// 从 data/jigouReports.json 中读取数据
const fs = require('fs');
const path = require('path');
const { getBrowser, getOrCreatePage } = require('../utils/browser');

const JIGOU_REPORTS_DATA_PATH = path.join(__dirname, '../data/jigouReports.json');
const JIGOU_REPORTS_NEW_DATA_PATH = path.join(__dirname, '../data/jigouReportsNew.json');
const RESEARCH_REPORTS_MENU_PATH = path.join(__dirname, '../data/research_reports/menu.json');
const RESEARCH_REPORTS_DIR = path.join(__dirname, '../data/research_reports');

// ==================== Puppeteer 抓取配置 ====================
const LOGIN_URL = 'https://wx.zsxq.com/login';
const GROUP_URL = 'https://wx.zsxq.com/group/88882285412582';
const API_PREFIX = 'https://api.zsxq.com/v2/groups/88882285412582/topics?scope=all&count=20';
const MAX_COUNT = 5;
const REFRESH_INTERVAL = 30 * 60 * 1000; // 刷新间隔 30min

// 抓取状态（供手动刷新使用）
let _runOnce = null;
let _isFetching = false;

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
    // 保留 id（topic_id，供前端匹配新增标记）、title, text 和 create_time 字段
    const reports = dedupedTopics.map((t) => ({
      id: t.topic_id,
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

// ==================== 新增研报差异追踪 ====================
// jigouReportsNew.json 结构：
// {
//   lastSeenIds: string[],   // 上一次抓取时的 topic_id 集合（用于计算差异）
//   pendingNew: Array<{ id, title, text, createTime, addedAt }>  // 用户尚未查看的新增研报
// }

// 读取当前 jigouReports.json 中去重后的原始 topics（含 topic_id）
const getCurrentReportsRaw = () => {
  try {
    const data = fs.readFileSync(JIGOU_REPORTS_DATA_PATH, 'utf-8');
    const json = JSON.parse(data);
    const list = Array.isArray(json) ? json : [json];
    const topics = list.flatMap(item => item?.resp_data?.topics || []);
    const seen = new Set();
    return topics.filter(t => {
      if (!t.topic_id || seen.has(t.topic_id)) return false;
      seen.add(t.topic_id);
      return true;
    });
  } catch {
    return [];
  }
};

// 读取新增状态文件
const readNewState = () => {
  try {
    const raw = fs.readFileSync(JIGOU_REPORTS_NEW_DATA_PATH, 'utf-8');
    const state = JSON.parse(raw);
    if (!Array.isArray(state.lastSeenIds)) state.lastSeenIds = [];
    if (!Array.isArray(state.pendingNew)) state.pendingNew = [];
    return state;
  } catch {
    return { lastSeenIds: [], pendingNew: [] };
  }
};

// 抓取完成后调用：对比上次记录的 topic_id 集合，把新增研报追加到 pendingNew
const updateNewReports = () => {
  try {
    const currentTopics = getCurrentReportsRaw();
    const currentIds = new Set(currentTopics.map(t => t.topic_id));
    const state = readNewState();

    // 首次运行（无历史记录）：只初始化 lastSeenIds，不把已有数据标记为新增
    if (state.lastSeenIds.length === 0 && state.pendingNew.length === 0) {
      state.lastSeenIds = Array.from(currentIds);
      fs.writeFileSync(JIGOU_REPORTS_NEW_DATA_PATH, JSON.stringify(state, null, 2));
      console.log(`[new-reports] 首次初始化，记录 ${state.lastSeenIds.length} 个已有研报 id`);
      return;
    }

    const lastSeenSet = new Set(state.lastSeenIds);
    const pendingIds = new Set(state.pendingNew.map(r => r.id));
    const now = new Date().toISOString();
    let added = 0;
    currentTopics.forEach(t => {
      // 与前端过滤保持一致：跳过"电话会音频"
      if (lastSeenSet.has(t.topic_id)) return;
      if ((t.title || '').includes('电话会音频')) return;
      if (pendingIds.has(t.topic_id)) return;
      state.pendingNew.push({
        id: t.topic_id,
        title: t.title || '',
        text: t.talk?.text || '',
        createTime: t.create_time || '',
        addedAt: now,
      });
      added++;
    });

    state.lastSeenIds = Array.from(currentIds);
    fs.writeFileSync(JIGOU_REPORTS_NEW_DATA_PATH, JSON.stringify(state, null, 2));
    if (added > 0) {
      console.log(`[new-reports] 检测到 ${added} 条新增研报，pendingNew 共 ${state.pendingNew.length} 条`);
    }
  } catch (error) {
    console.error('[new-reports] 更新新增研报失败:', error.message);
  }
};

// 获取待查看的新增研报列表
const getPendingNewReports = () => {
  const state = readNewState();
  return { newReports: state.pendingNew, count: state.pendingNew.length };
};

// 用户打开页面后确认查看：清空 pendingNew（保留 lastSeenIds 用于后续差异计算）
const acknowledgeNewReports = () => {
  try {
    const state = readNewState();
    state.pendingNew = [];
    fs.writeFileSync(JIGOU_REPORTS_NEW_DATA_PATH, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
};

// ==================== Puppeteer 抓取逻辑 ====================
// getBrowser / getOrCreatePage 已抽离到 utils/browser.js，供 rihan / amount 等服务共享复用

/**
 * 初始化浏览器并等待登录（内部函数，供 fetchZsxqTopics 和 refreshJigouReports 共享）
 * @returns {Promise<{browser, page}>} 初始化后的浏览器和页面实例
 */
async function initBrowserAndLogin() {
  const browser = await getBrowser();
  const page = await getOrCreatePage(browser, 'zsxq.com');

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  const { windowId } = await browser._connection.send('Browser.getWindowForTarget', {
    targetId: page.target()._targetId,
  });
  const { bounds } = await browser._connection.send('Browser.getWindowBounds', { windowId });
  console.log(`[page] 浏览器窗口实际大小：${bounds.width}x${bounds.height}`);
  await page.setViewport({ width: bounds.width, height: bounds.height });

  // ====== 通过 CDP 强制页面保持 active 状态，防止后台节流 ======
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setWebLifecycleState', { state: 'active' });
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    console.log('[page] 已通过 CDP 强制页面保持 active 生命周期');
  } catch (e) {
    console.warn('[page] CDP 设置 active 状态失败（非致命）:', e.message);
  }

  const currentUrl = page.url();
  try {
    if (!currentUrl.includes('wx.zsxq.com')) {
      console.log('正在打开登录页...');
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log(`登录页已打开，当前 URL：${page.url()}`);
    } else {
      console.log('已在 zsxq 域名，导航到登录页判断登录态...');
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log(`当前 URL：${page.url()}`);
    }
  } catch (error) {
    console.error('打开登录页失败:', error.message);
    throw error;
  }

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

  await new Promise((r) => setTimeout(r, 2000));

  return { browser, page };
}

/**
 * 启动 puppeteer 抓取循环：打开登录页 → 等待登录 → 拦截接口 → 滚动 → 写入 data/jigouReports.json
 * 浏览器常驻，每 10min 刷新一轮。
 */
async function fetchZsxqTopics() {
  const { browser, page } = await initBrowserAndLogin();

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

  async function runOnce() {
    try {
      await scrapeOnceWithBrowser(browser, page, false);
    } catch (error) {
      console.error('runOnce 抓取任务失败:', error.message);
    }
  }

  _runOnce = runOnce;

  let round = 0;
  try {
    _isFetching = true;
    await runOnce();
  } catch (error) {
    console.error('首轮抓取失败:', error.message);
  } finally {
    _isFetching = false;
  }
  
  while (true) {
    try {
      round++;
      console.log(`\n========== 第 ${round} 轮刷新，等待 ${REFRESH_INTERVAL / 1000}s ==========\n`);
      await new Promise((r) => setTimeout(r, REFRESH_INTERVAL));
      if (_isFetching) {
        console.log('检测到正在抓取中（可能是手动触发），跳过本轮自动刷新');
        continue;
      }
      _isFetching = true;
      try {
        await runOnce();
      } finally {
        _isFetching = false;
      }
    } catch (error) {
      console.error(`第 ${round} 轮抓取循环异常:`, error.message);
      _isFetching = false;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * 执行单次抓取（内部函数，接受已初始化的 browser 和 page）
 * @param {Object} browser - puppeteer browser 实例
 * @param {Object} page - puppeteer page 实例
 * @param {boolean} isManual - 是否是手动触发
 */
async function scrapeOnceWithBrowser(browser, page, isManual = false) {
  const ctx = { collected: [] };

  page.removeAllListeners('response');
  page.on('response', async (response) => {
    const req = response.request();
    if (req.method() === 'OPTIONS') return;
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

  ctx.collected.length = 0;

  console.log('正在刷新页面...');
  await page.goto(GROUP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('页面已就绪，开始滚动加载...');

  // 导航后重新设置 active 状态（页面导航可能重置生命周期）
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setWebLifecycleState', { state: 'active' });
  } catch {}

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

    // 等待新接口响应（最多 6 秒），替代固定 setTimeout
    // 这样即使后台节流，只要接口被触发就能立即继续
    const beforeCount = ctx.collected.length;
    try {
      await page.waitForResponse(
        (res) => {
          const req = res.request();
          return req.method() === 'GET' && res.url().startsWith(API_PREFIX);
        },
        { timeout: 6000 },
      );
      // 接口返回后再短暂等待，确保 response handler 处理完毕
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // 超时未收到新接口响应，继续滚动
      console.log(`[scroll] 第 ${scrollTimes + 1} 次滚动后未收到新接口（当前 ${ctx.collected.length}/${MAX_COUNT}）`);
    }

    // 如果本次滚动没有新增数据，额外等待一下防止过快
    if (ctx.collected.length === beforeCount) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    scrollTimes++;
  }

  if (ctx.collected.length < MAX_COUNT) {
    console.warn(`仅拦截到 ${ctx.collected.length} 次接口（未满 ${MAX_COUNT} 次），可能是已无更多内容或滚动未触发加载。`);
  }

  fs.writeFileSync(JIGOU_REPORTS_DATA_PATH, JSON.stringify(ctx.collected, null, 2));
  console.log(`[完成] 本轮共拦截 ${ctx.collected.length} 次，结果已写入 ${JIGOU_REPORTS_DATA_PATH}`);

  // 对比上次抓取结果，记录新增研报
  updateNewReports();

  if (isManual) {
    browser.disconnect();
    console.log('[手动刷新] 已断开浏览器连接（浏览器保持运行）');
  }
}

/**
 * 手动触发一次抓取（复用已启动的浏览器实例，如果未启动则临时启动）
 * @returns {Promise<{reports: Array}>} 最新的研报数据
 */
async function refreshJigouReports() {
  if (_isFetching) {
    throw new Error('正在抓取中，请稍后再试');
  }
  _isFetching = true;
  try {
    if (_runOnce) {
      await _runOnce();
    } else {
      console.log('[手动刷新] --no-poll 模式下初始化浏览器...');
      const { browser, page } = await initBrowserAndLogin();
      await scrapeOnceWithBrowser(browser, page, true);
    }
  } finally {
    _isFetching = false;
  }
  return getJigouReportsData();
}

module.exports = {
  getJigouReportsData,
  getRecentResearchReports,
  getJigouReportsDataWithResearch,
  fetchZsxqTopics,
  refreshJigouReports,
  getPendingNewReports,
  acknowledgeNewReports,
};
