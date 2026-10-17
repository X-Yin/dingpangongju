const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  stockPriorAvgVolume,
  stockVolumeRatioAt,
  stockWindowRangePct,
  stockDailyChange,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { iceResilienceIndexCode, getIceMa3SlopeIntraday, fmtKeyBlockSlope } = require('./indexGate');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_CODES } = require('../constants');
const { fmtTime } = require('../diagnose/buyPoint');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
// 差劲分 / 强度分的口径与打分函数（与「个股历史分析」接口共用同一份实现）
const {
  DIFF_A_MAX, DIFF_B_MAX, DIFF_C_MAX, DIFF_D_MAX,
  STRENGTH_A_MAX, STRENGTH_B_MAX, STRENGTH_C_MAX, STRENGTH_D_MAX,
  round2,
  loadTlinePoints, clearTlineCache,
  maxMinuteDrop, closeDropFromHigh, diffDFrom,
  buildDiffDetail, strengthAtMinute,
  diffAtMinute, lastDeathCrossIndex,
} = require('./extremeWinScores');

// ============================================================
// 情绪游资-极致胜率（extremeWinMode: true，2026-10-16 用户新增；2026-10-17 改版；独立引擎）
//   选股 = 过去 10 个交易日（不含当日）内出现过四连板及以上（连板数 >= 4）的个股（2026-10-17 用户要求：一律剔除创业板 30/301 与科创板 688；
//          并叠加「过去 20 个交易日区间最大涨幅 (最高价 − 最低价) ÷ 最低价 < 80%」过滤，剔除近期已大幅拉升者；
//          且四连板之后若出现过任一交易日涨幅 < -6%，一并剔除该股）；
//   差劲分（0~100，越高越差）= 0.3×A + 0.2×B + 0.3×C + 0.2×D，各分项先按上限归一化到 0~100：
//          A 放量比 = (当日量 − 该日前 3 日日均量) ÷ 该日前 3 日日均量（上限 3）
//          B 单分钟最大跳水 = 分时相邻分钟最大跌幅（上限 5%）
//          C 冲高回落 = (分时最高 − 当刻价) ÷ 当刻价 × 100（上限 10%）
//          D 涨停炸板或跌幅（2026-10-17 改）：当日分时触及涨停价 → 炸板次数（上限 5）；
//            当日未涨停 → 改用涨跌幅：涨幅 ≥ 0 → 0 分；涨幅 < 0 → |跌幅| ÷ 10% 归一（-10% 记满 100）；跌停 → 100
//   强度分（0~100，越高越强）= 0.3×A + 0.2×B + 0.3×C + 0.2×D，各分项归一化到 0~100：
//          A 竞价高开 = (当日开盘价 − 昨收) ÷ 昨收 × 100（上限 10%）
//          B 单分钟最大涨幅 = 分时相邻分钟最大涨幅（上限 10%；一字板直接取 10%/20%）
//          C 抗分歧分数 = calculateReplayResilience（原始 0~30，上限 20）
//          D 当日涨幅 = 现价较昨收涨幅（涨幅 < 0 记 0 分；涨幅 >= 0 按 ÷ 10% 归一化）
//            权重（2026-10-17 用户新增加 D 当日涨幅）：A 0.3 / B 0.2 / C 0.3 / D 0.2
//   买点 = 分两层判定（当日盘中逐桶实时）：
//          ① 过去 10 个交易日（不含当日）内须出现过一次「死叉」——最近一次「强度分由高于差劲分转为一度低于差劲分」
//             （相邻交易日 delta = 强度分 − 差劲分 由 > 0 翻为 < 0）；
//             且死叉之后至昨日为止 delta >= 30 的交易日数 <= 1——即该机会只允许「第一次或第二次」达标才买
//             （若死叉之后已出现 >= 2 天 delta >= 30，视为该机会已在历史消耗，今日再触发则不再买入）；
//          ② 今日盘中逐桶实时：今日「强度分 − 差劲分 >= 30」（首次达到）即买入该股；
//          ③ 指数门禁（2026-10-17 用户新增）：仅当上证指数（sh000001）3 日线分时斜率为正
//             （MA3 今日实时 − MA3 昨日收盘 > 0，逐桶实时判定）时才允许买入；斜率为负或数据不足时该桶跳过买入
//             （机会不顺延作废，后续桶斜率转正后仍可继续判定）；
//          多候选取今日「强度分 − 差劲分」差值最大者；买入时点已涨停（主板 > 9.5%、创业/科创 > 19%）不可买、顺延下一只；
//          日线 delta 与今日盘中 delta 均按「个股历史分析」口径：日线取收盘（1500）口径、今日实时按桶口径。
//   卖点 = 完全沿用「情绪游资-龙头战法」的卖点，唯一区别是①成本线止损（2026-10-17 用户要求）：
//          本策略「只要跌破成本线就卖」——成本线口径 0%（现价 < 买入价）即卖、不设持续分钟门槛
//          （龙头战法为 -5% 且连续 ≥5 分钟）；其余卖点不变——跌停 ∪ 高位放量大阴线
//          ∪ 持仓第 3 日尾盘未拉开 +10% ∪ 竞价低开 < -5% ∪ 收盘抗分歧 < 6 ∪ 盘中分时跌幅（较昨收）≤ -5% 直接卖
//          ∪ 开盘后较开盘价直线下挫 ≤ -5% 直接卖
//          ∪ 盘中单分钟跳水（相对上一分钟分时价 ≤ -3%）直接卖；价格类卖点按分钟级回溯取最先触发分钟精准成交）；全仓，收益率不做半仓折算。
// ============================================================

const LOOKBACK_DAYS = 10;          // 选股回溯窗口：过去 10 个交易日
const MIN_BOARD_COUNT = 4;         // 连板门槛：四连板及以上
const DEATH_CROSS_WINDOW = 10;     // 死叉检索窗口：过去 10 个交易日（不含当日）
const DELTA_MIN = 30;              // 买点门槛：今日「强度分 − 差劲分」>= 30
const CLOSE_MINUTE = 1500;         // 日线 delta 序列的收盘口径分钟（与「个股历史分析」一致）

// 差劲分 / 强度分 的分项上限、权重均取自 ./extremeWinScores

// 价格类卖点门槛（止损/跌停/昨收跌幅/开盘跌幅/高位回落/竞价低开）统一由 ./leaderSellMinute 持有
const WEAK_TRADE_HOLD_DAYS = 3;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const TAIL_MINUTE = 1457;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001'; // 抗分歧/涨停口径统一跟踪上证指数（与龙头战法一致）
// 2026-10-17 用户要求：本策略候选池一律剔除创业板（30/301）与科创板（688）
const isChiNextOrStar = (code) => /^(30|688)/.test(String(code).replace(/^(sh|sz|bj)/i, ''));
// 2026-10-17 用户要求：候选池再叠加「区间最大涨幅 < 80%」过滤
// 区间最大涨幅 = (窗口最高价 − 窗口最低价) ÷ 窗口最低价 × 100
// 窗口：2026-10-17 用户要求改为「过去 20 个交易日」（独立于选股的 LOOKBACK_DAYS=10）
const RANGE_WINDOW_DAYS = 20;
const MAX_WINDOW_RANGE_PCT = 80;
// 2026-10-17 用户要求：四连板（连板数 ≥ 4）之后若出现过任一交易日涨幅 < -6%，则从候选池剔除该股
const POST_LIANBAN_DROP_PCT = -6;
const hasPostLianbanBigDrop = (code, lianbanDate, dates) => {
  const from = Number(lianbanDate);
  if (!Number.isFinite(from)) return false;
  for (const d of dates) {
    if (Number(d) > from) {
      const chg = stockDailyChange(code, d);
      // 数据缺失时不判定为「出现过」——仅在确有大跌交易日时才剔除
      if (chg != null && Number.isFinite(chg) && chg < POST_LIANBAN_DROP_PCT) return true;
    }
  }
  return false;
};

// 价格类卖点的分钟级回溯统一走 ./leaderSellMinute.scanLeaderPriceSell

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};

// 个股分时点缓存与加载统一走 ./extremeWinScores（loadTlinePoints / clearTlineCache）

// 判某候选在过去 DEATH_CROSS_WINDOW 个交易日（crossDates 升序，不含当日）是否满足买点前置：
//   构建日线「强度分 − 差劲分」序列（差劲分 / 强度分均按收盘 1500 口径，与「个股历史分析」一致）
//   → 最近一次死叉下标 → 死叉之后 delta >= DELTA_MIN 的交易日计数
//   2026-10-17 用户要求：死叉之后仅允许「第一次或第二次」达标才可买——即死叉之后至昨日
//   已出现 delta >= DELTA_MIN 的交易日 >= 2 天时视为已消耗（今日再触发则不买）
// 返回 { hasCross, consumed, hitCount, crossIdx, deltas, dates }
const computeCrossInfo = async (code, crossDates) => {
  const idxCode = iceResilienceIndexCode(code);
  const deltas = [];
  for (const d of crossDates) {
    const t = await loadTlinePoints(code, d);
    if (!t || t.points.length === 0 || !(t.preclose > 0)) { deltas.push(null); continue; }
    // 差劲分（收盘 1500 口径）：A 放量比 + B 单分钟最大跳水 + C 冲高回落 + D 涨停炸板/跌幅
    const lastPx = t.points[t.points.length - 1].lastPx;
    const dayChange = ((lastPx - t.preclose) / t.preclose) * 100;
    const dItem = diffDFrom(t.points, t.preclose, code, dayChange);
    const diff = buildDiffDetail(
      stockVolumeRatioAt(code, d),
      maxMinuteDrop(t.points),
      closeDropFromHigh(t.points),
      dItem,
    );
    const idxT = await loadTlinePoints(idxCode, d);
    const s = strengthAtMinute(t, CLOSE_MINUTE, code, idxT.points);
    const strength = s ? s.score : null;
    deltas.push(strength != null ? round2(strength - diff.score) : null);
  }
  const crossIdx = lastDeathCrossIndex(deltas);
  // 死叉之后至昨日「delta >= DELTA_MIN」的交易日数（2026-10-17：允许前两次，>= 2 天即视为已消耗）
  let hitCount = 0;
  if (crossIdx >= 0) {
    for (let j = crossIdx + 1; j < deltas.length; j++) {
      if (deltas[j] != null && deltas[j] >= DELTA_MIN) hitCount++;
    }
  }
  const consumed = hitCount >= 2;
  return { hasCross: crossIdx >= 0, consumed, hitCount, crossIdx, deltas, dates: crossDates };
};

const runExtremeWinBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.extremeWinMode !== true) {
    return { success: false, message: `未知情绪游资-极致胜率策略: ${strategyId}` };
  }

  // 不依赖资金快照：日期序列并入 tech_index 覆盖的交易日（与龙头战法引擎同口径）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // 启动预拉取：扫描整个回测区间每个交易日可能出现的候选股，一次性拉取日K（供放量比 / 死叉日线序列使用）
  try {
    const presetAll = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      for (const s of stocks) presetAll.add(s.code);
    }
    if (presetAll.size > 0) await ensureBarsForCodes(presetAll);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  let position = null;      // 单股持仓（全仓）
  let lastSellDate = null;  // 卖出当日不再追买

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
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
    const hasTailBucket = timeBuckets.some(b => Number(b.minute) >= TAIL_MINUTE);
    const todayIdx = di;

    // 候选池基本面（连板股名单，读快照，较廉价）
    let candidatesRaw = [];
    let poolFilterText = '';
    try {
      const info = await getRecentMultiLianbanStocks(dateStr, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      const base = (info.stocks || []).filter(s => !EXCLUDED_CODES.has(s.code) && !isChiNextOrStar(s.code));
      // 2026-10-17 用户要求：过去 RANGE_WINDOW_DAYS 个交易日（不含当日）区间最大涨幅须 < 80%（剔除近期已大幅拉升者）
      if (base.length > 0) {
        let winDates = [];
        try { winDates = await getPastTradingDates(dateStr, RANGE_WINDOW_DAYS); } catch (e) { winDates = []; }
        try { await ensureBarsForCodes(new Set(base.map(s => s.code))); } catch (e) { /* 拉取失败按数据缺失处理 */ }
        if (winDates.length >= RANGE_WINDOW_DAYS) {
          const before = base.length;
          candidatesRaw = base.filter(s => {
            const rp = stockWindowRangePct(s.code, winDates);
            // 区间振幅缺失（日K未覆盖）视为不达标，与精准择时同口径
            return rp != null && Number.isFinite(rp) && rp < MAX_WINDOW_RANGE_PCT;
          });
          const beforeDrop = candidatesRaw.length;
          // 2026-10-17 用户要求：四连板之后出现过任一交易日涨幅 < -6% 的个股一并剔除
          candidatesRaw = candidatesRaw.filter(s => !hasPostLianbanBigDrop(s.code, s.date, winDates));
          poolFilterText = `；过去 ${RANGE_WINDOW_DAYS} 个交易日区间最大涨幅 (最高价 − 最低价) ÷ 最低价 < ${MAX_WINDOW_RANGE_PCT}% 剔除 ${before - beforeDrop} 只；四连板后出现单日涨幅 < ${POST_LIANBAN_DROP_PCT}% 再剔除 ${beforeDrop - candidatesRaw.length} 只`;
        } else {
          poolFilterText = `；过去 ${RANGE_WINDOW_DAYS} 个交易日日K数据不足，本日无候选`;
        }
      }
    } catch (e) { candidatesRaw = []; }
    if (candidatesRaw.length > 0) {
      for (const s of candidatesRaw) {
        s.poolFilterText = poolFilterText;
        if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
      }
    }

    // 每日分时缓存重建，控制内存
    clearTlineCache();

    // 隔夜持仓当日分时（卖点用）
    let posTline = null;
    if (position && dateStr > position.buyDate) {
      posTline = await loadTlinePoints(position.code, dateNum);
    }
    // 持仓股当日收盘抗分歧指数（卖点⑥用；懒计算）
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
          .filter(p => p && p.minute != null && p.last_px != null)
          .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
          .filter(p => p.lastPx > 0);
        const indexLine = (indexT?.line || [])
          .filter(p => p && p.minute != null && p.last_px != null)
          .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
          .filter(p => p.lastPx > 0);
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const s = calculateReplayResilience(stockLine, indexLine, position.code);
          if (s != null && Number.isFinite(Number(s))) posResilience = round2(s);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResilience;
    };

    // 候选池数据（懒加载：仅当空仓需要评估买入时构建）：死叉前置 + 今日分时 + 今日前 3 日均量 + 指数分时
    let poolReady = false;
    let candidates = [];
    const todayTline = new Map();   // code -> { preclose, points }
    const todayAvg3Vol = new Map(); // code -> 今日前 3 个交易日日均量
    const idxPointsMap = new Map(); // idxCode -> points

    const ensurePoolData = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidatesRaw.length === 0) return;
      // 确保候选股日K已在缓存（放量比 A 依赖）
      try {
        await ensureBarsForCodes(new Set(candidatesRaw.map(s => s.code)));
      } catch (e) { /* 单只失败后续按 null 处理 */ }
      // 过去 DEATH_CROSS_WINDOW 个交易日（不含当日）升序日期
      let crossDates = [];
      try { crossDates = (await getPastTradingDates(dateStr, DEATH_CROSS_WINDOW)).map(Number); } catch (e) { crossDates = []; }
      if (crossDates.length < 2) { candidates = []; return; }
      // 逐候选判定死叉前置：过去窗口内须出现过死叉，且死叉之后至昨日从未有某日 delta >= DELTA_MIN
      const crossMap = new Map();
      await batchParallel(candidatesRaw, async (c) => {
        try { crossMap.set(c.code, await computeCrossInfo(c.code, crossDates)); } catch (e) { crossMap.set(c.code, null); }
      }, 8);
      candidates = candidatesRaw
        .map(c => ({ ...c, crossInfo: crossMap.get(c.code) }))
        .filter(c => c.crossInfo && c.crossInfo.hasCross && !c.crossInfo.consumed);
      if (candidates.length === 0) return;
      // 今日分时 + 今日前 3 个交易日日均量（逐候选）
      await batchParallel(candidates, async (c) => {
        try { todayTline.set(c.code, await loadTlinePoints(c.code, dateNum)); } catch (e) { todayTline.set(c.code, { preclose: null, points: [] }); }
        try { todayAvg3Vol.set(c.code, stockPriorAvgVolume(c.code, dateNum, 3)); } catch (e) { todayAvg3Vol.set(c.code, null); }
      }, 8);
      // 指数分时（主板 sh000001 / 创业板 sz399006 / 科创50 sh000688）
      await Promise.all(['sh000001', 'sz399006', 'sh000688'].map(async (ic) => {
        try {
          const r = await loadTlinePoints(ic, dateNum);
          idxPointsMap.set(ic, r.points || []);
        } catch (e) { idxPointsMap.set(ic, []); }
      }));
    };

    // 评估某桶的候选：返回按今日「强度分 − 差劲分」降序排列的达标（>= DELTA_MIN）候选数组
    const evalBucket = (bucketMinute) => {
      const out = [];
      for (const c of candidates) {
        const t = todayTline.get(c.code);
        if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
        // 今日实时差劲分（A 用分时累计成交量对前 3 日日均量的放量比）
        const d = diffAtMinute(t.points, t.preclose, c.code, bucketMinute, todayAvg3Vol.get(c.code));
        if (!d) continue;
        // 今日实时强度分（截至当前桶）
        const s = strengthAtMinute(t, bucketMinute, c.code, idxPointsMap.get(iceResilienceIndexCode(c.code)) || []);
        if (!s) continue;
        const delta = round2(s.score - d.score);
        if (delta == null || delta < DELTA_MIN) continue;
        out.push({ ...c, delta, strength: s.score, diffScore: d.score, s, d, px: s.px, changePct: s.changePct, limitUp: s.limitUp });
      }
      out.sort((a, b) => b.delta - a.delta);
      return out;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);

      // ===== 卖出（隔夜持仓；沿用龙头战法 10 条卖点，价格类卖点分钟级回溯）=====
      if (position && dateStr > position.buyDate && posTline && posTline.points.length > 0) {
        const atPt = priceAtMinute(posTline.points, bucketMinute);
        if (atPt && atPt.lastPx > 0) {
          const px = atPt.lastPx;
          const preclose = posTline.preclose;
          const changePct = preclose && preclose > 0
            ? round2(((px - preclose) / preclose) * 100)
            : (atPt.change != null ? atPt.change : null);
          const costReturn = position.buyPrice > 0
            ? round2(((px - position.buyPrice) / position.buyPrice) * 100)
            : null;

          let sellReason = null;
          let sellMinute = atPt.minute; // 默认按当前桶时点成交（④⑥属尾盘时点卖点）
          let sellPx = px;
          let sellChange = changePct;

          // 价格类卖点（⑤竞价低开 / ①成本线止损 / ②跌停 / ⑦昨收跌幅 / ⑧开盘跌幅 / ⑩单分钟跳水 / ③高位大阴线）：
          // 分钟级回溯——自 9:30 起逐分钟扫描分时，取「最先触发」的那一分钟精准卖出
          const priceHit = scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
            // 2026-10-17 用户要求：本策略「只要跌破成本线就卖」——成本线口径 0%（现价 < 买入价）且不设持续分钟
            costLinePct: 0,
            costLineSustainMinutes: 0,
          });
          if (priceHit) {
            sellReason = priceHit.reason;
            sellMinute = priceHit.minute;
            sellPx = priceHit.px;
            sellChange = priceHit.changePct;
          }
          // ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10%
          if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
            if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
              sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
            }
          }
          // ⑥ 收盘抗分歧指数 < 6
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
              weight: 1,
              buyDate: position.buyDate,
              buyDateDisplay: position.buyDateDisplay,
              buyTime: position.buyTime,
              buyPrice: position.buyPrice,
              buyChange: position.buyChange,
              buyReason: position.buyReason,
              buyChecks: position.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: fmtMinute(sellMinute),
              sellPrice: round2(sellPx),
              sellChange,
              sellReason: `${sellReason}，情绪游资-极致胜率持仓卖出（全仓）`,
              returnRate: rawReturnRate,
              rawReturnRate,
            });
            position = null;
            lastSellDate = dateStr; // 卖出当日不再追买
          }
        }
      }

      // ===== 买入（空仓、当日未卖出过、逐桶实时判定）=====
      if (!position && dateStr !== lastSellDate) {
        // 指数门禁（2026-10-17 用户新增）：仅当上证指数 3 日线分时斜率为正时才允许买入，否则跳过本桶
        const idxMa3Slope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
        if (!(Number(idxMa3Slope) > 0)) continue;
        await ensurePoolData();
        if (candidates.length > 0) {
          const ranked = evalBucket(bucketMinute);
          const pick = ranked.find(r => !r.limitUp); // 买入时点已涨停不可买 → 顺延至差值排名下一只
          if (pick) {
            position = buildPosition({ pick, ranked, dateStr, dateDisplay, timeText, idxMa3Slope });
            position.buyDi = todayIdx;
            for (const c of candidates) if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name || c.code });
          }
        }
      }
    }
  }

  // 组装结果（type:'single'：全仓单持仓，整体收益率 = 逐笔复利；期末持仓按最近收盘价估算浮盈并入复利）
  let acc = 1;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (position) {
    holding = { ...position, weight: 1 };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
    if (closePx != null && closePx > 0 && position.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - position.buyPrice) / position.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn;
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) acc *= 1 + holding.buyReturn / 100;
  }
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

// 构建持仓对象（含买入原因与死叉 / 差劲分 / 强度分诊断明细）
const buildPosition = ({ pick, ranked, dateStr, dateDisplay, timeText, idxMa3Slope }) => {
  const s = pick.s;
  const d = pick.d;
  const diff = pick.diffScore;
  const strength = pick.strength;
  const delta = pick.delta;
  const cross = pick.crossInfo;
  const limitUpText = (v) => (v > 0 ? `+${v}%` : `${v}%`);
  const crossDate = cross && cross.crossIdx >= 0 ? cross.dates[cross.crossIdx] : '';
  const deltasText = cross ? cross.deltas.map(v => (v == null ? '--' : v)).join(' → ') : '--';
  const hitCount = cross && cross.hitCount != null ? cross.hitCount : 0;
  const buyReason = `${timeText} 过去 ${DEATH_CROSS_WINDOW} 个交易日内出现死叉（${crossDate}）后，今日满足「强度分 − 差劲分 = ${delta} ≥ ${DELTA_MIN}」（死叉后第 ${hitCount + 1} 次达标，本策略只允许前 2 次），买入候选 ${pick.name}（${pick.code}，${pick.lianbanCount} 连板），触发时点价 ${pick.px.toFixed(2)}`;
  const checks = [
    {
      id: 'extreme_win_pool',
      title: `选股（过去 ${LOOKBACK_DAYS} 个交易日四连板及以上；剔除创业板/科创板；过去 ${RANGE_WINDOW_DAYS} 个交易日区间最大涨幅 < ${MAX_WINDOW_RANGE_PCT}%；四连板后无单日涨幅 < ${POST_LIANBAN_DROP_PCT}%）`,
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板`,
      reason: `候选 = 过去 ${LOOKBACK_DAYS} 个交易日内出现连板数 ≥ ${MIN_BOARD_COUNT} 的个股（命中日 ${pick.date}，板块 ${pick.board || '--'}）；已剔除 ST 等黑名单、创业板（30/301）与科创板（688）${pick.poolFilterText || ''}；本桶达标候选共 ${ranked.length} 只，按今日「强度分 − 差劲分」降序取第一名（已排除买入时点涨停者）`,
    },
    {
      id: 'extreme_win_cross',
      title: `买点前置：过去 ${DEATH_CROSS_WINDOW} 个交易日死叉且死叉后达标次数 ≤ 1`,
      passed: true,
      value: `死叉日 ${crossDate}（死叉后达标 ${hitCount} 次，本次为第 ${hitCount + 1} 次；日线「强度 − 差劲」序列 ${deltasText}）`,
      reason: `过去 ${DEATH_CROSS_WINDOW} 个交易日内出现过「强度分由高于差劲分转为一度低于差劲分」的死叉；死叉之后至昨日 delta ≥ ${DELTA_MIN} 的交易日数为 ${hitCount}（2026-10-17 用户要求：只允许「第一次或第二次」达标才买，${hitCount} ≤ 1 天视为未被历史消耗）`,
    },
    {
      id: 'extreme_win_diff',
      title: `今日差劲分 ${diff}（越高越差）`,
      passed: true,
      value: `${d.limitDown ? '当日跌停 → 差劲分封顶 100；' : ''}A 放量 ${d.aRaw == null ? '--' : d.aRaw}（分 ${d.aScore}）· B 跳水 ${d.bRaw}%（分 ${d.bScore}）· C 冲高回落 ${d.cRaw}%（分 ${d.cScore}）· D ${d.dRaw < 0 ? `跌幅 ${d.dRaw}%` : `炸板 ${d.dRaw} 次`}（分 ${d.dScore}）`,
      reason: d.limitDown
        ? `当日跌停 → 整个差劲分直接封顶 100（2026-10-17 用户要求；A/B/C/D 分项仅供展示：0.3×${d.aScore} + 0.2×${d.bScore} + 0.3×${d.cScore} + 0.2×${d.dScore}）`
        : `差劲分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${d.aScore} + 0.2×${d.bScore} + 0.3×${d.cScore} + 0.2×${d.dScore} = ${diff}（A 为分时累计成交量对该股前 3 个交易日日均量的放量比，上限 ${DIFF_A_MAX}；B 上限 ${DIFF_B_MAX}%、C 上限 ${DIFF_C_MAX}%；D：当日跌停时整个差劲分记 100；当日触及涨停价时取炸板次数（上限 ${DIFF_D_MAX}），未涨停时改用跌幅——涨幅 ≥ 0 记 0 分、跌幅按 10% 归一（-10% 记满 100）；均按盘中截至当前桶口径）`,
    },
    {
      id: 'extreme_win_strength',
      title: `今日强度分 ${strength}（越高越强）`,
      passed: true,
      value: `A 竞价高开 ${s.aRaw}%（分 ${s.aScore}）· B 分钟最大涨幅 ${s.bRaw}%（分 ${s.bScore}）${s.isOneWord ? '（一字板）' : ''} · C 抗分歧 ${s.cRaw}（分 ${s.cScore}）· D 当日涨幅 ${s.dRaw}%（分 ${s.dScore}）`,
      reason: `强度分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${s.aScore} + 0.2×${s.bScore} + 0.3×${s.cScore} + 0.2×${s.dScore} = ${strength}（A 上限 ${STRENGTH_A_MAX}%、B 上限 ${STRENGTH_B_MAX}%、C 上限 ${STRENGTH_C_MAX}%、D 上限 ${STRENGTH_D_MAX}%）；时点价 ${pick.px.toFixed(2)}（昨收 ${s.preclose}，现价涨幅 ${limitUpText(s.changePct)}）`,
    },
    {
      id: 'extreme_win_threshold',
      title: `买点判定：今日「强度分 − 差劲分 ≥ ${DELTA_MIN}」`,
      passed: true,
      value: `${strength} − ${diff} = ${delta} ≥ ${DELTA_MIN}`,
      reason: `今日强度分 ${strength} 高于今日差劲分 ${diff} 达 ${delta}，达到 ${DELTA_MIN} 门槛，满足死叉后金叉「分歧转一致」低吸反转买入条件`,
    },
    {
      id: 'extreme_win_index_slope',
      title: '买点门禁：上证指数 3 日线分时斜率为正',
      passed: true,
      value: `上证指数 3 日线斜率 ${fmtKeyBlockSlope(idxMa3Slope)}（> 0）`,
      reason: `买入时点计算上证指数（sh000001）3 日线分时斜率 = MA3(今日实时) − MA3(昨日收盘) = ${idxMa3Slope}，为正（> 0），大盘短期趋势向上，允许买入；若斜率 ≤ 0 或数据不足则该桶跳过买入`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name,
    mode: 'offense',
    board: pick.board,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: timeText,
    buyPrice: round2(pick.px),
    buyChange: round2(s.changePct),
    metric: delta,
    weight: 1,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runExtremeWinBacktest };
