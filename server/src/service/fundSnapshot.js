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

// 与盯盘页 MainMoneyCharts.aggregateTo5Min 完全同口径的向前归属分桶：
// 原始点落入 [上一边界, 本边界) 窗口、取窗口内最后一条，标签从 9:35/13:05 开始（无 9:30/13:00 桶），
// 保证快照 5min 桶与盯盘页实时明细的 5min 桶完全一致
const aggregateByInterval = (data, intervalMinutes) => {
  if (!data || data.length === 0) return [];

  const sortedData = [...data].sort((a, b) => a[0].localeCompare(b[0]));

  const buckets = {};
  const tradingSlots = [];

  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;

  for (let t = morningStart + intervalMinutes; t <= morningEnd; t += intervalMinutes) {
    tradingSlots.push(t);
  }
  for (let t = afternoonStart + intervalMinutes; t <= afternoonEnd; t += intervalMinutes) {
    tradingSlots.push(t);
  }

  sortedData.forEach(([timeStr, item]) => {
    const totalMin = timeStrToMinutes(timeStr);
    let bucketMin = null;
    // 归属到「不小于该时间的下一个结束边界」对应的窗口：例如 9:35~9:39 计入标签 9:40
    for (const slot of tradingSlots) {
      if (totalMin < slot) {
        bucketMin = slot;
        break;
      }
    }
    if (bucketMin === null && tradingSlots.length > 0) {
      bucketMin = tradingSlots[tradingSlots.length - 1];
    }
    if (bucketMin !== null) {
      // 窗口内后点覆盖前点，取最后一条的累计净流入作为该窗口值；末值相对上一窗口的增量由展示端计算
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

// ===== 盘中实时快照兜底（2026-10-21 用户新增）=====
// 交易日当天收盘快照尚未落盘（15:01 定时归档）时，把今天也纳入回测范围并用实时数据：
// 用当日实时轮询的主力资金/成交量数据（getAmountHistory，与 saveDailySnapshots 同源同口径）
// 按完全相同的 5min 归属分桶聚合成「准快照」；收盘归档后文件存在，自动切回归档快照。
// 非交易日或当日暂无轮询数据时返回 null（调用方回退为「无快照」的既有兜底逻辑）。
// 30s 备忘缓存：一次回测会多处查询快照，避免重复读文件与聚合
let liveSnapCache = null; // { at, data: { fund5min, amount5min } | null }
const LIVE_SNAP_TTL_MS = 30 * 1000;
const getLiveSnapshot5min = () => {
  if (liveSnapCache && Date.now() - liveSnapCache.at < LIVE_SNAP_TTL_MS) return liveSnapCache.data;
  let data = null;
  try {
    const today = dayjs().format('YYYYMMDD');
    // 非交易日不提供实时快照（getAmountHistory 返回的是最近交易日的数据，不能误当成「今天」的）
    if (isTradingDay(new Date())) {
      const history = (getAmountHistory() || []).filter(i => i[1]?.date === today);
      if (history.length > 0) {
        data = { fund5min: aggregateByInterval(history, 5), amount5min: aggregateByInterval(history, 5) };
      }
    }
  } catch (e) {
    data = null;
  }
  liveSnapCache = { at: Date.now(), data };
  return data;
};

// 当日收盘快照是否已归档（供回测缓存新鲜度校验：归档前当日范围的结果随盘中行情持续变化）
const hasArchivedSnapshot = (date) => fs.existsSync(path.join(fundSnapshotDir, `${date}.json`));

const getFundSnapshot = (date) => {
  const file = path.join(fundSnapshotDir, `${date}.json`);
  if (!fs.existsSync(file)) {
    // 交易日盘中：今天的收盘快照尚未生成 → 回退为当日实时聚合数据
    if (date === dayjs().format('YYYYMMDD')) {
      const live = getLiveSnapshot5min();
      if (live) return live.fund5min;
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const getAmountSnapshot = (date) => {
  const file = path.join(amountSnapshotDir, `${date}.json`);
  if (!fs.existsSync(file)) {
    // 交易日盘中：今天的收盘快照尚未生成 → 回退为当日实时聚合数据
    if (date === dayjs().format('YYYYMMDD')) {
      const live = getLiveSnapshot5min();
      if (live) return live.amount5min;
    }
    return null;
  }
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
  hasArchivedSnapshot,
  getLiveSnapshot5min,
};
