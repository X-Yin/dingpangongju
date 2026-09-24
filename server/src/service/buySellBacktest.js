// 训练营 - 买卖点历史回测
// 依据「当下已有的买卖点诊断」对全部自选股进行多日回测：
//   买入信号 = 训练营回放买点诊断 allPassed（市场级，命中时对所有未持仓自选股买入）
//   卖出信号 = 训练营回放模拟持仓卖点诊断 isSell（个股级）
// 交易规则：首次触发买入信号即买入；持仓期间再次触发买入信号忽略，仅等卖出信号；
//          卖出后下一次买入信号可再次买入（每个股票同一时刻最多一笔持仓）。
// 诊断逻辑与前端 src/pages/trainingCamp/utils/buyPointChecks.js、sellPointChecks.js、
// src/utils/replayResilience.js 保持一致（两处同步）。
const { loadTrainingCampData, getTrainingCampDates } = require('./trainingCamp');
const { getSingleStockTlineDataByDate } = require('./stock');
const { calculateResilience, getLimitTypeByCode } = require('./stockDiagnose');
const {
  SENTIMENT_STRATEGIES,
  isSentimentStrategy,
  getSentimentDefaultRange,
  runSentimentBacktest,
} = require('./sentimentHotMoney');
const fs = require('fs');
const path = require('path');

const SELL_CONDITION_PERSIST_MIN = 5; // 卖出条件持续满足分钟数

// 回测排除的股票（不参与任何策略的回测）
const EXCLUDED_CODES = new Set(['sh688498', 'sh688808']); // 源杰科技、联讯仪器

// 回测策略定义（全部为单股策略：买点命中时只选指标最优的一只买入）
const STRATEGIES = {
  highest_gain: { id: 'highest_gain', name: '买入最高涨幅', desc: '买点命中时只买入回测起始日至当前整体涨幅最大的股票' },
  highest_5d_gain: { id: 'highest_5d_gain', name: '5日涨幅最大', desc: '买点命中时只买入最近 5 个交易日涨幅最大的股票' },
  highest_3d_gain: { id: 'highest_3d_gain', name: '3日涨幅最大', desc: '买点命中时只买入最近 3 个交易日涨幅最大的股票' },
  highest_3d_gain_switch: { id: 'highest_3d_gain_switch', name: '连续切换三日涨幅', desc: '触发买点时，买入当前所有自选股三日涨幅最大值。若空仓则全仓买入；若已持仓且最大涨幅股票变化，则卖掉旧的并全仓买入新的；若持仓未变则不操作' },
  highest_4d_gain: { id: 'highest_4d_gain', name: '4日涨幅最大', desc: '买点命中时只买入最近 4 个交易日涨幅最大的股票' },
  highest_2d_gain: { id: 'highest_2d_gain', name: '2日涨幅最大', desc: '买点命中时只买入最近 2 个交易日涨幅最大的股票' },
  highest_10d_gain: { id: 'highest_10d_gain', name: '10日涨幅最大', desc: '买点命中时只买入最近 10 个交易日涨幅最大的股票' },
  highest_3d_gain_twice: { id: 'highest_3d_gain_twice', name: '3日涨幅两次买入', desc: '买点命中时先买入 5 成仓位，剩余 5 成等当天收盘再买入，成本价为两次买入价格平均值（选股逻辑同 3 日涨幅最大）' },
  highest_3d_gain_quarter: { id: 'highest_3d_gain_quarter', name: '三日涨幅四份仓位', desc: '买点触发时把仓位分成四份，分别买入最近 3 个交易日涨幅排名前四的股票（各占 1/4）。任一只触发卖点即独立卖出；仅当四份全部清仓（彻底空仓）后，下一次买点才重新按四份建仓' },
  highest_3d_gain_two: { id: 'highest_3d_gain_two', name: '三日涨幅两个股票', desc: '买点触发时把仓位分成两份（各占 1/2）。两份均空仓时买入最近 3 个交易日涨幅最大和第二大的股票；仅一份空仓时只买入涨幅最大的股票。任一只触发卖点即独立卖出' },
  highest_5d_gain_2nd: { id: 'highest_5d_gain_2nd', name: '5日涨幅第二名', desc: '买点命中时只买入最近 5 个交易日涨幅第二大的股票' },
  highest_3d_gain_2nd: { id: 'highest_3d_gain_2nd', name: '3日涨幅第二名', desc: '买点命中时只买入最近 3 个交易日涨幅第二大的股票' },
  highest_3d_ma_slope: { id: 'highest_3d_ma_slope', name: '3日线斜率最陡峭', desc: '买点命中时只买入 3 日涨幅均线斜率角度最大的股票' },
  highest_5d_ma_slope: { id: 'highest_5d_ma_slope', name: '5日线斜率最陡峭', desc: '买点命中时只买入 5 日涨幅均线斜率角度最大的股票' },
  highest_5d_resilience: { id: 'highest_5d_resilience', name: '5日抗分歧分数最大', desc: '买点命中时只买入最近 5 个交易日抗分歧分数汇总最大的股票' },
  highest_3d_resilience: { id: 'highest_3d_resilience', name: '3日抗分歧分数最大', desc: '买点命中时只买入最近 3 个交易日抗分歧分数汇总最大的股票' },
  resilience_weak_to_strong: { id: 'resilience_weak_to_strong', name: '抗分歧弱转强', desc: '买点命中时先筛选出当日抗分歧分数>11 的股票，再从中计算最近 4 个交易日「前两天均值」与「最近两天均值」的差值（差值越大=抗分歧由弱转强越明显），全仓买入差值最大的股票；差值相同则买入当日涨幅最大的一只' },
  highest_3d_reports: { id: 'highest_3d_reports', name: '3日研报覆盖数最多', desc: '买点命中时只买入过去 3 个交易日研报覆盖数最多的股票（覆盖数相同取 3 日涨幅最大）' },
  highest_5d_reports: { id: 'highest_5d_reports', name: '5日研报覆盖数最多', desc: '买点命中时只买入过去 5 个交易日研报覆盖数最多的股票（覆盖数相同取 5 日涨幅最大）' },
  highest_3d_reports_2nd: { id: 'highest_3d_reports_2nd', name: '3日研报覆盖数第二名', desc: '买点命中时只买入过去 3 个交易日研报覆盖数第二多的股票（覆盖数相同取 3 日涨幅最大）' },
  highest_5d_reports_2nd: { id: 'highest_5d_reports_2nd', name: '5日研报覆盖数第二名', desc: '买点命中时只买入过去 5 个交易日研报覆盖数第二多的股票（覆盖数相同取 5 日涨幅最大）' },
  highest_3d_reports_top5_gain: { id: 'highest_3d_reports_top5_gain', name: '3日研报前五&涨幅最大', desc: '买点命中时在最近 3 个交易日研报覆盖数前五（含覆盖数相同的股票）中买入 3 日涨幅最大的一只' },
  highest_5d_reports_top5_gain: { id: 'highest_5d_reports_top5_gain', name: '5日研报前五&涨幅最大', desc: '买点命中时在最近 5 个交易日研报覆盖数前五（含覆盖数相同的股票）中买入 5 日涨幅最大的一只' },
  // 尾盘抄底系列（tailDip: true → 买入信号仅取尾盘抄底命中，不走买点诊断 allPassed；卖点走专属逐分钟环比规则）
  tail_dip_1d_gain: { id: 'tail_dip_1d_gain', name: '尾盘抄底-当日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日涨幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_3d_gain: { id: 'tail_dip_3d_gain', name: '尾盘抄底-3日涨幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入最近 3 个交易日涨幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_1d_resilience: { id: 'tail_dip_1d_resilience', name: '尾盘抄底-当日抗分歧最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日抗分歧分数最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_3d_resilience: { id: 'tail_dip_3d_resilience', name: '尾盘抄底-3日抗分歧最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入最近 3 个交易日抗分歧分数汇总最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_1d_fall: { id: 'tail_dip_1d_fall', name: '尾盘抄底-当日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日跌幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_3d_fall: { id: 'tail_dip_3d_fall', name: '尾盘抄底-3日跌幅最大', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入最近 3 个交易日跌幅最大的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  tail_dip_1d_resilience_low: { id: 'tail_dip_1d_resilience_low', name: '尾盘抄底-当日抗分歧分数最低', desc: '14:57 尾盘挂单买入（收盘集合竞价成交）：仅当日科技情绪分时曾触及 -100 退潮冰点（hasIce: true）时命中，买入当日抗分歧分数最低的股票；次日开盘后涨幅持续上涨则持有，开始下降（较上一分钟回落）即卖出', tailDip: true },
  // 情绪游资系列（独立回测逻辑，日期范围不受 fundSnapshot 限制，默认最近 60 个交易日）
  ...SENTIMENT_STRATEGIES,
};

// 选股抗分歧门槛（仅「买入最高涨幅」与「2日涨幅最大」两个策略启用）：买点触发时要求入选股票
// 「触发时点当日抗分歧分数 > 11」，不满足则按策略排名依次顺延至下一只满足的股票
// （买入条件明细中标注是否因前序股票分数≤11 而顺延买入；其余策略不受此限制）
const RESILIENCE_GATE_MIN = 11;
const RESILIENCE_GATE_STRATEGY_IDS = new Set(['highest_gain', 'highest_2d_gain']);
const RESILIENCE_GATE_DESC = '选股门槛：买点触发时要求入选股票触发时点当日抗分歧分数 > 11，不满足则按策略排名依次顺延至下一只满足的股票（全部候选均不满足则不买入），买入条件明细中标注是否因前序股票分数≤11 而顺延';
for (const s of Object.values(STRATEGIES)) {
  if (!RESILIENCE_GATE_STRATEGY_IDS.has(s.id)) continue;
  s.desc = `${s.desc}；${RESILIENCE_GATE_DESC}`;
}

// 回测结果缓存文件（按 策略+日期范围 存储，避免重复回测）
const backtestCacheDir = path.join(__dirname, '../data/backtest_results');
const getBacktestCacheFile = (strategy, startDate, endDate) => path.join(backtestCacheDir, `backtest_${strategy}_${startDate}_${endDate}.json`);

const readCachedBacktest = (strategy, startDate, endDate) => {
  try {
    const file = getBacktestCacheFile(strategy, startDate, endDate);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || data.range?.startDate !== startDate || data.range?.endDate !== endDate) return null;
    return data;
  } catch {
    return null;
  }
};

const writeCachedBacktest = (strategy, startDate, endDate, result) => {
  try {
    if (!fs.existsSync(backtestCacheDir)) fs.mkdirSync(backtestCacheDir, { recursive: true });
    fs.writeFileSync(getBacktestCacheFile(strategy, startDate, endDate), JSON.stringify(result, null, 2), 'utf-8');
  } catch (e) {
    console.error('回测结果缓存写入失败:', e.message);
  }
};

// ============================================================
// 机构研报覆盖索引：research_reports/menu.json（日期文件夹 → 报告标题/正文）
// 按自选股名称匹配报告标题或正文，统计每日每只股票的研报覆盖数
// ============================================================
const researchReportsDir = path.join(__dirname, '../data/research_reports');
let reportIndexCache = null; // { YYYYMMDD: { stockName: count } }
let reportIndexMtime = 0; // menu.json 修改时间，用于检测新增/编辑研报后自动重建索引

// 读取报告正文内容（id.json 存放 { content }），供正文匹配股票名使用
const readReportContent = (id) => {
  try {
    const contentPath = path.join(researchReportsDir, `${id}.json`);
    if (!fs.existsSync(contentPath)) return '';
    return JSON.parse(fs.readFileSync(contentPath, 'utf-8')).content || '';
  } catch {
    return '';
  }
};

const loadReportIndex = () => {
  const menuFile = path.join(researchReportsDir, 'menu.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(menuFile).mtimeMs;
  } catch {
    // menu.json 不存在时按 0 处理
  }
  if (reportIndexCache && mtime === reportIndexMtime) return reportIndexCache;
  const { getMonitorStocks } = require('./monitorStock');
  const stockNames = Array.from(new Set(
    getMonitorStocks().map(s => s.name).filter(Boolean)
  )).sort((a, b) => b.length - a.length); // 长名优先，避免"天孚通信"被"通信"误配
  const index = {};
  try {
    const menu = JSON.parse(fs.readFileSync(menuFile, 'utf-8'));
    const walk = (node, folderDate) => {
      if (!node) return;
      if (node.type === 'folder') {
        const date = String(node.name || '');
        if (!/^\d{8}$/.test(date)) return;
        for (const child of (node.children || [])) walk(child, date);
      } else if (node.type === 'report') {
        const id = String(node.id || '');
        if (!folderDate || !id) return;
        // 标题或正文命中股票名的都计入覆盖（正文如"相关国内标的：天孚通信，仕佳光子"）
        const text = `${String(node.name || '')}\n${readReportContent(id)}`;
        const matchedNames = stockNames.filter(n => text.includes(n));
        if (matchedNames.length === 0) return;
        if (!index[folderDate]) index[folderDate] = {};
        for (const n of matchedNames) {
          index[folderDate][n] = (index[folderDate][n] || 0) + 1;
        }
      }
    };
    for (const root of menu) walk(root, null);
  } catch (e) {
    console.error('研报索引加载失败:', e.message);
  }
  reportIndexCache = index;
  reportIndexMtime = mtime;
  return index;
};

// 某只股票在 winDates（升序）内的研报覆盖总数
const sumReportCount = (stockName, winDates, reportIndex) => {
  if (!stockName || !reportIndex) return 0;
  let count = 0;
  for (const d of winDates) {
    const day = reportIndex[d];
    if (day) count += day[stockName] || 0;
  }
  return count;
};

// ============================================================
// 以下为买点诊断移植（对齐 src/pages/trainingCamp/utils/buyPointChecks.js）
// ============================================================
const minuteToSeconds = (minute) => {
  const m = Number(minute);
  const h = Math.floor(m / 100);
  const mm = m % 100;
  return h * 3600 + mm * 60;
};

const fmtTime = (timeKey) => {
  const t = String(timeKey || '').padStart(6, '0');
  if (t.length < 4) return '--:--:--';
  return `${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`;
};

// 在当前桶之前寻找约 targetMin 分钟前的桶（targetMin±1 分钟内取最近的；找不到回退到至少 targetMin-1 分钟前最近的）
const findBucketMinutesAgo = (buckets, currentIndex, targetMin = 5) => {
  if (currentIndex <= 0) return null;
  const currentSec = minuteToSeconds(buckets[currentIndex].minute);
  const minSec = (targetMin - 1) * 60;
  const maxSec = (targetMin + 1) * 60;
  let hit = null;
  let hitIdx = -1;
  let minDelta = Infinity;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const diff = currentSec - minuteToSeconds(buckets[i].minute);
    if (diff >= minSec && diff <= maxSec) {
      if (diff < minDelta) { minDelta = diff; hit = buckets[i]; hitIdx = i; }
    } else if (diff > maxSec) {
      break;
    }
  }
  if (!hit) {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (currentSec - minuteToSeconds(buckets[i].minute) >= minSec) {
        hit = buckets[i];
        hitIdx = i;
        break;
      }
    }
  }
  return hit ? { bucket: hit, index: hitIdx } : null;
};

// 训练营回放买点诊断（对齐前端 buyPointChecks.js，返回 { success, data } 或 null）
const runBuyPointDiagnosis = (timeBuckets, currentIndex, campData) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return null;
  const current = buckets[currentIndex];
  const checks = [];
  let allPassed = true;
  const targetDateStr = String(campData?.date || '').replace(/-/g, '');

  // 检查2：最近 5min 资金净流入大于 20 亿
  const currentFund = Number(current.fundFlow) || 0;
  const pastFundHit = findBucketMinutesAgo(buckets, currentIndex, 5);
  const fundResult = pastFundHit
    ? {
        hasData: true,
        diff: currentFund - (Number(pastFundHit.bucket.fundFlow) || 0),
        currentValue: currentFund,
        pastValue: Number(pastFundHit.bucket.fundFlow) || 0,
        currentTime: fmtTime(current.timeKey),
        pastTime: fmtTime(pastFundHit.bucket.timeKey),
      }
    : { hasData: false, diff: 0, currentValue: currentFund, pastValue: 0, currentTime: fmtTime(current.timeKey), pastTime: null };
  const fundDiff = parseFloat(fundResult.diff.toFixed(2));
  const checkFundPassed = fundResult.hasData && fundDiff > 20;
  checks.push({
    id: 'fund_inflow',
    title: '最近 5min 资金净流入大于 20 亿',
    passed: checkFundPassed,
    value: fundResult.hasData ? `${fundDiff >= 0 ? '+' : ''}${fundDiff.toFixed(2)}亿` : '数据不足',
    reason: checkFundPassed
      ? `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），超过 20 亿阈值`
      : !fundResult.hasData
        ? '资金数据不足，无法判断最近 5 分钟净流入'
        : `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），未达到 20 亿阈值`,
  });
  if (!checkFundPassed) allPassed = false;

  // 检查3：当前量能（amountChangeDiff = 今日累计成交额 − 昨日全天成交额）为正，且大于 5min 前的值
  const volNow = current.volume !== null && current.volume !== undefined && !Number.isNaN(Number(current.volume)) ? Number(current.volume) : null;
  const pastVolHit = findBucketMinutesAgo(buckets, currentIndex, 5);
  const past2VolHit = pastVolHit ? findBucketMinutesAgo(buckets, pastVolHit.index, 5) : null;
  let volumeResult;
  if (volNow === null) {
    volumeResult = {
      hasData: false, diff: 0, last5minVol: 0, prev5minVol: 0,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
    };
  } else {
    const last5minVol = parseFloat(volNow.toFixed(2));
    const prev5minVol = pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : 0;
    volumeResult = {
      hasData: true,
      diff: parseFloat((last5minVol - prev5minVol).toFixed(2)),
      last5minVol,
      prev5minVol,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
      currentCumulative: parseFloat(volNow.toFixed(2)),
      pastCumulative: pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : null,
      past2Cumulative: past2VolHit ? parseFloat((Number(past2VolHit.bucket.volume) || 0).toFixed(2)) : null,
    };
  }
  const volDiff = volumeResult.hasData ? volumeResult.diff : 0;
  // 判定规则（对齐线上 buySellDiagnose.js）：当前量能为正时只需较 5min 前增加；为负时需增加 100 亿以上
  const checkVolumePassed = !volumeResult.hasData ? false
    : volumeResult.last5minVol > 0
      ? volumeResult.last5minVol > volumeResult.prev5minVol
      : volDiff >= 100;
  const todayHasIceFlag = campData?.todayHasIce === true;
  const prevDayHasIceFlag = campData?.prevDayHasIce === true;
  if (todayHasIceFlag || prevDayHasIceFlag) {
    const iceSource = todayHasIceFlag ? `今日(${targetDateStr.substring(4, 6)}-${targetDateStr.substring(6, 8)})` : '前一交易日';
    checks.push({
      id: 'volume_expansion',
      title: '当前量能为正（今日累计成交额超昨日全天）',
      passed: true,
      exempted: true,
      value: volumeResult.hasData ? `${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿（已豁免）` : '已豁免',
      reason: `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），情绪已达冰点量能条件自动豁免`,
    });
  } else {
    // 量能明细文案（随买入原因汇总展示）：当前量能值 + 最近 5min 变化量
    const volumeText = volumeResult.hasData
      ? `当前量能 ${volumeResult.last5minVol.toFixed(2)}亿，较 5min 前 ${volDiff >= 0 ? '+' : '-'}${Math.abs(volDiff).toFixed(2)}亿`
      : null;
    checks.push({
      id: 'volume_expansion',
      title: '量能较 5min 前增加（负值需增加超 100 亿）',
      passed: checkVolumePassed,
      value: volumeResult.hasData ? `${volDiff >= 0 ? '+' : '-'} ${Math.abs(volDiff).toFixed(2)}亿` : '数据不足',
      volumeText,
      reason: !volumeResult.hasData
        ? '量能数据不足，无法判断当前量能'
        : (() => {
            const volChangeText = volDiff >= 0 ? `+ ${volDiff.toFixed(2)} 亿` : `- ${Math.abs(volDiff).toFixed(2)} 亿`;
            return volumeResult.last5minVol > 0
              ? checkVolumePassed
                ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为正，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，持续放量`
                : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿虽为正，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}`
              : checkVolumePassed
                ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，达到 100 亿阈值`
                : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿仅${volChangeText}，未达到增加 100 亿的阈值`;
          })(),
    });
    if (!checkVolumePassed) allPassed = false;
  }

  // 检查4：开盘后自选股低于开盘价不超过 30 只（仅 9:30-10:00 生效）
  const changes = current.stockChanges || [];
  const inOpeningWindow = Number(current.minute) >= 930 && Number(current.minute) <= 1000;
  if (inOpeningWindow) {
    const openingBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
    const openingMap = new Map((openingBucket?.stockChanges || []).map(s => [s.code, s.changePct]));
    let belowCount = 0;
    let validCount = 0;
    changes.forEach(s => {
      const openPct = openingMap.get(s.code);
      if (openPct !== undefined && openPct !== null) {
        validCount++;
        if (Number(s.changePct) < Number(openPct)) belowCount++;
      }
    });
    const checkOpeningPassed = belowCount <= 30;
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: checkOpeningPassed,
      value: `${belowCount} / ${validCount}只`,
      reason: checkOpeningPassed
        ? `开盘后自选股共 ${validCount} 只，${belowCount} 只现价低于 9:30 开盘价，未超过 30 只`
        : belowCount > 30
          ? `开盘后自选股共 ${validCount} 只，${belowCount} 只现价低于 9:30 开盘价，超过 30 只阈值，市场开盘跳水严重`
          : '分时数据获取异常',
    });
    if (!checkOpeningPassed) allPassed = false;
  } else {
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: true,
      value: '非交易时段',
      reason: '此项检查仅在交易日 9:30-10:00 之间生效，当前时段跳过',
    });
  }

  // 检查6：9:30 竞价开盘科技情绪 > 80 时，后续触发买点要求当前科技情绪 < 40
  const openEmotionBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
  const openingAuctionEmotion = openEmotionBucket && openEmotionBucket.techEmotion !== null && openEmotionBucket.techEmotion !== undefined && !Number.isNaN(Number(openEmotionBucket.techEmotion))
    ? Number(openEmotionBucket.techEmotion)
    : null;
  const currentRetraceEmotion = current.techEmotion !== null && current.techEmotion !== undefined && !Number.isNaN(Number(current.techEmotion))
    ? Number(current.techEmotion)
    : null;

  let checkEmotionRetracePassed;
  let emotionRetraceReason;
  if (openingAuctionEmotion === null) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = '暂无 9:30 竞价科技情绪分时数据，跳过该检查';
  } else if (openingAuctionEmotion <= 80) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 未超过 80，当前情绪须低于 40 的限制不生效`;
  } else if (currentRetraceEmotion === null) {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，但暂无当前分时数据，无法确认情绪回落至 40 以下`;
  } else if (currentRetraceEmotion < 40) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentRetraceEmotion.toFixed(2)} 已回落至 40 以下，允许买入`;
  } else {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentRetraceEmotion.toFixed(2)} 未回落至 40 以下，禁止买入`;
  }
  checks.push({
    id: 'emotion_retrace_after_open',
    title: '竞价情绪超 80 时当前情绪须低于 40',
    passed: checkEmotionRetracePassed,
    value: openingAuctionEmotion === null ? '暂无分时数据' : `开盘 ${openingAuctionEmotion.toFixed(2)} / 当前 ${currentRetraceEmotion === null ? '--' : currentRetraceEmotion.toFixed(2)}`,
    reason: emotionRetraceReason,
  });
  if (!checkEmotionRetracePassed) allPassed = false;

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timeKey: current.timeKey,
      displayTime: current.displayTime || fmtTime(current.timeKey),
      checks,
      allPassed,
      passedCount: checks.filter(c => c.passed).length,
      totalCheckCount: checks.length,
    },
  };
};

// 尾盘抄底命中检查（买卖点回测专用）：
// 抄底时机固定在尾盘 14:57（收盘集合竞价挂单，按触发桶价格成交，价格≈当日收盘价）：
// 判断点取当日第一个 minute ≥ 1457 的回放桶（通常即 1500 收盘桶）；
// 若当日分时数据未覆盖 14:57（如最后一桶为 1455），回退用当日最后一个桶，其余桶一律不触发。
// 命中条件（唯一）：当日科技情绪分时曾触及 -100 退潮冰点（等价于当日科技情绪指数 hasIce: true）
const checkTailDipHit = (timeBuckets, currentIndex) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return false;
  // 注意：回放桶的 minute 为 HHMM 整数（如 1457 表示 14:57），与 runBuyPointDiagnosis 开盘窗口（930-1000）口径一致
  let triggerIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) >= 1457) { triggerIdx = i; break; }
  }
  if (triggerIdx === -1) triggerIdx = buckets.length - 1; // 数据未覆盖 14:57 时回退最后一个桶，避免条件永不命中
  if (currentIndex !== triggerIdx) return false;

  // 当日科技情绪分时曾触及 -100（hasIce）；仅统计截至当前时点的分时，避免使用未来数据
  return buckets.slice(0, currentIndex + 1).some((b) => {
    const e = b.techEmotion == null ? null : Number(b.techEmotion);
    return e != null && !Number.isNaN(e) && e <= -100;
  });
};

// ===== 买入原因构建（随成交记录/缓存/回测报告落盘，供前端与报告展示命中了哪些买入条件） =====
// 尾盘抄底策略的固定买入原因（命中条件唯一：当日科技情绪分时曾触及 -100 退潮冰点）
const TAIL_DIP_BUY_INFO = {
  buyReason: '尾盘抄底命中：当日科技情绪曾触及-100退潮冰点',
  buyChecks: [{
    id: 'tail_dip',
    title: '尾盘抄底命中（当日科技情绪曾触及-100退潮冰点）',
    passed: true,
    value: '14:57',
    reason: '当日科技情绪分时曾触及 -100 退潮冰点（等价 hasIce: true），14:57 尾盘挂单买入（收盘集合竞价成交）',
  }],
};

// 由买点诊断结果构建买入原因：buyReason 为全部命中条件标题汇总（与 sellReason 命中卖出条件名口径一致），
// 量能项额外附带当前量能值与最近 5min 变化量；buyChecks 为逐项明细（含数值与判定理由），
// allPassed !== true 时返回空
const buildBuyReasonFromDiag = (diagData) => {
  if (!diagData || diagData.allPassed !== true) return { buyReason: '', buyChecks: [] };
  const passedChecks = (diagData.checks || []).filter(c => c.passed);
  return {
    buyReason: passedChecks.map(c => (
      c.id === 'volume_expansion' && c.volumeText
        ? `${c.title}：${c.volumeText}`
        : c.title
    )).join('、') || '买点诊断全部通过',
    buyChecks: (diagData.checks || []).map(c => ({
      id: c.id,
      title: c.title,
      passed: !!c.passed,
      exempted: !!c.exempted,
      value: c.value,
      reason: c.reason,
      ...(c.volumeText ? { volumeText: c.volumeText } : {}),
    })),
  };
};

// ============================================================
// 以下为抗分歧指数移植（对齐 src/utils/replayResilience.js）
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

// 尾盘抄底专属卖点检查（1 分钟维度）：
//   开盘后逐分钟环比跟踪：当前分钟涨幅（相对昨收）与上一分钟涨幅比较——
//   一直在上涨（ curr > prev ）→ 先不卖出继续持有；首次开始下降（ curr < prev ）→ 在该分钟卖出。
//   涨幅持平视为尚未开始下降，继续持有；开盘首分钟无上一分钟可比，仅作为基准；
//   若全天持续上涨未出现下降则当日不卖，次日继续跟踪。
// 数据源：getSingleStockTlineDataByDate 分钟级分时（磁盘/内存缓存）；拉取失败时回退用 5min 桶回放点近似
const checkOpenRetraceSell = async (replayStocks, code, currentMinute, dateStr) => {
  let points = [];
  try {
    const tline = await getSingleStockTlineDataByDate(code, parseInt(dateStr));
    points = (tline?.line || [])
      .filter(p => p.minute != null && Number(p.minute) <= currentMinute
        && p.change != null && !Number.isNaN(Number(p.change))
        && p.last_px != null && Number(p.last_px) > 0)
      .map(p => ({ minute: Number(p.minute), change: Number(p.change), lastPx: Number(p.last_px) }));
  } catch (e) { /* 拉取失败走回退 */ }
  if (points.length === 0) {
    points = getTlinePoints(replayStocks, code, currentMinute)
      .filter(p => p.change != null && !Number.isNaN(Number(p.change)) && p.lastPx != null && p.lastPx > 0);
  }
  // 逐分钟环比：首个较上一分钟开始下降的分钟即卖点（首分钟仅作基准）
  for (let i = 1; i < points.length; i++) {
    if (points[i].change < points[i - 1].change) {
      return {
        satisfied: true,
        triggerMinute: points[i].minute,
        triggerPrice: points[i].lastPx,
        prevChange: points[i - 1].change,
        currentChange: points[i].change,
        retrace: points[i - 1].change - points[i].change,
      };
    }
  }
  const last = points.length > 0 ? points[points.length - 1] : null;
  return {
    satisfied: false,
    triggerMinute: null,
    triggerPrice: null,
    prevChange: points.length > 1 ? points[points.length - 2].change : null,
    currentChange: last ? last.change : null,
    retrace: null,
  };
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

  // ===== 尾盘抄底策略专属卖点：开盘后逐分钟环比跟踪，涨幅开始下降（较上一分钟回落）即卖出（1 分钟维度，独立于下方 7 项通用条件） =====
  if (position?.tailDipSell === true) {
    const retraceCheck = await checkOpenRetraceSell(replayStocks, code, minute, dateStr);
    // 卖出价/卖出时间用分钟级触发点（精确到触发分钟），而非当前 5min 桶
    const sellPrice = retraceCheck.satisfied && retraceCheck.triggerPrice != null ? retraceCheck.triggerPrice : closePrice;
    const sellDisplayTime = retraceCheck.satisfied && retraceCheck.triggerMinute != null
      ? fmtTime(String(retraceCheck.triggerMinute).padStart(4, '0') + '00').substring(0, 5)
      : displayTime;
    const tailReturnRate = buyPrice !== null && buyPrice > 0 && sellPrice > 0
      ? parseFloat((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2))
      : null;
    const condition = {
      name: '开盘后涨幅开始下降即卖出',
      satisfied: retraceCheck.satisfied,
      detail: retraceCheck.currentChange == null
        ? '当前涨幅数据缺失，无法判断'
        : retraceCheck.satisfied
          ? `${sellDisplayTime} 涨幅 ${retraceCheck.currentChange.toFixed(2)}%，较上一分钟 ${retraceCheck.prevChange != null ? retraceCheck.prevChange.toFixed(2) : '--'}% 开始下降（回落 ${retraceCheck.retrace != null ? retraceCheck.retrace.toFixed(2) : '--'} 个百分点），按触发分钟价格卖出`
          : `开盘后涨幅持续上涨未开始下降（当前 ${retraceCheck.currentChange.toFixed(2)}%），继续持有`,
      subConditions: [],
    };
    const conditions = [condition];
    return {
      isSell: condition.satisfied,
      code,
      stockName,
      closePrice: parseFloat(sellPrice.toFixed(2)),
      change: change !== null ? parseFloat(change.toFixed(2)) : null,
      returnRate: tailReturnRate,
      dayHigh: dayHigh > 0 ? parseFloat(dayHigh.toFixed(2)) : null,
      techEmotion: currentBucket?.techEmotion != null ? toNumber(currentBucket.techEmotion) : null,
      resilienceScore: null,
      conditions,
      conclusion: condition.satisfied
        ? `尾盘抄底专属卖点：${sellDisplayTime} 涨幅开始下降（较上一分钟回落），卖出离场`
        : '尾盘抄底专属卖点未触发（开盘后涨幅持续上涨尚未开始下降），继续持有',
      displayTime: sellDisplayTime,
    };
  }

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
    subConditions: [],
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
    conclusion: isSell
      ? `共触发 ${satisfiedCount} 个卖出条件（${conditions.filter(c => c.satisfied).map(c => c.name).join('、')}），建议卖出离场`
      : '所有卖出条件均未触发，当前可继续持有',
    displayTime,
  };
};

// ============================================================
// 回放股票结构构建（对齐 trainingCamp/index.jsx 中 replayStocks 的 useMemo 构建逻辑，全量时间桶）
// ============================================================
const buildReplayStocks = (campData) => {
  const timeBuckets = campData?.timeBuckets || [];
  const stockMap = new Map();
  const indexTline = { sh000688: [], sz399006: [] };
  const indexNames = { sh000688: '科创指数', sz399006: '创业板指数' };
  for (const bucket of timeBuckets) {
    const itl = bucket.indexTline || {};
    if (itl.kcb && itl.kcb.changePct != null) {
      indexTline.sh000688.push({ minute: bucket.minute, change: itl.kcb.changePct, lastPx: itl.kcb.price });
    }
    if (itl.cyb && itl.cyb.changePct != null) {
      indexTline.sz399006.push({ minute: bucket.minute, change: itl.cyb.changePct, lastPx: itl.cyb.price });
    }
    for (const sc of bucket.stockChanges) {
      if (!stockMap.has(sc.code)) {
        const lowByCode = campData.dailyLowByCode || {};
        stockMap.set(sc.code, { code: sc.code, stockName: sc.name, tlinePoints: [], dailyLowMap: lowByCode[sc.code] || null });
      }
      if (sc.changePct != null) {
        stockMap.get(sc.code).tlinePoints.push({ minute: bucket.minute, change: sc.changePct, lastPx: sc.lastPx });
      }
    }
  }
  Object.entries(indexTline).forEach(([code, points]) => {
    if (points.length > 0) {
      stockMap.set(code, { code, stockName: indexNames[code], isDefaultIndex: true, tlinePoints: points });
    }
  });
  return Array.from(stockMap.values()).filter(s => s.tlinePoints.length > 0);
};

// 计算某只股票截至当前 minute 的日内抗分歧分数（供单股策略选股用，与卖点诊断条件4口径一致）
const calcResilienceAtMinute = (replayStocks, code, minute) => {
  const isSh688 = String(code).toLowerCase().startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const stockPoints = getTlinePoints(replayStocks, code, minute).filter(p => p.lastPx != null && p.lastPx > 0);
  const indexPoints = getTlinePoints(replayStocks, indexCode, minute);
  if (stockPoints.length < 5 || indexPoints.length < 5) return null;
  const raw = calculateReplayResilience(stockPoints, indexPoints, code);
  return raw != null ? parseFloat(raw.toFixed(2)) : null;
};

// 从回放数据提取每个股票「当日 EOD」信息：收盘涨幅、收盘价、当日抗分歧分数
// （当日抗分歧分数取 resilience3dScores 的最后一位，即 score(当天)，与 resilience3d 口径一致）
const extractDailyInfo = (campData) => {
  const buckets = campData?.timeBuckets || [];
  const lastBucket = buckets[buckets.length - 1];
  const info = new Map();
  for (const sc of lastBucket?.stockChanges || []) {
    let resilience = null;
    if (Array.isArray(sc.resilience3dScores) && sc.resilience3dScores.length === 3) {
      const today = sc.resilience3dScores[2];
      if (today != null && !Number.isNaN(Number(today))) resilience = Number(today);
    }
    info.set(sc.code, {
      code: sc.code,
      name: sc.name || sc.code,
      changePct: sc.changePct != null ? Number(sc.changePct) : null,
      closePx: sc.lastPx != null ? Number(sc.lastPx) : null,
      resilience,
    });
  }
  return info;
};

// 窗口累计涨幅：winDates 最后一位为当日（用盘中涨幅），其余为历史 EOD 涨幅，复利相乘
const computeWindowGain = (code, winDates, dailyInfos, todayIntradayChange) => {
  let prod = 1;
  for (let i = 0; i < winDates.length; i++) {
    let ch;
    if (i === winDates.length - 1) {
      ch = todayIntradayChange != null ? Number(todayIntradayChange) : null;
    } else {
      ch = dailyInfos.get(winDates[i])?.get(code)?.changePct;
    }
    if (ch == null || !Number.isFinite(ch)) return null;
    prod *= 1 + ch / 100;
  }
  return (prod - 1) * 100;
};

// 窗口抗分歧分数汇总：winDates 最后一位为当日（用盘中分数），其余为历史 EOD 分数
const computeWindowResilience = (code, winDates, dailyInfos, todayIntradayResilience) => {
  let sum = 0;
  for (let i = 0; i < winDates.length; i++) {
    let r;
    if (i === winDates.length - 1) {
      r = todayIntradayResilience != null ? Number(todayIntradayResilience) : null;
    } else {
      r = dailyInfos.get(winDates[i])?.get(code)?.resilience;
    }
    if (r == null || !Number.isFinite(r)) return null;
    sum += r;
  }
  return sum;
};

// 抗分歧弱转强选股：取最近 4 个交易日（最后一位为当日，用盘中过滤后的抗分歧分数）每只股票的抗分歧分数，
// 先筛选出「买点触发时抗分歧分数 > 11」的股票，再从中计算「前两天均值」与「后两天均值」（第 3 天+当日，即最近两天）的差值
// diff = 后两天均值 - 前两天均值。diff 越大代表抗分歧由弱转强越明显，选 diff 最大的一只；diff 相同（弱转强过程一致）时，取当日盘中涨幅最大的一只。
const pickWeakToStrongStock = (bucket, rangeDates, di, replayStocks, dailyInfos) => {
  const winDates = rangeDates.slice(Math.max(0, di - 3), di + 1); // 最近 4 个交易日
  if (winDates.length < 4) return null; // 4 日窗口不足，不构成弱转强
  let best = null; // { sc, diff, gain }
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    const scores = [];
    for (let i = 0; i < winDates.length; i++) {
      let r;
      if (i === winDates.length - 1) {
        // 当日：用当前分钟的日内抗分歧分数
        r = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      } else {
        r = dailyInfos.get(winDates[i])?.get(sc.code)?.resilience;
      }
      if (r == null || !Number.isFinite(r)) {
        scores.length = 0;
        break;
      }
      scores.push(Number(r));
    }
    if (scores.length < 4) continue;
    if (!(scores[3] > 11)) continue; // 买点触发时当日抗分歧分数需 > 11 才参与弱转强优选
    const first2Avg = (scores[0] + scores[1]) / 2; // 前两天均值
    const last2Avg = (scores[2] + scores[3]) / 2; // 最近两天均值（含当日）
    const diff = last2Avg - first2Avg;
    const gain = sc.changePct != null ? Number(sc.changePct) : -Infinity;
    if (!best || diff > best.diff + 1e-9 || (Math.abs(diff - best.diff) <= 1e-9 && gain > best.gain)) {
      best = { sc, diff, gain };
    }
  }
  if (!best) return null;
  return { stock: best.sc, metric: parseFloat(best.diff.toFixed(4)) };
};

// 计算 N 日线斜率角度：以「N 日涨幅均线」为观测线（用涨幅替代价格，消除不同股票价格差异）
// avgRet(d) = 近 N 个交易日涨幅均值，今日涨幅用当前盘中涨幅（避免未来数据），其余用历史 EOD 涨幅
// 斜率Δ（每日变化，% / 天）= avgRet(今日) - avgRet(昨日)
// 角度（度）= atan(Δ) * 180 / π；取当日角度最大（即线最陡峭）的股票买入
const computeMaSlopeAngle = (code, days, di, rangeDates, dailyInfos, todayIntradayChange) => {
  if (!days || todayIntradayChange == null || !Number.isFinite(Number(todayIntradayChange))) return null;
  if (di < days) return null; // 历史日不足，无法得到「昨日N日涨幅均线」
  // 今日N日涨幅均线 = (今日盘中涨幅 + 最近 days-1 个历史 EOD 涨幅) / days
  const todayRets = [Number(todayIntradayChange)];
  for (let i = di - 1; i >= 0 && todayRets.length < days; i--) {
    const r = dailyInfos.get(rangeDates[i])?.get(code)?.changePct;
    if (r == null || !Number.isFinite(Number(r))) return null;
    todayRets.push(Number(r));
  }
  if (todayRets.length < days) return null;
  // 昨日N日涨幅均线 = 最近 days 个历史 EOD 涨幅 / days
  const yestRets = [];
  for (let i = di - 1; i >= di - days; i--) {
    if (i < 0) return null;
    const r = dailyInfos.get(rangeDates[i])?.get(code)?.changePct;
    if (r == null || !Number.isFinite(Number(r))) return null;
    yestRets.push(Number(r));
  }
  if (yestRets.length < days) return null;
  const avgToday = todayRets.reduce((a, b) => a + b, 0) / days;
  const avgYesterday = yestRets.reduce((a, b) => a + b, 0) / days;
  if (!Number.isFinite(avgToday) || !Number.isFinite(avgYesterday)) return null;
  const delta = avgToday - avgYesterday; // 斜率（百分点 / 天）
  const angle = Math.atan(delta) * 180 / Math.PI; // 转化为角度
  return angle;
};

// 单股策略选股：在买点命中的当前时间桶，按策略指标选择最优的一只股票。
// 抗分歧>11 顺延门槛仅对 RESILIENCE_GATE_STRATEGY_IDS（买入最高涨幅/2日涨幅最大）启用：
// 排名首位不满足则按策略排名依次顺延至下一只满足的股票，skipped 记录被顺延跳过的前序股票（供买入明细标注）；
// 其余策略不做抗分歧校验，直接取排名指定名次的第一只
const pickBestStock = (stocks, rangeDates, di, bucket, replayStocks, dailyInfos, strategyId) => {
  const isReportStrategy = strategyId.includes('reports');
  const isTop5ReportGainMode = strategyId.includes('reports_top5_gain'); // 研报覆盖前五（含覆盖数相同）中取窗口涨幅最大
  const isPureReportMode = isReportStrategy && !isTop5ReportGainMode; // 研报覆盖数最多/第二多
  const isMaSlopeMode = strategyId.includes('ma_slope'); // 均线斜率最陡峭（3日/5日）
  const useSecond = strategyId.includes('_2nd');
  // 尾盘抄底反向选股：跌幅最大/抗分歧分数最低（取窗口指标最小值而非最大值）
  const lowMode = strategyId.includes('_fall') || strategyId.includes('_resilience_low');
  const dayMatch = strategyId.match(/(\d+)d/);
  const days = dayMatch ? Number(dayMatch[1]) : null;

  // 抗分歧弱转强：使用独立的 5 日窗口弱转强选股逻辑（已内置「当日分数 > 11 参与优选」门槛）
  if (strategyId === 'resilience_weak_to_strong') {
    return pickWeakToStrongStock(bucket, rangeDates, di, replayStocks, dailyInfos);
  }

  // 涨幅/抗分歧窗口按 days 天
  let winDates;
  if (strategyId === 'highest_gain') {
    winDates = rangeDates.slice(0, di + 1); // 回测起始日至当日
  } else if (days) {
    winDates = rangeDates.slice(Math.max(0, di - days + 1), di + 1);
  } else {
    winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  }
  // 研报覆盖窗口与涨幅/抗分歧窗口一致（按对应 3 天/5 天统计）
  let reportWinDates = null;
  if (isReportStrategy && days) {
    reportWinDates = winDates;
  }
  // 跌幅最大（_fall）与涨幅共用窗口涨幅指标，仅取最小值；其余照旧
  const gainMode = strategyId === 'highest_gain' || strategyId.includes('_gain') || strategyId.includes('_fall');

  // 收集全部候选（与原 best/second 口径一致：按指标值排序，同值保持自选股原顺序）
  const candidates = [];
  const top5Candidates = isTop5ReportGainMode ? [] : null;
  const reportIndex = isReportStrategy ? loadReportIndex() : null;
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (stocks.has(sc.code) && stocks.get(sc.code).holding) continue;
    let val;
    let metric = null;
    if (isMaSlopeMode) {
      // 涨幅均线斜率角度：用当前盘中涨幅作为"今日涨幅均线"的今日成分，避免未来数据
      const angle = computeMaSlopeAngle(sc.code, days, di, rangeDates, dailyInfos, Number(sc.changePct));
      if (angle == null || !Number.isFinite(angle)) continue;
      val = angle;
      metric = parseFloat(angle.toFixed(4));
    } else if (isTop5ReportGainMode) {
      // 收集研报覆盖数与涨幅候选，事后按覆盖数取前五再按涨幅最大选股
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      top5Candidates.push({ sc, reportCount, gain });
      continue;
    }
    if (isPureReportMode) {
      // 研报覆盖数最多/第二多（按对应 days 天统计）；覆盖数相同取 days 天涨幅最大
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      val = reportCount * 100000 + gain;
      metric = reportCount;
    } else if (gainMode) {
      val = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
    } else {
      const intradayResilience = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      val = computeWindowResilience(sc.code, winDates, dailyInfos, intradayResilience);
    }
    if (val == null || !Number.isFinite(val)) continue;
    candidates.push({ sc, val, metric: metric != null ? metric : parseFloat(val.toFixed(4)) });
  }

  // 构建策略排名序列
  let ordered; // [{ sc, metric }]
  if (isTop5ReportGainMode) {
    // 研报覆盖数降序取前五（覆盖数相同的股票全部纳入），组内按窗口涨幅降序；
    // 前五组之后按涨幅降序接在后面（仅在组内全部不满足抗分歧门槛时才会顺延到）
    if (!top5Candidates.length) return null;
    top5Candidates.sort((a, b) => b.reportCount - a.reportCount);
    const threshold = top5Candidates[Math.min(4, top5Candidates.length - 1)].reportCount;
    const topGroup = top5Candidates.filter(c => c.reportCount >= threshold).sort((a, b) => b.gain - a.gain);
    const restGroup = top5Candidates.filter(c => c.reportCount < threshold).sort((a, b) => b.gain - a.gain);
    ordered = topGroup.concat(restGroup).map(c => ({ sc: c.sc, metric: c.reportCount }));
  } else {
    ordered = candidates.slice().sort((a, b) => (lowMode ? a.val - b.val : b.val - a.val))
      .map(c => ({ sc: c.sc, metric: c.metric }));
  }

  // 抗分歧>11 门槛：仅最高涨幅/2日涨幅最大策略启用，从策略指定名次（_2nd 策略从第 2 名开始）向后找
  // 第一只满足的股票；其余策略不做校验，直接取指定名次的第一只（与原逻辑一致）
  const gateEnabled = RESILIENCE_GATE_STRATEGY_IDS.has(strategyId);
  const skipped = []; // 因分数≤11（或无法计算）被顺延跳过的前序股票（仅门槛策略使用）
  for (let i = useSecond ? 1 : 0; i < ordered.length; i++) {
    const cand = ordered[i];
    if (gateEnabled) {
      const score = calcResilienceAtMinute(replayStocks, cand.sc.code, bucket.minute);
      if (score != null && score > RESILIENCE_GATE_MIN) {
        return { stock: cand.sc, metric: cand.metric, resilienceScore: score, skipped };
      }
      skipped.push({ code: cand.sc.code, name: cand.sc.name || cand.sc.code, resilience: score });
    } else {
      return { stock: cand.sc, metric: cand.metric };
    }
  }
  return null; // 门槛策略：全部候选均不满足门槛，不买入；其余策略：无候选
};

// ============================================================
// 买入条件明细中的选股顺延标注（抗分歧>11 门槛）
// ============================================================
// 抗分歧门槛明细项（passed 恒为 true：能入选即代表满足门槛），reason 标明是否因前序股票分数≤11 而顺延
const buildResilienceGateCheck = (resilienceScore, skipped) => {
  const skipText = (skipped || []).map(s => `${s.name}（${s.resilience != null ? s.resilience : '无法计算'}）`).join('、');
  return {
    id: 'resilience_gate',
    title: '触发时点抗分歧分数>11',
    passed: true,
    value: resilienceScore != null ? `${resilienceScore}` : '--',
    reason: skipped && skipped.length > 0
      ? `因前序股票 ${skipText} 触发时点抗分歧分数≤11 依次顺延，轮到本股买入（本股触发时点抗分歧分数 ${resilienceScore}）`
      : `按策略指定名次直接满足，未发生顺延（触发时点抗分歧分数 ${resilienceScore}）`,
  };
};

// 将选股顺延信息追加到买入原因/明细：发生顺延时在 buyReason 尾部标注，buyChecks 追加 resilience_gate 明细项。
// 仅 RESILIENCE_GATE_STRATEGY_IDS 两个策略的选股结果带 resilienceScore/skipped，其余策略（含抗分歧弱转强）
// 返回结构不含该字段，此处自动跳过标注（买入原因/明细保持原样）
const withResilienceGateInfo = (buyInfo, picked) => {
  if (!buyInfo || !picked || picked.resilienceScore == null) return buyInfo;
  return {
    buyReason: picked.skipped && picked.skipped.length > 0
      ? `${buyInfo.buyReason}（因前序股票抗分歧≤11顺延买入）`
      : buyInfo.buyReason,
    buyChecks: [...(buyInfo.buyChecks || []), buildResilienceGateCheck(picked.resilienceScore, picked.skipped)],
  };
};

// ============================================================
// 三日涨幅四份仓位策略选股：买点命中时取最近 3 个交易日涨幅排名前 4 的股票（各占 1/4）
// ============================================================
const pickQuarterStocks = (bucket, rangeDates, di, dailyInfos, heldCodes) => {
  const winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  const candidates = [];
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (heldCodes.has(sc.code)) continue;
    const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
    if (gain == null || !Number.isFinite(gain)) continue;
    candidates.push({ sc, gain });
  }
  candidates.sort((a, b) => b.gain - a.gain);
  return candidates.slice(0, 4);
};

// ============================================================
// 三日涨幅两个股票策略选股：按空仓份数取最近 3 个交易日涨幅排名靠前的股票
//   needCount=2：两份均空仓，买入涨幅最大与第二大（各 1/2）
//   needCount=1：仅一份空仓，只买入涨幅最大的一只（排除已持仓）
// ============================================================
const pickTwoStocks = (bucket, rangeDates, di, dailyInfos, heldCodes, needCount) => {
  const winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  const candidates = [];
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (heldCodes.has(sc.code)) continue;
    const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
    if (gain == null || !Number.isFinite(gain)) continue;
    candidates.push({ sc, gain });
  }
  candidates.sort((a, b) => b.gain - a.gain);
  return candidates.slice(0, needCount).map(c => ({ sc: c.sc, gain: c.gain }));
};

// ============================================================
// 三日涨幅四份仓位回测主循环：
//   买点触发且彻底空仓时把仓位分成四份，买入三日涨幅排名前四的股票（各 1/4）。
//   任一只触发卖点即独立卖出；仅当四份全部清仓后才允许下一次买点重新四份建仓。
//   结果结构兼容单股策略（type: 'single'：trades 为每份独立卖出成交，currentHolding 为期末首笔持仓）。
// ============================================================
const runQuarterBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  const strategy = STRATEGIES[strategyId];

  let positions = []; // 最多 4 份持仓：{ code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
  const trades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息与回测期间出现过的自选股
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 卖出：对每只持仓独立诊断，任一只触发卖点即独立卖出（同日买入不可同日卖出）
    const soldCodes = new Set();
    for (const pos of positions) {
      if (soldCodes.has(pos.code)) continue;
      if (dateStr <= pos.buyDate) continue;
      const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate };
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
        if (result.isSell && result.closePrice != null) {
          const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
          trades.push({
            seq: trades.length + 1,
            metric: pos.metric,
            code: pos.code,
            stockName: pos.stockName,
            buyDate: pos.buyDate,
            buyDateDisplay: pos.buyDateDisplay,
            buyTime: pos.buyTime,
            buyPrice: pos.buyPrice,
            buyChange: pos.buyChange,
            buyReason: pos.buyReason,
            buyChecks: pos.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: result.displayTime,
            sellPrice: result.closePrice,
            sellChange: result.change,
            sellReason: satisfiedNames || '卖出条件触发',
            returnRate: result.returnRate,
          });
          soldCodes.add(pos.code);
          break;
        }
      }
    }
    positions = positions.filter(p => !soldCodes.has(p.code));

    // 买入：仅当四份全部清仓（彻底空仓）时，买点触发才重新四份建仓
    if (positions.length === 0) {
      const heldCodes = new Set();
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const buyResult = runBuyPointDiagnosis(timeBuckets, bi, campData);
        if (buyResult?.data?.allPassed === true) {
          const buyInfo = buildBuyReasonFromDiag(buyResult.data);
          const buyTime = fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM
          const picks = pickQuarterStocks(bucket, rangeDates, di, dailyInfos, heldCodes);
          for (const pick of picks) {
            const sc = pick.sc;
            positions.push({
              code: sc.code,
              stockName: sc.name || sc.code,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime,
              buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
              buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
              metric: parseFloat(pick.gain.toFixed(4)),
              buyReason: buyInfo.buyReason,
              buyChecks: buyInfo.buyChecks,
            });
            heldCodes.add(sc.code);
          }
          break; // 同一个买点触发仅建仓一次（四份）
        }
      }
    }
  }

  // 组装结果：整体收益率按仓位权重计算（每份仓位占总额的 1/4，单笔收益率 × 0.25 后加总）。
  // 期末仍有多份持仓时，整体收益率计入相应权重，展示取首笔持仓
  const QUARTER_WEIGHT = 0.25; // 每份仓位权重（四份均分）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) {
      overallReturn += QUARTER_WEIGHT * t.returnRate;
    }
  }
  let holding = null;
  if (positions.length > 0) {
    const first = positions[0];
    holding = { ...first };
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(first.code);
      if (info && info.closePx != null && info.closePx > 0) {
        holding.buyReturn = first.buyPrice > 0
          ? parseFloat((((info.closePx - first.buyPrice) / first.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) {
      overallReturn += QUARTER_WEIGHT * holding.buyReturn;
    }
  }
  overallReturn = parseFloat(overallReturn.toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      overallReturn,
      holding: positions.length > 0,
    },
  };
};

// ============================================================
// 三日涨幅两个股票回测主循环：
//   仓位分成两份（各占 1/2）。两份均空仓时，买点触发买入三日涨幅最大与第二大两只股票；仅一份空仓时，买点触发只买入涨幅最大的一只。
//   任一只触发卖点即独立卖出；空仓的份数会在后续买点触发时按上述规则补仓。
//   结果结构兼容单股策略（type: 'single'：trades 为每份独立卖出成交，currentHolding 为期末首笔持仓）。
// ============================================================
const runTwoBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  const strategy = STRATEGIES[strategyId];

  let positions = []; // 最多 2 份持仓：{ code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
  const trades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息与回测期间出现过的自选股
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 卖出：对每只持仓独立诊断，任一只触发卖点即独立卖出（同日买入不可同日卖出）
    const soldCodes = new Set();
    for (const pos of positions) {
      if (soldCodes.has(pos.code)) continue;
      if (dateStr <= pos.buyDate) continue;
      const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate };
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
        if (result.isSell && result.closePrice != null) {
          const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
          trades.push({
            seq: trades.length + 1,
            metric: pos.metric,
            code: pos.code,
            stockName: pos.stockName,
            buyDate: pos.buyDate,
            buyDateDisplay: pos.buyDateDisplay,
            buyTime: pos.buyTime,
            buyPrice: pos.buyPrice,
            buyChange: pos.buyChange,
            buyReason: pos.buyReason,
            buyChecks: pos.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: result.displayTime,
            sellPrice: result.closePrice,
            sellChange: result.change,
            sellReason: satisfiedNames || '卖出条件触发',
            returnRate: result.returnRate,
          });
          soldCodes.add(pos.code);
          break;
        }
      }
    }
    positions = positions.filter(p => !soldCodes.has(p.code));

    // 买入：空仓份数按涨幅排名补仓
    //   两份均空仓（positions.length===0）→ 买入涨幅最大 + 第二大（各 1/2）
    //   仅一份空仓（positions.length===1）→ 只买入涨幅最大的一只（排除已持仓）
    const idleSlots = 2 - positions.length;
    if (idleSlots > 0) {
      const heldCodes = new Set(positions.map(p => p.code));
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];
        const buyResult = runBuyPointDiagnosis(timeBuckets, bi, campData);
        if (buyResult?.data?.allPassed === true) {
          const buyInfo = buildBuyReasonFromDiag(buyResult.data);
          const buyTime = fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM
          const picks = pickTwoStocks(bucket, rangeDates, di, dailyInfos, heldCodes, idleSlots);
          for (const pick of picks) {
            const sc = pick.sc;
            positions.push({
              code: sc.code,
              stockName: sc.name || sc.code,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime,
              buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
              buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
              metric: parseFloat(pick.gain.toFixed(4)),
              buyReason: buyInfo.buyReason,
              buyChecks: buyInfo.buyChecks,
            });
            heldCodes.add(sc.code);
          }
          break; // 同一个买点触发仅建仓一次
        }
      }
    }
  }

  // 组装结果：整体收益率按仓位权重计算（每份仓位占总额的 1/2，单笔收益率 × 0.5 后加总）。
  // 期末仍有多份持仓时，整体收益率计入相应权重，展示取首笔持仓
  const HALF_WEIGHT = 0.5; // 每份仓位权重（两份均分）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) {
      overallReturn += HALF_WEIGHT * t.returnRate;
    }
  }
  let holding = null;
  if (positions.length > 0) {
    const first = positions[0];
    holding = { ...first };
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(first.code);
      if (info && info.closePx != null && info.closePx > 0) {
        holding.buyReturn = first.buyPrice > 0
          ? parseFloat((((info.closePx - first.buyPrice) / first.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) {
      overallReturn += HALF_WEIGHT * holding.buyReturn;
    }
  }
  overallReturn = parseFloat(overallReturn.toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      overallReturn,
      holding: positions.length > 0,
    },
  };
};

// ============================================================
// 多日回测主循环
// ============================================================
const runRangeBacktest = async (startDate, endDate, strategyId = 'highest_gain', onProgress) => {
  // 情绪游资系列策略走独立回测逻辑（不依赖后端回放缓存，日期范围不受 fundSnapshot 限制）
  if (isSentimentStrategy(strategyId)) {
    return runSentimentBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 三日涨幅四份仓位策略走独立的多持仓回测逻辑
  if (strategyId === 'highest_3d_gain_quarter') {
    return runQuarterBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 三日涨幅两个股票策略走独立的多持仓回测逻辑
  if (strategyId === 'highest_3d_gain_two') {
    return runTwoBacktest(startDate, endDate, strategyId, onProgress);
  }
  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }
  const strategy = STRATEGIES[strategyId];

  // 单股策略的持仓状态（同一时刻仅一只股票）
  let singlePosition = null; // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
  // 两次买入策略挂起的首笔半仓（买点触发当日先买 5 成，等收盘补足剩余 5 成后再建立正式持仓）
  let pendingHalfBuy = null; // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice1, buyChange1, metric, closePrice }
  const singleTrades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息：{ date: Map<code, {changePct, closePx, resilience}> }
  const dailyInfos = new Map();
  // 回测期间出现过的全部自选股（供复制K线等使用）
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用）
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    // 记录回测期间出现过的全部自选股（供前端复制K线等使用）
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    const sellPositions = async (bi) => {
      const bucket = timeBuckets[bi];
      // 单股策略：仅诊断唯一持仓（尾盘抄底策略走专属卖点）
      if (!singlePosition) return;
      if (dateStr <= singlePosition.buyDate) return;
      const position = { code: singlePosition.code, stockName: singlePosition.stockName, buyPrice: singlePosition.buyPrice, buyDate: singlePosition.buyDate, tailDipSell: strategy.tailDip === true };
      const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
      if (result.isSell && result.closePrice != null) {
        const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
        singleTrades.push({
          seq: singleTrades.length + 1,
          metric: singlePosition.metric,
          code: singlePosition.code,
          stockName: singlePosition.stockName,
          buyDate: singlePosition.buyDate,
          buyDateDisplay: singlePosition.buyDateDisplay,
          buyTime: singlePosition.buyTime,
          buyPrice: singlePosition.buyPrice,
          buyChange: singlePosition.buyChange,
          buyReason: singlePosition.buyReason,
          buyChecks: singlePosition.buyChecks,
          sellDate: dateStr,
          sellDateDisplay: dateDisplay,
          sellTime: result.displayTime,
          sellPrice: result.closePrice,
          sellChange: result.change,
          sellReason: satisfiedNames || '卖出条件触发',
          returnRate: result.returnRate,
        });
        singlePosition = null;
      }
    };

    const isTwice = strategy.id === 'highest_3d_gain_twice'; // 两次买入策略（选股同 3 日涨幅最大，仅建仓成本计算不同）
    const lastBucket = timeBuckets[timeBuckets.length - 1]; // 用于两次买入策略的收盘补仓
    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];

      // 两次买入策略：非收盘桶上，先建立挂起的首笔半仓（买点触发当日不等收盘）
      if (isTwice && pendingHalfBuy && bucket === lastBucket) {
        const closeStock = (bucket.stockChanges || []).find(s => s.code === pendingHalfBuy.code);
        const closePrice = closeStock?.lastPx != null && closeStock.lastPx > 0 ? Number(closeStock.lastPx) : null;
        if (closePrice != null) {
          // 成本价 = (首笔半仓买入价 + 收盘补仓买入价) / 2
          const avgPrice = parseFloat(((pendingHalfBuy.buyPrice1 + closePrice) / 2).toFixed(2));
          const closeChange = closeStock.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : pendingHalfBuy.buyChange1;
          singlePosition = {
            code: pendingHalfBuy.code,
            stockName: pendingHalfBuy.stockName,
            buyDate: pendingHalfBuy.buyDate,
            buyDateDisplay: pendingHalfBuy.buyDateDisplay,
            buyTime: pendingHalfBuy.buyTime,
            buyPrice: avgPrice,
            buyChange: closeChange,
            metric: pendingHalfBuy.metric,
            buyReason: pendingHalfBuy.buyReason,
            buyChecks: pendingHalfBuy.buyChecks,
          };
        }
        pendingHalfBuy = null;
      }

      // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
      const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
      const buyHit = strategy.tailDip === true ? checkTailDipHit(timeBuckets, bi) : buyDiag?.allPassed === true;
      // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，其余取买点诊断全部通过项汇总）
      const buyInfo = buyHit ? (strategy.tailDip === true ? TAIL_DIP_BUY_INFO : buildBuyReasonFromDiag(buyDiag)) : null;
      if (buyHit) {
        // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
        const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

        // 策略切换逻辑：连续切换三日涨幅
        if (strategy.id === 'highest_3d_gain_switch') {
          const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, 'highest_3d_gain');
          if (picked) {
            const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
            const sc = picked.stock;
            const buyPx = parseFloat(Number(sc.lastPx).toFixed(2));
            const buyChange = sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null;

            if (!singlePosition) {
              // 情况1：空仓，直接全仓买入
              singlePosition = {
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: buyPx,
                buyChange,
                metric: picked.metric,
                buyReason: gatedBuyInfo.buyReason,
                buyChecks: gatedBuyInfo.buyChecks,
              };
            } else if (singlePosition.code !== sc.code) {
              // 情况2：已持仓且目标股票已变，卖旧买新
              const oldStock = (bucket.stockChanges || []).find(s => s.code === singlePosition.code);
              const sellPx = oldStock?.lastPx != null && oldStock.lastPx > 0 ? parseFloat(Number(oldStock.lastPx).toFixed(2)) : buyPx;
              const sellChange = oldStock?.changePct != null ? parseFloat(Number(oldStock.changePct).toFixed(2)) : null;
              const returnRate = singlePosition.buyPrice > 0 ? parseFloat((((sellPx - singlePosition.buyPrice) / singlePosition.buyPrice) * 100).toFixed(2)) : null;

              singleTrades.push({
                seq: singleTrades.length + 1,
                metric: singlePosition.metric,
                code: singlePosition.code,
                stockName: singlePosition.stockName,
                buyDate: singlePosition.buyDate,
                buyDateDisplay: singlePosition.buyDateDisplay,
                buyTime: singlePosition.buyTime,
                buyPrice: singlePosition.buyPrice,
                buyChange: singlePosition.buyChange,
                buyReason: singlePosition.buyReason,
                buyChecks: singlePosition.buyChecks,
                sellDate: dateStr,
                sellDateDisplay: dateDisplay,
                sellTime: buyTime,
                sellPrice: sellPx,
                sellChange,
                sellReason: '策略切换：买入三日涨幅更优品种',
                returnRate,
              });

              singlePosition = {
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: buyPx,
                buyChange,
                metric: picked.metric,
                buyReason: gatedBuyInfo.buyReason,
                buyChecks: gatedBuyInfo.buyChecks,
              };
            }
          }
        } else if (!singlePosition && !pendingHalfBuy) {
          // 原有单股策略逻辑：同一时刻仅持有一只，未持仓时按指标选最优的一只买入
          const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, isTwice ? 'highest_3d_gain' : strategy.id);
          if (picked) {
            const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
            const sc = picked.stock;
            if (isTwice) {
              // 两次买入：买点触发当日先把首笔半仓挂起，留待收盘补足另 5 成
              if (bucket === lastBucket) {
                // 买点恰好在收盘桶触发：直接按收盘价一次性成交，成本价即为收盘价
                const closeStock = (bucket.stockChanges || []).find(s => s.code === sc.code);
                const closePx = closeStock?.lastPx != null && closeStock.lastPx > 0 ? parseFloat(Number(closeStock.lastPx).toFixed(2)) : parseFloat(Number(sc.lastPx).toFixed(2));
                singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: closePx,
                  buyChange: closeStock?.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : (sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null),
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              } else {
                pendingHalfBuy = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice1: parseFloat(Number(sc.lastPx).toFixed(2)),
                  buyChange1: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              }
            } else {
              singlePosition = {
                code: sc.code,
                stockName: sc.name || sc.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
                buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                metric: picked.metric,
                buyReason: gatedBuyInfo.buyReason,
                buyChecks: gatedBuyInfo.buyChecks,
              };
            }
          }
        }
      }

      // 卖出信号
      await sellPositions(bi);
    }

    // 两次买入策略：当日尾盘仍有挂起半仓（买点触发但收盘桶无该股报价）→ 次日自动取消，不产生持仓
    if (isTwice && pendingHalfBuy) {
      pendingHalfBuy = null;
    }
  }

  // 组装结果
  // 期末持仓：按最近一个有效日期的收盘价估算浮盈，计入整体收益
  let overallReturn = 1;
  for (const t of singleTrades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (singlePosition) {
    holding = { ...singlePosition };
    // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(singlePosition.code);
      if (info && info.closePx != null && info.closePx > 0) {
        holding.buyReturn = singlePosition.buyPrice > 0
          ? parseFloat((((info.closePx - singlePosition.buyPrice) / singlePosition.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    overallReturn *= 1 + (holding.buyReturn || 0) / 100;
  }
  overallReturn = parseFloat(((overallReturn - 1) * 100).toFixed(2));
  const validTrades = singleTrades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: singleTrades,
    currentHolding: holding,
    summary: {
      tradeCount: singleTrades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      overallReturn,
      holding: !!holding,
    },
  };
};

// 多策略共享数据回测：外层日期、内层策略，同一天回放数据只加载一次依次喂给全部策略。
// 与 runRangeBacktest 的差异仅在于数据加载被整组策略共享（dailyInfos/seenStocks 由 campData 派生，与策略无关，可共享），
// 持仓状态与成交流水按策略独立维护，单策略结果结构与 runRangeBacktest 完全一致。
// 返回：[{ strategyId, result }]
const runRangeBacktestMulti = async (startDate, endDate, strategyIds, onProgress) => {
  const ids = (Array.isArray(strategyIds) ? strategyIds : []).filter(id => STRATEGIES[id]);
  if (ids.length === 0) return [];
  // 混合策略组拆分：情绪游资走独立回测（不依赖回放缓存，先独立跑完），其余走共享数据的原逻辑
  const sentimentIds = ids.filter(id => isSentimentStrategy(id));
  const regularIds = ids.filter(id => !isSentimentStrategy(id));
  const results = [];
  for (const strategyId of sentimentIds) {
    const result = await runSentimentBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  if (regularIds.length === 0) return results;

  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return results.concat(regularIds.map(strategyId => ({ strategyId, result: { success: false, message: '所选日期范围内无可回测交易日' } })));
  }

  // 每个策略独立的持仓状态与成交流水
  const states = regularIds.map(strategyId => ({
    strategy: STRATEGIES[strategyId],
    singlePosition: null, // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric }
    // 两次买入策略挂起的首笔半仓（买点触发当日先买 5 成，等收盘补足剩余 5 成后再建立正式持仓）
    pendingHalfBuy: null, // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice1, buyChange1, metric, closePrice }
    singleTrades: [],
    skippedDates: [],
  }));

  // 整组策略共享：每日 EOD 信息与期间出现过的自选股（均由 campData 派生）
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      campData = await loadTrainingCampData(dateStr);
    } catch (e) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: e.message || '加载失败' }));
      continue;
    }
    if (!campData || campData.success === false) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' }));
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: '无时间桶数据' }));
      continue;
    }
    const replayStocks = buildReplayStocks(campData);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用，与策略无关）
    dailyInfos.set(dateStr, extractDailyInfo(campData));
    // 记录回测期间出现过的全部自选股（供前端复制K线等使用）
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 内层策略：同一天数据依次跑本组全部策略的买卖点诊断
    for (const st of states) {
      const { strategy, singleTrades } = st;
      const isTwice = strategy.id === 'highest_3d_gain_twice'; // 两次买入策略（选股同 3 日涨幅最大，仅建仓成本计算不同）
      const lastBucket = timeBuckets[timeBuckets.length - 1]; // 用于两次买入策略的收盘补仓
      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];

        // 两次买入策略：非收盘桶上，先建立挂起的首笔半仓（买点触发当日不等收盘）
        if (isTwice && st.pendingHalfBuy && bucket === lastBucket) {
          const closeStock = (bucket.stockChanges || []).find(s => s.code === st.pendingHalfBuy.code);
          const closePrice = closeStock?.lastPx != null && closeStock.lastPx > 0 ? Number(closeStock.lastPx) : null;
          if (closePrice != null) {
            // 成本价 = (首笔半仓买入价 + 收盘补仓买入价) / 2
            const avgPrice = parseFloat(((st.pendingHalfBuy.buyPrice1 + closePrice) / 2).toFixed(2));
            const closeChange = closeStock.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : st.pendingHalfBuy.buyChange1;
            st.singlePosition = {
              code: st.pendingHalfBuy.code,
              stockName: st.pendingHalfBuy.stockName,
              buyDate: st.pendingHalfBuy.buyDate,
              buyDateDisplay: st.pendingHalfBuy.buyDateDisplay,
              buyTime: st.pendingHalfBuy.buyTime,
              buyPrice: avgPrice,
              buyChange: closeChange,
              metric: st.pendingHalfBuy.metric,
              buyReason: st.pendingHalfBuy.buyReason,
              buyChecks: st.pendingHalfBuy.buyChecks,
            };
          }
          st.pendingHalfBuy = null;
        }

        // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
        const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
        const buyHit = strategy.tailDip === true ? checkTailDipHit(timeBuckets, bi) : buyDiag?.allPassed === true;
        // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，其余取买点诊断全部通过项汇总）
        const buyInfo = buyHit ? (strategy.tailDip === true ? TAIL_DIP_BUY_INFO : buildBuyReasonFromDiag(buyDiag)) : null;
        if (buyHit) {
          // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
          const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

          // 策略切换逻辑：连续切换三日涨幅
          if (strategy.id === 'highest_3d_gain_switch') {
            const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, 'highest_3d_gain');
            if (picked) {
              const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
              const sc = picked.stock;
              const buyPx = parseFloat(Number(sc.lastPx).toFixed(2));
              const buyChange = sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null;

              if (!st.singlePosition) {
                // 情况1：空仓，直接全仓买入
                st.singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: buyPx,
                  buyChange,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              } else if (st.singlePosition.code !== sc.code) {
                // 情况2：已持仓且目标股票已变，卖旧买新
                const oldStock = (bucket.stockChanges || []).find(s => s.code === st.singlePosition.code);
                const sellPx = oldStock?.lastPx != null && oldStock.lastPx > 0 ? parseFloat(Number(oldStock.lastPx).toFixed(2)) : buyPx;
                const sellChange = oldStock?.changePct != null ? parseFloat(Number(oldStock.changePct).toFixed(2)) : null;
                const returnRate = st.singlePosition.buyPrice > 0 ? parseFloat((((sellPx - st.singlePosition.buyPrice) / st.singlePosition.buyPrice) * 100).toFixed(2)) : null;

                singleTrades.push({
                  seq: singleTrades.length + 1,
                  metric: st.singlePosition.metric,
                  code: st.singlePosition.code,
                  stockName: st.singlePosition.stockName,
                  buyDate: st.singlePosition.buyDate,
                  buyDateDisplay: st.singlePosition.buyDateDisplay,
                  buyTime: st.singlePosition.buyTime,
                  buyPrice: st.singlePosition.buyPrice,
                  buyChange: st.singlePosition.buyChange,
                  buyReason: st.singlePosition.buyReason,
                  buyChecks: st.singlePosition.buyChecks,
                  sellDate: dateStr,
                  sellDateDisplay: dateDisplay,
                  sellTime: buyTime,
                  sellPrice: sellPx,
                  sellChange,
                  sellReason: '策略切换：买入三日涨幅更优品种',
                  returnRate,
                });

                st.singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: buyPx,
                  buyChange,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              }
            }
          } else if (!st.singlePosition && !st.pendingHalfBuy) {
            // 原有单股策略逻辑：同一时刻仅持有一只，未持仓时按指标选最优的一只买入
            const picked = pickBestStock(new Map(), rangeDates, di, bucket, replayStocks, dailyInfos, isTwice ? 'highest_3d_gain' : strategy.id);
            if (picked) {
              const gatedBuyInfo = withResilienceGateInfo(buyInfo, picked);
              const sc = picked.stock;
              if (isTwice) {
                // 两次买入：买点触发当日先把首笔半仓挂起，留待收盘补足另 5 成
                if (bucket === lastBucket) {
                  // 买点恰好在收盘桶触发：直接按收盘价一次性成交，成本价即为收盘价
                  const closeStock = (bucket.stockChanges || []).find(s => s.code === sc.code);
                  const closePx = closeStock?.lastPx != null && closeStock.lastPx > 0 ? parseFloat(Number(closeStock.lastPx).toFixed(2)) : parseFloat(Number(sc.lastPx).toFixed(2));
                  st.singlePosition = {
                    code: sc.code,
                    stockName: sc.name || sc.code,
                    buyDate: dateStr,
                    buyDateDisplay: dateDisplay,
                    buyTime,
                    buyPrice: closePx,
                    buyChange: closeStock?.changePct != null ? parseFloat(Number(closeStock.changePct).toFixed(2)) : (sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null),
                    metric: picked.metric,
                    buyReason: gatedBuyInfo.buyReason,
                    buyChecks: gatedBuyInfo.buyChecks,
                  };
                } else {
                  st.pendingHalfBuy = {
                    code: sc.code,
                    stockName: sc.name || sc.code,
                    buyDate: dateStr,
                    buyDateDisplay: dateDisplay,
                    buyTime,
                    buyPrice1: parseFloat(Number(sc.lastPx).toFixed(2)),
                    buyChange1: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                    metric: picked.metric,
                    buyReason: gatedBuyInfo.buyReason,
                    buyChecks: gatedBuyInfo.buyChecks,
                  };
                }
              } else {
                st.singlePosition = {
                  code: sc.code,
                  stockName: sc.name || sc.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
                  buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
                  metric: picked.metric,
                  buyReason: gatedBuyInfo.buyReason,
                  buyChecks: gatedBuyInfo.buyChecks,
                };
              }
            }
          }
        }

        // 卖出信号（同日买入不可同日卖出；尾盘抄底策略走专属卖点）
        if (st.singlePosition && dateStr > st.singlePosition.buyDate) {
          const position = { code: st.singlePosition.code, stockName: st.singlePosition.stockName, buyPrice: st.singlePosition.buyPrice, buyDate: st.singlePosition.buyDate, tailDipSell: strategy.tailDip === true };
          const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
          if (result.isSell && result.closePrice != null) {
            const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
            singleTrades.push({
              seq: singleTrades.length + 1,
              metric: st.singlePosition.metric,
              code: st.singlePosition.code,
              stockName: st.singlePosition.stockName,
              buyDate: st.singlePosition.buyDate,
              buyDateDisplay: st.singlePosition.buyDateDisplay,
              buyTime: st.singlePosition.buyTime,
              buyPrice: st.singlePosition.buyPrice,
              buyChange: st.singlePosition.buyChange,
              buyReason: st.singlePosition.buyReason,
              buyChecks: st.singlePosition.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: result.displayTime,
              sellPrice: result.closePrice,
              sellChange: result.change,
              sellReason: satisfiedNames || '卖出条件触发',
              returnRate: result.returnRate,
            });
            st.singlePosition = null;
          }
        }
      }

      // 两次买入策略：当日尾盘仍有挂起半仓（买点触发但收盘桶无该股报价）→ 次日自动取消，不产生持仓
      if (isTwice && st.pendingHalfBuy) {
        st.pendingHalfBuy = null;
      }
    }
  }

  // 逐策略组装结果（与 runRangeBacktest 单策略版完全一致）
  return states.map(st => {
    const { strategy, singleTrades, skippedDates } = st;
    // 期末持仓：按最近一个有效日期的收盘价估算浮盈，计入整体收益
    let overallReturn = 1;
    for (const t of singleTrades) {
      if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn *= 1 + t.returnRate / 100;
    }
    let holding = null;
    if (st.singlePosition) {
      holding = { ...st.singlePosition };
      // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
      for (let i = rangeDates.length - 1; i >= 0; i--) {
        const info = dailyInfos.get(rangeDates[i])?.get(st.singlePosition.code);
        if (info && info.closePx != null && info.closePx > 0) {
          holding.buyReturn = st.singlePosition.buyPrice > 0
            ? parseFloat((((info.closePx - st.singlePosition.buyPrice) / st.singlePosition.buyPrice) * 100).toFixed(2))
            : null;
          break;
        }
      }
      overallReturn *= 1 + (holding.buyReturn || 0) / 100;
    }
    overallReturn = parseFloat(((overallReturn - 1) * 100).toFixed(2));
    const validTrades = singleTrades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
    const winCount = validTrades.filter(t => t.returnRate > 0).length;
    return {
      strategyId: strategy.id,
      result: {
        success: true,
        type: 'single',
        strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
        range: { startDate, endDate },
        skippedDates,
        seenStocks: Array.from(seenStocks.values()),
        trades: singleTrades,
        currentHolding: holding,
        summary: {
          tradeCount: singleTrades.length,
          winCount,
          winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
          overallReturn,
          holding: !!holding,
        },
      },
    };
  });
};

module.exports = {
  runRangeBacktest,
  runRangeBacktestMulti,
  STRATEGIES,
  readCachedBacktest,
  writeCachedBacktest,
  loadReportIndex,
  sumReportCount,
  isSentimentStrategy,
  getSentimentDefaultRange,
};
