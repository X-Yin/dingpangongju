// 各板块（传媒/农业/消费/医药/电力/锂电池/存储芯片/光通信/液冷/pcb）成交额汇总计算
// 用途：读取 东方财富板块成分股汇总/{分类}.json 的成分股列表，
//       逐只请求同花顺日K拿成交额与收盘价，按天汇总后写入 category_amount_money_result.json；
//       若存在 {分类}_blocks.json（板块名 → 成分股明细），额外按子板块拆分成交额，
//       并计算每个子板块的近5日涨幅（等权平均成分股5日涨幅），写入 category_block_amount_result.json
//       （如 消费 的分拆子题材折线，前端按近5日涨幅取 Top5 展示）。
//       getBlockCategoryRatio 结合 amount_day_history.json（全市场总成交额）计算成交额占比，
//       结果按「时间范围」做内存缓存，run() 完成后自动失效，避免每次请求重复计算。
// 用法：
//   node category_amount_money.js              计算全部分类
//   node category_amount_money.js 传媒 农业     只计算指定分类
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getThsKlineUrl, getThsKlineHeaders, buildThsKlineRequestBody, timestampToDateStr } = require('../../utils');

const OUTPUT_FILE = path.resolve(__dirname, 'category_amount_money_result.json');
const BLOCK_OUTPUT_FILE = path.resolve(__dirname, 'category_block_amount_result.json');
const CONSTITUENTS_DIR = path.resolve(__dirname, '../../data/东方财富板块成分股汇总');
const AMOUNT_DAY_HISTORY_FILE = path.resolve(__dirname, '../../data/amount_day_history.json');

const defaultStartDate = '2026-04-01';
const defaultEndDate = dayjs().format('YYYY-MM-DD');

// 需要计算成交额占比的分类（与 东方财富板块成分股汇总 目录下 {分类}.json 对应）
const CATEGORY_NAMES = ['传媒', '农业', '消费', '医药', '电力', '锂电池', '存储芯片', '光通信', '液冷', 'pcb', '半导体'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 获取单只股票的日K成交额与收盘价（与 科技板块拥挤度计算/block_amount_money.js 同一数据源）
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
                close: item[4], // 收盘价，用于计算子板块近5日涨幅
            });
        }

        return result;
    } catch (error) {
        console.error(`获取股票 ${code} K线数据失败:`, error.message);
        return [];
    }
};

// 拉取一个分类下所有股票并按天汇总成交额；同时返回每只股票的按天成交额与收盘价明细，供子板块拆分复用
const fetchCategoryMoney = async (categoryName, stocks, startDate, endDate) => {
    const moneyByDate = {};
    const stockAmounts = {}; // code → { date: amount }
    const stockCloses = {}; // code → { date: close }
    const endDateStr = String(endDate).replace(/-/g, '');

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        console.log(`  [${categoryName}] 获取股票 ${i + 1}/${stocks.length}: ${stock.code} ${stock.name}`);

        const klineData = await fetchStockKline(stock.code, startDate);

        const amountsByDate = {};
        const closesByDate = {};
        for (const item of klineData) {
            const amount = parseFloat(item.amount);
            const close = parseFloat(item.close);
            if (item.date && !isNaN(amount) && amount > 0 && item.date <= endDateStr) {
                amountsByDate[item.date] = amount;
                moneyByDate[item.date] = (moneyByDate[item.date] || 0) + amount;
            }
            if (item.date && !isNaN(close) && close > 0) {
                closesByDate[item.date] = close;
            }
        }
        stockAmounts[stock.code] = amountsByDate;
        stockCloses[stock.code] = closesByDate;

        await sleep(100);
    }

    const rows = Object.keys(moneyByDate)
        .sort((a, b) => a.localeCompare(b))
        .map((date) => ({ date, money: moneyByDate[date] }));

    return { rows, stockAmounts, stockCloses };
};

// 汇总一个子板块下所有股票的按天成交额
const sumBlockMoney = (blockStocks, stockAmounts) => {
    const moneyByDate = {};
    for (const stock of blockStocks || []) {
        const amountsByDate = stockAmounts[stock.code] || {};
        for (const [date, amount] of Object.entries(amountsByDate)) {
            moneyByDate[date] = (moneyByDate[date] || 0) + amount;
        }
    }
    return Object.keys(moneyByDate)
        .sort((a, b) => a.localeCompare(b))
        .map((date) => ({ date, money: moneyByDate[date] }));
};

// 计算一个子板块的近5日涨幅序列（等权平均成分股的5日涨幅，5个交易日收盘价对比）
const computeBlockGain5 = (blockStocks, stockCloses) => {
    const gainByDate = {}; // date → [各成分股5日涨幅]
    for (const stock of blockStocks || []) {
        const closesByDate = stockCloses[stock.code] || {};
        const dates = Object.keys(closesByDate).sort((a, b) => a.localeCompare(b));
        for (let i = 5; i < dates.length; i++) {
            const prevClose = closesByDate[dates[i - 5]];
            const close = closesByDate[dates[i]];
            if (prevClose > 0 && close > 0) {
                const gain = (close / prevClose - 1) * 100;
                if (!gainByDate[dates[i]]) gainByDate[dates[i]] = [];
                gainByDate[dates[i]].push(gain);
            }
        }
    }
    const result = {};
    for (const [date, gains] of Object.entries(gainByDate)) {
        if (!gains.length) continue;
        result[date] = gains.reduce((sum, g) => sum + g, 0) / gains.length;
    }
    return result;
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

    let blockResult = {};
    if (fs.existsSync(BLOCK_OUTPUT_FILE)) {
        try {
            blockResult = JSON.parse(fs.readFileSync(BLOCK_OUTPUT_FILE, 'utf-8'));
        } catch (e) {
            console.error('读取已有子板块结果文件失败，将重新生成:', e.message);
            blockResult = {};
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

        const { rows, stockAmounts, stockCloses } = await fetchCategoryMoney(name, stocks, startDate, endDate);
        result[name] = rows;

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
        console.log(`[完成] ${name}: ${rows.length} 天数据已写入`);

        // 若存在板块明细文件，则按子板块拆分成交额（复用上面已拉取的股票日K数据，不重复请求）
        const blocksFile = path.join(CONSTITUENTS_DIR, `${name}_blocks.json`);
        if (fs.existsSync(blocksFile)) {
            const blocksMap = JSON.parse(fs.readFileSync(blocksFile, 'utf-8'));
            const blockRows = Object.entries(blocksMap).map(([blockName, blockStocks]) => {
                const moneyRows = sumBlockMoney(blockStocks, stockAmounts);
                const gain5ByDate = computeBlockGain5(blockStocks, stockCloses);
                return {
                    blockName,
                    data: moneyRows.map((row) => ({
                        ...row,
                        gain5: gain5ByDate[row.date] !== undefined ? Number(gain5ByDate[row.date].toFixed(4)) : null,
                    })),
                };
            });
            blockResult[name] = blockRows;

            fs.writeFileSync(BLOCK_OUTPUT_FILE, JSON.stringify(blockResult, null, 2), 'utf-8');
            console.log(`[完成] ${name} 子板块拆分（${blockRows.length} 个板块）已写入`);
        }
    }

    ratioCache = null; // 数据已更新，清空内存缓存，下次请求重新计算并缓存

    console.log(`\n===== 全部完成: ${OUTPUT_FILE} =====`);
    return result;
};

// 占比结果内存缓存（按时间范围），run() 完成后失效，避免每次请求重复计算
let ratioCache = null;

// 将按天成交额序列换算为占比序列（分类成交额 / 全市场总成交额，与 getTechBlockCrowd 口径一致）
const buildRatioRows = (moneyRows, totalAmountMap, start, end) => {
    const rows = [];
    for (const item of moneyRows || []) {
        const date = String(item.date);
        if (start && date < start) continue;
        if (end && date > end) continue;

        const totalAmountYi = totalAmountMap.get(date);
        if (totalAmountYi === undefined || !isFinite(totalAmountYi) || totalAmountYi <= 0) continue;

        const money = Number(item.money);
        if (!isFinite(money) || money <= 0) continue;

        const ratio = (money / (totalAmountYi * 1e8)) * 100;
        const row = {
            date,
            ratio: Number(ratio.toFixed(4)),
            money,
            totalAmount: totalAmountYi,
        };
        // 子板块数据附带近5日涨幅（%）
        if (item.gain5 !== undefined && item.gain5 !== null && isFinite(Number(item.gain5))) {
            row.gain5 = Number(item.gain5);
        }
        rows.push(row);
    }
    return rows;
};

// 读取成交额数据并计算占比；子板块拆分数据以「{分类}_blocks」键附加在返回值中
const getBlockCategoryRatio = (startDate, endDate) => {
    const cacheKey = `${startDate || ''}|${endDate || ''}`;
    if (ratioCache && ratioCache.key === cacheKey) {
        return ratioCache.data;
    }

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
        result[name] = buildRatioRows(list, totalAmountMap, start, end);
    }

    // 子板块拆分（如 消费 的分拆子题材）
    if (fs.existsSync(BLOCK_OUTPUT_FILE)) {
        try {
            const blockMoney = JSON.parse(fs.readFileSync(BLOCK_OUTPUT_FILE, 'utf-8'));
            for (const [name, blocks] of Object.entries(blockMoney)) {
                if (!Array.isArray(blocks)) continue;
                result[`${name}_blocks`] = blocks.map((block) => ({
                    blockName: block.blockName,
                    data: buildRatioRows(block.data, totalAmountMap, start, end),
                }));
            }
        } catch (e) {
            console.error('读取子板块成交额数据失败:', e.message);
        }
    }

    ratioCache = { key: cacheKey, data: result };
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
