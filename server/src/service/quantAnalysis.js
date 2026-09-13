const fs = require('fs');
const path = require('path');
const { getSingleStockData, getSingleStockTlineData } = require('./stock');
const { predictSentimentCycle } = require('./sentimentPrediction');
const { calculateResilience, getLimitTypeByCode } = require('./stockDiagnose');
const { classifySectorBlocksDaily } = require('../utils/classifySectorBlocks');
const { getMainLine } = require('./marketMainLine');
const { useCLS } = require('../config');
const { batchParallel } = require('../utils');

const monitorStocksPath = path.join(__dirname, '../data/monitor_stocks.json');
const quantAnalysisPath = path.join(__dirname, '../data/quant_analysis.json');
const blockDataPath = path.join(__dirname, '../data/block_data_day_history.json');
const blockMoneyPath = path.join(__dirname, '../data/block_money_day_history.json');
const amountPath = path.join(__dirname, '../data/amount.json');
const amountDayHistoryPath = path.join(__dirname, '../data/amount_day_history.json');

const REQUEST_DELAY_MS = 1500;
let currentRunPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));
const safeNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};
const average = (values = []) => {
    const valid = values.filter((item) => Number.isFinite(item));
    if (!valid.length) return 0;
    return valid.reduce((sum, item) => sum + item, 0) / valid.length;
};
const sum = (values = []) => values.reduce((acc, item) => acc + safeNumber(item), 0);
const percentChange = (from, to) => {
    const base = safeNumber(from);
    if (!base) return 0;
    return ((safeNumber(to) - base) / base) * 100;
};
const formatPercent = (value, digits = 2) => `${value >= 0 ? '+' : ''}${round(value, digits)}%`;
const formatPercentRange = (low, high) => `${Math.max(0, Math.round(low * 100))}%-${Math.max(0, Math.round(high * 100))}%`;
const logQuantProgress = (stage, message, extra) => {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    if (extra !== undefined) {
        console.log(`[量化分析][${timestamp}][${stage}] ${message}`, extra);
        return;
    }
    console.log(`[量化分析][${timestamp}][${stage}] ${message}`);
};

const safeReadJson = (filePath, fallback) => {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8').trim();
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (error) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const trimmed = raw.trim();
            const endChar = Array.isArray(fallback) ? ']' : '}';
            const endIndex = trimmed.lastIndexOf(endChar);
            if (endIndex !== -1) {
                return JSON.parse(trimmed.slice(0, endIndex + 1));
            }
        } catch (secondaryError) {
            // ignore
        }
        return fallback;
    }
};

const calculateEMA = (values, period) => {
    if (!Array.isArray(values) || values.length === 0) return [];
    const alpha = 2 / (period + 1);
    const result = [safeNumber(values[0])];
    for (let i = 1; i < values.length; i++) {
        result.push(safeNumber(values[i]) * alpha + result[i - 1] * (1 - alpha));
    }
    return result;
};

const calculateSMA = (values, period) => values.map((_, index) => {
    if (index + 1 < period) return null;
    return average(values.slice(index - period + 1, index + 1).map(safeNumber));
});

const calculateMACD = (closes) => {
    if (closes.length < 26) return { diff: [], dea: [], macd: [] };
    const shortEMA = calculateEMA(closes, 12);
    const longEMA = calculateEMA(closes, 26);
    const diff = shortEMA.map((item, index) => item - longEMA[index]);
    const dea = calculateEMA(diff, 9);
    const macd = diff.map((item, index) => (item - dea[index]) * 2);
    return { diff, dea, macd };
};

const calculateATRPercent = (kline, period = 14) => {
    if (!Array.isArray(kline) || kline.length < 2) return 0;
    const trueRanges = [];
    for (let i = 1; i < kline.length; i++) {
        const current = kline[i];
        const prev = kline[i - 1];
        const high = safeNumber(current.high_px);
        const low = safeNumber(current.low_px);
        const prevClose = safeNumber(prev.close_px);
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    const atr = average(trueRanges.slice(-period));
    const latestClose = safeNumber(kline[kline.length - 1]?.close_px);
    return latestClose ? (atr / latestClose) * 100 : 0;
};

const slopeScore = (values = [], lookback = 5) => {
    if (values.length < lookback) return 0;
    const recent = values.slice(-lookback).filter((item) => item !== null && item !== undefined);
    if (recent.length < 2) return 0;
    return percentChange(recent[0], recent[recent.length - 1]);
};

const getRangePosition = (value, low, high) => {
    const width = high - low;
    if (width <= 0) return 0.5;
    return clamp((value - low) / width, 0, 1);
};

const getUpperShadowPercent = (item) => {
    const high = safeNumber(item.high_px);
    const open = safeNumber(item.open_px);
    const close = safeNumber(item.close_px);
    const ref = Math.max(open, close);
    return ref ? ((high - ref) / ref) * 100 : 0;
};

const rankBlocksForDay = (dayData) => Object.entries(dayData?.blocks || {})
    .map(([name, value]) => ({ name, avgChange: safeNumber(value?.avgChange) }))
    .sort((a, b) => b.avgChange - a.avgChange);

const getManualLineMap = () => {
    const items = safeReadJson(path.join(__dirname, '../data/marketMainLine.json'), []);
    const fallbackItems = Array.isArray(items) ? items : [];
    const fileItems = fallbackItems.length ? fallbackItems : (() => {
        try {
            return getMainLine();
        } catch (error) {
            return [];
        }
    })();

    return new Map(
        (Array.isArray(fileItems) ? fileItems : [])
            .filter((item) => item && item.blockName)
            .map((item) => [item.blockName, item])
    );
};

const parseAmountToYi = (value) => {
    if (typeof value === 'number') return value;
    const str = String(value || '').trim();
    if (!str) return 0;
    const sign = str.startsWith('-') ? -1 : 1;
    const clean = str.replace(/[+-]/g, '');
    const num = parseFloat(clean.replace(/亿|万/g, '')) || 0;
    if (clean.includes('万')) {
        return sign * (num / 10000);
    }
    return sign * num;
};

const buildMarketAmountContext = (amountHistory, amountDayHistory) => {
    const latestIntraday = amountHistory[amountHistory.length - 1] || null;
    const previousIntraday = amountHistory[amountHistory.length - 2] || null;
    const latestInfo = latestIntraday?.[1] || {};
    const latestTime = latestIntraday?.[0] || '';
    const currentMainMoney = parseAmountToYi(latestInfo.mainMoney);
    const currentAmountDiff = parseAmountToYi(latestInfo.amountChangeDiff);
    const previousMainMoney = parseAmountToYi(previousIntraday?.[1]?.mainMoney);
    const previousAmountDiff = parseAmountToYi(previousIntraday?.[1]?.amountChangeDiff);

    const recentIntradayMoney = amountHistory.slice(-6).map((item) => parseAmountToYi(item?.[1]?.mainMoney));
    const recentIntradayAmount = amountHistory.slice(-6).map((item) => parseAmountToYi(item?.[1]?.amountChangeDiff));
    const flowTrendDelta = recentIntradayMoney.length >= 2
        ? safeNumber(recentIntradayMoney[recentIntradayMoney.length - 1]) - safeNumber(recentIntradayMoney[0])
        : 0;
    const amountTrendDelta = recentIntradayAmount.length >= 2
        ? safeNumber(recentIntradayAmount[recentIntradayAmount.length - 1]) - safeNumber(recentIntradayAmount[0])
        : 0;
    const latestDay = amountDayHistory[0] || null;
    const prevDay = amountDayHistory[1] || null;
    const dayMainMoneyDelta = latestDay && prevDay ? safeNumber(latestDay.mainMoney) - safeNumber(prevDay.mainMoney) : 0;
    const dayAmountDelta = latestDay && prevDay ? safeNumber(latestDay.amountChangeDiff) - safeNumber(prevDay.amountChangeDiff) : 0;

    let action = '观望';
    let bias = 'neutral';
    let score = 0;
    const reasons = [];

    if (currentMainMoney > 120) {
        score += 7;
        reasons.push(`当前主力资金净流入 ${round(currentMainMoney)} 亿`);
    } else if (currentMainMoney < -120) {
        score -= 8;
        reasons.push(`当前主力资金净流出 ${round(Math.abs(currentMainMoney))} 亿`);
    }

    if (currentAmountDiff > 800) {
        score += 5;
        reasons.push(`当前较昨日明显放量 ${round(currentAmountDiff)} 亿`);
    } else if (currentAmountDiff < -300) {
        score -= 5;
        reasons.push(`当前较昨日缩量 ${round(currentAmountDiff)} 亿`);
    }

    if (flowTrendDelta > 120) {
        score += 4;
        reasons.push('近几笔分时主力资金持续回流');
    } else if (flowTrendDelta < -120) {
        score -= 4;
        reasons.push('近几笔分时主力资金持续走弱');
    }

    if (amountTrendDelta > 500) {
        score += 2;
    } else if (amountTrendDelta < -500) {
        score -= 2;
    }

    if (dayMainMoneyDelta > 300) {
        score += 2;
    } else if (dayMainMoneyDelta < -300) {
        score -= 2;
    }

    if (dayAmountDelta > 1000) {
        score += 1;
    } else if (dayAmountDelta < -1000) {
        score -= 1;
    }

    const recentPeakMoney = recentIntradayMoney.length ? Math.max(...recentIntradayMoney) : currentMainMoney;
    const recentLowMoney = recentIntradayMoney.length ? Math.min(...recentIntradayMoney) : currentMainMoney;
    const inflowSlowdown = currentMainMoney > 0
        && previousMainMoney > 0
        && currentMainMoney < previousMainMoney - 60
        && currentMainMoney < recentPeakMoney * 0.82;
    const outflowWorsening = currentMainMoney < 0
        && previousMainMoney < 0
        && currentMainMoney < previousMainMoney - 60
        && currentMainMoney <= recentLowMoney;
    const volumeCooling = currentAmountDiff > 0
        && previousAmountDiff > 0
        && currentAmountDiff < previousAmountDiff - 300;

    if (inflowSlowdown) {
        reasons.push('主力资金净流入放缓，注意高位分歧风险');
    }
    if (outflowWorsening) {
        reasons.push('主力资金净流出持续扩大，需防止进一步杀跌');
    }
    if (volumeCooling) {
        reasons.push('量能边际回落，情绪可能从加速转向分歧');
    }

    if (score >= 8) {
        action = '买入观察';
        bias = 'riskOn';
    } else if (score >= 3) {
        action = '偏买入';
        bias = 'riskOn';
    } else if (score <= -8) {
        action = '防守观望';
        bias = 'riskOff';
    } else if (score <= -3) {
        action = '防守观察';
        bias = 'riskOff';
    }

    const summary = reasons.length
        ? `大盘建议：${action}。${reasons.slice(0, 3).join('，')}。`
        : '大盘分时资金与成交量暂无有效指引，先以观望为主。';

    const pulseReason = outflowWorsening
        ? '主力资金净流出扩大'
        : inflowSlowdown
            ? '主力资金净流入放缓'
            : volumeCooling
                ? '量能边际回落'
                : '';
    const shouldBlink = Boolean(pulseReason);

    return {
        action,
        bias,
        score: round(score),
        currentTime: latestTime,
        currentMainMoney: round(currentMainMoney),
        currentAmountDiff: round(currentAmountDiff),
        flowTrendDelta: round(flowTrendDelta),
        amountTrendDelta: round(amountTrendDelta),
        summary,
        reasons,
        latestDay,
        signal: {
            shouldBlink,
            type: outflowWorsening ? 'riskOff' : inflowSlowdown || volumeCooling ? 'warning' : 'neutral',
            reason: pulseReason,
        },
    };
};

const normalizeKeyword = (value) => String(value || '').replace(/\s+/g, '').trim().toLowerCase();

const findMonitorStock = (keyword, monitorStocks = []) => {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) return null;

    const exact = monitorStocks.find((item) => {
        const name = normalizeKeyword(item?.name);
        const code = normalizeKeyword(item?.code);
        return name === normalized || code === normalized;
    });
    if (exact) return exact;

    return monitorStocks.find((item) => {
        const name = normalizeKeyword(item?.name);
        const code = normalizeKeyword(item?.code);
        return name.includes(normalized) || code.includes(normalized);
    }) || null;
};

const buildSectorState = (blockName, blockDataHistory, blockMoneyHistory, manualLineMap) => {
    const sortedBlockHistory = [...blockDataHistory].sort((a, b) => Number(b.date) - Number(a.date));
    const sortedMoneyHistory = [...blockMoneyHistory].sort((a, b) => Number(b.date) - Number(a.date));
    const classification = classifySectorBlocksDaily(sortedBlockHistory, 5);
    const currentDay = classification?.dailyResults?.[0] || null;
    const latestDay = sortedBlockHistory[0] || null;
    const latestRanks = rankBlocksForDay(latestDay);
    const latestRank = Math.max(1, latestRanks.findIndex((item) => item.name === blockName) + 1);
    const totalBlocks = latestRanks.length || 1;

    const recentChanges = sortedBlockHistory
        .slice(0, 5)
        .map((day) => safeNumber(day?.blocks?.[blockName]?.avgChange))
        .filter((item) => Number.isFinite(item));
    const previousChanges = sortedBlockHistory
        .slice(5, 10)
        .map((day) => safeNumber(day?.blocks?.[blockName]?.avgChange))
        .filter((item) => Number.isFinite(item));

    const recentMoney = sortedMoneyHistory
        .slice(0, 5)
        .map((day) => safeNumber(day?.blockAmounts?.[blockName]))
        .filter((item) => Number.isFinite(item));
    const previousMoney = sortedMoneyHistory
        .slice(5, 10)
        .map((day) => safeNumber(day?.blockAmounts?.[blockName]))
        .filter((item) => Number.isFinite(item));

    const recentAvgChange = average(recentChanges);
    const previousAvgChange = average(previousChanges);
    const recentAvgMoney = average(recentMoney);
    const previousAvgMoney = average(previousMoney);
    const detail = currentDay?.details?.[blockName] || null;
    const manual = manualLineMap.get(blockName);

    let role = detail?.category || '弱势';
    if (manual?.lineType === 'main') role = '主线';
    if (manual?.lineType === 'branch') role = '支线';

    const roleScoreMap = {
        主线: 18,
        支线: 8,
        止跌企稳: 4,
        掉队: -10,
        弱势: -6,
    };

    const moneyTrend = recentAvgMoney > previousAvgMoney * 1.05
        ? 'increasing'
        : recentAvgMoney < previousAvgMoney * 0.95
            ? 'decreasing'
            : 'stable';

    const tags = [];
    if (role === '主线') tags.push('当前主线');
    if (role === '支线') tags.push('支线轮动');
    if (recentAvgChange > 1) tags.push('板块偏强');
    if (moneyTrend === 'increasing') tags.push('资金增配');
    if (role === '掉队') tags.push('板块掉队');

    return {
        role,
        latestRank,
        totalBlocks,
        rankPercentile: totalBlocks ? 1 - (latestRank - 1) / totalBlocks : 0,
        recentAvgChange: round(recentAvgChange),
        previousAvgChange: round(previousAvgChange),
        changeMomentum: round(recentAvgChange - previousAvgChange),
        recentAvgMoney: round(recentAvgMoney / 1e8),
        previousAvgMoney: round(previousAvgMoney / 1e8),
        moneyTrend,
        reasons: detail?.reasons || [],
        manualReason: manual?.reason || '',
        score: roleScoreMap[role] || 0,
        tags,
        topMainLines: currentDay?.classification?.主线 || [],
        branchLines: currentDay?.classification?.支线 || [],
        laggingLines: currentDay?.classification?.掉队 || [],
        marketJudgment: currentDay?.marketJudgment || null,
    };
};

const buildMarketContext = (sentiment, sectorStateSample, marketAmountContext) => {
    const currentPhase = sentiment?.current?.phase || '震荡期';
    const stageLabel = sentiment?.current?.stageLabel || sentiment?.cycle?.stageLabel || '';
    const confidence = safeNumber(sentiment?.tomorrow?.confidence || sentiment?.confidence, 55);
    const biasLabel = sentiment?.tomorrow?.biasLabel || '分化震荡';
    const mainLineBlocks = sectorStateSample?.topMainLines || [];
    const branchBlocks = sectorStateSample?.branchLines || [];
    const laggingBlocks = sectorStateSample?.laggingLines || [];

    let regime = '快速轮动';
    if (currentPhase === '退潮期') {
        regime = '退潮防守';
    } else if (currentPhase === '高潮期' && stageLabel !== '后段' && mainLineBlocks.length <= 3) {
        regime = '抱团主升';
    } else if (currentPhase === '高潮期') {
        regime = '高位抱团分歧';
    } else if (currentPhase === '震荡期' && mainLineBlocks.length >= 3) {
        regime = '主线扩散轮动';
    }

    let chasingRiskLevel = '中';
    if (currentPhase === '退潮期' || regime === '高位抱团分歧') {
        chasingRiskLevel = '高';
    } else if (regime === '抱团主升' && confidence >= 70) {
        chasingRiskLevel = '低';
    }

    if (marketAmountContext?.bias === 'riskOff') {
        chasingRiskLevel = '高';
    } else if (marketAmountContext?.bias === 'riskOn' && chasingRiskLevel !== '高') {
        chasingRiskLevel = '低';
    }

    const summaryLines = [
        ...(sectorStateSample?.marketJudgment?.summaryLines || []),
        `情绪周期：${currentPhase}${stageLabel ? `·${stageLabel}` : ''}，明日偏向 ${biasLabel}，模型把握度 ${confidence}%。`,
        `当前市场更像“${regime}”，追高风险评估为 ${chasingRiskLevel}。`,
        marketAmountContext?.summary,
    ];

    return {
        phase: currentPhase,
        stageLabel,
        score: round(sentiment?.current?.score),
        confidence,
        biasLabel,
        regime,
        chasingRiskLevel,
        mainLineBlocks,
        branchBlocks,
        laggingBlocks,
        summaryLines,
        marketAdvice: marketAmountContext,
    };
};

const analyzeKlineStructure = (sortedKline) => {
    const closes = sortedKline.map((item) => safeNumber(item.close_px));
    const highs = sortedKline.map((item) => safeNumber(item.high_px));
    const lows = sortedKline.map((item) => safeNumber(item.low_px));
    const volumes = sortedKline.map((item) => safeNumber(item.business_amount || item.business_balance));
    const ema5 = calculateEMA(closes, 5);
    const ema10 = calculateEMA(closes, 10);
    const ema20 = calculateEMA(closes, 20);
    const ema60 = calculateEMA(closes, 60);
    const sma5 = calculateSMA(closes, 5);
    const macd = calculateMACD(closes);
    const latest = sortedKline[sortedKline.length - 1];
    const prev = sortedKline[sortedKline.length - 2];
    const latestClose = safeNumber(latest.close_px);
    const latestOpen = safeNumber(latest.open_px);
    const latestHigh = safeNumber(latest.high_px);
    const latestLow = safeNumber(latest.low_px);
    const latestEma5 = ema5[ema5.length - 1];
    const latestEma10 = ema10[ema10.length - 1];
    const latestEma20 = ema20[ema20.length - 1];
    const latestEma60 = ema60[ema60.length - 1];
    const latestMacd = safeNumber(macd.macd[macd.macd.length - 1]);
    const prevMacd = safeNumber(macd.macd[macd.macd.length - 2]);
    const avgVol3 = average(volumes.slice(-3));
    const avgVol5 = average(volumes.slice(-5));
    const avgVol10 = average(volumes.slice(-10));
    const avgVol20 = average(volumes.slice(-20));
    const recent20High = Math.max(...highs.slice(-20));
    const recent20Low = Math.min(...lows.slice(-20));
    const prior20High = Math.max(...highs.slice(-21, -1));
    const prior10High = Math.max(...highs.slice(-11, -1));
    const atrPct = calculateATRPercent(sortedKline, 14);
    const latestChange = safeNumber(latest.change);
    const last5Change = average(sortedKline.slice(-5).map((item) => safeNumber(item.change)));
    const upperShadowPct = getUpperShadowPercent(latest);
    const closePosition20 = getRangePosition(latestClose, recent20Low, recent20High);
    const distanceToEma5 = percentChange(latestEma5, latestClose);
    const distanceToEma10 = percentChange(latestEma10, latestClose);
    const trendSlope5 = slopeScore(ema5, 5);
    const trendSlope10 = slopeScore(ema10, 5);
    const isBullTrend = latestClose > latestEma5 && latestEma5 > latestEma10 && latestEma10 > latestEma20;
    const isTrendHealthy = latestEma20 >= latestEma60 * 0.99;
    const recentPullback = sum(sortedKline.slice(-3).map((item) => safeNumber(item.change))) < 1.5 && last5Change > 0;
    const pullbackLow = Math.min(...lows.slice(-3));
    const lowAbsorbSignal = recentPullback
        && pullbackLow >= latestEma5 * 0.985
        && avgVol3 < avgVol10 * 0.88
        && trendSlope5 >= -1.5;
    const breakoutSignal = latestClose > prior20High * 1.005
        && avgVol3 > avgVol20 * 1.25
        && latestMacd >= prevMacd;
    const climaxTopRisk = closePosition20 > 0.85
        && avgVol3 > avgVol20 * 1.85
        && upperShadowPct > 2.2
        && latestClose < latestOpen;
    const distributionRisk = closePosition20 > 0.8
        && avgVol5 > avgVol20 * 1.45
        && latestClose < latestEma5
        && latestMacd < prevMacd;

    let trendScore = 0;
    if (isBullTrend) trendScore += 18;
    else if (latestClose > latestEma10) trendScore += 8;
    else if (latestClose < latestEma20) trendScore -= 10;
    if (isTrendHealthy) trendScore += 6;
    if (trendSlope5 > 2.5) trendScore += 6;
    if (trendSlope10 < -2) trendScore -= 6;

    let structureScore = 0;
    if (lowAbsorbSignal) structureScore += 14;
    if (breakoutSignal) structureScore += 12;
    if (closePosition20 > 0.7) structureScore += 4;
    if (closePosition20 < 0.35) structureScore -= 4;
    if (distanceToEma5 > 8) structureScore -= 5;
    if (climaxTopRisk) structureScore -= 18;
    if (distributionRisk) structureScore -= 10;

    let volumeScore = 0;
    if (avgVol5 > avgVol20 * 1.2 && latestChange > 0) volumeScore += 8;
    if (avgVol3 < avgVol10 * 0.88 && lowAbsorbSignal) volumeScore += 6;
    if (avgVol5 > avgVol20 * 1.7 && latestChange < 0) volumeScore -= 8;

    const tags = [];
    if (isBullTrend) tags.push('均线多头');
    if (lowAbsorbSignal) tags.push('缩量回踩');
    if (breakoutSignal) tags.push('放量突破');
    if (climaxTopRisk) tags.push('高位巨量');
    if (distributionRisk) tags.push('分歧转弱');

    return {
        latestClose,
        latestChange,
        ema5: round(latestEma5),
        ema10: round(latestEma10),
        ema20: round(latestEma20),
        ema60: round(latestEma60),
        sma5: round(sma5[sma5.length - 1]),
        latestMacd: round(latestMacd, 4),
        prevMacd: round(prevMacd, 4),
        atrPct: round(atrPct),
        closePosition20: round(closePosition20 * 100),
        volRatio5To20: round(avgVol20 ? avgVol5 / avgVol20 : 1),
        distanceToEma5: round(distanceToEma5),
        distanceToEma10: round(distanceToEma10),
        trendSlope5: round(trendSlope5),
        trendSlope10: round(trendSlope10),
        lowAbsorbSignal,
        breakoutSignal,
        climaxTopRisk,
        distributionRisk,
        trendScore,
        structureScore,
        volumeScore,
        tags,
        summary: {
            bullish: isBullTrend,
            recentPullback,
            upperShadowPct: round(upperShadowPct),
            avgVol3: round(avgVol3),
            avgVol20: round(avgVol20),
            recent20High: round(recent20High),
            prior10High: round(prior10High),
            latestHigh: round(latestHigh),
            latestLow: round(latestLow),
            prevClose: round(prev?.close_px),
        },
    };
};

const analyzeIntradayStrength = (tlineData, benchmarkLine, code) => {
    const line = Array.isArray(tlineData?.line) ? [...tlineData.line].sort((a, b) => safeNumber(a.minute) - safeNumber(b.minute)) : [];
    if (line.length < 20) {
        return {
            score: 0,
            resilienceScore: 0,
            closePosition: 50,
            aboveVwap: false,
            chaseRisk: '中',
            tags: [],
            summary: '分时数据不足',
            line,
        };
    }

    const first = line[0];
    const last = line[line.length - 1];
    const prices = line.map((item) => safeNumber(item.last_px));
    const volumes = line.map((item) => safeNumber(item.business_amount));
    const intradayHigh = Math.max(...prices);
    const intradayLow = Math.min(...prices);
    const closePosition = getRangePosition(safeNumber(last.last_px), intradayLow, intradayHigh);
    const first30 = line.slice(0, 30);
    const afternoonStart = line.find((item) => safeNumber(item.minute) >= 1300) || line[Math.floor(line.length / 2)];
    const openingChange = safeNumber(first30[first30.length - 1]?.change) - safeNumber(first.change);
    const afternoonChange = safeNumber(last.change) - safeNumber(afternoonStart?.change);
    const weightedAmount = line.reduce((acc, item) => acc + safeNumber(item.last_px) * safeNumber(item.business_amount), 0);
    const totalVolume = sum(volumes);
    const vwap = totalVolume ? weightedAmount / totalVolume : safeNumber(last.last_px);
    const fadeFromHigh = intradayHigh ? ((intradayHigh - safeNumber(last.last_px)) / intradayHigh) * 100 : 0;
    const limitType = getLimitTypeByCode(code);
    const resilienceScore = benchmarkLine?.length ? calculateResilience(benchmarkLine, line, limitType) : 0;

    let score = 0;
    if (resilienceScore >= 15) score += 12;
    else if (resilienceScore >= 10) score += 8;
    else if (resilienceScore < 5) score -= 6;
    if (closePosition >= 0.7) score += 6;
    else if (closePosition < 0.4) score -= 6;
    if (afternoonChange > 0.8) score += 6;
    else if (afternoonChange < -0.8) score -= 6;
    if (safeNumber(last.last_px) > vwap) score += 4;
    if (openingChange > 2.2 && fadeFromHigh > 2.5) score -= 6;

    let chaseRisk = '中';
    if ((openingChange > 2.5 && fadeFromHigh > 2.5) || closePosition < 0.4) {
        chaseRisk = '高';
    } else if (closePosition > 0.72 && safeNumber(last.last_px) >= vwap && afternoonChange >= 0) {
        chaseRisk = '低';
    }

    const tags = [];
    if (resilienceScore >= 12) tags.push('分时抗跌');
    if (safeNumber(last.last_px) > vwap) tags.push('站上VWAP');
    if (afternoonChange > 0.6) tags.push('尾盘走强');
    if (chaseRisk === '高') tags.push('脉冲回落');

    return {
        score,
        resilienceScore: round(resilienceScore, 2),
        closePosition: round(closePosition * 100),
        openingChange: round(openingChange),
        afternoonChange: round(afternoonChange),
        vwap: round(vwap),
        aboveVwap: safeNumber(last.last_px) >= vwap,
        fadeFromHigh: round(fadeFromHigh),
        chaseRisk,
        tags,
        summary: `开盘段 ${formatPercent(openingChange)}，午后段 ${formatPercent(afternoonChange)}，收在日内区间 ${round(closePosition * 100)}% 位置。`,
        line,
    };
};

const analyzeIntradayPattern = (tlineData) => {
    const line = Array.isArray(tlineData?.line) ? [...tlineData.line].sort((a, b) => safeNumber(a.minute) - safeNumber(b.minute)) : [];
    if (line.length < 20) {
        return {
            pattern: '数据不足',
            patternLabel: '暂无分时解析',
            patternDesc: '分时数据不足，无法进行有效解析',
            details: [],
            suggestion: '等待更多分时数据',
            metrics: {},
        };
    }

    const first = line[0];
    const last = line[line.length - 1];
    const prices = line.map((item) => safeNumber(item.last_px));
    const volumes = line.map((item) => safeNumber(item.business_amount));
    const changes = line.map((item) => safeNumber(item.change));
    const intradayHigh = Math.max(...prices);
    const intradayLow = Math.min(...prices);
    const latestPrice = safeNumber(last.last_px);
    const latestChange = safeNumber(last.change);
    const openPrice = safeNumber(first.last_px);

    const first30 = line.slice(0, 30);
    const morningEnd = line.find((item) => safeNumber(item.minute) >= 1130) || line[Math.floor(line.length * 0.45)];
    const afternoonStart = line.find((item) => safeNumber(item.minute) >= 1300) || line[Math.floor(line.length * 0.55)];
    const last30 = line.slice(-30);

    const openingChange = safeNumber(first30[first30.length - 1]?.change) - safeNumber(first.change);
    const morningChange = safeNumber(morningEnd?.change) - safeNumber(first.change);
    const afternoonChange = safeNumber(last.change) - safeNumber(afternoonStart?.change);
    const lateChange = safeNumber(last.change) - safeNumber(last30[0]?.change);

    const weightedAmount = line.reduce((acc, item) => acc + safeNumber(item.last_px) * safeNumber(item.business_amount), 0);
    const totalVolume = sum(volumes);
    const vwap = totalVolume ? weightedAmount / totalVolume : latestPrice;

    const morningVolumes = line.filter((item) => safeNumber(item.minute) < 1130).map((item) => safeNumber(item.business_amount));
    const afternoonVolumes = line.filter((item) => safeNumber(item.minute) >= 1300).map((item) => safeNumber(item.business_amount));
    const morningVolume = sum(morningVolumes);
    const afternoonVolume = sum(afternoonVolumes);
    const volumeRatio = morningVolume > 0 ? afternoonVolume / morningVolume : 1;

    const amplitude = ((intradayHigh - intradayLow) / openPrice * 100) || 0;
    const closePosition = getRangePosition(latestPrice, intradayLow, intradayHigh);
    const distanceFromVwap = ((latestPrice - vwap) / vwap * 100) || 0;
    const fadeFromHigh = intradayHigh ? ((intradayHigh - latestPrice) / intradayHigh * 100) : 0;

    const earlyMorning = line.slice(0, 15);
    const earlyPrices = earlyMorning.map((item) => safeNumber(item.last_px));
    const earlyHigh = Math.max(...earlyPrices);
    const earlyLow = Math.min(...earlyPrices);
    const earlyRange = ((earlyHigh - earlyLow) / openPrice * 100) || 0;

    const isOpeningGapUp = latestPrice > openPrice * 1.02;
    const isOpeningGapDown = latestPrice < openPrice * 0.98;
    const isSpikeAndFade = openingChange > 3 && fadeFromHigh > 2.5;
    const isSteadyRise = afternoonChange > 1 && closePosition > 0.7 && latestPrice >= vwap;
    const isAfternoonBreakout = afternoonChange > 1.5 && volumeRatio > 1.2;
    const isWeakClose = lateChange < -0.8 && latestPrice < vwap;
    const isVolumeShrinkage = volumeRatio < 0.6;
    const isVolumeExpansion = volumeRatio > 1.5;

    let pattern = '震荡整理';
    let patternLabel = '震荡整理';
    let patternDesc = '';
    const details = [];
    let suggestion = '先观察震荡区间是否被有效突破';

    if (isSpikeAndFade) {
        pattern = '冲高回落';
        patternLabel = '冲高回落';
        patternDesc = '开盘快速冲高后未能持续，逐步回落';
        details.push(`开盘 30 分钟涨幅 ${formatPercent(openingChange)}，但从日内高点回落 ${formatPercent(fadeFromHigh)}`);
        details.push(`收盘位于日内区间 ${round(closePosition * 100)}% 位置，偏弱`);
        if (latestPrice < vwap) {
            details.push('收盘价低于 VWAP，资金承接不足');
        }
        suggestion = '需警惕假突破风险，等待回踩确认或二次上攻';
    } else if (isSteadyRise) {
        pattern = '稳步上升';
        patternLabel = '稳步上升';
        patternDesc = '全天走势稳健，午后继续走强';
        details.push(`早盘涨幅 ${formatPercent(morningChange)}，午后继续拉升 ${formatPercent(afternoonChange)}`);
        details.push(`收盘价位于日内区间高位 ${round(closePosition * 100)}%`);
        details.push(`收盘价 ${latestPrice >= vwap ? '高于' : '低于'} VWAP (${round(vwap)})`);
        if (isVolumeExpansion) {
            details.push('午后放量上涨，资金跟进积极');
        }
        suggestion = '趋势较强，可关注回踩后的低吸机会';
    } else if (isAfternoonBreakout) {
        pattern = '午后突破';
        patternLabel = '午后突破';
        patternDesc = '午后放量突破，走势较为强势';
        details.push(`午后涨幅 ${formatPercent(afternoonChange)}，量能较上午放大 ${round((volumeRatio - 1) * 100)}%`);
        details.push(`振幅 ${formatPercent(amplitude)}，波动较大`);
        if (latestPrice >= vwap) {
            details.push('突破后站上 VWAP，形态健康');
        }
        suggestion = '放量突破形态较为强势，但需注意追高风险';
    } else if (isWeakClose) {
        pattern = '尾盘走弱';
        patternLabel = '尾盘走弱';
        patternDesc = '尾盘出现明显回落，走势偏弱';
        details.push(`最后 30 分钟下跌 ${formatPercent(lateChange)}`);
        details.push(`收盘价低于 VWAP ${formatPercent(Math.abs(distanceFromVwap))}`);
        details.push(`从日内高点回落 ${formatPercent(fadeFromHigh)}`);
        suggestion = '尾盘资金出逃迹象，建议先减仓观望';
    } else if (isVolumeShrinkage && Math.abs(latestChange) < 1.5) {
        pattern = '缩量震荡';
        patternLabel = '缩量震荡';
        patternDesc = '全天缩量震荡，交投意愿低迷';
        details.push(`午后量能仅为上午的 ${round(volumeRatio * 100)}%`);
        details.push(`振幅仅 ${formatPercent(amplitude)}，波动较小`);
        details.push(`收盘位于日内区间 ${round(closePosition * 100)}%`);
        suggestion = '等待量能放大确认方向，暂不急于操作';
    } else if (isVolumeExpansion && Math.abs(latestChange) >= 3) {
        pattern = '放量大涨';
        patternLabel = '放量大涨';
        patternDesc = '全天放量大涨，资金介入明显';
        details.push(`全天涨幅 ${formatPercent(latestChange)}`);
        details.push(`午后量能较上午放大 ${round((volumeRatio - 1) * 100)}%`);
        details.push(`收盘价位于日内区间高位 ${round(closePosition * 100)}%`);
        if (latestPrice >= vwap) {
            details.push('收盘价高于 VWAP，量价配合良好');
        }
        suggestion = '强势特征明显，可适当跟进，但需设止损';
    } else if (isOpeningGapUp && morningChange > 0) {
        pattern = '高开高走';
        patternLabel = '高开高走';
        patternDesc = '高开后继续走高，多头意愿较强';
        details.push(`开盘高开 ${formatPercent(latestChange - morningChange + openingChange)}`);
        details.push(`早盘涨幅 ${formatPercent(morningChange)}`);
        details.push(`收盘位于日内区间 ${round(closePosition * 100)}%`);
        suggestion = '高开高走形态积极，关注持续性';
    } else if (isOpeningGapDown && morningChange < 0) {
        pattern = '低开低走';
        patternLabel = '低开低走';
        patternDesc = '低开后继续走低，空头主导';
        details.push(`开盘低开 ${formatPercent(Math.abs(latestChange - morningChange + openingChange))}`);
        details.push(`早盘跌幅 ${formatPercent(morningChange)}`);
        details.push(`收盘位于日内区间低位 ${round(closePosition * 100)}%`);
        suggestion = '低开低走形态偏弱，暂不参与';
    } else if (earlyRange > 4 && Math.abs(openingChange) < 1) {
        pattern = '开盘剧烈震荡';
        patternLabel = '开盘剧烈震荡';
        patternDesc = '开盘阶段剧烈震荡，多空分歧较大';
        details.push(`开盘 15 分钟振幅达 ${formatPercent(earlyRange)}`);
        details.push(`但开盘 30 分钟净涨幅仅 ${formatPercent(openingChange)}`);
        suggestion = '多空分歧较大，等待方向明确';
    } else if (closePosition > 0.85 && latestPrice >= vwap) {
        pattern = '强势高位';
        patternLabel = '强势高位';
        patternDesc = '收盘位于日内高位，走势较强';
        details.push(`收盘位于日内区间高位 ${round(closePosition * 100)}%`);
        details.push(`收盘价高于 VWAP ${formatPercent(distanceFromVwap)}`);
        if (fadeFromHigh < 1) {
            details.push('几乎没有从高点回落，强势特征明显');
        }
        suggestion = '高位强势，但追高需谨慎，可等回踩';
    } else if (closePosition < 0.15 && latestPrice < vwap) {
        pattern = '弱势低位';
        patternLabel = '弱势低位';
        patternDesc = '收盘位于日内低位，走势偏弱';
        details.push(`收盘位于日内区间低位 ${round(closePosition * 100)}%`);
        details.push(`收盘价低于 VWAP ${formatPercent(Math.abs(distanceFromVwap))}`);
        suggestion = '低位弱势，暂不介入，等待止跌信号';
    }

    const intervalAnalysis = buildIntradayIntervalAnalysis(line, openPrice, vwap);

    return {
        pattern,
        patternLabel,
        patternDesc,
        details: details.slice(0, 5),
        suggestion,
        intervalAnalysis,
        metrics: {
            openingChange: round(openingChange),
            morningChange: round(morningChange),
            afternoonChange: round(afternoonChange),
            lateChange: round(lateChange),
            vwap: round(vwap),
            distanceFromVwap: round(distanceFromVwap),
            closePosition: round(closePosition * 100),
            amplitude: round(amplitude),
            fadeFromHigh: round(fadeFromHigh),
            volumeRatio: round(volumeRatio, 2),
            latestPrice: round(latestPrice),
            latestChange: round(latestChange),
        },
    };
};

const addHHMMMinutes = (hhmm, delta) => {
    const total = Math.floor(hhmm / 100) * 60 + (hhmm % 100) + delta;
    return Math.floor(total / 60) * 100 + (total % 60);
};

const buildIntradayIntervalAnalysis = (line, openPrice, vwap, indexLine = []) => {
    if (!Array.isArray(line) || line.length < 20) {
        return [];
    }

    const INTERVAL = 10;

    // 辅助函数
    const safeNumber = (val) => {
        const n = Number(val);
        return isNaN(n) ? 0 : n;
    };

    const round = (val, digits = 2) => {
        const n = Number(val);
        if (isNaN(n)) return 0;
        const factor = Math.pow(10, digits);
        return Math.round(n * factor) / factor;
    };

    const minutesToDisplay = (minutes) => {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // 1. 时间切片
    const buckets = new Map();
    for (const item of line) {
        const minute = safeNumber(item.minute);
        const key = Math.floor(minute / INTERVAL) * INTERVAL;
        if (!buckets.has(key)) {
            buckets.set(key, []);
        }
        buckets.get(key).push(item);
    }

    // 构建指数的时间切片
    const indexBuckets = new Map();
    if (Array.isArray(indexLine) && indexLine.length > 0) {
        for (const item of indexLine) {
            const minute = safeNumber(item.minute);
            const key = Math.floor(minute / INTERVAL) * INTERVAL;
            if (!indexBuckets.has(key)) {
                indexBuckets.set(key, []);
            }
            indexBuckets.get(key).push(item);
        }
    }

    const intervals = [];
    for (const [start, records] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        if (records.length < 2) continue;

        const first = records[0];
        const last = records.at(-1);
        const startPrice = safeNumber(first.last_px);
        const endPrice = safeNumber(last.last_px);
        const volume = records.reduce((sum, x) => sum + safeNumber(x.business_amount), 0);
        const highPrice = Math.max(...records.map(r => safeNumber(r.last_px)));
        const lowPrice = Math.min(...records.map(r => safeNumber(r.last_px)));

        // 指数数据
        let indexChange = 0;
        let indexStartPrice = 0;
        let indexEndPrice = 0;
        const indexRecords = indexBuckets.get(start);
        if (indexRecords && indexRecords.length >= 2) {
            const idxFirst = indexRecords[0];
            const idxLast = indexRecords.at(-1);
            indexStartPrice = safeNumber(idxFirst.last_px);
            indexEndPrice = safeNumber(idxLast.last_px);
            if (indexStartPrice > 0) {
                indexChange = (indexEndPrice - indexStartPrice) / indexStartPrice * 100;
            }
        }

        intervals.push({
            start,
            end: start + INTERVAL,
            startPrice,
            endPrice,
            highPrice,
            lowPrice,
            volume,
            priceChange: (endPrice - startPrice) / openPrice * 100,
            changeDelta: safeNumber(last.change) - safeNumber(first.change),
            indexChange,
            indexStartPrice,
            indexEndPrice,
            hasIndexData: indexStartPrice > 0
        });
    }

    if (!intervals.length) return [];

    // 2. 动态量能基准 - 分时段计算
    const getTimeSlot = (start) => {
        if (start < 630) return 'morning';   // 9:30-10:30
        if (start < 810) return 'mid';       // 10:30-13:30
        if (start < 870) return 'afternoon'; // 13:30-14:30
        return 'late';                        // 14:30-15:00
    };

    const slotVolumes = {};
    intervals.forEach(iv => {
        const slot = getTimeSlot(iv.start);
        if (!slotVolumes[slot]) slotVolumes[slot] = [];
        slotVolumes[slot].push(iv.volume);
    });

    const slotAvg = {};
    for (const [slot, vols] of Object.entries(slotVolumes)) {
        slotAvg[slot] = vols.reduce((a, b) => a + b, 0) / vols.length;
    }

    // 3. 计算波动率基准
    const priceChanges = intervals.map(x => x.priceChange);
    const priceChangeMean = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;
    const priceChangeStd = Math.sqrt(
        priceChanges.reduce((sum, x) => sum + Math.pow(x - priceChangeMean, 2), 0) 
        / priceChanges.length
    ) || 0.5;

    const indexChanges = intervals.filter(x => x.hasIndexData).map(x => x.indexChange);
    const indexChangeMean = indexChanges.length > 0 ? indexChanges.reduce((a, b) => a + b, 0) / indexChanges.length : 0;
    const indexChangeStd = indexChanges.length > 0 
        ? Math.sqrt(
            indexChanges.reduce((sum, x) => sum + Math.pow(x - indexChangeMean, 2), 0) 
            / indexChanges.length
        ) || 0.3
        : 0.3;

    // 4. Feature Engine
    const features = intervals.map((x, i) => {
        const prev = intervals[i - 1];
        const prev2 = intervals[i - 2];
        const slot = getTimeSlot(x.start);
        const slotVolumeBase = slotAvg[slot] || x.volume;
        
        const volumeRatio = x.volume / slotVolumeBase;
        
        const aboveVWAP = x.endPrice >= vwap;
        const vwapDistance = vwap > 0 ? (x.endPrice - vwap) / vwap * 100 : 0;
        const crossVWAPUp = prev && prev.endPrice < vwap && x.endPrice >= vwap;
        const crossVWAPDown = prev && prev.endPrice >= vwap && x.endPrice < vwap;
        
        const bodyChange = x.priceChange;
        const wickRatio = x.highPrice > x.lowPrice 
            ? (Math.max(x.endPrice, x.startPrice) - Math.min(x.endPrice, x.startPrice)) / (x.highPrice - x.lowPrice)
            : 1;
        
        const momentum = prev ? x.priceChange - prev.priceChange : 0;
        const acceleration = prev && prev2 ? (x.priceChange - prev.priceChange) - (prev.priceChange - prev2.priceChange) : 0;
        
        const priceDiffFromIndex = x.hasIndexData ? x.priceChange - x.indexChange : 0;
        
        const relativeStrength = x.hasIndexData && (priceChangeStd + indexChangeStd) > 0
            ? (x.priceChange - x.indexChange) / (priceChangeStd + indexChangeStd)
            : 0;
        
        const timeWeight = x.start >= 1430 ? 1.3 : x.start < 630 ? 1.2 : 1.0;
        
        const trendContinuity = prev && Math.sign(x.priceChange) === Math.sign(prev.priceChange) ? 1 : 0;
        
        return {
            ...x,
            volumeRatio,
            aboveVWAP,
            vwapDistance,
            crossVWAPUp,
            crossVWAPDown,
            bodyChange,
            wickRatio,
            momentum,
            acceleration,
            priceDiffFromIndex,
            relativeStrength,
            timeWeight,
            trendContinuity,
            isHighVolume: volumeRatio > 1.5,
            isLowVolume: volumeRatio < 0.6,
            late: x.start >= 1430
        };
    });

    // 5. 高级资金意图模型
    function classifyCapital(f) {
        const { 
            priceChange, 
            volumeRatio, 
            aboveVWAP, 
            vwapDistance,
            crossVWAPUp,
            crossVWAPDown,
            momentum, 
            acceleration,
            late, 
            priceDiffFromIndex,
            relativeStrength,
            timeWeight,
            trendContinuity,
            wickRatio,
            hasIndexData,
            indexChange,
            bodyChange
        } = f;

        // 5.1 计算综合强度得分
        let strengthScore = 0;

        const normalizedPriceChange = 2 / (1 + Math.exp(-priceChange * 2)) - 1;
        strengthScore += normalizedPriceChange * 3;

        const volumeQuality = Math.sign(priceChange) * Math.log1p(Math.max(volumeRatio - 1, 0));
        strengthScore += volumeQuality * 2;

        if (aboveVWAP) {
            strengthScore += Math.min(Math.abs(vwapDistance) * 2, 1.5);
            if (crossVWAPUp) strengthScore += 1;
        } else {
            strengthScore -= Math.min(Math.abs(vwapDistance) * 2, 1.5);
            if (crossVWAPDown) strengthScore -= 1;
        }

        strengthScore += momentum * 1.5;
        strengthScore += acceleration * 1;

        strengthScore *= timeWeight;

        if (trendContinuity && priceChange > 0) strengthScore += 0.5;
        if (trendContinuity && priceChange < 0) strengthScore -= 0.5;

        strengthScore += (wickRatio - 0.5) * Math.sign(priceChange);

        // 5.2 计算相对强度得分
        let relativeScore = 0;
        
        if (hasIndexData) {
            relativeScore = relativeStrength * 3;
            
            if (indexChange < -0.5 && priceChange > -0.3) {
                relativeScore += 3;
            }
            if (indexChange > 0.5 && priceChange < 0.2) {
                relativeScore -= 2;
            }
            if (indexChange < -0.5 && priceChange < indexChange * 1.2) {
                relativeScore -= 3;
            }
        }

        // 5.3 综合判断
        const totalScore = strengthScore + relativeScore;
        
        const bullishThreshold = Math.max(priceChangeStd * 1.5, 0.8);
        const bearishThreshold = -Math.max(priceChangeStd * 1.5, 0.8);

        // ===== 买入侧分类 =====
        if (totalScore >= bullishThreshold) {
            // 逆势抢筹：指数大跌，个股上涨或抗跌
            if (hasIndexData && indexChange < -0.3 && priceChange > -0.3) {
                return { intent: "逆势抢筹", type: "strong_bullish" };
            }
            // 放量强攻：显著放量 + 明显上涨
            if (volumeRatio > 2.0 && priceChange > 1.0) {
                return { intent: "放量强攻", type: "strong_bullish" };
            }
            return { intent: "主动抢筹", type: "bullish" };
        }

        // ===== 卖出侧分类 =====
        if (totalScore <= bearishThreshold) {
            // 逆势派发：指数大涨，个股下跌
            if (hasIndexData && indexChange > 0.3 && priceChange < 0) {
                return { intent: "逆势派发", type: "strong_warning" };
            }
            // 恐慌抛售：显著放量 + 大跌（跌幅足够大）
            if (volumeRatio > 2.0 && priceChange < -1.5) {
                return { intent: "恐慌抛售", type: "strong_warning" };
            }
            return { intent: "主动派发", type: "warning" };
        }

        // ===== 中间区域细分 =====
        if (Math.abs(totalScore) < bullishThreshold * 0.5) {
            if (hasIndexData) {
                if (Math.abs(priceDiffFromIndex) < 0.2) {
                    return { intent: "跟踪指数", type: "neutral" };
                }
                if (priceDiffFromIndex > 0.1 && totalScore > 0) {
                    return { intent: "温和吸筹", type: "mild_bullish" };
                }
                if (priceDiffFromIndex < -0.1 && totalScore < 0) {
                    return { intent: "温和派发", type: "mild_warning" };
                }
            }
            return { intent: "跟踪指数", type: "neutral" };
        }

        // 模糊区域
        if (totalScore > 0) {
            return { intent: "温和吸筹", type: "mild_bullish" };
        }
        return { intent: "温和派发", type: "mild_warning" };
    }

    // 6. 输出
    return features.map(f => {
        const signal = classifyCapital(f);
        return {
            intervalLabel: `${minutesToDisplay(f.start)} - ${minutesToDisplay(f.end)}`,
            startMinute: f.start,
            endMinute: f.end,
            capitalIntent: signal.intent,
            intentType: signal.type,
            priceChange: round(f.priceChange, 2),
            changeDelta: round(f.changeDelta, 2),
            indexChange: round(f.indexChange, 2),
            priceDiffFromIndex: round(f.priceDiffFromIndex, 2),
            startPrice: round(f.startPrice, 2),
            endPrice: round(f.endPrice, 2),
            volumeRatio: round(f.volumeRatio, 2),
            aboveVwap: f.aboveVWAP
        };
    });
};

const minutesToDisplay = (minutes) => {
    const h = Math.floor(minutes / 100);
    const m = minutes % 100;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

const buildDecision = ({ totalScore, klineFactor, intradayFactor, marketContext }) => {
    const marketHighRisk = marketContext.chasingRiskLevel === '高';
    const marketRiskOff = marketContext.marketAdvice?.bias === 'riskOff';
    const stockHighRisk = klineFactor.climaxTopRisk || klineFactor.distributionRisk || intradayFactor.chaseRisk === '高';
    let action = '观望';
    let entryMode = '等待';
    let strategy = '等待结构明确';
    let reason = '当前没有形成高胜率进攻结构。';

    if (totalScore >= 78 && klineFactor.lowAbsorbSignal && !marketRiskOff) {
        action = '低吸';
        entryMode = '低吸';
        strategy = '缩量回踩低吸';
        reason = '上涨途中的缩量回调未破 5 日均线，属于趋势内的低风险承接点。';
    } else if (totalScore >= 82 && klineFactor.breakoutSignal && !marketHighRisk && !stockHighRisk && !marketRiskOff) {
        action = '追高';
        entryMode = '追高';
        strategy = '右侧突破追强';
        reason = '放量突破平台且板块、情绪同步配合，右侧追强的容错率更高。';
    } else if (totalScore >= 72 && !marketRiskOff) {
        action = '低吸';
        entryMode = '低吸';
        strategy = marketHighRisk ? '只做回踩，不追脉冲' : '分歧低吸';
        reason = marketHighRisk
            ? '市场高位分歧偏大，宁可等回踩承接，不宜追涨吃情绪溢价。'
            : '结构偏强，但更适合等回踩确认而不是见脉冲就追。';
    } else if (totalScore >= 60) {
        action = '观察';
        entryMode = '等回踩';
        strategy = '观察回踩质量';
        reason = '个股具备一定弹性，但还没有到明确的高胜率买点。';
    } else {
        action = '回避';
        entryMode = '回避';
        strategy = '不参与';
        reason = '量价、板块和情绪三者没有形成有效共振，强行参与容易被套。';
    }

    if (marketRiskOff && action !== '回避') {
        action = '观察';
        entryMode = '等确认';
        strategy = '大盘防守期，降低出手频率';
        reason = `大盘主力资金与成交量偏弱，当前更适合先防守，再等待确认信号。`;
    }

    const baseLow = marketContext.chasingRiskLevel === '高' ? 0.05 : marketContext.chasingRiskLevel === '低' ? 0.22 : 0.12;
    const baseHigh = marketContext.chasingRiskLevel === '高' ? 0.18 : marketContext.chasingRiskLevel === '低' ? 0.48 : 0.3;
    let low = baseLow + clamp((totalScore - 60) / 100, -0.04, 0.12);
    let high = baseHigh + clamp((totalScore - 70) / 100, -0.05, 0.15);

    if (stockHighRisk || marketRiskOff) {
        low -= 0.08;
        high -= 0.12;
    }
    if (action === '回避') {
        low = 0;
        high = 0;
    }

    low = clamp(low, 0, 0.7);
    high = clamp(Math.max(low, high), 0, 0.8);

    const riskLevel = stockHighRisk ? '高' : totalScore >= 78 ? '低' : '中';

    return {
        action,
        entryMode,
        strategy,
        position: formatPercentRange(low, high),
        riskLevel,
        summary: `${action}为主，仓位参考 ${formatPercentRange(low, high)}。${reason}`,
        chasingRisk: marketHighRisk || stockHighRisk ? '高' : '中低',
        reason,
    };
};

const buildStockAnalysis = ({
    stock,
    sortedKline,
    tlineData,
    benchmarkLine,
    sectorState,
    marketContext,
}) => {
    const klineFactor = analyzeKlineStructure(sortedKline);
    const intradayFactor = analyzeIntradayStrength(tlineData, benchmarkLine, stock?.code);
    const intradayPattern = analyzeIntradayPattern(tlineData);

    let sentimentFactorScore = 0;
    const marketFactorScore = safeNumber(marketContext.marketAdvice?.score);
    if (marketContext.phase === '高潮期' && marketContext.chasingRiskLevel === '低') sentimentFactorScore += 10;
    if (marketContext.phase === '高潮期' && marketContext.chasingRiskLevel === '高') sentimentFactorScore -= 4;
    if (marketContext.phase === '震荡期') sentimentFactorScore += 2;
    if (marketContext.phase === '退潮期') sentimentFactorScore -= 12;

    const totalScore = clamp(
        50
        + klineFactor.trendScore
        + klineFactor.structureScore
        + klineFactor.volumeScore
        + intradayFactor.score
        + sectorState.score
        + sentimentFactorScore,
        + marketFactorScore,
        0,
        100
    );

    const decision = buildDecision({
        totalScore,
        klineFactor,
        intradayFactor,
        marketContext,
    });

    const positives = [];
    const negatives = [];
    const tags = [...new Set([
        ...klineFactor.tags,
        ...intradayFactor.tags,
        ...sectorState.tags,
        sectorState.role,
    ].filter(Boolean))];

    if (klineFactor.lowAbsorbSignal) positives.push('上涨趋势中的缩量回调未破 EMA5，属于标准低吸结构。');
    if (klineFactor.breakoutSignal) positives.push('股价放量突破近 20 日平台，具备右侧加速条件。');
    if (intradayFactor.resilienceScore >= 12) positives.push(`分时抗跌得分 ${intradayFactor.resilienceScore}，盘中相对指数更有主动性。`);
    if (sectorState.role === '主线') positives.push(`所属板块“${stock.blockName}”当前属于主线，板块位阶有加成。`);
    if (sectorState.moneyTrend === 'increasing') positives.push('板块近 5 日资金均值抬升，说明并非纯情绪脉冲。');
    if (decision.action === '低吸') positives.push('当前更适合等回踩承接，而不是被盘中脉冲诱多。');
    if (marketContext.marketAdvice?.bias === 'riskOn') positives.push(`大盘环境偏多，${marketContext.marketAdvice.summary}`);

    if (klineFactor.climaxTopRisk) negatives.push('高位放出巨量并伴随长上影，具备阶段见顶特征。');
    if (klineFactor.distributionRisk) negatives.push('放量后跌回短线均线，说明分歧开始转向兑现。');
    if (intradayFactor.chaseRisk === '高') negatives.push('分时冲高回落明显，追高容易在尾盘被套。');
    if (sectorState.role === '掉队' || sectorState.role === '弱势') negatives.push('板块不在当前核心方向内，持续性会打折。');
    if (marketContext.chasingRiskLevel === '高') negatives.push(`当前市场处于“${marketContext.regime}”，整体追高容错率偏低。`);
    if (marketContext.marketAdvice?.bias === 'riskOff') negatives.push(`大盘建议偏防守：${marketContext.marketAdvice.summary}`);

    const type = totalScore >= 78
        ? 'strong'
        : totalScore >= 60
            ? 'potential'
            : 'weak';
    const isBuyPoint = !marketContext.marketAdvice || marketContext.marketAdvice.bias !== 'riskOff'
        ? (
            totalScore >= 82
            && (klineFactor.lowAbsorbSignal || klineFactor.breakoutSignal)
            && intradayFactor.closePosition >= 58
            && intradayFactor.chaseRisk !== '高'
            && sectorState.role === '主线'
        )
        : false;
    const buyPointReason = isBuyPoint
        ? (klineFactor.lowAbsorbSignal
            ? '分时承接稳定，趋势内缩量回踩形成低吸买点。'
            : '放量突破且分时不弱，形成右侧确认买点。')
        : '';

    return {
        code: stock.code,
        name: stock.name,
        blockName: stock.blockName,
        isImportant: stock.isImportant,
        type,
        strengthScore: round(totalScore),
        latestClose: round(klineFactor.latestClose),
        latestChange: round(klineFactor.latestChange),
        strategy: decision.strategy,
        action: decision.action,
        entryMode: decision.entryMode,
        position: decision.position,
        reason: decision.summary,
        tags,
        factorScores: {
            trend: round(klineFactor.trendScore),
            structure: round(klineFactor.structureScore),
            volume: round(klineFactor.volumeScore),
            intraday: round(intradayFactor.score),
            sector: round(sectorState.score),
            sentiment: round(sentimentFactorScore),
            market: round(marketFactorScore),
        },
        isBuyPoint,
        buyPointReason,
        shouldBlink: isBuyPoint,
        blinkType: isBuyPoint ? 'buy' : null,
        technical: {
            ema5: klineFactor.ema5,
            ema10: klineFactor.ema10,
            ema20: klineFactor.ema20,
            ema60: klineFactor.ema60,
            latestMacd: klineFactor.latestMacd,
            volRatio5To20: klineFactor.volRatio5To20,
            closePosition20: klineFactor.closePosition20,
            atrPct: klineFactor.atrPct,
            lowAbsorbSignal: klineFactor.lowAbsorbSignal,
            breakoutSignal: klineFactor.breakoutSignal,
            climaxTopRisk: klineFactor.climaxTopRisk,
            distributionRisk: klineFactor.distributionRisk,
        },
        intraday: {
            resilienceScore: intradayFactor.resilienceScore,
            closePosition: intradayFactor.closePosition,
            vwap: intradayFactor.vwap,
            aboveVwap: intradayFactor.aboveVwap,
            openingChange: intradayFactor.openingChange,
            afternoonChange: intradayFactor.afternoonChange,
            fadeFromHigh: intradayFactor.fadeFromHigh,
            chaseRisk: intradayFactor.chaseRisk,
            summary: intradayFactor.summary,
            pattern: intradayPattern,
        },
        blockContext: {
            role: sectorState.role,
            latestRank: sectorState.latestRank,
            totalBlocks: sectorState.totalBlocks,
            recentAvgChange: sectorState.recentAvgChange,
            changeMomentum: sectorState.changeMomentum,
            recentAvgMoney: sectorState.recentAvgMoney,
            moneyTrend: sectorState.moneyTrend,
            reasons: sectorState.reasons,
            manualReason: sectorState.manualReason,
        },
        decision,
        explanation: {
            thesis: `${stock.name} 属于 ${sectorState.role} 方向，当前市场为“${marketContext.regime}”，更适合${decision.entryMode}${decision.entryMode === '回避' ? '' : `，仓位参考 ${decision.position}`}`,
            positives: positives.slice(0, 4),
            negatives: negatives.slice(0, 4),
            trigger: decision.entryMode === '低吸'
                ? '等待回踩 EMA5/EMA10 后缩量企稳，分时重新站上 VWAP。'
                : decision.entryMode === '追高'
                    ? '仅在放量突破前高且尾盘不回落时右侧跟随。'
                    : '先看板块和情绪是否继续共振，再等形态确认。',
            invalidation: klineFactor.lowAbsorbSignal
                ? '跌破 EMA10 且放量，说明低吸结构失效。'
                : '跌破短线平台并伴随量能放大，说明资金转为兑现。',
        },
        klineData: sortedKline.slice(-60),
        tlineData: intradayFactor.line,
    };
};

const loadAnalysisBaseContext = async () => {
    logQuantProgress('初始化', '开始加载量化分析基础上下文');
    const monitorStocks = safeReadJson(monitorStocksPath, []);
    const blockDataHistory = safeReadJson(blockDataPath, []);
    const blockMoneyHistory = safeReadJson(blockMoneyPath, []);
    const amountHistory = safeReadJson(amountPath, []);
    const amountDayHistory = safeReadJson(amountDayHistoryPath, []);
    const manualLineMap = getManualLineMap();
    logQuantProgress(
        '初始化',
        `基础文件读取完成，自选股 ${monitorStocks.length} 只，板块历史 ${blockDataHistory.length} 天，资金历史 ${blockMoneyHistory.length} 天，大盘分时 ${amountHistory.length} 条`
    );

    const [sentiment, shIndexTline, cybIndexTline] = await Promise.all([
        predictSentimentCycle(),
        getSingleStockTlineData('sh000001'),
        getSingleStockTlineData('sz399006'),
    ]);
    logQuantProgress('初始化', '情绪周期和指数分时数据加载完成');

    const seedBlockName = monitorStocks[0]?.blockName
        || manualLineMap.keys().next().value
        || Object.keys(blockDataHistory?.[0]?.blocks || {})[0]
        || '';
    const seedSectorState = buildSectorState(seedBlockName, blockDataHistory, blockMoneyHistory, manualLineMap);
    const marketAmountContext = buildMarketAmountContext(amountHistory, amountDayHistory);
    const marketContext = buildMarketContext(sentiment, seedSectorState, marketAmountContext);
    logQuantProgress(
        '市场上下文',
        `市场状态=${marketContext.regime}，情绪阶段=${marketContext.phase}${marketContext.stageLabel ? `·${marketContext.stageLabel}` : ''}，追高风险=${marketContext.chasingRiskLevel}，大盘建议=${marketAmountContext.action}`
    );

    return {
        monitorStocks,
        blockDataHistory,
        blockMoneyHistory,
        manualLineMap,
        marketContext,
        marketAmountContext,
        benchmarkLines: {
            sh: shIndexTline?.line || [],
            sz: cybIndexTline?.line || [],
        },
    };
};

const analyzeSingleStock = async (keyword) => {
    logQuantProgress('单股搜索', `收到单股量化分析请求，keyword=${keyword}`);
    const context = await loadAnalysisBaseContext();
    const stock = findMonitorStock(keyword, context.monitorStocks);

    if (!stock) {
        logQuantProgress('单股搜索', `未找到匹配标的，keyword=${keyword}`);
        return {
            success: false,
            message: '未在监控股票中找到匹配标的',
        };
    }
    logQuantProgress('单股搜索', `匹配到标的 ${stock.name}(${stock.code})，开始抓取K线和分时`);

    const [kline, tline] = await Promise.all([
        getSingleStockData(stock.code, 120),
        getSingleStockTlineData(stock.code),
    ]);

    if (!Array.isArray(kline) || kline.length < 40) {
        logQuantProgress('单股搜索', `${stock.name}(${stock.code}) K线数据不足，无法完成分析`);
        return {
            success: false,
            message: '该股票K线数据不足，暂时无法完成量化分析',
        };
    }

    const sortedKline = [...kline].sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
    const benchmarkLine = stock.code.startsWith('sh')
        ? context.benchmarkLines.sh
        : context.benchmarkLines.sz;
    const sectorState = buildSectorState(
        stock.blockName,
        context.blockDataHistory,
        context.blockMoneyHistory,
        context.manualLineMap
    );

    const result = {
        success: true,
        keyword,
        updateTime: new Date().toISOString(),
        marketContext: context.marketContext,
        sentiment: {
            phase: context.marketContext.phase,
            stageLabel: context.marketContext.stageLabel,
            score: context.marketContext.score,
            confidence: context.marketContext.confidence,
            biasLabel: context.marketContext.biasLabel,
            regime: context.marketContext.regime,
            chasingRiskLevel: context.marketContext.chasingRiskLevel,
        },
        marketAdvice: context.marketAmountContext,
        stock: buildStockAnalysis({
            stock,
            sortedKline,
            tlineData: tline,
            benchmarkLine,
            sectorState,
            marketContext: context.marketContext,
        }),
    };
    logQuantProgress('单股搜索', `单股量化分析完成：${stock.name}(${stock.code})，评分=${result.stock.strengthScore}，动作=${result.stock.action}`);
    return result;
};

const doRunQuantAnalysis = async () => {
    try {
        logQuantProgress('任务开始', '开始执行全量量化分析任务');
        const {
            monitorStocks,
            blockDataHistory,
            blockMoneyHistory,
            manualLineMap,
            marketContext,
            benchmarkLines,
        } = await loadAnalysisBaseContext();

        if (!Array.isArray(monitorStocks) || !monitorStocks.length) {
            logQuantProgress('任务结束', '未读取到自选股，终止本轮量化分析');
            return null;
        }
        const results = [];
        logQuantProgress('逐股分析', `准备逐股分析，共 ${monitorStocks.length} 只股票`);

        const processStock = async (stock, index) => {
            try {
                logQuantProgress('逐股分析', `进度 ${index + 1}/${monitorStocks.length}，开始分析 ${stock.name}(${stock.code})`);
                const [kline, tline] = await Promise.all([
                    getSingleStockData(stock.code, 120),
                    getSingleStockTlineData(stock.code),
                ]);

                if (!Array.isArray(kline) || kline.length < 40) {
                    logQuantProgress('逐股分析', `${stock.name}(${stock.code}) K线数据不足，已跳过`);
                    return;
                }

                const sortedKline = [...kline].sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
                const benchmarkLine = stock.code.startsWith('sh') ? benchmarkLines.sh : benchmarkLines.sz;
                const sectorState = buildSectorState(stock.blockName, blockDataHistory, blockMoneyHistory, manualLineMap);
                const analysis = buildStockAnalysis({
                    stock,
                    sortedKline,
                    tlineData: tline,
                    benchmarkLine,
                    sectorState,
                    marketContext,
                });
                results.push(analysis);
                logQuantProgress(
                    '逐股分析',
                    `完成 ${stock.name}(${stock.code})，评分=${analysis.strengthScore}，动作=${analysis.action}，板块=${analysis.blockContext.role}`
                );
            } catch (error) {
                logQuantProgress('逐股异常', `分析 ${stock.name}(${stock.code}) 失败: ${error.message}`);
            }
        };

        if (useCLS()) {
            for (let i = 0; i < monitorStocks.length; i++) {
                await processStock(monitorStocks[i], i);
                if (i < monitorStocks.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }
            }
        } else {
            await batchParallel(monitorStocks, (stock, index) => processStock(stock, index), 10);
        }

        results.sort((a, b) => {
            if (Number(b.isBuyPoint) !== Number(a.isBuyPoint)) {
                return Number(b.isBuyPoint) - Number(a.isBuyPoint);
            }
            return b.strengthScore - a.strengthScore;
        });
        logQuantProgress(
            '结果汇总',
            `排序完成，买点 ${results.filter((item) => item.isBuyPoint).length} 只，强势 ${results.filter((item) => item.type === 'strong').length} 只，潜伏 ${results.filter((item) => item.type === 'potential').length} 只`
        );

        const finalData = {
            updateTime: new Date().toISOString(),
            sentiment: {
                phase: marketContext.phase,
                stageLabel: marketContext.stageLabel,
                score: marketContext.score,
                confidence: marketContext.confidence,
                biasLabel: marketContext.biasLabel,
                regime: marketContext.regime,
                chasingRiskLevel: marketContext.chasingRiskLevel,
            },
            marketAdvice: marketContext.marketAdvice,
            marketContext: {
                mainLineBlocks: marketContext.mainLineBlocks,
                branchBlocks: marketContext.branchBlocks,
                laggingBlocks: marketContext.laggingBlocks,
                summaryLines: marketContext.summaryLines,
            },
            overview: {
                buyPointCount: results.filter((item) => item.isBuyPoint).length,
                strongCount: results.filter((item) => item.type === 'strong').length,
                potentialCount: results.filter((item) => item.type === 'potential').length,
                weakCount: results.filter((item) => item.type === 'weak').length,
                signalCount:
                    results.filter((item) => item.isBuyPoint).length
                    + (marketContext.marketAdvice?.signal?.shouldBlink ? 1 : 0),
                menuShouldBlink:
                    results.some((item) => item.isBuyPoint)
                    || Boolean(marketContext.marketAdvice?.signal?.shouldBlink),
                topTargets: results.slice(0, 5).map((item) => ({
                    code: item.code,
                    name: item.name,
                    strengthScore: item.strengthScore,
                    action: item.action,
                    position: item.position,
                    isBuyPoint: item.isBuyPoint,
                })),
            },
            analysis: results,
        };

        fs.writeFileSync(quantAnalysisPath, JSON.stringify(finalData, null, 2), 'utf-8');
        logQuantProgress('落盘完成', `量化分析结果已写入 quant_analysis.json，共分析 ${results.length} 只股票`);
        return finalData;
    } catch (error) {
        logQuantProgress('任务异常', '量化分析执行异常', error);
        return null;
    }
};

const runQuantAnalysis = async () => {
    if (currentRunPromise) {
        logQuantProgress('任务复用', '检测到已有量化分析任务在执行，复用当前 Promise');
        return currentRunPromise;
    }

    currentRunPromise = doRunQuantAnalysis();
    try {
        return await currentRunPromise;
    } finally {
        logQuantProgress('任务结束', '本轮量化分析任务已结束');
        currentRunPromise = null;
    }
};

const getQuantAnalysisData = () => {
    return safeReadJson(quantAnalysisPath, {
        updateTime: null,
        sentiment: {},
        marketContext: {},
        overview: {},
        analysis: [],
    });
};

module.exports = {
    runQuantAnalysis,
    getQuantAnalysisData,
    analyzeSingleStock,
    buildIntradayIntervalAnalysis,
};
