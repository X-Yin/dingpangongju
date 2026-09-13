const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const axios = require('axios');
const { sleep } = require('../utils/index');
const { getBrowser, getOrCreatePage } = require('../utils/browser');

const amountPath = path.resolve(__dirname, '../data/amount.json');
const amountDayHistoryPath = path.resolve(__dirname, '../data/amount_day_history.json');
const currentDayHotBlockPath = path.resolve(__dirname, '../data/current_day_hot_block.json');

// 持久化页面引用：所有轮询共用同一个 Chrome tab，避免反复启动/关闭浏览器
let _page = null;

const SINA_URL = 'https://gu.sina.cn/m/?vt=4#/index/index';

const DFCF_URL = 'https://data.eastmoney.com/zjlx/dpzjlx.html';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 解析 JSONP 响应（新浪 openapi 返回格式：hqccallXXX({...})）
const parseJsonp = (jsonpString) => {
    const match = jsonpString.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (match && match[1]) {
        return JSON.parse(match[1]);
    }
    return null;
};

// 生成随机 JSONP 回调名
const genCallback = () => `hqccall${Math.floor(Math.random() * 1e10)}`;

// 获取（或复用）持久化的 sina 页面
const ensureSinaPage = async () => {
    if (_page && !_page.isClosed()) {
        return _page;
    }
    const browser = await getBrowser();
    _page = await getOrCreatePage(browser, 'gu.sina.cn');
    await _page.setUserAgent(UA);
    await _page.setDefaultTimeout(60000);
    return _page;
};

// 从 Lv2_Service.getCateMinLine 接口获取主力资金
// 计算方式：(r0_in - r0_out) + (r1_in - r1_out)
const fetchMainMoneyFromApi = async () => {
    const callback = genCallback();
    const url = `https://gu.sina.cn/moneyflow/api/openapi.php/Lv2_Service.getCateMinLine?cate=hs_a&vtype=isymbol&callback=${callback}`;
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://gu.sina.cn/' },
        timeout: 15000,
        responseType: 'text',
        transformResponse: [(d) => d],
    });
    const json = parseJsonp(data);
    if (!json?.result?.data?.data?.length) {
        throw new Error('主力资金接口返回数据异常');
    }
    const arr = json.result.data.data;
    const latest = arr[arr.length - 1];
    // 最新数据点包含 r0_in/r0_out/r1_in/r1_out 累计值
    let mainMoneyYi;
    if (latest.r0_in !== undefined && latest.r0_out !== undefined &&
        latest.r1_in !== undefined && latest.r1_out !== undefined) {
        mainMoneyYi = ((Number(latest.r0_in) - Number(latest.r0_out)) +
                       (Number(latest.r1_in) - Number(latest.r1_out))) / 1e8;
    } else {
        // 回退使用 r0 + r1 净额字段
        mainMoneyYi = (Number(latest.r0) + Number(latest.r1)) / 1e8;
    }
    const sign = mainMoneyYi >= 0 ? '+' : '-';
    return `${sign}${Math.abs(mainMoneyYi).toFixed(2)}亿`;
};

// 从 ZhenMinAmtService.getTodayDataForGraph 接口获取成交量信息
// 计算方式：(今日 sh+sz+bjs) - (昨日 sh+sz+bjs)
const fetchAmountDiffFromApi = async () => {
    const callback = genCallback();
    const url = `https://gu.sina.cn/hq/api/openapi.php/ZhenMinAmtService.getTodayDataForGraph?&callback=${callback}`;
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://gu.sina.cn/' },
        timeout: 15000,
        responseType: 'text',
        transformResponse: [(d) => d],
    });
    const json = parseJsonp(data);
    if (!json?.result?.data) {
        throw new Error('成交量接口返回数据异常');
    }
    const { latest_data, last_day_data } = json.result.data;
    const todayTotal = Number(latest_data.sh_amount) + Number(latest_data.sz_amount) + Number(latest_data.bjs_amount);
    const yesterdayTotal = Number(last_day_data.sh_amount) + Number(last_day_data.sz_amount) + Number(last_day_data.bjs_amount);
    const diffYi = (todayTotal - yesterdayTotal) / 1e8;
    const sign = diffYi >= 0 ? '+' : '-';

    // 格式化总成交量
    const totalYi = todayTotal / 1e8;
    const totalAmount = totalYi >= 10000
        ? `${(totalYi / 10000).toFixed(2)}万亿`
        : `${totalYi.toFixed(2)}亿`;

    return {
        amountChangeDiff: `${sign}${Math.abs(diffYi).toFixed(2)}亿`,
        totalAmount,
    };
};

// 获取当日热门板块（仍通过 Puppeteer 抓取，接口暂无对应数据源）
const fetchCurrentDayHotBlock = async () => {
    let page;
    try {
        page = await ensureSinaPage();
        await page.goto(SINA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.hq-stock-section .hq-topthree-item', { timeout: 30000 });
        await sleep(1000);
        return await page.evaluate(() => {
            const elements = document.querySelectorAll('.hq-stock-section .hq-topthree-item.block a h3');
            const result = [];
            elements.forEach((item) => {
                result.push(item.innerText);
            });
            return result.slice(0, 6);
        });
    } catch (error) {
        console.error('抓取当日热门板块失败:', error.message);
        if (page && page.isClosed()) {
            _page = null;
        }
        return [];
    }
};

// 从带单位的字符串（如 "-873.55亿" / "+3216.55亿" / "2.68万亿" / "1234.56万"）中解析出数值（单位：亿）
const parseAmountToYi = (str) => {
    if (!str) return 0;
    const isPositive = str.startsWith('+');
    const isNegative = str.startsWith('-');
    const valueStr = (isPositive || isNegative) ? str.slice(1) : str;
    const num = parseFloat(valueStr.replace(/亿|万/g, '')) || 0;
    const sign = (isNegative ? -1 : 1);
    if (valueStr.indexOf('万亿') !== -1) {
        // 万亿 -> 亿
        return sign * (num * 10000);
    }
    if (valueStr.indexOf('亿') !== -1) {
        return sign * num;
    }
    if (valueStr.indexOf('万') !== -1) {
        // 万 -> 亿
        return sign * (num / 10000);
    }
    return sign * num;
};

// 将带单位的字符串统一转换为仅以「亿」为单位的字符串（如 "2.68万亿" -> "26800亿"）
const formatAmountToYi = (str) => {
    if (!str) return str;
    const isPositive = str.startsWith('+');
    const isNegative = str.startsWith('-');
    const sign = isPositive ? '+' : (isNegative ? '-' : '');
    const valueStr = (isPositive || isNegative) ? str.slice(1) : str;
    const num = parseFloat(valueStr.replace(/亿|万/g, '')) || 0;
    let yi;
    if (valueStr.indexOf('万亿') !== -1) {
        yi = num * 10000;
    } else if (valueStr.indexOf('万') !== -1) {
        yi = num / 10000;
    } else {
        yi = num;
    }
    return `${sign}${yi}亿`;
};

// 通过接口获取成交量信息（主力资金 + 成交量走接口，热门板块仍通过 Puppeteer 抓取）
const fetchAmountInfoFromApi = async () => {
    // 并行获取：接口数据（主力资金 + 成交量） + Puppeteer（热门板块）
    const [mainMoney, amountData, currentDayHotBlock] = await Promise.all([
        fetchMainMoneyFromApi(),
        fetchAmountDiffFromApi(),
        fetchCurrentDayHotBlock(),
    ]);

    const result = {
        mainMoney,
        amountChangeDiff: amountData.amountChangeDiff,
        totalAmount: amountData.totalAmount,
        currentDayHotBlock,
    };

    if (Math.abs(Number(parseFloat(result.mainMoney))) > 0 && Math.abs(Number(parseFloat(result.amountChangeDiff))) > 0) {
        return result;
    } else {
        throw new Error('成交量信息获取失败');
    }
};

// 通过 Puppeteer 从 HTML 抓取成交量信息（原始方式）
const fetchAmountInfoFromBrowser = async () => {
    let page;
    try {
        page = await ensureSinaPage();

        await page.goto(SINA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

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

            const element4 = document.querySelector('.hq-stock-amount span.val');

            return {
                'mainMoney': element1 ? element1.innerText.trim() : null,
                'amountChangeDiff': element2 ? element2.innerText.trim() : null,
                'currentDayHotBlock': currentDayHotBlock.slice(0, 6),
                'totalAmount': element4 ? element4.innerText.trim() : null,
            }
        });

        if (Math.abs(Number(parseFloat(result.mainMoney))) > 0 && Math.abs(Number(parseFloat(result.amountChangeDiff))) > 0) {
            return result;
        } else {
            throw new Error('成交量信息获取失败');
        }
    } catch (error) {
        console.error('抓取数据发生错误:', error.message);
        // 不关闭浏览器（共享实例），仅在页面已关闭时重置引用，下次轮询会重新获取
        if (page && page.isClosed()) {
            _page = null;
        }
        throw error;
    }
};

// 持久化东方财富页面引用
let _dfcfPage = null;

// 获取（或复用）持久化的东方财富页面
const ensureDFCFPage = async () => {
    if (_dfcfPage && !_dfcfPage.isClosed()) {
        return _dfcfPage;
    }
    const browser = await getBrowser();
    _dfcfPage = await getOrCreatePage(browser, 'data.eastmoney.com');
    await _dfcfPage.setUserAgent(UA);
    await _dfcfPage.setDefaultTimeout(60000);
    return _dfcfPage;
};

// 通过 Puppeteer 从东方财富页面抓取主力资金净流入/流出
// 元素示例：<td data-field="f62"><span class="green">-296.2015亿</span></td>
const fetchMainMoneyFromDFCF = async () => {
    let page;
    try {
        page = await ensureDFCFPage();
        await page.goto(DFCF_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('td[data-field="f62"] span', { timeout: 30000 });
        await sleep(1000);
        const text = await page.evaluate(() => {
            const el = document.querySelector('td[data-field="f62"] span');
            return el ? el.innerText.trim() : null;
        });
        if (!text) {
            throw new Error('东方财富主力资金元素未找到');
        }
        // 统一格式化为带正负号、保留2位小数、单位为「亿」
        const isNegative = text.startsWith('-');
        const num = parseFloat(text.replace(/[^0-9.]/g, '')) || 0;
        const sign = isNegative ? '-' : '+';
        return `${sign}${num.toFixed(2)}亿`;
    } catch (error) {
        console.error('从东方财富抓取主力资金失败:', error.message);
        if (page && page.isClosed()) {
            _dfcfPage = null;
        }
        throw error;
    }
};

// 通过东方财富浏览器方式获取成交量信息（主力资金走东方财富 Puppeteer，成交量走新浪接口，热门板块走新浪 Puppeteer）
const fetchAmountInfoFromDFCFBrowser = async () => {
    const [mainMoney, amountData, currentDayHotBlock] = await Promise.all([
        fetchMainMoneyFromDFCF(),
        fetchAmountDiffFromApi(),
        fetchCurrentDayHotBlock(),
    ]);

    const result = {
        mainMoney,
        amountChangeDiff: amountData.amountChangeDiff,
        totalAmount: amountData.totalAmount,
        currentDayHotBlock,
    };

    if (Math.abs(Number(parseFloat(result.mainMoney))) > 0 && Math.abs(Number(parseFloat(result.amountChangeDiff))) > 0) {
        return result;
    } else {
        throw new Error('成交量信息获取失败');
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

const pollAmountInfo = async (interval = 1000 * 10, type = 'api') => {
    let fetchFn;
    if (type === 'browser') {
        fetchFn = fetchAmountInfoFromBrowser;
    } else if (type === 'dfcf_browser') {
        fetchFn = fetchAmountInfoFromDFCFBrowser;
    } else {
        fetchFn = fetchAmountInfoFromApi;
    }
    // 立即执行首次获取
    const fetchAndSave = async () => {
        try {
            const amountInfo = await fetchFn();
            // 先把文件中的内容读取出来，然后将当前的内容合并到文件中，文件中的内容是一个二维数组，数组中的每一项也是一个数组，第一个值 是当前的时间 DD:MM:SS，第二个值 是当前的成交量信息
            const amountData = fs.existsSync(amountPath) ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]') : [];
            const { currentDayHotBlock, ...amountDataToSave } = amountInfo;
            amountData.push([dayjs().format('HHmmss'), { ...amountDataToSave, date: dayjs().format('YYYYMMDD') }]);

            // 保存到文件
            fs.writeFileSync(amountPath, JSON.stringify(amountData, null, 2));
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
    const uniqueData = data.filter((item, index, arr) => arr.findIndex(t => t[0] === item[0]) === index);

    // 取文件中最新一天的日期，非交易日（如周末）也能展示最近交易日数据
    let latestDate = '';
    uniqueData.forEach(i => {
        const d = i[1]?.date;
        if (d && d > latestDate) latestDate = d;
    });

    return uniqueData.map(i => {
        const { mainMoney, amountChangeDiff } = i[1];
        let updatedItem = { ...i[1] };

        if (mainMoney) {
            if (mainMoney.indexOf('万') !== -1) {
                updatedItem.mainMoney = (parseFloat(mainMoney.replace('万', '')) / 10000).toFixed(2);
            } else if (mainMoney.indexOf('亿') !== -1) {
                updatedItem.mainMoney = parseFloat(mainMoney.replace('亿', '')).toFixed(2);
            } else {
                updatedItem.mainMoney = parseFloat(mainMoney).toFixed(2);
            }
        }

        if (amountChangeDiff) {
            let value = amountChangeDiff;
            const sign = value.startsWith('-') ? -1 : 1;
            if (value.startsWith('+') || value.startsWith('-')) {
                value = value.slice(1);
            }
            if (value.indexOf('万') !== -1) {
                updatedItem.amountChangeDiff = `${sign === -1 ? '-' : ''}${(parseFloat(value.replace('万', '')) / 10000).toFixed(2)}`;
            } else if (value.indexOf('亿') !== -1) {
                updatedItem.amountChangeDiff = `${sign === -1 ? '-' : ''}${parseFloat(value.replace('亿', '')).toFixed(2)}`;
            } else {
                updatedItem.amountChangeDiff = `${sign === -1 ? '-' : ''}${parseFloat(value).toFixed(2)}`;
            }
        }

        return [i[0], updatedItem];
    }).filter(i => {
        // 只返回最新一天的数据（不强制要求是今天，周末也能展示周五数据）
        const itemDate = i[1]?.date;
        if (itemDate && latestDate && itemDate !== latestDate) return false;

        // 只返回开盘时间的数据：早上9:30-11:30，下午13:00-15:00
        const time = i[0];
        const hour = parseInt(time.substring(0, 2));
        const minute = parseInt(time.substring(2, 4));
        const totalMinutes = hour * 60 + minute;

        // 上午开盘时间：9:30-11:30 (570-690分钟)
        const morningStart = 9 * 60 + 30;
        const morningEnd = 11 * 60 + 30;

        // 下午开盘时间：13:00-15:00 (780-900分钟)
        const afternoonStart = 13 * 60;
        const afternoonEnd = 15 * 60;

        return (totalMinutes >= morningStart && totalMinutes <= morningEnd) ||
            (totalMinutes >= afternoonStart && totalMinutes <= afternoonEnd);
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
    const { mainMoney, amountChangeDiff, totalAmount } = latest[1];

    const dayHistory = getAmountDayHistory();
    const today = dayjs().format('YYYYMMDD');
    const record = {
        date: today,
        mainMoney: parseAmountToYi(mainMoney),
        amountChangeDiff: parseAmountToYi(amountChangeDiff),
        mainMoneyRaw: mainMoney,
        amountChangeDiffRaw: amountChangeDiff,
        totalAmount: parseAmountToYi(totalAmount),
        totalAmountRaw: formatAmountToYi(totalAmount),
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
//     const data = await fetchMainMoneyFromApi();
//     const data2 = await fetchAmountDiffFromApi();
//     console.log('123412341234', data, data2);
// })();

exports.getAmountInfo = getAmountInfo;
exports.getAmountHistory = getAmountHistory;
exports.pollAmountInfo = pollAmountInfo;
exports.getAmountDayHistory = getAmountDayHistory;
exports.updateAmountDayHistory = updateAmountDayHistory;
exports.scheduleAmountDayHistory = scheduleAmountDayHistory;
exports.parseAmountToYi = parseAmountToYi;