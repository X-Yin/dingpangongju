// 买点 / 卖点诊断 WebSocket 客户端单例（前端不再各自轮询）
//   后端每 10s 集中计算一次诊断，经 WebSocket 推送：
//     { type:'buy_point' | 'sell_point', mode, bucket, ts, data, open }
//     - data = 完整诊断结果（供卡片/抽屉实时展示）
//     - open = true 表示「命中且需要前端弹出卖点/买点提示」，前端据此打开抽屉/弹窗（飞书由后端统一发送）
//       （卖点：情绪游资-极致胜率模式下命中即推送；其余模式为「命中且进入新的 5 分钟桶」）
//   多个页面/组件共享同一连接；断线指数退避重连，页面重新可见时主动重连。
import axios from 'axios';
import { local_ip } from '../constant';

const WS_URL = `ws://${local_ip}:3000/ws`;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PUSH_TYPES = ['buy_point', 'sell_point', 'buy_point_blocked', 'fund_gate', 'ice_delay_wait', 'wash_fusion_candidates', 'wash_fusion_buy', 'block_5min_surge', 'strategy_signal', 'emotion_resonance', 'important_stock_surge'];

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connecting = false;
// 按类型保存最近一条消息，供晚挂载组件补发（打开即有数据）
const lastByType = {};
const listeners = new Set();
// debug 自检消息（debug_ping/pong/pong_ack）单独走一条分发通道
const debugListeners = new Set();
const activeCount = () => listeners.size + debugListeners.size;
const isDebugType = (t) => typeof t === 'string' && t.startsWith('debug_');

// ==================== 弹卡对账（2026-11-09 用户新增） ====================
// 凡 open:true 的弹卡类广播，后端都会补全局唯一 aid 并登记（保留 12 小时，GET /pending_alerts 拉取）。
// 前端若在广播瞬间不在线（页面未开 / WS 断连 / 服务重启）会错过弹卡；
// 本模块在 WS 连上 / 页面重新可见时拉取对账：本地没弹过的一律经 notify() 以 open:true 重新分发，
// 复用各组件现有订阅逻辑弹卡（GlobalDiagnosisAlert 卡片 / App 屏蔽弹窗等无需改动）。
const SHOWN_KEY = 'ws_alert_shown_ids';    // localStorage 已弹记录 { [aid]: 时间戳 }
const SHOWN_TTL_MS = 3 * 24 * 3600 * 1000; // 已弹记录保留 3 天，防 localStorage 无限膨胀
const dispatchedIds = new Set();           // 本次会话已分发过的 aid（防在线推送与对账拉取重复弹）

const loadShownIds = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(SHOWN_KEY) || '{}');
    const cutoff = Date.now() - SHOWN_TTL_MS;
    const out = {};
    Object.keys(raw).forEach((id) => { if (raw[id] >= cutoff) out[id] = raw[id]; });
    return out;
  } catch {
    return {};
  }
};

// 标记某条提醒「已弹」：写入 localStorage + 本会话内存去重集合
const markAlertShown = (aid) => {
  if (!aid) return;
  dispatchedIds.add(aid);
  try {
    const shown = loadShownIds();
    shown[aid] = Date.now();
    localStorage.setItem(SHOWN_KEY, JSON.stringify(shown));
  } catch { /* 忽略 */ }
};

// 对账补弹：拉取后端登记的 open:true 广播，本地没弹过的重新分发（消息带 replayed:true 便于排查）
let replaying = false;
export const replayPendingAlerts = async () => {
  if (replaying || activeCount() === 0) return;
  replaying = true;
  try {
    const res = await axios.get(`http://${local_ip}:3000/pending_alerts`, { timeout: 5000 });
    const list = Array.isArray(res.data) ? res.data : [];
    if (list.length === 0) return;
    const shown = loadShownIds();
    let replayed = 0;
    for (const item of list) {
      if (!item || !item.id || !item.msg || !item.msg.type) continue;
      if (dispatchedIds.has(item.id) || shown[item.id]) continue; // 已弹过（本会话或历史）不重弹
      markAlertShown(item.id);
      notify({ ...item.msg, replayed: true });
      replayed += 1;
    }
    if (replayed > 0) console.log(`[ws对账] 补弹 ${replayed} 条漏收提醒`);
  } catch (e) {
    console.error('[ws对账] 拉取待补弹提醒失败:', e);
  } finally {
    replaying = false;
  }
};

const notify = (msg) => {
  if (msg && msg.type) lastByType[msg.type] = msg;
  [...listeners].forEach((fn) => {
    try {
      fn(msg);
    } catch (e) {
      console.error('诊断 WS 回调异常:', e);
    }
  });
};

const dispatchDebug = (msg) => {
  [...debugListeners].forEach((fn) => {
    try {
      fn(msg);
    } catch (e) {
      console.error('debug WS 回调异常:', e);
    }
  });
};

// 直接向服务端发送一条消息（调试面板自检协议使用）
export const sendRaw = (obj) => {
  if (socket && socket.readyState === 1 /* OPEN */) {
    try {
      socket.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
  return false;
};

const scheduleReconnect = () => {
  if (reconnectTimer || activeCount() === 0) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected();
  }, delay);
};

function ensureConnected() {
  if (connecting) return;
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return; // CONNECTING / OPEN
  connecting = true;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    connecting = false;
    reconnectAttempts = 0;
    replayPendingAlerts(); // 对账补弹：连上后立刻检查有没有漏收的弹卡提醒
  };
  socket.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (!msg || !msg.type) return;
    // debug 双向自检：后端主动推送 debug_ping → 前端自动回 debug_pong
    if (msg.type === 'debug_ping' && msg.src === 'server') {
      sendRaw({ type: 'debug_pong', seq: msg.seq, src: 'client' });
    }
    if (PUSH_TYPES.includes(msg.type)) {
      if (msg.open === true && msg.aid) markAlertShown(msg.aid); // 在线收到弹卡推送即记账，避免对账时重复弹
      notify(msg);
    } else if (isDebugType(msg.type)) dispatchDebug(msg);
  };
  socket.onclose = () => {
    connecting = false;
    socket = null;
    PUSH_TYPES.forEach((t) => { delete lastByType[t]; });
    scheduleReconnect();
  };
  socket.onerror = () => { /* 随后触发 onclose，由 onclose 负责重连 */ };
}

// 订阅指定类型推送：若有该类型最近一条消息会立即回调一次（打开即有数据）；返回取消订阅函数
//   注意：补发时去掉 open 标记，避免组件晚挂载时因历史 open:true 重复打开抽屉/弹窗
export const subscribePush = (type, handler) => {
  const wrapped = (msg) => {
    if (msg && msg.type === type) handler(msg);
  };
  listeners.add(wrapped);
  const last = lastByType[type];
  if (last) {
    try {
      wrapped({ ...last, open: false });
    } catch (e) {
      console.error('诊断 WS 回调异常:', e);
    }
  }
  ensureConnected();
  return () => {
    listeners.delete(wrapped);
    if (activeCount() === 0 && socket) {
      try { socket.close(); } catch { /* 忽略 */ }
    }
  };
};

// 买点订阅（保持既有调用不变）
export const subscribeBuyPointPush = (handler) => subscribePush('buy_point', handler);
// 卖点订阅
export const subscribeSellPointPush = (handler) => subscribePush('sell_point', handler);
// 买点屏蔽通知订阅（快进快出强卖当日禁买：其余买点条件通过但被策略规则拦截时后端推送，open:true 实时弹窗）
export const subscribeBuyPointBlockedPush = (handler) => subscribePush('buy_point_blocked', handler);

// 冰点转折延时观察订阅（2026-10-23 用户新增）：买点触发且属冰点转折时后端广播
// { type:'ice_delay_wait', mode, bucket, ts, data:{ phase:'wait', triggerTime, executeTime, delayMin, message } }，
// 前端展示「延时 15min 观察资金聚焦主线板块」等待卡片；到点后由 buy_point（data.iceDelay.phase='ready'）给出个股
export const subscribeIceDelayWaitPush = (handler) => subscribePush('ice_delay_wait', handler);

// 快进快出「资金净流入阈值动态调节」推送订阅（2026-10-21 用户新增）：
// 后端每次跑完回测（每日首次启动回测 / 持仓增删后台重跑）后广播
// { type:'fund_gate', ts, data:{ threshold, consecutiveBelow, tradeCount, computedAt, reason, range } }，
// 前端据此实时更新资金净流入阈值文案；页面刷新时的初始值走 HTTP /emo_quick_fund_gate（见 useFundGate）
export const subscribeFundGatePush = (handler) => subscribePush('fund_gate', handler);

// 情绪游资-极致赔率（2026-11-01 用户新增）：
//   候选股列表 { type:'wash_fusion_candidates', open, ts, data:{ date, updatedAt, count, firstBoard, secondBoard, rules } }
//     - 交易日 09:10 起整理完成后 open:true；09:15-15:00 每 3s 轮询 open:false → 仅刷新列表
//   买点触达 { type:'wash_fusion_buy', open:true, ts, data:{ date, source, sourceLabel, stocks:[...], checks, positionHint, remind, rules } }
//     - 首板起爆：09:25-9:30 竞价涨幅 ≥ 5% 的候选每 30s 提前提醒一次；09:30-9:40 盘中分时涨幅首次 +8% 弹出一次
//     - 二板起爆：09:30-14:30 盘中分时涨幅首次 +8% 弹出一次（竞价必须高开）
//     - 前端由 GlobalDiagnosisAlert 用统一买点诊断卡片展示，飞书由后端发送
export const subscribeWashFusionCandidatesPush = (handler) => subscribePush('wash_fusion_candidates', handler);
export const subscribeWashFusionBuyPush = (handler) => subscribePush('wash_fusion_buy', handler);

// 重点板块 5 分钟涨幅异动推送（2026-11-04 用户新增）：
//   后端在每个 5min 整数倍时刻扫描重点板块，任一板块过去 5min 平均涨幅 ≥ 1.5% 即广播
//   { type:'block_5min_surge', ts, open:true, data:{ time, prevTime, threshold, blocks:[{blockName,avgChange,prevAvgChange,change5min}] } }
//   前端全局弹窗提示异动板块；MOCK 调试消息额外带 mock:true 标记
export const subscribeBlock5minSurgePush = (handler) => subscribePush('block_5min_surge', handler);

// 策略中心命中推送（2026-11-06 用户新增）：后端策略轮询新命中时广播
//   { type:'strategy_signal', ts, open:true, data:{ signals:[{ id, time, read, strategyId, title, description, severity, isBullish }] } }
//   前端由 GlobalDiagnosisAlert 用类似买点诊断的全局卡片提醒（悬浮策略球/抽屉不受影响）；
//   MOCK 调试消息额外带 mock:true 标记
export const subscribeStrategySignalPush = (handler) => subscribePush('strategy_signal', handler);

// 大盘 × 板块情绪共振推送（2026-11-07 用户新增）：
//   后端每 5 分钟（block_amount_poll 触发）计算即时情绪周期，大盘情绪温度 ≥60 且板块
//   当日情绪周期达到全面高潮 / 一致加速时广播
//   { type:'emotion_resonance', ts, open:true, data:{ date, marketTemperature, threshold,
//     blocks:[{ board, phase, count, ratio, prevRatio, deltaRatio, reason }] } }
//   前端由 GlobalDiagnosisAlert 弹出全局共振提示；MOCK 调试消息额外带 mock:true 标记
export const subscribeEmotionResonancePush = (handler) => subscribePush('emotion_resonance', handler);

// 重点股 1 分钟涨跌幅异动推送（2026-11-10 用户新增）：前端 ImportantStockSurgeMonitor 每 1min
// 采样全量自选股，任一重点股（isImportant）1 分钟内涨跌幅绝对值变化 ≥ 2% 时本地广播
//   { type:'important_stock_surge', ts, open:true, mock?, data:{ time, prevTime, threshold, stocks:[{ code, stockName, change, prevChange, delta }] } }
//   前端由 GlobalDiagnosisAlert 弹出全局异动卡片（一次列出全部命中股票）；调试面板可发 MOCK 消息
export const subscribeImportantStockSurgePush = (handler) => subscribePush('important_stock_surge', handler);

// 本地广播：不经过后端 WS，直接把一条消息按推送协议分发给所有订阅者
//   （默认补 open:true，供前端自产自销的监控触发 / 调试面板 MOCK 使用）
export const publishLocalPush = (msg) => {
  if (!msg || !msg.type) return;
  notify({ open: true, ts: Date.now(), ...msg });
};

// 订阅 debug 自检消息（debug_pong / debug_ping / debug_pong_ack）；返回取消订阅函数
export const subscribeDebugWs = (handler) => {
  debugListeners.add(handler);
  ensureConnected();
  return () => {
    debugListeners.delete(handler);
    if (activeCount() === 0 && socket) {
      try { socket.close(); } catch { /* 忽略 */ }
    }
  };
};

// 同步全局策略模式到后端（后端据此集中诊断 / 发飞书，即使浏览器未打开也按当前模式运行）
// multi_mode 仅为前端「多选模式」下拉显示标记，不回传后端（多选列表走 syncStrategyModes）
export const syncStrategyMode = async (mode) => {
  if (mode === 'multi_mode') return;
  try {
    await axios.post(`http://${local_ip}:3000/set_strategy_mode`, { mode });
  } catch (e) {
    console.error('同步策略模式到后端失败:', e);
  }
};

// 多选模式（2026-11-04 新增）：把弹窗勾选的模式列表缓存到后端，
// 后端买点诊断按列表内全部模式并行执行
export const syncStrategyModes = async (modes) => {
  try {
    await axios.post(`http://${local_ip}:3000/set_strategy_modes`, { modes });
  } catch (e) {
    console.error('同步多选策略模式到后端失败:', e);
  }
};

// 拉取后端已缓存的多选模式列表（打开多选弹窗时回显；后端为持久化真源）
export const fetchStrategyModes = async () => {
  try {
    const res = await axios.get(`http://${local_ip}:3000/get_strategy_modes`);
    return Array.isArray(res.data?.data?.modes) ? res.data.data.modes : null;
  } catch (e) {
    console.error('获取多选策略模式失败:', e);
    return null;
  }
};

// 后台标签页被浏览器挂起后恢复时主动重连 + 对账补弹
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeCount() > 0) {
      ensureConnected();
      replayPendingAlerts();
    }
  });
}
