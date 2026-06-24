// 开盘后持续下挫的股票
const fs = require('fs');
const path = require('path');

const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const pollKaiPanXiaCuoData = async (timeRange = { startHour: 9, startMinute: 30, endHour: 9, endMinute: 33 }) => {
    const { startHour, startMinute, endHour, endMinute } = timeRange;
    const dirPath = path.resolve(__dirname, '../data/kaipanxiacuo');

    ensureDir(dirPath);

    let num = 1;
    let pollTimer = null;

    const checkTimer = setInterval(() => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        const isAfterStart = currentHour > startHour || (currentHour === startHour && currentMinute >= startMinute);
        const isAfterEnd = currentHour > endHour || (currentHour === endHour && currentMinute >= endMinute);

        if (!isAfterStart) return;

        if (isAfterEnd) {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
                console.log(`已达到结束时间 ${endHour}:${endMinute}，停止监控开盘下挫。`);
            }
            clearInterval(checkTimer);
            return;
        }

        if (!pollTimer) {
            console.log(`已达到开始时间 ${startHour}:${startMinute}，启动开盘持续下挫监控...`);

            const task = () => {
                delete require.cache[path.resolve(__dirname, '../data/stockData.json')];
                const stockDataMap = require(path.resolve(__dirname, '../data/stockData.json'));
                const stockList = Object.keys(stockDataMap).map(code => ({
                    code,
                    ...stockDataMap[code]
                }));
                // const kaiPanXiaCuoData = stockList.filter(stock => stock.kline && stock.kline[0] && stock.kline[0].change < -0.03);
                fs.writeFileSync(path.resolve(dirPath, `kaipanxiacuo_${num}.json`), JSON.stringify(stockList, null, 2));
                num++;
            };

            task();
            pollTimer = setInterval(task, 30000);
        }
    }, 1000);
};

const getKaiPanXiaCuoData = () => {
    const dirPath = path.resolve(__dirname, '../data/kaipanxiacuo');
    if (!fs.existsSync(dirPath)) return [];

    const files = fs.readdirSync(dirPath)
        .filter(file => file.startsWith('kaipanxiacuo_') && file.endsWith('.json'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/kaipanxiacuo_(\d+)\.json/)[1], 10);
            const numB = parseInt(b.match(/kaipanxiacuo_(\d+)\.json/)[1], 10);
            return numA - numB;
        });

    if (files.length < 2) return [];

    const latestFile = files[files.length - 1];
    const firstFile = files[0];

    const latestData = JSON.parse(fs.readFileSync(path.resolve(dirPath, latestFile), 'utf-8'));
    const firstData = JSON.parse(fs.readFileSync(path.resolve(dirPath, firstFile), 'utf-8'));

    return latestData.filter((stock) => {
        const firstStock = firstData.find(stockItem => stock.code === stockItem.code);
        return stock?.kline?.[0]?.change < firstStock?.kline?.[0]?.change;
    }).map(stock => ({
        code: stock.code,
        stockName: stock.stockName,
        ...stock.kline[0]
    }));
};

(async () => {
    await pollKaiPanXiaCuoData({
        startHour: 23,
        startMinute: 9,
        endHour: 23,
        endMinute: 12,
    });
})()

exports.pollKaiPanXiaCuoData = pollKaiPanXiaCuoData;
exports.getKaiPanXiaCuoData = getKaiPanXiaCuoData;
