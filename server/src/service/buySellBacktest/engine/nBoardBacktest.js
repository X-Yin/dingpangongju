const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
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
  fmtKeyBlockSlope,
} = require('./indexGate');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_CODES } = require('../constants');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { round2, loadTlinePoints, clearTlineCache } = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

// ============================================================
// 情绪游资-n板打板（nBoardMode: true，2026-10-18 用户新增；独立引擎；n = 2 / 3）
//   买点门禁 = 上证指数（sh000001）3 日线斜率分时为正；且**严格时段门禁**——当日一律只在 9:40 及以后才买
//       （2026-10-18 用户要求：不再区分「前一交易日收盘斜率是否为正」，9:40 之前一律不买）；买入时段限 9:40–11:30。
//   选股 = 上一交易日（T-1）的 n-1 板个股（n=2→首板、n=3→二板），剔除创业板（30/301）与科创板（688）；
//       当日盘中分时涨幅（较昨收）首次冲高至 +8% 的那一分钟按该分钟分时价买入，先冲到 8% 的先买（半仓单持仓）；
//       一字板过滤（2026-10-18 用户要求）：开盘竞价（9:30 开盘价）涨幅 > 9.5% 的候选整日不买，即使后续炸板也不买。
//       涨停过滤（2026-10-18 用户要求）：9:40 及以后首次触及 +8% 的那一分钟若已涨停（主板 ≥ 9.5%，涨停价买不进），该候选整日不买。
//   卖点 = 完全沿用「情绪游资-极致胜率」顺周期腿口径：
//       价格类卖点（scanLeaderPriceSell：成本线 -5% 即时止损 ∪ 跌停 ∪ 高位放量大阴线 ∪ 竞价低开 < -5%
//       ∪ 盘中较昨收 ≤ -5% ∪ 开盘后较开盘价 ≤ -5% ∪ 单分钟跳水 ≤ -3%）
//       ∪ 持仓第 3 个交易日尾盘收益仍未拉开 +10% ∪ 当日收盘抗分歧指数 < 6（抗分歧指数跟踪上证指数）；
//       价格类卖点按分钟级回溯成交。
//   仓位 = 半仓单持仓（权重 0.5），收益率按半仓折算后逐笔复利。
// ============================================================

const N_BOARD_TRIGGER_PCT = 8;         // 打板触发涨幅（较昨收）
const OPEN_ONE_WORD_PCT = 9.5;         // 开盘竞价涨幅 > 9.5% 视为一字板 → 不买（即使后续炸板也不买，2026-10-18 用户要求）
const LIMIT_UP_PCT = 9.5;              // 主板涨停阈值（涨幅 ≥ 9.5% 视为涨停）；9:40 及以后触发分钟已涨停的候选整日不买（2026-10-18 用户要求）
const BUY_WINDOW_END = 1130;           // 买入时段终点 11:30
const SLOPE_MINUTE_GATE = 940;         // 严格时段门禁：当日一律只在 9:40 及以后才允许买入（2026-10-18 用户要求）
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
// 主板（剔除创业板 30/301 与科创板 688）
const isMainBoardCode = (code) => !!code && !/^(sz30|sh688)/i.test(code);

// 上证指数「前一交易日收盘口径」3 日线斜率（仅用于买入明细展示，不再影响时段门禁），数据不足返回 null
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

const runNBoardBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.nBoardMode !== true) {
    return { success: false, message: `未知情绪游资-n板打板策略: ${strategyId}` };
  }
  const N = Number(strategy.nBoardN);
  if (!(N >= 2)) {
    return { success: false, message: `情绪游资-n板打板策略配置错误（nBoardN=${strategy.nBoardN}）` };
  }
  const minBoardCount = N - 1; // 上一交易日须为 n-1 板

  // 不依赖资金快照：日期序列并入 tech_index 覆盖的交易日（与龙头战法引擎同口径）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // 预计算上证 3 日线斜率收盘口径序列（供 prevCloseSlope 查询）
  try {
    await ensureIndexMa3SlopeSeries(ICE_SIGNAL_INDEX_CODE);
  } catch (e) { /* 预热失败时逐日兜底 */ }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  let position = null;      // 半仓单持仓
  let soldThisDate = false; // 当日卖出后当日不再追买

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
    soldThisDate = false;

    // 候选池：上一交易日（T-1）的 n-1 板（getRecentMultiLianbanStocks 的 lookback=1 → 仅取 T-1）
    let candidates = [];
    try {
      const { stocks } = await getRecentMultiLianbanStocks(dateStr, 1, minBoardCount);
      candidates = (stocks || []).filter(s => s
        && s.code
        && Number(s.lianbanCount) === minBoardCount
        && isMainBoardCode(s.code)
        && !EXCLUDED_CODES.has(s.code));
    } catch (e) { candidates = []; }
    for (const c of candidates) {
      if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name || c.code });
    }

    // 上证指数前一交易日收盘口径斜率（判定当日是否需等到 9:40）
    const prevCloseSlope = await getPrevCloseSlope(dateStr);

    // 每日分时缓存重建，控制内存
    clearTlineCache();

    // 隔夜持仓当日分时（卖点用）+ 当日收盘抗分歧指数（卖点⑥用；懒计算）
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

    // 候选分时（懒加载：仅当需要评估买点时构建）
    let poolReady = false;
    const tlineMap = new Map(); // code -> { preclose, points }
    const ensurePoolData = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidates.length === 0) return;
      await batchParallel(candidates, async (c) => {
        try { tlineMap.set(c.code, await loadTlinePoints(c.code, dateNum)); }
        catch (e) { tlineMap.set(c.code, { preclose: null, points: [] }); }
      }, 8);
    };

    // 每只候选「当日分时首次冲高至 +8%」的分钟与价格（懒计算，一日一次）
    let first8Ready = false;
    const first8Map = new Map(); // code -> { minute, px, chg, openChg }
    const limitUpMap = new Map(); // code -> { minute, chg }：9:40 及以后首次触及 +8% 时已涨停（≥9.5%）的候选，整日不买
    const computeFirst8 = () => {
      if (first8Ready) return;
      first8Ready = true;
      for (const c of candidates) {
        const t = tlineMap.get(c.code);
        if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) continue;
        // 一字板过滤（2026-10-18 用户要求）：开盘竞价（当日首分钟 9:30 开盘价）较昨收涨幅 > 9.5% 即视为一字板/竞价大幅高开，
        // 该候选整日不买——即使后续炸板（盘中回落）也不买、不顺延给其他候选之外的补偿
        const openPt = t.points[0];
        const openChg = openPt && openPt.lastPx > 0 ? ((openPt.lastPx - t.preclose) / t.preclose) * 100 : null;
        if (openChg != null && openChg > OPEN_ONE_WORD_PCT) continue;
        for (const p of t.points) {
          // 严格时段门禁：只在 9:40 及以后寻找「首次冲高至 +8%」的分钟——避免用 9:40 之前的分钟价成交（前视偏差）
          if (p.minute < SLOPE_MINUTE_GATE) continue;
          if (p.minute > BUY_WINDOW_END) break;
          if (!(p.lastPx > 0)) continue;
          const chg = ((p.lastPx - t.preclose) / t.preclose) * 100;
          // 9:40 及以后已涨停过滤（2026-10-18 用户要求）：首次触及 +8% 的那一分钟若已是涨停（主板 ≥ 9.5%，涨停价买不进），
          // 该候选整日不买——即使后续炸板（盘中回落）也不买（与「一字板」过滤同一口径）
          if (chg >= LIMIT_UP_PCT) {
            limitUpMap.set(c.code, { minute: p.minute, chg: round2(chg) });
            break;
          }
          if (chg >= N_BOARD_TRIGGER_PCT) {
            first8Map.set(c.code, { minute: p.minute, px: p.lastPx, chg: round2(chg), openChg: openChg != null ? round2(openChg) : null });
            break;
          }
        }
      }
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;

      // ===== 卖出（隔夜持仓；沿用「情绪游资-极致胜率」顺周期腿卖点）=====
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

          // 价格类卖点（成本线 -5% 即时止损 ∪ 跌停 ∪ 高位放量大阴线 ∪ 竞价低开 ∪ 盘中跌幅 ∪ 开盘跌幅 ∪ 单分钟跳水）：
          // 分钟级回溯——自 9:30 起逐分钟扫描分时，取「最先触发」的那一分钟精准卖出
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
              weight: TWO_BUY_LEG_WEIGHT,
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
              sellReason: `${sellReason}，情绪游资-${N}板打板（半仓）卖出`,
              returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
              rawReturnRate,
            });
            position = null;
            soldThisDate = true;
          }
        }
      }

      // ===== 买入（半仓单持仓）=====
      // 严格时段门禁（2026-10-18 用户要求）：当日一律只能在 9:40 及以后买入（不再有「前一日收盘斜率为负则可提前买」的例外）
      if (!position && !soldThisDate && bucketMinute >= SLOPE_MINUTE_GATE && bucketMinute <= BUY_WINDOW_END && candidates.length > 0) {
        const slope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
        const slopeOk = slope != null && Number.isFinite(Number(slope)) && Number(slope) > 0;
        if (slopeOk) {
          await ensurePoolData();
          computeFirst8();
          // 「先冲到 8% 的先买」：在已冲高至 8%（首次触及分钟 <= 当前桶）的候选中取首次触及最早者
          let best = null;
          for (const c of candidates) {
            const h = first8Map.get(c.code);
            if (!h || h.minute > bucketMinute) continue;
            if (!best || h.minute < best.hit.minute || (h.minute === best.hit.minute && h.chg > best.hit.chg)) {
              best = { c, hit: h };
            }
          }
          if (best) {
            position = buildPosition({
              pick: best.c,
              trigger: best.hit,
              dateStr,
              dateDisplay,
              slope,
              prevCloseSlope,
              n: N,
            });
            position.buyDi = di;
          }
        }
      }
    }
  }

  // 组装结果（type:'single'：半仓单持仓，收益率按半仓折算逐笔复利）
  let holding = null;
  if (position) {
    holding = { ...position, weight: TWO_BUY_LEG_WEIGHT };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
    if (closePx != null && closePx > 0 && position.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - position.buyPrice) / position.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn * TWO_BUY_LEG_WEIGHT) : null;
  }
  // 半仓账户口径：每笔收益按 0.5 权重计、单持仓不重叠（区间合并退化为逐笔复利）
  const overallReturn = computeTwoBuyAccountReturn([
    ...trades.map(t => ({ buyDate: t.buyDate, buyTime: t.buyTime, sellDate: t.sellDate, sellTime: t.sellTime, returnRate: t.returnRate })),
    ...(holding ? [{ buyDate: holding.buyDate, buyTime: holding.buyTime, returnRate: holding.buyReturn }] : []),
  ]);
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

// 构建持仓对象（含买入原因与买点诊断明细；半仓单持仓，权重 0.5）
const buildPosition = ({ pick, trigger, dateStr, dateDisplay, slope, prevCloseSlope, n }) => {
  const chgText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const slopeText = fmtKeyBlockSlope(slope);
  const prevText = prevCloseSlope == null ? '--' : fmtKeyBlockSlope(prevCloseSlope);
  const buyTimeText = fmtMinute(trigger.minute);
  const buyReason = `${buyTimeText} 上证指数 3 日线斜率分时 ${slopeText} > 0（${String(Math.floor(SLOPE_MINUTE_GATE / 100)).padStart(2, '0')}:${String(SLOPE_MINUTE_GATE % 100).padStart(2, '0')} 后；前一交易日收盘 ${prevText}），上一交易日 ${n - 1} 板候选 ${pick.name}（${pick.code}）当日分时冲高至 ${chgText(trigger.chg)}（首次触及 +${N_BOARD_TRIGGER_PCT}%），按该分钟分时价 ${trigger.px.toFixed(2)} 买入（半仓）`;
  const checks = [
    {
      id: 'n_board_index_slope',
      title: '买点门禁：上证指数 3 日线斜率分时为正，且严格限于 9:40 及以后买入',
      passed: true,
      value: `当桶实时斜率 ${slopeText} > 0（${buyTimeText}）；前一交易日收盘斜率 ${prevText}`,
      reason: `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线斜率按当桶分时实时判定为正；**严格时段门禁**：当日一律只在 ${String(Math.floor(SLOPE_MINUTE_GATE / 100)).padStart(2, '0')}:${String(SLOPE_MINUTE_GATE % 100).padStart(2, '0')} 及以后才允许买入（前一交易日收盘口径斜率 ${prevText}，不影响该时段限制）`,
    },
    {
      id: 'n_board_pool',
      title: `选股：上一交易日的 ${n - 1} 板（剔除创业板 30/301 与科创板 688）`,
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板（命中日 ${pick.date || '--'}，板块 ${pick.board || '--'}）`,
      reason: `候选 = 上一交易日（T-1）lianbanSnapshot 中连板数恰为 ${n - 1}（${n - 1} 板）的个股，已剔除 ST 等黑名单、创业板（30/301）与科创板（688）`,
    },
    {
      id: 'n_board_trigger',
      title: `买点触发：当日分时首次冲高至 +${N_BOARD_TRIGGER_PCT}%（先冲到的先买）`,
      passed: true,
      value: `首次触及 ${buyTimeText}（涨幅 ${chgText(trigger.chg)}，价 ${trigger.px.toFixed(2)}）`,
      reason: `当日分时（较昨收）首次冲高至 +${N_BOARD_TRIGGER_PCT}% 的分钟为 ${buyTimeText}，按该分钟分时价 ${trigger.px.toFixed(2)} 买入；同桶多只候选达到 +${N_BOARD_TRIGGER_PCT}% 时取「首次触及最早」的一只（先冲到 8% 的先买）`,
    },
    {
      id: 'n_board_one_word',
      title: `一字板过滤：开盘竞价涨幅 ≤ ${OPEN_ONE_WORD_PCT}%（非一字板）`,
      passed: true,
      value: `开盘竞价涨幅 ${chgText(trigger.openChg)}`,
      reason: `开盘竞价（9:30 开盘价）较昨收涨幅 ${chgText(trigger.openChg)} ≤ ${OPEN_ONE_WORD_PCT}%，非一字板/竞价大幅高开，可正常买入；开盘竞价涨幅 > ${OPEN_ONE_WORD_PCT}% 的候选整日不买（即使后续炸板也不买）`,
    },
    {
      id: 'n_board_not_limit_up',
      title: `涨停过滤：9:40 及以后触发时未涨停（触发涨幅 < ${LIMIT_UP_PCT}%）`,
      passed: true,
      value: `触发分钟涨幅 ${chgText(trigger.chg)} < ${LIMIT_UP_PCT}%`,
      reason: `首次触及 +${N_BOARD_TRIGGER_PCT}% 的分钟涨幅 ${chgText(trigger.chg)} 未达涨停阈值 ${LIMIT_UP_PCT}%（主板涨停价买不进），可正常成交；9:40 及以后触发时已涨停（涨幅 ≥ ${LIMIT_UP_PCT}%）的候选整日不买——即使后续炸板也不买`,
    },
    {
      id: 'n_board_position',
      title: `仓位与时段：半仓单持仓；买入仅限 9:40–11:30`,
      passed: true,
      value: `半仓（权重 ${TWO_BUY_LEG_WEIGHT}）`,
      reason: `单持仓半仓买入（权重 ${TWO_BUY_LEG_WEIGHT}），收益率按半仓折算后逐笔复利；买入时段严格限 9:40–11:30，卖出后当日不再追买`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name || pick.code,
    mode: 'offense',
    board: pick.board,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: buyTimeText,
    buyPrice: round2(trigger.px),
    buyChange: trigger.chg,
    metric: trigger.chg,
    weight: TWO_BUY_LEG_WEIGHT,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runNBoardBacktest };
