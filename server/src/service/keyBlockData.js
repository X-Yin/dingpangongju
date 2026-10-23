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

// 个股最近窗口区间涨幅（%）：(窗口内最高收盘价 − 窗口内最低收盘价) ÷ 最低收盘价 × 100；任一日缺 K 线返回 null
// 2026-10-17 用户要求：口径由「最高价/最低价」改为「收盘价」（取窗口内收盘价的最大值与最小值）
const stockWindowRangePct = (code, winDates) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length === 0) return null;
  let maxClose = null;
  let minClose = null;
  for (const d of winDates) {
    const dn = Number(d);
    const bar = bars.find(b => b.d === dn);
    if (!bar) return null;
    const c = bar.c != null ? Number(bar.c) : null;
    if (c == null || !Number.isFinite(c) || c <= 0) return null;
    if (maxClose == null || c > maxClose) maxClose = c;
    if (minClose == null || c < minClose) minClose = c;
  }
  if (maxClose == null || !(minClose > 0)) return null;
  return parseFloat((((maxClose - minClose) / minClose) * 100).toFixed(4));
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

// 上一交易日涨停个股数前 topN 板块的全部成分股；excludeBoards 可剔除指定板块名
//（如「其他」「并购重组」这类非主题/重组类板块，剔除后在剩余板块中顺延取前 topN）
// 返回 [{ code: 'shxxxxxx', name, board, lianbanCount }]（board = 所属板块名，lianbanCount = 该股在快照日（上一交易日）的连板数）
const getTopLianbanBoardStocks = (dateStr, topN = 1, excludeBoards = []) => {
  const data = readLianbanSnapshot(dateStr);
  if (!data || !Array.isArray(data.themes)) return [];
  const excluded = new Set((excludeBoards || []).map(String));
  // 先剔除被排除板块（快照里板块名为 theme.board），再按 count 降序（同 count 按 rank 升序）取前 topN
  const sorted = data.themes
    .filter(t => t && Array.isArray(t.stocks) && t.stocks.length > 0 && !excluded.has(String(t.board || t.name || '')))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (a.rank || 99) - (b.rank || 99));
  const top = sorted.slice(0, topN);
  const out = [];
  for (const theme of top) {
    for (const st of theme.stocks) {
      const code = st.marketCode || st.code;
      if (!code) continue;
      const lb = Number(st.lianbanCount);
      out.push({
        code,
        name: st.name || st.code || code,
        board: theme.board || theme.name || '',
        lianbanCount: Number.isFinite(lb) ? lb : null,
      });
    }
  }
  return out;
};

// 从 lianbanSnapshot 某日期中取当日所有 ≥minBoardCount 连板的个股（minBoardCount 默认 3）
// 返回 [{ code: 'shxxxxxx', name, lianbanCount, board, floatMarketValueYi }]
//   floatMarketValueYi = 当日快照流通市值（亿元，取自 quote.floatMarketValueYi）；缺失时为 null
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
        const rawFmv = st.quote ? Number(st.quote.floatMarketValueYi) : null;
        out.push({
          code,
          name: st.name || st.code || code,
          lianbanCount: cnt,
          board: theme.name || theme.board || '',
          floatMarketValueYi: Number.isFinite(rawFmv) && rawFmv > 0 ? rawFmv : null,
        });
      }
    }
  }
  return out;
};

// 给定回测日期 D，返回过去 lookbackDays 个交易日（严格不含当日 D）内出现过连板数 >= minBoardCount
// 的个股（去重合并；同 code 保留最大连板数及其命中日期）
// 返回 { stocks: [{ code: 'shxxxxxx', name, lianbanCount, board, date }], dates: ['YYYYMMDD'] }
const getRecentMultiLianbanStocks = async (dateStr, lookbackDays = 20, minBoardCount = 3) => {
  const dates = (await getPastTradingDates(dateStr, lookbackDays)).map(String);
  const map = new Map(); // code -> { code, name, lianbanCount, board, date }
  for (const d of dates) {
    const list = getMultiLianbanStocks(d, minBoardCount);
    for (const s of list) {
      const prev = map.get(s.code);
      if (prev && prev.lianbanCount >= s.lianbanCount) continue;
      map.set(s.code, { code: s.code, name: s.name, lianbanCount: s.lianbanCount, board: s.board, date: d });
    }
  }
  return { stocks: Array.from(map.values()), dates };
};

// 给定回测日期 D，返回过去 lookbackDays 个交易日（严格不含当日 D）内每一次出现的连板个股记录
// （不做 code 合并，同一只股票在不同快照日各返回一条；供「涨停/连板 + 后续涨幅」等多事件判定使用）
// 返回 { stocks: [{ code, name, lianbanCount, board, date, floatMarketValueYi }], dates: ['YYYYMMDD'] }
const getRecentMultiLianbanOccurrences = async (dateStr, lookbackDays = 20, minBoardCount = 2) => {
  const dates = (await getPastTradingDates(dateStr, lookbackDays)).map(String);
  const out = [];
  for (const d of dates) {
    const list = getMultiLianbanStocks(d, minBoardCount);
    for (const s of list) out.push({ ...s, date: d });
  }
  return { stocks: out, dates };
};

// 个股「放量比」：昨日成交量 v 相对「更前 3 个交易日日均量」的比值 (v_y − avg3) / avg3
// 数据不足（bars 缺失 / 更前 3 日量能缺失）返回 null
const stockVolumeRatio = (code, dateStr) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length < 4) return null;
  const d = Number(dateStr);
  let yIdx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].d < d) yIdx = i; else break; }
  if (yIdx < 3) return null; // 需昨日 + 更前 3 日共 4 根
  const yv = bars[yIdx].v;
  const prior = [bars[yIdx - 1].v, bars[yIdx - 2].v, bars[yIdx - 3].v];
  if (yv == null || prior.some(v => v == null || !(v > 0))) return null;
  const avg3 = prior.reduce((a, b) => a + b, 0) / 3;
  if (!(avg3 > 0)) return null;
  return parseFloat(((yv - avg3) / avg3).toFixed(6));
};

// 某交易日之前的 n 个交易日日均成交量（严格早于 dateNum；默认前 3 日）；数据不足返回 null
const stockPriorAvgVolume = (code, dateNum, n = 3) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length < n + 1) return null;
  const d = Number(dateNum);
  let idx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].d < d) idx = i; else break; }
  if (idx < n - 1) return null;
  let sum = 0;
  for (let k = idx - n + 1; k <= idx; k++) {
    const v = bars[k].v;
    if (v == null || !(v > 0)) return null;
    sum += v;
  }
  return sum / n;
};

// 某交易日「当日」放量比：(当日成交量 − 该日前 3 个交易日日均量) ÷ 该日前 3 个交易日日均量
// 与 extremeWinScores.volumeRatioAtDate 口径一致（同为日线 business_amount）；数据不足返回 null
const stockVolumeRatioAt = (code, dateNum) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length < 4) return null;
  const d = Number(dateNum);
  let idx = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].d === d) { idx = i; break; } if (bars[i].d > d) break; }
  if (idx < 3) return null;
  const cv = bars[idx].v;
  if (cv == null || !(cv > 0)) return null;
  const avg3 = stockPriorAvgVolume(code, d, 3);
  if (!(avg3 > 0)) return null;
  return parseFloat(((cv - avg3) / avg3).toFixed(6));
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

// ============================================================
// 龙头战法候选池（情绪游资-龙头战法，2026-10-11 用户新增；2026-10-11 二次改版为「板块口径」）
// 在回测日期 D，回溯过去 lookbackDays（默认 10）个交易日（严格不含当日 D，避免当日收盘前视）：
//   ① 找出这些日子里「涨停个股数 >= minCount（默认 20，即掀起涨停潮）」的板块（theme）；
//   ② 每个板块取其「窗口内最早一次涨停潮」那天作为该板块的**爆发日**（hotDate），并把爆发日当天的成分股作为该板块名册；
//   ③ 每只成分股以「爆发日收盘价」为基准（base）——引擎据此按「当前价 / base − 1」计算该股自板块爆发以来的涨幅；
//   ④ 引擎在买点触发时先选「板块内最优个股自爆发以来涨幅最高」的板块，再买该板块内涨幅最大者（已涨停则顺延第二，均涨停则次日 9:30）。
// 注意：基准价取自「个股日K」（getStockBars），而不用快照里的 quote.price——历史快照该字段在 20260817
//   之前全部为空（行情未落库），会导致取不到基准价、候选池恒为空、回测迟迟不成交。
// 返回 { dates, boards:[{board,hotDate,count,stocks:[{code,name,board,base,baseDate}]}], pool:[...扁平], hotBoards:[{board,date,count}] }
// excludeBoards：需整体剔除的板块名（如 芯片/通信/算力/其他），这些板块既不触发候选、其成分股也不计入候选池
// ============================================================
const getLeaderPool = async (dateStr, lookbackDays = 10, minCount = 20, excludeBoards = []) => {
  const dates = await getPastTradingDates(String(dateStr), lookbackDays);
  const excludeSet = new Set((excludeBoards || []).map(b => String(b).trim()));
  const hotBoards = [];
  const boardMap = new Map(); // board -> { board, hotDate, count, stocks:Map<code,name> }（仅保留最早一次爆发日）
  for (const d of dates) {
    const data = readLianbanSnapshot(String(d));
    const themes = (data && Array.isArray(data.themes)) ? data.themes : [];
    for (const theme of themes) {
      const board = String(theme?.board || theme?.name || '').trim();
      if (!board || excludeSet.has(board)) continue; // 指定板块整体剔除
      const cnt = Number(theme?.count);
      if (!Number.isFinite(cnt) || cnt < minCount) continue; // 未掀起涨停潮
      hotBoards.push({ board, date: String(d), count: cnt });
      if (boardMap.has(board)) continue; // 该板块已有更早的爆发日，名册与基准日以最早那次为准
      const stocks = new Map();
      for (const st of (theme?.stocks || [])) {
        const code = st?.marketCode || st?.code;
        if (!code) continue;
        stocks.set(code, st.name || code);
      }
      boardMap.set(board, { board, hotDate: String(d), count: cnt, stocks });
    }
  }
  const allCodes = new Set();
  for (const b of boardMap.values()) for (const c of b.stocks.keys()) allCodes.add(c);
  await ensureBarsForCodes(allCodes);
  const boards = [];
  const pool = [];
  for (const b of boardMap.values()) {
    const hotDateNum = Number(b.hotDate);
    const stocks = [];
    for (const [code, name] of b.stocks) {
      const bars = barsCache.get(code);
      if (!bars || bars.length === 0) continue;
      let c = null;
      for (const bar of bars) { if (bar.d === hotDateNum) { c = bar.c; break; } }
      if (c == null || !(c > 0)) continue;
      const item = { code, name, board: b.board, base: parseFloat(c.toFixed(4)), baseDate: b.hotDate };
      stocks.push(item);
      pool.push(item);
    }
    if (stocks.length > 0) boards.push({ board: b.board, hotDate: b.hotDate, count: b.count, stocks });
  }
  return { dates, boards, pool, hotBoards };
};

// ============================================================
// 买入门槛：个股最近 N 个交易日内是否出现过「放量」（放量分歧）
// 口径：某交易日成交量（bars.v = business_amount，单位股）≥ 前一交易日成交量 × (1 + ratioPct/100) 即视为该日放量。
// 叠加条件①：该放量日还须是「从放量之日开始往前回溯 peakLookbackDays 个交易日（含放量当日）」内量能最大的一天。
// 叠加条件②（2026-10-12 用户新增）：该放量日不得是该股的**首板或二板**——当日连板数须为 0（当日未涨停，属真分歧）
//   或 ≥ 3（已是高位龙头）；落在首板（连板数 1，启动首日）/ 二板（连板数 2）则视为启动初期、尚非龙头形态，
//   该放量日不能作为买入门槛，继续回溯窗口内其他放量日。
// 判定范围：严格早于 dateStr 的最近 days 个交易日（回测当日为盘中，当日成交量不完整，不计入）。
// 依赖该股日K已进入 barsCache（getLeaderPool 已对候选池预拉取 ensureBarsForCodes）。
// ============================================================
const LIMIT_UP_PCT = 9.5;                       // 日涨幅 ≥ 9.5% 视为涨停板（口径同 sentimentHotMoney 首板/二板判定）
const SURGE_EXCLUDE_BOARD_COUNTS = [1, 2];      // 放量分歧日须剔除的连板数：首板(1) / 二板(2)

// 个股某交易日（bars 下标 idx）当日连板数：自当日往前连续累计涨停日数（含当日）；当日非涨停返回 0
const boardCountAt = (bars, idx) => {
  let cnt = 0;
  for (let k = idx; k >= 1; k--) {
    const prevC = bars[k - 1] && bars[k - 1].c;
    const curC = bars[k] && bars[k].c;
    if (!prevC || prevC <= 0 || curC == null) break;
    if (((curC / prevC) - 1) * 100 < LIMIT_UP_PCT) break;
    cnt++;
  }
  return cnt;
};

const hasRecentVolumeSurge = (code, dateStr, days = 5, ratioPct = 30, peakLookbackDays = 10) => {
  const bars = barsCache.get(code);
  if (!bars || bars.length < 2) return false;
  const d = Number(dateStr);
  let end = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].d < d) end = i; else break;
  }
  if (end < 1) return false;
  const start = Math.max(1, end - days + 1);
  const factor = 1 + ratioPct / 100;
  for (let i = start; i <= end; i++) {
    const cur = bars[i].v;
    const prev = bars[i - 1] && bars[i - 1].v;
    if (cur == null || prev == null || prev <= 0 || cur < prev * factor) continue;
    // 额外要求①：该放量日须为「从放量之日起往前回溯 peakLookbackDays 个交易日（含当日）」内的量能最大之日
    const peakStart = Math.max(0, i - peakLookbackDays + 1);
    let peak = -Infinity;
    for (let j = peakStart; j <= i; j++) {
      const v = bars[j] && bars[j].v;
      if (v != null && v > peak) peak = v;
    }
    if (cur < peak) continue;
    // 额外要求②：该放量日不得是该股的首板 / 二板（连板数 1、2），否则该放量日不成立、继续回溯
    if (SURGE_EXCLUDE_BOARD_COUNTS.includes(boardCountAt(bars, i))) continue;
    return true;
  }
  return false;
};

module.exports = {
  getKeyBlockConstituents,
  getKeyBlockTagMap,
  ensureKeyBlockBars,
  ensureBarsForCodes,
  stockDailyChange,
  stockWindowGain,
  stockWindowRangePct,
  getStockCloseOnOrBefore,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getRecentMultiLianbanOccurrences,
  stockVolumeRatio,
  stockPriorAvgVolume,
  stockVolumeRatioAt,
  getHistoricalLianbanDefenseStocks,
  scanAllLianbanCodesInRange,
  getHongliMultiLianbanStocks,
  scanHongliMultiLianbanCodesInRange,
  getLeaderPool,
  hasRecentVolumeSurge,
  getTopLianbanBoardStocks,
};
