// 股票日K临时缓存
// 用途：一次刷新/轮询任务内，同一只股票可能在多个板块（分类）中重复出现，
//       首次请求后把结果落到临时目录，后续再遇到同一只股票直接读缓存，任务结束后删除临时目录。
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');
const { getThsKlineUrl, getThsKlineHeaders, buildThsKlineRequestBody, timestampToDateStr } = require('../utils');

const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');

class StockKlineTempCache {
    constructor(prefix = 'stock_kline') {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `dingpan_${safeName(prefix)}_`));
        this.hits = 0;
        this.misses = 0;
    }

    _fileOf(code, startDate) {
        return path.join(this.dir, `${safeName(code)}_${safeName(startDate)}.json`);
    }

    // 命中返回缓存数组；未命中返回 null
    get(code, startDate) {
        const file = this._fileOf(code, startDate);
        if (!fs.existsSync(file)) {
            this.misses++;
            return null;
        }
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            this.hits++;
            return data;
        } catch (e) {
            this.misses++;
            return null;
        }
    }

    set(code, startDate, data) {
        try {
            fs.writeFileSync(this._fileOf(code, startDate), JSON.stringify(data));
        } catch (e) {
            console.error(`写入股票缓存失败 ${code}:`, e.message);
        }
    }

    getStats() {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            total,
            hitRate: total > 0 ? this.hits / total : 0,
        };
    }

    cleanup() {
        try {
            fs.rmSync(this.dir, { recursive: true, force: true });
        } catch (e) {
            console.error('清理股票临时缓存失败:', e.message);
        }
    }
}

// 请求单只股票日K（成交额、收盘价）
const fetchStockKline = async (code, startDate) => {
    if (!code) return [];

    const codeStr = String(code);
    const pureCode = codeStr.replace(/^[a-zA-Z]+/, '');

    const start = dayjs(startDate);
    const end = dayjs();
    const daysDiff = end.diff(start, 'day');
    const limit = Math.max(daysDiff + 60, 120);

    try {
        const url = getThsKlineUrl();
        const headers = getThsKlineHeaders();
        const requestBody = buildThsKlineRequestBody(pureCode, limit);

        const response = await axios.post(url, requestBody, { headers });

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

        const result = [];
        for (let i = 0; i < valueArray.length; i++) {
            const item = valueArray[i];
            if (item.length < 7) continue;
            result.push({
                date: timestampToDateStr(item[0]),
                amount: item[6],
                close: item[4],
            });
        }

        return result;
    } catch (error) {
        console.error(`获取股票 ${code} K线数据失败:`, error.message);
        return [];
    }
};

// 优先读临时缓存，未命中再请求并回填缓存
const fetchStockKlineCached = async (cache, code, startDate) => {
    if (cache) {
        const cached = cache.get(code, startDate);
        if (cached) return cached;
    }
    const data = await fetchStockKline(code, startDate);
    if (cache) cache.set(code, startDate, data);
    return data;
};

exports.StockKlineTempCache = StockKlineTempCache;
exports.fetchStockKline = fetchStockKline;
exports.fetchStockKlineCached = fetchStockKlineCached;
