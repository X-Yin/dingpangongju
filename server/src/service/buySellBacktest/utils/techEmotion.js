const { fs } = require('../deps');
const { TECH_INDEX_FILE } = require('../paths');

let techEmotionEmaCache = null;
// force=true 时强制重读文件（盘中调用需拿当日最新的 changeSumResult，回测离线场景用默认缓存即可）
const getTechEmotionEmaMap = (force = false) => {
  if (!force && techEmotionEmaCache) return techEmotionEmaCache;
  const map = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(TECH_INDEX_FILE, 'utf-8'));
    if (Array.isArray(arr)) {
      const chartData = arr
        .filter(x => x && x.date != null && x.changeSumResult != null && !Number.isNaN(Number(x.changeSumResult)))
        .sort((a, b) => a.date - b.date)
        .map(x => ({ date: String(x.date), value: Number(x.changeSumResult) }));
      let prevEma = null;
      for (let i = 0; i < chartData.length; i++) {
        let ema = null;
        if (i >= 2) {
          if (prevEma === null) {
            prevEma = (chartData[i - 2].value + chartData[i - 1].value + chartData[i].value) / 3;
          } else {
            prevEma = 0.5 * chartData[i].value + 0.5 * prevEma;
          }
          ema = prevEma;
        }
        map.set(chartData[i].date, ema);
      }
    }
  } catch (e) { /* 文件缺失/损坏时 map 为空，策略不触发 */ }
  techEmotionEmaCache = map;
  return map;
};

// 当日科技情绪原始分 Map<'YYYYMMDD', changeSumResult>（tech_index.json 每日收盘情绪分，不做 EMA 平滑），
// 供快进快出「-30~-10 温和回升」条件按当日情绪分判定（与 3 日 EMA 条件口径不同）
let techEmotionRawCache = null;
const getTechEmotionRawMap = (force = false) => {
  if (!force && techEmotionRawCache) return techEmotionRawCache;
  const map = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(TECH_INDEX_FILE, 'utf-8'));
    if (Array.isArray(arr)) {
      arr
        .filter(x => x && x.date != null && x.changeSumResult != null && !Number.isNaN(Number(x.changeSumResult)))
        .forEach(x => map.set(String(x.date), Number(x.changeSumResult)));
    }
  } catch (e) { /* 文件缺失/损坏时 map 为空，策略不触发 */ }
  techEmotionRawCache = map;
  return map;
};

// tech_index.json 覆盖的日期（过滤周末重复数据点），供三日情绪均值策略并入回测日期序列，
// 覆盖缺资金快照的交易日（如 20260730）——该系列策略不依赖历史资金/成交量快照
const getTechIndexDates = () => Array.from(getTechEmotionEmaMap().keys()).filter(d => {
  if (!/^\d{8}$/.test(d)) return false;
  const weekday = new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))).getDay();
  return weekday >= 1 && weekday <= 5;
});

// 三日情绪均值尾盘抄底命中检查（买卖点回测专用）：
// 抄底时机固定在尾盘 14:57（与 checkTailDipHit 一致）；
// 命中条件：情绪页「三日均值」EMA 线当日读数 < -60（与前端 sentiment 页曲线同源同算法，用户按该曲线人工盯盘）。
// 注意：EMA 读数基于每日收盘情绪分，属收盘定型值，14:57 触发时视为已基本定型（与用户实际盯盘习惯一致）

module.exports = {
  getTechEmotionEmaMap,
  getTechEmotionRawMap,
  getTechIndexDates,
  techEmotionEmaCache,
  techEmotionRawCache,
};
