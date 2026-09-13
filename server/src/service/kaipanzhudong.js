// 开盘前 3min 内主动向上拉升的股票
const fs = require('fs');
const path = require('path');

const pollKaiPaiZhuDongData = async (timeRange = { startHour: 9, startMinute: 30, endHour: 9, endMinute: 33 }) => {
    const { startHour, startMinute, endHour, endMinute } = timeRange;
    const dirPath = path.resolve(__dirname, '../data/kaipanzhudong');

    let num = 1;
    let pollTimer = null;
    
    // 开启 1s 定时器检查时间
    const checkTimer = setInterval(() => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        const isAfterStart = currentHour > startHour || (currentHour === startHour && currentMinute >= startMinute);
        const isAfterEnd = currentHour > endHour || (currentHour === endHour && currentMinute >= endMinute);

        // 1. 如果还没到开始时间，继续等待
        if (!isAfterStart) return;

        // 2. 如果已经过了结束时间
        if (isAfterEnd) {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
                console.log(`已达到结束时间 ${endHour}:${endMinute}，停止监控。`);
                // clearDir(); // 达到结束时间，删除所有文件
            }
            // 注意：这里我们不一定要 clearInterval(checkTimer)，因为第二天可能还要跑
            // 但根据用户要求“关闭所有的定时器”，我们这里可以关闭
            clearInterval(checkTimer);
            return;
        }

        // 3. 处于监控时间段内
        if (!pollTimer) {
            console.log(`已达到开始时间 ${startHour}:${startMinute}，启动开盘主动拉升监控...`);
            
            const task = () => {
                delete require.cache[path.resolve(__dirname, '../data/stockData.json')];
                const stockDataMap = require(path.resolve(__dirname, '../data/stockData.json'));
                const stockList = Object.keys(stockDataMap).map(code => ({
                    code,
                    ...stockDataMap[code]
                }));
                // const kaipanzhudongData = stockList.filter(stock => stock.kline && stock.kline[0] && stock.kline[0].change > 0.03);
                fs.writeFileSync(path.resolve(dirPath, `kaipanzhudong_${num}.json`), JSON.stringify(stockList, null, 2));
                num++;
            };

            task(); // 立即执行一次
            pollTimer = setInterval(task, 30000);
        }
    }, 1000);
}

const getKaiPanZhuDongData = () => {
    const dirPath = path.resolve(__dirname, '../data/kaipanzhudong');
    if (!fs.existsSync(dirPath)) return [];

    const files = fs.readdirSync(dirPath)
        .filter(file => file.startsWith('kaipanzhudong_') && file.endsWith('.json'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/kaipanzhudong_(\d+)\.json/)[1]);
            const numB = parseInt(b.match(/kaipanzhudong_(\d+)\.json/)[1]);
            return numA - numB;
        });

    if (files.length < 2) return [];

    const latestFile = files[files.length - 1];
    const firstFile = files[0];

    const latestData = JSON.parse(fs.readFileSync(path.resolve(dirPath, latestFile), 'utf-8'));
    const firstData = JSON.parse(fs.readFileSync(path.resolve(dirPath, firstFile), 'utf-8'));

    const monitorStocks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/monitor_stocks.json'), 'utf-8'));
    const blockMap = {};
    monitorStocks.forEach(s => {
        blockMap[s.code] = s.blockName;
    });

    const result = latestData.filter((stock) => {
        const firstStock = firstData.find(stockItem => stock.code === stockItem.code);
        return stock?.kline?.[0]?.change > firstStock?.kline?.[0]?.change;
    }).map(stock => ({
        code: stock.code,
        stockName: stock.stockName,
        blockName: blockMap[stock.code] || '',
        ...stock.kline[0]
    }));

    return result;
}

const getKaiPanHighChangeStocks = () => {
    const dirPath = path.resolve(__dirname, '../data/kaipanzhudong');
    if (!fs.existsSync(dirPath)) return [];

    const files = fs.readdirSync(dirPath)
        .filter(file => file.startsWith('kaipanzhudong_') && file.endsWith('.json'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/kaipanzhudong_(\d+)\.json/)[1]);
            const numB = parseInt(b.match(/kaipanzhudong_(\d+)\.json/)[1]);
            return numA - numB;
        });

    if (files.length === 0) return [];

    const firstFile = files[0];
    const firstData = JSON.parse(fs.readFileSync(path.resolve(dirPath, firstFile), 'utf-8'));

    return firstData
        .filter(stock => stock?.kline?.[0]?.change > 2)
        .map(stock => ({
            code: stock.code,
            stockName: stock.stockName,
            change: stock.kline[0].change
        }));
};

exports.pollKaiPaiZhuDongData = pollKaiPaiZhuDongData;
exports.getKaiPanZhuDongData = getKaiPanZhuDongData;
exports.getKaiPanHighChangeStocks = getKaiPanHighChangeStocks;
