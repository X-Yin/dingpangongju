const { getKlineCached, getSingleStockTlineDataByDate } = require('../deps');
const { calculateReplayResilience, getTlinePoints } = require('../diagnose/sellPoint');

const buildReplayStocks = (campData) => {
  const timeBuckets = campData?.timeBuckets || [];
  const stockMap = new Map();
  const indexTline = { sh000688: [], sz399006: [] };
  const indexNames = { sh000688: '科创指数', sz399006: '创业板指数' };
  for (const bucket of timeBuckets) {
    const itl = bucket.indexTline || {};
    if (itl.kcb && itl.kcb.changePct != null) {
      indexTline.sh000688.push({ minute: bucket.minute, change: itl.kcb.changePct, lastPx: itl.kcb.price });
    }
    if (itl.cyb && itl.cyb.changePct != null) {
      indexTline.sz399006.push({ minute: bucket.minute, change: itl.cyb.changePct, lastPx: itl.cyb.price });
    }
    for (const sc of bucket.stockChanges) {
      if (!stockMap.has(sc.code)) {
        const lowByCode = campData.dailyLowByCode || {};
        stockMap.set(sc.code, { code: sc.code, stockName: sc.name, tlinePoints: [], dailyLowMap: lowByCode[sc.code] || null });
      }
      if (sc.changePct != null) {
        stockMap.get(sc.code).tlinePoints.push({ minute: bucket.minute, change: sc.changePct, lastPx: sc.lastPx });
      }
    }
  }
  Object.entries(indexTline).forEach(([code, points]) => {
    if (points.length > 0) {
      stockMap.set(code, { code, stockName: indexNames[code], isDefaultIndex: true, tlinePoints: points });
    }
  });
  return Array.from(stockMap.values()).filter(s => s.tlinePoints.length > 0);
};

// 真分钟级分时点映射（与前端 replayResilience.mapTlineLineToPoints 同规则）
const mapTlineToPoints = (tline) => (tline?.line || [])
  .filter(p => p && p.minute != null && p.last_px != null)
  .map(p => ({ minute: parseInt(p.minute), change: parseFloat(p.change || 0), lastPx: parseFloat(p.last_px) }))
  .sort((a, b) => a.minute - b.minute);

// 增强版回放数据构建：在训练营桶数据基础上，用真分钟级分时（getSingleStockTlineDataByDate 磁盘缓存，
// 与前端实时回放 /stock_tline_data 完全同源）替换股票与指数的 tlinePoints。
// 目的：消除 5 分钟桶粒度导致的口径偏差 —— 桶数据下抗分歧分数的 offenseScore（upRatio）样本不足会
// 显著偏低（例：景旺电子 2026-09-04 10:05 桶口径 8.96 vs 真分时口径 11.87，实时回放显示 11.6），
// 导致回测选股门槛（全局抗分歧 ≥9）与实时回放判定不一致。
// 单只拉取失败/无数据时保留原桶点回退（不阻塞回测）。合成股票走 getTlineCompat 的确定性分时。
const buildReplayStocksWithTline = async (campData, dateStr) => {
  const replayStocks = buildReplayStocks(campData);
  const dateNum = parseInt(dateStr, 10);
  if (!Number.isFinite(dateNum) || replayStocks.length === 0) return replayStocks;
  await Promise.all(replayStocks.map(async (s) => {
    try {
      const pts = mapTlineToPoints(await getSingleStockTlineDataByDate(s.code, dateNum));
      if (pts.length > 0) s.tlinePoints = pts;
    } catch (e) { /* 拉取失败保留桶点 */ }
  }));
  return replayStocks;
};

// 计算某只股票截至当前 minute 的日内抗分歧分数（供单股策略选股用，与卖点诊断条件4口径一致）
const calcResilienceAtMinute = (replayStocks, code, minute) => {
  const isSh688 = String(code).toLowerCase().startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const stockPoints = getTlinePoints(replayStocks, code, minute).filter(p => p.lastPx != null && p.lastPx > 0);
  const indexPoints = getTlinePoints(replayStocks, indexCode, minute);
  if (stockPoints.length < 5 || indexPoints.length < 5) return null;
  const raw = calculateReplayResilience(stockPoints, indexPoints, code);
  return raw != null ? parseFloat(raw.toFixed(2)) : null;
};

// ============================================================
// 「N.5 日涨幅最大」系列的 0.5 日成分缓存（2026-10-08 用户新增）：
// 0.5 日 = 更前一个交易日「下午 13:00 开盘 → 收盘」的涨幅（%）。
// 数据来源 = 该交易日回放桶（timeBuckets）中该股 minute >= 1300 的首个桶价 → 当日最后一个桶价（收盘）。
// 逐日回放时（含窗口预热日）在 extractDailyInfo 内顺带缓存，后续日期的选股直接查表（date → Map<code, pct>）。
// ============================================================
const afternoonGainCache = new Map(); // dateStr -> Map<code, pct>
const AFTERNOON_START_MINUTE = 1300;
const buildAfternoonGainMap = (campData) => {
  const buckets = campData?.timeBuckets || [];
  const firstPx = new Map(); // code -> 13:00 后首个桶价
  const lastPx = new Map(); // code -> 当日最后一个桶价（收盘）
  for (const b of buckets) {
    const m = Number(b.minute);
    if (!Number.isFinite(m)) continue;
    for (const sc of (b.stockChanges || [])) {
      const px = sc.lastPx != null ? Number(sc.lastPx) : null;
      if (px == null || !Number.isFinite(px) || px <= 0) continue;
      if (m >= AFTERNOON_START_MINUTE && !firstPx.has(sc.code)) firstPx.set(sc.code, px);
      lastPx.set(sc.code, px);
    }
  }
  const out = new Map();
  for (const [code, p0] of firstPx) {
    const close = lastPx.get(code);
    if (close != null && close > 0) out.set(code, ((close - p0) / p0) * 100);
  }
  return out;
};
// 查某交易日某股的下半日（13:00→收盘）涨幅；无该日缓存/该股无下午分时返回 null（候选按无效处理）
const getAfternoonGain = (dateStr, code) => {
  const m = afternoonGainCache.get(String(dateStr));
  if (!m) return null;
  const v = m.get(code);
  return v != null && Number.isFinite(v) ? v : null;
};

// 从回放数据提取每个股票「当日 EOD」信息：收盘涨幅、收盘价、当日抗分歧分数
// （当日抗分歧分数取 resilience3dScores 的最后一位，即 score(当天)，与 resilience3d 口径一致）
// dateStr 传入时顺带登记该交易日的「下半日涨幅」缓存（供 N.5 日窗口选股查表）
const extractDailyInfo = (campData, dateStr = null) => {
  const buckets = campData?.timeBuckets || [];
  const lastBucket = buckets[buckets.length - 1];
  const info = new Map();
  for (const sc of lastBucket?.stockChanges || []) {
    let resilience = null;
    if (Array.isArray(sc.resilience3dScores) && sc.resilience3dScores.length === 3) {
      const today = sc.resilience3dScores[2];
      if (today != null && !Number.isNaN(Number(today))) resilience = Number(today);
    }
    info.set(sc.code, {
      code: sc.code,
      name: sc.name || sc.code,
      changePct: sc.changePct != null ? Number(sc.changePct) : null,
      closePx: sc.lastPx != null ? Number(sc.lastPx) : null,
      resilience,
    });
  }
  if (dateStr != null) afternoonGainCache.set(String(dateStr), buildAfternoonGainMap(campData));
  return info;
};

// 窗口累计涨幅：winDates 最后一位为当日（用盘中涨幅），其余为历史 EOD 涨幅，复利相乘
const computeWindowGain = (code, winDates, dailyInfos, todayIntradayChange) => {
  let prod = 1;
  for (let i = 0; i < winDates.length; i++) {
    let ch;
    if (i === winDates.length - 1) {
      ch = todayIntradayChange != null ? Number(todayIntradayChange) : null;
    } else {
      ch = dailyInfos.get(winDates[i])?.get(code)?.changePct;
    }
    if (ch == null || !Number.isFinite(ch)) return null;
    prod *= 1 + ch / 100;
  }
  return (prod - 1) * 100;
};

// 「N.5 日涨幅」窗口累计涨幅：在 N 日窗口复利涨幅基础上，再复利计入「更前一个交易日
// （窗口最早交易日的再前一交易日，0.5 日）下午 13:00 → 收盘」的涨幅。
// halfDayDate 为 null（窗口前一日超出可用日期范围）时退化为常规 N 日窗口涨幅；
// 该股当日无下午分时（getAfternoonGain 返回 null）时返回 null，候选按无效处理（与窗口缺失口径一致）。
const computeWindowGainWithHalf = (code, winDates, dailyInfos, todayIntradayChange, halfDayDate) => {
  const base = computeWindowGain(code, winDates, dailyInfos, todayIntradayChange);
  if (base == null) return null;
  if (halfDayDate == null) return base;
  const half = getAfternoonGain(halfDayDate, code);
  if (half == null) return null;
  return ((1 + base / 100) * (1 + half / 100) - 1) * 100;
};

// 纯历史窗口累计涨幅（全部取历史 EOD 涨幅复利相乘，不含任何盘中口径）：
// 供「前N日跌幅&当日指标」系列（prev{N}d_fall_top5_day_*）第一阶段使用——窗口不含今日，
// 与 computeWindowGain「最后一位为当日」的约定不同，故独立成函数
const computeHistoricalWindowGain = (code, winDates, dailyInfos) => {
  let prod = 1;
  for (const d of winDates) {
    const ch = dailyInfos.get(d)?.get(code)?.changePct;
    if (ch == null || !Number.isFinite(ch)) return null;
    prod *= 1 + ch / 100;
  }
  return (prod - 1) * 100;
};

// 窗口抗分歧分数汇总：winDates 最后一位为当日（用盘中分数），其余为历史 EOD 分数
const computeWindowResilience = (code, winDates, dailyInfos, todayIntradayResilience) => {
  let sum = 0;
  for (let i = 0; i < winDates.length; i++) {
    let r;
    if (i === winDates.length - 1) {
      r = todayIntradayResilience != null ? Number(todayIntradayResilience) : null;
    } else {
      r = dailyInfos.get(winDates[i])?.get(code)?.resilience;
    }
    if (r == null || !Number.isFinite(r)) return null;
    sum += r;
  }
  return sum;
};

// 涨停判定（买入时点，全策略通用）：主板（60/00 开头）当日涨幅 > 9.5% 视为涨停；
// 创业板（sz30 开头）/科创板（sh68 开头）涨幅 > 19% 视为涨停。涨停股买入不可成交，
// 各选股路径遇到涨停候选一律剔除并顺延至排名下一只（重点板块系列的涨停过滤同此口径）
const isLimitUpAtBuy = (code, changePct) => {
  if (changePct == null || !Number.isFinite(Number(changePct))) return false;
  const growthBoard = String(code).startsWith('sz30') || String(code).startsWith('sh68');
  return Number(changePct) > (growthBoard ? 19 : 9.5);
};

// ============================================================
// 上一交易日一字板过滤（2026-10-05 新增，所有策略选股通用限制；同日放宽阈值）：
// 一字板定义 = 上一交易日竞价开盘涨幅、收盘涨幅、全天最低价涨幅三者均不低于阈值
//（主板 8%、创业板/科创板 16%，口径较真实一字板放宽：全天始终维持普涨、无低位上车机会）；
// 一字板次日常继续一字或大高开，难以低位上车且追高风险大 → 所有策略选股一律剔除该候选并顺延排名下一只。
// ============================================================
// klineBars：升序日K（getKlineCached 口径，字段 trade_date/open_px/close_px/low_px）；dateStr：买入日。
// 返回 true=上一交易日一字板 / false=非一字板 / null=数据不足无法判定（不拦截）
const isPrevDayOneWordBoard = (code, klineBars, dateStr) => {
  try {
    const bars = (klineBars || [])
      .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const target = parseInt(dateStr, 10);
    let idx = -1; // 上一交易日K线位置（trade_date < 买入日的最后一根）
    for (let i = bars.length - 1; i >= 0; i--) {
      if (Number(bars[i].trade_date) < target) { idx = i; break; }
    }
    if (idx < 1) return null; // 无上一交易日K线或缺上上交易日（无法取昨收）
    const prevBar = bars[idx];
    const preclose = Number(bars[idx - 1].close_px);
    const openPx = Number(prevBar.open_px);
    const lowPx = prevBar.low_px != null ? Number(prevBar.low_px) : null;
    const closePx = Number(prevBar.close_px);
    if (!(preclose > 0) || !(openPx > 0) || !(closePx > 0) || lowPx == null || !(lowPx > 0)) return null;
    const chg = (px) => ((px - preclose) / preclose) * 100;
    const growthBoard = String(code).startsWith('sz30') || String(code).startsWith('sh68');
    const threshold = growthBoard ? 16 : 8;
    return chg(openPx) >= threshold && chg(closePx) >= threshold && chg(lowPx) >= threshold;
  } catch (e) {
    return null;
  }
};

// 批量预取候选池「上一交易日一字板」代码集合：返回 Set<code>，供同步选股函数
// pickBestStock / pickWeakToStrongStock 使用。结果按 `${code}_${dateStr}` 进程内缓存
//（历史日K不可变，同一回测窗口内重复桶/重复日直接命中）
const prevOneWordBoardCache = new Map(); // `${code}_${dateStr}` -> true/false/null
const buildPrevOneWordBoardSet = async (codes, dateStr) => {
  const set = new Set();
  await Promise.all([...new Set(codes)].map(async (code) => {
    const key = `${code}_${dateStr}`;
    if (!prevOneWordBoardCache.has(key)) {
      let bars = null;
      try { bars = await getKlineCached(code, dateStr); } catch (e) { bars = null; }
      prevOneWordBoardCache.set(key, isPrevDayOneWordBoard(code, bars, dateStr));
    }
    if (prevOneWordBoardCache.get(key) === true) set.add(code);
  }));
  return set;
};

// ============================================================
// 个股顺/逆周期过滤（2026-10-06 用户新增，2026-10-06 扩展至全部策略）：
// 取候选股与创业板指在最近 N 个已完结交易日（截至买入日前一交易日收盘，不含买入日）的日收益率序列，
// 计算 Pearson 相关系数：corr > 阈值（正相关）= 顺周期（放行）；corr <= 阈值 = 逆周期（剔除并顺延排名下一只）。
// 含义：只做与大盘（创业板指）同向共振的股票，逆周期个股持有期胜率低。
// 数据不足（个股/指数共同交易日不足 N+1 个或方差为 0）时返回 null，不拦截（与其他过滤器口径一致）。
// 适用范围：除「情绪游资类（iceMode）」「三日情绪冰点类（emoAvgBuy）」「尾盘抄底类（tailDip）」
// 「重点板块类（keyBlockDays）」外的全部策略。
// ============================================================

module.exports = {
  AFTERNOON_START_MINUTE,
  afternoonGainCache,
  buildAfternoonGainMap,
  buildPrevOneWordBoardSet,
  buildReplayStocks,
  buildReplayStocksWithTline,
  calcResilienceAtMinute,
  computeHistoricalWindowGain,
  computeWindowGain,
  computeWindowGainWithHalf,
  computeWindowResilience,
  extractDailyInfo,
  getAfternoonGain,
  isLimitUpAtBuy,
  isPrevDayOneWordBoard,
  mapTlineToPoints,
  prevOneWordBoardCache,
};
