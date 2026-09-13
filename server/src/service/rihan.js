const fs = require('fs');
const path = require('path');
const { getBrowser, getOrCreatePage } = require('../utils/browser');

const RIHAN_DATA_PATH = path.resolve(__dirname, '../data/rihan.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const N225_URL = 'https://quote.eastmoney.com/gb/zsN225.html';
const KS11_URL = 'https://quote.eastmoney.com/gb/zsKS11.html';

// 持久化页面引用，复用而非每次新建
let _n225Page = null;
let _ks11Page = null;

const ensureN225Page = async () => {
    if (_n225Page && !_n225Page.isClosed()) {
        return _n225Page;
    }
    const browser = await getBrowser();
    _n225Page = await getOrCreatePage(browser, 'zsN225.html');
    await _n225Page.setUserAgent(UA);
    await _n225Page.setDefaultTimeout(60000);
    return _n225Page;
};

const ensureKS11Page = async () => {
    if (_ks11Page && !_ks11Page.isClosed()) {
        return _ks11Page;
    }
    const browser = await getBrowser();
    _ks11Page = await getOrCreatePage(browser, 'zsKS11.html');
    await _ks11Page.setUserAgent(UA);
    await _ks11Page.setDefaultTimeout(60000);
    return _ks11Page;
};

// 从页面 DOM 提取指数数据（价格和涨跌幅）
const extractIndexData = async (page) => {
    return await page.evaluate(() => {
        const quoteDiv = document.querySelector('.gi_quote_l');
        if (!quoteDiv) return null;

        // 提取当前价格
        const zxjSpan = quoteDiv.querySelector('.zxj span span');
        const value = zxjSpan ? zxjSpan.textContent.trim() : null;

        // 提取涨跌幅（包含 % 的那个 span）
        const zdDiv = quoteDiv.querySelector('.zd');
        let change = null;
        if (zdDiv) {
            const spans = zdDiv.querySelectorAll('span');
            for (const span of spans) {
                const text = span.textContent?.trim();
                if (text && text.includes('%')) {
                    change = text;
                    break;
                }
            }
        }

        return { value, change };
    });
};

// 获取单个指数数据
const fetchIndexData = async (ensurePageFn, url, name, code) => {
    let page;
    try {
        page = await ensurePageFn();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.gi_quote_l .zd', { timeout: 30000 });
        const data = await extractIndexData(page);
        return {
            name,
            code,
            change: data?.change || '--',
            value: data?.value || '--',
        };
    } catch (error) {
        console.error(`>>> 获取${name}数据失败:`, error.message);
        if (page && page.isClosed()) {
            if (code === 'N225') _n225Page = null;
            if (code === 'KS11') _ks11Page = null;
        }
        return { name, code, change: '--', value: '--' };
    }
};

// 手动刷新日韩指数数据（同时供轮询和 API 调用）
const refreshRiHanData = async () => {
    try {
        const [n225, ks11] = await Promise.all([
            fetchIndexData(ensureN225Page, N225_URL, '日经225', 'N225'),
            fetchIndexData(ensureKS11Page, KS11_URL, '韩国KOSPI', 'KS11'),
        ]);
        const result = [n225, ks11];
        fs.writeFileSync(RIHAN_DATA_PATH, JSON.stringify(result, null, 2));
        console.log(`>>> 日韩指数更新成功 (${new Date().toLocaleTimeString()}):`, result.map(r => `${r.name}: ${r.change}`).join(', '));
        return result;
    } catch (e) {
        console.error('>>> 日韩指数获取失败:', e.message);
        throw e;
    }
};

const pollRiHanData = async () => {
    console.log('>>> 启动日韩指数监控...');

    // 首次立即执行
    await refreshRiHanData();
    // 每隔5分钟刷新
    setInterval(refreshRiHanData, 5 * 60 * 1000);
};

const getRiHanData = () => {
    if (fs.existsSync(RIHAN_DATA_PATH)) {
        let data = JSON.parse(fs.readFileSync(RIHAN_DATA_PATH, 'utf-8'));
        data = data.filter(i => !i.name.includes('KOSPI200'));
        return data;
    }
    return [];
};

module.exports = {
    pollRiHanData,
    getRiHanData,
    refreshRiHanData,
};