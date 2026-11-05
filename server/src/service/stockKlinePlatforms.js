// 多平台个股日K请求（板块成交量占比轮询兜底使用）
// - 同花顺 / 财联社：复用线上已有的 HTTP 请求逻辑
// 统一返回 [{ date: 'YYYYMMDD', amount: 成交额(元), close: 收盘价 }]，按日期升序
// 2026-11-05：新增 source='auto' 支持 CLS/THS 加权随机（默认 60/40），
//             主源失败时自动兜底到另一只主力；显式 'cls'/'ths' 保持原有单源语义不变。
const axios = require('axios');
const dayjs = require('dayjs');
const { getClsReqUrl } = require('../utils');
const { fetchStockKline } = require('./stockKlineCache');
const { pickPrimarySource } = require('../config');

// 平台标识 → 展示名称
const PLATFORM_NAMES = {
    ths: '同花顺',
    cls: '财联社',
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

// 单只股票日K：单源请求（auto 时内部做随机 + 兜底）
const fetchSingleKline = async (platform, code, startDate) => {
    // 显式指定 → 原有单源语义
    if (platform === 'ths') return fetchThsKline(code, startDate);
    if (platform === 'cls') return fetchClsKline(code, startDate);

    // auto：按权重选主源，失败兜底另一只主力
    if (!platform || platform === 'auto') {
        const primary = pickPrimarySource('kline');
        const other = primary === 'cls' ? 'ths' : 'cls';
        try {
            const rows = await (primary === 'cls' ? fetchClsKline(code, startDate) : fetchThsKline(code, startDate));
            if (rows && rows.length > 0) return rows;
        } catch (e) {
            // 主源失败继续兜底
            console.warn(`[kline-auto] ${PLATFORM_NAMES[primary]} ${code} 失败：${e.message}，兜底 ${PLATFORM_NAMES[other]}`);
        }
        return (other === 'cls' ? fetchClsKline(code, startDate) : fetchThsKline(code, startDate));
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
