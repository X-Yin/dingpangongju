/**
 * 趋势诊断服务
 *
 * 流程：
 *   1. 取全部自选股
 *   2. 拉取每只股票最近 LOOKBACK_DAYS+5 个交易日的 K 线（需保证 MA10 已就绪）
 *   3. 计算 20 个交易日涨幅 = (今日收盘 - 20 日前收盘) / 20 日前收盘 × 100%
 *   4. 按涨幅降序取前 TOP_N 名
 *   5. 在前 TOP_N 中筛出「未跌破 10 日线」者：最新收盘价 > 最新 MA10
 *
 * 返回结构：
 *   { success, data: { totalScanned, totalValid, topGainers: [...], filtered: [...] } }
 */
const { getSingleStockData } = require('./stock');
const { getMonitorStocks } = require('./monitorStock');
const { batchParallel } = require('../utils');
const { useCLS } = require('../config');

const LOOKBACK_DAYS = 20;
const TOP_N = 30;
const KLINE_LIMIT = LOOKBACK_DAYS + 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

const trendCache = {
  expiresAt: 0,
  data: null,
  promise: null,
};

const hasValidNumber = (value) => Number.isFinite(Number(value));

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const round2 = (value) => (value == null ? null : parseFloat(value.toFixed(2)));

/**
 * 计算单只股票的趋势诊断指标
 * K 线按 trade_date 倒序返回（index 0 = 最新）
 */
function computeTrendMetrics(klineData, stock) {
  if (!Array.isArray(klineData) || klineData.length < LOOKBACK_DAYS + 1) {
    return { code: stock.code, stockName: stock.name, error: 'K 线数据不足' };
  }

  const sortedDesc = [...klineData]
    .filter((item) => item && hasValidNumber(item.close_px))
    .sort((a, b) => Number(b.trade_date) - Number(a.trade_date));

  if (sortedDesc.length < LOOKBACK_DAYS + 1) {
    return { code: stock.code, stockName: stock.name, error: '有效 K 线不足' };
  }

  const latest = sortedDesc[0];
  const baseline = sortedDesc[LOOKBACK_DAYS];

  const latestClose = toNumber(latest.close_px);
  const baselineClose = toNumber(baseline.close_px);
  if (latestClose == null || baselineClose == null || baselineClose === 0) {
    return { code: stock.code, stockName: stock.name, error: '收盘价数据缺失' };
  }

  const change20d = parseFloat((((latestClose - baselineClose) / baselineClose) * 100).toFixed(2));
  const todayChange = toNumber(latest.change);
  const ma10 = toNumber(latest.ma10_px);
  const ma5 = toNumber(latest.ma5_px);
  const ma20 = toNumber(latest.ma20_px);

  const aboveMa10 = ma10 != null && latestClose > ma10;

  // 计算最近 10 个交易日内 MA10 斜率均值（百分比/日）
  // 取最近 11 个交易日的 MA10，计算相邻两日的 (curr-prev)/prev*100，取均值
  const recentMa10Slice = sortedDesc.slice(0, 11).reverse(); // 升序：旧 → 新
  const ma10Slopes = [];
  for (let i = 1; i < recentMa10Slice.length; i++) {
    const prevMa10 = toNumber(recentMa10Slice[i - 1].ma10_px);
    const currMa10 = toNumber(recentMa10Slice[i].ma10_px);
    if (prevMa10 != null && currMa10 != null && prevMa10 !== 0) {
      ma10Slopes.push(((currMa10 - prevMa10) / prevMa10) * 100);
    }
  }
  const ma10SlopeAvg = ma10Slopes.length > 0
    ? parseFloat((ma10Slopes.reduce((a, b) => a + b, 0) / ma10Slopes.length).toFixed(4))
    : null;

  return {
    code: stock.code,
    stockName: stock.name,
    close: round2(latestClose),
    change20d,
    todayChange: todayChange != null ? round2(todayChange) : null,
    ma5: round2(ma5),
    ma10: round2(ma10),
    ma20: round2(ma20),
    aboveMa10,
    ma10SlopeAvg,
    tradeDate: latest.trade_date,
  };
}

/**
 * 趋势诊断主入口
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 */
async function diagnoseTrendStocks(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && trendCache.data && trendCache.expiresAt > now) {
    return { success: true, data: trendCache.data, cached: true };
  }

  if (trendCache.promise && !forceRefresh) {
    return { success: true, data: await trendCache.promise, cached: true };
  }

  trendCache.promise = (async () => {
    const monitorStocks = getMonitorStocks();
    if (!monitorStocks.length) {
      const empty = { totalScanned: 0, totalValid: 0, topGainers: [], filtered: [] };
      trendCache.data = empty;
      trendCache.expiresAt = Date.now() + CACHE_TTL_MS;
      return empty;
    }

    const calcOne = async (stock) => {
      try {
        const kline = await getSingleStockData(stock.code, KLINE_LIMIT);
        return computeTrendMetrics(kline, stock);
      } catch (e) {
        return { code: stock.code, stockName: stock.name, error: e.message || '计算失败' };
      }
    };

    const allResults = await batchParallel(monitorStocks, calcOne, useCLS() ? 3 : 10);

    const valid = allResults.filter((r) => r.change20d != null && !r.error);
    const sorted = valid.sort((a, b) => b.change20d - a.change20d);
    const topGainers = sorted.slice(0, TOP_N);

    // 筛选：最新一日收盘价未跌破 MA10（close > ma10）
    const filtered = topGainers.filter((r) => r.aboveMa10);

    const payload = {
      totalScanned: monitorStocks.length,
      totalValid: valid.length,
      lookbackDays: LOOKBACK_DAYS,
      topN: TOP_N,
      topGainers,
      filtered,
      filteredCount: filtered.length,
    };

    trendCache.data = payload;
    trendCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return payload;
  })();

  try {
    const data = await trendCache.promise;
    return { success: true, data, cached: false };
  } finally {
    trendCache.promise = null;
  }
}

module.exports = {
  diagnoseTrendStocks,
};
