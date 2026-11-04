// 情绪周期-板块轮换-N 日涨幅最大（2026-11-04 用户新增；仅回测；独立引擎）
//
// 买点（逐分钟判定）：
//   0) 情绪温度门禁（2026-11-04 用户要求）：上一交易日（T-1）lianbanSnapshot 快照的情绪阶段
//      为「退潮期」或「冰点期」时，次日（当日）才允许出手；T-1 为其它阶段或快照缺失时当日全天不买入
//      （只影响开新仓，不影响卖出）；
//   1) 重点板块成分股数量 ≥ 5（2026-11-04 用户补充要求）；
//   2) 该板块上一交易日（T-1）与上上个交易日（T-2）收盘板块平均涨幅均 < 4%；
//   3) 当日盘中板块分时平均涨幅 > 4% 且连续保持超过 5 分钟；
//   4) 触发时买入该板块内「N 日涨幅最大」的股票；N 日涨幅 = 前 N-1 个交易日收盘涨幅之和 +
//      触发时点当日分时涨幅；若该股已涨停则按涨幅排名顺延下一只（同时跳过已持仓的同股）。
//
// 仓位：账户拆两份、每份半仓（权重 0.5）：
//   · 空仓时第一份仅限上午（≤ 11:30）买入；
//   · 只持有一份时，第二份可在上午（≤ 11:30）或下午 13:00–14:00 买入；
//   · 两份不得落在同一交易日的同一个半天（同一日只能上午→下午；跨日则上午/下午均可），
//     即两份买入时点至少相隔半天；
//   · 同一交易日内，上午与下午买入的不能是同一个板块（上午已买板块 A，下午只能买其它板块）。
//
// 卖点：与「情绪游资-极致胜率」顺周期腿完全一致：
//   · 分钟级价格类卖点（成本线 -5% 且不设持续分钟、跌停、盘中跌幅、开盘下挫、单分钟跳水、
//     高位大阴线、⑪竞价大幅低开冲高回落、⑫开盘自救），逐分钟回溯取最先触发分钟；
//   · ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10% → 尾盘卖；
//   · ⑥ 当日收盘抗分歧指数 < 6 → 尾盘卖。
const fs = require('fs');
const path = require('path');
const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  clearTlineMemCache,
  ensureKeyBlockBars,
  getKeyBlockConstituents,
  getPastTradingDates,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  stockDailyChange,
  stockHighChangeAt,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { round2, limitUpThresholdOf } = require('./extremeWinScores');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn } = require('./twoBuy');

const BLOCK_MEMBER_MIN = 5;                 // 板块内股票个数 ≥ 5（2026-11-04 用户补充要求）
const BLOCK_COVERAGE_RATIO = 0.5;           // 板块均值至少覆盖 50% 成分股，且不少于 5 只
const BLOCK_TRIGGER_PCT = 4;                // 板块分时平均涨幅 > 4%
const BLOCK_TRIGGER_SUSTAIN_MINUTES = 5;    // 持续超过 5 分钟
const MAX_POSITIONS = 2;                    // 两份半仓
const MORNING_END_MINUTE = 1130;            // 上午最晚买入分钟
const AFTERNOON_START_MINUTE = 1300;        // 下午买入窗口起
const AFTERNOON_END_MINUTE = 1400;          // 下午买入窗口止
const TAIL_MINUTE = 1457;                   // 尾盘判定分钟（与极致胜率一致）
const WEAK_TRADE_HOLD_DAYS = 3;             // 持仓第 3 个交易日尾盘
const WEAK_TRADE_MIN_GAIN_PCT = 10;         // 收益仍未拉开至 +10%
const RESILIENCE_SELL_MAX = 6;              // 收盘抗分歧指数 < 6
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001';
const EBB_PHASES = ['退潮期', '冰点期'];    // 情绪温度门禁：T-1 处于退潮期或冰点期，次日才允许出手
const LIANBAN_SNAPSHOT_DIR = path.resolve(__dirname, '../../../data/lianbanSnapshot');

// 读取某交易日连板快照的情绪阶段/温度（文件缺失或解析失败返回 null）
const readSentimentOfDay = (dateStr) => {
  try {
    const file = path.join(LIANBAN_SNAPSHOT_DIR, `${dateStr}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.sentiment) return null;
    return {
      phase: data.sentiment.phase || null,
      temperature: data.sentiment.temperature ?? null,
    };
  } catch (e) { return null; }
};

const toAbsMinute = (mm) => Math.floor(mm / 100) * 60 + (mm % 100);
const fmtMinute = (m) => (m != null
  ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`
  : '--');
const gainText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

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

// 按日读取分时（2026-11-04 改走按日捆绑缓存 getSingleStockTlineDataByDate：
// 原用 Lean 版对每只成分股整份同步读盘解析全历史分时文件（单文件可达 1-11MB），
// 是该策略回测 80s+ 的主因；改后每日只解析一个按日捆绑小文件，缺失的成分股由
// worker 线程补读并自动登记进当日捆绑缓存。内存由每日 clearTlineMemCache 兜底）
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

// 板块某交易日的「成分股均值」（收盘涨幅 / 最高价涨幅等），覆盖不足返回 null
const blockDailyAvg = (members, dateStr, metricFn) => {
  const vals = [];
  for (const m of members) {
    const v = metricFn(m.code, String(dateStr));
    if (v != null && Number.isFinite(Number(v))) vals.push(Number(v));
  }
  if (vals.length < requiredCoverage(members.length)) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

// 构建某板块当日逐分钟平均涨幅序列（用每只成分股该分钟及之前最后一个分时价）
const buildBlockSeries = (members, tlineMap) => {
  const states = [];
  for (const m of members) {
    const tl = tlineMap.get(m.code);
    if (!tl || !Array.isArray(tl.points) || tl.points.length === 0) continue;
    const preclose = Number(tl.preclose);
    if (!(preclose > 0)) continue;
    states.push({ preclose, points: tl.points, ptr: 0, lastPx: null });
  }
  if (states.length === 0) return [];
  const required = requiredCoverage(members.length);
  const series = [];
  for (const slot of MINUTE_AXIS) {
    const minute = slot.minute;
    let sum = 0;
    let count = 0;
    for (const st of states) {
      while (st.ptr < st.points.length && st.points[st.ptr].minute <= minute) {
        const p = st.points[st.ptr];
        if (p.lastPx > 0) st.lastPx = p.lastPx;
        st.ptr += 1;
      }
      if (st.lastPx != null && st.lastPx > 0) {
        sum += ((st.lastPx - st.preclose) / st.preclose) * 100;
        count += 1;
      }
    }
    series.push({ minute, avg: count >= required ? sum / count : null });
  }
  return series;
};

// 从逐分钟序列中找出「板块平均涨幅 > 4% 且持续超过 5 分钟」的触发分钟；
// 每次触发后重新计时（允许同一板块当日后续再次触发，例如上午第一份、下午第二份）
const detectTriggerEvents = (series, blockName) => {
  const events = [];
  let runStartAbs = null;
  let prevAbs = null;
  for (const pt of series) {
    const abs = toAbsMinute(pt.minute);
    if (pt.avg != null && pt.avg > BLOCK_TRIGGER_PCT) {
      if (runStartAbs == null) {
        runStartAbs = abs;
      } else {
        const gap = abs - prevAbs;
        const isLunch = prevAbs <= toAbsMinute(1130) && abs >= toAbsMinute(1300);
        if (gap > 1 && !isLunch) runStartAbs = abs; // 分时缺口不视为连续
      }
      prevAbs = abs;
      if (abs - runStartAbs > BLOCK_TRIGGER_SUSTAIN_MINUTES) {
        events.push({ minute: pt.minute, blockName, avg: round2(pt.avg) });
        runStartAbs = null; // 重新计时
      }
    } else {
      runStartAbs = null;
      prevAbs = null;
    }
  }
  return events;
};

// 触发分钟时，板块成分股按 N 日涨幅降序排名
const buildCandidates = (members, tlineMap, minute, priorDates) => {
  const out = [];
  for (const m of members) {
    const tl = tlineMap.get(m.code);
    if (!tl || !Array.isArray(tl.points) || tl.points.length === 0) continue;
    const preclose = Number(tl.preclose);
    if (!(preclose > 0)) continue;
    const atPt = priceAtMinute(tl.points, minute);
    if (!atPt || !(atPt.lastPx > 0)) continue;
    const currentPct = ((atPt.lastPx - preclose) / preclose) * 100;
    let priorSum = 0;
    let priorOk = true;
    for (const d of priorDates) {
      const v = stockDailyChange(m.code, String(d));
      if (v == null || !Number.isFinite(Number(v))) { priorOk = false; break; }
      priorSum += Number(v);
    }
    if (!priorOk) continue;
    const nDayGain = priorSum + currentPct;
    out.push({
      code: m.code,
      name: m.name,
      lastPx: atPt.lastPx,
      currentPct: round2(currentPct),
      priorSum: round2(priorSum),
      nDayGain: round2(nDayGain),
      limitUp: currentPct >= limitUpThresholdOf(m.code),
    });
  }
  out.sort((a, b) => b.nDayGain - a.nDayGain);
  return out;
};

const buildBuyReason = (pos) => {
  const t = pos.triggerInfo;
  const skipText = (t.skippedLimitUp || []).length > 0
    ? `（涨停顺延：${t.skippedLimitUp.map((x) => x.name).join('、')}）`
    : '';
  return `上一交易日（T-1）情绪阶段「${t.prevPhase || '缺失'}」（温度 ${t.prevTemperature ?? '--'}，须为退潮期/冰点期），`
    + `重点板块「${t.blockName}」成分股 ${t.memberCount} 只（≥ ${BLOCK_MEMBER_MIN}），`
    + `T-1 收盘板块平均涨幅 ${gainText(t.avgT1)}、T-2 ${gainText(t.avgT2)}（均 < ${BLOCK_TRIGGER_PCT}%），`
    + `盘中 ${fmtMinute(t.triggerMinute)} 板块分时平均涨幅 ${gainText(t.triggerAvg)} > ${BLOCK_TRIGGER_PCT}% 且持续超过 ${BLOCK_TRIGGER_SUSTAIN_MINUTES} 分钟，`
    + `买入板块内 ${t.n} 日涨幅最大 ${pos.stockName}（${t.n} 日涨幅 ${gainText(t.pickNdayGain)}，当日分时 ${gainText(t.pickCurrentPct)}）`
    + `${skipText}，成交价 ${pos.buyPrice.toFixed(2)}（第 ${pos.leg} 份半仓，${pos.half === 'am' ? '上午' : '下午'}买入）`;
};

const buildBuyChecks = (pos) => {
  const t = pos.triggerInfo;
  return [
    {
      id: 'mbr_ebb_gate',
      title: '情绪温度门禁：上一交易日（T-1）情绪阶段为「退潮期」或「冰点期」',
      passed: true,
      value: `T-1（${t.prevDate}）情绪阶段「${t.prevPhase || '缺失'}」、情绪温度 ${t.prevTemperature ?? '--'}`,
      reason: `2026-11-04 用户要求：上个交易日（T-1）lianbanSnapshot 情绪阶段为「${EBB_PHASES.join('」或「')}」时，次日才允许出手；T-1 为其它阶段或快照缺失时当日全天不买入（不影响卖出）`,
    },
    {
      id: 'mbr_member_count',
      title: `重点板块内股票个数 ≥ ${BLOCK_MEMBER_MIN}`,
      passed: true,
      value: `板块「${t.blockName}」成分股 ${t.memberCount} 只（≥ ${BLOCK_MEMBER_MIN}）`,
      reason: `2026-11-04 用户补充要求：只有成分股数量 ≥ ${BLOCK_MEMBER_MIN} 的重点板块才参与板块轮换`,
    },
    {
      id: 'mbr_prev_gate',
      title: `T-1、T-2 收盘板块平均涨幅均 < ${BLOCK_TRIGGER_PCT}%`,
      passed: true,
      value: `T-1 ${gainText(t.avgT1)}，T-2 ${gainText(t.avgT2)}`,
      reason: '板块必须处于「前两日尚未启动」状态；T-1 或 T-2 板块平均涨幅 ≥ 4% 即不参与当日轮换',
    },
    {
      id: 'mbr_intraday_trigger',
      title: `盘中板块分时平均涨幅 > ${BLOCK_TRIGGER_PCT}% 且持续超过 ${BLOCK_TRIGGER_SUSTAIN_MINUTES} 分钟`,
      passed: true,
      value: `${fmtMinute(t.triggerMinute)} 板块平均涨幅 ${gainText(t.triggerAvg)}（当日最高均涨幅 ${gainText(t.avgHigh)}）`,
      reason: '按板块全体有效成分股的分钟分时价计算每分钟平均涨幅；连续保持 > 4% 超过 5 分钟才触发，分时缺口不视为连续',
    },
    {
      id: 'mbr_nday_pick',
      title: `${t.n} 日涨幅最大选股（涨停顺延）`,
      passed: true,
      value: `候选 ${t.candidateCount} 只，选中 ${pos.stockName}（${t.n} 日涨幅 ${gainText(t.pickNdayGain)}，当日 ${gainText(t.pickCurrentPct)}）`
        + `${(t.skippedLimitUp || []).length > 0 ? `；涨停顺延 ${t.skippedLimitUp.map((x) => `${x.name}(${gainText(x.currentPct)})`).join('、')}` : ''}`,
      reason: `${t.n} 日涨幅 = ${t.n > 1 ? `前 ${t.n - 1} 个交易日收盘涨幅之和 + ` : ''}触发时点当日分时涨幅；按降序取第一只未涨停且未持仓的股票`,
    },
    {
      id: 'mbr_position_time',
      title: '两份半仓买入时点：第一份仅上午、第二份可与第一份相隔半天（同日只能上午→下午）',
      passed: true,
      value: `第 ${pos.leg} 份于 ${fmtMinute(pos.buyMinute)}（${pos.half === 'am' ? '上午' : '下午'}）买入`,
      reason: '空仓时第一份仅限 ≤ 11:30；第二份可在 ≤ 11:30 或 13:00–14:00；两份不得在同一交易日同一半天',
    },
  ];
};

const runMoodBlockRotateBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.moodBlockRotateMode !== true) {
    return { success: false, message: '未找到「情绪周期-板块轮换」策略' };
  }
  const n = Number(strategy.moodBlockRotateN) || 1;

  if (onProgress) onProgress({ current: 0, total: 0, date: '', status: 'loading' });
  try {
    await ensureKeyBlockBars();
  } catch (e) { /* 日K预取失败时后续按数据缺失处理 */ }

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
      sellReason: `${sellReason}，情绪周期-板块轮换-${n}日涨幅最大（半仓）卖出`,
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

    // T-1 / T-2（严格不含当日）
    let t1 = null;
    let t2 = null;
    try {
      const past = await getPastTradingDates(dateStr, 2);
      t1 = past && past.length >= 1 ? past[past.length - 1] : null;
      t2 = past && past.length >= 2 ? past[past.length - 2] : null;
    } catch (e) { t1 = null; t2 = null; }
    const priorDates = n >= 3
      ? [t2, t1]
      : n >= 2
        ? [t1]
        : [];

    // 情绪温度门禁：上一交易日（T-1）情绪阶段为「退潮期」或「冰点期」时，当日才允许出手（快照缺失按不满足处理）
    const prevSentiment = t1 ? readSentimentOfDay(t1) : null;
    const prevIsEbb = EBB_PHASES.includes(prevSentiment?.phase);

    // ---- 板块门禁 + 当日最高涨幅预筛（避免对不可能触发的板块拉分时）----
    const passingBlocks = [];
    for (const block of blockList) {
      if (t1 == null || t2 == null) continue;
      const avgT1 = blockDailyAvg(block.members, t1, stockDailyChange);
      const avgT2 = blockDailyAvg(block.members, t2, stockDailyChange);
      if (avgT1 == null || avgT2 == null) continue;
      if (avgT1 >= BLOCK_TRIGGER_PCT || avgT2 >= BLOCK_TRIGGER_PCT) continue;
      const avgHigh = blockDailyAvg(block.members, dateStr, stockHighChangeAt);
      // 板块平均最高涨幅 ≤ 4% 时，任何时点的平均分时涨幅都不可能 > 4%（安全剪枝）
      if (avgHigh == null || avgHigh <= BLOCK_TRIGGER_PCT) continue;
      passingBlocks.push({ ...block, avgT1, avgT2, avgHigh });
    }

    // ---- 只对通过门禁的板块预拉成分股分时 ----
    const tlineMap = new Map();
    if (passingBlocks.length > 0) {
      const codeSet = new Set();
      for (const b of passingBlocks) for (const m of b.members) codeSet.add(m.code);
      await batchParallel(Array.from(codeSet), async (code) => {
        const t = await loadDayTline(code, dateNum);
        if (t) tlineMap.set(code, t);
      }, 8);
    }

    // ---- 逐板块识别触发分钟 ----
    const eventsByMinute = new Map();
    for (const b of passingBlocks) {
      const series = buildBlockSeries(b.members, tlineMap);
      const events = detectTriggerEvents(series, b.blockName);
      if (events.length === 0) continue;
      for (const ev of events) {
        const list = eventsByMinute.get(ev.minute) || [];
        list.push({
          minute: ev.minute,
          blockName: b.blockName,
          blockAvg: ev.avg,
          members: b.members,
          memberCount: b.members.length,
          avgT1: b.avgT1,
          avgT2: b.avgT2,
          avgHigh: b.avgHigh,
        });
        eventsByMinute.set(ev.minute, list);
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
    // 同一天上午与下午买入的不能是同一个板块（跨日不受限制）
    const boughtBoardsByHalf = { am: new Set(), pm: new Set() };
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

      // 买入：该分钟若有板块触发，取板块平均涨幅最高者，买入其 N 日涨幅最大的未涨停股票
      const events = eventsByMinute.get(bucketMinute);
      if (!events || events.length === 0) continue;
      if (!prevIsEbb) continue; // T-1 非退潮期/冰点期（或快照缺失），当日不出手
      const gate = canEnterAt(dateStr, bucketMinute);
      if (!gate.ok) continue;

      events.sort((a, b) => b.blockAvg - a.blockAvg);
      const half = bucketMinute <= MORNING_END_MINUTE ? 'am' : 'pm';
      const otherHalf = half === 'am' ? 'pm' : 'am';
      for (const ev of events) {
        // 同一天上午/下午不得买入同一个板块：当前半天若已买过该板块则跳过，尝试其它触发板块
        if (boughtBoardsByHalf[otherHalf].has(ev.blockName)) continue;
        const candidates = buildCandidates(ev.members, tlineMap, bucketMinute, priorDates);
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
            n,
            prevDate: t1,
            prevPhase: prevSentiment?.phase || null,
            prevTemperature: prevSentiment?.temperature ?? null,
            blockName: ev.blockName,
            memberCount: ev.memberCount,
            avgT1: round2(ev.avgT1),
            avgT2: round2(ev.avgT2),
            avgHigh: round2(ev.avgHigh),
            triggerMinute: bucketMinute,
            triggerAvg: ev.blockAvg,
            candidateCount: candidates.length,
            pickNdayGain: picked.nDayGain,
            pickCurrentPct: picked.currentPct,
            skippedLimitUp,
          },
        };
        pos.buyReason = buildBuyReason(pos);
        pos.buyChecks = buildBuyChecks(pos);
        boughtBoardsByHalf[half].add(ev.blockName);
        positions.push(pos);
        break; // 同一分钟只买一份
      }
    }

    // 每日结束释放分时进程缓存，避免全区间回测撑爆堆内存（磁盘缓存不受影响）
    clearTlineMemCache();
  }

  // ---- 组装结果 ----
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

module.exports = { runMoodBlockRotateBacktest };
