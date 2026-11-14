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
const { getStockPositions, getPositionSellStrategy } = require('./stockPosition');
const { checkSingleStockSellPoint } = require('./buySellDiagnose');
const { checkExtremeWinSellPointDetailed, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE } = require('./hotMoneyExtremeWin');
const { checkFirstBoardWashSellPointDetailed, checkSecondBoardWashSellPointDetailed } = require('./firstBoardWashSell');
const { isTechWatchlistStock } = require('./monitorStock');
const { logSell } = require('./diagnosisLog');

const INTERVAL_MS = 10 * 1000;
const statePath = path.resolve(__dirname, '../data/sell_point_notify_state.json');
// 卖点提醒开关（默认开启）：关闭后不再发飞书消息，也不再广播 open:true（前端不再弹提醒卡片 / 闪烁）
const reminderPath = path.resolve(__dirname, '../data/sell_point_reminder.json');

const isReminderEnabled = () => {
  try {
    if (!fs.existsSync(reminderPath)) return true;
    const raw = JSON.parse(fs.readFileSync(reminderPath, 'utf8') || '{}');
    return !(raw && raw.enabled === false);
  } catch (e) {
    return true;
  }
};

const setReminderEnabled = (enabled) => {
  const value = enabled !== false;
  try {
    fs.writeFileSync(reminderPath, JSON.stringify({ enabled: value }, null, 2));
  } catch (e) {
    console.error('写入卖点提醒开关失败:', e.message);
  }
  return value;
};

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

// 单笔持仓的卖点策略：优先用持仓显式设置的统一卖点策略（2026-11-01 用户要求），未设置时按全局策略模式回退
//   tech_attack 科技进攻 | extreme_win_pro 极致胜率顺周期 | extreme_win_reverse 极致胜率逆周期
//   first_board_wash 首板起爆 | second_board_wash 二板起爆
const resolveSellStrategy = (stock, mode) => {
  const explicit = getPositionSellStrategy(stock);
  if (explicit) return explicit;
  if (mode === MODE_EXTREME_WIN) {
    return stock.cycle === 'reverse' ? 'extreme_win_reverse' : 'extreme_win_pro';
  }
  if (mode === MODE_ATTACK_DEFENSE) {
    return isTechWatchlistStock(stock.code)
      ? 'tech_attack'
      : (stock.cycle === 'reverse' ? 'extreme_win_reverse' : 'extreme_win_pro');
  }
  // 情绪游资-极致赔率：未显式设置卖点策略时按首板起爆口径（1min 时间桶）兜底
  if (mode === strategyModeState.MODE_WASH_FUSION) return 'first_board_wash';
  return 'tech_attack';
};

// 单笔持仓卖点诊断：同一股票的不同仓位各自独立诊断（各自买入日期 / 成本线 / 仓位）
//   口径与前端 diagnosePositionSellPoint 完全一致：买入当日不诊断、次日起生效
const diagnosePosition = async (stock, todayStr, mode, minuteEvalNow = true) => {
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
    const strategy = resolveSellStrategy(stock, mode);
    // 科技进攻的科技卖点按 10s 逐轮诊断；情绪游资-极致胜率、首板起爆、二板起爆均按 **1 分钟整数分钟** 诊断（2026-11-01 用户要求），
    //   非整数分钟直接复用本分钟首次诊断结果
    const minuteBased = strategy !== 'tech_attack';
    const cacheKey = String(base.positionId);
    if (minuteBased && !minuteEvalNow && ewSellCache.has(cacheKey)) return ewSellCache.get(cacheKey);
    let res;
    if (strategy === 'first_board_wash') {
      res = await checkFirstBoardWashSellPointDetailed(stock.code, stock.costPrice, stock.buyDate || null);
    } else if (strategy === 'second_board_wash') {
      res = await checkSecondBoardWashSellPointDetailed(stock.code, stock.costPrice, stock.buyDate || null);
    } else if (strategy === 'extreme_win_pro' || strategy === 'extreme_win_reverse') {
      // 逆周期持仓与回测逆周期腿同口径（2026-11-05 对齐，见 extremeWinBacktest.js / fusedEmoWinBacktest.js
      // 逆周期腿 scanLeaderPriceSell 调用参数）：⑪⑫不启用、单分钟跳水⑩不启用、成本线 -5% 须连续 ≥5 分钟
      res = await checkExtremeWinSellPointDetailed(stock.code, stock.costPrice, stock.buyDate || null, {
        enableOpenGapReboundSell: strategy !== 'extreme_win_reverse',
        // 2026-11-14 用户要求：⑪⑫仅在「买入之后的第二个交易日（买入日计第 1 天，即持仓次日）」或「当前亏损」时生效
        openGapLossOrSecondDayOnly: strategy !== 'extreme_win_reverse',
        ...(strategy === 'extreme_win_reverse'
          ? { disableMinutePlummet: true, costLineSustainMinutes: 5 }
          : {}),
      });
    } else {
      res = await checkSingleStockSellPoint(stock.code, stock.costPrice);
    }
    const merged = { ...res, ...base, sellStrategy: strategy, minuteBased };
    if (minuteBased && minuteEvalNow) ewSellCache.set(cacheKey, merged);
    return merged;
  } catch (e) {
    return { ...base, error: '诊断失败' };
  }
};

const tick = async () => {
  if (running) return; // 上一 tick 未完成则跳过，避免重入
  running = true;
  const startedAt = Date.now();
  try {
    const now = new Date();
    if (!isInPushWindow(now)) return;

    const mode = strategyModeState.getMode();
    const todayStr = dayjs().format('YYYY-MM-DD');
    const todayNum = dayjs().format('YYYYMMDD');
    const positions = getStockPositions() || [];
    if (positions.length === 0) return;

    // 分钟级策略（情绪游资-极致胜率 / 首板起爆）：卖点诊断只在 1 分钟整数分钟（9:30 / 9:31 / 9:32 …）执行一次，
    //   其余 10s tick 复用本分钟结果；科技进攻仍按 10s 逐轮诊断
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

    const results = await Promise.all(positions.map((stock) => diagnosePosition(stock, todayStr, mode, ewEvalNow)));
    const hitResults = results.filter((r) => r.isSell === true);
    const bucket = getCurrentClosedBucket(now);
    const data = { results, hitCount: hitResults.length, total: results.length };

    // 1) 每 10s 广播诊断结果（仅供前端展示，不触发打开）
    wsServer.broadcast({ type: 'sell_point', mode, bucket, ts: Date.now(), data, open: false });

    // 每个诊断周期都落盘（无论是否命中卖点），便于后续排查
    logSell({
      mode,
      bucket,
      results,
      hitCount: hitResults.length,
      total: results.length,
      durationMs: Date.now() - startedAt,
    });

    if (hitResults.length === 0) return;

    // 提醒开关关闭时：诊断结果照常广播（卡片数据仍更新），但不再发飞书、不广播 open:true
    const reminderEnabled = isReminderEnabled();
    let notified = false;

    // 2) 分钟级策略（情绪游资-极致胜率 / 首板起爆）：1 分钟整数分钟命中即通知（不等 5 分钟桶）；
    //    同一持仓同一分钟最多通知一次，跨分钟重新判定（2026-11-01：首板起爆卖点用 1min 时间桶）
    const minuteHits = hitResults.filter((r) => r.minuteBased);
    if (minuteHits.length > 0) {
      // 非 1min 整数分钟：本次结果为复用的上一分钟诊断，已在该分钟首次通知，不再重复通知
      if (ewEvalNow) {
        if (ewNotifiedDate !== todayNum) {
          ewNotifiedMinute.clear();
          ewNotifiedDate = todayNum;
        }
        const hitKeyOf = (r) => String(r.positionId || r.code || '');
        const freshHits = minuteHits.filter((r) => ewNotifiedMinute.get(hitKeyOf(r)) !== minuteKey);
        if (freshHits.length > 0) {
          // 无论是否提醒都先记录去重，避免重新打开开关后把同一分钟/同一桶的旧命中再补发一遍
          freshHits.forEach((r) => ewNotifiedMinute.set(hitKeyOf(r), minuteKey));
          if (reminderEnabled) {
            notified = true;
            try {
              await notifySellPointFeishu({ hitResults: freshHits });
            } catch (e) {
              console.error('卖点飞书发送失败:', e.message);
            }
          }
        }
      }
    }

    // 3) 其余策略（科技进攻）：命中且进入新的合法桶时通知（每桶最多一次）
    const otherHits = hitResults.filter((r) => !r.minuteBased);
    if (otherHits.length > 0 && bucket != null && lastNotifiedBucket !== bucket) {
      lastNotifiedBucket = bucket;
      if (reminderEnabled) {
        notified = true;
        try {
          await notifySellPointFeishu({ hitResults: otherHits });
        } catch (e) {
          console.error('卖点飞书发送失败:', e.message);
        }
      }
    }

    if (!notified) return;
    const notifyMinuteObj = {};
    ewNotifiedMinute.forEach((v, k) => { notifyMinuteObj[k] = v; });
    writeState({ date: todayNum, bucket: lastNotifiedBucket, mode, ewNotifiedMinute: notifyMinuteObj });
    wsServer.broadcast({ type: 'sell_point', mode, bucket, ts: Date.now(), data, open: true });
  } catch (e) {
    console.error('卖点诊断推送任务异常:', e.message);
    logSell({ error: e.message, durationMs: Date.now() - startedAt });
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

module.exports = { start, stop, isInPushWindow, isReminderEnabled, setReminderEnabled };
