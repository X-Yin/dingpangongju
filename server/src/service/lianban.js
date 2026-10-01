/**
 * 连板网（lianban.net）每日连板复盘数据抓取
 *
 * 数据页面：https://lianban.net/days/YYYY-MM-DD.html
 * 每个交易日 21:00 后抓取当日「热点题材」板块下的全部涨停个股（剔除 ST），
 * 区分板块 / 股票名称 / 股票代码，保存为 src/data/lianbanSnapshot/YYYYMMDD.json
 *
 * 页面结构：
 *  - 「热点题材」(id="s-themes") 下每个 <div class="thc"> 为一个板块，
 *    板块内 <div class="tk" data-c="股票代码"> 为个股（含封板时间/龙头★/连板标签/细分题材）
 *  - 页尾 var S = {...} 是以股票代码为 key 的完整数据对象（名称/板块/连板数/涨停原因/行情等）
 *  - ST 个股位于独立的 ST 板块，不在热点题材内，解析时再做一次 st 标记兜底剔除
 *  - 非交易日页面返回 404
 */
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils/tradingDay');

const lianbanDir = path.resolve(__dirname, '../data/lianbanSnapshot');
const cookieFile = path.resolve(__dirname, '../../.lianban-cookie');
const BASE_URL = 'https://lianban.net/days';

// 历史复盘页（非当日）必须登录后才会返回「热点题材」数据
// cookie 优先级：环境变量 LIANBAN_COOKIE > server/.lianban-cookie 文件
// 文件每次请求前实时读取，cookie 过期后直接更新文件即可，无需重启服务
const loadCookie = () => {
  if (process.env.LIANBAN_COOKIE) return process.env.LIANBAN_COOKIE.trim();
  try {
    if (fs.existsSync(cookieFile)) {
      return fs.readFileSync(cookieFile, 'utf8').trim();
    }
  } catch (e) {
    // 忽略读取失败，按无 cookie 处理
  }
  return '';
};

const HTTP_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const decodeEntities = (str) => String(str == null ? '' : str)
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const num = (val) => {
  if (val === '' || val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

// Date | dayjs | 'YYYYMMDD' | 'YYYY-MM-DD' | undefined(今天) -> { ymd, dash }
const normalizeDateInput = (input) => {
  if (input == null) {
    const d = dayjs();
    return { ymd: d.format('YYYYMMDD'), dash: d.format('YYYY-MM-DD') };
  }
  let d = null;
  if (dayjs.isDayjs(input)) {
    d = input;
  } else if (input instanceof Date) {
    d = dayjs(input);
  } else {
    const s = String(input).trim();
    if (/^\d{8}$/.test(s)) {
      d = dayjs(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      d = dayjs(s);
    }
  }
  if (!d || !d.isValid()) {
    throw new Error(`无法识别的日期: ${input}`);
  }
  return { ymd: d.format('YYYYMMDD'), dash: d.format('YYYY-MM-DD') };
};

class LianbanNoDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LianbanNoDataError';
    this.noRetry = true;
  }
}

// 浏览额度受限（HTTP 429 或限流页）：需要较长退避后重试
class LianbanRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LianbanRateLimitError';
  }
}

// 抓取某一天的复盘页 HTML
// - 非交易日 404：直接抛 LianbanNoDataError，不重试
// - 429/限流页：按 15s/45s/120s 退避重试
// - 200 但缺少热点题材：cookie 失效或需登录，抛出明确错误
const fetchDayHtml = async (dashDate, { retries = 3, timeout = 15000 } = {}) => {
  const url = `${BASE_URL}/${dashDate}.html`;
  let lastError = null;
  const rateLimitBackoff = [15000, 45000, 120000];

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers = {
        ...HTTP_HEADERS,
        referer: `https://lianban.net/login.html?src=day&back=%2Fdays%2F${dashDate}.html`,
      };
      const cookie = loadCookie();
      if (cookie) headers.Cookie = cookie;

      const res = await axios.get(url, {
        headers,
        timeout,
        // 直接拿原始 HTML 字符串，不让 axios 做 JSON 转换
        transformResponse: [(data) => data],
        // 404/429 均先放行，由下方按语义处理
        validateStatus: (status) => status < 500,
      });

      if (res.status === 404) {
        throw new LianbanNoDataError(`${dashDate} 页面不存在（非交易日或数据未生成，HTTP 404）`);
      }
      if (res.status === 429 || /浏览已达上限|浏览.*上限/.test(res.data)) {
        throw new LianbanRateLimitError(`${dashDate} 触发浏览频率/额度限制（HTTP 429）`);
      }
      if (res.status !== 200) {
        throw new Error(`${dashDate} 页面请求失败，HTTP ${res.status}`);
      }
      if (!/var\s+S\s*=\s*\{/.test(res.data)) {
        throw new Error(`${dashDate} 页面缺少 var S 数据（站点结构变化或需要更新登录态）`);
      }
      if (!/id="s-themes"/.test(res.data)) {
        throw new Error(`${dashDate} 页面缺少「热点题材」区块（历史页面需登录，请检查 .lianban-cookie 是否有效）`);
      }
      return res.data;
    } catch (error) {
      lastError = error;
      if (error.noRetry) throw error;
      if (attempt < retries) {
        const wait = error.name === 'LianbanRateLimitError'
          ? rateLimitBackoff[Math.min(attempt, rateLimitBackoff.length - 1)]
          : 1500 * (attempt + 1);
        if (error.name === 'LianbanRateLimitError') {
          console.log(`[lianban] ${error.message}，${Math.round(wait / 1000)}s 后重试（第 ${attempt + 1}/${retries} 次）`);
        }
        await sleep(wait);
      }
    }
  }
  throw lastError;
};

// 提取页尾 var S = {...} 股票数据对象（合法 JSON，可直接 parse）
const extractStockMap = (html) => {
  const m = html.match(/var\s+S\s*=\s*(\{[\s\S]*?\})\s*;\s*var\s+CUR\b/);
  if (!m) {
    throw new Error('未在页面中找到 var S 连板数据（站点结构可能已变化）');
  }
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`var S 数据 JSON 解析失败: ${e.message}`);
  }
};

const extractPageDate = (html) => {
  const m = html.match(/var\s+CUR\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/);
  return m ? m[1] : null;
};

// 解析「热点题材」HTML：板块顺序/题材理由，以及每只个股的龙头★/早盘标记/连板标签
// 返回 [{ rank, board, reason, stockOrder: [code...], stocks: Map(code -> info) }]
// 注意：股票代码全为数字，挂到普通对象上会被引擎按数组索引重排，必须用 Map 保序
const parseThemesHtml = (html) => {
  const startIdx = html.indexOf('id="s-themes"');
  if (startIdx === -1) return [];

  // 所有 thc 板块都在「展开剩余题材」按钮(csmore)之前
  const afterStart = html.slice(startIdx);
  const moreIdx = afterStart.indexOf('class="csmore"');
  const segment = moreIdx === -1 ? afterStart : afterStart.slice(0, moreIdx);

  const chunks = segment.split('<div class="thc">').slice(1);

  return chunks.map((chunk, index) => {
    const rankM = chunk.match(/<span class="r mono">\s*(\d+)\s*<\/span>/);
    const boardM = chunk.match(/<span class="nm">([\s\S]*?)<\/span>/);
    const reasonM = chunk.match(/<div class="thr">([\s\S]*?)<\/div>/);

    const stockOrder = [];
    const stocks = new Map();
    const tkRe = /<div class="tk" data-c="(\d+)"\s*>([\s\S]*?)<div class="cc">([\s\S]*?)<\/div>\s*<\/div>/g;
    let tkMatch;
    while ((tkMatch = tkRe.exec(chunk)) !== null) {
      const code = tkMatch[1];
      const head = tkMatch[2];
      const concept = decodeEntities(tkMatch[3]).trim();
      const nameM = head.match(/<span class="nm">([\s\S]*?)<\/span>/);
      const timeM = head.match(/<span class="tm mono[^"]*">\s*(\d{2}:\d{2})\s*<\/span>/);
      const ntM = head.match(/<span class="nt mono">([\s\S]*?)<\/span>/);
      stockOrder.push(code);
      stocks.set(code, {
        time: timeM ? timeM[1] : '',
        early: /class="tm mono early"/.test(head),
        leader: /<span class="cr">/.test(head),
        nt: ntM ? decodeEntities(ntM[1]).trim() : '',
        name: nameM ? decodeEntities(nameM[1]).trim() : '',
        concept,
      });
    }

    return {
      rank: rankM ? parseInt(rankM[1], 10) : index + 1,
      board: boardM ? decodeEntities(boardM[1]).trim() : '',
      reason: reasonM ? decodeEntities(reasonM[1]).trim() : '',
      stockOrder,
      stocks,
    };
  }).filter((t) => t.board);
};

// 合并 var S 行情数据与热点题材 HTML 展示信息
const buildStock = (code, sData, htmlInfo, board) => ({
  code,
  name: (sData?.n || htmlInfo?.name || '').trim(),
  board: sData?.board || board || '',
  marketCode: sData?.k || '',
  sealTime: sData?.t || htmlInfo?.time || '',
  early: !!(htmlInfo?.early),
  leader: !!(htmlInfo?.leader),
  lianbanCount: sData && Number.isFinite(Number(sData.lb)) ? Number(sData.lb) : null,
  // 以页面展示标签为准（如「反4天2板」），S.lbs 可能省略「反」字
  lianbanText: htmlInfo?.nt || sData?.lbs || '',
  fanbao: !!(sData?.fb),
  concept: (sData?.th || htmlInfo?.concept || '').trim(),
  concepts: sData?.cpt || '',
  reason: sData?.rs || '',
  quote: {
    price: num(sData?.p),                // 收盘价（元）
    changePct: num(sData?.pct),          // 涨跌幅（%）
    open: num(sData?.o),                 // 开盘价
    prevClose: num(sData?.yc),           // 昨收价
    amplitude: num(sData?.amp),          // 振幅（%）
    turnoverRate: num(sData?.vr),        // 换手率（%）
    amountWan: num(sData?.amt),          // 成交额（万元）
    pe: num(sData?.pe),
    pb: num(sData?.pb),
    floatMarketValueYi: num(sData?.ffmv), // 流通市值（亿元）
    totalMarketValueYi: num(sData?.tmv),  // 总市值（亿元）
    fmv: num(sData?.fmv),                 // 站点原始市值字段
    tn: num(sData?.tn),                   // 站点原始字段
  },
});

// 解析整页为结构化连板数据
const parseLianbanHtml = (html, requestDate) => {
  const stockMap = extractStockMap(html);
  const pageDate = extractPageDate(html);
  const htmlThemes = parseThemesHtml(html);

  const themes = htmlThemes.map((htmlTheme, index) => {
    const stocks = [];
    htmlTheme.stockOrder.forEach((code) => {
      const sData = stockMap[code];
      // 双保险：剔除 ST 个股（热点题材之外的 ST 板块不会进入这里）
      if (sData && (sData.st === true || sData.board === 'ST板块')) return;
      stocks.push(buildStock(code, sData, htmlTheme.stocks.get(code), htmlTheme.board));
    });
    return {
      rank: htmlTheme.rank || index + 1,
      board: htmlTheme.board,
      count: stocks.length,
      reason: htmlTheme.reason || null,
      stocks,
    };
  }).filter((theme) => theme.stocks.length > 0);

  const allStocks = themes.reduce((acc, t) => acc.concat(t.stocks), []);
  const summary = {
    totalCount: allStocks.length,
    themeCount: themes.length,
    lianbanCount: allStocks.filter((s) => Number(s.lianbanCount) >= 2).length,
    firstBoardCount: allStocks.filter((s) => s.lianbanCount === 1).length,
    leaderCount: allStocks.filter((s) => s.leader).length,
  };

  return {
    date: requestDate.ymd,
    pageDate: pageDate || requestDate.dash,
    sourceUrl: `${BASE_URL}/${requestDate.dash}.html`,
    fetchedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    summary,
    themes,
  };
};

const lianbanFilePath = (dateInput) => {
  const { ymd } = normalizeDateInput(dateInput);
  return path.join(lianbanDir, `${ymd}.json`);
};

// 抓取并保存某一天的连板数据，返回结构化结果
const saveLianbanDay = async (dateInput) => {
  const { ymd, dash } = normalizeDateInput(dateInput);
  ensureDir(lianbanDir);

  const html = await fetchDayHtml(dash);
  const data = parseLianbanHtml(html, { ymd, dash });
  if (data.themes.length === 0) {
    throw new Error(`${dash} 连板数据解析结果为空，跳过写入`);
  }

  fs.writeFileSync(path.join(lianbanDir, `${ymd}.json`), JSON.stringify(data, null, 2));
  return data;
};

const hasLianbanDay = (dateInput) => fs.existsSync(lianbanFilePath(dateInput));

const getLianbanDayData = (dateInput) => {
  const file = lianbanFilePath(dateInput);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const getAvailableLianbanDates = () => {
  ensureDir(lianbanDir);
  return fs.readdirSync(lianbanDir)
    .filter((f) => /^\d{8}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort((a, b) => b.localeCompare(a));
};

// 每个交易日晚 21:00 自动抓取当日连板数据；失败不占位，下一分钟自动重试
let lianbanScheduled = false;
let lianbanTaskRunning = false;
const executedDates = new Set();

const scheduleLianbanDaily = (hour = 21, minute = 30) => {
  if (lianbanScheduled) return;
  lianbanScheduled = true;

  const task = async () => {
    // 上一轮（含 429 退避重试）尚未结束时不重入，避免请求叠加
    if (lianbanTaskRunning) return;
    const now = dayjs();
    const ymd = now.format('YYYYMMDD');

    // 非交易日（周末/节假日，以交易日历为准）不执行
    if (!isTradingDay(now.toDate())) return;
    if (executedDates.has(ymd)) return;

    const targetTime = now.hour(hour).minute(minute).second(0).millisecond(0);
    if (!now.isAfter(targetTime)) return;

    lianbanTaskRunning = true;
    try {
      const data = await saveLianbanDay(ymd);
      executedDates.add(ymd);
      console.log(`[lianban] ${ymd} 连板数据已保存：${data.summary.themeCount} 个题材 / ${data.summary.totalCount} 只涨停（其中连板 ${data.summary.lianbanCount} 只）`);
    } catch (error) {
      if (error.noRetry) {
        // 404 等当日无数据情况：占位避免整晚报错，下个交易日重新判定
        executedDates.add(ymd);
        console.log(`[lianban] ${ymd} 无连板数据可抓取：${error.message}`);
        return;
      }
      console.error(`[lianban] ${ymd} 连板数据抓取失败，下一分钟重试:`, error.message);
    } finally {
      lianbanTaskRunning = false;
    }
  };

  task();
  setInterval(task, 60 * 1000);
  console.log(`[lianban] 连板数据每日定时抓取已调度：交易日 ${hour}:${String(minute).padStart(2, '0')} 后自动执行`);
};

module.exports = {
  fetchDayHtml,
  parseLianbanHtml,
  parseThemesHtml,
  saveLianbanDay,
  hasLianbanDay,
  getLianbanDayData,
  getAvailableLianbanDates,
  lianbanFilePath,
  scheduleLianbanDaily,
  normalizeDateInput,
  LianbanNoDataError,
};
