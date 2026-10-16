// 情绪游资-极致胜率：差劲分 / 强度分 的公共口径与打分函数
// 供两处复用，保证公式完全一致：
//   1) 回测引擎 engine/extremeWinBacktest.js
//   2) 个股历史分析接口 GET /stock_history_analysis（index.js）
const { getSingleStockTlineDataByDate } = require('../deps');
const { calculateReplayResilience } = require('../diagnose/sellPoint');

// ==================== 归一化上限与权重 ====================
// 差劲分（越高越差）：A 放量比 / B 单分钟最大跳水 / C 冲高回落 / D 炸板次数
const DIFF_A_MAX = 3;              // 放量比上限
const DIFF_B_MAX = 5;              // 单分钟最大跳水（%）上限
const DIFF_C_MAX = 10;             // 冲高回落（%）上限
const DIFF_D_MAX = 5;              // 炸板次数上限
const DIFF_W = { a: 0.3, b: 0.2, c: 0.3, d: 0.2 };

// 强度分（越高越强）：A 竞价高开 / B 单分钟最大涨幅 / C 抗分歧分数
const STRENGTH_A_MAX = 10;         // 竞价高开（%）上限
const STRENGTH_B_MAX = 10;         // 单分钟最大涨幅（%）上限
const STRENGTH_C_MAX = 20;         // 抗分歧分数（原始 0~30）上限
const STRENGTH_W = { a: 0.4, b: 0.3, c: 0.3 };

// 买点门槛：昨日差劲分 >= 45
const DIFF_MIN_SCORE = 45;

// ==================== 通用工具 ====================
// 市场涨停口径：主板 10 / 创业板·科创板 20
const limitTypeOf = (code) => {
  const c = String(code || '').replace(/^(sh|sz|bj)/i, '');
  if (/^68/.test(c)) return 'STAR';
  if (/^30/.test(c)) return 'GEM';
  return 'MAIN';
};
const limitPctOf = (code) => (limitTypeOf(code) === 'MAIN' ? 10 : 20);
const limitUpThresholdOf = (code) => (limitTypeOf(code) === 'MAIN' ? 9.5 : 19);

const clamp100 = (v) => (!Number.isFinite(Number(v)) ? 0 : Math.max(0, Math.min(100, Number(v))));
const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : parseFloat(Number(v).toFixed(2)));

// ==================== 分时数据加载（进程内缓存） ====================
const tlineCache = new Map(); // `${code}|${dateNum}` -> { preclose, points }
const loadTlinePoints = async (code, dateNum) => {
  const key = `${code}|${dateNum}`;
  if (tlineCache.has(key)) return tlineCache.get(key);
  let res = { preclose: null, points: [] };
  try {
    const t = await getSingleStockTlineDataByDate(code, dateNum);
    res = {
      preclose: t?.preclose_px != null ? parseFloat(t.preclose_px) : null,
      points: (t?.line || [])
        .filter(p => p && p.minute != null && p.last_px != null)
        .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
        .filter(p => p.lastPx > 0)
        .sort((a, b) => a.minute - b.minute),
    };
  } catch (e) { /* 拉取失败返回空 */ }
  tlineCache.set(key, res);
  return res;
};
const clearTlineCache = () => tlineCache.clear();

// ==================== 原始项提取 ====================
// B 单分钟最大跳水（%）：相邻分钟最大跌幅
const maxMinuteDrop = (points) => {
  let res = 0;
  for (let i = 1; i < points.length; i++) {
    const q = points[i - 1], p = points[i];
    if (q.lastPx > 0) {
      const drop = ((q.lastPx - p.lastPx) / q.lastPx) * 100;
      if (drop > res) res = drop;
    }
  }
  return res;
};

// B 单分钟最大涨幅（%）：相邻分钟最大涨幅
const maxMinuteRise = (points) => {
  let res = 0;
  for (let i = 1; i < points.length; i++) {
    const q = points[i - 1], p = points[i];
    if (q.lastPx > 0) {
      const r = ((p.lastPx - q.lastPx) / q.lastPx) * 100;
      if (r > res) res = r;
    }
  }
  return res;
};

// C 冲高回落（%）：(分时最高价 − 当日收盘价) ÷ 当日收盘价 × 100；收盘价取当日分时最后一个点
const closeDropFromHigh = (points) => {
  if (points.length === 0) return 0;
  const hi = points.reduce((m, p) => Math.max(m, p.lastPx), 0);
  const close = points[points.length - 1].lastPx;
  return close > 0 ? ((hi - close) / close) * 100 : 0;
};

// D 炸板次数：当日分时触及涨停价后回落的次数（涨停价 = 昨收 × (1 + 涨停幅%)）
const fanbanCount = (points, preclose, code) => {
  if (!(preclose > 0) || points.length === 0) return 0;
  const limitPrice = preclose * (1 + limitPctOf(code) / 100);
  let atLimit = false;
  let count = 0;
  for (const p of points) {
    if (p.lastPx >= limitPrice - 0.001) atLimit = true;
    else if (atLimit) { count++; atLimit = false; }
  }
  return count;
};

// 放量比 A：(目标日成交量 − 其前 3 个交易日日均量) ÷ 其前 3 个交易日日均量
// bars 为按日期升序的日K数组（需含 d=YYYYMMDD、v=成交量）
const volumeRatioAtDate = (bars, dateNum) => {
  if (!Array.isArray(bars) || bars.length < 4) return null;
  const d = Number(dateNum);
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].d === d) { idx = i; break; }
    if (bars[i].d > d) break;
  }
  if (idx < 3) return null;
  const cv = bars[idx].v;
  const prior = [bars[idx - 1].v, bars[idx - 2].v, bars[idx - 3].v];
  if (cv == null || prior.some((v) => v == null || !(v > 0))) return null;
  const avg3 = prior.reduce((a, b) => a + b, 0) / 3;
  if (!(avg3 > 0)) return null;
  return parseFloat(((cv - avg3) / avg3).toFixed(6));
};

// ==================== 打分（原始项 → 0~100） ====================
// 差劲分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D
const scoreDiffFromRaw = (aRaw, bRaw, cRaw, dRaw) => {
  const aScore = clamp100(((aRaw == null ? 0 : aRaw) / DIFF_A_MAX) * 100);
  const bScore = clamp100((bRaw / DIFF_B_MAX) * 100);
  const cScore = clamp100((cRaw / DIFF_C_MAX) * 100);
  const dScore = clamp100((dRaw / DIFF_D_MAX) * 100);
  const score = DIFF_W.a * aScore + DIFF_W.b * bScore + DIFF_W.c * cScore + DIFF_W.d * dScore;
  return {
    score: round2(score) || 0,
    aRaw: round2(aRaw), bRaw: round2(bRaw), cRaw: round2(cRaw), dRaw,
    aScore: round2(aScore), bScore: round2(bScore), cScore: round2(cScore), dScore: round2(dScore),
  };
};

// 强度分 = 0.4×A + 0.3×B + 0.3×C
const scoreStrengthFromRaw = (gapPct, bRaw, cRaw) => {
  const aScore = clamp100((gapPct / STRENGTH_A_MAX) * 100);
  const bScore = clamp100((bRaw / STRENGTH_B_MAX) * 100);
  const cScore = clamp100((cRaw / STRENGTH_C_MAX) * 100);
  const score = STRENGTH_W.a * aScore + STRENGTH_W.b * bScore + STRENGTH_W.c * cScore;
  return {
    score: round2(score) || 0,
    aRaw: round2(gapPct), bRaw: round2(bRaw), cRaw: round2(cRaw),
    aScore: round2(aScore), bScore: round2(bScore), cScore: round2(cScore),
  };
};

// 强度分（截至 minute 的盘中分时，0~100）：A 竞价高开 / B 单分钟最大涨幅 / C 抗分歧分数
// t 为 loadTlinePoints 的结果；idxPoints 为该股对应跟踪指数的当日分时点数组，调用方负责取到
const strengthAtMinute = (t, minute, code, idxPoints) => {
  const pts = (t?.points || []).filter(p => p.minute <= minute);
  if (pts.length === 0) return null;
  const preclose = t.preclose;
  if (!(preclose > 0)) return null;
  const px = pts[pts.length - 1].lastPx;
  if (!(px > 0)) return null;
  const changePct = ((px - preclose) / preclose) * 100;
  // A 竞价高开：开盘价取当日首个分时点
  const openPx = pts[0].lastPx;
  const gapPct = ((openPx - preclose) / preclose) * 100;
  // B 单分钟最大涨幅；一字板直接取上限（主板 10 / 创业板·科创板 20）
  const limitPct = limitPctOf(code);
  const limitPrice = preclose * (1 + limitPct / 100);
  const isOneWord = pts[0].lastPx >= limitPrice - 0.001 && pts.every(p => p.lastPx >= limitPrice - 0.001);
  const bRaw = isOneWord ? limitPct : maxMinuteRise(pts);
  // C 抗分歧分数（原始 0~30）
  let cRaw = 0;
  const idxPts = (idxPoints || []).filter(p => p.minute <= minute);
  if (pts.length >= 5 && idxPts.length >= 5) {
    const r = calculateReplayResilience(pts, idxPts, code);
    if (r != null && Number.isFinite(Number(r))) cRaw = Number(r);
  }
  return {
    ...scoreStrengthFromRaw(gapPct, bRaw, cRaw),
    px,
    changePct: round2(changePct),
    openPx: round2(openPx),
    preclose: round2(preclose),
    isOneWord,
    limitUp: changePct > limitUpThresholdOf(code),
  };
};

module.exports = {
  // 常量
  DIFF_A_MAX, DIFF_B_MAX, DIFF_C_MAX, DIFF_D_MAX, DIFF_W,
  STRENGTH_A_MAX, STRENGTH_B_MAX, STRENGTH_C_MAX, STRENGTH_W,
  DIFF_MIN_SCORE,
  // 工具
  limitTypeOf, limitPctOf, limitUpThresholdOf, clamp100, round2,
  // 分时缓存
  loadTlinePoints, clearTlineCache,
  // 原始项
  maxMinuteDrop, maxMinuteRise, closeDropFromHigh, fanbanCount, volumeRatioAtDate,
  // 打分
  scoreDiffFromRaw, scoreStrengthFromRaw, strengthAtMinute,
};
