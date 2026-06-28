const clsReqConfig = {
    stock_sign: 'b6239aaba9b1502299315b18090783a8',
    dapan_sign: 'b02d8f7bc4c45eeb3e86904203597da2',
};

exports.clsReqStockUrl = `https://x-quote.cls.cn/v2/quote/a/kline?fq_type=1&app=CailianpressWeb&code=$code&limit=$limit&os=web&period=d&sv=8.7.9&sign=${clsReqConfig.stock_sign}`

exports.clsReqDaPanUrl = `https://x-quote.cls.cn/quote/index/home?app=CailianpressWeb&os=web&sv=8.7.9&sign=${clsReqConfig.dapan_sign}`

exports.clsReqStockTlineUrl = `https://x-quote.cls.cn/v2/quote/a/tline?app=CailianpressWeb&os=web&secu_code=$code&sv=8.7.9&sign=${clsReqConfig.stock_sign}`;

exports.clsReqEmotionUrl = `https://x-quote.cls.cn/v2/quote/a/stock/emotion?app=CailianpressWeb&os=web&sv=8.7.9&sign=${clsReqConfig.dapan_sign}`

// 请求各个指数的 k 线图接口
exports.clsReqIndexUrl = `https://x-quote.cls.cn/v2/quote/a/kline?app=CailianpressWeb&code=$code&limit=$limit&os=web&period=d&sv=8.7.9&sign=${clsReqConfig.stock_sign}`

// 请求东方财富的概念资金流入流出板块接口
exports.dfcfBlockMoneyUrl = 'https://data.eastmoney.com/dataapi/bkzj/getbkzj?key=f62&code=m%3A90%2Bt%3A3' 

// 请求东方财富的行业资金流入流出板块接口
exports.dfcfBlockMoneyIndustryUrl = 'https://data.eastmoney.com/dataapi/bkzj/getbkzj?key=f62&code=m%3A90%2Bs%3A4';

// 股票列表
const { stockList } = require('./stock_list');
exports.stockList = stockList;