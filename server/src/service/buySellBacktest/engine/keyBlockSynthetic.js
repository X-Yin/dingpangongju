const { calcDailyMaInfo, calculateResilience, getKlineCached, getLimitTypeByCode, getSingleStockTlineDataByDate } = require('../deps');

const buildKeyBlockSyntheticDay = async (code, stockName, dateStr) => {
  const dateNum = parseInt(dateStr, 10);
  let tline = null;
  try {
    tline = await getSingleStockTlineDataByDate(code, dateNum);
  } catch (e) {
    return null;
  }
  const preclose = tline?.preclose_px != null ? parseFloat(tline.preclose_px) : null;
  const sortedPoints = (tline?.line || [])
    .filter(p => p && p.minute != null && p.last_px != null)
    .map(p => ({
      minute: parseInt(p.minute),
      lastPx: parseFloat(p.last_px),
      change: preclose && preclose > 0 ? parseFloat((((parseFloat(p.last_px) - preclose) / preclose) * 100).toFixed(2)) : null,
    }))
    .filter(p => p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sortedPoints.length === 0) return null;

  // 日K衍生字段（失败降级为 null：仅影响条件1/条件6，价格类条件不受影响）
  let maInfo = { ma5: null, ma5Slope: null, ma10: null, ma10Slope: null, prevLow: null, dailyLowMap: {} };
  try {
    const calc = calcDailyMaInfo(await getKlineCached(code, dateStr), dateStr);
    if (calc) maInfo = calc;
  } catch (e) { /* 保持降级默认 */ }

  // 最近 3 个交易日（含当日）全天抗分歧分数（失败降级为空数组 → 条件5 安全不触发）
  let r3d = { allBelow10: false, scores: [], valid: false };
  try {
    const kline = await getKlineCached(code, dateStr);
    const sortedBars = [...(kline || [])]
      .filter(k => k && Number.isFinite(Number(k.trade_date)))
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const idx = sortedBars.findIndex(k => Number(k.trade_date) === dateNum);
    if (idx >= 2) {
      const last3Dates = [idx - 2, idx - 1, idx].map(i => Number(sortedBars[i].trade_date));
      const indexCode = code.startsWith('sh688') ? 'sh000688' : 'sz399006';
      const limitType = getLimitTypeByCode(code);
      const scores = [];
      let allValid = true;
      for (const d of last3Dates) {
        const [stockTline, indexTline] = await Promise.all([
          getSingleStockTlineDataByDate(code, d),
          getSingleStockTlineDataByDate(indexCode, d),
        ]);
        const stockLine = stockTline?.line || [];
        const indexLine = indexTline?.line || [];
        if (stockLine.length < 5 || indexLine.length < 5) {
          allValid = false;
          scores.push(null);
          continue;
        }
        const s = calculateResilience(indexLine, stockLine, limitType);
        scores.push(parseFloat(s.toFixed(2)));
      }
      const allBelow10 = allValid && scores.every(s => s !== null && s < 10);
      r3d = { allBelow10, scores, valid: allValid };
    }
  } catch (e) { /* 保持降级默认 */ }

  // 合成 replayStocks 条目：tlinePoints 供 dayHigh/openPrice/条件2持续/条件4实时/条件6持续；dailyLowMap 供条件6
  const replayEntry = {
    code,
    stockName: stockName || code,
    tlinePoints: sortedPoints.map(p => ({ minute: p.minute, change: p.change, lastPx: p.lastPx })),
    dailyLowMap: maInfo.dailyLowMap || {},
    isDefaultIndex: false,
  };

  // 逐桶 stockChanges 条目按需由 buildKeyBlockSyntheticBucketEntry 生成（见下）
  return { replayEntry, sortedPoints, maInfo, r3d };
};

// 由合成日数据生成某一时间桶的 stockChanges 条目（lastPx/changePct 取 minute ≤ 桶 minute 的最后一点）
const buildKeyBlockSyntheticBucketEntry = (code, stockName, sortedPoints, maInfo, r3d, bucketMinute) => {
  let atBucket = null;
  for (const p of sortedPoints) {
    if (p.minute <= bucketMinute) atBucket = p;
    else break;
  }
  if (!atBucket) return null;
  return {
    code,
    name: stockName || code,
    lastPx: atBucket.lastPx,
    changePct: atBucket.change,
    dailyMa5: maInfo.ma5 != null ? maInfo.ma5 : null,
    dailyMa5Slope: maInfo.ma5Slope != null ? maInfo.ma5Slope : null,
    dailyMa10: maInfo.ma10 != null ? maInfo.ma10 : null,
    dailyMa10Slope: maInfo.ma10Slope != null ? maInfo.ma10Slope : null,
    dailyPrevLow: maInfo.prevLow != null ? maInfo.prevLow : null,
    resilience3dAllBelow10: r3d.allBelow10 === true,
    resilience3dScores: r3d.scores || [],
    resilience3dValid: r3d.valid === true,
  };
};

// 创业板 / 科创板指 3 日线斜率（**MA3 切线方向**：MA3(今日) − MA3(昨日)，按当日收盘已基本定型口径，
//  MA 截止口径对齐 calcEmo3IndexGate：日K过滤升序、close_px>0），用途：
//   - 本次 N 日涨幅最大系列跨指数双门禁：创业板指跟踪主板/创业板股票，科创 50 跟踪科创板股票
//   - 卖出条件3门禁：斜率 > 0 时「科技板块情绪退潮」条件才参与进攻持仓卖出判定
//   - 斜率翻转状态机初值：回测首日前一交易日的收盘斜率符号（2026-10-01 重构）
// 关键说明（2026-10-02 用户修正）：斜率口径从旧版 MA3 − 5 个交易日前 MA3 改成 MA3 − 昨 MA3（MA3 切线方向），
//  因旧版滞后、与 K 线图上看的"均线斜率"直觉语义不符。MA3 切线需要最少 4 根日K即可计算。
// 盘中实时翻转判定统一走 getIndexMa3SlopeIntraday；
//  一次拉取日K批量计算全序列（历史不可变，进程内按 indexCode 独立缓存），数据不足（<4根）/获取失败返回 null
// EMO3_GATE_INDEX_CODES 已包含 sz399006（创业板指）和 sh000688（科创 50）两项配置，直接复用

module.exports = {
  buildKeyBlockSyntheticBucketEntry,
  buildKeyBlockSyntheticDay,
};
