const { getKlineCached, loadIndexKline } = require('../deps');

const CYC_CORR_WINDOW = 20; // 相关性回看窗口（已完结交易日数）
const CYC_MIN_CYB_CORR = 0; // 相关系数需 > 该值（正相关）才算顺周期，否则逆周期

// Pearson 相关系数（要求至少 3 组样本；任一方差为 0 返回 null）
const pearsonCorr = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  return cov / Math.sqrt(vx * vy);
};

// 个股与创业板指最近 window 个已完结交易日的日收益率相关系数
// stockKline：getKlineCached 口径（trade_date / close_px）；cybBars：[{ d, c }] 升序（创业板指收盘）
const calcStockCybCorrelation = (stockKline, cybBars, dateStr, window = CYC_CORR_WINDOW) => {
  const target = parseInt(dateStr, 10);
  if (!Number.isFinite(target)) return null;
  const stockBars = (stockKline || [])
    .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
    .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px) }))
    .filter(b => b.d < target) // 只用已完结交易日，避免使用买入日（未来）数据
    .sort((a, b) => a.d - b.d);
  const idxByDate = new Map((cybBars || [])
    .filter(b => Number.isFinite(b.d) && Number.isFinite(b.c) && b.c > 0 && b.d < target)
    .map(b => [b.d, b.c]));
  const stockByDate = new Map(stockBars.map(b => [b.d, b.c]));
  // 以个股交易日为准取与指数共同的交易日，最近 window+1 个收盘价 → window 个日收益率
  const commonDates = stockBars.map(b => b.d).filter(d => idxByDate.has(d)).slice(-(window + 1));
  if (commonDates.length < window + 1) return null;
  const stockRet = [];
  const idxRet = [];
  for (let i = 1; i < commonDates.length; i++) {
    const sc = stockByDate.get(commonDates[i]);
    const sp = stockByDate.get(commonDates[i - 1]);
    const ic = idxByDate.get(commonDates[i]);
    const ip = idxByDate.get(commonDates[i - 1]);
    if (!(sp > 0) || !(ip > 0)) return null;
    stockRet.push((sc / sp - 1) * 100);
    idxRet.push((ic / ip - 1) * 100);
  }
  return pearsonCorr(stockRet, idxRet);
};

// 创业板指收盘序列（进程内缓存，首次拉取后复用）
const cycCorrCache = new Map(); // `${code}_${dateStr}` -> number|null（相关系数）
let cybCorrBarsPromise = null;
const getCybCorrBars = () => {
  if (!cybCorrBarsPromise) {
    cybCorrBarsPromise = (async () => {
      try {
        const kline = await loadIndexKline('cyb_kline.json', '399006', '32', 500);
        return (kline || [])
          .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
          .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px) }))
          .sort((a, b) => a.d - b.d);
      } catch (e) { return []; }
    })();
  }
  return cybCorrBarsPromise;
};

// 预取候选池「逆周期」代码集合（与创业板指负相关/零相关）：返回 Set<code>，供同步选股函数使用。
// 结果按 `${code}_${dateStr}` 进程内缓存（历史日K不可变，同窗口重复桶直接命中）；
// 数据不足（相关系数 null）的候选不入集合（放行不拦截）。
const buildCounterCycSet = async (codes, dateStr) => {
  const set = new Set();
  const cybBars = await getCybCorrBars();
  await Promise.all([...new Set(codes)].map(async (code) => {
    const key = `${code}_${dateStr}`;
    if (!cycCorrCache.has(key)) {
      let bars = null;
      try { bars = await getKlineCached(code, dateStr); } catch (e) { bars = null; }
      cycCorrCache.set(key, calcStockCybCorrelation(bars, cybBars, dateStr));
    }
    const corr = cycCorrCache.get(key);
    if (corr != null && corr <= CYC_MIN_CYB_CORR) set.add(code);
  }));
  return set;
};

// ============================================================
// 随机模拟注入：把「随机模拟测试」随机抽取的一批真实科技股混入当日回放候选池。
// 在加载回放数据后、构建 replayStocks / dailyInfos 之前调用：向每个时间桶的 stockChanges
// 追加这些股票的真实逐桶行情（真实分时 → 桶 minute 取价），并补齐 dailyLowByCode。
// 这些股票是真实 A 股（来自科技股清单），日K/分时/均线/抗分歧全部取自真实行情缓存，
// 与真实自选股完全同源，因此形态真实（不会出现合成数据的长影线等异常）。
// 注入股票在候选选股处跳过自选股添加时间门禁（见 passWatchlistGate）。
// ============================================================

module.exports = {
  CYC_CORR_WINDOW,
  CYC_MIN_CYB_CORR,
  buildCounterCycSet,
  calcStockCybCorrelation,
  cybCorrBarsPromise,
  cycCorrCache,
  getCybCorrBars,
  pearsonCorr,
};
