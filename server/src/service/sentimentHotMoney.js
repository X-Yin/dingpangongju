// 训练营 - 情绪游资系列策略回测
// 与自选股系列策略不同：不依赖后端资金快照/回放缓存数据，直接用日K线 + 分钟级分时回测，
// 日期范围不受 fundSnapshot 交易日限制（交易日历来自创业板指日K线）。
// 选股（每日用前一交易日数据判定）：
//   前提1：前一交易日登上同花顺龙虎榜（data.10jqka.com.cn/ifmarket/lhbtable）
//   前提2：主板股票（60/00 开头）且非 ST（名称含 ST/退 的剔除）
//   策略标的：
//     - hot_money_3d/5d/10d_gain：截至前一交易日收盘，最近 N 个交易日累计涨幅最大的候选股
//     - hot_money_first_board：最近 5 个交易日内，昨日为第一个涨停板（涨幅 >= 9.5%）
//     - hot_money_second_board：前日与昨日均为涨停板（首板/二板多只候选时取当日最先触发买入的）
// 买点（环境条件按前一交易日收盘数据计算）：
//   创业板指 5 日线斜率 < 0 且 10 日线斜率 < 0，且银行板块（同花顺 881155）5 日线斜率 > 0
//   （斜率口径与 calcDailyMaInfo 一致：当前 MA − 5 日前 MA）
//   满足环境条件时，候选股盘中涨幅超过 8% 即买入（按触发分钟价格成交）
// 卖点（买入次日起生效）：
//   1) 当日触及跌停价（前收 × 0.90）→ 按触发分钟价格卖出
//   2) 14:57 价格跌破 5 日线（按前一交易日收盘口径的 MA5）→ 按 14:57 价格卖出
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const iconv = require('iconv-lite');
const { getThsKlineUrl, getThsKlineHeaders, timestampToDateStr } = require('../utils');
const { getSingleStockData, getSingleStockTlineDataByDate } = require('./stock');
const { beijingToday } = require('./trainingCamp');
const { batchParallel } = require('../utils');

const DATA_DIR = path.resolve(__dirname, '../data/sentiment_hot_money');
const KLINE_CACHE_DIR = path.resolve(__dirname, '../data/kline_cache'); // 与训练营日K线文件缓存同目录同格式 { fetchedAt, kline }

const BANK_CODE = '881155'; // 同花顺银行板块指数
const BANK_MARKET = '48';
const CYB_CODE = '399006'; // 创业板指（同花顺市场代码 32）
const GAIN_BUY_TRIGGER_PCT = 8; // 盘中涨幅超过 8% 买入
const ONE_WORD_BOARD_OPEN_PCT = 9.6; // 9:30 竞价开盘涨幅达到此值视为一字板（开盘即封板买不进去），剔除不参与买入
const WAVE_MIN_20D_GAIN = 60; // 龙二波：前期 20 个交易日累计涨幅必须 > 60%
const WAVE_MAX_5D_FLUCTUATION = 20; // 龙二波：最近 5 个交易日收盘价上下波动幅度必须 < 20%
const WEAK_STRONG_MIN_VOLUME_RATIO = 1.4; // 弱转强：昨日量能 >= 前日量能 × 1.4（放大 40% 以上）
const WEAK_STRONG_MIN_GAP_PCT = 2; // 弱转强：当日高开 2% 以上（分时第一分钟涨幅）
const WEAK_STRONG_LOOKBACK = 20; // 弱转强：前期涨停板统计窗口（截至昨日的最近 20 个交易日）
const WEAK_STRONG_MIN_LIMIT_UPS = 2; // 弱转强：前期（20 个交易日内）至少出现过的涨停板个数
const LIMIT_UP_PCT = 9.5; // 涨幅 >= 9.5% 视为涨停板
const BOARD_WINDOW = 5; // 首板判定窗口：最近 5 个交易日
const SENTIMENT_DEFAULT_DAYS = 60; // 情绪游资默认回测最近 60 个交易日

// ===== 策略定义（buySellBacktest.STRATEGIES 会合并本表） =====
const SENTIMENT_STRATEGIES = {
  hot_money_3d_gain: {
    id: 'hot_money_3d_gain', name: '情绪游资-3日涨幅最大', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，截至前一交易日收盘最近3个交易日累计涨幅最大的一只；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正（按前一交易日收盘数据计算）时，该股盘中涨幅超过8%即买入；卖点：14:57价格跌破5日线（前收口径）或当日触及跌停价',
  },
  hot_money_5d_gain: {
    id: 'hot_money_5d_gain', name: '情绪游资-5日涨幅最大', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，截至前一交易日收盘最近5个交易日累计涨幅最大的一只；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正（按前一交易日收盘数据计算）时，该股盘中涨幅超过8%即买入；卖点：14:57价格跌破5日线（前收口径）或当日触及跌停价',
  },
  hot_money_10d_gain: {
    id: 'hot_money_10d_gain', name: '情绪游资-10日涨幅最大', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，截至前一交易日收盘最近10个交易日累计涨幅最大的一只；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正（按前一交易日收盘数据计算）时，该股盘中涨幅超过8%即买入；卖点：14:57价格跌破5日线（前收口径）或当日触及跌停价',
  },
  hot_money_first_board: {
    id: 'hot_money_first_board', name: '情绪游资-昨日首板', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，最近5个交易日内昨日为第一个涨停板（涨幅>=9.5%）的股票；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正时，候选股盘中涨幅超过8%即买入（多只候选取当日最先触发的一只）；卖点：14:57价格跌破5日线（前收口径）或当日触及跌停价',
  },
  hot_money_second_board: {
    id: 'hot_money_second_board', name: '情绪游资-昨日二板', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，前日与昨日均为涨停板（涨幅>=9.5%）的股票；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正时，候选股盘中涨幅超过8%即买入（多只候选取当日最先触发的一只）；卖点：14:57价格跌破5日线（前收口径）或当日触及跌停价',
  },
  hot_money_3d_slope: {
    id: 'hot_money_3d_slope', name: '情绪游资-3日线斜率最陡峭', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，3日涨幅均线斜率（角度，口径同常规策略：最近3个交易日日涨幅均值与前3个交易日均值之差转角度，按前一交易日收盘数据）最陡峭的一只，最陡峭的若竞价一字板开盘（>=9.6% 买不进）则顺延买第二陡峭的，以此类推；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正时，标的盘中涨幅超过8%即买入；卖点：当日触及跌停价或14:57价格跌破5日线（前收口径）',
  },
  hot_money_5d_slope: {
    id: 'hot_money_5d_slope', name: '情绪游资-5日线斜率最陡峭', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，5日涨幅均线斜率（角度，口径同常规策略：最近5个交易日日涨幅均值与前5个交易日均值之差转角度，按前一交易日收盘数据）最陡峭的一只，最陡峭的若竞价一字板开盘（>=9.6% 买不进）则顺延买第二陡峭的，以此类推；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正时，标的盘中涨幅超过8%即买入；卖点：当日触及跌停价或14:57价格跌破5日线（前收口径）',
  },
  hot_money_2nd_wave: {
    id: 'hot_money_2nd_wave', name: '情绪游资-龙二波', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，截至昨日收盘过去20个交易日累计涨幅>60%，且最近5个交易日收盘价上下波动幅度<20%、最近5个交易日内无涨停板（日涨幅>=9.5%，前期大涨后横盘整理）的股票；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正时，候选股盘中涨幅冲击8%即买入（多候选取当日最先触发的一只，一字板剔除；当日无触发则不买）；卖点：当日触及跌停价或14:57价格跌破5日线（前收口径）',
  },
  hot_money_weak_to_strong: {
    id: 'hot_money_weak_to_strong', name: '情绪游资-弱转强', hotMoney: true,
    desc: '选股：前一交易日登龙虎榜的主板非ST股中，昨日量能放大至前日量能的1.4倍以上（放大40%以上），且前期（截至昨日的最近20个交易日）至少出现过2个涨停板（日涨幅>=9.5%，不要求连续）的股票；买点：创业板指5日线斜率与10日线斜率均为负、银行板块5日线斜率为正，且今日高开2%以上（分时第一分钟涨幅过滤）时，候选股盘中涨幅冲击8%即买入（多候选取当日最先触发的一只，一字板剔除；当日无触发则不买）；卖点：当日触及跌停价或14:57价格跌破5日线（前收口径）',
  },
};

const SENTIMENT_HOT_MONEY_IDS = Object.keys(SENTIMENT_STRATEGIES);
const isSentimentStrategy = (id) => Object.prototype.hasOwnProperty.call(SENTIMENT_STRATEGIES, id);

// ============================================================
// 文件缓存工具
// ============================================================
const readJsonCache = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
};
const writeJsonCache = (file, data) => {
  try {
    if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) { /* 写缓存失败不影响主流程 */ }
};

// ============================================================
// 指数/板块日K线（创业板指、银行板块）
// ============================================================
// 通过同花顺 single_kline 接口拉取指数/板块日K（仅收盘价），返回 [{ trade_date, close_px }] 升序
const fetchThsIndexDailyKline = async (pureCode, market, limit) => {
  const url = getThsKlineUrl();
  const headers = getThsKlineHeaders();
  const body = {
    code_list: [{ codes: [pureCode], market }],
    trade_class: 'intraday',
    time_period: 'day_1',
    trade_date: -1,
    begin_time: -limit,
    end_time: 0,
    adjust_type: 'forward',
    gpid: 1,
  };
  const resp = await axios.post(url, body, { headers, timeout: 15000 });
  if (resp.data?.status_code !== 0) return [];
  const value = resp.data?.data?.quote_data?.[0]?.value || [];
  return value
    .filter(item => Array.isArray(item) && item.length >= 5)
    .map(item => ({ trade_date: parseInt(timestampToDateStr(item[0])), close_px: Number(item[4]) }))
    .filter(k => Number.isFinite(k.trade_date) && Number.isFinite(k.close_px) && k.close_px > 0)
    .sort((a, b) => a.trade_date - b.trade_date);
};

// 带文件缓存（当日有效）的指数/板块日K加载
const loadIndexKline = async (cacheName, pureCode, market, limit) => {
  const file = path.join(DATA_DIR, cacheName);
  const cached = readJsonCache(file);
  if (cached && cached.fetchedAt === beijingToday() && Array.isArray(cached.kline) && cached.kline.length > 0) {
    return cached.kline;
  }
  let kline = [];
  try { kline = await fetchThsIndexDailyKline(pureCode, market, limit); } catch (e) { /* 失败返回空 */ }
  if (kline.length > 0) writeJsonCache(file, { fetchedAt: beijingToday(), kline });
  return kline;
};

const getBankKline = () => loadIndexKline('bank_kline.json', BANK_CODE, BANK_MARKET, 400);
const getCybKline = () => loadIndexKline('cyb_kline.json', CYB_CODE, '32', 500);

// ============================================================
// 交易日历：来自创业板指日K线（剔除当日，仅保留已完结交易日）
// ============================================================
let calendarCache = null;
const getTradingCalendar = async () => {
  if (calendarCache && calendarCache.length > 0) return calendarCache;
  const kline = await getCybKline();
  const today = Number(beijingToday());
  calendarCache = [...new Set((kline || []).map(k => Number(k.trade_date)).filter(Number.isFinite))]
    .filter(d => d < today)
    .sort((a, b) => a - b)
    .map(String);
  return calendarCache;
};

// 情绪游资默认回测范围：最近 60 个已完结交易日
const getSentimentDefaultRange = async () => {
  const cal = await getTradingCalendar();
  if (!cal || cal.length === 0) return null;
  const end = cal[cal.length - 1];
  const start = cal[Math.max(0, cal.length - SENTIMENT_DEFAULT_DAYS)];
  return { startDate: start, endDate: end };
};

// ============================================================
// 龙虎榜数据（同花顺 data.10jqka.com.cn，HTML 表格解析）
// ============================================================
const lhbUrl = (dateStr) =>
  `https://data.10jqka.com.cn/ifmarket/lhbtable/report/${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}/tab/all/field/STOCKCODE/sort/asc/`;

// 同花顺数据站会话 token（与 cookie 中 v= 一致；失效时用浏览器复制更新）
const THS_DATA_TOKEN = 'A9859sJEyTkfnc0lWkgmpABRaDhsRDppTZM1yHEpew7VAPEmeRTDNl1oxyKC';
const lhbHeaders = () => ({
  'accept': 'text/html, */*; q=0.01',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cookie': `v=${THS_DATA_TOKEN}; _ga=GA1.1.1477206887.1776152186; _ga_H2RK0R0681=GS2.1.s1789867713$o16$g1$t1789868769$j60$l0$h0`,
  'referer': 'https://data.10jqka.com.cn/market/longhu/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
  'hexin-v': THS_DATA_TOKEN,
});

// 解析龙虎榜 HTML：提取 <tr> 中的 6 位代码与股票名（含连续 N 日上榜行，均属当日龙虎榜）
const parseLhbHtml = (html) => {
  const stocks = [];
  const seen = new Set();
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    const codeM = row.match(/<td[^>]*>\s*(\d{6})\s*<\/td>/);
    const nameM = row.match(/class="stock"[^>]*>([^<]+)<\/a>/);
    if (!codeM || !nameM) continue;
    const code = codeM[1];
    if (seen.has(code)) continue;
    seen.add(code);
    stocks.push({ code, name: nameM[1].trim() });
  }
  return stocks;
};

const fetchLhbStocks = async (dateStr) => {
  try {
    // 同花顺龙虎榜页面为 GBK 编码，必须显式按 GBK 解码（axios 默认按 UTF-8 解码会把中文名称变成乱码）
    const resp = await axios.get(lhbUrl(dateStr), { headers: lhbHeaders(), timeout: 15000, responseType: 'arraybuffer' });
    const html = iconv.decode(Buffer.from(resp.data || ''), 'gbk');
    return parseLhbHtml(html);
  } catch (e) {
    console.error(`龙虎榜数据获取失败 ${dateStr}: ${e.message}`);
    return [];
  }
};

const lhbMemCache = new Map();
// 获取某交易日龙虎榜个股列表（文件缓存；空结果不落盘，避免接口异常污染缓存）
const getLhbStocks = async (dateStr) => {
  if (lhbMemCache.has(dateStr)) return lhbMemCache.get(dateStr);
  const file = path.join(DATA_DIR, `lhb_${dateStr}.json`);
  const cached = readJsonCache(file);
  if (cached && Array.isArray(cached.stocks) && cached.stocks.length > 0) {
    lhbMemCache.set(dateStr, cached.stocks);
    return cached.stocks;
  }
  const stocks = await fetchLhbStocks(dateStr);
  if (stocks.length > 0) {
    writeJsonCache(file, { date: dateStr, stocks });
    lhbMemCache.set(dateStr, stocks);
  } else {
    console.warn(`龙虎榜数据为空 ${dateStr}（可能 token 失效或接口变更，请检查）`);
  }
  return stocks;
};

// ============================================================
// 个股日K线（任意龙虎榜股票，文件缓存跨进程共享）
// ============================================================
const stockKlineMem = new Map();
const getStockDailyKline = async (code) => {
  if (stockKlineMem.has(code)) return stockKlineMem.get(code);
  const file = path.join(KLINE_CACHE_DIR, `${code}.json`);
  const cached = readJsonCache(file);
  if (cached && cached.fetchedAt === beijingToday() && Array.isArray(cached.kline) && cached.kline.length > 0) {
    stockKlineMem.set(code, cached.kline);
    return cached.kline;
  }
  let kline = [];
  try { kline = (await getSingleStockData(code, 280)) || []; } catch (e) { /* 失败返回空 */ }
  if (kline.length > 0) writeJsonCache(file, { fetchedAt: beijingToday(), kline });
  stockKlineMem.set(code, kline);
  return kline;
};

// 个股日K收盘序列 [{ d, c, v }] 升序（d=YYYYMMDD 数字，v=成交量 business_amount）
const getStockBars = async (code6) => {
  const prefixed = toThsStockCode(code6);
  const kline = await getStockDailyKline(prefixed);
  return (kline || [])
    .filter(k => k && Number.isFinite(Number(k.trade_date)) && Number.isFinite(Number(k.close_px)) && Number(k.close_px) > 0)
    .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px), v: Number.isFinite(Number(k.business_amount)) ? Number(k.business_amount) : null }))
    .sort((a, b) => a.d - b.d);
};

// 个股分钟级分时（stock.js 自带磁盘缓存），返回 { preclose, line: [{ minute, lastPx, change }] } 升序（仅 9:30-15:00）
const getStockMinuteTline = async (code, dateStr) => {
  try {
    const tline = await getSingleStockTlineDataByDate(code, parseInt(dateStr));
    if (!tline || !Array.isArray(tline.line) || tline.line.length === 0) return null;
    const preclose = Number(tline.preclose_px);
    const line = tline.line
      .filter(p => p && p.minute != null && p.last_px != null && Number(p.last_px) > 0)
      .map(p => {
        const px = Number(p.last_px);
        let chg = p.change != null && !Number.isNaN(Number(p.change)) ? Number(p.change) : null;
        if (chg == null && preclose > 0) chg = parseFloat((((px - preclose) / preclose) * 100).toFixed(2));
        return { minute: parseInt(p.minute), lastPx: px, change: chg };
      })
      .filter(p => p.minute >= 930 && p.minute <= 1500 && p.change != null && Number.isFinite(p.change))
      .sort((a, b) => a.minute - b.minute);
    if (line.length === 0) return null;
    const first = line[0];
    const estPreclose = preclose > 0 ? preclose : (first.change !== 0 ? first.lastPx / (1 + first.change / 100) : first.lastPx);
    return { preclose: estPreclose, line };
  } catch (e) {
    return null;
  }
};

// ============================================================
// 买点环境条件：创业板指 5/10 日线斜率均为负 + 银行板块 5 日线斜率为正
// 斜率口径与 calcDailyMaInfo 一致：MA(当前) − MA(5 日前)；数据用前一交易日收盘（trade_date < d）
// ============================================================
const maSlope = (closes, period) => {
  if (!Array.isArray(closes) || closes.length < period + 5) return null;
  const now = closes.slice(-period).reduce((s, v) => s + v, 0) / period;
  const prevArr = closes.slice(0, closes.length - 5);
  if (prevArr.length < period) return null;
  const prev = prevArr.slice(-period).reduce((s, v) => s + v, 0) / period;
  return now - prev;
};

const buildMarketGates = async (rangeDates) => {
  const [bankKline, cybKline] = await Promise.all([getBankKline(), getCybKline()]);
  const toBars = (kline) => (kline || [])
    .filter(k => Number.isFinite(Number(k.trade_date)) && Number.isFinite(Number(k.close_px)))
    .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px) }))
    .sort((a, b) => a.d - b.d);
  const bankBars = toBars(bankKline);
  const cybBars = toBars(cybKline);
  const gates = new Map();
  let bi = 0;
  let ci = 0;
  for (const d of rangeDates) {
    const dNum = Number(d);
    while (bi < bankBars.length && bankBars[bi].d < dNum) bi++;
    while (ci < cybBars.length && cybBars[ci].d < dNum) ci++;
    const bankCloses = bankBars.slice(0, bi).map(b => b.c);
    const cybCloses = cybBars.slice(0, ci).map(b => b.c);
    const cybMa5Slope = maSlope(cybCloses, 5);
    const cybMa10Slope = maSlope(cybCloses, 10);
    const bankMa5Slope = maSlope(bankCloses, 5);
    const hit = cybMa5Slope != null && cybMa5Slope < 0
      && cybMa10Slope != null && cybMa10Slope < 0
      && bankMa5Slope != null && bankMa5Slope > 0;
    gates.set(d, { hit, cybMa5Slope, cybMa10Slope, bankMa5Slope });
  }
  return gates;
};

// ============================================================
// 选股：前一交易日龙虎榜 → 主板非ST → 按策略筛选候选
// 返回 { candidates: [{ code6, code, name, metric }], lhbCount }
// ============================================================
const toThsStockCode = (code6) => (/^6/.test(code6) ? `sh${code6}` : `sz${code6}`);
const isMainBoardCode = (code6) => /^60/.test(code6) || /^00/.test(code6);
const isExcludedName = (name) => /ST/i.test(name || '') || (name || '').includes('退');

// 个股昨日（idx 为昨日 bar 下标）日涨幅 %
const dailyChangeAt = (bars, idx) =>
  idx >= 1 && bars[idx - 1].c > 0 ? (bars[idx].c / bars[idx - 1].c - 1) * 100 : null;

const selectCandidates = async (prevDate, strategyId, calendar) => {
  const lhb = await getLhbStocks(prevDate);
  const lhbCount = lhb.length;
  const pool = lhb.filter(s => isMainBoardCode(s.code) && !isExcludedName(s.name));
  const gainMatch = strategyId.match(/_(\d{1,2})d_gain$/);
  const slopeMatch = strategyId.match(/_(\d{1,2})d_slope$/);
  const calIdx = calendar.indexOf(prevDate);

  // 并发预取候选股日K（文件缓存命中则无 HTTP）
  await batchParallel(pool, async (s) => { try { await getStockBars(s.code); } catch (e) { /* 单只失败忽略 */ } }, 8);

  const candidates = [];
  for (const s of pool) {
    let bars;
    try { bars = await getStockBars(s.code); } catch (e) { continue; }
    // 找昨日 bar（昨日停牌/无数据的股票跳过）
    let idx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].d === Number(prevDate)) { idx = i; break; }
      if (bars[i].d < Number(prevDate)) break;
    }
    if (idx < 0) continue;

    if (gainMatch) {
      // 最近 N 个交易日累计涨幅（截至昨日收盘，按该股自身日K）
      const n = Number(gainMatch[1]);
      if (idx < n - 1) continue;
      const gain = (bars[idx].c / bars[idx - (n - 1)].c - 1) * 100;
      if (!Number.isFinite(gain)) continue;
      candidates.push({ code6: s.code, code: toThsStockCode(s.code), name: s.name, metric: gain });
    } else if (slopeMatch) {
      // N 日涨幅均线斜率（口径对齐常规策略 computeMaSlopeAngle，按截至昨日收盘数据，避免未来数据）：
      // avgNow = 截至昨日的 N 个日涨幅均值；avgPrev = 再往前 N 个日涨幅均值；angle = atan(avgNow−avgPrev)×180/π
      const n = Number(slopeMatch[1]);
      if (idx < n + 1) continue;
      const rets = [];
      for (let k = idx - n; k <= idx; k++) {
        const ch = dailyChangeAt(bars, k);
        if (ch == null) { rets.length = 0; break; }
        rets.push(ch);
      }
      if (rets.length < n + 1) continue;
      const avgNow = rets.slice(1).reduce((a, b) => a + b, 0) / n;
      const avgPrev = rets.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const angle = Math.atan(avgNow - avgPrev) * 180 / Math.PI;
      if (!Number.isFinite(angle)) continue;
      candidates.push({ code6: s.code, code: toThsStockCode(s.code), name: s.name, metric: angle });
    } else if (strategyId === 'hot_money_first_board') {
      // 最近 5 个交易日内昨日为第一个涨停板：昨日涨停，且窗口内更早的交易日均未涨停
      const chgYest = dailyChangeAt(bars, idx);
      if (chgYest == null || chgYest < LIMIT_UP_PCT) continue;
      if (idx < BOARD_WINDOW - 1) continue;
      const windowStartDate = calIdx >= BOARD_WINDOW - 1 ? Number(calendar[calIdx - (BOARD_WINDOW - 1)]) : null;
      let earlierLimitUp = false;
      for (let k = idx - (BOARD_WINDOW - 1); k <= idx - 1; k++) {
        if (windowStartDate != null && bars[k].d < windowStartDate) continue; // 仅统计窗口内交易日
        const chg = dailyChangeAt(bars, k);
        if (chg != null && chg >= LIMIT_UP_PCT) { earlierLimitUp = true; break; }
      }
      if (earlierLimitUp) continue;
      candidates.push({ code6: s.code, code: toThsStockCode(s.code), name: s.name, metric: chgYest });
    } else if (strategyId === 'hot_money_second_board') {
      // 前日与昨日均为涨停板
      const chgYest = dailyChangeAt(bars, idx);
      const chgPrev = dailyChangeAt(bars, idx - 1);
      if (chgYest == null || chgYest < LIMIT_UP_PCT) continue;
      if (chgPrev == null || chgPrev < LIMIT_UP_PCT) continue;
      candidates.push({ code6: s.code, code: toThsStockCode(s.code), name: s.name, metric: chgYest });
    } else if (strategyId === 'hot_money_2nd_wave') {
      // 龙二波：过去 20 个交易日累计涨幅 > 60%，且最近 5 个交易日收盘价上下波动幅度 < 20%、
      // 最近 5 个交易日内不能有涨停板（日涨幅 >=9.5%）
      if (idx < 19) continue;
      const gain20d = (bars[idx].c / bars[idx - 19].c - 1) * 100;
      if (!Number.isFinite(gain20d) || !(gain20d > WAVE_MIN_20D_GAIN)) continue;
      const recent5 = [bars[idx].c, bars[idx - 1].c, bars[idx - 2].c, bars[idx - 3].c, bars[idx - 4].c];
      const hi = Math.max(...recent5);
      const lo = Math.min(...recent5);
      if (!(lo > 0)) continue;
      const fluctuation = (hi - lo) / lo * 100;
      if (!Number.isFinite(fluctuation) || fluctuation >= WAVE_MAX_5D_FLUCTUATION) continue;
      let hasLimitUp = false;
      for (let i = idx - 4; i <= idx; i++) {
        const chg = dailyChangeAt(bars, i);
        if (chg != null && chg >= LIMIT_UP_PCT) { hasLimitUp = true; break; }
      }
      if (hasLimitUp) continue;
      candidates.push({ code6: s.code, code: toThsStockCode(s.code), name: s.name, metric: gain20d, fluctuation });
    } else if (strategyId === 'hot_money_weak_to_strong') {
      // 弱转强：昨日量能 >= 前日量能 × 1.4（放大 40% 以上），且前期（截至昨日的最近 20 个
      // 交易日）至少出现过 2 个涨停板（日涨幅 >=9.5%，不要求连续）；当日还需高开 >=2%（买入段按分时过滤）
      if (idx < 1) continue;
      const vYest = Number(bars[idx].v);
      const vPrev = Number(bars[idx - 1].v);
      if (!Number.isFinite(vYest) || !Number.isFinite(vPrev) || !(vPrev > 0)) continue;
      const ratio = vYest / vPrev;
      if (!Number.isFinite(ratio) || ratio < WEAK_STRONG_MIN_VOLUME_RATIO) continue;
      let limitUpCount = 0;
      for (let i = Math.max(1, idx - WEAK_STRONG_LOOKBACK + 1); i <= idx; i++) {
        const chg = dailyChangeAt(bars, i);
        if (chg != null && chg >= LIMIT_UP_PCT) limitUpCount++;
      }
      if (limitUpCount < WEAK_STRONG_MIN_LIMIT_UPS) continue;
      candidates.push({ code6: s.code, code: toThsStockCode(s.code), name: s.name, metric: ratio, limitUpCount });
    }
  }

  // 涨幅类策略取指标最大的一只；首板/二板/龙二波/弱转强保留全部候选（盘中最先触发 8% 的买入）；
  // 斜率类策略返回全部候选按斜率降序（买入时跳过一字板顺延取下一陡峭）
  if (gainMatch) {
    let best = null;
    for (const c of candidates) {
      if (!best || c.metric > best.metric) best = c;
    }
    return { candidates: best ? [best] : [], lhbCount };
  }
  if (slopeMatch || strategyId === 'hot_money_2nd_wave' || strategyId === 'hot_money_weak_to_strong') {
    candidates.sort((a, b) => b.metric - a.metric);
    return { candidates, lhbCount };
  }
  return { candidates, lhbCount };
};

// ============================================================
// 买入触发：候选股盘中涨幅超过 8% 的第一个分钟
//   单候选：该股首个触发分钟；多候选：按分钟推进，首个触发的候选买入（同分钟取涨幅最大）
// ============================================================
const findBuyTrigger = (candidates, tlineMap) => {
  // tlineMap 值为 getStockMinuteTline 的结果 { preclose, line }，这里取其 line 分钟数组
  let entries = candidates
    .map(c => {
      const tline = tlineMap.get(c.code);
      return { c, line: tline && Array.isArray(tline.line) ? tline.line : null };
    })
    .filter(e => e.line && e.line.length > 0);
  if (entries.length === 0) return null;
  // 9:30 竞价开盘涨幅 >= 9.6% 视为一字板（开盘即封板买不进去），直接剔除，
  // 从其余候选中取最早触发 8% 涨幅的股票
  entries = entries.filter(e => {
    const first = e.line[0];
    return !(first && first.minute <= 931 && first.change >= ONE_WORD_BOARD_OPEN_PCT);
  });
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const hit = entries[0].line.find(p => p.change > GAIN_BUY_TRIGGER_PCT);
    return hit ? { cand: entries[0].c, minute: hit.minute, price: hit.lastPx, change: hit.change } : null;
  }
  const minuteSet = new Set();
  entries.forEach(e => e.line.forEach(p => minuteSet.add(p.minute)));
  const minutes = [...minuteSet].sort((a, b) => a - b);
  for (const m of minutes) {
    let hit = null;
    for (const e of entries) {
      const p = e.line.find(q => q.minute === m);
      if (p && p.change > GAIN_BUY_TRIGGER_PCT && (!hit || p.change > hit.change)) {
        hit = { cand: e.c, minute: p.minute, price: p.lastPx, change: p.change };
      }
    }
    if (hit) return hit;
  }
  return null;
};

// ============================================================
// 卖出触发（按分钟时序）：当日触及跌停价 / 首个 >=14:57 分钟跌破 5 日线
// 数据未覆盖 14:57 时回退用当日最后一分钟判断
// ============================================================
const findSellTrigger = (tline, ma5) => {
  const preclose = tline.preclose;
  const limitDownPx = preclose > 0 ? Math.round(preclose * 0.9 * 100) / 100 : null;
  const line = tline.line;
  for (const p of line) {
    if (limitDownPx != null && p.lastPx <= limitDownPx + 0.001) {
      return { reason: '当日跌停', minute: p.minute, price: p.lastPx, change: p.change };
    }
    if (p.minute >= 1457 && ma5 != null && p.lastPx < ma5) {
      return { reason: '14:57跌破5日线', minute: p.minute, price: p.lastPx, change: p.change };
    }
  }
  // 回退：分时未覆盖 14:57（最后一分钟 < 1457）时用最后一分钟判断 5 日线
  const last = line[line.length - 1];
  if (ma5 != null && last && last.minute < 1457 && last.lastPx < ma5) {
    return { reason: '14:57跌破5日线', minute: last.minute, price: last.lastPx, change: last.change };
  }
  return null;
};

// 昨日收盘口径的 MA5（截至 dateStr 前一交易日收盘，5 根日K收盘均值）
const getMa5Before = async (code6, prevDate) => {
  if (!prevDate) return null;
  const bars = await getStockBars(code6);
  let idx = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].d === Number(prevDate)) { idx = i; break; }
    if (bars[i].d < Number(prevDate)) break;
  }
  if (idx < 4) return null;
  return (bars[idx - 4].c + bars[idx - 3].c + bars[idx - 2].c + bars[idx - 1].c + bars[idx].c) / 5;
};

// ============================================================
// 买入原因（随成交记录落盘展示，口径同其他策略 buyReason/buyChecks）
// ============================================================
const fmtSlope = (v) => (v == null ? '--' : v.toFixed(2));
const fmtMinute = (minute) => `${String(Math.floor(minute / 100)).padStart(2, '0')}:${String(minute % 100).padStart(2, '0')}`;
const fmtDateDisplay = (dateStr) => `${String(dateStr).slice(0, 4)}-${String(dateStr).slice(4, 6)}-${String(dateStr).slice(6, 8)}`;

const buildBuyInfo = (cand, trigger, gate, prevDate, strategyId) => {
  const gainMatch = strategyId.match(/_(\d{1,2})d_gain$/);
  const slopeMatch = strategyId.match(/_(\d{1,2})d_slope$/);
  let selection;
  if (gainMatch) {
    const n = Number(gainMatch[1]);
    selection = {
      title: `最近${n}个交易日累计涨幅最大`,
      value: `+${cand.metric.toFixed(2)}%`,
      reason: `截至前一交易日（${prevDate}）收盘，最近${n}个交易日累计涨幅 ${cand.metric.toFixed(2)}%，为当日龙虎榜主板非ST股中最高`,
    };
  } else if (strategyId === 'hot_money_2nd_wave') {
    selection = {
      title: '龙二波（20日涨幅>60%且5日收盘波动<20%无涨停）',
      value: `20日 +${cand.metric.toFixed(2)}% / 5日波动 ${(cand.fluctuation != null ? cand.fluctuation : 0).toFixed(2)}%`,
      reason: `截至前一交易日（${prevDate}）收盘：过去20个交易日累计涨幅 ${cand.metric.toFixed(2)}% > 60%，最近5个交易日收盘价上下波动幅度 ${(cand.fluctuation != null ? cand.fluctuation : 0).toFixed(2)}% < 20%，且最近5个交易日内无涨停板（日涨幅 >=9.5%）（前期大涨后横盘整理，等待二波启动）`,
    };
  } else if (strategyId === 'hot_money_weak_to_strong') {
    selection = {
      title: '弱转强（昨日量能放大40%以上、今日高开2%以上且前期至少2板）',
      value: `量比 ${(cand.metric != null ? cand.metric : 0).toFixed(2)} / 前期涨停 ${cand.limitUpCount != null ? cand.limitUpCount : '--'} 个`,
      reason: `前一交易日（${prevDate}）登龙虎榜的主板非ST股：昨日成交量放大至前日的 ${(cand.metric != null ? cand.metric : 0).toFixed(2)} 倍（>=1.4 倍即放大 40% 以上），前期（最近20个交易日）出现过 ${cand.limitUpCount != null ? cand.limitUpCount : '--'} 个涨停板（>=2 个，不要求连续），且今日开盘高开 >=2%（按分时第一分钟涨幅过滤）`,
    };
  } else if (slopeMatch) {
    const n = Number(slopeMatch[1]);
    selection = {
      title: `${n}日线斜率最陡峭（一字板顺延后）`,
      value: `斜率 ${cand.metric.toFixed(2)}°`,
      reason: `截至前一交易日（${prevDate}）收盘，${n}日涨幅均线斜率角度 ${cand.metric.toFixed(2)}°；更陡峭的候选若竞价一字板开盘（>=9.6%）买不进已顺延剔除，本股为可交易候选中最陡峭`,
    };
  } else if (strategyId === 'hot_money_first_board') {
    selection = {
      title: '昨日首板（最近5个交易日首个涨停板）',
      value: `昨日 +${cand.metric.toFixed(2)}%`,
      reason: `最近 5 个交易日内昨日（${prevDate}）为第一个涨停板（涨幅 ${cand.metric.toFixed(2)}% >= 9.5%）`,
    };
  } else {
    selection = {
      title: '昨日二板（前日与昨日均涨停）',
      value: `昨日 +${cand.metric.toFixed(2)}%`,
      reason: `前日与昨日（${prevDate}）均为涨停板（涨幅 >= 9.5%）`,
    };
  }
  const checks = [
    {
      id: 'lhb',
      title: `前一交易日（${prevDate}）登龙虎榜`,
      passed: true,
      value: cand.code6,
      reason: `同花顺龙虎榜 ${prevDate} 上榜个股，且为主板（60/00 开头）非 ST 股`,
    },
    {
      id: 'selection',
      title: selection.title,
      passed: true,
      value: selection.value,
      reason: selection.reason,
    },
  ];
  checks.push({
    id: 'market_gate',
    title: '创业板指5/10日线斜率均为负且银行板块5日线斜率为正',
    passed: true,
    value: `创业5日 ${fmtSlope(gate.cybMa5Slope)} / 创业10日 ${fmtSlope(gate.cybMa10Slope)} / 银行5日 ${fmtSlope(gate.bankMa5Slope)}`,
    reason: '按前一交易日收盘数据计算（斜率=当前MA−5日前MA），情绪游资买点环境条件满足',
  });
  checks.push({
    id: 'trigger',
    title: '盘中涨幅超过8%',
    passed: true,
    value: `${fmtMinute(trigger.minute)} +${trigger.change.toFixed(2)}%`,
    reason: `${fmtMinute(trigger.minute)} 盘中涨幅 ${trigger.change.toFixed(2)}% 超过 8%，按该分钟价格买入`,
  });
  return { buyReason: checks.map(c => c.title).join('、'), buyChecks: checks };
};

// ============================================================
// 情绪游资系列回测主循环（结果结构兼容单股策略 type: 'single'）
// ============================================================
const runSentimentBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = SENTIMENT_STRATEGIES[strategyId];
  if (!strategy) return { success: false, message: `未知情绪游资策略: ${strategyId}` };

  const calendar = await getTradingCalendar();
  if (!calendar || calendar.length === 0) {
    return { success: false, message: '交易日历获取失败（创业板指日K线）' };
  }
  const rangeDates = calendar.filter(d => d >= String(startDate) && d <= String(endDate));
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  const gates = await buildMarketGates(rangeDates);

  let position = null; // { code, code6, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric, buyReason, buyChecks }
  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    const dateDisplay = fmtDateDisplay(dateStr);
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    const calIdx = calendar.indexOf(dateStr);
    const prevDate = calIdx > 0 ? calendar[calIdx - 1] : null;

    // ===== 卖出（买入次日起生效；同日买入不可同日卖出） =====
    const soldTodayCodes = new Set();
    if (position) {
      if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });
      const tline = await getStockMinuteTline(position.code, dateStr);
      if (tline) {
        const ma5 = await getMa5Before(position.code6, prevDate);
        const trigger = findSellTrigger(tline, ma5);
        if (trigger) {
          const returnRate = position.buyPrice > 0
            ? parseFloat((((trigger.price - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
            : null;
          trades.push({
            seq: trades.length + 1,
            metric: position.metric,
            code: position.code,
            stockName: position.stockName,
            buyDate: position.buyDate,
            buyDateDisplay: position.buyDateDisplay,
            buyTime: position.buyTime,
            buyPrice: position.buyPrice,
            buyChange: position.buyChange,
            buyReason: position.buyReason,
            buyChecks: position.buyChecks,
            sellDate: dateStr,
            sellDateDisplay: dateDisplay,
            sellTime: fmtMinute(trigger.minute),
            sellPrice: parseFloat(trigger.price.toFixed(2)),
            sellChange: parseFloat(trigger.change.toFixed(2)),
            sellReason: trigger.reason,
            returnRate,
          });
          soldTodayCodes.add(position.code);
          position = null;
        }
      }
    }

    // ===== 买入（空仓时；环境条件 + 候选股盘中涨幅超过 8%） =====
    if (!position && prevDate) {
      const gate = gates.get(dateStr);
      if (gate && gate.hit) {
        const { candidates, lhbCount } = await selectCandidates(prevDate, strategyId, calendar);
        const buyable = candidates.filter(c => !soldTodayCodes.has(c.code));
        for (const c of buyable) {
          if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name });
        }
        if (lhbCount === 0) {
          skippedDates.push({ date: dateStr, message: `前一交易日（${prevDate}）龙虎榜数据为空` });
        } else if (buyable.length > 0) {
          if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });
          const tlineMap = new Map();
          for (const c of buyable) {
            tlineMap.set(c.code, await getStockMinuteTline(c.code, dateStr));
          }
          // 斜率类策略：候选已按斜率降序，跳过一字板开盘（竞价 >=9.6% 买不进）顺延取下一陡峭，
          // 以第一个非一字板候选作为当日标的，等其盘中涨幅超过 8% 买入（当日未触发则不买，不轮到后续候选）
          let triggerCandidates = buyable;
          if (/_\d{1,2}d_slope$/.test(strategyId)) {
            const isOneWordOpen = (c) => {
              const t = tlineMap.get(c.code);
              const first = t && Array.isArray(t.line) && t.line[0];
              return !!(first && first.minute <= 931 && first.change >= ONE_WORD_BOARD_OPEN_PCT);
            };
            const firstTradable = buyable.find(c => !isOneWordOpen(c));
            triggerCandidates = firstTradable ? [firstTradable] : [];
          }
          // 弱转强策略：今日高开 2% 以上（分时第一分钟涨幅）的候选才参与买入，不满足的剔除
          if (strategyId === 'hot_money_weak_to_strong') {
            triggerCandidates = triggerCandidates.filter(c => {
              const t = tlineMap.get(c.code);
              const first = t && Array.isArray(t.line) && t.line[0];
              return !!(first && first.change != null && first.change >= WEAK_STRONG_MIN_GAP_PCT);
            });
          }
          const trigger = triggerCandidates.length > 0 ? findBuyTrigger(triggerCandidates, tlineMap) : null;
          if (trigger) {
            const buyInfo = buildBuyInfo(trigger.cand, trigger, gate, prevDate, strategyId);
            position = {
              code: trigger.cand.code,
              code6: trigger.cand.code6,
              stockName: trigger.cand.name,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime: fmtMinute(trigger.minute),
              buyPrice: parseFloat(trigger.price.toFixed(2)),
              buyChange: parseFloat(trigger.change.toFixed(2)),
              metric: parseFloat(Number(trigger.cand.metric).toFixed(4)),
              buyReason: buyInfo.buyReason,
              buyChecks: buyInfo.buyChecks,
            };
          }
        }
      }
    }
  }

  // ===== 组装结果（期末持仓按该股最近收盘价估算浮盈，计入整体收益） =====
  let overallReturn = 1;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (position) {
    holding = { ...position };
    const bars = await getStockBars(position.code6);
    const endNum = Number(rangeDates[rangeDates.length - 1]);
    let lastClose = null;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].d <= endNum) { lastClose = bars[i].c; break; }
    }
    if (lastClose != null && position.buyPrice > 0) {
      holding.buyReturn = parseFloat((((lastClose - position.buyPrice) / position.buyPrice) * 100).toFixed(2));
      overallReturn *= 1 + holding.buyReturn / 100;
    }
  }
  overallReturn = parseFloat(((overallReturn - 1) * 100).toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      overallReturn,
      holding: !!holding,
    },
  };
};

module.exports = {
  SENTIMENT_STRATEGIES,
  SENTIMENT_HOT_MONEY_IDS,
  isSentimentStrategy,
  getSentimentDefaultRange,
  runSentimentBacktest,
};
