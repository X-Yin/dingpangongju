/**
 * 买卖点诊断服务 - 基于情绪冰点与量价关系的交易策略
 *
 * 核心逻辑：在情绪冰点后的次日寻找强势个股的买入机会，并通过技术指标和量价关系判断卖出时机
 *
 * ============================================
 * 情绪冰点判断（满足任一条件即可）：
 *   条件1：前一日科技情绪指数 < -30（极度恐慌，归一化后）
 *   条件2：前两日科技情绪指数连续为负数（持续低迷）
 *   条件3：前三天科技情绪指数平均值 < 0（整体弱势）
 *
 * ============================================
 * 买点触发条件（需全部满足）：
 *   1. 前一日为情绪冰点（市场恐慌后的反弹窗口）
 *   2. 所跟踪的指数当日上涨超过 1%（sh688 开头跟踪科创板 sh000688，其他跟踪创业板 sz399006）
 *   3. 当天科技情绪指数不能小于 -40（市场整体情绪不能极度低迷，未到退潮期）
 *   4. 当前 10 日线斜率不能为负（MA10 不能呈下降趋势，趋势走弱不买）
 *   5. 该股票当日抗分歧指数 > 8
 *   买入价格：(当日收盘价 + 当日开盘价) / 2（取日内均价，降低滑点影响）
 *
 * ============================================
 * 卖点触发条件（满足任一即可）：
 *   1. 收盘价跌破 10 日线（收盘价 < MA10，趋势破位）
 *   2. 高位阴线（收盘跌幅超过 -5%，主力出货信号）
 *   3. 科技板块情绪退潮 == -100（市场整体情绪极度低迷，避险卖出）
 *   4. 抗分歧指数 < 6 且 涨幅 ≤ -5%（14:50后生效，个股抗跌性弱且正在下跌）
 *   5. 连续三天（含当日）抗分歧指数均 < 10（个股连续弱势，资金持续分歧），仅 9:40 后生效
 *   6. 现价跌破最迟一天买入（最近一次加仓）当日的最低点，且持续 ≥5 分钟（买入成本线告破）
 *   7. 现价跌破持仓成本线（用户在持仓中自定义的成本价）
 */
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const axios = require('axios');
const { getSingleStockData, getSingleStockTlineData, getSingleStockTlineDataByDate, getAllStockData } = require('./stock');
const { getAllTechIndexData, updateCurrentTechIndexData, getCurrentTechEmotion, getTechEmotionIntraday, getLatestTechEmotion } = require('./emotion');
const { calculateResilience, getLimitTypeByCode } = require('./stockDiagnose');
const { getMonitorStocks } = require('./monitorStock');
const { getStockPositions } = require('./stockPosition');
const { loadReportIndex, sumReportCount } = require('./buySellBacktest');
const { getAmountHistory, parseAmountToYi } = require('./amount');
const { getDaPanData } = require('./dapan');
const { getClsReqUrl, getClsReqStockTlineUrl, batchParallel, sleep } = require('../utils');
const { useCLS } = require('../config');

const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
const monitorAlarmsPath = path.resolve(__dirname, '../data/monitor_alarms.json');
const dapanDataPath = path.resolve(__dirname, '../data/dapanData.json');

// ========== 工具函数 ==========

const formatDateStr = (dateNum) => {
  const str = String(dateNum);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
};

// ========== 卖点条件持续时间追踪（内存缓存，仅当日实盘生效） ==========
// 记录条件1（均线破位）、条件2（高位放量大阴线）和条件3（科技板块情绪退潮）首次满足的时间戳，
// 需持续满足 ≥5 分钟才标记 satisfied=true，避免瞬时波动误触。
// 历史回测（非当日）不受影响，直接按当前值判定。
const SELL_CONDITION_PERSIST_MIN = 5; // 分钟
const sellConditionFirstTrueMap = {}; // { [code]: { date, condition1: timestamp|null, condition2: timestamp|null, condition3: timestamp|null, condition6: timestamp|null } }

// 获取或初始化某股票的条件追踪记录（自动按日期重置）
const getOrInitSellConditionTrack = (code, date) => {
  const existing = sellConditionFirstTrueMap[code];
  if (!existing || existing.date !== date) {
    sellConditionFirstTrueMap[code] = { date, condition1: null, condition2: null, condition3: null, condition6: null };
  }
  return sellConditionFirstTrueMap[code];
};

// 判断条件是否已持续满足足够时间，返回 { satisfied, pending, pendingMinutes }
const evaluateSellConditionPersist = (code, date, conditionKey, isCurrentlyTrue) => {
  const track = getOrInitSellConditionTrack(code, date);
  const now = Date.now();
  if (isCurrentlyTrue) {
    if (track[conditionKey] === null) {
      // 首次满足，记录时间戳
      track[conditionKey] = now;
      return { satisfied: false, pending: true, pendingMinutes: 0 };
    }
    const elapsedMin = Math.floor((now - track[conditionKey]) / 60000);
    if (elapsedMin >= SELL_CONDITION_PERSIST_MIN) {
      return { satisfied: true, pending: false, pendingMinutes: elapsedMin };
    }
    return { satisfied: false, pending: true, pendingMinutes: elapsedMin };
  } else {
    // 当前不满足，清除时间戳
    track[conditionKey] = null;
    return { satisfied: false, pending: false, pendingMinutes: 0 };
  }
};

const parseDateNum = (dateNum) => {
  const str = String(dateNum);
  return new Date(
    parseInt(str.substring(0, 4)),
    parseInt(str.substring(4, 6)) - 1,
    parseInt(str.substring(6, 8))
  );
};

// 读取持仓收益操作记录与持仓管理记录，返回该股票最近一次加仓（买入或推进仓位）的日期（YYYYMMDD），无记录返回 null
const getLastBuyDay = (code) => {
  let lastDate = null;
  try {
    const returnsPath = path.resolve(__dirname, '../data/stock_position_returns.json');
    const returns = JSON.parse(fs.readFileSync(returnsPath, 'utf8'));
    for (const r of returns) {
      const ops = Array.isArray(r.operations) ? r.operations : [];
      const hasBuy = ops.some(op => op && String(op.stockCode || '') === code && (op.action === 'buy' || op.action === 'pipeline'));
      if (hasBuy) {
        const d = String(r.date || '').replace(/-/g, '');
        if (d && (!lastDate || d > lastDate)) lastDate = d;
      }
    }
  } catch (e) { /* 文件不存在或解析失败时忽略 */ }
  try {
    const recordsPath = path.resolve(__dirname, '../data/stock_position_records.json');
    const records = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
    for (const rec of records) {
      if (rec && String(rec.code || '') === code && (rec.type === 'buy' || rec.type === 'pipeline')) {
        const d = String(rec.date || '').replace(/-/g, '');
        if (d && (!lastDate || d > lastDate)) lastDate = d;
      }
    }
  } catch (e) { /* 文件不存在或解析失败时忽略 */ }
  return lastDate;
};

const calcHoldingDays = (buyDate, sellDate) => {
  const start = parseDateNum(buyDate);
  const end = parseDateNum(sellDate);
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
};

// ========== 情绪冰点判断 ==========
// 判断情绪冰点：前一日情绪 < -40 或当日 hasIce:true / 前两日连续为负 / 前三天均值为负
// 前提：前一日情绪大于 45 一定不是情绪冰点（但 hasIce 和 < -40 优先判断，不受此前提限制）
const isEmotionFreezing = (techIndexData, targetDate) => {
  if (!Array.isArray(techIndexData) || techIndexData.length === 0) return false;

  const target = parseInt(targetDate);
  const sorted = [...techIndexData].sort((a, b) => a.date - b.date);

  // 取出所有 < targetDate 的数据，按日期升序
  const before = sorted.filter(item => parseInt(item.date) < target);
  if (before.length === 0) return false;

  const prev1 = before[before.length - 1];
  const prev2 = before.length >= 2 ? before[before.length - 2] : null;
  const prev3 = before.length >= 3 ? before[before.length - 3] : null;

  // 找当日数据，检查 hasIce（盘中分时触及冰点）
  const todayData = sorted.find(item => parseInt(item.date) === target);
  const todayHasIce = todayData && todayData.hasIce === true;

  // 条件1：当日 hasIce 或 前一日情绪 < -40
  if (todayHasIce) {
    return {
      isFreezing: true,
      reason: `当日(${formatDateStr(target)})盘中有分时触及冰点（hasIce）`,
      prev1, prev2, prev3,
    };
  }
  if (prev1 && typeof prev1.changeSumResult === 'number' && prev1.changeSumResult < -40) {
    return {
      isFreezing: true,
      reason: `前一日(${formatDateStr(prev1.date)})科技情绪指数 ${prev1.changeSumResult} < -40`,
      prev1, prev2, prev3,
    };
  }

  // 前提：前一日情绪大于 45 一定不是情绪冰点（hasIce 和 < -40 已在上方优先判断）
  if (Number(prev1.changeSumResult) > 45) {
    return {
      isFreezing: false,
      reason: '前一日/前两日/前三日未触发情绪冰点',
      prev1, prev2, prev3,
    };
  }

  // 条件2：前两日连续为负
  if (
    prev1 && prev2 &&
    typeof prev1.changeSumResult === 'number' &&
    typeof prev2.changeSumResult === 'number' &&
    prev1.changeSumResult < 0 && prev2.changeSumResult < 0
  ) {
    return {
      isFreezing: true,
      reason: `前两日科技情绪指数连续为负：${formatDateStr(prev2.date)}=${prev2.changeSumResult}，${formatDateStr(prev1.date)}=${prev1.changeSumResult}`,
      prev1, prev2, prev3,
    };
  }

  // 条件3：前三天平均值是负数
  if (
    prev1 && prev2 && prev3 &&
    typeof prev1.changeSumResult === 'number' &&
    typeof prev2.changeSumResult === 'number' &&
    typeof prev3.changeSumResult === 'number'
  ) {
    const avg3 = (prev1.changeSumResult + prev2.changeSumResult + prev3.changeSumResult) / 3;
    if (avg3 < 0) {
      return {
        isFreezing: true,
        reason: `前三天科技情绪指数平均值 ${avg3.toFixed(2)} < 0（${formatDateStr(prev3.date)}=${prev3.changeSumResult}，${formatDateStr(prev2.date)}=${prev2.changeSumResult}，${formatDateStr(prev1.date)}=${prev1.changeSumResult}）`,
        prev1, prev2, prev3,
        avg3: parseFloat(avg3.toFixed(2)),
      };
    }
  }

  return {
    isFreezing: false,
    reason: '前一日/前两日/前三日未触发情绪冰点',
    prev1, prev2, prev3,
  };
};

// ========== 当日分时情绪冰点判断 ==========
// 检查当日分时数据中是否有情绪低于阈值（默认 -40）的情况
// 用于买点诊断：今天上午情绪砸到冰点（<-40）然后下午弱转强拉起来也算买点
// 不再严格以天为单位判断情绪冰点
const hasTodayIntradayEmotionBelow = (threshold = -40) => {
  try {
    const { data: intradayData } = getTechEmotionIntraday();
    const today = dayjs().format('YYYYMMDD');
    const todayRecords = intradayData[today] || [];
    if (!Array.isArray(todayRecords) || todayRecords.length === 0) {
      return { hasBelow: false, min: null, belowRecords: [], records: [] };
    }
    const sorted = [...todayRecords].sort((a, b) => a.time.localeCompare(b.time));
    const belowRecords = sorted.filter(r =>
      r.value !== null && r.value !== undefined && !isNaN(r.value) && r.value < threshold
    );
    const values = sorted
      .map(r => r.value)
      .filter(v => v !== null && v !== undefined && !isNaN(v));
    const min = values.length > 0 ? Math.min(...values) : null;
    return {
      hasBelow: belowRecords.length > 0,
      min: min !== null ? parseFloat(min.toFixed(2)) : null,
      belowRecords,
      records: sorted,
    };
  } catch (e) {
    return { hasBelow: false, min: null, belowRecords: [], records: [], error: e.message };
  }
};

// ========== 容灾前置检查辅助函数 ==========
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

    // 开盘初期（9:30:00-9:34:59，开盘不满 5 分钟）：不足 5 分钟找不到"5min 前"基准，
    // 回退计算 9:30 开盘至当前的累计净流入，同样参与 20 亿阈值判定（sinceOpen 标记）
    if (latestTotalSec >= 9 * 3600 + 30 * 60 && latestTotalSec < 9 * 3600 + 35 * 60) {
      const openEntry = sorted.find(e => e[0] >= '093000') || sorted[0];
      if (openEntry !== latest) {
        const openValue = parseAmountValue(openEntry[1]?.mainMoney);
        const openDiff = latestValue - openValue;
        return {
          hasData: true,
          sinceOpen: true,
          diff: parseFloat(openDiff.toFixed(2)),
          currentValue: parseFloat(latestValue.toFixed(2)),
          pastValue: parseFloat(openValue.toFixed(2)),
          currentTime: `${latestTime.substring(0, 2)}:${latestTime.substring(2, 4)}:${latestTime.substring(4, 6)}`,
          pastTime: `${openEntry[0].substring(0, 2)}:${openEntry[0].substring(2, 4)}:${openEntry[0].substring(4, 6)}`,
        };
      }
    }

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

// 量能数据：当前 amountChangeDiff 及相较 5 分钟前的变化
// amountChangeDiff = 今日累计成交额 − 昨日全天成交额（单位亿，带正负号）
// 买点诊断仅需当前 amountChangeDiff 为正；diff（现在 − 5min前）仅作展示参考
function getRecent5MinVolumeChange() {
  try {
    const history = getAmountHistory();
    if (!history || history.length < 1) {
      return { hasData: false, diff: 0, last5minVol: 0, prev5minVol: 0, currentTime: null, pastTime: null };
    }

    const sorted = [...history].sort((a, b) => a[0].localeCompare(b[0]));
    const fmt = (t) => `${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`;

    // 在 sorted 中从 startIdx 向前找距离 baseSec 约 4~6 分钟（240~360 秒）最近的条目；
    // 找不到则回退取第一条 >=240 秒的条目。返回 { entry, idx } 或 null
    const findEntryBefore = (baseSec, startIdx) => {
      let hit = null;
      let hitIdx = -1;
      let minDelta = Infinity;
      for (let i = startIdx; i >= 0; i--) {
        const t = sorted[i][0];
        const totalSec = timeStrToSeconds(t);
        const diff = baseSec - totalSec;
        if (diff >= 240 && diff <= 360) {
          if (diff < minDelta) { minDelta = diff; hit = sorted[i]; hitIdx = i; }
        } else if (diff > 360) break;
      }
      if (!hit) {
        for (let i = startIdx; i >= 0; i--) {
          const t = sorted[i][0];
          const totalSec = timeStrToSeconds(t);
          if (baseSec - totalSec >= 240) { hit = sorted[i]; hitIdx = i; break; }
        }
      }
      return hit ? { entry: hit, idx: hitIdx } : null;
    };

    const latest = sorted[sorted.length - 1];
    const latestTime = latest[0];
    const last5minVol = parseAmountToYi(latest[1]?.amountChangeDiff); // 当前 amountChangeDiff
    const latestTotalSec = timeStrToSeconds(latestTime);

    // 5 分钟前的条目（仅作展示参考）
    const pastHit = findEntryBefore(latestTotalSec, sorted.length - 2);
    if (!pastHit) {
      return { hasData: true, diff: 0, last5minVol: parseFloat(last5minVol.toFixed(2)), prev5minVol: 0, currentTime: fmt(latestTime), pastTime: null };
    }
    const pastTime = pastHit.entry[0];
    const prev5minVol = parseAmountToYi(pastHit.entry[1]?.amountChangeDiff); // 5min 前 amountChangeDiff
    const diff = last5minVol - prev5minVol; // 正=放量，负=缩量

    return {
      hasData: true,
      diff: parseFloat(diff.toFixed(2)),
      last5minVol: parseFloat(last5minVol.toFixed(2)),
      prev5minVol: parseFloat(prev5minVol.toFixed(2)),
      currentTime: fmt(latestTime),
      pastTime: fmt(pastTime),
    };
  } catch (e) {
    return { hasData: false, diff: 0, last5minVol: 0, prev5minVol: 0, currentTime: null, pastTime: null, error: e.message };
  }
}

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

function getMonitorStocksChangeFromCache() {
  try {
    const stockDataPathLocal = path.resolve(__dirname, '../data/stockData.json');
    if (!fs.existsSync(stockDataPathLocal)) return null;
    const stockData = JSON.parse(fs.readFileSync(stockDataPathLocal, 'utf-8'));
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

function isInOpeningCheckWindow() {
  const now = dayjs();
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const hour = now.hour();
  const minute = now.minute();
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight <= 10 * 60;
}

// fetchOpeningBelowCount 结果缓存：开盘时段多个前端每10秒轮询均触发全量分时爬取，
// 30 秒内复用结果（计数型检查，30 秒新鲜度足够）
let _openingBelowCache = { ts: 0, data: null };
const OPENING_BELOW_CACHE_INTERVAL = 30 * 1000;

async function fetchOpeningBelowCount() {
  if (_openingBelowCache.data && Date.now() - _openingBelowCache.ts < OPENING_BELOW_CACHE_INTERVAL) {
    return _openingBelowCache.data;
  }
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

    const result = {
      belowCount,
      total: stockCodes.length,
      validCount,
      list: results.filter(r => r.openingPrice !== null && r.currentPrice !== null && r.currentPrice < r.openingPrice),
    };
    _openingBelowCache = { ts: Date.now(), data: result };
    return result;
  } catch (e) {
    console.error('获取分时数据失败:', e.message);
    return { belowCount: 0, total: 0, validCount: 0, list: [], error: e.message };
  }
}

// ========== 买点诊断 ==========
// 买点触发条件（需全部满足）：
//   1. 前一日为情绪冰点（前一日科技情绪指数 < -30，或前两日连续为负，或前三天平均值为负）
//   2. 所跟踪的指数当日上涨超过 1%（sh688 开头跟踪科创板 sh000688，其他跟踪创业板 sz399006）
//   3. 当天科技情绪指数不能小于 -40（市场整体情绪未到退潮期）
//   4. 该股票当日抗分歧指数 > 8
// 买入价格：(当日收盘价 + 当日开盘价) / 2
const checkBuyPoint = async (code, tradeDate, klineData, prefetchedStockTline = null, prefetchedIndexTline = null) => {
  const date = parseInt(tradeDate);
  const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);

  const targetIdx = sortedKline.findIndex(k => k.trade_date === date);
  if (targetIdx < 0) {
    return { isBuy: false, reason: `${formatDateStr(date)} 无K线数据` };
  }

  const targetKline = sortedKline[targetIdx];
  const openPrice = parseFloat(targetKline.open_px);
  const closePrice = parseFloat(targetKline.close_px);
  const change = parseFloat(targetKline.change || 0);
  const prevClose = targetIdx > 0 ? parseFloat(sortedKline[targetIdx - 1].close_px) : closePrice;
  const openChange = prevClose > 0 ? parseFloat(((openPrice - prevClose) / prevClose * 100).toFixed(2)) : 0;
  if (!(openPrice > 0) || !(closePrice > 0)) {
    return { isBuy: false, reason: 'K线价格异常' };
  }

  // 买入价格：(收盘价 + 开盘价) / 2
  const buyPrice = parseFloat(((closePrice + openPrice) / 2).toFixed(2));

  // ========== 判断买点：情绪冰点次日 + 指数涨幅 > 1% + 当天科技情绪指数 >= -40 + 10日线斜率非负 + 抗分歧指数 > 8 ==========
  const isSh688 = code.startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const indexName = isSh688 ? '科创板' : '创业板';

  try {
    // 条件1：前一日必须是情绪冰点（前提条件）
    const techIndexData = getAllTechIndexData();
    const freezing = isEmotionFreezing(techIndexData, date);
    if (!freezing.isFreezing) {
      return {
        isBuy: false,
        openPrice,
        closePrice,
        buyPrice,
        change,
        prevClose,
        openChange,
        reason: `前一日未触发情绪冰点（${freezing.reason}），不具备买点前提`,
        indexCode,
        indexName,
        isFreezingDay: false,
      };
    }

    const indexTline = prefetchedIndexTline || await getSingleStockTlineDataByDate(indexCode, date);
    const indexLine = indexTline?.line || [];
    if (indexLine.length === 0) {
      return { isBuy: false, openPrice, closePrice, buyPrice, change, prevClose, openChange, reason: `${indexName}指数无分时数据`, isFreezingDay: true };
    }

    const lastIndexPoint = indexLine[indexLine.length - 1];
    const indexChange = parseFloat(lastIndexPoint.change || 0);

    // 条件2：跟踪指数当日上涨超过 1%
    if (indexChange <= 1) {
      return {
        isBuy: false,
        openPrice,
        closePrice,
        buyPrice,
        change,
        prevClose,
        openChange,
        reason: `${indexName}指数涨幅 ${indexChange.toFixed(2)}% 未超过 1%`,
        indexCode,
        indexName,
        indexChange: parseFloat(indexChange.toFixed(2)),
        isFreezingDay: true,
      };
    }

    // 条件3：当天科技情绪指数不能小于 -40（未到退潮期才可入场）
    if (Array.isArray(techIndexData) && techIndexData.length > 0) {
      const sortedTech = [...techIndexData].sort((a, b) => a.date - b.date);
      const targetTechIdx = sortedTech.findIndex(t => parseInt(t.date) === date);
      if (targetTechIdx >= 0) {
        const techIndex = sortedTech[targetTechIdx];
        const techChange = parseFloat(techIndex.changeSumResult || 0);
        if (techChange < -40) {
          return {
            isBuy: false,
            openPrice,
            closePrice,
            buyPrice,
            change,
            prevClose,
            openChange,
            reason: `当天科技情绪指数 ${techChange.toFixed(2)} < -40，市场处于退潮期，情绪极度低迷`,
            indexCode,
            indexName,
            indexChange: parseFloat(indexChange.toFixed(2)),
            techEmotion: parseFloat(techChange.toFixed(2)),
            isFreezingDay: true,
          };
        }
      }
    }

    // 条件4：10日线斜率不能为负
    let ma10 = targetKline.ma10_px;
    if (ma10 === undefined || ma10 === null) {
      if (targetIdx >= 9) {
        const last10 = sortedKline.slice(targetIdx - 9, targetIdx + 1);
        ma10 = last10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
      }
    }
    ma10 = ma10 !== undefined && ma10 !== null ? parseFloat(ma10) : null;

    let ma10Slope = null;
    if (ma10 !== null && targetIdx >= 14) {
      const prev5Idx = targetIdx - 5;
      let prevMa10 = sortedKline[prev5Idx].ma10_px;
      if (prevMa10 === undefined || prevMa10 === null) {
        const prev10 = sortedKline.slice(prev5Idx - 9, prev5Idx + 1);
        prevMa10 = prev10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
      }
      prevMa10 = parseFloat(prevMa10);
      ma10Slope = ma10 - prevMa10;
    }

    if (ma10Slope !== null && ma10Slope < 0) {
      return {
        isBuy: false,
        openPrice,
        closePrice,
        buyPrice,
        change,
        prevClose,
        openChange,
        reason: `10日线斜率 ${ma10Slope.toFixed(2)} 为负，MA10呈下降趋势，不满足买点条件`,
        indexCode,
        indexName,
        indexChange: parseFloat(indexChange.toFixed(2)),
        isFreezingDay: true,
        ma10Slope: parseFloat(ma10Slope.toFixed(2)),
      };
    }

    // 条件5：价格不能低于10日线
    if (ma10 !== null && closePrice < ma10) {
      return {
        isBuy: false,
        openPrice,
        closePrice,
        buyPrice,
        change,
        prevClose,
        openChange,
        reason: `收盘价 ${closePrice.toFixed(2)} 低于10日线 ${ma10.toFixed(2)}，不满足买点条件`,
        indexCode,
        indexName,
        indexChange: parseFloat(indexChange.toFixed(2)),
        isFreezingDay: true,
        ma10: parseFloat(ma10.toFixed(2)),
      };
    }

    // 条件6：该股票当日抗分歧指数 > 8
    const stockTline = prefetchedStockTline || await getSingleStockTlineDataByDate(code, date);
    const stockLine = stockTline?.line || [];
    if (stockLine.length === 0) {
      return { isBuy: false, openPrice, closePrice, buyPrice, change, prevClose, openChange, reason: '股票无分时数据', indexCode, indexName, indexChange: parseFloat(indexChange.toFixed(2)), isFreezingDay: true };
    }

    const limitType = getLimitTypeByCode(code);
    const resilienceScore = calculateResilience(indexLine, stockLine, limitType);
    if (resilienceScore <= 8) {
      return {
        isBuy: false,
        openPrice,
        closePrice,
        buyPrice,
        change,
        prevClose,
        openChange,
        reason: `抗分歧指数 ${resilienceScore.toFixed(2)} 未超过 8`,
        indexCode,
        indexName,
        indexChange: parseFloat(indexChange.toFixed(2)),
        resilienceScore: parseFloat(resilienceScore.toFixed(2)),
        isFreezingDay: true,
      };
    }

    return {
      isBuy: true,
      buyType: '综合买点',
      openPrice,
      isFreezingDay: true,
      closePrice,
      buyPrice,
      change,
      prevClose,
      openChange,
      reason: `${indexName}指数上涨 ${indexChange.toFixed(2)}%，抗分歧指数 ${resilienceScore.toFixed(2)} > 8`,
      indexCode,
      indexName,
      indexChange: parseFloat(indexChange.toFixed(2)),
      resilienceScore: parseFloat(resilienceScore.toFixed(2)),
    };

  } catch (e) {
    return { isBuy: false, openPrice, closePrice, buyPrice, change, prevClose, openChange, reason: `获取分时数据失败: ${e.message}` };
  }
};

// ========== 卖点诊断 ==========
// 卖点触发条件（满足任一即可）：
//   1. 收盘价跌破 10 日线（根据 MA10 斜率判断）：
//      - MA10 斜率为正（上升趋势）：收盘价 < MA10 即卖点
//      - MA10 斜率为负（下降趋势）：收盘价未站上 5 日线（收盘价 < MA5）即卖点
//   2. 高位大阴线（当日最高最低振幅超过 5 个点，且为阴线：最新价低于开盘价）
//   3. 科技板块情绪退潮 == -100 且自选股中跌幅 <-9% 的个股 >= 5 个（市场整体情绪极度低迷，避险卖出）
//   4. 抗分歧指数 < 6（个股抗跌性弱，资金分歧大）

// 统计自选股中当前跌幅低于 threshold（如 -9，表示跌幅超过 9%）的个股数量
const countWatchlistStocksBelow = (threshold) => {
  try {
    const allStockData = getAllStockData();
    if (!Array.isArray(allStockData)) return 0;
    return allStockData.filter((stock) => {
      const change = parseFloat(stock.change);
      return !isNaN(change) && change < threshold;
    }).length;
  } catch (error) {
    console.error('统计自选股跌幅失败:', error.message);
    return 0;
  }
};
const checkSellPoint = async (code, tradeDate, klineData, prefetchedStockTline = null, prefetchedIndexTline = null) => {
  const date = parseInt(tradeDate);
  const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
  const targetIdx = sortedKline.findIndex(k => k.trade_date === date);
  if (targetIdx < 0) {
    return { isSell: false, reason: `${formatDateStr(date)} 无K线数据` };
  }

  const targetKline = sortedKline[targetIdx];
  const closePrice = parseFloat(targetKline.close_px);

  let ma5 = targetKline.ma5_px;
  if (ma5 === undefined || ma5 === null) {
    if (targetIdx >= 4) {
      const last5 = sortedKline.slice(targetIdx - 4, targetIdx + 1);
      ma5 = last5.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 5;
    }
  }
  ma5 = ma5 !== undefined && ma5 !== null ? parseFloat(ma5) : null;

  let ma10 = targetKline.ma10_px;
  if (ma10 === undefined || ma10 === null) {
    if (targetIdx >= 9) {
      const last10 = sortedKline.slice(targetIdx - 9, targetIdx + 1);
      ma10 = last10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
    }
  }
  ma10 = ma10 !== undefined && ma10 !== null ? parseFloat(ma10) : null;

  // 计算 MA5 斜率（当前 MA5 - 5 天前的 MA5）
  let ma5Slope = null;
  if (ma5 !== null && targetIdx >= 9) {
    const prev5Idx = targetIdx - 5;
    let prevMa5 = sortedKline[prev5Idx].ma5_px;
    if (prevMa5 === undefined || prevMa5 === null) {
      const prev5 = sortedKline.slice(prev5Idx - 4, prev5Idx + 1);
      prevMa5 = prev5.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 5;
    }
    prevMa5 = parseFloat(prevMa5);
    ma5Slope = ma5 - prevMa5;
  }

  // 计算 MA10 斜率（用过去5天的MA10变化来判断）
  let ma10Slope = null;
  if (ma10 !== null && targetIdx >= 14) {
    const prev5Idx = targetIdx - 5;
    let prevMa10 = sortedKline[prev5Idx].ma10_px;
    if (prevMa10 === undefined || prevMa10 === null) {
      const prev10 = sortedKline.slice(prev5Idx - 9, prev5Idx + 1);
      prevMa10 = prev10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
    }
    prevMa10 = parseFloat(prevMa10);
    ma10Slope = ma10 - prevMa10;
  }

  // 条件1：均线破位（根据 MA5/MA10 斜率 + 开盘价位置，四种情况判断）
  // 历史回测：跌破即触发；当日实盘：跌破需持续 ≥5 分钟才触发
  // ① MA10斜率<0, MA5斜率>0, 开盘价>MA10 → 跌破MA10为卖点
  // ② MA10斜率<0, MA5斜率≤0 → 跌破前一日最低价为卖点
  // ③ MA10斜率<0, MA5斜率>0, 开盘价≤MA10 → 跌破MA5为卖点
  // ④ MA10斜率≥0（含数据不足）→ 跌破MA10为卖点
  if (ma10 !== null) {
    const openPriceForC1 = parseFloat(targetKline.open_px);
    let prevDayLow = null;
    if (targetIdx >= 1) {
      const prevLowRaw = parseFloat(sortedKline[targetIdx - 1].low_px);
      if (Number.isFinite(prevLowRaw) && prevLowRaw > 0) prevDayLow = prevLowRaw;
    }

    let ruleType = 4;
    if (ma10Slope !== null && ma10Slope < 0) {
      if (ma5Slope !== null && ma5Slope > 0) {
        ruleType = openPriceForC1 > ma10 ? 1 : 3;
      } else {
        ruleType = 2;
      }
    }

    let cond1Result = null;
    if (ruleType === 1) {
      // 规则①：MA10↓ MA5↑ 开盘>MA10 → 跌破MA10
      if (closePrice < ma10) {
        cond1Result = {
          isSell: true, sellPrice: closePrice, ma5, ma10, ma5Slope: ma5Slope !== null ? parseFloat(ma5Slope.toFixed(2)) : null,
          ma10Slope: ma10Slope !== null ? parseFloat(ma10Slope.toFixed(2)) : null,
          reason: `规则①：MA10↓(${ma10Slope?.toFixed(2) ?? '--'}) MA5↑(${ma5Slope?.toFixed(2) ?? '--'}) 开盘价${openPriceForC1.toFixed(2)}>MA10 → 现价 ${closePrice.toFixed(2)} 跌破 10 日线 ${ma10.toFixed(2)}`,
        };
      }
    } else if (ruleType === 2) {
      // 规则②：MA10↓ MA5↓ → 跌破前一日最低价
      if (prevDayLow !== null && closePrice < prevDayLow) {
        cond1Result = {
          isSell: true, sellPrice: closePrice, ma5, ma10, ma5Slope: ma5Slope !== null ? parseFloat(ma5Slope.toFixed(2)) : null,
          ma10Slope: ma10Slope !== null ? parseFloat(ma10Slope.toFixed(2)) : null,
          reason: `规则②：MA10↓(${ma10Slope?.toFixed(2) ?? '--'}) MA5↓ → 现价 ${closePrice.toFixed(2)} 跌破前一交易日最低价 ${prevDayLow.toFixed(2)}`,
        };
      }
    } else if (ruleType === 3) {
      // 规则③：MA10↓ MA5↑ 开盘≤MA10 → 跌破MA5
      if (ma5 !== null && closePrice < ma5) {
        cond1Result = {
          isSell: true, sellPrice: closePrice, ma5, ma10, ma5Slope: ma5Slope !== null ? parseFloat(ma5Slope.toFixed(2)) : null,
          ma10Slope: ma10Slope !== null ? parseFloat(ma10Slope.toFixed(2)) : null,
          reason: `规则③：MA10↓(${ma10Slope?.toFixed(2) ?? '--'}) MA5↑(${ma5Slope?.toFixed(2) ?? '--'}) 开盘价${openPriceForC1.toFixed(2)}≤MA10 → 现价 ${closePrice.toFixed(2)} 跌破 5 日线 ${ma5.toFixed(2)}`,
        };
      }
    } else {
      // 规则④：MA10↑ → 跌破MA10
      if (closePrice < ma10) {
        cond1Result = {
          isSell: true, sellPrice: closePrice, ma5, ma10, ma5Slope: ma5Slope !== null ? parseFloat(ma5Slope.toFixed(2)) : null,
          ma10Slope: ma10Slope !== null ? parseFloat(ma10Slope.toFixed(2)) : null,
          reason: `规则④：MA10${ma10Slope !== null ? '↑(' + ma10Slope.toFixed(2) + ')' : '斜率非负'} → 现价 ${closePrice.toFixed(2)} 跌破 10 日线 ${ma10.toFixed(2)}`,
        };
      }
    }

    // 当日实盘：跌破需持续 ≥5 分钟才触发，历史回测直接按当前值判定
    const isLiveTodayForCond1 = date === parseInt(dayjs().format('YYYYMMDD'));
    if (isLiveTodayForCond1) {
      const persist = evaluateSellConditionPersist(code, date, 'condition1', cond1Result !== null);
      if (!persist.satisfied) cond1Result = null;
    }
    if (cond1Result) {
      return cond1Result;
    }
  }

  // 条件2：高位放量大阴线（最高价到收盘价回落超过 8%，且为阴线：最新价低于开盘价）
  const openPrice = parseFloat(targetKline.open_px);
  const highPrice = parseFloat(targetKline.high_px);
  const lowPrice = parseFloat(targetKline.low_px);
  const amplitude = closePrice > 0 ? ((highPrice - closePrice) / closePrice) * 100 : 0;
  const isCondition2RawTrue = amplitude > 8 && closePrice < openPrice;
  // 当日实盘需持续满足 ≥5 分钟才触发，历史回测直接按当前值判定
  const isLiveTodayForCond2 = date === parseInt(dayjs().format('YYYYMMDD'));
  let cond2Satisfied = isCondition2RawTrue;
  if (isLiveTodayForCond2) {
    cond2Satisfied = evaluateSellConditionPersist(code, date, 'condition2', isCondition2RawTrue).satisfied;
  }
  if (cond2Satisfied) {
    return {
      isSell: true,
      sellPrice: closePrice,
      ma10,
      openPrice: parseFloat(openPrice.toFixed(2)),
      highPrice: parseFloat(highPrice.toFixed(2)),
      lowPrice: parseFloat(lowPrice.toFixed(2)),
      amplitude: parseFloat(amplitude.toFixed(2)),
      reason: `高位放量大阴线（回落 ${amplitude.toFixed(2)}% > 8%，收盘 ${closePrice.toFixed(2)} < 开盘 ${openPrice.toFixed(2)}）`,
    };
  }

  // 条件3：科技板块情绪退潮 == -100（同步检查，优先判断以避免不必要的异步调用）
  const techIndexData = getAllTechIndexData();
  if (Array.isArray(techIndexData) && techIndexData.length > 0) {
    const sortedTech = [...techIndexData].sort((a, b) => a.date - b.date);
    const targetTechIdx = sortedTech.findIndex(t => parseInt(t.date) === date);
    if (targetTechIdx >= 0) {
      const techIndex = sortedTech[targetTechIdx];
      const techChange = parseFloat(techIndex.changeSumResult || 0);
      // 条件3：科技板块情绪退潮 == -100，且自选股中跌幅 <-9% 的个股 >= 5 个
      if (techChange === -100) {
        const downStocksCount = countWatchlistStocksBelow(-9);
        if (downStocksCount >= 5) {
          // 当日实盘需持续满足 ≥5 分钟才触发，历史回测直接按当前值判定
          const isLiveTodayForCond3 = date === parseInt(dayjs().format('YYYYMMDD'));
          let cond3Satisfied = true;
          if (isLiveTodayForCond3) {
            cond3Satisfied = evaluateSellConditionPersist(code, date, 'condition3', true).satisfied;
          }
          if (cond3Satisfied) {
            return {
              isSell: true,
              sellPrice: closePrice,
              ma10,
              techEmotion: parseFloat(techChange.toFixed(2)),
              downStocksCount,
              reason: `科技板块情绪退潮 ${techChange.toFixed(2)} = -100 且自选股中跌幅<-9%的个股 ${downStocksCount} 个（>=5）`,
            };
          }
        }
      }
    }
  }

  // 条件4：抗分歧指数 < 6
  const isSh688 = code.startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';

  let stockTline, indexTline;
  try {
    if (prefetchedStockTline && prefetchedIndexTline) {
      stockTline = prefetchedStockTline;
      indexTline = prefetchedIndexTline;
    } else {
      [stockTline, indexTline] = await Promise.all([
        getSingleStockTlineDataByDate(code, date),
        getSingleStockTlineDataByDate(indexCode, date),
      ]);
    }
  } catch (e) {
    return {
      isSell: false,
      closePrice,
      ma10,
      reason: `获取分时数据失败: ${e.message}`,
    };
  }

  const stockLine = stockTline?.line || [];
  const indexLine = indexTline?.line || [];

  if (stockLine.length >= 5 && indexLine.length >= 5) {
    const limitType = getLimitTypeByCode(code);
    const score = calculateResilience(indexLine, stockLine, limitType);
    if (score < 6) {
      return {
        isSell: true,
        sellPrice: closePrice,
        ma10,
        resilienceScore: parseFloat(score.toFixed(2)),
        reason: `抗分歧指数 ${score.toFixed(2)} < 6`,
      };
    }
  }

  return {
    isSell: false,
    closePrice,
    ma10,
    resilienceScore: null,
    reason: '未触发卖点',
  };
};

// ========== 卖点详细诊断（逐一列出所有条件的满足情况） ==========
const checkSellPointDetailed = async (code, tradeDate, klineData, costPrice = null) => {
  const date = parseInt(tradeDate);
  const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
  const targetIdx = sortedKline.findIndex(k => k.trade_date === date);
  if (targetIdx < 0) {
    return {
      isSell: false,
      closePrice: null,
      conditions: [],
      conclusion: `${formatDateStr(date)} 无K线数据，无法诊断`,
    };
  }

  const targetKline = sortedKline[targetIdx];
  const closePrice = parseFloat(targetKline.close_px);
  const change = parseFloat(targetKline.change || 0);

  // 计算 MA5
  let ma5 = targetKline.ma5_px;
  if (ma5 === undefined || ma5 === null) {
    if (targetIdx >= 4) {
      const last5 = sortedKline.slice(targetIdx - 4, targetIdx + 1);
      ma5 = last5.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 5;
    }
  }
  ma5 = ma5 !== undefined && ma5 !== null ? parseFloat(ma5) : null;

  // 计算 MA10
  let ma10 = targetKline.ma10_px;
  if (ma10 === undefined || ma10 === null) {
    if (targetIdx >= 9) {
      const last10 = sortedKline.slice(targetIdx - 9, targetIdx + 1);
      ma10 = last10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
    }
  }
  ma10 = ma10 !== undefined && ma10 !== null ? parseFloat(ma10) : null;

  // 计算 MA5 斜率（当前 MA5 - 5 天前的 MA5）
  let ma5Slope = null;
  if (ma5 !== null && targetIdx >= 9) {
    const prev5Idx = targetIdx - 5;
    let prevMa5 = sortedKline[prev5Idx].ma5_px;
    if (prevMa5 === undefined || prevMa5 === null) {
      const prev5 = sortedKline.slice(prev5Idx - 4, prev5Idx + 1);
      prevMa5 = prev5.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 5;
    }
    prevMa5 = parseFloat(prevMa5);
    ma5Slope = ma5 - prevMa5;
  }

  // 计算 MA10 斜率
  let ma10Slope = null;
  if (ma10 !== null && targetIdx >= 14) {
    const prev5Idx = targetIdx - 5;
    let prevMa10 = sortedKline[prev5Idx].ma10_px;
    if (prevMa10 === undefined || prevMa10 === null) {
      const prev10 = sortedKline.slice(prev5Idx - 9, prev5Idx + 1);
      prevMa10 = prev10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
    }
    prevMa10 = parseFloat(prevMa10);
    ma10Slope = ma10 - prevMa10;
  }

  // 条件1：均线破位（根据 MA5/MA10 斜率 + 开盘价位置，四种情况判断）
  // ① MA10斜率<0, MA5斜率>0, 开盘价>MA10 → 跌破MA10为卖点
  // ② MA10斜率<0, MA5斜率≤0 → 跌破前一日最低价为卖点
  // ③ MA10斜率<0, MA5斜率>0, 开盘价≤MA10 → 跌破MA5为卖点
  // ④ MA10斜率≥0（含数据不足）→ 跌破MA10为卖点
  // 历史日期（回测）按收盘定格处理，等同 14:50 后规则
  let condition1 = {
    name: '均线破位',
    satisfied: false,
    pending: false,
    pendingMinutes: 0,
    detail: '',
    subConditions: [],
  };
  // 前一交易日最低价
  let prevDayLow = null;
  if (targetIdx >= 1) {
    const prevLowRaw = parseFloat(sortedKline[targetIdx - 1].low_px);
    if (Number.isFinite(prevLowRaw) && prevLowRaw > 0) prevDayLow = prevLowRaw;
  }
  // 当日开盘价
  const openPriceForC1 = parseFloat(targetKline.open_px);
  const isLiveToday = date === parseInt(dayjs().format('YYYYMMDD'));
  const inTradingWindow = isLiveToday && dayjs().format('HHmm') >= '0930' && dayjs().format('HHmm') < '1450';
  const deepFall = change < -3;

  if (ma10 === null) {
    condition1.detail = '数据不足，无法计算MA10';
    condition1.subConditions = [{ label: '状态', value: '数据不足' }];
  } else {
    // 判定属于哪种情况
    let ruleType = 4; // 默认规则④：MA10斜率≥0 → 跌破MA10
    let slopeInfo = '';
    if (ma10Slope !== null && ma10Slope < 0) {
      // MA10斜率为负
      if (ma5Slope !== null && ma5Slope > 0) {
        // MA5斜率为正 → 根据开盘价位置区分规则①和③
        if (openPriceForC1 > ma10) {
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
      // MA10斜率≥0 或数据不足 → 规则④
      ruleType = 4;
      if (ma10Slope !== null) {
        slopeInfo = `10日线斜率 ${ma10Slope.toFixed(2)} ≥ 0`;
      } else {
        slopeInfo = '10日线斜率数据不足（视为非负）';
      }
    }

    const formatRuleDetail = (ruleType, broken, triggerLine, triggerLabel) => {
      // 规则①③④：跌破某均线，9:30-14:50 需额外涨幅<-3%
      if (ruleType === 2) return null; // 规则②单独处理
      if (!broken) {
        return `现价 ${closePrice.toFixed(2)} 未跌破${triggerLabel} ${triggerLine.toFixed(2)}，未触发`;
      } else if (inTradingWindow && !deepFall) {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}，但当前涨幅 ${change.toFixed(2)}% 未低于 -3%（14:50 前需涨幅 < -3%），暂不触发`;
      } else if (inTradingWindow) {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}，且当前涨幅 ${change.toFixed(2)}% < -3%，触发卖点`;
      } else {
        return `现价 ${closePrice.toFixed(2)} 跌破${triggerLabel} ${triggerLine.toFixed(2)}${isLiveToday ? '（14:50 后跌破即触发）' : ''}，触发卖点`;
      }
    };

    const breakAndSetTradingWindow = (brokenRaw) => brokenRaw && (!inTradingWindow || deepFall);

    // 当日实盘：跌破需持续 ≥5 分钟才触发，历史回测直接按当前值判定
    const persistCond1 = (rawBroken) => {
      if (!isLiveToday) return { satisfied: rawBroken, pending: false, pendingMinutes: 0 };
      return evaluateSellConditionPersist(code, date, 'condition1', rawBroken);
    };

    if (ruleType === 1) {
      // 规则①：MA10斜率<0, MA5斜率>0, 开盘价>MA10 → 跌破MA10为卖点
      const broken = closePrice < ma10;
      const persist1 = persistCond1(broken);
      condition1.satisfied = breakAndSetTradingWindow(persist1.satisfied);
      condition1.pending = persist1.pending;
      condition1.pendingMinutes = persist1.pendingMinutes;
      const openPos = openPriceForC1 > ma10 ? '上方' : '附近或下方';
      condition1.detail = formatRuleDetail(1, broken, ma10, '10日线') || '';
      const extra = broken && inTradingWindow && !deepFall ? '' : `（${slopeInfo}，开盘价 ${openPriceForC1.toFixed(2)} 在10日线${openPos}，采用规则①）`;
      if (!broken) {
        condition1.detail += extra;
      } else if (!inTradingWindow || deepFall) {
        condition1.detail += `（${slopeInfo}，开盘价在10日线${openPos}）`;
      }
      condition1.subConditions = [
        { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
        { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
        { label: '开盘价', value: openPriceForC1.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '10日线', value: ma10.toFixed(2) },
        { label: '当前涨幅', value: `${change.toFixed(2)}%` },
        { label: '判断规则', value: '规则①：MA10↓ MA5↑ 开盘>MA10 → 跌破MA10（持续≥5分钟才触发）' },
      ];
    } else if (ruleType === 2) {
      // 规则②：MA10斜率<0, MA5斜率≤0 → 跌破前一日最低价为卖点
      const brokenPrevLow = prevDayLow !== null && closePrice < prevDayLow;
      const persist2 = persistCond1(brokenPrevLow);
      condition1.satisfied = persist2.satisfied;
      condition1.pending = persist2.pending;
      condition1.pendingMinutes = persist2.pendingMinutes;
      condition1.detail = prevDayLow === null
        ? `${slopeInfo}，改用前低判断，但缺少前一交易日最低价数据`
        : brokenPrevLow
          ? `${slopeInfo}，现价 ${closePrice.toFixed(2)} 跌破前一交易日最低价 ${prevDayLow.toFixed(2)}，下降趋势延续，触发卖点`
          : `${slopeInfo}，现价 ${closePrice.toFixed(2)} 未跌破前一交易日最低价 ${prevDayLow.toFixed(2)}，暂不触发`;
      condition1.subConditions = [
        { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
        { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '前一日最低价', value: prevDayLow !== null ? prevDayLow.toFixed(2) : '--' },
        { label: '判断规则', value: '规则②：MA10↓ MA5↓ → 跌破前一日最低价（持续≥5分钟才触发）' },
      ];
    } else if (ruleType === 3) {
      // 规则③：MA10斜率<0, MA5斜率>0, 开盘价≤MA10 → 跌破MA5为卖点
      if (ma5 !== null) {
        const broken = closePrice < ma5;
        const persist3 = persistCond1(broken);
        condition1.satisfied = breakAndSetTradingWindow(persist3.satisfied);
        condition1.pending = persist3.pending;
        condition1.pendingMinutes = persist3.pendingMinutes;
        const openPos = openPriceForC1 <= ma10 ? '下方或附近' : '上方';
        condition1.detail = formatRuleDetail(3, broken, ma5, '5日线') || '';
        if (!broken) {
          condition1.detail += `（${slopeInfo}，开盘价 ${openPriceForC1.toFixed(2)} 在10日线${openPos}，采用规则③）`;
        } else if (!inTradingWindow || deepFall) {
          condition1.detail += `（${slopeInfo}，开盘价在10日线${openPos}）`;
        }
        condition1.subConditions = [
          { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
          { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
          { label: '开盘价', value: openPriceForC1.toFixed(2) },
          { label: '现价', value: closePrice.toFixed(2) },
          { label: '5日线', value: ma5.toFixed(2) },
          { label: '10日线', value: ma10.toFixed(2) },
          { label: '当前涨幅', value: `${change.toFixed(2)}%` },
          { label: '判断规则', value: '规则③：MA10↓ MA5↑ 开盘≤MA10 → 跌破MA5（持续≥5分钟才触发）' },
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
      // 规则④：MA10斜率≥0 → 跌破MA10为卖点
      const broken = closePrice < ma10;
      const persist4 = persistCond1(broken);
      condition1.satisfied = breakAndSetTradingWindow(persist4.satisfied);
      condition1.pending = persist4.pending;
      condition1.pendingMinutes = persist4.pendingMinutes;
      condition1.detail = formatRuleDetail(4, broken, ma10, '10日线') || '';
      if (broken && !inTradingWindow) {
        condition1.detail += `（${slopeInfo}，上升趋势中跌破MA10）`;
      }
      condition1.subConditions = [
        { label: '10日线斜率', value: ma10Slope !== null ? ma10Slope.toFixed(2) : '--' },
        { label: '5日线斜率', value: ma5Slope !== null ? ma5Slope.toFixed(2) : '--' },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '10日线', value: ma10.toFixed(2) },
        { label: '当前涨幅', value: `${change.toFixed(2)}%` },
        { label: '当前时间', value: isLiveToday ? dayjs().format('HH:mm') : '历史日期（按收盘判定）' },
        { label: '判断规则', value: '规则④：MA10↑ → 跌破MA10（持续≥5分钟才触发）' },
      ];
    }

    // 补充 pending 提示到 detail
    if (condition1.pending) {
      condition1.detail += `（跌破已持续 ${condition1.pendingMinutes} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟才触发）`;
    }
  }

  // 条件2：高位放量大阴线（最高价到收盘价回落超过 8%，且为阴线：最新价低于开盘价）
  const openPrice = parseFloat(targetKline.open_px);
  const highPrice = parseFloat(targetKline.high_px);
  const amplitude = closePrice > 0 ? ((highPrice - closePrice) / closePrice) * 100 : 0;
  const isCondition2RawTrue = amplitude > 8 && closePrice < openPrice;
  // 当日实盘需持续满足 ≥5 分钟才触发，历史回测直接按当前值判定
  const isLiveTodayForCond2 = date === parseInt(dayjs().format('YYYYMMDD'));
  let cond2Satisfied = isCondition2RawTrue;
  let cond2Pending = false;
  let cond2PendingMinutes = 0;
  if (isLiveTodayForCond2) {
    const persist = evaluateSellConditionPersist(code, date, 'condition2', isCondition2RawTrue);
    cond2Satisfied = persist.satisfied;
    cond2Pending = persist.pending;
    cond2PendingMinutes = persist.pendingMinutes;
  }
  const condition2 = {
    name: '高位放量大阴线',
    satisfied: cond2Satisfied,
    pending: cond2Pending,
    pendingMinutes: cond2PendingMinutes,
    detail: isCondition2RawTrue
      ? `回落 ${amplitude.toFixed(2)}% > 8%，且收盘 ${closePrice.toFixed(2)} < 开盘 ${openPrice.toFixed(2)}，为高位放量大阴线`
      : `回落 ${amplitude.toFixed(2)}%${amplitude > 8 ? ' > 8%' : ' ≤ 8%'}，收盘 ${closePrice.toFixed(2)}${closePrice < openPrice ? ' < 开盘' : ' ≥ 开盘'}，未触发`,
    subConditions: [
      { label: '开盘价', value: openPrice.toFixed(2) },
      { label: '最高价', value: highPrice.toFixed(2) },
      { label: '收盘价', value: closePrice.toFixed(2) },
      { label: '回落幅度', value: `${amplitude.toFixed(2)}%` },
      { label: '判断规则', value: '回落 > 8% 且 收盘 < 开盘（持续≥5分钟才触发）' },
    ],
  };
  // 补充 pending 提示到 detail
  if (cond2Pending) {
    condition2.detail += `（已持续 ${cond2PendingMinutes} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）`;
  }

  // 条件3：科技板块情绪退潮
  let condition3 = {
    name: '科技板块情绪退潮',
    satisfied: false,
    pending: false,
    pendingMinutes: 0,
    detail: '',
    subConditions: [],
  };
  const techIndexData = getAllTechIndexData();
  let techChange = null;
  if (Array.isArray(techIndexData) && techIndexData.length > 0) {
    const sortedTech = [...techIndexData].sort((a, b) => a.date - b.date);
    const targetTechIdx = sortedTech.findIndex(t => parseInt(t.date) === date);
    if (targetTechIdx >= 0) {
      techChange = parseFloat(sortedTech[targetTechIdx].changeSumResult || 0);
      // 条件3：科技板块情绪退潮 == -100 且自选股中跌幅 <-9% 的个股 >= 5
      const downStocksCount = countWatchlistStocksBelow(-9);
      const isCondition3RawTrue = techChange === -100 && downStocksCount >= 5;
      // 当日实盘需持续满足 ≥5 分钟才触发，历史回测直接按当前值判定
      const isLiveTodayForCond3 = date === parseInt(dayjs().format('YYYYMMDD'));
      let cond3Satisfied = isCondition3RawTrue;
      let cond3Pending = false;
      let cond3PendingMinutes = 0;
      if (isLiveTodayForCond3) {
        const persist = evaluateSellConditionPersist(code, date, 'condition3', isCondition3RawTrue);
        cond3Satisfied = persist.satisfied;
        cond3Pending = persist.pending;
        cond3PendingMinutes = persist.pendingMinutes;
      }
      condition3.satisfied = cond3Satisfied;
      condition3.pending = cond3Pending;
      condition3.pendingMinutes = cond3PendingMinutes;
      condition3.detail = techChange === -100 && downStocksCount >= 5
        ? `科技情绪指数 = -100 且自选股中跌幅<-9%的个股 ${downStocksCount} 个（>=5），市场触底`
        : techChange === -100
          ? `科技情绪指数 = -100，但自选股中跌幅<-9%的个股仅 ${downStocksCount} 个（<5），未触发`
          : `科技情绪指数 ${techChange.toFixed(2)}，未达到 -100（需 = -100 且自选股中跌幅<-9%个股 >=5 才触发）`;
      // 补充 pending 提示到 detail
      if (cond3Pending) {
        condition3.detail += `（已持续 ${cond3PendingMinutes} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟）`;
      }
      condition3.subConditions = [
        { label: '科技情绪指数', value: techChange.toFixed(2) },
        { label: '阈值', value: '= -100（持续≥5分钟才触发）' },
        { label: '跌幅<-9%自选股', value: `${downStocksCount} 个（需>=5）` },
      ];
    } else {
      condition3.detail = '当日科技情绪数据暂无';
      condition3.subConditions = [{ label: '状态', value: '数据暂无' }];
    }
  } else {
    condition3.detail = '无科技情绪数据';
    condition3.subConditions = [{ label: '状态', value: '无数据' }];
  }

  // 条件5：连续三天（含当日）抗分歧指数均 < 10（个股连续弱势，资金持续分歧），仅 9:40 后生效
  let condition5 = {
    name: '连续三日抗分歧弱势',
    satisfied: false,
    detail: '',
    subConditions: [],
  };
  const isSh688ForC5 = code.startsWith('sh688');
  const indexCodeForC5 = isSh688ForC5 ? 'sh000688' : 'sz399006';
  const resilience3d = []; // [{ date, score }]

  // 从前 K 线中取最近 3 个交易日（含当日）
  const recent3Dates = [];
  for (let i = targetIdx; i >= 0 && recent3Dates.length < 3; i--) {
    recent3Dates.push(parseInt(sortedKline[i].trade_date));
  }
  recent3Dates.reverse(); // 升序：[day-2, day-1, day]

  try {
    if (recent3Dates.length < 3) {
      condition5.detail = `历史交易日不足 3 天（仅 ${recent3Dates.length} 天），无法判断连续三日弱势`;
      condition5.subConditions = [{ label: '状态', value: `交易日不足 3 天` }];
    } else {
      // 并行拉取 3 天的 stock+index 分时
      const tlineRequests = [];
      for (const d of recent3Dates) {
        tlineRequests.push(
          getSingleStockTlineDataByDate(code, d).then(data => ({ type: 'stock', date: d, data })),
          getSingleStockTlineDataByDate(indexCodeForC5, d).then(data => ({ type: 'index', date: d, data })),
        );
      }
      const results = await Promise.all(tlineRequests);
      // 按日期分组
      const byDate = {};
      for (const r of results) {
        if (!byDate[r.date]) byDate[r.date] = {};
        byDate[r.date][r.type] = r.data;
      }
      const limitType = getLimitTypeByCode(code);
      let allValid = true;
      for (const d of recent3Dates) {
        const entry = byDate[d] || {};
        const stockLine = entry.stock?.line || [];
        const indexLine = entry.index?.line || [];
        if (stockLine.length < 5 || indexLine.length < 5) {
          allValid = false;
          resilience3d.push({ date: d, score: null });
          continue;
        }
        const s = calculateResilience(indexLine, stockLine, limitType);
        resilience3d.push({ date: d, score: parseFloat(s.toFixed(2)) });
      }
      if (!allValid) {
        condition5.detail = `部分历史分时数据不足，已计算 ${resilience3d.filter(r => r.score !== null).length}/3 天`;
        condition5.subConditions = [
          { label: '状态', value: '分时数据不足' },
          { label: '近3日抗分歧', value: resilience3d.map(r => `${formatDateStr(r.date)}: ${r.score !== null ? r.score : '--'}`).join(' | ') },
        ];
      } else {
        const allBelow10 = resilience3d.every(r => r.score < 10);
        const isAfter940 = dayjs().format('HHmm') >= '0940';
        condition5.satisfied = allBelow10 && isAfter940;
        const dateDesc = resilience3d.map(r => `${formatDateStr(r.date)}: ${r.score}`).join('、');
        if (!isAfter940) {
          condition5.detail = `近三日抗分歧指数均 < 10（${dateDesc}），但当前时间未到 9:40，条件暂不生效`;
        } else if (allBelow10) {
          condition5.detail = `近三日抗分歧指数均 < 10（${dateDesc}），个股连续弱势，资金持续分歧，触发卖点`;
        } else {
          condition5.detail = `近三日抗分歧指数未全部 < 10（${dateDesc}），未触发`;
        }
        condition5.subConditions = [
          { label: '近3日抗分歧', value: dateDesc },
          { label: '跟踪指数', value: isSh688ForC5 ? '科创板' : '创业板' },
          { label: '生效时间', value: '9:40 后' },
          { label: '阈值', value: '连续3日均 < 10' },
        ];
      }
    }
  } catch (e) {
    condition5.detail = `获取历史分时数据失败: ${e.message}`;
    condition5.subConditions = [{ label: '状态', value: '获取失败' }];
  }

  // 条件4：抗分歧指数 < 6 且 涨幅 ≤ -5%（14:50后生效）
  let condition4 = {
    name: '抗分歧指数弱势',
    satisfied: false,
    detail: '',
    subConditions: [],
  };
  const isSh688 = code.startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  let resilienceScore = null;

  try {
    const [stockTline, indexTline] = await Promise.all([
      getSingleStockTlineDataByDate(code, date),
      getSingleStockTlineDataByDate(indexCode, date),
    ]);
    const stockLine = stockTline?.line || [];
    const indexLine = indexTline?.line || [];

    if (stockLine.length >= 5 && indexLine.length >= 5) {
      const limitType = getLimitTypeByCode(code);
      resilienceScore = calculateResilience(indexLine, stockLine, limitType);
      // 需同时满足：抗分歧指数 < 6 且 当前涨幅 ≤ -5%，且当前时间 >= 14:50
      const isResilienceWeak = resilienceScore < 6;
      const isFalling = change <= -5;
      const isAfter1450 = dayjs().format('HHmm') >= '1450';
      condition4.satisfied = isResilienceWeak && isFalling && isAfter1450;
      if (!isAfter1450) {
        condition4.detail = `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，但当前时间未到 14:50，条件暂不生效`;
      } else if (isResilienceWeak && isFalling) {
        condition4.detail = `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，个股抗跌性弱且正在下跌`;
      } else if (!isResilienceWeak) {
        condition4.detail = `抗分歧指数 ${resilienceScore.toFixed(2)} ≥ 6，个股抗跌性尚可，未触发`;
      } else {
        condition4.detail = `抗分歧指数 ${resilienceScore.toFixed(2)} < 6，但涨幅 ${change.toFixed(2)}% > -5%，未触发`;
      }
      condition4.subConditions = [
        { label: '抗分歧指数', value: resilienceScore.toFixed(2) },
        { label: '当前涨幅', value: `${change.toFixed(2)}%` },
        { label: '当前时间', value: dayjs().format('HH:mm') },
        { label: '跟踪指数', value: isSh688 ? '科创板' : '创业板' },
        { label: '阈值', value: '< 6 且 涨幅 ≤ -5%（14:50后生效）' },
      ];
    } else {
      condition4.detail = '分时数据不足，无法计算抗分歧指数';
      condition4.subConditions = [{ label: '状态', value: '分时数据不足' }];
    }
  } catch (e) {
    condition4.detail = `获取分时数据失败: ${e.message}`;
    condition4.subConditions = [{ label: '状态', value: '获取失败' }];
  }

  // ===== 条件6：现价跌破最迟一天买入（最近一次加仓）当日的最低点，需持续 ≥5 分钟 =====
  // 最迟一天买入：持仓收益操作记录 / 持仓管理记录中最近一次 action/type 为 buy 或 pipeline 的日期；
  // 一旦现价跌破该日最低价（买入成本线告破）并持续 ≥5 分钟即触发卖点。
  let condition6 = {
    name: '跌破最迟买入日低点',
    satisfied: false,
    pending: false,
    pendingMinutes: 0,
    detail: '',
    subConditions: [],
  };
  const lastBuyDay = getLastBuyDay(code); // 'YYYYMMDD' | null
  if (lastBuyDay === null) {
    condition6.detail = '未找到该股票的买入/加仓记录，无法判断最迟买入日低点';
    condition6.subConditions = [{ label: '状态', value: '无买入记录' }];
  } else {
    const lastBuyDayNum = parseInt(lastBuyDay);
    const buyBar = sortedKline.find(k => parseInt(k.trade_date) === lastBuyDayNum);
    const buyDayLowRaw = buyBar ? parseFloat(buyBar.low_px) : null;
    if (buyDayLowRaw === null || !Number.isFinite(buyDayLowRaw) || buyDayLowRaw <= 0) {
      condition6.detail = `最迟买入日 ${formatDateStr(lastBuyDayNum)} 无日K线最低价数据，无法判断`;
      condition6.subConditions = [
        { label: '最迟买入日', value: formatDateStr(lastBuyDayNum) },
        { label: '状态', value: '无K线数据' },
      ];
    } else {
      const brokenBuyDayLow = closePrice < buyDayLowRaw;
      // 当日实盘需持续满足 ≥5 分钟才触发，历史回测直接按当前值判定
      const isLiveForCond6 = date === parseInt(dayjs().format('YYYYMMDD'));
      const persist6 = isLiveForCond6
        ? evaluateSellConditionPersist(code, date, 'condition6', brokenBuyDayLow)
        : { satisfied: brokenBuyDayLow, pending: false, pendingMinutes: 0 };
      condition6.satisfied = persist6.satisfied;
      condition6.pending = persist6.pending;
      condition6.pendingMinutes = persist6.pendingMinutes;
      condition6.detail = brokenBuyDayLow
        ? `现价 ${closePrice.toFixed(2)} 已跌破最迟买入日（${formatDateStr(lastBuyDayNum)}）最低价 ${buyDayLowRaw.toFixed(2)}，买入成本线告破${persist6.pending ? `（已持续 ${persist6.pendingMinutes} 分钟，需≥${SELL_CONDITION_PERSIST_MIN} 分钟才触发）` : ''}`
        : `现价 ${closePrice.toFixed(2)} 未跌破最迟买入日（${formatDateStr(lastBuyDayNum)}）最低价 ${buyDayLowRaw.toFixed(2)}，暂不触发`;
      condition6.subConditions = [
        { label: '最迟买入日', value: formatDateStr(lastBuyDayNum) },
        { label: '买入日最低价', value: buyDayLowRaw.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '判断规则', value: `现价跌破最迟买入日最低价（持续≥${SELL_CONDITION_PERSIST_MIN}分钟才触发）` },
      ];
    }
  }

  const conditions = [condition1, condition2, condition3, condition4, condition5, condition6];
  const satisfiedCount = conditions.filter(c => c.satisfied).length;
  const isSell = satisfiedCount > 0;

  let conclusion;
  if (isSell) {
    const satisfiedNames = conditions.filter(c => c.satisfied).map(c => c.name).join('、');
    conclusion = `共触发 ${satisfiedCount} 个卖出条件（${satisfiedNames}），建议关注并考虑减仓或卖出`;
  } else {
    conclusion = '所有卖出条件均未触发，当前可继续持有';
  }

  return {
    isSell,
    closePrice,
    ma5,
    ma10,
    ma10Slope: ma10Slope !== null ? parseFloat(ma10Slope.toFixed(2)) : null,
    change: parseFloat(change.toFixed(2)),
    techEmotion: techChange !== null ? parseFloat(techChange.toFixed(2)) : null,
    resilienceScore: resilienceScore !== null ? parseFloat(resilienceScore.toFixed(2)) : null,
    conditions,
    conclusion,
  };
};

// ========== 单股回测 ==========
// 对一只股票在指定日期范围内进行买卖点回测
const backtestSingleStock = async (code, stockName, startDate, endDate) => {
  // 获取足够多的 K 线数据（最近 100 天，覆盖日期范围 + MA10 计算所需的缓冲）
  const klineData = await getSingleStockData(code, 100);
  if (!klineData || klineData.length === 0) {
    return {
      code,
      stockName,
      error: '无K线数据',
      trades: [],
      klineData: [],
      markers: [],
      summary: { totalTrades: 0, realizedTrades: 0, winTrades: 0, winRate: 0, totalProfit: 0, totalProfitPct: 0, avgProfitPct: 0 },
    };
  }

  const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);

  const start = parseInt(String(startDate).replace(/-/g, ''));
  const end = parseInt(String(endDate).replace(/-/g, ''));

  const techIndexData = getAllTechIndexData();
  const isSh688 = code.startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';

  const trades = [];
  const markers = [];
  let currentBuy = null;

  // 收集回测日期范围内的所有交易日
  const tradingDays = [];
  for (const kline of sortedKline) {
    const tradeDate = parseInt(kline.trade_date);
    if (tradeDate >= start && tradeDate <= end) {
      tradingDays.push(tradeDate);
    }
  }

  // 分批并行拉取所有交易日的分时数据（每批 5 天，批次间隔 200ms）
  const tlineCache = {}; // { [date]: { stock: tlineData, index: tlineData } }
  const BATCH_SIZE = 5;
  for (let i = 0; i < tradingDays.length; i += BATCH_SIZE) {
    const batch = tradingDays.slice(i, i + BATCH_SIZE);
    const batchRequests = [];
    for (const tradeDate of batch) {
      batchRequests.push(
        getSingleStockTlineDataByDate(code, tradeDate).then(data => ({ type: 'stock', date: tradeDate, data })),
        getSingleStockTlineDataByDate(indexCode, tradeDate).then(data => ({ type: 'index', date: tradeDate, data })),
      );
    }
    const batchResults = await Promise.all(batchRequests);
    for (const r of batchResults) {
      if (!tlineCache[r.date]) tlineCache[r.date] = {};
      tlineCache[r.date][r.type] = r.data;
    }
    // 批次间间隔 200ms，避免对数据源造成过大压力
    if (i + BATCH_SIZE < tradingDays.length) {
      await sleep(200);
    }
  }

  // 逐天处理买卖点逻辑（使用预取的分时数据，无需重复请求）
  for (const kline of sortedKline) {
    const tradeDate = parseInt(kline.trade_date);
    if (tradeDate < start || tradeDate > end) continue;

    // 使用预取的分时数据计算抗分歧指数
    const cachedStockTline = tlineCache[tradeDate]?.stock;
    const cachedIndexTline = tlineCache[tradeDate]?.index;
    let resilienceScore = null;
    try {
      const stockLine = cachedStockTline?.line || [];
      const indexLine = cachedIndexTline?.line || [];
      if (stockLine.length > 0 && indexLine.length > 0) {
        const limitType = getLimitTypeByCode(code);
        resilienceScore = calculateResilience(indexLine, stockLine, limitType);
      }
    } catch (e) {
      // 忽略分时数据获取失败
    }
    kline.resilienceScore = resilienceScore;

    if (!currentBuy) {
      // 提前检查情绪冰点作为性能优化，checkBuyPoint 内部也会独立验证
      const freezing = isEmotionFreezing(techIndexData, tradeDate);
      if (!freezing.isFreezing) continue;

      const buyResult = await checkBuyPoint(code, tradeDate, sortedKline, cachedStockTline, cachedIndexTline);
      if (buyResult.isBuy) {
        currentBuy = {
          buyDate: tradeDate,
          buyPrice: buyResult.buyPrice,
          openChange: buyResult.openChange,
          reason: buyResult.reason,
          freezingReason: freezing.reason,
        };
        markers.push({
          time: formatDateStr(tradeDate),
          position: 'belowBar',
          color: '#f5222d',
          shape: 'arrowUp',
          text: `买 ${buyResult.buyPrice.toFixed(2)}`,
        });
      }
    } else {
      const sellResult = await checkSellPoint(code, tradeDate, sortedKline, cachedStockTline, cachedIndexTline);
      if (sellResult.isSell) {
        const profit = sellResult.sellPrice - currentBuy.buyPrice;
        const profitPct = profit / currentBuy.buyPrice * 100;
        const holdingDays = calcHoldingDays(currentBuy.buyDate, tradeDate);

        trades.push({
          buyDate: currentBuy.buyDate,
          buyDateStr: formatDateStr(currentBuy.buyDate),
          buyPrice: parseFloat(currentBuy.buyPrice.toFixed(2)),
          sellDate: tradeDate,
          sellDateStr: formatDateStr(tradeDate),
          sellPrice: parseFloat(sellResult.sellPrice.toFixed(2)),
          profit: parseFloat(profit.toFixed(2)),
          profitPct: parseFloat(profitPct.toFixed(2)),
          holdingDays,
          openChange: currentBuy.openChange,
          buyReason: currentBuy.reason,
          sellReason: sellResult.reason,
        });

        markers.push({
          time: formatDateStr(tradeDate),
          position: 'aboveBar',
          color: '#52c41a',
          shape: 'arrowDown',
          text: `卖 ${sellResult.sellPrice.toFixed(2)}`,
        });

        currentBuy = null;
      }
    }
  }

  // 仍未卖出的部分用最后一个交易日收盘价平仓
  if (currentBuy) {
    const lastKline = sortedKline[sortedKline.length - 1];
    const sellPrice = parseFloat(lastKline.close_px);
    const profit = sellPrice - currentBuy.buyPrice;
    const profitPct = profit / currentBuy.buyPrice * 100;
    const holdingDays = calcHoldingDays(currentBuy.buyDate, lastKline.trade_date);

    trades.push({
      buyDate: currentBuy.buyDate,
      buyDateStr: formatDateStr(currentBuy.buyDate),
      buyPrice: parseFloat(currentBuy.buyPrice.toFixed(2)),
      sellDate: lastKline.trade_date,
      sellDateStr: formatDateStr(lastKline.trade_date),
      sellPrice,
      profit: parseFloat(profit.toFixed(2)),
      profitPct: parseFloat(profitPct.toFixed(2)),
      holdingDays,
      openChange: currentBuy.openChange,
      buyReason: currentBuy.reason,
      sellReason: '回测结束仍持有，按末日收盘价平仓',
      isUnrealized: true,
    });

    markers.push({
      time: formatDateStr(lastKline.trade_date),
      position: 'aboveBar',
      color: '#fa8c16',
      shape: 'arrowDown',
      text: `平 ${sellPrice.toFixed(2)}`,
    });
  }

  // 汇总统计前，按买入日期升序排列交易记录
  trades.sort((a, b) => a.buyDate - b.buyDate);

  const realizedTrades = trades.filter(t => !t.isUnrealized);
  const winTrades = realizedTrades.filter(t => t.profit > 0);
  const lossTrades = realizedTrades.filter(t => t.profit <= 0);
  const totalProfit = realizedTrades.reduce((s, t) => s + t.profit, 0);
  const totalProfitPct = realizedTrades.length > 0
    ? parseFloat(((realizedTrades.reduce((product, t) => product * (1 + t.profitPct / 100), 1) - 1) * 100).toFixed(2))
    : 0;
  const winRate = realizedTrades.length > 0
    ? parseFloat((winTrades.length / realizedTrades.length * 100).toFixed(2))
    : 0;
  const avgProfitPct = realizedTrades.length > 0
    ? parseFloat((totalProfitPct / realizedTrades.length).toFixed(2))
    : 0;

  return {
    code,
    stockName,
    klineData: sortedKline,
    trades,
    markers,
    summary: {
      totalTrades: trades.length,
      realizedTrades: realizedTrades.length,
      winTrades: winTrades.length,
      lossTrades: lossTrades.length,
      winRate,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalProfitPct: parseFloat(totalProfitPct.toFixed(2)),
      avgProfitPct,
    },
  };
};

// ========== 回测入口 ==========
const backtestBuySell = async (stockCodes, startDate, endDate) => {
  if (!Array.isArray(stockCodes) || stockCodes.length === 0) {
    return { success: false, message: '请选择至少一只股票' };
  }
  if (!startDate || !endDate) {
    return { success: false, message: '请选择回测日期范围' };
  }

  const monitorStocks = getMonitorStocks();
  const results = [];

  for (const code of stockCodes) {
    const stockInfo = monitorStocks.find(s => s.code === code);
    const stockName = stockInfo?.name || code;
    try {
      const result = await backtestSingleStock(code, stockName, startDate, endDate);
      results.push(result);
    } catch (error) {
      console.error(`回测 ${code} 失败:`, error.message);
      results.push({
        code,
        stockName,
        error: error.message,
        trades: [],
        klineData: [],
        markers: [],
        summary: {
          totalTrades: 0, realizedTrades: 0, winTrades: 0, lossTrades: 0,
          winRate: 0, totalProfit: 0, totalProfitPct: 0, avgProfitPct: 0,
        },
      });
    }
    await sleep(80);
  }

  return { success: true, data: results };
};

// ========== 即时买点诊断 ==========
// 前置检查：容灾7项条件全部通过
// 通过后：筛选当日抗分歧指数 > 8 的个股
// 未通过：列出所有条件的满足情况
// @param {string|number} targetDate - 目标日期（YYYYMMDD 或 YYYY-MM-DD），不传则使用今天
// @param {boolean} refresh - 是否刷新实时数据
// @returns {Object} 诊断结果
// ========== 买点前置7项诊断检查 ==========
// 重度刷新节流：多个前端每10秒轮询 + 抽屉打开均携带 refresh:1，
// 而重度刷新（全量成分股K线爬取 + 大盘数据拉取）的结果不被任何检查项消费（检查项均读本地文件），
// 30 秒内只真正执行一次，避免重复全量爬取拖慢响应
let _lastBuyPointHeavyRefreshAt = 0;
const BUY_POINT_HEAVY_REFRESH_INTERVAL = 30 * 1000;

const getBuyPointChecks = async (targetDate = null, refresh = false) => {
  let targetDay;
  if (targetDate) {
    const dateStr = String(targetDate).replace(/-/g, '');
    targetDay = dayjs(dateStr, 'YYYYMMDD');
  } else {
    targetDay = dayjs();
    // 周末回退到上周五
    const dow = targetDay.day();
    if (dow === 0) targetDay = targetDay.subtract(2, 'day');
    else if (dow === 6) targetDay = targetDay.subtract(1, 'day');
  }

  const targetDateStr = targetDay.format('YYYYMMDD');
  const checks = [];
  let allPassed = true;

  let freshDapanData = null;
  let freshOpeningStats = null;

  if (refresh && Date.now() - _lastBuyPointHeavyRefreshAt >= BUY_POINT_HEAVY_REFRESH_INTERVAL) {
    _lastBuyPointHeavyRefreshAt = Date.now();
    try {
      freshDapanData = await getDaPanData();
      if (freshDapanData) {
        fs.writeFileSync(dapanDataPath, JSON.stringify(freshDapanData, null, 2));
      }
    } catch (e) {
      console.error('刷新大盘数据失败:', e.message);
    }
    try {
      await updateCurrentTechIndexData();
    } catch (e) {
      console.error('刷新科技情绪失败:', e.message);
      try {
        await getCurrentTechEmotion();
      } catch (e2) {
        // ignore
      }
    }
    if (isInOpeningCheckWindow()) {
      freshOpeningStats = await fetchOpeningBelowCount();
    }
  }

  // ============================================================
  // 检查1：前一日为情绪冰点（或今日分时中存在情绪 <-40 的冰点情况）【已注释停用，保留代码】
  // 暂停该前置条件，不再作为买点必要条件
  // ============================================================
  // const techIndexData = getAllTechIndexData();
  // const freezingResult = isEmotionFreezing(techIndexData, targetDateStr);
  // const intradayBelowResult = hasTodayIntradayEmotionBelow(-40);
  // const check4Passed = freezingResult.isFreezing === true || intradayBelowResult.hasBelow;
  // let emotionFreezingReason;
  // if (freezingResult.isFreezing) {
  //   emotionFreezingReason = freezingResult.reason;
  // } else if (intradayBelowResult.hasBelow) {
  //   emotionFreezingReason = `前一日未触发情绪冰点，但今日分时存在情绪 < -40（最低 ${intradayBelowResult.min}），触发日内冰点`;
  // } else {
  //   emotionFreezingReason = freezingResult.reason || '前一日未触发情绪冰点条件，今日分时也未破 -40';
  // }
  // checks.push({
  //   id: 'emotion_freezing', title: '情绪冰点（前一日或今日分时）', passed: check4Passed,
  //   value: check4Passed ? '是' : '否',
  //   detail: {
  //     prev1: freezingResult.prev1?.changeSumResult ?? null,
  //     prev2: freezingResult.prev2?.changeSumResult ?? null,
  //     prev3: freezingResult.prev3?.changeSumResult ?? null,
  //     avg3: freezingResult.avg3 || null,
  //     intradayMin: intradayBelowResult.min,
  //     intradayBelowCount: intradayBelowResult.belowRecords.length,
  //   },
  //   reason: emotionFreezingReason,
  // });
  // if (!check4Passed) allPassed = false;

  // 检查2：最近5min资金净流入大于20亿
  // 开盘初期（9:30-9:35 不满 5min）回退为"9:30 开盘至当前"累计净流入判定（sinceOpen）
  const inflowResult = getRecent5MinInflow();
  const check5Passed = inflowResult.hasData && inflowResult.diff > 20;
  const inflowWindowText = inflowResult.sinceOpen ? '开盘至当前' : '最近 5 分钟';
  checks.push({
    id: 'fund_inflow',
    title: inflowResult.sinceOpen ? '开盘至当前资金净流入大于 20 亿（开盘不满 5min）' : '最近 5min 资金净流入大于 20 亿',
    passed: check5Passed,
    value: inflowResult.hasData ? `${inflowResult.diff >= 0 ? '+' : ''}${inflowResult.diff.toFixed(2)}亿` : '数据不足',
    detail: {
      currentTime: inflowResult.currentTime, pastTime: inflowResult.pastTime,
      currentValue: inflowResult.currentTime ? inflowResult.currentValue : null,
      pastValue: inflowResult.pastTime ? inflowResult.pastValue : null,
      sinceOpen: !!inflowResult.sinceOpen,
    },
    reason: check5Passed ? `${inflowWindowText}资金净流入 ${inflowResult.diff.toFixed(2)} 亿（${inflowResult.pastTime}→${inflowResult.currentTime}），超过 20 亿阈值`
      : !inflowResult.hasData ? '资金数据不足，无法判断最近 5 分钟净流入'
        : `${inflowWindowText}资金净流入 ${inflowResult.diff.toFixed(2)} 亿（${inflowResult.pastTime}→${inflowResult.currentTime}），未达到 20 亿阈值`,
  });
  if (!check5Passed) allPassed = false;

  // 检查3：当前量能（amountChangeDiff = 今日累计成交额 − 昨日全天成交额）为正，且大于 5min 前的值
  // 豁免规则：今日或前一交易日 hasIce: true（盘中情绪触及 -100 退潮冰点）时，量能条件自动豁免
  const volumeResult = getRecent5MinVolumeChange();

  // 读取科技情绪日级别数据，判断今日/前一交易日是否 hasIce
  let todayHasIce = false;
  let yesterdayIceDate = null;
  try {
    const techIndexDataForIce = getAllTechIndexData();
    const sortedTech = [...techIndexDataForIce].sort((a, b) => a.date - b.date);
    const todayIceItem = sortedTech.find(item => parseInt(item.date) === parseInt(targetDateStr));
    todayHasIce = !!(todayIceItem && todayIceItem.hasIce === true);
    const beforeIceItems = sortedTech.filter(item => parseInt(item.date) < parseInt(targetDateStr));
    const yesterdayIceItem = beforeIceItems.length > 0 ? beforeIceItems[beforeIceItems.length - 1] : null;
    if (yesterdayIceItem && yesterdayIceItem.hasIce === true) {
      yesterdayIceDate = yesterdayIceItem.date;
    }
  } catch (e) {
    console.error('读取科技情绪 hasIce 数据失败:', e.message);
  }
  const iceExempt = todayHasIce || yesterdayIceDate !== null;

  if (iceExempt) {
    const iceSource = todayHasIce
      ? `今日(${formatDateStr(targetDateStr)})`
      : `昨日(${formatDateStr(yesterdayIceDate)})`;
    checks.push({
      id: 'volume_expansion', title: '当前量能为正（今日累计成交额超昨日全天）', passed: true, exempted: true,
      value: volumeResult.hasData
        ? `${volumeResult.last5minVol - volumeResult.prev5minVol >= 0 ? '增加' : '减少'} ${Math.abs(volumeResult.last5minVol - volumeResult.prev5minVol).toFixed(2)}亿（已豁免）`
        : '已豁免',
      detail: {
        currentTime: volumeResult.currentTime,
        pastTime: volumeResult.pastTime,
        prev5minVol: volumeResult.hasData ? volumeResult.prev5minVol : null,
        last5minVol: volumeResult.hasData ? volumeResult.last5minVol : null,
        increase5min: volumeResult.hasData ? parseFloat((volumeResult.last5minVol - volumeResult.prev5minVol).toFixed(2)) : null,
      },
      reason: `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），情绪已达冰点量能条件自动豁免`,
    });
  } else {
    // 判定规则：当前量能为正时，只需较 5min 前增加即可（无阈值）；当前量能为负时，需较 5min 前增加 100 亿以上
    const checkVolumePassed = !volumeResult.hasData ? false
      : volumeResult.last5minVol > 0
        ? volumeResult.last5minVol > volumeResult.prev5minVol
        : (volumeResult.last5minVol - volumeResult.prev5minVol) >= 100;
    const volIncrease = volumeResult.last5minVol - volumeResult.prev5minVol;
    const volChangeText = volIncrease >= 0 ? `+${volIncrease.toFixed(2)} 亿` : `-${Math.abs(volIncrease).toFixed(2)} 亿`;
    checks.push({
      id: 'volume_expansion', title: '量能较 5min 前增加（成交量为负时需增加超 100 亿）', passed: checkVolumePassed,
      value: volumeResult.hasData ? `${volIncrease >= 0 ? '+' : '-'} ${Math.abs(volIncrease).toFixed(2)}亿` : '数据不足',
      detail: {
        currentTime: volumeResult.currentTime,
        pastTime: volumeResult.pastTime,
        prev5minVol: volumeResult.hasData ? volumeResult.prev5minVol : null,
        last5minVol: volumeResult.hasData ? volumeResult.last5minVol : null,
        increase5min: volumeResult.hasData ? parseFloat(volIncrease.toFixed(2)) : null,
      },
      reason: !volumeResult.hasData ? '量能数据不足，无法判断当前量能'
        : volumeResult.last5minVol > 0
          ? checkVolumePassed ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为正，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，持续放量`
            : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿虽为正，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}`
          : checkVolumePassed ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，达到 100 亿阈值`
            : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿仅${volChangeText}，未达到增加 100 亿的阈值`,
    });
    if (!checkVolumePassed) allPassed = false;
  }

  // 检查4：开盘后自选股低于开盘价不超过30只
  const inOpeningWindow = isInOpeningCheckWindow();
  if (inOpeningWindow) {
    let openingStats = freshOpeningStats;
    if (!openingStats) openingStats = await fetchOpeningBelowCount();
    const check7Passed = openingStats && openingStats.belowCount <= 30;
    checks.push({
      id: 'opening_below', title: '开盘后自选股低于开盘价不超过 30 只', passed: check7Passed,
      value: openingStats ? `${openingStats.belowCount} / ${openingStats.validCount || openingStats.total}只` : '检查中...',
      reason: check7Passed ? `开盘后自选股共 ${openingStats.total} 只，${openingStats.belowCount} 只现价低于 9:30 开盘价，未超过 30 只`
        : openingStats && openingStats.belowCount > 30 ? `开盘后自选股共 ${openingStats.total} 只，${openingStats.belowCount} 只现价低于 9:30 开盘价，超过 30 只阈值，市场开盘跳水严重`
          : '分时数据获取异常',
    });
    if (!check7Passed) allPassed = false;
  } else {
    checks.push({
      id: 'opening_below', title: '开盘后自选股低于开盘价不超过 30 只', passed: true,
      value: '非交易时段',
      reason: '此项检查仅在交易日 9:30-10:00 之间生效，当前时段跳过',
    });
  }

  // 检查6：9:30 竞价开盘科技情绪 > 80 时，后续触发买点要求当前科技情绪 < 40（开盘过热需回落才可买）
  let intradayRecords = [];
  try {
    const { data: intradayData } = getTechEmotionIntraday();
    intradayRecords = Array.isArray(intradayData[targetDateStr]) ? intradayData[targetDateStr] : [];
  } catch (e) {
    intradayRecords = [];
  }
  // 找 9:30 竞价开盘记录（time '0930'），找不到时回退取当日第一条
  const openRec = intradayRecords.find(r => String(r.time).padStart(4, '0') === '0930') || intradayRecords[0];
  const openingAuctionEmotion = openRec && typeof openRec.value === 'number' ? openRec.value : null;
  const latestEmotionRec = intradayRecords.length > 0 ? intradayRecords[intradayRecords.length - 1] : null;
  const currentTechEmotion = latestEmotionRec && typeof latestEmotionRec.value === 'number' ? latestEmotionRec.value : null;

  let checkEmotionRetracePassed;
  let emotionRetraceReason;
  if (openingAuctionEmotion === null) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = '暂无 9:30 竞价科技情绪分时数据，跳过该检查';
  } else if (openingAuctionEmotion <= 80) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 未超过 80，当前情绪须低于 40 的限制不生效`;
  } else if (currentTechEmotion === null) {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，但暂无当前分时数据，无法确认情绪回落至 40 以下`;
  } else if (currentTechEmotion < 40) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentTechEmotion.toFixed(2)} 已回落至 40 以下，允许买入`;
  } else {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentTechEmotion.toFixed(2)} 未回落至 40 以下，禁止买入`;
  }
  checks.push({
    id: 'emotion_retrace_after_open', title: '竞价情绪超 80 时当前情绪须低于 40', passed: checkEmotionRetracePassed,
    value: openingAuctionEmotion === null ? '暂无分时数据' : `开盘 ${openingAuctionEmotion.toFixed(2)} / 当前 ${currentTechEmotion === null ? '--' : currentTechEmotion.toFixed(2)}`,
    reason: emotionRetraceReason,
  });
  if (!checkEmotionRetracePassed) allPassed = false;

  // ============================================================
  // 检查（或逻辑分支）：尾盘抄底（交易日 14:10-15:00 生效）
  // 与其它检查相互独立：其它检查全部通过（allPassed）或本检查命中，均可触发买点诊断
  // 条件（均为当前时刻相较 14:00 的比较，14:10-15:00 任一时刻满足即可）：
  // ① 当前科技情绪指数 ≥ -70 且 < 0（全天弱势但未极端冰点）
  // ② 当前创业板指涨幅 < 14:00 涨幅（尾盘涨幅回落）
  // ③ 当前量能 amountChangeDiff 相较 14:00 放大 ≥ 50亿（尾盘放量）
  // ============================================================
  let tailDipHit = false;
  let tailDipValue = '未生效';
  let tailDipReason = '尾盘抄底检查仅在交易日 14:10-15:00 生效，当前时段未生效';
  try {
    const nowT = dayjs();
    const curTotalMin = nowT.hour() * 60 + nowT.minute();
    const inTailWindow = curTotalMin >= 14 * 60 + 10 && curTotalMin <= 15 * 60;
    if (inTailWindow) {
      // ① 当前科技情绪指数（-70 ≤ 情绪 < 0）
      const emotionNow = getLatestTechEmotion();
      const emotionOk = emotionNow !== null && emotionNow >= -70 && emotionNow < 0;

      // ③ 当前量能相较 14:00 放大 ≥ 50亿
      const amountHistory = getAmountHistory();
      let a1400 = null;
      if (amountHistory && amountHistory.length > 0) {
        for (const item of amountHistory) {
          if (String(item[0]) <= '140059') a1400 = item;
          else break;
        }
      }
      const aNow = amountHistory && amountHistory.length > 0 ? amountHistory[amountHistory.length - 1] : null;
      const diff1400 = a1400 ? parseAmountToYi(a1400[1].amountChangeDiff) : NaN;
      const diffNow = aNow ? parseAmountToYi(aNow[1].amountChangeDiff) : NaN;
      const tailSurge = (!isNaN(diff1400) && !isNaN(diffNow)) ? diffNow - diff1400 : null;
      const volumeOk = tailSurge !== null && tailSurge >= 50;

      // ② 创业板指当前涨幅 < 14:00 涨幅（尾盘涨幅回落）
      const cybTline = await getSingleStockTlineData('sz399006');
      const getCybChangeAt = (limitHhmm) => {
        if (!cybTline || !cybTline.preclose_px || !Array.isArray(cybTline.line)) return null;
        const preclose = parseFloat(cybTline.preclose_px);
        if (!preclose || preclose <= 0) return null;
        const line = cybTline.line
          .filter(p => p.minute != null && p.last_px)
          .map(p => ({ minute: p.minute, last_px: parseFloat(p.last_px) }))
          .filter(p => !isNaN(p.last_px))
          .sort((a, b) => a.minute - b.minute);
        let px = null;
        for (const p of line) {
          if (p.minute > limitHhmm) break;
          px = p.last_px;
        }
        if (px === null) return null;
        return ((px - preclose) / preclose) * 100;
      };
      const cybChangeNow = getCybChangeAt(1500);
      const cybChange1400 = getCybChangeAt(1400);
      const cybOk = cybChangeNow !== null && cybChange1400 !== null && cybChangeNow < cybChange1400;

      tailDipHit = emotionOk && volumeOk && cybOk;

      const fmtPct = (v) => (v === null || v === undefined || isNaN(v)) ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      const fmtEmotion = (v) => (v === null || v === undefined || isNaN(v)) ? '--' : v.toFixed(1);
      const fmtSurge = (v) => v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(0)}亿`;
      tailDipValue = `情绪 ${fmtEmotion(emotionNow)} / 量能 ${fmtSurge(tailSurge)} / 涨幅 ${fmtPct(cybChange1400)}→${fmtPct(cybChangeNow)}`;

      if (tailDipHit) {
        tailDipReason = `尾盘抄底条件全部满足：科技情绪 ${fmtEmotion(emotionNow)}（-70 ≤ 情绪 < 0），量能较 14:00 放大 ${fmtSurge(tailSurge)}（≥50亿），创业板指涨幅回落（14:00 ${fmtPct(cybChange1400)} → 当前 ${fmtPct(cybChangeNow)}），命中尾盘抄底，可触发买点诊断`;
      } else {
        const failed = [];
        if (!emotionOk) failed.push(`科技情绪 ${fmtEmotion(emotionNow)}（需 -70 ≤ 情绪 < 0）`);
        if (!volumeOk) failed.push(`量能较 14:00 ${fmtSurge(tailSurge)}（需放大 ≥50亿）`);
        if (!cybOk) failed.push(`创业板指涨幅 14:00 ${fmtPct(cybChange1400)} → 当前 ${fmtPct(cybChangeNow)}（需涨幅回落）`);
        tailDipReason = `尾盘抄底条件未全部满足：${failed.join('；')}（14:10-15:00 内任一时刻满足即可触发）`;
      }
    }
  } catch (e) {
    console.error('尾盘抄底检查失败:', e.message);
    tailDipValue = '检查异常';
    tailDipReason = `尾盘抄底检查异常：${e.message}`;
  }
  checks.push({
    id: 'tail_dip_buying', title: '尾盘抄底（14:10-15:00，或逻辑：命中即可触发）', passed: tailDipHit,
    value: tailDipValue,
    reason: tailDipReason,
  });
  // 注意：尾盘抄底为或分支，不计入 allPassed（与其它检查的与逻辑无关）

  const passedCount = checks.filter(c => c.passed).length;
  const totalCheckCount = checks.length;

  const conclusion = allPassed
    ? '全部前置条件已满足，可以出手买入，但是请分仓 1/3，随后逐步分批买入，分仓管理是最后一道防火墙，谨防尾盘大盘跳水！'
    : tailDipHit
      ? '尾盘抄底条件命中（或逻辑分支），适合尾盘抄底，博弈次日的反弹。可以出手买入，但是请分仓 1/3，随后逐步分批买入，分仓管理是最后一道防火墙，谨防尾盘大盘跳水！'
      : '当前前置条件未全部满足，请耐心等待，不要盲目出手。';

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      refreshed: refresh,
      checks,
      allPassed,
      tailDipBuyingHit: tailDipHit,
      passedCount,
      totalCheckCount,
      isFreezingDay: false, // 情绪冰点检查已注释停用，固定返回 false
      freezingReason: null, // 情绪冰点检查已注释停用，固定返回 null
      conclusion,
    },
  };
};

// ========== 筛选抗分歧指数 > 8 的个股 ==========
// 买点诊断涨跌幅排名排除的股票（不参与 3 日涨幅排名）
const BUY_POINT_EXCLUDED_CODES = new Set(['sh688498', 'sh688808']); // 源杰科技、联讯仪器

const getBuyPointStocks = async (targetDate = null, sortBy = 'resilience', reportDays = 3) => {
  let targetDay;
  if (targetDate) {
    const dateStr = String(targetDate).replace(/-/g, '');
    targetDay = dayjs(dateStr, 'YYYYMMDD');
  } else {
    targetDay = dayjs();
    const dow = targetDay.day();
    if (dow === 0) targetDay = targetDay.subtract(2, 'day');
    else if (dow === 6) targetDay = targetDay.subtract(1, 'day');
  }
  const targetDateStr = targetDay.format('YYYYMMDD');

  const monitorStocks = getMonitorStocks();
  const isChangeMode = sortBy === 'change';
  const isReportMode = sortBy === 'reports';
  const isResilienceMode = !isChangeMode && !isReportMode;

  // 涨跌幅/研报模式下不需要指数分时数据
  let kcIndexLine = [];
  let cyIndexLine = [];
  if (isResilienceMode) {
    const [kcIndexTline, cyIndexTline] = await Promise.all([
      getSingleStockTlineDataByDate('sh000688', targetDateStr),
      getSingleStockTlineDataByDate('sz399006', targetDateStr),
    ]);
    kcIndexLine = kcIndexTline?.line || [];
    cyIndexLine = cyIndexTline?.line || [];
  }

  // 研报覆盖索引（日期 → 股票名 → 覆盖数），与训练营回测研报策略共用
  const reportIndex = isReportMode ? loadReportIndex() : null;
  // 研报覆盖窗口：研报目录中 ≤ 今日的最近 N 个报告日期（N=3/5，研报可发布于周末，故以真实日期而非回退后的交易日为界）
  const ndays = reportDays === 5 ? 5 : 3;
  const reportWinDates = isReportMode
    ? Object.keys(reportIndex).filter(d => d <= dayjs().format('YYYYMMDD')).sort().slice(-ndays)
    : [];

  // 阶段1：并行拉取所有股票的K线数据（10并发）
  const klineResults = await batchParallel(monitorStocks, async (stock) => {
    try {
      const klineData = await getSingleStockData(stock.code, 30);
      return { stock, klineData };
    } catch (e) {
      return { stock, klineData: null, error: e.message };
    }
  }, 10);

  // 阶段2：本地处理K线数据（涨跌幅模式不过滤，抗分歧模式筛选通过MA10条件的股票）
  const passedStocks = [];
  let checkedCount = 0;

  // 涨跌幅/研报模式：数据缺失的股票也纳入（涨跌幅 null、研报覆盖按兜底窗口统计），不做任何过滤
  const pushNoDataStock = (stock) => {
    if (isChangeMode) {
      passedStocks.push({
        stock,
        openPrice: null, prevClose: null, openChange: null,
        change: null, change3d: null, buyPrice: null,
        noData: true,
      });
    } else if (isReportMode) {
      passedStocks.push({
        stock,
        openPrice: null, prevClose: null, openChange: null,
        change: null, change3d: null, changeNd: null, buyPrice: null,
        reportCount: sumReportCount(stock.name, reportWinDates, reportIndex),
        noData: true,
      });
    }
  };

  for (const { stock, klineData, error } of klineResults) {
    if (error) {
      if (!isResilienceMode) console.error(`诊断 ${stock.code} 买点失败:`, error);
      pushNoDataStock(stock);
      continue;
    }
    if (!klineData || klineData.length === 0) {
      pushNoDataStock(stock);
      continue;
    }

    const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
    const targetIdx = sortedKline.findIndex(k => parseInt(k.trade_date) === parseInt(targetDateStr));
    if (targetIdx < 0) {
      pushNoDataStock(stock);
      continue;
    }

    const targetKline = sortedKline[targetIdx];
    const openPrice = parseFloat(targetKline.open_px);
    const closePrice = parseFloat(targetKline.close_px);
    const change = parseFloat(targetKline.change || 0);
    const prevClose = targetIdx > 0 ? parseFloat(sortedKline[targetIdx - 1].close_px) : closePrice;
    const openChange = prevClose > 0 ? parseFloat(((openPrice - prevClose) / prevClose * 100).toFixed(2)) : 0;
    if (!(openPrice > 0) || !(closePrice > 0)) {
      pushNoDataStock(stock);
      continue;
    }

    const buyPrice = parseFloat(((closePrice + openPrice) / 2).toFixed(2));

    // 10日线斜率/价格限制仅在抗分歧模式生效；涨跌幅/研报模式不做此限制
    if (isResilienceMode) {
      let ma10 = targetKline.ma10_px;
      if (ma10 === undefined || ma10 === null) {
        if (targetIdx >= 9) {
          const last10 = sortedKline.slice(targetIdx - 9, targetIdx + 1);
          ma10 = last10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
        }
      }
      ma10 = ma10 !== undefined && ma10 !== null ? parseFloat(ma10) : null;

      let ma10Slope = null;
      if (ma10 !== null && targetIdx >= 14) {
        const prev5Idx = targetIdx - 5;
        let prevMa10 = sortedKline[prev5Idx].ma10_px;
        if (prevMa10 === undefined || prevMa10 === null) {
          const prev10 = sortedKline.slice(prev5Idx - 9, prev5Idx + 1);
          prevMa10 = prev10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
        }
        prevMa10 = parseFloat(prevMa10);
        ma10Slope = ma10 - prevMa10;
      }

      if (ma10Slope !== null && ma10Slope < 0) { checkedCount++; continue; }
      if (ma10 !== null && closePrice < ma10) { checkedCount++; continue; }
    }

    // 3日涨幅（涨跌幅模式排序依据）：当前收盘较 3 个交易日前收盘的累计涨幅，数据不足时回退当日涨幅
    let change3d = change;
    if (targetIdx >= 3) {
      const close3Ago = parseFloat(sortedKline[targetIdx - 3].close_px);
      if (close3Ago > 0) {
        change3d = parseFloat(((closePrice - close3Ago) / close3Ago * 100).toFixed(2));
      }
    }

    // N日涨幅（研报模式排序依据，N=3/5 筛选窗口）：同口径按窗口计算，数据不足时回退当日涨幅
    let changeNd = null;
    if (isReportMode) {
      changeNd = change;
      if (targetIdx >= ndays) {
        const closeNAgo = parseFloat(sortedKline[targetIdx - ndays].close_px);
        if (closeNAgo > 0) {
          changeNd = parseFloat(((closePrice - closeNAgo) / closeNAgo * 100).toFixed(2));
        }
      }
    }

    // N日研报覆盖数（研报模式排序依据）：最近 N 个报告日内标题或正文命中股票名的数量
    let reportCount = 0;
    if (isReportMode) {
      reportCount = sumReportCount(stock.name, reportWinDates, reportIndex);
    }

    checkedCount++;

    passedStocks.push({
      stock,
      openPrice, closePrice, change, prevClose, openChange, buyPrice,
      change3d, changeNd, reportCount,
      isSh688: stock.code.startsWith('sh688') || stock.code.startsWith('688'),
    });
  }

  if (isChangeMode || isReportMode) {
    // 涨跌幅模式：全量自选股按 3 日涨幅从高到低排序；研报模式：按 N 日研报覆盖数从高到低，覆盖数相同取 N 日涨幅大者优先
    // 不做任何过滤、不截断（数据缺失的排最后）
    const sorted = passedStocks.sort((a, b) => {
      if (isReportMode) {
        const ra = a.reportCount == null ? -Infinity : a.reportCount;
        const rb = b.reportCount == null ? -Infinity : b.reportCount;
        if (ra !== rb) return rb - ra;
      }
      const va = (isReportMode ? a.changeNd : a.change3d) == null ? -Infinity : (isReportMode ? a.changeNd : a.change3d);
      const vb = (isReportMode ? b.changeNd : b.change3d) == null ? -Infinity : (isReportMode ? b.changeNd : b.change3d);
      return vb - va;
    });
    const matched = sorted
      .filter(s => !BUY_POINT_EXCLUDED_CODES.has(s.stock.code))
      .map(s => ({
      code: s.stock.code,
      stockName: s.stock.name,
      blockName: s.stock.blockName,
      isImportant: s.stock.isImportant || false,
      openPrice: s.openPrice, prevClose: s.prevClose, openChange: s.openChange,
      change: s.change, change3d: s.change3d, changeNd: s.changeNd, buyPrice: s.buyPrice,
      reportCount: s.reportCount,
    }));

    const backtestRecommendation = isChangeMode && matched.length >= 2
      ? `根据历史回测数据，建议在 9:40 或者 11:00 买涨幅第二的股票 <span style="color:#cf1322;font-weight:700">${matched[1].stockName}</span>；`
      : null;

    return {
      success: true,
      data: {
        targetDate: targetDateStr,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        matchedStocks: matched,
        checkedCount,
        sortBy: isChangeMode ? 'change' : 'reports',
        reportDays: isReportMode ? ndays : null,
        backtestRecommendation,
      },
    };
  }

  // 抗分歧模式：阶段3 — 并行拉取通过MA10筛选的股票的分时数据，计算抗分歧分数
  const resilienceResults = await batchParallel(passedStocks, async (s) => {
    try {
      const indexLine = s.isSh688 ? kcIndexLine : cyIndexLine;
      if (indexLine.length === 0) return null;

      const stockTline = await getSingleStockTlineDataByDate(s.stock.code, targetDateStr);
      const stockLine = stockTline?.line || [];
      if (stockLine.length === 0) return null;

      const limitType = getLimitTypeByCode(s.stock.code);
      const resilienceScore = calculateResilience(indexLine, stockLine, limitType);

      if (resilienceScore <= 8) return null;

      return {
        code: s.stock.code,
        stockName: s.stock.name,
        blockName: s.stock.blockName,
        isImportant: s.stock.isImportant || false,
        openPrice: s.openPrice, prevClose: s.prevClose, openChange: s.openChange,
        resilienceScore: parseFloat(resilienceScore.toFixed(2)),
        change: s.change, buyPrice: s.buyPrice,
      };
    } catch (e) {
      console.error(`诊断 ${s.stock.code} 抗分歧失败:`, e.message);
      return null;
    }
  }, 10);

  const matchedStocks = resilienceResults.filter(Boolean);
  matchedStocks.sort((a, b) => (b.resilienceScore || 0) - (a.resilienceScore || 0));

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      matchedStocks,
      checkedCount,
      sortBy: 'resilience',
    },
  };
};

// ========== 个股买点诊断：7 项前置检查 + 个股抗分歧指数检查 ==========
const getSingleStockBuyPointDiagnosis = async (code, targetDate = null, refresh = false) => {
  if (!code) {
    return { success: false, message: '缺少股票代码' };
  }

  // 1. 复用 7 项前置条件检查
  const checksResult = await getBuyPointChecks(targetDate, refresh);
  const checks = [...(checksResult.data?.checks || [])];
  let allPassed = checksResult.data?.allPassed === true;

  // 2. 计算个股抗分歧指数（与 getBuyPointStocks 逻辑一致）
  let targetDay;
  if (targetDate) {
    const dateStr = String(targetDate).replace(/-/g, '');
    targetDay = dayjs(dateStr, 'YYYYMMDD');
  } else {
    targetDay = dayjs();
    // 周末回退到上周五
    const dow = targetDay.day();
    if (dow === 0) targetDay = targetDay.subtract(2, 'day');
    else if (dow === 6) targetDay = targetDay.subtract(1, 'day');
  }
  const targetDateStr = targetDay.format('YYYYMMDD');

  const isSh688 = code.startsWith('sh688') || code.startsWith('688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const indexTline = await getSingleStockTlineDataByDate(indexCode, targetDateStr);
  const indexLine = indexTline?.line || [];

  const stockTline = await getSingleStockTlineDataByDate(code, targetDateStr);
  const stockLine = stockTline?.line || [];

  let resilienceScore = null;
  let resilienceReason = '未获取到个股或指数分时数据，无法计算抗分歧指数';
  let resilienceValue = '无数据';

  if (indexLine.length > 0 && stockLine.length > 0) {
    const limitType = getLimitTypeByCode(code);
    resilienceScore = calculateResilience(indexLine, stockLine, limitType);
    resilienceScore = parseFloat(resilienceScore.toFixed(2));
    resilienceValue = resilienceScore != null ? `${resilienceScore.toFixed(2)}` : '无数据';
  }

  const check8Passed = resilienceScore !== null && resilienceScore > 8;
  if (check8Passed) {
    resilienceReason = `个股抗分歧指数 ${resilienceScore.toFixed(2)}，大于 8 阈值，个股抗跌性强`;
  } else if (resilienceScore !== null) {
    resilienceReason = `个股抗分歧指数 ${resilienceScore.toFixed(2)}，未达到 8 阈值，个股抗跌性不足`;
  }

  checks.push({
    id: 'stock_resilience',
    title: '个股抗分歧指数大于 8',
    passed: check8Passed,
    value: resilienceValue,
    reason: resilienceReason,
  });
  if (!check8Passed) allPassed = false;

  // 3. 个股价格是否低于10日线
  const klineData = await getSingleStockData(code, 30);
  let ma10CheckPassed = false;
  let ma10CheckReason = '未获取到K线数据';
  let ma10CheckValue = '无数据';
  if (klineData && klineData.length > 0) {
    const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
    const targetIdx = sortedKline.findIndex(k => parseInt(k.trade_date) === parseInt(targetDateStr));
    if (targetIdx >= 0) {
      const targetKline = sortedKline[targetIdx];
      const closePrice = parseFloat(targetKline.close_px);
      let ma10 = targetKline.ma10_px;
      if (ma10 === undefined || ma10 === null) {
        if (targetIdx >= 9) {
          const last10 = sortedKline.slice(targetIdx - 9, targetIdx + 1);
          ma10 = last10.reduce((sum, k) => sum + parseFloat(k.close_px), 0) / 10;
        }
      }
      ma10 = ma10 !== undefined && ma10 !== null ? parseFloat(ma10) : null;
      if (ma10 !== null) {
        ma10CheckPassed = closePrice >= ma10;
        ma10CheckValue = `收盘价${closePrice.toFixed(2)} / 10日线${ma10.toFixed(2)}`;
        ma10CheckReason = ma10CheckPassed
          ? `收盘价 ${closePrice.toFixed(2)} 不低于10日线 ${ma10.toFixed(2)}`
          : `收盘价 ${closePrice.toFixed(2)} 低于10日线 ${ma10.toFixed(2)}，价格偏弱，不适合买入`;
      } else {
        ma10CheckReason = 'K线数据不足，无法计算10日线';
      }
    }
  }
  checks.push({
    id: 'price_above_ma10',
    title: '价格不低于10日线',
    passed: ma10CheckPassed,
    value: ma10CheckValue,
    reason: ma10CheckReason,
  });
  if (!ma10CheckPassed) allPassed = false;

  const passedCount = checks.filter(c => c.passed).length;
  const totalCheckCount = checks.length;

  const conclusion = allPassed
    ? '全部条件已满足，可以出手买入，但是请分仓 1/3，随后逐步分批买入，分仓管理是最后一道防火墙，谨防尾盘大盘跳水！'
    : '当前条件未全部满足，请耐心等待，不要盲目出手。';

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      refreshed: refresh,
      code,
      resilienceScore,
      checks,
      allPassed,
      passedCount,
      totalCheckCount,
      conclusion,
    },
  };
};

// ========== 兼容旧接口：合并检查+个股 ==========
const diagnoseRealtimeBuyPoints = async (targetDate = null, refresh = false) => {
  const checksResult = await getBuyPointChecks(targetDate, refresh);
  const stocksResult = await getBuyPointStocks(targetDate);
  return {
    success: true,
    data: {
      ...checksResult.data,
      matchedStocks: stocksResult.data.matchedStocks,
      checkedCount: stocksResult.data.checkedCount,
      message: checksResult.data.allPassed
        ? `${checksResult.data.passedCount}/${checksResult.data.totalCheckCount} 项前置条件全部通过，共诊断 ${stocksResult.data.checkedCount} 只股票，筛选出 ${stocksResult.data.matchedStocks.length} 只抗分歧指数 > 8 的个股`
        : `${checksResult.data.passedCount}/${checksResult.data.totalCheckCount} 项前置条件通过，暂不满足买点要求；共诊断 ${stocksResult.data.checkedCount} 只股票，筛选出 ${stocksResult.data.matchedStocks.length} 只抗分歧指数 > 8 的个股（仅供参考）`,
    },
  };
};

// ========== 获取可选股票列表 ==========
// 合并 monitor_alarms.json 中的股票与 monitor_stocks.json 自选股列表
const getBuySellSelectableStocks = () => {
  const monitorStocks = getMonitorStocks();
  const result = monitorStocks.map(s => ({
    code: s.code,
    stockName: s.name,
    blockName: s.blockName,
    isImportant: s.isImportant,
    source: 'watchlist',
  }));

  // 读取 monitor_alarms.json，从中提取股票（若有）
  try {
    const raw = fs.readFileSync(monitorAlarmsPath, 'utf-8') || '[]';
    const alarms = JSON.parse(raw);
    if (Array.isArray(alarms)) {
      const existingCodes = new Set(result.map(s => s.code));
      for (const alarm of alarms) {
        const code = alarm.stockCode || alarm.code;
        if (!code || existingCodes.has(code)) continue;
        result.push({
          code,
          stockName: alarm.stockName || alarm.name || code,
          blockName: alarm.blockName || '',
          isImportant: false,
          source: 'alarms',
        });
        existingCodes.add(code);
      }
    }
  } catch (e) {
    // 读取失败忽略
  }

  return result;
};

const checkSingleStockSellPoint = async (code, costPrice = null) => {
  try {
    const klineData = await getSingleStockData(code, 30);
    if (!klineData || klineData.length === 0) {
      return { success: true, isSell: false, reasons: ['无K线数据'], stockName: code, conditions: [], conclusion: '无K线数据，无法诊断' };
    }

    const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
    const latestKline = sortedKline[sortedKline.length - 1];
    const tradeDate = latestKline.trade_date;

    // 成本价优先取请求传入值，缺省时从持仓列表读取（用户自定义成本线）
    let effectiveCostPrice = costPrice;
    if (!Number.isFinite(Number(effectiveCostPrice)) || Number(effectiveCostPrice) <= 0) {
      const positions = getStockPositions();
      const pos = (positions || []).find((p) => p.code === code);
      effectiveCostPrice = pos?.costPrice != null ? Number(pos.costPrice) : null;
    }

    const sellResult = await checkSellPointDetailed(code, tradeDate, sortedKline, effectiveCostPrice);

    return {
      success: true,
      isSell: sellResult.isSell,
      reasons: sellResult.isSell ? sellResult.conditions.filter(c => c.satisfied).map(c => c.detail) : ['当前未达到卖点，可以继续持有'],
      stockName: code,
      tradeDate,
      conditions: sellResult.conditions,
      conclusion: sellResult.conclusion,
      detail: {
        closePrice: sellResult.closePrice,
        ma5: sellResult.ma5,
        ma10: sellResult.ma10,
        ma10Slope: sellResult.ma10Slope,
        change: sellResult.change,
        techEmotion: sellResult.techEmotion,
        resilienceScore: sellResult.resilienceScore,
      },
    };
  } catch (error) {
    console.error('单个股票卖点诊断失败:', error);
    return { success: false, isSell: false, reasons: ['诊断失败'], stockName: code, conditions: [], conclusion: '诊断失败' };
  }
};

module.exports = {
  isEmotionFreezing,
  checkBuyPoint,
  checkSellPoint,
  checkSellPointDetailed,
  backtestSingleStock,
  backtestBuySell,
  diagnoseRealtimeBuyPoints,
  getBuyPointChecks,
  getBuyPointStocks,
  getSingleStockBuyPointDiagnosis,
  getBuySellSelectableStocks,
  checkSingleStockSellPoint,
};
