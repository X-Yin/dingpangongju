const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');

const amountPath = path.resolve(__dirname, '../data/amount.json');

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

        const result = await page.evaluate(() => {
            const element1 = document.querySelector('.hq-stock-money span.zhulivalue');
            const element2 = document.querySelector('.hq-stock-amount span.valfont');
            return {
                'mainMoney': element1 ? element1.innerText.trim() : null,
                'amountChangeDiff': element2 ? element2.innerText.trim() : null,
            }
        });

        await browser.close();
        if (Math.abs(Number(parseFloat(result.mainMoney))) > 0 && Math.abs(Number(parseFloat(result.amountChangeDiff))) > 0) {

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

const getAmountInfo = async () => {
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
            amountData.push([dayjs().format('HHmmss'), amountInfo]);

            // 保存到文件
            fs.writeFileSync(amountPath, JSON.stringify(amountData, null, 2));
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
    return fs.existsSync(amountPath) ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]') : [];
}

// let num = 0;
// const mockAmountInfo = async () => {
//     num++;
//     return {
//         'mainMoney': '-200',
//         'amountChangeDiff': -1000 - num * 10 + ''
//     }
// }

exports.getAmountInfo = getAmountInfo;
exports.getAmountHistory = getAmountHistory;
exports.pollAmountInfo = pollAmountInfo;
