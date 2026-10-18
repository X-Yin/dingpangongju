// 买点 / 卖点诊断 WebSocket 客户端单例（前端不再各自轮询）
//   后端每 10s 集中计算一次诊断，经 WebSocket 推送：
//     { type:'buy_point' | 'sell_point', mode, bucket, ts, data, open }
//     - data = 完整诊断结果（供卡片/抽屉实时展示）
//     - open = true 表示「命中且进入新的 5 分钟桶」，前端据此打开抽屉/弹窗（飞书由后端统一发送）
//   多个页面/组件共享同一连接；断线指数退避重连，页面重新可见时主动重连。
import axios from 'axios';
import { local_ip } from '../constant';

const WS_URL = `ws://${local_ip}:3000/ws`;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PUSH_TYPES = ['buy_point', 'sell_point'];

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
    if (PUSH_TYPES.includes(msg.type)) notify(msg);
    else if (isDebugType(msg.type)) dispatchDebug(msg);
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
export const syncStrategyMode = async (mode) => {
  try {
    await axios.post(`http://${local_ip}:3000/set_strategy_mode`, { mode });
  } catch (e) {
    console.error('同步策略模式到后端失败:', e);
  }
};

// 后台标签页被浏览器挂起后恢复时主动重连
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeCount() > 0) ensureConnected();
  });
}
