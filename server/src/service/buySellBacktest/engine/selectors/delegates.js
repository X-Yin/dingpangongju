// 选股委派注册表（策略行为 hook 化）：
// 把「先按策略 id 判定、再委托到其它策略 / 独立选股函数」的路由逻辑集中到本文件，
// pickBestStock 只保留共享流水线（候选过滤 / 涨停与一字板顺延 / 抗分歧门槛 / 周期过滤 / 排序）。
// 命中委派的策略：情绪快进快出（含研报双门）。
// 递归委托时 pickBestStock 由调用方注入（避免 pickBest ←→ delegates 循环 require）。
const { getTechEmotionEmaMap, getTechEmotionRawMap } = require('../../utils/techEmotion');
const { EMO_QUICK_RANGE_HIGH, EMO_QUICK_RANGE_LOW, EMO_SWITCH_EMA_THRESHOLD } = require('../../constants');

// 返回 undefined 表示该策略不由委派层处理（交回 pickBestStock 主流水线继续）；
// 否则返回选股结果（可能为 null，表示命中委派但本次不买入）。
const resolveDelegatePick = (ctx) => {
  const {
    pickBestStock, stocks, rangeDates, di, bucket, replayStocks, dailyInfos,
    strategyId, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet,
  } = ctx;

  // 情绪快进快出系列（highest_{N}d_gain_emoquick，2026-10-03 用户新增）：买点触发时均可正常买入
  // （不跳过），委托「N 日涨幅最大」（highest_{N}d_gain）选股；满足以下任一条件的日子，本次买入标记
  // 为「快进快出」（emoQuickOut.quickOut = true）：该笔持仓不走通用 7 条件卖点，买入次日 10:00 强制
  // 卖出、盘中跌破成本线 -2% 先到先卖止损（2026-10-05 新增；见 runRangeBacktest / runRangeBacktestMulti
  // 的每日预桶快进快出卖点）：
  //   1) 上一交易日科技情绪指数的 3 日 EMA（getTechEmotionEmaMap，与情绪页「三日均值」同源同算法）< -30
  //   2) 上上个、上个交易日的当日科技情绪原始分（getTechEmotionRawMap，非 3 日 EMA）均处 (-30, -10)
  //      区间且上个 > 上上个（情绪温和回升）
  // 两条件均不满足（或数据缺失）时为普通持仓，走通用卖点。递归调用不会再次命中本分支（委托 ID 无
  // _emoquick 后缀），买入复用全部通用机制（涨停顺延/抗分歧门槛/跨指数双门禁等）
  const emoQuickMatch = strategyId.match(/^highest_(\d+d\d*)_gain_emoquick$/);
  if (emoQuickMatch) {
    const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日（日期轴均为交易日）
    const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
    const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
    const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
    const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
    const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
    const quickByRangeRising = prev2Raw != null && prevRaw != null
      && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
      && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
      && prevRaw > prev2Raw;
    const quickPicked = pickBestStock(stocks, rangeDates, di, bucket, replayStocks, dailyInfos, `highest_${emoQuickMatch[1]}_gain`, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet);
    if (quickPicked) {
      // 附带快进快出标注：经 withResilienceGateInfo 写入买入原因与买入条件明细（emo_quick_out），
      // 并随持仓（positions[].emoQuickOut）传递给卖点侧，决定是否次日 10:00 强制卖出
      quickPicked.emoQuickOut = {
        quickOut: quickByEmaBelow || quickByRangeRising,
        trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
        ema: prevEma != null ? Number(prevEma.toFixed(2)) : null, // 上一交易日 3 日 EMA（条件①判定值）
        prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null, // 上一交易日当日科技情绪（条件②）
        prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null, // 上上个交易日当日科技情绪（条件②）
      };
    }
    return quickPicked;
  }

  // 快进快出 × 研报覆盖双门策略（highest_3d_reports_top5_gain_emoquick，2026-10-04 用户新增）：
  // 在 highest_3d_gain_emoquick 的基础上，仅当快进快出的触发条件是「上一交易日 3 日 EMA < -30」时，
  // 选股口径从「3日涨幅最大」改为「最近 3 日研报覆盖数前五（含并列）→ 组内 3 日涨幅最大」
  // （委托到已有的 highest_3d_reports_top5_gain 策略，天然走 isTop5ReportGainMode 分支）；
  // 温和回升快进快出路径 / 非快进快出路径 / EMA 缺失时 → 仍委托 highest_3d_gain
  // 卖出行为（emoQuickOut 标注 + 次日 10:00 强卖）与 highest_3d_gain_emoquick 完全一致
  if (strategyId === 'highest_3d_reports_top5_gain_emoquick') {
    const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日
    const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
    const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
    const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
    const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
    const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
    const quickByRangeRising = prev2Raw != null && prevRaw != null
      && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
      && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
      && prevRaw > prev2Raw;
    // 关键：只有走「上一交易日 3 日 EMA < -30」这条快进快出路径才切换到研报前五选股；
    // 温和回升 / 数据缺失 / 非快进快出 都用原 3 日涨幅最大选股
    const delegateId = quickByEmaBelow ? 'highest_3d_reports_top5_gain' : 'highest_3d_gain';
    const quickPicked = pickBestStock(stocks, rangeDates, di, bucket, replayStocks, dailyInfos, delegateId, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet);
    if (quickPicked) {
      quickPicked.emoQuickOut = {
        quickOut: quickByEmaBelow || quickByRangeRising,
        trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
        ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
        prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null,
        prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null,
      };
    }
    return quickPicked;
  }

  return undefined; // 未命中任何委派：交回 pickBestStock 主流水线
};

module.exports = { resolveDelegatePick };
