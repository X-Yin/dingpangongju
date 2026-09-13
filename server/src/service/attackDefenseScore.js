// 开盘攻防分数动态计算服务
// 每 3s 采集一次数据快照，仅保留最近 3min 的快照窗口
// 基于窗口内的数据趋势动态计算当前应该进攻还是防守，以及对应分数（0-100）

const path = require('path');
const fs = require('fs');
const { filterUnNormalStockData } = require('./stock');
const { getLatestTechEmotion } = require('./emotion');
const { getBlockMoneyChangeList } = require('./blockMoney');

const amountPath = path.resolve(__dirname, '../data/amount.json');
const snapshotPath = path.resolve(__dirname, '../data/attack_defense_snapshots.json');

// 进攻板块：光通信、半导体概念、存储芯片；防守板块：银行、保险、创新药
const ATTACK_KEYWORDS = ['光通信', '半导体概念', '存储芯片'];
const DEFENSE_KEYWORDS = ['银行', '保险', '创新药'];

const POLL_INTERVAL = 3 * 1000; // 3s 采集间隔
const MAX_WINDOW_MS = 3 * 60 * 1000; // 3min 滑动窗口

// 快照缓存（内存 + 文件持久化）
let snapshots = [];
let pollTimer = null;

// 从文件加载快照
const loadSnapshots = () => {
  try {
    if (fs.existsSync(snapshotPath)) {
      const raw = fs.readFileSync(snapshotPath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        snapshots = data;
        console.log(`[攻防分数] 从文件加载 ${snapshots.length} 条快照`);
      }
    }
  } catch (e) {
    console.error('[攻防分数] 加载快照文件失败:', e.message);
  }
};

// 将快照保存到文件
const saveSnapshots = () => {
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshots), 'utf-8');
  } catch (e) {
    console.error('[攻防分数] 保存快照文件失败:', e.message);
  }
};

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

// 判断当前是否在交易时段内（9:15-11:30, 13:00-15:00，非周末）
const isMarketOpen = () => {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const timeVal = now.getHours() * 60 + now.getMinutes();
  return (timeVal >= 555 && timeVal < 690) || (timeVal >= 780 && timeVal < 900);
};

// 解析带单位的资金字符串为「亿」为单位的数值
const parseMoneyStr = (str) => {
  if (str === null || str === undefined) return 0;
  if (typeof str === 'number') return str;
  let s = String(str);
  const sign = s.startsWith('-') ? -1 : 1;
  if (s.startsWith('+') || s.startsWith('-')) s = s.slice(1);
  let num = parseFloat(s.replace(/亿|万/g, '')) || 0;
  if (String(str).indexOf('万') !== -1) num = num / 10000;
  return sign * num;
};

// 从 amount.json 读取最新的主力资金与成交量
const getLatestAmount = () => {
  try {
    const data = fs.existsSync(amountPath)
      ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]')
      : [];
    if (data.length === 0) return { mainMoney: 0, amountChangeDiff: 0 };
    const latest = data[data.length - 1][1];
    return {
      mainMoney: parseMoneyStr(latest.mainMoney),
      amountChangeDiff: parseMoneyStr(latest.amountChangeDiff),
    };
  } catch (e) {
    return { mainMoney: 0, amountChangeDiff: 0 };
  }
};

// 采集一次快照
const takeSnapshot = () => {
  const timestamp = Date.now();

  // 1. 资金净流入流出 + 成交量
  const { mainMoney, amountChangeDiff } = getLatestAmount();

  // 2. 开盘统计三个数据（拉升/下跌数、涨跌数、平均拉升/下跌）
  let surgeCount = 0, declineCount = 0, posCount = 0, negCount = 0;
  let surgeSum = 0, declineSum = 0;
  try {
    const stockList = filterUnNormalStockData();
    (stockList || []).forEach((item) => {
      const openPx = parseFloat(item.open_px);
      const closePx = parseFloat(item.close_px);
      const change = parseFloat(item.change);
      if (!Number.isFinite(openPx) || !Number.isFinite(closePx) || openPx <= 0) return;
      const curChange = Number.isFinite(change) ? change : 0;
      const prevClose = curChange !== 0 ? closePx / (1 + curChange / 100) : closePx;
      const openChange = prevClose > 0 ? ((openPx - prevClose) / prevClose) * 100 : 0;
      const changeDiff = curChange - openChange;
      if (changeDiff >= 0) { surgeCount++; surgeSum += changeDiff; }
      else { declineCount++; declineSum += changeDiff; }
      if (curChange > 0) posCount++;
      else if (curChange < 0) negCount++;
    });
  } catch (e) {
    // stockData.json 不存在时忽略
  }
  const avgSurge = surgeCount > 0 ? surgeSum / surgeCount : 0;
  const avgDecline = declineCount > 0 ? declineSum / declineCount : 0;

  // 3. 科技情绪
  let techEmotion = 0;
  try { techEmotion = getLatestTechEmotion() || 0; } catch (e) {}

  // 4. 进攻/防守板块资金
  let attackMoney = 0, defenseMoney = 0;
  try {
    const blockData = getBlockMoneyChangeList();
    (blockData || []).forEach((b) => {
      const money = b.money || 0;
      if (ATTACK_KEYWORDS.some((kw) => b.block.includes(kw))) attackMoney += money;
      else if (DEFENSE_KEYWORDS.some((kw) => b.block.includes(kw))) defenseMoney += money;
    });
  } catch (e) {}

  return {
    timestamp,
    mainMoney,
    amountChangeDiff,
    surgeCount,
    declineCount,
    posCount,
    negCount,
    avgSurge,
    avgDecline,
    techEmotion,
    attackMoney,
    defenseMoney,
  };
};

// 计算趋势斜率（值变化/秒）
const computeSlope = (latest, oldest, key) => {
  const dt = (latest.timestamp - oldest.timestamp) / 1000;
  if (dt <= 0) return 0;
  return (latest[key] - oldest[key]) / dt;
};

// 基于快照窗口动态计算攻防分数
// 返回 { mode, score, attackScore, defenseScore, components, snapshotCount, timestamp }
const calculateScore = (snaps) => {
  if (!snaps || snaps.length === 0) {
    return {
      mode: 'defense',
      score: 0,
      attackScore: 50,
      defenseScore: 50,
      components: {},
      snapshotCount: 0,
      timestamp: null,
    };
  }

  const latest = snaps[snaps.length - 1];
  const oldest = snaps[0];

  // ---- 1. 资金净流入流出（权重 25%）----
  // 当前值归一化：±10亿 → 0-100
  const mainMoneyNorm = clamp(50 + latest.mainMoney * 5, 0, 100);
  // 趋势归一化：斜率 ±0.83亿/s（约 50亿/min）→ 0-100
  const mainMoneySlope = computeSlope(latest, oldest, 'mainMoney');
  const mainMoneySlopeNorm = clamp(50 + mainMoneySlope * 60, 0, 100);
  const capitalScore = 0.6 * mainMoneyNorm + 0.4 * mainMoneySlopeNorm;

  // ---- 2. 成交量（权重 10%）----
  const volNorm = clamp(50 + latest.amountChangeDiff * 2, 0, 100);
  const volSlope = computeSlope(latest, oldest, 'amountChangeDiff');
  const volSlopeNorm = clamp(50 + volSlope * 60, 0, 100);
  const volumeScore = 0.5 * volNorm + 0.5 * volSlopeNorm;

  // ---- 3. 开盘统计三数据（权重 25%）----
  // 拉升/下跌比
  const totalStocks = latest.surgeCount + latest.declineCount;
  const surgeRatio = totalStocks > 0 ? latest.surgeCount / totalStocks : 0.5;
  // 涨/跌比
  const posTotal = latest.posCount + latest.negCount;
  const posRatio = posTotal > 0 ? latest.posCount / posTotal : 0.5;
  // 平均拉升 vs 平均下跌差值归一化（avgSurge 为正，avgDecline 为负）
  const avgDiffNorm = clamp(50 + (latest.avgSurge + latest.avgDecline) * 10, 0, 100);
  const openingScore = surgeRatio * 40 + posRatio * 30 + avgDiffNorm * 0.3;

  // ---- 4. 科技情绪（权重 25%）----
  const emotionNorm = clamp(50 + latest.techEmotion * 0.5, 0, 100);
  const emotionSlope = computeSlope(latest, oldest, 'techEmotion');
  const emotionSlopeNorm = clamp(50 + emotionSlope * 10, 0, 100);
  const emotionScore = 0.7 * emotionNorm + 0.3 * emotionSlopeNorm;

  // ---- 5. 进攻/防守板块资金（权重 15%）----
  const diffLatest = latest.attackMoney - latest.defenseMoney;
  const sectorNorm = clamp(50 + (diffLatest / 2e9) * 50, 0, 100);
  const diffOldest = oldest.attackMoney - oldest.defenseMoney;
  const diffTrend = diffLatest - diffOldest;
  const sectorSlopeNorm = clamp(50 + (diffTrend / 2e9) * 50, 0, 100);
  const sectorScore = 0.6 * sectorNorm + 0.4 * sectorSlopeNorm;

  // ---- 加权总分 ----
  const attackScore =
    0.25 * capitalScore +
    0.10 * volumeScore +
    0.25 * openingScore +
    0.25 * emotionScore +
    0.15 * sectorScore;

  const mode = attackScore >= 50 ? 'attack' : 'defense';
  const score = mode === 'attack' ? attackScore : 100 - attackScore;

  return {
    mode,
    score: parseFloat(score.toFixed(1)),
    attackScore: parseFloat(attackScore.toFixed(1)),
    defenseScore: parseFloat((100 - attackScore).toFixed(1)),
    components: {
      capital: parseFloat(capitalScore.toFixed(1)),
      volume: parseFloat(volumeScore.toFixed(1)),
      opening: parseFloat(openingScore.toFixed(1)),
      emotion: parseFloat(emotionScore.toFixed(1)),
      sector: parseFloat(sectorScore.toFixed(1)),
    },
    snapshotCount: snaps.length,
    timestamp: latest.timestamp,
  };
};

// 采集一次快照并存入缓存，清理过期数据，同步写入文件
const pollSnapshot = () => {
  const snap = takeSnapshot();
  snapshots.push(snap);
  const cutoff = Date.now() - MAX_WINDOW_MS;
  while (snapshots.length > 0 && snapshots[0].timestamp < cutoff) {
    snapshots.shift();
  }
  saveSnapshots();
};

// 启动轮询服务
const startAttackDefensePolling = (interval = POLL_INTERVAL) => {
  if (pollTimer) return;
  console.log(`[攻防分数] 轮询服务启动，间隔 ${interval / 1000}s，窗口 ${MAX_WINDOW_MS / 1000}s`);

  // 从文件加载历史快照（服务重启恢复）
  loadSnapshots();

  const task = () => {
    if (!isMarketOpen()) return;
    pollSnapshot();
  };

  task();
  pollTimer = setInterval(task, interval);
};

// 获取当前攻防分数
const getAttackDefenseScore = () => calculateScore(snapshots);

module.exports = {
  startAttackDefensePolling,
  getAttackDefenseScore,
  calculateScore,
  takeSnapshot,
};
