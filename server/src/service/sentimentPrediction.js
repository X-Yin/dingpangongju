// 科技情绪周期分析推演模型（情绪 + 指数双维度）
// 判定规则（满足任一即触发）：
//   高潮期：
//     1. 创业板或科创板相比上一日放量超过 5%，并且上涨超过 2%
//     2. 创业板或科创板 3 日均线斜率拐头向上为正
//     3. 科技情绪指数大于 45（归一化后，对应原始值约 140）
//   退潮期：
//     1. 创业板或科创板相比上一日放量超过 5%，并且下跌超过 -2%
//     2. 创业板或科创板 3 日均线斜率拐头向下为负
//     3. 科技情绪指数小于 -40（归一化后）
//   震荡期：其他情况

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getAllIndexKlineData } = require('./emotion');

const techIndexPath = path.join(__dirname, '../data/tech_index.json');

// 周期转换关系：震荡期 → 高潮期 → 退潮期 → 震荡期
const NEXT_PHASE = {
  '高潮期': '退潮期',
  '退潮期': '震荡期',
  '震荡期': '高潮期',
};

// 结构化操作建议
const OPERATION_ADVICE_V2 = {
  '高潮期': {
    position: '持股为主，冲高减仓',
    positionRatio: '5-7成',
    summary: '趋势仍在，但更适合去弱留强，不再追高。',
    keyPoints: [
      '只留主线核心，不做跟风补涨。',
      '盘中冲高时分批兑现，避免情绪回落吞噬利润。',
      '一旦强度和动量同时转弱，优先降仓而不是硬扛。',
    ],
  },
  '退潮期': {
    position: '轻仓等待，先看止跌',
    positionRatio: '0-2成',
    summary: '亏钱效应占优，先等冰点修复信号，再考虑出手。',
    keyPoints: [
      '抢反弹只做试错，不做重仓博弈。',
      '优先观察缩量止跌、核心票抗跌和资金回流。',
      '确认修复后再加仓，避免把单日反抽看成反转。',
    ],
  },
  '震荡期': {
    position: '控制仓位，滚动操作',
    positionRatio: '3-5成',
    summary: '没有一致主升，重心放在节奏和仓位控制。',
    keyPoints: [
      '只在有辨识度的方向上做低吸高抛，不追涨。',
      '仓位控制在半仓附近，给试错留回撤空间。',
      '等主线和资金共振后，再从试错切到进攻。',
    ],
  },
};

// 兼容旧版字符串型操作建议
const OPERATION_ADVICE = {
  '高潮期': OPERATION_ADVICE_V2['高潮期'].keyPoints.join('\n'),
  '退潮期': OPERATION_ADVICE_V2['退潮期'].keyPoints.join('\n'),
  '震荡期': OPERATION_ADVICE_V2['震荡期'].keyPoints.join('\n'),
};

// ============ 通用工具函数 ============

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 计算 3 日简单移动平均
const computeMA3 = (values) => {
  const ma = [];
  for (let i = 0; i < values.length; i++) {
    if (i < 2) {
      ma.push(null);
    } else {
      const avg = (values[i - 2] + values[i - 1] + values[i]) / 3;
      ma.push(avg);
    }
  }
  return ma;
};

// 计算下一个交易日（以交易日历为准，自动跳过周末与法定节假日）
const tradingDayUtil = require('../utils/tradingDay');
const getNextTradingDay = (dateNum) => {
  const str = String(dateNum);
  const d = dayjs(`${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`).toDate();
  return Number(dayjs(tradingDayUtil.getNextTradingDay(d)).format('YYYYMMDD'));
};

// ============ 周期判定与识别 ============

// 识别历史周期
const identifyCycles = (phases) => {
  const cycles = [];
  const startIdx = phases.findIndex((p) => p !== null);
  if (startIdx === -1) return cycles;

  let curPhase = phases[startIdx];
  let cycleStart = startIdx;
  for (let i = startIdx + 1; i < phases.length; i++) {
    if (phases[i] !== curPhase) {
      const duration = i - cycleStart;
      cycles.push({ phase: curPhase, startIdx: cycleStart, endIdx: i - 1, duration });
      curPhase = phases[i];
      cycleStart = i;
    }
  }
  const lastDuration = phases.length - cycleStart;
  cycles.push({ phase: curPhase, startIdx: cycleStart, endIdx: phases.length - 1, duration: lastDuration });
  return cycles;
};

// 计算各周期平均持续天数
const computeAvgDurations = (cycles) => {
  const durs = { '高潮期': [], '退潮期': [], '震荡期': [] };
  cycles.forEach((c) => durs[c.phase].push(c.duration));
  const avg = {};
  Object.keys(durs).forEach((p) => {
    if (durs[p].length > 0) {
      avg[p] = Math.max(2, Math.round(durs[p].reduce((a, b) => a + b, 0) / durs[p].length));
    } else {
      avg[p] = p === '震荡期' ? 4 : 6;
    }
  });
  return avg;
};

const phaseTone = (phase) => {
  if (phase === '高潮期') return 'up';
  if (phase === '退潮期') return 'down';
  return 'neutral';
};

const getCycleStageLabel = (currentDuration, avgDuration) => {
  const earlyThreshold = Math.max(2, Math.round(avgDuration * 0.35));
  const lateThreshold = Math.max(3, Math.round(avgDuration * 0.8));

  if (currentDuration <= earlyThreshold) return '前段';
  if (currentDuration >= lateThreshold) return '后段';
  return '中段';
};

// 计算指数的 3 日均线斜率
const computeIndexMA3Slope = (series) => {
  if (!series || series.length < 4) return null;
  
  const sorted = [...series]
    .filter((item) => item && item.trade_date)
    .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
  
  if (sorted.length < 4) return null;
  
  const closes = sorted.map((item) => Number(item.close_px || 0));
  const ma3 = computeMA3(closes);
  
  const latest = ma3[ma3.length - 1];
  const prev = ma3[ma3.length - 2];
  
  if (latest === null || prev === null) return null;
  
  return latest - prev;
};

// 检查指数是否放量上涨/下跌
const checkIndexVolumePriceChange = (series) => {
  if (!series || series.length < 2) return { volumeIncrease: false, priceChange: 0 };
  
  const sorted = [...series]
    .filter((item) => item && item.trade_date)
    .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
  
  if (sorted.length < 2) return { volumeIncrease: false, priceChange: 0 };
  
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  
  const latestVolume = Number(latest.volume || 0);
  const prevVolume = Number(prev.volume || 0);
  const priceChange = Number(latest.change || 0);
  
  const volumeIncrease = prevVolume > 0 && latestVolume > prevVolume * 1.05;
  
  return { volumeIncrease, priceChange };
};

// 基于规则判定周期阶段
const determinePhaseByRules = (techValue, chuangyebanData, kechuangbanData) => {
  // 条件 3：科技情绪指数判定（归一化后阈值：>45 高潮期，<-40 退潮期）
  if (techValue > 45) {
    return { phase: '高潮期', reason: '情绪指数 > 45' };
  }
  if (techValue < -40) {
    return { phase: '退潮期', reason: '情绪指数 < -40' };
  }
  
  // 条件 1 和 2：检查创业板和科创板
  const indices = [
    { name: '创业板', data: chuangyebanData },
    { name: '科创板', data: kechuangbanData },
  ];
  
  for (const index of indices) {
    // 条件 1：放量超过 5% 并且涨跌超过阈值
    const { volumeIncrease, priceChange } = checkIndexVolumePriceChange(index.data);
    if (volumeIncrease && priceChange > 2) {
      return { phase: '高潮期', reason: `${index.name}放量上涨 ${priceChange.toFixed(2)}%` };
    }
    if (volumeIncrease && priceChange < -2) {
      return { phase: '退潮期', reason: `${index.name}放量下跌 ${priceChange.toFixed(2)}%` };
    }
    
    // 条件 2：3 日均线斜率
    const slope = computeIndexMA3Slope(index.data);
    if (slope !== null && slope > 0) {
      return { phase: '高潮期', reason: `${index.name}3日均线拐头向上` };
    }
    if (slope !== null && slope < 0) {
      return { phase: '退潮期', reason: `${index.name}3日均线拐头向下` };
    }
  }
  
  // 其他情况：震荡期
  return { phase: '震荡期', reason: '无明确方向信号' };
};

// 周期阶段描述
const phaseDescriptionTemplate = (phase, techValue) => {
  switch (phase) {
    case '高潮期':
      return `情绪指数 ${techValue.toFixed(2)}，当前处于情绪高潮阶段`;
    case '退潮期':
      return `情绪指数 ${techValue.toFixed(2)}，当前处于情绪退潮阶段`;
    case '震荡期':
      return `情绪指数 ${techValue.toFixed(2)}，当前处于情绪震荡阶段`;
    default:
      return '';
  }
};

// ============ 指数数据获取 ============

const buildTechIndexContext = async () => {
  try {
    const indexData = await getAllIndexKlineData();
    
    return {
      chuangyebanData: indexData?.chuangyebanData || [],
      kechuangbanData: indexData?.kechuangbanData || [],
    };
  } catch (error) {
    return {
      chuangyebanData: [],
      kechuangbanData: [],
    };
  }
};

// ============ 主推演函数 ============

const predictSentimentCycle = async () => {
  let techData = [];
  try {
    const raw = fs.readFileSync(techIndexPath, 'utf-8') || '[]';
    techData = JSON.parse(raw);
  } catch (e) {
    return { error: '无法读取科技情绪数据' };
  }

  if (techData.length < 5) {
    return { error: '数据不足，至少需要 5 天数据才能进行周期分析' };
  }

  // 获取指数数据
  const indexContext = await buildTechIndexContext();

  // 按日期升序排列
  const sorted = [...techData].sort((a, b) => a.date - b.date);
  const values = sorted.map((d) => d.changeSumResult);
  const dates = sorted.map((d) => d.date);
  const n = sorted.length;

  // 逐日判定周期阶段
  const phases = [];
  const phaseReasons = [];
  
  for (let i = 0; i < n; i++) {
    if (i < 3) {
      // 前 3 天数据不足，默认为震荡期
      phases.push('震荡期');
      phaseReasons.push('数据不足');
      continue;
    }
    
    // 获取截止到当前日期的指数数据
    const currentDate = dates[i];
    const chuangyebanDataUpToNow = indexContext.chuangyebanData.filter(
      (item) => Number(item.trade_date) <= Number(currentDate)
    );
    const kechuangbanDataUpToNow = indexContext.kechuangbanData.filter(
      (item) => Number(item.trade_date) <= Number(currentDate)
    );
    
    const result = determinePhaseByRules(values[i], chuangyebanDataUpToNow, kechuangbanDataUpToNow);
    phases.push(result.phase);
    phaseReasons.push(result.reason);
  }

  // 识别历史周期
  const cycles = identifyCycles(phases);

  // 各周期平均持续天数
  const avgDur = computeAvgDurations(cycles);

  // 当前周期信息
  const lastIdx = n - 1;
  const currentPhase = phases[lastIdx] || '震荡期';
  const currentCycle = cycles[cycles.length - 1] || { phase: currentPhase, startIdx: lastIdx, endIdx: lastIdx, duration: 1 };
  const currentDuration = currentCycle.duration;
  const avgD = avgDur[currentPhase];
  const progress = clamp(currentDuration / avgD, 0, 1.5);
  const remainingDays = Math.max(1, Math.round(avgD - currentDuration));
  const nextPhase = currentPhase === '震荡期'
    ? ((values[lastIdx] || 0) >= 0 ? '高潮期' : '退潮期')
    : NEXT_PHASE[currentPhase];

  const stageLabel = getCycleStageLabel(currentDuration, avgD);
  const durationRatio = clamp(currentDuration / Math.max(avgD, 1), 0, 1.6);

  // 明日推演
  const tomorrowDate = getNextTradingDay(dates[lastIdx]);
  const currentValue = values[lastIdx];
  const phaseDescription = `${phaseDescriptionTemplate(currentPhase, currentValue)}，当前更像${stageLabel}`;
  const cycleDescription = `当前${currentPhase}${stageLabel}，已运行 ${currentDuration} 天，历史平均约 ${avgD} 天，下一阶段大概率看向 ${nextPhase}`;

  // 风险/机会信号
  const riskSignals = [];
  
  if (currentPhase === '高潮期' && durationRatio >= 0.9) {
    riskSignals.push({ type: 'warning', message: '情绪已在高位区间，明天优先观察分歧是否继续放大' });
  }
  
  if (currentPhase === '退潮期' && durationRatio >= 0.8) {
    riskSignals.push({ type: 'opportunity', message: '退潮中的修复迹象开始出现，可以关注核心票先手' });
  }
  
  if (riskSignals.length === 0) {
    riskSignals.push({
      type: currentPhase === '高潮期' ? 'warning' : 'opportunity',
      message: currentPhase === '高潮期' 
        ? '短线仍有修复尝试，但更适合看确认后再跟随' 
        : '短线没有一致性进攻环境，仓位控制比预测方向更重要',
    });
  }

  // 综合分析
  const isNearEnd = durationRatio >= 0.9;
  const analysisLines = [
    `当前科技情绪处于${currentPhase}${stageLabel}，判定依据：${phaseReasons[lastIdx]}。`,
    `情绪指数 ${currentValue.toFixed(2)}，当前周期运行 ${currentDuration}/${avgD} 天。`,
    `${isNearEnd ? '当前阶段已接近尾声，明天更容易出现分歧切换。' : `暂时仍按 ${currentPhase} 的交易框架应对。`}`,
  ];

  const analysis = analysisLines.join('\n');
  const operationAdvice = OPERATION_ADVICE_V2[currentPhase];

  const signalCards = [
    {
      label: '情绪阶段',
      value: `${currentPhase}${stageLabel ? ` · ${stageLabel}` : ''}`,
      detail: `情绪指数 ${currentValue.toFixed(2)}`,
      tone: phaseTone(currentPhase),
    },
    {
      label: '周期位置',
      value: `${currentDuration}/${avgD} 天`,
      detail: isNearEnd ? '接近尾声，防切换' : `下一阶段看 ${nextPhase}`,
      tone: 'neutral',
    },
    {
      label: '判定依据',
      value: phaseReasons[lastIdx],
      detail: '满足任一条件即触发',
      tone: 'neutral',
    },
  ];

  const summary = {
    headline: `当前是${currentPhase}${stageLabel ? `的${stageLabel}` : ''}`,
    subline: `优先按"${operationAdvice.position}"执行，仓位参考 ${operationAdvice.positionRatio}`,
    action: operationAdvice.summary,
  };

  const historyPhases = dates
    .map((date, index) => {
      const phase = phases[index];
      if (!phase) return null;

      const cycleIndex = cycles.findIndex((cycle) => index >= cycle.startIdx && index <= cycle.endIdx);
      const cycle = cycleIndex >= 0 ? cycles[cycleIndex] : null;

      return {
        date,
        phase,
        value: parseFloat(values[index].toFixed(2)),
        cycleIndex,
        isCycleStart: cycle ? index === cycle.startIdx : false,
        isCycleEnd: cycle ? index === cycle.endIdx : false,
        reason: phaseReasons[index],
      };
    })
    .filter(Boolean);

  const cycleSegments = cycles.map((cycle, index) => ({
    phase: cycle.phase,
    startDate: dates[cycle.startIdx],
    endDate: dates[cycle.endIdx],
    duration: cycle.duration,
    cycleIndex: index,
  }));

  const result = {
    current: {
      phase: currentPhase,
      date: dates[lastIdx],
      value: parseFloat(currentValue.toFixed(2)),
      ma3: parseFloat(currentValue.toFixed(2)),
      stageLabel,
      description: phaseDescription,
      reason: phaseReasons[lastIdx],
    },
    cycle: {
      remainingDays,
      nextPhase,
      description: cycleDescription,
      currentDuration,
      avgDuration: avgD,
      progress: parseFloat(progress.toFixed(2)),
      stageLabel,
    },
    tomorrow: {
      date: tomorrowDate,
      predictedValue: parseFloat(currentValue.toFixed(2)),
      predictedRange: '--',
      predictedPhase: nextPhase,
      biasLabel: nextPhase === '高潮期' ? '偏强延续' : nextPhase === '退潮期' ? '偏弱延续' : '震荡延续',
      description: `按 ${nextPhase} 的应对方式准备。`,
      riskSignals,
    },
    confidence: 70,
    operationAdvice: OPERATION_ADVICE[currentPhase],
    analysis,
    analysisLines,
    summary,
    signals: signalCards,
    historyPhases,
    cycleSegments,
    operationAdviceV2: operationAdvice,
    riskSignals,
  };

  return result;
};

module.exports = { predictSentimentCycle };
