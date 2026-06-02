const { clsReqStockUrl, clsReqDaPanUrl, clsReqStockTlineUrl } = require('../constant');

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