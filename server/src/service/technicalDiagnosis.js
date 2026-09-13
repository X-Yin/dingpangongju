const fs = require('fs');
const path = require('path');
const { getSingleStockData } = require('./stock');
const { getMonitorStocks } = require('./monitorStock');
const { sleep, batchParallel } = require('../utils');
const { useCLS } = require('../config');

const technicalDiagnosisPath = path.resolve(__dirname, '../data/technical_diagnosis.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const KLINE_LIMIT = 40;
const TOUCH_LOOKBACK_DAYS = 6;

const CATEGORY_META = [
  {
    key: 'ma3_up',
    label: '沿着 3 日线上行',
    order: 1,
  },
  {
    key: 'ma5_up',
    label: '沿着 5 日线上行',
    order: 2,
  },
  {
    key: 'ma10_up',
    label: '沿着 10 日线上行',
    order: 3,
  },
  {
    key: 'ma20_up',
    label: '沿着 20 日线上行',
    order: 4,
  },
  {
    key: 'under_ma3_above_ma5',
    label: '被 3 日均线压制，但尚未破 5 日均线',
    order: 5,
  },
  {
    key: 'under_ma5_above_ma10',
    label: '被 5 日均线压制，但尚未破 10 日均线',
    order: 6,
  },
  {
    key: 'under_ma10_above_ma20',
    label: '被 10 日均线压制，但尚未破 20 日均线',
    order: 7,
  },
  {
    key: 'under_ma20',
    label: '被 20 日均线压制',
    order: 8,
  },
  {
    key: 'pullback_ma5_reclaim_ma3',
    label: '前期回踩 5 日均线，现在强势站上 3 日均线',
    order: 9,
  },
  {
    key: 'pullback_ma10_reclaim_ma5',
    label: '前期回踩 10 日均线，现在强势站上 5 日均线',
    order: 10,
  },
  {
    key: 'pullback_ma20_reclaim_ma10',
    label: '前期回踩 20 日均线，现在强势站上 10 日均线',
    order: 11,
  },
];

const PRESSURE_CATEGORY_KEYS = new Set([
  'under_ma3_above_ma5',
  'under_ma5_above_ma10',
  'under_ma10_above_ma20',
  'under_ma20',
]);

const categoryMap = CATEGORY_META.reduce((acc, item) => {
  acc[item.key] = item;
  return acc;
}, {});

const technicalDiagnosisCache = {
  expiresAt: 0,
  data: null,
  promise: null,
};

const hasValidNumber = (value) => Number.isFinite(Number(value));

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const average = (values) => {
  if (!Array.isArray(values) || !values.length) return null;
  const total = values.reduce((sum, item) => sum + Number(item), 0);
  return total / values.length;
};

const calcPercentChange = (startValue, endValue) => {
  const start = toNumber(startValue);
  const end = toNumber(endValue);
  if (start == null || end == null || start === 0) return null;
  return ((end - start) / start) * 100;
};

const randomDelay = () => 1000 + Math.floor(Math.random() * 1001);

const calcMovingAverage = (records, index, period) => {
  if (index < period - 1) return null;
  const closes = records.slice(index - period + 1, index + 1).map((item) => toNumber(item.close_px));
  if (closes.some((item) => item == null)) return null;
  return average(closes);
};

const buildMaSeries = (kline = []) => {
  const normalized = [...kline]
    .filter((item) => item && hasValidNumber(item.close_px))
    .sort((a, b) => Number(a.trade_date) - Number(b.trade_date))
    .map((item) => ({
      ...item,
      close_px: Number(item.close_px),
      open_px: Number(item.open_px),
      high_px: Number(item.high_px),
      low_px: Number(item.low_px),
      change: Number(item.change || 0),
    }));

  return normalized.map((item, index) => ({
    ...item,
    ma3: calcMovingAverage(normalized, index, 3),
    ma5: calcMovingAverage(normalized, index, 5),
    ma10: calcMovingAverage(normalized, index, 10),
    ma20: calcMovingAverage(normalized, index, 20),
  }));
};

const getRelativeDistance = (price, maValue) => {
  if (!hasValidNumber(price) || !hasValidNumber(maValue) || Number(maValue) === 0) return Infinity;
  return Math.abs(Number(price) - Number(maValue)) / Number(maValue);
};

const isNearMovingAverage = (price, maValue, threshold = 0.03) => {
  return getRelativeDistance(price, maValue) <= threshold;
};

const isStrongBullishCandle = (latest, prev) => {
  if (!latest || !prev) return false;
  const close = toNumber(latest.close_px);
  const open = toNumber(latest.open_px);
  const prevClose = toNumber(prev.close_px);
  const high = toNumber(latest.high_px);
  const change = toNumber(latest.change) || 0;
  if ([close, open, prevClose, high].some((item) => item == null)) return false;
  return close > open && close > prevClose && close >= high * 0.985 && (change >= 1.5 || close > Number(prev.high_px || 0));
};

const touchedMovingAverage = (day, maKey) => {
  if (!day) return false;
  const maValue = toNumber(day[maKey]);
  const low = toNumber(day.low_px);
  const close = toNumber(day.close_px);
  if ([maValue, low, close].some((item) => item == null) || maValue === 0) return false;
  return low <= maValue * 1.01 && close >= maValue * 0.985;
};

const isMovingAverageRising = (latest, prev, maKey) => {
  const latestMa = toNumber(latest?.[maKey]);
  const prevMa = toNumber(prev?.[maKey]);
  if (latestMa == null || prevMa == null) return false;
  return latestMa >= prevMa;
};

const getPullbackReclaimReason = (series, latest, prev) => {
  const recentWindow = series.slice(-1 - TOUCH_LOOKBACK_DAYS, -1);

  if (isStrongBullishCandle(latest, prev)) {
    if (
      recentWindow.some((day) => touchedMovingAverage(day, 'ma20')) &&
      hasValidNumber(latest.ma10) &&
      latest.close_px > latest.ma10 * 1.005
    ) {
      return {
        key: 'pullback_ma20_reclaim_ma10',
        reason: '近几日回踩 20 日线后，最新一日放量转强并重新站上 10 日线。',
      };
    }

    if (
      recentWindow.some((day) => touchedMovingAverage(day, 'ma10')) &&
      hasValidNumber(latest.ma5) &&
      latest.close_px > latest.ma5 * 1.005
    ) {
      return {
        key: 'pullback_ma10_reclaim_ma5',
        reason: '近几日回踩 10 日线后，最新一日强势反包并重新站上 5 日线。',
      };
    }

    if (
      recentWindow.some((day) => touchedMovingAverage(day, 'ma5')) &&
      hasValidNumber(latest.ma3) &&
      latest.close_px > latest.ma3 * 1.005
    ) {
      return {
        key: 'pullback_ma5_reclaim_ma3',
        reason: '近几日回踩 5 日线后，最新一日强势收阳并重新站上 3 日线。',
      };
    }
  }

  return null;
};

const resolveTrendCategory = (latest, prev) => {
  const maKeys = ['ma3', 'ma5', 'ma10', 'ma20'];

  for (const maKey of maKeys) {
    const maValue = toNumber(latest?.[maKey]);
    if (maValue == null) continue;
    const lineNumber = maKey.replace('ma', '');
    if (
      latest.close_px >= maValue &&
      latest.low_px >= maValue * 0.985 &&
      isMovingAverageRising(latest, prev, maKey) &&
      isNearMovingAverage(latest.close_px, maValue, 0.035)
    ) {
      return {
        key: `ma${lineNumber}_up`,
        reason: `最新收盘价贴近 ${lineNumber} 日线，且均线继续拐头向上。`,
      };
    }
  }

  if (
    hasValidNumber(latest?.ma3) &&
    hasValidNumber(latest?.ma5) &&
    latest.close_px < latest.ma3 &&
    latest.close_px >= latest.ma5 * 0.99
  ) {
    return {
      key: 'under_ma3_above_ma5',
      reason: '短线被 3 日线压制，但收盘仍守在 5 日线附近。',
    };
  }

  if (
    hasValidNumber(latest?.ma5) &&
    hasValidNumber(latest?.ma10) &&
    latest.close_px < latest.ma5 &&
    latest.close_px >= latest.ma10 * 0.99
  ) {
    return {
      key: 'under_ma5_above_ma10',
      reason: '反弹受阻于 5 日线，但趋势仍未跌破 10 日线。',
    };
  }

  if (
    hasValidNumber(latest?.ma10) &&
    hasValidNumber(latest?.ma20) &&
    latest.close_px < latest.ma10 &&
    latest.close_px >= latest.ma20 * 0.99
  ) {
    return {
      key: 'under_ma10_above_ma20',
      reason: '中短期反弹受阻于 10 日线，但 20 日线支撑尚在。',
    };
  }

  if (hasValidNumber(latest?.ma20) && latest.close_px < latest.ma20) {
    return {
      key: 'under_ma20',
      reason: '收盘跌回 20 日线下方，中期趋势仍承压。',
    };
  }

  return null;
};

const fallbackTrendCategory = (latest) => {
  const candidates = [
    { key: 'ma3_up', maValue: toNumber(latest?.ma3), label: '3' },
    { key: 'ma5_up', maValue: toNumber(latest?.ma5), label: '5' },
    { key: 'ma10_up', maValue: toNumber(latest?.ma10), label: '10' },
    { key: 'ma20_up', maValue: toNumber(latest?.ma20), label: '20' },
  ].filter((item) => item.maValue != null && latest.close_px >= item.maValue);

  if (!candidates.length) {
    return {
      key: 'under_ma20',
      reason: '收盘未能站回关键均线之上，暂按 20 日线压制处理。',
    };
  }

  candidates.sort((a, b) => getRelativeDistance(latest.close_px, a.maValue) - getRelativeDistance(latest.close_px, b.maValue));
  const nearest = candidates[0];
  return {
    key: nearest.key,
    reason: `收盘位于主要均线上方，当前更接近 ${nearest.label} 日线运行。`,
  };
};

const classifyStock = (series = []) => {
  if (!Array.isArray(series) || series.length < 20) {
    return {
      key: 'under_ma20',
      reason: 'K 线样本不足 20 个交易日，默认归入 20 日线压制观察。',
    };
  }

  const latest = series[series.length - 1];
  const prev = series[series.length - 2];

  if (!latest || !prev) {
    return {
      key: 'under_ma20',
      reason: '缺少足够的最近两日数据，默认归入 20 日线压制观察。',
    };
  }

  const pullbackReclaim = getPullbackReclaimReason(series, latest, prev);
  if (pullbackReclaim) return pullbackReclaim;

  const trendCategory = resolveTrendCategory(latest, prev);
  if (trendCategory) return trendCategory;

  return fallbackTrendCategory(latest);
};

const matchRecentMomentumFilter = (series = []) => {
  if (!Array.isArray(series) || series.length < 5) return false;

  const latest = series[series.length - 1];
  const startDay = series[series.length - 5];
  const recentFiveDayGain = calcPercentChange(startDay?.close_px, latest?.close_px);
  if (recentFiveDayGain == null || recentFiveDayGain > 15) {
    return false;
  }

  const latestThreeDays = series.slice(-3);
  return latestThreeDays.some((item) => {
    const change = toNumber(item?.change);
    return change != null && change > 6;
  });
};

const formatStockPayload = (stock, series, matched) => {
  const latest = series[series.length - 1] || {};
  const prev = series[series.length - 2] || {};
  const recentFiveDayGain = calcPercentChange(series[series.length - 5]?.close_px, latest.close_px);
  return {
    code: stock.code,
    stockName: stock.name,
    blockName: stock.blockName || '',
    isImportant: !!stock.isImportant,
    tradeDate: latest.trade_date || null,
    close_px: toNumber(latest.close_px),
    change: toNumber(latest.change) || 0,
    ma3: toNumber(latest.ma3),
    ma5: toNumber(latest.ma5),
    ma10: toNumber(latest.ma10),
    ma20: toNumber(latest.ma20),
    prevMa3: toNumber(prev.ma3),
    prevMa5: toNumber(prev.ma5),
    prevMa10: toNumber(prev.ma10),
    recentFiveDayGain: recentFiveDayGain == null ? null : Number(recentFiveDayGain.toFixed(2)),
    reason: matched.reason,
    categoryKey: matched.key,
    categoryLabel: categoryMap[matched.key]?.label || matched.key,
  };
};

const readPersistedDiagnosis = () => {
  try {
    if (!fs.existsSync(technicalDiagnosisPath)) return null;
    return JSON.parse(fs.readFileSync(technicalDiagnosisPath, 'utf-8'));
  } catch (error) {
    console.error('读取技术诊断缓存文件失败:', error.message);
    return null;
  }
};

const persistDiagnosis = (payload) => {
  try {
    fs.writeFileSync(technicalDiagnosisPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.error('写入技术诊断缓存文件失败:', error.message);
  }
};

const buildDiagnosisResult = async () => {
  const monitorStocks = getMonitorStocks();
  const categoryBuckets = CATEGORY_META.reduce((acc, item) => {
    acc[item.key] = [];
    return acc;
  }, {});
  const errors = [];

  const processStock = async (stock) => {
    try {
      const kline = await getSingleStockData(stock.code, KLINE_LIMIT);
      const maSeries = buildMaSeries(kline);

      if (maSeries.length < 20) {
        errors.push({
          code: stock.code,
          stockName: stock.name,
          blockName: stock.blockName || '',
          reason: 'K 线数据不足 20 个交易日',
        });
      } else {
        const matched = classifyStock(maSeries);
        if (!PRESSURE_CATEGORY_KEYS.has(matched.key) && matchRecentMomentumFilter(maSeries)) {
          categoryBuckets[matched.key].push(formatStockPayload(stock, maSeries, matched));
        }
      }
    } catch (error) {
      errors.push({
        code: stock.code,
        stockName: stock.name,
        blockName: stock.blockName || '',
        reason: error.message || 'K 线拉取失败',
      });
    }
  };

  if (useCLS()) {
    for (let index = 0; index < monitorStocks.length; index += 1) {
      await processStock(monitorStocks[index]);
      if (index < monitorStocks.length - 1) {
        await sleep(randomDelay());
      }
    }
  } else {
    await batchParallel(monitorStocks, processStock, 10);
  }

  const categories = CATEGORY_META
    .map((item) => ({
      ...item,
      count: categoryBuckets[item.key].length,
      stocks: categoryBuckets[item.key].sort((a, b) => {
        if (Number(b.isImportant) !== Number(a.isImportant)) {
          return Number(b.isImportant) - Number(a.isImportant);
        }
        return (Number(b.change) || 0) - (Number(a.change) || 0);
      }),
    }))
    .filter((item) => item.count > 0);

  const payload = {
    updatedAt: new Date().toISOString(),
    summary: {
      total: monitorStocks.length,
      classified: categories.reduce((sum, item) => sum + item.count, 0),
      errorCount: errors.length,
      requestMode: '串行拉取，每只间隔 1-2s',
    },
    categories,
    errors,
  };

  persistDiagnosis(payload);
  return payload;
};

const getTechnicalDiagnosis = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && technicalDiagnosisCache.data && technicalDiagnosisCache.expiresAt > now) {
    return {
      success: true,
      data: {
        ...technicalDiagnosisCache.data,
        summary: {
          ...technicalDiagnosisCache.data.summary,
          fromCache: true,
        },
      },
    };
  }

  if (!forceRefresh && technicalDiagnosisCache.promise) {
    const data = await technicalDiagnosisCache.promise;
    return {
      success: true,
      data: {
        ...data,
        summary: {
          ...data.summary,
          fromCache: false,
        },
      },
    };
  }

  technicalDiagnosisCache.promise = buildDiagnosisResult();

  try {
    const data = await technicalDiagnosisCache.promise;
    technicalDiagnosisCache.data = data;
    technicalDiagnosisCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return {
      success: true,
      data: {
        ...data,
        summary: {
          ...data.summary,
          fromCache: false,
        },
      },
    };
  } catch (error) {
    const persisted = readPersistedDiagnosis();
    if (persisted) {
      return {
        success: true,
        data: {
          ...persisted,
          summary: {
            ...persisted.summary,
            fromCache: true,
            stale: true,
          },
        },
      };
    }
    return {
      success: false,
      message: error.message || '技术诊断失败',
    };
  } finally {
    technicalDiagnosisCache.promise = null;
  }
};

exports.getTechnicalDiagnosis = getTechnicalDiagnosis;
