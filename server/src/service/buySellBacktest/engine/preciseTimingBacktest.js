const { STRATEGIES } = require('../strategies/registry');
const { runLeaderBacktest } = require('./leaderBacktest');
const {
  batchParallel,
  getPastTradingDates,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTopLianbanBoardStocks,
  getTrainingCampDates,
  loadTrainingCampData,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { ICE_SIGNAL_INDEX_CODE, ICE_SIGNAL_INDEX_NAME, ensureIndexMa3SlopeSeries } = require('./indexGate');
const { EXCLUDED_CODES } = require('../constants');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');

// ============================================================
// 情绪游资-精准择时（preciseTiming: true，2026-10-16 用户新增；独立引擎）
//   账户拆两份，各 5 成仓位（权重 0.5），两份仓位各自独立买卖、独立计收益：
//   仓位 A（5 成）= 完全按「情绪游资-龙头战法」执行——直接复用 runLeaderBacktest（weight 覆盖为 0.5）；
//   仓位 B（5 成）= 与 A 择时错开的日内打板——
//     买点 = 上证指数 3 日线斜率「前一交易日收盘口径由负转正」的当日（斜率转正事件日），
//            候选池 = 上一交易日（lianbanSnapshot）涨停个股数 top2 板块的全部成分股，
//            盘中分时逐桶扫描（仅上午 ≤ 11:30），谁最先涨到 +8% 就买谁（按触发桶分时价成交，同桶取涨幅最高者）；
//            一字板（开盘价即达涨停阈值）顺延下一只；下午不再交易（上午未成交则本次买点作废）；
//     卖点 = 完全沿用「情绪游资-龙头战法」的 8 条卖点（价格类卖点按分钟级回溯，取最先触发分钟精准卖出）；
//   整体收益率按真实两子账户口径：资金一分为二，各半独立复利后相加（0.5×F_A + 0.5×F_B − 1）。
// ============================================================

const LEG_WEIGHT = 0.5;             // 每份仓位 5 成
const TOP_BOARDS = 2;               // 候选池：上一交易日涨停数前二板块
const SURGE_PCT = 8;                // 打板阈值：分时涨幅达到 +8% 即买入
const MORNING_END_MINUTE = 1130;    // 只在上午打板（时间桶 minute ≤ 1130）
const MAIN_BOARD_LIMIT_UP_PCT = 9.5;   // 主板涨停阈值
const NON_MAIN_LIMIT_UP_PCT = 19.5;    // 创业板/科创板涨停阈值

// 价格类卖点门槛（止损/跌停/昨收跌幅/开盘跌幅/高位回落/竞价低开）统一由 ./leaderSellMinute 持有
const WEAK_TRADE_HOLD_DAYS = 3;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const TAIL_MINUTE = 1457;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001';

const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : parseFloat(Number(v).toFixed(2)));
const fmtDay = (d) => { const s = String(d); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s; };
const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};
// 创业板（30）/科创板（688）：2026-10-16 用户要求「所有创业板和科创板的都干掉」，候选池一律剔除
const isChiNextOrStar = (code) => /^(30|688)/.test(String(code).replace(/^(sh|sz|bj)/i, ''));
// 涨停阈值：创业板（30）/科创板（688）为 20%，其余（主板）为 10%
const limitUpPctOf = (code) => (isChiNextOrStar(code) ? NON_MAIN_LIMIT_UP_PCT : MAIN_BOARD_LIMIT_UP_PCT);
const isSTName = (name) => /ST|\*ST/i.test(String(name || ''));

// 个股分时点缓存：`${code}|${dateNum}` -> { preclose, points:[{minute,lastPx,change}] }
// 每个交易日开始前清空，避免整轮回测累积占用内存
const tlineCache = new Map();
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
        .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : null }))
        .filter(p => p.lastPx > 0)
        .sort((a, b) => a.minute - b.minute),
    };
  } catch (e) { /* 拉取失败返回空 */ }
  tlineCache.set(key, res);
  return res;
};

// 分时点的实时涨幅（优先取 tline 的 change，缺失时按昨收现算）
const changeOf = (p, preclose) => {
  if (p.change != null && Number.isFinite(p.change)) return p.change;
  if (preclose != null && preclose > 0) return ((p.lastPx - preclose) / preclose) * 100;
  return null;
};

// 仓位B 单只候选：扫描上午分时，返回「最先涨到 +8%」的触发信息（一字板/涨停不可买标记）
const scanSurge = (points, preclose, code) => {
  if (!points || points.length === 0 || !(preclose > 0)) return null;
  const limitPct = limitUpPctOf(code);
  const openPt = points[0];
  const openCh = changeOf(openPt, preclose);
  // 一字板：开盘（首个分时点）即已达涨停阈值 → 顺延下一只
  if (openCh != null && openCh >= limitPct) return { oneWord: true };
  for (const p of points) {
    if (p.minute > MORNING_END_MINUTE) break;
    const ch = changeOf(p, preclose);
    if (ch == null) continue;
    if (ch >= SURGE_PCT) {
      return {
        minute: p.minute,
        change: round2(ch),
        px: p.lastPx,
        // 触发时点已达涨停阈值 → 买不进，按顺延处理
        atLimit: ch >= limitPct,
      };
    }
  }
  return null;
};

// 组装仓位B 持仓对象
const buildBPosition = ({ pick, dateStr, dateDisplay, timeText, poolCount, boardsText, prevDate }) => {
  const limitText = `${pick.change > 0 ? '+' : ''}${pick.change}%`;
  const buyReason = `${timeText} ${ICE_SIGNAL_INDEX_NAME} 3 日线斜率前一交易日收盘口径由负转正（${prevDate}），上午打板买入最先涨到 +${SURGE_PCT}% 的 ${pick.name}（${pick.code}），触发时点价 ${pick.px.toFixed(2)}（实时涨幅 ${limitText}）`;
  const checks = [
    {
      id: 'precise_timing_slope',
      title: `${ICE_SIGNAL_INDEX_NAME} 3 日线斜率前一交易日收盘口径由负转正`,
      passed: true,
      value: `前一日收盘口径斜率 ${pick.slopePrev > 0 ? '+' : ''}${Number(pick.slopePrev).toFixed(2)}（更前一交易日 ${pick.slopePrevPrev > 0 ? '+' : ''}${Number(pick.slopePrevPrev).toFixed(2)}）`,
      reason: '买点 = 斜率在前一交易日收盘时「由负转正」，与仓位 A（盘中由负转正）择时错开，在转正事件当日出手',
    },
    {
      id: 'precise_timing_pool',
      title: `候选池 = 上一交易日（${prevDate}）涨停个股数前 ${TOP_BOARDS} 板块的全部成分股`,
      passed: true,
      value: boardsText,
      reason: `上一交易日涨停数前 ${TOP_BOARDS} 的板块：${boardsText}（去重、剔除 ST、黑名单与创业板/科创板后合计 ${poolCount} 只）`,
    },
    {
      id: 'precise_timing_surge',
      title: `上午盘中分时最先涨到 +${SURGE_PCT}%（打板）`,
      passed: true,
      value: `${pick.name}（${pick.code}）${fmtMinute(pick.minute)} 达 ${limitText}`,
      reason: `仅在上午（≤ ${fmtMinute(MORNING_END_MINUTE)}）逐桶监控候选池分时，最先触及 +${SURGE_PCT}% 者买入（相当于打板）；一字板（开盘即涨停）顺延下一只，触发时点已涨停者亦顺延；下午不再交易`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name,
    mode: 'offense',
    board: pick.board,
    splitLeg: 'B',
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: timeText,
    buyPrice: round2(pick.px),
    buyChange: round2(pick.change),
    metric: round2(pick.change),
    weight: LEG_WEIGHT,
    buyReason,
    buyChecks: checks,
  };
};

const runPreciseTimingBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.preciseTiming !== true) {
    return { success: false, message: `未知情绪游资-精准择时策略: ${strategyId}` };
  }

  // 与 A/B 引擎一致的日期序列（并入 tech_index 覆盖的交易日，补上缺资金快照的日期）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  // ===== 仓位 A（5 成）：完全复用「情绪游资-龙头战法」引擎，权重覆盖为 0.5 =====
  const aRes = await runLeaderBacktest(startDate, endDate, 'hot_money_leader', onProgress
    ? (p) => onProgress({ ...p, current: Math.round((p.current || 0) / 2), status: p.status })
    : null, { weight: LEG_WEIGHT });
  if (!aRes || aRes.success === false) return aRes || { success: false, message: '仓位A（龙头战法）回测失败' };

  const aTrades = aRes.trades || [];
  const aHolding = aRes.currentHolding || null;

  // ===== 仓位 B（5 成）：斜率前一交易日收盘口径由负转正 → 当日上午打板 =====
  // 上证指数 3 日线斜率序列（收盘口径）一次预计算，供「转正事件」判定复用
  let slopeSeries = null;
  try { slopeSeries = await ensureIndexMa3SlopeSeries(ICE_SIGNAL_INDEX_CODE); } catch (e) { slopeSeries = null; }
  const slopeDates = slopeSeries?.dates || [];
  const slopeMap = slopeSeries?.slopes || new Map();

  const seenStocks = new Map();
  for (const s of (aRes.seenStocks || [])) seenStocks.set(s.code, s);
  const bTrades = [];
  let bPosition = null;      // 仓位B 单持仓
  let lastBSellDate = null;  // 卖出当日不再追买

  const halfTotal = total;
  if (onProgress) onProgress({ current: Math.round(halfTotal / 2), total: halfTotal, date: '', status: 'loading' });

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: Math.round(halfTotal / 2 + (di + 1) / 2), total: halfTotal, date: dateStr, status: 'running' });
    const dateNum = parseInt(dateStr, 10);

    // 当日分时缓存重建，控制内存
    tlineCache.clear();

    // 上一交易日（候选池来源 + 斜率转正事件判定）
    let prevDates = [];
    try { prevDates = await getPastTradingDates(dateStr, 2); } catch (e) { prevDates = []; }
    const prevDate = prevDates.length > 0 ? Number(prevDates[prevDates.length - 1]) : null;

    // 转正事件：prevDate 收盘斜率 > 0 且其更前一交易日（prevPrevDate）收盘斜率 ≤ 0
    let slopePrev = null, slopePrevPrev = null;
    if (prevDate != null) {
      slopePrev = slopeMap.get(prevDate) ?? null;
      if (slopePrev == null) {
        for (let i = slopeDates.length - 1; i >= 0; i--) { if (slopeDates[i] <= prevDate) { slopePrev = slopeMap.get(slopeDates[i]) ?? null; break; } }
      }
      let prevPrevDate = prevDates.length >= 2 ? Number(prevDates[0]) : null;
      if (prevPrevDate == null) {
        try { const p = await getPastTradingDates(String(prevDate), 1); prevPrevDate = p.length > 0 ? Number(p[0]) : null; } catch (e) { prevPrevDate = null; }
      }
      if (prevPrevDate != null) {
        slopePrevPrev = slopeMap.get(prevPrevDate) ?? null;
        if (slopePrevPrev == null) {
          for (let i = slopeDates.length - 1; i >= 0; i--) { if (slopeDates[i] <= prevPrevDate) { slopePrevPrev = slopeMap.get(slopeDates[i]) ?? null; break; } }
        }
      }
    }
    const turnedPositive = slopePrev != null && slopePrevPrev != null && slopePrev > 0 && slopePrevPrev <= 0;

    // 隔夜持仓当日分时（卖点用）
    let bPosTline = null;
    if (bPosition && dateStr > bPosition.buyDate) {
      bPosTline = await loadTlinePoints(bPosition.code, dateNum);
    }
    // 持仓股当日收盘抗分歧指数（卖点⑥用；懒计算）
    let bResilience = null, bResilienceLoaded = false;
    let idxPointsCache = null;
    const ensureBResilience = async () => {
      if (bResilienceLoaded) return bResilience;
      bResilienceLoaded = true;
      if (!bPosition) return null;
      try {
        if (idxPointsCache == null) {
          const indexT = await getSingleStockTlineDataByDate(LEADER_RESILIENCE_INDEX_CODE, dateNum);
          idxPointsCache = (indexT?.line || [])
            .filter(p => p && p.minute != null && p.last_px != null)
            .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
            .filter(p => p.lastPx > 0);
        }
        const stockLine = (bPosTline?.points || []).map(p => ({ minute: p.minute, lastPx: p.lastPx, change: p.change != null ? p.change : 0 }));
        if (stockLine.length >= 5 && idxPointsCache.length >= 5) {
          const s = calculateReplayResilience(stockLine, idxPointsCache, bPosition.code);
          if (s != null && Number.isFinite(Number(s))) bResilience = round2(s);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return bResilience;
    };

    // ===== 仓位B 买入：仅当「斜率转正事件日」且空仓且当日未卖出过，上午逐桶扫描打板 =====
    if (turnedPositive && !bPosition && dateStr !== lastBSellDate && prevDate != null) {
      let poolRaw = [];
      try { poolRaw = getTopLianbanBoardStocks(String(prevDate), TOP_BOARDS) || []; } catch (e) { poolRaw = []; }
      // 去重 + 剔除黑名单/ST
      const seen = new Set();
      const pool = [];
      let boardsText = '';
      for (const s of poolRaw) {
        if (!s || !s.code || seen.has(s.code)) continue;
        seen.add(s.code);
        if (EXCLUDED_CODES.has(s.code)) continue;
        if (isSTName(s.name)) continue;
        if (isChiNextOrStar(s.code)) continue; // 剔除创业板/科创板
        pool.push(s);
      }
      if (pool.length === 0) boardsText = '无可交易成分股';
      if (pool.length > 0) {
        for (const s of pool) if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });

        // 逐候选扫描上午分时，找「最先涨到 +8%」且可买入者
        const scanned = [];
        await batchParallel(pool, async (s) => {
          try {
            const t = await loadTlinePoints(s.code, dateNum);
            const r = scanSurge(t.points, t.preclose, s.code);
            if (!r || r.oneWord || r.atLimit) return; // 一字板 / 触发即涨停 → 顺延
            scanned.push({ code: s.code, name: s.name || s.code, minute: r.minute, change: r.change, px: r.px });
          } catch (e) { /* 单只失败跳过 */ }
        }, 8);

        if (scanned.length > 0) {
          // 最先到达者优先；同桶并列取涨幅最高者
          scanned.sort((a, b) => (a.minute - b.minute) || (b.change - a.change));
          const pick = scanned[0];
          const poolCount = pool.length;
          boardsText = `上一交易日涨停数前 ${TOP_BOARDS} 板块共 ${poolCount} 只（去重后）`;
          const timeText = fmtMinute(pick.minute);
          bPosition = buildBPosition({ pick: { ...pick, slopePrev, slopePrevPrev }, dateStr, dateDisplay: fmtDay(dateStr), timeText, poolCount, boardsText, prevDate: String(prevDate) });
          bPosition.buyDi = di; // 持仓第 3 个交易日卖点④的计数基准
        }
      }
    }

    // ===== 逐桶循环：仓位B 卖出（隔夜持仓，沿用龙头战法 8 条卖点；价格类卖点分钟级回溯）=====
    let campData = null;
    try { campData = await loadTrainingCampData(dateStr, { allowMissingFund: true }); } catch (e) { campData = null; }
    const timeBuckets = (campData && campData.success !== false) ? (campData.timeBuckets || []) : [];
    if (timeBuckets.length > 0) {
      const dateDisplay = campData.dateDisplay || dateStr;
      const hasTailBucket = timeBuckets.some(b => Number(b.minute) >= TAIL_MINUTE);
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const bucketMinute = Number(bucket.minute);
        const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
        if (!bPosition || !(dateStr > bPosition.buyDate) || !bPosTline || bPosTline.points.length === 0) continue;

        const atPt = priceAtMinute(bPosTline.points, bucketMinute);
        if (!atPt || !(atPt.lastPx > 0)) continue;
        const px = atPt.lastPx;
        const preclose = bPosTline.preclose;
        const changePct = preclose && preclose > 0 ? round2(((px - preclose) / preclose) * 100) : round2(changeOf(atPt, preclose));
        const costReturn = bPosition.buyPrice > 0 ? round2(((px - bPosition.buyPrice) / bPosition.buyPrice) * 100) : null;

        let sellReason = null;
        let sellMinute = atPt.minute; // 默认按当前桶时点成交（④⑥属尾盘时点卖点）
        let sellPx = px;
        let sellChange = changePct;

        // 价格类卖点（⑤竞价低开 / ①成本线止损 / ②跌停 / ⑦昨收跌幅 / ⑧开盘跌幅 / ③高位大阴线）：
        // 分钟级回溯——自 9:30 起逐分钟扫描分时，取「最先触发」的那一分钟精准卖出
        const priceHit = scanLeaderPriceSell({
          points: bPosTline.points,
          preclose,
          buyPrice: bPosition.buyPrice,
          cutoffMinute: bucketMinute,
        });
        if (priceHit) {
          sellReason = priceHit.reason;
          sellMinute = priceHit.minute;
          sellPx = priceHit.px;
          sellChange = priceHit.changePct;
        }
        // ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10%
        if (!sellReason && bPosition.buyDi != null && (di - bPosition.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
          if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
            sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${bPosition.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
          }
        }
        // ⑥ 收盘抗分歧指数 < 6
        if (!sellReason && isTailBucket) {
          const res = await ensureBResilience();
          if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
            sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
          }
        }

        if (sellReason) {
          const rawReturnRate = bPosition.buyPrice > 0 ? round2(((sellPx - bPosition.buyPrice) / bPosition.buyPrice) * 100) : null;
          bTrades.push({
            metric: bPosition.metric,
            code: bPosition.code,
            stockName: bPosition.stockName,
            board: bPosition.board,
            positionMode: 'offense',
            splitLeg: 'B',
            weight: LEG_WEIGHT,
            buyDate: bPosition.buyDate,
            buyDateDisplay: bPosition.buyDateDisplay,
            buyTime: bPosition.buyTime,
            buyPrice: bPosition.buyPrice,
            buyChange: bPosition.buyChange,
            buyReason: bPosition.buyReason,
            buyChecks: bPosition.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: fmtMinute(sellMinute),
            sellPrice: round2(sellPx),
            sellChange,
            sellReason: `${sellReason}，情绪游资-精准择时·仓位B（半仓）卖出`,
            returnRate: rawReturnRate != null ? round2(rawReturnRate * LEG_WEIGHT) : null,
            rawReturnRate,
          });
          bPosition = null;
          lastBSellDate = dateStr;
        }
      }
    }
  }

  // ===== 合并两仓位轨迹 =====
  const trades = sortTradesByBuyTime([...aTrades, ...bTrades]).map((t, i) => ({ ...t, seq: i + 1 }));

  // 期末持仓：A 的 currentHolding + B 的当前持仓（各半仓）
  const currentHoldings = [];
  if (aHolding) currentHoldings.push(aHolding);
  if (bPosition) {
    const holding = { ...bPosition, weight: LEG_WEIGHT };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(bPosition.code, rangeDates[rangeDates.length - 1]);
    if (closePx != null && closePx > 0 && bPosition.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - bPosition.buyPrice) / bPosition.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn * LEG_WEIGHT) : null;
    currentHoldings.push(holding);
  }

  // 整体收益率（真实两子账户口径）：资金一分为二，各半独立复利后相加
  const factorOf = (ts, holding) => {
    let f = 1;
    for (const t of ts) if (t.rawReturnRate != null && Number.isFinite(Number(t.rawReturnRate))) f *= 1 + Number(t.rawReturnRate) / 100;
    if (holding && holding.rawBuyReturn != null && Number.isFinite(Number(holding.rawBuyReturn))) f *= 1 + Number(holding.rawBuyReturn) / 100;
    return f;
  };
  const fA = factorOf(aTrades, aHolding);
  const fB = factorOf(bTrades, bPosition);
  const overallReturn = round2((LEG_WEIGHT * fA + LEG_WEIGHT * fB - 1) * 100);

  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (currentHoldings.length > 0) await attachBuyDayReturn(currentHoldings);

  // skippedDates：A、B 两引擎并集（A 的日期覆盖范围更广且两者同源，取 A 的即可）
  const skippedDates = aRes.skippedDates || [];

  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHoldings,
    currentHolding: currentHoldings.length === 1 ? currentHoldings[0] : null,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: currentHoldings.length > 0,
    },
  };
};

module.exports = { runPreciseTimingBacktest };
