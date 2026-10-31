const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getRecentMultiLianbanStocks,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const {
  ICE_SIGNAL_INDEX_CODE,
  ensureIndexMa3SlopeSeries,
  getIceMa3SlopeIntraday,
  iceResilienceIndexCode,
  fmtKeyBlockSlope,
  precomputeTurnMap,
} = require('./indexGate');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_THEMES } = require('../constants');
const { fmtTime } = require('../diagnose/buyPoint');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
// 强度分完全复用「情绪游资-极致胜率」口径（0.3×A + 0.2×B + 0.3×C + 0.2×D）
const {
  STRENGTH_A_MAX, STRENGTH_B_MAX, STRENGTH_C_MAX, STRENGTH_D_MAX,
  round2,
  loadTlinePoints, clearTlineCache,
  strengthAtMinute,
} = require('./extremeWinScores');
// 逆周期候选池 + 择时常量 公共模块（与「情绪游资-极致胜率」逆周期腿共用同一份实现，避免口径漂移）
const {
  LOOKBACK_DAYS, MIN_BOARD_COUNT, RANGE_WINDOW_DAYS, RANGE_SLIDE_DAYS, MIN_WINDOW_RANGE_PCT,
  NEG_STREAK_MIN_DAYS, INDEX_DROP_PCT, STRENGTH_MIN, HIT_REQUIRED,
  BIG_DROP_MAX_TIMES,
  buildReverseLeaderPool,
} = require('./reverseLeaderPool');

// ============================================================
// 情绪游资-反向抱团龙头（reverseLeaderMode: true，2026-10-17 用户新增；独立引擎）
//   信号指数 = 上证指数（sh000001）3 日线斜率（MA3 − 5 个交易日前的 MA3），逐日按收盘口径判定正负。
//   买点前置 = 上证 3 日线斜率连续为负且进入第 3 天及以后（转负当日为第 1 天，即 daysSinceTurnNeg >= 2）。
//   选股（候选池）= 过去 20 个交易日（不含当日）内出现过连板（连板数 >= 2）的个股（剔除 ST 等黑名单）；
//        并叠加动量过滤——过去 20 个交易日（不含当日）内滑动「连续 10 个交易日」子窗口，
//        子窗口区间最大涨幅 = (窗口最高收盘价 − 窗口最低收盘价) ÷ 窗口最低收盘价 × 100，
//        取各子窗口的最大值须 >= 60%（子窗口缺日K数据视为不达标）。
//   买点（盘中逐桶实时）= 在某交易日「上证指数当日跌幅 >= 0.5%（较昨收 <= -0.5%，按该桶分时价实时判定）」时，
//        对候选股逐桶计算盘中强度分：某候选股当日盘中强度分首次 > 50 即计作一次命中（同一天同一只股票只计一次）；
//        每只候选股各自独立累计，累计到第 2 次命中（即「第二次当日强度分 > 50」）的那一刻按该分钟分时价买入；
//        若该刻该股已涨停（主板 > 9.5%、创业/科创 > 19%）则不买，继续等待下一个符合条件交易日再买；
//        命中计数只在当前这一段负斜率窗口内累计（窗口标识 = 最近一次由正转负日），窗口变化（斜率由负转正后再次转负）即清零。
//   卖点 = 沿用「情绪游资-龙头战法」全部卖点（价格类卖点分钟级回溯，成本线止损 -5% 且连续 >= 5 分钟），
//        并新增「上证指数 3 日线斜率盘中由负转正（前一交易日收盘斜率 <= 0、当桶实时斜率 > 0）」卖出；任一先触发即卖。
//   仓位 = 全仓单持仓（权重 1），收益率不做半仓折算。
// ============================================================

// 选股/择时常量（LOOKBACK_DAYS / MIN_BOARD_COUNT / RANGE_WINDOW_DAYS / RANGE_SLIDE_DAYS /
// MIN_WINDOW_RANGE_PCT / NEG_STREAK_MIN_DAYS / INDEX_DROP_PCT / STRENGTH_MIN / HIT_REQUIRED）
// 与候选池构建函数 buildReverseLeaderPool 见 ./reverseLeaderPool（与「情绪游资-极致胜率」逆周期腿共用）

const WEAK_TRADE_HOLD_DAYS = 3;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const TAIL_MINUTE = 1457;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001'; // 抗分歧/涨停口径统一跟踪上证指数（与龙头战法一致）

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};

// 上证指数「前一交易日收盘口径」3 日线斜率（用于判定「盘中由负转正」的基准），数据不足返回 null
const getPrevCloseSlope = async (dateStr) => {
  try {
    const { dates, slopes } = await ensureIndexMa3SlopeSeries(ICE_SIGNAL_INDEX_CODE);
    const target = Number(dateStr);
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] < target) { const s = slopes.get(dates[i]); return s != null ? Number(s) : null; }
    }
    return null;
  } catch (e) {
    return null;
  }
};

const runReverseLeaderBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.reverseLeaderMode !== true) {
    return { success: false, message: `未知情绪游资-反向抱团龙头策略: ${strategyId}` };
  }

  // 不依赖资金快照：日期序列并入 tech_index 覆盖的交易日（与龙头战法引擎同口径）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // 预计算上证 3 日线斜率收盘口径 + 历史「由正转负 / 由负转正」事件（供判定负斜率连续天数）
  let turnMap = new Map();
  try {
    turnMap = await precomputeTurnMap(ICE_SIGNAL_INDEX_CODE, rangeDates.map(Number));
  } catch (e) {
    turnMap = new Map();
  }

  // 启动预拉取：扫描整个回测区间每个交易日可能出现的候选股，一次性拉取日K（供动量过滤 / 持仓估值使用）
  try {
    const presetAll = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      for (const s of stocks) presetAll.add(s.code);
    }
    if (presetAll.size > 0) await ensureBarsForCodes(presetAll);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  let position = null;                 // 全仓单持仓
  let soldThisDate = false;            // 当日卖出后当日不再追买
  const hitCount = new Map();          // code -> 命中次数（同一天同一只只计一次，上限 2）
  let windowKey = null;                // 当前负斜率窗口标识（最近一次由正转负日）；窗口变化即清零命中计数

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

    // 上证 3 日线斜率连续为负天数（收盘口径）
    const tInfo = turnMap.get(Number(dateStr));
    const slopeClose = tInfo ? tInfo.slopeClose : null;
    const daysSinceTurnNeg = tInfo ? tInfo.daysSinceTurnNeg : null;
    const curWindowKey = tInfo ? tInfo.turnNegDate : null;
    if (curWindowKey !== windowKey) { hitCount.clear(); windowKey = curWindowKey; }
    // 买点前置：斜率 < 0 且已进入连续为负的第 3 天及以后
    const eligible = slopeClose != null && slopeClose < 0
      && daysSinceTurnNeg != null && daysSinceTurnNeg >= NEG_STREAK_MIN_DAYS;
    soldThisDate = false;

    // 候选池（仅在可用日构建；连板名单 + 题材黑名单 + 动量过滤）
    // 构建实现与「情绪游资-极致胜率」逆周期腿共用 ./reverseLeaderPool.buildReverseLeaderPool
    let candidatesRaw = [];
    let poolFilterText = '';
    if (eligible) {
      try {
        const pool = await buildReverseLeaderPool(dateStr, null, { bigDropMaxTimes: BIG_DROP_MAX_TIMES });
        candidatesRaw = pool.stocks || [];
        poolFilterText = pool.poolFilterText || '';
      } catch (e) { candidatesRaw = []; poolFilterText = ''; }
    }
    if (candidatesRaw.length > 0) {
      for (const s of candidatesRaw) {
        s.poolFilterText = poolFilterText;
        if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
      }
    }

    // 每日分时缓存重建，控制内存
    clearTlineCache();

    // 隔夜持仓当日分时（卖点用）+ 当日收盘抗分歧指数（卖点⑥用；懒计算）
    const posTline = (position && dateStr > position.buyDate) ? await loadTlinePoints(position.code, dateNum) : null;
    let prevCloseSlope = null;
    if (posTline) prevCloseSlope = await getPrevCloseSlope(dateStr);
    let posResilience = null;
    let posResilienceLoaded = false;
    const ensurePosResilience = async () => {
      if (posResilienceLoaded) return posResilience;
      posResilienceLoaded = true;
      if (!position) return null;
      try {
        const [stockT, indexT] = await Promise.all([
          getSingleStockTlineDataByDate(position.code, dateNum),
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
          const r = calculateReplayResilience(stockLine, indexLine, position.code);
          if (r != null && Number.isFinite(Number(r))) posResilience = round2(r);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResilience;
    };

    // 候选池数据（懒加载：仅当可用日且需评估强度分时构建）
    let poolReady = false;
    const todayTline = new Map();   // code -> { preclose, points }
    const idxTlineMap = new Map();  // idxCode -> { preclose, points }
    const ensurePoolData = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidatesRaw.length === 0) return;
      await batchParallel(candidatesRaw, async (c) => {
        try { todayTline.set(c.code, await loadTlinePoints(c.code, dateNum)); } catch (e) { todayTline.set(c.code, { preclose: null, points: [] }); }
      }, 8);
      await Promise.all(['sh000001', 'sz399006', 'sh000688'].map(async (ic) => {
        try { const r = await loadTlinePoints(ic, dateNum); idxTlineMap.set(ic, r); } catch (e) { idxTlineMap.set(ic, { preclose: null, points: [] }); }
      }));
    };
    // 上证指数截至某桶的当日跌幅（较昨收 %）；数据不足返回 null
    const idxChangeAt = (minute) => {
      const t = idxTlineMap.get(ICE_SIGNAL_INDEX_CODE);
      if (!t || !(t.preclose > 0) || t.points.length === 0) return null;
      const atPt = priceAtMinute(t.points, minute);
      if (!atPt || !(atPt.lastPx > 0)) return null;
      return ((atPt.lastPx - t.preclose) / t.preclose) * 100;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    const dayTriggered = new Set(); // 当日已登记命中的候选（同一天同一只只计一次）

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);

      // ===== 卖出（隔夜持仓；沿用龙头战法全部卖点 + 新增「上证斜率盘中由负转正」卖点）=====
      if (position && posTline && posTline.points.length > 0 && dateStr > position.buyDate) {
        const atPt = priceAtMinute(posTline.points, bucketMinute);
        if (atPt && atPt.lastPx > 0) {
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

          // 价格类卖点（⑤竞价低开 / ①成本线止损 -5% 且连续 ≥5 分钟 / ②跌停 / ⑦昨收跌幅 / ⑧开盘跌幅 / ③高位大阴线）：
          // 分钟级回溯——自 9:30 起逐分钟扫描分时，取「最先触发」的那一分钟精准卖出
          // 2026-10-17 用户要求：本策略**不使用「1 分钟内跳水」卖点**（disableMinutePlummet: true）
          const priceHit = scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
            disableMinutePlummet: true,
          });
          if (priceHit) {
            sellReason = priceHit.reason;
            sellMinute = priceHit.minute;
            sellPx = priceHit.px;
            sellChange = priceHit.changePct;
          }
          // 新增卖点：上证指数 3 日线斜率盘中由负转正（前一交易日收盘斜率 <= 0、当桶实时斜率 > 0）
          if (!sellReason) {
            const intradaySlope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
            if (intradaySlope != null && Number.isFinite(Number(intradaySlope))
              && prevCloseSlope != null && prevCloseSlope <= 0 && Number(intradaySlope) > 0) {
              sellReason = `上证指数 3 日线斜率盘中由负转正（前一交易日收盘 ${fmtKeyBlockSlope(prevCloseSlope)} → 当桶实时 ${fmtKeyBlockSlope(intradaySlope)}）`;
            }
          }
          // ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10%
          if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
            if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
              sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
            }
          }
          // ⑥ 收盘抗分歧指数 < 6
          if (!sellReason && isTailBucket) {
            const res = await ensurePosResilience();
            if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
              sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
            }
          }

          if (sellReason) {
            const rawReturnRate = position.buyPrice > 0
              ? round2(((sellPx - position.buyPrice) / position.buyPrice) * 100)
              : null;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              board: position.board,
              positionMode: 'offense',
              weight: 1,
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
              sellReason: `${sellReason}，情绪游资-反向抱团龙头（全仓）卖出`,
              returnRate: rawReturnRate,
              rawReturnRate,
            });
            position = null;
            soldThisDate = true;
          }
        }
      }

      // ===== 买入（全仓单持仓；命中计数逐股独立累计，达标后按分时价买入）=====
      if (eligible && candidatesRaw.length > 0) {
        await ensurePoolData();
        const idxChg = idxChangeAt(bucketMinute);
        // 买点前置：当日上证跌幅 >= 0.5%（较昨收 <= -0.5%）
        if (idxChg != null && idxChg <= INDEX_DROP_PCT) {
          for (const c of candidatesRaw) {
            if (dayTriggered.has(c.code)) continue;
            const t = todayTline.get(c.code);
            if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
            const s = strengthAtMinute(t, bucketMinute, c.code, (idxTlineMap.get(iceResilienceIndexCode(c.code)) || {}).points || []);
            if (!s || !(s.score > STRENGTH_MIN)) continue;
            // 首次 > 50 → 登记当日命中（同一天同一只股票只计一次）
            dayTriggered.add(c.code);
            const prev = hitCount.get(c.code) || 0;
            const next = Math.min(prev + 1, HIT_REQUIRED);
            hitCount.set(c.code, next);
            // 第 2 次命中（或已达标后再次命中）的这一刻为买点；若已涨停则不买，等下一个符合条件的交易日
            if (prev >= 1 && position === null && !soldThisDate && !s.limitUp) {
              position = buildPosition({
                pick: c, s, score: s.score, px: s.px, changePct: s.changePct,
                dateStr, dateDisplay, timeText, hitCount: next,
                slopeClose, daysSinceTurnNeg, idxChg,
              });
              position.buyDi = di;
            }
          }
        }
      }
    }
  }

  // 组装结果（type:'single'：全仓单持仓，逐笔复利）
  let holding = null;
  if (position) {
    holding = { ...position, weight: 1 };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
    if (closePx != null && closePx > 0 && position.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - position.buyPrice) / position.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn) : null;
  }
  let acc = 1;
  for (const t of trades) {
    if (t.rawReturnRate != null && Number.isFinite(Number(t.rawReturnRate))) acc *= 1 + Number(t.rawReturnRate) / 100;
  }
  if (holding && holding.rawBuyReturn != null && Number.isFinite(Number(holding.rawBuyReturn))) {
    acc *= 1 + Number(holding.rawBuyReturn) / 100;
  }
  const overallReturn = round2((acc - 1) * 100);
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (holding) await attachBuyDayReturn([holding]);
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: position != null,
    },
  };
};

// 构建持仓对象（含买入原因与命中/强度分诊断明细；全仓单持仓，权重 1）
const buildPosition = ({ pick, s, score, px, changePct, dateStr, dateDisplay, timeText, hitCount, slopeClose, daysSinceTurnNeg, idxChg }) => {
  const chgText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const buyReason = `${timeText} 上证指数 3 日线斜率连续为负第 ${daysSinceTurnNeg + 1} 天（斜率 ${fmtKeyBlockSlope(slopeClose)}），当日上证跌幅 ${chgText(idxChg)} ≤ ${INDEX_DROP_PCT}%，候选 ${pick.name}（${pick.code}，${pick.lianbanCount} 连板）盘中强度分第 ${hitCount} 次 > ${STRENGTH_MIN}（本次强度分 ${score}），按该分钟分时价 ${px.toFixed(2)} 买入（全仓）`;
  const checks = [
    {
      id: 'reverse_leader_pool',
      title: `选股（过去 ${LOOKBACK_DAYS} 个交易日出现过连板数 ≥ ${MIN_BOARD_COUNT} 的个股；过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 ≥ ${MIN_WINDOW_RANGE_PCT}%）`,
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板`,
      reason: `候选 = 过去 ${LOOKBACK_DAYS} 个交易日内出现过连板数 ≥ ${MIN_BOARD_COUNT} 的个股（命中日 ${pick.date}，板块 ${pick.board || '--'}）；已剔除 ST 等黑名单与题材黑名单（${EXCLUDED_THEMES.join('/')}）；并叠加动量过滤——过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内滑动「连续 ${RANGE_SLIDE_DAYS} 个交易日」子窗口区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 ≥ ${MIN_WINDOW_RANGE_PCT}%${pick.poolFilterText || ''}`,
    },
    {
      id: 'reverse_leader_index_neg',
      title: `买点前置：上证指数 3 日线斜率连续为负第 3 天及以后（转负当日为第 1 天）`,
      passed: true,
      value: `斜率 ${fmtKeyBlockSlope(slopeClose)}（连续为负第 ${daysSinceTurnNeg + 1} 天，≥ 第 ${NEG_STREAK_MIN_DAYS + 1} 天）`,
      reason: `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线斜率收盘口径 ${fmtKeyBlockSlope(slopeClose)} < 0，且已进入连续为负的第 ${daysSinceTurnNeg + 1} 天（转负当日算第 1 天，满足 ≥ ${NEG_STREAK_MIN_DAYS + 1} 天）`,
    },
    {
      id: 'reverse_leader_index_drop',
      title: `买点前置：当日上证跌幅 ≥ 0.5%（较昨收 ≤ ${INDEX_DROP_PCT}%）`,
      passed: true,
      value: `上证当日跌幅 ${chgText(idxChg)} ≤ ${INDEX_DROP_PCT}%`,
      reason: `买入时点上证指数较昨收跌幅 ${chgText(idxChg)}，达到 ≤ ${INDEX_DROP_PCT}% 门槛（按该桶指数分时价实时判定），符合「大盘走弱」的逆势低吸条件`,
    },
    {
      id: 'reverse_leader_strength',
      title: `买点判定：盘中强度分第 2 次 > ${STRENGTH_MIN}（本次为第 ${hitCount} 次命中）`,
      passed: true,
      value: `A 竞价高开 ${s.aRaw}%（分 ${s.aScore}）· B 分钟最大涨幅 ${s.bRaw}%（分 ${s.bScore}）${s.isOneWord ? '（一字板）' : ''} · C 抗分歧 ${s.cRaw}（分 ${s.cScore}）· D 当日涨幅 ${s.dRaw}%（分 ${s.dScore}）`,
      reason: `强度分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${s.aScore} + 0.2×${s.bScore} + 0.3×${s.cScore} + 0.2×${s.dScore} = ${score} > ${STRENGTH_MIN}（A 上限 ${STRENGTH_A_MAX}%、B 上限 ${STRENGTH_B_MAX}%、C 上限 ${STRENGTH_C_MAX}%、D 上限 ${STRENGTH_D_MAX}%；与「情绪游资-极致胜率」口径一致）；本股累计第 ${hitCount} 次命中（需达 ${HIT_REQUIRED} 次），命中计数逐股独立累计、同一交易日同一只只计一次；时点价 ${px.toFixed(2)}（昨收 ${s.preclose}，现价涨幅 ${chgText(changePct)}）`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name,
    mode: 'offense',
    board: pick.board,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: timeText,
    buyPrice: round2(px),
    buyChange: round2(changePct),
    metric: score,
    weight: 1,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runReverseLeaderBacktest };
