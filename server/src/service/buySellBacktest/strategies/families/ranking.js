module.exports = {
  highest_3d_reports: { id: 'highest_3d_reports', name: '3日研报覆盖数最多', desc: '买点命中时只买入过去 3 个交易日（含当日）研报覆盖数最多的股票（覆盖数相同取 3 日涨幅最大）；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_reports: { id: 'highest_5d_reports', name: '5日研报覆盖数最多', desc: '买点命中时只买入过去 5 个交易日（含当日）研报覆盖数最多的股票（覆盖数相同取 5 日涨幅最大）；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_3d_reports_top5_gain: { id: 'highest_3d_reports_top5_gain', name: '3日研报前五&涨幅最大', desc: '买点命中时在最近 3 个交易日（含当日）研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_reports_top5_gain: { id: 'highest_5d_reports_top5_gain', name: '5日研报前五&涨幅最大', desc: '买点命中时在最近 5 个交易日（含当日）研报覆盖数前五（含覆盖数相同的股票）中买入 5 日涨幅最大的一只；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
};
