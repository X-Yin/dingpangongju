const windowGainStrategies = require('./families/windowGain');
const twoBuyStrategies = require('./families/twoBuy');
const rankingStrategies = require('./families/ranking');
const emoSwitchStrategies = require('./families/emoSwitch');
const emoQuickStrategies = require('./families/emoQuick');
const keyBlockStrategies = require('./families/keyBlock');
const iceStrategies = require('./families/ice');
const lianbanGainStrategies = require('./families/lianbanGain');
const tailDipStrategies = require('./families/tailDip');
const { getTrainingCampDates } = require('../deps');

const STRATEGIES = {
  ...windowGainStrategies,
  ...twoBuyStrategies,
  ...rankingStrategies,
  ...emoSwitchStrategies,
  ...emoQuickStrategies,
  ...keyBlockStrategies,
  ...iceStrategies,
  ...lianbanGainStrategies,
  ...tailDipStrategies,
};


// 三日情绪冰点系列固定回测起点（与其他策略的「最近 60 个交易日」滚动窗口区别开）：
// 起点固定 2026-07-01，结束日取最新可用回放交易日；早于回放数据覆盖范围的日期自动跳过
const EMO3_BACKTEST_START_DATE = '20260701';
const isEmo3AvgStrategy = (strategyId) => STRATEGIES[strategyId]?.emoAvgBuy === true;
// 三日情绪冰点系列默认日期范围：起点固定 2026-07-01，结束日取最新可用回放交易日
// （与前端 BacktestDrawer 用同一份 /training_camp/dates 列表取最大值的口径一致，保证缓存命中）
const getEmo3DefaultRange = () => {
  const sorted = [...getTrainingCampDates()].sort();
  if (sorted.length === 0) return null;
  return { startDate: EMO3_BACKTEST_START_DATE, endDate: sorted[sorted.length - 1] };
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
// 「三日情绪冰点类（emoAvgBuy）」「尾盘抄底类（tailDip）」「重点板块类（keyBlockDays）」外的全部策略。
// 规则：候选按排名依次判断个股与创业板指最近 20 个已完结交易日的日收益率相关系数，corr > 0（正相关）
// = 顺周期可买，corr <= 0（逆周期）剔除并顺延排名下一只；数据不足不拦截。下列 desc 文案自动追加到所有适用策略
const CYC_FILTER_DESC = '顺周期过滤：候选按排名依次判断与创业板指最近 20 个已完结交易日的日收益率相关系数，相关系数 > 0（正相关，顺周期）才可买入，≤ 0（逆周期）则顺延至排名下一只（数据不足不拦截）';
const isCycleFilterStrategy = (s) => !!s && s.tailDip !== true && s.emoAvgBuy !== true && s.iceMode !== true && s.keyBlockDays == null && s.lianbanGainDays == null;
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

// 三日情绪冰点系列统一追加：买入环境门禁说明（触发日跟踪指数满足其一才可买，见 ensureEmo3DayGates）
const EMO3_GATE_DESC = '；买入环境门禁：触发日候选股所跟踪指数（sh688 开头跟踪科创50 sh000688，其余跟踪创业板指 sz399006）满足其一才可买入——①往前数 5 个交易日 20 日线斜率为正（MA20(触发日) − MA20(5个交易日前) > 0，含触发日收盘价，尾盘 14:57 触发按收盘已基本定型口径）；②触发日 30 日线在 60 日线下方（MA30 < MA60）。目的：剔除单边阴跌中段（20日线仍下行且 30 日线未跌破 60 日线）的无溢价环境，仅保留下跌初期/末期；全部候选股均不满足（或指数日K数据不足/获取失败）时当日不买入，买入条件明细中展示命中条件与具体数值';
for (const s of Object.values(STRATEGIES)) {
  if (s.emoAvgBuy !== true) continue;
  s.desc = `${s.desc}${EMO3_GATE_DESC}`;
}

module.exports = {
  BUY_TIME_MAX_MINUTE,
  CYC_FILTER_DESC,
  EMO3_BACKTEST_START_DATE,
  EMO3_GATE_DESC,
  GLOBAL_RESILIENCE_MIN,
  RESILIENCE_GATE_DESC,
  RESILIENCE_GATE_INTRADAY_SORT_IDS,
  RESILIENCE_GATE_MIN,
  RESILIENCE_GATE_STRATEGY_IDS,
  STRATEGIES,
  getEmo3DefaultRange,
  isCycleFilterStrategy,
  isEmo3AvgStrategy,
};
