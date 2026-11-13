// 板块最大市值股数据池抓取脚本（离线跑一次，结果缓存到本地文件，供 /block_max_cap_stock 接口使用）
// 背景：东财 push2 clist 接口对高频请求限流（空回复），点击时实时查板块成分股会被限流。
// 方案：本脚本一次性抓取：
//   ① 东财全部板块（概念 m:90+t:2 + 行业 m:90+t:3）的成分股明细
//   ② 全市场个股总股本（东财 clist f84，去重后一股一值）
// 写入：
//   server/src/data/block_max_cap/block_constituents.json  { updatedAt, boards: { BK1071: { name, stocks: [{code,name}] } } }
//   server/src/data/block_max_cap/stock_shares.json        { updatedAt, shares: { '600000': 总股本(股) } }
// 用法：node src/scripts/fetchBlockMaxCapPool.js [--skip-boards]  （--skip-boards 只刷新总股本）
// 建议每天收盘后跑一次（股本极少变动，板块成分偶尔调整）。

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');

const OUTPUT_DIR = path.resolve(__dirname, '../data/block_max_cap');
const CONSTITUENTS_FILE = path.join(OUTPUT_DIR, 'block_constituents.json');
const SHARES_FILE = path.join(OUTPUT_DIR, 'stock_shares.json');

// 主域名 push2 偶发限流直接断开（空响应），回退 push2test 备用域名
const API_HOSTS = ['push2.eastmoney.com', 'push2test.eastmoney.com'];
const API_HEADERS = {
    Referer: 'https://data.eastmoney.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
};
const PAGE_SIZE = 500;
// 只保留沪深 A 股：深主板(000/001/002/003)、创业板(300/301)、沪主板(600/601/603/605)、科创板(688/689)
const STOCK_CODE_PREFIX = ['00', '30', '60', '68'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带备用域名 + 重试的 clist 请求；失败返回 null（不中断整体流程）
async function fetchClist(params, { retries = 3, label = '' } = {}) {
    for (let attempt = 0; attempt < retries; attempt++) {
        for (const host of API_HOSTS) {
            try {
                const resp = await axios.get(`https://${host}/api/qt/clist/get`, {
                    params,
                    headers: API_HEADERS,
                    timeout: 20000,
                });
                const data = resp.data && resp.data.data;
                if (!data || !Array.isArray(data.diff)) {
                    throw new Error('接口未返回数据');
                }
                return { total: data.total || 0, diff: data.diff };
            } catch (e) {
                console.warn(`[warn] ${label} ${host} 第 ${attempt + 1} 次失败: ${e.message}`);
            }
        }
        // 全部域名失败，退避后重试
        await sleep(2000 * (attempt + 1));
    }
    return null;
}

// 抓取全部板块清单：[{ code: 'BK1071', name }]
async function fetchAllBoards() {
    const boards = [];
    const seen = new Set();
    for (const [fsParam, label] of [['m:90+t:2', '概念板块'], ['m:90+t:3', '行业板块']]) {
        let page = 1;
        let totalPages = 1;
        do {
            const data = await fetchClist({
                pn: page,
                pz: PAGE_SIZE,
                po: 1,
                np: 1,
                fltt: 2,
                invt: 2,
                fid: 'f20',
                fs: fsParam,
                fields: 'f12,f14',
            }, { label: `${label}第${page}页` });
            if (!data) break;
            totalPages = Math.ceil(data.total / PAGE_SIZE);
            for (const item of data.diff) {
                if (item && item.f12 && !seen.has(item.f12)) {
                    seen.add(item.f12);
                    boards.push({ code: String(item.f12), name: item.f14 || item.f12 });
                }
            }
            page++;
            await sleep(300);
        } while (page <= totalPages);
        console.log(`[boards] ${label}：累计 ${boards.length} 个`);
    }
    return boards;
}

// 抓取单个板块成分股 [{code, name}]
async function fetchBoardStocks(board) {
    const stocks = [];
    const seen = new Set();
    let page = 1;
    let totalPages = 1;
    do {
        const data = await fetchClist({
            pn: page,
            pz: PAGE_SIZE,
            po: 1,
            np: 1,
            fltt: 2,
            invt: 2,
            fid: 'f6',
            fs: `b:${board.code}`,
            fields: 'f12,f14',
        }, { label: `${board.name}(${board.code})第${page}页` });
        if (!data) return null; // 该板块彻底失败，标记为 null
        totalPages = Math.ceil(data.total / PAGE_SIZE);
        for (const item of data.diff) {
            const code = String(item && item.f12 || '');
            if (code && STOCK_CODE_PREFIX.some((p) => code.startsWith(p)) && !seen.has(code)) {
                seen.add(code);
                stocks.push({ code, name: (item && item.f14) || code });
            }
        }
        page++;
        await sleep(200);
    } while (page <= totalPages);
    return stocks;
}

// 抓取总股本（腾讯批量行情，q=sh600519,sz000001,... 每批 60 只）：
// 股本 = 总市值(亿, 字段45) × 1e8 ÷ 最新价(字段3)。东财 clist f84 实测缺失/异常（茅台等缺值、
// 部分股票数值偏差一个量级），故弃用。响应为 GBK，但所需字段均为 ASCII 数字，按 latin1 拆分即可。
async function fetchAllSharesFromTencent(codes) {
    const shares = {};
    const BATCH = 60;
    const totalBatches = Math.ceil(codes.length / BATCH);
    for (let i = 0; i < codes.length; i += BATCH) {
        const batch = codes.slice(i, i + BATCH);
        const query = batch.map((c) => (/^6/.test(c) ? 'sh' : 'sz') + c).join(',');
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            try {
                const resp = await axios.get(`https://qt.gtimg.cn/q=${query}`, {
                    timeout: 10000,
                    responseType: 'arraybuffer',
                    headers: { Referer: 'https://gu.qq.com/' },
                });
                const text = Buffer.from(resp.data).toString('latin1');
                const re = /v_(?:sh|sz)(\d{6})="([^"]*)"/g;
                let m;
                let hit = 0;
                while ((m = re.exec(text)) !== null) {
                    const code = m[1];
                    const f = m[2].split('~');
                    const price = parseFloat(f[3]);
                    const totalCapYi = parseFloat(f[45]); // 总市值（亿元）
                    if (price > 0 && totalCapYi > 0) {
                        shares[code] = Math.round((totalCapYi * 1e8) / price);
                        hit++;
                    }
                }
                ok = true;
                const batchNo = Math.floor(i / BATCH) + 1;
                if (batchNo % 10 === 0 || batchNo === totalBatches) {
                    console.log(`[shares] 批次 ${batchNo}/${totalBatches}，本批 ${hit} 只，累计 ${Object.keys(shares).length}`);
                }
            } catch (e) {
                console.warn(`[warn] 股本批次 ${Math.floor(i / BATCH) + 1} 第 ${attempt + 1} 次失败: ${e.message}`);
                await sleep(1500);
            }
        }
        await sleep(200);
    }
    return shares;
}

async function main() {
    const skipBoards = process.argv.includes('--skip-boards');
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const startedAt = Date.now();

    // ① 板块成分股
    let boardsData = null;
    if (!skipBoards) {
        const boards = await fetchAllBoards();
        console.log(`\n[boards] 共 ${boards.length} 个板块，开始抓取成分股...`);
        const boardsMap = {};
        let failCount = 0;
        let stockSeen = 0;
        for (let i = 0; i < boards.length; i++) {
            const board = boards[i];
            const stocks = await fetchBoardStocks(board);
            if (stocks === null) {
                failCount++;
                console.error(`[error] 板块 ${board.name}(${board.code}) 抓取失败，跳过`);
                continue;
            }
            boardsMap[board.code] = { name: board.name, stocks };
            stockSeen = Math.max(stockSeen, stocks.length);
            if ((i + 1) % 50 === 0) {
                console.log(`[boards] 进度 ${i + 1}/${boards.length}，最大板块 ${stockSeen} 只`);
            }
        }
        boardsData = { updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'), boards: boardsMap };
        fs.writeFileSync(CONSTITUENTS_FILE, JSON.stringify(boardsData), 'utf-8');
        const totalStocks = Object.values(boardsMap).reduce((s, b) => s + b.stocks.length, 0);
        console.log(`[done] 板块成分股 → ${CONSTITUENTS_FILE}（${Object.keys(boardsMap).length} 个板块 / ${totalStocks} 条成分记录，失败 ${failCount} 个）`);
    } else {
        boardsData = JSON.parse(fs.readFileSync(CONSTITUENTS_FILE, 'utf-8'));
        console.log('[skip] 已跳过板块成分股抓取，使用现有文件');
    }

    // ② 板块内全部股票去重后，轮询抓取总股本
    const allStocks = new Set();
    Object.values(boardsData.boards || {}).forEach((b) => {
        (b.stocks || []).forEach((s) => allStocks.add(s.code));
    });
    const codes = [...allStocks].sort();
    console.log(`\n[shares] 板块内去重后共 ${codes.length} 只股票，开始轮询总股本（腾讯批量行情）...`);
    const shares = await fetchAllSharesFromTencent(codes);
    fs.writeFileSync(SHARES_FILE, JSON.stringify({
        updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        shares,
    }), 'utf-8');
    console.log(`[done] 总股本 → ${SHARES_FILE}（${Object.keys(shares).length} 只）`);

    console.log(`全部完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
    console.error(`[失败] ${e.message}`);
    process.exitCode = 1;
});
