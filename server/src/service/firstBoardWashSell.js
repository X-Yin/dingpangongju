// 洗盘点卖点诊断（线上，2026-11-01 用户要求）
//   ① first_board_wash  首板起爆：首板洗盘-起爆拉升五条卖点（1min 时间桶）
//   ② second_board_wash 二板起爆：放量洗盘-二板起爆七条卖点（①~⑤ 同首板，⑥⑦ 为本策略新增；1min 时间桶）
//   与回测引擎（buySellBacktest/engine/firstBoardWashBacktest.js / volumeWashoutSecondBoardBacktest.js）同一套口径：
//     ① 跌破 5 日线（现价 < MA5，MA5 = 当日之前 5 个交易日收盘均值，不含当日收盘）：
//        收益率未拉开 +20% 时盘中分时跌破即卖；已拉开 +20%（收盘口径历史最高 ≥ +20%）时改为只在收盘判定
//     ② 跌破成本线：现价 < 买入价 × 0.97（-3%）须连续 5 分钟都跌破才卖；现价 < 买入价 × 0.95（-5%）立即卖
//     ③ 盘中跌停：分时跌幅 ≤ -9%（相对昨收）即视为跌停，立即卖
//     ④ 买入当日收盘涨停、买入次一交易日收盘未涨停 → 次一交易日收盘卖出（14:56 之后用现价近似收盘价判定）
//     ⑤ 买入次一交易日竞价低开（开盘涨幅 < 0）→ 9:30 竞价直接卖出
//     ⑥（仅二板起爆）收益率未拉开 +20% 之前，买入次日起某一天收盘未涨停 → 当日收盘卖出
//     ⑦（仅二板起爆）收益率未拉开 +20% 之前，任一持仓交易日竞价低开超过 -3% → 当日 9:30 按竞价开盘价卖出
//   线上时间桶：卖点诊断每 1 分钟一次（由 sellPointPushService 调度）
const dayjs = require('dayjs');
const { ensureBarsForCodes, getStockBarsCached } = require('./buySellBacktest/deps');
const { loadTlinePoints, round2, limitUpThresholdOf } = require('./buySellBacktest/engine/extremeWinScores');

const COST_STOP_PCT = -3;          // 成本线止损阈值
const COST_HARD_STOP_PCT = -5;     // 立即止损阈值
const COST_OBSERVE_MINUTES = 5;    // -3% 需连续 5 分钟
const LIMIT_DOWN_PCT = -9;         // 盘中跌幅 ≤ -9% 视为跌停
const PROFIT_UNLOCK_PCT = 20;      // 收益率拉开 +20% 后跌破 5 日线只在收盘判定
const CLOSE_EVAL_MINUTE = 1456;    // 14:56 起用现价近似收盘价判定收盘卖点
const GAP_DOWN_HARD_PCT = -3;      // 二板起爆⑦：竞价低开超过 -3%

const STRATEGY_META = {
  first_board_wash: {
    label: '首板洗盘-起爆拉升',
    conclusionHit: '已触发首板洗盘-起爆拉升卖点条件，建议卖出 / 减仓。',
    conclusionHold: '当前未达到首板洗盘-起爆拉升卖点条件，可以继续持有。',
    fallback: '当前未达到首板洗盘-起爆拉升卖点条件，可以继续持有',
  },
  second_board_wash: {
    label: '放量洗盘-二板起爆',
    conclusionHit: '已触发放量洗盘-二板起爆卖点条件，建议卖出 / 减仓。',
    conclusionHold: '当前未达到放量洗盘-二板起爆卖点条件，可以继续持有。',
    fallback: '当前未达到放量洗盘-二板起爆卖点条件，可以继续持有',
  },
};

const fmtMinute = (m) => {
  const num = Number(m);
  if (!Number.isFinite(num)) return '--';
  return `${String(Math.floor(num / 100)).padStart(2, '0')}:${String(num % 100).padStart(2, '0')}`;
};

const mkCond = (name, satisfied, detail, extra = {}) => ({
  name,
  satisfied,
  detail,
  exempted: !!extra.exempted,
  pending: !!extra.pending,
  pendingMinutes: extra.pendingMinutes != null ? extra.pendingMinutes : null,
});

// 连续跌破某价位的最大连续分钟数（午休不跨断：分钟值 1130 与 1300 之间视为断点）
const maxConsecutiveBelow = (points, threshold) => {
  let run = 0;
  let maxRun = 0;
  let runStart = null;
  let maxStart = null;
  let prevMinute = null;
  points.forEach((p) => {
    const minute = Number(p.minute);
    if (prevMinute != null && minute - prevMinute > 1) {
      run = 0;
      runStart = null;
    }
    prevMinute = minute;
    if (p.lastPx < threshold) {
      if (run === 0) runStart = minute;
      run += 1;
      if (run > maxRun) {
        maxRun = run;
        maxStart = runStart;
      }
    } else {
      run = 0;
      runStart = null;
    }
  });
  return { maxRun, maxStart };
};

const checkWashSellPointDetailed = async (code, costPrice, buyDate, strategy = 'first_board_wash') => {
  const meta = STRATEGY_META[strategy] || STRATEGY_META.first_board_wash;
  const isSecondBoard = strategy === 'second_board_wash';
  try {
    const targetDay = dayjs();
    const dateNum = Number(targetDay.format('YYYYMMDD'));
    const dateStr = targetDay.format('YYYYMMDD');
    const nowMinute = targetDay.hour() * 100 + targetDay.minute();

    // 1) 今日分时（现价 / 昨收 / 分钟序列）
    let t = null;
    try { t = await loadTlinePoints(code, dateNum); } catch (e) { t = null; }
    const points = (t && Array.isArray(t.points) ? t.points : []).filter((p) => p.lastPx > 0);
    const preclose = t && t.preclose > 0 ? Number(t.preclose) : null;
    if (points.length === 0 || preclose == null) {
      return {
        success: false, isSell: false, reasons: ['分时数据不足'], stockName: code,
        tradeDate: dateNum, conditions: [], conclusion: '分时数据不足，无法诊断', sellStrategy: strategy,
      };
    }
    const lastPt = points[points.length - 1];
    const lastPx = Number(lastPt.lastPx);
    const chgOf = (px) => (preclose > 0 ? round2(((px - preclose) / preclose) * 100) : null);

    // 2) 日K（MA5 / 买入日涨停 / 历史最高收盘收益）
    await ensureBarsForCodes(new Set([code]));
    const bars = getStockBarsCached(code) || [];
    const todayIdx = bars.findIndex((b) => String(b.d) === dateStr);
    const buyIdx = buyDate ? bars.findIndex((b) => String(b.d) === String(buyDate).replace(/-/g, '')) : -1;
    const prevBars = todayIdx >= 0 ? bars.slice(0, todayIdx) : bars;
    const ma5 = prevBars.length >= 5
      ? round2(prevBars.slice(-5).reduce((sum, b) => sum + Number(b.c), 0) / 5)
      : null;

    const effCostPrice = Number(costPrice);
    const hasCost = Number.isFinite(effCostPrice) && effCostPrice > 0;
    const stopPx = hasCost ? effCostPrice * (1 + COST_STOP_PCT / 100) : null;
    const hardStopPx = hasCost ? effCostPrice * (1 + COST_HARD_STOP_PCT / 100) : null;

    // 收益率已拉开 +20%（收盘口径历史最高，含买入当日收盘；今日未收盘不计）
    let maxCloseGainPct = null;
    if (hasCost && buyIdx >= 0) {
      const endIdx = todayIdx >= 0 ? todayIdx : bars.length;
      for (let i = buyIdx; i < endIdx; i += 1) {
        const c = Number(bars[i].c);
        if (!(c > 0)) continue;
        const ret = round2(((c - effCostPrice) / effCostPrice) * 100);
        maxCloseGainPct = maxCloseGainPct == null ? ret : Math.max(maxCloseGainPct, ret);
      }
    }
    const profitUnlocked = maxCloseGainPct != null && maxCloseGainPct >= PROFIT_UNLOCK_PCT;

    // 买入次一交易日：今日即买入日的下一个交易日
    const isDay2 = buyIdx >= 0 && (todayIdx >= 0
      ? buyIdx === todayIdx - 1
      : buyIdx === bars.length - 1);
    // 买入次日起（含 T+1 及之后，A 股 T+1 当日不卖）
    const isAfterBuy = buyIdx >= 0 && (todayIdx >= 0
      ? todayIdx > buyIdx
      : buyIdx === bars.length - 1);

    const thr = limitUpThresholdOf(code);
    const openPx = points[0].lastPx;
    const openChg = round2(((openPx - preclose) / preclose) * 100);
    const minChg = points.reduce((min, p) => {
      const v = chgOf(p.lastPx);
      return v == null ? min : (min == null || v < min ? v : min);
    }, null);

    const conditions = [];

    // ⑤ 买入次一交易日竞价低开 → 9:30 竞价直接卖出
    conditions.push(mkCond(
      '买入次一交易日竞价低开 → 9:30 直接卖出',
      isDay2 && openChg < 0,
      isDay2
        ? `今日为买入次一交易日，竞价开盘 ${fmtMinute(points[0].minute)} 价 ${round2(openPx)}（昨收 ${round2(preclose)}，开盘涨幅 ${openChg}%），${openChg < 0 ? '竞价低开 → 9:30 按竞价价直接卖出' : '竞价未低开，不触发'}`
        : '非买入次一交易日（或买入日期缺失），不判定',
    ));

    // ⑦（仅二板起爆）收益率未拉开 +20% 前，任一持仓交易日竞价低开超过 -3% → 9:30 竞价直接卖出
    if (isSecondBoard) {
      conditions.push(mkCond(
        `收益率未拉开 +${PROFIT_UNLOCK_PCT}% 前竞价低开超过 ${GAP_DOWN_HARD_PCT}% → 9:30 直接卖出`,
        isAfterBuy && !profitUnlocked && openChg < GAP_DOWN_HARD_PCT,
        !isAfterBuy
          ? '买入当日不卖（T+1），不判定'
          : profitUnlocked
            ? `收益率已拉开 +${PROFIT_UNLOCK_PCT}%（历史最高收盘 ${maxCloseGainPct}%），该条不再触发`
            : `竞价开盘涨幅 ${openChg}%（昨收 ${round2(preclose)} → 竞价 ${round2(openPx)}），${openChg < GAP_DOWN_HARD_PCT ? `超过 ${GAP_DOWN_HARD_PCT}%，9:30 竞价直接卖出` : `未超过 ${GAP_DOWN_HARD_PCT}%，不触发`}`,
        { exempted: isAfterBuy && profitUnlocked },
      ));
    }

    // ③ 盘中跌停（当日跌幅 ≤ -9%）
    conditions.push(mkCond(
      '盘中跌停（当日 ≤ -9%）',
      minChg != null && minChg <= LIMIT_DOWN_PCT,
      `当日最低分时涨跌幅 ${minChg == null ? '--' : `${minChg}%`}（昨收 ${round2(preclose)}），${minChg != null && minChg <= LIMIT_DOWN_PCT ? '已跌停，立即卖出' : `未达 ${LIMIT_DOWN_PCT}%`}`,
    ));

    // ②a 跌破成本线 -5%：立即卖出
    conditions.push(mkCond(
      '跌破成本线 -5%（立即卖出）',
      hasCost ? lastPx < hardStopPx : false,
      hasCost
        ? `成本 ${round2(effCostPrice)}，止损价 ${round2(hardStopPx)}，现价 ${round2(lastPx)}（较成本 ${round2(((lastPx - effCostPrice) / effCostPrice) * 100)}%），${lastPx < hardStopPx ? '已跌破 -5%，立即卖出' : '未跌破'}`
        : '成本价缺失，无法判定',
    ));

    // ②b 跌破成本线 -3% 连续 5 分钟
    let costObserve = { maxRun: 0, maxStart: null };
    if (hasCost) {
      costObserve = maxConsecutiveBelow(points, stopPx);
    }
    conditions.push(mkCond(
      `连续 ${COST_OBSERVE_MINUTES} 分钟跌破成本线 -3%`,
      hasCost ? costObserve.maxRun >= COST_OBSERVE_MINUTES : false,
      hasCost
        ? `成本 ${round2(effCostPrice)}，观察价 ${round2(stopPx)}；当前最长连续跌破 ${costObserve.maxRun} 分钟${costObserve.maxStart != null ? `（自 ${fmtMinute(costObserve.maxStart)} 起）` : ''}，${costObserve.maxRun >= COST_OBSERVE_MINUTES ? `已连续 ${COST_OBSERVE_MINUTES} 分钟，卖出` : '未满足'}`
        : '成本价缺失，无法判定',
      { pendingMinutes: hasCost ? costObserve.maxRun : null },
    ));

    // ① 跌破 5 日线（盘中；收益率已拉开 +20% 时豁免，改由收盘判定）
    conditions.push(mkCond(
      '跌破 5 日线（盘中）',
      !profitUnlocked && ma5 != null && lastPx < (ma5 || 0),
      ma5 == null
        ? '日K数据不足，无法计算 5 日线'
        : `MA5 ${round2(ma5)}，现价 ${round2(lastPx)}（低于 5 日线 ${round2(((lastPx - ma5) / ma5) * 100)}%）${profitUnlocked ? `；收益率已拉开 +${PROFIT_UNLOCK_PCT}%（历史最高 ${maxCloseGainPct}%），改由收盘判定` : ''}`,
      { exempted: profitUnlocked },
    ));

    const closeEvalNow = nowMinute >= CLOSE_EVAL_MINUTE;
    const closePx = todayIdx >= 0 ? Number(bars[todayIdx].c) : lastPx;
    const todayPct = preclose > 0 && closePx > 0 ? round2(((closePx - preclose) / preclose) * 100) : null;
    const todayLimitUp = todayPct != null && todayPct >= thr;

    // ④ 买入当日收盘涨停、买入次一交易日收盘未涨停 → 次一交易日收盘卖出
    let buyDayLimitUp = false;
    if (buyIdx > 0) {
      const bPre = Number(bars[buyIdx - 1].c);
      const bClose = Number(bars[buyIdx].c);
      buyDayLimitUp = bPre > 0 && bClose > 0 && round2(((bClose - bPre) / bPre) * 100) >= thr;
    }
    conditions.push(mkCond(
      '买入当日涨停而次日收盘未涨停 → 收盘卖出',
      closeEvalNow && isDay2 && buyDayLimitUp && !todayLimitUp,
      !closeEvalNow
        ? '未到收盘判定时间（14:56 起判定）'
        : !isDay2
          ? '非买入次一交易日，不判定'
          : !buyDayLimitUp
            ? '买入当日收盘未涨停，不触发'
            : `买入当日收盘涨停，今日收盘涨幅 ${todayPct == null ? '--' : `${todayPct}%`}，${todayLimitUp ? '收盘涨停，不卖出' : '收盘未涨停，卖出'}`,
      { pending: !closeEvalNow },
    ));

    // ⑥（仅二板起爆）收益率未拉开 +20% 前，买入次日起某一天收盘未涨停 → 当日收盘卖出
    if (isSecondBoard) {
      conditions.push(mkCond(
        `收益率未拉开 +${PROFIT_UNLOCK_PCT}% 前收盘未涨停 → 收盘卖出`,
        closeEvalNow && isAfterBuy && !profitUnlocked && !todayLimitUp,
        !isAfterBuy
          ? '买入当日不卖（T+1），不判定'
          : profitUnlocked
            ? `收益率已拉开 +${PROFIT_UNLOCK_PCT}%（历史最高收盘 ${maxCloseGainPct}%），该条不再触发`
            : !closeEvalNow
              ? '未到收盘判定时间（14:56 起判定）'
              : `今日收盘涨幅 ${todayPct == null ? '--' : `${todayPct}%`}，${todayLimitUp ? '收盘涨停，不卖出' : '收盘未涨停，卖出'}`,
        { exempted: isAfterBuy && profitUnlocked, pending: isAfterBuy && !profitUnlocked && !closeEvalNow },
      ));
    }

    // ①（收盘分支）收益率已拉开 +20% 后，收盘跌破 5 日线即卖
    conditions.push(mkCond(
      '收益率已拉开 +20% 后收盘跌破 5 日线',
      closeEvalNow && profitUnlocked && ma5 != null && closePx > 0 && closePx < ma5,
      !profitUnlocked
        ? `收益率未拉开 +${PROFIT_UNLOCK_PCT}%（历史最高 ${maxCloseGainPct == null ? '--' : `${maxCloseGainPct}%`}），不适用`
        : !closeEvalNow
          ? '未到收盘判定时间（14:56 起判定）'
          : `历史最高收盘收益 ${maxCloseGainPct}%，收盘 ${round2(closePx)} ${ma5 != null && closePx < ma5 ? `< MA5 ${round2(ma5)}，收盘卖出` : `≥ MA5 ${round2(ma5)}，不卖出`}`,
      { pending: profitUnlocked && !closeEvalNow },
    ));

    const isSell = conditions.some((c) => c.satisfied && !c.exempted && !c.pending);
    const reasons = isSell
      ? conditions.filter((c) => c.satisfied && !c.exempted).map((c) => c.detail)
      : [meta.fallback];

    return {
      success: true,
      isSell,
      reasons,
      stockName: code,
      tradeDate: dateNum,
      conditions,
      conclusion: isSell ? meta.conclusionHit : meta.conclusionHold,
      sellStrategy: strategy,
      detail: {
        closePrice: round2(lastPx),
        change: chgOf(lastPx),
        preclose: round2(preclose),
        ma5,
        maxCloseGainPct,
        costPrice: hasCost ? round2(effCostPrice) : null,
      },
    };
  } catch (error) {
    console.error(`${meta.label}卖点诊断失败:`, error);
    return {
      success: false,
      isSell: false,
      reasons: ['诊断失败'],
      stockName: code,
      conditions: [],
      conclusion: '诊断失败',
      sellStrategy: strategy,
    };
  }
};

const checkFirstBoardWashSellPointDetailed = (code, costPrice = null, buyDate = null) => (
  checkWashSellPointDetailed(code, costPrice, buyDate, 'first_board_wash')
);

const checkSecondBoardWashSellPointDetailed = (code, costPrice = null, buyDate = null) => (
  checkWashSellPointDetailed(code, costPrice, buyDate, 'second_board_wash')
);

module.exports = {
  checkWashSellPointDetailed,
  checkFirstBoardWashSellPointDetailed,
  checkSecondBoardWashSellPointDetailed,
  COST_STOP_PCT,
  COST_HARD_STOP_PCT,
  COST_OBSERVE_MINUTES,
  LIMIT_DOWN_PCT,
  PROFIT_UNLOCK_PCT,
  GAP_DOWN_HARD_PCT,
};
