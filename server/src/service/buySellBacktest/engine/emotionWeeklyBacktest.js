// 情绪周期-一周一次（2026-11-27 用户新增；仅回测；独立引擎）
//
// 买点（5 分钟成交额快照逐桶判定，三条同时满足）：
//   ① 大盘分时放量 ≥ 500 亿：成交额快照 amountChangeDiff（今日全市场累计成交额 − 昨日同期累计成交额，单位亿）≥ 500；
//   ② 往前数最近两个交易日「收盘口径」放量（当日最后一个成交额快照的 amountChangeDiff）均 < 500 亿；
//   ③ 创业板指（sz399006）与科创 50（sh000688）过去 10 分钟内均为上涨（当下涨幅 − 10 分钟前涨幅 > 0）；
//   买入时段沿用普通策略 9:30 – 13:30（13:30 之后的快照不再触发买入）。
// 选股：目标板块（半导体 / 光通信 / 光芯片 / cpo / MPO / 半导体材料 / CCL / pcb，光通信取「光模块 + 光纤」）
//       中取触发时点当日涨幅（成分股当日涨幅均值）最大的板块，再买该板块内当日分时涨幅最大的个股；
//       买点时刻已涨停（主板 > 9.5%、创业板/科创板 > 19%）则按涨幅排名顺延下一只；全部涨停则本次不买。
// 仓位：全仓单持仓（同一时间最多 1 只，未卖出前不再买入）。
// 卖点：完全复用「3日涨幅最大&三日情绪-30快进快出」的通用卖点——通用 7 条件卖点 + 盘中大跌强卖（-7%）；
//       该策略的快进快出专属机制（次日 10:00 强卖 / 快进快出半仓 / 冰点门禁 / 强卖豁免）均不启用。
const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  calcDailyMaInfo,
  clearTlineMemCache,
  getKeyBlockConstituents,
  getKlineCached,
  getSingleStockTlineDataByDate,
  getTrainingCampDates,
  loadTrainingCampData,
} = require('../deps');
const { getAmountSnapshot } = require('../../fundSnapshot');
const { buildReplayStocksWithTline, isLimitUpAtBuy } = require('./replayData');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { round2 } = require('./extremeWinScores');

const BUY_TIME_MAX_MINUTE = 1330;   // 买入时段上限（与普通策略一致）
const VOLUME_MIN_YI = 500;          // 大盘分时放量阈值：≥ 500 亿
const PRIOR_VOLUME_DAYS = 2;        // 往前两个交易日不得出现放量日（收盘口径）
const INDEX_RISE_WINDOW = 10;       // 创业板 / 科创板过去 10 分钟涨幅差 > 0
const CYB_INDEX_CODE = 'sz399006';  // 创业板指
const STAR_INDEX_CODE = 'sh000688'; // 科创 50
const BLOCK_COVERAGE_RATIO = 0.5;   // 板块当日涨幅 = 有效成分股当日涨幅均值，覆盖需 ≥ 50% 且不少于 2 只

// 目标板块（一个分类可由多个配置板块合并，如「光通信」= 光模块 + 光纤）
const TARGET_BLOCKS = [
  { label: '半导体', names: ['半导体'] },
  { label: '光通信', names: ['光模块', '光纤'] },
  { label: '光芯片', names: ['光芯片'] },
  { label: 'cpo', names: ['cpo'] },
  { label: 'MPO', names: ['MPO'] },
  { label: '半导体材料', names: ['半导体材料'] },
  { label: 'CCL', names: ['CCL'] },
  { label: 'pcb', names: ['pcb'] },
];

const toAbsMinute = (mm) => Math.floor(mm / 100) * 60 + (mm % 100);
const fmtMinute = (m) => (m != null
  ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`
  : '--');
const gainText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 成交额快照时间（HHMMSS，如 093500）→ 分钟（935）
const snapshotMinuteOf = (time) => {
  const digits = String(time == null ? '' : time).replace(/[^0-9]/g, '').padStart(6, '0');
  if (digits.length < 6) return null;
  const hh = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 100 + mm;
};

// 当日成交额快照列表：[{ minute, diff }]（diff = 今日累计成交额 − 昨日同期累计成交额，单位亿）
const getDayAmountList = (dateStr) => {
  const raw = getAmountSnapshot(dateStr) || [];
  const list = [];
  for (const a of raw) {
    const minute = snapshotMinuteOf(a?.time);
    const diff = Number(a?.amountChangeDiff);
    if (minute == null || !Number.isFinite(diff)) continue;
    list.push({ minute, diff });
  }
  list.sort((a, b) => toAbsMinute(a.minute) - toAbsMinute(b.minute));
  return list;
};

// 某交易日「收盘口径」放量（当日最后一个快照的 amountChangeDiff）；无快照返回 null（视为未放量，不拦截）
const closeDiffCache = new Map();
const getCloseAmountDiff = (dateStr) => {
  if (closeDiffCache.has(dateStr)) return closeDiffCache.get(dateStr);
  const list = getDayAmountList(dateStr);
  const value = list.length > 0 ? list[list.length - 1].diff : null;
  closeDiffCache.set(dateStr, value);
  return value;
};

const pointAtMinute = (points, minute) => {
  let hit = null;
  for (const p of points || []) {
    if (p.minute <= minute) hit = p;
    else break;
  }
  return hit;
};

const pointAtAbs = (points, absMinute) => {
  let hit = null;
  for (const p of points || []) {
    if (p.absMinute <= absMinute) hit = p;
    else break;
  }
  return hit;
};

// 读取某只股票/指数的分时（含 preclose），点按分钟升序
const loadDayTline = async (code, dateNum) => {
  try {
    const t = await getSingleStockTlineDataByDate(code, dateNum);
    const preclose = t?.preclose_px != null ? parseFloat(t.preclose_px) : null;
    const points = (t?.line || [])
      .filter((p) => p && p.minute != null && p.last_px != null && parseFloat(p.last_px) > 0)
      .map((p) => {
        const minute = parseInt(p.minute, 10);
        const lastPx = parseFloat(p.last_px);
        const change = p.change != null ? parseFloat(p.change) : null;
        return { minute, absMinute: toAbsMinute(minute), lastPx, change };
      })
      .filter((p) => Number.isFinite(p.minute) && p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
    if (!(preclose > 0) || points.length === 0) return null;
    for (const p of points) {
      if (p.change == null || !Number.isFinite(p.change)) p.change = ((p.lastPx - preclose) / preclose) * 100;
    }
    return { preclose, points };
  } catch (e) {
    return null;
  }
};

// 指数过去 N 分钟涨幅差（当下涨幅 − N 分钟前涨幅）
const indexRiseOverWindow = (tline, minute) => {
  const cur = pointAtMinute(tline.points, minute);
  const prev = pointAtAbs(tline.points, toAbsMinute(minute) - INDEX_RISE_WINDOW);
  if (!cur || !prev) return null;
  const diff = Number(cur.change) - Number(prev.change);
  return Number.isFinite(diff) ? round2(diff) : null;
};

// 构建当日买点触发桶（放量 ≥ 500 亿 + 前两日未放量 + 创业板/科创 10 分钟上涨）
const buildTriggers = async (dateStr, dateNum, prevCloseDiffs) => {
  if (prevCloseDiffs.some((v) => v != null && v >= VOLUME_MIN_YI)) return [];
  const list = getDayAmountList(dateStr).filter((x) => x.minute >= 930 && x.minute <= BUY_TIME_MAX_MINUTE && x.diff >= VOLUME_MIN_YI);
  if (list.length === 0) return [];
  const [cyb, star] = await Promise.all([
    loadDayTline(CYB_INDEX_CODE, dateNum),
    loadDayTline(STAR_INDEX_CODE, dateNum),
  ]);
  if (!cyb || !star) return [];
  const triggers = [];
  for (const item of list) {
    const cybRise = indexRiseOverWindow(cyb, item.minute);
    const starRise = indexRiseOverWindow(star, item.minute);
    if (cybRise == null || starRise == null) continue;
    if (!(cybRise > 0) || !(starRise > 0)) continue;
    triggers.push({ minute: item.minute, diff: item.diff, cybRise, starRise });
  }
  return triggers;
};

// 目标板块列表（合并同名分类；去重）
const buildTargetBlocks = () => {
  const all = getKeyBlockConstituents();
  const out = [];
  for (const def of TARGET_BLOCKS) {
    const seen = new Set();
    const members = [];
    for (const name of def.names) {
      for (const m of all.get(name) || []) {
        if (!m || !m.code || seen.has(m.code)) continue;
        seen.add(m.code);
        members.push({ code: m.code, name: m.name || m.code });
      }
    }
    if (members.length > 0) out.push({ label: def.label, members });
  }
  return out;
};

const requiredCoverage = (total) => Math.max(2, Math.ceil(total * BLOCK_COVERAGE_RATIO));

// 板块当日涨幅（有效成分股当日涨幅均值，覆盖不足返回 null）
const blockDayGain = (members, tlineMap, minute) => {
  const vals = [];
  for (const m of members) {
    const tl = tlineMap.get(m.code);
    if (!tl) continue;
    const pt = pointAtMinute(tl.points, minute);
    if (!pt || !(pt.lastPx > 0) || !(tl.preclose > 0)) continue;
    vals.push(((pt.lastPx - tl.preclose) / tl.preclose) * 100);
  }
  if (vals.length < requiredCoverage(members.length)) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

// 选股：取当日涨幅最大板块，再买板块内当日分时涨幅最大且未涨停的个股
const pickStock = (blocks, tlineMap, minute) => {
  const blockStats = [];
  for (const b of blocks) {
    const gain = blockDayGain(b.members, tlineMap, minute);
    if (gain == null) continue;
    blockStats.push({ ...b, gain: round2(gain) });
  }
  if (blockStats.length === 0) return null;
  blockStats.sort((a, b) => b.gain - a.gain);
  const best = blockStats[0];

  const candidates = [];
  for (const m of best.members) {
    const tl = tlineMap.get(m.code);
    if (!tl) continue;
    const pt = pointAtMinute(tl.points, minute);
    if (!pt || !(pt.lastPx > 0) || !(tl.preclose > 0)) continue;
    const currentPct = ((pt.lastPx - tl.preclose) / tl.preclose) * 100;
    candidates.push({ code: m.code, name: m.name, lastPx: pt.lastPx, currentPct: round2(currentPct) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.currentPct - a.currentPct);

  const skippedLimitUp = [];
  let picked = null;
  for (const c of candidates) {
    if (isLimitUpAtBuy(c.code, c.currentPct)) {
      skippedLimitUp.push(c);
      continue;
    }
    picked = c;
    break;
  }
  if (!picked) return null;
  return {
    block: best,
    blockGain: best.gain,
    blockStats,
    pick: picked,
    candidateCount: candidates.length,
    skippedLimitUp,
  };
};

const buildBuyChecks = (pos, prevCloseDiffs, prevDates) => {
  const t = pos.buyInfo;
  return [
    {
      id: 'ew_prior_volume',
      title: `往前 ${PRIOR_VOLUME_DAYS} 个交易日收盘口径放量均 < ${VOLUME_MIN_YI} 亿`,
      passed: true,
      value: prevCloseDiffs
        .map((v, i) => `${prevDates[i] ? fmtDate(prevDates[i]) : '--'} ${v == null ? '无快照' : `${v} 亿`}`)
        .join('、'),
      reason: `取前 ${PRIOR_VOLUME_DAYS} 个交易日当日最后一个成交额快照的 amountChangeDiff 作为收盘口径放量，均须 < ${VOLUME_MIN_YI} 亿（无快照不拦截）`,
    },
    {
      id: 'ew_intraday_volume',
      title: `大盘分时放量 ≥ ${VOLUME_MIN_YI} 亿`,
      passed: true,
      value: `${fmtMinute(t.triggerMinute)} 放量 ${t.volumeDiff} 亿`,
      reason: `成交额快照 amountChangeDiff = 今日全市场累计成交额 − 昨日同期累计成交额（单位亿），达到 ${VOLUME_MIN_YI} 亿视为放量`,
    },
    {
      id: 'ew_index_rise',
      title: `创业板指与科创 50 过去 ${INDEX_RISE_WINDOW} 分钟均为上涨`,
      passed: true,
      value: `创业板指 ${gainText(t.cybRise)}、科创 50 ${gainText(t.starRise)}（当下涨幅 − ${INDEX_RISE_WINDOW} 分钟前涨幅）`,
      reason: `以两只指数分时涨幅（change）计算过去 ${INDEX_RISE_WINDOW} 分钟的涨幅差，均须 > 0`,
    },
    {
      id: 'ew_block_pick',
      title: '选股：目标板块中当日涨幅最大板块内分时涨幅最大个股（涨停顺延）',
      passed: true,
      value: `板块「${t.blockLabel}」当日涨幅 ${gainText(t.blockGain)} 为全部目标板块最高，选中 ${pos.stockName}（当日 ${gainText(t.pickCurrentPct)}）`
        + (t.skippedLimitUp.length > 0
          ? `；涨停顺延 ${t.skippedLimitUp.map((x) => `${x.name}(${gainText(x.currentPct)})`).join('、')}`
          : ''),
      reason: '板块当日涨幅 = 有效成分股当日涨幅均值（覆盖 ≥ 50% 且 ≥ 2 只）；个股按当日分时涨幅降序取第一只未涨停者，主板涨幅 > 9.5%、创业板/科创板 > 19% 视为涨停',
    },
    {
      id: 'ew_full_position',
      title: '仓位：全仓买入',
      passed: true,
      value: `成交价 ${pos.buyPrice.toFixed(2)}，仓位 100%`,
      reason: '全仓单持仓，未卖出前不再买入其它股票',
    },
  ];
};

const fmtDate = (dateStr) => `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;

// 将非自选股的持仓个股补进当日时间桶与回放数据（通用 7 条件卖点依赖 stockChanges 的现价/涨幅/均线字段）
const injectHeldStock = async (pos, dateStr, dateNum, timeBuckets, replayStocks, maCache) => {
  const inBuckets = timeBuckets.some((b) => (b.stockChanges || []).some((s) => s.code === pos.code));
  if (inBuckets) return;
  const tline = await loadDayTline(pos.code, dateNum);
  if (!tline) return;
  let maInfo = maCache.get(pos.code);
  if (!maInfo) {
    try {
      maInfo = calcDailyMaInfo(await getKlineCached(pos.code, dateStr), dateStr);
    } catch (e) {
      maInfo = null;
    }
    maCache.set(pos.code, maInfo);
  }
  for (const b of timeBuckets) {
    const pt = pointAtMinute(tline.points, Number(b.minute));
    b.stockChanges = b.stockChanges || [];
    b.stockChanges.push({
      code: pos.code,
      name: pos.stockName,
      lastPx: pt ? pt.lastPx : null,
      changePct: pt && tline.preclose > 0 ? ((pt.lastPx - tline.preclose) / tline.preclose) * 100 : null,
      dailyMa5: maInfo?.ma5 ?? null,
      dailyMa5Slope: maInfo?.ma5Slope ?? null,
      dailyMa10: maInfo?.ma10 ?? null,
      dailyMa10Slope: maInfo?.ma10Slope ?? null,
      dailyPrevLow: maInfo?.prevLow ?? null,
      resilience3dScores: [],
      resilience3dValid: false,
    });
  }
  if (!replayStocks.some((s) => s.code === pos.code)) {
    replayStocks.push({
      code: pos.code,
      stockName: pos.stockName,
      tlinePoints: tline.points.map((p) => ({ minute: p.minute, change: p.change, lastPx: p.lastPx })),
      dailyLowMap: maInfo?.dailyLowMap || null,
    });
  }
};

const runEmotionWeeklyBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.moodWeeklyMode !== true) {
    return { success: false, message: '未找到「情绪周期-一周一次」策略' };
  }

  if (onProgress) onProgress({ current: 0, total: 0, date: '', status: 'loading' });

  const allDates = getTrainingCampDates().slice().sort();
  const rangeDates = allDates.filter((d) => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) return { success: false, message: '所选日期范围内无可回测交易日' };

  const blocks = buildTargetBlocks();
  const blockCodes = new Set();
  for (const b of blocks) for (const m of b.members) blockCodes.add(m.code);

  const positions = []; // 全仓单持仓
  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map();
  const lastPxByCode = new Map(); // code -> 最近一个有效分时价（期末持仓估值兜底）

  for (let di = 0; di < total; di += 1) {
    const dateStr = rangeDates[di];
    const dateDisplay = fmtDate(dateStr);
    const dateNum = parseInt(dateStr, 10);
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

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
      skippedDates.push({ date: dateStr, message: '无回放数据' });
      continue;
    }

    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);

    // 最近两个交易日「收盘口径」放量
    const allIdx = allDates.indexOf(dateStr);
    const prevDates = [];
    const prevCloseDiffs = [];
    for (let k = 1; k <= PRIOR_VOLUME_DAYS; k += 1) {
      const d = allIdx - k >= 0 ? allDates[allIdx - k] : null;
      prevDates.push(d);
      prevCloseDiffs.push(d ? getCloseAmountDiff(d) : null);
    }

    // 当日买点触发桶（未触发时不加载板块分时）
    const triggers = await buildTriggers(dateStr, dateNum, prevCloseDiffs);
    const triggerByMinute = new Map(triggers.map((t) => [t.minute, t]));
    const tlineMap = new Map();
    if (triggers.length > 0) {
      await batchParallel(Array.from(blockCodes), async (code) => {
        const t = await loadDayTline(code, dateNum);
        if (t) tlineMap.set(code, t);
      }, 8);
      for (const m of blockCodes) {
        if (!seenStocks.has(m)) {
          const member = blocks.flatMap((b) => b.members).find((x) => x.code === m);
          if (member) seenStocks.set(m, { code: m, name: member.name });
        }
      }
    }

    // 隔夜持仓：保证通用卖点所需的当日现价/涨幅/均线数据齐全（非自选股补进时间桶与回放数据）
    const maCache = new Map();
    for (const pos of positions) {
      if (dateStr <= pos.buyDate) continue;
      await injectHeldStock(pos, dateStr, dateNum, timeBuckets, replayStocks, maCache);
      const tl = tlineMap.get(pos.code) || await loadDayTline(pos.code, dateNum);
      if (tl && tl.points.length > 0) lastPxByCode.set(pos.code, tl.points[tl.points.length - 1].lastPx);
    }

    // 逐桶：先卖（通用 7 条件 + 盘中大跌强卖），后买
    for (let bi = 0; bi < timeBuckets.length; bi += 1) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);

      await generalSellPositions({ positions, strategy, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades: trades });

      if (positions.length > 0) continue;
      const trigger = triggerByMinute.get(bucketMinute);
      if (!trigger) continue;

      const sel = pickStock(blocks, tlineMap, bucketMinute);
      if (!sel) continue;

      const pos = {
        code: sel.pick.code,
        stockName: sel.pick.name,
        buyDate: dateStr,
        buyDateDisplay: dateDisplay,
        buyTime: fmtMinute(bucketMinute),
        buyMinute: bucketMinute,
        buyPrice: round2(sel.pick.lastPx),
        buyChange: round2(sel.pick.currentPct),
        metric: null,
        buyReason: `大盘分时放量 ${trigger.diff} 亿（≥ ${VOLUME_MIN_YI} 亿，前两日收盘口径未放量），`
          + `创业板指 ${gainText(trigger.cybRise)}、科创 50 ${gainText(trigger.starRise)}（过去 ${INDEX_RISE_WINDOW} 分钟上涨），`
          + `目标板块「${sel.block.label}」当日涨幅 ${gainText(sel.blockGain)} 最高，`
          + `买入板块内分时涨幅最大 ${sel.pick.name}（当日 ${gainText(sel.pick.currentPct)}）`
          + `${sel.skippedLimitUp.length > 0 ? `，涨停顺延 ${sel.skippedLimitUp.map((x) => x.name).join('、')}` : ''}`
          + `，${fmtMinute(bucketMinute)} 价 ${round2(sel.pick.lastPx).toFixed(2)}（全仓）`,
        buyChecks: [],
        buyInfo: {
          triggerMinute: bucketMinute,
          volumeDiff: round2(trigger.diff),
          cybRise: trigger.cybRise,
          starRise: trigger.starRise,
          blockLabel: sel.block.label,
          blockGain: sel.blockGain,
          candidateCount: sel.candidateCount,
          pickCurrentPct: sel.pick.currentPct,
          skippedLimitUp: sel.skippedLimitUp,
        },
      };
      pos.buyChecks = buildBuyChecks(pos, prevCloseDiffs, prevDates);
      positions.push(pos);

      const tl = tlineMap.get(sel.pick.code);
      if (tl && tl.points.length > 0) lastPxByCode.set(sel.pick.code, tl.points[tl.points.length - 1].lastPx);
    }

    clearTlineMemCache();
  }

  // ---- 组装结果 ----
  const currentHoldings = [];
  for (const pos of positions) {
    const h = { ...pos };
    const closePx = lastPxByCode.get(pos.code) ?? null;
    const rawBuyReturn = closePx != null && pos.buyPrice > 0
      ? round2(((closePx - pos.buyPrice) / pos.buyPrice) * 100)
      : null;
    h.buyReturn = rawBuyReturn;
    h.rawBuyReturn = rawBuyReturn;
    currentHoldings.push(h);
  }

  const overallReturn = (() => {
    let acc = 1;
    for (const t of trades) {
      if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
    }
    for (const h of currentHoldings) acc *= 1 + (h.buyReturn || 0) / 100;
    return round2((acc - 1) * 100);
  })();

  const validTrades = trades.filter((t) => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter((t) => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (currentHoldings.length > 0) await attachBuyDayReturn(currentHoldings);

  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: sortTradesByBuyTime(trades),
    currentHolding: currentHoldings[0] || null,
    currentHoldings,
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

module.exports = { runEmotionWeeklyBacktest };
