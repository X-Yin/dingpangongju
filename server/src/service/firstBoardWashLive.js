// ============================================================
// 首板洗盘-起爆拉升 · 线上常驻服务（2026-11-01 用户新增）
//   与回测引擎 engine/firstBoardWashBacktest.js 共用同一份前置洗盘判定（washout）与买点常量，
//   保证线上展示/买点诊断与回测口径一致。本服务常驻运行，与「科技进攻 / 情绪游资-极致胜率」模式无关：
//
//   时间轴（仅交易日）：
//     09:00             → 计算当日候选股（首板洗盘-起爆拉升形态），WS 推送 open:true 弹窗展示
//     09:15 ~ 09:41     → 每 3s 轮询全部候选股（实时快照）
//     09:25 竞价结束后  → 买点诊断：竞价高开 ≥ 5% 的候选 → 9:30 按竞价开盘价直接买入
//                         09:25-09:30 每 30s 提前提醒一次（WS 买点卡片，飞书仅首次发送），便于提前准备
//     09:30 ~ 09:40     → 竞价 < 5% 的候选，分时涨幅首次达到 +8% 即买入（最多 1 次回落，触发价 ≥ 平台高点 0.80）
//                         9:30 开盘即涨停（竞价一字板）买不进；9:40 之后不再买入
//   其余时间不轮询；配置与回测同源：剔除创业板/科创板、代码黑名单、题材黑名单、15 日内 ≥3 板、
//   买点日前 20 日最大三日窗口涨幅 ≤ 20%、流通市值 ≤ 100 亿。
// ============================================================
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils/tradingDay');
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
} = require('./buySellBacktest/engine/firstBoardWashBacktest');
const { loadTlinePoints, round2, limitUpThresholdOf } = require('./buySellBacktest/engine/extremeWinScores');
const { getBacktestValuationMap, getValuationMap, ensureBacktestValuation } = require('./watchlistValuation');
const { getRealtimeQuotes } = require('./stock');
const wsServer = require('../wsServer');
const feishuNotify = require('./feishuNotify');

// ===== 时间窗（分钟数，0 点起算）=====
const PREOPEN_PUSH_MINUTE = 9 * 60;      // 09:00 推送当日候选股弹窗
const POLL_START_MINUTE = 9 * 60 + 15;   // 09:15 起每 3s 轮询
const AUCTION_END_MINUTE = 9 * 60 + 25;  // 09:25 竞价结束，开始买点诊断
const POLL_END_MINUTE = 9 * 60 + 41;     // 09:41 停止轮询
const TICK_MS = 3 * 1000;
const AUCTION_REMIND_MS = 30 * 1000;     // 09:25-09:30 竞价买点提前提醒间隔（30s 一次）

const statePath = path.resolve(__dirname, '../data/first_board_wash_online_state.json');

// ===== 运行时状态（按交易日隔离）=====
let timer = null;
let running = false;
let candidateCache = { date: null, candidates: [], computedAt: null };
let candidateInflight = null;
let quoteRows = [];                    // 最近一次带实时快照的候选行（供前端列表补发）
let quoteRowsTs = 0;
const auctionGaps = new Map();         // code -> { gap, price, preclose, at }（09:25 竞价值）
const auctionSignaled = new Set();     // 当日已推送「竞价 ≥ 5% 直接买入」
const auctionRemindAt = new Map();     // code -> 最近一次竞价买点提前提醒的时间戳（30s 节流）
const burstSignaled = new Set();       // 当日已推送「盘中 +8% 买入」
let preopenPushedDate = null;          // 当日候选弹窗已推送过的日期
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
    console.error('写入首板起爆线上状态失败:', e.message);
  }
};

const ensureDayState = (dateStr) => {
  if (stateDate === dateStr) return;
  stateDate = dateStr;
  auctionGaps.clear();
  auctionSignaled.clear();
  auctionRemindAt.clear();
  burstSignaled.clear();
  preopenPushedDate = null;
  quoteRows = [];
  quoteRowsTs = 0;
  const s = readState();
  if (s && s.date === dateStr) {
    for (const code of Array.isArray(s.auctionSignaled) ? s.auctionSignaled : []) auctionSignaled.add(code);
    for (const code of Array.isArray(s.burstSignaled) ? s.burstSignaled : []) burstSignaled.add(code);
    if (s.preopenPushed === true) preopenPushedDate = dateStr;
  }
};

const isChiNextOrStar = (code) => /^(30|688)/.test(String(code || '').replace(/^(sh|sz|bj)/i, ''));

// 线上洗盘形态判定：日K若尚未包含当日（盘前/开盘初），追加一根仅含日期的占位 bar，
// 使 isPotentialBullWashout 的 eIdx（买点日前一交易日）落在最后一根真实日K上（与回测口径一致）
const barsForEval = (bars, todayNum) => {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const last = bars[bars.length - 1];
  if (Number(last.d) >= todayNum) return bars;
  return [...bars, { d: todayNum }];
};

// 流通市值（亿元，当下快照口径）：优先通用估值缓存（覆盖非自选股），其次自选股估值快照；缺失返回 null（不拦截）
const floatMvYiOf = (code) => {
  const bt = getBacktestValuationMap().get(code);
  const watch = getValuationMap().get(code);
  const cmc = bt && Number.isFinite(Number(bt.circulatingMarketValue)) && Number(bt.circulatingMarketValue) > 0
    ? Number(bt.circulatingMarketValue)
    : (watch && Number.isFinite(Number(watch.circulatingMarketValue)) && Number(watch.circulatingMarketValue) > 0
      ? Number(watch.circulatingMarketValue) : null);
  return cmc != null ? round2(cmc / 1e8) : null;
};

// ============================================================
// 候选股计算（首板洗盘-起爆拉升形态，与回测选股阶段同口径）
// ============================================================
const computeCandidates = async (dateStr) => {
  const todayNum = Number(dateStr);
  let occStocks = [];
  try {
    const r = await getRecentMultiLianbanOccurrences(dateStr, WASHOUT_LOOKBACK_DAYS, 1);
    occStocks = r.stocks || [];
  } catch (e) { occStocks = []; }

  // 按 code 汇总连板记录：是否出现 ≥3 板 / 板块名；与「情绪游资-极致胜率」同口径剔除创业板/科创板/黑名单/题材
  const recordMap = new Map();
  for (const s of occStocks) {
    if (!s || !s.code) continue;
    if (isChiNextOrStar(s.code) || EXCLUDED_CODES.has(s.code) || isThemeExcluded(s.code, s.board)) continue;
    const item = recordMap.get(s.code) || {
      code: s.code, name: s.name || s.code, board: s.board || '', maxCount: 0, hasHighBoard: false,
    };
    const cnt = Number(s.lianbanCount);
    if (Number.isFinite(cnt)) {
      if (cnt >= 3) item.hasHighBoard = true;
      if (cnt > item.maxCount) item.maxCount = cnt;
    }
    if (s.board) item.board = s.board;
    recordMap.set(s.code, item);
  }
  const bannedCodes = new Set(Array.from(recordMap.values()).filter((x) => x.hasHighBoard).map((x) => x.code));
  const pool = Array.from(recordMap.values()).filter((x) => !bannedCodes.has(x.code));

  try { await ensureBarsForCodes(new Set(pool.map((x) => x.code))); } catch (e) { /* 日K拉取失败按缺失处理 */ }

  const candidates = [];
  for (const item of pool) {
    const bars = getStockBarsCached(item.code);
    const evalBars = barsForEval(bars, todayNum);
    if (!evalBars) continue;
    const washout = isPotentialBullWashout(evalBars, todayNum);
    if (!washout) continue;
    // 买点日前 20 个交易日内最大三日滑动窗口涨幅 ≤ 20%
    const win3 = maxThreeDayWindowGain(evalBars, todayNum);
    if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
    washout.maxWin3Pct = win3 != null ? round2(win3) : null;
    const realBars = bars || [];
    const lastClose = realBars.length > 0 ? Number(realBars[realBars.length - 1].c) : null;
    candidates.push({
      code: item.code,
      name: item.name,
      board: item.board,
      lianbanCount: item.maxCount,
      lastClose: lastClose != null && lastClose > 0 ? round2(lastClose) : null,
      washout,
    });
  }

  // 流通市值 ≤ 100 亿元（数据缺失不拦截）
  try { await ensureBacktestValuation(candidates.map((c) => c.code)); } catch (e) { /* 拉取失败时按缺失处理 */ }
  return candidates
    .map((c) => ({ ...c, floatMvYi: floatMvYiOf(c.code) }))
    .filter((c) => c.floatMvYi == null || c.floatMvYi <= MAX_FLOAT_MV_YI)
    .sort((a, b) => (b.washout.rangePct || 0) - (a.washout.rangePct || 0));
};

// 候选股（带当日缓存；refresh=true 强制重算）。并发调用共用同一次计算
const getCandidates = async ({ dateStr = dayjs().format('YYYYMMDD'), refresh = false } = {}) => {
  if (!refresh && candidateCache.date === dateStr && candidateCache.computedAt) {
    return { date: dateStr, computedAt: candidateCache.computedAt, candidates: candidateCache.candidates };
  }
  if (candidateInflight && candidateInflight.date === dateStr) {
    await candidateInflight.promise;
    return { date: dateStr, computedAt: candidateCache.computedAt, candidates: candidateCache.candidates };
  }
  const promise = (async () => {
    try {
      const list = await computeCandidates(dateStr);
      candidateCache = { date: dateStr, candidates: list, computedAt: dayjs().format('YYYY-MM-DD HH:mm:ss') };
    } catch (e) {
      console.error('首板起爆候选股计算失败:', e.message);
      if (candidateCache.date !== dateStr) candidateCache = { date: dateStr, candidates: [], computedAt: null };
    }
  })();
  candidateInflight = { date: dateStr, promise };
  try { await promise; } finally { candidateInflight = null; }
  return { date: dateStr, computedAt: candidateCache.computedAt, candidates: candidateCache.candidates };
};

// ============================================================
// 实时快照 / 买点诊断
// ============================================================
const fetchQuotes = async (codes) => {
  if (!codes || codes.length === 0) return {};
  try { return await getRealtimeQuotes(codes) || {}; } catch (e) { return {}; }
};

const buildRows = (candidates, quotes, nowMinute) => {
  const afterMarket = nowMinute >= BUY_START_MINUTE;
  return candidates.map((c) => {
    const q = quotes[c.code] || {};
    const price = q.price != null ? Number(q.price) : null;
    const preclose = q.preclose != null && Number(q.preclose) > 0 ? Number(q.preclose) : c.lastClose;
    const change = q.change != null ? Number(q.change)
      : (price != null && preclose > 0 ? ((price - preclose) / preclose) * 100 : null);
    const auction = auctionGaps.get(c.code) || null;
    const auctionGap = auction ? auction.gap : (afterMarket ? null : change);
    const limitThreshold = limitUpThresholdOf(c.code);
    let status = 'pending';
    let statusText = '待竞价';
    if (auctionGap != null && auctionGap >= limitThreshold) {
      status = 'limit_open';
      statusText = '开盘即涨停，买不进';
    } else if (auctionSignaled.has(c.code)) {
      status = 'auction_buy';
      statusText = `${'9:30'} 竞价直接买入`;
    } else if (burstSignaled.has(c.code)) {
      status = 'burst_buy';
      statusText = '盘中 +8% 已触发';
    } else if (auctionGap != null && auctionGap >= BUY_OPEN_GAP_AUCTION_PCT) {
      status = 'auction_buy';
      statusText = '竞价 ≥ 5%，9:30 买入';
    } else if (nowMinute > BUY_CUTOFF_MINUTE) {
      status = 'miss';
      statusText = '9:40 前未触发';
    } else if (nowMinute >= BUY_START_MINUTE) {
      status = 'watching';
      statusText = '等盘中 +8%';
    } else if (auctionGap != null) {
      status = 'watching';
      statusText = '竞价 < 5%，等 +8%';
    }
    return {
      code: c.code,
      name: c.name,
      board: c.board,
      lianbanCount: c.lianbanCount,
      floatMvYi: c.floatMvYi,
      washout: c.washout,
      preclose: preclose != null ? round2(preclose) : null,
      price: price != null ? round2(price) : null,
      change: change != null ? round2(change) : null,
      auctionGap: auctionGap != null ? round2(auctionGap) : null,
      status,
      statusText,
    };
  });
};

const broadcastCandidates = (dateStr, rows, updatedAt, open = false) => {
  wsServer.broadcast({
    type: 'first_board_wash_candidates',
    ts: Date.now(),
    open,
    data: {
      date: dateStr,
      basisDate: dateStr,
      isPreviousDay: false,
      updatedAt,
      count: rows.length,
      candidates: rows,
      rules: buildRules(),
    },
  });
};

const fmtMinute = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
// 0 点起算的分钟数（如 565）→ HH:mm
const fmtClock = (m) => `${String(Math.floor(Number(m) / 60)).padStart(2, '0')}:${String(Number(m) % 60).padStart(2, '0')}`;

const buildRules = () => ({
  buyTriggerPct: BUY_TRIGGER_PCT,
  auctionBuyPct: BUY_OPEN_GAP_AUCTION_PCT,
  buyWindow: `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(BUY_CUTOFF_MINUTE)}`,
  maxPullbacks: MAX_INTRADAY_PULLBACKS,
  maxFloatMvYi: MAX_FLOAT_MV_YI,
});

// ============================================================
// 展示基准日（2026-11-01 用户要求）
//   交易日 09:00 起 → 展示当日候选（含 09:15-09:41 实时快照）
//   非交易日 / 交易日 09:00 前 → 展示上一交易日收盘后的候选（没有则前端显示空态）
// ============================================================
const getPrevTradingDate = async (dateStr) => {
  try {
    const dates = ((await getPastTradingDates(dateStr, 1)) || []).map(String);
    const last = dates[dates.length - 1];
    if (last) return last;
  } catch (e) { /* 忽略，走兜底 */ }
  // 兜底：逐日回退到最近一个交易日
  let d = dayjs(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`).subtract(1, 'day');
  for (let i = 0; i < 10; i += 1) {
    if (isTradingDay(d.toDate())) break;
    d = d.subtract(1, 'day');
  }
  return d.format('YYYYMMDD');
};

const resolveDisplayBasis = async (now = new Date()) => {
  const todayStr = dayjs(now).format('YYYYMMDD');
  const minute = now.getHours() * 60 + now.getMinutes();
  if (isTradingDay(now) && minute >= PREOPEN_PUSH_MINUTE) {
    return { dateStr: todayStr, isPreviousDay: false };
  }
  return { dateStr: await getPrevTradingDate(todayStr), isPreviousDay: true };
};

// 静态候选行（无实时价/竞价）：上一交易日收盘 / 当日盘前待竞价
const buildStaticRows = (candidates, status = 'closed', statusText = '上一交易日收盘') => candidates.map((c) => ({
  code: c.code,
  name: c.name,
  board: c.board,
  lianbanCount: c.lianbanCount,
  floatMvYi: c.floatMvYi,
  washout: c.washout,
  preclose: c.lastClose,
  price: c.lastClose,
  change: null,
  auctionGap: null,
  status,
  statusText,
}));

// 前端展示数据（首次加载 / 手动刷新）：按基准日返回候选列表
const getDisplayData = async ({ refresh = false, now = new Date() } = {}) => {
  const basis = await resolveDisplayBasis(now);
  const { candidates, computedAt } = await getCandidates({ dateStr: basis.dateStr, refresh });
  const rules = buildRules();
  if (basis.isPreviousDay) {
    return {
      date: basis.dateStr,
      basisDate: basis.dateStr,
      isPreviousDay: true,
      updatedAt: null,
      computedAt,
      candidates: buildStaticRows(candidates),
      rules,
    };
  }
  // 交易日盘中：有实时快照优先用快照（最新价/竞价/状态），否则用当日静态候选
  return {
    date: basis.dateStr,
    basisDate: basis.dateStr,
    isPreviousDay: false,
    updatedAt: quoteRowsTs ? dayjs(quoteRowsTs).format('YYYY-MM-DD HH:mm:ss') : computedAt,
    computedAt,
    candidates: quoteRows.length > 0 ? quoteRows : buildStaticRows(candidates, 'pending', '待竞价'),
    rules,
  };
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
      title: '首板洗盘形态',
      value: washoutText(cand.washout),
      reason: `首板（或首板+二板）放量峰值后 ${WASHOUT_OPT.minWashDays}~${WASHOUT_OPT.maxWashDays} 日缩量洗盘、未破位`
        + `（洗盘幅度 ${round2(WASHOUT_OPT.minRangePct * 100)}%~${round2(WASHOUT_OPT.maxRangePct * 100)}%，洗盘期不得突破平台高点）`,
    },
    {
      id: 'win3',
      passed: true,
      title: `买点日前 ${WIN3_LOOKBACK_DAYS} 日最大三日窗口涨幅`,
      value: wash.maxWin3Pct != null ? `${round2(wash.maxWin3Pct)}% ≤ ${MAX_WIN3_GAIN_PCT}%` : `--（≤ ${MAX_WIN3_GAIN_PCT}%）`,
      reason: `任意连续 3 个交易日窗口涨幅都 ≤ ${MAX_WIN3_GAIN_PCT}%，不追短期已大涨的票`,
    },
    {
      id: 'float_mv',
      passed: true,
      title: '流通市值',
      value: cand.floatMvYi != null ? `${round2(cand.floatMvYi)} 亿 ≤ ${MAX_FLOAT_MV_YI} 亿` : `缺失（不拦截）`,
      reason: `流通市值须 ≤ ${MAX_FLOAT_MV_YI} 亿元`,
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
        title: '开盘未涨停（可买入）',
        value: `竞价涨幅 ${gainText(auctionGap)} < 涨停阈值 ${round2(thr)}%`,
        reason: '9:30 开盘即涨停（一字板）买不进，本次竞价涨幅未达涨停阈值，可按竞价价买入',
      },
      ...common,
    ];
  }
  return [
    {
      id: 'burst_pct',
      passed: true,
      title: `盘中涨幅 ≥ ${BUY_TRIGGER_PCT}%`,
      value: `${gainText(change)}（触发 ${fmtMinute(minute)}）`,
      reason: `竞价 ${gainText(auctionGap)} 未达 ${BUY_OPEN_GAP_AUCTION_PCT}%，`
        + `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(BUY_CUTOFF_MINUTE)} 分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 时买入`,
    },
    {
      id: 'breakout',
      passed: true,
      title: `起爆价 ≥ 平台高点 × ${WASHOUT_OPT.breakoutMinRatio}`,
      value: platformHigh != null ? `起爆价 ${round2(price)} ≥ 下限 ${minBreakoutPx}` : `起爆价 ${round2(price)}（平台高点缺失，不拦截）`,
      reason: `起爆价须 ≥ 平台高点 × ${WASHOUT_OPT.breakoutMinRatio}，避免弱势反抽`,
    },
    {
      id: 'pullback',
      passed: true,
      title: `分时回落 ≤ ${MAX_INTRADAY_PULLBACKS} 次`,
      value: `触发前最多 ${MAX_INTRADAY_PULLBACKS} 次分钟级回落`,
      reason: `${fmtMinute(BUY_START_MINUTE)}-${fmtMinute(BUY_CUTOFF_MINUTE)} 之间允许最多 ${MAX_INTRADAY_PULLBACKS} 次分钟级回落，超过则本次不买`,
    },
    ...common,
  ];
};

// 买点诊断卡片推送（WS）+ 飞书
//   remind=true：09:25-09:30 竞价买点提前提醒（每 30s 一次，不重复发飞书）
//   首次命中才写状态 + 发飞书；盘中 +8% 买点不重复推送
const emitBuySignal = async ({ dateStr, cand, mode, minute, price, change, auctionGap, remind = false }) => {
  const already = mode === 'auction' ? auctionSignaled.has(cand.code) : burstSignaled.has(cand.code);
  if (already && !remind) return;
  if (!already) {
    if (mode === 'auction') auctionSignaled.add(cand.code);
    else burstSignaled.add(cand.code);
    writeState({
      date: dateStr,
      auctionSignaled: Array.from(auctionSignaled),
      burstSignaled: Array.from(burstSignaled),
      preopenPushed: preopenPushedDate === dateStr,
    });
  }

  const stock = {
    stockName: cand.name,
    name: cand.name,
    code: cand.code,
    board: cand.board,
    mode,
    modeText: mode === 'auction'
      ? `${fmtMinute(BUY_START_MINUTE)} 竞价高开 ${gainText(auctionGap)}（≥ ${BUY_OPEN_GAP_AUCTION_PCT}%）按竞价开盘价直接买入`
      : `盘中 ${fmtMinute(minute)} 分时涨幅 ${gainText(change)} 首次达到 +${BUY_TRIGGER_PCT}%`,
    minute: fmtMinute(minute),
    price: round2(price),
    change: round2(change),
    auctionGap: auctionGap != null ? round2(auctionGap) : null,
    floatMvYi: cand.floatMvYi,
    washout: cand.washout,
    positionHint: '半仓（50%）——账户拆两份、每份半仓，最多同时持有 2 只不同股票，各自独立买卖',
    timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };

  wsServer.broadcast({
    type: 'first_board_wash_buy',
    ts: Date.now(),
    open: true,
    data: {
      date: dateStr,
      stocks: [stock],
      checks: buildBuyChecks({ cand, mode, minute, price, change, auctionGap }),
      positionHint: stock.positionHint,
      remind,
      strategy: 'first_board_wash',
      rules: buildRules(),
    },
  });
  console.log(`[首板起爆] ${dateStr} ${cand.name}（${cand.code}）${stock.modeText}，价 ${stock.price}${remind ? '（竞价提前提醒）' : ''}`);

  // 提前提醒不重复发飞书：首次命中时已发过一张，避免 09:25-09:30 每 30s 刷屏
  if (already) return;
  try {
    await feishuNotify.sendFeishuCard(feishuNotify.buildFirstBoardWashBuyCard({
      buyStocks: [stock],
      timestamp: stock.timestamp,
      positionHint: stock.positionHint,
    }));
  } catch (e) {
    console.error('首板起爆买点飞书发送失败:', e.message);
  }
};

const gainText = (v) => (v == null ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 盘中 +8% 扫描（逐分钟回溯，最多 1 次回落；起爆价 ≥ 平台高点 0.80；9:30 开盘即涨停买不进）
const scanBurstHit = (t, cand, nowMinute) => {
  if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) return null;
  const preclose = t.preclose;
  const thr = limitUpThresholdOf(cand.code);
  const pts = t.points;
  const inBuyWindow = (p) => p.minute >= BUY_START_MINUTE && p.minute <= BUY_CUTOFF_MINUTE;
  const p0 = pts.find((p) => p.lastPx > 0);
  let openChg = null;
  if (p0 && p0.minute <= BUY_START_MINUTE) {
    openChg = ((p0.lastPx - preclose) / preclose) * 100;
    if (openChg >= thr) return { limitOpen: true, openChg };
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
    const minBreakoutPx = (cand.washout.platformHigh || 0) * WASHOUT_OPT.breakoutMinRatio;
    if (minBreakoutPx > 0 && p.lastPx < minBreakoutPx) continue;
    return { minute: p.minute, px: p.lastPx, chg: round2(chg) };
  }
  return null;
};

// ============================================================
// 主循环（每 3s；仅交易日 09:00-09:41 有实际动作）
// ============================================================
const tick = async () => {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    if (!isTradingDay(now)) return;
    const minute = now.getHours() * 60 + now.getMinutes();
    if (minute < PREOPEN_PUSH_MINUTE || minute > POLL_END_MINUTE) return;

    const dateStr = dayjs().format('YYYYMMDD');
    ensureDayState(dateStr);

    // 1) 09:00-09:15 提前整理当日候选股，WS 弹窗推送（每天一次）
    //    服务在 09:00 之后才启动（当日已推送过）时，若本进程还没有候选行，也补一次推送
    if (minute < POLL_START_MINUTE) {
      if (preopenPushedDate === dateStr && quoteRows.length > 0) return;
      const { candidates, computedAt } = await getCandidates({ dateStr });
      if (preopenPushedDate !== dateStr) {
        preopenPushedDate = dateStr;
        writeState({ date: dateStr, preopenPushed: true, candidatesComputedAt: computedAt });
      }
      quoteRows = candidates.map((c) => ({
        code: c.code, name: c.name, board: c.board, lianbanCount: c.lianbanCount,
        floatMvYi: c.floatMvYi, washout: c.washout,
        preclose: c.lastClose, price: null, change: null, auctionGap: null,
        status: 'pending', statusText: '待竞价',
      }));
      quoteRowsTs = Date.now();
      broadcastCandidates(dateStr, quoteRows, computedAt, true);
      console.log(`[首板起爆] ${dateStr} 候选股整理完成：${quoteRows.length} 只`);
      return;
    }

    // 2) 09:15 ~ 09:41 每 3s 轮询全部候选股
    const { candidates, computedAt } = await getCandidates({ dateStr });
    if (candidates.length === 0) {
      // 无候选：仍推一次空列表，避免前端一直等待
      if (minute === POLL_START_MINUTE && quoteRowsTs === 0) {
        quoteRowsTs = Date.now();
        broadcastCandidates(dateStr, [], computedAt, false);
      }
      return;
    }

    const quotes = await fetchQuotes(candidates.map((c) => c.code));

    // 09:25 竞价结束后记录竞价值（竞价涨幅 = 当前价相对昨收）
    if (minute >= AUCTION_END_MINUTE) {
      for (const c of candidates) {
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

    // 09:25-09:30：竞价 ≥ 5% 且未达涨停（一字板买不进）→ 提前提醒，每 30s 一次（9:30 按竞价开盘价直接买入）
    // 09:30 之后：仍未推送的补推一次（服务启动晚于 09:30 的兜底）
    if (minute >= AUCTION_END_MINUTE) {
      const nowMs = now.getTime();
      const inRemindWindow = minute < BUY_START_MINUTE;
      for (const c of candidates) {
        const a = auctionGaps.get(c.code);
        if (!a || !(a.gap >= BUY_OPEN_GAP_AUCTION_PCT)) continue;
        if (a.gap >= limitUpThresholdOf(c.code)) continue; // 一字板买不进
        if (inRemindWindow) {
          const last = auctionRemindAt.get(c.code) || 0;
          if (nowMs - last < AUCTION_REMIND_MS) continue;
          auctionRemindAt.set(c.code, nowMs);
          await emitBuySignal({
            dateStr, cand: c, mode: 'auction', minute: BUY_START_MINUTE,
            price: a.price, change: a.gap, auctionGap: a.gap, remind: true,
          });
        } else if (!auctionSignaled.has(c.code)) {
          await emitBuySignal({
            dateStr, cand: c, mode: 'auction', minute: BUY_START_MINUTE,
            price: a.price, change: a.gap, auctionGap: a.gap,
          });
        }
      }
    }

    // 09:30 补记竞价值：服务在 09:25 之后才启动（auctionGaps 为空）时，用分时首个分钟点反推竞价开盘价，
    // 保证「竞价 ≥ 5% 直接 9:30 买入」在重启场景下也不漏（每只每日只补一次）
    if (minute >= BUY_START_MINUTE && minute <= BUY_START_MINUTE + 1) {
      const missing = candidates.filter((c) => !auctionGaps.has(c.code) && !burstSignaled.has(c.code));
      await batchParallel(missing, async (c) => {
        let t = null;
        try { t = await loadTlinePoints(c.code, Number(dateStr)); } catch (e) { t = null; }
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

    // 09:30 ~ 09:40：竞价 < 5% 的候选，分时涨幅首次达到 +8% 即买入
    if (minute >= BUY_START_MINUTE && minute <= BUY_CUTOFF_MINUTE) {
      const near = [];
      for (const c of candidates) {
        if (auctionSignaled.has(c.code) || burstSignaled.has(c.code)) continue;
        const q = quotes[c.code];
        if (!q || q.change == null) continue;
        // 当前涨幅接近或已达 +8% 的才拉分时，避免候选池较大时逐只 HTTP 造成压力
        if (Number(q.change) >= BUY_TRIGGER_PCT - 2) near.push(c);
      }
      await batchParallel(near, async (c) => {
        let t = null;
        try { t = await loadTlinePoints(c.code, Number(dateStr)); } catch (e) { t = null; }
        if (!t) return null;
        const hit = scanBurstHit(t, c, minute);
        if (hit && hit.limitOpen) return null;
        if (hit) {
          await emitBuySignal({
            dateStr, cand: c, mode: 'burst', minute: hit.minute,
            price: hit.px, change: hit.chg, auctionGap: auctionGaps.get(c.code)?.gap ?? null,
          });
        }
        return null;
      }, 4);
    }

    // 3) 每轮广播最新候选列表（open:false，仅刷新前端列表，不弹窗）
    quoteRows = buildRows(candidates, quotes, minute);
    quoteRowsTs = Date.now();
    broadcastCandidates(dateStr, quoteRows, dayjs(quoteRowsTs).format('YYYY-MM-DD HH:mm:ss'), false);
  } catch (e) {
    console.error('首板起爆线上轮询任务异常:', e.message);
  } finally {
    running = false;
  }
};

// 前端列表数据（打开页面/WS 重连后立即有数据，不依赖等下一轮；非交易日/盘前自动回退上一交易日）
const getSnapshot = () => getDisplayData();

const start = () => {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
  console.log('首板洗盘-起爆拉升线上服务已启动（交易日 09:00-09:41 每 3s 轮询）');
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = {
  start,
  stop,
  tick,
  getCandidates,
  getDisplayData,
  getSnapshot,
  computeCandidates,
  buildBuyChecks,
  // 常量导出便于前端文案/回测对照
  BUY_TRIGGER_PCT,
  BUY_OPEN_GAP_AUCTION_PCT,
  BUY_START_MINUTE,
  BUY_CUTOFF_MINUTE,
  MAX_FLOAT_MV_YI,
  MAX_WIN3_GAIN_PCT,
  MAX_INTRADAY_PULLBACKS,
};
