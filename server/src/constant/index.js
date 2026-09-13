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

// 获取财联社个股基础信息接口（含总股本 TotalShares、市值、涨跌幅等）
exports.clsReqStockBasicUrl = `https://x-quote.cls.cn/quote/stock/basic?app=CailianpressWeb&fields=open_px,av_px,high_px,low_px,change,change_px,down_price,change_3,change_5,qrr,entrust_rate,tr,amp,TotalShares,mc,NetAssetPS,NonRestrictedShares,cmc,business_amount,business_balance,pe,ttm_pe,pb,secu_name,secu_code,trade_status,secu_type,preclose_px,up_price,last_px&os=web&secu_code=$code&sv=8.7.9&sign=a8739ece26266b1c041e9edfe782b6c0`

// 获取财联社五日分时接口
exports.clsReqStockTlineDay5Url = `https://x-quote.cls.cn/v2/quote/a/tline_5d?app=CailianpressWeb&os=web&secu_code=$code&sv=8.7.9&sign=99d6e467a4ebcc9eae1c490c89993053`

// 股票列表
const { stockList } = require('./stock_list');
exports.stockList = stockList;

// 同花顺K线API配置
exports.thsKlineUrl = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_kline';

exports.thsKlineHeaders = {
    'accept': '*/*',
    'content-type': 'application/json',
    'platform': 'hxkline',
    'x-auth-appname': 'AINVEST',
    'x-auth-progid': '7047',
    'x-auth-type': 'ths',
    'x-auth-version': '1.0',
    'x-fuyao-auth': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdXRob3JpemVyX25hbWVzcGFjZSI6ImNvbW1vbi1ocS1hZ2dyIiwibGljZW5zZWVfdHlwZSI6IkZST05UX0FQUCIsImxpY2Vuc2VlX25hbWVzcGFjZSI6Imh4a2xpbmUtTkVXU19hcHBOZXdzRmxvd0hvbWVfUGFnZSJ9.ldrvWTheNnGOa_rH_buA6OoUpLtW2bhcdr3fABrGHbk',
    'cookie': 'Hm_lvt_78c58f01938e4d85eaf619eae71b4ed1=1783908286,1784347120,1784353963,1784612366; __utma=156575163.1477206887.1776152186.1780211173.1784612665.2; search_history=[{%22keyword%22:%22%E9%9F%A9%E5%9B%BD%E7%BB%BC%E5%90%88%E6%8C%87%E6%95%B0%22%2C%22timestamp%22:1784612677909%2C%22type%22:%22stock%22}]; v=Ax0gB1D8K9zmLM_wfJb6TMkZKvISOlFGW2-1Yt_iW2Sg6TNsp4phXOu-xT5s; _ga_H2RK0R0681=GS2.1.s1784689414$o7$g1$t1784689420$j54$l0$h0'
};

// 市场代码映射：上海(60/68开头) -> 17, 深圳(00/30开头) -> 33
exports.thsMarketMap = {
    '60': '17',
    '68': '17',
    '00': '33',
    '30': '33',
    '39': '32'
};

// 同花顺分时API配置
exports.thsTrendUrl = 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1/single_trend';

exports.thsTrendHeaders = {
    'accept': '*/*',
    'content-type': 'application/json',
    'platform': 'hxkline',
    'x-auth-appname': 'AINVEST',
    'x-auth-progid': '7047',
    'x-auth-type': 'ths',
    'x-auth-version': '1.0',
    'x-fuyao-auth': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdXRob3JpemVyX25hbWVzcGFjZSI6ImNvbW1vbi1ocS1hZ2dyIiwibGljZW5zZWVfdHlwZSI6IkZST05UX0FQUCIsImxpY2Vuc2VlX25hbWVzcGFjZSI6Imh4a2xpbmUtTkVXU19hcHBOZXdzRmxvd0hvbWVfUGFnZSJ9.ldrvWTheNnGOa_rH_buA6OoUpLtW2bhcdr3fABrGHbk'
};