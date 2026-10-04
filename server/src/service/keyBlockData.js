// ============================================================
// 重点板块回测数据层（重点板块-N日最高涨幅系列策略专用）
// 板块成分来自 blockConfig（constant/block_code.js 重点板块配置，剔除 __block_placeholder__ 占位条目）；
// 板块/个股日涨幅在回测时从成分股日K线现算：个股日涨幅 = 相邻收盘价环比，板块日涨幅 = 成分股当日涨幅均值，
// 不使用服务端任何板块级涨幅历史缓存；个股日K走 sentimentHotMoney.getStockBars（data/kline_cache 每日自动重拉）
// ============================================================
const fs = require('fs');
const path = require('path');
const { getBlocksConfig } = require('./blockConfig');
const { getStockBars, loadIndexKline } = require('./sentimentHotMoney');
const { batchParallel } = require('../utils');

const blockCodePath = path.resolve(__dirname, '../constant/block_code.js');
const lianbanSnapshotDir = path.resolve(__dirname, '../data/lianbanSnapshot');

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

// 预拉取指定 codes（shxxxxxx 完整格式）日K到 barsCache；并发 8；已缓存的跳过，拉取失败存 null
const ensureBarsForCodes = async (codeSet) => {
  const codes = Array.from(codeSet).filter(c => !barsCache.has(c));
  if (codes.length === 0) return { total: 0, fetched: 0 };
  let fetched = 0;
  await batchParallel(codes, async (code) => {
    try {
      const bars = await getStockBars(code.replace(/^(sh|sz|bj)/i, ''));
      barsCache.set(code, bars && bars.length > 0 ? bars : null);
      if (bars && bars.length > 0) fetched++;
    } catch (e) {
      barsCache.set(code, null);
    }
  }, 8);
  return { total: codes.length, fetched };
};

// 预拉取全部重点板块成分股日K（回测启动时调用一次，避免逐桶逐日阻塞；并发 8）
const ensureKeyBlockBars = async (extraCodes) => {
  const blocks = getKeyBlockConstituents();
  const codes = new Set();
  for (const members of blocks.values()) {
    for (const m of members) codes.add(m.code);
  }
  if (extraCodes) for (const c of extraCodes) codes.add(c);
  const r = await ensureBarsForCodes(codes);
  return r;
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

// ============================================================
// 历史涨停板块候选股（防御池扩展）
// 在回测日期 D 往前 lookbackDays 个交易日中，找出创业板当日收盘日涨幅 < cybThresholdPct（默认 -1%）的每一天，
// 从这些天的 lianbanSnapshot 中取涨停数 Top-N（默认 3）板块的所有股票，去重后作为防御候选池的补充。
// 用途：防御买点时，在本地防御+中性 tag 板块成分股之外，再加上这些情绪冰点日的热门涨停板块股，
//       一起做 n 日涨幅最大筛选。
// ============================================================

// lianbanSnapshot 按日期的文件读取缓存：dateStr -> { themes: [...] }
const lianbanSnapshotCache = new Map();
const readLianbanSnapshot = (dateStr) => {
  if (lianbanSnapshotCache.has(dateStr)) return lianbanSnapshotCache.get(dateStr);
  const file = path.join(lianbanSnapshotDir, `${dateStr}.json`);
  let data = null;
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      data = JSON.parse(raw);
    }
  } catch (e) { /* 读取失败返回 null */ }
  lianbanSnapshotCache.set(dateStr, data);
  return data;
};

// 创业板日K缓存（进程内，首次调用后常驻）
let cybKlineCache = null;
const ensureCybKline = async () => {
  if (cybKlineCache) return cybKlineCache;
  cybKlineCache = await loadIndexKline('cyb_kline.json', '399006', '32', 500);
  return cybKlineCache;
};

// 给定回测日期 D，返回往前 lookbackDays 个交易日（严格不含当日 D）的完整日期列表
// dateStr: 'YYYYMMDD'；返回升序的 YYYYMMDD 数字数组
const getPastTradingDates = async (dateStr, lookbackDays = 20) => {
  const kline = await ensureCybKline();
  if (!kline || kline.length < 2) return [];
  const d = Number(dateStr);
  let endIdx = -1;
  for (let i = 0; i < kline.length; i++) {
    if (kline[i].trade_date >= d) break;
    endIdx = i;
  }
  if (endIdx < 0) return [];
  const startIdx = Math.max(0, endIdx - lookbackDays + 1);
  const result = [];
  for (let i = startIdx; i <= endIdx; i++) result.push(kline[i].trade_date);
  return result;
};

// 给定回测日期 D，返回往前 lookbackDays 个交易日（严格不含当日 D）中创业板日涨幅 < thresholdPct 的日期列表
// dateStr: 'YYYYMMDD'；返回升序的 YYYYMMDD 数字数组
const getCybDownDays = async (dateStr, lookbackDays = 20, thresholdPct = -1) => {
  const kline = await ensureCybKline();
  if (!kline || kline.length < 2) return [];
  const d = Number(dateStr);
  // kline 升序，找到 < d 的最后一根下标（严格不含当日 D，避免盘中买点泄露当日收盘信息）
  let endIdx = -1;
  for (let i = 0; i < kline.length; i++) {
    if (kline[i].trade_date >= d) break;
    endIdx = i;
  }
  if (endIdx < 1) return [];
  // 往前取 lookbackDays 个交易日（含 endIdx 当天）
  const startIdx = Math.max(1, endIdx - lookbackDays + 1);
  const result = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const prev = kline[i - 1].close_px;
    const cur = kline[i].close_px;
    if (!prev || prev <= 0 || !cur) continue;
    const pct = ((cur - prev) / prev) * 100;
    if (pct < thresholdPct) result.push(kline[i].trade_date);
  }
  return result;
};

// 从 lianbanSnapshot 某日期中取涨停数 topN 板块的所有股票
// 返回 [{ code: 'shxxxxxx', name }]
const getTopLianbanBoardStocks = (dateStr, topN = 1) => {
  const data = readLianbanSnapshot(dateStr);
  if (!data || !Array.isArray(data.themes)) return [];
  // 按 count 降序（同 count 按 rank 升序）
  const sorted = data.themes
    .filter(t => t && Array.isArray(t.stocks) && t.stocks.length > 0)
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (a.rank || 99) - (b.rank || 99));
  const top = sorted.slice(0, topN);
  const out = [];
  for (const theme of top) {
    for (const st of theme.stocks) {
      const code = st.marketCode || st.code;
      if (!code) continue;
      out.push({ code, name: st.name || st.code || code });
    }
  }
  return out;
};

// 从 lianbanSnapshot 某日期中取当日所有 ≥minBoardCount 连板的个股（minBoardCount 默认 3）
// 返回 [{ code: 'shxxxxxx', name, lianbanCount, board }]
const getMultiLianbanStocks = (dateStr, minBoardCount = 3) => {
  const data = readLianbanSnapshot(dateStr);
  if (!data || !Array.isArray(data.themes)) return [];
  const out = [];
  for (const theme of data.themes) {
    for (const st of theme.stocks || []) {
      const cnt = parseInt(st.lianbanCount, 10);
      if (Number.isFinite(cnt) && cnt >= minBoardCount) {
        const code = st.marketCode || st.code;
        if (!code) continue;
        out.push({
          code,
          name: st.name || st.code || code,
          lianbanCount: cnt,
          board: theme.name || theme.board || '',
        });
      }
    }
  }
  return out;
};

// ============================================================
// 红利板块连板候选股（逆周期情绪游资防御池扩展）
// 2026-10-04 用户口径（修订版）：在回测日期 D 往前 lookbackDays（默认 20）个交易日内，
//   收集所有属红利板块名单（resource/hongliName.json，主题 board 精确匹配）的板块中、
//   出现过连板数 >= minBoardCount（默认 3，即三板及以上）的个股，去重。
//   不要求红利板块进入当日涨停家数 TopN —— 凡近 20 日内走出过三板及以上的红利板块个股均纳入。
// 用途：逆周期情绪游资防御买点时，在「防御+中性」tag 板块成分股之外，再加上近期红利强势板块里的连板股，
//       一起做 n 日涨幅最大筛选。
// ============================================================
const hongliNamePath = path.join(lianbanSnapshotDir, 'resource/hongliName.json');
let hongliNameCache = null; // Set<string>
const getHongliNameSet = () => {
  if (hongliNameCache) return hongliNameCache;
  let set = new Set();
  try {
    const list = JSON.parse(fs.readFileSync(hongliNamePath, 'utf-8'));
    if (Array.isArray(list)) set = new Set(list.map(n => String(n).trim()).filter(Boolean));
  } catch (e) {
    console.warn(`红利板块名单读取失败: ${hongliNamePath}`);
  }
  hongliNameCache = set;
  return set;
};

// 给定回测日期 D，返回红利板块连板候选股
// 返回 { stocks: [{ code: 'shxxxxxx', name, board, lianbanCount }], boards: 命中的红利板块名数组, dates: 参与扫描的交易日 }
const getHongliMultiLianbanStocks = async (dateStr, lookbackDays = 20, minBoardCount = 3) => {
  const hongliSet = getHongliNameSet();
  const dates = await getPastTradingDates(dateStr, lookbackDays);
  const stocks = new Map(); // code -> { code, name, board, lianbanCount }
  const boards = new Set(); // 近 lookbackDays 天走出过 >= minBoardCount 连板的红利板块
  for (const d of dates) {
    const data = readLianbanSnapshot(String(d));
    const themes = (data && Array.isArray(data.themes)) ? data.themes : [];
    for (const theme of themes) {
      const board = String(theme.board || '').trim();
      if (!hongliSet.has(board)) continue;
      for (const st of (theme.stocks || [])) {
        const cnt = parseInt(st.lianbanCount, 10);
        if (!Number.isFinite(cnt) || cnt < minBoardCount) continue;
        const code = st.marketCode || st.code;
        if (!code) continue;
        boards.add(board);
        if (stocks.has(code)) continue;
        stocks.set(code, { code, name: st.name || st.code || code, board, lianbanCount: cnt });
      }
    }
  }
  return { stocks: Array.from(stocks.values()), boards: Array.from(boards), dates: dates.map(String) };
};

// 预扫描整个回测日期范围，收集红利板块连板候选股代码（用于一次性预拉 bars）
// rangeDates: 回测日期数组 [YYYYMMDD]；返回 Set<code>
const scanHongliMultiLianbanCodesInRange = async (rangeDates, lookbackDays = 20, minBoardCount = 3) => {
  const all = new Set();
  for (const dateStr of rangeDates) {
    const { stocks } = await getHongliMultiLianbanStocks(dateStr, lookbackDays, minBoardCount);
    for (const s of stocks) all.add(s.code);
  }
  return all;
};

// 主入口（新版）：给定回测日期，往前 lookbackDays 个交易日内的科技情绪冰点日
// → 取这些天涨停数 TopN 板块中的全部股票，**再与** lookbackDays 内所有交易日出现过 ≥minBoardCount 连板的个股**做交集**
// → 得到候选股扩展集（同时满足"曾被市场抱团 Top 板块" + "曾走出过连板强度"两个条件）
// getCybDownDays 口径：创业板指当日收盘跌幅 < thresholdPct（默认 -1%，近似科技情绪冰点）
const getHistoricalLianbanDefenseStocks = async (dateStr, lookbackDays = 20, topN = 3, thresholdPct = -1, minBoardCount = 3) => {
  const downDays = await getCybDownDays(dateStr, lookbackDays, thresholdPct);

  // 集合 A：冰点日涨停数 TopN 板块中的所有股票 code
  const topBoardCodes = new Set();
  for (const d of downDays) {
    const stocks = getTopLianbanBoardStocks(String(d), topN);
    for (const s of stocks) topBoardCodes.add(s.code);
  }

  // 集合 B：lookbackDays 内所有交易日中出现过 ≥minBoardCount 连板的个股 code
  const multiCodes = new Set();
  const lookbackAllDates = await getPastTradingDates(dateStr, lookbackDays);
  for (const d of lookbackAllDates) {
    const multi = getMultiLianbanStocks(String(d), minBoardCount);
    for (const s of multi) multiCodes.add(s.code);
  }

  // A ∩ B：同时在 Top 板块出现过、又走出过连板
  // 用 lookbackAllDates 扫一遍拿交集里的 name（取最新一次命中时的 name 即可）
  const intersect = new Set();
  const seenNames = new Map(); // code -> { name } 去重存一次

  // 用 getTopLianbanBoardStocks 的完整对象做 name 查找
  for (const d of downDays) {
    const stocks = getTopLianbanBoardStocks(String(d), topN);
    for (const s of stocks) {
      if (topBoardCodes.has(s.code) && multiCodes.has(s.code)) {
        intersect.add(s.code);
        if (!seenNames.has(s.code)) seenNames.set(s.code, s.name);
      }
    }
  }

  const result = [];
  for (const code of intersect) {
    result.push({ code, name: seenNames.get(code) || code });
  }

  return {
    stocks: result,
    downDays: downDays.map(d => String(d)),
    topBoardCodes: topBoardCodes.size,
    multiCodes: multiCodes.size,
  };
};

// 预扫描整个回测日期范围，收集所有可能用到的 lianban 候选股代码（用于一次性预拉 bars）
// rangeDates: 回测日期数组 [YYYYMMDD]；返回 Set<code>
const scanAllLianbanCodesInRange = async (rangeDates, lookbackDays = 20, topN = 3, thresholdPct = -1, minBoardCount = 3) => {
  const all = new Set();
  for (const dateStr of rangeDates) {
    const { stocks } = await getHistoricalLianbanDefenseStocks(dateStr, lookbackDays, topN, thresholdPct, minBoardCount);
    for (const s of stocks) all.add(s.code);
  }
  return all;
};

module.exports = {
  getKeyBlockConstituents,
  getKeyBlockTagMap,
  ensureKeyBlockBars,
  ensureBarsForCodes,
  stockDailyChange,
  stockWindowGain,
  getStockCloseOnOrBefore,
  getHistoricalLianbanDefenseStocks,
  scanAllLianbanCodesInRange,
  getHongliMultiLianbanStocks,
  scanHongliMultiLianbanCodesInRange,
};
