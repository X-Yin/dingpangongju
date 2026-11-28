// ============================================================
// 冰点反弹-率先冲击5% · 线上常驻服务（2026-11-28 用户要求）
//   把回测引擎 engine/iceReboundFirstHitBacktest.js 的当日买点事件判定搬到线上实时诊断
//   （getIceReboundBuySignal，与回测当日买点逻辑完全同口径）：
//     门禁：前一交易日科技情绪 ≤ -20（情绪冰点）且往前两个交易日科技情绪均 < 20（近端无过热）；
//     候选池：盯盘页「板块涨跌幅」置顶板块成分股 ∩ 当日自选股回放，剔除黑名单个股；
//     买点：9:30–11:30 内逐 1 分钟回溯分时，取「率先盘中涨幅达到 +5%」的分钟买入（触发涨幅 ≤ +8%、
//           未涨停、触发时盘中科技情绪 < 30、个股总市值 ≥ 300 亿；不满足者按触发先后顺延）。
//   买点诊断粒度 = 1 分钟（同一 minute 只诊断一次）；15s tick + running 标志防重入；
//   仅交易日（isTradingDay）9:20–15:05 运行扫描。
//   卖点：通用卖点 + 低于成本价即卖（costLinePct=0）+ 禁用竞价低开自救（9:30 低于成本线直接卖），
//         按 5 分钟时间桶诊断（由 sellPointPushService 调度，strategy === 'ice_rebound' 分支）。
//   买点命中通知当日仅一次（WS 广播 + 飞书卡片）；每次诊断后（不只命中时）都广播候选池快照。
//   本服务不挂策略模式门禁（2026-11-28 用户要求：启动即常驻扫描，快照无论是否触发都更新）；
//   持仓已持有的股票在买点顺延链中直接跳过（excludeCodes）。
// ============================================================
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils/tradingDay');
const { getStockPositions } = require('./stockPosition');
const { getIceReboundBuySignal } = require('./buySellBacktest/engine/iceReboundFirstHitBacktest');
const wsServer = require('../wsServer');
const feishuNotify = require('./feishuNotify');

const SOURCE = 'ice_rebound_live';
const SOURCE_LABEL = '冰点反弹-率先冲击5%';
const HIT_PCT = 5;                       // 率先冲击涨幅阈值（与 ice_rebound_first_hit_5 一致）
const FLOAT_CAP_PCT = HIT_PCT + 3;       // 触发涨幅窗口上限（n + 3）
const SCAN_START_MINUTE = 9 * 60 + 20;   // 09:20 起扫描（开盘前先刷一轮门禁/候选池快照）
const SCAN_END_MINUTE = 15 * 60 + 5;     // 15:05 停止扫描
const TICK_MS = 15 * 1000;               // 15s tick
const BUY_WINDOW_TEXT = '9:30-11:30';
const RULES = { hitPct: HIT_PCT, floatCapPct: FLOAT_CAP_PCT, buyWindow: BUY_WINDOW_TEXT };

const fmtMinute = (m) => (m != null
  ? `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`
  : '--');

let timer = null;
let running = false;
let stateDate = null;          // 跨日重置标记
let lastDiagMinute = null;     // 买点诊断粒度 = 1 分钟：同一 minute（HHMM）只诊断一次
let firedCodes = new Set();    // 当日已推送买点的候选（每只仅推一次；卖出后顺延推送下一只）
let lastFiredCode = null;      // 最近一次推送的候选 code
let refireAllowed = false;     // 卖出检测通过：允许推送下一只（2026-11-28 用户要求：当日卖出后仍可继续买入）
let prevHeldCodes = new Set(); // 上一轮诊断时的持仓快照（卖出检测用）
let snapshot = null;           // 最近一次诊断快照（无论是否触发都更新）

// 跨日重置：date 变化时清空推送状态与快照
const ensureDayState = (dateStr) => {
  if (stateDate === dateStr) return;
  stateDate = dateStr;
  lastDiagMinute = null;
  firedCodes = new Set();
  lastFiredCode = null;
  refireAllowed = false;
  prevHeldCodes = new Set();
  snapshot = null;
};

// 前端展示快照（无论是否触发都更新；pushing 恒为 true——走到诊断即代表实时推送在运行）
const getDisplayData = () => ({
  date: snapshot?.date || dayjs().format('YYYYMMDD'),
  updatedAt: snapshot?.updatedAt || null,
  minute: snapshot?.minute != null ? snapshot.minute : null,
  pushing: true,
  gateOpen: snapshot?.gateOpen === true,
  gates: snapshot?.gates || { prevTechEmotion: null, recentOver: null },
  poolSize: snapshot?.poolSize != null ? snapshot.poolSize : 0,
  potentialCount: snapshot?.potentialCount != null ? snapshot.potentialCount : 0,
  dayEvent: snapshot?.dayEvent || null,
  candidates: snapshot?.candidates || [],
  checks: snapshot?.checks || [],
  notified: firedCodes.size > 0,
  fired: [...firedCodes],
  refireAllowed,
  error: snapshot?.error || null,
  rules: RULES,
});

// 买点命中：dayEvent 包装为 stocks 元素（与 washFusion 买点卡片字段对齐：minute 为 HH:MM 文案，price/change 为触发分钟分时价/涨幅）
const buildStockOf = (dayEvent) => ({
  code: dayEvent.code,
  name: dayEvent.name,
  stockName: dayEvent.name,
  event: dayEvent.event,
  minute: fmtMinute(dayEvent.event.minute),
  price: dayEvent.event.px,
  change: dayEvent.event.pct,
  stockCapYi: dayEvent.stockCapYi,
  triggerEmo: dayEvent.triggerEmo,
  timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
});

// ============================================================
// 单次诊断（供 tick 调用；验证脚本也可直接调用，不做时间窗 / 交易日 / 分钟粒度门控）
// ============================================================
const runDiagnosis = async (dateStr, minuteKey) => {
  // 卖出检测（2026-11-28 用户要求：当日卖出后仍可继续买入）：上一轮持仓中存在「已推送买点」的
  // 股票、本轮已不在持仓 → 视为已卖出，允许顺延推送下一只候选
  const heldCodes = (getStockPositions() || []).map((p) => p && p.code).filter(Boolean);
  const heldSet = new Set(heldCodes);
  for (const c of prevHeldCodes) {
    if (firedCodes.has(c) && !heldSet.has(c)) {
      refireAllowed = true;
      console.log(`[冰点反弹] ${dateStr} 检测到已推送候选 ${c} 已不在持仓（卖出），允许顺延推送下一只`);
    }
  }
  prevHeldCodes = heldSet;
  // 买点候选排除：正持仓 + 当日已推送过的候选（每只当日仅推一次）
  const excludeCodes = [...new Set([...heldCodes, ...firedCodes])];
  const signal = await getIceReboundBuySignal({ dateStr, excludeCodes, strict: true });

  if (!signal || signal.success === false) {
    // 加载失败也更新快照（带 error 信息），前端可看到诊断时间与失败原因
    snapshot = {
      ...(snapshot || {}),
      date: dateStr,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      minute: minuteKey,
      error: (signal && signal.message) || '买点信号诊断失败',
    };
    console.error(`[冰点反弹] ${dateStr} 买点信号诊断失败: ${snapshot.error}`);
    wsServer.broadcast({ type: 'ice_rebound_candidates', ts: Date.now(), open: true, data: getDisplayData() });
    return;
  }

  snapshot = {
    date: dateStr,
    updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    minute: minuteKey,
    gateOpen: signal.gateOpen,
    gates: signal.gates,
    poolSize: signal.poolSize,
    potentialCount: signal.potentialCount,
    dayEvent: signal.dayEvent,
    candidates: signal.candidates,
    checks: signal.checks,
    error: null,
  };

  // 买点命中通知：每只候选当日仅推一次；检测到已推送候选被卖出（refireAllowed）后顺延推送下一只
  // （2026-11-28 用户要求：当日卖出后仍可继续买入）
  if (signal.dayEvent && (firedCodes.size === 0 || (refireAllowed && signal.dayEvent.code !== lastFiredCode))) {
    firedCodes.add(signal.dayEvent.code);
    lastFiredCode = signal.dayEvent.code;
    refireAllowed = false;
    const stock = buildStockOf(signal.dayEvent);
    wsServer.broadcast({
      type: 'ice_rebound_buy',
      ts: Date.now(),
      open: true,
      data: {
        date: dateStr,
        source: SOURCE,
        sourceLabel: SOURCE_LABEL,
        stocks: [stock],
        checks: signal.checks,
        rules: RULES,
      },
    });
    console.log(`[冰点反弹] ${dateStr} ${signal.dayEvent.name}（${signal.dayEvent.code}）于 ${fmtMinute(signal.dayEvent.event.minute)} 率先盘中涨幅达到 +${HIT_PCT}%（触发涨幅 ${signal.dayEvent.event.pct.toFixed(2)}%），按 1 分钟回溯价 ${signal.dayEvent.event.px} 买入`);
    try {
      await feishuNotify.sendFeishuCard(feishuNotify.buildIceReboundBuyCard({
        buyStocks: [stock],
        triggerTime: stock.timestamp,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        prevTechEmotion: signal.gates?.prevTechEmotion,
      }));
    } catch (e) {
      console.error('冰点反弹买点飞书发送失败:', e.message);
    }
  }

  // 每次诊断后（不只命中时）广播候选池快照
  wsServer.broadcast({ type: 'ice_rebound_candidates', ts: Date.now(), open: true, data: getDisplayData() });
};

// ============================================================
// 主循环（每 15s；仅交易日 09:20-15:05；买点诊断粒度 = 1 分钟，同一 minute 只诊断一次）
// ============================================================
const tick = async () => {
  if (running) return; // 上一 tick 未完成则跳过，防重入
  running = true;
  try {
    const now = new Date();
    if (!isTradingDay(now)) return;
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    if (minuteOfDay < SCAN_START_MINUTE || minuteOfDay > SCAN_END_MINUTE) return;

    const dateStr = dayjs().format('YYYYMMDD');
    ensureDayState(dateStr);
    const minuteKey = now.getHours() * 100 + now.getMinutes();
    if (lastDiagMinute === minuteKey) return; // 1 分钟粒度：同一分钟只诊断一次
    lastDiagMinute = minuteKey;
    await runDiagnosis(dateStr, minuteKey);
  } catch (e) {
    console.error('冰点反弹线上轮询任务异常:', e.message);
  } finally {
    running = false;
  }
};

const start = () => {
  if (timer) return; // 幂等：重复调用不重复启动
  tick();
  timer = setInterval(tick, TICK_MS);
  console.log('冰点反弹-率先冲击5%线上服务已启动（交易日 09:20-15:05 每 15s 轮询，买点 1 分钟诊断一次）');
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = {
  SOURCE,
  SOURCE_LABEL,
  RULES,
  start,
  stop,
  tick,
  runDiagnosis,
  getDisplayData,
  ensureDayState,
};
