const { HIGHEST_HALF_DESC } = require('../descs');

module.exports = {
  highest_gain: { id: 'highest_gain', name: '买入最高涨幅', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票' },
  highest_2d_gain: { id: 'highest_2d_gain', name: '2日涨幅最大', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票（按用户定义排序依据为触发时点当日盘中涨幅，非 2 日窗口累计涨幅）' },
  highest_3d_gain: { id: 'highest_3d_gain', name: '3日涨幅最大', desc: '买点命中时只买入最近 3 个交易日涨幅最大的股票' },
  highest_4d_gain: { id: 'highest_4d_gain', name: '4日涨幅最大', desc: '买点命中时只买入最近 4 个交易日涨幅最大的股票' },
  highest_5d_gain: { id: 'highest_5d_gain', name: '5日涨幅最大', desc: '买点命中时只买入最近 5 个交易日涨幅最大的股票' },
  highest_10d_gain: { id: 'highest_10d_gain', name: '10日涨幅最大', desc: '买点命中时只买入最近 10 个交易日涨幅最大的股票' },

  // N.5 日涨幅最大系列（highest_{N}d5_gain，2026-10-08 用户新增）：halfDayAfternoon: true → 选股窗口在
  // 最近 N 个交易日基础上额外复利计入「更前一个交易日（窗口最早日的再前一交易日）下午 13:00→收盘」的半日涨幅
  highest_2d5_gain: { id: 'highest_2d5_gain', name: '2.5日涨幅最大', desc: HIGHEST_HALF_DESC(2), halfDayAfternoon: true },
  highest_3d5_gain: { id: 'highest_3d5_gain', name: '3.5日涨幅最大', desc: HIGHEST_HALF_DESC(3), halfDayAfternoon: true },
};
