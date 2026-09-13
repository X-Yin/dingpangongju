const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getClsReqUrl, getClsReqIndexUrl, sleep, batchParallel } = require('../utils');
const { getMonitorStocks } = require('./monitorStock');
const { useCLS } = require('../config');

const premiumCachePath = path.resolve(__dirname, '../data/premium_diagnosis.json');

const readPremiumCache = () => {
    try {
        const cache = JSON.parse(fs.readFileSync(premiumCachePath, 'utf-8'));
        const cacheAge = Date.now() - new Date(cache.updatedAt).getTime();
        if (cacheAge < 4 * 60 * 60 * 1000) {
            return cache;
        }
    } catch (e) {
    }
    return null;
};

const writePremiumCache = (data) => {
    try {
        fs.writeFileSync(premiumCachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('写入溢价诊断缓存失败:', e.message);
    }
};

const getRecentTradingDates = (days = 60) => {
    const dates = [];
    const today = new Date();
    let date = new Date(today);

    const dayOfWeek = today.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        date.setDate(date.getDate() - 1);
    }

    while (dates.length < days) {
        const dow = date.getDay();
        if (dow !== 0 && dow !== 6) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            dates.push(parseInt(`${year}${month}${day}`));
        }
        date.setDate(date.getDate() - 1);
    }

    return dates.sort((a, b) => a - b);
};

const diagnosePremium = async (forceRefresh = false) => {
    if (!forceRefresh) {
        const cache = readPremiumCache();
        if (cache) {
            console.log('溢价诊断：返回缓存数据');
            return { success: true, data: cache, fromCache: true };
        }
    }

    const monitorStocks = getMonitorStocks();
    if (!monitorStocks || monitorStocks.length === 0) {
        return { success: false, message: '监控股票列表为空' };
    }

    const stockCodes = monitorStocks.map(s => s.code);
    const stockNameMap = {};
    monitorStocks.forEach(s => {
        stockNameMap[s.code] = s.name;
    });

    const fetchStockKline = async (code) => {
        try {
            const limit = 80;
            const { data: { data: klineData } } = await axios.get(getClsReqUrl(code, limit));
            if (klineData && klineData.length > 0) {
                return { code, kline: klineData };
            }
        } catch (error) {
            console.error(`获取股票 ${code} K线数据失败:`, error.message);
        }
        return { code, kline: [] };
    };

    console.log(`溢价诊断：开始获取 ${stockCodes.length} 只股票的K线数据`);
    const klineResults = await batchParallel(stockCodes, fetchStockKline, useCLS() ? 5 : 20);

    const stockKlineMap = {};
    klineResults.forEach(result => {
        if (result.kline && result.kline.length > 0) {
            stockKlineMap[result.code] = result.kline.sort((a, b) => a.trade_date - b.trade_date);
        }
    });

    console.log(`溢价诊断：成功获取 ${Object.keys(stockKlineMap).length} 只股票的K线数据`);

    const { data: { data: chuangyebanData } } = await axios.get(getClsReqIndexUrl('sz399006', 80));
    const { data: { data: kechuangbanData } } = await axios.get(getClsReqIndexUrl('sh000688', 80));

    const indexKline = {
        chuangyeban: chuangyebanData?.sort((a, b) => a.trade_date - b.trade_date) || [],
        kechuangban: kechuangbanData?.sort((a, b) => a.trade_date - b.trade_date) || []
    };

    const candidateDates = indexKline.chuangyeban.map(item => item.trade_date);

    console.log(`溢价诊断：候选日期范围 ${candidateDates[0]} - ${candidateDates[candidateDates.length - 1]}, 共 ${candidateDates.length} 个`);

    if (stockCodes.length > 0) {
        const sampleKline = stockKlineMap[stockCodes[0]];
        if (sampleKline && sampleKline.length > 0) {
            const klineDates = sampleKline.map(k => k.trade_date);
            console.log(`溢价诊断：样本股票 ${stockCodes[0]} K线日期范围 ${klineDates[0]} - ${klineDates[klineDates.length - 1]}, 共 ${klineDates.length} 个`);
        }
    }

    const premiumHistory = [];

    for (let i = 1; i < candidateDates.length; i++) {
        const currentDate = candidateDates[i];
        const prevDate = candidateDates[i - 1];

        const prevDayUpStocks = [];

        for (const code of stockCodes) {
            const kline = stockKlineMap[code];
            if (!kline || kline.length === 0) continue;

            const prevDayKline = kline.find(k => k.trade_date === prevDate);
            if (prevDayKline && prevDayKline.change > 0) {
                prevDayUpStocks.push({
                    code,
                    stockName: stockNameMap[code] || code,
                    prevClose: prevDayKline.close_px,
                    prevChange: prevDayKline.change
                });
            }
        }

        const premiumStocks = [];
        const laggingStocks = [];

        if (prevDayUpStocks.length > 0) {
            for (const stock of prevDayUpStocks) {
                const kline = stockKlineMap[stock.code];
                if (!kline || kline.length === 0) continue;

                const currentDayKline = kline.find(k => k.trade_date === currentDate);
                if (!currentDayKline) continue;

                const hasPremium = currentDayKline.close_px > stock.prevClose;

                if (hasPremium) {
                    premiumStocks.push({
                        code: stock.code,
                        stockName: stock.stockName,
                        prevClose: stock.prevClose,
                        prevChange: stock.prevChange,
                        currentClose: currentDayKline.close_px,
                        currentChange: currentDayKline.change,
                        premiumAmount: parseFloat((currentDayKline.close_px - stock.prevClose).toFixed(2))
                    });
                } else {
                    laggingStocks.push({
                        code: stock.code,
                        stockName: stock.stockName,
                        prevClose: stock.prevClose,
                        prevChange: stock.prevChange,
                        currentClose: currentDayKline.close_px,
                        currentChange: currentDayKline.change,
                        premiumAmount: parseFloat((currentDayKline.close_px - stock.prevClose).toFixed(2))
                    });
                }
            }
        }

        const premiumRate = prevDayUpStocks.length > 0 
            ? parseFloat(((premiumStocks.length / prevDayUpStocks.length) * 100).toFixed(2))
            : 0;

        premiumHistory.push({
            date: currentDate,
            prevDate: prevDate,
            totalUpCount: prevDayUpStocks.length,
            premiumCount: premiumStocks.length,
            laggingCount: laggingStocks.length,
            premiumRate,
            premiumStocks,
            laggingStocks
        });

        await sleep(50);
    }

    premiumHistory.sort((a, b) => b.date - a.date);

    const latestData = premiumHistory[0] || null;

    const result = {
        latestData,
        premiumHistory,
        indexKline,
        totalStockCount: stockCodes.length,
        validStockCount: Object.keys(stockKlineMap).length,
        updatedAt: new Date().toISOString()
    };

    writePremiumCache(result);

    console.log(`溢价诊断完成：共 ${premiumHistory.length} 个交易日数据`);

    return { success: true, data: result, fromCache: false };
};

exports.diagnosePremium = diagnosePremium;

const pollPremiumDiagnosis = (interval = 30 * 60 * 1000) => {
    const task = async () => {
        try {
            console.log('>>> 开始轮询溢价诊断...');
            const result = await diagnosePremium(true);
            if (result.success) {
                const latest = result.data?.latestData;
                console.log(`>>> 溢价诊断轮询完成，最新溢价率 ${latest?.premiumRate || 0}%`);
            } else {
                console.warn('>>> 溢价诊断轮询失败:', result.message);
            }
        } catch (error) {
            console.error('>>> 溢价诊断轮询异常:', error.message);
        }
    };

    setTimeout(() => {
        task();
        setInterval(task, interval);
        console.log(`>>> 溢价诊断轮询已调度，间隔 ${interval / 1000}s，首次延迟 60s`);
    }, 60 * 1000);
};

exports.pollPremiumDiagnosis = pollPremiumDiagnosis;