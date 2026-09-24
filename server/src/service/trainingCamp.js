const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { getAvailableDates, runBacktest, getStrategyDefinitions } = require('./strategyBacktest');
const { getFundSnapshot, getAmountSnapshot } = require('./fundSnapshot');
const { getIndexTlineByDate } = require('./fupan');
const { getMonitorStocks } = require('./monitorStock');
const { getSingleStockTlineDataByDate, getSingleStockData } = require('./stock');
const { calculateResilience, getLimitTypeByCode } = require('./stockDiagnose');
const { normalizeTechEmotion, computeTechEmotion, computePullbackPenaltyFromPullback } = require('./emotion');
const blockCodeList = require('../constant/block_code').default || [];
const { batchParallel } = require('../utils');

const getBlockCodeStocks = () => {
  const map = new Map();
  blockCodeList.forEach(item => {
    if (item.code && !map.has(item.code)) {
      map.set(item.code, { code: item.code, name: item.name || item.code, blockName: item.blockName || '其他' });
    }
  });
  return Array.from(map.values());
};

const groupsFile = path.resolve(__dirname, '../data/training_camp_groups.json');

// 回放数据构建缓存：过去交易日的 loadTrainingCampData 构建结果落盘（data/backtest_camp_cache/{date}.json）。
// 历史日期的回放数据/分时/日K线均不可变，构建结果只依赖自选股与板块清单（签名校验），
// 因此回测多进程与重复加载直接读文件，跳过 runBacktest 重建与全部 HTTP 拉取；当日数据不缓存（盘中实时变化）。
const CAMP_BUILT_DIR = path.resolve(__dirname, '../data/backtest_camp_cache');
// 构建逻辑版本：修改 loadTrainingCampData 的构建逻辑（如为 campData 新增预计算字段）时必须 +1，
// 使全部旧缓存自动失效重建；仅新增策略或调整买卖点条件无需动它（条件在回测阶段实时应用，不依赖此缓存失效）
const CAMP_BUILDER_VERSION = 4;
const beijingToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const campBuiltSignature = (monitorStocks) => crypto.createHash('md5')
  .update(JSON.stringify([
    CAMP_BUILDER_VERSION,
    (monitorStocks || []).map(s => [s.code, s.isTech !== false]),
    blockCodeList.map(b => b.code),
  ]))
  .digest('hex');

const getTrainingCampDates = () => getAvailableDates();

const hhmmssToMinute = (timeKey) => {
  const str = String(timeKey).padStart(6, '0');
  return parseInt(str.substring(0, 4));
};

const padTimeKey = (t) => String(t).padStart(6, '0');

// 日K线缓存（按股票代码），回放日期的历史均线不随最新行情变化，TTL 可较长
const klineCache = new Map();
const KLINE_CACHE_TTL_MS = 30 * 60 * 1000;
// 日K线文件缓存（跨进程共享）：历史日期的均线计算只需截至回放日的K线，
// 当天拉取的 60 根日K对全部历史回放日期均有效，落盘后多进程/多次运行直接读文件，免 HTTP
const klineFileCacheDir = path.resolve(__dirname, '../data/kline_cache');
const getKlineFileCachePath = (code) => path.join(klineFileCacheDir, `${code}.json`);

const readKlineFileCache = (code, targetDateInt) => {
  try {
    const file = getKlineFileCachePath(code);
    if (!fs.existsSync(file)) return null;
    const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!cached || !Array.isArray(cached.kline) || cached.kline.length === 0) return null;
    // 仅当天拉取的缓存有效（隔天可能有新K线）；需覆盖目标回放日期
    if (cached.fetchedAt !== beijingToday()) return null;
    if (targetDateInt != null) {
      const maxDate = Math.max(...cached.kline.map(k => Number(k.trade_date)).filter(Number.isFinite));
      if (!(maxDate >= targetDateInt)) return null;
    }
    return cached.kline;
  } catch {
    return null;
  }
};

const writeKlineFileCache = (code, kline) => {
  try {
    if (!fs.existsSync(klineFileCacheDir)) fs.mkdirSync(klineFileCacheDir, { recursive: true });
    const tmpFile = `${getKlineFileCachePath(code)}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ fetchedAt: beijingToday(), kline }));
    fs.renameSync(tmpFile, getKlineFileCachePath(code));
  } catch (e) { /* 写缓存失败不影响主流程 */ }
};

const getKlineCached = async (code, targetDateStr = null) => {
  const hit = klineCache.get(code);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  // 历史回放日期优先读文件缓存（跨进程共享，当日盘中数据不走文件缓存）
  const targetDateInt = targetDateStr != null && String(targetDateStr) < beijingToday() ? parseInt(targetDateStr) : null;
  if (targetDateInt != null) {
    const fileKline = readKlineFileCache(code, targetDateInt);
    if (fileKline) {
      klineCache.set(code, { expiresAt: Date.now() + KLINE_CACHE_TTL_MS, data: fileKline });
      return fileKline;
    }
  }
  const data = await getSingleStockData(code, 60);
  klineCache.set(code, { expiresAt: Date.now() + KLINE_CACHE_TTL_MS, data });
  if (data && data.length > 0) writeKlineFileCache(code, data);
  return data;
};

// 预热日K线文件缓存：并发拉取全部自选股日K并落盘，供随后 fork 的预构建/回测子进程直接命中
const prewarmKlineCache = async () => {
  const stocks = getMonitorStocks() || [];
  const codes = [...new Set(stocks.map(s => s.code))];
  let fetched = 0;
  await batchParallel(codes, async (code) => {
    try {
      // 无目标日期：只要求当天缓存有效即命中，否则拉取落盘
      const fileKline = readKlineFileCache(code, null);
      if (fileKline) return;
      const data = await getSingleStockData(code, 60);
      if (data && data.length > 0) {
        writeKlineFileCache(code, data);
        fetched++;
      }
    } catch (e) { /* 单只失败忽略 */ }
  }, 10);
  return { total: codes.length, fetched };
};

// 根据日K线计算截至回放日期的 MA5/MA10、MA5/MA10 斜率（近5日MA变化）、前一交易日最低价与最近若干交易日最低价映射
// （与 buySellDiagnose.checkSellPointDetailed 一致；dailyLowMap 供卖点诊断「跌破最迟买入日低点」使用）
const calcDailyMaInfo = (kline, dateStr) => {
  const target = parseInt(dateStr);
  const bars = (kline || [])
    .filter(k => k && Number.isFinite(Number(k.trade_date)) && Number.isFinite(Number(k.close_px)))
    .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px), low: k.low_px != null ? Number(k.low_px) : null }))
    .filter(b => b.d <= target)
    .sort((a, b) => a.d - b.d);
  const ma = (closes, period) => {
    if (closes.length < period) return null;
    return closes.slice(-period).reduce((s, v) => s + v, 0) / period;
  };
  const closes = bars.map(b => b.c);
  const ma5 = ma(closes, 5);
  const ma10 = ma(closes, 10);
  // MA5 斜率：当前 MA5 - 5 天前的 MA5（近5日 MA5 变化）
  const ma5Slope = ma5 !== null && closes.length >= 10
    ? ma5 - ma(closes.slice(0, -5), 5)
    : null;
  // MA10 斜率：当前 MA10 - 5 天前的 MA10（近5日 MA10 变化）
  const ma10Slope = ma10 !== null && closes.length >= 15
    ? ma10 - ma(closes.slice(0, -5), 10)
    : null;
  // 前一交易日最低价（回放日期前最近一个交易日的 low_px）
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;
  const prevLow = prevBar && Number.isFinite(prevBar.low) && prevBar.low > 0 ? prevBar.low : null;
  // 最近若干交易日（含回放日）的日K线最低价映射 { trade_date: low }，覆盖最迟买入日的常见跨度（对齐实盘 30 日K线）
  const dailyLowMap = {};
  const lowBars = bars.slice(-30);
  for (const b of lowBars) {
    if (Number.isFinite(b.low) && b.low > 0) dailyLowMap[b.d] = parseFloat(b.low.toFixed(2));
  }
  return {
    ma5: ma5 !== null ? parseFloat(ma5.toFixed(2)) : null,
    ma5Slope: ma5Slope !== null && Number.isFinite(ma5Slope) ? parseFloat(ma5Slope.toFixed(2)) : null,
    ma10: ma10 !== null ? parseFloat(ma10.toFixed(2)) : null,
    ma10Slope: ma10Slope !== null && Number.isFinite(ma10Slope) ? parseFloat(ma10Slope.toFixed(2)) : null,
    prevLow: prevLow !== null ? parseFloat(prevLow.toFixed(2)) : null,
    dailyLowMap,
  };
};

const ensureGroupsFile = () => {
  if (!fs.existsSync(groupsFile)) {
    fs.writeFileSync(groupsFile, JSON.stringify([], null, 2));
  }
};

const getTrainingCampGroups = () => {
  ensureGroupsFile();
  try {
    const raw = fs.readFileSync(groupsFile, 'utf-8') || '[]';
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
};

const saveTrainingCampGroup = (group) => {
  ensureGroupsFile();
  const groups = getTrainingCampGroups();
  if (group.id) {
    const idx = groups.findIndex(g => g.id === group.id);
    if (idx >= 0) {
      groups[idx] = { ...groups[idx], ...group };
    } else {
      groups.push(group);
    }
  } else {
    const newGroup = { ...group, id: `g${Date.now()}` };
    groups.push(newGroup);
    group.id = newGroup.id;
  }
  fs.writeFileSync(groupsFile, JSON.stringify(groups, null, 2));
  return group;
};

const deleteTrainingCampGroup = (id) => {
  ensureGroupsFile();
  const groups = getTrainingCampGroups().filter(g => g.id !== id);
  fs.writeFileSync(groupsFile, JSON.stringify(groups, null, 2));
};

const buildIndexLineMap = (indexTline) => {
  if (!indexTline || !indexTline.line) return { preclose: null, sortedLine: [] };
  const preclose = parseFloat(indexTline.preclose_px);
  const sortedLine = indexTline.line
    .filter(p => p.minute && p.last_px != null)
    .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
    .sort((a, b) => a.minute - b.minute);
  return { preclose, sortedLine };
};

const findIndexPoint = (sortedLine, preclose, minute) => {
  let point = null;
  for (const p of sortedLine) {
    if (p.minute <= minute) point = p;
    else break;
  }
  if (!point) return null;
  const changePct = preclose > 0 ? parseFloat((((point.lastPx - preclose) / preclose) * 100).toFixed(2)) : 0;
  return { price: point.lastPx, changePct };
};

const loadTrainingCampData = async (dateStr) => {
  if (!dateStr || !/^\d{8}$/.test(dateStr)) {
    return { success: false, message: '日期格式错误，应为YYYYMMDD' };
  }

  const isPastDate = dateStr < beijingToday();
  const builtFile = path.join(CAMP_BUILT_DIR, `${dateStr}.json`);
  if (isPastDate) {
    try {
      if (fs.existsSync(builtFile)) {
        const cached = JSON.parse(fs.readFileSync(builtFile, 'utf-8'));
        if (cached && cached.signature === campBuiltSignature(getMonitorStocks()) && cached.data?.success) {
          return cached.data;
        }
      }
    } catch (e) { /* 缓存损坏则走重建 */ }
  }

  // 并发预取全部自选股当日分时（runBacktest 内部为逐只串行拉取，先并发拉好可让后续全部命中缓存）
  const monitorStocks = getMonitorStocks() || [];
  await batchParallel(monitorStocks, async (stock) => {
    try { await getSingleStockTlineDataByDate(stock.code, parseInt(dateStr)); } catch (e) { /* 单只失败忽略 */ }
  }, 10);

  const backtestResult = await runBacktest(dateStr, null).catch(err => {
    console.error(`runBacktest ${dateStr} 失败:`, err.message);
    return { success: false, message: err.message };
  });
  if (!backtestResult.success) {
    return { success: false, message: backtestResult.message || '回测数据加载失败', date: dateStr };
  }

  const fundData = getFundSnapshot(dateStr) || [];
  const amountData = getAmountSnapshot(dateStr) || [];

  if (fundData.length === 0) {
    return { success: false, message: `未找到 ${dateStr} 的资金快照数据`, date: dateStr };
  }

  const indexTlines = await getIndexTlineByDate(dateStr);
  const cybMap = buildIndexLineMap(indexTlines?.chuangyeban);
  const kcbMap = buildIndexLineMap(indexTlines?.kechuangban);

  const stockTlines = [];
  for (const stock of monitorStocks) {
    try {
      const tlineData = await getSingleStockTlineDataByDate(stock.code, parseInt(dateStr));
      if (!tlineData || !tlineData.line || tlineData.line.length === 0) continue;
      const preclose = parseFloat(tlineData.preclose_px);
      if (!preclose || preclose <= 0) continue;
      const sortedLine = tlineData.line
        .filter(p => p.minute && p.last_px != null)
        .map(p => ({
          minute: parseInt(p.minute),
          lastPx: parseFloat(p.last_px),
          changePct: parseFloat((((parseFloat(p.last_px) - preclose) / preclose) * 100).toFixed(2)),
        }))
        .sort((a, b) => a.minute - b.minute);
      stockTlines.push({
        code: stock.code,
        name: stock.name || stock.code,
        isTech: stock.isTech !== false,
        preclose,
        sortedLine,
      });
    } catch (e) {
      // skip individual stock errors
    }
  }

  // 拉取自选股日K线，计算截至回放日期的真实 MA5/MA10（与K线图10日线一致）
  const dailyMaMap = new Map();
  const klineCodes = [...new Set(stockTlines.map(s => s.code))];
  await batchParallel(klineCodes, async (code) => {
    try {
      dailyMaMap.set(code, calcDailyMaInfo(await getKlineCached(code, dateStr), dateStr));
    } catch (e) {
      dailyMaMap.set(code, { ma5: null, ma10: null, ma10Slope: null });
    }
  }, 10);

  // 每只股票最近若干交易日的日K线最低价映射 { [code]: { [trade_date]: low } }，供卖点诊断「跌破最迟买入日低点」使用
  const dailyLowByCode = {};
  for (const [code, ma] of dailyMaMap.entries()) {
    if (ma.dailyLowMap && Object.keys(ma.dailyLowMap).length > 0) {
      dailyLowByCode[code] = ma.dailyLowMap;
    }
  }

  // 预计算每只股票最近 3 个交易日（含当日）的抗分歧指数，用于卖点诊断条件5（仅 9:40 后生效）；当日分数另供策略选股 extractDailyInfo 使用
  const resilience3dMap = new Map();
  await batchParallel(klineCodes, async (code) => {
    try {
      const kline = await getKlineCached(code, dateStr);
      const target = parseInt(dateStr);
      const sorted = [...(kline || [])]
        .filter(k => k && Number.isFinite(Number(k.trade_date)))
        .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
      const idx = sorted.findIndex(k => Number(k.trade_date) === target);
      if (idx < 2) {
        resilience3dMap.set(code, { allBelow10: false, scores: [], valid: false });
        return;
      }
      const last3Dates = [idx - 2, idx - 1, idx].map(i => Number(sorted[i].trade_date));
      const isSh688 = code.startsWith('sh688');
      const indexCode = isSh688 ? 'sh000688' : 'sz399006';
      const limitType = getLimitTypeByCode(code);
      const scores = [];
      let allValid = true;
      for (const d of last3Dates) {
        const [stockTline, indexTline] = await Promise.all([
          getSingleStockTlineDataByDate(code, d),
          getSingleStockTlineDataByDate(indexCode, d),
        ]);
        const stockLine = stockTline?.line || [];
        const indexLine = indexTline?.line || [];
        if (stockLine.length < 5 || indexLine.length < 5) {
          allValid = false;
          scores.push(null);
          continue;
        }
        const s = calculateResilience(indexLine, stockLine, limitType);
        scores.push(parseFloat(s.toFixed(2)));
      }
      const allBelow10 = allValid && scores.every(s => s !== null && s < 10);
      resilience3dMap.set(code, { allBelow10, scores, valid: allValid });
    } catch (e) {
      resilience3dMap.set(code, { allBelow10: false, scores: [], valid: false });
    }
  }, 10);

  // 板块股分时：并发拉取（原串行逐只 await，160 只板块股冷缓存时是单日重建的最大耗时点）
  const blockStocks = getBlockCodeStocks();
  const ownTlineMap = new Map(stockTlines.map(s => [s.code, s]));
  const blockStockTlines = [];
  await batchParallel(blockStocks, async (stock) => {
    try {
      const own = ownTlineMap.get(stock.code);
      if (own) {
        blockStockTlines.push({ code: stock.code, name: stock.name, blockName: stock.blockName, sortedLine: own.sortedLine });
        return;
      }
      const tlineData = await getSingleStockTlineDataByDate(stock.code, parseInt(dateStr));
      if (!tlineData || !tlineData.line || tlineData.line.length === 0) return;
      const preclose = parseFloat(tlineData.preclose_px);
      if (!preclose || preclose <= 0) return;
      const sortedLine = tlineData.line
        .filter(p => p.minute && p.last_px != null)
        .map(p => ({
          minute: parseInt(p.minute),
          lastPx: parseFloat(p.last_px),
          changePct: parseFloat((((parseFloat(p.last_px) - preclose) / preclose) * 100).toFixed(2)),
        }))
        .sort((a, b) => a.minute - b.minute);
      blockStockTlines.push({ code: stock.code, name: stock.name, blockName: stock.blockName, sortedLine });
    } catch { /* skip */ }
  }, 10);

  const signalsMap = new Map();
  for (const tp of backtestResult.signals) {
    signalsMap.set(padTimeKey(tp.timeKey), tp.signals);
  }

  const amountList = amountData
    .map(a => ({ minute: hhmmssToMinute(a.time), volume: parseFloat(a.amountChangeDiff) || 0 }))
    .sort((a, b) => a.minute - b.minute);

  const findVolume = (minute) => {
    let vol = null;
    for (const a of amountList) {
      if (a.minute <= minute) vol = a.volume;
      else break;
    }
    return vol;
  };

  const findStockChange = (sortedLine, minute) => {
    let point = null;
    for (const p of sortedLine) {
      if (p.minute <= minute) point = p;
      else break;
    }
    return point ? { changePct: point.changePct, lastPx: point.lastPx } : null;
  };

  let cybMaxChange = null;
  let kcbMaxChange = null;
  const techStockTlines = stockTlines.filter(s => s.isTech !== false);

  const timeBuckets = fundData.map(f => {
    const timeKey = padTimeKey(f.time);
    const minute = hhmmssToMinute(f.time);
    const displayTime = f.displayTime ? f.displayTime.substring(0, 5) : `${timeKey.substring(0, 2)}:${timeKey.substring(2, 4)}`;

    const stockChanges = stockTlines.map(st => {
      const p = findStockChange(st.sortedLine, minute);
      const ma = dailyMaMap.get(st.code) || {};
      const dailyMa5 = ma.ma5 != null ? ma.ma5 : null;
      const dailyMa5Slope = ma.ma5Slope != null ? ma.ma5Slope : null;
      const dailyMa10 = ma.ma10 != null ? ma.ma10 : null;
      const dailyMa10Slope = ma.ma10Slope != null ? ma.ma10Slope : null;
      const dailyPrevLow = ma.prevLow != null ? ma.prevLow : null;
      const r3d = resilience3dMap.get(st.code) || {};
      return p
        ? { code: st.code, name: st.name, changePct: p.changePct, lastPx: p.lastPx, dailyMa5, dailyMa5Slope, dailyMa10, dailyMa10Slope, dailyPrevLow, resilience3dAllBelow10: r3d.allBelow10 === true, resilience3dScores: r3d.scores || [], resilience3dValid: r3d.valid === true }
        : { code: st.code, name: st.name, changePct: null, lastPx: null, dailyMa5, dailyMa5Slope, dailyMa10, dailyMa10Slope, dailyPrevLow, resilience3dAllBelow10: r3d.allBelow10 === true, resilience3dScores: r3d.scores || [], resilience3dValid: r3d.valid === true };
    }).filter(s => s.changePct !== null);

    const cybPoint = findIndexPoint(cybMap.sortedLine, cybMap.preclose, minute);
    const kcbPoint = findIndexPoint(kcbMap.sortedLine, kcbMap.preclose, minute);
    if (cybPoint && (cybMaxChange === null || cybPoint.changePct > cybMaxChange)) cybMaxChange = cybPoint.changePct;
    if (kcbPoint && (kcbMaxChange === null || kcbPoint.changePct > kcbMaxChange)) kcbMaxChange = kcbPoint.changePct;

    const rawSum = techStockTlines.reduce((acc, st) => {
      const p = findStockChange(st.sortedLine, minute);
      return acc + (p ? p.changePct : 0);
    }, 0);
    const baseEmotion = normalizeTechEmotion(rawSum);

    const pullbacks = [];
    if (cybPoint && cybMaxChange !== null) pullbacks.push(cybPoint.changePct - cybMaxChange);
    if (kcbPoint && kcbMaxChange !== null) pullbacks.push(kcbPoint.changePct - kcbMaxChange);
    const avgPullback = pullbacks.length > 0 ? pullbacks.reduce((a, b) => a + b, 0) / pullbacks.length : 0;
    const pullbackPenalty = computePullbackPenaltyFromPullback(avgPullback);
    const techEmotion = computeTechEmotion(baseEmotion, pullbackPenalty);

    const blockMap = {};
    blockStockTlines.forEach(st => {
      const p = findStockChange(st.sortedLine, minute);
      if (!p) return;
      const b = st.blockName || '其他';
      if (!blockMap[b]) blockMap[b] = { blockName: b, total: 0, count: 0 };
      blockMap[b].total += p.changePct;
      blockMap[b].count += 1;
    });
    const blockAvg = Object.values(blockMap).map(b => ({
      blockName: b.blockName,
      avgChange: b.count > 0 ? b.total / b.count : 0,
      count: b.count,
    }));
    const sortedBlocks = blockAvg.sort((a, b) => b.avgChange - a.avgChange);

    return {
      timeKey,
      displayTime,
      minute,
      fundFlow: parseFloat(f.mainMoney) || 0,
      volume: findVolume(minute),
      indexTline: {
        cyb: cybPoint,
        kcb: kcbPoint,
      },
      stockChanges,
      blockRanking: {
        firstNumList: sortedBlocks.slice(0, 10).map(b => ({ blockName: b.blockName, avgChange: Number(b.avgChange.toFixed(2)), rankChange: 0, code: b.blockName })),
        lastNumList: sortedBlocks.slice(-10).reverse().map(b => ({ blockName: b.blockName, avgChange: Number(b.avgChange.toFixed(2)), rankChange: 0, code: b.blockName })),
      },
      techEmotion,
      signals: signalsMap.get(timeKey) || [],
    };
  });

  const campData = {
    success: true,
    date: dateStr,
    dateDisplay: `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`,
    monitorStocks: monitorStocks.map(s => ({ code: s.code, name: s.name || s.code })),
    indexKline: backtestResult.chartData?.kline || { cyb: [], kcb: [] },
    strategies: backtestResult.strategies || getStrategyDefinitions(),
    dailyLowByCode,
    timeBuckets,
    prevDayTechEmotion: backtestResult.prevDayTechEmotion ?? null,
    prevDayIsIcePoint: backtestResult.prevDayIsIcePoint ?? false,
    prevDayHasIce: backtestResult.prevDayHasIce ?? false,
    todayHasIce: backtestResult.todayHasIce ?? false,
    cybOpenPx: backtestResult.cybOpenPx ?? null,
    kcbOpenPx: backtestResult.kcbOpenPx ?? null,
  };

  // 过去日期构建结果落盘（tmp + rename 原子写，多进程并发安全）
  if (isPastDate) {
    try {
      if (!fs.existsSync(CAMP_BUILT_DIR)) fs.mkdirSync(CAMP_BUILT_DIR, { recursive: true });
      const tmpFile = `${builtFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify({ signature: campBuiltSignature(monitorStocks), data: campData }));
      fs.renameSync(tmpFile, builtFile);
    } catch (e) { /* 写缓存失败不影响返回 */ }
  }

  return campData;
};

module.exports = {
  getTrainingCampDates,
  loadTrainingCampData,
  beijingToday,
  getTrainingCampGroups,
  saveTrainingCampGroup,
  deleteTrainingCampGroup,
  prewarmKlineCache,
};
