const clsReqConfig = {
    stock_sign: 'b6239aaba9b1502299315b18090783a8',
    dapan_sign: 'b02d8f7bc4c45eeb3e86904203597da2',
};

exports.clsReqStockUrl = `https://x-quote.cls.cn/v2/quote/a/kline?fq_type=1&app=CailianpressWeb&code=$code&limit=$limit&os=web&period=d&sv=8.7.9&sign=${clsReqConfig.stock_sign}`

exports.clsReqDaPanUrl = `https://x-quote.cls.cn/quote/index/home?app=CailianpressWeb&os=web&sv=8.7.9&sign=${clsReqConfig.dapan_sign}`

exports.clsReqStockTlineUrl = `https://x-quote.cls.cn/v2/quote/a/tline?app=CailianpressWeb&os=web&secu_code=$code&sv=8.7.9&sign=${clsReqConfig.stock_sign}`;