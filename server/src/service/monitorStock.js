const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getClsReqStockBasicUrl, batchParallel } = require('../utils');

const DATA_PATH = path.join(__dirname, '../data/monitor_stocks.json');
const TOTAL_SHARES_PATH = path.join(__dirname, '../data/monitor_stocks_total_shares.json');

// 读取 monitor_stocks_total_shares.json（数组：[{ secu_code, secu_name, TotalShares }]）
const getTotalSharesData = () => {
    try {
        if (!fs.existsSync(TOTAL_SHARES_PATH)) return [];
        const data = fs.readFileSync(TOTAL_SHARES_PATH, 'utf8') || '[]';
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Error reading total shares data:', error);
        return [];
    }
};

// 拉取个股基础信息中的总股本（TotalShares）并写入 monitor_stocks_total_shares.json
// codes 为空时：只补拉文件中缺失的股票；传入 codes 时强制重新拉取指定股票
const syncTotalShares = async (codes = null) => {
    const stocks = getMonitorStocks();
    const existingArr = getTotalSharesData();
    const existingMap = {};
    existingArr.forEach(item => {
        if (item && item.secu_code) existingMap[item.secu_code] = item;
    });

    // 待拉取列表：显式传入则强制刷新；否则只拉缺失的
    let targetCodes;
    if (Array.isArray(codes) && codes.length > 0) {
        targetCodes = stocks.filter(s => codes.includes(s.code)).map(s => s.code)
            .concat(codes.filter(c => !stocks.find(s => s.code === c)));
    } else {
        targetCodes = stocks.map(s => s.code).filter(code =>
            !existingMap[code] || existingMap[code].TotalShares == null
        );
    }

    if (targetCodes.length > 0) {
        const clsHeaders = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': 'https://www.cls.cn',
            'Referer': 'https://www.cls.cn/',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        };
        const fetchOne = async (code) => {
            try {
                const { data: resp } = await axios.get(getClsReqStockBasicUrl(code), { headers: clsHeaders, timeout: 10000 });
                if (resp && resp.code === 200 && resp.data && resp.data.TotalShares != null) {
                    return {
                        secu_code: resp.data.secu_code,
                        secu_name: resp.data.secu_name,
                        TotalShares: resp.data.TotalShares,
                    };
                }
                console.error(`获取 ${code} 总股本失败: 响应异常`, resp && resp.msg);
            } catch (error) {
                console.error(`获取 ${code} 总股本失败:`, error.message);
            }
            return null;
        };
        const fetched = await batchParallel(targetCodes, fetchOne, 5);
        fetched.forEach(item => {
            if (item) existingMap[item.secu_code] = item;
        });
    }

    // 与监控列表保持同序，剔除已删除的自选股
    const merged = stocks
        .map(s => existingMap[s.code])
        .filter(Boolean);

    fs.writeFileSync(TOTAL_SHARES_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
};

const getMonitorStocks = () => {
    try {
        if (!fs.existsSync(DATA_PATH)) {
            return [];
        }
        const data = fs.readFileSync(DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading monitor stocks:', error);
        return [];
    }
};

const saveMonitorStocks = (stocks) => {
    try {
        fs.writeFileSync(DATA_PATH, JSON.stringify(stocks, null, 2), 'utf8');
        
        // 删除或更新后，立即清理 stockData.json 中的失效数据，确保前端 fetchData 拿到的是最新列表
        const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
        if (fs.existsSync(stockDataPath)) {
            const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
            const monitorCodes = stocks.map(s => s.code);
            const newStockData = {};
            
            // 只保留当前监控列表中的股票数据
            monitorCodes.forEach(code => {
                if (stockData[code]) {
                    newStockData[code] = stockData[code];
                }
            });
            
            fs.writeFileSync(stockDataPath, JSON.stringify(newStockData, null, 2), 'utf-8');
        }
        
        return true;
    } catch (error) {
        console.error('Error saving monitor stocks:', error);
        return false;
    }
};

const addMonitorStock = (code, name, blockName = 'xxx', riskScore = null, isTech = true) => {
    const stocks = getMonitorStocks();
    if (stocks.find(s => s.code === code)) {
        return false;
    }
    stocks.push({ code, name, isImportant: false, blockName, riskScore, isTech });
    return saveMonitorStocks(stocks);
};

const deleteMonitorStock = (code) => {
    const stocks = getMonitorStocks();
    const newStocks = stocks.filter(s => s.code !== code);
    if (stocks.length === newStocks.length) {
        return false;
    }
    // 同步移除总股本文件中的对应记录
    try {
        const filtered = getTotalSharesData().filter(item => item.secu_code !== code);
        fs.writeFileSync(TOTAL_SHARES_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    } catch (error) {
        console.error('清理总股本数据失败:', error);
    }
    return saveMonitorStocks(newStocks);
};

const toggleStockImportant = (code) => {
    const stocks = getMonitorStocks();
    const stock = stocks.find(s => s.code === code);
    if (!stock) {
        return false;
    }
    stock.isImportant = !stock.isImportant;
    return saveMonitorStocks(stocks);
};

const toggleStockTop = (code) => {
    const stocks = getMonitorStocks();
    const stock = stocks.find(s => s.code === code);
    if (!stock) {
        return false;
    }
    stock.isTop = !stock.isTop;
    return saveMonitorStocks(stocks);
};

const batchSetImportant = (codes) => {
    if (!Array.isArray(codes) || codes.length === 0) {
        return { success: false, message: '股票代码列表为空' };
    }
    const stocks = getMonitorStocks();
    let updatedCount = 0;
    for (const code of codes) {
        const stock = stocks.find(s => s.code === code);
        if (stock && !stock.isImportant) {
            stock.isImportant = true;
            updatedCount++;
        }
    }
    if (updatedCount > 0) {
        saveMonitorStocks(stocks);
    }
    return { success: true, updatedCount, totalRequested: codes.length };
};

const updateMonitorStockName = (code, newName) => {
    const stocks = getMonitorStocks();
    const stock = stocks.find(s => s.code === code);
    if (!stock) {
        return false;
    }
    stock.name = newName;
    return saveMonitorStocks(stocks);
};

module.exports = {
    getMonitorStocks,
    addMonitorStock,
    deleteMonitorStock,
    toggleStockImportant,
    batchSetImportant,
    updateMonitorStockName,
    toggleStockTop,
    getTotalSharesData,
    syncTotalShares
};
