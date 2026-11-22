// 情绪周期-择时为主-N 日涨幅最大（2026-11-22 用户新增；仅回测；独立引擎 moodTimingBacktest.js）
//
// 买点：前一日科技情绪 < -40（情绪冰点），今日盘中分时科技情绪首次 > -20 的那个 5 分钟桶按该桶分时价买入。
// 选股：全量自选股中的科技股（isTech !== false）中最近 N 个交易日涨幅最大的一只；买点时刻已涨停则按涨幅
//       排名顺延下一只；每次买入均全仓（单持仓）。
// 卖点（买入次日起生效，满足其一即卖）：
//   ① 盘中现价跌破 10 日线（现价 < MA10）；
//   ② 高位放量大阴线（当日最高价回落到现价幅度 > 8%，且现价 < 当日开盘价）；
//   ③ 科技情绪指数 ≤ -40 且自选科技股中跌幅 ≤ -9% 的个股 ≥ 5 只；
//   ④ 自身抗分歧分数 < 6 且当前涨幅 ≤ -5%（仅 14:50 后生效，沿用现有卖点诊断条件4口径）；
//   ⑤ 现价跌破成本线 -3%（现价 < 买入价 × 0.97）。
const MOOD_TIMING_DESC = (days) => `情绪周期-择时为主-${days}日涨幅最大：前一日科技情绪 < -40（情绪冰点）时，今日盘中分时科技情绪首次 > -20 的时点，从全量自选科技股中买入最近 ${days} 个交易日涨幅最大的一只（买点时刻已涨停则按涨幅排名顺延下一只），全仓单持仓；卖点（买入次日起，满足其一即卖）：盘中现价跌破 10 日线、高位放量大阴线（最高回落 > 8% 且现价 < 开盘）、科技情绪指数 ≤ -40 且自选科技股中跌幅 ≤ -9% 的个股 ≥ 5 只、抗分歧 < 6 且涨幅 ≤ -5%（14:50 后生效）、跌破成本线 -3%`;

module.exports = {
  mood_timing_1d_gain: {
    id: 'mood_timing_1d_gain',
    name: '情绪周期-择时为主-1日涨幅最大',
    desc: MOOD_TIMING_DESC(1),
    moodTimingMode: true,
    moodTimingDays: 1,
  },
  mood_timing_2d_gain: {
    id: 'mood_timing_2d_gain',
    name: '情绪周期-择时为主-2日涨幅最大',
    desc: MOOD_TIMING_DESC(2),
    moodTimingMode: true,
    moodTimingDays: 2,
  },
  mood_timing_3d_gain: {
    id: 'mood_timing_3d_gain',
    name: '情绪周期-择时为主-3日涨幅最大',
    desc: MOOD_TIMING_DESC(3),
    moodTimingMode: true,
    moodTimingDays: 3,
  },
};
