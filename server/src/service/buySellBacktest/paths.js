const path = require('path');

// 数据目录：原文件位于 service/ 下用 '../data'，本文件位于 service/buySellBacktest/ 下需上溯两级
const DATA_DIR = path.resolve(__dirname, '../../data');

// 回测结果缓存文件（按 策略+日期范围 存储，避免重复回测）
const backtestCacheDir = path.join(DATA_DIR, 'backtest_results');
const getBacktestCacheFile = (strategy, startDate, endDate) => path.join(backtestCacheDir, `backtest_${strategy}_${startDate}_${endDate}.json`);

// 研报目录
const researchReportsDir = path.join(DATA_DIR, 'research_reports');

// 科技情绪指数文件
const TECH_INDEX_FILE = path.join(DATA_DIR, 'tech_index.json');

// 自选股（板块名映射）文件
const stockBlockFilePath = path.join(DATA_DIR, 'monitor_stocks.json');

module.exports = { DATA_DIR, backtestCacheDir, getBacktestCacheFile, researchReportsDir, TECH_INDEX_FILE, stockBlockFilePath };
