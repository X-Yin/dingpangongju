const { EMO_SWITCH_DESC } = require('../descs');

module.exports = {
  // 情绪开关系列（2026-10-03 用户新增）：上一交易日科技情绪 3 日 EMA < -60 → 前N日波动最小&当日涨幅最大，否则 → 3日涨幅最大
  prev3d_fall_low5_day_gain_emoswitch: { id: 'prev3d_fall_low5_day_gain_emoswitch', name: '前三波动最小&当日涨最大/3日涨幅开关', desc: EMO_SWITCH_DESC(3) },
  prev2d_fall_low5_day_gain_emoswitch: { id: 'prev2d_fall_low5_day_gain_emoswitch', name: '前二波动最小&当日涨最大/3日涨幅开关', desc: EMO_SWITCH_DESC(2) },
  prev1d_fall_low5_day_gain_emoswitch: { id: 'prev1d_fall_low5_day_gain_emoswitch', name: '昨日波动最小&当日涨最大/3日涨幅开关', desc: EMO_SWITCH_DESC(1) },
};
