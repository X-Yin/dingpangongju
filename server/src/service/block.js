// 返回重点板块数据
const path = require('path');
const fs = require('fs');
const { default: blockCodeList } = require('../constant/block_code.js');
const { getSingleStockData } = require('./stock');
const { sleep } = require('../utils/index.js');
const dayjs = require('dayjs');

const blockPath = path.resolve(__dirname, '../data/block_data.json');
const previousRankPath = path.resolve(__dirname, '../data/previous_block_rank.json');

// 保存上一次的排名数据
const savePreviousRank = (blockList) => {
  const rankMap = {};
  blockList.forEach((item, index) => {
    rankMap[item.blockName] = index;
  });
  fs.writeFileSync(previousRankPath, JSON.stringify(rankMap, null, 2));
};

// 读取上一次的排名数据
const getPreviousRank = () => {
  try {
    const data = fs.readFileSync(previousRankPath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
};

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

// 找出涨幅前十和跌幅前十的板块返回
const getTopAndBottomBlockData = (num = 10) => {
  const blockData = getBlockData();
  const previousRank = getPreviousRank();
  
  // 为每个板块计算排名变化
  const blockDataWithRankChange = blockData.map((item, currentIndex) => {
    const previousIndex = previousRank[item.blockName];
    let rankChange = 0;
    if (previousIndex !== undefined) {
      // 排名数字越小越好，所以如果 currentIndex 0，previousIndex 是 2，说明前进了 2 名
      rankChange = previousIndex - currentIndex;
    }
    return {
      ...item,
      rankChange
    };
  });
  
  // 保存当前排名，供下次使用
  savePreviousRank(blockData);
  
  const firstNumList = blockDataWithRankChange.slice(0, num);
  // 先获取最后num个数据，再按跌幅从大到小（即涨跌幅从小到大）排序
  const lastNumList = blockDataWithRankChange.slice(-num).sort((a, b) => a.avgChange - b.avgChange);
  
  // 找出排名提升 >= 3 和 下降 >= 3 的板块
  const upRankBlocks = blockDataWithRankChange.filter(item => item.rankChange >= 3).map(item => ({
    blockName: item.blockName,
    rankChange: item.rankChange,
    avgChange: item.avgChange
  }));
  const downRankBlocks = blockDataWithRankChange.filter(item => item.rankChange <= -3).map(item => ({
    blockName: item.blockName,
    rankChange: item.rankChange,
    avgChange: item.avgChange
  }));

  return {
    firstNumList,
    lastNumList,
    upRankBlocks,
    downRankBlocks,
    defensiveBlock: blockDataWithRankChange.filter(i => ['煤炭', '电力', '银行', '医药', '消费'].includes(i.blockName)).map(i => ({
      blockName: i.blockName,
      avgChange: i.avgChange
    }))
  };
}

const getCurrentDayHotBlock = () => {
  const currentDayHotBlock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/current_day_hot_block.json'), 'utf-8') || '[]');
  return currentDayHotBlock;
}

// 每隔 1min 自动读取一次板块数据，并且计算每个板块的 avgChange，将时间和结果储存到本地的 data/block_history.json 文件中
const pollBlockHistory = async (interval = 60000) => {
  const task = async () => {
    const blockData = getBlockData();
    const blockHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_history.json'), 'utf-8') || '[]');
    blockHistory.push({
      time: dayjs().format('HH:mm'),
      blockData: blockData.map(item => ({
        blockName: item.blockName,
        avgChange: item.avgChange
      }))
    });
    fs.writeFileSync(path.resolve(__dirname, '../data/block_history.json'), JSON.stringify(blockHistory, null, 2));
  };
  setInterval(task, interval);
}

let num = 0;
const getBlockHistory = () => {
  // if (num === 0) {
  //     num++;
  //     return require('../mock/block_history_1.json');
  // }
  // return require('../mock/block_history_2.json');

  const blockHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_history.json'), 'utf-8') || '[]');
  return blockHistory;
}

const getBlockDayHistory = () => {
  const blockDayHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_data_day_history.json'), 'utf-8') || '[]');
  return blockDayHistory;
};

const updateBlockDayHistory = () => {
  // 先通过 getBlockData 获取最新的板块数据，然后序列化成 block_data_day_history.json 内部的格式，存储下来
  const blockData = getBlockData();
  const blockDayHistory = getBlockDayHistory();
  const today = dayjs().format('YYYYMMDD');
  
  // 将 blockData 数组转换成对象格式，与旧数据保持一致
  const blocksObj = {};
  blockData.forEach(item => {
    blocksObj[item.blockName] = {
      avgChange: item.avgChange
    };
  });
  
  // 检查今天是否已经有记录
  const existingIndex = blockDayHistory.findIndex(item => item.date === today);
  
  if (existingIndex !== -1) {
    // 如果今天已经有记录，则替换
    blockDayHistory[existingIndex] = {
      date: today,
      blocks: blocksObj
    };
  } else {
    // 如果今天没有记录，则追加
    blockDayHistory.unshift({
      date: today,
      blocks: blocksObj
    });
  }
  
  fs.writeFileSync(path.resolve(__dirname, '../data/block_data_day_history.json'), JSON.stringify(blockDayHistory, null, 2));
};

const updateBlockMoneyDayHistory = async () => {
  const blockData = JSON.parse(fs.readFileSync(blockPath, 'utf-8') || '{}');
  const blockMoneyDayHistoryPath = path.resolve(__dirname, '../data/block_money_day_history.json');
  
  // 读取历史数据
  let historyData = [];
  try {
    historyData = JSON.parse(fs.readFileSync(blockMoneyDayHistoryPath, 'utf-8') || '[]');
  } catch (e) {
    historyData = [];
  }
  
  const today = dayjs().format('YYYYMMDD');
  const blockAmounts = {};
  
  // 遍历每个板块
  for (const blockName in blockData) {
    const stocks = blockData[blockName];
    let totalAmount = 0;
    
    // 获取每个股票的成交金额
    for (const stock of stocks) {
      try {
        const klineData = await getSingleStockData(stock.code, 1);
        if (klineData && klineData[0] && klineData[0].business_balance) {
          totalAmount += klineData[0].business_balance;
        }
        await sleep(1000); // 避免请求过快
      } catch (e) {
        console.log(`获取股票 ${stock.name} 成交金额失败:`, e.message);
      }
    }
    
    blockAmounts[blockName] = totalAmount;
  }
  
  // 检查今天是否已经有记录
  const existingIndex = historyData.findIndex(item => item.date === today);
  
  if (existingIndex !== -1) {
    // 如果今天已经有记录，则替换
    historyData[existingIndex] = {
      date: today,
      blockAmounts
    };
  } else {
    // 如果今天没有记录，则追加
    historyData.unshift({
      date: today,
      blockAmounts
    });
  }
  
  // 写入文件
  fs.writeFileSync(blockMoneyDayHistoryPath, JSON.stringify(historyData, null, 2));
  
  return blockAmounts;
};

const getBlockMoneyDayHistory = () => {
  const blockMoneyDayHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_money_day_history.json'), 'utf-8') || '[]');
  return blockMoneyDayHistory;
};

exports.getBlockData = getBlockData;
exports.pollBlockData = pollBlockData;
exports.getTopAndBottomBlockData = getTopAndBottomBlockData;
exports.getCurrentDayHotBlock = getCurrentDayHotBlock;
exports.pollBlockHistory = pollBlockHistory;
exports.getBlockHistory = getBlockHistory;
exports.getBlockDayHistory = getBlockDayHistory;
exports.updateBlockDayHistory = updateBlockDayHistory;
exports.getBlockMoneyDayHistory = getBlockMoneyDayHistory;
exports.updateBlockMoneyDayHistory = updateBlockMoneyDayHistory;