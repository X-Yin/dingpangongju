const { TWO_BUY_DESC, TWO_BUY_DIFF_BLOCK_DESC, TWO_BUY_HALF_DESC } = require('../descs');

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
  // 两次买入 × 不同板块（highest_{N}d_gain_two_buy_diff_block，2026-10-08 用户新增）：
  // 第一份同「N日涨幅最大」（不限板块）；第二份在「板块（blockName）与第一份不同」的候选中重新按 N 日涨幅最大择股
  // diffBlock: true → 第二份改为限制板块差异的重新择股（见 runRangeBacktestInner / runRangeBacktestMulti）
  highest_2d_gain_two_buy_diff_block: { id: 'highest_2d_gain_two_buy_diff_block', name: '2日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(2), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_3d_gain_two_buy_diff_block: { id: 'highest_3d_gain_two_buy_diff_block', name: '3日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(3), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_4d_gain_two_buy_diff_block: { id: 'highest_4d_gain_two_buy_diff_block', name: '4日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(4), twoBuy: true, diffBlock: true, emoQuickOut: true },
  highest_5d_gain_two_buy_diff_block: { id: 'highest_5d_gain_two_buy_diff_block', name: '5日涨幅最大&两次买入不同板块', desc: TWO_BUY_DIFF_BLOCK_DESC(5), twoBuy: true, diffBlock: true, emoQuickOut: true },
};
