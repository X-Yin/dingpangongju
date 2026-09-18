// 训练营 - 买卖点回测报告
// 报告由多个策略（STRATEGIES，全量自选股策略已移除）在相同日期范围的回测结果汇总而成，
// 按整体收益（overallReturn）从高到低排名。报告缓存最近 MAX_REPORTS 次到 data/backtest_reports。
// 生成方式：
//   - fromCacheOnly=true ：仅读已有回测缓存，不重新回测（用于启动时/最新无报告时快速生成）
//   - fromCacheOnly=false：逐策略重新回测（用于周六自动任务与「重新生成最新报告」）
const fs = require('fs');
const path = require('path');
const { getTrainingCampDates } = require('./trainingCamp');
const { STRATEGIES, readCachedBacktest, runRangeBacktest } = require('./buySellBacktest');

const reportsDir = path.join(__dirname, '../data/backtest_reports');
const backtestCacheDir = path.join(__dirname, '../data/backtest_results');
const MAX_REPORTS = 5;
const REPORT_DAYS = 60; // 过去 60 个交易日

// 过去 REPORT_DAYS 个交易日的日期范围（以最新可用回放交易日为 endDate）
const getDefaultReportRange = () => {
  const sorted = [...getTrainingCampDates()].sort(); // 升序
  if (sorted.length === 0) return null;
  const endDate = sorted[sorted.length - 1];
  const startDate = sorted[Math.max(0, sorted.length - REPORT_DAYS)];
  return { startDate, endDate };
};

// 扫描现有回测缓存，找出被当前所有策略共享的日期范围（用于无报告时从缓存快速生成）
const getCommonCachedRange = () => {
  try {
    if (!fs.existsSync(backtestCacheDir)) return null;
    const files = fs.readdirSync(backtestCacheDir);
    const ids = Object.keys(STRATEGIES);
    // 对每个策略，收集其缓存文件对应的 (startDate, endDate)
    const rangeMap = new Map(); // `${start}_${end}` -> { start, end, count }
    for (const f of files) {
      const m = String(f).match(/^backtest_(.+)_(\d{8})_(\d{8})\.json$/);
      if (!m) continue;
      const sid = m[1];
      if (!STRATEGIES[sid]) continue;
      const key = `${m[2]}_${m[3]}`;
      const entry = rangeMap.get(key) || { start: m[2], end: m[3], count: 0 };
      entry.count += 1;
      rangeMap.set(key, entry);
    }
    let best = null;
    for (const entry of rangeMap.values()) {
      if (entry.count >= ids.length && (!best || entry.start > best.start)) best = entry;
    }
    return best;
  } catch {
    return null;
  }
};

// 读取某策略某范围的结果：优先命中缓存，否则视 fromCacheOnly 决定是否现场回测
const getStrategyResult = async (strategyId, startDate, endDate, fromCacheOnly) => {
  const cached = readCachedBacktest(strategyId, startDate, endDate);
  if (cached) return cached;
  if (fromCacheOnly) return null;
  return runRangeBacktest(startDate, endDate, strategyId);
};

// 生成一份回测报告（可持久化）
const generateReport = async ({ startDate, endDate, fromCacheOnly = false, onProgress } = {}) => {
  const range = (startDate && endDate) ? { startDate, endDate } : getDefaultReportRange();
  if (!range) return { success: false, message: '无可用回放交易日' };

  const ids = Object.keys(STRATEGIES);
  const total = ids.length;
  const strategies = [];
  const skipped = [];

  for (let i = 0; i < total; i++) {
    const id = ids[i];
    if (onProgress) onProgress({ current: i, total, strategy: STRATEGIES[id].name, status: 'running' });
    let result;
    try {
      result = await getStrategyResult(id, range.startDate, range.endDate, fromCacheOnly);
    } catch (e) {
      skipped.push({ strategy: id, message: e.message || '回测失败' });
      continue;
    }
    if (!result || !result.success) {
      skipped.push({ strategy: id, message: result?.message || '回测失败' });
      continue;
    }
    const sum = result.summary || {};
    strategies.push({
      rank: 0, // 排名占位，随后统一计算
      id: result.strategy?.id || id,
      name: result.strategy?.name || STRATEGIES[id].name,
      desc: result.strategy?.desc || STRATEGIES[id].desc,
      summary: {
        tradeCount: sum.tradeCount || 0,
        winCount: sum.winCount || 0,
        winRate: sum.winRate != null ? Number(sum.winRate) : null,
        overallReturn: sum.overallReturn != null ? Number(sum.overallReturn) : null,
        holding: !!sum.holding,
      },
      trades: (result.trades || []).map((t, idx) => ({
        seq: t.seq != null ? t.seq : idx + 1,
        code: t.code,
        stockName: t.stockName,
        metric: t.metric ?? null,
        buyDate: t.buyDate,
        buyDateDisplay: t.buyDateDisplay,
        buyTime: t.buyTime,
        buyPrice: t.buyPrice,
        buyChange: t.buyChange,
        buyReason: t.buyReason ?? null,
        buyChecks: t.buyChecks ?? null,
        sellDate: t.sellDate,
        sellDateDisplay: t.sellDateDisplay,
        sellTime: t.sellTime,
        sellPrice: t.sellPrice,
        sellChange: t.sellChange,
        sellReason: t.sellReason,
        returnRate: t.returnRate,
      })),
      currentHolding: result.currentHolding ? {
        code: result.currentHolding.code,
        stockName: result.currentHolding.stockName,
        metric: result.currentHolding.metric ?? null,
        buyDate: result.currentHolding.buyDate,
        buyTime: result.currentHolding.buyTime,
        buyPrice: result.currentHolding.buyPrice,
        buyChange: result.currentHolding.buyChange,
        buyReturn: result.currentHolding.buyReturn,
        buyReason: result.currentHolding.buyReason ?? null,
        buyChecks: result.currentHolding.buyChecks ?? null,
      } : null,
    });
  }

  // 按整体收益从高到低排名；收益缺失（null）排在最后
  strategies.sort((a, b) => {
    const ra = a.summary.overallReturn == null ? -Infinity : a.summary.overallReturn;
    const rb = b.summary.overallReturn == null ? -Infinity : b.summary.overallReturn;
    return rb - ra;
  });
  strategies.forEach((s, idx) => { s.rank = idx + 1; });

  const report = {
    id: `report_${Date.now()}`,
    createdAt: new Date().toISOString(),
    range: { startDate: range.startDate, endDate: range.endDate },
    strategyCount: strategies.length,
    skipped,
    generatedFromCache: fromCacheOnly,
    strategies,
  };
  saveReport(report);
  return { success: true, report };
};

// 最近一次报告；无报告时尝试从现有回测缓存快速生成一份（不重新回测）
const ensureLatestReport = async () => {
  const latest = getLatestReport();
  if (latest) return { success: true, report: latest };
  const cachedRange = getCommonCachedRange();
  if (cachedRange) return generateReport({ startDate: cachedRange.start, endDate: cachedRange.end, fromCacheOnly: true });
  return generateReport({ fromCacheOnly: true });
};

const listReports = () => {
  try {
    if (!fs.existsSync(reportsDir)) return [];
    return fs.readdirSync(reportsDir)
      .filter(f => /^report_.+\.json$/.test(f))
      .map(f => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf-8'));
          return {
            id: r.id,
            createdAt: r.createdAt,
            range: r.range,
            strategyCount: r.strategyCount,
            generatedFromCache: r.generatedFromCache,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
};

const getLatestReport = () => {
  const list = listReports();
  if (list.length === 0) return null;
  return getReportById(list[0].id);
};

const getReportById = (id) => {
  if (!id || !/^report_[\w-]+$/.test(id)) return null;
  const file = path.join(reportsDir, `${id}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
};

const saveReport = (report) => {
  try {
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, `${report.id}.json`), JSON.stringify(report, null, 2), 'utf-8');
    // 仅保留最近 MAX_REPORTS 次
    const list = listReports();
    for (const r of list.slice(MAX_REPORTS)) {
      const f = path.join(reportsDir, `${r.id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  } catch (e) {
    console.error('回测报告写入失败:', e.message);
  }
};

module.exports = {
  generateReport,
  ensureLatestReport,
  getDefaultReportRange,
  getLatestReport,
  getReportById,
  listReports,
  saveReport,
};