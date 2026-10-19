const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  stockDailyChange,
  ensureBarsForCodes,
  fs,
  path,
} = require('../deps');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { EXCLUDED_CODES } = require('../constants');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { round2, loadTlinePoints, clearTlineCache } = require('./extremeWinScores');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');
const { getBlockCategoryRatio } = require('../../板块成交量占比计算/category_amount_money');

// ============================================================
// 情绪游资-成交量占比（volumeShareMode: true，2026-10-19 用户新增；独立引擎；N = 2 / 3 / 5）
//   选股（每日按 D 的前一交易日 T-1 数据判定）：
//     ① 板块：对候选分类（剔除 半导体/液冷/光通信/存储芯片/pcb 后剩 9 类）算「成交量占比 3 日线斜率」
//        （MA3 收盘序列，斜率 = (r[i] - r[i-3]) / 3，i = 最后一个 date ≤ T-1 的索引），取斜率 > 0 者按
//        斜率降序取前 3（不足 3 取全部）；
//     ② 成分股 ∩ 近 5 个交易日连板：读「东方财富板块成分股汇总/{分类}.json」得前 3 板块全部个股（bare code），
//        与 getRecentMultiLianbanStocks(D, 5, 1) 的连板个股（带前缀 marketCode 去前缀得 bare code）求交集；
//     ③ 候选 = 上述交集的全部个股（记录其命中的前 3 板块集合，卖出时用）。
//   买点（自 9:40 起逐桶重试，直到买进；限早盘 9:40–11:30；当日全部桶无合格候选则当日不买）：
//     在触发桶分钟 M 上，候选按「N 日涨幅最大」（复利口径；窗口最后一位为当日 M 时点的分时涨幅）降序排名，
//     依次顺延筛选：买入时点已涨停（一字板，主板 ≥ 9.5% / 创·科 ≥ 19%）跳过 → 当日分时涨幅 ≤ -5% 跳过 →
//     抗分歧指数 < 9（跟踪指数：sh688→科创50 sh000688，其余→创业板指 sz399006）跳过；首个通过者按 M 分时价买入。
//   卖点：持仓所属「前 3 板块集合」中任一板块的成交量占比 3 日线斜率（截止 T-1）转负 → 该日开盘按开盘分时价卖出。
//   仓位 = 半仓单持仓（权重 0.5），收益率按半仓折算后逐笔复利。
// ============================================================

const CANDIDATE_CATEGORIES = ['传媒', '农业', '消费', '医药', '电力', '锂电池', '商业航天', '军工', '机器人'];
const BOARD_DIR = path.resolve(__dirname, '../../../data/东方财富板块成分股汇总');
const BUY_START_MINUTE = 940;   // 买点严格 9:40 及以后
const BUY_END_MINUTE = 1130;    // 买入时段终点 11:30
const GLOBAL_RESILIENCE_MIN = 9; // 全局最低抗分歧门槛
const DROP_LIMIT_PCT = -5;       // 当日分时涨幅须 > -5%

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const stripPrefix = (code) => String(code || '').replace(/^(sh|sz|bj)/i, '');
// 市场涨停口径：主板（60/00）9.5% / 创业板·科创板（30/68）19%
const limitUpThresholdOf = (code) => (/^(68|30)/.test(stripPrefix(code)) ? 19 : 9.5);
// 抗分歧跟踪指数：sh688 → 科创50，其余 → 创业板指
const resilienceIndexCodeOf = (code) => (/^sh688/i.test(String(code || '')) ? 'sh000688' : 'sz399006');
const chgText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 板块成交量占比序列（按分类）；启动一次性加载，失败抛错
let ratioSeriesCache = null;
const loadRatioSeries = () => {
  if (ratioSeriesCache) return ratioSeriesCache;
  const raw = getBlockCategoryRatio(null, null);
  const m = new Map();
  for (const cat of CANDIDATE_CATEGORIES) {
    const rows = Array.isArray(raw[cat]) ? raw[cat] : [];
    m.set(cat, rows
      .filter(r => r && r.date != null && Number.isFinite(Number(r.ratio)))
      .map(r => ({ date: String(r.date), ratio: Number(r.ratio) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
  }
  ratioSeriesCache = m;
  return m;
};

// 截止到 refDateStr（含）的成交量占比 3 日线斜率；数据不足返回 null
const blockSlope = (seriesMap, cat, refDateStr) => {
  const rows = seriesMap.get(cat);
  if (!rows || rows.length < 4) return null;
  const ref = String(refDateStr);
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].date <= ref) idx = i; else break;
  }
  if (idx < 3) return null;
  return (rows[idx].ratio - rows[idx - 3].ratio) / 3;
};

// 板块成分股（Map<分类, Map<bareCode, name>>）
let constituentCache = null;
const loadConstituents = () => {
  if (constituentCache) return constituentCache;
  const m = new Map();
  for (const cat of CANDIDATE_CATEGORIES) {
    const file = path.join(BOARD_DIR, `${cat}.json`);
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { arr = []; }
    const map = new Map();
    for (const it of (Array.isArray(arr) ? arr : [])) {
      if (it && it.code) map.set(String(it.code), it.name || String(it.code));
    }
    m.set(cat, map);
  }
  constituentCache = m;
  return m;
};

// N 日涨幅（复利口径，复刻 replayData.computeWindowGain）：winDates 最后一位为当日，用当日 M 时点分时涨幅
const computeNDayGain = (code, winDates, todayIntradayChange) => {
  let prod = 1;
  for (let i = 0; i < winDates.length; i++) {
    let ch;
    if (i === winDates.length - 1) {
      ch = todayIntradayChange != null ? Number(todayIntradayChange) : null;
    } else {
      ch = stockDailyChange(code, winDates[i]);
    }
    if (ch == null || !Number.isFinite(ch)) return null;
    prod *= 1 + ch / 100;
  }
  return (prod - 1) * 100;
};

const runVolumeShareBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.volumeShareMode !== true) {
    return { success: false, message: `未知情绪游资-成交量占比策略: ${strategyId}` };
  }
  const N = Number(strategy.volumeShareDays);
  if (!(N >= 2)) {
    return { success: false, message: `情绪游资-成交量占比策略配置错误（volumeShareDays=${strategy.volumeShareDays}）` };
  }

  // 一次性加载板块占比序列与板块成分股
  let seriesMap, constituentMap;
  try {
    seriesMap = loadRatioSeries();
    constituentMap = loadConstituents();
  } catch (e) {
    return { success: false, message: `板块成交量占比数据不可用：${e.message || e}` };
  }

  const allDates = getTrainingCampDates();
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  let position = null;      // 半仓单持仓
  let soldThisDate = false; // 当日卖出后当日不再追买

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    const dateNum = parseInt(dateStr, 10);
    soldThisDate = false;

    // 上一交易日 T-1（严格不含当日）
    const prevDates = await getPastTradingDates(dateStr, N - 1); // 长度 N-1（可能不足）
    const t1 = await getPastTradingDates(dateStr, 1);
    const prevDate = t1.length > 0 ? t1[t1.length - 1] : null;

    // 每日分时缓存重建，控制内存
    clearTlineCache();

    // ===== 卖出（隔夜持仓，且 D > buyDate）：所属前 3 板块中任一斜率（截止 T-1）转负 → 开盘卖出 =====
    if (position && prevDate != null && dateStr > position.buyDate) {
      const negCats = (position.categories || []).filter(cat => {
        const s = blockSlope(seriesMap, cat, prevDate);
        return s != null && Number(s) < 0;
      });
      if (negCats.length > 0) {
        const t = await loadTlinePoints(position.code, dateNum);
        const openPt = (t.points || [])[0];
        if (openPt && openPt.lastPx > 0) {
          const sellPx = openPt.lastPx;
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
            sellDateDisplay: dateStr,
            sellTime: fmtMinute(openPt.minute),
            sellPrice: round2(sellPx),
            sellChange: openPt.change != null ? round2(openPt.change) : null,
            sellReason: `所属板块「${negCats.join('、')}」成交量占比 3 日线斜率（截止 ${prevDate}）已转负（${negCats.map(c => `${c}:${fmtSlope(blockSlope(seriesMap, c, prevDate))}`).join('，')}），次一交易日开盘按开盘分时价 ${round2(sellPx).toFixed(2)} 卖出（情绪游资-成交量占比 · 半仓）`,
            returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
            rawReturnRate,
          });
          position = null;
          soldThisDate = true;
        }
      }
    }

    // ===== 买入（半仓单持仓）=====
    if (!position && !soldThisDate && prevDate != null) {
      // ① 板块：算 T-1 斜率，取 > 0 者按斜率降序取前 3
      const ranked = CANDIDATE_CATEGORIES
        .map(cat => ({ cat, slope: blockSlope(seriesMap, cat, prevDate) }))
        .filter(x => x.slope != null && Number(x.slope) > 0)
        .sort((a, b) => b.slope - a.slope);
      const top3 = ranked.slice(0, 3);

      if (top3.length > 0) {
        // ② 成分股 ∩ 近 5 日连板（交集 = 候选）
        let lianbanStocks = [];
        try {
          const { stocks } = await getRecentMultiLianbanStocks(dateStr, 5, 1);
          lianbanStocks = stocks || [];
        } catch (e) { lianbanStocks = []; }

        const candMap = new Map(); // prefixedCode -> { code, bareCode, name, categories:Set }
        for (const s of lianbanStocks) {
          if (!s || !s.code) continue;
          const prefixed = String(s.code);
          if (EXCLUDED_CODES.has(prefixed)) continue;
          const bare = stripPrefix(prefixed);
          const hitCats = top3.filter(t => constituentMap.get(t.cat).has(bare)).map(t => t.cat);
          if (hitCats.length === 0) continue;
          if (candMap.has(prefixed)) {
            const cur = candMap.get(prefixed);
            for (const c of hitCats) cur.categories.add(c);
          } else {
            candMap.set(prefixed, {
              code: prefixed,
              bareCode: bare,
              name: s.name || bare,
              categories: new Set(hitCats),
            });
          }
        }
        const candidates = Array.from(candMap.values());
        for (const c of candidates) {
          if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name });
        }

        if (candidates.length > 0) {
          // 预拉日K（N 日涨幅需要）
          try { await ensureBarsForCodes(new Set(candidates.map(c => c.code))); } catch (e) { /* 缺失则 gain=null */ }
          // 预拉分时（候选 + 所需跟踪指数）
          const tlineMap = new Map();
          const idxCodes = Array.from(new Set(candidates.map(c => resilienceIndexCodeOf(c.code))));
          await batchParallel(candidates, async (c) => {
            try { tlineMap.set(c.code, await loadTlinePoints(c.code, dateNum)); }
            catch (e) { tlineMap.set(c.code, { preclose: null, points: [] }); }
          }, 8);
          await batchParallel(idxCodes, async (ic) => {
            try { tlineMap.set(`__idx__${ic}`, await loadTlinePoints(ic, dateNum)); }
            catch (e) { tlineMap.set(`__idx__${ic}`, { preclose: null, points: [] }); }
          }, 4);

          const winDates = [...prevDates, dateStr];
          // N 日涨幅排名（每日固定：以「当前桶分时涨幅」为窗口末位，逐桶重排）
          const priceAtMinute = (points, minute) => {
            let at = null;
            for (const p of points) { if (p.minute <= minute) at = p; else break; }
            return at;
          };
          const resilienceAtMinute = (code, M) => {
            const t = tlineMap.get(code);
            const idxT = tlineMap.get(`__idx__${resilienceIndexCodeOf(code)}`);
            if (!t || !idxT) return { ok: false, reason: '分时数据缺失' };
            const stockLine = (t.points || [])
              .filter(p => p.minute <= M && p.lastPx > 0)
              .map(p => ({ minute: p.minute, lastPx: p.lastPx, change: p.change }));
            const indexLine = (idxT.points || [])
              .filter(p => p.minute <= M && p.lastPx > 0)
              .map(p => ({ minute: p.minute, lastPx: p.lastPx, change: p.change }));
            if (stockLine.length < 5 || indexLine.length < 5) return { ok: false, reason: '分时点数不足 5 点' };
            const r = calculateReplayResilience(stockLine, indexLine, code);
            if (r == null || !Number.isFinite(Number(r))) return { ok: false, reason: '抗分歧计算失败' };
            return { ok: true, value: round2(r) };
          };

          const buckets = [];
          // 时间桶按 5 分钟粒度生成：9:35..11:30 覆盖（使用固定分钟列表）
          for (let m = 935; m <= 1130; m += 5) {
            const mm = m % 100;
            if (mm >= 60) { m += 35; continue; } // 跳过 10:60 之类
            buckets.push(m);
          }
          buckets.push(1130);
          const uniqBuckets = Array.from(new Set(buckets)).filter(m => m >= BUY_START_MINUTE && m <= BUY_END_MINUTE).sort((a, b) => a - b);

          const blockReason = [];
          for (const M of uniqBuckets) {
            // 该桶各候选快照
            const snap = [];
            for (const c of candidates) {
              const t = tlineMap.get(c.code);
              if (!t || !(t.preclose > 0)) continue;
              const pt = priceAtMinute(t.points, M);
              if (!pt || !(pt.lastPx > 0)) continue;
              const todayChange = round2(((pt.lastPx - t.preclose) / t.preclose) * 100);
              snap.push({
                c,
                pt,
                todayChange,
                curLimitUp: todayChange >= limitUpThresholdOf(c.code),
                gain: computeNDayGain(c.code, winDates, todayChange),
              });
            }
            if (snap.length === 0) continue;
            snap.sort((a, b) => (b.gain == null ? -Infinity : b.gain) - (a.gain == null ? -Infinity : a.gain));

            for (const s of snap) {
              if (s.curLimitUp) { blockReason.push(`${s.c.name} ${fmtMinute(M)} 已涨停（${chgText(s.todayChange)}）顺延`); continue; }
              if (s.todayChange <= DROP_LIMIT_PCT) { blockReason.push(`${s.c.name} ${fmtMinute(M)} 分时涨幅 ${chgText(s.todayChange)} ≤ ${DROP_LIMIT_PCT}% 顺延`); continue; }
              const rz = resilienceAtMinute(s.c.code, M);
              if (!rz.ok || !(rz.value >= GLOBAL_RESILIENCE_MIN)) {
                blockReason.push(`${s.c.name} ${fmtMinute(M)} 抗分歧 ${rz.ok ? rz.value : '--'}${rz.ok ? '' : `（${rz.reason}）`} < ${GLOBAL_RESILIENCE_MIN} 顺延`);
                continue;
              }
              position = buildPosition({
                pick: s.c,
                minute: M,
                px: s.pt.lastPx,
                change: s.todayChange,
                gain: s.gain,
                resilience: rz.value,
                top3,
                prevDate,
                dateStr,
                n: N,
              });
              position.buyDi = di;
              position.resilienceIndex = resilienceIndexCodeOf(s.c.code);
              break;
            }
            if (position) break;
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
    trades: sortTradesByBuyTime(trades),
    currentHolding: holding,
    currentHoldings: holding ? [holding] : [],
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

const fmtSlope = (s) => (s == null ? '--' : Number(s).toFixed(4));

// 构建持仓对象（含买入原因与买点诊断明细；半仓单持仓，权重 0.5）
const buildPosition = ({ pick, minute, px, change, gain, resilience, top3, prevDate, dateStr, n }) => {
  const buyTimeText = fmtMinute(minute);
  const top3Text = top3.map(t => `${t.cat}(${fmtSlope(t.slope)})`).join('、');
  const buyReason = `${buyTimeText} 板块成交量占比（截止 ${prevDate}）3 日线斜率为正且最陡的前 3 板块「${top3Text}」成分股 ∩ 近 5 日连板 = ${pick.name}（${pick.code}，属 ${Array.from(pick.categories).join('、')}）；该股 N=${n} 日涨幅排名第一（+${Number(gain).toFixed(2)}%），${buyTimeText} 分时涨幅 ${chgText(change)}、抗分歧 ${resilience} ≥ ${GLOBAL_RESILIENCE_MIN}，按该分钟分时价 ${round2(px).toFixed(2)} 买入（半仓）`;
  const checks = [
    {
      id: 'vs_block_rank',
      title: '选股①：板块成交量占比 3 日线斜率 > 0 且最陡的前 3（剔除半导体/液冷/光通信/存储芯片/pcb）',
      passed: true,
      value: top3Text,
      reason: `以截止上一交易日 ${prevDate} 的成交量占比 3 日线斜率（斜率 = (r[i] - r[i-3]) / 3）排序，取斜率为正且最陡的前 3 板块（候选分类剔除 半导体/液冷/光通信/存储芯片/pcb）`,
    },
    {
      id: 'vs_pool',
      title: '选股②：前 3 板块成分股 ∩ 近 5 个交易日连板个股（交集）',
      passed: true,
      value: `${pick.name}（${pick.code}）· 属 ${Array.from(pick.categories).join('、')}`,
      reason: `候选 = 前 3 板块「东方财富板块成分股汇总/{分类}.json」的全部个股（bare code）与近 5 个交易日 lianbanSnapshot 连板个股（marketCode 去前缀）的交集（剔除黑名单）；同一股属多个前 3 板块时记录全部所属板块，卖出取任一转负者`,
    },
    {
      id: 'vs_gain_rank',
      title: `选股③：候选按 N=${n} 日涨幅最大排名，买入排名第一者`,
      passed: true,
      value: `${pick.name} N=${n} 日涨幅 +${Number(gain).toFixed(2)}%（窗口末位为 ${buyTimeText} 分时涨幅 ${chgText(change)}）`,
      reason: `N 日涨幅按复利口径（最近 ${n - 1} 个收盘日复利 × 当日 ${buyTimeText} 分时涨幅复利），降序排名取第一只通过筛选者`,
    },
    {
      id: 'vs_not_limit_up',
      title: `一字板/涨停顺延：买入时点未涨停（主板 < 9.5%、创·科 < 19%）`,
      passed: true,
      value: `买入时点分时涨幅 ${chgText(change)}`,
      reason: `买入时点已涨停的候选（主板 ≥ 9.5%、创业板/科创板 ≥ 19%）买不进，顺延至 N 日涨幅排名下一只`,
    },
    {
      id: 'vs_drop_ok',
      title: `当日分时涨幅 > ${DROP_LIMIT_PCT}%`,
      passed: true,
      value: `${chgText(change)}`,
      reason: `仅可买入当日分时涨幅 > ${DROP_LIMIT_PCT}% 的候选；≤ ${DROP_LIMIT_PCT}% 顺延下一只`,
    },
    {
      id: 'vs_resilience',
      title: `抗分歧指数 ≥ ${GLOBAL_RESILIENCE_MIN}（sh688→科创50 sh000688，其余→创业板指 sz399006）`,
      passed: true,
      value: `${resilience}（${buyTimeText}）`,
      reason: `买入时点抗分歧指数需 ≥ ${GLOBAL_RESILIENCE_MIN}（按截至 ${buyTimeText} 的分时现算）；不足者按 N 日涨幅排名顺延`,
    },
    {
      id: 'vs_position',
      title: `仓位与时段：半仓单持仓；买入仅限 9:40–11:30（9:40 起逐桶重试）`,
      passed: true,
      value: `半仓（权重 ${TWO_BUY_LEG_WEIGHT}）· ${buyTimeText}`,
      reason: `单持仓半仓买入（权重 ${TWO_BUY_LEG_WEIGHT}），收益率按半仓折算后逐笔复利；自 9:40 起在 9:40–11:30 的桶持续重试直到买进，当日无合格候选则当日不买`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name || pick.code,
    mode: 'offense',
    board: null,
    categories: Array.from(pick.categories),
    buyDate: dateStr,
    buyDateDisplay: dateStr,
    buyTime: buyTimeText,
    buyPrice: round2(px),
    buyChange: change,
    metric: gain,
    weight: TWO_BUY_LEG_WEIGHT,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runVolumeShareBacktest };
