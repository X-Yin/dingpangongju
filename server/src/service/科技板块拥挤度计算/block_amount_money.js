const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const puppeteer = require('puppeteer');
const { techBlockMap } = require('../../constant/block_money');
const { getThsKlineUrl, getThsKlineHeaders, buildThsKlineRequestBody, timestampToDateStr } = require('../../utils');

const OUTPUT_FILE = path.resolve(__dirname, 'block_amount_money_result.json');
const STOCK_CODE_FILE = path.resolve(__dirname, 'all_tech_stock_code.json');

const defaultStartDate = '2026-04-01';
const defaultEndDate = dayjs().format('YYYY-MM-DD');

const parseJsonp = (jsonpString) => {
    const match = jsonpString.match(/^[^(]*\((.*)\);?$/);
    if (match && match[1]) {
        return JSON.parse(match[1]);
    }
    return null;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchBlockStocks = async (blockCode) => {
    console.log(`正在获取板块 ${blockCode} 的股票列表...`);
    const allStocks = [];
    let browser = null;
    let page = null;

    try {
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,800',
            ],
            defaultViewport: { width: 1280, height: 800 },
        });

        page = await browser.newPage();
        await page.setCacheEnabled(false);
        await page.setDefaultTimeout(60000);
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');

        const url = `https://data.eastmoney.com/bkzj/${blockCode}.html`;
        console.log(`  打开页面: ${url}`);

        let totalPages = 1;
        let currentPage = 1;
        const collectedStockCodes = new Set();

        const collectPageData = async () => {
            return new Promise((resolve) => {
                const handler = async (response) => {
                    const responseUrl = response.url();
                    if (responseUrl.includes('push2.eastmoney.com/api/qt/clist/get') && responseUrl.includes(`fs=b%3A${blockCode}`)) {
                        console.log(`    截获到响应: ${responseUrl.substring(0, 80)}...`);
                        try {
                            const text = await response.text();
                            const data = parseJsonp(text);
                            if (data && data.data && data.data.diff) {
                                totalPages = Math.ceil((data.data.total || 0) / 50);
                                const stocks = data.data.diff.map(item => ({
                                    code: item.f12,
                                    name: item.f14,
                                }));

                                let newCount = 0;
                                for (const stock of stocks) {
                                    const key = `${stock.code}_${stock.name}`;
                                    if (!collectedStockCodes.has(key)) {
                                        collectedStockCodes.add(key);
                                        allStocks.push(stock);
                                        newCount++;
                                    }
                                }
                                console.log(`    第 ${currentPage} 页获取到 ${newCount} 只新股票，累计 ${allStocks.length} 只，共 ${totalPages} 页`);
                            }
                        } catch (e) {
                            console.error(`    解析第 ${currentPage} 页数据失败:`, e.message);
                        }

                        page.off('response', handler);
                        resolve();
                    }
                };

                page.on('response', handler);

                setTimeout(() => {
                    page.off('response', handler);
                    resolve();
                }, 15000);
            });
        };

        const firstCollectPromise = collectPageData();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await firstCollectPromise;

        await sleep(3000);
        currentPage++;

        while (currentPage <= totalPages) {
            console.log(`  获取第 ${currentPage} 页数据...`);

            try {
                await page.waitForSelector('.dataview-pagination .pagerbox', { timeout: 10000 });

                const nextPageNum = await page.evaluate(() => {
                    const pagination = document.querySelector('.dataview-pagination .pagerbox');
                    if (!pagination) return null;
                    const links = pagination.querySelectorAll('a');
                    const nextLink = links[links.length - 1];
                    if (!nextLink || nextLink.textContent.trim() !== '下一页') {
                        return null;
                    }
                    return nextLink.getAttribute('data-page');
                });

                if (!nextPageNum || parseInt(nextPageNum) > totalPages) {
                    console.log('    已到达最后一页或未找到下一页按钮');
                    break;
                }

                console.log(`    点击下一页，目标页码: ${nextPageNum}`);

                const collectPromise = collectPageData();

                await page.evaluate(() => {
                    const pagination = document.querySelector('.dataview-pagination .pagerbox');
                    if (!pagination) return;
                    const links = pagination.querySelectorAll('a');
                    const nextLink = links[links.length - 1];
                    if (nextLink && nextLink.textContent.trim() === '下一页') {
                        nextLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        setTimeout(() => {
                            nextLink.click();
                        }, 500);
                    }
                });

                await collectPromise;
                await sleep(1000);
                currentPage++;
            } catch (e) {
                console.error(`    点击下一页失败:`, e.message);
                break;
            }
        }

        await page.close();
    } catch (error) {
        console.error(`获取板块 ${blockCode} 股票列表失败:`, error.message);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
        if (page && !page.isClosed()) {
            try { await page.close(); } catch (e) { }
        }
    }

    const filtered = allStocks.filter(stock => {
        const code = stock.code || '';
        return code.startsWith('3') || code.startsWith('6') || code.startsWith('0');
    });

    console.log(`  过滤后（3/6/0开头）: ${filtered.length} 只股票`);

    return filtered;
};

const fetchStockKline = async (code, startDate) => {
    if (!code) {
        console.error('股票代码为空');
        return [];
    }
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

const generateDateRange = (startDate, endDate) => {
    console.log(`生成日期范围: ${startDate} ~ ${endDate}`);
    const dates = [];
    let current = dayjs(startDate);
    const end = dayjs(endDate);

    while (current.isBefore(end) || current.isSame(end)) {
        dates.push(current.format('YYYYMMDD'));
        current = current.add(1, 'day');
    }

    return dates;
};

const loadStockProgress = () => {
    if (fs.existsSync(STOCK_CODE_FILE)) {
        try {
            const content = fs.readFileSync(STOCK_CODE_FILE, 'utf-8');
            return JSON.parse(content);
        } catch (e) {
            console.error('读取进度文件失败:', e.message);
        }
    }
    return { stocks: [], completedBlocks: [] };
};

const saveStockProgress = (stocks, completedBlocks) => {
    const data = {
        stocks,
        completedBlocks,
        updateTime: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    };
    fs.writeFileSync(STOCK_CODE_FILE, JSON.stringify(data, null, 2), 'utf-8');
};

const run = async (startDate = defaultStartDate, endDate = defaultEndDate, needCollectBlock = false) => {
    console.log(`\n===== 开始获取科技板块总成交金额数据 =====`);
    console.log(`时间范围: ${startDate} ~ ${endDate}`);
    console.log(`板块列表: ${techBlockMap.map(b => `${b.name}(${b.code})`).join(', ')}\n`);

    const dateRange = generateDateRange(startDate, endDate);

    let stocksArray = [];
    if (needCollectBlock) {
        console.log('needCollectBlock=true，将清空 completedBlocks 后重新拉取所有板块');
        resetProgress();
        const progress = loadStockProgress();
        const allStocksMap = new Map();
        for (const stock of progress.stocks) {
            allStocksMap.set(stock.code, stock.name);
        }

        console.log(`  已完成板块: ${progress.completedBlocks.length} 个`);
        console.log(`  已收集股票: ${allStocksMap.size} 只`);

        for (const block of techBlockMap) {
            if (progress.completedBlocks.includes(block.code)) {
                console.log(`\n--- 跳过已完成板块: ${block.name} (${block.code}) ---`);
                continue;
            }

            console.log(`\n--- 获取板块: ${block.name} (${block.code}) ---`);
            const stocks = await fetchBlockStocks(block.code);

            let newCount = 0;
            for (const stock of stocks) {
                if (!allStocksMap.has(stock.code)) {
                    allStocksMap.set(stock.code, stock.name);
                    newCount++;
                }
            }
            console.log(`  新增 ${newCount} 只股票，去重后总计 ${allStocksMap.size} 只`);

            progress.completedBlocks.push(block.code);
            const stocksArray = Array.from(allStocksMap.entries()).map(([code, name]) => ({ code, name }));
            saveStockProgress(stocksArray, progress.completedBlocks);
            console.log(`  进度已保存，已完成 ${progress.completedBlocks.length}/${techBlockMap.length} 个板块`);
        }

        console.log(`\n--- 所有板块股票汇总完成，共 ${allStocksMap.size} 只 ---`);
        stocksArray = stocksArray.filter(stock => progress.completedBlocks.includes(stock.code));
    } else {
        stocksArray = JSON.parse(fs.readFileSync(STOCK_CODE_FILE, 'utf-8')).stocks;
    }

    const techTotalMoneyByDate = {};

    for (let i = 0; i < stocksArray.length; i++) {
        const stock = stocksArray[i];
        console.log(`\n  获取股票 ${i + 1}/${stocksArray.length}: ${stock.code} ${stock.name}`);

        const klineData = await fetchStockKline(stock.code, startDate);

        for (const item of klineData) {
            const date = item.date;
            const amount = parseFloat(item.amount);
            if (date && !isNaN(amount) && dateRange.includes(date)) {
                techTotalMoneyByDate[date] = (techTotalMoneyByDate[date] || 0) + amount;
            }
        }

        await sleep(100);
    }

    console.log(dateRange);
    const finalResult = dateRange
        .filter(date => techTotalMoneyByDate[date] !== undefined)
        .map(date => ({
            date,
            techTotalMoney: techTotalMoneyByDate[date],
        }));

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalResult, null, 2), 'utf-8');
    console.log(`\n===== 数据已写入: ${OUTPUT_FILE} =====`);
    console.log(`共 ${finalResult.length} 天数据`);
};

const args = process.argv.slice(2);
const startDate = defaultStartDate;
const endDate = defaultEndDate;

const resetProgress = () => {
    if (!fs.existsSync(STOCK_CODE_FILE)) {
        console.log('  进度文件不存在，跳过重置');
        return;
    }
    try {
        const content = fs.readFileSync(STOCK_CODE_FILE, 'utf-8');
        const data = JSON.parse(content);
        data.completedBlocks = [];
        data.updateTime = dayjs().format('YYYY-MM-DD HH:mm:ss');
        fs.writeFileSync(STOCK_CODE_FILE, JSON.stringify(data, null, 2), 'utf-8');
        console.log('  已清空 completedBlocks，保留已收集的股票列表');
    } catch (e) {
        console.error('  重置 completedBlocks 失败:', e.message);
    }
};

exports.run = run;
exports.techCrowdStartDate = defaultStartDate;
exports.techCrowdEndDate = defaultEndDate;

if (require.main === module) {
    // 如果需要重新拉取所有的股票，需要传递 needCollectBlock=true
    // 一般不用，除非类似长鑫上市，科技板块里面有新的股票才需要重新拉取
    run(startDate, endDate, true).catch(error => {
        console.error('脚本执行失败:', error);
        process.exit(1);
    });
}