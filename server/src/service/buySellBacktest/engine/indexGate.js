const { EMO3_GATE_INDEX_CODES } = require('./emo3Gate');
const { getSingleStockTlineDataByDate, loadIndexKline } = require('../deps');
const { STRATEGIES } = require('../strategies/registry');

let indexMa3SlopeSeriesPromises = new Map(); // indexCode -> Promise<{ dates, closes, slopes }>
const ensureIndexMa3SlopeSeries = async (indexCode) => {
  let p = indexMa3SlopeSeriesPromises.get(indexCode);
  if (p) return p;
  const conf = EMO3_GATE_INDEX_CODES.find(c => c.code === indexCode);
  if (!conf) throw new Error(`未知指数: ${indexCode}`);
  p = (async () => {
    const kline = await loadIndexKline(conf.cacheName, conf.pureCode, conf.market, 100);
    const bars = (kline || [])
      .filter(k => Number.isFinite(Number(k.trade_date)) && Number.isFinite(Number(k.close_px)) && Number(k.close_px) > 0)
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const dates = bars.map(k => Number(k.trade_date));
    const closes = bars.map(k => Number(k.close_px));
    const avgLast = (i, period) => closes.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period;
    const slopes = new Map(); // date -> slope（索引 i>=3 即至少 4 根日K，MA3(今日) 和 MA3(昨日) 各 3 根）
    for (let i = 3; i < closes.length; i++) {
      slopes.set(dates[i], parseFloat((avgLast(i, 3) - avgLast(i - 1, 3)).toFixed(4)));
    }
    return { dates, closes, slopes };
  })().catch((e) => {
    indexMa3SlopeSeriesPromises.delete(indexCode); // 失败允许下次重试
    throw e;
  });
  indexMa3SlopeSeriesPromises.set(indexCode, p);
  return p;
};

// 某交易日某指数 3 日线斜率；目标日缺K线（数据缺日）时回退用 <= 目标日的最近交易日斜率；
// 数据不足/获取失败返回 null
const getIndexMa3Slope = async (indexCode, dateStr) => {
  try {
    const { dates, slopes } = await ensureIndexMa3SlopeSeries(indexCode);
    const target = Number(dateStr);
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= target) {
        const s = slopes.get(dates[i]);
        return s != null ? s : null;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
};

// 创业板指当日分时缓存（进程内按日期缓存，供盘中实时斜率逐桶复用；值 null 表示当日拉取失败）
// 科创板同理，两个缓存互相独立
const indexTlineCache = new Map(); // key=`${indexCode}_${dateStr}` -> [{ minute, lastPx }] | null
const getIndexTlinePoints = async (indexCode, dateStr) => {
  const key = `${indexCode}_${dateStr}`;
  if (indexTlineCache.has(key)) return indexTlineCache.get(key);
  let points = null;
  try {
    const tline = await getSingleStockTlineDataByDate(indexCode, parseInt(dateStr, 10));
    points = (tline?.line || [])
      .filter(p => p && p.minute != null && p.last_px != null)
      .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
      .filter(p => p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
  } catch (e) {
    points = null;
  }
  // 缓存上限：每个指数最多 200 天，两个指数加起来 ≤ 400（和之前单缓存上限一致）
  if (indexTlineCache.size > 400) indexTlineCache.clear();
  indexTlineCache.set(key, points);
  return points;
};

// 兼容旧函数名（固定创业板指）
const cybTlineCache = new Map(); // 保留旧变量名避免被外部误用（实际新逻辑已统一走 indexTlineCache）
const getKeyBlockCybTlinePoints = async (dateStr) => getIndexTlinePoints('sz399006', dateStr);

// 盘中实时指数 3 日线斜率（2026-09-30 用户要求：买入/卖出不等收盘，盘中实时计算）：
//   MA3(今日实时) = (前第2交易日收盘 + 前第1交易日收盘 + 当日实时价) / 3
//   MA3(昨日收盘) = (前第3交易日收盘 + 前第2交易日收盘 + 前第1交易日收盘) / 3
//   slope = MA3(今日实时) − MA3(昨日收盘)  ← MA3 切线方向
// 与收盘口径 ensureIndexMa3SlopeSeries 完全对齐（收盘后实时价=当日收盘价，两者一致）。
// minute 为 HHMM 整数；当日实时价取指数分时中 minute ≤ 目标分钟的最后一点。
// 数据不足（早于目标日的日K不足 3 根）/分时拉取失败/该时点前无分时 → 返回 null
const getIndexMa3SlopeIntraday = async (indexCode, dateStr, minute) => {
  try {
    const { dates, closes } = await ensureIndexMa3SlopeSeries(indexCode);
    const target = Number(dateStr);
    // hi = 严格早于目标日的最近交易日索引（当日收盘价由盘中实时价代替，不使用当日K线）
    let hi = -1;
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] < target) hi = i; else break;
    }
    if (hi < 2) return null; // MA3(昨日) 需要 closes[hi-2..hi]
    const pts = await getIndexTlinePoints(indexCode, dateStr);
    if (!pts || pts.length === 0) return null;
    let atPt = null;
    for (const p of pts) {
      if (p.minute <= Number(minute)) atPt = p; else break;
    }
    if (!atPt) return null;
    const maNow = (closes[hi - 1] + closes[hi] + atPt.lastPx) / 3;
    const maPrev = (closes[hi - 2] + closes[hi - 1] + closes[hi]) / 3;
    return parseFloat((maNow - maPrev).toFixed(4));
  } catch (e) {
    return null;
  }
};

// 兼容旧函数名（固定创业板指）
const getKeyBlockCybMa3SlopeIntraday = async (dateStr, minute) => getIndexMa3SlopeIntraday('sz399006', dateStr, minute);

// 兼容旧函数名（固定创业板指）
const getKeyBlockCybMa3Slope = async (dateStr) => getIndexMa3Slope('sz399006', dateStr);

// 情绪游资系列信号指数：上证指数 sh000001（与重点板块系列的创业板口径不同；
// 顺周期情绪游资＝斜率由负转正买、由正转负卖；逆周期情绪游资（iceReverse）＝方向完全镜像）
const ICE_SIGNAL_INDEX_CODE = 'sh000001';
const ICE_SIGNAL_INDEX_NAME = '上证指数';
const getIceMa3SlopeIntraday = async (dateStr, minute) => getIndexMa3SlopeIntraday(ICE_SIGNAL_INDEX_CODE, dateStr, minute);
const getIceMa3Slope = async (dateStr) => getIndexMa3Slope(ICE_SIGNAL_INDEX_CODE, dateStr);

// 斜率数值格式化（带正负号，2 位小数；null 显示 --）
const fmtKeyBlockSlope = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`);
// 交易日数值（20260804）→ 展示字符串（2026-08-04），后端本地工具（避免引用前端 fmtDate）
const fmtCybGateDate = (d) => {
  const s = String(d == null ? '' : d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
};

// ---------------------------------------------------------------------------
// N 日涨幅最大系列买入环境门禁（2026-10-02 用户新增；盘中实时口径；跨指数双门禁）：
//   创业板指 3 日线斜率（sz399006）跟踪 主板（60/00）+ 创业板（30）自选股
//   科创 50  3 日线斜率（sh000688）跟踪 科创板（68）自选股
// 三条规则（按优先级）：① slope<0 且不在转负两日禁入窗口 → 始终允许；② 由负转正当天+次日允许；
//   ③a 今日盘中由正转负 → 当日禁止；③b 转负后第 1 天（前一交易日转负且今日 slope<0 盘中未转正）→ 次日也禁止
// 买入选股时，根据两个指数各自门禁是否允许，过滤出允许的市场集合，
// 只从允许的集合中选 N 日涨幅最大；两个都允许 → 全池；都禁止 → 跳过买入
// 仅对常规 N 日涨幅最大策略启用，key_block / tail_dip / sentiment 系列有各自独立门禁
// ---------------------------------------------------------------------------
// 指数斜率门禁（双指数：创业板指 sz399006 + 科创 50 sh000688）适用策略集合。
// 排除以下前缀的策略（它们有独立的情绪/板块门禁，不走指数斜率）：
//   key_block_*        重点板块
//   hot_money_ice_*    情绪游资系列（复用重点板块引擎；顺周期＝斜率由负转正买/由正转负卖，
//                      逆周期（_rev_）＝镜像：由正转负次日 9:40 依旧为负买/由负转正当桶卖）
//   tail_dip_*         尾盘抄底（含 emo3 变体 tail_dip_emo3_*）
// 三日情绪冰点策略全部包含在 tail_dip_emo3_* 内，随 tail_dip_* 一起排除。
// 构建方式：从 STRATEGIES 枚举中排除上述前缀，未来新增策略只要不在这 3 组前缀里自动纳入。
const CYB_GATE_EXCLUDE_PREFIX = ['key_block_', 'hot_money_ice_', 'tail_dip_'];
const CYB_GATE_STRATEGY_IDS = new Set(Object.keys(STRATEGIES).filter(id => !CYB_GATE_EXCLUDE_PREFIX.some(p => id.startsWith(p))));

// 指数代码
const CYB_INDEX_CODE = 'sz399006';
const STAR_INDEX_CODE = 'sh000688';
const CYB_INDEX_NAME = '创业板指';
const STAR_INDEX_NAME = '科创50';

// 代码前缀 → 跟踪的指数代码（30 开头属创业板，跟创业板指；68 科创板，跟科创 50；其余 60/00 跟创业板指）
const codeToGateIndex = (code) => {
  const c = String(code).replace(/^SH|^SZ|^BJ/i, '');
  if (/^68/.test(c)) return STAR_INDEX_CODE;
  return CYB_INDEX_CODE;
};
// 反向：指数代码 → 允许的代码前缀数组
const gateIndexToPrefixes = (indexCode) => {
  if (indexCode === STAR_INDEX_CODE) return ['68'];
  return ['60', '00', '30'];
};
// 指数代码 → 中文名
const gateIndexName = (code) => code === STAR_INDEX_CODE ? STAR_INDEX_NAME : CYB_INDEX_NAME;

// 情绪游资系列（防御池）抗分歧跟踪指数映射：与「科技股统一跟踪创业板指」不同——
// 防御性股票（主板 60/00）跟踪上证指数 sh000001（不再跟踪与科技绑定的创业板指）；
// 创业板(30) 跟踪创业板指 sz399006；科创板(68) 跟踪科创 50 sh000688
const ICE_SH_INDEX_CODE = 'sh000001';
const ICE_SH_INDEX_NAME = '上证指数';
const iceResilienceIndexCode = (code) => {
  const c = String(code).replace(/^SH|^SZ|^BJ/i, '');
  if (/^68/.test(c)) return STAR_INDEX_CODE;
  if (/^30/.test(c)) return CYB_INDEX_CODE;
  return ICE_SH_INDEX_CODE;
};
const iceIndexName = (indexCode) => indexCode === STAR_INDEX_CODE
  ? STAR_INDEX_NAME
  : (indexCode === CYB_INDEX_CODE ? CYB_INDEX_NAME : ICE_SH_INDEX_NAME);

// 预计算某个指数 rangeDates 每日收盘口径斜率 + 历史「由负转正 / 由正转负」事件索引（只提供历史初值）
// 返回 Map<dateNum, { slopeClose, turnPosDate|null, daysSinceTurnPos, turnNegDate|null, daysSinceTurnNeg }>
const precomputeTurnMap = async (indexCode, rangeDates) => {
  const { dates, slopes } = await ensureIndexMa3SlopeSeries(indexCode);
  const sorted = [...rangeDates].map(Number);
  const result = new Map();
  const slopeByDate = new Map();
  for (const target of sorted) {
    let found = null;
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= target) { found = slopes.get(dates[i]); break; }
    }
    slopeByDate.set(target, found != null ? Number(found) : null);
  }
  let lastPosDateNum = null, lastNegDateNum = null;
  const firstTarget = sorted[0];
  let lo = -1;
  for (let i = 0; i < dates.length; i++) { if (dates[i] < firstTarget) lo = i; else break; }
  if (lo >= 0) {
    for (let i = lo; i > 0; i--) {
      const cur = slopes.get(dates[i]), prev = slopes.get(dates[i - 1]);
      if (cur != null && prev != null) {
        if (prev <= 0 && cur > 0 && lastPosDateNum == null) lastPosDateNum = dates[i];
        if (prev > 0 && cur <= 0 && lastNegDateNum == null) lastNegDateNum = dates[i];
      }
    }
  }
  for (const target of sorted) {
    const curSlope = slopeByDate.get(target);
    if (curSlope != null) {
      const prevIdx = sorted.indexOf(target) - 1;
      const prevNum = prevIdx >= 0 ? sorted[prevIdx] : null;
      const prevS = prevNum != null ? slopeByDate.get(prevNum) : null;
      if (prevS != null && prevS <= 0 && curSlope > 0) lastPosDateNum = target;
      if (prevS != null && prevS > 0 && curSlope <= 0) lastNegDateNum = target;
    }
    const daysSince = (fromDate, fromIdxName) => {
      if (fromDate == null) return null;
      let a = -1, b = -1;
      for (let i = 0; i < dates.length; i++) {
        if (a === -1 && dates[i] === fromDate) a = i;
        if (b === -1 && dates[i] === target) b = i;
      }
      return a >= 0 && b >= 0 && b >= a ? b - a : null;
    };
    const dPos = daysSince(lastPosDateNum);
    const dNeg = daysSince(lastNegDateNum);
    result.set(target, {
      slopeClose: curSlope,
      turnPosDate: lastPosDateNum, daysSinceTurnPos: dPos,
      turnNegDate: lastNegDateNum, daysSinceTurnNeg: dNeg,
    });
  }
  return result;
};

// 判定**单个指数**在某个时点是否满足新三条规则（盘中实时口径）
//   规则 优先级  条件                                                                   判定
//   ③a 最高    今日盘中由正转负（前收盘正、当前 ≤ 0）                                   T 日禁止
//   ③b   高    slope < 0 且前一交易日是"由正转负日"且今日盘中未转正                     T+1 日禁止
//   ②a  中高   slope ≥ 0 且今日盘中由负转正                                           T 日允许
//   ②b  中     slope ≥ 0 且距最近由负转正 = 1（转负后第 1 天）                          T+1 日允许
//   ①   中     slope < 0 且不在③a③b窗口                                               始终允许
//   禁   低    slope ≥ 0 且不在转正窗口                                               禁止
// 盘中实时口径：今日翻转用 前一交易日收盘斜率 vs 当前桶实时斜率 判定
// 返回 { passed, slope, daysSinceTurnPos, turnPosDate, daysSinceTurnNeg, turnNegDate,
//        prevCloseSlope, turnedPosToday, turnedNegToday, isDayAfterTurnNeg, reason }
const checkIndexGate = async (indexCode, dateStr, minute, precomputed, runtimeState) => {
  const dateNum = Number(dateStr);
  const info = precomputed.get(dateNum);
  const state = {
    slope: null, slopeClose: info?.slopeClose ?? null,
    daysSinceTurnPos: null, turnPosDate: null,
    daysSinceTurnNeg: null, turnNegDate: null,
    prevCloseSlope: null, turnedPosToday: false, turnedNegToday: false,
    isDayAfterTurnNeg: false, // 前一交易日是"由正转负日"（来源：runtimeState.lastNegTurnDate 或 precomputed 的 daysSinceTurnNeg===1）
  };
  const { dates, slopes } = await ensureIndexMa3SlopeSeries(indexCode);
  let prevCloseSlope = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] < dateNum) { const s = slopes.get(dates[i]); if (s != null) prevCloseSlope = Number(s); break; }
  }
  state.prevCloseSlope = prevCloseSlope;

  let slope = await getIndexMa3SlopeIntraday(indexCode, dateStr, minute);
  const usePrevCloseFallback = slope == null || !Number.isFinite(Number(slope));
  if (usePrevCloseFallback) slope = prevCloseSlope ?? null;
  state.slope = slope;
  if (slope == null || !Number.isFinite(Number(slope))) {
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 3 日线斜率数据不足，判定失败` };
  }

  // 今日盘中翻转判定（以前日收盘为基准；分时拉不到时保守不判今日翻转）
  if (prevCloseSlope != null && !usePrevCloseFallback) {
    if (prevCloseSlope > 0 && slope <= 0) state.turnedNegToday = true;
    if (prevCloseSlope <= 0 && slope > 0) state.turnedPosToday = true;
  }

  // 辅助：计算"前一交易日"的 dateNum（用 dates 数组严格早于 dateNum 的最后一个）
  let prevDateNum = null;
  for (let i = dates.length - 1; i >= 0; i--) { if (dates[i] < dateNum) { prevDateNum = dates[i]; break; } }

  // isDayAfterTurnNeg：今日是不是"由正转负后第 1 天"
  //   优先 runtimeState.lastNegTurnDate == prevDateNum（盘中实时口径，覆盖"前一天盘中刚转负"场景）
  //   回退 info.daysSinceTurnNeg === 1（precomputed 收盘口径初值）
  if (runtimeState?.lastNegTurnDate != null && prevDateNum != null && runtimeState.lastNegTurnDate === prevDateNum) {
    state.isDayAfterTurnNeg = true;
    state.turnNegDate = runtimeState.lastNegTurnDate;
    state.daysSinceTurnNeg = 1;
  } else if (info?.daysSinceTurnNeg === 1) {
    state.isDayAfterTurnNeg = true;
    state.turnNegDate = info.turnNegDate;
    state.daysSinceTurnNeg = 1;
  }
  // 兜底：不管有没有 isDayAfterTurnNeg，都从 precomputed 拿 turnPosDate/daysSinceTurnPos 和 turnNegDate/daysSinceTurnNeg 初值
  //       保证持续正/持续负斜率场景也能披露"距上次由正转负/由负转正 第 X 天"
  if (state.turnPosDate == null && info?.turnPosDate != null) state.turnPosDate = info.turnPosDate;
  if (state.daysSinceTurnPos == null && info?.daysSinceTurnPos != null) state.daysSinceTurnPos = info.daysSinceTurnPos;
  if (state.turnNegDate == null && info?.turnNegDate != null) state.turnNegDate = info.turnNegDate;
  if (state.daysSinceTurnNeg == null && info?.daysSinceTurnNeg != null) state.daysSinceTurnNeg = info.daysSinceTurnNeg;

  // 【规则③a】最高优先级：今日盘中由正转负 → T 日禁止（不管 slope 后续如何）
  if (state.turnedNegToday) {
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)}（前收盘 ${fmtKeyBlockSlope(prevCloseSlope)} → 当前 ${fmtKeyBlockSlope(slope)}），今日盘中由正转负，禁止出手` };
  }

  // 【规则③b】次高优先级：由正转负后第 1 天（前一天转负、今天 slope < 0 且盘中没转正）
  //   但如果今天盘中已经又转正了（turnedPosToday=true），则③b不适用——下方②/⑤会放行
  if (state.isDayAfterTurnNeg && !state.turnedPosToday && slope < 0) {
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} < 0，但前一交易日（${fmtCybGateDate(String(prevDateNum))}）由正转负，今日为转负后第 1 天且盘中未转正，禁止出手` };
  }

  // slope ≥ 0 的情况：看"由负转正"窗口（规则②）；slope < 0 且不在③a③b → 规则①允许
  if (slope >= 0) {
    let daysSincePos = null, turnPosDate = null;
    if (state.turnedPosToday) { daysSincePos = 0; turnPosDate = dateNum; }
    else if (runtimeState?.lastPosTurnDate != null) {
      turnPosDate = runtimeState.lastPosTurnDate;
      let posIdx = -1, curIdx = -1;
      for (let i = 0; i < dates.length; i++) {
        if (posIdx === -1 && dates[i] === turnPosDate) posIdx = i;
        if (curIdx === -1 && dates[i] === dateNum) curIdx = i;
      }
      if (posIdx >= 0 && curIdx >= 0 && curIdx >= posIdx) daysSincePos = curIdx - posIdx;
    } else if (info?.daysSinceTurnPos != null) {
      daysSincePos = info.daysSinceTurnPos; turnPosDate = info.turnPosDate;
    }
    state.daysSinceTurnPos = daysSincePos; state.turnPosDate = turnPosDate;
    if (daysSincePos != null && daysSincePos <= 1) {
      const d = daysSincePos;
      const tag = d === 0
        ? (state.turnedPosToday ? '由负转正当日（今日盘中判定）' : `由负转正当日（${fmtCybGateDate(String(turnPosDate))} 转正）`)
        : `由负转正后第 ${d} 个交易日（${fmtCybGateDate(String(turnPosDate))} 转正）`;
      return { passed: true, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} ≥ 0，但${tag}，允许出手` };
    }
    return { passed: false, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} ≥ 0，且距最近一次由负转正${turnPosDate != null ? `（${fmtCybGateDate(String(turnPosDate))}）已 ${daysSincePos} 个交易日（需 ≤ 1）` : '无转正事件'}，禁止出手` };
  }

  // slope < 0 且不在③a③b → 规则① 始终允许
  return { passed: true, ...state, reason: `${gateIndexName(indexCode)} 斜率 ${fmtKeyBlockSlope(slope)} < 0，负斜率允许出手${state.isDayAfterTurnNeg ? '（由正转负后第 1 天，但今日盘中已转正）' : ''}` };
};

// 跨指数双门禁总判定：同时查创业板指和科创 50
// 返回 { allowedMarkets: Set<'mainboard'|'gem'|'star'>, allBlocked, cybGate, starGate }
// 并把今日盘中翻转事件合并回各自的 runtimeState
const checkDualIndexGates = async (dateStr, minute, cybPrecomputed, starPrecomputed, cybRuntime, starRuntime) => {
  const [cybGate, starGate] = await Promise.all([
    checkIndexGate(CYB_INDEX_CODE, dateStr, minute, cybPrecomputed, cybRuntime),
    checkIndexGate(STAR_INDEX_CODE, dateStr, minute, starPrecomputed, starRuntime),
  ]);
  // 盘中翻转事件合并回各自 runtimeState（lastNegTurnDate 用于明日 T+1 日 isDayAfterTurnNeg 判定；
  // lastPosTurnDate 用于转正窗口判定；两者互相冲突——今日转负清空 lastPos、今日转正清空 lastNeg）
  const merge = (runtime, gate) => {
    if (!runtime) return;
    const dayNum = Number(dateStr);
    if (gate.turnedNegToday) { runtime.lastNegTurnDate = dayNum; runtime.lastPosTurnDate = null; }
    if (gate.turnedPosToday) { runtime.lastPosTurnDate = dayNum; runtime.lastNegTurnDate = null; }
  };
  merge(cybRuntime, cybGate);
  merge(starRuntime, starGate);
  const allowedMarkets = new Set();
  if (cybGate.passed === true) { allowedMarkets.add('mainboard'); allowedMarkets.add('gem'); }
  if (starGate.passed === true) allowedMarkets.add('star');
  return { allowedMarkets, allBlocked: allowedMarkets.size === 0, cybGate, starGate };
};

// 无状态实时门禁查询（供前端 /api/index-slope-gate 实时调用）
// 与 checkDualIndexGates 区别：
//   - 不依赖回测循环的 precomputed Map；内部自己从 ensureIndexMa3SlopeSeries 取历史斜率
//   - 不依赖回测 runtimeState；跨桶/跨日翻转事件只靠收盘口径（历史扫一遍）
//   - 单次调用，返回 { trackedIndex, cybGate, starGate, allowedMarkets, gatePassed }
// 注意：因为是无状态，"由正转负后第 1 天"判定只依赖前一交易日的收盘翻转事件（precomputed 初值），
//       盘中 runtimeState 实时修正只有在回测循环里才生效——前端实时买点诊断场景足够了。
const queryLiveIndexGate = async (stockCode, dateStr, minute) => {
  const trackedIndex = codeToGateIndex(stockCode);
  const cybPrecomputed = await precomputeTurnMap(CYB_INDEX_CODE, [Number(dateStr)]);
  const starPrecomputed = await precomputeTurnMap(STAR_INDEX_CODE, [Number(dateStr)]);
  const { allowedMarkets, allBlocked, cybGate, starGate } = await checkDualIndexGates(
    dateStr, minute, cybPrecomputed, starPrecomputed, null, null
  );
  return { trackedIndex, cybGate, starGate, allowedMarkets, allBlocked, gatePassed: !allBlocked };
};

// 跨指数门禁 buyChecks 明细项（两个指数各一条）
const buildIndexGateChecks = (cybGate, starGate) => {
  const buildOne = (indexCode, gate) => {
    const slopeText = fmtKeyBlockSlope(gate.slope);
    const passed = gate.passed === true;
    // 统一格式化：带天数披露（距上次翻转第 X 天 / 翻转当日）
    const daysLabel = (label, days, turnDate) => {
      const d = Number(days);
      if (!Number.isFinite(d)) return '';
      if (d === 0) return `${label}（${fmtCybGateDate(String(turnDate))}）`;
      return `${label} 第 ${d} 天（${fmtCybGateDate(String(turnDate))} 翻转）`;
    };
    let extra = '';
    if (gate.turnedNegToday) {
      extra = `${daysLabel('今日盘中由正转负', 0, gate.turnNegDate || '')}，禁止出手（T 日）`;
    } else if (gate.isDayAfterTurnNeg && !gate.turnedPosToday && gate.slope < 0) {
      extra = `${daysLabel('由正转负', 1, gate.turnNegDate)}，且今日盘中未转正，禁止出手（T+1 日）`;
    } else if (gate.turnedPosToday && gate.isDayAfterTurnNeg) {
      extra = `${daysLabel('由正转负', 1, gate.turnNegDate)}，但今日盘中又由负转正，允许出手`;
    } else if (gate.slope != null && gate.slope < 0) {
      // 规则① 持续负斜率
      extra = `负斜率允许出手${gate.daysSinceTurnNeg != null ? `；距上次${daysLabel('由正转负', gate.daysSinceTurnNeg, gate.turnNegDate)}` : ''}`;
    } else if (gate.turnedPosToday) {
      extra = `今日盘中由负转正，允许出手`; // 规则②a，天数由 runtime 状态自动置 0
    } else if (gate.daysSinceTurnPos != null && gate.daysSinceTurnPos <= 1) {
      // 规则②b
      const d = gate.daysSinceTurnPos;
      extra = `${daysLabel('由负转正', d, gate.turnPosDate)}，允许出手${d === 1 ? '（T+1 日）' : '（T 日）'}`;
    } else if (gate.daysSinceTurnPos != null) {
      extra = `${daysLabel('由负转正', gate.daysSinceTurnPos, gate.turnPosDate)}，但需 ≤ 1 才允许出手`;
    } else {
      extra = '距最近一次由负转正已超过 1 个交易日';
    }
    return {
      id: indexCode === CYB_INDEX_CODE ? 'cyb_ma3_slope_gate' : 'star_ma3_slope_gate',
      title: `${gateIndexName(indexCode)} 3 日线斜率门禁`,
      passed,
      value: gate.slope == null ? `${gateIndexName(indexCode)} 斜率数据不足` : `${gateIndexName(indexCode)} 3 日线斜率 ${slopeText}°，${extra}`,
      reason: gate.reason,
    };
  };
  return [buildOne(CYB_INDEX_CODE, cybGate), buildOne(STAR_INDEX_CODE, starGate)];
};

// 在选股完成之后，用实际买入的股票代码把 buyChecks 里两条指数门禁再补充一次：
//   - 在跟踪指数那一条的 title 前缀 "{stockName} 跟踪{指数名}"
//   - 在 value 里同样加上"{stockName} 跟踪{指数名}，"前缀
//   - 非跟踪指数的那一条保持原样（前端 tooltip 展示时两条都在，用户能对比）
// stockName 可选，优先展示名称；没有则用 code
const annotateIndexGateChecksWithStock = (buyChecks, stockCode, stockName) => {
  if (!Array.isArray(buyChecks) || !stockCode) return buyChecks;
  const trackedIdx = codeToGateIndex(stockCode);
  const trackedId = trackedIdx === STAR_INDEX_CODE ? 'star_ma3_slope_gate' : 'cyb_ma3_slope_gate';
  const displayName = stockName || String(stockCode);
  return buyChecks.map(c => {
    if (c.id !== trackedId) return c; // 非跟踪指数保持原样
    const idxName = gateIndexName(trackedIdx);
    return {
      ...c,
      title: `${displayName} 跟踪${idxName} 3 日线斜率门禁`,
      value: c.value.replace(`${idxName} 3 日线斜率`, `${displayName} 跟踪${idxName}，3 日线斜率`),
    };
  });
};

// 兼容旧函数名（只查创业板指，向后兼容）
const precomputeCybTurnMap = async (rangeDates) => precomputeTurnMap(CYB_INDEX_CODE, rangeDates);
const checkCybSlopeGate = async (dateStr, minute, precomputed, runtimeState) =>
  checkIndexGate(CYB_INDEX_CODE, dateStr, minute, precomputed, runtimeState);

// 跨指数双门禁 + 选股市场过滤的主入口：
//   返回 { gatePassed: bool, gateAllowedMarkets: Set|null, gatedBuyInfo }
//   gatePassed=false → 两个指数都不让进（allBlocked），调用方应跳过本次买入
//   gatePassed=true 且 gateAllowedMarkets 非空 → 调用方需要在 pickBestStock 前根据 gateAllowedMarkets 过滤候选
//   非适用策略 → gateAllowedMarkets=null 表示不做过滤，保留原有全池选股
const withDualGateInfo = async (buyInfo, strategyId, dateStr, minute, opts) => {
  const { cybPrecomputed, starPrecomputed, cybRuntime, starRuntime } = opts;
  if (!buyInfo) return { gatedBuyInfo: buyInfo, gatePassed: true, gateAllowedMarkets: null };
  if (!CYB_GATE_STRATEGY_IDS.has(strategyId)) {
    return { gatedBuyInfo: buyInfo, gatePassed: true, gateAllowedMarkets: null }; // 非适用策略跳过
  }
  if (!cybPrecomputed || !starPrecomputed) {
    return { gatedBuyInfo: buyInfo, gatePassed: false, gateAllowedMarkets: new Set() }; // 预计算缺失 → 保守拦截
  }
  const { allowedMarkets, allBlocked, cybGate, starGate } = await checkDualIndexGates(
    dateStr, minute, cybPrecomputed, starPrecomputed, cybRuntime, starRuntime
  );
  const checks = buildIndexGateChecks(cybGate, starGate);
  const buyChecks = [...(buyInfo.buyChecks || []), ...checks];
  const marketLabel = allBlocked
    ? '两个指数均未通过，禁止买入'
    : `允许市场: ${[...allowedMarkets].map(m => ({ mainboard: '主板', gem: '创业板', star: '科创板' })[m]).join('/')}`;
  const gateTag = `跨指数双门禁（${marketLabel}）`;
  const buyReason = buyInfo.buyReason ? `${buyInfo.buyReason}；${gateTag}` : gateTag;
  return {
    gatedBuyInfo: { ...buyInfo, buyReason, buyChecks },
    gatePassed: !allBlocked,
    gateAllowedMarkets: allowedMarkets,
    // 关键补充：用于下游 pickBestStock 对个股 MA3 切线正斜率连续天数做过滤
    //   两种场景都触发：① 指数今日由负转正当日；② 指数斜率为负（规则① 持续负斜率窗口）
    //   两种场景的过滤规则相同：个股 MA3 切线正斜率连续天数 > 4 则顺延
    gateTurnedPosInfo: {
      cybTurnedPosToday: !!cybGate?.turnedPosToday,
      starTurnedPosToday: !!starGate?.turnedPosToday,
      cybSlopeNegative: cybGate?.slope != null && cybGate.slope < 0,
      starSlopeNegative: starGate?.slope != null && starGate.slope < 0,
    },
  };
};

// 重点板块仓位权重：进攻（斜率为正、市场情绪好）全仓买入；防御（斜率为负、创业板情绪低迷）半仓买入。
// 防御持仓的个股实际收益率（raw）在汇总口径中按半仓折算：returnRate = rawReturnRate × 0.5，
// 整体收益率与平均/最大回撤均按折算后的收益率计算（2026-10-01 用户要求）

module.exports = {
  CYB_GATE_EXCLUDE_PREFIX,
  CYB_GATE_STRATEGY_IDS,
  CYB_INDEX_CODE,
  CYB_INDEX_NAME,
  ICE_SH_INDEX_CODE,
  ICE_SH_INDEX_NAME,
  ICE_SIGNAL_INDEX_CODE,
  ICE_SIGNAL_INDEX_NAME,
  STAR_INDEX_CODE,
  STAR_INDEX_NAME,
  annotateIndexGateChecksWithStock,
  buildIndexGateChecks,
  checkCybSlopeGate,
  checkDualIndexGates,
  checkIndexGate,
  codeToGateIndex,
  cybTlineCache,
  ensureIndexMa3SlopeSeries,
  fmtCybGateDate,
  fmtKeyBlockSlope,
  gateIndexName,
  gateIndexToPrefixes,
  getIceMa3Slope,
  getIceMa3SlopeIntraday,
  getIndexMa3Slope,
  getIndexMa3SlopeIntraday,
  getIndexTlinePoints,
  getKeyBlockCybMa3Slope,
  getKeyBlockCybMa3SlopeIntraday,
  getKeyBlockCybTlinePoints,
  iceIndexName,
  iceResilienceIndexCode,
  indexMa3SlopeSeriesPromises,
  indexTlineCache,
  precomputeCybTurnMap,
  precomputeTurnMap,
  queryLiveIndexGate,
  withDualGateInfo,
};
