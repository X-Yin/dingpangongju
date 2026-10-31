const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
} = require('../deps');
const { getMultiLianbanStocks } = require('../../keyBlockData');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_CODES } = require('../constants');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { round2, loadTlinePoints, clearTlineCache } = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');
const { runEmotionBurstDriftBacktest } = require('./emotionBurstDriftBacktest');

// ============================================================
// 连板题材-情绪瞬爆-惯性漂移-补涨（emotionBurstFollowMode: true，2026-10-31 用户新增；独立引擎）
//   触发：完整复用「连板题材-情绪瞬爆-惯性漂移-龙头」引擎跑同一区间，记录其真实买入（龙头买点）事件：
//         { 买入日 D、买入分钟、命中题材 B、龙头个股 }；
//   可出手窗口：龙头买点触发日之后的 3 个交易日内（不含触发当日 D，即 D+1 / D+2 / D+3）；
//   选股：题材 B 在触发日 D「爆发的首板股」——即 D 当日连板数为 1（当日首封涨停）且所属题材为 B 的个股，
//         只保留主板（剔除创业板 30/301 与科创板 688，北交所同样剔除）；
//   买点：在上述窗口内逐分钟跟踪这批首板股，任一个股「分时涨幅（较当日昨收）达到 +9% 且未涨停
//         （涨幅 ≥ 9.5% 即视为涨停、买不进）」即可买入，**谁先达到谁先买入**（跨个股取最早可成交分钟，
//         同分钟取涨幅更大者）；半仓单持仓；
//   卖点：与「连板题材-情绪瞬爆-惯性漂移-龙头」完全一致（价格类卖点 + 持仓第 4 个交易日尾盘收益未达 +10%
//         + 当日收盘抗分歧指数 < 6）；注：「收盘未涨停即卖」条件 2026-10-31 已按用户要求移除。
// ============================================================

const FOLLOW_WINDOW_DAYS = 3;      // 龙头买点触发后 3 个交易日内可出手（不含触发当日）
const BUY_TRIGGER_PCT = 9;         // 首板股分时涨幅达到 +9% 即买入
const LIMIT_UP_PCT = 9.5;          // 涨幅 ≥ 9.5% 即视为涨停（买不进，顺延其他候选）
const TAIL_MINUTE = 1457;
const WEAK_TRADE_HOLD_DAYS = 4;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001';
const LEADER_STRATEGY_ID = 'emotion_burst_drift_leader';

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

// 只买主板：剔除创业板（sz30/301）与科创板（sh688），北交所同样不参与
const isMainBoardCode = (code) => !!code && !/^(sz30|sh688|bj)/i.test(code);

const runEmotionBurstFollowBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.emotionBurstFollowMode !== true) {
    return { success: false, message: `未知连板题材-情绪瞬爆-惯性漂移-补涨策略: ${strategyId}` };
  }

  const allDates = Array.from(new Set(getTrainingCampDates()))
    .filter((d) => d >= startDate && d <= endDate)
    .sort();
  const total = allDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // ---- 1) 记录「龙头」买点事件（复用龙头引擎，静默运行）----
  const triggerEvents = [];
  try {
    await runEmotionBurstDriftBacktest(startDate, endDate, LEADER_STRATEGY_ID, null, {
      onLeaderBuy: (evt) => { if (evt && evt.date) triggerEvents.push(evt); },
    });
  } catch (e) { /* 龙头引擎异常时按无触发处理 */ }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map();

  let position = null;
  let soldThisDate = false;

  // 龙头触发日 → 该日该题材的首板股名单（懒加载并按事件缓存）
  const firstBoardMemo = new Map(); // `${date}|${board}` -> [{ code, name }]
  const buildFirstBoardPool = (eventDate, board) => {
    const key = `${eventDate}|${board}`;
    if (firstBoardMemo.has(key)) return firstBoardMemo.get(key);
    let list = [];
    try {
      list = getMultiLianbanStocks(eventDate, 1)
        .filter((s) => s && s.code
          && Number(s.lianbanCount) === 1
          && String(s.board || '') === String(board || '')
          && isMainBoardCode(s.code)
          && !EXCLUDED_CODES.has(s.code))
        .map((s) => ({ code: s.code, name: s.name || s.code }));
    } catch (e) { list = []; }
    firstBoardMemo.set(key, list);
    return list;
  };

  for (let di = 0; di < total; di += 1) {
    const dateStr = allDates[di];
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
    const hasTailBucket = timeBuckets.some((b) => Number(b.minute) >= TAIL_MINUTE);
    soldThisDate = false;

    clearTlineCache();

    // ---- 2) 当日可出手的补涨候选：触发日在最近 3 个交易日内（不含触发当日）----
    const activeCandidates = [];
    const activeEventKeys = new Set();
    for (const evt of triggerEvents) {
      const evtDi = allDates.indexOf(evt.date);
      if (evtDi < 0) continue;
      const gap = di - evtDi;
      if (gap < 1 || gap > FOLLOW_WINDOW_DAYS) continue;
      const key = `${evt.date}|${evt.board}`;
      if (activeEventKeys.has(key)) continue;
      activeEventKeys.add(key);
      for (const s of buildFirstBoardPool(evt.date, evt.board)) {
        activeCandidates.push({ ...s, eventDate: evt.date, eventBoard: evt.board, eventLeader: evt.name, eventMinute: evt.minute });
        if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name });
      }
    }

    // ---- 3) 隔夜持仓卖点数据（与龙头引擎同口径）----
    const posTline = (position && dateStr > position.buyDate) ? await loadTlinePoints(position.code, dateNum) : null;
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
        const toLine = (t) => (t?.line || [])
          .filter((x) => x && x.minute != null && x.last_px != null)
          .map((x) => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter((x) => x.lastPx > 0);
        const stockLine = toLine(stockT);
        const indexLine = toLine(indexT);
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const r = calculateReplayResilience(stockLine, indexLine, position.code);
          if (r != null && Number.isFinite(Number(r))) posResilience = round2(r);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResilience;
    };

    // ---- 4) 补涨候选分时（仅空仓且存在候选时加载一次）----
    let poolReady = false;
    const tlineMap = new Map(); // code -> { preclose, points }
    const ensurePool = async () => {
      if (poolReady) return;
      poolReady = true;
      if (activeCandidates.length === 0) return;
      const codes = Array.from(new Set(activeCandidates.map((c) => c.code)));
      await batchParallel(codes, async (code) => {
        try { tlineMap.set(code, await loadTlinePoints(code, dateNum)); }
        catch (e) { tlineMap.set(code, { preclose: null, points: [] }); }
      }, 8);
    };
    // 每只候选当日「首个可成交的 +9% 分钟」（懒计算，一日一次）
    //   涨幅 ≥ 9.5% 即视为涨停（买不进）：该分钟不计入买点，继续向后寻找炸板后重新回到 9%≤涨幅<9.5% 的分钟；
    //   若全天达到 +9% 时都已 ≥9.5%（整日一字板/封板），则该股当日不可买，顺延到其他候选
    const hitMemo = new Map();
    const openOneWordMemo = new Map(); // code -> { minute, px, chg, atOpen }
    let hitReady = false;
    const computeHits = () => {
      if (hitReady) return;
      hitReady = true;
      for (const c of activeCandidates) {
        const t = tlineMap.get(c.code);
        if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) continue;
        const firstMinute = t.points[0] ? t.points[0].minute : null;
        for (const p of t.points) {
          if (!(p.lastPx > 0)) continue;
          const chg = ((p.lastPx - t.preclose) / t.preclose) * 100;
          if (chg < BUY_TRIGGER_PCT) continue;
          // 买不进：涨幅 ≥ 涨停阈值（9.5% 即视为涨停）——一字板开盘或封板中的分钟均不可成交
          if (chg >= LIMIT_UP_PCT) {
            if (!openOneWordMemo.has(c.code)) {
              openOneWordMemo.set(c.code, { minute: p.minute, px: p.lastPx, chg: round2(chg), atOpen: p.minute === firstMinute });
            }
            continue;
          }
          hitMemo.set(c.code, { minute: p.minute, px: p.lastPx, chg: round2(chg) });
          break;
        }
      }
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    for (let bi = 0; bi < timeBuckets.length; bi += 1) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const atPtOfPos = posTline && posTline.points.length > 0
        ? priceAtMinute(posTline.points, bucketMinute)
        : null;

      // ===== 卖出 =====
      if (position) {
        const sellNow = dateStr > position.buyDate && atPtOfPos && atPtOfPos.lastPx > 0;
        let sellReason = null;
        let sellMinute = bucketMinute;
        let sellPx = sellNow ? atPtOfPos.lastPx : null;
        let sellChange = null;

        if (sellNow) {
          const px = atPtOfPos.lastPx;
          const preclose = posTline.preclose;
          sellChange = preclose && preclose > 0 ? round2(((px - preclose) / preclose) * 100) : (atPtOfPos.change != null ? atPtOfPos.change : null);

          const priceHit = scanLeaderPriceSell({
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
          // 持仓第 4 个交易日尾盘收益仍未拉开至 +10%
          if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
            const costReturn = position.buyPrice > 0
              ? round2(((px - position.buyPrice) / position.buyPrice) * 100)
              : null;
            if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
              sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
            }
          }
          // 当日收盘抗分歧指数 < 6
          if (!sellReason && isTailBucket) {
            const res = await ensurePosResilience();
            if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
              sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
            }
          }
        }

        if (sellReason) {
          const rawReturnRate = position.buyPrice > 0 && sellPx > 0
            ? round2(((sellPx - position.buyPrice) / position.buyPrice) * 100)
            : null;
          trades.push({
            seq: trades.length + 1,
            metric: position.metric,
            code: position.code,
            stockName: position.stockName,
            board: position.board,
            positionMode: 'offense',
            weight: TWO_BUY_LEG_WEIGHT,
            buyDate: position.buyDate,
            buyDateDisplay: position.buyDateDisplay,
            buyTime: position.buyTime,
            buyPrice: position.buyPrice,
            buyChange: position.buyChange,
            buyReason: position.buyReason,
            buyChecks: position.buyChecks,
            triggerInfo: position.triggerInfo,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: fmtMinute(sellMinute),
            sellPrice: round2(sellPx),
            sellChange,
            sellReason: `${sellReason}，连板题材-情绪瞬爆-惯性漂移-补涨（半仓）卖出`,
            returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
            rawReturnRate,
          });
          position = null;
          soldThisDate = true;
        }
      }

      // ===== 买入：窗口内首板股首个达到 +9% 者 =====
      if (!position && !soldThisDate && activeCandidates.length > 0) {
        await ensurePool();
        computeHits();
        let pick = null;
        for (const c of activeCandidates) {
          const hit = hitMemo.get(c.code);
          if (!hit || hit.minute > bucketMinute) continue;
          if (hit.px == null || !(hit.px > 0)) continue;
          if (!pick
            || hit.minute < pick.hit.minute
            || (hit.minute === pick.hit.minute && hit.chg > pick.hit.chg)) {
            pick = { cand: c, hit };
          }
        }
        if (pick) {
          const minute = pick.hit.minute;
          const chg = pick.hit.chg;
          // 一字板开盘不可买的候选（买不进 → 顺延到其他先达到 +9% 者）
          const skippedOneWord = activeCandidates
            .filter((c) => openOneWordMemo.has(c.code) && !hitMemo.has(c.code))
            .map((c) => ({ code: c.code, name: c.name, ...openOneWordMemo.get(c.code) }))
            .map((x) => ({ code: x.code, name: x.name, minute: x.minute, chg: x.chg }));
          const pos = {
            code: pick.cand.code,
            stockName: pick.cand.name,
            mode: 'offense',
            board: pick.cand.eventBoard,
            buyDate: dateStr,
            buyDateDisplay: dateDisplay,
            buyTime: fmtMinute(minute),
            buyPrice: round2(pick.hit.px),
            buyChange: round2(chg),
            metric: null,
            weight: TWO_BUY_LEG_WEIGHT,
            buyReason: '',
            buyChecks: [],
            buyDi: di,
            triggerInfo: {
              eventDate: pick.cand.eventDate,
              eventMinute: pick.cand.eventMinute,
              eventBoard: pick.cand.eventBoard,
              eventLeader: pick.cand.eventLeader,
              gapDays: di - allDates.indexOf(pick.cand.eventDate),
              pool: activeCandidates.filter((x) => x.eventDate === pick.cand.eventDate && x.eventBoard === pick.cand.eventBoard).map((x) => x.name),
              hitMinute: minute,
              hitChange: round2(chg),
              skippedOneWord,
            },
          };
          pos.buyReason = buildBuyReason(pos);
          pos.buyChecks = buildBuyChecks(pos);
          position = pos;
          soldThisDate = false; // 买入当日仍可在尾盘触发「收盘不涨停即卖」
        }
      }
    }
  }

  // 组装结果
  let holding = null;
  if (position) {
    holding = { ...position, weight: TWO_BUY_LEG_WEIGHT };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(position.code, allDates[allDates.length - 1]);
    if (closePx != null && closePx > 0 && position.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - position.buyPrice) / position.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn * TWO_BUY_LEG_WEIGHT) : null;
  }

  const overallReturn = computeTwoBuyAccountReturn([
    ...trades.map((t) => ({ buyDate: t.buyDate, buyTime: t.buyTime, sellDate: t.sellDate, sellTime: t.sellTime, returnRate: t.returnRate })),
    ...(holding ? [{ buyDate: holding.buyDate, buyTime: holding.buyTime, returnRate: holding.buyReturn }] : []),
  ]);
  const validTrades = trades.filter((t) => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter((t) => t.returnRate > 0).length;
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

const buildBuyReason = (pos) => {
  const t = pos.triggerInfo;
  const skipText = (t.skippedOneWord || []).length > 0
    ? `（涨幅 ≥ ${LIMIT_UP_PCT}% 已涨停买不进、已顺延：${(t.skippedOneWord || []).map((x) => x.name).join('、')}）`
    : '';
  return `${pos.buyTime} 触发「连板题材-情绪瞬爆-惯性漂移-龙头」买点：${t.eventDate} ${fmtMinute(t.eventMinute)} 命中题材「${t.eventBoard}」（龙头 ${t.eventLeader}）；本策略在触发后第 ${t.gapDays} 个交易日（≤3 日内）跟踪该题材在触发日爆发的首板股 ${t.pool.length} 只，${pos.stockName} 首个达到分时涨幅 ${gainText(t.hitChange)}（≥ +${BUY_TRIGGER_PCT}% 且未涨停）${skipText}，按该分钟分时价 ${pos.buyPrice.toFixed(2)} 买入（半仓）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  return [
    {
      id: 'ebf_trigger',
      title: '触发①：龙头策略（连板题材-情绪瞬爆-惯性漂移-龙头）买点',
      passed: true,
      value: `${t.eventDate} ${fmtMinute(t.eventMinute)} 命中题材「${t.eventBoard}」，龙头 ${t.eventLeader}`,
      reason: '完整复用龙头策略引擎，在其真实买入（龙头买点）发生的当日记录触发事件；本策略仅在触发日之后的 3 个交易日内出手（不含触发当日）',
    },
    {
      id: 'ebf_window',
      title: `触发②：处于触发后 ${FOLLOW_WINDOW_DAYS} 个交易日内（不含触发当日）`,
      passed: true,
      value: `第 ${t.gapDays} 个交易日（${pos.buyDate}）`,
      reason: `可出手窗口 = 触发日 D+1 / D+2 / D+3（共 ${FOLLOW_WINDOW_DAYS} 个交易日）；本次为第 ${t.gapDays} 个交易日`,
    },
    {
      id: 'ebf_pool',
      title: '选股：触发日该题材「爆发的首板股」（只买主板）',
      passed: true,
      value: `${t.pool.length} 只：${t.pool.slice(0, 12).join('、')}${t.pool.length > 12 ? ' 等' : ''}`,
      reason: `首板股 = 触发日 ${t.eventDate} 当日连板数为 1（首封涨停）且所属题材为「${t.eventBoard}」的个股；剔除创业板 30/301、科创板 688 与北交所`,
    },
    {
      id: 'ebf_first9',
      title: `买点：窗口内首个「分时涨幅达到 +${BUY_TRIGGER_PCT}%」者买入（谁先达到谁先买；一字板买不进则顺延）`,
      passed: true,
      value: `${t.hitMinute != null ? fmtMinute(t.hitMinute) : '--'} ${pos.stockName} ${gainText(t.hitChange)}`,
      reason: `在窗口内逐分钟跟踪上述首板股，跨个股取最早达到 +${BUY_TRIGGER_PCT}% 的分钟（同分钟取涨幅更大者），按该分钟分时价买入；**涨幅 ≥ ${LIMIT_UP_PCT}% 视为涨停（买不进）**，该分钟不计入买点，顺延到其他先达到 +${BUY_TRIGGER_PCT}% 的候选`,
    },
    {
      id: 'ebf_one_word',
      title: `一字板顺延：涨幅 ≥ ${LIMIT_UP_PCT}%（已涨停，买不进）的候选跳过`,
      passed: true,
      value: (t.skippedOneWord || []).length > 0
        ? (t.skippedOneWord || []).map((x) => `${x.name}（${fmtMinute(x.minute)} 涨幅 ${gainText(x.chg)} ≥ ${LIMIT_UP_PCT}%，买不进）`).join('；')
        : '当日无「涨停买不进」的候选被顺延',
      reason: `判定口径：只要涨幅 ≥ ${LIMIT_UP_PCT}% 就算涨停、买不进（含一字板开盘与封板中的分钟）；该分钟不作为买点，若其后续炸板回落到 9%~${LIMIT_UP_PCT}% 之间仍可买入，整日都 ≥${LIMIT_UP_PCT}% 的候选当日跳过并顺延`,
    },
  ];
};

module.exports = { runEmotionBurstFollowBacktest };
