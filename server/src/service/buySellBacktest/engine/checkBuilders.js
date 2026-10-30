const { GLOBAL_RESILIENCE_MIN, RESILIENCE_GATE_MIN, RESILIENCE_GATE_STRATEGY_IDS } = require('../strategies/registry');
const { CYC_CORR_WINDOW, CYC_MIN_CYB_CORR } = require('./cycleFilter');
const {
  EMO_QUICK_CRASH_PCT,
  EMO_QUICK_RAISED_BLOCK_DELAY_MIN,
  EMO_QUICK_RAISED_BLOCK_TAGS,
  EMO_QUICK_RAISED_BLOCK_LOOKBACK_MIN,
  EMO_QUICK_ICE_CONFIRM_PCT,
  TECH_ICE_THRESHOLD,
  EMO_QUICK_RANGE_HIGH,
  EMO_QUICK_RANGE_LOW,
  EMO_SWITCH_EMA_THRESHOLD,
} = require('../constants');
const { runBuyPointDiagnosis } = require('../diagnose/buyPoint');
const { describeCrashSell, fmtMin, pctTxt } = require('./crashSellWindow');

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

// 快进快出类「涨幅领先但当日爆发力不足」顺延明细（2026-10-22 用户新增）：
// 当前候选 N 日涨幅领先第二名 > N 个百分点，且买点时刻抗分歧低于第2~5名抗分歧均值达 N 分时，
// 视为仅靠历史涨幅、当日爆发力不足 → 剔除并顺延，追加 gain_gap_defer 买入明细项
const buildGainGapDeferCheck = (gainGapSkipped) => {
  const skippedStocks = (gainGapSkipped || []).map(s => ({
    code: s.code,
    name: s.name,
    gain: s.gain != null ? Number(s.gain) : null, // N 日窗口涨幅
    gainLead: s.gainLead != null ? Number(s.gainLead) : null, // 领先第二名百分点
    resilience: s.resilience != null ? Number(s.resilience) : null, // 买点时刻抗分歧
    avgResilience: s.avgResilience != null ? Number(s.avgResilience) : null, // 第2~5名抗分歧均值
    diff: s.diff != null ? Number(s.diff) : null, // 均值 − 该股
    threshold: s.threshold != null ? Number(s.threshold) : null,
  }));
  const skipText = skippedStocks
    .map(s => `${s.name}（${s.threshold}日涨幅 ${s.gain != null ? s.gain.toFixed(2) + '%' : '--'}、领先第二名 ${s.gainLead != null ? s.gainLead.toFixed(2) : '--'} 个百分点；抗分歧 ${s.resilience != null ? s.resilience.toFixed(2) : '--'}，低于第2~5名均值 ${s.avgResilience != null ? s.avgResilience.toFixed(2) : '--'} 达 ${s.diff != null ? s.diff.toFixed(2) : '--'} 分）`)
    .join('、');
  return {
    id: 'gain_gap_defer',
    title: '快进快出涨幅领先但当日爆发力不足过滤',
    passed: true,
    value: skippedStocks.length > 0 ? `顺延 ${skippedStocks.length} 只` : '无领先但爆发力不足候选',
    skippedStocks,
    reason: skippedStocks.length > 0
      ? `前序候选 N 日涨幅领先第二名 > N 个百分点、但买点时刻抗分歧低于第2~5名均值达 N 分，已剔除并顺延：${skipText}（该类个股仅历史涨幅大、当日爆发力不强，顺延至排名下一只）`
      : '当前候选未触发「涨幅领先但当日爆发力不足」过滤',
  };
};

// 快进快出类「N 日涨幅接近时按当日抗分歧优先」明细（2026-10-23 用户新增）：
// 按 N 日窗口涨幅排名后，第一名与第二名涨幅相差 ≤ 1 个百分点时，改按买点触发时点的当日抗分歧分数排序，
// 买入抗分歧更高者（两者分数缺失或相等时保持原涨幅排名），买入条件明细追加 gain_tie_break 项
const buildGainTieCheck = (info) => {
  const fmt = v => (v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '--');
  const p = info?.picked || {};
  const d = info?.dropped || {};
  const swapped = info?.swapped === true;
  const detail = `${p.name || p.code}（涨幅 ${fmt(p.gain)}% / 抗分歧 ${fmt(p.resilience)}）优先于 ${d.name || d.code}（涨幅 ${fmt(d.gain)}% / 抗分歧 ${fmt(d.resilience)}）`;
  return {
    id: 'gain_tie_break',
    title: '快进快出N日涨幅接近时按当日抗分歧优先',
    passed: true,
    value: swapped ? '按抗分歧优先调整' : '保持涨幅排名',
    reason: swapped
      ? `第一名与第二名 N 日涨幅相差 ${fmt(info?.gap)} 个百分点（≤ ${info?.threshold}），按买点触发时点的当日抗分歧分数更高者优先：${detail}`
      : `第一名与第二名 N 日涨幅相差 ${fmt(info?.gap)} 个百分点（≤ ${info?.threshold}），但当日抗分歧分数缺失或第一名不低于第二名，保持原涨幅排名：${detail}`,
  };
};

// 快进快出类「连续两日冰点·板块内选股」明细（2026-10-23 用户新增）：
// 上一交易日 hasIce + 当日分时曾触冰时，首次建仓不再从全量自选股中选 N 日涨幅最大者，改为在「中性/进攻」tag 板块中
// 按「区间涨幅差值（目标时点 T+15 往前回溯 20 分钟）」降序逐个尝试：某板块交集内选不出可买标的则顺延下一板块，
// 本次命中的板块追加 raised_block_pick
const buildRaisedBlockCheck = (info) => {
  const fmt = v => (v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '--');
  const chg = info?.avgChange;
  return {
    id: 'raised_block_pick',
    title: `${info?.pulse ? '脉冲最强' : '连续两日冰点'}·改板块内选股（${EMO_QUICK_RAISED_BLOCK_TAGS.join('+')}）`,
    passed: true,
    value: `${info?.blockName || '--'}（区间差值第 ${info?.rank != null ? info.rank : '--'} 名，${fmt(info?.startChange)}%→${chg > 0 ? '+' : ''}${fmt(chg)}%，差值 ${info?.delta != null && info.delta > 0 ? '+' : ''}${fmt(info?.delta)}）`,
    reason: `${info?.pulse
      ? `脉冲最强策略每次买点触发都无条件走板块内选股：本次买入不从全量自选股中选 N 日涨幅最大者`
      : `上一交易日与当日科技情绪均达到冰点（上一交易日 hasIce: true；当日任一分时科技情绪 ≤ ${TECH_ICE_THRESHOLD}）：本次买入不再从全量自选股中选 N 日涨幅最大者`}，改为在「${EMO_QUICK_RAISED_BLOCK_TAGS.join('/')}」tag 板块中，按「目标时点往前回溯 ${EMO_QUICK_RAISED_BLOCK_LOOKBACK_MIN} 分钟的区间涨幅差值」从高到低逐个板块尝试（前序板块交集内均无可买标的时顺延），本次命中板块「${info?.blockName || '--'}」（${fmt(info?.startChange)}% → ${chg > 0 ? '+' : ''}${fmt(chg)}%，差值 ${info?.delta != null && info.delta > 0 ? '+' : ''}${fmt(info?.delta)}，第 ${info?.rank != null ? info.rank : '--'} 名），并仅在该板块与自选科技股交集（${info?.overlapCount != null ? info.overlapCount : '--'} 只）中选 N 日涨幅最大者`,
  };
};

// 快进快出类「连续两日冰点·板块内选股兜底」（2026-10-23 用户新增）：
// 全部「中性/进攻」板块的交集内都选不出可买标的（如抗分歧不足、涨停、一字板等被过滤）→ 回退全量自选股原逻辑
const buildRaisedBlockFallbackCheck = (info) => ({
  id: 'raised_block_fallback',
  title: '板块内均选不出·回退全量自选股',
  passed: true,
  value: `已尝试 ${info?.triedCount != null ? info.triedCount : '--'} 个板块`,
  reason: `${info?.pulse ? '脉冲最强策略' : '连续两日冰点下'}已按区间涨幅差值从高到低尝试 ${info?.triedCount != null ? info.triedCount : '--'} 个「${EMO_QUICK_RAISED_BLOCK_TAGS.join('/')}」tag 板块，但所有板块交集内的股票均被其它选股条件（抗分歧不足/涨停/一字板/逆周期/过热等）剔除、选不出可买标的，回退为原逻辑：从全量自选股中选 N 日涨幅最大者`,
});

// 快进快出类「板块发酵延时」明细（2026-10-23 用户新增）：
// 连续两日冰点下买点触发后不立刻买入，等待 15 分钟（目标桶）再按区间涨幅差值重新选板块与选股，明细追加 raised_block_delay
const buildRaisedBlockDelayCheck = (info) => ({
  id: 'raised_block_delay',
  title: `板块发酵延时 ${EMO_QUICK_RAISED_BLOCK_DELAY_MIN} 分钟`,
  passed: true,
  value: `${info?.triggerTime || '--'} → ${info?.execTime || '--'}`,
  reason: `${info?.pulse
    ? '脉冲最强策略每次买点触发都无条件走板块内选股'
    : `连续两日冰点（上一交易日 hasIce: true 且当日分时科技情绪触及 ${TECH_ICE_THRESHOLD}）下`}买点于 ${info?.triggerTime || '--'} 触发，不立刻买入：延时 ${EMO_QUICK_RAISED_BLOCK_DELAY_MIN} 分钟至 ${info?.execTime || '--'} 桶，并以该时点为终点往前回溯 ${EMO_QUICK_RAISED_BLOCK_LOOKBACK_MIN} 分钟，重新计算「${EMO_QUICK_RAISED_BLOCK_TAGS.join('/')}」tag 板块的区间涨幅差值（给板块发酵时间），再按差值从高到低逐个尝试板块并选 N 日涨幅最大者买入`,
});

// 快进快出类「冰点转折·延时后涨幅确认」明细（2026-10-30 用户新增）：
// 延时 15 分钟到期选好个股后不立即买入，先取该股在延时窗口内的最高当日涨幅，此后每 5min 桶监控，
// 只有当前涨幅超过窗口最高涨幅 + 1 个百分点（8% → > 9%）才允许买入；始终未超过 → 本次不买
const buildIceGainConfirmCheck = (info) => ({
  id: 'raised_block_gain_confirm',
  title: `延时后涨幅确认（须超过窗口最高涨幅 +${EMO_QUICK_ICE_CONFIRM_PCT} 个百分点）`,
  passed: true,
  value: `${info?.confirmTime || '--'} 涨幅 ${info?.confirmGain != null ? Number(info.confirmGain).toFixed(2) : '--'}%（窗口最高 ${info?.windowMaxGain != null ? Number(info.windowMaxGain).toFixed(2) : '--'}%）`,
  reason: `冰点转折延时 ${EMO_QUICK_RAISED_BLOCK_DELAY_MIN} 分钟到期（${info?.triggerTime || '--'} → ${info?.execTime || '--'}）后不立即买入：先取该股在延时窗口内的最高当日涨幅 ${info?.windowMaxGain != null ? Number(info.windowMaxGain).toFixed(2) : '--'}%，随后每隔 5 分钟桶监控，只有当涨幅超过该最高涨幅 +${EMO_QUICK_ICE_CONFIRM_PCT} 个百分点（即 > ${info?.windowMaxGain != null ? (Number(info.windowMaxGain) + EMO_QUICK_ICE_CONFIRM_PCT).toFixed(2) : '--'}%）时才允许买入；本次在 ${info?.confirmTime || '--'} 涨幅 ${info?.confirmGain != null ? Number(info.confirmGain).toFixed(2) : '--'}% 达到确认条件，按该桶价买入`,
});

// 重点板块-进攻延迟 n 分钟：延时窗口资金净流入逐 5min 桶校验明细
const buildAttackDelayWindowCheck = (info) => ({
  id: 'attack_delay_window',
  title: `买点延迟 ${info?.delayMin != null ? info.delayMin : '--'} 分钟：窗口内资金净流入 5min 桶逐桶为正`,
  passed: true,
  value: `${info?.window?.passedCount != null ? info.window.passedCount : '--'} / ${info?.window?.totalCount != null ? info.window.totalCount : '--'} 个 5min 桶通过`,
  reason: `${info?.triggerTime || '--'} 买点触发后不立刻买入，延时 ${info?.delayMin != null ? info.delayMin : '--'} 分钟至 ${info?.execTime || '--'} 桶：${info?.window?.reason || ''}`,
});

// 重点板块-进攻延迟 n 分钟：全量重点板块中 3 日涨幅最大板块明细（前天/昨天/实时涨幅、合成 gain、排名与交集只数）
const buildAttackBlockCheck = (info) => {
  const fmt = v => (v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '--');
  const pct = v => (Number(v) > 0 ? '+' : '') + fmt(v);
  return {
    id: 'attack_block_pick',
    title: '全量重点板块3日涨幅最大·板块内选股',
    passed: true,
    value: `${info?.blockName || '--'}（3 日 ${pct(info?.gain)}% = 前天 ${pct(info?.prev2Change)}% + 昨天 ${pct(info?.prev1Change)}% + 实时 ${pct(info?.todayChange)}%）`,
    reason: `在目标时点对全量重点板块按「最近 3 日涨幅」（前天收盘涨幅 + 昨天收盘涨幅 + 目标桶实时涨幅，复利口径）降序逐个尝试，本次命中「${info?.blockName || '--'}」（3 日涨幅 ${pct(info?.gain)}%，第 ${info?.rank != null ? info.rank : '--'} 名），并仅在该板块成分股与全量自选股交集（${info?.overlapCount != null ? info.overlapCount : '--'} 只）内选最近 3 日涨幅最大者（涨停顺延、抗分歧 ≥ 9）`,
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
      ? `上上个交易日科技情绪 = ${info.prev2Raw != null ? info.prev2Raw : '缺失'}、上一交易日 = ${info.prevRaw != null ? info.prevRaw : '缺失'}（当日原始分，均在 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间且较前日回升），本次买入为快进快出：次日 10:00 强制卖出（不走通用 7 条件卖点；盘中跌破成本线 -2% 时先到先卖止损、盘中当日跌幅较昨收 ≤ -7% 时无条件强卖（竞价低开时先等自救拉升结束的首个回落分钟再卖）；命中强卖豁免——次日 10:00 前买点诊断再次触发，或 10:00 时点科技情绪>0、自选科技股低于开盘价<30只、主力资金净流入>0 三者同时满足——则不强卖、转由通用卖点接管）`
      : `上一交易日科技情绪 3 日 EMA = ${info.ema}（< ${EMO_SWITCH_EMA_THRESHOLD}），本次买入为快进快出：次日 10:00 强制卖出（不走通用 7 条件卖点；盘中跌破成本线 -2% 时先到先卖止损、盘中当日跌幅较昨收 ≤ -7% 时无条件强卖（竞价低开时先等自救拉升结束的首个回落分钟再卖）；命中强卖豁免——次日 10:00 前买点诊断再次触发，或 10:00 时点科技情绪>0、自选科技股低于开盘价<30只、主力资金净流入>0 三者同时满足——则不强卖、转由通用卖点接管）`)
    : `上一交易日科技情绪 3 日 EMA = ${info.ema != null ? info.ema : '缺失'}（不满足 < ${EMO_SWITCH_EMA_THRESHOLD}），上两交易日当日科技情绪 = ${info.prev2Raw != null ? info.prev2Raw : '缺失'} / ${info.prevRaw != null ? info.prevRaw : '缺失'}（不满足均处 ${EMO_QUICK_RANGE_LOW}~${EMO_QUICK_RANGE_HIGH} 区间且回升），普通持仓，走通用 7 条件卖点（快进快出系列全部持仓叠加：盘中当日跌幅较昨收 ≤ -7% 时无条件强卖（竞价低开时先等自救拉升结束的首个回落分钟再卖））`,
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
  return `情绪快进快出：${desc}，触发成本线 -${pct}% 止损（成本线基准 ${Number(buyPrice).toFixed(2)}、阈值 ${threshold.toFixed(2)}，${stopTime} 价 ${Number(stopPt.lastPx).toFixed(2)} 成交），先于当日 10:00 强卖离场`;
};

// 快进快出持仓盘中大跌强卖的 sellReason（2026-10-15 用户新增：当日跌幅较昨收 ≤ EMO_QUICK_CRASH_PCT 时
// 无条件卖出，不受强卖豁免保护，与成本线止损 / 10:00 强卖先到先卖；2026-10-19 叠加竞价低开自救窗口——
// 首个分时点即 ≤ 阈值时改为等待自救拉升结束的首个回落分钟，见 engine/crashSellWindow.js；Inner/Multi 两处共用）
const buildQuickOutCrashSellReason = (crashPt, crashLoc = null) => {
  const detail = crashLoc && crashLoc.pt
    ? describeCrashSell(crashLoc)
    : `${fmtMin(crashPt.minute)} 当日跌幅（较昨收）${pctTxt(crashPt.change)} ≤ ${EMO_QUICK_CRASH_PCT}%`;
  return `情绪快进快出：盘中大跌强卖（${detail}，无条件卖出、不受强卖豁免保护），先于成本线止损与当日 10:00 强卖离场`;
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
  const hasGainGap = Array.isArray(picked.gainGapSkipped) && picked.gainGapSkipped.length > 0;
  const hasGainTie = !!picked.gainTieInfo;
  const hasRaisedBlock = !!picked.raisedBlockInfo;
  const hasRaisedFallback = !!picked.raisedBlockFallbackInfo;
  const hasRaisedDelay = !!picked.raisedBlockDelayInfo;
  const hasIceConfirm = !!picked.iceConfirmInfo;
  const hasAttackDelay = !!picked.attackDelayInfo;
  const hasAttackBlock = !!picked.attackBlockInfo;
  const hasGlobalSkip = Array.isArray(picked.globalResilienceSkipped) && picked.globalResilienceSkipped.length > 0;
  const hasGateSkip = Array.isArray(picked.skipped) && picked.skipped.length > 0;
  // 早返回：既没有分数也没有任何顺延信息，也没有情绪快进快出标注
  if (picked.resilienceScore == null && !picked.emoQuickOut && !hasLimitUp && !hasOneWord && !hasEmoCyc && !hasGainGap && !hasGainTie && !hasRaisedBlock && !hasRaisedFallback && !hasRaisedDelay && !hasIceConfirm && !hasAttackDelay && !hasAttackBlock && !hasGlobalSkip && !hasGateSkip) return buyInfo;
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
  if (hasGainGap) {
    // 快进快出类：涨幅领先但当日爆发力不足顺延 → gain_gap_defer
    buyChecks.push(buildGainGapDeferCheck(picked.gainGapSkipped));
  }
  if (hasGainTie) {
    // 快进快出类：N 日涨幅接近时按当日抗分歧优先 → gain_tie_break
    buyChecks.push(buildGainTieCheck(picked.gainTieInfo));
  }
  if (hasRaisedBlock) {
    // 快进快出类：连续两日冰点改板块内选股 → raised_block_pick
    buyChecks.push(buildRaisedBlockCheck(picked.raisedBlockInfo));
  }
  if (hasRaisedFallback) {
    // 快进快出类：全部板块交集内均选不出 → raised_block_fallback（回退全量自选股）
    buyChecks.push(buildRaisedBlockFallbackCheck(picked.raisedBlockFallbackInfo));
  }
  if (hasRaisedDelay) {
    // 快进快出类：连续两日冰点下买点触发后延时 15 分钟再按区间涨幅差值选板块 → raised_block_delay
    buyChecks.push(buildRaisedBlockDelayCheck(picked.raisedBlockDelayInfo));
  }
  if (hasIceConfirm) {
    // 快进快出类：冰点转折延时到点后须涨幅确认才买入 → raised_block_gain_confirm
    buyChecks.push(buildIceGainConfirmCheck(picked.iceConfirmInfo));
  }
  if (hasAttackDelay) {
    // 重点板块-进攻延迟 n 分钟：延时窗口资金净流入逐 5min 桶校验 → attack_delay_window
    buyChecks.push(buildAttackDelayWindowCheck(picked.attackDelayInfo));
  }
  if (hasAttackBlock) {
    // 重点板块-进攻延迟 n 分钟：命中「3 日涨幅最大」板块 → attack_block_pick
    buyChecks.push(buildAttackBlockCheck(picked.attackBlockInfo));
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
  if (hasGainGap) suffixParts.push('前序股票涨幅领先但当日爆发力不足');
  if (hasGlobalSkip) suffixParts.push(`前序股票买点抗分歧<${GLOBAL_RESILIENCE_MIN}`);
  if (hasGateSkip) suffixParts.push(`前序股票抗分歧<${RESILIENCE_GATE_MIN}`);
  if (suffixParts.length > 0) {
    buyReason = `${buyInfo.buyReason}（因${suffixParts.join('/')}顺延买入）`;
  }
  if (hasRaisedBlock) {
    // 板块内选股：非顺延语义，单独追加标签（明细见 raised_block_pick）
    buyReason = `${buyReason}｜${picked.raisedBlockInfo?.pulse ? '脉冲最强·改板块内选股' : '连续两日冰点·改板块内选股'}`;
  }
  if (hasRaisedFallback) {
    // 板块内均选不出 → 回退全量自选股（明细见 raised_block_fallback）
    buyReason = `${buyReason}｜板块内均选不出，回退全量自选股`;
  }
  if (hasRaisedDelay) {
    // 板块发酵延时：单独追加标签（明细见 raised_block_delay）
    buyReason = `${buyReason}｜买点触发后延时 ${EMO_QUICK_RAISED_BLOCK_DELAY_MIN} 分钟按最新板块涨幅选股（${picked.raisedBlockDelayInfo.triggerTime} → ${picked.raisedBlockDelayInfo.execTime}）`;
  }
  if (hasIceConfirm) {
    // 冰点转折·延时后涨幅确认（明细见 raised_block_gain_confirm）
    buyReason = `${buyReason}｜延时后涨幅 ${picked.iceConfirmInfo.confirmGain != null ? Number(picked.iceConfirmInfo.confirmGain).toFixed(2) : '--'}% 超过窗口最高 ${picked.iceConfirmInfo.windowMaxGain != null ? Number(picked.iceConfirmInfo.windowMaxGain).toFixed(2) : '--'}% +${EMO_QUICK_ICE_CONFIRM_PCT}%（${picked.iceConfirmInfo.confirmTime || '--'} 确认买入）`;
  }
  if (hasAttackDelay) {
    // 重点板块-进攻延迟：单独追加标签（明细见 attack_delay_window）
    buyReason = `${buyReason}｜买点触发后延时 ${picked.attackDelayInfo.delayMin} 分钟、窗口内资金净流入逐 5min 桶为正（${picked.attackDelayInfo.triggerTime} → ${picked.attackDelayInfo.execTime}）`;
  }
  if (hasAttackBlock) {
    // 全量重点板块 3 日涨幅最大选股：单独追加标签（明细见 attack_block_pick）
    buyReason = `${buyReason}｜全量重点板块「${picked.attackBlockInfo.blockName}」3 日涨幅最大·板块内选股`;
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
  buildAttackBlockCheck,
  buildAttackDelayWindowCheck,
  buildCycleDeferCheck,
  buildEmoQuickOutCheck,
  buildGainGapDeferCheck,
  buildGainTieCheck,
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
