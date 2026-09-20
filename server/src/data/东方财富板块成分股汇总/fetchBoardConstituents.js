// 东方财富板块成分股汇总抓取
// 用途：根据同目录 东财板块到本地板块map.json 的「分类 → 东财板块代码」映射，
//       逐个打开 data.eastmoney.com/bkzj/{BK代码}.html 成分股列表页，
//       拦截 push2.eastmoney.com/api/qt/clist/get 响应并点击「下一页」翻页，
//       把分类下所有板块的成分股去重合并后写入同目录 {分类}.json（格式 [{code,name}]）。
// 用法：
//   node fetchBoardConstituents.js              抓取 map 中全部分类（电力/医药/消费/农业）
//   node fetchBoardConstituents.js 农业 消费     只抓取指定分类
const fs = require('fs');
const path = require('path');
const { getBrowser } = require('../../utils/browser');

const DIR = __dirname;
const MAP_FILE = path.join(DIR, '东财板块到本地板块map.json');

const PAGE_SIZE = 50; // bkzj 页面成分股每页 50 条
const PAGE_WAIT_TIMEOUT = 15000;
const STOCK_CODE_PREFIX = ['3', '6', '0']; // 只保留沪深 A 股（与 block_amount_money.js 口径一致）

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
  console.log(`  板块 ${blockCode} 共 ${stocks.length} 只，过滤后（3/6/0开头）${filtered.length} 只`);
  return filtered;
}

async function main() {
  const args = process.argv.slice(2);
  const mapData = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
  const categoryNames = args.length ? args : Object.keys(mapData);

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setDefaultTimeout(60000);
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');

  try {
    for (const name of categoryNames) {
      const blocks = mapData[name];
      if (!Array.isArray(blocks) || blocks.length === 0) {
        console.warn(`[warn] map 中不存在分类「${name}」，跳过`);
        continue;
      }

      console.log(`\n===== 分类：${name}（${blocks.length} 个板块）=====`);
      const merged = new Map();

      for (const block of blocks) {
        console.log(`--- 板块 ${block.name} (${block.code}) ---`);
        const stocks = await fetchBlockStocks(page, block.code);
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

      const outFile = path.join(DIR, `${name}.json`);
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf-8');
      console.log(`[完成] ${name}: ${result.length} 只股票 → ${outFile}`);
    }
  } finally {
    if (page && !page.isClosed()) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    browser.disconnect();
  }
}

main().catch((e) => {
  console.error(`[失败] ${e.message}`);
  process.exitCode = 1;
});
