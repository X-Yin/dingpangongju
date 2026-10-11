const { getKeyBlockConstituents, getKeyBlockTagMap, getMonitorStocks } = require('../deps');
const { EMO_QUICK_RANGE_HIGH, EMO_QUICK_RANGE_LOW, EMO_SWITCH_EMA_THRESHOLD, EXCLUDED_CODES } = require('../constants');
const { getTechEmotionEmaMap, getTechEmotionRawMap } = require('../utils/techEmotion');

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
  const { getMonitorStocks } = require('../../monitorStock');
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

module.exports = {
  TECH_TOP3_BLOCK_N,
  buildTechTop3BlockCodeSet,
  computeEmoQuickOutInfo,
  techTop3BlockCache,
};
