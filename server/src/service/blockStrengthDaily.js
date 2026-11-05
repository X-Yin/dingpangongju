// 一级板块日强度（收盘日线口径）
// 与 dingpan 的盘中强度不同，日线口径不含「30 分钟前成交量占比」：
//   1. 板块平均涨幅：40 分，[-10%, +10%] 线性映射到 [-40, +40]
//   2. 当日涨停股票个数：30 分，以 50 个为满格（最低 0 分）
//   3. 较上一交易日成交量占比变化：30 分，占比增减幅度 [-100%, +100%] 对应 [-30, +30]
// 数据源：
//   - 板块成交额历史：service/板块成交量占比计算/category_amount_money_result.json
//   - 大盘成交额历史：data/amount_day_history.json
//   - 个股日K：同花顺（失败回退财联社），用于回溯每日涨幅与涨停家数
// 结果写入 data/block_strength_daily.json，供 key_blocks「板块强度」tab 使用
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { CATEGORY_NAMES } = require('./板块成交量占比计算/category_amount_money');
const { fetchSingleKline } = require('./stockKlinePlatforms');
const { getIntradayData } = require('./blockVolumeRatio');
const {
  loadCategories,
  loadSpotQuotes,
  getPrevDayRatios,
  isLimitUp,
  normalizeCode,
} = require('./blockStrength');
const { resolveAnalysisDate } = require('../utils');

const OUTPUT_FILE = path.resolve(__dirname, '../data/block_strength_daily.json');
const CATEGORY_MONEY_FILE = path.resolve(__dirname, './板块成交量占比计算/category_amount_money_result.json');
const AMOUNT_DAY_HISTORY_FILE = path.resolve(__dirname, '../data/amount_day_history.json');

const SCORE_WEIGHTS = { avgChange: 40, limitUp: 30, dayRatio: 30 };
const AVG_CHANGE_RANGE = 10;
const MAX_LIMIT_UP = 50;
const MAX_RATIO_CHANGE_PCT = 100;
const DEFAULT_BACKFILL_DAYS = 30;
const FETCH_CONCURRENCY = 12;

const readJsonSafe = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fallback;
  }
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// 注意：与 blockStrength.round2 不同，这里对 null/undefined 保持 null，避免缺失占比被记成 0 分
const round2 = (value) => (
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(2))
);

// 读取大盘每日成交额（亿）→ Map(YYYYMMDD → 亿)
const loadMarketTotals = () => {
  const list = readJsonSafe(AMOUNT_DAY_HISTORY_FILE, []);
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    const date = String(item && item.date);
    const total = Number(item && item.totalAmount);
    if (date && Number.isFinite(total) && total > 0) map.set(date, total);
  }
  return map;
};

// 读取各板块每日成交额（元）→ Map(name → Map(date → 元))
const loadCategoryMoney = () => {
  const data = readJsonSafe(CATEGORY_MONEY_FILE, {});
  const map = new Map();
  for (const name of CATEGORY_NAMES) {
    const rows = Array.isArray(data[name]) ? data[name] : [];
    const byDate = new Map();
    for (const row of rows) {
      const date = String(row && row.date);
      const money = Number(row && row.money);
      if (date && Number.isFinite(money) && money > 0) byDate.set(date, money);
    }
    map.set(name, byDate);
  }
  return map;
};

// 全部可用交易日（以各板块成交额历史日期并集为准），按升序返回
const getAvailableDates = (categoryMoney, limit) => {
  const dates = new Set();
  for (const byDate of categoryMoney.values()) {
    for (const date of byDate.keys()) dates.add(date);
  }
  const sorted = Array.from(dates).sort();
  return limit && limit > 0 ? sorted.slice(-limit) : sorted;
};

// 某板块在指定日期的成交量占比（%）
const getBlockRatio = (name, date, categoryMoney, marketTotals) => {
  const money = categoryMoney.get(name)?.get(date);
  const totalYi = marketTotals.get(date);
  if (!Number.isFinite(money) || !Number.isFinite(totalYi) || totalYi <= 0) return null;
  return money / (totalYi * 1e8) * 100;
};

// 计算某日某板块的强度分项（quoteMap: code → changePct）
const scoreBlockOnDate = (category, date, prevDate, categoryMoney, marketTotals, quoteMap) => {
  const matched = [];
  for (const stock of category.stocks) {
    const code = normalizeCode(stock.code);
    const changePct = quoteMap.get(code);
    if (Number.isFinite(changePct)) {
      matched.push({ code, name: stock.name, changePct });
    }
  }

  const avgChange = matched.length > 0
    ? matched.reduce((sum, item) => sum + item.changePct, 0) / matched.length
    : null;
  const avgChangeScore = Number.isFinite(avgChange)
    ? clamp(avgChange / AVG_CHANGE_RANGE, -1, 1) * SCORE_WEIGHTS.avgChange
    : 0;

  const limitUpCount = matched.filter((item) => isLimitUp(item.code, item.name, item.changePct)).length;
  const limitUpScore = clamp(limitUpCount / MAX_LIMIT_UP, 0, 1) * SCORE_WEIGHTS.limitUp;

  const ratio = getBlockRatio(category.name, date, categoryMoney, marketTotals);
  const prevRatio = prevDate ? getBlockRatio(category.name, prevDate, categoryMoney, marketTotals) : null;
  let ratioChangePct = null;
  if (Number.isFinite(ratio) && Number.isFinite(prevRatio) && prevRatio > 0) {
    ratioChangePct = clamp((ratio - prevRatio) / prevRatio * 100, -MAX_RATIO_CHANGE_PCT, MAX_RATIO_CHANGE_PCT);
  }
  const ratioScore = ratioChangePct !== null ? ratioChangePct / MAX_RATIO_CHANGE_PCT * SCORE_WEIGHTS.dayRatio : 0;

  return {
    date,
    totalScore: round2(avgChangeScore + limitUpScore + ratioScore),
    avgChange: round2(avgChange),
    avgChangeScore: round2(avgChangeScore),
    limitUpCount,
    limitUpScore: round2(limitUpScore),
    ratio: round2(ratio),
    prevRatio: round2(prevRatio),
    prevDate: prevDate || null,
    ratioChangePct: round2(ratioChangePct),
    ratioScore: round2(ratioScore),
    stockCount: category.stocks.length,
    matchedCount: matched.length,
  };
};

// 把某一天的强度行合并进按板块的历史序列（跳过缺失板块名的脏数据行）
const mergeRowsIntoBlocks = (blocks, date, rows) => {
  const byName = new Map(blocks.filter((block) => block.name).map((block) => [block.name, block]));
  for (const row of rows) {
    if (!row.name) continue;
    let block = byName.get(row.name);
    if (!block) {
      block = { name: row.name, points: [] };
      byName.set(row.name, block);
      blocks.push(block);
    }
    block.points = block.points.filter((point) => String(point.date) !== String(date));
    block.points.push({
      date,
      totalScore: row.totalScore,
      avgChange: row.avgChange,
      avgChangeScore: row.avgChangeScore,
      limitUpCount: row.limitUpCount,
      limitUpScore: row.limitUpScore,
      ratio: row.ratio,
      prevRatio: row.prevRatio,
      prevDate: row.prevDate,
      ratioChangePct: row.ratioChangePct,
      ratioScore: row.ratioScore,
      stockCount: row.stockCount,
      matchedCount: row.matchedCount,
    });
    block.points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }
  return blocks;
};

const buildPayload = (blocks, extra = {}) => ({
  updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  weights: SCORE_WEIGHTS,
  limits: {
    avgChangeRange: AVG_CHANGE_RANGE,
    maxLimitUp: MAX_LIMIT_UP,
    maxRatioChangePct: MAX_RATIO_CHANGE_PCT,
  },
  ...extra,
  blocks: blocks
    .filter((block) => block && block.name)
    .map((block) => ({
      ...block,
      latest: block.points[block.points.length - 1] || null,
    }))
    .sort((a, b) => (b.latest?.totalScore ?? -999) - (a.latest?.totalScore ?? -999)),
});

const savePayload = (payload) => {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
};

// 并发拉取个股日K，返回 Map(code → rows)，auto 路由会随机主源 + 兜底
const fetchAllKlines = async (codes, startDate, onProgress) => {
  const result = new Map();
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < codes.length) {
      const index = cursor;
      cursor += 1;
      const code = codes[index];
      let rows = [];
      try {
        // 'auto'：CLS 60% / THS 40% 加权随机主源，失败自动兜底另一源
        rows = await fetchSingleKline('auto', code, startDate);
      } catch (e) {
        rows = [];
      }
      if (Array.isArray(rows) && rows.length > 0) result.set(code, rows);
      done += 1;
      if (onProgress) onProgress(done, codes.length, code);
    }
  };

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, codes.length) }, () => worker()));
  return result;
};

// 用日K构建 code → Map(date → 当日涨跌幅)
const buildDailyChangeMap = (klines) => {
  const map = new Map();
  for (const [code, rows] of klines.entries()) {
    const byDate = new Map();
    for (let i = 1; i < rows.length; i += 1) {
      const cur = rows[i];
      const prev = rows[i - 1];
      const close = Number(cur && cur.close);
      const prevClose = Number(prev && prev.close);
      if (!cur || !prev) continue;
      if (!Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose <= 0) continue;
      byDate.set(String(cur.date), (close - prevClose) / prevClose * 100);
    }
    map.set(code, byDate);
  }
  return map;
};

const buildQuoteMapForDate = (categories, dailyChangeMap, date) => {
  const quoteMap = new Map();
  for (const category of categories) {
    for (const stock of category.stocks) {
      const code = normalizeCode(stock.code);
      if (quoteMap.has(code)) continue;
      const changePct = dailyChangeMap.get(code)?.get(date);
      if (Number.isFinite(changePct)) quoteMap.set(code, changePct);
    }
  }
  return quoteMap;
};

// 回溯最近 N 个交易日的板块强度（逐日拉取个股日K）
const backfillDailyStrength = async ({ days = DEFAULT_BACKFILL_DAYS, onProgress } = {}) => {
  const categories = loadCategories();
  if (categories.length === 0) throw new Error('未找到一级板块成分股数据');

  const categoryMoney = loadCategoryMoney();
  const marketTotals = loadMarketTotals();
  const allDates = getAvailableDates(categoryMoney, 0).filter((date) => date <= dayjs().format('YYYYMMDD'));
  const targetDates = allDates.slice(-days);
  if (targetDates.length === 0) throw new Error('没有可用的板块成交额历史日期');

  const codes = Array.from(new Set(categories.flatMap((category) => category.stocks.map((s) => normalizeCode(s.code))).filter(Boolean)));
  // 多取 25 个自然日，保证首日也能拿到前收盘价
  const startDate = dayjs(targetDates[0], 'YYYYMMDD').subtract(25, 'day').format('YYYY-MM-DD');
  console.log(`[blockStrengthDaily] 回溯 ${targetDates.length} 个交易日，拉取 ${codes.length} 只股票日K（${startDate} 起）...`);

  const klines = await fetchAllKlines(codes, startDate, onProgress);
  const dailyChangeMap = buildDailyChangeMap(klines);
  console.log(`[blockStrengthDaily] 日K拉取完成：${klines.size}/${codes.length} 只有效`);

  const blocks = [];
  targetDates.forEach((date, index) => {
    const prevDate = targetDates[index - 1] || null;
    const quoteMap = buildQuoteMapForDate(categories, dailyChangeMap, date);
    const rows = categories.map((category) => ({
      name: category.name,
      ...scoreBlockOnDate(category, date, prevDate, categoryMoney, marketTotals, quoteMap),
    }));
    mergeRowsIntoBlocks(blocks, date, rows);
  });

  const payload = buildPayload(blocks, {
    source: 'kline_backfill',
    fromDate: targetDates[0],
    toDate: targetDates[targetDates.length - 1],
    stockTotal: codes.length,
    stockMatched: klines.size,
  });
  return savePayload(payload);
};

// 收盘后（15:01）用实时/收盘行情更新当日强度，避免每天重新拉取 4000+ 只日K
// 目标日取「最新交易日」（非交易日/开盘前自动回退到上一交易日），周末手动补算时也能写入正确日期
const updateLatestDailyFromSpot = async () => {
  const categories = loadCategories();
  if (categories.length === 0) throw new Error('未找到一级板块成分股数据');

  const spot = await loadSpotQuotes(categories);
  const today = dayjs(resolveAnalysisDate()).format('YYYYMMDD');
  const categoryMoney = loadCategoryMoney();
  const marketTotals = loadMarketTotals();
  const prevDay = getPrevDayRatios(today);

  const existing = readJsonSafe(OUTPUT_FILE, null);
  const blocks = existing && Array.isArray(existing.blocks) ? existing.blocks : [];

  const quoteMap = new Map();
  for (const [code, quote] of spot.quotes.entries()) {
    if (Number.isFinite(quote.changePct)) quoteMap.set(code, quote.changePct);
  }

  const intraday = getIntradayData();
  const latestPoint = intraday.date === today ? (intraday.points[intraday.points.length - 1] || null) : null;

  const rows = categories.map((category) => {
    const row = scoreBlockOnDate(category, today, null, categoryMoney, marketTotals, quoteMap);
    // 当日占比优先取本地成交额历史，缺失时用分时缓存的最新占比
    const rawTodayRatio = Number.isFinite(row.ratio)
      ? row.ratio
      : Number(latestPoint && latestPoint.ratios ? latestPoint.ratios[category.name] : null);
    const todayRatio = Number.isFinite(rawTodayRatio) && rawTodayRatio > 0 ? rawTodayRatio : null;
    const prevRatio = Number.isFinite(Number(prevDay.ratios[category.name]))
      ? Number(prevDay.ratios[category.name])
      : row.prevRatio;
    let ratioChangePct = null;
    if (Number.isFinite(todayRatio) && Number.isFinite(prevRatio) && prevRatio > 0) {
      ratioChangePct = clamp((todayRatio - prevRatio) / prevRatio * 100, -MAX_RATIO_CHANGE_PCT, MAX_RATIO_CHANGE_PCT);
    }
    return {
      name: category.name,
      ...row,
      ratio: round2(todayRatio),
      prevRatio: round2(prevRatio),
      prevDate: prevDay.dates[category.name] || null,
      ratioChangePct: round2(ratioChangePct),
      ratioScore: round2(ratioChangePct !== null ? ratioChangePct / MAX_RATIO_CHANGE_PCT * SCORE_WEIGHTS.dayRatio : 0),
      totalScore: round2((row.avgChangeScore || 0) + (row.limitUpScore || 0)
        + (ratioChangePct !== null ? ratioChangePct / MAX_RATIO_CHANGE_PCT * SCORE_WEIGHTS.dayRatio : 0)),
    };
  });

  mergeRowsIntoBlocks(blocks, today, rows);
  const payload = buildPayload(blocks, {
    source: 'spot_close',
    spot: {
      source: spot.source,
      rowCount: spot.rowCount,
      validCount: spot.validCount,
    },
  });
  return savePayload(payload);
};

const getDailyStrengthHistory = () => {
  const data = readJsonSafe(OUTPUT_FILE, null);
  if (!data || !Array.isArray(data.blocks)) {
    return { updatedAt: null, weights: SCORE_WEIGHTS, blocks: [] };
  }
  return data;
};

// 缓存中已有的最新数据日期（取所有板块强度点的最大日期）
const getLatestCachedDate = () => {
  let latest = null;
  for (const block of (getDailyStrengthHistory().blocks || [])) {
    for (const point of (block.points || [])) {
      const date = String(point.date);
      if (date && (!latest || date > latest)) latest = date;
    }
  }
  return latest;
};

// 确保缓存中有最新交易日的日线强度：已有则跳过，缺失则立即计算并写入缓存
const ensureLatestTradingDayData = async () => {
  const targetDate = dayjs(resolveAnalysisDate()).format('YYYYMMDD');
  if (getLatestCachedDate() === targetDate) {
    return { refreshed: false, date: targetDate };
  }
  await updateLatestDailyFromSpot();
  return { refreshed: true, date: targetDate };
};

exports.SCORE_WEIGHTS = SCORE_WEIGHTS;
exports.OUTPUT_FILE = OUTPUT_FILE;
exports.backfillDailyStrength = backfillDailyStrength;
exports.updateLatestDailyFromSpot = updateLatestDailyFromSpot;
exports.getDailyStrengthHistory = getDailyStrengthHistory;
exports.getAvailableDates = getAvailableDates;
exports.ensureLatestTradingDayData = ensureLatestTradingDayData;
