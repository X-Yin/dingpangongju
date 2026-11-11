// 一级板块强度分时（盘中口径）
// 与日线口径一致，去掉「30 分钟前成交量占比」：
//   平均涨幅 40 分（±10% 映射）、当日涨停家数 30 分（上限 50 个）、
//   较上一交易日成交量占比变化 30 分（±100% 映射）
// 数据来源：
//   - 个股实时涨幅：全 A 股实时行情（与板块成交量占比同一份快照）
//   - 当日/上一交易日板块成交额占比：复用 block_volume_ratio_intraday.json 最新时点与本地日历史
// 结果写入 data/block_strength_intraday.json，与板块成交量分时同步（每 5 分钟一个时点）
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getASpotFull } = require('./akData');
const { getIntradayData } = require('./blockVolumeRatio');
const {
  loadCategories,
  getPrevDayRatios,
  isLimitUp,
  normalizeCode,
} = require('./blockStrength');

const OUTPUT_FILE = path.resolve(__dirname, '../data/block_strength_intraday.json');

const SCORE_WEIGHTS = { avgChange: 40, limitUp: 30, dayRatio: 30 };
const AVG_CHANGE_RANGE = 10;
const MAX_LIMIT_UP = 50;
const MAX_RATIO_CHANGE_PCT = 100;
const MIN_SPOT_ROWS = 3000;

const readJsonSafe = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fallback;
  }
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// 缺失值保持 null，避免 Number(null)=0 把占比变化算成 -100%
const round2 = (value) => (
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(2))
);

const getStrengthIntradayData = () => {
  const data = readJsonSafe(OUTPUT_FILE, null);
  if (!data || !Array.isArray(data.points)) {
    return { date: '', updatedAt: '', points: [] };
  }
  return data;
};

const saveStrengthPoint = (point) => {
  const today = dayjs().format('YYYYMMDD');
  const existing = getStrengthIntradayData();
  const points = existing.date === today && Array.isArray(existing.points) ? existing.points : [];
  const next = points.filter((item) => String(item.time) !== String(point.time));
  next.push(point);
  next.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const payload = {
    date: today,
    updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    weights: SCORE_WEIGHTS,
    limits: {
      avgChangeRange: AVG_CHANGE_RANGE,
      maxLimitUp: MAX_LIMIT_UP,
      maxRatioChangePct: MAX_RATIO_CHANGE_PCT,
    },
    points: next,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
};

// 计算并写入当前时点的强度分时
// quoteMap: 可选的「代码 → 涨跌幅」映射（来自同花顺全量快照）；
// 传入时直接复用，跳过 akshare 全 A 股实时行情，保证拥挤度刷新在 10s 内完成
const runAndSaveStrengthPoint = async ({ quoteMap: providedQuoteMap } = {}) => {
  const categories = loadCategories();
  if (categories.length === 0) throw new Error('未找到一级板块成分股数据');

  let quoteMap;
  if (providedQuoteMap instanceof Map && providedQuoteMap.size > 0) {
    quoteMap = providedQuoteMap;
  } else {
    const spot = await getASpotFull();
    if (!Array.isArray(spot) || spot.length === 0) {
      throw new Error('全 A 股实时行情数据为空，无法计算板块强度');
    }

    quoteMap = new Map();
    for (const row of spot) {
      const code = normalizeCode(row['代码']);
      const changePct = Number(row['涨跌幅']);
      if (code && Number.isFinite(changePct)) quoteMap.set(code, changePct);
    }
  }
  if (quoteMap.size < MIN_SPOT_ROWS) {
    throw new Error(`全 A 股实时行情不完整（有效 ${quoteMap.size} 只），跳过本次强度计算`);
  }

  const intraday = getIntradayData();
  const latestPoint = intraday.points[intraday.points.length - 1] || null;
  const isToday = intraday.date === dayjs().format('YYYYMMDD');
  const prevDay = getPrevDayRatios(dayjs().format('YYYYMMDD'));

  const rows = categories.map((category) => {
    const matched = [];
    for (const stock of category.stocks) {
      const code = normalizeCode(stock.code);
      const changePct = quoteMap.get(code);
      if (Number.isFinite(changePct)) matched.push({ code, name: stock.name, changePct });
    }

    const avgChange = matched.length > 0
      ? matched.reduce((sum, item) => sum + item.changePct, 0) / matched.length
      : null;
    const avgChangeScore = Number.isFinite(avgChange)
      ? clamp(avgChange / AVG_CHANGE_RANGE, -1, 1) * SCORE_WEIGHTS.avgChange
      : 0;

    const limitUpCount = matched.filter((item) => isLimitUp(item.code, item.name, item.changePct)).length;
    const limitUpScore = clamp(limitUpCount / MAX_LIMIT_UP, 0, 1) * SCORE_WEIGHTS.limitUp;

    const rawTodayRatio = isToday && latestPoint && latestPoint.ratios
      ? latestPoint.ratios[category.name]
      : null;
    const todayRatio = Number.isFinite(Number(rawTodayRatio)) && Number(rawTodayRatio) > 0
      ? Number(rawTodayRatio)
      : null;
    const prevRatio = Number.isFinite(Number(prevDay.ratios[category.name]))
      ? Number(prevDay.ratios[category.name])
      : null;
    let ratioChangePct = null;
    if (Number.isFinite(todayRatio) && Number.isFinite(prevRatio) && prevRatio > 0) {
      ratioChangePct = clamp((todayRatio - prevRatio) / prevRatio * 100, -MAX_RATIO_CHANGE_PCT, MAX_RATIO_CHANGE_PCT);
    }
    const ratioScore = ratioChangePct !== null ? ratioChangePct / MAX_RATIO_CHANGE_PCT * SCORE_WEIGHTS.dayRatio : 0;

    return {
      name: category.name,
      totalScore: round2(avgChangeScore + limitUpScore + ratioScore),
      avgChange: round2(avgChange),
      avgChangeScore: round2(avgChangeScore),
      limitUpCount,
      limitUpScore: round2(limitUpScore),
      todayRatio: round2(todayRatio),
      prevDayRatio: round2(prevRatio),
      prevDayDate: prevDay.dates[category.name] || null,
      ratioChangePct: round2(ratioChangePct),
      ratioScore: round2(ratioScore),
      stockCount: category.stocks.length,
      matchedCount: matched.length,
    };
  });

  const point = {
    time: dayjs().format('HHmmss'),
    blocks: rows.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)),
    stats: {
      spotRows: quoteMap.size,
      ratioTime: isToday && latestPoint ? latestPoint.time : null,
    },
  };
  return saveStrengthPoint(point);
};

exports.SCORE_WEIGHTS = SCORE_WEIGHTS;
exports.OUTPUT_FILE = OUTPUT_FILE;
exports.runAndSaveStrengthPoint = runAndSaveStrengthPoint;
exports.getStrengthIntradayData = getStrengthIntradayData;
