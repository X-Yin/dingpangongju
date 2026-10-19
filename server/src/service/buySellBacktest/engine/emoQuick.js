const { EMO_QUICK_RANGE_HIGH, EMO_QUICK_RANGE_LOW, EMO_SWITCH_EMA_THRESHOLD } = require('../constants');
const { getTechEmotionEmaMap, getTechEmotionRawMap } = require('../utils/techEmotion');

// 计算「快进快出」标注（买入时点判定）：
//   ① 上一交易日科技情绪 3 日 EMA < -30；② 上上个/上个交易日当日科技情绪均处 (-30, -10) 且回升。
// 两次买入系列（highest_{N}d_gain_two_buy）复用该能力，在首次建仓时调用并把结果挂到持仓上。
// 入参须与 pickBestStock 一致：di 为日期轴（含预热日）绝对索引、rangeDates 为日期轴，方能取到同一「上一交易日」。
const computeEmoQuickOutInfo = (di, rangeDates) => {
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
  return {
    quickOut: quickByEmaBelow || quickByRangeRising,
    trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
    ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
    prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null,
    prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null,
  };
};

module.exports = {
  computeEmoQuickOutInfo,
};
