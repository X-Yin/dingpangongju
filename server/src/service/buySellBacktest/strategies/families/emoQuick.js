const { EMO_QUICK_DESC, EMO_QUICK_HALF_DESC, EMO_QUICK_REPORTS_DESC } = require('../descs');

module.exports = {
  // 情绪快进快出系列（2026-10-03 用户新增）：买点触发时均可正常买入；上一交易日科技情绪 3 日 EMA < -30
  // （2026-10-19 用户改：-60 → -30）的日子买入 → 该笔持仓次日 10:00 强制卖出（不走通用卖点），否则走通用卖点；
  // 2026-10-05 叠加：持仓次日盘中跌破成本线 -2% 先到先卖止损（口径与通用条件7一致，见每日预桶快进快出卖点）
  // 2026-10-09 叠加：10:00 强卖豁免（buildQuickOutExemptInfo）——次日强势判断命中任一不强卖、转由通用卖点接管
  highest_2d_gain_emoquick: { id: 'highest_2d_gain_emoquick', name: '2日涨幅最大&三日情绪-30快进快出', desc: EMO_QUICK_DESC(2), emoQuickOut: true },
  highest_3d_gain_emoquick: { id: 'highest_3d_gain_emoquick', name: '3日涨幅最大&三日情绪-30快进快出', desc: EMO_QUICK_DESC(3), emoQuickOut: true },
  highest_4d_gain_emoquick: { id: 'highest_4d_gain_emoquick', name: '4日涨幅最大&三日情绪-30快进快出', desc: EMO_QUICK_DESC(4), emoQuickOut: true },
  highest_5d_gain_emoquick: { id: 'highest_5d_gain_emoquick', name: '5日涨幅最大&三日情绪-30快进快出', desc: EMO_QUICK_DESC(5), emoQuickOut: true },
  // 快进快出 × N.5 日窗口（2026-10-08 用户新增；选股窗口额外计入更前一个交易日下半日涨幅）
  highest_2d5_gain_emoquick: { id: 'highest_2d5_gain_emoquick', name: '2.5日涨幅最大&三日情绪-30快进快出', desc: EMO_QUICK_HALF_DESC(2), emoQuickOut: true, halfDayAfternoon: true },
  highest_3d5_gain_emoquick: { id: 'highest_3d5_gain_emoquick', name: '3.5日涨幅最大&三日情绪-30快进快出', desc: EMO_QUICK_HALF_DESC(3), emoQuickOut: true, halfDayAfternoon: true },
  // 快进快出 × 研报覆盖双门策略：仅当快进快出的触发条件是「上一交易日 3 日 EMA < -30」时，
  // 选股口径从「3日涨幅最大」改为「最近 3 日研报覆盖数前五（含并列）→ 组内 3 日涨幅最大」；
  // 温和回升路径 / 非快进快出路径仍走原 3 日涨幅最大；卖出行为与 highest_3d_gain_emoquick 完全一致
  highest_3d_reports_top5_gain_emoquick: { id: 'highest_3d_reports_top5_gain_emoquick', name: '3日涨幅最大&三日情绪-30快进快出&研报覆盖', desc: EMO_QUICK_REPORTS_DESC, emoQuickOut: true },
};
