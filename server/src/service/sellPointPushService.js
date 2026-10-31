// 卖点诊断后端集中调度（每 10s 一次）
//   - 每 10s 对全部持仓（含同股多笔仓位，各自独立诊断）计算一次卖点诊断，经 WebSocket 广播给所有前端
//   - 命中且进入新的 5 分钟时间桶时（每桶最多一次）：后端发飞书 + 额外广播 open:true 让前端开抽屉/弹窗
//   - 例外（2026-10-31 用户要求）：情绪游资-极致胜率含「单分钟跳水 ≥ 3 个点」这类分钟级卖点，
//     故该模式下卖点诊断**在 1 分钟整数分钟（9:30 / 9:31 / 9:32 …）执行并通知**（后端仍每 10s 轮询，
//     非整数分钟直接复用本分钟首次诊断结果、不重复执行也不通知）；同一持仓同一分钟最多通知一次，跨分钟重新判定
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
const { checkExtremeWinSellPointDetailed, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE } = require('./hotMoneyExtremeWin');
const { isTechWatchlistStock } = require('./monitorStock');

const INTERVAL_MS = 10 * 1000;
const statePath = path.resolve(__dirname, '../data/sell_point_notify_state.json');

let timer = null;
let running = false;
let lastNotifiedBucket = null;
// 情绪游资-极致胜率：卖点诊断只在 1 分钟整数分钟（9:30 / 9:31 / 9:32 …）执行与通知（2026-10-31 用户要求）；
//   各命中持仓按「当前分钟（HHMM）」去重，同一分钟最多通知一次，跨分钟重新判定
const ewNotifiedMinute = new Map();
let ewNotifiedDate = null;
// 当前已执行 EW 卖点诊断的分钟（HHMM）与当日缓存：非整数分钟直接复用，不重复诊断
let ewSellEvalMinute = null;
let ewSellEvalDate = null;
const ewSellCache = new Map();

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

// 启动时恢复「今日已通知到的桶」与「情绪游资-极致胜率各持仓最近一次已通知的分钟」，避免重启后重复通知
const loadLastNotifiedBucket = () => {
  const s = readState();
  const today = dayjs().format('YYYYMMDD');
  lastNotifiedBucket = s && s.date === today && s.bucket != null ? s.bucket : null;
  ewNotifiedMinute.clear();
  ewNotifiedDate = s && s.date === today ? today : null;
  const saved = s && s.date === today ? s.ewNotifiedMinute : null;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    Object.entries(saved).forEach(([k, v]) => {
      if (Number.isFinite(Number(v))) ewNotifiedMinute.set(k, Number(v));
    });
  }
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
const diagnosePosition = async (stock, todayStr, mode, ewEvalNow = true) => {
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
    // 攻防兼备模式：按持仓股是否属于自选股科技股范围分流——科技股走科技卖点诊断，其余（连板股）走龙头卖点诊断
    const useExtremeWin = mode === MODE_EXTREME_WIN
      || (mode === MODE_ATTACK_DEFENSE && !isTechWatchlistStock(stock.code));
    if (!useExtremeWin) {
      return { ...(await checkSingleStockSellPoint(stock.code, stock.costPrice)), ...base };
    }
    // 情绪游资-极致胜率卖点诊断按 1min 整数分钟执行：非整数分钟直接复用本分钟首次诊断结果
    const cacheKey = String(base.positionId);
    if (!ewEvalNow && ewSellCache.has(cacheKey)) return ewSellCache.get(cacheKey);
    const res = await checkExtremeWinSellPointDetailed(stock.code, stock.costPrice, stock.buyDate || null, {
      // ⑪⑫仅顺周期持仓启用：持仓标记 reverse（逆周期）时关闭；未标记按顺周期处理
      enableOpenGapReboundSell: (mode === MODE_EXTREME_WIN || mode === MODE_ATTACK_DEFENSE) && stock.cycle !== 'reverse',
    });
    const merged = { ...res, ...base };
    if (ewEvalNow) ewSellCache.set(cacheKey, merged);
    return merged;
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
    const todayNum = dayjs().format('YYYYMMDD');
    const positions = getStockPositions() || [];
    if (positions.length === 0) return;

    // 情绪游资-极致胜率：卖点诊断只在 1 分钟整数分钟（9:30 / 9:31 / 9:32 …）执行一次，其余 10s tick 复用本分钟结果
    const minuteKey = now.getHours() * 100 + now.getMinutes();
    if (ewSellEvalDate !== todayNum) {
      ewSellEvalDate = todayNum;
      ewSellEvalMinute = null;
      ewSellCache.clear();
    }
    const ewEvalNow = ewSellEvalMinute !== minuteKey;
    if (ewEvalNow) {
      ewSellEvalMinute = minuteKey;
      ewSellCache.clear();
    }
    const ewEvalForPositions = mode === MODE_EXTREME_WIN ? ewEvalNow : true;

    const results = await Promise.all(positions.map((stock) => diagnosePosition(stock, todayStr, mode, ewEvalForPositions)));
    const hitResults = results.filter((r) => r.isSell === true);
    const bucket = getCurrentClosedBucket(now);
    const data = { results, hitCount: hitResults.length, total: results.length };

    // 1) 每 10s 广播诊断结果（仅供前端展示，不触发打开）
    wsServer.broadcast({ type: 'sell_point', mode, bucket, ts: Date.now(), data, open: false });

    if (hitResults.length === 0) return;

    // 2) 情绪游资-极致胜率：卖点诊断在 1 分钟整数分钟执行，命中即通知（不等 5 分钟桶）；
    //    同一持仓同一分钟最多通知一次，跨分钟重新判定
    if (mode === MODE_EXTREME_WIN) {
      if (!ewEvalNow) return; // 非 1min 整数分钟：不通知（本次结果为复用的上一分钟诊断）
      if (ewNotifiedDate !== todayNum) {
        ewNotifiedMinute.clear();
        ewNotifiedDate = todayNum;
      }
      const hitKeyOf = (r) => String(r.positionId || r.code || '');
      const freshHits = hitResults.filter((r) => ewNotifiedMinute.get(hitKeyOf(r)) !== minuteKey);
      if (freshHits.length === 0) return;
      freshHits.forEach((r) => ewNotifiedMinute.set(hitKeyOf(r), minuteKey));
      const notifyMinuteObj = {};
      ewNotifiedMinute.forEach((v, k) => { notifyMinuteObj[k] = v; });
      writeState({ date: todayNum, bucket: lastNotifiedBucket, mode, ewNotifiedMinute: notifyMinuteObj });
      try {
        await notifySellPointFeishu({ hitResults: freshHits });
      } catch (e) {
        console.error('卖点飞书发送失败:', e.message);
      }
      wsServer.broadcast({ type: 'sell_point', mode, bucket, ts: Date.now(), data, open: true });
      return;
    }

    // 3) 其余模式：命中且进入新的合法桶时，发飞书 + 额外广播 open:true（每桶最多一次）
    if (bucket == null) return;
    if (lastNotifiedBucket === bucket) return;

    lastNotifiedBucket = bucket;
    writeState({ date: todayNum, bucket, mode });

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
