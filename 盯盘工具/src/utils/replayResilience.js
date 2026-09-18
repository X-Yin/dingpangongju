// 回放模式实时抗分歧指数计算（对齐后端 calculateResilience 逻辑）
// 供训练营回放复用（叠加分时、模拟持仓卖点诊断）
// 入参均为 { minute, change, lastPx } 数组，按分钟对齐后计算涨跌弹性与超额收益

import axios from 'axios';
import { local_ip } from '../constant';

// ===== 回放模式分钟级分时缓存（key: `${date}_${code}`）=====
// MultiStockTimeLineModal（叠加分时 tag）与训练营卖点诊断（条件5当日实时分数）共用
// value 为 [{minute, change, lastPx}] 升序数组，null 表示拉取失败（不重试，走桶级回退）
const minuteTlineCache = new Map();
const minuteTlineFetching = new Set();
const minuteTlineListeners = new Set();

const mapTlineLineToPoints = (line) => (line || [])
  .filter(p => p && p.minute != null && p.last_px != null)
  .map(p => ({ minute: parseInt(p.minute), change: parseFloat(p.change || 0), lastPx: parseFloat(p.last_px) }))
  .sort((a, b) => a.minute - b.minute);

// 同步读取分钟级分时缓存（未拉到返回 null）
export const getReplayMinuteTlineByDate = (code, date) => {
  if (!code || !date) return null;
  const key = `${date}_${code}`;
  return minuteTlineCache.has(key) ? minuteTlineCache.get(key) : null;
};

// 拉取缺失的分钟级分时（每日期每代码仅拉一次，复用服务端磁盘缓存接口 /stock_tline_data）
export const ensureReplayMinuteTlineByDate = (codes, date) => {
  if (!date || !Array.isArray(codes)) return;
  codes.forEach((code) => {
    if (!code) return;
    const key = `${date}_${code}`;
    if (minuteTlineCache.has(key) || minuteTlineFetching.has(key)) return;
    minuteTlineFetching.add(key);
    axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code, date } })
      .then((res) => {
        minuteTlineCache.set(key, mapTlineLineToPoints(res.data?.line));
      })
      .catch(() => {
        minuteTlineCache.set(key, null);
      })
      .finally(() => {
        minuteTlineFetching.delete(key);
        minuteTlineListeners.forEach((cb) => { try { cb() } catch { /* noop */ } });
      });
  });
};

// 订阅缓存更新（任一拉取完成/失败后触发）；返回取消订阅函数
export const subscribeMinuteTlineUpdate = (cb) => {
  minuteTlineListeners.add(cb);
  return () => minuteTlineListeners.delete(cb);
};

const getReplayLimitType = (code) => {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('SH688') || c.startsWith('688')) return 'STAR';
  if (c.startsWith('SZ3') || c.startsWith('3')) return 'GEM';
  return 'MAIN';
};

const calculateReplayResilience = (stockPoints, indexPoints, code) => {
  if (!Array.isArray(stockPoints) || stockPoints.length < 5) return null;
  if (!Array.isArray(indexPoints) || indexPoints.length < 5) return null;
  const limits = { STAR: 20, GEM: 20, MAIN: 10 };
  const limitType = getReplayLimitType(code);
  const limitPct = limits[limitType] ?? 10;
  const limitEps = 0.001;

  const indexMap = new Map();
  for (const item of indexPoints) {
    const m = parseInt(item.minute);
    const px = item.lastPx != null ? parseFloat(item.lastPx) : (100 + (item.change != null ? parseFloat(item.change) : 0));
    if (!isNaN(m) && px > 0) {
      indexMap.set(m, { px, change: item.change != null ? parseFloat(item.change) : 0 });
    }
  }
  if (indexMap.size < 5) return null;

  const aligned = [];
  for (const s of stockPoints) {
    const m = parseInt(s.minute);
    const idx = indexMap.get(m);
    if (!idx) continue;
    const stockPx = s.lastPx != null ? parseFloat(s.lastPx) : (100 + (s.change != null ? parseFloat(s.change) : 0));
    if (!(stockPx > 0)) continue;
    const stockChange = s.change != null ? parseFloat(s.change) : 0;
    const prevClose = stockPx / (1 + stockChange / 100);
    const limitUpPrice = prevClose * (1 + limitPct / 100);
    const limitDownPrice = prevClose * (1 - limitPct / 100);
    aligned.push({
      minute: m,
      stockPx,
      indexPx: idx.px,
      stockChange,
      indexChange: idx.change,
      isLockUp: stockPx >= limitUpPrice - limitEps,
      isLockDown: stockPx <= limitDownPrice + limitEps,
      prevClose,
    });
  }
  aligned.sort((a, b) => a.minute - b.minute);
  if (aligned.length < 5) return null;

  const totalMinutes = aligned.length;
  const lockUpCount = aligned.filter(p => p.isLockUp).length;
  const lockDownCount = aligned.filter(p => p.isLockDown).length;
  const lockUpRatio = lockUpCount / totalMinutes;
  const lockDownRatio = lockDownCount / totalMinutes;

  const freeMinutes = aligned.filter(p => !p.isLockUp && !p.isLockDown);
  const stockRets = [];
  const indexRets = [];
  for (let i = 1; i < freeMinutes.length; i++) {
    const prev = freeMinutes[i - 1];
    const curr = freeMinutes[i];
    if (prev.stockPx > 0 && prev.indexPx > 0) {
      stockRets.push((curr.stockPx - prev.stockPx) / prev.stockPx * 100);
      indexRets.push((curr.indexPx - prev.indexPx) / prev.indexPx * 100);
    }
  }

  const upStockRets = [];
  const upIndexRets = [];
  const downStockRets = [];
  const downIndexRets = [];
  for (let i = 0; i < indexRets.length; i++) {
    if (indexRets[i] > 0) {
      upIndexRets.push(indexRets[i]);
      upStockRets.push(stockRets[i]);
    } else if (indexRets[i] < 0) {
      downIndexRets.push(indexRets[i]);
      downStockRets.push(stockRets[i]);
    }
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

  const upStockChg = [];
  const upIndexChg = [];
  const downStockChg = [];
  const downIndexChg = [];
  for (const p of freeMinutes) {
    if (p.indexChange > 0) {
      upStockChg.push(p.stockChange);
      upIndexChg.push(p.indexChange);
    } else if (p.indexChange < 0) {
      downStockChg.push(p.stockChange);
      downIndexChg.push(p.indexChange);
    }
  }
  const avg = (arr) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const excessUp = avg(upStockChg) - avg(upIndexChg);
  const excessDown = avg(downStockChg) - avg(downIndexChg);

  let offenseScore = 0;
  if (upRatio !== null) {
    offenseScore = Math.min(4, Math.max(0, upRatio * 1.6));
  } else {
    offenseScore = 1.0;
  }

  let defenseScore = 0;
  if (downRatio !== null) {
    if (downRatio < 0) {
      defenseScore = 6.0 + Math.min(4, Math.abs(downRatio) * 2);
    } else {
      defenseScore = 5.0 / (downRatio + 1.0);
    }
  } else {
    defenseScore = 2.5;
  }

  const excessUpScore = Math.max(-2, Math.min(2, excessUp * 0.3));
  const excessDownScore = Math.max(-3, Math.min(5, excessDown * 0.8));

  let lockScore = 0;
  if (lockUpRatio > 0.5) {
    lockScore = 5 + (lockUpRatio - 0.5) * 10;
  } else if (lockUpRatio > 0) {
    lockScore = lockUpRatio * 4;
  }
  if (lockDownRatio > 0.5) {
    lockScore -= 5 + (lockDownRatio - 0.5) * 10;
  } else if (lockDownRatio > 0) {
    lockScore -= lockDownRatio * 4;
  }

  let resilienceScore = 5.0 + offenseScore + defenseScore + excessUpScore + excessDownScore + lockScore;
  resilienceScore = Math.max(0, Math.min(30, resilienceScore));
  return parseFloat(resilienceScore.toFixed(4));
};

export { getReplayLimitType, calculateReplayResilience };
export default calculateReplayResilience;
