const fs = require('fs');
const path = require('path');
const { getSingleStockData } = require('./stock');
const { getMonitorStocks } = require('./monitorStock');
const { sleep, batchParallel } = require('../utils');
const { useCLS } = require('../config');

const maSlopePath = path.resolve(__dirname, '../data/ma_slope_diagnosis.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const KLINE_LIMIT = 40;

const maSlopeCache = {
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
  }));
};

const calcSlope = (maValue, prevMaValue) => {
  if (maValue == null || prevMaValue == null || prevMaValue === 0) return null;
  const change = maValue - prevMaValue;
  return ((change / prevMaValue) * 100).toFixed(2);
};

const randomDelay = () => 1000 + Math.floor(Math.random() * 1001);

const readPersistedSlope = () => {
  try {
    if (!fs.existsSync(maSlopePath)) return null;
    return JSON.parse(fs.readFileSync(maSlopePath, 'utf-8'));
  } catch (error) {
    console.error('读取均线斜率缓存文件失败:', error.message);
    return null;
  }
};

const persistSlope = (payload) => {
  try {
    fs.writeFileSync(maSlopePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.error('写入均线斜率缓存文件失败:', error.message);
  }
};

const buildSlopeResult = async () => {
  const monitorStocks = getMonitorStocks();
  const stocks = [];
  const errors = [];

  const processStock = async (stock) => {
    try {
      const kline = await getSingleStockData(stock.code, KLINE_LIMIT);
      const maSeries = buildMaSeries(kline);

      if (maSeries.length < 10) {
        errors.push({
          code: stock.code,
          stockName: stock.name,
          blockName: stock.blockName || '',
          reason: 'K 线数据不足 10 个交易日',
        });
      } else {
        const latest = maSeries[maSeries.length - 1];
        const prev = maSeries[maSeries.length - 2];

        const ma3Slope = calcSlope(latest.ma3, prev.ma3);
        const ma5Slope = calcSlope(latest.ma5, prev.ma5);
        const ma10Slope = calcSlope(latest.ma10, prev.ma10);

        stocks.push({
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
          ma3Slope,
          ma5Slope,
          ma10Slope,
        });
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

  const sortedStocks = [...stocks].sort((a, b) => {
    const absA = Math.abs(Number(a.ma5Slope) || 0);
    const absB = Math.abs(Number(b.ma5Slope) || 0);
    return absB - absA;
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    summary: {
      total: monitorStocks.length,
      processed: sortedStocks.length,
      errorCount: errors.length,
      requestMode: '串行拉取，每只间隔 1-2s',
    },
    stocks: sortedStocks,
    errors,
  };

  persistSlope(payload);
  return payload;
};

const getMaSlopeDiagnosis = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && maSlopeCache.data && maSlopeCache.expiresAt > now) {
    return {
      success: true,
      data: {
        ...maSlopeCache.data,
        summary: {
          ...maSlopeCache.data.summary,
          fromCache: true,
        },
      },
    };
  }

  if (!forceRefresh && maSlopeCache.promise) {
    const data = await maSlopeCache.promise;
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

  maSlopeCache.promise = buildSlopeResult();

  try {
    const data = await maSlopeCache.promise;
    maSlopeCache.data = data;
    maSlopeCache.expiresAt = Date.now() + CACHE_TTL_MS;
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
    const persisted = readPersistedSlope();
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
      message: error.message || '均线斜率诊断失败',
    };
  } finally {
    maSlopeCache.promise = null;
  }
};

exports.getMaSlopeDiagnosis = getMaSlopeDiagnosis;