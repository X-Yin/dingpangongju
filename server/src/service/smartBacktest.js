/**
 * 智能回测诊断服务
 *
 * 策略：
 *   1. 3日线斜率 - 按MA3斜率从高到低排序，取前3
 *   2. 抗分歧分数前三 - 按当日抗分歧分数从高到低排序，取前3
 *   3. 涨幅前三 - 按当日涨幅从高到低排序，取前3
 *
 * 大盘买点条件（创业板和科创板分别判断）：
 *   ① 前一日为情绪冰点
 *   ② 跟踪指数当日涨幅 > 1%（sh688 跟踪科创板，其他跟踪创业板）
 *   ③ 当天科技情绪指数 ≥ -40
 *
 * 卖点：复用现有 checkSellPoint 逻辑（MA10破位/高位大阴线/情绪退潮/抗分歧<6）
 */
const dayjs = require('dayjs');
const { getSingleStockData, getSingleStockTlineDataByDate } = require('./stock');
const { getAllTechIndexData, getAllIndexKlineData } = require('./emotion');
const { getMonitorStocks } = require('./monitorStock');
const { calculateResilience, getLimitTypeByCode } = require('./stockDiagnose');
const { sleep } = require('../utils');

// ========== 工具函数 ==========

const formatDateStr = (dateNum) => {
  const str = String(dateNum);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
};

const dateNumToStr = (dateNum) => {
  const s = String(dateNum);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
};

const parseDateNum = (dateNum) => {
  const str = String(dateNum);
  return new Date(
    parseInt(str.substring(0, 4)),
    parseInt(str.substring(4, 6)) - 1,
    parseInt(str.substring(6, 8))
  );
};

/**
 * 判断情绪冰点（复用 buySellDiagnose 中的逻辑）
 * 条件：前一日情绪 < -40 或 当日 hasIce / 前两日连续为负 / 前三天均值为负（前提：前一日情绪 ≤ 45）
 * @param {Array} techIndexData - 科技情绪数据
 * @param {number|string} targetDate - 目标日期 YYYYMMDD
 * @returns {{ isFreezing: boolean, reason: string }}
 */
const isEmotionFreezing = (techIndexData, targetDate) => {
  if (!Array.isArray(techIndexData) || techIndexData.length === 0) return { isFreezing: false, reason: '无科技情绪数据' };

  const target = parseInt(targetDate);
  const sorted = [...techIndexData].sort((a, b) => a.date - b.date);
  const before = sorted.filter(item => parseInt(item.date) < target);
  if (before.length === 0) return { isFreezing: false, reason: '无历史情绪数据' };

  const prev1 = before[before.length - 1];
  const prev2 = before.length >= 2 ? before[before.length - 2] : null;
  const prev3 = before.length >= 3 ? before[before.length - 3] : null;

  const todayData = sorted.find(item => parseInt(item.date) === target);
  const todayHasIce = todayData && todayData.hasIce === true;

  if (todayHasIce) {
    return { isFreezing: true, reason: `当日(${formatDateStr(target)})盘中有分时触及冰点（hasIce）`, prev1, prev2, prev3 };
  }
  if (prev1 && typeof prev1.changeSumResult === 'number' && prev1.changeSumResult < -40) {
    return { isFreezing: true, reason: `前一日(${formatDateStr(prev1.date)})科技情绪指数 ${prev1.changeSumResult} < -40`, prev1, prev2, prev3 };
  }

  if (Number(prev1.changeSumResult) > 45) {
    return { isFreezing: false, reason: '前一日情绪 > 45，不触发冰点', prev1, prev2, prev3 };
  }

  if (prev1 && prev2 &&
    typeof prev1.changeSumResult === 'number' && typeof prev2.changeSumResult === 'number' &&
    prev1.changeSumResult < 0 && prev2.changeSumResult < 0) {
    return { isFreezing: true, reason: `前两日科技情绪指数连续为负`, prev1, prev2, prev3 };
  }

  if (prev1 && prev2 && prev3 &&
    typeof prev1.changeSumResult === 'number' && typeof prev2.changeSumResult === 'number' && typeof prev3.changeSumResult === 'number') {
    const avg3 = (prev1.changeSumResult + prev2.changeSumResult + prev3.changeSumResult) / 3;
    if (avg3 < 0) {
      return { isFreezing: true, reason: `前三天科技情绪指数平均值 ${avg3.toFixed(2)} < 0`, prev1, prev2, prev3 };
    }
  }

  return { isFreezing: false, reason: '未触发情绪冰点', prev1, prev2, prev3 };
};

// ========== 大盘买点判断（可复用） ==========

/**
 * 判断某个日期是否为大盘买点（创业板和科创板分别判断）
 *
 * 条件：
 *   ① 前一日为情绪冰点
 *   ② 跟踪指数当日涨幅 > 1%
 *   ③ 当天科技情绪指数 ≥ -40
 *
 * @param {number|string} dateNum - 目标日期 YYYYMMDD
 * @param {Array} techIndexData - 科技情绪数据
 * @param {Array} indexKlineData - 指数K线数据（如 kechuangbanData 或 chuangyebanData）
 * @param {string} indexName - 指数名称（用于日志）
 * @returns {{ isBuyDate: boolean, reason: string, indexChange: number|null, freezingReason: string|null }}
 */
const isMarketBuyDate = (dateNum, techIndexData, indexKlineData, indexName = '指数') => {
  const date = parseInt(dateNum);

  // 条件①：前一日为情绪冰点
  const freezing = isEmotionFreezing(techIndexData, date);
  if (!freezing.isFreezing) {
    return { isBuyDate: false, reason: `前一日未触发情绪冰点`, indexChange: null, freezingReason: freezing.reason };
  }

  // 条件③：当天科技情绪指数 ≥ -40
  const sortedTech = [...techIndexData].sort((a, b) => a.date - b.date);
  const techIdx = sortedTech.findIndex(t => parseInt(t.date) === parseInt(date));
  if (techIdx >= 0) {
    const techEmotion = parseFloat(sortedTech[techIdx].changeSumResult || 0);
    if (techEmotion < -40) {
      return { isBuyDate: false, reason: `当天科技情绪指数 ${techEmotion.toFixed(2)} < -40`, indexChange: null, freezingReason: freezing.reason };
    }
  }

  // 条件②：跟踪指数当日涨幅 > 1%
  if (!Array.isArray(indexKlineData)) {
    return { isBuyDate: false, reason: `无${indexName}K线数据`, indexChange: null, freezingReason: freezing.reason };
  }

  const idx = indexKlineData.findIndex(k => parseInt(k.trade_date) === date);
  if (idx < 0) {
    return { isBuyDate: false, reason: `${indexName}在${formatDateStr(date)}无K线数据`, indexChange: null, freezingReason: freezing.reason };
  }

  const change = parseFloat(indexKlineData[idx].change || 0);
  if (change <= 1) {
    return { isBuyDate: false, reason: `${indexName}涨幅 ${change.toFixed(2)}% 未超过 1%`, indexChange: parseFloat(change.toFixed(2)), freezingReason: freezing.reason };
  }

  return {
    isBuyDate: true,
    reason: `${indexName}涨幅 +${change.toFixed(2)}%，${freezing.reason}`,
    indexChange: parseFloat(change.toFixed(2)),
    freezingReason: freezing.reason,
  };
};

/**
 * 检查MA10买入条件：十日线斜率 ≥ 0 且 当前价格 ≥ 十日线
 * @param {Array} klineData - K线数据（按trade_date升序）
 * @param {number} buyIdx - 买入日期在klineData中的索引
 * @param {number} buyPrice - 买入价格（时间点策略用分时价，其他用收盘价）
 * @returns {boolean}
 */
const checkMA10BuyCondition = (klineData, buyIdx, buyPrice) => {
  if (buyIdx < 14) return false;

  let sum = 0;
  for (let i = buyIdx - 9; i <= buyIdx; i++) {
    sum += parseFloat(klineData[i].close_px);
  }
  const ma10 = sum / 10;

  let prevSum = 0;
  for (let i = buyIdx - 14; i <= buyIdx - 5; i++) {
    prevSum += parseFloat(klineData[i].close_px);
  }
  const prevMa10 = prevSum / 10;

  const ma10Slope = ma10 - prevMa10;
  return ma10Slope >= 0 && buyPrice >= ma10;
};

/**
 * 检查卖点（简化版，基于K线数据）
 * 卖点条件：① MA10破位 ② 高位大阴线（振幅>5%且收盘<开盘）③ 科技情绪退潮<-80
 */
const checkSellPointSimple = (klineData, targetIdx, techIndexData) => {
  const kline = klineData[targetIdx];
  const closePrice = parseFloat(kline.close_px);
  const date = kline.trade_date;

  let ma5 = null;
  if (targetIdx >= 4) {
    let sum = 0;
    for (let i = targetIdx - 4; i <= targetIdx; i++) sum += parseFloat(klineData[i].close_px);
    ma5 = sum / 5;
  }

  let ma10 = null;
  if (targetIdx >= 9) {
    let sum = 0;
    for (let i = targetIdx - 9; i <= targetIdx; i++) sum += parseFloat(klineData[i].close_px);
    ma10 = sum / 10;
  }

  let ma10Slope = null;
  if (ma10 !== null && targetIdx >= 14) {
    let prevSum = 0;
    for (let i = targetIdx - 14; i <= targetIdx - 5; i++) prevSum += parseFloat(klineData[i].close_px);
    const prevMa10 = prevSum / 10;
    ma10Slope = ma10 - prevMa10;
  }

  // 条件1：MA10破位
  if (ma10 !== null) {
    if (ma10Slope !== null) {
      if (ma10Slope > 0 && closePrice < ma10) {
        return { isSell: true, sellPrice: closePrice, reason: `MA10上升趋势，收盘价 ${closePrice.toFixed(2)} 跌破10日线 ${ma10.toFixed(2)}` };
      }
      if (ma10Slope <= 0 && ma5 !== null && closePrice < ma5) {
        return { isSell: true, sellPrice: closePrice, reason: `MA10下降趋势，收盘价 ${closePrice.toFixed(2)} 未站上5日线 ${ma5.toFixed(2)}` };
      }
    } else {
      if (closePrice < ma10) {
        return { isSell: true, sellPrice: closePrice, reason: `收盘价 ${closePrice.toFixed(2)} 跌破10日线 ${ma10.toFixed(2)}` };
      }
    }
  }

  // 条件2：高位大阴线
  const openPrice = parseFloat(kline.open_px);
  const highPrice = parseFloat(kline.high_px);
  const lowPrice = parseFloat(kline.low_px);
  const amplitude = openPrice > 0 ? ((highPrice - lowPrice) / openPrice) * 100 : 0;
  if (amplitude > 5 && closePrice < openPrice) {
    return { isSell: true, sellPrice: closePrice, reason: `高位大阴线（振幅 ${amplitude.toFixed(2)}% > 5%）` };
  }

  // 条件3：科技情绪退潮 < -80
  if (Array.isArray(techIndexData) && techIndexData.length > 0) {
    const sortedTech = [...techIndexData].sort((a, b) => a.date - b.date);
    const techIdx = sortedTech.findIndex(t => parseInt(t.date) === parseInt(date));
    if (techIdx >= 0) {
      const techChange = parseFloat(sortedTech[techIdx].changeSumResult || 0);
      if (techChange < -80) {
        return { isSell: true, sellPrice: closePrice, reason: `科技情绪退潮 ${techChange.toFixed(2)} < -80` };
      }
    }
  }

  return { isSell: false, sellPrice: null, reason: null };
};

/**
 * 模拟卖出：从买入次日开始逐日检查卖点，直到触发或到达数据末尾
 */
const simulateSell = (klineData, buyIdx, techIndexData) => {
  for (let i = buyIdx + 1; i < klineData.length; i++) {
    const result = checkSellPointSimple(klineData, i, techIndexData);
    if (result.isSell) {
      return {
        sellDate: klineData[i].trade_date,
        sellPrice: result.sellPrice,
        sellReason: result.reason,
        holdingDays: Math.max(1, Math.round((parseDateNum(klineData[i].trade_date) - parseDateNum(klineData[buyIdx].trade_date)) / (1000 * 60 * 60 * 24))),
      };
    }
  }
  const lastKline = klineData[klineData.length - 1];
  return {
    sellDate: lastKline.trade_date,
    sellPrice: parseFloat(lastKline.close_px),
    sellReason: '回测结束仍持有，按末日收盘价平仓',
    isUnrealized: true,
    holdingDays: Math.max(1, Math.round((parseDateNum(lastKline.trade_date) - parseDateNum(klineData[buyIdx].trade_date)) / (1000 * 60 * 60 * 24))),
  };
};

/**
 * 计算抗分歧指数最近N天平均值
 * @param {string} code - 股票代码
 * @param {number|string} targetDate - 目标日期 YYYYMMDD（包含当天）
 * @param {number} days - 天数（3 或 5）
 */
const calcResilienceAvg = async (code, targetDate, days) => {
  const isSh688 = code.startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const limitType = getLimitTypeByCode(code);

  const targetDateStr = String(targetDate);
  const target = dayjs(`${targetDateStr.substring(0, 4)}-${targetDateStr.substring(4, 6)}-${targetDateStr.substring(6, 8)}`);

  let validCount = 0;
  let totalScore = 0;

  for (let i = 0; i < days; i++) {
    const checkDate = target.subtract(i, 'day').format('YYYYMMDD');
    try {
      const [stockTline, indexTline] = await Promise.all([
        getSingleStockTlineDataByDate(code, parseInt(checkDate)),
        getSingleStockTlineDataByDate(indexCode, parseInt(checkDate)),
      ]);

      const stockLine = stockTline?.line || [];
      const indexLine = indexTline?.line || [];

      if (stockLine.length >= 5 && indexLine.length >= 5) {
        const score = calculateResilience(indexLine, stockLine, limitType);
        if (score != null && !isNaN(score)) {
          totalScore += score;
          validCount++;
        }
      }
    } catch (e) {
      // 跳过无法计算的日期
    }
    await sleep(100);
  }

  return validCount > 0 ? parseFloat((totalScore / validCount).toFixed(2)) : null;
};

// ========== 主函数 ==========

/**
 * 寻找大盘符合条件的买点日期
 * @returns {{ kechuang: [{date, dateStr, reason}], chuangye: [{date, dateStr, reason}] }}
 */
const findMarketBuyDates = async (startDate, endDate) => {
  const techIndexData = getAllTechIndexData();
  console.log('[智能回测] 科技情绪数据条数:', techIndexData?.length);
  if (techIndexData?.length > 0) {
    const sorted = [...techIndexData].sort((a, b) => a.date - b.date);
    console.log('[智能回测] 科技情绪最早日期:', sorted[0]?.date, '最新日期:', sorted[sorted.length - 1]?.date);
  }

  const { kechuangbanData, chuangyebanData } = await getAllIndexKlineData();
  console.log('[智能回测] 科创板K线数据条数:', kechuangbanData?.length, '创业板K线数据条数:', chuangyebanData?.length);
  if (kechuangbanData?.length > 0) {
    const sortedKc = [...kechuangbanData].sort((a, b) => a.trade_date - b.trade_date);
    console.log('[智能回测] 科创板K线最早:', sortedKc[0]?.trade_date, '最新:', sortedKc[sortedKc.length - 1]?.trade_date);
  }
  if (chuangyebanData?.length > 0) {
    const sortedCy = [...chuangyebanData].sort((a, b) => a.trade_date - b.trade_date);
    console.log('[智能回测] 创业板K线最早:', sortedCy[0]?.trade_date, '最新:', sortedCy[sortedCy.length - 1]?.trade_date);
  }

  const start = dayjs(startDate);
  const end = dayjs(endDate);

  const kechuangDates = [];
  const chuangyeDates = [];

  let current = start;
  while (current.isBefore(end) || current.isSame(end, 'day')) {
    const dateStr = current.format('YYYYMMDD');
    const dateNum = parseInt(dateStr);

    // 科创板
    const kcResult = isMarketBuyDate(dateNum, techIndexData, kechuangbanData, '科创50');
    if (kcResult.isBuyDate) {
      kechuangDates.push({
        date: dateNum,
        dateStr,
        indexChange: kcResult.indexChange,
        freezingReason: kcResult.freezingReason,
      });
    }

    // 创业板
    const cyResult = isMarketBuyDate(dateNum, techIndexData, chuangyebanData, '创业板指');
    if (cyResult.isBuyDate) {
      chuangyeDates.push({
        date: dateNum,
        dateStr,
        indexChange: cyResult.indexChange,
        freezingReason: cyResult.freezingReason,
      });
    }

    current = current.add(1, 'day');
  }

  console.log('[智能回测] 找到科创板买点:', kechuangDates.length, '个, 创业板买点:', chuangyeDates.length, '个');
  return { kechuang: kechuangDates, chuangye: chuangyeDates };
};

// 策略名称映射
const strategyNames = {
  resilience_top3: '抗分歧分数前三',
  gain_top3: '涨幅前三',
  gain_resilience_overlap: '涨幅+抗分歧',
  gain_935am_top3: '上午九点三十五涨幅前三',
  gain_940am_top3: '上午九点四十涨幅前三',
  gain_950am_top3: '上午九点五十涨幅前三',
  gain_10am_top3: '上午十点涨幅前三',
  gain_1030am_top3: '上午十点半涨幅前三',
  gain_11am_top3: '上午十一点涨幅前三',
  gain_130pm_top3: '下午一点半涨幅前三',
  gain_2pm_top3: '下午两点涨幅前三',
  gain_230pm_top3: '下午两点半涨幅前三',
};

// 时间点策略配置：策略ID -> 分钟值
const timeStrategyMinuteMap = {
  gain_935am_top3: 935,
  gain_940am_top3: 940,
  gain_950am_top3: 950,
  gain_10am_top3: 1000,
  gain_1030am_top3: 1030,
  gain_11am_top3: 1100,
  gain_130pm_top3: 1330,
  gain_2pm_top3: 1400,
  gain_230pm_top3: 1430,
};

/**
 * 判断是否为时间点涨幅策略
 */
const isTimeGainStrategy = (strategyId) => {
  return !!timeStrategyMinuteMap[strategyId];
};

// 策略对应的抗分歧天数
const resilienceDaysMap = {
  resilience_top3: 1,
};

/**
 * 执行智能回测
 * @param {string} startDate - 开始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @param {string} strategy - 策略ID（单个，单选）
 */
const smartBacktestRun = async (startDate, endDate, strategy) => {
  console.log('[智能回测] 开始回测, 日期:', startDate, '~', endDate, '策略:', strategy);
  if (!strategy || !strategyNames[strategy]) {
    return { success: false, message: '请选择一个有效的策略' };
  }

  const techIndexData = getAllTechIndexData();

  // Step 1: 找大盘买点日期
  const { kechuang: kcDates, chuangye: cyDates } = await findMarketBuyDates(startDate, endDate);

  // Step 2: 获取自选股并按跟踪指数分组
  const monitorStocks = getMonitorStocks();
  const kcStocks = [];
  const cyStocks = [];

  for (const stock of monitorStocks) {
    if (stock.code.startsWith('sh688')) {
      kcStocks.push(stock);
    } else {
      cyStocks.push(stock);
    }
  }

  // Step 3: 按日期合并创业板和科创板（同一天两个板块都命中 → 全量自选股跑策略）
  const dateMap = new Map();

  const addToDateMap = (dateInfo, indexType, indexCode) => {
    const key = dateInfo.dateStr;
    if (!dateMap.has(key)) {
      dateMap.set(key, { date: dateInfo.date, dateStr: dateInfo.dateStr, boards: [] });
    }
    dateMap.get(key).boards.push({ indexType, indexCode, indexChange: dateInfo.indexChange, freezingReason: dateInfo.freezingReason });
  };

  kcDates.forEach(d => addToDateMap(d, '科创板', 'sh000688'));
  cyDates.forEach(d => addToDateMap(d, '创业板', 'sz399006'));

  const allDates = [];
  for (const [dateStr, entry] of dateMap) {
    const isDouble = entry.boards.length >= 2;
    const stockList = isDouble ? [...kcStocks, ...cyStocks] : (entry.boards[0].indexType === '科创板' ? kcStocks : cyStocks);

    const strategyResults = await runStrategy(strategy, stockList, parseInt(dateStr), techIndexData);

    allDates.push({
      date: entry.date,
      dateStr: entry.dateStr,
      indexType: isDouble ? '科创板+创业板' : entry.boards[0].indexType,
      indexCode: isDouble ? 'sh000688/sz399006' : entry.boards[0].indexCode,
      indexChange: entry.boards.map(b => `${b.indexType} +${b.indexChange}%`).join(', '),
      freezingReason: entry.boards.map(b => b.freezingReason).join('; '),
      strategy: { name: strategyNames[strategy], stocks: strategyResults },
    });
  }

  allDates.sort((a, b) => a.date - b.date);

  return {
    success: true,
    data: {
      dates: allDates,
      summary: {
        totalDates: allDates.length,
        mergedDates: [...dateMap.values()].filter(e => e.boards.length >= 2).length,
        strategy: { id: strategy, name: strategyNames[strategy] },
        kcDateCount: kcDates.length,
        cyDateCount: cyDates.length,
        kcStockCount: kcStocks.length,
        cyStockCount: cyStocks.length,
      },
    },
  };
};

/**
 * 涨幅+抗分歧权重策略：涨幅前10中，按涨幅70% + 抗分歧30% 加权打分，取前3
 */
const runGainResilienceOverlap = async (stockList, buyDate, techIndexData) => {
  const scoredStocks = [];

  for (let i = 0; i < stockList.length; i++) {
    const stock = stockList[i];
    try {
      const klineData = await getSingleStockData(stock.code, 400);
      if (!klineData || klineData.length === 0) continue;

      const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
      const buyIdx = sortedKline.findIndex(k => parseInt(k.trade_date) === buyDate);
      if (buyIdx < 0) continue;

      const kline = sortedKline[buyIdx];
      const gain = parseFloat((kline.change || 0).toFixed(2));
      const resilience = await calcResilienceAvg(stock.code, buyDate, 1);

      if (!isNaN(gain) && resilience != null && !isNaN(resilience)) {
        const closePrice = parseFloat(kline.close_px);
        if (!checkMA10BuyCondition(sortedKline, buyIdx, closePrice)) continue;
        scoredStocks.push({
          code: stock.code,
          stockName: stock.name || stock.code,
          gain,
          resilience,
          klineData: sortedKline,
          buyIdx,
        });
      }
    } catch (e) {
      // 跳过出错股票
    }

    if (i < stockList.length - 1) {
      await sleep(100);
    }
  }

  // 涨幅前10
  const gainTop10 = [...scoredStocks].sort((a, b) => b.gain - a.gain).slice(0, 10);

  if (gainTop10.length === 0) return [];

  // 归一化：涨幅和抗分歧分别做 min-max 归一化到 0-1
  const maxGain = Math.max(...gainTop10.map(s => s.gain));
  const minGain = Math.min(...gainTop10.map(s => s.gain));
  const gainRange = maxGain - minGain || 1;

  const maxRes = Math.max(...gainTop10.map(s => s.resilience));
  const minRes = Math.min(...gainTop10.map(s => s.resilience));
  const resRange = maxRes - minRes || 1;

  // 加权打分：涨幅 70% + 抗分歧 30%
  const scored = gainTop10.map(s => ({
    ...s,
    score: ((s.gain - minGain) / gainRange) * 0.7 + ((s.resilience - minRes) / resRange) * 0.3,
  }));

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  const results = [];
  for (let i = 0; i < top3.length; i++) {
    const stock = top3[i];
    const kline = stock.klineData[stock.buyIdx];
    const closePrice = parseFloat(kline.close_px);
    const buyPrice = parseFloat(closePrice.toFixed(2));

    const sellResult = simulateSell(stock.klineData, stock.buyIdx, techIndexData);
    const profit = parseFloat((sellResult.sellPrice - buyPrice).toFixed(2));
    const profitPct = parseFloat(((profit / buyPrice) * 100).toFixed(2));

    results.push({
      rank: i + 1,
      code: stock.code,
      stockName: stock.stockName,
      metric: +(stock.score * 100).toFixed(1),
      metricLabel: `加权 ${(stock.score * 100).toFixed(1)}（涨${stock.gain}% + 抗分歧${stock.resilience}分）`,
      buyDate: buyDate,
      buyDateStr: dateNumToStr(buyDate),
      buyPrice,
      sellDate: sellResult.sellDate,
      sellDateStr: dateNumToStr(sellResult.sellDate),
      sellPrice: parseFloat(sellResult.sellPrice.toFixed(2)),
      profit,
      profitPct,
      holdingDays: sellResult.holdingDays,
      buyReason: `涨幅+抗分歧加权排名第${i + 1}（得分${(stock.score * 100).toFixed(1)}，涨幅${stock.gain}%，抗分歧${stock.resilience}分）`,
      sellReason: sellResult.sellReason,
      isUnrealized: sellResult.isUnrealized || false,
    });

    await sleep(100);
  }

  return results;
};

/**
 * 执行单个策略，返回排名前3的股票及其回测结果
 */
const runStrategy = async (strategy, stockList, buyDate, techIndexData) => {
  // 涨幅+抗分歧交集策略：需要同时计算涨幅和抗分歧分数
  if (strategy === 'gain_resilience_overlap') {
    return runGainResilienceOverlap(stockList, buyDate, techIndexData);
  }

  const rankedStocks = [];

  for (let i = 0; i < stockList.length; i++) {
    const stock = stockList[i];
    try {
      const klineData = await getSingleStockData(stock.code, 400);
      if (!klineData || klineData.length === 0) continue;

      const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
      const buyIdx = sortedKline.findIndex(k => parseInt(k.trade_date) === buyDate);
      if (buyIdx < 0) continue;

      let metric = null;

      if (strategy === 'resilience_top3') {
        const days = resilienceDaysMap[strategy] || 1;
        metric = await calcResilienceAvg(stock.code, buyDate, days);
        await sleep(100);
      } else if (strategy === 'gain_top3') {
        const kline = sortedKline[buyIdx];
        metric = parseFloat((kline.change || 0).toFixed(2));
      } else if (strategy === 'gain_10am_top3') {
        const tlineData = await getSingleStockTlineDataByDate(stock.code, buyDate);
        if (tlineData && tlineData.line && tlineData.line.length > 0) {
          const targetMinute = 1000;
          let closest = tlineData.line[0];
          let minDiff = Math.abs(closest.minute - targetMinute);
          for (const point of tlineData.line) {
            const diff = Math.abs(point.minute - targetMinute);
            if (diff < minDiff) {
              minDiff = diff;
              closest = point;
            }
          }
          if (minDiff <= 5 && closest.change != null) {
            metric = parseFloat(closest.change.toFixed(2));
          }
        }
        await sleep(100);
      }

      if (metric != null && !isNaN(metric)) {
        const kline = sortedKline[buyIdx];
        const closePrice = parseFloat(kline.close_px);
        if (!checkMA10BuyCondition(sortedKline, buyIdx, closePrice)) continue;
        rankedStocks.push({
          code: stock.code,
          stockName: stock.name || stock.code,
          metric,
          klineData: sortedKline,
          buyIdx,
        });
      }
    } catch (e) {
      // 跳过出错股票
    }

    if (i < stockList.length - 1) {
      await sleep(100);
    }
  }

  rankedStocks.sort((a, b) => b.metric - a.metric);
  const top3 = rankedStocks.slice(0, 3);

  const results = [];
  const isResilience = strategy === 'resilience_top3';
  const isGain = strategy === 'gain_top3';

  for (let i = 0; i < top3.length; i++) {
    const stock = top3[i];
    const kline = stock.klineData[stock.buyIdx];
    const closePrice = parseFloat(kline.close_px);
    const buyPrice = parseFloat(closePrice.toFixed(2));

    const sellResult = simulateSell(stock.klineData, stock.buyIdx, techIndexData);
    const profit = parseFloat((sellResult.sellPrice - buyPrice).toFixed(2));
    const profitPct = parseFloat(((profit / buyPrice) * 100).toFixed(2));

    results.push({
      rank: i + 1,
      code: stock.code,
      stockName: stock.stockName,
      metric: stock.metric,
      metricLabel: isResilience ? `${stock.metric} 分` : isGain ? `${stock.metric}%` : `${stock.metric}%`,
      buyDate: buyDate,
      buyDateStr: dateNumToStr(buyDate),
      buyPrice,
      sellDate: sellResult.sellDate,
      sellDateStr: dateNumToStr(sellResult.sellDate),
      sellPrice: parseFloat(sellResult.sellPrice.toFixed(2)),
      profit,
      profitPct,
      holdingDays: sellResult.holdingDays,
      buyReason: `${strategyNames[strategy]}排名第${i + 1}（${isResilience ? stock.metric + '分' : stock.metric + '%'}）`,
      sellReason: sellResult.sellReason,
      isUnrealized: sellResult.isUnrealized || false,
    });

    await sleep(100);
  }

  return results;
};

/**
 * 批量执行时间点涨幅策略 — 每只股票只请求一次分时接口，然后分别计算各时间点的涨幅排名
 * @param {Array} stockList - 股票列表
 * @param {number} buyDate - 买入日期 YYYYMMDD
 * @param {Array} techIndexData - 科技情绪数据
 * @param {Array} timeStrategyIds - 时间点策略ID列表
 * @returns {Object} { [strategyId]: results[] }
 */
const runTimeGainStrategies = async (stockList, buyDate, techIndexData, timeStrategyIds) => {
  const configs = timeStrategyIds
    .filter(id => timeStrategyMinuteMap[id])
    .map(id => ({ id, minute: timeStrategyMinuteMap[id], name: strategyNames[id] }));

  if (configs.length === 0) return {};

  const allStocksData = [];

  for (let i = 0; i < stockList.length; i++) {
    const stock = stockList[i];
    try {
      const klineData = await getSingleStockData(stock.code, 400);
      if (!klineData || klineData.length === 0) continue;

      const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
      const buyIdx = sortedKline.findIndex(k => parseInt(k.trade_date) === buyDate);
      if (buyIdx < 0) continue;

      const tlineData = await getSingleStockTlineDataByDate(stock.code, buyDate);

      const timeGains = {};
      const timePrices = {};
      if (tlineData && tlineData.line && tlineData.line.length > 0) {
        for (const cfg of configs) {
          const targetMinute = cfg.minute;
          let closest = tlineData.line[0];
          let minDiff = Math.abs(closest.minute - targetMinute);
          for (const point of tlineData.line) {
            const diff = Math.abs(point.minute - targetMinute);
            if (diff < minDiff) {
              minDiff = diff;
              closest = point;
            }
          }
          if (minDiff <= 5 && closest.change != null) {
            timeGains[cfg.id] = parseFloat(closest.change.toFixed(2));
            timePrices[cfg.id] = parseFloat((closest.last_px || 0).toFixed(2));
          }
        }
      }

      allStocksData.push({
        code: stock.code,
        stockName: stock.name || stock.code,
        klineData: sortedKline,
        buyIdx,
        timeGains,
        timePrices,
      });
    } catch (e) {
      // 跳过出错股票
    }

    if (i < stockList.length - 1) {
      await sleep(100);
    }
  }

  // 为每个策略分别排名、构建结果
  const resultsByStrategy = {};
  for (const cfg of configs) {
    const ranked = allStocksData
      .filter(s => s.timeGains[cfg.id] != null && s.timePrices[cfg.id] != null
        && checkMA10BuyCondition(s.klineData, s.buyIdx, s.timePrices[cfg.id]))
      .map(s => ({ ...s, metric: s.timeGains[cfg.id] }))
      .sort((a, b) => b.metric - a.metric)
      .slice(0, 3);

    const strategyResults = [];
    for (let i = 0; i < ranked.length; i++) {
      const stock = ranked[i];
      const buyPrice = stock.timePrices[cfg.id] || 0;

      const sellResult = simulateSell(stock.klineData, stock.buyIdx, techIndexData);
      const profit = parseFloat((sellResult.sellPrice - buyPrice).toFixed(2));
      const profitPct = buyPrice > 0 ? parseFloat(((profit / buyPrice) * 100).toFixed(2)) : 0;

      strategyResults.push({
        rank: i + 1,
        code: stock.code,
        stockName: stock.stockName,
        metric: stock.metric,
        metricLabel: `${stock.metric}%`,
        buyDate: buyDate,
        buyDateStr: dateNumToStr(buyDate),
        buyPrice,
        sellDate: sellResult.sellDate,
        sellDateStr: dateNumToStr(sellResult.sellDate),
        sellPrice: parseFloat(sellResult.sellPrice.toFixed(2)),
        profit,
        profitPct,
        holdingDays: sellResult.holdingDays,
        buyReason: `${cfg.name}排名第${i + 1}（${stock.metric}%）`,
        sellReason: sellResult.sellReason,
        isUnrealized: sellResult.isUnrealized || false,
      });
    }

    resultsByStrategy[cfg.id] = strategyResults;
  }

  return resultsByStrategy;
};

/**
 * 批量执行多个策略回测，时间点涨幅策略共享一次分时数据请求
 * @param {string} startDate - 开始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @param {string[]} strategies - 策略ID数组
 * @returns {{ success: boolean, results: { [strategyId]: { name, success, elapsed, dateCount, data } } }}
 */
const smartBacktestRunBatch = async (startDate, endDate, strategies) => {
  console.log('[智能回测-批量] 开始回测, 日期:', startDate, '~', endDate, '策略:', strategies.join(', '));

  const invalidStrategies = strategies.filter(s => !strategyNames[s]);
  if (invalidStrategies.length > 0) {
    return { success: false, message: `无效策略: ${invalidStrategies.join(', ')}` };
  }

  const techIndexData = getAllTechIndexData();

  // Step 1: 找大盘买点日期
  const { kechuang: kcDates, chuangye: cyDates } = await findMarketBuyDates(startDate, endDate);

  // Step 2: 获取自选股并按跟踪指数分组
  const monitorStocks = getMonitorStocks();
  const kcStocks = [];
  const cyStocks = [];

  for (const stock of monitorStocks) {
    if (stock.code.startsWith('sh688')) {
      kcStocks.push(stock);
    } else {
      cyStocks.push(stock);
    }
  }

  // Step 3: 按日期合并创业板和科创板
  const dateMap = new Map();

  const addToDateMap = (dateInfo, indexType, indexCode) => {
    const key = dateInfo.dateStr;
    if (!dateMap.has(key)) {
      dateMap.set(key, { date: dateInfo.date, dateStr: dateInfo.dateStr, boards: [] });
    }
    dateMap.get(key).boards.push({ indexType, indexCode, indexChange: dateInfo.indexChange, freezingReason: dateInfo.freezingReason });
  };

  kcDates.forEach(d => addToDateMap(d, '科创板', 'sh000688'));
  cyDates.forEach(d => addToDateMap(d, '创业板', 'sz399006'));

  // 分离时间点涨幅策略和其他策略
  const timeGainStrategyIds = strategies.filter(s => isTimeGainStrategy(s));
  const otherStrategyIds = strategies.filter(s => !isTimeGainStrategy(s));

  console.log(`[智能回测-批量] 时间点策略: ${timeGainStrategyIds.length}个, 其他策略: ${otherStrategyIds.length}个`);

  // 初始化结果容器
  const allDatesByStrategy = {};
  for (const s of strategies) {
    allDatesByStrategy[s] = [];
  }

  // 处理每个日期
  const dateEntries = [...dateMap.values()];
  for (let di = 0; di < dateEntries.length; di++) {
    const entry = dateEntries[di];
    const isDouble = entry.boards.length >= 2;
    const stockList = isDouble ? [...kcStocks, ...cyStocks] : (entry.boards[0].indexType === '科创板' ? kcStocks : cyStocks);
    const buyDate = parseInt(entry.dateStr);

    console.log(`[智能回测-批量] [${di + 1}/${dateEntries.length}] ${entry.dateStr} (${entry.boards.map(b => b.indexType).join('+')}, ${stockList.length}只)`);

    const dateEntry = {
      date: entry.date,
      dateStr: entry.dateStr,
      indexType: isDouble ? '科创板+创业板' : entry.boards[0].indexType,
      indexCode: isDouble ? 'sh000688/sz399006' : entry.boards[0].indexCode,
      indexChange: entry.boards.map(b => `${b.indexType} +${b.indexChange}%`).join(', '),
      freezingReason: entry.boards.map(b => b.freezingReason).join('; '),
    };

    // 批量执行时间点涨幅策略（共享一次分时数据请求）
    if (timeGainStrategyIds.length > 0) {
      const batchResults = await runTimeGainStrategies(stockList, buyDate, techIndexData, timeGainStrategyIds);
      for (const [strategyId, strategyResults] of Object.entries(batchResults)) {
        allDatesByStrategy[strategyId].push({
          ...dateEntry,
          strategy: { name: strategyNames[strategyId], stocks: strategyResults },
        });
      }
    }

    // 逐个执行其他策略
    for (const s of otherStrategyIds) {
      const strategyResults = await runStrategy(s, stockList, buyDate, techIndexData);
      allDatesByStrategy[s].push({
        ...dateEntry,
        strategy: { name: strategyNames[s], stocks: strategyResults },
      });
    }
  }

  // 构建最终结果
  const results = {};
  for (const s of strategies) {
    allDatesByStrategy[s].sort((a, b) => a.date - b.date);
    results[s] = {
      name: strategyNames[s],
      success: true,
      dateCount: allDatesByStrategy[s].length,
      data: {
        dates: allDatesByStrategy[s],
        summary: {
          totalDates: allDatesByStrategy[s].length,
          mergedDates: [...dateMap.values()].filter(e => e.boards.length >= 2).length,
          strategy: { id: s, name: strategyNames[s] },
          kcDateCount: kcDates.length,
          cyDateCount: cyDates.length,
          kcStockCount: kcStocks.length,
          cyStockCount: cyStocks.length,
        },
      },
    };
  }

  return { success: true, results };
};

module.exports = {
  smartBacktestRun,
  smartBacktestRunBatch,
  findMarketBuyDates,
  isMarketBuyDate,
  isEmotionFreezing,
  strategyNames,
};