const fs = require('fs');
const path = require('path');
const axios = require('axios');

const RIHAN_DATA_PATH = path.resolve(__dirname, '../data/rihan.json');

const SINA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// 外盘指数均通过新浪环球/期货接口获取，不再依赖 Puppeteer 打开网页
const NQ_FUTURES_SINA_URL = 'https://w.sinajs.cn/list=hf_NQ';          // 纳指期货
const KS11_SINA_URL = 'https://w.sinajs.cn/list=znb_KOSPI';             // 韩国综合指数
const N225_SINA_URL = 'https://w.sinajs.cn/list=znb_NKY';               // 日经225

const buildSinaHeaders = (referer) => ({
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Connection': 'keep-alive',
    'Referer': referer,
    'Sec-Fetch-Dest': 'script',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Storage-Access': 'active',
    'User-Agent': SINA_UA,
    'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
});

// 从新浪接口获取单个环球指数（znb_* 常规盘）
// 返回结构：var hq_str_znb_XXX = "名称,最新价,涨跌额,涨跌幅,时间,时间戳,日期,时间,昨收,今开,最高,最低,0";
const fetchIndexFromSina = async (url, referer, name, code) => {
    try {
        const { data } = await axios.get(url, {
            headers: buildSinaHeaders(referer),
            timeout: 15000,
            responseType: 'text',
            transformResponse: [(d) => d],
        });
        const start = data.indexOf('"');
        const end = data.lastIndexOf('"');
        if (start === -1 || end <= start) throw new Error('响应格式异常');
        const fields = data.slice(start + 1, end).split(',');
        const value = Number(fields[1]);
        const changePct = Number(fields[3]);
        if (!Number.isFinite(value) || !Number.isFinite(changePct)) throw new Error('字段解析失败');
        return {
            name,
            code,
            change: `${changePct.toFixed(2)}%`,
            value: `${value.toFixed(2)}`,
        };
    } catch (error) {
        console.error(`>>> 获取${name}数据失败:`, error.message);
        return { name, code, change: '--', value: '--' };
    }
};

// 从新浪接口获取期货指数（hf_* 实时期货）
// 返回结构：var hq_str_hf_NQ = "最新价,,昨收,今开,最高,最低,时间,... ,开盘原始价,...";
// fields[0] 最新价, fields[1] 空, fields[2] 昨收, fields[8] 开盘原始数据
// 涨幅 = (最新价 - 开盘原始数据) / 开盘原始数据
const fetchFuturesFromSina = async (url, referer, name, code) => {
    try {
        const { data } = await axios.get(url, {
            headers: buildSinaHeaders(referer),
            timeout: 15000,
            responseType: 'text',
            transformResponse: [(d) => d],
        });
        const start = data.indexOf('"');
        const end = data.lastIndexOf('"');
        if (start === -1 || end <= start) throw new Error('响应格式异常');
        const fields = data.slice(start + 1, end).split(',');
        const value = Number(fields[0]);                 // 实时价
        const openRef = Number(fields[8]);                // 开盘原始价
        if (!Number.isFinite(value) || !Number.isFinite(openRef)) throw new Error('字段解析失败');
        const changePct = ((value - openRef) / openRef) * 100;
        return {
            name,
            code,
            change: `${changePct.toFixed(2)}%`,
            value: `${value.toFixed(2)}`,
        };
    } catch (error) {
        console.error(`>>> 获取${name}数据失败:`, error.message);
        return { name, code, change: '--', value: '--' };
    }
};

// 手动刷新外盘指数数据（同时供轮询和 API 调用）
// 返回顺序：纳指期货 → 韩国综合指数 → 日经225
const refreshRiHanData = async () => {
    try {
        const [nq, ks11, n225] = await Promise.all([
            fetchFuturesFromSina(NQ_FUTURES_SINA_URL, 'https://gu.sina.cn/ft/hq/hf.php?symbol=NQ&autocallup=no&isfromsina=yes', '纳指期货', 'NQ'),
            fetchIndexFromSina(KS11_SINA_URL, 'https://quotes.sina.cn/index/global/ks11', '韩国综合指数', 'KS11'),
            fetchIndexFromSina(N225_SINA_URL, 'https://quotes.sina.cn/index/global/n225', '日经225', 'N225'),
        ]);
        const result = [nq, ks11, n225];
        fs.writeFileSync(RIHAN_DATA_PATH, JSON.stringify(result, null, 2));
        console.log(`>>> 外盘指数更新成功 (${new Date().toLocaleTimeString()}):`, result.map(r => `${r.name}: ${r.change}`).join(', '));
        return result;
    } catch (e) {
        console.error('>>> 外盘指数获取失败:', e.message);
        throw e;
    }
};

const pollRiHanData = async () => {
    console.log('>>> 启动日韩指数监控...');

    // 首次立即执行
    await refreshRiHanData();
    // 每隔60秒刷新一次（日韩指数无需高频跟踪）
    setInterval(refreshRiHanData, 60000);
};

const getRiHanData = () => {
    if (fs.existsSync(RIHAN_DATA_PATH)) {
        let data = JSON.parse(fs.readFileSync(RIHAN_DATA_PATH, 'utf-8'));
        data = data.filter(i => !i.name.includes('KOSPI200'));
        return data;
    }
    return [];
};

module.exports = {
    pollRiHanData,
    getRiHanData,
    refreshRiHanData,
};
