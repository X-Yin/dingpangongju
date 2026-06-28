const { clsReqStockUrl, clsReqDaPanUrl, clsReqStockTlineUrl, clsReqEmotionUrl, clsReqIndexUrl, dfcfBlockMoneyUrl, dfcfBlockMoneyIndustryUrl } = require('../constant');

exports.sleep = async (n) => {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve('');
        }, n);
    })
}

// 返回财联社请求 k 线数据的 url
exports.getClsReqUrl = (code, limit) => {
    return clsReqStockUrl.replace('$code', code).replace('$limit', limit);
}

exports.getClsReqStockTlineUrl = (code) => {
    return clsReqStockTlineUrl.replace('$code', code);
}

// 返回财联社请求大盘数据的 url
exports.getClsReqDaPanUrl = () => {
    return clsReqDaPanUrl;
}

// 返回财联社请求情绪情绪数据的 url
exports.getClsReqEmotionUrl = () => {
    return clsReqEmotionUrl;
}

// 返回财联社请求指数 k 线数据的 url
exports.getClsReqIndexUrl = (code, limit) => {
    return clsReqIndexUrl.replace('$code', code).replace('$limit', limit);
}

// 返回东方财富请求板块资金流入流出数据的 url
exports.getDFCFBlockMoneyUrl = () => {
    return dfcfBlockMoneyUrl;
}

// 返回东方财富请求行业资金流入流出数据的 url
exports.getDFCFBlockMoneyIndustryUrl = () => {
    return dfcfBlockMoneyIndustryUrl;
}

// 使用当前时间戳生成一个唯一 id
exports.generateUniqueId = () => {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

