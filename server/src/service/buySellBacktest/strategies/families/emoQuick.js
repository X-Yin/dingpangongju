const { EMO_QUICK_DESC, EMO_QUICK_HALF_DESC, EMO_QUICK_REPORTS_DESC, TECH_TOP3_BLOCK_DESC, TECH_TOP3_HALF_DESC } = require('../descs');

module.exports = {
  // 情绪快进快出系列（2026-10-03 用户新增）：买点触发时均可正常买入；上一交易日科技情绪 3 日 EMA < -60
  // 的日子买入 → 该笔持仓次日 10:00 强制卖出（不走通用卖点），否则走通用卖点；
  // 2026-10-05 叠加：持仓次日盘中跌破成本线 -2% 先到先卖止损（口径与通用条件7一致，见每日预桶快进快出卖点）
  // 2026-10-09 叠加：10:00 强卖豁免（buildQuickOutExemptInfo）——次日强势判断命中任一不强卖、转由通用卖点接管
  highest_2d_gain_emoquick: { id: 'highest_2d_gain_emoquick', name: '2日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(2), emoQuickOut: true },
  highest_3d_gain_emoquick: { id: 'highest_3d_gain_emoquick', name: '3日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(3), emoQuickOut: true },
  highest_4d_gain_emoquick: { id: 'highest_4d_gain_emoquick', name: '4日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(4), emoQuickOut: true },
  highest_5d_gain_emoquick: { id: 'highest_5d_gain_emoquick', name: '5日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(5), emoQuickOut: true },
  // 快进快出 × N.5 日窗口（2026-10-08 用户新增；选股窗口额外计入更前一个交易日下半日涨幅）
  highest_2d5_gain_emoquick: { id: 'highest_2d5_gain_emoquick', name: '2.5日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_HALF_DESC(2), emoQuickOut: true, halfDayAfternoon: true },
  highest_3d5_gain_emoquick: { id: 'highest_3d5_gain_emoquick', name: '3.5日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_HALF_DESC(3), emoQuickOut: true, halfDayAfternoon: true },
  // 快进快出 × 研报覆盖双门策略：仅当快进快出的触发条件是「上一交易日 3 日 EMA < -60」时，
  // 选股口径从「3日涨幅最大」改为「最近 3 日研报覆盖数前五（含并列）→ 组内 3 日涨幅最大」；
  // 温和回升路径 / 非快进快出路径仍走原 3 日涨幅最大；卖出行为与 highest_3d_gain_emoquick 完全一致
  highest_3d_reports_top5_gain_emoquick: { id: 'highest_3d_reports_top5_gain_emoquick', name: '3日涨幅最大&三日情绪-60快进快出&研报覆盖', desc: EMO_QUICK_REPORTS_DESC, emoQuickOut: true },

  // 科技板块前三 × N日涨幅最大 × 快进快出系列（tech_block_top3_{N}d_gain_emoquick，2026-10-06 用户新增）：
  // 与 highest_{N}d_gain_emoquick 几乎完全一样（快进快出触发条件与卖点行为不变），唯一区别在选股策略——
  // 买点触发时先做板块效应筛选：当日 tag=进攻 的重点板块按板块盘中涨幅取前三，成分股与全量自选科技股取交集，
  // 再在交集内选 N 日涨幅最大的一只（板块盘中涨幅直接取回放桶 blockRanking.all，无需预拉成分股日K）
  tech_block_top3_2d_gain_emoquick: { id: 'tech_block_top3_2d_gain_emoquick', name: '科技板块前三&2日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(2), emoQuickOut: true },
  tech_block_top3_3d_gain_emoquick: { id: 'tech_block_top3_3d_gain_emoquick', name: '科技板块前三&3日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(3), emoQuickOut: true },
  tech_block_top3_4d_gain_emoquick: { id: 'tech_block_top3_4d_gain_emoquick', name: '科技板块前三&4日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(4), emoQuickOut: true },
  tech_block_top3_5d_gain_emoquick: { id: 'tech_block_top3_5d_gain_emoquick', name: '科技板块前三&5日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(5), emoQuickOut: true },
  // 科技板块前三 × N.5 日窗口（2026-10-08 用户新增；交集内选股窗口额外计入更前一个交易日下半日涨幅）
  tech_block_top3_2d5_gain_emoquick: { id: 'tech_block_top3_2d5_gain_emoquick', name: '科技板块前三&2.5日涨幅最大&快进快出', desc: TECH_TOP3_HALF_DESC(2), emoQuickOut: true, halfDayAfternoon: true },
  tech_block_top3_3d5_gain_emoquick: { id: 'tech_block_top3_3d5_gain_emoquick', name: '科技板块前三&3.5日涨幅最大&快进快出', desc: TECH_TOP3_HALF_DESC(3), emoQuickOut: true, halfDayAfternoon: true },
};
