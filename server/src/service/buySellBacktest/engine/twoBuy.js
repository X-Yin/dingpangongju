const { fs, getMonitorStocks } = require('../deps');
const { stockBlockFilePath } = require('../paths');


// ============================================================
// 多日回测主循环
// ============================================================
// ===== 两次买入策略（highest_{N}d_gain_two_buy）公共逻辑 =====
// 重构版（2026-10-08 用户要求）：两份仓位各自独立买卖、独立计算收益，均按半仓权重 0.5 折算，互不摊平成本。
// 每份仓位就是一笔普通的「N日涨幅最大&快进快出」持仓——以自身买入价为成本（跌破成本线 -2% 止损），
// 各自走 emoquick/通用卖点、产生独立交易记录。
// 建仓约束：第一份按买点正常择股买入；第二份必须在第一份建仓之后的交易日（≥ 隔 1 天）触发买点时买入，
// 且必须是同一只股票（不重新择股）。
const TWO_BUY_LEG_WEIGHT = 0.5;

// 「两次买入（同一天）」尾盘补买第二份的当日盈利阈值（2026-10-20 用户改版）：
// 14:55 检查当日盈利（14:55 分时价 vs 第一份买入价）超过该百分比且未涨停 → 尾盘买入第二份 5 成
const TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT = 2;

// 「两次买入（同一天）」统一成本线（2026-10-20 用户改版）：两份仓位均在持时，
// 成本线 = 两次买入价的平均值（(买1 + 买2) ÷ 2），两份共用；仅剩一份或非本变体时返回 null
// （调用方回落到 pos.buyPrice 自身成本）。仅用于「跌破成本线 -2%」止损判定，
// 每份仓位的收益率仍按各自实际买入价计算。
const getUnifiedCostLinePrice = (pos, positions, strategy) => {
  if (!pos || strategy?.twoBuySameDay !== true || !Array.isArray(positions) || positions.length !== 2) return null;
  const mine = Number(pos.buyPrice);
  const other = positions.find(p => p && p !== pos && p.code === pos.code && Number(p.buyPrice) > 0);
  if (!Number.isFinite(mine) || mine <= 0 || !other) return null;
  return parseFloat(((mine + Number(other.buyPrice)) / 2).toFixed(2));
};

// 两次买入「不同板块」策略：取个股所属板块标识（自选股 monitor_stocks.json 的 blockName），
// 未记录板块的股票统一按「其他」处理；按文件 mtime 懒加载映射并缓存，避免逐候选重复读盘
let stockBlockCache = { mtimeMs: -1, map: new Map() };
const getStockBlockName = (code) => {
  try {
    const mtimeMs = fs.statSync(stockBlockFilePath).mtimeMs;
    if (mtimeMs !== stockBlockCache.mtimeMs) {
      const map = new Map();
      for (const s of getMonitorStocks() || []) {
        if (s && s.code) map.set(s.code, s.blockName || '其他');
      }
      stockBlockCache = { mtimeMs, map };
    }
  } catch (e) {
    // 读取失败：沿用上次映射（无映射时全部按「其他」）
  }
  return stockBlockCache.map.get(code) || '其他';
};

// 仓位权重（2026-10-13 泛化）：优先取挂到持仓上的 weight（两次买入 / 快进快出半仓等分批建仓），
// 缺省时按策略 twoBuy 兜底半仓、其余按全仓
const getPositionLegWeight = (pos, strategy) => {
  if (pos && pos.weight != null && Number.isFinite(Number(pos.weight))) return Number(pos.weight);
  return strategy && strategy.twoBuy === true ? TWO_BUY_LEG_WEIGHT : 1;
};

// 是否为「分批建仓」仓位（两次买入 / 快进快出半仓）：用于成交流水附加字段与明细展示
const isLegPosition = (pos, strategy) => (pos && pos.twoBuy === true) || (strategy && strategy.twoBuy === true);

// 组装两次买入某一份仓位在成交流水上追加的字段（半仓权重、个股原始收益率、所属份数 1/2）
const buildTwoBuyTradeExtra = (position) => ({
  twoBuy: true,
  leg: position?.leg ?? null,
  weight: TWO_BUY_LEG_WEIGHT,
  rawReturnRate: position?.rawReturnRate ?? null,
  avgPrice: position?.buyPrice ?? null,
  buyPrices: position?.buyPrice != null ? [position.buyPrice] : [],
  buyTimes: position?.buyTime != null ? [position.buyTime] : [],
  buyDates: position?.buyDate != null ? [position.buyDate] : [],
});

// 两次买入策略「整体收益率」按真实账户口径计算（2026-10-08 用户要求）：
// 资金从 1 起步，每轮买入半仓（第一份）+ 半仓（第二份）= 满仓；两份是「同时持有」的
// （第二份在第一份卖出前买入），故同一轮内两份的半仓收益应【相加】（合计占满仓，不产生复利放大），
// 只有【轮次之间】才复利——上一轮已实现收益成为下一轮的本金基数。
// 算法：把每一份仓位视为一段 [买入时刻, 卖出时刻] 区间（期末持仓以区间终点为卖出时刻），
// 按买入时刻排序后做区间合并：时间上重叠（含传递重叠）的份数归入同一轮，轮内收益相加、跨轮相乘。
// legs: [{ buyDate, buyTime, sellDate?, sellTime?, returnRate }]，returnRate 已按半仓折算（百分数）
const computeTwoBuyAccountReturn = (legs) => {
  const items = [];
  for (const l of legs) {
    if (!l) continue;
    const rate = l.returnRate != null && Number.isFinite(Number(l.returnRate)) ? Number(l.returnRate) : null;
    if (rate == null) continue;
    items.push({
      start: `${l.buyDate || ''}${l.buyTime || ''}`,
      // 期末持仓无卖出时刻：视为持有到回测结束（区间终点取最大）
      end: l.sellDate ? `${l.sellDate}${l.sellTime || '99:99'}` : '99999999999999',
      rate,
    });
  }
  items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let overall = 1;
  let groupRate = 0;
  let groupEnd = null;
  for (const it of items) {
    if (groupEnd != null && it.start <= groupEnd) {
      // 与当前轮已有持仓时间重叠 → 归入同一轮，收益相加
      groupRate += it.rate;
      if (it.end > groupEnd) groupEnd = it.end;
    } else {
      // 新一轮：先把上一轮收益复利进总资金
      if (groupEnd != null) overall *= 1 + groupRate / 100;
      groupRate = it.rate;
      groupEnd = it.end;
    }
  }
  if (groupEnd != null) overall *= 1 + groupRate / 100;
  return parseFloat(((overall - 1) * 100).toFixed(2));
};


module.exports = {
  TWO_BUY_LEG_WEIGHT,
  TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT,
  buildTwoBuyTradeExtra,
  computeTwoBuyAccountReturn,
  getUnifiedCostLinePrice,
  getPositionLegWeight,
  getStockBlockName,
  isLegPosition,
  stockBlockCache,
};
