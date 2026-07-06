// 从 data/jigouReports.json 中读取数据
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const JIGOU_REPORTS_DATA_PATH = path.join(__dirname, '../data/jigouReports.json');
const RESEARCH_REPORTS_MENU_PATH = path.join(__dirname, '../data/research_reports/menu.json');
const RESEARCH_REPORTS_DIR = path.join(__dirname, '../data/research_reports');

// ==================== Puppeteer 抓取配置 ====================
const LOGIN_URL = 'https://wx.zsxq.com/login';
const GROUP_URL = 'https://wx.zsxq.com/group/88882285412582';
const API_PREFIX = 'https://api.zsxq.com/v2/groups/88882285412582/topics?scope=all&count=20';
const MAX_COUNT = 5;
const REFRESH_INTERVAL = 10 * 60 * 1000; // 刷新间隔 10min

// Chrome 远程调试端口（保持浏览器常驻的关键）
const DEBUG_PORT = 9222;
const DEBUG_HTTP = `http://127.0.0.1:${DEBUG_PORT}/json/version`;

// 窗口/视口尺寸（让内容铺满整个浏览器窗口）
const WINDOW_W = 1280;
const WINDOW_H = 800;

// 用户数据目录：保存登录态、cookie 等，重启后仍生效
const USER_DATA_DIR = path.join(__dirname, '.chrome-profile');

// 获取今天的日期字符串 YYYYMMDD
const getTodayStr = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

// 读取机构调研帖子数据
const getJigouReportsData = () => {
  try {
    const data = fs.readFileSync(JIGOU_REPORTS_DATA_PATH, 'utf-8');
    const json = JSON.parse(data);
    // 数据结构为数组，每个元素含 resp_data.topics
    const list = Array.isArray(json) ? json : [json];
    const topics = list.flatMap(item => item?.resp_data?.topics || []);
    // 根据 topic_id 去重
    const seen = new Set();
    const dedupedTopics = topics.filter(t => {
      if (!t.topic_id || seen.has(t.topic_id)) return false;
      seen.add(t.topic_id);
      return true;
    });
    // 只保留 title, text 和 create_time 字段
    const reports = dedupedTopics.map((t) => ({
      title: t.title || '',
      text: t.talk?.text || '',
      createTime: t.create_time || '',
    }));
    return { reports };
  } catch (error) {
    return { reports: [] };
  }
};

// 读取近 5 天的研报内容（按 menu.json 中 folder 顺序取最后 5 个日期），排除"今日复盘"
const getRecentResearchReports = () => {
  try {
    const data = fs.readFileSync(RESEARCH_REPORTS_MENU_PATH, 'utf-8');
    const folders = JSON.parse(data);
    if (!Array.isArray(folders)) return [];
    // 取最后 5 个 folder（按日期升序，最后 5 个即最近 5 天）
    const recentFolders = folders.filter(f => f.type === 'folder').slice(-5);
    const reports = [];
    recentFolders.forEach(folder => {
      (folder.children || []).forEach(report => {
        if (report.type === 'report' && report.name && report.name !== '今日复盘') {
          // content 存储在单独的 {id}.json 文件中
          let content = '';
          try {
            const reportData = fs.readFileSync(path.join(RESEARCH_REPORTS_DIR, `${report.id}.json`), 'utf-8');
            content = JSON.parse(reportData).content || '';
          } catch (e) {
            content = '';
          }
          reports.push({
            date: folder.name,
            title: report.name,
            text: content,
          });
        }
      });
    });
    return reports;
  } catch (error) {
    return [];
  }
};

// 读取数据
const getJigouReportsDataWithResearch = () => {
  const { reports } = getJigouReportsData();
  const researchReports = getRecentResearchReports();
  return {
    reports,
    researchReports,
  };
};

// ==================== Puppeteer 抓取逻辑 ====================

/**
 * 获取已运行 Chrome 的 WebSocket 调试地址
 */
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

/**
 * 轮询等待 Chrome 调试端口就绪
 */
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
 * 让其完全脱离 node 进程组 —— 这样 node 退出 / Ctrl+C 都不会杀掉 Chrome，
 * 从而保证登录态（session cookie）持续保留。
 */
async function getBrowser() {
  // 1. 尝试连接已存在的 Chrome
  const ws = await getExistingWsEndpoint();
  if (ws) {
    console.log(`[browser] 检测到已运行的 Chrome，通过 ${DEBUG_PORT} 端口连接复用`);
    try {
      const browser = await puppeteer.connect({ browserWSEndpoint: ws });
      console.log('[browser] 连接成功');
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
    ],
    {
      detached: true,  // 关键：脱离父进程组，独立成会话
      stdio: 'ignore', // 不绑定 stdio，node 退出不会被 Chrome 阻塞
    },
  );
  child.unref();  // 让 node 事件循环不等待此子进程

  // 3. 等待调试端口就绪后连接
  const ws2 = await waitForDebugPort(15000);
  const browser = await puppeteer.connect({ browserWSEndpoint: ws2 });
  console.log('[browser] Chrome 已启动并连接成功，下次运行会自动复用此实例');
  return browser;
}

/**
 * 获取或复用已存在的目标 page
 */
async function getOrCreatePage(browser) {
  const pages = await browser.pages();
  // 优先找已经在星球页面的 tab
  const existing = pages.find((p) => {
    try {
      return p.url().includes('zsxq.com');
    } catch {
      return false;
    }
  });
  if (existing) {
    console.log('[page] 复用已存在的 tab');
    return existing;
  }
  // 退而求其次，复用第一个空白页
  if (pages.length > 0) {
    console.log('[page] 复用空白 tab');
    return pages[0];
  }
  console.log('[page] 新建 tab');
  return await browser.newPage();
}

/**
 * 启动 puppeteer 抓取循环：打开登录页 → 等待登录 → 拦截接口 → 滚动 → 写入 data/jigouReports.json
 * 浏览器常驻，每 10min 刷新一轮。
 */
async function fetchZsxqTopics() {
  const browser = await getBrowser();
  const page = await getOrCreatePage(browser);

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  // 获取浏览器实际窗口大小，设置到 viewport 让 tab 内容区域撑满
  const { windowId } = await browser._connection.send('Browser.getWindowForTarget', {
    targetId: page.target()._targetId,
  });
  const { bounds } = await browser._connection.send('Browser.getWindowBounds', { windowId });
  console.log(`[page] 浏览器窗口实际大小：${bounds.width}x${bounds.height}`);
  await page.setViewport({ width: bounds.width, height: bounds.height });

  // 进程退出时只断开连接，不关闭浏览器，保留登录态供下次复用
  const cleanup = () => {
    try {
      browser.disconnect();
      console.log('[browser] 已断开连接（浏览器保持运行）');
    } catch {}
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // 1. 始终先打开登录页
  //    - 未登录：停留在登录页，等待用户手动登录
  //    - 已登录：网站会自动重定向到星球页面
  const currentUrl = page.url();
  if (!currentUrl.includes('wx.zsxq.com')) {
    console.log('正在打开登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log(`登录页已打开，当前 URL：${page.url()}`);
  } else {
    // 已经在 zsxq 域名下，强制导航到登录页触发重定向逻辑
    console.log('已在 zsxq 域名，导航到登录页判断登录态...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log(`当前 URL：${page.url()}`);
  }

  // 2. 如果当前不在星球页面（说明未登录，停在了登录页），等待用户手动登录
  if (!page.url().includes('/group/88882285412582')) {
    console.log('未检测到登录态，请手动登录，登录成功后会自动跳转到星球页面...');
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const current = page.url();
        if (current.includes('/group/88882285412582')) {
          clearInterval(timer);
          console.log(`检测到已进入星球页面：${current}`);
          resolve();
        }
      }, 1000);
    });
  } else {
    console.log(`已登录，自动重定向到了星球页面：${page.url()}`);
  }

  // 给页面一点时间稳定
  await new Promise((r) => setTimeout(r, 2000));

  // 用一个可变容器持有本轮收集结果，listener 通过引用读取
  const ctx = { collected: [] };

  // 拦截 topics 接口响应（每轮注册前先 removeAllListeners，避免重复）
  page.removeAllListeners('response');
  page.on('response', async (response) => {
    const req = response.request();
    if (req.method() === 'OPTIONS') return; // 跳过 preflight
    const url = response.url();
    if (url.startsWith(API_PREFIX)) {
      try {
        const json = await response.json();
        ctx.collected.push(json);
        const topicCount = json?.resp_data?.topics?.length || 0;
        console.log(`[拦截] 第 ${ctx.collected.length} 次接口，topics: ${topicCount}`);
      } catch (e) {
        console.log('解析响应失败:', e.message);
      }
    }
  });

  // 单轮：刷新页面 → 滚动 → 收集 → 写文件
  async function runOnce() {
    ctx.collected.length = 0;

    console.log('正在刷新页面...');
    await page.goto(GROUP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('页面已就绪，开始滚动加载...');

    let scrollTimes = 0;
    const MAX_SCROLL = 200;
    let diagPrinted = false;
    while (ctx.collected.length < MAX_COUNT && scrollTimes < MAX_SCROLL) {
      const info = await page.evaluate(() => {
        const candidates = [
          document.querySelector('.page__bd'),
          document.querySelector('.topic-list'),
          document.querySelector('.group-page'),
          document.querySelector('.group-topic-list'),
          document.scrollingElement,
          document.documentElement,
          document.body,
        ].filter(Boolean);

        const scroller = candidates.find(
          (el) => el && el.scrollHeight - el.clientHeight > 4,
        );

        const delta = (window.innerHeight || 800) * 1.5;
        if (scroller) {
          scroller.scrollTop += delta;
        }
        window.scrollBy(0, delta);
        return {
          found: !!scroller,
          tag: scroller ? scroller.className || scroller.tagName : 'none',
          scrollTop: scroller ? scroller.scrollTop : window.scrollY,
          scrollHeight: scroller ? scroller.scrollHeight : document.body.scrollHeight,
        };
      });
      if (!diagPrinted) {
        diagPrinted = true;
        console.log(
          `[scroll] 容器: ${info.tag}, scrollTop=${info.scrollTop}, scrollHeight=${info.scrollHeight}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      scrollTimes++;
    }

    if (ctx.collected.length < MAX_COUNT) {
      console.warn(`仅拦截到 ${ctx.collected.length} 次接口（未满 ${MAX_COUNT} 次），可能是已无更多内容或滚动未触发加载。`);
    }

    // 写入 data/jigouReports.json
    fs.writeFileSync(JIGOU_REPORTS_DATA_PATH, JSON.stringify(ctx.collected, null, 2));
    console.log(`[完成] 本轮共拦截 ${ctx.collected.length} 次，结果已写入 ${JIGOU_REPORTS_DATA_PATH}`);
  }

  // 主循环：浏览器常驻，每 10min 刷新一轮
  let round = 0;
  await runOnce();
  while (true) {
    round++;
    console.log(`\n========== 第 ${round} 轮刷新，等待 ${REFRESH_INTERVAL / 1000}s ==========\n`);
    await new Promise((r) => setTimeout(r, REFRESH_INTERVAL));
    await runOnce();
  }
}

module.exports = {
  getJigouReportsData,
  getRecentResearchReports,
  getJigouReportsDataWithResearch,
  fetchZsxqTopics,
};
