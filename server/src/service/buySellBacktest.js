// 训练营 - 买卖点历史回测
// 依据「当下已有的买卖点诊断」对全部自选股进行多日回测：
//   买入信号 = 训练营回放买点诊断 allPassed（市场级，命中时对所有未持仓自选股买入）
//   卖出信号 = 训练营回放模拟持仓卖点诊断 isSell（个股级）
// 交易规则：首次触发买入信号即买入；持仓期间再次触发买入信号忽略，仅等卖出信号；
//          卖出后下一次买入信号可再次买入（每个股票同一时刻最多一笔持仓）。
// 诊断逻辑与前端 src/pages/trainingCamp/utils/buyPointChecks.js、sellPointChecks.js、
// src/utils/replayResilience.js 保持一致（两处同步）。
const { loadTrainingCampData, getTrainingCampDates, calcDailyMaInfo, getKlineCached } = require('./trainingCamp');
const { getSingleStockTlineDataByDate } = require('./stock');
const { calculateResilience, getLimitTypeByCode } = require('./stockDiagnose');
const { isStockInWatchlistAt } = require('./monitorStock');
const { batchParallel } = require('../utils');
const { getKeyBlockConstituents, getKeyBlockTagMap, ensureKeyBlockBars, stockWindowGain, getStockCloseOnOrBefore } = require('./keyBlockData');
const {
  SENTIMENT_STRATEGIES,
  isSentimentStrategy,
  getSentimentDefaultRange,
  runSentimentBacktest,
  loadIndexKline,
} = require('./sentimentHotMoney');
const fs = require('fs');
const path = require('path');

const SELL_CONDITION_PERSIST_MIN = 5; // 卖出条件持续满足分钟数

// 回测排除的股票（不参与任何策略的回测）
const EXCLUDED_CODES = new Set(['sh688498', 'sh688808']); // 源杰科技、联讯仪器

// 重点板块-N日最高涨幅系列统一描述（keyBlockDays: N；板块 tag = 进攻/中性/防御，在 key_blocks 页面维护；
// 个股涨幅由回测时重新拉取成分股日K现算）
const KEY_BLOCK_DESC = (n) => `唯一买卖开关 = 创业板指 3 日线斜率（MA3 − 5个交易日前的MA3；当日收盘价用盘中实时价代替，不等收盘，逐桶实时判定）的正负翻转，不需要资金、成交量、情绪等任何条件配合。进攻（自选科技股）：斜率由负转正的桶触发买入，买自选股（monitor_stocks.json 中 isTech ≠ false 的科技股，含添加时间门禁）中最近 ${n} 个交易日（含触发日）个股涨幅之和最大的一只；卖点沿用通用 7 条件卖出诊断（「跌破成本线」为 -2%，即现价 < 买入价 × 0.98）；卖点诊断卖出后若斜率仍为正，当日不再买入，等到次日开盘 10 分钟后（9:40 桶）复测斜率仍为正才再买 ${n} 日涨幅最大的科技股（复测时斜率已为负则改由「由正转负」防御信号驱动）。防御（防御+中性 tag 板块）：斜率由正转负且当前空仓的桶触发买入，买防御+中性 tag 板块成分股中 ${n} 日涨幅最大的一只；防御对应创业板情绪低迷期，按半仓买入，该笔收益率（含期末浮盈）在概览的整体收益与平均/最大回撤统计中一律按半仓（×0.5）折算；唯一卖点 = 斜率由负转正（不对成本线设置任何止损，一直持仓到转正那一刻，同桶可转手买入进攻科技股）。买入时点涨停股不可买（主板涨幅 > 9.5%、创业板/科创板涨幅 > 19% 视为涨停），顺延到 ${n} 日涨幅排名的下一只；候选全部不可买时在斜率状态不变的后续桶持续重试；买入价取触发桶分时价；同桶允许先卖后买转手。回测首个交易日之前的斜率符号取前一交易日收盘口径作为初值，首个交易日无翻转则不建仓`;

// 回测策略定义（全部为单股策略：买点命中时只选指标最优的一只买入）
const STRATEGIES = {
  highest_gain: { id: 'highest_gain', name: '买入最高涨幅', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票' },
  highest_2d_gain: { id: 'highest_2d_gain', name: '2日涨幅最大', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票（按用户定义排序依据为触发时点当日盘中涨幅，非 2 日窗口累计涨幅）' },
  highest_3d_gain: { id: 'highest_3d_gain', name: '3日涨幅最大', desc: '买点命中时只买入最近 3 个交易日涨幅最大的股票' },
  highest_4d_gain: { id: 'highest_4d_gain', name: '4日涨幅最大', desc: '买点命中时只买入最近 4 个交易日涨幅最大的股票' },
  highest_5d_gain: { id: 'highest_5d_gain', name: '5日涨幅最大', desc: '买点命中时只买入最近 5 个交易日涨幅最大的股票' },
  highest_10d_gain: { id: 'highest_10d_gain', name: '10日涨幅最大', desc: '买点命中时只买入最近 10 个交易日涨幅最大的股票' },
  highest_3d_gain_switch: { id: 'highest_3d_gain_switch', name: '3日涨幅连续切换', desc: '触发买点时，买入当前所有自选股三日涨幅最大值。若空仓则全仓买入；若已持仓且最大涨幅股票变化，则卖掉旧的并全仓买入新的；若持仓未变则不操作' },
  highest_3d_gain_twice: { id: 'highest_3d_gain_twice', name: '3日涨幅两次买入', desc: '买点命中时先买入 5 成仓位，剩余 5 成等当天收盘再买入，成本价为两次买入价格平均值（选股逻辑同 3 日涨幅最大）' },
  highest_3d_gain_quarter: { id: 'highest_3d_gain_quarter', name: '3日涨幅四份仓位', desc: '买点触发时把仓位分成四份，分别买入最近 3 个交易日涨幅排名前四的股票（各占 1/4）。任一只触发卖点即独立卖出；仅当四份全部清仓（彻底空仓）后，下一次买点才重新按四份建仓' },
  highest_3d_gain_two: { id: 'highest_3d_gain_two', name: '3日涨幅两个股票', desc: '买点触发时把仓位分成两份（各占 1/2）。两份均空仓时买入最近 3 个交易日涨幅最大和第二大的股票；仅一份空仓时只买入涨幅最大的股票。任一只触发卖点即独立卖出' },
  highest_5d_gain_2nd: { id: 'highest_5d_gain_2nd', name: '5日涨幅第二名', desc: '买点命中时只买入最近 5 个交易日涨幅第二大的股票' },
  highest_3d_gain_2nd: { id: 'highest_3d_gain_2nd', name: '3日涨幅第二名', desc: '买点命中时只买入最近 3 个交易日涨幅第二大的股票' },
  highest_3d_ma_slope: { id: 'highest_3d_ma_slope', name: '3日线斜率最陡峭', desc: '买点命中时只买入 3 日涨幅均线斜率角度最大的股票' },
  highest_5d_ma_slope: { id: 'highest_5d_ma_slope', name: '5日线斜率最陡峭', desc: '买点命中时只买入 5 日涨幅均线斜率角度最大的股票' },
  highest_3d_reports: { id: 'highest_3d_reports', name: '3日研报覆盖数最多', desc: '买点命中时只买入过去 3 个交易日研报覆盖数最多的股票（覆盖数相同取 3 日涨幅最大）' },
  highest_5d_reports: { id: 'highest_5d_reports', name: '5日研报覆盖数最多', desc: '买点命中时只买入过去 5 个交易日研报覆盖数最多的股票（覆盖数相同取 5 日涨幅最大）' },
  highest_3d_reports_2nd: { id: 'highest_3d_reports_2nd', name: '3日研报覆盖数第二名', desc: '买点命中时只买入过去 3 个交易日研报覆盖数第二多的股票（覆盖数相同取 3 日涨幅最大）' },
  highest_5d_reports_2nd: { id: 'highest_5d_reports_2nd', name: '5日研报覆盖数第二名', desc: '买点命中时只买入过去 5 个交易日研报覆盖数第二多的股票（覆盖数相同取 5 日涨幅最大）' },
  highest_3d_reports_top5_gain: { id: 'highest_3d_reports_top5_gain', name: '3日研报前五&涨幅最大', desc: '买点命中时在最近 3 个交易日研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只' },
  highest_5d_reports_top5_gain: { id: 'highest_5d_reports_top5_gain', name: '5日研报前五&涨幅最大', desc: '买点命中时在最近 5 个交易日研报覆盖数前五（含覆盖数相同的股票）中买入 5 日涨幅最大的一只' },
  highest_5d_resilience: { id: 'highest_5d_resilience', name: '5日抗分歧分数最大', desc: '买点命中时只买入最近 5 个交易日抗分歧分数汇总最大的股票' },
  highest_3d_resilience: { id: 'highest_3d_resilience', name: '3日抗分歧分数最大', desc: '买点命中时只买入最近 3 个交易日抗分歧分数汇总最大的股票' },
  resilience_weak_to_strong: { id: 'resilience_weak_to_strong', name: '抗分歧弱转强', desc: '买点命中时先筛选出当日抗分歧分数>11 的股票，再从中计算最近 4 个交易日「前两天均值」与「最近两天均值」的差值（差值越大=抗分歧由弱转强越明显），全仓买入差值最大的股票；差值相同则买入当日涨幅最大的一只' },

  // 重点板块-N日最高涨幅系列（keyBlockDays → 独立板块驱动回测 runKeyBlockBacktest：斜率双模式 + tag 板块选股，触发桶买入）
  key_block_2d_gain: { id: 'key_block_2d_gain', name: '重点板块-2日最高涨幅', desc: KEY_BLOCK_DESC(2), keyBlockDays: 2, costLinePct: 2 },
  key_block_3d_gain: { id: 'key_block_3d_gain', name: '重点板块-3日最高涨幅', desc: KEY_BLOCK_DESC(3), keyBlockDays: 3, costLinePct: 2 },
  key_block_4d_gain: { id: 'key_block_4d_gain', name: '重点板块-4日最高涨幅', desc: KEY_BLOCK_DESC(4), keyBlockDays: 4, costLinePct: 2 },
  key_block_5d_gain: { id: 'key_block_5d_gain', name: '重点板块-5日最高涨幅', desc: KEY_BLOCK_DESC(5), keyBlockDays: 5, costLinePct: 2 },

  // 尾盘抄底系列（tailDip: true → 买入信号仅取尾盘抄底命中，不走买点诊断 allPassed；卖点走专属逐分钟环比规则）
  tail_dip_1d_gain: { id: 'tail_dip_1d_gain', name: '尾盘抄底-当日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日涨幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_3d_gain: { id: 'tail_dip_3d_gain', name: '尾盘抄底-3日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入最近 3 个交易日涨幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_1d_resilience: { id: 'tail_dip_1d_resilience', name: '尾盘抄底-当日抗分歧最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日抗分歧分数最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_3d_resilience: { id: 'tail_dip_3d_resilience', name: '尾盘抄底-3日抗分歧最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入最近 3 个交易日抗分歧分数汇总最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_1d_fall: { id: 'tail_dip_1d_fall', name: '尾盘抄底-当日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日跌幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_3d_fall: { id: 'tail_dip_3d_fall', name: '尾盘抄底-3日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入最近 3 个交易日跌幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_1d_resilience_low: { id: 'tail_dip_1d_resilience_low', name: '尾盘抄底-当日抗分歧分数最低', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日抗分歧分数最低的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  // 三日情绪均值尾盘抄底系列：命中条件为「情绪页三日均值 EMA 线当日读数 < -60」（与 sentiment 页曲线同源同算法）；
  // 卖点为专属的次日竞价开盘规则（emoAvgBuy → 买入条件，nextDayOpenSell → 次日开盘一次性卖出，不走通用/尾盘回落卖点）
  tail_dip_emo3_3d_gain: { id: 'tail_dip_emo3_3d_gain', name: '三日情绪冰点-3日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入最近 3 个交易日涨幅最大的股票；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_3d_fall: { id: 'tail_dip_emo3_3d_fall', name: '三日情绪冰点-3日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入最近 3 个交易日跌幅最大的股票；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_3d_reports_top5_gain: { id: 'tail_dip_emo3_3d_reports_top5_gain', name: '三日情绪冰点-3日研报前五&涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，在最近 3 个交易日研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_1d_gain: { id: 'tail_dip_emo3_1d_gain', name: '三日情绪冰点-当日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入当日涨幅最大的股票（涨幅相同时取最近 2 个交易日涨幅最大的一只）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_1d_fall: { id: 'tail_dip_emo3_1d_fall', name: '三日情绪冰点-当日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入当日跌幅最大的股票（跌幅相同时取最近 2 个交易日跌幅最大的一只）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_1d_resilience: { id: 'tail_dip_emo3_1d_resilience', name: '三日情绪冰点-当日抗分歧最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入当日抗分歧分数最大的股票（分数相同时取最近 2 个交易日抗分歧分数汇总最大的一只）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  // 情绪游资系列（独立回测逻辑，日期范围不受 fundSnapshot 限制，默认最近 60 个交易日）
  ...SENTIMENT_STRATEGIES,
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

// 选股抗分歧门槛（仅「买入最高涨幅」与「2日涨幅最大」两个策略启用）：这两个策略按「买点触发时点
// 当日盘中涨幅」从高到低排序，从最高者起依次要求「触发时点当日抗分歧分数 > 11」，不满足则顺延至
// 下一只满足的股票（买入条件明细中标注顺延原因；其余策略不受此限制、排序口径也不变）
const RESILIENCE_GATE_MIN = 11;
const RESILIENCE_GATE_STRATEGY_IDS = new Set(['highest_gain', 'highest_2d_gain']);
const RESILIENCE_GATE_DESC = '选股门槛：按买点触发时点当日盘中涨幅从高到低排序，从最高者起依次要求「触发时点当日抗分歧分数 > 11」，不满足则顺延至下一只满足的股票（全部候选均不满足则当日不买入），买入条件明细中标注是否因前序股票分数≤11 而顺延';
for (const s of Object.values(STRATEGIES)) {
  if (!RESILIENCE_GATE_STRATEGY_IDS.has(s.id)) continue;
  s.desc = `${s.desc}；${RESILIENCE_GATE_DESC}`;
}

// 三日情绪冰点系列统一追加：买入环境门禁说明（触发日跟踪指数满足其一才可买，见 ensureEmo3DayGates）
const EMO3_GATE_DESC = '；买入环境门禁：触发日候选股所跟踪指数（sh688 开头跟踪科创50 sh000688，其余跟踪创业板指 sz399006）满足其一才可买入——①往前数 5 个交易日 20 日线斜率为正（MA20(触发日) − MA20(5个交易日前) > 0，含触发日收盘价，尾盘 14:57 触发按收盘已基本定型口径）；②触发日 30 日线在 60 日线下方（MA30 < MA60）。目的：剔除单边阴跌中段（20日线仍下行且 30 日线未跌破 60 日线）的无溢价环境，仅保留下跌初期/末期；全部候选股均不满足（或指数日K数据不足/获取失败）时当日不买入，买入条件明细中展示命中条件与具体数值';
for (const s of Object.values(STRATEGIES)) {
  if (s.emoAvgBuy !== true) continue;
  s.desc = `${s.desc}${EMO3_GATE_DESC}`;
}

// 回测结果缓存文件（按 策略+日期范围 存储，避免重复回测）
const backtestCacheDir = path.join(__dirname, '../data/backtest_results');
const getBacktestCacheFile = (strategy, startDate, endDate) => path.join(backtestCacheDir, `backtest_${strategy}_${startDate}_${endDate}.json`);

// ---------- 持仓交易日数（以项目根目录 YYYY交易日.json 交易日历为准）----------
// 持仓天数 = 卖出日相对买入日的交易日跨度（当日卖出为 0），自动剔除周末/法定节假日；
// 买卖日期所在年份超出日历覆盖范围时（如更早的历史区间）按周一~周五回退计数，
// 并以 holdingDaysApprox = true 标记为退化估算（前端显示 ≈）
const tradingDayUtil = require('../utils/tradingDay');
const normDateNum = (s) => String(s == null ? '' : s).replace(/-/g, '');

// 为回测结果就地补充持仓交易日数（trades / currentHolding / stocks[].trades / stocks[].holding）：
// holdingDays = 卖出日 - 买入日的交易日跨度；期末仍持仓的统计买入日至最近一个交易日（今日为交易日则含今日）；
// holdingDaysApprox = true 表示买卖日期所在年份未被交易日历覆盖、按周一~周五退化估算
const attachHoldingDays = (result) => {
  if (!result || typeof result !== 'object') return result;
  const now = new Date();
  const latest = tradingDayUtil.isTradingDay(now) ? now : tradingDayUtil.getPrevTradingDay(now);
  const latestTradingDayNum = Number(`${latest.getFullYear()}${String(latest.getMonth() + 1).padStart(2, '0')}${String(latest.getDate()).padStart(2, '0')}`);
  const calc = (buyDate, sellDate) => {
    const a = normDateNum(buyDate);
    const b = normDateNum(sellDate);
    if (!/^\d{8}$/.test(a) || !/^\d{8}$/.test(b) || b < a) return null;
    const days = tradingDayUtil.countTradingDaysBetween(a, b);
    if (days == null) return null;
    const approx = !tradingDayUtil.isYearCovered(a) || !tradingDayUtil.isYearCovered(b);
    return { days, approx };
  };
  const apply = (pos, open) => {
    if (!pos || !pos.buyDate) return;
    const r = open ? calc(pos.buyDate, latestTradingDayNum) : calc(pos.buyDate, pos.sellDate);
    if (!r) return;
    pos.holdingDays = r.days;
    pos.holdingDaysApprox = r.approx;
  };
  (result.trades || []).forEach(t => apply(t, false));
  apply(result.currentHolding, true);
  (result.stocks || []).forEach(st => {
    (st.trades || []).forEach(t => apply(t, false));
    apply(st.holding, true);
  });
  // 平均持仓时间：仅统计已卖出成交（holdingDays 非空，不含期末仍持仓），保留 1 位小数；
  // 含退化估算（≈）的交易时在 summary.avgHoldingDaysApprox 标记
  const closedDays = [];
  let anyApprox = false;
  const collectClosed = (t) => {
    if (t && t.holdingDays != null) {
      closedDays.push(t.holdingDays);
      if (t.holdingDaysApprox) anyApprox = true;
    }
  };
  (result.trades || []).forEach(collectClosed);
  (result.stocks || []).forEach(st => (st.trades || []).forEach(collectClosed));
  if (result.summary && closedDays.length > 0) {
    result.summary.avgHoldingDays = Math.round((closedDays.reduce((a, b) => a + b, 0) / closedDays.length) * 10) / 10;
    result.summary.avgHoldingDaysApprox = anyApprox;
  }
  return result;
};

// 回撤统计（仅统计已卖出成交中收益率为负的单笔，returnRate 为百分数）：
//   avgDrawdown：亏损单笔的平均收益率（负值）；maxDrawdown：单笔最大回撤（最差一笔，负值）
// 无亏损成交时两者均为 null（前端展示 --）
const calcDrawdownStats = (trades) => {
  const losses = (Array.isArray(trades) ? trades : [])
    .map(t => Number(t?.returnRate))
    .filter(r => Number.isFinite(r) && r < 0);
  if (losses.length === 0) return { avgDrawdown: null, maxDrawdown: null };
  return {
    avgDrawdown: parseFloat((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)),
    maxDrawdown: parseFloat(Math.min(...losses).toFixed(2)),
  };
};

const readCachedBacktest = (strategy, startDate, endDate) => {
  try {
    const file = getBacktestCacheFile(strategy, startDate, endDate);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || data.range?.startDate !== startDate || data.range?.endDate !== endDate) return null;
    return attachHoldingDays(data); // 读取时统一注入持仓交易日数（缓存文件本身不落盘该字段，兼容旧缓存）
  } catch {
    return null;
  }
};

const writeCachedBacktest = (strategy, startDate, endDate, result) => {
  try {
    if (!fs.existsSync(backtestCacheDir)) fs.mkdirSync(backtestCacheDir, { recursive: true });
    fs.writeFileSync(getBacktestCacheFile(strategy, startDate, endDate), JSON.stringify(result, null, 2), 'utf-8');
  } catch (e) {
    console.error('回测结果缓存写入失败:', e.message);
  }
};

// ============================================================
// 机构研报覆盖索引：research_reports/menu.json（日期文件夹 → 报告标题/正文）
// 按自选股名称匹配报告标题或正文，统计每日每只股票的研报覆盖数
// ============================================================
const researchReportsDir = path.join(__dirname, '../data/research_reports');
let reportIndexCache = null; // { YYYYMMDD: { stockName: count } }
let reportIndexMtime = 0; // menu.json 修改时间，用于检测新增/编辑研报后自动重建索引

// 读取报告正文内容（id.json 存放 { content }），供正文匹配股票名使用
const readReportContent = (id) => {
  try {
    const contentPath = path.join(researchReportsDir, `${id}.json`);
    if (!fs.existsSync(contentPath)) return '';
    return JSON.parse(fs.readFileSync(contentPath, 'utf-8')).content || '';
  } catch {
    return '';
  }
};

const loadReportIndex = () => {
  const menuFile = path.join(researchReportsDir, 'menu.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(menuFile).mtimeMs;
  } catch {
    // menu.json 不存在时按 0 处理
  }
  if (reportIndexCache && mtime === reportIndexMtime) return reportIndexCache;
  const { getMonitorStocks } = require('./monitorStock');
  const stockNames = Array.from(new Set(
    getMonitorStocks().map(s => s.name).filter(Boolean)
  )).sort((a, b) => b.length - a.length); // 长名优先，避免"天孚通信"被"通信"误配
  const index = {};
  try {
    const menu = JSON.parse(fs.readFileSync(menuFile, 'utf-8'));
    const walk = (node, folderDate) => {
      if (!node) return;
      if (node.type === 'folder') {
        const date = String(node.name || '');
        if (!/^\d{8}$/.test(date)) return;
        for (const child of (node.children || [])) walk(child, date);
      } else if (node.type === 'report') {
        const id = String(node.id || '');
        if (!folderDate || !id) return;
        // 标题或正文命中股票名的都计入覆盖（正文如"相关国内标的：天孚通信，仕佳光子"）
        const text = `${String(node.name || '')}\n${readReportContent(id)}`;
        const matchedNames = stockNames.filter(n => text.includes(n));
        if (matchedNames.length === 0) return;
        if (!index[folderDate]) index[folderDate] = {};
        for (const n of matchedNames) {
          index[folderDate][n] = (index[folderDate][n] || 0) + 1;
        }
      }
    };
    for (const root of menu) walk(root, null);
  } catch (e) {
    console.error('研报索引加载失败:', e.message);
  }
  reportIndexCache = index;
  reportIndexMtime = mtime;
  return index;
};

// 某只股票在 winDates（升序）内的研报覆盖总数
const sumReportCount = (stockName, winDates, reportIndex) => {
  if (!stockName || !reportIndex) return 0;
  let count = 0;
  for (const d of winDates) {
    const day = reportIndex[d];
    if (day) count += day[stockName] || 0;
  }
  return count;
};

// ============================================================
// 以下为买点诊断移植（对齐 src/pages/trainingCamp/utils/buyPointChecks.js）
// ============================================================
const minuteToSeconds = (minute) => {
  const m = Number(minute);
  const h = Math.floor(m / 100);
  const mm = m % 100;
  return h * 3600 + mm * 60;
};

const fmtTime = (timeKey) => {
  const t = String(timeKey || '').padStart(6, '0');
  if (t.length < 4) return '--:--:--';
  return `${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`;
};

// 在当前桶之前寻找约 targetMin 分钟前的桶（targetMin±1 分钟内取最近的；找不到回退到至少 targetMin-1 分钟前最近的）
const findBucketMinutesAgo = (buckets, currentIndex, targetMin = 5) => {
  if (currentIndex <= 0) return null;
  const currentSec = minuteToSeconds(buckets[currentIndex].minute);
  const minSec = (targetMin - 1) * 60;
  const maxSec = (targetMin + 1) * 60;
  let hit = null;
  let hitIdx = -1;
  let minDelta = Infinity;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const diff = currentSec - minuteToSeconds(buckets[i].minute);
    if (diff >= minSec && diff <= maxSec) {
      if (diff < minDelta) { minDelta = diff; hit = buckets[i]; hitIdx = i; }
    } else if (diff > maxSec) {
      break;
    }
  }
  if (!hit) {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (currentSec - minuteToSeconds(buckets[i].minute) >= minSec) {
        hit = buckets[i];
        hitIdx = i;
        break;
      }
    }
  }
  return hit ? { bucket: hit, index: hitIdx } : null;
};

// 训练营回放买点诊断（对齐前端 buyPointChecks.js，返回 { success, data } 或 null）
// 资金净流入检查构建（常规买点诊断与重点板块策略共用）：最近 5min 大盘主力资金净流入差值，> 20 亿通过
// 返回 { fundResult, fundDiff, check }；fundResult.hasData=false 表示数据不足
const buildFundInflowCheck = (buckets, currentIndex) => {
  const list = buckets || [];
  const current = list[currentIndex];
  const currentFund = Number(current.fundFlow) || 0;
  const pastFundHit = findBucketMinutesAgo(list, currentIndex, 5);
  const fundResult = pastFundHit
    ? {
      hasData: true,
      diff: currentFund - (Number(pastFundHit.bucket.fundFlow) || 0),
      currentValue: currentFund,
      pastValue: Number(pastFundHit.bucket.fundFlow) || 0,
      currentTime: fmtTime(current.timeKey),
      pastTime: fmtTime(pastFundHit.bucket.timeKey),
    }
    : { hasData: false, diff: 0, currentValue: currentFund, pastValue: 0, currentTime: fmtTime(current.timeKey), pastTime: null };
  const fundDiff = parseFloat(fundResult.diff.toFixed(2));
  const checkFundPassed = fundResult.hasData && fundDiff > 20;
  const check = {
    id: 'fund_inflow',
    title: '最近 5min 资金净流入大于 20 亿',
    passed: checkFundPassed,
    value: fundResult.hasData ? `${fundDiff >= 0 ? '+' : ''}${fundDiff.toFixed(2)}亿` : '数据不足',
    reason: checkFundPassed
      ? `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），超过 20 亿阈值`
      : !fundResult.hasData
        ? '资金数据不足，无法判断最近 5 分钟净流入'
        : `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），未达到 20 亿阈值`,
  };
  return { fundResult, fundDiff, check };
};

// 量能检查构建（常规买点诊断与重点板块策略共用）：当前量能（今日累计成交额 − 昨日全天成交额）
// 为正时较 5min 前增加即可，为负时需增加 ≥ 100 亿；今日/昨日科技情绪触及 -100 冰点时自动豁免
const buildVolumeExpansionCheck = (buckets, currentIndex, campData) => {
  const list = buckets || [];
  const current = list[currentIndex];
  const volNow = current.volume !== null && current.volume !== undefined && !Number.isNaN(Number(current.volume)) ? Number(current.volume) : null;
  const pastVolHit = findBucketMinutesAgo(list, currentIndex, 5);
  const past2VolHit = pastVolHit ? findBucketMinutesAgo(list, pastVolHit.index, 5) : null;
  let volumeResult;
  if (volNow === null) {
    volumeResult = {
      hasData: false, diff: 0, last5minVol: 0, prev5minVol: 0,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
    };
  } else {
    const last5minVol = parseFloat(volNow.toFixed(2));
    const prev5minVol = pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : 0;
    volumeResult = {
      hasData: true,
      diff: parseFloat((last5minVol - prev5minVol).toFixed(2)),
      last5minVol,
      prev5minVol,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
      currentCumulative: parseFloat(volNow.toFixed(2)),
      pastCumulative: pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : null,
      past2Cumulative: past2VolHit ? parseFloat((Number(past2VolHit.bucket.volume) || 0).toFixed(2)) : null,
    };
  }
  const volDiff = volumeResult.hasData ? volumeResult.diff : 0;
  // 判定规则（对齐线上 buySellDiagnose.js）：当前量能为正时只需较 5min 前增加；为负时需增加 100 亿以上
  const checkVolumePassed = !volumeResult.hasData ? false
    : volumeResult.last5minVol > 0
      ? volumeResult.last5minVol > volumeResult.prev5minVol
      : volDiff >= 100;
  const todayHasIceFlag = campData?.todayHasIce === true;
  const prevDayHasIceFlag = campData?.prevDayHasIce === true;
  if (todayHasIceFlag || prevDayHasIceFlag) {
    const targetDateStr = String(campData?.date || '').replace(/-/g, '');
    const iceSource = todayHasIceFlag ? `今日(${targetDateStr.substring(4, 6)}-${targetDateStr.substring(6, 8)})` : '前一交易日';
    return {
      check: {
        id: 'volume_expansion',
        title: '当前量能为正（今日累计成交额超昨日全天）',
        passed: true,
        exempted: true,
        value: volumeResult.hasData ? `${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿（已豁免）` : '已豁免',
        reason: `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），情绪已达冰点量能条件自动豁免`,
      },
      volumeResult,
    };
  }
  // 量能明细文案（随买入原因汇总展示）：当前量能值 + 最近 5min 变化量
  const volumeText = volumeResult.hasData
    ? `当前量能 ${volumeResult.last5minVol.toFixed(2)}亿，较 5min 前 ${volDiff >= 0 ? '+' : '-'}${Math.abs(volDiff).toFixed(2)}亿`
    : null;
  return {
    check: {
      id: 'volume_expansion',
      title: '量能较 5min 前增加（负值需增加超 100 亿）',
      passed: checkVolumePassed,
      value: volumeResult.hasData ? `${volDiff >= 0 ? '+' : '-'} ${Math.abs(volDiff).toFixed(2)}亿` : '数据不足',
      volumeText,
      reason: !volumeResult.hasData
        ? '量能数据不足，无法判断当前量能'
        : (() => {
          const volChangeText = volDiff >= 0 ? `+ ${volDiff.toFixed(2)} 亿` : `- ${Math.abs(volDiff).toFixed(2)} 亿`;
          return volumeResult.last5minVol > 0
            ? checkVolumePassed
              ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为正，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，持续放量`
              : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿虽为正，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}`
            : checkVolumePassed
              ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，达到 100 亿阈值`
              : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿仅${volChangeText}，未达到增加 100 亿的阈值`;
        })(),
    },
    volumeResult,
  };
};

const runBuyPointDiagnosis = (timeBuckets, currentIndex, campData) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return null;
  const current = buckets[currentIndex];
  const checks = [];
  let allPassed = true;
  const targetDateStr = String(campData?.date || '').replace(/-/g, '');

  // 检查2：最近 5min 资金净流入大于 20 亿（构建函数与重点板块策略共用）
  const { check: fundCheck } = buildFundInflowCheck(buckets, currentIndex);
  checks.push(fundCheck);
  if (!fundCheck.passed) allPassed = false;

  // 检查3：量能较 5min 前增加（负值需增加超 100 亿；情绪冰点自动豁免，构建函数与重点板块策略共用）
  const { check: volumeCheck } = buildVolumeExpansionCheck(buckets, currentIndex, campData);
  checks.push(volumeCheck);
  if (!volumeCheck.passed) allPassed = false;

  // 检查4：开盘后自选股低于开盘价不超过 30 只（仅 9:30-10:00 生效）
  const changes = current.stockChanges || [];
  const inOpeningWindow = Number(current.minute) >= 930 && Number(current.minute) <= 1000;
  if (inOpeningWindow) {
    const openingBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
    const openingMap = new Map((openingBucket?.stockChanges || []).map(s => [s.code, s.changePct]));
    let belowCount = 0;
    let validCount = 0;
    changes.forEach(s => {
      const openPct = openingMap.get(s.code);
      if (openPct !== undefined && openPct !== null) {
        validCount++;
        if (Number(s.changePct) < Number(openPct)) belowCount++;
      }
    });
    const checkOpeningPassed = belowCount <= 30;
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: checkOpeningPassed,
      value: `${belowCount} / ${validCount}只`,
      reason: checkOpeningPassed
        ? `开盘后自选股共 ${validCount} 只，${belowCount} 只现价低于 9:30 开盘价，未超过 30 只`
        : belowCount > 30
          ? `开盘后自选股共 ${validCount} 只，${belowCount} 只现价低于 9:30 开盘价，超过 30 只阈值，市场开盘跳水严重`
          : '分时数据获取异常',
    });
    if (!checkOpeningPassed) allPassed = false;
  } else {
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: true,
      value: '非交易时段',
      reason: '此项检查仅在交易日 9:30-10:00 之间生效，当前时段跳过',
    });
  }

  // 检查6：9:30 竞价开盘科技情绪 > 80 时，后续触发买点要求当前科技情绪 < 40
  const openEmotionBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
  const openingAuctionEmotion = openEmotionBucket && openEmotionBucket.techEmotion !== null && openEmotionBucket.techEmotion !== undefined && !Number.isNaN(Number(openEmotionBucket.techEmotion))
    ? Number(openEmotionBucket.techEmotion)
    : null;
  const currentRetraceEmotion = current.techEmotion !== null && current.techEmotion !== undefined && !Number.isNaN(Number(current.techEmotion))
    ? Number(current.techEmotion)
    : null;

  let checkEmotionRetracePassed;
  let emotionRetraceReason;
  if (openingAuctionEmotion === null) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = '暂无 9:30 竞价科技情绪分时数据，跳过该检查';
  } else if (openingAuctionEmotion <= 80) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 未超过 80，当前情绪须低于 40 的限制不生效`;
  } else if (currentRetraceEmotion === null) {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，但暂无当前分时数据，无法确认情绪回落至 40 以下`;
  } else if (currentRetraceEmotion < 40) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentRetraceEmotion.toFixed(2)} 已回落至 40 以下，允许买入`;
  } else {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentRetraceEmotion.toFixed(2)} 未回落至 40 以下，禁止买入`;
  }
  checks.push({
    id: 'emotion_retrace_after_open',
    title: '竞价情绪超 80 时当前情绪须低于 40',
    passed: checkEmotionRetracePassed,
    value: openingAuctionEmotion === null ? '暂无分时数据' : `开盘 ${openingAuctionEmotion.toFixed(2)} / 当前 ${currentRetraceEmotion === null ? '--' : currentRetraceEmotion.toFixed(2)}`,
    reason: emotionRetraceReason,
  });
  if (!checkEmotionRetracePassed) allPassed = false;

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timeKey: current.timeKey,
      displayTime: current.displayTime || fmtTime(current.timeKey),
      checks,
      allPassed,
      passedCount: checks.filter(c => c.passed).length,
      totalCheckCount: checks.length,
    },
  };
};

// 尾盘抄底命中检查（买卖点回测专用）：
// 抄底时机固定在尾盘 14:57（收盘集合竞价挂单，按触发桶价格成交，价格≈当日收盘价）：
// 判断点取当日第一个 minute ≥ 1457 的回放桶（通常即 1500 收盘桶）；
// 若当日分时数据未覆盖 14:57（如最后一桶为 1455），回退用当日最后一个桶，其余桶一律不触发。
// 命中条件（唯一）：当日科技情绪分时曾触及 -100 退潮冰点（等价于当日科技情绪指数 hasIce: true）
const checkTailDipHit = (timeBuckets, currentIndex) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return false;
  // 注意：回放桶的 minute 为 HHMM 整数（如 1457 表示 14:57），与 runBuyPointDiagnosis 开盘窗口（930-1000）口径一致
  let triggerIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) >= 1457) { triggerIdx = i; break; }
  }
  if (triggerIdx === -1) triggerIdx = buckets.length - 1; // 数据未覆盖 14:57 时回退最后一个桶，避免条件永不命中
  if (currentIndex !== triggerIdx) return false;

  // 当日科技情绪分时曾触及 -100（hasIce）；仅统计截至当前时点的分时，避免使用未来数据
  return buckets.slice(0, currentIndex + 1).some((b) => {
    const e = b.techEmotion == null ? null : Number(b.techEmotion);
    return e != null && !Number.isNaN(e) && e <= -100;
  });
};

// 情绪页同源数据：tech_index.json 每日收盘情绪分（changeSumResult）序列，
// 复刻 sentiment 页「三日均值」EMA 线算法（emaAlpha = 2/(3+1) = 0.5，首点 = 前三个值简单均值，
// 之后 currentEma = 0.5 * 当日值 + 0.5 * 前一日 EMA；按文件全量序列递推，含周末重复数据点，与页面展示一致）。
// 返回 Map<'YYYYMMDD', EMA值>（序列前两个点无 EMA，存 null）
const TECH_INDEX_FILE = path.join(__dirname, '../data/tech_index.json');
let techEmotionEmaCache = null;
// force=true 时强制重读文件（盘中调用需拿当日最新的 changeSumResult，回测离线场景用默认缓存即可）
const getTechEmotionEmaMap = (force = false) => {
  if (!force && techEmotionEmaCache) return techEmotionEmaCache;
  const map = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(TECH_INDEX_FILE, 'utf-8'));
    if (Array.isArray(arr)) {
      const chartData = arr
        .filter(x => x && x.date != null && x.changeSumResult != null && !Number.isNaN(Number(x.changeSumResult)))
        .sort((a, b) => a.date - b.date)
        .map(x => ({ date: String(x.date), value: Number(x.changeSumResult) }));
      let prevEma = null;
      for (let i = 0; i < chartData.length; i++) {
        let ema = null;
        if (i >= 2) {
          if (prevEma === null) {
            prevEma = (chartData[i - 2].value + chartData[i - 1].value + chartData[i].value) / 3;
          } else {
            prevEma = 0.5 * chartData[i].value + 0.5 * prevEma;
          }
          ema = prevEma;
        }
        map.set(chartData[i].date, ema);
      }
    }
  } catch (e) { /* 文件缺失/损坏时 map 为空，策略不触发 */ }
  techEmotionEmaCache = map;
  return map;
};

// tech_index.json 覆盖的日期（过滤周末重复数据点），供三日情绪均值策略并入回测日期序列，
// 覆盖缺资金快照的交易日（如 20260730）——该系列策略不依赖历史资金/成交量快照
const getTechIndexDates = () => Array.from(getTechEmotionEmaMap().keys()).filter(d => {
  if (!/^\d{8}$/.test(d)) return false;
  const weekday = new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))).getDay();
  return weekday >= 1 && weekday <= 5;
});

// 三日情绪均值尾盘抄底命中检查（买卖点回测专用）：
// 抄底时机固定在尾盘 14:57（与 checkTailDipHit 一致）；
// 命中条件：情绪页「三日均值」EMA 线当日读数 < -60（与前端 sentiment 页曲线同源同算法，用户按该曲线人工盯盘）。
// 注意：EMA 读数基于每日收盘情绪分，属收盘定型值，14:57 触发时视为已基本定型（与用户实际盯盘习惯一致）
const EMO_AVG3_THRESHOLD = -60;
const checkEmoAvg3Hit = (timeBuckets, currentIndex, dateStr) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return false;
  let triggerIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) >= 1457) { triggerIdx = i; break; }
  }
  if (triggerIdx === -1) triggerIdx = buckets.length - 1; // 数据未覆盖 14:57 时回退最后一个桶，避免条件永不命中
  if (currentIndex !== triggerIdx) return false;
  const ema = getTechEmotionEmaMap().get(String(dateStr));
  return ema != null && ema < EMO_AVG3_THRESHOLD;
};

// ===== 买入原因构建（随成交记录/缓存/回测报告落盘，供前端与报告展示命中了哪些买入条件） =====
// 尾盘抄底策略的固定买入原因（命中条件唯一：当日科技情绪分时曾触及 -100 退潮冰点）
const TAIL_DIP_BUY_INFO = {
  buyReason: '尾盘抄底命中：当日科技情绪曾触及-100退潮冰点',
  buyChecks: [{
    id: 'tail_dip',
    title: '尾盘抄底命中（当日科技情绪曾触及-100退潮冰点）',
    passed: true,
    value: '14:57',
    reason: '当日科技情绪分时曾触及 -100 退潮冰点（等价 hasIce: true），14:57 尾盘挂单买入（收盘集合竞价成交）',
  }],
};

// 三日情绪均值尾盘抄底策略的固定买入原因（命中条件：情绪页三日均值EMA线 < -60）
const EMO_AVG3_BUY_INFO = {
  buyReason: '尾盘抄底命中：情绪页三日均值线(EMA) < -60',
  buyChecks: [{
    id: 'tail_dip_emo3',
    title: '尾盘抄底命中（情绪页三日均值EMA线<-60）',
    passed: true,
    value: '14:57',
    reason: '情绪页「三日均值」EMA 线（每日收盘情绪分 changeSumResult 递推，与 sentiment 页同源同算法）当日读数 < -60，14:57 尾盘挂单买入（收盘集合竞价成交）',
  }],
};

// 由买点诊断结果构建买入原因：buyReason 为全部命中条件标题汇总（与 sellReason 命中卖出条件名口径一致），
// 量能项额外附带当前量能值与最近 5min 变化量；buyChecks 为逐项明细（含数值与判定理由），
// allPassed !== true 时返回空
const buildBuyReasonFromDiag = (diagData) => {
  if (!diagData || diagData.allPassed !== true) return { buyReason: '', buyChecks: [] };
  const passedChecks = (diagData.checks || []).filter(c => c.passed);
  return {
    buyReason: passedChecks.map(c => (
      c.id === 'volume_expansion' && c.volumeText
        ? `${c.title}：${c.volumeText}`
        : c.title
    )).join('、') || '买点诊断全部通过',
    buyChecks: (diagData.checks || []).map(c => ({
      id: c.id,
      title: c.title,
      passed: !!c.passed,
      exempted: !!c.exempted,
      value: c.value,
      reason: c.reason,
      ...(c.volumeText ? { volumeText: c.volumeText } : {}),
    })),
  };
};

// ============================================================
// 以下为抗分歧指数移植（对齐 src/utils/replayResilience.js）
// ============================================================
const getReplayLimitType = (code) => {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('SH688') || c.startsWith('688')) return 'STAR';
  if (c.startsWith('SZ3') || c.startsWith('3')) return 'GEM';
  return 'MAIN';
};

const calculateReplayResilience = (stockPoints, indexPoints, code) => {
  if (!Array.isArray(stockPoints) || stockPoints.length < 5) return null;
  if (!Array.isArray(indexPoints) || indexPoints.length < 5) return null;
  const limits = { STAR: 20, GEM: 20, MAIN: 10 };
  const limitType = getReplayLimitType(code);
  const limitPct = limits[limitType] ?? 10;
  const limitEps = 0.001;

  const indexMap = new Map();
  for (const item of indexPoints) {
    const m = parseInt(item.minute);
    const px = item.lastPx != null ? parseFloat(item.lastPx) : (100 + (item.change != null ? parseFloat(item.change) : 0));
    if (!isNaN(m) && px > 0) {
      indexMap.set(m, { px, change: item.change != null ? parseFloat(item.change) : 0 });
    }
  }
  if (indexMap.size < 5) return null;

  const aligned = [];
  for (const s of stockPoints) {
    const m = parseInt(s.minute);
    const idx = indexMap.get(m);
    if (!idx) continue;
    const stockPx = s.lastPx != null ? parseFloat(s.lastPx) : (100 + (s.change != null ? parseFloat(s.change) : 0));
    if (!(stockPx > 0)) continue;
    const stockChange = s.change != null ? parseFloat(s.change) : 0;
    const prevClose = stockPx / (1 + stockChange / 100);
    const limitUpPrice = prevClose * (1 + limitPct / 100);
    const limitDownPrice = prevClose * (1 - limitPct / 100);
    aligned.push({
      minute: m,
      stockPx,
      indexPx: idx.px,
      stockChange,
      indexChange: idx.change,
      isLockUp: stockPx >= limitUpPrice - limitEps,
      isLockDown: stockPx <= limitDownPrice + limitEps,
      prevClose,
    });
  }
  aligned.sort((a, b) => a.minute - b.minute);
  if (aligned.length < 5) return null;

  const totalMinutes = aligned.length;
  const lockUpCount = aligned.filter(p => p.isLockUp).length;
  const lockDownCount = aligned.filter(p => p.isLockDown).length;
  const lockUpRatio = lockUpCount / totalMinutes;
  const lockDownRatio = lockDownCount / totalMinutes;

  const freeMinutes = aligned.filter(p => !p.isLockUp && !p.isLockDown);
  const stockRets = [];
  const indexRets = [];
  for (let i = 1; i < freeMinutes.length; i++) {
    const prev = freeMinutes[i - 1];
    const curr = freeMinutes[i];
    if (prev.stockPx > 0 && prev.indexPx > 0) {
      stockRets.push((curr.stockPx - prev.stockPx) / prev.stockPx * 100);
      indexRets.push((curr.indexPx - prev.indexPx) / prev.indexPx * 100);
    }
  }

  const upStockRets = [];
  const upIndexRets = [];
  const downStockRets = [];
  const downIndexRets = [];
  for (let i = 0; i < indexRets.length; i++) {
    if (indexRets[i] > 0) {
      upIndexRets.push(indexRets[i]);
      upStockRets.push(stockRets[i]);
    } else if (indexRets[i] < 0) {
      downIndexRets.push(indexRets[i]);
      downStockRets.push(stockRets[i]);
    }
  }

  const safeRatio = (xArr, yArr, minSamples = 3) => {
    if (xArr.length < minSamples || yArr.length < minSamples) return null;
    const meanX = xArr.reduce((a, b) => a + b, 0) / xArr.length;
    const meanY = yArr.reduce((a, b) => a + b, 0) / yArr.length;
    if (Math.abs(meanX) < 0.005) return null;
    return meanY / meanX;
  };

  const upRatio = safeRatio(upIndexRets, upStockRets);
  const downRatio = safeRatio(downIndexRets, downStockRets);

  const upStockChg = [];
  const upIndexChg = [];
  const downStockChg = [];
  const downIndexChg = [];
  for (const p of freeMinutes) {
    if (p.indexChange > 0) {
      upStockChg.push(p.stockChange);
      upIndexChg.push(p.indexChange);
    } else if (p.indexChange < 0) {
      downStockChg.push(p.stockChange);
      downIndexChg.push(p.indexChange);
    }
  }
  const avg = (arr) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const excessUp = avg(upStockChg) - avg(upIndexChg);
  const excessDown = avg(downStockChg) - avg(downIndexChg);

  let offenseScore = 0;
  if (upRatio !== null) {
    offenseScore = Math.min(4, Math.max(0, upRatio * 1.6));
  } else {
    offenseScore = 1.0;
  }

  let defenseScore = 0;
  if (downRatio !== null) {
    if (downRatio < 0) {
      defenseScore = 6.0 + Math.min(4, Math.abs(downRatio) * 2);
    } else {
      defenseScore = 5.0 / (downRatio + 1.0);
    }
  } else {
    defenseScore = 2.5;
  }

  const excessUpScore = Math.max(-2, Math.min(2, excessUp * 0.3));
  const excessDownScore = Math.max(-3, Math.min(5, excessDown * 0.8));

  let lockScore = 0;
  if (lockUpRatio > 0.5) {
    lockScore = 5 + (lockUpRatio - 0.5) * 10;
  } else if (lockUpRatio > 0) {
    lockScore = lockUpRatio * 4;
  }
  if (lockDownRatio > 0.5) {
    lockScore -= 5 + (lockDownRatio - 0.5) * 10;
  } else if (lockDownRatio > 0) {
    lockScore -= lockDownRatio * 4;
  }

  let resilienceScore = 5.0 + offenseScore + defenseScore + excessUpScore + excessDownScore + lockScore;
  resilienceScore = Math.max(0, Math.min(30, resilienceScore));
  return parseFloat(resilienceScore.toFixed(4));
};

// ============================================================
// 以下为卖点诊断移植（对齐 src/pages/trainingCamp/utils/sellPointChecks.js）
// ============================================================
const toNumber = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

// 取某只股票（或指数）截至当前 minute 的分时序列 { minute, change, lastPx }
const getTlinePoints = (replayStocks, code, minute) => {
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry) return [];
  return (entry.tlinePoints || [])
    .filter(p => p.minute != null && p.minute <= minute)
    .sort((a, b) => a.minute - b.minute);
};

// 检查条件2（高位放量大阴线）在过去 N 分钟内是否持续满足
const checkCondition2Persist = (replayStocks, code, currentMinute, openPrice) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry || !entry.tlinePoints || entry.tlinePoints.length === 0) return { satisfied: false, checkedMin: 0 };
  const sorted = [...entry.tlinePoints]
    .filter(p => p.minute != null && p.minute <= currentMinute && p.lastPx != null && p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sorted.length === 0) return { satisfied: false, checkedMin: 0 };

  const recent = sorted.slice(-PERSIST_MIN);
  if (recent.length < PERSIST_MIN) {
    return { satisfied: false, checkedMin: recent.length };
  }
  for (let i = 0; i < recent.length; i++) {
    const dayHighAtMinute = sorted
      .filter(p => p.minute <= recent[i].minute)
      .reduce((mx, p) => Math.max(mx, p.lastPx), 0);
    const px = recent[i].lastPx;
    const amp = px > 0 ? ((dayHighAtMinute - px) / px) * 100 : 0;
    if (!(amp > 8 && px < openPrice)) {
      return { satisfied: false, checkedMin: i + 1 };
    }
  }
  return { satisfied: true, checkedMin: recent.length };
};

// 检查条件3（科技板块情绪退潮）在过去 N 分钟内是否持续满足
const checkCondition3Persist = (timeBuckets, currentIndex) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  if (!Array.isArray(timeBuckets) || currentIndex < 0) return { satisfied: false, checkedMin: 0 };

  let coveredMin = 0;
  for (let i = currentIndex; i >= 0; i--) {
    const bucket = timeBuckets[i];
    const techEmotion = toNumber(bucket?.techEmotion);
    const downStocksCount = (bucket?.stockChanges || []).filter(s => {
      const pct = toNumber(s.changePct);
      return pct !== null && pct < -9;
    }).length;
    const cond3True = techEmotion !== null && techEmotion === -100 && downStocksCount >= 5;
    if (!cond3True) break;
    const bucketMinute = toNumber(bucket?.minute);
    if (bucketMinute === null || bucketMinute === undefined) break;
    if (i === currentIndex) {
      coveredMin += 5;
    } else {
      const prevBucketMinute = toNumber(timeBuckets[i + 1]?.minute);
      if (prevBucketMinute !== null && prevBucketMinute !== undefined) {
        coveredMin += prevBucketMinute - bucketMinute;
      } else {
        coveredMin += 5;
      }
    }
    if (coveredMin >= PERSIST_MIN) {
      return { satisfied: true, checkedMin: coveredMin };
    }
  }
  return { satisfied: false, checkedMin: coveredMin };
};

// 检查条件6（跌破最迟买入日低点）在过去 N 分钟内是否持续满足
const checkBuyDayLowPersist = (replayStocks, code, currentMinute, buyDayLow) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry || !entry.tlinePoints || entry.tlinePoints.length === 0) return { satisfied: false, checkedMin: 0 };
  const sorted = [...entry.tlinePoints]
    .filter(p => p.minute != null && p.minute <= currentMinute && p.lastPx != null && p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sorted.length === 0) return { satisfied: false, checkedMin: 0 };
  const recent = sorted.slice(-PERSIST_MIN);
  if (recent.length < PERSIST_MIN) {
    return { satisfied: false, checkedMin: recent.length };
  }
  for (let i = 0; i < recent.length; i++) {
    if (!(recent[i].lastPx < buyDayLow)) {
      return { satisfied: false, checkedMin: i + 1 };
    }
  }
  return { satisfied: true, checkedMin: recent.length };
};

// 尾盘抄底专属卖点检查（1 分钟维度）：
//   开盘后逐分钟环比跟踪：当前分钟涨幅（相对昨收）与上一分钟涨幅比较——
//   一直在上涨（ curr > prev ）→ 先不卖出继续持有；首次开始下降（ curr < prev ）→ 在该分钟卖出。
//   涨幅持平视为尚未开始下降，继续持有；开盘首分钟无上一分钟可比，仅作为基准；
//   若全天持续上涨未出现下降则当日不卖，次日继续跟踪。
// 数据源：getSingleStockTlineDataByDate 分钟级分时（磁盘/内存缓存）；拉取失败时回退用 5min 桶回放点近似
const checkOpenRetraceSell = async (replayStocks, code, currentMinute, dateStr) => {
  let points = [];
  try {
    const tline = await getSingleStockTlineDataByDate(code, parseInt(dateStr));
    points = (tline?.line || [])
      .filter(p => p.minute != null && Number(p.minute) <= currentMinute
        && p.change != null && !Number.isNaN(Number(p.change))
        && p.last_px != null && Number(p.last_px) > 0)
      .map(p => ({ minute: Number(p.minute), change: Number(p.change), lastPx: Number(p.last_px) }));
  } catch (e) { /* 拉取失败走回退 */ }
  if (points.length === 0) {
    points = getTlinePoints(replayStocks, code, currentMinute)
      .filter(p => p.change != null && !Number.isNaN(Number(p.change)) && p.lastPx != null && p.lastPx > 0);
  }
  // 逐分钟环比：首个较上一分钟开始下降的分钟即卖点（首分钟仅作基准）
  for (let i = 1; i < points.length; i++) {
    if (points[i].change < points[i - 1].change) {
      return {
        satisfied: true,
        triggerMinute: points[i].minute,
        triggerPrice: points[i].lastPx,
        prevChange: points[i - 1].change,
        currentChange: points[i].change,
        retrace: points[i - 1].change - points[i].change,
      };
    }
  }
  const last = points.length > 0 ? points[points.length - 1] : null;
  return {
    satisfied: false,
    triggerMinute: null,
    triggerPrice: null,
    prevChange: points.length > 1 ? points[points.length - 2].change : null,
    currentChange: last ? last.change : null,
    retrace: null,
  };
};

// 训练营回放模拟持仓卖点诊断（对齐前端 sellPointChecks.js）
const runSellPointDiagnosis = async (position, currentBucket, replayStocks, timeBuckets, currentIndex, dateStr) => {
  const code = position?.code;
  const stockName = position?.stockName || position?.name || code;
  const buyPrice = toNumber(position?.buyPrice);
  const stockChanges = currentBucket?.stockChanges || [];
  const stock = stockChanges.find(s => s.code === code);
  const closePrice = stock?.lastPx != null ? toNumber(stock.lastPx) : null;
  const minute = currentBucket?.minute;
  const displayTime = fmtTime(currentBucket?.timeKey).substring(0, 5); // 归一化 HH:MM，避免原快照 displayTime 格式不一致

  if (closePrice === null || closePrice <= 0 || minute == null) {
    return {
      isSell: false,
      code,
      stockName,
      closePrice: null,
      change: null,
      returnRate: null,
      dayHigh: null,
      techEmotion: null,
      resilienceScore: null,
      conditions: [],
      conclusion: '当前时间桶无该股票价格数据，无法诊断',
      displayTime,
    };
  }

  const change = stock?.changePct != null ? toNumber(stock.changePct) : null;

  const stockPoints = getTlinePoints(replayStocks, code, minute).filter(p => p.lastPx != null && p.lastPx > 0);
  const dayHigh = stockPoints.reduce((mx, p) => Math.max(mx, p.lastPx), 0);
  const openPrice = stockPoints.length > 0 ? stockPoints[0].lastPx : null;

  // ===== 尾盘抄底策略专属卖点：开盘后逐分钟环比跟踪，涨幅开始下降（较上一分钟回落）即卖出（1 分钟维度，独立于下方 7 项通用条件） =====
  if (position?.tailDipSell === true) {
    const retraceCheck = await checkOpenRetraceSell(replayStocks, code, minute, dateStr);
    // 卖出价/卖出时间用分钟级触发点（精确到触发分钟），而非当前 5min 桶
    const sellPrice = retraceCheck.satisfied && retraceCheck.triggerPrice != null ? retraceCheck.triggerPrice : closePrice;
    const sellDisplayTime = retraceCheck.satisfied && retraceCheck.triggerMinute != null
      ? fmtTime(String(retraceCheck.triggerMinute).padStart(4, '0') + '00').substring(0, 5)
      : displayTime;
    const tailReturnRate = buyPrice !== null && buyPrice > 0 && sellPrice > 0
      ? parseFloat((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2))
      : null;
    const condition = {
      name: '开盘后涨幅开始下降即卖出',
      satisfied: retraceCheck.satisfied,
      detail: retraceCheck.currentChange == null
        ? '当前涨幅数据缺失，无法判断'
        : retraceCheck.satisfied
          ? `${sellDisplayTime} 涨幅 ${retraceCheck.currentChange.toFixed(2)}%，较上一分钟 ${retraceCheck.prevChange != null ? retraceCheck.prevChange.toFixed(2) : '--'}% 开始下降（回落 ${retraceCheck.retrace != null ? retraceCheck.retrace.toFixed(2) : '--'} 个百分点），按触发分钟价格卖出`
          : `开盘后涨幅持续上涨未开始下降（当前 ${retraceCheck.currentChange.toFixed(2)}%），继续持有`,
      subConditions: [],
    };
    const conditions = [condition];
    return {
      isSell: condition.satisfied,
      code,
      stockName,
      closePrice: parseFloat(sellPrice.toFixed(2)),
      change: change !== null ? parseFloat(change.toFixed(2)) : null,
      returnRate: tailReturnRate,
      dayHigh: dayHigh > 0 ? parseFloat(dayHigh.toFixed(2)) : null,
      techEmotion: currentBucket?.techEmotion != null ? toNumber(currentBucket.techEmotion) : null,
      resilienceScore: null,
      conditions,
      conclusion: condition.satisfied
        ? `尾盘抄底专属卖点：${sellDisplayTime} 涨幅开始下降（较上一分钟回落），卖出离场`
        : '尾盘抄底专属卖点未触发（开盘后涨幅持续上涨尚未开始下降），继续持有',
      displayTime: sellDisplayTime,
    };
  }

  // ===== 条件1：均线破位 =====
  const ma5 = stock?.dailyMa5 != null ? toNumber(stock.dailyMa5) : null;
  const ma5Slope = stock?.dailyMa5Slope != null ? toNumber(stock.dailyMa5Slope) : null;
  const ma10 = stock?.dailyMa10 != null ? toNumber(stock.dailyMa10) : null;
  const ma10Slope = stock?.dailyMa10Slope != null ? toNumber(stock.dailyMa10Slope) : null;
  const prevLow = stock?.dailyPrevLow != null ? toNumber(stock.dailyPrevLow) : null;

  let condition1 = {
    name: '均线破位',
    satisfied: false,
    detail: '',
    subConditions: [],
  };
  if (ma10 === null) {
    condition1.detail = '缺少日K线数据（不足10个交易日），无法计算MA10';
    condition1.subConditions = [{ label: '状态', value: '数据不足' }];
  } else {
    const inTradingWindow = minute != null && minute >= 930 && minute < 1450;
    const deepFall = change !== null && change < -3;

    let ruleType = 4;
    let slopeInfo = '';
    if (ma10Slope !== null && ma10Slope < 0) {
      if (ma5Slope !== null && ma5Slope > 0) {
        if (openPrice !== null && openPrice > ma10) {
          ruleType = 1;
        } else {
          ruleType = 3;
        }
      } else {
        ruleType = 2;
      }
      slopeInfo = `10日线斜率 ${ma10Slope.toFixed(2)} < 0`;
      if (ma5Slope !== null) slopeInfo += `，5日线斜率 ${ma5Slope.toFixed(2)}`;
    } else {
      ruleType = 4;
      slopeInfo = ma10Slope !== null
        ? `10日线斜率 ${ma10Slope.toFixed(2)} ≥ 0`
        : '10日线斜率数据不足（视为非负）';
    }

    const formatBreakDetail = (broken, triggerLine, triggerLabel) => {
      if (!broken) {
        return `现价 ${closePrice.toFixed(2)} 未跌破${triggerLabel} ${triggerLine.toFixed(2)}，未触发`;
      } else if (inTradingWindow && !deepFall) {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}，但当前涨幅 ${(change ?? 0).toFixed(2)}% 未低于 -3%（14:50 前需涨幅 < -3%），暂不触发`;
      } else if (inTradingWindow) {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}，且当前涨幅 ${change.toFixed(2)}% < -3%，触发卖点`;
      } else {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}（14:50 后跌破即触发），触发卖点`;
      }
    };

    if (ruleType === 1) {
      const broken = closePrice < ma10;
      condition1.satisfied = broken && (!inTradingWindow || deepFall);
      condition1.detail = formatBreakDetail(broken, ma10, '10日线');
    } else if (ruleType === 2) {
      const brokenPrevLow = prevLow !== null && closePrice < prevLow;
      condition1.satisfied = brokenPrevLow;
      condition1.detail = prevLow === null
        ? `${slopeInfo}，改用前低判断，但缺少前一交易日最低价数据`
        : brokenPrevLow
          ? `${slopeInfo}，现价 ${closePrice.toFixed(2)} 跌破前一交易日最低价 ${prevLow.toFixed(2)}，下降趋势延续，触发卖点`
          : `${slopeInfo}，现价 ${closePrice.toFixed(2)} 未跌破前一交易日最低价 ${prevLow.toFixed(2)}，暂不触发`;
    } else if (ruleType === 3) {
      if (ma5 !== null) {
        const broken = closePrice < ma5;
        condition1.satisfied = broken && (!inTradingWindow || deepFall);
        condition1.detail = formatBreakDetail(broken, ma5, '5日线');
      } else {
        condition1.detail = `${slopeInfo}，缺少MA5数据，无法按规则③判断`;
      }
    } else {
      const broken = closePrice < ma10;
      condition1.satisfied = broken && (!inTradingWindow || deepFall);
      condition1.detail = formatBreakDetail(broken, ma10, '10日线');
    }
  }

  // ===== 条件2：高位放量大阴线（需持续 ≥5 分钟） =====
  const amplitude = closePrice > 0 ? ((dayHigh - closePrice) / closePrice) * 100 : 0;
  const isCondition2RawTrue = openPrice !== null && amplitude > 8 && closePrice < openPrice;
  const cond2Persist = isCondition2RawTrue
    ? checkCondition2Persist(replayStocks, code, minute, openPrice)
    : { satisfied: false, checkedMin: 0 };
  const condition2 = {
    name: '高位放量大阴线',
    satisfied: cond2Persist.satisfied,
    pending: isCondition2RawTrue && !cond2Persist.satisfied,
    pendingMinutes: isCondition2RawTrue ? cond2Persist.checkedMin : 0,
    detail: openPrice !== null
      ? `回落 ${amplitude.toFixed(2)}%${amplitude > 8 ? ' > 8%' : ' ≤ 8%'}，现价 ${closePrice.toFixed(2)}${closePrice < openPrice ? ' < 开盘' : ' ≥ 开盘'}，${amplitude > 8 && closePrice < openPrice ? '为高位大阴线' : '未触发'}${isCondition2RawTrue && !cond2Persist.satisfied ? `（已持续 ${cond2Persist.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）` : ''}`
      : '无日内开盘价数据，无法判断',
    subConditions: [],
  };

  // ===== 条件3：科技板块情绪退潮（需持续 ≥5 分钟） =====
  // 重点板块系列专属门禁（2026-09-30）：仅当创业板指 3 日线斜率为正（position.keyBlockCybMa3Slope > 0，
  // MA3 − 5个交易日前MA3，按当日收盘已基本定型口径）时本条件才参与卖出判定；斜率为负/数据不足/获取失败当日不生效。
  // 字段缺省（其他策略）走原逻辑不受影响。
  const techEmotion = toNumber(currentBucket?.techEmotion);
  const downStocksCount = (currentBucket?.stockChanges || []).filter(s => {
    const pct = toNumber(s.changePct);
    return pct !== null && pct < -9;
  }).length;
  const techCrash = techEmotion !== null && techEmotion === -100;
  const hasKeyBlockGateC3 = position?.keyBlockCybMa3Slope !== undefined;
  const gateSlopeC3 = hasKeyBlockGateC3 && Number.isFinite(Number(position.keyBlockCybMa3Slope)) ? Number(position.keyBlockCybMa3Slope) : null;
  const gatePassedC3 = !hasKeyBlockGateC3 || (gateSlopeC3 !== null && gateSlopeC3 > 0);
  let condition3;
  if (!gatePassedC3) {
    condition3 = {
      name: '科技板块情绪退潮',
      satisfied: false,
      detail: gateSlopeC3 === null
        ? '创业板指 3 日线斜率数据不足，无法判定生效门禁，本条件当日不参与卖出判定'
        : `创业板指 3 日线斜率 ${gateSlopeC3.toFixed(2)} ≤ 0，本条件当日不参与卖出判定（门禁：斜率为正时科技板块情绪退潮才生效）`,
      subConditions: [
        { label: '创业板指3日线斜率', value: gateSlopeC3 === null ? '--' : gateSlopeC3.toFixed(2) },
        { label: '门禁规则', value: '斜率 > 0 时本条件生效' },
      ],
    };
  } else {
    const isCondition3RawTrue = techCrash && downStocksCount >= 5;
    const cond3Persist = isCondition3RawTrue
      ? checkCondition3Persist(timeBuckets, currentIndex)
      : { satisfied: false, checkedMin: 0 };
    condition3 = {
      name: '科技板块情绪退潮',
      satisfied: cond3Persist.satisfied,
      pending: isCondition3RawTrue && !cond3Persist.satisfied,
      pendingMinutes: isCondition3RawTrue ? cond3Persist.checkedMin : 0,
      detail: techCrash && downStocksCount >= 5
        ? `科技情绪指数 = -100 且自选股中跌幅<-9%的个股 ${downStocksCount} 个（>=5），市场触底${!cond3Persist.satisfied ? `（已持续 ${cond3Persist.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）` : ''}`
        : techCrash
          ? `科技情绪指数 = -100，但自选股中跌幅<-9%的个股仅 ${downStocksCount} 个（<5），未触发`
          : techEmotion !== null
            ? `科技情绪指数 ${techEmotion.toFixed(2)}，未达到 -100（需 = -100 且自选股中跌幅<-9%个股 >=5 才触发）`
            : '当日科技情绪数据暂无',
      subConditions: [],
    };
  }
  if (hasKeyBlockGateC3) {
    condition3.subConditions = [
      ...(condition3.subConditions || []),
      {
        label: '创业板指3日线斜率门禁',
        value: gatePassedC3
          ? `${gateSlopeC3 > 0 ? '+' : ''}${gateSlopeC3.toFixed(2)}（>0，本条件生效）`
          : (gateSlopeC3 === null ? '数据不足，本条件不生效' : `${gateSlopeC3.toFixed(2)}（≤0，本条件不生效）`),
      },
    ];
  }

  // ===== 条件4：抗分歧指数 < 6 且 当前涨幅 ≤ -5%（14:50后生效） =====
  const isSh688 = String(code).toLowerCase().startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const indexPoints = getTlinePoints(replayStocks, indexCode, minute);
  let resilienceScore = null;
  if (stockPoints.length >= 5 && indexPoints.length >= 5) {
    const raw = calculateReplayResilience(stockPoints, indexPoints, code);
    if (raw != null) resilienceScore = parseFloat(raw.toFixed(2));
  }
  const isResilienceWeak = resilienceScore !== null && resilienceScore < 6;
  const isFalling = change !== null && change <= -5;
  const isAfter1450 = minute != null && minute >= 1450;
  const condition4 = {
    name: '抗分歧指数弱势',
    satisfied: isResilienceWeak && isFalling && isAfter1450,
    detail: resilienceScore === null
      ? '分时数据不足，无法计算抗分歧指数'
      : !isAfter1450
        ? `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，但当前时间未到 14:50，条件暂不生效`
        : isResilienceWeak && isFalling
          ? `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，个股抗跌性弱且正在下跌`
          : !isResilienceWeak
            ? `抗分歧指数 ${resilienceScore.toFixed(2)} ≥ 6，个股抗跌性尚可，未触发`
            : `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，但涨幅 ${change.toFixed(2)}% > -5%，未触发`,
    subConditions: [],
  };

  // ===== 条件5：连续三日（含当日）抗分歧指数均 < 10（个股连续弱势，资金持续分歧），仅 9:40 后生效 =====
  // 前两日用预计算的全天分数（resilience3dScores 前 2 位，历史数据）；当日为实时口径：
  // 用当日分钟级分时截至当前评估分钟现算，避免使用收盘后才能得到的未来数据（与线上 checkSellPointDetailed 当日口径一致）。
  // 预计算的收盘口径标志 resilience3dAllBelow10 仅供策略选股（extractDailyInfo 取 scores[2]），不再用于本条件
  const r3dScores = Array.isArray(stock?.resilience3dScores) ? stock.resilience3dScores : [];
  const prev1C5 = r3dScores.length > 0 ? r3dScores[0] : null;
  const prev2C5 = r3dScores.length > 1 ? r3dScores[1] : null;
  const prevOkC5 = prev1C5 != null && prev2C5 != null && prev1C5 < 10 && prev2C5 < 10;
  const isAfter940C5 = minute != null && minute >= 940;
  let todayScoreC5 = null;
  if (dateStr && minute != null) {
    try {
      const indexCodeC5 = String(code).startsWith('sh688') ? 'sh000688' : 'sz399006';
      const dateNumC5 = parseInt(dateStr, 10);
      const [stockTlineC5, indexTlineC5] = await Promise.all([
        getSingleStockTlineDataByDate(code, dateNumC5),
        getSingleStockTlineDataByDate(indexCodeC5, dateNumC5),
      ]);
      const stockLineC5 = (stockTlineC5?.line || []).filter(p => p && p.minute != null && parseInt(p.minute) <= minute);
      const indexLineC5 = (indexTlineC5?.line || []).filter(p => p && p.minute != null && parseInt(p.minute) <= minute);
      if (stockLineC5.length >= 5 && indexLineC5.length >= 5) {
        todayScoreC5 = parseFloat(calculateResilience(indexLineC5, stockLineC5, getLimitTypeByCode(code)).toFixed(2));
      }
    } catch (e) { /* 当日分时数据不足，视为无法判断 */ }
  }
  const allBelow10C5 = prevOkC5 && todayScoreC5 != null && todayScoreC5 < 10;
  const fmtMinuteC5 = minute != null ? `${String(Math.floor(minute / 100)).padStart(2, '0')}:${String(minute % 100).padStart(2, '0')}` : '--';
  const prevDisplayC5 = [prev1C5, prev2C5].map(s => (s != null ? Number(s).toFixed(2) : '--')).join('、');
  const todayDisplayC5 = todayScoreC5 != null ? todayScoreC5.toFixed(2) : '--';
  const condition5 = {
    name: '连续三日抗分歧弱势',
    satisfied: allBelow10C5 && isAfter940C5,
    detail: !prevOkC5
      ? `前两日抗分歧指数未全部 < 10（${prevDisplayC5}）或历史数据不足，无法判断连续三日弱势`
      : !isAfter940C5
        ? `前两日抗分歧指数均 < 10（${prevDisplayC5}），当日实时 ${todayDisplayC5}，但当前时间未到 9:40，条件暂不生效`
        : !allBelow10C5
          ? (todayScoreC5 == null
            ? `当日实时抗分歧分数数据不足（截至 ${fmtMinuteC5}），未触发`
            : `前两日均 < 10（${prevDisplayC5}），但当日实时 ${todayDisplayC5} ≥ 10（截至 ${fmtMinuteC5}），未触发`)
          : `前两日抗分歧指数均 < 10（${prevDisplayC5}），当日实时 ${todayDisplayC5} < 10（截至 ${fmtMinuteC5}），个股连续弱势，触发卖点`,
    subConditions: [
      { label: '前两日抗分歧（全天）', value: prevDisplayC5 },
      { label: '当日实时抗分歧', value: `${todayDisplayC5}（截至 ${fmtMinuteC5}）` },
      { label: '当前时间', value: fmtMinuteC5 },
      { label: '生效时间', value: '9:40 后' },
      { label: '阈值', value: '连续3日均 < 10' },
    ],
  };

  // ===== 条件6：现价跌破最迟一天买入（买入日 buyDate）当日的最低点 —— 需持续 ≥5 分钟 =====
  const lastBuyDayRaw = String(position?.buyDate || '').replace(/-/g, '');
  let condition6 = {
    name: '跌破最迟买入日低点',
    satisfied: false,
    pending: false,
    pendingMinutes: 0,
    detail: '',
    subConditions: [],
  };
  const stockEntry6 = (replayStocks || []).find(s => s.code === code);
  const dailyLowMap = stockEntry6?.dailyLowMap || {};
  if (!lastBuyDayRaw) {
    condition6.detail = '该模拟持仓无买入日期，无法判断最迟买入日低点';
    condition6.subConditions = [{ label: '状态', value: '无买入日期' }];
  } else {
    const buyDayLowRaw = dailyLowMap[parseInt(lastBuyDayRaw)];
    const buyDayLow = buyDayLowRaw != null ? toNumber(buyDayLowRaw) : null;
    if (buyDayLow === null || buyDayLow <= 0) {
      condition6.detail = `最迟买入日 ${lastBuyDayRaw} 无日K线最低价数据，无法判断`;
      condition6.subConditions = [{ label: '状态', value: '无K线数据' }];
    } else {
      const brokenBuyDayLow = closePrice < buyDayLow;
      const persist6 = brokenBuyDayLow
        ? checkBuyDayLowPersist(replayStocks, code, minute, buyDayLow)
        : { satisfied: false, checkedMin: 0 };
      condition6.satisfied = persist6.satisfied;
      condition6.pending = brokenBuyDayLow && !persist6.satisfied;
      condition6.pendingMinutes = brokenBuyDayLow ? persist6.checkedMin : 0;
      condition6.detail = brokenBuyDayLow
        ? `现价 ${closePrice.toFixed(2)} 已跌破最迟买入日（${lastBuyDayRaw}）最低价 ${buyDayLow.toFixed(2)}，买入成本线告破${condition6.pending ? `（已持续 ${persist6.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟才触发）` : ''}`
        : `现价 ${closePrice.toFixed(2)} 未跌破最迟买入日（${lastBuyDayRaw}）最低价 ${buyDayLow.toFixed(2)}，暂不触发`;
      condition6.subConditions = [
        { label: '最迟买入日', value: lastBuyDayRaw },
        { label: '买入日最低价', value: buyDayLow.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
      ];
    }
  }

  // ===== 条件7：现价跌破持仓成本线 -2%（即时触发，无需持续分钟；成本线 = 模拟持仓买入价 buyPrice） =====
  // 阈值可按持仓覆盖（position.costLinePct，百分比数值，默认 2）
  const costLinePct = position?.costLinePct != null && Number.isFinite(Number(position.costLinePct)) ? Number(position.costLinePct) : 2;
  const costLineRatio = 1 - costLinePct / 100;
  const costLineThreshold = buyPrice !== null && buyPrice > 0 ? buyPrice * costLineRatio : null;
  const brokenCostLine = costLineThreshold !== null && closePrice < costLineThreshold;
  const condition7 = {
    name: `跌破成本线-${costLinePct}%`,
    satisfied: brokenCostLine,
    detail: costLineThreshold === null
      ? `该模拟持仓无买入价格，无法判断是否跌破成本线 -${costLinePct}%`
      : brokenCostLine
        ? `现价 ${closePrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），触发卖点`
        : `现价 ${closePrice.toFixed(2)} 未跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），未触发`,
    subConditions: [
      { label: '买入价（成本线）', value: buyPrice !== null && buyPrice > 0 ? buyPrice.toFixed(2) : '--' },
      { label: `阈值（成本价-${costLinePct}%）`, value: costLineThreshold !== null ? costLineThreshold.toFixed(2) : '--' },
      { label: '现价', value: closePrice.toFixed(2) },
      { label: '判断规则', value: `现价 < 成本价 × ${costLineRatio.toFixed(2)} 即触发` },
    ],
  };

  const conditions = [condition1, condition2, condition3, condition4, condition5, condition6, condition7];
  const satisfiedCount = conditions.filter(c => c.satisfied).length;
  const isSell = satisfiedCount > 0;
  const returnRate = buyPrice !== null && buyPrice > 0
    ? parseFloat((((closePrice - buyPrice) / buyPrice) * 100).toFixed(2))
    : null;

  return {
    isSell,
    code,
    stockName,
    closePrice: parseFloat(closePrice.toFixed(2)),
    change: change !== null ? parseFloat(change.toFixed(2)) : null,
    returnRate,
    dayHigh: dayHigh > 0 ? parseFloat(dayHigh.toFixed(2)) : null,
    techEmotion,
    resilienceScore,
    conditions,
    conclusion: isSell
      ? `共触发 ${satisfiedCount} 个卖出条件（${conditions.filter(c => c.satisfied).map(c => c.name).join('、')}），建议卖出离场`
      : '所有卖出条件均未触发，当前可继续持有',
    displayTime,
  };
};

// ============================================================
// 回放股票结构构建（对齐 trainingCamp/index.jsx 中 replayStocks 的 useMemo 构建逻辑，全量时间桶）
// ============================================================
const buildReplayStocks = (campData) => {
  const timeBuckets = campData?.timeBuckets || [];
  const stockMap = new Map();
  const indexTline = { sh000688: [], sz399006: [] };
  const indexNames = { sh000688: '科创指数', sz399006: '创业板指数' };
  for (const bucket of timeBuckets) {
    const itl = bucket.indexTline || {};
    if (itl.kcb && itl.kcb.changePct != null) {
      indexTline.sh000688.push({ minute: bucket.minute, change: itl.kcb.changePct, lastPx: itl.kcb.price });
    }
    if (itl.cyb && itl.cyb.changePct != null) {
      indexTline.sz399006.push({ minute: bucket.minute, change: itl.cyb.changePct, lastPx: itl.cyb.price });
    }
    for (const sc of bucket.stockChanges) {
      if (!stockMap.has(sc.code)) {
        const lowByCode = campData.dailyLowByCode || {};
        stockMap.set(sc.code, { code: sc.code, stockName: sc.name, tlinePoints: [], dailyLowMap: lowByCode[sc.code] || null });
      }
      if (sc.changePct != null) {
        stockMap.get(sc.code).tlinePoints.push({ minute: bucket.minute, change: sc.changePct, lastPx: sc.lastPx });
      }
    }
  }
  Object.entries(indexTline).forEach(([code, points]) => {
    if (points.length > 0) {
      stockMap.set(code, { code, stockName: indexNames[code], isDefaultIndex: true, tlinePoints: points });
    }
  });
  return Array.from(stockMap.values()).filter(s => s.tlinePoints.length > 0);
};

// 计算某只股票截至当前 minute 的日内抗分歧分数（供单股策略选股用，与卖点诊断条件4口径一致）
const calcResilienceAtMinute = (replayStocks, code, minute) => {
  const isSh688 = String(code).toLowerCase().startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const stockPoints = getTlinePoints(replayStocks, code, minute).filter(p => p.lastPx != null && p.lastPx > 0);
  const indexPoints = getTlinePoints(replayStocks, indexCode, minute);
  if (stockPoints.length < 5 || indexPoints.length < 5) return null;
  const raw = calculateReplayResilience(stockPoints, indexPoints, code);
  return raw != null ? parseFloat(raw.toFixed(2)) : null;
};

// 从回放数据提取每个股票「当日 EOD」信息：收盘涨幅、收盘价、当日抗分歧分数
// （当日抗分歧分数取 resilience3dScores 的最后一位，即 score(当天)，与 resilience3d 口径一致）
const extractDailyInfo = (campData) => {
  const buckets = campData?.timeBuckets || [];
  const lastBucket = buckets[buckets.length - 1];
  const info = new Map();
  for (const sc of lastBucket?.stockChanges || []) {
    let resilience = null;
    if (Array.isArray(sc.resilience3dScores) && sc.resilience3dScores.length === 3) {
      const today = sc.resilience3dScores[2];
      if (today != null && !Number.isNaN(Number(today))) resilience = Number(today);
    }
    info.set(sc.code, {
      code: sc.code,
      name: sc.name || sc.code,
      changePct: sc.changePct != null ? Number(sc.changePct) : null,
      closePx: sc.lastPx != null ? Number(sc.lastPx) : null,
      resilience,
    });
  }
  return info;
};

// 窗口累计涨幅：winDates 最后一位为当日（用盘中涨幅），其余为历史 EOD 涨幅，复利相乘
const computeWindowGain = (code, winDates, dailyInfos, todayIntradayChange) => {
  let prod = 1;
  for (let i = 0; i < winDates.length; i++) {
    let ch;
    if (i === winDates.length - 1) {
      ch = todayIntradayChange != null ? Number(todayIntradayChange) : null;
    } else {
      ch = dailyInfos.get(winDates[i])?.get(code)?.changePct;
    }
    if (ch == null || !Number.isFinite(ch)) return null;
    prod *= 1 + ch / 100;
  }
  return (prod - 1) * 100;
};

// 窗口抗分歧分数汇总：winDates 最后一位为当日（用盘中分数），其余为历史 EOD 分数
const computeWindowResilience = (code, winDates, dailyInfos, todayIntradayResilience) => {
  let sum = 0;
  for (let i = 0; i < winDates.length; i++) {
    let r;
    if (i === winDates.length - 1) {
      r = todayIntradayResilience != null ? Number(todayIntradayResilience) : null;
    } else {
      r = dailyInfos.get(winDates[i])?.get(code)?.resilience;
    }
    if (r == null || !Number.isFinite(r)) return null;
    sum += r;
  }
  return sum;
};

// 抗分歧弱转强选股：取最近 4 个交易日（最后一位为当日，用盘中过滤后的抗分歧分数）每只股票的抗分歧分数，
// 先筛选出「买点触发时抗分歧分数 > 11」的股票，再从中计算「前两天均值」与「后两天均值」（第 3 天+当日，即最近两天）的差值
// diff = 后两天均值 - 前两天均值。diff 越大代表抗分歧由弱转强越明显，选 diff 最大的一只；diff 相同（弱转强过程一致）时，取当日盘中涨幅最大的一只。
const pickWeakToStrongStock = (bucket, rangeDates, di, replayStocks, dailyInfos) => {
  const winDates = rangeDates.slice(Math.max(0, di - 3), di + 1); // 最近 4 个交易日
  if (winDates.length < 4) return null; // 4 日窗口不足，不构成弱转强
  let best = null; // { sc, diff, gain }
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!isStockInWatchlistAt(sc.code, rangeDates[di], bucket.minute)) continue;
    const scores = [];
    for (let i = 0; i < winDates.length; i++) {
      let r;
      if (i === winDates.length - 1) {
        // 当日：用当前分钟的日内抗分歧分数
        r = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      } else {
        r = dailyInfos.get(winDates[i])?.get(sc.code)?.resilience;
      }
      if (r == null || !Number.isFinite(r)) {
        scores.length = 0;
        break;
      }
      scores.push(Number(r));
    }
    if (scores.length < 4) continue;
    if (!(scores[3] > 11)) continue; // 买点触发时当日抗分歧分数需 > 11 才参与弱转强优选
    const first2Avg = (scores[0] + scores[1]) / 2; // 前两天均值
    const last2Avg = (scores[2] + scores[3]) / 2; // 最近两天均值（含当日）
    const diff = last2Avg - first2Avg;
    const gain = sc.changePct != null ? Number(sc.changePct) : -Infinity;
    if (!best || diff > best.diff + 1e-9 || (Math.abs(diff - best.diff) <= 1e-9 && gain > best.gain)) {
      best = { sc, diff, gain };
    }
  }
  if (!best) return null;
  return { stock: best.sc, metric: parseFloat(best.diff.toFixed(4)) };
};

// 计算 N 日线斜率角度：以「N 日涨幅均线」为观测线（用涨幅替代价格，消除不同股票价格差异）
// avgRet(d) = 近 N 个交易日涨幅均值，今日涨幅用当前盘中涨幅（避免未来数据），其余用历史 EOD 涨幅
// 斜率Δ（每日变化，% / 天）= avgRet(今日) - avgRet(昨日)
// 角度（度）= atan(Δ) * 180 / π；取当日角度最大（即线最陡峭）的股票买入
const computeMaSlopeAngle = (code, days, di, rangeDates, dailyInfos, todayIntradayChange) => {
  if (!days || todayIntradayChange == null || !Number.isFinite(Number(todayIntradayChange))) return null;
  if (di < days) return null; // 历史日不足，无法得到「昨日N日涨幅均线」
  // 今日N日涨幅均线 = (今日盘中涨幅 + 最近 days-1 个历史 EOD 涨幅) / days
  const todayRets = [Number(todayIntradayChange)];
  for (let i = di - 1; i >= 0 && todayRets.length < days; i--) {
    const r = dailyInfos.get(rangeDates[i])?.get(code)?.changePct;
    if (r == null || !Number.isFinite(Number(r))) return null;
    todayRets.push(Number(r));
  }
  if (todayRets.length < days) return null;
  // 昨日N日涨幅均线 = 最近 days 个历史 EOD 涨幅 / days
  const yestRets = [];
  for (let i = di - 1; i >= di - days; i--) {
    if (i < 0) return null;
    const r = dailyInfos.get(rangeDates[i])?.get(code)?.changePct;
    if (r == null || !Number.isFinite(Number(r))) return null;
    yestRets.push(Number(r));
  }
  if (yestRets.length < days) return null;
  const avgToday = todayRets.reduce((a, b) => a + b, 0) / days;
  const avgYesterday = yestRets.reduce((a, b) => a + b, 0) / days;
  if (!Number.isFinite(avgToday) || !Number.isFinite(avgYesterday)) return null;
  const delta = avgToday - avgYesterday; // 斜率（百分点 / 天）
  const angle = Math.atan(delta) * 180 / Math.PI; // 转化为角度
  return angle;
};

// ============================================================
// 三日情绪冰点系列买入环境门禁（2026-09-28 新增）：触发买点当天，候选股所跟踪指数满足其一才可买——
//   ① 往前数 5 个交易日 20 日线斜率为正：MA20(触发日) − MA20(5个交易日前) > 0（口径同 maSlope=当前MA−5日前MA）
//   ② 触发日 30 日线在 60 日线下方：MA30 < MA60
// 目的：单边阴跌中段（20日线仍下行且 30 日线未跌破 60 日线）抄底隔日无溢价，
//       仅保留「下跌末期反弹（20日线回升）」与「深跌阶段（30<60）」两类有溢价环境。
// 数据：同花顺指数日K收盘价（创业板指 sz399006 / 科创50 sh000688），MA 含触发日收盘
//      （尾盘 14:57 触发时按收盘已基本定型口径，与 EMA 命中条件一致）。
// 跟踪指数映射与抗分歧口径一致：sh688 开头跟踪科创50，其余跟踪创业板指。
// 全部候选股均不满足（或指数日K数据不足/获取失败）时当日不买入。
// ============================================================
const EMO3_GATE_INDEX_CODES = [
  { code: 'sz399006', name: '创业板指', cacheName: 'cyb_kline.json', pureCode: '399006', market: '32' },
  { code: 'sh000688', name: '科创50', cacheName: 'kcb50_kline.json', pureCode: '1B0688', market: '16' },
];
// 门禁结果缓存：key `${dateStr}_${indexCode}`（历史数据不可变，进程内缓存即可）
const emo3IndexGateCache = new Map();
const trackedIndexCodeOf = (code) => (String(code).toLowerCase().startsWith('sh688') ? 'sh000688' : 'sz399006');

const calcEmo3IndexGate = async (dateStr, indexCode) => {
  const conf = EMO3_GATE_INDEX_CODES.find(c => c.code === indexCode) || EMO3_GATE_INDEX_CODES[0];
  try {
    const kline = await loadIndexKline(conf.cacheName, conf.pureCode, conf.market, 500);
    const target = Number(dateStr);
    const bars = (kline || [])
      .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.trade_date) <= target
        && Number.isFinite(Number(k.close_px)) && Number(k.close_px) > 0)
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date))
      .map(k => Number(k.close_px));
    if (bars.length < 60) {
      // MA60 需要至少 60 根日K；数据不足按不满足处理（宁可不买）
      console.error(`三日情绪冰点指数门禁 ${conf.name} ${dateStr} 日K数据不足（${bars.length}/60 根），按不满足处理`);
      return { indexCode: conf.code, indexName: conf.name, passed: false, error: `指数日K数据不足（${bars.length}/60 根）` };
    }
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const avgLast = (period, endOffset) => {
      // bars 升序、末位为触发日；endOffset=0 取最近 period 根，=5 取截止 5 个交易日前（不含其间）的 period 根
      const arr = bars.slice(bars.length - period - endOffset, bars.length - endOffset);
      return arr.reduce((s, v) => s + v, 0) / period;
    };
    const ma20Now = r4(avgLast(20, 0));
    const ma20Prev = r4(avgLast(20, 5));
    const ma30 = r4(avgLast(30, 0));
    const ma60 = r4(avgLast(60, 0));
    const slope20 = r4(ma20Now - ma20Prev);
    const cond1 = slope20 > 0; // ① 近 5 个交易日 20 日线斜率为正
    const cond2 = ma30 < ma60; // ② 30 日线在 60 日线下方
    return { indexCode: conf.code, indexName: conf.name, passed: cond1 || cond2, cond1, cond2, slope20, ma20Now, ma20Prev, ma30, ma60 };
  } catch (e) {
    console.error(`三日情绪冰点指数门禁 ${conf.name} ${dateStr} 计算失败: ${e.message}`);
    return { indexCode: conf.code, indexName: conf.name, passed: false, error: e.message || String(e) };
  }
};

// 按日预计算两只跟踪指数的门禁结果（仅三日情绪冰点策略需要；pickBestStock 内同步查表过滤候选）
const ensureEmo3DayGates = async (dateStr) => {
  await Promise.all(EMO3_GATE_INDEX_CODES.map(async ({ code }) => {
    const key = `${dateStr}_${code}`;
    if (emo3IndexGateCache.has(key)) return;
    emo3IndexGateCache.set(key, await calcEmo3IndexGate(dateStr, code));
  }));
};

// 门禁命中的买入条件明细项（展示命中了哪个条件与具体数值，随 buyChecks 持久化到成交记录）
const buildEmo3GateCheck = (gate) => {
  const fmt = (v) => (v > 0 ? `+${v}` : `${v}`);
  const cond1Text = `近5个交易日20日线斜率为正（MA20 ${gate.ma20Now}，5个交易日前 ${gate.ma20Prev}，斜率 ${fmt(gate.slope20)}）`;
  const cond2Text = `30日线在60日线下方（MA30 ${gate.ma30} < MA60 ${gate.ma60}）`;
  return {
    id: 'emo3_index_gate',
    title: `跟踪指数环境门禁（${gate.indexName}，满足其一）`,
    passed: true,
    value: gate.cond1 ? `20日线斜率 ${fmt(gate.slope20)}` : `MA30 ${gate.ma30} < MA60 ${gate.ma60}`,
    reason: `①${cond1Text}；②${cond2Text}；两个条件满足其一才允许尾盘抄底买入，当前${gate.cond1 ? '命中①' : '命中②'}`,
  };
};

// 单股策略选股：在买点命中的当前时间桶，按策略指标选择最优的一只股票。
// 抗分歧>11 顺延门槛仅对 RESILIENCE_GATE_STRATEGY_IDS（买入最高涨幅/2日涨幅最大）启用：
// 排名首位不满足则按策略排名依次顺延至下一只满足的股票，skipped 记录被顺延跳过的前序股票（供买入明细标注）；
// 其余策略不做抗分歧校验，直接取排名指定名次的第一只
const pickBestStock = (stocks, rangeDates, di, bucket, replayStocks, dailyInfos, strategyId) => {
  const isReportStrategy = strategyId.includes('reports');
  const isTop5ReportGainMode = strategyId.includes('reports_top5_gain'); // 研报覆盖前五（含覆盖数相同）中取窗口涨幅最大
  const isPureReportMode = isReportStrategy && !isTop5ReportGainMode; // 研报覆盖数最多/第二多
  const isMaSlopeMode = strategyId.includes('ma_slope'); // 均线斜率最陡峭（3日/5日）
  const useSecond = strategyId.includes('_2nd');
  // 尾盘抄底反向选股：跌幅最大/抗分歧分数最低（取窗口指标最小值而非最大值）
  const lowMode = strategyId.includes('_fall') || strategyId.includes('_resilience_low');
  const dayMatch = strategyId.match(/(\d+)d/);
  const days = dayMatch ? Number(dayMatch[1]) : null;
  // 三日情绪冰点 1d 系列决胜规则：主指标（当日涨幅/跌幅/抗分歧分数）相同时，
  // 按最近 2 个交易日窗口的同向指标决胜（如当日涨幅相同取最近 2 日累计涨幅更大的一只）
  const isEmo3Tiebreak = /^tail_dip_emo3_1d_(gain|fall|resilience)$/.test(strategyId);
  const tiebreakWinDates = isEmo3Tiebreak ? rangeDates.slice(Math.max(0, di - 1), di + 1) : null;
  // 三日情绪冰点系列：候选股按各自跟踪指数的当日环境门禁过滤（满足其一才可买，结果由 ensureEmo3DayGates 按日预计算）
  const isEmo3GateStrategy = /^tail_dip_emo3_/.test(strategyId);

  // 抗分歧弱转强：使用独立的 5 日窗口弱转强选股逻辑（已内置「当日分数 > 11 参与优选」门槛）
  if (strategyId === 'resilience_weak_to_strong') {
    return pickWeakToStrongStock(bucket, rangeDates, di, replayStocks, dailyInfos);
  }

  // 涨幅/抗分歧窗口按 days 天
  let winDates;
  if (strategyId === 'highest_gain') {
    winDates = rangeDates.slice(0, di + 1); // 回测起始日至当日
  } else if (days) {
    winDates = rangeDates.slice(Math.max(0, di - days + 1), di + 1);
  } else {
    winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  }
  // 研报覆盖窗口与涨幅/抗分歧窗口一致（按对应 3 天/5 天统计）
  let reportWinDates = null;
  if (isReportStrategy && days) {
    reportWinDates = winDates;
  }
  // 跌幅最大（_fall）与涨幅共用窗口涨幅指标，仅取最小值；其余照旧
  const gainMode = strategyId === 'highest_gain' || strategyId.includes('_gain') || strategyId.includes('_fall');
  // 抗分歧门槛策略（买入最高涨幅/2日涨幅最大）：选股排序依据 = 买点触发时点当日盘中涨幅（用户定义，
  // 非窗口累计涨幅），从高到低排序后从最高者起依次用触发时点抗分歧分数>11 过滤
  const gateEnabled = RESILIENCE_GATE_STRATEGY_IDS.has(strategyId);

  // 收集全部候选（与原 best/second 口径一致：按指标值排序，同值保持自选股原顺序）
  const candidates = [];
  const top5Candidates = isTop5ReportGainMode ? [] : null;
  const reportIndex = isReportStrategy ? loadReportIndex() : null;
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (stocks.has(sc.code) && stocks.get(sc.code).holding) continue;
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!isStockInWatchlistAt(sc.code, rangeDates[di], bucket.minute)) continue;
    if (isEmo3GateStrategy) {
      // 三日情绪冰点：跟踪指数环境门禁（当日满足其一才可买；未预计算/数据不足按不满足处理）
      const gate = emo3IndexGateCache.get(`${rangeDates[di]}_${trackedIndexCodeOf(sc.code)}`);
      if (!gate || gate.passed !== true) continue;
    }
    if (gateEnabled) {
      // 门槛策略：按触发时点当日盘中涨幅排序（如买点触发在 13:10，即看 13:10 时谁的涨幅最大）
      const chg = sc.changePct != null ? Number(sc.changePct) : null;
      if (chg == null || !Number.isFinite(chg)) continue;
      candidates.push({ sc, val: chg, metric: parseFloat(chg.toFixed(4)) });
      continue;
    }
    let val;
    let val2; // 三日情绪冰点 1d 系列的决胜指标（最近 2 个交易日窗口的同向指标）
    let metric = null;
    if (isMaSlopeMode) {
      // 涨幅均线斜率角度：用当前盘中涨幅作为"今日涨幅均线"的今日成分，避免未来数据
      const angle = computeMaSlopeAngle(sc.code, days, di, rangeDates, dailyInfos, Number(sc.changePct));
      if (angle == null || !Number.isFinite(angle)) continue;
      val = angle;
      metric = parseFloat(angle.toFixed(4));
    } else if (isTop5ReportGainMode) {
      // 收集研报覆盖数与涨幅候选，事后按覆盖数取前五再按涨幅最大选股
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      top5Candidates.push({ sc, reportCount, gain });
      continue;
    }
    if (isPureReportMode) {
      // 研报覆盖数最多/第二多（按对应 days 天统计）；覆盖数相同取 days 天涨幅最大
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      val = reportCount * 100000 + gain;
      metric = reportCount;
    } else if (gainMode) {
      val = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (isEmo3Tiebreak) val2 = computeWindowGain(sc.code, tiebreakWinDates, dailyInfos, sc.changePct);
    } else {
      const intradayResilience = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      val = computeWindowResilience(sc.code, winDates, dailyInfos, intradayResilience);
      if (isEmo3Tiebreak) val2 = computeWindowResilience(sc.code, tiebreakWinDates, dailyInfos, intradayResilience);
    }
    if (val == null || !Number.isFinite(val)) continue;
    candidates.push({
      sc,
      val,
      // 决胜指标：2 日窗口数据缺失（如回测首日无昨日数据）时排到同分组末尾——
      // 降序（涨幅/抗分歧）用 -Infinity，升序（跌幅）用 +Infinity
      val2: isEmo3Tiebreak
        ? (val2 != null && Number.isFinite(val2) ? val2 : (lowMode ? Infinity : -Infinity))
        : undefined,
      metric: metric != null ? metric : parseFloat(val.toFixed(4)),
    });
  }

  // 构建策略排名序列
  let ordered; // [{ sc, metric }]
  if (isTop5ReportGainMode) {
    // 研报覆盖数降序取前五（覆盖数相同的股票全部纳入），组内按窗口涨幅降序；
    // 前五组之后按涨幅降序接在后面（仅在组内全部不满足抗分歧门槛时才会顺延到）
    if (!top5Candidates.length) return null;
    top5Candidates.sort((a, b) => b.reportCount - a.reportCount);
    const threshold = top5Candidates[Math.min(4, top5Candidates.length - 1)].reportCount;
    const topGroup = top5Candidates.filter(c => c.reportCount >= threshold).sort((a, b) => b.gain - a.gain);
    const restGroup = top5Candidates.filter(c => c.reportCount < threshold).sort((a, b) => b.gain - a.gain);
    ordered = topGroup.concat(restGroup).map(c => ({ sc: c.sc, metric: c.reportCount }));
  } else {
    ordered = candidates.slice().sort((a, b) => {
      const primary = lowMode ? a.val - b.val : b.val - a.val;
      if (primary !== 0 || a.val2 === undefined) return primary;
      // 主指标（当日指标）相同时按最近 2 日窗口指标决胜；双方均缺失（±Infinity 相等）保持自选股原顺序
      if (a.val2 === b.val2) return 0;
      return lowMode ? a.val2 - b.val2 : b.val2 - a.val2;
    }).map(c => ({ sc: c.sc, metric: c.metric }));
  }

  // 抗分歧>11 门槛：门槛策略从涨幅最高者起向后找第一只满足的股票；其余策略不做校验，
  // 直接取策略排名指定名次的第一只（与原逻辑一致）
  const skipped = []; // 因分数≤11（或无法计算）被顺延跳过的前序股票（仅门槛策略使用）
  for (let i = useSecond ? 1 : 0; i < ordered.length; i++) {
    const cand = ordered[i];
    if (gateEnabled) {
      const score = calcResilienceAtMinute(replayStocks, cand.sc.code, bucket.minute);
      if (score != null && score > RESILIENCE_GATE_MIN) {
        return { stock: cand.sc, metric: cand.metric, resilienceScore: score, skipped };
      }
      skipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时间点涨幅（即排序依据）
        resilience: score,
      });
    } else {
      return {
        stock: cand.sc,
        metric: cand.metric,
        // 三日情绪冰点：附带命中的跟踪指数环境门禁明细（withResilienceGateInfo 会追加到买入条件明细）
        emo3Gate: isEmo3GateStrategy
          ? emo3IndexGateCache.get(`${rangeDates[di]}_${trackedIndexCodeOf(cand.sc.code)}`)
          : undefined,
      };
    }
  }
  return null; // 门槛策略：全部候选均不满足门槛，不买入；其余策略：无候选
};

// ============================================================
// 买入条件明细中的选股顺延标注（抗分歧>11 门槛）
// ============================================================
// 抗分歧门槛明细项（passed 恒为 true：能入选即代表满足门槛），reason 标明是否因前序股票分数≤11 而顺延
const buildResilienceGateCheck = (resilienceScore, skipped) => {
  const fmtChangePct = v => (v != null ? `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '无法计算');
  const skippedStocks = (skipped || []).map(s => ({
    code: s.code,
    name: s.name,
    change: s.change != null ? Number(s.change) : null, // 触发时间点涨幅（即排序依据）
    resilience: s.resilience,
  }));
  const skipText = skippedStocks.map(s => `${s.name}（触发时涨幅 ${fmtChangePct(s.change)}、抗分歧 ${s.resilience != null ? s.resilience : '无法计算'}）`).join('、');
  return {
    id: 'resilience_gate',
    title: '触发时点抗分歧分数>11',
    passed: true,
    value: resilienceScore != null ? `${resilienceScore}` : '--',
    skippedStocks, // 结构化顺延明细（前端抽屉/报告悬停展示为表格）
    reason: skipped && skipped.length > 0
      ? `因前序股票 ${skipText} 触发时点抗分歧分数≤11 依次顺延，轮到本股买入（本股触发时点抗分歧分数 ${resilienceScore}）`
      : `按策略指定名次直接满足，未发生顺延（触发时点抗分歧分数 ${resilienceScore}）`,
  };
};

// 将选股顺延信息追加到买入原因/明细：发生顺延时在 buyReason 尾部标注，buyChecks 追加 resilience_gate 明细项。
// 仅 RESILIENCE_GATE_STRATEGY_IDS 两个策略的选股结果带 resilienceScore/skipped，其余策略（含抗分歧弱转强）
// 返回结构不含该字段，此处自动跳过标注（买入原因/明细保持原样）；
// 三日情绪冰点策略的选股结果带 emo3Gate（跟踪指数环境门禁命中明细），追加 emo3_index_gate 明细项
const withResilienceGateInfo = (buyInfo, picked) => {
  if (!buyInfo || !picked) return buyInfo;
  if (picked.resilienceScore == null && !picked.emo3Gate) return buyInfo;
  let buyReason = buyInfo.buyReason;
  const buyChecks = [...(buyInfo.buyChecks || [])];
  if (picked.resilienceScore != null) {
    buyReason = picked.skipped && picked.skipped.length > 0
      ? `${buyInfo.buyReason}（因前序股票抗分歧≤11顺延买入）`
      : buyInfo.buyReason;
    buyChecks.push(buildResilienceGateCheck(picked.resilienceScore, picked.skipped));
  }
  if (picked.emo3Gate) {
    buyChecks.push(buildEmo3GateCheck(picked.emo3Gate));
  }
  return { buyReason, buyChecks };
};

// ============================================================
// 三日涨幅四份仓位策略选股：买点命中时取最近 3 个交易日涨幅排名前 4 的股票（各占 1/4）
// ============================================================
const pickQuarterStocks = (bucket, rangeDates, di, dailyInfos, heldCodes) => {
  const winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  const candidates = [];
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (heldCodes.has(sc.code)) continue;
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!isStockInWatchlistAt(sc.code, rangeDates[di], bucket.minute)) continue;
    const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
    if (gain == null || !Number.isFinite(gain)) continue;
    candidates.push({ sc, gain });
  }
  candidates.sort((a, b) => b.gain - a.gain);
  return candidates.slice(0, 4);
};

// ============================================================
// 三日涨幅两个股票策略选股：按空仓份数取最近 3 个交易日涨幅排名靠前的股票
//   needCount=2：两份均空仓，买入涨幅最大与第二大（各 1/2）
//   needCount=1：仅一份空仓，只买入涨幅最大的一只（排除已持仓）
// ============================================================
const pickTwoStocks = (bucket, rangeDates, di, dailyInfos, heldCodes, needCount) => {
  const winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  const candidates = [];
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (heldCodes.has(sc.code)) continue;
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!isStockInWatchlistAt(sc.code, rangeDates[di], bucket.minute)) continue;
    const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
    if (gain == null || !Number.isFinite(gain)) continue;
    candidates.push({ sc, gain });
  }
  candidates.sort((a, b) => b.gain - a.gain);
  return candidates.slice(0, needCount).map(c => ({ sc: c.sc, gain: c.gain }));
};

// ============================================================
// 三日涨幅四份仓位回测主循环：
//   买点触发且彻底空仓时把仓位分成四份，买入三日涨幅排名前四的股票（各 1/4）。
//   任一只触发卖点即独立卖出；仅当四份全部清仓后才允许下一次买点重新四份建仓。
//   结果结构兼容单股策略（type: 'single'：trades 为每份独立卖出成交，currentHolding 为期末首笔持仓）。
// ============================================================
const runQuarterBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  const strategy = STRATEGIES[strategyId];

  let positions = []; // 最多 4 份持仓：{ code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
  const trades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息与回测期间出现过的自选股
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 卖出：对每只持仓独立诊断，任一只触发卖点即独立卖出（同日买入不可同日卖出）
    const soldCodes = new Set();
    for (const pos of positions) {
      if (soldCodes.has(pos.code)) continue;
      if (dateStr <= pos.buyDate) continue;
      const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate };
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
        if (result.isSell && result.closePrice != null) {
          const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
          trades.push({
            seq: trades.length + 1,
            metric: pos.metric,
            code: pos.code,
            stockName: pos.stockName,
            buyDate: pos.buyDate,
            buyDateDisplay: pos.buyDateDisplay,
            buyTime: pos.buyTime,
            buyPrice: pos.buyPrice,
            buyChange: pos.buyChange,
            buyReason: pos.buyReason,
            buyChecks: pos.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: result.displayTime,
            sellPrice: result.closePrice,
            sellChange: result.change,
            sellReason: satisfiedNames || '卖出条件触发',
            returnRate: result.returnRate,
          });
          soldCodes.add(pos.code);
          break;
        }
      }
    }
    positions = positions.filter(p => !soldCodes.has(p.code));

    // 买入：仅当四份全部清仓（彻底空仓）时，买点触发才重新四份建仓
    if (positions.length === 0) {
      const heldCodes = new Set();
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const buyResult = runBuyPointDiagnosis(timeBuckets, bi, campData);
        if (buyResult?.data?.allPassed === true) {
          const buyInfo = buildBuyReasonFromDiag(buyResult.data);
          const buyTime = fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM
          const picks = pickQuarterStocks(bucket, rangeDates, di, dailyInfos, heldCodes);
          for (const pick of picks) {
            const sc = pick.sc;
            positions.push({
              code: sc.code,
              stockName: sc.name || sc.code,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime,
              buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
              buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
              metric: parseFloat(pick.gain.toFixed(4)),
              buyReason: buyInfo.buyReason,
              buyChecks: buyInfo.buyChecks,
            });
            heldCodes.add(sc.code);
          }
          break; // 同一个买点触发仅建仓一次（四份）
        }
      }
    }
  }

  // 组装结果：整体收益率按仓位权重计算（每份仓位占总额的 1/4，单笔收益率 × 0.25 后加总）。
  // 期末仍有多份持仓时，整体收益率计入相应权重，展示取首笔持仓
  const QUARTER_WEIGHT = 0.25; // 每份仓位权重（四份均分）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) {
      overallReturn += QUARTER_WEIGHT * t.returnRate;
    }
  }
  let holding = null;
  if (positions.length > 0) {
    const first = positions[0];
    holding = { ...first };
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(first.code);
      if (info && info.closePx != null && info.closePx > 0) {
        holding.buyReturn = first.buyPrice > 0
          ? parseFloat((((info.closePx - first.buyPrice) / first.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) {
      overallReturn += QUARTER_WEIGHT * holding.buyReturn;
    }
  }
  overallReturn = parseFloat(overallReturn.toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: positions.length > 0,
    },
  };
};

// ============================================================
// 三日涨幅两个股票回测主循环：
//   仓位分成两份（各占 1/2）。两份均空仓时，买点触发买入三日涨幅最大与第二大两只股票；仅一份空仓时，买点触发只买入涨幅最大的一只。
//   任一只触发卖点即独立卖出；空仓的份数会在后续买点触发时按上述规则补仓。
//   结果结构兼容单股策略（type: 'single'：trades 为每份独立卖出成交，currentHolding 为期末首笔持仓）。
// ============================================================
const runTwoBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  const strategy = STRATEGIES[strategyId];

  let positions = []; // 最多 2 份持仓：{ code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
  const trades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息与回测期间出现过的自选股
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 卖出：对每只持仓独立诊断，任一只触发卖点即独立卖出（同日买入不可同日卖出）
    const soldCodes = new Set();
    for (const pos of positions) {
      if (soldCodes.has(pos.code)) continue;
      if (dateStr <= pos.buyDate) continue;
      const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate };
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
        if (result.isSell && result.closePrice != null) {
          const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
          trades.push({
            seq: trades.length + 1,
            metric: pos.metric,
            code: pos.code,
            stockName: pos.stockName,
            buyDate: pos.buyDate,
            buyDateDisplay: pos.buyDateDisplay,
            buyTime: pos.buyTime,
            buyPrice: pos.buyPrice,
            buyChange: pos.buyChange,
            buyReason: pos.buyReason,
            buyChecks: pos.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: result.displayTime,
            sellPrice: result.closePrice,
            sellChange: result.change,
            sellReason: satisfiedNames || '卖出条件触发',
            returnRate: result.returnRate,
          });
          soldCodes.add(pos.code);
          break;
        }
      }
    }
    positions = positions.filter(p => !soldCodes.has(p.code));

    // 买入：空仓份数按涨幅排名补仓
    //   两份均空仓（positions.length===0）→ 买入涨幅最大 + 第二大（各 1/2）
    //   仅一份空仓（positions.length===1）→ 只买入涨幅最大的一只（排除已持仓）
    const idleSlots = 2 - positions.length;
    if (idleSlots > 0) {
      const heldCodes = new Set(positions.map(p => p.code));
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const buyResult = runBuyPointDiagnosis(timeBuckets, bi, campData);
        if (buyResult?.data?.allPassed === true) {
          const buyInfo = buildBuyReasonFromDiag(buyResult.data);
          const buyTime = fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM
          const picks = pickTwoStocks(bucket, rangeDates, di, dailyInfos, heldCodes, idleSlots);
          for (const pick of picks) {
            const sc = pick.sc;
            positions.push({
              code: sc.code,
              stockName: sc.name || sc.code,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime,
              buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
              buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
              metric: parseFloat(pick.gain.toFixed(4)),
              buyReason: buyInfo.buyReason,
              buyChecks: buyInfo.buyChecks,
            });
            heldCodes.add(sc.code);
          }
          break; // 同一个买点触发仅建仓一次
        }
      }
    }
  }

  // 组装结果：整体收益率按仓位权重计算（每份仓位占总额的 1/2，单笔收益率 × 0.5 后加总）。
  // 期末仍有多份持仓时，整体收益率计入相应权重，展示取首笔持仓
  const HALF_WEIGHT = 0.5; // 每份仓位权重（两份均分）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) {
      overallReturn += HALF_WEIGHT * t.returnRate;
    }
  }
  let holding = null;
  if (positions.length > 0) {
    const first = positions[0];
    holding = { ...first };
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(first.code);
      if (info && info.closePx != null && info.closePx > 0) {
        holding.buyReturn = first.buyPrice > 0
          ? parseFloat((((info.closePx - first.buyPrice) / first.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) {
      overallReturn += HALF_WEIGHT * holding.buyReturn;
    }
  }
  overallReturn = parseFloat(overallReturn.toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: positions.length > 0,
    },
  };
};

// ============================================================
// 重点板块-N日最高涨幅系列回测（keyBlockDays: 2/3/4/5，2026-10-01 完全重构为斜率翻转状态机）
// 买卖唯一开关 = 创业板指 3 日线斜率（盘中实时口径）的正负翻转，不看资金/量能/情绪：
//   进攻（mode='offense'，买自选科技股池内 n 日涨幅最大者）：
//     买点：斜率由负转正当桶（首个翻转桶；状态不变的后续桶只在已生成入场意图但建仓失败时重试）
//     卖点：通用 7 条件卖出诊断（条件7 跌破成本线 -2%）
//     卖出后斜率仍为正 → 当日不追买；次日开盘 10 分钟后（9:40 桶）复测仍为正才继续买
//   防御（mode='defense'，买防御+中性 tag 板块内 n 日涨幅最大者）：
//     买点：斜率由正转负且当前空仓的当桶
//     卖点：斜率由负转正当桶（唯一卖点，不设成本线止损，持有至最后一刻，同桶可转手买入进攻股）
//     仓位：创业板情绪低迷期按半仓买入（weight=0.5），个股实际收益 rawReturnRate × 0.5 记入
//           returnRate / buyReturn；整体收益与平均/最大回撤均按折算后口径（2026-10-01 用户要求）
// 斜率符号跨日连续追踪（lastSlopeSign），初值取回测首日前一交易日收盘斜率；null 桶不更新基准；
// 个股日涨幅由 keyBlockData 从成分股日K现算（相邻收盘环比），不使用服务端缓存的历史涨幅数据；
// 进攻持仓的「科技板块情绪退潮」卖出条件仍受日收盘斜率 > 0 门禁，见 getKeyBlockCybMa3Slope
// ============================================================

// 非自选股持仓的合成回放数据（重点板块策略买入板块全部成分股后，卖出诊断所需的逐桶字段）。
// 自选股直接用回放数据 stockChanges；非自选股回放数据无该股，需按日合成：
//   - 逐桶 lastPx/changePct：当日分时线在桶时刻（minute ≤ 桶 minute 的最后一点）现算
//   - dailyMa5/ma5Slope/ma10/ma10Slope/prevLow：getKlineCached 日K → calcDailyMaInfo（与 trainingCamp 自选股口径一致）
//   - dailyLowMap：同上 calcDailyMaInfo（条件6 跌破买入日低点用）
//   - resilience3dScores：最近 3 个交易日（含当日）全天抗分歧分数（口径同 trainingCamp resilience3dMap）
// 返回 { replayEntry, perBucket }；当日无分时（停牌/拉取失败）返回 null（卖出诊断当日安全跳过，次日重试）
const buildKeyBlockSyntheticDay = async (code, stockName, dateStr) => {
  const dateNum = parseInt(dateStr, 10);
  let tline = null;
  try {
    tline = await getSingleStockTlineDataByDate(code, dateNum);
  } catch (e) {
    return null;
  }
  const preclose = tline?.preclose_px != null ? parseFloat(tline.preclose_px) : null;
  const sortedPoints = (tline?.line || [])
    .filter(p => p && p.minute != null && p.last_px != null)
    .map(p => ({
      minute: parseInt(p.minute),
      lastPx: parseFloat(p.last_px),
      change: preclose && preclose > 0 ? parseFloat((((parseFloat(p.last_px) - preclose) / preclose) * 100).toFixed(2)) : null,
    }))
    .filter(p => p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sortedPoints.length === 0) return null;

  // 日K衍生字段（失败降级为 null：仅影响条件1/条件6，价格类条件不受影响）
  let maInfo = { ma5: null, ma5Slope: null, ma10: null, ma10Slope: null, prevLow: null, dailyLowMap: {} };
  try {
    const calc = calcDailyMaInfo(await getKlineCached(code, dateStr), dateStr);
    if (calc) maInfo = calc;
  } catch (e) { /* 保持降级默认 */ }

  // 最近 3 个交易日（含当日）全天抗分歧分数（失败降级为空数组 → 条件5 安全不触发）
  let r3d = { allBelow10: false, scores: [], valid: false };
  try {
    const kline = await getKlineCached(code, dateStr);
    const sortedBars = [...(kline || [])]
      .filter(k => k && Number.isFinite(Number(k.trade_date)))
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const idx = sortedBars.findIndex(k => Number(k.trade_date) === dateNum);
    if (idx >= 2) {
      const last3Dates = [idx - 2, idx - 1, idx].map(i => Number(sortedBars[i].trade_date));
      const indexCode = code.startsWith('sh688') ? 'sh000688' : 'sz399006';
      const limitType = getLimitTypeByCode(code);
      const scores = [];
      let allValid = true;
      for (const d of last3Dates) {
        const [stockTline, indexTline] = await Promise.all([
          getSingleStockTlineDataByDate(code, d),
          getSingleStockTlineDataByDate(indexCode, d),
        ]);
        const stockLine = stockTline?.line || [];
        const indexLine = indexTline?.line || [];
        if (stockLine.length < 5 || indexLine.length < 5) {
          allValid = false;
          scores.push(null);
          continue;
        }
        const s = calculateResilience(indexLine, stockLine, limitType);
        scores.push(parseFloat(s.toFixed(2)));
      }
      const allBelow10 = allValid && scores.every(s => s !== null && s < 10);
      r3d = { allBelow10, scores, valid: allValid };
    }
  } catch (e) { /* 保持降级默认 */ }

  // 合成 replayStocks 条目：tlinePoints 供 dayHigh/openPrice/条件2持续/条件4实时/条件6持续；dailyLowMap 供条件6
  const replayEntry = {
    code,
    stockName: stockName || code,
    tlinePoints: sortedPoints.map(p => ({ minute: p.minute, change: p.change, lastPx: p.lastPx })),
    dailyLowMap: maInfo.dailyLowMap || {},
    isDefaultIndex: false,
  };

  // 逐桶 stockChanges 条目按需由 buildKeyBlockSyntheticBucketEntry 生成（见下）
  return { replayEntry, sortedPoints, maInfo, r3d };
};

// 由合成日数据生成某一时间桶的 stockChanges 条目（lastPx/changePct 取 minute ≤ 桶 minute 的最后一点）
const buildKeyBlockSyntheticBucketEntry = (code, stockName, sortedPoints, maInfo, r3d, bucketMinute) => {
  let atBucket = null;
  for (const p of sortedPoints) {
    if (p.minute <= bucketMinute) atBucket = p;
    else break;
  }
  if (!atBucket) return null;
  return {
    code,
    name: stockName || code,
    lastPx: atBucket.lastPx,
    changePct: atBucket.change,
    dailyMa5: maInfo.ma5 != null ? maInfo.ma5 : null,
    dailyMa5Slope: maInfo.ma5Slope != null ? maInfo.ma5Slope : null,
    dailyMa10: maInfo.ma10 != null ? maInfo.ma10 : null,
    dailyMa10Slope: maInfo.ma10Slope != null ? maInfo.ma10Slope : null,
    dailyPrevLow: maInfo.prevLow != null ? maInfo.prevLow : null,
    resilience3dAllBelow10: r3d.allBelow10 === true,
    resilience3dScores: r3d.scores || [],
    resilience3dValid: r3d.valid === true,
  };
};

// 创业板指 3 日线斜率（MA3 − 5个交易日前MA3，按当日收盘已基本定型口径，
// MA 截止口径对齐 calcEmo3IndexGate：日K过滤升序、close_px>0），用途：
//   - 卖出条件3门禁：斜率 > 0 时「科技板块情绪退潮」条件才参与进攻持仓卖出判定
//   - 斜率翻转状态机初值：回测首日前一交易日的收盘斜率符号（2026-10-01 重构）
// 盘中实时翻转判定统一走 getKeyBlockCybMa3SlopeIntraday；
// 一次拉取日K批量计算全序列（历史不可变，进程内缓存），数据不足（<8根）/获取失败返回 null
const CYB_INDEX_CONF = EMO3_GATE_INDEX_CODES.find(c => c.code === 'sz399006');
let cybMa3SlopeSeriesPromise = null;
const ensureCybMa3SlopeSeries = async () => {
  if (!cybMa3SlopeSeriesPromise) {
    cybMa3SlopeSeriesPromise = (async () => {
      const kline = await loadIndexKline(CYB_INDEX_CONF.cacheName, CYB_INDEX_CONF.pureCode, CYB_INDEX_CONF.market, 100);
      const bars = (kline || [])
        .filter(k => Number.isFinite(Number(k.trade_date)) && Number.isFinite(Number(k.close_px)) && Number(k.close_px) > 0)
        .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
      const dates = bars.map(k => Number(k.trade_date));
      const closes = bars.map(k => Number(k.close_px));
      const avgLast = (i, period) => closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
      const slopes = new Map(); // date -> slope（索引 i>=7 即至少 3+5=8 根日K才有斜率）
      for (let i = 7; i < closes.length; i++) {
        slopes.set(dates[i], parseFloat((avgLast(i, 3) - avgLast(i - 5, 3)).toFixed(4)));
      }
      return { dates, closes, slopes };
    })().catch((e) => {
      cybMa3SlopeSeriesPromise = null; // 失败允许下次重试
      throw e;
    });
  }
  return cybMa3SlopeSeriesPromise;
};

// 某交易日创业板指 3 日线斜率；目标日缺K线（数据缺日）时回退用 <= 目标日的最近交易日斜率（与旧单日版口径一致），
// 数据不足/获取失败返回 null
const getKeyBlockCybMa3Slope = async (dateStr) => {
  try {
    const { dates, slopes } = await ensureCybMa3SlopeSeries();
    const target = Number(dateStr);
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= target) {
        const s = slopes.get(dates[i]);
        return s != null ? s : null;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
};

// 创业板指当日分时缓存（进程内按日期缓存，供盘中实时斜率逐桶复用；值 null 表示当日拉取失败）
const cybTlineCache = new Map();
const getKeyBlockCybTlinePoints = async (dateStr) => {
  if (cybTlineCache.has(dateStr)) return cybTlineCache.get(dateStr);
  let points = null;
  try {
    const tline = await getSingleStockTlineDataByDate('sz399006', parseInt(dateStr, 10));
    points = (tline?.line || [])
      .filter(p => p && p.minute != null && p.last_px != null)
      .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
      .filter(p => p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
  } catch (e) {
    points = null;
  }
  if (cybTlineCache.size > 400) cybTlineCache.clear(); // 防长跑内存膨胀
  cybTlineCache.set(dateStr, points);
  return points;
};

// 盘中实时创业板指 3 日线斜率（2026-09-30 用户要求：买入/卖出不等收盘，盘中实时计算）：
//   MA3(实时) = (前第2交易日收盘 + 前第1交易日收盘 + 当日实时价) / 3
//   MA3(5个交易日前) = 前 8/7/6 交易日收盘的 3 日均值
// 与收盘口径 ensureCybMa3SlopeSeries 完全对齐（收盘后实时价=当日收盘价，两者一致）。
// minute 为 HHMM 整数；当日实时价取创业板指分时中 minute ≤ 目标分钟的最后一点。
// 数据不足（早于目标日的日K不足 7 根）/分时拉取失败/该时点前无分时 → 返回 null
const getKeyBlockCybMa3SlopeIntraday = async (dateStr, minute) => {
  try {
    const { dates, closes } = await ensureCybMa3SlopeSeries();
    const target = Number(dateStr);
    // hi = 严格早于目标日的最近交易日索引（当日收盘价由盘中实时价代替，不使用当日K线）
    let hi = -1;
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] < target) hi = i; else break;
    }
    if (hi < 6) return null; // MA3(d-5) 需要 closes[hi-6..hi-4]
    const pts = await getKeyBlockCybTlinePoints(dateStr);
    if (!pts || pts.length === 0) return null;
    let atPt = null;
    for (const p of pts) {
      if (p.minute <= Number(minute)) atPt = p; else break;
    }
    if (!atPt) return null;
    const maNow = (closes[hi - 1] + closes[hi] + atPt.lastPx) / 3;
    const maPrev = (closes[hi - 6] + closes[hi - 5] + closes[hi - 4]) / 3;
    return parseFloat((maNow - maPrev).toFixed(4));
  } catch (e) {
    return null;
  }
};

// 涨停判定（买入时点）：主板（60/00 开头）当日涨幅 > 9.5% 视为涨停；创业板（sz30）/科创板（sh68）涨幅 > 19% 视为涨停。
// 涨停股买入时不可买，只能顺延找 n 日涨幅排名的下一只
const isKeyBlockLimitUp = (code, changePct) => {
  if (changePct == null || !Number.isFinite(Number(changePct))) return false;
  const growthBoard = String(code).startsWith('sz30') || String(code).startsWith('sh68');
  return Number(changePct) > (growthBoard ? 19 : 9.5);
};

// 斜率数值格式化（带正负号，2 位小数；null 显示 --）
const fmtKeyBlockSlope = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`);

// 重点板块仓位权重：进攻（斜率为正、市场情绪好）全仓买入；防御（斜率为负、创业板情绪低迷）半仓买入。
// 防御持仓的个股实际收益率（raw）在汇总口径中按半仓折算：returnRate = rawReturnRate × 0.5，
// 整体收益率与平均/最大回撤均按折算后的收益率计算（2026-10-01 用户要求）
const KEY_BLOCK_POSITION_WEIGHT = { offense: 1, defense: 0.5 };
const KEY_BLOCK_MODE_LABEL = { offense: '进攻·全仓', defense: '防御·半仓' };

const runKeyBlockBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.keyBlockDays == null) {
    return { success: false, message: `未知重点板块策略: ${strategyId}` };
  }
  const days = Number(strategy.keyBlockDays);
  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  const blocks = getKeyBlockConstituents();
  if (blocks.size === 0) {
    return { success: false, message: '无重点板块配置（block_code.js 为空）' };
  }
  // 预拉取全部重点板块成分股日K（回测时现算板块/个股涨幅；进程内缓存，多策略/多子进程共享磁盘缓存）
  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });
  try {
    await ensureKeyBlockBars();
  } catch (e) {
    return { success: false, message: `重点板块成分股日K拉取失败: ${e.message || e}` };
  }

  let position = null; // 单股持仓（mode: 'offense' 进攻=自选科技股 / 'defense' 防御=防御+中性 tag 股）
  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }（回测期间出现过的自选股，供复制K线等使用）
  const dailyInfos = new Map(); // date -> Map<code, {changePct, closePx, resilience}>（期末持仓收益率估算用）

  // 斜率符号状态机（2026-10-01 重构：买卖只由斜率正负翻转驱动，不再按斜率正负直接分模式）：
  //   lastSlopeSign/Value：最近一个有效盘中实时斜率的符号与数值，跨日连续追踪；初值取回测首日前一交易日收盘斜率
  //   pendingEntry：空仓时的入场意图（斜率翻转事件/次日9:40复测），在后续桶持续尝试直到建仓或被反向翻转覆盖
  //   offenseBlockDate：进攻持仓卖点诊断卖出且当时斜率仍为正的交易日，当日剩余桶禁止进攻追买（次日9:40复测）
  let lastSlopeSign = null; // null | 1（正）| -1（非正）
  let lastSlopeValue = null;
  let pendingEntry = null; // null | { mode: 'offense'|'defense', trigger, fromValue, toValue }
  let offenseBlockDate = null;
  try {
    const { dates: seedDates, slopes: seedSlopes } = await ensureCybMa3SlopeSeries();
    for (let i = seedDates.length - 1; i >= 0; i--) {
      if (seedDates[i] < Number(rangeDates[0])) {
        const v = seedSlopes.get(seedDates[i]);
        if (v != null && Number.isFinite(Number(v))) {
          lastSlopeSign = v > 0 ? 1 : -1;
          lastSlopeValue = v;
        }
        break;
      }
    }
  } catch (e) { /* 无初值时首个有效斜率桶建立基准，当日不触发翻转事件 */ }

  // 候选池（每轮回测固定）：进攻 = 自选股中 isTech ≠ false 的科技股；防御 = 防御+中性 tag 板块全部成分股
  const { getMonitorStocks } = require('./monitorStock');
  const techPool = (getMonitorStocks() || [])
    .filter(s => s && s.code && s.isTech !== false && !EXCLUDED_CODES.has(s.code))
    .map(s => ({ code: s.code, name: s.name || s.code }));
  const tagBlocks = [];
  const tagMap = getKeyBlockTagMap();
  for (const [blockName, members] of blocks) {
    const tag = tagMap.get(blockName);
    if (tag && ['防御', '中性'].includes(tag)) tagBlocks.push({ blockName, tag, members });
  }

  // 按入场意图在触发桶时点选股建仓（涨停顺延、买入价取桶时点分时价）；成功建仓返回 true 并写入 position
  // trigger：slope_turn_positive（斜率由负转正=进攻）/ slope_turn_negative（由正转负且空仓=防御）/
  //          retry_next_day_940（进攻卖出后次日开盘10分钟复测仍为正）
  const openPosition = async (intent, ctx) => {
    const { mode, trigger, fromValue, toValue } = intent;
    const { dateStr, dateDisplay, dateNum, winDates, bucket, bucketMinute } = ctx;
    const isOffense = mode === 'offense';
    const allMembers = [];
    if (isOffense) {
      for (const m of techPool) allMembers.push(m);
    } else {
      for (const tb of tagBlocks) for (const m of tb.members) allMembers.push(m);
    }
    if (allMembers.length === 0) return false;
    // 候选：进攻含自选股添加时间门禁（候选来自当前自选配置，防后加股票污染历史回测）；
    // 涨停判定取该桶时点当日涨幅；买入价从当日分时线现取（minute ≤ 该桶 minute 的最后一点），停牌/无分时个股自动跳过
    const candidateList = await batchParallel(allMembers, async (m) => {
      if (EXCLUDED_CODES.has(m.code)) return null;
      if (isOffense && !isStockInWatchlistAt(m.code, dateStr, bucketMinute)) return null;
      const gain = stockWindowGain(m.code, winDates);
      if (gain == null || !Number.isFinite(gain)) return null;
      let tline = null;
      try {
        tline = await getSingleStockTlineDataByDate(m.code, dateNum);
      } catch (e) {
        return null;
      }
      const preclose = tline?.preclose_px != null ? parseFloat(tline.preclose_px) : null;
      const points = (tline?.line || [])
        .filter(p => p && p.minute != null && p.last_px != null)
        .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
        .filter(p => p.lastPx > 0 && p.minute <= bucketMinute)
        .sort((a, b) => a.minute - b.minute);
      const atBucket = points.length > 0 ? points[points.length - 1] : null;
      if (!atBucket) return null;
      const changePct = preclose && preclose > 0
        ? parseFloat((((atBucket.lastPx - preclose) / preclose) * 100).toFixed(2))
        : null;
      return { code: m.code, name: m.name || m.code, gain, lastPx: atBucket.lastPx, changePct, limitUp: isKeyBlockLimitUp(m.code, changePct) };
    }, 8);
    const candidates = candidateList.filter(Boolean);
    candidates.sort((a, b) => b.gain - a.gain); // 并列涨幅保持配置顺序（batchParallel 保序）
    const best = candidates.find(c => !c.limitUp) || null;
    if (!best) return false; // 全部候选涨停/无有效候选：调用方在后续桶继续重试

    if (!seenStocks.has(best.code)) seenStocks.set(best.code, { code: best.code, name: best.name });
    const blocksText = tagBlocks.map(tb => `${tb.blockName}[${tb.tag}]`).join('、');
    const slopeText = `${toValue > 0 ? '+' : ''}${Number(toValue).toFixed(2)}`;
    const fromText = fromValue == null ? '无（首值）' : `${fromValue > 0 ? '+' : ''}${Number(fromValue).toFixed(2)}`;
    const triggerTimeText = fmtTime(bucket.timeKey);
    const gateReasonMap = {
      slope_turn_positive: `创业板指 3 日线斜率在 ${triggerTimeText} 由负转正（${fromText} → ${slopeText}）：进攻买点触发，不看资金/量能/情绪等任何配合条件，买入自选科技股中 ${days} 日涨幅最大的一只`,
      slope_turn_negative: `创业板指 3 日线斜率在 ${triggerTimeText} 由正转负（${fromText} → ${slopeText}）且当前空仓：防御买点触发，买入防御+中性 tag 板块中 ${days} 日涨幅最大的一只`,
      retry_next_day_940: `进攻持仓按卖点诊断卖出后，卖出当时 3 日线斜率仍为正（${fromText}），当日不继续买；次日开盘 10 分钟后（${triggerTimeText}，9:40 桶）复测斜率仍为正（${slopeText}），继续买入自选科技股中 ${days} 日涨幅最大的一只`,
    };
    const modeGateCheck = {
      id: 'key_block_cyb_gate',
      title: trigger === 'retry_next_day_940'
        ? '次日开盘10分钟后斜率复测（进攻买点）'
        : `创业板指3日线斜率${isOffense ? '由负转正（进攻买点）' : '由正转负且空仓（防御买点）'}`,
      passed: true,
      value: `${triggerTimeText} ${slopeText}`,
      reason: gateReasonMap[trigger] || gateReasonMap.slope_turn_positive,
    };
    const poolCheck = isOffense ? {
      id: 'key_block_watchlist_tech',
      title: '自选科技股筛选（进攻）',
      passed: true,
      value: `${techPool.length} 只`,
      reason: `进攻候选 = 自选股（monitor_stocks.json）中 isTech ≠ false 的科技股共 ${techPool.length} 只（剔除排除股；含自选股添加时间门禁）`,
    } : {
      id: 'key_block_tag_blocks',
      title: 'Tag板块筛选（防御+中性）',
      passed: true,
      value: `${tagBlocks.length} 个板块`,
      reason: `参与选股的 tag 板块 ${tagBlocks.length} 个：${blocksText}（板块 tag 在 key_blocks 页面维护，未打 tag 的板块不参与选股）`,
    };
    const limitUpSkipped = candidates.filter(c => c.limitUp && c.gain > best.gain);
    const limitUpCheck = {
      id: 'key_block_limit_up',
      title: '涨停过滤（主板>9.5%、创业/科创>19%）',
      passed: true,
      value: limitUpSkipped.length > 0 ? `顺延 ${limitUpSkipped.length} 只` : '无涨停候选',
      reason: limitUpSkipped.length > 0
        ? `买入时点（${triggerTimeText}）涨停候选已剔除并顺延：${limitUpSkipped.map(c => (c.changePct != null ? `${c.name} +${c.changePct}%` : c.name)).join('、')}；${days} 日涨幅排名后延至 ${best.name}`
        : `买入时点候选中无涨停股（主板涨幅 >9.5%、创业板/科创板 >19% 视为涨停；涨停股不可买，顺延排名下一只）`,
    };
    const bestCheck = {
      id: 'key_block_best_stock',
      title: `${isOffense ? '自选科技股' : '防御+中性Tag板块'}内最近${days}日涨幅最大的股票`,
      passed: true,
      value: `${best.gain > 0 ? '+' : ''}${best.gain.toFixed(2)}%`,
      reason: `在${isOffense ? `自选科技股池共 ${allMembers.length} 只` : `${tagBlocks.length} 个 tag 板块共 ${allMembers.length} 只成分股`}中（有效候选 ${candidates.length} 只），按最近 ${days} 日个股涨幅之和取最大${limitUpSkipped.length > 0 ? '（涨停股顺延后）' : ''}；买入价取 ${triggerTimeText} 分时价`,
    };
    const buyReasonMap = {
      slope_turn_positive: `${triggerTimeText.substring(0, 5)}创业板指3日线斜率由负转正（${fromText}→${slopeText}），买入自选科技股池内${days}日涨幅最大的股票（进攻买点，无需资金/量能配合）`,
      slope_turn_negative: `${triggerTimeText.substring(0, 5)}创业板指3日线斜率由正转负（${fromText}→${slopeText}）且空仓，买入防御+中性tag板块内${days}日涨幅最大的股票（防御买点）`,
      retry_next_day_940: `${triggerTimeText.substring(0, 5)}开盘10分钟后复测创业板指3日线斜率仍为正（${slopeText}，卖出当时${fromText}），买入自选科技股池内${days}日涨幅最大的股票（卖点诊断卖出后次日复测继续买）`,
    };
    position = {
      code: best.code,
      stockName: best.name,
      mode: isOffense ? 'offense' : 'defense',
      buyDate: dateStr,
      buyDateDisplay: dateDisplay,
      buyTime: triggerTimeText.substring(0, 5),
      buyPrice: parseFloat(Number(best.lastPx).toFixed(2)),
      buyChange: best.changePct != null ? parseFloat(Number(best.changePct).toFixed(2)) : null,
      metric: parseFloat(best.gain.toFixed(4)),
      costLinePct: Number(strategy.costLinePct) || 2,
      buyReason: buyReasonMap[trigger] || buyReasonMap.slope_turn_positive,
      buyChecks: [modeGateCheck, poolCheck, limitUpCheck, bestCheck],
    };
    return true;
  };

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }
    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 当日隔夜持仓卖出数据预建（当日买入次日才可卖，同日买入不可同日卖出）：
    //   进攻持仓 → 通用 7 条件卖点诊断所需的日收盘斜率门禁（「科技板块情绪退潮」条件）+ 非自选股合成逐桶数据
    //   防御持仓 → 持仓股当日分时（唯一卖点 = 斜率由负转正当桶的时点价格；不设任何成本线止损）
    let sellBuckets = timeBuckets;
    let sellReplayStocks = replayStocks;
    let cybMa3SlopeForGate = null;
    let defensePoints = null;
    let defensePreclose = null;
    if (position && dateStr > position.buyDate) {
      if (position.mode === 'offense') {
        cybMa3SlopeForGate = await getKeyBlockCybMa3Slope(dateStr);
        // 非自选股持仓：回放数据无该股，为卖出诊断合成逐桶 stockChanges 与 replayStocks 条目
        // （仅浅拷贝桶并追加条目，不改动共享回放缓存；合成失败当日安全跳过，次日重试）
        const hasRealEntry = timeBuckets.some(b => (b.stockChanges || []).some(sc => sc.code === position.code));
        if (!hasRealEntry) {
          const synth = await buildKeyBlockSyntheticDay(position.code, position.stockName, dateStr);
          if (synth) {
            sellBuckets = timeBuckets.map(b => {
              const entry = buildKeyBlockSyntheticBucketEntry(position.code, position.stockName, synth.sortedPoints, synth.maInfo, synth.r3d, Number(b.minute));
              return entry ? { ...b, stockChanges: [...(b.stockChanges || []), entry] } : b;
            });
            sellReplayStocks = [...replayStocks, synth.replayEntry];
          }
        }
      } else {
        try {
          const tline = await getSingleStockTlineDataByDate(position.code, parseInt(dateStr, 10));
          defensePreclose = tline?.preclose_px != null ? parseFloat(tline.preclose_px) : null;
          defensePoints = (tline?.line || [])
            .filter(p => p && p.minute != null && p.last_px != null)
            .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
            .filter(p => p.lastPx > 0)
            .sort((a, b) => a.minute - b.minute);
        } catch (e) {
          defensePoints = null; // 分时拉取失败当日安全跳过卖出（次日重试）
        }
      }
    }

    const winDates = di + 1 >= days ? rangeDates.slice(di + 1 - days, di + 1) : [];
    const dateNum = parseInt(dateStr, 10);

    // 逐桶状态机（2026-10-01 重构）：
    //   ① 盘中实时斜率（null 桶不参与翻转识别，符号基准跨缺失桶连续）→ 识别由负转正/由正转负
    //   ② 卖出：防御持仓遇「由负转正」当桶按分时价卖出（无止损）；进攻持仓走通用 7 条件卖点诊断，
    //          卖出后斜率仍为正则当日不再追买（offenseBlockDate），挂次日 9:40 复测意图
    //   ③ 空仓时翻转事件生成入场意图：由正转负→防御（独立规则，即使刚卖出也生效）；
    //          由负转正→进攻（进攻卖出当日除外）；同桶允许先卖后买转手
    //   ④ 按意图建仓：9:40 复测意图仅在 ≥9:40 且斜率仍为正的桶执行；候选全部不可买时后续桶持续重试
    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const slopeNow = await getKeyBlockCybMa3SlopeIntraday(dateStr, bucketMinute);
      const signNow = slopeNow == null ? null : (slopeNow > 0 ? 1 : -1);
      const turnedPositive = lastSlopeSign !== null && signNow === 1 && lastSlopeSign === -1;
      const turnedNegative = lastSlopeSign !== null && signNow === -1 && lastSlopeSign === 1;

      // ===== ② 卖出（仅隔夜持仓） =====
      if (position && dateStr > position.buyDate) {
        if (position.mode === 'defense' && turnedPositive && defensePoints && defensePoints.length > 0) {
          // 防御唯一卖点：斜率由负转正的当桶，按持仓股分时价卖出（不设成本线止损，一直持仓到最后一刻）
          let atPt = null;
          for (const p of defensePoints) { if (p.minute <= bucketMinute) atPt = p; else break; }
          if (atPt) {
            const sellChange = defensePreclose && defensePreclose > 0
              ? parseFloat((((atPt.lastPx - defensePreclose) / defensePreclose) * 100).toFixed(2))
              : null;
            const rawReturnRate = position.buyPrice > 0
              ? parseFloat((((atPt.lastPx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
              : null;
            // 防御半仓折算：个股实际收益 × 0.5 才是对全仓账户的收益贡献（回撤/整体收益均按折算口径）
            const weight = KEY_BLOCK_POSITION_WEIGHT.defense;
            const returnRate = rawReturnRate != null ? parseFloat((rawReturnRate * weight).toFixed(2)) : null;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              positionMode: position.mode,
              weight,
              buyDate: position.buyDate,
              buyDateDisplay: position.buyDateDisplay,
              buyTime: position.buyTime,
              buyPrice: position.buyPrice,
              buyChange: position.buyChange,
              buyReason: position.buyReason,
              buyChecks: position.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: `${String(Math.floor(atPt.minute / 100)).padStart(2, '0')}:${String(atPt.minute % 100).padStart(2, '0')}`,
              sellPrice: parseFloat(Number(atPt.lastPx).toFixed(2)),
              sellChange,
              sellReason: `创业板指3日线斜率盘中由负转正（${fmtKeyBlockSlope(lastSlopeValue)} → ${fmtKeyBlockSlope(slopeNow)}），防御半仓持仓卖出（不设成本线止损，持有至斜率转正的最后一刻；防御为半仓买入，收益率按半仓折算）`,
              returnRate,
              rawReturnRate,
            });
            position = null;
          }
        } else if (position.mode === 'offense') {
          // 进攻卖点：通用 7 条件卖点诊断（条件7 跌破成本线 -2%；「科技板块情绪退潮」受日收盘斜率>0 门禁）
          const pos = { code: position.code, stockName: position.stockName, buyPrice: position.buyPrice, buyDate: position.buyDate, costLinePct: position.costLinePct, keyBlockCybMa3Slope: cybMa3SlopeForGate };
          const result = await runSellPointDiagnosis(pos, sellBuckets[bi], sellReplayStocks, sellBuckets, bi, dateStr);
          if (result.isSell && result.closePrice != null) {
            const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
            const weight = KEY_BLOCK_POSITION_WEIGHT.offense;
            const rawReturnRate = result.returnRate != null && Number.isFinite(Number(result.returnRate))
              ? parseFloat(Number(result.returnRate).toFixed(2))
              : result.returnRate;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              positionMode: position.mode,
              weight,
              buyDate: position.buyDate,
              buyDateDisplay: position.buyDateDisplay,
              buyTime: position.buyTime,
              buyPrice: position.buyPrice,
              buyChange: position.buyChange,
              buyReason: position.buyReason,
              buyChecks: position.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: result.displayTime,
              sellPrice: result.closePrice,
              sellChange: result.change,
              sellReason: satisfiedNames || '卖出条件触发',
              returnRate: rawReturnRate,
              rawReturnRate,
            });
            position = null;
            // 卖出后斜率仍为正：当日不再继续买，次日开盘 10 分钟后（9:40 桶）复测仍为正才再买
            // （卖出时斜率为负且本桶由正转负的情形，交由下方③的防御事件处理）
            if (signNow === 1) {
              pendingEntry = { mode: 'offense', trigger: 'retry_next_day_940', armDate: dateStr, fromValue: slopeNow, toValue: slopeNow };
              offenseBlockDate = dateStr;
            }
          }
        }
      }

      // ===== ③ 空仓时由翻转事件生成/覆盖入场意图 =====
      if (!position) {
        if (turnedNegative) {
          // 防御买点：斜率变成负数且当前空仓（独立于进攻卖出的不追买限制）
          pendingEntry = { mode: 'defense', trigger: 'slope_turn_negative', fromValue: lastSlopeValue, toValue: slopeNow };
        } else if (turnedPositive && offenseBlockDate !== dateStr) {
          // 进攻买点：斜率转为正数（防御持仓当桶卖出后的转手买入同样走这里；进攻卖出当日禁止追买）
          pendingEntry = { mode: 'offense', trigger: 'slope_turn_positive', fromValue: lastSlopeValue, toValue: slopeNow };
        }
      }

      // ===== ④ 按意图建仓（同桶先卖后买；候选全部涨停/无效时后续桶继续重试） =====
      if (!position && winDates.length === days && pendingEntry) {
        let canAttempt = true;
        if (pendingEntry.trigger === 'retry_next_day_940') {
          // 仅在卖出的次一交易日生效：9:40 前不买；斜率数据不足等后续桶；复测斜率 ≤ 0 本桶不买
          // （当日由正转负时③已把意图切为防御；卖出当日一律不执行，落实「当日不要继续买」）
          if (dateStr <= pendingEntry.armDate || bucketMinute < 940 || slopeNow == null || slopeNow <= 0) canAttempt = false;
        }
        if (canAttempt) {
          // 复测买入：明细中的斜率取复测桶当时值（fromValue 仍为卖出当时值）
          const intent = pendingEntry.trigger === 'retry_next_day_940' ? { ...pendingEntry, toValue: slopeNow } : pendingEntry;
          const opened = await openPosition(intent, { dateStr, dateDisplay, dateNum, winDates, bucket, bucketMinute });
          if (opened) pendingEntry = null;
        }
      }

      // 更新斜率符号基准（null 桶不更新，翻转识别跨缺失桶连续）
      if (signNow !== null) {
        lastSlopeSign = signNow;
        lastSlopeValue = slopeNow;
      }
    }
  }

  // 组装结果（type:'single'，结构对齐 runTwoBacktest：整体收益率 = 已卖出收益 + 期末持仓按最近收盘价估算的浮动收益）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn += t.returnRate;
  }
  let holding = null;
  if (position) {
    holding = { ...position };
    holding.weight = KEY_BLOCK_POSITION_WEIGHT[position.mode] ?? 1;
    let rawBuyReturn = null; // 期末持仓的个股实际浮盈（未折算）
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(position.code);
      if (info && info.closePx != null && info.closePx > 0) {
        rawBuyReturn = position.buyPrice > 0
          ? parseFloat((((info.closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    // 非自选股持仓（重点板块策略买入板块全部成分股）：回放数据无该股，用成分股日K收盘价兜底估值
    if (rawBuyReturn == null) {
      const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
      if (closePx != null && closePx > 0 && position.buyPrice > 0) {
        rawBuyReturn = parseFloat((((closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2));
      }
    }
    // 防御半仓持仓：浮盈同样按 0.5 折算后计入整体收益
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * holding.weight).toFixed(2)) : null;
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) {
      overallReturn += holding.buyReturn;
    }
  }
  overallReturn = parseFloat(overallReturn.toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: position != null,
    },
  };
};

// ============================================================
// 多日回测主循环
// ============================================================
const runRangeBacktest = async (startDate, endDate, strategyId = 'highest_gain', onProgress) => {
  // 情绪游资系列策略走独立回测逻辑（不依赖后端回放缓存，日期范围不受 fundSnapshot 限制）
  if (isSentimentStrategy(strategyId)) {
    return runSentimentBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 三日涨幅四份仓位策略走独立的多持仓回测逻辑
  if (strategyId === 'highest_3d_gain_quarter') {
    return runQuarterBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 三日涨幅两个股票策略走独立的多持仓回测逻辑
  if (strategyId === 'highest_3d_gain_two') {
    return runTwoBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 重点板块-N日最高涨幅系列走独立的板块驱动回测逻辑（尾盘 14:50 买入，不走大盘买点诊断）
  if (STRATEGIES[strategyId]?.keyBlockDays != null) {
    return runKeyBlockBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 三日情绪均值系列不依赖资金快照，日期序列并入 tech_index 覆盖的交易日（补上缺资金快照的日期，如 20260730）
  const strategy = STRATEGIES[strategyId];
  const allDates = strategy.emoAvgBuy === true
    ? Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    : getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  // 单股策略的持仓状态（同一时刻仅一只股票）
  let singlePosition = null; // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
  // 两次买入策略挂起的首笔半仓（买点触发当日先买 5 成，等收盘补足剩余 5 成后再建立正式持仓）
  let pendingHalfBuy = null; // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice1, buyChange1, metric, closePrice }
  const singleTrades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息：{ date: Map<code, {changePct, closePx, resilience}> }
  const dailyInfos = new Map();
  // 回测期间出现过的全部自选股（供复制K线等使用）
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: strategy.emoAvgBuy === true });
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用）
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    // 记录回测期间出现过的全部自选股（供前端复制K线等使用）
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 三日情绪冰点策略：预计算当日跟踪指数环境门禁（pickBestStock 内同步查表过滤候选，见 calcEmo3IndexGate）
    if (strategy.emoAvgBuy === true) await ensureEmo3DayGates(dateStr);

    // 三日情绪均值策略专属卖点：买入次日按竞价开盘涨幅一次性卖出（开盘涨幅为负 → 9:30 开盘卖出；
    // 开盘涨幅 ≥ 0（含 0~1%）→ 固定 10:00 卖出）。当日无该股分时数据时保持持仓、顺延至后续日期重试
    if (strategy.nextDayOpenSell === true && singlePosition && dateStr > singlePosition.buyDate) {
      const entry = (replayStocks || []).find(s => s.code === singlePosition.code);
      const pts = (entry?.tlinePoints || [])
        .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
        .sort((a, b) => a.minute - b.minute);
      if (pts.length > 0) {
        const openPt = pts[0]; // 竞价开盘 = 当日第一分钟分时点（开盘价≈集合竞价成交价）
        const openChange = openPt.change != null && !Number.isNaN(Number(openPt.change)) ? Number(openPt.change) : null;
        let sellPt;
        let sellReason;
        if (openChange != null && openChange < 0) {
          sellPt = openPt;
          sellReason = `次日竞价开盘涨幅 ${openChange.toFixed(2)}% 为负，9:30 开盘直接卖出`;
        } else {
          // 开盘涨幅 ≥ 0（含 0~1% 及无法读取开盘涨幅）：固定次日 10:00 卖出（取当日第一个 minute ≥ 1000 的分时点，未覆盖时回退当日最后一分钟）
          sellPt = pts.find(p => Number(p.minute) >= 1000) || pts[pts.length - 1];
          sellReason = openChange != null
            ? `次日竞价开盘涨幅 +${openChange.toFixed(2)}% ≥ 0，固定 10:00 卖出`
            : '次日开盘涨幅缺失，按非负口径固定 10:00 卖出';
        }
        const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
        const returnRate = singlePosition.buyPrice > 0
          ? parseFloat((((sellPrice - singlePosition.buyPrice) / singlePosition.buyPrice) * 100).toFixed(2))
          : null;
        singleTrades.push({
          seq: singleTrades.length + 1,
          metric: singlePosition.metric,
          code: singlePosition.code,
          stockName: singlePosition.stockName,
          buyDate: singlePosition.buyDate,
          buyDateDisplay: singlePosition.buyDateDisplay,
          buyTime: singlePosition.buyTime,
          buyPrice: singlePosition.buyPrice,
          buyChange: singlePosition.buyChange,
          buyReason: singlePosition.buyReason,
          buyChecks: singlePosition.buyChecks,
          sellDate: dateStr,
          sellDateDisplay: dateDisplay,
          sellTime: `${String(Math.floor(Number(sellPt.minute) / 100)).padStart(2, '0')}:${String(Number(sellPt.minute) % 100).padStart(2, '0')}`,
          sellPrice,
          sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
          sellReason,
          returnRate,
        });
        singlePosition = null;
      }
    }

    const sellPositions = async (bi) => {
      const bucket = timeBuckets[bi];
      // 单股策略：仅诊断唯一持仓（尾盘抄底策略走专属卖点）
      if (!singlePosition) return;
      if (dateStr <= singlePosition.buyDate) return;
      // 三日情绪均值策略走次日开盘专属卖点（已在桶循环前按日处理），不进入通用卖点诊断
      const position = { code: singlePosition.code, stockName: singlePosition.stockName, buyPrice: singlePosition.buyPrice, buyDate: singlePosition.buyDate, tailDipSell: strategy.tailDip === true && strategy.nextDayOpenSell !== true };
      const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
      if (result.isSell && result.closePrice != null) {
        const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
        singleTrades.push({
          seq: singleTrades.length + 1,
          metric: singlePosition.metric,
          code: singlePosition.code,
          stockName: singlePosition.stockName,
          buyDate: singlePosition.buyDate,
          buyDateDisplay: singlePosition.buyDateDisplay,
          buyTime: singlePosition.buyTime,
          buyPrice: singlePosition.buyPrice,
          buyChange: singlePosition.buyChange,
          buyReason: singlePosition.buyReason,
          buyChecks: singlePosition.buyChecks,
          sellDate: dateStr,
          sellDateDisplay: dateDisplay,
          sellTime: result.displayTime,
          sellPrice: result.closePrice,
          sellChange: result.change,
          sellReason: satisfiedNames || '卖出条件触发',
          returnRate: result.returnRate,
        });
        singlePosition = null;
      }
    };

    const isTwice = strategy.id === 'highest_3d_gain_twice'; // 两次买入策略（选股同 3 日涨幅最大，仅建仓成本计算不同）
    const lastBucket = timeBuckets[timeBuckets.length - 1]; // 用于两次买入策略的收盘补仓
    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];

      // 两次买入策略：非收盘桶上，先建立挂起的首笔半仓（买点触发当日不等收盘）
      if (isTwice && pendingHalfBuy && bucket === lastBucket) {
        const closeStock = (bucket.stockChanges || []).find(s => s.code === pendingHalfBuy.code);
        const closePrice = closeStock?.lastPx != null && closeStock.lastPx > 0 ? Number(closeStock.lastPx) : null;
        if (closePrice != null) {
          // 成本价 = (首笔半仓买入价 + 收盘补仓买入价) / 2
          const avgPrice = parseFloat(((pendingHalfBuy.buyPrice1 + closePrice) / 2).toFixed(2));
          const closeChange = closeStock.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : pendingHalfBuy.buyChange1;
          singlePosition = {
            code: pendingHalfBuy.code,
            stockName: pendingHalfBuy.stockName,
            buyDate: pendingHalfBuy.buyDate,
            buyDateDisplay: pendingHalfBuy.buyDateDisplay,
            buyTime: pendingHalfBuy.buyTime,
            buyPrice: avgPrice,
            buyChange: closeChange,
            metric: pendingHalfBuy.metric,
            buyReason: pendingHalfBuy.buyReason,
            buyChecks: pendingHalfBuy.buyChecks,
          };
        }
        pendingHalfBuy = null;
      }

      // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
      const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
      const buyHit = strategy.tailDip === true
        ? (strategy.emoAvgBuy === true ? checkEmoAvg3Hit(timeBuckets, bi, dateStr) : checkTailDipHit(timeBuckets, bi))
        : buyDiag?.allPassed === true;
      // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，三日情绪均值走专属命中原因，其余取买点诊断全部通过项汇总）
      const buyInfo = buyHit
        ? (strategy.tailDip === true ? (strategy.emoAvgBuy === true ? EMO_AVG3_BUY_INFO : TAIL_DIP_BUY_INFO) : buildBuyReasonFromDiag(buyDiag))
        : null;
      if (buyHit) {
        // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
        const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

        // 策略切换逻辑：连续切换三日涨幅
        if (strategy.id === 'highest_3d_gain_switch') {
          const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, 'highest_3d_gain');
          if (picked) {
            const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
            const sc = picked.stock;
            const buyPx = parseFloat(Number(sc.lastPx).toFixed(2));
            const buyChange = sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null;

            if (!singlePosition) {
              // 情况1：空仓，直接全仓买入
              singlePosition = {
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: buyPx,
                buyChange,
                metric: picked.metric,
                buyReason: gatedBuyInfo.buyReason,
                buyChecks: gatedBuyInfo.buyChecks,
              };
            } else if (singlePosition.code !== sc.code) {
              // 情况2：已持仓且目标股票已变，卖旧买新
              const oldStock = (bucket.stockChanges || []).find(s => s.code === singlePosition.code);
              const sellPx = oldStock?.lastPx != null && oldStock.lastPx > 0 ? parseFloat(Number(oldStock.lastPx).toFixed(2)) : buyPx;
              const sellChange = oldStock?.changePct != null ? parseFloat(Number(oldStock.changePct).toFixed(2)) : null;
              const returnRate = singlePosition.buyPrice > 0 ? parseFloat((((sellPx - singlePosition.buyPrice) / singlePosition.buyPrice) * 100).toFixed(2)) : null;

              singleTrades.push({
                seq: singleTrades.length + 1,
                metric: singlePosition.metric,
                code: singlePosition.code,
                stockName: singlePosition.stockName,
                buyDate: singlePosition.buyDate,
                buyDateDisplay: singlePosition.buyDateDisplay,
                buyTime: singlePosition.buyTime,
                buyPrice: singlePosition.buyPrice,
                buyChange: singlePosition.buyChange,
                buyReason: singlePosition.buyReason,
                buyChecks: singlePosition.buyChecks,
                sellDate: dateStr,
                sellDateDisplay: dateDisplay,
                sellTime: buyTime,
                sellPrice: sellPx,
                sellChange,
                sellReason: '策略切换：买入三日涨幅更优品种',
                returnRate,
              });

              singlePosition = {
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: buyPx,
                buyChange,
                metric: picked.metric,
                buyReason: gatedBuyInfo.buyReason,
                buyChecks: gatedBuyInfo.buyChecks,
              };
            }
          }
        } else if (!singlePosition && !pendingHalfBuy) {
          // 原有单股策略逻辑：同一时刻仅持有一只，未持仓时按指标选最优的一只买入
          const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, isTwice ? 'highest_3d_gain' : strategy.id);
          if (picked) {
            const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
            const sc = picked.stock;
            if (isTwice) {
              // 两次买入：买点触发当日先把首笔半仓挂起，留待收盘补足另 5 成
              if (bucket === lastBucket) {
                // 买点恰好在收盘桶触发：直接按收盘价一次性成交，成本价即为收盘价
                const closeStock = (bucket.stockChanges || []).find(s => s.code === sc.code);
                const closePx = closeStock?.lastPx != null && closeStock.lastPx > 0 ? parseFloat(Number(closeStock.lastPx).toFixed(2)) : parseFloat(Number(sc.lastPx).toFixed(2));
                singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: closePx,
                  buyChange: closeStock?.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : (sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null),
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              } else {
                pendingHalfBuy = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice1: parseFloat(Number(sc.lastPx).toFixed(2)),
                  buyChange1: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              }
            } else {
              singlePosition = {
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
                buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                metric: picked.metric,
                buyReason: gatedBuyInfo.buyReason,
                buyChecks: gatedBuyInfo.buyChecks,
              };
            }
          }
        }
      }

      // 卖出信号
      await sellPositions(bi);
    }

    // 两次买入策略：当日尾盘仍有挂起半仓（买点触发但收盘桶无该股报价）→ 次日自动取消，不产生持仓
    if (isTwice && pendingHalfBuy) {
      pendingHalfBuy = null;
    }
  }

  // 组装结果
  // 期末持仓：按最近一个有效日期的收盘价估算浮盈，计入整体收益
  let overallReturn = 1;
  for (const t of singleTrades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (singlePosition) {
    holding = { ...singlePosition };
    // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(singlePosition.code);
      if (info && info.closePx != null && info.closePx > 0) {
        holding.buyReturn = singlePosition.buyPrice > 0
          ? parseFloat((((info.closePx - singlePosition.buyPrice) / singlePosition.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    overallReturn *= 1 + (holding.buyReturn || 0) / 100;
  }
  overallReturn = parseFloat(((overallReturn - 1) * 100).toFixed(2));
  const validTrades = singleTrades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: singleTrades,
    currentHolding: holding,
    summary: {
      tradeCount: singleTrades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: !!holding,
    },
  };
};

// 多策略共享数据回测：外层日期、内层策略，同一天回放数据只加载一次依次喂给全部策略。
// 与 runRangeBacktest 的差异仅在于数据加载被整组策略共享（dailyInfos/seenStocks 由 campData 派生，与策略无关，可共享），
// 持仓状态与成交流水按策略独立维护，单策略结果结构与 runRangeBacktest 完全一致。
// 返回：[{ strategyId, result }]
const runRangeBacktestMulti = async (startDate, endDate, strategyIds, onProgress) => {
  const ids = (Array.isArray(strategyIds) ? strategyIds : []).filter(id => STRATEGIES[id]);
  if (ids.length === 0) return [];
  // 混合策略组拆分：情绪游资走独立回测（不依赖回放缓存，先独立跑完），其余走共享数据的原逻辑
  const sentimentIds = ids.filter(id => isSentimentStrategy(id));
  // 重点板块-N日最高涨幅系列也走独立回测（板块驱动、尾盘 14:50 买入，不走共享数据循环的买点诊断）
  const keyBlockIds = ids.filter(id => !isSentimentStrategy(id) && STRATEGIES[id]?.keyBlockDays != null);
  const regularIds = ids.filter(id => !isSentimentStrategy(id) && STRATEGIES[id]?.keyBlockDays == null);
  const results = [];
  for (const strategyId of sentimentIds) {
    const result = await runSentimentBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of keyBlockIds) {
    const result = await runKeyBlockBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  if (regularIds.length === 0) return results;

  // 三日情绪均值系列不依赖资金快照：组内包含该系列策略时，日期序列并入 tech_index 覆盖的交易日
  // （补上缺资金快照的日期，如 20260730）并允许构建无资金快照的回放数据；
  // 非该系列策略在这些日期上量能等依赖资金快照的条件为 null 会安全判不通过，不会误买入
  const hasEmoAvg = regularIds.some(id => STRATEGIES[id].emoAvgBuy === true);
  const allDates = hasEmoAvg
    ? Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    : getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return results.concat(regularIds.map(strategyId => ({ strategyId, result: { success: false, message: '所选日期范围内无可回测交易日' } })));
  }

  // 每个策略独立的持仓状态与成交流水
  const states = regularIds.map(strategyId => ({
    strategy: STRATEGIES[strategyId],
    singlePosition: null, // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
    // 两次买入策略挂起的首笔半仓（买点触发当日先买 5 成，等收盘补足剩余 5 成后再建立正式持仓）
    pendingHalfBuy: null, // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice1, buyChange1, metric, closePrice }
    singleTrades: [],
    skippedDates: [],
  }));

  // 整组策略共享：每日 EOD 信息与期间出现过的自选股（均由 campData 派生）
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: hasEmoAvg });
    } catch (e) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: e.message || '加载失败' }));
      continue;
    }
    if (!campData || campData.success === false) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' }));
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: '无时间桶数据' }));
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用，与策略无关）
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    // 记录回测期间出现过的全部自选股（供前端复制K线等使用）
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 组内含三日情绪冰点策略：预计算当日跟踪指数环境门禁（pickBestStock 内同步查表过滤候选，见 calcEmo3IndexGate）
    if (hasEmoAvg) await ensureEmo3DayGates(dateStr);

    // 内层策略：同一天数据依次跑本组全部策略的买卖点诊断
    for (const st of states) {
      const { strategy, singleTrades } = st;
      const isTwice = strategy.id === 'highest_3d_gain_twice'; // 两次买入策略（选股同 3 日涨幅最大，仅建仓成本计算不同）
      const lastBucket = timeBuckets[timeBuckets.length - 1]; // 用于两次买入策略的收盘补仓

      // 三日情绪均值策略专属卖点：买入次日按竞价开盘涨幅一次性卖出（开盘涨幅为负 → 9:30 开盘卖出；
      // 开盘涨幅 ≥ 0（含 0~1%）→ 固定 10:00 卖出）。当日无该股分时数据时保持持仓、顺延至后续日期重试
      if (strategy.nextDayOpenSell === true && st.singlePosition && dateStr > st.singlePosition.buyDate) {
        const entry = (replayStocks || []).find(s => s.code === st.singlePosition.code);
        const pts = (entry?.tlinePoints || [])
          .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
          .sort((a, b) => a.minute - b.minute);
        if (pts.length > 0) {
          const openPt = pts[0]; // 竞价开盘 = 当日第一分钟分时点（开盘价≈集合竞价成交价）
          const openChange = openPt.change != null && !Number.isNaN(Number(openPt.change)) ? Number(openPt.change) : null;
          let sellPt;
          let sellReason;
          if (openChange != null && openChange < 0) {
            sellPt = openPt;
            sellReason = `次日竞价开盘涨幅 ${openChange.toFixed(2)}% 为负，9:30 开盘直接卖出`;
          } else {
            // 开盘涨幅 ≥ 0（含 0~1% 及无法读取开盘涨幅）：固定次日 10:00 卖出（取当日第一个 minute ≥ 1000 的分时点，未覆盖时回退当日最后一分钟）
            sellPt = pts.find(p => Number(p.minute) >= 1000) || pts[pts.length - 1];
            sellReason = openChange != null
              ? `次日竞价开盘涨幅 +${openChange.toFixed(2)}% ≥ 0，固定 10:00 卖出`
              : '次日开盘涨幅缺失，按非负口径固定 10:00 卖出';
          }
          const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
          const returnRate = st.singlePosition.buyPrice > 0
            ? parseFloat((((sellPrice - st.singlePosition.buyPrice) / st.singlePosition.buyPrice) * 100).toFixed(2))
            : null;
          singleTrades.push({
            seq: singleTrades.length + 1,
            metric: st.singlePosition.metric,
            code: st.singlePosition.code,
            stockName: st.singlePosition.stockName,
            buyDate: st.singlePosition.buyDate,
            buyDateDisplay: st.singlePosition.buyDateDisplay,
            buyTime: st.singlePosition.buyTime,
            buyPrice: st.singlePosition.buyPrice,
            buyChange: st.singlePosition.buyChange,
            buyReason: st.singlePosition.buyReason,
            buyChecks: st.singlePosition.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: `${String(Math.floor(Number(sellPt.minute) / 100)).padStart(2, '0')}:${String(Number(sellPt.minute) % 100).padStart(2, '0')}`,
            sellPrice,
            sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
            sellReason,
            returnRate,
          });
          st.singlePosition = null;
        }
      }

      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];

        // 两次买入策略：非收盘桶上，先建立挂起的首笔半仓（买点触发当日不等收盘）
        if (isTwice && st.pendingHalfBuy && bucket === lastBucket) {
          const closeStock = (bucket.stockChanges || []).find(s => s.code === st.pendingHalfBuy.code);
          const closePrice = closeStock?.lastPx != null && closeStock.lastPx > 0 ? Number(closeStock.lastPx) : null;
          if (closePrice != null) {
            // 成本价 = (首笔半仓买入价 + 收盘补仓买入价) / 2
            const avgPrice = parseFloat(((st.pendingHalfBuy.buyPrice1 + closePrice) / 2).toFixed(2));
            const closeChange = closeStock.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : st.pendingHalfBuy.buyChange1;
            st.singlePosition = {
              code: st.pendingHalfBuy.code,
              stockName: st.pendingHalfBuy.stockName,
              buyDate: st.pendingHalfBuy.buyDate,
              buyDateDisplay: st.pendingHalfBuy.buyDateDisplay,
              buyTime: st.pendingHalfBuy.buyTime,
              buyPrice: avgPrice,
              buyChange: closeChange,
              metric: st.pendingHalfBuy.metric,
              buyReason: st.pendingHalfBuy.buyReason,
              buyChecks: st.pendingHalfBuy.buyChecks,
            };
          }
          st.pendingHalfBuy = null;
        }

        // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
        const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
        const buyHit = strategy.tailDip === true
          ? (strategy.emoAvgBuy === true ? checkEmoAvg3Hit(timeBuckets, bi, dateStr) : checkTailDipHit(timeBuckets, bi))
          : buyDiag?.allPassed === true;
        // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，三日情绪均值走专属命中原因，其余取买点诊断全部通过项汇总）
        const buyInfo = buyHit
          ? (strategy.tailDip === true ? (strategy.emoAvgBuy === true ? EMO_AVG3_BUY_INFO : TAIL_DIP_BUY_INFO) : buildBuyReasonFromDiag(buyDiag))
          : null;
        if (buyHit) {
          // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
          const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

          // 策略切换逻辑：连续切换三日涨幅
          if (strategy.id === 'highest_3d_gain_switch') {
            const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, 'highest_3d_gain');
            if (picked) {
              const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
              const sc = picked.stock;
              const buyPx = parseFloat(Number(sc.lastPx).toFixed(2));
              const buyChange = sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null;

              if (!st.singlePosition) {
                // 情况1：空仓，直接全仓买入
                st.singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: buyPx,
                  buyChange,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              } else if (st.singlePosition.code !== sc.code) {
                // 情况2：已持仓且目标股票已变，卖旧买新
                const oldStock = (bucket.stockChanges || []).find(s => s.code === st.singlePosition.code);
                const sellPx = oldStock?.lastPx != null && oldStock.lastPx > 0 ? parseFloat(Number(oldStock.lastPx).toFixed(2)) : buyPx;
                const sellChange = oldStock?.changePct != null ? parseFloat(Number(oldStock.changePct).toFixed(2)) : null;
                const returnRate = st.singlePosition.buyPrice > 0 ? parseFloat((((sellPx - st.singlePosition.buyPrice) / st.singlePosition.buyPrice) * 100).toFixed(2)) : null;

                singleTrades.push({
                  seq: singleTrades.length + 1,
                  metric: st.singlePosition.metric,
                  code: st.singlePosition.code,
                  stockName: st.singlePosition.stockName,
                  buyDate: st.singlePosition.buyDate,
                  buyDateDisplay: st.singlePosition.buyDateDisplay,
                  buyTime: st.singlePosition.buyTime,
                  buyPrice: st.singlePosition.buyPrice,
                  buyChange: st.singlePosition.buyChange,
                  buyReason: st.singlePosition.buyReason,
                  buyChecks: st.singlePosition.buyChecks,
                  sellDate: dateStr,
                  sellDateDisplay: dateDisplay,
                  sellTime: buyTime,
                  sellPrice: sellPx,
                  sellChange,
                  sellReason: '策略切换：买入三日涨幅更优品种',
                  returnRate,
                });

                st.singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: buyPx,
                  buyChange,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              }
            }
          } else if (!st.singlePosition && !st.pendingHalfBuy) {
            // 原有单股策略逻辑：同一时刻仅持有一只，未持仓时按指标选最优的一只买入
            const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, isTwice ? 'highest_3d_gain' : strategy.id);
            if (picked) {
              const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
              const sc = picked.stock;
              if (isTwice) {
                // 两次买入：买点触发当日先把首笔半仓挂起，留待收盘补足另 5 成
                if (bucket === lastBucket) {
                  // 买点恰好在收盘桶触发：直接按收盘价一次性成交，成本价即为收盘价
                  const closeStock = (bucket.stockChanges || []).find(s => s.code === sc.code);
                  const closePx = closeStock?.lastPx != null && closeStock.lastPx > 0 ? parseFloat(Number(closeStock.lastPx).toFixed(2)) : parseFloat(Number(sc.lastPx).toFixed(2));
                  st.singlePosition = {
                    code: sc.code,
                    stockName: sc.name || sc.code,
                    buyDate: dateStr,
                    buyDateDisplay: dateDisplay,
                    buyTime,
                    buyPrice: closePx,
                    buyChange: closeStock?.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : (sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null),
                    metric: picked.metric,
                    buyReason: gatedBuyInfo.buyReason,
                    buyChecks: gatedBuyInfo.buyChecks,
                  };
                } else {
                  st.pendingHalfBuy = {
                    code: sc.code,
                    stockName: sc.name || sc.code,
                    buyDate: dateStr,
                    buyDateDisplay: dateDisplay,
                    buyTime,
                    buyPrice1: parseFloat(Number(sc.lastPx).toFixed(2)),
                    buyChange1: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                    metric: picked.metric,
                    buyReason: gatedBuyInfo.buyReason,
                    buyChecks: gatedBuyInfo.buyChecks,
                  };
                }
              } else {
                st.singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
                  buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              }
            }
          }
        }

        // 卖出信号（同日买入不可同日卖出；尾盘抄底策略走专属卖点）
        if (st.singlePosition && dateStr > st.singlePosition.buyDate) {
          // 三日情绪均值策略走次日开盘专属卖点（已在桶循环前按日处理），不进入通用卖点诊断
          const position = { code: st.singlePosition.code, stockName: st.singlePosition.stockName, buyPrice: st.singlePosition.buyPrice, buyDate: st.singlePosition.buyDate, tailDipSell: strategy.tailDip === true && strategy.nextDayOpenSell !== true };
          const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
          if (result.isSell && result.closePrice != null) {
            const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
            singleTrades.push({
              seq: singleTrades.length + 1,
              metric: st.singlePosition.metric,
              code: st.singlePosition.code,
              stockName: st.singlePosition.stockName,
              buyDate: st.singlePosition.buyDate,
              buyDateDisplay: st.singlePosition.buyDateDisplay,
              buyTime: st.singlePosition.buyTime,
              buyPrice: st.singlePosition.buyPrice,
              buyChange: st.singlePosition.buyChange,
              buyReason: st.singlePosition.buyReason,
              buyChecks: st.singlePosition.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: result.displayTime,
              sellPrice: result.closePrice,
              sellChange: result.change,
              sellReason: satisfiedNames || '卖出条件触发',
              returnRate: result.returnRate,
            });
            st.singlePosition = null;
          }
        }
      }

      // 两次买入策略：当日尾盘仍有挂起半仓（买点触发但收盘桶无该股报价）→ 次日自动取消，不产生持仓
      if (isTwice && st.pendingHalfBuy) {
        st.pendingHalfBuy = null;
      }
    }
  }

  // 逐策略组装结果（与 runRangeBacktest 单策略版完全一致）
  // 注意：必须 concat 前面独立回测（重点板块系列/情绪游资）已推入 results 的结果，
  // 否则混合组跑常规阶段时这些策略的结果会被静默丢弃（子进程不写缓存、也不报错，
  // 汇总阶段仅读缓存时即显示为「回测失败」——情绪游资因总在独立阶段跑（regularIds 为空
  // 走上方提前 return results）从未触发此问题）
  return results.concat(states.map(st => {
    const { strategy, singleTrades, skippedDates } = st;
    // 期末持仓：按最近一个有效日期的收盘价估算浮盈，计入整体收益
    let overallReturn = 1;
    for (const t of singleTrades) {
      if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn *= 1 + t.returnRate / 100;
    }
    let holding = null;
    if (st.singlePosition) {
      holding = { ...st.singlePosition };
      // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
      for (let i = rangeDates.length - 1; i >= 0; i--) {
        const info = dailyInfos.get(rangeDates[i])?.get(st.singlePosition.code);
        if (info && info.closePx != null && info.closePx > 0) {
          holding.buyReturn = st.singlePosition.buyPrice > 0
            ? parseFloat((((info.closePx - st.singlePosition.buyPrice) / st.singlePosition.buyPrice) * 100).toFixed(2))
            : null;
          break;
        }
      }
      overallReturn *= 1 + (holding.buyReturn || 0) / 100;
    }
    overallReturn = parseFloat(((overallReturn - 1) * 100).toFixed(2));
    const validTrades = singleTrades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
    const winCount = validTrades.filter(t => t.returnRate > 0).length;
    return {
      strategyId: strategy.id,
      result: {
        success: true,
        type: 'single',
        strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
        range: { startDate, endDate },
        skippedDates,
        seenStocks: Array.from(seenStocks.values()),
        trades: singleTrades,
        currentHolding: holding,
        summary: {
          tradeCount: singleTrades.length,
          winCount,
          winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
          ...calcDrawdownStats(validTrades),
          overallReturn,
          holding: !!holding,
        },
      },
    };
  }));
};

module.exports = {
  runRangeBacktest,
  runRangeBacktestMulti,
  STRATEGIES,
  readCachedBacktest,
  writeCachedBacktest,
  attachHoldingDays,
  loadReportIndex,
  sumReportCount,
  isSentimentStrategy,
  getSentimentDefaultRange,
  getTechEmotionEmaMap,
  getTechIndexDates, // 供 backtest-worker 对三日情绪冰点日期范围（含缺资金快照日期）做兜底预构建
  EMO3_BACKTEST_START_DATE,
  isEmo3AvgStrategy,
  getEmo3DefaultRange,
};
