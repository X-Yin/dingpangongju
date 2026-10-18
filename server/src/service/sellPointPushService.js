// 卖点诊断后端集中调度（每 10s 一次）
//   - 每 10s 对全部持仓（含同股多笔仓位，各自独立诊断）计算一次卖点诊断，经 WebSocket 广播给所有前端
//   - 命中且进入新的 5 分钟时间桶时（每桶最多一次）：后端发飞书 + 额外广播 open:true 让前端开抽屉/弹窗
//   - 5 分钟桶标签口径严格对齐回测（见 buyPointBuckets.js，与买点诊断共用同一份桶标签）
//   - 非交易日 / 午休 / 收盘后不发；幂等状态落盘，重启同桶不重复发
//   - 诊断口径与前端 diagnosePositionSellPoint 完全一致（买入当日不诊断、次日起生效）
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils');
const { getCurrentClosedBucket } = require('./buyPointBuckets');
const strategyModeState = require('./strategyModeState');
const wsServer = require('../wsServer');
const { notifySellPointFeishu } = require('./sellPointNotifier');
const { getStockPositions } = require('./stockPosition');
const { checkSingleStockSellPoint } = require('./buySellDiagnose');
const { checkExtremeWinSellPointDetailed, MODE_EXTREME_WIN } = require('./hotMoneyExtremeWin');

const INTERVAL_MS = 10 * 1000;
const statePath = path.resolve(__dirname, '../data/sell_point_notify_state.json');

let timer = null;
let running = false;
let lastNotifiedBucket = null;

const readState = () => {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
};

const writeState = (obj) => {
  try {
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('写入卖点通知状态失败:', e.message);
  }
};

// 启动时恢复「今日已通知到的桶」，避免同桶内重启重复发送
const loadLastNotifiedBucket = () => {
  const s = readState();
  const today = dayjs().format('YYYYMMDD');
  lastNotifiedBucket = s && s.date === today && s.bucket != null ? s.bucket : null;
};

// 推送时间窗：非交易日不发；9:30 前不发；15:00 后不发；午休（11:31-12:59）不发。
// 注意：11:30 那一分钟仍运行，以捕获回测口径中的 11:30 桶。
const isInPushWindow = (date = new Date()) => {
  if (!isTradingDay(date)) return false;
  const m = date.getHours() * 60 + date.getMinutes();
  if (m < 9 * 60 + 30) return false;
  if (m > 15 * 60) return false;
  if (m >= 11 * 60 + 31 && m < 13 * 60) return false;
  return true;
};

// 单笔持仓卖点诊断：同一股票的不同仓位各自独立诊断（各自买入日期 / 成本线 / 仓位）
//   口径与前端 diagnosePositionSellPoint 完全一致：买入当日不诊断、次日起生效
const diagnosePosition = async (stock, todayStr, mode) => {
  const base = {
    positionId: stock.id || stock.code,
    code: stock.code,
    stockName: stock.name,
    weight: stock.weight != null ? stock.weight : null,
    buyDate: stock.buyDate || null,
    buyTime: stock.buyTime || null,
    costPrice: stock.costPrice != null && Number.isFinite(Number(stock.costPrice)) ? Number(stock.costPrice) : null,
  };
  if (stock.buyDate === todayStr) {
    return { ...base, buyToday: true };
  }
  try {
    const res = mode === MODE_EXTREME_WIN
      ? await checkExtremeWinSellPointDetailed(stock.code, stock.costPrice, stock.buyDate || null)
      : await checkSingleStockSellPoint(stock.code, stock.costPrice);
    return { ...res, ...base };
  } catch (e) {
    return { ...base, error: '诊断失败' };
  }
};

const tick = async () => {
  if (running) return; // 上一 tick 未完成则跳过，避免重入
  running = true;
  try {
    const now = new Date();
    if (!isInPushWindow(now)) return;

    const mode = strategyModeState.getMode();
    const todayStr = dayjs().format('YYYY-MM-DD');
    const positions = getStockPositions() || [];
    if (positions.length === 0) return;

    const results = await Promise.all(positions.map((stock) => diagnosePosition(stock, todayStr, mode)));
    const hitResults = results.filter((r) => r.isSell === true);
    const bucket = getCurrentClosedBucket(now);
    const data = { results, hitCount: hitResults.length, total: results.length };

    // 1) 每 10s 广播诊断结果（仅供前端展示，不触发打开）
    wsServer.broadcast({ type: 'sell_point', mode, bucket, ts: Date.now(), data, open: false });

    // 2) 桶门控命中：命中且进入新的合法桶时，发飞书 + 额外广播 open:true（每桶最多一次）
    if (bucket == null || hitResults.length === 0) return;
    if (lastNotifiedBucket === bucket) return;

    lastNotifiedBucket = bucket;
    writeState({ date: dayjs().format('YYYYMMDD'), bucket, mode });

    try {
      await notifySellPointFeishu({ hitResults });
    } catch (e) {
      console.error('卖点飞书发送失败:', e.message);
    }
    wsServer.broadcast({ type: 'sell_point', mode, bucket, ts: Date.now(), data, open: true });
  } catch (e) {
    console.error('卖点诊断推送任务异常:', e.message);
  } finally {
    running = false;
  }
};

// 启动调度（挂在常驻 HTTP 服务进程上；进程退出即停止）
const start = () => {
  if (timer) return;
  loadLastNotifiedBucket();
  tick(); // 立即执行一次，启动即有数据
  timer = setInterval(tick, INTERVAL_MS);
  console.log('卖点诊断集中推送服务已启动（每 10s 一次）');
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, isInPushWindow };
