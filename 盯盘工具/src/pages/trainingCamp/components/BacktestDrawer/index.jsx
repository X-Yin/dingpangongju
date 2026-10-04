import { useState, useEffect, useRef, useMemo } from 'react';
import { Drawer, Button, DatePicker, message, Progress, Tag, Empty, Alert, Select, Tooltip, Checkbox, Modal, Tabs } from 'antd';
import {
  CopyOutlined,
  StopOutlined,
  BarChartOutlined,
  LineChartOutlined,
  RiseOutlined,
  FallOutlined,
  ThunderboltOutlined,
  RocketOutlined,
  ExperimentOutlined,
  BookOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import BacktestReportModal from '../BacktestReportModal';
import TrendDiagnosisModal from '../TrendDiagnosisModal';
import TimeFlexTestModal from '../TimeFlexTestModal';

// 回测最早支持日期（早于此日期无回放数据）
const EARLIEST_DATE = '20260803';
// 默认回测范围窗口（最近 N 个交易日），与后端 backtestReport.js 的 getDefaultReportRange /
// backtest-worker.js 的回测时间口径一致；可用交易日不足 N 个时自动取最早的一个日期
const REPORT_DAYS = 60;
const fmtDate = (d) => `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
const fmtPct = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '--';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};
// 持仓交易日数展示（服务端按 amountSnapshot 交易日历计算；≈ 表示日期超出日历覆盖、按周一~周五退化估算）
const fmtHoldingDays = (t) => (t && t.holdingDays != null ? `${t.holdingDaysApprox ? '≈' : ''}${t.holdingDays} 交易日` : '--');

// 重点板块仓位模式标签：进攻=全仓 / 防御=创业板情绪低迷期半仓（收益率按半仓折算进概览）
const KEY_BLOCK_MODE_META = {
  offense: { text: '进攻·全仓', color: 'red' },
  defense: { text: '防御·半仓', color: 'orange' },
};
const KeyBlockModeTag = ({ mode }) => {
  const meta = KEY_BLOCK_MODE_META[mode];
  if (!meta) return null;
  return <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>;
};
// 收益标签：rate 为计入账户的折算收益率；防御半仓笔（weight<1）展示折算后值并悬停显示个股原始收益
const WeightedReturnTag = ({ rate, rawRate, weight, label = '收益' }) => {
  const isHalf = weight != null && Number(weight) < 1;
  const tag = (
    <Tag color={Number(rate) >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
      {label} {fmtPct(rate)}{isHalf ? '（半仓折算）' : ''}
    </Tag>
  );
  if (!isHalf || rawRate == null) return tag;
  return (
    <Tooltip title={`个股实际${label} ${fmtPct(rawRate)}；防御为半仓买入（${Math.round(Number(weight) * 100)}% 仓位），计入账户的${label} = ${fmtPct(rawRate)} × ${Number(weight)} = ${fmtPct(rate)}`}>
      {tag}
    </Tooltip>
  );
};

// 当前买卖点诊断规则说明（与训练营回放 / buySellBacktest 后端逻辑保持一致，供复制到外部分析）
const BUY_RULES = [
  { key: 'cyb_ma3_slope_gate', title: '跨指数双门禁（创业板指+科创50，仅 N 日涨幅最大系列）', desc: '盘中实时计算两个指数的 3 日线斜率（MA3 − MA3(5 个交易日前)，当日收盘价用盘中实时价代替），按优先级依次判定：③a 今日盘中由正转负 → 当日禁止；③b 由正转负后第 1 天（前一交易日刚转负、今日 slope<0 且盘中未转正）→ 次日也禁止；② 由负转正当日 + 次日（daysSinceTurnPos ≤ 1）→ 均允许；① slope<0 且不在转负两日禁入窗口 → 始终允许；其余 slope≥0 且距上次转正已过 1 天以上 → 禁止。根据代码前缀分配跟踪指数：主板（60/00）+ 创业板（30）→ 创业板指 sz399006；科创板（68）→ 科创 50 sh000688。两个指数各自独立判定后合并为 allowedMarkets 集合——两个都过→全池选 N 日涨幅最大；只一个过→只从对应市场选；都不过→跳过本次买入。两个指数的 buyChecks 明细都会记录斜率实时值与翻转事件。非 N 日涨幅最大系列策略不受此限制' },
  { key: 'fund_inflow', title: '最近 5 分钟资金净流入', desc: '最近 5min 大盘主力资金净流入大于 20 亿才触发买入' },
  { key: 'volume_expansion', title: '量能变化', desc: '当前量能（今日累计成交额-昨日全天）为 0 以上：较 5min 前增加即可；量能为负：需较 5min 前增加不小于 100 亿。若今日或前一交易日科技情绪触及 -100 退潮冰点（hasIce）则此项自动豁免' },
  { key: 'opening_below', title: '开盘后自选股低于开盘价数量', desc: '仅 9:30-10:00 生效：现价低于 9:30 开盘价的自选股数量不超过 30 只' },
  { key: 'emotion_retrace_after_open', title: '竞价情绪回落', desc: '9:30 竞价科技情绪 > 80 时，需当前科技情绪 < 40 才允许买入；开盘情绪 ≤80 或无线数据时该项不限制' },
  { key: 'resilience_gate', title: '选股抗分歧门槛（仅「买入最高涨幅」策略叠加 ≥ 11；所有策略通用 ≥ 9）', desc: '两层门槛：① 全局最低门槛 ≥ 9（所有策略通用，买点触发时刻个股抗分歧分数 < 9 → 顺延至下一只满足的股票，全部不满足则当日不买入）；② 专项门槛 ≥ 11（仅「买入最高涨幅」一个策略叠加启用，其余策略不走此条）。BUY_RULES 的买入条件明细会在 resiliencScore 字段里返回实际抗分歧分数，并标注是否因前序股票抗分歧不足而顺延（含前序股票触发时涨幅与抗分歧分数）' },
];
const SELL_RULES = [
  { key: 'condition1', title: '均线破位', desc: '根据 MA5/MA10 斜率与开盘价位置分四种规则，跌破对应均线或前一交易日最低价触发卖点' },
  { key: 'condition2', title: '高位放量大阴线', desc: '日内最高价到现价回落超过 8%，且现价低于日内开盘价，需持续 ≥5 分钟才触发' },
  { key: 'condition3', title: '科技板块情绪退潮', desc: '科技情绪指数 = -100 且自选股中跌幅 <-9% 的个股 ≥5 个，需持续 ≥5 分钟才触发' },
  { key: 'condition4', title: '抗分歧指数弱势', desc: '抗分歧指数 < 6 且当前涨幅 ≤ -5%，仅 14:50 后生效' },
  { key: 'condition5', title: '连续三日抗分歧弱势', desc: '近三日（含当日）抗分歧指数均 < 10，仅 9:40 后生效' },
  { key: 'condition6', title: '跌破最迟买入日低点', desc: '现价跌破买入当日最低点，需持续 ≥5 分钟才触发' },
  { key: 'condition7', title: '跌破成本线-2%', desc: '现价跌破持仓成本线的 -2%（成本价 × 0.98）即触发卖出，线上为持仓管理设置的成本价，回测为买入价' },
];

// 回测策略选项（与后端 buySellBacktest.STRATEGIES 保持一致；全量自选股策略已移除）
const STRATEGY_OPTIONS = [
  // 情绪快进快出系列（买点触发均可买入；上一交易日科技情绪 3 日 EMA < -60 的日子买入 → 该笔持仓次日 10:00 强制卖出且强卖当日禁止二次买入，否则走通用卖点）
  { value: 'highest_2d_gain_emoquick', label: '2日涨幅最大&三日情绪-60快进快出' },
  { value: 'highest_3d_gain_emoquick', label: '3日涨幅最大&三日情绪-60快进快出' },
  { value: 'highest_4d_gain_emoquick', label: '4日涨幅最大&三日情绪-60快进快出' },
  { value: 'highest_5d_gain_emoquick', label: '5日涨幅最大&三日情绪-60快进快出' },
  { value: 'highest_3d_reports_top5_gain_emoquick', label: '3日涨幅最大&三日情绪-60快进快出&研报覆盖' },
  { value: 'highest_gain', label: '买入最高涨幅' },
  { value: 'highest_2d_gain', label: '2日涨幅最大' },
  { value: 'highest_3d_gain', label: '3日涨幅最大' },
  { value: 'highest_4d_gain', label: '4日涨幅最大' },
  { value: 'highest_5d_gain', label: '5日涨幅最大' },
  { value: 'highest_10d_gain', label: '10日涨幅最大' },
  { value: 'key_block_2d_gain', label: '重点板块-2日最高涨幅' },
  { value: 'key_block_3d_gain', label: '重点板块-3日最高涨幅' },
  { value: 'key_block_4d_gain', label: '重点板块-4日最高涨幅' },
  { value: 'key_block_5d_gain', label: '重点板块-5日最高涨幅' },
  { value: 'highest_3d_reports', label: '3日研报覆盖数最多' },
  { value: 'highest_5d_reports', label: '5日研报覆盖数最多' },
  { value: 'highest_3d_reports_top5_gain', label: '3日研报前五&涨幅最大' },
  { value: 'highest_5d_reports_top5_gain', label: '5日研报前五&涨幅最大' },
  { value: 'highest_3d_ma_slope', label: '3日线斜率最陡峭' },
  { value: 'highest_5d_ma_slope', label: '5日线斜率最陡峭' },
  { value: 'highest_5d_resilience', label: '5日抗分歧分数最大' },
  { value: 'highest_3d_resilience', label: '3日抗分歧分数最大' },
  { value: 'resilience_weak_to_strong', label: '抗分歧弱转强' },

  // 当日实时口径系列（与后端 buySellBacktest.STRATEGIES 保持一致；指标按买点触发时刻分时数据实时计算）
  { value: 'highest_1d_resilience', label: '当日抗分歧分数最大' },

  // 情绪开关系列（上一交易日科技情绪 3 日 EMA < -60 → 波动最小策略，否则 → 3日涨幅最大）
  { value: 'prev3d_fall_low5_day_gain_emoswitch', label: '前三波动最小&当日涨最大/3日涨幅开关' },
  { value: 'prev2d_fall_low5_day_gain_emoswitch', label: '前二波动最小&当日涨最大/3日涨幅开关' },
  { value: 'prev1d_fall_low5_day_gain_emoswitch', label: '昨日波动最小&当日涨最大/3日涨幅开关' },

  { value: 'tail_dip_1d_gain', label: '尾盘抄底-当日涨幅最大' },
  { value: 'tail_dip_3d_gain', label: '尾盘抄底-3日涨幅最大' },
  { value: 'tail_dip_1d_resilience', label: '尾盘抄底-当日抗分歧最大' },
  { value: 'tail_dip_3d_resilience', label: '尾盘抄底-3日抗分歧最大' },
  { value: 'tail_dip_1d_fall', label: '尾盘抄底-当日跌幅最大' },
  { value: 'tail_dip_3d_fall', label: '尾盘抄底-3日跌幅最大' },
  { value: 'tail_dip_1d_resilience_low', label: '尾盘抄底-当日抗分歧分数最低' },
  { value: 'tail_dip_emo3_3d_gain', label: '三日情绪冰点-3日涨幅最大' },
  { value: 'tail_dip_emo3_3d_fall', label: '三日情绪冰点-3日跌幅最大' },
  { value: 'tail_dip_emo3_3d_reports_top5_gain', label: '三日情绪冰点-3日研报前五&涨幅最大' },
  { value: 'tail_dip_emo3_1d_gain', label: '三日情绪冰点-当日涨幅最大' },
  { value: 'tail_dip_emo3_1d_fall', label: '三日情绪冰点-当日跌幅最大' },
  { value: 'tail_dip_emo3_1d_resilience', label: '三日情绪冰点-当日抗分歧最大' },
  { value: 'hot_money_3d_gain', label: '情绪游资-3日涨幅最大' },
  { value: 'hot_money_5d_gain', label: '情绪游资-5日涨幅最大' },
  { value: 'hot_money_10d_gain', label: '情绪游资-10日涨幅最大' },
  { value: 'hot_money_first_board', label: '情绪游资-昨日首板' },
  { value: 'hot_money_second_board', label: '情绪游资-昨日二板' },
  { value: 'hot_money_3d_slope', label: '情绪游资-3日线斜率最陡峭' },
  { value: 'hot_money_5d_slope', label: '情绪游资-5日线斜率最陡峭' },
  { value: 'hot_money_2nd_wave', label: '情绪游资-龙二波' },
  { value: 'hot_money_weak_to_strong', label: '情绪游资-弱转强' },
  { value: 'hot_money_leader', label: '情绪游资-龙头战法' },
];

// 情绪游资系列策略（与后端 sentimentHotMoney.SENTIMENT_HOT_MONEY_IDS 保持一致）：
// 买卖点规则与常规策略不同，日期范围独立（不依赖后端回放缓存，默认最近 60 个已完结交易日）
const SENTIMENT_HOT_MONEY_IDS = [
  'hot_money_3d_gain',
  'hot_money_5d_gain',
  'hot_money_10d_gain',
  'hot_money_first_board',
  'hot_money_second_board',
  'hot_money_3d_slope',
  'hot_money_5d_slope',
  'hot_money_2nd_wave',
  'hot_money_weak_to_strong',
  'hot_money_leader',
];
const isSentimentStrategy = (id) => SENTIMENT_HOT_MONEY_IDS.includes(id);
// 情绪游资策略可选日期下限（不依赖回放缓存，仅受数据源覆盖范围限制）
const SENTIMENT_EARLIEST_DATE = '20250101';

// 三日情绪冰点系列策略（与后端 buySellBacktest.STRATEGIES 的 emoAvgBuy: true 保持一致）：
// 回测日期范围独立——固定从 2026-07-01 开始回测，与其他策略（最近 60 个交易日滚动窗口）区别开
const EMO3_STRATEGY_IDS = [
  'tail_dip_emo3_3d_gain',
  'tail_dip_emo3_3d_fall',
  'tail_dip_emo3_3d_reports_top5_gain',
  'tail_dip_emo3_1d_gain',
  'tail_dip_emo3_1d_fall',
  'tail_dip_emo3_1d_resilience',
];
const isEmo3Strategy = (id) => EMO3_STRATEGY_IDS.includes(id);
// 三日情绪冰点系列固定回测起点（与后端 buySellBacktest.EMO3_BACKTEST_START_DATE 保持一致）
const EMO3_BACKTEST_START_DATE = '20260701';
// 策略类别：用于切换策略时判断是否需要重置手动日期范围（emo3 / sentiment / regular 各自默认范围不同）
const strategyCategory = (id) => (isEmo3Strategy(id) ? 'emo3' : isSentimentStrategy(id) ? 'sentiment' : 'regular');

// 情绪游资策略专属规则说明（与后端 sentimentHotMoney 逻辑保持一致，供复制到外部分析）
const SENTIMENT_BUY_RULES = [
  { key: 'lhb', title: '登龙虎榜（累计池）', desc: '候选股须在回测起始日至前一交易日（含）期间任一交易日登上同花顺龙虎榜（随回测推进逐日累加的累计池），且为主板（60/00 开头）非 ST 股（名称含 ST/退 的剔除）' },
  { key: 'board_overlap', title: '属电力/农业/医药/消费板块成分股', desc: '龙虎榜候选股必须与东方财富板块成分股汇总的电力、农业、医药、消费四份名单之一代码重合才可买入，其余龙虎榜股票全部剔除' },
  { key: 'selection', title: '策略选股', desc: '3/5/10日涨幅最大：截至前一交易日收盘最近 N 个交易日累计涨幅最大的候选股；昨日首板：最近 5 个交易日内昨日为第一个涨停板（涨幅 ≥9.5%）；昨日二板：昨日恰好第 2 个涨停板（昨日与前日均涨停 ≥9.5%，且大前日未涨停，多连板股剔除）；3/5日线斜率最陡峭：N 个日涨幅均线斜率角度最陡峭（一字板顺延）；龙二波：过去 20 个交易日累计涨幅 >60% 且过去 3 个交易日收盘价最高值与最低值波动幅度 ≤10%（收盘价始终在 10 个点以内波动）、最近 5 个交易日内无涨停板（前期大涨后横盘整理）；弱转强：昨日量能放大至前日量能的 1.4 倍以上（放大 40% 以上），且前期（最近 20 个交易日）至少出现过 2 个涨停板（不要求连续）；龙头战法：截至前一交易日收盘过去 20 个交易日累计涨幅最高的一只' },
  { key: 'market_gate', title: '大盘环境条件', desc: '创业板指 5 日线斜率 < 0 且 10 日线斜率 < 0，且银行板块（同花顺 881155）5 日线斜率 > 0 且较前一交易日更陡峭（斜率值增大；均按前一交易日收盘数据计算，斜率 = 当前 MA − 5 日前 MA）；龙头战法例外：仅需银行板块 10 日线斜率 > 0，不看创业板指' },
  { key: 'trigger', title: '盘中涨幅超过 8%', desc: '环境条件满足时，候选股盘中涨幅超过 8% 即按该分钟价格买入（多只候选取当日最先触发的一只，同分钟取涨幅最大）；9:30 竞价开盘涨幅 ≥9.6% 的一字板买不进去，直接剔除不参与买入；弱转强策略还要求今日高开 2% 以上（按分时第一分钟涨幅过滤）才参与买入；龙头战法例外：9:30 开盘按开盘第一分钟价格直接买入，不等 8% 触发' },
];
const SENTIMENT_SELL_RULES = [
  { key: 'sentiment_stop_loss', title: '跌破成本线-5%', desc: '现价低于买入价 × 0.95（较买入价下跌 5%）即按触发分钟价格止损卖出；所有情绪游资策略统一此口径' },
  { key: 'sentiment_ma10_slope', title: '十日线斜率转负', desc: '该股十日线斜率（昨日收盘口径，斜率 = 当前 MA10 − 5 日前 MA10）转为负数，即按当日开盘第一分钟价格卖出；所有情绪游资策略统一仅这两个卖点，满足其一即卖（买入次日起生效）' },
  { key: 'sentiment_yin_close', title: '尾盘收阴线（仅首板/二板）', desc: '仅限买入次日的尾盘判定：当日首个 ≥14:57 的分钟（分时未覆盖时用最后一分钟）现价低于当日开盘价（即当日收阴线）→ 按该分钟价格卖出；过了次日该卖点失效，卖点回归「跌破成本线-5%」与「十日线斜率转负」两个；仅情绪游资-昨日首板、昨日二板两个策略适用' },
];

// 重点板块-N日最高涨幅系列策略（与后端 buySellBacktest.STRATEGIES 的 keyBlockDays 保持一致）：
// 板块驱动的独立买入逻辑（斜率分模式 + tag 板块选股），日期范围与常规策略一致（依赖回放缓存）
const KEY_BLOCK_STRATEGY_IDS = [
  'key_block_2d_gain',
  'key_block_3d_gain',
  'key_block_4d_gain',
  'key_block_5d_gain',
];
const KEY_BLOCK_BUY_RULES = [
  { key: 'key_block_cyb_gate', title: '唯一买卖开关：3 日线斜率正负翻转（盘中实时）', desc: '盘中实时计算创业板指 3 日线斜率（MA3 − 5个交易日前的MA3，当日收盘价用盘中实时价代替，不等收盘，逐桶实时判定），只在斜率正负翻转的桶触发买卖，不需要资金、成交量、情绪等任何条件配合：斜率由负转正 → 进攻买点（买自选科技股）；斜率由正转负且当前空仓 → 防御买点（买防御+中性 tag 板块）。斜率符号跨日连续追踪，初值取回测首日前一交易日的收盘斜率；斜率数据不足的桶不参与翻转判定；回测首日之前若斜率无翻转则不建仓' },
  { key: 'key_block_watchlist_tech', title: '候选池筛选与仓位（进攻=自选科技股·全仓 / 防御=防御+中性板块·半仓）', desc: '进攻候选 = 自选股（monitor_stocks.json）中 isTech ≠ false 的科技股（剔除排除股；含自选股添加时间门禁，买点时点未加入自选的股票不参与），进攻为全仓买入；防御候选 =「防御+中性」tag 板块全部成分股（板块 tag 在 key_blocks 页面维护，未打 tag 的板块不参与，不限自选股），防御对应创业板情绪低迷期，按半仓买入；防御笔的收益率（含期末浮盈）在概览的整体收益、平均回撤、单笔最大回撤中一律按半仓（×0.5）折算；停牌或无当日分时数据的个股自动跳过' },
  { key: 'key_block_retry_940', title: '进攻卖出后当日不追买，次日 9:40 复测', desc: '进攻持仓按卖点诊断卖出后，若当时 3 日线斜率仍为正，当日不再继续买入；等到次日开盘 10 分钟后（9:40 桶）再看盘中实时斜率，仍为正才继续买 N 日涨幅最大的科技股；若复测时斜率已经为负，则不再买科技股，改由「由正转负」防御信号驱动（空仓时买入防御+中性）；防御持仓在斜率转正桶卖出后，同桶即可转手买入进攻科技股，不受此限制' },
  { key: 'key_block_limit_up', title: '涨停过滤与顺延', desc: '买入时点判断候选股是否涨停：主板股票（60/00 开头）涨幅 > 9.5% 视为涨停，创业板（30）/科创板（68）涨幅 > 19% 视为涨停；涨停股不可买入，顺延到 N 日涨幅排名的下一只非涨停股票（买入明细中标注被顺延的涨停候选）；全部候选涨停或无有效候选时，在斜率状态不变的后续桶持续重试' },
  { key: 'key_block_best_stock', title: '候选池内 N 日涨幅最大的股票', desc: '在候选池（进攻=自选科技股池；防御=tag 匹配板块成分股）中，按最近 N 个交易日（含触发日）个股涨幅之和取最大的一只买入（个股日涨幅 = 相邻收盘价环比，由回测时重新拉取成分股日K现算）；买入价取触发桶时点的分时价格；同桶允许先卖后买转手（防御卖出与进攻买入可在同一桶完成）' },
];
const KEY_BLOCK_SELL_RULES = [
  { key: 'key_block_positive_sells', title: '进攻持仓（科技股）：通用 7 条件卖点（成本线 -2%）', desc: '自选科技股买入的进攻持仓沿用通用 7 条件卖出诊断（跌破10日线/前低/5日线、高位放量大阴线、科技板块情绪退潮、连续三日抗分歧<10、距5日收盘新高、跌停、跌破成本线），满足其一即卖（买入次日起生效）；条件 7「跌破成本线」为 -2%（现价 < 买入价 × 0.98 即触发）；卖出后按「当日不追买、次日 9:40 复测」规则处理（见买入规则）；「科技板块情绪退潮」受创业板指 3 日线斜率门禁（见下）' },
  { key: 'key_block_reverse_sells', title: '防御持仓（防御+中性·半仓）：双卖点 = 斜率由负转正 ∪ 个股跌破成本线 -5%', desc: '防御持仓按半仓买入（账户收益贡献 = 个股实际收益 × 0.5，概览的整体收益与平均/最大回撤均按折算口径），双卖点任一先触发即卖出：① 盘中实时创业板指 3 日线斜率由负转正的那个桶（MA3 − 5个交易日前的MA3，当日收盘价用盘中实时价代替），按该桶时点持仓股分时价卖出；② 个股分时价跌破买入成本线 -5%（现价 < 买入价 × 0.95）即止损卖出。卖出后同桶即按进攻买点扫描买入科技股；持仓股分时拉取失败当日安全跳过，次日重试' },
  { key: 'key_block_emo_gate', title: '科技板块情绪退潮门禁（仅进攻持仓）', desc: '创业板指 3 日线斜率为正（MA3 − 5个交易日前的MA3，按当日收盘已基本定型口径）时，「科技板块情绪退潮」条件才参与进攻（科技股）持仓的卖出判定；斜率为负或数据不足时该条件当日不生效（其余 6 项条件不受影响）；防御持仓不走 7 条件卖点，本门禁不适用' },
];

// ============ 策略专属说明（不与通用 BUY_RULES / SELL_RULES 重复） ============
// 每个策略的 id → { 选股口径, 触发时点, 特殊卖点/触发条件, 备注 }
const STRATEGY_SPECIFIC_NOTES = {
  // ---- 常规「N日涨幅最大」系列 ----
  highest_gain: {
    group: '常规·N日涨幅最大',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入**触发时点当日盘中涨幅最大**的一只。',
      '触发时点：沿用通用买入诊断（BUY_RULES）的 allPassed 时点。',
      '卖点：通用 SELL_RULES 7 条件（均线破位 / 高位放量大阴线 / 科技情绪退潮 / 抗分歧<6 / 连续3日抗分歧<10 / 跌破买点前低 / 跌破成本线-2%），满足其一即卖。',
      '跨指数双门禁：创业板指 + 科创50 的 3 日线斜率实时判定后合并（两个都过→全池；只一个过→对应市场）。',
    ],
  },
  highest_2d_gain: {
    group: '常规·N日涨幅最大',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入**触发时点当日盘中涨幅最大**的一只（注意：2 日窗口并不影响排序依据，排序仍按「触发时点当日盘中涨幅」）。',
      '卖点：通用 SELL_RULES 7 条件，满足其一即卖。',
      '跨指数双门禁（创业板指 + 科创50 的 3 日线斜率实时判定后合并）；全局最低抗分歧门槛 ≥ 9 顺延（与所有非 highest_gain 策略共享）。',
    ],
  },
  highest_3d_gain: {
    group: '常规·N日涨幅最大',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入**最近 3 个交易日涨幅之和最大**的一只；3 日窗口 = 触发日 + 前 2 个交易日（按日K相邻收盘价环比累加）。',
      '卖点：通用 SELL_RULES 7 条件，满足其一即卖。',
      '跨指数双门禁（创业板指 + 科创50 的 3 日线斜率实时判定后合并）；全局最低抗分歧门槛 ≥ 9 顺延。',
    ],
  },
  highest_4d_gain: {
    group: '常规·N日涨幅最大',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入**最近 4 个交易日涨幅之和最大**的一只。',
      '卖点：通用 SELL_RULES 7 条件；跨指数双门禁 + 全局最低抗分歧门槛 ≥ 9。',
    ],
  },
  highest_5d_gain: {
    group: '常规·N日涨幅最大',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入**最近 5 个交易日涨幅之和最大**的一只。',
      '卖点：通用 SELL_RULES 7 条件；跨指数双门禁 + 全局最低抗分歧门槛 ≥ 9。',
    ],
  },
  highest_10d_gain: {
    group: '常规·N日涨幅最大',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入**最近 10 个交易日涨幅之和最大**的一只。',
      '卖点：通用 SELL_RULES 7 条件。注意：**全局最低抗分歧门槛 ≥ 9 照常生效**（所有策略通用，不可豁免）；只有「买入最高涨幅」一个策略叠加了 ≥ 11 的专项门槛，其余常规 N 日涨幅最大系列都只走 ≥ 9 线。',
    ],
  },

  // ---- 研报覆盖系列 ----
  highest_3d_reports: {
    group: '研报覆盖系列',
    bullets: [
      '选股口径：买点触发时，统计自选科技股最近 3 个交易日（含触发日）的研报覆盖数，买入覆盖数最多的一只；**覆盖数相同时取 3 日涨幅最大**。',
      '研报口径：仅统计买点触发时点之前已创建的研报，买点后补录的不计入。',
      '卖点：通用 SELL_RULES 7 条件；不适用抗分歧门槛。',
    ],
  },
  highest_5d_reports: {
    group: '研报覆盖系列',
    bullets: [
      '选股口径：最近 5 个交易日研报覆盖数最多的一只；相同时取 5 日涨幅最大。',
      '卖点：通用 SELL_RULES 7 条件；不适用抗分歧门槛。',
    ],
  },
  highest_3d_reports_top5_gain: {
    group: '研报覆盖系列',
    bullets: [
      '选股口径：先取「最近 3 日研报覆盖数前五（含并列）」形成候选池，再从中选 3 日涨幅最大的一只。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },
  highest_5d_reports_top5_gain: {
    group: '研报覆盖系列',
    bullets: [
      '选股口径：先取「最近 5 日研报覆盖数前五（含并列）」形成候选池，再从中选 5 日涨幅最大的一只。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },

  // ---- 均线斜率系列 ----
  highest_3d_ma_slope: {
    group: '均线斜率系列',
    bullets: [
      '选股口径：买点触发时，从全量自选科技股中买入 **3 日涨幅均线斜率最陡峭** 的一只（斜率 = 当前 MA3 − 5 个交易日前的 MA3，斜率越大=近期涨幅越陡峭）。',
      '卖点：通用 SELL_RULES 7 条件；不适用抗分歧门槛。',
    ],
  },
  highest_5d_ma_slope: {
    group: '均线斜率系列',
    bullets: [
      '选股口径：5 日涨幅均线斜率最陡峭的一只。',
      '卖点：通用 SELL_RULES 7 条件；不适用抗分歧门槛。',
    ],
  },

  // ---- 抗分歧系列 ----
  highest_3d_resilience: {
    group: '抗分歧系列',
    bullets: [
      '选股口径：买点触发时买入**最近 3 个交易日抗分歧分数之和最大**的一只。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },
  highest_5d_resilience: {
    group: '抗分歧系列',
    bullets: [
      '选股口径：买点触发时买入**最近 5 个交易日抗分歧分数之和最大**的一只。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },
  highest_1d_resilience: {
    group: '抗分歧系列',
    bullets: [
      '选股口径：买点触发时，**按触发时点实时分时数据**计算每只自选股的日内抗分歧分数，买入分数最大的一只；分数相同时取触发时点当日实时涨幅最大的一只。',
      '与 highest_3d/5d_resilience 的区别：这里用的是「当日截至触发时点的实时分数」，不是收盘口径。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },
  resilience_weak_to_strong: {
    group: '抗分歧系列',
    bullets: [
      '选股口径：两阶段——① 先筛出**当日抗分歧分数 > 11** 的股票；② 在候选池里计算「最近 4 个交易日抗分歧均值」的弱转强差值（前两天均值 vs 最近两天均值，差值越大=由弱转强越明显），全仓买入差值最大的一只；差值相同则取当日涨幅最大的。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },

  // ---- 情绪开关系列（prev{N}d_fall_low5_day_gain_emoswitch）----
  prev1d_fall_low5_day_gain_emoswitch: {
    group: '情绪开关系列',
    bullets: [
      '选股口径：两阶段 + 情绪开关。当开关触发（上一交易日科技情绪 3 日 EMA < -60）：① 先按「**昨日累计涨幅绝对值最小**」取前五（无论涨跌，波动最小在前，top5=最低 5 只含并列）；② 候选池内选**买点触发时点当日盘中涨幅最大**的一只；否则（EMA ≥ -60 或数据缺失）跳过第一步，直接按「3 日涨幅最大」（最近 3 个交易日涨幅之和最大）选股。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },
  prev2d_fall_low5_day_gain_emoswitch: {
    group: '情绪开关系列',
    bullets: [
      '选股口径：两阶段 + 情绪开关。开关触发时（EMA < -60）：① 先按「**前 2 个交易日累计涨幅绝对值最小**」取前五（波动最小，无论涨跌）；② 候选池内选**触发时点当日盘中涨幅最大**的一只；否则直接按「3 日涨幅最大」选股。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },
  prev3d_fall_low5_day_gain_emoswitch: {
    group: '情绪开关系列',
    bullets: [
      '选股口径：两阶段 + 情绪开关。开关触发时（EMA < -60）：① 先按「**前 3 个交易日累计涨幅绝对值最小**」取前五（波动最小，无论涨跌）；② 候选池内选**触发时点当日盘中涨幅最大**的一只；否则直接按「3 日涨幅最大」选股。',
      '卖点：通用 SELL_RULES 7 条件。',
    ],
  },

  // ---- 快进快出系列（*_emoquick） ----
  highest_2d_gain_emoquick: {
    group: '快进快出系列',
    bullets: [
      '选股口径：与「2日涨幅最大」完全相同——买点触发时买入**触发时点当日盘中涨幅最大**的一只，跨指数双门禁 + 全局最低抗分歧门槛 ≥ 9 顺延生效。',
      '与常规策略的唯一区别在**卖点**：当上一交易日科技情绪 3 日 EMA < -60 时，该笔持仓**次日 10:00 强制卖出**（不走通用卖点），且强卖当日禁止二次买入；否则仍走通用 SELL_RULES 7 条件。',
      '快进快出温和回升额外门控：买入日、卖出日（上上个、上个交易日）的当日科技情绪原始分（非 3 日 EMA）必须都落在开区间 (-30, 20) 内且逐日回升，才触发快进快出逻辑；不满足则退化为普通「2日涨幅最大」。',
    ],
  },
  highest_3d_gain_emoquick: {
    group: '快进快出系列',
    bullets: [
      '选股口径：与「3日涨幅最大」完全相同——买点触发时买入**最近 3 个交易日涨幅之和最大**的一只，跨指数双门禁 + 全局最低抗分歧门槛 ≥ 9 顺延生效。',
      '特殊卖点：当上一交易日科技情绪 3 日 EMA < -60 → 次日 10:00 强制卖出（不走通用卖点），强卖当日禁止二次买入；否则走通用 SELL_RULES。',
      '快进快出温和回升门控：近两日当日情绪原始分 ∈ (-30, 20) 且逐日回升才触发；不满足退化为普通 3 日涨幅最大。',
    ],
  },
  highest_4d_gain_emoquick: {
    group: '快进快出系列',
    bullets: [
      '选股口径：最近 4 个交易日涨幅之和最大的一只；跨指数双门禁 + 全局最低抗分歧门槛 ≥ 9。',
      '特殊卖点：上一交易日 3 日 EMA < -60 → 次日 10:00 强卖，否则通用 7 条件卖点。',
    ],
  },
  highest_5d_gain_emoquick: {
    group: '快进快出系列',
    bullets: [
      '选股口径：最近 5 个交易日涨幅之和最大的一只；跨指数双门禁 + 全局最低抗分歧门槛 ≥ 9。',
      '特殊卖点：上一交易日 3 日 EMA < -60 → 次日 10:00 强卖，否则通用 7 条件卖点。',
    ],
  },
  highest_3d_reports_top5_gain_emoquick: {
    group: '快进快出系列',
    bullets: [
      '选股口径分三路：当触发「上一交易日科技情绪 3 日 EMA < -60」这条快进快出路径时，先取**最近 3 日研报覆盖数前五（含并列，仅统计买点前已创建的研报）**形成候选池，再从中选 3 日涨幅最大的一只（博弈反弹提胜率）；走「温和回升」或数据缺失 / 非快进快出 时仍按普通「3 日涨幅最大」选股。',
      '特殊卖点：与 highest_3d_gain_emoquick 完全相同——上一交易日 3 日 EMA < -60 或温和回升任一触发 → 次日 10:00 强卖（不走通用 7 条件），否则走通用 SELL_RULES。',
    ],
  },

  // ---- 重点板块系列（key_block_*） ----
  key_block_2d_gain: {
    group: '重点板块系列',
    bullets: [
      '选股口径：板块驱动，**不走通用 BUY_RULES**。候选池分两种——进攻 = 自选股 monitor_stocks 中 isTech ≠ false 的科技股（全仓）；防御 = 「防御+中性」tag 板块全部成分股（半仓）。',
      '触发时点：**唯一触发开关 = 创业板指 3 日线斜率正负翻转桶**。斜率由负转正 → 进攻买点，全仓买 N 日涨幅最大科技股；斜率由正转负且空仓 → 防御买点，半仓买防御+中性板块 N 日涨幅最大股。',
      'N 日窗口：2 个交易日（与其他 key_block_* 同步）。',
      '进攻卖点：通用 7 条件卖点（成本线 -2%）；但防御卖点 = 斜率由负转正 ∪ 个股跌破买入价 × 0.95，双条件任一触发即卖。',
      '特殊：进攻卖出后当日不追买，次日 9:40 再复测斜率；涨停股（主板>9.5%、创业板/科创板>19%）顺延到下一只。',
    ],
  },
  key_block_3d_gain: {
    group: '重点板块系列',
    bullets: [
      '与 key_block_2d_gain 完全相同，唯 N 日窗口 = 3 个交易日。',
    ],
  },
  key_block_4d_gain: {
    group: '重点板块系列',
    bullets: [
      '与 key_block_2d_gain 完全相同，唯 N 日窗口 = 4 个交易日。',
    ],
  },
  key_block_5d_gain: {
    group: '重点板块系列',
    bullets: [
      '与 key_block_2d_gain 完全相同，唯 N 日窗口 = 5 个交易日。',
    ],
  },

  // ---- 尾盘抄底系列（tail_dip_*） ----
  tail_dip_1d_gain: {
    group: '尾盘抄底系列',
    bullets: [
      '买入触发条件：仅当**当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）**时命中，不走通用 BUY_RULES 的 allPassed。',
      '触发时点：固定 14:57（尾盘集合竞价时点）挂单买入，成交价取 14:57 那一分钟的 lastPx（等价于收盘价）。',
      '选股口径：当日涨幅最大的自选科技股（tail_dip_1d_gain 变体）。',
      '卖点：**专属逐分钟环比规则**——次日开盘后持续监测：只要当前分钟涨幅比上一分钟回落，就立即按回落那一分钟的价格卖出。不走通用 SELL_RULES。',
    ],
  },
  tail_dip_3d_gain: {
    group: '尾盘抄底系列',
    bullets: [
      '与 tail_dip_1d_gain 相同，但选股口径改为「最近 3 个交易日涨幅之和最大」。',
      '买入触发条件：当日科技情绪分时曾触及 -100 冰点（hasIce: true）；14:57 挂单买入。',
      '卖点：次日开盘后逐分钟监测，涨幅开始回落即按回落分钟价格卖出。',
    ],
  },
  tail_dip_1d_resilience: {
    group: '尾盘抄底系列',
    bullets: [
      '选股口径：当日抗分歧分数最大的自选科技股。',
      '买入触发条件：当日科技情绪曾触及 -100 冰点（hasIce: true）；14:57 挂单买入。',
      '卖点：次日开盘后逐分钟环比，涨幅回落即卖出。',
    ],
  },
  tail_dip_3d_resilience: {
    group: '尾盘抄底系列',
    bullets: [
      '选股口径：最近 3 个交易日抗分歧分数之和最大。',
      '其他规则同 tail_dip_1d_resilience。',
    ],
  },
  tail_dip_1d_fall: {
    group: '尾盘抄底系列',
    bullets: [
      '选股口径：当日跌幅最大的自选科技股（「跌深反弹」版本，与 gain 系列对称）。',
      '买入触发条件：当日科技情绪曾触及 -100 冰点；14:57 挂单。',
      '卖点：次日开盘后逐分钟环比，涨幅回落即卖。',
    ],
  },
  tail_dip_3d_fall: {
    group: '尾盘抄底系列',
    bullets: [
      '选股口径：最近 3 个交易日跌幅最大。',
      '其他规则同 tail_dip_1d_fall。',
    ],
  },
  tail_dip_1d_resilience_low: {
    group: '尾盘抄底系列',
    bullets: [
      '选股口径：**当日抗分歧分数最低**的自选科技股（与 resilience 对称，买最「弱」的博弈反弹）。',
      '其他规则同 tail_dip_1d_resilience。',
    ],
  },

  // ---- 三日情绪冰点变体（tail_dip_emo3_*） ----
  tail_dip_emo3_3d_gain: {
    group: '三日情绪冰点系列',
    bullets: [
      '触发条件：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60；**不走 hasIce**（与普通尾盘抄底的核心区别）。回测固定起点 2026-07-01。',
      '选股口径：最近 3 个交易日涨幅之和最大；买点固定 14:57（尾盘集合竞价）。',
      '卖点**专属**（不走通用 SELL_RULES / 不走尾盘逐分钟回落）——买入次日竞价开盘涨幅 < 0 → 9:30 开盘直接卖出；开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 统一卖出。',
    ],
  },
  tail_dip_emo3_3d_fall: {
    group: '三日情绪冰点系列',
    bullets: [
      '触发条件：情绪页三日均值 EMA < -60；选股口径：最近 3 个交易日跌幅最大；14:57 挂单。',
      '卖点专属：次日竞价开盘涨幅 < 0 → 9:30 开盘直接卖；≥ 0 → 固定次日 10:00 卖。',
      '回测固定起点 2026-07-01。',
    ],
  },
  tail_dip_emo3_3d_reports_top5_gain: {
    group: '三日情绪冰点系列',
    bullets: [
      '触发条件：情绪页三日均值 EMA < -60。',
      '选股口径：先取最近 3 日研报覆盖数前五（含并列），候选池内选 3 日涨幅最大。',
      '卖点专属：次日竞价开盘涨幅 < 0 → 9:30 开盘直接卖；≥ 0 → 固定次日 10:00 卖。买点 14:57；回测固定起点 2026-07-01。',
    ],
  },
  tail_dip_emo3_1d_gain: {
    group: '三日情绪冰点系列',
    bullets: [
      '触发条件：情绪页三日均值 EMA < -60；选股口径：当日涨幅最大（涨幅相同时取最近 2 个交易日涨幅最大的一只）；14:57 挂单。',
      '卖点专属：次日竞价开盘涨幅 < 0 → 9:30 开盘直接卖；≥ 0 → 固定次日 10:00 卖；回测固定起点 2026-07-01。',
    ],
  },
  tail_dip_emo3_1d_fall: {
    group: '三日情绪冰点系列',
    bullets: [
      '触发条件：情绪页三日均值 EMA < -60；选股口径：当日跌幅最大（跌幅相同时取最近 2 个交易日跌幅最大的一只）；14:57 挂单。',
      '卖点专属：次日竞价开盘涨幅 < 0 → 9:30 开盘直接卖；≥ 0 → 固定次日 10:00 卖；回测固定起点 2026-07-01。',
    ],
  },
  tail_dip_emo3_1d_resilience: {
    group: '三日情绪冰点系列',
    bullets: [
      '触发条件：情绪页三日均值 EMA < -60；选股口径：当日抗分歧分数最大（分数相同时取最近 2 个交易日抗分歧分数汇总最大的一只）；14:57 挂单。',
      '卖点专属：次日竞价开盘涨幅 < 0 → 9:30 开盘直接卖；≥ 0 → 固定次日 10:00 卖；回测固定起点 2026-07-01。',
    ],
  },

  // ---- 情绪游资系列（hot_money_*） ----
  hot_money_3d_gain: {
    group: '情绪游资系列',
    bullets: [
      '候选池：**累计龙虎榜**（回测起始日至前一交易日，同花顺龙虎榜每日累加） ∩「电力/农业/医药/消费」四大东方财富板块成分股 ∩ 主板（60/00）非 ST。',
      '选股口径：最近 3 个交易日累计涨幅最大的候选股。',
      '触发时点：大盘环境满足时（创业板指 5/10 日线斜率 < 0 且银行板块 5 日线斜率 > 0 且更陡峭），**盘中涨幅 > 8%** 时按该分钟价格买入（多只同日触发取最先那只，同分钟取涨幅最大）；9:30 一字板（竞价涨幅 ≥9.6%）剔除。',
      '卖点：三条统一卖点（2026-09-20 起所有情绪游资策略一致，满足任一即卖，买入次日起生效）——① 该股十日线斜率（昨日收盘口径，MA10 − 5 日前 MA10）转为负数 → 当日开盘第一分钟卖出；② 现价跌破买入价 × 0.95（逐分钟监控）→ 止损卖出；③ 首板/二板专属（仅限买入次日尾盘判定，过了次日失效）——当日首个 ≥14:57 分钟现价低于当日开盘价（收阴线）→ 按该分钟价格卖出。',
      '回测日期范围：默认最近 60 个已完结交易日，不依赖回放缓存；最早可选 2025-01-01。',
    ],
  },
  hot_money_5d_gain: {
    group: '情绪游资系列',
    bullets: [
      '与 hot_money_3d_gain 完全相同，唯选股口径为「最近 5 个交易日累计涨幅最大」。',
    ],
  },
  hot_money_10d_gain: {
    group: '情绪游资系列',
    bullets: [
      '与 hot_money_3d_gain 完全相同，唯选股口径为「最近 10 个交易日累计涨幅最大」。',
    ],
  },
  hot_money_first_board: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：候选池内**昨日恰好第一个涨停板**（昨日涨幅 ≥ 9.5%，且最近 5 个交易日此前未涨停过）。',
      '触发时点 & 卖点：同 hot_money_3d_gain；首板/二板专属额外卖点——仅限次日尾盘：当日 14:57 现价低于开盘价（收阴线）则按该分钟价格卖出；过了次日失效。',
    ],
  },
  hot_money_second_board: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：候选池内**昨日恰好第 2 个涨停板**（昨日与前日均涨停 ≥ 9.5%，且大前日未涨停，多连板股剔除）。',
      '触发时点 & 卖点：同 hot_money_3d_gain；同样带「次日尾盘收阴线即卖」的额外卖点（仅次日生效）。',
    ],
  },
  hot_money_3d_slope: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：候选池内 **3 日涨幅均线斜率最陡峭** 的一只（一字板顺延）。',
      '其他规则同 hot_money_3d_gain（触发 8% / 止损-5% / 十日线斜率转负）。',
    ],
  },
  hot_money_5d_slope: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：候选池内 **5 日涨幅均线斜率最陡峭** 的一只。其他规则同 hot_money_3d_gain。',
    ],
  },
  hot_money_2nd_wave: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：「龙二波」——候选池内同时满足①过去 20 个交易日累计涨幅 > 60%；②过去 3 个交易日收盘价最高值与最低值波动 ≤ 10%（前期大涨后横盘整理）；③最近 5 个交易日内无涨停板。',
      '其他规则同 hot_money_3d_gain（触发 8% / 止损-5% / 十日线斜率转负）。',
    ],
  },
  hot_money_weak_to_strong: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：「弱转强」——候选池内同时满足①昨日量能放大至前日的 1.4 倍以上；②前期（最近 20 个交易日）至少出现过 2 个涨停板。',
      '额外买入门禁：今日**高开 2% 以上**（按分时第一分钟涨幅过滤）才参与买入。',
      '其他规则同 hot_money_3d_gain。',
    ],
  },
  hot_money_leader: {
    group: '情绪游资系列',
    bullets: [
      '选股口径：「龙头战法」——候选池内过去 20 个交易日累计涨幅最高的一只。',
      '特殊触发与卖点：① 不等 8% 阈值，**9:30 开盘第一分钟价格直接买入**；② 大盘环境只需银行板块 10 日线斜率 > 0，不看创业板指（与其他情绪游资策略独立）；③ 卖点仍为「跌破买入价 × 0.95」与「十日线斜率转负」两条。',
    ],
  },
};

// 买入原因标签：显示命中了哪些买入条件（悬停展示逐项明细：条件标题、数值与判定理由）
const BuyReasonTag = ({ reason, checks }) => {
  if (!reason) return null;
  // 顺延明细表格单元格样式（Tooltip 深色底：白边框、涨红/跌绿）
  const gateCellStyle = { border: '1px solid rgba(255,255,255,0.3)', padding: '1px 8px', whiteSpace: 'nowrap' };
  const hasDetail = Array.isArray(checks) && checks.length > 0;
  const detail = hasDetail ? (
    <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
      {checks.map((c, i) => (
        <div key={c.id || i}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {c.passed ? '✓' : '✗'} {c.value || c.title}
          </div>
          {c.reason && c.reason !== c.value && (
            <div style={{ fontSize: 11, opacity: 0.75 }}>{c.reason}</div>
          )}
          {Array.isArray(c.skippedStocks) && c.skippedStocks.length > 0 && (() => {
            // 列按数据存在性渲染：涨停顺延明细（limit_up_defer）无窗口涨幅/抗分歧列
            const hasMetric = c.skippedStocks.some(s => s.metric != null);
            const hasResilience = c.skippedStocks.some(s => s.resilience != null);
            const heads = ['顺延前序股票'];
            if (hasMetric) heads.push('窗口涨幅(排序依据)');
            heads.push('触发时涨幅');
            if (hasResilience) heads.push('抗分歧分数');
            return (
              <table style={{ borderCollapse: 'collapse', marginTop: 3, fontSize: 11 }}>
                <thead>
                  <tr>
                    {heads.map(h => (
                      <th key={h} style={{ ...gateCellStyle, fontWeight: 600, opacity: 0.75 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.skippedStocks.map((s, j) => (
                    <tr key={s.code || j}>
                      <td style={gateCellStyle}>{s.name || s.code}</td>
                      {hasMetric && (
                        <td style={{ ...gateCellStyle, color: s.metric != null ? (s.metric > 0 ? '#ff7875' : s.metric < 0 ? '#95de64' : undefined) : undefined }}>
                          {s.metric != null ? `${s.metric > 0 ? '+' : ''}${Number(s.metric).toFixed(2)}%` : '--'}
                        </td>
                      )}
                      <td style={{ ...gateCellStyle, color: s.change != null ? (s.change > 0 ? '#ff7875' : s.change < 0 ? '#95de64' : undefined) : undefined }}>
                        {s.change != null ? `${s.change > 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                      </td>
                      {hasResilience && (
                        <td style={gateCellStyle}>{s.resilience != null ? Number(s.resilience).toFixed(1) : '--'}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>
      ))}
    </div>
  ) : undefined;
  return (
    <Tooltip
      title={detail}
      placement="topLeft"
      // 限制 tooltip 气泡最大高度 500px，超出部分内部滚动（买入条件明细可能很长）
      styles={{ inner: { maxHeight: 500, overflowY: 'auto' } }}
      className='backtest-drawer-buy-reason-tooltip'
    >
      <Tag color="volcano" style={{ marginInlineEnd: 0, whiteSpace: 'normal', height: 'auto', cursor: hasDetail ? 'help' : 'default' }}>
        {reason}
      </Tag>
    </Tooltip>
  );
};

// 计算回测汇总指标（兼容全量策略 stocks 与单股策略 summary 两种结果结构）
const buildSummary = (result) => {
  if (result?.type === 'single') {
    const sum = result.summary || {};
    return {
      stockCount: (result.seenStocks || []).length,
      totalTrades: sum.tradeCount || 0,
      winTrades: sum.winCount || 0,
      winRate: sum.winRate != null ? Number(sum.winRate) : null,
      avgDrawdown: sum.avgDrawdown != null ? Number(sum.avgDrawdown) : null,
      maxDrawdown: sum.maxDrawdown != null ? Number(sum.maxDrawdown) : null,
      avgReturn: null,
      overallReturn: sum.overallReturn != null ? Number(sum.overallReturn) : null,
      holdingCount: sum.holding ? 1 : 0,
      avgHoldingDays: sum.avgHoldingDays ?? null,
      avgHoldingDaysApprox: sum.avgHoldingDaysApprox ?? false,
    };
  }
  const stocks = result?.stocks || [];
  let totalTrades = 0;
  let winTrades = 0;
  let returnSum = 0;
  let validReturns = 0;
  let lossSum = 0; // 亏损单笔收益之和（负值）
  let lossCount = 0;
  let maxDrawdown = null; // 单笔最大回撤（最差一笔，负值）
  let holdingCount = 0;
  const closedDays = []; // 已卖出成交的持仓交易日数（含退化估算时标记 ≈）
  let anyApprox = false;
  stocks.forEach(s => {
    s.trades.forEach(t => {
      totalTrades++;
      if (t.returnRate != null && !Number.isNaN(Number(t.returnRate))) {
        const r = Number(t.returnRate);
        returnSum += r;
        validReturns++;
        if (r > 0) winTrades++;
        if (r < 0) {
          lossSum += r;
          lossCount++;
          if (maxDrawdown == null || r < maxDrawdown) maxDrawdown = r;
        }
      }
      if (t.holdingDays != null) {
        closedDays.push(t.holdingDays);
        if (t.holdingDaysApprox) anyApprox = true;
      }
    });
    if (s.holding) holdingCount++;
  });
  return {
    stockCount: stocks.length,
    totalTrades,
    winTrades,
    winRate: totalTrades > 0 ? (winTrades / totalTrades) * 100 : null,
    avgDrawdown: lossCount > 0 ? parseFloat((lossSum / lossCount).toFixed(2)) : null,
    maxDrawdown,
    avgReturn: validReturns > 0 ? returnSum / validReturns : null,
    overallReturn: null,
    holdingCount,
    avgHoldingDays: closedDays.length > 0 ? Math.round((closedDays.reduce((a, b) => a + b, 0) / closedDays.length) * 10) / 10 : null,
    avgHoldingDaysApprox: anyApprox,
  };
};

const BacktestDrawer = ({ open, onClose, dates = [] }) => {
  const [range, setRange] = useState(null);
  const [strategy, setStrategy] = useState('highest_3d_gain_emoquick');
  const [sentimentRange, setSentimentRange] = useState(null); // 情绪游资默认日期范围 [dayjs, dayjs]（最近 60 个已完结交易日）
  const [reportOpen, setReportOpen] = useState(false);
  const [trendOpen, setTrendOpen] = useState(false); // 策略趋势诊断弹窗（三档时间范围 × 全部策略）
  const [timeFlexOpen, setTimeFlexOpen] = useState(false); // 时间伸缩测试弹窗
  const [ruleOpen, setRuleOpen] = useState(false); // 策略说明弹窗（当前选中策略的买卖规则细节）
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { current, total, date, status }
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copying, setCopying] = useState(false);
  // 震荡测试：记录右上角勾选「隐藏」的股票代码集合（一次性，不持久化；打开抽屉/切换策略或日期时清空）
  const [hiddenCodes, setHiddenCodes] = useState(() => new Set());
  const [oscResult, setOscResult] = useState(null); // 震荡测试结果（不落后端缓存，退出/刷新即失效）
  const [oscMeta, setOscMeta] = useState(null); // 本次震荡测试实际排除的股票展示文案，如 ['某某(sh688361)']
  const pollRef = useRef(null);
  const taskIdRef = useRef(null);
  const [workerRunning, setWorkerRunning] = useState(false); // 全量回测（backtest-worker.js）后台执行中
  const [workerLog, setWorkerLog] = useState(''); // worker 最近一条日志
  const workerPollRef = useRef(null);

  const availableDates = useMemo(() => (Array.isArray(dates) ? dates : []), [dates]);
  const maxDateStr = availableDates.length > 0 ? availableDates[0] : dayjs().format('YYYYMMDD');
  // 情绪游资策略不依赖后端回放缓存，默认范围用独立的 sentiment_range（最近 60 个已完结交易日）；
  // 三日情绪冰点策略固定从 2026-07-01 开始回测（结束日取最新可用交易日）；
  // 未手动选择时常规策略默认取「最近 60 个可用交易日」（不足 60 个时取最早的一个日期），与后端回测报告 /
  // worker 预生成缓存的日期范围口径一致，
  // 保证 worker 跑完后打开抽屉能直接命中缓存（此前写死最早日期会因范围不一致查不到缓存而空白）
  const defaultRange = useMemo(() => {
    if (availableDates.length === 0) return [dayjs(EARLIEST_DATE, 'YYYYMMDD'), dayjs(maxDateStr, 'YYYYMMDD')];
    const sortedAsc = [...availableDates].sort();
    const start = sortedAsc[Math.max(0, sortedAsc.length - REPORT_DAYS)];
    const end = sortedAsc[sortedAsc.length - 1];
    return [dayjs(start, 'YYYYMMDD'), dayjs(end, 'YYYYMMDD')];
  }, [availableDates, maxDateStr]);
  // 三日情绪冰点默认范围：起点固定 2026-07-01，结束日取最新可用回放交易日（与后端 getEmo3DefaultRange 口径一致）
  const emo3DefaultRange = useMemo(() => {
    if (availableDates.length === 0) return [dayjs(EMO3_BACKTEST_START_DATE, 'YYYYMMDD'), dayjs(maxDateStr, 'YYYYMMDD')];
    const sortedAsc = [...availableDates].sort();
    return [dayjs(EMO3_BACKTEST_START_DATE, 'YYYYMMDD'), dayjs(sortedAsc[sortedAsc.length - 1], 'YYYYMMDD')];
  }, [availableDates, maxDateStr]);
  const curIsSentiment = isSentimentStrategy(strategy);
  const curIsEmo3 = isEmo3Strategy(strategy);
  const curIsKeyBlock = KEY_BLOCK_STRATEGY_IDS.includes(strategy);
  const effectiveRange = range || (curIsEmo3 ? emo3DefaultRange : curIsSentiment ? (sentimentRange || defaultRange) : defaultRange);

  // 组件卸载时停止轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (workerPollRef.current) clearInterval(workerPollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // 查询当前 策略+日期范围 是否已有缓存结果：有则直接展示，无需重新回测
  const checkCache = async () => {
    const pick = effectiveRange;
    if (!pick || !pick[0] || !pick[1] || running) return;
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) return;
    try {
      const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/cache`, {
        params: { startDate, endDate, strategy },
      });
      if (r.data?.success && r.data.cached && r.data.result) {
        setResult(r.data.result);
        setError(null);
      } else if (r.data?.success && !r.data.cached) {
        // 无缓存：清空旧结果，避免展示与当前策略/日期不符的数据
        setResult(null);
      }
    } catch {
      // 网络异常时保持现状
    }
  };

  // 打开抽屉、切换策略或修改日期范围时检查缓存（延迟到宏任务，避免 effect 内同步 setState）；
  // 同时清空上一次震荡测试的隐藏勾选与结果（一次性状态，不持久化，重新打开抽屉即重置）
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      setHiddenCodes(new Set());
      setOscResult(null);
      setOscMeta(null);
      checkCache();
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, strategy, range, sentimentRange]);

  // 选中情绪游资策略且尚无默认范围时拉取（最近 60 个已完结交易日，不依赖回放缓存）
  useEffect(() => {
    if (!open || !curIsSentiment || sentimentRange) return;
    let cancelled = false;
    axios.get(`http://${local_ip}:3000/training_camp/backtest/sentiment_range`).then((r) => {
      if (cancelled) return;
      if (r.data?.success && r.data.startDate && r.data.endDate) {
        setSentimentRange([dayjs(String(r.data.startDate), 'YYYYMMDD'), dayjs(String(r.data.endDate), 'YYYYMMDD')]);
      }
    }).catch(() => { });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, curIsSentiment, sentimentRange]);

  // 复制文本到剪贴板：优先 clipboard API（需 secure context），失败/不可用时降级 execCommand
  const copyToClipboard = async (text) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 降级 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const autoCopyStrategyLabel = async (v) => {
    // 选中策略后自动把策略名称复制到剪贴板
    const label = STRATEGY_OPTIONS.find(o => o.value === v)?.label;
    if (label) {
      const ok = await copyToClipboard(label);
      if (ok) message.success('复制名称成功');
      else message.warning('复制失败，请手动复制');
    }
  };

  // 切换策略：策略类别（三日情绪冰点 / 情绪游资 / 常规）变化时重置手动日期，回退到该类别的默认范围；
  // 选中后自动复制策略名称到剪贴板
  const handleStrategyChange = async (v) => {
    if (strategyCategory(v) !== strategyCategory(strategy)) {
      setRange(null);
      setResult(null);
    }
    setStrategy(v);
  };

  const startPolling = (taskId, opts = {}) => {
    stopPolling();
    taskIdRef.current = taskId;
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/status/${taskId}`);
        const s = r.data;
        if (s.status === 'running') {
          setProgress(s.progress || null);
        } else {
          stopPolling();
          setRunning(false);
          if (s.status === 'done' && s.result) {
            if (opts.osc) {
              setOscResult(s.result); // 震荡测试结果单独存放，不覆盖缓存回测结果
              message.success('震荡测试完成');
            } else {
              setResult(s.result);
              message.success('回测完成');
            }
          } else if (s.status === 'error') {
            setError(s.error || '回测失败');
          } else {
            setError('任务状态异常');
          }
        }
      } catch {
        // 忽略单次轮询失败，继续等待
      }
    }, 2000);
  };

  const handleStart = async (force = false) => {
    const pick = effectiveRange;
    if (!pick || !pick[0] || !pick[1]) {
      message.warning('请选择回测日期范围');
      return;
    }
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) {
      message.warning('开始日期不能晚于结束日期');
      return;
    }
    setResult(null);
    setOscResult(null);
    setOscMeta(null);
    setHiddenCodes(new Set());
    setError(null);
    setProgress({ current: 0, total: 0, date: '', status: '' });
    setRunning(true);
    try {
      const r = await axios.post(`http://${local_ip}:3000/training_camp/backtest`, { startDate, endDate, strategy, force });
      if (r.data?.success && r.data.taskId) {
        startPolling(r.data.taskId);
      } else if (r.data?.success && r.data.cached && r.data.result) {
        // 服务端命中缓存，直接展示
        setResult(r.data.result);
        setRunning(false);
        message.success('已加载缓存回测结果');
      } else {
        setRunning(false);
        setError(r.data?.message || '创建回测任务失败');
      }
    } catch {
      setRunning(false);
      setError('创建回测任务失败，请检查后端服务');
    }
  };

  // 勾选/取消勾选某条回测记录的「隐藏」（按股票代码维度：同一股票的所有记录同步勾选）
  const toggleHiddenCode = (code, checked) => {
    setHiddenCodes(prev => {
      const next = new Set(prev);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  // 震荡测试：按当前策略 + 日期范围重跑一次回测，被勾选「隐藏」的股票不参与本次回测，
  // 用于检验策略收益率是结构性的还是依赖个别牛股；结果不落后端缓存，一次性展示
  const handleOscTest = async () => {
    const pick = effectiveRange;
    if (!pick || !pick[0] || !pick[1]) {
      message.warning('请选择回测日期范围');
      return;
    }
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) {
      message.warning('开始日期不能晚于结束日期');
      return;
    }
    if (hiddenCodes.size === 0) {
      message.warning('请先在回测记录右上角勾选「隐藏」需要排除的股票');
      return;
    }
    // 记录本次排除的股票展示文案（代码 + 名称，名称取自当前回测结果）
    const nameMap = {};
    (result?.trades || []).forEach(t => { if (t.code) nameMap[t.code] = t.stockName || t.code; });
    (result?.stocks || []).forEach(s => { if (s.code) nameMap[s.code] = s.stockName || s.code; });
    const codes = Array.from(hiddenCodes).map(c => (nameMap[c] ? `${nameMap[c]}(${c})` : c));
    setOscResult(null);
    setError(null);
    setProgress({ current: 0, total: 0, date: '', status: '' });
    setRunning(true);
    try {
      const r = await axios.post(`http://${local_ip}:3000/training_camp/backtest`, {
        startDate,
        endDate,
        strategy,
        force: true,
        excludeCodes: Array.from(hiddenCodes),
      });
      if (r.data?.success && r.data.taskId) {
        setOscMeta({ codes });
        startPolling(r.data.taskId, { osc: true });
      } else {
        setRunning(false);
        setError(r.data?.message || '创建震荡测试任务失败');
      }
    } catch {
      setRunning(false);
      setError('创建震荡测试任务失败，请检查后端服务');
    }
  };

  const stopWorkerPolling = () => {
    if (workerPollRef.current) {
      clearInterval(workerPollRef.current);
      workerPollRef.current = null;
    }
  };

  const startWorkerPolling = () => {
    stopWorkerPolling();
    workerPollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/worker/status`);
        const s = r.data || {};
        const logs = Array.isArray(s.logs) ? s.logs : [];
        setWorkerLog(logs[logs.length - 1] || '');
        if (s.status !== 'running') {
          stopWorkerPolling();
          setWorkerRunning(false);
          if (s.status === 'done') {
            message.success('全量回测完成，回测报告已重新生成');
            setTimeout(checkCache, 0); // 拉取重跑后的最新缓存结果
          } else {
            message.error('全量回测失败，详情见服务端日志');
          }
        }
      } catch {
        // 忽略单次轮询失败，继续等待
      }
    }, 3000);
  };

  // 回测全部：后台执行 backtest-worker.js（清空回测缓存 → 预热日K → 并行预构建 → 全部策略并行回测 → 自动汇总生成回测报告）
  const handleRunAll = async () => {
    const pick = effectiveRange;
    if (!pick || !pick[0] || !pick[1]) {
      message.warning('请选择回测日期范围');
      return;
    }
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) {
      message.warning('开始日期不能晚于结束日期');
      return;
    }
    try {
      const r = await axios.post(`http://${local_ip}:3000/training_camp/backtest/worker`, { startDate, endDate });
      if (r.data?.success) {
        setWorkerRunning(true);
        setWorkerLog('全量回测已启动：清空回测缓存 → 预热日K线 → 预构建回放数据…');
        startWorkerPolling();
        message.info('全量回测已启动（全部策略强制重跑），完成后结果与报告自动刷新');
      } else {
        message.error(r.data?.message || '启动全量回测失败');
      }
    } catch {
      message.error('启动全量回测失败，请检查后端服务');
    }
  };

  // 打开抽屉时同步一次全量回测状态（worker 正在后台跑时恢复按钮态与轮询）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    axios.get(`http://${local_ip}:3000/training_camp/backtest/worker/status`).then((r) => {
      if (cancelled) return;
      const s = r.data || {};
      if (s.status === 'running') {
        const logs = Array.isArray(s.logs) ? s.logs : [];
        setWorkerRunning(true);
        setWorkerLog(logs[logs.length - 1] || '全量回测进行中…');
        startWorkerPolling();
      }
    }).catch(() => { });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleCopy = async () => {
    if (!result) return;
    if (copying) return;
    setCopying(true);
    try {
      const pick = effectiveRange;
      const startDate = pick[0].format('YYYYMMDD');
      const endDate = pick[1].format('YYYYMMDD');
      // 情绪游资策略使用专属买卖规则文案（选股/环境/触发与常规策略不同）
      const buyRules = curIsSentiment ? SENTIMENT_BUY_RULES : curIsKeyBlock ? KEY_BLOCK_BUY_RULES : BUY_RULES;
      const sellRules = curIsSentiment ? SENTIMENT_SELL_RULES : curIsKeyBlock ? KEY_BLOCK_SELL_RULES : SELL_RULES;

      // 1) 批量拉取全部自选股 K 线数据（覆盖回测范围，limit 取 100）
      const codes = (result.stocks || result.seenStocks || []).map(s => s.code).filter(Boolean);
      let kline = {};
      if (codes.length > 0) {
        try {
          const kr = await axios.post(`http://${local_ip}:3000/data_center/stocks_kline`, { codes, limit: 100 });
          if (kr.data?.success) {
            // 清除单只获取失败的错误占位，避免混入 JSON
            Object.entries(kr.data.data || {}).forEach(([code, arr]) => {
              if (Array.isArray(arr)) kline[code] = arr;
            });
          }
        } catch {
          kline = {};
        }
      }

      // 2) 规则文本描述
      const buyRulesText = buyRules.map(r => `- ${r.title}：${r.desc}`).join('\n');
      const sellRulesText = sellRules.map(r => `- ${r.title}：${r.desc}`).join('\n');
      const rulesText = `【买入规则】\n${buyRulesText}\n\n【卖出规则】\n${sellRulesText}`;

      // 3) 拉取除「全量自选股」外所有策略的回测结果（优先命中缓存，未运行的策略跳过）
      const strategies = [];
      for (const opt of STRATEGY_OPTIONS) {
        if (opt.value === 'all') continue;
        try {
          const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/cache`, {
            params: { startDate, endDate, strategy: opt.value },
          });
          const cached = r.data?.cached && r.data?.result ? r.data.result : null;
          if (!cached) continue;
          const sum = cached.summary || {};
          strategies.push({
            id: opt.value,
            name: opt.label,
            summary: {
              tradeCount: sum.tradeCount || 0,
              winCount: sum.winCount || 0,
              winRate: sum.winRate != null ? Number(sum.winRate) : null,
              avgDrawdown: sum.avgDrawdown != null ? Number(sum.avgDrawdown) : null,
              maxDrawdown: sum.maxDrawdown != null ? Number(sum.maxDrawdown) : null,
              overallReturn: sum.overallReturn != null ? Number(sum.overallReturn) : null,
              holding: sum.holding ? 1 : 0,
            },
            trades: (cached.trades || []).map(t => ({
              seq: t.seq,
              stockName: t.stockName,
              code: t.code,
              positionMode: t.positionMode ?? null,
              weight: t.weight ?? null,
              rawReturnRate: t.rawReturnRate ?? null,
              metric: t.metric ?? null,
              buyDate: t.buyDate,
              buyTime: t.buyTime,
              buyPrice: t.buyPrice,
              buyChange: t.buyChange,
              buyReason: t.buyReason ?? null,
              buyChecks: t.buyChecks ?? null,
              sellDate: t.sellDate,
              sellTime: t.sellTime,
              sellPrice: t.sellPrice,
              returnRate: t.returnRate,
              sellReason: t.sellReason,
            })),
          });
        } catch {
          // 单策略拉取失败跳过
        }
      }

      // 4) 序列化全部策略回测结果（含汇总指标 + 交易明细 + 买卖点规则 + 全部自选股K线）并附上待分析问题
      const payload = JSON.stringify({
        strategies,
        rules: {
          buy: buyRules,
          sell: sellRules,
        },
        rulesText,
        kline,
        question: '将所有的策略进行收益率的高低排序，根据胜率和赔率进行打分，按照从高到低进行排序，给出理由和依据',
      }, null, 2);

      await copyText(payload);
      message.success(`已复制 ${strategies.length} 个策略的回测结果（含 ${codes.length} 只自选股 K 线、买点/卖点规则）`);
    } catch {
      message.error('复制失败，请重试或手动复制');
    } finally {
      setCopying(false);
    }
  };

  // 兼容不同环境的剪贴板写入
  const copyText = async (payload) => {
    try {
      await navigator.clipboard.writeText(payload);
      return;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  // 展示用结果：震荡测试结果存在时优先展示（退出震荡测试或刷新后回到缓存回测结果）
  const displayResult = oscResult || result;
  const summary = displayResult ? buildSummary(displayResult) : null;

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const disabledDate = (current) => {
    if (!current) return false;
    const ds = current.format('YYYYMMDD');
    // 情绪游资策略不依赖回放缓存，日期可选范围放开（仅受数据源覆盖限制）
    if (curIsSentiment) {
      return ds < SENTIMENT_EARLIEST_DATE || ds > dayjs().format('YYYYMMDD');
    }
    // 三日情绪冰点策略固定从 2026-07-01 开始回测，下限放开至该日（早于回放数据的日期回测时自动跳过）
    if (curIsEmo3) {
      return ds < EMO3_BACKTEST_START_DATE || ds > maxDateStr;
    }
    return ds < EARLIEST_DATE || ds > maxDateStr;
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={1060}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChartOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>买卖点回测</span>
          <Button
            type="primary"
            ghost
            size="small"
            icon={<BarChartOutlined />}
            onClick={() => setReportOpen(true)}
            style={{ marginLeft: 12, borderRadius: 999 }}
          >
            回测报告
          </Button>
          <Button
            size="small"
            icon={<LineChartOutlined />}
            onClick={() => setTrendOpen(true)}
            style={{ marginLeft: 12, borderRadius: 999 }}
          >
            策略趋势诊断
          </Button>
          {result && !running ? (
            <Button
              size="small"
              type="primary"
              icon={<CopyOutlined />}
              onClick={handleCopy}
              loading={copying}
              style={{ marginLeft: 12, borderRadius: 999 }}
            >
              {copying ? '正在获取K线…' : '复制结果内容'}
            </Button>
          ) : null}
        </div>
      }
      styles={{ body: { padding: 16, paddingBottom: 96, background: '#f7f9fc' } }}
    >
      {/* 参数选择区 */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>回测日期范围</span>
          <DatePicker.RangePicker
            value={effectiveRange}
            onChange={setRange}
            disabledDate={disabledDate}
            allowClear={false}
            format="YYYY-MM-DD"
            disabled={running || workerRunning}
            style={{ flex: 1, minWidth: 280, maxWidth: 380 }}
          />
          <Button
            type="primary"
            icon={running ? <StopOutlined /> : <ThunderboltOutlined />}
            onClick={() => handleStart(true)}
            loading={running}
            disabled={workerRunning}
            style={{ borderRadius: 999, padding: '0 24px' }}
          >
            {running ? '回测中' : '强制回测'}
          </Button>
          <Button
            icon={<RocketOutlined />}
            onClick={handleRunAll}
            loading={workerRunning}
            disabled={running}
            style={{ borderRadius: 999 }}
          >
            {workerRunning ? '全量回测中' : '回测全部'}
          </Button>
        </div>

        {/* 回测策略选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>回测策略</span>
          <Select
            value={strategy}
            onChange={handleStrategyChange}
            onSelect={autoCopyStrategyLabel}
            disabled={running}
            style={{ flex: 1, minWidth: 240, maxWidth: 360 }}
            options={STRATEGY_OPTIONS}
          />
          {curIsEmo3 ? (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              三日情绪冰点策略固定从 2026-07-01 开始回测（结束日取最新交易日）
            </span>
          ) : curIsSentiment ? (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              情绪游资策略不依赖回放缓存，可选时间不限（默认最近 60 个交易日）
            </span>
          ) : (
            <Tooltip title="在回测记录右上角勾选「隐藏」排除个别股票后重跑一次回测：被隐藏的股票不参与本次回测，用于检验策略收益率是结构正确带来的，还是单纯依赖个别牛股；结果不落缓存，刷新即失效">
              <Button
                size="small"
                icon={<ExperimentOutlined />}
                onClick={handleOscTest}
                disabled={!displayResult || running || workerRunning}
                style={{ borderRadius: 999 }}
              >
                选股震荡测试
              </Button>
            </Tooltip>
          )}
          <Tooltip title="固定当前结束日，将回测起始日从最早可用交易日逐日平移至「结束日前 10 个交易日」，观察不同起始日下的整体收益率曲线，用于检验策略收益对起始日是否敏感">
            <Button
              size="small"
              icon={<SwapOutlined />}
              onClick={() => setTimeFlexOpen(true)}
              disabled={running || workerRunning}
              style={{ borderRadius: 999 }}
            >
              时间伸缩测试
            </Button>
          </Tooltip>
          {/* 策略说明：始终可见，点击打开当前选中策略的买卖规则详情弹窗 */}
          <Tooltip title="查看当前选中策略的买入触发、选股口径、卖点判定等完整规则细节">
            <Button
              size="small"
              icon={<BookOutlined />}
              onClick={() => setRuleOpen(true)}
              disabled={running}
              style={{ borderRadius: 999 }}
            >
              策略说明
            </Button>
          </Tooltip>
        </div>

        {/* 进度条 */}
        {running && (
          <div style={{ marginTop: 14 }}>
            <Progress
              percent={progressPercent}
              status="active"
              size="small"
              format={() => (progress && progress.total > 0 ? `${progress.current}/${progress.total} 天` : '准备中')}
            />
            <div style={{ fontSize: 12, color: '#6b7890', marginTop: 4 }}>
              {progress && progress.current > 0
                ? `正在回测 ${fmtDate(progress.date)}（${progress.current}/${progress.total}）……逐日回放全部自选股的买点/卖点诊断，耗时较长，请耐心等待`
                : '正在初始化回测任务……'}
            </div>
          </div>
        )}
        {/* 全量回测进行中提示 */}
        {workerRunning && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 14 }}
            message="全量回测进行中（清空回测缓存 → 预热日K线 → 并行预构建 → 全部策略并行回测 → 自动生成回测报告）"
            description={workerLog || '正在启动 worker 进程…'}
          />
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <Alert type="error" showIcon message="回测失败" description={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      )}

      {/* 回测结果 */}
      {displayResult && summary && !running ? (
        <>
          {/* 震荡测试模式提示（结果不落缓存，一次性） */}
          {oscResult ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`震荡测试结果（排除 ${oscMeta?.codes?.length || 0} 只个股｜不落缓存，刷新后失效）`}
              description={`已排除：${(oscMeta?.codes || []).join('、') || '--'}。被隐藏的个股不参与本次回测，对比上方汇总与原结果即可判断策略收益率是结构性的还是依赖个别牛股。`}
              action={(
                <Button
                  size="small"
                  onClick={() => { setOscResult(null); setOscMeta(null); }}
                >
                  退出震荡测试
                </Button>
              )}
            />
          ) : null}
          {/* 汇总统计 */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                displayResult.type === 'single'
                  ? { label: '整体收益', value: summary.overallReturn != null ? fmtPct(summary.overallReturn) : '--', color: summary.overallReturn != null ? (summary.overallReturn >= 0 ? '#f5222d' : '#52c41a') : undefined }
                  : { label: '平均单笔收益', value: summary.avgReturn != null ? fmtPct(summary.avgReturn) : '--', color: summary.avgReturn != null ? (summary.avgReturn >= 0 ? '#f5222d' : '#52c41a') : undefined },
                { label: '胜率', value: summary.winRate != null ? `${summary.winRate.toFixed(1)}%` : '--', color: summary.winRate != null && summary.winRate >= 50 ? '#f5222d' : '#52c41a' },
                { label: '平均回撤', value: summary.avgDrawdown != null ? fmtPct(summary.avgDrawdown) : '--', color: '#52c41a' },
                { label: '单笔最大回撤', value: summary.maxDrawdown != null ? fmtPct(summary.maxDrawdown) : '--', color: '#52c41a' },
                { label: '平均持仓', value: summary.avgHoldingDays != null ? `${summary.avgHoldingDaysApprox ? '≈' : ''}${Number(summary.avgHoldingDays).toFixed(1)} 交易日` : '--' },
                { label: '覆盖自选股', value: `${summary.stockCount} 只` },
                { label: '成交笔数', value: `${summary.totalTrades} 笔` },
                { label: '盈利笔数', value: `${summary.winTrades} 笔` },
                { label: '期末仍持仓', value: displayResult.type === 'single' ? (summary.holdingCount > 0 ? '1 只' : '0 只') : `${summary.holdingCount} 只` },
              ].map(item => (
                <div key={item.label} style={{ flex: 1, minWidth: 110, background: '#f7f9fc', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{item.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: item.color || '#12213a', marginTop: 2 }}>{item.value}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10 }}>
              回测范围：{fmtDate(displayResult.range?.startDate)} ~ {fmtDate(displayResult.range?.endDate)}
              {displayResult.skippedDates && displayResult.skippedDates.length > 0
                ? `｜跳过无数据交易日 ${displayResult.skippedDates.length} 天`
                : ''}
            </div>
          </div>

          {/* 单股策略：逐笔交易明细 */}
          {displayResult.type === 'single' ? (
            displayResult.trades.length === 0 && !displayResult.currentHolding ? (
              <Empty description="所选范围内未产生任何成交" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {displayResult.trades.map(t => (
                  <div key={t.seq} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                    {/* 交易头部 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>第{t.seq}笔</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{t.stockName}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{t.code}</span>
                      <KeyBlockModeTag mode={t.positionMode} />
                      {t.metric != null && (
                        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                          选股指标 {Number(t.metric).toFixed(4)}
                        </Tag>
                      )}
                      <WeightedReturnTag rate={t.returnRate} rawRate={t.rawReturnRate} weight={t.weight} />
                      <Checkbox
                        checked={hiddenCodes.has(t.code)}
                        onChange={(e) => toggleHiddenCode(t.code, e.target.checked)}
                        style={{ marginLeft: 'auto' }}
                      >
                        隐藏
                      </Checkbox>
                    </div>

                    {/* 买卖明细 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ border: '1px solid #eef1f6', borderRadius: 8, padding: '8px 10px', background: '#fafbfd' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <RiseOutlined style={{ color: '#f5222d', fontSize: 12 }} />
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            买入 <b>{fmtDate(t.buyDate)} {t.buyTime}</b>
                          </span>
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.buyPrice).toFixed(2)}</b>
                          </span>
                          <span style={{ fontSize: 12 }}>
                            涨幅 <b style={{ color: t.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.buyChange)}</b>
                          </span>
                        </div>
                        {t.buyReason && (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                            <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                            <BuyReasonTag reason={t.buyReason} checks={t.buyChecks} />
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                          <FallOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            卖出 <b>{fmtDate(t.sellDate)} {t.sellTime}</b>
                          </span>
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.sellPrice).toFixed(2)}</b>
                          </span>
                          <span style={{ fontSize: 12 }}>
                            涨幅 <b style={{ color: t.sellChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.sellChange)}</b>
                          </span>
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(t)}</b>
                          </span>
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            卖出原因 <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t.sellReason}</Tag>
                          </span>
                        </div>
                        {t.positionMode === 'defense' && t.rawReturnRate != null && (
                          <div style={{ fontSize: 12, color: '#d46b08', marginTop: 4 }}>
                            防御半仓口径：个股实际收益 {fmtPct(t.rawReturnRate)}，按 50% 仓位折算后计入概览（整体收益/平均回撤/单笔最大回撤）的收益为 {fmtPct(t.returnRate)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* 期末持仓 */}
                {displayResult.currentHolding && (
                  <div style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>持仓中（未卖出）</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{displayResult.currentHolding.stockName}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{displayResult.currentHolding.code}</span>
                      <KeyBlockModeTag mode={displayResult.currentHolding.mode || displayResult.currentHolding.positionMode} />
                      {displayResult.currentHolding.metric != null && (
                        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                          选股指标 {Number(displayResult.currentHolding.metric).toFixed(4)}
                        </Tag>
                      )}
                      {displayResult.currentHolding.buyReturn != null && (
                        <WeightedReturnTag
                          rate={displayResult.currentHolding.buyReturn}
                          rawRate={displayResult.currentHolding.rawBuyReturn}
                          weight={displayResult.currentHolding.weight}
                          label="浮盈"
                        />
                      )}
                      <Checkbox
                        checked={hiddenCodes.has(displayResult.currentHolding.code)}
                        onChange={(e) => toggleHiddenCode(displayResult.currentHolding.code, e.target.checked)}
                        style={{ marginLeft: 'auto' }}
                      >
                        隐藏
                      </Checkbox>
                    </div>
                    <div style={{ border: '1px dashed #f5c96b', borderRadius: 8, padding: '8px 10px', background: '#fffbea' }}>
                      <span style={{ fontSize: 12, color: '#6b7890' }}>
                        买入 {fmtDate(displayResult.currentHolding.buyDate)} {displayResult.currentHolding.buyTime} 价格{' '}
                        <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(displayResult.currentHolding.buyPrice).toFixed(2)}</b>
                      </span>
                      <span style={{ fontSize: 12, marginLeft: 10 }}>
                        涨幅 <b style={{ color: displayResult.currentHolding.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(displayResult.currentHolding.buyChange)}</b>
                      </span>
                      <span style={{ fontSize: 12, marginLeft: 10, color: '#6b7890' }}>
                        已持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(displayResult.currentHolding)}</b>
                      </span>
                      {displayResult.currentHolding.buyReason && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                          <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                          <BuyReasonTag reason={displayResult.currentHolding.buyReason} checks={displayResult.currentHolding.buyChecks} />
                        </div>
                      )}
                      {(displayResult.currentHolding.mode || displayResult.currentHolding.positionMode) === 'defense' && displayResult.currentHolding.rawBuyReturn != null && (
                        <div style={{ fontSize: 12, color: '#d46b08', marginTop: 4 }}>
                          防御半仓口径：个股实际浮盈 {fmtPct(displayResult.currentHolding.rawBuyReturn)}，按 50% 仓位折算后计入概览的浮盈为 {fmtPct(displayResult.currentHolding.buyReturn)}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          ) : (
            /* 全量策略：每只股票一张卡片 */
            displayResult.stocks.length === 0 ? (
              <Empty description="所选范围内未产生任何成交" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {displayResult.stocks.map(stock => {
                  const stockTotalReturn = stock.trades.reduce((s, t) => s + (Number(t.returnRate) || 0), 0);
                  return (
                    <div key={stock.code} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                      {/* 卡片头部 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{stock.stockName}</span>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{stock.code}</span>
                        <Tag color="blue" style={{ marginInlineEnd: 0 }}>{stock.trades.length} 笔成交</Tag>
                        {stock.trades.length > 0 && (
                          <Tag color={stockTotalReturn >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                            累计收益 {fmtPct(stockTotalReturn)}
                          </Tag>
                        )}
                        {stock.holding && (
                          <Tag color="gold" style={{ marginInlineEnd: 0 }}>期末持仓中</Tag>
                        )}
                        <Checkbox
                          checked={hiddenCodes.has(stock.code)}
                          onChange={(e) => toggleHiddenCode(stock.code, e.target.checked)}
                          style={{ marginLeft: 'auto' }}
                        >
                          隐藏
                        </Checkbox>
                      </div>

                      {/* 成交明细 */}
                      {stock.trades.length === 0 && !stock.holding ? (
                        <div style={{ fontSize: 12, color: '#9ca3af' }}>所选范围内无买入信号触发</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {stock.trades.map((t, idx) => (
                            <div key={idx} style={{ border: '1px solid #eef1f6', borderRadius: 8, padding: '8px 10px', background: '#fafbfd' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <RiseOutlined style={{ color: '#f5222d', fontSize: 12 }} />
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>
                                  第{idx + 1}笔
                                </span>
                                <span style={{ fontSize: 12, color: '#6b7890' }}>
                                  买入 <b>{fmtDate(t.buyDate)} {t.buyTime}</b>
                                </span>
                                <span style={{ fontSize: 12, color: '#6b7890' }}>
                                  价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.buyPrice).toFixed(2)}</b>
                                </span>
                                <span style={{ fontSize: 12 }}>
                                  涨幅 <b style={{ color: t.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.buyChange)}</b>
                                </span>
                              </div>
                              {t.buyReason && (
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                                  <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                                  <BuyReasonTag reason={t.buyReason} checks={t.buyChecks} />
                                </div>
                              )}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                                <FallOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                                <span style={{ fontSize: 12, color: '#6b7890' }}>
                                  卖出 <b>{fmtDate(t.sellDate)} {t.sellTime}</b>
                                </span>
                                <span style={{ fontSize: 12, color: '#6b7890' }}>
                                  价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.sellPrice).toFixed(2)}</b>
                                </span>
                                <span style={{ fontSize: 12 }}>
                                  涨幅 <b style={{ color: t.sellChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.sellChange)}</b>
                                </span>
                                <span style={{ fontSize: 12, color: '#6b7890' }}>
                                  持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(t)}</b>
                                </span>
                                <span style={{ fontSize: 12, color: '#6b7890' }}>
                                  卖出原因 <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t.sellReason}</Tag>
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: t.returnRate >= 0 ? '#f5222d' : '#52c41a' }}>
                                  收益 {fmtPct(t.returnRate)}
                                </span>
                              </div>
                            </div>
                          ))}

                          {/* 期末持仓 */}
                          {stock.holding && (
                            <div style={{ border: '1px dashed #f5c96b', borderRadius: 8, padding: '8px 10px', background: '#fffbea' }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#ad6800' }}>持仓中（未卖出）</span>
                              <span style={{ fontSize: 12, color: '#6b7890', marginLeft: 10 }}>
                                买入 {fmtDate(stock.holding.buyDate)} {stock.holding.buyTime} 价格{' '}
                                <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(stock.holding.buyPrice).toFixed(2)}</b>
                              </span>
                              <span style={{ fontSize: 12, marginLeft: 10 }}>
                                涨幅 <b style={{ color: stock.holding.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(stock.holding.buyChange)}</b>
                              </span>
                              <span style={{ fontSize: 12, marginLeft: 10, color: '#6b7890' }}>
                                已持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(stock.holding)}</b>
                              </span>
                              {stock.holding.buyReason && (
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                                  <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                                  <BuyReasonTag reason={stock.holding.buyReason} checks={stock.holding.buyChecks} />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
        </>
      ) : null}

      <BacktestReportModal open={reportOpen} onClose={() => setReportOpen(false)} />
      <TrendDiagnosisModal open={trendOpen} onClose={() => setTrendOpen(false)} />
      <TimeFlexTestModal
        open={timeFlexOpen}
        onClose={() => setTimeFlexOpen(false)}
        strategy={strategy}
        endDate={effectiveRange?.[1] ? effectiveRange[1].format('YYYYMMDD') : undefined}
        maxStartDate={effectiveRange?.[0] ? effectiveRange[0].format('YYYYMMDD') : undefined}
        strategyName={STRATEGY_OPTIONS.find(o => o.value === strategy)?.label || strategy}
      />
      {(() => {
        const opt = STRATEGY_OPTIONS.find(o => o.value === strategy);
        const label = opt?.label || strategy;
        const isKeyBlock = KEY_BLOCK_STRATEGY_IDS.includes(strategy);
        const isSent = isSentimentStrategy(strategy);
        const buyRules = isSent ? SENTIMENT_BUY_RULES : isKeyBlock ? KEY_BLOCK_BUY_RULES : BUY_RULES;
        const sellRules = isSent ? SENTIMENT_SELL_RULES : isKeyBlock ? KEY_BLOCK_SELL_RULES : SELL_RULES;
        const notes = STRATEGY_SPECIFIC_NOTES[strategy];

        // 将文案中 **xxx** 这种 markdown 粗体标记解析为 React 节点（纯文本不解析）
        const renderBold = (text, keyPrefix = 'b') => {
          const parts = String(text).split('**');
          return parts.map((p, i) => (i % 2 === 1 ? <strong key={`${keyPrefix}-${i}`}>{p}</strong> : <span key={`${keyPrefix}-${i}`}>{p}</span>));
        };

        const ruleRow = (item, idx) => (
          <div key={item.key || idx} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px dashed #eef1f6' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#12213a', marginBottom: 4 }}>
              {idx + 1}. {item.title}
            </div>
            <div style={{ fontSize: 12.5, color: '#4b5563', lineHeight: 1.8 }}>
              {renderBold(item.desc, `rule-${idx}`)}
            </div>
          </div>
        );

        return (
          <Modal
            open={ruleOpen}
            onCancel={() => setRuleOpen(false)}
            footer={null}
            width={860}
            destroyOnHidden
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <BookOutlined style={{ color: '#1677ff' }} />
                <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>策略说明</span>
                <Tag color={isSent ? 'purple' : isKeyBlock ? 'orange' : curIsEmo3 ? 'gold' : 'blue'} style={{ marginLeft: 8 }}>
                  {(notes?.group) || (isSent ? '情绪游资系列' : isKeyBlock ? '重点板块系列' : curIsEmo3 ? '三日情绪冰点系列' : '常规策略')}
                </Tag>
              </div>
            }
          >
            {/* 基本信息卡片 */}
            <div style={{ background: '#f7f9fc', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#6b7890', marginBottom: 4 }}>当前选中策略</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>{label}</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, fontFamily: "'SF Mono', monospace" }}>{strategy}</div>
            </div>

            {/* 策略专属说明（选股口径/触发时点等） */}
            {notes?.bullets && notes.bullets.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#12213a', marginBottom: 10 }}>
                  🎯 本策略专属说明
                </div>
                <div style={{
                  border: '1px solid #e6f0ff', background: '#f0f6ff', borderRadius: 8,
                  padding: '12px 14px', fontSize: 12.5, color: '#12213a', lineHeight: 1.9,
                }}>
                  {notes.bullets.map((b, i) => (
                    <div key={i} style={{ marginBottom: i < notes.bullets.length - 1 ? 6 : 0 }}>
                      • {renderBold(b, `note-${i}`)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 通用买入/卖出规则（Tab 切换） */}
            <Tabs
              defaultActiveKey="buy"
              items={[
                {
                  key: 'buy',
                  label: `买入规则（${buyRules.length} 条）`,
                  children: (<div style={{ height: 400, overflowY: 'auto' }}>{buyRules.map(ruleRow)}</div>),
                },
                {
                  key: 'sell',
                  label: `卖出规则（${sellRules.length} 条）`,
                  children: (<div style={{ height: 400, overflowY: 'auto' }}>{sellRules.map(ruleRow)}</div>),
                },
              ]}
            />
          </Modal>
        );
      })()}
    </Drawer>
  );
};

export default BacktestDrawer;
