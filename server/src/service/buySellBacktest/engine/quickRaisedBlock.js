// 快进快出类「连续两日冰点」板块内选股（2026-10-23 用户新增，前置限制当日由「资金净流入阈值抬高态」改为「连续两日冰点」，
// 判定见 emoQuick.isTechIceGateOpen：上一交易日 hasIce: true + 当日分时科技情绪 ≤ TECH_ICE_THRESHOLD）：
// 门禁成立时，首次建仓不再从全量自选股中选 N 日涨幅最大者，而是：
//   1) 买点触发后延时 15 分钟，以目标时点（T+15）往前回溯 20 分钟（起点 T−5）计算每个重点板块的区间涨幅差值；
//   2) 只保留 tag 为「中性」/「进攻」的板块（与 key_blocks 页面 /block 的 tag/avgChange 同口径），
//      按区间涨幅差值降序（2026-10-23 用户改：已去掉「成分股数量 × 0.1%」加成）；
//   3) 从差值第 1 名开始逐块检查其成分股与「全量自选科技股 ∩ 该时点已在自选股 ∩ 当桶有行情」的交集，
//      把所有交集非空的板块按差值降序返回（调用方逐个尝试选股：某板块交集内选不出可买标的时顺延下一板块）；
//   4) 交集（作为 pickBestStock 的 restrictCodes 候选池）内仍按 N 日涨幅最大选股。
// 全部板块均无交集 / 均有交集但都选不出 → 返回空数组（调用方回退原逻辑：从全量自选股选 N 日涨幅最大）。
const {
  fs,
  getKeyBlockConstituents,
  getKeyBlockTagMap,
  getMonitorStocks,
  getSimContext,
  isStockInWatchlistAt,
} = require('../deps');
const {
  EMO_QUICK_RAISED_BLOCK_TAGS,
  EXCLUDED_CODES,
  EMO_QUICK_RAISED_BLOCK_DELAY_MIN,
  EMO_QUICK_RAISED_BLOCK_LOOKBACK_MIN,
  EMO_QUICK_ICE_CONFIRM_PCT,
} = require('../constants');
const { BUY_TIME_MAX_MINUTE } = require('../strategies/registry');
const { stockBlockFilePath } = require('../paths');

// 全量自选科技股集合（isTech !== false 且非回测排除股）：按 monitor_stocks.json mtime 缓存，
// 避免回测热循环中逐桶重复读盘（与 engine/pickHelpers.getNonTechWatchlistCodeSet 同样的缓存策略）
let techCodeSetCache = { mtimeMs: -1, set: new Set() };
// 全量自选股集合（不限科技股，重点板块-进攻延迟系列按「与全量自选股重叠」口径使用）
let allCodeSetCache = { mtimeMs: -1, set: new Set() };
const getWatchlistCodeSet = (includeNonTech) => {
  try {
    const mtimeMs = fs.statSync(stockBlockFilePath).mtimeMs;
    const cache = includeNonTech ? allCodeSetCache : techCodeSetCache;
    if (mtimeMs !== cache.mtimeMs) {
      const set = new Set();
      for (const s of getMonitorStocks() || []) {
        if (!s || !s.code) continue;
        if (!includeNonTech && s.isTech === false) continue;
        if (EXCLUDED_CODES.has(s.code)) continue;
        set.add(s.code);
      }
      if (includeNonTech) allCodeSetCache = { mtimeMs, set };
      else techCodeSetCache = { mtimeMs, set };
    }
  } catch (e) {
    // 读取失败：沿用上次集合（空集合 = 解析不到重叠板块，回退原选股逻辑）
  }
  return includeNonTech ? allCodeSetCache.set : techCodeSetCache.set;
};

// 选股板块解析（2026-10-23 用户改）：以目标时点 execBucket（买点 T 后延时 15 分钟）与回溯起点 startBucket
// （目标时点往前 20 分钟，即 T−5）两个桶计算每个板块的区间涨幅差值，按差值降序返回全部「交集非空」的板块候选，
// 由调用方逐个尝试选股（某板块交集内选不出可买标的时顺延下一板块）。
const resolveQuickRaisedBlocks = (execBucket, dateStr, startBucket, opts) => {
  // 板块 tag 白名单可按策略覆盖（默认「中性/进攻」）；useAllWatchlist=true 时交集口径改为「全量自选股」（不限科技股）
  const tags = Array.isArray(opts?.tags) && opts.tags.length > 0 ? opts.tags : EMO_QUICK_RAISED_BLOCK_TAGS;
  const useAllWatchlist = opts?.useAllWatchlist === true;
  // 随机模拟注入的合成股不在板块配置内，保持原有模拟口径（不启用板块限制）
  if (getSimContext()) return [];
  const ranking = execBucket?.blockRanking?.all;
  if (!Array.isArray(ranking) || ranking.length === 0) return [];
  const blocks = getKeyBlockConstituents();
  const tagMap = getKeyBlockTagMap();
  if (!blocks || blocks.size === 0 || !tagMap || tagMap.size === 0) return [];

  const watchCodes = getWatchlistCodeSet(useAllWatchlist);
  if (watchCodes.size === 0) return [];

  // 该买点时点有实时行情的股票（无价/停牌的成分股不参与交集，保证交集内至少有一个可买候选）
  const presentCodes = new Set();
  for (const sc of (execBucket.stockChanges || [])) {
    if (!sc || !sc.code) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    presentCodes.add(sc.code);
  }
  if (presentCodes.size === 0) return [];

  // 回溯起点各板块涨幅（缺失该板块数据时以目标时点涨幅兜底 → 差值按 0 计）
  const startMap = new Map();
  for (const it of ((startBucket && startBucket.blockRanking && startBucket.blockRanking.all) || [])) {
    if (it && it.blockName && Number.isFinite(Number(it.avgChange))) startMap.set(it.blockName, Number(it.avgChange));
  }

  // 仅统计「中性/进攻」板块：按区间涨幅差值降序
  const candidates = [];
  for (const item of ranking) {
    if (!item || !item.blockName) continue;
    const tag = tagMap.get(item.blockName);
    if (!tags.includes(tag)) continue;
    const avgChange = Number(item.avgChange);
    if (!Number.isFinite(avgChange)) continue;
    const startChange = startMap.has(item.blockName) ? startMap.get(item.blockName) : avgChange;
    const delta = Number((avgChange - startChange).toFixed(2));
    candidates.push({ item, tag, avgChange, startChange, delta });
  }
  candidates.sort((a, b) => b.delta - a.delta);

  // rank 仅统计「中性/进攻」板块差值排名，与页面展示的板块排名口径一致；
  // 返回全部交集非空的板块（差值降序），由调用方逐个尝试选股
  const result = [];
  let rank = 0;
  for (const c of candidates) {
    rank += 1;
    const codes = buildBlockCodeSet(c.item.blockName, execBucket, dateStr, { useAllWatchlist, presentCodes });
    if (codes.size === 0) continue;
    result.push({
      blockName: c.item.blockName,
      tag: c.tag,
      avgChange: Number(c.avgChange.toFixed(2)),
      startChange: Number(c.startChange.toFixed(2)),
      delta: c.delta,
      rank,
      overlapCount: codes.size, // 与自选股的交集只数（默认科技股口径；useAllWatchlist 时为全量自选股口径）
      codes,
    });
  }
  return result;
};

// 单个板块在目标桶可买的成分股集合：∩ 自选股（科技股或全量）∩ 目标桶有行情 ∩ 买点时刻已在自选股。
// 供「板块内选股」与「重点板块-进攻延迟」等路径复用
const buildBlockCodeSet = (blockName, execBucket, dateStr, opts) => {
  const codes = new Set();
  if (!blockName || !execBucket) return codes;
  const blocks = getKeyBlockConstituents();
  if (!blocks || blocks.size === 0) return codes;
  const watchCodes = getWatchlistCodeSet(opts?.useAllWatchlist === true);
  if (watchCodes.size === 0) return codes;
  let presentCodes = opts?.presentCodes;
  if (!presentCodes) {
    presentCodes = new Set();
    for (const sc of (execBucket.stockChanges || [])) {
      if (!sc || !sc.code) continue;
      if (sc.lastPx == null || sc.lastPx <= 0) continue;
      presentCodes.add(sc.code);
    }
  }
  if (presentCodes.size === 0) return codes;
  const minute = execBucket.minute;
  for (const m of (blocks.get(blockName) || [])) {
    if (!m || !m.code) continue;
    if (!watchCodes.has(m.code)) continue;
    if (!presentCodes.has(m.code)) continue;
    // 买点时刻尚未加入自选股的股票不计入重叠（与 pickBestStock 的 passWatchlistGate 同口径）
    if (!isStockInWatchlistAt(m.code, dateStr, minute)) continue;
    codes.add(m.code);
  }
  return codes;
};

// 目标时点往前回溯 EMO_QUICK_RAISED_BLOCK_LOOKBACK_MIN 分钟对应的桶：取 minute ≤ 目标分钟中最接近的一个；
// 目标早于当日首个桶时退化为当日首个桶（窗口相应缩短），无桶时返回 null
const resolveRaisedBlockLookbackBucket = (timeBuckets, execMinute) => {
  if (!Array.isArray(timeBuckets) || timeBuckets.length === 0) return null;
  const target = addMinutesHHMM(Number(execMinute), -EMO_QUICK_RAISED_BLOCK_LOOKBACK_MIN);
  let best = null;
  for (const b of timeBuckets) {
    const m = Number(b && b.minute);
    if (!Number.isFinite(m) || m > target) continue;
    if (!best || m > Number(best.minute)) best = b;
  }
  return best || timeBuckets[0];
};

// 板块发酵延时（2026-10-23 用户改）：买点触发后不立刻买入，等待 15 分钟到目标时点再按区间涨幅差值选板块并选股。
// 返回目标分钟（HHMM 整数）；目标落在非法买入时段（午休或 13:30 之后）时返回 null → 本次触发不买。
// 允许买入时段与 pickBestStock 门禁一致：9:30–11:30、13:00–13:30（上界 13:30 见 BUY_TIME_MAX_MINUTE）。
// HHMM 整数加分钟（不能直接 +分钟数：955 + 10 = 965，正确应为 1005）
const addMinutesHHMM = (minute, delta) => {
  const h = Math.floor(minute / 100);
  const mm = minute % 100;
  const total = h * 60 + mm + delta;
  return Math.floor(total / 60) * 100 + (total % 60);
};

const resolveRaisedBlockDelayTarget = (minute) => resolveDelayTargetMinute(minute, EMO_QUICK_RAISED_BLOCK_DELAY_MIN);

// 通用延时目标计算（重点板块-进攻延迟系列 n 可变）：触发分钟 + delayMin，落在非法买入时段返回 null
const resolveDelayTargetMinute = (minute, delayMin) => {
  const m = Number(minute);
  const d = Number(delayMin);
  if (!Number.isFinite(m) || !Number.isFinite(d) || d <= 0) return null;
  const target = addMinutesHHMM(m, d);
  const inMorning = target >= 930 && target <= 1130;
  const inAfternoon = target >= 1300 && target <= BUY_TIME_MAX_MINUTE;
  return inMorning || inAfternoon ? target : null;
};

// 回放桶是否达到延时目标（允许相差一个 5 分钟桶的缺口，但不允许跨过目标 10 分钟以上或超出买入时段上限）
const isRaisedBlockDelayBucket = (minute, targetMinute) => {
  const m = Number(minute);
  if (!Number.isFinite(m)) return false;
  return m >= targetMinute && m <= addMinutesHHMM(targetMinute, 10) && m <= BUY_TIME_MAX_MINUTE;
};

// 延时窗口已过期（目标桶后 10 分钟仍无可用桶 → 放弃本次买入）
const isRaisedBlockDelayExpired = (minute, targetMinute) => {
  const m = Number(minute);
  if (!Number.isFinite(m)) return false;
  return m > addMinutesHHMM(targetMinute, 10);
};

// 冰点转折·涨幅确认窗口（2026-10-30 用户新增）：延时窗口结束桶 targetMinute 往前 15 分钟（含两端）内，
// 各股票出现过的最高当日涨幅（changePct vs 昨收）。返回 Map<code, maxGain>，供确认买入判定使用
const buildIceGainWindowMax = (timeBuckets, targetMinute) => {
  const map = new Map();
  const end = Number(targetMinute);
  if (!Array.isArray(timeBuckets) || !Number.isFinite(end)) return map;
  const start = addMinutesHHMM(end, -EMO_QUICK_RAISED_BLOCK_DELAY_MIN);
  for (const b of timeBuckets) {
    const m = Number(b && b.minute);
    if (!Number.isFinite(m) || m < start || m > end) continue;
    for (const sc of (b.stockChanges || [])) {
      if (!sc || !sc.code || sc.changePct == null) continue;
      const v = Number(sc.changePct);
      if (!Number.isFinite(v)) continue;
      if (!map.has(sc.code) || v > map.get(sc.code)) map.set(sc.code, v);
    }
  }
  return map;
};

// 涨幅确认判定：当前涨幅须超过窗口最高涨幅 + EMO_QUICK_ICE_CONFIRM_PCT 个百分点（8% → 需 > 9%）
const isIceGainConfirmed = (curChangePct, windowMaxGain) => {
  const cur = Number(curChangePct);
  const max = Number(windowMaxGain);
  if (!Number.isFinite(cur) || !Number.isFinite(max)) return false;
  return cur > max + EMO_QUICK_ICE_CONFIRM_PCT;
};

module.exports = {
  addMinutesHHMM,
  buildBlockCodeSet,
  resolveQuickRaisedBlocks,
  resolveRaisedBlockLookbackBucket,
  resolveRaisedBlockDelayTarget,
  resolveDelayTargetMinute,
  isRaisedBlockDelayBucket,
  isRaisedBlockDelayExpired,
  buildIceGainWindowMax,
  isIceGainConfirmed,
};
