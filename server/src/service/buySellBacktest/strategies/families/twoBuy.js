const { TWO_BUY_DESC, TWO_BUY_DIFF_BLOCK_DESC, TWO_BUY_DIFF_STOCK_DESC, TWO_BUY_HALF_DESC, TWO_BUY_SAME_DAY_DESC } = require('../descs');

module.exports = {

  // 两次买入（分批建仓）系列（highest_{N}d_gain_two_buy，2026-10-08 用户新增；twoBuy: true → 独立分批建仓逻辑）：
  // 买点首次触发买入 5 成（第一份），之后若买点再次触发、且距离第一份建仓日已间隔至少一个交易日，再买入 5 成（第二份）；
  // 第二份必须买入与第一份相同的股票标的；两份仓位各自独立买卖（各半仓），跌破成本线 -2% 止损（默认口径，不摊平成本）；
  // emoQuickOut: true → 叠加「快进快出」能力（情绪冰点/温和回升日买入的持仓次日 10:00 强卖 + 盘中跌破成本线 -2% 先到先卖）
  highest_2d_gain_two_buy: { id: 'highest_2d_gain_two_buy', name: '2日涨幅最大&两次买入', desc: TWO_BUY_DESC(2), twoBuy: true, emoQuickOut: true },
  highest_3d_gain_two_buy: { id: 'highest_3d_gain_two_buy', name: '3日涨幅最大&两次买入', desc: TWO_BUY_DESC(3), twoBuy: true, emoQuickOut: true },
  highest_4d_gain_two_buy: { id: 'highest_4d_gain_two_buy', name: '4日涨幅最大&两次买入', desc: TWO_BUY_DESC(4), twoBuy: true, emoQuickOut: true },
  highest_5d_gain_two_buy: { id: 'highest_5d_gain_two_buy', name: '5日涨幅最大&两次买入', desc: TWO_BUY_DESC(5), twoBuy: true, emoQuickOut: true },
  // 两次买入 × N.5 日窗口（2026-10-08 用户新增）
  highest_2d5_gain_two_buy: { id: 'highest_2d5_gain_two_buy', name: '2.5日涨幅最大&两次买入', desc: TWO_BUY_HALF_DESC(2), twoBuy: true, emoQuickOut: true, halfDayAfternoon: true },
  highest_3d5_gain_two_buy: { id: 'highest_3d5_gain_two_buy', name: '3.5日涨幅最大&两次买入', desc: TWO_BUY_HALF_DESC(3), twoBuy: true, emoQuickOut: true, halfDayAfternoon: true },
  // 两次买入 × 同一天（highest_3d_gain_two_buy_same_day，2026-10-20 用户新增、同日改版）：
  // 当日不再因买点二次触发补买第二份，改为 14:55 评估一次——当日盈利（14:55 分时价 vs 第一份买入价）
  // 超过 2% 且该股未涨停 → 尾盘按 14:55 价买入第二份 5 成；已涨停或盈利未达标 → 当日不补，
  // 等后续交易日买点再次触发时再买第二份；两份买入后成本线 = 两次买入价均值（统一成本线）
  // （twoBuySameDay: true → rangeBacktest/rangeBacktestMulti 执行尾盘补买与统一成本线；见 engine/twoBuy.js 说明）
  highest_3d_gain_two_buy_same_day: { id: 'highest_3d_gain_two_buy_same_day', name: '3日涨幅最大&两次买入（同一天）', desc: TWO_BUY_SAME_DAY_DESC(3), twoBuy: true, twoBuySameDay: true, emoQuickOut: true },
  // 两次买入 × 不同板块（highest_{N}d_gain_two_buy_diff_block，2026-10-08 用户新增）：
  // 第一份同「N日涨幅最大」（不限板块）；第二份在「板块（blockName）与第一份不同」的候选中重新按 N 日涨幅最大择股
  // diffBlock: true → 第二份改为限制板块差异的重新择股（见 runRangeBacktestInner / runRangeBacktestMulti）
  highest_2d_gain_two_buy_diff_block: { id: 'highest_2d_gain_two_buy_diff_block', name: '2日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(2), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_3d_gain_two_buy_diff_block: { id: 'highest_3d_gain_two_buy_diff_block', name: '3日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(3), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_4d_gain_two_buy_diff_block: { id: 'highest_4d_gain_two_buy_diff_block', name: '4日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(4), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_5d_gain_two_buy_diff_block: { id: 'highest_5d_gain_two_buy_diff_block', name: '5日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(5), twoBuy: true, diffBlock: true, emoQuickOut: true },
  // 两次买入 × 不同股（highest_{N}d_gain_two_buy_diff_stock，2026-10-23 用户新增）：
  // 第一份半仓买入 N 日涨幅最大；第二份在后续交易日买点再次触发时重新按 N 日涨幅最大择股——
  // 若仍为同一只股票则合并持有（成本线摊平 = 两次买入价均值，卖点按该均价判定；记录仍为两条独立交易、
  // 各自收益率按自身买入价计算）；若已变为另一只股票则买入该股票（两份独立买卖、独立成本线）
  // twoBuyDiffStock: true → 见 rangeBacktest / rangeBacktestMulti 与 engine/twoBuy.js
  highest_2d_gain_two_buy_diff_stock: { id: 'highest_2d_gain_two_buy_diff_stock', name: '2日涨幅最大&两次买入（不同股）', desc: TWO_BUY_DIFF_STOCK_DESC(2), twoBuy: true, twoBuyDiffStock: true, emoQuickOut: true },
  highest_3d_gain_two_buy_diff_stock: { id: 'highest_3d_gain_two_buy_diff_stock', name: '3日涨幅最大&两次买入（不同股）', desc: TWO_BUY_DIFF_STOCK_DESC(3), twoBuy: true, twoBuyDiffStock: true, emoQuickOut: true },
  highest_4d_gain_two_buy_diff_stock: { id: 'highest_4d_gain_two_buy_diff_stock', name: '4日涨幅最大&两次买入（不同股）', desc: TWO_BUY_DIFF_STOCK_DESC(4), twoBuy: true, twoBuyDiffStock: true, emoQuickOut: true },
};
