// 东方财富的概念资金流入流出板块

const { getDFCFBlockMoneyUrl, sleep, getDFCFBlockMoneyIndustryUrl } = require('../utils');
const axios = require('axios');
const { default: blockMoneyList } = require('../constant/block_money');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const blockMoneyPath = path.join(__dirname, '../data/blockMoneyChange.json');
const blockMoneyTimePath = path.join(__dirname, '../data/blockMoneyChangeTime.json');


// 每隔 10s 轮询一次接口，将数据存储到本地的 src/data/blockMoneyChange.json 中
const pollDFCFBlockMoney = async (interval = 10000) => {
    setInterval(async () => {
        const res = await axios.get(getDFCFBlockMoneyUrl());
        const totalBlockMoneyChangeList = res.data.data.diff;
        const blockMoneyChangeList = totalBlockMoneyChangeList.filter(item => blockMoneyList.includes(item.f14));
        const result = blockMoneyChangeList.map(item => ({
            money: item.f62,
            block: item.f14,
            blockCode: item.f13 + '.' + item.f12,
            jumpUrl: `https://quote.eastmoney.com/center/gridlist.html#boards2-${item.f13 + '.' + item.f12}`,
        }));

        const res2 = await axios.get(getDFCFBlockMoneyIndustryUrl());
        const totalBlockMoneyIndustryChangeList = res2.data.data.diff;
        const industryBlockMoneyChangeList = totalBlockMoneyIndustryChangeList.filter(item => blockMoneyList.includes(item.f14));
        const industryResult = industryBlockMoneyChangeList.map(item => ({
            money: item.f62,
            block: item.f14,
            blockCode: item.f13 + '.' + item.f12,
            jumpUrl: `https://quote.eastmoney.com/center/gridlist.html#boards2-${item.f13 + '.' + item.f12}`,
        }));

        fs.writeFileSync(blockMoneyPath, JSON.stringify([...result, ...industryResult], null, 2));
    }, interval);
};

const  pollTimeDFCFBlockMoneyChange = (interval = 300000) => {
    setInterval(() => {
        const time = dayjs().format('HHmmss');
        const blockMoneyChangeData = JSON.parse(fs.readFileSync(blockMoneyPath, 'utf-8') || '[]');
        const data = fs.readFileSync(blockMoneyTimePath, 'utf-8') || '[]';
        const dataJson = JSON.parse(data);
        const result = {
            time,
            data: blockMoneyChangeData
        }
        dataJson.push(result);
        fs.writeFileSync(blockMoneyTimePath, JSON.stringify(dataJson));
    }, interval);
};

const getBlockMoneyChangeList = () => {
    const prevContent = fs.readFileSync(blockMoneyPath, 'utf-8') || '[]';
    const prevContentJson = JSON.parse(prevContent);
    return prevContentJson;
};

const getBlockMoneyChangeTimeList = () => {
    const prevContent = fs.readFileSync(blockMoneyTimePath, 'utf-8') || '[]';
    const prevContentJson = JSON.parse(prevContent);
    return prevContentJson;
};

(async () => {
    await pollDFCFBlockMoney();
    sleep(50000);
})();

exports.pollDFCFBlockMoney = pollDFCFBlockMoney;
exports.getBlockMoneyChangeList = getBlockMoneyChangeList;
exports.pollTimeDFCFBlockMoneyChange = pollTimeDFCFBlockMoneyChange;
exports.getBlockMoneyChangeTimeList = getBlockMoneyChangeTimeList;
