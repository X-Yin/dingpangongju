const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dayjs = require('dayjs');
const { isTradingHours, isWeekend } = require('../utils');
const { getAllStockData, getOpeningPrices } = require('./stock');
const { getAllDaPanData } = require('./dapan');
const { getLatestTechEmotion, getAllTechIndexData, getAllIndexKlineData } = require('./emotion');
const { getIndexTlineByDate } = require('./fupan');
const { getMonitorStocks } = require('./monitorStock');
const { STRATEGY_DEFINITIONS } = require('./strategyBacktest');

const strategyRecordsPath = path.resolve(__dirname, '../data/strategy_records.json');
const strategyStatePath = path.resolve(__dirname, '../data/strategy_state.json');

const STRATEGY_RETENTION_HOURS = 8;
const POLL_INTERVAL_1MIN = 60000;
const POLL_INTERVAL_5MIN = 300000;

const genId = () => crypto.randomBytes(8).toString('hex');

const readRecords = () => {
  try {
    return fs.existsSync(strategyRecordsPath) ? JSON.parse(fs.readFileSync(strategyRecordsPath, 'utf8') || '[]') : [];
  } catch (e) {
    console.error('[strategy] 读取记录文件失败:', e.message);
    return [];
  }
};

const writeRecords = (list) => {
  try {
    fs.writeFileSync(strategyRecordsPath, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('[strategy] 写入记录文件失败:', e.message);
  }
};

const readState = () => {
  try {
    return fs.existsSync(strategyStatePath) ? JSON.parse(fs.readFileSync(strategyStatePath, 'utf8') || '{}') : {};
  } catch (e) {
    return {};
  }
};

const writeState = (state) => {
  try {
    fs.writeFileSync(strategyStatePath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[strategy] 写入状态文件失败:', e.message);
  }
};

const cleanupRecords = () => {
  const cutoff = dayjs().subtract(STRATEGY_RETENTION_HOURS, 'hour');
  const records = readRecords();
  const filtered = records.filter(r => r && r.time && dayjs(r.time).isAfter(cutoff));
  if (filtered.length !== records.length) {
    writeRecords(filtered);
  }
  return filtered;
};

const parseAmountToYi = (str) => {
  if (!str) return 0;
  const isPositive = str.startsWith('+');
  const isNegative = str.startsWith('-');
  const valueStr = (isPositive || isNegative) ? str.slice(1) : str;
  const num = parseFloat(valueStr.replace(/亿|万/g, '')) || 0;
  if (valueStr.indexOf('万') !== -1) {
    return (isNegative ? -1 : 1) * (num / 10000);
  }
  return (isNegative ? -1 : 1) * num;
};

const getLimitUpPercent = (code) => {
  const pureCode = code.replace(/^sh|^sz/, '');
  if (pureCode.startsWith('688') || pureCode.startsWith('3')) {
    return 20;
  }
  return 10;
};

const getHighOpenThreshold = (code) => {
  const pureCode = code.replace(/^sh|^sz/, '');
  if (pureCode.startsWith('688') || pureCode.startsWith('3')) {
    return 10;
  }
  return 5;
};

const getIndexTline = async (code) => {
  try {
    const { getSingleStockTlineData } = require('./stock');
    const data = await getSingleStockTlineData(code);
    return data?.line || [];
  } catch (e) {
    return [];
  }
};

const checkStrategy1_HighOpenLowClose = (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;
  
  if (timeVal < 9 * 60 + 25 || timeVal > 9 * 60 + 45) {
    return null;
  }

  try {
    const allStocks = getAllStockData();
    const openingPrices = getOpeningPrices();
    const monitorStocks = getMonitorStocks();
    
    if (!allStocks || allStocks.length === 0) return null;

    const monitorCodes = new Set(monitorStocks.map(s => s.code));
    let highOpenCount = 0;
    let totalCount = 0;
    const highOpenStocks = [];

    for (const stock of allStocks) {
      if (!monitorCodes.has(stock.code)) continue;
      
      const openPrice = openingPrices[stock.code];
      if (!openPrice || !stock.preClosePx) continue;
      
      totalCount++;
      const openChange = ((openPrice - stock.preClosePx) / stock.preClosePx) * 100;
      const threshold = getHighOpenThreshold(stock.code);
      
      if (openChange >= threshold) {
        highOpenCount++;
        highOpenStocks.push({
          name: stock.stockName,
          code: stock.code,
          openChange: openChange.toFixed(2)
        });
      }
    }

    if (totalCount === 0) return null;

    const ratio = highOpenCount / totalCount;
    const lastTriggered = state.high_open_low_close?.lastTriggered;
    
    if (ratio >= 0.1 && highOpenCount >= 3) {
      const today = now.format('YYYY-MM-DD');
      if (lastTriggered === today) return null;
      
      return {
        strategyId: 'high_open_low_close',
        title: '⚠️ 高开低走风险预警',
        description: `自选股中有 <strong>${highOpenCount}</strong> 只股票（占比 ${(ratio * 100).toFixed(1)}%）高开接近涨停板位置，警惕高开低走风险。<br/><strong>高开门个股：</strong>${highOpenStocks.slice(0, 5).map(s => `${s.name}(${s.code}) +${s.openChange}%`).join('、')}${highOpenStocks.length > 5 ? '...' : ''}`,
        severity: 'high',
        isBullish: false
      };
    }
  } catch (e) {
    console.error('[strategy] 策略1检测失败:', e.message);
  }
  return null;
};

const checkStrategy2_VShapeReversal = async (state) => {
  try {
    const techIndexData = await getAllTechIndexData();
    if (!techIndexData || techIndexData.length < 2) return null;
    
    const sorted = [...techIndexData].sort((a, b) => b.date.localeCompare(a.date));
    const yesterdayValue = parseFloat(sorted[0]?.changeSumResult);
    
    if (isNaN(yesterdayValue) || yesterdayValue >= -30) return null;

    const [dapanData, amountResult] = await Promise.all([
      getAllDaPanData(),
      Promise.resolve(require('./amount').getAmountHistory())
    ]);

    if (!dapanData || !amountResult || amountResult.length < 2) return null;

    const latestAmount = amountResult[amountResult.length - 1];
    const prevAmount = amountResult[amountResult.length - 2];
    
    const currMainMoney = parseAmountToYi(latestAmount[1].mainMoney);
    const prevMainMoney = parseAmountToYi(prevAmount[1].mainMoney);
    const moneyFlowIncreased = currMainMoney > prevMainMoney;

    const currAmount = parseAmountToYi(latestAmount[1].amountChangeDiff);
    const prevAmountVal = parseAmountToYi(prevAmount[1].amountChangeDiff);
    const amountIncreased = currAmount - prevAmountVal >= 50;

    const indexQuotes = dapanData.index_quote || [];
    const cyb = indexQuotes.find(i => i.secu_code === 'sz399006');
    const kcb = indexQuotes.find(i => i.secu_code === 'sh000688');
    
    const indexUp = (cyb && cyb.change > 0) || (kcb && kcb.change > 0);

    const lastTriggered = state.v_shape_reversal?.lastTriggeredTime;
    const now = dayjs();
    if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 30) return null;

    if (moneyFlowIncreased && amountIncreased && indexUp) {
      const state2 = state.v_shape_reversal || {};
      if (state2.triggeredToday === now.format('YYYY-MM-DD')) return null;
      
      return {
        strategyId: 'v_shape_reversal',
        title: '🚀 V形反转信号',
        description: `昨日科技情绪指数为 <strong>${yesterdayValue.toFixed(2)}</strong>（冰点<-30），今日出现量价齐升信号：<br/>• 主力资金净流入增加（${prevMainMoney.toFixed(1)}亿 → ${currMainMoney.toFixed(1)}亿）<br/>• 成交量放大 ${(currAmount - prevAmountVal).toFixed(1)}亿（≥50亿）<br/>• 创业板/科创板指数上涨`,
        severity: 'high',
        isBullish: true
      };
    }
  } catch (e) {
    console.error('[strategy] 策略2检测失败:', e.message);
  }
  return null;
};

const checkStrategy3_VolumeShrinkStagnation = async (state) => {
  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 10) return null;

    const recent = amountHistory.slice(-10);
    const amounts = recent.map(item => parseAmountToYi(item[1].amountChangeDiff));
    const maxAmount = Math.max(...amounts.slice(0, -3));
    const latestAmounts = amounts.slice(-3);
    const avgLatest = latestAmounts.reduce((a, b) => a + b, 0) / latestAmounts.length;

    if (maxAmount - avgLatest < 100) return null;

    const dapanData = await getAllDaPanData();
    const indexQuotes = dapanData.index_quote || [];
    const cyb = indexQuotes.find(i => i.secu_code === 'sz399006');
    const kcb = indexQuotes.find(i => i.secu_code === 'sh000688');
    
    const cybLine = await getIndexTline('sz399006');
    const kcbLine = await getIndexTline('sh000688');
    
    let indexStagnating = false;
    for (const line of [cybLine, kcbLine]) {
      if (line.length < 10) continue;
      const recent5 = line.slice(-5);
      const prev5 = line.slice(-10, -5);
      const recentMax = Math.max(...recent5.map(p => p.last_px));
      const prevMax = Math.max(...prev5.map(p => p.last_px));
      const recentMin = Math.min(...recent5.map(p => p.last_px));
      
      if (recentMax <= prevMax && recentMin < recentMax * 0.998) {
        indexStagnating = true;
        break;
      }
    }

    const now = dayjs();
    const lastTriggered = state.volume_shrink_stagnation?.lastTriggeredTime;
    if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 30) return null;

    if (indexStagnating || (cyb && cyb.change <= 0) || (kcb && kcb.change <= 0)) {
      return {
        strategyId: 'volume_shrink_stagnation',
        title: '📉 放量后缩量滞涨',
        description: `成交量从高位 <strong>${maxAmount.toFixed(0)}亿</strong> 回落至 <strong>${avgLatest.toFixed(0)}亿</strong>，指数开始滞涨，需警惕回落风险。`,
        severity: 'medium',
        isBullish: false
      };
    }
  } catch (e) {
    console.error('[strategy] 策略3检测失败:', e.message);
  }
  return null;
};

const checkStrategy4_OutflowFakeRally = async (state) => {
  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 2) return null;

    const latest = amountHistory[amountHistory.length - 1];
    const prev = amountHistory[amountHistory.length - 2];
    
    const currMoney = parseAmountToYi(latest[1].mainMoney);
    const prevMoney = parseAmountToYi(prev[1].mainMoney);
    
    if (!(currMoney < prevMoney && currMoney < -5 && (prevMoney - currMoney) >= 5)) return null;

    const cybLine = await getIndexTline('sz399006');
    const kcbLine = await getIndexTline('sh000688');
    
    let indexRising = false;
    for (const line of [cybLine, kcbLine]) {
      if (line.length < 3) continue;
      const curr = line[line.length - 1]?.last_px;
      const prev2 = line[line.length - 3]?.last_px;
      if (curr && prev2 && curr > prev2) {
        indexRising = true;
        break;
      }
    }

    const now = dayjs();
    const lastTriggered = state.outflow_fake_rally?.lastTriggeredTime;
    if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 10) return null;

    if (indexRising) {
      return {
        strategyId: 'outflow_fake_rally',
        title: '⚠️ 资金流出但指数上涨-诱多信号',
        description: `主力资金净流出扩大（${prevMoney.toFixed(1)}亿 → ${currMoney.toFixed(1)}亿），但创业板/科创板指数仍在上涨，可能是诱多信号，注意风险。`,
        severity: 'high',
        isBullish: false
      };
    }
  } catch (e) {
    console.error('[strategy] 策略4检测失败:', e.message);
  }
  return null;
};

const checkStrategy5_LowOpenWashRecovery = (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;
  
  if (timeVal < 10 * 60 + 30 || timeVal > 11 * 60) return null;

  try {
    const dapanData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/dapanData.json'), 'utf8'));
    const indexQuotes = dapanData.index_quote || [];
    
    let signalFound = false;
    const details = [];

    for (const idx of indexQuotes) {
      if (idx.secu_code !== 'sz399006' && idx.secu_code !== 'sh000688') continue;
      
      const openPx = idx.open_px;
      const lastPx = idx.last_px;
      const lowPx = idx.low_px;
      
      if (!openPx || !lastPx || !lowPx) continue;
      
      const openToLow = ((lowPx - openPx) / openPx) * 100;
      const lowToNow = ((lastPx - lowPx) / lowPx) * 100;
      const recovered = lastPx >= openPx * 0.998;
      
      if (openToLow < -1.5 && lowToNow > 1 && recovered) {
        signalFound = true;
        details.push(`${idx.secu_name}: 最低${openToLow.toFixed(2)}%，当前回升+${lowToNow.toFixed(2)}%`);
      }
    }

    const state5 = state.low_open_wash_recovery || {};
    if (state5.triggeredToday === now.format('YYYY-MM-DD')) return null;

    if (signalFound) {
      return {
        strategyId: 'low_open_wash_recovery',
        title: '✅ 低开假摔后V形反转',
        description: `指数开盘后下挫后快速回升，已重新站上开盘价附近，可能是洗盘结束信号：<br/>${details.join('<br/>')}`,
        severity: 'high',
        isBullish: true
      };
    }
  } catch (e) {
    console.error('[strategy] 策略5检测失败:', e.message);
  }
  return null;
};

const checkStrategy6_StraightRiseNoVolume = async (state) => {
  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 6) return null;

    const now5minAgo = dayjs().subtract(5, 'minute').format('HHmmss');
    const recent = amountHistory.slice(-10);
    
    let currItem = recent[recent.length - 1];
    let fiveMinAgoItem = null;
    
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i][0] <= now5minAgo) {
        fiveMinAgoItem = recent[i];
        break;
      }
    }
    
    if (!fiveMinAgoItem) return null;

    const currAmount = parseAmountToYi(currItem[1].amountChangeDiff);
    const prevAmount = parseAmountToYi(fiveMinAgoItem[1].amountChangeDiff);
    const amountDiff = currAmount - prevAmount;

    const cybLine = await getIndexTline('sz399006');
    const kcbLine = await getIndexTline('sh000688');
    
    let sharpRise = false;
    let riseDetail = '';
    
    for (const [line, name] of [[cybLine, '创业板'], [kcbLine, '科创板']]) {
      if (line.length < 6) continue;
      const curr = line[line.length - 1]?.last_px;
      const prev = line[0]?.last_px;
      if (curr && prev) {
        const change = ((curr - prev) / prev) * 100;
        if (change > 0.5) {
          sharpRise = true;
          riseDetail = `${name}5分钟上涨${change.toFixed(2)}%`;
          break;
        }
      }
    }

    const now = dayjs();
    const lastTriggered = state.straight_rise_no_volume?.lastTriggeredTime;
    if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 15) return null;

    if (sharpRise && amountDiff < 100) {
      return {
        strategyId: 'straight_rise_no_volume',
        title: '⚠️ 无量拉升警惕回落',
        description: `${riseDetail}，但成交量仅增加 <strong>${amountDiff.toFixed(0)}亿</strong>（不足100亿），无量上涨持续性存疑，容易回落。`,
        severity: 'medium',
        isBullish: false
      };
    }
  } catch (e) {
    console.error('[strategy] 策略6检测失败:', e.message);
  }
  return null;
};

const checkStrategy7_VolumePriceSurge = async (state) => {
  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 6) return null;

    const currItem = amountHistory[amountHistory.length - 1];
    const now5minAgo = dayjs().subtract(5, 'minute').format('HHmmss');
    
    let fiveMinAgoItem = null;
    for (let i = amountHistory.length - 2; i >= 0; i--) {
      if (amountHistory[i][0] <= now5minAgo) {
        fiveMinAgoItem = amountHistory[i];
        break;
      }
    }
    if (!fiveMinAgoItem) return null;

    const currAmount = parseFloat(currItem[1].amountChangeDiff) || 0;
    const prevAmount = parseFloat(fiveMinAgoItem[1].amountChangeDiff) || 0;
    const currMoney = parseFloat(currItem[1].mainMoney) || 0;
    const prevMoney = parseFloat(fiveMinAgoItem[1].mainMoney) || 0;
    const amountDiff = currAmount - prevAmount;
    const fundIncreased = currMoney > prevMoney;

    const cybLine = await getIndexTline('sz399006');
    const kcbLine = await getIndexTline('sh000688');
    
    let indexUp = false;
    let upDetail = '';
    for (const [line, name] of [[cybLine, '创业板'], [kcbLine, '科创板']]) {
      if (line.length < 6) continue;
      const curr = line[line.length - 1]?.last_px;
      const prev = line[0]?.last_px;
      if (curr && prev) {
        const change = ((curr - prev) / prev) * 100;
        if (change > 0.3) {
          indexUp = true;
          upDetail = `${name}5分钟上涨${change.toFixed(2)}%`;
          break;
        }
      }
    }

    const now = dayjs();
    const lastTriggered = state.volume_price_surge?.lastTriggeredTime;
    if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 20) return null;

    const massiveInflow = currMoney >= 10;

    if (amountDiff >= 100 && fundIncreased && indexUp && massiveInflow) {
      return {
        strategyId: 'volume_price_surge',
        title: '✅ 量价齐升',
        description: `成交量放大 <strong>${amountDiff.toFixed(0)}亿</strong>（≥100亿），资金净流入${prevMoney.toFixed(1)}→${currMoney.toFixed(1)}亿（≥10亿，流入增加），${upDetail}。量价资金三者共振，多方占优。`,
        severity: 'medium',
        isBullish: true
      };
    }
  } catch (e) {
    console.error('[strategy] 策略7检测失败:', e.message);
  }
  return null;
};

const checkStrategy8_PanicOutflow = async (state) => {
  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 10) return null;

    const currItem = amountHistory[amountHistory.length - 1];

    // 找约15分钟前的成交量快照
    const now15minAgo = dayjs().subtract(15, 'minute').format('HHmmss');
    let amount15minAgoItem = null;
    for (let i = amountHistory.length - 2; i >= 0; i--) {
      if (amountHistory[i][0] <= now15minAgo) {
        amount15minAgoItem = amountHistory[i];
        break;
      }
    }
    if (!amount15minAgoItem) return null;

    // 找约10分钟前的资金快照
    const now10minAgo = dayjs().subtract(10, 'minute').format('HHmmss');
    let fund10minAgoItem = null;
    for (let i = amountHistory.length - 2; i >= 0; i--) {
      if (amountHistory[i][0] <= now10minAgo) {
        fund10minAgoItem = amountHistory[i];
        break;
      }
    }
    if (!fund10minAgoItem) return null;

    const currAmount = parseFloat(currItem[1].amountChangeDiff) || 0;
    const prevAmount = parseFloat(amount15minAgoItem[1].amountChangeDiff) || 0;
    const currMoney = parseFloat(currItem[1].mainMoney) || 0;
    const prevMoney = parseFloat(fund10minAgoItem[1].mainMoney) || 0;
    const amountDiff = currAmount - prevAmount;
    const fundOutflowAccelerating = currMoney < prevMoney;
    const volumeSurge = amountDiff >= 100;
    const massiveOutflow = currMoney <= -10;

    const now = dayjs();
    const lastTriggered = state.panic_outflow?.lastTriggeredTime;
    if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 20) return null;

    if (volumeSurge && fundOutflowAccelerating && massiveOutflow) {
      return {
        strategyId: 'panic_outflow',
        title: '🚨 恐慌盘出逃',
        description: `成交量较约15分钟前放大 <strong>${amountDiff.toFixed(0)}亿</strong>（≥100亿），主力资金净流出加速（${prevMoney.toFixed(1)}→${currMoney.toFixed(1)}亿），净流出≥10亿。放量+资金出逃，恐慌盘涌出。`,
        severity: 'high',
        isBullish: false
      };
    }
  } catch (e) {
    console.error('[strategy] 策略8检测失败:', e.message);
  }
  return null;
};

// 策略9和10共用：获取创业板指日K线中的前日、昨日、今日数据
const getCybKlineForPrevDayStrategies = async () => {
  try {
    const indexKlineData = await getAllIndexKlineData();
    const cybKline = (indexKlineData.chuangyebanData || [])
      .filter(k => k.trade_date && k.open_px)
      .sort((a, b) => parseInt(a.trade_date) - parseInt(b.trade_date));
    if (cybKline.length < 3) return null;
    const todayKline = cybKline[cybKline.length - 1];
    const yesterdayKline = cybKline[cybKline.length - 2];
    const dayBeforeYesterdayKline = cybKline[cybKline.length - 3];
    return { todayKline, yesterdayKline, dayBeforeYesterdayKline };
  } catch (e) {
    console.error('[strategy] 获取创业板K线数据失败:', e.message);
    return null;
  }
};

// Strategy 9: 前一日高开低走+放量
const checkStrategy9_PrevDayHighOpenLowCloseVolume = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 仅在 9:30-9:35 窗口检测
  if (timeVal < 9 * 60 + 30 || timeVal > 9 * 60 + 35) return null;

  // 当天已触发过则跳过
  const state9 = state.prev_day_high_open_low_close_volume || {};
  if (state9.triggeredToday === now.format('YYYY-MM-DD')) return null;

  try {
    const klineData = await getCybKlineForPrevDayStrategies();
    if (!klineData) return null;

    const { todayKline, yesterdayKline, dayBeforeYesterdayKline } = klineData;
    const todayOpen = parseFloat(todayKline.open_px);
    const yesterdayOpen = parseFloat(yesterdayKline.open_px);
    const yesterdayClose = parseFloat(yesterdayKline.close_px);
    const yesterdayPreclose = parseFloat(yesterdayKline.preclose_px);
    const yesterdayVolume = parseFloat(yesterdayKline.business_amount);
    const dayBeforeVolume = parseFloat(dayBeforeYesterdayKline.business_amount);

    if (!todayOpen || !yesterdayOpen || !yesterdayClose || !yesterdayPreclose) return null;
    if (!yesterdayVolume || !dayBeforeVolume) return null;

    const isHighOpen = yesterdayOpen > yesterdayPreclose;
    const isLowClose = yesterdayClose < yesterdayOpen;
    const isVolumeSurge = yesterdayVolume > dayBeforeVolume * 1.05;

    if (!(isHighOpen && isLowClose && isVolumeSurge)) return null;

    const volumeChangePct = ((yesterdayVolume - dayBeforeVolume) / dayBeforeVolume) * 100;
    const yesterdayOpenPct = ((yesterdayOpen - yesterdayPreclose) / yesterdayPreclose) * 100;
    const yesterdayClosePct = ((yesterdayClose - yesterdayOpen) / yesterdayOpen) * 100;
    const todayOpenChangePct = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
    const isTodayLowOpen = todayOpen < yesterdayClose;

    if (isTodayLowOpen) {
      return {
        strategyId: 'prev_day_high_open_low_close_volume',
        title: '⚠️ 前日高开低走放量，今日低开继续下跌',
        description: `前一日创业板指高开低走且放量：开盘+${yesterdayOpenPct.toFixed(2)}%（高开）、收盘跌${yesterdayClosePct.toFixed(2)}%（低走）、放量${volumeChangePct.toFixed(1)}%（>5%）。今日竞价低开${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} < 前日收盘${yesterdayClose.toFixed(2)}），前日放量多为真出货或恐慌盘涌出，当日大概率继续下跌。`,
        severity: 'high',
        isBullish: false
      };
    } else {
      return {
        strategyId: 'prev_day_high_open_low_close_volume',
        title: '✅ 前日高开低走放量，今日平开/高开大概率反弹',
        description: `前一日创业板指高开低走且放量：开盘+${yesterdayOpenPct.toFixed(2)}%（高开）、收盘跌${yesterdayClosePct.toFixed(2)}%（低走）、放量${volumeChangePct.toFixed(1)}%（>5%）。今日竞价${todayOpenChangePct >= 0 ? '高开' : '平开'}${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} ≥ 前日收盘${yesterdayClose.toFixed(2)}），资金愿意高开解放前日套牢盘，说明前日回落为洗盘而非出货，当日大概率反弹。`,
        severity: 'high',
        isBullish: true
      };
    }
  } catch (e) {
    console.error('[strategy] 策略9检测失败:', e.message);
  }
  return null;
};

// Strategy 10: 前一日地量地价
const checkStrategy10_PrevDayVolumePriceBottom = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 仅在 9:30-9:35 窗口检测
  if (timeVal < 9 * 60 + 30 || timeVal > 9 * 60 + 35) return null;

  // 当天已触发过则跳过
  const state10 = state.prev_day_volume_price_bottom || {};
  if (state10.triggeredToday === now.format('YYYY-MM-DD')) return null;

  try {
    const klineData = await getCybKlineForPrevDayStrategies();
    if (!klineData) return null;

    const { todayKline, yesterdayKline, dayBeforeYesterdayKline } = klineData;
    const todayOpen = parseFloat(todayKline.open_px);
    const yesterdayClose = parseFloat(yesterdayKline.close_px);
    const yesterdayChange = parseFloat(yesterdayKline.change);
    const yesterdayVolume = parseFloat(yesterdayKline.business_amount);
    const dayBeforeVolume = parseFloat(dayBeforeYesterdayKline.business_amount);

    if (!todayOpen || !yesterdayClose) return null;
    if (isNaN(yesterdayChange) || !yesterdayVolume || !dayBeforeVolume) return null;

    const isBigDrop = yesterdayChange < -1;
    const isVolumeShrink = yesterdayVolume < dayBeforeVolume * 0.95;

    if (!(isBigDrop && isVolumeShrink)) return null;

    const volumeChangePct = ((yesterdayVolume - dayBeforeVolume) / dayBeforeVolume) * 100;
    const todayOpenChangePct = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
    const isTodayLowOpen = todayOpen < yesterdayClose;

    if (isTodayLowOpen) {
      return {
        strategyId: 'prev_day_volume_price_bottom',
        title: '⚠️ 前日地量地价，今日低开继续下跌',
        description: `前一日创业板指地量地价：涨跌幅${yesterdayChange.toFixed(2)}%（<-1%大幅下跌）、缩量${volumeChangePct.toFixed(1)}%（>5%缩量）。今日竞价低开${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} < 前日收盘${yesterdayClose.toFixed(2)}），可能受外围利空拖累，当日大概率继续下跌。`,
        severity: 'high',
        isBullish: false
      };
    } else {
      return {
        strategyId: 'prev_day_volume_price_bottom',
        title: '✅ 前日地量地价，今日平开/高开大概率反弹',
        description: `前一日创业板指地量地价：涨跌幅${yesterdayChange.toFixed(2)}%（<-1%大幅下跌）、缩量${volumeChangePct.toFixed(1)}%（>5%缩量）。今日竞价${todayOpenChangePct >= 0 ? '高开' : '平开'}${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} ≥ 前日收盘${yesterdayClose.toFixed(2)}），可能受隔夜情绪催化，当日大概率上涨反弹。`,
        severity: 'high',
        isBullish: true
      };
    }
  } catch (e) {
    console.error('[strategy] 策略10检测失败:', e.message);
  }
  return null;
};

// Strategy 11: 前一日尾盘拉升
const checkStrategy11_PrevDayTailRally = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 仅在 9:30-9:35 窗口检测
  if (timeVal < 9 * 60 + 30 || timeVal > 9 * 60 + 35) return null;

  // 当天已触发过则跳过
  const state11 = state.prev_day_tail_rally || {};
  if (state11.triggeredToday === now.format('YYYY-MM-DD')) return null;

  try {
    const indexKlineData = await getAllIndexKlineData();
    const cybKline = (indexKlineData.chuangyebanData || [])
      .filter(k => k.trade_date && k.open_px)
      .sort((a, b) => parseInt(a.trade_date) - parseInt(b.trade_date));
    const kcbKline = (indexKlineData.kechuangbanData || [])
      .filter(k => k.trade_date && k.open_px)
      .sort((a, b) => parseInt(a.trade_date) - parseInt(b.trade_date));

    if (cybKline.length < 2 && kcbKline.length < 2) return null;

    const todayInt = parseInt(now.format('YYYYMMDD'));

    const findTodayAndPrev = (kline) => {
      if (kline.length < 2) return { today: null, prev: null };
      for (let i = kline.length - 1; i >= 0; i--) {
        if (parseInt(kline[i].trade_date) <= todayInt) {
          return { today: kline[i], prev: i > 0 ? kline[i - 1] : null };
        }
      }
      return { today: null, prev: null };
    };

    const cyb = findTodayAndPrev(cybKline);
    const kcb = findTodayAndPrev(kcbKline);

    const cybIsToday = cyb.today && parseInt(cyb.today.trade_date) === todayInt;
    const kcbIsToday = kcb.today && parseInt(kcb.today.trade_date) === todayInt;
    if (!cybIsToday && !kcbIsToday) return null;

    const prevDate = cyb.prev?.trade_date || kcb.prev?.trade_date;
    if (!prevDate) return null;

    const indexTlines = await getIndexTlineByDate(prevDate);
    if (!indexTlines) return null;

    const checkTailRally = (line) => {
      if (!line || line.length === 0) return null;
      const tailPoints = line.filter(p => p.minute >= 1400 && p.last_px);
      if (tailPoints.length === 0) return null;
      const lowPx = Math.min(...tailPoints.map(p => parseFloat(p.last_px)));
      const closePx = parseFloat(tailPoints[tailPoints.length - 1].last_px);
      if (isNaN(lowPx) || isNaN(closePx) || lowPx <= 0) return null;
      const rallyPct = ((closePx - lowPx) / lowPx) * 100;
      return { lowPx, closePx, rallyPct };
    };

    const cybRally = checkTailRally(indexTlines.chuangyeban?.line);
    const kcbRally = checkTailRally(indexTlines.kechuangban?.line);

    const cybHit = cybRally && cybRally.rallyPct >= 1;
    const kcbHit = kcbRally && kcbRally.rallyPct >= 1;

    if (!cybHit && !kcbHit) return null;

    let todayOpen = null, prevClose = null;
    if (cybHit && cyb.today && cyb.prev) {
      todayOpen = parseFloat(cyb.today.open_px);
      prevClose = parseFloat(cyb.prev.close_px);
    } else if (kcbHit && kcb.today && kcb.prev) {
      todayOpen = parseFloat(kcb.today.open_px);
      prevClose = parseFloat(kcb.prev.close_px);
    } else if (cyb.today && cyb.prev) {
      todayOpen = parseFloat(cyb.today.open_px);
      prevClose = parseFloat(cyb.prev.close_px);
    } else if (kcb.today && kcb.prev) {
      todayOpen = parseFloat(kcb.today.open_px);
      prevClose = parseFloat(kcb.prev.close_px);
    }

    if (!todayOpen || !prevClose || isNaN(todayOpen) || isNaN(prevClose)) return null;

    const openChangePct = ((todayOpen - prevClose) / prevClose) * 100;
    const isHighOpen = openChangePct > 0;

    const hitDetails = [];
    if (cybHit) {
      hitDetails.push(`创业板指：14:00后最低${cybRally.lowPx.toFixed(2)}→收盘${cybRally.closePx.toFixed(2)}，拉升${cybRally.rallyPct.toFixed(2)}%`);
    }
    if (kcbHit) {
      hitDetails.push(`科创50：14:00后最低${kcbRally.lowPx.toFixed(2)}→收盘${kcbRally.closePx.toFixed(2)}，拉升${kcbRally.rallyPct.toFixed(2)}%`);
    }

    if (isHighOpen) {
      return {
        strategyId: 'prev_day_tail_rally',
        title: '📊 前一日尾盘拉升，今日高开需持续观察',
        description: `前一日（${prevDate}）${hitDetails.join('；')}。今日竞价高开${openChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} > 前日收盘${prevClose.toFixed(2)}），需要持续观察，可能高开低走，也可能是高举高打，概率五五开。`,
        severity: 'medium',
        isBullish: true
      };
    } else {
      return {
        strategyId: 'prev_day_tail_rally',
        title: '⚠️ 前一日尾盘拉升，今日低开大概率下跌',
        description: `前一日（${prevDate}）${hitDetails.join('；')}。今日竞价低开${openChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} < 前日收盘${prevClose.toFixed(2)}），当日大概率低开低走大阴线，情况不对要赶快清仓！`,
        severity: 'high',
        isBullish: false
      };
    }
  } catch (e) {
    console.error('[strategy] 策略11检测失败:', e.message);
  }
  return null;
};

// Strategy 12: 资金流入+指数上涨+严重缩量（量价背离，容易冲高回落）
const checkStrategy12_InflowRiseVolumeShrink = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 仅在交易时段检测（9:30-11:30, 13:00-15:00），午休时间不算
  if (timeVal < 9 * 60 + 30 || (timeVal > 11 * 60 + 30 && timeVal < 13 * 60) || timeVal > 15 * 60) {
    return null;
  }

  // 每隔10分钟检测一次（10分钟冷却）
  const lastTriggered = state.inflow_rise_volume_shrink?.lastTriggeredTime;
  if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 10) return null;

  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 2) return null;

    const currItem = amountHistory[amountHistory.length - 1];
    const now10minAgo = now.subtract(10, 'minute').format('HHmmss');

    let tenMinAgoItem = null;
    for (let i = amountHistory.length - 2; i >= 0; i--) {
      if (amountHistory[i][0] <= now10minAgo) {
        tenMinAgoItem = amountHistory[i];
        break;
      }
    }
    if (!tenMinAgoItem) return null;

    // 防止跨午休比较：若10min前快照实际距当前超过15分钟，跳过
    const parseTotalMin = (t) => parseInt(t.substring(0, 2), 10) * 60 + parseInt(t.substring(2, 4), 10);
    const currMin = parseTotalMin(currItem[0]);
    const prevMin = parseTotalMin(tenMinAgoItem[0]);
    if (currMin - prevMin > 15) return null;

    const currMainMoney = parseAmountToYi(currItem[1].mainMoney);
    const prevMainMoney = parseAmountToYi(tenMinAgoItem[1].mainMoney);
    const currAmountDiff = parseAmountToYi(currItem[1].amountChangeDiff);
    const prevAmountDiff = parseAmountToYi(tenMinAgoItem[1].amountChangeDiff);

    // 条件1：主力资金净流入较10min前增加 ≥ 5亿
    const fundIncrease = currMainMoney - prevMainMoney;
    if (fundIncrease < 5) return null;

    // 条件3：成交量较10min前增加 ≤ 50亿（没有大于50亿）
    const amountIncrease = currAmountDiff - prevAmountDiff;
    if (amountIncrease > 50) return null;

    // 条件4：当前成交量差值 < -500亿（严重缩量）
    if (currAmountDiff >= -500) return null;

    // 条件2：创业板或科创板指数较10min前上涨（任一满足即可）
    const cybLine = await getIndexTline('sz399006');
    const kcbLine = await getIndexTline('sh000688');

    const findIndex10minChange = (line) => {
      if (!line || line.length === 0) return null;
      const curr = line[line.length - 1];
      if (!curr || !curr.last_px || curr.minute == null) return null;
      const currTotalMin = Math.floor(curr.minute / 100) * 60 + (curr.minute % 100);
      let prev = null;
      for (let i = line.length - 2; i >= 0; i--) {
        const prevTotalMin = Math.floor(line[i].minute / 100) * 60 + (line[i].minute % 100);
        const gap = currTotalMin - prevTotalMin;
        if (gap >= 9) {
          if (gap <= 15) prev = line[i];
          break;
        }
      }
      if (!prev || !prev.last_px) return null;
      return ((curr.last_px - prev.last_px) / prev.last_px) * 100;
    };

    const cybChange = findIndex10minChange(cybLine);
    const kcbChange = findIndex10minChange(kcbLine);
    const indexUp = (cybChange !== null && cybChange > 0) || (kcbChange !== null && kcbChange > 0);

    if (!indexUp) return null;

    const idxName = (cybChange !== null && cybChange > 0) ? '创业板' : '科创板';
    const risePct = Math.max(cybChange || 0, kcbChange || 0);

    return {
      strategyId: 'inflow_rise_volume_shrink',
      title: '⚠️ 资金流入&指数上涨但严重缩量-量价背离',
      description: `资金虽然持续净流入&指数配合上涨，但是量能萎缩严重，量价背离，容易冲高回落，切勿追高。<br/>• 主力资金净流入${prevMainMoney.toFixed(1)}→${currMainMoney.toFixed(1)}亿（增加${fundIncrease.toFixed(1)}亿，≥5亿）<br/>• ${idxName}指较10分钟前上涨${risePct.toFixed(2)}%<br/>• 成交量差值${currAmountDiff.toFixed(0)}亿（<-500亿严重缩量），较10分钟前仅增加${amountIncrease.toFixed(0)}亿（≤50亿）`,
      severity: 'high',
      isBullish: false
    };
  } catch (e) {
    console.error('[strategy] 策略12检测失败:', e.message);
  }
  return null;
};

// Strategy 13: 隔夜危机跑路
// 隔夜重大危机（美股暴跌/战争/关税利空等）下，开盘科技股直线拉升但主力资金净流出，量价背离，冲高清仓机会
const checkStrategy13_OvernightCrisisEscape = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 检测时段：9:30 - 10:00
  if (timeVal < 9 * 60 + 30 || timeVal > 10 * 60) return null;

  const nowStr = now.format('YYYY-MM-DD HH:mm:ss');
  const state13 = state.overnight_crisis_escape || {};

  // 每隔2分钟检测一次（用 lastCheckedTime 控制，避免每分钟都跑检测逻辑）
  const lastCheckedTime = state13.lastCheckedTime;
  if (lastCheckedTime && now.diff(dayjs(lastCheckedTime), 'second') < 110) return null;

  // 标记本次检测时间（由 pollOnce 末尾统一 writeState 持久化）
  state.overnight_crisis_escape = { ...state13, lastCheckedTime: nowStr };

  // 触发后30分钟冷却
  const lastTriggered = state13.lastTriggeredTime;
  if (lastTriggered && now.diff(dayjs(lastTriggered), 'minute') < 30) return null;

  try {
    // 1. 大盘资金净流出（当前主力资金净流入为负）
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length === 0) return null;

    const currItem = amountHistory[amountHistory.length - 1];
    const currMainMoney = parseAmountToYi(currItem[1].mainMoney);

    if (currMainMoney >= 0) return null;

    // 2. 科技分时情绪在上升（相较约5分钟前）
    const { getTechEmotionIntraday } = require('./emotion');
    const { data: intradayData } = getTechEmotionIntraday();
    const today = now.format('YYYYMMDD');
    const todayIntraday = intradayData[today] || [];
    if (todayIntraday.length < 2) return null;

    const sorted = [...todayIntraday].sort((a, b) => a.time.localeCompare(b.time));
    const currEmotion = sorted[sorted.length - 1].value;

    // 找约5分钟前的情绪快照作为对比基准
    const nowMinus5Min = now.subtract(5, 'minute').format('HHmm');
    let prevEmotion = null;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i].time <= nowMinus5Min) {
        prevEmotion = sorted[i].value;
        break;
      }
    }
    if (prevEmotion === null || prevEmotion === undefined) return null;

    // 科技分时情绪在上升
    const emotionRise = currEmotion - prevEmotion;
    if (emotionRise <= 0) return null;

    // 命中策略：更新 lastTriggeredTime
    state.overnight_crisis_escape.lastTriggeredTime = nowStr;

    return {
      strategyId: 'overnight_crisis_escape',
      title: '⚠️ 隔夜危机跑路-冲高清仓机会',
      description: `隔夜危机背景下，开盘科技股直线拉升，但主力资金持续净流出，量价背离，是冲高清仓的机会。<br/>• 主力资金净流入 <strong>${currMainMoney.toFixed(1)}亿</strong>（净流出）<br/>• 科技分时情绪 ${prevEmotion.toFixed(1)} → ${currEmotion.toFixed(1)}（上升 ${emotionRise.toFixed(1)}）<br/>• 当前为科技股虚拉、主力资金出货，建议冲高清仓避险`,
      severity: 'high',
      isBullish: false
    };
  } catch (e) {
    console.error('[strategy] 策略13检测失败:', e.message);
  }
  return null;
};

// Strategy 14: 退潮直接反转
// 前一日创业板指或科创50大跌超过-2%，次日直接反转概率仅23%，提示不要追涨
const checkStrategy14_EbbTideDirectReversal = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 仅在 9:30-9:35 窗口检测
  if (timeVal < 9 * 60 + 30 || timeVal > 9 * 60 + 35) return null;

  // 当天已触发过则跳过
  const state14 = state.ebb_tide_direct_reversal || {};
  if (state14.triggeredToday === now.format('YYYY-MM-DD')) return null;

  try {
    const indexKlineData = await getAllIndexKlineData();
    const parsePrevDayChange = (rawData, name) => {
      const kline = (rawData || [])
        .filter(k => k.trade_date)
        .sort((a, b) => parseInt(a.trade_date) - parseInt(b.trade_date));
      if (kline.length < 2) return null;
      // 最后一条为今日，倒数第二条为前一日
      const yesterdayChange = parseFloat(kline[kline.length - 2].change);
      if (isNaN(yesterdayChange)) return null;
      return { name, yesterdayChange };
    };

    const cyb = parsePrevDayChange(indexKlineData.chuangyebanData, '创业板指');
    const kcb = parsePrevDayChange(indexKlineData.kechuangbanData, '科创50');
    if (!cyb && !kcb) return null;

    const hits = [];
    if (cyb && cyb.yesterdayChange <= -2) hits.push(cyb);
    if (kcb && kcb.yesterdayChange <= -2) hits.push(kcb);
    if (hits.length === 0) return null;

    const hitDetails = hits.map(h => `${h.name}前一日涨跌幅 ${h.yesterdayChange.toFixed(2)}%`).join('，');
    const hitNames = hits.map(h => h.name).join('/');

    return {
      strategyId: 'ebb_tide_direct_reversal',
      title: '⚠️ 退潮直接反转概率低，切勿追涨',
      description: `${hitDetails}。<br/>${hitNames}前一个交易日大跌超过-2%，次日直接反转的概率只有 <strong>23%</strong>，不要追涨！就算参与只能 <strong>1/3 仓位</strong>参与。`,
      severity: 'high',
      isBullish: false
    };
  } catch (e) {
    console.error('[strategy] 策略14检测失败:', e.message);
  }
  return null;
};

// Strategy 15: 开盘资金净流入
// 9:35 检测一次，判断 9:30-9:35 开盘前5分钟的大盘主力资金净流动方向
const checkStrategy15_OpeningNetInflow = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;

  // 仅在 9:35 前后短窗口检测一次（用2分钟窗口避免轮询错过 9:35 整点）
  if (timeVal < 9 * 60 + 35 || timeVal > 9 * 60 + 37) return null;

  // 当天已触发过则跳过
  const state15 = state.opening_net_inflow || {};
  if (state15.triggeredToday === now.format('YYYY-MM-DD')) return null;

  try {
    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 2) return null;

    // 第一条即约 9:30 开盘快照（getAmountHistory 只返回交易时段数据）
    const baseItem = amountHistory[0];
    const currItem = amountHistory[amountHistory.length - 1];

    const baseMoney = parseFloat(baseItem?.[1]?.mainMoney);
    const currMoney = parseFloat(currItem?.[1]?.mainMoney);
    if (isNaN(baseMoney) || isNaN(currMoney)) return null;

    // 开盘5分钟净流入 = 9:35 主力资金累计净流入 - 9:30 开盘累计净流入（负数为净流出）
    const netFlow = currMoney - baseMoney;

    // 标记当天已触发（无论是否命中，9:35 只判定一次）
    state.opening_net_inflow = { triggeredToday: now.format('YYYY-MM-DD') };

    // 净流出 > 60亿 → 风险卡片（此时 netFlow 恒为负）
    if (netFlow < -60) {
      return {
        strategyId: 'opening_net_inflow',
        title: '🚨 开盘大幅资金出逃-谨防大跌',
        description: `开盘 5min 资金净流出 <strong>${Math.abs(netFlow).toFixed(1)}亿</strong>，按照历史规律，当天大概率大盘要大幅下跌，谨慎出手。`,
        severity: 'high',
        isBullish: false
      };
    }

    // 净流出 ≤ 10亿（含小幅流出与净流入）→ 利好卡片（按净流入/净流出区分文案）
    if (netFlow >= -10) {
      const isInflow = netFlow >= 0;
      const label = isInflow ? '净流入' : '净流出';
      const value = `${isInflow ? '+' : ''}${Math.abs(netFlow).toFixed(1)}亿`;
      return {
        strategyId: 'opening_net_inflow',
        title: '✅ 开盘资金未明显流出-市场或有回暖',
        description: `开盘 5min 资金${label} <strong>${value}</strong>，按照历史规律，当天大概率大盘会回暖，可以适当出手。`,
        severity: 'medium',
        isBullish: true
      };
    }

    return null;
  } catch (e) {
    console.error('[strategy] 策略15检测失败:', e.message);
  }
  return null;
};

// Strategy 16: 高开高走
// 9:30 开盘提示：创业板指/科创50高开>0.5% 且 科技情绪指数≥30 → 提示 9:40 之前不要出手
// 9:41 确认检测：指数距最高点回落≤0.5% + 资金持续净流入 + 9:30-9:35、9:35-9:40 两波流入各≥10亿
const HIGH_OPEN_HIGH_WALK_ADVISORY = '高开高走需要满足 9:40 之前指数持续上攻 & 资金持续净流入，当然有量能放大配合最好，如果量能不放大，前一日必须要满足情绪冰点。所以在 9:40 之前不要出手，等 9:40 之后出手即可，当日买入一般能有 3-4 个点的利润垫。';

// 从指数分时数据计算开盘涨幅（开盘价 vs 昨收）
const getIndexOpenChange = (tlineData) => {
  if (!tlineData || !tlineData.preclose_px || !Array.isArray(tlineData.line) || tlineData.line.length === 0) return null;
  const preclose = parseFloat(tlineData.preclose_px);
  if (!preclose || preclose <= 0) return null;
  const line = tlineData.line
    .filter(p => p.minute != null && p.last_px)
    .map(p => ({ minute: p.minute, last_px: parseFloat(p.last_px) }))
    .filter(p => !isNaN(p.last_px))
    .sort((a, b) => a.minute - b.minute);
  if (line.length === 0) return null;
  const openPoint = line.find(p => p.minute >= 930 && p.minute < 935) || line[0];
  return ((openPoint.last_px - preclose) / preclose) * 100;
};

// 找 amountHistory 中不晚于 limitTime（HHmmss）的最近一条快照
const findAmountAtOrBefore = (amountHistory, limitTime) => {
  let found = null;
  for (const item of amountHistory) {
    if (item[0] <= limitTime) found = item;
    else break;
  }
  return found;
};

const checkStrategy16_HighOpenHighWalk = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;
  const today = now.format('YYYY-MM-DD');

  const state16 = state.high_open_high_walk || {};
  const { getSingleStockTlineData } = require('./stock');

  // ===== 阶段1：9:30 开盘提示（9:30-9:31 窗口内检测一次）=====
  if (timeVal >= 9 * 60 + 30 && timeVal <= 9 * 60 + 31 && state16.advisoryToday !== today) {
    try {
      const [cybTline, kcbTline] = await Promise.all([
        getSingleStockTlineData('sz399006'),
        getSingleStockTlineData('sh000688'),
      ]);
      const cybOpenChange = getIndexOpenChange(cybTline);
      const kcbOpenChange = getIndexOpenChange(kcbTline);

      // 数据未就绪则不标记，窗口内下分钟重试
      if (cybOpenChange !== null || kcbOpenChange !== null) {
        const hitIndexes = [];
        if (cybOpenChange !== null && cybOpenChange > 0.5) hitIndexes.push({ code: 'sz399006', name: '创业板指', openChange: cybOpenChange });
        if (kcbOpenChange !== null && kcbOpenChange > 0.5) hitIndexes.push({ code: 'sh000688', name: '科创50', openChange: kcbOpenChange });

        const emotion = getLatestTechEmotion();
        const emotionOk = emotion !== null && emotion >= 30;
        const preconditionMet = hitIndexes.length > 0 && emotionOk;

        // 当日只评估一次（9:41 检测依赖此前置条件）
        state.high_open_high_walk = {
          ...state16,
          advisoryToday: today,
          preconditionMet,
          triggerIndexCode: hitIndexes.length > 0 ? hitIndexes[0].code : null,
          triggerIndexName: hitIndexes.length > 0 ? hitIndexes[0].name : null,
        };

        if (preconditionMet) {
          const openDesc = hitIndexes.map(i => `<strong>${i.name}</strong>高开 <strong>+${i.openChange.toFixed(2)}%</strong>`).join('、');
          return {
            strategyId: 'high_open_high_walk',
            title: '📈 高开高走观察-9:40之前不要出手',
            description: `9:30 开盘：${openDesc}（>0.5%），科技情绪指数 <strong>${emotion.toFixed(1)}</strong>（≥30）。<br/>${HIGH_OPEN_HIGH_WALK_ADVISORY}`,
            severity: 'medium',
            isBullish: true
          };
        }
      }
    } catch (e) {
      console.error('[strategy] 策略16开盘提示检测失败:', e.message);
    }
    return null;
  }

  // ===== 阶段2：9:41 确认检测（9:41-9:42 窗口内检测一次，前置条件满足才进行）=====
  if (timeVal >= 9 * 60 + 41 && timeVal <= 9 * 60 + 42 && state16.checkedToday !== today) {
    // 前置条件未满足，当日不再检测
    if (!state16.preconditionMet || !state16.triggerIndexCode) {
      state.high_open_high_walk = { ...state16, checkedToday: today };
      return null;
    }

    try {
      const indexCode = state16.triggerIndexCode;
      const indexName = state16.triggerIndexName || (indexCode === 'sz399006' ? '创业板指' : '科创50');

      // 条件1：指数当前价距当日最高点回落 ≤ 0.5%
      const tlineData = await getSingleStockTlineData(indexCode);
      const line = (tlineData?.line || [])
        .filter(p => p.minute != null && p.last_px)
        .map(p => ({ minute: p.minute, last_px: parseFloat(p.last_px) }))
        .filter(p => !isNaN(p.last_px))
        .sort((a, b) => a.minute - b.minute);
      const points = line.filter(p => p.minute >= 930 && p.minute <= 940);
      if (points.length === 0) return null;

      const highPx = Math.max(...points.map(p => p.last_px));
      const currPx = points[points.length - 1].last_px;
      const preclose = parseFloat(tlineData?.preclose_px) || null;
      const pullback = ((highPx - currPx) / highPx) * 100;
      const pullbackOk = pullback <= 0.5;
      const currChange = preclose ? ((currPx - preclose) / preclose) * 100 : null;

      // 条件2&3：资金持续净流入 + 9:30-9:35、9:35-9:40 两波净流入均≥10亿
      const amountHistory = require('./amount').getAmountHistory();
      if (!amountHistory || amountHistory.length < 2) return null;

      const baseItem = amountHistory[0]; // 约 9:30 开盘快照
      const f935Item = findAmountAtOrBefore(amountHistory, '093559');
      const f940Item = findAmountAtOrBefore(amountHistory, '094059'); // 约 9:40 快照（9:41 检测时该窗口刚结束）
      if (!baseItem || !f935Item || !f940Item) return null;

      const baseMoney = parseFloat(baseItem[1].mainMoney);
      const f935Money = parseFloat(f935Item[1].mainMoney);
      const f940Money = parseFloat(f940Item[1].mainMoney);
      if (isNaN(baseMoney) || isNaN(f935Money) || isNaN(f940Money)) return null;

      const flow1 = f935Money - baseMoney; // 9:30-9:35 净流入
      const flow2 = f940Money - f935Money; // 9:35-9:40 净流入
      const netInflowOk = f940Money > 0;
      const flow1Ok = flow1 >= 10;
      const flow2Ok = flow2 >= 10;

      const hit = pullbackOk && netInflowOk && flow1Ok && flow2Ok;

      // 检测成功，当日不再重复
      state.high_open_high_walk = { ...state16, checkedToday: today };

      if (hit) {
        const amountDiff = parseFloat(f940Item[1].amountChangeDiff);
        return {
          strategyId: 'high_open_high_walk',
          title: '✅ 命中高开高走-可以出手',
          description: `命中高开高走，可以出手。当天资金净流入 <strong>${f940Money.toFixed(1)}亿</strong>，${indexName}上涨 <strong>${currChange !== null ? currChange.toFixed(2) + '%' : '-'}</strong>，量能 <strong>${isNaN(amountDiff) ? '-' : amountDiff.toFixed(0) + '亿'}</strong>（amountChangeDiff 值）。<br/>确认明细：${indexName}距最高点回落 ${pullback.toFixed(2)}%（≤0.5%），9:30-9:35 流入 ${flow1.toFixed(1)}亿（≥10亿），9:35-9:40 流入 ${flow2.toFixed(1)}亿（≥10亿）。`,
          severity: 'high',
          isBullish: true
        };
      }

      const failed = [];
      if (!pullbackOk) failed.push(`${indexName}距最高点回落 ${pullback.toFixed(2)}%（>0.5%）`);
      if (!netInflowOk) failed.push(`当天主力资金净流出 ${Math.abs(f940Money).toFixed(1)}亿`);
      if (!flow1Ok) failed.push(`9:30-9:35 流入仅 ${flow1.toFixed(1)}亿（<10亿）`);
      if (!flow2Ok) failed.push(`9:35-9:40 流入仅 ${flow2.toFixed(1)}亿（<10亿）`);

      return {
        strategyId: 'high_open_high_walk',
        title: '⚠️ 未命中高开高走-不适合出手',
        description: `当前没有满足高开高走的条件，极易高低开走或者是冲高回落，不适合出手。<br/>未满足项：${failed.join('；')}`,
        severity: 'medium',
        isBullish: false
      };
    } catch (e) {
      console.error('[strategy] 策略16确认检测失败:', e.message);
    }
    return null;
  }

  return null;
};

// Strategy 17: 尾盘抄底（14:30 检测一次）
// 条件：当前科技情绪指数 < 0 且 当前 amountChangeDiff 相较 14:00 放大 ≥ 50亿 且 创业板指 14:30 涨幅 < 14:00 涨幅
// → 尾盘抄底，博弈次日反弹
const checkStrategy17_TailDipBuying = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;
  const today = now.format('YYYY-MM-DD');

  const state17 = state.tail_dip_buying || {};
  // 14:30-14:35 窗口内检测一次（数据缺失时窗口内下分钟重试）
  if (timeVal < 14 * 60 + 30 || timeVal > 14 * 60 + 35 || state17.checkedToday === today) {
    return null;
  }

  try {
    const emotion = getLatestTechEmotion();

    // 情绪指数不满足弱势条件，当日不再检测
    if (emotion !== null && emotion >= 0) {
      state.tail_dip_buying = { ...state17, checkedToday: today };
      return null;
    }

    const amountHistory = require('./amount').getAmountHistory();
    if (!amountHistory || amountHistory.length < 2) return null;

    const amount1400 = findAmountAtOrBefore(amountHistory, '140059');
    const latestItem = amountHistory[amountHistory.length - 1];
    if (!amount1400 || !latestItem) return null;

    const diff1400 = parseFloat(amount1400[1].amountChangeDiff);
    const diffNow = parseFloat(latestItem[1].amountChangeDiff);
    if (isNaN(diff1400) || isNaN(diffNow)) return null;

    // 附加条件：创业板指 14:30 涨幅必须小于 14:00 涨幅（尾盘涨幅回落）
    const { getSingleStockTlineData } = require('./stock');
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
    const cybChangeNow = getCybChangeAt(1435);
    const cybChange1400 = getCybChangeAt(1400);
    // 分时数据缺失，窗口内下分钟重试
    if (cybChangeNow === null || cybChange1400 === null) return null;

    // 检测完成，当日不再重复
    state.tail_dip_buying = { ...state17, checkedToday: today };

    const surge = diffNow - diff1400;
    if (emotion !== null && surge >= 50 && cybChangeNow < cybChange1400) {
      const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      return {
        strategyId: 'tail_dip_buying',
        title: '✅ 尾盘抄底机会',
        description: `全天科技情绪弱势（科技情绪指数 <strong>${emotion.toFixed(1)}</strong>，-70 ≤ 情绪 < 0），尾盘半小时放量：14:00 量能 <strong>${diff1400.toFixed(0)}亿</strong> → 当前 <strong>${diffNow.toFixed(0)}亿</strong>，放量 <strong>${surge.toFixed(0)}亿</strong>（≥50亿），创业板指涨幅回落（14:00 ${fmt(cybChange1400)} → 14:30 ${fmt(cybChangeNow)}）。全天科技情绪弱势，尾盘半小时放量，适合尾盘抄底，博弈次日的反弹。`,
        severity: 'high',
        isBullish: true
      };
    }
  } catch (e) {
    console.error('[strategy] 策略17尾盘抄底检测失败:', e.message);
  }
  return null;
};

// Strategy 18: 高开最多半仓
// 9:30 开盘检测：创业板指 或 科创50 高开超过 0.5% 即触发
const checkStrategy18_HighOpenMaxHalfPosition = async (state) => {
  const now = dayjs();
  const hour = now.hour();
  const minute = now.minute();
  const timeVal = hour * 60 + minute;
  const today = now.format('YYYY-MM-DD');

  // 9:30-9:31 窗口内检测一次（数据缺失时下分钟重试）
  if (timeVal < 9 * 60 + 30 || timeVal > 9 * 60 + 31) return null;

  const state18 = state.high_open_max_half_position || {};
  if (state18.triggeredToday === today) return null;

  try {
    const { getSingleStockTlineData } = require('./stock');
    const [cybTline, kcbTline] = await Promise.all([
      getSingleStockTlineData('sz399006'),
      getSingleStockTlineData('sh000688'),
    ]);
    const cybOpenChange = getIndexOpenChange(cybTline);
    const kcbOpenChange = getIndexOpenChange(kcbTline);

    // 数据未就绪则不标记，窗口内下分钟重试
    if (cybOpenChange !== null || kcbOpenChange !== null) {
      const hitIndexes = [];
      if (cybOpenChange !== null && cybOpenChange > 0.5) hitIndexes.push({ name: '创业板指', openChange: cybOpenChange });
      if (kcbOpenChange !== null && kcbOpenChange > 0.5) hitIndexes.push({ name: '科创50', openChange: kcbOpenChange });
      state.high_open_max_half_position = { triggeredToday: today };

      if (hitIndexes.length > 0) {
        const openDesc = hitIndexes.map(i => `${i.name}高开 +${i.openChange.toFixed(2)}%`).join('、');
        return {
          strategyId: 'high_open_max_half_position',
          title: '⚠️ 高开最多半仓',
          description: `9:30 开盘 ${openDesc}（>0.5%）。\n大A惯例高开容易低走，此时如果开盘想要加仓，最多只能买单半仓，分摊到两个个股身上就是各自1/4仓位。最后等到收盘的时候再视情况是否要把剩下的仓位加上。`,
          severity: 'high',
          isBullish: false,
        };
      }
    }
  } catch (e) {
    console.error('[strategy] 策略18高开最多半仓检测失败:', e.message);
  }
  return null;
};

const pollOnce = async () => {
  if (!isTradingHours()) return;
  
  const now = dayjs();
  const nowStr = now.format('YYYY-MM-DD HH:mm:ss');
  const state = readState();
  const newSignals = [];

  const s1 = checkStrategy1_HighOpenLowClose(state);
  if (s1) {
    newSignals.push(s1);
    state.high_open_low_close = { lastTriggered: now.format('YYYY-MM-DD') };
  }

  const s2 = await checkStrategy2_VShapeReversal(state);
  if (s2) {
    newSignals.push(s2);
    state.v_shape_reversal = { 
      lastTriggeredTime: nowStr,
      triggeredToday: now.format('YYYY-MM-DD')
    };
  }

  const s3 = await checkStrategy3_VolumeShrinkStagnation(state);
  if (s3) {
    newSignals.push(s3);
    state.volume_shrink_stagnation = { lastTriggeredTime: nowStr };
  }

  const s4 = await checkStrategy4_OutflowFakeRally(state);
  if (s4) {
    newSignals.push(s4);
    state.outflow_fake_rally = { lastTriggeredTime: nowStr };
  }

  const s5 = checkStrategy5_LowOpenWashRecovery(state);
  if (s5) {
    newSignals.push(s5);
    state.low_open_wash_recovery = { triggeredToday: now.format('YYYY-MM-DD') };
  }

  const s6 = await checkStrategy6_StraightRiseNoVolume(state);
  if (s6) {
    newSignals.push(s6);
    state.straight_rise_no_volume = { lastTriggeredTime: nowStr };
  }

  const s7 = await checkStrategy7_VolumePriceSurge(state);
  if (s7) {
    newSignals.push(s7);
    state.volume_price_surge = { lastTriggeredTime: nowStr };
  }

  const s8 = await checkStrategy8_PanicOutflow(state);
  if (s8) {
    newSignals.push(s8);
    state.panic_outflow = { lastTriggeredTime: nowStr };
  }

  const s9 = await checkStrategy9_PrevDayHighOpenLowCloseVolume(state);
  if (s9) {
    newSignals.push(s9);
    state.prev_day_high_open_low_close_volume = { triggeredToday: now.format('YYYY-MM-DD') };
  }

  const s10 = await checkStrategy10_PrevDayVolumePriceBottom(state);
  if (s10) {
    newSignals.push(s10);
    state.prev_day_volume_price_bottom = { triggeredToday: now.format('YYYY-MM-DD') };
  }

  const s11 = await checkStrategy11_PrevDayTailRally(state);
  if (s11) {
    newSignals.push(s11);
    state.prev_day_tail_rally = { triggeredToday: now.format('YYYY-MM-DD') };
  }

  const s12 = await checkStrategy12_InflowRiseVolumeShrink(state);
  if (s12) {
    newSignals.push(s12);
    state.inflow_rise_volume_shrink = { lastTriggeredTime: nowStr };
  }

  const s13 = await checkStrategy13_OvernightCrisisEscape(state);
  if (s13) {
    newSignals.push(s13);
  }

  const s14 = await checkStrategy14_EbbTideDirectReversal(state);
  if (s14) {
    newSignals.push(s14);
    state.ebb_tide_direct_reversal = { triggeredToday: now.format('YYYY-MM-DD') };
  }

  const s15 = await checkStrategy15_OpeningNetInflow(state);
  if (s15) {
    newSignals.push(s15);
  }

  const s16 = await checkStrategy16_HighOpenHighWalk(state);
  if (s16) {
    newSignals.push(s16);
  }

  const s17 = await checkStrategy17_TailDipBuying(state);
  if (s17) {
    newSignals.push(s17);
  }

  const s18 = await checkStrategy18_HighOpenMaxHalfPosition(state);
  if (s18) {
    newSignals.push(s18);
  }

  // 始终写入 state（用于持久化策略13的 lastCheckedTime 等检测间隔状态）
  writeState(state);

  if (newSignals.length > 0) {
    const records = readRecords();
    const oneMinuteAgo = now.subtract(1, 'minute');
    
    for (const signal of newSignals) {
      const isDuplicate = records.some(r => 
        r.strategyId === signal.strategyId && 
        dayjs(r.time).isAfter(oneMinuteAgo)
      );
      
      if (!isDuplicate) {
        records.push({
          id: genId(),
          time: nowStr,
          read: false,
          ...signal
        });
        console.log(`[strategy] 策略触发: ${signal.title}`);
      }
    }
    
    const cutoff = now.subtract(STRATEGY_RETENTION_HOURS, 'hour');
    const filtered = records.filter(r => r && r.time && dayjs(r.time).isAfter(cutoff));
    writeRecords(filtered);
  }
};

let pollingStarted = false;

const startStrategyPolling = () => {
  if (pollingStarted) return;
  pollingStarted = true;
  console.log('[strategy] 策略中心轮询已启动');
  
  cleanupRecords();
  
  const poll1Min = async () => {
    try {
      await pollOnce();
    } catch (e) {
      console.error('[strategy] 轮询执行失败:', e.message);
    }
    setTimeout(poll1Min, POLL_INTERVAL_1MIN);
  };
  
  poll1Min();
};

const getStrategyRecords = () => {
  return cleanupRecords();
};

const markStrategyRead = (id) => {
  const records = readRecords();
  let changed = false;
  for (const r of records) {
    if (r && r.id === id && r.read !== true) {
      r.read = true;
      changed = true;
      break;
    }
  }
  if (changed) writeRecords(records);
  return changed;
};

const markAllStrategiesRead = () => {
  const records = readRecords();
  let changed = false;
  for (const r of records) {
    if (r && r.read !== true) {
      r.read = true;
      changed = true;
    }
  }
  if (changed) writeRecords(records);
  return changed;
};

const getStrategyDefinitions = () => {
  return Object.values(STRATEGY_DEFINITIONS);
};

module.exports = {
  startStrategyPolling,
  getStrategyRecords,
  markStrategyRead,
  markAllStrategiesRead,
  getStrategyDefinitions,
};
