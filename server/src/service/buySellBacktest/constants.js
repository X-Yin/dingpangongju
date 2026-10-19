const SELL_CONDITION_PERSIST_MIN = 5; // 卖出条件持续满足分钟数

// 回测排除的股票（不参与任何策略的回测）
const EXCLUDED_CODES = new Set(['sh688498', 'sh688808']); // 源杰科技、联讯仪器

// 候选池题材黑名单（2026-10-17 用户新增；「情绪游资-极致胜率」与「情绪游资-反向抱团龙头」共用同一份）：
// 板块名包含关键词即剔除，以覆盖派生板块名——如「PCB 上游/概念/并购」「通信(PCB)」「光模块上游/高速光模块发布」
// 「液冷散热/服务器/算力(液冷)」「芯片(玻璃基板)」等；2026-10-17 追加 靶材 / 电子气体 / 光刻胶 / 算力租赁
const EXCLUDED_THEMES = ['PCB', '玻璃基板', '光模块', '液冷', '通信', '算力', '芯片', '靶材', '电子气体', '光刻胶', '算力租赁'];
const isExcludedTheme = (board) => {
  const b = String(board || '').toUpperCase();
  if (!b) return false;
  return EXCLUDED_THEMES.some((t) => b.includes(t.toUpperCase()));
};
// 快进快出系列「上一交易日科技情绪 3 日 EMA」阈值（2026-10-19 用户改：-60 → -30）：
// 触发买点时取上一交易日科技情绪指数的 3 日 EMA（getTechEmotionEmaMap，与情绪页「三日均值」曲线同源同算法），
// 低于该阈值 → 本次买入标记为「快进快出」（次日 10:00 强制卖出）
const EMO_SWITCH_EMA_THRESHOLD = -30;
// 快进快出「温和回升」触发区间（2026-10-19 用户改：(-30, 20) → (-30, -10)）：
// 上上个、上个交易日的当日科技情绪原始分（非 3 日 EMA）均需严格处于该开区间且逐日回升
const EMO_QUICK_RANGE_LOW = -30;
const EMO_QUICK_RANGE_HIGH = -10;
// 快进快出系列「盘中大跌强卖」阈值（2026-10-15 用户新增）：持仓个股盘中当日跌幅（较昨收涨跌幅）
// ≤ 该阈值时无条件卖出（无持续分钟、无竞价自救窗口、不受强卖豁免保护），与成本线止损 / 10:00 强卖先到先卖。
// 适用于 emoquick 系列策略的全部持仓（含非快进快出的普通持仓与强卖豁免后的持仓），仅回测生效（实盘诊断暂不加）
const EMO_QUICK_CRASH_PCT = -7;

// 检查4「开盘后自选科技股低于开盘价」按比例收紧（2026-10-19 用户定，取代原「创业板指斜率负时固定收紧为 15」）：
// 适用范围（24 个）= 快进快出（emoQuickOut）7 个 + 纯「N 日涨幅最大」7 个 + 两次买入 6 个 + 两次买入不同板块 4 个。
// 这些策略的阈值 = ceil(参与计数的科技股数 × 25%)（向上取整，如 90 只科技股 → 23），其余策略保持固定 30 只。
// 「参与计数的科技股数」= 当桶自选股中 isTech !== false 且当日开盘涨幅数据存在的只数（即诊断明细 value 的「X / N只」里的 N）
const OPENING_BELOW_RATIO = 0.25;
const OPENING_BELOW_RATIO_STRATEGY_IDS = new Set([
  // 快进快出（emoQuickOut）
  'highest_2d_gain_emoquick',
  'highest_3d_gain_emoquick',
  'highest_4d_gain_emoquick',
  'highest_5d_gain_emoquick',
  'highest_2d5_gain_emoquick',
  'highest_3d5_gain_emoquick',
  'highest_3d_reports_top5_gain_emoquick',
  // 纯「N 日涨幅最大」
  'highest_2d_gain',
  'highest_3d_gain',
  'highest_4d_gain',
  'highest_5d_gain',
  'highest_10d_gain',
  'highest_2d5_gain',
  'highest_3d5_gain',
  // 两次买入
  'highest_2d_gain_two_buy',
  'highest_3d_gain_two_buy',
  'highest_4d_gain_two_buy',
  'highest_5d_gain_two_buy',
  'highest_2d5_gain_two_buy',
  'highest_3d5_gain_two_buy',
  // 两次买入不同板块
  'highest_2d_gain_two_buy_diff_block',
  'highest_3d_gain_two_buy_diff_block',
  'highest_4d_gain_two_buy_diff_block',
  'highest_5d_gain_two_buy_diff_block',
]);

module.exports = {
  EMO_QUICK_CRASH_PCT,
  EMO_QUICK_RANGE_HIGH,
  EMO_QUICK_RANGE_LOW,
  EMO_SWITCH_EMA_THRESHOLD,
  EXCLUDED_CODES,
  EXCLUDED_THEMES,
  OPENING_BELOW_RATIO,
  OPENING_BELOW_RATIO_STRATEGY_IDS,
  isExcludedTheme,
  SELL_CONDITION_PERSIST_MIN,
};
