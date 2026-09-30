// ============================================================
// 重点板块回测数据层（重点板块-N日最高涨幅系列策略专用）
// 板块成分来自 blockConfig（constant/block_code.js 重点板块配置，剔除 __block_placeholder__ 占位条目）；
// 板块/个股日涨幅在回测时从成分股日K线现算：个股日涨幅 = 相邻收盘价环比，板块日涨幅 = 成分股当日涨幅均值，
// 不使用服务端任何板块级涨幅历史缓存；个股日K走 sentimentHotMoney.getStockBars（data/kline_cache 每日自动重拉）
// ============================================================
const fs = require('fs');
const path = require('path');
const { getBlocksConfig } = require('./blockConfig');
const { getStockBars } = require('./sentimentHotMoney');
const { batchParallel } = require('../utils');

const blockCodePath = path.resolve(__dirname, '../constant/block_code.js');

// blockName -> [{ code: 'shxxxxxx', name }]（保持配置顺序；剔除占位条目；按配置文件 mtime 缓存）
let constituentsCache = null; // { mtimeMs, map }
const getKeyBlockConstituents = () => {
  try {
    const mtimeMs = fs.statSync(blockCodePath).mtimeMs;
    if (constituentsCache && constituentsCache.mtimeMs === mtimeMs) return constituentsCache.map;
    const list = getBlocksConfig() || [];
    const map = new Map();
    for (const item of list) {
      if (!item || !item.blockName || !item.code || item.code === '__block_placeholder__') continue;
      const arr = map.get(item.blockName) || [];
      arr.push({ code: item.code, name: item.name || item.code });
      map.set(item.blockName, arr);
    }
    constituentsCache = { mtimeMs, map };
    return map;
  } catch (e) {
    console.error('读取重点板块配置失败:', e.message);
    return constituentsCache ? constituentsCache.map : new Map();
  }
};

// 个股日K收盘序列进程内缓存：code(完整 shxxxxxx) -> [{ d, c }]（d=YYYYMMDD 数字升序）；拉取失败/无数据存 null 防反复重试
const barsCache = new Map();

// 预拉取全部重点板块成分股日K（回测启动时调用一次，避免逐桶逐日阻塞；并发 8）
const ensureKeyBlockBars = async () => {
  const blocks = getKeyBlockConstituents();
  const codes = new Set();
  for (const members of blocks.values()) {
    for (const m of members) codes.add(m.code);
  }
  let fetched = 0;
  await batchParallel(Array.from(codes), async (code) => {
    if (barsCache.has(code)) return;
    try {
      // getStockBars 入参为 6 位纯代码
      const bars = await getStockBars(code.replace(/^(sh|sz|bj)/i, ''));
      barsCache.set(code, bars && bars.length > 0 ? bars : null);
      if (bars && bars.length > 0) fetched++;
    } catch (e) {
      barsCache.set(code, null); // 拉取失败：该股不参与板块涨幅均值
    }
  }, 8);
  return { total: codes.size, fetched };
};

// 个股某交易日日涨幅（%）：相邻收盘价环比现算；当日无K线或无前收盘返回 null
const stockDailyChange = (code, dateStr) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length < 2) return null;
  const d = Number(dateStr);
  const idx = bars.findIndex(b => b.d === d);
  if (idx <= 0) return null;
  const prev = bars[idx - 1].c;
  if (!prev || prev <= 0) return null;
  return parseFloat((((bars[idx].c - prev) / prev) * 100).toFixed(4));
};

// 个股最近窗口累计涨幅（%）：各日涨幅求和；任一日缺失返回 null（与 computeWindowGain 缺失即无效口径一致）
const stockWindowGain = (code, winDates) => {
  let sum = 0;
  for (const d of winDates) {
    const chg = stockDailyChange(code, d);
    if (chg == null || !Number.isFinite(chg)) return null;
    sum += chg;
  }
  return parseFloat(sum.toFixed(4));
};

// blockName -> tag（进攻/中性/防御；取该板块任一带 tag 条目；未打 tag 的板块不出现在 Map 中）
let tagCache = null; // { mtimeMs, map }
const getKeyBlockTagMap = () => {
  try {
    const mtimeMs = fs.statSync(blockCodePath).mtimeMs;
    if (tagCache && tagCache.mtimeMs === mtimeMs) return tagCache.map;
    const list = getBlocksConfig() || [];
    const map = new Map();
    for (const item of list) {
      if (!item || !item.blockName || !item.tag) continue;
      if (!map.has(item.blockName)) map.set(item.blockName, item.tag);
    }
    tagCache = { mtimeMs, map };
    return map;
  } catch (e) {
    console.error('读取重点板块 tag 失败:', e.message);
    return tagCache ? tagCache.map : new Map();
  }
};

// 个股截至某交易日的最近收盘价（期末持仓估值兜底用，回放数据无该股时）：barsCache 中 d <= date 的最后一根收盘价
const getStockCloseOnOrBefore = (code, dateStr) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length === 0) return null;
  const d = Number(dateStr);
  let close = null;
  for (const b of bars) {
    if (b.d > d) break;
    if (b.c != null && b.c > 0) close = b.c;
  }
  return close;
};

module.exports = {
  getKeyBlockConstituents,
  getKeyBlockTagMap,
  ensureKeyBlockBars,
  stockDailyChange,
  stockWindowGain,
  getStockCloseOnOrBefore,
};
