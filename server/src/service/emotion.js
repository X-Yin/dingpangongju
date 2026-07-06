// 复盘大盘的情绪，为后续操作出手时机提供参考

const { getClsReqEmotionUrl, getClsReqIndexUrl, getClsReqUrl } = require("../utils");
const { getDaPanData } = require("./dapan");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const { getMonitorStocks } = require('./monitorStock');

const emotionPath = path.join(__dirname, "../data/emotion.json");
const techIndexPath = path.join(__dirname, "../data/tech_index.json");

// 获取当天的涨停板和跌停板个数，以及炸板率，作为当日情绪计算的依据
const getCurrentEmotionData = async () => {
    const dapanData = await getDaPanData();
    const { up_down_dis } = dapanData;
    const { up_num, down_num } = up_down_dis;
    const response = await axios.get(getClsReqEmotionUrl());
    const { up_ratio } = response.data.data;
    // 计算当日的情绪，涨停和跌停的情绪比重为 0.4，炸板率的比重为 0.6
    const emotion = 0.4 * (up_num - down_num) - 0.6 * (1 - parseFloat(up_ratio));
    return {
        emotion: parseFloat(emotion.toFixed(2)),
        up_num,
        down_num,
        up_ratio,
    };
}

// 写入当日的情绪数据
const updateCurrentEmotionData = async () => {
    const emotionData = await getCurrentEmotionData();
    // 写入本地的 src/data/emotion.json
    const data = {
        date: dayjs().format('YYYYMMDD'),
        originData: {
            up_num: emotionData.up_num,
            down_num: emotionData.down_num,
            up_ratio: parseFloat(emotionData.up_ratio),
        },
        emotion: emotionData.emotion,
    }
    // 先读取本地的 src/data/emotion.json
    const oldData = fs.readFileSync(emotionPath, "utf-8") || '[]';
    const oldDataJson = JSON.parse(oldData);
    // 合并新的情绪数据，检查重复日期，如有则覆盖
    const existingIndex = oldDataJson.findIndex(item => item.date === data.date);
    if (existingIndex !== -1) {
        oldDataJson[existingIndex] = data;
    } else {
        oldDataJson.push(data);
    }
    // 写入本地的 src/data/emotion.json
    fs.writeFileSync(emotionPath, JSON.stringify(oldDataJson, null, 2));
}
exports.updateCurrentEmotionData = updateCurrentEmotionData;


// 获取所有日期的情绪数据
const getAllEmotionData = async () => {
    const data = fs.readFileSync(emotionPath, "utf-8") || '[]';
    return JSON.parse(data);
}
exports.getAllEmotionData = getAllEmotionData;

// 获取所有指数的 k 线数据
const getAllIndexKlineData = async () => {
    const shangzhengCode = 'sh000001';
    const chuangyebanCode = 'sz399006';
    const kechuangbanCode = 'sh000688';
    const { data: { data: shangzhengData } } = await axios.get(getClsReqIndexUrl(shangzhengCode, 100));
    const { data: { data: chuangyebanData } } = await axios.get(getClsReqIndexUrl(chuangyebanCode, 100));
    const { data: { data: kechuangbanData } } = await axios.get(getClsReqIndexUrl(kechuangbanCode, 100));
    return {
        shangzhengData,
        chuangyebanData,
        kechuangbanData,
    };
}
exports.getAllIndexKlineData = getAllIndexKlineData;


// 定义计算科技指数的成分股
const updateCurrentTechIndexData = async () => {
    const monitorStocks = getMonitorStocks();
    const stockCodes = monitorStocks.map(s => s.code);
    const changeSumData = [];
    const klineDataArr = [];
    for (let stockCode of stockCodes) {
        const { data: { data: klineData } } = await axios.get(getClsReqUrl(stockCode, 1));
        if (klineData && klineData.length > 0) {
            klineDataArr.push(klineData[0].change);
        }
    }
    const changeSumResult = klineDataArr.reduce((acc, cur) => acc + cur, 0);
    changeSumData.push({
        date: Number(dayjs().format('YYYYMMDD')),
        changeSumResult: parseFloat(changeSumResult.toFixed(2)),
    });

    // 先把之前的 tech_index.json 的数据读出来，然后合并新的数据，检查重复日期，如有则覆盖
    const oldData = fs.readFileSync(techIndexPath, "utf-8") || '[]';
    const oldDataJson = JSON.parse(oldData);
    // 合并新的数据，检查重复日期，如有则覆盖
    changeSumData.forEach(item => {
        const existingIndex = oldDataJson.findIndex(existingItem => existingItem.date === item.date);
        if (existingIndex !== -1) {
            oldDataJson[existingIndex] = item;
        } else {
            oldDataJson.push(item);
        }
    });
    fs.writeFileSync(techIndexPath, JSON.stringify(oldDataJson, null, 2));
}

const getAllTechIndexData = () => {
    const data = fs.readFileSync(techIndexPath, "utf-8") || '[]';
    return JSON.parse(data);
}
exports.getAllTechIndexData = getAllTechIndexData;
exports.updateCurrentTechIndexData = updateCurrentTechIndexData;
