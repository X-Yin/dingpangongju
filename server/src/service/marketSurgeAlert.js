// 大盘放量急拉 · 重点板块全局提示（后端判定 + 拉取数据 + WS 推送）
// 每 30 秒检查一次：当日两市成交额较昨日同期放量 ≥ 500 亿，且
//   创业板指 1 分钟内涨幅 ≥ 0.2%，或 科创50 1 分钟内涨幅 ≥ 0.3%
// 命中后先在服务端实时并行拉取重点板块数据，全部就绪后再经 WS 推送前端，
// 前端收到即弹窗展示（打开即有数据，不再等前端请求）。
// 必须运行在 index.js 进程（WS 服务只挂载在该进程）。
const wsServer = require('../wsServer');
const { isTradingHours } = require('../utils');
const { getAmountHistory } = require('./amount');
const { getSingleStockTlineData } = require('./stock');
const { getBlocksRealtimeData } = require('./block');

// 需要实时重算涨幅的重点板块（与 constant/block_code.js 中的板块名保持一致）
const TARGET_BLOCKS = [
  '光模块', 'cpo', 'pcb', 'CCL', '光芯片', '半导体', '物理AI', 'AI 剧',
  '先进封装', '华为', 'MLCC', '电子布', '半导体材料', 'PPE树脂', '液冷',
  'cpu', 'MPO', '存储', '光刻胶', '光刻机',
];

const AMOUNT_DIFF_THRESHOLD = 500; // 亿（较昨日同期放量）
const CYB_1MIN_THRESHOLD = 0.2; // 创业板指 1 分钟涨幅（%）
const KCB_1MIN_THRESHOLD = 0.3; // 科创50 1 分钟涨幅（%）
const CHECK_INTERVAL = 30 * 1000;

let timer = null;
let checking = false;
let lastAlertKey = '';

// 取分时最后两个「相邻分钟」点，返回这 1 分钟内的涨幅变化（百分点）
const oneMinuteDelta = (line) => {
  const pts = (Array.isArray(line) ? line : [])
    .filter((p) => p && p.minute != null && p.change != null && !isNaN(Number(p.change)))
    .map((p) => ({ minute: Number(p.minute), change: Number(p.change) }))
    .sort((a, b) => a.minute - b.minute);
  if (pts.length < 2) return null;
  const prev = pts[pts.length - 2];
  const latest = pts[pts.length - 1];
  if (latest.minute - prev.minute !== 1) return null; // 午休/跨段等非相邻分钟不判定
  return {
    minute: latest.minute,
    prevMinute: prev.minute,
    from: prev.change,
    to: latest.change,
    delta: Number((latest.change - prev.change).toFixed(3)),
  };
};

const check = async () => {
  if (checking || !isTradingHours()) return;
  checking = true;
  try {
    const history = getAmountHistory();
    const latest = history.length ? history[history.length - 1] : null;
    const amountDiff = Number(latest?.[1]?.amountChangeDiff);
    if (!Number.isFinite(amountDiff) || amountDiff < AMOUNT_DIFF_THRESHOLD) return;

    const [cybLine, kcbLine] = await Promise.all([
      getSingleStockTlineData('sz399006').catch(() => null),
      getSingleStockTlineData('sh000688').catch(() => null),
    ]);
    const cyb = oneMinuteDelta(cybLine?.line);
    const kcb = oneMinuteDelta(kcbLine?.line);
    const hitCyb = Boolean(cyb && cyb.delta >= CYB_1MIN_THRESHOLD);
    const hitKcb = Boolean(kcb && kcb.delta >= KCB_1MIN_THRESHOLD);
    if (!hitCyb && !hitKcb) return;

    // 同一分钟只提示一次
    const minute = hitCyb ? cyb.minute : kcb.minute;
    const key = `${latest?.[1]?.date || ''}-${minute}-${hitCyb ? 'c' : ''}${hitKcb ? 'k' : ''}`;
    if (key === lastAlertKey) return;
    lastAlertKey = key;

    // 先完成板块数据请求，再推送；前端收到即打开弹窗
    const { blocks, historyTime } = await getBlocksRealtimeData(TARGET_BLOCKS);
    wsServer.broadcast({
      type: 'market_surge_alert',
      open: true,
      ts: Date.now(),
      data: {
        trigger: {
          amountDiff,
          amountTotal: latest?.[1]?.totalAmount || null,
          cyb,
          kcb,
          hitCyb,
          hitKcb,
          time: new Date().toISOString(),
        },
        blocks,
        historyTime,
      },
    });
    console.log(`[大盘放量急拉] 已推送：放量 ${amountDiff.toFixed(2)} 亿（创业板 1min ${cyb ? cyb.delta : '-'}%，科创50 1min ${kcb ? kcb.delta : '-'}%），板块 ${blocks.length} 个`);
  } catch (e) {
    console.error('[大盘放量急拉] 检测/推送失败:', e.message);
  } finally {
    checking = false;
  }
};

const start = () => {
  if (timer) return;
  check();
  timer = setInterval(check, CHECK_INTERVAL);
  console.log('大盘放量急拉监控已启动（每 30 秒检测，命中后经 WS 推送前端）');
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, TARGET_BLOCKS };
