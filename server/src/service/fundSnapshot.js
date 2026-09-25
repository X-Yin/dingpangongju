const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils/tradingDay');
const { getAmountHistory } = require('./amount');

const fundSnapshotDir = path.resolve(__dirname, '../data/fundSnapshot');
const amountSnapshotDir = path.resolve(__dirname, '../data/amountSnapshot');

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const parseMoneyValue = (val) => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  let str = String(val).replace('亿', '').replace('万', '');
  const sign = str.startsWith('-') ? -1 : 1;
  if (str.startsWith('+') || str.startsWith('-')) str = str.slice(1);
  let num = parseFloat(str) || 0;
  if (String(val).indexOf('万') !== -1) {
    num = num / 10000;
  }
  return sign * num;
};

const timeStrToMinutes = (timeStr) => {
  const h = parseInt(timeStr.substring(0, 2));
  const m = parseInt(timeStr.substring(2, 4));
  return h * 60 + m;
};

const minutesToTimeStr = (totalMin) => {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
};

const formatDisplayTime = (timeStr) => {
  return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
};

const aggregateByInterval = (data, intervalMinutes) => {
  if (!data || data.length === 0) return [];

  const sortedData = [...data].sort((a, b) => a[0].localeCompare(b[0]));

  const buckets = {};
  const tradingSlots = [];

  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;

  for (let t = morningStart; t <= morningEnd; t += intervalMinutes) {
    tradingSlots.push(t);
  }
  for (let t = afternoonStart; t <= afternoonEnd; t += intervalMinutes) {
    tradingSlots.push(t);
  }

  sortedData.forEach(([timeStr, item]) => {
    const totalMin = timeStrToMinutes(timeStr);
    let bucketMin = null;
    for (const slot of tradingSlots) {
      if (totalMin <= slot + intervalMinutes / 2) {
        bucketMin = slot;
        break;
      }
    }
    if (bucketMin === null && totalMin > tradingSlots[tradingSlots.length - 1]) {
      bucketMin = tradingSlots[tradingSlots.length - 1];
    }
    if (bucketMin !== null) {
      buckets[bucketMin] = { timeStr, item };
    }
  });

  const result = [];
  tradingSlots.forEach((slot) => {
    const entry = buckets[slot];
    const bucketTimeStr = minutesToTimeStr(slot);
    if (entry) {
      result.push({
        time: bucketTimeStr,
        displayTime: formatDisplayTime(bucketTimeStr),
        mainMoney: parseMoneyValue(entry.item.mainMoney),
        amountChangeDiff: parseMoneyValue(entry.item.amountChangeDiff),
        rawTime: entry.timeStr,
      });
    }
  });

  return result;
};

const saveDailySnapshots = () => {
  ensureDir(fundSnapshotDir);
  ensureDir(amountSnapshotDir);

  const history = getAmountHistory();
  if (!history || history.length === 0) {
    throw new Error('当日暂无主力资金数据，无法生成快照');
  }

  const today = dayjs().format('YYYYMMDD');

  const fund5min = aggregateByInterval(history, 5);
  const amount5min = aggregateByInterval(history, 5);

  const fundFile = path.join(fundSnapshotDir, `${today}.json`);
  fs.writeFileSync(fundFile, JSON.stringify(fund5min, null, 2));

  const amountFile = path.join(amountSnapshotDir, `${today}.json`);
  fs.writeFileSync(amountFile, JSON.stringify(amount5min, null, 2));

  console.log(`[fundSnapshot] 已保存 ${today} 快照: 主力资金5min ${fund5min.length}条, 成交量5min ${amount5min.length}条`);
  return { date: today, fund5min, amount5min };
};

const getAvailableDates = () => {
  ensureDir(fundSnapshotDir);
  const files = fs.readdirSync(fundSnapshotDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort((a, b) => b.localeCompare(a));
  return files;
};

const getFundSnapshot = (date) => {
  const file = path.join(fundSnapshotDir, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const getAmountSnapshot = (date) => {
  const file = path.join(amountSnapshotDir, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const getLatestSnapshotDate = () => {
  const dates = getAvailableDates();
  return dates.length > 0 ? dates[0] : null;
};

const getSnapshotData = (date) => {
  const fundData = getFundSnapshot(date);
  const amountData = getAmountSnapshot(date);
  if (!fundData && !amountData) return null;
  return { date, fund5min: fundData || [], amount10min: amountData || [] };
};

let snapshotScheduled = false;
let executedDates = new Set();

const scheduleDailySnapshot = (hour = 15, minute = 1) => {
  if (snapshotScheduled) return;
  snapshotScheduled = true;

  const task = () => {
    const now = dayjs();
    const today = now.format('YYYYMMDD');

    // 非交易日（周末/节假日，以交易日历为准）不执行
    if (!isTradingDay(now.toDate())) return;
    if (executedDates.has(today)) return;

    const targetTime = now.hour(hour).minute(minute).second(0).millisecond(0);
    if (!now.isAfter(targetTime)) return;

    console.log('[fundSnapshot] 收盘后自动保存快照开始...', now.format('YYYY-MM-DD HH:mm:ss'));
    try {
      const result = saveDailySnapshots();
      executedDates.add(today);
      console.log('[fundSnapshot] 快照保存完成:', result.date);
    } catch (e) {
      console.error('[fundSnapshot] 快照保存失败:', e.message);
    }
  };

  task();
  setInterval(task, 60 * 1000);
  console.log(`[fundSnapshot] 每日快照调度已启动，超过 ${hour}:${String(minute).padStart(2, '0')} 将自动保存`);
};

module.exports = {
  saveDailySnapshots,
  getAvailableDates,
  getFundSnapshot,
  getAmountSnapshot,
  getLatestSnapshotDate,
  getSnapshotData,
  scheduleDailySnapshot,
  aggregateByInterval,
};
