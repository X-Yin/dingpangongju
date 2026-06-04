const { clsReqStockUrl, clsReqDaPanUrl, clsReqStockTlineUrl, clsReqEmotionUrl, clsReqIndexUrl } = require('../constant');

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
