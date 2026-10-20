const { SELL_CONDITION_PERSIST_MIN } = require('../constants');
const { calculateResilience, getLimitTypeByCode, getSingleStockTlineDataByDate } = require('../deps');
const { fmtTime } = require('./buyPoint');

// ============================================================
const getReplayLimitType = (code) => {
  const c = String(code || '').toUpperCase();
  if (c.startsWith('SH688') || c.startsWith('688')) return 'STAR';
  if (c.startsWith('SZ3') || c.startsWith('3')) return 'GEM';
  return 'MAIN';
};

const calculateReplayResilience = (stockPoints, indexPoints, code) => {
  if (!Array.isArray(stockPoints) || stockPoints.length < 5) return null;
  if (!Array.isArray(indexPoints) || indexPoints.length < 5) return null;
  const limits = { STAR: 20, GEM: 20, MAIN: 10 };
  const limitType = getReplayLimitType(code);
  const limitPct = limits[limitType] ?? 10;
  const limitEps = 0.001;

  const indexMap = new Map();
  for (const item of indexPoints) {
    const m = parseInt(item.minute);
    const px = item.lastPx != null ? parseFloat(item.lastPx) : (100 + (item.change != null ? parseFloat(item.change) : 0));
    if (!isNaN(m) && px > 0) {
      indexMap.set(m, { px, change: item.change != null ? parseFloat(item.change) : 0 });
    }
  }
  if (indexMap.size < 5) return null;

  const aligned = [];
  for (const s of stockPoints) {
    const m = parseInt(s.minute);
    const idx = indexMap.get(m);
    if (!idx) continue;
    const stockPx = s.lastPx != null ? parseFloat(s.lastPx) : (100 + (s.change != null ? parseFloat(s.change) : 0));
    if (!(stockPx > 0)) continue;
    const stockChange = s.change != null ? parseFloat(s.change) : 0;
    const prevClose = stockPx / (1 + stockChange / 100);
    const limitUpPrice = prevClose * (1 + limitPct / 100);
    const limitDownPrice = prevClose * (1 - limitPct / 100);
    aligned.push({
      minute: m,
      stockPx,
      indexPx: idx.px,
      stockChange,
      indexChange: idx.change,
      isLockUp: stockPx >= limitUpPrice - limitEps,
      isLockDown: stockPx <= limitDownPrice + limitEps,
      prevClose,
    });
  }
  aligned.sort((a, b) => a.minute - b.minute);
  if (aligned.length < 5) return null;

  const totalMinutes = aligned.length;
  const lockUpCount = aligned.filter(p => p.isLockUp).length;
  const lockDownCount = aligned.filter(p => p.isLockDown).length;
  const lockUpRatio = lockUpCount / totalMinutes;
  const lockDownRatio = lockDownCount / totalMinutes;

  const freeMinutes = aligned.filter(p => !p.isLockUp && !p.isLockDown);
  const stockRets = [];
  const indexRets = [];
  for (let i = 1; i < freeMinutes.length; i++) {
    const prev = freeMinutes[i - 1];
    const curr = freeMinutes[i];
    if (prev.stockPx > 0 && prev.indexPx > 0) {
      stockRets.push((curr.stockPx - prev.stockPx) / prev.stockPx * 100);
      indexRets.push((curr.indexPx - prev.indexPx) / prev.indexPx * 100);
    }
  }

  const upStockRets = [];
  const upIndexRets = [];
  const downStockRets = [];
  const downIndexRets = [];
  for (let i = 0; i < indexRets.length; i++) {
    if (indexRets[i] > 0) {
      upIndexRets.push(indexRets[i]);
      upStockRets.push(stockRets[i]);
    } else if (indexRets[i] < 0) {
      downIndexRets.push(indexRets[i]);
      downStockRets.push(stockRets[i]);
    }
  }

  const safeRatio = (xArr, yArr, minSamples = 3) => {
    if (xArr.length < minSamples || yArr.length < minSamples) return null;
    const meanX = xArr.reduce((a, b) => a + b, 0) / xArr.length;
    const meanY = yArr.reduce((a, b) => a + b, 0) / yArr.length;
    if (Math.abs(meanX) < 0.005) return null;
    return meanY / meanX;
  };

  const upRatio = safeRatio(upIndexRets, upStockRets);
  const downRatio = safeRatio(downIndexRets, downStockRets);

  const upStockChg = [];
  const upIndexChg = [];
  const downStockChg = [];
  const downIndexChg = [];
  for (const p of freeMinutes) {
    if (p.indexChange > 0) {
      upStockChg.push(p.stockChange);
      upIndexChg.push(p.indexChange);
    } else if (p.indexChange < 0) {
      downStockChg.push(p.stockChange);
      downIndexChg.push(p.indexChange);
    }
  }
  const avg = (arr) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const excessUp = avg(upStockChg) - avg(upIndexChg);
  const excessDown = avg(downStockChg) - avg(downIndexChg);

  let offenseScore = 0;
  if (upRatio !== null) {
    offenseScore = Math.min(4, Math.max(0, upRatio * 1.6));
  } else {
    offenseScore = 1.0;
  }

  let defenseScore = 0;
  if (downRatio !== null) {
    if (downRatio < 0) {
      defenseScore = 6.0 + Math.min(4, Math.abs(downRatio) * 2);
    } else {
      defenseScore = 5.0 / (downRatio + 1.0);
    }
  } else {
    defenseScore = 2.5;
  }

  const excessUpScore = Math.max(-2, Math.min(2, excessUp * 0.3));
  const excessDownScore = Math.max(-3, Math.min(5, excessDown * 0.8));

  let lockScore = 0;
  if (lockUpRatio > 0.5) {
    lockScore = 5 + (lockUpRatio - 0.5) * 10;
  } else if (lockUpRatio > 0) {
    lockScore = lockUpRatio * 4;
  }
  if (lockDownRatio > 0.5) {
    lockScore -= 5 + (lockDownRatio - 0.5) * 10;
  } else if (lockDownRatio > 0) {
    lockScore -= lockDownRatio * 4;
  }

  let resilienceScore = 5.0 + offenseScore + defenseScore + excessUpScore + excessDownScore + lockScore;
  resilienceScore = Math.max(0, Math.min(30, resilienceScore));
  return parseFloat(resilienceScore.toFixed(4));
};

// ============================================================
// 以下为卖点诊断移植（对齐 src/pages/trainingCamp/utils/sellPointChecks.js）
// ============================================================
const toNumber = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

// 取某只股票（或指数）截至当前 minute 的分时序列 { minute, change, lastPx }
const getTlinePoints = (replayStocks, code, minute) => {
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry) return [];
  return (entry.tlinePoints || [])
    .filter(p => p.minute != null && p.minute <= minute)
    .sort((a, b) => a.minute - b.minute);
};

// 检查条件2（高位放量大阴线）在过去 N 分钟内是否持续满足
const checkCondition2Persist = (replayStocks, code, currentMinute, openPrice) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry || !entry.tlinePoints || entry.tlinePoints.length === 0) return { satisfied: false, checkedMin: 0 };
  const sorted = [...entry.tlinePoints]
    .filter(p => p.minute != null && p.minute <= currentMinute && p.lastPx != null && p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sorted.length === 0) return { satisfied: false, checkedMin: 0 };

  const recent = sorted.slice(-PERSIST_MIN);
  if (recent.length < PERSIST_MIN) {
    return { satisfied: false, checkedMin: recent.length };
  }
  for (let i = 0; i < recent.length; i++) {
    const dayHighAtMinute = sorted
      .filter(p => p.minute <= recent[i].minute)
      .reduce((mx, p) => Math.max(mx, p.lastPx), 0);
    const px = recent[i].lastPx;
    const amp = px > 0 ? ((dayHighAtMinute - px) / px) * 100 : 0;
    if (!(amp > 8 && px < openPrice)) {
      return { satisfied: false, checkedMin: i + 1 };
    }
  }
  return { satisfied: true, checkedMin: recent.length };
};

// 检查条件3（科技板块情绪退潮）在过去 N 分钟内是否持续满足
const checkCondition3Persist = (timeBuckets, currentIndex) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  if (!Array.isArray(timeBuckets) || currentIndex < 0) return { satisfied: false, checkedMin: 0 };

  let coveredMin = 0;
  for (let i = currentIndex; i >= 0; i--) {
    const bucket = timeBuckets[i];
    const techEmotion = toNumber(bucket?.techEmotion);
    const downStocksCount = (bucket?.stockChanges || []).filter(s => {
      const pct = toNumber(s.changePct);
      return pct !== null && pct < -9;
    }).length;
    const cond3True = techEmotion !== null && techEmotion === -100 && downStocksCount >= 5;
    if (!cond3True) break;
    const bucketMinute = toNumber(bucket?.minute);
    if (bucketMinute === null || bucketMinute === undefined) break;
    if (i === currentIndex) {
      coveredMin += 5;
    } else {
      const prevBucketMinute = toNumber(timeBuckets[i + 1]?.minute);
      if (prevBucketMinute !== null && prevBucketMinute !== undefined) {
        coveredMin += prevBucketMinute - bucketMinute;
      } else {
        coveredMin += 5;
      }
    }
    if (coveredMin >= PERSIST_MIN) {
      return { satisfied: true, checkedMin: coveredMin };
    }
  }
  return { satisfied: false, checkedMin: coveredMin };
};

// 检查条件6（跌破最迟买入日低点）在过去 N 分钟内是否持续满足
const checkBuyDayLowPersist = (replayStocks, code, currentMinute, buyDayLow) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry || !entry.tlinePoints || entry.tlinePoints.length === 0) return { satisfied: false, checkedMin: 0 };
  const sorted = [...entry.tlinePoints]
    .filter(p => p.minute != null && p.minute <= currentMinute && p.lastPx != null && p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sorted.length === 0) return { satisfied: false, checkedMin: 0 };
  const recent = sorted.slice(-PERSIST_MIN);
  if (recent.length < PERSIST_MIN) {
    return { satisfied: false, checkedMin: recent.length };
  }
  for (let i = 0; i < recent.length; i++) {
    if (!(recent[i].lastPx < buyDayLow)) {
      return { satisfied: false, checkedMin: i + 1 };
    }
  }
  return { satisfied: true, checkedMin: recent.length };
};

// 训练营回放模拟持仓卖点诊断（对齐前端 sellPointChecks.js）
const runSellPointDiagnosis = async (position, currentBucket, replayStocks, timeBuckets, currentIndex, dateStr) => {
  const code = position?.code;
  const stockName = position?.stockName || position?.name || code;
  const buyPrice = toNumber(position?.buyPrice);
  const stockChanges = currentBucket?.stockChanges || [];
  const stock = stockChanges.find(s => s.code === code);
  const closePrice = stock?.lastPx != null ? toNumber(stock.lastPx) : null;
  const minute = currentBucket?.minute;
  const displayTime = fmtTime(currentBucket?.timeKey).substring(0, 5); // 归一化 HH:MM，避免原快照 displayTime 格式不一致

  if (closePrice === null || closePrice <= 0 || minute == null) {
    return {
      isSell: false,
      code,
      stockName,
      closePrice: null,
      change: null,
      returnRate: null,
      dayHigh: null,
      techEmotion: null,
      resilienceScore: null,
      conditions: [],
      conclusion: '当前时间桶无该股票价格数据，无法诊断',
      displayTime,
    };
  }

  const change = stock?.changePct != null ? toNumber(stock.changePct) : null;

  const stockPoints = getTlinePoints(replayStocks, code, minute).filter(p => p.lastPx != null && p.lastPx > 0);
  const dayHigh = stockPoints.reduce((mx, p) => Math.max(mx, p.lastPx), 0);
  const openPrice = stockPoints.length > 0 ? stockPoints[0].lastPx : null;

  // ===== 条件1：均线破位 =====
  const ma5 = stock?.dailyMa5 != null ? toNumber(stock.dailyMa5) : null;
  const ma5Slope = stock?.dailyMa5Slope != null ? toNumber(stock.dailyMa5Slope) : null;
  const ma10 = stock?.dailyMa10 != null ? toNumber(stock.dailyMa10) : null;
  const ma10Slope = stock?.dailyMa10Slope != null ? toNumber(stock.dailyMa10Slope) : null;
  const prevLow = stock?.dailyPrevLow != null ? toNumber(stock.dailyPrevLow) : null;

  let condition1 = {
    name: '均线破位',
    satisfied: false,
    detail: '',
    subConditions: [],
  };
  if (ma10 === null) {
    condition1.detail = '缺少日K线数据（不足10个交易日），无法计算MA10';
    condition1.subConditions = [{ label: '状态', value: '数据不足' }];
  } else {
    const inTradingWindow = minute != null && minute >= 930 && minute < 1450;
    const deepFall = change !== null && change < -3;

    let ruleType = 4;
    let slopeInfo = '';
    if (ma10Slope !== null && ma10Slope < 0) {
      if (ma5Slope !== null && ma5Slope > 0) {
        if (openPrice !== null && openPrice > ma10) {
          ruleType = 1;
        } else {
          ruleType = 3;
        }
      } else {
        ruleType = 2;
      }
      slopeInfo = `10日线斜率 ${ma10Slope.toFixed(2)} < 0`;
      if (ma5Slope !== null) slopeInfo += `，5日线斜率 ${ma5Slope.toFixed(2)}`;
    } else {
      ruleType = 4;
      slopeInfo = ma10Slope !== null
        ? `10日线斜率 ${ma10Slope.toFixed(2)} ≥ 0`
        : '10日线斜率数据不足（视为非负）';
    }

    const formatBreakDetail = (broken, triggerLine, triggerLabel) => {
      if (!broken) {
        return `现价 ${closePrice.toFixed(2)} 未跌破${triggerLabel} ${triggerLine.toFixed(2)}，未触发`;
      } else if (inTradingWindow && !deepFall) {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}，但当前涨幅 ${(change ?? 0).toFixed(2)}% 未低于 -3%（14:50 前需涨幅 < -3%），暂不触发`;
      } else if (inTradingWindow) {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}，且当前涨幅 ${change.toFixed(2)}% < -3%，触发卖点`;
      } else {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}（14:50 后跌破即触发），触发卖点`;
      }
    };

    if (ruleType === 1) {
      const broken = closePrice < ma10;
      condition1.satisfied = broken && (!inTradingWindow || deepFall);
      condition1.detail = formatBreakDetail(broken, ma10, '10日线');
    } else if (ruleType === 2) {
      const brokenPrevLow = prevLow !== null && closePrice < prevLow;
      condition1.satisfied = brokenPrevLow;
      condition1.detail = prevLow === null
        ? `${slopeInfo}，改用前低判断，但缺少前一交易日最低价数据`
        : brokenPrevLow
          ? `${slopeInfo}，现价 ${closePrice.toFixed(2)} 跌破前一交易日最低价 ${prevLow.toFixed(2)}，下降趋势延续，触发卖点`
          : `${slopeInfo}，现价 ${closePrice.toFixed(2)} 未跌破前一交易日最低价 ${prevLow.toFixed(2)}，暂不触发`;
    } else if (ruleType === 3) {
      if (ma5 !== null) {
        const broken = closePrice < ma5;
        condition1.satisfied = broken && (!inTradingWindow || deepFall);
        condition1.detail = formatBreakDetail(broken, ma5, '5日线');
      } else {
        condition1.detail = `${slopeInfo}，缺少MA5数据，无法按规则③判断`;
      }
    } else {
      const broken = closePrice < ma10;
      condition1.satisfied = broken && (!inTradingWindow || deepFall);
      condition1.detail = formatBreakDetail(broken, ma10, '10日线');
    }
  }

  // ===== 条件2：高位放量大阴线（需持续 ≥5 分钟） =====
  const amplitude = closePrice > 0 ? ((dayHigh - closePrice) / closePrice) * 100 : 0;
  const isCondition2RawTrue = openPrice !== null && amplitude > 8 && closePrice < openPrice;
  const cond2Persist = isCondition2RawTrue
    ? checkCondition2Persist(replayStocks, code, minute, openPrice)
    : { satisfied: false, checkedMin: 0 };
  const condition2 = {
    name: '高位放量大阴线',
    satisfied: cond2Persist.satisfied,
    pending: isCondition2RawTrue && !cond2Persist.satisfied,
    pendingMinutes: isCondition2RawTrue ? cond2Persist.checkedMin : 0,
    detail: openPrice !== null
      ? `回落 ${amplitude.toFixed(2)}%${amplitude > 8 ? ' > 8%' : ' ≤ 8%'}，现价 ${closePrice.toFixed(2)}${closePrice < openPrice ? ' < 开盘' : ' ≥ 开盘'}，${amplitude > 8 && closePrice < openPrice ? '为高位大阴线' : '未触发'}${isCondition2RawTrue && !cond2Persist.satisfied ? `（已持续 ${cond2Persist.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）` : ''}`
      : '无日内开盘价数据，无法判断',
    subConditions: [],
  };

  // ===== 条件3：科技板块情绪退潮（需持续 ≥5 分钟） =====
  // 重点板块系列专属门禁（2026-09-30）：仅当创业板指 3 日线斜率为正（position.keyBlockCybMa3Slope > 0，
  // MA3 − 5个交易日前MA3，按当日收盘已基本定型口径）时本条件才参与卖出判定；斜率为负/数据不足/获取失败当日不生效。
  // 字段缺省（其他策略）走原逻辑不受影响。
  const techEmotion = toNumber(currentBucket?.techEmotion);
  const downStocksCount = (currentBucket?.stockChanges || []).filter(s => {
    const pct = toNumber(s.changePct);
    return pct !== null && pct < -9;
  }).length;
  const techCrash = techEmotion !== null && techEmotion === -100;
  const hasKeyBlockGateC3 = position?.keyBlockCybMa3Slope !== undefined;
  const gateSlopeC3 = hasKeyBlockGateC3 && Number.isFinite(Number(position.keyBlockCybMa3Slope)) ? Number(position.keyBlockCybMa3Slope) : null;
  const gatePassedC3 = !hasKeyBlockGateC3 || (gateSlopeC3 !== null && gateSlopeC3 > 0);
  let condition3;
  if (!gatePassedC3) {
    condition3 = {
      name: '科技板块情绪退潮',
      satisfied: false,
      detail: gateSlopeC3 === null
        ? '创业板指 3 日线斜率数据不足，无法判定生效门禁，本条件当日不参与卖出判定'
        : `创业板指 3 日线斜率 ${gateSlopeC3.toFixed(2)} ≤ 0，本条件当日不参与卖出判定（门禁：斜率为正时科技板块情绪退潮才生效）`,
      subConditions: [
        { label: '创业板指3日线斜率', value: gateSlopeC3 === null ? '--' : gateSlopeC3.toFixed(2) },
        { label: '门禁规则', value: '斜率 > 0 时本条件生效' },
      ],
    };
  } else {
    const isCondition3RawTrue = techCrash && downStocksCount >= 5;
    const cond3Persist = isCondition3RawTrue
      ? checkCondition3Persist(timeBuckets, currentIndex)
      : { satisfied: false, checkedMin: 0 };
    condition3 = {
      name: '科技板块情绪退潮',
      satisfied: cond3Persist.satisfied,
      pending: isCondition3RawTrue && !cond3Persist.satisfied,
      pendingMinutes: isCondition3RawTrue ? cond3Persist.checkedMin : 0,
      detail: techCrash && downStocksCount >= 5
        ? `科技情绪指数 = -100 且自选股中跌幅<-9%的个股 ${downStocksCount} 个（>=5），市场触底${!cond3Persist.satisfied ? `（已持续 ${cond3Persist.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）` : ''}`
        : techCrash
          ? `科技情绪指数 = -100，但自选股中跌幅<-9%的个股仅 ${downStocksCount} 个（<5），未触发`
          : techEmotion !== null
            ? `科技情绪指数 ${techEmotion.toFixed(2)}，未达到 -100（需 = -100 且自选股中跌幅<-9%个股 >=5 才触发）`
            : '当日科技情绪数据暂无',
      subConditions: [],
    };
  }
  if (hasKeyBlockGateC3) {
    condition3.subConditions = [
      ...(condition3.subConditions || []),
      {
        label: '创业板指3日线斜率门禁',
        value: gatePassedC3
          ? `${gateSlopeC3 > 0 ? '+' : ''}${gateSlopeC3.toFixed(2)}（>0，本条件生效）`
          : (gateSlopeC3 === null ? '数据不足，本条件不生效' : `${gateSlopeC3.toFixed(2)}（≤0，本条件不生效）`),
      },
    ];
  }

  // ===== 条件4：抗分歧指数 < 6 且 当前涨幅 ≤ -5%（14:50后生效） =====
  const isSh688 = String(code).toLowerCase().startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const indexPoints = getTlinePoints(replayStocks, indexCode, minute);
  let resilienceScore = null;
  if (stockPoints.length >= 5 && indexPoints.length >= 5) {
    const raw = calculateReplayResilience(stockPoints, indexPoints, code);
    if (raw != null) resilienceScore = parseFloat(raw.toFixed(2));
  }
  const isResilienceWeak = resilienceScore !== null && resilienceScore < 6;
  const isFalling = change !== null && change <= -5;
  const isAfter1450 = minute != null && minute >= 1450;
  const condition4 = {
    name: '抗分歧指数弱势',
    satisfied: isResilienceWeak && isFalling && isAfter1450,
    detail: resilienceScore === null
      ? '分时数据不足，无法计算抗分歧指数'
      : !isAfter1450
        ? `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，但当前时间未到 14:50，条件暂不生效`
        : isResilienceWeak && isFalling
          ? `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，个股抗跌性弱且正在下跌`
          : !isResilienceWeak
            ? `抗分歧指数 ${resilienceScore.toFixed(2)} ≥ 6，个股抗跌性尚可，未触发`
            : `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，但涨幅 ${change.toFixed(2)}% > -5%，未触发`,
    subConditions: [],
  };

  // ===== 条件5：连续三日（含当日）抗分歧指数均 < 10（个股连续弱势，资金持续分歧），仅 9:40 后生效 =====
  // 前两日用预计算的全天分数（resilience3dScores 前 2 位，历史数据）；当日为实时口径：
  // 用当日分钟级分时截至当前评估分钟现算，避免使用收盘后才能得到的未来数据（与线上 checkSellPointDetailed 当日口径一致）。
  // 预计算的收盘口径标志 resilience3dAllBelow10 仅供策略选股（extractDailyInfo 取 scores[2]），不再用于本条件
  const r3dScores = Array.isArray(stock?.resilience3dScores) ? stock.resilience3dScores : [];
  const prev1C5 = r3dScores.length > 0 ? r3dScores[0] : null;
  const prev2C5 = r3dScores.length > 1 ? r3dScores[1] : null;
  const prevOkC5 = prev1C5 != null && prev2C5 != null && prev1C5 < 10 && prev2C5 < 10;
  const isAfter940C5 = minute != null && minute >= 940;
  let todayScoreC5 = null;
  if (dateStr && minute != null) {
    try {
      const indexCodeC5 = String(code).startsWith('sh688') ? 'sh000688' : 'sz399006';
      const dateNumC5 = parseInt(dateStr, 10);
      const [stockTlineC5, indexTlineC5] = await Promise.all([
        getSingleStockTlineDataByDate(code, dateNumC5),
        getSingleStockTlineDataByDate(indexCodeC5, dateNumC5),
      ]);
      const stockLineC5 = (stockTlineC5?.line || []).filter(p => p && p.minute != null && parseInt(p.minute) <= minute);
      const indexLineC5 = (indexTlineC5?.line || []).filter(p => p && p.minute != null && parseInt(p.minute) <= minute);
      if (stockLineC5.length >= 5 && indexLineC5.length >= 5) {
        todayScoreC5 = parseFloat(calculateResilience(indexLineC5, stockLineC5, getLimitTypeByCode(code)).toFixed(2));
      }
    } catch (e) { /* 当日分时数据不足，视为无法判断 */ }
  }
  const allBelow10C5 = prevOkC5 && todayScoreC5 != null && todayScoreC5 < 10;
  const fmtMinuteC5 = minute != null ? `${String(Math.floor(minute / 100)).padStart(2, '0')}:${String(minute % 100).padStart(2, '0')}` : '--';
  const prevDisplayC5 = [prev1C5, prev2C5].map(s => (s != null ? Number(s).toFixed(2) : '--')).join('、');
  const todayDisplayC5 = todayScoreC5 != null ? todayScoreC5.toFixed(2) : '--';
  const condition5 = {
    name: '连续三日抗分歧弱势',
    satisfied: allBelow10C5 && isAfter940C5,
    detail: !prevOkC5
      ? `前两日抗分歧指数未全部 < 10（${prevDisplayC5}）或历史数据不足，无法判断连续三日弱势`
      : !isAfter940C5
        ? `前两日抗分歧指数均 < 10（${prevDisplayC5}），当日实时 ${todayDisplayC5}，但当前时间未到 9:40，条件暂不生效`
        : !allBelow10C5
          ? (todayScoreC5 == null
            ? `当日实时抗分歧分数数据不足（截至 ${fmtMinuteC5}），未触发`
            : `前两日均 < 10（${prevDisplayC5}），但当日实时 ${todayDisplayC5} ≥ 10（截至 ${fmtMinuteC5}），未触发`)
          : `前两日抗分歧指数均 < 10（${prevDisplayC5}），当日实时 ${todayDisplayC5} < 10（截至 ${fmtMinuteC5}），个股连续弱势，触发卖点`,
    subConditions: [
      { label: '前两日抗分歧（全天）', value: prevDisplayC5 },
      { label: '当日实时抗分歧', value: `${todayDisplayC5}（截至 ${fmtMinuteC5}）` },
      { label: '当前时间', value: fmtMinuteC5 },
      { label: '生效时间', value: '9:40 后' },
      { label: '阈值', value: '连续3日均 < 10' },
    ],
  };

  // ===== 条件6：现价跌破最迟一天买入（买入日 buyDate）当日的最低点 —— 需持续 ≥5 分钟 =====
  const lastBuyDayRaw = String(position?.buyDate || '').replace(/-/g, '');
  let condition6 = {
    name: '跌破最迟买入日低点',
    satisfied: false,
    pending: false,
    pendingMinutes: 0,
    detail: '',
    subConditions: [],
  };
  const stockEntry6 = (replayStocks || []).find(s => s.code === code);
  const dailyLowMap = stockEntry6?.dailyLowMap || {};
  if (!lastBuyDayRaw) {
    condition6.detail = '该模拟持仓无买入日期，无法判断最迟买入日低点';
    condition6.subConditions = [{ label: '状态', value: '无买入日期' }];
  } else {
    const buyDayLowRaw = dailyLowMap[parseInt(lastBuyDayRaw)];
    const buyDayLow = buyDayLowRaw != null ? toNumber(buyDayLowRaw) : null;
    if (buyDayLow === null || buyDayLow <= 0) {
      condition6.detail = `最迟买入日 ${lastBuyDayRaw} 无日K线最低价数据，无法判断`;
      condition6.subConditions = [{ label: '状态', value: '无K线数据' }];
    } else {
      const brokenBuyDayLow = closePrice < buyDayLow;
      const persist6 = brokenBuyDayLow
        ? checkBuyDayLowPersist(replayStocks, code, minute, buyDayLow)
        : { satisfied: false, checkedMin: 0 };
      condition6.satisfied = persist6.satisfied;
      condition6.pending = brokenBuyDayLow && !persist6.satisfied;
      condition6.pendingMinutes = brokenBuyDayLow ? persist6.checkedMin : 0;
      condition6.detail = brokenBuyDayLow
        ? `现价 ${closePrice.toFixed(2)} 已跌破最迟买入日（${lastBuyDayRaw}）最低价 ${buyDayLow.toFixed(2)}，买入成本线告破${condition6.pending ? `（已持续 ${persist6.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟才触发）` : ''}`
        : `现价 ${closePrice.toFixed(2)} 未跌破最迟买入日（${lastBuyDayRaw}）最低价 ${buyDayLow.toFixed(2)}，暂不触发`;
      condition6.subConditions = [
        { label: '最迟买入日', value: lastBuyDayRaw },
        { label: '买入日最低价', value: buyDayLow.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
      ];
    }
  }

  // ===== 条件7：现价跌破持仓成本线 -2%（即时触发，无需持续分钟；成本线 = 模拟持仓买入价 buyPrice） =====
  // 阈值可按持仓覆盖（position.costLinePct，百分比数值，默认 2）
  // 统一成本线覆盖（2026-10-20「两次买入（同一天）」变体）：调用方可传 position.costLinePrice
  //（= 两次买入价均值，两份共用）作为成本线基准；未传时回落到买入价 buyPrice。
  // 仅影响本条件止损阈值判定；returnRate 仍按实际买入价 buyPrice 计算
  // 竞价低开自救窗口（2026-10-05 新增；2026-10-08 修订）：隔夜持仓当日竞价开盘价（首分钟价）已跌破成本线 -xx% 时，
  //   不在 9:30 直接止损——大低开往往开盘先直线拉升（资金自救），逐分钟跟踪：
  //   拉升过程中（尚未出现「某分钟价低于上一分钟」的回落）继续持有（即使仍在成本线下方）；
  //   若拉升把价格回补到阈值上方，则视为自救成功、不再止损，待后续再次跌破阈值时再卖；
  //   只有当「拉升结束、开始回落」且该回落分钟价仍跌破阈值时，才卖出（按该回落分钟价成交，卖出原因标注回落分钟）。
  //   若开盘价未跌破成本线、盘中才跌破 → 维持原即时止损（该卖就得卖）。
  const costLinePct = position?.costLinePct != null && Number.isFinite(Number(position.costLinePct)) ? Number(position.costLinePct) : 2;
  const costLineRatio = 1 - costLinePct / 100;
  const costLineBase = position?.costLinePrice != null && Number.isFinite(Number(position.costLinePrice)) && Number(position.costLinePrice) > 0
    ? Number(position.costLinePrice)
    : buyPrice;
  const costLineThreshold = costLineBase !== null && costLineBase > 0 ? costLineBase * costLineRatio : null;
  const openBrokeCostLine = costLineThreshold !== null && openPrice != null && openPrice > 0 && openPrice < costLineThreshold;
  // 自救窗口观察：在截至当前桶的分时点中找首个「分钟价低于上一分钟、且该分钟价仍跌破阈值」的回落点
  //（stockPoints 已按分钟升序、过滤无效价）——若拉升已回补至阈值上方，此时的回落不计入；待再次跌破阈值并回落才触发
  let costLineFirstDecline = null;
  if (openBrokeCostLine) {
    for (let i = 1; i < stockPoints.length; i++) {
      if (stockPoints[i].lastPx < stockPoints[i - 1].lastPx && stockPoints[i].lastPx < costLineThreshold) {
        costLineFirstDecline = { minute: stockPoints[i].minute, lastPx: stockPoints[i].lastPx, prevMinute: stockPoints[i - 1].minute, prevPx: stockPoints[i - 1].lastPx };
        break;
      }
    }
  }
  const brokenCostLine = costLineThreshold !== null && closePrice < costLineThreshold;
  // 触发判定：开盘已破线 → 只在「回落且该分钟仍跌破阈值」时触发（回补至阈值上方则不再止损、待再次跌破再卖）；开盘未破线 → 原即时止损
  const condition7Satisfied = openBrokeCostLine ? costLineFirstDecline !== null : brokenCostLine;
  const fmtMinuteC7 = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
  // 精确分钟回溯（2026-10-05 新增）：回测按 5 分钟桶触发本卖点后，逐分钟回溯定位真实触发分钟并按该分钟分时价成交
  //（线上环境在触发当分钟即已卖出，桶级成交最多晚 4 分钟，回溯后回测更贴近实盘）：
  //   - 盘中破线：从桶前一分钟向回逐分钟检查是否仍跌破成本线阈值，直到首次不跌破（或回溯至 9:30 开盘）为止，
  //     取该段连续跌破区间的最早一分钟为成交分钟；若破线就发生在当前桶（前一分钟未跌破）→ 维持按桶价成交；
  //   - 开盘破线（自救窗口）：卖出分钟本就是「回落且该分钟仍跌破阈值」的精确分钟，成交价由桶价改为该回落分钟价
  //     （与线上在回落当分钟立即卖出一致）。
  let condition7PreciseSell = null; // { minute, price }
  if (condition7Satisfied && costLineThreshold !== null) {
    if (openBrokeCostLine) {
      if (costLineFirstDecline !== null) {
        condition7PreciseSell = { minute: costLineFirstDecline.minute, price: costLineFirstDecline.lastPx };
      }
    } else if (brokenCostLine) {
      let walkStart = -1;
      for (let i = stockPoints.length - 1; i >= 0; i--) {
        if (stockPoints[i].minute < minute) { walkStart = i; break; }
      }
      for (let i = walkStart; i >= 0; i--) {
        if (!(stockPoints[i].lastPx < costLineThreshold)) break;
        condition7PreciseSell = { minute: stockPoints[i].minute, price: stockPoints[i].lastPx };
      }
    }
  }
  const condition7 = {
    name: `跌破成本线-${costLinePct}%`,
    satisfied: condition7Satisfied,
    detail: costLineThreshold === null
      ? `该模拟持仓无买入价格，无法判断是否跌破成本线 -${costLinePct}%`
      : openBrokeCostLine
        ? (costLineFirstDecline !== null
          ? `竞价开盘 ${openPrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（成本线基准 ${costLineBase.toFixed(2)}），自救拉升已于 ${fmtMinuteC7(costLineFirstDecline.minute)} 回落（${fmtMinuteC7(costLineFirstDecline.minute)} 价 ${costLineFirstDecline.lastPx.toFixed(2)} 低于 ${fmtMinuteC7(costLineFirstDecline.prevMinute)} 价 ${costLineFirstDecline.prevPx.toFixed(2)}）且仍跌破阈值，卖出，按回落分钟 ${fmtMinuteC7(costLineFirstDecline.minute)} 价格 ${costLineFirstDecline.lastPx.toFixed(2)} 成交`
          : `竞价开盘 ${openPrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（成本线基准 ${costLineBase.toFixed(2)}），开盘后资金拉升中（尚无「回落且仍跌破阈值」信号；若回补至阈值上方则不自救止损、待再次跌破再卖），自救窗口观察中、暂不卖出`)
        : brokenCostLine
          ? `现价 ${closePrice.toFixed(2)} 已跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（成本线基准 ${costLineBase.toFixed(2)}），触发卖点${condition7PreciseSell !== null ? `；逐分钟回溯：实际于 ${fmtMinuteC7(condition7PreciseSell.minute)} 首次跌破（价 ${condition7PreciseSell.price.toFixed(2)}），按该分钟价格成交（桶级 ${displayTime}）` : '（破线发生在当前桶，按桶价成交）'}`
          : `现价 ${closePrice.toFixed(2)} 未跌破成本线 -${costLinePct}% 阈值 ${costLineThreshold.toFixed(2)}（成本线基准 ${costLineBase.toFixed(2)}），未触发`,
    subConditions: [
      { label: '成本线基准', value: costLineBase !== null && costLineBase > 0 ? costLineBase.toFixed(2) : '--' },
      { label: `阈值（成本价-${costLinePct}%）`, value: costLineThreshold !== null ? costLineThreshold.toFixed(2) : '--' },
      { label: '开盘价（首分钟）', value: openPrice != null && openPrice > 0 ? openPrice.toFixed(2) : '--' },
      { label: '现价', value: closePrice.toFixed(2) },
      ...(openBrokeCostLine ? [{ label: '自救窗口', value: costLineFirstDecline !== null ? `已于 ${fmtMinuteC7(costLineFirstDecline.minute)} 回落（仍跌破阈值，卖出）` : '进行中（拉升中/已回补阈值上方，暂不卖）' }] : []),
      { label: '判断规则', value: openBrokeCostLine ? '开盘破线 → 拉升中持有；回补至阈值上方则不再止损、待再次跌破阈值再卖；回落时仍跌破阈值才卖。盘中破线 → 现价 < 成本价 × 阈值即时卖' : `现价 < 成本价 × ${costLineRatio.toFixed(2)} 即触发` },
    ],
  };

  const conditions = [condition1, condition2, condition3, condition4, condition5, condition6, condition7];
  const satisfiedCount = conditions.filter(c => c.satisfied).length;
  const isSell = satisfiedCount > 0;
  // 条件7 命中时用回溯出的精确触发分钟价/时间成交（对齐线上在触发当分钟即卖出的行为；尾盘抄底专属卖点同模式）
  const usePreciseSell = condition7Satisfied && condition7PreciseSell !== null;
  const finalSellPrice = usePreciseSell ? condition7PreciseSell.price : closePrice;
  const finalDisplayTime = usePreciseSell ? fmtMinuteC7(condition7PreciseSell.minute) : displayTime;
  const returnRate = buyPrice !== null && buyPrice > 0
    ? parseFloat((((finalSellPrice - buyPrice) / buyPrice) * 100).toFixed(2))
    : null;

  return {
    isSell,
    code,
    stockName,
    closePrice: parseFloat(finalSellPrice.toFixed(2)),
    change: change !== null ? parseFloat(change.toFixed(2)) : null,
    returnRate,
    dayHigh: dayHigh > 0 ? parseFloat(dayHigh.toFixed(2)) : null,
    techEmotion,
    resilienceScore,
    conditions,
    conclusion: isSell
      ? `共触发 ${satisfiedCount} 个卖出条件（${conditions.filter(c => c.satisfied).map(c => c.name).join('、')}），建议卖出离场${usePreciseSell ? `；按 ${finalDisplayTime} 分时价 ${finalSellPrice.toFixed(2)} 精确成交` : ''}`
      : '所有卖出条件均未触发，当前可继续持有',
    displayTime: finalDisplayTime,
  };
};

// ============================================================
// 回放股票结构构建（对齐 trainingCamp/index.jsx 中 replayStocks 的 useMemo 构建逻辑，全量时间桶）
// ============================================================

module.exports = {
  calculateReplayResilience,
  checkBuyDayLowPersist,
  checkCondition2Persist,
  checkCondition3Persist,
  getReplayLimitType,
  getTlinePoints,
  runSellPointDiagnosis,
  toNumber,
};
