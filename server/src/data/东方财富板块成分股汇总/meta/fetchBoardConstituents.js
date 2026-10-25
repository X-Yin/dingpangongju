// 东方财富板块成分股汇总抓取
// 用途：根据 meta 同目录 东财板块到本地板块map.json 的「分类 → 东财板块代码」映射，
//       逐个打开 data.eastmoney.com/bkzj/{BK代码}.html 成分股列表页，
//       拦截 push2.eastmoney.com/api/qt/clist/get 响应并点击「下一页」翻页，
//       把分类下所有板块的成分股去重合并后写入上级目录 {分类}.json（格式 [{code,name}]）；
//       同时写入 {分类}_blocks.json（格式 {板块名: [{code,name}]}，保留每个板块的成分股明细，
//       供「板块成交量占比计算」按子题材拆分成交额使用）。
// 用法（在 东方财富板块成分股汇总 目录下执行）：
//   node meta/fetchBoardConstituents.js              抓取 map 中全部分类（电力/医药/消费/农业）
//   node meta/fetchBoardConstituents.js 农业 消费     只抓取指定分类
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getBrowser } = require('../../../utils/browser');

const META_DIR = __dirname;
const OUTPUT_DIR = path.resolve(__dirname, '..');
const MAP_FILE = path.join(META_DIR, '东财板块到本地板块map.json');

const PAGE_SIZE = 50; // bkzj 页面成分股每页 50 条
const PAGE_WAIT_TIMEOUT = 15000;

// 优先走 clist 数据接口（一次可返回全部成分股，不依赖浏览器与页面渲染）。
// 主域名 push2 偶发限流会直接断开连接（空响应），此时回退到 push2test 备用域名。
const API_HOSTS = ['push2.eastmoney.com', 'push2test.eastmoney.com'];
const API_PAGE_SIZE = 500; // 单次请求最多返回条数（实测 500 可一次性取回整板块）
const API_HEADERS = {
  Referer: 'https://data.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
};
// 只保留沪深 A 股：深主板(000/001/002/003)、创业板(300/301)、沪主板(600/601/603/605)、科创板(688/689)
const STOCK_CODE_PREFIX = ['00', '30', '60', '68'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseJsonp = (jsonpString) => {
  const match = jsonpString.match(/^[^(]*\((.*)\);?$/);
  return match && match[1] ? JSON.parse(match[1]) : null;
};

// 抓取单个板块（BK 代码）的全部成分股
async function fetchBlockStocks(page, blockCode) {
  const url = `https://data.eastmoney.com/bkzj/${blockCode}.html`;
  const stocks = [];
  const seen = new Set();
  let totalPages = 1;
  let currentPage = 1;

  // 等待并收集一页 clist 响应（15s 超时兜底）
  const collectPageData = () => new Promise((resolve) => {
    const handler = async (response) => {
      try {
        const responseUrl = response.url();
        if (!/push(2|guest)\.eastmoney\.com\/api\/qt\/clist\/get/.test(responseUrl)) return;
        const fsParam = new URL(responseUrl).searchParams.get('fs') || '';
        if (!fsParam.includes(`b:${blockCode}`)) return;

        const text = await response.text();
        const data = parseJsonp(text);
        if (data && data.data && data.data.diff) {
          totalPages = Math.ceil((data.data.total || 0) / PAGE_SIZE);
          for (const item of data.data.diff) {
            if (item && item.f12 && !seen.has(item.f12)) {
              seen.add(item.f12);
              stocks.push({ code: item.f12, name: item.f14 });
            }
          }
          console.log(`    第 ${currentPage} 页：累计 ${stocks.length} 只，共 ${totalPages} 页`);
        }
        page.off('response', handler);
        resolve();
      } catch (e) {
        console.error(`    解析响应失败: ${e.message}`);
      }
    };
    page.on('response', handler);
    setTimeout(() => {
      page.off('response', handler);
      resolve();
    }, PAGE_WAIT_TIMEOUT);
  });

  try {
    console.log(`  打开页面: ${url}`);
    const firstCollect = collectPageData();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await firstCollect;

    await sleep(1500);
    currentPage++;

    while (currentPage <= totalPages) {
      await page.waitForSelector('.dataview-pagination .pagerbox', { timeout: 10000 });

      const nextPageNum = await page.evaluate(() => {
        const pagination = document.querySelector('.dataview-pagination .pagerbox');
        if (!pagination) return null;
        const links = pagination.querySelectorAll('a');
        const nextLink = links[links.length - 1];
        if (!nextLink || nextLink.textContent.trim() !== '下一页') return null;
        return nextLink.getAttribute('data-page');
      });

      if (!nextPageNum || parseInt(nextPageNum, 10) > totalPages) {
        console.log('    已到达最后一页或未找到下一页按钮');
        break;
      }

      const collectPromise = collectPageData();
      await page.evaluate(() => {
        const pagination = document.querySelector('.dataview-pagination .pagerbox');
        if (!pagination) return;
        const links = pagination.querySelectorAll('a');
        const nextLink = links[links.length - 1];
        if (nextLink && nextLink.textContent.trim() === '下一页') {
          nextLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => nextLink.click(), 500);
        }
      });

      await collectPromise;
      await sleep(1000);
      currentPage++;
    }
  } catch (e) {
    console.error(`  板块 ${blockCode} 抓取失败: ${e.message}`);
  }

  const filtered = stocks.filter((s) => STOCK_CODE_PREFIX.some((p) => (s.code || '').startsWith(p)));
  console.log(`  板块 ${blockCode} 共 ${stocks.length} 只，过滤后（沪深A股：主板/创业板/科创板）${filtered.length} 只`);
  return filtered;
}

// 通过 clist 数据接口抓取单个板块成分股（依次尝试 API_HOSTS，全部失败返回 null 以便回退到页面方式）
async function fetchBlockStocksByApi(blockCode) {
  for (const host of API_HOSTS) {
    try {
      const stocks = [];
      const seen = new Set();
      let page = 1;
      let totalPages = 1;

      do {
        const response = await axios.get(`https://${host}/api/qt/clist/get`, {
          params: {
            pn: page,
            pz: API_PAGE_SIZE,
            po: 1,
            np: 1,
            fltt: 2,
            invt: 2,
            fid: 'f6',
            fs: `b:${blockCode}`,
            fields: 'f12,f14',
          },
          headers: API_HEADERS,
          timeout: 20000,
        });

        const data = response.data && response.data.data;
        if (!data || !Array.isArray(data.diff)) {
          throw new Error('接口未返回成分股数据');
        }
        totalPages = Math.ceil((data.total || 0) / API_PAGE_SIZE);
        for (const item of data.diff) {
          if (item && item.f12 && !seen.has(item.f12)) {
            seen.add(item.f12);
            stocks.push({ code: String(item.f12), name: item.f14 });
          }
        }
        page++;
        if (page <= totalPages) await sleep(300);
      } while (page <= totalPages);

      const filtered = stocks.filter((s) => STOCK_CODE_PREFIX.some((p) => s.code.startsWith(p)));
      console.log(`  板块 ${blockCode} 共 ${stocks.length} 只，过滤后（沪深A股：主板/创业板/科创板）${filtered.length} 只（接口 ${host}）`);
      return filtered;
    } catch (e) {
      console.warn(`  接口域名 ${host} 抓取失败: ${e.message}`);
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const mapData = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
  const categoryNames = args.length ? args : Object.keys(mapData);

  let browser = null; // 仅当接口抓取失败、需要回退到页面方式时才启动浏览器
  let page = null;
  const ensurePage = async () => {
    if (page) return page;
    browser = await getBrowser();
    page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setDefaultTimeout(60000);
    await page.setUserAgent(API_HEADERS['User-Agent']);
    return page;
  };

  try {
    for (const name of categoryNames) {
      const blocks = mapData[name];
      if (!Array.isArray(blocks) || blocks.length === 0) {
        console.warn(`[warn] map 中不存在分类「${name}」，跳过`);
        continue;
      }

      console.log(`\n===== 分类：${name}（${blocks.length} 个板块）=====`);
      const merged = new Map();
      const blockStocksMap = {}; // 板块名 → 成分股明细

      for (const block of blocks) {
        console.log(`--- 板块 ${block.name} (${block.code}) ---`);
        const apiStocks = await fetchBlockStocksByApi(block.code);
        const stocks = apiStocks !== null ? apiStocks : await fetchBlockStocks(await ensurePage(), block.code);
        blockStocksMap[block.name] = stocks;
        let newCount = 0;
        for (const s of stocks) {
          if (!merged.has(s.code)) {
            merged.set(s.code, s.name);
            newCount++;
          }
        }
        console.log(`  新增 ${newCount} 只，去重后累计 ${merged.size} 只`);
      }

      const result = Array.from(merged.entries())
        .map(([code, nm]) => ({ code, name: nm }))
        .sort((a, b) => a.code.localeCompare(b.code));

      const outFile = path.join(OUTPUT_DIR, `${name}.json`);
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf-8');
      console.log(`[完成] ${name}: ${result.length} 只股票 → ${outFile}`);

      const blocksFile = path.join(OUTPUT_DIR, `${name}_blocks.json`);
      fs.writeFileSync(blocksFile, JSON.stringify(blockStocksMap, null, 2) + '\n', 'utf-8');
      console.log(`[完成] ${name} 板块明细（${Object.keys(blockStocksMap).length} 个板块）→ ${blocksFile}`);
    }
  } finally {
    if (page && !page.isClosed()) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    if (browser) browser.disconnect();
  }
}

main().catch((e) => {
  console.error(`[失败] ${e.message}`);
  process.exitCode = 1;
});
