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
const {
  iceResilienceIndexCode,
  getIceMa3SlopeIntraday,
  fmtKeyBlockSlope,
  ICE_SIGNAL_INDEX_CODE,
  ensureIndexMa3SlopeSeries,
  precomputeTurnMap,
} = require('./indexGate');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_CODES, EXCLUDED_THEMES, isExcludedTheme } = require('../constants');
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
//   2026-10-17 用户要求：把「情绪游资-反向抱团龙头」作为**逆周期**腿融合进本策略——两条腿择时互补：
//     ① 顺周期腿 = 本策略原有逻辑（上证 3 日线分时斜率 > 0 才买，见下「买点」）；② 逆周期腿 = 反向抱团龙头逻辑
//     （上证 3 日线斜率连续为负第 3 天及以后、当日上证跌幅 ≥ 0.5% 时，候选股盘中强度分第 2 次 > 50 买入）。
//     **账户仍拆两份、每份各半仓**：谁的买点先触发就由谁占用一个空仓位（各信号每交易日最多建仓一份）；
//     若两份均已满仓，则另一条腿即使触发也不买。两条腿各自独立买卖、独立计成本与收益（均 ×0.5 折算），
//     两条腿不得同时持有同一只股票。回测记录以 `cycle` 字段区分顺周期（procyclic）/ 逆周期（counter）。
//     「情绪游资-反向抱团龙头」作为独立策略仍保留（全仓单持仓），本策略的逆周期腿规则与其**完全一致**，唯一区别是按半仓计收益。
//   —— 以下为顺周期腿（极致胜率原逻辑）——
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
//   —— 逆周期腿（反向抱团龙头，2026-10-17 融合）规则见 reverseLeader 系列常量与 buildRevPosition ——
//   仓位（2026-10-17 用户要求）：账户拆两份、每份各半仓，两份各自独立买卖、独立计成本与收益（均按半仓 ×0.5 折算）；
//          谁的买点先触发就由谁占用空仓位，两份不得同时持有同一只股票；整体收益 = 两份子账户各自复利后按 0.5 加权相加。
// ============================================================

// 2026-10-17 用户要求：账户拆两份、每份各半仓，两份独立买卖（互不重叠同一标的）
const LEG_COUNT = 2;               // 仓位份数
const LEG_WEIGHT = 0.5;            // 每份占账户资金比例（半仓）
const LEG_LABELS = ['A', 'B'];     // 份别标记（物理仓位槽）

// 腿标记（2026-10-17 用户要求：回测记录中标注顺周期 / 逆周期）
const CYCLE_PRO = 'procyclic';     // 顺周期：极致胜率原逻辑（上证斜率 > 0 才买）
const CYCLE_COUNTER = 'counter';   // 逆周期：反向抱团龙头逻辑（上证斜率连续为负 + 当日大跌）
const CYCLE_LABELS = { [CYCLE_PRO]: '顺周期', [CYCLE_COUNTER]: '逆周期' };

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

// ---- 逆周期腿（情绪游资-反向抱团龙头，2026-10-17 用户要求融合进本策略；规则与独立策略完全一致，仅按半仓计收益）----
const REV_LOOKBACK_DAYS = 20;        // 反向抱团：过去 20 个交易日出现过连板
const REV_MIN_BOARD_COUNT = 2;       // 反向抱团：连板门槛 2 板及以上
const REV_RANGE_WINDOW_DAYS = 20;    // 反向抱团：动量窗口 20 日（不含当日）
const REV_RANGE_SLIDE_DAYS = 10;     // 反向抱团：滑动子窗口 连续 10 日
const REV_MIN_WINDOW_RANGE_PCT = 60; // 反向抱团：子窗口区间最大涨幅门槛 ≥ 60%
const REV_NEG_STREAK_MIN_DAYS = 2;   // 反向抱团：斜率连续为负第 3 天起（daysSinceTurnNeg >= 2）
const REV_INDEX_DROP_PCT = -0.5;     // 反向抱团：当日上证跌幅 ≥ 0.5%（较昨收 ≤ -0.5%）
const REV_STRENGTH_MIN = 50;         // 反向抱团：盘中强度分 > 50 记一次命中
const REV_HIT_REQUIRED = 2;          // 反向抱团：累计 2 次命中买入

// 2026-10-17 用户要求：候选池整体剔除 PCB / 玻璃基板 / 光模块 / 液冷 / 通信 / 算力 / 芯片 / 靶材 / 电子气体 / 光刻胶 / 算力租赁 题材
// （EXCLUDED_THEMES / isExcludedTheme 已提升到 ../constants，供「情绪游资-极致胜率」与「情绪游资-反向抱团龙头」共用同一份名单）
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
// 逐个子窗口调用 stockWindowRangePct 取最大；任一子窗口缺 K 线则返回 null（视为不达标）
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

// 上证指数「前一交易日收盘口径」3 日线斜率（用于逆周期腿「盘中由负转正」卖点），数据不足返回 null
// slopeByDate: Map<dateNum, slope>，取严格小于 dateStr 的最大日期对应的斜率
const prevSlopeOf = (slopeByDate, dateStr) => {
  const target = Number(dateStr);
  let bestDate = null;
  let bestSlope = null;
  for (const [d, s] of slopeByDate) {
    if (d < target && (bestDate === null || d > bestDate)) { bestDate = d; bestSlope = s; }
  }
  return bestSlope;
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

  // 顺周期腿预计算：上证 3 日线斜率收盘序列（供逆周期腿卖点「前一交易日收盘斜率」基准）+ 历史「由正转负 / 由负转正」事件
  const slopeByDate = new Map();
  try {
    const { dates, slopes } = await ensureIndexMa3SlopeSeries(ICE_SIGNAL_INDEX_CODE);
    for (const d of dates) {
      const s = slopes.get(d);
      if (s != null && Number.isFinite(Number(s))) slopeByDate.set(Number(d), Number(s));
    }
  } catch (e) { /* 数据不足时逆周期腿卖点不生效 */ }
  let turnMap = new Map();
  try {
    turnMap = await precomputeTurnMap(ICE_SIGNAL_INDEX_CODE, rangeDates.map(Number));
  } catch (e) {
    turnMap = new Map();
  }

  // 启动预拉取：扫描整个回测区间每个交易日可能出现的候选股，一次性拉取日K（供放量比 / 死叉日线序列使用）
  try {
    const presetAll = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      for (const s of stocks) presetAll.add(s.code);
    }
    if (presetAll.size > 0) await ensureBarsForCodes(presetAll);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }
  // 逆周期腿候选池预拉取：过去 20 日出现过 ≥ 2 板者
  try {
    const presetRev = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, REV_LOOKBACK_DAYS, REV_MIN_BOARD_COUNT);
      for (const s of stocks) presetRev.add(s.code);
    }
    if (presetRev.size > 0) await ensureBarsForCodes(presetRev);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  // 2026-10-17 用户要求：候选池若与「全量自选股中的科技股」（monitor_stocks.json 中 isTech !== false）
  // 重叠，则该股不买（建仓前即从候选池剔除，避免与科技股仓位重叠；仅作用于顺周期腿）
  const techWatchlistCodes = new Set(
    (getMonitorStocks() || [])
      .filter(s => s && s.code && s.isTech !== false)
      .map(s => s.code),
  );

  // 账户拆两份（各半仓）独立持仓：两份各自独立买卖、互不重叠同一标的，可在不同日期建仓
  const positions = new Array(LEG_COUNT).fill(null);
  const legLastSellDate = new Array(LEG_COUNT).fill(null); // 该份卖出当日不再追买（两份间互不影响）

  // 逆周期腿命中计数（逐股独立累计；只在当前负斜率窗口内累计，窗口变化即清零）
  const revHitCount = new Map();
  let revWindowKey = null;

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

    // 逆周期腿买点前置：上证 3 日线斜率收盘口径连续为负第 3 天及以后（转负当日为第 1 天）
    const tInfo = turnMap.get(Number(dateStr));
    const slopeClose = tInfo ? tInfo.slopeClose : null;
    const daysSinceTurnNeg = tInfo ? tInfo.daysSinceTurnNeg : null;
    const curWindowKey = tInfo ? tInfo.turnNegDate : null;
    if (curWindowKey !== revWindowKey) { revHitCount.clear(); revWindowKey = curWindowKey; }
    const eligibleRev = slopeClose != null && slopeClose < 0
      && daysSinceTurnNeg != null && daysSinceTurnNeg >= REV_NEG_STREAK_MIN_DAYS;
    // 逆周期腿卖点基准：前一交易日收盘口径斜率
    const revPrevCloseSlope = prevSlopeOf(slopeByDate, dateStr);

    // ===== 顺周期腿候选池（连板股名单，读快照，较廉价）=====
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
            // 区间振幅缺失（日K未覆盖）视为不达标
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

    // ===== 逆周期腿候选池（仅在可用日构建；连板名单 + 题材黑名单 + 动量过滤）=====
    let revCandidatesRaw = [];
    let revPoolFilterText = '';
    if (eligibleRev) {
      try {
        const info = await getRecentMultiLianbanStocks(dateStr, REV_LOOKBACK_DAYS, REV_MIN_BOARD_COUNT);
        const themeRemoved = [];
        const base = (info.stocks || []).filter(s => {
          if (EXCLUDED_CODES.has(s.code)) return false;
          // 2026-10-17 用户要求：逆周期腿候选池一律剔除创业板（30/301）与科创板（688），与顺周期腿口径一致
          if (isChiNextOrStar(s.code)) return false;
          if (isExcludedTheme(s.board)) { themeRemoved.push(s); return false; }
          return true;
        });
        const themeFilterText = themeRemoved.length > 0
          ? `；题材黑名单（${EXCLUDED_THEMES.join('、')}）剔除 ${themeRemoved.length} 只（${themeRemoved.map(s => `${s.name || s.code}（${s.board}）`).join('、')}）`
          : '';
        if (base.length > 0) {
          let winDates = [];
          try { winDates = await getPastTradingDates(dateStr, REV_RANGE_WINDOW_DAYS); } catch (e) { winDates = []; }
          try { await ensureBarsForCodes(new Set(base.map(s => s.code))); } catch (e) { /* 拉取失败按数据缺失处理 */ }
          if (winDates.length >= REV_RANGE_WINDOW_DAYS) {
            const before = base.length;
            revCandidatesRaw = base.filter(s => {
              const rp = maxSlidingWindowRangePct(s.code, winDates, REV_RANGE_SLIDE_DAYS);
              return rp != null && Number.isFinite(rp) && rp >= REV_MIN_WINDOW_RANGE_PCT;
            });
            revPoolFilterText = `${themeFilterText}；过去 ${REV_RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${REV_RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 ≥ ${REV_MIN_WINDOW_RANGE_PCT}% 保留 ${revCandidatesRaw.length}/${before} 只`;
          } else {
            revPoolFilterText = `${themeFilterText}；过去 ${REV_RANGE_WINDOW_DAYS} 个交易日日K数据不足，本日无候选`;
          }
        }
      } catch (e) { revCandidatesRaw = []; }
      if (revCandidatesRaw.length > 0) {
        for (const s of revCandidatesRaw) {
          s.poolFilterText = revPoolFilterText;
          if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
        }
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

    // 指数分时（主板 sh000001 / 创业板 sz399006 / 科创50 sh000688）：两条腿共用（懒加载，每日一次）
    let idxTlineReady = false;
    const idxTlineMap = new Map(); // idxCode -> { preclose, points }
    const ensureIdxTlines = async () => {
      if (idxTlineReady) return;
      idxTlineReady = true;
      await Promise.all(['sh000001', 'sz399006', 'sh000688'].map(async (ic) => {
        try {
          const r = await loadTlinePoints(ic, dateNum);
          idxTlineMap.set(ic, r || { preclose: null, points: [] });
        } catch (e) { idxTlineMap.set(ic, { preclose: null, points: [] }); }
      }));
    };
    const idxPointsOf = (code) => (idxTlineMap.get(iceResilienceIndexCode(code)) || {}).points || [];
    // 上证指数截至某桶的当日跌幅（较昨收 %）；数据不足返回 null（逆周期腿买点前置用）
    const idxChangeAt = (minute) => {
      const t = idxTlineMap.get(ICE_SIGNAL_INDEX_CODE);
      if (!t || !(t.preclose > 0) || t.points.length === 0) return null;
      const atPt = priceAtMinute(t.points, minute);
      if (!atPt || !(atPt.lastPx > 0)) return null;
      return ((atPt.lastPx - t.preclose) / t.preclose) * 100;
    };

    // 顺周期腿候选池数据（懒加载：仅当空仓需要评估买入时构建）：死叉前置 + 今日分时 + 今日前 3 日均量
    let poolReady = false;
    let candidates = [];
    const todayTline = new Map();   // code -> { preclose, points }
    const todayAvg3Vol = new Map(); // code -> 今日前 3 个交易日日均量

    const ensurePoolData = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidatesRaw.length === 0) return;
      await ensureIdxTlines();
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
    };

    // 逆周期腿候选池数据（懒加载：仅在可用日需要评估强度分时构建）：今日分时（指数分时已由 ensureIdxTlines 覆盖）
    let revPoolReady = false;
    const revTodayTline = new Map(); // code -> { preclose, points }
    const ensureRevPoolData = async () => {
      if (revPoolReady) return;
      revPoolReady = true;
      if (revCandidatesRaw.length === 0) return;
      await ensureIdxTlines();
      await batchParallel(revCandidatesRaw, async (c) => {
        try { revTodayTline.set(c.code, await loadTlinePoints(c.code, dateNum)); } catch (e) { revTodayTline.set(c.code, { preclose: null, points: [] }); }
      }, 8);
    };

    // 顺周期腿评估某桶的候选：返回按今日「强度分 − 差劲分」降序排列的达标（>= DELTA_MIN）候选数组
    const evalBucket = (bucketMinute) => {
      const out = [];
      for (const c of candidates) {
        const t = todayTline.get(c.code);
        if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
        // 今日实时差劲分（A 用分时累计成交量对前 3 日日均量的放量比）
        const d = diffAtMinute(t.points, t.preclose, c.code, bucketMinute, todayAvg3Vol.get(c.code));
        if (!d) continue;
        // 今日实时强度分（截至当前桶）
        const s = strengthAtMinute(t, bucketMinute, c.code, idxPointsOf(c.code));
        if (!s) continue;
        const delta = round2(s.score - d.score);
        if (delta == null || delta < DELTA_MIN) continue;
        out.push({ ...c, delta, strength: s.score, diffScore: d.score, s, d, px: s.px, changePct: s.changePct, limitUp: s.limitUp });
      }
      out.sort((a, b) => b.delta - a.delta);
      return out;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 2026-10-17 用户要求：账户拆两份各半仓，各信号每交易日最多建仓一份（谁先触发谁占空仓位）
    let boughtProcyclicToday = false;
    let boughtCounterToday = false;
    const revDayTriggered = new Set(); // 逆周期腿当日已登记命中的候选（同一天同一只只计一次）
    const idleLegIdx = () => positions.findIndex((p, i) => !p && legLastSellDate[i] !== dateStr);

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);

      // ===== 卖出（隔夜持仓；按每条腿各自的卖点规则独立卖出）=====
      for (let l = 0; l < LEG_COUNT; l++) {
        const position = positions[l];
        const posTline = posTlines[l];
        if (!position || !(dateStr > position.buyDate) || !posTline || posTline.points.length === 0) continue;
        const atPt = priceAtMinute(posTline.points, bucketMinute);
        if (!atPt || !(atPt.lastPx > 0)) continue;
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

        const isCounter = position.cycle === CYCLE_COUNTER;
        // 价格类卖点分钟级回溯：
        //   顺周期腿 = 极致胜率原口径（成本线 -5% 且不设持续分钟）∪ 其余 6 类（含单分钟跳水）
        //   逆周期腿 = 反向抱团龙头口径（成本线 -5% 且连续 ≥5 分钟）但**去掉「1 分钟内跳水」卖点**
        const priceHit = isCounter
          ? scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
            disableMinutePlummet: true,
          })
          : scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
            costLinePct: -5,
            costLineSustainMinutes: 0,
          });
        if (priceHit) {
          sellReason = priceHit.reason;
          sellMinute = priceHit.minute;
          sellPx = priceHit.px;
          sellChange = priceHit.changePct;
        }
        // 逆周期腿新增卖点：上证指数 3 日线斜率盘中由负转正（前一交易日收盘斜率 <= 0、当桶实时斜率 > 0）
        if (!sellReason && isCounter) {
          const intradaySlope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
          if (intradaySlope != null && Number.isFinite(Number(intradaySlope))
            && revPrevCloseSlope != null && revPrevCloseSlope <= 0 && Number(intradaySlope) > 0) {
            sellReason = `上证指数 3 日线斜率盘中由负转正（前一交易日收盘 ${fmtKeyBlockSlope(revPrevCloseSlope)} → 当桶实时 ${fmtKeyBlockSlope(intradaySlope)}）`;
          }
        }
        // ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10%（两条腿共用）
        if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
          if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
            sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
          }
        }
        // ⑥ 收盘抗分歧指数 < 6（两条腿共用）
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
          const cycleLabel = CYCLE_LABELS[position.cycle] || '顺周期';
          trades.push({
            seq: trades.length + 1,
            metric: position.metric,
            code: position.code,
            stockName: position.stockName,
            board: position.board,
            positionMode: 'offense',
            splitLeg: LEG_LABELS[l],
            cycle: position.cycle,
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
            sellReason: `${sellReason}，情绪游资-极致胜率·${cycleLabel}腿（半仓）卖出`,
            returnRate: rawReturnRate != null ? round2(rawReturnRate * LEG_WEIGHT) : null,
            rawReturnRate,
          });
          positions[l] = null;
          legLastSellDate[l] = dateStr; // 该份卖出当日不再追买
        }
      }

      // ===== 买入 =====
      // 【顺周期腿】极致胜率逻辑：指数门禁（上证 3 日线分时斜率 > 0）+ 今日「强度分 − 差劲分 >= 30」取差值最大者
      if (!boughtProcyclicToday) {
        const legIdx = idleLegIdx();
        if (legIdx !== -1) {
          const idxMa3Slope = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
          if (Number(idxMa3Slope) > 0) {
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
                positions[legIdx].cycle = CYCLE_PRO;
                boughtProcyclicToday = true;
                for (const c of candidates) if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name || c.code });
              }
            }
          }
        }
      }

      // 【逆周期腿】反向抱团龙头逻辑：斜率连续为负 + 当日上证跌幅 ≥ 0.5% 时逐桶累计强度分命中，第 2 次命中且有空仓位即买
      if (eligibleRev && revCandidatesRaw.length > 0) {
        await ensureRevPoolData();
        const idxChg = idxChangeAt(bucketMinute);
        if (idxChg != null && idxChg <= REV_INDEX_DROP_PCT) {
          for (const c of revCandidatesRaw) {
            if (revDayTriggered.has(c.code)) continue;
            const t = revTodayTline.get(c.code);
            if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
            const s = strengthAtMinute(t, bucketMinute, c.code, idxPointsOf(c.code));
            if (!s || !(s.score > REV_STRENGTH_MIN)) continue;
            // 首次 > 50 → 登记当日命中（同一天同一只股票只计一次）
            revDayTriggered.add(c.code);
            const prev = revHitCount.get(c.code) || 0;
            const next = Math.min(prev + 1, REV_HIT_REQUIRED);
            revHitCount.set(c.code, next);
            // 第 2 次命中（或已达标后再次命中）的这一刻为买点；有空仓位且未涨停才买
            if (prev >= 1 && !boughtCounterToday && !s.limitUp) {
              const legIdx = idleLegIdx();
              if (legIdx !== -1) {
                const otherHeld = positions.filter((p, i) => i !== legIdx && p).map(p => p.code);
                if (!otherHeld.includes(c.code)) {
                  positions[legIdx] = buildRevPosition({
                    pick: c, s, score: s.score, px: s.px, changePct: s.changePct,
                    dateStr, dateDisplay, timeText, hitCount: next,
                    slopeClose, daysSinceTurnNeg, idxChg, legIdx, otherHeld,
                  });
                  positions[legIdx].buyDi = todayIdx;
                  positions[legIdx].cycle = CYCLE_COUNTER;
                  boughtCounterToday = true;
                  for (const cc of revCandidatesRaw) if (!seenStocks.has(cc.code)) seenStocks.set(cc.code, { code: cc.code, name: cc.name || cc.code });
                }
              }
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

// 构建顺周期腿持仓对象（含买入原因与死叉 / 差劲分 / 强度分诊断明细；legIdx = 所属份别，各半仓）
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
  const buyReason = `${timeText} 过去 ${DEATH_CROSS_WINDOW} 个交易日内出现死叉（${crossDate}）后，今日满足「强度分 − 差劲分 = ${delta} ≥ ${DELTA_MIN}」（死叉后第 ${hitCount + 1} 次达标，本策略只允许前 2 次），买入候选 ${pick.name}（${pick.code}，${pick.lianbanCount} 连板），触发时点价 ${pick.px.toFixed(2)}；本次建仓为顺周期腿（极致胜率，第 ${legIdx + 1} 份半仓 ${LEG_WEIGHT * 100}%）${otherHeld.length > 0 ? `，已排除另一腿当前持仓标的（${otherHeld.join('、')}）` : ''}`;
  const checks = [
    {
      id: 'extreme_win_pool',
      title: `选股（过去 ${LOOKBACK_DAYS} 个交易日四连板及以上；剔除创业板/科创板；剔除 ${EXCLUDED_THEMES.join('/')} 题材；过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 < ${MAX_WINDOW_RANGE_PCT}%；过去 ${RANGE_WINDOW_DAYS} 个交易日总涨幅 < ${MAX_TOTAL_RANGE_PCT}%；四连板后无单日涨幅 < ${POST_LIANBAN_DROP_PCT}%；无全量自选股科技股重叠）`,
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板`,
      reason: `候选 = 过去 ${LOOKBACK_DAYS} 个交易日内出现连板数 ≥ ${MIN_BOARD_COUNT} 的个股（命中日 ${pick.date}，板块 ${pick.board || '--'}）；已剔除 ST 等黑名单、创业板（30/301）与科创板（688）、${EXCLUDED_THEMES.join('/')} 题材（板块名包含关键词即剔除）与全量自选股科技股（isTech ≠ false）重叠者${pick.poolFilterText || ''}；本桶达标候选共 ${ranked.length} 只，按今日「强度分 − 差劲分」降序取第一个「未涨停且未被另一腿持有」者作为顺周期腿（第 ${legIdx + 1} 份半仓）建仓标的`,
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
    cycle: CYCLE_PRO,
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

// 构建逆周期腿持仓对象（反向抱团龙头口径；legIdx = 所属份别，各半仓；规则与独立「情绪游资-反向抱团龙头」完全一致）
const buildRevPosition = ({ pick, s, score, px, changePct, dateStr, dateDisplay, timeText, hitCount, slopeClose, daysSinceTurnNeg, idxChg, legIdx = 0, otherHeld = [] }) => {
  const chgText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const buyReason = `${timeText} 上证指数 3 日线斜率连续为负第 ${daysSinceTurnNeg + 1} 天（斜率 ${fmtKeyBlockSlope(slopeClose)}），当日上证跌幅 ${chgText(idxChg)} ≤ ${REV_INDEX_DROP_PCT}%，候选 ${pick.name}（${pick.code}，${pick.lianbanCount} 连板）盘中强度分第 ${hitCount} 次 > ${REV_STRENGTH_MIN}（本次强度分 ${score}），按该分钟分时价 ${px.toFixed(2)} 买入；本次建仓为逆周期腿（反向抱团龙头，第 ${legIdx + 1} 份半仓 ${LEG_WEIGHT * 100}%）${otherHeld.length > 0 ? `，已排除另一腿当前持仓标的（${otherHeld.join('、')}）` : ''}`;
  const checks = [
    {
      id: 'reverse_leader_pool',
      title: `选股（过去 ${REV_LOOKBACK_DAYS} 个交易日出现过连板数 ≥ ${REV_MIN_BOARD_COUNT} 的个股；过去 ${REV_RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${REV_RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 ≥ ${REV_MIN_WINDOW_RANGE_PCT}%）`,
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板`,
      reason: `候选 = 过去 ${REV_LOOKBACK_DAYS} 个交易日内出现过连板数 ≥ ${REV_MIN_BOARD_COUNT} 的个股（命中日 ${pick.date}，板块 ${pick.board || '--'}）；已剔除 ST 等黑名单与题材黑名单（${EXCLUDED_THEMES.join('/')}）；并叠加动量过滤——过去 ${REV_RANGE_WINDOW_DAYS} 个交易日（不含当日）内滑动「连续 ${REV_RANGE_SLIDE_DAYS} 个交易日」子窗口区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 ≥ ${REV_MIN_WINDOW_RANGE_PCT}%${pick.poolFilterText || ''}`,
    },
    {
      id: 'reverse_leader_index_neg',
      title: `买点前置：上证指数 3 日线斜率连续为负第 3 天及以后（转负当日为第 1 天）`,
      passed: true,
      value: `斜率 ${fmtKeyBlockSlope(slopeClose)}（连续为负第 ${daysSinceTurnNeg + 1} 天，≥ 第 ${REV_NEG_STREAK_MIN_DAYS + 1} 天）`,
      reason: `上证指数（${ICE_SIGNAL_INDEX_CODE}）3 日线斜率收盘口径 ${fmtKeyBlockSlope(slopeClose)} < 0，且已进入连续为负的第 ${daysSinceTurnNeg + 1} 天（转负当日算第 1 天，满足 ≥ ${REV_NEG_STREAK_MIN_DAYS + 1} 天）`,
    },
    {
      id: 'reverse_leader_index_drop',
      title: `买点前置：当日上证跌幅 ≥ 0.5%（较昨收 ≤ ${REV_INDEX_DROP_PCT}%）`,
      passed: true,
      value: `上证当日跌幅 ${chgText(idxChg)} ≤ ${REV_INDEX_DROP_PCT}%`,
      reason: `买入时点上证指数较昨收跌幅 ${chgText(idxChg)}，达到 ≤ ${REV_INDEX_DROP_PCT}% 门槛（按该桶指数分时价实时判定），符合「大盘走弱」的逆势低吸条件`,
    },
    {
      id: 'reverse_leader_strength',
      title: `买点判定：盘中强度分第 2 次 > ${REV_STRENGTH_MIN}（本次为第 ${hitCount} 次命中）`,
      passed: true,
      value: `A 竞价高开 ${s.aRaw}%（分 ${s.aScore}）· B 分钟最大涨幅 ${s.bRaw}%（分 ${s.bScore}）${s.isOneWord ? '（一字板）' : ''} · C 抗分歧 ${s.cRaw}（分 ${s.cScore}）· D 当日涨幅 ${s.dRaw}%（分 ${s.dScore}）`,
      reason: `强度分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${s.aScore} + 0.2×${s.bScore} + 0.3×${s.cScore} + 0.2×${s.dScore} = ${score} > ${REV_STRENGTH_MIN}（A 上限 ${STRENGTH_A_MAX}%、B 上限 ${STRENGTH_B_MAX}%、C 上限 ${STRENGTH_C_MAX}%、D 上限 ${STRENGTH_D_MAX}%；与「情绪游资-极致胜率」口径一致）；本股累计第 ${hitCount} 次命中（需达 ${REV_HIT_REQUIRED} 次），命中计数逐股独立累计、同一交易日同一只只计一次；时点价 ${px.toFixed(2)}（昨收 ${s.preclose}，现价涨幅 ${chgText(changePct)}）`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name,
    mode: 'offense',
    splitLeg: LEG_LABELS[legIdx],
    cycle: CYCLE_COUNTER,
    board: pick.board,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: timeText,
    buyPrice: round2(px),
    buyChange: round2(changePct),
    metric: score,
    weight: LEG_WEIGHT,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runExtremeWinBacktest };
