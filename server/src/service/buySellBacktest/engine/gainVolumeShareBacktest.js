const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getSingleStockTlineDataByDateLean,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  stockDailyChange,
  clearTlineMemCache,
  fs,
  path,
} = require('../deps');
const { EXCLUDED_CODES } = require('../constants');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { round2 } = require('./extremeWinScores');
const { buildReplayStocksWithTline } = require('./replayData');
const { buildKeyBlockSyntheticBucketEntry, buildKeyBlockSyntheticDay } = require('./keyBlockSynthetic');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { getBlockCategoryRatio } = require('../../板块成交量占比计算/category_amount_money');

// ============================================================
// N 日涨幅最大-成交量占比（gainVolumeShareMode: true，2026-10-25 用户新增；独立引擎；N = 2 / 3 / 4 / 5）
//   选股（每日按 D 的前一交易日 T-1 数据判定）：
//     ① 板块：33 个一级板块中，T-1 成交量占比的 3 日线斜率为正、且 T-1 占比较此前 5 个交易日最低占比
//        高出 30% 以上，且该最低占比本身 > 5%；多个板块同时满足时取「占比(T-1) − 占比(T-2)」差值最大者：
//     ② 个股：该板块成分股中仅保留沪深主板（60/00）、创业板（30）、科创板（68），
//        按最近 N 日涨幅（复利口径：最近 N-1 个收盘日复利 × 当日 9:40 分时涨幅）降序取前 5；
//     ③ 买点：只在 9:40 单点，按排名从前到后取第一只满足「9:40 未涨停 + 9:40 分时涨幅 > 0
//        + 9:40 现价 > 当日开盘价」的股票买入（全仓单持仓），无合格候选则当日跳过（不逐桶重试）；
//   卖点：与「N 日涨幅最大」一致（通用 7 条件卖点 + 盘中大跌 -7% 强卖），非自选股持仓用合成逐桶数据。
// ============================================================

const BOARD_DIR = path.resolve(__dirname, '../../../data/东方财富板块成分股汇总');
const BOARD_MAP_FILE = path.join(BOARD_DIR, 'meta', '东财板块到本地板块map.json');
const RATIO_LOOKBACK = 6; // 选板块窗口：T-6 ~ T-1（T-1 与此前 5 个交易日最低占比比较 + 3 日线斜率比较）
const RATIO_RISE_THRESHOLD = 0.3; // T-1 占比较前 5 日最低占比的最小涨幅（30%）
const RATIO_MIN_FLOOR = 5;        // 前 5 日最低占比必须大于 5%（过滤低占比板块）
const BUY_MINUTE = 940;    // 唯一买点：9:40
const TOP_N = 5;           // 涨幅排名前 5 再逐一筛选买点条件

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const stripPrefix = (code) => String(code || '').replace(/^(sh|sz|bj)/i, '');
// 市场涨停口径：主板（60/00）9.5% / 创业板·科创板（30/68）19%
const limitUpThresholdOf = (code) => (/^(68|30)/.test(stripPrefix(code)) ? 19 : 9.5);
const chgText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
const round4 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : parseFloat(Number(v).toFixed(4)));

// 33 个一级板块名称（map.json 的键，与 板块成交量占比 分类一致）
let categoryCache = null;
const loadCategories = () => {
  if (categoryCache) return categoryCache;
  const raw = JSON.parse(fs.readFileSync(BOARD_MAP_FILE, 'utf-8'));
  categoryCache = Object.keys(raw && typeof raw === 'object' ? raw : {});
  return categoryCache;
};

// 各分类成交量占比序列（按日期升序）；启动一次性加载，失败抛错
let ratioSeriesCache = null;
const loadRatioSeries = () => {
  if (ratioSeriesCache) return ratioSeriesCache;
  const raw = getBlockCategoryRatio(null, null);
  const m = new Map();
  for (const cat of loadCategories()) {
    const rows = Array.isArray(raw[cat]) ? raw[cat] : [];
    m.set(cat, rows
      .filter(r => r && r.date != null && Number.isFinite(Number(r.ratio)))
      .map(r => ({ date: String(r.date), ratio: Number(r.ratio) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
  }
  ratioSeriesCache = m;
  return m;
};

// 板块成分股（按需逐分类加载，仅保留沪深主板/创业板/科创板）；返回 [{ code(带前缀), name }]
const constituentCache = new Map();
const loadConstituents = (cat) => {
  if (constituentCache.has(cat)) return constituentCache.get(cat);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(path.join(BOARD_DIR, `${cat}.json`), 'utf-8')); } catch (e) { arr = []; }
  const list = [];
  for (const it of (Array.isArray(arr) ? arr : [])) {
    if (!it || !it.code) continue;
    const bare = String(it.code);
    if (!/^(60|68|00|30)/.test(bare)) continue; // 仅沪深主板 60/00、创业板 30、科创板 68
    const code = /^6/.test(bare) ? `sh${bare}` : `sz${bare}`;
    if (EXCLUDED_CODES.has(code)) continue;
    list.push({ code, name: it.name || bare });
  }
  constituentCache.set(cat, list);
  return list;
};

// 选取板块：T-1 成交量占比的 3 日线斜率为正，T-1 占比高于此前 5 个交易日的最低占比 30% 以上，
// 且该最低占比本身大于 5%（过滤低占比板块）；多个板块同时满足时取 T-1−T-2 增幅最大者
//（差值越大代表资金流入越多，越可能是主线板块）
const selectMainBlock = (seriesMap, t1) => {
  const ref = String(t1);
  const qualified = [];
  for (const cat of loadCategories()) {
    const rows = seriesMap.get(cat) || [];
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].date <= ref) idx = i; else break;
    }
    if (idx < 0) continue;
    const window = rows.slice(Math.max(0, idx - RATIO_LOOKBACK + 1), idx + 1);
    if (window.length < RATIO_LOOKBACK) continue;           // 数据不足（T-6 ~ T-1 共 6 个交易日）
    if (window[window.length - 1].date !== ref) continue;   // 缺少 T-1 当日占比
    const last = window[window.length - 1].ratio;           // T-1
    const prev = window[window.length - 2].ratio;           // T-2
    // 3 日线：MA3(T-1)=均(T-3,T-2,T-1)，MA3(T-2)=均(T-4,T-3,T-2)，斜率为正即 MA3(T-1) > MA3(T-2)
    const ma3Last = (window[window.length - 3].ratio + window[window.length - 2].ratio + last) / 3;
    const ma3Prev = (window[window.length - 4].ratio + window[window.length - 3].ratio + window[window.length - 2].ratio) / 3;
    // 更往前的 5 个交易日（T-6 ~ T-2）最低占比
    const priorMin = Math.min(...window.slice(0, window.length - 1).map(r => r.ratio));
    if (!(ma3Last > ma3Prev + 1e-9)) continue;              // 3 日线斜率为正
    if (!(priorMin > 0 && last - priorMin >= priorMin * RATIO_RISE_THRESHOLD - 1e-9)) continue; // T-1 占比较前 5 日最低值高出 ≥ 30%
    if (!(priorMin > RATIO_MIN_FLOOR)) continue;            // 前 5 日最低占比须 > 5%
    qualified.push({
      cat,
      last,
      prev,
      diff: round4(last - prev),
      ma3Last: round4(ma3Last),
      ma3Prev: round4(ma3Prev),
      priorMin: round4(priorMin),
      risePct: round4(((last - priorMin) / priorMin) * 100),
    });
  }
  if (qualified.length === 0) return null;
  qualified.sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));
  return qualified[0];
};

// 9:40 买点快照：开盘价（当日分时首点）、9:40 现价与分时涨幅（较昨收）
const loadBuySnapshot = async (code, dateNum) => {
  try {
    const t = await getSingleStockTlineDataByDateLean(code, dateNum);
    const preclose = t?.preclose_px != null ? parseFloat(t.preclose_px) : null;
    const line = (t?.line || [])
      .filter(p => p && p.minute != null && p.last_px != null && parseFloat(p.last_px) > 0)
      .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px) }))
      .filter(p => Number.isFinite(p.minute))
      .sort((a, b) => a.minute - b.minute);
    if (!(preclose > 0) || line.length === 0) return null;
    let at = null;
    for (const p of line) { if (p.minute <= BUY_MINUTE) at = p; else break; }
    if (!at || !(at.lastPx > 0)) return null;
    return {
      openPx: line[0].lastPx,
      px: at.lastPx,
      minute: at.minute,
      change: round2(((at.lastPx - preclose) / preclose) * 100),
    };
  } catch (e) {
    return null;
  }
};

const runGainVolumeShareBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.gainVolumeShareMode !== true) {
    return { success: false, message: `未知 N 日涨幅最大-成交量占比策略: ${strategyId}` };
  }
  const N = Number(strategy.gainVolumeShareDays);
  if (!(N >= 2)) {
    return { success: false, message: `N 日涨幅最大-成交量占比策略配置错误（gainVolumeShareDays=${strategy.gainVolumeShareDays}）` };
  }

  let seriesMap;
  try {
    seriesMap = loadRatioSeries();
    loadCategories();
  } catch (e) {
    return { success: false, message: `板块成交量占比数据不可用：${e.message || e}` };
  }

  const allDates = getTrainingCampDates();
  const rangeDates = allDates.filter(d => String(d) >= String(startDate) && String(d) <= String(endDate)).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }
  let position = null;

  for (let di = 0; di < total; di++) {
    const dateStr = String(rangeDates[di]);
    const dateNum = parseInt(dateStr, 10);
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    const isHolding = position != null && dateStr > position.buyDate;

    // ===== 卖点（隔夜持仓）：通用 7 条件 + 盘中大跌强卖；非自选股持仓合成逐桶数据 =====
    if (isHolding) {
      let campData;
      try {
        campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
      } catch (e) {
        skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
        clearTlineMemCache();
        continue;
      }
      if (!campData || campData.success === false) {
        skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
        clearTlineMemCache();
        continue;
      }
      const timeBuckets = campData.timeBuckets || [];
      if (timeBuckets.length === 0) {
        skippedDates.push({ date: dateStr, message: '无时间桶数据' });
        clearTlineMemCache();
        continue;
      }
      const dateDisplay = campData.dateDisplay || dateStr;
      const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
      const synth = await buildKeyBlockSyntheticDay(position.code, position.stockName, dateStr);
      let sellBuckets = timeBuckets;
      let sellReplayStocks = replayStocks;
      if (synth) {
        sellBuckets = timeBuckets.map(b => {
          const entry = buildKeyBlockSyntheticBucketEntry(position.code, position.stockName, synth.sortedPoints, synth.maInfo, synth.r3d, Number(b.minute));
          return entry ? { ...b, stockChanges: [...(b.stockChanges || []), entry] } : b;
        });
        sellReplayStocks = [...replayStocks, synth.replayEntry];
      }

      let buyAttempted = false;
      for (let bi = 0; bi < sellBuckets.length; bi++) {
        const bucketMinute = Number(sellBuckets[bi].minute);
        // 9:40 买点窗口只在「首个 ≥9:40 的桶」打开一次：若此时仍持仓（或已被卖出）都消费掉本次机会，
        // 避免盘中卖出后（如 10:00）再用 9:40 的价格回补，导致买点时间早于上一笔卖点时间
        if (!buyAttempted && bucketMinute >= BUY_MINUTE) {
          buyAttempted = true;
          if (!position) {
            position = await tryBuy(dateStr, dateNum, N, seriesMap, seenStocks, onProgress);
          }
        }
        if (!position) continue;
        const arr = [position];
        await generalSellPositions({
          positions: arr,
          strategy,
          bi,
          replayStocks: sellReplayStocks,
          timeBuckets: sellBuckets,
          dateStr,
          dateDisplay,
          singleTrades: trades,
        });
        if (arr.length === 0) position = null;
      }
    } else if (!position) {
      // ===== 买点（空仓）：只在 9:40 单点尝试一次，无合格候选当日跳过 =====
      if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });
      position = await tryBuy(dateStr, dateNum, N, seriesMap, seenStocks, onProgress);
    }
    // 每日结束释放分时内存缓存：本策略单日会批量加载命中板块数百只成分股的 9:40 分时，
    // 若跨日累积（tlineFileMemCache / tlineResultMemCache）全区间回测会撑爆堆内存（磁盘缓存不受影响）
    clearTlineMemCache();
  }

  // 组装结果（type:'single'：全仓单持仓）
  let holding = null;
  if (position) {
    holding = { ...position };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
    if (closePx != null && closePx > 0 && position.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - position.buyPrice) / position.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn;
  }
  let acc = 1;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
  }
  if (holding) acc *= 1 + (holding.buyReturn || 0) / 100;
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

// 当日 9:40 买点：选板块 → 板块成分股按 N 日涨幅取前 5 → 排名从前到后取第一只满足条件的买入
const tryBuy = async (dateStr, dateNum, N, seriesMap, seenStocks) => {
  const prevTen = await getPastTradingDates(dateStr, RATIO_LOOKBACK);
  if (prevTen.length < RATIO_LOOKBACK) return null;
  const t1 = String(prevTen[prevTen.length - 1]);
  const t2 = String(prevTen[prevTen.length - 2]);
  const block = selectMainBlock(seriesMap, t1, t2);
  if (!block) return null;

  const constituents = loadConstituents(block.cat);
  if (constituents.length === 0) return null;

  const prevDates = await getPastTradingDates(dateStr, N - 1);
  if (prevDates.length < N - 1) return null;

  try { await ensureBarsForCodes(new Set(constituents.map(c => c.code))); } catch (e) { /* 缺失个股按无效处理 */ }

  // 先算 N-1 个历史收盘日涨幅复利乘积（无效者剔除）
  const priorList = [];
  for (const c of constituents) {
    let prod = 1;
    let ok = true;
    for (const d of prevDates) {
      const ch = stockDailyChange(c.code, d);
      if (ch == null || !Number.isFinite(Number(ch))) { ok = false; break; }
      prod *= 1 + Number(ch) / 100;
    }
    if (!ok) continue;
    priorList.push({ ...c, priorProd: prod });
  }
  if (priorList.length === 0) return null;

  // 9:40 分时快照 + 当日涨幅复利，得到 N 日涨幅
  const snaps = [];
  await batchParallel(priorList, async (c) => {
    const s = await loadBuySnapshot(c.code, dateNum);
    if (!s) return null;
    const gain = round4((c.priorProd * (1 + s.change / 100) - 1) * 100);
    if (gain == null || !Number.isFinite(gain)) return null;
    snaps.push({ ...c, ...s, gain });
    return null;
  }, 8);
  if (snaps.length === 0) return null;

  snaps.sort((a, b) => b.gain - a.gain);
  const top5 = snaps.slice(0, TOP_N);
  for (const c of top5) {
    if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name });
  }

  // 排名从前到后：9:40 未涨停 + 分时涨幅 > 0 + 现价 > 当日开盘价
  const chosen = top5.find(s => s.change > 0 && s.px > s.openPx && s.change < limitUpThresholdOf(s.code));
  if (!chosen) return null;

  const rank = top5.indexOf(chosen) + 1;
  const top5Text = top5.map((s, i) => `${i + 1}.${s.name}(${s.code}) ${chgText(s.gain)}`).join('、');
  const diffText = block.diff != null ? `${block.diff > 0 ? '+' : ''}${Number(block.diff).toFixed(4)}pp` : '--';
  const buyReason = `板块「${block.cat}」上一交易日 ${t1} 成交量占比 ${Number(block.last).toFixed(4)}%，3 日线 ${Number(block.ma3Last).toFixed(4)}% 高于前一日 ${Number(block.ma3Prev).toFixed(4)}%（斜率为正），且较此前 5 个交易日最低占比 ${Number(block.priorMin).toFixed(4)}% 高出 ${Number(block.risePct).toFixed(2)}%（≥30%，前5日最低 >5%）；较 ${t2} 变化 ${diffText}，为该系列中增幅最大者；该板块沪深主板/创业板/科创板成分股 ${constituents.length} 只，按最近 ${N} 日涨幅（含当日 9:40 分时 ${chgText(chosen.change)}）排名前 5：${top5Text}；9:40 买入排名第 ${rank} 且未涨停、分时涨幅为正、现价高于开盘价（开 ${chosen.openPx.toFixed(2)} → 9:40 ${chosen.px.toFixed(2)}）的 ${chosen.name}（${chosen.code}），买入价 ${chosen.px.toFixed(2)}（全仓）`;

  const buyChecks = [
    {
      id: 'gvs_block',
      title: '选股①：上一交易日成交量占比的 3 日线斜率为正、且较此前 5 个交易日最低占比高出 30% 以上（该最低占比须 >5%）的板块（多个满足时取增幅最大者）',
      passed: true,
      value: `${block.cat} ${Number(block.last).toFixed(4)}%（${t1}，3日线 ${Number(block.ma3Last).toFixed(4)}% > ${Number(block.ma3Prev).toFixed(4)}%，前5日最低 ${Number(block.priorMin).toFixed(4)}%，高出 ${Number(block.risePct).toFixed(2)}%；较 ${t2} ${diffText}）`,
      reason: `对 33 个一级板块，取截止 ${t1} 的成交量占比序列：要求 MA3(${t1}) 高于 MA3(${t2})（3 日线斜率为正），且 ${t1} 占比较 ${t1} 之前 5 个交易日（T-6 ~ T-2）的最低占比高出 30% 及以上（即 (占比(${t1}) − 最低占比) ÷ 最低占比 ≥ 30%），同时该最低占比本身须大于 5%（过滤低占比板块）；多个板块同时满足时取「占比(${t1}) − 占比(${t2})」差值最大者（差值越大代表资金流入越多，越可能是主线板块）`,
    },
    {
      id: 'gvs_pool',
      title: '选股②：该板块成分股仅取沪深主板（60/00）、创业板（30）、科创板（68）',
      passed: true,
      value: `${constituents.length} 只`,
      reason: `读取「东方财富板块成分股汇总/${block.cat}.json」，剔除北交所等非沪深主板/创业板/科创板个股及黑名单个股后作为候选池`,
    },
    {
      id: 'gvs_top5',
      title: `选股③：候选按最近 ${N} 日涨幅（含当日 9:40 分时，复利口径）降序取前 ${TOP_N}`,
      passed: true,
      value: top5Text,
      reason: `N 日涨幅 = 最近 ${N - 1} 个交易日收盘涨幅复利 × 当日 9:40 分时涨幅（较昨收）复利；按降序排名取前 ${TOP_N} 只（历史日K缺失者视为无效）`,
    },
    {
      id: 'gvs_gain_rank',
      title: `买点：在前 ${TOP_N} 中按排名从前到后取第一只满足条件的股票`,
      passed: true,
      value: `排名第 ${rank}：${chosen.name}（${chosen.code}）`,
      reason: `按 N 日涨幅排名依次检查，首个满足「9:40 未涨停 + 分时涨幅 > 0 + 现价 > 开盘价」者买入；前 ${TOP_N} 均不满足则当日跳过`,
    },
    {
      id: 'gvs_not_limit_up',
      title: '9:40 未涨停（主板 < 9.5%、创业板/科创板 < 19%）',
      passed: true,
      value: `9:40 分时涨幅 ${chgText(chosen.change)}（阈值 ${limitUpThresholdOf(chosen.code)}%）`,
      reason: `买入时点已涨停（主板 ≥ 9.5%、创业板/科创板 ≥ 19%）的股票买不进，排名顺延下一只`,
    },
    {
      id: 'gvs_positive_above_open',
      title: '9:40 分时涨幅 > 0 且现价高于当日开盘价',
      passed: true,
      value: `${chgText(chosen.change)}，开 ${chosen.openPx.toFixed(2)} → 9:40 ${chosen.px.toFixed(2)}`,
      reason: `分时涨幅（较昨收）必须为正，且 9:40 现价必须高于当日开盘价（首分钟价），否则排名顺延下一只`,
    },
    {
      id: 'gvs_buy_point',
      title: '买点时段：仅 9:40 单点（不逐桶重试）',
      passed: true,
      value: `${fmtMinute(chosen.minute)} 买入，全仓`,
      reason: `不看 9:40 以外的时点：当日 9:40 无合格候选则跳过当日；单持仓全仓买入，卖点与「${N}日涨幅最大」一致（通用 7 条件 + 盘中大跌 -7% 强卖）`,
    },
  ];

  return {
    code: chosen.code,
    stockName: chosen.name,
    buyDate: dateStr,
    buyDateDisplay: dateStr,
    buyTime: fmtMinute(chosen.minute),
    buyPrice: round2(chosen.px),
    buyChange: chosen.change,
    metric: chosen.gain,
    blockCategory: block.cat,
    buyReason,
    buyChecks,
  };
};

module.exports = { runGainVolumeShareBacktest };
