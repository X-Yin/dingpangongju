const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanOccurrences,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  getStockBarsCached,
  stockHighChangeAt,
  clearTlineMemCache,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { EXCLUDED_CODES, isExcludedTheme } = require('../constants');
const { getValuationMap, getBacktestValuationMap, ensureBacktestValuation } = require('../../watchlistValuation');
const fs = require('fs');
const path = require('path');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { round2, loadTlinePoints, clearTlineCache, limitUpThresholdOf, limitPctOf } = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

// ============================================================
// 放量洗盘-二板起爆（volumeWashoutMode: true，仅回测；独立引擎）
//   选股 = 「只放量无涨停-打二板」形态（参照 股票数据材料/只放量无涨停-打二板/washout.js）：
//     首板日 = 买点日前一交易日（T-1，必须为连板快照中的首板 lianbanCount === 1）；
//     首板日之前的日K上须出现「拉升放量 1~3 日 → 震荡缩量 2~12 日」：
//       拉升段均量 ≥ 前 5 日均量 1.8 倍、拉升段峰值成交量 ≥ 前 5 日均量 2 倍（2026-11-01 用户要求）、
//       拉升段累计涨幅 ≥ 3.5%、最大单日涨幅 ≥ 2%、最高价突破前 5 日最高价 1.02 倍；
//       震荡段最高收盘 ≤ 拉升段最高收盘 1.05、最低收盘 ≥ 拉升段最低收盘 0.85、震荡振幅 ≤ 20%、平台振幅 ≤ 25%；
//       震荡均量 ≤ 拉升均量 0.8、震荡最大量 ≤ 拉升最大量 0.95、后半段均量 ≤ 前半段均量 0.95；
//       首板收盘 ≥ 震荡最高收盘 1.01、首板量 ≥ 震荡最后一日量 1.2、
//       首板量 ≤ 拉升段峰值日量 1.2（2026-11-01 用户要求：首板成交量不得超过更前面量能峰值日的 20% 以上，按成交量而非成交额）。
//   首板日（T-1）分时限制（2026-11-01 用户要求）：
//     ① 断板次数 ≤ 1（断板一次可接受，出现第 2 次断板即剔除）；
//     ② 封住涨停满 20 分钟后（断板回封重新计时）到收盘，封死涨停期间不得漏量——
//        任一分钟成交量 > 「封死涨停那一分钟」成交量的 130% 即视为漏量（按成交量而非成交金额）；
//        20 分钟按交易分钟计算：剔除午休 11:30–13:00（如 11:15 封板 → 13:05 起检查，而非 11:35）。
//     叠加过滤（用户要求）：震荡区间内单日涨跌幅须在 ±5% 之内，跌幅 -5%~-6%（不含两端）最多 1 天，
//       跌幅超过 -6% 一律剔除；震荡最低价不得低于「首次爆量（拉升段首日）开盘价」的 -5%
//       （即 (首次爆量开盘价 − 震荡最低价) ÷ 首次爆量开盘价 ≤ 5%）。
//   候选池统一剔除：创业板（30/301）、科创板（688）、代码黑名单（源杰科技/联讯仪器）、
//     题材黑名单（芯片/半导体/算力/PCB/光模块/液冷等，含派生板块名）；
//     过去 15 个交易日内出现过 ≥3 板者一律剔除；
//     买点日前 20 个交易日内任意连续 3 个交易日的涨幅最大值 > 20% 者剔除；
//     总市值 ≤ 100 亿元（2026-11-01 用户要求，由流通市值改为总市值；总股本近似不变，市值 ∝ 股价；
//     先按当下总市值反推总股本，预筛用前一交易日收盘价、买入时按买入价复核）。
//   买点：竞价必须高开（9:30 开盘价 > 昨收），之后在 9:30–14:30 内按 1 分钟回溯，
//     分时涨幅首次达到 +8% 时按该分钟分时价买入；竞价一字板（开盘即涨停）买不进。
//   卖点：七条（①~⑤ 与「首板洗盘-起爆拉升」同口径，⑥⑦ 为本策略新增）——
//     ① 跌破 5 日线（MA5 = 当日之前 5 个交易日收盘均值；收益率未拉开 +20% 盘中卖 / 已拉开 +20% 收盘卖）
//     ② 跌破成本线 -3%（连续 5 分钟才卖）/ -5%（立即卖）
//     ③ 盘中跌停（分时跌幅 ≤ -9%）立即卖
//     ④ 买入当日收盘涨停、次日收盘未涨停 → 次日收盘卖出
//     ⑤ 买入后次日竞价低开 → 次日 9:30 竞价卖出（早于当日盘中卖点与 ④）
//     ⑥ 收益率未拉开 +20% 之前（收盘口径历史最高收益 < +20%），买入次日起只要某一天收盘未涨停就在当日收盘卖出
//        （A 股 T+1，买入当日不卖；已拉开 +20% 后该条不再触发，④ 仍按原口径生效）
//     ⑦ 收益率未拉开 +20% 之前，任一持仓交易日竞价低开超过 -3%（开盘涨幅 < -3%）→ 当日 9:30 按竞价开盘价卖出
//        （T+1 已由 ⑤ 以「任意低开」口径先卖，⑦ 实际对 T+2 起生效；已拉开 +20% 后不再触发）
//   仓位：账户拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票，各自独立买卖。
// ============================================================

const BUY_TRIGGER_PCT = 8;          // 分时涨幅首次达到 +8% 即买入
const BUY_START_MINUTE = 930;       // 买点最早 9:30
const BUY_CUTOFF_MINUTE = 1430;     // 买点最晚 14:30（之后不再追买）
const MAX_FLOAT_MV_YI = 100;        // 流通市值（按买入日股价折算）须 ≤ 100 亿元（线上口径）
const MAX_TOTAL_MV_YI = 100;        // 回测口径：总市值（按买入日股价折算）须 ≤ 100 亿元（2026-11-01 用户要求，替代流通市值）
const MAX_WIN3_GAIN_PCT = 20;       // 买点日前 20 个交易日内最大三日滑动窗口涨幅 ≤ 20%
const WIN3_LOOKBACK_DAYS = 20;      // 三日滑动窗口涨幅的回溯交易日数
const MAX_POSITIONS = 2;            // 账户拆两份、每份半仓，最多同时持有 2 只不同股票
// 首板日（T-1）分时限制（2026-11-01 用户要求）：
//   ① 断板次数 ≤ 1（断板一次可以接受，出现第 2 次断板即剔除）；
//   ② 封住涨停满 20 分钟之后（断板回封重新计时）到收盘，处于封死涨停期间不得漏量——
//      某一分钟成交量 > 「封死涨停的那一分钟」成交量的 130% 即视为漏量（按成交量而非成交金额）；
//      20 分钟按交易分钟计算（剔除午休 11:30–13:00，如 11:15 封板则从 13:05 起检查）。
const BOARD_MAX_BREAKS = 1;
const BOARD_LEAK_MIN_AFTER_SEAL = 20;
const BOARD_LEAK_VOL_RATIO = 1.3;
const WASHOUT_LOOKBACK_DAYS = 15;   // 连板快照回溯 15 个交易日（T-1 首板 + 15 日内 ≥3 板剔除）

// 「只放量无涨停-打二板」washout 参数（基准与 股票数据材料/只放量无涨停-打二板/washout.js 默认值一致），
// 末尾四项为用户新增的震荡区间过滤；PULL_PEAK_VOL_RATIO 为 2026-11-01 用户要求新增：
// 放量段峰值成交量须 ≥ 前 5 日均量的 2 倍（与仅单日拉升时的阈值一致）
const VOL_WASHOUT_OPT = {
  LOOKBACK: 60,
  PULL_MIN_DAYS: 1,
  PULL_MAX_DAYS: 3,
  PRE_VOL_DAYS: 5,
  PULL_AVG_VOL_RATIO: 1.8,
  PULL_DAY_VOL_RATIO: 1.3,
  PULL_PEAK_VOL_RATIO: 2.0,        // 放量段峰值成交量 ≥ 前 5 日均量 2 倍（2026-11-01 用户要求）
  PULL_SINGLE_DAY_VOL_RATIO: 2.0,  // 仅 1 天拉升时该日（即峰值日）量 ≥ 2 倍
  PULL_MIN_GAIN_PCT: 3.5,
  PULL_MIN_MAX_DAY_GAIN_PCT: 2.0,
  PULL_BREAK_PRE_HIGH_RATIO: 1.02,
  SHOCK_MIN_DAYS: 2,
  SHOCK_MAX_DAYS: 12,
  SHOCK_UP_TOL: 1.05,
  SHOCK_DOWN_TOL: 0.85,
  MAX_SHOCK_RANGE: 0.20,
  MAX_PLATFORM_RANGE: 0.25,
  SHOCK_VOL_RATIO: 0.8,
  SHOCK_MAX_VOL_RATIO: 0.95,
  SHOCK_HALF_VOL_RATIO: 0.95,
  BOARD_LIMIT_CHANGE: 9.5,
  BOARD_BREAK_SHOCK_CLOSE_RATIO: 1.01,
  BOARD_LAST_VOL_RATIO: 1.2,
  BOARD_MAX_VS_PEAK_VOL_RATIO: 1.2,   // 首板日成交量不得超过拉升段峰值日成交量的 120%（2026-11-01 用户要求，按成交量而非成交额）
  SHOCK_MAX_DAY_GAIN_PCT: 5,          // 震荡期单日最大涨幅 ≤ +5%
  SHOCK_MID_DROP_PCT: -5,             // 跌幅低于该线（且不低于 -6%）的交易日
  SHOCK_DEEP_DROP_PCT: -6,            // 跌幅低于该线一律剔除
  SHOCK_MAX_MID_DROP_DAYS: 1,         // 跌幅 -5%~-6%（不含两端）最多 1 天
  SHOCK_LOW_VS_PULL_OPEN_PCT: -5,     // 震荡最低价不得低于首次爆量开盘价 -5%
};

// 候选池一律剔除创业板（30/301）与科创板（688）
const isChiNextOrStar = (code) => /^(30|688)/.test(String(code || '').replace(/^(sh|sz|bj)/i, ''));

// 「东方财富板块成分股汇总」全量题材映射（同「首板洗盘-起爆拉升」口径）
const BOARD_DIR = path.resolve(__dirname, '../../../data/东方财富板块成分股汇总');
const BOARD_CACHE_TTL_MS = 60 * 1000;
let themeBlockCache = null;
const getThemeBlockIndex = () => {
  const now = Date.now();
  if (themeBlockCache && now - themeBlockCache.checkedAt < BOARD_CACHE_TTL_MS) return themeBlockCache;
  try {
    const names = fs.readdirSync(BOARD_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('_blocks.json'));
    const mtimeMs = names.reduce((mx, f) => Math.max(mx, fs.statSync(path.join(BOARD_DIR, f)).mtimeMs), 0);
    if (themeBlockCache && themeBlockCache.mtimeMs === mtimeMs) {
      themeBlockCache.checkedAt = now;
      return themeBlockCache;
    }
    const map = new Map();
    for (const f of names) {
      const blockName = f.replace(/\.json$/, '');
      try {
        const list = JSON.parse(fs.readFileSync(path.join(BOARD_DIR, f), 'utf-8'));
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const code = String((item && item.code) || '').trim();
          if (!/^\d{6}$/.test(code)) continue;
          if (!map.has(code)) map.set(code, []);
          map.get(code).push(blockName);
        }
      } catch (e) { /* 单个板块文件损坏忽略 */ }
    }
    const excludedCodes = new Set();
    for (const [code, blockNames] of map) {
      if (blockNames.some((n) => isExcludedTheme(n))) excludedCodes.add(code);
    }
    themeBlockCache = { checkedAt: now, mtimeMs, map, excludedCodes };
    return themeBlockCache;
  } catch (e) {
    themeBlockCache = { checkedAt: now, mtimeMs: 0, map: new Map(), excludedCodes: new Set() };
    return themeBlockCache;
  }
};
const isThemeExcluded = (code, board) => {
  if (isExcludedTheme(board)) return true;
  return getThemeBlockIndex().excludedCodes.has(String(code || '').replace(/^(sh|sz|bj)/i, ''));
};

// 总市值换算（2026-11-01 用户要求由流通市值改为总市值口径）：
//   当下总市值 ÷ 当下股价 → 总股本 → × 目标日股价 → 目标日总市值。
// 「当下总市值」优先取 data/backtest_stock_valuation.json（财联社 mc，非自选股也可覆盖），
// 其次 monitor_stocks_valuation.json（自选股）；数据缺失返回 null（不拦截）。
const VALUATION_MV_BASE_DATE = 99999999;
const totalMvInfoFor = (code, targetDate) => {
  const bt = getBacktestValuationMap().get(code);
  const watch = getValuationMap().get(code);
  const mcNow = bt && Number.isFinite(Number(bt.marketValue)) && Number(bt.marketValue) > 0
    ? Number(bt.marketValue)
    : (watch && Number.isFinite(Number(watch.marketValue)) && Number(watch.marketValue) > 0
      ? Number(watch.marketValue) : null);
  if (mcNow == null) return null;
  const baseDate = VALUATION_MV_BASE_DATE;
  const mvYi = mcNow / 1e8;
  const cBase = getStockCloseOnOrBefore(code, baseDate);
  const shares = cBase > 0 ? (mvYi * 1e8) / cBase : null; // 总股本（股）
  const cTarget = targetDate ? getStockCloseOnOrBefore(code, targetDate) : null;
  const mvYiAtTarget = shares != null && cTarget > 0 ? (shares * cTarget) / 1e8 : mvYi;
  return { mvYi: mvYiAtTarget, shares, baseMvYi: mvYi, baseDate, baseClose: cBase, targetClose: cTarget, source: 'current' };
};

// ============================================================
// 「只放量无涨停-打二板」前置形态判定（参照 washout.js 的 isPotentialBullWashout）：
//   给定首板日 boardDateNum（本策略均为 T-1），在其之前枚举「拉升放量段 1~3 日 + 震荡缩量段 2~12 日」，
//   要求首板日本身涨停、首板收盘突破震荡最高收盘、首板量 ≥ 震荡最后一日量 1.2 倍。
//   返回明细对象；不满足返回 null。
// ============================================================
const matchVolumeWashout = (bars, boardDateNum, options = {}) => {
  const opt = { ...VOL_WASHOUT_OPT, ...options };
  if (!Array.isArray(bars) || bars.length < opt.PRE_VOL_DAYS + 3) return null;

  const dNum = bars.map((b) => Number(b.d));
  const close = bars.map((b) => Number(b.c));
  const open = bars.map((b) => (Number(b.o) > 0 ? Number(b.o) : null));
  const high = bars.map((b) => (Number(b.h) > 0 ? Number(b.h) : Number(b.c)));
  const low = bars.map((b) => (Number(b.l) > 0 ? Number(b.l) : Number(b.c)));
  const vol = bars.map((b) => (Number(b.v) > 0 ? Number(b.v) : 0));
  const pct = close.map((c, i) => (i > 0 && close[i - 1] > 0 ? ((c / close[i - 1]) - 1) * 100 : 0));

  let boardIdx = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (dNum[i] === boardDateNum) { boardIdx = i; break; }
  }
  if (boardIdx < opt.PRE_VOL_DAYS) return null;

  // 首板日本身必须涨停（收盘涨幅 ≥ 9.5% 或收盘 ≥ 昨收 × 1.095）
  const boardClose = close[boardIdx];
  const prevClose = close[boardIdx - 1];
  const boardLimitUp = pct[boardIdx] >= opt.BOARD_LIMIT_CHANGE
    || (prevClose > 0 && boardClose >= prevClose * 1.095);
  if (!boardLimitUp) return null;

  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
  const startLimit = Math.max(0, boardIdx - opt.LOOKBACK);

  for (let shockLen = opt.SHOCK_MIN_DAYS; shockLen <= opt.SHOCK_MAX_DAYS; shockLen += 1) {
    const e = boardIdx - 1 - shockLen;
    if (e < startLimit) continue;

    for (let pullLen = opt.PULL_MIN_DAYS; pullLen <= opt.PULL_MAX_DAYS; pullLen += 1) {
      const s = e - pullLen + 1;
      if (s - opt.PRE_VOL_DAYS < 0) continue;

      const pullStart = s;
      const pullEnd = e;
      const preStart = s - opt.PRE_VOL_DAYS;
      // 量能缺失视为无效
      let volOk = true;
      for (let i = preStart; i <= boardIdx; i += 1) {
        if (!(vol[i] > 0) || !(close[i] > 0)) { volOk = false; break; }
      }
      if (!volOk) continue;

      const pre5AvgVol = avg(vol.slice(preStart, s));
      const pullAvgVol = avg(vol.slice(s, e + 1));
      const pullMaxVol = Math.max(...vol.slice(s, e + 1));
      if (!(pre5AvgVol > 0) || !(pullAvgVol > 0)) continue;
      if (pullAvgVol < pre5AvgVol * opt.PULL_AVG_VOL_RATIO) continue;
      // 放量峰值须 ≥ 前 5 日均量 2 倍（2026-11-01 用户要求；单日拉升时该日即为峰值）
      if (pullMaxVol < pre5AvgVol * opt.PULL_PEAK_VOL_RATIO) continue;

      const dayVolOk = vol.slice(s, e + 1)
        .filter((v) => v >= pre5AvgVol * opt.PULL_DAY_VOL_RATIO).length;
      if (dayVolOk < Math.min(2, pullLen)) continue;
      if (pullLen === 1 && vol[s] < pre5AvgVol * opt.PULL_SINGLE_DAY_VOL_RATIO) continue;

      const prevCloseBeforePull = close[s - 1];
      const pullEndClose = close[e];
      if (!(prevCloseBeforePull > 0)) continue;
      const pullGainPct = ((pullEndClose / prevCloseBeforePull) - 1) * 100;
      if (pullGainPct < opt.PULL_MIN_GAIN_PCT) continue;

      let pullMaxDayGain = -Infinity;
      for (let i = s; i <= e; i += 1) if (pct[i] > pullMaxDayGain) pullMaxDayGain = pct[i];
      if (pullMaxDayGain < opt.PULL_MIN_MAX_DAY_GAIN_PCT) continue;

      const pre5High = Math.max(...high.slice(preStart, s));
      const pullHigh = Math.max(...high.slice(s, e + 1));
      if (!(pre5High > 0) || pullHigh < pre5High * opt.PULL_BREAK_PRE_HIGH_RATIO) continue;

      // ---- 震荡区间与缩量 ----
      const shockStart = e + 1;
      const shockEnd = boardIdx - 1;
      const pullHighClose = Math.max(...close.slice(s, e + 1));
      const pullLowClose = Math.min(...close.slice(s, e + 1));
      const pullLow = Math.min(...low.slice(s, e + 1));
      const shockHigh = Math.max(...high.slice(shockStart, shockEnd + 1));
      const shockLow = Math.min(...low.slice(shockStart, shockEnd + 1));
      const shockHighClose = Math.max(...close.slice(shockStart, shockEnd + 1));
      const shockLowClose = Math.min(...close.slice(shockStart, shockEnd + 1));
      if (!(pullHighClose > 0) || !(pullLowClose > 0) || !(shockHigh > 0) || !(shockLow > 0)) continue;

      if (shockHighClose > pullHighClose * opt.SHOCK_UP_TOL) continue;
      if (shockLowClose < pullLowClose * opt.SHOCK_DOWN_TOL) continue;

      const shockRange = (shockHigh - shockLow) / shockLow;
      if (shockRange > opt.MAX_SHOCK_RANGE) continue;

      const platformHigh = Math.max(pullHigh, shockHigh);
      const platformLow = Math.min(pullLow, shockLow);
      if (!(platformLow > 0)) continue;
      const platformRange = (platformHigh - platformLow) / platformLow;
      if (platformRange > opt.MAX_PLATFORM_RANGE) continue;

      const shockAvgVol = avg(vol.slice(shockStart, shockEnd + 1));
      const shockMaxVol = Math.max(...vol.slice(shockStart, shockEnd + 1));
      if (shockAvgVol > pullAvgVol * opt.SHOCK_VOL_RATIO) continue;
      if (shockMaxVol > pullMaxVol * opt.SHOCK_MAX_VOL_RATIO) continue;

      if (shockLen >= 4) {
        const mid = Math.floor(shockLen / 2);
        const firstHalfAvg = avg(vol.slice(shockStart, shockStart + mid));
        const secondHalfAvg = avg(vol.slice(shockStart + mid, shockEnd + 1));
        if (firstHalfAvg > 0 && secondHalfAvg > firstHalfAvg * opt.SHOCK_HALF_VOL_RATIO) continue;
      }

      // ---- 首板突破确认 ----
      if (boardClose < shockHighClose * opt.BOARD_BREAK_SHOCK_CLOSE_RATIO) continue;
      const lastShockVol = vol[shockEnd];
      if (vol[boardIdx] < lastShockVol * opt.BOARD_LAST_VOL_RATIO) continue;
      // 首板日成交量不得超过前面「量能峰值那一天」的 120%（2026-11-01 用户要求，按成交量 v 判定）
      if (vol[boardIdx] > pullMaxVol * opt.BOARD_MAX_VS_PEAK_VOL_RATIO) continue;

      // ---- 震荡期单日涨跌幅过滤（用户要求）----
      let maxDayPct = -Infinity;
      let minDayPct = Infinity;
      let deepDropDays = 0;
      let midDropDays = 0;
      for (let i = shockStart; i <= shockEnd; i += 1) {
        if (pct[i] > maxDayPct) maxDayPct = pct[i];
        if (pct[i] < minDayPct) minDayPct = pct[i];
        if (pct[i] < opt.SHOCK_DEEP_DROP_PCT) deepDropDays += 1;
        else if (pct[i] < opt.SHOCK_MID_DROP_PCT && pct[i] > opt.SHOCK_DEEP_DROP_PCT) midDropDays += 1;
      }
      if (maxDayPct > opt.SHOCK_MAX_DAY_GAIN_PCT) continue;
      if (deepDropDays > 0) continue;
      if (midDropDays > opt.SHOCK_MAX_MID_DROP_DAYS) continue;

      // ---- 震荡最低价不得低于首次爆量开盘价 -5%（用户要求；开盘价缺失时该项不拦截）----
      const pullOpen = open[pullStart];
      let lowVsPullOpenPct = null;
      if (pullOpen != null && pullOpen > 0) {
        lowVsPullOpenPct = ((pullOpen - shockLow) / pullOpen) * 100;
        if (lowVsPullOpenPct > Math.abs(opt.SHOCK_LOW_VS_PULL_OPEN_PCT)) continue;
      }

      return {
        boardDate: String(bars[boardIdx].d),
        boardOpen: round2(open[boardIdx]),
        boardClose: round2(boardClose),
        boardPct: round2(pct[boardIdx]),
        boardVol: round2(vol[boardIdx]),
        pullStartDate: String(bars[pullStart].d),
        pullEndDate: String(bars[pullEnd].d),
        pullDays: pullLen,
        pullOpen: round2(pullOpen),
        pullGainPct: round2(pullGainPct),
        pullMaxDayGain: round2(pullMaxDayGain),
        pullAvgVol: round2(pullAvgVol),
        pullMaxVol: round2(pullMaxVol),
        preVolAvg: round2(pre5AvgVol),
        pullVolRatio: round2(pullAvgVol / pre5AvgVol),
        pullMaxVolRatio: round2(pullMaxVol / pre5AvgVol),
        boardVsPeakVolPct: round2((vol[boardIdx] / pullMaxVol) * 100),
        shockStartDate: String(bars[shockStart].d),
        shockEndDate: String(bars[shockEnd].d),
        shockDays: shockLen,
        platformHigh: round2(platformHigh),
        platformLow: round2(platformLow),
        shockLow: round2(shockLow),
        shockRangePct: round2(shockRange * 100),
        platformRangePct: round2(platformRange * 100),
        shockAvgVolRatioPct: round2((shockAvgVol / pullAvgVol) * 100),
        shockMaxVolRatioPct: round2((shockMaxVol / pullMaxVol) * 100),
        maxDayPct: round2(maxDayPct),
        minDayPct: round2(minDayPct),
        deepDropDays,
        midDropDays,
        lowVsPullOpenPct: lowVsPullOpenPct != null ? round2(lowVsPullOpenPct) : null,
      };
    }
  }
  return null;
};

// ============================================================
// 首板日（T-1）分时检查（2026-11-01 用户要求）：
//   ① 断板次数：分时价触及涨停价后回落算 1 次断板；允许 1 次，出现第 2 次即剔除。
//   ② 封板漏量：每次封住涨停（含断板后回封，重新计时）后满 20 分钟起、直到收盘，
//      只要仍处于封死涨停状态，任一分钟成交量 > 「封板那一分钟」成交量的 130% 即视为漏量、剔除。
//      判定用分时每分钟成交量（THS/CLS 的逐分钟增量），不是成交金额；量能缺失的分钟跳过。
//      20 分钟按**交易分钟**计算：剔除午休 11:30–13:00，只统计 9:30–11:30 与 13:00–15:00
//      （如 11:15 封板，则从 13:05 起检查漏量，而不是 11:35）。
//   分时数据缺失时按「不拦截」处理（与其它数据缺失口径一致）。
// ============================================================
// 两个 HHMM 分钟之间相隔的「交易分钟数」（只算 9:30–11:30、13:00–15:00，剔除午休与盘后）
const tradingMinutesBetween = (fromMinute, toMinute) => {
  if (fromMinute == null || toMinute == null) return null;
  const toAbs = (m) => Math.floor(Number(m) / 100) * 60 + (Number(m) % 100);
  const a = toAbs(fromMinute);
  const b = toAbs(toMinute);
  if (!(b > a)) return 0;
  const segments = [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]];
  let total = 0;
  for (const [s, e] of segments) total += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return total;
};

const analyzeBoardDayTline = (code, tline) => {
  if (!tline || !(tline.preclose > 0) || !Array.isArray(tline.points) || tline.points.length === 0) {
    return { skipped: true, breaks: null, sealed: false, sealMinute: null, sealVol: null, maxLeakRatioPct: null, maxLeakMinute: null, leakCount: 0 };
  }
  const limitPrice = tline.preclose * (1 + limitPctOf(code) / 100);
  const eps = 0.001;
  let breaks = 0;
  let sealed = false;
  let sealMinute = null;
  let sealVol = null;
  let maxLeakRatio = null;
  let maxLeakMinute = null;
  let leakCount = 0;
  for (const p of tline.points) {
    if (!(p.lastPx > 0)) continue;
    const atLimit = p.lastPx >= limitPrice - eps;
    if (atLimit) {
      if (!sealed) {
        // 首次封板 / 断板后回封：重新计时，基准量取封板这一分钟的成交量
        sealed = true;
        sealMinute = p.minute;
        sealVol = p.vol != null && p.vol > 0 ? p.vol : null;
      } else if (sealVol != null && p.vol != null && p.vol > 0
        && tradingMinutesBetween(sealMinute, p.minute) >= BOARD_LEAK_MIN_AFTER_SEAL) {
        const ratio = p.vol / sealVol;
        if (maxLeakRatio == null || ratio > maxLeakRatio) {
          maxLeakRatio = ratio;
          maxLeakMinute = p.minute;
        }
        if (ratio > BOARD_LEAK_VOL_RATIO) leakCount += 1;
      }
    } else if (sealed) {
      sealed = false;
      breaks += 1;
      sealMinute = null;
      sealVol = null;
    }
  }
  const failed = breaks > BOARD_MAX_BREAKS || leakCount > 0;
  return {
    skipped: false,
    breaks,
    sealed,
    sealMinute,
    sealVol: sealVol != null ? round2(sealVol) : null,
    maxLeakRatioPct: maxLeakRatio != null ? round2(maxLeakRatio * 100) : null,
    maxLeakMinute,
    leakCount,
    failed,
  };
};

// 买点日前 20 个交易日内「三日滑动窗口涨幅」最大值（末日收盘 − 窗口前一日收盘 ÷ 窗口前一日收盘）；
// 只统计买点日前一交易日及更早日K（不含买点日，避免未来函数）；历史不足返回 null（该项不拦截）
const maxThreeDayWindowGain = (bars, dateNum, lookback = WIN3_LOOKBACK_DAYS) => {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  let dIdx = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (Number(bars[i].d) <= dateNum) dIdx = i;
    else break;
  }
  const eIdx = dIdx - 1;
  if (eIdx < 3) return null;
  const start = Math.max(0, eIdx - lookback + 1);
  let maxPct = -Infinity;
  for (let i = start + 3; i <= eIdx; i += 1) {
    const base = Number(bars[i - 3].c);
    const cur = Number(bars[i].c);
    if (!(base > 0) || !(cur > 0)) continue;
    const pct = ((cur - base) / base) * 100;
    if (pct > maxPct) maxPct = pct;
  }
  return Number.isFinite(maxPct) ? maxPct : null;
};

// 早于训练营回放缓存覆盖范围的日期用标准 5min 时间桶兜底
const FALLBACK_TIME_BUCKETS = (() => {
  const out = [];
  const pushRange = (startHour, startMinute, endHour, endMinute) => {
    let h = startHour;
    let m = startMinute;
    const end = endHour * 100 + endMinute;
    while (h * 100 + m <= end) {
      out.push({ minute: h * 100 + m });
      m += 5;
      if (m >= 60) { m -= 60; h += 1; }
    }
  };
  pushRange(9, 30, 11, 30);
  pushRange(13, 0, 15, 0);
  return out;
})();

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const gainText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) {
    if (p.minute <= minute) atPt = p;
    else break;
  }
  return atPt;
};

// 卖点扫描（与「首板洗盘-起爆拉升」完全同口径）
//   ① 跌破 5 日线：现价 < MA5；收益率未拉开 +20% 时盘中卖
//   ② 跌破成本线 -3%（连续 5 分钟）/ -5%（立即卖）
//   ③ 盘中跌停：分时跌幅 ≤ -9% 立即卖
// 逐分钟回溯，取最先触发的那一分钟；同分钟优先级 ③ > ②(-5%) > ②(-3%) > ①
const WASH_SELL_COST_STOP_PCT = -3;
const WASH_SELL_COST_HARD_STOP_PCT = -5;
const WASH_SELL_COST_OBSERVE_MINUTES = 5;
const WASH_SELL_LIMIT_DOWN_PCT = -9;
const WASH_SELL_GAP_DOWN_PCT = -3;   // 未拉开 +20% 前：竞价低开超过 -3% 即 9:30 卖出
const WASH_SELL_PROFIT_UNLOCK_PCT = 20;
const scanWashPriceSell = ({ points, preclose, buyPrice, cutoffMinute, ma5, profitUnlocked }) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const mins = points.filter((p) => p.minute <= cutoffMinute && p.lastPx > 0);
  if (mins.length === 0) return null;

  const hasCost = buyPrice > 0 && Number.isFinite(Number(buyPrice));
  const stopPx = hasCost ? Number(buyPrice) * (1 + WASH_SELL_COST_STOP_PCT / 100) : null;
  const hardStopPx = hasCost ? Number(buyPrice) * (1 + WASH_SELL_COST_HARD_STOP_PCT / 100) : null;
  const ma5Px = ma5 != null && Number.isFinite(Number(ma5)) && Number(ma5) > 0 ? Number(ma5) : null;

  let best = null;
  let costBelowCount = 0;
  let costBelowSinceMinute = null;
  const push = (minute, price, rank, reason) => {
    if (!best || minute < best.minute || (minute === best.minute && rank < best.rank)) {
      const changePct = preclose && preclose > 0 ? round2(((price - preclose) / preclose) * 100) : null;
      best = { minute, px: price, changePct, reason, rank };
    }
  };

  for (const p of mins) {
    const price = p.lastPx;
    const chg = preclose && preclose > 0 ? round2(((price - preclose) / preclose) * 100) : null;
    if (chg != null && chg <= WASH_SELL_LIMIT_DOWN_PCT) {
      push(p.minute, price, 0,
        `持仓股盘中跌停（昨收 ${preclose.toFixed(2)}，现价 ${price.toFixed(2)}，当日 ${chg}% ≤ ${WASH_SELL_LIMIT_DOWN_PCT}%）即卖出`);
    }
    if (hardStopPx != null && price < hardStopPx) {
      const costReturn = round2(((price - buyPrice) / buyPrice) * 100);
      push(p.minute, price, 1,
        `持仓股跌破成本线 ${WASH_SELL_COST_HARD_STOP_PCT}%（成本 ${buyPrice.toFixed(2)}，现价 ${price.toFixed(2)}，较成本 ${costReturn}%）立即卖出`);
    }
    if (stopPx != null && price < stopPx) {
      if (costBelowCount === 0) costBelowSinceMinute = p.minute;
      costBelowCount += 1;
      if (costBelowCount >= WASH_SELL_COST_OBSERVE_MINUTES) {
        const costReturn = round2(((price - buyPrice) / buyPrice) * 100);
        push(p.minute, price, 2,
          `持仓股连续 ${WASH_SELL_COST_OBSERVE_MINUTES} 分钟跌破成本线 ${WASH_SELL_COST_STOP_PCT}%（${fmtMinute(costBelowSinceMinute)} 起，成本 ${buyPrice.toFixed(2)}，现价 ${price.toFixed(2)}，较成本 ${costReturn}%）卖出`);
      }
    } else {
      costBelowCount = 0;
      costBelowSinceMinute = null;
    }
    if (profitUnlocked !== true && ma5Px != null && price < ma5Px) {
      const belowPct = round2(((price - ma5Px) / ma5Px) * 100);
      push(p.minute, price, 3,
        `持仓股跌破 5 日线（MA5 ${ma5Px.toFixed(2)}，现价 ${price.toFixed(2)}，低于 5 日线 ${belowPct}%）`);
    }
  }
  return best;
};

const runVolumeWashoutSecondBoardBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.volumeWashoutMode !== true) {
    return { success: false, message: `未知放量洗盘-二板起爆策略: ${strategyId}` };
  }

  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    .filter((d) => d >= startDate && d <= endDate)
    .sort();
  const total = allDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map();
  const positions = [];
  let soldThisDate = false;

  for (let di = 0; di < total; di++) {
    const dateStr = allDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });

    let campData;
    try {
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
    } catch (e) { campData = null; }
    const campBuckets = (campData && campData.success !== false) ? (campData.timeBuckets || []) : [];
    const timeBuckets = campBuckets.length > 0 ? campBuckets : FALLBACK_TIME_BUCKETS;
    const dateDisplay = (campData && campData.dateDisplay)
      || `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const dateNum = parseInt(dateStr, 10);
    soldThisDate = false;

    clearTlineCache();

    // 买点日前一交易日（= 首板日）
    let prevTradeDate = null;
    try {
      const past = await getPastTradingDates(dateStr, 1);
      prevTradeDate = past && past.length ? String(past[past.length - 1]) : null;
    } catch (e) { prevTradeDate = null; }

    // ---- 选股：T-1 首板 + 前置只放量洗盘形态 ----
    let selectedReady = false;
    let candidates = [];
    const ensureSelected = async () => {
      if (selectedReady) return;
      selectedReady = true;
      if (!prevTradeDate) { candidates = []; return; }

      let occStocks = [];
      try {
        const r = await getRecentMultiLianbanOccurrences(dateStr, WASHOUT_LOOKBACK_DAYS, 1);
        occStocks = r.stocks || [];
      } catch (e) { occStocks = []; }

      const recordMap = new Map();
      for (const s of occStocks) {
        if (!s || !s.code) continue;
        if (isChiNextOrStar(s.code) || EXCLUDED_CODES.has(s.code) || isThemeExcluded(s.code, s.board)) continue;
        const item = recordMap.get(s.code) || {
          code: s.code, name: s.name || s.code, board: s.board || '',
          hasHighBoard: false, firstBoardAtPrev: false,
        };
        const cnt = Number(s.lianbanCount);
        if (Number.isFinite(cnt) && cnt >= 3) item.hasHighBoard = true;
        const d = String(s.date || '');
        // 上一交易日（T-1）必须是首板（lianbanCount === 1）
        if (cnt === 1 && d === prevTradeDate) item.firstBoardAtPrev = true;
        if (s.board) item.board = s.board;
        recordMap.set(s.code, item);
      }

      // 15 日内出现过 ≥3 板者剔除；且只保留 T-1 为首板的股票
      const poolStocks = Array.from(recordMap.values())
        .filter((x) => !x.hasHighBoard && x.firstBoardAtPrev);

      try { await ensureBarsForCodes(new Set(poolStocks.map((x) => x.code))); } catch (e) { /* 日K拉取失败按缺失处理 */ }

      const prevNum = parseInt(prevTradeDate, 10);
      candidates = [];
      for (const item of poolStocks) {
        const bars = getStockBarsCached(item.code);
        if (!bars || bars.length === 0) continue;
        const washout = matchVolumeWashout(bars, prevNum);
        if (!washout) continue;
        const win3 = maxThreeDayWindowGain(bars, dateNum);
        if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
        washout.maxWin3Pct = win3 != null ? round2(win3) : null;
        if (!seenStocks.has(item.code)) seenStocks.set(item.code, { code: item.code, name: item.name });
        candidates.push({ code: item.code, name: item.name, board: item.board, washout });
      }

      // 总市值 ≤ 100 亿元（2026-11-01 用户要求）：预筛按 T-1 收盘价折算，买入时按实际买入价复核
      try { await ensureBacktestValuation(candidates.map((c) => c.code)); } catch (e) { /* 拉取失败时按缺失处理（不拦截） */ }
      candidates = candidates.filter((c) => {
        const info = totalMvInfoFor(c.code, prevTradeDate);
        c.totalShares = info ? info.shares : null;
        c.totalMvYiPrev = info ? info.mvYi : null;
        c.totalMvBase = info
          ? { baseMvYi: info.baseMvYi, baseDate: info.baseDate, baseClose: info.baseClose }
          : null;
        return c.totalMvYiPrev == null || c.totalMvYiPrev <= MAX_TOTAL_MV_YI;
      });

      // 分时加载前剪枝：买点要求「竞价高开 > 0」且「盘中首次涨到 +8%」，
      // 因此竞价低开/平开（不可能买）或当日最高涨幅 < 8% 且开盘涨幅 < 8% 的候选直接剔除
      candidates = candidates.filter((c) => {
        const bars = getStockBarsCached(c.code);
        const idx = bars ? bars.findIndex((b) => String(b.d) === dateStr) : -1;
        let openChg = null;
        if (idx > 0) {
          const pre = Number(bars[idx - 1].c);
          const o = Number(bars[idx].o);
          if (pre > 0 && o > 0) openChg = ((o - pre) / pre) * 100;
        }
        if (openChg != null && openChg <= 0) return false; // 竞价未高开 → 不买
        const highChg = stockHighChangeAt(c.code, dateStr);
        if (highChg == null) return true;
        if (highChg >= BUY_TRIGGER_PCT) return true;
        return openChg != null && openChg >= BUY_TRIGGER_PCT;
      });
    };

    // ---- 候选股分时（流式提取，不保留分时点位）----
    const hitMemo = new Map();     // code -> { minute, px, chg, mode }
    const limitUpMemo = new Map(); // code -> { minute, px, chg }（竞价一字板，买不进）
    let entriesReady = false;
    const ensureEntries = async () => {
      if (entriesReady) return;
      entriesReady = true;
      if (candidates.length === 0) return;
      const prevNum = prevTradeDate ? parseInt(prevTradeDate, 10) : null;
      await batchParallel(candidates, async (c) => {
        // 首板日（T-1）分时检查：断板次数 ≤ 1、封板满 20 分钟后无漏量（2026-11-01 用户要求）
        let bt = null;
        try { bt = prevNum ? await loadTlinePoints(c.code, prevNum) : null; }
        catch (e) { bt = null; }
        c.boardCheck = analyzeBoardDayTline(c.code, bt);
        if (c.boardCheck.failed) return; // 不合格 → 不进入候选股（不计算买点）
        let t = null;
        try { t = await loadTlinePoints(c.code, dateNum); }
        catch (e) { t = null; }
        if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) return;
        const preclose = t.preclose;
        const thr = limitUpThresholdOf(c.code);
        const pts = t.points;
        const p0 = pts.find((p) => p.lastPx > 0);
        if (!p0) return;
        const openChg = ((p0.lastPx - preclose) / preclose) * 100;
        // 竞价一字板（开盘即涨停）买不进
        if (openChg >= thr) {
          limitUpMemo.set(c.code, { minute: p0.minute, px: p0.lastPx, chg: round2(openChg) });
          return;
        }
        // 竞价必须高开
        if (openChg <= 0) return;
        // 1 分钟回溯：买点窗口内分时涨幅首次达到 +8% 即买入（开盘已 ≥8% 则在 9:30 买入）
        for (let i = 0; i < pts.length; i += 1) {
          const p = pts[i];
          if (p.minute < BUY_START_MINUTE || p.minute > BUY_CUTOFF_MINUTE) continue;
          if (!(p.lastPx > 0)) continue;
          const chg = ((p.lastPx - preclose) / preclose) * 100;
          if (chg < BUY_TRIGGER_PCT) continue;
          hitMemo.set(c.code, {
            minute: p.minute,
            px: p.lastPx,
            chg: round2(chg),
            mode: p.minute <= p0.minute ? 'auction8' : 'burst8',
          });
          break;
        }
      }, 4);
      // 首板日分时不合格者从候选池剔除（2026-11-01 用户要求）
      candidates = candidates.filter((c) => !(c.boardCheck && c.boardCheck.failed));
      clearTlineCache();
    };

    // ---- 隔夜持仓分时（买入当日不卖）----
    const posTlines = new Map();
    for (const p of positions) {
      if (dateStr > p.buyDate) {
        try {
          const t = await loadTlinePoints(p.code, dateNum);
          if (t) posTlines.set(p.code, t);
        } catch (e) { /* 分时缺失时该份持仓不做盘中卖点判定 */ }
      }
    }
    // MA5 = 当日之前 5 个交易日收盘均值（不含当日收盘，避免未来函数）
    const ma5Cache = new Map();
    const ensureMa5 = async (code) => {
      if (ma5Cache.has(code)) return ma5Cache.get(code);
      let map = null;
      try {
        await ensureBarsForCodes(new Set([code]));
        const bars = getStockBarsCached(code) || [];
        if (bars.length >= 6) {
          map = new Map();
          for (let i = 5; i < bars.length; i += 1) {
            const sum = bars.slice(i - 5, i).reduce((acc, b) => acc + Number(b.c), 0);
            map.set(String(bars[i].d), round2(sum / 5));
          }
        }
      } catch (e) { /* 日K不足时该项不触发 */ }
      ma5Cache.set(code, map);
      return map;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    const sellPositionAt = (pos, sellMinute, sellPx, sellChange, sellReason) => {
      if (!pos) return;
      const rawReturnRate = pos.buyPrice > 0
        ? round2(((sellPx - pos.buyPrice) / pos.buyPrice) * 100)
        : null;
      trades.push({
        seq: trades.length + 1,
        metric: pos.metric,
        code: pos.code,
        stockName: pos.stockName,
        board: pos.board,
        positionMode: 'offense',
        leg: pos.leg,
        weight: TWO_BUY_LEG_WEIGHT,
        buyDate: pos.buyDate,
        buyDateDisplay: pos.buyDateDisplay,
        buyTime: pos.buyTime,
        buyPrice: pos.buyPrice,
        buyChange: pos.buyChange,
        buyReason: pos.buyReason,
        buyChecks: pos.buyChecks,
        sellDate: dateStr,
        sellDateDisplay: dateDisplay,
        sellTime: fmtMinute(sellMinute),
        sellPrice: round2(sellPx),
        sellChange,
        sellReason: `${sellReason}，放量洗盘-二板起爆（半仓）卖出`,
        returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
        rawReturnRate,
      });
      const idx = positions.indexOf(pos);
      if (idx >= 0) positions.splice(idx, 1);
      soldThisDate = true;
    };

    // ===== ⑤ 买入后的次一交易日竞价低开 → 次日 9:30 竞价直接卖 =====
    for (const pos of Array.from(positions)) {
      if (dateStr <= pos.buyDate) continue;
      const prevDate = di > 0 ? allDates[di - 1] : null;
      if (prevDate !== pos.buyDate) continue;
      const tline = posTlines.get(pos.code);
      const openPt = tline && Array.isArray(tline.points)
        ? tline.points.find((p) => p.lastPx > 0)
        : null;
      if (!openPt || !(tline.preclose > 0)) continue;
      const openChg = ((openPt.lastPx - tline.preclose) / tline.preclose) * 100;
      if (openChg >= 0) continue;
      sellPositionAt(pos, BUY_START_MINUTE, openPt.lastPx, round2(openChg),
        `买入次一交易日（${dateDisplay}）竞价低开 ${round2(openChg)}%（昨收 ${round2(tline.preclose)} → 竞价 ${round2(openPt.lastPx)}）→ 9:30 竞价直接卖出`);
    }

    // ===== ⑦ 收益率未拉开 +20% 之前：竞价低开超过 -3% → 当日 9:30 竞价直接卖 =====
    //   覆盖买入次日起的任一交易日（T+1 已被 ⑤ 以「任意低开」口径先卖，⑦ 实际对 T+2 起生效）
    for (const pos of Array.from(positions)) {
      if (dateStr <= pos.buyDate) continue;
      const unlocked = pos.maxCloseGainPct != null
        && pos.maxCloseGainPct >= WASH_SELL_PROFIT_UNLOCK_PCT;
      if (unlocked) continue;
      const tline = posTlines.get(pos.code);
      const openPt = tline && Array.isArray(tline.points)
        ? tline.points.find((p) => p.lastPx > 0)
        : null;
      if (!openPt || !(tline.preclose > 0)) continue;
      const openChg = ((openPt.lastPx - tline.preclose) / tline.preclose) * 100;
      if (openChg >= WASH_SELL_GAP_DOWN_PCT) continue;
      sellPositionAt(pos, BUY_START_MINUTE, openPt.lastPx, round2(openChg),
        `收益率未拉开 +${WASH_SELL_PROFIT_UNLOCK_PCT}%（收盘口径历史最高 ${pos.maxCloseGainPct != null ? `${pos.maxCloseGainPct}%` : '--'}），竞价低开 ${round2(openChg)}% 超过 ${WASH_SELL_GAP_DOWN_PCT}%（昨收 ${round2(tline.preclose)} → 竞价 ${round2(openPt.lastPx)}）→ 9:30 竞价直接卖出`);
    }

    for (let bi = 0; bi < timeBuckets.length; bi += 1) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);

      // ===== 卖出（逐份持仓独立判定）=====
      for (const pos of Array.from(positions)) {
        if (dateStr <= pos.buyDate) continue;
        const tline = posTlines.get(pos.code);
        if (!tline || !Array.isArray(tline.points) || tline.points.length === 0) continue;
        const atPt = priceAtMinute(tline.points, bucketMinute);
        if (!atPt || !(atPt.lastPx > 0)) continue;
        const preclose = tline.preclose;

        const profitUnlocked = pos.maxCloseGainPct != null
          && pos.maxCloseGainPct >= WASH_SELL_PROFIT_UNLOCK_PCT;
        const ma5Map = profitUnlocked ? null : await ensureMa5(pos.code);
        const ma5 = ma5Map ? ma5Map.get(dateStr) : null;
        const hit = scanWashPriceSell({
          points: tline.points,
          preclose,
          buyPrice: pos.buyPrice,
          cutoffMinute: bucketMinute,
          ma5,
          profitUnlocked,
        });
        if (hit) sellPositionAt(pos, hit.minute, hit.px, hit.changePct, hit.reason);
      }

      // ===== 买入（账户拆两份、每份半仓）=====
      if (positions.length < MAX_POSITIONS && !soldThisDate && bucketMinute <= BUY_CUTOFF_MINUTE + 5) {
        await ensureSelected();
        if (candidates.length > 0) {
          await ensureEntries();

          const heldCodes = new Set(positions.map((p) => p.code));
          const mvRejected = new Set();
          while (positions.length < MAX_POSITIONS) {
            let pick = null;
            for (const c of candidates) {
              if (heldCodes.has(c.code) || mvRejected.has(c.code)) continue;
              const hit = hitMemo.get(c.code);
              if (!hit || hit.minute > bucketMinute) continue;
              const mvYiAtBuy = c.totalShares != null && hit.px > 0
                ? (c.totalShares * hit.px) / 1e8
                : null;
              if (mvYiAtBuy != null && mvYiAtBuy > MAX_TOTAL_MV_YI) {
                mvRejected.add(c.code);
                continue;
              }
              if (!pick
                || hit.minute < pick.hit.minute
                || (hit.minute === pick.hit.minute && hit.chg > pick.hit.chg)) {
                pick = { cand: c, hit, mvYiAtBuy };
              }
            }
            if (!pick || !(pick.hit.px > 0)) break;

            const skippedLimitUp = candidates
              .filter((c) => limitUpMemo.has(c.code) && !hitMemo.has(c.code))
              .map((c) => ({ code: c.code, name: c.name, ...limitUpMemo.get(c.code) }));
            const pos = {
              code: pick.cand.code,
              stockName: pick.cand.name,
              mode: 'offense',
              board: pick.cand.board || '',
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime: fmtMinute(pick.hit.minute),
              buyPrice: round2(pick.hit.px),
              buyChange: round2(pick.hit.chg),
              metric: null,
              leg: positions.length + 1,
              weight: TWO_BUY_LEG_WEIGHT,
              buyReason: '',
              buyChecks: [],
              triggerInfo: {
                mode: pick.hit.mode,
                prevTradeDate,
                washout: pick.cand.washout,
                boardCheck: pick.cand.boardCheck || null,
                pool: candidates.map((c) => c.name),
                hitMinute: pick.hit.minute,
                hitChange: round2(pick.hit.chg),
                skippedLimitUp,
                totalMvYiAtBuy: pick.mvYiAtBuy != null ? round2(pick.mvYiAtBuy) : null,
                totalMvYiPrev: pick.cand.totalMvYiPrev != null ? round2(pick.cand.totalMvYiPrev) : null,
                totalMvBase: pick.cand.totalMvBase || null,
              },
            };
            pos.buyReason = buildBuyReason(pos);
            pos.buyChecks = buildBuyChecks(pos);
            positions.push(pos);
            heldCodes.add(pos.code);
          }
        }
      }
    }

    // ===== 收盘卖点（逐份持仓独立判定）=====
    //   买入日当天更新「收盘口径历史最高收益」
    //   ④ 买入当日收盘涨停、买入次一交易日收盘未涨停 → 次日收盘卖出
    //   ⑥ 收益率未拉开 +20% 之前（收盘口径历史最高收益 < +20%）：持仓期内任一日收盘未涨停 → 当日收盘卖出
    //   ①（收盘分支）收益率已拉开 +20% 后，收盘价 < MA5 → 收盘卖出
    for (const pos of Array.from(positions)) {
      if (dateStr < pos.buyDate) continue;
      try {
        await ensureBarsForCodes(new Set([pos.code]));
        const bars = getStockBarsCached(pos.code) || [];
        let idx = -1;
        for (let i = 0; i < bars.length; i += 1) if (String(bars[i].d) === dateStr) idx = i;
        if (idx > 0) {
          const closePx = Number(bars[idx].c);
          const preClose = Number(bars[idx - 1].c);
          const thr = limitUpThresholdOf(pos.code);
          const dayPct = preClose > 0 && closePx > 0 ? round2(((closePx - preClose) / preClose) * 100) : null;
          const closeReturn = pos.buyPrice > 0 && closePx > 0
            ? round2(((closePx - pos.buyPrice) / pos.buyPrice) * 100)
            : null;
          if (closeReturn != null) {
            pos.maxCloseGainPct = pos.maxCloseGainPct == null
              ? closeReturn : Math.max(pos.maxCloseGainPct, closeReturn);
          }
          const profitUnlocked = pos.maxCloseGainPct != null
            && pos.maxCloseGainPct >= WASH_SELL_PROFIT_UNLOCK_PCT;

          if (dateStr > pos.buyDate) {
            const dayLimitUp = dayPct != null && dayPct >= thr;
            const buyIdx = bars.findIndex((b) => String(b.d) === pos.buyDate);
            const isDay2 = buyIdx >= 0 && buyIdx + 1 === idx;
            if (positions.includes(pos) && isDay2) {
              const bPre = buyIdx > 0 ? Number(bars[buyIdx - 1].c) : null;
              const bClose = Number(bars[buyIdx].c);
              const buyDayPct = bPre > 0 && bClose > 0 ? round2(((bClose - bPre) / bPre) * 100) : null;
              const buyDayLimitUp = buyDayPct != null && buyDayPct >= thr;
              if (buyDayLimitUp && !dayLimitUp) {
                sellPositionAt(pos, 1500, closePx, dayPct,
                  `买入当日收盘涨停（当日 ${buyDayPct}%），买入次一交易日（${dateDisplay}）收盘未涨停（当日 ${dayPct != null ? `${dayPct}%` : '--'}）→ 收盘卖出`);
              }
            }
          }

          // ⑥ 收益率未拉开 +20% 之前，买入次日起任一日收盘未涨停 → 当日收盘卖出（A 股 T+1，买入当日不可卖）
          if (positions.includes(pos) && dateStr > pos.buyDate && !profitUnlocked && dayPct != null && dayPct < thr) {
            sellPositionAt(pos, 1500, closePx, dayPct,
              `收益率未拉开 +${WASH_SELL_PROFIT_UNLOCK_PCT}%（收盘口径历史最高 ${pos.maxCloseGainPct != null ? `${pos.maxCloseGainPct}%` : '--'}），当日收盘未涨停（收盘 ${closePx.toFixed(2)}，当日 ${dayPct}% < 涨停阈值 ${thr}%）→ 收盘卖出`);
          }

          if (positions.includes(pos) && profitUnlocked) {
            const ma5Map = await ensureMa5(pos.code);
            const ma5 = ma5Map ? ma5Map.get(dateStr) : null;
            if (ma5 != null && closePx > 0 && closePx < ma5) {
              sellPositionAt(pos, 1500, closePx, dayPct,
                `收益率已拉开 +${WASH_SELL_PROFIT_UNLOCK_PCT}%（收盘口径历史最高 ${pos.maxCloseGainPct}%），当日收盘跌破 5 日线（收盘 ${closePx.toFixed(2)} < MA5 ${ma5}）→ 收盘卖出`);
            }
          }
        }
      } catch (e) { /* 日K缺失时不判定收盘卖点 */ }
    }

    clearTlineMemCache();
  }

  const holdings = [];
  for (const pos of positions) {
    const h = { ...pos, weight: TWO_BUY_LEG_WEIGHT };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(pos.code, allDates[allDates.length - 1]);
    if (closePx != null && closePx > 0 && pos.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - pos.buyPrice) / pos.buyPrice) * 100);
    }
    h.rawBuyReturn = rawBuyReturn;
    h.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn * TWO_BUY_LEG_WEIGHT) : null;
    holdings.push(h);
  }

  const overallReturn = computeTwoBuyAccountReturn([
    ...trades.map((t) => ({ buyDate: t.buyDate, buyTime: t.buyTime, sellDate: t.sellDate, sellTime: t.sellTime, returnRate: t.returnRate })),
    ...holdings.map((h) => ({ buyDate: h.buyDate, buyTime: h.buyTime, returnRate: h.buyReturn })),
  ]);
  const validTrades = trades.filter((t) => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter((t) => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (holdings.length > 0) await attachBuyDayReturn(holdings);
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holdings[0] || null,
    currentHoldings: holdings,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: positions.length > 0,
    },
  };
};

const buildBuyReason = (pos) => {
  const t = pos.triggerInfo;
  const skipText = (t.skippedLimitUp || []).length > 0
    ? `（开盘即涨停买不进、已顺延：${(t.skippedLimitUp || []).map((x) => x.name).join('、')}）`
    : '';
  const w = t.washout || {};
  const washText = t.washout
    ? `前置只放量洗盘：首板 ${w.boardDate}（${w.boardPct}% 涨停，量占峰值日 ${w.boardVsPeakVolPct}% ≤ ${VOL_WASHOUT_OPT.BOARD_MAX_VS_PEAK_VOL_RATIO * 100}%）→ 拉升放量 ${w.pullStartDate}~${w.pullEndDate} ${w.pullDays} 日（均量 ${w.pullVolRatio} 倍 ≥ ${VOL_WASHOUT_OPT.PULL_AVG_VOL_RATIO}、峰值量 ${w.pullMaxVolRatio} 倍 ≥ ${VOL_WASHOUT_OPT.PULL_PEAK_VOL_RATIO}）→ 震荡缩量 ${w.shockStartDate}~${w.shockEndDate} ${w.shockDays} 日（单日涨幅最大 ${gainText(w.maxDayPct)}、跌幅最大 ${gainText(w.minDayPct)}，超 -6% ${w.deepDropDays} 天、-5%~-6% ${w.midDropDays} 天 ≤ 1；震荡最低 ${w.shockLow} ${w.lowVsPullOpenPct != null ? (w.lowVsPullOpenPct >= 0 ? `较首次爆量开盘 ${w.pullOpen} 低 ${w.lowVsPullOpenPct}%` : `较首次爆量开盘 ${w.pullOpen} 高 ${Math.abs(w.lowVsPullOpenPct)}%`) : `首次爆量开盘 ${w.pullOpen != null ? w.pullOpen : '数据缺失'}`}（回撤 ≤ 5%）），未突破平台高点 ${w.platformHigh}`
    : null;
  const modeText = t.mode === 'auction8'
    ? `竞价高开 ${gainText(t.hitChange)}，${fmtMinute(t.hitMinute)} 开盘即已 ≥ +${BUY_TRIGGER_PCT}% 按竞价价买入`
    : `竞价高开后 ${fmtMinute(t.hitMinute)} 分时涨幅 ${gainText(t.hitChange)} 首次达到 +${BUY_TRIGGER_PCT}%`;
  return `候选 ${t.pool.length} 只（${washText}），${pos.stockName} ${modeText}${skipText}，成交价 ${pos.buyPrice.toFixed(2)} 买入（半仓）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  const w = t.washout || {};
  return [
    {
      id: 'vws_board',
      title: '上个交易日（T-1）必须是首板，且过去 15 个交易日内未出现 ≥3 板',
      passed: true,
      value: `T-1 = ${t.prevTradeDate || '--'}，连板快照为 ${w.boardDate || '--'} 首板（收盘 ${w.boardPct != null ? `${w.boardPct}%` : '--'} 涨停）；15 日内无 ≥3 板记录`,
      reason: '首板之后的次日为买点日；过去 15 个交易日内出现过三板及以上连板的个股一律剔除',
    },
    {
      id: 'vws_board_break_limit',
      title: `首板日断板次数 ≤ ${BOARD_MAX_BREAKS} 次`,
      passed: true,
      value: t.boardCheck && !t.boardCheck.skipped
        ? `首板日（${t.prevTradeDate}）分时断板 ${t.boardCheck.breaks} 次${t.boardCheck.breaks === 0 ? '（未断板）' : ''}`
        : '首板日分时缺失，该项不拦截',
      reason: '首板日分时价触及涨停价后回落算一次断板；允许断板 1 次，出现第 2 次断板的个股不能进入候选股（2026-11-01 用户要求）',
    },
    {
      id: 'vws_board_seal_leak',
      title: `封板满 ${BOARD_LEAK_MIN_AFTER_SEAL} 个交易分钟后封板期间无漏量（分钟量 ≤ 封板那分钟量的 ${Math.round(BOARD_LEAK_VOL_RATIO * 100)}%）`,
      passed: true,
      value: t.boardCheck && !t.boardCheck.skipped
        ? (t.boardCheck.sealMinute != null
          ? `封板 ${fmtMinute(t.boardCheck.sealMinute)} 那分钟量 ${t.boardCheck.sealVol}，封板满 ${BOARD_LEAK_MIN_AFTER_SEAL} 分钟后最大分钟量占比 ${t.boardCheck.maxLeakRatioPct != null ? `${t.boardCheck.maxLeakRatioPct}%` : '--'}${t.boardCheck.maxLeakMinute != null ? `（${fmtMinute(t.boardCheck.maxLeakMinute)}）` : ''}，漏量 ${t.boardCheck.leakCount} 分钟`
          : '首板日未封板，该项不拦截')
        : '首板日分时缺失，该项不拦截',
      reason: `首板日封住涨停满 ${BOARD_LEAK_MIN_AFTER_SEAL} 个交易分钟后（断板回封重新计时；20 分钟剔除午休 11:30–13:00，如 11:15 封板则从 13:05 起检查）到收盘，封死涨停期间任一分钟成交量不得超过「封板那一分钟」成交量的 ${Math.round(BOARD_LEAK_VOL_RATIO * 100)}%（即超出 30% 以上视为漏量，按成交量而非成交金额）；出现漏量即不能进入候选股（2026-11-01 用户要求）`,
    },
    {
      id: 'vws_washout',
      title: '前置「拉升放量 1~3 日 → 震荡缩量 2~12 日 → 首板突破」形态',
      passed: !!t.washout,
      value: t.washout
        ? `首板 ${w.boardDate}（开 ${w.boardOpen != null ? w.boardOpen : '--'}、收 ${w.boardClose}、量 ${w.boardVol}，占峰值日量 ${w.boardVsPeakVolPct}% ≤ ${VOL_WASHOUT_OPT.BOARD_MAX_VS_PEAK_VOL_RATIO * 100}%）；拉升 ${w.pullStartDate}~${w.pullEndDate}（${w.pullDays} 日，均量 ${w.pullVolRatio} 倍 ≥ ${VOL_WASHOUT_OPT.PULL_AVG_VOL_RATIO}，峰值量 ${w.pullMaxVolRatio} 倍 ≥ ${VOL_WASHOUT_OPT.PULL_PEAK_VOL_RATIO}，累计 ${gainText(w.pullGainPct)} ≥ ${VOL_WASHOUT_OPT.PULL_MIN_GAIN_PCT}%，最大单日 ${gainText(w.pullMaxDayGain)} ≥ ${VOL_WASHOUT_OPT.PULL_MIN_MAX_DAY_GAIN_PCT}%）；震荡 ${w.shockStartDate}~${w.shockEndDate}（${w.shockDays} 日，振幅 ${gainText(w.shockRangePct)} ≤ 20%，平台振幅 ${gainText(w.platformRangePct)} ≤ 25%，均量占拉升 ${w.shockAvgVolRatioPct}% ≤ 80%，最大量占拉升 ${w.shockMaxVolRatioPct}% ≤ 95%）`
        : '未命中前置只放量洗盘形态',
      reason: `参照 股票数据材料/只放量无涨停-打二板/washout.js：首板日前存在「拉升放量 1~${VOL_WASHOUT_OPT.PULL_MAX_DAYS} 日（均量 ≥ 前 5 日均量 ${VOL_WASHOUT_OPT.PULL_AVG_VOL_RATIO} 倍、峰值量 ≥ 前 5 日均量 ${VOL_WASHOUT_OPT.PULL_PEAK_VOL_RATIO} 倍、累计涨幅 ≥ ${VOL_WASHOUT_OPT.PULL_MIN_GAIN_PCT}%、最高价突破前 5 日最高价 ${VOL_WASHOUT_OPT.PULL_BREAK_PRE_HIGH_RATIO} 倍）→ 震荡缩量 ${VOL_WASHOUT_OPT.SHOCK_MIN_DAYS}~${VOL_WASHOUT_OPT.SHOCK_MAX_DAYS} 日（最高收盘 ≤ 拉升最高收盘 ${VOL_WASHOUT_OPT.SHOCK_UP_TOL} 倍、最低收盘 ≥ 拉升最低收盘 ${VOL_WASHOUT_OPT.SHOCK_DOWN_TOL} 倍、均量 ≤ 拉升均量 ${VOL_WASHOUT_OPT.SHOCK_VOL_RATIO * 100}%、最大量 ≤ 拉升最大量 ${VOL_WASHOUT_OPT.SHOCK_MAX_VOL_RATIO * 100}%）」→ 首板收盘 ≥ 震荡最高收盘 ${VOL_WASHOUT_OPT.BOARD_BREAK_SHOCK_CLOSE_RATIO} 倍、首板量 ≥ 震荡最后一日量 ${VOL_WASHOUT_OPT.BOARD_LAST_VOL_RATIO} 倍、首板量 ≤ 拉升段峰值日成交量 ${VOL_WASHOUT_OPT.BOARD_MAX_VS_PEAK_VOL_RATIO} 倍（2026-11-01 用户要求：首板量不得超过更前面量能峰值日的 20% 以上，按成交量判定）；放量峰值倍数按 2026-11-01 用户要求为 2 倍`,
    },
    {
      id: 'vws_shock_calm',
      title: '震荡区间单日涨跌幅温和 + 最低价不破首次爆量开盘价 -5%',
      passed: !!t.washout,
      value: t.washout
        ? `单日涨幅最大 ${gainText(w.maxDayPct)}（≤ +5%）、跌幅最大 ${gainText(w.minDayPct)}（不低于 -5%；-5%~-6% 共 ${w.midDropDays} 天 ≤ ${VOL_WASHOUT_OPT.SHOCK_MAX_MID_DROP_DAYS}，超 -6% 共 ${w.deepDropDays} 天）；震荡最低 ${w.shockLow}，首次爆量开盘 ${w.pullOpen != null ? w.pullOpen : '数据缺失'}，${w.lowVsPullOpenPct != null ? (w.lowVsPullOpenPct >= 0 ? `低于开盘 ${w.lowVsPullOpenPct}%` : `高于开盘 ${Math.abs(w.lowVsPullOpenPct)}%`) : '回撤 --'}（≤ 5%）`
        : '未命中前置只放量洗盘形态',
      reason: '爆量日之后的震荡区间内所有交易日涨跌幅须在 ±5% 之内（涨幅 ≤ +5%、跌幅不低于 -5%），唯一例外是单日跌幅介于 -5%~-6%（不含两端）最多允许 1 天，跌幅超过 -6% 一律剔除；且震荡区间最低价不得低于首次爆量开盘价 -5%（(首次爆量开盘价 − 震荡最低价) ÷ 首次爆量开盘价 ≤ 5%）',
    },
    {
      id: 'vws_win3_cap',
      title: `买点日前 ${WIN3_LOOKBACK_DAYS} 个交易日内最大三日滑动窗口涨幅 ≤ ${MAX_WIN3_GAIN_PCT}%`,
      passed: true,
      value: w.maxWin3Pct != null
        ? `本样本最大三日滑动窗口涨幅 ${gainText(w.maxWin3Pct)}（≤ ${MAX_WIN3_GAIN_PCT}%）`
        : '历史日K不足 3 日，该项不拦截',
      reason: `按买点日前一交易日及更早日K，取最近 ${WIN3_LOOKBACK_DAYS} 个交易日内任意连续 3 个交易日的涨幅（末日收盘 − 窗口前一日收盘 ÷ 窗口前一日收盘）的最大值，超过 ${MAX_WIN3_GAIN_PCT}% 的个股一律剔除`,
    },
    {
      id: 'vws_total_mv',
      title: `总市值 ≤ ${MAX_TOTAL_MV_YI} 亿元（按买入日股价折算）`,
      passed: true,
      value: (() => {
        const atBuy = t.totalMvYiAtBuy;
        const prev = t.totalMvYiPrev;
        const b = t.totalMvBase;
        if (atBuy == null) return `总市值数据缺失，该项不拦截（前一交易日折算值 ${prev != null ? `${prev} 亿` : '缺失'}）`;
        const baseText = b && b.baseClose > 0
          ? `基准 ${b.baseDate === VALUATION_MV_BASE_DATE ? '当下总市值快照' : `连板快照 ${b.baseDate}`} ${round2(b.baseMvYi)} 亿 ÷ 基准收盘 ${round2(b.baseClose)} → `
          : '';
        return `${baseText}买入价 ${round2(pos.buyPrice)} 对应总市值 ${atBuy} 亿（前一交易日收盘价折算 ${prev != null ? `${prev} 亿` : '缺失'}，均 ≤ ${MAX_TOTAL_MV_YI} 亿）`;
      })(),
      reason: `先由「当下总市值 ÷ 当下股价」反推总股本（自选股用 monitor_stocks_valuation，非自选股用 data/backtest_stock_valuation.json 的财联社 mc；数据缺失时不拦截），再把股本 × 买入日该分钟实际买入价折算成回测当天的总市值，> ${MAX_TOTAL_MV_YI} 亿元即剔除并顺延下一只；候选池预筛用 T-1 收盘价，买入时再按买入价复核`,
    },
    {
      id: 'vws_entry',
      title: `买点：竞价高开 → 9:30–14:30 分时首次 +${BUY_TRIGGER_PCT}% 按该分钟价买入`,
      passed: true,
      value: `${fmtMinute(t.hitMinute)} ${pos.stockName} ${gainText(t.hitChange)}（${t.mode === 'auction8' ? '竞价已 ≥ +8%，按竞价价买入' : `盘中 +${BUY_TRIGGER_PCT}% 买入`}）`,
      reason: `首板之后的次日（回测日期）竞价必须高开（9:30 开盘价高于昨收），随后按 1 分钟回溯在 ${fmtMinute(BUY_START_MINUTE)}–${fmtMinute(BUY_CUTOFF_MINUTE)} 内寻找分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 的那一分钟，按该分钟分时价买入；${fmtMinute(BUY_CUTOFF_MINUTE)} 之后不再买入；竞价一字板（开盘即涨停）买不进`,
    },
    {
      id: 'vws_limit_up_skip',
      title: '竞价一字板买不进：9:30 开盘即涨停的候选顺延',
      passed: true,
      value: (t.skippedLimitUp || []).length > 0
        ? (t.skippedLimitUp || []).map((x) => `${x.name}（${fmtMinute(x.minute)} 涨幅 ${gainText(x.chg)}，开盘即涨停买不进）`).join('；')
        : '当日无「开盘即涨停」的候选被顺延',
      reason: '只有 9:30 开盘即涨停（竞价一字板，涨幅 ≥ 涨停阈值）视为买不进；开盘未涨停、盘中才冲上涨停的仍按该分钟价买入',
    },
  ];
};

module.exports = {
  runVolumeWashoutSecondBoardBacktest,
  matchVolumeWashout,
  analyzeBoardDayTline,
  VOL_WASHOUT_OPT,
  WASHOUT_LOOKBACK_DAYS,
  BUY_TRIGGER_PCT,
  BUY_START_MINUTE,
  BUY_CUTOFF_MINUTE,
  MAX_TOTAL_MV_YI,
  MAX_WIN3_GAIN_PCT,
  WIN3_LOOKBACK_DAYS,
  WASH_SELL_PROFIT_UNLOCK_PCT,
  WASH_SELL_GAP_DOWN_PCT,
};
