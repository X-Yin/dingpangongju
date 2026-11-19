// ============================================================
// 情绪游资-极致赔率 · 线上常驻服务（2026-11-01 用户要求）
//   把回测引擎 engine/washFusionExtremeOddsBacktest.js 的策略搬到线上：
//     股票列表分两组：A 首板起爆（首板洗盘-起爆拉升）、B 二板起爆（放量洗盘-二板起爆）；
//     买点诊断 3s 时间桶、提示不限频控；卖点诊断 1min 时间桶（由 sellPointPushService 调度）。
//   A 首板起爆竞价买点诊断仍在 9:25-9:30 执行，提示带 30s 频控（9:30 按竞价开盘价直接买入）；
//   A 盘中 +8% 买点仅 9:30-9:40；B 盘中 +8% 买点 9:30-14:30（竞价必须高开、一字板买不进）。
//   本服务仅在全局策略模式 = wash_fusion_extreme_odds 时轮询，避免与其他模式重复消耗行情接口。
// ============================================================
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { isTradingDay, getNextTradingDay } = require('../utils/tradingDay');
const { batchParallel } = require('../utils');
const {
  ensureBarsForCodes,
  getStockBarsCached,
  getRecentMultiLianbanOccurrences,
  getPastTradingDates,
} = require('./buySellBacktest/deps');
const { EXCLUDED_CODES } = require('./buySellBacktest/constants');
const {
  isPotentialBullWashout,
  isThemeExcluded,
  maxThreeDayWindowGain,
  totalMvInfoFor,
  WASHOUT_OPT,
  WASHOUT_LOOKBACK_DAYS,
  BACKTEST_VOL_MULT,
  BUY_TRIGGER_PCT,
  BUY_SEAL_PCT,
  BUY_OPEN_GAP_AUCTION_PCT,
  BUY_START_MINUTE,
  BUY_CUTOFF_MINUTE,
  MAX_INTRADAY_PULLBACKS,
  MAX_TOTAL_MV_YI,
  MAX_WIN3_GAIN_PCT,
} = require('./buySellBacktest/engine/firstBoardWashBacktest');
const {
  matchVolumeWashout,
  analyzeBoardDayTline,
  WASHOUT_LOOKBACK_DAYS: VWS_LOOKBACK_DAYS,
  BUY_CUTOFF_MINUTE: B_BUY_CUTOFF_MINUTE,
} = require('./buySellBacktest/engine/volumeWashoutSecondBoardBacktest');
const { loadTlinePoints, round2, limitUpThresholdOf } = require('./buySellBacktest/engine/extremeWinScores');
// 线上极致赔率：分时失败按同花顺→财联社（当日再兜底连板网）严格重试，不再一次失败就剔除个股
const loadTlinePointsStrict = (code, dateNum) => loadTlinePoints(code, dateNum, { strict: true });
const { ensureBacktestValuation } = require('./watchlistValuation');
const { getRealtimeQuotes, isBjStockCode } = require('./stock');
const wsServer = require('../wsServer');
const feishuNotify = require('./feishuNotify');
const strategyModeState = require('./strategyModeState');
const { logWashFusion } = require('./diagnosisLog');
const { maybeWashFusionPreheat } = require('./buyPointPreheat');

const MODE_WASH_FUSION = 'wash_fusion_extreme_odds';
const SOURCE_A = 'first_board_wash';
const SOURCE_B = 'second_board_wash';
const SOURCE_LABELS = {
  [SOURCE_A]: '首板起爆',
  [SOURCE_B]: '二板起爆',
};

// ===== 时间窗（分钟数，0 点起算）=====
const PREPARE_MINUTE = 9 * 60 + 10;       // 09:10 起准备当日候选股
const POLL_START_MINUTE = 9 * 60 + 15;    // 09:15 起每 3s 轮询
const AUCTION_END_MINUTE = 9 * 60 + 25;   // 09:25 竞价结束，开始买点诊断
const POLL_END_MINUTE = 15 * 60;          // 15:00 停止轮询
const TICK_MS = 3 * 1000;
const AUCTION_REMIND_MS = 30 * 1000;      // A 竞价买点提前提醒间隔（30s 一次）
const B_CUTOFF = B_BUY_CUTOFF_MINUTE;     // B 二板起爆最晚买入 14:30

const statePath = path.resolve(__dirname, '../data/wash_fusion_online_state.json');

let timer = null;
let running = false;
let poolCache = { date: null, pools: null, computedAt: null };
let poolInflight = null;
let quoteRows = [];                       // 最近一次带实时快照的候选行（A/B 合并）
let quoteRowsTs = 0;
const auctionGaps = new Map();            // code -> { gap, price, preclose, at }
const aAuctionSignaled = new Set();
const aBurstSignaled = new Set();
const bSignaled = new Set();
const auctionRemindAt = new Map();
let stateDate = null;

const readState = () => {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
};

const writeState = (patch) => {
  try {
    const prev = readState();
    fs.writeFileSync(statePath, JSON.stringify({ ...prev, ...patch }, null, 2));
  } catch (e) {
    console.error('写入情绪游资-极致赔率线上状态失败:', e.message);
  }
};

const ensureDayState = (dateStr) => {
  if (stateDate === dateStr) return;
  stateDate = dateStr;
  auctionGaps.clear();
  aAuctionSignaled.clear();
  aBurstSignaled.clear();
  bSignaled.clear();
  auctionRemindAt.clear();
  mvRejectedCodes.clear();
  quoteRows = [];
  quoteRowsTs = 0;
  const s = readState();
  if (s && s.date === dateStr) {
    for (const code of Array.isArray(s.aAuctionSignaled) ? s.aAuctionSignaled : []) aAuctionSignaled.add(code);
    for (const code of Array.isArray(s.aBurstSignaled) ? s.aBurstSignaled : []) aBurstSignaled.add(code);
    for (const code of Array.isArray(s.bSignaled) ? s.bSignaled : []) bSignaled.add(code);
    for (const code of Array.isArray(s.mvRejectedCodes) ? s.mvRejectedCodes : []) mvRejectedCodes.add(code);
  }
};

const persistSignals = (dateStr) => writeState({
  date: dateStr,
  aAuctionSignaled: Array.from(aAuctionSignaled),
  aBurstSignaled: Array.from(aBurstSignaled),
  bSignaled: Array.from(bSignaled),
  mvRejectedCodes: Array.from(mvRejectedCodes),
});

const isChiNextOrStar = (code) => /^(30|688)/.test(String(code || '').replace(/^(sh|sz|bj)/i, ''));

// 线上洗盘形态判定：日K未包含当日（盘前/开盘初）时追加一根仅含日期的占位 bar，
// 使 eIdx（买点日前一交易日）落在最后一根真实日K上（与回测口径一致）
const barsForEval = (bars, todayNum) => {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const last = bars[bars.length - 1];
  if (Number(last.d) >= todayNum) return bars;
  return [...bars, { d: todayNum }];
};

const lastCloseOf = (bars, dateNum) => {
  if (!Array.isArray(bars)) return null;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (Number(bars[i].d) <= dateNum && Number(bars[i].c) > 0) return Number(bars[i].c);
  }
  return null;
};

// 最近一个交易日（日K最后一根真实 bar）的当日涨幅与竞价高开：
// 非交易日 / 盘前 / 收盘后展示时无法取实时快照，用日K现算，避免「当日 / 竞价」列显示为空
const latestBarStats = (bars) => {
  if (!Array.isArray(bars) || bars.length < 2) return { change: null, auctionGap: null };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prevClose = Number(prev && prev.c);
  const close = Number(last && last.c);
  if (!(prevClose > 0) || !(close > 0)) return { change: null, auctionGap: null };
  const change = round2(((close - prevClose) / prevClose) * 100);
  const open = last.o != null && Number(last.o) > 0 ? Number(last.o) : null;
  const auctionGap = open != null ? round2(((open - prevClose) / prevClose) * 100) : null;
  return { change, auctionGap };
};

// ============================================================
// 候选池计算：A 首板起爆 + B 二板起爆（与回测选股阶段同口径）
// ============================================================
// 日K统一按最新口径取：ensureBarsForCodes 的 force 会清掉进程内旧快照，再走 getStockBars
//（盘中有当日 K 线前命中内存缓存开销极小；收盘后首次会补拉当日收盘 K，避免用盘中旧数据算下一买点）
const computePools = async (dateStr) => {
  const dateNum = Number(dateStr);
  let prevTradeDate = null;
  try {
    const past = await getPastTradingDates(dateStr, 1);
    prevTradeDate = past && past.length ? String(past[past.length - 1]) : null;
  } catch (e) { prevTradeDate = null; }

  // ---- A 首板起爆 ----
  const collectFirstBoard = async () => {
    let occStocks = [];
    try {
      const r = await getRecentMultiLianbanOccurrences(dateStr, WASHOUT_LOOKBACK_DAYS, 1);
      occStocks = r.stocks || [];
    } catch (e) { occStocks = []; }

    const recordMap = new Map();
    for (const s of occStocks) {
      if (!s || !s.code) continue;
      // 与回测 collectRawPool 同口径：剔除创业板/科创板、北交所、黑名单代码、题材黑名单
      if (isChiNextOrStar(s.code) || isBjStockCode(s.code) || EXCLUDED_CODES.has(s.code) || isThemeExcluded(s.code, s.board)) continue;
      const item = recordMap.get(s.code) || {
        code: s.code, name: s.name || s.code, board: s.board || '', hasHighBoard: false,
      };
      const cnt = Number(s.lianbanCount);
      if (Number.isFinite(cnt) && cnt >= 3) item.hasHighBoard = true;
      if (s.board) item.board = s.board;
      recordMap.set(s.code, item);
    }

    const washStocks = Array.from(recordMap.values()).filter((x) => !x.hasHighBoard);
    try { await ensureBarsForCodes(new Set(washStocks.map((x) => x.code)), { force: true, strict: true, windowMs: 8000 }); } catch (e) { /* 日K严格重试后仍失败：不缓存空值，下一轮继续 */ }

    const out = [];
    for (const item of washStocks) {
      const bars = getStockBarsCached(item.code);
      if (!bars || bars.length === 0) continue;
      const evalBars = barsForEval(bars, dateNum);
      const washout = isPotentialBullWashout(evalBars, dateNum, { volMult: BACKTEST_VOL_MULT });
      if (!washout) continue;
      const win3 = maxThreeDayWindowGain(evalBars, dateNum);
      if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
      washout.maxWin3Pct = win3 != null ? round2(win3) : null;
      out.push({
        code: item.code,
        name: item.name,
        board: item.board,
        source: SOURCE_A,
        sourceLabel: SOURCE_LABELS[SOURCE_A],
        washout,
        lastClose: lastCloseOf(bars, dateNum),
      });
    }
    return out;
  };

  // ---- B 二板起爆 ----
  const collectSecondBoard = async () => {
    if (!prevTradeDate) return [];
    let occStocks = [];
    try {
      const r = await getRecentMultiLianbanOccurrences(dateStr, VWS_LOOKBACK_DAYS, 1);
      occStocks = r.stocks || [];
    } catch (e) { occStocks = []; }

    const recordMap = new Map();
    for (const s of occStocks) {
      if (!s || !s.code) continue;
      // 与回测 collectRawPool 同口径：剔除创业板/科创板、北交所、黑名单代码、题材黑名单
      if (isChiNextOrStar(s.code) || isBjStockCode(s.code) || EXCLUDED_CODES.has(s.code) || isThemeExcluded(s.code, s.board)) continue;
      const item = recordMap.get(s.code) || {
        code: s.code, name: s.name || s.code, board: s.board || '', hasHighBoard: false, firstBoardAtPrev: false,
      };
      const cnt = Number(s.lianbanCount);
      if (Number.isFinite(cnt) && cnt >= 3) item.hasHighBoard = true;
      const d = String(s.date || '');
      if (cnt === 1 && d === prevTradeDate) item.firstBoardAtPrev = true;
      if (s.board) item.board = s.board;
      recordMap.set(s.code, item);
    }

    const poolStocks = Array.from(recordMap.values()).filter((x) => !x.hasHighBoard && x.firstBoardAtPrev);
    try { await ensureBarsForCodes(new Set(poolStocks.map((x) => x.code)), { force: true, strict: true, windowMs: 8000 }); } catch (e) { /* 日K严格重试后仍失败：不缓存空值，下一轮继续 */ }

    const prevNum = parseInt(prevTradeDate, 10);
    const out = [];
    for (const item of poolStocks) {
      const bars = getStockBarsCached(item.code);
      if (!bars || bars.length === 0) continue;
      const washout = matchVolumeWashout(bars, prevNum);
      if (!washout) continue;
      const win3 = maxThreeDayWindowGain(barsForEval(bars, dateNum), dateNum);
      if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
      washout.maxWin3Pct = win3 != null ? round2(win3) : null;
      // 与 A 统一字段：前端/文案统一读取 washDays、rangePct（B 原始字段为 shockDays、platformRangePct）
      washout.washDays = washout.shockDays;
      washout.rangePct = washout.platformRangePct;
      out.push({
        code: item.code,
        name: item.name,
        board: item.board,
        source: SOURCE_B,
        sourceLabel: SOURCE_LABELS[SOURCE_B],
        washout,
        lastClose: lastCloseOf(bars, prevNum),
      });
    }

    // 首板日（T-1）分时限制：断板 ≤ 1 次、封板满 20 分钟无漏量（与回测口径一致）
    await batchParallel(out, async (c) => {
      let bt = null;
      try { bt = await loadTlinePointsStrict(c.code, prevNum); } catch (e) { bt = null; }
      c.boardCheck = analyzeBoardDayTline(c.code, bt);
      return null;
    }, 4);
    return out.filter((c) => !(c.boardCheck && c.boardCheck.failed));
  };

  const [aPool, bPoolRaw] = await Promise.all([collectFirstBoard(), collectSecondBoard()]);

  // 同一只股票同时命中两个策略时只保留 A（首板起爆）一份
  const seen = new Set();
  const merged = [];
  for (const c of [...aPool, ...bPoolRaw]) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    merged.push(c);
  }

  // 总市值 ≤ 100 亿元（按买点日前一交易日收盘价折算；数据缺失不拦截）
  try { await ensureBacktestValuation(merged.map((c) => c.code)); } catch (e) { /* 拉取失败按缺失处理 */ }
  const kept = merged.filter((c) => {
    const info = totalMvInfoFor(c.code, prevTradeDate);
    c.totalShares = info ? info.shares : null;
    c.totalMvYi = info ? round2(info.mvYi) : null;
    return c.totalMvYi == null || c.totalMvYi <= MAX_TOTAL_MV_YI;
  });

  const firstBoard = kept
    .filter((c) => c.source === SOURCE_A)
    .sort((a, b) => (b.washout.rangePct || 0) - (a.washout.rangePct || 0));
  const secondBoard = kept
    .filter((c) => c.source === SOURCE_B)
    .sort((a, b) => (b.washout.rangePct || 0) - (a.washout.rangePct || 0));

  return { date: dateStr, prevTradeDate, firstBoard, secondBoard };
};

const getPools = async ({ dateStr = dayjs().format('YYYYMMDD'), refresh = false } = {}) => {
  if (!refresh && poolCache.date === dateStr && poolCache.pools) {
    return { pools: poolCache.pools, computedAt: poolCache.computedAt };
  }
  if (poolInflight && poolInflight.date === dateStr) {
    // 手动刷新必须真正重算：先等当前轮算完，再强制重算一次，避免直接复用 3s 轮询中的结果
    await poolInflight.promise;
    if (!refresh) return { pools: poolCache.pools, computedAt: poolCache.computedAt };
  }
  const promise = (async () => {
    try {
      const pools = await computePools(dateStr);
      poolCache = { date: dateStr, pools, computedAt: dayjs().format('YYYY-MM-DD HH:mm:ss') };
    } catch (e) {
      console.error('情绪游资-极致赔率候选池计算失败:', e.message);
      if (poolCache.date !== dateStr) {
        poolCache = { date: dateStr, pools: { date: dateStr, prevTradeDate: null, firstBoard: [], secondBoard: [] }, computedAt: null };
      }
    }
  })();
  poolInflight = { date: dateStr, promise };
  try { await promise; } finally { poolInflight = null; }
  return { pools: poolCache.pools, computedAt: poolCache.computedAt };
};

// ============================================================
// 实时快照 / 买点诊断
// ============================================================
const fetchQuotes = async (codes) => {
  if (!codes || codes.length === 0) return {};
  try { return await getRealtimeQuotes(codes) || {}; } catch (e) { return {}; }
};

const fmtMinute = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
const fmtClock = (m) => `${String(Math.floor(Number(m) / 60)).padStart(2, '0')}:${String(Number(m) % 60).padStart(2, '0')}`;
const gainText = (v) => (v == null ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

const buildRules = () => ({
  buyTriggerPct: BUY_TRIGGER_PCT,
  buySealPct: BUY_SEAL_PCT,
  auctionBuyPct: BUY_OPEN_GAP_AUCTION_PCT,
  firstBoardBuyWindow: `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(BUY_CUTOFF_MINUTE)}`,
  secondBoardBuyWindow: `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(B_CUTOFF)}`,
  auctionRemindWindow: `${fmtClock(AUCTION_END_MINUTE)}-${fmtClock(BUY_START_MINUTE)}`,
  auctionRemindSeconds: AUCTION_REMIND_MS / 1000,
  maxPullbacks: MAX_INTRADAY_PULLBACKS,
  maxTotalMvYi: MAX_TOTAL_MV_YI,
});

const statusOf = (c, quotes, nowMinute) => {
  const q = quotes[c.code] || {};
  const price = q.price != null ? Number(q.price) : null;
  const preclose = q.preclose != null && Number(q.preclose) > 0 ? Number(q.preclose) : c.lastClose;
  const change = q.change != null ? Number(q.change)
    : (price != null && preclose > 0 ? ((price - preclose) / preclose) * 100 : null);
  // 竞价涨幅只认真实竞价（2026-11-16 用户反馈）：auctionGaps 缺失时置 null，不再用实时涨幅兜底。
  // 否则盘中涨幅 ≥5% 会被当成「竞价买点」返回 auction_buy，前端打出「买点触发」但后端从未推送卡片。
  const auction = auctionGaps.get(c.code) || null;
  const auctionGap = auction ? auction.gap : null;
  const limitThreshold = limitUpThresholdOf(c.code);
  // 买入价折算总市值超 100 亿 → 当日拉黑（与回测 mvRejected 顺延口径一致，2026-11-05 对齐）
  if (mvRejectedCodes.has(c.code)) {
    return { status: 'mv_over', statusText: '买入价折算总市值超 100 亿，当日不参与' };
  }
  if (c.source === SOURCE_A) {
    if (auctionGap != null && auctionGap >= limitThreshold) {
      return { status: 'limit_open', statusText: '开盘即涨停，买不进' };
    }
    // 涨幅 ≥ 9.5% 视为已涨停封板，不能再买入（2026-11-17 用户要求，与回测口径一致）
    if (auctionGap != null && auctionGap >= BUY_SEAL_PCT) {
      return { status: 'limit_open', statusText: `竞价涨幅 ${round2(auctionGap)}% ≥ ${BUY_SEAL_PCT}% 视为涨停，买不进` };
    }
    if (aAuctionSignaled.has(c.code)) return { status: 'auction_buy', statusText: '9:30 竞价直接买入' };
    if (aBurstSignaled.has(c.code)) return { status: 'burst_buy', statusText: '盘中 +8% 已触发' };
    if (auctionGap != null && auctionGap >= BUY_OPEN_GAP_AUCTION_PCT) {
      return { status: 'auction_buy', statusText: '竞价 ≥ 5%，9:30 买入' };
    }
    if (nowMinute > BUY_CUTOFF_MINUTE) return { status: 'miss', statusText: '9:40 前未触发' };
    if (nowMinute >= BUY_START_MINUTE) return { status: 'watching', statusText: '等盘中 +8%' };
    if (auctionGap != null) return { status: 'watching', statusText: '竞价 < 5%，等 +8%' };
    return { status: 'pending', statusText: '待竞价' };
  }
  // B 二板起爆
  if (auctionGap != null && auctionGap >= limitThreshold) {
    return { status: 'limit_open', statusText: '开盘即涨停，买不进' };
  }
  if (auctionGap != null && auctionGap >= BUY_SEAL_PCT) {
    return { status: 'limit_open', statusText: `竞价涨幅 ${round2(auctionGap)}% ≥ ${BUY_SEAL_PCT}% 视为涨停，买不进` };
  }
  if (auctionGap != null && auctionGap <= 0) {
    return { status: 'gap_down', statusText: '竞价未高开，不参与' };
  }
  if (bSignaled.has(c.code)) return { status: 'burst_buy', statusText: '盘中 +8% 已触发' };
  if (nowMinute > B_CUTOFF) return { status: 'miss', statusText: '14:30 前未触发' };
  if (nowMinute >= BUY_START_MINUTE) return { status: 'watching', statusText: '等盘中 +8%' };
  return { status: 'pending', statusText: '待竞价' };
};

const buildRows = (pools, quotes, nowMinute) => {
  const list = [...(pools.firstBoard || []), ...(pools.secondBoard || [])];
  return list.map((c) => {
    const q = quotes[c.code] || {};
    const price = q.price != null ? Number(q.price) : null;
    const preclose = q.preclose != null && Number(q.preclose) > 0 ? Number(q.preclose) : c.lastClose;
    const change = q.change != null ? Number(q.change)
      : (price != null && preclose > 0 ? ((price - preclose) / preclose) * 100 : null);
    const auction = auctionGaps.get(c.code) || null;
    // 与 statusOf 同口径：缺失真实竞价时返回 null（前端显示 --），不用实时涨幅冒充竞价
    const auctionGap = auction ? auction.gap : null;
    const st = statusOf(c, quotes, nowMinute);
    return {
      code: c.code,
      name: c.name,
      board: c.board,
      source: c.source,
      sourceLabel: c.sourceLabel,
      totalMvYi: c.totalMvYi,
      washout: c.washout,
      boardCheck: c.boardCheck || null,
      preclose: preclose != null ? round2(preclose) : null,
      price: price != null ? round2(price) : null,
      change: change != null ? round2(change) : null,
      auctionGap: auctionGap != null ? round2(auctionGap) : null,
      status: st.status,
      statusText: st.statusText,
      // 是否真实命中（后端已推送买点卡片）：前端「买点触发」标签以此为准，不再用 status 推导
      hit: c.source === SOURCE_A
        ? (aAuctionSignaled.has(c.code) || aBurstSignaled.has(c.code))
        : bSignaled.has(c.code),
    };
  });
};

// 首板 / 二板两组列表统一按「当日涨幅」从高到低排序（缺失涨幅的置后）
const byChangeDesc = (a, b) => {
  const av = a.change != null && Number.isFinite(Number(a.change)) ? Number(a.change) : -Infinity;
  const bv = b.change != null && Number.isFinite(Number(b.change)) ? Number(b.change) : -Infinity;
  return bv - av;
};

const splitGroups = (rows) => ({
  firstBoard: rows.filter((r) => r.source === SOURCE_A).sort(byChangeDesc),
  secondBoard: rows.filter((r) => r.source === SOURCE_B).sort(byChangeDesc),
});

const broadcastCandidates = (dateStr, rows, updatedAt, open = false) => {
  const groups = splitGroups(rows);
  wsServer.broadcast({
    type: 'wash_fusion_candidates',
    ts: Date.now(),
    open,
    data: {
      date: dateStr,
      updatedAt,
      count: rows.length,
      firstBoardCount: groups.firstBoard.length,
      secondBoardCount: groups.secondBoard.length,
      firstBoard: groups.firstBoard,
      secondBoard: groups.secondBoard,
      rules: buildRules(),
      // 能走到这里说明该模式处于生效状态，实时推送正在运行
      pushing: true,
    },
  });
  // 每个 3s 诊断周期都落盘一条候选池摘要（无论是否命中）；只记数量，避免日志体积过大，
  // 命中个股由 emitBuySignal 单独记录
  logWashFusion({
    date: dateStr,
    firstBoardCount: groups.firstBoard.length,
    secondBoardCount: groups.secondBoard.length,
    rows: [],
    note: `${open ? '候选池推送(open)' : '候选池刷新'}：A ${groups.firstBoard.length} 只 / B ${groups.secondBoard.length} 只`,
  });
};

// 洗盘形态文案（与前端候选列表 / 买点卡片同一口径）
const washoutText = (w) => {
  if (!w) return '--';
  const parts = [];
  if (w.washDays != null) parts.push(`洗盘 ${w.washDays} 个交易日`);
  if (w.rangePct != null) parts.push(`幅度 ${round2(w.rangePct)}%`);
  if (w.platformHigh != null) parts.push(`平台高点 ${round2(w.platformHigh)}`);
  return parts.length > 0 ? parts.join('，') : '--';
};

// 买点通过项（供前端统一买点诊断卡片 / 飞书使用，全部引用线上真实阈值）
const buildBuyChecks = ({ cand, mode, minute, price, change, auctionGap }) => {
  const thr = limitUpThresholdOf(cand.code);
  const wash = cand.washout || {};
  const platformHigh = wash.platformHigh != null ? Number(wash.platformHigh) : null;
  const minBreakoutPx = platformHigh != null ? round2(platformHigh * WASHOUT_OPT.breakoutMinRatio) : null;
  const common = [
    {
      id: 'washout',
      passed: true,
      title: cand.source === SOURCE_B ? '二板放量洗盘形态' : '首板洗盘形态',
      value: washoutText(cand.washout),
      reason: cand.source === SOURCE_B
        ? '首板前一交易日放量拉升后震荡缩量洗盘，首板收盘突破震荡平台、封板无漏量'
        : `首板（或首板+二板）放量峰值后 ${WASHOUT_OPT.minWashDays}~${WASHOUT_OPT.maxWashDays} 日缩量洗盘、未破位`,
    },
    {
      id: 'win3',
      passed: true,
      title: '买点日前 20 日最大三日窗口涨幅',
      value: wash.maxWin3Pct != null ? `${round2(wash.maxWin3Pct)}% ≤ ${MAX_WIN3_GAIN_PCT}%` : `--（≤ ${MAX_WIN3_GAIN_PCT}%）`,
      reason: `任意连续 3 个交易日窗口涨幅都 ≤ ${MAX_WIN3_GAIN_PCT}%，不追短期已大涨的票`,
    },
    {
      id: 'total_mv',
      passed: true,
      title: '总市值',
      value: cand.totalMvYi != null ? `${round2(cand.totalMvYi)} 亿 ≤ ${MAX_TOTAL_MV_YI} 亿` : '缺失（不拦截）',
      reason: `总市值须 ≤ ${MAX_TOTAL_MV_YI} 亿元`,
    },
  ];
  if (mode === 'auction') {
    return [
      {
        id: 'auction_gap',
        passed: true,
        title: `竞价涨幅 ≥ ${BUY_OPEN_GAP_AUCTION_PCT}%（9:30 直接买入）`,
        value: `${gainText(auctionGap)}（≥ ${BUY_OPEN_GAP_AUCTION_PCT}%）`,
        reason: `${fmtClock(AUCTION_END_MINUTE)} 竞价结束后即可判定：竞价高开 ${gainText(auctionGap)} ≥ ${BUY_OPEN_GAP_AUCTION_PCT}%，`
          + `按竞价开盘价直接买入，计划买入时间 ${fmtMinute(BUY_START_MINUTE)}`,
      },
      {
        id: 'not_limit_open',
        passed: true,
        title: `开盘未涨停（竞价涨幅 < ${BUY_SEAL_PCT}%，可买入）`,
        value: `竞价涨幅 ${gainText(auctionGap)} < ${BUY_SEAL_PCT}%（涨停阈值 ${round2(thr)}%）`,
        reason: '9:30 开盘即涨停（一字板）或竞价涨幅 ≥ 9.5%（视为已涨停）买不进，本次竞价涨幅未达 9.5%，可按竞价价买入',
      },
      ...common,
    ];
  }
  const checks = [
    {
      id: 'burst_pct',
      passed: true,
      title: `盘中涨幅 ≥ ${BUY_TRIGGER_PCT}%`,
      value: `${gainText(change)}（触发 ${fmtMinute(minute)}）`,
      reason: cand.source === SOURCE_B
        ? `竞价高开 ${gainText(auctionGap)}，${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(B_CUTOFF)} 分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 时买入`
        : `竞价 ${gainText(auctionGap)} 未达 ${BUY_OPEN_GAP_AUCTION_PCT}%，`
          + `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(BUY_CUTOFF_MINUTE)} 分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 时买入`,
    },
    {
      id: 'buy_not_sealed',
      passed: true,
      title: `买入时涨幅 < ${BUY_SEAL_PCT}%（≥ ${BUY_SEAL_PCT}% 视为涨停不买）`,
      value: `买入时涨幅 ${gainText(change)}（< ${BUY_SEAL_PCT}%）`,
      reason: `触发那一刻涨幅 ≥ ${BUY_SEAL_PCT}% 视为已涨停封板、不能买入；该分钟跳过，炸板回落到 +${BUY_TRIGGER_PCT}%~${BUY_SEAL_PCT}% 区间仍可买`,
    },
  ];
  if (cand.source === SOURCE_A) {
    checks.push({
      id: 'breakout',
      passed: true,
      title: `起爆价 ≥ 平台高点 × ${WASHOUT_OPT.breakoutMinRatio}`,
      value: platformHigh != null ? `起爆价 ${round2(price)} ≥ 下限 ${minBreakoutPx}` : `起爆价 ${round2(price)}（平台高点缺失，不拦截）`,
      reason: `起爆价须 ≥ 平台高点 × ${WASHOUT_OPT.breakoutMinRatio}，避免弱势反抽`,
    });
    checks.push({
      id: 'pullback',
      passed: true,
      title: `分时回落 ≤ ${MAX_INTRADAY_PULLBACKS} 次`,
      value: `触发前最多 ${MAX_INTRADAY_PULLBACKS} 次分钟级回落`,
      reason: `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(BUY_CUTOFF_MINUTE)} 之间允许最多 ${MAX_INTRADAY_PULLBACKS} 次分钟级回落，超过则本次不买`,
    });
  } else {
    checks.push({
      id: 'auction_gap_up',
      passed: true,
      title: '竞价必须高开',
      value: `竞价 ${gainText(auctionGap)} > 0`,
      reason: '二板起爆要求 9:30 竞价必须高开，低开不参与；竞价一字板买不进',
    });
    checks.push({
      id: 'board_day_tline',
      passed: true,
      title: '首板日分时（断板 ≤ 1 次、封板无漏量）',
      value: cand.boardCheck && cand.boardCheck.skipped
        ? '首板日分时缺失，不拦截'
        : (cand.boardCheck
          ? `断板 ${cand.boardCheck.breaks} 次，最大漏量 ${cand.boardCheck.maxLeakRatioPct == null ? '--' : `${cand.boardCheck.maxLeakRatioPct}%`}`
          : '合格'),
      reason: '首板日断板次数 ≤ 1，封住涨停满 20 分钟到收盘不得漏量',
    });
  }
  return [...checks, ...common];
};

const positionHint = '半仓（50%）——账户拆两份、每份半仓，最多同时持有 2 只不同股票，各自独立买卖';

// 买入价折算总市值复核（2026-11-05 对齐回测 washFusionExtremeOddsBacktest.js）：
//   回测买入时按「总股本 × 买入分钟价」复核总市值，> 100 亿剔除顺延且当日不再买入该股；
//   线上此前只按 T-1 收盘价预筛，盘中大涨触发买点时市值可能已超限 → 回测不买、线上却推送。
//   现在触发买点推送前按触发价复核，超限当日拉黑（不再推送买入提示）；数据缺失不拦截（与回测一致）
const mvRejectedCodes = new Set();
const mvOverLimitAtBuy = (cand, price) => cand.totalShares != null && Number(price) > 0
  && ((cand.totalShares * Number(price)) / 1e8) > MAX_TOTAL_MV_YI;

// 买点诊断卡片推送（WS）+ 飞书
//   remind=true：A 首板起爆 09:25-09:30 竞价买点提前提醒（每 30s 一次，不重复发飞书）
const emitBuySignal = async ({ dateStr, cand, mode, minute, price, change, auctionGap, remind = false, mock = false }) => {
  // 买入价折算总市值复核（与回测 mvRejected 同口径）：超 100 亿不推送买入提示，当日拉黑不再评估
  if (!mock && mvRejectedCodes.has(cand.code)) return;
  if (!mock && mvOverLimitAtBuy(cand, price)) {
    mvRejectedCodes.add(cand.code);
    persistSignals(dateStr);
    console.log(`[极致赔率] ${dateStr} ${cand.name}（${cand.code}）买点触发价 ${round2(price)} 折算总市值超 ${MAX_TOTAL_MV_YI} 亿，不推送买入（当日不再评估，与回测顺延口径一致）`);
    return;
  }
  const isA = cand.source === SOURCE_A;
  const signaledSet = isA ? (mode === 'auction' ? aAuctionSignaled : aBurstSignaled) : bSignaled;
  const already = signaledSet.has(cand.code);
  if (already && !remind) return;
  if (!already) {
    signaledSet.add(cand.code);
    persistSignals(dateStr);
  }

  const stock = {
    stockName: cand.name,
    name: cand.name,
    code: cand.code,
    board: cand.board,
    source: cand.source,
    sourceLabel: cand.sourceLabel,
    mode,
    modeText: mode === 'auction'
      ? `${fmtMinute(BUY_START_MINUTE)} 竞价高开 ${gainText(auctionGap)}（≥ ${BUY_OPEN_GAP_AUCTION_PCT}%）按竞价开盘价直接买入`
      : `盘中 ${fmtMinute(minute)} 分时涨幅 ${gainText(change)} 首次达到 +${BUY_TRIGGER_PCT}%`,
    minute: fmtMinute(minute),
    price: round2(price),
    change: round2(change),
    auctionGap: auctionGap != null ? round2(auctionGap) : null,
    totalMvYi: cand.totalMvYi,
    washout: cand.washout,
    boardCheck: cand.boardCheck || null,
    positionHint,
    timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };

  wsServer.broadcast({
    type: 'wash_fusion_buy',
    ts: Date.now(),
    open: true,
    data: {
      date: dateStr,
      source: cand.source,
      sourceLabel: cand.sourceLabel,
      stocks: [stock],
      checks: buildBuyChecks({ cand, mode, minute, price, change, auctionGap }),
      positionHint,
      remind,
      strategy: MODE_WASH_FUSION,
      rules: buildRules(),
      mock: !!mock,
    },
  });
  console.log(`[极致赔率·${cand.sourceLabel}] ${dateStr} ${cand.name}（${cand.code}）${stock.modeText}，价 ${stock.price}${remind ? '（竞价提前提醒）' : ''}`);
  logWashFusion({
    date: dateStr,
    firstBoardCount: cand.source === SOURCE_A ? 1 : 0,
    secondBoardCount: cand.source === SOURCE_B ? 1 : 0,
    rows: [stock],
    note: `买点命中：${cand.sourceLabel} ${stock.modeText}`,
  });

  if (already) return;
  try {
    await feishuNotify.sendFeishuCard(feishuNotify.buildWashFusionBuyCard({
      buyStocks: [stock],
      triggerTime: stock.timestamp,
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      positionHint,
      sourceLabel: cand.sourceLabel,
      mock,
    }));
  } catch (e) {
    console.error('情绪游资-极致赔率买点飞书发送失败:', e.message);
  }
};

// A 首板起爆盘中 +8% 扫描（逐分钟回溯，最多 1 次回落；起爆价 ≥ 平台高点 0.80；9:30 开盘即涨停买不进）
const scanFirstBoardBurstHit = (t, cand, nowMinute) => {
  if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) return null;
  const preclose = t.preclose;
  const thr = limitUpThresholdOf(cand.code);
  const pts = t.points;
  const inBuyWindow = (p) => p.minute >= BUY_START_MINUTE && p.minute <= BUY_CUTOFF_MINUTE;
  const p0 = pts.find((p) => p.lastPx > 0);
  // 竞价买点口径与回测一致：p0 = 分时首个有效分钟点（开盘价），不限其 minute 是否 ≤ 9:30
  if (p0) {
    const openChg = ((p0.lastPx - preclose) / preclose) * 100;
    // 开盘即涨停（一字板）或竞价涨幅 ≥ 9.5% 视为已涨停，买不进
    if (openChg >= thr || openChg >= BUY_SEAL_PCT) return { limitOpen: true, openChg };
    if (openChg >= BUY_OPEN_GAP_AUCTION_PCT) {
      return { auction: true, minute: p0.minute, px: p0.lastPx, chg: round2(openChg), openChg };
    }
  }

  let pullbackCount = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (!inBuyWindow(p)) continue;
    if (p.minute > nowMinute) break; // 不看未来分钟
    if (!(p.lastPx > 0)) continue;
    if (i > 0 && inBuyWindow(pts[i - 1]) && pts[i - 1].lastPx > 0 && p.lastPx < pts[i - 1].lastPx) {
      pullbackCount += 1;
      if (pullbackCount > MAX_INTRADAY_PULLBACKS) break;
    }
    const chg = ((p.lastPx - preclose) / preclose) * 100;
    if (chg < BUY_TRIGGER_PCT) continue;
    // 触发时涨幅 ≥ 9.5% 视为已涨停封板，该分钟不能买入；后续炸板回落到 8%~9.5% 区间仍可买
    if (chg >= BUY_SEAL_PCT) continue;
    const minBreakoutPx = (cand.washout.platformHigh || 0) * WASHOUT_OPT.breakoutMinRatio;
    if (minBreakoutPx > 0 && p.lastPx < minBreakoutPx) continue;
    return { minute: p.minute, px: p.lastPx, chg: round2(chg), openChg: null };
  }
  return null;
};

// B 二板起爆盘中 +8% 扫描（9:30-14:30；竞价必须高开；开盘即涨停买不进）
const scanSecondBoardBurstHit = (t, cand, nowMinute) => {
  if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) return null;
  const preclose = t.preclose;
  const thr = limitUpThresholdOf(cand.code);
  const pts = t.points;
  const p0 = pts.find((p) => p.lastPx > 0);
  if (!p0) return null;
  const openChg = ((p0.lastPx - preclose) / preclose) * 100;
  // 开盘即涨停（一字板）或竞价涨幅 ≥ 9.5% 视为已涨停，买不进
  if (openChg >= thr || openChg >= BUY_SEAL_PCT) return { limitOpen: true, openChg };
  if (openChg <= 0) return { gapDown: true, openChg };
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (p.minute < BUY_START_MINUTE || p.minute > B_CUTOFF) continue;
    if (p.minute > nowMinute) break;
    if (!(p.lastPx > 0)) continue;
    const chg = ((p.lastPx - preclose) / preclose) * 100;
    if (chg < BUY_TRIGGER_PCT) continue;
    // 触发时涨幅 ≥ 9.5% 视为已涨停封板，该分钟不能买入；后续炸板回落到 8%~9.5% 区间仍可买
    if (chg >= BUY_SEAL_PCT) continue;
    return { minute: p.minute, px: p.lastPx, chg: round2(chg), openChg };
  }
  return null;
};

// ============================================================
// 主循环（每 3s；仅交易日 09:10-15:00，且仅在情绪游资-极致赔率模式下运行）
// ============================================================
const tick = async () => {
  if (running) return;
  running = true;
  try {
    // 单选极致赔率或多选模式勾选了极致赔率时均运行（2026-11-04 多选模式）
    if (!strategyModeState.isModeActive(MODE_WASH_FUSION)) return;
    const now = new Date();
    if (!isTradingDay(now)) return;
    const minute = now.getHours() * 60 + now.getMinutes();
    if (minute < PREPARE_MINUTE || minute > POLL_END_MINUTE) return;

    const dateStr = dayjs().format('YYYYMMDD');
    ensureDayState(dateStr);
    const { pools, computedAt } = await getPools({ dateStr });
    const allCands = [...(pools.firstBoard || []), ...(pools.secondBoard || [])];

    // 09:10-09:15：整理候选池，广播一次静态列表
    if (minute < POLL_START_MINUTE) {
      if (quoteRowsTs === 0) {
        quoteRows = buildRows(pools, {}, minute);
        quoteRowsTs = Date.now();
        broadcastCandidates(dateStr, quoteRows, computedAt, false);
      }
      return;
    }

    if (allCands.length === 0) {
      if (minute === POLL_START_MINUTE && quoteRowsTs === 0) {
        quoteRowsTs = Date.now();
        broadcastCandidates(dateStr, [], computedAt, false);
      }
      return;
    }

    const quotes = await fetchQuotes(allCands.map((c) => c.code));

    // 09:25 竞价结束后记录竞价值（竞价涨幅 = 当前价相对昨收）
    if (minute >= AUCTION_END_MINUTE) {
      for (const c of allCands) {
        if (auctionGaps.has(c.code)) continue;
        const q = quotes[c.code];
        if (!q || q.price == null || !(Number(q.price) > 0)) continue;
        const preclose = q.preclose != null && Number(q.preclose) > 0 ? Number(q.preclose) : c.lastClose;
        if (!(preclose > 0)) continue;
        auctionGaps.set(c.code, {
          gap: ((Number(q.price) - preclose) / preclose) * 100,
          price: Number(q.price),
          preclose,
          at: now.getTime(),
        });
      }
    }

    // A 首板起爆：09:25-09:30 竞价 ≥ 5% 且未涨停 → 每 30s 提前提醒一次（仅提醒，不作为正式买点判定）。
    // 正式竞价买点（2026-11-17 与回测口径对齐）：回测用 9:30 分时首个分钟点开盘价判定（≥5%、未涨停、<9.5%）
    // 并按开盘价买入——此前线上按 9:25 竞价判定，存在「竞价 <5% 但 9:30 开盘 ≥5% → 回测买线上不推」的漏报，
    // 该场景现由下方 9:30-9:40 扫描块内的 auction 分支覆盖
    const firstBoard = pools.firstBoard || [];
    if (minute >= AUCTION_END_MINUTE && minute < BUY_START_MINUTE) {
      const nowMs = now.getTime();
      for (const c of firstBoard) {
        const a = auctionGaps.get(c.code);
        if (!a || !(a.gap >= BUY_OPEN_GAP_AUCTION_PCT)) continue;
        if (a.gap >= limitUpThresholdOf(c.code)) continue; // 一字板买不进
        if (a.gap >= BUY_SEAL_PCT) continue; // 竞价涨幅 ≥ 9.5% 视为涨停，买不进（2026-11-17 用户要求）
        const last = auctionRemindAt.get(c.code) || 0;
        if (nowMs - last < AUCTION_REMIND_MS) continue;
        auctionRemindAt.set(c.code, nowMs);
        await emitBuySignal({
          dateStr, cand: c, mode: 'auction', minute: BUY_START_MINUTE,
          price: a.price, change: a.gap, auctionGap: a.gap, remind: true,
        });
      }
    }

    // 09:30 补记竞价值：服务在 09:25 之后启动（auctionGaps 为空）时用分时首个分钟点反推竞价开盘价
    if (minute >= BUY_START_MINUTE && minute <= BUY_START_MINUTE + 1) {
      const missing = allCands.filter((c) => !auctionGaps.has(c.code));
      await batchParallel(missing, async (c) => {
        let t = null;
        try { t = await loadTlinePointsStrict(c.code, Number(dateStr)); } catch (e) { t = null; }
        if (!t || !(t.preclose > 0)) return null;
        const p0 = (t.points || []).find((p) => p.lastPx > 0 && p.minute <= BUY_START_MINUTE);
        if (!p0) return null;
        auctionGaps.set(c.code, {
          gap: ((p0.lastPx - t.preclose) / t.preclose) * 100,
          price: p0.lastPx,
          preclose: t.preclose,
          at: now.getTime(),
        });
        return null;
      }, 4);
    }

    // A 首板起爆 09:30-09:40：竞价买点 + 盘中买点（与回测预取同一套口径）
    //   竞价买点：9:30 分时首个分钟点开盘价 ≥ 5%、未涨停、< 9.5% → 按开盘价买入（回测 hitMemo auction 同口径）；
    //   盘中买点：分时首次 +8% 且 < 9.5% → 按该分钟价买入。
    //   9:30-9:32 前两分钟评估全部未触发候选（覆盖「竞价 <5% 但开盘 ≥5%」场景），之后用实时涨幅收敛评估范围
    if (minute >= BUY_START_MINUTE && minute <= BUY_CUTOFF_MINUTE) {
      const near = firstBoard.filter((c) => {
        if (aAuctionSignaled.has(c.code) || aBurstSignaled.has(c.code)) return false;
        const a = auctionGaps.get(c.code);
        if (a && a.gap >= BUY_OPEN_GAP_AUCTION_PCT) return true;
        if (minute <= BUY_START_MINUTE + 2) return true;
        const q = quotes[c.code];
        if (!q || q.change == null) return false;
        return Number(q.change) >= BUY_TRIGGER_PCT - 2;
      });
      await batchParallel(near, async (c) => {
        let t = null;
        try { t = await loadTlinePointsStrict(c.code, Number(dateStr)); } catch (e) { t = null; }
        if (!t) return null;
        const hit = scanFirstBoardBurstHit(t, c, minute);
        if (!hit || hit.limitOpen) return null;
        if (hit.auction) {
          // 正式竞价买点：按 9:30 开盘价（分时首点）判定与成交，与回测一致（9:25 竞价仅做提前提醒）
          await emitBuySignal({
            dateStr, cand: c, mode: 'auction', minute: hit.minute,
            price: hit.px, change: hit.chg, auctionGap: auctionGaps.get(c.code)?.gap ?? null,
          });
          return null;
        }
        await emitBuySignal({
          dateStr, cand: c, mode: 'burst', minute: hit.minute,
          price: hit.px, change: hit.chg, auctionGap: auctionGaps.get(c.code)?.gap ?? null,
        });
        return null;
      }, 4);
    }

    // B 二板起爆 09:30-14:30：竞价高开的候选，分时涨幅首次达到 +8% 即买入
    if (minute >= BUY_START_MINUTE && minute <= B_CUTOFF) {
      const secondBoard = pools.secondBoard || [];
      const near = secondBoard.filter((c) => {
        if (bSignaled.has(c.code)) return false;
        const a = auctionGaps.get(c.code);
        if (a && a.gap <= 0) return false;             // 竞价未高开，不参与
        if (a && a.gap >= limitUpThresholdOf(c.code)) return false; // 一字板买不进
        if (a && a.gap >= BUY_SEAL_PCT) return false;  // 竞价涨幅 ≥ 9.5% 视为涨停，买不进（2026-11-17 用户要求）
        const q = quotes[c.code];
        if (!q || q.change == null) return false;
        return Number(q.change) >= BUY_TRIGGER_PCT - 2;
      });
      await batchParallel(near, async (c) => {
        let t = null;
        try { t = await loadTlinePointsStrict(c.code, Number(dateStr)); } catch (e) { t = null; }
        if (!t) return null;
        const hit = scanSecondBoardBurstHit(t, c, minute);
        if (!hit || hit.limitOpen || hit.gapDown) return null;
        await emitBuySignal({
          dateStr, cand: c, mode: 'burst', minute: hit.minute,
          price: hit.px, change: hit.chg, auctionGap: auctionGaps.get(c.code)?.gap ?? null,
        });
        return null;
      }, 4);
    }

    // 每轮广播最新列表（A/B 分两组，open:false 仅刷新前端列表）
    quoteRows = buildRows(pools, quotes, minute);
    quoteRowsTs = Date.now();
    broadcastCandidates(dateStr, quoteRows, dayjs(quoteRowsTs).format('YYYY-MM-DD HH:mm:ss'), false);

    // 买点预热（2026-11-15）：打板模式（忽略首板竞价）候选盘中涨幅 ≥ 5% 且尚未触发正式买点的，
    // 提前提示关注候选股列表；同一标的当日只提醒一次
    const preheatSignaled = new Set([...aAuctionSignaled, ...aBurstSignaled, ...bSignaled]);
    maybeWashFusionPreheat({ dateStr, pools, quotes, minute, signaledCodes: preheatSignaled });
  } catch (e) {
    console.error('情绪游资-极致赔率线上轮询任务异常:', e.message);
  } finally {
    running = false;
  }
};

// ============================================================
// 展示基准日 = 候选所属的「买点日」（洗盘须在买点日前一交易日结束）：
//   交易日 09:10 前 → 当日（盘前用上一交易日收盘数据算出的就是当日候选）
//   交易日 09:10-15:00 → 当日（盘中按实时行情刷新）
//   交易日 15:00 后 → 下一交易日（用当日已收盘数据重新计算，供次日买点使用）
//   非交易日 → 下一个交易日（周末/节假日展示的是下一交易日的候选，而不是已过去的上一交易日）
// ============================================================
const resolveDisplayBasis = async (now = new Date()) => {
  const todayStr = dayjs(now).format('YYYYMMDD');
  const minute = now.getHours() * 60 + now.getMinutes();
  if (isTradingDay(now)) {
    if (minute < PREPARE_MINUTE) return { dateStr: todayStr, isPreviousDay: true };
    if (minute >= POLL_END_MINUTE) {
      return { dateStr: dayjs(getNextTradingDay(now)).format('YYYYMMDD'), isPreviousDay: true };
    }
    return { dateStr: todayStr, isPreviousDay: false };
  }
  return { dateStr: dayjs(getNextTradingDay(now)).format('YYYYMMDD'), isPreviousDay: true };
};

const buildStaticRows = (pools) => {
  const list = [...(pools.firstBoard || []), ...(pools.secondBoard || [])];
  return list.map((c) => {
    // 非交易时段没有实时快照：用日K最后一根（最近一个交易日）现算当日涨幅 / 竞价高开
    const { change, auctionGap } = latestBarStats(getStockBarsCached(c.code));
    return {
      code: c.code,
      name: c.name,
      board: c.board,
      source: c.source,
      sourceLabel: c.sourceLabel,
      totalMvYi: c.totalMvYi,
      washout: c.washout,
      boardCheck: c.boardCheck || null,
      preclose: c.lastClose,
      price: c.lastClose,
      change,
      auctionGap,
      status: 'closed',
      statusText: '最近交易日收盘',
    };
  });
};

// 前端展示数据（首次加载 / 手动刷新）：按基准日返回 A/B 两组候选
//   refresh=true 时：盘中重新抓实时行情并按当前分钟重算状态；收盘后/盘前重新计算下一买点日候选
const getDisplayData = async ({ refresh = false, now = new Date() } = {}) => {
  const basis = await resolveDisplayBasis(now);
  const { pools, computedAt } = await getPools({ dateStr: basis.dateStr, refresh });
  const minute = now.getHours() * 60 + now.getMinutes();
  let rows;
  let updatedAt;
  if (basis.isPreviousDay) {
    rows = buildStaticRows(pools);
    updatedAt = computedAt;
  } else if (refresh) {
    // 盘中手动刷新：必须重新抓取实时行情，否则只会返回上一轮 3s 推送的旧快照
    const list = [...(pools.firstBoard || []), ...(pools.secondBoard || [])];
    const quotes = await fetchQuotes(list.map((c) => c.code));
    rows = buildRows(pools, quotes, minute);
    quoteRows = rows;
    quoteRowsTs = Date.now();
    updatedAt = dayjs(quoteRowsTs).format('YYYY-MM-DD HH:mm:ss');
  } else {
    rows = quoteRows.length > 0 ? quoteRows : buildStaticRows(pools);
    updatedAt = quoteRowsTs ? dayjs(quoteRowsTs).format('YYYY-MM-DD HH:mm:ss') : computedAt;
  }
  const groups = splitGroups(rows);
  return {
    date: basis.dateStr,
    basisDate: basis.dateStr,
    isPreviousDay: basis.isPreviousDay,
    computedAt,
    updatedAt,
    count: rows.length,
    firstBoardCount: groups.firstBoard.length,
    secondBoardCount: groups.secondBoard.length,
    firstBoard: groups.firstBoard,
    secondBoard: groups.secondBoard,
    candidates: rows,
    rules: buildRules(),
    // 后端当前是否在该模式下运行实时推送：false 时前端提示「实时推送未开启」，
    // 避免列表看着是实时的、实际既不会刷新也不会推送买点卡片（2026-11-16 用户反馈）
    pushing: strategyModeState.isModeActive(MODE_WASH_FUSION),
  };
};

const getSnapshot = () => getDisplayData();

const start = () => {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
  console.log('情绪游资-极致赔率线上服务已启动（交易日 09:10-15:00 每 3s 轮询，仅在该策略模式下运行）');
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = {
  MODE_WASH_FUSION,
  SOURCE_A,
  SOURCE_B,
  SOURCE_LABELS,
  start,
  stop,
  tick,
  getPools,
  computePools,
  getDisplayData,
  getSnapshot,
  buildBuyChecks,
  emitBuySignal,
  buildRules,
  // 常量导出便于前端文案/调试面板/回测对照
  BUY_TRIGGER_PCT,
  BUY_SEAL_PCT,
  BUY_OPEN_GAP_AUCTION_PCT,
  BUY_START_MINUTE,
  BUY_CUTOFF_MINUTE,
  B_BUY_CUTOFF_MINUTE,
  MAX_INTRADAY_PULLBACKS,
  MAX_TOTAL_MV_YI,
  MAX_WIN3_GAIN_PCT,
  AUCTION_END_MINUTE,
  AUCTION_REMIND_MS,
};
