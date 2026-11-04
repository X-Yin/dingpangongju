// 连板网 cookie（lb_sess）自动刷新
//
// 触发时机：getSingleStockTlineDataFromLB 请求返回空数据 / 非 code:0 时
// 执行路径：
//   1. 复用项目共享 Chrome（utils/browser.js）打开 https://lianban.net
//   2. 等待"连板天梯"模块首屏渲染
//   3. 点击天梯里第一只股票 → 触发页面主动请求 minute/query（分时）+ newfqkline/get（K线）
//   4. 通过 page.on('request') 拦截这两个请求的 Cookie header，提取新的 lb_sess
//   5. 更新 constant/index.js 导出的 lianbanHeaders.cookie
//
// 全局锁：同一时刻只跑一个刷新任务，其余等待或跳过
// 降级：puppeteer 失败则直接返回，让调用方继续走 CLS 兜底

const http = require('http');
const { URL } = require('url');
const { getBrowser, getOrCreatePage } = require('../utils/browser');

// 上次刷新时间 + 全局锁
let _inFlight = null;       // Promise，全局锁
let _lastRefreshAt = 0;    // ms，防刷
const MIN_REFRESH_INTERVAL = 60 * 1000; // 至少 1 分钟才允许再刷一次

// 动态更新 lianbanHeaders（因为 constant/index.js 导出的是一个对象引用，
// 改其 cookie 属性，下游 axios.get(lianbanHeaders) 自然生效）
function patchLianbanCookie(cookieHeader) {
    try {
        const { lianbanHeaders } = require('../constant');
        lianbanHeaders.cookie = cookieHeader;
        console.log(`[lb-cookie] 已更新 cookie header，长度=${cookieHeader?.length || 0}`);
    } catch (e) {
        console.error('[lb-cookie] patch constant 失败:', e.message);
    }
}

/**
 * 刷新连板网 cookie：通过 puppeteer 打开 lianban.net → 拦截分时请求 → 提取 Cookie header
 * @returns {Promise<string|null>} 新 cookie header（失败返回 null）
 */
async function refreshLBSessCookie() {
    // 全局锁：并发请求只刷一次
    if (_inFlight) {
        console.log('[lb-cookie] 已有刷新任务在跑，跳过');
        return _inFlight;
    }
    // 节流
    const now = Date.now();
    if (now - _lastRefreshAt < MIN_REFRESH_INTERVAL) {
        console.log(`[lb-cookie] ${Math.round((MIN_REFRESH_INTERVAL - (now - _lastRefreshAt)) / 1000)}s 内刚刷过，跳过`);
        return null;
    }

    _inFlight = doRefresh().finally(() => { _inFlight = null; });
    return _inFlight;
}

async function doRefresh() {
    let page = null;
    let newCookie = null;
    const capturedRequests = [];

    try {
        console.log('[lb-cookie] 开始刷新连板网 cookie...');
        const browser = await getBrowser();
        page = await getOrCreatePage(browser, 'lianban.net');
        await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
        );
        await page.setDefaultTimeout(15000);

        // 拦截目标请求
        const targetPattern = /lianban\.net\/tx\/appstock\/app\/(minute\/query|newfqkline\/get)/;
        page.on('request', (req) => {
            if (targetPattern.test(req.url())) {
                const hdr = req.headers();
                const cookie = hdr.cookie || hdr.Cookie || '';
                console.log(`[lb-cookie] 拦截到请求: ${req.url().slice(0, 80)}... cookie=${cookie ? '有' : '无'}`);
                capturedRequests.push({ url: req.url(), cookie });
            }
        });

        // 打开连板网首页
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const homeUrl = `https://lianban.net/days/${yyyy}-${mm}-${dd}.html`;
        console.log(`[lb-cookie] 打开 ${homeUrl}`);
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // 等待"连板天梯"区域内的股票列表渲染
        // 尝试几种可能的 selector（连板天梯 / 涨停天梯 / main-list 等）
        const selectorsToTry = [
            '.board-list .item',
            '.lianban-list a',
            '.days-list a',
            'div[class*="lianban"] a',
            '.list a[href*="/S/"]',
            'a[href*="/S/"]',
        ];
        let clicked = false;
        for (const sel of selectorsToTry) {
            try {
                await page.waitForSelector(sel, { timeout: 3000 });
                const first = await page.$(sel);
                if (first) {
                    console.log(`[lb-cookie] 找到 selector ${sel}，点击第一个股票`);
                    await first.click();
                    clicked = true;
                    break;
                }
            } catch { /* 下一个 */ }
        }
        if (!clicked) {
            console.warn('[lb-cookie] 没找到可点击的连板天梯股票，cookie 可能无法刷新');
        }

        // 等待 2-3s 让弹窗加载 + 接口请求发出去
        await new Promise(r => setTimeout(r, 3000));

        // 从拦截的请求里找 cookie
        const withCookie = capturedRequests.find(r => r.cookie && r.cookie.includes('lb_sess'));
        if (withCookie) {
            newCookie = withCookie.cookie;
            console.log('[lb-cookie] 成功捕获 lb_sess cookie');
        } else if (capturedRequests.length > 0) {
            // 请求发了但没有 cookie — 可能 lianban.net 根本不需要 cookie
            console.log(`[lb-cookie] 拦截到 ${capturedRequests.length} 个请求，但都没有 lb_sess cookie（连板网可能不需要 cookie）`);
        } else {
            console.warn('[lb-cookie] 3s 内没有拦截到任何目标请求，刷新失败');
        }

        _lastRefreshAt = Date.now();

        // 如果确实拿到了新 cookie，就更新
        if (newCookie) {
            patchLianbanCookie(newCookie);
        }
        return newCookie;

    } catch (err) {
        console.error('[lb-cookie] 刷新异常:', err.message);
        _lastRefreshAt = Date.now(); // 失败也节流，避免疯狂重试
        return null;
    } finally {
        // 不关闭 page — 保留给其他需要 lianban.net 页面的服务复用
        // 但可以把弹窗关掉减少干扰
        if (page) {
            try {
                await page.evaluate(() => {
                    const modal = document.querySelector('.modal-close, .popup-close, [class*="close"]');
                    if (modal && modal.click) modal.click();
                }).catch(() => {});
            } catch {}
        }
    }
}

module.exports = { refreshLBSessCookie };
