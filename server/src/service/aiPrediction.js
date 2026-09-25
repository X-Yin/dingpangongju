// AI 分时图预测服务：基于 Kronos 模型预测指数下一日分时走势
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const { getSingleStockTlineDataByDate, getSingleStockData } = require('./stock');
const { getAvailableDates: getSnapshotAvailableDates, getFundSnapshot, getAmountSnapshot, aggregateByInterval } = require('./fundSnapshot');
const { getAmountHistory } = require('./amount');
const { getActiveProvider, getHeaders, buildRequestBody } = require('../utils/aiProvider');

// Python 解释器与脚本路径
const PYTHON_BIN = path.resolve(__dirname, '../../../AI/Kronos/venv/bin/python');
const PREDICT_SCRIPT = path.resolve(__dirname, '../../../AI/predict.py');

// 支持的指数
const INDEX_OPTIONS = [
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000688', name: '科创50' },
];

// 把 1 分钟 tline 数据聚合成 5 分钟 K 线
function bucketStartOf(minute) {
  if (minute >= 930 && minute <= 1130) {
    return Math.min(930 + 5 * Math.floor((minute - 930) / 5), 1125);
  }
  if (minute >= 1300 && minute <= 1500) {
    return Math.min(1300 + 5 * Math.floor((minute - 1300) / 5), 1455);
  }
  return null;
}

function aggregateTlineTo5Min(line, dateStr) {
  if (!line || !Array.isArray(line) || line.length === 0) return [];
  const buckets = new Map(); // bucketStart -> {open,high,low,close,volume,amount,minute}
  for (const item of line) {
    const minute = item.minute;
    if (minute == null) continue;
    const px = item.last_px || item.av_px;
    if (px == null) continue;
    const bs = bucketStartOf(minute);
    if (bs == null) continue;
    let b = buckets.get(bs);
    if (!b) {
      b = { open: px, high: px, low: px, close: px, volume: 0, amount: 0, bucketStart: bs };
      buckets.set(bs, b);
    }
    b.open = b.open; // 第一条作为 open
    b.high = Math.max(b.high, px);
    b.low = Math.min(b.low, px);
    b.close = px; // 最后一条覆盖
    b.volume += (item.business_amount || 0);
    b.amount += (item.business_balance || 0);
  }
  // 按桶起始时间排序输出
  const sorted = [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  return sorted.map(b => {
    const hh = String(Math.floor(b.bucketStart / 100)).padStart(2, '0');
    const mm = String(b.bucketStart % 100).padStart(2, '0');
    return {
      timestamp: `${dateStr} ${hh}:${mm}:00`,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      amount: b.amount,
    };
  });
}

// 计算下一个交易日（以交易日历为准，自动跳过周末与法定节假日；未覆盖年份回退为跳过周末）
const tradingDayUtil = require('../utils/tradingDay');
function nextWeekday(dateStr) {
  const d = dayjs(dateStr, 'YYYYMMDD').toDate();
  return dayjs(tradingDayUtil.getNextTradingDay(d)).format('YYYYMMDD');
}

// 全天 48 个 5 分钟分时桶的 "HH:MM" 标签
const INTRADAY_MINUTES = (() => {
  const arr = [];
  for (let i = 0; i < 24; i++) {
    const m = 570 + 5 * i; // 09:30 ~ 11:25
    arr.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  for (let i = 0; i < 24; i++) {
    const m = 780 + 5 * i; // 13:00 ~ 14:55
    arr.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return arr;
})();

// 获取目标日期之前的 N 个真实交易日（通过 K 线数据判定，自动跳过周末/节假日）
async function getPrevTradingDays(targetDate, indexCode, n = 5) {
  // 拉取最近 60 个交易日的日 K 线，足够覆盖近期回测目标日
  const kline = await getSingleStockData(indexCode, 60);
  const dates = kline
    .map(k => String(k.trade_date))
    .filter(d => d < targetDate)
    .sort((a, b) => b.localeCompare(a)) // 降序，最新在前
    .slice(0, n)
    .sort((a, b) => a.localeCompare(b)); // 升序，最旧在前（送入模型）
  return dates;
}

// 把分时桶聚合结果加上 minute 标签
function buildBarsWithMinute(line, dateStr) {
  return aggregateTlineTo5Min(line, dateStr).map(b => {
    // timestamp 格式: "YYYYMMDD HH:MM:00"，提取 "HH:MM"
    const timePart = (b.timestamp.split(' ')[1] || '').trim();
    return { ...b, minute: timePart.substring(0, 5) };
  });
}

// 根据「已走到的最后一根分钟」推算剩余待预测的分钟桶
function getRemainingMinutes(lastMinute) {
  if (!lastMinute) return [...INTRADAY_MINUTES];
  const idx = INTRADAY_MINUTES.indexOf(lastMinute);
  if (idx >= 0) return INTRADAY_MINUTES.slice(idx + 1);
  return INTRADAY_MINUTES.filter(m => m > lastMinute);
}

// 通用：前 N 日全天 + 目标日部分 K 线 → 预测目标日剩余分时
async function runPartialPrediction({ prevDates, targetDate, targetBars, indexCode, sampleCount, preclose }) {
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;

  const { history, usedDates } = await buildHistoryBars(prevDates, code);
  if (history.length < 10) {
    throw new Error(`历史 5 分钟 K 线数据不足(${history.length} 根)，请确认参考交易日数据完整`);
  }

  // 拼入目标日已走部分
  history.push(...targetBars);

  const lastMinute = targetBars.length > 0 ? targetBars[targetBars.length - 1].minute : null;
  const remainingMinutes = getRemainingMinutes(lastMinute);
  if (remainingMinutes.length === 0) {
    throw new Error('已到收盘时间，无可预测时段');
  }

  const payload = {
    history,
    pred_len: remainingMinutes.length,
    sample_count: sampleCount,
    predict_date: targetDate,
    preclose,
    predict_minutes: remainingMinutes,
  };

  console.log(`[aiPrediction] 部分日预测 ${code} ${opt.name}, 历史 ${history.length} 根(含目标日 ${targetBars.length}), 剩余 ${remainingMinutes.length} 桶, preclose=${preclose}, 采样 ${sampleCount}`);
  const result = await runPythonPredict(payload);
  if (!result || !result.success) {
    throw new Error(result?.message || '预测失败');
  }

  // 构造实际走势线（含涨幅）
  const actualLine = targetBars.map(b => ({
    minute: b.minute,
    last_px: +b.close.toFixed(4),
    change: preclose > 0 ? +(((b.close - preclose) / preclose) * 100).toFixed(2) : 0,
  }));

  return {
    indexCode: code,
    indexName: opt.name,
    historyDates: usedDates,
    predictDate: targetDate,
    preclose,
    sampleCount: result.sample_count,
    actualLine,
    trends: result.trends,
  };
}

// 实时预测：前 5 个交易日 + 当日已走部分 → 预测当日剩余
async function getRealtimePrediction(indexCode, sampleCount = 20) {
  const today = dayjs().format('YYYYMMDD');
  const prevDates = await getPrevTradingDays(today, indexCode, 5);
  if (prevDates.length < 5) {
    throw new Error(`历史交易日不足 5 天(仅 ${prevDates.length} 天)，无法实时预测`);
  }

  let todayTline;
  try {
    todayTline = await getSingleStockTlineDataByDate(indexCode, parseInt(today, 10));
  } catch (e) {
    console.error(`[aiPrediction] 获取当日 ${indexCode} ${today} 分时数据失败:`, e.message);
  }
  if (!todayTline || !todayTline.line || todayTline.line.length === 0) {
    throw new Error('当日分时数据暂不可用（非交易时段或数据未就绪）');
  }

  const preclose = todayTline.preclose_px || todayTline.line[0]?.preclose_px || 0;
  if (!preclose) throw new Error('无法获取昨收价');

  const targetBars = buildBarsWithMinute(todayTline.line, today);
  if (targetBars.length === 0) throw new Error('当日分时数据为空');
  if (targetBars.length >= 48) throw new Error('当日分时已完整，无需预测');

  return runPartialPrediction({
    prevDates,
    targetDate: today,
    targetBars,
    indexCode,
    sampleCount,
    preclose,
  });
}

// 回测预测：选择某交易日某时刻 → 预测当日剩余（输入仍含前 5 个交易日）
async function getBacktestPrediction(indexCode, targetDate, targetMinute, sampleCount = 20) {
  const prevDates = await getPrevTradingDays(targetDate, indexCode, 5);
  if (prevDates.length < 5) {
    throw new Error(`目标日期前历史交易日不足 5 天(仅 ${prevDates.length} 天)`);
  }

  let tline;
  try {
    tline = await getSingleStockTlineDataByDate(indexCode, parseInt(targetDate, 10));
  } catch (e) {
    console.error(`[aiPrediction] 获取 ${indexCode} ${targetDate} 分时数据失败:`, e.message);
  }
  if (!tline || !tline.line || tline.line.length === 0) {
    throw new Error('所选日期无分时数据');
  }

  console.log(`[aiPrediction] ${targetDate} tline: line=${tline.line.length} 根, preclose_px=${tline.preclose_px}, 首条=${JSON.stringify(tline.line[0])}`);

  const preclose = tline.preclose_px || tline.line[0]?.preclose_px || 0;
  if (!preclose) throw new Error('无法获取昨收价');

  const allBars = buildBarsWithMinute(tline.line, targetDate);
  console.log(`[aiPrediction] ${targetDate} 聚合后 allBars=${allBars.length} 根, 首分钟=${allBars[0]?.minute}, 末分钟=${allBars[allBars.length - 1]?.minute}`);

  if (allBars.length === 0) {
    throw new Error(`所选日期分时数据聚合后为空（原始 ${tline.line.length} 条，可能数据格式异常）`);
  }

  // 截取到 targetMinute（含）为止
  let cutoffIdx = allBars.findIndex(b => b.minute === targetMinute);
  if (cutoffIdx === -1) {
    cutoffIdx = -1;
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].minute > targetMinute) break;
      cutoffIdx = i;
    }
  }
  if (cutoffIdx < 0) {
    throw new Error(`所选时刻 ${targetMinute} 早于当日最早数据 ${allBars[0]?.minute}，请选择更晚的时刻`);
  }
  const targetBars = allBars.slice(0, cutoffIdx + 1);
  if (targetBars.length >= 48) throw new Error('所选时间已到收盘，无可预测时段');

  return runPartialPrediction({
    prevDates,
    targetDate,
    targetBars,
    indexCode,
    sampleCount,
    preclose,
  });
}

// 获取可用日期（复用 fundSnapshot 的日期列表）
function getAvailableDates() {
  return getSnapshotAvailableDates();
}

// 拉取多日指数分时数据并聚合成 5 分钟 K 线序列
async function buildHistoryBars(dates, indexCode) {
  // 升序排列
  const sortedDates = [...dates].sort((a, b) => a.localeCompare(b));
  const history = [];
  const usedDates = [];
  for (const dateStr of sortedDates) {
    const dateInt = parseInt(dateStr, 10);
    let tline;
    try {
      tline = await getSingleStockTlineDataByDate(indexCode, dateInt);
    } catch (e) {
      console.error(`[aiPrediction] 获取 ${indexCode} ${dateStr} 分时数据失败:`, e.message);
    }
    if (!tline || !tline.line || tline.line.length === 0) {
      console.warn(`[aiPrediction] ${indexCode} ${dateStr} 无分时数据，跳过`);
      continue;
    }
    const bars = aggregateTlineTo5Min(tline.line, dateStr);
    if (bars.length === 0) continue;
    history.push(...bars);
    usedDates.push(dateStr);
  }
  return { history, usedDates };
}

// 调用 Python 脚本执行预测
function runPythonPredict(payload, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [PREDICT_SCRIPT], {
      env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch (e) {}
      reject(new Error(`Python 预测超时 (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      // 实时打印进度
      process.stdout.write(`[predict] ${data.toString()}`);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`启动 Python 失败: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Python 进程退出码 ${code}\n${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (e) {
        reject(new Error(`解析 Python 输出失败: ${e.message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
    // 通过 stdin 传 JSON
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// 主入口：执行预测
async function getPrediction(dates, indexCode, sampleCount = 20) {
  if (!dates || !Array.isArray(dates) || dates.length === 0) {
    throw new Error('请至少选择一个历史日期');
  }
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;

  const { history, usedDates } = await buildHistoryBars(dates, code);
  if (history.length < 10) {
    throw new Error(`历史 5 分钟 K 线数据不足(${history.length} 根)，请选择包含完整分时数据的日期`);
  }

  const predictDate = nextWeekday(usedDates[usedDates.length - 1]);

  const payload = {
    history,
    pred_len: 48,
    sample_count: sampleCount,
    predict_date: predictDate,
  };

  console.log(`[aiPrediction] 开始预测 ${code} ${opt.name}, 历史 ${history.length} 根, 预测日 ${predictDate}, 采样 ${sampleCount}`);
  const result = await runPythonPredict(payload);
  if (!result || !result.success) {
    throw new Error(result?.message || '预测失败');
  }
  return {
    indexCode: code,
    indexName: opt.name,
    historyDates: usedDates,
    predictDate,
    preclose: result.preclose,
    sampleCount: result.sample_count,
    trends: result.trends,
  };
}

// 把快照时间 "HHMMSS" 转为 "HH:MM"
function snapshotTimeToHHMM(timeStr) {
  return timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4);
}

// 从实时数据（fundData 5分钟 / amountData 10分钟）构建今天的 48 桶 mainMoneys 和 amountChangeDiffs
// 未到的时刻为 null，无数据则对应字段为 null
function buildToday48FromRealtime(fundData, amountData) {
  let mainMoneys = null;
  let amountChangeDiffs = null;

  if (fundData && Array.isArray(fundData) && fundData.length > 0) {
    // fundData 为 5 分钟级别，直接按时间匹配到 48 桶
    const valueMap = {};
    fundData.forEach(d => { valueMap[snapshotTimeToHHMM(d.time)] = d.mainMoney; });
    mainMoneys = INTRADAY_MINUTES.map(m => {
      const v = valueMap[m];
      return v !== undefined && v !== null ? +v.toFixed(2) : null;
    });
    if (mainMoneys.every(v => v === null)) mainMoneys = null;
  }

  if (amountData && Array.isArray(amountData) && amountData.length > 0) {
    // amountData 为 10 分钟级别，线性插值到 48 桶
    amountChangeDiffs = interpolateSnapshotTo5Min(amountData, 'amountChangeDiff');
  }

  return { mainMoneys, amountChangeDiffs };
}

// 读取目标日截至 cutoffMinute 的资金流和成交量快照（不存在则静默跳过）
// mode='backtest' 读取 fundSnapshot/amountSnapshot 文件
// mode='realtime' 读取 amount.json 实时数据并按 5/10 分钟聚合
function readSnapshotsForPrompt(targetDate, cutoffMinute, mode = 'backtest') {
  let fundData = null;
  let amountData = null;
  if (mode === 'realtime') {
    try {
      const history = getAmountHistory();
      if (history && Array.isArray(history) && history.length > 0) {
        const fund5 = aggregateByInterval(history, 5);
        const amount10 = aggregateByInterval(history, 10);
        fundData = cutoffMinute
          ? fund5.filter(d => snapshotTimeToHHMM(d.time) <= cutoffMinute)
          : fund5;
        amountData = cutoffMinute
          ? amount10.filter(d => snapshotTimeToHHMM(d.time) <= cutoffMinute)
          : amount10;
      }
    } catch (e) { /* skip */ }
  } else {
    try {
      const fund = getFundSnapshot(targetDate);
      if (fund && Array.isArray(fund) && fund.length > 0) {
        fundData = cutoffMinute
          ? fund.filter(d => snapshotTimeToHHMM(d.time) <= cutoffMinute)
          : fund;
      }
    } catch (e) { /* skip */ }
    try {
      const amount = getAmountSnapshot(targetDate);
      if (amount && Array.isArray(amount) && amount.length > 0) {
        amountData = cutoffMinute
          ? amount.filter(d => snapshotTimeToHHMM(d.time) <= cutoffMinute)
          : amount;
      }
    } catch (e) { /* skip */ }
  }
  return { fundData, amountData };
}

// 构建在线预测上下文（前100日全天5分钟K线 + 目标日已走部分 + 资金/成交量快照）
// 使用 100 天缓存（含 OHLCV + 快照合并），与历史探查共用一套数据
// mode='realtime' 当日资金流/成交量读 amount.json 实时数据；mode='backtest' 读快照文件
async function buildOnlineContext(indexCode, targetDate, targetMinute, mode = 'backtest') {
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;

  // 1. 获取目标日分时数据
  let tline;
  try {
    tline = await getSingleStockTlineDataByDate(code, parseInt(targetDate, 10));
  } catch (e) {
    console.error(`[aiPrediction] 获取 ${code} ${targetDate} 分时数据失败:`, e.message);
  }
  if (!tline || !tline.line || tline.line.length === 0) {
    throw new Error('所选日期无分时数据');
  }

  const preclose = tline.preclose_px || tline.line[0]?.preclose_px || 0;
  if (!preclose) throw new Error('无法获取昨收价');

  const allBars = buildBarsWithMinute(tline.line, targetDate);
  if (allBars.length === 0) {
    throw new Error('所选日期分时数据聚合后为空');
  }

  // 2. 截取目标日已走部分
  let targetBars;
  if (targetMinute) {
    let cutoffIdx = allBars.findIndex(b => b.minute === targetMinute);
    if (cutoffIdx === -1) {
      cutoffIdx = -1;
      for (let i = 0; i < allBars.length; i++) {
        if (allBars[i].minute > targetMinute) break;
        cutoffIdx = i;
      }
    }
    if (cutoffIdx < 0) {
      throw new Error(`所选时刻 ${targetMinute} 早于当日最早数据 ${allBars[0]?.minute}`);
    }
    targetBars = allBars.slice(0, cutoffIdx + 1);
  } else {
    // realtime: 取全部已走 bars
    targetBars = allBars;
  }
  if (targetBars.length >= 48) throw new Error('所选时间已到收盘，无可预测时段');

  const lastMinute = targetBars[targetBars.length - 1].minute;
  const remainingMinutes = getRemainingMinutes(lastMinute);
  if (remainingMinutes.length === 0) {
    throw new Error('已到收盘时间，无可预测时段');
  }

  // 3. 从 100 天缓存获取历史数据（含 OHLCV + 快照），取目标日之前的 100 个交易日
  const cacheData = await getIntradayHistoryCached(code, 100, targetDate);
  const dailyBars = cacheData.days
    .filter(d => d.date < targetDate) // 排除目标日本身
    .map(d => ({
      date: d.date,
      change: d.change,
      closes: d.closes,
      mainMoneys: d.mainMoneys,
      amountChangeDiffs: d.amountChangeDiffs,
    }));

  if (dailyBars.length < 5) {
    throw new Error(`历史交易日不足 5 天(仅 ${dailyBars.length} 天)`);
  }

  const cumulative = dailyBars.reduce((s, c) => s + c.change, 0);
  const todayChange = preclose > 0
    ? (targetBars[targetBars.length - 1].close - preclose) / preclose * 100
    : 0;

  // 4. 读取当日资金流和成交量快照（截取到 lastMinute）
  const { fundData, amountData } = readSnapshotsForPrompt(targetDate, lastMinute, mode);

  // 4.1 从实时/快照数据构建今天的 48 桶 mainMoneys 和 amountChangeDiffs
  // realtime 模式下今天无快照文件，从 amount.json 实时数据构建；backtest 模式下从快照文件构建
  const { mainMoneys: todayMainMoneys, amountChangeDiffs: todayAmountChangeDiffs } = buildToday48FromRealtime(fundData, amountData);

  // 5. 构造 actualLine
  const actualLine = targetBars.map(b => ({
    minute: b.minute,
    last_px: +b.close.toFixed(4),
    change: preclose > 0 ? +(((b.close - preclose) / preclose) * 100).toFixed(2) : 0,
  }));

  return {
    opt,
    code,
    indexName: opt.name,
    prevDates: dailyBars.map(d => d.date),
    predictDate: targetDate,
    preclose,
    targetBars,
    lastMinute,
    remainingMinutes,
    dailyBars,
    cumulative,
    todayChange,
    fundData,
    amountData,
    todayMainMoneys,
    todayAmountChangeDiffs,
    actualLine,
  };
}

// 构建 prompt 字符串
function buildOnlinePrompt(ctx) {
  const { opt, preclose, dailyBars, cumulative, todayChange, targetBars, remainingMinutes, lastMinute, todayMainMoneys, todayAmountChangeDiffs } = ctx;

  const dailyStr = dailyBars.map(d => `${d.date}(${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}%)`).join(', ');

  // 前 100 日全天 5 分钟收盘价 + 主力资金 + 成交量变化
  // 每日 3 行：收盘价 / 主力资金净流入(亿元) / 成交量变化(亿元)；无快照标 MISSING
  const dailyClosesStr = dailyBars.map(d => {
    const mmLine = d.mainMoneys ? d.mainMoneys.join(',') : 'MISSING';
    const acdLine = d.amountChangeDiffs ? d.amountChangeDiffs.join(',') : 'MISSING';
    return `${d.date}(${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}%): ${d.closes.join(',')}\n${mmLine}\n${acdLine}`;
  }).join('\n');

  // 今日已走分时
  const actualStr = targetBars.map(b =>
    `${b.minute},${b.close.toFixed(2)},${preclose > 0 ? ((b.close - preclose) / preclose * 100).toFixed(2) : '0.00'}`
  ).join('\n');

  // 今日实时资金流/成交量（48桶格式，与历史数据一致；null 表示未到时刻，MISSING 表示无数据）
  const mmLine = todayMainMoneys ? todayMainMoneys.join(',') : 'MISSING';
  const acdLine = todayAmountChangeDiffs ? todayAmountChangeDiffs.join(',') : 'MISSING';
  const todaySnapshotStr = `## 今日实时资金流/成交量（截至${lastMinute}，48桶，null=未到时刻）\n${mmLine}\n${acdLine}`;

  return `你是A股分时走势预测专家。请根据以下数据预测今日剩余分时走势。

## 基本信息
- 指数：${opt.name}
- 昨收价：${preclose.toFixed(2)}
- 前${dailyBars.length}个交易日：${dailyStr}
- 前${dailyBars.length}日累计：${cumulative >= 0 ? '+' : ''}${cumulative.toFixed(2)}%
- 今日截至目前涨跌：${todayChange >= 0 ? '+' : ''}${todayChange.toFixed(2)}%

## 前${dailyBars.length}个交易日全天5分钟收盘价（48个节点/日）+ 主力资金 + 成交量变化
每个交易日占 3 行，第1行：日期(涨跌%): 48个5分钟收盘价；第2行：48个5分钟主力资金净流入(亿元)；第3行：48个5分钟成交量变化(亿元)；MISSING 表示该日无快照。
时间轴对应：09:30,09:35,...,11:25,13:00,13:05,...,14:55（共48个5分钟桶）
${dailyClosesStr}

## 今日已走分时（5分钟收盘价）
时间,收盘价,涨幅%
${actualStr}

${todaySnapshotStr}

## 预测要求
预测从 ${remainingMinutes[0]} 到 ${remainingMinutes[remainingMinutes.length - 1]} 的剩余分时（共${remainingMinutes.length}个5分钟节点），给出2种可能的场景。

剩余时间节点：${remainingMinutes.join(',')}

请以严格JSON格式输出（不要包含markdown代码块标记），格式如下：
{"scenarios":[{"name":"场景名称","probability":0.6,"final_change":0.5,"reason":"一句话理由","prices":[价格1,价格2,...]},{"name":"场景名称","probability":0.4,"final_change":-1.2,"reason":"一句话理由","prices":[价格1,价格2,...]}]}

要求：
1. 两种场景概率之和为1
2. prices数组长度必须为${remainingMinutes.length}
3. 价格应基于昨收价${preclose.toFixed(2)}合理波动
4. final_change为收盘价相对昨收价的涨跌幅%`;
}

// 调用 AI API 并解析返回（底层根据 aiProvider 配置自动切换 DeepSeek / 智谱）
async function callAI(prompt) {
  const provider = getActiveProvider();
  console.log(`[aiPrediction] 调用 ${provider.name} ${provider.model}`);
  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(buildRequestBody({
      messages: [
        { role: 'system', content: '你是专业的A股分时走势预测专家，请基于历史数据和当前走势，预测剩余交易时间的分时走势。只输出JSON，不要输出其他任何内容。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      stream: false,
      thinking: false, // 预测场景关闭思考，确保输出纯净的JSON
      responseFormat: { type: 'json_object' }, // 强制 JSON 输出，避免截断或格式错误
      maxTokens: 16384, // K线预测需生成多场景×48根价格，需要较大 token 额度
    })),
  });

  if (!response.ok) {
    throw new Error(`${provider.name}API请求失败: ${response.status}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const finishReason = choice.finish_reason || '';
  // 优先取 content，为空时回退到 reasoning_content（DeepSeek 思考模式可能将内容放在此字段）
  const content = msg.content || msg.reasoning_content || '';
  console.log(`[aiPrediction] ${provider.name}返回 finish_reason=${finishReason}, 长度=${content.length}, usage=${JSON.stringify(data.usage || {})}`);
  console.log(`[aiPrediction] ${provider.name}返回(前200字): ${content.slice(0, 200)}`);
  if (!content) {
    console.error(`[aiPrediction] ${provider.name}返回内容为空, 完整响应:`, JSON.stringify(data).slice(0, 500));
    throw new Error(`${provider.name}返回内容为空`);
  }
  if (finishReason === 'length') {
    console.error(`[aiPrediction] ${provider.name}因max_tokens限制截断, 当前设置max_tokens=16384`);
  }

  let jsonStr = content.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // JSON 解析失败：尝试修复截断的 JSON（补全未闭合的括号）
    console.error(`[aiPrediction] JSON解析失败: ${e.message}`);
    console.error(`[aiPrediction] 内容末尾200字: ...${jsonStr.slice(-200)}`);
    const repaired = repairTruncatedJson(jsonStr);
    if (repaired) {
      console.log(`[aiPrediction] JSON修复成功，重试解析`);
      parsed = repaired;
    } else {
      throw new Error(`解析${provider.name}返回JSON失败: ${e.message}`);
    }
  }

  const scenarios = parsed.scenarios || [];
  if (scenarios.length === 0) {
    throw new Error(`${provider.name}返回的场景数据为空`);
  }
  return scenarios;
}

// 修复因 max_tokens 截断的 JSON：补全未闭合的括号/引号
function repairTruncatedJson(str) {
  let s = str.trim();
  // 如果以代码块开头但未闭合，去掉开头
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '');
  }
  // 统计未闭合的括号
  let braces = 0, brackets = 0;
  let inString = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  // 如果在字符串内部被截断，先关闭字符串
  if (inString) s += '"';
  // 去掉末尾可能残留的不完整 token（如数字、逗号后无内容）
  s = s.replace(/,\s*$/, '');
  // 补全括号
  for (let i = 0; i < brackets; i++) s += ']';
  for (let i = 0; i < braces; i++) s += '}';
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// 把场景数组转为 trend 格式
function parseScenariosToTrends(scenarios, remainingMinutes, preclose) {
  return scenarios.map((s, idx) => {
    const prices = (s.prices || []).map(p => parseFloat(p));
    const line = remainingMinutes.map((minute, j) => {
      const px = !isNaN(prices[j]) ? prices[j] : preclose;
      return {
        minute,
        last_px: +px.toFixed(4),
        change: preclose > 0 ? +(((px - preclose) / preclose) * 100).toFixed(2) : 0,
      };
    });
    const finalChange = s.final_change !== undefined
      ? parseFloat(s.final_change)
      : (line.length > 0 && preclose > 0 ? ((line[line.length - 1].last_px - preclose) / preclose * 100) : 0);
    return {
      probability: s.probability || 0,
      name: s.name || `场景${idx + 1}`,
      final_change: +finalChange.toFixed(2),
      reason: s.reason || '',
      line,
    };
  });
}

// 在线回测：调用 AI 大模型接口预测剩余分时走势（前100日全天 + 目标日已走 + 资金/成交量快照）
async function getOnlineBacktestPrediction(indexCode, targetDate, targetMinute) {
  const ctx = await buildOnlineContext(indexCode, targetDate, targetMinute, 'backtest');
  const prompt = buildOnlinePrompt(ctx);
  console.log(`[aiPrediction] 在线回测 ${ctx.code} ${ctx.indexName}, 目标日 ${targetDate}, 时刻 ${targetMinute || ctx.lastMinute}, 剩余 ${ctx.remainingMinutes.length} 桶`);
  const scenarios = await callAI(prompt);
  const trends = parseScenariosToTrends(scenarios, ctx.remainingMinutes, ctx.preclose);
  return {
    indexCode: ctx.code,
    indexName: ctx.indexName,
    historyDates: ctx.prevDates,
    predictDate: ctx.predictDate,
    preclose: ctx.preclose,
    sampleCount: scenarios.length,
    actualLine: ctx.actualLine,
    trends,
    model: 'zhipu',
  };
}

// 在线实时预测：当日已走部分 → AI 大模型预测剩余
async function getOnlineRealtimePrediction(indexCode) {
  const today = dayjs().format('YYYYMMDD');
  // realtime: targetMinute 为空，使用当日全部已走 bars
  const ctx = await buildOnlineContext(indexCode, today, '', 'realtime');
  const prompt = buildOnlinePrompt(ctx);
  console.log(`[aiPrediction] 在线实时 ${ctx.code} ${ctx.indexName}, 目标日 ${today}, 时刻 ${ctx.lastMinute}, 剩余 ${ctx.remainingMinutes.length} 桶`);
  const scenarios = await callAI(prompt);
  const trends = parseScenariosToTrends(scenarios, ctx.remainingMinutes, ctx.preclose);
  return {
    indexCode: ctx.code,
    indexName: ctx.indexName,
    historyDates: ctx.prevDates,
    predictDate: ctx.predictDate,
    preclose: ctx.preclose,
    sampleCount: scenarios.length,
    actualLine: ctx.actualLine,
    trends,
    model: 'zhipu',
  };
}

// 获取预测上下文（用于拷贝上下文功能）
async function getPredictionContext(indexCode, targetDate, targetMinute, mode) {
  const actualTargetDate = mode === 'realtime' ? dayjs().format('YYYYMMDD') : targetDate;
  const actualTargetMinute = mode === 'realtime' ? '' : targetMinute;
  const ctx = await buildOnlineContext(indexCode, actualTargetDate, actualTargetMinute, mode);
  const prompt = buildOnlinePrompt(ctx);
  return {
    prompt,
    actualLine: ctx.actualLine,
    preclose: ctx.preclose,
    remainingMinutes: ctx.remainingMinutes,
    indexName: ctx.indexName,
    predictDate: ctx.predictDate,
    historyDates: ctx.prevDates,
  };
}

// ==================== K线预测（全天48根5分钟K线）====================

// 构建 K 线预测上下文（前100日全天5分钟K线，无目标日已走部分）
// 使用 100 天缓存（含 OHLCV + 快照合并），与历史探查/在线分时共用一套数据
async function buildKlineContext(indexCode, targetDate, mode) {
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;

  // 1. 从 100 天缓存获取历史数据（含 OHLCV + 快照），取预测日之前的 100 个交易日
  // realtime 模式下预测日为下一交易日，需含入今日数据；backtest 模式下预测日即 targetDate，排除之
  const predictDateForFilter = mode === 'backtest' ? targetDate : nextWeekday(dayjs().format('YYYYMMDD'));
  const cacheData = await getIntradayHistoryCached(code, 100, predictDateForFilter);
  const dailyBars = cacheData.days
    .filter(d => d.date < predictDateForFilter) // 排除预测日本身（realtime 含入今日）
    .map(d => ({
      date: d.date,
      change: d.change,
      closes: d.closes,
      mainMoneys: d.mainMoneys,
      amountChangeDiffs: d.amountChangeDiffs,
    }));

  if (dailyBars.length < 5) {
    throw new Error(`历史日线数据不足 5 天(仅 ${dailyBars.length} 天)`);
  }

  const cumulative = dailyBars.reduce((s, c) => s + c.change, 0);
  const lastDayCloses = dailyBars[dailyBars.length - 1].closes;
  const lastHistClose = lastDayCloses[lastDayCloses.length - 1];

  // 2. 确定 preclose 和 actualLine
  let preclose = 0;
  let actualLine = null;
  if (mode === 'backtest') {
    // 回测：获取 targetDate 的实际分时数据
    let tline;
    try {
      tline = await getSingleStockTlineDataByDate(code, parseInt(targetDate, 10));
    } catch (e) { /* skip */ }
    if (!tline || !tline.line || tline.line.length === 0) {
      throw new Error('所选日期无分时数据');
    }
    preclose = tline.preclose_px || tline.line[0]?.preclose_px || 0;
    if (!preclose) throw new Error('无法获取昨收价');
    const allBars = buildBarsWithMinute(tline.line, targetDate);
    actualLine = allBars.map(b => ({
      minute: b.minute,
      last_px: +b.close.toFixed(4),
      change: preclose > 0 ? +(((b.close - preclose) / preclose) * 100).toFixed(2) : 0,
    }));
  } else {
    // 实时：preclose = 当日收盘价（如有），否则用前一交易日收盘价
    const today = dayjs().format('YYYYMMDD');
    let tline;
    try {
      tline = await getSingleStockTlineDataByDate(code, parseInt(today, 10));
    } catch (e) { /* skip */ }
    if (tline && tline.line && tline.line.length > 0) {
      const allBars = buildBarsWithMinute(tline.line, today);
      if (allBars.length > 0) {
        preclose = +allBars[allBars.length - 1].close.toFixed(2);
      }
    }
    if (!preclose) preclose = lastHistClose;
  }

  const predictDate = mode === 'backtest' ? targetDate : nextWeekday(dayjs().format('YYYYMMDD'));

  return {
    opt,
    code,
    indexName: opt.name,
    prevDates: dailyBars.map(d => d.date),
    predictDate,
    preclose,
    dailyBars,
    cumulative,
    actualLine,
    mode,
  };
}

// 构建 K线预测 prompt（全天48节点）
function buildKlinePrompt(ctx) {
  const { opt, preclose, dailyBars, cumulative, predictDate } = ctx;
  const dateStr = `${predictDate.substring(0, 4)}-${predictDate.substring(4, 6)}-${predictDate.substring(6, 8)}`;

  const dailyStr = dailyBars.map(d => `${d.date}(${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}%)`).join(', ');
  // 前 100 日全天 5 分钟收盘价 + 主力资金 + 成交量变化
  // 每日 3 行：收盘价 / 主力资金净流入(亿元) / 成交量变化(亿元)；无快照标 MISSING
  const dailyClosesStr = dailyBars.map(d => {
    const mmLine = d.mainMoneys ? d.mainMoneys.join(',') : 'MISSING';
    const acdLine = d.amountChangeDiffs ? d.amountChangeDiffs.join(',') : 'MISSING';
    return `${d.date}(${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}%): ${d.closes.join(',')}\n${mmLine}\n${acdLine}`;
  }).join('\n');

  return `你是A股分时走势预测专家。请根据以下数据预测${dateStr}的全天分时走势。

## 基本信息
- 指数：${opt.name}
- 昨收价：${preclose.toFixed(2)}
- 前${dailyBars.length}个交易日：${dailyStr}
- 前${dailyBars.length}日累计：${cumulative >= 0 ? '+' : ''}${cumulative.toFixed(2)}%

## 前${dailyBars.length}个交易日全天5分钟收盘价（48个节点/日）+ 主力资金 + 成交量变化
每个交易日占 3 行，第1行：日期(涨跌%): 48个5分钟收盘价；第2行：48个5分钟主力资金净流入(亿元)；第3行：48个5分钟成交量变化(亿元)；MISSING 表示该日无快照。
时间轴对应：09:30,09:35,...,11:25,13:00,13:05,...,14:55（共48个5分钟桶）
${dailyClosesStr}

## 预测要求
预测 ${dateStr} 全天分时走势（共48个5分钟节点），给出2种可能的场景。

时间节点：${INTRADAY_MINUTES.join(',')}

请以严格JSON格式输出（不要包含markdown代码块标记），格式如下：
{"scenarios":[{"name":"场景名称","probability":0.6,"final_change":0.5,"reason":"一句话理由","prices":[价格1,价格2,...]},{"name":"场景名称","probability":0.4,"final_change":-1.2,"reason":"一句话理由","prices":[价格1,价格2,...]}]}

要求：
1. 两种场景概率之和为1
2. prices数组长度必须为48
3. 价格应基于昨收价${preclose.toFixed(2)}合理波动
4. final_change为收盘价相对昨收价的涨跌幅%`;
}

// K线预测：Kronos 预测下一交易日全天 48 根 5 分钟 K 线
async function getKlinePrediction(indexCode, sampleCount = 20) {
  const today = dayjs().format('YYYYMMDD');
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;

  const prevDates = await getPrevTradingDays(today, code, 10);
  if (prevDates.length < 5) {
    throw new Error(`历史交易日不足 5 天(仅 ${prevDates.length} 天)`);
  }

  const { history, usedDates } = await buildHistoryBars(prevDates, code);
  if (history.length < 10) {
    throw new Error(`历史 5 分钟 K 线数据不足(${history.length} 根)`);
  }

  const predictDate = nextWeekday(today);

  const payload = {
    history,
    pred_len: 48,
    sample_count: sampleCount,
    predict_date: predictDate,
  };

  console.log(`[aiPrediction] K线预测 ${code} ${opt.name}, 历史 ${history.length} 根, 预测日 ${predictDate}, 采样 ${sampleCount}`);
  const result = await runPythonPredict(payload);
  if (!result || !result.success) {
    throw new Error(result?.message || '预测失败');
  }
  return {
    indexCode: code,
    indexName: opt.name,
    historyDates: usedDates,
    predictDate,
    preclose: result.preclose,
    sampleCount: result.sample_count,
    trends: result.trends,
    model: 'kronos',
  };
}

// K线回测：Kronos 预测目标日全天 48 根 5 分钟 K 线（含实际走势）
async function getKlineBacktestPrediction(indexCode, targetDate, sampleCount = 20) {
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;

  const prevDates = await getPrevTradingDays(targetDate, code, 10);
  if (prevDates.length < 5) {
    throw new Error(`目标日期前历史交易日不足 5 天(仅 ${prevDates.length} 天)`);
  }

  const { history, usedDates } = await buildHistoryBars(prevDates, code);
  if (history.length < 10) {
    throw new Error(`历史 5 分钟 K 线数据不足(${history.length} 根)`);
  }

  const payload = {
    history,
    pred_len: 48,
    sample_count: sampleCount,
    predict_date: targetDate,
  };

  console.log(`[aiPrediction] K线回测 ${code} ${opt.name}, 目标日 ${targetDate}, 采样 ${sampleCount}`);
  const result = await runPythonPredict(payload);
  if (!result || !result.success) {
    throw new Error(result?.message || '预测失败');
  }

  // 获取目标日实际分时数据
  let tline;
  try {
    tline = await getSingleStockTlineDataByDate(code, parseInt(targetDate, 10));
  } catch (e) {
    console.error(`[aiPrediction] 获取 ${code} ${targetDate} 分时数据失败:`, e.message);
  }
  if (!tline || !tline.line || tline.line.length === 0) {
    throw new Error('所选日期无分时数据');
  }

  const preclose = result.preclose || tline.preclose_px || tline.line[0]?.preclose_px || 0;
  const allBars = buildBarsWithMinute(tline.line, targetDate);
  const actualLine = allBars.map(b => ({
    minute: b.minute,
    last_px: +b.close.toFixed(4),
    change: preclose > 0 ? +(((b.close - preclose) / preclose) * 100).toFixed(2) : 0,
  }));

  return {
    indexCode: code,
    indexName: opt.name,
    historyDates: usedDates,
    predictDate: targetDate,
    preclose,
    sampleCount: result.sample_count,
    actualLine,
    trends: result.trends,
    model: 'kronos',
  };
}

// 在线K线预测：AI 大模型预测下一交易日全天 48 根
async function getOnlineKlinePrediction(indexCode) {
  const today = dayjs().format('YYYYMMDD');
  const ctx = await buildKlineContext(indexCode, today, 'realtime');
  const prompt = buildKlinePrompt(ctx);
  console.log(`[aiPrediction] 在线K线预测 ${ctx.code} ${ctx.indexName}, 预测日 ${ctx.predictDate}`);
  const scenarios = await callAI(prompt);
  const trends = parseScenariosToTrends(scenarios, INTRADAY_MINUTES, ctx.preclose);
  return {
    indexCode: ctx.code,
    indexName: ctx.indexName,
    historyDates: ctx.prevDates,
    predictDate: ctx.predictDate,
    preclose: ctx.preclose,
    sampleCount: scenarios.length,
    trends,
    model: 'zhipu',
  };
}

// 在线K线回测：AI 大模型预测目标日全天 48 根（含实际走势）
async function getOnlineKlineBacktestPrediction(indexCode, targetDate) {
  const ctx = await buildKlineContext(indexCode, targetDate, 'backtest');
  const prompt = buildKlinePrompt(ctx);
  console.log(`[aiPrediction] 在线K线回测 ${ctx.code} ${ctx.indexName}, 目标日 ${targetDate}`);
  const scenarios = await callAI(prompt);
  const trends = parseScenariosToTrends(scenarios, INTRADAY_MINUTES, ctx.preclose);
  return {
    indexCode: ctx.code,
    indexName: ctx.indexName,
    historyDates: ctx.prevDates,
    predictDate: ctx.predictDate,
    preclose: ctx.preclose,
    sampleCount: scenarios.length,
    actualLine: ctx.actualLine,
    trends,
    model: 'zhipu',
  };
}

// 获取K线预测上下文（用于拷贝上下文功能）
async function getKlinePredictionContext(indexCode, targetDate, mode) {
  const actualTargetDate = mode === 'realtime' ? dayjs().format('YYYYMMDD') : targetDate;
  const ctx = await buildKlineContext(indexCode, actualTargetDate, mode);
  const prompt = buildKlinePrompt(ctx);
  return {
    prompt,
    actualLine: ctx.actualLine,
    preclose: ctx.preclose,
    remainingMinutes: [...INTRADAY_MINUTES],
    indexName: ctx.indexName,
    predictDate: ctx.predictDate,
    historyDates: ctx.prevDates,
  };
}

// ==================== 历史探查（100 天分时数据缓存 + AI 分析）====================

// 分时历史缓存文件路径
const INTRADAY_HISTORY_CACHE_PATH = path.resolve(__dirname, '../data/intraday_history_cache.json');

// 将 10 分钟快照数据线性插值为 48 个 5 分钟桶（与 INTRADAY_MINUTES 对齐）
// snapshot10min: [{time:"HHMMSS", mainMoney, amountChangeDiff}, ...]
// fieldName: 'mainMoney' | 'amountChangeDiff'
// 返回: [48个值] 或 null
function interpolateSnapshotTo5Min(snapshot10min, fieldName) {
  if (!snapshot10min || !Array.isArray(snapshot10min) || snapshot10min.length === 0) return null;

  // 构建有序点列表（按分钟数）
  const points = snapshot10min.map(s => {
    const hhmm = snapshotTimeToHHMM(s.time);
    const parts = hhmm.split(':');
    return { minute: parseInt(parts[0]) * 60 + parseInt(parts[1]), value: s[fieldName] };
  }).filter(p => p.value !== undefined && p.value !== null).sort((a, b) => a.minute - b.minute);

  if (points.length === 0) return null;

  const result = [];
  for (const hhmm of INTRADAY_MINUTES) {
    const parts = hhmm.split(':');
    const targetMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);

    // 精确命中
    const exact = points.find(p => p.minute === targetMin);
    if (exact) {
      result.push(+exact.value.toFixed(2));
      continue;
    }

    // 寻找前后两个已知点
    let prev = null, next = null;
    for (const p of points) {
      if (p.minute < targetMin) prev = p;
      if (p.minute > targetMin) { next = p; break; }
    }

    if (prev && next) {
      const ratio = (targetMin - prev.minute) / (next.minute - prev.minute);
      result.push(+(prev.value + (next.value - prev.value) * ratio).toFixed(2));
    } else if (prev) {
      result.push(+prev.value.toFixed(2));
    } else if (next) {
      result.push(+next.value.toFixed(2));
    } else {
      result.push(null);
    }
  }
  return result;
}

// 读取某日 fundSnapshot（5分钟主力资金）和 amountSnapshot（5分钟成交量变化）
// 合并为 48 桶数组（与 INTRADAY_MINUTES 对齐），无快照则对应字段为 null
// 返回 { mainMoneys: [48]|null, amountChangeDiffs: [48]|null }
function readMergedSnapshots(dateStr) {
  let mainMoneys = null;
  let amountChangeDiffs = null;
  try {
    const fund = getFundSnapshot(dateStr);
    if (fund && Array.isArray(fund) && fund.length > 0) {
      // fundSnapshot 为 5 分钟级别，直接按时间匹配到 48 桶
      const valueMap = {};
      fund.forEach(s => { valueMap[snapshotTimeToHHMM(s.time)] = s.mainMoney; });
      mainMoneys = INTRADAY_MINUTES.map(m => {
        const v = valueMap[m];
        return v !== undefined ? +v.toFixed(2) : null;
      });
      // 若全部为 null 则置为 null
      if (mainMoneys.every(v => v === null)) mainMoneys = null;
    }
  } catch (e) { /* skip */ }
  try {
    const amount = getAmountSnapshot(dateStr);
    if (amount && Array.isArray(amount) && amount.length > 0) {
      // amountSnapshot 为 5 分钟级别，直接匹配到 48 桶（缺失点线性插值兜底）
      amountChangeDiffs = interpolateSnapshotTo5Min(amount, 'amountChangeDiff');
    }
  } catch (e) { /* skip */ }
  return { mainMoneys, amountChangeDiffs };
}

// 读取分时历史缓存
function readIntradayHistoryCache() {
  try {
    if (fs.existsSync(INTRADAY_HISTORY_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(INTRADAY_HISTORY_CACHE_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[aiPrediction] 读取分时历史缓存失败:', e.message);
  }
  return {};
}

// 写入分时历史缓存
function writeIntradayHistoryCache(cache) {
  try {
    fs.writeFileSync(INTRADAY_HISTORY_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    console.error('[aiPrediction] 写入分时历史缓存失败:', e.message);
  }
}

// 获取过去 N 个真实交易日列表（通过 K 线数据判定）
async function getPastTradingDays(targetDate, indexCode, n = 100) {
  // 拉取足够多的日 K 线以覆盖 100 个交易日（含节假日跳过）
  const kline = await getSingleStockData(indexCode, n + 40);
  const dates = kline
    .map(k => String(k.trade_date))
    .filter(d => d <= targetDate)
    .sort((a, b) => b.localeCompare(a)) // 降序，最新在前
    .slice(0, n)
    .sort((a, b) => a.localeCompare(b)); // 升序返回
  return dates;
}

// 获取过去 N 天分时数据（带缓存：首次全量拉取，后续只补缺失日期）
// 缓存同时存储 OHLCV（opens/highs/lows/closes/volumes/amounts）
// 以及合并后的快照数据（mainMoneys/amountChangeDiffs，无快照则为 null）
// targetDate 可选：获取截至该日期的 N 天数据（默认今天）
// 返回 { indexCode, indexName, days: [{date, change, preclose, opens, highs, lows, closes, volumes, amounts, mainMoneys, amountChangeDiffs}] }
async function getIntradayHistoryCached(indexCode, days = 100, targetDate = null) {
  const opt = INDEX_OPTIONS.find(o => o.code === indexCode) || INDEX_OPTIONS[0];
  const code = opt.code;
  const today = dayjs().format('YYYYMMDD');
  const endDate = targetDate || today;

  // 1. 获取交易日列表
  const tradingDays = await getPastTradingDays(endDate, code, days);
  if (tradingDays.length === 0) {
    throw new Error('无法获取交易日列表');
  }

  console.log(`[aiPrediction] 历史缓存 ${code} ${opt.name}, 需要 ${tradingDays.length} 个交易日, 截至日 ${endDate}`);

  // 2. 读取缓存
  const cache = readIntradayHistoryCache();
  if (!cache[code]) cache[code] = { lastUpdated: '', dates: {} };
  const cachedDates = cache[code].dates || {};

  // 3. 找出 OHLCV 缺失或不完整的日期
  // 判定缺失：无缓存条目、任一 OHLCV 数组不存在/为空、或不足 48 根 K 线（不完整）
  // 当日盘中数据会持续变化，不足 48 根时需强制刷新获取最新
  const missingDates = tradingDays.filter(d => {
    const entry = cachedDates[d];
    if (!entry) return true;
    if (!Array.isArray(entry.opens) || entry.opens.length === 0) return true;
    if (!Array.isArray(entry.highs) || entry.highs.length === 0) return true;
    if (!Array.isArray(entry.lows) || entry.lows.length === 0) return true;
    if (!Array.isArray(entry.volumes) || entry.volumes.length === 0) return true;
    if (!Array.isArray(entry.amounts) || entry.amounts.length === 0) return true;
    // 不足 48 根视为不完整（当日盘中实时变化或历史数据拉取中断）
    if (entry.opens.length < 48) return true;
    return false;
  });
  console.log(`[aiPrediction] OHLCV缓存命中 ${tradingDays.length - missingDates.length} 天, 需补拉 ${missingDates.length} 天`);

  // 4. 拉取缺失日期的分时数据
  for (const dateStr of missingDates) {
    let tline;
    try {
      tline = await getSingleStockTlineDataByDate(code, parseInt(dateStr, 10));
    } catch (e) {
      console.error(`[aiPrediction] 获取 ${code} ${dateStr} 分时数据失败:`, e.message);
    }
    if (!tline || !tline.line || tline.line.length === 0) {
      console.warn(`[aiPrediction] ${code} ${dateStr} 无分时数据，跳过`);
      continue;
    }
    const preclose = tline.preclose_px || tline.line[0]?.preclose_px || 0;
    const bars = buildBarsWithMinute(tline.line, dateStr);
    if (bars.length === 0) continue;
    const dayClose = bars[bars.length - 1].close;
    const change = preclose > 0 ? +(((dayClose - preclose) / preclose) * 100).toFixed(2) : 0;
    cachedDates[dateStr] = {
      preclose: +preclose.toFixed(2),
      change,
      opens: bars.map(b => +b.open.toFixed(2)),
      highs: bars.map(b => +b.high.toFixed(2)),
      lows: bars.map(b => +b.low.toFixed(2)),
      closes: bars.map(b => +b.close.toFixed(2)),
      // 成交量（手）与成交额（元）的原始值，保留 0 位小数避免浮点
      volumes: bars.map(b => Math.max(0, Math.round(b.volume || 0))),
      amounts: bars.map(b => Math.max(0, Math.round(b.amount || 0))),
    };
  }

  // 5. 补充快照数据（mainMoneys / amountChangeDiffs）— 字段未定义或为 null 时才补
  // null 表示之前拉取时快照文件尚未生成（如当日盘中），后续快照生成后需重新补入
  const missingSnapshotDates = tradingDays.filter(d => {
    const entry = cachedDates[d];
    return entry && (entry.mainMoneys === undefined || entry.mainMoneys === null);
  });
  if (missingSnapshotDates.length > 0) {
    console.log(`[aiPrediction] 补充快照数据 ${missingSnapshotDates.length} 天`);
    for (const dateStr of missingSnapshotDates) {
      const { mainMoneys, amountChangeDiffs } = readMergedSnapshots(dateStr);
      cachedDates[dateStr].mainMoneys = mainMoneys;
      cachedDates[dateStr].amountChangeDiffs = amountChangeDiffs;
    }
  }

  // 6. 更新缓存
  cache[code].dates = cachedDates;
  cache[code].lastUpdated = today;
  writeIntradayHistoryCache(cache);

  // 7. 返回有序结果
  const result = tradingDays
    .filter(d => cachedDates[d])
    .map(d => ({ date: d, ...cachedDates[d] }));

  console.log(`[aiPrediction] 历史缓存 ${code} 返回 ${result.length} 天分时数据`);
  return { indexCode: code, indexName: opt.name, days: result };
}

// 构建历史探查 prompt
function buildHistoryExplorationPrompt(indexName, userQuestion, historyData) {
  const { days } = historyData;
  const totalDays = days.length;

  // 单位换算：原始 volume 单位为「手」，amount 单位为「元」
  // prompt 中转为「万手」与「亿元」，便于 AI 阅读
  const toWanShou = (v) => +(v / 10000).toFixed(2);
  const toYiYuan = (v) => +(v / 100000000).toFixed(2);

  // 每个交易日五行：价格 / 成交量(万手) / 成交额(亿元) / 主力资金净流入(亿元) / 成交量变化(亿元)
  // 后两行无快照时标记为 MISSING
  const dailyStr = days.map(d => {
    const vols = (d.volumes || []).map(toWanShou);
    const amts = (d.amounts || []).map(toYiYuan);
    const mmLine = d.mainMoneys ? d.mainMoneys.join(',') : 'MISSING';
    const acdLine = d.amountChangeDiffs ? d.amountChangeDiffs.join(',') : 'MISSING';
    return `${d.date},${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}%,${d.preclose},${d.closes.join(',')}\n${vols.join(',')}\n${amts.join(',')}\n${mmLine}\n${acdLine}`;
  }).join('\n');

  // 统计概览
  const upDays = days.filter(d => d.change > 0).length;
  const downDays = days.filter(d => d.change < 0).length;
  const flatDays = totalDays - upDays - downDays;
  const avgChange = days.reduce((s, d) => s + d.change, 0) / totalDays;
  const maxChange = days.reduce((max, d) => d.change > max.change ? d : max, days[0]);
  const minChange = days.reduce((min, d) => d.change < min.change ? d : min, days[0]);

  // 成交额统计（亿元）
  const dayAmountsYi = days.map(d => (d.amounts || []).reduce((s, a) => s + a, 0) / 100000000);
  const avgAmountYi = dayAmountsYi.reduce((s, a) => s + a, 0) / totalDays;
  const maxAmountIdx = dayAmountsYi.reduce((max, a, i) => a > dayAmountsYi[max] ? i : max, 0);
  const minAmountIdx = dayAmountsYi.reduce((min, a, i) => a < dayAmountsYi[min] ? i : min, 0);

  // 快照覆盖统计
  const snapshotDays = days.filter(d => d.mainMoneys || d.amountChangeDiffs).length;

  return `你是A股市场分析专家。请根据以下${indexName}过去${totalDays}个交易日的5分钟分时数据，回答用户的问题。

## 指数概况
- 指数：${indexName}
- 数据范围：${days[0].date} ~ ${days[days.length - 1].date}（共${totalDays}个交易日）
- 上涨天数：${upDays}，下跌天数：${downDays}，平盘天数：${flatDays}
- 平均日涨跌：${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(2)}%
- 最大涨幅：${maxChange.date} (${maxChange.change >= 0 ? '+' : ''}${maxChange.change.toFixed(2)}%)
- 最大跌幅：${minChange.date} (${minChange.change >= 0 ? '+' : ''}${minChange.change.toFixed(2)}%)
- 平均日成交额：${avgAmountYi.toFixed(2)}亿元
- 最大成交额：${days[maxAmountIdx].date} (${dayAmountsYi[maxAmountIdx].toFixed(2)}亿元)
- 最小成交额：${days[minAmountIdx].date} (${dayAmountsYi[minAmountIdx].toFixed(2)}亿元)
- 资金流/成交量快照覆盖：${snapshotDays}/${totalDays} 天（无快照的日期对应行标记为 MISSING）

## 分时数据
每个交易日占 5 行，格式如下：
第1行：日期,日涨跌%,昨收价,48个5分钟收盘价
第2行：48个5分钟成交量（万手）
第3行：48个5分钟成交额（亿元）
第4行：48个5分钟主力资金净流入（亿元，来自 fundSnapshot 5分钟快照；MISSING 表示该日无快照）
第5行：48个5分钟成交量变化（亿元，来自 amountSnapshot 5分钟快照，缺失点线性插值；MISSING 表示该日无快照）
时间轴对应：09:30,09:35,...,11:25,13:00,13:05,...,14:55（共48个5分钟桶）

${dailyStr}

## 用户问题
${userQuestion}

请基于上述数据进行深入分析，给出专业、有数据支撑的回答。可以直接引用具体日期和数据来佐证你的观点。分析时请综合考虑价格走势、成交量变化、成交额水平、主力资金流向（mainMoneys）和成交量变化（amountChangeDiffs），尤其关注放量/缩量、资金净流入/流出与涨跌方向的关系。`;
}

// 调用 AI 并返回自由文本（不解析 JSON）
async function callAIText(prompt, systemPrompt) {
  const provider = getActiveProvider();
  console.log(`[aiPrediction] 历史探查调用 ${provider.name} ${provider.model}`);
  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(buildRequestBody({
      messages: [
        { role: 'system', content: systemPrompt || '你是专业的A股市场分析专家，擅长基于分时走势数据进行深度分析。请给出专业、详实、有数据支撑的分析。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      stream: false,
      thinking: false,
      maxTokens: 8192,
    })),
  });

  if (!response.ok) {
    throw new Error(`${provider.name}API请求失败: ${response.status}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = msg.content || msg.reasoning_content || '';
  console.log(`[aiPrediction] 历史探查 ${provider.name}返回, 长度=${content.length}, usage=${JSON.stringify(data.usage || {})}`);
  if (!content) {
    throw new Error(`${provider.name}返回内容为空`);
  }
  return content;
}

// 历史探查：拉取 100 天分时数据 + 用户问题 → AI 分析
async function getHistoryExplorationResult(indexCode, userQuestion) {
  if (!userQuestion || !userQuestion.trim()) {
    throw new Error('请输入要分析的问题');
  }
  const historyData = await getIntradayHistoryCached(indexCode, 100);
  const prompt = buildHistoryExplorationPrompt(historyData.indexName, userQuestion, historyData);
  console.log(`[aiPrediction] 历史探查 ${historyData.indexCode} ${historyData.indexName}, ${historyData.days.length} 天数据, 问题: ${userQuestion.slice(0, 80)}`);
  const answer = await callAIText(prompt);
  return {
    indexCode: historyData.indexCode,
    indexName: historyData.indexName,
    daysCount: historyData.days.length,
    question: userQuestion,
    answer,
    model: getActiveProvider().name,
  };
}

// 历史探查上下文（用于拷贝到豆包/千问等平台）
async function getHistoryExplorationContext(indexCode, userQuestion) {
  if (!userQuestion || !userQuestion.trim()) {
    throw new Error('请输入要分析的问题');
  }
  const historyData = await getIntradayHistoryCached(indexCode, 100);
  const prompt = buildHistoryExplorationPrompt(historyData.indexName, userQuestion, historyData);
  return {
    prompt,
    indexName: historyData.indexName,
    daysCount: historyData.days.length,
  };
}

module.exports = {
  getAvailableDates,
  getPrediction,
  getRealtimePrediction,
  getBacktestPrediction,
  getOnlineBacktestPrediction,
  getOnlineRealtimePrediction,
  getPredictionContext,
  getKlinePrediction,
  getKlineBacktestPrediction,
  getOnlineKlinePrediction,
  getOnlineKlineBacktestPrediction,
  getKlinePredictionContext,
  getHistoryExplorationResult,
  getHistoryExplorationContext,
  getIntradayHistoryCached,
  callAIText,
  INTRADAY_MINUTES,
  INDEX_OPTIONS,
};
