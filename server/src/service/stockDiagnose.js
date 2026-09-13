/**
 * calculateResilience - 计算个股抗跌性得分
 * 
 * 核心逻辑：抗跌 ≠ 不跌，而是"指数跌时我少跌/不跌/甚至涨，指数涨时我能跟上或涨更多"
 * 本函数融合"分钟级弹性回归"与"累计涨跌幅超额收益"两个维度，
 * 既能捕捉盘中的资金主动性，又能反映全天的趋势性抗跌能力。
 * 
 * @param {Array<Object>} indexData - 指数分时数据数组
 *   每个元素需包含: { minute: number, last_px: number, change: number }
 *   minute: 时间(如 930, 931...), last_px: 最新价, change: 累计涨跌幅(%)
 * 
 * @param {Array<Object>} stockData - 个股分时数据数组
 *   每个元素需包含: { minute: number, last_px: number, change: number }
 *   字段含义与指数一致
 * 
 * @param {string} limitType - 股票所属类型，
 *   STAR: 科创板, GEM: 创业板, MAIN: 主板
 * 
 * @returns {number} resilienceScore - 抗跌性得分，越高代表越抗跌
 *  满分 0 ~ 30  
 *  一般范围: 5 ~ 25+
 *   >15: 极强抗跌（龙头级，指数跌时逆势上涨或微跌）
 *   10~15: 较强抗跌（指数跌时明显少跌）
 *   5~10: 一般（基本跟随指数）
 *   <5: 较弱（指数跌时跌得比指数还多）
 */
function calculateResilience(indexData, stockData, limitType) {
    // ========== 0. 参数防御与涨跌停阈值 ==========
    if (!Array.isArray(indexData) || !Array.isArray(stockData)) return 0;

    // 根据板块确定涨跌幅限制（%）
    const limits = { STAR: 20, GEM: 20, MAIN: 10 };
    const limitPct = limits[limitType] ?? 10;          // 涨跌停幅度
    const limitEps = 0.001;                            // 价格判断容差（元）
    const changeEps = 0.05;                            // 涨跌幅判断容差（%）

    // ========== 1. 数据预处理与对齐 ==========
    const indexMap = new Map();
    for (const item of indexData) {
        const m = parseInt(item.minute);
        if (!isNaN(m) && item.last_px != null && item.last_px > 0) {
            indexMap.set(m, {
                px: parseFloat(item.last_px),
                change: parseFloat(item.change ?? 0)
            });
        }
    }

    const aligned = [];
    for (const s of stockData) {
        const m = parseInt(s.minute);
        const idx = indexMap.get(m);
        if (idx && s.last_px != null && s.last_px > 0) {
            const stockPx = parseFloat(s.last_px);
            const stockChange = parseFloat(s.change ?? 0);
            // 反推前收盘价，用于计算理论涨跌停价格
            const prevClose = stockPx / (1 + stockChange / 100);
            const limitUpPrice = prevClose * (1 + limitPct / 100);
            const limitDownPrice = prevClose * (1 - limitPct / 100);

            aligned.push({
                minute: m,
                stockPx,
                indexPx: idx.px,
                stockChange,
                indexChange: idx.change,
                // 是否处于涨跌停锁定状态（价格触及极限视为锁定）
                isLockUp: stockPx >= limitUpPrice - limitEps,
                isLockDown: stockPx <= limitDownPrice + limitEps,
                prevClose
            });
        }
    }
    aligned.sort((a, b) => a.minute - b.minute);

    if (aligned.length < 5) return 0;

    // 统计涨跌停锁定分钟数
    const totalMinutes = aligned.length;
    const lockUpCount = aligned.filter(p => p.isLockUp).length;
    const lockDownCount = aligned.filter(p => p.isLockDown).length;
    const lockUpRatio = lockUpCount / totalMinutes;
    const lockDownRatio = lockDownCount / totalMinutes;

    // ========== 2. 仅用“非锁定”分钟计算分钟收益率 ==========
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

    // ========== 3. 分离上涨/下跌时段（自由交易分钟） ==========
    const upStockRets = [], upIndexRets = [];
    const downStockRets = [], downIndexRets = [];
    for (let i = 0; i < indexRets.length; i++) {
        if (indexRets[i] > 0) {
            upIndexRets.push(indexRets[i]);
            upStockRets.push(stockRets[i]);
        } else if (indexRets[i] < 0) {
            downIndexRets.push(indexRets[i]);
            downStockRets.push(stockRets[i]);
        }
    }

    /** 辅助：计算比率 mean(y) / mean(x)，抗极端样本不足 */
    function safeRatio(xArr, yArr, minSamples = 3) {
        if (xArr.length < minSamples || yArr.length < minSamples) return null;
        const meanX = xArr.reduce((a, b) => a + b, 0) / xArr.length;
        const meanY = yArr.reduce((a, b) => a + b, 0) / yArr.length;
        if (Math.abs(meanX) < 0.005) return null;   // 指数几乎没动，比率无意义
        return meanY / meanX;
    }

    const upRatio = safeRatio(upIndexRets, upStockRets);      // 上涨弹性比率
    const downRatio = safeRatio(downIndexRets, downStockRets); // 下跌弹性比率

    // ========== 4. 累计超额收益（非锁定分钟） ==========
    const upStockChg = [], upIndexChg = [];
    const downStockChg = [], downIndexChg = [];
    for (const p of freeMinutes) {
        if (p.indexChange > 0) {
            upStockChg.push(p.stockChange);
            upIndexChg.push(p.indexChange);
        } else if (p.indexChange < 0) {
            downStockChg.push(p.stockChange);
            downIndexChg.push(p.indexChange);
        }
    }
    const avg = arr => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
    const excessUp = avg(upStockChg) - avg(upIndexChg);
    const excessDown = avg(downStockChg) - avg(downIndexChg);

    // ========== 5. 综合打分 ==========
    // 5.1 进攻分（基于 upRatio）
    let offenseScore = 0;
    if (upRatio !== null) {
        // upRatio 通常 0.5~2.5，映射到 0~4 分
        offenseScore = Math.min(4, Math.max(0, upRatio * 1.6));
    } else {
        // 无足够上涨时段，给基础分
        offenseScore = 1.0;
    }

    // 5.2 防守分（基于 downRatio）
    let defenseScore = 0;
    if (downRatio !== null) {
        if (downRatio < 0) {
            // 指数跌时个股逆势上涨，高度抗跌
            defenseScore = 6.0 + Math.min(4, Math.abs(downRatio) * 2);
        } else {
            // downRatio >= 0，越接近0越抗跌，映射 0→5, 1→2.5, 2→1.25
            defenseScore = 5.0 / (downRatio + 1.0);
        }
    } else {
        defenseScore = 2.5;   // 信息不足时给中性分
    }

    // 5.3 超额收益分
    const excessUpScore = Math.max(-2, Math.min(2, excessUp * 0.3));     // 权重降低且截断
    const excessDownScore = Math.max(-3, Math.min(5, excessDown * 0.8)); // 核心抗跌指标

    // 5.4 涨跌停特殊加减分
    let lockScore = 0;
    if (lockUpRatio > 0.5) {
        // 大部分时间封涨停，极其强势
        lockScore = 5 + (lockUpRatio - 0.5) * 10;
    } else if (lockUpRatio > 0) {
        lockScore = lockUpRatio * 4;   // 有涨停，温和加分
    }
    if (lockDownRatio > 0.5) {
        // 大部分时间封跌停，极其弱势
        lockScore -= 5 + (lockDownRatio - 0.5) * 10;
    } else if (lockDownRatio > 0) {
        lockScore -= lockDownRatio * 4;
    }

    // 5.5 基础分与汇总
    let resilienceScore = 5.0 + offenseScore + defenseScore + excessUpScore + excessDownScore + lockScore;

    // 截断到 [0, 30]
    resilienceScore = Math.max(0, Math.min(30, resilienceScore));

    return parseFloat(resilienceScore.toFixed(4));
}

function getLimitTypeByCode(code) {
    if (!code) return 'MAIN';
    const codeUpper = code.toUpperCase();
    if (codeUpper.startsWith('SH688') || codeUpper.startsWith('688')) return 'STAR';
    if (codeUpper.startsWith('SZ3') || codeUpper.startsWith('3')) return 'GEM';
    if (codeUpper.startsWith('SH6') || codeUpper.startsWith('6') || 
        codeUpper.startsWith('SZ0') || codeUpper.startsWith('0')) return 'MAIN';
    return 'MAIN';
}


exports.calculateResilience = calculateResilience;

const getResilienceStatus = (score) => {
    if (score >= 15) return '极强抗跌';
    if (score >= 10) return '较强抗跌';
    if (score >= 5) return '跟随指数';
    return '偏弱';
};

exports.getResilienceStatus = getResilienceStatus;

const calculateRealtimeResilienceBatch = ({ stocks = [], indexLines = {} } = {}) => {
    const kechuangIndexData = Array.isArray(indexLines.sh000688) ? indexLines.sh000688 : [];
    const chuangyeIndexData = Array.isArray(indexLines.sz399006) ? indexLines.sz399006 : [];

    return stocks.map((item) => {
        const code = item?.code || '';
        const stockName = item?.stockName || code;
        const stockLine = Array.isArray(item?.line) ? item.line : [];

        if (!code) {
            return {
                code: '',
                stockName: '',
                resilienceScore: 0,
                status: '偏弱',
                benchmarkCode: '',
                benchmarkName: '',
                error: '股票代码缺失',
            };
        }

        if (code === 'sh000688' || code === 'sz399006') {
            return {
                code,
                stockName,
                resilienceScore: 0,
                status: '基准指数',
                benchmarkCode: code,
                benchmarkName: stockName,
            };
        }

        const isSh688 = code.startsWith('sh688');
        const benchmarkCode = isSh688 ? 'sh000688' : 'sz399006';
        const benchmarkName = isSh688 ? '科创指数' : '创业板指数';
        const benchmarkLine = isSh688 ? kechuangIndexData : chuangyeIndexData;

        if (!benchmarkLine.length) {
            return {
                code,
                stockName,
                resilienceScore: 0,
                status: '偏弱',
                benchmarkCode,
                benchmarkName,
                error: '指数数据缺失',
            };
        }

        if (!stockLine.length) {
            return {
                code,
                stockName,
                resilienceScore: 0,
                status: '偏弱',
                benchmarkCode,
                benchmarkName,
                error: '无分时数据',
            };
        }

        const limitType = getLimitTypeByCode(code);
        const resilienceScore = calculateResilience(benchmarkLine, stockLine, limitType);
        return {
            code,
            stockName,
            resilienceScore,
            status: getResilienceStatus(resilienceScore),
            benchmarkCode,
            benchmarkName,
        };
    });
};

exports.calculateRealtimeResilienceBatch = calculateRealtimeResilienceBatch;
exports.getLimitTypeByCode = getLimitTypeByCode;

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getClsReqStockTlineUrl } = require('../utils');
const { getMonitorStocks } = require('./monitorStock');
const { getSingleStockTlineDataByDate, getSingleStockData } = require('./stock');

const stockDataPath = path.resolve(__dirname, '../data/stockData.json');

const getSingleStockTlineData = async (code) => {
    try {
        const response = await axios.get(getClsReqStockTlineUrl(code));
        return response.data.data;
    } catch (error) {
        console.error(`获取股票 ${code} 分时数据失败:`, error.message);
        return null;
    }
};

const diagnoseResilience = async (stockCodes) => {
    if (!stockCodes || !Array.isArray(stockCodes)) {
        return { success: false, message: '请选择股票' };
    }

    try {
        const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        const monitorStocks = getMonitorStocks();

        const kechuangIndexTline = await getSingleStockTlineData('sh000688');
        const chuangyeIndexTline = await getSingleStockTlineData('sz399006');

        const kechuangIndexData = kechuangIndexTline?.line || [];
        const chuangyeIndexData = chuangyeIndexTline?.line || [];

        const results = [];

        for (const code of stockCodes) {
            try {
                const stockTline = await getSingleStockTlineData(code);
                const stockLineData = stockTline?.line || [];

                if (stockLineData.length === 0) {
                    results.push({ code, stockName: '', resilienceScore: 0, error: '无分时数据' });
                    continue;
                }

                const indexData = code.startsWith('sh688') ? kechuangIndexData : chuangyeIndexData;

                if (indexData.length === 0) {
                    results.push({ code, stockName: '', resilienceScore: 0, error: '指数数据缺失' });
                    continue;
                }

                const limitType = getLimitTypeByCode(code);
                const score = calculateResilience(indexData, stockLineData, limitType);

                const monitorStock = monitorStocks.find(s => s.code === code);
                const stockName = monitorStock?.name || stockData[code]?.stockName || '';
                const change = stockData[code]?.kline?.[0]?.change || 0;
                
                results.push({
                    code,
                    stockName,
                    resilienceScore: score,
                    change
                });
            } catch (error) {
                console.error(`计算 ${code} 抗跌性失败:`, error.message);
                const monitorStock = monitorStocks.find(s => s.code === code);
                const stockName = monitorStock?.name || stockData[code]?.stockName || '';
                results.push({ code, stockName, resilienceScore: 0, error: error.message });
            }
        }

        results.sort((a, b) => b.resilienceScore - a.resilienceScore);

        return { success: true, data: results };
    } catch (error) {
        console.error('抗分歧诊断失败:', error.message);
        return { success: false, message: error.message };
    }
};

exports.diagnoseResilience = diagnoseResilience;

// ========== 多日抗分歧诊断 ==========

const resilienceCachePath = path.resolve(__dirname, '../data/resilience_multi_day.json');

// 获取最近N个交易日期（跳过周末，多取2天以防节假日）
const getRecentTradingDates = (days = 5) => {
    const dates = [];
    const today = new Date();
    let date = new Date(today);

    const dayOfWeek = today.getDay();
    // 周末（周六/周日）从昨天开始取（会自动跳过周末到上周五）
    // 工作日（含交易时段和收盘后）都从今天开始取：
    //   - 交易时段内：当日分时数据实时更新
    //   - 收盘后：当日分时数据已最终确定，同样可用
    //   - 盘前（9:25 前）：当日尚无分时数据，下面的 validDates 过滤会自动跳过
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        date.setDate(date.getDate() - 1);
    }

    while (dates.length < days + 2) {
        const dow = date.getDay();
        if (dow !== 0 && dow !== 6) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            dates.push(parseInt(`${year}${month}${day}`));
        }
        date.setDate(date.getDate() - 1);
    }

    return dates;
};

// 读取缓存
const readResilienceCache = () => {
    try {
        const cache = JSON.parse(fs.readFileSync(resilienceCachePath, 'utf-8'));
        const cacheAge = Date.now() - new Date(cache.updatedAt).getTime();
        // 缓存有效期：4小时
        if (cacheAge < 4 * 60 * 60 * 1000) {
            return cache;
        }
    } catch (e) {
        // 缓存不存在或解析失败
    }
    return null;
};

// 写入缓存
const writeResilienceCache = (data) => {
    try {
        fs.writeFileSync(resilienceCachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('写入抗分歧多日缓存失败:', e.message);
    }
};

// 多日抗分歧诊断
// 对每只监控股票，获取最近5个交易日的分时数据及其跟踪指数的分时数据，计算每日抗分歧得分
// 筛选出最近3日平均得分大于最早3日平均得分的股票（抗分歧能力提升，弱转强）
const diagnoseResilienceMultiDay = async (forceRefresh = false) => {
    // 检查缓存
    if (!forceRefresh) {
        const cache = readResilienceCache();
        if (cache) {
            console.log('抗分歧多日诊断：返回缓存数据');
            return { success: true, data: cache, fromCache: true };
        }
    }

    const monitorStocks = getMonitorStocks();
    if (!monitorStocks || monitorStocks.length === 0) {
        return { success: false, message: '监控股票列表为空' };
    }

    // 获取最近交易日期（多取2天以防节假日返回空数据）
    const candidateDates = getRecentTradingDates(5);
    console.log(`抗分歧多日诊断：候选日期 ${candidateDates.join(', ')}`);

    // 先获取指数分时数据（科创50和创业板指）
    // sh688开头 → 跟踪科创50(sh000688/1B0688)，其他 → 跟踪创业板指(sz399006)
    const indexDataByDate = {}; // { date: { sh000688: lineData, sz399006: lineData } }

    for (const date of candidateDates) {
        const [kcTline, szTline] = await Promise.all([
            getSingleStockTlineDataByDate('sh000688', date),
            getSingleStockTlineDataByDate('sz399006', date)
        ]);

        const hasKc = kcTline?.line && kcTline.line.length > 0;
        const hasSz = szTline?.line && szTline.line.length > 0;

        if (!hasKc && !hasSz) {
            console.log(`日期 ${date} 无指数分时数据，跳过（可能为非交易日）`);
            continue;
        }

        indexDataByDate[date] = {
            sh000688: hasKc ? kcTline.line : null,
            sz399006: hasSz ? szTline.line : null
        };
    }

    const validDates = Object.keys(indexDataByDate).sort((a, b) => parseInt(b) - parseInt(a));
    const targetDates = validDates.slice(0, 5);

    if (targetDates.length === 0) {
        return { success: false, message: '无法获取最近交易日的指数分时数据' };
    }

    console.log(`抗分歧多日诊断：有效交易日 ${targetDates.join(', ')}`);

    // 直接并行处理所有股票，不再分批节流，以最快速度计算
    const allResults = await Promise.all(monitorStocks.map(async (stock) => {
        const { code, name, blockName, isImportant } = stock;

        try {
            const dailyResults = [];
            const isSh688 = code.startsWith('sh688');
            const indexCode = isSh688 ? 'sh000688' : 'sz399006';

            for (const dateStr of targetDates) {
                const date = parseInt(dateStr);
                const indexLine = indexDataByDate[dateStr]?.[indexCode];

                if (!indexLine || indexLine.length === 0) {
                    dailyResults.push({ date, resilienceScore: 0, error: '指数数据缺失' });
                    continue;
                }

                const stockTline = await getSingleStockTlineDataByDate(code, date);
                const stockLine = stockTline?.line;

                if (!stockLine || stockLine.length === 0) {
                    dailyResults.push({ date, resilienceScore: 0, error: '无分时数据' });
                    continue;
                }

                const limitType = getLimitTypeByCode(code);
                const score = calculateResilience(indexLine, stockLine, limitType);
                const stockChange = stockLine[stockLine.length - 1]?.change || 0;
                const indexChange = indexLine[indexLine.length - 1]?.change || 0;

                dailyResults.push({
                    date,
                    resilienceScore: score,
                    stockChange: parseFloat(stockChange.toFixed(2)),
                    indexChange: parseFloat(indexChange.toFixed(2)),
                    status: getResilienceStatus(score)
                });
            }

            // 趋势判定：基于3日均线均值，避免单日波动误判
            const validDailyResults = dailyResults.filter(r => !r.error);
            const validScores = validDailyResults.map(r => r.resilienceScore);
            const avgArr = (arr) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

            // 最近3日均值与最早3日均值 (validScores 是按日期倒序排列，index 0 是最近一天)
            const latest3 = validScores.slice(0, Math.min(3, validScores.length));
            const ma3Latest = avgArr(latest3);
            const earliest3 = validScores.slice(Math.max(0, validScores.length - 3));
            const ma3Earliest = avgArr(earliest3);

            // 最近一天的抗分歧分数
            const latestSingleScore = validScores[0] || 0;

            // 获取K线数据判断多头排列
            let isBullishArrangement = false;
            let klineCondition = {};
            try {
                const klineData = await getSingleStockData(code, 25);
                if (klineData && klineData.length > 0) {
                    // 按日期排序（从旧到新）
                    const sortedKline = [...klineData].sort((a, b) => a.trade_date - b.trade_date);
                    const latestKline = sortedKline[sortedKline.length - 1];
                    const close = latestKline.close_px;

                    // 手动计算MA5/MA10/MA20，兼容CLS和THS数据源
                    let ma5 = null, ma10 = null, ma20 = null;

                    if (latestKline.ma5_px !== undefined && latestKline.ma5_px !== null) {
                        ma5 = latestKline.ma5_px;
                        ma10 = latestKline.ma10_px;
                        ma20 = latestKline.ma20_px;
                    } else {
                        // CLS数据源需要手动计算均线
                        const len = sortedKline.length;
                        if (len >= 5) {
                            ma5 = parseFloat(sortedKline.slice(len - 5).reduce((sum, k) => sum + k.close_px, 0) / 5).toFixed(2);
                        }
                        if (len >= 10) {
                            ma10 = parseFloat(sortedKline.slice(len - 10).reduce((sum, k) => sum + k.close_px, 0) / 10).toFixed(2);
                        }
                        if (len >= 20) {
                            ma20 = parseFloat(sortedKline.slice(len - 20).reduce((sum, k) => sum + k.close_px, 0) / 20).toFixed(2);
                        }
                    }

                    klineCondition = { close, ma5, ma10, ma20 };

                    if (close != null && ma5 != null && ma10 != null && ma20 != null) {
                        isBullishArrangement = close > ma5 && ma5 > ma10 && ma10 > ma20;
                    } else {
                        console.log(`股票 ${code} K线数据不足，无法判断多头排列: close=${close}, ma5=${ma5}, ma10=${ma10}, ma20=${ma20}`);
                    }
                }
            } catch (e) {
                console.error(`获取 ${code} K线数据失败:`, e.message);
            }

            // 需至少3天有效数据才能进行判定（新算法要求3日平均）
            const canDetermineTransition = validScores.length >= 3;

            let trend = 'stable';
            let hasTransition = false;

            if (canDetermineTransition) {
                // 新判定规则：最近三天平均抗分歧指数>=9，最近一天抗分歧分数>=11，且当前K线呈现多头排列
                const meetsScoreCondition = ma3Latest >= 9 && latestSingleScore >= 11;
                if (meetsScoreCondition && isBullishArrangement) {
                    trend = 'improving';
                    hasTransition = true;
                    console.log(`股票 ${code} 满足转强条件: 近3日均值=${ma3Latest.toFixed(2)}, 近1日=${latestSingleScore.toFixed(2)}, 多头排列=${isBullishArrangement}`);
                }
                // 转弱：最近3日均值 < 最早3日均值
                else if (ma3Latest < ma3Earliest) {
                    trend = 'declining';
                }
                // 稳定
                else {
                    trend = 'stable';
                }
            } else {
                // 数据不足3天，无法使用新算法判定，保持稳定状态
                trend = 'stable';
                hasTransition = false;
            }

            const latestResult = validDailyResults[0] || {};
            const latestChange = latestResult.stockChange || 0;

            return {
                code,
                stockName: name,
                blockName,
                isImportant,
                change: latestChange,
                dailyResults,
                latestScore: parseFloat(ma3Latest.toFixed(2)),
                latestSingleScore: parseFloat(latestSingleScore.toFixed(2)),
                latestStatus: getResilienceStatus(ma3Latest),
                trend,
                hasTransition,
                klineCondition,
                isBullishArrangement
            };
        } catch (error) {
            console.error(`计算 ${code} 多日抗分歧失败:`, error.message);
            return {
                code,
                stockName: name,
                blockName,
                isImportant,
                change: 0,
                dailyResults: [],
                latestScore: 0,
                latestStatus: '偏弱',
                trend: 'error',
                hasTransition: false,
                error: error.message
            };
        }
    }));

    console.log(`抗分歧多日诊断完成：共处理 ${allResults.length} 只股票`);

    // 筛选转强股票 (按最新3日均值降序排列)
    const transitionedStocks = allResults
        .filter(s => s.hasTransition)
        .sort((a, b) => b.latestScore - a.latestScore);

    // 全部股票按最新3日得分排序
    const sortedAllResults = allResults
        .sort((a, b) => b.latestScore - a.latestScore);

    const result = {
        dates: targetDates.map(d => parseInt(d)),
        stocks: sortedAllResults,
        transitionedStocks,
        updatedAt: new Date().toISOString()
    };

    writeResilienceCache(result);

    console.log(`抗分歧多日诊断完成：共 ${allResults.length} 只股票，${transitionedStocks.length} 只发生转强(均值增加)`);

    return { success: true, data: result, fromCache: false };
};

exports.diagnoseResilienceMultiDay = diagnoseResilienceMultiDay;

// 轮询抗分歧多日诊断：每隔 15 分钟自动刷新缓存
// 这样前端打开抗分歧诊断 tab 时可以直接读取缓存，无需手动点击按钮
const pollResilienceMultiDay = (interval = 15 * 60 * 1000) => {
    const task = async () => {
        try {
            console.log('>>> 开始轮询抗分歧多日诊断...');
            const result = await diagnoseResilienceMultiDay(true);
            if (result.success) {
                const transitionedCount = result.data?.transitionedStocks?.length || 0;
                console.log(`>>> 抗分歧多日诊断轮询完成，转强股票 ${transitionedCount} 只`);
            } else {
                console.warn('>>> 抗分歧多日诊断轮询失败:', result.message);
            }
        } catch (error) {
            console.error('>>> 抗分歧多日诊断轮询异常:', error.message);
        }
    };

    // 首次延迟 30s 执行（等 server 其他初始化完成）
    setTimeout(() => {
        task();
        setInterval(task, interval);
        console.log(`>>> 抗分歧多日诊断轮询已调度，间隔 ${interval / 1000}s，首次延迟 30s`);
    }, 30 * 1000);
};

// ========== 个股诊断（指定时间范围） ==========

const diagnoseSingleStockResilience = async (code, startDate, endDate) => {
    if (!code || !startDate || !endDate) {
        return { success: false, message: '参数缺失' };
    }

    const isSh688 = code.startsWith('sh688');
    const indexCode = isSh688 ? 'sh000688' : 'sz399006';
    const indexName = isSh688 ? '科创50' : '创业板指';

    try {
        const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        const monitorStocks = getMonitorStocks();
        const monitorStock = monitorStocks.find(s => s.code === code);
        const stockName = monitorStock?.name || stockData[code]?.stockName || code;

        const start = parseInt(startDate.replace(/-/g, ''));
        const end = parseInt(endDate.replace(/-/g, ''));

        if (start > end) {
            return { success: false, message: '开始日期不能大于结束日期' };
        }

        const dates = [];
        let current = new Date(startDate);
        const endDateObj = new Date(endDate);

        while (current <= endDateObj) {
            const dow = current.getDay();
            if (dow !== 0 && dow !== 6) {
                const year = current.getFullYear();
                const month = String(current.getMonth() + 1).padStart(2, '0');
                const day = String(current.getDate()).padStart(2, '0');
                dates.push(parseInt(`${year}${month}${day}`));
            }
            current.setDate(current.getDate() + 1);
        }

        // 并行处理所有日期，不做节流，以最快速度计算（结果顺序与日期一致）
        const dailyResults = await Promise.all(dates.map(async (date) => {
            try {
                const [stockTline, indexTline] = await Promise.all([
                    getSingleStockTlineDataByDate(code, date),
                    getSingleStockTlineDataByDate(indexCode, date)
                ]);

                const stockLine = stockTline?.line || [];
                const indexLine = indexTline?.line || [];

                if (!stockLine || stockLine.length === 0) {
                    return { date, resilienceScore: 0, error: '无分时数据' };
                }

                if (!indexLine || indexLine.length === 0) {
                    return { date, resilienceScore: 0, error: '指数数据缺失' };
                }

                const limitType = getLimitTypeByCode(code);
                const score = calculateResilience(indexLine, stockLine, limitType);
                const stockLast = stockLine[stockLine.length - 1];
                const indexLast = indexLine[indexLine.length - 1];
                
                const stockChange = (stockLast?.change !== null && stockLast?.change !== undefined) ? stockLast.change : 0;
                const indexChange = (indexLast?.change !== null && indexLast?.change !== undefined) ? indexLast.change : 0;

                return {
                    date,
                    resilienceScore: parseFloat(score.toFixed(4)),
                    stockChange: typeof stockChange === 'number' ? parseFloat(stockChange.toFixed(2)) : 0,
                    indexChange: typeof indexChange === 'number' ? parseFloat(indexChange.toFixed(2)) : 0,
                    status: getResilienceStatus(score)
                };
            } catch (error) {
                console.error(`计算 ${code} 日期 ${date} 抗分歧失败:`, error.message);
                return { date, resilienceScore: 0, error: error.message };
            }
        }));

        const klineData = await getSingleStockData(code, 100);

        return {
            success: true,
            data: {
                code,
                stockName,
                indexCode,
                indexName,
                startDate,
                endDate,
                dailyResults,
                klineData
            }
        };
    } catch (error) {
        console.error('个股诊断失败:', error.message);
        return { success: false, message: error.message };
    }
};

exports.diagnoseSingleStockResilience = diagnoseSingleStockResilience;

// ========== 个股分时抗分歧诊断（按10分钟分段） ==========

// 生成交易时段的10分钟分段
// 上午 9:30-11:30（12段），下午 13:00-15:00（12段），共24段
const generateIntradaySegments = () => {
    const segments = [];
    // 上午 9:30 - 11:30
    for (let h = 9; h <= 11; h++) {
        const startM = h === 9 ? 30 : 0;
        for (let m = startM; m < 60; m += 10) {
            if (h === 11 && m >= 30) break;
            const startMinute = h * 100 + m;
            const endM = m + 10;
            let endHour = h;
            let endMin = endM;
            if (endM >= 60) {
                endHour = h + 1;
                endMin = 0;
            }
            const endMinute = endHour * 100 + endMin;
            segments.push({ startMinute, endMinute });
        }
    }
    // 下午 13:00 - 15:00
    for (let h = 13; h <= 14; h++) {
        for (let m = 0; m < 60; m += 10) {
            const startMinute = h * 100 + m;
            const endM = m + 10;
            let endHour = h;
            let endMin = endM;
            if (endM >= 60) {
                endHour = h + 1;
                endMin = 0;
            }
            const endMinute = endHour * 100 + endMin;
            segments.push({ startMinute, endMinute });
        }
    }
    return segments;
};

// 过滤并重新基准化分段数据（将 change 重新基于分段起始价格计算）
const filterAndRebaseSegment = (line, startMinute, endMinute) => {
    const segment = line.filter(item => {
        const m = parseInt(item.minute);
        return m >= startMinute && m < endMinute;
    });

    if (segment.length === 0) return segment;

    const basePx = parseFloat(segment[0].last_px);
    return segment.map(item => {
        const px = parseFloat(item.last_px);
        const rebasedChange = basePx > 0 ? parseFloat((((px - basePx) / basePx) * 100).toFixed(4)) : 0;
        return {
            ...item,
            change: rebasedChange,
        };
    });
};

// 个股分时抗分歧诊断：获取指定日期的分时数据，按10分钟分段计算抗分歧得分
const diagnoseIntradayResilience = async (code, date) => {
    if (!code || !date) {
        return { success: false, message: '参数缺失' };
    }

    const isSh688 = code.startsWith('sh688');
    const indexCode = isSh688 ? 'sh000688' : 'sz399006';
    const indexName = isSh688 ? '科创50' : '创业板指';

    try {
        const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        const monitorStocks = getMonitorStocks();
        const monitorStock = monitorStocks.find(s => s.code === code);
        const stockName = monitorStock?.name || stockData[code]?.stockName || code;

        const tradeDate = parseInt(date.replace(/-/g, ''));

        const [stockTline, indexTline] = await Promise.all([
            getSingleStockTlineDataByDate(code, tradeDate),
            getSingleStockTlineDataByDate(indexCode, tradeDate)
        ]);

        const stockLine = stockTline?.line || [];
        const indexLine = indexTline?.line || [];

        if (!stockLine || stockLine.length === 0) {
            return { success: false, message: '该日期无个股分时数据' };
        }

        if (!indexLine || indexLine.length === 0) {
            return { success: false, message: '该日期无指数分时数据' };
        }

        const segments = generateIntradaySegments();
        const segmentResults = [];

        for (const seg of segments) {
            const stockSegment = filterAndRebaseSegment(stockLine, seg.startMinute, seg.endMinute);
            const indexSegment = filterAndRebaseSegment(indexLine, seg.startMinute, seg.endMinute);

            if (stockSegment.length < 5 || indexSegment.length < 5) {
                const stockChange = stockSegment.length > 0 ? stockSegment[stockSegment.length - 1].change : 0;
                const indexChange = indexSegment.length > 0 ? indexSegment[indexSegment.length - 1].change : 0;
                segmentResults.push({
                    startMinute: seg.startMinute,
                    endMinute: seg.endMinute,
                    resilienceScore: 0,
                    status: '数据不足',
                    stockChange: parseFloat(stockChange.toFixed(2)),
                    indexChange: parseFloat(indexChange.toFixed(2)),
                    error: '数据不足'
                });
                continue;
            }

            const limitType = getLimitTypeByCode(code);
            const score = calculateResilience(indexSegment, stockSegment, limitType);
            const stockChange = stockSegment[stockSegment.length - 1].change;
            const indexChange = indexSegment[indexSegment.length - 1].change;

            segmentResults.push({
                startMinute: seg.startMinute,
                endMinute: seg.endMinute,
                resilienceScore: parseFloat(score.toFixed(4)),
                status: getResilienceStatus(score),
                stockChange: parseFloat(stockChange.toFixed(2)),
                indexChange: parseFloat(indexChange.toFixed(2))
            });
        }

        const limitType = getLimitTypeByCode(code);
        const overallResilience = calculateResilience(indexLine, stockLine, limitType);

        return {
            success: true,
            data: {
                code,
                stockName,
                indexCode,
                indexName,
                date: tradeDate,
                stockLine,
                indexLine,
                segmentResults,
                overallResilience: parseFloat(overallResilience.toFixed(2)),
                overallStatus: getResilienceStatus(overallResilience)
            }
        };
    } catch (error) {
        console.error('个股分时诊断失败:', error.message);
        return { success: false, message: error.message };
    }
};

exports.diagnoseIntradayResilience = diagnoseIntradayResilience;

// ========== 持仓卖出预警检查 ==========
// 检查所有持仓股票是否触发卖出条件：
// 1. 抗分歧指数 < 5
// 2. 当前价格跌破 10 日线（当前收盘价 < MA10）
// 满足任一条件即返回预警

const { getStockPositions } = require('./stockPosition');

const checkPositionSellAlerts = async () => {
    const positions = getStockPositions();
    if (!positions || positions.length === 0) {
        return { success: true, data: { alerts: [], checkedCount: 0 } };
    }

    // 先获取指数分时数据（科创50和创业板指）
    const [kcTline, szTline] = await Promise.all([
        getSingleStockTlineData('sh000688'),
        getSingleStockTlineData('sz399006'),
    ]);
    const kcLine = kcTline?.line || [];
    const szLine = szTline?.line || [];

    // 并行检查所有持仓，不做节流，以最快速度计算
    const results = await Promise.all(positions.map(async (stock) => {
        try {
            const code = stock.code;
            const isSh688 = code.startsWith('sh688');
            const indexLine = isSh688 ? kcLine : szLine;

            // 1. 计算抗分歧指数
            let resilienceScore = null;
            if (indexLine.length > 0) {
                const stockTline = await getSingleStockTlineData(code);
                const stockLine = stockTline?.line || [];
                if (stockLine.length >= 10) {
                    const limitType = getLimitTypeByCode(code);
                    resilienceScore = calculateResilience(indexLine, stockLine, limitType);
                }
            }

            // 2. 获取 K 线数据判断是否跌破 10 日线
            const klineData = await getSingleStockData(code, 25);
            let closePrice = null;
            let ma10 = null;
            if (klineData && klineData.length > 0) {
                // klineData 按日期倒序，index 0 是最新一天
                const latest = klineData[0];
                closePrice = latest.close_px;
                ma10 = latest.ma10_px;
            }

            // 3. 判断是否触发卖出条件
            const reasons = [];
            if (resilienceScore !== null && resilienceScore < 5) {
                reasons.push(`抗分歧指数 ${resilienceScore.toFixed(2)} 低于 5`);
            }
            if (closePrice !== null && ma10 !== null && closePrice < ma10) {
                reasons.push(`当前价 ${closePrice} 跌破 10 日线 ${ma10}`);
            }

            if (reasons.length > 0) {
                return {
                    code,
                    name: stock.name,
                    resilienceScore: resilienceScore !== null ? parseFloat(resilienceScore.toFixed(2)) : null,
                    closePrice,
                    ma10,
                    reasons,
                };
            }
            return null;
        } catch (error) {
            console.error(`检查 ${stock.name}(${stock.code}) 卖出预警失败:`, error.message);
            return null;
        }
    }));

    const alerts = results.filter(Boolean);

    return {
        success: true,
        data: {
            alerts,
            checkedCount: positions.length,
            updatedAt: new Date().toISOString(),
        },
    };
};

exports.checkPositionSellAlerts = checkPositionSellAlerts;
exports.pollResilienceMultiDay = pollResilienceMultiDay;
