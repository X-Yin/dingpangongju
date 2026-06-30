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

// 财联社股票主力资金流向接口
exports.clsReqMainFundUrl = `
https://x-quote.cls.cn/quote/stock/fundflow?secu_code=$code&app=CailianpressWeb&os=web&sv=8.7.9&sign=b02d8f7bc4c45eeb3e86904203597da2`

// 获取东方财富近两个交易日的分时接口
exports.dfcfStockTlineDay2Url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f17&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b&secid=$code&ndays=2&iscr=0&iscca=0&cb=jsonp$timestamp`

// 股票列表
const { stockList } = require('./stock_list');
exports.stockList = stockList;