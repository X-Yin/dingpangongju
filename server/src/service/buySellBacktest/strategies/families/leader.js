const { EXTREME_WIN_DESC, REVERSE_LEADER_DESC, N_BOARD_ATTACK_DESC, VOLUME_SHARE_DESC } = require('../descs');

// 情绪游资系列（2026-10-17 用户要求：已删除「情绪游资-龙头战法」「情绪龙头+科技进攻」「科技进攻 + 情绪龙头」三个策略）：
module.exports = {
  // 情绪游资-极致胜率（2026-10-16 用户新增）：在「过去 10 个交易日走出过四连板及以上」的强势股中，
  // 寻找「昨日表现很差（差劲分高）＋今日分时表现很强（强度分高）」的个股做分歧转一致的低吸反转博弈。
  // extremeWinMode: true → 独立引擎 runExtremeWinBacktest（不复用重点板块引擎）；
  //   买点在今日盘中逐桶实时判定；2026-10-17 起为双腿结构（顺周期腿 = 极致胜率原逻辑、
  //   逆周期腿 = 「情绪游资-反向抱团龙头」逻辑），账户拆两份各半仓、择时互补；
  //   记录以 cycle 字段标注顺周期 / 逆周期
  hot_money_extreme_win: {
    id: 'hot_money_extreme_win',
    name: '情绪游资-极致胜率',
    desc: EXTREME_WIN_DESC,
    extremeWinMode: true,
  },
  // 情绪游资-反向抱团龙头（2026-10-17 用户新增）：独立策略——
  //   大盘（上证 3 日线斜率）连续走弱第 3 天起，逆势低吸「抱团龙头」：
  //   候选池 = 过去 20 个交易日内出现过连板（连板数 ≥ 2）的个股 ∩ 过去 20 个交易日内滑动「连续 10 个交易日」
  //            子窗口区间最大涨幅 ≥ 60%；且一律剔除创业板（30/301）与科创板（688）；
  //   买点 = 上证 3 日线斜率连续为负第 3 天（转负当日为第 1 天）起，在「当日上证跌幅 ≥ 0.5%」的交易日里，
  //          逐桶实时计算候选股强度分；盘中强度分第 2 次 > 50（逐股独立累计、同一日同一只只计一次）的那一刻买入，
  //          若该刻已涨停则不买、顺延等下一个符合条件的交易日；计数在斜率由负转正后清零；
  //   卖点 = 沿用龙头战法卖点（去掉盘中 1 分钟跳水），并新增「上证 3 日线斜率盘中由负转正」卖出（任一先触发即卖）；
  //   全仓单持仓（权重 1）。
  // reverseLeaderMode: true → 独立引擎 runReverseLeaderBacktest
  hot_money_reverse_leader: {
    id: 'hot_money_reverse_leader',
    name: '情绪游资-反向抱团龙头',
    desc: REVERSE_LEADER_DESC,
    reverseLeaderMode: true,
  },
  // 情绪游资-n板打板（2026-10-18 用户新增，n = 2 / 3 两个独立策略）：
  //   买点门禁 = 上证指数 3 日线斜率分时为正；若前一交易日收盘口径斜率已为正，则当日至少等到 9:40 才买；
  //   选股 = 上一交易日（T-1）的 n-1 板个股（n=2→首板、n=3→二板），剔除创业板（30/301）与科创板（688），
  //   当日盘中分时涨幅（较昨收）首次冲高至 +8% 的那一分钟按该分钟分时价买入，先冲到 8% 的先买；
  //   卖点 = 完全沿用「情绪游资-极致胜率」顺周期腿；买入仅限早盘 9:30–11:30；半仓单持仓（权重 0.5）。
  // nBoardMode: true → 独立引擎 runNBoardBacktest
  hot_money_2board_attack: {
    id: 'hot_money_2board_attack',
    name: '情绪游资-2板打板',
    desc: N_BOARD_ATTACK_DESC(2),
    nBoardMode: true,
    nBoardN: 2,
  },
  hot_money_3board_attack: {
    id: 'hot_money_3board_attack',
    name: '情绪游资-3板打板',
    desc: N_BOARD_ATTACK_DESC(3),
    nBoardMode: true,
    nBoardN: 3,
  },
  // 情绪游资-成交量占比（2026-10-19 用户新增，N = 2 / 3 / 5 三个独立策略）：
  //   选股 = 「成交量占比 3 日线斜率（截止 T-1）为正且最陡的前 3 板块（剔除半导体/液冷/光通信/存储芯片/pcb）」
  //          成分股 ∩ 最近 5 个交易日连板个股；
  //   买点 = 9:40 起在 9:40–11:30 逐桶重试，候选按 N 日涨幅最大排名，涨停（一字板）/分时涨幅 ≤ -5%/抗分歧 < 9 顺延；
  //   卖点 = 所属前 3 板块中任一板块成交量占比 3 日线斜率（截止 T-1）转负 → 次一交易日开盘卖出；
  //   半仓单持仓（权重 0.5）。volumeShareMode: true → 独立引擎 runVolumeShareBacktest
  hot_money_volume_share_2d: {
    id: 'hot_money_volume_share_2d',
    name: '情绪游资-成交量占比-2日涨幅最大',
    desc: VOLUME_SHARE_DESC(2),
    volumeShareMode: true,
    volumeShareDays: 2,
  },
  hot_money_volume_share_3d: {
    id: 'hot_money_volume_share_3d',
    name: '情绪游资-成交量占比-3日涨幅最大',
    desc: VOLUME_SHARE_DESC(3),
    volumeShareMode: true,
    volumeShareDays: 3,
  },
  hot_money_volume_share_5d: {
    id: 'hot_money_volume_share_5d',
    name: '情绪游资-成交量占比-5日涨幅最大',
    desc: VOLUME_SHARE_DESC(5),
    volumeShareMode: true,
    volumeShareDays: 5,
  },
};
