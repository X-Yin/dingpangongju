const { batchParallel, fs, getMonitorStocks, getSimContext, isSimStock, isStockInWatchlistAt, loadTrainingCampData } = require('../deps');
const { buildKeyBlockSyntheticBucketEntry, buildKeyBlockSyntheticDay } = require('./keyBlockSynthetic');
const { extractDailyInfo } = require('./replayData');
const { stockBlockFilePath } = require('../paths');

// ============================================================
// 候选池科技股过滤（2026-10-12 用户要求）：凡是以「全量自选股」为候选池的策略，只允许自选股中的
// 科技股（isTech !== false）参与选股，非科技股（isTech === false）一律剔除。
// 覆盖候选池出口：pickBestStock 主流水线（N 日涨幅/研报/抗分歧，以及两次买入的选股）。
// 随机模拟注入的合成股票不在自选股清单内 → 天然按科技股处理，不受本过滤影响。
// 集合按 monitor_stocks.json mtime 懒加载缓存，避免回测热循环中逐候选重复读盘。
// ============================================================
let nonTechCodeSetCache = { mtimeMs: -1, set: new Set() };
const getNonTechWatchlistCodeSet = () => {
  try {
    const mtimeMs = fs.statSync(stockBlockFilePath).mtimeMs;
    if (mtimeMs !== nonTechCodeSetCache.mtimeMs) {
      const set = new Set();
      for (const s of getMonitorStocks() || []) {
        if (s && s.code && s.isTech === false) set.add(s.code);
      }
      nonTechCodeSetCache = { mtimeMs, set };
    }
  } catch (e) {
    // 读取失败：沿用上次集合（空集合 = 不拦截任何候选）
  }
  return nonTechCodeSetCache.set;
};

// 该代码是否为自选股中的非科技股（是则不参与选股策略）
const isNonTechWatchlistStock = (code) => getNonTechWatchlistCodeSet().has(code);

const injectSimStocksIntoCampData = async (campData, dateStr) => {
  const sim = getSimContext();
  if (!sim || !Array.isArray(sim.codes) || sim.codes.length === 0) return;
  const buckets = campData?.timeBuckets || [];
  if (buckets.length === 0) return;
  campData.dailyLowByCode = campData.dailyLowByCode || {};

  // 并发构建每只股票当日真实数据（分时/均线/近 3 日抗分歧），单只失败即跳过该股当日
  await batchParallel(sim.codes, async (code) => {
    const name = (sim.nameByCode && sim.nameByCode.get(code)) || code;
    let synth = null;
    try {
      synth = await buildKeyBlockSyntheticDay(code, name, dateStr);
    } catch (e) {
      return;
    }
    if (!synth) return;
    const { sortedPoints, maInfo, r3d } = synth;
    for (const bucket of buckets) {
      const entry = buildKeyBlockSyntheticBucketEntry(code, name, sortedPoints, maInfo, r3d, Number(bucket.minute));
      if (entry) bucket.stockChanges.push(entry);
    }
    campData.dailyLowByCode[code] = maInfo.dailyLowMap || {};
  }, 8);
};

// ============================================================
// 窗口预热（起点一致性）：把回测起始日之前的 needDays 个交易日的 EOD 数据提前加载进 dailyInfos，
// 并返回向前扩展的日期轴 dateAxis = [...预热日, ...rangeDates]（axisOffset = 预热日数）。
// 动机：窗口指标（最近 N 日涨幅/抗分歧）的历史成分来自 dailyInfos（随回测循环逐日填充），
// 窗口切片又受限于 rangeDates——回测起点附近的窗口被起始日截断，导致「同一交易日、不同回测起点」
// 得到不同的窗口指标与选股结果（如 8.3 起点与 8.4 起点在 8.4 9:40 选出不同的股票）。
// 修复后选股函数传入 (dateAxis, di + axisOffset)，窗口切片自然覆盖预热日；
// highest_gain（买入最高涨幅）的窗口语义固定为「回测起始日至当日」，通过 axisOffset 起切保持不变。
// 预热日加载失败时跳过该日（窗口相应变短，与旧行为一致）；预热日不产生任何买卖动作。
// ============================================================
const buildWindowAxis = async (allDates, rangeDates, startDate, needDays, dailyInfos) => {
  const preloadDates = allDates.filter(d => d < startDate).sort().slice(-Math.max(0, needDays));
  const loaded = [];
  for (const d of preloadDates) {
    try {
      const campData = await loadTrainingCampData(d);
      if (campData && campData.success !== false && (campData.timeBuckets || []).length > 0) {
        await injectSimStocksIntoCampData(campData, d); // 随机模拟：预热日同样注入合成股票，保证窗口指标可比
        dailyInfos.set(d, extractDailyInfo(campData, d));
        loaded.push(d);
      }
    } catch { /* 单日预热失败忽略 */ }
  }
  return { dateAxis: [...loaded, ...rangeDates], axisOffset: loaded.length };
};

// 自选股添加时间门禁：随机模拟注入的合成股票不受该门禁约束（它们没有"加入自选股"历史），
// 其余股票沿用真实自选股加入时间校验，防止后加自选股污染历史回测
const passWatchlistGate = (code, dateStr, minute) => isSimStock(code) || isStockInWatchlistAt(code, dateStr, minute);

// 计算个股 MA3 切线正斜率连续天数（从 targetDateStr 倒着数，包括 targetDateStr 本身）
// MA3 切线公式 B：MA3(今日) − MA3(昨日)；avg(i,d) = closes.slice(i, i+d).reduce(...) / d
// closes 是按日期降序的 [{date, close}] 数组，[0] = 目标日，[1] = 前一日，...
// 返回：连续正的天数（含当日）；斜率非正返回 0；数据不足返回 null（调用方保守放行）
const countStockPositiveSlopeDays = (code, targetDateStr, dailyInfos) => {
  if (!dailyInfos) return null;
  const codeStr = String(code);
  const dates = [...dailyInfos.keys()].sort((a, b) => b - a);
  const closes = [];
  for (const d of dates) {
    const info = dailyInfos.get(d)?.get(codeStr);
    if (info?.closePx != null && info.closePx > 0) closes.push({ date: d, close: Number(info.closePx) });
    if (closes.length >= 10) break;
  }
  if (closes.length < 4) return null;
  const avg = (i, d) => closes.slice(i, i + d).reduce((s, v) => s + v.close, 0) / d;
  const slopeToday = avg(0, 3) - avg(1, 3);
  if (!Number.isFinite(slopeToday)) return null;
  if (slopeToday <= 0) return 0;
  let count = 1;
  for (let i = 1; i + 3 <= closes.length; i++) {
    const slope = avg(i, 3) - avg(i + 1, 3);
    if (!Number.isFinite(slope)) break;
    if (slope > 0) count++;
    else break;
    if (count >= 6) break; // 用户关心 ≤4，算到 5 就够了
  }
  return count;
};

module.exports = {
  buildWindowAxis,
  countStockPositiveSlopeDays,
  injectSimStocksIntoCampData,
  isNonTechWatchlistStock,
  passWatchlistGate,
};
