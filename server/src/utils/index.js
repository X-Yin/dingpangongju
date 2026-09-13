const { clsReqStockUrl, clsReqDaPanUrl, clsReqStockTlineUrl, clsReqEmotionUrl, clsReqIndexUrl, dfcfBlockMoneyUrl, dfcfBlockMoneyIndustryUrl, clsReqMainFundUrl, dfcfStockTlineDay2Url, clsReqStockTlineDay5Url, thsKlineUrl, thsKlineHeaders, thsMarketMap, thsTrendUrl, thsTrendHeaders, clsReqStockBasicUrl } = require('../constant');

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

// 返回财联社请求个股基础信息（总股本等）的 url
exports.getClsReqStockBasicUrl = (code) => {
    return clsReqStockBasicUrl.replace('$code', code);
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

// 返回财联社请求五日分时数据的 url
exports.getClsReqStockTlineDay5Url = (code) => {
    return clsReqStockTlineDay5Url.replace('$code', code);
}

// 使用当前时间戳生成一个唯一 id
exports.generateUniqueId = () => {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 根据股票代码前缀获取同花顺市场代码
exports.getThsMarketCode = (code) => {
    const prefix = code.substring(0, 2);
    return thsMarketMap[prefix] || '17';
};

// 根据完整代码(含sh/sz前缀或1B前缀)获取同花顺市场代码
// 支持个股和指数：sh000001→16(上证指数,THS code 1A0001), sh000688→16(科创50,THS 1B0688), sz399xxx→32(创业板指)
exports.getThsMarketCodeForCode = (code) => {
    if (code === 'sh000001') return '16'; // 上证指数 → THS 1A0001
    if (code === 'sh000688') return '16'; // 科创50 → THS 1B0688
    if (code.startsWith('sh000')) return '17'; // 其他上证指数
    if (code.startsWith('sz399')) return '32';
    const pureCode = code.replace(/^[a-zA-Z]+/, '');
    if (pureCode.startsWith('1A')) return '16';
    if (pureCode.startsWith('1B')) return '16';
    const prefix = pureCode.substring(0, 2);
    return thsMarketMap[prefix] || '17';
};

// 将财联社代码转换为同花顺代码
// 上证指数: CLS sh000001 → THS 1A0001 (market=16)
// 科创50: CLS sh000688 → THS 1B0688 (market=16)
// 其他代码: 去掉 sh/sz 前缀即可
exports.convertClsToThsCode = (code) => {
    if (code === 'sh000001') return '1A0001';
    if (code === 'sh000688') return '1B0688';
    return code.replace(/^[a-zA-Z]+/, '');
};

// 获取同花顺K线API的URL
exports.getThsKlineUrl = () => {
    return thsKlineUrl;
};

// 获取同花顺K线API的请求头
exports.getThsKlineHeaders = () => {
    return thsKlineHeaders;
};

// 构建同花顺K线API的请求体
exports.buildThsKlineRequestBody = (code, limit) => {
    const market = exports.getThsMarketCode(code);
    return {
        code_list: [{
            codes: [code],
            market: market
        }],
        trade_class: 'intraday',
        time_period: 'day_1',
        trade_date: -1,
        begin_time: -limit,
        end_time: 0,
        adjust_type: 'forward',
        gpid: 1
    };
};

// 将时间戳(毫秒)转换为YYYYMMDD格式
exports.timestampToDateStr = (timestamp) => {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
};

// 获取同花顺分时API的URL
exports.getThsTrendUrl = () => {
    return thsTrendUrl;
};

// 获取同花顺分时API的请求头
exports.getThsTrendHeaders = () => {
    return thsTrendHeaders;
};

// 构建同花顺分时API的请求体
exports.buildThsTrendRequestBody = (code) => {
    const market = exports.getThsMarketCodeForCode(code);
    const thsCode = exports.convertClsToThsCode(code);
    return {
        code_list: [{
            codes: [thsCode],
            market: market
        }],
        trade_date: 0,
        gpid: 1,
        time_zone: 'Asia/Shanghai',
        trade_class: 'intraday'
    };
};

// 构建同花顺分时API的请求体（指定交易日期）
// tradeDate: YYYYMMDD格式的数字，如 20260710
exports.buildThsTrendRequestBodyWithDate = (code, tradeDate) => {
    const market = exports.getThsMarketCodeForCode(code);
    const thsCode = exports.convertClsToThsCode(code);
    return {
        code_list: [{
            codes: [thsCode],
            market: market
        }],
        trade_date: tradeDate,
        gpid: 1,
        time_zone: 'Asia/Shanghai',
        trade_class: 'intraday'
    };
};

// 将毫秒时间戳转换为分钟格式(如930表示9:30)
exports.timestampToMinute = (timestamp) => {
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    return hours * 100 + minutes;
};

// 批量并行请求，每次最多 batchSize 个并发
exports.batchParallel = async (items, fn, batchSize = 10) => {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
    }
    return results;
};

// 判断是否为周末
exports.isWeekend = (date = new Date()) => {
    const day = date.getDay();
    return day === 0 || day === 6;
};

// 判断是否在午休时段（11:30-13:00）
exports.isMiddayBreak = (date = new Date()) => {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const timeVal = hours * 60 + minutes;
    // 11:30 = 11*60+30 = 690, 13:00 = 13*60 = 780
    return timeVal >= 690 && timeVal < 780;
};

// 判断是否已收盘（15:05及以后）
exports.isAfterMarketClose = (date = new Date()) => {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    return hours > 15 || (hours === 15 && minutes >= 5)
};

// 判断是否在交易时段内（9:15-11:30, 13:00-15:05，非周末）
exports.isTradingHours = (date = new Date()) => {
    if (exports.isWeekend(date)) return false;
    if (exports.isMiddayBreak(date)) return false;
    if (exports.isAfterMarketClose(date)) return false;
    
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const timeVal = hours * 60 + minutes;
    // 9:15 = 9*60+15 = 555
    return timeVal >= 555;
};

// 获取距离下一个交易时段开始的毫秒数
exports.getMsToNextTradingSession = (date = new Date()) => {
    const now = new Date(date);
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const timeVal = hours * 60 + minutes;
    
    // 如果在午休，返回距离13:00的时间
    if (timeVal >= 690 && timeVal < 780) {
        const next = new Date(now);
        next.setHours(13, 0, 0, 0);
        return next.getTime() - now.getTime();
    }
    
    // 如果在收盘后或周末，返回距离明天9:15的时间（简化处理）
    // 实际使用中通常由外部进程管理器负责重启
    const next = new Date(now);
    if (exports.isWeekend(now) || timeVal >= 900 /* 15:00 */) {
        // 找下一个工作日
        do {
            next.setDate(next.getDate() + 1);
        } while (exports.isWeekend(next));
        next.setHours(9, 15, 0, 0);
    }
    
    return next.getTime() - now.getTime();
};

