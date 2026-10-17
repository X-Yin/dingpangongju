const path = require('path');

// 数据目录：原文件位于 service/ 下用 '../data'，本文件位于 service/buySellBacktest/ 下需上溯两级
const DATA_DIR = path.resolve(__dirname, '../../data');

// 回测结果缓存文件（按 策略+日期范围 存储，避免重复回测）
const backtestCacheDir = path.join(DATA_DIR, 'backtest_results');
const getBacktestCacheFile = (strategy, startDate, endDate) => path.join(backtestCacheDir, `backtest_${strategy}_${startDate}_${endDate}.json`);

// 回测结果缓存版本：买入/卖出规则一旦变更，必须把对应策略的版本号 +1，
// 否则 readCachedBacktest 仍会命中「旧规则」算出的结果（时间伸缩测试、回测报告都会读到过期数据）。
// 版本号随结果一起落盘，读取时校验；不匹配即视为未命中并重跑（旧文件会被同名的重跑结果覆盖）。
// 只影响列在这里的策略，其余策略沿用默认版本 1（无需清理即可自动失效）。
const CACHE_VERSION_BY_STRATEGY = {
  // v9（2026-10-17）：移除卖点「上证指数竞价低开 < -0.5% → 9:30 直接卖」（共享模块 leaderSellMinute）
  // v8（2026-10-17）：仓位B 候选池由「上一交易日涨停数前二板块」扩大为「前两个交易日各自涨停数前二板块」的并集
  // v7（2026-10-17）：去掉仓位B「只打二板」限制（候选池不再按连板数过滤）
  // v6（2026-10-17）：仓位B 开盘后前 5 分钟不买（最早 9:35 出手），且出手前复核上证 3 日线实时斜率须为正、否则当天不买
  // v5（2026-10-17）：仓位B 候选池「只打二板」（仅取上一交易日首板、连板数 = 1）；卖点新增⑩「盘中 1 分钟内跳水 ≤ -3%」
  // v4（2026-10-17）：仓位B 候选池剔除「其他」「并购重组」板块，并在剩余板块中顺延取前二
  // v3（2026-10-17）：仓位A 沿用龙头战法买点，买入门槛同步收紧（当日实时涨幅 < -5% 不买）
  // v2（2026-10-16）：仓位B 候选池新增「过去 20 个交易日区间涨幅 (最高价−最低价)÷最低价 < 40%」过滤
  hot_money_precise_timing: 9,
  // v4（2026-10-17）：移除卖点「上证指数竞价低开 < -0.5% → 9:30 直接卖」（共享模块 leaderSellMinute）
  // v3（2026-10-17）：卖点新增⑩「盘中 1 分钟内跳水 ≤ -3%」（共享模块 leaderSellMinute 扩展）
  // v2（2026-10-17）：龙头战法买入门槛由 -8% 收紧为 -5%（当日实时涨幅 < -5% 不买）
  hot_money_leader: 4,
  hot_money_leader_tech_emoquick: 4,
  tech_emoquick_hot_money_leader: 4,
  // v13（2026-10-17）：选股新增「四连板之后出现过单日涨幅 < -6% 则剔除」过滤
  // v12（2026-10-17）：区间最大涨幅过滤窗口由 10 个交易日改为 20 个交易日
  // v11（2026-10-17）：买点前置——死叉后 delta ≥ 30 的交易日数须 ≤ 1（只允许第一次或第二次达标，≥2 天视为已消耗）
  // v10（2026-10-17）：选股叠加「过去 10 个交易日区间最大涨幅 (最高价−最低价)÷最低价 < 80%」过滤
  // v9（2026-10-17）：强度分新增 D 项「当日涨幅」（权重 0.2，从 A 竞价高开 / B 单分钟最大涨幅各扣 0.1；涨幅<0 记 0 分、涨幅≥0 按 10% 归一）
  // v8（2026-10-17）：差劲分 D 项——跌停日整个差劲分直接封顶 100
  // v7（2026-10-17）：差劲分 D 项改口径——当日触及涨停价取炸板次数，未涨停改用跌幅（涨幅≥0 记 0 分，跌幅按 -10% 归一，跌停记满 100）
  // v6（2026-10-17）：候选池剔除创业板 30/301 与科创板 688；卖点①成本线止损改为「现价 < 买入价即卖」（0%、不设持续分钟）
  // v5（2026-10-17）：移除卖点「上证指数竞价低开 < -0.5% → 9:30 直接卖」（共享模块 leaderSellMinute）
  // v4（2026-10-17）：买点新增指数门禁「上证指数（sh000001）3 日线分时斜率为正」才可买入，否则该桶跳过
  // v3（2026-10-17）：选股改为「过去 10 个交易日四连板及以上」；买点改为「过去 10 日出现死叉（强度分由高于差劲分转为一度低于差劲分）且死叉后未提前达标，今日盘中首次 强度分−差劲分 ≥ 30」（差劲分/强度分改为当日实时口径）
  // v2（2026-10-17）：卖点新增⑩「盘中 1 分钟内跳水 ≤ -3%」（共享模块 leaderSellMinute 扩展）
  hot_money_extreme_win: 13,
};
const getBacktestCacheVersion = (strategy) => CACHE_VERSION_BY_STRATEGY[strategy] || 1;

// 研报目录
const researchReportsDir = path.join(DATA_DIR, 'research_reports');

// 科技情绪指数文件
const TECH_INDEX_FILE = path.join(DATA_DIR, 'tech_index.json');

// 自选股（板块名映射）文件
const stockBlockFilePath = path.join(DATA_DIR, 'monitor_stocks.json');

module.exports = { DATA_DIR, backtestCacheDir, getBacktestCacheFile, getBacktestCacheVersion, researchReportsDir, TECH_INDEX_FILE, stockBlockFilePath };
