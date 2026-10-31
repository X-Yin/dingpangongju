// ============================================================
// 「情绪游资-反向抱团龙头」（逆周期腿）候选池 公共模块
//   从 reverseLeaderBacktest.js / extremeWinBacktest.js 两处重复实现中抽取，
//   供「回测引擎」与「开盘实战页 live 反向抱团列表」共用同一份实现，避免口径漂移
//   （2026-10-17 用户要求：龙头列表拆上下两部分，下半部分为反向抱团逆周期）。
//   候选池口径（与两处回测引擎逐字节一致）：
//     getRecentMultiLianbanStocks(dateStr, 20, 2) → 剔除 ST 等黑名单 / 创业板(30/301) / 科创板(688) / 题材黑名单
//     → 过去 20 个交易日（不含当日）内任意连续 10 个交易日子窗口区间最大涨幅 ≥ 60%
//   注意：本函数「无条件」构建候选池（不看择时门禁），择时状态由调用方自行判定/
//     回测引擎仍在各自 eligible 门禁内调用（保持回测结果不变）。
// ============================================================
const {
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  stockDailyChange,
} = require('../deps');
const { EXCLUDED_CODES, EXCLUDED_THEMES, isExcludedTheme } = require('../constants');
// 复用顺周期腿已抽出的工具函数（候选池剔除创业板/科创板、滑动窗口区间涨幅）
const { isChiNextOrStar, maxSlidingWindowRangePct } = require('./extremeWinPool');

// ---- 选股与择时常量（与两个回测引擎完全一致）----
const LOOKBACK_DAYS = 20;          // 选股回溯窗口：过去 20 个交易日
const MIN_BOARD_COUNT = 2;         // 连板门槛：二连板及以上（出现过连板）
const RANGE_WINDOW_DAYS = 20;      // 动量窗口：过去 20 个交易日（不含当日）
const RANGE_SLIDE_DAYS = 10;       // 滑动子窗口：连续 10 个交易日
const MIN_WINDOW_RANGE_PCT = 60;   // 子窗口区间最大涨幅门槛：>= 60%
const NEG_STREAK_MIN_DAYS = 2;     // 斜率连续为负第 3 天起（daysSinceTurnNeg >= 2）才允许执行
const INDEX_DROP_PCT = -0.5;       // 买点前置：上证当日跌幅 >= 0.5%（较昨收 <= -0.5%）
const STRENGTH_MIN = 50;           // 命中门槛：盘中强度分 > 50
const HIT_REQUIRED = 2;            // 需要累计 2 次命中
// 2026-10-31 用户要求（回测与线上实盘同口径）：最近 10 个交易日内收盘跌幅 < -9% 的交易日不可超过 2 次
// （不要求连续，只统计频次；第 3 次即从候选池剔除）
const BIG_DROP_WINDOW_DAYS = 10;
const BIG_DROP_THRESHOLD = -9;
const BIG_DROP_MAX_TIMES = 2;

// 逆周期买点前置（收盘口径）：上证 3 日线斜率 < 0 且已进入连续为负的第 3 天及以后
const isReverseEligible = (slopeClose, daysSinceTurnNeg) => slopeClose != null && slopeClose < 0
  && daysSinceTurnNeg != null && daysSinceTurnNeg >= NEG_STREAK_MIN_DAYS;

// 构建逆周期（反向抱团龙头）候选池（给定交易日 dateStr，不含当日）：
//   getRecentMultiLianbanStocks(dateStr, 20, 2) → 剔除 ST 等黑名单 / 创业板(30/301) / 科创板(688) / 题材黑名单
//   → 过去 20 个交易日（不含当日）任意连续 10 个交易日子窗口区间最大涨幅 >= 60%
// filterCodes：可选代码集合（Set）；提供时仅保留其中的代码（供 live 按历史交易日重建「当日池 ∩ 关注代码」使用）
// opts.bigDropMaxTimes：可选——最近 BIG_DROP_WINDOW_DAYS 个交易日内收盘跌幅 < BIG_DROP_THRESHOLD%
//   的交易日最多允许出现该次数，超出则剔除；不传时不做该过滤（回测与线上实盘均传入 BIG_DROP_MAX_TIMES，口径一致）
// 返回 { stocks, poolFilterText, winDates }
const buildReverseLeaderPool = async (dateStr, filterCodes = null, opts = {}) => {
  const bigDropMaxTimes = opts.bigDropMaxTimes != null ? Number(opts.bigDropMaxTimes) : null;
  let base = [];
  let themeFilterText = '';
  try {
    const info = await getRecentMultiLianbanStocks(dateStr, LOOKBACK_DAYS, MIN_BOARD_COUNT);
    // 候选池沿用「情绪游资-极致胜率」的题材黑名单，整体剔除 PCB/玻璃基板/光模块/液冷/通信/
    // 算力/芯片/靶材/电子气体/光刻胶/算力租赁/元器件/黄金/中报增长/次新股 题材（板块名包含关键词即剔除，覆盖派生板块名，如「通信(PCB)」）
    const themeRemoved = [];
    base = (info.stocks || []).filter(s => {
      if (filterCodes && !filterCodes.has(s.code)) return false;
      if (EXCLUDED_CODES.has(s.code)) return false;
      // 候选池一律剔除创业板（30/301）与科创板（688）
      if (isChiNextOrStar(s.code)) return false;
      if (isExcludedTheme(s.board)) { themeRemoved.push(s); return false; }
      return true;
    });
    if (themeRemoved.length > 0) {
      themeFilterText = `；题材黑名单（${EXCLUDED_THEMES.join('、')}）剔除 ${themeRemoved.length} 只（${themeRemoved.map(s => `${s.name || s.code}（${s.board}）`).join('、')}）`;
    }
  } catch (e) {
    return { stocks: [], poolFilterText: '', winDates: [] };
  }

  let winDates = [];
  try { winDates = await getPastTradingDates(dateStr, RANGE_WINDOW_DAYS); } catch (e) { winDates = []; }

  let poolFilterText = '';
  let candidates = [];
  if (base.length > 0) {
    try { await ensureBarsForCodes(new Set(base.map(s => s.code))); } catch (e) { /* 拉取失败按数据缺失处理 */ }
    if (winDates.length >= RANGE_WINDOW_DAYS) {
      const before = base.length;
      const recentDates = bigDropMaxTimes == null ? [] : winDates.slice(-BIG_DROP_WINDOW_DAYS);
      let bigDropRemoved = 0;
      candidates = base.filter(s => {
        const rp = maxSlidingWindowRangePct(s.code, winDates, RANGE_SLIDE_DAYS);
        // 区间振幅缺失（日K未覆盖）视为不达标
        if (rp == null || !Number.isFinite(rp) || rp < MIN_WINDOW_RANGE_PCT) return false;
        if (bigDropMaxTimes != null) {
          let bigDropCount = 0;
          for (const d of recentDates) {
            const chg = stockDailyChange(s.code, d);
            if (chg != null && Number.isFinite(chg) && chg < BIG_DROP_THRESHOLD) bigDropCount += 1;
          }
          if (bigDropCount > bigDropMaxTimes) { bigDropRemoved += 1; return false; }
        }
        return true;
      });
      const bigDropText = bigDropMaxTimes == null
        ? ''
        : `，且最近 ${BIG_DROP_WINDOW_DAYS} 个交易日（不含当日）收盘跌幅 < ${BIG_DROP_THRESHOLD}% 的交易日 ≤ ${bigDropMaxTimes} 次（不要求连续、只计频次；第 ${bigDropMaxTimes + 1} 次起剔除${bigDropRemoved > 0 ? `，剔除 ${bigDropRemoved} 只` : ''}）`;
      poolFilterText = `${themeFilterText}；过去 ${RANGE_WINDOW_DAYS} 个交易日（不含当日）内任意连续 ${RANGE_SLIDE_DAYS} 个交易日区间最大涨幅 (最高收盘价 − 最低收盘价) ÷ 最低收盘价 ≥ ${MIN_WINDOW_RANGE_PCT}%${bigDropText} 保留 ${candidates.length}/${before} 只`;
    } else {
      poolFilterText = `${themeFilterText}；过去 ${RANGE_WINDOW_DAYS} 个交易日日K数据不足，本日无候选`;
    }
  }

  for (const s of candidates) s.poolFilterText = poolFilterText;
  return { stocks: candidates, poolFilterText, winDates };
};

module.exports = {
  LOOKBACK_DAYS, MIN_BOARD_COUNT, RANGE_WINDOW_DAYS, RANGE_SLIDE_DAYS, MIN_WINDOW_RANGE_PCT,
  NEG_STREAK_MIN_DAYS, INDEX_DROP_PCT, STRENGTH_MIN, HIT_REQUIRED,
  BIG_DROP_WINDOW_DAYS, BIG_DROP_THRESHOLD, BIG_DROP_MAX_TIMES,
  isReverseEligible, buildReverseLeaderPool,
};
