// 引入 express
const express = require('express');
const cors = require('cors');
const { filterUnNormalDaPanData, pollDaPanData, getAllDaPanData } = require('./service/dapan');
const { filterUnNormalStockData, pollStockData, getSingleStockData, getSingleStockTlineData, getAllStockData } = require('./service/stock');
const { getBlockData, pollBlockData, getTopAndBottomBlockData } = require('./service/block');
// const { diagnose } = require('./service/diagnose');
const { getJingJiaQiangChouData, pollJingJiaQiangChouData } = require('./service/jingjiaqiangchou');
const { pollKaiPaiZhuDongData, getKaiPanZhuDongData } = require('./service/kaipanzhudong');

const POLL_CONFIG = {
  kaipanzhudong: {
    startHour: 9,
    startMinute: 30,
    endHour: 9,
    endMinute: 35
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
  res.json({
    unNormalDaPanData,
    unNormalStockList,
    topAndBottomBlockData,
    allStockData,
    jingJiaQiangChouData,
    kaiPanZhuDongData
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


// 启动服务
app.listen(port, () => {
  // 大盘数据 20s 轮训一次
  pollDaPanData(20000);
  // 个股数据 10s 轮询一次
  pollStockData(10000);
  // 板块数据 1min 轮询
  pollBlockData(60000);
  // 竞价抢筹数据轮询服务
  pollJingJiaQiangChouData(POLL_CONFIG.jingjiaqiangchou.hour, POLL_CONFIG.jingjiaqiangchou.minute);
  // 开盘主动拉升轮询服务
  pollKaiPaiZhuDongData({ 
    startHour: POLL_CONFIG.kaipanzhudong.startHour,
    startMinute: POLL_CONFIG.kaipanzhudong.startMinute,
    endHour: POLL_CONFIG.kaipanzhudong.endHour,
    endMinute: POLL_CONFIG.kaipanzhudong.endMinute
  });
  console.log(`服务运行在 http://localhost:${port}`);
});


