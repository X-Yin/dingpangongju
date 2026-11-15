// 雪球行情数据源（2026-11-15 新增）：日K + 当日分时
// - 接口：stock.xueqiu.com/v5/stock/chart/kline.json（日K）、.../minute.json（最新一日分时）
// - 鉴权：必须带 xq_a_token cookie。未登录访问一次 https://xueqiu.com/ 即下发匿名 token，
//   这里做「启动预热 + 过期自动重取」，不阻塞行情请求（取不到 cookie 时直接返回 null 走兜底源）
// - 限制：只提供最新一日分时，不支持按历史日期查询（与连板网一样只能用于当日实时分时）
const axios = require('axios');
const { timestampToDateStr, timestampToMinute } = require('../utils');
const {
    xueqiuHomeUrl,
    xueqiuKlineUrl,
    xueqiuMinuteUrl,
    xueqiuHeaders,
} = require('../constant');

const COOKIE_TTL_MS = 2 * 60 * 60 * 1000;
// 雪球请求统一超时 1s（硬上限，调用方传更大也不会放宽）：
// 超时立即抛错，由调用方切财联社 / 同花顺兜底
const TIMEOUT_MS = 1000;

let cookieCache = { value: '', ts: 0 };
let cookieInFlight = null;

// 代码 → 雪球 symbol（SZ300308 / SH600519 / BJ430047）
const toXqSymbol = (code) => {
    const raw = String(code || '').trim().toUpperCase();
    if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw;
    const plain = raw.replace(/^[A-Z]+/, '');
    if (/^[69]/.test(plain)) return `SH${plain}`;
    if (/^[48]/.test(plain)) return `BJ${plain}`;
    return `SZ${plain}`;
};

// 获取匿名 cookie（xq_a_token 在 https://www.xueqiu.com/ 的 200 响应里下发）
const refreshCookie = async (timeoutMs = 8000) => {
    if (cookieInFlight) return cookieInFlight;
    cookieInFlight = (async () => {
        try {
            const resp = await axios.get(xueqiuHomeUrl, {
                headers: { ...xueqiuHeaders, accept: 'text/html,application/xhtml+xml' },
                timeout: timeoutMs,
                maxRedirects: 5,
            });
            const cookies = (resp.headers['set-cookie'] || [])
                .map((item) => String(item).split(';')[0])
                .filter((item) => item && item.includes('='));
            const value = cookies.join('; ');
            if (value.includes('xq_a_token')) {
                cookieCache = { value, ts: Date.now() };
                return value;
            }
            console.warn('[xq] 首页未下发 xq_a_token');
        } catch (error) {
            console.warn('[xq] 获取 cookie 失败:', error.message);
        }
        return '';
    })().finally(() => { cookieInFlight = null; });
    return cookieInFlight;
};

// 同步取当前可用 cookie：无效时在后台刷新，本次请求直接失败交给兜底源，避免拖慢行情链路
const getCookie = () => {
    if (cookieCache.value && Date.now() - cookieCache.ts < COOKIE_TTL_MS) return cookieCache.value;
    refreshCookie().catch(() => {});
    return '';
};

const invalidateCookie = () => {
    cookieCache = { value: '', ts: 0 };
};

// 统一请求：cookie 失效（error_code 400016）时清缓存，后台重取，本次返回 null
const requestXueqiu = async (url, params, timeoutMs) => {
    const cookie = getCookie();
    if (!cookie) return null;
    const wanted = Number(timeoutMs) > 0 ? Number(timeoutMs) : TIMEOUT_MS;
    const resp = await axios.get(url, {
        params,
        headers: { ...xueqiuHeaders, cookie },
        // 硬上限 1s：调用方即使传更大的超时也按 1s 中断
        timeout: Math.min(wanted, TIMEOUT_MS),
        // token 失效时雪球返回 HTTP 400 + error_code 400016，需要读到 body 才能判断并清缓存
        validateStatus: (status) => status < 500,
    });
    const body = resp.data;
    if (body && body.error_code) {
        console.warn(`[xq] 接口返回错误 ${body.error_code}: ${body.error_description || ''}`);
        if (String(body.error_code) === '400016') invalidateCookie();
        return null;
    }
    return body && body.data ? body.data : null;
};

// 日K：返回 [{ trade_date, open_px, high_px, low_px, close_px, business_amount, business_balance, change, ma5_px, ma10_px, ma20_px }]
// 按日期倒序、截取 limit 条，与同花顺口径一致
const fetchXueqiuKline = async (code, limit = 1, timeoutMs) => {
    const count = Math.max(Number(limit) + 20, 40);
    const data = await requestXueqiu(xueqiuKlineUrl, {
        symbol: toXqSymbol(code),
        begin: Date.now(),
        period: 'day',
        type: 'before',
        count: -count,
        indicator: 'kline',
    }, timeoutMs);
    if (!data || !Array.isArray(data.column) || !Array.isArray(data.item)) return [];

    const cols = data.column;
    const idx = (name) => cols.indexOf(name);
    const iTs = idx('timestamp');
    const iVol = idx('volume');
    const iOpen = idx('open');
    const iHigh = idx('high');
    const iLow = idx('low');
    const iClose = idx('close');
    const iPct = idx('percent');
    const iAmt = idx('amount');
    if (iTs < 0 || iClose < 0) return [];

    const num = (row, i) => {
        if (i < 0) return null;
        const v = Number(row[i]);
        return Number.isFinite(v) ? v : null;
    };

    const klineData = data.item
        .map((row) => {
            const close = num(row, iClose);
            if (close === null) return null;
            return {
                trade_date: parseInt(timestampToDateStr(row[iTs]), 10),
                open_px: num(row, iOpen),
                high_px: num(row, iHigh),
                low_px: num(row, iLow),
                close_px: close,
                business_amount: num(row, iVol),
                business_balance: num(row, iAmt),
                change: num(row, iPct),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.trade_date - b.trade_date);

    // 均线口径与同花顺分支保持一致
    klineData.forEach((item, i) => {
        const avg = (n) => {
            const start = Math.max(0, i - n + 1);
            const slice = klineData.slice(start, i + 1);
            if (slice.length < n) return null;
            const sum = slice.reduce((acc, cur) => acc + cur.close_px, 0);
            return parseFloat((sum / n).toFixed(2));
        };
        item.ma5_px = avg(5);
        item.ma10_px = avg(10);
        item.ma20_px = avg(20);
    });

    return klineData
        .filter((item) => item.change !== null)
        .sort((a, b) => b.trade_date - a.trade_date)
        .slice(0, limit);
};

// 当日分时：返回 { date, preclose_px, line: [{ date, minute, last_px, av_px, change, change_px, business_amount, business_balance }] }
const fetchXueqiuTline = async (code, timeoutMs) => {
    const data = await requestXueqiu(xueqiuMinuteUrl, {
        symbol: toXqSymbol(code),
        period: '1d',
    }, timeoutMs);
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;

    const preclosePx = Number(data.last_close) || 0;
    if (preclosePx <= 0) return null;

    const dateInt = parseInt(timestampToDateStr(data.items[0].timestamp), 10);
    const line = data.items.map((item) => {
        const lastPx = Number(item.current);
        const minute = timestampToMinute(item.timestamp);
        const change = Number.isFinite(Number(item.percent))
            ? Number(item.percent)
            : parseFloat((((lastPx - preclosePx) / preclosePx) * 100).toFixed(2));
        const changePx = Number.isFinite(Number(item.chg))
            ? Number(item.chg)
            : parseFloat((lastPx - preclosePx).toFixed(2));
        return {
            date: dateInt,
            minute,
            last_px: lastPx,
            av_px: lastPx,
            change,
            change_px: changePx,
            // 雪球 items 里的 volume / amount 已是单分钟量（非累计）
            business_amount: Number(item.volume) || 0,
            business_balance: Number(item.amount) || 0,
        };
    }).filter((item) => Number.isFinite(item.last_px) && item.last_px > 0);

    return line.length > 0 ? { date: dateInt, preclose_px: preclosePx, line } : null;
};

// 启动预热匿名 cookie（不阻塞、失败静默），保证首次行情请求就能命中雪球
refreshCookie().catch(() => {});

exports.toXqSymbol = toXqSymbol;
exports.fetchXueqiuKline = fetchXueqiuKline;
exports.fetchXueqiuTline = fetchXueqiuTline;
exports.refreshXueqiuCookie = refreshCookie;
