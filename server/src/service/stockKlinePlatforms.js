// 多平台个股日K请求（板块成交量占比轮询兜底使用）
// - 同花顺 / 财联社 / 雪球：复用线上已有的 HTTP 请求逻辑
// 统一返回 [{ date: 'YYYYMMDD', amount: 成交额(元), close: 收盘价 }]，按日期升序
// 2026-11-05：新增 source='auto' 支持 CLS/THS 加权随机（默认 60/40），
//             主源失败时自动兜底到另一只主力；显式 'cls'/'ths' 保持原有单源语义不变。
// 2026-11-15：新增 'xq'（雪球）；auto 模式按 code 稳定哈希分散到 XQ / CLS / THS，失败依次兜底。
const axios = require('axios');
const dayjs = require('dayjs');
const { getClsReqUrl } = require('../utils');
const { fetchStockKline } = require('./stockKlineCache');
const { fetchXueqiuKline } = require('./xueqiu');
const { buildTryOrder } = require('../config');

// 平台标识 → 展示名称
const PLATFORM_NAMES = {
    ths: '同花顺',
    cls: '财联社',
    xq: '雪球',
};

const toPlainCode = (code) => String(code || '').trim().replace(/^[a-zA-Z]+/, '');

const toPrefixedCode = (code) => {
    const raw = String(code || '').trim();
    if (/^(sh|sz|bj)/i.test(raw)) return raw.toLowerCase();
    const plain = toPlainCode(raw);
    if (/^[69]/.test(plain)) return `sh${plain}`;
    if (/^[48]/.test(plain)) return `bj${plain}`;
    return `sz${plain}`;
};

// 把各平台返回的 K 线统一成 { date, amount, close } 并过滤脏数据
const normalizeRows = (rows) => (Array.isArray(rows) ? rows : [])
    .map((item) => {
        const date = String(item && item.date !== undefined ? item.date : '').replace(/-/g, '').slice(0, 8);
        const amount = Number(item && item.amount);
        const close = Number(item && item.close);
        if (date.length !== 8 || !/^\d{8}$/.test(date)) return null;
        return {
            date,
            amount: Number.isFinite(amount) ? amount : null,
            close: Number.isFinite(close) ? close : null,
        };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

// 同花顺日K（线上已有逻辑）
const fetchThsKline = async (code, startDate) => {
    const rows = await fetchStockKline(toPlainCode(code), startDate);
    return normalizeRows(rows);
};

// 财联社日K（线上已有逻辑，代码需要 sh/sz 前缀）
const fetchClsKline = async (code, startDate) => {
    const limit = Math.min(Math.max(dayjs().diff(dayjs(startDate), 'day'), 10), 30);
    const resp = await axios.get(getClsReqUrl(toPrefixedCode(code), limit), { timeout: 15000 });
    const body = resp.data;
    if (!body || Number(body.code) !== 200 || !Array.isArray(body.data)) {
        throw new Error(`财联社日K返回异常: ${(body && body.msg) || 'unknown'}`);
    }
    return normalizeRows(body.data.map((item) => ({
        date: item.trade_date,
        amount: item.business_balance,
        close: item.close_px,
    })));
};

// 雪球日K（2026-11-15 新增，需匿名 cookie，模块内自动维护）
const fetchXqKline = async (code, startDate) => {
    const limit = Math.min(Math.max(dayjs().diff(dayjs(startDate), 'day'), 10), 60);
    // 雪球超时硬上限 1s，超时由 auto 兜底链切财联社 / 同花顺
    const rows = await fetchXueqiuKline(code, limit, 1000);
    return normalizeRows(rows.map((item) => ({
        date: item.trade_date,
        amount: item.business_balance,
        close: item.close_px,
    })));
};

// 单只股票日K：单源请求（auto 时内部做随机 + 兜底）
const fetchSingleKline = async (platform, code, startDate) => {
    // 显式指定 → 原有单源语义
    if (platform === 'ths') return fetchThsKline(code, startDate);
    if (platform === 'cls') return fetchClsKline(code, startDate);
    if (platform === 'xq') return fetchXqKline(code, startDate);

    // auto：按权重选主源（同 code 稳定命中同一主源，保证重算可复现），失败按兜底链依次重试
    if (!platform || platform === 'auto') {
        const tryOrder = buildTryOrder('kline', code).filter((src) => src === 'cls' || src === 'ths' || src === 'xq');
        let lastError = null;
        for (const src of tryOrder) {
            try {
                const rows = src === 'cls'
                    ? await fetchClsKline(code, startDate)
                    : src === 'ths'
                        ? await fetchThsKline(code, startDate)
                        : await fetchXqKline(code, startDate);
                if (rows && rows.length > 0) return rows;
            } catch (e) {
                lastError = e;
                console.warn(`[kline-auto] ${PLATFORM_NAMES[src]} ${code} 失败：${e.message}，尝试下一个兜底源`);
            }
        }
        if (lastError) throw lastError;
        return [];
    }

    throw new Error(`未知平台: ${platform}`);
};

// 批量日K：同平台并发请求，返回 Map(code → rows)
// platform='auto' 时：每只股票独立随机选主源（60/40），保持并发粒度不变
const fetchKlineBatch = async (platform, codes, startDate) => {
    const result = new Map();
    if (!codes || codes.length === 0) return result;

    const settled = await Promise.allSettled(
        codes.map((code) => fetchSingleKline(platform || 'auto', code, startDate))
    );
    settled.forEach((item, index) => {
        result.set(codes[index], item.status === 'fulfilled' ? item.value : []);
    });
    return result;
};

exports.PLATFORM_NAMES = PLATFORM_NAMES;
exports.fetchSingleKline = fetchSingleKline;
exports.fetchKlineBatch = fetchKlineBatch;
