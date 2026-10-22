// ============================================================
// 「情绪游资-极致胜率」顺周期腿候选池 + 死叉口径 公共模块
//   从 extremeWinBacktest.js 抽取，供「回测引擎」与「开盘实战页 live 龙头列表」共用同一份实现，
//   避免线上展示与回测口径漂移（2026-10-17 用户要求：开盘实战页切换模式后与回测买卖点完全一致）。
// ============================================================
const {
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanOccurrences,
  getMonitorStocks,
  stockVolumeRatioAt,
  stockWindowRangePct,
  stockDailyChange,
  getStockCloseOnOrBefore,
} = require('../deps');
const { iceResilienceIndexCode } = require('./indexGate');
const { EXCLUDED_CODES, EXCLUDED_THEMES, isExcludedTheme } = require('../constants');
const {
  round2,
  loadTlinePoints,
  maxMinuteDrop, closeDropFromHigh, diffDFrom,
  buildDiffDetail, strengthAtMinute,
} = require('./extremeWinScores');

// ---- 选股与死叉窗口常量（与回测引擎完全一致）----
const LOOKBACK_DAYS = 10;          // 选股回溯窗口：过去 10 个交易日
const MIN_BOARD_COUNT = 4;         // 连板门槛：四连板及以上（流通市值 ≤ 100 亿元者适用）
const BASE_MIN_BOARD_COUNT = 2;    // 连板基础门槛：两连板及以上（仅流通市值 > 100 亿元者适用）
const DEATH_CROSS_WINDOW = 10;     // 死叉检索窗口：过去 10 个交易日（不含当日）
const DELTA_MIN = 30;              // 买点门槛：今日「强度分 − 差劲分」>= 30
const CLOSE_MINUTE = 1500;         // 日线 delta 序列的收盘口径分钟（与「个股历史分析」一致）

// 2026-10-22 用户新增：连板基础名单按流通市值分档
//   流通市值 > 100 亿元：出现过两连板，且「含这两连板在内」的连续 5 个交易日累计涨幅 > 40% 即可入选
//   流通市值 ≤ 100 亿元（或市值数据缺失）：仍需四连板及以上
const LARGE_CAP_FLOAT_MV_YI = 100;      // 流通市值门槛（亿元）：严格大于该值适用两连板口径
const CAP_BOARD_WINDOW_DAYS = 5;        // 大市值个股的涨幅判定窗口：连续 5 个交易日（含两连板）
const CAP_BOARD_MIN_GAIN_PCT = 40;      // 该 5 日窗口累计涨幅须 > 40%

// 2026-10-17 用户要求：本策略候选池一律剔除创业板（30/301）与科创板（688）
const isChiNextOrStar = (code) => /^(30|688)/.test(String(code).replace(/^(sh|sz|bj)/i, ''));

// 动量过滤窗口：过去 20 个交易日（不含当日）
const RANGE_WINDOW_DAYS = 20;
const RANGE_SLIDE_DAYS = 10;
// 旧路径：最多 10 个交易日的最精准窗口区间最大涨幅 < 80%（先枚举长度 ≤ 10 的子窗口取最大涨幅者，再双向缩进）
const MAX_WINDOW_RANGE_PCT = 80;
// 整段 20 日总涨幅上限（两条路径共用）
const MAX_TOTAL_RANGE_PCT = 100;
// 新路径（2026-10-18 用户新增，与旧路径为「或」关系，满足其一即可入选）：
//   连板基础名单单独按「过去 20 个交易日（不含当日）内连板准入（市值分档规则同旧路径）」统计（不同于旧路径的 10 日）；
//   动量：最多 10 个交易日的最精准窗口区间最大涨幅 > 70%（2026-10-22 用户新增）且 < 100%，且「该窗口峰值日（窗内最高收盘日）」距买点严格相隔 ≥ 5 个交易日，
//   且峰值日（含峰值日本身，2026-10-21 用户改）到买点前之间的全部交易日区间最大波动 < 15%（区间最大波动 = (最高收盘价 − 最低收盘价) ÷ 最低收盘价 × 100）；
//   且该窗口内收盘跌幅 < -9% 的交易日至多 1 次（≥ 2 次剔除，2026-10-21 用户要求；不再完全豁免旧路径的 -9% 规则）
const NEW_MAX_WINDOW_RANGE_PCT = 100;
// 2026-10-22 用户新增：新路径在「最多 10 个交易日最精准窗口区间最大涨幅 < 100%」之外，
//   还要求该窗口区间最大涨幅（即 10 日滑动窗口内的最大涨幅峰值）严格 > 70%（形成 70%~100% 区间）
const NEW_MIN_WINDOW_RANGE_PCT = 70;
const PEAK_GAP_MIN_DAYS = 5;
const POST_PEAK_MAX_RANGE_PCT = 15;
const NEW_BASE_LOOKBACK_DAYS = 20;   // 新路径连板基础名单回溯窗口：过去 20 个交易日（不含当日）

// 连板准入事件（旧路径达标记录）之后若出现过任一交易日涨幅 < -9%，则该股从候选池剔除
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

// 过去若干交易日内「任意连续 slideDays 个交易日」的区间最大涨幅取最大值（%），并返回取到最大值的子窗口末位下标：
// 逐个子窗口调用 stockWindowRangePct 取最大；任一子窗口缺 K 线则返回 null（视为不达标）
// 返回 { max, endIdx }（endIdx 为 winDates 中该子窗口最后一天的下标，用于新路径的「峰值距今间隔」与「峰值后波动」判定）
const maxSlidingWindowRangeInfo = (code, winDates, slideDays) => {
  if (!Array.isArray(winDates) || winDates.length < slideDays) return null;
  let max = null;
  let endIdx = -1;
  for (let i = 0; i + slideDays <= winDates.length; i += 1) {
    const rp = stockWindowRangePct(code, winDates.slice(i, i + slideDays));
    if (rp == null || !Number.isFinite(rp)) return null;
    if (max == null || rp > max) { max = rp; endIdx = i + slideDays - 1; }
  }
  return { max, endIdx };
};

const maxSlidingWindowRangePct = (code, winDates, slideDays) => {
  const info = maxSlidingWindowRangeInfo(code, winDates, slideDays);
  return info ? info.max : null;
};

// 「最多 maxLen 个交易日」的最精准最大涨幅窗口（2026-10-18 用户要求：滑动窗口不再是固定 10 日，而是最多 10 日）：
//   1) 在 winDates 内枚举所有长度 1..maxLen 的子窗口，取区间涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 最大者为初选窗口；
//   2) 对该窗口做「双向缩进」：从首端/尾端依次剔除不影响该最大值的交易日，收敛到「同时包含窗内最高收盘日与最低收盘日的最短跨度」，
//      即最精准的最大涨幅区间（例：6.29~7.10 因尾部含 3 天下跌而被高估，缩进后得到 6.29~7.7）
//   返回 { max, startIdx, endIdx, startDate, endDate, lowIdx, peakIdx, peakDate, len }；任一相关交易日收盘价缺失时返回 null（视为不达标）
//   注：peakIdx = 窗内最高收盘日（峰值日）、lowIdx = 窗内最低收盘日；后续「峰值距今间隔 ≥ 5 交易日」
//       「峰值后区间最大波动 < 15%」等条件均以 peakIdx 为基准（下跌型窗口下 peakIdx 早于 endIdx，故不可用 endIdx）
const maxPreciseGainWindowInfo = (code, winDates, maxLen) => {
  if (!Array.isArray(winDates) || winDates.length < 1) return null;
  const closes = [];
  for (const d of winDates) {
    const c = getStockCloseOnOrBefore(code, Number(d));
    if (c == null || !Number.isFinite(c) || c <= 0) return null;
    closes.push(c);
  }
  const n = winDates.length;
  const limit = Math.min(maxLen, n);
  let best = null;   // { pct, startIdx, endIdx }
  for (let len = 1; len <= limit; len += 1) {
    for (let i = 0; i + len <= n; i += 1) {
      const j = i + len - 1;
      let mn = closes[i];
      let mx = closes[i];
      for (let k = i + 1; k <= j; k += 1) {
        if (closes[k] < mn) mn = closes[k];
        if (closes[k] > mx) mx = closes[k];
      }
      const pct = (mx - mn) / mn * 100;
      if (best == null || pct > best.pct) best = { pct, startIdx: i, endIdx: j };
    }
  }
  if (best == null) return null;
  // 双向缩进：取「同时包含一个窗内最高收盘日与一个窗内最低收盘日」的最短跨度
  let mnVal = Infinity;
  let mxVal = -Infinity;
  for (let k = best.startIdx; k <= best.endIdx; k += 1) {
    if (closes[k] < mnVal) mnVal = closes[k];
    if (closes[k] > mxVal) mxVal = closes[k];
  }
  const minIdxs = [];
  const maxIdxs = [];
  for (let k = best.startIdx; k <= best.endIdx; k += 1) {
    if (closes[k] === mnVal) minIdxs.push(k);
    if (closes[k] === mxVal) maxIdxs.push(k);
  }
  let span = Infinity;
  let startIdx = best.startIdx;
  let endIdx = best.endIdx;
  let lowIdx = startIdx;    // 窗内最低收盘日
  let peakIdx = endIdx;     // 窗内最高收盘日（即「峰值日」，为「峰值之后」相关条件的基准）
  for (const a of minIdxs) {
    for (const b of maxIdxs) {
      const s = Math.min(a, b);
      const e = Math.max(a, b);
      if (e - s < span) {
        span = e - s;
        startIdx = s;
        endIdx = e;
        lowIdx = a;
        peakIdx = b;
      }
    }
  }
  return {
    max: best.pct,
    startIdx,
    endIdx,
    startDate: winDates[startIdx],
    endDate: winDates[endIdx],
    lowIdx,
    peakIdx,
    peakDate: winDates[peakIdx],
    len: endIdx - startIdx + 1,
  };
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

// 死叉检索（2026-10-18 用户要求改为「峰值日之后的第一次死叉」）：
//   从 fromIdx 之后（严格晚于 fromIdx）起，取最先出现的「deltas[i-1] > 0 且 deltas[i] < 0」的下标；未找到返回 -1
//   deltas 为按日期升序的「强度分 − 差劲分」序列（元素可能为 null）；fromIdx 为 -1 时等价于在整个序列里取第一次死叉
const firstDeathCrossIndexAfter = (deltas, fromIdx) => {
  const start = Math.max(1, (Number.isFinite(Number(fromIdx)) ? Number(fromIdx) : -1) + 1);
  for (let i = start; i < deltas.length; i += 1) {
    const a = deltas[i - 1];
    const b = deltas[i];
    if (a == null || b == null) continue;
    if (Number(a) > 0 && Number(b) < 0) return i;
  }
  return -1;
};

// 判某候选在给定日期段（crossDates 升序，不含当日）是否满足买点前置：
//   构建日线「强度分 − 差劲分」序列（差劲分 / 强度分均按收盘 1500 口径）
//   → 死叉下标（2026-10-18 用户要求：由原来的「买点之前最近一次死叉」改为「峰值日之后的第一次死叉」——
//     窗口内首个 >= peakDate 的交易日即峰值日，取其之后的第一次死叉）→ 死叉之后 delta >= DELTA_MIN 的交易日计数
// 返回 { hasCross, consumed, hitCount, crossIdx, deltas, dates, prevDayDelta, prevDayVolRatio, prevDayStrength, prevDayVolumeOk }
const computeCrossInfo = async (code, crossDates, peakDate) => {
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
  // 峰值日在窗口内的下标（窗口内首个 >= peakDate 的交易日）；峰值早于窗口（不在窗口内）时视为整段都在峰值之后，记 -1
  const pv = Number(peakDate);
  const peakIdx = Number.isFinite(pv) ? crossDates.findIndex(d => Number(d) >= pv) : 0;
  const crossIdx = firstDeathCrossIndexAfter(deltas, peakIdx >= 0 ? peakIdx : -1);
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

// 大市值（流通市值 > 100 亿元）个股的连板准入判定（2026-10-22 用户新增）：
//   出现过两连板（该条快照记录的连板数 ≥ 2）且「含这两连板在内」的连续 5 个交易日累计涨幅 > 40%：
//   两连板命中日为 hitDate（快照日 = 第二板当日），前一日即第一板；枚举所有包含这两个交易日的 5 日窗口（最多 4 个），
//   窗口累计涨幅按复利口径（各交易日涨幅复利相乘，(∏(1+r)−1)×100，与「N 日涨幅」同口径），任一窗口 > 40% 即通过；日K缺失视为不通过
const windowCompoundGain = (code, dates) => {
  let acc = 1;
  for (const d of dates) {
    const chg = stockDailyChange(code, d);
    if (chg == null || !Number.isFinite(chg)) return null;
    acc *= 1 + chg / 100;
  }
  return parseFloat(((acc - 1) * 100).toFixed(4));
};

const largeCapBoardPass = (code, hitDate, winDates) => {
  if (!Array.isArray(winDates) || winDates.length < CAP_BOARD_WINDOW_DAYS) return false;
  const idx = winDates.findIndex(d => Number(d) === Number(hitDate));
  if (idx < 1) return false;   // 需在窗口内且存在前一交易日（两连板的第一板）
  for (let start = idx - (CAP_BOARD_WINDOW_DAYS - 1); start <= idx - 1; start += 1) {
    if (start < 0 || start + CAP_BOARD_WINDOW_DAYS > winDates.length) continue;
    const gain = windowCompoundGain(code, winDates.slice(start, start + CAP_BOARD_WINDOW_DAYS));
    if (gain != null && Number.isFinite(gain) && gain > CAP_BOARD_MIN_GAIN_PCT) return true;
  }
  return false;
};

// 构建顺周期腿候选池（给定交易日 dateStr，不含当日）：
//   两条路径各自统计连板基础名单并取并集（2026-10-18 用户要求）：
//     旧路径基础：过去 10 个交易日（不含当日）内满足下面的连板准入；
//     新路径基础：过去 20 个交易日（不含当日）内满足下面的连板准入（单独统计，范围更宽）
//   连板准入（2026-10-22 用户改，按流通市值分档）：
//     流通市值 > 100 亿元：出现过两连板，且含这两连板在内的连续 5 个交易日累计涨幅 > 40% 即可；
//     流通市值 ≤ 100 亿元（含市值数据缺失）：仍需四连板及以上
//   两份基础名单均先剔除 ST 等黑名单 / 创业板(30/301) / 科创板(688) / 题材黑名单
//   → 动量过滤（满足其一即入选）：
//       旧路径：最多 10 个交易日的最精准窗口区间最大涨幅 < 80%，且连板后无单日跌幅 < -9%，且过去 20 个交易日总涨幅 < 100%
//       新路径：最多 10 个交易日的最精准窗口区间最大涨幅 > 70% 且 < 100%，且该窗口峰值日（窗内最高收盘日）至买点前严格相隔 ≥ 5 个交易日，
//               且峰值日（含峰值日本身，2026-10-21 用户改）至买点前之间的全部交易日区间最大波动 < 15%，
//               且该窗口内收盘跌幅 < -9% 的交易日至多 1 次（≥ 2 次剔除，2026-10-21 用户要求），
//               且过去 20 个交易日总涨幅 < 100%
//   → 剔除与全量自选股科技股（isTech !== false）重叠者
// 返回 { stocks, poolFilterText, winDates }
const buildExtremeWinPool = async (dateStr) => {
  let themeFilterText = '';

  // 过去 RANGE_WINDOW_DAYS 个交易日（不含当日）日期序列：动量过滤与大市值「两连板后 5 日涨幅」判定共用
  let winDates = [];
  try { winDates = await getPastTradingDates(dateStr, RANGE_WINDOW_DAYS); } catch (e) { winDates = []; }

  // 两条路径的连板基础名单分别统计（不合并：保留每次出现的快照日与当日流通市值，
  //   以便大市值个股按「两连板 + 5 日涨幅 > 40%」逐次出现判定）
  let occOld = { stocks: [] };
  let occNew = { stocks: [] };
  try {
    occOld = await getRecentMultiLianbanOccurrences(dateStr, LOOKBACK_DAYS, BASE_MIN_BOARD_COUNT);
    occNew = await getRecentMultiLianbanOccurrences(dateStr, NEW_BASE_LOOKBACK_DAYS, BASE_MIN_BOARD_COUNT);
  } catch (e) {
    return { stocks: [], poolFilterText: '', winDates: [] };
  }
  const themeRemoved = [];
  const accept = (s, out) => {
    if (EXCLUDED_CODES.has(s.code)) return;
    if (isChiNextOrStar(s.code)) return;
    if (isExcludedTheme(s.board)) { themeRemoved.push(s); return; }
    out.push(s);
  };
  const rawOld = [];
  const rawNew = [];
  for (const s of occOld.stocks || []) accept(s, rawOld);
  for (const s of occNew.stocks || []) accept(s, rawNew);
  if (themeRemoved.length > 0) {
    const uniq = [...new Map(themeRemoved.map(s => [s.code, s])).values()];
    themeFilterText = `；题材黑名单（${EXCLUDED_THEMES.join('、')}）剔除 ${uniq.length} 只（${uniq.map(s => `${s.name || s.code}（${s.board}）`).join('、')}）`;
  }

  // 流通市值分档：严格 > 100 亿元为大市值（使用该次连板快照日的流通市值；缺失按小市值处理）
  const isLargeCap = (s) => s.floatMarketValueYi != null && Number.isFinite(Number(s.floatMarketValueYi))
    && Number(s.floatMarketValueYi) > LARGE_CAP_FLOAT_MV_YI;
  const needsBarCheck = (s) => isLargeCap(s) && Number(s.lianbanCount) >= BASE_MIN_BOARD_COUNT;

  // 大市值个股的 5 日涨幅判定需要日K：只为待校验的大市值记录预拉，避免无谓拉取全部两连板个股
  const pendingCodes = new Set([...rawOld, ...rawNew].filter(needsBarCheck).map(s => s.code));
  if (pendingCodes.size > 0 && winDates.length >= CAP_BOARD_WINDOW_DAYS) {
    try { await ensureBarsForCodes(pendingCodes); } catch (e) { /* 拉取失败按数据缺失处理（不通过） */ }
  }

  // 单条连板记录是否通过「连板准入」
  const boardPass = (s) => {
    if (!s) return false;
    const lb = Number(s.lianbanCount) || 0;
    if (isLargeCap(s)) return lb >= BASE_MIN_BOARD_COUNT && largeCapBoardPass(s.code, s.date, winDates);
    return lb >= MIN_BOARD_COUNT;
  };
  // 每条路径内按 code 去重（同 code 取连板数更高、命中日更晚的达标记录）
  const mergeQualified = (list) => {
    const map = new Map();
    for (const s of list) {
      if (!boardPass(s)) continue;
      const prev = map.get(s.code);
      if (!prev || s.lianbanCount > prev.lianbanCount
        || (s.lianbanCount === prev.lianbanCount && String(s.date) > String(prev.date))) map.set(s.code, s);
    }
    return Array.from(map.values());
  };
  const baseOld = mergeQualified(rawOld);
  const baseNew = mergeQualified(rawNew);

  // 合并两路径名单（同 code 取连板数更高、命中日更晚者），用于统一的日K计算
  const byCode = new Map();
  const merge = (s) => {
    const prev = byCode.get(s.code);
    if (!prev || s.lianbanCount > prev.lianbanCount
      || (s.lianbanCount === prev.lianbanCount && String(s.date) > String(prev.date))) byCode.set(s.code, s);
  };
  for (const s of baseOld) merge(s);
  for (const s of baseNew) merge(s);
  const oldCodes = new Set(baseOld.map(s => s.code));
  const newCodes = new Set(baseNew.map(s => s.code));

  let poolFilterText = '';
  let candidates = [];
  if (byCode.size > 0) {
    try { await ensureBarsForCodes(new Set(byCode.keys())); } catch (e) { /* 拉取失败按数据缺失处理 */ }
    if (winDates.length >= RANGE_WINDOW_DAYS) {
      // 旧路径：最多 10 日最精准窗口区间最大涨幅 < 80% + 连板后无单日跌幅 < -9% + 20 日总涨幅 < 100%
      const oldPass = (code, s, info) => {
        if (!info || !Number.isFinite(info.max) || !(info.max < MAX_WINDOW_RANGE_PCT)) return false;
        if (hasPostLianbanBigDrop(code, s.date, winDates)) return false;
        const total = stockWindowRangePct(code, winDates);
        return total != null && Number.isFinite(total) && total < MAX_TOTAL_RANGE_PCT;
      };
      // 新路径：最多 10 日最精准窗口区间最大涨幅 > 70%（2026-10-22 用户新增）且 < 100%
      //        + 该窗口峰值日（窗内最高收盘日）至买点前严格相隔 ≥ 5 交易日
      //        + 峰值日（含峰值日本身，2026-10-21 用户改）至买点前之间的全部交易日区间最大波动 < 15%
      //        + 该窗口内收盘跌幅 < -9% 的交易日至多 1 次（≥ 2 次剔除，2026-10-21 用户要求）+ 20 日总涨幅 < 100%
      const newPass = (code, info) => {
        if (!info || !Number.isFinite(info.max)) return false;
        if (!(info.max > NEW_MIN_WINDOW_RANGE_PCT)) return false;
        if (!(info.max < NEW_MAX_WINDOW_RANGE_PCT)) return false;
        const betweenDates = winDates.slice(info.peakIdx + 1);
        if (betweenDates.length < PEAK_GAP_MIN_DAYS) return false;
        // 波动窗口带上峰值日本身（2026-10-21 用户改：原 slice(peakIdx+1) 不含峰值日，峰值日回撤本身不计入波动）
        const postPeakDates = winDates.slice(info.peakIdx);
        const postPeakRange = stockWindowRangePct(code, postPeakDates);
        if (!(postPeakRange != null && Number.isFinite(postPeakRange) && postPeakRange < POST_PEAK_MAX_RANGE_PCT)) return false;
        // 峰值日（含）至买点前，收盘跌幅 < -9% 的交易日至多 1 次（≥ 2 次剔除；数据缺失日不计数）
        let bigDropCount = 0;
        for (const d of postPeakDates) {
          const chg = stockDailyChange(code, d);
          if (chg != null && Number.isFinite(chg) && chg < POST_LIANBAN_DROP_PCT) bigDropCount += 1;
        }
        if (bigDropCount > 1) return false;
        const total = stockWindowRangePct(code, winDates);
        return total != null && Number.isFinite(total) && total < MAX_TOTAL_RANGE_PCT;
      };
      let oldHit = 0;
      let newHit = 0;
      for (const [code, s] of byCode) {
        // 最精准窗口（最多 10 日）信息每只只算一次：区间最大涨幅 + 峰值日（旧/新两路径与后续死叉口径共用）
        const info = maxPreciseGainWindowInfo(code, winDates, RANGE_SLIDE_DAYS);
        const okOld = oldCodes.has(code) && oldPass(code, s, info);
        const okNew = newCodes.has(code) && newPass(code, info);
        if (okOld) oldHit += 1;
        else if (okNew) newHit += 1;
        // 2026-10-18 用户要求：候选挂上「峰值日」，后续死叉口径按「峰值之后的第一次死叉」计算
        if (okOld || okNew) candidates.push(info ? { ...s, peakDate: info.peakDate } : s);
      }
      poolFilterText = `；连板准入（2026-10-22 用户改）：流通市值 > ${LARGE_CAP_FLOAT_MV_YI} 亿元者「出现过两连板且含这两连板在内的连续 ${CAP_BOARD_WINDOW_DAYS} 个交易日累计涨幅 > ${CAP_BOARD_MIN_GAIN_PCT}%」，流通市值 ≤ ${LARGE_CAP_FLOAT_MV_YI} 亿元（含市值缺失）者「四连板及以上」；旧路径选股：过去 ${LOOKBACK_DAYS} 个交易日（不含当日）内达标 ${baseOld.length} 只，满足「最多 ${RANGE_SLIDE_DAYS} 个交易日的最精准窗口区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < ${MAX_WINDOW_RANGE_PCT}%」且「连板后无单日跌幅 < ${POST_LIANBAN_DROP_PCT}%」且「过去 ${RANGE_WINDOW_DAYS} 个交易日总涨幅 < ${MAX_TOTAL_RANGE_PCT}%」命中 ${oldHit} 只；新路径选股（2026-10-18 用户新增，与旧路径取并集）：过去 ${NEW_BASE_LOOKBACK_DAYS} 个交易日（不含当日）内达标 ${baseNew.length} 只，满足「最多 ${RANGE_SLIDE_DAYS} 个交易日的最精准窗口区间最大涨幅 > ${NEW_MIN_WINDOW_RANGE_PCT}%（2026-10-22 用户新增，要求 10 日滑动窗口最大涨幅峰值 > 70%）且 < ${NEW_MAX_WINDOW_RANGE_PCT}%」且「该窗口峰值日（窗内最高收盘日）至买点前严格相隔 ≥ ${PEAK_GAP_MIN_DAYS} 个交易日、峰值日（含峰值日本身，2026-10-21 用户改）至买点前之间全部交易日区间最大波动 < ${POST_PEAK_MAX_RANGE_PCT}%、该窗口内收盘跌幅 < ${POST_LIANBAN_DROP_PCT}% 的交易日至多 1 次（≥ 2 次剔除）」且「过去 ${RANGE_WINDOW_DAYS} 个交易日总涨幅 < ${MAX_TOTAL_RANGE_PCT}%」新增命中 ${newHit} 只；两路径去重后共 ${candidates.length} 只`;
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
  LOOKBACK_DAYS, MIN_BOARD_COUNT, BASE_MIN_BOARD_COUNT, DEATH_CROSS_WINDOW, DELTA_MIN, CLOSE_MINUTE,
  LARGE_CAP_FLOAT_MV_YI, CAP_BOARD_WINDOW_DAYS, CAP_BOARD_MIN_GAIN_PCT,
  RANGE_WINDOW_DAYS, RANGE_SLIDE_DAYS, MAX_WINDOW_RANGE_PCT, MAX_TOTAL_RANGE_PCT, POST_LIANBAN_DROP_PCT,
  NEW_MAX_WINDOW_RANGE_PCT, NEW_MIN_WINDOW_RANGE_PCT, PEAK_GAP_MIN_DAYS, POST_PEAK_MAX_RANGE_PCT, NEW_BASE_LOOKBACK_DAYS,
  PREV_STRENGTH_GAP_GATE, OPEN_GAP_MIN_PCT,
  isChiNextOrStar, hasPostLianbanBigDrop, largeCapBoardPass, maxSlidingWindowRangeInfo, maxSlidingWindowRangePct, maxPreciseGainWindowInfo,
  getTechWatchlistCodes,
  computeCrossInfo, buildExtremeWinPool,
};
