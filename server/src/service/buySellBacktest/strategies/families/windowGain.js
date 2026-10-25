const { HIGHEST_HALF_DESC, EMO_QUICK_FUND_GATE_DESC } = require('../descs');

// 「资金净流入阈值动态调节」desc 后缀（2026-10-21 用户新增，N日涨幅最大系列适用，见 engine/rangeBacktest.js fundGate）：
// 连续 2 笔已完结交易折算收益率均未超 3% → 买点诊断资金净流入阈值 20 → 30 亿；任一笔超 3% → 降回 20 亿
const GAIN_FUND_GATE_DESC = `。${EMO_QUICK_FUND_GATE_DESC}`;

module.exports = {
  highest_gain: { id: 'highest_gain', name: '买入最高涨幅', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票' },
  highest_2d_gain: { id: 'highest_2d_gain', name: '2日涨幅最大', desc: `买点命中时只买入触发时点当日盘中涨幅最大的股票（按用户定义排序依据为触发时点当日盘中涨幅，非 2 日窗口累计涨幅）${GAIN_FUND_GATE_DESC}`, dynamicFundGate: true },
  highest_3d_gain: { id: 'highest_3d_gain', name: '3日涨幅最大', desc: `买点命中时只买入最近 3 个交易日涨幅最大的股票${GAIN_FUND_GATE_DESC}`, dynamicFundGate: true },
  highest_4d_gain: { id: 'highest_4d_gain', name: '4日涨幅最大', desc: `买点命中时只买入最近 4 个交易日涨幅最大的股票${GAIN_FUND_GATE_DESC}`, dynamicFundGate: true },
  highest_5d_gain: { id: 'highest_5d_gain', name: '5日涨幅最大', desc: `买点命中时只买入最近 5 个交易日涨幅最大的股票${GAIN_FUND_GATE_DESC}`, dynamicFundGate: true },
  highest_10d_gain: { id: 'highest_10d_gain', name: '10日涨幅最大', desc: `买点命中时只买入最近 10 个交易日涨幅最大的股票${GAIN_FUND_GATE_DESC}`, dynamicFundGate: true },

  // N.5 日涨幅最大系列（highest_{N}d5_gain，2026-10-08 用户新增）：halfDayAfternoon: true → 选股窗口在
  // 最近 N 个交易日基础上额外复利计入「更前一个交易日（窗口最早日的再前一交易日）下午 13:00→收盘」的半日涨幅
  highest_2d5_gain: { id: 'highest_2d5_gain', name: '2.5日涨幅最大', desc: `${HIGHEST_HALF_DESC(2)}${GAIN_FUND_GATE_DESC}`, halfDayAfternoon: true, dynamicFundGate: true },
  highest_3d5_gain: { id: 'highest_3d5_gain', name: '3.5日涨幅最大', desc: `${HIGHEST_HALF_DESC(3)}${GAIN_FUND_GATE_DESC}`, halfDayAfternoon: true, dynamicFundGate: true },

  // N日涨幅最大-成交量占比系列（gainVolumeShareMode，2026-10-25 用户新增；独立引擎 engine/gainVolumeShareBacktest.js）
  // 选股：33 个一级板块中，上一交易日 T-1 成交量占比的 3 日线斜率为正、且 T-1 占比较此前 5 个交易日最低占比高出 30% 以上
  //（该最低占比须 > 5%；多个板块满足时取 T-1 与 T-2 占比差值最大者）
  // → 该板块沪深主板/创业板/科创板成分股中，按最近 N 日涨幅（含当日 9:40 分时涨幅，复利）取前 5
  // → 只在 9:40 单点买入排名最高且满足「9:40 未涨停 + 分时涨幅 > 0 + 现价 > 当日开盘价」的一只，无合格当日跳过
  // 卖点：与 N 日涨幅最大一致（通用 7 条件 + 盘中大跌 -7% 强卖）；全仓单持仓
  highest_2d_gain_volume_share: {
    id: 'highest_2d_gain_volume_share',
    name: '2日涨幅最大-成交量占比',
    desc: '选股：33 个一级板块中取上一交易日成交量占比的 3 日线斜率为正且较此前 5 个交易日最低占比高出 30% 以上（且该最低占比 > 5%）的板块（多个满足时取占比较上上交易日增幅最大者），在该板块沪深主板/创业板/科创板成分股中取最近 2 日涨幅（含当日 9:40 分时涨幅，复利口径）前 5；仅在 9:40 买入排名最高且未涨停、分时涨幅为正且高于开盘价的一只，无合格则当日跳过；卖点同「2日涨幅最大」（通用 7 条件 + 盘中大跌 -7% 强卖）；全仓单持仓',
    gainVolumeShareMode: true,
    gainVolumeShareDays: 2,
  },
  highest_3d_gain_volume_share: {
    id: 'highest_3d_gain_volume_share',
    name: '3日涨幅最大-成交量占比',
    desc: '选股：33 个一级板块中取上一交易日成交量占比的 3 日线斜率为正且较此前 5 个交易日最低占比高出 30% 以上（且该最低占比 > 5%）的板块（多个满足时取占比较上上交易日增幅最大者），在该板块沪深主板/创业板/科创板成分股中取最近 3 日涨幅（含当日 9:40 分时涨幅，复利口径）前 5；仅在 9:40 买入排名最高且未涨停、分时涨幅为正且高于开盘价的一只，无合格则当日跳过；卖点同「3日涨幅最大」（通用 7 条件 + 盘中大跌 -7% 强卖）；全仓单持仓',
    gainVolumeShareMode: true,
    gainVolumeShareDays: 3,
  },
  highest_4d_gain_volume_share: {
    id: 'highest_4d_gain_volume_share',
    name: '4日涨幅最大-成交量占比',
    desc: '选股：33 个一级板块中取上一交易日成交量占比的 3 日线斜率为正且较此前 5 个交易日最低占比高出 30% 以上（且该最低占比 > 5%）的板块（多个满足时取占比较上上交易日增幅最大者），在该板块沪深主板/创业板/科创板成分股中取最近 4 日涨幅（含当日 9:40 分时涨幅，复利口径）前 5；仅在 9:40 买入排名最高且未涨停、分时涨幅为正且高于开盘价的一只，无合格则当日跳过；卖点同「4日涨幅最大」（通用 7 条件 + 盘中大跌 -7% 强卖）；全仓单持仓',
    gainVolumeShareMode: true,
    gainVolumeShareDays: 4,
  },
  highest_5d_gain_volume_share: {
    id: 'highest_5d_gain_volume_share',
    name: '5日涨幅最大-成交量占比',
    desc: '选股：33 个一级板块中取上一交易日成交量占比的 3 日线斜率为正且较此前 5 个交易日最低占比高出 30% 以上（且该最低占比 > 5%）的板块（多个满足时取占比较上上交易日增幅最大者），在该板块沪深主板/创业板/科创板成分股中取最近 5 日涨幅（含当日 9:40 分时涨幅，复利口径）前 5；仅在 9:40 买入排名最高且未涨停、分时涨幅为正且高于开盘价的一只，无合格则当日跳过；卖点同「5日涨幅最大」（通用 7 条件 + 盘中大跌 -7% 强卖）；全仓单持仓',
    gainVolumeShareMode: true,
    gainVolumeShareDays: 5,
  },
};
