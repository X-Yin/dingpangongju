const windowGainStrategies = require('./families/windowGain');
const twoBuyStrategies = require('./families/twoBuy');
const rankingStrategies = require('./families/ranking');
const emoQuickStrategies = require('./families/emoQuick');
const iceStrategies = require('./families/ice');
const leaderStrategies = require('./families/leader');
const { OPENING_BELOW_RATIO, OPENING_BELOW_RATIO_STRATEGY_IDS } = require('../constants');

const STRATEGIES = {
  ...windowGainStrategies,
  ...twoBuyStrategies,
  ...rankingStrategies,
  ...emoQuickStrategies,
  ...iceStrategies,
  ...leaderStrategies,
};


// 选股抗分歧门槛（当前仅「买入最高涨幅」启用）：买入时从策略排名最高者起依次要求「触发时点当日
// 抗分歧分数 ≥ 11」，不满足则顺延至下一只满足的股票（买入条件明细中标注顺延原因；其余策略不受此限制）。
// 历史备注：2/3/4/5/10日涨幅最大系列曾启用该门槛，已按需求移除；如需重新启用，把对应策略 id 加回
// RESILIENCE_GATE_STRATEGY_IDS（按 N 日窗口涨幅排序）或 RESILIENCE_GATE_INTRADAY_SORT_IDS（按触发时点
// 当日盘中涨幅排序，两个集合都加才按当日涨幅排序），选股与明细逻辑无需改动
const RESILIENCE_GATE_MIN = 11;
const RESILIENCE_GATE_STRATEGY_IDS = new Set(['highest_gain']);
const RESILIENCE_GATE_INTRADAY_SORT_IDS = new Set(['highest_gain']);
const RESILIENCE_GATE_DESC = '选股门槛：按策略排名从最高者起依次要求「触发时点当日抗分歧分数 ≥ 11」，不满足则顺延至下一只满足的股票（全部候选均不满足则当日不买入），买入条件明细中标注是否因前序股票分数<11 而顺延';
for (const s of Object.values(STRATEGIES)) {
  if (!RESILIENCE_GATE_STRATEGY_IDS.has(s.id)) continue;
  s.desc = `${s.desc}；${RESILIENCE_GATE_DESC}`;
}

// 个股顺/逆周期过滤（2026-10-06 新增，2026-10-06 扩展至全策略）：适用范围 = 除「情绪游资类（iceMode）」
// 外的全部策略（极致胜率 / 反向抱团龙头同属情绪游资类）。
// 规则：候选按排名依次判断个股与创业板指最近 20 个已完结交易日的日收益率相关系数，corr > 0（正相关）
// = 顺周期可买，corr <= 0（逆周期）剔除并顺延排名下一只；数据不足不拦截。下列 desc 文案自动追加到所有适用策略
const CYC_FILTER_DESC = '顺周期过滤：候选按排名依次判断与创业板指最近 20 个已完结交易日的日收益率相关系数，相关系数 > 0（正相关，顺周期）才可买入，≤ 0（逆周期）则顺延至排名下一只（数据不足不拦截）';
const isCycleFilterStrategy = (s) => !!s && s.iceMode !== true && s.keyBlockDays == null && s.extremeWinMode !== true && s.reverseLeaderMode !== true && s.nBoardMode !== true && s.volumeShareMode !== true && s.fusedEmoWinMode !== true;
for (const s of Object.values(STRATEGIES)) {
  if (isCycleFilterStrategy(s)) s.desc = `${s.desc}；${CYC_FILTER_DESC}`;
}

// 全局最低抗分歧门槛（所有策略通用）：买点触发时刻个股抗分歧分数 < 9 → 顺延至下一只满足的股票；
// 全部候选均不满足则当日不买入。门槛策略（RESILIENCE_GATE_STRATEGY_IDS）在此基础上叠加 ≥ 11 的专项门槛——
// 先过 ≥ 9 的全局最低线，再过 ≥ 11 的专项线
const GLOBAL_RESILIENCE_MIN = 9;

// 买入时段门禁（所有策略通用）：仅允许 9:30 – 11:30 和 13:00 – 13:30 之间的买点触发买入，
// 13:30 之后即使满足所有买点条件也不执行买入；bucket.minute 为数字分钟，
// 如 930=09:30，1130=11:30，1300=13:00，1330=13:30，1455=14:55
// 例外：两次买入策略的第二份仓位（补买）不受此上限限制，可在触发日任意买点补入
const BUY_TIME_MAX_MINUTE = 1330;

// 快进快出半仓（2026-10-13 用户新增）：仅适用于「N日涨幅最大-快进快出」系列
// （emoQuickOut === true 且非两次买入 twoBuy）。买点触发时看该笔买入是否属于「快进快出」情形
// （emoQuickOut.quickOut：上一交易日科技情绪 3 日 EMA < -30，或上两/上一交易日科技情绪均处 (-30,-10)
// 区间且温和回升——即买入次日 10:00 强制卖出的持仓）：属于则本次只半仓买入（第一份），至少等到次日
// 买点再次触发时才把剩余半仓买入（与两次买入策略同口径：同一标的、两份各自独立买卖与收益、均按半仓折算）；
// 非快进快出情形（走通用 7 条件卖点）则首次触发即全仓买入。
const EMO_QUICK_HALF_POS_DESC = '；快进快出半仓（2026-10-13 新增）：买点触发时判定该笔买入是否属于「快进快出」情形（上一交易日科技情绪 3 日 EMA < -30，或上两/上一交易日科技情绪均处 (-30,-10) 区间且温和回升，即买入次日 10:00 强制卖出的持仓）——属于则本次仅半仓买入（第一份），至少等到次日买点再次触发时再买入剩余半仓（与两次买入策略同口径：买入同一标的、两份各自独立买卖与收益、均按半仓折算、不摊平成本），非快进快出情形（走通用 7 条件卖点）首次触发即全仓买入';
for (const s of Object.values(STRATEGIES)) {
  if (s.emoQuickOut === true && s.twoBuy !== true) s.desc = `${s.desc}${EMO_QUICK_HALF_POS_DESC}`;
}

// 盘中大跌强卖（2026-10-16 用户新增）：适用范围 = 除「情绪游资类（iceMode）」「极致胜率（extremeWinMode）」
// 「反向抱团龙头（reverseLeaderMode）」外的全部策略（两次买入系列已内置同口径卖点，
// 仅补字段不重复追加 desc）。规则：持仓当日跌幅（较昨收涨跌幅）≤ EMO_QUICK_CRASH_PCT（-7%）时无条件卖出——
// 先于各策略原有卖点判定（generalSell 引擎桶级预检 / 重点板块引擎卖出预检）；
// 2026-10-19 叠加竞价低开自救窗口：竞价首分钟即 ≤ -7% 时不在 9:30 直接卖出，改为等自救拉升结束的
// 首个「回落且仍 ≤ -7%」的分钟再卖（10:00 前未回落且 10:00 仍 ≤ -7% 则按 10:00 时点价兜底）
const CRASH_SELL_DESC = '；盘中大跌强卖（2026-10-16 新增）：持仓当日跌幅（较昨收涨跌幅）≤ -7% 时无条件卖出（先于其他卖点判定；2026-10-19 起叠加竞价低开自救窗口——竞价首分钟即跌破 -7% 时改为等自救拉升结束的首个回落分钟再卖）';
const isCrashSellStrategy = (s) => !!s && s.iceMode !== true && s.extremeWinMode !== true && s.reverseLeaderMode !== true && s.nBoardMode !== true && s.volumeShareMode !== true && s.fusedEmoWinMode !== true;
for (const s of Object.values(STRATEGIES)) {
  if (!isCrashSellStrategy(s)) continue;
  s.crashSell = true;
  if (s.emoQuickOut !== true) s.desc = `${s.desc}${CRASH_SELL_DESC}`;
}

// 检查4「开盘后自选科技股低于开盘价」按比例收紧（2026-10-19 用户定，取代原「创业板指斜率负收紧为 15」）：
// 仅 OPENING_BELOW_RATIO_STRATEGY_IDS 内的 25 个策略（快进快出 7 + 纯 N 日涨幅最大 7 + 两次买入 7 + 两次买入不同板块 4）生效，
// 阈值 = ceil(参与计数的科技股数 × 25%)（向上取整，如 90 只科技股 → 23 只）；其余策略保持固定 30 只
const OPENING_BELOW_RATIO_DESC = `；开盘门禁按比例收紧（2026-10-19 新增）：买点检查4「开盘后自选科技股低于开盘价」阈值由固定 30 只改为「参与计数的科技股数的 ${OPENING_BELOW_RATIO * 100}% 向上取整」（如 90 只科技股 → 23 只），非科技股不参与计数`;
for (const s of Object.values(STRATEGIES)) {
  if (OPENING_BELOW_RATIO_STRATEGY_IDS.has(s.id)) s.desc = `${s.desc}${OPENING_BELOW_RATIO_DESC}`;
}

module.exports = {
  BUY_TIME_MAX_MINUTE,
  CYC_FILTER_DESC,
  GLOBAL_RESILIENCE_MIN,
  RESILIENCE_GATE_DESC,
  RESILIENCE_GATE_INTRADAY_SORT_IDS,
  RESILIENCE_GATE_MIN,
  RESILIENCE_GATE_STRATEGY_IDS,
  STRATEGIES,
  CRASH_SELL_DESC,
  isCrashSellStrategy,
  isCycleFilterStrategy,
};
