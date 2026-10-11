const { ICE_DESC, ICE_REV_DESC } = require('../descs');

module.exports = {
  // 顺周期情绪游资-N日涨幅最大系列（2026-10-04 用户新增，2026-10-10 由「逆周期情绪游资」改名；
  // iceMode: true → 复用 runKeyBlockBacktest，但与重点板块系列不同：信号指数为上证指数，
  // 斜率由负转正才买（9:40 后）、由正转负即卖（与上证自身同向=顺周期）；只用「防御+中性」tag 板块，全仓；
  // 成本线止损为 -2%（costLinePct: 2，区别于重点板块防御持仓的 -5%））
  hot_money_ice_2d_gain: { id: 'hot_money_ice_2d_gain', name: '顺周期情绪游资-前2日涨幅最大', desc: ICE_DESC(2), keyBlockDays: 2, iceMode: true, costLinePct: 2 },
  hot_money_ice_3d_gain: { id: 'hot_money_ice_3d_gain', name: '顺周期情绪游资-前3日涨幅最大', desc: ICE_DESC(3), keyBlockDays: 3, iceMode: true, costLinePct: 2 },
  hot_money_ice_4d_gain: { id: 'hot_money_ice_4d_gain', name: '顺周期情绪游资-前4日涨幅最大', desc: ICE_DESC(4), keyBlockDays: 4, iceMode: true, costLinePct: 2 },
  hot_money_ice_5d_gain: { id: 'hot_money_ice_5d_gain', name: '顺周期情绪游资-前5日涨幅最大', desc: ICE_DESC(5), keyBlockDays: 5, iceMode: true, costLinePct: 2 },
  hot_money_ice_10d_gain: { id: 'hot_money_ice_10d_gain', name: '顺周期情绪游资-前10日涨幅最大', desc: ICE_DESC(10), keyBlockDays: 10, iceMode: true, costLinePct: 2 },
  // 逆周期情绪游资-N日涨幅最大系列（2026-10-10 用户新增；iceMode + iceReverse → 复用 runKeyBlockBacktest，
  // 与顺周期情绪游资完全镜像：上证斜率由正转负的次日 9:40 且依旧为负才买、由负转正当桶即卖；
  // 候选池与顺周期一致（防御+中性 tag 板块成分股 ∪ 红利板块三板及以上连板个股）；涨停顺延/抗分歧门槛等与顺周期一致，全仓；成本线止损 -2%；
  // 1 日变体（iceIntradayGain: true）选股口径为「当日分时涨幅（触发时点实时涨幅）最大」）
  hot_money_ice_rev_1d_gain: { id: 'hot_money_ice_rev_1d_gain', name: '逆周期情绪游资-当日分时涨幅最大', desc: ICE_REV_DESC(1), keyBlockDays: 1, iceMode: true, iceReverse: true, iceIntradayGain: true, costLinePct: 2 },
  hot_money_ice_rev_2d_gain: { id: 'hot_money_ice_rev_2d_gain', name: '逆周期情绪游资-前2日涨幅最大', desc: ICE_REV_DESC(2), keyBlockDays: 2, iceMode: true, iceReverse: true, costLinePct: 2 },
  hot_money_ice_rev_3d_gain: { id: 'hot_money_ice_rev_3d_gain', name: '逆周期情绪游资-前3日涨幅最大', desc: ICE_REV_DESC(3), keyBlockDays: 3, iceMode: true, iceReverse: true, costLinePct: 2 },
  hot_money_ice_rev_4d_gain: { id: 'hot_money_ice_rev_4d_gain', name: '逆周期情绪游资-前4日涨幅最大', desc: ICE_REV_DESC(4), keyBlockDays: 4, iceMode: true, iceReverse: true, costLinePct: 2 },
  hot_money_ice_rev_5d_gain: { id: 'hot_money_ice_rev_5d_gain', name: '逆周期情绪游资-前5日涨幅最大', desc: ICE_REV_DESC(5), keyBlockDays: 5, iceMode: true, iceReverse: true, costLinePct: 2 },
};
