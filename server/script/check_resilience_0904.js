// 临时排查脚本：复算 2026-09-04 10:05 景旺电子（sh603228）抗分歧分数，对比两种数据源口径
//   口径 A（回测选股现状）：训练营回放快照 timeBuckets 桶数据（buildReplayStocks 同源）
//   口径 B（实时回放口径）：getSingleStockTlineDataByDate 真分钟级分时（前端 /stock_tline_data 同源）
// 运行：node script/check_resilience_0904.js
const fs = require('fs');
const path = require('path');
const { getSingleStockTlineDataByDate } = require('../src/service/stock');

const CODE = 'sh603228';
const INDEX = 'sz399006';
const DATE = 20260904;
const CUT_MINUTE = 1005; // 截至 10:05

// —— 公式复刻自前端 utils/replayResilience.js（与后端 buySellBacktest.js 完全一致）——
const getReplayLimitType = (code) => {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('SH688') || c.startsWith('688')) return 'STAR';
  if (c.startsWith('SZ3') || c.startsWith('3')) return 'GEM';
  return 'MAIN';
};

const calcResilience = (stockPoints, indexPoints, code) => {
  if (!Array.isArray(stockPoints) || stockPoints.length < 5) return { score: null, n: stockPoints?.length };
  if (!Array.isArray(indexPoints) || indexPoints.length < 5) return { score: null, n: indexPoints?.length };
  const limits = { STAR: 20, GEM: 20, MAIN: 10 };
  const limitPct = limits[getReplayLimitType(code)] ?? 10;
  const limitEps = 0.001;

  const indexMap = new Map();
  for (const item of indexPoints) {
    const m = parseInt(item.minute);
    const px = item.lastPx != null ? parseFloat(item.lastPx) : (100 + (item.change != null ? parseFloat(item.change) : 0));
    if (!isNaN(m) && px > 0) indexMap.set(m, { px, change: item.change != null ? parseFloat(item.change) : 0 });
  }
  if (indexMap.size < 5) return { score: null, idxN: indexMap.size };

  const aligned = [];
  for (const s of stockPoints) {
    const m = parseInt(s.minute);
    const idx = indexMap.get(m);
    if (!idx) continue;
    const stockPx = s.lastPx != null ? parseFloat(s.lastPx) : (100 + (s.change != null ? parseFloat(s.change) : 0));
    if (!(stockPx > 0)) continue;
    const stockChange = s.change != null ? parseFloat(s.change) : 0;
    const prevClose = stockPx / (1 + stockChange / 100);
    aligned.push({
      minute: m, stockPx, indexPx: idx.px, stockChange, indexChange: idx.change,
      isLockUp: stockPx >= prevClose * (1 + limitPct / 100) - limitEps,
      isLockDown: stockPx <= prevClose * (1 - limitPct / 100) + limitEps,
    });
  }
  aligned.sort((a, b) => a.minute - b.minute);
  if (aligned.length < 5) return { score: null, alignedN: aligned.length };

  const totalMinutes = aligned.length;
  const lockUpRatio = aligned.filter(p => p.isLockUp).length / totalMinutes;
  const lockDownRatio = aligned.filter(p => p.isLockDown).length / totalMinutes;

  const freeMinutes = aligned.filter(p => !p.isLockUp && !p.isLockDown);
  const stockRets = [], indexRets = [];
  for (let i = 1; i < freeMinutes.length; i++) {
    const prev = freeMinutes[i - 1], curr = freeMinutes[i];
    if (prev.stockPx > 0 && prev.indexPx > 0) {
      stockRets.push((curr.stockPx - prev.stockPx) / prev.stockPx * 100);
      indexRets.push((curr.indexPx - prev.indexPx) / prev.indexPx * 100);
    }
  }
  const upStockRets = [], upIndexRets = [], downStockRets = [], downIndexRets = [];
  for (let i = 0; i < indexRets.length; i++) {
    if (indexRets[i] > 0) { upIndexRets.push(indexRets[i]); upStockRets.push(stockRets[i]); }
    else if (indexRets[i] < 0) { downIndexRets.push(indexRets[i]); downStockRets.push(stockRets[i]); }
  }
  const safeRatio = (xArr, yArr, minSamples = 3) => {
    if (xArr.length < minSamples || yArr.length < minSamples) return null;
    const meanX = xArr.reduce((a, b) => a + b, 0) / xArr.length;
    const meanY = yArr.reduce((a, b) => a + b, 0) / yArr.length;
    if (Math.abs(meanX) < 0.005) return null;
    return meanY / meanX;
  };
  const upRatio = safeRatio(upIndexRets, upStockRets);
  const downRatio = safeRatio(downIndexRets, downStockRets);

  const upStockChg = [], upIndexChg = [], downStockChg = [], downIndexChg = [];
  for (const p of freeMinutes) {
    if (p.indexChange > 0) { upStockChg.push(p.stockChange); upIndexChg.push(p.indexChange); }
    else if (p.indexChange < 0) { downStockChg.push(p.stockChange); downIndexChg.push(p.indexChange); }
  }
  const avg = (arr) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const excessUp = avg(upStockChg) - avg(upIndexChg);
  const excessDown = avg(downStockChg) - avg(downIndexChg);

  let offenseScore = upRatio !== null ? Math.min(4, Math.max(0, upRatio * 1.6)) : 1.0;
  let defenseScore = 0;
  if (downRatio !== null) {
    defenseScore = downRatio < 0 ? 6.0 + Math.min(4, Math.abs(downRatio) * 2) : 5.0 / (downRatio + 1.0);
  } else defenseScore = 2.5;
  const excessUpScore = Math.max(-2, Math.min(2, excessUp * 0.3));
  const excessDownScore = Math.max(-3, Math.min(5, excessDown * 0.8));
  let lockScore = 0;
  if (lockUpRatio > 0.5) lockScore = 5 + (lockUpRatio - 0.5) * 10;
  else if (lockUpRatio > 0) lockScore = lockUpRatio * 4;
  if (lockDownRatio > 0.5) lockScore -= 5 + (lockDownRatio - 0.5) * 10;
  else if (lockDownRatio > 0) lockScore -= lockDownRatio * 4;

  let resilienceScore = 5.0 + offenseScore + defenseScore + excessUpScore + excessDownScore + lockScore;
  resilienceScore = Math.max(0, Math.min(30, resilienceScore));
  return {
    score: parseFloat(resilienceScore.toFixed(2)), n: totalMinutes,
    parts: { base: 5.0, offenseScore: +offenseScore.toFixed(3), defenseScore: +defenseScore.toFixed(3), excessUpScore: +excessUpScore.toFixed(3), excessDownScore: +excessDownScore.toFixed(3), lockScore: +lockScore.toFixed(3) },
    lockUpCount: aligned.filter(p => p.isLockUp).length, lockDownCount: aligned.filter(p => p.isLockDown).length,
  };
};

const cutBy = (points, cut) => (points || []).filter(p => parseInt(p.minute) <= cut);

(async () => {
  console.log(`=== ${CODE} 景旺电子 ${DATE} 截至 ${Math.floor(CUT_MINUTE / 100)}:${String(CUT_MINUTE % 100).padStart(2, '0')} ===`);

  // ===== 口径 A：训练营回放快照桶数据（回测选股现状） =====
  const campFile = path.resolve(__dirname, '../src/data/backtest_camp_cache/20260904.json');
  const camp = JSON.parse(fs.readFileSync(campFile, 'utf-8'));
  const buckets = camp.data?.timeBuckets || camp.timeBuckets || [];
  const stockPts = [], indexPts = [];
  for (const b of buckets) {
    if (b.minute > CUT_MINUTE) break;
    const itl = b.indexTline || {};
    if (itl.cyb && itl.cyb.changePct != null) indexPts.push({ minute: b.minute, change: itl.cyb.changePct, lastPx: itl.cyb.price });
    const sc = (b.stockChanges || []).find(x => x.code === CODE);
    if (sc && sc.changePct != null) stockPts.push({ minute: b.minute, change: sc.changePct, lastPx: sc.lastPx });
  }
  const resA = calcResilience(stockPts, indexPts, CODE);
  console.log(`\n[口径A 回放桶数据] 桶点 ${stockPts.length} 个（最后一个桶 ${stockPts.length ? stockPts[stockPts.length - 1].minute : '-'}）`);
  console.log('  分数 =', resA.score, JSON.stringify(resA.parts || {}, null, 0).replace(/"/g, ''));
  console.log('  桶粒度间隔：', stockPts.length > 1 ? `${stockPts[1].minute - stockPts[0].minute} 分钟` : '-');

  // ===== 口径 B：真分钟级分时（实时回放口径） =====
  const [stockTline, indexTline] = await Promise.all([
    getSingleStockTlineDataByDate(CODE, DATE),
    getSingleStockTlineDataByDate(INDEX, DATE),
  ]);
  const toPts = (t) => (t?.line || t || []).filter(p => p && p.minute != null)
    .map(p => ({ minute: parseInt(p.minute), change: parseFloat(p.change || 0), lastPx: p.last_px != null ? parseFloat(p.last_px) : null }))
    .sort((a, b) => a.minute - b.minute);
  const sPts = cutBy(toPts(stockTline), CUT_MINUTE);
  const iPts = cutBy(toPts(indexTline), CUT_MINUTE);
  const resB = calcResilience(sPts, iPts, CODE);
  console.log(`\n[口径B 真分钟分时] 分时点 ${sPts.length} 个（最后一个点 ${sPts.length ? sPts[sPts.length - 1].minute : '-'}）`);
  console.log('  分数 =', resB.score, JSON.stringify(resB.parts || {}, null, 0).replace(/"/g, ''));
  console.log('  涨停分钟数:', resB.lockUpCount ?? '-', ' 跌停分钟数:', resB.lockDownCount ?? '-');

  console.log('\n=== 结论 ===');
  console.log(`回测选股口径 A = ${resA.score}，实时回放口径 B = ${resB.score}，差值 = ${resA.score != null && resB.score != null ? (resB.score - resA.score).toFixed(2) : '-'}`);
})();
