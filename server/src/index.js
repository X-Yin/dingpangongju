// 引入 express
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { filterUnNormalDaPanData, pollDaPanData, getAllDaPanData } = require('./service/dapan');
const { filterUnNormalStockData, pollStockData, getSingleStockData, getSingleStockTlineData, getAllStockData, getJiSuYiDongRankData } = require('./service/stock');
const { getBlockData, pollBlockData, getTopAndBottomBlockData, getCurrentDayHotBlock, getBlockHistory, pollBlockHistory, getBlockDayHistory, updateBlockDayHistory, getBlockMoneyDayHistory, updateBlockMoneyDayHistory } = require('./service/block');
// const { diagnose } = require('./service/diagnose');
const { getJingJiaQiangChouData, pollJingJiaQiangChouData, clearJingJiaQiangChouData } = require('./service/jingjiaqiangchou');
const { pollKaiPaiZhuDongData, getKaiPanZhuDongData } = require('./service/kaipanzhudong');
const { pollKaiPanXiaCuoData, getKaiPanXiaCuoData } = require('./service/kaipanxiacuo');
const { getAmountHistory, pollAmountInfo } = require('./service/amount');
const { getAllEmotionData, getAllIndexKlineData, updateCurrentEmotionData, updateCurrentTechIndexData, getAllTechIndexData } = require('./service/emotion');
const { getMainProblem, writeMainProblem, updateMainProblemSeq, delMainProblem, updatePersonalSugg } = require('./service/mainProblem');
const { getOpRecord, updateOpRecord } = require('./service/opRecord');
const { updateMainLine, getMainLine } = require('./service/marketMainLine');
const { getTimelineData, updateTimelineEvent, deleteTimelineEvent } = require('./service/timeline');
const { getMarketRhythmData, updateMarketRhythmItem } = require('./service/marketRhythm');
const { getRecentOperationData, updateRecentOperationItem } = require('./service/recentOperation');
const { getLongTermRhythmData, updateLongTermRhythmItem, getAllProjects, createProject, updateProject, deleteProject } = require('./service/longTermRhythm');
const { 
  getResearchReports, 
  getResearchReportById,
  createResearchReport, 
  updateResearchReport, 
  deleteResearchReport,
  moveResearchReport,
  pinResearchReport
} = require('./service/researchReport');
const { pollDFCFBlockMoney, getBlockMoneyChangeList, pollTimeDFCFBlockMoneyChange, getBlockMoneyChangeTimeList } = require('./service/blockMoney');
const { getStockPositionMainFund, addStockPosition, deleteStockPosition, diff2DayStockTline } = require('./service/stockPosition');

const POLL_CONFIG = {
  kaipanzhudong: {
    startHour: 9,
    startMinute: 30,
    endHour: 9,
    endMinute: 40
  },
  kaipanxiacuo: {
    startHour: 9,
    startMinute: 30,
    endHour: 9,
    endMinute: 40
  },
  jingjiaqiangchou: {
    hour: 9,
    minute: 24
  },
}

// 创建实例
const app = express();

// 设置跨域
app.use(cors({
  origin: '*', // 对所有来源开放跨域访问
  optionsSuccessStatus: 200 // 一些旧浏览器（IE11，各种 SmartTV）在 204 时会窒息
}));

// 解析 JSON 请求体
app.use(express.json());

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

// 返回需要告警的数据
app.get('/notice_data', async (req, res) => {
  const unNormalDaPanData = filterUnNormalDaPanData();
  const unNormalStockList = filterUnNormalStockData();
  const topAndBottomBlockData = getTopAndBottomBlockData();
  const allStockData = getAllStockData();
  const jingJiaQiangChouData = await getJingJiaQiangChouData();
  const kaiPanZhuDongData = getKaiPanZhuDongData();
  const kaiPanXiaCuoData = getKaiPanXiaCuoData();
  res.json({
    unNormalDaPanData,
    unNormalStockList,
    topAndBottomBlockData,
    allStockData,
    jingJiaQiangChouData,
    kaiPanZhuDongData,
    kaiPanXiaCuoData
  });
});

// 返回板块数据
app.get('/block', (req, res) => {
  const blockData = getBlockData();
  res.json(blockData);
});

// 返回单个股票数据，解析 req 中的 code, limit 参数
app.get('/stock_data', async (req, res) => {
  const code = req.query.code;
  const limit = Number(req.query.limit) || 100;
  const stockData = await getSingleStockData(code, limit);
  res.json(stockData);
});

app.get('/stock_tline_data', async (req, res) => {
  const code = req.query.code;
  const stockTlineData = await getSingleStockTlineData(code);
  res.json(stockTlineData);
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

app.get('/amount_history', async (req, res) => {
  const amountHistory = await getAmountHistory();
  res.json(amountHistory);
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
  await updateCurrentEmotionData();
  await updateCurrentTechIndexData();
  res.json({ message: '情绪数据更新成功' });
});

app.get('/jisuyidong_rank', async (req, res) => {
  const jisuyidongRankData = getJiSuYiDongRankData();
  res.json(jisuyidongRankData);
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
  console.log('>> person sugg', globalSuggContent, tempSuggContent);
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

app.get('/diff2_day_stock_tline', async (req, res) => {
  try {
    const result = await diff2DayStockTline();
    res.json(result);
  } catch (error) {
    console.error('获取数据失败:', error);
    res.status(500).json({ message: '获取数据失败' });
  }
});

// 启动服务
app.listen(port, () => {
  const disablePolling = process.argv.includes('--no-poll');

  if (!disablePolling) {
    // 大盘数据 20s 轮训一次
    pollDaPanData(20000);
    // 个股数据 10s 轮询一次
    pollStockData(10000);
    // 板块数据 1min 轮询
    pollBlockData(60000);
    // 竞价抢筹数据轮询服务
    pollJingJiaQiangChouData(POLL_CONFIG.jingjiaqiangchou.hour, POLL_CONFIG.jingjiaqiangchou.minute);
    // 竞价抢筹数据 9:30 自动清理
    clearJingJiaQiangChouData(9, 30);
    // 开盘主动拉升轮询服务
    pollKaiPaiZhuDongData({ 
      startHour: POLL_CONFIG.kaipanzhudong.startHour,
      startMinute: POLL_CONFIG.kaipanzhudong.startMinute,
      endHour: POLL_CONFIG.kaipanzhudong.endHour,
      endMinute: POLL_CONFIG.kaipanzhudong.endMinute
    });
    // 开盘持续下挫轮询服务
    pollKaiPanXiaCuoData({
      startHour: POLL_CONFIG.kaipanxiacuo.startHour,
      startMinute: POLL_CONFIG.kaipanxiacuo.startMinute,
      endHour: POLL_CONFIG.kaipanxiacuo.endHour,
      endMinute: POLL_CONFIG.kaipanxiacuo.endMinute
    });
    // 轮询成交量信息
    pollAmountInfo(10000);
    // 轮询板块数据历史记录
    pollBlockHistory(60000);
    // 轮询各个板块的资金流入流出情况
    pollDFCFBlockMoney(10000);
    // 轮询各个板块的资金分时情况
    pollTimeDFCFBlockMoneyChange(300000);
  }
  console.log(`服务运行在 http://localhost:${port}`);
});
