// 一级板块强度分析（自定义板块涨幅前十卡片「强度分析」弹窗使用）
// 评分口径（满分 100，涨停家数最低 0 分，其余三项按增减幅度可为负分）：
//   1. 平均涨幅：板块成分股平均涨跌幅，按 [-10%, +10%] 线性映射到 [-30, +30]，占 30 分
//   2. 涨停板个数：区分主板（10% 涨停）/ 创业板·科创板（20% 涨停）/ ST（5% 涨停），
//      以 50 个为满格，占 40 分（最低 0 分）
//   3. 日成交量占比：当日实时占比相对上一交易日占比的增减幅度（相对百分比），
//      范围 [-100%, +100%]，占 20 分，占比降低即为负分
//   4. 30 分钟前占比：当前占比相对 30 分钟前（最早不早于 9:35）占比的增减幅度，
//      范围 [-100%, +100%]，占 20 分，占比降低即为负分；
//      已收盘或非交易日时，取最近一个交易日的 15:00 对比 14:30
// 数据源：
//   - 个股实时涨幅：全 A 股实时行情（东财，失败回退新浪），再兜底同花顺批量行情、财联社日K
//   - 板块成交量占比：复用「板块成交量占比」分时缓存（刷新全部拥挤度接口 /refresh_block_volume_ratio 写入）
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getASpotFull } = require('./akData');
const { getStockQuotes } = require('./themeMonitor');
const { getIntradayData } = require('./blockVolumeRatio');
const { fetchSingleKline } = require('./stockKlinePlatforms');
const { CATEGORY_NAMES } = require('./板块成交量占比计算/category_amount_money');
const { isTradingDay } = require('../utils');

const CONSTITUENTS_DIR = path.resolve(__dirname, '../data/东方财富板块成分股汇总');
const AMOUNT_DAY_HISTORY_FILE = path.resolve(__dirname, '../data/amount_day_history.json');
const CATEGORY_MONEY_FILE = path.resolve(__dirname, './板块成交量占比计算/category_amount_money_result.json');

// 各评分项满分
const SCORE_WEIGHTS = { avgChange: 30, limitUp: 40, dayRatio: 20, ratio30m: 20 };
const AVG_CHANGE_RANGE = 10; // 平均涨幅映射区间 ±10%
const MAX_LIMIT_UP = 50; // 涨停个数满格值
const MAX_RATIO_CHANGE_PCT = 100; // 占比增减幅度上限（100%）
const RATIO_30M_MINUTES = 30; // 对比 30 分钟前
const RATIO_30M_EARLIEST = '093500'; // 最早不早于 9:35（分时点 time 为 6 位 HHmmss）
const MIN_SPOT_ROWS = 3000; // 全 A 股快照完整性下限
const MIN_SPOT_HIT_RATE = 0.9; // 板块成分股行情匹配率下限

const readJsonSafe = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fallback;
  }
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round2 = (value) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null);

const normalizeCode = (code) => String(code || '').trim().replace(/^(sh|sz|bj)/i, '');
const toMarketCode = (code) => {
  const plain = normalizeCode(code);
  if (/^6/.test(plain)) return `sh${plain}`;
  if (/^0|^3/.test(plain)) return `sz${plain}`;
  return null;
};

// 读取全部一级板块成分股（以 东方财富板块成分股汇总/{分类}.json 为准）
const loadCategories = () => CATEGORY_NAMES
  .map((name) => {
    const stocks = readJsonSafe(path.join(CONSTITUENTS_DIR, `${name}.json`), []);
    if (!Array.isArray(stocks) || stocks.length === 0) return null;
    return { name, stocks };
  })
  .filter(Boolean);

// 涨停判定：ST 5%，主板 10%，创业板/科创板 20%（留 0.2% 容差，避免四舍五入误差）
const isLimitUp = (code, name, changePct) => {
  const pct = Number(changePct);
  if (!Number.isFinite(pct)) return false;
  if (/ST/i.test(String(name || ''))) return pct >= 4.8;
  const plain = normalizeCode(code);
  if (/^68/.test(plain) || /^30/.test(plain)) return pct >= 19.8;
  return pct >= 9.8;
};

// 交易分钟（9:30=0，11:30=120，13:00=120，15:00=240），用于跨午休回溯 30 分钟
const toTradingMinute = (time) => {
  const str = String(time || '').padStart(6, '0');
  const hour = Number(str.slice(0, 2));
  const minute = Number(str.slice(2, 4));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const total = hour * 60 + minute;
  if (total <= 11 * 60 + 30) return total - (9 * 60 + 30);
  return 120 + (total - 13 * 60);
};

// 全市场行情 → { code: { changePct, amount } }
const buildQuoteMap = (rows) => {
  const map = new Map();
  for (const row of rows || []) {
    const code = String(row['代码'] || '').trim();
    const changePct = Number(row['涨跌幅']);
    if (!code) continue;
    map.set(code, {
      changePct: Number.isFinite(changePct) ? changePct : null,
      amount: Number(row['成交额']) || 0,
    });
  }
  return map;
};

// 财联社日K兜底：用最近两个收盘价计算涨幅（仅在东财/新浪、同花顺行情都不可用时触发）
const fetchChangeByClsKline = async (codes) => {
  const map = new Map();
  const startDate = dayjs().subtract(10, 'day').format('YYYY-MM-DD');
  let cursor = 0;
  const workers = Array.from({ length: 10 }, async () => {
    while (cursor < codes.length) {
      const code = codes[cursor];
      cursor += 1;
      try {
        const rows = await fetchSingleKline('cls', code, startDate);
        const last = rows[rows.length - 1];
        const prev = rows[rows.length - 2];
        if (last && prev && Number(last.close) > 0 && Number(prev.close) > 0) {
          map.set(code, {
            changePct: (Number(last.close) - Number(prev.close)) / Number(prev.close) * 100,
            amount: Number(last.amount) || 0,
          });
        }
      } catch (e) {
        // 单只失败忽略，按无行情处理
      }
    }
  });
  await Promise.all(workers);
  return map;
};

// 全市场个股行情：东财/新浪 → 同花顺批量 → 财联社日K
const loadSpotQuotes = async (categories) => {
  try {
    const rows = await getASpotFull();
    const map = buildQuoteMap(rows);
    const validCount = Array.from(map.values()).filter((item) => Number.isFinite(item.changePct)).length;
    if (validCount >= MIN_SPOT_ROWS) {
      return { quotes: map, source: 'eastmoney/sina', rowCount: map.size, validCount };
    }
    console.warn(`[blockStrength] 全 A 股行情不完整（有效 ${validCount} 只），尝试同花顺批量行情兜底`);
  } catch (e) {
    console.warn(`[blockStrength] 全 A 股行情获取失败，尝试同花顺批量行情兜底: ${e.message}`);
  }

  const codes = Array.from(new Set(categories.flatMap((category) => category.stocks.map((s) => normalizeCode(s.code))).filter(Boolean)));
  try {
    const marketCodes = codes.map(toMarketCode).filter(Boolean);
    const quotes = await getStockQuotes(marketCodes);
    const map = new Map();
    for (const [marketCode, quote] of Object.entries(quotes || {})) {
      if (quote && Number.isFinite(quote.changePct)) {
        map.set(normalizeCode(marketCode), { changePct: quote.changePct, amount: 0 });
      }
    }
    if (map.size >= codes.length * MIN_SPOT_HIT_RATE) {
      return { quotes: map, source: 'ths', rowCount: map.size, validCount: map.size };
    }
    console.warn(`[blockStrength] 同花顺批量行情覆盖不足（${map.size}/${codes.length}），尝试财联社日K兜底`);
  } catch (e) {
    console.warn(`[blockStrength] 同花顺批量行情失败，尝试财联社日K兜底: ${e.message}`);
  }

  const map = await fetchChangeByClsKline(codes);
  if (map.size === 0) {
    throw new Error('全市场个股行情获取失败（东财/新浪、同花顺、财联社均不可用）');
  }
  return { quotes: map, source: 'cls_kline', rowCount: map.size, validCount: map.size };
};

// 上一交易日各板块成交量占比（%）：板块成交额 / 全市场成交额
const getPrevDayRatios = (todayYmd) => {
  const categoryMoney = readJsonSafe(CATEGORY_MONEY_FILE, {});
  const amountHistory = readJsonSafe(AMOUNT_DAY_HISTORY_FILE, []);
  const totalByDate = new Map();
  for (const item of amountHistory || []) {
    const date = String(item && item.date);
    const total = Number(item && item.totalAmount);
    if (date && Number.isFinite(total) && total > 0) totalByDate.set(date, total);
  }

  const result = {};
  const prevDateByName = {};
  let latestPrevDate = null;
  for (const name of CATEGORY_NAMES) {
    const rows = Array.isArray(categoryMoney[name]) ? categoryMoney[name] : [];
    let prev = null;
    for (const row of rows) {
      const date = String(row && row.date);
      if (!date || date >= todayYmd) continue;
      if (!prev || date > prev.date) prev = { date, money: Number(row.money) };
    }
    if (!prev) continue;
    const totalYi = totalByDate.get(prev.date);
    if (!Number.isFinite(totalYi) || totalYi <= 0 || !Number.isFinite(prev.money)) continue;
    result[name] = (prev.money / (totalYi * 1e8)) * 100;
    prevDateByName[name] = prev.date;
    if (!latestPrevDate || prev.date > latestPrevDate) latestPrevDate = prev.date;
  }
  return { ratios: result, dates: prevDateByName, latestPrevDate };
};

// 取 30 分钟前（最早不早于 9:35）的分时点：按交易分钟回溯，跨午休不按自然时间计算
// basePoint 可选：指定基准点（收盘/非交易日时以最近交易日的 15:00 为基准）
const pickRatio30mPoint = (points, basePoint) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const base = basePoint || points[points.length - 1];
  const baseMinute = toTradingMinute(base.time);
  if (baseMinute === null || baseMinute < 5) return null;

  const targetMinute = Math.max(baseMinute - RATIO_30M_MINUTES, 5);
  let picked = null;
  let pickedMinute = -Infinity;
  for (const point of points) {
    if (String(point.time) < RATIO_30M_EARLIEST) continue;
    if (String(point.time) > String(base.time)) continue;
    const minute = toTradingMinute(point.time);
    if (minute === null || minute > targetMinute) continue;
    if (minute > pickedMinute) {
      picked = point;
      pickedMinute = minute;
    }
  }
  return picked;
};

// 是否已收盘（非交易日、开盘前或 14:59 之后均视为已收盘）
const isMarketClosed = (date = new Date()) => {
  if (!isTradingDay(date)) return true;
  const hour = date.getHours();
  const minute = date.getMinutes();
  return hour < 9
    || (hour === 9 && minute < 15)
    || (hour === 14 && minute >= 59)
    || hour >= 15;
};

const pctChange = (current, base) => {
  const cur = Number(current);
  const prev = Number(base);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return (cur - prev) / prev * 100;
};

const normalizeRatioChange = (value) => {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return clamp(num, -MAX_RATIO_CHANGE_PCT, MAX_RATIO_CHANGE_PCT);
};

const analyzeBlockStrength = async () => {
  const categories = loadCategories();
  if (categories.length === 0) {
    throw new Error('未找到一级板块成分股数据');
  }

  const spot = await loadSpotQuotes(categories);
  const intraday = getIntradayData();
  // 分时缓存本身就是最近一个交易日的时点（未刷新时保留上一交易日数据）
  const points = Array.isArray(intraday.points) ? intraday.points : [];
  const effectiveDate = intraday.date || dayjs().format('YYYYMMDD');
  const closedMode = isMarketClosed();
  // 收盘/非交易日：以最近交易日 15:00 为基准（15:00~15:05 的收盘快照视为 15:00，忽略之后补写的时点）；盘中：取最新时点
  const latestPoint = closedMode
    ? ([...points].filter((point) => String(point.time) <= '150500').pop() || points[points.length - 1] || null)
    : (points[points.length - 1] || null);
  const prevDay = getPrevDayRatios(effectiveDate);
  const ratio30Point = pickRatio30mPoint(points, latestPoint);

  const rows = categories.map(({ name, stocks }) => {
    const matched = [];
    for (const stock of stocks) {
      const code = normalizeCode(stock.code);
      const quote = spot.quotes.get(code);
      if (quote && Number.isFinite(quote.changePct)) {
        matched.push({ code, name: stock.name, changePct: quote.changePct });
      }
    }

    // 1) 平均涨幅（占比 30 分）：涨幅为负时按比例扣分
    const avgChange = matched.length > 0
      ? matched.reduce((sum, item) => sum + item.changePct, 0) / matched.length
      : null;
    const avgChangeScore = Number.isFinite(avgChange)
      ? clamp(avgChange / AVG_CHANGE_RANGE, -1, 1) * SCORE_WEIGHTS.avgChange
      : 0;

    // 2) 涨停板个数（占比 40 分，最低 0 分）；同时保留涨停股明细供前端弹窗展示
    const limitUpStocks = matched
      .filter((item) => isLimitUp(item.code, item.name, item.changePct))
      .map((item) => ({ code: item.code, name: item.name, changePct: round2(item.changePct) }));
    const limitUpCount = limitUpStocks.length;
    const limitUpScore = clamp(limitUpCount / MAX_LIMIT_UP, 0, 1) * SCORE_WEIGHTS.limitUp;

    // 3) 日成交量占比：当日实时占比 vs 上一交易日占比（占比 20 分）：占比降低时按比例扣分
    const todayRatio = latestPoint && latestPoint.ratios ? Number(latestPoint.ratios[name]) : null;
    const prevDayRatio = Number.isFinite(Number(prevDay.ratios[name])) ? Number(prevDay.ratios[name]) : null;
    const dayRatioChangePct = normalizeRatioChange(pctChange(todayRatio, prevDayRatio));
    const dayRatioScore = dayRatioChangePct !== null
      ? (dayRatioChangePct / MAX_RATIO_CHANGE_PCT) * SCORE_WEIGHTS.dayRatio
      : 0;

    // 4) 相较 30 分钟前的占比变化（占比 20 分）：占比降低时按比例扣分
    const ratio30mAgo = ratio30Point && ratio30Point.ratios ? Number(ratio30Point.ratios[name]) : null;
    const ratio30mChangePct = normalizeRatioChange(pctChange(todayRatio, ratio30mAgo));
    const ratio30mScore = ratio30mChangePct !== null
      ? (ratio30mChangePct / MAX_RATIO_CHANGE_PCT) * SCORE_WEIGHTS.ratio30m
      : 0;

    const totalScore = avgChangeScore + limitUpScore + dayRatioScore + ratio30mScore;

    return {
      name,
      stockCount: stocks.length,
      matchedCount: matched.length,
      avgChange: round2(avgChange),
      avgChangeScore: round2(avgChangeScore),
      limitUpCount,
      limitUpStocks,
      limitUpScore: round2(limitUpScore),
      todayRatio: round2(todayRatio),
      prevDayRatio: round2(prevDayRatio),
      prevDayDate: prevDay.dates[name] || null,
      dayRatioChangePct: round2(dayRatioChangePct),
      dayRatioScore: round2(dayRatioScore),
      ratio30mAgo: round2(ratio30mAgo),
      ratio30mTime: ratio30Point ? ratio30Point.time : null,
      ratio30mChangePct: round2(ratio30mChangePct),
      ratio30mScore: round2(ratio30mScore),
      totalScore: round2(totalScore),
    };
  });

  const matchedTotal = rows.reduce((sum, row) => sum + row.matchedCount, 0);
  const stockTotal = rows.reduce((sum, row) => sum + row.stockCount, 0);

  return {
    updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    weights: SCORE_WEIGHTS,
    limits: {
      avgChangeRange: AVG_CHANGE_RANGE,
      maxLimitUp: MAX_LIMIT_UP,
      maxRatioChangePct: MAX_RATIO_CHANGE_PCT,
      ratio30mMinutes: RATIO_30M_MINUTES,
      ratio30mEarliest: '09:35',
    },
    spot: {
      source: spot.source,
      rowCount: spot.rowCount,
      validCount: spot.validCount,
      matchedTotal,
      stockTotal,
      hitRate: stockTotal > 0 ? Number((matchedTotal / stockTotal).toFixed(4)) : 0,
    },
    intraday: {
      date: intraday.date || null,
      latestTime: latestPoint ? latestPoint.time : null,
      ratio30mTime: ratio30Point ? ratio30Point.time : null,
      prevDayDate: prevDay.latestPrevDate,
    },
    rows: rows.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)),
  };
};

exports.analyzeBlockStrength = analyzeBlockStrength;
exports.SCORE_WEIGHTS = SCORE_WEIGHTS;
exports.loadCategories = loadCategories;
exports.loadSpotQuotes = loadSpotQuotes;
exports.getPrevDayRatios = getPrevDayRatios;
exports.isLimitUp = isLimitUp;
exports.buildQuoteMap = buildQuoteMap;
exports.normalizeCode = normalizeCode;
exports.round2 = round2;
