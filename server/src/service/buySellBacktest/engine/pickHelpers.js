const { batchParallel, getSimContext, isOscExcluded, isSimStock, isStockInWatchlistAt, loadTrainingCampData } = require('../deps');
const { buildKeyBlockSyntheticBucketEntry, buildKeyBlockSyntheticDay } = require('./keyBlockSynthetic');
const { calcResilienceAtMinute, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { EXCLUDED_CODES } = require('../constants');
const { cycCorrCache } = require('./cycleFilter');

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

// 抗分歧弱转强选股：取最近 4 个交易日（最后一位为当日，用盘中过滤后的抗分歧分数）每只股票的抗分歧分数，
// 先筛选出「买点触发时抗分歧分数 > 11」的股票，再从中计算「前两天均值」与「后两天均值」（第 3 天+当日，即最近两天）的差值
// diff = 后两天均值 - 前两天均值。diff 越大代表抗分歧由弱转强越明显，选 diff 最大的一只；diff 相同（弱转强过程一致）时，取当日盘中涨幅最大的一只。
const pickWeakToStrongStock = (bucket, rangeDates, di, replayStocks, dailyInfos, prevOneWordSet = null, emoCycSet = null) => {
  const winDates = rangeDates.slice(Math.max(0, di - 3), di + 1); // 最近 4 个交易日
  if (winDates.length < 4) return null; // 4 日窗口不足，不构成弱转强
  const emoCycSkipped = [];
  let best = null; // { sc, diff, gain }
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (isOscExcluded(sc.code)) continue; // 震荡测试：勾选隐藏的股票不参与选股
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!passWatchlistGate(sc.code, rangeDates[di], bucket.minute)) continue;
    // 涨停顺延：买点触发时点已涨停的股票无法成交，不参与优选
    if (isLimitUpAtBuy(sc.code, sc.changePct)) continue;
    // 上一交易日一字板过滤（全策略通用）：昨日一字板的候选次日不买，不参与优选
    if (prevOneWordSet && prevOneWordSet.size > 0 && prevOneWordSet.has(sc.code)) continue;
    // 顺/逆周期过滤：逆周期（与创业板指负相关/零相关）候选剔除并顺延（由循环自然改选下一最优）
    if (emoCycSet && emoCycSet.size > 0 && emoCycSet.has(sc.code)) {
      emoCycSkipped.push({ code: sc.code, name: sc.name || sc.code, change: sc.changePct != null ? Number(sc.changePct) : null, corr: cycCorrCache.get(`${sc.code}_${rangeDates[di]}`) });
      continue;
    }
    const scores = [];
    for (let i = 0; i < winDates.length; i++) {
      let r;
      if (i === winDates.length - 1) {
        // 当日：用当前分钟的日内抗分歧分数
        r = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      } else {
        r = dailyInfos.get(winDates[i])?.get(sc.code)?.resilience;
      }
      if (r == null || !Number.isFinite(r)) {
        scores.length = 0;
        break;
      }
      scores.push(Number(r));
    }
    if (scores.length < 4) continue;
    if (!(scores[3] > 11)) continue; // 买点触发时当日抗分歧分数需 > 11 才参与弱转强优选
    const first2Avg = (scores[0] + scores[1]) / 2; // 前两天均值
    const last2Avg = (scores[2] + scores[3]) / 2; // 最近两天均值（含当日）
    const diff = last2Avg - first2Avg;
    const gain = sc.changePct != null ? Number(sc.changePct) : -Infinity;
    if (!best || diff > best.diff + 1e-9 || (Math.abs(diff - best.diff) <= 1e-9 && gain > best.gain)) {
      best = { sc, diff, gain };
    }
  }
  if (!best) return null;
  return { stock: best.sc, metric: parseFloat(best.diff.toFixed(4)), emoCycSkipped };
};

// 计算 N 日线斜率角度：以「N 日涨幅均线」为观测线（用涨幅替代价格，消除不同股票价格差异）
// avgRet(d) = 近 N 个交易日涨幅均值，今日涨幅用当前盘中涨幅（避免未来数据），其余用历史 EOD 涨幅
// 斜率Δ（每日变化，% / 天）= avgRet(今日) - avgRet(昨日)
// 角度（度）= atan(Δ) * 180 / π；取当日角度最大（即线最陡峭）的股票买入
const computeMaSlopeAngle = (code, days, di, rangeDates, dailyInfos, todayIntradayChange) => {
  if (!days || todayIntradayChange == null || !Number.isFinite(Number(todayIntradayChange))) return null;
  if (di < days) return null; // 历史日不足，无法得到「昨日N日涨幅均线」
  // 今日N日涨幅均线 = (今日盘中涨幅 + 最近 days-1 个历史 EOD 涨幅) / days
  const todayRets = [Number(todayIntradayChange)];
  for (let i = di - 1; i >= 0 && todayRets.length < days; i--) {
    const r = dailyInfos.get(rangeDates[i])?.get(code)?.changePct;
    if (r == null || !Number.isFinite(Number(r))) return null;
    todayRets.push(Number(r));
  }
  if (todayRets.length < days) return null;
  // 昨日N日涨幅均线 = 最近 days 个历史 EOD 涨幅 / days
  const yestRets = [];
  for (let i = di - 1; i >= di - days; i--) {
    if (i < 0) return null;
    const r = dailyInfos.get(rangeDates[i])?.get(code)?.changePct;
    if (r == null || !Number.isFinite(Number(r))) return null;
    yestRets.push(Number(r));
  }
  if (yestRets.length < days) return null;
  const avgToday = todayRets.reduce((a, b) => a + b, 0) / days;
  const avgYesterday = yestRets.reduce((a, b) => a + b, 0) / days;
  if (!Number.isFinite(avgToday) || !Number.isFinite(avgYesterday)) return null;
  const delta = avgToday - avgYesterday; // 斜率（百分点 / 天）
  const angle = Math.atan(delta) * 180 / Math.PI; // 转化为角度
  return angle;
};

// ============================================================
// 三日情绪冰点系列买入环境门禁（2026-09-28 新增）：触发买点当天，候选股所跟踪指数满足其一才可买——
//   ① 往前数 5 个交易日 20 日线斜率为正：MA20(触发日) − MA20(5个交易日前) > 0（口径同 maSlope=当前MA−5日前MA）
//   ② 触发日 30 日线在 60 日线下方：MA30 < MA60
// 目的：单边阴跌中段（20日线仍下行且 30 日线未跌破 60 日线）抄底隔日无溢价，
//       仅保留「下跌末期反弹（20日线回升）」与「深跌阶段（30<60）」两类有溢价环境。
// 数据：同花顺指数日K收盘价（创业板指 sz399006 / 科创50 sh000688），MA 含触发日收盘
//      （尾盘 14:57 触发时按收盘已基本定型口径，与 EMA 命中条件一致）。
// 跟踪指数映射与抗分歧口径一致：sh688 开头跟踪科创50，其余跟踪创业板指。
// 全部候选股均不满足（或指数日K数据不足/获取失败）时当日不买入。
// ============================================================

module.exports = {
  buildWindowAxis,
  computeMaSlopeAngle,
  injectSimStocksIntoCampData,
  passWatchlistGate,
  pickWeakToStrongStock,
};
