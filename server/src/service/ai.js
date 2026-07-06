const fs = require('fs');
const path = require('path');
const { getJigouReportsDataWithResearch } = require('./jigouReports');

const dataDir = path.resolve(__dirname, '../data');

// 通用采样函数：从最新数据开始，往前间隔 interval 个取一次，最后保持时间正序返回
const sampleEveryN = (arr, interval = 10) => {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length === 1) return [arr[0]];
  const result = [arr[arr.length - 1]];
  let i = arr.length - 1 - interval;
  while (i >= 0) {
    result.push(arr[i]);
    if (i < interval) break; // 剩余不足 interval 个，取第一个并结束
    i -= interval;
  }
  // 补上第一个（如果未被取到）
  if (result[result.length - 1] !== arr[0]) {
    result.push(arr[0]);
  }
  return result.reverse();
};

/**
 * 获取全局分析聚合数据
 * 1. 板块历史（block_data_change_time.json）- 直接采样
 * 2. 板块资金变化（blockMoneyChangeTime.json）- 采样 + time 转 HH:mm + 仅保留 money/block
 * 3. 成交量（amount.json）- 采样 + time 序列化 + 字段重命名
 * 4. 个股数据（stockData.json）- 只取名称和 change
 * 5. 板块资金日历史（block_money_day_history.json）- 最近 5 天
 * 6. 大盘数据（dapanData.json）- 全部返回
 * 7. 科技情绪指数（tech_index.json）- 最近 10 天
 */
// 过滤掉 15:00 之后的数据，time 可为 "HH:mm" 或 "HHmmss" 纯数字
const filterAfterClose = (arr, getTime) => {
  return arr.filter(item => {
    const raw = String(getTime(item) || '').replace(/\D/g, '');
    if (raw.length < 4) return true;
    const hh = parseInt(raw.slice(0, 2), 10);
    const mm = parseInt(raw.slice(2, 4), 10);
    const minutes = hh * 60 + mm;
    return minutes <= 15 * 60;
  });
};

const getGlobalAnalysisData = () => {
  // 1. 板块历史
  const blockHistoryRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'block_data_change_time.json'), 'utf8'));
  const blockHistory = sampleEveryN(filterAfterClose(blockHistoryRaw, item => item.time));

  // 2. 板块资金变化
  const blockMoneyRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'blockMoneyChangeTime.json'), 'utf8'));
  const blockMoneyChange = sampleEveryN(filterAfterClose(blockMoneyRaw, item => item.time), 5).map(item => {
    const timeStr = String(item.time || '').replace(/\D/g, '');
    const hh = timeStr.slice(0, 2);
    const mm = timeStr.slice(2, 4);
    const time = hh && mm ? `${hh}:${mm}` : '';
    const data = (item.data || []).map(d => ({ money: d.money, block: d.block }));
    return { time, data };
  });

  // 3. 成交量
  const amountRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'amount.json'), 'utf8'));
  const amount = sampleEveryN(filterAfterClose(amountRaw, item => item[0]), 40).map(item => {
    const [timeStr, obj] = item;
    const digits = String(timeStr || '').replace(/\D/g, '');
    const hh = digits.slice(0, 2);
    const mm = digits.slice(2, 4);
    const ss = digits.slice(4, 6);
    const time = hh && mm ? (ss ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`) : '';
    return {
      time,
      '主力资金流入流出': obj?.mainMoney ?? '',
      '相较上一日成交量变化': obj?.amountChangeDiff ?? '',
    };
  });

  // 4. 个股数据：只取名称和 change
  const stockDataRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'stockData.json'), 'utf8'));
  const stockData = Object.values(stockDataRaw).map(item => ({
    名称: item.stockName || '',
    change: item.kline?.[0]?.change ?? '',
  }));

  // 5. 板块资金日历史（最近 5 天，数据从新到旧排列）
  const blockMoneyDayHistoryRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'block_money_day_history.json'), 'utf8'));
  const blockMoneyDayHistory = blockMoneyDayHistoryRaw.slice(0, 5);

  // 6. 大盘数据（全部返回）
  const dapanData = JSON.parse(fs.readFileSync(path.join(dataDir, 'dapanData.json'), 'utf8'));

  // 7. 科技情绪指数（最近 10 天，数据从新到旧排列）
  const techIndexRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tech_index.json'), 'utf8'));
  const techIndex = techIndexRaw.slice(0, 10);

  return {
    blockHistory: blockHistory.slice(-5),
    blockMoneyChange: blockMoneyChange.slice(-5),
    amount: amount.slice(-5),
    stockData,
    blockMoneyDayHistory,
    dapanData,
    techIndex,
  };
};

const generateAIContext = () => {
    const data = getGlobalAnalysisData();
    const { reports, researchReports } = getJigouReportsDataWithResearch();
    return {
        '今日板块分时历史数据': data.blockHistory,
        '今日板块资金流入流出数据': data.blockMoneyChange,
        '大盘主力资金和成交量数据': data.amount,
        '今日个股涨跌幅数据': data.stockData,
        '近5天板块资金日历史数据': data.blockMoneyDayHistory,
        '大盘数据': data.dapanData,
        '科技情绪指数（近10天）': data.techIndex,
        '机构调研交流圈最新帖子': reports,
        '近6天研报内容': researchReports,
    }
};

const getMarketStyleAnalysis = () => {
  const filePath = path.join(dataDir, 'market_style_analysis.json');
  if (!fs.existsSync(filePath)) {
    return { content: '', updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { content: '', updatedAt: null };
  }
};

const updateMarketStyleAnalysis = (content) => {
  const filePath = path.join(dataDir, 'market_style_analysis.json');
  const data = {
    content,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
};

// (async () => {
//     const res = generateAIContext();
//     fs.writeFileSync('./result.json', JSON.stringify(res, null ,2));
// })()

module.exports = {
  generateAIContext,
  getMarketStyleAnalysis,
  updateMarketStyleAnalysis
};
