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
const { isStockInWatchlistAt, getMonitorStocks } = require('./monitorStock');
const { batchParallel } = require('../utils');
const { getKeyBlockConstituents, getKeyBlockTagMap, ensureKeyBlockBars, ensureBarsForCodes, stockWindowGain, getStockCloseOnOrBefore, getHistoricalLianbanDefenseStocks, scanAllLianbanCodesInRange, getHongliMultiLianbanStocks, scanHongliMultiLianbanCodesInRange } = require('./keyBlockData');
const { loadIndexKline } = require('./sentimentHotMoney');
const { isOscExcluded, runWithOscExclude } = require('./backtestOscContext');
const { getSimContext, isSimStock, runWithSimContext } = require('./backtestSimContext');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const SELL_CONDITION_PERSIST_MIN = 5; // 卖出条件持续满足分钟数

// 回测排除的股票（不参与任何策略的回测）
const EXCLUDED_CODES = new Set(['sh688498', 'sh688808']); // 源杰科技、联讯仪器

// 重点板块-N日最高涨幅系列统一描述（keyBlockDays: N；板块 tag = 进攻/中性/防御，在 key_blocks 页面维护；
// 个股涨幅由回测时重新拉取成分股日K现算）
const KEY_BLOCK_DESC = (n) => `唯一买卖开关 = 创业板指 3 日线斜率（MA3 − 5个交易日前的MA3；当日收盘价用盘中实时价代替，不等收盘，逐桶实时判定）的正负翻转，不需要资金、成交量、情绪等任何条件配合。进攻（自选科技股）：斜率由负转正的桶触发买入，买自选股（monitor_stocks.json 中 isTech ≠ false 的科技股，含添加时间门禁）中最近 ${n} 个交易日（含触发日）个股涨幅之和最大的一只；卖点沿用通用 7 条件卖出诊断（「跌破成本线」为 -2%，即现价 < 买入价 × 0.98）；卖点诊断卖出后若斜率仍为正，当日不再买入，等到次日开盘 10 分钟后（9:40 桶）复测斜率仍为正才再买 ${n} 日涨幅最大的科技股（复测时斜率已为负则改由「由正转负」防御信号驱动）。防御（防御+中性 tag 板块）：斜率由正转负且当前空仓的桶触发买入，买防御+中性 tag 板块成分股中 ${n} 日涨幅最大的一只；防御对应创业板情绪低迷期，按半仓买入，该笔收益率（含期末浮盈）在概览的整体收益与平均/最大回撤统计中一律按半仓（×0.5）折算；唯一卖点 = 斜率由负转正 ∪ 个股分时价跌破成本线 -5% 止损（双卖点任一先触发即卖，同桶可转手买入进攻科技股）。买入时点涨停股不可买（主板涨幅 > 9.5%、创业板/科创板涨幅 > 19% 视为涨停），顺延到 ${n} 日涨幅排名的下一只；候选全部不可买时在斜率状态不变的后续桶持续重试；买入价取触发桶分时价；同桶允许先卖后买转手。回测首个交易日之前的斜率符号取前一交易日收盘口径作为初值，首个交易日无翻转则不建仓`;

// 逆周期情绪游资-N日涨幅最大系列统一描述（iceMode: true；复用重点板块引擎 runKeyBlockBacktest）：
// 信号指数 = 上证指数 3 日线斜率（与重点板块系列的创业板口径不同、且方向相反）——斜率为正买入、为负卖出；
// 候选池 = 「防御+中性」tag 板块成分股 ∪ 近20交易日 lianbanSnapshot 中出现过三板及以上连板的红利板块（hongliName.json）个股，全仓；转正事件次日 9:40 空仓可补买一次
const ICE_DESC = (n) => `逆周期情绪游资系列：唯一买卖开关 = 上证指数 3 日线斜率（MA3 − 5个交易日前的MA3；当日收盘价用盘中实时价代替，逐桶实时判定）的正负方向——斜率为正买入、为负卖出，不需要资金/成交量/情绪等任何条件配合。买点：斜率由负转正、且当前空仓、且前一交易日收盘口径斜率为负（即「前一日为负、今日盘中才转正」才算一次出手机会，前一日收盘已为正时今日盘中由负转正不计）时，在转正当日 **9:40 及以后**的桶执行买入（至少等到 9:40，给抗分歧分数留出盘中分时计算窗口），或在同一转正事件的次日开盘 10 分钟后（9:40 桶）空仓补买一次，买入重点板块中 tag 为「防御」「中性」的全部板块成分股（去重、剔除 ST）**并额外加入**近 20 个交易日 lianbanSnapshot 中属红利板块名单（hongliName.json）的板块内**出现过连板数 ≥ 3（三板及以上）**的个股（即这 20 天内曾走出过三板及以上连板的红利板块个股），两者合并去重后取最近 ${n} 个交易日（不含当日，截至前一交易日收盘）个股涨幅之和最大的一只，全仓买入。卖点：上证指数 3 日线斜率分时由正转负 ∪ 个股分时价跌破成本线 -2% 止损 ∪ 当日 14:55 检查 K 线形态（下影线 ≥ 实体长度 2 倍即 14:55 按分时价强制卖出），任一先触发即卖（买入次日起生效）。买入时点涨停股不可买（主板涨幅 > 9.5%、创业板/科创板涨幅 > 19% 视为涨停），顺延到 ${n} 日涨幅排名的下一只；候选全部不可买时在后续桶持续重试（转正次日起仅在 9:40 及以后的桶重试）；买入价取触发桶分时价。买入时点抗分歧指数需 ≥ 9（不足者按 ${n} 日涨幅排名顺延至下一只；防御股不跟与科技绑定的创业板指——主板（60/00）跟踪上证指数 sh000001、创业板（30）跟踪创业板指 sz399006、科创板（68）跟踪科创 50 sh000688；分时不足 5 分钟无法计算时放行）。回测首个交易日之前的斜率符号取前一交易日收盘口径作为初值，首个交易日无转正则不建仓`;

// 情绪开关系列阈值（prev{N}d_fall_low5_day_gain_emoswitch，2026-10-03 用户新增）：
// 触发买点时取上一交易日科技情绪指数的 3 日 EMA（getTechEmotionEmaMap，与情绪页「三日均值」曲线同源同算法），
// 低于该阈值 → 使用「前N日波动最小&当日涨幅最大」选股；否则 → 使用「3日涨幅最大」选股
const EMO_SWITCH_EMA_THRESHOLD = -60;

// 情绪开关系列统一描述（须定义在 STRATEGIES 之前：策略 desc 在模块加载时即求值）
const EMO_SWITCH_DESC = (n) => `买点命中时先取上一交易日科技情绪指数的 3 日 EMA（tech_index.json 每日收盘情绪分，与情绪页「三日均值」曲线同源同算法，不含当日）：低于 -60 时按「前 ${n} 个交易日（不含今日）累计涨幅绝对值最小的前五（波动最小，无论涨跌）→ 组内当日实时涨幅最大」选股买入，否则按「3 日涨幅最大（前 2 个交易日收盘涨幅 + 当日触发时点实时涨幅复利累计）」选股买入；EMA 缺失（无上一交易日或数据未覆盖）时按「否则」分支处理。两分支共用通用机制：触发时点涨停股不可买顺延至排名下一只、全局最低抗分歧门槛（≥9）、自选股添加时间门禁与跨指数双门禁照常生效`;

// 快进快出「温和回升」触发区间：上上个、上个交易日的当日科技情绪原始分（非 3 日 EMA）
// 均需严格处于该开区间且逐日回升
const EMO_QUICK_RANGE_LOW = -30;
const EMO_QUICK_RANGE_HIGH = 20;

// 情绪快进快出系列统一描述（highest_{N}d_gain_emoquick，2026-10-03 用户新增）：
// 买点触发时均可正常买入（不跳过）；满足以下任一条件的日子买入 → 次日 10:00 强制卖出：
//   1) 上一交易日科技情绪指数的 3 日 EMA（与情绪开关同源同算法）低于 -60
//   2) 上上个、上个交易日的当日科技情绪原始分（非 3 日 EMA）均处 (-30, 20) 区间且上个 > 上上个（情绪温和回升）
// 2026-10-09 叠加：10:00 强卖豁免（见 buildQuickOutExemptInfo）——强卖前先做两种「次日强势」判断，
//   命中任一不强卖、持仓转由通用 7 条件卖点接管：① 10:00 前（含）买点诊断再次触发；
//   ② 10:00 时点科技情绪>0 且自选股低于开盘价<30只且主力资金净流入>0（三者同时满足）
const EMO_QUICK_EXEMPT_DESC = '2026-10-09 新增「10:00 强卖豁免」：强卖前先做两种次日强势判断，命中任一则本次不强卖、持仓转由通用 7 条件卖点接管（-2% 成本线止损仍先到先卖）：① 次日 10:00 前（含 10:00）买点诊断再次触发；② 次日 10:00 时点科技情绪 > 0、自选股低于开盘价个股 < 30 只、主力资金净流入 > 0 三者同时满足';
const EMO_QUICK_DESC = (n) => `买点命中时按「${n} 日涨幅最大」选股买入${n === 2 ? '（排序依据为触发时点当日盘中涨幅，非 2 日窗口累计涨幅）' : `（最近 ${n} 个交易日涨幅最大）`}，买点触发时均可正常买入、不跳过；买入时先取上一交易日科技情绪指数的 3 日 EMA 与上两个交易日的当日科技情绪原始分（tech_index.json 每日收盘情绪分，与情绪页同源，EMA 不含当日、当日分即当日收盘值），满足以下任一条件则本次买入标记为「快进快出」——该笔持仓不走通用 7 条件卖点，买入次日上午 10:00 强制卖出（取当日第一个 ≥10:00 的分时点价格，分时未覆盖 10:00 时取当日最后一分钟，当日无该股分时数据时顺延至后续日期重试），且买入次日盘中跌破成本线 -2%（买入价 × 0.98，口径与通用条件7一致：开盘首分钟已破线走竞价自救窗口、首次分钟回落即卖；盘中才破线则即时止损）时先到先卖、提前止损离场，强卖/止损当日禁止二次买入（哪怕买点再次触发也不买）：① 上一交易日 3 日 EMA 低于 -60；② 上上个与上个交易日的当日科技情绪均处于 -30~20 区间（不含边界）且上个交易日高于上上个交易日（情绪温和回升）；两条件均不满足（或数据缺失）时为普通持仓，走通用 7 条件卖点。${EMO_QUICK_EXEMPT_DESC}。涨停顺延、全局最低抗分歧门槛（≥9）、自选股添加时间门禁与跨指数双门禁照常生效`;

// 快进快出 × 研报覆盖双门策略描述（highest_3d_reports_top5_gain_emoquick，2026-10-04 用户新增）：
// 在 highest_3d_gain_emoquick 的基础上：仅当触发「上一交易日 3 日 EMA < -60」这条快进快出路径时，
// 选股口径从「3日涨幅最大」改为「最近 3 日研报覆盖数前五（含并列）→ 组内 3 日涨幅最大」；
// 温和回升快进快出路径 / 非快进快出路径 仍走原 3 日涨幅最大选股
const EMO_QUICK_REPORTS_DESC = `买点命中时均可正常买入、不跳过；满足以下任一条件则本次买入标记为「快进快出」——该笔持仓不走通用 7 条件卖点，买入次日上午 10:00 强制卖出（取当日第一个 ≥10:00 的分时点价格，分时未覆盖 10:00 时取当日最后一分钟，当日无该股分时数据时顺延至后续日期重试），且买入次日盘中跌破成本线 -2%（买入价 × 0.98，口径与通用条件7一致：开盘首分钟已破线走竞价自救窗口、首次分钟回落即卖；盘中才破线则即时止损）时先到先卖、提前止损离场，强卖/止损当日禁止二次买入（哪怕买点再次触发也不买）：① 上一交易日科技情绪 3 日 EMA < -60；② 上上个与上个交易日的当日科技情绪均处于 -30~20 区间（不含边界）且上个交易日高于上上个交易日（情绪温和回升）。选股口径分三路：走①时先取「最近 3 日研报覆盖数前五（含并列，仅统计买点前已创建的研报）」形成候选池，再从中选 3 日涨幅最大的一只（博弈反弹提胜率）；走②或两条件均不满足时仍按「3 日涨幅最大」选股（最近 3 个交易日涨幅之和最大）。${EMO_QUICK_EXEMPT_DESC}。涨停顺延、全局最低抗分歧门槛（≥9）、自选股添加时间门禁与跨指数双门禁照常生效`;

// 科技板块前三 × N日涨幅最大 × 快进快出系列统一描述（tech_block_top3_{N}d_gain_emoquick，2026-10-06 用户新增）：
// 与 highest_{N}d_gain_emoquick 完全一致（快进快出触发条件、次日 10:00 强卖、盘中 -2% 止损、否则走通用卖点均不变），
// 唯一区别在选股口径——增加一层板块效应筛选：
//   买点触发时，取当日重点板块（block_code.js，key_blocks 页面维护）中 tag = 进攻 的板块，
//   按「板块盘中涨幅」（= 该板块成分股在买点触发时点的实时涨幅均值，与 key_blocks 页面盘中 avgChange 同口径，不含收盘价前视）降序取前三，
//   把这 3 个板块的全部成分股与「全量自选股中 isTech ≠ false 的科技股」取交集，再在交集内按最近 N 个交易日涨幅之和最大选一只买入
const TECH_TOP3_BLOCK_DESC = (n) => `与「${n}日涨幅最大&三日情绪-60快进快出」完全一致，唯一区别在选股口径增加一层板块效应筛选：买点触发时，先取当日重点板块（block_code.js，key_blocks 页面维护）中 tag 为「进攻」的板块，按板块盘中涨幅（= 该板块成分股在买点触发时点的实时涨幅均值，与 key_blocks 页面盘中 avgChange 同口径，不含收盘价前视）降序取前三个板块；把这 3 个板块的全部成分股与「全量自选股（monitor_stocks.json）中 isTech ≠ false 的科技股」取交集，再在交集内按最近 ${n} 个交易日涨幅之和最大选一只买入（与常规「${n}日涨幅最大」同口径）。卖点与 highest_${n}d_gain_emoquick 完全一致：满足以下任一快进快出条件则次日 10:00 强制卖出、盘中跌破成本线 -2% 先到先卖（强卖/止损当日禁止二次买入），否则走通用 7 条件卖点——① 上一交易日科技情绪 3 日 EMA < -60；② 上上个与上个交易日当日科技情绪均处于 -30~20 区间（不含边界）且回升。${EMO_QUICK_EXEMPT_DESC}。涨停顺延、全局最低抗分歧门槛（≥9）、自选股添加时间门禁与跨指数双门禁照常生效`;

// 两次买入（分批建仓）系列统一描述（highest_{N}d_gain_two_buy，2026-10-08 用户重构）：
// 在「N日涨幅最大 & 快进快出」（highest_{N}d_gain_emoquick）基础上做的分批建仓变体：
// 买点首次触发先买入 5 成（第一份），之后若买点再次触发、且距离第一份建仓日已间隔至少一个交易日（次日及以后），
// 再买入 5 成（第二份）——第二份必须买入与第一份完全相同的股票标的，不按 N 日涨幅重新择股；
// 目的：避免一次性全仓时上午脉冲触发买点、随后大幅回落被套，需大盘持续拉升一段时间才确认建仓。
// 两份仓位各自独立买卖、独立计算收益（均按半仓 0.5 折算），互不摊平成本：
//   各自以自身买入价计算跌破成本线 -2% 止损（阈值 = 自身买入价 × 0.98），
//   卖点完全沿用「N日涨幅最大&快进快出」规则（买入日快进快出则次日 10:00 强卖 + 盘中跌破成本线 -2% 先到先卖，
//   否则通用 7 条件），每份仓位产生一条独立交易记录（不合并）。选股口径与「N日涨幅最大」完全一致。
const TWO_BUY_DESC = (n) => `在「${n}日涨幅最大&三日情绪-60快进快出」基础上做的分批建仓变体：买点首次触发先买入 5 成（第一份），之后若买点再次触发、且距离第一份建仓日已间隔至少一个交易日（次日及以后），再买入 5 成（第二份）——第二份必须买入与第一份完全相同的股票标的（不按 ${n} 日涨幅重新择股），且买入时点该股已涨停（主板>9.5%、创业/科创>19%）则本次放弃、保持半仓等待下次买点。两份仓位各自独立买卖、独立计算收益（均按半仓 0.5 折算，不摊平成本）：各自以自身买入价计算跌破成本线 -2% 止损（阈值 = 自身买入价 × 0.98），卖点完全沿用「${n}日涨幅最大&三日情绪-60快进快出」——买入日上一交易日科技情绪 3 日 EMA < -60（或上两交易日当日科技情绪均处 -30~20 区间且回升）的持仓次日 10:00 强制卖出、强卖当日禁止二次买入，且盘中跌破成本线 -2% 先到先卖止损；否则走通用 7 条件卖点。${EMO_QUICK_EXEMPT_DESC}（豁免按每份仓位独立判定）。每份仓位产生一条独立交易记录（不合并、不摊平成本）。选股口径与「${n}日涨幅最大」完全一致：买点触发时从全量自选科技股中买入最近 ${n} 个交易日涨幅之和最大的一只；跨指数双门禁、全局最低抗分歧门槛 ≥ 9、顺/逆周期过滤照常生效`;

// 「N.5 日涨幅最大」窗口口径（2026-10-08 用户新增）：在常规「N 日涨幅最大」（最近 N 个交易日含触发日涨幅之和）
// 基础上，额外复利计入「更前一个交易日（窗口最早交易日的再前一交易日，0.5 日）下午 13:00 开盘至收盘」的涨幅。
// 例：触发日 8.4 的 3.5 日窗口 = 8.1 下午 13:00→收盘 + 8.2 + 8.3 + 8.4 三个完整交易日。
// 「2.5 日」同理：2 日窗口（8.3、8.4）+ 8.2 下午 13:00→收盘。半日涨幅按该交易日回放桶现算
// （13:00 后首个桶价 → 当日收盘价），该股当日无下午分时则本次候选按无效处理。
const HALF_DAY_NOTE = (n) => `「${n}.5 日涨幅最大」口径：在常规最近 ${n} 个交易日（含触发日）涨幅之和的基础上，额外复利计入「更前一个交易日（窗口最早交易日的再前一交易日）下午 13:00 开盘至收盘」的半日涨幅；例：触发日 8.4 的 ${n}.5 日窗口 = ${n}.1 下午 13:00→收盘 + ${n}.2~${n}.4 共 ${n} 个完整交易日；半日涨幅按该交易日回放分时现算（13:00 后首个桶价 → 当日收盘价），该股当日无下午分时则本次候选按无效处理`;
const HIGHEST_HALF_DESC = (n) => `买点命中时只买入${HALF_DAY_NOTE(n)}所定义口径下涨幅最大的一只自选科技股`;
const EMO_QUICK_HALF_DESC = (n) => `${EMO_QUICK_DESC(n)}；特别说明：本策略的选股窗口采用 ${HALF_DAY_NOTE(n)}`;
const TECH_TOP3_HALF_DESC = (n) => `${TECH_TOP3_BLOCK_DESC(n)}；特别说明：本策略在交集内的 N 日涨幅窗口采用 ${HALF_DAY_NOTE(n)}`;
const TWO_BUY_HALF_DESC = (n) => `${TWO_BUY_DESC(n)}；特别说明：本策略的选股窗口采用 ${HALF_DAY_NOTE(n)}`;

// 两次买入「不同板块」系列统一描述（highest_{N}d_gain_two_buy_diff_block，2026-10-08 用户新增）：
// 在「N日涨幅最大&两次买入」基础上增加板块约束——第一份仍从全量自选科技股中选 N 日涨幅最大（不限板块）；
// 第二份不再买入第一份的同一只股票，而是在「所属板块（自选股 monitor_stocks.json 的 blockName 标识）
// 与第一份不同」的候选中，重新按 N 日涨幅最大择股买入。其余（半仓、各自独立买卖、快进快出、-2% 止损、
// 双门禁/抗分歧/周期过滤/涨停顺延等）与「N日涨幅最大&两次买入」完全一致
const TWO_BUY_DIFF_BLOCK_DESC = (n) => `在「${n}日涨幅最大&两次买入」基础上增加板块约束的分批建仓变体：买点首次触发先买入 5 成（第一份），从全量自选科技股中买入最近 ${n} 个交易日涨幅之和最大的一只（不限板块）；之后若买点再次触发、且距离第一份建仓日已间隔至少一个交易日（次日及以后），再买入 5 成（第二份）——第二份不再买入第一份的同一只股票，而是在「所属板块（自选股 monitor_stocks.json 的 blockName 板块标识）与第一份不同」的候选中，重新按最近 ${n} 个交易日涨幅之和最大选一只买入（即其他板块中 ${n} 日涨幅最大的个股）；若其他板块中无有效候选（或候选均被涨停/抗分歧/周期等过滤）则本次不补买、保持半仓等待下次买点。两份仓位各自独立买卖、独立计算收益（均按半仓 0.5 折算，不摊平成本）：各自以自身买入价计算跌破成本线 -2% 止损，卖点完全沿用「${n}日涨幅最大&快进快出」规则（买入日快进快出则次日 10:00 强卖 + 盘中跌破成本线 -2% 先到先卖，否则通用 7 条件），每份仓位产生一条独立交易记录。${EMO_QUICK_EXEMPT_DESC}（豁免按每份仓位独立判定）。选股窗口、跨指数双门禁、全局最低抗分歧门槛 ≥ 9、顺/逆周期过滤、涨停与一字板顺延均与「N日涨幅最大&两次买入」一致`;

// 回测策略定义（全部为单股策略：买点命中时只选指标最优的一只买入）
const STRATEGIES = {
  highest_gain: { id: 'highest_gain', name: '买入最高涨幅', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票' },
  highest_2d_gain: { id: 'highest_2d_gain', name: '2日涨幅最大', desc: '买点命中时只买入触发时点当日盘中涨幅最大的股票（按用户定义排序依据为触发时点当日盘中涨幅，非 2 日窗口累计涨幅）' },
  highest_3d_gain: { id: 'highest_3d_gain', name: '3日涨幅最大', desc: '买点命中时只买入最近 3 个交易日涨幅最大的股票' },
  highest_4d_gain: { id: 'highest_4d_gain', name: '4日涨幅最大', desc: '买点命中时只买入最近 4 个交易日涨幅最大的股票' },
  highest_5d_gain: { id: 'highest_5d_gain', name: '5日涨幅最大', desc: '买点命中时只买入最近 5 个交易日涨幅最大的股票' },
  highest_10d_gain: { id: 'highest_10d_gain', name: '10日涨幅最大', desc: '买点命中时只买入最近 10 个交易日涨幅最大的股票' },

  // N.5 日涨幅最大系列（highest_{N}d5_gain，2026-10-08 用户新增）：halfDayAfternoon: true → 选股窗口在
  // 最近 N 个交易日基础上额外复利计入「更前一个交易日（窗口最早日的再前一交易日）下午 13:00→收盘」的半日涨幅
  highest_2d5_gain: { id: 'highest_2d5_gain', name: '2.5日涨幅最大', desc: HIGHEST_HALF_DESC(2), halfDayAfternoon: true },
  highest_3d5_gain: { id: 'highest_3d5_gain', name: '3.5日涨幅最大', desc: HIGHEST_HALF_DESC(3), halfDayAfternoon: true },

  // 两次买入（分批建仓）系列（highest_{N}d_gain_two_buy，2026-10-08 用户新增；twoBuy: true → 独立分批建仓逻辑）：
  // 买点首次触发买入 5 成（第一份），之后若买点再次触发、且距离第一份建仓日已间隔至少一个交易日，再买入 5 成（第二份）；
  // 第二份必须买入与第一份相同的股票标的；两份仓位各自独立买卖（各半仓），跌破成本线 -2% 止损（默认口径，不摊平成本）；
  // emoQuickOut: true → 叠加「快进快出」能力（情绪冰点/温和回升日买入的持仓次日 10:00 强卖 + 盘中跌破成本线 -2% 先到先卖）
  highest_2d_gain_two_buy: { id: 'highest_2d_gain_two_buy', name: '2日涨幅最大&两次买入', desc: TWO_BUY_DESC(2), twoBuy: true, emoQuickOut: true },
  highest_3d_gain_two_buy: { id: 'highest_3d_gain_two_buy', name: '3日涨幅最大&两次买入', desc: TWO_BUY_DESC(3), twoBuy: true, emoQuickOut: true },
  highest_4d_gain_two_buy: { id: 'highest_4d_gain_two_buy', name: '4日涨幅最大&两次买入', desc: TWO_BUY_DESC(4), twoBuy: true, emoQuickOut: true },
  highest_5d_gain_two_buy: { id: 'highest_5d_gain_two_buy', name: '5日涨幅最大&两次买入', desc: TWO_BUY_DESC(5), twoBuy: true, emoQuickOut: true },
  // 两次买入 × N.5 日窗口（2026-10-08 用户新增）
  highest_2d5_gain_two_buy: { id: 'highest_2d5_gain_two_buy', name: '2.5日涨幅最大&两次买入', desc: TWO_BUY_HALF_DESC(2), twoBuy: true, emoQuickOut: true, halfDayAfternoon: true },
  highest_3d5_gain_two_buy: { id: 'highest_3d5_gain_two_buy', name: '3.5日涨幅最大&两次买入', desc: TWO_BUY_HALF_DESC(3), twoBuy: true, emoQuickOut: true, halfDayAfternoon: true },
  // 两次买入 × 不同板块（highest_{N}d_gain_two_buy_diff_block，2026-10-08 用户新增）：
  // 第一份同「N日涨幅最大」（不限板块）；第二份在「板块（blockName）与第一份不同」的候选中重新按 N 日涨幅最大择股
  // diffBlock: true → 第二份改为限制板块差异的重新择股（见 runRangeBacktestInner / runRangeBacktestMulti）
  highest_2d_gain_two_buy_diff_block: { id: 'highest_2d_gain_two_buy_diff_block', name: '2日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(2), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_3d_gain_two_buy_diff_block: { id: 'highest_3d_gain_two_buy_diff_block', name: '3日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(3), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_4d_gain_two_buy_diff_block: { id: 'highest_4d_gain_two_buy_diff_block', name: '4日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(4), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_5d_gain_two_buy_diff_block: { id: 'highest_5d_gain_two_buy_diff_block', name: '5日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(5), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_3d_ma_slope: { id: 'highest_3d_ma_slope', name: '3日线斜率最陡峭', desc: '买点命中时只买入 3 日涨幅均线斜率角度最大的股票' },
  highest_5d_ma_slope: { id: 'highest_5d_ma_slope', name: '5日线斜率最陡峭', desc: '买点命中时只买入 5 日涨幅均线斜率角度最大的股票' },
  highest_3d_reports: { id: 'highest_3d_reports', name: '3日研报覆盖数最多', desc: '买点命中时只买入过去 3 个交易日（含当日）研报覆盖数最多的股票（覆盖数相同取 3 日涨幅最大）；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_reports: { id: 'highest_5d_reports', name: '5日研报覆盖数最多', desc: '买点命中时只买入过去 5 个交易日（含当日）研报覆盖数最多的股票（覆盖数相同取 5 日涨幅最大）；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_3d_reports_top5_gain: { id: 'highest_3d_reports_top5_gain', name: '3日研报前五&涨幅最大', desc: '买点命中时在最近 3 个交易日（含当日）研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_reports_top5_gain: { id: 'highest_5d_reports_top5_gain', name: '5日研报前五&涨幅最大', desc: '买点命中时在最近 5 个交易日（含当日）研报覆盖数前五（含覆盖数相同的股票）中买入 5 日涨幅最大的一只；覆盖仅统计买点前已创建的研报，买点后补录的不计入' },
  highest_5d_resilience: { id: 'highest_5d_resilience', name: '5日抗分歧分数最大', desc: '买点命中时只买入最近 5 个交易日抗分歧分数汇总最大的股票' },
  highest_3d_resilience: { id: 'highest_3d_resilience', name: '3日抗分歧分数最大', desc: '买点命中时只买入最近 3 个交易日抗分歧分数汇总最大的股票' },
  resilience_weak_to_strong: { id: 'resilience_weak_to_strong', name: '抗分歧弱转强', desc: '买点命中时先筛选出当日抗分歧分数>11 的股票，再从中计算最近 4 个交易日「前两天均值」与「最近两天均值」的差值（差值越大=抗分歧由弱转强越明显），全仓买入差值最大的股票；差值相同则买入当日涨幅最大的一只' },

  // 当日实时口径系列（2026-10-03 用户新增）：抗分歧分数/当日涨幅/3 日涨幅均按买点触发时刻的分时数据实时计算，不取当日收盘状态
  highest_1d_resilience: { id: 'highest_1d_resilience', name: '当日抗分歧分数最大', desc: '买点命中时只买入触发时点当日实时抗分歧分数最大的股票（抗分歧分数按触发时刻截至当时的日内分时数据实时计算，非收盘口径）；分数相同时取触发时点当日实时涨幅最大的一只' },

  // 情绪开关系列（2026-10-03 用户新增）：上一交易日科技情绪 3 日 EMA < -60 → 前N日波动最小&当日涨幅最大，否则 → 3日涨幅最大
  prev3d_fall_low5_day_gain_emoswitch: { id: 'prev3d_fall_low5_day_gain_emoswitch', name: '前三波动最小&当日涨最大/3日涨幅开关', desc: EMO_SWITCH_DESC(3) },
  prev2d_fall_low5_day_gain_emoswitch: { id: 'prev2d_fall_low5_day_gain_emoswitch', name: '前二波动最小&当日涨最大/3日涨幅开关', desc: EMO_SWITCH_DESC(2) },
  prev1d_fall_low5_day_gain_emoswitch: { id: 'prev1d_fall_low5_day_gain_emoswitch', name: '昨日波动最小&当日涨最大/3日涨幅开关', desc: EMO_SWITCH_DESC(1) },

  // 情绪快进快出系列（2026-10-03 用户新增）：买点触发时均可正常买入；上一交易日科技情绪 3 日 EMA < -60
  // 的日子买入 → 该笔持仓次日 10:00 强制卖出（不走通用卖点），否则走通用卖点；
  // 2026-10-05 叠加：持仓次日盘中跌破成本线 -2% 先到先卖止损（口径与通用条件7一致，见每日预桶快进快出卖点）
  // 2026-10-09 叠加：10:00 强卖豁免（buildQuickOutExemptInfo）——次日强势判断命中任一不强卖、转由通用卖点接管
  highest_2d_gain_emoquick: { id: 'highest_2d_gain_emoquick', name: '2日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(2), emoQuickOut: true },
  highest_3d_gain_emoquick: { id: 'highest_3d_gain_emoquick', name: '3日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(3), emoQuickOut: true },
  highest_4d_gain_emoquick: { id: 'highest_4d_gain_emoquick', name: '4日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(4), emoQuickOut: true },
  highest_5d_gain_emoquick: { id: 'highest_5d_gain_emoquick', name: '5日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_DESC(5), emoQuickOut: true },
  // 快进快出 × N.5 日窗口（2026-10-08 用户新增；选股窗口额外计入更前一个交易日下半日涨幅）
  highest_2d5_gain_emoquick: { id: 'highest_2d5_gain_emoquick', name: '2.5日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_HALF_DESC(2), emoQuickOut: true, halfDayAfternoon: true },
  highest_3d5_gain_emoquick: { id: 'highest_3d5_gain_emoquick', name: '3.5日涨幅最大&三日情绪-60快进快出', desc: EMO_QUICK_HALF_DESC(3), emoQuickOut: true, halfDayAfternoon: true },
  // 快进快出 × 研报覆盖双门策略：仅当快进快出的触发条件是「上一交易日 3 日 EMA < -60」时，
  // 选股口径从「3日涨幅最大」改为「最近 3 日研报覆盖数前五（含并列）→ 组内 3 日涨幅最大」；
  // 温和回升路径 / 非快进快出路径仍走原 3 日涨幅最大；卖出行为与 highest_3d_gain_emoquick 完全一致
  highest_3d_reports_top5_gain_emoquick: { id: 'highest_3d_reports_top5_gain_emoquick', name: '3日涨幅最大&三日情绪-60快进快出&研报覆盖', desc: EMO_QUICK_REPORTS_DESC, emoQuickOut: true },

  // 科技板块前三 × N日涨幅最大 × 快进快出系列（tech_block_top3_{N}d_gain_emoquick，2026-10-06 用户新增）：
  // 与 highest_{N}d_gain_emoquick 几乎完全一样（快进快出触发条件与卖点行为不变），唯一区别在选股策略——
  // 买点触发时先做板块效应筛选：当日 tag=进攻 的重点板块按板块盘中涨幅取前三，成分股与全量自选科技股取交集，
  // 再在交集内选 N 日涨幅最大的一只（板块盘中涨幅直接取回放桶 blockRanking.all，无需预拉成分股日K）
  tech_block_top3_2d_gain_emoquick: { id: 'tech_block_top3_2d_gain_emoquick', name: '科技板块前三&2日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(2), emoQuickOut: true },
  tech_block_top3_3d_gain_emoquick: { id: 'tech_block_top3_3d_gain_emoquick', name: '科技板块前三&3日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(3), emoQuickOut: true },
  tech_block_top3_4d_gain_emoquick: { id: 'tech_block_top3_4d_gain_emoquick', name: '科技板块前三&4日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(4), emoQuickOut: true },
  tech_block_top3_5d_gain_emoquick: { id: 'tech_block_top3_5d_gain_emoquick', name: '科技板块前三&5日涨幅最大&快进快出', desc: TECH_TOP3_BLOCK_DESC(5), emoQuickOut: true },
  // 科技板块前三 × N.5 日窗口（2026-10-08 用户新增；交集内选股窗口额外计入更前一个交易日下半日涨幅）
  tech_block_top3_2d5_gain_emoquick: { id: 'tech_block_top3_2d5_gain_emoquick', name: '科技板块前三&2.5日涨幅最大&快进快出', desc: TECH_TOP3_HALF_DESC(2), emoQuickOut: true, halfDayAfternoon: true },
  tech_block_top3_3d5_gain_emoquick: { id: 'tech_block_top3_3d5_gain_emoquick', name: '科技板块前三&3.5日涨幅最大&快进快出', desc: TECH_TOP3_HALF_DESC(3), emoQuickOut: true, halfDayAfternoon: true },

  // 重点板块-N日最高涨幅系列（keyBlockDays → 独立板块驱动回测 runKeyBlockBacktest：斜率双模式 + tag 板块选股，触发桶买入）
  key_block_2d_gain: { id: 'key_block_2d_gain', name: '重点板块-2日最高涨幅', desc: KEY_BLOCK_DESC(2), keyBlockDays: 2, costLinePct: 2 },
  key_block_3d_gain: { id: 'key_block_3d_gain', name: '重点板块-3日最高涨幅', desc: KEY_BLOCK_DESC(3), keyBlockDays: 3, costLinePct: 2 },
  key_block_4d_gain: { id: 'key_block_4d_gain', name: '重点板块-4日最高涨幅', desc: KEY_BLOCK_DESC(4), keyBlockDays: 4, costLinePct: 2 },
  key_block_5d_gain: { id: 'key_block_5d_gain', name: '重点板块-5日最高涨幅', desc: KEY_BLOCK_DESC(5), keyBlockDays: 5, costLinePct: 2 },

  // 逆周期情绪游资-N日涨幅最大系列（2026-10-04 用户新增；iceMode: true → 复用 runKeyBlockBacktest，
  // 但与大盘逆周期：斜率由正转负才买、转正即卖；只用「防御+中性」tag 板块，全仓；转负次日 9:40 可补买；
  // 成本线止损为 -2%（costLinePct: 2，区别于重点板块防御持仓的 -5%））
  hot_money_ice_2d_gain: { id: 'hot_money_ice_2d_gain', name: '逆周期情绪游资-前2日涨幅最大', desc: ICE_DESC(2), keyBlockDays: 2, iceMode: true, costLinePct: 2 },
  hot_money_ice_3d_gain: { id: 'hot_money_ice_3d_gain', name: '逆周期情绪游资-前3日涨幅最大', desc: ICE_DESC(3), keyBlockDays: 3, iceMode: true, costLinePct: 2 },
  hot_money_ice_4d_gain: { id: 'hot_money_ice_4d_gain', name: '逆周期情绪游资-前4日涨幅最大', desc: ICE_DESC(4), keyBlockDays: 4, iceMode: true, costLinePct: 2 },
  hot_money_ice_5d_gain: { id: 'hot_money_ice_5d_gain', name: '逆周期情绪游资-前5日涨幅最大', desc: ICE_DESC(5), keyBlockDays: 5, iceMode: true, costLinePct: 2 },
  hot_money_ice_10d_gain: { id: 'hot_money_ice_10d_gain', name: '逆周期情绪游资-前10日涨幅最大', desc: ICE_DESC(10), keyBlockDays: 10, iceMode: true, costLinePct: 2 },

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
  tail_dip_emo3_3d_reports_top5_gain: { id: 'tail_dip_emo3_3d_reports_top5_gain', name: '三日情绪冰点-3日研报前五&涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，在最近 3 个交易日研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只（覆盖仅统计买点前已创建的研报，买点后补录的不计入）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_1d_gain: { id: 'tail_dip_emo3_1d_gain', name: '三日情绪冰点-当日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入当日涨幅最大的股票（涨幅相同时取最近 2 个交易日涨幅最大的一只）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_1d_fall: { id: 'tail_dip_emo3_1d_fall', name: '三日情绪冰点-当日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入当日跌幅最大的股票（跌幅相同时取最近 2 个交易日跌幅最大的一只）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
  tail_dip_emo3_1d_resilience: { id: 'tail_dip_emo3_1d_resilience', name: '三日情绪冰点-当日抗分歧最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：情绪页「三日均值」EMA 线（每日收盘情绪分递推，与 sentiment 页同源）当日读数 < -60 时命中，买入当日抗分歧分数最大的股票（分数相同时取最近 2 个交易日抗分歧分数汇总最大的一只）；专属卖点：次日竞价开盘涨幅为负 → 9:30 开盘直接卖出，开盘涨幅 ≥ 0（含 0~1%）→ 固定次日 10:00 卖出', tailDip: true, emoAvgBuy: true, nextDayOpenSell: true },
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
const isCycleFilterStrategy = (s) => !!s && s.tailDip !== true && s.emoAvgBuy !== true && s.iceMode !== true && s.keyBlockDays == null;
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
  // 两次买入策略可能同时持有多份（currentHoldings），逐份注入持仓交易日数
  (result.currentHoldings || []).forEach(h => apply(h, true));
  (result.stocks || []).forEach(st => {
    (st.trades || []).forEach(t => apply(t, false));
    apply(st.holding, true);
  });
  // 交易列表统一按买入时间排序（旧缓存/旧报告生成顺序为平仓顺序，读取时归一）
  if (Array.isArray(result.trades)) result.trades = sortTradesByBuyTime(result.trades);
  (result.stocks || []).forEach(st => {
    if (Array.isArray(st.trades)) st.trades = sortTradesByBuyTime(st.trades);
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

// 交易列表按买入时间升序排序（买入日升序，同日按买入时间升序），并按新顺序重编 seq：
// 两次买入系列两份仓位独立平仓，成交记录生成顺序 = 平仓顺序（卖出时间序），
// 展示统一按买入时间排序更符合直觉（不影响收益/胜率/回撤等统计，均为顺序无关计算）
const sortTradesByBuyTime = (trades) => {
  if (!Array.isArray(trades)) return trades;
  return [...trades]
    .sort((a, b) => {
      const da = String(a?.buyDate ?? '');
      const db = String(b?.buyDate ?? '');
      if (da !== db) return da < db ? -1 : 1;
      const ta = String(a?.buyTime ?? '');
      const tb = String(b?.buyTime ?? '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return 0;
    })
    .map((t, idx) => ({ ...t, seq: idx + 1 }));
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
let reportIndexCache = null; // { YYYYMMDD: { stockName: [createdAtMs, ...] } }（每条命中研报记录一次创建时间）
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
        // 记录该研报的创建时间（ms，UTC ISO 转绝对时间戳）；缺失/非法按 0（视为始终已存在）
        const createdAtMs = Date.parse(node.createdAt) || 0;
        for (const n of matchedNames) {
          if (!index[folderDate][n]) index[folderDate][n] = [];
          index[folderDate][n].push(createdAtMs);
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
// beforeTs：买点时间戳（ms）。传入时只统计 createdAt ≤ 买点时间的研报，
// 排除买点之后才录入（如盘后补录）的研报对历史回测统计的污染；不传则统计全部
const sumReportCount = (stockName, winDates, reportIndex, beforeTs) => {
  if (!stockName || !reportIndex) return 0;
  let count = 0;
  for (const d of winDates) {
    const day = reportIndex[d];
    if (!day) continue;
    const arr = day[stockName];
    if (!arr) continue;
    if (beforeTs == null) {
      count += arr.length;
    } else {
      for (const ts of arr) {
        if (ts <= beforeTs) count += 1;
      }
    }
  }
  return count;
};

/**
 * 获取某只股票最近 N 个报告日内（以 menu.json 文件夹名 YYYYMMDD 为报告日）
 * 标题或正文命中该股票名的全部研报（含 id / 标题 / 正文 / 报告日 / 更新时间）。
 * 报告日筛选窗口与 loadReportIndex 一致：研报目录中 ≤ 今日 的最近 N 个报告日。
 * stockNames 按「长名优先」匹配避免短名误配（与 loadReportIndex 保持一致）。
 */
const getStockRecentReports = (stockName, days = 5) => {
  if (!stockName) return [];
  const menuFile = path.join(researchReportsDir, 'menu.json');
  let menu;
  try {
    menu = JSON.parse(fs.readFileSync(menuFile, 'utf-8'));
  } catch (e) {
    return [];
  }

  // 收集所有 folderDate（只取 8 位数字，视作报告日）
  const allDates = new Set();
  const collectDates = (node) => {
    if (!node) return;
    if (node.type === 'folder') {
      const d = String(node.name || '');
      if (/^\d{8}$/.test(d)) {
        allDates.add(d);
      }
      for (const c of (node.children || [])) collectDates(c);
    }
  };
  for (const root of menu) collectDates(root);

  const today = dayjs().format('YYYYMMDD');
  const winDates = Array.from(allDates)
    .filter(d => d <= today)
    .sort()
    .slice(-days);

  if (winDates.length === 0) return [];
  const winSet = new Set(winDates);

  // 构造 stockNames（若只给了一个名字，取它自己即可；长名优先匹配）
  const stockNames = [stockName].sort((a, b) => b.length - a.length);

  const results = [];
  const walk = (node, folderDate) => {
    if (!node) return;
    if (node.type === 'folder') {
      const d = String(node.name || '');
      if (!/^\d{8}$/.test(d)) return;
      for (const child of (node.children || [])) walk(child, d);
    } else if (node.type === 'report') {
      if (!winSet.has(folderDate)) return;
      const id = String(node.id || '');
      if (!id) return;
      const content = readReportContent(id);
      const text = `${String(node.name || '')}\n${content}`;
      const matched = stockNames.some(n => n && text.includes(n));
      if (!matched) return;
      results.push({
        id,
        name: node.name || '',
        content: content || '',
        folderDate,
        updatedAt: node.updatedAt || '',
        createdAt: node.createdAt || '',
      });
    }
  };
  for (const root of menu) walk(root, null);

  // 按报告日降序、同一天内按更新时间降序
  results.sort((a, b) => {
    if (b.folderDate !== a.folderDate) return b.folderDate.localeCompare(a.folderDate);
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return results;
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
  // 资金明细文案（随买入原因汇总展示）：最近 5min 净流入差值
  const fundText = fundResult.hasData ? `5min 内资金净流入 ${fundDiff.toFixed(2)}亿` : null;
  const check = {
    id: 'fund_inflow',
    title: '最近 5min 资金净流入大于 20 亿',
    passed: checkFundPassed,
    value: fundResult.hasData ? `${fundDiff >= 0 ? '+' : ''}${fundDiff.toFixed(2)}亿` : '数据不足',
    fundText,
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
    // 豁免文案：明确说明「冰点期豁免成交量」，并带出实际量能变化数值（无数据时仅说明豁免）
    const exemptVolText = volumeResult.hasData
      ? `冰点期豁免成交量，成交量${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿`
      : '冰点期豁免成交量';
    return {
      check: {
        id: 'volume_expansion',
        title: '当前量能为正（今日累计成交额超昨日全天）',
        passed: true,
        exempted: true,
        value: exemptVolText,
        volumeText: exemptVolText,
        reason: volumeResult.hasData
          ? `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），${exemptVolText}`
          : `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），情绪已达冰点量能条件自动豁免`,
      },
      volumeResult,
    };
  }
  // 量能明细文案（随买入原因汇总展示）：最近 5min 成交量变化量
  const volumeText = volumeResult.hasData
    ? `成交量${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿`
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

// 当日科技情绪原始分 Map<'YYYYMMDD', changeSumResult>（tech_index.json 每日收盘情绪分，不做 EMA 平滑），
// 供快进快出「-30~20 温和回升」条件按当日情绪分判定（与 3 日 EMA 条件口径不同）
let techEmotionRawCache = null;
const getTechEmotionRawMap = (force = false) => {
  if (!force && techEmotionRawCache) return techEmotionRawCache;
  const map = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(TECH_INDEX_FILE, 'utf-8'));
    if (Array.isArray(arr)) {
      arr
        .filter(x => x && x.date != null && x.changeSumResult != null && !Number.isNaN(Number(x.changeSumResult)))
        .forEach(x => map.set(String(x.date), Number(x.changeSumResult)));
    }
  } catch (e) { /* 文件缺失/损坏时 map 为空，策略不触发 */ }
  techEmotionRawCache = map;
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
// 资金净流入/量能项额外附带明细数值（如「5min 内资金净流入 24.00亿」「成交量增加 120.00亿」「冰点期豁免成交量，成交量增加 50.00亿」）；
// buyChecks 为逐项明细（含数值与判定理由），allPassed !== true 时返回空
const buildBuyReasonFromDiag = (diagData) => {
  if (!diagData || diagData.allPassed !== true) return { buyReason: '', buyChecks: [] };
  const passedChecks = (diagData.checks || []).filter(c => c.passed);
  return {
    buyReason: passedChecks.map(c => (
      c.id === 'volume_expansion' && c.volumeText
        ? `${c.volumeText}`
        : c.id === 'fund_inflow' && c.fundText
          ? `${c.fundText}`
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
      ...(c.fundText ? { fundText: c.fundText } : {}),
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
  // 竞价低开自救窗口（2026-10-05 新增；2026-10-08 修订）：隔夜持仓当日竞价开盘价（首分钟价）已跌破成本线 -xx% 时，
  //   不在 9:30 直接止损——大低开往往开盘先直线拉升（资金自救），逐分钟跟踪：
  //   拉升过程中（尚未出现「某分钟价低于上一分钟」的回落）继续持有（即使仍在成本线下方）；
  //   若拉升把价格回补到阈值上方，则视为自救成功、不再止损，待后续再次跌破阈值时再卖；
  //   只有当「拉升结束、开始回落」且该回落分钟价仍跌破阈值时，才卖出（按该回落分钟价成交，卖出原因标注回落分钟）。
  //   若开盘价未跌破成本线、盘中才跌破 → 维持原即时止损（该卖就得卖）。
  const costLinePct = position?.costLinePct != null && Number.isFinite(Number(position.costLinePct)) ? Number(position.costLinePct) : 2;
  const costLineRatio = 1 - costLinePct / 100;
  const costLineThreshold = buyPrice !== null && buyPrice > 0 ? buyPrice * costLineRatio : null;
  const openBrokeCostLine = costLineThreshold !== null && openPrice != null && openPrice > 0 && openPrice < costLineThreshold;
  // 自救窗口观察：在截至当前桶的分时点中找首个「分钟价低于上一分钟、且该分钟价仍跌破阈值」的回落点
  //（stockPoints 已按分钟升序、过滤无效价）——若拉升已回补至阈值上方，此时的回落不计入；待再次跌破阈值并回落才触发
  let costLineFirstDecline = null;
  if (openBrokeCostLine) {
    for (let i = 1; i < stockPoints.length; i++) {
      if (stockPoints[i].lastPx < stockPoints[i - 1].lastPx && stockPoints[i].lastPx < costLineThreshold) {
        costLineFirstDecline = { minute: stockPoints[i].minute, lastPx: stockPoints[i].lastPx, prevMinute: stockPoints[i - 1].minute, prevPx: stockPoints[i - 1].lastPx };
        break;
      }
    }
  }
  const brokenCostLine = costLineThreshold !== null && closePrice < costLineThreshold;
  // 触发判定：开盘已破线 → 只在「回落且该分钟仍跌破阈值」时触发（回补至阈值上方则不再止损、待再次跌破再卖）；开盘未破线 → 原即时止损
  const condition7Satisfied = openBrokeCostLine ? costLineFirstDecline !== null : brokenCostLine;
  const fmtMinuteC7 = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
  // 精确分钟回溯（2026-10-05 新增）：回测按 5 分钟桶触发本卖点后，逐分钟回溯定位真实触发分钟并按该分钟分时价成交
  //（线上环境在触发当分钟即已卖出，桶级成交最多晚 4 分钟，回溯后回测更贴近实盘）：
  //   - 盘中破线：从桶前一分钟向回逐分钟检查是否仍跌破成本线阈值，直到首次不跌破（或回溯至 9:30 开盘）为止，
  //     取该段连续跌破区间的最早一分钟为成交分钟；若破线就发生在当前桶（前一分钟未跌破）→ 维持按桶价成交；
  //   - 开盘破线（自救窗口）：卖出分钟本就是「回落且该分钟仍跌破阈值」的精确分钟，成交价由桶价改为该回落分钟价
  //     （与线上在回落当分钟立即卖出一致）。
  let condition7PreciseSell = null; // { minute, price }
  if (condition7Satisfied && costLineThreshold !== null) {
    if (openBrokeCostLine) {
      if (costLineFirstDecline !== null) {
        condition7PreciseSell = { minute: costLineFirstDecline.minute, price: costLineFirstDecline.lastPx };
      }
    } else if (brokenCostLine) {
      let walkStart = -1;
      for (let i = stockPoints.length - 1; i >= 0; i--) {
        if (stockPoints[i].minute < minute) { walkStart = i; break; }
      }
      for (let i = walkStart; i >= 0; i--) {
        if (!(stockPoints[i].lastPx < costLineThreshold)) break;
        condition7PreciseSell = { minute: stockPoints[i].minute, price: stockPoints[i].lastPx };
      }
    }
  }
  const condition7 = {
    name: `跌破成本线-${costLinePct}%`,
    satisfied: condition7Satisfied,
    detail: costLineThreshold === null
      ? `该模拟持仓无买入价格，无法判断是否跌破成本线 -${costLinePct}%`
      : openBrokeCostLine
        ? (costLineFirstDecline !== null
          ? `竞价开盘 ${openPrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），自救拉升已于 ${fmtMinuteC7(costLineFirstDecline.minute)} 回落（${fmtMinuteC7(costLineFirstDecline.minute)} 价 ${costLineFirstDecline.lastPx.toFixed(2)} 低于 ${fmtMinuteC7(costLineFirstDecline.prevMinute)} 价 ${costLineFirstDecline.prevPx.toFixed(2)}）且仍跌破阈值，卖出，按回落分钟 ${fmtMinuteC7(costLineFirstDecline.minute)} 价格 ${costLineFirstDecline.lastPx.toFixed(2)} 成交`
          : `竞价开盘 ${openPrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），开盘后资金拉升中（尚无「回落且仍跌破阈值」信号；若回补至阈值上方则不自救止损、待再次跌破再卖），自救窗口观察中、暂不卖出`)
        : brokenCostLine
          ? `现价 ${closePrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），触发卖点${condition7PreciseSell !== null ? `；逐分钟回溯：实际于 ${fmtMinuteC7(condition7PreciseSell.minute)} 首次跌破（价 ${condition7PreciseSell.price.toFixed(2)}），按该分钟价格成交（桶级 ${displayTime}）` : '（破线发生在当前桶，按桶价成交）'}`
          : `现价 ${closePrice.toFixed(2)} 未跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），未触发`,
    subConditions: [
      { label: '买入价（成本线）', value: buyPrice !== null && buyPrice > 0 ? buyPrice.toFixed(2) : '--' },
      { label: `阈值（成本价-${costLinePct}%）`, value: costLineThreshold !== null ? costLineThreshold.toFixed(2) : '--' },
      { label: '开盘价（首分钟）', value: openPrice != null && openPrice > 0 ? openPrice.toFixed(2) : '--' },
      { label: '现价', value: closePrice.toFixed(2) },
      ...(openBrokeCostLine ? [{ label: '自救窗口', value: costLineFirstDecline !== null ? `已于 ${fmtMinuteC7(costLineFirstDecline.minute)} 回落（仍跌破阈值，卖出）` : '进行中（拉升中/已回补阈值上方，暂不卖）' }] : []),
      { label: '判断规则', value: openBrokeCostLine ? '开盘破线 → 拉升中持有；回补至阈值上方则不再止损、待再次跌破阈值再卖；回落时仍跌破阈值才卖。盘中破线 → 现价 < 成本价 × 阈值即时卖' : `现价 < 成本价 × ${costLineRatio.toFixed(2)} 即触发` },
    ],
  };

  const conditions = [condition1, condition2, condition3, condition4, condition5, condition6, condition7];
  const satisfiedCount = conditions.filter(c => c.satisfied).length;
  const isSell = satisfiedCount > 0;
  // 条件7 命中时用回溯出的精确触发分钟价/时间成交（对齐线上在触发当分钟即卖出的行为；尾盘抄底专属卖点同模式）
  const usePreciseSell = condition7Satisfied && condition7PreciseSell !== null;
  const finalSellPrice = usePreciseSell ? condition7PreciseSell.price : closePrice;
  const finalDisplayTime = usePreciseSell ? fmtMinuteC7(condition7PreciseSell.minute) : displayTime;
  const returnRate = buyPrice !== null && buyPrice > 0
    ? parseFloat((((finalSellPrice - buyPrice) / buyPrice) * 100).toFixed(2))
    : null;

  return {
    isSell,
    code,
    stockName,
    closePrice: parseFloat(finalSellPrice.toFixed(2)),
    change: change !== null ? parseFloat(change.toFixed(2)) : null,
    returnRate,
    dayHigh: dayHigh > 0 ? parseFloat(dayHigh.toFixed(2)) : null,
    techEmotion,
    resilienceScore,
    conditions,
    conclusion: isSell
      ? `共触发 ${satisfiedCount} 个卖出条件（${conditions.filter(c => c.satisfied).map(c => c.name).join('、')}），建议卖出离场${usePreciseSell ? `；按 ${finalDisplayTime} 分时价 ${finalSellPrice.toFixed(2)} 精确成交` : ''}`
      : '所有卖出条件均未触发，当前可继续持有',
    displayTime: finalDisplayTime,
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

// 真分钟级分时点映射（与前端 replayResilience.mapTlineLineToPoints 同规则）
const mapTlineToPoints = (tline) => (tline?.line || [])
  .filter(p => p && p.minute != null && p.last_px != null)
  .map(p => ({ minute: parseInt(p.minute), change: parseFloat(p.change || 0), lastPx: parseFloat(p.last_px) }))
  .sort((a, b) => a.minute - b.minute);

// 增强版回放数据构建：在训练营桶数据基础上，用真分钟级分时（getSingleStockTlineDataByDate 磁盘缓存，
// 与前端实时回放 /stock_tline_data 完全同源）替换股票与指数的 tlinePoints。
// 目的：消除 5 分钟桶粒度导致的口径偏差 —— 桶数据下抗分歧分数的 offenseScore（upRatio）样本不足会
// 显著偏低（例：景旺电子 2026-09-04 10:05 桶口径 8.96 vs 真分时口径 11.87，实时回放显示 11.6），
// 导致回测选股门槛（全局抗分歧 ≥9）与实时回放判定不一致。
// 单只拉取失败/无数据时保留原桶点回退（不阻塞回测）。合成股票走 getTlineCompat 的确定性分时。
const buildReplayStocksWithTline = async (campData, dateStr) => {
  const replayStocks = buildReplayStocks(campData);
  const dateNum = parseInt(dateStr, 10);
  if (!Number.isFinite(dateNum) || replayStocks.length === 0) return replayStocks;
  await Promise.all(replayStocks.map(async (s) => {
    try {
      const pts = mapTlineToPoints(await getSingleStockTlineDataByDate(s.code, dateNum));
      if (pts.length > 0) s.tlinePoints = pts;
    } catch (e) { /* 拉取失败保留桶点 */ }
  }));
  return replayStocks;
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

// ============================================================
// 「N.5 日涨幅最大」系列的 0.5 日成分缓存（2026-10-08 用户新增）：
// 0.5 日 = 更前一个交易日「下午 13:00 开盘 → 收盘」的涨幅（%）。
// 数据来源 = 该交易日回放桶（timeBuckets）中该股 minute >= 1300 的首个桶价 → 当日最后一个桶价（收盘）。
// 逐日回放时（含窗口预热日）在 extractDailyInfo 内顺带缓存，后续日期的选股直接查表（date → Map<code, pct>）。
// ============================================================
const afternoonGainCache = new Map(); // dateStr -> Map<code, pct>
const AFTERNOON_START_MINUTE = 1300;
const buildAfternoonGainMap = (campData) => {
  const buckets = campData?.timeBuckets || [];
  const firstPx = new Map(); // code -> 13:00 后首个桶价
  const lastPx = new Map(); // code -> 当日最后一个桶价（收盘）
  for (const b of buckets) {
    const m = Number(b.minute);
    if (!Number.isFinite(m)) continue;
    for (const sc of (b.stockChanges || [])) {
      const px = sc.lastPx != null ? Number(sc.lastPx) : null;
      if (px == null || !Number.isFinite(px) || px <= 0) continue;
      if (m >= AFTERNOON_START_MINUTE && !firstPx.has(sc.code)) firstPx.set(sc.code, px);
      lastPx.set(sc.code, px);
    }
  }
  const out = new Map();
  for (const [code, p0] of firstPx) {
    const close = lastPx.get(code);
    if (close != null && close > 0) out.set(code, ((close - p0) / p0) * 100);
  }
  return out;
};
// 查某交易日某股的下半日（13:00→收盘）涨幅；无该日缓存/该股无下午分时返回 null（候选按无效处理）
const getAfternoonGain = (dateStr, code) => {
  const m = afternoonGainCache.get(String(dateStr));
  if (!m) return null;
  const v = m.get(code);
  return v != null && Number.isFinite(v) ? v : null;
};

// 从回放数据提取每个股票「当日 EOD」信息：收盘涨幅、收盘价、当日抗分歧分数
// （当日抗分歧分数取 resilience3dScores 的最后一位，即 score(当天)，与 resilience3d 口径一致）
// dateStr 传入时顺带登记该交易日的「下半日涨幅」缓存（供 N.5 日窗口选股查表）
const extractDailyInfo = (campData, dateStr = null) => {
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
  if (dateStr != null) afternoonGainCache.set(String(dateStr), buildAfternoonGainMap(campData));
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

// 「N.5 日涨幅」窗口累计涨幅：在 N 日窗口复利涨幅基础上，再复利计入「更前一个交易日
// （窗口最早交易日的再前一交易日，0.5 日）下午 13:00 → 收盘」的涨幅。
// halfDayDate 为 null（窗口前一日超出可用日期范围）时退化为常规 N 日窗口涨幅；
// 该股当日无下午分时（getAfternoonGain 返回 null）时返回 null，候选按无效处理（与窗口缺失口径一致）。
const computeWindowGainWithHalf = (code, winDates, dailyInfos, todayIntradayChange, halfDayDate) => {
  const base = computeWindowGain(code, winDates, dailyInfos, todayIntradayChange);
  if (base == null) return null;
  if (halfDayDate == null) return base;
  const half = getAfternoonGain(halfDayDate, code);
  if (half == null) return null;
  return ((1 + base / 100) * (1 + half / 100) - 1) * 100;
};

// 纯历史窗口累计涨幅（全部取历史 EOD 涨幅复利相乘，不含任何盘中口径）：
// 供「前N日跌幅&当日指标」系列（prev{N}d_fall_top5_day_*）第一阶段使用——窗口不含今日，
// 与 computeWindowGain「最后一位为当日」的约定不同，故独立成函数
const computeHistoricalWindowGain = (code, winDates, dailyInfos) => {
  let prod = 1;
  for (const d of winDates) {
    const ch = dailyInfos.get(d)?.get(code)?.changePct;
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

// 涨停判定（买入时点，全策略通用）：主板（60/00 开头）当日涨幅 > 9.5% 视为涨停；
// 创业板（sz30 开头）/科创板（sh68 开头）涨幅 > 19% 视为涨停。涨停股买入不可成交，
// 各选股路径遇到涨停候选一律剔除并顺延至排名下一只（重点板块系列的涨停过滤同此口径）
const isLimitUpAtBuy = (code, changePct) => {
  if (changePct == null || !Number.isFinite(Number(changePct))) return false;
  const growthBoard = String(code).startsWith('sz30') || String(code).startsWith('sh68');
  return Number(changePct) > (growthBoard ? 19 : 9.5);
};

// ============================================================
// 上一交易日一字板过滤（2026-10-05 新增，所有策略选股通用限制；同日放宽阈值）：
// 一字板定义 = 上一交易日竞价开盘涨幅、收盘涨幅、全天最低价涨幅三者均不低于阈值
//（主板 8%、创业板/科创板 16%，口径较真实一字板放宽：全天始终维持普涨、无低位上车机会）；
// 一字板次日常继续一字或大高开，难以低位上车且追高风险大 → 所有策略选股一律剔除该候选并顺延排名下一只。
// ============================================================
// klineBars：升序日K（getKlineCached 口径，字段 trade_date/open_px/close_px/low_px）；dateStr：买入日。
// 返回 true=上一交易日一字板 / false=非一字板 / null=数据不足无法判定（不拦截）
const isPrevDayOneWordBoard = (code, klineBars, dateStr) => {
  try {
    const bars = (klineBars || [])
      .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const target = parseInt(dateStr, 10);
    let idx = -1; // 上一交易日K线位置（trade_date < 买入日的最后一根）
    for (let i = bars.length - 1; i >= 0; i--) {
      if (Number(bars[i].trade_date) < target) { idx = i; break; }
    }
    if (idx < 1) return null; // 无上一交易日K线或缺上上交易日（无法取昨收）
    const prevBar = bars[idx];
    const preclose = Number(bars[idx - 1].close_px);
    const openPx = Number(prevBar.open_px);
    const lowPx = prevBar.low_px != null ? Number(prevBar.low_px) : null;
    const closePx = Number(prevBar.close_px);
    if (!(preclose > 0) || !(openPx > 0) || !(closePx > 0) || lowPx == null || !(lowPx > 0)) return null;
    const chg = (px) => ((px - preclose) / preclose) * 100;
    const growthBoard = String(code).startsWith('sz30') || String(code).startsWith('sh68');
    const threshold = growthBoard ? 16 : 8;
    return chg(openPx) >= threshold && chg(closePx) >= threshold && chg(lowPx) >= threshold;
  } catch (e) {
    return null;
  }
};

// 批量预取候选池「上一交易日一字板」代码集合：返回 Set<code>，供同步选股函数
// pickBestStock / pickWeakToStrongStock 使用。结果按 `${code}_${dateStr}` 进程内缓存
//（历史日K不可变，同一回测窗口内重复桶/重复日直接命中）
const prevOneWordBoardCache = new Map(); // `${code}_${dateStr}` -> true/false/null
const buildPrevOneWordBoardSet = async (codes, dateStr) => {
  const set = new Set();
  await Promise.all([...new Set(codes)].map(async (code) => {
    const key = `${code}_${dateStr}`;
    if (!prevOneWordBoardCache.has(key)) {
      let bars = null;
      try { bars = await getKlineCached(code, dateStr); } catch (e) { bars = null; }
      prevOneWordBoardCache.set(key, isPrevDayOneWordBoard(code, bars, dateStr));
    }
    if (prevOneWordBoardCache.get(key) === true) set.add(code);
  }));
  return set;
};

// ============================================================
// 个股顺/逆周期过滤（2026-10-06 用户新增，2026-10-06 扩展至全部策略）：
// 取候选股与创业板指在最近 N 个已完结交易日（截至买入日前一交易日收盘，不含买入日）的日收益率序列，
// 计算 Pearson 相关系数：corr > 阈值（正相关）= 顺周期（放行）；corr <= 阈值 = 逆周期（剔除并顺延排名下一只）。
// 含义：只做与大盘（创业板指）同向共振的股票，逆周期个股持有期胜率低。
// 数据不足（个股/指数共同交易日不足 N+1 个或方差为 0）时返回 null，不拦截（与其他过滤器口径一致）。
// 适用范围：除「情绪游资类（iceMode）」「三日情绪冰点类（emoAvgBuy）」「尾盘抄底类（tailDip）」
// 「重点板块类（keyBlockDays）」外的全部策略。
// ============================================================
const CYC_CORR_WINDOW = 20; // 相关性回看窗口（已完结交易日数）
const CYC_MIN_CYB_CORR = 0; // 相关系数需 > 该值（正相关）才算顺周期，否则逆周期

// Pearson 相关系数（要求至少 3 组样本；任一方差为 0 返回 null）
const pearsonCorr = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  return cov / Math.sqrt(vx * vy);
};

// 个股与创业板指最近 window 个已完结交易日的日收益率相关系数
// stockKline：getKlineCached 口径（trade_date / close_px）；cybBars：[{ d, c }] 升序（创业板指收盘）
const calcStockCybCorrelation = (stockKline, cybBars, dateStr, window = CYC_CORR_WINDOW) => {
  const target = parseInt(dateStr, 10);
  if (!Number.isFinite(target)) return null;
  const stockBars = (stockKline || [])
    .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
    .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px) }))
    .filter(b => b.d < target) // 只用已完结交易日，避免使用买入日（未来）数据
    .sort((a, b) => a.d - b.d);
  const idxByDate = new Map((cybBars || [])
    .filter(b => Number.isFinite(b.d) && Number.isFinite(b.c) && b.c > 0 && b.d < target)
    .map(b => [b.d, b.c]));
  const stockByDate = new Map(stockBars.map(b => [b.d, b.c]));
  // 以个股交易日为准取与指数共同的交易日，最近 window+1 个收盘价 → window 个日收益率
  const commonDates = stockBars.map(b => b.d).filter(d => idxByDate.has(d)).slice(-(window + 1));
  if (commonDates.length < window + 1) return null;
  const stockRet = [];
  const idxRet = [];
  for (let i = 1; i < commonDates.length; i++) {
    const sc = stockByDate.get(commonDates[i]);
    const sp = stockByDate.get(commonDates[i - 1]);
    const ic = idxByDate.get(commonDates[i]);
    const ip = idxByDate.get(commonDates[i - 1]);
    if (!(sp > 0) || !(ip > 0)) return null;
    stockRet.push((sc / sp - 1) * 100);
    idxRet.push((ic / ip - 1) * 100);
  }
  return pearsonCorr(stockRet, idxRet);
};

// 创业板指收盘序列（进程内缓存，首次拉取后复用）
const cycCorrCache = new Map(); // `${code}_${dateStr}` -> number|null（相关系数）
let cybCorrBarsPromise = null;
const getCybCorrBars = () => {
  if (!cybCorrBarsPromise) {
    cybCorrBarsPromise = (async () => {
      try {
        const kline = await loadIndexKline('cyb_kline.json', '399006', '32', 500);
        return (kline || [])
          .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
          .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px) }))
          .sort((a, b) => a.d - b.d);
      } catch (e) { return []; }
    })();
  }
  return cybCorrBarsPromise;
};

// 预取候选池「逆周期」代码集合（与创业板指负相关/零相关）：返回 Set<code>，供同步选股函数使用。
// 结果按 `${code}_${dateStr}` 进程内缓存（历史日K不可变，同窗口重复桶直接命中）；
// 数据不足（相关系数 null）的候选不入集合（放行不拦截）。
const buildCounterCycSet = async (codes, dateStr) => {
  const set = new Set();
  const cybBars = await getCybCorrBars();
  await Promise.all([...new Set(codes)].map(async (code) => {
    const key = `${code}_${dateStr}`;
    if (!cycCorrCache.has(key)) {
      let bars = null;
      try { bars = await getKlineCached(code, dateStr); } catch (e) { bars = null; }
      cycCorrCache.set(key, calcStockCybCorrelation(bars, cybBars, dateStr));
    }
    const corr = cycCorrCache.get(key);
    if (corr != null && corr <= CYC_MIN_CYB_CORR) set.add(code);
  }));
  return set;
};

// ============================================================
// 随机模拟注入：把「随机模拟测试」随机抽取的一批真实科技股混入当日回放候选池。
// 在加载回放数据后、构建 replayStocks / dailyInfos 之前调用：向每个时间桶的 stockChanges
// 追加这些股票的真实逐桶行情（真实分时 → 桶 minute 取价），并补齐 dailyLowByCode。
// 这些股票是真实 A 股（来自科技股清单），日K/分时/均线/抗分歧全部取自真实行情缓存，
// 与真实自选股完全同源，因此形态真实（不会出现合成数据的长影线等异常）。
// 注入股票在候选选股处跳过自选股添加时间门禁（见 passWatchlistGate）。
// ============================================================
const injectSimStocksIntoCampData = async (campData, dateStr) => {
  const sim = getSimContext();
  if (!sim || !Array.isArray(sim.codes) || sim.codes.length === 0) return;
  const buckets = campData?.timeBuckets || [];
  if (buckets.length === 0) return;
  campData.dailyLowByCode = campData.dailyLowByCode || {};

  // 并发构建每只股票当日真实数据（分时/均线/近 3 日抗分歧），单只失败即跳过该股当日
  await batchParallel(sim.codes, async (code) => {
    const name = (sim.nameByCode && sim.nameByCode.get(code)) || code;
    let synth = null;
    try {
      synth = await buildKeyBlockSyntheticDay(code, name, dateStr);
    } catch (e) {
      return;
    }
    if (!synth) return;
    const { sortedPoints, maInfo, r3d } = synth;
    for (const bucket of buckets) {
      const entry = buildKeyBlockSyntheticBucketEntry(code, name, sortedPoints, maInfo, r3d, Number(bucket.minute));
      if (entry) bucket.stockChanges.push(entry);
    }
    campData.dailyLowByCode[code] = maInfo.dailyLowMap || {};
  }, 8);
};

// ============================================================
// 窗口预热（起点一致性）：把回测起始日之前的 needDays 个交易日的 EOD 数据提前加载进 dailyInfos，
// 并返回向前扩展的日期轴 dateAxis = [...预热日, ...rangeDates]（axisOffset = 预热日数）。
// 动机：窗口指标（最近 N 日涨幅/抗分歧）的历史成分来自 dailyInfos（随回测循环逐日填充），
// 窗口切片又受限于 rangeDates——回测起点附近的窗口被起始日截断，导致「同一交易日、不同回测起点」
// 得到不同的窗口指标与选股结果（如 8.3 起点与 8.4 起点在 8.4 9:40 选出不同的股票）。
// 修复后选股函数传入 (dateAxis, di + axisOffset)，窗口切片自然覆盖预热日；
// highest_gain（买入最高涨幅）的窗口语义固定为「回测起始日至当日」，通过 axisOffset 起切保持不变。
// 预热日加载失败时跳过该日（窗口相应变短，与旧行为一致）；预热日不产生任何买卖动作。
// ============================================================
const buildWindowAxis = async (allDates, rangeDates, startDate, needDays, dailyInfos) => {
  const preloadDates = allDates.filter(d => d < startDate).sort().slice(-Math.max(0, needDays));
  const loaded = [];
  for (const d of preloadDates) {
    try {
      const campData = await loadTrainingCampData(d);
      if (campData && campData.success !== false && (campData.timeBuckets || []).length > 0) {
        await injectSimStocksIntoCampData(campData, d); // 随机模拟：预热日同样注入合成股票，保证窗口指标可比
        dailyInfos.set(d, extractDailyInfo(campData, d));
        loaded.push(d);
      }
    } catch { /* 单日预热失败忽略 */ }
  }
  return { dateAxis: [...loaded, ...rangeDates], axisOffset: loaded.length };
};

// 自选股添加时间门禁：随机模拟注入的合成股票不受该门禁约束（它们没有"加入自选股"历史），
// 其余股票沿用真实自选股加入时间校验，防止后加自选股污染历史回测
const passWatchlistGate = (code, dateStr, minute) => isSimStock(code) || isStockInWatchlistAt(code, dateStr, minute);

// 抗分歧弱转强选股：取最近 4 个交易日（最后一位为当日，用盘中过滤后的抗分歧分数）每只股票的抗分歧分数，
// 先筛选出「买点触发时抗分歧分数 > 11」的股票，再从中计算「前两天均值」与「后两天均值」（第 3 天+当日，即最近两天）的差值
// diff = 后两天均值 - 前两天均值。diff 越大代表抗分歧由弱转强越明显，选 diff 最大的一只；diff 相同（弱转强过程一致）时，取当日盘中涨幅最大的一只。
const pickWeakToStrongStock = (bucket, rangeDates, di, replayStocks, dailyInfos, prevOneWordSet = null, emoCycSet = null) => {
  const winDates = rangeDates.slice(Math.max(0, di - 3), di + 1); // 最近 4 个交易日
  if (winDates.length < 4) return null; // 4 日窗口不足，不构成弱转强
  const emoCycSkipped = [];
  let best = null; // { sc, diff, gain }
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (isOscExcluded(sc.code)) continue; // 震荡测试：勾选隐藏的股票不参与选股
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!passWatchlistGate(sc.code, rangeDates[di], bucket.minute)) continue;
    // 涨停顺延：买点触发时点已涨停的股票无法成交，不参与优选
    if (isLimitUpAtBuy(sc.code, sc.changePct)) continue;
    // 上一交易日一字板过滤（全策略通用）：昨日一字板的候选次日不买，不参与优选
    if (prevOneWordSet && prevOneWordSet.size > 0 && prevOneWordSet.has(sc.code)) continue;
    // 顺/逆周期过滤：逆周期（与创业板指负相关/零相关）候选剔除并顺延（由循环自然改选下一最优）
    if (emoCycSet && emoCycSet.size > 0 && emoCycSet.has(sc.code)) {
      emoCycSkipped.push({ code: sc.code, name: sc.name || sc.code, change: sc.changePct != null ? Number(sc.changePct) : null, corr: cycCorrCache.get(`${sc.code}_${rangeDates[di]}`) });
      continue;
    }
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
  return { stock: best.sc, metric: parseFloat(best.diff.toFixed(4)), emoCycSkipped };
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
  { code: 'sh000001', name: '上证指数', cacheName: 'sh_kline.json', pureCode: '1A0001', market: '16' },
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

// 计算个股 MA3 切线正斜率连续天数（从 targetDateStr 倒着数，包括 targetDateStr 本身）
// MA3 切线公式 B：MA3(今日) − MA3(昨日)；avg(i,d) = closes.slice(i, i+d).reduce(...) / d
// closes 是按日期降序的 [{date, close}] 数组，[0] = 目标日，[1] = 前一日，...
// 返回：连续正的天数（含当日）；斜率非正返回 0；数据不足返回 null（调用方保守放行）
const countStockPositiveSlopeDays = (code, targetDateStr, dailyInfos) => {
  if (!dailyInfos) return null;
  const codeStr = String(code);
  const dates = [...dailyInfos.keys()].sort((a, b) => b - a);
  const closes = [];
  for (const d of dates) {
    const info = dailyInfos.get(d)?.get(codeStr);
    if (info?.closePx != null && info.closePx > 0) closes.push({ date: d, close: Number(info.closePx) });
    if (closes.length >= 10) break;
  }
  if (closes.length < 4) return null;
  const avg = (i, d) => closes.slice(i, i + d).reduce((s, v) => s + v.close, 0) / d;
  const slopeToday = avg(0, 3) - avg(1, 3);
  if (!Number.isFinite(slopeToday)) return null;
  if (slopeToday <= 0) return 0;
  let count = 1;
  for (let i = 1; i + 3 <= closes.length; i++) {
    const slope = avg(i, 3) - avg(i + 1, 3);
    if (!Number.isFinite(slope)) break;
    if (slope > 0) count++;
    else break;
    if (count >= 6) break; // 用户关心 ≤4，算到 5 就够了
  }
  return count;
};

// 科技板块前三系列（tech_block_top3_*）取前几的板块数量
const TECH_TOP3_BLOCK_N = 3;

// 科技板块前三候选集的记忆化缓存（`dateStr#timeKey` -> { codes, top }），同一交易日同一时点的板块盘中涨幅不变
const techTop3BlockCache = new Map();

// 科技板块效应候选集（tech_block_top3_* 选股第一步）：以买点触发时点（时间桶 bucket）的盘中实时口径，
// 取当日重点板块（block_code.js，key_blocks 页面维护）中 tag = 进攻 的板块，按「板块盘中涨幅」
// （= 该板块成分股在触发时点的实时涨幅均值，直接取回放桶 blockRanking.all，与 key_blocks 页面盘中
// avgChange 同口径、不含任何收盘价前视）降序取前 TECH_TOP3_BLOCK_N 个，把这些板块的全部成分股与
// 「全量自选股中 isTech ≠ false 的科技股」取交集，返回交集代码集合（供 pickBestStock 的 restrictCodes
// 限制候选池）。触发桶无板块盘中数据 / 进攻板块交集为空 → 返回空集（本次不买入）
const buildTechTop3BlockCodeSet = (bucket, dateStr) => {
  // 同一（交易日, 时点）的板块盘中涨幅不变，按 dateStr#timeKey 记忆化避免同一天多个买点桶重复计算
  const timeKey = bucket && bucket.timeKey != null ? String(bucket.timeKey) : '';
  const cacheKey = `${dateStr}#${timeKey}`;
  const cached = techTop3BlockCache.get(cacheKey);
  if (cached) return cached;
  const allBlocks = (bucket && bucket.blockRanking && Array.isArray(bucket.blockRanking.all))
    ? bucket.blockRanking.all
    : [];
  const tagMap = getKeyBlockTagMap();
  const constituents = getKeyBlockConstituents();
  const { getMonitorStocks } = require('./monitorStock');
  const techCodes = new Set(
    (getMonitorStocks() || [])
      .filter(s => s && s.code && s.isTech !== false && !EXCLUDED_CODES.has(s.code))
      .map(s => s.code)
  );
  // 触发时点盘中涨幅前三的进攻板块（allBlocks 已按 avgChange 降序，但显式再排一次以防上游字段顺序变化）
  const top = allBlocks
    .filter(b => b && tagMap.get(b.blockName) === '进攻' && b.avgChange != null && Number.isFinite(b.avgChange))
    .sort((a, b) => b.avgChange - a.avgChange)
    .slice(0, TECH_TOP3_BLOCK_N);
  const codes = new Set();
  for (const tb of top) {
    for (const m of constituents.get(tb.blockName) || []) {
      if (techCodes.has(m.code)) codes.add(m.code);
    }
  }
  const result = { codes, top: top.map(tb => ({ blockName: tb.blockName, gain: tb.avgChange })) };
  techTop3BlockCache.set(cacheKey, result);
  return result;
};

// 计算「快进快出」标注（买入时点判定，与 pickBestStock 内各 emoquick 分支口径完全一致）：
//   ① 上一交易日科技情绪 3 日 EMA < -60；② 上上个/上个交易日当日科技情绪均处 (-30, 20) 且回升。
// 两次买入系列（highest_{N}d_gain_two_buy）复用该能力，在首次建仓时调用并把结果挂到持仓上。
// 入参须与 pickBestStock 一致：di 为日期轴（含预热日）绝对索引、rangeDates 为日期轴，方能取到同一「上一交易日」。
const computeEmoQuickOutInfo = (di, rangeDates) => {
  const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日
  const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
  const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
  const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
  const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
  const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
  const quickByRangeRising = prev2Raw != null && prevRaw != null
    && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
    && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
    && prevRaw > prev2Raw;
  return {
    quickOut: quickByEmaBelow || quickByRangeRising,
    trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
    ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
    prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null,
    prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null,
  };
};

// 单股策略选股：在买点命中的当前时间桶，按策略指标选择最优的一只股票。
// 抗分歧≥11 顺延门槛对 RESILIENCE_GATE_STRATEGY_IDS（当前仅买入最高涨幅）启用：
// 排名首位不满足则按策略排名依次顺延至下一只满足的股票，skipped 记录被顺延跳过的前序股票（供买入明细标注）；
// 其余策略不做抗分歧校验，直接取排名指定名次的第一只
const pickBestStock = (stocks, rangeDates, di, bucket, replayStocks, dailyInfos, strategyId, axisOffset = 0, allowedMarkets = null, turnedPosInfo = null, prevOneWordSet = null, emoCycSet = null, restrictCodes = null) => {
  // 买入时段门禁（所有策略通用）：仅允许 9:30 – 11:30 和 13:00 – 13:30 之间的买点触发买入
  const mNum = Number(bucket.minute);
  if (Number.isFinite(mNum) && mNum > BUY_TIME_MAX_MINUTE) return null;

  const isReportStrategy = strategyId.includes('reports');
  const isTop5ReportGainMode = strategyId.includes('reports_top5_gain'); // 研报覆盖前五（含覆盖数相同）中取窗口涨幅最大
  const isPureReportMode = isReportStrategy && !isTop5ReportGainMode; // 研报覆盖数最多/第二多
  const isMaSlopeMode = strategyId.includes('ma_slope'); // 均线斜率最陡峭（3日/5日）
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
  // 当日抗分歧分数最大：实时抗分歧分数选股，分数相同按触发时点当日实时涨幅决胜
  const isResilienceMaxToday = strategyId === 'highest_1d_resilience';
  // 前N日「跌幅最大/波动最小」前五&当日指标最大（prev{N}d_fall_top5_day_* / prev{N}d_fall_low5_day_*）：两阶段选股——
  // 第一阶段按前 N 个交易日（不含今日）累计涨幅取前五（top5=跌幅最大；low5=波动最小版，无论涨跌按
  // 累计涨幅绝对值取最小的五只），第二阶段组内选当日实时指标最大
  const prevFallMatch = strategyId.match(/^prev(\d)d_fall_(top|low)5_day_(gain|resilience)$/);
  const isPrevFall5Mode = prevFallMatch != null;
  const prevFallLowMode = isPrevFall5Mode && prevFallMatch[2] === 'low';
  const prevFallWinDays = isPrevFall5Mode ? Number(prevFallMatch[1]) : 0;
  const prevFallStage2Resilience = isPrevFall5Mode && prevFallMatch[3] === 'resilience';

  // 抗分歧弱转强：使用独立的 5 日窗口弱转强选股逻辑（已内置「当日分数 > 11 参与优选」门槛）
  if (strategyId === 'resilience_weak_to_strong') {
    return pickWeakToStrongStock(bucket, rangeDates, di, replayStocks, dailyInfos, prevOneWordSet, emoCycSet);
  }

  // 情绪开关系列（prev{N}d_fall_low5_day_gain_emoswitch）：触发买点时取上一交易日科技情绪指数的
  // 3 日 EMA（getTechEmotionEmaMap，与情绪页「三日均值」曲线同源同算法），低于 -60 → 委托
  // 「前N日波动最小&当日涨幅最大」选股，否则 → 委托「3日涨幅最大」选股；EMA 缺失（无上一
  // 交易日或数据未覆盖）时按「否则」分支处理。递归调用不会再次命中本分支（委托 ID 无 _emoswitch 后缀），
  // 两分支复用全部通用机制（涨停顺延/抗分歧门槛/门禁等）
  const emoswitchMatch = strategyId.match(/^prev(\d)d_fall_low5_day_gain_emoswitch$/);
  if (emoswitchMatch) {
    const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日（日期轴均为交易日）
    const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
    const useLow5 = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
    const delegateId = useLow5
      ? `prev${emoswitchMatch[1]}d_fall_low5_day_gain`
      : 'highest_3d_gain';
    const emoPicked = pickBestStock(stocks, rangeDates, di, bucket, replayStocks, dailyInfos, delegateId, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet);
    if (emoPicked) {
      // 附带分支标注：经 withResilienceGateInfo 写入买入原因与买入条件明细（emo_switch_branch），
      // 抽屉/报告据此展示本次买入走的是「前N波动最小&当日涨幅最大」还是「3日涨幅最大」分支
      emoPicked.emoSwitchBranch = {
        ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
        branch: useLow5 ? `前${emoswitchMatch[1]}个交易日波动最小&当日涨幅最大` : '3日涨幅最大',
      };
    }
    return emoPicked;
  }

  // 情绪快进快出系列（highest_{N}d_gain_emoquick，2026-10-03 用户新增）：买点触发时均可正常买入
  // （不跳过），委托「N 日涨幅最大」（highest_{N}d_gain）选股；满足以下任一条件的日子，本次买入标记
  // 为「快进快出」（emoQuickOut.quickOut = true）：该笔持仓不走通用 7 条件卖点，买入次日 10:00 强制
  // 卖出、盘中跌破成本线 -2% 先到先卖止损（2026-10-05 新增；见 runRangeBacktest / runRangeBacktestMulti
  // 的每日预桶快进快出卖点）：
  //   1) 上一交易日科技情绪指数的 3 日 EMA（getTechEmotionEmaMap，与情绪页「三日均值」同源同算法）< -60
  //   2) 上上个、上个交易日的当日科技情绪原始分（getTechEmotionRawMap，非 3 日 EMA）均处 (-30, 20)
  //      区间且上个 > 上上个（情绪温和回升）
  // 两条件均不满足（或数据缺失）时为普通持仓，走通用卖点。递归调用不会再次命中本分支（委托 ID 无
  // _emoquick 后缀），买入复用全部通用机制（涨停顺延/抗分歧门槛/跨指数双门禁等）
  const emoQuickMatch = strategyId.match(/^highest_(\d+d\d*)_gain_emoquick$/);
  if (emoQuickMatch) {
    const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日（日期轴均为交易日）
    const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
    const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
    const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
    const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
    const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
    const quickByRangeRising = prev2Raw != null && prevRaw != null
      && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
      && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
      && prevRaw > prev2Raw;
    const quickPicked = pickBestStock(stocks, rangeDates, di, bucket, replayStocks, dailyInfos, `highest_${emoQuickMatch[1]}_gain`, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet);
    if (quickPicked) {
      // 附带快进快出标注：经 withResilienceGateInfo 写入买入原因与买入条件明细（emo_quick_out），
      // 并随持仓（positions[].emoQuickOut）传递给卖点侧，决定是否次日 10:00 强制卖出
      quickPicked.emoQuickOut = {
        quickOut: quickByEmaBelow || quickByRangeRising,
        trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
        ema: prevEma != null ? Number(prevEma.toFixed(2)) : null, // 上一交易日 3 日 EMA（条件①判定值）
        prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null, // 上一交易日当日科技情绪（条件②）
        prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null, // 上上个交易日当日科技情绪（条件②）
      };
    }
    return quickPicked;
  }

  // 快进快出 × 研报覆盖双门策略（highest_3d_reports_top5_gain_emoquick，2026-10-04 用户新增）：
  // 在 highest_3d_gain_emoquick 的基础上，仅当快进快出的触发条件是「上一交易日 3 日 EMA < -60」时，
  // 选股口径从「3日涨幅最大」改为「最近 3 日研报覆盖数前五（含并列）→ 组内 3 日涨幅最大」
  // （委托到已有的 highest_3d_reports_top5_gain 策略，天然走 isTop5ReportGainMode 分支）；
  // 温和回升快进快出路径 / 非快进快出路径 / EMA 缺失时 → 仍委托 highest_3d_gain
  // 卖出行为（emoQuickOut 标注 + 次日 10:00 强卖）与 highest_3d_gain_emoquick 完全一致
  if (strategyId === 'highest_3d_reports_top5_gain_emoquick') {
    const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日
    const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
    const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
    const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
    const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
    const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
    const quickByRangeRising = prev2Raw != null && prevRaw != null
      && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
      && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
      && prevRaw > prev2Raw;
    // 关键：只有走「上一交易日 3 日 EMA < -60」这条快进快出路径才切换到研报前五选股；
    // 温和回升 / 数据缺失 / 非快进快出 都用原 3 日涨幅最大选股
    const delegateId = quickByEmaBelow ? 'highest_3d_reports_top5_gain' : 'highest_3d_gain';
    const quickPicked = pickBestStock(stocks, rangeDates, di, bucket, replayStocks, dailyInfos, delegateId, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet);
    if (quickPicked) {
      quickPicked.emoQuickOut = {
        quickOut: quickByEmaBelow || quickByRangeRising,
        trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
        ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
        prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null,
        prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null,
      };
    }
    return quickPicked;
  }

  // 科技板块前三 × N日涨幅最大 × 快进快出系列（tech_block_top3_{N}d_gain_emoquick，2026-10-06 用户新增）：
  // 与 highest_{N}d_gain_emoquick 几乎完全一样（快进快出触发条件、次日 10:00 强卖、盘中 -2% 止损、
  // 否则走通用 7 条件卖点均不变），唯一区别在选股口径——先做一层板块效应筛选：
  //   ① 取当日重点板块（block_code.js，key_blocks 页面维护）中 tag = 进攻 的板块，按「触发时点盘中涨幅」
  //      （= 成分股在买点触发时点的实时涨幅均值，取自回放桶 blockRanking.all，与 key_blocks 页面盘中
  //      avgChange 同口径、不含收盘价前视）降序取前三；
  //   ② 这 3 个板块的全部成分股与「全量自选股中 isTech ≠ false 的科技股」取交集，得到 restrictCodes；
  //   ③ 委托「N 日涨幅最大」在交集内选股（restrictCodes 限制候选池），交集为空则本次不买入。
  // 板块效应只影响买入选股；卖出行为与 highest_{N}d_gain_emoquick 完全一致（emoQuickOut 标注驱动）
  const techTop3Match = strategyId.match(/^tech_block_top3_(\d+d\d*)_gain_emoquick$/);
  if (techTop3Match) {
    const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日
    const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
    const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
    const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
    const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
    const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
    const quickByRangeRising = prev2Raw != null && prevRaw != null
      && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
      && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
      && prevRaw > prev2Raw;
    const techTop3 = buildTechTop3BlockCodeSet(bucket, String(rangeDates[di]));
    const quickPicked = techTop3.codes.size > 0
      ? pickBestStock(stocks, rangeDates, di, bucket, replayStocks, dailyInfos, `highest_${techTop3Match[1]}_gain`, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet, techTop3.codes)
      : null;
    if (quickPicked) {
      quickPicked.emoQuickOut = {
        quickOut: quickByEmaBelow || quickByRangeRising,
        trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
        ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
        prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null,
        prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null,
      };
      // 板块效应筛选明细：标注买点触发时点进攻 tag 板块盘中涨幅前三与交集后候选数量（供买入明细展示）
      quickPicked.techTop3Block = {
        date: String(rangeDates[di]),
        time: bucket && bucket.displayTime ? bucket.displayTime : null,
        blocks: techTop3.top,
        candidateCount: techTop3.codes.size,
      };
    }
    return quickPicked;
  }

  // 涨幅/抗分歧窗口按 days 天
  let winDates;
  if (strategyId === 'highest_gain') {
    // 买入最高涨幅：窗口固定为「回测起始日至当日」——从 axisOffset（日期轴上预热日的数量）起切，
    // 避免预热日改变该策略的全期窗口语义；其余策略的最近 N 日窗口可自然覆盖预热日
    winDates = rangeDates.slice(axisOffset, di + 1);
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
  // 「N.5 日涨幅最大」系列（highest_{N}d5_gain 及其 _emoquick/_two_buy/tech_block_top3 变体）：
  // 在 N 日窗口之外，额外复利计入「更前一个交易日（窗口最早交易日的再前一交易日）下午 13:00→收盘」的半日涨幅；
  // halfDayDate = 日期轴上 di - days 那一天（越界为 null，退化为常规 N 日窗口）
  const halfDayAfternoon = STRATEGIES[strategyId]?.halfDayAfternoon === true;
  const halfDayDate = halfDayAfternoon && days && di - days >= 0 ? rangeDates[di - days] : null;
  // 抗分歧门槛策略（当前仅买入最高涨幅）：选股排序依据 = 买点触发时点当日盘中涨幅（用户定义，
  // 非窗口累计涨幅），从高到低排序后从最高者起依次用触发时点抗分歧分数≥11 过滤；
  // 若未来加入按 N 日窗口涨幅排序的门槛策略，会走下方窗口涨幅计算分支，仅追加抗分歧顺延校验
  const gateEnabled = RESILIENCE_GATE_STRATEGY_IDS.has(strategyId);
  const gateIntradaySort = RESILIENCE_GATE_INTRADAY_SORT_IDS.has(strategyId);

  // 收集全部候选（与原 best/second 口径一致：按指标值排序，同值保持自选股原顺序）
  const candidates = [];
  const top5Candidates = isTop5ReportGainMode ? [] : null;
  const reportIndex = isReportStrategy ? loadReportIndex() : null;
  // 研报创建时间门禁：买点时间戳（回测分时为北京时区，menu.json 的 createdAt 为 UTC，统一为绝对时间戳比较）。
  // 买点之后才创建的研报（如收盘后补录）不计入该买点时点的覆盖统计
  let reportBuyTs = null;
  if (isReportStrategy) {
    const dStr = String(rangeDates[di]);
    const mNum = Number(bucket.minute);
    if (/^\d{8}$/.test(dStr) && Number.isFinite(mNum)) {
      const hh = String(Math.floor(mNum / 100)).padStart(2, '0');
      const mi = String(mNum % 100).padStart(2, '0');
      const ts = Date.parse(`${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}T${hh}:${mi}:00+08:00`);
      if (Number.isFinite(ts)) reportBuyTs = ts;
    }
  }
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (isOscExcluded(sc.code)) continue; // 震荡测试：勾选隐藏的股票不参与选股
    // 候选池限制（科技板块前三系列）：只保留「进攻 tag 板块当日涨幅前三 ∩ 全量自选科技股」交集内的股票
    if (restrictCodes && !restrictCodes.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (stocks.has(sc.code) && stocks.get(sc.code).holding) continue;
    // 跨指数双门禁的市场过滤（allowedMarkets=null 表示不做过滤，默认留空或非适用策略）
    if (allowedMarkets && allowedMarkets.size > 0) {
      const code = String(sc.code).replace(/^SH|^SZ|^BJ/i, '');
      if (/^68/.test(code)) {
        if (!allowedMarkets.has('star')) continue; // 科创板 → 需要 star gate
      } else {
        if (!allowedMarkets.has('mainboard') && !allowedMarkets.has('gem')) continue; // 主板/创业板 → 需要 cyb gate
      }
    }
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!passWatchlistGate(sc.code, rangeDates[di], bucket.minute)) continue;
    if (isEmo3GateStrategy) {
      // 三日情绪冰点：跟踪指数环境门禁（当日满足其一才可买；未预计算/数据不足按不满足处理）
      const gate = emo3IndexGateCache.get(`${rangeDates[di]}_${trackedIndexCodeOf(sc.code)}`);
      if (!gate || gate.passed !== true) continue;
    }
    if (gateIntradaySort) {
      // 门槛策略（最高涨幅/2日涨幅最大）：按触发时点当日盘中涨幅排序（如买点触发在 13:10，即看 13:10 时谁的涨幅最大）
      const chg = sc.changePct != null ? Number(sc.changePct) : null;
      if (chg == null || !Number.isFinite(chg)) continue;
      candidates.push({ sc, val: chg, metric: parseFloat(chg.toFixed(4)) });
      continue;
    }
    // 当日抗分歧分数最大：取触发时点截至当时的日内实时抗分歧分数（非收盘口径），同分按实时涨幅决胜
    if (isResilienceMaxToday) {
      const r = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      if (r == null || !Number.isFinite(r)) continue;
      const chg = sc.changePct != null && Number.isFinite(Number(sc.changePct)) ? Number(sc.changePct) : null;
      candidates.push({
        sc,
        val: r,
        // 分数相同时按触发时点当日实时涨幅决胜（涨幅缺失排同分组末尾）
        val2: chg != null ? chg : -Infinity,
        metric: parseFloat(r.toFixed(2)),
      });
      continue;
    }
    // 前N日跌幅前五&当日指标最大：收集第一阶段指标（前 N 个交易日不含今日的累计涨幅，纯历史收盘口径）
    // 与第二阶段指标（触发时点当日实时涨幅 / 日内实时抗分歧分数）；循环结束后统一做「前五 → 组内排序」
    if (isPrevFall5Mode) {
      const winPrev = rangeDates.slice(Math.max(0, di - prevFallWinDays), di); // 不含今日
      if (winPrev.length === 0) continue; // 无任何历史交易日（回测最早日），无法构成跌幅窗口
      const prevGain = computeHistoricalWindowGain(sc.code, winPrev, dailyInfos);
      if (prevGain == null || !Number.isFinite(prevGain)) continue;
      let stage2 = null;
      if (prevFallStage2Resilience) {
        stage2 = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      } else {
        stage2 = sc.changePct != null && Number.isFinite(Number(sc.changePct)) ? Number(sc.changePct) : null;
      }
      // 第二阶段指标无法计算的候选保留 prevGain 参与前五筛选，但组内不参与买入排序（见下方 ordered 构建）
      candidates.push({
        sc,
        prevGain,
        stage2: stage2 != null && Number.isFinite(stage2) ? stage2 : -Infinity,
      });
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
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex, reportBuyTs);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      top5Candidates.push({ sc, reportCount, gain });
      continue;
    }
    if (isPureReportMode) {
      // 研报覆盖数最多/第二多（按对应 days 天统计）；覆盖数相同取 days 天涨幅最大
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex, reportBuyTs);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      val = reportCount * 100000 + gain;
      metric = reportCount;
    } else if (gainMode) {
      val = halfDayDate != null
        ? computeWindowGainWithHalf(sc.code, winDates, dailyInfos, sc.changePct, halfDayDate)
        : computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
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
  if (isPrevFall5Mode) {
    // 前N日「跌幅最大 / 波动最小」前五&当日指标最大：
    // 第一阶段：按前 N 日（不含今日）累计涨幅取前五（与第 5 名并列的全部纳入）
    //   top5：升序（跌幅最大在前）；low5（波动最小）：无论涨跌，按累计涨幅绝对值升序（波动最小在前）
    if (candidates.length === 0) return null;
    let topGroup;
    if (prevFallLowMode) {
      const byVol = candidates.slice().sort((a, b) => Math.abs(a.prevGain) - Math.abs(b.prevGain));
      const volThreshold = byVol[Math.min(4, byVol.length - 1)].prevGain;
      topGroup = byVol.filter(c => Math.abs(c.prevGain) <= Math.abs(volThreshold));
    } else {
      const byFall = candidates.slice().sort((a, b) => a.prevGain - b.prevGain);
      const fallThreshold = byFall[Math.min(4, byFall.length - 1)].prevGain;
      topGroup = byFall.filter(c => c.prevGain <= fallThreshold);
    }
    // 第二阶段：组内按当日实时指标（触发时点实时涨幅 / 日内实时抗分歧分数）降序；
    // 指标无法计算（-Infinity 占位）的候选不参与买入排序
    ordered = topGroup
      .filter(c => c.stage2 !== -Infinity)
      .sort((a, b) => b.stage2 - a.stage2)
      .map(c => ({ sc: c.sc, metric: parseFloat(c.stage2.toFixed(2)) }));
  } else if (isTop5ReportGainMode) {
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

  // 抗分歧≥11 门槛：门槛策略从排名最高者起向后找第一只满足的股票；其余策略不做校验，
  // 直接取策略排名指定名次的第一只（与原逻辑一致）。
  // 涨停顺延（全策略通用）：买点触发时点已涨停的候选（主板涨幅>9.5%、创业/科创>19%）实际无法成交，
  // 一律剔除并顺延至排名下一只；全部候选均涨停（或无有效候选）时当日不买入
  const skipped = []; // 因门槛策略抗分歧分数<11 被顺延跳过的前序股票（仅 RESILIENCE_GATE_STRATEGY_IDS 使用）
  const globalResilienceSkipped = []; // 因全局最低抗分歧 < GLOBAL_RESILIENCE_MIN 被顺延跳过（所有策略通用）
  const limitUpSkipped = []; // 因买点时点涨停被顺延跳过的候选（全策略通用，追加 limit_up_defer 买入明细）
  const prevOneWordSkipped = []; // 因上一交易日一字板被顺延跳过的候选（全策略通用，追加 one_word_board_defer 买入明细）
  const emoCycSkipped = []; // 因逆周期（与创业板指负相关）被顺延跳过的候选（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略，追加 cycle_defer 买入明细）
  const stockSlopeSkipped = []; // 因个股 MA3 切线正斜率连续天数 > 4 被顺延跳过
  // 个股斜率过滤触发条件：**仅指数今日盘中由负转正当日**（turnedPosToday=true）
  // 过滤规则：个股 MA3 切线正斜率连续天数 > 4 → 顺延下一只（= 4 允许）
  // 原因：指数刚由负转正，个股如果已经抢先连涨 ≥5 天是提前反应过大盘，不该再追
  const shouldCheckStockSlope = turnedPosInfo && (
    turnedPosInfo.cybTurnedPosToday || turnedPosInfo.starTurnedPosToday
  );
  for (let i = 0; i < ordered.length; i++) {
    const cand = ordered[i];
    if (isLimitUpAtBuy(cand.sc.code, cand.sc.changePct)) {
      limitUpSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时点涨幅
      });
      continue;
    }
    // 上一交易日一字板过滤（全策略通用，2026-10-05 新增）：昨日一字板的候选次日不买，
    // 剔除并顺延至排名下一只（set 为空视为无候选命中，不逐一判定）
    if (prevOneWordSet && prevOneWordSet.size > 0 && prevOneWordSet.has(cand.sc.code)) {
      prevOneWordSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时点涨幅
      });
      continue;
    }
    // 顺/逆周期过滤（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略，emoCycSet 非空时生效，2026-10-06 新增）：
    // 与创业板指最近 20 个交易日日收益率负相关/零相关的候选 = 逆周期 → 剔除并顺延至排名下一只
    if (emoCycSet && emoCycSet.size > 0 && emoCycSet.has(cand.sc.code)) {
      emoCycSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时点涨幅
        corr: cycCorrCache.get(`${cand.sc.code}_${rangeDates[di]}`), // 相关系数（可能为 null=数据不足，理论上不进集合）
      });
      continue;
    }
    // 全局最低抗分歧门槛（所有策略）：买点触发时刻个股抗分歧 < GLOBAL_RESILIENCE_MIN → 顺延
    const intradayResilience = calcResilienceAtMinute(replayStocks, cand.sc.code, bucket.minute);
    if (intradayResilience != null && intradayResilience < GLOBAL_RESILIENCE_MIN) {
      globalResilienceSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        resilience: Number(intradayResilience.toFixed(2)),
        reason: `买点时刻抗分歧 ${intradayResilience.toFixed(2)} < 全局最低 ${GLOBAL_RESILIENCE_MIN}`,
      });
      continue;
    }
    // 指数今日由负转正当日，检查个股 MA3 切线正斜率连续天数；> 4 则顺延（= 4 允许）
    if (shouldCheckStockSlope) {
      const slopeDays = countStockPositiveSlopeDays(cand.sc.code, rangeDates[di], dailyInfos);
      if (slopeDays != null && slopeDays > 4) {
        stockSlopeSkipped.push({
          code: cand.sc.code,
          name: cand.sc.name || cand.sc.code,
          slopeDays,
          reason: `跟踪指数今日由负转正，个股 MA3 切线正斜率已连续 ${slopeDays} 天（≤ 4 才允许）`,
        });
        continue;
      }
    }
    if (gateEnabled) {
      // RESILIENCE_GATE_STRATEGY_IDS（仅 highest_gain）：已经过了全局 ≥ 9 的线，这里再叠加 ≥ 11
      if (intradayResilience != null && intradayResilience >= RESILIENCE_GATE_MIN) {
        return { stock: cand.sc, metric: cand.metric, resilienceScore: intradayResilience, skipped, globalResilienceSkipped, limitUpSkipped, prevOneWordSkipped, emoCycSkipped, stockSlopeSkipped };
      }
      skipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时间点涨幅
        metric: gateIntradaySort ? undefined : cand.metric, // 窗口涨幅（排序依据，仅 N 日窗口涨幅排序的门槛策略输出）
        resilience: intradayResilience,
      });
    } else {
      return {
        stock: cand.sc,
        metric: cand.metric,
        resilienceScore: intradayResilience,
        limitUpSkipped,
        prevOneWordSkipped,
        emoCycSkipped,
        globalResilienceSkipped,
        stockSlopeSkipped,
        // 三日情绪冰点：附带命中的跟踪指数环境门禁明细（withResilienceGateInfo 会追加到买入条件明细）
        emo3Gate: isEmo3GateStrategy
          ? emo3IndexGateCache.get(`${rangeDates[di]}_${trackedIndexCodeOf(cand.sc.code)}`)
          : undefined,
      };
    }
  }
  return null; // 门槛策略：全部候选均不满足门槛；其余策略：候选全部涨停/抗分歧不足/无候选——均不买入
};

// ============================================================
// 买入条件明细中的选股顺延标注（抗分歧门槛）
// ============================================================
// 抗分歧门槛明细项：
//   - 全部策略：全局最低门槛 ≥ GLOBAL_RESILIENCE_MIN（当前 9）
//   - RESILIENCE_GATE_STRATEGY_IDS 门槛策略：叠加专项门槛 ≥ RESILIENCE_GATE_MIN（当前 11）
// passed 恒为 true：能入选即代表满足所有门槛
const buildResilienceGateCheck = (resilienceScore, gateSkipped, globalSkipped) => {
  const fmtChangePct = v => (v != null ? `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '无法计算');
  const gs = (globalSkipped || []).map(s => ({
    code: s.code, name: s.name, resilience: s.resilience,
  }));
  const ks = (gateSkipped || []).map(s => ({
    code: s.code, name: s.name,
    change: s.change != null ? Number(s.change) : null,
    metric: s.metric != null ? Number(s.metric) : null,
    resilience: s.resilience,
  }));
  const skipText = ks.map(s => `${s.name}（${s.metric != null ? `窗口涨幅 ${fmtChangePct(s.metric)}、` : ''}触发时涨幅 ${fmtChangePct(s.change)}、抗分歧 ${s.resilience != null ? s.resilience : '无法计算'}）`).join('、');
  const gsText = gs.map(s => `${s.name}（抗分歧 ${s.resilience}）`).join('、');
  const title = ks.length > 0 || gs.length > 0
    ? `触发时点抗分歧分数≥${GLOBAL_RESILIENCE_MIN}${ks.length > 0 ? `（${RESILIENCE_GATE_STRATEGY_IDS.has('highest_gain') ? '最高涨幅策略专项≥' + RESILIENCE_GATE_MIN : ''}）` : ''}`
    : `触发时点抗分歧分数≥${GLOBAL_RESILIENCE_MIN}`;
  let reason = null;
  if (gs.length > 0 && ks.length > 0) {
    reason = `前序股票全局最低抗分歧不足（${gsText}）+ 专项门槛不足（${skipText}）依次顺延，轮到本股买入（本股触发时点抗分歧 ${resilienceScore}）`;
  } else if (gs.length > 0) {
    reason = `前序股票全局最低抗分歧不足（${gsText}）依次顺延，轮到本股买入（本股触发时点抗分歧 ${resilienceScore}）`;
  } else if (ks.length > 0) {
    reason = `前序股票专项门槛不足（${skipText}）依次顺延，轮到本股买入（本股触发时点抗分歧 ${resilienceScore}）`;
  } else {
    reason = `直接入选，未发生顺延（本股触发时点抗分歧 ${resilienceScore}，≥ 全局最低 ${GLOBAL_RESILIENCE_MIN}）`;
  }
  return {
    id: 'resilience_gate',
    title,
    passed: true,
    value: resilienceScore != null ? `${resilienceScore}` : '--',
    skippedStocks: [...gs, ...ks], // 合并全局 + 专项顺延明细
    reason,
  };
};

// 涨停顺延明细（全策略通用）：买点触发时点已涨停的候选被剔除并顺延至排名下一只时，
// 在买入条件明细中追加 limit_up_defer 项（口径与重点板块系列的 key_block_limit_up 一致）
const buildLimitUpDeferCheck = (limitUpSkipped) => {
  const fmtChangePct = v => (v != null ? `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%` : '无法计算');
  const skippedStocks = (limitUpSkipped || []).map(s => ({
    code: s.code,
    name: s.name,
    change: s.change != null ? Number(s.change) : null, // 触发时间点涨幅
  }));
  const skipText = skippedStocks.map(s => `${s.name}（触发时涨幅 ${fmtChangePct(s.change)}）`).join('、');
  return {
    id: 'limit_up_defer',
    title: '涨停过滤（主板>9.5%、创业/科创>19%）',
    passed: true,
    value: skippedStocks.length > 0 ? `顺延 ${skippedStocks.length} 只` : '无涨停候选',
    skippedStocks, // 结构化顺延明细（前端抽屉/报告悬停展示为表格）
    reason: `买入时点涨停候选已剔除并顺延：${skipText}（涨停股买入不可成交，顺延至排名下一只）`,
  };
};

// 上一交易日一字板顺延明细（全策略通用，2026-10-05 新增）：上一交易日一字板的候选被剔除并顺延
// 至排名下一只时，追加 one_word_board_defer 买入明细项（口径与 limit_up_defer 一致）
const buildOneWordBoardDeferCheck = (prevOneWordSkipped) => {
  const skippedStocks = (prevOneWordSkipped || []).map(s => ({
    code: s.code,
    name: s.name,
  }));
  const skipText = skippedStocks.map(s => s.name).join('、');
  return {
    id: 'one_word_board_defer',
    title: '上一交易日一字板过滤（主板≥8%、创业/科创≥16%）',
    passed: true,
    value: skippedStocks.length > 0 ? `顺延 ${skippedStocks.length} 只` : '无一字板候选',
    skippedStocks, // 结构化顺延明细（前端抽屉/报告悬停展示为表格）
    reason: skippedStocks.length > 0
      ? `上一交易日一字板候选已剔除并顺延：${skipText}（昨日开盘/收盘/最低涨幅均达涨停阈值，全天封死一字板；一字板次日难以上车且追高风险大，顺延至排名下一只）`
      : '候选中无上一交易日一字板股（主板开盘/收盘/最低涨幅均≥8%、创业/科创均≥16% 视为一字板）',
  };
};

// 顺/逆周期过滤顺延明细（2026-10-06 新增，适用除情绪游资/三日情绪冰点/尾盘抄底外的全部策略）：
// 与创业板指最近 N 个交易日日收益率负相关/零相关的候选（逆周期）被剔除并顺延至排名下一只时，
// 追加 cycle_defer 买入明细项，记录被顺延股票与相关系数（口径与 one_word_board_defer 一致）
const buildCycleDeferCheck = (emoCycSkipped) => {
  const skippedStocks = (emoCycSkipped || []).map(s => ({
    code: s.code,
    name: s.name,
    corr: s.corr != null && Number.isFinite(Number(s.corr)) ? Number(Number(s.corr).toFixed(4)) : null,
  }));
  const skipText = skippedStocks
    .map(s => `${s.name}（相关系数 ${s.corr != null ? s.corr.toFixed(2) : '数据不足'}）`)
    .join('、');
  return {
    id: 'cycle_defer',
    title: `顺周期过滤（与创业板指近${CYC_CORR_WINDOW}日相关性>${CYC_MIN_CYB_CORR}）`,
    passed: true,
    value: skippedStocks.length > 0 ? `顺延 ${skippedStocks.length} 只` : '无逆周期候选',
    skippedStocks, // 结构化顺延明细（前端抽屉/报告悬停展示为表格）
    reason: skippedStocks.length > 0
      ? `逆周期候选已剔除并顺延：${skipText}（与创业板指最近 ${CYC_CORR_WINDOW} 个交易日日收益率呈负相关/零相关，非顺周期；快进快出策略仅买入顺周期股，顺延至排名下一只）`
      : `候选均为顺周期或无足够数据判定（与创业板指最近 ${CYC_CORR_WINDOW} 个交易日日收益率正相关为顺周期；数据不足时不拦截）`,
  };
};

// 情绪开关分支明细项（prev{N}d_fall_low5_day_gain_emoswitch 系列）：
// 标注本次买入由开关的哪个分支触发——上一交易日科技情绪 3 日 EMA 低于阈值走「前N波动最小&当日涨幅最大」，否则走「3日涨幅最大」
const buildEmoSwitchBranchCheck = (info) => ({
  id: 'emo_switch_branch',
  title: '情绪开关分支',
  passed: true,
  value: info.branch,
  reason: info.ema != null
    ? `上一交易日科技情绪 3 日 EMA = ${info.ema}（< ${EMO_SWITCH_EMA_THRESHOLD}）→ 走「${info.branch}」选股买入`
    : `上一交易日科技情绪 3 日 EMA 无数据（缺失按「否则」分支处理）→ 走「${info.branch}」选股买入`,
});

// 情绪快进快出标注明细项（highest_{N}d_gain_emoquick 系列）：标注本次买入是否为「快进快出」买入
//（触发条件二选一：上一交易日科技情绪 3 日 EMA < -60；或上上个、上个交易日的当日科技情绪原始分
// 均处 -30~20 区间且回升）——是则该笔持仓不走通用 7 条件卖点、买入次日 10:00 强制卖出；
// 2026-10-05 叠加：持仓次日盘中跌破成本线 -2% 时先到先卖止损；
// 2026-10-09 叠加：次日命中强卖豁免（10:00 前买点再触发 / 10:00 时点科技情绪>0+低于开盘价<30只+资金净流入>0）则不强卖、转由通用卖点接管
const buildEmoQuickOutCheck = (info) => ({
  id: 'emo_quick_out',
  title: '情绪快进快出（次日10:00强卖）',
  passed: true,
  value: info.quickOut ? '快进快出' : '普通持仓',
  reason: info.quickOut
    ? (info.trigger === 'range_rising'
      ? `上上个交易日科技情绪 = ${info.prev2Raw != null ? info.prev2Raw : '缺失'}、上一交易日 = ${info.prevRaw != null ? info.prevRaw : '缺失'}（当日原始分，均在 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间且较前日回升），本次买入为快进快出：次日 10:00 强制卖出（不走通用 7 条件卖点；盘中跌破成本线 -2% 时先到先卖止损；命中强卖豁免——次日 10:00 前买点诊断再次触发，或 10:00 时点科技情绪>0、自选股低于开盘价<30只、主力资金净流入>0 三者同时满足——则不强卖、转由通用卖点接管）`
      : `上一交易日科技情绪 3 日 EMA = ${info.ema}（< ${EMO_SWITCH_EMA_THRESHOLD}），本次买入为快进快出：次日 10:00 强制卖出（不走通用 7 条件卖点；盘中跌破成本线 -2% 时先到先卖止损；命中强卖豁免——次日 10:00 前买点诊断再次触发，或 10:00 时点科技情绪>0、自选股低于开盘价<30只、主力资金净流入>0 三者同时满足——则不强卖、转由通用卖点接管）`)
    : `上一交易日科技情绪 3 日 EMA = ${info.ema != null ? info.ema : '缺失'}（不满足 < ${EMO_SWITCH_EMA_THRESHOLD}），上两交易日当日科技情绪 = ${info.prev2Raw != null ? info.prev2Raw : '缺失'} / ${info.prevRaw != null ? info.prevRaw : '缺失'}（不满足均处 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间且回升），普通持仓，走通用 7 条件卖点`,
});

// 科技板块效应筛选明细项（tech_block_top3_* 系列）：标注本次买点触发时点 tag=进攻 板块按板块盘中涨幅
// （触发时点成分股实时涨幅均值）取前三的结果，以及前三板块成分股与全量自选科技股取交集后的候选数量
const buildTechTop3BlockCheck = (info) => {
  const fmt = (b) => `${b.blockName} ${b.gain > 0 ? '+' : ''}${b.gain}%`;
  const text = (info.blocks || []).map(fmt).join('、') || '无';
  const at = `${info.date}${info.time ? ' ' + info.time : ''}`;
  return {
    id: 'tech_block_top3',
    title: '科技板块效应筛选（进攻 tag 板块盘中涨幅前三 ∩ 自选科技股）',
    passed: true,
    value: text,
    reason: `${at} 买点触发时点 tag=进攻 的重点板块按板块盘中涨幅（触发时点成分股实时涨幅均值）前三：${text}；前三板块成分股与全量自选科技股（isTech ≠ false）取交集后候选 ${info.candidateCount} 只，在其中选 N 日涨幅最大的一只`,
  };
};

// 快进快出持仓强卖的 sellReason（按触发条件区分文案；Inner/Multi 两处强卖点共用）
const buildQuickOutSellReason = (info) => {
  if (info?.trigger === 'range_rising') {
    return `情绪快进快出：买入日前两交易日当日科技情绪温和回升（${info.prev2Raw != null ? info.prev2Raw : '缺失'} → ${info.prevRaw != null ? info.prevRaw : '缺失'}，均在 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间），次日 10:00 强制卖出`;
  }
  return `情绪快进快出：买入日上一交易日科技情绪 3 日 EMA ${info?.ema != null ? info.ema : '缺失'} < ${EMO_SWITCH_EMA_THRESHOLD}，次日 10:00 强制卖出`;
};

// 快进快出持仓盘中跌破成本线止损的 sellReason（先到先卖、先于当日 10:00 强卖；Inner/Multi 两处共用）
// stopPct：成本线止损百分比（常规 emoquick 策略为 2，两次买入系列为 4），阈值 = 买入价 × (1 - stopPct/100)
const buildQuickOutStopLossReason = (buyPrice, stopPt, desc, stopPct = 2) => {
  const pct = Number(stopPct);
  const threshold = parseFloat((Number(buyPrice) * (1 - pct / 100)).toFixed(2));
  const stopTime = `${String(Math.floor(Number(stopPt.minute) / 100)).padStart(2, '0')}:${String(Number(stopPt.minute) % 100).padStart(2, '0')}`;
  return `情绪快进快出：${desc}，触发成本线 -${pct}% 止损（买入价 ${Number(buyPrice).toFixed(2)}、阈值 ${threshold.toFixed(2)}，${stopTime} 价 ${Number(stopPt.lastPx).toFixed(2)} 成交），先于当日 10:00 强卖离场`;
};

// 快进快出 10:00 强卖豁免判定（2026-10-09 用户新增）：次日 10:00 强卖前先做两种「次日强势」判断，
// 命中任一即豁免本次强卖，持仓保留并转由通用 7 条件卖点接管（先一直拿着，等命中其他卖点规则再卖）：
//   豁免① 次日 10:00 前（含 10:00）任一桶买点诊断再次全部通过（runBuyPointDiagnosis allPassed）；
//   豁免② 次日 10:00 时点（无 10:00 桶时取其后最近桶，整日缺失时回退当日最后一桶）三条件同时满足：
//          科技情绪 > 0 且 自选股现价低于 9:30 开盘价个股数 < 30（口径同买点诊断检查4，阈值取严格小于）
//          且 大盘主力资金净流入（bucket.fundFlow 累计值）> 0。
// 返回 { via: 'buy_retrigger' | 'strong_at_10', detail } 或 null（不豁免）；任一条件数据缺失按不满足处理（照常强卖）。
// 注意：豁免只取消 10:00 强卖本身，盘中跌破成本线 -2% 止损仍先到先卖（止损本身即「其他卖点规则」之一）
const buildQuickOutExemptInfo = (timeBuckets, campData) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0) return null;
  // 豁免①：10:00 前（含）任一桶买点诊断再次触发
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) > 1000) break;
    const diag = runBuyPointDiagnosis(buckets, i, campData)?.data;
    if (diag?.allPassed === true) {
      return { via: 'buy_retrigger', detail: `${diag.displayTime} 买点诊断再次触发` };
    }
  }
  // 豁免②：10:00 时点「科技情绪>0 + 低于开盘价<30只 + 资金净流入>0」三条件同时满足
  const emoBucket = buckets.find(b => Number(b.minute) >= 1000) || buckets[buckets.length - 1];
  const emo = emoBucket.techEmotion != null && !Number.isNaN(Number(emoBucket.techEmotion)) ? Number(emoBucket.techEmotion) : null;
  const fund = emoBucket.fundFlow != null && !Number.isNaN(Number(emoBucket.fundFlow)) ? Number(emoBucket.fundFlow) : null;
  const openingBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
  const openingMap = new Map((openingBucket?.stockChanges || []).map(s => [s.code, s.changePct]));
  let belowCount = 0;
  (emoBucket.stockChanges || []).forEach(s => {
    const openPct = openingMap.get(s.code);
    if (openPct !== undefined && openPct !== null && Number(s.changePct) < Number(openPct)) belowCount++;
  });
  const emoOk = emo != null && emo > 0;
  const fundOk = fund != null && fund > 0;
  const belowOk = belowCount < 30;
  if (emoOk && belowOk && fundOk) {
    return {
      via: 'strong_at_10',
      detail: `10:00 时点科技情绪 ${emo.toFixed(2)} > 0、自选股低于开盘价 ${belowCount} 只 < 30、主力资金净流入 ${fund.toFixed(2)} 亿 > 0`,
    };
  }
  return null;
};

// 快进快出强卖豁免持仓最终经通用卖点卖出时，sellReason 尾部追加的豁免说明（Inner/Multi 两处通用卖点共用）
const buildQuickOutExemptSuffix = (pos) => {
  const ex = pos?.emoQuickOut?.exempted;
  return ex ? `（${ex.date} 快进快出 10:00 强卖豁免：${ex.detail}，转由通用卖点接管）` : '';
};

// 将选股顺延信息追加到买入原因/明细：发生顺延时在 buyReason 尾部标注，buyChecks 追加 resilience_gate 明细项。
// 仅 RESILIENCE_GATE_STRATEGY_IDS 门槛策略（当前仅买入最高涨幅）的选股结果带
// resilienceScore/skipped，其余策略（含抗分歧弱转强）返回结构不含该字段，此处自动跳过标注（买入原因/明细保持原样）；
// 全部策略的选股结果都可能带 limitUpSkipped（买点时点涨停被顺延的候选），追加 limit_up_defer 明细项并标注买入原因；
// 三日情绪冰点策略的选股结果带 emo3Gate（跟踪指数环境门禁命中明细），追加 emo3_index_gate 明细项
// 将选股顺延信息追加到买入原因/明细：
//   - 全部策略都可能带 resilienceScore（买点时刻抗分歧分数）：有分数就追加全局 ≥ 9 的 resilience_gate 明细；
//     若全局不达标（globalResilienceSkipped）或门槛策略专项不达标（skipped），追加顺延标注；
//   - 全部策略都可能带 limitUpSkipped（买点时点涨停被顺延的候选），追加 limit_up_defer 明细项并标注买入原因；
//   - 三日情绪冰点策略的选股结果带 emo3Gate（跟踪指数环境门禁命中明细），追加 emo3_index_gate 明细项
const withResilienceGateInfo = (buyInfo, picked) => {
  if (!buyInfo || !picked) return buyInfo;
  const hasLimitUp = Array.isArray(picked.limitUpSkipped) && picked.limitUpSkipped.length > 0;
  const hasOneWord = Array.isArray(picked.prevOneWordSkipped) && picked.prevOneWordSkipped.length > 0;
  const hasEmoCyc = Array.isArray(picked.emoCycSkipped) && picked.emoCycSkipped.length > 0;
  const hasGlobalSkip = Array.isArray(picked.globalResilienceSkipped) && picked.globalResilienceSkipped.length > 0;
  const hasGateSkip = Array.isArray(picked.skipped) && picked.skipped.length > 0;
  // 早返回：既没有分数也没有任何顺延信息也没有情绪冰点门禁/情绪开关分支/情绪快进快出标注
  if (picked.resilienceScore == null && !picked.emo3Gate && !picked.emoSwitchBranch && !picked.emoQuickOut && !picked.techTop3Block && !hasLimitUp && !hasOneWord && !hasEmoCyc && !hasGlobalSkip && !hasGateSkip) return buyInfo;
  let buyReason = buyInfo.buyReason;
  const buyChecks = [...(buyInfo.buyChecks || [])];
  if (hasLimitUp) {
    buyChecks.push(buildLimitUpDeferCheck(picked.limitUpSkipped));
  }
  if (hasOneWord) {
    // 上一交易日一字板顺延：追加 one_word_board_defer 明细项（全策略通用）
    buyChecks.push(buildOneWordBoardDeferCheck(picked.prevOneWordSkipped));
  }
  if (hasEmoCyc) {
    // 顺/逆周期过滤顺延：追加 cycle_defer 明细项（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略）
    buyChecks.push(buildCycleDeferCheck(picked.emoCycSkipped));
  }
  if (picked.resilienceScore != null) {
    // 全局最低抗分歧 ≥ 9 + 门槛策略专项 ≥ 11（RESILIENCE_GATE_STRATEGY_IDS）
    buyChecks.push(buildResilienceGateCheck(picked.resilienceScore, picked.skipped, picked.globalResilienceSkipped));
  }
  if (picked.emo3Gate) {
    buyChecks.push(buildEmo3GateCheck(picked.emo3Gate));
  }
  if (picked.emoSwitchBranch) {
    // 情绪开关系列：标注本次买入由哪个分支触发（明细项 + 买入原因尾部标签，前端抽屉直接可见）
    buyChecks.push(buildEmoSwitchBranchCheck(picked.emoSwitchBranch));
    buyReason = `${buyReason}｜情绪开关→${picked.emoSwitchBranch.branch}`;
  }
  if (picked.emoQuickOut) {
    // 情绪快进快出系列：标注本次买入是否为快进快出（明细项；快进快出时买入原因尾部加标签）
    buyChecks.push(buildEmoQuickOutCheck(picked.emoQuickOut));
    if (picked.emoQuickOut.quickOut) {
      const quickTag = picked.emoQuickOut.trigger === 'range_rising' ? '情绪回升快进快出(次日10:00强卖)' : '情绪-60快进快出(次日10:00强卖)';
      buyReason = `${buyReason}｜${quickTag}`;
    }
  }
  if (picked.techTop3Block) {
    // 科技板块前三系列：标注当日进攻 tag 板块涨幅前三与交集后候选数量
    buyChecks.push(buildTechTop3BlockCheck(picked.techTop3Block));
  }
  const suffixParts = [];
  if (hasLimitUp) suffixParts.push('前序股票涨停');
  if (hasOneWord) suffixParts.push('前序股票昨日一字板');
  if (hasEmoCyc) suffixParts.push('前序股票逆周期');
  if (hasGlobalSkip) suffixParts.push(`前序股票买点抗分歧<${GLOBAL_RESILIENCE_MIN}`);
  if (hasGateSkip) suffixParts.push(`前序股票抗分歧<${RESILIENCE_GATE_MIN}`);
  if (suffixParts.length > 0) {
    buyReason = `${buyInfo.buyReason}（因${suffixParts.join('/')}顺延买入）`;
  }
  return { buyReason, buyChecks };
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
//     卖点：斜率由负转正当桶 ∪ 个股分时价跌破成本线 -5% 止损（双卖点任一先触发即卖，同桶可转手买入进攻股）
//           （逆周期情绪游资 iceMode 方向相反、止损为 -2%，且额外增加「14:55 下影线 ≥ 实体 2 倍」强卖，见 ICE_DESC / costLinePct）
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

// 创业板 / 科创板指 3 日线斜率（**MA3 切线方向**：MA3(今日) − MA3(昨日)，按当日收盘已基本定型口径，
//  MA 截止口径对齐 calcEmo3IndexGate：日K过滤升序、close_px>0），用途：
//   - 本次 N 日涨幅最大系列跨指数双门禁：创业板指跟踪主板/创业板股票，科创 50 跟踪科创板股票
//   - 卖出条件3门禁：斜率 > 0 时「科技板块情绪退潮」条件才参与进攻持仓卖出判定
//   - 斜率翻转状态机初值：回测首日前一交易日的收盘斜率符号（2026-10-01 重构）
// 关键说明（2026-10-02 用户修正）：斜率口径从旧版 MA3 − 5 个交易日前 MA3 改成 MA3 − 昨 MA3（MA3 切线方向），
//  因旧版滞后、与 K 线图上看的"均线斜率"直觉语义不符。MA3 切线需要最少 4 根日K即可计算。
// 盘中实时翻转判定统一走 getIndexMa3SlopeIntraday；
//  一次拉取日K批量计算全序列（历史不可变，进程内按 indexCode 独立缓存），数据不足（<4根）/获取失败返回 null
// EMO3_GATE_INDEX_CODES 已包含 sz399006（创业板指）和 sh000688（科创 50）两项配置，直接复用
let indexMa3SlopeSeriesPromises = new Map(); // indexCode -> Promise<{ dates, closes, slopes }>
const ensureIndexMa3SlopeSeries = async (indexCode) => {
  let p = indexMa3SlopeSeriesPromises.get(indexCode);
  if (p) return p;
  const conf = EMO3_GATE_INDEX_CODES.find(c => c.code === indexCode);
  if (!conf) throw new Error(`未知指数: ${indexCode}`);
  p = (async () => {
    const kline = await loadIndexKline(conf.cacheName, conf.pureCode, conf.market, 100);
    const bars = (kline || [])
      .filter(k => Number.isFinite(Number(k.trade_date)) && Number.isFinite(Number(k.close_px)) && Number(k.close_px) > 0)
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const dates = bars.map(k => Number(k.trade_date));
    const closes = bars.map(k => Number(k.close_px));
    const avgLast = (i, period) => closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
    const slopes = new Map(); // date -> slope（索引 i>=3 即至少 4 根日K，MA3(今日) 和 MA3(昨日) 各 3 根）
    for (let i = 3; i < closes.length; i++) {
      slopes.set(dates[i], parseFloat((avgLast(i, 3) - avgLast(i - 1, 3)).toFixed(4)));
    }
    return { dates, closes, slopes };
  })().catch((e) => {
    indexMa3SlopeSeriesPromises.delete(indexCode); // 失败允许下次重试
    throw e;
  });
  indexMa3SlopeSeriesPromises.set(indexCode, p);
  return p;
};

// 某交易日某指数 3 日线斜率；目标日缺K线（数据缺日）时回退用 <= 目标日的最近交易日斜率；
// 数据不足/获取失败返回 null
const getIndexMa3Slope = async (indexCode, dateStr) => {
  try {
    const { dates, slopes } = await ensureIndexMa3SlopeSeries(indexCode);
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
// 科创板同理，两个缓存互相独立
const indexTlineCache = new Map(); // key=`${indexCode}_${dateStr}` -> [{ minute, lastPx }] | null
const getIndexTlinePoints = async (indexCode, dateStr) => {
  const key = `${indexCode}_${dateStr}`;
  if (indexTlineCache.has(key)) return indexTlineCache.get(key);
  let points = null;
  try {
    const tline = await getSingleStockTlineDataByDate(indexCode, parseInt(dateStr, 10));
    points = (tline?.line || [])
      .filter(p => p && p.minute != null && p.last_px != null)
      .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
      .filter(p => p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
  } catch (e) {
    points = null;
  }
  // 缓存上限：每个指数最多 200 天，两个指数加起来 ≤ 400（和之前单缓存上限一致）
  if (indexTlineCache.size > 400) indexTlineCache.clear();
  indexTlineCache.set(key, points);
  return points;
};

// 兼容旧函数名（固定创业板指）
const cybTlineCache = new Map(); // 保留旧变量名避免被外部误用（实际新逻辑已统一走 indexTlineCache）
const getKeyBlockCybTlinePoints = async (dateStr) => getIndexTlinePoints('sz399006', dateStr);

// 盘中实时指数 3 日线斜率（2026-09-30 用户要求：买入/卖出不等收盘，盘中实时计算）：
//   MA3(今日实时) = (前第2交易日收盘 + 前第1交易日收盘 + 当日实时价) / 3
//   MA3(昨日收盘) = (前第3交易日收盘 + 前第2交易日收盘 + 前第1交易日收盘) / 3
//   slope = MA3(今日实时) − MA3(昨日收盘)  ← MA3 切线方向
// 与收盘口径 ensureIndexMa3SlopeSeries 完全对齐（收盘后实时价=当日收盘价，两者一致）。
// minute 为 HHMM 整数；当日实时价取指数分时中 minute ≤ 目标分钟的最后一点。
// 数据不足（早于目标日的日K不足 3 根）/分时拉取失败/该时点前无分时 → 返回 null
const getIndexMa3SlopeIntraday = async (indexCode, dateStr, minute) => {
  try {
    const { dates, closes } = await ensureIndexMa3SlopeSeries(indexCode);
    const target = Number(dateStr);
    // hi = 严格早于目标日的最近交易日索引（当日收盘价由盘中实时价代替，不使用当日K线）
    let hi = -1;
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] < target) hi = i; else break;
    }
    if (hi < 2) return null; // MA3(昨日) 需要 closes[hi-2..hi]
    const pts = await getIndexTlinePoints(indexCode, dateStr);
    if (!pts || pts.length === 0) return null;
    let atPt = null;
    for (const p of pts) {
      if (p.minute <= Number(minute)) atPt = p; else break;
    }
    if (!atPt) return null;
    const maNow = (closes[hi - 1] + closes[hi] + atPt.lastPx) / 3;
    const maPrev = (closes[hi - 2] + closes[hi - 1] + closes[hi]) / 3;
    return parseFloat((maNow - maPrev).toFixed(4));
  } catch (e) {
    return null;
  }
};

// 兼容旧函数名（固定创业板指）
const getKeyBlockCybMa3SlopeIntraday = async (dateStr, minute) => getIndexMa3SlopeIntraday('sz399006', dateStr, minute);

// 兼容旧函数名（固定创业板指）
const getKeyBlockCybMa3Slope = async (dateStr) => getIndexMa3Slope('sz399006', dateStr);

// 逆周期情绪游资信号指数：上证指数 sh000001（方向与创业板口径相反——斜率为正买、为负卖）
const ICE_SIGNAL_INDEX_CODE = 'sh000001';
const ICE_SIGNAL_INDEX_NAME = '上证指数';
const getIceMa3SlopeIntraday = async (dateStr, minute) => getIndexMa3SlopeIntraday(ICE_SIGNAL_INDEX_CODE, dateStr, minute);
const getIceMa3Slope = async (dateStr) => getIndexMa3Slope(ICE_SIGNAL_INDEX_CODE, dateStr);

// 斜率数值格式化（带正负号，2 位小数；null 显示 --）
const fmtKeyBlockSlope = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`);
// 交易日数值（20260804）→ 展示字符串（2026-08-04），后端本地工具（避免引用前端 fmtDate）
const fmtCybGateDate = (d) => {
  const s = String(d == null ? '' : d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
};

// ---------------------------------------------------------------------------
// N 日涨幅最大系列买入环境门禁（2026-10-02 用户新增；盘中实时口径；跨指数双门禁）：
//   创业板指 3 日线斜率（sz399006）跟踪 主板（60/00）+ 创业板（30）自选股
//   科创 50  3 日线斜率（sh000688）跟踪 科创板（68）自选股
// 三条规则（按优先级）：① slope<0 且不在转负两日禁入窗口 → 始终允许；② 由负转正当天+次日允许；
//   ③a 今日盘中由正转负 → 当日禁止；③b 转负后第 1 天（前一交易日转负且今日 slope<0 盘中未转正）→ 次日也禁止
// 买入选股时，根据两个指数各自门禁是否允许，过滤出允许的市场集合，
// 只从允许的集合中选 N 日涨幅最大；两个都允许 → 全池；都禁止 → 跳过买入
// 仅对常规 N 日涨幅最大策略启用，key_block / tail_dip / sentiment 系列有各自独立门禁
// ---------------------------------------------------------------------------
// 指数斜率门禁（双指数：创业板指 sz399006 + 科创 50 sh000688）适用策略集合。
// 排除以下前缀的策略（它们有独立的情绪/板块门禁，不走指数斜率）：
//   key_block_*        重点板块
//   hot_money_ice_*    逆周期情绪游资（复用重点板块引擎，但走斜率由正转负的独立门禁）
//   tail_dip_*         尾盘抄底（含 emo3 变体 tail_dip_emo3_*）
// 三日情绪冰点策略全部包含在 tail_dip_emo3_* 内，随 tail_dip_* 一起排除。
// 构建方式：从 STRATEGIES 枚举中排除上述前缀，未来新增策略只要不在这 3 组前缀里自动纳入。
const CYB_GATE_EXCLUDE_PREFIX = ['key_block_', 'hot_money_ice_', 'tail_dip_'];
const CYB_GATE_STRATEGY_IDS = new Set(Object.keys(STRATEGIES).filter(id => !CYB_GATE_EXCLUDE_PREFIX.some(p => id.startsWith(p))));

// 指数代码
const CYB_INDEX_CODE = 'sz399006';
const STAR_INDEX_CODE = 'sh000688';
const CYB_INDEX_NAME = '创业板指';
const STAR_INDEX_NAME = '科创50';

// 代码前缀 → 跟踪的指数代码（30 开头属创业板，跟创业板指；68 科创板，跟科创 50；其余 60/00 跟创业板指）
const codeToGateIndex = (code) => {
  const c = String(code).replace(/^SH|^SZ|^BJ/i, '');
  if (/^68/.test(c)) return STAR_INDEX_CODE;
  return CYB_INDEX_CODE;
};
// 反向：指数代码 → 允许的代码前缀数组
const gateIndexToPrefixes = (indexCode) => {
  if (indexCode === STAR_INDEX_CODE) return ['68'];
  return ['60', '00', '30'];
};
// 指数代码 → 中文名
const gateIndexName = (code) => code === STAR_INDEX_CODE ? STAR_INDEX_NAME : CYB_INDEX_NAME;

// 逆周期情绪游资（防御池）抗分歧跟踪指数映射：与「科技股统一跟踪创业板指」不同——
// 防御性股票（主板 60/00）跟踪上证指数 sh000001（不再跟踪与科技绑定的创业板指）；
// 创业板(30) 跟踪创业板指 sz399006；科创板(68) 跟踪科创 50 sh000688
const ICE_SH_INDEX_CODE = 'sh000001';
const ICE_SH_INDEX_NAME = '上证指数';
const iceResilienceIndexCode = (code) => {
  const c = String(code).replace(/^SH|^SZ|^BJ/i, '');
  if (/^68/.test(c)) return STAR_INDEX_CODE;
  if (/^30/.test(c)) return CYB_INDEX_CODE;
  return ICE_SH_INDEX_CODE;
};
const iceIndexName = (indexCode) => indexCode === STAR_INDEX_CODE
  ? STAR_INDEX_NAME
  : (indexCode === CYB_INDEX_CODE ? CYB_INDEX_NAME : ICE_SH_INDEX_NAME);

// 预计算某个指数 rangeDates 每日收盘口径斜率 + 历史「由负转正 / 由正转负」事件索引（只提供历史初值）
// 返回 Map<dateNum, { slopeClose, turnPosDate|null, daysSinceTurnPos, turnNegDate|null, daysSinceTurnNeg }>
const precomputeTurnMap = async (indexCode, rangeDates) => {
  const { dates, slopes } = await ensureIndexMa3SlopeSeries(indexCode);
  const sorted = [...rangeDates].map(Number);
  const result = new Map();
  const slopeByDate = new Map();
  for (const target of sorted) {
    let found = null;
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= target) { found = slopes.get(dates[i]); break; }
    }
    slopeByDate.set(target, found != null ? Number(found) : null);
  }
  let lastPosDateNum = null, lastNegDateNum = null;
  const firstTarget = sorted[0];
  let lo = -1;
  for (let i = 0; i < dates.length; i++) { if (dates[i] < firstTarget) lo = i; else break; }
  if (lo >= 0) {
    for (let i = lo; i > 0; i--) {
      const cur = slopes.get(dates[i]), prev = slopes.get(dates[i - 1]);
      if (cur != null && prev != null) {
        if (prev <= 0 && cur > 0 && lastPosDateNum == null) lastPosDateNum = dates[i];
        if (prev > 0 && cur <= 0 && lastNegDateNum == null) lastNegDateNum = dates[i];
      }
    }
  }
  for (const target of sorted) {
    const curSlope = slopeByDate.get(target);
    if (curSlope != null) {
      const prevIdx = sorted.indexOf(target) - 1;
      const prevNum = prevIdx >= 0 ? sorted[prevIdx] : null;
      const prevS = prevNum != null ? slopeByDate.get(prevNum) : null;
      if (prevS != null && prevS <= 0 && curSlope > 0) lastPosDateNum = target;
      if (prevS != null && prevS > 0 && curSlope <= 0) lastNegDateNum = target;
    }
    const daysSince = (fromDate, fromIdxName) => {
      if (fromDate == null) return null;
      let a = -1, b = -1;
      for (let i = 0; i < dates.length; i++) {
        if (a === -1 && dates[i] === fromDate) a = i;
        if (b === -1 && dates[i] === target) b = i;
      }
      return a >= 0 && b >= 0 && b >= a ? b - a : null;
    };
    const dPos = daysSince(lastPosDateNum);
    const dNeg = daysSince(lastNegDateNum);
    result.set(target, {
      slopeClose: curSlope,
      turnPosDate: lastPosDateNum, daysSinceTurnPos: dPos,
      turnNegDate: lastNegDateNum, daysSinceTurnNeg: dNeg,
    });
  }
  return result;
};

// 判定**单个指数**在某个时点是否满足新三条规则（盘中实时口径）
//   规则 优先级  条件                                                                   判定
//   ③a 最高    今日盘中由正转负（前收盘正、当前 ≤ 0）                                   T 日禁止
//   ③b   高    slope < 0 且前一交易日是"由正转负日"且今日盘中未转正                     T+1 日禁止
//   ②a  中高   slope ≥ 0 且今日盘中由负转正                                           T 日允许
//   ②b  中     slope ≥ 0 且距最近由负转正 = 1（转负后第 1 天）                          T+1 日允许
//   ①   中     slope < 0 且不在③a③b窗口                                               始终允许
//   禁   低    slope ≥ 0 且不在转正窗口                                               禁止
// 盘中实时口径：今日翻转用 前一交易日收盘斜率 vs 当前桶实时斜率 判定
// 返回 { passed, slope, daysSinceTurnPos, turnPosDate, daysSinceTurnNeg, turnNegDate,
//        prevCloseSlope, turnedPosToday, turnedNegToday, isDayAfterTurnNeg, reason }
const checkIndexGate = async (indexCode, dateStr, minute, precomputed, runtimeState) => {
  const dateNum = Number(dateStr);
  const info = precomputed.get(dateNum);
  const state = {
    slope: null, slopeClose: info?.slopeClose ?? null,
    daysSinceTurnPos: null, turnPosDate: null,
    daysSinceTurnNeg: null, turnNegDate: null,
    prevCloseSlope: null, turnedPosToday: false, turnedNegToday: false,
    isDayAfterTurnNeg: false, // 前一交易日是"由正转负日"（来源：runtimeState.lastNegTurnDate 或 precomputed 的 daysSinceTurnNeg===1）
  };
  const { dates, slopes } = await ensureIndexMa3SlopeSeries(indexCode);
  let prevCloseSlope = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] < dateNum) { const s = slopes.get(dates[i]); if (s != null) prevCloseSlope = Number(s); break; }
  }
  state.prevCloseSlope = prevCloseSlope;

  let slope = await getIndexMa3SlopeIntraday(indexCode, dateStr, minute);
  const usePrevCloseFallback = slope == null || !Number.isFinite(Number(slope));
  if (usePrevCloseFallback) slope = prevCloseSlope ?? null;
  state.slope = slope;
  if (slope == null || !Number.isFinite(Number(slope))) {
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 3 日线斜率数据不足，判定失败` };
  }

  // 今日盘中翻转判定（以前日收盘为基准；分时拉不到时保守不判今日翻转）
  if (prevCloseSlope != null && !usePrevCloseFallback) {
    if (prevCloseSlope > 0 && slope <= 0) state.turnedNegToday = true;
    if (prevCloseSlope <= 0 && slope > 0) state.turnedPosToday = true;
  }

  // 辅助：计算"前一交易日"的 dateNum（用 dates 数组严格早于 dateNum 的最后一个）
  let prevDateNum = null;
  for (let i = dates.length - 1; i >= 0; i--) { if (dates[i] < dateNum) { prevDateNum = dates[i]; break; } }

  // isDayAfterTurnNeg：今日是不是"由正转负后第 1 天"
  //   优先 runtimeState.lastNegTurnDate == prevDateNum（盘中实时口径，覆盖"前一天盘中刚转负"场景）
  //   回退 info.daysSinceTurnNeg === 1（precomputed 收盘口径初值）
  if (runtimeState?.lastNegTurnDate != null && prevDateNum != null && runtimeState.lastNegTurnDate === prevDateNum) {
    state.isDayAfterTurnNeg = true;
    state.turnNegDate = runtimeState.lastNegTurnDate;
    state.daysSinceTurnNeg = 1;
  } else if (info?.daysSinceTurnNeg === 1) {
    state.isDayAfterTurnNeg = true;
    state.turnNegDate = info.turnNegDate;
    state.daysSinceTurnNeg = 1;
  }
  // 兜底：不管有没有 isDayAfterTurnNeg，都从 precomputed 拿 turnPosDate/daysSinceTurnPos 和 turnNegDate/daysSinceTurnNeg 初值
  //       保证持续正/持续负斜率场景也能披露"距上次由正转负/由负转正 第 X 天"
  if (state.turnPosDate == null && info?.turnPosDate != null) state.turnPosDate = info.turnPosDate;
  if (state.daysSinceTurnPos == null && info?.daysSinceTurnPos != null) state.daysSinceTurnPos = info.daysSinceTurnPos;
  if (state.turnNegDate == null && info?.turnNegDate != null) state.turnNegDate = info.turnNegDate;
  if (state.daysSinceTurnNeg == null && info?.daysSinceTurnNeg != null) state.daysSinceTurnNeg = info.daysSinceTurnNeg;

  // 【规则③a】最高优先级：今日盘中由正转负 → T 日禁止（不管 slope 后续如何）
  if (state.turnedNegToday) {
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)}（前收盘 ${fmtKeyBlockSlope(prevCloseSlope)} → 当前 ${fmtKeyBlockSlope(slope)}），今日盘中由正转负，禁止出手` };
  }

  // 【规则③b】次高优先级：由正转负后第 1 天（前一天转负、今天 slope < 0 且盘中没转正）
  //   但如果今天盘中已经又转正了（turnedPosToday=true），则③b不适用——下方②/⑤会放行
  if (state.isDayAfterTurnNeg && !state.turnedPosToday && slope < 0) {
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} < 0，但前一交易日（${fmtCybGateDate(String(prevDateNum))}）由正转负，今日为转负后第 1 天且盘中未转正，禁止出手` };
  }

  // slope ≥ 0 的情况：看"由负转正"窗口（规则②）；slope < 0 且不在③a③b → 规则①允许
  if (slope >= 0) {
    let daysSincePos = null, turnPosDate = null;
    if (state.turnedPosToday) { daysSincePos = 0; turnPosDate = dateNum; }
    else if (runtimeState?.lastPosTurnDate != null) {
      turnPosDate = runtimeState.lastPosTurnDate;
      let posIdx = -1, curIdx = -1;
      for (let i = 0; i < dates.length; i++) {
        if (posIdx === -1 && dates[i] === turnPosDate) posIdx = i;
        if (curIdx === -1 && dates[i] === dateNum) curIdx = i;
      }
      if (posIdx >= 0 && curIdx >= 0 && curIdx >= posIdx) daysSincePos = curIdx - posIdx;
    } else if (info?.daysSinceTurnPos != null) {
      daysSincePos = info.daysSinceTurnPos; turnPosDate = info.turnPosDate;
    }
    state.daysSinceTurnPos = daysSincePos; state.turnPosDate = turnPosDate;
    if (daysSincePos != null && daysSincePos <= 1) {
      const d = daysSincePos;
      const tag = d === 0
        ? (state.turnedPosToday ? '由负转正当日（今日盘中判定）' : `由负转正当日（${fmtCybGateDate(String(turnPosDate))} 转正）`)
        : `由负转正后第 ${d} 个交易日（${fmtCybGateDate(String(turnPosDate))} 转正）`;
      return { passed: true, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} ≥ 0，但${tag}，允许出手` };
    }
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} ≥ 0，且距最近一次由负转正${turnPosDate != null ? `（${fmtCybGateDate(String(turnPosDate))}）已 ${daysSincePos} 个交易日（需 ≤ 1）` : '无转正事件'}，禁止出手` };
  }

  // slope < 0 且不在③a③b → 规则① 始终允许
  return { passed: true, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} < 0，负斜率允许出手${state.isDayAfterTurnNeg ? '（由正转负后第 1 天，但今日盘中已转正）' : ''}` };
};

// 跨指数双门禁总判定：同时查创业板指和科创 50
// 返回 { allowedMarkets: Set<'mainboard'|'gem'|'star'>, allBlocked, cybGate, starGate }
// 并把今日盘中翻转事件合并回各自的 runtimeState
const checkDualIndexGates = async (dateStr, minute, cybPrecomputed, starPrecomputed, cybRuntime, starRuntime) => {
  const [cybGate, starGate] = await Promise.all([
    checkIndexGate(CYB_INDEX_CODE, dateStr, minute, cybPrecomputed, cybRuntime),
    checkIndexGate(STAR_INDEX_CODE, dateStr, minute, starPrecomputed, starRuntime),
  ]);
  // 盘中翻转事件合并回各自 runtimeState（lastNegTurnDate 用于明日 T+1 日 isDayAfterTurnNeg 判定；
  // lastPosTurnDate 用于转正窗口判定；两者互相冲突——今日转负清空 lastPos、今日转正清空 lastNeg）
  const merge = (runtime, gate) => {
    if (!runtime) return;
    const dayNum = Number(dateStr);
    if (gate.turnedNegToday) { runtime.lastNegTurnDate = dayNum; runtime.lastPosTurnDate = null; }
    if (gate.turnedPosToday) { runtime.lastPosTurnDate = dayNum; runtime.lastNegTurnDate = null; }
  };
  merge(cybRuntime, cybGate);
  merge(starRuntime, starGate);
  const allowedMarkets = new Set();
  if (cybGate.passed === true) { allowedMarkets.add('mainboard'); allowedMarkets.add('gem'); }
  if (starGate.passed === true) allowedMarkets.add('star');
  return { allowedMarkets, allBlocked: allowedMarkets.size === 0, cybGate, starGate };
};

// 无状态实时门禁查询（供前端 /api/index-slope-gate 实时调用）
// 与 checkDualIndexGates 区别：
//   - 不依赖回测循环的 precomputed Map；内部自己从 ensureIndexMa3SlopeSeries 取历史斜率
//   - 不依赖回测 runtimeState；跨桶/跨日翻转事件只靠收盘口径（历史扫一遍）
//   - 单次调用，返回 { trackedIndex, cybGate, starGate, allowedMarkets, gatePassed }
// 注意：因为是无状态，"由正转负后第 1 天"判定只依赖前一交易日的收盘翻转事件（precomputed 初值），
//       盘中 runtimeState 实时修正只有在回测循环里才生效——前端实时买点诊断场景足够了。
const queryLiveIndexGate = async (stockCode, dateStr, minute) => {
  const trackedIndex = codeToGateIndex(stockCode);
  const cybPrecomputed = await precomputeTurnMap(CYB_INDEX_CODE, [Number(dateStr)]);
  const starPrecomputed = await precomputeTurnMap(STAR_INDEX_CODE, [Number(dateStr)]);
  const { allowedMarkets, allBlocked, cybGate, starGate } = await checkDualIndexGates(
    dateStr, minute, cybPrecomputed, starPrecomputed, null, null
  );
  return { trackedIndex, cybGate, starGate, allowedMarkets, allBlocked, gatePassed: !allBlocked };
};

// 跨指数门禁 buyChecks 明细项（两个指数各一条）
const buildIndexGateChecks = (cybGate, starGate) => {
  const buildOne = (indexCode, gate) => {
    const slopeText = fmtKeyBlockSlope(gate.slope);
    const passed = gate.passed === true;
    // 统一格式化：带天数披露（距上次翻转第 X 天 / 翻转当日）
    const daysLabel = (label, days, turnDate) => {
      const d = Number(days);
      if (!Number.isFinite(d)) return '';
      if (d === 0) return `${label}（${fmtCybGateDate(String(turnDate))}）`;
      return `${label} 第 ${d} 天（${fmtCybGateDate(String(turnDate))} 翻转）`;
    };
    let extra = '';
    if (gate.turnedNegToday) {
      extra = `${daysLabel('今日盘中由正转负', 0, gate.turnNegDate || '')}，禁止出手（T 日）`;
    } else if (gate.isDayAfterTurnNeg && !gate.turnedPosToday && gate.slope < 0) {
      extra = `${daysLabel('由正转负', 1, gate.turnNegDate)}，且今日盘中未转正，禁止出手（T+1 日）`;
    } else if (gate.turnedPosToday && gate.isDayAfterTurnNeg) {
      extra = `${daysLabel('由正转负', 1, gate.turnNegDate)}，但今日盘中又由负转正，允许出手`;
    } else if (gate.slope != null && gate.slope < 0) {
      // 规则① 持续负斜率
      extra = `负斜率允许出手${gate.daysSinceTurnNeg != null ? `；距上次${daysLabel('由正转负', gate.daysSinceTurnNeg, gate.turnNegDate)}` : ''}`;
    } else if (gate.turnedPosToday) {
      extra = `今日盘中由负转正，允许出手`; // 规则②a，天数由 runtime 状态自动置 0
    } else if (gate.daysSinceTurnPos != null && gate.daysSinceTurnPos <= 1) {
      // 规则②b
      const d = gate.daysSinceTurnPos;
      extra = `${daysLabel('由负转正', d, gate.turnPosDate)}，允许出手${d === 1 ? '（T+1 日）' : '（T 日）'}`;
    } else if (gate.daysSinceTurnPos != null) {
      extra = `${daysLabel('由负转正', gate.daysSinceTurnPos, gate.turnPosDate)}，但需 ≤ 1 才允许出手`;
    } else {
      extra = '距最近一次由负转正已超过 1 个交易日';
    }
    return {
      id: indexCode === CYB_INDEX_CODE ? 'cyb_ma3_slope_gate' : 'star_ma3_slope_gate',
      title: `${gateIndexName(indexCode)} 3 日线斜率门禁`,
      passed,
      value: gate.slope == null ? `${gateIndexName(indexCode)} 斜率数据不足` : `${gateIndexName(indexCode)} 3 日线斜率 ${slopeText}°，${extra}`,
      reason: gate.reason,
    };
  };
  return [buildOne(CYB_INDEX_CODE, cybGate), buildOne(STAR_INDEX_CODE, starGate)];
};

// 在选股完成之后，用实际买入的股票代码把 buyChecks 里两条指数门禁再补充一次：
//   - 在跟踪指数那一条的 title 前缀 "{stockName} 跟踪{指数名}"
//   - 在 value 里同样加上"{stockName} 跟踪{指数名}，"前缀
//   - 非跟踪指数的那一条保持原样（前端 tooltip 展示时两条都在，用户能对比）
// stockName 可选，优先展示名称；没有则用 code
const annotateIndexGateChecksWithStock = (buyChecks, stockCode, stockName) => {
  if (!Array.isArray(buyChecks) || !stockCode) return buyChecks;
  const trackedIdx = codeToGateIndex(stockCode);
  const trackedId = trackedIdx === STAR_INDEX_CODE ? 'star_ma3_slope_gate' : 'cyb_ma3_slope_gate';
  const displayName = stockName || String(stockCode);
  return buyChecks.map(c => {
    if (c.id !== trackedId) return c; // 非跟踪指数保持原样
    const idxName = gateIndexName(trackedIdx);
    return {
      ...c,
      title: `${displayName} 跟踪${idxName} 3 日线斜率门禁`,
      value: c.value.replace(`${idxName} 3 日线斜率`, `${displayName} 跟踪${idxName}，3 日线斜率`),
    };
  });
};

// 兼容旧函数名（只查创业板指，向后兼容）
const precomputeCybTurnMap = async (rangeDates) => precomputeTurnMap(CYB_INDEX_CODE, rangeDates);
const checkCybSlopeGate = async (dateStr, minute, precomputed, runtimeState) =>
  checkIndexGate(CYB_INDEX_CODE, dateStr, minute, precomputed, runtimeState);

// 跨指数双门禁 + 选股市场过滤的主入口：
//   返回 { gatePassed: bool, gateAllowedMarkets: Set|null, gatedBuyInfo }
//   gatePassed=false → 两个指数都不让进（allBlocked），调用方应跳过本次买入
//   gatePassed=true 且 gateAllowedMarkets 非空 → 调用方需要在 pickBestStock 前根据 gateAllowedMarkets 过滤候选
//   非适用策略 → gateAllowedMarkets=null 表示不做过滤，保留原有全池选股
const withDualGateInfo = async (buyInfo, strategyId, dateStr, minute, opts) => {
  const { cybPrecomputed, starPrecomputed, cybRuntime, starRuntime } = opts;
  if (!buyInfo) return { gatedBuyInfo: buyInfo, gatePassed: true, gateAllowedMarkets: null };
  if (!CYB_GATE_STRATEGY_IDS.has(strategyId)) {
    return { gatedBuyInfo: buyInfo, gatePassed: true, gateAllowedMarkets: null }; // 非适用策略跳过
  }
  if (!cybPrecomputed || !starPrecomputed) {
    return { gatedBuyInfo: buyInfo, gatePassed: false, gateAllowedMarkets: new Set() }; // 预计算缺失 → 保守拦截
  }
  const { allowedMarkets, allBlocked, cybGate, starGate } = await checkDualIndexGates(
    dateStr, minute, cybPrecomputed, starPrecomputed, cybRuntime, starRuntime
  );
  const checks = buildIndexGateChecks(cybGate, starGate);
  const buyChecks = [...(buyInfo.buyChecks || []), ...checks];
  const marketLabel = allBlocked
    ? '两个指数均未通过，禁止买入'
    : `允许市场: ${[...allowedMarkets].map(m => ({ mainboard: '主板', gem: '创业板', star: '科创板' })[m]).join('/')}`;
  const gateTag = `跨指数双门禁（${marketLabel}）`;
  const buyReason = buyInfo.buyReason ? `${buyInfo.buyReason}；${gateTag}` : gateTag;
  return {
    gatedBuyInfo: { ...buyInfo, buyReason, buyChecks },
    gatePassed: !allBlocked,
    gateAllowedMarkets: allowedMarkets,
    // 关键补充：用于下游 pickBestStock 对个股 MA3 切线正斜率连续天数做过滤
    //   两种场景都触发：① 指数今日由负转正当日；② 指数斜率为负（规则① 持续负斜率窗口）
    //   两种场景的过滤规则相同：个股 MA3 切线正斜率连续天数 > 4 则顺延
    gateTurnedPosInfo: {
      cybTurnedPosToday: !!cybGate?.turnedPosToday,
      starTurnedPosToday: !!starGate?.turnedPosToday,
      cybSlopeNegative: cybGate?.slope != null && cybGate.slope < 0,
      starSlopeNegative: starGate?.slope != null && starGate.slope < 0,
    },
  };
};

// 重点板块仓位权重：进攻（斜率为正、市场情绪好）全仓买入；防御（斜率为负、创业板情绪低迷）半仓买入。
// 防御持仓的个股实际收益率（raw）在汇总口径中按半仓折算：returnRate = rawReturnRate × 0.5，
// 整体收益率与平均/最大回撤均按折算后的收益率计算（2026-10-01 用户要求）
const KEY_BLOCK_POSITION_WEIGHT = { offense: 1, defense: 0.5 };
const KEY_BLOCK_MODE_LABEL = { offense: '进攻·全仓', defense: '防御·半仓' };
// 防御持仓止损线（个股成本线下 -5%，任一卖点先触发即卖出；2026-10-01 用户新增）
const KEY_BLOCK_DEFENSE_STOP_LOSS_PCT = 5;

const runKeyBlockBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.keyBlockDays == null) {
    return { success: false, message: `未知重点板块策略: ${strategyId}` };
  }
  const days = Number(strategy.keyBlockDays);
  // 逆周期情绪游资：与大盘逆周期（斜率由正转负才买、转正即卖），只用 tag 板块、全仓，转负次日 9:40 可补买
  const iceMode = strategy.iceMode === true;
  // 逆周期情绪游资（iceMode）不依赖资金快照，日期序列并入 tech_index 覆盖的交易日（补上缺资金快照的日期，如 20260730），
  // 与三日情绪均值系列口径一致；否则这类日期整日不参与回放，会漏掉当日的斜率翻转/止损等卖点判定
  const allDates = iceMode
    ? Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    : getTrainingCampDates();
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
  // 同时预扫描整个回测窗口可能出现的历史涨停板块防御候选股（创业板下跌日的涨停第一板块），一并预拉 bars
  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });
  try {
    let extraCodes = new Set();
    if (!iceMode) {
      try {
        extraCodes = await scanAllLianbanCodesInRange(rangeDates);
      } catch (e) { /* 历史涨停扫描失败忽略，防御池退化为仅 tag 板块成分股 */ }
    } else {
      // 逆周期情绪游资：预扫描红利板块连板候选股（近20交易日出现三板及以上连板的红利板块个股），一并预拉 bars
      try {
        extraCodes = await scanHongliMultiLianbanCodesInRange(rangeDates);
      } catch (e) { /* 红利连板扫描失败忽略，防御池退化为仅 tag 板块成分股 */ }
    }
    await ensureKeyBlockBars(extraCodes);
    // 随机模拟：预拉随机抽取的真实科技股日K，供 keyBlock 引擎的「N 日涨幅最大」筛选与期末收盘估值现算
    const simPreload = getSimContext();
    if (simPreload && Array.isArray(simPreload.codes) && simPreload.codes.length > 0) {
      try { await ensureBarsForCodes(simPreload.codes); } catch (e) { /* 个别股票拉取失败不影响整体 */ }
    }
  } catch (e) {
    return { success: false, message: `重点板块成分股日K拉取失败: ${e.message || e}` };
  }

  let position = null; // 单股持仓（mode: 'offense' 进攻=自选科技股 / 'defense' 防御=防御+中性 tag 股）
  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }（回测期间出现过的自选股，供复制K线等使用）
  const dailyInfos = new Map(); // date -> Map<code, {changePct, closePx, resilience}>（期末持仓收益率估算用）
  // 预热起始日前 days 个交易日 EOD，日期轴前移，保证起点附近「最近 N 日」窗口不被起始日截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, days, dailyInfos);

  // 斜率符号状态机（2026-10-01 重构：买卖只由斜率正负翻转驱动，不再按斜率正负直接分模式）：
  //   lastSlopeSign/Value：最近一个有效盘中实时斜率的符号与数值，跨日连续追踪；初值取回测首日前一交易日收盘斜率
  //   pendingEntry：空仓时的入场意图（斜率翻转事件/次日9:40复测），在后续桶持续尝试直到建仓或被反向翻转覆盖
  //   offenseBlockDate：进攻持仓卖点诊断卖出且当时斜率仍为正的交易日，当日剩余桶禁止进攻追买（次日9:40复测）
  let lastSlopeSign = null; // null | 1（正）| -1（非正）
  let lastSlopeValue = null;
  let pendingEntry = null; // null | { mode: 'offense'|'defense', trigger, fromValue, toValue }
  let offenseBlockDate = null;
  try {
    // 逆周期情绪游资以「上证指数」3 日线斜率为信号，与创业板口径相反——斜率为正买、为负卖
    const { dates: seedDates, slopes: seedSlopes } = await ensureIndexMa3SlopeSeries(iceMode ? ICE_SIGNAL_INDEX_CODE : 'sz399006');
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
    const { mode, trigger, fromValue, toValue, icePrevCloseSlope } = intent;
    const { dateStr, dateDisplay, dateNum, winDates, bucket, bucketMinute, buyDi } = ctx;
    const isOffense = mode === 'offense';
    const allMembers = [];
    let lianbanAdded = []; // 防御池动态追加的历史涨停候选股（用于日志/文案）
    let lianbanDownDays = [];
    let hongliAdded = []; // 逆周期情绪游资：防御池追加的红利板块连板候选股（用于日志/文案）
    let hongliBoards = []; // 命中的红利板块名
    if (isOffense) {
      for (const m of techPool) allMembers.push(m);
    } else {
      for (const tb of tagBlocks) for (const m of tb.members) allMembers.push(m);
      if (iceMode) {
        // 逆周期情绪游资防御池扩展（2026-10-04 用户口径）：往前 20 个交易日内，
        // 属红利板块名单（hongliName.json）的板块中、出现过连板数 ≥ 3（三板及以上）的个股；
        // 与 tag 板块成分股合并去重后一起做 n 日涨幅最大筛选
        try {
          const hlKey = dateStr; // 同一回测日的 openPosition 可能被多次调用（重试），缓存结果
          if (!openPosition._hongliCache) openPosition._hongliCache = new Map();
          let hlResult;
          if (openPosition._hongliCache.has(hlKey)) {
            hlResult = openPosition._hongliCache.get(hlKey);
          } else {
            hlResult = await getHongliMultiLianbanStocks(dateStr);
            openPosition._hongliCache.set(hlKey, hlResult);
          }
          hongliBoards = hlResult.boards || [];
          const existCodes = new Set(allMembers.map(m => m.code));
          for (const s of hlResult.stocks || []) {
            if (!existCodes.has(s.code)) {
              allMembers.push(s);
              hongliAdded.push(s);
            }
          }
        } catch (e) { /* 红利连板候选获取失败，退化为仅 tag 板块 */ }
      } else {
        // 防御池扩展：往前 20 个交易日中创业板日跌幅 < -1% 的天，取涨停数最多的第一板块的所有股票
        // 与 tag 板块成分股合并去重后一起做 n 日涨幅最大筛选
        try {
          const lbKey = dateStr; // 同一回测日的 openPosition 可能被多次调用（重试），缓存结果
          if (!openPosition._lianbanCache) openPosition._lianbanCache = new Map();
          let lbResult;
          if (openPosition._lianbanCache.has(lbKey)) {
            lbResult = openPosition._lianbanCache.get(lbKey);
          } else {
            lbResult = await getHistoricalLianbanDefenseStocks(dateStr);
            openPosition._lianbanCache.set(lbKey, lbResult);
          }
          lianbanDownDays = lbResult.downDays || [];
          const tagCodes = new Set(allMembers.map(m => m.code));
          for (const s of lbResult.stocks || []) {
            if (!tagCodes.has(s.code)) {
              allMembers.push(s);
              lianbanAdded.push(s);
            }
          }
        } catch (e) { /* 历史涨停候选获取失败，退化为仅 tag 板块 */ }
      }
    }
    // 随机模拟：把随机抽取的真实科技股并入当前候选池一起参与 N 日涨幅最大筛选（进攻/防御池均注入，
    // 检验候选池被大量噪声股票稀释/干扰时的稳定性；这些股票日涨幅/分时均取自真实行情缓存）
    const simCtx = getSimContext();
    if (simCtx && Array.isArray(simCtx.codes) && simCtx.codes.length > 0) {
      const existCodes = new Set(allMembers.map(m => m.code));
      for (const code of simCtx.codes) {
        if (!existCodes.has(code)) allMembers.push({ code, name: (simCtx.nameByCode && simCtx.nameByCode.get(code)) || code });
      }
    }
    if (allMembers.length === 0) return false;
    // 逆周期情绪游资（防御池）抗分歧门槛：买入时点抗分歧指数需 ≥ GLOBAL_RESILIENCE_MIN。
    // 防御股不跟科技绑定的创业板指——主板跟踪上证指数 sh000001（创业板跟创业板指、科创板跟科创50），
    // 按候选实际市场预拉当日指数分时（按「日期+指数」进程内缓存，同日多次重试复用）
    let iceIndexPointsMap = null;
    if (iceMode && !isOffense) {
      const idxCodes = new Set(allMembers.map(m => iceResilienceIndexCode(m.code)));
      if (!openPosition._iceIndexCache) openPosition._iceIndexCache = new Map();
      iceIndexPointsMap = new Map();
      await Promise.all([...idxCodes].map(async (idxCode) => {
        const key = `${dateNum}|${idxCode}`;
        let pts = openPosition._iceIndexCache.get(key);
        if (!pts) {
          try {
            const it = await getSingleStockTlineDataByDate(idxCode, dateNum);
            pts = (it?.line || [])
              .filter(p => p && p.minute != null && p.last_px != null)
              .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
              .filter(p => p.lastPx > 0)
              .sort((a, b) => a.minute - b.minute);
          } catch (e) { pts = []; }
          openPosition._iceIndexCache.set(key, pts);
        }
        iceIndexPointsMap.set(idxCode, pts);
      }));
    }
    // 候选：进攻含自选股添加时间门禁（候选来自当前自选配置，防后加股票污染历史回测）；
    // 涨停判定取该桶时点当日涨幅；买入价从当日分时线现取（minute ≤ 该桶 minute 的最后一点），停牌/无分时个股自动跳过
    const candidateList = await batchParallel(allMembers, async (m) => {
      if (EXCLUDED_CODES.has(m.code)) return null;
      if (isOscExcluded(m.code)) return null; // 震荡测试：勾选隐藏的股票不参与选股
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
        .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
        .filter(p => p.lastPx > 0 && p.minute <= bucketMinute)
        .sort((a, b) => a.minute - b.minute);
      const atBucket = points.length > 0 ? points[points.length - 1] : null;
      if (!atBucket) return null;
      const changePct = preclose && preclose > 0
        ? parseFloat((((atBucket.lastPx - preclose) / preclose) * 100).toFixed(2))
        : null;
      // 逆周期情绪游资：按候选市场跟踪指数现算买入时点抗分歧分数（主板跟踪上证指数，非创业板指）
      let iceResilience = null;
      let iceIndexCode = null;
      if (iceIndexPointsMap) {
        iceIndexCode = iceResilienceIndexCode(m.code);
        const idxPoints = (iceIndexPointsMap.get(iceIndexCode) || []).filter(p => p.minute <= bucketMinute);
        if (points.length >= 5 && idxPoints.length >= 5) {
          const raw = calculateReplayResilience(points, idxPoints, m.code);
          if (raw != null) iceResilience = parseFloat(Number(raw).toFixed(2));
        }
      }
      // 上一交易日一字板过滤（全策略通用，2026-10-05 新增）：昨日一字板（开盘/收盘/最低涨幅均达阈值，
      // 主板 9.5%、创业/科创 19.5%）的候选次日不买；数据不足（null）不拦截
      let prevOneWord = null;
      try {
        prevOneWord = isPrevDayOneWordBoard(m.code, await getKlineCached(m.code, dateStr), dateStr);
      } catch (e) { prevOneWord = null; }
      return { code: m.code, name: m.name || m.code, gain, lastPx: atBucket.lastPx, changePct, limitUp: isLimitUpAtBuy(m.code, changePct), prevOneWord: prevOneWord === true, iceResilience, iceIndexCode };
    }, 8);
    const candidates = candidateList.filter(Boolean);
    candidates.sort((a, b) => b.gain - a.gain); // 并列涨幅保持配置顺序（batchParallel 保序）
    // 逆周期情绪游资：叠加抗分歧门槛（≥ GLOBAL_RESILIENCE_MIN）——不满足的按涨幅排名顺延至下一只，
    // 全部候选（涨停或抗分歧不足）均不可买时本桶不买、后续桶继续重试
    const iceResilienceSkipped = [];
    const best = candidates.find(c => {
      if (c.limitUp) return false;
      // 上一交易日一字板过滤（全策略通用）：昨日一字板的候选次日不买，顺延至排名下一只
      if (c.prevOneWord) return false;
      if (iceMode && c.iceResilience != null && c.iceResilience < GLOBAL_RESILIENCE_MIN) {
        iceResilienceSkipped.push(c);
        return false;
      }
      return true;
    }) || null;
    if (!best) return false; // 全部候选涨停/无有效候选：调用方在后续桶继续重试

    if (!seenStocks.has(best.code)) seenStocks.set(best.code, { code: best.code, name: best.name });
    const blocksText = tagBlocks.map(tb => `${tb.blockName}[${tb.tag}]`).join('、');
    const slopeText = `${toValue > 0 ? '+' : ''}${Number(toValue).toFixed(2)}`;
    const fromText = fromValue == null ? '无（首值）' : `${fromValue > 0 ? '+' : ''}${Number(fromValue).toFixed(2)}`;
    const triggerTimeText = fmtTime(bucket.timeKey);
    const gateReasonMap = {
      slope_turn_positive: `创业板指 3 日线斜率在 ${triggerTimeText} 由负转正（${fromText} → ${slopeText}）：进攻买点触发，不看资金/量能/情绪等任何配合条件，买入自选科技股中 ${days} 日涨幅最大的一只`,
      slope_turn_negative: `创业板指 3 日线斜率在 ${triggerTimeText} 由正转负（${fromText} → ${slopeText}）且当前空仓：防御买点触发，买入防御+中性 tag 板块 ∪ 近20交易日创业板下跌日的涨停前3板块 ∩ 20日有≥3连板个股中 ${days} 日涨幅最大的一只`,
      ice_slope_turn_positive: `上证指数 3 日线斜率由负转正（${fromText} → ${slopeText}）且当前空仓、前一交易日收盘口径斜率为负：逆周期情绪游资买点触发，在 ${triggerTimeText} 执行买入（转正当日起至少等 9:40，给抗分歧分数留出分时计算窗口），买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中 ${days} 日涨幅最大的一只`,
      retry_next_day_940: `进攻持仓按卖点诊断卖出后，卖出当时 3 日线斜率仍为正（${fromText}），当日不继续买；次日开盘 10 分钟后（${triggerTimeText}，9:40 桶）复测斜率仍为正（${slopeText}），继续买入自选科技股中 ${days} 日涨幅最大的一只`,
      ice_next_day_940: `前一交易日上证指数 3 日线斜率由负转正，今日开盘 10 分钟后（${triggerTimeText}，9:40 桶）仍空仓补买：逆周期情绪游资买点触发，买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中 ${days} 日涨幅最大的一只`,
    };
    const modeGateCheck = {
      id: 'key_block_cyb_gate',
      title: iceMode
        ? (trigger === 'ice_next_day_940'
          ? '转正次日 9:40 空仓补买（逆周期情绪游资买点）'
          : '上证指数3日线斜率由负转正且空仓（逆周期情绪游资买点，9:40 及以后执行）')
        : (trigger === 'retry_next_day_940'
          ? '次日开盘10分钟后斜率复测（进攻买点）'
          : `创业板指3日线斜率${isOffense ? '由负转正（进攻买点）' : '由正转负且空仓（防御买点）'}`),
      passed: true,
      value: iceMode
        ? `${triggerTimeText} ${slopeText}（前一日收盘 ${fmtKeyBlockSlope(icePrevCloseSlope)}）`
        : `${triggerTimeText} ${slopeText}`,
      reason: gateReasonMap[trigger] || gateReasonMap.slope_turn_positive,
    };
    const poolCheck = isOffense ? {
      id: 'key_block_watchlist_tech',
      title: '自选科技股筛选（进攻）',
      passed: true,
      value: `${techPool.length} 只`,
      reason: `进攻候选 = 自选股（monitor_stocks.json）中 isTech ≠ false 的科技股共 ${techPool.length} 只（剔除排除股；含自选股添加时间门禁）`,
    } : (() => {
      const tagCount = tagBlocks.reduce((s, tb) => s + tb.members.length, 0);
      if (iceMode) {
        const hongliInfo = hongliAdded.length > 0
          ? `；红利板块连板扩展 = 往前20交易日出现三板及以上连板的红利板块（${hongliBoards.join('、') || '无'}）个股，与Tag板块去重后新增 ${hongliAdded.length} 只`
          : `；红利板块连板扩展 = 往前20交易日无符合条件（三板及以上）的红利板块个股（或均已在 tag 板块）`;
        return {
          id: 'key_block_tag_blocks',
          title: '逆周期情绪游资候选池（防御+中性 Tag板块 ∪ 红利板块三板及以上·全仓）',
          passed: true,
          value: `${tagBlocks.length} 个Tag板块 ${tagCount} 只 + 红利板块 ${hongliAdded.length} 只`,
          reason: `参与选股的防御+中性 tag 板块 ${tagBlocks.length} 个：${blocksText}${hongliInfo}；合并去重后共 ${allMembers.length} 只候选`,
        };
      }
      const lbInfo = lianbanAdded.length > 0
        ? `；历史涨停扩展 = 往前20交易日中创业板日跌幅<-1%的 ${lianbanDownDays.length} 天涨停前3板块 ∩ 20日有≥3连板个股，与Tag板块去重后新增 ${lianbanAdded.length} 只（下跌日：${lianbanDownDays.join('、') || '无'}）`
        : `；历史涨停扩展 = 往前20交易日中创业板日跌幅<-1%的天数 = ${lianbanDownDays.length}，均已在 tag 板块或无数据，无新增`;
      return {
        id: 'key_block_tag_blocks',
        title: '防御候选池（Tag板块 + 历史涨停扩展）',
        passed: true,
        value: `${tagBlocks.length} 个Tag板块 ${tagCount} 只 + 涨停扩展 ${lianbanAdded.length} 只`,
        reason: `参与选股的防御+中性 tag 板块 ${tagBlocks.length} 个：${blocksText}${lbInfo}；合并去重后共 ${allMembers.length} 只候选`,
      };
    })();
    const limitUpSkipped = candidates.filter(c => c.limitUp && c.gain > best.gain);
    // 上一交易日一字板过滤明细（全策略通用，2026-10-05 新增）：记录排名高于最终买入的一字板候选
    const oneWordSkipped = candidates.filter(c => c.prevOneWord && c.gain > best.gain);
    const oneWordBoardCheck = {
      id: 'one_word_board_defer',
      title: '上一交易日一字板过滤（主板≥8%、创业/科创≥16%）',
      passed: true,
      value: oneWordSkipped.length > 0 ? `顺延 ${oneWordSkipped.length} 只` : '无一字板候选',
      skippedStocks: oneWordSkipped.map(c => ({ code: c.code, name: c.name })),
      reason: oneWordSkipped.length > 0
        ? `上一交易日一字板候选已剔除并顺延：${oneWordSkipped.map(c => (c.changePct != null ? `${c.name} +${c.changePct}%` : c.name)).join('、')}；${days} 日涨幅排名后延至 ${best.name}（昨日开盘/收盘/最低涨幅均达涨停阈值，全天封死一字板，次日不买）`
        : `买入时点候选中无上一交易日一字板股（主板开盘/收盘/最低涨幅均≥8%、创业/科创均≥16% 视为一字板；一字板次日不买，顺延排名下一只）`,
    };
    const limitUpCheck = {
      id: 'key_block_limit_up',
      title: '涨停过滤（主板>9.5%、创业/科创>19%）',
      passed: true,
      value: limitUpSkipped.length > 0 ? `顺延 ${limitUpSkipped.length} 只` : '无涨停候选',
      reason: limitUpSkipped.length > 0
        ? `买入时点（${triggerTimeText}）涨停候选已剔除并顺延：${limitUpSkipped.map(c => (c.changePct != null ? `${c.name} +${c.changePct}%` : c.name)).join('、')}；${days} 日涨幅排名后延至 ${best.name}`
        : `买入时点候选中无涨停股（主板涨幅 >9.5%、创业板/科创板 >19% 视为涨停；涨停股不可买，顺延排名下一只）`,
    };
    // 逆周期情绪游资专属：抗分歧 ≥ 9 门槛（主板跟踪上证指数 sh000001，非创业板指）
    const iceResilienceCheck = iceMode ? {
      id: 'ice_resilience_gate',
      title: `抗分歧门槛（买入时点 ≥ ${GLOBAL_RESILIENCE_MIN}，主板跟踪上证指数）`,
      passed: true,
      value: `${best.iceResilience != null ? Number(best.iceResilience).toFixed(2) : '数据不足'}（${iceIndexName(best.iceIndexCode)}）`,
      reason: `买入时点抗分歧指数需 ≥ ${GLOBAL_RESILIENCE_MIN}：${best.name}(${best.code}) 跟踪${iceIndexName(best.iceIndexCode)}，抗分歧 ${best.iceResilience != null ? Number(best.iceResilience).toFixed(2) : '数据不足（放行）'}${iceResilienceSkipped.length > 0 ? `；前序已顺延抗分歧不足的 ${iceResilienceSkipped.length} 只（${iceResilienceSkipped.map(c => `${c.name} ${Number(c.iceResilience).toFixed(2)}`).join('、')}）` : ''}（防御股不跟科技绑定的创业板指：主板跟踪上证指数 sh000001，创业板跟 sz399006，科创板跟 sh000688）`,
    } : null;
    const bestCheck = {
      id: 'key_block_best_stock',
      title: `${isOffense ? '自选科技股' : (iceMode ? '防御+中性 Tag板块∪红利连板' : '防御候选池(Tag板块+涨停扩展)')}内最近${days}日涨幅最大的股票`,
      passed: true,
      value: `${best.gain > 0 ? '+' : ''}${best.gain.toFixed(2)}%`,
      reason: `在${isOffense ? `自选科技股池共 ${allMembers.length} 只` : (iceMode ? `防御+中性 tag 板块 ∪ 红利板块三板及以上候选股共 ${allMembers.length} 只（其中红利板块扩展 ${hongliAdded.length} 只）` : `防御候选池共 ${allMembers.length} 只（Tag板块 + 历史涨停扩展 ${lianbanAdded.length} 只）`)}中（有效候选 ${candidates.length} 只），按最近 ${days} 日个股涨幅之和取最大${limitUpSkipped.length > 0 ? '（涨停股顺延后）' : ''}${iceResilienceSkipped.length > 0 ? `（抗分歧不足顺延 ${iceResilienceSkipped.length} 只后）` : ''}；买入价取 ${triggerTimeText} 分时价`,
    };
    const buyReasonMap = {
      slope_turn_positive: `${triggerTimeText.substring(0, 5)}创业板指3日线斜率由负转正（${fromText}→${slopeText}），买入自选科技股池内${days}日涨幅最大的股票（进攻买点，无需资金/量能配合）`,
      slope_turn_negative: `${triggerTimeText.substring(0, 5)}创业板指3日线斜率由正转负（${fromText}→${slopeText}）且空仓，买入防御候选池（Tag板块 + 近20交易日创业板下跌日涨停前3板块 ∩ 20日有≥3连板个股）内${days}日涨幅最大的股票（防御买点）`,
      ice_slope_turn_positive: `${triggerTimeText.substring(0, 5)}上证指数3日线斜率由负转正（${fromText}→${slopeText}）且空仓、前一交易日收盘口径斜率为负，买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${days}日涨幅最大的股票（逆周期情绪游资买点，9:40 及以后执行）`,
      retry_next_day_940: `${triggerTimeText.substring(0, 5)}开盘10分钟后复测创业板指3日线斜率仍为正（${slopeText}，卖出当时${fromText}），买入自选科技股池内${days}日涨幅最大的股票（卖点诊断卖出后次日复测继续买）`,
      ice_next_day_940: `${triggerTimeText.substring(0, 5)}前一交易日上证指数3日线斜率由负转正，今日开盘10分钟后（9:40 桶）仍空仓补买（上证指数3日线斜率 ${slopeText}），买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${days}日涨幅最大的股票（逆周期情绪游资次日9:40补买）`,
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
      buyChecks: [modeGateCheck, poolCheck, limitUpCheck, oneWordBoardCheck, ...(iceResilienceCheck ? [iceResilienceCheck] : []), bestCheck],
    };
    return true;
  };

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      // 所有策略统一允许缺失资金快照的日期用兜底（.nomfund）回放数据构建（此前仅 ice/emoAvg 开放）：
      // 这类日期（如 20260730 快照缺失）整日跳过会导致当日止损/斜率翻转等卖点判定全部漏执行，
      // 前一日买入的持仓被迫等到下一个有快照的交易日才能卖出；兜底构建仅缺 fundFlow/成交量字段，
      // 卖出所需分时/情绪数据齐全，买入的量能条件在无成交量数据时自然判不通过（当日不新买入）
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
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
    await injectSimStocksIntoCampData(campData, dateStr); // 随机模拟：把合成股票混入当日候选池（重点板块/情绪游资系列）
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 当日隔夜持仓卖出数据预建（当日买入次日才可卖，同日买入不可同日卖出）：
    //   进攻持仓 → 通用 7 条件卖点诊断所需的日收盘斜率门禁（「科技板块情绪退潮」条件）+ 非自选股合成逐桶数据
    // 防御持仓 → 持仓股当日分时（卖点：斜率翻转当桶 ∪ 个股分时价跌破成本线止损 -5%/-2% ∪ 情绪游资 14:55 长下影强卖）
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

    const diA = di + axisOffset;
    const winDates = diA + 1 >= days ? dateAxis.slice(diA + 1 - days, diA + 1) : [];
    const dateNum = parseInt(dateStr, 10);
    // 逆周期情绪游资：前一交易日「收盘口径」上证指数 3 日线斜率。
    // 出手门禁要求「前一日收盘斜率为负、今日盘中才转正」才算一次有效买点（前一日已为正则今日盘中 −→+ 不计）
    const icePrevCloseSlope = iceMode && diA - 1 >= 0 ? await getIceMa3Slope(dateAxis[diA - 1]) : null;

    // 逐桶状态机（2026-10-01 重构）：
    //   ① 盘中实时斜率（null 桶不参与翻转识别，符号基准跨缺失桶连续）→ 识别由负转正/由正转负
    //   ② 卖出：防御持仓遇斜率翻转或「个股跌破成本线止损（重点板块 -5% / 情绪游资 -2%）」即按分时价卖出；进攻持仓走通用 7 条件卖点诊断，
    //          卖出后斜率仍为正则当日不再追买（offenseBlockDate），挂次日 9:40 复测意图
    //   ③ 空仓时翻转事件生成入场意图：由正转负→防御（独立规则，即使刚卖出也生效）；
    //          由负转正→进攻（进攻卖出当日除外）；同桶允许先卖后买转手
    //   ④ 按意图建仓：9:40 复测意图仅在 ≥9:40 且斜率仍为正的桶执行；候选全部不可买时后续桶持续重试
    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      // 逆周期情绪游资改用上证指数 3 日线斜率（方向相反：为正买、为负卖）
      const slopeNow = iceMode
        ? await getIceMa3SlopeIntraday(dateStr, bucketMinute)
        : await getKeyBlockCybMa3SlopeIntraday(dateStr, bucketMinute);
      const signNow = slopeNow == null ? null : (slopeNow > 0 ? 1 : -1);
      const turnedPositive = lastSlopeSign !== null && signNow === 1 && lastSlopeSign === -1;
      const turnedNegative = lastSlopeSign !== null && signNow === -1 && lastSlopeSign === 1;

      // ===== ② 卖出（仅隔夜持仓） =====
      if (position && dateStr > position.buyDate) {
        if (position.mode === 'defense' && defensePoints && defensePoints.length > 0) {
          // 防御卖点：① 斜率翻转的当桶 ② 个股分时价跌破成本线止损 ③（情绪游资）14:55 长下影强卖
          //   重点板块防御持仓 → -5%（KEY_BLOCK_DEFENSE_STOP_LOSS_PCT）；逆周期情绪游资 → -2%（策略 costLinePct）
          // 任一先触发即卖出；止损在每个桶都会检查（因为不依赖斜率翻转事件）
          // 竞价低开自救窗口（2026-10-05 新增；2026-10-08 修订，仅作用于成本线止损）：当日竞价开盘价（首分钟价）已跌破
          //   成本线止损线时，不在 9:30 直接止损——大低开往往开盘先直线拉升（资金自救），逐分钟跟踪：
          //   拉升过程中（尚未出现「某分钟价低于上一分钟」的回落）继续持有（即使仍在成本线下方）；
          //   若拉升回补至阈值上方则视为自救成功、不再止损，待后续再次跌破阈值时再卖；
          //   只有当「拉升结束、开始回落」且该回落分钟价仍跌破阈值时，才卖出（成交价/时间取该回落点，精确到分钟）。
          //   若开盘未破线、盘中才跌破 → 即时止损（桶级触发后逐分钟回溯定位首次跌破分钟，按该分钟分时价成交）。
          const stopLossPct = iceMode
            ? (position.costLinePct != null ? Number(position.costLinePct) : 2)
            : KEY_BLOCK_DEFENSE_STOP_LOSS_PCT;
          let atPt = null;
          let atPtIdx = -1;
          for (let pi = 0; pi < defensePoints.length; pi++) {
            if (defensePoints[pi].minute <= bucketMinute) { atPt = defensePoints[pi]; atPtIdx = pi; } else break;
          }
          if (atPt) {
            const rawReturnRate = position.buyPrice > 0
              ? parseFloat((((atPt.lastPx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
              : null;
            const defenseCostLineThreshold = position.buyPrice > 0 ? position.buyPrice * (1 - stopLossPct / 100) : null;
            const defenseOpenPx = defensePoints[0].lastPx;
            const openBrokeCostLine = defenseCostLineThreshold != null && defenseOpenPx != null && defenseOpenPx > 0 && defenseOpenPx < defenseCostLineThreshold;
            // 自救窗口观察：在 minute ≤ 当前桶的分时点中找首个「分钟价低于上一分钟、且该分钟价仍跌破阈值」的回落点
            //（拉升已回补至阈值上方的回落不计入；待再次跌破阈值并回落才触发）
            let openBreakFirstDecline = null;
            let openBreakFirstDeclinePrev = null;
            if (openBrokeCostLine) {
              for (let pi = 1; pi < defensePoints.length; pi++) {
                if (defensePoints[pi].minute > bucketMinute) break;
                if (defensePoints[pi].lastPx < defensePoints[pi - 1].lastPx && defensePoints[pi].lastPx < defenseCostLineThreshold) {
                  openBreakFirstDecline = defensePoints[pi];
                  openBreakFirstDeclinePrev = defensePoints[pi - 1];
                  break;
                }
              }
            }
            const fmtMinuteD = (m) => `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`;
            // 开盘已破线 → 成本线止损被自救窗口规则取代（回补至阈值上方则不再止损；回落且仍跌破阈值才卖）；开盘未破线 → 原即时止损
            const stopLossHit = !openBrokeCostLine && rawReturnRate != null && rawReturnRate <= -stopLossPct;
            const openBreakSellHit = openBrokeCostLine && openBreakFirstDecline != null;
            // 精确分钟回溯（2026-10-05 新增）：桶级触发成本线卖出后，逐分钟回溯定位真实触发分钟并按该分钟分时价成交
            //（线上环境在触发当分钟即已卖出，桶级成交最多晚 4 分钟，回溯后回测更贴近实盘）：
            //   - 盘中破线止损：从桶前一分钟向回逐分钟检查是否仍跌破阈值（口径与触发一致：较买入价跌幅 ≤ -stopLossPct%），
            //     直到首次不跌破（或回溯至 9:30 开盘）为止，取连续跌破区间最早一分钟为成交分钟；
            //     破线就发生在当前桶（前一分钟未跌破）→ 维持按桶价成交；
            //   - 开盘破线（自救窗口）：成交价/时间由桶改为「回落且仍跌破阈值」的回落点（与线上在回落当分钟立即卖出一致）；
            //     斜率翻转 / 14:55 长下影卖点不回溯，仍按当桶分时价成交。
            let preciseSellPt = null;
            if (stopLossHit) {
              for (let pw = atPtIdx - 1; pw >= 0; pw--) {
                const px = defensePoints[pw].lastPx;
                if (!(position.buyPrice > 0) || !(((px - position.buyPrice) / position.buyPrice) * 100 <= -stopLossPct)) break;
                preciseSellPt = defensePoints[pw];
              }
            } else if (openBreakSellHit) {
              preciseSellPt = openBreakFirstDecline;
            }
            const sellPtFinal = preciseSellPt || atPt;
            // 逆周期情绪游资卖点为「上证 3 日线斜率由正转负」，与创业板口径（由负转正）方向相反
            const slopeSellHit = iceMode ? turnedNegative : turnedPositive;
            // 情绪游资新增卖点（2026-10-04 用户新增）：当日 14:55 检查 K 线形态——
            // 下影线 ≥ 实体长度的 2 倍（长下影＝盘中被砸后拉起、上方承压）→ 14:55 强制卖出。
            // 仅用 minute ≤ 1455 的当日分时点现算（无未来数据）：开=首个分时价，收=14:55 价，低=区间 min。
            let shadowSellHit = false;
            let shadowInfo = null;
            if (iceMode && bucketMinute === 1455) {
              const pts = defensePoints.filter(p => p.minute <= 1455 && p.lastPx > 0);
              if (pts.length > 0) {
                const openPx = pts[0].lastPx;
                const closePx = pts[pts.length - 1].lastPx;
                const lowPx = pts.reduce((mn, p) => Math.min(mn, p.lastPx), Infinity);
                const body = Math.abs(closePx - openPx);
                const lowerShadow = Math.min(openPx, closePx) - lowPx;
                if (lowerShadow > 0 && lowerShadow >= 2 * body) {
                  shadowSellHit = true;
                  shadowInfo = {
                    openPx: parseFloat(openPx.toFixed(2)),
                    closePx: parseFloat(closePx.toFixed(2)),
                    body: parseFloat(body.toFixed(2)),
                    lowerShadow: parseFloat(lowerShadow.toFixed(2)),
                  };
                }
              }
            }
            if (slopeSellHit || stopLossHit || shadowSellHit || openBreakSellHit) {
              const finalRawReturnRate = position.buyPrice > 0
                ? parseFloat((((sellPtFinal.lastPx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
                : rawReturnRate;
              const sellChange = defensePreclose && defensePreclose > 0
                ? parseFloat((((sellPtFinal.lastPx - defensePreclose) / defensePreclose) * 100).toFixed(2))
                : null;
              // 防御半仓折算：个股实际收益 × 0.5 才是对全仓账户的收益贡献（回撤/整体收益均按折算口径）
              // 逆周期情绪游资（iceMode）为全仓买入，不做折算
              const weight = iceMode ? 1 : KEY_BLOCK_POSITION_WEIGHT.defense;
              const returnRate = finalRawReturnRate != null ? parseFloat((finalRawReturnRate * weight).toFixed(2)) : null;
              const slopeTurnText = iceMode
                ? `${ICE_SIGNAL_INDEX_NAME}3日线斜率盘中由正转负（${fmtKeyBlockSlope(lastSlopeValue)} → ${fmtKeyBlockSlope(slopeNow)}）`
                : `创业板指3日线斜率盘中由负转正（${fmtKeyBlockSlope(lastSlopeValue)} → ${fmtKeyBlockSlope(slopeNow)}）`;
              const sellTrigger = slopeSellHit
                ? slopeTurnText
                : shadowSellHit
                  ? `当日 14:55 下影线 ${shadowInfo.lowerShadow.toFixed(2)} ≥ 实体长度 ${shadowInfo.body.toFixed(2)} 的 2 倍（开 ${shadowInfo.openPx.toFixed(2)} → 14:55 价 ${shadowInfo.closePx.toFixed(2)}），K 线形态走坏强制卖出`
                  : openBreakSellHit
                    ? `竞价开盘 ${defenseOpenPx.toFixed(2)} 已跌破成本线 -${stopLossPct}%（阈值 ${defenseCostLineThreshold.toFixed(2)}），不在 9:30 直接止损、等待开盘自救拉升；${fmtMinuteD(openBreakFirstDecline.minute)} 价 ${openBreakFirstDecline.lastPx.toFixed(2)} 低于 ${fmtMinuteD(openBreakFirstDeclinePrev.minute)} 价 ${openBreakFirstDeclinePrev.lastPx.toFixed(2)} 且仍跌破阈值，自救拉升结束回落即卖出，按回落分钟 ${fmtMinuteD(sellPtFinal.minute)} 价格 ${parseFloat(Number(sellPtFinal.lastPx).toFixed(2))} 成交（较成本 ${finalRawReturnRate}%，桶级触发于 ${fmtMinuteD(atPt.minute)}）`
                    : (preciseSellPt != null
                      ? `持仓个股分时价跌破成本线 -${stopLossPct}% 止损（成本 ${position.buyPrice.toFixed(2)}，桶级触发现价 ${parseFloat(Number(atPt.lastPx).toFixed(2))}）；逐分钟回溯：实际于 ${fmtMinuteD(preciseSellPt.minute)} 首次跌破（价 ${parseFloat(Number(preciseSellPt.lastPx).toFixed(2))}，较成本 ${finalRawReturnRate}%），按该分钟价格成交`
                      : `持仓个股分时价跌破成本线 -${stopLossPct}% 止损（成本 ${position.buyPrice.toFixed(2)} → 现价 ${parseFloat(Number(atPt.lastPx).toFixed(2))}，浮亏 ${finalRawReturnRate}%；破线发生在当前桶，按桶价成交）`);
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
                sellTime: `${String(Math.floor(sellPtFinal.minute / 100)).padStart(2, '0')}:${String(sellPtFinal.minute % 100).padStart(2, '0')}`,
                sellPrice: parseFloat(Number(sellPtFinal.lastPx).toFixed(2)),
                sellChange,
                sellReason: iceMode
                  ? `${sellTrigger}，逆周期情绪游资持仓卖出（全仓买入）`
                  : `${sellTrigger}，防御半仓持仓卖出（防御为半仓买入，收益率按半仓折算）`,
                returnRate,
                rawReturnRate: finalRawReturnRate,
              });
              position = null;
            }
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
        if (iceMode) {
          // 逆周期情绪游资：上证 3 日线斜率「由负转正」为买点（方向与创业板口径相反）：
          //   ① 仅当「前一交易日收盘口径斜率为负」时，今日盘中由负转正才算一次出手机会；
          //      前一日收盘已为正时，今日盘中的 −→+ 不算买点（不生成/不覆盖意图，继续空仓等待）
          //   ② 斜率「由正转负」是卖点信号，同时作废尚未成交的买点意图
          // armDate/armDi 记录转正发生日：仅在转正当日与次日 9:40 补买
          if (turnedPositive) {
            if (icePrevCloseSlope != null && icePrevCloseSlope < 0) {
              pendingEntry = { mode: 'defense', trigger: 'ice_slope_turn_positive', armDate: dateStr, armDi: di, fromValue: lastSlopeValue, toValue: slopeNow, icePrevCloseSlope };
            }
          } else if (turnedNegative) {
            pendingEntry = null;
          }
        } else if (turnedNegative) {
          // 防御买点：斜率变成负数且当前空仓（独立于进攻卖出的不追买限制）
          pendingEntry = { mode: 'defense', trigger: 'slope_turn_negative', armDate: dateStr, armDi: di, fromValue: lastSlopeValue, toValue: slopeNow };
        } else if (turnedPositive && offenseBlockDate !== dateStr) {
          // 进攻买点：斜率转为正数（防御持仓当桶卖出后的转手买入同样走这里；进攻卖出当日禁止追买）
          pendingEntry = { mode: 'offense', trigger: 'slope_turn_positive', fromValue: lastSlopeValue, toValue: slopeNow };
        }
      }
      // 逆周期情绪游资：补买窗口仅限转正当日与次日 9:40，超过次日的未成交意图作废
      if (iceMode && pendingEntry && pendingEntry.trigger === 'ice_slope_turn_positive'
        && pendingEntry.armDi != null && di > pendingEntry.armDi + 1) {
        pendingEntry = null;
      }

      // ===== ④ 按意图建仓（同桶先卖后买；候选全部涨停/无效时后续桶继续重试） =====
      if (!position && winDates.length === days && pendingEntry) {
        // 逆周期情绪游资：转正当日在转正桶之后持续重试；转正次日起仅在 9:40 及以后的桶补买
        const iceNextDay = iceMode && pendingEntry.trigger === 'ice_slope_turn_positive'
          && pendingEntry.armDi != null && di > pendingEntry.armDi;
        let canAttempt = true;
        if (pendingEntry.trigger === 'retry_next_day_940') {
          // 仅在卖出的次一交易日生效：9:40 前不买；斜率数据不足等后续桶；复测斜率 ≤ 0 本桶不买
          // （当日由正转负时③已把意图切为防御；卖出当日一律不执行，落实「当日不要继续买」）
          if (dateStr <= pendingEntry.armDate || bucketMinute < 940 || slopeNow == null || slopeNow <= 0) canAttempt = false;
        } else if (iceMode && pendingEntry.trigger === 'ice_slope_turn_positive' && bucketMinute < 940) {
          // 逆周期情绪游资：无论转正当日还是次日，都要等到 9:40 及以后才买——给抗分歧分数留出盘中分时窗口
          // （9:40 时股价与跟踪指数各约 11 个分时点，满足抗分歧函数 ≥5 点的计算要求，避免 9:30 桶「数据不足」放行）
          canAttempt = false;
        }
        if (canAttempt) {
          // 复测/补买：明细中的斜率取执行桶当时值（fromValue 仍为翻转当时值）
          const intent = pendingEntry.trigger === 'retry_next_day_940'
            ? { ...pendingEntry, toValue: slopeNow }
            : (iceNextDay ? { ...pendingEntry, trigger: 'ice_next_day_940', toValue: slopeNow } : pendingEntry);
          const opened = await openPosition(intent, { dateStr, dateDisplay, dateNum, winDates, bucket, bucketMinute });
          if (opened) {
            pendingEntry = null;
          }
        }
      }

      // 更新斜率符号基准（null 桶不更新，翻转识别跨缺失桶连续）
      if (signNow !== null) {
        lastSlopeSign = signNow;
        lastSlopeValue = slopeNow;
      }
    }
  }

  // 组装结果（type:'single'：整体收益率 = 已卖出收益 + 期末持仓按最近收盘价估算的浮动收益）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn += t.returnRate;
  }
  let holding = null;
  if (position) {
    holding = { ...position };
    holding.weight = (iceMode && position.mode === 'defense') ? 1 : (KEY_BLOCK_POSITION_WEIGHT[position.mode] ?? 1);
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
// ===== 两次买入策略（highest_{N}d_gain_two_buy）公共逻辑 =====
// 重构版（2026-10-08 用户要求）：两份仓位各自独立买卖、独立计算收益，均按半仓权重 0.5 折算，互不摊平成本。
// 每份仓位就是一笔普通的「N日涨幅最大&快进快出」持仓——以自身买入价为成本（跌破成本线 -2% 止损），
// 各自走 emoquick/通用卖点、产生独立交易记录。
// 建仓约束：第一份按买点正常择股买入；第二份必须在第一份建仓之后的交易日（≥ 隔 1 天）触发买点时买入，
// 且必须是同一只股票（不重新择股）。
const TWO_BUY_LEG_WEIGHT = 0.5;

// 两次买入「不同板块」策略：取个股所属板块标识（自选股 monitor_stocks.json 的 blockName），
// 未记录板块的股票统一按「其他」处理；按文件 mtime 懒加载映射并缓存，避免逐候选重复读盘
const stockBlockFilePath = path.join(__dirname, '../data/monitor_stocks.json');
let stockBlockCache = { mtimeMs: -1, map: new Map() };
const getStockBlockName = (code) => {
  try {
    const mtimeMs = fs.statSync(stockBlockFilePath).mtimeMs;
    if (mtimeMs !== stockBlockCache.mtimeMs) {
      const map = new Map();
      for (const s of getMonitorStocks() || []) {
        if (s && s.code) map.set(s.code, s.blockName || '其他');
      }
      stockBlockCache = { mtimeMs, map };
    }
  } catch (e) {
    // 读取失败：沿用上次映射（无映射时全部按「其他」）
  }
  return stockBlockCache.map.get(code) || '其他';
};

// 组装两次买入某一份仓位在成交流水上追加的字段（半仓权重、个股原始收益率、所属份数 1/2）
const buildTwoBuyTradeExtra = (position) => ({
  twoBuy: true,
  leg: position?.leg ?? null,
  weight: TWO_BUY_LEG_WEIGHT,
  rawReturnRate: position?.rawReturnRate ?? null,
  avgPrice: position?.buyPrice ?? null,
  buyPrices: position?.buyPrice != null ? [position.buyPrice] : [],
  buyTimes: position?.buyTime != null ? [position.buyTime] : [],
  buyDates: position?.buyDate != null ? [position.buyDate] : [],
});

// 两次买入策略「整体收益率」按真实账户口径计算（2026-10-08 用户要求）：
// 资金从 1 起步，每轮买入半仓（第一份）+ 半仓（第二份）= 满仓；两份是「同时持有」的
// （第二份在第一份卖出前买入），故同一轮内两份的半仓收益应【相加】（合计占满仓，不产生复利放大），
// 只有【轮次之间】才复利——上一轮已实现收益成为下一轮的本金基数。
// 算法：把每一份仓位视为一段 [买入时刻, 卖出时刻] 区间（期末持仓以区间终点为卖出时刻），
// 按买入时刻排序后做区间合并：时间上重叠（含传递重叠）的份数归入同一轮，轮内收益相加、跨轮相乘。
// legs: [{ buyDate, buyTime, sellDate?, sellTime?, returnRate }]，returnRate 已按半仓折算（百分数）
const computeTwoBuyAccountReturn = (legs) => {
  const items = [];
  for (const l of legs) {
    if (!l) continue;
    const rate = l.returnRate != null && Number.isFinite(Number(l.returnRate)) ? Number(l.returnRate) : null;
    if (rate == null) continue;
    items.push({
      start: `${l.buyDate || ''}${l.buyTime || ''}`,
      // 期末持仓无卖出时刻：视为持有到回测结束（区间终点取最大）
      end: l.sellDate ? `${l.sellDate}${l.sellTime || '99:99'}` : '99999999999999',
      rate,
    });
  }
  items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let overall = 1;
  let groupRate = 0;
  let groupEnd = null;
  for (const it of items) {
    if (groupEnd != null && it.start <= groupEnd) {
      // 与当前轮已有持仓时间重叠 → 归入同一轮，收益相加
      groupRate += it.rate;
      if (it.end > groupEnd) groupEnd = it.end;
    } else {
      // 新一轮：先把上一轮收益复利进总资金
      if (groupEnd != null) overall *= 1 + groupRate / 100;
      groupRate = it.rate;
      groupEnd = it.end;
    }
  }
  if (groupEnd != null) overall *= 1 + groupRate / 100;
  return parseFloat(((overall - 1) * 100).toFixed(2));
};

const runRangeBacktestInner = async (startDate, endDate, strategyId = 'highest_gain', onProgress) => {
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

  // 持仓列表：普通单股策略最多 1 个；两次买入策略最多 2 个（两份仓位各自独立买卖，均半仓）
  const positions = []; // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric, ... }
  // 情绪快进快出策略：最近一次 10:00 强制卖出的日期（该日禁止二次买入，哪怕买点再次触发）
  let quickOutSoldDate = null;
  const singleTrades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息：{ date: Map<code, {changePct, closePx, resilience}> }
  const dailyInfos = new Map();
  // 预热起始日前 10 个交易日 EOD，日期轴前移，保证起点附近「最近 N 日」窗口不被起始日截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, 10, dailyInfos);
  // 回测期间出现过的全部自选股（供前端复制K线等使用）
  const seenStocks = new Map(); // code -> { code, name }

  // 跨指数双门禁预计算（仅对 N 日涨幅最大系列策略启用；其余策略跳过）
  let cybGatePrecomputed = null, starGatePrecomputed = null;
  const cybGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const starGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const applyCybGate = CYB_GATE_STRATEGY_IDS.has(strategyId);
  if (applyCybGate) {
    try {
      [cybGatePrecomputed, starGatePrecomputed] = await Promise.all([
        precomputeTurnMap(CYB_INDEX_CODE, rangeDates),
        precomputeTurnMap(STAR_INDEX_CODE, rangeDates),
      ]);
    } catch (e) {
      cybGatePrecomputed = null; starGatePrecomputed = null;
    }
  }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      // 统一允许缺失资金快照的日期兜底构建（见 runKeyBlockBacktest 内说明），避免整日跳过漏执行卖点
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
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
    await injectSimStocksIntoCampData(campData, dateStr); // 随机模拟：把合成股票混入当日候选池
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用）
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
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
    if (strategy.nextDayOpenSell === true) {
      for (let pi = 0; pi < positions.length; pi++) {
        const pos = positions[pi];
        if (!pos || !(dateStr > pos.buyDate)) continue;
        const entry = (replayStocks || []).find(s => s.code === pos.code);
        const pts = (entry?.tlinePoints || [])
          .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
          .sort((a, b) => a.minute - b.minute);
        if (pts.length === 0) continue; // 当日无该股分时数据 → 保持持仓、顺延至后续日期重试
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
        const returnRate = pos.buyPrice > 0
          ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
          : null;
        singleTrades.push({
          seq: singleTrades.length + 1,
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
          sellTime: `${String(Math.floor(Number(sellPt.minute) / 100)).padStart(2, '0')}:${String(Number(sellPt.minute) % 100).padStart(2, '0')}`,
          sellPrice,
          sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
          sellReason,
          returnRate,
        });
        positions.splice(pi, 1);
        pi--;
      }
    }

    // 情绪快进快出策略专属卖点：快进快出日（上一交易日 3 日 EMA < -60，或上两交易日当日科技情绪
    // 均处 -30~20 区间且回升）买入的持仓，次日上午 10:00 强制卖出（取当日第一个 minute ≥ 1000 的
    // 分时点价格，未覆盖 10:00 时取当日最后一分钟；当日无该股分时数据时保持持仓、顺延至后续日期重试），
    // 不走通用 7 条件卖点。
    // 2026-10-05 叠加盘中止损（先到先卖，口径与通用条件7一致，成本线 = 买入价 × (1 - costLinePct/100)）：默认 -2%
    // 开盘首分钟已破线 → 竞价低开自救窗口（拉升中继续持有；回补至阈值上方则不再止损、待再次跌破再卖）；
    // 回落且仍跌破阈值才卖；开盘未破线、盘中才跌破 → 即时止损；止损分钟早于强卖分钟时按止损价先卖，否则仍按 10:00 强卖
    // 两份仓位各自独立判定（两次买入策略的两份均为半仓、各以自身买入价为成本）
    // 2026-10-09 叠加强卖豁免（buildQuickOutExemptInfo）：未触发止损且命中任一「次日强势」判断
    // （① 10:00 前含 10:00 买点诊断再次触发；② 10:00 时点科技情绪>0 + 低于开盘价<30只 + 资金净流入>0）
    // → 本次不强卖，持仓转由通用 7 条件卖点接管（后续日期也不再强卖）
    if (strategy.emoQuickOut === true) {
      // 当日存在待强卖（未豁免过的）快进快出持仓时才评估豁免判定（每策略每日一次）
      const hasDueQuickOut = positions.some(p => p?.emoQuickOut?.quickOut === true && !p.emoQuickOut?.exempted && dateStr > p.buyDate);
      const exemptInfo = hasDueQuickOut ? buildQuickOutExemptInfo(timeBuckets, campData) : null;
      for (let pi = 0; pi < positions.length; pi++) {
        const pos = positions[pi];
        if (!pos || pos.emoQuickOut?.quickOut !== true || pos.emoQuickOut?.exempted || !(dateStr > pos.buyDate)) continue;
        const entry = (replayStocks || []).find(s => s.code === pos.code);
        const pts = (entry?.tlinePoints || [])
          .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
          .sort((a, b) => a.minute - b.minute);
        if (pts.length === 0) continue; // 当日无该股分时数据 → 保持持仓、顺延至后续日期重试
        const fmtMin = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
        const forcedPt = pts.find(p => Number(p.minute) >= 1000) || pts[pts.length - 1];
        // 盘中跌破成本线止损点（先到先卖）
        const qPct = strategy.costLinePct != null && Number.isFinite(Number(strategy.costLinePct)) ? Number(strategy.costLinePct) : 2;
        let stopPt = null;
        let stopDesc = '';
        const stopThreshold = pos.buyPrice > 0 ? parseFloat((pos.buyPrice * (1 - qPct / 100)).toFixed(2)) : null;
        if (stopThreshold != null) {
          if (Number(pts[0].lastPx) <= stopThreshold) {
            // 竞价低开自救窗口：首分钟已破线，拉升中继续持有；回补至阈值上方则不再止损（待再次跌破再卖）；回落且仍跌破阈值才卖（到 10:00 交由强卖）
            for (let i = 1; i < pts.length && Number(pts[i].minute) < 1000; i++) {
              if (Number(pts[i].lastPx) < Number(pts[i - 1].lastPx) && Number(pts[i].lastPx) <= stopThreshold) {
                stopPt = pts[i];
                stopDesc = `开盘首分钟 ${fmtMin(pts[0].minute)} 价 ${Number(pts[0].lastPx).toFixed(2)} 已跌破止损线，自救拉升于 ${fmtMin(stopPt.minute)} 回落且仍跌破止损线`;
                break;
              }
            }
          } else {
            // 盘中才跌破 → 即时止损（仅看 10:00 前分钟，10:00 起由强卖接管）
            stopPt = pts.find(p => Number(p.minute) < 1000 && Number(p.lastPx) <= stopThreshold) || null;
            if (stopPt) stopDesc = `盘中 ${fmtMin(stopPt.minute)} 跌破止损线`;
          }
        }
        const sellPt = stopPt && Number(stopPt.minute) < Number(forcedPt.minute) ? stopPt : forcedPt;
        const isStopLoss = sellPt === stopPt;
        // 强卖豁免（2026-10-09）：未触发止损且命中任一「次日强势」判断 → 本次不强卖，
        // 持仓转由通用 7 条件卖点接管（本次及后续日期均不再强卖；止损仍先到先卖）
        if (!isStopLoss && exemptInfo) {
          pos.emoQuickOut.exempted = { date: dateStr, via: exemptInfo.via, detail: exemptInfo.detail };
          continue;
        }
        const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
        // 两次买入策略：快进快出强卖/止损按半仓权重折算（每份仓位各自独立、恒为半仓）
        const isTwoBuy = strategy.twoBuy === true;
        const rawReturnRate = pos.buyPrice > 0
          ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
          : null;
        const returnRate = isTwoBuy && rawReturnRate != null
          ? parseFloat((rawReturnRate * TWO_BUY_LEG_WEIGHT).toFixed(2))
          : rawReturnRate;
        singleTrades.push({
          seq: singleTrades.length + 1,
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
          ...(isTwoBuy ? buildTwoBuyTradeExtra({ ...pos, rawReturnRate }) : {}),
          sellDate: dateStr,
          sellDateDisplay: dateDisplay,
          sellTime: fmtMin(sellPt.minute),
          sellPrice,
          sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
          sellReason: isStopLoss
            ? buildQuickOutStopLossReason(pos.buyPrice, sellPt, stopDesc, qPct)
            : buildQuickOutSellReason(pos.emoQuickOut),
          returnRate,
        });
        positions.splice(pi, 1);
        pi--;
        quickOutSoldDate = dateStr; // 强卖/止损当日禁止二次买入（哪怕买点再次触发）
      }
    }

    const sellPositions = async (bi) => {
      const bucket = timeBuckets[bi];
      // 逐份诊断持仓（普通单股策略最多 1 份；两次买入策略最多 2 份，各自独立卖点）
      for (let pi = 0; pi < positions.length; pi++) {
        const pos = positions[pi];
        if (!pos) continue;
        if (dateStr <= pos.buyDate) continue; // 当日买入不可当日卖出（T+1）
        // 情绪快进快出持仓：不走通用 7 条件卖点，仅由上方按日处理（盘中跌破成本线止损先到先卖 + 10:00 强卖；分时缺失时顺延）；
        // 2026-10-09 起命中强势豁免的快进快出持仓（exempted）转为普通持仓，由通用 7 条件卖点接管
        if (strategy.emoQuickOut === true && pos.emoQuickOut?.quickOut === true && !pos.emoQuickOut?.exempted) continue;
        // 三日情绪均值策略走次日开盘专属卖点（已在桶循环前按日处理），不进入通用卖点诊断
        const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate, tailDipSell: strategy.tailDip === true && strategy.nextDayOpenSell !== true, costLinePct: strategy.costLinePct };
        const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
        if (result.isSell && result.closePrice != null) {
          const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
          const isTwoBuy = strategy.twoBuy === true;
          // 两次买入策略：每份仓位各自独立按半仓折算收益，保留个股原始收益率供前端悬停展示
          const rawReturnRate = result.returnRate;
          const returnRate = isTwoBuy && rawReturnRate != null
            ? parseFloat((rawReturnRate * TWO_BUY_LEG_WEIGHT).toFixed(2))
            : result.returnRate;
          singleTrades.push({
            seq: singleTrades.length + 1,
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
            ...(isTwoBuy ? buildTwoBuyTradeExtra({ ...pos, rawReturnRate }) : {}),
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: result.displayTime,
            sellPrice: result.closePrice,
            sellChange: result.change,
            sellReason: (satisfiedNames || '卖出条件触发') + buildQuickOutExemptSuffix(pos),
            returnRate,
          });
          positions.splice(pi, 1);
          pi--;
        }
      }
    };

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];

      // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
      // 情绪快进快出策略：当日已发生 10:00 强制卖出 → 当日禁止二次买入（哪怕买点再次触发）
      const quickOutNoRebuy = strategy.emoQuickOut === true && quickOutSoldDate === dateStr;
      const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
      const buyHit = !quickOutNoRebuy && (strategy.tailDip === true
        ? (strategy.emoAvgBuy === true ? checkEmoAvg3Hit(timeBuckets, bi, dateStr) : checkTailDipHit(timeBuckets, bi))
        : buyDiag?.allPassed === true);
      // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，三日情绪均值走专属命中原因，其余取买点诊断全部通过项汇总）
      const buyInfo = buyHit
        ? (strategy.tailDip === true ? (strategy.emoAvgBuy === true ? EMO_AVG3_BUY_INFO : TAIL_DIP_BUY_INFO) : buildBuyReasonFromDiag(buyDiag))
        : null;
      if (buyHit) {
        // N 日涨幅最大系列策略：跨指数双门禁 + 选股市场过滤
        const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(buyInfo, strategy.id, dateStr, bucket.minute,
          { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState });
        if (!gatePassed) {
          continue;
        }
        // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
        const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

        if (positions.length === 0) {
          // 未持仓时按指标选最优的一只买入（普通策略同一时刻仅持有一只；两次买入策略建第一份）
          // 上一交易日一字板过滤（全策略通用）：预取候选池昨日一字板集合传入选股（进程内按 股票_日期 缓存）
          const prevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
          // 顺/逆周期过滤（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略）：预取逆周期候选集合传入选股
          const emoCycSet = isCycleFilterStrategy(strategy)
            ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
            : null;
          const picked = pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet);
          if (picked) {
            // 两次买入系列叠加「快进快出」能力：首次建仓时按买入时点计算快进快出标注
            // （与 highest_{N}d_gain_emoquick 同口径，传入日期轴绝对索引 di + axisOffset），挂到持仓上驱动
            // 次日 10:00 强卖 + 盘中跌破成本线止损。必须在 withResilienceGateInfo 之前挂载，买入明细方可写入 emo_quick_out 判定项。
            if (strategy.twoBuy === true && strategy.emoQuickOut === true) {
              picked.emoQuickOut = computeEmoQuickOutInfo(di + axisOffset, dateAxis);
            }
            const finalBuyInfo = withResilienceGateInfo(gatedBuyInfo, picked);
            const sc = picked.stock;
            const firstBuyPrice = parseFloat(Number(sc.lastPx).toFixed(2));
            positions.push({
              code: sc.code,
              stockName: sc.name || sc.code,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime,
              buyPrice: firstBuyPrice,
              buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
              metric: picked.metric,
              buyReason: finalBuyInfo.buyReason,
              buyChecks: annotateIndexGateChecksWithStock(finalBuyInfo.buyChecks, sc.code, sc.name),
              emoQuickOut: picked.emoQuickOut || null, // 情绪快进快出标注（quickOut=true → 次日 10:00 强制卖出；其余策略为 null）
              // 两次买入策略：第一份按半仓权重，标记 leg=1
              ...(strategy.twoBuy === true ? { twoBuy: true, leg: 1, weight: TWO_BUY_LEG_WEIGHT } : {}),
            });
          }
        } else if (strategy.twoBuy === true && positions.length === 1 && positions[0].leg === 1 && dateStr > positions[0].buyDate) {
          // 两次买入策略：已持有第一份（半仓），买点再次触发 → 买入第二份 5 成
          // 约束：① 必须在第一份建仓之后的交易日（≥ 隔 1 天）买入；② 补买同样过滤涨停（买入时点该股已涨停不可成交）；
          //       ③ 普通两次买入系列第二份必须与第一份同一只股票（不重新择股）；
          //          「不同板块」变体（diffBlock）第二份则在「板块与第一份不同」的候选中重新按 N 日涨幅最大择股
          const first = positions[0];
          if (strategy.diffBlock === true) {
            // 两次买入不同板块：第二份在「所属板块（blockName）≠ 第一份板块」的候选中重新择股（N 日涨幅最大）
            const firstBlock = getStockBlockName(first.code);
            const restrictCodes = new Set(
              (bucket.stockChanges || [])
                .filter(s => s.lastPx != null && s.lastPx > 0 && getStockBlockName(s.code) !== firstBlock)
                .map(s => s.code)
            );
            const secondPrevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
            const secondEmoCycSet = isCycleFilterStrategy(strategy)
              ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
              : null;
            const secondPicked = restrictCodes.size > 0
              ? pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, secondPrevOneWordSet, secondEmoCycSet, restrictCodes)
              : null;
            if (secondPicked) {
              const secondBuyInfo = withResilienceGateInfo(gatedBuyInfo, secondPicked);
              const sc2 = secondPicked.stock;
              const secondPx = parseFloat(Number(sc2.lastPx).toFixed(2));
              positions.push({
                code: sc2.code,
                stockName: sc2.name || sc2.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: secondPx,
                buyChange: sc2.changePct != null ? parseFloat(Number(sc2.changePct).toFixed(2)) : null,
                metric: secondPicked.metric,
                buyReason: `${secondBuyInfo.buyReason}；买点第二次触发，买入第二份 5 成（第一份 ${first.stockName}·${firstBlock} 板块，本份改选其他板块中 N 日涨幅最大的 ${sc2.name || sc2.code}·${getStockBlockName(sc2.code)} 板块，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                buyChecks: annotateIndexGateChecksWithStock(secondBuyInfo.buyChecks, sc2.code, sc2.name),
                emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
              });
            }
          } else {
            const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
            const secondPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
            const heldLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
            if (secondPx != null && secondPx > 0 && !heldLimitUp) {
              positions.push({
                code: first.code,
                stockName: first.stockName,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: secondPx,
                buyChange: heldSc.changePct != null ? parseFloat(Number(heldSc.changePct).toFixed(2)) : null,
                metric: first.metric,
                buyReason: `${gatedBuyInfo?.buyReason || first.buyReason}；买点第二次触发，买入第二份 5 成（同一股票 ${first.stockName}，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                buyChecks: annotateIndexGateChecksWithStock(gatedBuyInfo?.buyChecks || first.buyChecks, first.code, first.stockName),
                emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
              });
            }
          }
        }
      }

      // 卖出信号
      await sellPositions(bi);
    }

  }

  // 组装结果
  // 期末持仓：逐份按最近一个有效日期的收盘价估算浮盈，计入整体收益（两次买入策略可能同时持有两份）
  const currentHoldings = [];
  for (const pos of positions) {
    const h = { ...pos };
    let closePx = null;
    // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(pos.code);
      if (info && info.closePx != null && info.closePx > 0) { closePx = info.closePx; break; }
    }
    const rawBuyReturn = closePx != null && pos.buyPrice > 0
      ? parseFloat((((closePx - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
      : null;
    if (strategy.twoBuy === true) {
      // 两次买入：每份仓位各自半仓折算期末浮盈
      h.weight = TWO_BUY_LEG_WEIGHT;
      h.rawBuyReturn = rawBuyReturn;
      h.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * TWO_BUY_LEG_WEIGHT).toFixed(2)) : null;
    } else {
      h.buyReturn = rawBuyReturn;
    }
    currentHoldings.push(h);
  }
  const holding = currentHoldings[0] || null;
  // 整体收益：两次买入按真实账户口径（同一轮两份同时持有 → 轮内收益相加，跨轮复利）；
  // 其余单份策略同一时刻只持有一份，逐笔复利即等价账户口径
  const overallReturn = strategy.twoBuy === true
    ? computeTwoBuyAccountReturn([
        ...singleTrades,
        ...currentHoldings.map(h => ({ ...h, returnRate: h.buyReturn })),
      ])
    : (() => {
        let acc = 1;
        for (const t of singleTrades) {
          if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
        }
        for (const h of currentHoldings) acc *= 1 + (h.buyReturn || 0) / 100;
        return parseFloat(((acc - 1) * 100).toFixed(2));
      })();
  const validTrades = singleTrades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: sortTradesByBuyTime(singleTrades),
    currentHolding: holding,
    currentHoldings,
    summary: {
      tradeCount: singleTrades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: currentHoldings.length > 0,
    },
  };
};

// 多日回测入口：可选 options.excludeCodes（震荡测试勾选隐藏的股票代码列表）。
// 排除列表经 AsyncLocalStorage 注入整次回测执行链，候选选股处（pickBestStock / 弱转强 /
// 四份仓位 / 两个股票 / 重点板块）统一过滤，被隐藏的股票不参与选股买入
const runRangeBacktest = (startDate, endDate, strategyId = 'highest_gain', onProgress, options = {}) => {
  const excludeList = Array.isArray(options.excludeCodes)
    ? options.excludeCodes.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
    : [];
  const excludeSet = excludeList.length > 0 ? new Set(excludeList.map(c => c.toLowerCase())) : null;
  // options.sim：随机模拟测试注入的合成股票集合（AsyncLocalStorage 上下文，见 backtestSimContext）
  const sim = options.sim || null;
  return runWithSimContext(sim, () => runWithOscExclude(excludeSet, () => runRangeBacktestInner(startDate, endDate, strategyId, onProgress)));
};

// 多策略共享数据回测：外层日期、内层策略，同一天回放数据只加载一次依次喂给全部策略。
// 与 runRangeBacktest 的差异仅在于数据加载被整组策略共享（dailyInfos/seenStocks 由 campData 派生，与策略无关，可共享），
// 持仓状态与成交流水按策略独立维护，单策略结果结构与 runRangeBacktest 完全一致。
// 返回：[{ strategyId, result }]
const runRangeBacktestMulti = async (startDate, endDate, strategyIds, onProgress) => {
  const ids = (Array.isArray(strategyIds) ? strategyIds : []).filter(id => STRATEGIES[id]);
  if (ids.length === 0) return [];
  // 重点板块-N日最高涨幅系列走独立回测（板块驱动、尾盘 14:50 买入，不走共享数据循环的买点诊断）
  const keyBlockIds = ids.filter(id => STRATEGIES[id]?.keyBlockDays != null);
  const regularIds = ids.filter(id => STRATEGIES[id]?.keyBlockDays == null);
  const results = [];
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
    // 持仓列表：普通单股策略最多 1 个；两次买入策略最多 2 个（两份仓位各自独立买卖，均半仓）
    positions: [], // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric, ... }
    // 情绪快进快出策略：最近一次 10:00 强制卖出的日期（该日禁止二次买入，哪怕买点再次触发）
    quickOutSoldDate: null,
    singleTrades: [],
    skippedDates: [],
  }));

  // 整组策略共享：每日 EOD 信息与期间出现过的自选股（均由 campData 派生）
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }
  // 预热起始日前 10 个交易日 EOD，日期轴前移，保证起点附近「最近 N 日」窗口不被起始日截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, 10, dailyInfos);

  // 跨指数双门禁预计算（整组 regular 策略共享一次，每个策略各自在 buyHit 时判定）
  let cybGatePrecomputed = null, starGatePrecomputed = null;
  const cybGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const starGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const anyApplyCybGate = regularIds.some(id => CYB_GATE_STRATEGY_IDS.has(id));
  if (anyApplyCybGate) {
    try {
      [cybGatePrecomputed, starGatePrecomputed] = await Promise.all([
        precomputeTurnMap(CYB_INDEX_CODE, rangeDates),
        precomputeTurnMap(STAR_INDEX_CODE, rangeDates),
      ]);
    } catch (e) { cybGatePrecomputed = null; starGatePrecomputed = null; }
  }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      // 统一允许缺失资金快照的日期兜底构建（见 runKeyBlockBacktest 内说明），避免整日跳过漏执行卖点
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
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
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用，与策略无关）
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
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

      // 三日情绪均值策略专属卖点：买入次日按竞价开盘涨幅一次性卖出（开盘涨幅为负 → 9:30 开盘卖出；
      // 开盘涨幅 ≥ 0（含 0~1%）→ 固定 10:00 卖出）。当日无该股分时数据时保持持仓、顺延至后续日期重试
      if (strategy.nextDayOpenSell === true) {
        for (let pi = 0; pi < st.positions.length; pi++) {
          const pos = st.positions[pi];
          if (!pos || !(dateStr > pos.buyDate)) continue;
          const entry = (replayStocks || []).find(s => s.code === pos.code);
          const pts = (entry?.tlinePoints || [])
            .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
            .sort((a, b) => a.minute - b.minute);
          if (pts.length === 0) continue; // 当日无该股分时数据 → 保持持仓、顺延至后续日期重试
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
          const returnRate = pos.buyPrice > 0
            ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
            : null;
          singleTrades.push({
            seq: singleTrades.length + 1,
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
            sellTime: `${String(Math.floor(Number(sellPt.minute) / 100)).padStart(2, '0')}:${String(Number(sellPt.minute) % 100).padStart(2, '0')}`,
            sellPrice,
            sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
            sellReason,
            returnRate,
          });
          st.positions.splice(pi, 1);
          pi--;
        }
      }

      // 情绪快进快出策略专属卖点：快进快出日（上一交易日 3 日 EMA < -60，或上两交易日当日科技情绪
      // 均处 -30~20 区间且回升）买入的持仓，次日上午 10:00 强制卖出（取当日第一个 minute ≥ 1000 的
      // 分时点价格，未覆盖 10:00 时取当日最后一分钟；当日无该股分时数据时保持持仓、顺延至后续日期重试），
      // 不走通用 7 条件卖点。
      // 2026-10-05 叠加盘中止损（先到先卖，口径与通用条件7一致，成本线 = 买入价 × (1 - costLinePct/100)）：默认 -2%
      // 开盘首分钟已破线 → 竞价低开自救窗口（拉升中继续持有；回补至阈值上方则不再止损、待再次跌破再卖）；
      // 回落且仍跌破阈值才卖；开盘未破线、盘中才跌破 → 即时止损；止损分钟早于强卖分钟时按止损价先卖，否则仍按 10:00 强卖
      // 两份仓位各自独立判定（两次买入策略的两份均为半仓、各以自身买入价为成本）
      // 2026-10-09 叠加强卖豁免（buildQuickOutExemptInfo）：未触发止损且命中任一「次日强势」判断
      // （① 10:00 前含 10:00 买点诊断再次触发；② 10:00 时点科技情绪>0 + 低于开盘价<30只 + 资金净流入>0）
      // → 本次不强卖，持仓转由通用 7 条件卖点接管（后续日期也不再强卖）
      if (strategy.emoQuickOut === true) {
        // 当日存在待强卖（未豁免过的）快进快出持仓时才评估豁免判定（每策略每日一次）
        const hasDueQuickOut = st.positions.some(p => p?.emoQuickOut?.quickOut === true && !p.emoQuickOut?.exempted && dateStr > p.buyDate);
        const exemptInfo = hasDueQuickOut ? buildQuickOutExemptInfo(timeBuckets, campData) : null;
        for (let pi = 0; pi < st.positions.length; pi++) {
          const pos = st.positions[pi];
          if (!pos || pos.emoQuickOut?.quickOut !== true || pos.emoQuickOut?.exempted || !(dateStr > pos.buyDate)) continue;
          const entry = (replayStocks || []).find(s => s.code === pos.code);
          const pts = (entry?.tlinePoints || [])
            .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
            .sort((a, b) => a.minute - b.minute);
          if (pts.length === 0) continue; // 当日无该股分时数据 → 保持持仓、顺延至后续日期重试
          const fmtMin = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
          const forcedPt = pts.find(p => Number(p.minute) >= 1000) || pts[pts.length - 1];
          // 盘中跌破成本线止损点（先到先卖）
          const qPct = strategy.costLinePct != null && Number.isFinite(Number(strategy.costLinePct)) ? Number(strategy.costLinePct) : 2;
          let stopPt = null;
          let stopDesc = '';
          const stopThreshold = pos.buyPrice > 0 ? parseFloat((pos.buyPrice * (1 - qPct / 100)).toFixed(2)) : null;
          if (stopThreshold != null) {
            if (Number(pts[0].lastPx) <= stopThreshold) {
              // 竞价低开自救窗口：首分钟已破线，拉升中继续持有；回补至阈值上方则不再止损（待再次跌破再卖）；回落且仍跌破阈值才卖（到 10:00 交由强卖）
              for (let i = 1; i < pts.length && Number(pts[i].minute) < 1000; i++) {
                if (Number(pts[i].lastPx) < Number(pts[i - 1].lastPx) && Number(pts[i].lastPx) <= stopThreshold) {
                  stopPt = pts[i];
                  stopDesc = `开盘首分钟 ${fmtMin(pts[0].minute)} 价 ${Number(pts[0].lastPx).toFixed(2)} 已跌破止损线，自救拉升于 ${fmtMin(stopPt.minute)} 回落且仍跌破止损线`;
                  break;
                }
              }
            } else {
              // 盘中才跌破 → 即时止损（仅看 10:00 前分钟，10:00 起由强卖接管）
              stopPt = pts.find(p => Number(p.minute) < 1000 && Number(p.lastPx) <= stopThreshold) || null;
              if (stopPt) stopDesc = `盘中 ${fmtMin(stopPt.minute)} 跌破止损线`;
            }
          }
          const sellPt = stopPt && Number(stopPt.minute) < Number(forcedPt.minute) ? stopPt : forcedPt;
          const isStopLoss = sellPt === stopPt;
          // 强卖豁免（2026-10-09）：未触发止损且命中任一「次日强势」判断 → 本次不强卖，
          // 持仓转由通用 7 条件卖点接管（本次及后续日期均不再强卖；止损仍先到先卖）
          if (!isStopLoss && exemptInfo) {
            pos.emoQuickOut.exempted = { date: dateStr, via: exemptInfo.via, detail: exemptInfo.detail };
            continue;
          }
          const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
          // 两次买入策略：快进快出强卖/止损按半仓权重折算（每份仓位各自独立、恒为半仓）
          const isTwoBuy = strategy.twoBuy === true;
          const rawReturnRate = pos.buyPrice > 0
            ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
            : null;
          const returnRate = isTwoBuy && rawReturnRate != null
            ? parseFloat((rawReturnRate * TWO_BUY_LEG_WEIGHT).toFixed(2))
            : rawReturnRate;
          singleTrades.push({
            seq: singleTrades.length + 1,
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
            ...(isTwoBuy ? buildTwoBuyTradeExtra({ ...pos, rawReturnRate }) : {}),
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: fmtMin(sellPt.minute),
            sellPrice,
            sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
            sellReason: isStopLoss
              ? buildQuickOutStopLossReason(pos.buyPrice, sellPt, stopDesc, qPct)
              : buildQuickOutSellReason(pos.emoQuickOut),
            returnRate,
          });
          st.positions.splice(pi, 1);
          pi--;
          st.quickOutSoldDate = dateStr; // 强卖/止损当日禁止二次买入（哪怕买点再次触发）
        }
      }

      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];

        // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
        // 情绪快进快出策略：当日已发生 10:00 强制卖出 → 当日禁止二次买入（哪怕买点再次触发）
        const quickOutNoRebuy = strategy.emoQuickOut === true && st.quickOutSoldDate === dateStr;
        const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
        const buyHit = !quickOutNoRebuy && (strategy.tailDip === true
          ? (strategy.emoAvgBuy === true ? checkEmoAvg3Hit(timeBuckets, bi, dateStr) : checkTailDipHit(timeBuckets, bi))
          : buyDiag?.allPassed === true);
        // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，三日情绪均值走专属命中原因，其余取买点诊断全部通过项汇总）
        const buyInfo = buyHit
          ? (strategy.tailDip === true ? (strategy.emoAvgBuy === true ? EMO_AVG3_BUY_INFO : TAIL_DIP_BUY_INFO) : buildBuyReasonFromDiag(buyDiag))
          : null;
        if (buyHit) {
          // N 日涨幅最大系列策略：跨指数双门禁 + 选股市场过滤
          const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(buyInfo, strategy.id, dateStr, bucket.minute,
            { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState });
          if (!gatePassed) {
            continue;
          }
          // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
          const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

          if (st.positions.length === 0) {
            // 未持仓时按指标选最优的一只买入（普通策略同一时刻仅持有一只；两次买入策略建第一份）
            // 上一交易日一字板过滤（全策略通用）：预取候选池昨日一字板集合传入选股（进程内按 股票_日期 缓存）
            const prevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
            // 顺/逆周期过滤（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略）：预取逆周期候选集合传入选股
            const emoCycSet = isCycleFilterStrategy(strategy)
              ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
              : null;
            const picked = pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet);
            if (picked) {
              // 两次买入系列叠加「快进快出」能力：首次建仓时按买入时点计算快进快出标注
              // （与 highest_{N}d_gain_emoquick 同口径，传入日期轴绝对索引 di + axisOffset），挂到持仓上驱动
              // 次日 10:00 强卖 + 盘中跌破成本线止损。必须在 withResilienceGateInfo 之前挂载，买入明细方可写入 emo_quick_out 判定项。
              if (strategy.twoBuy === true && strategy.emoQuickOut === true) {
                picked.emoQuickOut = computeEmoQuickOutInfo(di + axisOffset, dateAxis);
              }
              const finalBuyInfo = withResilienceGateInfo(gatedBuyInfo, picked);
              const sc = picked.stock;
              const firstBuyPrice = parseFloat(Number(sc.lastPx).toFixed(2));
              st.positions.push({
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: firstBuyPrice,
                buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                metric: picked.metric,
                buyReason: finalBuyInfo.buyReason,
                buyChecks: annotateIndexGateChecksWithStock(finalBuyInfo.buyChecks, sc.code, sc.name),
                emoQuickOut: picked.emoQuickOut || null, // 情绪快进快出标注（quickOut=true → 次日 10:00 强制卖出；其余策略为 null）
                // 两次买入策略：第一份按半仓权重，标记 leg=1
                ...(strategy.twoBuy === true ? { twoBuy: true, leg: 1, weight: TWO_BUY_LEG_WEIGHT } : {}),
              });
            }
          } else if (strategy.twoBuy === true && st.positions.length === 1 && st.positions[0].leg === 1 && dateStr > st.positions[0].buyDate) {
            // 两次买入策略：已持有第一份（半仓），买点再次触发 → 买入第二份 5 成
            // 约束：① 必须在第一份建仓之后的交易日（≥ 隔 1 天）买入；② 补买同样过滤涨停（买入时点该股已涨停不可成交）；
            //       ③ 普通两次买入系列第二份必须与第一份同一只股票（不重新择股）；
            //          「不同板块」变体（diffBlock）第二份则在「板块与第一份不同」的候选中重新按 N 日涨幅最大择股
            const first = st.positions[0];
            if (strategy.diffBlock === true) {
              // 两次买入不同板块：第二份在「所属板块（blockName）≠ 第一份板块」的候选中重新择股（N 日涨幅最大）
              const firstBlock = getStockBlockName(first.code);
              const restrictCodes = new Set(
                (bucket.stockChanges || [])
                  .filter(s => s.lastPx != null && s.lastPx > 0 && getStockBlockName(s.code) !== firstBlock)
                  .map(s => s.code)
              );
              const secondPrevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
              const secondEmoCycSet = isCycleFilterStrategy(strategy)
                ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
                : null;
              const secondPicked = restrictCodes.size > 0
                ? pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, secondPrevOneWordSet, secondEmoCycSet, restrictCodes)
                : null;
              if (secondPicked) {
                const secondBuyInfo = withResilienceGateInfo(gatedBuyInfo, secondPicked);
                const sc2 = secondPicked.stock;
                const secondPx = parseFloat(Number(sc2.lastPx).toFixed(2));
                st.positions.push({
                  code: sc2.code,
                  stockName: sc2.name || sc2.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: secondPx,
                  buyChange: sc2.changePct != null ? parseFloat(Number(sc2.changePct).toFixed(2)) : null,
                  metric: secondPicked.metric,
                  buyReason: `${secondBuyInfo.buyReason}；买点第二次触发，买入第二份 5 成（第一份 ${first.stockName}·${firstBlock} 板块，本份改选其他板块中 N 日涨幅最大的 ${sc2.name || sc2.code}·${getStockBlockName(sc2.code)} 板块，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                  buyChecks: annotateIndexGateChecksWithStock(secondBuyInfo.buyChecks, sc2.code, sc2.name),
                  emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                  twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
                });
              }
            } else {
              const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
              const secondPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
              const heldLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
              if (secondPx != null && secondPx > 0 && !heldLimitUp) {
                st.positions.push({
                  code: first.code,
                  stockName: first.stockName,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: secondPx,
                  buyChange: heldSc.changePct != null ? parseFloat(Number(heldSc.changePct).toFixed(2)) : null,
                  metric: first.metric,
                  buyReason: `${gatedBuyInfo?.buyReason || first.buyReason}；买点第二次触发，买入第二份 5 成（同一股票 ${first.stockName}，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                  buyChecks: annotateIndexGateChecksWithStock(gatedBuyInfo?.buyChecks || first.buyChecks, first.code, first.stockName),
                  emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                  twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
                });
              }
            }
          }
        }

        // 卖出信号（同日买入不可同日卖出）
        // 逐份诊断持仓（普通单股策略最多 1 份；两次买入策略最多 2 份，各自独立卖点、各自半仓折算）
        for (let pi = 0; pi < st.positions.length; pi++) {
          const pos = st.positions[pi];
          if (!pos) continue;
          if (dateStr <= pos.buyDate) continue; // 当日买入不可当日卖出（T+1）
          // 情绪快进快出持仓：不走通用 7 条件卖点，仅由上方按日处理（盘中跌破成本线止损先到先卖 + 10:00 强卖；分时缺失时顺延）；
          // 2026-10-09 起命中强势豁免的快进快出持仓（exempted）转为普通持仓，由通用 7 条件卖点接管
          if (strategy.emoQuickOut === true && pos.emoQuickOut?.quickOut === true && !pos.emoQuickOut?.exempted) continue;
          // 三日情绪均值策略走次日开盘专属卖点（已在桶循环前按日处理），不进入通用卖点诊断
          const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate, tailDipSell: strategy.tailDip === true && strategy.nextDayOpenSell !== true, costLinePct: strategy.costLinePct };
          const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
          if (result.isSell && result.closePrice != null) {
            const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
            const isTwoBuy = strategy.twoBuy === true;
            // 两次买入策略：每份仓位各自独立按半仓折算收益，保留个股原始收益率供前端悬停展示
            const rawReturnRate = result.returnRate;
            const returnRate = isTwoBuy && rawReturnRate != null
              ? parseFloat((rawReturnRate * TWO_BUY_LEG_WEIGHT).toFixed(2))
              : result.returnRate;
            singleTrades.push({
              seq: singleTrades.length + 1,
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
              ...(isTwoBuy ? buildTwoBuyTradeExtra({ ...pos, rawReturnRate }) : {}),
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: result.displayTime,
              sellPrice: result.closePrice,
              sellChange: result.change,
              sellReason: (satisfiedNames || '卖出条件触发') + buildQuickOutExemptSuffix(pos),
              returnRate,
            });
            st.positions.splice(pi, 1);
            pi--;
          }
        }
      }
    }
  }

  // 逐策略组装结果（与 runRangeBacktest 单策略版完全一致）
  // 注意：必须 concat 前面独立回测（重点板块系列）已推入 results 的结果，
  // 否则混合组跑常规阶段时这些策略的结果会被静默丢弃（子进程不写缓存、也不报错，
  // 汇总阶段仅读缓存时即显示为「回测失败」——重点板块因总在独立阶段跑（regularIds 为空
  // 走上方提前 return results）从未触发此问题）
  return results.concat(states.map(st => {
    const { strategy, singleTrades, skippedDates } = st;
    // 期末持仓：逐份按最近一个有效日期的收盘价估算浮盈，计入整体收益（两次买入策略可能同时持有两份）
    const currentHoldings = [];
    for (const pos of st.positions) {
      const h = { ...pos };
      let closePx = null;
      // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
      for (let i = rangeDates.length - 1; i >= 0; i--) {
        const info = dailyInfos.get(rangeDates[i])?.get(pos.code);
        if (info && info.closePx != null && info.closePx > 0) { closePx = info.closePx; break; }
      }
      const rawBuyReturn = closePx != null && pos.buyPrice > 0
        ? parseFloat((((closePx - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
        : null;
      if (strategy.twoBuy === true) {
        // 两次买入：每份仓位各自半仓折算期末浮盈
        h.weight = TWO_BUY_LEG_WEIGHT;
        h.rawBuyReturn = rawBuyReturn;
        h.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * TWO_BUY_LEG_WEIGHT).toFixed(2)) : null;
      } else {
        h.buyReturn = rawBuyReturn;
      }
      currentHoldings.push(h);
    }
    const holding = currentHoldings[0] || null;
    // 整体收益：两次买入按真实账户口径（同一轮两份同时持有 → 轮内收益相加，跨轮复利）；
    // 其余单份策略同一时刻只持有一份，逐笔复利即等价账户口径
    const overallReturn = strategy.twoBuy === true
      ? computeTwoBuyAccountReturn([
          ...singleTrades,
          ...currentHoldings.map(h => ({ ...h, returnRate: h.buyReturn })),
        ])
      : (() => {
          let acc = 1;
          for (const t of singleTrades) {
            if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
          }
          for (const h of currentHoldings) acc *= 1 + (h.buyReturn || 0) / 100;
          return parseFloat(((acc - 1) * 100).toFixed(2));
        })();
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
        trades: sortTradesByBuyTime(singleTrades),
        currentHolding: holding,
        currentHoldings,
        summary: {
          tradeCount: singleTrades.length,
          winCount,
          winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
          ...calcDrawdownStats(validTrades),
          overallReturn,
          holding: currentHoldings.length > 0,
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
  sortTradesByBuyTime, // 供回测报告读取旧快照时统一按买入时间排序
  loadReportIndex,
  sumReportCount,
  getStockRecentReports,
  getTechEmotionEmaMap,
  getTechEmotionRawMap, // 供 buySellDiagnose 线上卖点诊断条件8/买点提示按当日科技情绪原始分判定快进快出
  getTechIndexDates, // 供 backtest-worker 对三日情绪冰点日期范围（含缺资金快照日期）做兜底预构建
  EMO3_BACKTEST_START_DATE,
  isEmo3AvgStrategy,
  getEmo3DefaultRange,
  queryLiveIndexGate, // 无状态实时门禁查询（供前端 /api/index-slope-gate 使用）
  codeToGateIndex,    // 供 buySellDiagnose 的 getSingleStockBuyPointDiagnosis 复用
  gateIndexName,      // 供 buySellDiagnose 里生成可读标签
  CYB_INDEX_CODE,
  STAR_INDEX_CODE,
  GLOBAL_RESILIENCE_MIN, // 全局最低抗分歧门槛（供 buySellDiagnose 复用，此前未导出导致比较恒为 false）
  BUY_TIME_MAX_MINUTE,   // 买入时段门禁上限 13:30（供 buySellDiagnose 复用，此前未导出导致门禁恒不通过）
};
