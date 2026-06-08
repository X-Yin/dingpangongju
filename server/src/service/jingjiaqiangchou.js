// 竞价抢筹相关数据服务
const fs = require('fs');
const path = require('path');

const pollJingJiaQiangChouData = async (hour = 9, minute = 24) => {
    // 设置一个定时器，每隔一秒轮询一次，如果当前时间是上午的 9:24 读取本地的 data/stockData.json 文件内容，存储到本地的 data/jingjiaqiangchouData/924.json 文件中
    const intervalId = setInterval(() => {
        const currentTime = new Date();
        if (currentTime.getHours() === hour && currentTime.getMinutes() === minute) {
            const stockData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/stockData.json'), 'utf-8'));
            fs.writeFileSync(path.resolve(__dirname, '../data/jingjiaqiangchou/924.json'), JSON.stringify(stockData, null, 2));
            console.log('>>> 924 数据已更新');
            // 取消当前的定时器，新开一个 setTimeout，等待 60s 之后再读取一次 data/stockData.json，重新存储到 ../data/jingjiaqiangchouData/925.json
            clearInterval(intervalId);
            setTimeout(() => {
                const stockData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/stockData.json'), 'utf-8'));
                fs.writeFileSync(path.resolve(__dirname, '../data/jingjiaqiangchou/925.json'), JSON.stringify(stockData, null, 2), 'utf-8');
                console.log('>>> 925 数据已更新');
                // 分别读取 924.json 和 925.json 两个文件内容，进行对比，如果发现某个股票的涨幅 925 的涨幅要大于 924 的涨幅，就重新存储到 ../data/jingjiaqiangchouData/index.json
                const resultData = {};
                const data924 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/jingjiaqiangchou/924.json'), 'utf-8'));
                const data925 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/jingjiaqiangchou/925.json'), 'utf-8'));
                for (const code in data925) {
                   const value925 = data925[code];
                   const value924 = data924[code];
                   if (value925.kline[0].change > value924.kline[0].change) {
                       resultData[code] = value925;
                   }
                }
                fs.writeFileSync(path.resolve(__dirname, '../data/jingjiaqiangchou/index.json'), JSON.stringify(resultData, null, 2), 'utf-8');
                console.log('>>> 竞价抢筹数据已更新');
            }, 90000);
        }
    }, 1000);
    return intervalId;
}

const getJingJiaQiangChouData = async () => {
    // 是否存在 /data/jingjiaqiangchou/index.json 文件
    if (!fs.existsSync(path.resolve(__dirname, '../data/jingjiaqiangchou/index.json'))) {
        return null;
    }
    // 读取 /data/jingjiaqiangchou/index.json 文件内容
    const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/jingjiaqiangchou/index.json'), 'utf-8'));
    return Object.entries(data).map(([code, value]) => ({
        code,
        stockName: value.stockName,
        ...value.kline[0]
    }));
}

exports.pollJingJiaQiangChouData = pollJingJiaQiangChouData;
exports.getJingJiaQiangChouData = getJingJiaQiangChouData;
