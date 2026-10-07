const axios = require('axios');

// 同花顺个股热度榜（fuyao 热度榜，type=hour 为小时维度，返回前 100）
const THS_HOT_RANK_URL = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock';

const THS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const buildThsHeaders = () => ({
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://eq.10jqka.com.cn/',
    'Origin': 'https://eq.10jqka.com.cn',
    'User-Agent': THS_UA,
});

// 结果缓存：前端 5min 轮询一次，服务端缓存 60s 兜底，避免重复请求同花顺
const CACHE_TTL = 60 * 1000;
let cache = { data: null, ts: 0 };

// 获取同花顺热度前 100，字段与前端热度榜保持一致（当前排名/代码/股票名称/涨跌幅）
const getThsHotRank = async () => {
    if (cache.data && Date.now() - cache.ts < CACHE_TTL) return cache.data;
    const { data } = await axios.get(THS_HOT_RANK_URL, {
        params: { stock_type: 'a', type: 'hour', list_type: 'normal' },
        headers: buildThsHeaders(),
        timeout: 15000,
    });
    const list = data?.data?.stock_list || [];
    const result = list.map((it, idx) => ({
        当前排名: it.order ?? idx + 1,
        代码: it.code,
        股票名称: it.name,
        涨跌幅: typeof it.rise_and_fall === 'number' ? it.rise_and_fall : null,
    }));
    cache = { data: result, ts: Date.now() };
    return result;
};

module.exports = { getThsHotRank };