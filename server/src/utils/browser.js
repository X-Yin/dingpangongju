// 共享 Chrome 浏览器管理工具
// 所有需要 puppeteer 的服务（jigouReports / rihan / amount）通过此工具复用同一个 Chrome 实例，
// 避免每个服务各自启动一个 Chrome 进程导致 CPU / 内存占用过高。
//
// 核心思路（与 jigouReports.js 原有逻辑一致）：
// 1. 通过 --remote-debugging-port 启动一个 detached Chrome（脱离 node 进程组，node 退出不会杀掉 Chrome）
// 2. 后续所有服务通过 puppeteer.connect 复用该 Chrome，各自只管自己的 tab
// 3. 用户数据目录固定在 service/.chrome-profile，保留 zsxq 登录态

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const DEBUG_PORT = 9222;
const DEBUG_HTTP = `http://127.0.0.1:${DEBUG_PORT}/json/version`;

const WINDOW_W = 1280;
const WINDOW_H = 800;

// 与 jigouReports.js 原有路径保持一致，保留已有的 zsxq 登录态
const USER_DATA_DIR = path.resolve(__dirname, '../service/.chrome-profile');

// 获取已运行 Chrome 的 WebSocket 调试地址
function getExistingWsEndpoint() {
  return new Promise((resolve) => {
    const req = http.get(DEBUG_HTTP, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.webSocketDebuggerUrl || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// 轮询等待 Chrome 调试端口就绪
async function waitForDebugPort(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = await getExistingWsEndpoint();
    if (ws) return ws;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome 调试端口 ${DEBUG_PORT} 在 ${timeoutMs}ms 内未就绪`);
}

/**
 * 连接已存在的 Chrome；连不上则用 detached 方式启动一个新的 Chrome，
 * 让其完全脱离 node 进程组 —— node 退出 / Ctrl+C 都不会杀掉 Chrome，
 * 从而保证登录态（session cookie）持续保留，且所有服务复用同一实例。
 */
async function getBrowser() {
  // 1. 尝试连接已存在的 Chrome
  const ws = await getExistingWsEndpoint();
  if (ws) {
    try {
      const browser = await puppeteer.connect({ browserWSEndpoint: ws });
      return browser;
    } catch (e) {
      console.warn(`[browser] 连接失败：${e.message}，将启动新的 Chrome`);
    }
  }

  // 2. 用 detached 方式启动 Chrome（脱离 node 进程组）
  const chromePath = await puppeteer.executablePath();
  console.log(`[browser] 启动新的 Chrome（detached），调试端口 ${DEBUG_PORT}`);
  console.log(`[browser] 用户数据目录：${USER_DATA_DIR}`);
  console.log(`[browser] Chrome 路径：${chromePath}`);

  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--start-maximized',
      `--window-size=${WINDOW_W},${WINDOW_H}`,
      // ====== 禁用后台节流（关键修复）======
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,BackgroundOcclusionWindow',
    ],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();

  // 3. 等待调试端口就绪后连接
  const ws2 = await waitForDebugPort(15000);
  const browser = await puppeteer.connect({ browserWSEndpoint: ws2 });
  console.log('[browser] Chrome 已启动并连接成功，下次运行会自动复用此实例');
  return browser;
}

/**
 * 获取或复用已存在的目标 page
 * @param {Object} browser - puppeteer browser 实例
 * @param {string} urlPattern - 用于匹配已存在 tab 的 URL 片段（如 'zsxq.com' / 'eastmoney.com'）
 * @returns {Promise<Object>} page 实例
 */
async function getOrCreatePage(browser, urlPattern = '') {
  const pages = await browser.pages();
  // 优先找已经在目标页面的 tab
  if (urlPattern) {
    const existing = pages.find((p) => {
      try {
        return p.url().includes(urlPattern);
      } catch {
        return false;
      }
    });
    if (existing) {
      return existing;
    }
  }
  // 没有匹配的 tab 时，复用真正空白的 tab（about:blank / chrome://newtab）
  // 注意：不能直接复用 pages[0]，否则会抢占其他服务正在使用的 tab
  const blank = pages.find((p) => {
    try {
      const u = p.url();
      return u === 'about:blank' || u === '' || u.startsWith('chrome://');
    } catch {
      return false;
    }
  });
  if (blank) {
    return blank;
  }
  // 没有空白 tab 才新建
  return await browser.newPage();
}

module.exports = {
  getBrowser,
  getOrCreatePage,
  DEBUG_PORT,
};
