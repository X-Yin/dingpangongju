// 获取批量个股的数据，返回需要告警的数据

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getClsReqUrl, getClsReqStockTlineUrl, getThsKlineUrl, getThsKlineHeaders, buildThsKlineRequestBody, timestampToDateStr, getThsTrendUrl, getThsTrendHeaders, buildThsTrendRequestBody, buildThsTrendRequestBodyWithDate, timestampToMinute, getClsReqStockTlineDay5Url, isTradingHours } = require('../utils');
const { getMonitorStocks } = require('./monitorStock');
const { useCLS } = require('../config');

const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
const jisuyidongPath = path.resolve(__dirname, '../data/jisuyidong.json');
const openingPricesPath = path.resolve(__dirname, '../data/openingPrices.json');
const tlineCacheDir = '/Users/xieyin/Desktop/盯盘工具/自选股全量股票过去分时数据';

// 保存当日开盘价（9:25 竞价结束后执行）
function saveOpeningPricesIfNeeded() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return;

    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeNum = currentHour * 100 + currentMinute;
    if (currentTimeNum < 925) return;

    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    let savedData = {};
    try {
        if (fs.existsSync(openingPricesPath)) {
            savedData = JSON.parse(fs.readFileSync(openingPricesPath, 'utf-8'));
        }
    } catch (e) {
        savedData = {};
    }

    // 如果今天已经保存过，不再重复保存
    if (savedData.date === todayStr && savedData.prices) {
        return;
    }

    try {
        const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        const prices = {};
        for (const [code, value] of Object.entries(stockData)) {
            const kline = value.kline && value.kline[0];
            if (kline && kline.open_px) {
                prices[code] = {
                    name: value.stockName,
                    open_px: kline.open_px,
                    trade_date: kline.trade_date
                };
            }
        }
        savedData = {
            date: todayStr,
            prices
        };
        fs.writeFileSync(openingPricesPath, JSON.stringify(savedData, null, 2), 'utf-8');
        console.log(`---------- 保存当日开盘价完成，共 ${Object.keys(prices).length} 只股票 ----------`);
    } catch (e) {
        console.error('保存开盘价失败:', e.message);
    }
}

// 读取当日开盘价
function getOpeningPrices() {
    try {
        if (!fs.existsSync(openingPricesPath)) return { date: null, prices: {} };
        return JSON.parse(fs.readFileSync(openingPricesPath, 'utf-8'));
    } catch (e) {
        return { date: null, prices: {} };
    }
}

const getSingleStockData = async (code, limit = 1) => {
    let result = await getSingleStockDataFromTHS(code, limit);
    if (!result || result.length === 0) {
        console.log(`同花顺获取股票 ${code} K线数据失败，尝试财联社接口兜底`);
        result = await getSingleStockDataFromCLS(code, limit);
    }
    return result;
};

const getSingleStockDataFromCLS = async (code, limit = 1) => {
    try {
        const response = await axios.get(getClsReqUrl(code, limit));
        const kline = response.data.data;
        return kline;
    } catch (error) {
        console.error(`财联社获取股票 ${code} 数据失败:`, error.message);
        return [];
    }
};

const getSingleStockDataFromTHS = async (code, limit = 1) => {
    try {
        const pureCode = code.replace(/^[a-zA-Z]+/, '');
        const url = getThsKlineUrl();
        const headers = getThsKlineHeaders();
        const fetchLimit = Math.max(limit + 20, 40);
        const requestBody = buildThsKlineRequestBody(pureCode, fetchLimit);

        const response = await axios.post(url, requestBody, { headers });

        if (response.data.status_code !== 0) {
            console.error(`同花顺API返回错误状态码: ${response.data.status_code}`);
            return [];
        }

        const quoteData = response.data.data.quote_data;
        if (!quoteData || quoteData.length === 0) {
            return [];
        }

        const valueArray = quoteData[0].value;
        if (!valueArray || !Array.isArray(valueArray) || valueArray.length === 0) {
            return [];
        }

        const klineData = [];
        for (let i = 0; i < valueArray.length; i++) {
            const item = valueArray[i];
            if (item.length < 7) continue;

            const klineItem = {
                trade_date: parseInt(timestampToDateStr(item[0])),
                open_px: item[1],
                high_px: item[2],
                low_px: item[3],
                close_px: item[4],
                business_amount: item[5],
                business_balance: item[6]
            };

            if (i > 0) {
                const prevClose = valueArray[i - 1][4];
                if (prevClose > 0) {
                    klineItem.change = parseFloat((((item[4] - prevClose) / prevClose) * 100).toFixed(2));
                }
            }

            klineData.push(klineItem);
        }

        klineData.sort((a, b) => a.trade_date - b.trade_date);

        for (let i = 0; i < klineData.length; i++) {
            let ma5Sum = 0;
            let ma10Sum = 0;
            let ma20Sum = 0;
            let ma5Count = 0;
            let ma10Count = 0;
            let ma20Count = 0;

            for (let j = Math.max(0, i - 4); j <= i; j++) {
                ma5Sum += klineData[j].close_px;
                ma5Count++;
            }
            for (let j = Math.max(0, i - 9); j <= i; j++) {
                ma10Sum += klineData[j].close_px;
                ma10Count++;
            }
            for (let j = Math.max(0, i - 19); j <= i; j++) {
                ma20Sum += klineData[j].close_px;
                ma20Count++;
            }

            klineData[i].ma5_px = ma5Count >= 5 ? parseFloat((ma5Sum / ma5Count).toFixed(2)) : null;
            klineData[i].ma10_px = ma10Count >= 10 ? parseFloat((ma10Sum / ma10Count).toFixed(2)) : null;
            klineData[i].ma20_px = ma20Count >= 20 ? parseFloat((ma20Sum / ma20Count).toFixed(2)) : null;
        }

        const result = klineData
            .filter(item => item.change !== undefined)
            .sort((a, b) => b.trade_date - a.trade_date)
            .slice(0, limit);

        return result;
    } catch (error) {
        console.error(`同花顺获取股票 ${code} 数据失败:`, error.message);
        return [];
    }
}
exports.getSingleStockData = getSingleStockData;

let tlineNum = 0;
const getSingleStockTlineData = async (code) => {
    let result = await getSingleStockTlineDataFromTHS(code);
    if (!result) {
        console.log(`同花顺获取股票 ${code} 分时数据失败，尝试财联社接口兜底`);
        result = await getSingleStockTlineDataFromCLS(code);
    }
    return result;
};

const getSingleStockTlineDataFromCLS = async (code) => {
    try {
        const response = await axios.get(getClsReqStockTlineUrl(code));
        const data = response.data.data;
        const line = data?.line || [];
        if (!Array.isArray(line) || line.length === 0) {
            return null;
        }
        
        const preclosePx = data?.preclose_px || line[0]?.preclose_px || 0;
        const dateInt = parseInt(timestampToDateStr(line[0].time || line[0].timestamp || Date.now()));
        
        const processedLine = line.map((item) => {
            const timestamp = item.time || item.timestamp || Date.now();
            const lastPx = item.last_px || item.price || item.p || 0;
            const minute = timestampToMinute(timestamp);
            const change = item.change !== undefined ? item.change : 
                (preclosePx > 0 ? parseFloat((((lastPx - preclosePx) / preclosePx) * 100).toFixed(2)) : null);
            const changePx = preclosePx > 0 ? parseFloat((lastPx - preclosePx).toFixed(2)) : null;
            return {
                date: dateInt,
                minute: minute,
                last_px: lastPx,
                av_px: lastPx,
                change: change,
                change_px: changePx,
                business_amount: item.business_amount || item.volume || 0,
                business_balance: item.business_balance || item.amount || 0
            };
        });
        
        return {
            date: dateInt,
            preclose_px: preclosePx,
            line: processedLine
        };
    } catch (error) {
        console.error(`财联社获取股票 ${code} 分时数据失败:`, error.message);
        return null;
    }
};

const getSingleStockTlineDataFromTHS = async (code) => {
    try {
        const url = getThsTrendUrl();
        const headers = getThsTrendHeaders();
        const requestBody = buildThsTrendRequestBody(code);

        const response = await axios.post(url, requestBody, { headers });
        const quoteData = response.data.data?.quote_data?.[0];
        
        if (!quoteData || !quoteData.value || !Array.isArray(quoteData.value)) {
            return null;
        }

        const basePrice = quoteData.base_price;
        const date = timestampToDateStr(quoteData.value[0][0]);
        
        let prevPrice = basePrice;
        const line = quoteData.value.map((item, i) => {
            const prevItem = quoteData.value?.[i - 1];
            const timestamp = item[0];
            const lastPx = item[1];
            const volume = item[2];
            const amount = item[3];
            const minute = timestampToMinute(timestamp);
            
            const effectivePrice = (lastPx !== null && lastPx !== undefined && typeof lastPx === 'number') ? lastPx : prevPrice;
            prevPrice = effectivePrice;
            
            const change = basePrice > 0 ? parseFloat((((effectivePrice - basePrice) / basePrice) * 100).toFixed(2)) : null;
            const changePx = basePrice > 0 ? parseFloat((effectivePrice - basePrice).toFixed(2)) : null;

            return {
                date: parseInt(date),
                minute: minute,
                last_px: effectivePrice,
                av_px: effectivePrice,
                change: change,
                change_px: changePx,
                business_amount: volume - (prevItem?.[2] || 0),
                business_balance: amount - (prevItem?.[3] || 0)
            };
        });

        return {
            date: parseInt(date),
            preclose_px: basePrice,
            line: line
        };
    } catch (error) {
        console.error(`同花顺获取股票 ${code} 分时数据失败:`, error.message);
        return null;
    }
};

exports.getSingleStockTlineData = getSingleStockTlineData;

// 通过股票代码获取股票名称
const getStockNameByCode = (code) => {
    const monitorStocks = getMonitorStocks();
    const stock = monitorStocks.find(s => s.code === code);
    return stock ? stock.name : null;
};

// 分时文件内存缓存：同一缓存文件（按股票名/代码）只读取+解析一次，进程内复用
// （resilience3d 等场景会对同一只股票反复按日期取分时，避免每次重复读盘+JSON.parse）
const tlineFileMemCache = new Map(); // cacheKey -> 已解析的分时历史数组

// 从本地缓存读取分时数据
const getTlineFromCache = (cacheKey, tradeDate) => {
    try {
        let cacheData = tlineFileMemCache.get(cacheKey);
        if (cacheData === undefined) {
            const cacheFile = path.join(tlineCacheDir, `${cacheKey}.json`);
            if (!fs.existsSync(cacheFile)) return null;

            cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            if (!Array.isArray(cacheData)) cacheData = [];
            tlineFileMemCache.set(cacheKey, cacheData);
        }

        const dayData = cacheData.find(d => d.trade_date === tradeDate);
        if (!dayData || !dayData.line || dayData.line.length === 0) return null;

        return {
            date: dayData.trade_date,
            preclose_px: dayData.preclose_px || 0,
            line: dayData.line
        };
    } catch (e) {
        console.error(`读取分时缓存失败 (${cacheKey}, ${tradeDate}):`, e.message);
        return null;
    }
};

// 将分时数据写入本地缓存
const saveTlineToCache = (cacheKey, tradeDate, tlineData) => {
    try {
        const cacheFile = path.join(tlineCacheDir, `${cacheKey}.json`);
        let cacheData = tlineFileMemCache.get(cacheKey);
        if (!Array.isArray(cacheData)) {
            if (fs.existsSync(cacheFile)) {
                try {
                    cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
                } catch (e) {
                    cacheData = [];
                }
            } else {
                cacheData = [];
            }
        }
        if (!Array.isArray(cacheData)) cacheData = [];

        // 移除同日期旧数据
        cacheData = cacheData.filter(d => d.trade_date !== tradeDate);

        const line = tlineData.line || [];
        const lastPxList = line.map(l => l.last_px).filter(p => p != null);

        cacheData.push({
            trade_date: tradeDate,
            open_px: line[0]?.last_px || 0,
            high_px: lastPxList.length > 0 ? Math.max(...lastPxList) : 0,
            low_px: lastPxList.length > 0 ? Math.min(...lastPxList) : 0,
            close_px: line[line.length - 1]?.last_px || 0,
            business_amount: line.reduce((sum, l) => sum + (l.business_amount || 0), 0),
            business_balance: line.reduce((sum, l) => sum + (l.business_balance || 0), 0),
            change: line[line.length - 1]?.change || 0,
            preclose_px: tlineData.preclose_px,
            line: line
        });

        fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');
        tlineFileMemCache.set(cacheKey, cacheData); // 同步内存缓存
    } catch (e) {
        console.error(`写入分时缓存失败 (${cacheKey}, ${tradeDate}):`, e.message);
    }
};

const getSingleStockTlineDataByDateFromCLS = async (code, tradeDate) => {
    try {
        const response = await axios.get(getClsReqStockTlineDay5Url(code));
        const data = response.data.data;
        if (!data || !Array.isArray(data)) {
            return null;
        }

        const targetDay = data.find(day => {
            if (!day.line || !Array.isArray(day.line) || day.line.length === 0) {
                return false;
            }
            const firstItem = day.line[0];
            const itemDate = parseInt(timestampToDateStr(firstItem.time || firstItem.timestamp || Date.now()));
            return itemDate === tradeDate;
        });

        if (!targetDay) {
            return null;
        }

        const line = targetDay.line;
        const preclosePx = targetDay.preclose_px || line[0]?.preclose_px || 0;

        const processedLine = line.map((item) => {
            const lastPx = item.last_px || item.price || item.p || 0;
            const minute = timestampToMinute(item.time || item.timestamp || Date.now());
            const change = preclosePx > 0 ? parseFloat((((lastPx - preclosePx) / preclosePx) * 100).toFixed(2)) : null;
            const changePx = preclosePx > 0 ? parseFloat((lastPx - preclosePx).toFixed(2)) : null;

            return {
                date: tradeDate,
                minute: minute,
                last_px: lastPx,
                av_px: lastPx,
                change: change,
                change_px: changePx,
                business_amount: item.business_amount || 0,
                business_balance: item.business_balance || 0
            };
        });

        return {
            date: tradeDate,
            preclose_px: preclosePx,
            line: processedLine
        };
    } catch (error) {
        console.error(`财联社获取股票 ${code} 日期 ${tradeDate} 分时数据失败:`, error.message);
        return null;
    }
};

// 判断分时缓存数据是否完整（截止时间应为 15:00，否则视为缓存有问题需重新请求）
const isTlineCacheComplete = (line, tradeDate) => {
    if (!Array.isArray(line) || line.length === 0) return false;
    const lastMinute = line[line.length - 1]?.minute;
    if (lastMinute == null) return false;

    const now = new Date();
    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const isToday = String(tradeDate) === todayStr;
    const currentMinute = now.getHours() * 100 + now.getMinutes();

    // 当日尚未收盘（当前时间早于 15:00），当日数据未到 15:00 属正常，直接视为有效，避免重复请求
    if (isToday && currentMinute < 1500) return true;

    // 收盘后或历史交易日，分时数据必须截止到 15:00 才视为完整
    return lastMinute >= 1500;
};

// 分时结果内存缓存（code|date -> 结果，历史分时不可变；当日盘中不缓存）
// 消除 resilience3d 等场景对同一 (股票/指数, 日期) 的重复请求/读盘
const tlineResultMemCache = new Map();

const getSingleStockTlineDataByDate = async (code, tradeDate) => {
    const stockName = getStockNameByCode(code);
    // 非自选股（指数/板块股）无股票名，按代码落盘缓存，避免每次都走 HTTP
    const cacheKey = stockName || String(code);

    // 当日交易时段内跳过缓存，确保获取最新分时数据
    const now = new Date();
    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const isToday = String(tradeDate) === todayStr;
    const skipCache = isToday && isTradingHours();
    const memKey = `${code}|${tradeDate}`;

    if (!skipCache) {
        const memHit = tlineResultMemCache.get(memKey);
        if (memHit !== undefined) {
            return memHit ? { ...memHit } : memHit; // 浅拷贝，防止调用方修改污染缓存
        }
    }

    if (!skipCache && cacheKey) {
        const cached = getTlineFromCache(cacheKey, tradeDate);
        if (cached) {
            if (isTlineCacheComplete(cached.line, tradeDate)) {
                if (!skipCache) tlineResultMemCache.set(memKey, cached);
                return { ...cached }; // 浅拷贝，防止调用方修改污染缓存
            }
            console.log(`分时缓存数据截止时间未到 15:00，视为不完整，重新请求: ${cacheKey} (${code}) ${tradeDate}`);
        }
    }

    let result = await getSingleStockTlineDataByDateFromTHS(code, tradeDate);
    if (!result) {
        console.log(`同花顺获取股票 ${code} 日期 ${tradeDate} 分时数据失败，尝试财联社接口兜底`);
        result = await getSingleStockTlineDataByDateFromCLS(code, tradeDate);
    }

    // 写入本地缓存
    if (result && cacheKey) {
        saveTlineToCache(cacheKey, tradeDate, result);
    }
    // 当日数据仅在覆盖到收盘（15:00）后才写入结果内存缓存
    // 盘前/午间拿到的不完整当日数据一旦缓存，交易时段（skipCache）内不会刷新，
    // 收盘后所有请求会一直命中脏缓存（曾导致抗分歧诊断当日指数只有1个点、得分全为0）
    if (result && !skipCache) {
        const resultLine = Array.isArray(result.line) ? result.line : [];
        const resultLastMinute = resultLine.length > 0 ? resultLine[resultLine.length - 1]?.minute : null;
        const todayComplete = !isToday || (resultLastMinute != null && resultLastMinute >= 1500);
        if (todayComplete) {
            tlineResultMemCache.set(memKey, result);
        }
    }

    return result;
};

const getSingleStockTlineDataByDateFromTHS = async (code, tradeDate) => {
    try {
        const url = getThsTrendUrl();
        const headers = getThsTrendHeaders();
        const requestBody = buildThsTrendRequestBodyWithDate(code, tradeDate);

        const response = await axios.post(url, requestBody, { headers });
        const quoteData = response.data.data?.quote_data?.[0];

        if (!quoteData || !quoteData.value || !Array.isArray(quoteData.value) || quoteData.value.length === 0) {
            return null;
        }

        // 校验返回数据是否确实为请求的日期，避免同花顺忽略 trade_date 返回最新一天数据
        const actualDate = parseInt(timestampToDateStr(quoteData.value[0][0]));
        if (actualDate !== parseInt(tradeDate)) {
            console.log(`同花顺返回 ${actualDate} 分时数据（请求 ${tradeDate}），日期不匹配，改用财联社接口`);
            return null;
        }

        const basePrice = quoteData.base_price;

        let prevPrice = basePrice;
        const line = quoteData.value.map((item, i) => {
            const prevItem = quoteData.value?.[i - 1];
            const timestamp = item[0];
            const lastPx = item[1];
            const volume = item[2];
            const amount = item[3];
            const minute = timestampToMinute(timestamp);

            const effectivePrice = (lastPx !== null && lastPx !== undefined && typeof lastPx === 'number') ? lastPx : prevPrice;
            prevPrice = effectivePrice;

            const change = basePrice > 0 ? parseFloat((((effectivePrice - basePrice) / basePrice) * 100).toFixed(2)) : null;
            const changePx = basePrice > 0 ? parseFloat((effectivePrice - basePrice).toFixed(2)) : null;

            return {
                date: tradeDate,
                minute: minute,
                last_px: effectivePrice,
                av_px: effectivePrice,
                change: change,
                change_px: changePx,
                business_amount: volume - (prevItem?.[2] || 0),
                business_balance: amount - (prevItem?.[3] || 0)
            };
        });

        return {
            date: tradeDate,
            preclose_px: basePrice,
            line: line
        };
    } catch (error) {
        console.error(`同花顺获取股票 ${code} 日期 ${tradeDate} 分时数据失败:`, error.message);
        return null;
    }
};
exports.getSingleStockTlineDataByDate = getSingleStockTlineDataByDate;

/**
 * 获取批量个股的数据
 * @param {*} stockCodeList 股票代码列表
 * @param {*} limit 数据量，默认 1 天
 * @returns [{ 'sh688981': { stockName: '中芯国际', kline: [{}, {}] } }]
 **/
let num = 0;
const getStockListData = async (stockCodeList, limit = 1) => {
    const codes = Object.keys(stockCodeList);
    const promises = codes.map(code => getSingleStockData(code, limit));
    const klineList = await Promise.all(promises);
    
    const stockListData = {};
    for (let i = 0; i < klineList.length; i++) {
        const code = codes[i];
        const kline = klineList[i];
        
        // 过滤掉没有 k 线数据的股票，防止后续逻辑报错
        if (kline && Array.isArray(kline) && kline.length > 0) {
            stockListData[code] = {
                stockName: stockCodeList[code],
                kline: kline.sort((a, b) => b.trade_date - a.trade_date),
            };
        }
    }
    return stockListData;
};

// 轮询股票列表数据，并且存储到本地的 src/data/stockData.json 文件中
const refreshStockData = async () => {
    try {
        const monitorStocks = getMonitorStocks();
        const stockListObj = {};
        monitorStocks.forEach(s => {
            stockListObj[s.code] = s.name;
        });

        console.log(`Manual refresh: monitoring ${monitorStocks.length} stocks, unique codes: ${Object.keys(stockListObj).length}`);

        const stockListData = await getStockListData(stockListObj, 1);
        console.log(`Manual refresh: fetched ${Object.keys(stockListData).length} stocks data`);

        let localDataList = {};
        try {
            localDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        } catch (e) {
            localDataList = {};
        }

        for (const code in stockListData) {
            const kline = localDataList[code] && localDataList[code].kline && localDataList[code].kline[0];
            const newKline = stockListData[code].kline && stockListData[code].kline[0];
            
            if (newKline) {
                if (kline) {
                    stockListData[code].kline[0].change_diff = newKline.change - kline.change;
                } else {
                    stockListData[code].kline[0].change_diff = 0;
                }
            }

            const monitorStock = monitorStocks.find(s => s.code === code);
            if (monitorStock) {
                stockListData[code].isImportant = monitorStock.isImportant;
            }
        }

        fs.writeFileSync(
            stockDataPath,
            JSON.stringify(stockListData, null, 2),
            'utf-8'
        );
        console.log('---------- 手动刷新股票列表数据完成！----------', new Date().toLocaleString());
        return { success: true, message: '刷新成功', count: Object.keys(stockListData).length };
    } catch (error) {
        console.error("手动刷新股票数据失败:", error.message);
        return { success: false, message: error.message };
    }
};
exports.refreshStockData = refreshStockData;
exports.getOpeningPrices = getOpeningPrices;
exports.saveOpeningPricesIfNeeded = saveOpeningPricesIfNeeded;

exports.pollStockData = async (pollInterval = 10000) => {
    const task = async () => {
        if (!isTradingHours()) return;
        try {
            const monitorStocks = getMonitorStocks();
            const stockListObj = {};
            monitorStocks.forEach(s => {
                stockListObj[s.code] = s.name;
            });

            console.log(`Poll: monitoring ${monitorStocks.length} stocks, unique codes: ${Object.keys(stockListObj).length}`);

            const stockListData = await getStockListData(stockListObj, 1);
            console.log(`Poll: fetched ${Object.keys(stockListData).length} stocks data`);

            let localDataList = {};
            try {
                localDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
            } catch (e) {
                localDataList = {};
            }

            for (const code in stockListData) {
                const kline = localDataList[code] && localDataList[code].kline && localDataList[code].kline[0];
                const newKline = stockListData[code].kline && stockListData[code].kline[0];
                
                if (newKline) {
                    if (kline) {
                        stockListData[code].kline[0].change_diff = newKline.change - kline.change;
                    } else {
                        stockListData[code].kline[0].change_diff = 0;
                    }
                }

                const monitorStock = monitorStocks.find(s => s.code === code);
                if (monitorStock) {
                    stockListData[code].isImportant = monitorStock.isImportant;
                }
            }

            fs.writeFileSync(
                stockDataPath,
                JSON.stringify(stockListData, null, 2),
                'utf-8'
            );
            saveOpeningPricesIfNeeded();
            console.log('---------- 轮询股票列表数据完成！----------', new Date().toLocaleString());
        } catch (error) {
            console.error("轮询股票数据任务失败:", error.message);
        }
    };

    await task();

    setInterval(task, pollInterval);
}

// 读取本地 stockData 中的数据，返回需要告警的股票
exports.filterUnNormalStockData = () => {
    const unNormalStockList = [];
    const seenCodes = new Set();
    const stockDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    const monitorStocks = getMonitorStocks();
    const openingPrices = getOpeningPrices();
    const data = Object.entries(stockDataList);
    // 同一只股票可能同时命中"急速异动"和"异常波动"两种条件，需按 code 去重避免重复展示
    const pushUnique = (item) => {
        if (seenCodes.has(item.code)) return;
        seenCodes.add(item.code);
        unNormalStockList.push(item);
    };
    
    for (let i = 0; i < data.length; i++) {
        const [code, value] = data[i];
        const kline = value.kline[0];
        const monitorStock = monitorStocks.find(s => s.code === code);
        const isImportant = monitorStock ? monitorStock.isImportant : false;

        const savedOpening = openingPrices.prices?.[code];
        const openPx = savedOpening?.open_px || kline.open_px;
        const closePx = kline.close_px;
        const aboveOpening = (openPx !== undefined && closePx !== undefined) ? closePx >= openPx : null;

        // 如果涨幅前后相差超过 0.3%，则认为是急速异动股票
        if (Math.abs(kline.change_diff) > 0.3) {
            const item = {
                type: 1,
                name: value.stockName,
                code,
                isImportant,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: `急速异动，异动幅度：${kline.change_diff.toFixed(2)}%`,
                open_px: openPx,
                close_px: closePx,
                above_opening: aboveOpening
            };
            pushUnique(item);
            // 将当前的数据写入到 data/jisuyidong.json 中，先把之前的数据读取出来，然后再塞进去，再写入
            try {
                const localData = JSON.parse(fs.readFileSync(jisuyidongPath, 'utf-8')) || {};
                if (localData[item.code]) {
                    if (kline.change_diff > 0) {
                        localData[item.code].up++;
                    } else {
                        localData[item.code].down++;
                    }
                    localData[item.code].change = item.change;
                } else {
                    localData[item.code] = {
                        stockName: item.name,
                        change: item.change,
                        up: 0,
                        down: 0,
                    };
                }
                fs.writeFileSync(
                    jisuyidongPath,
                    JSON.stringify(localData, null, 2),
                    'utf-8'
                );
            } catch (e) {
                console.log('---------- 写入极速异动股票数据失败！----------', e);
            }
        }
        // 果当日最新的涨幅涨超 2%，或者跌超 -2%，则认为是异常波动股票
        if (Math.abs(kline.change) > 2) {
            pushUnique({
                type: 2,
                name: value.stockName,
                code,
                isImportant,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: kline.change > 0 ? '涨幅>2%' : '跌幅>-2%',
                open_px: openPx,
                close_px: closePx,
                above_opening: aboveOpening
            });
        }
    }
    return unNormalStockList;
};

const getAllStockData = () => {
    const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    const monitorStocks = getMonitorStocks();
    const monitorCodes = monitorStocks.map(s => s.code);

    // 过滤掉不在监控列表中的股票数据
    const filteredStockEntries = Object.entries(stockData).filter(([code]) => monitorCodes.includes(code));

    // 将股票数据转换为数组，每个对象包含独立的code字段，再按涨幅从高到低排序
    const sortedStockArray = filteredStockEntries.map(([code, value]) => {
        // 取出kline的第一项，打平到最外层
        const latestKline = value.kline?.[0] || {};
        const monitorStock = monitorStocks.find(s => s.code === code);
        return {
            code,
            stockName: monitorStock?.name || value.stockName,
            isImportant: monitorStock ? monitorStock.isImportant : false,
            isTop: monitorStock ? monitorStock.isTop : false,
            blockName: monitorStock?.blockName || '',
            ...latestKline
        };
    }).sort((a, b) => {
        const changeA = a.change || 0;
        const changeB = b.change || 0;
        return changeB - changeA;
    });
    return sortedStockArray;
}
exports.getAllStockData = getAllStockData;

// 主动触发更新特定股票的数据（用于新增股票时立即显示）
exports.triggerUpdateStockData = async (codes) => {
    try {
        if (!codes || codes.length === 0) return;
        
        const monitorStocks = getMonitorStocks();
        const stockListObj = {};
        codes.forEach(code => {
            const stock = monitorStocks.find(s => s.code === code);
            if (stock) {
                stockListObj[code] = stock.name;
            }
        });

        if (Object.keys(stockListObj).length === 0) return;

        const newData = await getStockListData(stockListObj, 1);
        
        let localData = {};
        if (fs.existsSync(stockDataPath)) {
            localData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        }

        for (const code in newData) {
            const monitorStock = monitorStocks.find(s => s.code === code);
            if (monitorStock) {
                newData[code].isImportant = monitorStock.isImportant;
                newData[code].kline[0].change_diff = 0; // 新增的默认为 0
                localData[code] = newData[code];
            }
        }

        fs.writeFileSync(stockDataPath, JSON.stringify(localData, null, 2), 'utf-8');
        console.log(`Triggered immediate update for: ${codes.join(', ')}`);
    } catch (e) {
        console.error('Trigger update stock data failed:', e);
    }
};

const getJiSuYiDongRankData = () => {
    let jisuyidongData = {};
    try {
        jisuyidongData = JSON.parse(fs.readFileSync(jisuyidongPath, 'utf-8')) || {};
    } catch (e) {
        console.error('解析 jisuyidong.json 失败，重置为空对象:', e.message);
        fs.writeFileSync(jisuyidongPath, '{}', 'utf-8');
    }
    // 将股票数据转换为数组，每个对象包含独立的code字段，再按涨幅从高到低排序
    const stockArray = Object.entries(jisuyidongData).map(([code, value]) => {
        return {
            code,
            stockName: value.stockName,
            change: value.change,
            up: value.up,
            down: value.down,
        };
    });
    // stockArray 根据每个对象的 up 字段从高到低排序
    const upList = stockArray.sort((a, b) => {
        const upA = a.up || 0;
        const upB = b.up || 0;
        return upB - upA;
    });
    const downList = stockArray.sort((a, b) => {
        const downA = a.down || 0;
        const downB = b.down || 0;
        return downB - downA;
    });
    // 取 upList 和 downList 的前 20 个
    const result = {
        upList: upList.slice(0, 20).filter(item => item.up > 0),
        downList: downList.slice(0, 20).filter(item => item.down > 0),
    };
    return result;
};
exports.getJiSuYiDongRankData = getJiSuYiDongRankData;

// (async () => {
//     console.log(await getSingleStockDataFromTHS('603986', 100));
// })()