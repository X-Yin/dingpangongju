// 重点板块 5 分钟涨幅异动监控
//   - 依赖 pollBlockHistory 每分钟写入的 data/block_data_change_time.json（每条含 time:"HH:mm" 与各板块 avgChange）
//   - 在每个 5 分钟整数倍时刻（9:30 / 9:35 / 9:40 … 11:30、13:00 … 15:00），
//     取当前快照与 5 分钟前快照，逐板块计算 avgChange 差值；
//   - 差值 ≥ 1.5% 的板块通过 WebSocket 广播给前端弹窗提示（type: 'block_5min_surge'）
//   - 内存安全：每次计算即时读盘、用完即释放，仅保留一个「上一次已处理的 5min 桶」字符串状态，避免缓存泄漏
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const wsServer = require('../wsServer');
const { isTradingDay, isTradingHours } = require('../utils');
const { getBlockData } = require('./block');

const HISTORY_PATH = path.resolve(__dirname, '../data/block_data_change_time.json');
const SURGE_THRESHOLD = 1.5;            // 5 分钟涨幅阈值（%）
const CHECK_INTERVAL_MS = 20 * 1000;     // 每 20s 检查一次是否到达 5min 桶边界
const SNAPSHOT_TOLERANCE_MIN = 2;        // 5 分钟前快照的容差（分钟），允许数据有轻微漂移

let timer = null;
let started = false;
// 上一次已经处理过的 5 分钟桶（HHmm），防止同一桶内重复广播
let lastHandledBucket = null;

// 将板块成分股合并到 payload（用板块名索引 getBlockData，避免多次遍历）
const enrichBlocksWithStocks = (surgeBlockNames) => {
  const blockList = getBlockData();
  const map = new Map();
  for (let i = 0; i < blockList.length; i += 1) {
    map.set(blockList[i].blockName, blockList[i].data || []);
  }
  const result = surgeBlockNames.map((item) => ({
    ...item,
    stocks: map.get(item.blockName) || [],
  }));
  map.clear();
  return result;
};

// 读取板块分时历史（每次从磁盘重新读取，用完即释放，避免内存中持有大数组）
const readHistory = () => {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('[block5minSurge] 读取板块分时历史失败:', e.message);
    return [];
  }
};

// "HH:mm" → 当天分钟数
const timeToMinute = (hhmm) => {
  const parts = String(hhmm || '').split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
};

// 在历史快照中找到「最接近 targetMin 且在容差内」的那一条
const findSnapshotNear = (history, targetMin) => {
  let best = null;
  let bestDiff = Infinity;
  for (let i = 0; i < history.length; i += 1) {
    const snap = history[i];
    const min = timeToMinute(snap && snap.time);
    if (min < 0) continue;
    const diff = Math.abs(min - targetMin);
    if (diff <= SNAPSHOT_TOLERANCE_MIN && diff < bestDiff) {
      best = snap;
      bestDiff = diff;
    }
  }
  return best;
};

// 执行一次异动检查（仅在 5min 桶边界触发）
const checkSurge = () => {
  const now = new Date();
  // 非交易日 / 非交易时段不计算（午休 11:30-13:00 也跳过）
  if (!isTradingDay(now) || !isTradingHours(now)) return;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  // 只在 5 分钟整数倍分钟内触发
  if (nowMin % 5 !== 0) return;

  const bucketKey = dayjs(now).format('HHmm');
  if (lastHandledBucket === bucketKey) return; // 同一桶只处理一次
  lastHandledBucket = bucketKey;

  const history = readHistory();
  if (!history.length) return;

  const current = history[history.length - 1];
  const prevSnap = findSnapshotNear(history, nowMin - 5);
  if (!current || !prevSnap) return;

  const prevMap = new Map();
  (prevSnap.blockData || []).forEach((b) => {
    if (b && b.blockName != null) prevMap.set(b.blockName, Number(b.avgChange));
  });

  const surged = [];
  const curList = current.blockData || [];
  for (let i = 0; i < curList.length; i += 1) {
    const b = curList[i];
    if (!b || b.blockName == null) continue;
    const prev = prevMap.get(b.blockName);
    if (prev == null || !Number.isFinite(prev)) continue;
    const cur = Number(b.avgChange);
    if (!Number.isFinite(cur)) continue;
    const delta = cur - prev;
    if (delta >= SURGE_THRESHOLD) {
      surged.push({
        blockName: b.blockName,
        avgChange: +cur.toFixed(2),
        prevAvgChange: +prev.toFixed(2),
        change5min: +delta.toFixed(2),
      });
    }
  }

  // 用完即清理，避免闭包持有大对象
  prevMap.clear();

  if (surged.length === 0) return;

  // 按 5min 涨幅降序
  surged.sort((a, b2) => b2.change5min - a.change5min);
  // 合并最新成分股涨跌幅（板块名索引 getBlockData）
  const enriched = enrichBlocksWithStocks(surged);

  const payload = {
    type: 'block_5min_surge',
    ts: Date.now(),
    open: true,
    data: {
      time: current.time,
      prevTime: prevSnap.time,
      threshold: SURGE_THRESHOLD,
      blocks: enriched,
    },
  };

  wsServer.broadcast(payload);
  console.log(
    `[block5minSurge] ${dayjs(now).format('HH:mm')} 检测到 ${surged.length} 个板块 5min 涨幅 ≥ ${SURGE_THRESHOLD}%：` +
    surged.map((b) => `${b.blockName}(+${b.change5min}%)`).join('、')
  );
};

// 启动监控（幂等）
const start = () => {
  if (started) return;
  started = true;
  timer = setInterval(checkSurge, CHECK_INTERVAL_MS);
  console.log('[block5minSurge] 重点板块 5 分钟异动监控已启动');
};

// 停止监控并释放定时器
const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  lastHandledBucket = null;
};

// 调试 MOCK：模拟一次板块 5min 涨幅异动推送（走与实盘完全一致的 WS 链路）
//   - 从最新板块快照中随机挑若干个板块，构造 ≥ 1.5% 的 5min 涨幅
//   - payload 结构与实盘一致，仅多一个 mock:true 标记
const mockSurge = (count = 3) => {
  const history = readHistory();
  const current = history.length ? history[history.length - 1] : null;
  const pool = (current && current.blockData) || [];
  const n = Math.max(1, Math.min(Number(count) || 3, pool.length || 5));

  // 随机挑 n 个板块（不重复）
  const picked = [];
  const used = new Set();
  while (picked.length < n && picked.length < pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(pool[idx]);
  }

  const blocks = picked.map((b) => {
    const cur = Number(b && b.avgChange);
    const delta = +(SURGE_THRESHOLD + Math.random() * 3).toFixed(2);
    return {
      blockName: b.blockName,
      avgChange: Number.isFinite(cur) ? +cur.toFixed(2) : 0,
      prevAvgChange: Number.isFinite(cur) ? +(cur - delta).toFixed(2) : +(-delta).toFixed(2),
      change5min: delta,
    };
  });

  used.clear();

  // 合并成分股涨跌幅，让 MOCK payload 与实盘结构一致
  const enriched = enrichBlocksWithStocks(blocks);

  const payload = {
    type: 'block_5min_surge',
    ts: Date.now(),
    open: true,
    mock: true,
    data: {
      time: dayjs().format('HH:mm'),
      prevTime: dayjs().subtract(5, 'minute').format('HH:mm'),
      threshold: SURGE_THRESHOLD,
      blocks: enriched,
    },
  };

  wsServer.broadcast(payload);
  return { success: true, blocks: blocks.map((b) => b.blockName) };
};

module.exports = { start, stop, checkSurge, mockSurge, SURGE_THRESHOLD };
