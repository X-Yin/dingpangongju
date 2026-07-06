    // 股票持仓服务
const { getClsReqMainFundUrl, getDFCFStockTlineDay2Url, getClsReqStockTlineDay5Url, getClsReqStockTlineUrl } = require('../utils');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const stock_position_path = path.resolve(__dirname, '../data/stock_position.json');
const stock_position_fund_flow_path = path.resolve(__dirname, '../data/stock_position_fund_flow.json');

// 检查当前是否为交易时间（周一至周五 9:25 - 15:05）
const isTradingTime = () => {
    const now = dayjs();
    const day = now.day();
    if (day === 0 || day === 6) return false;
    const cur = now.hour() * 60 + now.minute();
    return cur >= 9 * 60 + 25 && cur <= 15 * 60 + 5;
};

// 读取资金流向全部数据
const readFundFlowData = () => {
    try {
        return JSON.parse(fs.readFileSync(stock_position_fund_flow_path, 'utf8')) || {};
    } catch (e) {
        return {};
    }
};

// 轮询持仓股票的主力资金净流入数据，每分钟保存一次
const pollStockPositionFundFlow = (interval = 60000) => {
    const lastRecordMinuteRef = { date: '', minute: '' };
    const task = async () => {
        if (!isTradingTime()) return;
        const stock_positions = JSON.parse(fs.readFileSync(stock_position_path, 'utf8')) || [];
        if (stock_positions.length === 0) return;

        const now = dayjs();
        const today = now.format('YYYYMMDD');
        const time = now.format('HHmmss');
        const minuteKey = now.format('HHmm');
        // 同一分钟内不重复记录
        if (lastRecordMinuteRef.date === today && lastRecordMinuteRef.minute === minuteKey) return;
        lastRecordMinuteRef.date = today;
        lastRecordMinuteRef.minute = minuteKey;

        const allData = readFundFlowData();
        if (!allData[today]) allData[today] = {};

        for (const item of stock_positions) {
            try {
                const mainFundUrl = getClsReqMainFundUrl(item.code);
                const tlineUrl = getClsReqStockTlineUrl(item.code);
                
                // 同时获取主力资金和分时数据
                const [fundRes, tlineRes] = await Promise.all([
                    axios.get(mainFundUrl),
                    axios.get(tlineUrl)
                ]);

                const mainFundDiff = fundRes.data.data.main_fund_diff;
                const mainFund = Number((mainFundDiff / 100000000).toFixed(2));
                
                // 获取最新涨幅
                const line = tlineRes.data?.data?.line || [];
                const latestTline = line[line.length - 1];
                const change = latestTline ? latestTline.change : null;

                if (!allData[today][item.code]) allData[today][item.code] = [];
                allData[today][item.code].push({ 
                    time, 
                    mainFund,
                    change // 记录当前涨幅
                });
            } catch (error) {
                console.error(`记录 ${item.name} 数据失败:`, error.message);
            }
        }

        fs.writeFileSync(stock_position_fund_flow_path, JSON.stringify(allData, null, 2));
    };

    task();
    setInterval(task, interval);
};

// 获取某只股票当日（或指定日期）的资金净流入流出时间序列
const getStockPositionFundFlow = (code, date) => {
    const allData = readFundFlowData();
    const targetDate = date || dayjs().format('YYYYMMDD');
    const dayData = allData[targetDate] || {};
    return dayData[code] || [];
};

const addStockPosition = (code, name) => {
    try {
        const stock_positions = JSON.parse(fs.readFileSync(stock_position_path, 'utf8')) || [];
        // 已存在则不重复添加
        if (stock_positions.some(item => item.code === code)) {
            return false;
        }
        stock_positions.push({ code, name });
        fs.writeFileSync(stock_position_path, JSON.stringify(stock_positions, null, 2));
        return true;
    } catch (error) {
        console.error('添加持仓失败:', error);
        return false;
    }
};

const deleteStockPosition = (code) => {
    try {
        const stock_positions = JSON.parse(fs.readFileSync(stock_position_path, 'utf8')) || [];
        const filtered = stock_positions.filter(item => item.code !== code);
        fs.writeFileSync(stock_position_path, JSON.stringify(filtered, null, 2));
        return filtered.length !== stock_positions.length;
    } catch (error) {
        console.error('删除持仓失败:', error);
        return false;
    }
};

const getStockPositionMainFund = async () => {
    // 先把所有股票持仓都获取到
    const stock_positions = JSON.parse(fs.readFileSync(stock_position_path, 'utf8')) || [];
    // 遍历所有股票持仓，分别请求财联社接口返回数据
    const result = [];
    for (const item of stock_positions) {
        try {
            const mainFundData = getClsReqMainFundUrl(item.code);
            const res = await axios.get(mainFundData);
            const mainFundDiff = res.data.data.main_fund_diff;
            result.push({
                code: item.code,
                name: item.name,
                mainFund: (mainFundDiff / 100000000).toFixed(2)
            });
        } catch (error) {
            console.error(`获取 ${item.name} 主力资金失败:`, error.message);
            result.push({
                code: item.code,
                name: item.name,
                mainFund: null
            });
        }
    }

    return result;
};

const diff2DayStockTline = async () => {
    // 先把所有股票持仓都获取到
    const stock_positions = JSON.parse(fs.readFileSync(stock_position_path, 'utf8')) || [];
    // 遍历所有股票持仓，分别请求东方财富接口返回数据
    const result = [];
    for (const item of stock_positions) {
        try {
            const tlineData = getClsReqStockTlineDay5Url(item.code);
            const res = await axios.get(tlineData);
            const tline = res.data.data.line;
            // 按日期分组，提取所有不重复的日期并排序
            const dates = [...new Set(tline.map(item => item.date))].sort((a, b) => a - b);
            // 最新一天和倒数第二天
            const latestDate = dates[dates.length - 1];
            const prevDate = dates[dates.length - 2];
            // 取出最新一天和倒数第二天的所有分时数据
            const latestDayLine = tline.filter(item => item.date === latestDate);
            const prevDayLine = tline.filter(item => item.date === prevDate);
            // 取今日分时最后一条数据的时刻作为基准时刻（HHMM 格式）
            const currentMinute = latestDayLine.length > 0
                ? latestDayLine[latestDayLine.length - 1].minute
                : 0;
            // 累计今天当前时刻之前（含）的所有成交量
            const todayTotal = latestDayLine
                .filter(line => line.minute <= currentMinute)
                .reduce((sum, line) => sum + (line.business_amount || 0), 0);
            // 累计前一交易日同一时刻之前（含）的所有成交量
            const prevTotal = prevDayLine
                .filter(line => line.minute <= currentMinute)
                .reduce((sum, line) => sum + (line.business_amount || 0), 0);
            // 量能差值及百分比（相较前一交易日同时刻）
            const volumeDiff = todayTotal - prevTotal;
            const volumeDiffPercent = prevTotal !== 0
                ? Number(((volumeDiff / prevTotal) * 100).toFixed(2))
                : 0;
            result.push({
                code: item.code,
                name: item.name,
                volumeDiffPercent
            });
        } catch (error) {
            console.error(`获取 ${item.name} 五日分时失败:`, error.message);
        }
    }
    return result;
};

module.exports = {
    addStockPosition,
    deleteStockPosition,
    getStockPositionMainFund,
    diff2DayStockTline,
    pollStockPositionFundFlow,
    getStockPositionFundFlow
};
