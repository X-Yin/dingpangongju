// ============================================================
// 「情绪游资-极致胜率」live 服务（开盘实战页「切换模式」使用）
//   与回测引擎 engine/extremeWinBacktest.js 共用同一份候选池 / 死叉 / 打分实现
//   （engine/extremeWinPool.js、engine/extremeWinScores.js、engine/indexGate.js），
//   保证线上展示与回测口径完全一致（2026-10-17 用户要求）。
//
//   导出：
//     getHotMoneyLeaderList(targetDate, limit)     龙头列表（除 delta≥30 与上证斜率>0 外全部买点条件满足）
//     getExtremeWinBuyPointChecks(targetDate, ...) 买点诊断 8 项（结构同科技进攻，便于前端复用；含买入截止时间门禁，默认 14:30）
//     checkExtremeWinSellPointDetailed(code, costPrice, buyDate, opts) 卖点诊断 11 条（完整龙头战法 + ⑪冲高回落/⑫开盘自救）
// ============================================================
const dayjs = require('dayjs');
const { batchParallel, isAfterMarketClose, resolveAnalysisDate } = require('../utils');
const { countTradingDaysBetween, isTradingDay } = require('../utils/tradingDay');
const { getStockPositions } = require('./stockPosition');
const { getPastTradingDates, stockPriorAvgVolume } = require('./buySellBacktest/deps');
const { calculateReplayResilience } = require('./buySellBacktest/diagnose/sellPoint');
const {
  DEATH_CROSS_WINDOW, DELTA_MIN, CLOSE_MINUTE,
  PREV_STRENGTH_GAP_GATE, OPEN_GAP_MIN_PCT,
  ABNORMAL_WARN_MIN_ROOM_PCT, buildAbnormalWarnBases, evalAbnormalWarn, abnormalWarnText,
  LARGE_CAP_FLOAT_MV_YI, CAP_BOARD_WINDOW_DAYS, CAP_BOARD_MIN_GAIN_PCT, NEW_MIN_WINDOW_RANGE_PCT,
  OLD_POST_PEAK_MAX_RANGE_PCT,
  computeCrossInfo, buildExtremeWinPool,
} = require('./buySellBacktest/engine/extremeWinPool');
const {
  loadTlinePoints, strengthAtMinute, diffAtMinute, round2, limitUpThresholdOf, clearTodayTlineCache,
} = require('./buySellBacktest/engine/extremeWinScores');
const {
  ICE_SIGNAL_INDEX_CODE, getIceMa3SlopeIntraday, fmtKeyBlockSlope, iceResilienceIndexCode, precomputeTurnMap,
} = require('./buySellBacktest/engine/indexGate');
// 逆周期（反向抱团龙头）候选池 + 择时常量（与回测引擎 engine/reverseLeaderPool.js 共用同一实现）
const {
  LOOKBACK_DAYS: REV_LOOKBACK_DAYS,
  MIN_BOARD_COUNT: REV_MIN_BOARD_COUNT,
  RANGE_WINDOW_DAYS: REV_RANGE_WINDOW_DAYS,
  RANGE_SLIDE_DAYS: REV_RANGE_SLIDE_DAYS,
  MIN_WINDOW_RANGE_PCT: REV_MIN_WINDOW_RANGE_PCT,
  INDEX_DROP_PCT: REV_INDEX_DROP_PCT,
  STRENGTH_MIN: REV_STRENGTH_MIN,
  HIT_REQUIRED: REV_HIT_REQUIRED,
  NEG_STREAK_MIN_DAYS: REV_NEG_STREAK_MIN_DAYS,
  BIG_DROP_MAX_TIMES: REV_BIG_DROP_MAX_TIMES,
  POST_PEAK_MAX_RANGE_PCT: REV_POST_PEAK_MAX_RANGE_PCT,
  isReverseEligible,
  buildReverseLeaderPool,
} = require('./buySellBacktest/engine/reverseLeaderPool');

const MODE_EXTREME_WIN = 'hot_money_extreme_win';
// 攻防兼备（2026-10-20 新增）：融合「科技进攻(快进快出)」与「情绪游资-极致胜率(双腿)」双策略同时诊断，
// 对应回测融合策略 sci_attack_emo_win（引擎 runFusedEmoWinBacktest）
const MODE_ATTACK_DEFENSE = 'attack_defense';

// 反向抱团「强度分命中次数」回溯窗口上限（交易日）：与回测口径一致（窗口自「上证 3 日线斜率由正转负日」起算）
// 逆周期命中计数窗口（2026-11-05 对齐回测）：回测 revHitCount 自「由负转正日」起全窗口累计、
// 无天数上限（extremeWinBacktest.js / fusedEmoWinBacktest.js），线上此前截断 20 日会导致长负斜率
// 窗口漏计命中 → 线上少买。现去掉截断，回溯拉取量放大到 250 个交易日覆盖任意长度窗口
const REVERSE_HIT_LOOKBACK_DAYS = 250;
// 2026-10-20 用户新增、2026-10-24 用户改为 14:30：每天 14:30 之后不买（14:30 桶本身仍可买；顺周期/逆周期两条腿均适用，与回测引擎 BUY_CUTOFF_MINUTE 同口径）。
//   判定口径：盘中取「候选池分时最新分钟」；盘前尚无分时数据视为未过截止；收盘后/历史日期一律视为已过截止。
//   顺周期作用于 buyPointHit；逆周期作用于 timingPassed（命中登记照常累计，仅不再触发买入）
//   2026-10-24 用户要求：仅「情绪游资-极致胜率」用 14:30；「攻防兼备」模式的 EW 腿保持 13:30（调用方传 buyCutoffMinute）
const BUY_CUTOFF_MINUTE = 1430;
const ATTACK_DEFENSE_BUY_CUTOFF_MINUTE = 1330;
// ⑪⑫ 竞价大幅低开后的「开盘自救」（2026-10-31 用户改版；仅「情绪游资-极致胜率」/「攻防兼备」的顺周期持仓，
//   持仓标记为 reverse（逆周期）时不启用，未标记按顺周期处理）：
//   当日竞价开盘价较昨收 < -2% 时启用——自开盘起进入自救观察期（截至 9:35）：
//   ① 期间「回落不低于开盘价」且「距当日分时最高涨幅回落 ≤ 2 个百分点」时先不卖；
//   ② 跌破开盘价 → ⑫ 在该分钟卖出；自当日最高涨幅回落超过 2 个百分点 → ⑪ 在该分钟卖出；
//   ③ 9:35 当日涨幅已脱离 ≤ -5% 区域 → 自救成功，当日剩余时间不再因⑪⑫卖出（交由其他卖点规则）；
//      9:35 仍处于 ≤ -5% 区域 → 自救失败，在 9:35 按分时价卖出。
//   期间 ⑤竞价低开 与 ⑦盘中跌幅 在观察期内不再直接判定，避免把自救机会吃掉（与回测 leaderSellMinute 同口径）
const OPEN_GAP_REBOUND_PCT = -2;
const RESCUE_EVAL_MINUTE = 935;   // 自救判定时点：9:35
const RESCUE_TOLERANCE_PCT = 2;   // 自当日分时最高涨幅回落的容忍幅度（个百分点）
// 命中次数缓存（仅历史交易日，key = `${code}|${dateNum}|3m|resIdx`）：当日盘中实时重算，不缓存
//   3m/resIdx 后缀：与回测 3 分钟时间桶 + 个股韧性指数口径对齐后，旧的全分钟命中缓存不再可用
const reversePastHitCache = new Map();

// 回测买点评估时间桶：含 9:30 / 13:00，上午 9:30~11:30、下午 13:00~15:00，每 3 分钟一个桶边界
//   与 engine/extremeWinBacktest.js buildThreeMinuteSlots 完全同口径
const buildThreeMinuteSlots = () => {
  const slots = [];
  const pushRange = (startHour, startMinute, endHour, endMinute) => {
    for (let t = startHour * 60 + startMinute; t <= endHour * 60 + endMinute; t += 3) {
      slots.push(Math.floor(t / 60) * 100 + (t % 60));
    }
  };
  pushRange(9, 30, 11, 30);
  pushRange(13, 0, 15, 0);
  return slots;
};
const THREE_MINUTE_SLOTS = buildThreeMinuteSlots();
const THREE_MINUTE_SLOT_SET = new Set(THREE_MINUTE_SLOTS);

// 盘中评估分钟：按当前时钟向下取整到 3 分钟桶（与回测逐桶推进一致）；午休归到 11:30，收盘归到 15:00
const resolveEvalMinute = (minute) => {
  const m = Number(minute);
  if (!Number.isFinite(m) || m <= 0) return null;
  const total = Math.floor(m / 100) * 60 + (m % 100);
  const floored = total - (total % 3);
  if (floored < 570) return null;                    // 9:30 之前
  let hhmm = Math.floor(floored / 60) * 100 + (floored % 60);
  if (hhmm > 1130 && hhmm < 1300) hhmm = 1130;       // 午休
  if (hhmm > 1500) hhmm = 1500;                      // 收盘后
  return THREE_MINUTE_SLOT_SET.has(hhmm) ? hhmm : null;
};

const fmtMinuteText = (m) => (m == null
  ? '--'
  : `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`);

// 取截至某分钟的最后一条分时点（与回测 priceAtMinute 同口径）
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};

// 当前时钟分钟（HHMM），用于盘中 3 分钟桶评估
const currentClockMinute = () => {
  const now = dayjs();
  return now.hour() * 100 + now.minute();
};

// ---------- 交易日回退（与 getBuyPointChecks 口径一致） ----------
const resolveTargetDay = (targetDate) => {
  if (targetDate) {
    const dateStr = String(targetDate).replace(/-/g, '');
    const d = dayjs(dateStr, 'YYYYMMDD');
    return d.isValid() ? d : dayjs();
  }
  const now = dayjs();
  // 竞价时间（交易日 9:15–9:30）使用当天：当日分时尚未生成，涨幅/强度−差劲以 '--' 展示
  // （THS/CLS 分时接口均有请求日期校验，竞价期间查当天只会返回空分时，不会误用昨日数据）
  const minuteOfDay = now.hour() * 60 + now.minute();
  if (isTradingDay(now.toDate()) && minuteOfDay >= 9 * 60 + 15 && minuteOfDay < 9 * 60 + 30) {
    return now;
  }
  // 非交易日 / 9:15 前：回退到上一个交易日，避免列表与诊断因当日无数据而为空
  return dayjs(resolveAnalysisDate(now.toDate()));
};

// ============================================================
// 共享上下文：池 + 死叉信息 + 盘中实时打分（一次算出供列表 / 买点诊断复用）
// ============================================================
const fetchExtremeWinContext = async (targetDate = null, buyCutoffMinute = BUY_CUTOFF_MINUTE) => {
  const targetDay = resolveTargetDay(targetDate);
  const dateStr = targetDay.format('YYYYMMDD');
  const dateNum = Number(dateStr);
  const isToday = dateStr === dayjs().format('YYYYMMDD');
  const afterClose = !isToday || isAfterMarketClose();

  // 1) 候选池（过去 10/20 交易日连板准入：流通市值 > 100 亿元者两连板（连板数 ≥ 2）+ 含该连板日的 5 日累计涨幅 > 45%，其余需四连板及以上；
  //    10 日最大涨幅窗口「从第一天涨停的前一交易日收盘价起算」（2026-10-31 与回测同口径）；
  //    并剔除创业板/科创板/题材黑名单/科技自选股重叠/近期大幅拉升）
  const pool = await buildExtremeWinPool(dateStr, {
    fromFirstLimitUp: true,
    capBoardMinGainPct: CAP_BOARD_MIN_GAIN_PCT,
    // 2026-11-14 用户要求：旧路径追加「峰值日（含）至买点前区间最大波动 < 20%」（与回测同口径）
    oldPostPeakMaxRangePct: OLD_POST_PEAK_MAX_RANGE_PCT,
  });
  const poolStocks = pool.stocks || [];

  // 2) 死叉口径（与回测 crossDatesOf 完全同口径）：
  //   优先用候选池的完整 winDates + 个股峰值窗口起止日，由 computeCrossInfo 先做「死叉 + 次日未创新高 → 峰值锁死」，
  //   再取锁定后峰值日之后的第一次死叉；峰值日缺失时退回过去 DEATH_CROSS_WINDOW 个交易日
  const poolWinDates = (pool.winDates || []).map(Number);
  const fallbackCrossDates = (await getPastTradingDates(dateStr, DEATH_CROSS_WINDOW)).map(Number);
  const crossInfos = poolStocks.length > 0
    ? await batchParallel(poolStocks, async (s) => {
        try {
          const p = Number(s.peakDate);
          const useWindow = Number.isFinite(p) && poolWinDates.length > 0;
          const cd = useWindow ? poolWinDates : fallbackCrossDates;
          const peakWindow = useWindow ? { windowStart: s.windowStart, windowEnd: s.windowEnd } : null;
          return cd.length < 2 ? null : await computeCrossInfo(s.code, cd, s.peakDate, peakWindow);
        } catch (e) { return null; }
      }, 6)
    : [];

  // 3) 当日分时（进程内缓存；当日盘中 5s TTL 短缓存支持 live 刷新，历史日期永久缓存）
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

  // 4.5) 严重异动临近测算（2026-11-02 用户要求）：买入前按「T-10 / T-30 收盘价」测算累计涨幅剩余空间，
  //   任一距 100% / 200% 的剩余 ≤ 10% 即视为临近严重异动，买点不命中（与回测引擎同口径）
  let abnormalDates = [];
  try { abnormalDates = await getPastTradingDates(dateStr, 30); } catch (e) { abnormalDates = []; }
  const abnormalBases = new Map();
  for (const s of poolStocks) {
    try { abnormalBases.set(s.code, buildAbnormalWarnBases(s.code, abnormalDates)); } catch (e) { abnormalBases.set(s.code, null); }
  }

  // 5) 计算口径分钟：收盘后按 1500；盘中按当前时钟向下取整到 3 分钟桶（与回测逐桶推进一致），
  //   避免用「分时最后点」导致线上比回测多/少一个桶（数据端分钟可能领先本地时钟 1~2 分钟）
  let minute = CLOSE_MINUTE;
  let latestTlineMinute = 0;
  if (!afterClose) {
    let maxMinute = 0;
    for (const t of tlineList) {
      const pts = (t && t.points) || [];
      if (pts.length > 0) {
        const m = pts[pts.length - 1].minute;
        if (Number.isFinite(m) && m > maxMinute) maxMinute = m;
      }
    }
    if (maxMinute > 0) {
      latestTlineMinute = maxMinute;
      minute = resolveEvalMinute(currentClockMinute())
        || resolveEvalMinute(maxMinute)
        || CLOSE_MINUTE;
    }
  }

  // 5.5) 买入截止（2026-10-20 用户新增，与回测引擎同口径）：截止分钟之后不买（截止桶本身仍可买）
  const buyWindowOpen = afterClose ? false : (latestTlineMinute > 0 ? minute <= buyCutoffMinute : true);

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
      : (points.length > 0 ? minute : CLOSE_MINUTE);

    let avg3Vol = null;
    try { avg3Vol = stockPriorAvgVolume(code, dateNum, 3); } catch (e) { avg3Vol = null; }

    const diff = points.length > 0 ? diffAtMinute(points, preclose, code, stockMinute, avg3Vol) : null;
    const idxT = idxTlineMap.get(iceResilienceIndexCode(code)) || { points: [] };
    const strength = points.length > 0 ? strengthAtMinute(t, stockMinute, code, idxT.points) : null;
    const delta = (diff && strength) ? round2(strength.score - diff.score) : null;

    const atPt = points.length > 0 ? priceAtMinute(points, stockMinute) : null;
    const px = atPt ? round2(atPt.lastPx) : null;
    const change = (preclose > 0 && px != null) ? round2(((px - preclose) / preclose) * 100) : null;
    const aRaw = strength ? strength.aRaw : null;
    const isLimitUp = strength
      ? !!strength.limitUp
      : (change != null && change > limitUpThresholdOf(code));
    const abnormalWarn = evalAbnormalWarn(abnormalBases.get(code), px);

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
    // 2026-10-20 用户新增：买入截止后不买——买入窗口关闭时买点一律不命中（与回测引擎同口径）
    // 2026-11-02 用户新增：临近严重异动（剩余空间 ≤ 10%）不买
    // 与回测 evalBucket → 买入分支同口径：涨停不可买（回测 finalPick 明确跳过 limitUp）
    const buyPointHit = listPassed && deltaOk && !isLimitUp && indexSlope != null && indexSlope > 0 && buyWindowOpen && !abnormalWarn.blocked;

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
      abnormalWarn,
      minute: stockMinute,
    };
  });

  return {
    dateStr,
    dateNum,
    isToday,
    afterClose,
    minute,
    buyWindowOpen,
    buyCutoffMinute,
    buyGateMinute: afterClose ? null : (latestTlineMinute > 0 ? minute : null),
    indexSlope,
    pool,
    rows,
  };
};

const byDeltaDesc = (a, b) => ((b.delta == null ? -Infinity : b.delta) - (a.delta == null ? -Infinity : a.delta));

// 14:30 时间门禁的口径时间展示文本（buyGateMinute 为 null 时：收盘后/历史 → 已收盘；盘前暂无分时 → 盘前）
const gateTimeText = (ctx) => {
  const m = ctx && ctx.buyGateMinute;
  if (m == null || !Number.isFinite(Number(m))) return ctx && ctx.afterClose ? '已收盘' : '盘前（暂无分时数据）';
  return `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
};
// 买入截止时间展示文本（不同模式口径不同：情绪游资-极致胜率 14:30 / 攻防兼备 EW 腿 13:30）
const cutoffText = (ctx) => {
  const m = ctx && ctx.buyCutoffMinute != null ? Number(ctx.buyCutoffMinute) : BUY_CUTOFF_MINUTE;
  return `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`;
};

// ============================================================
// 逆周期（反向抱团龙头）上下文：候选池（全部）+ 择时状态（上证斜率天数 / 当日上证跌幅 / 强度分命中次数）
//   与回测引擎口径完全一致：窗口自「上证 3 日线斜率由正转负日」起算，窗口变化即清零；
//   命中判定 = 某交易日上证当日跌幅 ≤ -0.5% 的 3 分钟桶内，候选股盘中强度分首次 > 50 记 1 次（同一天同股只计一次），
//   累计上限 HIT_REQUIRED；买点 = 历史已命中 ≥ 1 次后，当日某 3 分钟桶「新命中」的当桶（未涨停、未过买入截止）。
//   即：历史已累计 2 次但当日没有再出现 > 50 新命中时，不再触发买点（与回测 revDayTriggered 逐桶买入完全对齐）。
//   说明：为使线上展示轻量，命中次数按「当前（今日）候选池」回溯历史窗口各交易日统计
//   （回测中每日池按当日行情独立重建，属已知近似）。
// ============================================================
const reverseTimestampText = (daysSinceTurnNeg) => (daysSinceTurnNeg == null
  ? '--'
  : `第 ${daysSinceTurnNeg + 1} 天`);

// 计算各候选在负斜率窗口内已累计的强度分命中次数（与回测 3 分钟桶口径完全一致）
//   逐交易日重建「当日候选池 ∩ 今日池代码」再统计命中（回测每个交易日按当日行情重建池）：
//   仅在「该 3 分钟桶的上证当日跌幅 ≤ -0.5%」时，统计该股盘中强度分首次 > 50（同一交易日同一只只计 1 次）
//   返回值：{ counts: 累计次数(≤HIT_REQUIRED), priorCounts: 不含当日的历史次数, todayHitMinutes: 当日首次命中桶 }
const computeReverseHitCounts = async (codes, windowDates, todayNum, todayCutoffMinute) => {
  const counts = new Map(codes.map(c => [c, 0]));
  let priorCounts = null;
  const todayHitMinutes = new Map();
  const codeSet = new Set(codes);
  for (const d of windowDates) {
    const dNum = Number(d);
    const isToday = dNum === todayNum;
    // 当日命中只统计到「当前评估桶」为止；历史交易日统计完整全天
    if (isToday) priorCounts = new Map(counts);
    let idxT;
    try { idxT = await loadTlinePoints(ICE_SIGNAL_INDEX_CODE, dNum); } catch (e) { idxT = { preclose: null, points: [] }; }
    const idxPts = idxT.points || [];
    const pre = idxT.preclose;
    if (!(pre > 0) || idxPts.length === 0) continue;

    const daySlots = isToday && todayCutoffMinute != null
      ? THREE_MINUTE_SLOTS.filter(m => m <= todayCutoffMinute)
      : THREE_MINUTE_SLOTS;
    if (daySlots.length === 0) continue;
    // 该交易日「上证当日跌幅 ≤ -0.5%」的 3 分钟桶（升序，与回测 idxChangeAt(bucketMinute) 同口径）
    const dropSlots = [];
    for (const m of daySlots) {
      const atPt = priceAtMinute(idxPts, m);
      if (!atPt || !(atPt.lastPx > 0)) continue;
      const chg = ((atPt.lastPx - pre) / pre) * 100;
      if (chg <= REV_INDEX_DROP_PCT) dropSlots.push(m);
    }
    if (dropSlots.length === 0) continue;

    // 该交易日候选池（与今日池代码取交集）
    let dayCodes;
    try {
      const dayPool = await buildReverseLeaderPool(String(dNum), codeSet, {
        bigDropMaxTimes: REV_BIG_DROP_MAX_TIMES,
        postPeakMaxRangePct: REV_POST_PEAK_MAX_RANGE_PCT,
      });
      dayCodes = new Set((dayPool.stocks || []).map(s => s.code));
    } catch (e) { dayCodes = new Set(); }
    if (dayCodes.size === 0) continue;

    // 与回测同口径：强度分的指数分时用个股对应的韧性指数（iceResilienceIndexCode）
    const idxPointsByCode = new Map();
    const idxCodes = Array.from(new Set(codes.map(c => iceResilienceIndexCode(c))));
    await batchParallel(idxCodes, async (ic) => {
      try { idxPointsByCode.set(ic, (await loadTlinePoints(ic, dNum)).points || []); } catch (e) { idxPointsByCode.set(ic, []); }
      return null;
    }, 6);

    await batchParallel(codes, async (code) => {
      const cur = counts.get(code) || 0;
      // 历史日已达上限后无需再算；但「当日」必须继续检测新命中（回测中已达标后再次命中仍可买）
      if (!isToday && cur >= REV_HIT_REQUIRED) return null;
      if (!dayCodes.has(code)) return null;
      const ck = `${code}|${dNum}|3m|resIdx`;
      let hit = null; // 历史日：0/1；当日：命中的桶分钟
      if (!isToday && reversePastHitCache.has(ck)) hit = reversePastHitCache.get(ck);
      if (hit == null) {
        let t;
        try { t = await loadTlinePoints(code, dNum); } catch (e) { t = { preclose: null, points: [] }; }
        const pts = t.points || [];
        if (pts.length > 0 && t.preclose > 0) {
          const codeIdxPts = idxPointsByCode.get(iceResilienceIndexCode(code)) || [];
          for (const m of dropSlots) {
            const s = strengthAtMinute(t, m, code, codeIdxPts);
            if (s && Number.isFinite(s.score) && s.score > REV_STRENGTH_MIN) { hit = isToday ? m : 1; break; }
          }
        }
        if (!isToday) reversePastHitCache.set(ck, hit == null ? 0 : 1);
      }
      if (hit != null && hit !== 0) {
        counts.set(code, Math.min(cur + 1, REV_HIT_REQUIRED));
        if (isToday) todayHitMinutes.set(code, hit);
      }
      return null;
    }, 6);
  }
  return { counts, priorCounts: priorCounts || new Map(counts), todayHitMinutes };
};

const fetchReverseLeaderContext = async (targetDate = null, buyCutoffMinute = BUY_CUTOFF_MINUTE) => {
  const targetDay = resolveTargetDay(targetDate);
  const dateStr = targetDay.format('YYYYMMDD');
  const dateNum = Number(dateStr);
  const isToday = dateStr === dayjs().format('YYYYMMDD');
  const afterClose = !isToday || isAfterMarketClose();

  // 1) 候选池（过去 20 交易日出现过连板 ≥ 2 + 剔除创业板/科创板/题材黑名单 + 10 日滑动窗口区间涨幅 ≥ 60%
  //    + 最近 10 个交易日收盘跌幅 < -9% 的日至多 2 次）
  const pool = await buildReverseLeaderPool(dateStr, null, {
    bigDropMaxTimes: REV_BIG_DROP_MAX_TIMES,
    // 2026-11-14 用户要求：峰值日（含）至买点前区间最大波动 < 30%（与回测同口径）
    postPeakMaxRangePct: REV_POST_PEAK_MAX_RANGE_PCT,
  });
  const poolStocks = pool.stocks || [];
  const codes = poolStocks.map(s => s.code);

  // 2) 上证 3 日线斜率（收盘口径）+ 连续为负天数 / 窗口起点
  let slopeClose = null;
  let daysSinceTurnNeg = null;
  let turnNegDate = null;
  const turnMap = new Map();
  try {
    const recentDates = await getPastTradingDates(dateStr, 60);
    const rangeDates = [...recentDates.map(Number), dateNum];
    const tm = await precomputeTurnMap(ICE_SIGNAL_INDEX_CODE, rangeDates);
    for (const [k, v] of tm) turnMap.set(k, v);
    const tInfo = tm.get(dateNum);
    if (tInfo) {
      slopeClose = tInfo.slopeClose != null ? Number(tInfo.slopeClose) : null;
      daysSinceTurnNeg = tInfo.daysSinceTurnNeg != null ? Number(tInfo.daysSinceTurnNeg) : null;
      turnNegDate = tInfo.turnNegDate != null ? Number(tInfo.turnNegDate) : null;
    }
  } catch (e) { /* 斜率数据不足时择时状态展示为 -- */ }
  const eligible = isReverseEligible(slopeClose, daysSinceTurnNeg);

  // 3) 当日上证指数分时（当日跌幅 + 命中桶）
  let indexTline;
  try { indexTline = await loadTlinePoints(ICE_SIGNAL_INDEX_CODE, dateNum); } catch (e) { indexTline = { preclose: null, points: [] }; }
  const idxPts = indexTline.points || [];
  const idxPre = indexTline.preclose;

  // 4) 各候选当日分时
  const tlineList = codes.length > 0
    ? await batchParallel(codes, async (code) => {
        try { return await loadTlinePoints(code, dateNum); } catch (e) { return { preclose: null, points: [] }; }
      }, 6)
    : [];

  // 4.5) 评估分钟 + 买入截止（2026-10-20 用户新增，与回测引擎同口径）：
  //   盘中按当前时钟向下取整到 3 分钟桶；截止分钟之后不买（截止桶本身仍可买）。
  //   命中登记（computeReverseHitCounts）照常累计，仅不再触发买入
  let revLatestMinute = 0;
  for (const t of tlineList) {
    const pts = (t && t.points) || [];
    if (pts.length > 0) {
      const m = pts[pts.length - 1].minute;
      if (Number.isFinite(m) && m > revLatestMinute) revLatestMinute = m;
    }
  }
  const minute = afterClose
    ? CLOSE_MINUTE
    : (resolveEvalMinute(currentClockMinute()) || resolveEvalMinute(revLatestMinute) || CLOSE_MINUTE);
  const idxAt = (idxPre > 0 && idxPts.length > 0) ? priceAtMinute(idxPts, minute) : null;
  const indexChange = (idxAt && idxAt.lastPx > 0)
    ? round2(((idxAt.lastPx - idxPre) / idxPre) * 100)
    : null;
  const indexDropOk = indexChange != null && indexChange <= REV_INDEX_DROP_PCT;
  const buyWindowOpen = afterClose ? false : (revLatestMinute > 0 ? minute <= buyCutoffMinute : true);

  // 4.6) 严重异动临近测算（2026-11-02 用户要求，与顺周期腿/回测引擎同口径）：
  //   买入前按 T-10 / T-30 收盘价测算累计涨幅剩余空间，任一剩余 ≤ 10% 即视为临近严重异动，买点不触发（命中计数照常展示）
  let abnormalDates = [];
  try { abnormalDates = await getPastTradingDates(dateStr, 30); } catch (e) { abnormalDates = []; }
  const abnormalBases = new Map();
  for (const code of codes) {
    try { abnormalBases.set(code, buildAbnormalWarnBases(code, abnormalDates)); } catch (e) { abnormalBases.set(code, null); }
  }

  // 5) 负斜率窗口内各交易日的强度分命中次数
  //   仅统计「该交易日自身也满足择时前置（斜率 < 0 且已连续为负 ≥ 第 3 天）」的日期——与回测一致
  //   （回测只在当日 eligible 时构建池并登记命中，负斜率窗口前 2 天不计数）
  let reverseHit = { counts: new Map(), priorCounts: new Map(), todayHitMinutes: new Map() };
  if (eligible && codes.length > 0) {
    let windowDates = [];
    try {
      // 与回测同口径：自 turnNegDate 起全窗口累计命中，无 20 日截断（2026-11-05 对齐）
      const pastDates = await getPastTradingDates(dateStr, REVERSE_HIT_LOOKBACK_DAYS);
      windowDates = pastDates.filter(d => Number(d) >= Number(turnNegDate || 0));
    } catch (e) { windowDates = []; }
    windowDates.push(dateNum); // 含当日（盘中实时）
    const eligibleDates = windowDates.filter(dd => {
      const ti = turnMap.get(Number(dd));
      return !!ti && isReverseEligible(ti.slopeClose, ti.daysSinceTurnNeg);
    });
    reverseHit = await computeReverseHitCounts(codes, eligibleDates, dateNum, minute);
  }

  // 与回测同口径：强度分使用个股对应的韧性指数分时（iceResilienceIndexCode），不是上证指数
  const revIdxCodes = Array.from(new Set(poolStocks.map(s => iceResilienceIndexCode(s.code))));
  const revIdxTlineMap = new Map();
  await batchParallel(revIdxCodes, async (ic) => {
    try { revIdxTlineMap.set(ic, await loadTlinePoints(ic, dateNum)); } catch (e) { revIdxTlineMap.set(ic, { preclose: null, points: [] }); }
    return null;
  }, 6);

  const rows = poolStocks.map((s, i) => {
    const code = s.code;
    const t = tlineList[i] || { preclose: null, points: [] };
    const points = t.points || [];
    const preclose = t.preclose;
    const stockMinute = afterClose
      ? CLOSE_MINUTE
      : (points.length > 0 ? minute : CLOSE_MINUTE);

    const revIdxPts = (revIdxTlineMap.get(iceResilienceIndexCode(code)) || {}).points || [];
    const strength = points.length > 0 ? strengthAtMinute(t, stockMinute, code, revIdxPts) : null;
    // 差劲分与「强度 − 差劲」（2026-11-03 用户要求：逆周期列表的强度分列改为强度−差劲）
    let revAvg3Vol = null;
    try { revAvg3Vol = stockPriorAvgVolume(code, dateNum, 3); } catch (e) { revAvg3Vol = null; }
    const revDiff = points.length > 0 ? diffAtMinute(points, preclose, code, stockMinute, revAvg3Vol) : null;
    const revDelta = (revDiff && strength) ? round2(strength.score - revDiff.score) : null;
    const atPt = points.length > 0 ? priceAtMinute(points, stockMinute) : null;
    const px = atPt ? round2(atPt.lastPx) : null;
    const change = (preclose > 0 && px != null) ? round2(((px - preclose) / preclose) * 100) : null;
    const isLimitUp = strength
      ? !!strength.limitUp
      : (change != null && change > limitUpThresholdOf(code));
    const abnormalWarn = evalAbnormalWarn(abnormalBases.get(code), px);

    const hitCount = reverseHit.counts.get(code) || 0;
    const priorHitCount = reverseHit.priorCounts.get(code) || 0;
    const todayHitMinute = reverseHit.todayHitMinutes.get(code) || null;
    // 与回测逆周期腿同口径：必须「当日在该 3 分钟桶新命中」且「历史已命中 ≥ 1 次」，
    //   即第 2 次命中（或已达标后再次命中）的当桶才买；历史已累计 2 次但当日未新命中，不再触发
    const todayHitNow = todayHitMinute != null && todayHitMinute === minute;
    const buyReady = priorHitCount >= 1 && todayHitNow;
    // 2026-10-20 用户新增：买入截止后不买——买入窗口关闭时买点不触发（命中计数照常展示）
    // 2026-11-02 用户新增：临近严重异动不买——命中计数照常展示
    const timingPassed = eligible && indexDropOk && buyReady && !isLimitUp && buyWindowOpen && !abnormalWarn.blocked;
    let timingTag;
    if (!eligible) timingTag = '斜率未就绪';
    else if (afterClose) timingTag = todayHitMinute != null ? `当日命中 ${fmtMinuteText(todayHitMinute)}（历史口径）` : '当日未命中（历史口径）';
    else if (timingPassed) timingTag = '已触发买点';
    else if (buyReady && !buyWindowOpen) timingTag = `已过${cutoffText({ buyCutoffMinute })}不买`;
    else if (buyReady && abnormalWarn.blocked) timingTag = '临近异动不可买';
    else if (buyReady && isLimitUp) timingTag = '涨停不可买';
    else if (buyReady && !indexDropOk) timingTag = '大盘未达跌幅';
    else if (todayHitMinute != null && !todayHitNow) timingTag = `今日已命中 ${fmtMinuteText(todayHitMinute)}（非买点桶）`;
    else if (todayHitNow && priorHitCount === 0) timingTag = '今日首次命中，需历史已命中 1 次';
    else if (priorHitCount >= REV_HIT_REQUIRED) timingTag = `已累计 ${priorHitCount}/${REV_HIT_REQUIRED}，待今日再次命中`;
    else timingTag = `待命中 ${priorHitCount}/${REV_HIT_REQUIRED}`;

    const slopeText = slopeClose == null ? '--' : round2(slopeClose);
    const dayNoText = reverseTimestampText(daysSinceTurnNeg);
    const timingDetail = `上证 3 日线斜率收盘口径 ${slopeText}（连续为负${daysSinceTurnNeg == null ? '--' : dayNoText}${eligible ? '，已满足 ≥ 第 ' + (REV_NEG_STREAK_MIN_DAYS + 1) + ' 天' : ''}）；评估桶 ${fmtMinuteText(minute)}；当日上证跌幅 ${indexChange == null ? '--' : indexChange + '%'}${indexDropOk ? `（≤ ${REV_INDEX_DROP_PCT}%，已满足）` : `（须 ≤ ${REV_INDEX_DROP_PCT}%）`}；窗口内强度分命中 ${hitCount}/${REV_HIT_REQUIRED} 次（历史 ${priorHitCount} 次，今日命中桶 ${fmtMinuteText(todayHitMinute)}）；与回测同口径：仅「今日新命中当桶」可买${buyWindowOpen ? '' : `；已过 ${cutoffText({ buyCutoffMinute })} 买入截止，今日不再买入`}；异动空间：${abnormalWarnText(abnormalWarn)}${abnormalWarn.blocked ? `（剩余 ≤ ${ABNORMAL_WARN_MIN_ROOM_PCT}%，临近严重异动，不买）` : ''}`;

    return {
      code,
      stockName: s.name || code,
      name: s.name || code,
      board: s.board || '',
      lianbanCount: s.lianbanCount || 0,
      preclose: round2(preclose),
      px,
      change,
      strengthScore: strength ? strength.score : null,
      diffScore: revDiff ? revDiff.score : null,
      delta: revDelta,
      strengthDetail: strength,
      isLimitUp,
      hitCount,
      priorHitCount,
      todayHitMinute,
      minute: stockMinute,
      timingPassed,
      timingTag,
      timingDetail,
      abnormalWarn,
    };
  });

  const byHitDesc = (a, b) => (b.hitCount - a.hitCount) || (b.lianbanCount - a.lianbanCount);

  return {
    dateStr,
    dateNum,
    isToday,
    afterClose,
    slopeClose,
    daysSinceTurnNeg,
    turnNegDate,
    eligible,
    minute,
    indexChange,
    indexDropOk,
    buyWindowOpen,
    buyCutoffMinute,
    buyGateMinute: afterClose ? null : (revLatestMinute > 0 ? minute : null),
    pool,
    rows: rows.sort(byHitDesc),
  };
};

// ============================================================
// 逆周期（反向抱团龙头）买点诊断 4 项（独立分组，前端在顺周期 8 项之后单独展示）
//   与回测引擎 reverseLeaderMode 买点口径一致：择时前置（上证 3 日线斜率连续为负第 3 天及以后）
//   + 触发（当日上证跌幅 ≤ -0.5% 且历史已命中 ≥ 1 次后、当日 3 分钟桶新命中、未涨停）+ 买入截止时间门禁
// ============================================================
const buildReverseChecks = (rctx) => {
  const cutoff = cutoffText(rctx);
  const poolCount = (rctx.pool.stocks || []).length;
  const rows = rctx.rows || [];
  const triggered = rows.filter(r => r.timingPassed);
  const best = rows[0] || null;
  const slopeText = rctx.slopeClose == null ? '--' : round2(rctx.slopeClose);
  const dayNoText = reverseTimestampText(rctx.daysSinceTurnNeg);
  const idxChangeText = rctx.indexChange == null ? '--' : `${rctx.indexChange}%`;
  const nameText = best ? `${best.stockName}（${best.code}）· ${best.lianbanCount} 连板` : '--';

  const slopePassed = rctx.eligible === true;
  const triggerPassed = triggered.length > 0;
  const trigRow = triggered[0] || null;
  // 2026-11-02 用户新增：异动空间门禁展示标的——优先已触发买点者，其次未临近异动的最高命中者
  const abnormalRow = trigRow
    || rows.find(r => !(r.abnormalWarn && r.abnormalWarn.blocked))
    || best;
  const abnormalOk = !(abnormalRow && abnormalRow.abnormalWarn && abnormalRow.abnormalWarn.blocked);

  return [
    {
      id: 'reverse_leader_pool',
      group: 'reverse',
      title: `逆周期选股（过去 ${REV_LOOKBACK_DAYS} 个交易日出现 ${REV_MIN_BOARD_COUNT} 连板及以上；剔除创业板/科创板/题材黑名单；近 ${REV_RANGE_WINDOW_DAYS} 日内滑动 ${REV_RANGE_SLIDE_DAYS} 日区间最大涨幅 ≥ ${REV_MIN_WINDOW_RANGE_PCT}%）`,
      passed: poolCount > 0,
      value: `反向抱团池 ${poolCount} 只`,
      reason: `候选 = 过去 ${REV_LOOKBACK_DAYS} 个交易日内出现连板数 ≥ ${REV_MIN_BOARD_COUNT} 的个股，已剔除 ST 等黑名单、创业板（30/301）与科创板（688）及题材黑名单，并叠加动量过滤——过去 ${REV_RANGE_WINDOW_DAYS} 个交易日内任意连续 ${REV_RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 ≥ ${REV_MIN_WINDOW_RANGE_PCT}%${rctx.pool.poolFilterText || ''}；当前反向抱团池共 ${poolCount} 只，展示标的为 ${nameText}`,
    },
    {
      id: 'reverse_leader_timing',
      group: 'reverse',
      title: `逆周期买点前置：上证指数 3 日线斜率连续为负第 ${REV_NEG_STREAK_MIN_DAYS + 1} 天及以后`,
      passed: slopePassed,
      value: `上证 3 日线斜率（收盘口径）${slopeText}；连续为负${dayNoText}`,
      reason: slopePassed
        ? `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线斜率收盘口径 = ${slopeText} < 0，且已连续为负${dayNoText}（≥ 第 ${REV_NEG_STREAK_MIN_DAYS + 1} 天，转负当日为第 1 天），满足逆周期择时前置——大盘走弱进入中段，反向抱团龙头具备做多条件`
        : `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线斜率收盘口径 ${slopeText}（连续为负${dayNoText}），未满足「斜率为负且连续为负 ≥ 第 ${REV_NEG_STREAK_MIN_DAYS + 1} 天」，当前不处于逆周期择时窗口`,
    },
    {
      id: 'reverse_leader_trigger',
      group: 'reverse',
      title: `逆周期买点触发：当日上证跌幅 ≤ ${REV_INDEX_DROP_PCT}% 且当日 3 分钟桶新命中（历史已命中 ≥ 1 次，未涨停）`,
      passed: triggerPassed,
      value: `当日上证跌幅 ${idxChangeText}（${rctx.indexDropOk ? '已满足' : `须 ≤ ${REV_INDEX_DROP_PCT}%`}）；评估桶 ${fmtMinuteText(rctx.minute)}；当日新命中买点 ${triggered.length} 只`,
      reason: triggerPassed
        ? `当日上证跌幅 ${idxChangeText}（≤ ${REV_INDEX_DROP_PCT}%），反向抱团池内 ${trigRow.stockName}（${trigRow.code}）在 ${fmtMinuteText(trigRow.todayHitMinute)} 桶盘中强度分新命中（窗口内累计 ${trigRow.hitCount}/${REV_HIT_REQUIRED} 次，其中历史 ${trigRow.priorHitCount} 次），为第 ${REV_HIT_REQUIRED} 次（或已达标后再次命中）且未涨停，触发逆周期反向抱团买点`
        : !slopePassed
          ? '逆周期择时前置未满足（上证 3 日线斜率未连续为负第 ' + (REV_NEG_STREAK_MIN_DAYS + 1) + ' 天及以后），暂不判定逆周期买点触发'
          : !rctx.indexDropOk
            ? `当日上证跌幅 ${idxChangeText} 未达到 ≤ ${REV_INDEX_DROP_PCT}%，不触发逆周期买点（须等待大盘当日出现 ≥ ${Math.abs(REV_INDEX_DROP_PCT)}% 幅度的下跌）`
            : rctx.buyWindowOpen === false
              ? `当日上证跌幅已满足且当日有新的强度分命中，但已过 ${cutoff} 买入截止（每天 ${cutoff} 之后不买，2026-10-20 用户新增），今日不再买入`
              : `当日上证跌幅已满足，但反向抱团池内暂无个股在当日 ${fmtMinuteText(rctx.minute)} 桶新命中盘中强度分 > ${REV_STRENGTH_MIN}（回测口径：历史已命中 1 次后，当日新命中当桶才买；当前最高累计 ${best ? `${best.stockName} ${best.hitCount}/${REV_HIT_REQUIRED} 次` : '--'}）`,
    },
    {
      id: 'reverse_leader_abnormal_gate',
      group: 'reverse',
      title: `逆周期异动门禁：距「10 个交易日内累计涨幅 100%」或「30 个交易日内累计涨幅 200%」的剩余空间须 > ${ABNORMAL_WARN_MIN_ROOM_PCT}%`,
      passed: abnormalOk,
      value: abnormalRow ? abnormalWarnText(abnormalRow.abnormalWarn) : '--',
      reason: abnormalOk
        ? `2026-11-02 用户新增：逆周期腿买入前同样以当前时点价测算「含买入当日共 10 个交易日累计涨幅 = (时点价 − T-10 收盘价) ÷ T-10 收盘价」与「含买入当日共 30 个交易日累计涨幅 = (时点价 − T-30 收盘价) ÷ T-30 收盘价」，任一距 100% / 200% 的剩余空间 ≤ ${ABNORMAL_WARN_MIN_ROOM_PCT}% 即跳过不买；展示标的两个窗口剩余空间均 > ${ABNORMAL_WARN_MIN_ROOM_PCT}%，门禁通过（与回测引擎同口径）`
        : `2026-11-02 用户新增：展示标的${abnormalRow ? ` ${abnormalRow.stockName}（${abnormalRow.code}） ` : ''}任一异动窗口剩余空间 ≤ ${ABNORMAL_WARN_MIN_ROOM_PCT}%，临近严重异动，逆周期腿跳过不买（命中计数照常展示；与回测引擎同口径）`,
    },
    {
      id: 'reverse_leader_time_gate',
      group: 'reverse',
      title: `逆周期时间门禁：每天 ${cutoff} 后不买`,
      passed: rctx.buyWindowOpen === true,
      value: rctx.buyWindowOpen
        ? `当前口径时间 ${gateTimeText(rctx)}（未过 ${cutoff} 截止，可买）`
        : `${rctx.afterClose ? '已收盘/历史口径' : `当前口径时间 ${gateTimeText(rctx)}`}，已过 ${cutoff} 截止，今日不再买入`,
      reason: rctx.buyWindowOpen
        ? `2026-10-20 用户新增、2026-10-24 改为 ${cutoff} 的门禁规则：每天 ${cutoff} 之后不再买入（${cutoff} 桶本身仍可买；顺周期/逆周期两条腿均适用，与回测引擎同口径）；当前未过 ${cutoff} 截止，买入窗口开放（${cutoff} 后窗口内强度分命中登记照常累计，仅不再实际买入）`
        : `2026-10-20 用户新增、2026-10-24 改为 ${cutoff} 的门禁规则：每天 ${cutoff} 之后不再买入（${cutoff} 桶本身仍可买；顺周期/逆周期两条腿均适用，与回测引擎同口径）；当前已过 ${cutoff} 截止（或为收盘后/历史口径），今日买入窗口已关闭——窗口内强度分命中登记照常累计、仅不再触发买入`,
    },
  ];
};

// ============================================================
// 龙头列表（除「强度分 − 差劲分 ≥ 30」与「上证 3 日线斜率为正」外，其余买点条件全部满足）
// ============================================================
const getHotMoneyLeaderList = async (targetDate = null, limit = 50) => {
  try {
    const ctx = await fetchExtremeWinContext(targetDate);
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
    const stocks = ctx.rows.filter(r => r.listPassed).sort(byDeltaDesc).slice(0, lim);

    // 逆周期（反向抱团）列表：池全部 + 择时状态（失败时不影响顺周期列表）
    let reverse = null;
    try {
      const rctx = await fetchReverseLeaderContext(targetDate);
      reverse = {
        poolCount: (rctx.pool.stocks || []).length,
        poolFilterText: rctx.pool.poolFilterText || '',
        slopeClose: rctx.slopeClose != null ? round2(rctx.slopeClose) : null,
        daysSinceTurnNeg: rctx.daysSinceTurnNeg,
        slopeDayNo: rctx.daysSinceTurnNeg != null ? rctx.daysSinceTurnNeg + 1 : null,
        eligible: rctx.eligible,
        indexChange: rctx.indexChange,
        indexDropOk: rctx.indexDropOk,
        strengthMin: REV_STRENGTH_MIN,
        hitRequired: REV_HIT_REQUIRED,
        indexDropPct: REV_INDEX_DROP_PCT,
        stocks: rctx.rows.slice(0, lim),
      };
    } catch (e) { reverse = null; }

    return {
      success: true,
      data: {
        mode: MODE_EXTREME_WIN,
        date: ctx.dateStr,
        minute: ctx.minute,
        isAfterClose: ctx.afterClose,
        buyWindowOpen: ctx.buyWindowOpen === true,
        indexSlope: ctx.indexSlope,
        poolCount: (ctx.pool.stocks || []).length,
        poolFilterText: ctx.pool.poolFilterText || '',
        stocks,
        reverse,
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
// 买点诊断 8 项（与回测 buildPosition 的 checks 一一对应）
// ============================================================
const buildExtremeWinChecks = (ctx, candidate) => {
  const cutoff = cutoffText(ctx);
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
      title: `选股（两路径并集，满足其一即可；连板准入按流通市值分档：流通市值 > ${LARGE_CAP_FLOAT_MV_YI} 亿元者出现过两连板（连板数 ≥ 2）且含该连板日在内的连续 ${CAP_BOARD_WINDOW_DAYS} 个交易日累计涨幅 > ${CAP_BOARD_MIN_GAIN_PCT}% 即可，流通市值 ≤ ${LARGE_CAP_FLOAT_MV_YI} 亿元者仍需四连板及以上；10 日最大涨幅窗口 = 从第一天涨停的前一交易日收盘价起算、最多 10 个交易日；旧路径=过去 10 个交易日达标 + 该窗口区间最大涨幅 < 80% 且连板后无单日跌幅 < -9%；新路径=过去 20 个交易日达标 + 该窗口区间最大涨幅 > ${NEW_MIN_WINDOW_RANGE_PCT}% 且 < 100% 且该窗口峰值日至买点严格相隔 ≥ 5 个交易日、峰值日（含峰值日本身）至买点前区间最大波动 < 15%、该窗口内收盘跌幅 < -9% 的交易日至多 1 次（≥ 2 次剔除）；均剔除创业板/科创板/题材黑名单/全量自选股科技股）`,
      passed: poolCount > 0,
      value: `龙头池 ${poolCount} 只`,
      reason: `候选 = 旧路径（过去 10 个交易日连板准入达标 + 上述动量过滤）与新路径（过去 20 个交易日连板准入达标 + 上述动量过滤）并集，已剔除 ST 等黑名单、创业板（30/301）与科创板（688）、题材黑名单与全量自选股科技股（isTech ≠ false）重叠者${ctx.pool.poolFilterText || ''}；当前龙头池共 ${poolCount} 只，展示标的为 ${nameText}`,
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
      id: 'extreme_win_abnormal_gate',
      title: `买点门禁：距「10 个交易日内累计涨幅 100%」或「30 个交易日内累计涨幅 200%」的剩余空间须 > ${ABNORMAL_WARN_MIN_ROOM_PCT}%`,
      passed: !(candidate && candidate.abnormalWarn && candidate.abnormalWarn.blocked),
      value: candidate ? abnormalWarnText(candidate.abnormalWarn) : '--',
      reason: candidate && candidate.abnormalWarn && candidate.abnormalWarn.blocked
        ? `2026-11-02 用户新增：以当前时点价测算「含买入当日共 10 个交易日累计涨幅 = (时点价 − T-10 收盘价) ÷ T-10 收盘价」与「含买入当日共 30 个交易日累计涨幅 = (时点价 − T-30 收盘价) ÷ T-30 收盘价」，本股任一距 100% / 200% 的剩余空间 ≤ ${ABNORMAL_WARN_MIN_ROOM_PCT}%，临近严重异动，跳过不买（与回测引擎同口径）`
        : `2026-11-02 用户新增：以当前时点价测算「10 个交易日内累计涨幅距 100%」与「30 个交易日内累计涨幅距 200%」的剩余空间，本股剩余空间均 > ${ABNORMAL_WARN_MIN_ROOM_PCT}%，不构成临近异动，门禁通过（与回测引擎同口径）`,
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
    {
      id: 'extreme_win_time_gate',
      title: `买点时间门禁：每天 ${cutoff} 后不买`,
      passed: ctx.buyWindowOpen === true,
      value: ctx.buyWindowOpen
        ? `当前口径时间 ${gateTimeText(ctx)}（未过 ${cutoff} 截止，可买）`
        : `${ctx.afterClose ? '已收盘/历史口径' : `当前口径时间 ${gateTimeText(ctx)}`}，已过 ${cutoff} 截止，今日不再买入`,
      reason: ctx.buyWindowOpen
        ? `2026-10-20 用户新增、2026-10-24 改为 ${cutoff} 的门禁规则：每天 ${cutoff} 之后不再买入（${cutoff} 桶本身仍可买；顺周期/逆周期两条腿均适用，与回测引擎同口径）；当前未过 ${cutoff} 截止，买入窗口开放`
        : `2026-10-20 用户新增、2026-10-24 改为 ${cutoff} 的门禁规则：每天 ${cutoff} 之后不再买入（${cutoff} 桶本身仍可买；顺周期/逆周期两条腿均适用，与回测引擎同口径）；当前已过 ${cutoff} 截止（或为收盘后/历史口径），今日买入窗口已关闭，不再触发买入信号`,
    },
  ];
  return checks;
};

const getExtremeWinBuyPointChecks = async (targetDate = null, refresh = false, buyCutoffMinute = BUY_CUTOFF_MINUTE) => {
  try {
    const ctx = await fetchExtremeWinContext(targetDate, buyCutoffMinute);
    const rows = ctx.rows || [];
    const notLimitUp = rows.filter(r => r.listPassed && !r.isLimitUp).sort(byDeltaDesc);
    const candidate = notLimitUp[0] || rows.filter(r => r.listPassed)[0] || rows[0] || null;

    const checks = buildExtremeWinChecks(ctx, candidate);
    const allPassed = rows.some(r => r.buyPointHit);
    const passedCount = checks.filter(c => c.passed).length;
    const totalCheckCount = checks.length;

    // 逆周期（反向抱团龙头）一组条件：独立分组，失败时不影响顺周期 7 项
    let reverseChecks = [];
    let reverse = null;
    try {
      const rctx = await fetchReverseLeaderContext(targetDate, buyCutoffMinute);
      reverseChecks = buildReverseChecks(rctx);
      const revPoolCount = (rctx.pool.stocks || []).length;
      reverse = {
        poolCount: revPoolCount,
        poolFilterText: rctx.pool.poolFilterText || '',
        slopeClose: rctx.slopeClose != null ? round2(rctx.slopeClose) : null,
        daysSinceTurnNeg: rctx.daysSinceTurnNeg,
        slopeDayNo: rctx.daysSinceTurnNeg != null ? rctx.daysSinceTurnNeg + 1 : null,
        eligible: rctx.eligible === true,
        indexChange: rctx.indexChange,
        indexDropOk: rctx.indexDropOk === true,
        strengthMin: REV_STRENGTH_MIN,
        hitRequired: REV_HIT_REQUIRED,
        indexDropPct: REV_INDEX_DROP_PCT,
        triggeredCount: (rctx.rows || []).filter(r => r.timingPassed).length,
        triggered: (rctx.rows || []).filter(r => r.timingPassed),
      };
      reverse.allPassed = reverse.triggeredCount > 0;
      reverse.passedCount = reverseChecks.filter(c => c.passed).length;
      reverse.totalCheckCount = reverseChecks.length;
    } catch (e) { reverseChecks = []; reverse = null; }

    const poolCount = (ctx.pool.stocks || []).length;
    const baseConclusion = allPassed
      ? '龙头池出现完整买点标的（强度分 − 差劲分 ≥ 30 且上证 3 日线斜率为正），可关注买入时机。分仓管理是最后一道防火墙。'
      : poolCount === 0
        ? '龙头池当前无满足条件的标的，请耐心等待。'
        : '龙头池暂未出现完整买点标的（需强度分 − 差劲分 ≥ 30 且上证 3 日线斜率为正），请耐心等待。';
    const cutoff = cutoffText(ctx);
    const gateSuffix = ctx.buyWindowOpen ? '' : ` 已过 ${cutoff} 买入截止（每天 ${cutoff} 之后不买），今日买入窗口已关闭。`;
    const conclusionBase = `${baseConclusion}${gateSuffix}`;
    const conclusion = reverse && reverse.triggeredCount > 0
      ? `${conclusionBase} 另：逆周期（反向抱团）择时已触发，反向抱团池出现 ${reverse.triggeredCount} 只买点标的。`
      : conclusionBase;

    return {
      success: true,
      data: {
        mode: MODE_EXTREME_WIN,
        targetDate: ctx.dateStr,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        refreshed: !!refresh,
        buyWindowOpen: ctx.buyWindowOpen === true,
        checks,
        allPassed,
        passedCount,
        totalCheckCount,
        reverseChecks,
        reverse,
        conclusion,
      },
    };
  } catch (e) {
    return { success: false, message: e.message || '买点诊断失败' };
  }
};

// ============================================================
// 卖点诊断 10 条（完整龙头战法 9 条 + ⑪竞价大幅低开后冲高回落即卖）；不调用 buySellDiagnose.checkSellPointDetailed（口径不同）
// ============================================================
const mkCond = (name, satisfied, detail, extra = {}) => ({
  name, satisfied, detail,
  exempted: !!extra.exempted,
  pending: !!extra.pending,
  pendingMinutes: extra.pendingMinutes != null ? extra.pendingMinutes : null,
});

const checkExtremeWinSellPointDetailed = async (code, costPrice = null, buyDate = null, opts = {}) => {
  try {
    const holdDays = 3;
    const weakCondName = `持仓第 ${holdDays} 日未拉开 +10%`;
    const modeName = '龙头战法';
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
    const openChg = mins.length > 0 ? chgOf(mins[0].lastPx) : null;
    // ⑪⑫ 开盘自救启用条件（仅顺周期持仓）：竞价低开 < -2% 且调用方开启该卖点
    const rescueEnabled = !!opts.enableOpenGapReboundSell;
    const gapArmed = rescueEnabled && openChg != null && openChg < OPEN_GAP_REBOUND_PCT;

    if (mins.length === 0) {
      return {
        success: true,
        isSell: false,
        reasons: ['分时数据不足'],
        stockName: code,
        tradeDate: dateNum,
        conditions: [
          mkCond('跌破成本线 -5%（即时/逆周期须连续 5 分钟）', false, '分时数据不足'),
          mkCond('盘中分时跌幅 ≤ -5%', false, '分时数据不足'),
          mkCond('较开盘价下挫 5 个点', false, '分时数据不足'),
          mkCond('单分钟跳水 ≥ 3 个点', false, '分时数据不足'),
          mkCond('持仓股跌停', false, '分时数据不足'),
          mkCond('高位放量大阴线', false, '分时数据不足'),
          mkCond(weakCondName, false, '分时数据不足', { exempted: true }),
          mkCond('竞价低开 < -5%', false, '分时数据不足'),
          ...(opts.enableOpenGapReboundSell ? [
            mkCond('竞价大幅低开后冲高回落超过 2 个百分点即卖', false, '分时数据不足'),
            mkCond('竞价大幅低开后「开盘自救」', false, '分时数据不足'),
          ] : []),
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
    // ⑦盘中跌幅判定口径：开启开盘自救且竞价低开 < -2% 时，自救观察期（≤9:35）内的分钟不判定（交给⑪⑫）
    let minChgJudged = null;
    for (const p of mins) {
      const v = chgOf(p.lastPx);
      if (v != null && (minChg == null || v < minChg)) minChg = v;
      if (!(gapArmed && p.minute <= RESCUE_EVAL_MINUTE) && v != null && (minChgJudged == null || v < minChgJudged)) minChgJudged = v;
      if (openPx > 0) {
        const od = round2(((p.lastPx - openPx) / openPx) * 100);
        if (od != null && (minOpenDrop == null || od < minOpenDrop)) minOpenDrop = od;
      }
    }

    const conditions = [];

    // ① 跌破成本线 -5%
    //   顺周期持仓：即时卖出（回测 scanLeaderPriceSell costLineSustainMinutes: 0 同口径）
    //   逆周期持仓：须连续 ≥5 分钟跌破才卖（opts.costLineSustainMinutes = 5，与回测逆周期腿
    //   scanLeaderPriceSell 默认口径一致：中途回到阈值上方即清零重新计时，2026-11-05 对齐）
    const costSustain = Number.isFinite(Number(opts.costLineSustainMinutes)) && Number(opts.costLineSustainMinutes) > 0
      ? Math.floor(Number(opts.costLineSustainMinutes)) : 0;
    const c1Name = costSustain > 0
      ? `跌破成本线 -5%（连续 ${costSustain} 分钟）`
      : '跌破成本线 -5%（即时）';
    let c1 = false;
    let c1Detail = '成本价缺失，无法判定';
    if (effCostPrice > 0 && lastPx != null) {
      const stopPx = effCostPrice * 0.95;
      const costRet = round2(((lastPx - effCostPrice) / effCostPrice) * 100);
      if (costSustain > 0) {
        let run = 0;
        let maxRun = 0;
        for (const p of mins) {
          if (p.lastPx > 0 && p.lastPx < stopPx) {
            run += 1;
            if (run > maxRun) maxRun = run;
          } else {
            run = 0;
          }
        }
        c1 = maxRun >= costSustain;
        c1Detail = `${c1 ? `已连续 ${maxRun} 分钟（≥ ${costSustain} 分钟）跌破成本线 -5%（成本 ${effCostPrice.toFixed(2)}，止损价 ${stopPx.toFixed(2)}，现价 ${lastPx.toFixed(2)}，较成本 ${costRet}%），卖出` : `未连续 ${costSustain} 分钟跌破成本线 -5%（成本 ${effCostPrice.toFixed(2)}，止损价 ${stopPx.toFixed(2)}，现价 ${lastPx.toFixed(2)}，较成本 ${costRet}%，本日最长连续 ${maxRun} 分钟），继续持有`}`;
      } else {
        c1 = lastPx < stopPx;
        c1Detail = `${c1 ? '已' : '未'}跌破成本线 -5%（成本 ${effCostPrice.toFixed(2)}，止损价 ${stopPx.toFixed(2)}，现价 ${lastPx.toFixed(2)}，较成本 ${costRet}%），${c1 ? '即时卖出' : '继续持有'}`;
      }
    }
    conditions.push(mkCond(c1Name, c1, c1Detail));

    // ② 盘中分时跌幅 ≤ -5%（较昨收）；竞价低开 < -2% 开启自救时，观察期（≤9:35）内不判定
    const c2 = minChgJudged != null && minChgJudged <= -5;
    conditions.push(mkCond('盘中分时跌幅 ≤ -5%', c2,
      `当日最低分时涨跌幅 ${minChgJudged == null ? '--' : minChgJudged}%（较昨收 ${preclose != null ? round2(preclose) : '--'}）${gapArmed ? '；竞价低开 < -2% 开启开盘自救，观察期（≤9:35）内不判定⑦' : ''}${c2 ? ' ≤ -5%，直接卖出' : '，未达 -5%'}`));

    // ③ 较开盘价下挫 5 个点
    const c3 = minOpenDrop != null && minOpenDrop <= -5;
    conditions.push(mkCond('较开盘价下挫 5 个点', c3,
      `当日最低较开盘价跌幅 ${minOpenDrop == null ? '--' : minOpenDrop}%（开盘 ${openPx != null ? round2(openPx) : '--'}）${c3 ? ' ≤ -5%，直接卖出' : '，未达 -5%'}`));

    // ④ 单分钟跳水 ≥ 3 个点（含「上一分钟自身涨幅 > 2% 则豁免」）
    //   逆周期持仓不启用（opts.disableMinutePlummet = true，与回测逆周期腿 disableMinutePlummet 同口径，2026-11-05 对齐）
    let c4 = false;
    let c4Detail = '未出现单分钟跳水';
    if (opts.disableMinutePlummet === true) {
      c4Detail = '逆周期持仓不启用单分钟跳水卖点（与回测逆周期腿口径一致）';
    } else {
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
      } else if (daysSince + 1 !== holdDays) {
        c7Detail = `当前为持仓第 ${daysSince + 1} 日，非第 ${holdDays} 日，不适用`;
      } else {
        const isTail = afterClose || (mins.length > 0 && mins[mins.length - 1].minute >= 1457);
        if (!isTail) {
          c7Exempted = false;
          c7Pending = true;
          c7Detail = `持仓第 ${holdDays} 日，待尾盘 14:57 后判定是否未拉开 +10%（当前现价 ${lastPx != null ? round2(lastPx) : '--'}）`;
        } else {
          c7Exempted = false;
          const ret = effCostPrice > 0 && lastPx != null
            ? round2(((lastPx - effCostPrice) / effCostPrice) * 100)
            : null;
          c7 = ret != null && ret < 10;
          c7Detail = ret == null
            ? `成本价缺失，无法判定持仓第 ${holdDays} 日涨幅`
            : `持仓第 ${holdDays} 日尾盘现价 ${round2(lastPx)}，较成本 ${effCostPrice.toFixed(2)} 涨幅 ${ret}% ${c7 ? '< +10%，未拉开 → 卖出' : '≥ +10%，继续持有'}`;
        }
      }
    }
    conditions.push(mkCond(weakCondName, c7, c7Detail, { exempted: c7Exempted, pending: c7Pending }));

    // ⑧ 竞价低开 < -5%（竞价低开 < -2% 开启自救时，由⑪⑫在观察期内按回落容忍线判定，此处不直接卖）
    const c8 = openChg != null && openChg < -5 && !gapArmed;
    conditions.push(mkCond('竞价低开 < -5%', c8,
      `当日竞价开盘涨跌幅 ${openChg == null ? '--' : openChg}%（昨收 ${preclose != null ? round2(preclose) : '--'}，开盘 ${mins[0].lastPx.toFixed(2)}）${gapArmed ? '，竞价低开 < -2% 已进入开盘自救观察期，本卖点不直接触发' : (c8 ? ' < -5%，直接卖出' : '，未达 -5%')}`));

    // ⑪⑫ 竞价大幅低开（开盘较昨收 < -2%）后的「开盘自救」（2026-10-31 用户改版；仅 opts.enableOpenGapReboundSell 时启用，
    //   调用方按持仓顺逆周期标记决定：逆周期持仓不启用、条件列表也不额外增加该项）
    //   自救观察期 = 开盘 ~ 9:35：回落不低于开盘价且距当日最高涨幅回落 ≤ 2 个百分点时先不卖；
    //   跌破开盘价 / 自最高涨幅回落超过 2 个百分点 → 该分钟卖出；9:35 脱离 ≤ -5% 区域 → 自救成功、当日不再因⑪⑫卖出；
    //   9:35 仍 ≤ -5% → 自救失败、9:35 卖出。
    if (rescueEnabled) {
      let c11 = false;
      let c11Detail = '未出现竞价大幅低开后的冲高回落';
      let c12 = false;
      let c12Detail = '未出现竞价大幅低开后的开盘自救卖点';
      if (!gapArmed) {
        const noArmed = `当日竞价开盘涨跌幅 ${openChg == null ? '--' : openChg}%（未低于 ${OPEN_GAP_REBOUND_PCT}%），本卖点不触发`;
        c11Detail = noArmed;
        c12Detail = noArmed;
      } else {
        const gapText = `竞价大幅低开（开盘 ${openPx.toFixed(2)}，低开 ${openChg}% < ${OPEN_GAP_REBOUND_PCT}%）`;
        let rescuePeakChangePct = null;
        let rescueSuccess = false;
        for (const p of mins) {
          if (p.minute > RESCUE_EVAL_MINUTE) break;
          const changePct = chgOf(p.lastPx);
          if (changePct != null && (rescuePeakChangePct == null || changePct > rescuePeakChangePct)) rescuePeakChangePct = changePct;
          const isEvalMinute = p.minute === RESCUE_EVAL_MINUTE;
          const brokeOpenPx = p.lastPx < openPx;
          const overRetrace = rescuePeakChangePct != null && changePct != null && changePct < rescuePeakChangePct - RESCUE_TOLERANCE_PCT;
          if (isEvalMinute) {
            if (changePct != null && changePct <= -5) {
              c12 = true;
              c12Detail = `${gapText}后开盘自救失败：9:35 仍未脱离 -5% 区域（现价 ${p.lastPx.toFixed(2)}，涨幅 ${changePct}%），按分时价卖出`;
            } else {
              if (brokeOpenPx) {
                c12 = true;
                c12Detail = `${gapText}后开盘自救期间跌破开盘价（开盘 ${openPx.toFixed(2)} → 现价 ${p.lastPx.toFixed(2)}，涨幅 ${changePct != null ? `${changePct}%` : '--'}）即卖出`;
              } else if (overRetrace) {
                c11 = true;
                c11Detail = `${gapText}后冲高回落超过 ${RESCUE_TOLERANCE_PCT} 个百分点（当日最高涨幅 ${rescuePeakChangePct}% → 现价涨幅 ${changePct}%）即卖出`;
              }
              rescueSuccess = true; // 9:35 脱离 -5% 区域 → 自救成功，当日剩余时间不再因⑪⑫卖出
            }
            break;
          }
          if (brokeOpenPx) {
            c12 = true;
            c12Detail = `${gapText}后开盘自救期间跌破开盘价（开盘 ${openPx.toFixed(2)} → 现价 ${p.lastPx.toFixed(2)}，涨幅 ${changePct != null ? `${changePct}%` : '--'}）即卖出`;
            break;
          }
          if (overRetrace) {
            c11 = true;
            c11Detail = `${gapText}后冲高回落超过 ${RESCUE_TOLERANCE_PCT} 个百分点（当日最高涨幅 ${rescuePeakChangePct}% → 现价涨幅 ${changePct}%）即卖出`;
            break;
          }
        }
        if (!c11 && !c12 && !rescueSuccess) {
          c12Detail = `${gapText}，自救观察期内尚未出现跌破开盘价或回落超过 ${RESCUE_TOLERANCE_PCT} 个百分点，等待 9:35 判定是否脱离 -5% 区域`;
        }
      }
      conditions.push(mkCond('竞价大幅低开后冲高回落超过 2 个百分点即卖', c11, c11Detail));
      conditions.push(mkCond('竞价大幅低开后「开盘自救」', c12, c12Detail));
    }

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
      : [`当前未达到${modeName}卖点条件，可以继续持有`];

    return {
      success: true,
      isSell,
      reasons,
      stockName: code,
      tradeDate: dateNum,
      conditions,
      conclusion: isSell
        ? `已触发${modeName}卖点条件，建议卖出 / 减仓。`
        : `当前未达到${modeName}卖点条件，可以继续持有。`,
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
  MODE_ATTACK_DEFENSE,
  ATTACK_DEFENSE_BUY_CUTOFF_MINUTE,
  getHotMoneyLeaderList,
  getExtremeWinBuyPointChecks,
  checkExtremeWinSellPointDetailed,
  clearTodayTlineCache,
};
