// 东方财富的概念资金流入流出板块

const { getDFCFBlockMoneyUrl, sleep, getDFCFBlockMoneyIndustryUrl } = require('../utils');
const axios = require('axios');
const blockMoneyConfig = require('../constant/block_money');
const blockMoneyList = blockMoneyConfig.default;
const techBlockList = blockMoneyConfig.techBlockList;
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const blockMoneyPath = path.join(__dirname, '../data/blockMoneyChange.json');
const blockMoneyTimePath = path.join(__dirname, '../data/blockMoneyChangeTime.json');
const blockMoneyDayHistoryPath = path.join(__dirname, '../data/block_money_change_day_history.json');
const techBlockRatioPath = path.join(__dirname, '../data/tech_block_ratio.json');

const MAX_DAY_HISTORY = 90;


// 每隔 10s 轮询一次接口，将数据存储到本地的 src/data/blockMoneyChange.json 中
const pollDFCFBlockMoney = async (interval = 10000) => {
    setInterval(async () => {
        try {
            const res = await axios.get(getDFCFBlockMoneyUrl());
            const totalBlockMoneyChangeList = res.data.data.diff;
            const blockMoneyChangeList = totalBlockMoneyChangeList.filter(item => blockMoneyList.includes(item.f14));
            const result = blockMoneyChangeList.map(item => ({
                money: item.f62,
                block: item.f14,
                blockCode: item.f13 + '.' + item.f12,
                jumpUrl: `https://quote.eastmoney.com/center/gridlist.html#boards2-${item.f13 + '.' + item.f12}`,
            }));

            const res2 = await axios.get(getDFCFBlockMoneyIndustryUrl());
            const totalBlockMoneyIndustryChangeList = res2.data.data.diff;
            const industryBlockMoneyChangeList = totalBlockMoneyIndustryChangeList.filter(item => blockMoneyList.includes(item.f14));
            const industryResult = industryBlockMoneyChangeList.map(item => ({
                money: item.f62,
                block: item.f14,
                blockCode: item.f13 + '.' + item.f12,
                jumpUrl: `https://quote.eastmoney.com/center/gridlist.html#boards2-${item.f13 + '.' + item.f12}`,
            }));

            const filteredResult = [...result, ...industryResult];
            fs.writeFileSync(blockMoneyPath, JSON.stringify(filteredResult, null, 2));

            const allBlockData = [
                ...totalBlockMoneyChangeList.map(item => ({
                    money: item.f62,
                    block: item.f14,
                })),
                ...totalBlockMoneyIndustryChangeList.map(item => ({
                    money: item.f62,
                    block: item.f14,
                })),
            ];

            const totalMoney = allBlockData.reduce((sum, item) => sum + Math.abs(item.money || 0), 0);
            const techBlockMoney = allBlockData
                .filter(item => techBlockList.includes(item.block))
                .reduce((sum, item) => sum + Math.abs(item.money || 0), 0);
            const techRatio = totalMoney > 0 ? (techBlockMoney / totalMoney * 100) : 0;

            fs.writeFileSync(techBlockRatioPath, JSON.stringify({
                totalMoney,
                techBlockMoney,
                techRatio: parseFloat(techRatio.toFixed(2)),
                timestamp: Date.now(),
            }, null, 2));
        } catch (error) {
            console.error("轮询板块资金数据失败:", error.message);
        }
    }, interval);
};

// 10:00 之前每 30s 记录一次板块资金快照，10:00 之后每 3min 记录一次
const pollTimeDFCFBlockMoneyChange = (beforeInterval = 30000, afterInterval = 180000, switchHour = 10) => {
    const fetchAndSave = () => {
        const time = dayjs().format('HHmmss');
        const blockMoneyChangeData = JSON.parse(fs.readFileSync(blockMoneyPath, 'utf-8') || '[]');
        const data = fs.readFileSync(blockMoneyTimePath, 'utf-8') || '[]';
        const dataJson = JSON.parse(data);
        const result = {
            time,
            data: blockMoneyChangeData
        }
        dataJson.push(result);
        fs.writeFileSync(blockMoneyTimePath, JSON.stringify(dataJson));
    };

    // 根据当前时间决定轮询间隔：switchHour 前用 beforeInterval，之后用 afterInterval
    const getInterval = () => {
        const now = new Date();
        return now.getHours() < switchHour ? beforeInterval : afterInterval;
    };

    // 立即执行首次
    fetchAndSave();

    // 递归 setTimeout，支持动态切换间隔
    const scheduleNext = () => {
        setTimeout(() => {
            fetchAndSave();
            scheduleNext();
        }, getInterval());
    };
    scheduleNext();
};

const getBlockMoneyChangeList = () => {
    const prevContent = fs.readFileSync(blockMoneyPath, 'utf-8') || '[]';
    const prevContentJson = JSON.parse(prevContent);
    return prevContentJson;
};

const getBlockMoneyChangeTimeList = () => {
    const prevContent = fs.readFileSync(blockMoneyTimePath, 'utf-8') || '[]';
    const prevContentJson = JSON.parse(prevContent);
    return prevContentJson;
};

const getTechBlockRatio = () => {
    const content = fs.existsSync(techBlockRatioPath) ? (fs.readFileSync(techBlockRatioPath, 'utf-8') || '{}') : '{}';
    return JSON.parse(content);
};

// 读取按天维度的板块资金历史记录
const getBlockMoneyChangeDayHistory = () => {
    const content = fs.existsSync(blockMoneyDayHistoryPath) ? (fs.readFileSync(blockMoneyDayHistoryPath, 'utf-8') || '[]') : '[]';
    return JSON.parse(content);
};

// 收盘后把当日最新的板块资金数据写入按天维度的历史文件，最多保留近 90 天
const updateBlockMoneyChangeDayHistory = () => {
    const currentList = getBlockMoneyChangeList();
    if (!Array.isArray(currentList) || currentList.length === 0) {
        throw new Error('当日暂无板块资金数据，无法记录收盘历史');
    }

    const techBlockRatio = getTechBlockRatio();

    const dayHistory = getBlockMoneyChangeDayHistory();
    const today = dayjs().format('YYYYMMDD');
    const record = { 
        date: today, 
        data: currentList,
        techRatio: techBlockRatio.techRatio || 0,
        totalMoney: techBlockRatio.totalMoney || 0,
        techBlockMoney: techBlockRatio.techBlockMoney || 0,
    };

    // 同一天重复记录则覆盖
    const existingIndex = dayHistory.findIndex(item => item.date === today);
    if (existingIndex !== -1) {
        dayHistory[existingIndex] = record;
    } else {
        // 新数据放在最前面（从新到旧）
        dayHistory.unshift(record);
    }

    // 超过 90 天的最早数据剔除
    const trimmed = dayHistory.slice(0, MAX_DAY_HISTORY);

    fs.writeFileSync(blockMoneyDayHistoryPath, JSON.stringify(trimmed, null, 2));
    return record;
};

// 调度每日收盘后自动记录（默认 15:05），仅工作日执行，每分钟轮询检查
const scheduleBlockMoneyChangeDayHistory = (hour = 15, minute = 5) => {
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

        console.log('开始记录每日板块资金历史...', now.format('YYYY-MM-DD HH:mm:ss'));
        try {
            const record = updateBlockMoneyChangeDayHistory();
            console.log('每日板块资金历史记录完成:', record.date, '板块数:', record.data.length);
            executedDates.add(today); // 标记今天已执行
        } catch (e) {
            console.error('每日板块资金历史记录失败:', e.message);
        }
    };

    // 立即执行一次检查
    task();
    // 每分钟轮询检查
    setInterval(task, 60 * 1000);
    console.log(`每日板块资金历史记录已调度，超过 ${hour}:${String(minute).padStart(2, '0')} 且未记录时将自动执行`);
};

(async () => {
    await pollDFCFBlockMoney();
    sleep(50000);
})();

exports.pollDFCFBlockMoney = pollDFCFBlockMoney;
exports.getBlockMoneyChangeList = getBlockMoneyChangeList;
exports.pollTimeDFCFBlockMoneyChange = pollTimeDFCFBlockMoneyChange;
exports.getBlockMoneyChangeTimeList = getBlockMoneyChangeTimeList;
exports.getBlockMoneyChangeDayHistory = getBlockMoneyChangeDayHistory;
exports.updateBlockMoneyChangeDayHistory = updateBlockMoneyChangeDayHistory;
exports.scheduleBlockMoneyChangeDayHistory = scheduleBlockMoneyChangeDayHistory;
exports.getTechBlockRatio = getTechBlockRatio;
