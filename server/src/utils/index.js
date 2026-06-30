const { clsReqStockUrl, clsReqDaPanUrl, clsReqStockTlineUrl, clsReqEmotionUrl, clsReqIndexUrl, dfcfBlockMoneyUrl, dfcfBlockMoneyIndustryUrl, clsReqMainFundUrl, dfcfStockTlineDay2Url } = require('../constant');

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

// 返回财联社请求主力资金流向数据的 url
exports.getClsReqMainFundUrl = (code) => {
    return clsReqMainFundUrl.replace('$code', code);
}

// 返回东方财富请求近两个交易日分时数据的 url
exports.getDFCFStockTlineDay2Url = (code) => {
    code = code.slice(2);
    if (code.startsWith('60') || code.startsWith('688')) {
        code = `1.${code}`;
    } else if (code.startsWith('30')) {
        code = `4.${code}`;
    } else if (code.startsWith('00')) {
        code = `0.${code}`;
    }
    return dfcfStockTlineDay2Url.replace('$code', code).replace('$timestamp', Date.now());
}

// 使用当前时间戳生成一个唯一 id
exports.generateUniqueId = () => {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

