// ============================================================
// 「情绪游资-极致胜率」live 服务（开盘实战页「切换模式」使用）
//   与回测引擎 engine/extremeWinBacktest.js 共用同一份候选池 / 死叉 / 打分实现
//   （engine/extremeWinPool.js、engine/extremeWinScores.js、engine/indexGate.js），
//   保证线上展示与回测口径完全一致（2026-10-17 用户要求）。
//
//   导出：
//     getHotMoneyLeaderList(targetDate, limit)     龙头列表（除 delta≥30 与上证斜率>0 外全部买点条件满足）
//     getExtremeWinBuyPointChecks(targetDate, ...) 买点诊断 7 项（结构同科技进攻，便于前端复用）
//     checkExtremeWinSellPointDetailed(code, costPrice, buyDate) 卖点诊断 9 条（完整龙头战法）
// ============================================================
const dayjs = require('dayjs');
const { batchParallel, isTradingDay, getPrevTradingDay, isAfterMarketClose } = require('../utils');
const { countTradingDaysBetween } = require('../utils/tradingDay');
const { getStockPositions } = require('./stockPosition');
const { getPastTradingDates, stockPriorAvgVolume } = require('./buySellBacktest/deps');
const { calculateReplayResilience } = require('./buySellBacktest/diagnose/sellPoint');
const {
  DEATH_CROSS_WINDOW, DELTA_MIN, CLOSE_MINUTE,
  PREV_STRENGTH_GAP_GATE, OPEN_GAP_MIN_PCT,
  computeCrossInfo, buildExtremeWinPool,
} = require('./buySellBacktest/engine/extremeWinPool');
const {
  loadTlinePoints, strengthAtMinute, diffAtMinute, round2, limitUpThresholdOf,
} = require('./buySellBacktest/engine/extremeWinScores');
const {
  ICE_SIGNAL_INDEX_CODE, getIceMa3SlopeIntraday, fmtKeyBlockSlope, iceResilienceIndexCode,
} = require('./buySellBacktest/engine/indexGate');

const MODE_EXTREME_WIN = 'hot_money_extreme_win';

// ---------- 交易日回退（与 getBuyPointChecks 口径一致） ----------
const resolveTargetDay = (targetDate) => {
  if (targetDate) {
    const dateStr = String(targetDate).replace(/-/g, '');
    const d = dayjs(dateStr, 'YYYYMMDD');
    return d.isValid() ? d : dayjs();
  }
  const now = dayjs();
  if (!isTradingDay(now.toDate())) return dayjs(getPrevTradingDay());
  return now;
};

// ============================================================
// 共享上下文：池 + 死叉信息 + 盘中实时打分（一次算出供列表 / 买点诊断复用）
// ============================================================
const fetchExtremeWinContext = async (targetDate = null) => {
  const targetDay = resolveTargetDay(targetDate);
  const dateStr = targetDay.format('YYYYMMDD');
  const dateNum = Number(dateStr);
  const isToday = dateStr === dayjs().format('YYYYMMDD');
  const afterClose = !isToday || isAfterMarketClose();

  // 1) 候选池（过去 10 交易日四连板及以上，剔除创业板/科创板/题材黑名单/科技自选股重叠/近期大幅拉升）
  const pool = await buildExtremeWinPool(dateStr);
  const poolStocks = pool.stocks || [];

  // 2) 死叉口径（过去 DEATH_CROSS_WINDOW 个交易日，不含当日）
  const crossDates = await getPastTradingDates(dateStr, DEATH_CROSS_WINDOW);
  const crossInfos = poolStocks.length > 0
    ? await batchParallel(poolStocks.map(s => s.code), async (code) => {
        try { return await computeCrossInfo(code, crossDates); } catch (e) { return null; }
      }, 6)
    : [];

  // 3) 当日分时（进程内缓存；当日盘中跳过缓存，支持 live）
  const tlineList = poolStocks.length > 0
    ? await batchParallel(poolStocks.map(s => s.code), async (code) => {
        try { return await loadTlinePoints(code, dateNum); } catch (e) { return { preclose: null, points: [] }; }
      }, 6)
    : [];

  // 4) 各股跟踪指数当日分时（强度分 C 抗分歧所需）
  const idxCodes = Array.from(new Set(poolStocks.map(s => iceResilienceIndexCode(s.code))));
  const idxTlineMap = new Map();
  await batchParallel(idxCodes, async (idxCode) => {
    try { idxTlineMap.set(idxCode, await loadTlinePoints(idxCode, dateNum)); }
    catch (e) { idxTlineMap.set(idxCode, { preclose: null, points: [] }); }
    return null;
  }, 4);

  // 5) 计算口径分钟：收盘后按 1500；盘中取各股分时最后点的最大分钟
  let minute = CLOSE_MINUTE;
  if (!afterClose) {
    let maxMinute = 0;
    for (const t of tlineList) {
      const pts = (t && t.points) || [];
      if (pts.length > 0) {
        const m = pts[pts.length - 1].minute;
        if (Number.isFinite(m) && m > maxMinute) maxMinute = m;
      }
    }
    if (maxMinute > 0) minute = maxMinute;
  }

  // 6) 上证指数（sh000001）3 日线分时斜率门禁
  let indexSlope = null;
  try { indexSlope = await getIceMa3SlopeIntraday(dateStr, minute); } catch (e) { indexSlope = null; }

  const rows = poolStocks.map((s, i) => {
    const code = s.code;
    const t = tlineList[i] || { preclose: null, points: [] };
    const points = t.points || [];
    const preclose = t.preclose;
    const stockMinute = afterClose
      ? CLOSE_MINUTE
      : (points.length > 0 ? points[points.length - 1].minute : CLOSE_MINUTE);

    let avg3Vol = null;
    try { avg3Vol = stockPriorAvgVolume(code, dateNum, 3); } catch (e) { avg3Vol = null; }

    const diff = points.length > 0 ? diffAtMinute(points, preclose, code, stockMinute, avg3Vol) : null;
    const idxT = idxTlineMap.get(iceResilienceIndexCode(code)) || { points: [] };
    const strength = points.length > 0 ? strengthAtMinute(t, stockMinute, code, idxT.points) : null;
    const delta = (diff && strength) ? round2(strength.score - diff.score) : null;

    const lastPt = points.length > 0 ? points[points.length - 1] : null;
    const px = lastPt ? round2(lastPt.lastPx) : null;
    const change = (preclose > 0 && px != null) ? round2(((px - preclose) / preclose) * 100) : null;
    const aRaw = strength ? strength.aRaw : null;
    const isLimitUp = strength
      ? !!strength.limitUp
      : (change != null && change > limitUpThresholdOf(code));

    const cross = crossInfos[i] || null;
    // 买点前置：死叉 + 未被历史消耗 + 上个交易日 delta>30 时须放量
    const crossPassed = !!(cross && cross.hasCross && !cross.consumed && cross.prevDayVolumeOk);
    // 竞价低开门禁：上个交易日强度分 > 60 时，当日竞价低开须 ≥ -3%
    const gatePassed = !cross
      || cross.prevDayStrength == null
      || cross.prevDayStrength <= PREV_STRENGTH_GAP_GATE
      || (aRaw != null && aRaw >= OPEN_GAP_MIN_PCT);
    // 龙头列表口径 = 池筛选 + 死叉前置 + 竞价门禁（除 delta≥30 与上证斜率>0 外全部满足）
    const listPassed = crossPassed && gatePassed;
    const deltaOk = delta != null && delta >= DELTA_MIN;
    const buyPointHit = listPassed && deltaOk && indexSlope != null && indexSlope > 0;

    return {
      code,
      stockName: s.name || code,
      name: s.name || code,
      board: s.board || '',
      lianbanCount: s.lianbanCount || 0,
      preclose: round2(preclose),
      px,
      change,
      aRaw,
      isLimitUp,
      diffScore: diff ? diff.score : null,
      strengthScore: strength ? strength.score : null,
      delta,
      diffDetail: diff,
      strengthDetail: strength,
      crossInfo: cross ? {
        crossDate: cross.crossIdx >= 0 ? cross.dates[cross.crossIdx] : null,
        hitCount: cross.hitCount,
        prevDayDelta: cross.prevDayDelta,
        prevDayVolumeOk: cross.prevDayVolumeOk,
        prevDayStrength: cross.prevDayStrength,
        deltas: cross.deltas,
        dates: cross.dates,
      } : null,
      listPassed,
      buyPointHit,
      minute: stockMinute,
    };
  });

  return { dateStr, dateNum, isToday, afterClose, minute, indexSlope, pool, rows };
};

const byDeltaDesc = (a, b) => ((b.delta == null ? -Infinity : b.delta) - (a.delta == null ? -Infinity : a.delta));

// ============================================================
// 龙头列表（除「强度分 − 差劲分 ≥ 30」与「上证 3 日线斜率为正」外，其余买点条件全部满足）
// ============================================================
const getHotMoneyLeaderList = async (targetDate = null, limit = 50) => {
  try {
    const ctx = await fetchExtremeWinContext(targetDate);
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
    const stocks = ctx.rows.filter(r => r.listPassed).sort(byDeltaDesc).slice(0, lim);
    return {
      success: true,
      data: {
        mode: MODE_EXTREME_WIN,
        date: ctx.dateStr,
        minute: ctx.minute,
        isAfterClose: ctx.afterClose,
        indexSlope: ctx.indexSlope,
        poolCount: (ctx.pool.stocks || []).length,
        poolFilterText: ctx.pool.poolFilterText || '',
        stocks,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e.message || '获取情绪游资龙头列表失败',
      data: { mode: MODE_EXTREME_WIN, stocks: [] },
    };
  }
};

// ============================================================
// 买点诊断 7 项（与回测 buildPosition 的 checks 一一对应）
// ============================================================
const buildExtremeWinChecks = (ctx, candidate) => {
  const poolCount = (ctx.pool.stocks || []).length;
  const cross = candidate ? candidate.crossInfo : null;
  const crossPassed = !!(cross && cross.crossDate != null && cross.hitCount <= 1 && cross.prevDayVolumeOk);
  const gatePassed = !cross
    || cross.prevDayStrength == null
    || cross.prevDayStrength <= PREV_STRENGTH_GAP_GATE
    || (candidate.aRaw != null && candidate.aRaw >= OPEN_GAP_MIN_PCT);
  const deltaOk = !!(candidate && candidate.delta != null && candidate.delta >= DELTA_MIN);
  const slopeOk = ctx.indexSlope != null && ctx.indexSlope > 0;

  const crossDateText = cross && cross.crossDate != null ? cross.crossDate : '--';
  const hitCount = cross ? cross.hitCount : 0;
  const deltasText = cross && Array.isArray(cross.deltas)
    ? cross.deltas.map(v => (v == null ? '--' : v)).join(' → ')
    : '--';
  const d = candidate ? candidate.diffDetail : null;
  const s = candidate ? candidate.strengthDetail : null;
  const nameText = candidate ? `${candidate.stockName}（${candidate.code}）· ${candidate.lianbanCount} 连板` : '--';

  const checks = [
    {
      id: 'extreme_win_pool',
      title: `选股（过去 10 个交易日四连板及以上；剔除创业板/科创板/题材黑名单/全量自选股科技股；剔除近期大幅拉升）`,
      passed: poolCount > 0,
      value: `龙头池 ${poolCount} 只`,
      reason: `候选 = 过去 10 个交易日内出现连板数 ≥ 4 的个股，已剔除 ST 等黑名单、创业板（30/301）与科创板（688）、题材黑名单与全量自选股科技股（isTech ≠ false）重叠者，并剔除近期已大幅拉升者${ctx.pool.poolFilterText || ''}；当前龙头池共 ${poolCount} 只，展示标的为 ${nameText}`,
    },
    {
      id: 'extreme_win_cross',
      title: `买点前置：过去 ${DEATH_CROSS_WINDOW} 个交易日死叉且死叉后达标次数 ≤ 1（上个交易日 delta > ${DELTA_MIN} 时须放量）`,
      passed: crossPassed,
      value: `死叉日 ${crossDateText}（死叉后达标 ${hitCount} 次；上个交易日 delta ${cross ? (cross.prevDayDelta == null ? '--' : cross.prevDayDelta) : '--'}）；日线「强度 − 差劲」序列 ${deltasText}`,
      reason: crossPassed
        ? `过去 ${DEATH_CROSS_WINDOW} 个交易日内出现过「强度分由高于差劲分转为一度低于差劲分」的死叉（${crossDateText}）；死叉之后至昨日 delta ≥ ${DELTA_MIN} 的交易日数为 ${hitCount}（≤ 1 天视为未被历史消耗，本策略只允许「第一次或第二次」达标才买）；且上个交易日 delta = ${cross ? cross.prevDayDelta : '--'}${cross && cross.prevDayDelta != null && cross.prevDayDelta > DELTA_MIN ? ' > ' + DELTA_MIN + '，该日成交量须 ≥ 其前 3 个交易日成交量均值（放量门禁已通过）' : '（未超过 ' + DELTA_MIN + '，不触发放量要求）'}`
        : `尚未满足「过去 ${DEATH_CROSS_WINDOW} 个交易日内死叉 + 死叉后达标次数 ≤ 1 + 上个交易日 delta > ${DELTA_MIN} 时须放量」的买点前置（死叉日 ${crossDateText}，死叉后达标 ${hitCount} 次）`,
    },
    {
      id: 'extreme_win_prev_strength_gap',
      title: `买点门禁：上个交易日强度分 > ${PREV_STRENGTH_GAP_GATE} 时当日竞价低开须 ≥ ${OPEN_GAP_MIN_PCT}%`,
      passed: gatePassed,
      value: `上个交易日强度分 ${cross && cross.prevDayStrength != null ? cross.prevDayStrength : '--'}；当日竞价高开 ${candidate ? candidate.aRaw : '--'}%`,
      reason: gatePassed
        ? (cross && cross.prevDayStrength != null && cross.prevDayStrength > PREV_STRENGTH_GAP_GATE
            ? `上个交易日强度分 ${cross.prevDayStrength} > ${PREV_STRENGTH_GAP_GATE}，故当日竞价低开不得超过 ${OPEN_GAP_MIN_PCT}%；本股当日竞价高开 ${candidate ? candidate.aRaw : '--'}% ≥ ${OPEN_GAP_MIN_PCT}%，满足门禁`
            : `上个交易日强度分 ${cross && cross.prevDayStrength != null ? cross.prevDayStrength : '数据缺失（不判定）'} ≤ ${PREV_STRENGTH_GAP_GATE}，不触发竞价低开限制`)
        : `上个交易日强度分 ${cross && cross.prevDayStrength != null ? cross.prevDayStrength : '--'} > ${PREV_STRENGTH_GAP_GATE}，当日竞价高开 ${candidate ? candidate.aRaw : '--'}% < ${OPEN_GAP_MIN_PCT}%，竞价低开超过限制，该候选不可买`,
    },
    {
      id: 'extreme_win_diff',
      title: `今日差劲分 ${d ? d.score : '--'}（越高越差）`,
      passed: true,
      value: d
        ? `${d.limitDown ? '当日跌停 → 差劲分封顶 100；' : ''}A 放量 ${d.aRaw == null ? '--' : d.aRaw}（分 ${d.aScore}）· B 跳水 ${d.bRaw}%（分 ${d.bScore}）· C 冲高回落 ${d.cRaw}%（分 ${d.cScore}）· D ${d.dRaw < 0 ? `跌幅 ${d.dRaw}%` : `炸板 ${d.dRaw} 次`}（分 ${d.dScore}）`
        : '分时数据不足',
      reason: d
        ? `差劲分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${d.aScore} + 0.2×${d.bScore} + 0.3×${d.cScore} + 0.2×${d.dScore} = ${d.score}（A 为分时累计成交量对该股前 3 个交易日日均量的放量比；B 上限 5%、C 上限 10%；D：当日跌停记 100，触及涨停价取炸板次数，未涨停改用跌幅；均按盘中截至当前桶口径）`
        : '分时数据不足，无法计算差劲分',
    },
    {
      id: 'extreme_win_strength',
      title: `今日强度分 ${s ? s.score : '--'}（越高越强）`,
      passed: true,
      value: s
        ? `A 竞价高开 ${s.aRaw}%（分 ${s.aScore}）· B 分钟最大涨幅 ${s.bRaw}%（分 ${s.bScore}）${s.isOneWord ? '（一字板）' : ''} · C 抗分歧 ${s.cRaw}（分 ${s.cScore}）· D 当日涨幅 ${s.dRaw}%（分 ${s.dScore}）`
        : '分时数据不足',
      reason: s
        ? `强度分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${s.aScore} + 0.2×${s.bScore} + 0.3×${s.cScore} + 0.2×${s.dScore} = ${s.score}（A 上限 10%、B 上限 10%、C 上限 20%、D 上限 10%）；时点价 ${candidate ? candidate.px : '--'}（昨收 ${s.preclose}，现价涨幅 ${s.changePct}%）`
        : '分时数据不足，无法计算强度分',
    },
    {
      id: 'extreme_win_threshold',
      title: `买点判定：今日「强度分 − 差劲分 ≥ ${DELTA_MIN}」`,
      passed: deltaOk,
      value: candidate && candidate.delta != null
        ? `${candidate.strengthScore} − ${candidate.diffScore} = ${candidate.delta} ${deltaOk ? '≥' : '<'} ${DELTA_MIN}`
        : '分时数据不足',
      reason: deltaOk
        ? `今日强度分 ${candidate.strengthScore} 高于今日差劲分 ${candidate.diffScore} 达 ${candidate.delta}，达到 ${DELTA_MIN} 门槛，满足死叉后金叉「分歧转一致」低吸反转买入条件`
        : `今日「强度分 − 差劲分」${candidate && candidate.delta != null ? `= ${candidate.delta}` : '数据不足'}，未达到 ${DELTA_MIN} 门槛`,
    },
    {
      id: 'extreme_win_index_slope',
      title: '买点门禁：上证指数 3 日线分时斜率为正',
      passed: slopeOk,
      value: `上证指数 3 日线斜率 ${fmtKeyBlockSlope(ctx.indexSlope)}（需 > 0）`,
      reason: slopeOk
        ? `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线分时斜率 = MA3(今日实时) − MA3(昨日收盘) = ${ctx.indexSlope}，为正（> 0），大盘短期趋势向上，允许买入`
        : `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线分时斜率 ${fmtKeyBlockSlope(ctx.indexSlope)} 未为正，或数据不足，当前不允许买入`,
    },
  ];
  return checks;
};

const getExtremeWinBuyPointChecks = async (targetDate = null, refresh = false) => {
  try {
    const ctx = await fetchExtremeWinContext(targetDate);
    const rows = ctx.rows || [];
    const notLimitUp = rows.filter(r => r.listPassed && !r.isLimitUp).sort(byDeltaDesc);
    const candidate = notLimitUp[0] || rows.filter(r => r.listPassed)[0] || rows[0] || null;

    const checks = buildExtremeWinChecks(ctx, candidate);
    const allPassed = rows.some(r => r.buyPointHit);
    const passedCount = checks.filter(c => c.passed).length;
    const totalCheckCount = checks.length;

    const poolCount = (ctx.pool.stocks || []).length;
    const conclusion = allPassed
      ? '龙头池出现完整买点标的（强度分 − 差劲分 ≥ 30 且上证 3 日线斜率为正），可关注买入时机。分仓管理是最后一道防火墙。'
      : poolCount === 0
        ? '龙头池当前无满足条件的标的，请耐心等待。'
        : '龙头池暂未出现完整买点标的（需强度分 − 差劲分 ≥ 30 且上证 3 日线斜率为正），请耐心等待。';

    return {
      success: true,
      data: {
        mode: MODE_EXTREME_WIN,
        targetDate: ctx.dateStr,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        refreshed: !!refresh,
        checks,
        allPassed,
        passedCount,
        totalCheckCount,
        conclusion,
      },
    };
  } catch (e) {
    return { success: false, message: e.message || '买点诊断失败' };
  }
};

// ============================================================
// 卖点诊断 9 条（完整龙头战法）；不调用 buySellDiagnose.checkSellPointDetailed（口径不同）
// ============================================================
const mkCond = (name, satisfied, detail, extra = {}) => ({
  name, satisfied, detail,
  exempted: !!extra.exempted,
  pending: !!extra.pending,
  pendingMinutes: extra.pendingMinutes != null ? extra.pendingMinutes : null,
});

const checkExtremeWinSellPointDetailed = async (code, costPrice = null, buyDate = null) => {
  try {
    const targetDay = resolveTargetDay(null);
    const dateStr = targetDay.format('YYYYMMDD');
    const dateNum = Number(dateStr);
    const isToday = dateStr === dayjs().format('YYYYMMDD');
    const afterClose = !isToday || isAfterMarketClose();

    const t = await loadTlinePoints(code, dateNum);
    const points = t.points || [];
    const preclose = t.preclose;
    const mins = points.filter(p => p.lastPx > 0);

    // 成本价：优先请求传入；缺省从持仓列表读取（与现有 checkSingleStockSellPoint 一致）
    let effCostPrice = Number(costPrice);
    if (!Number.isFinite(effCostPrice) || effCostPrice <= 0) {
      const positions = getStockPositions() || [];
      const pos = positions.find(p => p && String(p.code) === String(code));
      effCostPrice = pos && pos.costPrice != null ? Number(pos.costPrice) : null;
    }

    const chgOf = (px) => (preclose > 0 && px > 0) ? round2(((px - preclose) / preclose) * 100) : null;
    const openPx = mins.length > 0 ? mins[0].lastPx : null;
    const lastPx = mins.length > 0 ? mins[mins.length - 1].lastPx : null;

    if (mins.length === 0) {
      return {
        success: true,
        isSell: false,
        reasons: ['分时数据不足'],
        stockName: code,
        tradeDate: dateNum,
        conditions: [
          mkCond('跌破成本线 -5%（即时）', false, '分时数据不足'),
          mkCond('盘中分时跌幅 ≤ -5%', false, '分时数据不足'),
          mkCond('较开盘价下挫 5 个点', false, '分时数据不足'),
          mkCond('单分钟跳水 ≥ 3 个点', false, '分时数据不足'),
          mkCond('持仓股跌停', false, '分时数据不足'),
          mkCond('高位放量大阴线', false, '分时数据不足'),
          mkCond('持仓第 3 日未拉开 +10%', false, '分时数据不足', { exempted: true }),
          mkCond('竞价低开 < -5%', false, '分时数据不足'),
          mkCond('当日收盘抗分歧指数 < 6', false, '分时数据不足', { pending: true }),
        ],
        conclusion: '分时数据不足，无法诊断',
        mode: MODE_EXTREME_WIN,
        detail: { closePrice: null, change: null, resilienceScore: null },
      };
    }

    // 全时段最小涨跌幅 / 最小开盘跌幅
    let minChg = null;
    let minOpenDrop = null;
    for (const p of mins) {
      const v = chgOf(p.lastPx);
      if (v != null && (minChg == null || v < minChg)) minChg = v;
      if (openPx > 0) {
        const od = round2(((p.lastPx - openPx) / openPx) * 100);
        if (od != null && (minOpenDrop == null || od < minOpenDrop)) minOpenDrop = od;
      }
    }

    const conditions = [];

    // ① 跌破成本线 -5%（即时）
    let c1 = false;
    let c1Detail = '成本价缺失，无法判定';
    if (effCostPrice > 0 && lastPx != null) {
      const stopPx = effCostPrice * 0.95;
      const costRet = round2(((lastPx - effCostPrice) / effCostPrice) * 100);
      c1 = lastPx < stopPx;
      c1Detail = `${c1 ? '已' : '未'}跌破成本线 -5%（成本 ${effCostPrice.toFixed(2)}，止损价 ${stopPx.toFixed(2)}，现价 ${lastPx.toFixed(2)}，较成本 ${costRet}%），${c1 ? '即时卖出' : '继续持有'}`;
    }
    conditions.push(mkCond('跌破成本线 -5%（即时）', c1, c1Detail));

    // ② 盘中分时跌幅 ≤ -5%（较昨收）
    const c2 = minChg != null && minChg <= -5;
    conditions.push(mkCond('盘中分时跌幅 ≤ -5%', c2,
      `当日最低分时涨跌幅 ${minChg == null ? '--' : minChg}%（较昨收 ${preclose != null ? round2(preclose) : '--'}）${c2 ? ' ≤ -5%，直接卖出' : '，未达 -5%'}`));

    // ③ 较开盘价下挫 5 个点
    const c3 = minOpenDrop != null && minOpenDrop <= -5;
    conditions.push(mkCond('较开盘价下挫 5 个点', c3,
      `当日最低较开盘价跌幅 ${minOpenDrop == null ? '--' : minOpenDrop}%（开盘 ${openPx != null ? round2(openPx) : '--'}）${c3 ? ' ≤ -5%，直接卖出' : '，未达 -5%'}`));

    // ④ 单分钟跳水 ≥ 3 个点（含「上一分钟自身涨幅 > 2% 则豁免」）
    let c4 = false;
    let c4Detail = '未出现单分钟跳水';
    for (let i = 1; i < mins.length; i++) {
      const prev = mins[i - 1];
      const cur = mins[i];
      if (!(prev.lastPx > 0)) continue;
      const plunge = round2(((cur.lastPx - prev.lastPx) / prev.lastPx) * 100);
      if (plunge == null || plunge > -3) continue;
      const prevPrev = i >= 2 ? mins[i - 2] : null;
      const prevGain = prevPrev && prevPrev.lastPx > 0
        ? round2(((prev.lastPx - prevPrev.lastPx) / prevPrev.lastPx) * 100)
        : null;
      if (prevGain != null && prevGain > 2) continue; // 上一分钟急拉 → 本次豁免
      c4 = true;
      c4Detail = `盘中 1 分钟内跳水（上一分钟 ${prev.lastPx.toFixed(2)} → 现价 ${cur.lastPx.toFixed(2)}，单分钟跌幅 ${plunge}% ≤ -3%），直接卖出`;
      break;
    }
    conditions.push(mkCond('单分钟跳水 ≥ 3 个点', c4, c4Detail));

    // ⑤ 持仓股跌停（较昨收 < -9%）
    const c5 = minChg != null && minChg < -9;
    conditions.push(mkCond('持仓股跌停', c5,
      `当日最低分时涨跌幅 ${minChg == null ? '--' : minChg}%${c5 ? ' < -9%，触及跌停' : '，未触及跌停'}`));

    // ⑥ 高位放量大阴线：当日最高回落现价 > 8% 且现价 < 开盘
    let c6 = false;
    let c6Detail = '未出现高位放量大阴线';
    if (openPx > 0) {
      let hi = 0;
      for (const p of mins) {
        if (p.lastPx > hi) hi = p.lastPx;
        const amp = p.lastPx > 0 ? ((hi - p.lastPx) / p.lastPx) * 100 : 0;
        if (amp > 8 && p.lastPx < openPx) {
          c6 = true;
          c6Detail = `高位放量大阴线（当日最高 ${hi.toFixed(2)} 回落至 ${p.lastPx.toFixed(2)}，跌幅 ${round2(amp)}% > 8%，且现价 < 开盘 ${openPx.toFixed(2)}）`;
        }
      }
    }
    conditions.push(mkCond('高位放量大阴线', c6, c6Detail));

    // ⑦ 持仓第 3 日未拉开 +10%（非第 3 日豁免；未到尾盘待确认）
    let c7 = false;
    let c7Detail = '未提供买入日期，不适用';
    let c7Exempted = true;
    let c7Pending = false;
    if (buyDate) {
      const bd = String(buyDate).replace(/-/g, '');
      const daysSince = countTradingDaysBetween(bd, dateStr); // (buyDate, today] 的交易日数
      if (daysSince == null) {
        c7Detail = '买入日期非法，不适用';
      } else if (daysSince + 1 !== 3) {
        c7Detail = `当前为持仓第 ${daysSince + 1} 日，非第 3 日，不适用`;
      } else {
        const isTail = afterClose || (mins.length > 0 && mins[mins.length - 1].minute >= 1457);
        if (!isTail) {
          c7Exempted = false;
          c7Pending = true;
          c7Detail = `持仓第 3 日，待尾盘 14:57 后判定是否未拉开 +10%（当前现价 ${lastPx != null ? round2(lastPx) : '--'}）`;
        } else {
          c7Exempted = false;
          const ret = effCostPrice > 0 && lastPx != null
            ? round2(((lastPx - effCostPrice) / effCostPrice) * 100)
            : null;
          c7 = ret != null && ret < 10;
          c7Detail = ret == null
            ? '成本价缺失，无法判定持仓第 3 日涨幅'
            : `持仓第 3 日尾盘现价 ${round2(lastPx)}，较成本 ${effCostPrice.toFixed(2)} 涨幅 ${ret}% ${c7 ? '< +10%，未拉开 → 卖出' : '≥ +10%，继续持有'}`;
        }
      }
    }
    conditions.push(mkCond('持仓第 3 日未拉开 +10%', c7, c7Detail, { exempted: c7Exempted, pending: c7Pending }));

    // ⑧ 竞价低开 < -5%
    const openChg = mins.length > 0 ? chgOf(mins[0].lastPx) : null;
    const c8 = openChg != null && openChg < -5;
    conditions.push(mkCond('竞价低开 < -5%', c8,
      `当日竞价开盘涨跌幅 ${openChg == null ? '--' : openChg}%（昨收 ${preclose != null ? round2(preclose) : '--'}，开盘 ${mins[0].lastPx.toFixed(2)}）${c8 ? ' < -5%，直接卖出' : '，未达 -5%'}`));

    // ⑨ 当日收盘抗分歧指数 < 6（未收盘待确认）
    let c9 = false;
    let c9Pending = false;
    let c9Detail = '抗分歧指数待判定';
    let resilienceScore = null;
    const idxT = await loadTlinePoints(iceResilienceIndexCode(code), dateNum);
    const idxPts = idxT.points || [];
    const atClose = afterClose || (mins.length > 0 && mins[mins.length - 1].minute >= 1457);
    if (!atClose) {
      c9Pending = true;
      c9Detail = '未到收盘，抗分歧指数待收盘判定';
    } else if (mins.length >= 5 && idxPts.length >= 5) {
      const r = calculateReplayResilience(mins, idxPts, code);
      if (r == null || !Number.isFinite(Number(r))) {
        c9Pending = true;
        c9Detail = '抗分歧指数数据不足，待判定';
      } else {
        resilienceScore = round2(r);
        c9 = Number(r) < 6;
        c9Detail = `当日收盘抗分歧指数 ${resilienceScore} ${c9 ? '< 6，卖出' : '≥ 6，继续持有'}`;
      }
    } else {
      c9Pending = true;
      c9Detail = '分时数据不足，抗分歧指数待判定';
    }
    conditions.push(mkCond('当日收盘抗分歧指数 < 6', c9, c9Detail, { pending: c9Pending }));

    const isSell = conditions.some(c => c.satisfied && !c.exempted);
    const reasons = isSell
      ? conditions.filter(c => c.satisfied).map(c => c.detail)
      : ['当前未达到龙头战法卖点条件，可以继续持有'];

    return {
      success: true,
      isSell,
      reasons,
      stockName: code,
      tradeDate: dateNum,
      conditions,
      conclusion: isSell
        ? '已触发龙头战法卖点条件，建议卖出 / 减仓。'
        : '当前未达到龙头战法卖点条件，可以继续持有。',
      mode: MODE_EXTREME_WIN,
      detail: {
        closePrice: lastPx != null ? round2(lastPx) : null,
        change: lastPx != null ? chgOf(lastPx) : null,
        resilienceScore,
      },
    };
  } catch (error) {
    console.error('情绪游资-极致胜率卖点诊断失败:', error);
    return {
      success: false,
      isSell: false,
      reasons: ['诊断失败'],
      stockName: code,
      conditions: [],
      conclusion: '诊断失败',
      mode: MODE_EXTREME_WIN,
    };
  }
};

module.exports = {
  MODE_EXTREME_WIN,
  getHotMoneyLeaderList,
  getExtremeWinBuyPointChecks,
  checkExtremeWinSellPointDetailed,
};
