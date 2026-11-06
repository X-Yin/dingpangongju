// 情绪周期-板块共振大盘（2026-11-04 由「情绪周期-板块轮换-N 日涨幅最大」三策略重构合并；仅回测；独立引擎）
//
// 买点（每 5 分钟桶判定，需同时满足）：
//   1) 创业板指（sz399006）在最近 5 分钟内上涨 > 0.5%；
//   2) 主力资金在最近 5 分钟内净流入 > 10 亿；
//   3) 大盘成交量在最近 5 分钟内放大 > 50 亿；
//   4) 从全部重点板块（成分股去重后 ≥ 5 只）中选出这 5 分钟涨幅最大的板块；
//   5) 买入该板块内这 5 分钟涨幅最大的股票；已涨停则按涨幅排名顺延下一只
//      （同时跳过已持仓的同股）。
//
// 仓位：账户拆两份、每份半仓（权重 0.5）：
//   · 空仓时第一份仅限上午（≤ 11:30）买入；
//   · 只持有一份时，第二份可在上午（≤ 11:30）或下午 13:00–14:00 买入；
//   · 两份不得落在同一交易日的同一个半天（同一日只能上午→下午；跨日则上午/下午均可），
//     即两份买入时点至少相隔半天。
//
// 卖点：与「情绪游资-极致胜率」顺周期腿完全一致：
//   · 分钟级价格类卖点（成本线 -5% 且不设持续分钟、跌停、盘中跌幅、开盘下挫、单分钟跳水、
//     高位大阴线、⑪竞价大幅低开冲高回落、⑫开盘自救），逐分钟回溯取最先触发分钟；
//   · ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10% → 尾盘卖；
//   · ⑥ 当日收盘抗分歧指数 < 6 → 尾盘卖。
const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  clearTlineMemCache,
  ensureBarsForCodes,
  getKeyBlockConstituents,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
} = require('../deps');
const { getFundSnapshot, getAmountSnapshot } = require('../../fundSnapshot');
const { getTechIndexDates } = require('../utils/techEmotion');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { round2, limitUpThresholdOf } = require('./extremeWinScores');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

const BLOCK_MEMBER_MIN = 5;                 // 板块内股票个数 ≥ 5
const BLOCK_COVERAGE_RATIO = 0.5;           // 板块均值至少覆盖 50% 成分股，且不少于 5 只
const CYB_INDEX_CODE = 'sz399006';          // 创业板指
const WINDOW_MINUTES = 5;                   // 5 分钟窗口
const CYB_GAIN_MIN_PCT = 0.5;               // 创业板指 5 分钟涨幅 > 0.5%
const FUND_INFLOW_MIN = 10;                 // 主力资金 5 分钟净流入 > 10 亿
const AMOUNT_EXPAND_MIN = 50;               // 大盘成交量 5 分钟放大 > 50 亿
const MAX_POSITIONS = 2;                    // 两份半仓
const MORNING_END_MINUTE = 1130;            // 上午最晚买入分钟
const AFTERNOON_START_MINUTE = 1300;        // 下午买入窗口起
const AFTERNOON_END_MINUTE = 1400;          // 下午买入窗口止
const TAIL_MINUTE = 1457;                   // 尾盘判定分钟（与极致胜率一致）
const WEAK_TRADE_HOLD_DAYS = 3;             // 持仓第 3 个交易日尾盘
const WEAK_TRADE_MIN_GAIN_PCT = 10;         // 收益仍未拉开至 +10%
const RESILIENCE_SELL_MAX = 6;              // 收盘抗分歧指数 < 6
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001';

const toAbsMinute = (mm) => Math.floor(mm / 100) * 60 + (mm % 100);
const fmtMinute = (m) => (m != null
  ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`
  : '--');
const gainText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 快照时间（HHMMSS，如 093500 / 130500）转分钟（935 / 1305）
const snapshotMinuteOf = (time) => {
  const digits = String(time == null ? '' : time).replace(/[^0-9]/g, '').padStart(6, '0');
  if (digits.length < 6) return null;
  const hh = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 100 + mm;
};

// 标准分钟轴（09:30–11:30、13:00–15:00，逐分钟）
const MINUTE_AXIS = (() => {
  const out = [];
  const pushRange = (sh, sm, eh, em) => {
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    for (let t = start; t <= end; t += 1) {
      const h = Math.floor(t / 60);
      const m = t % 60;
      out.push({ minute: h * 100 + m });
    }
  };
  pushRange(9, 30, 11, 30);
  pushRange(13, 0, 15, 0);
  return out;
})();

const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) {
    if (p.minute <= minute) atPt = p;
    else break;
  }
  return atPt;
};

// 按日读取分时（走按日捆绑缓存 getSingleStockTlineDataByDate，避免整份全历史文件读盘）
const loadDayTline = async (code, dateNum) => {
  try {
    const t = await getSingleStockTlineDataByDate(code, dateNum);
    const preclose = t?.preclose_px != null ? parseFloat(t.preclose_px) : null;
    const points = (t?.line || [])
      .filter((p) => p && p.minute != null && p.last_px != null && parseFloat(p.last_px) > 0)
      .map((p) => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px) }))
      .filter((p) => Number.isFinite(p.minute) && p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
    if (!(preclose > 0) || points.length === 0) return null;
    return { preclose, points };
  } catch (e) {
    return null;
  }
};

const requiredCoverage = (total) => Math.max(BLOCK_MEMBER_MIN, Math.ceil(total * BLOCK_COVERAGE_RATIO));

const isBuyWindowMinute = (minute) => minute <= MORNING_END_MINUTE
  || (minute >= AFTERNOON_START_MINUTE && minute <= AFTERNOON_END_MINUTE);

// 计算单个分时序列在 [prevMinute, minute] 窗口内的涨幅
const windowGain = (points, minute, prevMinute) => {
  const atPt = priceAtMinute(points, minute);
  const prevPt = priceAtMinute(points, prevMinute);
  if (!atPt || !prevPt || !(atPt.lastPx > 0) || !(prevPt.lastPx > 0)) return null;
  return ((atPt.lastPx - prevPt.lastPx) / prevPt.lastPx) * 100;
};

// 构建当日满足「创业板 + 主力资金 + 大盘成交额」三重条件的 5 分钟触发桶
const buildMarketTriggers = async (dateStr, dateNum) => {
  const fundData = getFundSnapshot(dateStr) || [];
  const amountData = getAmountSnapshot(dateStr) || [];
  if (!Array.isArray(fundData) || fundData.length === 0 || !Array.isArray(amountData) || amountData.length === 0) return [];

  const amountMap = new Map();
  for (const a of amountData) {
    const m = snapshotMinuteOf(a?.time);
    if (m != null) amountMap.set(m, a);
  }
  const buckets = [];
  for (const f of fundData) {
    const m = snapshotMinuteOf(f?.time);
    if (m == null) continue;
    if (!isBuyWindowMinute(m)) continue;
    buckets.push({ minute: m, fund: Number(f.mainMoney) });
  }
  buckets.sort((a, b) => toAbsMinute(a.minute) - toAbsMinute(b.minute));
  if (buckets.length < 2) return [];

  const indexTline = await loadDayTline(CYB_INDEX_CODE, dateNum);
  if (!indexTline || !Array.isArray(indexTline.points) || indexTline.points.length === 0) return [];

  const triggers = [];
  for (let i = 1; i < buckets.length; i += 1) {
    const cur = buckets[i];
    const prev = buckets[i - 1];
    // 只认严格相隔 5 分钟的前后桶（午休前后跨度不足 5 分钟时跳过）
    if (toAbsMinute(cur.minute) - toAbsMinute(prev.minute) !== WINDOW_MINUTES) continue;
    const amountCur = amountMap.get(cur.minute);
    const amountPrev = amountMap.get(prev.minute);
    if (!amountCur || !amountPrev) continue;
    const cybGain = windowGain(indexTline.points, cur.minute, prev.minute);
    if (cybGain == null) continue;
    const fundDelta = cur.fund - prev.fund;
    const amountDelta = Number(amountCur.amountChangeDiff) - Number(amountPrev.amountChangeDiff);
    if (!Number.isFinite(fundDelta) || !Number.isFinite(amountDelta)) continue;
    if (cybGain <= CYB_GAIN_MIN_PCT) continue;
    if (fundDelta <= FUND_INFLOW_MIN) continue;
    if (amountDelta <= AMOUNT_EXPAND_MIN) continue;
    triggers.push({
      minute: cur.minute,
      prevMinute: prev.minute,
      cybGain: round2(cybGain),
      fundDelta: round2(fundDelta),
      amountDelta: round2(amountDelta),
    });
  }
  return triggers;
};

// 某板块在触发窗口内的成分股平均涨幅（覆盖不足返回 null）
const blockWindowGain = (members, tlineMap, minute, prevMinute) => {
  const vals = [];
  for (const m of members) {
    const tl = tlineMap.get(m.code);
    if (!tl || !Array.isArray(tl.points) || tl.points.length === 0) continue;
    const g = windowGain(tl.points, minute, prevMinute);
    if (g != null && Number.isFinite(g)) vals.push(g);
  }
  if (vals.length < requiredCoverage(members.length)) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

// 触发窗口内，板块成分股按 5 分钟涨幅降序排名
const buildCandidates = (members, tlineMap, minute, prevMinute) => {
  const out = [];
  for (const m of members) {
    const tl = tlineMap.get(m.code);
    if (!tl || !Array.isArray(tl.points) || tl.points.length === 0) continue;
    const preclose = Number(tl.preclose);
    if (!(preclose > 0)) continue;
    const atPt = priceAtMinute(tl.points, minute);
    if (!atPt || !(atPt.lastPx > 0)) continue;
    const fiveMinGain = windowGain(tl.points, minute, prevMinute);
    if (fiveMinGain == null) continue;
    const currentPct = ((atPt.lastPx - preclose) / preclose) * 100;
    out.push({
      code: m.code,
      name: m.name,
      lastPx: atPt.lastPx,
      currentPct: round2(currentPct),
      fiveMinGain: round2(fiveMinGain),
      limitUp: currentPct >= limitUpThresholdOf(m.code),
    });
  }
  out.sort((a, b) => b.fiveMinGain - a.fiveMinGain);
  return out;
};

const buildBuyReason = (pos) => {
  const t = pos.triggerInfo;
  const skipText = (t.skippedLimitUp || []).length > 0
    ? `（涨停顺延：${t.skippedLimitUp.map((x) => x.name).join('、')}）`
    : '';
  return `创业板指 5 分钟内 ${gainText(t.cybGain)}（> ${CYB_GAIN_MIN_PCT}%），`
    + `主力资金 5 分钟净流入 ${t.fundDelta} 亿（> ${FUND_INFLOW_MIN} 亿），`
    + `大盘 5 分钟成交额放大 ${t.amountDelta} 亿（> ${AMOUNT_EXPAND_MIN} 亿）；`
    + `重点板块「${t.blockName}」成分股 ${t.memberCount} 只（≥ ${BLOCK_MEMBER_MIN}），`
    + `该 5 分钟板块平均涨幅 ${gainText(t.blockGain)} 为全部重点板块最高，`
    + `买入板块内 5 分钟涨幅最大 ${pos.stockName}（5 分钟 ${gainText(t.pickFiveMinGain)}，当日 ${gainText(t.pickCurrentPct)}）`
    + `${skipText}，成交价 ${pos.buyPrice.toFixed(2)}（第 ${pos.leg} 份半仓，${pos.half === 'am' ? '上午' : '下午'}买入）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  return [
    {
      id: 'mbr_cyb_gain',
      title: `创业板指 5 分钟内上涨 > ${CYB_GAIN_MIN_PCT}%`,
      passed: true,
      value: `${fmtMinute(t.prevMinute)} → ${fmtMinute(t.triggerMinute)} 创业板指上涨 ${gainText(t.cybGain)}`,
      reason: `以创业板指（${CYB_INDEX_CODE}）分时价计算最近 ${WINDOW_MINUTES} 分钟涨幅，须 > ${CYB_GAIN_MIN_PCT}%`,
    },
    {
      id: 'mbr_fund_inflow',
      title: `主力资金 5 分钟内净流入 > ${FUND_INFLOW_MIN} 亿`,
      passed: true,
      value: `${fmtMinute(t.prevMinute)} → ${fmtMinute(t.triggerMinute)} 净流入 ${t.fundDelta} 亿`,
      reason: `取主力资金累计净流入快照在最近 ${WINDOW_MINUTES} 分钟的增量，须 > ${FUND_INFLOW_MIN} 亿`,
    },
    {
      id: 'mbr_amount_expand',
      title: `大盘成交量 5 分钟内放大 > ${AMOUNT_EXPAND_MIN} 亿`,
      passed: true,
      value: `${fmtMinute(t.prevMinute)} → ${fmtMinute(t.triggerMinute)} 放大 ${t.amountDelta} 亿`,
      reason: `取大盘成交额快照在最近 ${WINDOW_MINUTES} 分钟的增量，须 > ${AMOUNT_EXPAND_MIN} 亿`,
    },
    {
      id: 'mbr_block_gain',
      title: `重点板块内股票个数 ≥ ${BLOCK_MEMBER_MIN}，取 5 分钟涨幅最大板块`,
      passed: true,
      value: `板块「${t.blockName}」成分股 ${t.memberCount} 只，5 分钟平均涨幅 ${gainText(t.blockGain)}（全部重点板块最高）`,
      reason: '按板块有效成分股的分时价计算 5 分钟平均涨幅，覆盖需 ≥ 5 只且 ≥ 成分股 50%；取涨幅最大的板块',
    },
    {
      id: 'mbr_5min_pick',
      title: '选股：买入板块内 5 分钟涨幅最大者（涨停顺延）',
      passed: true,
      value: `候选 ${t.candidateCount} 只，选中 ${pos.stockName}（5 分钟 ${gainText(t.pickFiveMinGain)}，当日 ${gainText(t.pickCurrentPct)}）`
        + `${(t.skippedLimitUp || []).length > 0 ? `；涨停顺延 ${t.skippedLimitUp.map((x) => `${x.name}(${gainText(x.currentPct)})`).join('、')}` : ''}`,
      reason: '按 5 分钟涨幅降序取第一只未涨停且未持仓的股票；主板涨幅 ≥ 9.5%、创业板/科创板 ≥ 19% 视为涨停',
    },
    {
      id: 'mbr_position',
      title: '两份半仓买入时点：第一份仅上午、第二份可与第一份相隔半天（同日只能上午→下午）',
      passed: true,
      value: `第 ${pos.leg} 份于 ${fmtMinute(pos.buyMinute)}（${pos.half === 'am' ? '上午' : '下午'}）买入`,
      reason: '空仓时第一份仅限 ≤ 11:30；第二份可在 ≤ 11:30 或 13:00–14:00；两份不得在同一交易日同一半天',
    },
  ];
};

const runMoodBlockResonanceBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.moodBlockResonanceMode !== true) {
    return { success: false, message: '未找到「情绪周期-板块共振大盘」策略' };
  }

  if (onProgress) onProgress({ current: 0, total: 0, date: '', status: 'loading' });

  const blocks = getKeyBlockConstituents();
  // 预筛：板块内股票个数 ≥ 5（去重后）
  const blockList = [];
  for (const [blockName, membersRaw] of blocks.entries()) {
    const seen = new Set();
    const members = [];
    for (const m of membersRaw || []) {
      if (!m || !m.code || seen.has(m.code)) continue;
      seen.add(m.code);
      members.push({ code: m.code, name: m.name || m.code });
    }
    if (members.length < BLOCK_MEMBER_MIN) continue;
    blockList.push({ blockName, members });
  }

  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    .filter((d) => d >= startDate && d <= endDate)
    .sort();
  const total = allDates.length;
  if (total === 0) return { success: false, message: '所选日期范围内无可回测交易日' };

  const trades = [];
  const seenStocks = new Map();
  const positions = []; // 最多 2 份，每份带 leg 1/2
  const nextLeg = () => {
    for (const leg of [1, 2]) {
      if (!positions.some((p) => p.leg === leg)) return leg;
    }
    return 1;
  };

  // 买入时点约束：返回 { ok, reason }
  const canEnterAt = (dateStr, minute) => {
    if (positions.length >= MAX_POSITIONS) return { ok: false, reason: '两份仓位已满' };
    const morning = minute <= MORNING_END_MINUTE;
    const afternoon = minute >= AFTERNOON_START_MINUTE && minute <= AFTERNOON_END_MINUTE;
    if (positions.length === 0) {
      return morning
        ? { ok: true }
        : { ok: false, reason: '空仓时第一份半仓仅限上午 11:30 前买入' };
    }
    const other = positions[0];
    if (other.buyDate < dateStr) {
      return (morning || afternoon)
        ? { ok: true }
        : { ok: false, reason: '第二份半仓仅限上午 11:30 前或下午 13:00–14:00 买入' };
    }
    if (other.buyDate === dateStr && other.half === 'am') {
      return afternoon
        ? { ok: true }
        : { ok: false, reason: '两份仓位不得在同一交易日同一半天买入（需至少相隔半天）' };
    }
    return { ok: false, reason: '当日已有一份在下午买入，须等下一交易日' };
  };

  const sellPositionAt = (pos, dateStr, dateDisplay, sellMinute, sellPx, sellChange, sellReason) => {
    if (!pos) return;
    const rawReturnRate = pos.buyPrice > 0
      ? round2(((sellPx - pos.buyPrice) / pos.buyPrice) * 100)
      : null;
    trades.push({
      seq: trades.length + 1,
      metric: null,
      code: pos.code,
      stockName: pos.stockName,
      board: pos.board,
      positionMode: 'offense',
      leg: pos.leg,
      weight: TWO_BUY_LEG_WEIGHT,
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
      sellReason: `${sellReason}，情绪周期-板块共振大盘（半仓）卖出`,
      returnRate: rawReturnRate != null ? round2(rawReturnRate * TWO_BUY_LEG_WEIGHT) : null,
      rawReturnRate,
    });
    const idx = positions.indexOf(pos);
    if (idx >= 0) positions.splice(idx, 1);
  };

  for (let di = 0; di < total; di += 1) {
    const dateStr = allDates[di];
    const dateDisplay = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const dateNum = parseInt(dateStr, 10);
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // ---- 市场共振触发桶（创业板 + 主力资金 + 大盘成交额）----
    const triggers = await buildMarketTriggers(dateStr, dateNum);

    // ---- 当日有共振触发时拉取全部重点板块成分股分时（卖出可能盘中释放仓位，故不在盘前按持仓数剪枝）----
    let tlineMap = new Map();
    const eventsByMinute = new Map();
    if (triggers.length > 0) {
      const codeSet = new Set();
      for (const b of blockList) for (const m of b.members) codeSet.add(m.code);
      await batchParallel(Array.from(codeSet), async (code) => {
        const t = await loadDayTline(code, dateNum);
        if (t) tlineMap.set(code, t);
      }, 8);

      for (const trigger of triggers) {
        let best = null;
        for (const b of blockList) {
          const g = blockWindowGain(b.members, tlineMap, trigger.minute, trigger.prevMinute);
          if (g == null) continue;
          if (!best || g > best.blockGain) {
            best = { blockName: b.blockName, members: b.members, memberCount: b.members.length, blockGain: round2(g) };
          }
        }
        if (!best) continue;
        eventsByMinute.set(trigger.minute, { ...trigger, ...best });
      }
    }

    // ---- 隔夜持仓当日分时（买入当日不卖）----
    const posTlines = new Map();
    for (const pos of positions) {
      if (dateStr <= pos.buyDate) continue;
      const t = await loadDayTline(pos.code, dateNum);
      if (t) posTlines.set(pos.code, t);
    }
    const resilienceCache = new Map();
    const ensurePosResilience = async (pos) => {
      if (resilienceCache.has(pos.code)) return resilienceCache.get(pos.code);
      let value = null;
      try {
        const [stockT, indexT] = await Promise.all([
          getSingleStockTlineDataByDate(pos.code, dateNum),
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
          const s = calculateReplayResilience(stockLine, indexLine, pos.code);
          if (s != null && Number.isFinite(Number(s))) value = round2(s);
        }
      } catch (e) { value = null; }
      resilienceCache.set(pos.code, value);
      return value;
    };

    // ---- 逐分钟：先卖后买 ----
    for (let mi = 0; mi < MINUTE_AXIS.length; mi += 1) {
      const bucketMinute = MINUTE_AXIS[mi].minute;
      const isTail = bucketMinute >= TAIL_MINUTE;

      // 卖出（与极致胜率顺周期腿一致）
      for (const pos of Array.from(positions)) {
        if (dateStr <= pos.buyDate) continue;
        const tline = posTlines.get(pos.code);
        if (!tline || !Array.isArray(tline.points) || tline.points.length === 0) continue;
        const atPt = priceAtMinute(tline.points, bucketMinute);
        if (!atPt || !(atPt.lastPx > 0)) continue;
        const px = atPt.lastPx;
        const preclose = tline.preclose;
        const changePct = preclose && preclose > 0
          ? round2(((px - preclose) / preclose) * 100)
          : (atPt.change != null ? atPt.change : null);
        const costReturn = pos.buyPrice > 0
          ? round2(((px - pos.buyPrice) / pos.buyPrice) * 100)
          : null;

        let sellReason = null;
        let sellMinute = atPt.minute;
        let sellPx = px;
        let sellChange = changePct;

        const priceHit = scanLeaderPriceSell({
          points: tline.points,
          preclose,
          buyPrice: pos.buyPrice,
          cutoffMinute: bucketMinute,
          costLinePct: -5,
          costLineSustainMinutes: 0,
          enableOpenGapReboundSell: true,
        });
        if (priceHit) {
          sellReason = priceHit.reason;
          sellMinute = priceHit.minute;
          sellPx = priceHit.px;
          sellChange = priceHit.changePct;
        }
        // ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10%
        if (!sellReason && pos.buyDi != null && (di - pos.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTail) {
          if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
            sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${pos.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
          }
        }
        // ⑥ 当日收盘抗分歧指数 < 6
        if (!sellReason && isTail) {
          const res = await ensurePosResilience(pos);
          if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
            sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
          }
        }

        if (sellReason) {
          sellPositionAt(pos, dateStr, dateDisplay, sellMinute, sellPx, sellChange, sellReason);
        }
      }

      // 买入：该分钟若市场共振触发，买入 5 分钟涨幅最大板块内 5 分钟涨幅最大的未涨停股票
      const ev = eventsByMinute.get(bucketMinute);
      if (!ev) continue;
      const gate = canEnterAt(dateStr, bucketMinute);
      if (!gate.ok) continue;

      const candidates = buildCandidates(ev.members, tlineMap, bucketMinute, ev.prevMinute);
      if (candidates.length === 0) continue;
      const skippedLimitUp = [];
      let picked = null;
      for (const c of candidates) {
        if (c.limitUp) { skippedLimitUp.push(c); continue; }
        if (positions.some((p) => p.code === c.code)) continue; // 两份仓位不得同时持有同一只股票
        picked = c;
        break;
      }
      if (!picked) continue;

      // 记录板块候选池（供前端展示）
      for (const m of ev.members) {
        if (!seenStocks.has(m.code)) seenStocks.set(m.code, { code: m.code, name: m.name });
      }

      const half = bucketMinute <= MORNING_END_MINUTE ? 'am' : 'pm';
      const leg = nextLeg();
      const pos = {
        code: picked.code,
        stockName: picked.name,
        board: ev.blockName,
        buyDate: dateStr,
        buyDateDisplay: dateDisplay,
        buyTime: fmtMinute(bucketMinute),
        buyMinute: bucketMinute,
        half,
        buyPrice: round2(picked.lastPx),
        buyChange: picked.currentPct,
        metric: null,
        leg,
        weight: TWO_BUY_LEG_WEIGHT,
        buyDi: di,
        buyReason: '',
        buyChecks: [],
        triggerInfo: {
          prevMinute: ev.prevMinute,
          triggerMinute: bucketMinute,
          cybGain: ev.cybGain,
          fundDelta: ev.fundDelta,
          amountDelta: ev.amountDelta,
          blockName: ev.blockName,
          memberCount: ev.memberCount,
          blockGain: ev.blockGain,
          candidateCount: candidates.length,
          pickFiveMinGain: picked.fiveMinGain,
          pickCurrentPct: picked.currentPct,
          skippedLimitUp,
        },
      };
      pos.buyReason = buildBuyReason(pos);
      pos.buyChecks = buildBuyChecks(pos);
      positions.push(pos);
      break; // 同一分钟只买一份
    }

    // 每日结束释放分时进程缓存，避免全区间回测撑爆堆内存（磁盘缓存不受影响）
    clearTlineMemCache();
  }

  // ---- 组装结果 ----
  // 收盘后强制刷新 barsCache，确保 getStockCloseOnOrBefore 能拿到当日收盘价（与 extremeWinBacktest 同理）
  if (positions.length > 0) {
    try { await ensureBarsForCodes(new Set(positions.map(p => p.code)), { force: true }); } catch (e) { /* 兜底 */ }
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
    ...trades.map((t) => ({
      buyDate: t.buyDate,
      buyTime: t.buyTime,
      sellDate: t.sellDate,
      sellTime: t.sellTime,
      returnRate: t.returnRate,
    })),
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
    skippedDates: [],
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

module.exports = { runMoodBlockResonanceBacktest };
