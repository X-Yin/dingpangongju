const { LIANBAN_GAIN_DESC } = require('../descs');

// 情绪游资-连板 N 日涨幅最大系列（2026-10-11 用户新增；lianbanGainDays: N → 独立引擎 runLianbanGainBacktest，
// 不复用重点板块引擎）：买点 = 上证指数 3 日线斜率为正即可买（前一日收盘为正则 9:30 起、盘中由负转正则转正桶买）；
// 选股 = 上一交易日涨停数 > 15 的板块内非首板主板个股中 N 日涨幅最大者（无此类板块当日不买、不做一字板顺延）；
// 卖点 = 抗分歧 < 9 ∪ 高位放量大阴线 ∪ 爆量分歧(量比>1.2,收盘) ∪ 跌停 ∪ 跌破成本线 -2%；全仓，成本线止损 -2%
module.exports = {
  hot_money_lianban_2d_gain: { id: 'hot_money_lianban_2d_gain', name: '情绪游资-连板2日涨幅最大', desc: LIANBAN_GAIN_DESC(2), lianbanGainDays: 2, costLinePct: 2 },
  hot_money_lianban_3d_gain: { id: 'hot_money_lianban_3d_gain', name: '情绪游资-连板3日涨幅最大', desc: LIANBAN_GAIN_DESC(3), lianbanGainDays: 3, costLinePct: 2 },
};