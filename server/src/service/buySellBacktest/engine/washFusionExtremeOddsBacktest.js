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
const { EXCLUDED_CODES } = require('../constants');
const { ensureBacktestValuation } = require('../../watchlistValuation');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { round2, loadTlinePoints, clearTlineCache, limitUpThresholdOf } = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

// 复用「首板洗盘-起爆拉升」口径（A 风格）
const {
  isPotentialBullWashout,
  isThemeExcluded,
  maxThreeDayWindowGain,
  totalMvInfoFor,
  scanWashPriceSell,
  priceAtMinute,
  WASHOUT_OPT,
  WASHOUT_LOOKBACK_DAYS,
  BACKTEST_VOL_MULT,
  BUY_TRIGGER_PCT,
  BUY_OPEN_GAP_AUCTION_PCT,
  BUY_START_MINUTE,
  BUY_CUTOFF_MINUTE,
  MAX_INTRADAY_PULLBACKS,
  MAX_TOTAL_MV_YI,
  MAX_WIN3_GAIN_PCT,
  WASH_SELL_PROFIT_UNLOCK_PCT,
} = require('./firstBoardWashBacktest');
// 复用「放量洗盘-二板起爆」口径（B 风格）
const {
  matchVolumeWashout,
  analyzeBoardDayTline,
  VOL_WASHOUT_OPT,
  WASHOUT_LOOKBACK_DAYS: VWS_LOOKBACK_DAYS,
  BUY_CUTOFF_MINUTE: VWS_BUY_CUTOFF_MINUTE,
  WASH_SELL_GAP_DOWN_PCT,
} = require('./volumeWashoutSecondBoardBacktest');

// ============================================================
// 情绪游资-极致赔率（washFusionMode: true，2026-11-01 用户新增；仅回测；独立引擎）
//   把「首板洗盘-起爆拉升」（A 风格）与「放量洗盘-二板起爆」（B 风格）融合为同一个账户：
//   ① 候选池 = 两个策略候选池的并集（各自沿用原策略的完整选股 / 剔除口径，逐只标注来源）；
//      同一只股票同时命中两个策略时只保留一份，按 A 风格（首板洗盘-起爆拉升）口径建仓；
//   ② 买点 = 两套买点共用同一账户、谁先命中买谁（跨候选取最早触发分钟，同分钟取涨幅更大者；
//      同分钟同涨幅时 A 风格优先）；账户仍拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票；
//   ③ 卖点 = 每份持仓按其命中来源执行各自策略的卖出体系：
//      A 风格五条（① 跌破 5 日线 ② 跌破成本线 -3%/-5% ③ 盘中跌停 ④ 买入当日涨停、次日收盘未涨停
//        ⑤ 次日竞价低开），
//      B 风格七条（①~⑤ 同 A，⑥ 未拉开 +20% 前收盘未涨停即卖，⑦ 未拉开 +20% 前竞价低开超过 -3% 即卖）；
//   ④ 各份独立计收益（×0.5 折算），账户整体按重叠相加、跨轮复利；卖出后当日仍可继续买入（2026-11-01 用户要求取消该限制）。
// ============================================================

const MAX_POSITIONS = 2; // 账户拆两份、每份半仓，最多同时持有 2 只不同股票

const SOURCE_A = 'firstBoardWash';
const SOURCE_B = 'volumeWashout';
const SOURCE_LABELS = {
  [SOURCE_A]: '首板洗盘-起爆拉升',
  [SOURCE_B]: '放量洗盘-二板起爆',
};

const isChiNextOrStar = (code) => /^(30|688)/.test(String(code || '').replace(/^(sh|sz|bj)/i, ''));

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

const runWashFusionBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  // 无限仓位测试（2026-11-01 用户新增）：不限制同时持仓数量，每个买点只买排名最高且未被持有的一只
  const unlimited = options.unlimited === true;
  const maxPositions = unlimited ? Infinity : MAX_POSITIONS;
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.washFusionMode !== true) {
    return { success: false, message: `未知情绪游资-极致赔率策略: ${strategyId}` };
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

    clearTlineCache();

    let prevTradeDate = null;
    try {
      const past = await getPastTradingDates(dateStr, 1);
      prevTradeDate = past && past.length ? String(past[past.length - 1]) : null;
    } catch (e) { prevTradeDate = null; }

    // ---- 选股：A 风格（首板洗盘-起爆拉升）候选池 ----
    let selectedReady = false;
    let candidates = [];
    const collectFirstBoardWash = async () => {
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
          code: s.code, name: s.name || s.code, board: s.board || '', hasHighBoard: false,
        };
        const cnt = Number(s.lianbanCount);
        if (Number.isFinite(cnt) && cnt >= 3) item.hasHighBoard = true;
        if (s.board) item.board = s.board;
        recordMap.set(s.code, item);
      }

      const washStocks = Array.from(recordMap.values()).filter((x) => !x.hasHighBoard);
      try { await ensureBarsForCodes(new Set(washStocks.map((x) => x.code))); } catch (e) { /* 日K拉取失败按缺失处理 */ }

      const out = [];
      for (const item of washStocks) {
        const bars = getStockBarsCached(item.code);
        if (!bars || bars.length === 0) continue;
        const washout = isPotentialBullWashout(bars, dateNum, { volMult: BACKTEST_VOL_MULT });
        if (!washout) continue;
        const win3 = maxThreeDayWindowGain(bars, dateNum);
        if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
        washout.maxWin3Pct = win3 != null ? round2(win3) : null;
        out.push({ code: item.code, name: item.name, board: item.board, source: SOURCE_A, washout });
      }
      return out;
    };

    // ---- 选股：B 风格（放量洗盘-二板起爆）候选池 ----
    const collectVolumeWashout = async () => {
      if (!prevTradeDate) return [];
      let occStocks = [];
      try {
        const r = await getRecentMultiLianbanOccurrences(dateStr, VWS_LOOKBACK_DAYS, 1);
        occStocks = r.stocks || [];
      } catch (e) { occStocks = []; }

      const recordMap = new Map();
      for (const s of occStocks) {
        if (!s || !s.code) continue;
        if (isChiNextOrStar(s.code) || EXCLUDED_CODES.has(s.code) || isThemeExcluded(s.code, s.board)) continue;
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
      try { await ensureBarsForCodes(new Set(poolStocks.map((x) => x.code))); } catch (e) { /* 日K拉取失败按缺失处理 */ }

      const prevNum = parseInt(prevTradeDate, 10);
      const out = [];
      for (const item of poolStocks) {
        const bars = getStockBarsCached(item.code);
        if (!bars || bars.length === 0) continue;
        const washout = matchVolumeWashout(bars, prevNum);
        if (!washout) continue;
        const win3 = maxThreeDayWindowGain(bars, dateNum);
        if (win3 != null && win3 > MAX_WIN3_GAIN_PCT) continue;
        washout.maxWin3Pct = win3 != null ? round2(win3) : null;
        out.push({ code: item.code, name: item.name, board: item.board, source: SOURCE_B, washout });
      }
      return out;
    };

    const ensureSelected = async () => {
      if (selectedReady) return;
      selectedReady = true;

      const [aPool, bPool] = await Promise.all([collectFirstBoardWash(), collectVolumeWashout()]);

      // 同一只股票同时命中两个策略时只保留一份（按 A 风格口径建仓）
      const seen = new Set();
      candidates = [];
      for (const c of [...aPool, ...bPool]) {
        if (seen.has(c.code)) continue;
        seen.add(c.code);
        candidates.push(c);
      }

      // 总市值 ≤ 100 亿元：预筛按买点日前一交易日收盘价折算，买入时再按买入价复核；数据缺失不拦截
      try { await ensureBacktestValuation(candidates.map((c) => c.code)); } catch (e) { /* 拉取失败按缺失处理 */ }
      candidates = candidates.filter((c) => {
        const info = totalMvInfoFor(c.code, prevTradeDate);
        c.totalShares = info ? info.shares : null;
        c.totalMvYiPrev = info ? info.mvYi : null;
        c.totalMvBase = info
          ? { baseMvYi: info.baseMvYi, baseDate: info.baseDate, baseClose: info.baseClose }
          : null;
        return c.totalMvYiPrev == null || c.totalMvYiPrev <= MAX_TOTAL_MV_YI;
      });

      // 分时加载前剪枝：该候选不可能触发任一来源的买点时直接剔除（日K缺失时保守保留）
      candidates = candidates.filter((c) => {
        const bars = getStockBarsCached(c.code);
        const idx = bars ? bars.findIndex((b) => String(b.d) === dateStr) : -1;
        let openChg = null;
        if (idx > 0) {
          const pre = Number(bars[idx - 1].c);
          const o = Number(bars[idx].o);
          if (pre > 0 && o > 0) openChg = ((o - pre) / pre) * 100;
        }
        const highChg = stockHighChangeAt(c.code, dateStr);
        if (c.source === SOURCE_A) {
          // A：竞价 ≥ 5% 直接买，或盘中首次 +8%
          if (highChg == null || highChg >= BUY_TRIGGER_PCT) return true;
          return openChg != null && openChg >= BUY_OPEN_GAP_AUCTION_PCT;
        }
        // B：竞价必须高开，且盘中首次 +8%
        if (openChg != null && openChg <= 0) return false;
        if (highChg == null) return true;
        if (highChg >= BUY_TRIGGER_PCT) return true;
        return openChg != null && openChg >= BUY_TRIGGER_PCT;
      });

      for (const c of candidates) {
        if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name });
      }
    };

    // ---- 候选股分时（流式提取，不保留分时点位）----
    const hitMemo = new Map();     // code -> { minute, px, chg, mode, source }
    const limitUpMemo = new Map(); // code -> { minute, px, chg }
    let entriesReady = false;
    const ensureEntries = async () => {
      if (entriesReady) return;
      entriesReady = true;
      if (candidates.length === 0) return;
      const prevNum = prevTradeDate ? parseInt(prevTradeDate, 10) : null;
      await batchParallel(candidates, async (c) => {
        // B 风格：首板日（T-1）分时检查（断板 ≤ 1 次、封板满 20 分钟无漏量）
        if (c.source === SOURCE_B) {
          let bt = null;
          try { bt = prevNum ? await loadTlinePoints(c.code, prevNum) : null; } catch (e) { bt = null; }
          c.boardCheck = analyzeBoardDayTline(c.code, bt);
          if (c.boardCheck.failed) return;
        }
        let t = null;
        try { t = await loadTlinePoints(c.code, dateNum); } catch (e) { t = null; }
        if (!t || !(t.preclose > 0) || !Array.isArray(t.points) || t.points.length === 0) return;
        const preclose = t.preclose;
        const thr = limitUpThresholdOf(c.code);
        const pts = t.points;
        const p0 = pts.find((p) => p.lastPx > 0);
        if (!p0) return;
        const openChg = ((p0.lastPx - preclose) / preclose) * 100;

        if (c.source === SOURCE_A) {
          // 只有 9:30 开盘即涨停（竞价一字板）买不进；盘中封板仍可买
          if (openChg >= thr) {
            limitUpMemo.set(c.code, { minute: p0.minute, px: p0.lastPx, chg: round2(openChg) });
            return;
          }
          if (openChg >= BUY_OPEN_GAP_AUCTION_PCT) {
            hitMemo.set(c.code, { minute: p0.minute, px: p0.lastPx, chg: round2(openChg), mode: 'auction', source: SOURCE_A });
            return;
          }
          // 9:30–9:40 内首次 +8%，最多允许 1 次分钟级回落
          let pullbackCount = 0;
          const inBuyWindow = (p) => p.minute >= BUY_START_MINUTE && p.minute <= BUY_CUTOFF_MINUTE;
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
            const minBreakoutPx = (c.washout.platformHigh || 0) * WASHOUT_OPT.breakoutMinRatio;
            if (p.lastPx < minBreakoutPx) continue;
            hitMemo.set(c.code, { minute: p.minute, px: p.lastPx, chg: round2(chg), mode: 'burst8', source: SOURCE_A });
            break;
          }
          return;
        }

        // B 风格：竞价必须高开；竞价一字板买不进
        if (openChg >= thr) {
          limitUpMemo.set(c.code, { minute: p0.minute, px: p0.lastPx, chg: round2(openChg) });
          return;
        }
        if (openChg <= 0) return;
        for (let i = 0; i < pts.length; i += 1) {
          const p = pts[i];
          if (p.minute < BUY_START_MINUTE || p.minute > VWS_BUY_CUTOFF_MINUTE) continue;
          if (!(p.lastPx > 0)) continue;
          const chg = ((p.lastPx - preclose) / preclose) * 100;
          if (chg < BUY_TRIGGER_PCT) continue;
          hitMemo.set(c.code, {
            minute: p.minute,
            px: p.lastPx,
            chg: round2(chg),
            mode: p.minute <= p0.minute ? 'auction8' : 'burst8',
            source: SOURCE_B,
          });
          break;
        }
      }, 4);
      // B 风格首板日分时不合格者从候选池剔除
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
    // MA5 = 当日之前 5 个交易日收盘均值（盘中不含当日收盘，避免未来函数）
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
      } catch (e) { /* 日K不足时「跌破 5 日线」不判定 */ }
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
        fusionSource: pos.fusionSource,
        fusionSourceLabel: SOURCE_LABELS[pos.fusionSource] || null,
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
        sellReason: `${sellReason}，情绪游资-极致赔率（${SOURCE_LABELS[pos.fusionSource] || '融合'}·半仓）卖出`,
        returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
        rawReturnRate,
      });
      const idx = positions.indexOf(pos);
      if (idx >= 0) positions.splice(idx, 1);
    };

    // ===== ⑤（两风格通用）买入后的次一交易日竞价低开 → 次日 9:30 竞价直接卖 =====
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

    // ===== ⑦（仅 B 风格）：收益率未拉开 +20% 前，竞价低开超过 -3% → 当日 9:30 竞价直接卖 =====
    for (const pos of Array.from(positions)) {
      if (pos.fusionSource !== SOURCE_B) continue;
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

      // ===== 卖出（逐份持仓独立判定；①②③ 两风格同口径）=====
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

      // ===== 买入（两风格候选合并，谁先命中买谁；账户拆两份、每份半仓）=====
      //   桶循环一直走到 14:30（B 风格买点窗口），A 风格买点自身限制在 9:40 前
      if (positions.length < maxPositions && bucketMinute <= VWS_BUY_CUTOFF_MINUTE + 5) {
        await ensureSelected();
        if (candidates.length > 0) {
          await ensureEntries();

          const heldCodes = new Set(positions.map((p) => p.code));
          const mvRejected = new Set();
          while (positions.length < maxPositions) {
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
              const better = !pick
                ? true
                : hit.minute < pick.hit.minute
                  || (hit.minute === pick.hit.minute && (
                    hit.chg > pick.hit.chg
                    || (hit.chg === pick.hit.chg && hit.source === SOURCE_A && pick.hit.source !== SOURCE_A)
                  ));
              if (better) pick = { cand: c, hit, mvYiAtBuy };
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
              fusionSource: pick.cand.source,
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
                source: pick.cand.source,
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
            // 无限仓位：每个买点只买排名最高的一只，其余触发留给后续桶
            if (unlimited) break;
          }
        }
      }
    }

    // ===== 收盘卖点（逐份持仓独立判定；A/B 各自口径）=====
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
            // ④（两风格通用）：买入当日收盘涨停、买入次一交易日收盘未涨停 → 次一交易日收盘卖出
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

            // ⑥（仅 B 风格）：收益率未拉开 +20% 之前，买入次日起任一日收盘未涨停 → 当日收盘卖出
            if (pos.fusionSource === SOURCE_B && positions.includes(pos) && !profitUnlocked
              && dayPct != null && dayPct < thr) {
              sellPositionAt(pos, 1500, closePx, dayPct,
                `收益率未拉开 +${WASH_SELL_PROFIT_UNLOCK_PCT}%（收盘口径历史最高 ${pos.maxCloseGainPct != null ? `${pos.maxCloseGainPct}%` : '--'}），当日收盘未涨停（收盘 ${closePx.toFixed(2)}，当日 ${dayPct}% < 涨停阈值 ${thr}%）→ 收盘卖出`);
            }

            // ①（收盘分支，两风格通用）：收益率已拉开 +20% 后，收盘跌破 5 日线即卖
            if (positions.includes(pos) && profitUnlocked) {
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
  const sourceLabel = SOURCE_LABELS[t.source] || '融合';
  const skipText = (t.skippedLimitUp || []).length > 0
    ? `（开盘即涨停买不进、已顺延：${(t.skippedLimitUp || []).map((x) => x.name).join('、')}）`
    : '';
  const w = t.washout || {};
  let washText = null;
  if (t.source === SOURCE_A) {
    washText = t.washout
      ? `前置洗盘：${w.boardCount} 板 ${w.boardDate} → ${w.peakDate} 放量峰值（${w.peakVolRatio} 倍 ≥ ${BACKTEST_VOL_MULT} 倍）→ ${w.washStartDate}~${w.washEndDate} 缩量洗盘 ${w.washDays} 日（最大量 ${w.maxVolRatioPct}% ≤ 95%、最小量 ${w.minVolRatioPct}% ≤ 60%），洗盘幅度 ${gainText(w.rangePct)}（8%~35%），洗盘最低 ${w.washLow} 未跌破首板开盘 ${w.boardOpen != null ? w.boardOpen : '数据缺失'}，未突破平台高点 ${w.platformHigh}`
      : null;
  } else {
    washText = t.washout
      ? `前置只放量洗盘：首板 ${w.boardDate}（${w.boardPct}% 涨停，量占峰值日 ${w.boardVsPeakVolPct}% ≤ ${VOL_WASHOUT_OPT.BOARD_MAX_VS_PEAK_VOL_RATIO * 100}%）→ 拉升放量 ${w.pullStartDate}~${w.pullEndDate} ${w.pullDays} 日（均量 ${w.pullVolRatio} 倍、峰值量 ${w.pullMaxVolRatio} 倍）→ 震荡缩量 ${w.shockStartDate}~${w.shockEndDate} ${w.shockDays} 日（震荡最低 ${w.shockLow}，首次爆量开盘 ${w.pullOpen != null ? w.pullOpen : '数据缺失'}，回撤 ≤ 5%），未突破平台高点 ${w.platformHigh}`
      : null;
  }
  const modeText = t.mode === 'auction'
    ? `${fmtMinute(t.hitMinute)} 竞价高开 ${gainText(t.hitChange)}（≥ ${BUY_OPEN_GAP_AUCTION_PCT}%）直接按竞价开盘价买入`
    : t.mode === 'auction8'
      ? `竞价高开 ${gainText(t.hitChange)}，${fmtMinute(t.hitMinute)} 开盘即已 ≥ +${BUY_TRIGGER_PCT}% 按竞价价买入`
      : `盘中 ${fmtMinute(t.hitMinute)} 分时涨幅 ${gainText(t.hitChange)} 首次达到 +${BUY_TRIGGER_PCT}%`;
  return `【${sourceLabel}】候选 ${t.pool.length} 只（${washText}），${pos.stockName} ${modeText}${skipText}，成交价 ${pos.buyPrice.toFixed(2)} 买入（半仓）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  const w = t.washout || {};
  const sourceLabel = SOURCE_LABELS[t.source] || '融合';
  const checks = [
    {
      id: 'wf_source',
      title: '融合来源：两策略候选池并集，谁先命中买谁',
      passed: true,
      value: `本份仓位命中「${sourceLabel}」候选，按该策略口径建仓与卖出`,
      reason: '本策略把「首板洗盘-起爆拉升」与「放量洗盘-二板起爆」两个策略融合进同一个账户：候选池取两者并集（同一只股票同时命中两个策略时只保留一份、按首板洗盘口径建仓）；两套买点共用账户，跨候选取最早触发者，同分钟取涨幅更大者，同分钟同涨幅时首板洗盘优先；账户仍拆两份、每份半仓，最多同时持有 2 只不同股票',
    },
  ];
  if (t.source === SOURCE_A) {
    checks.push(
      {
        id: 'wf_a_washout',
        title: '首板洗盘口径：首/二板 → 放量峰值 → 5~12 日缩量洗盘（不突破、不破位、不跌破首板开盘价）',
        passed: !!t.washout,
        value: t.washout
          ? `${w.boardCount} 板 ${w.boardDate}（开盘 ${w.boardOpen != null ? w.boardOpen : '数据缺失'}），峰值 ${w.peakDate} 量 ${w.peakVol}（前 20 日均量 ${w.avg20}，${w.peakVolRatio} 倍）；洗盘 ${w.washStartDate}~${w.washEndDate} 共 ${w.washDays} 日，最大量 ${w.maxVolRatioPct}%、最小量 ${w.minVolRatioPct}%，区间幅度 ${gainText(w.rangePct)}，单日涨幅最大 ${gainText(w.maxDayPct)} / 跌幅最大 ${gainText(w.minDayPct)}，洗盘最低 ${w.washLow}，平台高点 ${w.platformHigh}`
          : '未命中前置洗盘形态',
        reason: `参照 washout.js 最新版 isPotentialBullWashout：首板日（可叠加二板）须涨停（≥ ${WASHOUT_OPT.limitPct}%）→ 首板日（含）后 ${WASHOUT_OPT.maxBaseToPeak} 个交易日内出现放量峰值（≥ 首板日前 20 日均量的 ${BACKTEST_VOL_MULT} 倍）→ 之后 ${WASHOUT_OPT.minWashDays}~${WASHOUT_OPT.maxWashDays} 个交易日缩量洗盘（最大量 ≤ 峰值量 ${WASHOUT_OPT.maxWashVolRatio * 100}%、最小量 ≤ 峰值量 ${WASHOUT_OPT.minShrinkRatio * 100}%、洗盘期内不得出现涨停）→ 洗盘期最高价 ≤ 平台高点 ${WASHOUT_OPT.upperToleranceHigh} 倍、最高收盘 ≤ ${WASHOUT_OPT.upperToleranceClose} 倍 → 洗盘区间幅度 ${WASHOUT_OPT.minRangePct * 100}%~${WASHOUT_OPT.maxRangePct * 100}% → 洗盘期单日涨跌幅须在 ±5% 内（-5%~-6% 最多 ${WASHOUT_OPT.maxMidDropDays} 天、超 -6% 剔除）→ 洗盘最低价不得跌破首板涨停日开盘价 → 起爆触发价 ≥ 平台高点 ${WASHOUT_OPT.breakoutMinRatio} 倍`,
      },
      {
        id: 'wf_a_entry',
        title: `首板洗盘买点：竞价 ≥ ${BUY_OPEN_GAP_AUCTION_PCT}% 直接 9:30 买入 / 竞价 < ${BUY_OPEN_GAP_AUCTION_PCT}% 时 9:30–9:40 分时 +${BUY_TRIGGER_PCT}% 买入（最多 ${MAX_INTRADAY_PULLBACKS} 次回落）`,
        passed: true,
        value: `${fmtMinute(t.hitMinute)} ${pos.stockName} ${gainText(t.hitChange)}（${t.mode === 'auction' ? '竞价直接买入' : `盘中 +${BUY_TRIGGER_PCT}% 买入`}）`,
        reason: `① 竞价高开 ≥ ${BUY_OPEN_GAP_AUCTION_PCT}% → 直接在 ${fmtMinute(BUY_START_MINUTE)} 按竞价开盘价买入；② 竞价高开 < ${BUY_OPEN_GAP_AUCTION_PCT}% → 在 ${fmtMinute(BUY_START_MINUTE)}–${fmtMinute(BUY_CUTOFF_MINUTE)} 内分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 时按该分钟分时价买入（最多允许 ${MAX_INTRADAY_PULLBACKS} 次回落，第 2 次回落即当日不买）；9:30 开盘即涨停（竞价一字板）买不进，盘中封板仍可买`,
      },
    );
  } else {
    checks.push(
      {
        id: 'wf_b_board',
        title: '放量洗盘口径：上个交易日（T-1）必须是首板，且过去 15 个交易日内未出现 ≥3 板',
        passed: true,
        value: `T-1 = ${t.prevTradeDate || '--'}，连板快照为 ${w.boardDate || '--'} 首板（收盘 ${w.boardPct != null ? `${w.boardPct}%` : '--'} 涨停）；15 日内无 ≥3 板记录`,
        reason: '首板之后的次日为买点日；过去 15 个交易日内出现过三板及以上连板的个股一律剔除',
      },
      {
        id: 'wf_b_board_break',
        title: '首板日断板次数 ≤ 1 次，且封板满 20 个交易分钟后封板期间无漏量（分钟量 ≤ 封板那分钟量的 130%）',
        passed: true,
        value: t.boardCheck && !t.boardCheck.skipped
          ? (t.boardCheck.sealMinute != null
            ? `首板日（${t.prevTradeDate}）分时断板 ${t.boardCheck.breaks} 次；封板 ${fmtMinute(t.boardCheck.sealMinute)} 那分钟量 ${t.boardCheck.sealVol}，封板满 20 分钟后最大分钟量占比 ${t.boardCheck.maxLeakRatioPct != null ? `${t.boardCheck.maxLeakRatioPct}%` : '--'}，漏量 ${t.boardCheck.leakCount} 分钟`
            : `首板日（${t.prevTradeDate}）分时断板 ${t.boardCheck.breaks} 次，且未封板（漏量项不拦截）`)
          : '首板日分时缺失，该项不拦截',
        reason: '首板日分时价触及涨停价后回落算一次断板，允许断板 1 次、出现第 2 次即剔除；封住涨停满 20 个交易分钟后（断板回封重新计时，剔除午休 11:30–13:00）到收盘，封死涨停期间任一分钟成交量不得超过「封板那一分钟」成交量的 130%（按成交量判定）',
      },
      {
        id: 'wf_b_washout',
        title: '前置「拉升放量 1~3 日 → 震荡缩量 2~12 日 → 首板突破」形态 + 震荡期涨跌幅温和 + 最低价不破首次爆量开盘价 -5%',
        passed: !!t.washout,
        value: t.washout
          ? `首板 ${w.boardDate}（开 ${w.boardOpen != null ? w.boardOpen : '--'}、收 ${w.boardClose}、量 ${w.boardVol}，占峰值日量 ${w.boardVsPeakVolPct}% ≤ ${VOL_WASHOUT_OPT.BOARD_MAX_VS_PEAK_VOL_RATIO * 100}%）；拉升 ${w.pullStartDate}~${w.pullEndDate}（${w.pullDays} 日，均量 ${w.pullVolRatio} 倍 ≥ ${VOL_WASHOUT_OPT.PULL_AVG_VOL_RATIO}，峰值量 ${w.pullMaxVolRatio} 倍 ≥ ${VOL_WASHOUT_OPT.PULL_PEAK_VOL_RATIO}，累计 ${gainText(w.pullGainPct)} ≥ ${VOL_WASHOUT_OPT.PULL_MIN_GAIN_PCT}%）；震荡 ${w.shockStartDate}~${w.shockEndDate}（${w.shockDays} 日，振幅 ${gainText(w.shockRangePct)} ≤ 20%，单日涨幅最大 ${gainText(w.maxDayPct)}、跌幅最大 ${gainText(w.minDayPct)}（-5%~-6% 共 ${w.midDropDays} 天 ≤ 1，超 -6% 共 ${w.deepDropDays} 天），震荡最低 ${w.shockLow} 较首次爆量开盘 ${w.pullOpen != null ? w.pullOpen : '数据缺失'} 回撤 ${w.lowVsPullOpenPct != null ? `${w.lowVsPullOpenPct}%` : '--'} ≤ 5%）`
          : '未命中前置只放量洗盘形态',
        reason: `参照 股票数据材料/只放量无涨停-打二板/washout.js：拉升段均量 ≥ 前 5 日均量 ${VOL_WASHOUT_OPT.PULL_AVG_VOL_RATIO} 倍、峰值量 ≥ ${VOL_WASHOUT_OPT.PULL_PEAK_VOL_RATIO} 倍、累计涨幅 ≥ ${VOL_WASHOUT_OPT.PULL_MIN_GAIN_PCT}%、最高价 ≥ 前 5 日最高价 ${VOL_WASHOUT_OPT.PULL_BREAK_PRE_HIGH_RATIO} 倍；震荡段 2~${VOL_WASHOUT_OPT.SHOCK_MAX_DAYS} 日、振幅 ≤ 20%、均量 ≤ 拉升均量 ${VOL_WASHOUT_OPT.SHOCK_VOL_RATIO * 100}%、最大量 ≤ ${VOL_WASHOUT_OPT.SHOCK_MAX_VOL_RATIO * 100}%；首板收盘 ≥ 震荡最高收盘 ${VOL_WASHOUT_OPT.BOARD_BREAK_SHOCK_CLOSE_RATIO} 倍、首板量 ≥ 震荡最后一日量 ${VOL_WASHOUT_OPT.BOARD_LAST_VOL_RATIO} 倍、首板量 ≤ 拉升峰值日量 ${VOL_WASHOUT_OPT.BOARD_MAX_VS_PEAK_VOL_RATIO} 倍；震荡期所有交易日涨跌幅须在 ±5% 内（-5%~-6% 最多 1 天、超 -6% 剔除），震荡最低价不得低于首次爆量开盘价 -5%`,
      },
      {
        id: 'wf_b_entry',
        title: `放量洗盘买点：竞价必须高开 → 9:30–14:30 分时首次 +${BUY_TRIGGER_PCT}% 按该分钟价买入`,
        passed: true,
        value: `${fmtMinute(t.hitMinute)} ${pos.stockName} ${gainText(t.hitChange)}（${t.mode === 'auction8' ? '竞价已 ≥ +8%，按竞价价买入' : `盘中 +${BUY_TRIGGER_PCT}% 买入`}）`,
        reason: `首板之后的次日竞价必须高开（9:30 开盘价高于昨收），随后按 1 分钟回溯在 ${fmtMinute(BUY_START_MINUTE)}–${fmtMinute(VWS_BUY_CUTOFF_MINUTE)} 内寻找分时涨幅首次达到 +${BUY_TRIGGER_PCT}% 的那一分钟，按该分钟分时价买入；竞价一字板（开盘即涨停）买不进`,
      },
    );
  }
  checks.push(
    {
      id: 'wf_win3_cap',
      title: `买点日前 20 个交易日内最大三日滑动窗口涨幅 ≤ ${MAX_WIN3_GAIN_PCT}%`,
      passed: true,
      value: w.maxWin3Pct != null
        ? `本样本最大三日滑动窗口涨幅 ${gainText(w.maxWin3Pct)}（≤ ${MAX_WIN3_GAIN_PCT}%）`
        : '历史日K不足 3 日，该项不拦截',
      reason: `按买点日前一交易日及更早日K，取最近 20 个交易日内任意连续 3 个交易日的涨幅最大值，超过 ${MAX_WIN3_GAIN_PCT}% 的个股一律剔除`,
    },
    {
      id: 'wf_total_mv',
      title: `总市值 ≤ ${MAX_TOTAL_MV_YI} 亿元（按买入日股价折算）`,
      passed: true,
      value: (() => {
        const atBuy = t.totalMvYiAtBuy;
        const prev = t.totalMvYiPrev;
        if (atBuy == null) return `总市值数据缺失，该项不拦截（前一交易日折算值 ${prev != null ? `${prev} 亿` : '缺失'}）`;
        return `买入价 ${round2(pos.buyPrice)} 对应总市值 ${atBuy} 亿（前一交易日收盘价折算 ${prev != null ? `${prev} 亿` : '缺失'}，均 ≤ ${MAX_TOTAL_MV_YI} 亿）`;
      })(),
      reason: `先由「当下总市值 ÷ 当下股价」反推总股本（自选股用 monitor_stocks_valuation，非自选股用 data/backtest_stock_valuation.json），再把股本 × 买入日该分钟实际买入价折算成回测当天的总市值，> ${MAX_TOTAL_MV_YI} 亿元即剔除并顺延下一只；候选池预筛用买点日前一交易日收盘价，买入时按买入价复核`,
    },
    {
      id: 'wf_position',
      title: '仓位：账户拆两份、每份半仓（权重 0.5），谁先命中买谁',
      passed: true,
      value: `本份为第 ${pos.leg} 份（半仓）`,
      reason: '账户拆两份、每份半仓（权重 0.5），最多同时持有 2 只不同股票；两份仓位各自独立买卖、独立按自身买入价计收益（×0.5 折算）；卖出后当日仍可继续买入',
    },
  );
  return checks;
};

module.exports = { runWashFusionBacktest };
