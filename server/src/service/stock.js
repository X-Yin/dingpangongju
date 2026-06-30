// 获取批量个股的数据，返回需要告警的数据

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getClsReqUrl, getClsReqStockTlineUrl } = require('../utils');
const { stockList } = require('../constant');

const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
const jisuyidongPath = path.resolve(__dirname, '../data/jisuyidong.json');

const getSingleStockData = async (code, limit = 1) => {
    const response = await axios.get(getClsReqUrl(code, limit));
    // [{trade_date: 20260529, open_px: xx, close_px: xx, high_px: xx, low_px: xx, change(当日涨幅百分比): xx}]
    const kline = response.data.data;
    return kline;
}
exports.getSingleStockData = getSingleStockData;

let tlineNum = 0;
const getSingleStockTlineData = async (code) => {
    const response = await axios.get(getClsReqStockTlineUrl(code));
    // [{trade_date: 20260529, open_px: xx, close_px: xx, high_px: xx, low_px: xx, change(当日涨幅百分比): xx}]
    const tline = response.data.data;
    // mock
    // if (tlineNum === 0) {
    //     tline.line[tline.line.length - 1].change = 9;
    //     tlineNum++;
    // }
       return tline;
}
exports.getSingleStockTlineData = getSingleStockTlineData;

/**
 * 获取批量个股的数据
 * @param {*} stockCodeList 股票代码列表
 * @param {*} limit 数据量，默认 1 天
 * @returns [{ 'sh688981': { stockName: '中芯国际', kline: [{}, {}] } }]
 **/
let num = 0;
const getStockListData = async (stockCodeList, limit = 1) => {
    // if (num === 0) {
    //     num++;
    //     return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../mock/mockStockData1.json')));
    // }
    // return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../mock/mockStockData2.json')));

    const promises = [];
    const stockListData = {};
    for (const code in stockCodeList) {
        promises.push(getSingleStockData(code, limit));
    }
    const klineList = await Promise.all(promises);
    for (let i = 0; i < klineList.length; i++) {
        stockListData[Object.keys(stockCodeList)[i]] = {
            stockName: stockCodeList[Object.keys(stockCodeList)[i]],
            kline: klineList[i],
        };
    }
    // 按照 trade_date 排序，最新的日期在第一个
    for (const code in stockListData) {
        stockListData[code].kline.sort((a, b) => b.trade_date - a.trade_date);
    }
    // mock 把 change 为负数的变成正的
    // for (const code in stockListData) {
    //     stockListData[code].kline.forEach(item => {
    //         if (item.change < 0) {
    //             item.change = -item.change;
    //         }
    //     });
    // }
    // stockListData['sh688981'].kline[0].change = -9999999;

    return stockListData;
};

// 轮询股票列表数据，并且存储到本地的 src/data/stockData.json 文件中
exports.pollStockData = async (pollInterval = 10000) => {
    const task = async () => {
        const stockListData = await getStockListData(stockList, 1);

        // 先读取出来本地的数据
        let localDataList = {};
        try {
            localDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        } catch (e) {
            localDataList = {};
        }

        // 遍历本地数据，如果最新的数据和本地的数据，计算 change 的差值，赋予一个新的属性叫做 change_diff
        for (const code in stockListData) {
            const kline = localDataList[code] && localDataList[code].kline && localDataList[code].kline[0];
            const newKline = stockListData[code].kline[0];
            if (kline) {
                stockListData[code].kline[0].change_diff = newKline.change - kline.change;
            } else {
                stockListData[code].kline[0].change_diff = 0;
            }
        }

        // 存储到本地的 src/data/stockData.json 文件中
        fs.writeFileSync(
            stockDataPath,
            JSON.stringify(stockListData, null, 2),
            'utf-8'
        );
        console.log('---------- 轮询股票列表数据完成！----------', new Date().toLocaleString());
    };

    // 立即执行一次
    await task();

    setInterval(task, pollInterval);
}

// 读取本地 stockData 中的数据，返回需要告警的股票
exports.filterUnNormalStockData = () => {
    const unNormalStockList = [];
    const stockDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    const data = Object.entries(stockDataList);
    for (let i = 0; i < data.length; i++) {
        const [code, value] = data[i];
        const kline = value.kline[0];
        // 如果涨幅前后相差超过 0.3%，则认为是急速异动股票
        if (Math.abs(kline.change_diff) > 0.3) {
            const item = {
                type: 1,
                name: value.stockName,
                code,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: `急速异动，异动幅度：${kline.change_diff.toFixed(2)}%`
            };
            unNormalStockList.push(item);
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
            unNormalStockList.push({
                type: 2,
                name: value.stockName,
                code,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: kline.change > 0 ? '涨幅>2%' : '跌幅>-2%'
            });
        }
    }
    // 对unNormalStockList按stockName去重，保留每个股票的第一条异常记录
    // const uniqueList = [];
    // const seenCodes = new Set();
    // for (const item of unNormalStockList) {
    //     if (!seenCodes.has(item.code)) {
    //         seenCodes.add(item.code);
    //         uniqueList.push(item);
    //     }
    // }
    return unNormalStockList;
};

const getAllStockData = () => {
    const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    // 将股票数据转换为数组，每个对象包含独立的code字段，再按涨幅从高到低排序
    const sortedStockArray = Object.entries(stockData).map(([code, value]) => {
        // 取出kline的第一项，打平到最外层
        const latestKline = value.kline?.[0] || {};
        return {
            code,
            stockName: value.stockName,
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

const getJiSuYiDongRankData = () => {
    const jisuyidongData = JSON.parse(fs.readFileSync(jisuyidongPath, 'utf-8')) || {};
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
//     console.log(getAllStockData());
// })();
