// 重点板块-进攻延迟 n 分钟系列（2026-10-30 用户重构）：
// 买点：在「3日涨幅最大」（highest_3d_gain）的通用买点诊断基础上，买点向后延迟 n 分钟；
//   延迟窗口内每个 5 分钟桶都要求「主力资金净流入的 5min 桶为正」（fundFlow(t) − fundFlow(t−5) > 0），
//   任一桶不满足（含数据缺失）则该次触发作废，不买入（后续买点再次触发时重新校验窗口）。
// 卖点：与「3日涨幅最大」完全一致（通用 7 条件卖点 + 盘中大跌强卖）。
// 选股：在目标时点从「全量重点板块」中找最近 3 日涨幅最大者（前天收盘涨幅 + 昨天收盘涨幅 + 当下实时涨幅，复利口径），
//   在该板块成分股与全量自选股的交集内选最近 3 日涨幅最大的一只（涨停顺延、抗分歧 ≥ 9）；
//   该板块交集内选不出可买标的时按 3 日涨幅降序顺延下一板块（全部选不出则本次不买）。
const { findBucketMinutesAgo } = require('../diagnose/buyPoint');
const { buildBlockCodeSet, resolveDelayTargetMinute } = require('./quickRaisedBlock');
const { loadTrainingCampData } = require('../deps');

// minute（HHMM 整数）转 HH:MM 展示文案
const fmtMinuteText = (m) => {
  const n = Number(m);
  if (!Number.isFinite(n)) return '--:--';
  return `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
};

// 延时目标时点：触发分钟 + n 分钟（落在午休或 13:30 之后返回 null → 本次不买）
const resolveAttackDelayTarget = (minute, delayMin) => resolveDelayTargetMinute(minute, delayMin);

// 延时窗口校验：triggerIndex 之后的每个 5 分钟桶（含目标桶 execIndex）逐桶校验资金净流入增量
const buildAttackDelayWindowCheck = (timeBuckets, triggerIndex, execIndex) => {
  const buckets = timeBuckets || [];
  const tIdx = Number(triggerIndex);
  const eIdx = Number(execIndex);
  if (!Number.isFinite(tIdx) || !Number.isFinite(eIdx) || eIdx <= tIdx || eIdx >= buckets.length) {
    return {
      passed: false,
      totalCount: 0,
      passedCount: 0,
      failures: [{ minute: null, reason: '延时窗口内无可用 5 分钟桶' }],
      reason: '延时窗口内无可用 5 分钟桶，本次买点作废、不买入',
    };
  }
  const failures = [];
  let totalCount = 0;
  let passedCount = 0;
  for (let i = tIdx + 1; i <= eIdx; i++) {
    totalCount += 1;
    const cur = buckets[i];
    const now = Number(cur?.minute);
    const past = findBucketMinutesAgo(buckets, i, 5);
    if (!past) {
      failures.push({ minute: now, reason: '5 分钟前数据不足' });
      continue;
    }
    const fundNow = Number(cur?.fundFlow);
    const fundPast = Number(past.bucket?.fundFlow);
    if (!Number.isFinite(fundNow) || !Number.isFinite(fundPast)) {
      failures.push({ minute: now, reason: '资金数据缺失' });
      continue;
    }
    const fundDiff = parseFloat((fundNow - fundPast).toFixed(2));
    if (!(fundDiff > 0)) {
      failures.push({
        minute: now,
        fundDiff,
        reason: `资金净流入增量 ${fundDiff > 0 ? '+' : ''}${fundDiff.toFixed(2)}亿（非正）`,
      });
      continue;
    }
    passedCount += 1;
  }
  const passed = failures.length === 0 && totalCount > 0;
  const failText = failures.length > 0
    ? `${failures.map(f => fmtMinuteText(f.minute)).join('、')} 桶不满足（${failures.map(f => f.reason).join('；')}）`
    : `窗口内 ${totalCount} 个 5 分钟桶的资金净流入增量均为正`;
  return {
    passed,
    totalCount,
    passedCount,
    failures,
    reason: passed
      ? `${failText}，允许在目标时点买入`
      : `${failText}，本次买点作废、不买入`,
  };
};

// 前一交易日收盘各重点板块涨幅缓存（按日期，进程内复用）：取该日最后一个 5min 桶的 blockRanking
const closeBlockChangeCache = new Map();
const loadCloseBlockChanges = async (dateStr) => {
  if (!dateStr) return null;
  if (closeBlockChangeCache.has(dateStr)) return closeBlockChangeCache.get(dateStr);
  let map = null;
  try {
    const data = await loadTrainingCampData(String(dateStr), { allowMissingFund: true });
    const buckets = (data && data.success && data.timeBuckets) || [];
    const last = buckets[buckets.length - 1];
    const ranking = (last && last.blockRanking && last.blockRanking.all) || [];
    const m = new Map();
    for (const it of ranking) {
      if (!it || !it.blockName) continue;
      const v = Number(it.avgChange);
      if (Number.isFinite(v)) m.set(it.blockName, v);
    }
    if (m.size > 0) map = m;
  } catch (e) {
    map = null;
  }
  closeBlockChangeCache.set(dateStr, map);
  return map;
};

// 多日涨幅复利合成（百分比输入/输出）
const compoundPct = (list) => {
  let prod = 1;
  for (const v of list) prod *= (1 + v / 100);
  return (prod - 1) * 100;
};

// 「全量重点板块」3 日涨幅（前天收盘 + 昨天收盘 + 目标桶实时）降序排列，返回全部「与全量自选股有交集」的
// 板块候选（交集内至少有一只可买成分股），由调用方逐个板块尝试选股：
// [{ blockName, gain, todayChange, prev1Change, prev2Change, gain3dDays, rank, overlapCount, codes }]
const resolveAttackBlocks = async (execBucket, dateStr, prev1Date, prev2Date) => {
  const ranking = (execBucket && execBucket.blockRanking && execBucket.blockRanking.all) || [];
  if (!Array.isArray(ranking) || ranking.length === 0) return [];
  const prev1Map = await loadCloseBlockChanges(prev1Date);
  const prev2Map = await loadCloseBlockChanges(prev2Date);
  const items = [];
  for (const it of ranking) {
    if (!it || !it.blockName) continue;
    const today = Number(it.avgChange);
    if (!Number.isFinite(today)) continue;
    const prev1 = prev1Map && prev1Map.has(it.blockName) ? Number(prev1Map.get(it.blockName)) : null;
    const prev2 = prev2Map && prev2Map.has(it.blockName) ? Number(prev2Map.get(it.blockName)) : null;
    const days = [prev2, prev1, today].filter(v => v != null);
    const gain = Number(compoundPct(days).toFixed(2));
    items.push({ blockName: it.blockName, today, prev1, prev2, gain });
  }
  items.sort((a, b) => b.gain - a.gain);
  // 按 3 日涨幅降序返回全部交集非空的板块（调用方逐个尝试选股：某板块交集内选不出可买标的时顺延下一板块）；
  // 全部板块均无可买成分股则本次不买（不回退全量自选股）
  const result = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const codes = buildBlockCodeSet(it.blockName, execBucket, dateStr, { useAllWatchlist: true });
    if (codes.size === 0) continue;
    result.push({
      blockName: it.blockName,
      gain: it.gain,
      todayChange: Number(it.today.toFixed(2)),
      prev1Change: it.prev1 != null ? Number(it.prev1.toFixed(2)) : null,
      prev2Change: it.prev2 != null ? Number(it.prev2.toFixed(2)) : null,
      gain3dDays: [it.prev2, it.prev1, it.today].filter(v => v != null).length,
      rank: i + 1,
      overlapCount: codes.size,
      codes,
    });
  }
  return result;
};

module.exports = {
  buildAttackDelayWindowCheck,
  resolveAttackBlocks,
  resolveAttackDelayTarget,
  fmtMinuteText,
};
