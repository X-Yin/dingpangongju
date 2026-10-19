const { GLOBAL_RESILIENCE_MIN, RESILIENCE_GATE_MIN, RESILIENCE_GATE_STRATEGY_IDS } = require('../strategies/registry');
const { CYC_CORR_WINDOW, CYC_MIN_CYB_CORR } = require('./cycleFilter');
const { EMO_QUICK_CRASH_PCT, EMO_QUICK_RANGE_HIGH, EMO_QUICK_RANGE_LOW, EMO_SWITCH_EMA_THRESHOLD } = require('../constants');
const { runBuyPointDiagnosis } = require('../diagnose/buyPoint');

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

// 情绪快进快出标注明细项（highest_{N}d_gain_emoquick 系列）：标注本次买入是否为「快进快出」买入
//（触发条件二选一：上一交易日科技情绪 3 日 EMA < -30；或上上个、上个交易日的当日科技情绪原始分
// 均处 -30~-10 区间且回升）——是则该笔持仓不走通用 7 条件卖点、买入次日 10:00 强制卖出；
// 2026-10-05 叠加：持仓次日盘中跌破成本线 -2% 时先到先卖止损；
// 2026-10-09 叠加：次日命中强卖豁免（10:00 前买点再触发 / 10:00 时点科技情绪>0+低于开盘价<30只+资金净流入>0）则不强卖、转由通用卖点接管；
// 2026-10-15 叠加：快进快出系列全部持仓（含普通持仓与豁免持仓）盘中当日跌幅（较昨收）≤ -7% 时无条件强卖
const buildEmoQuickOutCheck = (info) => ({
  id: 'emo_quick_out',
  title: '情绪快进快出（次日10:00强卖）',
  passed: true,
  value: info.quickOut ? '快进快出' : '普通持仓',
  reason: info.quickOut
    ? (info.trigger === 'range_rising'
      ? `上上个交易日科技情绪 = ${info.prev2Raw != null ? info.prev2Raw : '缺失'}、上一交易日 = ${info.prevRaw != null ? info.prevRaw : '缺失'}（当日原始分，均在 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间且较前日回升），本次买入为快进快出：次日 10:00 强制卖出（不走通用 7 条件卖点；盘中跌破成本线 -2% 时先到先卖止损、盘中当日跌幅较昨收 ≤ -7% 时无条件强卖；命中强卖豁免——次日 10:00 前买点诊断再次触发，或 10:00 时点科技情绪>0、自选科技股低于开盘价<30只、主力资金净流入>0 三者同时满足——则不强卖、转由通用卖点接管）`
      : `上一交易日科技情绪 3 日 EMA = ${info.ema}（< ${EMO_SWITCH_EMA_THRESHOLD}），本次买入为快进快出：次日 10:00 强制卖出（不走通用 7 条件卖点；盘中跌破成本线 -2% 时先到先卖止损、盘中当日跌幅较昨收 ≤ -7% 时无条件强卖；命中强卖豁免——次日 10:00 前买点诊断再次触发，或 10:00 时点科技情绪>0、自选科技股低于开盘价<30只、主力资金净流入>0 三者同时满足——则不强卖、转由通用卖点接管）`)
    : `上一交易日科技情绪 3 日 EMA = ${info.ema != null ? info.ema : '缺失'}（不满足 < ${EMO_SWITCH_EMA_THRESHOLD}），上两交易日当日科技情绪 = ${info.prev2Raw != null ? info.prev2Raw : '缺失'} / ${info.prevRaw != null ? info.prevRaw : '缺失'}（不满足均处 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间且回升），普通持仓，走通用 7 条件卖点（快进快出系列全部持仓叠加：盘中当日跌幅较昨收 ≤ -7% 时无条件强卖）`,
});

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

// 快进快出持仓盘中大跌强卖的 sellReason（2026-10-15 用户新增：当日跌幅较昨收 ≤ EMO_QUICK_CRASH_PCT 时
// 无条件卖出，无自救窗口、不受豁免保护，与成本线止损 / 10:00 强卖先到先卖；Inner/Multi 两处共用）
const buildQuickOutCrashSellReason = (crashPt) => {
  const crashTime = `${String(Math.floor(Number(crashPt.minute) / 100)).padStart(2, '0')}:${String(Number(crashPt.minute) % 100).padStart(2, '0')}`;
  const changeTxt = crashPt.change != null ? `${Number(crashPt.change).toFixed(2)}%` : '缺失';
  return `情绪快进快出：盘中大跌强卖（${crashTime} 当日跌幅较昨收 ${changeTxt} ≤ ${EMO_QUICK_CRASH_PCT}%，无条件卖出、不适用自救窗口与强卖豁免），先于成本线止损与当日 10:00 强卖离场`;
};

// 快进快出 10:00 强卖豁免判定（2026-10-09 用户新增）：次日 10:00 强卖前先做两种「次日强势」判断，
// 命中任一即豁免本次强卖，持仓保留并转由通用 7 条件卖点接管（先一直拿着，等命中其他卖点规则再卖）：
//   豁免① 次日 10:00 前（含 10:00）任一桶买点诊断再次全部通过（runBuyPointDiagnosis allPassed）；
//   豁免② 次日 10:00 时点（无 10:00 桶时取其后最近桶，整日缺失时回退当日最后一桶）三条件同时满足：
//          科技情绪 > 0 且 自选科技股现价低于 9:30 开盘价个股数 < 30（口径同买点诊断检查4，阈值取严格小于，
//          2026-10-16 起仅在科技股内部筛选、非科技股不参与计数）且 大盘主力资金净流入（bucket.fundFlow 累计值）> 0。
// 返回 { via: 'buy_retrigger' | 'strong_at_10', detail } 或 null（不豁免）；任一条件数据缺失按不满足处理（照常强卖）。
// 注意：豁免只取消 10:00 强卖本身，盘中跌破成本线 -2% 止损仍先到先卖（止损本身即「其他卖点规则」之一）
const buildQuickOutExemptInfo = (timeBuckets, campData) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0) return null;
  // 懒加载避免加载期循环依赖（pickHelpers → replayData → sellPoint → buyPoint）
  const { isNonTechWatchlistStock } = require('./pickHelpers');
  // 豁免①：10:00 前（含）任一桶买点诊断再次触发
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) > 1000) break;
    // 仅快进快出持仓会走到这里（sellHooks/emoQuickOut），与买入侧同口径启用检查4 比例收紧
    const diag = runBuyPointDiagnosis(buckets, i, campData, { ratioGatedOpeningBelow: true })?.data;
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
    if (isNonTechWatchlistStock(s.code)) return; // 2026-10-16 起非科技股不参与计数（口径同买点诊断检查4）
    const openPct = openingMap.get(s.code);
    if (openPct !== undefined && openPct !== null && Number(s.changePct) < Number(openPct)) belowCount++;
  });
  const emoOk = emo != null && emo > 0;
  const fundOk = fund != null && fund > 0;
  const belowOk = belowCount < 30;
  if (emoOk && belowOk && fundOk) {
    return {
      via: 'strong_at_10',
      detail: `10:00 时点科技情绪 ${emo.toFixed(2)} > 0、自选科技股低于开盘价 ${belowCount} 只 < 30、主力资金净流入 ${fund.toFixed(2)} 亿 > 0`,
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
// 全部策略的选股结果都可能带 limitUpSkipped（买点时点涨停被顺延的候选），追加 limit_up_defer 明细项并标注买入原因
// 将选股顺延信息追加到买入原因/明细：
//   - 全部策略都可能带 resilienceScore（买点时刻抗分歧分数）：有分数就追加全局 ≥ 9 的 resilience_gate 明细；
//     若全局不达标（globalResilienceSkipped）或门槛策略专项不达标（skipped），追加顺延标注；
//   - 全部策略都可能带 limitUpSkipped（买点时点涨停被顺延的候选），追加 limit_up_defer 明细项并标注买入原因
const withResilienceGateInfo = (buyInfo, picked) => {
  if (!buyInfo || !picked) return buyInfo;
  const hasLimitUp = Array.isArray(picked.limitUpSkipped) && picked.limitUpSkipped.length > 0;
  const hasOneWord = Array.isArray(picked.prevOneWordSkipped) && picked.prevOneWordSkipped.length > 0;
  const hasEmoCyc = Array.isArray(picked.emoCycSkipped) && picked.emoCycSkipped.length > 0;
  const hasGlobalSkip = Array.isArray(picked.globalResilienceSkipped) && picked.globalResilienceSkipped.length > 0;
  const hasGateSkip = Array.isArray(picked.skipped) && picked.skipped.length > 0;
  // 早返回：既没有分数也没有任何顺延信息，也没有情绪快进快出标注
  if (picked.resilienceScore == null && !picked.emoQuickOut && !hasLimitUp && !hasOneWord && !hasEmoCyc && !hasGlobalSkip && !hasGateSkip) return buyInfo;
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
  if (picked.emoQuickOut) {
    // 情绪快进快出系列：标注本次买入是否为快进快出（明细项；快进快出时买入原因尾部加标签）
    buyChecks.push(buildEmoQuickOutCheck(picked.emoQuickOut));
    if (picked.emoQuickOut.quickOut) {
      const quickTag = picked.emoQuickOut.trigger === 'range_rising' ? '情绪回升快进快出(次日10:00强卖)' : '情绪-30快进快出(次日10:00强卖)';
      buyReason = `${buyReason}｜${quickTag}`;
    }
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
//           （情绪游资系列 iceMode 方向不同、止损为 -2%，且额外增加「14:55 下影线 ≥ 实体 2 倍」强卖，见 ICE_DESC / ICE_REV_DESC / costLinePct）
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

module.exports = {
  buildCycleDeferCheck,
  buildEmoQuickOutCheck,
  buildLimitUpDeferCheck,
  buildOneWordBoardDeferCheck,
  buildQuickOutCrashSellReason,
  buildQuickOutExemptInfo,
  buildQuickOutExemptSuffix,
  buildQuickOutSellReason,
  buildQuickOutStopLossReason,
  buildResilienceGateCheck,
  withResilienceGateInfo,
};
