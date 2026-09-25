const { setConfig } = require('./config');
const { isTradingHours, isMiddayBreak, isAfterMarketClose, isTradingDay, getMsToNextTradingSession } = require('./utils');
const fs = require('fs');
const path = require('path');

const useCLS = process.argv.includes('--cls');
setConfig({ useCLS });
console.log(`数据源模式: ${useCLS ? '财联社(CLS)' : '同花顺(THS)'}`);

// --all 模式：任何时间都直接执行轮询逻辑，不卡交易时段（周末/午休/收盘均不拦截，也不自动退出）
const pollAll = process.argv.includes('--all');
if (pollAll) {
  console.log('poll-all 模式已开启：跳过交易时段限制，立即启动全部轮询');
}

const { pollDaPanData } = require('./service/dapan');
const { pollStockData } = require('./service/stock');
const { pollBlockData, pollBlockHistory, updateBlockMoneyDayHistory } = require('./service/block');
const { pollJingJiaQiangChouData, clearJingJiaQiangChouData } = require('./service/jingjiaqiangchou');
const { pollKaiPaiZhuDongData } = require('./service/kaipanzhudong');
const { pollRiHanData } = require('./service/rihan');
const { getAmountHistory, pollAmountInfo, scheduleAmountDayHistory } = require('./service/amount');
const { recordTechEmotionIntraday, scheduleTechEmotionIntraday5DayCache } = require('./service/emotion');
const { startMonitor } = require('./service/monitor');
const { pollStockPositionFundFlow } = require('./service/stockPosition');
const { pollDFCFBlockMoney, pollTimeDFCFBlockMoneyChange, scheduleBlockMoneyChangeDayHistory } = require('./service/blockMoney');
const { scheduleBlockDayHistory } = require('./service/block');
const { scheduleRiskScoreRecord } = require('./service/marketRiskScore');
const { pollResilienceMultiDay } = require('./service/stockDiagnose');
const { pollPremiumDiagnosis } = require('./service/premiumDiagnosis');
const { fetchZsxqTopics } = require('./service/jigouReports');
const { scheduleDailySnapshot } = require('./service/fundSnapshot');
const { startStrategyPolling } = require('./service/strategy');
const { startAttackDefensePolling } = require('./service/attackDefenseScore');
const { analyzeMonitorStocks } = require('./service/strongAndWeakStock');

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
};

let middayBreakNotified = false;
let afternoonResumeScheduled = false;

// 收盘后（15:01）自动执行的定时任务，每天只执行一次，非交易日（周末/节假日）不执行
const scheduleAfterCloseTasks = (hour = 15, minute = 1) => {
  let executedDates = new Set();

  const task = () => {
    const now = new Date();
    // 非交易日（周末/节假日，以交易日历为准）不执行
    if (!isTradingDay(now)) return;

    const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    if (executedDates.has(today)) return;

    const targetTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (now < targetTime) return;

    // 先标记今天已执行，避免异步执行期间重复触发
    executedDates.add(today);
    console.log(`开始执行 ${hour}:${String(minute).padStart(2, '0')} 收盘后定时任务...`);

    // 1. 更新板块资金日历史（对应 GET /update_block_money_day_history）
    updateBlockMoneyDayHistory()
      .then(() => console.log('收盘后板块资金日历史更新完成'))
      .catch(err => console.error('收盘后板块资金日历史更新失败:', err.message));

    // 2. 刷新市场情绪周期数据（对应 POST /refresh_market_emotion_cycle）
    analyzeMonitorStocks()
      .then(result => {
        fs.writeFileSync(path.join(__dirname, 'data/market_emotion_cycle.json'), JSON.stringify(result, null, 2));
        console.log('收盘后市场情绪周期数据刷新完成');
      })
      .catch(err => console.error('收盘后市场情绪周期数据刷新失败:', err.message));
  };

  task();
  setInterval(task, 60 * 1000);
  console.log(`收盘后定时任务已调度，超过 ${hour}:${String(minute).padStart(2, '0')} 且未执行时将自动执行`);
};

const checkMarketClose = () => {
  const now = new Date();
  if (!isTradingDay(now)) return false;
  return isAfterMarketClose(now);
};

const waitForNextSessionAndStart = () => {
  const ms = getMsToNextTradingSession();
  const now = new Date();
  const nextTime = new Date(now.getTime() + ms);
  console.log(`当前不在交易时段，将等待至 ${nextTime.toLocaleString('zh-CN')} 后启动轮询...`);
  
  setTimeout(() => {
    console.log('交易时段开始，准备启动轮询服务...');
    middayBreakNotified = false;
    afternoonResumeScheduled = false;
    startPolling();
  }, ms);
};

const startPolling = (force = false) => {
  const now = new Date();

  // force 模式（--all）：任何时间都直接执行轮询，跳过交易时段检查
  if (!force) {
    // 检查是否为非交易日（周末/节假日，以交易日历为准）
    if (!isTradingDay(now)) {
      console.log('今天是非交易日（周末/节假日），不启动轮询服务');
      waitForNextSessionAndStart();
      return;
    }

     // 检查是否已收盘
    if (isAfterMarketClose(now)) {
      console.log('今日已收盘，不启动轮询服务');
      waitForNextSessionAndStart();
      return;
    }

    // 检查是否在午休时段
    if (isMiddayBreak(now)) {
      console.log('当前处于午休时段(11:30-13:00)，不启动轮询服务');
      waitForNextSessionAndStart();
      return;
    }
  }

  console.log('轮询服务启动中...');

  // pollDaPanData(20000);

  pollStockData(10000);

  pollBlockData(60000);

  pollJingJiaQiangChouData(POLL_CONFIG.jingjiaqiangchou.hour, POLL_CONFIG.jingjiaqiangchou.minute);

  clearJingJiaQiangChouData(9, 30);

  // 开盘主动拉升的数据先注释掉，暂时没有对看盘起到很大的作用
  // pollKaiPaiZhuDongData({
  //   startHour: POLL_CONFIG.kaipanzhudong.startHour,
  //   startMinute: POLL_CONFIG.kaipanzhudong.startMinute,
  //   endHour: POLL_CONFIG.kaipanzhudong.endHour,
  //   endMinute: POLL_CONFIG.kaipanzhudong.endMinute
  // });

  pollRiHanData().catch(err => console.error('日韩指数抓取启动失败:', err));

  const hour = now.getHours();
  if (hour < 15) {
    pollDFCFBlockMoney(10000);

    pollTimeDFCFBlockMoneyChange();

    pollBlockHistory(60000);

    startMonitor();

    pollStockPositionFundFlow(60000);
  }

  // 9:45之前快速轮询主力资金，之后切换为慢速轮询
  // pollType: 'api'（新浪接口，9:45前1s/后3s） | 'browser'（新浪Puppeteer，9:45前3s/后10s） | 'dfcf_browser'（东方财富主力资金+新浪成交量，9:45前3s/后10s）
  const startAmountPolling = () => {
    const pollType = 'api';
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const beforeInterval = pollType === 'api' ? 1000 : 3000;
    const afterInterval = pollType === 'api' ? 3000 : 10000;
    if (h < 9 || (h === 9 && m < 45)) {
      pollAmountInfo(beforeInterval, pollType);
      const msTo945 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 45, 0, 0).getTime() - now.getTime();
      setTimeout(() => pollAmountInfo(afterInterval, pollType), msTo945);
    } else {
      pollAmountInfo(afterInterval, pollType);
    }
  };
  startAmountPolling();

  scheduleAmountDayHistory(15, 1);

  scheduleBlockMoneyChangeDayHistory(15, 1);

  scheduleBlockDayHistory(15, 1);

  scheduleRiskScoreRecord(15, 1);

  scheduleDailySnapshot(15, 1);

  scheduleTechEmotionIntraday5DayCache(15, 1);

  scheduleAfterCloseTasks(15, 1);

  // pollResilienceMultiDay();

  // pollPremiumDiagnosis();

  startStrategyPolling();

  setInterval(async () => {
    try {
      if (isTradingHours()) {
        await recordTechEmotionIntraday();
      }
    } catch (e) {
      console.error('记录科技情绪分时数据失败:', e.message);
    }
  }, 2 * 60 * 1000);
  console.log('科技情绪分时数据轮询已启动（每2分钟记录一次）');

  // fetchZsxqTopics().catch((err) => {
  //   console.error('知识星球抓取启动失败:', err);
  // });

  console.log('轮询服务已全部启动');

  // 定时检查：午休/收盘（--all 模式下不启用，保持持续轮询不退出）
  if (!force) {
    const closeCheckInterval = setInterval(() => {
    const currentNow = new Date();
    
    // 检查午休开始（11:30）
    if (isMiddayBreak(currentNow) && !middayBreakNotified) {
      middayBreakNotified = true;
      console.log('已到午休时间(11:30)，轮询将暂停，13:00后自动恢复');
      console.log('提示：建议使用 pm2 等进程管理器配合重启策略，或在13:00手动重启服务');
      
      // 设置13:00的恢复检查（如果进程还在运行）
      if (!afternoonResumeScheduled) {
        afternoonResumeScheduled = true;
        const msTo1300 = getMsToNextTradingSession();
        setTimeout(() => {
          console.log('午休结束，准备重新启动轮询服务...');
          // 退出进程，建议由外部进程管理器（如pm2）自动重启
          // 如果你希望不退出进程而是内部重启，可以取消注释下一行并修改逻辑
          process.exit(0);
        }, msTo1300);
      }
    }
    
    // 检查收盘
    if (checkMarketClose()) {
      console.log('已过下午3点，轮询服务自动停止');
      clearInterval(closeCheckInterval);
      process.exit(0);
    }
    }, 30000); // 每30秒检查一次
  }
};

// 启动入口：--all 模式任何时间直接启动，否则仅在交易时段启动
const entryNow = new Date();
if (pollAll || isTradingHours(entryNow)) {
  startPolling(pollAll);
} else {
  waitForNextSessionAndStart();
}
