const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../data/monitor_stocks.json');

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

const addMonitorStock = (code, name) => {
    const stocks = getMonitorStocks();
    if (stocks.find(s => s.code === code)) {
        return false;
    }
    stocks.push({ code, name, isImportant: false });
    return saveMonitorStocks(stocks);
};

const deleteMonitorStock = (code) => {
    const stocks = getMonitorStocks();
    const newStocks = stocks.filter(s => s.code !== code);
    if (stocks.length === newStocks.length) {
        return false;
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

module.exports = {
    getMonitorStocks,
    addMonitorStock,
    deleteMonitorStock,
    toggleStockImportant
};
