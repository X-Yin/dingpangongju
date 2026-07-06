const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const { sleep } = require('../utils/index');

const amountPath = path.resolve(__dirname, '../data/amount.json');
const amountDayHistoryPath = path.resolve(__dirname, '../data/amount_day_history.json');
const currentDayHotBlockPath = path.resolve(__dirname, '../data/current_day_hot_block.json');

// 从带单位的字符串（如 "-873.55亿" / "+3216.55亿" / "1234.56万"）中解析出数值（单位：亿）
const parseAmountToYi = (str) => {
    if (!str) return 0;
    const isPositive = str.startsWith('+');
    const isNegative = str.startsWith('-');
    const valueStr = (isPositive || isNegative) ? str.slice(1) : str;
    const num = parseFloat(valueStr.replace(/亿|万/g, '')) || 0;
    if (valueStr.indexOf('万') !== -1) {
        // 万 -> 亿
        return (isNegative ? -1 : 1) * (num / 10000);
    }
    return (isNegative ? -1 : 1) * num;
};

// 获取成交量信息
const fetchAmountInfo = async () => {
    // 启动浏览器
    const browser = await puppeteer.launch({
        headless: 'new', // 无头模式，如需看到浏览器改为 false
        defaultViewport: null
    });
    const page = await browser.newPage();

    // 设置 User-Agent 模拟真实浏览器，防止被反爬拦截
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 设置较长的默认超时时间
    await page.setDefaultTimeout(60000);

    try {
        const url = 'https://gu.sina.cn/m/?vt=4#/index/index';
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 等待目标元素渲染完成
        await page.waitForSelector('.hq-stock-money', { timeout: 30000 });
        await sleep(1000);

        const result = await page.evaluate(() => {
            const element1 = document.querySelector('.hq-stock-money span.zhulivalue');
            const element2 = document.querySelector('.hq-stock-amount span.valfont');
            // 把页面上所有类名是 hot-topthree-item 并且内部有 h3 标签的元素都取出来
            const element3 = document.querySelectorAll('.hq-stock-section .hq-topthree-item.block a h3');
            const currentDayHotBlock = [];
            element3.forEach((item) => {
                currentDayHotBlock.push(item.innerText);
            });

            return {
                'mainMoney': element1 ? element1.innerText.trim() : null,
                'amountChangeDiff': element2 ? element2.innerText.trim() : null,
                'currentDayHotBlock': currentDayHotBlock.slice(0, 6),
            }
        });

        await browser.close();
        if (Math.abs(Number(parseFloat(result.mainMoney))) > 0 && Math.abs(Number(parseFloat(result.amountChangeDiff))) > 0) {
            //  const now = dayjs();
            // const isWeekend = now.isWeekend();
            // const isBefore930 = now.isBefore('09:30:00');
            // const isAfter1530 = now.isAfter('15:30:00');
            // if (isWeekend || isBefore930 || isAfter1530) {
            //     return;
            // }
            // amountData.push([dayjs().format('HHmmss'), result]);

            // // 保存到文件
            // fs.writeFileSync(amountPath, JSON.stringify(amountData, null, 2))
            return result;
        } else {
            throw new Error('成交量信息获取失败');
        }
    } catch (error) {
        console.error('抓取数据发生错误:', error.message);
        await browser.close();
        throw error;
    }
};

let num = 0;
const getAmountInfo = async () => {
    // num++;
    // return {"mainMoney": "-873.55亿","amountChangeDiff": "+" + (num * 1 + 3216.55) + "亿"}

    // 读取 amount.json 的文件，把最新的一条数据拿出来返回
    const amountData = fs.existsSync(amountPath) ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]') : [];
    return amountData?.[amountData.length - 1]?.[1];
}

const pollAmountInfo = async (interval = 1000 * 10) => {
    // 立即执行首次获取
    const fetchAndSave = async () => {
        try {
            const amountInfo = await fetchAmountInfo();
            // 先把文件中的内容读取出来，然后将当前的内容合并到文件中，文件中的内容是一个二维数组，数组中的每一项也是一个数组，第一个值 是当前的时间 DD:MM:SS，第二个值 是当前的成交量信息
            const amountData = fs.existsSync(amountPath) ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]') : [];
            // 判断如果是周六周日，或者是时间上小于上午九点半，或者是大于下午三点就不写入文件
            // const now = dayjs();
            // const isWeekend = now.isWeekend();
            // const isBefore930 = now.isBefore('09:30:00');
            // const isAfter1530 = now.isAfter('15:30:00');
            // if (isWeekend || isBefore930 || isAfter1530) {
            //     return;
            // }
            amountData.push([dayjs().format('HHmmss'), amountInfo]);

            // 保存到文件
            fs.writeFileSync(amountPath, JSON.stringify(amountData, null, 2));
            const { currentDayHotBlock } = amountInfo;
            fs.writeFileSync(currentDayHotBlockPath, JSON.stringify(currentDayHotBlock, null, 2));
        } catch (error) {
            console.error('轮询获取成交量信息失败，等待下一次轮询:', error.message);
        }
    };

    // 首次立即执行
    fetchAndSave();
    // 设置轮询
    setInterval(fetchAndSave, interval);
}

const getAmountHistory = () => {
    const data = fs.existsSync(amountPath) ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]') : [];
    // 过滤 data 这个二维数组中，每一项的第一项时间，重复的就只保留最新的
    const uniqueData = data.filter((item, index, arr) => arr.findIndex(t => t[0] === item[0]) === index);

    return uniqueData.map(i => {
        const { mainMoney, amountChangeDiff } = i[1];
        let updatedItem = { ...i[1] };
        
        if (mainMoney && mainMoney.indexOf('万') !== -1) {
            updatedItem.mainMoney = `${(parseFloat(mainMoney.replace('万', '')) / 10000).toFixed(2)}亿`;
        }
        
        if (amountChangeDiff && amountChangeDiff.indexOf('万') !== -1) {
            // 处理正负号
            const isPositive = amountChangeDiff.startsWith('+') || amountChangeDiff.startsWith('-');
            const sign = isPositive ? amountChangeDiff.charAt(0) : '';
            const valueStr = isPositive ? amountChangeDiff.slice(1) : amountChangeDiff;
            updatedItem.amountChangeDiff = `${sign}${(parseFloat(valueStr.replace('万', '')) / 10000).toFixed(2)}亿`;
        }
        
        return [i[0], updatedItem];
    });
}

// 读取每日收盘后的主力资金与成交量历史记录
const getAmountDayHistory = () => {
    const data = fs.existsSync(amountDayHistoryPath) ? JSON.parse(fs.readFileSync(amountDayHistoryPath, 'utf8') || '[]') : [];
    return data;
};

// 收盘后把当天的最新主力资金和成交量写入按天维度的历史文件
const updateAmountDayHistory = () => {
    const history = getAmountHistory();
    if (!history || history.length === 0) {
        throw new Error('当日暂无成交量数据，无法记录收盘历史');
    }
    // 取最新一条数据
    const latest = history[history.length - 1];
    const { mainMoney, amountChangeDiff } = latest[1];

    const dayHistory = getAmountDayHistory();
    const today = dayjs().format('YYYYMMDD');
    const record = {
        date: today,
        mainMoney: parseAmountToYi(mainMoney),
        amountChangeDiff: parseAmountToYi(amountChangeDiff),
        mainMoneyRaw: mainMoney,
        amountChangeDiffRaw: amountChangeDiff,
    };

    // 同一天重复记录则覆盖
    const existingIndex = dayHistory.findIndex(item => item.date === today);
    if (existingIndex !== -1) {
        dayHistory[existingIndex] = record;
    } else {
        // 新数据放在最前面，保持与 block_money_day_history 一致（从新到旧）
        dayHistory.unshift(record);
    }

    fs.writeFileSync(amountDayHistoryPath, JSON.stringify(dayHistory, null, 2));
    return record;
};

// 调度每日收盘后自动记录（默认 15:01），仅工作日执行，每分钟轮询检查
const scheduleAmountDayHistory = (hour = 15, minute = 1) => {
    // 记录已经执行过的日期，避免重复执行
    let executedDates = new Set();

    const task = () => {
        const now = dayjs();
        const today = now.format('YYYYMMDD');
        const dayOfWeek = now.day(); // 0 周日, 6 周六
        
        // 检查是否是周末
        if (dayOfWeek === 0 || dayOfWeek === 6) return;
        
        // 检查今天是否已经执行过
        if (executedDates.has(today)) return;
        
        // 检查是否超过截止时间
        const targetTime = now.hour(hour).minute(minute).second(0).millisecond(0);
        if (!now.isAfter(targetTime)) return;

        console.log('开始记录每日收盘主力资金与成交量...', now.format('YYYY-MM-DD HH:mm:ss'));
        try {
            const record = updateAmountDayHistory();
            console.log('每日收盘记录完成:', record);
            executedDates.add(today); // 标记今天已执行
        } catch (e) {
            console.error('每日收盘记录失败:', e.message);
        }
    };

    // 立即执行一次检查
    task();
    // 每分钟轮询检查
    setInterval(task, 60 * 1000);
    console.log(`每日收盘记录已调度，超过 ${hour}:${String(minute).padStart(2, '0')} 且未记录时将自动执行`);
};

// (async () => {
//     getAmountHistory();
// })();

exports.getAmountInfo = getAmountInfo;
exports.getAmountHistory = getAmountHistory;
exports.pollAmountInfo = pollAmountInfo;
exports.getAmountDayHistory = getAmountDayHistory;
exports.updateAmountDayHistory = updateAmountDayHistory;
exports.scheduleAmountDayHistory = scheduleAmountDayHistory;
