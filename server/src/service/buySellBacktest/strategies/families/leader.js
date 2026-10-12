const { LEADER_DESC, LEADER_TECH_DESC, LEADER_TECH_REV_DESC } = require('../descs');

// 情绪游资-龙头战法（2026-10-11 用户新增，2026-10-11 二次改版合并为单一「板块口径」策略；
// leaderMode: true → 独立引擎 runLeaderBacktest，不复用重点板块引擎）：
// 选股 = 过去 10 个交易日掀起涨停潮（涨停数 ≥ 20）的板块（剔除 芯片/通信/算力/其他，仅主板）中，
//        买点触发时选「板块内最优个股自爆发以来涨幅最高」的板块，再买该板块内「自板块爆发日以来涨幅最大」的那只；
//        涨幅第 1 已涨停则买第 2，前两名均涨停则顺延次日 9:30 买第 2 那只；
// 买点 = 上证指数 3 日线斜率盘中由负转正（顺延买点要求次日 9:30 斜率仍为正）；
// 卖点 = 跌破成本线 -5% 且连续 5 分钟 ∪ 跌停 ∪ 高位放量大阴线 ∪ 持仓 3 日未拉开 10 个点 ∪ 竞价低开 -5%；全仓
module.exports = {
  hot_money_leader: {
    id: 'hot_money_leader',
    name: '情绪游资-龙头战法',
    desc: LEADER_DESC,
    leaderMode: true,
  },
  // 情绪龙头+科技进攻（2026-10-12 用户新增）：在「情绪游资-龙头战法」基础上叠加
  // 「3日涨幅最大&三日情绪-60快进快出」的独立买点，两者共用一个全仓单持仓账户。
  // leaderMode + leaderTechCombo → 仍走独立引擎 runLeaderBacktest，但走组合分支：
  //   出手优先级：同一桶两套买点同时触发先买情绪游资；非同时触发则谁先触发买谁；
  //   卖点各用各的（情绪游资仓位走龙头战法 6 条卖点；快进快出仓位走快进快出卖点）；
  //   当日卖出仅禁止同路再买（快进快出强卖当日仅快进快出那路不再买，反之亦然）
  hot_money_leader_tech_emoquick: {
    id: 'hot_money_leader_tech_emoquick',
    name: '情绪龙头+科技进攻',
    desc: LEADER_TECH_DESC,
    leaderMode: true,
    leaderTechCombo: true,
  },
  // 科技进攻 + 情绪龙头（2026-10-12 用户新增）：与「情绪龙头+科技进攻」完全对称，仅优先级反转。
  // techFirst: true → 同一桶两套买点同时触发先买科技进攻（②快进快出）；非同时触发谁先触发买谁；
  //   当前持仓为①情绪游资龙头（隔夜）时，②科技进攻买点盘中触发 → 立即卖出龙头、改买②选中的股票。
  tech_emoquick_hot_money_leader: {
    id: 'tech_emoquick_hot_money_leader',
    name: '科技进攻 + 情绪龙头',
    desc: LEADER_TECH_REV_DESC,
    leaderMode: true,
    leaderTechCombo: true,
    techFirst: true,
  },
};
