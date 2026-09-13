// 返回重点板块数据
const path = require('path');
const fs = require('fs');
const { getBlocksConfig } = require('./blockConfig');
const { getSingleStockData } = require('./stock');
const { sleep, batchParallel } = require('../utils/index.js');
const { useCLS } = require('../config');
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
// 过滤掉占位符条目（code === '__block_placeholder__'），但保留板块名
const divideBlockCodeList = (codeList) => {
  const blockGroupData = {};
  for (const item of codeList) {
    // 跳过占位符条目
    if (item.code === '__block_placeholder__') continue;
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
    try {
      // 每次获取最新的配置
      const blockCodeList = getBlocksConfig();
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

        if (useCLS()) await sleep(1000);
      }
      console.log('---------- 轮询板块数据完成！---------- ', new Date().toLocaleString());
    } catch (error) {
      console.error("轮询板块数据任务失败:", error.message);
    }
  };

  // 立即执行一次
  task(); // 不 await，因为板块数据比较多，同步执行会阻塞后续流程，但它会立即开始执行

  setInterval(task, interval);
}

const getBlockData = () => {
  const blockData = JSON.parse(fs.readFileSync(blockPath, 'utf-8') || '{}');
  
  // 每次获取最新的配置
  const blockCodeList = getBlocksConfig();
  
  // 从配置文件获取所有板块和股票的对应关系（排除占位符）
  const configGroups = divideBlockCodeList(blockCodeList);
  
  // 获取所有板块名
  const allBlockNames = new Set(blockCodeList.map(item => item.blockName));
  const blockList = [];
  
  allBlockNames.forEach(blockName => {
    // 配置中的股票列表
    const configStocks = configGroups[blockName] || [];
    
    // 实时行情中的股票列表（以 code 为 key）
    const marketDataMap = {};
    (blockData[blockName] || []).forEach(item => {
      marketDataMap[item.code] = item;
    });
    
    // 合并：以配置为准，实时行情作为补充
    const mergedData = configStocks.map(stock => {
      const marketData = marketDataMap[stock.code];
      if (marketData) {
        return {
          ...stock,
          change: marketData.change,
          price: marketData.price,
          open: marketData.open,
          high: marketData.high,
          low: marketData.low,
          volume: marketData.volume,
          amount: marketData.amount,
        };
      } else {
        // 没有实时行情数据，显示默认值
        return {
          ...stock,
          change: 0,
          price: null,
          noMarketData: true, // 标记为无行情数据
        };
      }
    });
    
    // 计算平均涨跌幅（只计算有行情数据的股票）
    const stocksWithData = mergedData.filter(s => !s.noMarketData);
    const avgChange = stocksWithData.length > 0
      ? Number((stocksWithData.reduce((acc, cur) => acc + cur.change, 0) / stocksWithData.length).toFixed(2))
      : 0;
    
    blockList.push({
      blockName,
      avgChange,
      data: mergedData.sort((a, b) => {
        // 有行情数据的排在前面
        if (a.noMarketData && !b.noMarketData) return 1;
        if (!a.noMarketData && b.noMarketData) return -1;
        // 按涨跌幅排序
        return b.change - a.change;
      })
    });
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

// 每隔 1min 自动读取一次板块数据，并且计算每个板块的 avgChange，将时间和结果储存到本地的 data/block_data_change_time.json 文件中
const pollBlockHistory = async (interval = 60000) => {
  const task = async () => {
    try {
      const blockData = getBlockData();
      const blockHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_data_change_time.json'), 'utf-8') || '[]');
      blockHistory.push({
        time: dayjs().format('HH:mm'),
        blockData: blockData.map(item => ({
          blockName: item.blockName,
          avgChange: item.avgChange
        }))
      });
      fs.writeFileSync(path.resolve(__dirname, '../data/block_data_change_time.json'), JSON.stringify(blockHistory, null, 2));
    } catch (error) {
      console.error("记录板块历史数据失败:", error.message);
    }
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

  const blockHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_data_change_time.json'), 'utf-8') || '[]');
  return blockHistory;
}

const getBlockDayHistory = () => {
  const blockDayHistory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/block_data_day_history.json'), 'utf-8') || '[]');
  return blockDayHistory;
};

const updateBlockDayHistory = () => {
  const blockHistoryPath = path.resolve(__dirname, '../data/block_data_change_time.json');
  const blockHistory = JSON.parse(fs.readFileSync(blockHistoryPath, 'utf-8') || '[]');
  
  if (!Array.isArray(blockHistory) || blockHistory.length === 0) {
    throw new Error('当日暂无板块分时数据，无法记录收盘历史');
  }
  
  const lastRecord = blockHistory[blockHistory.length - 1];
  const blockDayHistory = getBlockDayHistory();
  const today = dayjs().format('YYYYMMDD');
  
  const blocksObj = {};
  lastRecord.blockData.forEach(item => {
    blocksObj[item.blockName] = {
      avgChange: item.avgChange
    };
  });
  
  const existingIndex = blockDayHistory.findIndex(item => item.date === today);
  
  if (existingIndex !== -1) {
    blockDayHistory[existingIndex] = {
      date: today,
      blocks: blocksObj
    };
  } else {
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
    
    const fetchAmount = async (stock) => {
      try {
        const klineData = await getSingleStockData(stock.code, 1);
        if (klineData && klineData[0] && klineData[0].business_balance) {
          return klineData[0].business_balance;
        }
      } catch (e) {
        console.log(`获取股票 ${stock.name} 成交金额失败:`, e.message);
      }
      return 0;
    };

    if (useCLS()) {
      for (const stock of stocks) {
        totalAmount += await fetchAmount(stock);
        await sleep(1000);
      }
    } else {
      const amounts = await batchParallel(stocks, fetchAmount, 10);
      totalAmount = amounts.reduce((sum, val) => sum + val, 0);
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

const scheduleBlockDayHistory = (hour = 15, minute = 1) => {
  let executedDates = new Set();

  const task = () => {
    const now = dayjs();
    const today = now.format('YYYYMMDD');
    const dayOfWeek = now.day();

    if (dayOfWeek === 0 || dayOfWeek === 6) return;

    if (executedDates.has(today)) return;

    const targetTime = now.hour(hour).minute(minute).second(0).millisecond(0);
    if (!now.isAfter(targetTime)) return;

    console.log('开始记录每日板块涨跌幅历史...', now.format('YYYY-MM-DD HH:mm:ss'));
    try {
      updateBlockDayHistory();
      console.log('每日板块涨跌幅历史记录完成:', today);
      executedDates.add(today);
    } catch (e) {
      console.error('每日板块涨跌幅历史记录失败:', e.message);
    }
  };

  task();
  setInterval(task, 60 * 1000);
  console.log(`每日板块涨跌幅历史记录已调度，超过 ${hour}:${String(minute).padStart(2, '0')} 且未记录时将自动执行`);
};

// 立即刷新板块数据（同步等待完成）
const refreshBlockData = async () => {
  console.log('---------- 开始刷新板块数据 ---------- ', new Date().toLocaleString());
  try {
    // 每次获取最新的配置
    const blockCodeList = getBlocksConfig();
    // 拆分板块数据
    const blockGroupData = divideBlockCodeList(blockCodeList);
    const totalBlocks = Object.keys(blockGroupData).length;
    let completedBlocks = 0;

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

      completedBlocks++;
      console.log(`刷新进度: ${completedBlocks}/${totalBlocks} - ${blockName}`);

      if (useCLS()) await sleep(500);
    }
    console.log('---------- 刷新板块数据完成！---------- ', new Date().toLocaleString());
    return { success: true, message: '刷新成功', totalBlocks, updatedAt: new Date().toISOString() };
  } catch (error) {
    console.error("刷新板块数据失败:", error.message);
    return { success: false, message: error.message };
  }
};

exports.getBlockData = getBlockData;
exports.refreshBlockData = refreshBlockData;
exports.pollBlockData = pollBlockData;
exports.getTopAndBottomBlockData = getTopAndBottomBlockData;
exports.getCurrentDayHotBlock = getCurrentDayHotBlock;
exports.pollBlockHistory = pollBlockHistory;
exports.getBlockHistory = getBlockHistory;
exports.getBlockDayHistory = getBlockDayHistory;
exports.updateBlockDayHistory = updateBlockDayHistory;
exports.scheduleBlockDayHistory = scheduleBlockDayHistory;
exports.getBlockMoneyDayHistory = getBlockMoneyDayHistory;
exports.updateBlockMoneyDayHistory = updateBlockMoneyDayHistory;