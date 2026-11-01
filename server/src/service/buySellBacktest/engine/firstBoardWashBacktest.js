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
const { round2, loadTlinePoints, clearTlineCache, limitUpThresholdOf } = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

// ============================================================
// 首板洗盘-起爆拉升（firstBoardWashMode: true，仅回测；独立引擎）
//   选股 = 前置洗盘形态判定（2026-11-01 用户要求，参照 股票数据材料/涨停洗盘-打首板/washout.js
//     最新版 isPotentialBullWashout）：
//     首板（或首板+二板）→ 次日/隔日放量峰值 → 之后 5~12 个交易日缩量洗盘，且
//     洗盘区间不突破平台高点（最高价 ≤ 平台高点 1.03、最高收盘 ≤ 1.02）、不破位、
//     洗盘区间幅度 8%~35%、洗盘期最大量 ≤ 峰值量 95%、最小量 ≤ 峰值量 60%；
//     平台放量峰值须 ≥ 首板日前 20 日均量的 2 倍（线上口径；回测按 2026-11-01 用户要求提升至 3 倍，
//     见 BACKTEST_VOL_MULT，线上仍用 WASHOUT_OPT.volMult=2）；洗盘期内不得出现涨停（forbidLimitUpInWash）；
//     洗盘期内单日涨跌幅须温和：所有交易日涨跌幅都须在 ±5% 之内（最大涨幅 ≤ +5%、跌幅不低于 -5%）；
//     唯一例外——单日跌幅介于 -5%~-6%（不含两端）的最多允许 1 天，跌幅超过 -6% 的一律剔除；
//     且震荡区间最低价不得跌破首板涨停日开盘价（2026-11-01 用户要求）；
//     起爆前（买点触发价）须 ≥ 平台高点 × 0.80（breakoutMinRatio）；15 日内出现 ≥3 板者剔除。
//     「买点日 D 收盘必须涨停」（requireBreakoutLimitUp）不在选股阶段校验（会用到买点日收盘数据），
//     由买入后「跌破成本线 -3%」等卖点自然处理，不在选股阶段做额外校验。
//   候选池剔除：创业板/科创板、代码黑名单、题材黑名单（同「情绪游资-极致胜率」）；
//   且总市值必须 ≤ 100 亿元（先按最新总市值快照反推总股本，再按买入日股价折算；预筛用前一交易日收盘价）
//   买点（两条路径，2026-11-01 用户要求）：
//     ① 竞价高开 ≥ 5%：直接在 9:30 按竞价开盘价买入
//     ② 竞价高开 < 5%（含低开）：9:30–9:40 分时涨幅首次达到 +8% 即买入（9:40 之后不再买入）；
//        9:30–9:40 之间最多允许 1 次分钟级回落，出现第 2 次回落即当日不买
//     两条路径共同的限制：只有 9:30 开盘即涨停（竞价一字板）买不进，
//        开盘未涨停而盘中（如 9:31）冲上涨停仍按该分钟价买入；9:40 之后不再买入
//   卖点：共五条（2026-11-01 用户要求；「高位放量大阴线」「次日涨停放量」均已取消）——
//        ① 跌破 5 日线（现价 < MA5，MA5 取当日之前 5 个交易日收盘均值，不含当日收盘）：
//           收益率未拉开 +20% 时盘中分时跌破即卖；收益率已拉开 +20%（收盘口径历史最高 ≥ +20%）
//           时改为只在收盘判定（收盘价 < MA5 才卖）
//        ② 跌破成本线：现价 < 买入价 × 0.97（-3%）须**连续 5 分钟**都跌破才卖（中途回到 -3% 之上即重新计时）；
//           现价 < 买入价 × 0.95（-5%）则**立即卖出**、不等观察窗口（2026-11-01 用户要求）
//        ③ 盘中跌停：分时跌幅 ≤ -9%（相对昨收）即视为跌停，立即卖
//        ①②③ 逐分钟回溯，取最先触发的那一分钟的价与分钟；同日同分钟优先级 ③ > ②(-5%) > ②(-3%) > ①
//        ④ 买入当日收盘涨停、而买入次一交易日收盘未涨停 → 次一交易日收盘卖出（2026-11-01 用户要求；
//           原「次日涨停放量 ≥ 首板 2 倍 → 收盘卖」已按用户要求取消）
//        ⑤ 买入后的**次一交易日竞价低开**（开盘涨幅 < 0）→ 次一交易日 9:30 竞价直接卖出
//           （2026-11-01 用户要求：不看买入当日是否涨停，一律按次一交易日竞价是否低开判定；
//            ⑤ 在 9:30 先触发，早于 ④ 的收盘判定）
//   仓位：账户拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票（2026-11-01 用户要求）；
//        各份仓位各自独立买卖、独立按自身买入价计收益，任一份卖出当日不再新开仓位
// ============================================================

const BUY_TRIGGER_PCT = 8;         // 竞价未到 5% 时：分时涨幅达到 +8% 即买入（2026-11-01 用户要求，由 9% 改为 8%）
const MAX_FLOAT_MV_YI = 100;       // 流通市值（按买入日股价折算）须 ≤ 100 亿元（线上口径，firstBoardWashLive 使用）
const MAX_TOTAL_MV_YI = 100;       // 回测口径：总市值（按买入日股价折算）须 ≤ 100 亿元（2026-11-01 用户要求，替代流通市值）
const MAX_WIN3_GAIN_PCT = 20;      // 买点日前 20 个交易日内最大三日滑动窗口涨幅 ≤ 20%（2026-11-01 用户要求）
const WIN3_LOOKBACK_DAYS = 20;     // 三日滑动窗口涨幅的回溯交易日数
const BUY_OPEN_GAP_AUCTION_PCT = 5; // 竞价高开 ≥ 5% → 9:30 按竞价开盘价直接买入；< 5% → 等盘中 +8%（2026-11-01 用户要求）
const BUY_START_MINUTE = 930;      // 买点最早 9:30
const BUY_CUTOFF_MINUTE = 940;     // 买点最晚 9:40（2026-11-01 用户要求：9:30–9:40 之外不买）
const MAX_INTRADAY_PULLBACKS = 1;  // 9:30–9:40 之间最多允许 1 次分钟级回落（2026-11-01 用户要求）
const MAX_POSITIONS = 2;           // 账户拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票（2026-11-01 用户要求）

// 前置洗盘（washout）参数，与最新版 股票数据材料/涨停洗盘-打首板/washout.js 默认参数一致：
//   首板日最远可回溯到 eIdx − maxWashDays − maxBaseToPeak − 3（eIdx = 买点日前一交易日），
//   故连板快照回溯窗口取 20 个交易日（足够覆盖 18 个交易日前出现的首板）
//   注：新版算法里的 requireBreakoutLimitUp（买点日 D 收盘必须涨停）需用到买点日收盘数据，
//   本策略在买点日盘中买入、无法预知当日能否封板，故不在选股阶段校验（避免未来函数），
//   改由买入后的「买入当日未涨停 → 次日收盘直接卖出」规则做同等验证（2026-11-01 用户选择）
const WASHOUT_LOOKBACK_DAYS = 20;
// 回测口径的峰值倍数（2026-11-01 用户要求：回测改为 ≥ 3 倍；线上 firstBoardWashLive 仍用 WASHOUT_OPT.volMult=2）
const BACKTEST_VOL_MULT = 3.0;
const WASHOUT_OPT = {
  limitPct: 9.5,             // 涨停阈值（主板）
  volMult: 2.0,              // 峰值成交量 ≥ 首板日前 20 日均量的倍数（线上口径，回测见 BACKTEST_VOL_MULT）
  minHistory: 3,             // 计算均量所需的最少历史交易日
  maxBaseToPeak: 2,          // 首板日（含）之后最多几个交易日寻找放量峰值
  minWashDays: 5,            // 洗盘至少 5 个交易日
  maxWashDays: 12,           // 洗盘最多 12 个交易日
  maxWashVolRatio: 0.95,     // 洗盘期最大成交量 ≤ 峰值量的 95%
  minShrinkRatio: 0.60,      // 洗盘期最小成交量 ≤ 峰值量的 60%（必须有缩量）
  minRangePct: 0.08,         // 洗盘区间幅度下限 8%
  maxRangePct: 0.35,         // 洗盘区间幅度上限 35%
  upperToleranceHigh: 1.03,  // 洗盘期最高价 ≤ 平台高点 × 1.03
  upperToleranceClose: 1.02, // 洗盘期最高收盘 ≤ 平台高点 × 1.02
  forbidLimitUpInWash: true, // 洗盘期内不得出现涨停（新版 washout.js 新增过滤）
  breakoutMinRatio: 0.80,    // 起爆前收盘价 ≥ 平台高点 × 0.80（新版 washout.js 新增过滤，按买点前一交易日收盘）
  maxWashDayGainPct: 5,      // 洗盘期内单日最大涨幅 ≤ +5%（2026-11-01 用户要求）
  maxWashDayDropPct: -6,     // 洗盘期内单日跌幅的容忍线 -6%（跌穿此线的一律剔除）
  maxDeepDropDays: 0,        // 单日跌幅超过 -6% 的交易日一律不允许（2026-11-01 用户要求）
  midDropLinePct: -5,        // 跌幅介于 -5%~-6%（不含两端）的判定线
  maxMidDropDays: 1,         // 跌幅介于 -5%~-6%（不含两端）的交易日最多允许 1 天（2026-11-01 用户要求）
  requireWashLowAboveBoardOpen: true, // 洗盘期最低价不得跌破首板涨停日开盘价（2026-11-01 用户要求）
};

// 候选池一律剔除创业板（30/301）与科创板（688），与「情绪游资-极致胜率」同口径（2026-11-01 用户要求）
const isChiNextOrStar = (code) => /^(30|688)/.test(String(code || '').replace(/^(sh|sz|bj)/i, ''));

// 「东方财富板块成分股汇总」全量题材映射：code6 -> [板块名]，用于对非连板股（如自选股里从未涨停的
// 芯片/算力股）也应用同一份题材黑名单；按目录 mtime 缓存，并（引擎按日×按股高频调用）每 60s 才重新 stat 一次
const BOARD_DIR = path.resolve(__dirname, '../../../data/东方财富板块成分股汇总');
const BOARD_CACHE_TTL_MS = 60 * 1000;
let themeBlockCache = null; // { checkedAt, mtimeMs, map, excludedCodes }
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
          const code = String(item && item.code || '').trim();
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
// 个股是否命中题材黑名单：优先用连板快照里的板块名，其次用板块成分股文件里的所属板块名
const isThemeExcluded = (code, board) => {
  if (isExcludedTheme(board)) return true;
  return getThemeBlockIndex().excludedCodes.has(String(code || '').replace(/^(sh|sz|bj)/i, ''));
};

// 总市值换算（总股本近似不变，市值 ∝ 股价；2026-11-01 用户要求由流通市值改为总市值口径）：
//   「市值基准」优先取 **当下的总市值**（财联社 mc，对应最新股价）：
//     ① 回测通用估值缓存 data/backtest_stock_valuation.json（非自选股也能拿到）；
//     ② monitor_stocks_valuation.json（自选股估值快照，同为当下口径）。
//   由「基准总市值 ÷ 基准股价」反推总股本，再把股本 × 目标日股价折算出该股价对应的总市值。
//   候选池预筛用「买点日前一交易日收盘价」；买入时再用「该分钟实际买入价」复核（回测日期当天的股价口径）。
//   数据缺失返回 null（不拦截）。
const VALUATION_MV_BASE_DATE = 99999999; // 当前估值快照对应最新收盘价
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
// 前置洗盘判定（2026-11-01 用户要求，参照 股票数据材料/washout.js 的 isPotentialBullWashout）：
//   首板（或首板+二板）→ 放量峰值 → 之后 5~12 个交易日缩量洗盘 → 洗盘期不突破平台高点、不破位。
//   回测口径（避免未来函数）：洗盘区间只取买点日前一交易日及更早（includeD = false），
//   不使用买点日自身的日K（收盘/最高价不做确认）。
//   返回 null 表示不满足；满足时返回形态明细，供买入理由/明细展示。
// ============================================================
const isPotentialBullWashout = (bars, dateNum, options = {}) => {
  const opt = { ...WASHOUT_OPT, ...options };
  if (!Array.isArray(bars) || bars.length < 10) return null;

  let dIdx = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (Number(bars[i].d) <= dateNum) dIdx = i;
    else break;
  }
  if (dIdx < 0) return null;

  // 前置洗盘：洗盘区间严格在买点日之前
  const eIdx = dIdx - 1;
  if (eIdx < opt.minWashDays + 1) return null;

  const close = bars.map((b) => Number(b.c));
  const high = bars.map((b) => (Number(b.h) > 0 ? Number(b.h) : Number(b.c)));
  const low = bars.map((b) => (Number(b.l) > 0 ? Number(b.l) : Number(b.c)));
  const vol = bars.map((b) => (Number(b.v) > 0 ? Number(b.v) : 0));
  const pct = close.map((c, i) => (i > 0 && close[i - 1] > 0 ? ((c / close[i - 1]) - 1) * 100 : 0));
  const isLimitUp = (i) => i >= 0 && i <= eIdx && pct[i] >= opt.limitPct;

  // 首板日前 n 个交易日日均量（不足 minHistory 或量能缺失返回 null）
  const avgVolBefore = (idx, n) => {
    const start = Math.max(0, idx - n);
    const end = idx - 1;
    if (end - start + 1 < opt.minHistory) return null;
    let sum = 0;
    for (let i = start; i <= end; i += 1) {
      if (!(vol[i] > 0)) return null;
      sum += vol[i];
    }
    return sum / (end - start + 1);
  };

  const t0Start = Math.max(0, eIdx - opt.maxWashDays - opt.maxBaseToPeak - 3);
  const t0End = eIdx - opt.minWashDays - 1;
  for (let t0 = t0End; t0 >= t0Start; t0 -= 1) {
    if (!isLimitUp(t0)) continue; // 首板日必须是涨停日

    const t1 = t0 + 1;
    const twoBoard = t1 < eIdx && isLimitUp(t1);
    const peakStart = twoBoard ? t1 : t0;
    const peakEnd = Math.min(peakStart + opt.maxBaseToPeak, eIdx - opt.minWashDays);
    if (peakEnd < peakStart) continue;

    let p = -1;
    let peakVol = -1;
    for (let i = peakStart; i <= peakEnd; i += 1) {
      if (vol[i] > peakVol) { peakVol = vol[i]; p = i; }
    }
    if (p < 0 || !(peakVol > 0)) continue;

    const avg20 = avgVolBefore(t0, 20);
    if (avg20 == null || !(avg20 > 0)) continue;
    if (peakVol < opt.volMult * avg20) continue; // 平台必须放量

    const washStart = p + 1;
    const washEnd = eIdx;
    const washDays = washEnd - washStart + 1;
    if (washDays < opt.minWashDays || washDays > opt.maxWashDays) continue;

    let platformHigh = -Infinity;
    for (let i = t0; i <= p; i += 1) if (high[i] > platformHigh) platformHigh = high[i];

    let washLow = Infinity;
    let washMaxVol = -Infinity;
    let washMinVol = Infinity;
    let washMaxHigh = -Infinity;
    let washMaxClose = -Infinity;
    let washMaxDayPct = -Infinity; // 洗盘期内单日最大涨幅
    let washMinDayPct = Infinity;  // 洗盘期内单日最大跌幅（负数）
    let deepDropDays = 0;          // 洗盘期内单日跌幅超过 -6% 的天数（最多允许 1 天）
    let midDropDays = 0;           // 洗盘期内单日跌幅介于 -5%~-6%（不含两端）的天数（最多允许 1 天）
    let hasLimitUpInWash = false;
    for (let i = washStart; i <= washEnd; i += 1) {
      if (!(vol[i] > 0)) { washLow = -1; break; } // 洗盘期量能缺失视为无效
      if (opt.forbidLimitUpInWash && pct[i] >= opt.limitPct) { hasLimitUpInWash = true; break; }
      if (low[i] < washLow) washLow = low[i];
      if (vol[i] > washMaxVol) washMaxVol = vol[i];
      if (vol[i] < washMinVol) washMinVol = vol[i];
      if (high[i] > washMaxHigh) washMaxHigh = high[i];
      if (close[i] > washMaxClose) washMaxClose = close[i];
      if (pct[i] > washMaxDayPct) washMaxDayPct = pct[i];
      if (pct[i] < washMinDayPct) washMinDayPct = pct[i];
      if (pct[i] < opt.maxWashDayDropPct) deepDropDays += 1;
      else if (pct[i] < opt.midDropLinePct && pct[i] > opt.maxWashDayDropPct) midDropDays += 1;
    }
    if (!Number.isFinite(platformHigh) || !Number.isFinite(washLow) || !(washLow > 0)) continue;

    const rangePct = (platformHigh - washLow) / washLow;
    if (rangePct < opt.minRangePct || rangePct > opt.maxRangePct) continue; // 洗盘幅度 8%~35%
    if (hasLimitUpInWash) continue;                                        // 洗盘期内不得出现涨停（新版新增过滤）
    if (washMaxVol > peakVol * opt.maxWashVolRatio) continue;              // 洗盘期不得再度放量
    if (washMinVol > peakVol * opt.minShrinkRatio) continue;               // 洗盘期必须缩量
    if (washMaxHigh > platformHigh * opt.upperToleranceHigh) continue;     // 不得突破平台高点
    if (washMaxClose > platformHigh * opt.upperToleranceClose) continue;
    // 爆量日之后的震荡区间内，单日涨跌幅须温和：所有交易日涨跌幅都须在 ±5% 之内；
    // 唯一例外是跌幅介于 -5%~-6%（不含两端）的交易日最多允许 1 天，跌幅超过 -6% 的一律剔除（2026-11-01 用户要求）
    if (washMaxDayPct > opt.maxWashDayGainPct) continue;
    if (deepDropDays > opt.maxDeepDropDays) continue;
    if (midDropDays > opt.maxMidDropDays) continue;
    // 震荡区间最低点不得跌破首板涨停日的开盘价（2026-11-01 用户要求；开盘价缺失时该项不拦截）
    const boardOpenPx = Number(bars[t0].o) > 0 ? Number(bars[t0].o) : null;
    if (opt.requireWashLowAboveBoardOpen && boardOpenPx != null && washLow < boardOpenPx) continue;

    return {
      boardDate: String(bars[t0].d),
      boardOpen: round2(boardOpenPx),
      boardVol: round2(vol[t0]),
      boardCount: twoBoard ? 2 : 1,
      peakDate: String(bars[p].d),
      peakVol: round2(peakVol),
      avg20: round2(avg20),
      peakVolRatio: round2(peakVol / avg20),
      washStartDate: String(bars[washStart].d),
      washEndDate: String(bars[washEnd].d),
      washDays,
      platformHigh: round2(platformHigh),
      washLow: round2(washLow),
      rangePct: round2(rangePct * 100),
      maxVolRatioPct: round2((washMaxVol / peakVol) * 100),
      minVolRatioPct: round2((washMinVol / peakVol) * 100),
      washMaxClose: round2(washMaxClose),
      maxDayPct: round2(washMaxDayPct),
      minDayPct: round2(washMinDayPct),
      deepDropDays,
      midDropDays,
    };
  }

  return null;
};

// 买点日前 20 个交易日内「三日滑动窗口涨幅」的最大值（2026-11-01 用户要求）
//   窗口 = 任意连续 3 个交易日；涨幅 =（窗口末日收盘 − 窗口前一日收盘）÷ 窗口前一日收盘
//   只统计买点日前一交易日及更早的日K（避免未来函数）；历史不足时返回 null（该项不拦截）
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

// 早于训练营回放缓存覆盖范围（20260728 之前，如 2026-07 月初）的日期用标准 5min 时间桶兜底，
// 与回放桶口径保持一致（9:30~11:30 / 13:00~15:00，5 分钟一个桶）
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

// 首板洗盘-起爆拉升卖点扫描（2026-11-01 用户要求）
//   ① 跌破 5 日线：现价 < MA5（MA5 = 当日之前 5 个交易日收盘均值，盘中不含当日收盘）；
//      收益率未拉开 +20% 时盘中分时即卖；已拉开 +20% 时该条不在盘中判定，改由收盘卖点判定
//   ② 跌破成本线 -3%：现价 < 买入价 × 0.97，须连续 5 分钟都跌破才卖（-5% 则立即卖）
//   ③ 盘中跌停：分时跌幅 ≤ -9%（相对昨收）即视为跌停，立即卖
// 逐分钟回溯，取最先触发的那一分钟；同分钟命中多条时优先级 ③ > ②(-5%) > ②(-3%) > ①
const WASH_SELL_COST_STOP_PCT = -3;         // 成本线止损阈值（2026-11-01 用户要求：-2% → -3%）
const WASH_SELL_COST_HARD_STOP_PCT = -5;    // 跌破 -5% 立即卖出、不等观察窗口（2026-11-01 用户要求）
const WASH_SELL_COST_OBSERVE_MINUTES = 5;   // -3% 需连续 5 分钟跌破才卖（2026-11-01 用户要求）
const WASH_SELL_LIMIT_DOWN_PCT = -9;    // 盘中跌幅 ≤ -9% 视为跌停（2026-11-01 用户要求）
// 收盘卖点（2026-11-01 用户要求）：
//   ④ 买入当日收盘涨停、而买入次一交易日收盘未涨停 → 次一交易日收盘卖出；
//      买入次一交易日涨停放量卖点已按用户要求取消
//   ⑤ 收益率已拉开 +20%（收盘口径历史最高收益 ≥ 20%）后，跌破 5 日线只在收盘判定 → 收盘跌破即卖
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
  // 成本线 -3% 连续观察窗口：统计本轮连续跌破的分时点个数（1 分钟 1 点，午休不跨断），
  // 中途回到阈值上方即清零并重新计时
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
    // ③ 盘中跌停（当日跌幅 ≤ -9%，按 -9% 口径）
    if (chg != null && chg <= WASH_SELL_LIMIT_DOWN_PCT) {
      push(p.minute, price, 0,
        `持仓股盘中跌停（昨收 ${preclose.toFixed(2)}，现价 ${price.toFixed(2)}，当日 ${chg}% ≤ ${WASH_SELL_LIMIT_DOWN_PCT}%）即卖出`);
    }
    // ②a 跌破成本线 -5%：立即卖出，不等观察窗口
    if (hardStopPx != null && price < hardStopPx) {
      const costReturn = round2(((price - buyPrice) / buyPrice) * 100);
      push(p.minute, price, 1,
        `持仓股跌破成本线 ${WASH_SELL_COST_HARD_STOP_PCT}%（成本 ${buyPrice.toFixed(2)}，现价 ${price.toFixed(2)}，较成本 ${costReturn}%）立即卖出`);
    }
    // ②b 跌破成本线 -3% 且连续 5 分钟（含首分钟）都跌破：才卖出
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
    // ① 跌破 5 日线（仅在收益率未拉开 +20% 时盘中判定）
    if (profitUnlocked !== true && ma5Px != null && price < ma5Px) {
      const belowPct = round2(((price - ma5Px) / ma5Px) * 100);
      push(p.minute, price, 3,
        `持仓股跌破 5 日线（MA5 ${ma5Px.toFixed(2)}，现价 ${price.toFixed(2)}，低于 5 日线 ${belowPct}%）`);
    }
  }
  return best;
};

const runFirstBoardWashBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.firstBoardWashMode !== true) {
    return { success: false, message: `未知首板洗盘-起爆拉升策略: ${strategyId}` };
  }

  // 不依赖资金/成交量快照：日期序列并入 tech_index 覆盖的交易日（与「情绪游资-极致胜率」同口径，
  // 回测可回溯到 2026-07-01；早于训练营回放缓存的日期用标准 5min 时间桶兜底）
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

  // 账户拆两份、每份半仓（权重 0.5）：最多同时持有 2 只不同股票，各自独立买卖（2026-11-01 用户要求）
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

    // ---- 选股：前置洗盘形态（washout）----
    let selectedReady = false;
    let candidates = [];
    const ensureSelected = async () => {
      if (selectedReady) return;
      selectedReady = true;

      let occStocks = [];
      try {
        const r = await getRecentMultiLianbanOccurrences(dateStr, WASHOUT_LOOKBACK_DAYS, 1);
        occStocks = r.stocks || [];
      } catch (e) { occStocks = []; }

      // 按 code 汇总连板记录：是否出现 ≥3 板
      // 创业板（30/301）、科创板（688）、代码黑名单、题材黑名单（芯片/算力/PCB 等，与「情绪游资-极致胜率」
      // 共用同一份 EXCLUDED_THEMES）在这里统一剔除
      const recordMap = new Map();
      for (const s of occStocks) {
        if (!s || !s.code) continue;
        if (isChiNextOrStar(s.code) || EXCLUDED_CODES.has(s.code) || isThemeExcluded(s.code, s.board)) continue;
        const item = recordMap.get(s.code) || {
          code: s.code, name: s.name || s.code, board: s.board || '',
          maxCount: 0, hasHighBoard: false, latestDate: null,
        };
        const cnt = Number(s.lianbanCount);
        if (Number.isFinite(cnt)) {
          if (cnt >= 3) item.hasHighBoard = true;
          if (cnt > item.maxCount) item.maxCount = cnt;
        }
        const d = String(s.date || '');
        if (d && (!item.latestDate || d > item.latestDate)) item.latestDate = d;
        if (s.board) item.board = s.board;
        recordMap.set(s.code, item);
      }

      // 15（=回溯窗口）内出现过 ≥3 板者一律剔除（保持「首板洗盘」定位）
      const bannedCodes = new Set(
        Array.from(recordMap.values()).filter((x) => x.hasHighBoard).map((x) => x.code),
      );
      const washStocks = Array.from(recordMap.values()).filter((x) => !bannedCodes.has(x.code));

      try { await ensureBarsForCodes(new Set(washStocks.map((x) => x.code))); } catch (e) { /* 日K拉取失败按缺失处理 */ }

      // 前置洗盘判定（washout.js 口径），日K/量能缺失时无法判定 → 剔除
      candidates = [];
      for (const item of washStocks) {
        const bars = getStockBarsCached(item.code);
        if (!bars || bars.length === 0) continue;
        const washout = isPotentialBullWashout(bars, dateNum, { volMult: BACKTEST_VOL_MULT });
        if (!washout) continue;
        // 买点日前 20 个交易日内最大三日滑动窗口涨幅须 ≤ 20%（2026-11-01 用户要求）
        const win3 = maxThreeDayWindowGain(bars, dateNum);
        if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
        washout.maxWin3Pct = win3 != null ? round2(win3) : null;
        if (!seenStocks.has(item.code)) seenStocks.set(item.code, { code: item.code, name: item.name });
        candidates.push({ code: item.code, name: item.name, board: item.board, washout });
      }

      // 总市值 ≤ 100 亿元（2026-11-01 用户要求，由流通市值改为总市值）：由基准日总市值 ÷ 基准日收盘价反推总股本，
      // 预筛按买点日前一交易日收盘价折算、买入时再按实际买入价复核；数据缺失时不拦截
      let prevTradeDate = null;
      try {
        const past = await getPastTradingDates(dateStr, 1);
        prevTradeDate = past && past.length ? String(past[past.length - 1]) : null;
      } catch (e) { prevTradeDate = null; }
      // 预取「当下总市值」（换算基准）：候选多为非自选股，只有通用估值缓存里才拿得到真实总市值
      try { await ensureBacktestValuation(candidates.map((c) => c.code)); } catch (e) { /* 拉取失败时按缺失处理（不拦截） */ }
      candidates = candidates.filter((c) => {
        const info = totalMvInfoFor(c.code, prevTradeDate);
        c.totalShares = info ? info.shares : null;
        c.totalMvYiPrev = info ? info.mvYi : null;
        c.totalMvBase = info
          ? { baseMvYi: info.baseMvYi, baseDate: info.baseDate, baseClose: info.baseClose }
          : null;
        // 预筛：按买点日前一交易日收盘价折算的总市值 ≤ 100 亿元（最终以买入价复核）
        return c.totalMvYiPrev == null || c.totalMvYiPrev <= MAX_TOTAL_MV_YI;
      });
      // 分时加载前剪枝：买点 = 盘中首次 +8%（要求当日最高涨幅 ≥ 8%）或竞价高开 ≥ 5%（9:30 直接买），
      // 因此两者都不满足的候选不可能触发买点，直接剔除，不再为其加载完整分时
      // （候选池常达数百只，可显著降低峰值内存与耗时）；日K缺失时保守保留。
      candidates = candidates.filter((c) => {
        const highChg = stockHighChangeAt(c.code, dateStr);
        if (highChg == null || highChg >= BUY_TRIGGER_PCT) return true;
        // 盘中没到 +8% 的，若竞价高开 ≥ 5% 仍可能是买点（9:30 直接买），不能提前剪掉
        const bars = getStockBarsCached(c.code);
        const idx = bars ? bars.findIndex((b) => String(b.d) === dateStr) : -1;
        if (idx > 0) {
          const pre = Number(bars[idx - 1].c);
          const o = Number(bars[idx].o);
          if (pre > 0 && o > 0 && ((o - pre) / pre) * 100 >= BUY_OPEN_GAP_AUCTION_PCT) return true;
        }
        return false;
      });
    };

    // ---- 候选股分时（流式提取，不保留分时点位）----
    // 候选池可达数百只，若把所有候选的完整分时点数组都留在内存里，全区间回测会撑爆堆内存；
    // 因此逐只加载后立即提取盘中首次 +9% 的买点候选信息（分钟、价格、涨幅），随后丢弃点位。
    const hitMemo = new Map();     // code -> { minute, px, chg }
    const limitUpMemo = new Map(); // code -> { minute, px, chg, atOpen }
    let entriesReady = false;
    const ensureEntries = async () => {
      if (entriesReady) return;
      entriesReady = true;
      if (candidates.length === 0) return;
      await batchParallel(candidates, async (c) => {
        let t = null;
        try { t = await loadTlinePoints(c.code, dateNum); }
        catch (e) { t = null; }
        if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) return;
        const preclose = t.preclose;
        const thr = limitUpThresholdOf(c.code);
        const pts = t.points;
        const inBuyWindow = (p) => p.minute >= BUY_START_MINUTE && p.minute <= BUY_CUTOFF_MINUTE;
        const p0 = pts.find((p) => p.lastPx > 0);
        // 只有「9:30 开盘即涨停」（竞价一字板）买不进；若开盘未涨停、盘中（如 9:31）才冲上涨停，
        // 仍按该分钟价买入（2026-11-01 用户要求，参照 8.17 金健米业）
        let openChg = null;
        if (p0 && p0.minute <= BUY_START_MINUTE) {
          openChg = ((p0.lastPx - preclose) / preclose) * 100;
          if (openChg >= thr) {
            limitUpMemo.set(c.code, { minute: p0.minute, px: p0.lastPx, chg: round2(openChg), atOpen: true });
            return;
          }
          // 竞价高开 ≥ 5%：直接在 9:30 按竞价开盘价买入（2026-11-01 用户要求）
          if (openChg >= BUY_OPEN_GAP_AUCTION_PCT) {
            hitMemo.set(c.code, { minute: p0.minute, px: p0.lastPx, chg: round2(openChg), mode: 'auction' });
            return;
          }
        }
        // 竞价高开 < 5%（或低开）→ 在 9:30–9:40 等分时涨幅首次达到 +8% 时买入
        // 逐分钟回溯：最多允许 1 次回落（某分钟价格低于前一分钟即算一次），
        // 出现第 2 次回落之后的分钟都不算买点（2026-11-01 用户要求：整体须一口气拉升）
        let pullbackCount = 0;
        for (let i = 0; i < pts.length; i += 1) {
          const p = pts[i];
          if (!inBuyWindow(p)) continue;
          if (!(p.lastPx > 0)) continue;
          if (i > 0 && inBuyWindow(pts[i - 1]) && pts[i - 1].lastPx > 0 && p.lastPx < pts[i - 1].lastPx) {
            pullbackCount += 1;
            if (pullbackCount > MAX_INTRADAY_PULLBACKS) break;
          }
          const chg = ((p.lastPx - preclose) / preclose) * 100;
          if (chg < BUY_TRIGGER_PCT) continue;
          // 新版 washout.js 的 breakoutMinRatio：起爆价不得低于平台高点 × 0.80
          // （原算法用买点日收盘价，这里用买点触发价——盘中即可观测，效果等价且不引入未来函数）；
          // 若该分钟触发价过低则继续向后找满足条件的分钟
          const minBreakoutPx = (c.washout.platformHigh || 0) * WASHOUT_OPT.breakoutMinRatio;
          if (p.lastPx < minBreakoutPx) continue;
          hitMemo.set(c.code, { minute: p.minute, px: p.lastPx, chg: round2(chg), mode: 'burst8' });
          break;
        }
      }, 4);
      // 买点信息已提取完毕，立即释放本策略分时缓存（当日不再复用：持仓分时在日初已单独取出）
      clearTlineCache();
    };

    // ---- 隔夜持仓卖点数据（每份持仓各自取分时；买入当日不卖）----
    //   ① 跌破 5 日线 ② 跌破成本线 -2% ③ 盘中跌停 ≤ -9%
    const posTlines = new Map(); // code -> tline（仅隔夜持仓）
    for (const p of positions) {
      if (dateStr > p.buyDate) {
        try {
          const t = await loadTlinePoints(p.code, dateNum);
          if (t) posTlines.set(p.code, t);
        } catch (e) { /* 分时缺失时该份持仓不做盘中卖点判定 */ }
      }
    }
    // 5 日线：MA5 = 当日之前 5 个交易日收盘均值（盘中不含当日收盘价，避免未来函数）；按股票缓存
    const ma5Cache = new Map(); // code -> Map(date -> ma5)
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
      } catch (e) { /* 日K不足时「跌破 5 日线」不判定 */ }
      ma5Cache.set(code, map);
      return map;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 卖出统一入口：登记一笔交易、从持仓中移除该份、标记当日已卖出（卖出当日不再新开仓）
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
        sellReason: `${sellReason}，首板洗盘-起爆拉升（半仓）卖出`,
        returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
        rawReturnRate,
      });
      const idx = positions.indexOf(pos);
      if (idx >= 0) positions.splice(idx, 1);
      soldThisDate = true;
    };

    // ===== ⑤ 买入后的次一交易日竞价低开 → 次日 9:30 竞价直接卖（2026-11-01 用户要求）=====
    //   不论买入当日是否涨停，只要次一交易日竞价低开（开盘涨幅 < 0）即按竞价价卖出
    for (const pos of Array.from(positions)) {
      if (dateStr <= pos.buyDate) continue;
      const prevDate = di > 0 ? allDates[di - 1] : null;
      if (prevDate !== pos.buyDate) continue; // 只在买入次一交易日判定
      const tline = posTlines.get(pos.code);
      // 竞价价 = 当日第一个有效分时点（通常是 9:30）
      const openPt = tline && Array.isArray(tline.points)
        ? tline.points.find((p) => p.lastPx > 0)
        : null;
      if (!openPt || !(tline.preclose > 0)) continue;
      const openChg = ((openPt.lastPx - tline.preclose) / tline.preclose) * 100;
      if (openChg >= 0) continue; // 竞价未低开 → 不卖
      sellPositionAt(pos, BUY_START_MINUTE, openPt.lastPx, round2(openChg),
        `买入次一交易日（${dateDisplay}）竞价低开 ${round2(openChg)}%（昨收 ${round2(tline.preclose)} → 竞价 ${round2(openPt.lastPx)}）→ 9:30 竞价直接卖出`);
    }

    for (let bi = 0; bi < timeBuckets.length; bi += 1) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);

      // ===== 卖出（逐份持仓独立判定，2026-11-01 用户要求）=====
      //   ① 跌破 5 日线（收益率未拉开 +20% 时盘中判定）
      //   ② 跌破成本线 -3%（须连续 5 分钟）/-5%（立即卖） ③ 盘中跌停 ≤ -9%
      //   逐分钟回溯，取最先触发的那一分钟；各份持仓各自卖出、互不影响
      for (const pos of Array.from(positions)) {
        if (dateStr <= pos.buyDate) continue;
        const tline = posTlines.get(pos.code);
        if (!tline || !Array.isArray(tline.points) || tline.points.length === 0) continue;
        const atPt = priceAtMinute(tline.points, bucketMinute);
        if (!atPt || !(atPt.lastPx > 0)) continue;
        const preclose = tline.preclose;

        const profitUnlocked = pos.maxCloseGainPct != null
          && pos.maxCloseGainPct >= WASH_SELL_PROFIT_UNLOCK_PCT;
        // 5 日线只在「收益率未拉开 +20%」时需要（已拉开改由收盘卖点判定）
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

      // ===== 买入（账户拆两份、每份半仓）：盘中分时涨幅首次 +9%，可同时持有 2 只不同股票 =====
      if (positions.length < MAX_POSITIONS && !soldThisDate && bucketMinute <= BUY_CUTOFF_MINUTE + 5) {
        await ensureSelected();
        if (candidates.length > 0) {
          await ensureEntries();

          const heldCodes = new Set(positions.map((p) => p.code));
          const mvRejected = new Set(); // 按买入价折算后总市值 > 100 亿 → 当日顺延
          // 逐份补仓：每一轮取当前最早触发且未持有的候选，最多补到 2 份
          while (positions.length < MAX_POSITIONS) {
            let pick = null;
            // 盘中 +9% 买点：取最早触发分钟（同分钟取涨幅更大者）
            for (const c of candidates) {
              if (heldCodes.has(c.code) || mvRejected.has(c.code)) continue;
              const hit = hitMemo.get(c.code);
              if (!hit || hit.minute > bucketMinute) continue;
              // 市值复核：以该分钟实际买入价折算总市值（回测日期当天股价口径），> 100 亿顺延下一只
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
                pick = { cand: c, hit, mvYiAtBuy, mode: hit.mode || 'burst8' };
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
                mode: pick.mode,
                washout: pick.cand.washout,
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

    // ===== 收盘卖点（2026-11-01 用户要求，按当日日K收盘口径判定，逐份持仓独立判定）=====
    //   买入日当天只记录「收盘口径历史最高收益」（供是否已拉开 +20% 的判定），不做卖出
    //   ④ 买入当日收盘涨停、买入次一交易日收盘未涨停 → 次一交易日收盘卖出（2026-11-01 用户要求）
    //   ①（收盘分支）收益率已拉开 +20% 后，「跌破 5 日线」改为收盘判定：收盘价 < MA5 → 当日收盘卖出
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

          if (dateStr > pos.buyDate) {
            const dayLimitUp = dayPct != null && dayPct >= thr;

            // ④ 买入当日收盘涨停，而买入次一交易日收盘未涨停 → 次一交易日收盘卖出（2026-11-01 用户要求）
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
            // ①（收盘分支）收益率已拉开 +20%：跌破 5 日线只在收盘判定（收盘价 < MA5 → 收盘卖出）
            if (positions.includes(pos) && pos.maxCloseGainPct != null
              && pos.maxCloseGainPct >= WASH_SELL_PROFIT_UNLOCK_PCT) {
              const ma5Map = await ensureMa5(pos.code);
              const ma5 = ma5Map ? ma5Map.get(dateStr) : null;
              if (ma5 != null && closePx > 0 && closePx < ma5) {
                sellPositionAt(pos, 1500, closePx, dayPct,
                  `收益率已拉开 +${WASH_SELL_PROFIT_UNLOCK_PCT}%（收盘口径历史最高 ${pos.maxCloseGainPct}%），当日收盘跌破 5 日线（收盘 ${closePx.toFixed(2)} < MA5 ${ma5}）→ 收盘卖出`);
              }
            }
          }
        }
      } catch (e) { /* 日K缺失时不判定收盘卖点 */ }
    }

    // 每日结束释放分时内存缓存：单日候选池可达数百只，若跨日累积（stock.js 的
    // tlineResultMemCache / tlineFileMemCache）全区间回测会撑爆堆内存（磁盘缓存不受影响）
    clearTlineMemCache();
  }

  // 组装结果（期末可能同时持有 2 份，每份半仓）
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
    ? `前置洗盘：${w.boardCount} 板 ${w.boardDate} → ${w.peakDate} 放量峰值（${w.peakVolRatio} 倍 ≥ ${BACKTEST_VOL_MULT} 倍）→ ${w.washStartDate}~${w.washEndDate} 缩量洗盘 ${w.washDays} 日（最大量 ${w.maxVolRatioPct}% ≤ 95%、最小量 ${w.minVolRatioPct}% ≤ 60%），洗盘幅度 ${gainText(w.rangePct)}（8%~35%），单日涨幅最大 ${gainText(w.maxDayPct)}、跌幅最大 ${gainText(w.minDayPct)}（超 -6% 共 ${w.deepDropDays} 天 ≤ 1），洗盘最低 ${w.washLow} 未跌破首板开盘 ${w.boardOpen != null ? w.boardOpen : '数据缺失'}，未突破平台高点 ${w.platformHigh}`
    : null;
  const modeText = t.mode === 'auction'
    ? `${fmtMinute(t.hitMinute)} 竞价高开 ${gainText(t.hitChange)}（≥ ${BUY_OPEN_GAP_AUCTION_PCT}%）直接按竞价开盘价买入`
    : `盘中 ${fmtMinute(t.hitMinute)} 分时涨幅 ${gainText(t.hitChange)} 首次达到 +${BUY_TRIGGER_PCT}%`;
  return `候选 ${t.pool.length} 只（${washText}），${pos.stockName} ${modeText}${skipText}，成交价 ${pos.buyPrice.toFixed(2)} 买入（半仓）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  const w = t.washout || {};
  const checks = [
    {
      id: 'fbw_washout',
      title: '前置洗盘：首/二板 → 放量峰值 → 5~12 日缩量洗盘（不突破、不破位、不跌破首板开盘价）',
      passed: !!t.washout,
      value: t.washout
        ? `${w.boardCount} 板 ${w.boardDate}（开盘 ${w.boardOpen != null ? w.boardOpen : '数据缺失'}），峰值 ${w.peakDate} 量 ${w.peakVol}（前 20 日均量 ${w.avg20}，${w.peakVolRatio} 倍）；洗盘 ${w.washStartDate}~${w.washEndDate} 共 ${w.washDays} 日，最大量 ${w.maxVolRatioPct}%、最小量 ${w.minVolRatioPct}%，区间幅度 ${gainText(w.rangePct)}，单日涨幅最大 ${gainText(w.maxDayPct)} / 跌幅最大 ${gainText(w.minDayPct)}（所有交易日涨跌幅须在 ±5% 内，唯一例外是跌幅 -5%~-6% 最多 ${WASHOUT_OPT.maxMidDropDays} 天——本样本 ${w.midDropDays} 天；跌幅超 -6% 的 ${w.deepDropDays} 天一律不允许），洗盘最低 ${w.washLow}（未跌破首板开盘价），平台高点 ${w.platformHigh}`
        : '未命中前置洗盘形态',
      reason: `参照 washout.js 最新版 isPotentialBullWashout：首板日（可叠加二板）须涨停（≥ ${WASHOUT_OPT.limitPct}%）→ 首板日（含）后 ${WASHOUT_OPT.maxBaseToPeak} 个交易日内出现放量峰值（≥ 首板日前 20 日均量的 ${BACKTEST_VOL_MULT} 倍）→ 之后 ${WASHOUT_OPT.minWashDays}~${WASHOUT_OPT.maxWashDays} 个交易日缩量洗盘（最大量 ≤ 峰值量 ${WASHOUT_OPT.maxWashVolRatio * 100}%、最小量 ≤ 峰值量 ${WASHOUT_OPT.minShrinkRatio * 100}%、洗盘期内不得出现涨停）→ 洗盘期最高价 ≤ 平台高点 ${WASHOUT_OPT.upperToleranceHigh} 倍、最高收盘 ≤ ${WASHOUT_OPT.upperToleranceClose} 倍 → 洗盘区间幅度 ${WASHOUT_OPT.minRangePct * 100}%~${WASHOUT_OPT.maxRangePct * 100}% → 洗盘期内单日涨跌幅须温和：所有交易日涨跌幅都须在 ±5% 之内（最大单日涨幅 ≤ ${gainText(WASHOUT_OPT.maxWashDayGainPct)}、单日跌幅不低于 ${gainText(WASHOUT_OPT.midDropLinePct)}），唯一例外是单日跌幅介于 ${gainText(WASHOUT_OPT.midDropLinePct)}~${gainText(WASHOUT_OPT.maxWashDayDropPct)}（不含两端）的日子最多 ${WASHOUT_OPT.maxMidDropDays} 天、跌幅超过 ${gainText(WASHOUT_OPT.maxWashDayDropPct)} 的一律剔除（2026-11-01 用户要求）→ 洗盘最低价不得跌破首板涨停日开盘价（2026-11-01 用户要求，开盘价缺失时不拦截）→ 起爆前（买点触发价）≥ 平台高点 ${Math.round(WASHOUT_OPT.breakoutMinRatio * 100) / 100} 倍。洗盘区间只取买点日前一交易日及更早（不使用买点日自身日K）`,
    },
    {
      id: 'fbw_win3_cap',
      title: `买点日前 ${WIN3_LOOKBACK_DAYS} 个交易日内最大三日滑动窗口涨幅 ≤ ${MAX_WIN3_GAIN_PCT}%`,
      passed: true,
      value: w.maxWin3Pct != null
        ? `本样本最大三日滑动窗口涨幅 ${gainText(w.maxWin3Pct)}（≤ ${MAX_WIN3_GAIN_PCT}%）`
        : '历史日K不足 3 日，该项不拦截',
      reason: `按买点日前一交易日及更早日K，取最近 ${WIN3_LOOKBACK_DAYS} 个交易日内任意连续 3 个交易日的涨幅（末日收盘 − 窗口前一日收盘 ÷ 窗口前一日收盘）的最大值，超过 ${MAX_WIN3_GAIN_PCT}% 的个股一律剔除（不追短期已大涨的票，2026-11-01 用户要求）`,
    },
    {
      id: 'fbw_total_mv',
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
      reason: `总股本近似不变、市值 ∝ 股价：先由「当下总市值 ÷ 当下股价」反推总股本（自选股用 monitor_stocks_valuation，非自选股用 data/backtest_stock_valuation.json 的财联社 mc；数据缺失时不拦截），再把股本 × 买入日该分钟实际买入价折算出回测日当天的总市值，> ${MAX_TOTAL_MV_YI} 亿元即剔除并顺延下一只（候选池预筛用买点日前一交易日收盘价，最终以买入价复核）`,
    },
    {
      id: 'fbw_entry',
      title: `买点：竞价 ≥ ${BUY_OPEN_GAP_AUCTION_PCT}% 直接 9:30 买入 / 竞价 < ${BUY_OPEN_GAP_AUCTION_PCT}% 分时 +${BUY_TRIGGER_PCT}% 买入（最多 ${MAX_INTRADAY_PULLBACKS} 次回落）`,
      passed: true,
      value: `${fmtMinute(t.hitMinute)} ${pos.stockName} ${gainText(t.hitChange)}（${t.mode === 'auction' ? '竞价直接买入' : `盘中 +${BUY_TRIGGER_PCT}% 买入`}）`,
      reason: `买点分两条路径（2026-11-01 用户要求）：① 竞价高开 ≥ ${BUY_OPEN_GAP_AUCTION_PCT}% → 直接在 ${fmtMinute(BUY_START_MINUTE)} 按竞价开盘价买入；② 竞价高开 < ${BUY_OPEN_GAP_AUCTION_PCT}%（含低开）→ 在 ${fmtMinute(BUY_START_MINUTE)}–${fmtMinute(BUY_CUTOFF_MINUTE)} 内等待分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 时按该分钟分时价买入（逐分钟回溯，**最多允许 ${MAX_INTRADAY_PULLBACKS} 次回落**，某分钟价格低于前一分钟算一次，出现第 2 次回落即当日不买）。两条路径都只在 ${fmtMinute(BUY_CUTOFF_MINUTE)} 之前有效（之后不再买入）；只有 ${fmtMinute(BUY_START_MINUTE)} 开盘即涨停（竞价一字板）买不进，开盘未涨停而盘中（如 9:31）冲上涨停仍按该分钟价买入`,
    },
    {
      id: 'fbw_limit_up_skip',
      title: '开盘涨停买不进：9:30 开盘即涨停（竞价一字板）的候选顺延',
      passed: true,
      value: (t.skippedLimitUp || []).length > 0
        ? (t.skippedLimitUp || []).map((x) => `${x.name}（${fmtMinute(x.minute)} 涨幅 ${gainText(x.chg)}，开盘即涨停买不进）`).join('；')
        : '当日无「开盘即涨停」的候选被顺延',
      reason: '只有 9:30 开盘即涨停（竞价一字板，涨幅 ≥ 涨停阈值，候选池已剔除创业板/科创板按主板 9.5%）视为买不进；若开盘未涨停、盘中（如 9:31）才冲上涨停，仍可买入（2026-11-01 用户要求）',
    },
  ];
  return checks;
};

// 线上服务（service/firstBoardWashLive.js）复用同一份前置洗盘判定 / 买点常量，保证线上与回测口径一致
module.exports = {
  runFirstBoardWashBacktest,
  isPotentialBullWashout,
  isThemeExcluded,
  maxThreeDayWindowGain,
  WASHOUT_OPT,
  WASHOUT_LOOKBACK_DAYS,
  BUY_TRIGGER_PCT,
  BUY_OPEN_GAP_AUCTION_PCT,
  BUY_START_MINUTE,
  BUY_CUTOFF_MINUTE,
  MAX_INTRADAY_PULLBACKS,
  MAX_FLOAT_MV_YI,
  MAX_WIN3_GAIN_PCT,
  WIN3_LOOKBACK_DAYS,
};
