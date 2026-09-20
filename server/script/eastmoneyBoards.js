// 东方财富概念板块列表抓取
// 用途：node script/eastmoneyBoards.js
// 打开 https://quote.eastmoney.com/center/gridlist.html#concept_board，
// 拦截 pushguest.eastmoney.com/api/qt/clist/get 的 JSONP 响应，
// 通过点击「下一页」翻页直到第 26 页，把所有板块 code（f12）与名称（f14）
// 写入 src/data/东方财富板块成分股汇总/成分股汇总.json
const path = require('path');
const fs = require('fs');
const { getBrowser, getOrCreatePage } = require('../src/utils/browser');

const TARGET_URL = 'https://quote.eastmoney.com/center/gridlist.html#concept_board';
// 兼容 pushguest / push2 两种推送域名，只匹配 clist/get 接口
const API_PATTERN = /push(guest|2)\.eastmoney\.com\/api\/qt\/clist\/get/;
const MAX_PAGE = 26;
const OUT_FILE = path.resolve(__dirname, '../src/data/东方财富板块成分股汇总/成分股汇总.json');

// JSONP 文本（jQueryxxx({...});）→ 对象
function parseJsonp(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end <= start) throw new Error('JSONP 格式解析失败');
  return JSON.parse(text.slice(start + 1, end));
}

// 响应 JSON → { total, items: [{code, name}] }
function extractBoards(json) {
  const data = json && json.data ? json.data : {};
  const diff = Array.isArray(data.diff) ? data.diff : [];
  const items = [];
  for (const d of diff) {
    if (d && d.f12 && d.f14) items.push({ code: String(d.f12), name: String(d.f14) });
  }
  return { total: data.total ?? null, items };
}

// 请求 URL 中的 fs 参数需为概念板块（m:90 t:3），排除行业/地域板块
function isConceptBoardRequest(searchParams) {
  const fsParam = searchParams.get('fs') || '';
  return /(?:^|\+)t:3(?:\+|$)/.test(fsParam) && fsParam.includes('m:90');
}

async function main() {
  const browser = await getBrowser();
  const page = await getOrCreatePage(browser, 'gridlist.html');
  await page.setViewport({ width: 1280, height: 800 });

  // pn -> { total, items }
  const pagesMap = new Map();
  // 排查用：记录见过的 eastmoney API 请求路径（失败时打印）
  const apiRequestsSeen = new Set();
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('eastmoney.com') && u.includes('api')) {
      apiRequestsSeen.add(u.split('?')[0]);
    }
  });
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!API_PATTERN.test(url)) return;
      const params = new URL(url).searchParams;
      const pn = parseInt(params.get('pn'), 10);
      if (!pn || !isConceptBoardRequest(params)) return;
      const text = await res.text();
      const { total, items } = extractBoards(parseJsonp(text));
      pagesMap.set(pn, { total, items });
      console.log(`[抓取] 第 ${pn} 页：${items.length} 条（total=${total}）`);
    } catch (e) {
      console.warn(`[warn] 响应解析失败：${e.message}`);
    }
  });

  async function waitForPage(pn, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pagesMap.has(pn)) return pagesMap.get(pn);
      await new Promise((r) => setTimeout(r, 150));
    }
    const seen = [...apiRequestsSeen].slice(0, 20).join('\n  ');
    throw new Error(`等待第 ${pn} 页响应超时（${timeoutMs}ms），已见过的 API 请求：\n  ${seen || '（无）'}`);
  }

  // 点击「下一页」：a[title="下一页"]
  function clickNextPage() {
    return page.evaluate(() => {
      const el = document.querySelector('a[title="下一页"]');
      if (!el) return false;
      el.click();
      return true;
    });
  }

  console.log(`[导航] ${TARGET_URL}`);
  if (!page.url().includes('gridlist.html')) {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  // 强制刷新一次：同 URL 仅 hash 差异的 goto 不会重新加载，会漏掉已发出的请求
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPage(1, 30000);

  for (let pn = 2; pn <= MAX_PAGE; pn++) {
    let ok = await clickNextPage();
    if (!ok) {
      console.warn(`[warn] 未找到「下一页」按钮（期望翻到第 ${pn} 页），提前结束`);
      break;
    }
    try {
      await waitForPage(pn);
    } catch (e) {
      // 点击可能因页面渲染时序丢失，重试一次
      console.warn(`[warn] ${e.message}，重试点击`);
      ok = await clickNextPage();
      if (!ok) break;
      await waitForPage(pn);
    }
  }

  // 按 pn 顺序合并去重
  const seen = new Set();
  const boards = [];
  let total = null;
  for (let pn = 1; pn <= MAX_PAGE; pn++) {
    const p = pagesMap.get(pn);
    if (!p) continue;
    if (total === null && p.total !== null) total = p.total;
    for (const item of p.items) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      boards.push(item);
    }
  }

  if (boards.length === 0) {
    throw new Error('未抓取到任何板块数据');
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(boards, null, 2) + '\n', 'utf8');

  console.log('='.repeat(50));
  console.log(`[完成] 接口 total=${total}，实际抓取 ${boards.length} 个板块（去重后）`);
  console.log(`[完成] 已写入：${OUT_FILE}`);
  console.log(`[示例] ${JSON.stringify(boards[0])} ... ${JSON.stringify(boards[boards.length - 1])}`);

  browser.disconnect();
}

main().catch((e) => {
  console.error(`[失败] ${e.message}`);
  process.exitCode = 1;
});
