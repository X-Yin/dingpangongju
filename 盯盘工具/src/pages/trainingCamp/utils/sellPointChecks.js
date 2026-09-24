// 训练营回放 - 模拟持仓卖点诊断
// 基于回放时间桶数据计算 7 项卖出条件（满足任一即触发卖点），完全对齐后端
// server/src/service/buySellDiagnose.js 的 checkSellPointDetailed 逻辑（均线破位 / 高位放量大阴线 / 科技板块情绪退潮 / 抗分歧指数弱势 / 连续三日抗分歧弱势 / 跌破最迟买入日低点 / 跌破成本线-2%）：
//   1. 均线破位（真实日K线 MA10，由后端按回放日期计算下发；10日线斜率为负时屏蔽跌破10日线条件，
//      改用「现价不跌破前一交易日最低价」判断；斜率非负时 9:30-14:50 需跌破10日线且涨幅<-3%，14:50后跌破即触发）
//   2. 高位放量大阴线（日内最高价到现价回落超过 8%，且现价低于日内开盘价）—— 需持续 ≥5 分钟才触发
//   3. 科技板块情绪退潮 == -100 且自选股中跌幅 <-9% 的个股 >= 5 个 —— 需持续 ≥5 分钟才触发
//   4. 抗分歧指数 < 6 且 当前涨幅 ≤ -5%
//   5. 连续三日（含当日）抗分歧指数均 < 10：前两日用后端预计算的全天分数（resilience3dScores 前 2 位），
//      当日为实时口径（分钟级/桶级分时截至当前分钟现算，与叠加分时 tag 同口径），仅 9:40 后生效
//   6. 现价跌破最迟一天买入（模拟持仓买入日 buyDate）当日的最低点（后端下发 dailyLowMap，按 buyDate 取低点）—— 需持续 ≥5 分钟才触发
//   7. 现价跌破持仓成本线的 -2%（成本线 = 模拟持仓买入价 buyPrice，现价 < buyPrice × 0.98 即触发）
import { calculateReplayResilience, getReplayMinuteTlineByDate } from '../../../utils/replayResilience';

const SELL_CONDITION_PERSIST_MIN = 5; // 持续满足分钟数

const fmtTime = (timeKey) => {
  const t = String(timeKey || '').padStart(6, '0');
  if (t.length < 4) return '--:--';
  return `${t.substring(0, 2)}:${t.substring(2, 4)}`;
};

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
// 利用股票 tline 数据，逐分钟检查从 dayHigh 到该分钟 lastPx 的回落是否 > 8% 且 lastPx < openPrice
const checkCondition2Persist = (replayStocks, code, currentMinute, openPrice, dayHigh) => {
  const PERSIST_MIN = SELL_CONDITION_PERSIST_MIN;
  // 获取该股票完整分时序列
  const entry = (replayStocks || []).find(s => s.code === code);
  if (!entry || !entry.tlinePoints || entry.tlinePoints.length === 0) return { satisfied: false, checkedMin: 0 };
  // 按 minute 升序排列
  const sorted = [...entry.tlinePoints]
    .filter(p => p.minute != null && p.minute <= currentMinute && p.lastPx != null && p.lastPx > 0)
    .sort((a, b) => a.minute - b.minute);
  if (sorted.length === 0) return { satisfied: false, checkedMin: 0 };

  // 取过去 PERSIST_MIN 个分钟点（含当前），至少要有 1 个点
  const recent = sorted.slice(-PERSIST_MIN);
  if (recent.length < PERSIST_MIN) {
    // 数据不足 5 分钟，能检查多少算多少，但必须全部满足
    return { satisfied: false, checkedMin: recent.length };
  }
  // 计算截至每个检查点的日内最高价
  for (let i = 0; i < recent.length; i++) {
    // 该分钟之前（含）的最高价
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
// timeBuckets 为 5 分钟粒度，逐桶向前检查条件是否满足，累计覆盖分钟数
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
    // 计算该桶覆盖的分钟数
    const bucketMinute = toNumber(bucket?.minute);
    if (bucketMinute === null || bucketMinute === undefined) break;
    if (i === currentIndex) {
      // 当前桶：假设已覆盖 5 分钟（timeBuckets 为 5min 粒度）
      coveredMin += 5;
    } else {
      const prevBucketMinute = toNumber(timeBuckets[i + 1]?.minute);
      if (prevBucketMinute !== null && prevBucketMinute !== undefined) {
        coveredMin += prevBucketMinute - bucketMinute;
      } else {
        coveredMin += 5; // fallback
      }
    }
    if (coveredMin >= PERSIST_MIN) {
      return { satisfied: true, checkedMin: coveredMin };
    }
  }
  return { satisfied: false, checkedMin: coveredMin };
};

// 检查条件6（跌破最迟买入日低点）在过去 N 分钟内是否持续满足
// 利用股票 tline 数据，逐分钟检查 lastPx 是否持续 < buyDayLow
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

const runSellPointDiagnosis = (position, currentBucket, replayStocks, timeBuckets, currentIndex, dateStr = '') => {
  const code = position?.code;
  const stockName = position?.stockName || position?.name || code;
  const buyPrice = toNumber(position?.buyPrice);
  const stockChanges = currentBucket?.stockChanges || [];
  const stock = stockChanges.find(s => s.code === code);
  const closePrice = stock?.lastPx != null ? toNumber(stock.lastPx) : null;
  const minute = currentBucket?.minute;
  const displayTime = currentBucket?.displayTime || fmtTime(currentBucket?.timeKey);

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

  // 当日分时序列（截至当前时间桶），已过滤无效价格
  const stockPoints = getTlinePoints(replayStocks, code, minute).filter(p => p.lastPx != null && p.lastPx > 0);
  const dayHigh = stockPoints.reduce((mx, p) => Math.max(mx, p.lastPx), 0);
  const openPrice = stockPoints.length > 0 ? stockPoints[0].lastPx : null;

  // ===== 条件1：均线破位（根据 MA5/MA10 斜率 + 开盘价位置，四种情况判断）=====
  // 后端 trainingCamp.js 拉取日K线，计算截至回放日期的 MA5/MA5斜率/MA10/MA10斜率与前一日最低价，随 stockChanges 下发
  //   ① MA10斜率<0, MA5斜率>0, 开盘价>MA10 → 跌破MA10为卖点
  //   ② MA10斜率<0, MA5斜率≤0 → 跌破前一日最低价为卖点
  //   ③ MA10斜率<0, MA5斜率>0, 开盘价≤MA10 → 跌破MA5为卖点
  //   ④ MA10斜率≥0（含数据不足）→ 跌破MA10为卖点
  // 9:30-14:50 盘中规则①③④需跌破且涨幅<-3%才触发，14:50后跌破即触发；规则②全天生效
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

    // 判定属于哪种情况
    let ruleType = 4;
    let slopeInfo = '';
    if (ma10Slope !== null && ma10Slope < 0) {
      // MA10斜率为负
      if (ma5Slope !== null && ma5Slope > 0) {
        // MA5斜率为正 → 根据开盘价位置区分规则①和③
        if (openPrice !== null && openPrice > ma10) {
          ruleType = 1;
        } else {
          ruleType = 3;
        }
      } else {
        // MA5斜率≤0（含数据不足）→ 规则②
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

    // 辅助：构建规则①③④的 detail 文本
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
      // 规则①：MA10斜率<0, MA5斜率>0, 开盘价>MA10 → 跌破MA10为卖点
      const broken = closePrice < ma10;
      condition1.satisfied = broken && (!inTradingWindow || deepFall);
      const openPos = openPrice !== null && openPrice > ma10 ? '上方' : '附近或下方';
      condition1.detail = formatBreakDetail(broken, ma10, '10日线');
      if (!broken || !inTradingWindow || deepFall) {
        condition1.detail += `（${slopeInfo}，开盘价在10日线${openPos}，采用规则①）`;
      }
      condition1.subConditions = [
        { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
        { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
        { label: '开盘价', value: openPrice !== null ? openPrice.toFixed(2) : '--' },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '10日线', value: ma10.toFixed(2) },
        { label: '当前涨幅', value: change !== null ? `${change.toFixed(2)}%` : '--' },
        { label: '判断规则', value: '规则①：MA10↓ MA5↑ 开盘>MA10 → 跌破MA10' },
      ];
    } else if (ruleType === 2) {
      // 规则②：MA10斜率<0, MA5斜率≤0 → 跌破前一日最低价为卖点（全天生效）
      const brokenPrevLow = prevLow !== null && closePrice < prevLow;
      condition1.satisfied = brokenPrevLow;
      condition1.detail = prevLow === null
        ? `${slopeInfo}，改用前低判断，但缺少前一交易日最低价数据`
        : brokenPrevLow
          ? `${slopeInfo}，现价 ${closePrice.toFixed(2)} 跌破前一交易日最低价 ${prevLow.toFixed(2)}，下降趋势延续，触发卖点`
          : `${slopeInfo}，现价 ${closePrice.toFixed(2)} 未跌破前一交易日最低价 ${prevLow.toFixed(2)}，暂不触发`;
      condition1.subConditions = [
        { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
        { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '前一日最低价', value: prevLow !== null ? prevLow.toFixed(2) : '--' },
        { label: '判断规则', value: '规则②：MA10↓ MA5↓ → 跌破前一日最低价' },
      ];
    } else if (ruleType === 3) {
      // 规则③：MA10斜率<0, MA5斜率>0, 开盘价≤MA10 → 跌破MA5为卖点
      if (ma5 !== null) {
        const broken = closePrice < ma5;
        condition1.satisfied = broken && (!inTradingWindow || deepFall);
        const openPos = openPrice !== null && openPrice <= ma10 ? '下方或附近' : '上方';
        condition1.detail = formatBreakDetail(broken, ma5, '5日线');
        if (!broken || !inTradingWindow || deepFall) {
          condition1.detail += `（${slopeInfo}，开盘价在10日线${openPos}，采用规则③）`;
        }
        condition1.subConditions = [
          { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
          { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
          { label: '开盘价', value: openPrice !== null ? openPrice.toFixed(2) : '--' },
          { label: '现价', value: closePrice.toFixed(2) },
          { label: '5日线', value: ma5.toFixed(2) },
          { label: '10日线', value: ma10.toFixed(2) },
          { label: '当前涨幅', value: change !== null ? `${change.toFixed(2)}%` : '--' },
          { label: '判断规则', value: '规则③：MA10↓ MA5↑ 开盘≤MA10 → 跌破MA5' },
        ];
      } else {
        condition1.detail = `${slopeInfo}，缺少MA5数据，无法按规则③判断`;
        condition1.subConditions = [
          { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
          { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
          { label: '状态', value: 'MA5数据不足' },
        ];
      }
    } else {
      // 规则④：MA10斜率≥0（含数据不足）→ 跌破MA10为卖点
      const broken = closePrice < ma10;
      condition1.satisfied = broken && (!inTradingWindow || deepFall);
      condition1.detail = formatBreakDetail(broken, ma10, '10日线');
      if (broken && (!inTradingWindow || deepFall)) {
        condition1.detail += `（${slopeInfo}，上升趋势中跌破MA10）`;
      }
      condition1.subConditions = [
        { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
        { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '10日线', value: ma10.toFixed(2) },
        { label: '当前涨幅', value: change !== null ? `${change.toFixed(2)}%` : '--' },
        { label: '当前时间', value: displayTime || '--' },
        { label: '判断规则', value: '规则④：MA10↑ → 跌破MA10' },
      ];
    }
  }

  // ===== 条件2：高位放量大阴线（日内最高价到现价回落超过 8%，且现价低于日内开盘价）—— 需持续 ≥5 分钟 =====
  const amplitude = closePrice > 0 ? ((dayHigh - closePrice) / closePrice) * 100 : 0;
  const isCondition2RawTrue = openPrice !== null && amplitude > 8 && closePrice < openPrice;
  const cond2Persist = isCondition2RawTrue
    ? checkCondition2Persist(replayStocks, code, minute, openPrice, dayHigh)
    : { satisfied: false, checkedMin: 0 };
  const condition2 = {
    name: '高位放量大阴线',
    satisfied: cond2Persist.satisfied,
    pending: isCondition2RawTrue && !cond2Persist.satisfied,
    pendingMinutes: isCondition2RawTrue ? cond2Persist.checkedMin : 0,
    detail: openPrice !== null
      ? `回落 ${amplitude.toFixed(2)}%${amplitude > 8 ? ' > 8%' : ' ≤ 8%'}，现价 ${closePrice.toFixed(2)}${closePrice < openPrice ? ' < 开盘' : ' ≥ 开盘'}，${amplitude > 8 && closePrice < openPrice ? '为高位大阴线' : '未触发'}${isCondition2RawTrue && !cond2Persist.satisfied ? `（已持续 ${cond2Persist.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）` : ''}`
      : '无日内开盘价数据，无法判断',
    subConditions: [
      { label: '日内开盘价', value: openPrice !== null ? openPrice.toFixed(2) : '--' },
      { label: '日内最高价', value: dayHigh > 0 ? dayHigh.toFixed(2) : '--' },
      { label: '现价', value: closePrice.toFixed(2) },
      { label: '回落幅度', value: `${amplitude.toFixed(2)}%` },
      { label: '判断规则', value: `回落 > 8% 且 现价 < 开盘价（持续≥${SELL_CONDITION_PERSIST_MIN}分钟才触发）` },
    ],
  };

  // ===== 条件3：科技板块情绪退潮 == -100，且自选股中跌幅 <-9% 的个股 >= 5 个 —— 需持续 ≥5 分钟 =====
  const techEmotion = toNumber(currentBucket?.techEmotion);
  const downStocksCount = (currentBucket?.stockChanges || []).filter(s => {
    const pct = toNumber(s.changePct);
    return pct !== null && pct < -9;
  }).length;
  const techCrash = techEmotion !== null && techEmotion === -100;
  const isCondition3RawTrue = techCrash && downStocksCount >= 5;
  const cond3Persist = isCondition3RawTrue
    ? checkCondition3Persist(timeBuckets, currentIndex)
    : { satisfied: false, checkedMin: 0 };
  const condition3 = {
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
    subConditions: [
      { label: '科技情绪指数', value: techEmotion !== null ? techEmotion.toFixed(2) : '--' },
      { label: '阈值', value: `= -100（持续≥${SELL_CONDITION_PERSIST_MIN}分钟才触发）` },
      { label: '跌幅<-9%自选股', value: `${downStocksCount} 个（需>=5）` },
    ],
  };

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
    subConditions: [
      { label: '抗分歧指数', value: resilienceScore !== null ? resilienceScore.toFixed(2) : '--' },
      { label: '当前涨幅', value: change !== null ? `${change.toFixed(2)}%` : '--' },
      { label: '当前时间', value: displayTime || '--' },
      { label: '跟踪指数', value: isSh688 ? '科创板' : '创业板' },
      { label: '阈值', value: '< 6 且 涨幅 ≤ -5%（14:50后生效）' },
    ],
  };

  // ===== 条件5：连续三日（含当日）抗分歧指数均 < 10（个股连续弱势，资金持续分歧），仅 9:40 后生效 =====
  // 前两日用后端预计算的全天分数（resilience3dScores 前 2 位，历史数据）；当日为实时口径：
  // 优先用分钟级分时截至当前分钟现算（与叠加分时 tag 同源缓存），回退桶级 tlinePoints 现算；
  // 不再使用预计算的收盘口径 resilience3dAllBelow10（当日全天分数在回放时点属于未来数据）
  const r3dScores = Array.isArray(stock?.resilience3dScores) ? stock.resilience3dScores : [];
  const prev1C5 = r3dScores.length > 0 ? r3dScores[0] : null;
  const prev2C5 = r3dScores.length > 1 ? r3dScores[1] : null;
  const prevOkC5 = prev1C5 != null && prev2C5 != null && prev1C5 < 10 && prev2C5 < 10;
  const isAfter940C5 = minute != null && minute >= 940;
  const benchmarkCodeC5 = String(code).startsWith('sh688') ? 'sh000688' : 'sz399006';
  const stockMinuteC5 = dateStr ? getReplayMinuteTlineByDate(code, dateStr) : null;
  const indexMinuteC5 = dateStr ? getReplayMinuteTlineByDate(benchmarkCodeC5, dateStr) : null;
  let todayScoreC5 = null;
  if (minute != null && Array.isArray(stockMinuteC5) && Array.isArray(indexMinuteC5)) {
    todayScoreC5 = calculateReplayResilience(
      stockMinuteC5.filter(p => p.minute <= minute),
      indexMinuteC5.filter(p => p.minute <= minute),
      code
    );
  }
  if (todayScoreC5 == null && minute != null) {
    todayScoreC5 = calculateReplayResilience(
      getTlinePoints(replayStocks, code, minute),
      getTlinePoints(replayStocks, benchmarkCodeC5, minute),
      code
    );
  }
  const todayOkC5 = todayScoreC5 != null && todayScoreC5 < 10;
  const allBelow10C5 = prevOkC5 && todayOkC5;
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
            ? `当日实时抗分歧分数数据不足（截至 ${displayTime}），未触发`
            : `前两日均 < 10（${prevDisplayC5}），但当日实时 ${todayDisplayC5} ≥ 10（截至 ${displayTime}），未触发`)
          : `前两日抗分歧指数均 < 10（${prevDisplayC5}），当日实时 ${todayDisplayC5} < 10（截至 ${displayTime}），个股连续弱势，触发卖点`,
    subConditions: [
      { label: '前两日抗分歧（全天）', value: prevDisplayC5 },
      { label: '当日实时抗分歧', value: `${todayDisplayC5}（截至 ${displayTime}）` },
      { label: '当前时间', value: displayTime || '--' },
      { label: '生效时间', value: '9:40 后' },
      { label: '阈值', value: '连续3日均 < 10' },
    ],
  };

  // ===== 条件6：现价跌破最迟一天买入（模拟持仓买入日 buyDate）当日的最低点 —— 需持续 ≥5 分钟 =====
  // 最迟一天买入：模拟持仓的买入日期 buyDate（YYYYMMDD）；后端下发每日最低价映射 dailyLowMap，按 buyDate 取该日最低价，
  // 现价跌破该低点（买入成本线告破）并持续 ≥5 分钟即触发。
  const lastBuyDayRaw = String(position?.buyDate || '').replace(/-/g, '');
  const buyDayDisplay = lastBuyDayRaw.length === 8
    ? `${lastBuyDayRaw.substring(4, 6)}-${lastBuyDayRaw.substring(6, 8)}`
    : (lastBuyDayRaw || '--');
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
      condition6.detail = `最迟买入日 ${buyDayDisplay} 无日K线最低价数据，无法判断`;
      condition6.subConditions = [
        { label: '最迟买入日', value: buyDayDisplay },
        { label: '状态', value: '无K线数据' },
      ];
    } else {
      const brokenBuyDayLow = closePrice < buyDayLow;
      const persist6 = brokenBuyDayLow
        ? checkBuyDayLowPersist(replayStocks, code, minute, buyDayLow)
        : { satisfied: false, checkedMin: 0 };
      condition6.satisfied = persist6.satisfied;
      condition6.pending = brokenBuyDayLow && !persist6.satisfied;
      condition6.pendingMinutes = brokenBuyDayLow ? persist6.checkedMin : 0;
      condition6.detail = brokenBuyDayLow
        ? `现价 ${closePrice.toFixed(2)} 已跌破最迟买入日（${buyDayDisplay}）最低价 ${buyDayLow.toFixed(2)}，买入成本线告破${condition6.pending ? `（已持续 ${persist6.checkedMin} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟才触发）` : ''}`
        : `现价 ${closePrice.toFixed(2)} 未跌破最迟买入日（${buyDayDisplay}）最低价 ${buyDayLow.toFixed(2)}，暂不触发`;
      condition6.subConditions = [
        { label: '最迟买入日', value: buyDayDisplay },
        { label: '买入日最低价', value: buyDayLow.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '判断规则', value: `现价跌破最迟买入日最低价（持续≥${SELL_CONDITION_PERSIST_MIN}分钟才触发）` },
      ];
    }
  }

  // ===== 条件7：现价跌破持仓成本线 -2%（即时触发，无需持续分钟；成本线 = 模拟持仓买入价 buyPrice） =====
  const costLineThreshold = buyPrice !== null && buyPrice > 0 ? buyPrice * 0.98 : null;
  const brokenCostLine = costLineThreshold !== null && closePrice < costLineThreshold;
  const condition7 = {
    name: '跌破成本线-2%',
    satisfied: brokenCostLine,
    detail: costLineThreshold === null
      ? '该模拟持仓无买入价格，无法判断是否跌破成本线 -2%'
      : brokenCostLine
        ? `现价 ${closePrice.toFixed(2)} 已跌破成本线 -2% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），触发卖点`
        : `现价 ${closePrice.toFixed(2)} 未跌破成本线 -2% 阈值 ${costLineThreshold.toFixed(2)}（买入价 ${buyPrice.toFixed(2)}），未触发`,
    subConditions: [
      { label: '买入价（成本线）', value: buyPrice !== null && buyPrice > 0 ? buyPrice.toFixed(2) : '--' },
      { label: '阈值（成本价-2%）', value: costLineThreshold !== null ? costLineThreshold.toFixed(2) : '--' },
      { label: '现价', value: closePrice.toFixed(2) },
      { label: '判断规则', value: '现价 < 成本价 × 0.98 即触发' },
    ],
  };

  const conditions = [condition1, condition2, condition3, condition4, condition5, condition6, condition7];
  const satisfiedCount = conditions.filter(c => c.satisfied).length;
  const isSell = satisfiedCount > 0;
  const returnRate = buyPrice !== null && buyPrice > 0
    ? parseFloat((((closePrice - buyPrice) / buyPrice) * 100).toFixed(2))
    : null;

  let conclusion;
  if (isSell) {
    const satisfiedNames = conditions.filter(c => c.satisfied).map(c => c.name).join('、');
    conclusion = `共触发 ${satisfiedCount} 个卖出条件（${satisfiedNames}），建议卖出离场${returnRate !== null ? `，本次收益率 ${returnRate >= 0 ? '+' : ''}${returnRate.toFixed(2)}%` : ''}`;
  } else {
    conclusion = '所有卖出条件均未触发，当前可继续持有';
  }

  return {
    isSell,
    code,
    stockName,
    closePrice: parseFloat(closePrice.toFixed(2)),
    change: change !== null ? parseFloat(change.toFixed(2)) : null,
    returnRate,
    dayHigh: dayHigh > 0 ? parseFloat(dayHigh.toFixed(2)) : null,
    techEmotion,
    resilienceScore,
    conditions,
    conclusion,
    displayTime,
  };
};

export default runSellPointDiagnosis;
