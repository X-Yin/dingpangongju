const { execSync, spawn } = require('child_process');
const net = require('net');

const { setConfig } = require('./config');

const useCLS = process.argv.includes('--cls');
setConfig({ useCLS });
console.log(`数据源模式: ${useCLS ? '财联社(CLS)' : '同花顺(THS)'}`);

// 引入 express
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { filterUnNormalDaPanData, getAllDaPanData } = require('./service/dapan');
const { filterUnNormalStockData, getSingleStockData, getSingleStockTlineData, getSingleStockTlineDataByDate, getAllStockData, getJiSuYiDongRankData, triggerUpdateStockData, refreshStockData, getOpeningPrices } = require('./service/stock');
const { getBlockData, refreshBlockData, getTopAndBottomBlockData, getCurrentDayHotBlock, getBlockHistory, getBlockDayHistory, updateBlockDayHistory, getBlockMoneyDayHistory, updateBlockMoneyDayHistory } = require('./service/block');
// const { diagnose } = require('./service/diagnose');
const { getJingJiaQiangChouData } = require('./service/jingjiaqiangchou');
const { getKaiPanZhuDongData, getKaiPanHighChangeStocks } = require('./service/kaipanzhudong');
const { getRiHanData, refreshRiHanData } = require('./service/rihan');
const { getKaiPanXiaCuoData } = require('./service/kaipanxiacuo');
const { getAmountHistory, getAmountDayHistory, updateAmountDayHistory } = require('./service/amount');
const { getAllEmotionData, getAllIndexKlineData, updateCurrentEmotionData, updateCurrentTechIndexData, getAllTechIndexData, getTechEmotionIntraday, getLatestTechEmotion, forceRecordTechEmotionIntraday, markTechIndexIce, getTechEmotionIntraday5Day } = require('./service/emotion');
const { getMainProblem, writeMainProblem, updateMainProblemSeq, delMainProblem, updatePersonalSugg } = require('./service/mainProblem');
const { getOpRecord, updateOpRecord } = require('./service/opRecord');
const { updateMainLine, getMainLine } = require('./service/marketMainLine');
const { getTimelineData, updateTimelineEvent, deleteTimelineEvent } = require('./service/timeline');
const { getMarketRhythmData, updateMarketRhythmItem } = require('./service/marketRhythm');
const { getGanttData, updateGanttData } = require('./service/marketRhythmGantt');
const { getRecentOperationGanttData, updateRecentOperationGanttData } = require('./service/recentOperationGantt');
const { getRecentOperationData, updateRecentOperationItem } = require('./service/recentOperation');
const { getLongTermRhythmData, updateLongTermRhythmItem, getAllProjects, createProject, updateProject, deleteProject } = require('./service/longTermRhythm');
const {
  getResearchReports,
  getResearchReportById,
  createResearchReport,
  updateResearchReport,
  deleteResearchReport,
  deleteResearchReports,
  moveResearchReport,
  pinResearchReport,
  getRecentFoldersReports,
} = require('./service/researchReport');
const dayjs = require('dayjs');
const { getBlockMoneyChangeList, getBlockMoneyChangeTimeList, getBlockMoneyChangeDayHistory, updateBlockMoneyChangeDayHistory, getTechBlockRatio } = require('./service/blockMoney');
const { buildIntradayIntervalAnalysis } = require('./service/quantAnalysis');
const {
  getStockPositionMainFund,
  getWatchlistMainFund,
  addStockPosition,
  deleteStockPosition,
  updateStockPositionCost,
  diff2DayStockTline,
  getStockPositionFundFlow,
  getStockPositionAnalysisData,
  getStockPositions,
  getStockPipeline,
  updateStockPipeline,
  getStockPipelineData,
  getStockRecords,
  addStockRecord,
  PIPELINE_STAGES,
  getPositionReturns,
  savePositionReturn,
  deletePositionReturn,
} = require('./service/stockPosition');
const { classifySectorBlocksDaily } = require('./utils/classifySectorBlocks');
const { getGlobalAnalysisData, generateAIContext, getMarketStyleAnalysis, updateMarketStyleAnalysis } = require('./service/ai');
const { getBlocksConfig, addBlock, addBlockName, updateBlock, deleteBlock, deleteBlockByName } = require('./service/blockConfig');
const { getBlockAiContext, runBlockAiAnalysis } = require('./service/blockAi');
const { getAiScreenContext, runAiScreen } = require('./service/aiStockScreener');
const { getJigouReportsData, refreshJigouReports, getPendingNewReports, acknowledgeNewReports } = require('./service/jigouReports');
const { getMonitorAlarms, markAlarmRead, markAllAlarmsRead } = require('./service/monitor');
const { addMonitorStock, deleteMonitorStock, toggleStockImportant, batchSetImportant, updateMonitorStockName, getMonitorStocks, toggleStockTop, syncTotalShares } = require('./service/monitorStock');
const { diagnoseResilience, diagnoseResilienceMultiDay, calculateRealtimeResilienceBatch, diagnoseSingleStockResilience, diagnoseIntradayResilience, checkPositionSellAlerts } = require('./service/stockDiagnose');
const { diagnosePremium } = require('./service/premiumDiagnosis');
const { backtestBuySell, diagnoseRealtimeBuyPoints, getBuyPointChecks, getBuyPointStocks, getSingleStockBuyPointDiagnosis, getBuySellSelectableStocks, checkSingleStockSellPoint } = require('./service/buySellDiagnose');
const { diagnoseTrendStocks } = require('./service/trendDiagnose');
const { getTechnicalDiagnosis } = require('./service/technicalDiagnosis');
const { getMaSlopeDiagnosis } = require('./service/maSlopeDiagnosis');
const { predictSentimentCycle } = require('./service/sentimentPrediction');
const { runQuantAnalysis, getQuantAnalysisData, analyzeSingleStock } = require('./service/quantAnalysis');
const { getRZRQData } = require('./service/rzrq');
const { getTechBlockCrowd } = require('./service/techCrowd');
const { getRiskScoreHistory, calculateAndSaveRiskScore } = require('./service/marketRiskScore');
const { analyzeMonitorStocks } = require('./service/strongAndWeakStock');
const { getAvailableDates, getSnapshotData, getLatestSnapshotDate, saveDailySnapshots } = require('./service/fundSnapshot');
const { getAllFupanNotes, getFupanNoteByDate, saveFupanNote, deleteFupanNote, getIndexTlineByDate, getPersonalFeelings, savePersonalFeelings, getMarketSnapshot, getTodayPlan, saveTodayPlan } = require('./service/fupan');
const { listDataFiles, readDataFile, readDataFilesBatch, getAliases, saveAliases, setAlias, getHiddenPaths, setHiddenPath } = require('./service/dataCenter');
const { runDisasterRecoveryCheck } = require('./service/disasterRecovery');
const { getStrategyRecords, markStrategyRead, markAllStrategiesRead, getStrategyDefinitions } = require('./service/strategy');
const { getAvailableDates: getBacktestAvailableDates, runBacktest, STRATEGY_DEFINITIONS, runAiDiagnosis: runStrategyAiDiagnosis, getAiDiagnosisContext: getStrategyAiDiagnosisContext } = require('./service/strategyBacktest');
const { smartBacktestRun } = require('./service/smartBacktest');
const { getAvailableDates: getAiPredictionDates, getPrediction: getAiPrediction, getRealtimePrediction: getAiRealtimePrediction, getBacktestPrediction: getAiBacktestPrediction, getOnlineBacktestPrediction: getAiOnlineBacktestPrediction, getOnlineRealtimePrediction: getAiOnlineRealtimePrediction, getPredictionContext: getAiPredictionContext, getKlinePrediction: getAiKlinePrediction, getKlineBacktestPrediction: getAiKlineBacktestPrediction, getOnlineKlinePrediction: getAiOnlineKlinePrediction, getOnlineKlineBacktestPrediction: getAiOnlineKlineBacktestPrediction, getKlinePredictionContext: getAiKlinePredictionContext, getHistoryExplorationResult: getAiHistoryExplorationResult, getHistoryExplorationContext: getAiHistoryExplorationContext, INTRADAY_MINUTES: AI_INTRADAY_MINUTES, INDEX_OPTIONS: AI_INDEX_OPTIONS } = require('./service/aiPrediction');
const { getActiveProvider, getHeaders, buildRequestBody } = require('./utils/aiProvider');
const aiSettings = require('./service/aiSettings');
const { getMainFundAiSummary, getMainFundAiContext } = require('./service/mainFundAi');
const { getAllGroups: getAllIndexOverlayGroups, saveGroup: saveIndexOverlayGroup, deleteGroup: deleteIndexOverlayGroup } = require('./service/indexOverlayGroup');
const { getTrainingCampDates, loadTrainingCampData, getTrainingCampGroups, saveTrainingCampGroup, deleteTrainingCampGroup } = require('./service/trainingCamp');
const { runRangeBacktest, STRATEGIES, readCachedBacktest, writeCachedBacktest, getSentimentDefaultRange, attachHoldingDays } = require('./service/buySellBacktest');
const { generateReport, ensureLatestReport, getReportById, listReports } = require('./service/backtestReport');
const { getAttackDefenseScore } = require('./service/attackDefenseScore');
const feishuNotify = require('./service/feishuNotify');
const { getAllGroups: getAllOverlayStockGroups, saveGroup: saveOverlayStockGroup, deleteGroup: deleteOverlayStockGroup } = require('./service/overlayStockGroup');
const { refreshOvernightMeiguData, getOvernightMeiguData, getLatestMeiguDate } = require('./service/meigu');



// 创建实例
const app = express();

// 设置跨域
app.use(cors({
  origin: '*', // 对所有来源开放跨域访问
  optionsSuccessStatus: 200 // 一些旧浏览器（IE11，各种 SmartTV）在 204 时会窒息
}));

// 解析 JSON 请求体
app.use(express.json({ limit: '10mb' }));

// 静态文件服务
app.use('/static', express.static(path.join(__dirname, '../static')));

// 配置 multer 存储
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const staticPath = path.join(__dirname, '../static');
    if (!fs.existsSync(staticPath)) {
      fs.mkdirSync(staticPath, { recursive: true });
    }
    cb(null, staticPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'market-rhythm-' + uniqueSuffix + ext);
  }
});

const upload = multer({ storage: storage });

// 配置近期操作方案的 multer 存储
const recentOperationStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const staticPath = path.join(__dirname, '../static');
    if (!fs.existsSync(staticPath)) {
      fs.mkdirSync(staticPath, { recursive: true });
    }
    cb(null, staticPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'recent-operation-' + uniqueSuffix + ext);
  }
});

const recentOperationUpload = multer({ storage: recentOperationStorage });
// 端口
const port = 3000;

const killPortProcess = (port) => {
  try {
    const output = execSync(`lsof -i :${port} -t`).toString().trim();
    if (output) {
      const pids = output.split('\n');
      pids.forEach(pid => {
        execSync(`kill -9 ${pid}`);
        console.log(`已杀掉占用端口 ${port} 的进程: ${pid}`);
      });
      return true;
    }
  } catch (err) {
    return false;
  }
  return false;
};

killPortProcess(port);

// 返回需要告警的数据
app.get('/notice_data', async (req, res) => {
  const unNormalDaPanData = filterUnNormalDaPanData();
  const unNormalStockList = filterUnNormalStockData();
  const topAndBottomBlockData = getTopAndBottomBlockData();
  const allStockData = getAllStockData();
  const jingJiaQiangChouData = await getJingJiaQiangChouData();
  const kaiPanZhuDongData = getKaiPanZhuDongData();
  const kaiPanXiaCuoData = getKaiPanXiaCuoData();
  const openingPrices = getOpeningPrices();
  res.json({
    unNormalDaPanData,
    unNormalStockList,
    topAndBottomBlockData,
    allStockData,
    jingJiaQiangChouData,
    kaiPanZhuDongData,
    kaiPanXiaCuoData,
    openingPrices
  });
});

app.get('/kaipan_high_change_stocks', (req, res) => {
  try {
    const stocks = getKaiPanHighChangeStocks();
    res.json(stocks);
  } catch (error) {
    console.error('获取开盘高涨幅股票失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 返回板块数据
app.get('/block', (req, res) => {
  const blockData = getBlockData();
  res.json(blockData);
});

// 强制刷新板块数据（同步等待完成）
app.post('/api/block/refresh', async (req, res) => {
  try {
    const result = await refreshBlockData();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('刷新板块数据失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/stock_data', async (req, res) => {
  const code = req.query.code;
  const limit = Number(req.query.limit) || 100;
  const stockData = await getSingleStockData(code, limit);
  res.json(stockData);
});

// 返回单个股票分时数据
app.get('/get_stock_tline', async (req, res) => {
  const code = req.query.code;
  const tline = await getSingleStockTlineData(code);
  const monitorStocks = getMonitorStocks();
  const monitorStock = monitorStocks.find(s => s.code === code);
  let stockName = monitorStock?.name || code;
  try {
    const stockData = JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/stockData.json'), 'utf-8'));
    if (!monitorStock?.name && stockData[code]?.stockName) {
      stockName = stockData[code].stockName;
    }
  } catch (e) {
    // stockData.json 暂不存在时回退到 monitorStocks 名称或代码
  }
  res.json({ ...tline, stockName, line: tline?.line || [] });
});

// 返回所有个股数据（已按涨幅从高到低排序）
app.get('/get_all_stock_data', (req, res) => {
  const allStockData = getAllStockData();
  res.json(allStockData);
});

app.get('/stock_tline_data', async (req, res) => {
  const code = req.query.code;
  const date = req.query.date;
  let stockTlineData;
  if (date) {
    stockTlineData = await getSingleStockTlineDataByDate(code, parseInt(date, 10));
  } else {
    stockTlineData = await getSingleStockTlineData(code);
  }
  let stockName = null;
  try {
    const monitorStocks = getMonitorStocks();
    const monitorStock = monitorStocks.find(s => s.code === code);
    stockName = monitorStock?.name || null;
    if (!stockName) {
      const stockData = JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/stockData.json'), 'utf-8'));
      stockName = stockData[code]?.stockName || null;
    }
  } catch (e) {
    // stockData.json 暂不存在时忽略
  }
  res.json({ ...(stockTlineData || {}), stockName, line: stockTlineData?.line || [] });
});

app.get('/technical_diagnosis', async (req, res) => {
  try {
    const forceRefresh = String(req.query.forceRefresh || '') === '1';
    const result = await getTechnicalDiagnosis(forceRefresh);
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (error) {
    console.error('获取技术诊断失败:', error);
    return res.status(500).json({
      success: false,
      message: error.message || '获取技术诊断失败',
    });
  }
});

app.get('/ma_slope_diagnosis', async (req, res) => {
  try {
    const forceRefresh = String(req.query.forceRefresh || '') === '1';
    const result = await getMaSlopeDiagnosis(forceRefresh);
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (error) {
    console.error('获取均线斜率诊断失败:', error);
    return res.status(500).json({
      success: false,
      message: error.message || '获取均线斜率诊断失败',
    });
  }
});

app.get('/dapan_data', async (req, res) => {
  const dapanData = await getAllDaPanData();
  res.json(dapanData);
});

app.get('/jingjia_data', async (req, res) => {
  const jingJiaQiangChouData = await getJingJiaQiangChouData();
  res.json(jingJiaQiangChouData);
});

app.get('/kaipan_xiacuo_data', async (req, res) => {
  const kaiPanXiaCuoData = getKaiPanXiaCuoData();
  res.json(kaiPanXiaCuoData);
});

app.get('/rihan_data', (req, res) => {
  const rihanData = getRiHanData();
  res.json(rihanData);
});

app.post('/refresh_rihan_data', async (req, res) => {
  try {
    const result = await refreshRiHanData();
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/amount_history', async (req, res) => {
  const amountHistory = await getAmountHistory();
  res.json(amountHistory);
});

// 返回每日收盘后的主力资金与成交量历史记录
app.get('/amount_day_history', (req, res) => {
  const amountDayHistory = getAmountDayHistory();
  res.json(amountDayHistory);
});

// 手动触发记录当日收盘数据
app.post('/update_amount_day_history', (req, res) => {
  try {
    const record = updateAmountDayHistory();
    res.json({ message: '更新成功', data: record });
  } catch (error) {
    console.error('更新每日成交量历史失败:', error);
    res.status(500).json({ message: error.message || '更新失败' });
  }
});

// 主力资金与成交量监控报警
app.get('/monitor_alarms', (req, res) => {
  try {
    const alarms = getMonitorAlarms();
    res.json(alarms);
  } catch (error) {
    console.error('获取监控报警失败:', error);
    res.status(500).json({ message: error.message || '获取监控报警失败' });
  }
});

// 标记某条监控报警为已读
app.post('/monitor_alarms/read', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ message: '缺少 id 参数' });
    }
    const success = markAlarmRead(id);
    res.json({ message: success ? '已标记为已读' : '未找到对应报警', success });
  } catch (error) {
    console.error('标记报警已读失败:', error);
    res.status(500).json({ message: error.message || '标记已读失败' });
  }
});

// 标记所有监控报警为已读
app.post('/monitor_alarms/read_all', (req, res) => {
  try {
    const success = markAllAlarmsRead();
    res.json({ message: success ? '已全部标记为已读' : '没有未读报警', success });
  } catch (error) {
    console.error('全部标记已读失败:', error);
    res.status(500).json({ message: error.message || '全部标记已读失败' });
  }
});

// 返回机构研报数据
app.get('/get_jigou_reports', (req, res) => {
  try {
    const data = getJigouReportsData();
    res.json(data);
  } catch (error) {
    console.error('获取机构研报失败:', error);
    res.status(500).json({ message: error.message || '获取机构研报失败' });
  }
});

// 手动触发刷新机构研报（触发 puppeteer 重新抓取知识星球）
app.post('/refresh_jigou_reports', async (req, res) => {
  try {
    const data = await refreshJigouReports();
    res.json(data);
  } catch (error) {
    console.error('手动刷新机构研报失败:', error);
    res.status(500).json({ message: error.message || '刷新失败' });
  }
});

// 获取机构研报中尚未查看的新增列表（供前端菜单徽标轮询）
app.get('/get_jigou_reports_new', (req, res) => {
  try {
    const data = getPendingNewReports();
    res.json(data);
  } catch (error) {
    console.error('获取新增研报失败:', error);
    res.status(500).json({ message: error.message || '获取新增研报失败' });
  }
});

// 用户打开机构研报页面后确认查看，清空待查看的新增列表
app.post('/ack_jigou_reports_new', (req, res) => {
  try {
    const success = acknowledgeNewReports();
    res.json({ success, message: success ? '已确认' : '确认失败' });
  } catch (error) {
    console.error('确认新增研报失败:', error);
    res.status(500).json({ message: error.message || '确认失败' });
  }
});

// 返回所有日期的情绪数据
app.get('/emotion_data', async (req, res) => {
  const emotionData = await getAllEmotionData();
  const indexKlineData = await getAllIndexKlineData();
  const techIndexData = await getAllTechIndexData();
  res.json({
    emotionData,
    indexKlineData,
    techIndexData
  });
});

// 更新当日最新的情绪数据
app.post('/update_emotion_data', async (req, res) => {
  const data = await updateCurrentTechIndexData();
  // 同步写入分时数据（用于手动刷新，与轮询服务互相覆盖以最新为准）
  try {
    await forceRecordTechEmotionIntraday(data);
  } catch (e) {
    console.error('手动刷新写入分时数据失败:', e.message);
  }
  res.json({ message: '情绪数据更新成功', data });
});

// 获取最新科技情绪指数（读取离线数据）
app.get('/latest_tech_emotion', (req, res) => {
  try {
    const value = getLatestTechEmotion();
    res.json({ value });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 获取指数K线数据（创业板和科创板）
app.get('/get_index_kline_data', async (req, res) => {
  try {
    const indexKlineData = await getAllIndexKlineData();
    res.json(indexKlineData);
  } catch (error) {
    console.error('获取指数K线数据失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 获取当日科技情绪分时数据
app.get('/tech_emotion_intraday', (req, res) => {
  const data = getTechEmotionIntraday();
  res.json(data);
});

// 获取最近5日科技情绪分时数据（含当日实时合并）
app.get('/tech_emotion_intraday_5day', (req, res) => {
  const data = getTechEmotionIntraday5Day();
  res.json(data);
});

// 标记最新科技情绪指数为冰点（分时轮询发现 <= -40 时调用）
app.post('/mark_tech_index_ice', (req, res) => {
  try {
    const result = markTechIndexIce();
    res.json({ success: true, marked: result });
  } catch (error) {
    console.error('标记冰点失败:', error);
    res.status(500).json({ success: false, message: error.message || '标记失败' });
  }
});

// 科技情绪周期分析预测
app.get('/tech_sentiment_prediction', async (req, res) => {
  try {
    const result = await predictSentimentCycle();
    res.json(result);
  } catch (error) {
    console.error('科技情绪周期预测失败:', error);
    res.status(500).json({ error: error.message || '预测失败' });
  }
});

// 获取量化分析数据
app.get('/api/quant-analysis', (req, res) => {
  try {
    const data = getQuantAnalysisData();
    res.json(data);
  } catch (error) {
    console.error('获取量化分析数据失败:', error);
    res.status(500).json({ error: error.message || '获取失败' });
  }
});

app.get('/api/quant-analysis/search', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) {
      return res.status(400).json({ success: false, message: '请输入股票名称或代码' });
    }

    const result = await analyzeSingleStock(keyword);
    if (!result?.success) {
      return res.status(404).json(result || { success: false, message: '未找到匹配股票' });
    }

    res.json(result);
  } catch (error) {
    console.error('单股量化分析失败:', error);
    res.status(500).json({ success: false, error: error.message || '分析失败' });
  }
});

// 实时计算分时资金意图分析
app.post('/api/intraday-intent-analysis', async (req, res) => {
  try {
    const { tlineData, code } = req.body;
    if (!Array.isArray(tlineData) || tlineData.length < 20) {
      return res.json({ intervalAnalysis: [] });
    }

    const first = tlineData[0];
    const openPrice = Number(first.last_px) || 0;
    const totalAmount = tlineData.reduce((sum, item) => sum + (Number(item.last_px) || 0) * (Number(item.business_amount) || 0), 0);
    const totalVolume = tlineData.reduce((sum, item) => sum + (Number(item.business_amount) || 0), 0);
    const vwap = totalVolume > 0 ? totalAmount / totalVolume : openPrice;

    let indexTlineData = [];
    if (code) {
      const indexCode = code.startsWith('sh688') ? 'sh000688' : 'sz399006';
      try {
        const indexData = await getSingleStockTlineData(indexCode);
        indexTlineData = indexData?.line || [];
        console.log(`获取指数 ${indexCode} 分时数据成功，长度: ${indexTlineData.length}`);
      } catch (error) {
        console.error(`获取指数 ${indexCode} 分时数据失败:`, error.message);
      }
    }

    const intervalAnalysis = buildIntradayIntervalAnalysis(tlineData, openPrice, vwap, indexTlineData);
    res.json({ intervalAnalysis });
  } catch (error) {
    console.error('实时计算分时资金意图失败:', error);
    res.status(500).json({ error: error.message || '计算失败' });
  }
});

// 手动触发量化分析
app.post('/api/run-quant-analysis', async (req, res) => {
  try {
    // 异步执行，直接返回
    // runQuantAnalysis();
    res.json({ message: '量化分析任务已启动' });
  } catch (error) {
    res.status(500).json({ error: error.message || '启动失败' });
  }
});

app.get('/jisuyidong_rank', async (req, res) => {
  const jisuyidongRankData = getJiSuYiDongRankData();
  res.json(jisuyidongRankData);
});

// 自选股管理接口
app.post('/add_monitor_stock', async (req, res) => {
  const { code, name, blockName, riskScore, isTech } = req.body;
  const success = addMonitorStock(code, name, blockName, riskScore, isTech);
  if (success) {
    // 立即触发一次该股票的数据抓取，确保前端能立即看到数据
    await triggerUpdateStockData([code]);
    // 同步拉取该股票的总股本（用于科技情绪市值加权计算）
    try { await syncTotalShares([code]); } catch (e) { console.error('同步总股本失败:', e.message); }
  }
  res.json({ success, message: success ? '添加成功' : '添加失败，可能已存在' });
});

// 手动刷新自选股总股本数据（monitor_stocks_total_shares.json）
// 默认只补拉缺失的，传 force=true 时全量重新拉取
app.post('/refresh_total_shares', async (req, res) => {
  try {
    const { force } = req.body || {};
    const data = await syncTotalShares(force ? getMonitorStocks().map(s => s.code) : []);
    res.json({ success: true, count: data.length });
  } catch (error) {
    console.error('刷新总股本数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '刷新失败' });
  }
});

app.post('/delete_monitor_stock', (req, res) => {
  const { code } = req.body;
  const success = deleteMonitorStock(code);
  res.json({ success, message: success ? '删除成功' : '删除失败' });
});

app.post('/toggle_stock_important', (req, res) => {
  const { code } = req.body;
  const success = toggleStockImportant(code);
  res.json({ success, message: success ? '更新成功' : '更新失败' });
});

app.post('/batch_set_important', (req, res) => {
  const { codes } = req.body;
  const result = batchSetImportant(codes);
  res.json(result);
});

app.post('/update_monitor_stock_name', (req, res) => {
  const { code, name } = req.body;
  const success = updateMonitorStockName(code, name);
  res.json({ success, message: success ? '更新成功' : '更新失败' });
});

app.post('/toggle_stock_top', (req, res) => {
  const { code } = req.body;
  const success = toggleStockTop(code);
  res.json({ success, message: success ? '更新成功' : '更新失败' });
});

// 手动触发刷新所有监控股票数据
app.post('/refresh_monitor_stock_data', async (req, res) => {
  try {
    const result = await refreshStockData();
    res.json(result);
  } catch (error) {
    console.error('手动刷新监控股票数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '刷新失败' });
  }
});

app.post('/diagnose_resilience', async (req, res) => {
  const { stockCodes } = req.body;
  const result = await diagnoseResilience(stockCodes);
  res.json(result);
});

app.post('/calculate_resilience_realtime', (req, res) => {
  try {
    const { stocks, indexLines } = req.body || {};
    const data = calculateRealtimeResilienceBatch({ stocks, indexLines });
    res.json({ success: true, data });
  } catch (error) {
    console.error('实时抗分歧计算失败:', error);
    res.status(500).json({ success: false, message: error.message || '实时抗分歧计算失败' });
  }
});

// 多日抗分歧诊断（最近5个交易日）
app.get('/diagnose_resilience_multi_day', async (req, res) => {
  try {
    const forceRefresh = String(req.query.forceRefresh || '') === '1';
    const result = await diagnoseResilienceMultiDay(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('多日抗分歧诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 个股抗分歧诊断（指定时间范围）
app.post('/diagnose_single_stock_resilience', async (req, res) => {
  try {
    const { code, startDate, endDate } = req.body;
    const result = await diagnoseSingleStockResilience(code, startDate, endDate);
    res.json(result);
  } catch (error) {
    console.error('个股诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 个股分时抗分歧诊断（指定日期，按10分钟分段）
app.post('/diagnose_intraday_resilience', async (req, res) => {
  try {
    const { code, date } = req.body;
    const result = await diagnoseIntradayResilience(code, date);
    res.json(result);
  } catch (error) {
    console.error('个股分时诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 持仓卖出预警检查（抗分歧指数<5 或 跌破20日线）
app.get('/check_position_sell_alerts', async (req, res) => {
  try {
    const result = await checkPositionSellAlerts();
    res.json(result);
  } catch (error) {
    console.error('持仓卖出预警检查失败:', error);
    res.status(500).json({ success: false, message: error.message || '检查失败' });
  }
});

// 溢价诊断接口
app.get('/premium_diagnosis', async (req, res) => {
  try {
    const forceRefresh = String(req.query.forceRefresh || '') === '1';
    const result = await diagnosePremium(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('溢价诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 单个股票卖点诊断
app.post('/check_single_stock_sell_point', async (req, res) => {
  try {
    const { code, costPrice } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: '股票代码不能为空' });
    }
    const result = await checkSingleStockSellPoint(code, costPrice);
    res.json(result);
  } catch (error) {
    console.error('单个股票卖点诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 买卖点诊断 - 获取可选股票列表（合并 monitor_alarms.json 与自选股列表）
app.get('/buy_sell_selectable_stocks', (req, res) => {
  try {
    const stocks = getBuySellSelectableStocks();
    res.json({ success: true, data: stocks });
  } catch (error) {
    console.error('获取买卖点诊断可选股票失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取失败' });
  }
});

// 买卖点诊断 - 回测
app.post('/backtest_buy_sell', async (req, res) => {
  try {
    const { stockCodes, startDate, endDate } = req.body || {};
    const result = await backtestBuySell(stockCodes, startDate, endDate);
    res.json(result);
  } catch (error) {
    console.error('买卖点回测失败:', error);
    res.status(500).json({ success: false, message: error.message || '回测失败' });
  }
});

// 趋势诊断 - 自选股近 20 日涨幅前 30 中未跌破 10 日线者
app.get('/trend_diagnosis', async (req, res) => {
  try {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const result = await diagnoseTrendStocks(refresh);
    res.json(result);
  } catch (error) {
    console.error('趋势诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '趋势诊断失败' });
  }
});

// 买卖点诊断 - 即时买点筛选
app.post('/diagnose_realtime_buy_points', async (req, res) => {
  try {
    const targetDate = req.body?.targetDate;
    const refresh = req.body?.refresh === true || req.body?.refresh === 1 || req.body?.refresh === '1';
    const result = await diagnoseRealtimeBuyPoints(targetDate, refresh);
    res.json(result);
  } catch (error) {
    console.error('即时买点诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 买点7项前置条件检查
app.post('/buy_point_checks', async (req, res) => {
  try {
    const targetDate = req.body?.targetDate;
    const refresh = req.body?.refresh === true || req.body?.refresh === 1 || req.body?.refresh === '1';
    const result = await getBuyPointChecks(targetDate, refresh);
    res.json(result);
  } catch (error) {
    console.error('买点前置检查失败:', error);
    res.status(500).json({ success: false, message: error.message || '检查失败' });
  }
});

// 筛选抗分歧指数>8的个股
app.post('/buy_point_stocks', async (req, res) => {
  try {
    const targetDate = req.body?.targetDate;
    const sortBy = req.body?.sortBy || 'resilience';
    const days = req.body?.days || 3; // 研报模式窗口天数：3 或 5
    const result = await getBuyPointStocks(targetDate, sortBy, days);
    res.json(result);
  } catch (error) {
    console.error('筛选买点个股失败:', error);
    res.status(500).json({ success: false, message: error.message || '筛选失败' });
  }
});

// 个股买点诊断：7 项前置检查 + 个股抗分歧指数检查
app.post('/buy_point_single_stock_diagnosis', async (req, res) => {
  try {
    const { code, targetDate } = req.body;
    const refresh = req.body?.refresh === true || req.body?.refresh === 1 || req.body?.refresh === '1';
    const result = await getSingleStockBuyPointDiagnosis(code, targetDate, refresh);
    res.json(result);
  } catch (error) {
    console.error('个股买点诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '诊断失败' });
  }
});

// 发送飞书卡片消息（供前端调用）
// body: {
//   type: 'buy_point' | 'sell_point',
//   sellStocks?: [             // type='sell_point' 时必填：触发卖点的持仓股
//     { stockName, code, reasons: string[], closePrice? }
//   ]
//   topStocks?: [              // type='buy_point' 时可传，mock 前三日涨幅前三名；缺省则后端真实拉取
//     { stockName, code, change3d }
//   ]
// }
app.post('/send_feishu_card', async (req, res) => {
  try {
    const { type, sellStocks, topStocks } = req.body || {};
    if (type !== 'buy_point' && type !== 'sell_point') {
      return res.status(400).json({ success: false, message: 'type 必须是 buy_point 或 sell_point' });
    }

    let card;
    if (type === 'buy_point') {
      // 买点卡片：直接推荐近3日涨幅排名前三的股票，不做历史回测推荐
      let resultTopStocks = topStocks;
      if (!Array.isArray(topStocks)) {
        const { getBuyPointStocks } = require('./service/buySellDiagnose');
        const stocksRes = await getBuyPointStocks(null, 'change');
        const matched = stocksRes?.data?.matchedStocks || [];
        resultTopStocks = matched.slice(0, 3).map((s) => ({
          stockName: s.stockName,
          code: s.code,
          change3d: s.change3d,
        }));
      }
      card = feishuNotify.buildBuyPointCard({
        topStocks: resultTopStocks,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      });
    } else {
      // 卖点卡片：使用前端传入的持仓股及其触发原因
      card = feishuNotify.buildSellPointCard({
        sellStocks: Array.isArray(sellStocks) ? sellStocks : [],
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      });
    }

    const result = await feishuNotify.sendFeishuCard(card);
    res.json({ success: result.success, data: result.data, error: result.error });
  } catch (error) {
    console.error('发送飞书卡片失败:', error);
    res.status(500).json({ success: false, message: error.message || '发送失败' });
  }
});

app.get('/get_main_problem', async (req, res) => {
  const mainProblemData = await getMainProblem();
  res.json(mainProblemData);
});

app.post('/update_main_problem', async (req, res) => {
  const { id, title, content } = req.body;
  writeMainProblem({ id, title, content });
  res.json({ message: '更新成功' });
});

app.post('/update_main_problem_seq', async (req, res) => {
  const { seq_ids } = req.body;
  updateMainProblemSeq({ seq_ids });
  res.json({ message: '更新成功' });
});

app.post('/del_main_problem', async (req, res) => {
  const { id } = req.body;
  delMainProblem({ id });
  res.json({ message: '删除成功' });
});

app.post('/update_personal_sugg', async (req, res) => {
  const { globalSuggContent, tempSuggContent } = req.body;
  updatePersonalSugg({ globalSuggContent, tempSuggContent });
  res.json({ message: '更新成功' });
});

// 更新操作记录
app.post('/update_op_record', async (req, res) => {
  const { record } = req.body;
  updateOpRecord(record);
  res.json({ message: '更新成功' });
});

// 返回操作记录
app.get('/get_op_record', async (req, res) => {
  const opRecord = getOpRecord();
  res.json(opRecord);
});

// 更新市场主线和支线
app.post('/update_main_line', async (req, res) => {
  const { data } = req.body;
  updateMainLine(data);
  res.json({ message: '更新成功' });
});

// 返回市场主线和支线
app.get('/get_main_line', async (req, res) => {
  const mainLineData = getMainLine();
  res.json(mainLineData);
});

// 返回当前热门板块
app.get('/current_day_hot_block', async (req, res) => {
  const currentDayHotBlock = await getCurrentDayHotBlock();
  res.json(currentDayHotBlock);
});

// 返回板块数据历史记录
app.get('/block_history', async (req, res) => {
  const blockHistory = await getBlockHistory();
  res.json(blockHistory);
});

// 返回时间线数据
app.get('/get_timeline', async (req, res) => {
  const timelineData = getTimelineData();
  res.json(timelineData);
});

// 更新时间线事件
app.post('/update_timeline_event', async (req, res) => {
  const event = req.body;
  updateTimelineEvent(event);
  res.json({ message: '更新成功' });
});

// 删除时间线事件
app.post('/delete_timeline_event', async (req, res) => {
  const { id } = req.body;
  deleteTimelineEvent(id);
  res.json({ message: '删除成功' });
});

// 返回板块数据历史记录
app.get('/block_day_history', async (req, res) => {
  const blockDayHistory = await getBlockDayHistory();
  res.json(blockDayHistory);
});

// 更新板块数据历史记录
app.post('/update_block_day_history', async (req, res) => {
  await updateBlockDayHistory();
  res.json({ message: '更新成功' });
});

// 获取研报列表
app.get('/get_research_reports', async (req, res) => {
  const researchReports = getResearchReports();
  res.json(researchReports);
});

// 获取最近 N 个文件夹内的研报及内容（用于「复制上下文」）
app.get('/research_reports_context', async (req, res) => {
  try {
    const folderCount = Math.max(1, Math.min(120, parseInt(req.query?.folders) || 30));
    const folders = getRecentFoldersReports(folderCount);
    const totalReports = folders.reduce((sum, f) => sum + (f.reports?.length || 0), 0);
    res.json({
      success: true,
      data: {
        folders,
        totalFolders: folders.length,
        totalReports,
      },
    });
  } catch (error) {
    console.error('获取研报上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取研报上下文失败' });
  }
});

// 获取单个研报
app.get('/get_research_report', async (req, res) => {
  const { id } = req.query;
  const report = getResearchReportById(id);
  res.json(report);
});

// 创建研报/文件夹
app.post('/create_research_report', async (req, res) => {
  const { parentId, name, type, content } = req.body;
  const newItem = createResearchReport(parentId, name, type, content);
  res.json({ message: '创建成功', data: newItem });
});

// 更新研报/文件夹
app.post('/update_research_report', async (req, res) => {
  const { id, name, content } = req.body;
  const updatedItem = updateResearchReport(id, { name, content });
  res.json({ message: '更新成功', data: updatedItem });
});

// 删除研报/文件夹
app.post('/delete_research_report', async (req, res) => {
  const { id } = req.body;
  const success = deleteResearchReport(id);
  res.json({ message: success ? '删除成功' : '删除失败' });
});

// 批量删除研报/文件夹
app.post('/delete_research_reports', async (req, res) => {
  const { ids } = req.body;
  const success = deleteResearchReports(ids);
  res.json({ message: success ? '批量删除成功' : '批量删除失败' });
});

// 移动研报/文件夹
app.post('/move_research_report', async (req, res) => {
  const { id, newParentId } = req.body;
  const success = moveResearchReport(id, newParentId);
  res.json({ message: success ? '移动成功' : '移动失败' });
});

// 标记/取消标记研报为重点
app.post('/toggle_research_report_important', async (req, res) => {
  const { id } = req.body;
  const report = getResearchReportById(id);
  if (!report) {
    return res.json({ message: '未找到该项' });
  }
  const updatedItem = updateResearchReport(id, {
    isImportant: !report.isImportant,
    updatedAt: new Date().toISOString()
  });
  res.json({ message: '更新成功', data: updatedItem });
});

// 置顶研报
app.post('/pin_research_report', async (req, res) => {
  const { id } = req.body;
  const success = pinResearchReport(id);
  res.json({ message: success ? '置顶成功' : '置顶失败', success });
});

// 隐藏/取消隐藏文件夹
app.post('/toggle_research_report_hidden', async (req, res) => {
  const { id } = req.body;
  const report = getResearchReportById(id);
  if (!report) {
    return res.json({ message: '未找到该项' });
  }
  const updatedItem = updateResearchReport(id, {
    isHidden: !report.isHidden,
    updatedAt: new Date().toISOString()
  });
  res.json({ message: '更新成功', data: updatedItem });
});

// 上传市场节奏推演图片
app.post('/upload_market_rhythm_image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: '请上传图片' });
    }
    const imageUrl = `http://localhost:3000/static/${req.file.filename}`;
    res.json({
      message: '上传成功',
      imageUrl: imageUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error('上传失败:', error);
    res.status(500).json({ message: '上传失败' });
  }
});

// 获取市场节奏推演列表
app.get('/get_market_rhythm', async (req, res) => {
  try {
    const data = getMarketRhythmData();
    res.json(data);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 获取甘特图数据
app.get('/get_market_rhythm_gantt', (req, res) => {
  try {
    const data = getGanttData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: '获取甘特图数据失败' });
  }
});

// 更新甘特图数据
app.post('/update_market_rhythm_gantt', (req, res) => {
  try {
    const { events } = req.body;
    updateGanttData(events);
    res.json({ message: '保存成功' });
  } catch (error) {
    res.status(500).json({ message: '保存甘特图数据失败' });
  }
});

// 获取近期操作方案甘特图数据
app.get('/get_recent_operation_gantt', (req, res) => {
  try {
    const data = getRecentOperationGanttData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 更新近期操作方案甘特图数据
app.post('/update_recent_operation_gantt', (req, res) => {
  try {
    const { events } = req.body;
    updateRecentOperationGanttData(events);
    res.json({ message: '保存成功' });
  } catch (error) {
    res.status(500).json({ message: '保存数据失败' });
  }
});

// 更新市场节奏推演
app.post('/update_market_rhythm', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    const updatedItem = updateMarketRhythmItem({ imageUrl });
    res.json({ message: '更新成功', data: updatedItem });
  } catch (error) {
    console.error('更新失败:', error);
    res.status(500).json({ message: '更新失败' });
  }
});

// 上传近期操作方案图片
app.post('/upload_recent_operation_image', recentOperationUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: '请上传图片' });
    }
    const imageUrl = `http://localhost:3000/static/${req.file.filename}`;
    res.json({
      message: '上传成功',
      imageUrl: imageUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error('上传失败:', error);
    res.status(500).json({ message: '上传失败' });
  }
});

// 获取近期操作方案数据
app.get('/get_recent_operation', async (req, res) => {
  try {
    const data = getRecentOperationData();
    res.json(data);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 更新近期操作方案
app.post('/update_recent_operation', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    const updatedItem = updateRecentOperationItem({ imageUrl });
    res.json({ message: '更新成功', data: updatedItem });
  } catch (error) {
    console.error('更新失败:', error);
    res.status(500).json({ message: '更新失败' });
  }
});

// 获取长期炒作节奏项目列表
app.get('/get_long_term_rhythm_projects', async (req, res) => {
  try {
    const projects = getAllProjects();
    res.json(projects);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 创建长期炒作节奏项目
app.post('/create_long_term_rhythm_project', async (req, res) => {
  try {
    const { title, description } = req.body;
    const newProject = createProject(title, description);
    res.json({ message: '创建成功', data: newProject });
  } catch (error) {
    console.error('创建失败:', error);
    res.status(500).json({ message: '创建失败' });
  }
});

// 更新长期炒作节奏项目
app.post('/update_long_term_rhythm_project', async (req, res) => {
  try {
    const { id, title, description, content } = req.body;
    const updatedProject = updateProject(id, { title, description, content });
    if (!updatedProject) {
      return res.status(404).json({ message: '项目不存在' });
    }
    res.json({ message: '更新成功', data: updatedProject });
  } catch (error) {
    console.error('更新失败:', error);
    res.status(500).json({ message: '更新失败' });
  }
});

// 删除长期炒作节奏项目
app.post('/delete_long_term_rhythm_project', async (req, res) => {
  try {
    const { id } = req.body;
    const success = deleteProject(id);
    res.json({ message: success ? '删除成功' : '删除失败', success });
  } catch (error) {
    console.error('删除失败:', error);
    res.status(500).json({ message: '删除失败' });
  }
});

// 保持向后兼容的旧接口
// 获取长期炒作节奏数据
app.get('/get_long_term_rhythm', async (req, res) => {
  try {
    const projects = getAllProjects();
    const data = projects.length > 0 ? {
      content: projects[0].content,
      updatedAt: projects[0].updatedAt
    } : {
      content: '',
      updatedAt: new Date().toISOString()
    };
    res.json(data);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 更新长期炒作节奏
app.post('/update_long_term_rhythm', async (req, res) => {
  try {
    const { content } = req.body;
    const updatedItem = updateLongTermRhythmItem({ content });
    res.json({ message: '更新成功', data: updatedItem });
  } catch (error) {
    console.error('更新失败:', error);
    res.status(500).json({ message: '更新失败' });
  }
});

// 获取各个板块的资金流入流出情况
app.get('/get_block_money_change', async (req, res) => {
  try {
    const blockMoneyChangeList = getBlockMoneyChangeList();
    res.json(blockMoneyChangeList);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 获取各个板块的资金分时情况
app.get('/get_block_money_change_time', async (req, res) => {
  try {
    const blockMoneyChangeTimeList = getBlockMoneyChangeTimeList();
    res.json(blockMoneyChangeTimeList);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 获取板块资金的按天历史记录
app.get('/get_block_money_change_day_history', (req, res) => {
  try {
    const blockMoneyChangeDayHistory = getBlockMoneyChangeDayHistory();
    res.json(blockMoneyChangeDayHistory);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 手动触发记录当日板块资金历史
app.post('/update_block_money_change_day_history', (req, res) => {
  try {
    const record = updateBlockMoneyChangeDayHistory();
    res.json({ message: '更新成功', data: record });
  } catch (error) {
    console.error('更新板块资金历史失败:', error);
    res.status(500).json({ message: error.message || '更新失败' });
  }
});

// 获取当前科技板块资金占比
app.get('/get_tech_block_ratio', (req, res) => {
  try {
    const techBlockRatio = getTechBlockRatio();
    res.json(techBlockRatio);
  } catch (error) {
    console.error('获取科技板块占比失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 获取科技板块拥挤度（基于成交额占比、融资余额、融资买入综合计算）
app.get('/tech_block_crowd', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await getTechBlockCrowd(startDate, endDate);
    res.json(result);
  } catch (error) {
    console.error('获取科技板块拥挤度数据失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 刷新科技板块拥挤度数据
app.get('/refresh_tech_block_crowd', async (req, res) => {
  try {
    const { run, techCrowdStartDate, techCrowdEndDate } = require('./service/科技板块拥挤度计算/block_amount_money');
    await run(techCrowdStartDate, techCrowdEndDate, false);
    res.json({ success: true, message: '刷新成功' });
  } catch (error) {
    console.error('刷新科技板块拥挤度数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '刷新失败' });
  }
});

// 获取市场风险偏好指数历史数据
app.get('/market_risk_score', (req, res) => {
  try {
    const data = getRiskScoreHistory();
    res.json(data);
  } catch (error) {
    console.error('获取市场风险偏好指数失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 手动触发计算并保存市场风险偏好指数
app.post('/update_market_risk_score', async (req, res) => {
  try {
    const record = await calculateAndSaveRiskScore();
    res.json({ message: '更新成功', data: record });
  } catch (error) {
    console.error('更新市场风险偏好指数失败:', error);
    res.status(500).json({ message: error.message || '更新失败' });
  }
});

const EMOTION_CYCLE_FILE = path.join(__dirname, 'data/market_emotion_cycle.json');

// 获取市场情绪周期分析（基于MA3斜率分布）- 优先返回缓存
app.get('/market_emotion_cycle', async (req, res) => {
  try {
    if (fs.existsSync(EMOTION_CYCLE_FILE)) {
      const cachedData = JSON.parse(fs.readFileSync(EMOTION_CYCLE_FILE, 'utf8'));
      res.json(cachedData);
    } else {
      const result = await analyzeMonitorStocks();
      fs.writeFileSync(EMOTION_CYCLE_FILE, JSON.stringify(result, null, 2));
      res.json(result);
    }
  } catch (error) {
    console.error('获取市场情绪周期数据失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 刷新市场情绪周期数据
app.post('/refresh_market_emotion_cycle', async (req, res) => {
  try {
    const result = await analyzeMonitorStocks();
    fs.writeFileSync(EMOTION_CYCLE_FILE, JSON.stringify(result, null, 2));
    res.json({ message: '刷新成功', data: result });
  } catch (error) {
    console.error('刷新市场情绪周期数据失败:', error);
    res.status(500).json({ message: error.message || '刷新失败' });
  }
});

// 获取融资余额数据
app.get('/get_rzrq_data', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: '缺少 startDate 或 endDate 参数' });
    }
    const data = await getRZRQData(startDate, endDate);
    res.json(data);
  } catch (error) {
    console.error('获取融资余额数据失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 获取各个板块的资金流入流出情况历史记录
app.get('/get_block_money_day_history', async (req, res) => {
  try {
    const blockMoneyDayHistory = getBlockMoneyDayHistory();
    res.json(blockMoneyDayHistory);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

app.get('/update_block_money_day_history', async (req, res) => {
  try {
    const blockMoneyDayHistory = await updateBlockMoneyDayHistory();
    res.json(blockMoneyDayHistory);
  } catch (error) {
    console.error('更新数据失败:', error);
    res.status(500).json({ message: '更新数据失败' });
  }
});

// 获取股票持仓资金流入流出情况
app.get('/get_stock_position', async (req, res) => {
  try {
    const stockPositionMainFund = await getStockPositionMainFund();
    res.json(stockPositionMainFund);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 获取自选股主力资金净流入数据
app.get('/get_watchlist_main_fund', async (req, res) => {
  try {
    const result = await getWatchlistMainFund();
    res.json(result);
  } catch (error) {
    console.error('获取自选股主力资金失败:', error);
    res.status(500).json({ message: '获取自选股主力资金失败' });
  }
});

app.get('/stock_positions', (req, res) => {
  try {
    res.json(getStockPositions());
  } catch (error) {
    console.error('获取持仓列表失败:', error);
    res.status(500).json({ message: '获取持仓列表失败' });
  }
});

app.post('/add_stock_position', async (req, res) => {
  try {
    const { code, name } = req.body;
    const success = addStockPosition(code, name);
    res.json({ message: success ? '添加成功' : '添加失败', success });
  } catch (error) {
    console.error('添加失败:', error);
    res.status(500).json({ message: '添加失败' });
  }
});

app.post('/delete_stock_position', async (req, res) => {
  try {
    const { code } = req.body;
    const success = deleteStockPosition(code);
    res.json({ message: success ? '删除成功' : '删除失败', success });
  } catch (error) {
    console.error('删除失败:', error);
    res.status(500).json({ message: '删除失败' });
  }
});

// 更新持仓成本价（成本线价格），用于卖点诊断「跌破成本线」条件
app.post('/update_stock_position_cost', async (req, res) => {
  try {
    const { code, costPrice } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: '股票代码不能为空' });
    }
    const success = updateStockPositionCost(code, costPrice);
    if (!success) {
      return res.status(400).json({ success: false, message: '更新失败，请检查成本价是否有效且该股票在持仓中' });
    }
    res.json({ success: true, message: '成本价已更新' });
  } catch (error) {
    console.error('更新持仓成本价失败:', error);
    res.status(500).json({ success: false, message: error.message || '更新失败' });
  }
});

app.get('/diff2_day_stock_tline', async (req, res) => {
  try {
    const result = await diff2DayStockTline();
    res.json(result);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 获取某只持仓股票当日（或指定日期）的资金净流入流出时间序列
app.get('/stock_position_fund_flow', (req, res) => {
  try {
    const { code, date } = req.query;
    if (!code) {
      return res.status(400).json({ message: '缺少 code 参数' });
    }
    const result = getStockPositionFundFlow(code, date);
    res.json(result);
  } catch (error) {
    console.error('获取持仓资金流向失败:', error);
    res.status(500).json({ message: error.message || '获取数据失败' });
  }
});

app.get('/stock_position_analysis', (req, res) => {
  try {
    res.json(getStockPositionAnalysisData());
  } catch (error) {
    console.error('获取持仓分析失败:', error);
    res.status(500).json({ message: error.message || '获取持仓分析失败' });
  }
});

// 流水线管理
app.get('/get_stock_pipeline', (req, res) => {
  try {
    const { code } = req.query;
    if (code) {
      res.json(getStockPipeline(code));
    } else {
      res.json(getStockPipelineData());
    }
  } catch (error) {
    console.error('获取流水线数据失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

app.post('/update_stock_pipeline', (req, res) => {
  try {
    const { code, stage } = req.body;
    if (!code) return res.status(400).json({ message: '缺少 code 参数' });
    const result = updateStockPipeline(code, stage);
    res.json(result);
  } catch (error) {
    console.error('更新流水线失败:', error);
    res.status(500).json({ message: error.message || '更新失败' });
  }
});

// 持仓管理记录
app.get('/get_stock_records', (req, res) => {
  try {
    res.json(getStockRecords());
  } catch (error) {
    console.error('获取持仓记录失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 持仓收益
app.get('/get_position_returns', (req, res) => {
  try {
    res.json(getPositionReturns());
  } catch (error) {
    console.error('获取持仓收益失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

app.post('/save_position_return', (req, res) => {
  try {
    const { date, operations, totalReturn, principleViolated, score, review } = req.body;
    if (!date) {
      return res.status(400).json({ message: '缺少日期参数' });
    }
    const data = {
      operations: operations || [],
      totalReturn: totalReturn ?? null,
      principleViolated: principleViolated ?? false,
      score: score ?? null,
      review: review ?? '',
    };
    const result = savePositionReturn(date, data);
    res.json(result);
  } catch (error) {
    console.error('保存持仓收益失败:', error);
    res.status(500).json({ message: error.message || '保存失败' });
  }
});

app.post('/delete_position_return', (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ message: '缺少日期参数' });
    const result = deletePositionReturn(date);
    res.json(result);
  } catch (error) {
    console.error('删除持仓收益失败:', error);
    res.status(500).json({ message: error.message || '删除失败' });
  }
});

app.get('/classify_sector_blocks_daily', async (req, res) => {
  try {
    const blocksData = JSON.parse(require('fs').readFileSync(path.resolve(__dirname, './data/block_data_day_history.json'), 'utf8'));
    const result = await classifySectorBlocksDaily(blocksData);
    res.json(result);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 通用采样函数已迁移至 service/ai.js

// 全局分析聚合接口：板块历史 + 板块资金变化 + 成交量
app.get('/global_analysis_data', (req, res) => {
  try {
    const result = generateAIContext();
    res.json(result);
  } catch (error) {
    console.error('获取全局分析数据失败:', error);
    res.status(500).json({ message: '获取全局分析数据失败' });
  }
});

// 获取 AI 市场风格分析
app.get('/get_market_style_analysis', (req, res) => {
  try {
    const data = getMarketStyleAnalysis();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: '获取分析数据失败' });
  }
});

// 更新 AI 市场风格分析
app.post('/update_market_style_analysis', (req, res) => {
  try {
    const { content } = req.body;
    const data = updateMarketStyleAnalysis(content);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: '保存分析数据失败' });
  }
});

// AI 引擎切换接口：获取 / 设置当前使用的 AI 引擎（deepseek / zhipu / local）
app.get('/ai_provider', (req, res) => {
  try {
    const list = aiSettings.getProviderList();
    const current = aiSettings.getProvider();
    res.json({ success: true, current, providers: list });
  } catch (error) {
    console.error('获取 AI 引擎配置失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取失败' });
  }
});

app.post('/ai_provider', async (req, res) => {
  try {
    const { provider } = req.body || {};
    if (!provider) {
      return res.status(400).json({ success: false, message: '缺少 provider 参数' });
    }
    const valid = aiSettings.PROVIDERS.find(p => p.key === provider);
    if (!valid) {
      return res.status(400).json({ success: false, message: `不支持的引擎: ${provider}` });
    }

    aiSettings.writeSettings(provider);
    console.log(`[aiProvider] 引擎切换为: ${provider}`);
    res.json({
      success: true,
      current: provider,
      message: `已切换到 ${valid.name}`,
    });
  } catch (error) {
    console.error('切换 AI 引擎失败:', error);
    res.status(500).json({ success: false, message: error.message || '切换失败' });
  }
});

// AI 流式代理接口（底层根据 aiProvider 配置自动切换 DeepSeek / 智谱）
app.post('/api/zhipu_chat', async (req, res) => {
  try {
    const { content, context } = req.body || {};
    const userContent = content || '分析一下今天 A 股的行情';
    const provider = getActiveProvider();

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 构建消息列表：系统提示 + 上下文数据 + 用户问题
    const messages = [
      { role: 'system', content: '你是一个专业的A股市场分析师，请基于宏观、资金面、板块轮动等维度进行分析。' }
    ];
    if (context) {
      messages.push({
        role: 'system',
        content: `以下是今日市场的实时数据，请结合这些数据进行分析：\n${typeof context === 'string' ? context : JSON.stringify(context)}`
      });
    }
    messages.push({ role: 'user', content: userContent });

    const response = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(buildRequestBody({
        messages,
        temperature: 1.0,
        stream: true,
        thinking: false, // 聊天场景关闭思考，保证流式响应即时性
      })),
    });

    if (!response.ok) {
      res.write(`data: ${JSON.stringify({ error: `${provider.name}API请求失败: ${response.status}` })}\n\n`);
      res.end();
      return;
    }

    // 透传流式数据
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } catch (error) {
    console.error('AI请求异常:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'AI请求异常' });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

app.get('/fund_snapshot/dates', (req, res) => {
  try {
    const dates = getAvailableDates();
    res.json({ success: true, data: dates });
  } catch (error) {
    console.error('获取快照日期列表失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/fund_snapshot/latest_date', (req, res) => {
  try {
    const date = getLatestSnapshotDate();
    res.json({ success: true, data: date });
  } catch (error) {
    console.error('获取最新快照日期失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/fund_snapshot/data', (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const data = getSnapshotData(date);
    if (!data) {
      return res.status(404).json({ success: false, message: '未找到该日期的快照数据' });
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('获取快照数据失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/fund_snapshot/save', (req, res) => {
  try {
    const result = saveDailySnapshots();
    res.json({ success: true, message: '快照保存成功', data: result });
  } catch (error) {
    console.error('手动保存快照失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/fupan/notes', (req, res) => {
  try {
    const notes = getAllFupanNotes();
    res.json({ success: true, data: notes });
  } catch (error) {
    console.error('获取复盘笔记列表失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/fupan/note', (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const note = getFupanNoteByDate(date);
    res.json({ success: true, data: note });
  } catch (error) {
    console.error('获取复盘笔记失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/fupan/save', (req, res) => {
  try {
    const { date, title, content, tag, tagColor } = req.body;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const result = saveFupanNote({ date, title: title || '', content: content || '', tag, tagColor });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('保存复盘笔记失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/fupan/note', (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const result = deleteFupanNote(date);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('删除复盘笔记失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/fupan/index_tline', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const data = await getIndexTlineByDate(date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('获取指数分时数据失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/fupan/personal_feelings', (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const data = getPersonalFeelings(date);
    res.json({ success: true, data });
  } catch (error) {
    console.error('获取个人感受记录失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/fupan/personal_feelings', (req, res) => {
  try {
    const { date, records } = req.body;
    if (!date) {
      return res.status(400).json({ success: false, message: '缺少 date 参数' });
    }
    const result = savePersonalFeelings({ date, records: records || [] });
    if (result.success) {
      res.json({ success: true, data: { date: result.date, records: result.records } });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('保存个人感受记录失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 当前市场快照（创业板/科创板涨幅、科技情绪、主力资金净流入、两市成交额），用于个人感受记录自动填充
app.get('/fupan/market_snapshot', async (req, res) => {
  try {
    const data = await getMarketSnapshot();
    res.json({ success: true, data });
  } catch (error) {
    console.error('获取市场快照失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 今日交易计划
app.get('/fupan/today_plan', (req, res) => {
  try {
    const data = getTodayPlan();
    res.json({ success: true, data });
  } catch (error) {
    console.error('获取今日计划失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/fupan/today_plan', (req, res) => {
  try {
    const { content } = req.body;
    const result = saveTodayPlan({ content });
    if (result.success) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('保存今日计划失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 指数叠加分时 - 分组管理
app.get('/indexOverlayGroup/list', (req, res) => {
  try {
    const groups = getAllIndexOverlayGroups();
    res.json({ success: true, data: groups });
  } catch (error) {
    console.error('获取指数叠加分组失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/indexOverlayGroup/save', (req, res) => {
  try {
    const { id, title, description, dates } = req.body;
    const result = saveIndexOverlayGroup({ id, title, description, dates });
    if (result.success) {
      res.json({ success: true, data: result.group });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('保存指数叠加分组失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/indexOverlayGroup/delete', (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ success: false, message: '缺少 id 参数' });
    }
    const result = deleteIndexOverlayGroup(id);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('删除指数叠加分组失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 叠加分时观察 - 股票分组管理
app.get('/overlayStockGroup/list', (req, res) => {
  try {
    const groups = getAllOverlayStockGroups();
    res.json({ success: true, data: groups });
  } catch (error) {
    console.error('获取叠加分时股票分组失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/overlayStockGroup/save', (req, res) => {
  try {
    const { id, name, stocks } = req.body;
    const result = saveOverlayStockGroup({ id, name, stocks });
    if (result.success) {
      res.json({ success: true, data: result.group });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('保存叠加分时股票分组失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/overlayStockGroup/delete', (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ success: false, message: '缺少 id 参数' });
    }
    const result = deleteOverlayStockGroup(id);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error('删除叠加分时股票分组失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 容灾诊断
app.get('/disaster_recovery/check', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await runDisasterRecoveryCheck({ refresh });
    res.json(result);
  } catch (error) {
    console.error('容灾诊断失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 策略中心 - 获取策略命中记录
app.get('/strategy_signals', (req, res) => {
  try {
    const records = getStrategyRecords();
    res.json(records);
  } catch (error) {
    console.error('获取策略信号失败:', error);
    res.status(500).json({ message: error.message || '获取策略信号失败' });
  }
});

// 策略中心 - 标记单条已读
app.post('/strategy_signals/read', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ message: '缺少 id 参数' });
    }
    const success = markStrategyRead(id);
    res.json({ message: success ? '已标记为已读' : '未找到对应记录', success });
  } catch (error) {
    console.error('标记策略已读失败:', error);
    res.status(500).json({ message: error.message || '标记已读失败' });
  }
});

// 策略中心 - 全部标记已读
app.post('/strategy_signals/read_all', (req, res) => {
  try {
    const success = markAllStrategiesRead();
    res.json({ message: success ? '已全部标记为已读' : '没有未读记录', success });
  } catch (error) {
    console.error('全部标记已读失败:', error);
    res.status(500).json({ message: error.message || '全部标记已读失败' });
  }
});

// 策略中心 - 获取策略定义说明
app.get('/strategy_definitions', (req, res) => {
  try {
    const definitions = getStrategyDefinitions();
    res.json(definitions);
  } catch (error) {
    console.error('获取策略定义失败:', error);
    res.status(500).json({ message: error.message || '获取策略定义失败' });
  }
});

// 策略回测 - 获取可回测日期
app.get('/backtest/dates', (req, res) => {
  try {
    const dates = getBacktestAvailableDates();
    res.json(dates);
  } catch (error) {
    console.error('获取可回测日期失败:', error);
    res.status(500).json({ message: error.message || '获取可回测日期失败' });
  }
});

// 策略回测 - 执行回测
app.get('/backtest/run', async (req, res) => {
  try {
    const { date, strategies } = req.query;
    if (!date) {
      return res.status(400).json({ message: '请选择回测日期' });
    }
    
    let strategyIds = null;
    if (strategies) {
      strategyIds = strategies.split(',').filter(s => s);
    }
    
    const result = await runBacktest(date, strategyIds);
    res.json(result);
  } catch (error) {
    console.error('回测执行失败:', error);
    res.status(500).json({ message: error.message || '回测执行失败' });
  }
});

// 策略回测 - 获取策略列表
app.get('/backtest/strategies', (req, res) => {
  try {
    res.json(Object.values(STRATEGY_DEFINITIONS));
  } catch (error) {
    console.error('获取策略列表失败:', error);
    res.status(500).json({ message: error.message || '获取策略列表失败' });
  }
});

// 策略回测 - AI 诊断（运行回测 + 调用 AI 大模型分析，返回严格 JSON）
app.post('/backtest/ai_run', async (req, res) => {
  try {
    const { date, strategies } = req.body || {};
    if (!date) {
      return res.status(400).json({ success: false, message: '请选择回测日期' });
    }
    let strategyIds = null;
    if (strategies && Array.isArray(strategies) && strategies.length > 0) {
      strategyIds = strategies;
    } else if (typeof strategies === 'string') {
      strategyIds = strategies.split(',').filter(s => s);
    }
    const result = await runStrategyAiDiagnosis(date, strategyIds);
    if (result.success === false) {
      return res.json(result);
    }
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 诊断回测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 诊断回测失败' });
  }
});

// 策略回测 - 获取 AI 诊断上下文（用于拷贝上下文功能）
app.post('/backtest/get_context', async (req, res) => {
  try {
    const { date, strategies } = req.body || {};
    if (!date) {
      return res.status(400).json({ success: false, message: '请选择回测日期' });
    }
    let strategyIds = null;
    if (strategies && Array.isArray(strategies) && strategies.length > 0) {
      strategyIds = strategies;
    } else if (typeof strategies === 'string') {
      strategyIds = strategies.split(',').filter(s => s);
    }
    const result = await getStrategyAiDiagnosisContext(date, strategyIds);
    if (result.success === false) {
      return res.json(result);
    }
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('获取 AI 诊断上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取 AI 诊断上下文失败' });
  }
});

// 训练营 - 获取可回放日期
app.get('/training_camp/dates', (req, res) => {
  try {
    const dates = getTrainingCampDates();
    res.json(dates);
  } catch (error) {
    console.error('获取训练营日期失败:', error);
    res.status(500).json({ message: error.message || '获取训练营日期失败' });
  }
});

// 训练营 - 获取某日期全量回放数据
app.get('/training_camp/data', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, message: '请选择回放日期' });
    }
    const result = await loadTrainingCampData(date);
    res.json(result);
  } catch (error) {
    console.error('获取训练营回放数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取训练营回放数据失败' });
  }
});

// 训练营 - 获取分组列表
app.get('/training_camp/groups', (req, res) => {
  try {
    const groups = getTrainingCampGroups();
    res.json(groups);
  } catch (error) {
    console.error('获取训练营分组失败:', error);
    res.status(500).json({ message: error.message || '获取训练营分组失败' });
  }
});

// 训练营 - 新增/更新分组
app.post('/training_camp/groups', (req, res) => {
  try {
    const group = req.body || {};
    if (!group.name) {
      return res.status(400).json({ message: '分组名称不能为空' });
    }
    const saved = saveTrainingCampGroup(group);
    res.json(saved);
  } catch (error) {
    console.error('保存训练营分组失败:', error);
    res.status(500).json({ message: error.message || '保存训练营分组失败' });
  }
});

// 训练营 - 删除分组
app.delete('/training_camp/groups/:id', (req, res) => {
  try {
    const { id } = req.params;
    deleteTrainingCampGroup(id);
    res.json({ success: true });
  } catch (error) {
    console.error('删除训练营分组失败:', error);
    res.status(500).json({ message: error.message || '删除训练营分组失败' });
  }
});

// 训练营 - 买卖点历史回测（异步任务：按日期逐个加载回放数据并跑买卖点，耗时较长）
// 支持多策略；结果按 策略+日期范围 缓存到 data/backtest_results，覆盖旧文件
const buySellBacktestTasks = new Map(); // taskId -> { status, progress, result, error }
app.post('/training_camp/backtest', (req, res) => {
  try {
    const { startDate, endDate, strategy, force } = req.body || {};
    if (!startDate || !endDate || !/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate)) {
      return res.status(400).json({ success: false, message: '参数错误：startDate/endDate 需为 YYYYMMDD' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ success: false, message: '开始日期不能晚于结束日期' });
    }
    const strategyId = STRATEGIES[strategy] ? strategy : Object.keys(STRATEGIES)[0];
    // 命中缓存则直接返回，不再重复回测（force=true 时忽略缓存强制重跑）
    const cached = force ? null : readCachedBacktest(strategyId, startDate, endDate);
    if (cached) {
      return res.json({ success: true, cached: true, strategy: strategyId, taskId: null, result: cached });
    }
    const taskId = `bt${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    buySellBacktestTasks.set(taskId, { status: 'running', progress: { current: 0, total: 0, date: '', status: '' }, result: null, error: null });
    // 异步执行，避免阻塞事件循环
    runRangeBacktest(startDate, endDate, strategyId, (progress) => {
      const task = buySellBacktestTasks.get(taskId);
      if (task) task.progress = progress;
    }).then(result => {
      const task = buySellBacktestTasks.get(taskId);
      if (task) { task.status = 'done'; task.result = result; }
      if (result?.success) writeCachedBacktest(strategyId, startDate, endDate, result);
    }).catch(err => {
      const task = buySellBacktestTasks.get(taskId);
      if (task) { task.status = 'error'; task.error = err.message || String(err); }
    });
    res.json({ success: true, cached: false, strategy: strategyId, taskId });
  } catch (error) {
    console.error('创建买卖点回测任务失败:', error);
    res.status(500).json({ success: false, message: error.message || '创建买卖点回测任务失败' });
  }
});

app.get('/training_camp/backtest/status/:taskId', (req, res) => {
  try {
    const { taskId } = req.params;
    const task = buySellBacktestTasks.get(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: '回测任务不存在或已过期' });
    }
    res.json({ success: true, status: task.status, progress: task.progress, result: task.result ? attachHoldingDays(task.result) : null, error: task.error });
  } catch (error) {
    console.error('查询买卖点回测任务失败:', error);
    res.status(500).json({ success: false, message: error.message || '查询任务状态失败' });
  }
});

// 查询某策略+日期范围是否已有缓存结果（抽屉打开时可据此直接展示，无需重新回测）
app.get('/training_camp/backtest/cache', (req, res) => {
  try {
    const { startDate, endDate, strategy } = req.query || {};
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: '参数错误：startDate/endDate 缺失' });
    }
    const strategyId = STRATEGIES[strategy] ? strategy : Object.keys(STRATEGIES)[0];
    const cached = readCachedBacktest(strategyId, String(startDate), String(endDate));
    if (cached) {
      return res.json({ success: true, cached: true, strategy: strategyId, result: cached });
    }
    res.json({ success: true, cached: false, strategy: strategyId });
  } catch (error) {
    console.error('查询回测缓存失败:', error);
    res.status(500).json({ success: false, message: error.message || '查询缓存失败' });
  }
});

// ---------- 买卖点回测 - 情绪游资默认日期范围（最近 60 个已完结交易日，不依赖回放缓存）----------
app.get('/training_camp/backtest/sentiment_range', async (req, res) => {
  try {
    const range = await getSentimentDefaultRange();
    if (!range) {
      return res.status(500).json({ success: false, message: '情绪游资默认日期范围获取失败（交易日历不可用）' });
    }
    res.json({ success: true, ...range });
  } catch (error) {
    console.error('获取情绪游资默认日期范围失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取默认日期范围失败' });
  }
});

// ---------- 买卖点回测 - 全量回测（后台执行 script/backtest-worker.js：清空回测缓存 → 预热日K → 并行预构建 → 并行跑全部策略 → 自动汇总生成回测报告）----------
// 单例任务：同一时刻只允许一个 worker 进程；进度经 stdout/stderr 捕获为日志尾部的环形缓冲
const backtestWorkerJob = { status: 'idle', startedAt: null, endedAt: null, exitCode: null, logTail: [] };
const BACKTEST_WORKER_LOG_MAX = 120;

app.post('/training_camp/backtest/worker', (req, res) => {
  try {
    if (backtestWorkerJob.status === 'running') {
      return res.json({ success: true, running: true, startedAt: backtestWorkerJob.startedAt, message: '全量回测已在进行中' });
    }
    const { startDate, endDate } = req.body || {};
    const args = [path.join(__dirname, '../script/backtest-worker.js')];
    if (startDate && endDate) {
      if (!/^\d{8}$/.test(String(startDate)) || !/^\d{8}$/.test(String(endDate))) {
        return res.status(400).json({ success: false, message: '参数错误：startDate/endDate 需为 YYYYMMDD' });
      }
      if (startDate > endDate) {
        return res.status(400).json({ success: false, message: '开始日期不能晚于结束日期' });
      }
      args.push('--start', String(startDate), '--end', String(endDate));
    }
    backtestWorkerJob.status = 'running';
    backtestWorkerJob.startedAt = Date.now();
    backtestWorkerJob.endedAt = null;
    backtestWorkerJob.exitCode = null;
    backtestWorkerJob.logTail = [];
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    const pushLog = (line) => {
      const t = String(line || '').trim();
      if (!t) return;
      backtestWorkerJob.logTail.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${t}`);
      if (backtestWorkerJob.logTail.length > BACKTEST_WORKER_LOG_MAX) backtestWorkerJob.logTail.shift();
    };
    let outBuf = '';
    let errBuf = '';
    child.stdout.on('data', (d) => {
      outBuf += String(d);
      const lines = outBuf.split('\n');
      outBuf = lines.pop() || '';
      lines.forEach(pushLog);
    });
    child.stderr.on('data', (d) => {
      errBuf += String(d);
      const lines = errBuf.split('\n');
      errBuf = lines.pop() || '';
      lines.forEach(pushLog);
    });
    child.on('error', (err) => {
      backtestWorkerJob.status = 'error';
      backtestWorkerJob.endedAt = Date.now();
      backtestWorkerJob.exitCode = -1;
      pushLog(`全量回测 worker 启动失败: ${err.message}`);
    });
    child.on('exit', (code) => {
      if (outBuf.trim()) pushLog(outBuf);
      if (errBuf.trim()) pushLog(errBuf);
      backtestWorkerJob.status = code === 0 ? 'done' : 'error';
      backtestWorkerJob.endedAt = Date.now();
      backtestWorkerJob.exitCode = code;
      console.log(`全量回测 worker 结束（code=${code}，耗时 ${((Date.now() - backtestWorkerJob.startedAt) / 1000).toFixed(1)}s）`);
    });
    console.log(`全量回测 worker 已启动: node script/backtest-worker.js${startDate ? ` --start ${startDate} --end ${endDate}` : ''}`);
    res.json({ success: true, running: true, startedAt: backtestWorkerJob.startedAt });
  } catch (error) {
    console.error('启动全量回测失败:', error);
    res.status(500).json({ success: false, message: error.message || '启动全量回测失败' });
  }
});

app.get('/training_camp/backtest/worker/status', (req, res) => {
  res.json({
    success: true,
    status: backtestWorkerJob.status, // idle | running | done | error
    startedAt: backtestWorkerJob.startedAt,
    endedAt: backtestWorkerJob.endedAt,
    exitCode: backtestWorkerJob.exitCode,
    logs: backtestWorkerJob.logTail.slice(-30),
  });
});

// ---------- 买卖点回测报告 ----------
const backtestReportTasks = new Map(); // taskId -> { status, progress, result, error }

// 最新回测报告；无报告时从现有回测缓存快速生成一份（不重新回测）
app.get('/training_camp/backtest/report/latest', async (req, res) => {
  try {
    const r = await ensureLatestReport();
    if (!r.success || !r.report) {
      return res.status(500).json({ success: false, message: r.message || '暂无可用的回测报告' });
    }
    res.json({ success: true, report: r.report });
  } catch (error) {
    console.error('获取最新回测报告失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取回测报告失败' });
  }
});

// 历史回测报告列表（最近 MAX_REPORTS=5 次）
app.get('/training_camp/backtest/report/history', (req, res) => {
  try {
    const list = listReports();
    res.json({ success: true, list });
  } catch (error) {
    console.error('获取回测报告列表失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取回测报告列表失败' });
  }
});

// 重新生成最新回测报告（逐策略重新回测过去 30 个交易日）；异步任务 + 轮询
app.post('/training_camp/backtest/report/generate', (req, res) => {
  try {
    const { startDate, endDate } = req.body || {};
    if ((startDate && !/^\d{8}$/.test(startDate)) || (endDate && !/^\d{8}$/.test(endDate))) {
      return res.status(400).json({ success: false, message: '参数错误：startDate/endDate 需为 YYYYMMDD' });
    }
    const taskId = `rpt${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    backtestReportTasks.set(taskId, { status: 'running', progress: { current: 0, total: 0, strategy: '', status: '' }, result: null, error: null });
    generateReport({
      startDate, endDate,
      fromCacheOnly: false,
      onProgress: (p) => {
        const task = backtestReportTasks.get(taskId);
        if (task) task.progress = p;
      },
    }).then(r => {
      const task = backtestReportTasks.get(taskId);
      if (task) {
        if (r.success) { task.status = 'done'; task.result = r.report; }
        else { task.status = 'error'; task.error = r.message || '回测报告生成失败'; }
      }
    }).catch(err => {
      const task = backtestReportTasks.get(taskId);
      if (task) { task.status = 'error'; task.error = err.message || String(err); }
    });
    res.json({ success: true, taskId });
  } catch (error) {
    console.error('创建回测报告生成任务失败:', error);
    res.status(500).json({ success: false, message: error.message || '创建回测报告生成任务失败' });
  }
});

// 回测报告生成任务状态
app.get('/training_camp/backtest/report/status/:taskId', (req, res) => {
  try {
    const { taskId } = req.params;
    const task = backtestReportTasks.get(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: '回测报告生成任务不存在或已过期' });
    }
    res.json({ success: true, status: task.status, progress: task.progress, report: task.result, error: task.error });
  } catch (error) {
    console.error('查询回测报告生成任务失败:', error);
    res.status(500).json({ success: false, message: error.message || '查询任务状态失败' });
  }
});

// 指定 id 的回测报告详情
app.get('/training_camp/backtest/report/:id', (req, res) => {
  try {
    const { id } = req.params;
    const report = getReportById(id);
    if (!report) {
      return res.status(404).json({ success: false, message: '回测报告不存在' });
    }
    res.json({ success: true, report });
  } catch (error) {
    console.error('获取回测报告详情失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取回测报告详情失败' });
  }
});

// 智能回测诊断
app.post('/smart_backtest_run', async (req, res) => {
  try {
    const { startDate, endDate, strategy } = req.body || {};
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: '请选择回测日期范围' });
    }
    if (!strategy) {
      return res.status(400).json({ success: false, message: '请选择一个策略' });
    }
    const result = await smartBacktestRun(startDate, endDate, strategy);
    res.json(result);
  } catch (error) {
    console.error('智能回测诊断失败:', error);
    res.status(500).json({ success: false, message: error.message || '智能回测诊断失败' });
  }
});

// AI 预测 - 可用日期
app.get('/ai_prediction/dates', (req, res) => {
  try {
    const dates = getAiPredictionDates();
    res.json({ success: true, data: dates });
  } catch (error) {
    console.error('获取 AI 预测可用日期失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取可用日期失败' });
  }
});

// AI 预测 - 可选指数
app.get('/ai_prediction/indexes', (req, res) => {
  try {
    res.json({ success: true, data: AI_INDEX_OPTIONS });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 预测 - 执行预测
app.post('/ai_prediction/run', async (req, res) => {
  try {
    const { dates, indexCode, sampleCount } = req.body || {};
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ success: false, message: '请至少选择一个历史日期' });
    }
    const result = await getAiPrediction(dates, indexCode, sampleCount);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 预测执行失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 预测执行失败' });
  }
});

// AI 预测 - 实时预测（前 5 交易日 + 当日已走部分 → 预测当日剩余）
app.post('/ai_prediction/realtime', async (req, res) => {
  try {
    const { indexCode, sampleCount } = req.body || {};
    const result = await getAiRealtimePrediction(indexCode, sampleCount);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 实时预测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 实时预测失败' });
  }
});

// AI 预测 - 回测预测（选定交易日 + 时刻 → 预测当日剩余）
app.post('/ai_prediction/backtest', async (req, res) => {
  try {
    const { indexCode, targetDate, targetMinute, sampleCount } = req.body || {};
    if (!targetDate) return res.status(400).json({ success: false, message: '请选择回测交易日' });
    if (!targetMinute) return res.status(400).json({ success: false, message: '请选择回测时刻' });
    const result = await getAiBacktestPrediction(indexCode, targetDate, targetMinute, sampleCount);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 回测预测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 回测预测失败' });
  }
});

// AI 预测 - 可选时刻（5 分钟桶）
app.get('/ai_prediction/minutes', (req, res) => {
  res.json({ success: true, data: AI_INTRADAY_MINUTES });
});

// AI 预测 - 在线回测（AI 大模型）
app.post('/ai_prediction/online_backtest', async (req, res) => {
  try {
    const { indexCode, targetDate, targetMinute } = req.body || {};
    if (!targetDate) return res.status(400).json({ success: false, message: '请选择回测交易日' });
    if (!targetMinute) return res.status(400).json({ success: false, message: '请选择回测时刻' });
    const result = await getAiOnlineBacktestPrediction(indexCode, targetDate, targetMinute);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 在线回测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 在线回测失败' });
  }
});

// AI 预测 - 在线实时预测（AI 大模型）
app.post('/ai_prediction/online_realtime', async (req, res) => {
  try {
    const { indexCode } = req.body || {};
    const result = await getAiOnlineRealtimePrediction(indexCode);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 在线实时预测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 在线实时预测失败' });
  }
});

// AI 预测 - 获取上下文（用于拷贝上下文功能）
app.post('/ai_prediction/get_context', async (req, res) => {
  try {
    const { indexCode, targetDate, targetMinute, mode } = req.body || {};
    if (!mode || !['realtime', 'backtest'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'mode 必须为 realtime 或 backtest' });
    }
    if (mode === 'backtest') {
      if (!targetDate) return res.status(400).json({ success: false, message: '请选择回测交易日' });
      if (!targetMinute) return res.status(400).json({ success: false, message: '请选择回测时刻' });
    }
    const result = await getAiPredictionContext(indexCode, targetDate, targetMinute, mode);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 获取上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 获取上下文失败' });
  }
});

// AI 预测 - K线实时预测（Kronos 预测下一交易日全天 48 根）
app.post('/ai_prediction/kline_realtime', async (req, res) => {
  try {
    const { indexCode, sampleCount } = req.body || {};
    const result = await getAiKlinePrediction(indexCode, sampleCount);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI K线实时预测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI K线实时预测失败' });
  }
});

// AI 预测 - K线回测预测（Kronos 预测目标日全天 48 根，含实际走势）
app.post('/ai_prediction/kline_backtest', async (req, res) => {
  try {
    const { indexCode, targetDate, sampleCount } = req.body || {};
    if (!targetDate) return res.status(400).json({ success: false, message: '请选择回测交易日' });
    const result = await getAiKlineBacktestPrediction(indexCode, targetDate, sampleCount);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI K线回测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI K线回测失败' });
  }
});

// AI 预测 - 在线K线实时预测（AI 大模型预测下一交易日全天 48 根）
app.post('/ai_prediction/online_kline_realtime', async (req, res) => {
  try {
    const { indexCode } = req.body || {};
    const result = await getAiOnlineKlinePrediction(indexCode);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 在线K线预测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 在线K线预测失败' });
  }
});

// AI 预测 - 在线K线回测（AI 大模型预测目标日全天 48 根，含实际走势）
app.post('/ai_prediction/online_kline_backtest', async (req, res) => {
  try {
    const { indexCode, targetDate } = req.body || {};
    if (!targetDate) return res.status(400).json({ success: false, message: '请选择回测交易日' });
    const result = await getAiOnlineKlineBacktestPrediction(indexCode, targetDate);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 在线K线回测失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 在线K线回测失败' });
  }
});

// AI 预测 - 获取K线预测上下文（用于拷贝上下文功能）
app.post('/ai_prediction/get_kline_context', async (req, res) => {
  try {
    const { indexCode, targetDate, mode } = req.body || {};
    if (!mode || !['realtime', 'backtest'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'mode 必须为 realtime 或 backtest' });
    }
    if (mode === 'backtest' && !targetDate) {
      return res.status(400).json({ success: false, message: '请选择回测交易日' });
    }
    const result = await getAiKlinePredictionContext(indexCode, targetDate, mode);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 获取K线上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 获取K线上下文失败' });
  }
});

// AI 预测 - 历史探查（100天分时数据 + 用户问题 → AI 分析）
app.post('/ai_prediction/history_explore', async (req, res) => {
  try {
    const { indexCode, userQuestion } = req.body || {};
    if (!userQuestion || !userQuestion.trim()) {
      return res.status(400).json({ success: false, message: '请输入要分析的问题' });
    }
    const result = await getAiHistoryExplorationResult(indexCode || 'sz399006', userQuestion);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 历史探查失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 历史探查失败' });
  }
});

// AI 预测 - 历史探查上下文（用于拷贝到豆包/千问等平台）
app.post('/ai_prediction/history_explore_context', async (req, res) => {
  try {
    const { indexCode, userQuestion } = req.body || {};
    if (!userQuestion || !userQuestion.trim()) {
      return res.status(400).json({ success: false, message: '请输入要分析的问题' });
    }
    const result = await getAiHistoryExplorationContext(indexCode || 'sz399006', userQuestion);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 历史探查上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 历史探查上下文失败' });
  }
});

// 主力资金页面 AI 总结（历史分时+资金/成交量快照作为上下文 + 当日实时数据 → AI 分析）
app.post('/main_fund/ai_summary', async (req, res) => {
  try {
    const result = await getMainFundAiSummary();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('主力资金 AI 总结失败:', error);
    res.status(500).json({ success: false, message: error.message || '主力资金 AI 总结失败' });
  }
});

// 主力资金页面 AI 上下文（用于拷贝到豆包/千问等平台）
app.post('/main_fund/ai_context', async (req, res) => {
  try {
    const result = await getMainFundAiContext();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('主力资金 AI 上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || '主力资金 AI 上下文失败' });
  }
});

// ==================== 重点板块配置 CRUD ====================
app.get('/api/blocks_config', (req, res) => {
  try {
    const list = getBlocksConfig();
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('获取板块配置失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取板块配置失败' });
  }
});

app.post('/api/blocks_config', (req, res) => {
  try {
    const { action, block, blockName } = req.body || {};
    if (!action || !['add', 'addBlock', 'update', 'delete', 'deleteByName'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action 必须为 add/addBlock/update/delete/deleteByName' });
    }
    let data;
    if (action === 'add') {
      if (!block?.blockName || !block?.code || !block?.name) {
        return res.status(400).json({ success: false, message: 'block 需包含 blockName/code/name' });
      }
      data = addBlock(block);
    } else if (action === 'addBlock') {
      const { blockName, stocks } = req.body || {};
      if (!blockName) {
        return res.status(400).json({ success: false, message: 'blockName 不能为空' });
      }
      data = addBlockName({ blockName, stocks: stocks || [] });
    } else if (action === 'update') {
      if (!block?.code) {
        return res.status(400).json({ success: false, message: 'block.code 不能为空' });
      }
      data = updateBlock(block);
    } else if (action === 'delete') {
      if (!block?.code) {
        return res.status(400).json({ success: false, message: 'block.code 不能为空' });
      }
      data = deleteBlock(block.code);
    } else if (action === 'deleteByName') {
      if (!blockName) {
        return res.status(400).json({ success: false, message: 'blockName 不能为空' });
      }
      data = deleteBlockByName(blockName);
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('更新板块配置失败:', error);
    res.status(500).json({ success: false, message: error.message || '更新板块配置失败' });
  }
});

// ==================== 板块 AI 分析 ====================
// 拷贝上下文（返回 prompt 字符串供前端写入剪贴板）
app.post('/api/block_ai_context', async (req, res) => {
  try {
    const { days } = req.body || {};
    const result = await getBlockAiContext(Number(days) || 10);
    res.json(result);
  } catch (error) {
    console.error('获取板块 AI 上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取板块 AI 上下文失败' });
  }
});

// 直接调用 AI 分析
app.post('/api/block_ai_analysis', async (req, res) => {
  try {
    const { days } = req.body || {};
    const result = await runBlockAiAnalysis(Number(days) || 10);
    res.json(result);
  } catch (error) {
    console.error('板块 AI 分析失败:', error);
    res.status(500).json({ success: false, message: error.message || '板块 AI 分析失败' });
  }
});

// ==================== AI 选股 ====================
// AI 选股上下文（用于复制到豆包/千问等平台）
app.post('/ai_stock_screen/context', async (req, res) => {
  try {
    const result = getAiScreenContext();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI 选股上下文失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 选股上下文失败' });
  }
});

// AI 选股（直接调用 AI）
app.post('/ai_stock_screen/run', async (req, res) => {
  try {
    const result = await runAiScreen();
    res.json(result);
  } catch (error) {
    console.error('AI 选股失败:', error);
    res.status(500).json({ success: false, message: error.message || 'AI 选股失败' });
  }
});

// ==================== 数据中心 ====================
// 列出 data 目录下所有数据文件（树形结构）
app.get('/data_center/files', (req, res) => {
  try {
    const tree = listDataFiles();
    res.json({ success: true, data: tree });
  } catch (error) {
    console.error('列出数据文件失败:', error);
    res.status(500).json({ success: false, message: error.message || '列出数据文件失败' });
  }
});

// 读取单个数据文件内容
app.get('/data_center/file', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ success: false, message: '缺少 path 参数' });
    }
    const content = readDataFile(filePath);
    res.json({ success: true, data: content, path: filePath });
  } catch (error) {
    console.error('读取数据文件失败:', error);
    res.status(500).json({ success: false, message: error.message || '读取数据文件失败' });
  }
});

// 批量读取多个数据文件
app.post('/data_center/batch_files', (req, res) => {
  try {
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ success: false, message: '缺少 paths 参数' });
    }
    const result = readDataFilesBatch(paths);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('批量读取数据文件失败:', error);
    res.status(500).json({ success: false, message: error.message || '批量读取数据文件失败' });
  }
});

// 获取所有别名映射
app.get('/data_center/aliases', (req, res) => {
  try {
    const aliases = getAliases();
    res.json({ success: true, data: aliases });
  } catch (error) {
    console.error('获取别名映射失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取别名映射失败' });
  }
});

// 设置单个别名
app.post('/data_center/alias', (req, res) => {
  try {
    const { path: filePath, alias } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ success: false, message: '缺少 path 参数' });
    }
    const aliases = setAlias(filePath, alias || '');
    res.json({ success: true, data: aliases });
  } catch (error) {
    console.error('设置别名失败:', error);
    res.status(500).json({ success: false, message: error.message || '设置别名失败' });
  }
});

// 获取所有隐藏路径
app.get('/data_center/hidden', (req, res) => {
  try {
    const hidden = getHiddenPaths();
    res.json({ success: true, data: hidden });
  } catch (error) {
    console.error('获取隐藏路径失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取隐藏路径失败' });
  }
});

// 设置隐藏/显示
app.post('/data_center/hidden', (req, res) => {
  try {
    const { path: filePath, hidden } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ success: false, message: '缺少 path 参数' });
    }
    const hiddenList = setHiddenPath(filePath, !!hidden);
    res.json({ success: true, data: hiddenList });
  } catch (error) {
    console.error('设置隐藏失败:', error);
    res.status(500).json({ success: false, message: error.message || '设置隐藏失败' });
  }
});

// 批量获取多只股票的 K 线数据
app.post('/data_center/stocks_kline', async (req, res) => {
  try {
    const { codes, limit } = req.body || {};
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ success: false, message: '缺少 codes 参数' });
    }
    const klineLimit = Number(limit) || 100;
    const results = {};
    await Promise.all(codes.map(async (code) => {
      try {
        results[code] = await getSingleStockData(code, klineLimit);
      } catch (e) {
        results[code] = { __error: e.message };
      }
    }));
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('批量获取股票K线数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '批量获取股票K线数据失败' });
  }
});

// 批量获取多只股票的分时数据
app.post('/data_center/stocks_tline', async (req, res) => {
  try {
    const { codes } = req.body || {};
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ success: false, message: '缺少 codes 参数' });
    }
    const results = {};
    await Promise.all(codes.map(async (code) => {
      try {
        const tline = await getSingleStockTlineData(code);
        results[code] = tline || { __error: '无数据' };
      } catch (e) {
        results[code] = { __error: e.message };
      }
    }));
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('批量获取股票分时数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '批量获取股票分时数据失败' });
  }
});

// 批量获取指数 K 线数据（可选指定指数代码列表）
app.post('/data_center/indexes_kline', async (req, res) => {
  try {
    const { codes, limit } = req.body || {};
    // 默认拉取三大指数
    const targetCodes = Array.isArray(codes) && codes.length > 0
      ? codes
      : ['sh000001', 'sz399006', 'sh000688'];
    const klineLimit = Number(limit) || 100;
    const results = {};
    await Promise.all(targetCodes.map(async (code) => {
      try {
        results[code] = await getSingleStockData(code, klineLimit);
      } catch (e) {
        results[code] = { __error: e.message };
      }
    }));
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('批量获取指数K线数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '批量获取指数K线数据失败' });
  }
});

// 批量获取指数分时数据（可选指定日期，默认当天）
app.post('/data_center/indexes_tline', async (req, res) => {
  try {
    const { codes, date } = req.body || {};
    const targetCodes = Array.isArray(codes) && codes.length > 0
      ? codes
      : ['sh000001', 'sz399006', 'sh000688'];
    const now = new Date();
    const dateStr = date || `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const results = {};
    await Promise.all(targetCodes.map(async (code) => {
      try {
        const tline = await getSingleStockTlineData(code);
        results[code] = tline || { __error: '无数据' };
      } catch (e) {
        results[code] = { __error: e.message };
      }
    }));
    res.json({ success: true, data: results, date: dateStr });
  } catch (error) {
    console.error('批量获取指数分时数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '批量获取指数分时数据失败' });
  }
});

// 获取开盘攻防分数（基于最近3min快照动态计算）
app.get('/opening_battle_score', (req, res) => {
  try {
    const score = getAttackDefenseScore();
    res.json(score);
  } catch (error) {
    console.error('获取攻防分数失败:', error);
    res.status(500).json({ message: error.message || '获取失败' });
  }
});

// 获取隔夜美股数据（按日期读取已存储的快照）
app.get('/overnight_meigu', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '') === '1';
    const queryDate = req.query.date;

    // refresh=1 仅允许当天数据强制重新拉取并覆盖存储
    if (refresh) {
      const payload = await refreshOvernightMeiguData();
      return res.json({ success: true, data: payload.data, date: payload.date, fetchTime: payload.fetchTime });
    }

    // 有 date 参数：读取指定日期的快照；无 date 参数：读取最新可用日期
    let dateStr = queryDate;
    if (!dateStr) {
      dateStr = getLatestMeiguDate();
    }

    if (!dateStr) {
      return res.json({ success: true, data: [], date: null, fetchTime: null });
    }

    const payload = getOvernightMeiguData(dateStr);
    if (!payload) {
      return res.json({ success: true, data: [], date: dateStr, fetchTime: null });
    }

    res.json({ success: true, data: payload.data || [], date: payload.date, fetchTime: payload.fetchTime });
  } catch (error) {
    console.error('获取隔夜美股数据失败:', error);
    res.status(500).json({ success: false, message: error.message || '获取隔夜美股数据失败' });
  }
});

// ==================== 盘中市场快照飞书播报（后端自主调度，前端零逻辑）====================
// 交易时段（工作日 9:30-11:30、13:00-15:00）内每 5 分钟播报一次；
// 时间戳持久化在 data/feishu_market_snapshot_state.json，服务重启/多页面打开均不会重复发送
const MARKET_SNAPSHOT_STATE_FILE = path.join(__dirname, 'data/feishu_market_snapshot_state.json');
const MARKET_SNAPSHOT_MIN_INTERVAL = 5 * 60 * 1000;

const readMarketSnapshotLastSentAt = () => {
  try {
    if (!fs.existsSync(MARKET_SNAPSHOT_STATE_FILE)) return 0;
    const state = JSON.parse(fs.readFileSync(MARKET_SNAPSHOT_STATE_FILE, 'utf8'));
    return Number(state.lastSentAt) || 0;
  } catch (error) {
    console.error('读取市场快照发送时间戳失败:', error);
    return 0;
  }
};

const writeMarketSnapshotLastSentAt = (ts) => {
  try {
    fs.writeFileSync(MARKET_SNAPSHOT_STATE_FILE, JSON.stringify({ lastSentAt: ts }, null, 2));
  } catch (error) {
    console.error('写入市场快照发送时间戳失败:', error);
  }
};

// 是否处于可播报时段：交易日（以交易日历为准，自动剔除周末与法定节假日）且在 9:30-11:30 或 13:00-15:00 内
const isInMarketSnapshotWindow = () => {
  const { isTradingDay } = require('./utils/tradingDay');
  const now = dayjs();
  if (!isTradingDay(now.toDate())) return false;
  const totalMinutes = now.hour() * 60 + now.minute();
  return (totalMinutes >= 570 && totalMinutes < 690) || (totalMinutes >= 780 && totalMinutes < 900);
};

// 发送盘中市场快照：拉取大盘/成交额/指数/情绪数据 → 计算近5分钟主力净流入 → 发飞书文本
const runMarketSnapshotJob = async () => {
  const lastSentAt = readMarketSnapshotLastSentAt();
  // 距上次发送不足 5 分钟直接跳过
  if (Date.now() - lastSentAt < MARKET_SNAPSHOT_MIN_INTERVAL) return;
  // 先同步写入占坑，避免多个检查周期并发通过冷却检查导致重复发送
  writeMarketSnapshotLastSentAt(Date.now());
  try {
    // 并行获取：大盘资金/成交量 + 盘中资金分时序列 + 创业板/科创板指数 + 触发科技情绪重新计算
    const [dapanData, amountHistory, indexKlineData, emotionData] = await Promise.all([
      getAllDaPanData(),
      getAmountHistory(),
      getAllIndexKlineData(),
      updateCurrentTechIndexData(),
    ]);
    // 同步写入情绪分时数据（与原 /update_emotion_data 接口行为保持一致）
    try {
      await forceRecordTechEmotionIntraday(emotionData);
    } catch (e) {
      console.error('市场快照写入情绪分时数据失败:', e.message);
    }

    // K线数据按日期升序排列（最旧在前），最新一条在数组末尾
    const cybArr = indexKlineData?.chuangyebanData || [];
    const kcbArr = indexKlineData?.kechuangbanData || [];

    // 资金净流入：取最近 5 分钟的净流入增量 = 最新累计值 - 5分钟前的累计值
    const calcMainMoney5minDiff = () => {
      const src = Array.isArray(amountHistory) ? amountHistory : [];
      const sorted = src
        .filter((a) => Array.isArray(a) && a[0] && a[1] && Number.isFinite(Number(a[1].mainMoney)))
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map((a) => ({ t: String(a[0]), money: Number(a[1].mainMoney) }));
      if (sorted.length < 2) return null;

      // 从 HHmmss 时间往前推 minutes 分钟
      const subMinutes = (hhmmss, minutes) => {
        const hh = parseInt(hhmmss.slice(0, 2), 10);
        const mm = parseInt(hhmmss.slice(2, 4), 10);
        const total = hh * 60 + mm - minutes;
        if (total < 0) return null;
        const h = String(Math.floor(total / 60)).padStart(2, '0');
        const m = String(total % 60).padStart(2, '0');
        const ss = hhmmss.length >= 6 ? hhmmss.slice(4, 6) : '00';
        return `${h}${m}${ss}`;
      };

      const last = sorted[sorted.length - 1];
      const target = subMinutes(last.t, 5);
      if (!target) return null;
      // 找时间 <= target 的最近一条快照
      let prev = null;
      for (let i = sorted.length - 2; i >= 0; i--) {
        if (sorted[i].t <= target) { prev = sorted[i]; break; }
      }
      if (!prev) return null;
      const diff = last.money - prev.money;
      return `${diff > 0 ? '+' : ''}${diff.toFixed(2)}`;
    };

    const textContent = feishuNotify.buildMarketSnapshotText({
      mainMoney: calcMainMoney5minDiff() || dapanData?.mainMoney,
      amountChangeDiff: dapanData?.amountChangeDiff,
      chuangyeban: cybArr[cybArr.length - 1] || null,
      kechuangban: kcbArr[kcbArr.length - 1] || null,
      techEmotion: emotionData ?? null,
    });
    const sendResult = await feishuNotify.sendFeishuText(textContent);
    if (!sendResult.success) {
      // 发送失败回滚占坑时间戳，下一轮检查可立即重试
      writeMarketSnapshotLastSentAt(lastSentAt);
      console.error('发送盘中市场快照失败:', sendResult.error);
    } else {
      console.log('盘中市场快照已发送');
    }
  } catch (error) {
    writeMarketSnapshotLastSentAt(lastSentAt);
    console.error('发送盘中市场快照失败:', error);
  }
};

// 每分钟检查一次：处于可播报时段才执行，冷却由时间戳文件控制
setInterval(() => {
  if (isInMarketSnapshotWindow()) runMarketSnapshotJob();
}, 60 * 1000);

// 启动服务
app.listen(port, () => {
  console.log(`服务运行在 http://localhost:${port}`);
  console.log('轮询服务已分离到单独脚本，请运行 npm run poll 启动轮询');

  // 每周六首次启动服务时，自动回测全部策略（过去 30 个交易日）并生成最新回测报告
  const nowDate = new Date();
  if (nowDate.getDay() === 6) {
    console.log('今日为周六，开始自动回测全部策略并生成回测报告（过去 30 个交易日）……');
    generateReport({
      fromCacheOnly: false,
      onProgress: (p) => console.log(`周六自动回测进度 ${p.current}/${p.total}｜${p.strategy}`),
    }).then(r => {
      if (r.success) console.log(`周六自动回测完成，已生成回测报告：${r.report.id}`);
      else console.log('周六自动回测未生成报告：', r.message);
    }).catch(e => console.error('周六自动回测失败：', e.message));
  }
});
