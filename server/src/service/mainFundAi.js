// 主力资金页面 AI 总结服务
// - getMainFundAiSummary(): 拉取历史分时数据（含资金/成交量快照）作为上下文，
//   结合当日实时资金/成交量/指数分时数据，调用 AI 分析当日行情并预判后续走势
const dayjs = require('dayjs');
const { getAmountHistory } = require('./amount');
const { aggregateByInterval } = require('./fundSnapshot');
const { getIndexTlineByDate } = require('./fupan');
const { getIntradayHistoryCached, callAIText, INTRADAY_MINUTES } = require('./aiPrediction');

// 将 1 分钟 tline 数据聚合为 5 分钟桶（close = 最后价，volume/amount 累加）
// 返回 [{ minute: "HH:MM", close, volume, amount }, ...]
function aggregateTlineTo5MinBuckets(line) {
  if (!line || !Array.isArray(line) || line.length === 0) return [];
  const buckets = new Map();
  for (const item of line) {
    const minute = item.minute;
    if (minute == null) continue;
    const px = item.last_px || item.av_px;
    if (px == null) continue;
    // 5 分钟桶起始
    let bs = null;
    if (minute >= 930 && minute <= 1130) {
      bs = Math.min(930 + 5 * Math.floor((minute - 930) / 5), 1125);
    } else if (minute >= 1300 && minute <= 1500) {
      bs = Math.min(1300 + 5 * Math.floor((minute - 1300) / 5), 1455);
    }
    if (bs == null) continue;
    let b = buckets.get(bs);
    if (!b) {
      b = { close: px, volume: 0, amount: 0, bucketStart: bs };
      buckets.set(bs, b);
    }
    b.close = px;
    b.volume += (item.business_amount || 0);
    b.amount += (item.business_balance || 0);
  }
  const sorted = [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  return sorted.map(b => {
    const hh = String(Math.floor(b.bucketStart / 100)).padStart(2, '0');
    const mm = String(b.bucketStart % 100).padStart(2, '0');
    return { minute: `${hh}:${mm}`, close: +b.close.toFixed(2), volume: b.volume, amount: b.amount };
  });
}

// 单位换算
const toWanShou = (v) => +(v / 10000).toFixed(2);
const toYiYuan = (v) => +(v / 100000000).toFixed(2);

// 构建历史上下文段落（单个指数）
function buildHistorySection(historyData) {
  const { indexName, days } = historyData;
  if (!days || days.length === 0) return `（无${indexName}历史数据）`;
  const dailyStr = days.map(d => {
    const vols = (d.volumes || []).map(toWanShou);
    const amts = (d.amounts || []).map(toYiYuan);
    const mmLine = d.mainMoneys ? d.mainMoneys.join(',') : 'MISSING';
    const acdLine = d.amountChangeDiffs ? d.amountChangeDiffs.join(',') : 'MISSING';
    return `${d.date},${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}%,${d.preclose},${d.closes.join(',')}\n${vols.join(',')}\n${amts.join(',')}\n${mmLine}\n${acdLine}`;
  }).join('\n');
  const dateRange = `${days[0].date} ~ ${days[days.length - 1].date}`;
  return `### ${indexName} 历史分时数据（${days.length} 个交易日，${dateRange}）
每个交易日占 5 行：
第1行：日期,日涨跌%,昨收价,48个5分钟收盘价
第2行：48个5分钟成交量(万手)
第3行：48个5分钟成交额(亿)
第4行：48个5分钟主力资金净流入(亿；MISSING 表示无快照)
第5行：48个5分钟成交量变化(亿；MISSING 表示无快照)

${dailyStr}`;
}

// 构建当日实时数据段落
function buildTodaySection(todayFund5min, indexTlineMap, currentTime) {
  // 主力资金与成交量
  const fundLines = (todayFund5min || []).map(d => {
    const mm = d.time.substring(0, 2) + ':' + d.time.substring(2, 4);
    return `${mm} | ${d.mainMoney >= 0 ? '+' : ''}${d.mainMoney.toFixed(2)} | ${d.amountChangeDiff >= 0 ? '+' : ''}${d.amountChangeDiff.toFixed(2)}`;
  });

  // 指数分时
  const indexSections = [];
  for (const [name, tline] of Object.entries(indexTlineMap)) {
    if (!tline || !tline.line || tline.line.length === 0) {
      indexSections.push(`### ${name} 当日分时\n（无数据）`);
      continue;
    }
    const preclose = tline.preclose_px || tline.line[0]?.preclose_px || 0;
    const bars = aggregateTlineTo5MinBuckets(tline.line);
    const barLines = bars.map(b => {
      const change = preclose > 0 ? +(((b.close - preclose) / preclose) * 100).toFixed(2) : 0;
      return `${b.minute} | ${b.close} | ${change >= 0 ? '+' : ''}${change}% | ${toWanShou(b.volume)} | ${toYiYuan(b.amount)}`;
    });
    indexSections.push(`### ${name} 当日分时（5分钟级别，昨收 ${preclose}）
格式：时间 | 收盘价 | 涨跌% | 成交量(万手) | 成交额(亿)
${barLines.join('\n') || '（无数据）'}`);
  }

  return `### 主力资金与成交量（5分钟级别）
格式：时间 | 主力资金净流入(亿) | 成交量变化(亿)
${fundLines.join('\n') || '（无数据）'}

${indexSections.join('\n\n')}`;
}

// 构建 prompt
function buildMainFundPrompt(todayFund5min, indexTlineMap, cybHistory, kcbHistory, currentTime) {
  const todaySection = buildTodaySection(todayFund5min, indexTlineMap, currentTime);
  const cybHistorySection = buildHistorySection(cybHistory);
  const kcbHistorySection = buildHistorySection(kcbHistory);

  return `你是A股市场主力资金分析专家。请基于以下当日实时数据和历史上下文，分析今天的行情，并预判今天接下来的走势，给出操作建议。

## 当日实时数据（截至 ${currentTime}）

${todaySection}

## 历史上下文

${cybHistorySection}

${kcbHistorySection}

## 数据说明
- 时间轴对应：09:30,09:35,...,11:25,13:00,13:05,...,14:55（共48个5分钟桶）
- 主力资金净流入：正值表示净流入，负值表示净流出
- 成交量变化：相邻时段成交量的差值，反映放量/缩量
- 历史数据中 MISSING 表示该日无资金/成交量快照

## 分析任务
请基于上述数据进行深入分析，输出以下内容：

1. **今日行情分析**：结合主力资金流向、成交量变化、创业板指和科创50分时走势，分析今天截至目前的盘面特征（资金动向、量能变化、指数强弱对比）
2. **今日后续走势预判**：基于历史规律和当前盘面特征，预判今天剩余交易时间可能出现的走势（上涨/震荡/下跌），给出倾向性判断和理由
3. **操作建议**：针对当前盘面，给出具体的操作建议（如加仓/减仓/持仓/观望等），并说明依据

要求：
1. 分析必须基于数据，引用具体数值（资金规模、涨幅、成交量等）
2. 结合历史规律判断今日特征是否异常或符合惯例
3. 关注主力资金流向与指数走势的背离或共振
4. 用中文输出，结构清晰，使用小标题分段`;
}

// 收集数据并构建 prompt（不调用 AI），供总结和拷贝上下文复用
async function gatherMainFundAiData() {
  const today = dayjs().format('YYYYMMDD');
  const currentTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

  // 1. 当日主力资金与成交量（实时，聚合为 5 分钟）
  const amountHistory = getAmountHistory();
  const todayFund5min = aggregateByInterval(amountHistory, 5);

  // 2. 当日指数分时（实时，含历史回退）
  const indexTline = await getIndexTlineByDate(today);
  const indexTlineMap = {
    '创业板指': indexTline?.chuangyeban,
    '科创50': indexTline?.kechuangban,
  };

  // 3. 历史上下文（仅包含有 amountSnapshot 快照的日期，拉取足够多天数后过滤）
  const [cybHistoryRaw, kcbHistoryRaw] = await Promise.all([
    getIntradayHistoryCached('sz399006', 30, today),
    getIntradayHistoryCached('sh000688', 30, today),
  ]);
  // 仅保留有 amountSnapshot（amountChangeDiffs 非空）的日期
  const cybHistory = {
    ...cybHistoryRaw,
    days: cybHistoryRaw.days.filter(d => Array.isArray(d.amountChangeDiffs)),
  };
  const kcbHistory = {
    ...kcbHistoryRaw,
    days: kcbHistoryRaw.days.filter(d => Array.isArray(d.amountChangeDiffs)),
  };

  console.log(`[mainFundAi] 当日资金5min: ${todayFund5min.length}条, 创业板历史(有快照): ${cybHistory.days.length}天, 科创历史(有快照): ${kcbHistory.days.length}天`);

  const prompt = buildMainFundPrompt(todayFund5min, indexTlineMap, cybHistory, kcbHistory, currentTime);

  return {
    prompt,
    currentTime,
    dataInfo: {
      todayFundPoints: todayFund5min.length,
      cybHistoryDays: cybHistory.days.length,
      kcbHistoryDays: kcbHistory.days.length,
      hasCybTodayTline: !!(indexTlineMap['创业板指']?.line?.length),
      hasKcbTodayTline: !!(indexTlineMap['科创50']?.line?.length),
    },
  };
}

// 主入口：获取历史上下文 + 当日实时数据 → AI 分析
async function getMainFundAiSummary() {
  const { prompt, currentTime, dataInfo } = await gatherMainFundAiData();
  const answer = await callAIText(prompt, '你是专业的A股市场主力资金分析专家，擅长结合主力资金流向、成交量变化与指数分时走势进行盘中研判。请给出专业、有数据支撑的分析和可操作的建议。用中文输出。');

  return {
    analysis: answer,
    model: require('../utils/aiProvider').getActiveProvider().name,
    currentTime,
    dataInfo,
  };
}

// 拷贝上下文：返回 prompt 供前端复制到其他 AI 平台
async function getMainFundAiContext() {
  const { prompt, currentTime, dataInfo } = await gatherMainFundAiData();
  return { prompt, currentTime, dataInfo };
}

module.exports = {
  getMainFundAiSummary,
  getMainFundAiContext,
};
