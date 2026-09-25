// 股票持仓服务
const { getClsReqMainFundUrl, getClsReqStockTlineDay5Url, getClsReqStockTlineUrl, batchParallel, isTradingDay } = require('../utils');
const { getMonitorStocks } = require('./monitorStock');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const stock_position_path = path.resolve(__dirname, '../data/stock_position.json');
const stock_position_fund_flow_path = path.resolve(__dirname, '../data/stock_position_fund_flow.json');
const stock_position_analysis_path = path.resolve(__dirname, '../data/stock_position_analysis.json');
const quant_analysis_path = path.resolve(__dirname, '../data/quant_analysis.json');
const DIAGNOSIS_SUMMARY_INTERVAL_MINUTES = 10;

const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));
const toNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};
const formatSignedNumber = (value, digits = 2, suffix = '') => {
    const num = toNumber(value);
    return `${num >= 0 ? '+' : ''}${round(num, digits)}${suffix}`;
};
const formatAmountInYi = (value) => `${formatSignedNumber(value, 2)}亿`;
const timeToMinutes = (value) => {
    const normalized = String(value || '').padEnd(6, '0');
    const hh = Number(normalized.slice(0, 2));
    const mm = Number(normalized.slice(2, 4));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
    return hh * 60 + mm;
};
const minutesToDisplay = (totalMinutes) => {
    const minutes = Math.max(0, Number(totalMinutes) || 0);
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
};
const getDiagnosisBucketStartMinutes = (time) => {
    const minutes = timeToMinutes(time);
    return Math.floor(minutes / DIAGNOSIS_SUMMARY_INTERVAL_MINUTES) * DIAGNOSIS_SUMMARY_INTERVAL_MINUTES;
};
const buildDiagnosisRangeLabel = (bucketStartMinutes) => {
    const endMinutes = bucketStartMinutes + DIAGNOSIS_SUMMARY_INTERVAL_MINUTES;
    return `${minutesToDisplay(bucketStartMinutes)} - ${minutesToDisplay(endMinutes)}`;
};

const readJsonFile = (filePath, fallback) => {
    try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (error) {
        return fallback;
    }
};

const writeJsonFile = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

// 检查当前是否为交易时间（交易日 9:15 - 15:05，交易日以交易日历为准）
const isTradingTime = () => {
    const now = dayjs();
    if (!isTradingDay(now.toDate())) return false;
    const cur = now.hour() * 60 + now.minute();
    return cur >= 9 * 60 + 15 && cur <= 15 * 60 + 5;
};

const readStockPositionsFile = () => readJsonFile(stock_position_path, []);

// 读取资金流向全部数据
const readFundFlowData = () => readJsonFile(stock_position_fund_flow_path, {});

const getQuantAnalysisMap = () => {
    const quantData = readJsonFile(quant_analysis_path, {});
    const analysis = Array.isArray(quantData?.analysis) ? quantData.analysis : [];
    return new Map(analysis.map((item) => [item.code, item]));
};

const getVolumeState = (volumeDiffPercent) => {
    if (volumeDiffPercent >= 20) return '放量';
    if (volumeDiffPercent <= -12) return '缩量';
    return '平量';
};

const getRiskLevelBySignal = (signalType) => {
    if (signalType === 'warning') return '高';
    if (signalType === 'mixed') return '中';
    return '低';
};

const getSignalPriority = (signalType) => {
    if (signalType === 'warning') return 4;
    if (signalType === 'bullish') return 3;
    if (signalType === 'mixed') return 2;
    return 1;
};

const buildVolumeComparison = (tline = []) => {
    if (!Array.isArray(tline) || tline.length < 2) {
        return {
            currentMinute: '',
            todayTotal: 0,
            prevTotal: 0,
            volumeDiff: 0,
            volumeDiffPercent: 0,
            volumeState: '平量',
            hasEnoughData: false,
        };
    }

    const dates = [...new Set(tline.map((item) => item.date))].sort((a, b) => a - b);
    if (dates.length < 2) {
        return {
            currentMinute: '',
            todayTotal: 0,
            prevTotal: 0,
            volumeDiff: 0,
            volumeDiffPercent: 0,
            volumeState: '平量',
            hasEnoughData: false,
        };
    }

    const latestDate = dates[dates.length - 1];
    const prevDate = dates[dates.length - 2];
    const latestDayLine = tline.filter((item) => item.date === latestDate);
    const prevDayLine = tline.filter((item) => item.date === prevDate);
    const currentMinute = latestDayLine.length > 0 ? latestDayLine[latestDayLine.length - 1].minute : 0;
    const todayTotal = latestDayLine
        .filter((line) => line.minute <= currentMinute)
        .reduce((sum, line) => sum + toNumber(line.business_amount), 0);
    const prevTotal = prevDayLine
        .filter((line) => line.minute <= currentMinute)
        .reduce((sum, line) => sum + toNumber(line.business_amount), 0);
    const volumeDiff = todayTotal - prevTotal;
    const volumeDiffPercent = prevTotal !== 0 ? round((volumeDiff / prevTotal) * 100) : 0;

    return {
        currentMinute,
        todayTotal,
        prevTotal,
        volumeDiff,
        volumeDiffPercent,
        volumeState: getVolumeState(volumeDiffPercent),
        hasEnoughData: true,
    };
};

const getRecentReferenceRecord = (records = [], lookback = 5) => {
    if (!records.length) return null;
    const index = Math.max(0, records.length - 1 - lookback);
    return records[index];
};

const buildFundFlowMetrics = (records = []) => {
    if (!records.length) {
        return {
            latestMainFund: 0,
            latestChange: 0,
            recentFundChange: 0,
            recentChangeDelta: 0,
            sessionHighChange: 0,
            sessionLowChange: 0,
            amplitude: 0,
            pullbackFromHigh: 0,
            reboundFromLow: 0,
            fundPeak: 0,
            fundDrawdown: 0,
        };
    }

    const latest = records[records.length - 1];
    const reference = getRecentReferenceRecord(records, 5) || latest;
    const changeList = records.map((item) => toNumber(item.change));
    const fundList = records.map((item) => toNumber(item.mainFund));
    const sessionHighChange = Math.max(...changeList);
    const sessionLowChange = Math.min(...changeList);
    const fundPeak = Math.max(...fundList);
    const latestMainFund = toNumber(latest.mainFund);
    const latestChange = toNumber(latest.change);

    return {
        latestMainFund,
        latestChange,
        recentFundChange: round(latestMainFund - toNumber(reference.mainFund)),
        recentChangeDelta: round(latestChange - toNumber(reference.change)),
        sessionHighChange: round(sessionHighChange),
        sessionLowChange: round(sessionLowChange),
        amplitude: round(sessionHighChange - sessionLowChange),
        pullbackFromHigh: round(sessionHighChange - latestChange),
        reboundFromLow: round(latestChange - sessionLowChange),
        fundPeak: round(fundPeak),
        fundDrawdown: round(latestMainFund - fundPeak),
    };
};

const buildHoldingInterpretation = ({
    stock,
    flowMetrics,
    volumeMetrics,
    quantStock,
}) => {
    const latestChange = flowMetrics.latestChange;
    const recentFundChange = flowMetrics.recentFundChange;
    const latestMainFund = flowMetrics.latestMainFund;
    const volumeDiffPercent = volumeMetrics.volumeDiffPercent;
    const volumeState = volumeMetrics.volumeState;
    const pullbackFromHigh = flowMetrics.pullbackFromHigh;
    const reboundFromLow = flowMetrics.reboundFromLow;
    const amplitude = flowMetrics.amplitude;

    let pattern = '横盘震荡';
    let capitalAction = '震荡换手';
    let signalType = 'neutral';
    let suggestion = '先观察分时高低点是否被突破，再决定是否加减仓。';

    if (latestChange >= 5) {
        pattern = volumeState === '放量' ? '放量大涨' : (volumeState === '缩量' ? '缩量大涨' : '大涨');
        if (recentFundChange >= 0.3 || latestMainFund >= 0.8) {
            capitalAction = '抢筹';
            signalType = 'bullish';
            suggestion = '可继续持有，重点观察量价能否继续共振，避免追高加仓过猛。';
        } else if (pullbackFromHigh >= 2 && (recentFundChange <= -0.2 || flowMetrics.fundDrawdown <= -0.3)) {
            capitalAction = '出货';
            signalType = 'warning';
            suggestion = '冲高回落且资金回吐明显，优先防守，必要时分批减仓。';
        } else {
            capitalAction = '诱多';
            signalType = 'mixed';
            suggestion = '涨幅不小但资金未同步跟进，谨防尾盘回落，暂不追高。';
        }
    } else if (latestChange >= 1.5) {
        pattern = volumeState === '放量' ? '放量上涨' : (volumeState === '缩量' ? '缩量上涨' : '温和上涨');
        if (volumeState === '放量' && recentFundChange >= 0.2) {
            capitalAction = '抢筹';
            signalType = 'bullish';
            suggestion = '上涨过程中仍有新增主力流入，持有为主，等待趋势确认。';
        } else if (volumeState === '缩量' && recentFundChange >= 0) {
            capitalAction = '锁仓上行';
            signalType = 'bullish';
            suggestion = '缩量上涨多为筹码锁定，若回踩不破可继续持有。';
        } else if (volumeState === '放量' && recentFundChange < 0) {
            capitalAction = '诱多';
            signalType = 'mixed';
            suggestion = '价升量增但资金边际转弱，注意高位承接是否衰减。';
        }
    } else if (latestChange <= -5) {
        pattern = volumeState === '放量' ? '放量大跌' : (volumeState === '缩量' ? '缩量大跌' : '大跌');
        if (volumeState === '放量' && recentFundChange <= -0.3) {
            capitalAction = '出货';
            signalType = 'warning';
            suggestion = '放量杀跌且主力持续流出，优先控制回撤，避免死扛。';
        } else if (volumeState === '缩量' && recentFundChange >= 0.2) {
            capitalAction = '诱空';
            signalType = 'mixed';
            suggestion = '跌势中仍有承接，先观察是否出现止跌回拉，避免低位恐慌卖出。';
        } else {
            capitalAction = '恐慌释放';
            signalType = 'warning';
            suggestion = '短线情绪偏弱，先看能否缩量止跌，不能止跌就继续防守。';
        }
    } else if (latestChange <= -1.5) {
        pattern = volumeState === '放量' ? '放量下跌' : (volumeState === '缩量' ? '缩量回调' : '回调整理');
        if (volumeState === '缩量' && recentFundChange >= 0) {
            capitalAction = '洗盘';
            signalType = 'mixed';
            suggestion = '缩量回调且资金未显著恶化，更像洗盘，先看支撑是否有效。';
        } else if (volumeState === '放量' && recentFundChange < 0) {
            capitalAction = '出货';
            signalType = 'warning';
            suggestion = '放量回落更偏向资金撤退，若反抽无力可考虑减仓。';
        }
    } else {
        pattern = '横盘震荡';
        if (amplitude <= 2 && recentFundChange >= 0.25 && latestMainFund >= 0) {
            capitalAction = '横盘抢筹';
            signalType = 'bullish';
            suggestion = '价格横住但资金持续抬升，留意后续向上突破。';
        } else if (amplitude <= 2 && recentFundChange <= -0.25 && latestMainFund < 0) {
            capitalAction = '横盘出货';
            signalType = 'warning';
            suggestion = '价格看似平稳但资金持续流出，防止后续补跌。';
        } else if (reboundFromLow >= 1 && latestChange < 0 && recentFundChange > 0) {
            capitalAction = '诱空';
            signalType = 'mixed';
            suggestion = '低位回拉说明承接尚在，先看是否继续修复。';
        } else if (pullbackFromHigh >= 1 && latestChange > 0 && recentFundChange < 0) {
            capitalAction = '诱多';
            signalType = 'mixed';
            suggestion = '盘中冲高后资金回吐，先观察回踩承接，不宜追涨。';
        }
    }

    const summaryParts = [
        `${pattern}，当前涨幅 ${formatSignedNumber(latestChange, 2, '%')}`,
        `同刻量能 ${formatSignedNumber(volumeDiffPercent, 2, '%')}`,
        `近5分钟主力资金变化 ${formatAmountInYi(recentFundChange)}`,
    ];

    if (quantStock?.action) {
        summaryParts.push(`量化建议偏向 ${quantStock.action}`);
    }

    return {
        code: stock.code,
        name: stock.name,
        blockName: quantStock?.blockName || stock.blockName || '-',
        pattern,
        capitalAction,
        signalType,
        riskLevel: getRiskLevelBySignal(signalType),
        summary: `${summaryParts.join('，')}。当前更像${capitalAction}。`,
        suggestion,
        metrics: {
            latestChange,
            latestMainFund,
            recentFundChange,
            recentChangeDelta: flowMetrics.recentChangeDelta,
            volumeDiffPercent,
            volumeState,
            amplitude,
            pullbackFromHigh,
            reboundFromLow,
        },
        quant: quantStock ? {
            type: quantStock.type,
            action: quantStock.action,
            strategy: quantStock.strategy,
            strengthScore: quantStock.strengthScore,
            reason: quantStock.reason,
        } : null,
        recentFlow: (Array.isArray(stock.records) ? stock.records : []).slice(-8),
        updatedTime: stock.updatedTime,
    };
};

const buildWindowDiagnosisEntry = ({
    startRecord,
    endRecord,
    previousEndRecord,
    bucketStartMinutes,
    quantStock,
}) => {
    if (!startRecord || !endRecord) return null;

    const startChange = round(toNumber(startRecord.change));
    const endChange = round(toNumber(endRecord.change));
    const intervalChangeDelta = round(endChange - startChange);
    const currentChange = endChange;
    const baselineChange = previousEndRecord
        ? round(toNumber(previousEndRecord.change, startChange))
        : round(toNumber(startRecord.change, currentChange));
    const changeDelta = round(currentChange - baselineChange);
    const currentFund = round(toNumber(endRecord.mainFund));
    const baselineFund = previousEndRecord
        ? round(toNumber(previousEndRecord.mainFund, toNumber(startRecord.mainFund)))
        : round(toNumber(startRecord.mainFund, currentFund));
    const fundDelta = round(currentFund - baselineFund);
    const volumeDiffPercent = round(toNumber(endRecord.volumeDiffPercent));
    const volumeState = endRecord.volumeState || getVolumeState(volumeDiffPercent);
    const latestPrice = toNumber(endRecord.latestPrice, null);
    const intervalLabel = buildDiagnosisRangeLabel(bucketStartMinutes);

    let pattern = '横盘震荡';
    if (changeDelta >= 1.2) {
        pattern = volumeState === '放量' ? '放量拉升' : '缩量拉升';
    } else if (changeDelta >= 0.2) {
        pattern = volumeState === '放量' ? '放量上涨' : '缩量上涨';
    } else if (changeDelta <= -1.2) {
        pattern = volumeState === '放量' ? '放量下跌' : '缩量下跌';
    } else if (changeDelta <= -0.2) {
        pattern = volumeState === '放量' ? '放量回落' : '缩量回落';
    }

    let capitalAction = '震荡换手';
    let signalType = 'neutral';

    if (changeDelta >= 0.8 && fundDelta >= 0.35) {
        capitalAction = '资金疯狂抢筹';
        signalType = 'bullish';
    } else if (changeDelta >= 0.3 && fundDelta >= 0.12) {
        capitalAction = '资金抢筹';
        signalType = 'bullish';
    } else if (changeDelta >= 0.2 && fundDelta <= -0.12) {
        capitalAction = '资金诱多';
        signalType = 'mixed';
    } else if (changeDelta <= -0.8 && fundDelta <= -0.35) {
        capitalAction = '资金加速出货';
        signalType = 'warning';
    } else if (changeDelta <= -0.3 && fundDelta <= -0.12) {
        capitalAction = '资金出货';
        signalType = 'warning';
    } else if (changeDelta <= -0.2 && fundDelta >= 0.08) {
        capitalAction = '资金诱空';
        signalType = 'mixed';
    } else if (Math.abs(changeDelta) < 0.2 && fundDelta >= 0.15) {
        capitalAction = '横盘吸筹';
        signalType = 'bullish';
    } else if (Math.abs(changeDelta) < 0.2 && fundDelta <= -0.15) {
        capitalAction = '横盘派发';
        signalType = 'warning';
    }

    const diagnosis = `${pattern}，${capitalAction}`;
    const notes = [
        `区间涨跌变化 ${formatSignedNumber(changeDelta, 2, '%')}`,
        `主力资金变化 ${formatAmountInYi(fundDelta)}`,
        `同刻量能 ${formatSignedNumber(volumeDiffPercent, 2, '%')}`,
    ];
    if (quantStock?.action) {
        notes.push(`量化偏向 ${quantStock.action}`);
    }

    return {
        time: endRecord.time,
        minute: String(endRecord.time || '').slice(0, 4),
        intervalLabel,
        pattern,
        capitalAction,
        diagnosis,
        signalType,
        riskLevel: getRiskLevelBySignal(signalType),
        notes: notes.join('，'),
        startChange,
        endChange,
        intervalChangeDelta,
        metrics: {
            changeDelta,
            fundDelta,
            currentChange,
            currentFund,
            volumeDiffPercent,
            volumeState,
            latestPrice,
        },
    };
};

const buildDiagnosisHistory = (records = [], quantStock) => {
    if (!Array.isArray(records) || !records.length) return [];
    const bucketMap = new Map();

    records.forEach((record) => {
        const bucketStartMinutes = getDiagnosisBucketStartMinutes(record.time);
        if (!bucketMap.has(bucketStartMinutes)) {
            bucketMap.set(bucketStartMinutes, []);
        }
        bucketMap.get(bucketStartMinutes).push(record);
    });

    const bucketEntries = [...bucketMap.entries()].sort((a, b) => a[0] - b[0]);

    return bucketEntries
        .map(([bucketStartMinutes, bucketRecords], index) => {
            const previousBucketRecords = index > 0 ? bucketEntries[index - 1][1] : null;
            const previousEndRecord = previousBucketRecords?.[previousBucketRecords.length - 1] || null;
            return buildWindowDiagnosisEntry({
                startRecord: bucketRecords[0],
                endRecord: bucketRecords[bucketRecords.length - 1],
                previousEndRecord,
                bucketStartMinutes,
                quantStock,
            });
        })
        .filter(Boolean);
};

const buildStockPositionAnalysis = ({ stockPositions, allData, today, extraSnapshotMap = {} }) => {
    const quantMap = getQuantAnalysisMap();
    const dayData = allData[today] || {};
    const list = [];

    for (const stock of stockPositions) {
        const records = Array.isArray(dayData[stock.code]) ? dayData[stock.code] : [];
        const flowMetrics = buildFundFlowMetrics(records);
        const volumeMetrics = extraSnapshotMap[stock.code]?.volumeMetrics || {
            currentMinute: '',
            todayTotal: 0,
            prevTotal: 0,
            volumeDiff: 0,
            volumeDiffPercent: 0,
            volumeState: '平量',
            hasEnoughData: false,
        };
        const latestSnapshot = extraSnapshotMap[stock.code]?.latestSnapshot || {};
        const quantStock = quantMap.get(stock.code);
        const diagnosisHistory = buildDiagnosisHistory(records, quantStock);
        const latestDiagnosis = diagnosisHistory[diagnosisHistory.length - 1] || null;

        const insight = buildHoldingInterpretation({
            stock: {
                ...stock,
                records,
                updatedTime: latestSnapshot.time || (records[records.length - 1]?.time || ''),
            },
            flowMetrics,
            volumeMetrics,
            quantStock,
        });

        list.push({
            ...insight,
            latestDiagnosis,
            diagnosisHistory,
            latestPrice: latestSnapshot.latestPrice ?? null,
        });
    }

    list.sort((a, b) => {
        const signalA = a.latestDiagnosis?.signalType || a.signalType;
        const signalB = b.latestDiagnosis?.signalType || b.signalType;
        if (getSignalPriority(signalA) !== getSignalPriority(signalB)) {
            return getSignalPriority(signalB) - getSignalPriority(signalA);
        }
        return Math.abs(toNumber(b.metrics?.latestChange)) - Math.abs(toNumber(a.metrics?.latestChange));
    });

    return {
        updateTime: new Date().toISOString(),
        date: today,
        trading: isTradingTime(),
        overview: {
            total: list.length,
            bullishCount: list.filter((item) => (item.latestDiagnosis?.signalType || item.signalType) === 'bullish').length,
            warningCount: list.filter((item) => (item.latestDiagnosis?.signalType || item.signalType) === 'warning').length,
            mixedCount: list.filter((item) => (item.latestDiagnosis?.signalType || item.signalType) === 'mixed').length,
        },
        list,
    };
};

const writeStockPositionAnalysis = (payload) => {
    writeJsonFile(stock_position_analysis_path, payload);
};

const getStockPositionAnalysisData = () => readJsonFile(stock_position_analysis_path, {
    updateTime: null,
    date: '',
    trading: false,
    overview: {
        total: 0,
        bullishCount: 0,
        warningCount: 0,
        mixedCount: 0,
    },
    list: [],
});

// 轮询持仓股票的主力资金净流入数据，每分钟保存一次，并同步生成持仓分析快照
const pollStockPositionFundFlow = (interval = 60000) => {
    const lastRecordMinuteRef = { date: '', minute: '' };
    const task = async () => {
        if (!isTradingTime()) return;
        const stock_positions = readStockPositionsFile();
        if (stock_positions.length === 0) {
            writeStockPositionAnalysis({
                updateTime: new Date().toISOString(),
                date: dayjs().format('YYYYMMDD'),
                trading: isTradingTime(),
                overview: { total: 0, bullishCount: 0, warningCount: 0, mixedCount: 0 },
                list: [],
            });
            return;
        }

        const now = dayjs();
        const today = now.format('YYYYMMDD');
        const time = now.format('HHmmss');
        const minuteKey = now.format('HHmm');
        // 同一分钟内不重复记录
        if (lastRecordMinuteRef.date === today && lastRecordMinuteRef.minute === minuteKey) return;
        lastRecordMinuteRef.date = today;
        lastRecordMinuteRef.minute = minuteKey;

        const allData = readFundFlowData();
        if (!allData[today]) allData[today] = {};
        const extraSnapshotMap = {};

        for (const item of stock_positions) {
            try {
                const mainFundUrl = getClsReqMainFundUrl(item.code);
                const tlineUrl = getClsReqStockTlineUrl(item.code);
                const day5TlineUrl = getClsReqStockTlineDay5Url(item.code);

                // 同时获取主力资金、当日分时和近五日分时
                const [fundRes, tlineRes, day5TlineRes] = await Promise.all([
                    axios.get(mainFundUrl),
                    axios.get(tlineUrl),
                    axios.get(day5TlineUrl),
                ]);

                const mainFundDiff = fundRes.data?.data?.main_fund_diff;
                const mainFund = round(toNumber(mainFundDiff) / 100000000);

                const line = tlineRes.data?.data?.line || [];
                const latestTline = line[line.length - 1];
                const change = latestTline ? toNumber(latestTline.change, null) : null;
                const latestPrice = latestTline ? toNumber(latestTline.last_px, null) : null;

                if (!allData[today][item.code]) allData[today][item.code] = [];
                allData[today][item.code].push({
                    time,
                    minute: minuteKey,
                    mainFund,
                    change,
                    latestPrice,
                    volumeDiffPercent: extraSnapshotMap[item.code]?.volumeMetrics?.volumeDiffPercent,
                    volumeState: extraSnapshotMap[item.code]?.volumeMetrics?.volumeState,
                });

                const day5Line = day5TlineRes.data?.data?.line || [];
                extraSnapshotMap[item.code] = {
                    latestSnapshot: {
                        time,
                        latestPrice,
                        change,
                        mainFund,
                    },
                    volumeMetrics: buildVolumeComparison(day5Line),
                };
                const latestRecord = allData[today][item.code][allData[today][item.code].length - 1];
                latestRecord.volumeDiffPercent = extraSnapshotMap[item.code].volumeMetrics.volumeDiffPercent;
                latestRecord.volumeState = extraSnapshotMap[item.code].volumeMetrics.volumeState;
            } catch (error) {
                console.error(`记录 ${item.name} 数据失败:`, error.message);
            }
        }

        writeJsonFile(stock_position_fund_flow_path, allData);
        const analysisPayload = buildStockPositionAnalysis({
            stockPositions: stock_positions,
            allData,
            today,
            extraSnapshotMap,
        });
        writeStockPositionAnalysis(analysisPayload);
    };

    task();
    setInterval(task, interval);
};

// 获取某只股票当日（或指定日期）的资金净流入流出时间序列
const getStockPositionFundFlow = (code, date) => {
    const allData = readFundFlowData();
    const targetDate = date || dayjs().format('YYYYMMDD');
    const dayData = allData[targetDate] || {};
    return dayData[code] || [];
};

const addStockPosition = (code, name) => {
    try {
        const stock_positions = readStockPositionsFile();
        // 已存在则不重复添加
        if (stock_positions.some((item) => item.code === code)) {
            return false;
        }
        // 记录买入日期：卖点诊断买入当日不生效，次日起生效
        stock_positions.push({ code, name, buyDate: dayjs().format('YYYY-MM-DD') });
        writeJsonFile(stock_position_path, stock_positions);
        return true;
    } catch (error) {
        console.error('添加持仓失败:', error);
        return false;
    }
};

const deleteStockPosition = (code) => {
    try {
        const stock_positions = readStockPositionsFile();
        const filtered = stock_positions.filter((item) => item.code !== code);
        writeJsonFile(stock_position_path, filtered);
        return filtered.length !== stock_positions.length;
    } catch (error) {
        console.error('删除持仓失败:', error);
        return false;
    }
};

// 更新某只持仓的成本价（成本线价格），用于卖点诊断「跌破成本线」条件
const updateStockPositionCost = (code, costPrice) => {
    try {
        const stock_positions = readStockPositionsFile();
        const target = stock_positions.find((item) => item.code === code);
        if (!target) return false;
        const num = Number(costPrice);
        if (!Number.isFinite(num) || num <= 0) return false;
        target.costPrice = round(num, 2);
        writeJsonFile(stock_position_path, stock_positions);
        return true;
    } catch (error) {
        console.error('更新持仓成本价失败:', error);
        return false;
    }
};

const getStockPositionMainFund = async () => {
    const stock_positions = readStockPositionsFile();
    const result = [];
    for (const item of stock_positions) {
        try {
            const mainFundData = getClsReqMainFundUrl(item.code);
            const res = await axios.get(mainFundData);
            const mainFundDiff = res.data?.data?.main_fund_diff;
            result.push({
                code: item.code,
                name: item.name,
                costPrice: item.costPrice != null ? round(item.costPrice, 2) : null,
                buyDate: item.buyDate || null,
                mainFund: round(toNumber(mainFundDiff) / 100000000),
            });
        } catch (error) {
            console.error(`获取 ${item.name} 主力资金失败:`, error.message);
            result.push({
                code: item.code,
                name: item.name,
                costPrice: item.costPrice != null ? round(item.costPrice, 2) : null,
                buyDate: item.buyDate || null,
                mainFund: null,
            });
        }
    }

    return result;
};

// 获取自选股列表的主力资金净流入数据（批量并行请求，单位：亿）
const getWatchlistMainFund = async () => {
    const monitorStocks = getMonitorStocks();
    if (monitorStocks.length === 0) return [];
    const results = await batchParallel(monitorStocks, async (stock) => {
        try {
            const url = getClsReqMainFundUrl(stock.code);
            const res = await axios.get(url);
            const mainFundDiff = res.data?.data?.main_fund_diff;
            return { code: stock.code, mainFund: round(toNumber(mainFundDiff) / 100000000) };
        } catch (error) {
            return { code: stock.code, mainFund: null };
        }
    }, 10);
    return results;
};

const getStockPositions = () => {
    try {
        return readStockPositionsFile();
    } catch (error) {
        console.error('读取持仓列表失败:', error);
        return [];
    }
};

const diff2DayStockTline = async () => {
    const stock_positions = readStockPositionsFile();
    const result = [];
    for (const item of stock_positions) {
        try {
            const tlineData = getClsReqStockTlineDay5Url(item.code);
            const res = await axios.get(tlineData);
            const tline = res.data?.data?.line || [];
            const volumeMetrics = buildVolumeComparison(tline);
            result.push({
                code: item.code,
                name: item.name,
                volumeDiffPercent: volumeMetrics.volumeDiffPercent,
            });
        } catch (error) {
            console.error(`获取 ${item.name} 五日分时失败:`, error.message);
        }
    }
    return result;
};

// ---------- 持仓收益 ----------
const stock_position_returns_path = path.resolve(__dirname, '../data/stock_position_returns.json');

const getPositionReturns = () => readJsonFile(stock_position_returns_path, []);

const savePositionReturn = (date, data) => {
    const returns = getPositionReturns();
    const existing = returns.find((r) => r.date === date);
    const record = {
        date,
        operations: data.operations || [],
        totalReturn: data.totalReturn ?? null,
        principleViolated: data.principleViolated ?? false,
        score: data.score ?? null,
        review: data.review ?? '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    if (existing) {
        Object.assign(existing, record);
    } else {
        returns.push(record);
    }
    returns.sort((a, b) => b.date.localeCompare(a.date));
    writeJsonFile(stock_position_returns_path, returns);
    return { success: true };
};

const deletePositionReturn = (date) => {
    const returns = getPositionReturns();
    const filtered = returns.filter((r) => r.date !== date);
    if (filtered.length === returns.length) return { success: false, message: '未找到该日期的记录' };
    writeJsonFile(stock_position_returns_path, filtered);
    return { success: true };
};

// ---------- 流水线管理 ----------
const stock_position_pipeline_path = path.resolve(__dirname, '../data/stock_position_pipeline.json');
const stock_position_records_path = path.resolve(__dirname, '../data/stock_position_records.json');

const PIPELINE_STAGES = [
    { stage: 0, label: '未开始', percent: 0 },
    { stage: 1, label: '30%', percent: 30 },
    { stage: 2, label: '50%', percent: 50 },
    { stage: 3, label: '75%', percent: 75 },
    { stage: 4, label: '100%', percent: 100 },
];

const getStockPipelineData = () => readJsonFile(stock_position_pipeline_path, {});

const saveStockPipelineData = (data) => writeJsonFile(stock_position_pipeline_path, data);

const getStockPipeline = (code) => {
    const all = getStockPipelineData();
    return all[code] || { stage: 0, updatedAt: null };
};

const updateStockPipeline = (code, stage) => {
    const all = getStockPipelineData();
    const stockPositions = readStockPositionsFile();
    const stock = stockPositions.find((s) => s.code === code);
    if (!stock) return { success: false, message: '股票不在持仓列表中' };

    const prev = all[code] || { stage: 0 };
    if (stage < 0 || stage > 4) return { success: false, message: '无效的流水线阶段' };

    // 回退操作：允许从任意阶段回退到更低阶段（含未开始）
    const isRollback = stage < prev.stage;
    if (isRollback) {
        // 任意阶段均可回滚，无额外限制
    } else if (stage === prev.stage) {
        return { success: false, message: `流水线已处于 ${PIPELINE_STAGES[prev.stage]?.label} 阶段，无需重复设置` };
    }

    const now = new Date().toISOString();
    all[code] = { stage, updatedAt: now };
    saveStockPipelineData(all);

    if (isRollback) {
        addStockRecord({
            type: 'reduce',
            code,
            name: stock.name,
            detail: `回滚至 ${PIPELINE_STAGES[stage].label}（${PIPELINE_STAGES[stage].percent}%）`,
            pipelineStage: stage,
        });
    } else {
        addStockRecord({
            type: 'pipeline',
            code,
            name: stock.name,
            detail: `流水线推进至 ${PIPELINE_STAGES[stage].label}（${PIPELINE_STAGES[stage].percent}%）`,
            pipelineStage: stage,
        });
    }

    return { success: true, stage, updatedAt: now };
};

// ---------- 持仓管理记录 ----------
const getStockRecords = () => readJsonFile(stock_position_records_path, []);

const saveStockRecords = (data) => writeJsonFile(stock_position_records_path, data);

const addStockRecord = ({ type, code, name, detail, pipelineStage }) => {
    const records = getStockRecords();
    const now = dayjs();
    records.unshift({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        code,
        name,
        date: now.format('YYYY-MM-DD'),
        time: now.format('HH:mm:ss'),
        detail,
        pipelineStage: pipelineStage ?? null,
        createdAt: now.toISOString(),
    });
    saveStockRecords(records);
    return records;
};

// 重写 addStockPosition，记录买入操作
const addStockPositionWithRecord = (code, name) => {
    const result = addStockPosition(code, name);
    if (result) {
        addStockRecord({
            type: 'buy',
            code,
            name,
            detail: `新增持仓：${name}（${code}）`,
            pipelineStage: 0,
        });
    }
    return result;
};

// 重写 deleteStockPosition，记录删除操作
const deleteStockPositionWithRecord = (code) => {
    const stockPositions = readStockPositionsFile();
    const stock = stockPositions.find((s) => s.code === code);
    const result = deleteStockPosition(code);
    if (result && stock) {
        addStockRecord({
            type: 'delete',
            code,
            name: stock.name,
            detail: `删除持仓：${stock.name}（${code}）`,
            pipelineStage: null,
        });
        // 同时清理流水线数据
        const pipeline = getStockPipelineData();
        if (pipeline[code]) {
            delete pipeline[code];
            saveStockPipelineData(pipeline);
        }
    }
    return result;
};

module.exports = {
    addStockPosition: addStockPositionWithRecord,
    deleteStockPosition: deleteStockPositionWithRecord,
    updateStockPositionCost,
    getStockPositionMainFund,
    getWatchlistMainFund,
    getStockPositionAnalysisData,
    getStockPositions,
    diff2DayStockTline,
    pollStockPositionFundFlow,
    getStockPositionFundFlow,
    // 持仓收益
    getPositionReturns,
    savePositionReturn,
    deletePositionReturn,
    // 流水线 & 记录
    getStockPipeline,
    updateStockPipeline,
    getStockPipelineData,
    getStockRecords,
    addStockRecord,
    PIPELINE_STAGES,
};
