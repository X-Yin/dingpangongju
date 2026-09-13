// 复盘大盘的情绪，为后续操作出手时机提供参考

const { getClsReqEmotionUrl, getClsReqIndexUrl, getClsReqUrl, batchParallel } = require("../utils");
const { getDaPanData } = require("./dapan");
const { getSingleStockTlineData } = require("./stock");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const { getMonitorStocks } = require('./monitorStock');
const { useCLS } = require('../config');

const emotionPath = path.join(__dirname, "../data/emotion.json");
const techIndexPath = path.join(__dirname, "../data/tech_index.json");
const totalSharesPath = path.join(__dirname, "../data/monitor_stocks_total_shares.json");

// 读取成分股总股本数据，构建 { code: TotalShares } 映射
// 数据来源：财联社 stock/basic 接口（syncTotalShares 写入 monitor_stocks_total_shares.json）
const getTotalSharesMap = () => {
    try {
        if (!fs.existsSync(totalSharesPath)) return {};
        const raw = fs.readFileSync(totalSharesPath, 'utf-8') || '[]';
        const arr = JSON.parse(raw);
        const map = {};
        (Array.isArray(arr) ? arr : []).forEach(item => {
            if (item && item.secu_code && item.TotalShares != null && !isNaN(Number(item.TotalShares))) {
                map[item.secu_code] = Number(item.TotalShares);
            }
        });
        return map;
    } catch (error) {
        console.error('读取总股本数据失败:', error.message);
        return {};
    }
};

// 计算每只股票的市值加权因子（相对平均总市值）
// 个股总市值 = 总股本 × 当前价；权重因子 = 个股总市值 / 平均总市值
// 平均市值的股票因子为1（等价于原来的等权累加），大市值股票贡献放大、小市值缩小
// 缺失总股本或现价的股票按因子1处理（保持原有等权行为）
const computeMarketCapFactors = (items, sharesMap) => {
    // items: [{ code, change, price }]
    const caps = items.map(it => {
        const shares = sharesMap[it.code];
        if (!shares || !it.price || isNaN(shares) || isNaN(it.price)) return null;
        return shares * it.price;
    });
    const validCaps = caps.filter(c => c !== null && c > 0);
    if (validCaps.length === 0) return items.map(() => 1);
    const avgCap = validCaps.reduce((acc, cur) => acc + cur, 0) / validCaps.length;
    return caps.map(c => (c !== null && c > 0 ? c / avgCap : 1));
};

// 批量获取成分股涨幅并按市值加权累加（日级与分时路径共用）
// 返回 { rawSum, weighted }
const fetchWeightedChangeSum = async (stockCodes) => {
    const sharesMap = getTotalSharesMap();

    const fetchChange = async (stockCode) => {
        try {
            const { data: { data: klineData } } = await axios.get(getClsReqUrl(stockCode, 1));
            if (klineData && klineData.length > 0) {
                const klineItem = klineData[0];
                // 现价：盘中为最新收盘价字段，缺失时退回昨收
                const price = klineItem.close_px ?? klineItem.last_px ?? klineItem.preclose_px ?? null;
                return {
                    code: stockCode,
                    change: klineItem.change != null && !isNaN(klineItem.change) ? klineItem.change : 0,
                    price: price != null && !isNaN(price) ? price : null,
                };
            }
        } catch (error) {
            console.error(`获取股票 ${stockCode} K线数据失败:`, error.message);
        }
        return { code: stockCode, change: 0, price: null };
    };

    const items = await batchParallel(stockCodes, fetchChange, useCLS() ? 5 : 20);
    const factors = computeMarketCapFactors(items, sharesMap);
    const weighted = items.some((it, i) => factors[i] !== 1);
    const rawSum = items.reduce((acc, cur, i) => acc + cur.change * factors[i], 0);
    return { rawSum, weighted };
};

const techIndexIntradayPath = path.join(__dirname, "../data/tech_index_intraday.json");
const techIndexIntraday5DayPath = path.join(__dirname, "../data/tech_index_intraday_5day.json");
const INTRADAY_5DAY_MAX = 5;

// 科技情绪指数归一化：将个股涨幅累加值通过 tanh 映射到 [-100, 100] 区间
// scale=300 时：rawSum≈±300→±76，±600→±97，±900→±99.5，确保永远不超过 ±100
const TECH_EMOTION_SCALE = 300;
const normalizeTechEmotion = (rawValue) => {
  if (rawValue === null || rawValue === undefined || isNaN(rawValue)) return 0;
  return parseFloat((100 * Math.tanh(rawValue / TECH_EMOTION_SCALE)).toFixed(2));
};
exports.normalizeTechEmotion = normalizeTechEmotion;

// ========== 冲高回落修正 ==========
// 当天可能出现冲高回落或高开低走，虽然收盘涨幅可观，但追高资金被套，情绪实际偏差。
// 通过创业板指(sz399006)和科创50(sh000688)的实时分时数据，计算从当日最高涨幅的回落幅度，
// 映射为负向惩罚值，叠加到基础情绪上。
// PULLBACK_PENALTY_SCALE=2：回落1%→惩罚-46，回落2%→-76，回落3%→-95
// PULLBACK_WEIGHT=0.4：回落惩罚的权重，控制对最终情绪的影响程度
const PULLBACK_PENALTY_SCALE = 2;
const PULLBACK_WEIGHT = 0.4;
const CHUANGYEBAN_CODE = 'sz399006';
const KECHUANGBAN_CODE = 'sh000688';

// 计算单个指数从当日最高涨幅的回落幅度（百分点，负值表示回落）
// 返回 null 表示无法获取数据
const computeIndexPullback = async (indexCode) => {
    try {
        const tlineData = await getSingleStockTlineData(indexCode);
        if (!tlineData || !tlineData.line || !Array.isArray(tlineData.line) || tlineData.line.length === 0) {
            return null;
        }
        const changes = tlineData.line
            .map(item => item.change)
            .filter(c => c !== null && c !== undefined && !isNaN(c));
        if (changes.length === 0) return null;

        const maxChange = Math.max(...changes);
        const currentChange = changes[changes.length - 1];
        // 回落幅度 = 当前涨幅 - 最高涨幅（负值表示从高点回落，0表示收盘创新高）
        return parseFloat((currentChange - maxChange).toFixed(2));
    } catch (error) {
        console.error(`计算指数 ${indexCode} 回落幅度失败:`, error.message);
        return null;
    }
};

// 计算综合回落惩罚值 [-100, 0]
// 取创业板指和科创50回落幅度的平均值，通过 tanh 映射到 [-100, 0]
// 无数据或无回落时返回 0
const computePullbackPenalty = async () => {
    try {
        const [cybPullback, kcbPullback] = await Promise.all([
            computeIndexPullback(CHUANGYEBAN_CODE),
            computeIndexPullback(KECHUANGBAN_CODE),
        ]);

        const validPullbacks = [cybPullback, kcbPullback].filter(p => p !== null);
        if (validPullbacks.length === 0) return 0;

        const avgPullback = validPullbacks.reduce((acc, cur) => acc + cur, 0) / validPullbacks.length;
        // 复用统一的惩罚映射函数
        return computePullbackPenaltyFromPullback(avgPullback);
    } catch (error) {
        console.error('计算回落惩罚失败:', error.message);
        return 0;
    }
};

// 根据回落幅度（百分点，负值表示从高点回落）计算惩罚值 [-100, 0]
// 供实时分时路径和历史K线路径共同复用，确保算法一致
// avgPullback >= 0（收盘创新高或持平）则无惩罚
const computePullbackPenaltyFromPullback = (avgPullback) => {
    if (avgPullback === null || avgPullback === undefined || isNaN(avgPullback)) return 0;
    if (avgPullback >= 0) return 0;
    return parseFloat((-100 * Math.tanh(Math.abs(avgPullback) / PULLBACK_PENALTY_SCALE)).toFixed(2));
};
exports.computePullbackPenaltyFromPullback = computePullbackPenaltyFromPullback;

// 根据单日K线数据（含 high_px / close_px / preclose_px）计算回落惩罚 [-100, 0]
// 历史数据迁移专用：K线中的最高价相对昨收的涨幅与收盘涨幅之差即为回落幅度
const computePullbackPenaltyFromKline = (klineItem) => {
    if (!klineItem) return 0;
    const { high_px, close_px, preclose_px } = klineItem;
    if (!preclose_px || preclose_px <= 0) return 0;
    if (high_px === null || high_px === undefined || isNaN(high_px)) return 0;
    if (close_px === null || close_px === undefined || isNaN(close_px)) return 0;
    // 回落幅度(百分点) = (收盘价 - 最高价) / 昨收 * 100 = 收盘涨幅 - 最高涨幅
    const pullback = parseFloat(((close_px - high_px) / preclose_px * 100).toFixed(2));
    return computePullbackPenaltyFromPullback(pullback);
};
exports.computePullbackPenaltyFromKline = computePullbackPenaltyFromKline;

// 综合科技情绪计算：基础情绪 + 加权回落惩罚
// baseEmotion: 成分股涨幅累加归一化值 [-100, 100]
// pullbackPenalty: 冲高回落惩罚 [-100, 0]
// 最终值 clip 到 [-100, 100]，保证满分100，-40为退潮分界线
const computeTechEmotion = (baseEmotion, pullbackPenalty) => {
    const combined = baseEmotion + pullbackPenalty * PULLBACK_WEIGHT;
    return parseFloat(Math.max(-100, Math.min(100, combined)).toFixed(2));
};
exports.computeTechEmotion = computeTechEmotion;

// 获取当天的涨停板和跌停板个数，以及炸板率，作为当日情绪计算的依据
const getCurrentEmotionData = async () => {
    try {
        const dapanData = await getDaPanData();
        const { up_down_dis } = dapanData;
        const { up_num, down_num } = up_down_dis;
        const response = await axios.get(getClsReqEmotionUrl());
        const { up_ratio } = response.data.data;
        // 计算当日的情绪，涨停和跌停的情绪比重为 0.4，炸板率的比重为 0.6
        const emotion = 0.4 * (up_num - down_num) - 0.6 * (1 - parseFloat(up_ratio));
        return {
            emotion: parseFloat(emotion.toFixed(2)),
            up_num,
            down_num,
            up_ratio,
        };
    } catch (error) {
        console.error("获取当日情绪数据失败:", error.message);
        return {
            emotion: 0,
            up_num: 0,
            down_num: 0,
            up_ratio: 0,
        };
    }
}

// 写入当日的情绪数据
const updateCurrentEmotionData = async () => {
    const emotionData = await getCurrentEmotionData();
    // 写入本地的 src/data/emotion.json
    const data = {
        date: dayjs().format('YYYYMMDD'),
        originData: {
            up_num: emotionData.up_num,
            down_num: emotionData.down_num,
            up_ratio: parseFloat(emotionData.up_ratio),
        },
        emotion: emotionData.emotion,
    }
    // 先读取本地的 src/data/emotion.json
    const oldData = fs.readFileSync(emotionPath, "utf-8") || '[]';
    const oldDataJson = JSON.parse(oldData);
    // 合并新的情绪数据，检查重复日期，如有则覆盖
    const existingIndex = oldDataJson.findIndex(item => item.date === data.date);
    if (existingIndex !== -1) {
        oldDataJson[existingIndex] = data;
    } else {
        oldDataJson.push(data);
    }
    // 写入本地的 src/data/emotion.json
    fs.writeFileSync(emotionPath, JSON.stringify(oldDataJson, null, 2));
}
exports.updateCurrentEmotionData = updateCurrentEmotionData;


// 获取所有日期的情绪数据
const getAllEmotionData = async () => {
    const data = fs.readFileSync(emotionPath, "utf-8") || '[]';
    return JSON.parse(data);
}
exports.getAllEmotionData = getAllEmotionData;

// 获取所有指数的 k 线数据（进程内 10 分钟缓存：回测预构建每天调用一次，
// 历史 K 线部分不可变，避免每个日期重复发 3 次串行 HTTP）
let indexKlineMemCache = null;
let indexKlineMemCacheAt = 0;
const INDEX_KLINE_CACHE_TTL_MS = 10 * 60 * 1000;
const getAllIndexKlineData = async () => {
    if (indexKlineMemCache && Date.now() - indexKlineMemCacheAt < INDEX_KLINE_CACHE_TTL_MS) {
        return indexKlineMemCache;
    }
    const shangzhengCode = 'sh000001';
    const chuangyebanCode = 'sz399006';
    const kechuangbanCode = 'sh000688';
    try {
        const [shangzhengRes, chuangyebanRes, kechuangbanRes] = await Promise.all([
            axios.get(getClsReqIndexUrl(shangzhengCode, 100)),
            axios.get(getClsReqIndexUrl(chuangyebanCode, 100)),
            axios.get(getClsReqIndexUrl(kechuangbanCode, 100)),
        ]);
        const result = {
            shangzhengData: shangzhengRes.data.data,
            chuangyebanData: chuangyebanRes.data.data,
            kechuangbanData: kechuangbanRes.data.data,
        };
        indexKlineMemCache = result;
        indexKlineMemCacheAt = Date.now();
        return result;
    } catch (error) {
        console.error("获取指数K线数据失败:", error.message);
        return {
            shangzhengData: [],
            chuangyebanData: [],
            kechuangbanData: [],
        };
    }
}
exports.getAllIndexKlineData = getAllIndexKlineData;


// 定义计算科技指数的成分股
const updateCurrentTechIndexData = async () => {
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.filter(s => s.isTech !== false).map(s => s.code);
    const changeSumData = [];

    // 拉取各成分股涨幅并按市值（总股本×现价）加权累加
    const { rawSum, weighted } = await fetchWeightedChangeSum(stockCodes);
    const baseEmotion = normalizeTechEmotion(rawSum);
    // 计算冲高回落惩罚（实时获取创业板指和科创50分时数据）
    const pullbackPenalty = await computePullbackPenalty();
    const finalEmotion = computeTechEmotion(baseEmotion, pullbackPenalty);
    changeSumData.push({
        date: Number(dayjs().format('YYYYMMDD')),
        changeSumResult: finalEmotion,
        rawSum: parseFloat(rawSum.toFixed(2)),
        baseEmotion,
        pullbackPenalty,
        marketCapWeighted: weighted,
    });

    // 先把之前的 tech_index.json 的数据读出来，然后合并新的数据，检查重复日期，如有则覆盖
    const oldData = fs.readFileSync(techIndexPath, "utf-8") || '[]';
    let oldDataJson;
    try { oldDataJson = JSON.parse(oldData); } catch { oldDataJson = []; }

    // 归一化历史数据（旧数据没有 normalized 值，需要用 raw 值或 changeSumResult 做归一化）
    oldDataJson = oldDataJson.map(item => {
        if (item.changeSumResult !== undefined && item.rawSum === undefined) {
            // 旧数据：changeSumResult 是原始累加值，需要归一化
            return {
                date: item.date,
                changeSumResult: normalizeTechEmotion(item.changeSumResult),
                rawSum: item.changeSumResult,
            };
        }
        return item;
    });

    // 合并新的数据，检查重复日期，如有则覆盖
    // 保留已有条目的 hasIce 标记（由分时轮询触发的冰点标记）
    changeSumData.forEach(item => {
        const existingIndex = oldDataJson.findIndex(existingItem => existingItem.date === item.date);
        if (existingIndex !== -1) {
            if (oldDataJson[existingIndex].hasIce) {
                item.hasIce = true;
            }
            oldDataJson[existingIndex] = item;
        } else {
            oldDataJson.push(item);
        }
    });
    fs.writeFileSync(techIndexPath, JSON.stringify(oldDataJson, null, 2));
    return oldDataJson[oldDataJson.length - 1].changeSumResult;
}

const getAllTechIndexData = () => {
    const data = fs.readFileSync(techIndexPath, "utf-8") || '[]';
    let parsed;
    try { parsed = JSON.parse(data); } catch { return []; }
    // 归一化旧数据（兼容尚未被 updateCurrentTechIndexData 迁移的历史记录）
    return parsed.map(item => {
        if (item.changeSumResult !== undefined && item.rawSum === undefined) {
            return {
                date: item.date,
                changeSumResult: normalizeTechEmotion(item.changeSumResult),
                rawSum: item.changeSumResult,
            };
        }
        return item;
    });
}
exports.getAllTechIndexData = getAllTechIndexData;
exports.updateCurrentTechIndexData = updateCurrentTechIndexData;

// ========== 当日科技情绪分时数据 ==========

// 获取当前科技情绪指数（实时计算，不入库）
// 综合考虑成分股涨幅（基础情绪）和创业板指/科创50冲高回落（惩罚修正）
const getCurrentTechEmotion = async () => {
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.filter(s => s.isTech !== false).map(s => s.code);

    // 拉取各成分股涨幅并按市值（总股本×现价）加权累加
    const { rawSum } = await fetchWeightedChangeSum(stockCodes);
    const baseEmotion = normalizeTechEmotion(rawSum);
    // 并行计算冲高回落惩罚
    const pullbackPenalty = await computePullbackPenalty();
    return computeTechEmotion(baseEmotion, pullbackPenalty);
};

// 记录当前时刻的科技情绪指数到分时文件
const recordTechEmotionIntraday = async () => {
    const now = dayjs();
    const dayOfWeek = now.day();

    // 周末不记录
    if (dayOfWeek === 0 || dayOfWeek === 6) return null;

    // 只在交易时段记录 (9:25 - 11:30, 13:00 - 15:00)
    const timeStr = now.format('HHmm');
    if (!((timeStr >= '0925' && timeStr <= '1130') || (timeStr >= '1300' && timeStr <= '1500'))) {
        return null;
    }

    const value = await getCurrentTechEmotion();
    const today = now.format('YYYYMMDD');
    const timeLabel = now.format('HHmm');

    // 读取已有数据
    let intradayData = [];
    if (fs.existsSync(techIndexIntradayPath)) {
        const raw = fs.readFileSync(techIndexIntradayPath, 'utf-8') || '{}';
        intradayData = JSON.parse(raw);
    }

    // 按 date 分组
    if (!intradayData[today]) {
        intradayData[today] = [];
    }

    // 同一时间点去重（覆盖）
    const existingIdx = intradayData[today].findIndex(item => item.time === timeLabel);
    const record = { time: timeLabel, value };
    if (existingIdx !== -1) {
        intradayData[today][existingIdx] = record;
    } else {
        intradayData[today].push(record);
    }

    // 只保留今天的数据（每天重新开始）
    const newData = { [today]: intradayData[today] };
    fs.writeFileSync(techIndexIntradayPath, JSON.stringify(newData, null, 2));
    return record;
};

// 强制记录当前时刻的科技情绪指数到分时文件
// 与 recordTechEmotionIntraday 不同：
//   1. 不受交易时段/周末限制（用于手动刷新按钮）
//   2. 可接收预设值，避免重复请求成分股数据
//   3. 同一时间点去重覆盖，与轮询服务互相覆盖（以最新为准）
const forceRecordTechEmotionIntraday = async (presetValue = null) => {
    const now = dayjs();
    const today = now.format('YYYYMMDD');
    const timeLabel = now.format('HHmm');

    // 优先使用预设值，否则实时计算
    const value = presetValue !== null && presetValue !== undefined
        ? parseFloat(presetValue)
        : await getCurrentTechEmotion();

    // 读取已有数据
    let intradayData = {};
    if (fs.existsSync(techIndexIntradayPath)) {
        const raw = fs.readFileSync(techIndexIntradayPath, 'utf-8') || '{}';
        try { intradayData = JSON.parse(raw); } catch { intradayData = {}; }
    }

    // 按 date 分组
    if (!intradayData[today]) {
        intradayData[today] = [];
    }

    // 同一时间点去重（覆盖）- 与轮询服务互相覆盖以最新为准
    const existingIdx = intradayData[today].findIndex(item => item.time === timeLabel);
    const record = { time: timeLabel, value };
    if (existingIdx !== -1) {
        intradayData[today][existingIdx] = record;
    } else {
        intradayData[today].push(record);
    }

    // 只保留今天的数据（每天重新开始）
    const newData = { [today]: intradayData[today] };
    fs.writeFileSync(techIndexIntradayPath, JSON.stringify(newData, null, 2));
    return record;
};

// 获取当日科技情绪分时数据
const getTechEmotionIntraday = () => {
    if (!fs.existsSync(techIndexIntradayPath)) {
        return { data: {} };
    }
    const raw = fs.readFileSync(techIndexIntradayPath, 'utf-8') || '{}';
    let intradayData;
    try { intradayData = JSON.parse(raw); } catch { return { data: {} }; }

    // 归一化旧分时数据（检测是否有超过 ±100 的原始值，如有则归一化并写回）
    let needsWriteBack = false;
    const normalized = {};
    Object.keys(intradayData).forEach(dateKey => {
        const records = intradayData[dateKey] || [];
        const hasRawValue = records.some(r => r.value !== null && r.value !== undefined && Math.abs(r.value) > 100.5);
        if (hasRawValue) {
            normalized[dateKey] = records.map(r => ({
                time: r.time,
                value: normalizeTechEmotion(r.value),
            }));
            needsWriteBack = true;
        } else {
            normalized[dateKey] = records;
        }
    });

    if (needsWriteBack) {
        try { fs.writeFileSync(techIndexIntradayPath, JSON.stringify(normalized, null, 2)); } catch {}
    }

    return { data: normalized };
};

// 将当日分时数据缓存到5日存储文件（15:01收盘后调用）
// 读取 tech_index_intraday.json 中今日数据，合并写入 5day 文件，按日期升序保留最近5天
const cacheTechEmotionIntradayTo5Day = () => {
    const today = dayjs().format('YYYYMMDD');
    const dayOfWeek = dayjs().day();
    if (dayOfWeek === 0 || dayOfWeek === 6) return null;

    // 读取当日分时数据
    let todayRecords = [];
    if (fs.existsSync(techIndexIntradayPath)) {
        try {
            const raw = fs.readFileSync(techIndexIntradayPath, 'utf-8') || '{}';
            const intradayData = JSON.parse(raw);
            todayRecords = intradayData[today] || [];
        } catch { todayRecords = []; }
    }
    if (todayRecords.length === 0) {
        console.log('当日分时数据为空，跳过5日缓存');
        return null;
    }

    // 读取已有5日缓存
    let cacheData = {};
    if (fs.existsSync(techIndexIntraday5DayPath)) {
        try {
            const raw = fs.readFileSync(techIndexIntraday5DayPath, 'utf-8') || '{}';
            cacheData = JSON.parse(raw);
        } catch { cacheData = {}; }
    }

    // 覆盖/写入今日数据
    cacheData[today] = todayRecords;

    // 按日期升序排序，只保留最近5天
    const sortedDates = Object.keys(cacheData).sort();
    const trimmed = sortedDates.slice(-INTRADAY_5DAY_MAX).reduce((acc, dateKey) => {
        acc[dateKey] = cacheData[dateKey];
        return acc;
    }, {});

    fs.writeFileSync(techIndexIntraday5DayPath, JSON.stringify(trimmed, null, 2));
    console.log(`已缓存科技情绪5日数据，共 ${Object.keys(trimmed).length} 天`);
    return trimmed;
};

// 判断日期 key（YYYYMMDD）是否为周末
const isWeekendDateKey = (dateKey) => {
    const str = String(dateKey);
    if (str.length !== 8) return false;
    const d = dayjs(`${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`);
    const dow = d.day();
    return dow === 0 || dow === 6;
};

// 获取最近5日科技情绪分时数据（合并当日实时数据）
// 读取5日缓存文件，再用当日实时分时数据覆盖今日，保证交易时段内5日视图也能实时刷新
// 周末不计入：剔除缓存中的周末 key，周末也不合并当日数据，保证始终是最近5个交易日
const getTechEmotionIntraday5Day = () => {
    let cacheData = {};
    if (fs.existsSync(techIndexIntraday5DayPath)) {
        try {
            const raw = fs.readFileSync(techIndexIntraday5DayPath, 'utf-8') || '{}';
            cacheData = JSON.parse(raw);
        } catch { cacheData = {}; }
    }

    // 剔除周末日期 key，只保留交易日
    Object.keys(cacheData).forEach(dateKey => {
        if (isWeekendDateKey(dateKey)) delete cacheData[dateKey];
    });

    // 合并当日实时分时数据（周末不合并，避免刷新按钮把周末数据带进5日视图）
    const today = dayjs().format('YYYYMMDD');
    if (!isWeekendDateKey(today)) {
        const { data: intradayData } = getTechEmotionIntraday();
        if (intradayData[today] && intradayData[today].length > 0) {
            cacheData[today] = intradayData[today];
        }
    }

    // 按日期升序排序，只保留最近5个交易日
    const sortedDates = Object.keys(cacheData).sort();
    const trimmed = sortedDates.slice(-INTRADAY_5DAY_MAX).reduce((acc, dateKey) => {
        acc[dateKey] = cacheData[dateKey];
        return acc;
    }, {});

    return { data: trimmed };
};

// 15:01收盘后自动缓存当日分时数据到5日存储
const scheduleTechEmotionIntraday5DayCache = (hour = 15, minute = 1) => {
    let executedDates = new Set();

    const task = () => {
        const now = dayjs();
        const today = now.format('YYYYMMDD');
        const dayOfWeek = now.day();

        if (dayOfWeek === 0 || dayOfWeek === 6) return;
        if (executedDates.has(today)) return;

        const targetTime = now.hour(hour).minute(minute).second(0).millisecond(0);
        if (!now.isAfter(targetTime)) return;

        console.log('开始缓存当日科技情绪分时数据到5日存储...', now.format('YYYY-MM-DD HH:mm:ss'));
        try {
            cacheTechEmotionIntradayTo5Day();
            executedDates.add(today);
        } catch (e) {
            console.error('缓存科技情绪5日数据失败:', e.message);
        }
    };

    task();
    setInterval(task, 60 * 1000);
    console.log(`科技情绪5日数据缓存已调度，超过 ${hour}:${String(minute).padStart(2, '0')} 且未记录时将自动执行`);
};

// 获取最新科技情绪指数（读取离线数据，自动归一化）
const getLatestTechEmotion = () => {
    const today = dayjs().format('YYYYMMDD');

    // 优先读取当日分时数据的最新值
    try {
        const { data: intradayData } = getTechEmotionIntraday();
        if (intradayData[today] && intradayData[today].length > 0) {
            const todayData = [...intradayData[today]].sort((a, b) => a.time.localeCompare(b.time));
            const latestRecord = todayData[todayData.length - 1];
            if (latestRecord && latestRecord.value !== null && latestRecord.value !== undefined) {
                return parseFloat(latestRecord.value.toFixed(2));
            }
        }
    } catch (error) {
        console.error('读取科技情绪分时数据失败:', error.message);
    }

    // 如果没有分时数据，读取日级别离线数据的最新值
    try {
        const techIndexData = getAllTechIndexData();
        if (techIndexData.length > 0) {
            const sorted = [...techIndexData].sort((a, b) => b.date - a.date);
            const latestRecord = sorted[0];
            if (latestRecord && latestRecord.changeSumResult !== null && latestRecord.changeSumResult !== undefined) {
                return parseFloat(latestRecord.changeSumResult.toFixed(2));
            }
        }
    } catch (error) {
        console.error('读取科技情绪日级别数据失败:', error.message);
    }

    return null;
};

// 标记最新科技情绪指数日为冰点（hasIce: true）
// 由前端分时轮询触发：当盘中分时情绪 <= -100（退潮冰点）时调用
const markTechIndexIce = () => {
    try {
        const raw = fs.readFileSync(techIndexPath, 'utf-8') || '[]';
        let rawData;
        try { rawData = JSON.parse(raw); } catch { return false; }
        if (!Array.isArray(rawData) || rawData.length === 0) return false;

        // 按日期降序找到最新一天
        const sorted = [...rawData].sort((a, b) => b.date - a.date);
        const latestDate = sorted[0].date;

        const idx = rawData.findIndex(item => item.date === latestDate);
        if (idx === -1) return false;
        if (rawData[idx].hasIce) return false; // 已标记过

        rawData[idx].hasIce = true;
        fs.writeFileSync(techIndexPath, JSON.stringify(rawData, null, 2));
        console.log(`[markTechIndexIce] 已标记 ${latestDate} 为冰点 (hasIce: true)`);
        return true;
    } catch (e) {
        console.error('标记冰点失败:', e.message);
        return false;
    }
};

exports.recordTechEmotionIntraday = recordTechEmotionIntraday;
exports.forceRecordTechEmotionIntraday = forceRecordTechEmotionIntraday;
exports.getTechEmotionIntraday = getTechEmotionIntraday;
exports.getLatestTechEmotion = getLatestTechEmotion;
exports.markTechIndexIce = markTechIndexIce;
exports.cacheTechEmotionIntradayTo5Day = cacheTechEmotionIntradayTo5Day;
exports.getTechEmotionIntraday5Day = getTechEmotionIntraday5Day;
exports.scheduleTechEmotionIntraday5DayCache = scheduleTechEmotionIntraday5DayCache;
