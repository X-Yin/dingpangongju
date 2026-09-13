/**
 * 容灾诊断服务
 *
 * 7项检查：
 * 1. 当前科创指数是否上涨超过 1%
 * 2. 当前创业板指数是否上涨超过 1%
 * 3. 当前科技情绪指数是否大于 -100
 * 4. 前一日是否为情绪冰点
 * 5. 最近 5min 内资金净流入是否大于 20亿
 * 6. 自选股上涨家数是否大于下跌家数
 * 7. 9:30-10:00 期间，自选股跌幅超过 30 只
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getAllTechIndexData, getLatestTechEmotion, updateCurrentTechIndexData, getCurrentTechEmotion } = require('./emotion');
const { isEmotionFreezing } = require('./buySellDiagnose');
const { getAmountHistory } = require('./amount');
const { getDaPanData } = require('./dapan');
const { getMonitorStocks } = require('./monitorStock');
const { getClsReqUrl, getClsReqStockTlineUrl, batchParallel } = require('../utils');
const { useCLS } = require('../config');

const dapanDataPath = path.resolve(__dirname, '../data/dapanData.json');

function parseAmountValue(str) {
  if (!str) return 0;
  const isPositive = str.startsWith('+');
  const isNegative = str.startsWith('-');
  const valueStr = (isPositive || isNegative) ? str.slice(1) : str;
  const num = parseFloat(valueStr.replace(/亿|万/g, '')) || 0;
  if (valueStr.indexOf('万') !== -1) {
    return (isNegative ? -1 : 1) * (num / 10000);
  }
  return (isNegative ? -1 : 1) * num;
}

function readDapanDataFromFile() {
  try {
    if (!fs.existsSync(dapanDataPath)) return null;
    return JSON.parse(fs.readFileSync(dapanDataPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function timeStrToSeconds(timeStr) {
  const h = parseInt(timeStr.substring(0, 2));
  const m = parseInt(timeStr.substring(2, 4));
  const s = parseInt(timeStr.substring(4, 6));
  return h * 3600 + m * 60 + s;
}

function getRecent5MinInflow() {
  try {
    const history = getAmountHistory();
    if (!history || history.length < 2) {
      return { hasData: false, diff: 0, currentValue: 0, pastValue: 0, currentTime: null, pastTime: null };
    }

    const sorted = [...history].sort((a, b) => a[0].localeCompare(b[0]));
    const latest = sorted[sorted.length - 1];
    const latestTime = latest[0];
    const latestValue = parseAmountValue(latest[1]?.mainMoney);
    const latestTotalSec = timeStrToSeconds(latestTime);

    let targetEntry = null;
    let minDiff = Infinity;

    for (let i = sorted.length - 2; i >= 0; i--) {
      const t = sorted[i][0];
      const totalSec = timeStrToSeconds(t);
      const diff = latestTotalSec - totalSec;

      if (diff >= 240 && diff <= 360) {
        if (diff < minDiff) {
          minDiff = diff;
          targetEntry = sorted[i];
        }
      } else if (diff > 360) {
        break;
      }
    }

    if (!targetEntry) {
      for (let i = sorted.length - 2; i >= 0; i--) {
        const t = sorted[i][0];
        const totalSec = timeStrToSeconds(t);
        const diff = latestTotalSec - totalSec;
        if (diff >= 240) {
          targetEntry = sorted[i];
          break;
        }
      }
    }

    if (!targetEntry) {
      return { hasData: false, diff: 0, currentValue: latestValue, pastValue: 0, currentTime: latestTime, pastTime: null };
    }

    const pastValue = parseAmountValue(targetEntry[1]?.mainMoney);
    const diff = latestValue - pastValue;

    return {
      hasData: true,
      diff: parseFloat(diff.toFixed(2)),
      currentValue: parseFloat(latestValue.toFixed(2)),
      pastValue: parseFloat(pastValue.toFixed(2)),
      currentTime: `${latestTime.substring(0, 2)}:${latestTime.substring(2, 4)}:${latestTime.substring(4, 6)}`,
      pastTime: `${targetEntry[0].substring(0, 2)}:${targetEntry[0].substring(2, 4)}:${targetEntry[0].substring(4, 6)}`,
    };
  } catch (e) {
    return { hasData: false, diff: 0, currentValue: 0, pastValue: 0, currentTime: null, pastTime: null, error: e.message };
  }
}

// 实时拉取所有自选股的最新涨跌幅
async function fetchMonitorStocksChange() {
  try {
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.map(s => s.code);
    if (stockCodes.length === 0) {
      return { upCount: 0, downCount: 0, flatCount: 0, total: 0, list: [] };
    }

    const fetchChange = async (stockCode) => {
      try {
        const { data: { data: klineData } } = await axios.get(getClsReqUrl(stockCode, 1));
        if (klineData && klineData.length > 0) {
          return klineData[0].change;
        }
      } catch (error) {
        // ignore single stock error
      }
      return null;
    };

    const changeArr = await batchParallel(stockCodes, fetchChange, useCLS() ? 5 : 20);
    let upCount = 0, downCount = 0, flatCount = 0;
    const list = [];
    monitorStocks.forEach((stock, idx) => {
      const chg = changeArr[idx];
      if (chg === null || chg === undefined) {
        list.push({ code: stock.code, name: stock.name, change: null });
        return;
      }
      list.push({ code: stock.code, name: stock.name, change: parseFloat(chg.toFixed(2)) });
      if (chg > 0) upCount++;
      else if (chg < 0) downCount++;
      else flatCount++;
    });

    return { upCount, downCount, flatCount, total: stockCodes.length, list };
  } catch (e) {
    console.error('拉取自选股涨跌幅失败:', e.message);
    return { upCount: 0, downCount: 0, flatCount: 0, total: 0, list: [], error: e.message };
  }
}

// 从本地缓存读取自选股涨跌家数
function getMonitorStocksChangeFromCache() {
  try {
    const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
    if (!fs.existsSync(stockDataPath)) return null;
    const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    const monitorStocks = getMonitorStocks();
    let upCount = 0, downCount = 0, flatCount = 0;
    monitorStocks.forEach(stock => {
      const data = stockData[stock.code];
      if (data && data.kline && data.kline.length > 0) {
        const chg = data.kline[0].change;
        if (chg > 0) upCount++;
        else if (chg < 0) downCount++;
        else flatCount++;
      }
    });
    return { upCount, downCount, flatCount, total: monitorStocks.length };
  } catch (e) {
    return null;
  }
}

// 是否处于交易时段 9:30-10:00 且为工作日
function isInOpeningCheckWindow() {
  const now = dayjs();
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const hour = now.hour();
  const minute = now.minute();
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight <= 10 * 60;
}

// 实时拉取所有自选股的分时数据，对比当前价与9:30开盘价
async function fetchOpeningBelowCount() {
  try {
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.map(s => s.code);
    if (stockCodes.length === 0) {
      return { belowCount: 0, total: 0, openingPrice: null, currentPrice: null };
    }

    const fetchTline = async (stockCode) => {
      try {
        const response = await axios.get(getClsReqStockTlineUrl(stockCode));
        const data = response.data?.data;
        const line = data?.line || [];
        if (!Array.isArray(line) || line.length === 0) {
          return { code: stockCode, openingPrice: null, currentPrice: null };
        }
        const openingPoint = line.find(item => item.minute === 930);
        const openingPrice = openingPoint ? openingPoint.last_px : line[0].last_px;
        const currentPrice = line[line.length - 1].last_px;
        return { code: stockCode, openingPrice, currentPrice };
      } catch (error) {
        return { code: stockCode, openingPrice: null, currentPrice: null };
      }
    };

    const results = await batchParallel(stockCodes, fetchTline, useCLS() ? 3 : 10);
    let belowCount = 0;
    let validCount = 0;
    results.forEach(r => {
      if (r.openingPrice !== null && r.currentPrice !== null) {
        validCount++;
        if (r.currentPrice < r.openingPrice) belowCount++;
      }
    });

    return {
      belowCount,
      total: stockCodes.length,
      validCount,
      list: results.filter(r => r.openingPrice !== null && r.currentPrice !== null && r.currentPrice < r.openingPrice),
    };
  } catch (e) {
    console.error('获取分时数据失败:', e.message);
    return { belowCount: 0, total: 0, validCount: 0, list: [], error: e.message };
  }
}

async function runDisasterRecoveryCheck(options = {}) {
  const { refresh = false } = options;
  const checks = [];
  let allPassed = true;

  let freshDapanData = null;
  let freshTechEmotion = null;
  let freshStockStats = null;
  let freshOpeningStats = null;

  if (refresh) {
    try {
      freshDapanData = await getDaPanData();
      if (freshDapanData) {
        fs.writeFileSync(dapanDataPath, JSON.stringify(freshDapanData, null, 2));
      }
    } catch (e) {
      console.error('刷新大盘数据失败:', e.message);
    }
    try {
      freshTechEmotion = await updateCurrentTechIndexData();
    } catch (e) {
      console.error('刷新科技情绪失败:', e.message);
      try {
        freshTechEmotion = await getCurrentTechEmotion();
      } catch (e2) {
        // ignore
      }
    }
    freshStockStats = await fetchMonitorStocksChange();
    if (isInOpeningCheckWindow()) {
      freshOpeningStats = await fetchOpeningBelowCount();
    }
  }

  // ========== 检查 1：科创指数是否上涨超过 1% ==========
  let kcChange = null;
  try {
    const dapanData = freshDapanData || readDapanDataFromFile();
    if (dapanData && dapanData.index_quote) {
      const kcIndex = dapanData.index_quote.find(i => i.secu_code === 'sh000688');
      if (kcIndex) {
        kcChange = parseFloat((kcIndex.change * 100).toFixed(2));
      }
    }
  } catch (e) {
    // ignore
  }

  const check1Passed = kcChange !== null && kcChange > 1;
  checks.push({
    id: 'kc_index',
    title: '科创指数上涨超过 1%',
    passed: check1Passed,
    value: kcChange !== null ? `${kcChange.toFixed(2)}%` : '无数据',
    reason: check1Passed
      ? `科创指数当前涨幅 ${kcChange.toFixed(2)}%，超过 1% 阈值`
      : kcChange === null
        ? '未获取到科创指数数据'
        : `科创指数当前涨幅 ${kcChange.toFixed(2)}%，未达到 1% 阈值`,
  });
  if (!check1Passed) allPassed = false;

  // ========== 检查 2：创业板指数是否上涨超过 1% ==========
  let cyChange = null;
  try {
    const dapanData = freshDapanData || readDapanDataFromFile();
    if (dapanData && dapanData.index_quote) {
      const cyIndex = dapanData.index_quote.find(i => i.secu_code === 'sz399006');
      if (cyIndex) {
        cyChange = parseFloat((cyIndex.change * 100).toFixed(2));
      }
    }
  } catch (e) {
    // ignore
  }

  const check2Passed = cyChange !== null && cyChange > 1;
  checks.push({
    id: 'cy_index',
    title: '创业板指数上涨超过 1%',
    passed: check2Passed,
    value: cyChange !== null ? `${cyChange.toFixed(2)}%` : '无数据',
    reason: check2Passed
      ? `创业板指数当前涨幅 ${cyChange.toFixed(2)}%，超过 1% 阈值`
      : cyChange === null
        ? '未获取到创业板指数数据'
        : `创业板指数当前涨幅 ${cyChange.toFixed(2)}%，未达到 1% 阈值`,
  });
  if (!check2Passed) allPassed = false;

  // ========== 检查 3：当前科技情绪指数是否大于 -100 ==========
  let currentTechEmotion = null;
  try {
    currentTechEmotion = freshTechEmotion !== null && freshTechEmotion !== undefined
      ? freshTechEmotion
      : getLatestTechEmotion();
  } catch (e) {
    // ignore
  }

  const check3Passed = currentTechEmotion !== null && currentTechEmotion > -40;
  checks.push({
    id: 'tech_emotion',
    title: '科技情绪指数大于 -40',
    passed: check3Passed,
    value: currentTechEmotion !== null ? currentTechEmotion.toFixed(2) : '无数据',
    reason: check3Passed
      ? `当前科技情绪指数 ${currentTechEmotion.toFixed(2)}，大于 -40`
      : currentTechEmotion === null
        ? '未获取到科技情绪指数数据'
        : `当前科技情绪指数 ${currentTechEmotion.toFixed(2)}，未超过 -40 阈值（市场处于退潮期）`,
  });
  if (!check3Passed) allPassed = false;

  // ========== 检查 4：前一日是否为情绪冰点 ==========
  let freezingResult = { isFreezing: false, reason: '无数据', prev1: null, prev2: null, prev3: null };
  try {
    const techIndexData = getAllTechIndexData();
    const today = dayjs().format('YYYYMMDD');
    freezingResult = isEmotionFreezing(techIndexData, today);
  } catch (e) {
    freezingResult = { isFreezing: false, reason: `检查失败: ${e.message}`, prev1: null, prev2: null, prev3: null };
  }

  const check4Passed = freezingResult.isFreezing === true;
  const prev1Val = freezingResult.prev1?.changeSumResult;
  const prev2Val = freezingResult.prev2?.changeSumResult;
  const prev3Val = freezingResult.prev3?.changeSumResult;
  checks.push({
    id: 'emotion_freezing',
    title: '前一日为情绪冰点',
    passed: check4Passed,
    value: check4Passed ? '是' : '否',
    detail: {
      prev1: prev1Val !== undefined ? prev1Val : null,
      prev2: prev2Val !== undefined ? prev2Val : null,
      prev3: prev3Val !== undefined ? prev3Val : null,
      avg3: freezingResult.avg3 || null,
    },
    reason: check4Passed
      ? freezingResult.reason
      : freezingResult.reason || '前一日未触发情绪冰点条件',
  });
  if (!check4Passed) allPassed = false;

  // ========== 检查 5：最近 5min 内资金净流入是否大于 20亿 ==========
  const inflowResult = getRecent5MinInflow();
  const check5Passed = inflowResult.hasData && inflowResult.diff > 20;
  checks.push({
    id: 'fund_inflow',
    title: '最近 5min 资金净流入大于 20 亿',
    passed: check5Passed,
    value: inflowResult.hasData ? `${inflowResult.diff >= 0 ? '+' : ''}${inflowResult.diff.toFixed(2)}亿` : '数据不足',
    detail: {
      currentTime: inflowResult.currentTime,
      pastTime: inflowResult.pastTime,
      currentValue: inflowResult.currentTime ? inflowResult.currentValue : null,
      pastValue: inflowResult.pastTime ? inflowResult.pastValue : null,
    },
    reason: check5Passed
      ? `最近 5 分钟资金净流入 ${inflowResult.diff.toFixed(2)} 亿（${inflowResult.pastTime}→${inflowResult.currentTime}），超过 20 亿阈值`
      : !inflowResult.hasData
        ? '资金数据不足，无法判断最近 5 分钟净流入'
        : `最近 5 分钟资金净流入 ${inflowResult.diff.toFixed(2)} 亿（${inflowResult.pastTime}→${inflowResult.currentTime}），未达到 20 亿阈值`,
  });
  if (!check5Passed) allPassed = false;

  // ========== 检查 6：自选股上涨家数是否大于下跌家数 ==========
  let stockStats = freshStockStats || getMonitorStocksChangeFromCache();
  const check6Passed = stockStats && stockStats.total > 0 && stockStats.upCount > stockStats.downCount;
  checks.push({
    id: 'stocks_up_down',
    title: '自选股上涨家数大于下跌家数',
    passed: check6Passed,
    value: stockStats
      ? `涨${stockStats.upCount} / 跌${stockStats.downCount} / 平${stockStats.flatCount}（共${stockStats.total}只）`
      : '无数据',
    reason: check6Passed
      ? `自选股上涨 ${stockStats.upCount} 家，下跌 ${stockStats.downCount} 家，涨多跌少`
      : !stockStats || stockStats.total === 0
        ? '未获取到自选股数据'
        : `自选股上涨 ${stockStats.upCount} 家，下跌 ${stockStats.downCount} 家，跌多涨少，市场赚钱效应差`,
  });
  if (!check6Passed) allPassed = false;

  // ========== 检查 7：9:30-10:00 期间，自选股跌幅超过 30 只 ==========
  // 仅在交易日 9:30-10:00 之间检查，其他时段跳过此项
  const inOpeningWindow = isInOpeningCheckWindow();
  if (inOpeningWindow) {
    let openingStats = freshOpeningStats;
    // 如果非刷新模式（但当前处于开盘窗口），也实时拉取
    if (!openingStats) {
      openingStats = await fetchOpeningBelowCount();
    }
    const check7Passed = openingStats && openingStats.belowCount <= 30;
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: check7Passed,
      value: openingStats
        ? `${openingStats.belowCount} / ${openingStats.validCount || openingStats.total}只`
        : '检查中...',
      reason: check7Passed
        ? `开盘后自选股共 ${openingStats.total} 只，${openingStats.belowCount} 只现价低于 9:30 开盘价，未超过 30 只`
        : openingStats && openingStats.belowCount > 30
          ? `开盘后自选股共 ${openingStats.total} 只，${openingStats.belowCount} 只现价低于 9:30 开盘价，超过 30 只阈值，市场开盘跳水严重`
          : '分时数据获取异常',
    });
    if (!check7Passed) allPassed = false;
  } else {
    // 非开盘时段，添加一个跳过的检查项
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: true,
      value: '非交易时段',
      reason: '此项检查仅在交易日 9:30-10:00 之间生效，当前时段跳过',
    });
  }

  return {
    success: true,
    data: {
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      refreshed: refresh,
      checks,
      allPassed,
      conclusion: allPassed
        ? '可以出手买入，但是请分仓 1/3，随后逐步分批买入，分仓管理是最后一道防火墙，谨防尾盘大盘跳水！'
        : '当前条件未全部满足，请耐心等待，不要盲目出手。',
    },
  };
}

module.exports = {
  runDisasterRecoveryCheck,
};
