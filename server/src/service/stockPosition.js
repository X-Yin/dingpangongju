// 股票持仓服务
const { getClsReqMainFundUrl, getDFCFStockTlineDay2Url } = require('../utils');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const stock_position_path = path.resolve(__dirname, '../data/stock_position.json');

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

const handleStockTline = (tlineStr) => {
    tlineStr = tlineStr.split(",");
    const timeStr = tlineStr[0];
    const amount = tlineStr[5];
    const totalMoney = tlineStr[6];
    return {
        time: {
            date: timeStr.split(" ")[0],
            hourMin: timeStr.split(" ")[1]
        },
        amount,
        totalMoney
    };
};

const diff2DayStockTline = async () => {
    // 先把所有股票持仓都获取到
    const stock_positions = JSON.parse(fs.readFileSync(stock_position_path, 'utf8')) || [];
    // 遍历所有股票持仓，分别请求东方财富接口返回数据
    const result = [];
    const browser = await puppeteer.launch({
        headless: 'new',
        defaultViewport: null,
    });
    try {
        for (const item of stock_positions) {
            try {
                const tlineUrl = getDFCFStockTlineDay2Url(item.code);
                const page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.goto(tlineUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // 获取 body 下的 pre 元素中的文本（浏览器会把纯文本响应渲染到 <pre> 中）
                const htmlStr = await page.evaluate(() => {
                    return document.body.querySelector('pre')?.textContent || '';
                });
                await page.close();

                console.log(htmlStr);

                const reg = /^[\w]+\(([\s\S]*)\);?$/;

                // 提取 JSONP 格式中的 JSON 字符串
                const match = htmlStr.match(reg);
                if (!match || !match[1]) {
                    continue;
                }
                const jsonText = match[1];
                const data = JSON.parse(jsonText)?.data?.trends || [];
                const lastestData = handleStockTline(data[data.length - 1] || '');
                const yesterdayFinalIndex = data.findIndex(i => handleStockTline(i).time.hourMin === lastestData.time.hourMin);
                let yesterdayTotalAmount = 0;
                for (let i = yesterdayFinalIndex; i >= 0; i--) {
                    yesterdayTotalAmount += Number(data[i].amount);
                }

                const todayStartIndex = data.findIndex(i => {
                    const tline = handleStockTline(i);
                    return tline.time.hourMin === '09:30' && tline.time.date === lastestData.time.date;
                });
                let todayTotalAmount = 0;
                for (let i = todayStartIndex; i < data.length; i++) {
                    todayTotalAmount += Number(data[i].amount);
                }
                const amountDiffPercent = ((todayTotalAmount - yesterdayTotalAmount) / yesterdayTotalAmount * 100).toFixed(2) + '%';
                result.push({
                    code: item.code,
                    name: item.name,
                    amountDiffPercent
                });
            } catch (error) {
                console.error(`获取 ${item.name} 分时数据失败:`, error.message);
            }
        }
    } finally {
        await browser.close();
    }
    return result;
};

module.exports = {
    addStockPosition,
    deleteStockPosition,
    getStockPositionMainFund
};
