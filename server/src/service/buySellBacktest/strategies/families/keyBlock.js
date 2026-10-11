const { KEY_BLOCK_DESC } = require('../descs');

module.exports = {
  // 重点板块-N日最高涨幅系列（keyBlockDays → 独立板块驱动回测 runKeyBlockBacktest：斜率双模式 + tag 板块选股，触发桶买入）
  key_block_2d_gain: { id: 'key_block_2d_gain', name: '重点板块-2日最高涨幅', desc: KEY_BLOCK_DESC(2), keyBlockDays: 2, costLinePct: 2 },
  key_block_3d_gain: { id: 'key_block_3d_gain', name: '重点板块-3日最高涨幅', desc: KEY_BLOCK_DESC(3), keyBlockDays: 3, costLinePct: 2 },
  key_block_4d_gain: { id: 'key_block_4d_gain', name: '重点板块-4日最高涨幅', desc: KEY_BLOCK_DESC(4), keyBlockDays: 4, costLinePct: 2 },
  key_block_5d_gain: { id: 'key_block_5d_gain', name: '重点板块-5日最高涨幅', desc: KEY_BLOCK_DESC(5), keyBlockDays: 5, costLinePct: 2 },
};
