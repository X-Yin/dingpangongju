const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanOccurrences,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  getAllTechIndexData,
} = require('../deps');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { maxPreciseGainWindowInfo } = require('./extremeWinPool');
const { EXCLUDED_CODES, isExcludedTheme } = require('../constants');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const {
  round2,
  loadTlinePoints,
  clearTlineCache,
} = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

// ============================================================
// 连板题材-情绪瞬爆-惯性漂移-龙头（emotionBurstDriftMode: true，2026-10-30 用户新增；独立引擎）
//   2026-10-31 用户重构（仅回测，线上龙头策略不动）：
//   买点：① 前一交易日「科技情绪指数」收盘值 > 10；
//        ② 次日 9:30–14:30 之间，候选股分时涨幅（较昨收）首次达到 +9% 且未涨停（≥9.5% 视为涨停买不进）
//           即买入；多只候选同时满足时，谁的 +9% 分钟更早买谁（同分钟取涨幅更大者）；
//   选股：① 前一交易日「爆发」的题材板块中，涨停家数最多的板块（涨停家数须 > 5 个）；
//        ② 候选股 = 该板块前一交易日的首板股（连板数 = 1），只买主板（剔除创业板 30/301、科创板 688、北交所）；
//        ③ 限制：板块内最高度龙头（前一交易日连板数最高者）过去 20 交易日「最多 10 日」最大涨幅窗口 ≤ 70%，
//           除非该板块前一交易日涨停家数 > 20（涨停潮豁免）；
//   卖点：完全沿用「情绪游资-极致胜率」顺周期腿（价格类卖点 + 持仓第 4 个交易日尾盘收益未达 +10% + 收盘抗分歧 < 6）；
//   仓位：半仓单持仓（权重 0.5），收益率按半仓折算后逐笔复利。
// ============================================================

const TECH_EMOTION_MIN = 10;          // 前一日科技情绪指数收盘须 > 10
const THEME_LIMIT_UP_MIN = 5;         // 前一日题材涨停家数须 > 5
const THEME_COUNT_EXEMPT = 20;        // 板块当日涨停家数 > 20 时，豁免「龙头十日最大涨幅窗口 ≤ 70%」限制
const LEADER_WINDOW_LOOKBACK_DAYS = 20; // 龙头涨幅窗口回溯：过去 20 个交易日（不含当日）
const LEADER_WINDOW_MAX_DAYS = 10;      // 最多 10 个交易日的最大涨幅窗口
const LEADER_WINDOW_MAX_PCT = 70;       // 最高度龙头的十日最大涨幅窗口不得超过 70%
const BUY_TRIGGER_PCT = 9;            // 分时涨幅达到 +9% 即买入
const LIMIT_UP_PCT = 9.5;             // 涨幅 ≥ 9.5% 即视为涨停（买不进，顺延其他候选）
const BUY_START_MINUTE = 930;         // 买点最早 9:30
const BUY_CUTOFF_MINUTE = 1430;       // 买点最晚 14:30
const TAIL_MINUTE = 1457;
const WEAK_TRADE_HOLD_DAYS = 4;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001';
const EXCLUDED_BLOCK_KEYWORDS = ['并购重组', '三季报', '其他'];

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
const isExcludedBlock = (name) => EXCLUDED_BLOCK_KEYWORDS.some((k) => String(name || '').includes(k));

// options.onLeaderBuy：可选回调，在本策略真实成交买入时上报买点（供「惯性漂移-补涨」记录触发事件）
const runEmotionBurstDriftBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.emotionBurstDriftMode !== true) {
    return { success: false, message: `未知连板题材-情绪瞬爆-惯性漂移-龙头策略: ${strategyId}` };
  }
  const onLeaderBuy = typeof options?.onLeaderBuy === 'function' ? options.onLeaderBuy : null;

  const allDates = Array.from(new Set(getTrainingCampDates()))
    .filter((d) => d >= startDate && d <= endDate)
    .sort();
  const total = allDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // 科技情绪指数历史（前一交易日收盘值 > 10 的前置条件使用）
  const techIndexData = getAllTechIndexData();

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map();

  let position = null;
  let soldThisDate = false;

  for (let di = 0; di < total; di++) {
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

    // ---- 前一交易日 & 科技情绪指数（收盘值）+ 过去 20 个交易日（供龙头涨幅窗口限制使用）----
    let past20Dates = [];
    try {
      past20Dates = await getPastTradingDates(dateStr, LEADER_WINDOW_LOOKBACK_DAYS);
    } catch (e) { past20Dates = []; }
    const prevDate = past20Dates && past20Dates.length > 0 ? String(past20Dates[past20Dates.length - 1]) : null;
    let techEmotion = null;
    try {
      if (Array.isArray(techIndexData) && prevDate) {
        const hit = techIndexData.find((x) => x && String(x.date) === prevDate);
        const v = hit ? Number(hit.changeSumResult) : null;
        if (Number.isFinite(v)) techEmotion = v;
      }
    } catch (e) { techEmotion = null; }

    // ---- 前一日题材涨停家数排名 → 取涨停家数最多的题材（须 > 5）→ 该题材前一日首板股为候选 ----
    let selectedReady = false;
    let selectedBoard = null;
    let selectedCount = 0;
    let candidates = [];
    let themeTopList = [];
    let leaderHeight = null;
    let leaderWindow = null;
    let leaderExempt = false;
    let gate = { ok: false, reason: '' };
    const ensureSelected = async () => {
      if (selectedReady) return;
      selectedReady = true;
      if (!prevDate) {
        gate = { ok: false, reason: '缺少前一交易日数据' };
        return;
      }
      if (techEmotion == null) {
        gate = { ok: false, reason: `前一日（${prevDate}）缺少科技情绪指数数据` };
        return;
      }
      if (techEmotion <= TECH_EMOTION_MIN) {
        gate = { ok: false, reason: `前一日（${prevDate}）科技情绪指数 ${techEmotion.toFixed(2)} ≤ ${TECH_EMOTION_MIN}` };
        return;
      }

      const boardMap = new Map(); // board -> { board, count, stocks: Map(code -> {code,name,lianbanCount}) }
      try {
        // 注意：getRecentMultiLianbanOccurrences 的 lookback 是「相对传入日期的前 N 个交易日」，
        // 故传入当日 dateStr 才能得到前一交易日（prevDate）的快照
        const { stocks } = await getRecentMultiLianbanOccurrences(dateStr, 1, 1);
        for (const s of (stocks || [])) {
          if (!s || !s.code) continue;
          const board = String(s.board || '').trim() || '其他';
          if (isExcludedBlock(board)) continue;
          if (isExcludedTheme(board)) continue; // 与「情绪游资-极致胜率」同口径剔除科技硬件等黑名单板块
          if (!boardMap.has(board)) boardMap.set(board, { board, count: 0, stocks: new Map() });
          const item = boardMap.get(board);
          if (item.stocks.has(s.code)) continue;
          item.stocks.set(s.code, { code: s.code, name: s.name || s.code, lianbanCount: Number(s.lianbanCount) });
          item.count += 1;
        }
      } catch (e) { /* 快照缺失则该日不买 */ }

      const ranked = Array.from(boardMap.values())
        .map((x) => ({ board: x.board, count: x.count }))
        .sort((a, b) => b.count - a.count);
      themeTopList = ranked.slice(0, 5);

      if (ranked.length === 0) {
        gate = { ok: false, reason: `前一日（${prevDate}）无涨停题材数据` };
        return;
      }
      const top = ranked[0]; // 同涨停家数时保留快照排名靠前者
      if (top.count <= THEME_LIMIT_UP_MIN) {
        gate = { ok: false, reason: `前一日（${prevDate}）涨停家数最多的题材「${top.board}」仅 ${top.count} 家 ≤ ${THEME_LIMIT_UP_MIN}` };
        return;
      }
      selectedBoard = top.board;
      selectedCount = top.count;

      const pool = boardMap.get(top.board).stocks;
      candidates = Array.from(pool.values())
        .filter((s) => Number(s.lianbanCount) === 1 && isMainBoardCode(s.code) && !EXCLUDED_CODES.has(s.code))
        .map((s) => ({ code: s.code, name: s.name }));
      for (const c of candidates) {
        if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name });
      }
      if (candidates.length === 0) {
        gate = { ok: false, reason: `题材「${top.board}」前一日无主板首板股（连板数 = 1），无法打二板` };
        return;
      }

      // 新增限制（2026-10-31 用户要求）：遍历该板块「过去 20 个交易日内出现过的全部涨停股」，
      // 逐一计算其过去 20 交易日内的「最多 10 日」最大涨幅窗口，取其中最大的窗口涨幅作为该板块
      // 「最高度龙头」的涨幅；该最大值不得超过 70%（即使该股当前已回落为首板也计入，如万向德农
      // 近 20 日内曾 6 连板）；除非该板块前一交易日涨停家数 > 20（涨停潮豁免）。
      const allPool = Array.from(pool.values());
      const prevMaxHeight = allPool.reduce((m, s) => Math.max(m, Number.isFinite(Number(s.lianbanCount)) ? Number(s.lianbanCount) : 0), 0);
      // 逐个回溯近 20 个交易日的连板快照，收集该板块出现过的全部个股（回溯到前一日为止）
      const histStocksMap = new Map(); // code -> { code, name, height }
      for (const dt of past20Dates) {
        try {
          const { stocks: histStocks } = await getRecentMultiLianbanOccurrences(String(dt), 1, 1);
          for (const s of (histStocks || [])) {
            if (!s || !s.code) continue;
            if ((String(s.board || '').trim() || '其他') !== top.board) continue;
            const h = Number(s.lianbanCount);
            if (!Number.isFinite(h) || h <= 0) continue;
            const cur = histStocksMap.get(s.code);
            if (!cur) histStocksMap.set(s.code, { code: s.code, name: s.name || s.code, height: h });
            else if (h > cur.height) cur.height = h;
          }
        } catch (e) { /* 单日快照缺失则跳过 */ }
      }
      let boardStockList = Array.from(histStocksMap.values());
      if (boardStockList.length === 0) {
        // 历史快照不可用时退化为「前一交易日该板块的涨停股」
        boardStockList = allPool.map((s) => ({ code: s.code, name: s.name, height: Number(s.lianbanCount) || 0 }));
      }
      const histMaxHeight = boardStockList.reduce((m, s) => Math.max(m, s.height || 0), 0) || prevMaxHeight;
      leaderHeight = histMaxHeight > 0 ? histMaxHeight : null;
      if (boardStockList.length > 0) {
        try { await ensureBarsForCodes(new Set(boardStockList.map((s) => s.code))); } catch (e) { /* 日K拉取失败按缺失处理 */ }
        let best = null;
        for (const l of boardStockList) {
          const info = maxPreciseGainWindowInfo(l.code, past20Dates, LEADER_WINDOW_MAX_DAYS);
          if (!info || !Number.isFinite(info.max)) continue;
          if (!best || info.max > best.max) best = { ...info, code: l.code, name: l.name, height: l.height };
        }
        if (best) leaderWindow = { ...best, pct: round2(best.max) };
      }
      leaderExempt = top.count > THEME_COUNT_EXEMPT;
      if (!leaderExempt) {
        if (!leaderWindow) {
          gate = { ok: false, reason: `题材「${top.board}」近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日全部涨停股日K数据不足，无法确认「最多 ${LEADER_WINDOW_MAX_DAYS} 日」最大涨幅窗口 ≤ ${LEADER_WINDOW_MAX_PCT}%` };
          return;
        }
        if (leaderWindow.pct > LEADER_WINDOW_MAX_PCT) {
          gate = { ok: false, reason: `题材「${top.board}」近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日涨停股中最大涨幅窗口的龙头 ${leaderWindow.name}（${leaderWindow.height} 板）为 ${leaderWindow.pct}%（${leaderWindow.startDate}~${leaderWindow.endDate}）> ${LEADER_WINDOW_MAX_PCT}%，且板块涨停 ${top.count} 家 ≤ ${THEME_COUNT_EXEMPT}（未触发涨停潮豁免）` };
          return;
        }
      }

      gate = { ok: true, reason: `前一日（${prevDate}）科技情绪指数 ${techEmotion.toFixed(2)} > ${TECH_EMOTION_MIN}，题材「${top.board}」涨停 ${top.count} 家 > ${THEME_LIMIT_UP_MIN}，首板候选 ${candidates.length} 只；近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日涨停股最大涨幅窗口 ${leaderWindow ? `${leaderWindow.pct}%（${leaderWindow.name} ${leaderWindow.height} 板）` : '--'}${leaderExempt ? `（板块涨停 ${top.count} 家 > ${THEME_COUNT_EXEMPT}，豁免该限制）` : ` ≤ ${LEADER_WINDOW_MAX_PCT}%`}` };
    };

    // ---- 候选股分时（需要买入评估时加载一次）----
    let poolReady = false;
    const tlineMap = new Map(); // code -> { preclose, points }
    const ensurePool = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidates.length === 0) return;
      await batchParallel(candidates, async (c) => {
        try { tlineMap.set(c.code, await loadTlinePoints(c.code, dateNum)); }
        catch (e) { tlineMap.set(c.code, { preclose: null, points: [] }); }
      }, 8);
    };

    // 每只候选当日「首个可成交的 +9% 分钟」（9:30–14:30）
    //   涨幅 ≥ 9.5% 即视为涨停买不进：该分钟不计入买点，若后续炸板回落到 9%~9.5% 仍可买入；
    //   整日达到 +9% 时均 ≥9.5%（一字板/封板）则该股当日不可买，顺延其他候选。
    const hitMemo = new Map();
    const openOneWordMemo = new Map();
    let hitsReady = false;
    const computeHits = () => {
      if (hitsReady) return;
      hitsReady = true;
      for (const c of candidates) {
        const t = tlineMap.get(c.code);
        if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) continue;
        const firstMinute = t.points[0] ? t.points[0].minute : null;
        for (const p of t.points) {
          if (p.minute < BUY_START_MINUTE || p.minute > BUY_CUTOFF_MINUTE) continue;
          if (!(p.lastPx > 0)) continue;
          const chg = ((p.lastPx - t.preclose) / t.preclose) * 100;
          if (chg < BUY_TRIGGER_PCT) continue;
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

    // ---- 隔夜持仓卖点数据（沿用「情绪游资-极致胜率」顺周期腿）----
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
          .filter((x) => x && x.minute != null && x.last_px != null)
          .map((x) => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter((x) => x.lastPx > 0);
        const indexLine = (indexT?.line || [])
          .filter((x) => x && x.minute != null && x.last_px != null)
          .map((x) => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter((x) => x.lastPx > 0);
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const r = calculateReplayResilience(stockLine, indexLine, position.code);
          if (r != null && Number.isFinite(Number(r))) posResilience = round2(r);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResilience;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    for (let bi = 0; bi < timeBuckets.length; bi += 1) {
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

          let sellReason = null;
          let sellMinute = atPt.minute;
          let sellPx = px;
          let sellChange = changePct;

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
              leaderRank: position.leaderRank,
              leaderGain: position.leaderGain,
              skippedLeaders: position.skippedLeaders,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: fmtMinute(sellMinute),
              sellPrice: round2(sellPx),
              sellChange,
              sellReason: `${sellReason}，连板题材-情绪瞬爆-惯性漂移-龙头（半仓）卖出`,
              returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
              rawReturnRate,
            });
            position = null;
            soldThisDate = true;
          }
        }
      }

      // ===== 买入（半仓单持仓）：前一日快照情绪温度 > 65 + 前一日最强题材涨停家数 > 5，
      //        该题材前一日首板股当日首个达到 +9%（9:30–14:30，未涨停）者买入 =====
      if (!position && !soldThisDate) {
        await ensureSelected();
        if (gate.ok) {
          await ensurePool();
          computeHits();
          let pick = null;
          for (const c of candidates) {
            const hit = hitMemo.get(c.code);
            if (!hit || hit.minute > bucketMinute) continue;
            if (hit.px == null || !(hit.px > 0)) continue;
            if (!pick
              || hit.minute < pick.hit.minute
              || (hit.minute === pick.hit.minute && hit.chg > pick.hit.chg)) {
              pick = { cand: c, hit };
            }
          }
          if (pick && bucketMinute <= BUY_CUTOFF_MINUTE + 5) {
            const skippedOneWord = candidates
              .filter((c) => openOneWordMemo.has(c.code) && !hitMemo.has(c.code))
              .map((c) => ({ code: c.code, name: c.name, ...openOneWordMemo.get(c.code) }));
            const pos = {
              code: pick.cand.code,
              stockName: pick.cand.name,
              mode: 'offense',
              board: selectedBoard,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime: fmtMinute(pick.hit.minute),
              buyPrice: round2(pick.hit.px),
              buyChange: round2(pick.hit.chg),
              metric: null,
              weight: TWO_BUY_LEG_WEIGHT,
              buyReason: '',
              buyChecks: [],
              buyDi: di,
              leaderRank: leaderHeight,
              leaderGain: leaderWindow ? leaderWindow.pct : null,
              skippedLeaders: skippedOneWord,
              triggerInfo: {
                prevDate,
                techEmotion,
                eventBoard: selectedBoard,
                boardLimitUpCount: selectedCount,
                pool: candidates.map((c) => c.name),
                themeTopList,
                hitMinute: pick.hit.minute,
                hitChange: round2(pick.hit.chg),
                skippedOneWord,
                leaderHeight,
                leaderWindow,
                leaderExempt,
              },
            };
            pos.buyReason = buildBuyReason(pos);
            pos.buyChecks = buildBuyChecks(pos);
            position = pos;
            if (onLeaderBuy) {
              try {
                onLeaderBuy({
                  date: dateStr,
                  dateDisplay,
                  minute: pick.hit.minute,
                  board: selectedBoard,
                  code: pick.cand.code,
                  name: pick.cand.name,
                  buyPrice: round2(pick.hit.px),
                });
              } catch (e) { /* 上报失败不影响回测 */ }
            }
          }
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
  const topText = (t.themeTopList || [])
    .slice(0, 3)
    .map((x) => `${x.board} ${x.count} 家`)
    .join('、');
  const leaderText = t.leaderWindow
    ? `近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日涨停股最大涨幅窗口 ${t.leaderWindow.pct}%（龙头 ${t.leaderWindow.name}，${t.leaderWindow.height} 板）${t.leaderExempt ? `（板块涨停 ${t.boardLimitUpCount} 家 > ${THEME_COUNT_EXEMPT}，豁免该限制）` : ` ≤ ${LEADER_WINDOW_MAX_PCT}%`}`
    : `近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日涨停股最大涨幅窗口（日K缺失）`;
  return `${t.prevDate} 科技情绪指数收盘 ${t.techEmotion.toFixed(2)} > ${TECH_EMOTION_MIN}，次日 ${pos.buyTime} 买入：前一日涨停家数最多的题材「${t.eventBoard}」（${t.boardLimitUpCount} 家 > ${THEME_LIMIT_UP_MIN}，前 3 名：${topText}）中，${leaderText}；打二板候选（前一日首板股）${t.pool.length} 只，${pos.stockName} 于 ${fmtMinute(t.hitMinute)} 首个达到分时涨幅 ${gainText(t.hitChange)}（≥ +${BUY_TRIGGER_PCT}% 且未涨停）${skipText}，按该分钟分时价 ${pos.buyPrice.toFixed(2)} 买入（半仓）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  return [
    {
      id: 'ebd_tech_emotion',
      title: `买点前置①：前一交易日「科技情绪指数」收盘 > ${TECH_EMOTION_MIN}`,
      passed: !!(t.techEmotion != null && t.techEmotion > TECH_EMOTION_MIN),
      value: `${t.prevDate} 科技情绪指数收盘 ${t.techEmotion == null ? '--' : gainText(t.techEmotion)}`,
      reason: `取前一交易日（${t.prevDate}）科技情绪指数的收盘值，须 > ${TECH_EMOTION_MIN}；数值 ≤ ${TECH_EMOTION_MIN} 或缺失时当日不买`,
    },
    {
      id: 'ebd_theme_top',
      title: `选股①：前一交易日涨停家数最多的题材（涨停家数须 > ${THEME_LIMIT_UP_MIN}）`,
      passed: true,
      value: `选中「${t.eventBoard}」涨停 ${t.boardLimitUpCount} 家；前 5 名：${(t.themeTopList || []).map((x) => `${x.board}(${x.count})`).join('、')}`,
      reason: `候选题材 = 前一交易日 lianbanSnapshot 中爆发（出现涨停）的题材板块（剔除板块名含「并购重组」「三季报」者，并按与「情绪游资-极致胜率」相同的题材黑名单剔除 PCB/玻璃基板/光模块/液冷/通信/算力/芯片/靶材/电子气体/光刻胶/算力租赁/元器件/黄金/中报增长/次新股 等板块）；按涨停家数降序取第一名，且涨停家数须 > ${THEME_LIMIT_UP_MIN}，否则当日不买`,
    },
    {
      id: 'ebd_leader_window',
      title: `板块近 ${LEADER_WINDOW_LOOKBACK_DAYS} 交易日全部涨停股的「最多 ${LEADER_WINDOW_MAX_DAYS} 日」最大涨幅窗口 ≤ ${LEADER_WINDOW_MAX_PCT}%（板块涨停 > ${THEME_COUNT_EXEMPT} 家可豁免）`,
      passed: true,
      value: t.leaderWindow
        ? `${t.leaderWindow.name}（近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日最高 ${t.leaderWindow.height} 板）窗口涨幅 ${t.leaderWindow.pct}%（${t.leaderWindow.startDate}~${t.leaderWindow.endDate}，${t.leaderWindow.len} 个交易日）${t.leaderExempt ? `；板块涨停 ${t.boardLimitUpCount} 家 > ${THEME_COUNT_EXEMPT}，已豁免` : ''}`
        : `板块最高度龙头（近 ${LEADER_WINDOW_LOOKBACK_DAYS} 日最高 ${t.leaderHeight} 板）日K数据不足`,
      reason: `遍历选中题材在**过去 ${LEADER_WINDOW_LOOKBACK_DAYS} 个交易日**内出现过的**全部涨停股**（即便当前已回落为首板也计入，如万向德农 9/8 已首板但此前 6 连板），逐一计算其过去 ${LEADER_WINDOW_LOOKBACK_DAYS} 个交易日内「最多 ${LEADER_WINDOW_MAX_DAYS} 个交易日」的最大涨幅窗口（区间涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价），取其**最大值**作为该板块最高度龙头的窗口涨幅，不得超过 ${LEADER_WINDOW_MAX_PCT}%；若该题材前一交易日涨停家数 > ${THEME_COUNT_EXEMPT} 家（涨停潮），则豁免该限制`,
    },
    {
      id: 'ebd_pool',
      title: '选股②：候选股 = 该题材前一交易日的首板股（只买主板）',
      passed: true,
      value: `${t.pool.length} 只：${t.pool.slice(0, 12).join('、')}${t.pool.length > 12 ? ' 等' : ''}`,
      reason: `首板股 = 前一交易日（${t.prevDate}）连板数为 1（首封涨停）且所属题材为「${t.eventBoard}」的个股；只保留主板（剔除创业板 30/301、科创板 688、北交所）`,
    },
    {
      id: 'ebd_first9',
      title: `买点：${fmtMinute(BUY_START_MINUTE)}–${fmtMinute(BUY_CUTOFF_MINUTE)} 内首个分时涨幅达到 +${BUY_TRIGGER_PCT}% 者买入（谁先达到谁先买）`,
      passed: true,
      value: `${fmtMinute(t.hitMinute)} ${pos.stockName} ${gainText(t.hitChange)}`,
      reason: `次日逐分钟跟踪上述首板股，在 ${fmtMinute(BUY_START_MINUTE)}–${fmtMinute(BUY_CUTOFF_MINUTE)} 之间，任一只分时涨幅（较昨收）首次达到 +${BUY_TRIGGER_PCT}% 即买入；跨个股取最早达到的分钟（同分钟取涨幅更大者），按该分钟分时价成交`,
    },
    {
      id: 'ebd_limit_up_skip',
      title: `涨停买不进：涨幅 ≥ ${LIMIT_UP_PCT}% 的候选顺延`,
      passed: true,
      value: (t.skippedOneWord || []).length > 0
        ? (t.skippedOneWord || []).map((x) => `${x.name}（${fmtMinute(x.minute)} 涨幅 ${gainText(x.chg)} ≥ ${LIMIT_UP_PCT}%，买不进）`).join('；')
        : '当日无「涨停买不进」的候选被顺延',
      reason: `判定口径：只要涨幅 ≥ ${LIMIT_UP_PCT}% 就算涨停、买不进（含一字板开盘与封板中的分钟）；该分钟不作为买点，若其后续炸板回落到 9%~${LIMIT_UP_PCT}% 之间仍可买入，整日都 ≥ ${LIMIT_UP_PCT}% 的候选当日跳过并顺延`,
    },
  ];
};

module.exports = { runEmotionBurstDriftBacktest };
