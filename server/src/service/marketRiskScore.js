/**
 * calcRiskAppetite —— 全市场风险偏好指数（单函数版）
 *
 * 输入：stocks: Array<{ code, name, riskScore: 1~10, changePct: 当日涨跌幅(%) }>
 *       （即在你的股票池 JSON 上每日 merge 一个 changePct 字段）
 * 输出：{ score: 0~200, level, label, desc, detail }
 *
 * 分值分段：
 *   0  ~ 40   极度收缩（冰点）
 *   40 ~ 80   防御收缩
 *   80 ~ 110  中性均衡
 *   110~ 140  温和回升
 *   140~ 170  风偏高涨
 *   170~ 200  急剧上升（亢奋，警惕拥挤与反转）
 */
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const axios = require('axios');
const { getClsReqUrl, batchParallel, isTradingDay } = require("../utils");
const { useCLS } = require('../config');
const monitorStocks = require('../data/monitor_stocks.json');

const riskScorePath = path.join(__dirname, "../data/market_risk_score.json");

function calcRiskAppetite(stocks) {
  const list = (stocks || []).filter(
    s => s && Number.isFinite(s.changePct) && Number.isFinite(s.riskScore)
  );
  if (!list.length) {
    return {
      score: 100, level: 3, label: '中性均衡',
      desc: '无有效输入，返回中性值', detail: null,
    };
  }

  const { tanh } = Math;
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

  const high = list.filter(s => s.riskScore >= 7);
  const low = list.filter(s => s.riskScore <= 3);

  const highAvg = high.length ? avg(high.map(s => s.changePct)) : null;
  const lowAvg = low.length ? avg(low.map(s => s.changePct)) : null;
  const spread = highAvg !== null && lowAvg !== null ? highAvg - lowAvg : 0;

  const upRatio = a => a.filter(s => s.changePct > 0).length / a.length;
  const breadth = high.length && low.length ? upRatio(high) - upRatio(low) : 0;

  const sorted = [...list].sort((a, b) => b.changePct - a.changePct);
  const topN = Math.max(3, Math.ceil(list.length * 0.2));
  const attackTilt =
    avg(sorted.slice(0, topN).map(s => s.riskScore)) -
    avg(list.map(s => s.riskScore));

  const avgChange = avg(list.map(s => s.changePct));

  const parts = [];
  if (high.length && low.length) {
    parts.push({ v: tanh(spread / 2), w: 0.55 });
    parts.push({ v: tanh(breadth / 0.5), w: 0.2 });
  }
  parts.push({ v: tanh(attackTilt / 1.2), w: 0.15 });
  parts.push({ v: tanh(avgChange / 1.5), w: 0.1 });

  const wSum = parts.reduce((x, p) => x + p.w, 0);
  const raw = 100 + (100 * parts.reduce((x, p) => x + p.w * p.v, 0)) / wSum;
  const score = Math.max(0, Math.min(200, Math.round(raw)));

  const bands = [
    [40, 1, '极度收缩', '冰点区：资金全面撤离远期叙事，只抱当期业绩甚至普跌，往往是情绪底部区域'],
    [80, 2, '防御收缩', '风险偏好低位：资金只认最近可兑现的业绩，叙事股被持续抛弃'],
    [110, 3, '中性均衡', '业绩与叙事定价大体平衡，市场没有明确的风偏方向'],
    [140, 4, '温和回升', '资金开始试探性给远期叙事定价，风险偏好修复中'],
    [170, 5, '风偏高涨', '远期叙事股明显领涨，资金愿意为明年、后年的故事付溢价'],
    [201, 6, '急剧上升', '亢奋区：纯叙事/影子股乱飞，注意拥挤度与随时反转的风险'],
  ];
  const band = bands.find(b => score < b[0]);

  return {
    score,
    level: band[1],
    label: band[2],
    desc: band[3],
    detail: {
      spread: +spread.toFixed(3),
      breadth: +breadth.toFixed(3),
      attackTilt: +attackTilt.toFixed(3),
      avgChange: +avgChange.toFixed(3),
      highAvg: highAvg === null ? null : +highAvg.toFixed(3),
      lowAvg: lowAvg === null ? null : +lowAvg.toFixed(3),
    },
  };
}

const getStockChangePct = async (stockCode) => {
  try {
    const { data: { data: klineData } } = await axios.get(getClsReqUrl(stockCode, 1));
    if (klineData && klineData.length > 0) {
      return klineData[0].change;
    }
  } catch (error) {
    console.error(`获取股票 ${stockCode} 涨跌幅失败:`, error.message);
  }
  return 0;
};

const calculateAndSaveRiskScore = async () => {
  const stockCodes = monitorStocks.map(s => s.code);
  const changePctArr = await batchParallel(stockCodes, getStockChangePct, useCLS() ? 5 : 20);

  const stocksWithChange = monitorStocks.map((stock, index) => ({
    ...stock,
    changePct: changePctArr[index]
  }));

  const result = calcRiskAppetite(stocksWithChange);

  const today = dayjs().format('YYYYMMDD');
  const record = {
    date: Number(today),
    score: result.score,
    level: result.level,
    label: result.label,
    desc: result.desc,
    detail: result.detail,
    timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };

  let oldData = [];
  if (fs.existsSync(riskScorePath)) {
    const raw = fs.readFileSync(riskScorePath, 'utf-8') || '[]';
    oldData = JSON.parse(raw);
  }

  const existingIndex = oldData.findIndex(item => item.date === record.date);
  if (existingIndex !== -1) {
    oldData[existingIndex] = record;
  } else {
    oldData.push(record);
  }

  fs.writeFileSync(riskScorePath, JSON.stringify(oldData, null, 2));
  return record;
};

const getRiskScoreHistory = () => {
  if (!fs.existsSync(riskScorePath)) {
    return [];
  }
  const raw = fs.readFileSync(riskScorePath, 'utf-8') || '[]';
  return JSON.parse(raw);
};

const scheduleRiskScoreRecord = (hour = 15, minute = 1) => {
  let executedDates = new Set();

  const task = () => {
    const now = dayjs();
    const today = now.format('YYYYMMDD');

    // 非交易日（周末/节假日，以交易日历为准）不执行
    if (!isTradingDay(now.toDate())) return;

    if (executedDates.has(today)) return;

    const targetTime = now.hour(hour).minute(minute).second(0).millisecond(0);
    if (!now.isAfter(targetTime)) return;

    console.log('开始计算并记录市场风险偏好指数...', now.format('YYYY-MM-DD HH:mm:ss'));
    calculateAndSaveRiskScore().then(record => {
      console.log('市场风险偏好指数记录完成:');
      executedDates.add(today);
    }).catch(e => {
      console.error('市场风险偏好指数记录失败:', e.message);
    });
  };

  task();
  setInterval(task, 60 * 1000);
  console.log(`市场风险偏好指数记录已调度，超过 ${hour}:${String(minute).padStart(2, '0')} 且未记录时将自动执行`);
};

module.exports = {
  calcRiskAppetite,
  calculateAndSaveRiskScore,
  getRiskScoreHistory,
  scheduleRiskScoreRecord,
};