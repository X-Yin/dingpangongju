const { batchParallel, fs, getKlineCached } = require('../deps');
const { backtestCacheDir, getBacktestCacheFile } = require('../paths');


// ---------- 持仓交易日数（以项目根目录 YYYY交易日.json 交易日历为准）----------
// 持仓天数 = 卖出日相对买入日的交易日跨度（当日卖出为 0），自动剔除周末/法定节假日；
// 买卖日期所在年份超出日历覆盖范围时（如更早的历史区间）按周一~周五回退计数，
// 并以 holdingDaysApprox = true 标记为退化估算（前端显示 ≈）
const tradingDayUtil = require('../../../utils/tradingDay');
const normDateNum = (s) => String(s == null ? '' : s).replace(/-/g, '');

// 为回测结果就地补充持仓交易日数（trades / currentHolding / stocks[].trades / stocks[].holding）：
// holdingDays = 卖出日 - 买入日的交易日跨度；期末仍持仓的统计买入日至最近一个交易日（今日为交易日则含今日）；
// holdingDaysApprox = true 表示买卖日期所在年份未被交易日历覆盖、按周一~周五退化估算
const attachHoldingDays = (result) => {
  if (!result || typeof result !== 'object') return result;
  const now = new Date();
  const latest = tradingDayUtil.isTradingDay(now) ? now : tradingDayUtil.getPrevTradingDay(now);
  const latestTradingDayNum = Number(`${latest.getFullYear()}${String(latest.getMonth() + 1).padStart(2, '0')}${String(latest.getDate()).padStart(2, '0')}`);
  const calc = (buyDate, sellDate) => {
    const a = normDateNum(buyDate);
    const b = normDateNum(sellDate);
    if (!/^\d{8}$/.test(a) || !/^\d{8}$/.test(b) || b < a) return null;
    const days = tradingDayUtil.countTradingDaysBetween(a, b);
    if (days == null) return null;
    const approx = !tradingDayUtil.isYearCovered(a) || !tradingDayUtil.isYearCovered(b);
    return { days, approx };
  };
  const apply = (pos, open) => {
    if (!pos || !pos.buyDate) return;
    const r = open ? calc(pos.buyDate, latestTradingDayNum) : calc(pos.buyDate, pos.sellDate);
    if (!r) return;
    pos.holdingDays = r.days;
    pos.holdingDaysApprox = r.approx;
  };
  (result.trades || []).forEach(t => apply(t, false));
  apply(result.currentHolding, true);
  // 两次买入策略可能同时持有多份（currentHoldings），逐份注入持仓交易日数
  (result.currentHoldings || []).forEach(h => apply(h, true));
  (result.stocks || []).forEach(st => {
    (st.trades || []).forEach(t => apply(t, false));
    apply(st.holding, true);
  });
  // 交易列表统一按买入时间排序（旧缓存/旧报告生成顺序为平仓顺序，读取时归一）
  if (Array.isArray(result.trades)) result.trades = sortTradesByBuyTime(result.trades);
  (result.stocks || []).forEach(st => {
    if (Array.isArray(st.trades)) st.trades = sortTradesByBuyTime(st.trades);
  });
  // 平均持仓时间：仅统计已卖出成交（holdingDays 非空，不含期末仍持仓），保留 1 位小数；
  // 含退化估算（≈）的交易时在 summary.avgHoldingDaysApprox 标记
  const closedDays = [];
  let anyApprox = false;
  const collectClosed = (t) => {
    if (t && t.holdingDays != null) {
      closedDays.push(t.holdingDays);
      if (t.holdingDaysApprox) anyApprox = true;
    }
  };
  (result.trades || []).forEach(collectClosed);
  (result.stocks || []).forEach(st => (st.trades || []).forEach(collectClosed));
  if (result.summary && closedDays.length > 0) {
    result.summary.avgHoldingDays = Math.round((closedDays.reduce((a, b) => a + b, 0) / closedDays.length) * 10) / 10;
    result.summary.avgHoldingDaysApprox = anyApprox;
  }
  return result;
};

// ---------- 「买入当日收益」披露口径（2026-10-10 用户新增，全策略通用）----------
// 买入当日收益 =（买入当日收盘价 − 买入价）/ 买入价 × 100：披露「买入当天收盘时这笔持仓赚/亏多少」
//（例：8-4 上午 10:00 买入 → 该值 = 8-4 收盘价相对 10:00 买入价的涨跌幅）。
// 属事后披露指标、不参与任何买卖决策，也不做半仓折算（个股原始口径），故使用买入当日收盘价不构成前视；
// 收盘价取自买入日当日日K（getKlineCached 含当日）；停牌/无日K/无买入价时置 null，前端显示 --
const buyDayCloseCache = new Map(); // `${code}_${dateNum}` -> closePx | null
const getBuyDayClosePx = async (code, dateStr) => {
  const key = `${code}_${normDateNum(dateStr)}`;
  if (buyDayCloseCache.has(key)) return buyDayCloseCache.get(key);
  let closePx = null;
  try {
    const bars = await getKlineCached(code, dateStr);
    const target = parseInt(normDateNum(dateStr), 10);
    const bar = (bars || []).find(k => Number(k.trade_date) === target && Number(k.close_px) > 0);
    if (bar) closePx = Number(bar.close_px);
  } catch (e) { /* 日K缺失 → 置空 */ }
  buyDayCloseCache.set(key, closePx);
  return closePx;
};

// 为交易/持仓记录批量补写 buyDayClose / buyDayReturn（trades、currentHolding(s) 通用）
const attachBuyDayReturn = async (records) => {
  if (!Array.isArray(records) || records.length === 0) return records;
  await batchParallel(records, async (r) => {
    if (!r) return null;
    const buyPrice = Number(r.buyPrice);
    if (!r.buyDate || !(buyPrice > 0)) {
      r.buyDayClose = null;
      r.buyDayReturn = null;
      return null;
    }
    const closePx = await getBuyDayClosePx(r.code, r.buyDate);
    r.buyDayClose = closePx != null ? parseFloat(closePx.toFixed(2)) : null;
    r.buyDayReturn = (closePx != null && closePx > 0)
      ? parseFloat((((closePx - buyPrice) / buyPrice) * 100).toFixed(2))
      : null;
    return null;
  }, 8);
  return records;
};

// 交易列表按买入时间升序排序（买入日升序，同日按买入时间升序），并按新顺序重编 seq：
// 两次买入系列两份仓位独立平仓，成交记录生成顺序 = 平仓顺序（卖出时间序），
// 展示统一按买入时间排序更符合直觉（不影响收益/胜率/回撤等统计，均为顺序无关计算）
const sortTradesByBuyTime = (trades) => {
  if (!Array.isArray(trades)) return trades;
  return [...trades]
    .sort((a, b) => {
      const da = String(a?.buyDate ?? '');
      const db = String(b?.buyDate ?? '');
      if (da !== db) return da < db ? -1 : 1;
      const ta = String(a?.buyTime ?? '');
      const tb = String(b?.buyTime ?? '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return 0;
    })
    .map((t, idx) => ({ ...t, seq: idx + 1 }));
};

// 回撤统计（仅统计已卖出成交中收益率为负的单笔，returnRate 为百分数）：
//   avgDrawdown：亏损单笔的平均收益率（负值）；maxDrawdown：单笔最大回撤（最差一笔，负值）
// 无亏损成交时两者均为 null（前端展示 --）
const calcDrawdownStats = (trades) => {
  const losses = (Array.isArray(trades) ? trades : [])
    .map(t => Number(t?.returnRate))
    .filter(r => Number.isFinite(r) && r < 0);
  if (losses.length === 0) return { avgDrawdown: null, maxDrawdown: null };
  return {
    avgDrawdown: parseFloat((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)),
    maxDrawdown: parseFloat(Math.min(...losses).toFixed(2)),
  };
};

const readCachedBacktest = (strategy, startDate, endDate) => {
  try {
    const file = getBacktestCacheFile(strategy, startDate, endDate);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || data.range?.startDate !== startDate || data.range?.endDate !== endDate) return null;
    return attachHoldingDays(data); // 读取时统一注入持仓交易日数（缓存文件本身不落盘该字段，兼容旧缓存）
  } catch {
    return null;
  }
};

const writeCachedBacktest = (strategy, startDate, endDate, result) => {
  try {
    if (!fs.existsSync(backtestCacheDir)) fs.mkdirSync(backtestCacheDir, { recursive: true });
    fs.writeFileSync(getBacktestCacheFile(strategy, startDate, endDate), JSON.stringify(result, null, 2), 'utf-8');
  } catch (e) {
    console.error('回测结果缓存写入失败:', e.message);
  }
};

// ============================================================
// 机构研报覆盖索引：research_reports/menu.json（日期文件夹 → 报告标题/正文）
// 按自选股名称匹配报告标题或正文，统计每日每只股票的研报覆盖数
// ============================================================

module.exports = {
  attachBuyDayReturn,
  attachHoldingDays,
  buyDayCloseCache,
  calcDrawdownStats,
  getBuyDayClosePx,
  normDateNum,
  readCachedBacktest,
  sortTradesByBuyTime,
  tradingDayUtil,
  writeCachedBacktest,
};
