// 获取大盘数据，返回需要告警的数据

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getClsReqDaPanUrl, sleep } = require("../utils");
const { getAmountInfo } = require('./amount');

const dapanDataPath = path.resolve(__dirname, '../data/dapanData.json');

const getDaPanData = async () => {
    const response = await axios.get(getClsReqDaPanUrl());
    const data = response.data.data;
    return data;
}

exports.pollDaPanData = async (interval = 10000) => {
    const task = async () => {
        const data = await getDaPanData();
        fs.writeFileSync(dapanDataPath, JSON.stringify(data, null, 2));
        console.log('---------- 轮询大盘数据完成！----------', new Date().toLocaleString());
    };

    // 立即执行一次
    await task();

    setInterval(task, interval);
}

exports.filterUnNormalDaPanData = () => {
    const unNormalDaPanData = [];
    const { index_quote, up_down_dis } = JSON.parse(fs.readFileSync(dapanDataPath, 'utf-8'));
    for (const item of index_quote) {
        // 哪个变成绿的就认为是异常波动大盘
        if (item.change < 0) {
            unNormalDaPanData.push({
                name: item.secu_name,
                change: Number((item.change * 100).toFixed(2)),
            });
        }
    }
    // 下跌家数超过 3000 家，认为市场情绪有问题
    if (up_down_dis.fall_num > 3000) {
        unNormalDaPanData.push({
            name: '全市场下跌家数',
            change: -up_down_dis.fall_num,
        });
    }
    return unNormalDaPanData;
}

exports.getAllDaPanData = async () => {
    const v1 = JSON.parse(fs.readFileSync(dapanDataPath, 'utf-8'));
    const amountInfo = await getAmountInfo();
    return {
        ...v1,
        ...amountInfo,
    }
}

// let num = 0;
// exports.getAllDaPanData = () => {
//     num++;
//     return {
//         "index_quote": [
//             {
//                 "secu_code": "sh000001",
//                 "last_px": 4057.74 - num * 1,
//             },
//             {
//                 "secu_code": "sz399001",
//                 "last_px": 15340.356,
//             },
//             {
//                 "secu_code": "sz399006",
//                 "last_px": 3950.943,
//             },
//             {
//                 "secu_code": "sh000688",
//                 "last_px": 1663.693,
//             }
//         ],
//         mainMoney: '-200',
//         amountChangeDiff: -1000 + num * 10 + ''
//     }
// }