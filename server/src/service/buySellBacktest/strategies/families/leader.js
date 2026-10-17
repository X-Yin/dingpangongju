const { LEADER_DESC, LEADER_TECH_DESC, LEADER_TECH_REV_DESC, EXTREME_WIN_DESC, PRECISE_TIMING_DESC } = require('../descs');

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
  // 「3日涨幅最大&三日情绪-60快进快出」的独立买点，两者共用一个单持仓账户（①情绪游资半仓、②快进快出全仓）。
  // leaderMode + leaderTechCombo → 仍走独立引擎 runLeaderBacktest，但走组合分支：
  //   出手优先级：同一桶两套买点同时触发先买情绪游资；非同时触发则谁先触发买谁；
  //   卖点各用各的（情绪游资仓位走龙头战法 10 条卖点；快进快出仓位走快进快出卖点）；
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
  // 情绪游资-极致胜率（2026-10-16 用户新增）：在「过去 20 个交易日走出过三连板及以上」的强势股中，
  // 寻找「昨日表现很差（差劲分高）＋今日分时表现很强（强度分高）」的个股做分歧转一致的低吸反转博弈。
  // extremeWinMode: true → 独立引擎 runExtremeWinBacktest（不复用重点板块引擎，也不走龙头战法的斜率买点）；
  //   买点在今日盘中逐桶实时判定，卖点完全沿用「情绪游资-龙头战法」的 10 条卖点；全仓
  hot_money_extreme_win: {
    id: 'hot_money_extreme_win',
    name: '情绪游资-极致胜率',
    desc: EXTREME_WIN_DESC,
    extremeWinMode: true,
  },
  // 情绪游资-精准择时（2026-10-16 用户新增）：账户拆两份各 5 成——仓位 A 完全按「情绪游资-龙头战法」买卖，
  // 仓位 B 在「上证 3 日线斜率前一交易日收盘口径由负转正」时当日上午打板（前两个交易日各自涨停数前二板块的全部成分股取并集，
  // 每个交易日各自先剔除「其他/并购重组」板块并在剩余板块中顺延取前二；两日合并去重后，
  // 最先涨到 +8% 者；过去 20 个交易日区间涨幅 (最高收盘价−最低收盘价)÷最低收盘价 < 40%，一字板顺延），
  // 开盘后前 5 分钟（9:30–9:34）不买、最早 9:35 出手，且触达 +8% 时点复核上证 3 日线实时斜率须为正、否则当天不买（不顺延），
  // 仅上午交易），卖点沿用龙头战法 10 条。
  // leaderMode: true + preciseTiming: true → 独立引擎 runPreciseTimingBacktest（内部复用 runLeaderBacktest 跑仓位 A）
  hot_money_precise_timing: {
    id: 'hot_money_precise_timing',
    name: '情绪游资-精准择时',
    desc: PRECISE_TIMING_DESC,
    leaderMode: true,
    preciseTiming: true,
  },
};
