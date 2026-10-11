module.exports = {
  highest_3d_ma_slope: { id: 'highest_3d_ma_slope', name: '3日线斜率最陡峭', desc: '买点命中时只买入 3 日涨幅均线斜率角度最大的股票' },
  highest_5d_ma_slope: { id: 'highest_5d_ma_slope', name: '5日线斜率最陡峭', desc: '买点命中时只买入 5 日涨幅均线斜率角度最大的股票' },
  highest_3d_reports: { id: 'highest_3d_reports', name: '3日研报覆盖数最多', desc: '买点命中时只买入过去 3 个交易日（含当日）研报覆盖数最多的股票（覆盖数相同取 3 日涨幅最大）；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_reports: { id: 'highest_5d_reports', name: '5日研报覆盖数最多', desc: '买点命中时只买入过去 5 个交易日（含当日）研报覆盖数最多的股票（覆盖数相同取 5 日涨幅最大）；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_3d_reports_top5_gain: { id: 'highest_3d_reports_top5_gain', name: '3日研报前五&涨幅最大', desc: '买点命中时在最近 3 个交易日（含当日）研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_reports_top5_gain: { id: 'highest_5d_reports_top5_gain', name: '5日研报前五&涨幅最大', desc: '买点命中时在最近 5 个交易日（含当日）研报覆盖数前五（含覆盖数相同的股票）中买入 5 日涨幅最大的一只；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_resilience: { id: 'highest_5d_resilience', name: '5日抗分歧分数最大', desc: '买点命中时只买入最近 5 个交易日抗分歧分数汇总最大的股票' },
  highest_3d_resilience: { id: 'highest_3d_resilience', name: '3日抗分歧分数最大', desc: '买点命中时只买入最近 3 个交易日抗分歧分数汇总最大的股票' },
  resilience_weak_to_strong: { id: 'resilience_weak_to_strong', name: '抗分歧弱转强', desc: '买点命中时先筛选出当日抗分歧分数>11 的股票，再从中计算最近 4 个交易日「前两天均值」与「最近两天均值」的差值（差值越大=抗分歧由弱转强越明显），全仓买入差值最大的股票；差值相同则买入当日涨幅最大的一只' },

  // 当日实时口径系列（2026-10-03 用户新增）：抗分歧分数/当日涨幅/3 日涨幅均按买点触发时刻的分时数据实时计算，不取当日收盘状态
  highest_1d_resilience: { id: 'highest_1d_resilience', name: '当日抗分歧分数最大', desc: '买点命中时只买入触发时点当日实时抗分歧分数最大的股票（抗分歧分数按触发时刻截至当时的日内分时数据实时计算，非收盘口径）；分数相同时取触发时点当日实时涨幅最大的一只' },
};
