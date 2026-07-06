// 对当日的大盘和情绪进行诊断，目的是为了排除风险，判断当日是要买入机会，还是要卖出风险
const path = require('path');
const fs = require('fs');
const { getAmountInfo } = require('./amount');
const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
const dapanDataPath = path.resolve(__dirname, '../data/dapanData.json');

// 设定风险规则，返回风险诊断信息 [{ name: '风险名称', value: '风险值', bgColor: '背景颜色' }]
const handleRule = ({ shData, kcData, cyData, amount = {}, stockData }) => {
    const result = [];
    const riskColor = '#F53F3F'; // 风险统一用红色系，适合搭配白色文字
    
    if (shData.change < 0) {
        result.push({ name: '上证指数处于下跌状态', value: (shData.change * 100).toFixed(2) + '%', bgColor: riskColor });
    }
    if (kcData.change < 0) {
        result.push({ name: '科创指数处于下跌状态', value: (kcData.change * 100).toFixed(2) + '%', bgColor: riskColor });
    }
    if (cyData.change < 0) {
        result.push({ name: '创业板指处于下跌状态', value: (cyData.change * 100).toFixed(2) + '%', bgColor: riskColor });
    }
    if (parseFloat(amount.mainMoney) < 0) {
        result.push({ name: '当前主力资金净流出', value: amount.mainMoney, bgColor: riskColor });
    }
    if (parseFloat(amount.amountChangeDiff) < 0) {
        result.push({ name: '当前成交量相比上一日缩量', value: amount.amountChangeDiff, bgColor: riskColor });
    }

    if (stockData) {
        Object.entries(stockData).forEach(([_, value]) => {
            if (value.kline[0].change < -2) {
                result.push({ name: `${value.stockName}处于大幅下跌状态`, value: value.kline[0].change + '%', bgColor: riskColor });
            }
        })
    }

    return result;
};

const diagnose = async () => {
    // 读取股票数据
    const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf8'));
    // 读取大盘数据
    const dapanData = JSON.parse(fs.readFileSync(dapanDataPath, 'utf8'));
    // 读取成交量数据
    // const amount = await getAmountInfo();
    const amount = {};

    // 理论上来说出手的机会只有一种，那就是上证，科创，创业指数都上涨，并且大盘当天还是放量的，并且各个核心股票都在上涨
    const shData = dapanData.index_quote.find(item => item.secu_code === 'sh000001');
    const kcData = dapanData.index_quote.find(item => item.secu_code === 'sh000688');
    const cyData = dapanData.index_quote.find(item => item.secu_code === 'sz399006');
    const result = handleRule({ shData, kcData, cyData, amount, stockData });
    return result;
}

exports.diagnose = diagnose;

