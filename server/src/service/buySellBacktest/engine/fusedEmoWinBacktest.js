// ============================================================
// 科技进攻-情绪游资极致胜率（fusedEmoWinMode: true，2026-10-19 用户新增；独立引擎）
//   把两个既有策略融合为一个账户：
//     A 风格（'emo'） = 「3日涨幅最大&三日情绪-30快进快出」（highest_3d_gain_emoquick，常规共享循环 + 快进快出半仓）
//     B 风格（'ew'）  = 「情绪游资-极致胜率」（hot_money_extreme_win，独立引擎 + 双腿结构：顺周期腿 + 逆周期腿）
//   用户规则（原文）：「如果当下是空仓，那么谁先触发买谁。当然如果说一个买了半仓，那么另外一个哪怕买点触发了
//   也不能买剩下的半仓，只能先坚持做一种风格，等这一笔交易完全结束了之后再说下一次。如果是同时触发，那么
//   快进快出的优先级更高。」
//   语义（AskUserQuestion 已确认）：
//     ① 仓位模型 = 风格独占整个账户：账户仍 2 个半仓槽，但由单一风格独占；该风格按自身逻辑建仓
//        （A 风格：快进快出情形首日半仓、次日补第二份；非快进快出情形首日即全仓。B 风格：顺/逆两腿各半仓）；
//        期间另一风格被完全禁止；直到该风格全部平仓回到空仓，另一风格才解禁。
//     ② B 风格保持双腿结构（逆周期腿不删除）。
//     ③ 「同时触发」判定粒度 = 同一时间桶（5 分钟桶）内：先评估 A 风格，A 未成交才评估 B 风格。
//     ④ 科技进攻抢仓（2026-10-20 用户新增）：B 风格（情绪游资-极致胜率）持仓锁定账户期间，若某时间桶
//        A 风格（科技进攻）买点成交且该桶「实时科技情绪指数 > 0」，则把 B 风格**全部隔夜持仓**按当桶分时价
//        强制卖出（当日买入的 B 风格持仓保留不卖——存在此类持仓时放弃抢仓、账户仍由 B 风格独占），
//        同桶即由 A 风格接管账户建仓——即「风格独占锁」的例外：A 风格优先级高于 B 风格。
//   实现：单循环 + styleLock（null / 'emo' / 'ew'）状态机。A 侧口径以 EMO_ID='highest_3d_gain_emoquick' 传入
//   pickBestStock / withDualGateInfo / runBuyPointDiagnosis（保证选股委派、跨指数双门禁、检查4 比例收紧与独立
//   快进快出策略完全一致），卖点侧使用合成策略视图 emoStrategyView（emoQuickOut: true）驱动快进快出专属卖点
//   与盘中大跌强卖；B 侧完整照搬 runExtremeWinBacktest 的双腿卖出 / 买入逻辑，持仓构建复用其导出的
//   buildPosition / buildRevPosition（买入原因与 buyChecks 明细文案逐字节一致）。
//   2026-10-20 用户新增：B 风格双腿买入受「每天 13:30 后不买」时间门禁限制（13:30 桶本身可买；与独立极致胜率引擎同口径），
//   A 风格（科技进攻·快进快出）不受该门禁影响。
// ============================================================
const { STRATEGIES, isCycleFilterStrategy } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  stockPriorAvgVolume,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const {
  iceResilienceIndexCode,
  getIceMa3SlopeIntraday,
  fmtKeyBlockSlope,
  ICE_SIGNAL_INDEX_CODE,
  ensureIndexMa3SlopeSeries,
  precomputeTurnMap,
  CYB_GATE_STRATEGY_IDS,
  CYB_INDEX_CODE,
  STAR_INDEX_CODE,
  annotateIndexGateChecksWithStock,
  withDualGateInfo,
} = require('./indexGate');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_CODES, EMO_QUICK_FUND_INFLOW_BASE, OPENING_BELOW_RATIO_STRATEGY_IDS } = require('../constants');
const { fmtTime, buildBuyReasonFromDiag, runBuyPointDiagnosis } = require('../diagnose/buyPoint');
const { createEmoQuickFundGate } = require('./emoQuick');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
// 差劲分 / 强度分口径与打分函数（与「个股历史分析」接口共用同一份实现）
const {
  round2,
  loadTlinePoints,
  clearTlineCache,
  strengthAtMinute,
  diffAtMinute,
} = require('./extremeWinScores');
// B 风格·顺周期腿候选池 + 死叉口径
const {
  LOOKBACK_DAYS, MIN_BOARD_COUNT, DEATH_CROSS_WINDOW, DELTA_MIN,
  PREV_STRENGTH_GAP_GATE, OPEN_GAP_MIN_PCT,
  computeCrossInfo, buildExtremeWinPool,
} = require('./extremeWinPool');
// B 风格·逆周期腿候选池 + 择时常量
const {
  LOOKBACK_DAYS: REV_LOOKBACK_DAYS,
  MIN_BOARD_COUNT: REV_MIN_BOARD_COUNT,
  NEG_STREAK_MIN_DAYS: REV_NEG_STREAK_MIN_DAYS,
  INDEX_DROP_PCT: REV_INDEX_DROP_PCT,
  STRENGTH_MIN: REV_STRENGTH_MIN,
  HIT_REQUIRED: REV_HIT_REQUIRED,
  buildReverseLeaderPool,
} = require('./reverseLeaderPool');
const { buildPosition, buildRevPosition } = require('./extremeWinBacktest');
const { buildWindowAxis, injectSimStocksIntoCampData } = require('./pickHelpers');
const { buildPrevOneWordBoardSet, buildReplayStocksWithTline, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { withResilienceGateInfo } = require('./checkBuilders');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn, getPositionLegWeight } = require('./twoBuy');
const { buildCounterCycSet } = require('./cycleFilter');
const { pickBestStock } = require('./pickBest');
const { emoQuickOutSell } = require('./sellHooks/emoQuickOut');
const { generalSellPositions } = require('./sellHooks/generalSell');

// A 风格口径策略 id（必须用独立快进快出策略 id：pickBestStock 按该字符串委派选股并挂 emoQuickOut 标注）
const EMO_ID = 'highest_3d_gain_emoquick';

// 以下常量与 ./extremeWinBacktest 同值（该文件未导出这些内部常量，此处同源重声明，保证 B 风格口径一致）
const LEG_COUNT = 2;               // 仓位份数
const LEG_WEIGHT = 0.5;            // 每份占账户资金比例（半仓）
const LEG_LABELS = ['A', 'B'];     // 份别标记
const CYCLE_PRO = 'procyclic';     // 顺周期腿
const CYCLE_COUNTER = 'counter';   // 逆周期腿
const CYCLE_LABELS = { [CYCLE_PRO]: '顺周期', [CYCLE_COUNTER]: '逆周期' };
const WEAK_TRADE_HOLD_DAYS = 3;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const TAIL_MINUTE = 1457;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001';
// 2026-10-20 用户新增（与 ./extremeWinBacktest 同值同口径）：每天 13:30 之后不买（13:30 桶本身仍可买），
//   仅约束 B 风格（情绪游资-极致胜率）双腿买入；A 风格（科技进攻·快进快出）不受影响
const BUY_CUTOFF_MINUTE = 1330;

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};

// B 风格·顺周期腿买点门禁：上个交易日强度分 > 60 且当日竞价低开超过 -3% 时该候选不可买（顺延下一只）
const failPrevStrengthOpenGap = (r) => {
  const prevStrength = r.crossInfo ? r.crossInfo.prevDayStrength : null;
  if (!(prevStrength != null && prevStrength > PREV_STRENGTH_GAP_GATE)) return false;
  const gap = r.s ? r.s.aRaw : null;
  if (gap == null || !Number.isFinite(gap)) return false;
  return gap < OPEN_GAP_MIN_PCT;
};

// 上证指数「前一交易日收盘口径」3 日线斜率（用于逆周期腿「盘中由负转正」卖点），数据不足返回 null
const prevSlopeOf = (slopeByDate, dateStr) => {
  const target = Number(dateStr);
  let bestDate = null;
  let bestSlope = null;
  for (const [d, s] of slopeByDate) {
    if (d < target && (bestDate === null || d > bestDate)) { bestDate = d; bestSlope = s; }
  }
  return bestSlope;
};

const runFusedEmoWinBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.fusedEmoWinMode !== true) {
    return { success: false, message: `未知科技进攻-情绪游资极致胜率策略: ${strategyId}` };
  }

  // A 风格卖点用的合成策略视图：emoQuickOut: true → 快进快出专属卖点 + 盘中大跌强卖生效；
  // 不设 twoBuy（getPositionLegWeight 优先取持仓 weight，非快进快出全仓持仓 weight 缺省 → 全仓 1，与独立策略一致）
  const emoStrategyView = { id: EMO_ID, name: STRATEGIES[EMO_ID]?.name || EMO_ID, emoQuickOut: true, crashSell: true };

  // 日期源并入 tech_index 覆盖的交易日（与 B 风格独立引擎同口径，不依赖资金快照）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // ===== B 风格预计算：上证 3 日线斜率收盘序列 + 「由正转负 / 由负转正」事件 =====
  const slopeByDate = new Map();
  try {
    const { dates, slopes } = await ensureIndexMa3SlopeSeries(ICE_SIGNAL_INDEX_CODE);
    for (const d of dates) {
      const s = slopes.get(d);
      if (s != null && Number.isFinite(Number(s))) slopeByDate.set(Number(d), Number(s));
    }
  } catch (e) { /* 数据不足时逆周期腿卖点不生效 */ }
  let turnMap = new Map();
  try {
    turnMap = await precomputeTurnMap(ICE_SIGNAL_INDEX_CODE, rangeDates.map(Number));
  } catch (e) {
    turnMap = new Map();
  }

  // B 风格启动预拉取：顺周期腿候选池 / 逆周期腿候选池日K
  try {
    const presetAll = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      for (const s of stocks) presetAll.add(s.code);
    }
    if (presetAll.size > 0) await ensureBarsForCodes(presetAll);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }
  try {
    const presetRev = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, REV_LOOKBACK_DAYS, REV_MIN_BOARD_COUNT);
      for (const s of stocks) presetRev.add(s.code);
    }
    if (presetRev.size > 0) await ensureBarsForCodes(presetRev);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }

  const emoTrades = [];
  const ewTrades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  // A 风格（科技进攻·快进快出）「资金净流入阈值动态调节」状态机（2026-10-21 用户新增）：
  // 连续 2 笔 A 风格已完结交易的折算收益率（半仓 ×0.5 折算后）均未超过 3% → A 风格买点诊断
  // 资金净流入阈值 20 → 30 亿；此后任一笔超过 3% → 降回 20 亿并重置连续计数。
  // 仅作用于 A 风格买点诊断，B 风格（情绪游资极致胜率）不受影响、仍按固定 20 亿判定
  const fundGate = createEmoQuickFundGate();
  let fundGateFedCount = 0;
  const feedFundGate = () => {
    while (fundGateFedCount < emoTrades.length) {
      fundGate.onTradeClosed(emoTrades[fundGateFedCount]?.returnRate);
      fundGateFedCount += 1;
    }
  };

  // ===== 账户状态（风格独占锁）=====
  let styleLock = null;         // null = 空仓（两风格均可参与）| 'emo' | 'ew'
  const emoPositions = [];      // A 风格持仓：0~1 份（非快进快出全仓）或 1~2 份（快进快出半仓两份）
  let quickOutSoldDate = null;  // A 风格：最近一次 10:00 强卖/止损日期（当日禁止二次买入）
  const ewPositions = new Array(LEG_COUNT).fill(null);  // B 风格两腿持仓槽
  const ewLegLastSellDate = new Array(LEG_COUNT).fill(null);

  // B 风格·逆周期腿命中计数（逐股独立累计；只在当前负斜率窗口内累计，窗口变化即清零）
  const revHitCount = new Map();
  let revWindowKey = null;

  // A 风格选股：历史每日 EOD 信息 + 预热前的日期轴（起点附近「最近 N 日」窗口不被起始日截断）
  const dailyInfos = new Map();
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, 10, dailyInfos);

  // A 风格·跨指数双门禁预计算（highest_3d_gain_emoquick 属 CYB_GATE_STRATEGY_IDS）
  let cybGatePrecomputed = null, starGatePrecomputed = null;
  const cybGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const starGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  if (CYB_GATE_STRATEGY_IDS.has(EMO_ID)) {
    try {
      [cybGatePrecomputed, starGatePrecomputed] = await Promise.all([
        precomputeTurnMap(CYB_INDEX_CODE, rangeDates),
        precomputeTurnMap(STAR_INDEX_CODE, rangeDates),
      ]);
    } catch (e) {
      cybGatePrecomputed = null; starGatePrecomputed = null;
    }
  }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }
    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const dateDisplay = campData.dateDisplay || dateStr;
    const dateNum = parseInt(dateStr, 10);
    const hasTailBucket = timeBuckets.some(b => Number(b.minute) >= TAIL_MINUTE);
    const todayIdx = di;

    // ===== A 风格当日准备：合成股票注入 + 分时回放数据 + EOD 信息 + 出现过的自选股 =====
    await injectSimStocksIntoCampData(campData, dateStr);
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    // ===== A 风格·专属卖点（次日 10:00 强卖 + 盘中止损 + 盘中大跌强卖，先到先卖），返回强卖日期 =====
    const soldDate = emoQuickOutSell({ positions: emoPositions, strategy: emoStrategyView, dateStr, dateDisplay, replayStocks, timeBuckets, campData, singleTrades: emoTrades });
    if (soldDate) quickOutSoldDate = soldDate;
    feedFundGate(); // 强卖成交即时喂入 A 风格资金净流入阈值状态机（后续时间桶买点诊断按新阈值判定）

    // ===== B 风格当日准备：逆周期腿买点前置 + 两条腿的候选池 =====
    const tInfo = turnMap.get(Number(dateStr));
    const slopeClose = tInfo ? tInfo.slopeClose : null;
    const daysSinceTurnNeg = tInfo ? tInfo.daysSinceTurnNeg : null;
    const curWindowKey = tInfo ? tInfo.turnNegDate : null;
    if (curWindowKey !== revWindowKey) { revHitCount.clear(); revWindowKey = curWindowKey; }
    const eligibleRev = slopeClose != null && slopeClose < 0
      && daysSinceTurnNeg != null && daysSinceTurnNeg >= REV_NEG_STREAK_MIN_DAYS;
    const revPrevCloseSlope = prevSlopeOf(slopeByDate, dateStr);

    let candidatesRaw = [];
    let poolWinDates = [];
    try {
      const pool = await buildExtremeWinPool(dateStr);
      candidatesRaw = pool.stocks || [];
      poolWinDates = pool.winDates || [];
    } catch (e) { candidatesRaw = []; }
    if (candidatesRaw.length > 0) {
      for (const s of candidatesRaw) {
        if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
      }
    }

    let revCandidatesRaw = [];
    let revPoolFilterText = '';
    if (eligibleRev) {
      try {
        const pool = await buildReverseLeaderPool(dateStr);
        revCandidatesRaw = pool.stocks || [];
        revPoolFilterText = pool.poolFilterText || '';
      } catch (e) { revCandidatesRaw = []; revPoolFilterText = ''; }
      if (revCandidatesRaw.length > 0) {
        for (const s of revCandidatesRaw) {
          s.poolFilterText = revPoolFilterText;
          if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
        }
      }
    }

    // B 风格每日分时缓存重建（控制内存）
    clearTlineCache();

    // B 风格逐份隔夜持仓的当日分时（卖点用）+ 当日收盘抗分歧指数（懒计算）
    const posTlines = new Array(LEG_COUNT).fill(null);
    for (let l = 0; l < LEG_COUNT; l++) {
      const p = ewPositions[l];
      if (p && dateStr > p.buyDate) posTlines[l] = await loadTlinePoints(p.code, dateNum);
    }
    const posResiliences = new Array(LEG_COUNT).fill(null);
    const posResilienceLoaded = new Array(LEG_COUNT).fill(false);
    const ensurePosResilience = async (l) => {
      if (posResilienceLoaded[l]) return posResiliences[l];
      posResilienceLoaded[l] = true;
      const p = ewPositions[l];
      if (!p) return null;
      try {
        const [stockT, indexT] = await Promise.all([
          getSingleStockTlineDataByDate(p.code, dateNum),
          getSingleStockTlineDataByDate(LEADER_RESILIENCE_INDEX_CODE, dateNum),
        ]);
        const stockLine = (stockT?.line || [])
          .filter(x => x && x.minute != null && x.last_px != null)
          .map(x => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter(x => x.lastPx > 0);
        const indexLine = (indexT?.line || [])
          .filter(x => x && x.minute != null && x.last_px != null)
          .map(x => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter(x => x.lastPx > 0);
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const s = calculateReplayResilience(stockLine, indexLine, p.code);
          if (s != null && Number.isFinite(Number(s))) posResiliences[l] = round2(s);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResiliences[l];
    };

    // B 风格指数分时（主板 sh000001 / 创业板 sz399006 / 科创50 sh000688）：两条腿共用（懒加载，每日一次）
    let idxTlineReady = false;
    const idxTlineMap = new Map();
    const ensureIdxTlines = async () => {
      if (idxTlineReady) return;
      idxTlineReady = true;
      await Promise.all(['sh000001', 'sz399006', 'sh000688'].map(async (ic) => {
        try {
          const r = await loadTlinePoints(ic, dateNum);
          idxTlineMap.set(ic, r || { preclose: null, points: [] });
        } catch (e) { idxTlineMap.set(ic, { preclose: null, points: [] }); }
      }));
    };
    const idxPointsOf = (code) => (idxTlineMap.get(iceResilienceIndexCode(code)) || {}).points || [];
    const idxChangeAt = (minute) => {
      const t = idxTlineMap.get(ICE_SIGNAL_INDEX_CODE);
      if (!t || !(t.preclose > 0) || t.points.length === 0) return null;
      const atPt = priceAtMinute(t.points, minute);
      if (!atPt || !(atPt.lastPx > 0)) return null;
      return ((atPt.lastPx - t.preclose) / t.preclose) * 100;
    };

    // B 风格·顺周期腿候选池数据（懒加载）：死叉前置 + 今日分时 + 今日前 3 日均量
    let poolReady = false;
    let candidates = [];
    const todayTline = new Map();
    const todayAvg3Vol = new Map();
    const ensurePoolData = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidatesRaw.length === 0) return;
      await ensureIdxTlines();
      try {
        await ensureBarsForCodes(new Set(candidatesRaw.map(s => s.code)));
      } catch (e) { /* 单只失败后续按 null 处理 */ }
      let fallbackCrossDates = [];
      try { fallbackCrossDates = (await getPastTradingDates(dateStr, DEATH_CROSS_WINDOW)).map(Number); } catch (e) { fallbackCrossDates = []; }
      const crossDatesOf = (peakDate) => {
        const p = Number(peakDate);
        if (!Number.isFinite(p) || poolWinDates.length === 0) return fallbackCrossDates;
        return poolWinDates.filter(d => Number(d) >= p);
      };
      const crossMap = new Map();
      await batchParallel(candidatesRaw, async (c) => {
        try {
          const cd = crossDatesOf(c.peakDate);
          crossMap.set(c.code, cd.length < 2 ? null : await computeCrossInfo(c.code, cd, c.peakDate));
        } catch (e) { crossMap.set(c.code, null); }
      }, 8);
      candidates = candidatesRaw
        .map(c => ({ ...c, crossInfo: crossMap.get(c.code) }))
        .filter(c => c.crossInfo && c.crossInfo.hasCross && !c.crossInfo.consumed && c.crossInfo.prevDayVolumeOk);
      if (candidates.length === 0) return;
      await batchParallel(candidates, async (c) => {
        try { todayTline.set(c.code, await loadTlinePoints(c.code, dateNum)); } catch (e) { todayTline.set(c.code, { preclose: null, points: [] }); }
        try { todayAvg3Vol.set(c.code, stockPriorAvgVolume(c.code, dateNum, 3)); } catch (e) { todayAvg3Vol.set(c.code, null); }
      }, 8);
    };

    // B 风格·逆周期腿候选池数据（懒加载）：今日分时
    let revPoolReady = false;
    const revTodayTline = new Map();
    const ensureRevPoolData = async () => {
      if (revPoolReady) return;
      revPoolReady = true;
      if (revCandidatesRaw.length === 0) return;
      await ensureIdxTlines();
      await batchParallel(revCandidatesRaw, async (c) => {
        try { revTodayTline.set(c.code, await loadTlinePoints(c.code, dateNum)); } catch (e) { revTodayTline.set(c.code, { preclose: null, points: [] }); }
      }, 8);
    };

    // B 风格·顺周期腿某桶达标候选（按今日「强度分 − 差劲分」降序）
    const evalBucket = (bucketMinute) => {
      const out = [];
      for (const c of candidates) {
        const t = todayTline.get(c.code);
        if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
        const d = diffAtMinute(t.points, t.preclose, c.code, bucketMinute, todayAvg3Vol.get(c.code));
        if (!d) continue;
        const s = strengthAtMinute(t, bucketMinute, c.code, idxPointsOf(c.code));
        if (!s) continue;
        const delta = round2(s.score - d.score);
        if (delta == null || delta < DELTA_MIN) continue;
        out.push({ ...c, delta, strength: s.score, diffScore: d.score, s, d, px: s.px, changePct: s.changePct, limitUp: s.limitUp });
      }
      out.sort((a, b) => b.delta - a.delta);
      return out;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    const revDayTriggered = new Set(); // 逆周期腿当日已登记命中的候选（同一天同一只只计一次）
    const idleLegIdx = () => ewPositions.findIndex((p, i) => !p && ewLegLastSellDate[i] !== dateStr);

    // B 风格卖出记录（正常卖点与「科技进攻抢仓」强制卖出共用）：写成交、清空该份、登记当日已卖出
    const recordEwSell = (l, position, sellMinute, sellPx, sellChange, sellReason) => {
      const rawReturnRate = position.buyPrice > 0
        ? round2(((sellPx - position.buyPrice) / position.buyPrice) * 100)
        : null;
      ewTrades.push({
        seq: ewTrades.length + 1,
        metric: position.metric,
        code: position.code,
        stockName: position.stockName,
        board: position.board,
        positionMode: 'offense',
        splitLeg: LEG_LABELS[l],
        cycle: position.cycle,
        weight: LEG_WEIGHT,
        buyDate: position.buyDate,
        buyDateDisplay: position.buyDateDisplay,
        buyTime: position.buyTime,
        buyPrice: position.buyPrice,
        buyChange: position.buyChange,
        buyReason: position.buyReason,
        buyChecks: position.buyChecks,
        sellDate: dateStr,
        sellDateDisplay: dateDisplay,
        sellTime: fmtMinute(sellMinute),
        sellPrice: round2(sellPx),
        sellChange,
        sellReason,
        returnRate: rawReturnRate != null ? round2(rawReturnRate * LEG_WEIGHT) : null,
        rawReturnRate,
      });
      ewPositions[l] = null;
      ewLegLastSellDate[l] = dateStr;
    };

    // A 风格「科技进攻抢仓」（2026-10-20 用户新增）：B 风格持仓锁定账户期间，A 风格买点成交且当桶实时科技情绪
    // > 0 时，把 B 风格全部隔夜持仓按当桶分时价强制卖出，账户随即由 A 风格接管。仅当 B 风格持仓全部为隔夜持仓
    // （买入日早于当日）且当桶分时价可用时才执行——当日买入的 B 风格持仓保留不卖，该情形下放弃抢仓、账户仍由
    // B 风格独占；返回是否已完成抢仓（true 表示账户已空出、可立即由 A 风格建仓）
    const tryPreemptEwPositions = (bucketMinute, emotion) => {
      if (styleLock !== 'ew') return true; // 非 B 风格锁定：无需抢仓
      const plan = [];
      for (let l = 0; l < LEG_COUNT; l++) {
        const p = ewPositions[l];
        if (!p) continue;
        if (!(dateStr > p.buyDate)) return false; // 当日买入的 B 风格持仓不卖 → 放弃抢仓
        const t = posTlines[l];
        const atPt = t && t.points.length > 0 ? priceAtMinute(t.points, bucketMinute) : null;
        if (!atPt || !(atPt.lastPx > 0)) return false; // 当桶无可用分时价 → 放弃抢仓
        const preclose = t.preclose;
        plan.push({
          l,
          position: p,
          minute: atPt.minute,
          px: atPt.lastPx,
          change: preclose && preclose > 0
            ? round2(((atPt.lastPx - preclose) / preclose) * 100)
            : (atPt.change != null ? atPt.change : null),
        });
      }
      if (plan.length === 0) return false;
      for (const it of plan) {
        const cycleLabel = CYCLE_LABELS[it.position.cycle] || '顺周期';
        recordEwSell(it.l, it.position, it.minute, it.px, it.change,
          `科技进攻（A 风格）买点触发且当桶实时科技情绪 ${emotion} > 0，强制抢仓卖出（清出账户交 A 风格建仓），情绪游资-极致胜率·${cycleLabel}腿（半仓）卖出`);
      }
      return true;
    };

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);

      // ===== 卖出①（B 风格：隔夜持仓按两条腿各自的卖点规则独立卖出）=====
      for (let l = 0; l < LEG_COUNT; l++) {
        const position = ewPositions[l];
        const posTline = posTlines[l];
        if (!position || !(dateStr > position.buyDate) || !posTline || posTline.points.length === 0) continue;
        const atPt = priceAtMinute(posTline.points, bucketMinute);
        if (!atPt || !(atPt.lastPx > 0)) continue;
        const px = atPt.lastPx;
        const preclose = posTline.preclose;
        const changePct = preclose && preclose > 0
          ? round2(((px - preclose) / preclose) * 100)
          : (atPt.change != null ? atPt.change : null);
        const costReturn = position.buyPrice > 0
          ? round2(((px - position.buyPrice) / position.buyPrice) * 100)
          : null;

        let sellReason = null;
        let sellMinute = atPt.minute;
        let sellPx = px;
        let sellChange = changePct;

        const isCounter = position.cycle === CYCLE_COUNTER;
        const priceHit = isCounter
          ? scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
            disableMinutePlummet: true,
          })
          : scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
            costLinePct: -5,
            costLineSustainMinutes: 0,
          });
        if (priceHit) {
          sellReason = priceHit.reason;
          sellMinute = priceHit.minute;
          sellPx = priceHit.px;
          sellChange = priceHit.changePct;
        }
        if (!sellReason && isCounter) {
          const intradaySlope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
          if (intradaySlope != null && Number.isFinite(Number(intradaySlope))
            && revPrevCloseSlope != null && revPrevCloseSlope <= 0 && Number(intradaySlope) > 0) {
            sellReason = `上证指数 3 日线斜率盘中由负转正（前一交易日收盘 ${fmtKeyBlockSlope(revPrevCloseSlope)} → 当桶实时 ${fmtKeyBlockSlope(intradaySlope)}）`;
          }
        }
        if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
          if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
            sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
          }
        }
        if (!sellReason && isTailBucket) {
          const res = await ensurePosResilience(l);
          if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
            sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
          }
        }

        if (sellReason) {
          const cycleLabel = CYCLE_LABELS[position.cycle] || '顺周期';
          recordEwSell(l, position, sellMinute, sellPx, sellChange, `${sellReason}，情绪游资-极致胜率·${cycleLabel}腿（半仓）卖出`);
        }
      }

      // ===== 卖出②（A 风格：通用 7 条件卖点，见 sellHooks/generalSell）=====
      if (emoPositions.length > 0) {
        await generalSellPositions({ positions: emoPositions, strategy: emoStrategyView, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades: emoTrades });
      }
      feedFundGate(); // 通用卖点成交即时喂入 A 风格资金净流入阈值状态机

      // ===== 风格独占锁·解锁判定：当前风格全部平仓回到空仓 → 解锁 =====
      if (styleLock === 'emo' && emoPositions.length === 0) styleLock = null;
      if (styleLock === 'ew' && ewPositions.every(p => !p)) styleLock = null;

      // ===== 买入①（A 风格·科技进攻）=====
      // 未被 B 风格独占时照常评估；B 风格（情绪游资-极致胜率）持仓锁定账户期间，仅当「科技进攻抢仓」条件成立时
      // 才评估（2026-10-20 用户新增）：当桶实时科技情绪 > 0，且 B 风格持仓全部为隔夜持仓 → 强制卖出后由 A 风格接管
      const bucketTechEmotion = bucket.techEmotion != null && !Number.isNaN(Number(bucket.techEmotion))
        ? Number(bucket.techEmotion)
        : null;
      const preemptGateOk = bucketTechEmotion != null && bucketTechEmotion > 0;
      if (styleLock !== 'ew' || preemptGateOk) {
        const quickOutNoRebuy = quickOutSoldDate === dateStr;
        // A 风格买点诊断按动态阈值判定资金净流入检查（见上方 fundGate；B 风格不受影响）；
        // 已持第一份半仓待补买第二份时，检查2 固定按基准 20 亿判定（2026-10-21 用户新增：第二份补买阈值降回 20 亿）
        const waitingSecondLeg = emoPositions.length === 1 && emoPositions[0].leg === 1;
        const buyDiag = runBuyPointDiagnosis(timeBuckets, bi, campData, { ratioGatedOpeningBelow: OPENING_BELOW_RATIO_STRATEGY_IDS.has(EMO_ID), fundInflowThreshold: waitingSecondLeg ? EMO_QUICK_FUND_INFLOW_BASE : fundGate.getThreshold() })?.data;
        const buyHit = !quickOutNoRebuy && buyDiag?.allPassed === true;
        const buyInfo = buyHit ? buildBuyReasonFromDiag(buyDiag) : null;
        if (buyHit) {
          const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(buyInfo, EMO_ID, dateStr, bucket.minute,
            { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState });
          if (gatePassed) {
            const buyTime = fmtTime(bucket.timeKey).substring(0, 5);
            if (emoPositions.length === 0) {
              const prevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
              const emoCycSet = isCycleFilterStrategy(emoStrategyView)
                ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
                : null;
              const picked = pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, EMO_ID, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet);
              // A 风格买点确实可以成交（已选到标的）才执行抢仓：先强制卖出 B 风格隔夜持仓，再建仓
              if (picked && tryPreemptEwPositions(bucketMinute, bucketTechEmotion)) {
                const finalBuyInfo = withResilienceGateInfo(gatedBuyInfo, picked);
                const sc = picked.stock;
                const firstBuyPrice = parseFloat(Number(sc.lastPx).toFixed(2));
                // 快进快出半仓：本次买入属快进快出情形 → 仅半仓（第一份）；
                // 30 亿抬高态强制两次买入（2026-10-21 用户新增，与独立快进快出策略同口径）：
                // 阈值处于抬高态（30 亿）时不分快进快出情形一律只买半仓（第一份），剩余半仓等后续交易日补买（阈值 20 亿）
                const gateRaised = fundGate.isRaised();
                const halfByQuickOut = picked.emoQuickOut?.quickOut === true || gateRaised;
                const forcedRaisedHalf = gateRaised && picked.emoQuickOut?.quickOut !== true;
                emoPositions.push({
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: firstBuyPrice,
                  buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                  metric: picked.metric,
                  buyReason: forcedRaisedHalf
                    ? `${finalBuyInfo.buyReason}；资金净流入阈值处于抬高态 30 亿，强制两次买入——本次仅买第一份 5 成，剩余半仓等后续交易日买点再次触发时补买（补买阈值降为 20 亿）`
                    : finalBuyInfo.buyReason,
                  buyChecks: annotateIndexGateChecksWithStock(finalBuyInfo.buyChecks, sc.code, sc.name),
                  emoQuickOut: picked.emoQuickOut || null,
                  ...(halfByQuickOut ? { twoBuy: true, leg: 1, weight: TWO_BUY_LEG_WEIGHT } : {}),
                });
                styleLock = 'emo';
              }
            } else if (emoPositions.length === 1 && emoPositions[0].leg === 1 && dateStr > emoPositions[0].buyDate) {
              const first = emoPositions[0];
              const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
              const secondPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
              const heldLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
              if (secondPx != null && secondPx > 0 && !heldLimitUp) {
                emoPositions.push({
                  code: first.code,
                  stockName: first.stockName,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: secondPx,
                  buyChange: heldSc.changePct != null ? parseFloat(Number(heldSc.changePct).toFixed(2)) : null,
                  metric: first.metric,
                  buyReason: `${gatedBuyInfo?.buyReason || first.buyReason}；买点第二次触发，买入第二份 5 成（同一股票 ${first.stockName}，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                  buyChecks: annotateIndexGateChecksWithStock(gatedBuyInfo?.buyChecks || first.buyChecks, first.code, first.stockName),
                  emoQuickOut: null,
                  twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
                });
                styleLock = 'emo';
              }
            }
          }
        }
      }

      // ===== 买入②（B 风格·极致胜率双腿：仅在未被 A 风格独占时评估）=====
      if (styleLock !== 'emo') {
        // 【顺周期腿】上证 3 日线分时斜率 > 0 + 今日「强度分 − 差劲分 >= 30」
        //   2026-10-20 用户新增：每天 13:30 之后不买（13:30 桶本身仍可买，13:35 起的桶一律不买）
        if (bucketMinute <= BUY_CUTOFF_MINUTE && idleLegIdx() !== -1) {
          const idxMa3Slope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
          if (Number(idxMa3Slope) > 0) {
            await ensurePoolData();
            if (candidates.length > 0) {
              const ranked = evalBucket(bucketMinute);
              for (const pick of ranked) {
                const legIdx = idleLegIdx();
                if (legIdx === -1) break;
                const otherHeld = ewPositions.filter((p, i) => i !== legIdx && p).map(p => p.code);
                if (pick.limitUp || otherHeld.includes(pick.code) || failPrevStrengthOpenGap(pick)) continue;
                ewPositions[legIdx] = buildPosition({ pick, ranked, dateStr, dateDisplay, timeText, idxMa3Slope, legIdx, otherHeld });
                ewPositions[legIdx].buyDi = todayIdx;
                ewPositions[legIdx].cycle = CYCLE_PRO;
                styleLock = 'ew';
                for (const c of candidates) if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name || c.code });
              }
            }
          }
        }

        // 【逆周期腿】上证斜率连续为负 + 当日上证跌幅 ≥ 0.5% 时逐桶累计强度分命中，第 2 次命中且有空仓位即买
        if (eligibleRev && revCandidatesRaw.length > 0) {
          await ensureRevPoolData();
          const idxChg = idxChangeAt(bucketMinute);
          if (idxChg != null && idxChg <= REV_INDEX_DROP_PCT) {
            for (const c of revCandidatesRaw) {
              if (revDayTriggered.has(c.code)) continue;
              const t = revTodayTline.get(c.code);
              if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
              const s = strengthAtMinute(t, bucketMinute, c.code, idxPointsOf(c.code));
              if (!s || !(s.score > REV_STRENGTH_MIN)) continue;
              revDayTriggered.add(c.code);
              const prev = revHitCount.get(c.code) || 0;
              const next = Math.min(prev + 1, REV_HIT_REQUIRED);
              revHitCount.set(c.code, next);
              // 2026-10-20 用户新增：每天 13:30 之后不买——命中登记照常累计（与线上口径一致），仅不再实际买入
              if (prev >= 1 && !s.limitUp && bucketMinute <= BUY_CUTOFF_MINUTE) {
                const legIdx = idleLegIdx();
                if (legIdx !== -1) {
                  const otherHeld = ewPositions.filter((p, i) => i !== legIdx && p).map(p => p.code);
                  if (!otherHeld.includes(c.code)) {
                    ewPositions[legIdx] = buildRevPosition({
                      pick: c, s, score: s.score, px: s.px, changePct: s.changePct,
                      dateStr, dateDisplay, timeText, hitCount: next,
                      slopeClose, daysSinceTurnNeg, idxChg, legIdx, otherHeld,
                    });
                    ewPositions[legIdx].buyDi = todayIdx;
                    ewPositions[legIdx].cycle = CYCLE_COUNTER;
                    styleLock = 'ew';
                    for (const cc of revCandidatesRaw) if (!seenStocks.has(cc.code)) seenStocks.set(cc.code, { code: cc.code, name: cc.name || cc.code });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ===== 结果组装 =====
  const trades = sortTradesByBuyTime([...emoTrades, ...ewTrades]);
  trades.forEach((t, i) => { t.seq = i + 1; });

  // 期末持仓：A 风格（按权重折算）+ B 风格（双腿各半仓）（两风格互斥，不会同时存在）
  const holdings = [];
  for (const pos of emoPositions) {
    const h = { ...pos };
    let closePx = null;
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(pos.code);
      if (info && info.closePx != null && info.closePx > 0) { closePx = info.closePx; break; }
    }
    const rawBuyReturn = closePx != null && pos.buyPrice > 0
      ? parseFloat((((closePx - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
      : null;
    const legWeight = getPositionLegWeight(pos, emoStrategyView);
    if (legWeight < 1) {
      h.weight = legWeight;
      h.rawBuyReturn = rawBuyReturn;
      h.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * legWeight).toFixed(2)) : null;
    } else {
      h.buyReturn = rawBuyReturn;
    }
    holdings.push(h);
  }
  const lastPxDate = rangeDates[rangeDates.length - 1];
  for (let l = 0; l < LEG_COUNT; l++) {
    const p = ewPositions[l];
    if (!p) continue;
    const holding = { ...p, weight: LEG_WEIGHT };
    let rawBuyReturn = null;
    const closePx2 = getStockCloseOnOrBefore(p.code, lastPxDate);
    if (closePx2 != null && closePx2 > 0 && p.buyPrice > 0) {
      rawBuyReturn = round2(((closePx2 - p.buyPrice) / p.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn * LEG_WEIGHT) : null;
    holdings.push(holding);
  }

  // 整体收益：账户口径（两份半仓各自独立计成本与收益 ×0.5；跨风格复利、同风格内重叠区间相加）
  const overallReturn = computeTwoBuyAccountReturn([
    ...trades,
    ...holdings.map(h => ({ ...h, returnRate: h.buyReturn })),
  ]);

  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
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
    currentHoldings: holdings,
    currentHolding: holdings.length === 1 ? holdings[0] : null,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: holdings.length > 0,
    },
  };
};

module.exports = { runFusedEmoWinBacktest };
