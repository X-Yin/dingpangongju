const SELL_CONDITION_PERSIST_MIN = 5; // 卖出条件持续满足分钟数

// 回测排除的股票（不参与任何策略的回测）
const EXCLUDED_CODES = new Set(['sh688498', 'sh688808']); // 源杰科技、联讯仪器
// 情绪开关系列阈值（prev{N}d_fall_low5_day_gain_emoswitch，2026-10-03 用户新增）：
// 触发买点时取上一交易日科技情绪指数的 3 日 EMA（getTechEmotionEmaMap，与情绪页「三日均值」曲线同源同算法），
// 低于该阈值 → 使用「前N日波动最小&当日涨幅最大」选股；否则 → 使用「3日涨幅最大」选股
const EMO_SWITCH_EMA_THRESHOLD = -60;
// 快进快出「温和回升」触发区间：上上个、上个交易日的当日科技情绪原始分（非 3 日 EMA）
// 均需严格处于该开区间且逐日回升
const EMO_QUICK_RANGE_LOW = -30;
const EMO_QUICK_RANGE_HIGH = 20;

module.exports = {
  EMO_QUICK_RANGE_HIGH,
  EMO_QUICK_RANGE_LOW,
  EMO_SWITCH_EMA_THRESHOLD,
  EXCLUDED_CODES,
  SELL_CONDITION_PERSIST_MIN,
};
