const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getMonitorStocks,
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
//          并叠加「过去 20 个交易日内任意连续 10 个交易日区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < 80%」过滤，剔除近期已大幅拉升者；
//          且整段「过去 20 个交易日总涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < 100%」（2026-10-17 用户新增）；
//          且四连板之后若出现过任一交易日涨幅 < -9%，一并剔除该股；
//          并整体剔除 PCB / 玻璃基板 / 光模块 / 液冷 / 通信 / 算力 / 芯片 / 靶材 / 电子气体 / 光刻胶 / 算力租赁 题材（板块名包含关键词即剔除，2026-10-17 用户新增）；
//          并剔除与「全量自选股中的科技股」（monitor_stocks.json，isTech !== false）重叠的个股——2026-10-17 用户新增）；
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
//             且若上个交易日 delta > 30（昨日已达 30），则该日成交量须 ≥ 其前 3 个交易日成交量均值（须放量，2026-10-17 用户新增——
//             避免「强更强」但缩量的高位被套；数据缺失时不判定）；
//          ② 今日盘中逐桶实时：今日「强度分 − 差劲分 >= 30」（首次达到）即买入该股；
//          ③ 指数门禁（2026-10-17 用户新增）：仅当上证指数（sh000001）3 日线分时斜率为正
//             （MA3 今日实时 − MA3 昨日收盘 > 0，逐桶实时判定）时才允许买入；斜率为负或数据不足时该桶跳过买入
//             （机会不顺延作废，后续桶斜率转正后仍可继续判定）；
//          ④ 竞价低开门禁（2026-10-17 用户新增）：若「上个交易日强度分 > 60」，则当日买入时「竞价低开不得超过 -3%」
//             （开盘价较昨收涨幅须 >= -3%），否则该候选取值不可买、顺延至差值排名下一只；上个交易日强度分数据缺失时不判定；
//          多候选取今日「强度分 − 差劲分」差值最大者；买入时点已涨停（主板 > 9.5%、创业/科创 > 19%）不可买、顺延下一只；
//          日线 delta 与今日盘中 delta 均按「个股历史分析」口径：日线取收盘（1500）口径、今日实时按桶口径。
//   卖点 = 完全沿用「情绪游资-龙头战法」的卖点，唯一区别是①成本线止损（2026-10-17 用户要求）：
//          本策略成本线止损口径 -5%（现价 < 买入价 × 0.95）即卖、不设持续分钟门槛
//          （龙头战法同为 -5% 但要求连续维持 ≥5 分钟）；其余卖点不变——跌停 ∪ 高位放量大阴线
//          ∪ 持仓第 3 日尾盘未拉开 +10% ∪ 竞价低开 < -5% ∪ 收盘抗分歧 < 6 ∪ 盘中分时跌幅（较昨收）≤ -5% 直接卖
//          ∪ 开盘后较开盘价直线下挫 ≤ -5% 直接卖
//          ∪ 盘中单分钟跳水（相对上一分钟分时价 ≤ -3%）直接卖；价格类卖点按分钟级回溯取最先触发分钟精准成交）。
//   仓位（2026-10-17 用户要求）：账户拆两份、每份各半仓，两份各自独立买卖、独立计成本与收益（均按半仓 ×0.5 折算）；
//          每次触发买点只买入一份（一个交易日最多建仓一份），另一份留待下次触发（可在不同日期建仓）；
//          两份不得同时持有同一只股票（建仓时剔除另一份当前持仓标的）；整体收益 = 两份子账户各自复利后按 0.5 加权相加。
// ============================================================

// 2026-10-17 用户要求：账户拆两份、每份各半仓，两份独立买卖（互不重叠同一标的）
const LEG_COUNT = 2;               // 仓位份数
const LEG_WEIGHT = 0.5;            // 每份占账户资金比例（半仓）
const LEG_LABELS = ['A', 'B'];     // 份别标记

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
// 2026-10-17 用户要求：候选池整体剔除以下题材（板块名包含关键词即剔除，以覆盖派生板块名——
//   如「PCB 上游/概念/并购」「通信(PCB)」「光模块上游/高速光模块发布」「液冷散热/服务器/算力(液冷)」「芯片(玻璃基板)」等）
//   2026-10-17 追加：靶材、电子气体、光刻胶、算力租赁
const EXCLUDED_THEMES = ['PCB', '玻璃基板', '光模块', '液冷', '通信', '算力', '芯片', '靶材', '电子气体', '光刻胶', '算力租赁'];
const isExcludedTheme = (board) => {
  const b = String(board || '').toUpperCase();
  if (!b) return false;
  return EXCLUDED_THEMES.some((t) => b.includes(t.toUpperCase()));
};
// 2026-10-17 用户要求：候选池再叠加「区间最大涨幅 < 80%」过滤
// 区间最大涨幅 = 子窗口 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 × 100
// 窗口：在外层「过去 20 个交易日（不含当日，即不含买点触发日）」内滑动「连续 10 个交易日」子窗口，取各子窗口涨幅的最大值
const RANGE_WINDOW_DAYS = 20;
// 2026-10-17 用户要求：改以「连续 10 个交易日」滑动窗口计算（而非整个 20 日区间）
const RANGE_SLIDE_DAYS = 10;
// 2026-10-17 用户要求：任意连续 10 个交易日的区间最大涨幅须 < 80%
const MAX_WINDOW_RANGE_PCT = 80;
// 2026-10-17 用户要求：过去 20 个交易日整段窗口的「总涨幅」须 < 100%
// 总涨幅 = 该 20 日窗口 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 × 100（即 stockWindowRangePct 的整段口径）
const MAX_TOTAL_RANGE_PCT = 100;
// 2026-10-17 用户要求：四连板（连板数 ≥ 4）之后若出现过任一交易日涨幅 < -9%，则从候选池剔除该股
// 2026-10-17 用户要求：单日跌幅阈值由 -6% 扩大到 -9%
const POST_LIANBAN_DROP_PCT = -9;
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

// 过去若干交易日内「任意连续 slideDays 个交易日」的区间最大涨幅取最大值（%）：
// 逐个子窗口调用 stockWindowRangePct，取最大；任一子窗口缺 K 线则返回 null（视为不达标）
// 2026-10-17 用户要求：区间涨幅按「连续 10 个交易日」滑动窗口计算，而非整个外层区间
// 2026-10-17 用户要求：区间涨幅口径由「最高价/最低价」改为「收盘价」
const maxSlidingWindowRangePct = (code, winDates, slideDays) => {
  if (!Array.isArray(winDates) || winDates.length < slideDays) return null;
  let max = null;
  for (let i = 0; i + slideDays <= winDates.length; i += 1) {
    const rp = stockWindowRangePct(code, winDates.slice(i, i + slideDays));
    if (rp == null || !Number.isFinite(rp)) return null;
    if (max == null || rp > max) max = rp;
  }
  return max;
};

// 价格类卖点的分钟级回溯统一走 ./leaderSellMinute.scanLeaderPriceSell

// 2026-10-17 用户新增门禁：若上个交易日强度分 > 60，则当天买入时竞价低开不得超过 -3%
const PREV_STRENGTH_GAP_GATE = 60;   // 上个交易日强度分门槛（> 60 时触发竞价限制）
const OPEN_GAP_MIN_PCT = -3;         // 竞价低开下限（开盘涨幅须 >= -3%）

// 2026-10-17 用户新增门禁：上个交易日强度分 > 60 且当日竞价低开超过 -3%（开盘涨幅 < -3%）时该候选不可买（顺延下一只）
// 上个交易日强度分或竞价数据缺失时不判定（允许买入）
const failPrevStrengthOpenGap = (r) => {
  const prevStrength = r.crossInfo ? r.crossInfo.prevDayStrength : null;
  if (!(prevStrength != null && prevStrength > PREV_STRENGTH_GAP_GATE)) return false;
  const gap = r.s ? r.s.aRaw : null;
  if (gap == null || !Number.isFinite(gap)) return false;
  return gap < OPEN_GAP_MIN_PCT;
};

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
//   2026-10-17 用户新增：若「上个交易日」delta > DELTA_MIN（昨日已达 30），则该日成交量不得小于其前 3 个交易日成交量均值
//   （即上个交易日须放量，避免「强更强」但缩量的高位被套）；仅在该日前 3 日 K 线与当日量均齐备时判定，数据缺失时不判定
//   2026-10-17 用户新增门禁：若「上个交易日强度分 > 60」，则当日买入时「竞价低开不得超过 -3%」（开盘价较昨收涨幅须 >= -3%），
//   否则该候选不可买、顺延至下一只；上个交易日强度分数据缺失时不判定
// 返回 { hasCross, consumed, hitCount, crossIdx, deltas, dates, prevDayDelta, prevDayVolRatio, prevDayStrength, prevDayVolumeOk }
const computeCrossInfo = async (code, crossDates) => {
  const idxCode = iceResilienceIndexCode(code);
  const deltas = [];
  const volRatios = []; // 逐日「(当日量 − 前 3 日日均量) ÷ 前 3 日日均量」（用于上个交易日放量确认，2026-10-17 用户新增）
  const strengths = []; // 逐日「强度分」（收盘 1500 口径，用于上个交易日强度分门禁，2026-10-17 用户新增）
  for (const d of crossDates) {
    const t = await loadTlinePoints(code, d);
    if (!t || t.points.length === 0 || !(t.preclose > 0)) { deltas.push(null); volRatios.push(null); strengths.push(null); continue; }
    // 差劲分（收盘 1500 口径）：A 放量比 + B 单分钟最大跳水 + C 冲高回落 + D 涨停炸板/跌幅
    const lastPx = t.points[t.points.length - 1].lastPx;
    const dayChange = ((lastPx - t.preclose) / t.preclose) * 100;
    const dItem = diffDFrom(t.points, t.preclose, code, dayChange);
    const volRatio = stockVolumeRatioAt(code, d);
    const diff = buildDiffDetail(
      volRatio,
      maxMinuteDrop(t.points),
      closeDropFromHigh(t.points),
      dItem,
    );
    volRatios.push(volRatio);
    const idxT = await loadTlinePoints(idxCode, d);
    const s = strengthAtMinute(t, CLOSE_MINUTE, code, idxT.points);
    const strength = s ? s.score : null;
    strengths.push(strength);
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
  // 2026-10-17 用户要求：上个交易日 delta > DELTA_MIN 时，该日成交量必须 ≥ 其前 3 个交易日成交量均值
  // （volRatio = (当日量 − 前3日均量) ÷ 前3日均量，故「放量达标」即 volRatio >= 0）；
  // 数据缺失（volRatio 为 null）时不判定该限制
  const prevDayDelta = deltas.length > 0 ? deltas[deltas.length - 1] : null;
  const prevDayVolRatio = volRatios.length > 0 ? volRatios[volRatios.length - 1] : null;
  const prevDayStrength = strengths.length > 0 ? strengths[strengths.length - 1] : null; // 上个交易日强度分（2026-10-17 用户新增门禁）
  const prevDayVolumeOk = !(prevDayDelta != null && prevDayDelta > DELTA_MIN)
    || prevDayVolRatio == null
    || (Number.isFinite(prevDayVolRatio) && prevDayVolRatio >= 0);
  const consumed = hitCount >= 2;
  return { hasCross: crossIdx >= 0, consumed, hitCount, crossIdx, deltas, dates: crossDates, prevDayDelta, prevDayVolRatio, prevDayStrength, prevDayVolumeOk };
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

  // 2026-10-17 用户要求：候选池若与「全量自选股中的科技股」（monitor_stocks.json 中 isTech !== false）
  // 重叠，则该股不买（建仓前即从候选池剔除，避免与科技股仓位重叠）
  const techWatchlistCodes = new Set(
    (getMonitorStocks() || [])
      .filter(s => s && s.code && s.isTech !== false)
      .map(s => s.code),
  );

  // 账户拆两份（各半仓）独立持仓：两份各自独立买卖、互不重叠同一标的，可在不同日期建仓
  const positions = new Array(LEG_COUNT).fill(null);
  const legLastSellDate = new Array(LEG_COUNT).fill(null); // 该份卖出当日不再追买（两份间互不影响）

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
      const themeRemoved = [];
      const base = (info.stocks || []).filter(s => {
        if (EXCLUDED_CODES.has(s.code)) return false;
        if (isChiNextOrStar(s.code)) return false;
        // 2026-10-17 用户要求：候选池整体剔除 PCB/玻璃基板/光模块/液冷/通信/算力/芯片 题材
        if (isExcludedTheme(s.board)) { themeRemoved.push(s); return false; }
        return true;
      });
      const themeFilterText = themeRemoved.length > 0
        ? `；题材黑名单（${EXCLUDED_THEMES.join('、')}）剔除 ${themeRemoved.length} 只（${themeRemoved.map(s => `${s.name || s.code}（${s.board}）`).join('、')}）`
        : '';
      // 2026-10-17 用户要求：过去 RANGE_WINDOW_DAYS 个交易日内「任意连续 RANGE_SLIDE_DAYS 个交易日」区间最大涨幅须 < 80%（剔除近期已大幅拉升者）
      if (base.length > 0) {
        let winDates = [];
        try { winDates = await getPastTradingDates(dateStr, RANGE_WINDOW_DAYS); } catch (e) { winDates = []; }
        try { await ensureBarsForCodes(new Set(base.map(s => s.code))); } catch (e) { /* 拉取失败按数据缺失处理 */ }
        if (winDates.length >= RANGE_WINDOW_DAYS) {
          const before = base.length;
          candidatesRaw = base.filter(s => {
            const rp = maxSlidingWindowRangePct(s.code, winDates, RANGE_SLIDE_DAYS);
            // 区间振幅缺失（日K未覆盖）视为不达标，与精准择时同口径
            return rp != null && Number.isFinite(rp) && rp < MAX_WINDOW_RANGE_PCT;
          });
          const beforeDrop = candidatesRaw.length;
          // 2026-10-17 用户要求：四连板之后出现过任一交易日涨幅 < -9% 的个股一并剔除
          candidatesRaw = candidatesRaw.filter(s => !hasPostLianbanBigDrop(s.code, s.date, winDates));
          const beforeTotal = candidatesRaw.length;
          // 2026-10-17 用户要求：过去 RANGE_WINDOW_DAYS 个交易日「总涨幅」须 < 100%
          // 总涨幅 = 整段窗口 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 × 100（不含当日，与区间振幅同口径）
          candidatesRaw = candidatesRaw.filter(s => {
            const total = stockWindowRangePct(s.code, winDates);
            return total != null && Number.isFinite(total) && total < MAX_TOTAL_RANGE_PCT;
          });
          poolFilterText = `；过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < ${MAX_WINDOW_RANGE_PCT}% 剔除 ${before - beforeDrop} 只；四连板后出现单日涨幅 < ${POST_LIANBAN_DROP_PCT}% 再剔除 ${beforeDrop - beforeTotal} 只；过去 ${RANGE_WINDOW_DAYS} 个交易日总涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 < ${MAX_TOTAL_RANGE_PCT}% 再剔除 ${beforeTotal - candidatesRaw.length} 只`;
        } else {
          poolFilterText = `；过去 ${RANGE_WINDOW_DAYS} 个交易日日K数据不足，本日无候选`;
        }
        poolFilterText += themeFilterText;
      }
    } catch (e) { candidatesRaw = []; }
    // 2026-10-17 用户要求：候选与全量自选股科技股（isTech !== false）重叠者剔除，不参与买入
    if (candidatesRaw.length > 0 && techWatchlistCodes.size > 0) {
      const removedStocks = candidatesRaw.filter(s => techWatchlistCodes.has(s.code));
      if (removedStocks.length > 0) {
        candidatesRaw = candidatesRaw.filter(s => !techWatchlistCodes.has(s.code));
        poolFilterText += `；与全量自选股科技股（isTech ≠ false）重叠剔除 ${removedStocks.length} 只（${removedStocks.map(s => `${s.name || s.code}（${s.code}）`).join('、')}）`;
      }
    }
    if (candidatesRaw.length > 0) {
      for (const s of candidatesRaw) {
        s.poolFilterText = poolFilterText;
        if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
      }
    }

    // 每日分时缓存重建，控制内存
    clearTlineCache();

    // 逐份隔夜持仓的当日分时（卖点用），及逐份当日收盘抗分歧指数（卖点⑥用；懒计算）
    const posTlines = new Array(LEG_COUNT).fill(null);
    for (let l = 0; l < LEG_COUNT; l++) {
      const p = positions[l];
      if (p && dateStr > p.buyDate) posTlines[l] = await loadTlinePoints(p.code, dateNum);
    }
    const posResiliences = new Array(LEG_COUNT).fill(null);
    const posResilienceLoaded = new Array(LEG_COUNT).fill(false);
    const ensurePosResilience = async (l) => {
      if (posResilienceLoaded[l]) return posResiliences[l];
      posResilienceLoaded[l] = true;
      const p = positions[l];
      if (!p) return null;
      try {
        const [stockT, indexT] = await Promise.all([
          getSingleStockTlineDataByDate(p.code, dateNum),
          getSingleStockTlineDataByDate(LEADER_RESILIENCE_INDEX_CODE, dateNum),
        ]);
        const stockLine = (stockT?.line || [])
          .filter(x => x && x.minute != null && x.last_px != null)
          .map(x => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter(x => x.lastPx > 0);
        const indexLine = (indexT?.line || [])
          .filter(x => x && x.minute != null && x.last_px != null)
          .map(x => ({ minute: parseInt(x.minute, 10), lastPx: parseFloat(x.last_px), change: x.change != null ? parseFloat(x.change) : 0 }))
          .filter(x => x.lastPx > 0);
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const s = calculateReplayResilience(stockLine, indexLine, p.code);
          if (s != null && Number.isFinite(Number(s))) posResiliences[l] = round2(s);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResiliences[l];
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
        // 2026-10-17 用户新增：上个交易日 delta > 30 时，该日成交量须 ≥ 其前 3 个交易日成交量均值（放量确认，2026-10-17 用户要求）
        .filter(c => c.crossInfo && c.crossInfo.hasCross && !c.crossInfo.consumed && c.crossInfo.prevDayVolumeOk);
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

    let boughtThisDate = false; // 2026-10-17 用户要求：每次触发买点只买入一份（一个交易日最多建仓一份）

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);

      // ===== 卖出（隔夜持仓；沿用龙头战法 10 条卖点，价格类卖点分钟级回溯）=====
      // 两份持仓各自独立卖出（各半仓）
      for (let l = 0; l < LEG_COUNT; l++) {
        const position = positions[l];
        const posTline = posTlines[l];
        if (!position || !(dateStr > position.buyDate) || !posTline || posTline.points.length === 0) continue;
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
            // 2026-10-17 用户要求：本策略成本线止损口径 -5%（现价 < 买入价 × 0.95）且不设持续分钟
            costLinePct: -5,
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
            const res = await ensurePosResilience(l);
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
              splitLeg: LEG_LABELS[l],
              weight: LEG_WEIGHT,
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
              sellReason: `${sellReason}，情绪游资-极致胜率·第 ${l + 1} 份（半仓）卖出`,
              returnRate: rawReturnRate != null ? round2(rawReturnRate * LEG_WEIGHT) : null,
              rawReturnRate,
            });
            positions[l] = null;
            legLastSellDate[l] = dateStr; // 该份卖出当日不再追买
          }
        }
      }

      // ===== 买入（2026-10-17 用户要求：账户拆两份各半仓，每次触发买点只买入一份、可不同日期建仓）=====
      // 本交易日已建仓一份则不再建仓；目标份 = 第一份空仓且当日未卖出过的仓位
      if (!boughtThisDate) {
        const legIdx = positions.findIndex((p, i) => !p && legLastSellDate[i] !== dateStr);
        if (legIdx !== -1) {
          // 指数门禁（2026-10-17 用户新增）：仅当上证指数 3 日线分时斜率为正时才允许买入，否则跳过本桶
          const idxMa3Slope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
          if (!(Number(idxMa3Slope) > 0)) continue;
          await ensurePoolData();
          if (candidates.length > 0) {
            const ranked = evalBucket(bucketMinute);
            // 两份不得同时持有同一只股票：剔除另一份当前持仓标的
            const otherHeld = positions.filter((p, i) => i !== legIdx && p).map(p => p.code);
            // 买入时点已涨停不可买 / 已被另一份持有 / 上个交易日强度分 > 60 且竞价低开 > 3% → 顺延至差值排名下一只
            const pick = ranked.find(r => !r.limitUp && !otherHeld.includes(r.code) && !failPrevStrengthOpenGap(r));
            if (pick) {
              positions[legIdx] = buildPosition({ pick, ranked, dateStr, dateDisplay, timeText, idxMa3Slope, legIdx, otherHeld });
              positions[legIdx].buyDi = todayIdx;
              boughtThisDate = true;
              for (const c of candidates) if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name || c.code });
            }
          }
        }
      }
    }
  }

  // 组装结果（type:'single'：两份各半仓独立持仓，整体收益率 = 两份子账户各自复利后按 0.5 加权相加）
  const factorOf = (ts, holding) => {
    let f = 1;
    for (const t of ts) if (t.rawReturnRate != null && Number.isFinite(Number(t.rawReturnRate))) f *= 1 + Number(t.rawReturnRate) / 100;
    if (holding && holding.rawBuyReturn != null && Number.isFinite(Number(holding.rawBuyReturn))) f *= 1 + Number(holding.rawBuyReturn) / 100;
    return f;
  };
  const holdings = [];
  const lastPxDate = rangeDates[rangeDates.length - 1];
  for (let l = 0; l < LEG_COUNT; l++) {
    const p = positions[l];
    if (!p) continue;
    const holding = { ...p, weight: LEG_WEIGHT };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(p.code, lastPxDate);
    if (closePx != null && closePx > 0 && p.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - p.buyPrice) / p.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? round2(rawBuyReturn * LEG_WEIGHT) : null;
    holdings.push(holding);
  }
  const overallReturn = round2(
    (LEG_LABELS.reduce((sum, lb) => sum + LEG_WEIGHT * factorOf(
      trades.filter(t => t.splitLeg === lb),
      holdings.find(h => h.splitLeg === lb),
    ), 0) - 1) * 100,
  );
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
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
    currentHoldings: holdings,
    currentHolding: holdings.length === 1 ? holdings[0] : null,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: holdings.length > 0,
    },
  };
};

// 构建持仓对象（含买入原因与死叉 / 差劲分 / 强度分诊断明细；legIdx = 所属份别，各半仓）
const buildPosition = ({ pick, ranked, dateStr, dateDisplay, timeText, idxMa3Slope, legIdx = 0, otherHeld = [] }) => {
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
  const buyReason = `${timeText} 过去 ${DEATH_CROSS_WINDOW} 个交易日内出现死叉（${crossDate}）后，今日满足「强度分 − 差劲分 = ${delta} ≥ ${DELTA_MIN}」（死叉后第 ${hitCount + 1} 次达标，本策略只允许前 2 次），买入候选 ${pick.name}（${pick.code}，${pick.lianbanCount} 连板），触发时点价 ${pick.px.toFixed(2)}；本次建仓为第 ${legIdx + 1} 份（半仓 ${LEG_WEIGHT * 100}%）${otherHeld.length > 0 ? `，已排除另一份当前持仓标的（${otherHeld.join('、')}）` : ''}`;
  const checks = [
    {
      id: 'extreme_win_pool',
      title: `选股（过去 ${LOOKBACK_DAYS} 个交易日四连板及以上；剔除创业板/科创板；剔除 ${EXCLUDED_THEMES.join('/')} 题材；过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 < ${MAX_WINDOW_RANGE_PCT}%；过去 ${RANGE_WINDOW_DAYS} 个交易日总涨幅 < ${MAX_TOTAL_RANGE_PCT}%；四连板后无单日涨幅 < ${POST_LIANBAN_DROP_PCT}%；无全量自选股科技股重叠）`,
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板`,
      reason: `候选 = 过去 ${LOOKBACK_DAYS} 个交易日内出现连板数 ≥ ${MIN_BOARD_COUNT} 的个股（命中日 ${pick.date}，板块 ${pick.board || '--'}）；已剔除 ST 等黑名单、创业板（30/301）与科创板（688）、${EXCLUDED_THEMES.join('/')} 题材（板块名包含关键词即剔除）与全量自选股科技股（isTech ≠ false）重叠者${pick.poolFilterText || ''}；本桶达标候选共 ${ranked.length} 只，按今日「强度分 − 差劲分」降序取第一个「未涨停且未被另一份持有」者作为第 ${legIdx + 1} 份（半仓）建仓标的`,
    },
    {
      id: 'extreme_win_cross',
      title: `买点前置：过去 ${DEATH_CROSS_WINDOW} 个交易日死叉且死叉后达标次数 ≤ 1（上个交易日 delta > ${DELTA_MIN} 时须放量）`,
      passed: true,
      value: `死叉日 ${crossDate}（死叉后达标 ${hitCount} 次，本次为第 ${hitCount + 1} 次；上个交易日 delta ${cross.prevDayDelta == null ? '--' : cross.prevDayDelta}${cross.prevDayDelta != null && cross.prevDayDelta > DELTA_MIN ? `、放量比 ${cross.prevDayVolRatio == null ? '--' : cross.prevDayVolRatio}` : ''}；日线「强度 − 差劲」序列 ${deltasText}）`,
      reason: `过去 ${DEATH_CROSS_WINDOW} 个交易日内出现过「强度分由高于差劲分转为一度低于差劲分」的死叉；死叉之后至昨日 delta ≥ ${DELTA_MIN} 的交易日数为 ${hitCount}（2026-10-17 用户要求：只允许「第一次或第二次」达标才买，${hitCount} ≤ 1 天视为未被历史消耗）；且上个交易日 delta = ${cross.prevDayDelta == null ? '数据缺失（不判定）' : cross.prevDayDelta}${cross.prevDayDelta != null && cross.prevDayDelta > DELTA_MIN ? ` > ${DELTA_MIN}，则该日成交量须 ≥ 其前 3 个交易日成交量均值（放量比 ${cross.prevDayVolRatio == null ? '数据缺失（不判定）' : cross.prevDayVolRatio} ≥ 0，2026-10-17 用户新增：避免「强更强」但缩量的高位被套）` : '（未超过 ' + DELTA_MIN + '，不触发放量要求）'}`,
    },
    {
      id: 'extreme_win_prev_strength_gap',
      title: `买点门禁：上个交易日强度分 > ${PREV_STRENGTH_GAP_GATE} 时当日竞价低开须 ≥ ${OPEN_GAP_MIN_PCT}%`,
      passed: true,
      value: `上个交易日强度分 ${cross.prevDayStrength == null ? '--' : cross.prevDayStrength}；当日竞价高开 ${s.aRaw}%（开盘 ${s.openPx} / 昨收 ${s.preclose}）`,
      reason: cross.prevDayStrength != null && cross.prevDayStrength > PREV_STRENGTH_GAP_GATE
        ? `上个交易日强度分 ${cross.prevDayStrength} > ${PREV_STRENGTH_GAP_GATE}，故当日竞价低开不得超过 ${OPEN_GAP_MIN_PCT}%；本股当日竞价高开 ${s.aRaw}% ≥ ${OPEN_GAP_MIN_PCT}%，满足门禁（2026-10-17 用户新增：上个交易日强度过高时，若当日报价大幅低开易高位被套）`
        : `上个交易日强度分 ${cross.prevDayStrength == null ? '数据缺失（不判定）' : cross.prevDayStrength} ≤ ${PREV_STRENGTH_GAP_GATE}，不触发竞价低开限制（2026-10-17 用户新增门禁）`,
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
    splitLeg: LEG_LABELS[legIdx],
    board: pick.board,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: timeText,
    buyPrice: round2(pick.px),
    buyChange: round2(s.changePct),
    metric: delta,
    weight: LEG_WEIGHT,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runExtremeWinBacktest };
