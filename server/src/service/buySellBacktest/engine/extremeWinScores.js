// 情绪游资-极致胜率：差劲分 / 强度分 的公共口径与打分函数
// 供两处复用，保证公式完全一致：
//   1) 回测引擎 engine/extremeWinBacktest.js
//   2) 个股历史分析接口 GET /stock_history_analysis（index.js）
const { getSingleStockTlineDataByDate } = require('../deps');
const { calculateReplayResilience } = require('../diagnose/sellPoint');

// ==================== 归一化上限与权重 ====================
// 差劲分（越高越差）：A 放量比 / B 单分钟最大跳水 / C 冲高回落 / D 涨停炸板或跌幅
const DIFF_A_MAX = 3;              // 放量比上限
const DIFF_B_MAX = 5;              // 单分钟最大跳水（%）上限
const DIFF_C_MAX = 10;             // 冲高回落（%）上限
const DIFF_D_MAX = 5;              // D 项「炸板次数」分支上限（当日触及涨停价时）
const DIFF_D_DROP_MAX = 10;        // D 项「跌幅」分支满格值（%）：当日未涨停时按跌幅归一，-10% 记满 100
const DIFF_W = { a: 0.3, b: 0.2, c: 0.3, d: 0.2 };

// 强度分（越高越强）：A 竞价高开 / B 单分钟最大涨幅 / C 抗分歧分数 / D 当日涨幅（2026-10-17 用户新增）
const STRENGTH_A_MAX = 10;         // 竞价高开（%）上限
const STRENGTH_B_MAX = 10;         // 单分钟最大涨幅（%）上限
const STRENGTH_C_MAX = 20;         // 抗分歧分数（原始 0~30）上限
const STRENGTH_D_MAX = 10;         // 当日涨幅（%）上限（涨幅 < 0 记 0 分，涨幅 >= 0 按 ÷ 10% 归一化）
// 2026-10-17 用户要求：新增 D 当日涨幅（权重 0.2），并从 A 竞价高开、B 单分钟最大涨幅各扣 0.1 匀给它
const STRENGTH_W = { a: 0.3, b: 0.2, c: 0.3, d: 0.2 };

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
        .map(p => ({
          minute: parseInt(p.minute, 10),
          lastPx: parseFloat(p.last_px),
          change: p.change != null ? parseFloat(p.change) : 0,
          // 每分钟成交量（THS 为逐分钟增量、CLS 为 item.business_amount）；缺失记 null
          vol: p.business_amount != null && Number.isFinite(Number(p.business_amount)) ? Number(p.business_amount) : null,
        }))
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

// D 项口径（2026-10-17 用户新增）：
//   当日跌停（主板 ≤ -9.5% / 创业·科创 ≤ -19%）→ D 项记满 100，且整个差劲分封顶 100（见 buildDiffDetail）；
//   当日分时触及涨停价（任意分时点 >= 涨停价）→ 沿用「炸板次数」（0~DIFF_D_MAX），按 DIFF_D_MAX 归一化；
//   当日未涨停（且未跌停）→ 改用「涨跌幅」代理：
//     涨幅 >= 0 → 0 分；
//     涨幅 < 0  → |涨幅| ÷ DIFF_D_DROP_MAX 归一化（-10% 记满 100），clamp 0~100。
// changePct 为「较昨收」的涨跌幅（日线口径 = 收盘涨跌幅；盘中口径 = 截至当前桶实时涨跌幅）
// 返回 { dRaw, dScore, isLimitDown }：dRaw 为「炸板次数」或「涨跌幅(%)」，仅供展示
const diffDFrom = (points, preclose, code, changePct) => {
  if (!(preclose > 0) || !Array.isArray(points) || points.length === 0) return { dRaw: 0, dScore: 0, isLimitDown: false };
  const ch = Number(changePct);
  // 跌停优先：主板 -9.5% / 创业·科创 -19%（沿用全项目涨停阈值口径）→ D 项记满、整个差劲分封顶 100
  if (Number.isFinite(ch) && ch <= -limitUpThresholdOf(code)) {
    return { dRaw: round2(ch), dScore: 100, isLimitDown: true };
  }
  const limitPct = limitPctOf(code);
  const limitPrice = preclose * (1 + limitPct / 100);
  const touchedLimit = points.some(p => p.lastPx >= limitPrice - 0.001);
  if (touchedLimit) {
    const cnt = fanbanCount(points, preclose, code);
    return { dRaw: cnt, dScore: clamp100((cnt / DIFF_D_MAX) * 100), isLimitDown: false };
  }
  if (!Number.isFinite(ch) || ch >= 0) return { dRaw: 0, dScore: 0, isLimitDown: false };
  return { dRaw: round2(ch), dScore: clamp100((Math.abs(ch) / DIFF_D_DROP_MAX) * 100), isLimitDown: false };
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
// dScoreOverride：D 项已由 diffDFrom 算好（炸板/跌幅分支）时直接传入，省去重复「次数归一化」
const scoreDiffFromRaw = (aRaw, bRaw, cRaw, dRaw, dScoreOverride) => {
  const aScore = clamp100(((aRaw == null ? 0 : aRaw) / DIFF_A_MAX) * 100);
  const bScore = clamp100((bRaw / DIFF_B_MAX) * 100);
  const cScore = clamp100((cRaw / DIFF_C_MAX) * 100);
  const dScore = (dScoreOverride != null && Number.isFinite(Number(dScoreOverride)))
    ? clamp100(dScoreOverride)
    : clamp100((dRaw / DIFF_D_MAX) * 100);
  const score = DIFF_W.a * aScore + DIFF_W.b * bScore + DIFF_W.c * cScore + DIFF_W.d * dScore;
  return {
    score: round2(score) || 0,
    aRaw: round2(aRaw), bRaw: round2(bRaw), cRaw: round2(cRaw), dRaw,
    aScore: round2(aScore), bScore: round2(bScore), cScore: round2(cScore), dScore: round2(dScore),
  };
};

// 由 A/B/C 原始项 + D 项明细（diffDFrom 结果）合成差劲分：
// 当日跌停时整个差劲分直接封顶 100（覆盖加权结果；A/B/C/D 分项仍保留供展示）——2026-10-17 用户要求
const buildDiffDetail = (aRaw, bRaw, cRaw, dItem) => {
  const detail = scoreDiffFromRaw(aRaw, bRaw, cRaw, dItem.dRaw, dItem.dScore);
  return dItem.isLimitDown ? { ...detail, score: 100, limitDown: true } : { ...detail, limitDown: false };
};

// 强度分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D
// D 当日涨幅：涨幅 < 0 记 0 分；涨幅 >= 0 按 ÷ 10% 归一化（-10% 到 0 之间为 0，10% 及以上记满 100）
const scoreStrengthFromRaw = (gapPct, bRaw, cRaw, changePct) => {
  const aScore = clamp100((gapPct / STRENGTH_A_MAX) * 100);
  const bScore = clamp100((bRaw / STRENGTH_B_MAX) * 100);
  const cScore = clamp100((cRaw / STRENGTH_C_MAX) * 100);
  const chg = Number(changePct);
  const dRaw = Number.isFinite(chg) ? chg : 0;
  const dScore = clamp100((Math.max(0, dRaw) / STRENGTH_D_MAX) * 100);
  const score = STRENGTH_W.a * aScore + STRENGTH_W.b * bScore + STRENGTH_W.c * cScore + STRENGTH_W.d * dScore;
  return {
    score: round2(score) || 0,
    aRaw: round2(gapPct), bRaw: round2(bRaw), cRaw: round2(cRaw), dRaw: round2(dRaw),
    aScore: round2(aScore), bScore: round2(bScore), cScore: round2(cScore), dScore: round2(dScore),
  };
};

// 强度分（截至 minute 的盘中分时，0~100）：A 竞价高开 / B 单分钟最大涨幅 / C 抗分歧分数 / D 当日涨幅
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
    ...scoreStrengthFromRaw(gapPct, bRaw, cRaw, changePct),
    px,
    changePct: round2(changePct),
    openPx: round2(openPx),
    preclose: round2(preclose),
    isOneWord,
    limitUp: changePct > limitUpThresholdOf(code),
  };
};

// 死叉检索：返回「最近一次死叉」的下标 i（deltas[i-1] > 0 且 deltas[i] < 0，相邻两日均为有效值）；
// 无死叉返回 -1。deltas 为按日期升序的「强度分 − 差劲分」序列（元素可能为 null）
const lastDeathCrossIndex = (deltas) => {
  let res = -1;
  for (let i = 1; i < deltas.length; i++) {
    const a = deltas[i - 1];
    const b = deltas[i];
    if (a == null || b == null) continue;
    if (Number(a) > 0 && Number(b) < 0) res = i;
  }
  return res;
};

// 盘中实时差劲分（截至 minute，0~100）：A 用「分时累计成交量」对「该股前 3 个交易日日均量（avg3Vol）」的放量比，
// B/C/D 与日线收盘口径一致，但在截断到 minute 的分时上计算（C 以当前分时价替代收盘价）
const diffAtMinute = (points, preclose, code, minute, avg3Vol) => {
  const pts = (points || []).filter(p => p.minute <= minute);
  if (pts.length === 0) return null;
  let cumVol = 0;
  let volOk = true;
  for (const p of pts) {
    if (p.vol == null || !Number.isFinite(Number(p.vol))) { volOk = false; break; }
    cumVol += Number(p.vol);
  }
  const aRaw = (volOk && avg3Vol != null && avg3Vol > 0)
    ? parseFloat(((cumVol - avg3Vol) / avg3Vol).toFixed(6))
    : null;
  // D 项：按截至当前桶的实时涨跌幅（pts 最后一点 vs 昨收）
  const lastPx = pts[pts.length - 1].lastPx;
  const changePct = preclose > 0 ? ((lastPx - preclose) / preclose) * 100 : 0;
  const dItem = diffDFrom(pts, preclose, code, changePct);
  return buildDiffDetail(aRaw, maxMinuteDrop(pts), closeDropFromHigh(pts), dItem);
};

module.exports = {
  // 常量
  DIFF_A_MAX, DIFF_B_MAX, DIFF_C_MAX, DIFF_D_MAX, DIFF_D_DROP_MAX, DIFF_W,
  STRENGTH_A_MAX, STRENGTH_B_MAX, STRENGTH_C_MAX, STRENGTH_D_MAX, STRENGTH_W,
  // 工具
  limitTypeOf, limitPctOf, limitUpThresholdOf, clamp100, round2,
  // 分时缓存
  loadTlinePoints, clearTlineCache,
  // 原始项
  maxMinuteDrop, maxMinuteRise, closeDropFromHigh, fanbanCount, diffDFrom, volumeRatioAtDate,
  // 打分
  scoreDiffFromRaw, buildDiffDetail, scoreStrengthFromRaw, strengthAtMinute,
  // 盘中实时差劲分 / 死叉检索
  diffAtMinute, lastDeathCrossIndex,
};
