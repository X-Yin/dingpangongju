const { EXTREME_WIN_DESC, REVERSE_LEADER_DESC, N_BOARD_ATTACK_DESC, VOLUME_SHARE_DESC, FUSED_EMO_WIN_DESC, EMOTION_BURST_DRIFT_DESC, EMOTION_BURST_FOLLOW_DESC, FIRST_BOARD_WASH_DESC, VOLUME_WASHOUT_SECOND_BOARD_DESC, WASH_FUSION_DESC } = require('../descs');

// 情绪游资系列（2026-10-17 用户要求：已删除「情绪游资-龙头战法」「情绪龙头+科技进攻」「科技进攻 + 情绪龙头」三个策略）：
module.exports = {
  // 情绪游资-极致胜率（2026-10-16 用户新增）：在「过去 10 个交易日走出过连板准入（流通市值 > 100 亿元者出现过两连板 + 含该连板日 5 日累计涨幅 > 50%，其余四连板及以上）」的强势股中，
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
  // 科技进攻-情绪游资极致胜率（2026-10-19 用户新增）：把「3日涨幅最大&三日情绪-30快进快出」（A 风格）
  //   与「情绪游资-极致胜率」（B 风格，双腿）融合为一个账户——账户被单一风格独占（仍 2 个半仓槽）：
  //   空仓时谁先触发买谁（同一时间桶内两者均触发 → 快进快出优先）；某风格开始建仓后另一风格完全禁止
  //  （即使其买点触发也不买、不使用剩余半仓），该风格全部平仓回到空仓后另一风格才解禁。
  // fusedEmoWinMode: true → 独立引擎 runFusedEmoWinBacktest
  sci_attack_emo_win: {
    id: 'sci_attack_emo_win',
    name: '科技进攻-情绪游资极致胜率',
    desc: FUSED_EMO_WIN_DESC,
    fusedEmoWinMode: true,
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
  // 连板题材-情绪瞬爆-惯性漂移-龙头（2026-10-30 用户新增；2026-10-31 用户重构，仅回测、线上不动）：独立引擎——
  //   买点前置 = 前一交易日「科技情绪指数」收盘 > 10；
  //   选股 = 前一交易日涨停家数最多的题材（须 > 5 家；剔除并购重组/三季报/其他与题材黑名单），
  //          候选 = 该题材前一交易日的首板股（连板数 = 1，即次日打二板），只买主板；
  //          新增限制 = 遍历题材近 20 交易日出现过的全部涨停股（已回落为首板也计入），
  //                     取「最多 10 日」最大涨幅窗口的最大值 ≤ 70%，除非该题材前一交易日涨停家数 > 20；
  //   买点 = 次日 9:30–14:30 内，候选股分时涨幅首次达到 +9% 且未涨停者买入（谁先达到谁先买，同分钟取涨幅更大者）；
  //   卖点 = 完全沿用「情绪游资-极致胜率」顺周期腿；半仓单持仓（权重 0.5）。
  // emotionBurstDriftMode: true → 独立引擎 runEmotionBurstDriftBacktest
  emotion_burst_drift_leader: {
    id: 'emotion_burst_drift_leader',
    name: '连板题材-情绪瞬爆-惯性漂移-龙头',
    desc: EMOTION_BURST_DRIFT_DESC,
    emotionBurstDriftMode: true,
  },
  // 连板题材-情绪瞬爆-惯性漂移-补涨（2026-10-31 用户新增）：独立引擎——
  //   触发 = 复用龙头引擎，记录其真实买入（龙头买点）当日 D 与命中题材 B；
  //   窗口 = D 之后 3 个交易日内（不含 D）；
  //   选股 = 题材 B 在 D 当日爆发的首板股（连板数 = 1），只买主板；
  //   买点 = 窗口内首个分时涨幅达到 +9% 者买入（谁先达到谁先买）；
  //   卖点 = 与龙头模式一致 + 任一交易日收盘未涨停即尾盘卖出；半仓单持仓（权重 0.5）。
  // emotionBurstFollowMode: true → 独立引擎 runEmotionBurstFollowBacktest
  emotion_burst_follow_leader: {
    id: 'emotion_burst_follow_leader',
    name: '连板题材-情绪瞬爆-惯性漂移-补涨',
    desc: EMOTION_BURST_FOLLOW_DESC,
    emotionBurstFollowMode: true,
  },
  // 首板洗盘-起爆拉升（2026-10-31 用户新增，仅回测、线上实盘无此模式）：独立引擎——
  //   选股 = 前置洗盘形态判定（2026-11-01 用户要求，参照 股票数据材料/washout.js 的 isPotentialBullWashout；
  //   仅用买点日前一交易日及更早的日K，避免未来函数）：
  //     首板（或首板+二板）涨停日 → 首板日（含）后最多 2 个交易日内出现放量峰值（≥ 首板日前 20 日均量 2 倍）
  //     → 之后 5~12 个交易日缩量洗盘（洗盘最大量 ≤ 峰值量 95%、最小量 ≤ 峰值量 60%、洗盘期内不得出现涨停、
  //       所有交易日单日涨跌幅须在 ±5% 之内、唯一例外：跌幅介于 -5%~-6%（不含两端）最多 1 天、跌幅超 -6% 一律剔除、
  //       洗盘最低价不跌破首板涨停日开盘价（2026-11-01 用户要求））
  //     → 洗盘期最高价 ≤ 平台高点 1.03、最高收盘 ≤ 1.02，区间幅度 8%~35%，买点触发价 ≥ 平台高点 0.80；
  //     15 日内出现 ≥3 板一律剔除；候选池另剔除创业板/科创板、代码黑名单、题材黑名单，且流通市值必须 ≤ 100 亿元（按买入日股价折算）；
  //     买点日前 20 个交易日内最大三日滑动窗口涨幅须 ≤ 20%（2026-11-01 用户要求）；
  //   买点（两条路径，2026-11-01 用户要求）：① 竞价高开 ≥ 5% → 9:30 按竞价开盘价直接买入（开盘即涨停买不进）；
  //        ② 竞价高开 < 5%（含低开）→ 9:30–9:40 分时涨幅首次 +8% 即买入（9:40 后不买；区间内最多 1 次回落；
  //        只有 9:30 开盘即涨停买不进，开盘未涨停而盘中 9:31 涨停仍可买入）；
  //   卖点：共五条（2026-11-01 用户要求）——① 跌破 5 日线（MA5 取当日之前 5 个交易日收盘均值；
  //        收益率未拉开 +20% 时盘中分时即卖，已拉开 +20% 后只在收盘判定）；
  //        ② 跌破成本线 -3%（须连续 5 分钟都跌破）/ -5%（立即卖）；③ 盘中跌停（分时跌幅 ≤ -9%）立即卖；
  //        ④ 买入当日收盘涨停、次一交易日收盘未涨停 → 次一交易日收盘卖出（次日涨停放量卖点已取消）；
  //        ⑤ 买入后的次一交易日竞价低开（开盘涨幅 < 0，不看买入当日是否涨停）→ 次一交易日 9:30 竞价卖出（早于 ④ 收盘判定）；
  //   仓位：账户拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票、各自独立买卖。
  // firstBoardWashMode: true → 独立引擎 runFirstBoardWashBacktest
  first_board_wash_relaunch: {
    id: 'first_board_wash_relaunch',
    name: '首板洗盘-起爆拉升',
    desc: FIRST_BOARD_WASH_DESC,
    firstBoardWashMode: true,
  },
  // 放量洗盘-二板起爆（2026-11-01 用户新增）：T-1 必须是首板，其之前须出现「拉升放量 1~3 日 → 震荡缩量 2~12 日」
  //   洗盘形态（参照 股票数据材料/只放量无涨停-打二板/washout.js），并叠加震荡期单日涨跌幅 ±5%
  //   （-5%~-6% 最多 1 天、超 -6% 剔除）与「震荡最低不破首次爆量开盘价 -5%」两道过滤；
  //   15 日内 ≥3 板、20 日内三日窗口涨幅 > 20%、流通市值 > 100 亿者剔除；
  //   买点 = 竞价必须高开，9:30–14:30 按 1 分钟回溯分时涨幅首次 +8% 买入；
  //   卖点五条与「首板洗盘-起爆拉升」同口径；账户拆两份、每份半仓、最多同时持有 2 只
  // volumeWashoutMode: true → 独立引擎 runVolumeWashoutSecondBoardBacktest
  volume_washout_second_board: {
    id: 'volume_washout_second_board',
    name: '放量洗盘-二板起爆',
    desc: VOLUME_WASHOUT_SECOND_BOARD_DESC,
    volumeWashoutMode: true,
  },
  // 情绪游资-极致赔率（2026-11-01 用户新增，仅回测）：把「首板洗盘-起爆拉升」与「放量洗盘-二板起爆」
  //   融合进同一个账户——候选池取两者并集（同一只股票同时命中只保留一份、按首板洗盘口径建仓）；
  //   两套买点共用账户，谁先命中买谁（跨候选取最早触发分钟、同分钟取涨幅更大者，同分钟同涨幅时首板洗盘优先）；
  //   卖点按每份持仓的命中来源执行各自策略的卖出体系（首板洗盘五条 / 放量洗盘七条）；
  //   账户拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票
  // washFusionMode: true → 独立引擎 runWashFusionBacktest
  wash_fusion_extreme_odds: {
    id: 'wash_fusion_extreme_odds',
    name: '情绪游资-极致赔率',
    desc: WASH_FUSION_DESC,
    washFusionMode: true,
  },
};
