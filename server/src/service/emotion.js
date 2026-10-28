// 复盘大盘的情绪，为后续操作出手时机提供参考

const { getClsReqEmotionUrl, getClsReqIndexUrl, getClsReqUrl, batchParallel } = require("../utils");
const { getDaPanData } = require("./dapan");
const { getSingleStockTlineData, getRealtimeQuotes, getSingleStockData } = require("./stock");
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

const techIndexIntradayPath = path.join(__dirname, "../data/tech_index_intraday.json");
const techIndexIntraday5DayPath = path.join(__dirname, "../data/tech_index_intraday_5day.json");
const INTRADAY_5DAY_MAX = 5;

// ========== V1 旧算法归一化（实时路径已切换 V2；保留供历史数据迁移与训练营回放 trainingCamp.js 沿用旧口径） ==========
// 将个股涨幅累加值通过 tanh 映射到 [-100, 100] 区间
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
// PULLBACK_WEIGHT=0.4：V1 冲高回落惩罚权重（训练回放口径）；实时 V2 路径权重为下方 PULLBACK_WEIGHT_V2=0.2
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

// 综合科技情绪计算（V1）：基础情绪 + 加权回落惩罚
// baseEmotion: 成分股涨幅累加归一化值 [-100, 100]
// pullbackPenalty: 冲高回落惩罚 [-100, 0]
// 最终值 clip 到 [-100, 100]，保证满分100，-40为退潮分界线
const computeTechEmotion = (baseEmotion, pullbackPenalty) => {
    const combined = baseEmotion + pullbackPenalty * PULLBACK_WEIGHT;
    return parseFloat(Math.max(-100, Math.min(100, combined)).toFixed(2));
};
exports.computeTechEmotion = computeTechEmotion;

// ========== 科技情绪指数 V2 算法（2026-10-19 用户重新定义，实时/当日路径使用） ==========
// 端点基准：全部科技股涨停 → +100、全部跌停 → -100；叠加市值加权与冲高回落惩罚后，
// 未全部跌停/涨停也可能触及 ±100 端点（用户确认的口径）。
// ① 个股归一化得分 = 涨幅 ÷ 所属板块涨跌幅限制 × 100，截断到 [-100, 100]
//    （主板 ±10%、创业板 sz30* ±20%、科创板 sh68* ±20%）；
// ② 基础情绪 = 得分的市值加权平均（市值 = 总股本 × 现价，权重因子 = 个股市值 / 线内平均市值，
//    缺失总股本/现价的个股按因子 1 参与，与 V1 加权口径一致）；
// ③ 最终值 = 基础情绪 + 冲高回落惩罚 × 0.2，截断到 [-100, 100]。
// 与 V1 的区别：不再用「涨幅累加值 tanh 压缩」（旧口径平均跌 3% 就接近 -80），改为按板块限制归一化，
// 保证同样的指数数值在任意板块构成下语义一致（如 -50 ≈ 市值加权平均跌幅达到板块限制的一半）。
const PULLBACK_WEIGHT_V2 = 0.2;

// 按代码返回所属板块的涨跌幅限制（百分点）：主板 10、创业板/科创板 20
const getTechLimitPctByCode = (code) => {
    const c = String(code);
    if (c.startsWith('sh68')) return 20; // 科创板
    if (c.startsWith('sz30')) return 20; // 创业板
    return 10; // 主板（sh60*/sz00* 等）
};
exports.getTechLimitPctByCode = getTechLimitPctByCode;

// 批量获取科技成分股实时涨幅与现价（V2 日级与分时路径共用），单只失败按 change=0 计
// 返回 [{ code, change, price, tradeDate }]
const fetchTechStockItems = async (stockCodes) => {
    const now = dayjs();
    const timeStr = now.format('HHmm');
    // 集合竞价（9:15-9:30）：财联社日 K 线要等竞价撮合完成后才带上当日 bar，
    // 同花顺日 K 线在竞价阶段即可返回当日竞价 bar，这里先走同花顺，再用实时快照兜底
    const inAuction = tradingDayUtil.isTradingDay(now.toDate()) && timeStr >= '0915' && timeStr < '0930';

    const fetchChange = async (stockCode) => {
        try {
            let klineData;
            if (inAuction) {
                klineData = await getSingleStockData(stockCode, 1);
            } else {
                const { data: { data } } = await axios.get(getClsReqUrl(stockCode, 1));
                klineData = data;
            }
            if (klineData && klineData.length > 0) {
                const klineItem = klineData[0];
                // 现价：盘中为最新收盘价字段，缺失时退回昨收（市值加权因子用）
                const price = klineItem.close_px ?? klineItem.last_px ?? klineItem.preclose_px ?? null;
                return {
                    code: stockCode,
                    change: klineItem.change != null && !isNaN(klineItem.change) ? klineItem.change : 0,
                    price: price != null && !isNaN(price) ? price : null,
                    tradeDate: klineItem.trade_date != null && !isNaN(Number(klineItem.trade_date))
                        ? Number(klineItem.trade_date)
                        : null,
                };
            }
        } catch (error) {
            console.error(`获取股票 ${stockCode} K线数据失败:`, error.message);
        }
        return { code: stockCode, change: 0, price: null, tradeDate: null };
    };
    const items = await batchParallel(stockCodes, fetchChange, useCLS() ? 5 : 20);

    // 集合竞价阶段：日 K 线若仍停在上一交易日，用实时快照的竞价涨跌幅/现价覆盖，
    // 保证开盘前刷新也能反映当日最新情绪（快照字段为空时保持 K 线结果不变）
    if (inAuction) {
        const todayNum = Number(now.format('YYYYMMDD'));
        const staleItems = items.filter(item => Number(item.tradeDate) !== todayNum);
        if (staleItems.length > 0) {
            try {
                const quotes = await getRealtimeQuotes(staleItems.map(item => item.code));
                staleItems.forEach(item => {
                    const quote = quotes[item.code];
                    if (!quote) return;
                    if (quote.change !== null && quote.change !== undefined) item.change = quote.change;
                    if (quote.price !== null && quote.price !== undefined) item.price = quote.price;
                });
            } catch (error) {
                console.error('获取集合竞价实时快照失败:', error.message);
            }
        }
    }

    return items;
};
exports.fetchTechStockItems = fetchTechStockItems;

// V2 基础情绪：个股板块限制归一化得分的市值加权平均（严格落在 [-100, 100]）
// items: [{ code, change, price }]
const computeTechEmotionV2Base = (items) => {
    const valid = (items || []).filter(it => it && it.code && it.change !== null && it.change !== undefined && !isNaN(it.change));
    if (valid.length === 0) return 0;
    const sharesMap = getTotalSharesMap();
    const factors = computeMarketCapFactors(valid, sharesMap);
    let weightedSum = 0;
    let factorSum = 0;
    valid.forEach((it, i) => {
        const limit = getTechLimitPctByCode(it.code);
        const score = Math.max(-100, Math.min(100, (it.change / limit) * 100));
        weightedSum += score * factors[i];
        factorSum += factors[i];
    });
    if (factorSum <= 0) return 0;
    return parseFloat((weightedSum / factorSum).toFixed(2));
};
exports.computeTechEmotionV2Base = computeTechEmotionV2Base;

// V2 市值加权平均涨幅（百分点，诊断用）：与基础情绪同权重的原始涨幅均值
const computeTechAvgChangeV2 = (items) => {
    const valid = (items || []).filter(it => it && it.code && it.change !== null && it.change !== undefined && !isNaN(it.change));
    if (valid.length === 0) return 0;
    const sharesMap = getTotalSharesMap();
    const factors = computeMarketCapFactors(valid, sharesMap);
    let weightedSum = 0;
    let factorSum = 0;
    valid.forEach((it, i) => {
        weightedSum += it.change * factors[i];
        factorSum += factors[i];
    });
    if (factorSum <= 0) return 0;
    return parseFloat((weightedSum / factorSum).toFixed(2));
};
exports.computeTechAvgChangeV2 = computeTechAvgChangeV2;

// V2 最终合成：基础情绪 + 冲高回落惩罚 × 0.2，截断到 [-100, 100]
const computeTechEmotionV2 = (baseEmotion, pullbackPenalty) => {
    const combined = baseEmotion + pullbackPenalty * PULLBACK_WEIGHT_V2;
    return parseFloat(Math.max(-100, Math.min(100, combined)).toFixed(2));
};
exports.computeTechEmotionV2 = computeTechEmotionV2;

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
    // 非交易日（周末/节假日，以交易日历为准）不写入 tech_index.json，直接返回已有最新值
    if (tradingDayUtil.isNonTradingDay(new Date())) {
        console.log('非交易日，跳过科技情绪日数据写入');
        return getLatestTechEmotion();
    }
    // 交易日 9:15（集合竞价）前：当日尚无行情，计算结果等同上一交易日收盘，
    // 写库只会把上一交易日数值复制成「今日」记录（曾导致日线出现与昨日完全相同的记录），
    // 这里直接返回已有最新值，不产生重复记录
    const nowCheck = dayjs();
    if (nowCheck.format('HHmm') < '0915') {
        console.log('集合竞价开始前，跳过科技情绪日数据写入');
        return getLatestTechEmotion();
    }
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.filter(s => s.isTech !== false).map(s => s.code);
    const changeSumData = [];

    // V2 算法：个股按板块涨跌幅限制归一化 → 市值加权平均 + 冲高回落惩罚 × 0.2
    const items = await fetchTechStockItems(stockCodes);
    const baseEmotion = computeTechEmotionV2Base(items);
    // 计算冲高回落惩罚（实时获取创业板指和科创50分时数据）
    const pullbackPenalty = await computePullbackPenalty();
    const finalEmotion = computeTechEmotionV2(baseEmotion, pullbackPenalty);
    changeSumData.push({
        date: Number(dayjs().format('YYYYMMDD')),
        changeSumResult: finalEmotion,
        baseEmotion,
        pullbackPenalty,
        avgChange: computeTechAvgChangeV2(items),
        stockCount: items.length,
        algorithm: 2,
    });

    // 先把之前的 tech_index.json 的数据读出来，然后合并新的数据，检查重复日期，如有则覆盖
    const oldData = fs.readFileSync(techIndexPath, "utf-8") || '[]';
    let oldDataJson;
    try { oldDataJson = JSON.parse(oldData); } catch { oldDataJson = []; }

    // 归一化历史数据（旧数据没有 normalized 值，需要用 raw 值或 changeSumResult 做归一化；
    // algorithm 字段为 V2 新算法标记，有该字段的条目已是最终值，不做旧格式迁移）
    oldDataJson = oldDataJson.map(item => {
        if (item.changeSumResult !== undefined && item.rawSum === undefined && item.algorithm === undefined) {
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
    // 归一化旧数据（兼容尚未被 updateCurrentTechIndexData 迁移的历史记录；algorithm 为 V2 标记，跳过）
    return parsed.map(item => {
        if (item.changeSumResult !== undefined && item.rawSum === undefined && item.algorithm === undefined) {
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
// V2 算法：自选科技股按板块涨跌幅限制归一化 → 市值加权平均 + 创业板指/科创50冲高回落惩罚 × 0.2
const getCurrentTechEmotion = async () => {
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.filter(s => s.isTech !== false).map(s => s.code);

    const items = await fetchTechStockItems(stockCodes);
    const baseEmotion = computeTechEmotionV2Base(items);
    const pullbackPenalty = await computePullbackPenalty();
    return computeTechEmotionV2(baseEmotion, pullbackPenalty);
};

// 记录当前时刻的科技情绪指数到分时文件
const recordTechEmotionIntraday = async () => {
    const now = dayjs();

    // 非交易日（周末/节假日，以交易日历为准）不记录
    if (tradingDayUtil.isNonTradingDay(now.toDate())) return null;

    // 只在交易时段记录 (9:15 - 11:30, 13:00 - 15:00)
    // 2026-10-28 起提前到 9:15：集合竞价阶段已可用竞价价格计算当日科技情绪
    const timeStr = now.format('HHmm');
    if (!((timeStr >= '0915' && timeStr <= '1130') || (timeStr >= '1300' && timeStr <= '1500'))) {
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
    // 非交易日（周末/节假日，以交易日历为准）不写入，手动刷新按钮同样受限
    if (tradingDayUtil.isNonTradingDay(new Date())) {
        console.log('非交易日，跳过科技情绪分时数据写入');
        return null;
    }
    const now = dayjs();
    // 交易日 9:15（集合竞价）前：当日尚无行情，写入的分时点只是上一交易日收盘值的重复，直接跳过
    if (now.format('HHmm') < '0915') {
        console.log('集合竞价开始前，跳过科技情绪分时数据写入');
        return null;
    }
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
    // 非交易日（周末/节假日，以交易日历为准）不缓存
    if (tradingDayUtil.isNonTradingDay(dayjs().toDate())) return null;

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

// 判断日期 key（YYYYMMDD）是否为非交易日（周末或法定节假日，以交易日历为准）
const tradingDayUtil = require('../utils/tradingDay');
const isNonTradingDateKey = (dateKey) => {
    const str = String(dateKey);
    if (str.length !== 8) return false;
    return !tradingDayUtil.isTradingDateNum(str);
};

// 获取最近5日科技情绪分时数据（合并当日实时数据）
// 读取5日缓存文件，再用当日实时分时数据覆盖今日，保证交易时段内5日视图也能实时刷新
// 非交易日不计入：剔除缓存中的非交易日 key，非交易日也不合并当日数据，保证始终是最近5个交易日
const getTechEmotionIntraday5Day = () => {
    let cacheData = {};
    if (fs.existsSync(techIndexIntraday5DayPath)) {
        try {
            const raw = fs.readFileSync(techIndexIntraday5DayPath, 'utf-8') || '{}';
            cacheData = JSON.parse(raw);
        } catch { cacheData = {}; }
    }

    // 剔除非交易日日期 key（周末/节假日），只保留交易日
    Object.keys(cacheData).forEach(dateKey => {
        if (isNonTradingDateKey(dateKey)) delete cacheData[dateKey];
    });

    // 合并当日实时分时数据（非交易日不合并，避免刷新按钮把非交易日数据带进5日视图）
    const today = dayjs().format('YYYYMMDD');
    if (!isNonTradingDateKey(today)) {
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

        // 非交易日（周末/节假日，以交易日历为准）不执行
        if (tradingDayUtil.isNonTradingDay(now.toDate())) return;
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
// 由前端分时轮询触发：当盘中分时情绪 <= -39（退潮冰点）时调用
const markTechIndexIce = () => {
    // 非交易日（周末/节假日，以交易日历为准）不写入
    if (tradingDayUtil.isNonTradingDay(new Date())) return false;
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
