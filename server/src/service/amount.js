const puppeteer = require('puppeteer');

// 获取成交量信息
const getAmountInfo = async () => {
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

// let num = 0;
// const mockAmountInfo = async () => {
//     num++;
//     return {
//         'mainMoney': '-200',
//         'amountChangeDiff': -1000 - num * 10 + ''
//     }
// }

exports.getAmountInfo = getAmountInfo;