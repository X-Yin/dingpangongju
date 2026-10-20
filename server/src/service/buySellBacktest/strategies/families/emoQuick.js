const { EMO_BREAK_DESC, EMO_GATE_DESC, EMO_QUICK_DESC, EMO_QUICK_HALF_DESC, EMO_QUICK_REPORTS_DESC } = require('../descs');

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
  // 10n 科技情绪-快进快出系列（2026-10-20 用户新增，n = 1/2/3 → 分时情绪阈值 10/20/30）：
  // 选股与卖点与 highest_3d_gain_emoquick 完全一致，唯一区别在买点时机——不走大盘买点诊断，
  // 改为「盘中分时科技情绪突破 10×n」的首个时点按该桶分时价买入；emoBreak = 分时情绪买点阈值，
  // 引擎（rangeBacktest / rangeBacktestMulti）据此用突破判定替换买点诊断触发，其余机制全部复用
  highest_3d_gain_emoquick_emo10: { id: 'highest_3d_gain_emoquick_emo10', name: '10×1 科技情绪-快进快出', desc: EMO_BREAK_DESC(1), emoQuickOut: true, emoBreak: 10 },
  highest_3d_gain_emoquick_emo20: { id: 'highest_3d_gain_emoquick_emo20', name: '10×2 科技情绪-快进快出', desc: EMO_BREAK_DESC(2), emoQuickOut: true, emoBreak: 20 },
  highest_3d_gain_emoquick_emo30: { id: 'highest_3d_gain_emoquick_emo30', name: '10×3 科技情绪-快进快出', desc: EMO_BREAK_DESC(3), emoQuickOut: true, emoBreak: 30 },
  // 3日涨幅最大-快进快出-科技情绪10（2026-10-20 用户新增）：与 highest_3d_gain_emoquick 完全一致（走通用买点诊断），
  // 唯一区别是买点诊断全部通过后还要求「当前分时科技情绪 ≥ 10」才可买入，否则该桶不买；
  // emoGate = 分时情绪买入门禁阈值（与 emoBreak 的「替换买点时机」不同，emoGate 是「诊断之上叠加门禁」），
  // 引擎据此在诊断 allPassed 后追加门禁判断，其余机制（快进快出标注/半仓/卖点）全部复用
  highest_3d_gain_emoquick_g10: { id: 'highest_3d_gain_emoquick_g10', name: '3日涨幅最大-快进快出-科技情绪10', desc: EMO_GATE_DESC(10), emoQuickOut: true, emoGate: 10 },
};
