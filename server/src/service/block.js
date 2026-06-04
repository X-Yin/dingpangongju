// 返回重点板块数据
const path = require('path');
const fs = require('fs');
const { default: blockCodeList } = require('../constant/block_code.js');
const { getSingleStockData } = require('./stock');
const { sleep } = require('../utils/index.js');

const blockPath = path.resolve(__dirname, '../data/block_data.json');

// 对 blockCodeList 做分组，板块相同的放在一起
const divideBlockCodeList = (codeList) => {
    const blockGroupData = {};
    for (const item of codeList) {
        if (!blockGroupData[item.blockName]) {
            blockGroupData[item.blockName] = [];
        }
        blockGroupData[item.blockName].push(item);
    }   
    return blockGroupData;
}

//  根据指定的 codeList 返回板块数据
const getSingleBlockData = async (blockName, codeList) => {
    const promises = [];
    const blockListData = [];
    for (const item of codeList) {
        promises.push(getSingleStockData(item.code, 1));
    }
    const klineList = await Promise.all(promises);
    for (let i = 0; i < klineList.length; i++) {
        const item = klineList[i][0];
        blockListData.push({
            name: codeList[i].name,
            blockName: codeList[i].blockName,
            code: codeList[i].code,
            change: item && item.change || 0
        });
    }

    return { [blockName]: blockListData };
};

// 轮询板块数据，并且写入到本地的文件当中
const pollBlockData = async (interval = 60000) => {
    const task = async () => {
        // 拆分板块数据
        const blockGroupData = divideBlockCodeList(blockCodeList);
        // 每一个板块数据依次写入，防止同时发出的请求太多，接口返回有问题
        for (const blockName in blockGroupData) {
            const blockListData = await getSingleBlockData(blockName, blockGroupData[blockName]);
            let originData = '{}';
            try {
                originData = fs.readFileSync(blockPath, 'utf-8');
            } catch (e) {
                originData = '{}';
            }
            const blockData = JSON.parse(originData || '{}');
            blockData[blockName] = blockListData[blockName];
            fs.writeFileSync(blockPath, JSON.stringify(blockData, null, 2));
            await sleep(1000);
        }
        console.log('---------- 轮询板块数据完成！---------- ', new Date().toLocaleString());
    };

    // 立即执行一次
    task(); // 不 await，因为板块数据比较多，同步执行会阻塞后续流程，但它会立即开始执行

    setInterval(task, interval);
}

const getBlockData = () => {
    const blockData = JSON.parse(fs.readFileSync(blockPath, 'utf-8') || '{}');
    const blockList = Object.keys(blockData).map(blockName => ({
        blockName,
        // 每个板块的平均涨幅
        avgChange: Number((blockData[blockName].reduce((acc, cur) => acc + cur.change, 0) / blockData[blockName].length).toFixed(2)),
        data: blockData[blockName]
    }));
    // 并且每个 blockList 内部的股票也是从高到低排序
    blockList.forEach(item => {
        item.data.sort((a, b) => b.change - a.change);
    });
    return blockList.sort((a, b) => b.avgChange - a.avgChange);
};

// 找出涨幅前五和跌幅前五的板块返回
const getTopAndBottomBlockData = (num = 5) => {
    const blockData = getBlockData();
    const firstNumList = blockData.slice(0, num);
    // 先获取最后num个数据，再按跌幅从大到小（即涨跌幅从小到大）排序
    const lastNumList = blockData.slice(-num).sort((a, b) => a.avgChange - b.avgChange);
    return {
        firstNumList,
        lastNumList,
        defensiveBlock: blockData.filter(i => ['煤炭', '电力', '银行', '医药', '消费'].includes(i.blockName)).map(i => ({
            blockName: i.blockName,
            avgChange: i.avgChange
        }))
    };
}

exports.getBlockData = getBlockData;
exports.pollBlockData = pollBlockData;
exports.getTopAndBottomBlockData = getTopAndBottomBlockData;
