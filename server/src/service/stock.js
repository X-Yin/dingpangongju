// 获取批量个股的数据，返回需要告警的数据

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { getClsReqUrl, getClsReqStockTlineUrl, getThsKlineUrl, getThsKlineHeaders, buildThsKlineRequestBody, timestampToDateStr, getThsTrendUrl, getThsTrendHeaders, buildThsTrendRequestBody, buildThsTrendRequestBodyWithDate, timestampToMinute, getClsReqStockTlineDay5Url, isTradingHours, isTradingDay, getThsSnapshotUrl, getThsSnapshotHeaders, buildThsSnapshotRequestBody, getThsMarketCode, batchParallel } = require('../utils');
const { lianbanTlineUrl, lianbanHeaders } = require('../constant');
const { refreshLBSessCookie } = require('./lianbanCookieRefresh');
const { getMonitorStocks } = require('./monitorStock');
const { useCLS, buildTryOrder } = require('../config');

const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
const jisuyidongPath = path.resolve(__dirname, '../data/jisuyidong.json');
const openingPricesPath = path.resolve(__dirname, '../data/openingPrices.json');
const tlineCacheDir = '/Users/xieyin/Desktop/盯盘工具/自选股全量股票过去分时数据';
// 按日捆绑分时缓存（回测加速，2026-11-04 新增）：{date}.json 紧凑存储当日全部分时结果
// （cacheKey -> { trade_date, preclose_px, line }）。回测逐日请求大量 (股票, 日期) 分时，
// 原逻辑每只股票都要整份读取解析其全历史分时文件（目录共 8.6GB/9000+ 文件，单文件最大 11MB），
// 是回测耗时大头（CPU 画像 ~62%）。按日捆绑后同一交易日只解析一个小文件，跨次回测直接复用
const tlineDayCacheDir = path.resolve(__dirname, '../data/tline_day_cache');

// ---------- 当日分时 TTL 内存缓存（2026-11-04） ----------
// 对 getSingleStockTlineData 做模块级 TTL 缓存：外部行情接口（同花顺/财联社）偶发慢（1-3s）、
// 前端每秒轮询会放大延迟并触发第三方限流。盘中 5s 内命中直接返回，既稳延迟又减轻外部压力。
// 回测用的 getSingleStockTlineDataByDate 已按日落盘，不受此缓存影响。
const LIVE_TLINE_TTL_MS = 5000;
const liveTlineCache = new Map(); // key=code -> { res, ts }
// 合并在途 Promise（同一 code 并发请求只发一次外部调用，其他并发挂这个 Promise）
const liveTlineInFlight = new Map();
const getSingleStockTlineDataCached = async (code) => {
    const cached = liveTlineCache.get(code);
    if (cached && Date.now() - cached.ts < LIVE_TLINE_TTL_MS) return cached.res;
    // 如果同 code 正在请求，直接挂它的 Promise，避免重复打外部
    if (liveTlineInFlight.has(code)) return liveTlineInFlight.get(code);
    const promise = getSingleStockTlineDataRaw(code).finally(() => { liveTlineInFlight.delete(code); });
    liveTlineInFlight.set(code, promise);
    const res = await promise;
    if (res) liveTlineCache.set(code, { res, ts: Date.now() });
    return res;
};

// 保存当日开盘价（9:25 竞价结束后执行，非交易日不保存）
function saveOpeningPricesIfNeeded() {
    const now = new Date();
    if (!isTradingDay(now)) return;

    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeNum = currentHour * 100 + currentMinute;
    if (currentTimeNum < 925) return;

    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    let savedData = {};
    try {
        if (fs.existsSync(openingPricesPath)) {
            savedData = JSON.parse(fs.readFileSync(openingPricesPath, 'utf-8'));
        }
    } catch (e) {
        savedData = {};
    }

    // 如果今天已经保存过，不再重复保存
    if (savedData.date === todayStr && savedData.prices) {
        return;
    }

    try {
        const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        const prices = {};
        for (const [code, value] of Object.entries(stockData)) {
            const kline = value.kline && value.kline[0];
            if (kline && kline.open_px) {
                prices[code] = {
                    name: value.stockName,
                    open_px: kline.open_px,
                    trade_date: kline.trade_date
                };
            }
        }
        savedData = {
            date: todayStr,
            prices
        };
        fs.writeFileSync(openingPricesPath, JSON.stringify(savedData, null, 2), 'utf-8');
        console.log(`---------- 保存当日开盘价完成，共 ${Object.keys(prices).length} 只股票 ----------`);
    } catch (e) {
        console.error('保存开盘价失败:', e.message);
    }
}

// 读取当日开盘价
function getOpeningPrices() {
    try {
        if (!fs.existsSync(openingPricesPath)) return { date: null, prices: {} };
        return JSON.parse(fs.readFileSync(openingPricesPath, 'utf-8'));
    } catch (e) {
        return { date: null, prices: {} };
    }
}

const getSingleStockData = async (code, limit = 1) => {
    // 日K路由：CLS / THS 之间加权随机（默认 60/40），主源失败则另一源兜底
    const tryOrder = buildTryOrder('kline');
    for (const src of tryOrder) {
        let result = null;
        if (src === 'ths') result = await getSingleStockDataFromTHS(code, limit);
        else if (src === 'cls') result = await getSingleStockDataFromCLS(code, limit);
        if (result && result.length > 0) return result;
        console.log(`${src.toUpperCase()} 获取股票 ${code} K线失败，继续下一个兜底`);
    }
    return [];
};

const getSingleStockDataFromCLS = async (code, limit = 1) => {
    try {
        const response = await axios.get(getClsReqUrl(code, limit), { timeout: 500 });
        const kline = response.data.data;
        return kline;
    } catch (error) {
        console.error(`财联社获取股票 ${code} 数据失败:`, error.message);
        return [];
    }
};

const getSingleStockDataFromTHS = async (code, limit = 1) => {
    try {
        const pureCode = code.replace(/^[a-zA-Z]+/, '');
        const url = getThsKlineUrl();
        const headers = getThsKlineHeaders();
        const fetchLimit = Math.max(limit + 20, 40);
        const requestBody = buildThsKlineRequestBody(pureCode, fetchLimit);

        const response = await axios.post(url, requestBody, { headers, timeout: 500 });

        if (response.data.status_code !== 0) {
            console.error(`同花顺API返回错误状态码: ${response.data.status_code}`);
            return [];
        }

        const quoteData = response.data.data.quote_data;
        if (!quoteData || quoteData.length === 0) {
            return [];
        }

        const valueArray = quoteData[0].value;
        if (!valueArray || !Array.isArray(valueArray) || valueArray.length === 0) {
            return [];
        }

        const klineData = [];
        for (let i = 0; i < valueArray.length; i++) {
            const item = valueArray[i];
            if (item.length < 7) continue;

            const klineItem = {
                trade_date: parseInt(timestampToDateStr(item[0])),
                open_px: item[1],
                high_px: item[2],
                low_px: item[3],
                close_px: item[4],
                business_amount: item[5],
                business_balance: item[6]
            };

            if (i > 0) {
                const prevClose = valueArray[i - 1][4];
                if (prevClose > 0) {
                    klineItem.change = parseFloat((((item[4] - prevClose) / prevClose) * 100).toFixed(2));
                }
            }

            klineData.push(klineItem);
        }

        klineData.sort((a, b) => a.trade_date - b.trade_date);

        for (let i = 0; i < klineData.length; i++) {
            let ma5Sum = 0;
            let ma10Sum = 0;
            let ma20Sum = 0;
            let ma5Count = 0;
            let ma10Count = 0;
            let ma20Count = 0;

            for (let j = Math.max(0, i - 4); j <= i; j++) {
                ma5Sum += klineData[j].close_px;
                ma5Count++;
            }
            for (let j = Math.max(0, i - 9); j <= i; j++) {
                ma10Sum += klineData[j].close_px;
                ma10Count++;
            }
            for (let j = Math.max(0, i - 19); j <= i; j++) {
                ma20Sum += klineData[j].close_px;
                ma20Count++;
            }

            klineData[i].ma5_px = ma5Count >= 5 ? parseFloat((ma5Sum / ma5Count).toFixed(2)) : null;
            klineData[i].ma10_px = ma10Count >= 10 ? parseFloat((ma10Sum / ma10Count).toFixed(2)) : null;
            klineData[i].ma20_px = ma20Count >= 20 ? parseFloat((ma20Sum / ma20Count).toFixed(2)) : null;
        }

        const result = klineData
            .filter(item => item.change !== undefined)
            .sort((a, b) => b.trade_date - a.trade_date)
            .slice(0, limit);

        return result;
    } catch (error) {
        console.error(`同花顺获取股票 ${code} 数据失败:`, error.message);
        return [];
    }
}
exports.getSingleStockData = getSingleStockData;

// 批量获取个股实时快照（涨跌幅 / 现价 / 昨收），按同花顺市场分组，一次请求同市场多只股票
// 用途：集合竞价（9:15-9:30）当日日 K 线尚未生成时，补充「当日实时涨幅」，
//       避免刷新榜单 / 科技情绪指数时仍沿用上一交易日收盘数据
// 返回 { [code]: { change, price, preclose } }；未取到的股票不出现在结果中，由调用方回退 K 线
const REALTIME_SNAPSHOT_BATCH = 50;
const getRealtimeQuotes = async (codes = []) => {
    const result = {};
    const uniqueCodes = Array.from(new Set((Array.isArray(codes) ? codes : []).filter(Boolean).map(String)));
    if (uniqueCodes.length === 0) return result;

    const byMarket = new Map();
    uniqueCodes.forEach((code) => {
        const pureCode = code.replace(/^[a-zA-Z]+/, '');
        const market = getThsMarketCode(pureCode) || '17';
        if (!byMarket.has(market)) byMarket.set(market, []);
        byMarket.get(market).push({ code, pureCode });
    });

    const groups = [];
    byMarket.forEach((list, market) => {
        for (let i = 0; i < list.length; i += REALTIME_SNAPSHOT_BATCH) {
            groups.push({ market, list: list.slice(i, i + REALTIME_SNAPSHOT_BATCH) });
        }
    });

    await Promise.all(groups.map(async ({ market, list }) => {
        try {
            const response = await axios.post(getThsSnapshotUrl(), {
                code_list: [{ codes: list.map(item => item.pureCode), market }],
                trade_class: 'intraday',
                // 字段：10=现价、6=昨收、199112=涨跌幅(%)
                data_fields: ['10', '6', '199112'],
                lang: 'zh_hans',
                gpid: 1,
            }, { headers: getThsSnapshotHeaders() });

            const quoteData = response.data?.data?.quote_data;
            if (!Array.isArray(quoteData)) return;
            quoteData.forEach((quote) => {
                const value = Array.isArray(quote?.value) ? quote.value[0] : null;
                const fields = Array.isArray(quote?.data_fields) ? quote.data_fields : [];
                if (!Array.isArray(value) || fields.length === 0) return;
                const matched = list.find(item => item.pureCode === String(quote.code));
                if (!matched) return;
                const pick = (field) => {
                    const idx = fields.indexOf(field);
                    if (idx < 0) return null;
                    const v = value[idx];
                    return v !== null && v !== undefined && !isNaN(Number(v)) ? Number(v) : null;
                };
                const change = pick('199112');
                const price = pick('10');
                if (change === null && price === null) return;
                result[matched.code] = { change, price, preclose: pick('6') };
            });
        } catch (error) {
            console.error(`批量获取实时快照失败(${market}):`, error.message);
        }
    }));

    return result;
};
exports.getRealtimeQuotes = getRealtimeQuotes;

// 竞价阶段（交易日 9:15-9:30）日 K 线接口通常仍停在上一交易日 bar（当日 bar 要到开盘后才生成），
// 与 block.js getSingleBlockData 采用同样的兜底策略：K 线 trade_date 不是今日或无有效 change 时，
// 用同花顺实时快照 getRealtimeQuotes 拉竞价涨跌幅覆盖 change / close_px，
// 保证盘前轮询 / 手动刷新自选股时写入 stockData.json 的也是当日实时竞价数据，而非上一交易日收盘数据。
const applyAuctionQuotesFallback = async (stockListData) => {
    const now = new Date();
    const timeNum = now.getHours() * 100 + now.getMinutes();
    const inAuction = isTradingDay(now) && timeNum >= 915 && timeNum < 930;
    if (!inAuction) return;

    const todayNum = Number(
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    );

    const staleCodes = [];
    for (const code of Object.keys(stockListData)) {
        const kline = stockListData[code] && stockListData[code].kline && stockListData[code].kline[0];
        if (!kline || kline.change == null || isNaN(Number(kline.change)) || Number(kline.trade_date) !== todayNum) {
            staleCodes.push(code);
        }
    }
    if (staleCodes.length === 0) return;

    try {
        const quotes = await getRealtimeQuotes(staleCodes);
        let hitCount = 0;
        for (const code of staleCodes) {
            const q = quotes[code];
            const kline = stockListData[code] && stockListData[code].kline && stockListData[code].kline[0];
            if (!kline || !q) continue;
            if (q.change != null && !isNaN(Number(q.change))) {
                kline.change = Number(q.change);
                hitCount++;
            }
            // 现价一并覆盖为竞价最新价，避免涨幅与现价不一致
            if (q.price != null && Number(q.price) > 0) {
                kline.close_px = Number(q.price);
            }
        }
        if (hitCount > 0) {
            console.log(`自选股竞价兜底：${hitCount}/${staleCodes.length} 只股票从实时快照拿到竞价涨跌幅`);
        }
    } catch (err) {
        console.error('自选股竞价实时快照兜底失败:', err.message);
    }
};

// 获取单个股票估值信息（总市值/流通市值/市盈率）
// 快照接口 value[0] 数组下标对应：4=流通市值(元)、7=市盈率(null 表示亏损)、9=总市值(元)
const getStockValuation = async (code) => {
    try {
        const pureCode = code.replace(/^[a-zA-Z]+/, '');
        const url = getThsSnapshotUrl();
        const headers = getThsSnapshotHeaders();
        const requestBody = buildThsSnapshotRequestBody(pureCode);

        const response = await axios.post(url, requestBody, { headers });

        if (response.data.status_code !== 0) {
            return { success: false, message: `同花顺API返回错误状态码: ${response.data.status_code}` };
        }

        const value = response.data.data?.quote_data?.[0]?.value?.[0];
        if (!Array.isArray(value) || value.length === 0) {
            return { success: false, message: '未获取到估值数据' };
        }

        return {
            success: true,
            data: {
                totalMarketValue: value[9],
                circulatingMarketValue: value[4],
                peRatio: value[7]
            }
        };
    } catch (error) {
        console.error(`获取股票 ${code} 估值数据失败:`, error.message);
        return { success: false, message: error.message };
    }
};
exports.getStockValuation = getStockValuation;

let tlineNum = 0;

// 分时数据源路由（2026-11-05 多源加权随机化）：
//   主力：CLS 60% / THS 40%（加权随机）
//   兜底：主源失败后依次走「另一只主力 → LB（连板网，腾讯底层）」
// 2026-11-04 实测：CLS 并发 177-211ms / 稳定；LB 241-360ms / 稳定；THS 偶发 500ms+ timeout
const getSingleStockTlineDataRaw = async (code) => {
    const _t0 = Date.now();
    const tryOrder = buildTryOrder('tline'); // 例如 ['cls','ths','lb'] 或 ['ths','cls','lb']

    for (const src of tryOrder) {
        let result = null;
        if (src === 'cls') result = await getSingleStockTlineDataFromCLS(code);
        else if (src === 'ths') result = await getSingleStockTlineDataFromTHS(code);
        else if (src === 'lb') result = await getSingleStockTlineDataFromLB(code);
        if (result) {
            console.log(`[tline] ${code} → ${src.toUpperCase()} ${Date.now()-_t0}ms`);
            return result;
        }
    }

    console.warn(`[tline] ${code} 所有数据源(${tryOrder.join('/')})均失败，总耗时 ${Date.now()-_t0}ms`);
    return null;
};

// 对外导出：走 TTL 缓存 + 在途 Promise 合并
const getSingleStockTlineData = getSingleStockTlineDataCached;

// 统一的 sh/sz 前缀规范化（财联社 / 连板网都需要带前缀）
const normalizeMarketPrefix = (code) => {
    const c = String(code).toLowerCase();
    if (c.startsWith('sh') || c.startsWith('sz')) return c;
    if (/^(6|9)\d{5}$/.test(code)) return `sh${code}`;
    if (/^(0|3)\d{5}$/.test(code)) return `sz${code}`;
    return code; // 未知格式兜底原样
};

const getSingleStockTlineDataFromCLS = async (code) => {
    try {
        const normalizedCode = normalizeMarketPrefix(code);
        // 500ms 超时：超时立刻返回 null，由 buildTryOrder 兜底链切换下一个数据源
        const response = await axios.get(getClsReqStockTlineUrl(normalizedCode), { timeout: 500 });
        const data = response.data.data;
        const line = data?.line || [];
        if (!Array.isArray(line) || line.length === 0) {
            return null;
        }
        
        const preclosePx = data?.preclose_px || line[0]?.preclose_px || 0;
        const dateInt = data?.date || parseInt(timestampToDateStr(line[0].time || line[0].timestamp || Date.now()));
        
        const processedLine = line.map((item) => {
            const lastPx = item.last_px || item.price || item.p || 0;
            // 财联社返回的 item.minute 本身就是 930/1530 数字格式（09:30/15:30 的简写），直接用；
            // THS 返回 timestamp，用 timestampToMinute 转换后也是数字格式
            let minuteNum;
            if (typeof item.minute === 'number' && item.minute > 0) {
                minuteNum = item.minute;
            } else {
                const ts = item.time || item.timestamp || Date.now();
                minuteNum = timestampToMinute(ts);
            }
            const change = item.change !== undefined ? item.change : 
                (preclosePx > 0 ? parseFloat((((lastPx - preclosePx) / preclosePx) * 100).toFixed(2)) : null);
            const changePx = preclosePx > 0 ? parseFloat((lastPx - preclosePx).toFixed(2)) : null;
            return {
                date: dateInt,
                minute: minuteNum, // 保持数字格式，跟抗分歧 stockLine 完全一致
                last_px: lastPx,
                av_px: lastPx,
                change: change,
                change_px: changePx,
                business_amount: item.business_amount || item.volume || 0,
                business_balance: item.business_balance || item.amount || 0
            };
        });
        
        return {
            date: dateInt,
            preclose_px: preclosePx,
            line: processedLine
        };
    } catch (error) {
        console.error(`财联社获取股票 ${code} 分时数据失败:`, error.message);
        return null;
    }
};

const getSingleStockTlineDataFromTHS = async (code) => {
    try {
        const url = getThsTrendUrl();
        const headers = getThsTrendHeaders();
        const requestBody = buildThsTrendRequestBody(code);

        // 同花顺慢/卡/限流时 axios 默认超时会等很久，直接 500ms 过期兜底财联社
        const response = await axios.post(url, requestBody, { headers, timeout: 500 });
        const quoteData = response.data.data?.quote_data?.[0];
        
        if (!quoteData || !quoteData.value || !Array.isArray(quoteData.value)) {
            return null;
        }

        const basePrice = quoteData.base_price;
        const date = timestampToDateStr(quoteData.value[0][0]);
        
        let prevPrice = basePrice;
        const line = quoteData.value.map((item, i) => {
            const prevItem = quoteData.value?.[i - 1];
            const timestamp = item[0];
            const lastPx = item[1];
            const volume = item[2];
            const amount = item[3];
            const minute = timestampToMinute(timestamp);
            
            const effectivePrice = (lastPx !== null && lastPx !== undefined && typeof lastPx === 'number') ? lastPx : prevPrice;
            prevPrice = effectivePrice;
            
            const change = basePrice > 0 ? parseFloat((((effectivePrice - basePrice) / basePrice) * 100).toFixed(2)) : null;
            const changePx = basePrice > 0 ? parseFloat((effectivePrice - basePrice).toFixed(2)) : null;

            return {
                date: parseInt(date),
                minute: minute,
                last_px: effectivePrice,
                av_px: effectivePrice,
                change: change,
                change_px: changePx,
                business_amount: volume - (prevItem?.[2] || 0),
                business_balance: amount - (prevItem?.[3] || 0)
            };
        });

        return {
            date: parseInt(date),
            preclose_px: basePrice,
            line: line
        };
    } catch (error) {
        console.error(`同花顺获取股票 ${code} 分时数据失败:`, error.message);
        return null;
    }
};

// 连板网（腾讯底层）分时接口 — 复用统一前缀规范化
async function _rawLBRequest(lbCode) {
    // 动态读取当前 headers（cookie 可能被 refreshLBSessCookie 更新）
    const { lianbanHeaders: headers } = require('../constant');
    const response = await axios.get(lianbanTlineUrl(lbCode), { headers, timeout: 1500 });
    return response.data;
}

const getSingleStockTlineDataFromLB = async (code) => {
    const lbCode = normalizeMarketPrefix(code);

    const parse = (data) => {
        if (data?.code !== 0) return null; // cookie 过期时 code 可能 != 0
        const payload = data?.data?.[lbCode];
        if (!payload) return null;
        const rawLine = payload?.data?.data || [];
        if (!Array.isArray(rawLine) || rawLine.length === 0) return null;

        const dateInt = parseInt(payload?.data?.date || timestampToDateStr(Date.now()));
        const preclosePx = parseFloat(payload?.qt?.[lbCode]?.[4] || 0);
        if (preclosePx <= 0) return null;

        const processedLine = [];
        let prevVol = 0, prevAmt = 0;
        for (const entry of rawLine) {
            const parts = entry.trim().split(/\s+/);
            if (parts.length < 4) continue;
            const timeStr = parts[0];
            const price = parseFloat(parts[1]);
            const vol = parseInt(parts[2], 10);
            const amt = parseFloat(parts[3]);
            if (isNaN(price) || isNaN(vol) || isNaN(amt)) continue;

            processedLine.push({
                date: dateInt,
                minute: parseInt(timeStr, 10), // "0930" → 930，跟抗分歧 stockLine 保持一致
                last_px: price,
                av_px: price,
                change: parseFloat((((price - preclosePx) / preclosePx) * 100).toFixed(2)),
                change_px: parseFloat((price - preclosePx).toFixed(2)),
                business_amount: vol - prevVol,
                business_balance: amt - prevAmt
            });
            prevVol = vol; prevAmt = amt;
        }
        return processedLine.length > 0
            ? { date: dateInt, preclose_px: preclosePx, line: processedLine }
            : null;
    };

    try {
        // 首次请求
        const data1 = await _rawLBRequest(lbCode);
        let result = parse(data1);

        // 如果没拿到有效数据，疑似 cookie 过期 → 触发刷新（全局锁 + 节流），然后重放一次
        if (!result) {
            const isLikelyCookieExpired =
                data1?.code !== 0 ||
                (data1 && !data1.data?.[lbCode]) ||
                (data1?.data?.[lbCode]?.qt?.[lbCode]?.length < 10);

            if (isLikelyCookieExpired) {
                console.log(`[lb] 连板网股票 ${code} 返回空，尝试刷新 cookie...`);
                const newCookie = await refreshLBSessCookie();
                if (newCookie) {
                    console.log(`[lb] cookie 已刷新，重试 ${code}`);
                    try {
                        const data2 = await _rawLBRequest(lbCode);
                        result = parse(data2);
                    } catch { /* 仍然失败就返回 null，走 CLS 兜底 */ }
                } else {
                    console.log(`[lb] cookie 刷新失败或不需要刷新，直接返回 null 走 CLS 兜底`);
                }
            }
        }
        return result;
    } catch (error) {
        console.error(`连板网获取股票 ${code} 分时失败:`, error.message);
        return null;
    }
};

exports.getSingleStockTlineData = getSingleStockTlineData;
// 供板块成交额汇总兜底：直接走财联社分时，避免再次落到同花顺
exports.getSingleStockTlineDataFromCLS = getSingleStockTlineDataFromCLS;

// 通过股票代码获取股票名称
const getStockNameByCode = (code) => {
    const monitorStocks = getMonitorStocks();
    const stock = monitorStocks.find(s => s.code === code);
    return stock ? stock.name : null;
};

// 分时文件内存缓存：同一缓存文件（按股票名/代码）只读取+解析一次，进程内复用
// （resilience3d 等场景会对同一只股票反复按日期取分时，避免每次重复读盘+JSON.parse）
const tlineFileMemCache = new Map(); // cacheKey -> 已解析的分时历史数组

// ============================================================
// worker 线程读盘解析池（回测加速，2026-11-04 新增）：
// 历史分时 JSON 文件较大（平均 ~1MB、最大 11MB），主线程 readFileSync + JSON.parse
// 会串行阻塞事件循环并带来大量 GC。读盘+解析移入 worker 线程并行执行，主线程只接收
// 当日小对象。池化复用线程，任务队列满时排队。
// ============================================================
const TLINE_WORKER_SCRIPT = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
if (parentPort) {
  parentPort.on('message', (task) => {
    const { id, filePath, tradeDate } = task;
    try {
      if (!fs.existsSync(filePath)) { parentPort.postMessage({ id, found: false }); return; }
      const cacheData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!Array.isArray(cacheData)) { parentPort.postMessage({ id, found: false }); return; }
      const dayData = cacheData.find(d => d.trade_date === tradeDate);
      if (!dayData || !dayData.line || dayData.line.length === 0) { parentPort.postMessage({ id, found: false }); return; }
      parentPort.postMessage({ id, found: true, dayData: { date: dayData.trade_date, preclose_px: dayData.preclose_px || 0, line: dayData.line } });
    } catch (e) {
      parentPort.postMessage({ id, found: false, error: e.message });
    }
  });
}
`;
const TLINE_WORKER_COUNT = Math.min(6, Math.max(2, os.cpus().length - 2));
const tlineWorkers = [];
const tlineWorkerIdle = [];
const tlineTaskQueue = [];
let tlineTaskSeq = 0;
const tlinePendingTasks = new Map(); // id -> resolve

const tlineRunWorkerTask = (task) => new Promise((resolve) => {
  const id = ++tlineTaskSeq;
  tlinePendingTasks.set(id, resolve);
  const dispatch = () => {
    const worker = tlineWorkerIdle.pop();
    if (worker) {
      worker._busy = true;
      worker.postMessage({ id, filePath: task.filePath, tradeDate: task.tradeDate });
      return;
    }
    tlineTaskQueue.push({ id, filePath: task.filePath, tradeDate: task.tradeDate });
  };
  if (tlineWorkers.length < TLINE_WORKER_COUNT) {
    const worker = new Worker(TLINE_WORKER_SCRIPT, { eval: true });
    worker.unref();
    worker.on('message', (msg) => {
      const pending = tlinePendingTasks.get(msg.id);
      if (pending) {
        tlinePendingTasks.delete(msg.id);
        pending(msg);
      }
      worker._busy = false;
      tlineWorkerIdle.push(worker);
      const next = tlineTaskQueue.shift();
      if (next) {
        const w = tlineWorkerIdle.pop();
        if (w) {
          w._busy = true;
          w.postMessage({ id: next.id, filePath: next.filePath, tradeDate: next.tradeDate });
        } else {
          tlineTaskQueue.unshift(next);
        }
      }
    });
    worker.on('error', () => {
      // worker 崩溃：把队列任务改为主线程兜底同步读取，避免永久挂起
      const idx = tlineWorkerIdle.indexOf(worker);
      if (idx >= 0) tlineWorkerIdle.splice(idx, 1);
      const wIdx = tlineWorkers.indexOf(worker);
      if (wIdx >= 0) tlineWorkers.splice(wIdx, 1);
      for (const t of tlineTaskQueue.splice(0)) {
        const pending = tlinePendingTasks.get(t.id);
        tlinePendingTasks.delete(t.id);
        if (pending) pending(tlineReadDaySync(t.filePath, t.tradeDate));
      }
    });
    tlineWorkers.push(worker);
    worker._busy = true;
    worker.postMessage({ id, filePath: task.filePath, tradeDate: task.tradeDate });
    return;
  }
  dispatch();
});

// 主线程兜底同步读取（worker 不可用时）
const tlineReadDaySync = (filePath, tradeDate) => {
  try {
    if (!fs.existsSync(filePath)) return { found: false };
    const cacheData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(cacheData)) return { found: false };
    const dayData = cacheData.find(d => d.trade_date === tradeDate);
    if (!dayData || !dayData.line || dayData.line.length === 0) return { found: false };
    return { found: true, dayData: { date: dayData.trade_date, preclose_px: dayData.preclose_px || 0, line: dayData.line } };
  } catch (e) {
    return { found: false, error: e.message };
  }
};

// ============================================================
// 按日捆绑分时缓存：内存 Map + 落盘（data/tline_day_cache/{date}.json，紧凑 JSON）
// - 读：getTlineDayBundle 每个交易日整文件只解析一次（约 2~5MB，主线程开销可忽略）
// - 写：worker/文件/HTTP 拿到完整分时后 insertTlineDayCacheEntry 登记并标记脏，
//       防抖 5s 后异步落盘（避免回测期间每股票一次同步写整文件）
// - 只登记「数据完整」的分时（isTlineCacheComplete 通过后才写入），当日盘中数据不进捆绑缓存
// ============================================================
const tlineDayBundleMem = new Map(); // dateNum -> Map(cacheKey -> dayData)
const tlineDayBundleLoaded = new Set(); // 已尝试加载过文件的日期（含文件不存在的）
const tlineDayBundleDirty = new Set(); // 待落盘日期
const tlineDayBundleTimers = new Map(); // date -> 防抖定时器

const tlineDayCachePath = (dateNum) => path.join(tlineDayCacheDir, `${dateNum}.json`);

const getTlineDayBundle = (dateNum) => {
  let bundle = tlineDayBundleMem.get(dateNum);
  if (bundle) return bundle;
  bundle = new Map();
  if (!tlineDayBundleLoaded.has(dateNum)) {
    tlineDayBundleLoaded.add(dateNum);
    try {
      const file = tlineDayCachePath(dateNum);
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) bundle.set(k, v);
        }
      }
    } catch (e) {
      console.error(`读取按日分时捆绑缓存失败 (${dateNum}):`, e.message);
    }
  }
  tlineDayBundleMem.set(dateNum, bundle);
  return bundle;
};

const flushTlineDayBundle = (dateNum) => {
  const bundle = tlineDayBundleMem.get(dateNum);
  tlineDayBundleDirty.delete(dateNum);
  if (!bundle || bundle.size === 0) return;
  try {
    if (!fs.existsSync(tlineDayCacheDir)) fs.mkdirSync(tlineDayCacheDir, { recursive: true });
    const obj = {};
    for (const [k, v] of bundle) obj[k] = v;
    // 紧凑 JSON 落盘（无缩进），减小体积与下次解析开销
    const tmpFile = `${tlineDayCachePath(dateNum)}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(obj), 'utf-8');
    fs.renameSync(tmpFile, tlineDayCachePath(dateNum));
  } catch (e) {
    console.error(`写入按日分时捆绑缓存失败 (${dateNum}):`, e.message);
  }
};

const insertTlineDayCacheEntry = (dateNum, cacheKey, dayData) => {
  const bundle = getTlineDayBundle(dateNum);
  const existing = bundle.get(cacheKey);
  // 已有且长度不短于新数据则跳过（历史分时不可变）；
  // 当日盘中写入的短分时允许被收盘后的完整分时覆盖，避免收盘后一直判定缓存不完整而反复读盘
  if (existing && (existing.line?.length || 0) >= (dayData.line?.length || 0)) return;
  bundle.set(cacheKey, dayData);
  if (!tlineDayBundleDirty.has(dateNum)) {
    tlineDayBundleDirty.add(dateNum);
    const timer = setTimeout(() => {
      tlineDayBundleTimers.delete(dateNum);
      flushTlineDayBundle(dateNum);
    }, 5000);
    timer.unref();
    tlineDayBundleTimers.set(dateNum, timer);
  }
};

// 进程退出前尽力落盘未写入的捆绑缓存
process.on('exit', () => {
  for (const timer of tlineDayBundleTimers.values()) clearTimeout(timer);
  for (const dateNum of [...tlineDayBundleDirty]) {
    try { flushTlineDayBundle(dateNum); } catch (e) { /* 退出阶段尽力而为 */ }
  }
});

// 从本地缓存读取分时数据
const getTlineFromCache = (cacheKey, tradeDate) => {
    try {
        let cacheData = tlineFileMemCache.get(cacheKey);
        if (cacheData === undefined) {
            const cacheFile = path.join(tlineCacheDir, `${cacheKey}.json`);
            if (!fs.existsSync(cacheFile)) return null;

            cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            if (!Array.isArray(cacheData)) cacheData = [];
            tlineFileMemCache.set(cacheKey, cacheData);
        }

        const dayData = cacheData.find(d => d.trade_date === tradeDate);
        if (!dayData || !dayData.line || dayData.line.length === 0) return null;

        return {
            date: dayData.trade_date,
            preclose_px: dayData.preclose_px || 0,
            line: dayData.line
        };
    } catch (e) {
        console.error(`读取分时缓存失败 (${cacheKey}, ${tradeDate}):`, e.message);
        return null;
    }
};

// 将分时数据写入本地缓存
const saveTlineToCache = (cacheKey, tradeDate, tlineData) => {
    try {
        const cacheFile = path.join(tlineCacheDir, `${cacheKey}.json`);
        let cacheData = tlineFileMemCache.get(cacheKey);
        if (!Array.isArray(cacheData)) {
            if (fs.existsSync(cacheFile)) {
                try {
                    cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
                } catch (e) {
                    cacheData = [];
                }
            } else {
                cacheData = [];
            }
        }
        if (!Array.isArray(cacheData)) cacheData = [];

        // 移除同日期旧数据
        cacheData = cacheData.filter(d => d.trade_date !== tradeDate);

        const line = tlineData.line || [];
        const lastPxList = line.map(l => l.last_px).filter(p => p != null);

        cacheData.push({
            trade_date: tradeDate,
            open_px: line[0]?.last_px || 0,
            high_px: lastPxList.length > 0 ? Math.max(...lastPxList) : 0,
            low_px: lastPxList.length > 0 ? Math.min(...lastPxList) : 0,
            close_px: line[line.length - 1]?.last_px || 0,
            business_amount: line.reduce((sum, l) => sum + (l.business_amount || 0), 0),
            business_balance: line.reduce((sum, l) => sum + (l.business_balance || 0), 0),
            change: line[line.length - 1]?.change || 0,
            preclose_px: tlineData.preclose_px,
            line: line
        });

        // 紧凑 JSON 落盘（无缩进）：目录 8.6GB/9000+ 文件，缩进格式体积与解析开销均显著更大
        fs.writeFileSync(cacheFile, JSON.stringify(cacheData), 'utf-8');
        tlineFileMemCache.set(cacheKey, cacheData); // 同步内存缓存
    } catch (e) {
        console.error(`写入分时缓存失败 (${cacheKey}, ${tradeDate}):`, e.message);
    }
};

// 分时请求超时：当日（live）数据交易时段必须拿到，超时放宽到 5s（盘中高峰 500ms 会大面积超时）；
// 历史日期多为回测批量拉取，维持 500ms 快速失败由负缓存兜底
const tlineReqTimeout = (tradeDate) => {
    const t = new Date();
    const todayStr = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
    return String(tradeDate) === todayStr ? 5000 : 500;
};

const getSingleStockTlineDataByDateFromCLS = async (code, tradeDate) => {
    try {
        const response = await axios.get(getClsReqStockTlineDay5Url(code), { timeout: tlineReqTimeout(tradeDate) });
        const data = response.data.data;
        if (!data || !Array.isArray(data)) {
            return null;
        }

        const targetDay = data.find(day => {
            if (!day.line || !Array.isArray(day.line) || day.line.length === 0) {
                return false;
            }
            const firstItem = day.line[0];
            const itemDate = parseInt(timestampToDateStr(firstItem.time || firstItem.timestamp || Date.now()));
            return itemDate === tradeDate;
        });

        if (!targetDay) {
            return null;
        }

        const line = targetDay.line;
        const preclosePx = targetDay.preclose_px || line[0]?.preclose_px || 0;

        const processedLine = line.map((item) => {
            const lastPx = item.last_px || item.price || item.p || 0;
            const minute = timestampToMinute(item.time || item.timestamp || Date.now());
            const change = preclosePx > 0 ? parseFloat((((lastPx - preclosePx) / preclosePx) * 100).toFixed(2)) : null;
            const changePx = preclosePx > 0 ? parseFloat((lastPx - preclosePx).toFixed(2)) : null;

            return {
                date: tradeDate,
                minute: minute,
                last_px: lastPx,
                av_px: lastPx,
                change: change,
                change_px: changePx,
                business_amount: item.business_amount || 0,
                business_balance: item.business_balance || 0
            };
        });

        return {
            date: tradeDate,
            preclose_px: preclosePx,
            line: processedLine
        };
    } catch (error) {
        console.error(`财联社获取股票 ${code} 日期 ${tradeDate} 分时数据失败:`, error.message);
        return null;
    }
};

// 判断分时缓存数据是否完整（截止时间应为 15:00，否则视为缓存有问题需重新请求）
const isTlineCacheComplete = (line, tradeDate) => {
    if (!Array.isArray(line) || line.length === 0) return false;
    const lastMinute = line[line.length - 1]?.minute;
    if (lastMinute == null) return false;

    const now = new Date();
    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const isToday = String(tradeDate) === todayStr;
    const currentMinute = now.getHours() * 100 + now.getMinutes();

    // 当日尚未收盘（当前时间早于 15:00）：分时缓存必须覆盖到已完结的最近交易时点才视为有效
    // （盘前按日期拉到的竞价快照只有 1 个点，曾在此被当作有效缓存返回并污染内存缓存，
    //   导致抗分歧诊断当日指数只有 1 个点、各分段"数据不足"、得分全为 0）
    if (isToday && currentMinute < 1500) {
        if (currentMinute < 1130) return lastMinute >= 935;   // 盘前/上午：至少覆盖开盘 5 分钟
        if (currentMinute < 1300) return lastMinute >= 1130;  // 午休：须覆盖到上午收盘
        return lastMinute >= 1305;                            // 下午：至少覆盖开盘 5 分钟
    }

    // 收盘后或历史交易日，分时数据必须截止到 15:00 才视为完整
    return lastMinute >= 1500;
};

// 分时结果内存缓存（code|date -> 结果，历史分时不可变；当日盘中不缓存）
// 消除 resilience3d 等场景对同一 (股票/指数, 日期) 的重复请求/读盘
const tlineResultMemCache = new Map();
// 分时拉取失败负缓存："code|dateNum" -> 失败过期时间戳（10 分钟内不再重试 THS/CLS，回测加速）
const tlineFailMemo = new Map();

const getSingleStockTlineDataByDate = async (code, tradeDate) => {
    const stockName = getStockNameByCode(code);
    // 非自选股（指数/板块股）无股票名，按代码落盘缓存，避免每次都走 HTTP
    const cacheKey = stockName || String(code);

    // 当日交易时段内跳过缓存，确保获取最新分时数据
    const now = new Date();
    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const isToday = String(tradeDate) === todayStr;
    const skipCache = isToday && isTradingHours();
    const memKey = `${code}|${tradeDate}`;

    if (!skipCache) {
        const memHit = tlineResultMemCache.get(memKey);
        if (memHit !== undefined) {
            // 命中时校验完整性，不完整（如盘前竞价快照被误缓存）则剔除自愈，防止脏数据永久驻留
            if (isTlineCacheComplete(memHit?.line, tradeDate)) {
                return memHit ? { ...memHit } : memHit; // 浅拷贝，防止调用方修改污染缓存
            }
            tlineResultMemCache.delete(memKey);
        }
    }

    // 按日捆绑缓存（回测加速）：整日一个紧凑 JSON 文件，命中时跳过大体积全历史文件读盘
    if (!skipCache && cacheKey) {
        const bundled = getTlineDayBundle(tradeDate).get(cacheKey);
        if (bundled && isTlineCacheComplete(bundled.line, tradeDate)) {
            tlineResultMemCache.set(memKey, bundled);
            return { ...bundled };
        }
    }

    if (!skipCache && cacheKey) {
        // worker 线程读盘解析（不阻塞主线程；旧 tlineFileMemCache 保留给同步调用方 getTlineFromCache）
        let fileHit = tlineFileMemCache.get(cacheKey);
        if (fileHit !== undefined) {
            const dayData = fileHit.find(d => d.trade_date === tradeDate);
            if (dayData && dayData.line && dayData.line.length > 0 && isTlineCacheComplete(dayData.line, tradeDate)) {
                const result = { date: dayData.trade_date, preclose_px: dayData.preclose_px || 0, line: dayData.line };
                tlineResultMemCache.set(memKey, result);
                return { ...result };
            }
        } else {
            const r = await tlineRunWorkerTask({ filePath: path.join(tlineCacheDir, `${cacheKey}.json`), tradeDate });
            if (r.found && isTlineCacheComplete(r.dayData.line, tradeDate)) {
                tlineResultMemCache.set(memKey, r.dayData);
                insertTlineDayCacheEntry(tradeDate, cacheKey, r.dayData); // 登记进按日捆绑缓存（防抖落盘）
                return { ...r.dayData };
            }
            if (r.found) {
                console.log(`分时缓存数据截止时间未到 15:00，视为不完整，重新请求: ${cacheKey} (${code}) ${tradeDate}`);
            }
        }
    }

    // 失败负缓存（2026-11-04 回测加速）：THS/CLS 都拿不到的 (股票, 日期) 记忆 10 分钟，
    // 避免同一笔回测区间内反复超时重试（如长期停牌/退市代码每次都拖 2 次接口超时）。
    // 当日（live）数据随时会出现（竞价→开盘后逐分钟生成），失败不可负缓存，否则盘中负缓存期内涨幅/强度分全部为 '--'
    const failKey = `${code}|${tradeDate}`;
    if (!isToday) {
        const failMemo = tlineFailMemo.get(failKey);
        if (failMemo && Date.now() < failMemo) {
            return null;
        }
    }

    // 历史日期分时路由：CLS/THS 之间加权随机（LB 不支持按日期查，跳过）
    let result = null;
    const histOrder = buildTryOrder('tlineHistorical');
    for (const src of histOrder) {
        if (src === 'ths') result = await getSingleStockTlineDataByDateFromTHS(code, tradeDate);
        else if (src === 'cls') result = await getSingleStockTlineDataByDateFromCLS(code, tradeDate);
        if (result && result.line && result.line.length > 0) break;
        console.log(`${src.toUpperCase()} 获取股票 ${code} 日期 ${tradeDate} 分时失败，尝试下一个兜底`);
    }
    if (!isToday && (!result || !result.line || result.line.length === 0)) {
        tlineFailMemo.set(failKey, Date.now() + 10 * 60 * 1000);
    }

    // 写入本地缓存
    if (result && cacheKey) {
        saveTlineToCache(cacheKey, tradeDate, result);
    }
    // 当日数据仅在覆盖到收盘（15:00）后才写入结果内存缓存
    // 盘前/午间拿到的不完整当日数据一旦缓存，交易时段（skipCache）内不会刷新，
    // 收盘后所有请求会一直命中脏缓存（曾导致抗分歧诊断当日指数只有1个点、得分全为0）
    if (result && !skipCache) {
        const resultLine = Array.isArray(result.line) ? result.line : [];
        const resultLastMinute = resultLine.length > 0 ? resultLine[resultLine.length - 1]?.minute : null;
        const todayComplete = !isToday || (resultLastMinute != null && resultLastMinute >= 1500);
        if (todayComplete) {
            tlineResultMemCache.set(memKey, result);
            // HTTP 拉到的完整历史分时同样登记进按日捆绑缓存（防抖落盘），下次回测直接命中
            if (isTlineCacheComplete(resultLine, tradeDate)) {
                insertTlineDayCacheEntry(tradeDate, cacheKey, { date: result.date ?? tradeDate, preclose_px: result.preclose_px || 0, line: resultLine });
            }
        }
    }

    return result;
};

const getSingleStockTlineDataByDateFromTHS = async (code, tradeDate) => {
    try {
        const url = getThsTrendUrl();
        const headers = getThsTrendHeaders();
        const requestBody = buildThsTrendRequestBodyWithDate(code, tradeDate);

        const response = await axios.post(url, requestBody, { headers, timeout: tlineReqTimeout(tradeDate) });
        const quoteData = response.data.data?.quote_data?.[0];

        if (!quoteData || !quoteData.value || !Array.isArray(quoteData.value) || quoteData.value.length === 0) {
            return null;
        }

        // 校验返回数据是否确实为请求的日期，避免同花顺忽略 trade_date 返回最新一天数据
        const actualDate = parseInt(timestampToDateStr(quoteData.value[0][0]));
        if (actualDate !== parseInt(tradeDate)) {
            console.log(`同花顺返回 ${actualDate} 分时数据（请求 ${tradeDate}），日期不匹配，改用财联社接口`);
            return null;
        }

        const basePrice = quoteData.base_price;

        let prevPrice = basePrice;
        const line = quoteData.value.map((item, i) => {
            const prevItem = quoteData.value?.[i - 1];
            const timestamp = item[0];
            const lastPx = item[1];
            const volume = item[2];
            const amount = item[3];
            const minute = timestampToMinute(timestamp);

            const effectivePrice = (lastPx !== null && lastPx !== undefined && typeof lastPx === 'number') ? lastPx : prevPrice;
            prevPrice = effectivePrice;

            const change = basePrice > 0 ? parseFloat((((effectivePrice - basePrice) / basePrice) * 100).toFixed(2)) : null;
            const changePx = basePrice > 0 ? parseFloat((effectivePrice - basePrice).toFixed(2)) : null;

            return {
                date: tradeDate,
                minute: minute,
                last_px: effectivePrice,
                av_px: effectivePrice,
                change: change,
                change_px: changePx,
                business_amount: volume - (prevItem?.[2] || 0),
                business_balance: amount - (prevItem?.[3] || 0)
            };
        });

        return {
            date: tradeDate,
            preclose_px: basePrice,
            line: line
        };
    } catch (error) {
        console.error(`同花顺获取股票 ${code} 日期 ${tradeDate} 分时数据失败:`, error.message);
        return null;
    }
};
exports.getSingleStockTlineDataByDate = getSingleStockTlineDataByDate;

// 清空分时内存缓存（供批量回测等一次性场景按日释放，避免数百只股票的分时长期驻留导致堆溢出；
// 只清内存，磁盘缓存文件不受影响，下次读取会自动重新加载）
exports.clearTlineMemCache = () => {
    tlineFileMemCache.clear();
    tlineResultMemCache.clear();
};

// 轻量版按日取分时：只从磁盘缓存解析出请求的那一天并返回，整份历史分时数组不驻留进程内存
// （getTlineFromCache 会把整份历史分时数组写入 tlineFileMemCache；批量回测单日要取数百只成分股，
//   每份文件可达 1MB 级，累计即 GB 级导致堆溢出。此处解析后立即丢弃整份数组）
const getSingleStockTlineDataByDateLean = async (code, tradeDate) => {
    const stockName = getStockNameByCode(code);
    const cacheKey = stockName || String(code);
    const dateNum = parseInt(tradeDate, 10);
    let cached = null;
    try {
        const cacheFile = path.join(tlineCacheDir, `${cacheKey}.json`);
        if (fs.existsSync(cacheFile)) {
            const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            const dayData = Array.isArray(cacheData) ? cacheData.find(d => d.trade_date === dateNum) : null;
            if (dayData && Array.isArray(dayData.line) && dayData.line.length > 0) {
                cached = { date: dayData.trade_date, preclose_px: dayData.preclose_px || 0, line: dayData.line };
            }
        }
    } catch (e) {
        cached = null;
    }
    if (cached && isTlineCacheComplete(cached.line, dateNum)) return cached;

    // 历史分时路由（ByDateLean 路径，磁盘未命中才走 HTTP）
    let result = null;
    const histOrder = buildTryOrder('tlineHistorical');
    for (const src of histOrder) {
        if (src === 'ths') result = await getSingleStockTlineDataByDateFromTHS(code, tradeDate);
        else if (src === 'cls') result = await getSingleStockTlineDataByDateFromCLS(code, tradeDate);
        if (result && Array.isArray(result.line) && result.line.length > 0) break;
    }
    if (result && Array.isArray(result.line) && result.line.length > 0) {
        saveTlineToCache(cacheKey, dateNum, result);
        tlineFileMemCache.delete(cacheKey); // 落盘后立即释放，不保留整份历史分时
    }
    return result;
};
exports.getSingleStockTlineDataByDateLean = getSingleStockTlineDataByDateLean;

/**
 * 获取批量个股的数据
 * @param {*} stockCodeList 股票代码列表
 * @param {*} limit 数据量，默认 1 天
 * @returns [{ 'sh688981': { stockName: '中芯国际', kline: [{}, {}] } }]
 **/
let num = 0;
const getStockListData = async (stockCodeList, limit = 1) => {
    const codes = Object.keys(stockCodeList);
    // 限制并发：一次性并发上百个请求容易触发上游限流/超时，导致大量股票抓取失败
    const klineList = await batchParallel(codes, code => getSingleStockData(code, limit), 5);
    
    const stockListData = {};
    for (let i = 0; i < klineList.length; i++) {
        const code = codes[i];
        const kline = klineList[i];
        
        // 过滤掉没有 k 线数据的股票，防止后续逻辑报错
        if (kline && Array.isArray(kline) && kline.length > 0) {
            stockListData[code] = {
                stockName: stockCodeList[code],
                kline: kline.sort((a, b) => b.trade_date - a.trade_date),
            };
        }
    }
    return stockListData;
};

// 轮询股票列表数据，并且存储到本地的 src/data/stockData.json 文件中
const refreshStockData = async () => {
    try {
        const monitorStocks = getMonitorStocks();
        const stockListObj = {};
        monitorStocks.forEach(s => {
            stockListObj[s.code] = s.name;
        });

        console.log(`Manual refresh: monitoring ${monitorStocks.length} stocks, unique codes: ${Object.keys(stockListObj).length}`);

        const stockListData = await getStockListData(stockListObj, 1);
        console.log(`Manual refresh: fetched ${Object.keys(stockListData).length} stocks data`);

        // 竞价阶段 K 线仍是上一交易日 bar，先用实时快照的竞价涨跌幅覆盖再落盘
        await applyAuctionQuotesFallback(stockListData);

        let localDataList = {};
        try {
            localDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        } catch (e) {
            localDataList = {};
        }

        for (const code in stockListData) {
            const kline = localDataList[code] && localDataList[code].kline && localDataList[code].kline[0];
            const newKline = stockListData[code].kline && stockListData[code].kline[0];
            
            if (newKline) {
                if (kline) {
                    stockListData[code].kline[0].change_diff = newKline.change - kline.change;
                } else {
                    stockListData[code].kline[0].change_diff = 0;
                }
            }

            const monitorStock = monitorStocks.find(s => s.code === code);
            if (monitorStock) {
                stockListData[code].isImportant = monitorStock.isImportant;
            }
        }

        // 合并写入：本轮抓取失败的股票保留上一次的数据，避免上游抖动导致自选股大面积"消失"
        const mergedStockData = { ...localDataList, ...stockListData };
        const monitorCodeSet = new Set(monitorStocks.map(s => s.code));
        Object.keys(mergedStockData).forEach(code => {
            if (!monitorCodeSet.has(code)) delete mergedStockData[code];
        });

        fs.writeFileSync(
            stockDataPath,
            JSON.stringify(mergedStockData, null, 2),
            'utf-8'
        );
        console.log('---------- 手动刷新股票列表数据完成！----------', new Date().toLocaleString());
        return { success: true, message: '刷新成功', count: Object.keys(mergedStockData).length };
    } catch (error) {
        console.error("手动刷新股票数据失败:", error.message);
        return { success: false, message: error.message };
    }
};
exports.refreshStockData = refreshStockData;
exports.getOpeningPrices = getOpeningPrices;
exports.saveOpeningPricesIfNeeded = saveOpeningPricesIfNeeded;

exports.pollStockData = async (pollInterval = 10000) => {
    const task = async () => {
        if (!isTradingHours()) return;
        try {
            const monitorStocks = getMonitorStocks();
            const stockListObj = {};
            monitorStocks.forEach(s => {
                stockListObj[s.code] = s.name;
            });

            console.log(`Poll: monitoring ${monitorStocks.length} stocks, unique codes: ${Object.keys(stockListObj).length}`);

            const stockListData = await getStockListData(stockListObj, 1);
            console.log(`Poll: fetched ${Object.keys(stockListData).length} stocks data`);

            // 竞价阶段 K 线仍是上一交易日 bar，先用实时快照的竞价涨跌幅覆盖再落盘
            // （不覆盖的话，本轮询每 5s 会把上一交易日数据写回 stockData.json，手动刷新的竞价兜底也会被冲掉）
            await applyAuctionQuotesFallback(stockListData);

            let localDataList = {};
            try {
                localDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
            } catch (e) {
                localDataList = {};
            }

            for (const code in stockListData) {
                const kline = localDataList[code] && localDataList[code].kline && localDataList[code].kline[0];
                const newKline = stockListData[code].kline && stockListData[code].kline[0];
                
                if (newKline) {
                    if (kline) {
                        stockListData[code].kline[0].change_diff = newKline.change - kline.change;
                    } else {
                        stockListData[code].kline[0].change_diff = 0;
                    }
                }

                const monitorStock = monitorStocks.find(s => s.code === code);
                if (monitorStock) {
                    stockListData[code].isImportant = monitorStock.isImportant;
                }
            }

            // 合并写入：本轮抓取失败的股票保留上一次的数据，避免上游抖动导致自选股大面积"消失"
            const mergedStockData = { ...localDataList, ...stockListData };
            const monitorCodeSet = new Set(monitorStocks.map(s => s.code));
            Object.keys(mergedStockData).forEach(code => {
                if (!monitorCodeSet.has(code)) delete mergedStockData[code];
            });

            fs.writeFileSync(
                stockDataPath,
                JSON.stringify(mergedStockData, null, 2),
                'utf-8'
            );
            saveOpeningPricesIfNeeded();
            console.log('---------- 轮询股票列表数据完成！----------', new Date().toLocaleString());
        } catch (error) {
            console.error("轮询股票数据任务失败:", error.message);
        }
    };

    await task();

    setInterval(task, pollInterval);
}

// 读取本地 stockData 中的数据，返回需要告警的股票
exports.filterUnNormalStockData = () => {
    const unNormalStockList = [];
    const seenCodes = new Set();
    const stockDataList = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    const monitorStocks = getMonitorStocks();
    const openingPrices = getOpeningPrices();
    const data = Object.entries(stockDataList);
    // 同一只股票可能同时命中"急速异动"和"异常波动"两种条件，需按 code 去重避免重复展示
    const pushUnique = (item) => {
        if (seenCodes.has(item.code)) return;
        seenCodes.add(item.code);
        unNormalStockList.push(item);
    };
    
    for (let i = 0; i < data.length; i++) {
        const [code, value] = data[i];
        const kline = value.kline[0];
        const monitorStock = monitorStocks.find(s => s.code === code);
        const isImportant = monitorStock ? monitorStock.isImportant : false;

        const savedOpening = openingPrices.prices?.[code];
        const openPx = savedOpening?.open_px || kline.open_px;
        const closePx = kline.close_px;
        const aboveOpening = (openPx !== undefined && closePx !== undefined) ? closePx >= openPx : null;

        // 如果涨幅前后相差超过 0.3%，则认为是急速异动股票
        if (Math.abs(kline.change_diff) > 0.3) {
            const item = {
                type: 1,
                name: value.stockName,
                code,
                isImportant,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: `急速异动，异动幅度：${kline.change_diff.toFixed(2)}%`,
                open_px: openPx,
                close_px: closePx,
                above_opening: aboveOpening
            };
            pushUnique(item);
            // 将当前的数据写入到 data/jisuyidong.json 中，先把之前的数据读取出来，然后再塞进去，再写入
            try {
                const localData = JSON.parse(fs.readFileSync(jisuyidongPath, 'utf-8')) || {};
                if (localData[item.code]) {
                    if (kline.change_diff > 0) {
                        localData[item.code].up++;
                    } else {
                        localData[item.code].down++;
                    }
                    localData[item.code].change = item.change;
                } else {
                    localData[item.code] = {
                        stockName: item.name,
                        change: item.change,
                        up: 0,
                        down: 0,
                    };
                }
                fs.writeFileSync(
                    jisuyidongPath,
                    JSON.stringify(localData, null, 2),
                    'utf-8'
                );
            } catch (e) {
                console.log('---------- 写入极速异动股票数据失败！----------', e);
            }
        }
        // 果当日最新的涨幅涨超 2%，或者跌超 -2%，则认为是异常波动股票
        if (Math.abs(kline.change) > 2) {
            pushUnique({
                type: 2,
                name: value.stockName,
                code,
                isImportant,
                change: kline.change,
                change_diff: kline.change_diff,
                desc: kline.change > 0 ? '涨幅>2%' : '跌幅>-2%',
                open_px: openPx,
                close_px: closePx,
                above_opening: aboveOpening
            });
        }
    }
    return unNormalStockList;
};

const getAllStockData = () => {
    const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
    const monitorStocks = getMonitorStocks();
    const monitorCodes = monitorStocks.map(s => s.code);

    // 过滤掉不在监控列表中的股票数据
    const filteredStockEntries = Object.entries(stockData).filter(([code]) => monitorCodes.includes(code));

    // 将股票数据转换为数组，每个对象包含独立的code字段，再按涨幅从高到低排序
    const sortedStockArray = filteredStockEntries.map(([code, value]) => {
        // 取出kline的第一项，打平到最外层
        const latestKline = value.kline?.[0] || {};
        const monitorStock = monitorStocks.find(s => s.code === code);
        return {
            code,
            stockName: monitorStock?.name || value.stockName,
            isImportant: monitorStock ? monitorStock.isImportant : false,
            isTop: monitorStock ? monitorStock.isTop : false,
            isTech: monitorStock ? monitorStock.isTech !== false : true,
            blockName: monitorStock?.blockName || '',
            riskScore: monitorStock?.riskScore ?? null,
            // 关注市值 / 关注 PE 开关（2026-10-31）：右键「编辑」弹窗预填用；存量数据缺失按 true
            watchMarketCap: monitorStock ? monitorStock.watchMarketCap !== false : true,
            watchPE: monitorStock ? monitorStock.watchPE !== false : true,
            ...latestKline
        };
    }).sort((a, b) => {
        const changeA = a.change || 0;
        const changeB = b.change || 0;
        return changeB - changeA;
    });
    return sortedStockArray;
}
exports.getAllStockData = getAllStockData;

// 主动触发更新特定股票的数据（用于新增股票时立即显示）
exports.triggerUpdateStockData = async (codes) => {
    try {
        if (!codes || codes.length === 0) return;
        
        const monitorStocks = getMonitorStocks();
        const stockListObj = {};
        codes.forEach(code => {
            const stock = monitorStocks.find(s => s.code === code);
            if (stock) {
                stockListObj[code] = stock.name;
            }
        });

        if (Object.keys(stockListObj).length === 0) return;

        const newData = await getStockListData(stockListObj, 1);
        
        let localData = {};
        if (fs.existsSync(stockDataPath)) {
            localData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
        }

        for (const code in newData) {
            const monitorStock = monitorStocks.find(s => s.code === code);
            if (monitorStock) {
                newData[code].isImportant = monitorStock.isImportant;
                newData[code].kline[0].change_diff = 0; // 新增的默认为 0
                localData[code] = newData[code];
            }
        }

        fs.writeFileSync(stockDataPath, JSON.stringify(localData, null, 2), 'utf-8');
        console.log(`Triggered immediate update for: ${codes.join(', ')}`);
    } catch (e) {
        console.error('Trigger update stock data failed:', e);
    }
};

const getJiSuYiDongRankData = () => {
    let jisuyidongData = {};
    try {
        jisuyidongData = JSON.parse(fs.readFileSync(jisuyidongPath, 'utf-8')) || {};
    } catch (e) {
        console.error('解析 jisuyidong.json 失败，重置为空对象:', e.message);
        fs.writeFileSync(jisuyidongPath, '{}', 'utf-8');
    }
    // 将股票数据转换为数组，每个对象包含独立的code字段，再按涨幅从高到低排序
    const stockArray = Object.entries(jisuyidongData).map(([code, value]) => {
        return {
            code,
            stockName: value.stockName,
            change: value.change,
            up: value.up,
            down: value.down,
        };
    });
    // stockArray 根据每个对象的 up 字段从高到低排序
    const upList = stockArray.sort((a, b) => {
        const upA = a.up || 0;
        const upB = b.up || 0;
        return upB - upA;
    });
    const downList = stockArray.sort((a, b) => {
        const downA = a.down || 0;
        const downB = b.down || 0;
        return downB - downA;
    });
    // 取 upList 和 downList 的前 20 个
    const result = {
        upList: upList.slice(0, 20).filter(item => item.up > 0),
        downList: downList.slice(0, 20).filter(item => item.down > 0),
    };
    return result;
};
exports.getJiSuYiDongRankData = getJiSuYiDongRankData;

// (async () => {
//     console.log(await getSingleStockDataFromTHS('603986', 100));
// })()