// ============================================================
// 「情绪游资-极致胜率」顺周期腿候选池 + 死叉口径 公共模块
//   从 extremeWinBacktest.js 抽取，供「回测引擎」与「开盘实战页 live 龙头列表」共用同一份实现，
//   避免线上展示与回测口径漂移（2026-10-17 用户要求：开盘实战页切换模式后与回测买卖点完全一致）。
// ============================================================
const {
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getMonitorStocks,
  stockVolumeRatioAt,
  stockWindowRangePct,
  stockDailyChange,
} = require('../deps');
const { iceResilienceIndexCode } = require('./indexGate');
const { EXCLUDED_CODES, EXCLUDED_THEMES, isExcludedTheme } = require('../constants');
const {
  round2,
  loadTlinePoints,
  maxMinuteDrop, closeDropFromHigh, diffDFrom,
  buildDiffDetail, strengthAtMinute, lastDeathCrossIndex,
} = require('./extremeWinScores');

// ---- 选股与死叉窗口常量（与回测引擎完全一致）----
const LOOKBACK_DAYS = 10;          // 选股回溯窗口：过去 10 个交易日
const MIN_BOARD_COUNT = 4;         // 连板门槛：四连板及以上
const DEATH_CROSS_WINDOW = 10;     // 死叉检索窗口：过去 10 个交易日（不含当日）
const DELTA_MIN = 30;              // 买点门槛：今日「强度分 − 差劲分」>= 30
const CLOSE_MINUTE = 1500;         // 日线 delta 序列的收盘口径分钟（与「个股历史分析」一致）

// 2026-10-17 用户要求：本策略候选池一律剔除创业板（30/301）与科创板（688）
const isChiNextOrStar = (code) => /^(30|688)/.test(String(code).replace(/^(sh|sz|bj)/i, ''));

// 动量过滤窗口：过去 20 个交易日（不含当日）内任意连续 10 个交易日子窗口区间最大涨幅 < 80%，整段总涨幅 < 100%
const RANGE_WINDOW_DAYS = 20;
const RANGE_SLIDE_DAYS = 10;
const MAX_WINDOW_RANGE_PCT = 80;
const MAX_TOTAL_RANGE_PCT = 100;

// 四连板之后若出现过任一交易日涨幅 < -9%，则该股从候选池剔除
const POST_LIANBAN_DROP_PCT = -9;
const hasPostLianbanBigDrop = (code, lianbanDate, dates) => {
  const from = Number(lianbanDate);
  if (!Number.isFinite(from)) return false;
  for (const d of dates) {
    if (Number(d) > from) {
      const chg = stockDailyChange(code, d);
      // 数据缺失时不判定为「出现过」——仅在确有大跌交易日时才剔除
      if (chg != null && Number.isFinite(chg) && chg < POST_LIANBAN_DROP_PCT) return true;
    }
  }
  return false;
};

// 过去若干交易日内「任意连续 slideDays 个交易日」的区间最大涨幅取最大值（%）：
// 逐个子窗口调用 stockWindowRangePct 取最大；任一子窗口缺 K 线则返回 null（视为不达标）
const maxSlidingWindowRangePct = (code, winDates, slideDays) => {
  if (!Array.isArray(winDates) || winDates.length < slideDays) return null;
  let max = null;
  for (let i = 0; i + slideDays <= winDates.length; i += 1) {
    const rp = stockWindowRangePct(code, winDates.slice(i, i + slideDays));
    if (rp == null || !Number.isFinite(rp)) return null;
    if (max == null || rp > max) max = rp;
  }
  return max;
};

// 2026-10-17 用户新增门禁：若上个交易日强度分 > 60，则当天买入时竞价低开不得超过 -3%
const PREV_STRENGTH_GAP_GATE = 60;   // 上个交易日强度分门槛（> 60 时触发竞价限制）
const OPEN_GAP_MIN_PCT = -3;         // 竞价低开下限（开盘涨幅须 >= -3%）

// 「全量自选股中的科技股」（monitor_stocks.json 中 isTech !== false）代码集合：
// 候选池若与其重叠则不买，避免与科技股仓位重叠（仅作用于顺周期腿）
const getTechWatchlistCodes = () => new Set(
  (getMonitorStocks() || [])
    .filter(s => s && s.code && s.isTech !== false)
    .map(s => s.code),
);

// 判某候选在过去 DEATH_CROSS_WINDOW 个交易日（crossDates 升序，不含当日）是否满足买点前置：
//   构建日线「强度分 − 差劲分」序列（差劲分 / 强度分均按收盘 1500 口径）
//   → 最近一次死叉下标 → 死叉之后 delta >= DELTA_MIN 的交易日计数
// 返回 { hasCross, consumed, hitCount, crossIdx, deltas, dates, prevDayDelta, prevDayVolRatio, prevDayStrength, prevDayVolumeOk }
const computeCrossInfo = async (code, crossDates) => {
  const idxCode = iceResilienceIndexCode(code);
  const deltas = [];
  const volRatios = [];
  const strengths = [];
  for (const d of crossDates) {
    const t = await loadTlinePoints(code, d);
    if (!t || t.points.length === 0 || !(t.preclose > 0)) { deltas.push(null); volRatios.push(null); strengths.push(null); continue; }
    const lastPx = t.points[t.points.length - 1].lastPx;
    const dayChange = ((lastPx - t.preclose) / t.preclose) * 100;
    const dItem = diffDFrom(t.points, t.preclose, code, dayChange);
    const volRatio = stockVolumeRatioAt(code, d);
    const diff = buildDiffDetail(
      volRatio,
      maxMinuteDrop(t.points),
      closeDropFromHigh(t.points),
      dItem,
    );
    volRatios.push(volRatio);
    const idxT = await loadTlinePoints(idxCode, d);
    const s = strengthAtMinute(t, CLOSE_MINUTE, code, idxT.points);
    const strength = s ? s.score : null;
    strengths.push(strength);
    deltas.push(strength != null ? round2(strength - diff.score) : null);
  }
  const crossIdx = lastDeathCrossIndex(deltas);
  // 死叉之后至昨日「delta >= DELTA_MIN」的交易日数（允许前两次，>= 2 天即视为已消耗）
  let hitCount = 0;
  if (crossIdx >= 0) {
    for (let j = crossIdx + 1; j < deltas.length; j++) {
      if (deltas[j] != null && deltas[j] >= DELTA_MIN) hitCount++;
    }
  }
  // 上个交易日 delta > DELTA_MIN 时，该日成交量必须 ≥ 其前 3 个交易日成交量均值（即 volRatio >= 0）；
  // 数据缺失（volRatio 为 null）时不判定该限制
  const prevDayDelta = deltas.length > 0 ? deltas[deltas.length - 1] : null;
  const prevDayVolRatio = volRatios.length > 0 ? volRatios[volRatios.length - 1] : null;
  const prevDayStrength = strengths.length > 0 ? strengths[strengths.length - 1] : null;
  const prevDayVolumeOk = !(prevDayDelta != null && prevDayDelta > DELTA_MIN)
    || prevDayVolRatio == null
    || (Number.isFinite(prevDayVolRatio) && prevDayVolRatio >= 0);
  const consumed = hitCount >= 2;
  return { hasCross: crossIdx >= 0, consumed, hitCount, crossIdx, deltas, dates: crossDates, prevDayDelta, prevDayVolRatio, prevDayStrength, prevDayVolumeOk };
};

// 构建顺周期腿候选池（给定交易日 dateStr，不含当日）：
//   getRecentMultiLianbanStocks(dateStr, 10, 4) → 剔除 ST 等黑名单 / 创业板(30/301) / 科创板(688) / 题材黑名单
//   → 过去 20 个交易日（不含当日）日K + 连续 10 日子窗口区间最大涨幅 < 80% → 四连板后无单日跌幅 < -9%
//   → 过去 20 个交易日总涨幅 < 100% → 剔除与全量自选股科技股（isTech !== false）重叠者
// 返回 { stocks, poolFilterText, winDates }
const buildExtremeWinPool = async (dateStr) => {
  let base = [];
  let themeFilterText = '';
  try {
    const info = await getRecentMultiLianbanStocks(dateStr, LOOKBACK_DAYS, MIN_BOARD_COUNT);
    const themeRemoved = [];
    base = (info.stocks || []).filter(s => {
      if (EXCLUDED_CODES.has(s.code)) return false;
      if (isChiNextOrStar(s.code)) return false;
      if (isExcludedTheme(s.board)) { themeRemoved.push(s); return false; }
      return true;
    });
    if (themeRemoved.length > 0) {
      themeFilterText = `；题材黑名单（${EXCLUDED_THEMES.join('、')}）剔除 ${themeRemoved.length} 只（${themeRemoved.map(s => `${s.name || s.code}（${s.board}）`).join('、')}）`;
    }
  } catch (e) {
    return { stocks: [], poolFilterText: '', winDates: [] };
  }

  let winDates = [];
  try { winDates = await getPastTradingDates(dateStr, RANGE_WINDOW_DAYS); } catch (e) { winDates = []; }

  let poolFilterText = '';
  let candidates = [];
  if (base.length > 0) {
    try { await ensureBarsForCodes(new Set(base.map(s => s.code))); } catch (e) { /* 拉取失败按数据缺失处理 */ }
    if (winDates.length >= RANGE_WINDOW_DAYS) {
      const before = base.length;
      candidates = base.filter(s => {
        const rp = maxSlidingWindowRangePct(s.code, winDates, RANGE_SLIDE_DAYS);
        // 区间振幅缺失（日K未覆盖）视为不达标
        return rp != null && Number.isFinite(rp) && rp < MAX_WINDOW_RANGE_PCT;
      });
      const beforeDrop = candidates.length;
      candidates = candidates.filter(s => !hasPostLianbanBigDrop(s.code, s.date, winDates));
      const beforeTotal = candidates.length;
      candidates = candidates.filter(s => {
        const total = stockWindowRangePct(s.code, winDates);
        return total != null && Number.isFinite(total) && total < MAX_TOTAL_RANGE_PCT;
      });
      poolFilterText = `；过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < ${MAX_WINDOW_RANGE_PCT}% 剔除 ${before - beforeDrop} 只；四连板后出现单日涨幅 < ${POST_LIANBAN_DROP_PCT}% 再剔除 ${beforeDrop - beforeTotal} 只；过去 ${RANGE_WINDOW_DAYS} 个交易日总涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < ${MAX_TOTAL_RANGE_PCT}% 再剔除 ${beforeTotal - candidates.length} 只`;
    } else {
      poolFilterText = `；过去 ${RANGE_WINDOW_DAYS} 个交易日日K数据不足，本日无候选`;
    }
  }
  poolFilterText += themeFilterText;

  // 候选与全量自选股科技股（isTech !== false）重叠者剔除，不参与买入
  if (candidates.length > 0) {
    const techWatchlistCodes = getTechWatchlistCodes();
    if (techWatchlistCodes.size > 0) {
      const removedStocks = candidates.filter(s => techWatchlistCodes.has(s.code));
      if (removedStocks.length > 0) {
        candidates = candidates.filter(s => !techWatchlistCodes.has(s.code));
        poolFilterText += `；与全量自选股科技股（isTech ≠ false）重叠剔除 ${removedStocks.length} 只（${removedStocks.map(s => `${s.name || s.code}（${s.code}）`).join('、')}）`;
      }
    }
  }

  for (const s of candidates) s.poolFilterText = poolFilterText;
  return { stocks: candidates, poolFilterText, winDates };
};

module.exports = {
  LOOKBACK_DAYS, MIN_BOARD_COUNT, DEATH_CROSS_WINDOW, DELTA_MIN, CLOSE_MINUTE,
  RANGE_WINDOW_DAYS, RANGE_SLIDE_DAYS, MAX_WINDOW_RANGE_PCT, MAX_TOTAL_RANGE_PCT, POST_LIANBAN_DROP_PCT,
  PREV_STRENGTH_GAP_GATE, OPEN_GAP_MIN_PCT,
  isChiNextOrStar, hasPostLianbanBigDrop, maxSlidingWindowRangePct,
  getTechWatchlistCodes,
  computeCrossInfo, buildExtremeWinPool,
};
