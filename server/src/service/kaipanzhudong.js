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

    // 获取并按序号排序文件
    const files = fs.readdirSync(dirPath)
        .filter(file => file.startsWith('kaipanzhudong_') && file.endsWith('.json'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/kaipanzhudong_(\d+)\.json/)[1]);
            const numB = parseInt(b.match(/kaipanzhudong_(\d+)\.json/)[1]);
            return numA - numB;
        });

    // 如果文件夹下面只有一个文件或没有文件，就返回一个空数据
    if (files.length < 2) return [];

    // 获取序号最新的文件和序号第一个的文件
    const latestFile = files[files.length - 1];
    const firstFile = files[0];

    const latestData = JSON.parse(fs.readFileSync(path.resolve(dirPath, latestFile), 'utf-8'));
    const firstData = JSON.parse(fs.readFileSync(path.resolve(dirPath, firstFile), 'utf-8'));

    // 比对逻辑：如果最新数据比第一个序号的数据高，就放入结果中
    const result = latestData.filter((stock) => {
        const firstStock = firstData.find(stockItem => stock.code === stockItem.code);
        return stock?.kline?.[0]?.change > firstStock?.kline?.[0]?.change;
    }).map(stock => ({
        code: stock.code,
        stockName: stock.stockName,
        ...stock.kline[0]
    }));

    return result;
}

exports.pollKaiPaiZhuDongData = pollKaiPaiZhuDongData;
exports.getKaiPanZhuDongData = getKaiPanZhuDongData;
