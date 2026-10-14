// 各板块（传媒/农业/消费/医药/电力）成交额汇总计算
// 用途：读取 东方财富板块成分股汇总/{分类}.json 的成分股列表，
//       逐只请求同花顺日K拿成交额，按天汇总后写入 category_amount_money_result.json，
//       再由 getBlockCategoryRatio 结合 amount_day_history.json（全市场总成交额）计算成交额占比。
// 用法：
//   node category_amount_money.js              计算全部分类
//   node category_amount_money.js 传媒 农业     只计算指定分类
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getThsKlineUrl, getThsKlineHeaders, buildThsKlineRequestBody, timestampToDateStr } = require('../../utils');

const OUTPUT_FILE = path.resolve(__dirname, 'category_amount_money_result.json');
const CONSTITUENTS_DIR = path.resolve(__dirname, '../../data/东方财富板块成分股汇总');
const AMOUNT_DAY_HISTORY_FILE = path.resolve(__dirname, '../../data/amount_day_history.json');

const defaultStartDate = '2026-04-01';
const defaultEndDate = dayjs().format('YYYY-MM-DD');

// 需要计算成交额占比的分类（与 东方财富板块成分股汇总 目录下 {分类}.json 对应）
const CATEGORY_NAMES = ['传媒', '农业', '消费', '医药', '电力'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 获取单只股票的日K成交额（与 科技板块拥挤度计算/block_amount_money.js 同一数据源）
const fetchStockKline = async (code, startDate) => {
    if (!code) return [];

    const codeStr = String(code);
    const pureCode = codeStr.replace(/^[a-zA-Z]+/, '');

    const start = dayjs(startDate);
    const end = dayjs();
    const daysDiff = end.diff(start, 'day');
    const limit = Math.max(daysDiff + 60, 120);

    try {
        const url = getThsKlineUrl();
        const headers = getThsKlineHeaders();
        const requestBody = buildThsKlineRequestBody(pureCode, limit);

        const response = await axios.post(url, requestBody, { headers });

        if (response.data.status_code !== 0) {
            console.error(`同花顺API返回错误状态码: ${response.data.status_code}`);
            return [];
        }

        const quoteData = response.data.data.quote_data;
        if (!quoteData || quoteData.length === 0) {
            return [];
        }

        const valueArray = quoteData[0].value;
        if (!valueArray || !Array.isArray(valueArray) || valueArray.length === 0) {
            return [];
        }

        const result = [];
        for (let i = 0; i < valueArray.length; i++) {
            const item = valueArray[i];
            if (item.length < 7) continue;
            result.push({
                date: timestampToDateStr(item[0]),
                amount: item[6],
            });
        }

        return result;
    } catch (error) {
        console.error(`获取股票 ${code} K线数据失败:`, error.message);
        return [];
    }
};

// 拉取一个分类下所有股票并按天汇总成交额
const fetchCategoryMoney = async (categoryName, stocks, startDate, endDate) => {
    const moneyByDate = {};
    const endDateStr = String(endDate).replace(/-/g, '');

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        console.log(`  [${categoryName}] 获取股票 ${i + 1}/${stocks.length}: ${stock.code} ${stock.name}`);

        const klineData = await fetchStockKline(stock.code, startDate);

        for (const item of klineData) {
            const amount = parseFloat(item.amount);
            if (item.date && !isNaN(amount) && amount > 0 && item.date <= endDateStr) {
                moneyByDate[item.date] = (moneyByDate[item.date] || 0) + amount;
            }
        }

        await sleep(100);
    }

    return Object.keys(moneyByDate)
        .sort((a, b) => a.localeCompare(b))
        .map((date) => ({ date, money: moneyByDate[date] }));
};

// 拉取并更新各分类成交额数据（每个分类完成即落盘，支持中断后续跑）
const run = async (startDate = defaultStartDate, endDate = defaultEndDate, categoryNames = CATEGORY_NAMES) => {
    console.log(`\n===== 开始获取板块成交额数据 =====`);
    console.log(`时间范围: ${startDate} ~ ${endDate}`);
    console.log(`分类列表: ${categoryNames.join(', ')}\n`);

    let result = {};
    if (fs.existsSync(OUTPUT_FILE)) {
        try {
            result = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
        } catch (e) {
            console.error('读取已有结果文件失败，将重新生成:', e.message);
            result = {};
        }
    }

    for (const name of categoryNames) {
        const constituentsFile = path.join(CONSTITUENTS_DIR, `${name}.json`);
        if (!fs.existsSync(constituentsFile)) {
            console.warn(`[warn] 成分股文件不存在，跳过分类「${name}」: ${constituentsFile}`);
            continue;
        }

        const stocks = JSON.parse(fs.readFileSync(constituentsFile, 'utf-8'));
        console.log(`\n--- 分类：${name}（${stocks.length} 只股票）---`);

        result[name] = await fetchCategoryMoney(name, stocks, startDate, endDate);

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
        console.log(`[完成] ${name}: ${result[name].length} 天数据已写入`);
    }

    console.log(`\n===== 全部完成: ${OUTPUT_FILE} =====`);
    return result;
};

// 读取成交额数据并计算占比（分类成交额 / 全市场总成交额，与 getTechBlockCrowd 口径一致）
const getBlockCategoryRatio = (startDate, endDate) => {
    if (!fs.existsSync(OUTPUT_FILE)) {
        throw new Error('category_amount_money_result.json 不存在，请先点击刷新按钮生成数据');
    }
    if (!fs.existsSync(AMOUNT_DAY_HISTORY_FILE)) {
        throw new Error('amount_day_history.json 不存在');
    }

    const categoryMoney = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    const amountDayHistory = JSON.parse(fs.readFileSync(AMOUNT_DAY_HISTORY_FILE, 'utf-8'));

    const totalAmountMap = new Map();
    for (const item of amountDayHistory) {
        if (item && item.date && item.totalAmount !== undefined && item.totalAmount !== null) {
            totalAmountMap.set(String(item.date), Number(item.totalAmount));
        }
    }

    const start = startDate ? String(startDate).replace(/-/g, '') : null;
    const end = endDate ? String(endDate).replace(/-/g, '') : null;

    const result = {};
    for (const [name, list] of Object.entries(categoryMoney)) {
        if (!Array.isArray(list)) continue;
        const rows = [];
        for (const item of list) {
            const date = String(item.date);
            if (start && date < start) continue;
            if (end && date > end) continue;

            const totalAmountYi = totalAmountMap.get(date);
            if (totalAmountYi === undefined || !isFinite(totalAmountYi) || totalAmountYi <= 0) continue;

            const money = Number(item.money);
            if (!isFinite(money) || money <= 0) continue;

            const ratio = (money / (totalAmountYi * 1e8)) * 100;
            rows.push({
                date,
                ratio: Number(ratio.toFixed(4)),
                money,
                totalAmount: totalAmountYi,
            });
        }
        result[name] = rows;
    }

    return result;
};

exports.run = run;
exports.getBlockCategoryRatio = getBlockCategoryRatio;
exports.CATEGORY_NAMES = CATEGORY_NAMES;
exports.categoryRatioStartDate = defaultStartDate;
exports.categoryRatioEndDate = defaultEndDate;

if (require.main === module) {
    const args = process.argv.slice(2);
    const categoryNames = args.length ? args : CATEGORY_NAMES;
    run(defaultStartDate, defaultEndDate, categoryNames).catch((error) => {
        console.error('脚本执行失败:', error);
        process.exitCode = 1;
    });
}
