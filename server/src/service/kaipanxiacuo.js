// 开盘后持续下挫的股票
// 复用 kaipanzhudong 记录的数据，判断逻辑与主动拉升相反
const fs = require('fs');
const path = require('path');

const getKaiPanXiaCuoData = () => {
    const dirPath = path.resolve(__dirname, '../data/kaipanzhudong');
    if (!fs.existsSync(dirPath)) return [];

    const files = fs.readdirSync(dirPath)
        .filter(file => file.startsWith('kaipanzhudong_') && file.endsWith('.json'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/kaipanzhudong_(\d+)\.json/)[1], 10);
            const numB = parseInt(b.match(/kaipanzhudong_(\d+)\.json/)[1], 10);
            return numA - numB;
        });

    if (files.length < 2) return [];

    const latestFile = files[files.length - 1];
    const firstFile = files[0];

    const latestData = JSON.parse(fs.readFileSync(path.resolve(dirPath, latestFile), 'utf-8'));
    const firstData = JSON.parse(fs.readFileSync(path.resolve(dirPath, firstFile), 'utf-8'));

    // 比对逻辑与主动拉升相反：最新 change 小于第一次的 change 即为持续下挫
    return latestData.filter((stock) => {
        const firstStock = firstData.find(stockItem => stock.code === stockItem.code);
        return stock?.kline?.[0]?.change < firstStock?.kline?.[0]?.change;
    }).map(stock => ({
        code: stock.code,
        stockName: stock.stockName,
        ...stock.kline[0]
    }));
};

exports.getKaiPanXiaCuoData = getKaiPanXiaCuoData;
