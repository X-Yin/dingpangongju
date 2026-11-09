// WebSocket 服务：与 HTTP 服务共用同一个 http.Server（同进程、同生命周期）
// 买点诊断由后端集中计算后经此广播给所有前端连接。
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const WS_PATH = '/ws';
let wss = null;

// ==================== 弹卡对账登记（2026-11-09 用户新增） ====================
// 凡 open:true 的弹卡类广播（买点/卖点/冰点/极致赔率/板块异动/策略命中/情绪共振等）都登记在册：
//   - 每条广播补上全局唯一 aid，前端在线收到即记录「已弹」；
//   - 前端若在广播瞬间不在线（页面未开 / WS 断连 / 服务重启），可经 GET /pending_alerts 拉取对账，
//     本地没弹过的重新弹卡（去重由前端 localStorage 按 aid 负责）；
//   - 后端条目 12 小时过期、最多保留 200 条，防止无限膨胀。
const PENDING_TTL_MS = 12 * 3600 * 1000;
const PENDING_MAX = 200;
let pendingAlerts = [];

const genAlertId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

const prunePendingAlerts = () => {
  const cutoff = Date.now() - PENDING_TTL_MS;
  pendingAlerts = pendingAlerts.filter((p) => p && p.ts >= cutoff);
  if (pendingAlerts.length > PENDING_MAX) {
    pendingAlerts = pendingAlerts.slice(pendingAlerts.length - PENDING_MAX);
  }
};

// 单连接发送（对象自动 JSON 序列化）
const sendTo = (socket, msg) => {
  if (!socket || socket.readyState !== 1 /* OPEN */) return false;
  try {
    socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    return true;
  } catch (e) {
    return false;
  }
};

// 挂载到既有 http.Server（app.listen 返回值）
const attach = (server, port) => {
  if (wss) return wss;
  wss = new WebSocketServer({ server, path: WS_PATH });
  wss.on('connection', (socket) => {
    socket.on('error', () => { /* 忽略单连接错误，避免影响服务 */ });
    // debug 双向连通性自检协议（前端调试面板使用）：
    //   ① 客户端发 {type:'debug_ping', src:'client'} → 后端立即回 {type:'debug_pong', src:'server'}（方向一：前端→后端→前端）
    //   ② 1s 后后端主动推送 {type:'debug_ping', src:'server'} → 客户端回 {type:'debug_pong', src:'client'} → 后端回 {type:'debug_pong_ack'}（方向二：后端→前端→后端）
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'debug_ping' && msg.src === 'client') {
        sendTo(socket, { type: 'debug_pong', seq: msg.seq, src: 'server' });
        setTimeout(() => sendTo(socket, { type: 'debug_ping', seq: msg.seq, src: 'server' }), 1000);
      } else if (msg.type === 'debug_pong' && msg.src === 'client') {
        sendTo(socket, { type: 'debug_pong_ack', seq: msg.seq });
      }
    });
  });
  wss.on('error', (err) => {
    console.error('WebSocket 服务错误:', err.message);
  });
  console.log(`WebSocket 服务已挂载：ws://localhost:${port || 3000}${WS_PATH}`);
  return wss;
};

// 广播一条消息给所有已连接客户端（对象自动 JSON 序列化）
// open:true 的弹卡类消息：补上全局唯一 aid 并登记，供前端对账补弹（见文件头注释）
const broadcast = (msg) => {
  if (msg && typeof msg === 'object' && msg.open === true) {
    const enriched = { ...msg, aid: msg.aid || genAlertId() };
    pendingAlerts.push({ id: enriched.aid, ts: Date.now(), msg: enriched });
    prunePendingAlerts();
    msg = enriched;
  }
  if (!wss) return 0;
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try {
        client.send(payload);
        sent += 1;
      } catch (e) { /* 忽略单连接发送失败 */ }
    }
  }
  return sent;
};

const clientCount = () => (wss ? wss.clients.size : 0);

// 待对账弹卡列表（先裁剪过期条目再返回；每条含 id / ts / msg，msg 自带 aid）
const getPendingAlerts = () => {
  prunePendingAlerts();
  return pendingAlerts;
};

const close = () => {
  if (!wss) return;
  // 先主动断开所有客户端，避免 http.Server 因长连接迟迟无法关闭（配合 index.js 兜底退出）
  for (const client of wss.clients) {
    try { client.terminate(); } catch (e) { /* 忽略 */ }
  }
  try { wss.close(); } catch (e) { /* 忽略 */ }
  wss = null;
};

module.exports = { attach, broadcast, getPendingAlerts, clientCount, close, WS_PATH };
