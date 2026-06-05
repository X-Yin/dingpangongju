// 获取批量个股的数据，返回需要告警的数据

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getClsReqUrl, getClsReqStockTlineUrl } = require('../utils');

const stockList = {
    'sh688981': '中芯国际',
    'sh688347': '华虹公司',
    'sh688072': '拓荆科技',
    'sz002371': '北方华创',
    'sh688256': '寒武纪',
    'sz002837': '英维克',
    'sz301018': '申菱环境',
    'sh601138': '工业富联',
    'sz300757': '罗博特科',
    'sz300394': '天孚通信',
    'sz300502': '新易盛',
    'sz300308': '中际旭创',
    'sh688048': '长华光芯',
    'sz301511': '德福科技',
    'sz301217': '铜冠铜箔',
    'sh688008': '澜起科技',
    'sh688041': '海光信息',
    'sz002475': '立讯精密',
    'sh600183': '生益科技',
    'sh603986': '兆易创新',
    'sh688313': '仕佳光子',
    'sh688498': '源杰科技',
    'sz002384': '东山精密',
    'sz002916': '深南电路',
    'sz002463': '沪电股份',
    'sz300476': '胜宏科技',
    'sh688525': '佰维存储',
    'sz301308': '江波龙',
    'sh601869': '长飞光纤',
    'sh600487': '亨通光电',
    'sh603256': '宏和科技',
    'sh688146': '中船特气',
    'sz300408': '三环集团',
    'sh600118': '中国卫星',
    'sh600879': '航天电子',
    'sz000657': '中钨高新',
    'sh688082': '盛美上海',
    'sh688808': '联讯仪器',
    'sz002851': '麦格米特'
};

const stockDataPath = path.resolve(__dirname, '../data/stockData.json');

const getSingleStockData = async (code, limit = 1) => {
    const response = await axios.get(getClsReqUrl(code, limit));
    // [{trade_date: 20260529, open_px: xx, close_px: xx, high_px: xx, low_px: xx, change(当日涨幅百分比): xx}]
    const kline = response.data.data;
    return kline;
}
exports.getSingleStockData = getSingleStockData;

const getSingleStockTlineData = async (code) => {
    const response = await axios.get(getClsReqStockTlineUrl(code));
    // [{trade_date: 20260529, open_px: xx, close_px: xx, high_px: xx, low_px: xx, change(当日涨幅百分比): xx}]
    const tline = response.data.data;
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
            unNormalStockList.push({
                name: value.stockName,
                code,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: `急速异动，异动幅度：${kline.change_diff.toFixed(2)}%`
            });
        }
        // 果当日最新的涨幅涨超 2%，或者跌超 -2%，则认为是异常波动股票
        if (Math.abs(kline.change) > 2) {
            unNormalStockList.push({
                name: value.stockName,
                code,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: kline.change > 0 ? '涨幅>2%' : '跌幅>-2%'
            });
        }
    }
    // 对unNormalStockList按stockName去重，保留每个股票的第一条异常记录
    const uniqueList = [];
    const seenCodes = new Set();
    for (const item of unNormalStockList) {
        if (!seenCodes.has(item.code)) {
            seenCodes.add(item.code);
            uniqueList.push(item);
        }
    }
    return uniqueList;
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

// (async () => {
//     console.log(getAllStockData());
// })();
