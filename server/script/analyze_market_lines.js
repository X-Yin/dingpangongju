// 市场主线/支线阶段分析脚本
// 用途：分析指定区间内每个情绪阶段的 市场主线/支线，并输出自包含 HTML 可视化报告
// 数据源：
//   1) src/data/lianbanSnapshot/*.json       涨停题材快照（情绪温度/题材涨停家数/连板高度/龙头股）
//   2) src/data/block_data_day_history.json  重点板块每日均涨幅（前端 key_blocks「板块分类分析」的底层数据）
// 主线/支线判定：
//   - 阶段划分：对情绪温度做 3 日平滑后做 zigzag 摆动检测（振幅阈值 18、最短阶段 3 个交易日）
//   - 题材端主线：阶段内涨停家数 + 连板高度 + 持续天数综合得分最高的题材；次高者为支线
//   - 板块端主线：阶段内累计涨幅 + 上涨天数占比 + 排名靠前天数综合得分最高的板块；次高者为支线
//   - 红利防御类板块（resource/hongliName.json）单独标注为「防御线」，不参与主线竞争
// 用法：
//   node script/analyze_market_lines.js                     默认区间 20260701 ~ 20260830
//   node script/analyze_market_lines.js --start 20260701 --end 20260830
// 输出：script/market_lines_<start>_<end>.html（同级目录，自包含单文件，无外部依赖）
const fs = require('fs');
const path = require('path');

// ==================== 参数 ====================
const parseArgs = (argv) => {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--start') args.start = argv[++i];
    else if (argv[i] === '--end') args.end = argv[++i];
  }
  return args;
};
const args = parseArgs(process.argv);
const START = args.start || '20260701';
const END = args.end || '20260830';

const DATA_DIR = path.join(__dirname, '../src/data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'lianbanSnapshot');
const OUT_FILE = path.join(__dirname, `market_lines_${START}_${END}.html`);

const fmtDate = (d) => `${String(d).slice(4, 6)}/${String(d).slice(6, 8)}`;

// ==================== 1. 数据加载 ====================
function loadLianbanDays() {
  const days = [];
  for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
    if (!/^2026\d{4}\.json$/.test(f)) continue;
    const date = f.replace('.json', '');
    if (date < START || date > END) continue;
    const d = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, f), 'utf8'));
    const stocks = (d.themes || []).flatMap(t => t.stocks || []);
    days.push({
      date,
      temperature: d.sentiment?.temperature ?? 0,
      phaseLabel: d.sentiment?.phase || '',
      totalCount: d.summary?.totalCount || 0,
      lianbanCount: d.summary?.lianbanCount || 0,
      firstBoardCount: d.summary?.firstBoardCount || 0,
      leaderCount: d.summary?.leaderCount || 0,
      maxLianban: stocks.reduce((m, s) => Math.max(m, s.lianbanCount || 0), 0),
      themes: (d.themes || []).map(t => ({
        board: t.board,
        count: t.count || 0,
        stocks: (t.stocks || []).map(s => ({
          name: s.name, marketCode: s.marketCode || s.code || '',
          lianbanCount: s.lianbanCount || 0,
          lianbanText: s.lianbanText || '', leader: !!s.leader,
          concept: s.concept || '',
        })),
      })),
    });
  }
  days.sort((a, b) => a.date - b.date);
  return days;
}

function loadBlockDays() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'block_data_day_history.json'), 'utf8'));
  // 截断异常值：avgChange 为板块成分股均涨幅，物理上限约 ±20%（涨跌停），超过视为坏数据（如停牌复牌异常）
  const clamp = v => Math.max(-20, Math.min(20, v));
  return raw
    .filter(d => d.date >= START && d.date <= END)
    .sort((a, b) => a.date - b.date)
    .map(d => ({
      date: d.date,
      sectors: Object.fromEntries(
        Object.entries(d.blocks || {}).map(([name, v]) => [name, clamp(v.avgChange ?? 0)])
      ),
    }));
}

// 红利防御类名称集合（精确匹配 + 互为子串匹配）
function loadHongliNames() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'resource/hongliName.json'), 'utf8'));
    return new Set(list);
  } catch {
    return new Set();
  }
}
const isHongliName = (set, name) => {
  if (set.has(name)) return true;
  for (const h of set) {
    if (h.length >= 2 && (name.includes(h) || h.includes(name))) return true;
  }
  return false;
};

// ==================== 2. 情绪阶段划分（zigzag 摆动检测） ====================
function segmentPhases(days, { threshold = 18, minLength = 3 } = {}) {
  const n = days.length;
  if (n === 0) return [];
  const temps = days.map(d => d.temperature);
  // 3 日中心平滑
  const sm = temps.map((_, i) => {
    const a = temps[Math.max(0, i - 1)], b = temps[i], c = temps[Math.min(n - 1, i + 1)];
    return (a + b + c) / 3;
  });
  // zigzag：找振幅超过 threshold 的摆动极值点
  const pivots = [];
  let dir = 0; // 0 未定方向, 1 上, -1 下
  let minIdx = 0, maxIdx = 0, extIdx = 0;
  for (let i = 1; i < n; i++) {
    if (dir === 0) {
      if (sm[i] > sm[maxIdx]) maxIdx = i;
      if (sm[i] < sm[minIdx]) minIdx = i;
      if (sm[maxIdx] - sm[i] >= threshold) { pivots.push(maxIdx); dir = -1; extIdx = i; }
      else if (sm[i] - sm[minIdx] >= threshold) { pivots.push(minIdx); dir = 1; extIdx = i; }
    } else if (dir === 1) {
      if (sm[i] > sm[extIdx]) extIdx = i;
      else if (sm[extIdx] - sm[i] >= threshold) { pivots.push(extIdx); dir = -1; extIdx = i; }
    } else {
      if (sm[i] < sm[extIdx]) extIdx = i;
      else if (sm[i] - sm[extIdx] >= threshold) { pivots.push(extIdx); dir = 1; extIdx = i; }
    }
  }
  // 去重 + 排序，边界点去相邻过近的
  const uniq = [];
  for (const p of pivots) {
    if (!uniq.length || p - uniq[uniq.length - 1] >= 2) uniq.push(p);
  }
  // 构建阶段：阶段 k = (p_k, p_{k+1}]，拐点日归入走向它的阶段
  const bounds = [0, ...uniq, n - 1];
  let raw = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const s = k === 0 ? bounds[0] : bounds[k] + 1;
    const e = bounds[k + 1];
    if (e >= s) raw.push([s, e]);
  }
  // 合并过短的阶段（并入相邻更长的一侧）
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && seg[1] - seg[0] + 1 < minLength) prev[1] = seg[1];
    else merged.push([...seg]);
  }
  return merged.map(([s, e], idx) => {
    const seg = days.slice(s, e + 1);
    const avgTemp = seg.reduce((t, d) => t + d.temperature, 0) / seg.length;
    const firstTemp = seg[0].temperature, lastTemp = seg[seg.length - 1].temperature;
    const rising = lastTemp >= firstTemp;
    let name;
    if (avgTemp >= 75) name = seg.length <= 2 ? '冲高见顶' : (rising ? '高潮主升' : '高潮赶顶');
    else if (avgTemp >= 55) name = rising ? '升温拉升' : '高位震荡';
    else if (avgTemp >= 35) name = '震荡分化';
    else if (avgTemp >= 15) name = rising ? '修复回暖' : '退潮降温';
    else name = '情绪冰点';
    return {
      index: idx + 1,
      startDate: seg[0].date,
      endDate: seg[seg.length - 1].date,
      days: seg.length,
      dayIndexes: Array.from({ length: e - s + 1 }, (_, i) => s + i),
      avgTemp: +avgTemp.toFixed(0),
      maxTemp: Math.max(...seg.map(d => d.temperature)),
      minTemp: Math.min(...seg.map(d => d.temperature)),
      rising,
      name,
    };
  });
}

// ==================== 3. 题材端聚合（连板快照） ====================
function aggregateLianbanThemes(segDays, hongliSet) {
  const map = new Map();
  let phaseTotal = 0, phaseMaxLb = 0;
  for (const d of segDays) {
    phaseTotal += d.totalCount;
    phaseMaxLb = Math.max(phaseMaxLb, d.maxLianban);
    for (const t of d.themes) {
      const item = map.get(t.board) || { board: t.board, total: 0, days: 0, maxLb: 0, leader: null, hongli: isHongliName(hongliSet, t.board) };
      item.total += t.count;
      item.days += 1;
      for (const s of t.stocks) {
        if (s.lianbanCount > (item.leader?.lianbanCount || 0) || (item.leader && s.lianbanCount === item.leader.lianbanCount && s.leader && !item.leader.leader)) {
          if (!item.leader || s.lianbanCount > item.leader.lianbanCount || (s.leader && s.lianbanCount === item.leader.lianbanCount)) {
            item.leader = s;
          }
        }
        item.maxLb = Math.max(item.maxLb, s.lianbanCount);
      }
      map.set(t.board, item);
    }
  }
  // 得分 = 涨停家数 + 连板高度*6 + 出现天数*2.5
  const ranked = [...map.values()]
    .map(t => ({ ...t, score: t.total + t.maxLb * 6 + t.days * 2.5 }))
    .sort((a, b) => b.score - a.score);
  const attack = ranked.filter(t => !t.hongli);
  const hongli = ranked.filter(t => t.hongli && t.total >= 5);
  const top = attack[0];
  const mains = top ? attack.filter(t => t.score >= top.score * 0.55).slice(0, 2) : [];
  const sides = attack.filter(t => !mains.includes(t) && t.total >= Math.max(6, (top?.total || 0) * 0.12)).slice(0, 4);
  const fmt = t => t && ({
    name: t.board, total: t.total, maxLb: t.maxLb, days: t.days,
    share: phaseTotal ? +(t.total / phaseTotal * 100).toFixed(1) : 0,
    leader: t.leader ? { name: t.leader.name, text: t.leader.lianbanText, concept: (t.leader.concept || '').slice(0, 16) } : null,
    score: +t.score.toFixed(1),
  });
  return {
    phaseTotalLimitUp: phaseTotal,
    maxLianban: phaseMaxLb,
    main: mains.map(fmt),
    side: sides.map(fmt),
    hongli: hongli.slice(0, 3).map(fmt),
    all: ranked.slice(0, 12).map(fmt),
  };
}

// ==================== 4. 板块端聚合（板块日历史） ====================
function aggregateBlockSectors(segDays, allBlockDays, hongliSet) {
  // 先算全市场每日排名，用于「排名靠前天数」
  const rankByDate = new Map();
  for (const d of allBlockDays) {
    const entries = Object.entries(d.sectors).sort((a, b) => b[1] - a[1]);
    rankByDate.set(d.date, new Map(entries.map(([name], i) => [name, i + 1])));
  }
  const map = new Map();
  for (const d of segDays) {
    const ranks = rankByDate.get(d.date);
    const nSectors = ranks.size;
    for (const [name, ch] of Object.entries(d.sectors)) {
      const item = map.get(name) || { name, cum: 0, upDays: 0, topDays: 0, presence: 0, hongli: isHongliName(hongliSet, name) };
      item.presence += 1;
      item.cum += ch;
      if (ch > 0) item.upDays += 1;
      if ((ranks.get(name) || nSectors) <= Math.max(1, nSectors * 0.3)) item.topDays += 1;
      map.set(name, item);
    }
  }
  const dayCount = segDays.length;
  const ranked = [...map.values()]
    .map(s => {
      const avgCh = s.cum / Math.max(1, s.presence);
      const upRatio = s.upDays / Math.max(1, s.presence);
      return { ...s, avgCh: +avgCh.toFixed(2), upRatio: +upRatio.toFixed(2), cum: +s.cum.toFixed(1), score: +(s.cum + upRatio * 6 + s.topDays * 1.2).toFixed(1) };
    })
    .sort((a, b) => b.score - a.score);
  const attack = ranked.filter(s => !s.hongli);
  const hongli = ranked.filter(s => s.hongli && s.cum > 0.5);
  // 主线要求：在场天数 >= 40% 阶段天数（避免中途新加入/偶尔出现的板块误判），且累计涨幅为正、上涨天数占比 >= 40%
  const mains = attack.filter(s => s.presence >= dayCount * 0.4 && s.cum > 1 && s.upRatio >= 0.4).slice(0, 2);
  const mainNames = new Set(mains.map(s => s.name));
  const sides = attack.filter(s => !mainNames.has(s.name) && s.cum > 0.5).slice(0, 4);
  const fmt = s => ({
    name: s.name, cum: s.cum, avgCh: s.avgCh, upRatio: s.upRatio,
    upDays: s.upDays, presence: s.presence, days: dayCount, topDays: s.topDays, score: s.score,
  });
  return { main: mains.map(fmt), side: sides.map(fmt), hongli: hongli.slice(0, 3).map(fmt), all: ranked.slice(0, 12).map(fmt) };
}

// ==================== 4.5 上证指数 3 日线斜率窗口分析（收盘口径） ====================
const KLINE_DIR = path.join(DATA_DIR, 'kline_cache');
// 题材排除（用户指定）：算力/芯片/通信/并购重组/其他（子串匹配，覆盖「算力(液冷)」等变体）
const THEME_EXCLUDE_KEYWORDS = ['算力', '芯片', '通信', '并购重组', '其他'];
// 科技板块排除关键词（小写子串匹配）：AI 链/半导体/算力硬件材料/机器人/商业航天等
const TECH_SECTOR_KEYWORDS = [
  'ai', '半导体', '芯片', 'cpu', 'cpo', 'mpo', '光模块', '光芯片', '光纤', '光通信',
  '存储', 'pcb', 'ccl', 'mlcc', '先进封装', '功率半导体', '超节点', '液冷', '玻璃基板',
  '电子布', '铜箔', 'ppe树脂', '北美缺电', '机器人', '商业航天', '算力', '消费电子', '元器件', '端侧',
];
const isThemeExcluded = (board) => THEME_EXCLUDE_KEYWORDS.some(k => board.includes(k));
const isTechSector = (name) => {
  const s = String(name).toLowerCase();
  return TECH_SECTOR_KEYWORDS.some(k => s.includes(k));
};

// 窗口内题材排名（剔除指定题材），返回按得分排序的完整列表
function rankThemesExcluded(segDays) {
  const map = new Map();
  for (const d of segDays) {
    for (const t of d.themes) {
      if (isThemeExcluded(t.board)) continue;
      const item = map.get(t.board) || { board: t.board, total: 0, days: 0, maxLb: 0, leader: null };
      item.total += t.count;
      item.days += 1;
      for (const s of t.stocks) {
        if (!item.leader || s.lianbanCount > item.leader.lianbanCount
          || (s.leader && s.lianbanCount === item.leader.lianbanCount)) item.leader = s;
        item.maxLb = Math.max(item.maxLb, s.lianbanCount);
      }
      map.set(t.board, item);
    }
  }
  const ranked = [...map.values()]
    .map(t => ({ ...t, score: t.total + t.maxLb * 6 + t.days * 2.5 }))
    .sort((a, b) => b.score - a.score);
  const total = ranked.reduce((s, t) => s + t.total, 0) || 1;
  return ranked.map(t => ({
    name: t.board, total: t.total, maxLb: t.maxLb, days: t.days,
    share: +(t.total / total * 100).toFixed(1),
    leader: t.leader ? { name: t.leader.name, text: t.leader.lianbanText } : null,
  }));
}

// 窗口内板块累计涨幅排名（剔除科技板块）
function rankSectorsExcluded(segBlockDays) {
  const map = new Map();
  for (const d of segBlockDays) {
    for (const [name, ch] of Object.entries(d.sectors)) {
      if (isTechSector(name)) continue;
      const item = map.get(name) || { name, cum: 0, upDays: 0, presence: 0 };
      item.presence += 1;
      item.cum += ch;
      if (ch > 0) item.upDays += 1;
      map.set(name, item);
    }
  }
  return [...map.values()]
    .map(s => ({ name: s.name, cum: +s.cum.toFixed(1), upDays: s.upDays, presence: s.presence }))
    .sort((a, b) => b.cum - a.cum);
}

// 个股窗口涨幅（kline_cache 现算）：close(窗口末日) / close(窗口首日前一交易日) - 1；无前收盘则用窗口内首日收盘
function stockWindowGainFromCache(marketCode, T, E) {
  const file = path.join(KLINE_DIR, `${marketCode}.json`);
  if (!fs.existsSync(file)) return null;
  let bars;
  try {
    bars = JSON.parse(fs.readFileSync(file, 'utf8')).kline || [];
  } catch {
    return null;
  }
  const asc = bars
    .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
    .map(k => ({ d: Number(k.trade_date), c: Number(k.close_px) }))
    .sort((a, b) => a.d - b.d);
  let base = null, end = null;
  for (const b of asc) {
    if (b.d < T) base = b;
    if (b.d <= E) end = b; else break;
  }
  if (!end) return null;
  let basis = '';
  if (!base) {
    base = asc.find(b => b.d >= T && b.d <= E);
    basis = '首日起算';
  }
  if (!base || end.d <= base.d) return null;
  return { gain: +((end.c / base.c - 1) * 100).toFixed(1), basis };
}

// 主流程：上证指数 sh000001 收盘口径 MA3 斜率窗口 + 每窗口题材/板块/个股冠军
async function analyzeIndexWindows(allLianbanDays, allBlockDays) {
  const { loadIndexKline } = require('../src/service/sentimentHotMoney');
  const kline = await loadIndexKline('sh_kline.json', '1A0001', '16', 150);
  const bars = (kline || [])
    .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
    .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
  if (bars.length < 10) throw new Error('上证指数日K数据不足');
  const dates = bars.map(k => Number(k.trade_date));
  const closes = bars.map(k => Number(k.close_px));
  const avgLast = (i, n) => closes.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  const slopeOf = new Map(); // date -> { slope, ma3, close }
  for (let i = 3; i < closes.length; i++) {
    slopeOf.set(dates[i], {
      slope: +(avgLast(i, 3) - avgLast(i - 1, 3)).toFixed(4),
      ma3: +avgLast(i, 3).toFixed(2),
      close: closes[i],
    });
  }
  const daily = dates.filter(d => d >= Number(START) && d <= Number(END))
    .map(d => ({ date: d, ...(slopeOf.get(d) || {}) }));
  // 正斜率窗口：slope 由负转正当日开窗，由正转负前一日收盘
  const windows = [];
  let cur = null;
  for (const row of daily) {
    if (row.slope > 0) {
      if (!cur) cur = { startDate: row.date, endDate: row.date, days: 0 };
      cur.endDate = row.date;
      cur.days += 1;
    } else if (cur) {
      cur.turnDownDate = row.date;
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) { cur.turnDownDate = null; windows.push(cur); } // 区间末仍为正斜率

  const lianbanByDate = new Map(allLianbanDays.map(d => [d.date, d]));
  const blockByDateMap = new Map(allBlockDays.map(d => [d.date, d]));
  const results = [];
  for (const w of windows) {
    const T = Number(w.startDate), E = Number(w.endDate);
    let prevClose = null;
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] < T) prevClose = closes[i]; else break;
    }
    const endClose = slopeOf.get(E)?.close;
    const indexGain = prevClose && endClose ? +((endClose / prevClose - 1) * 100).toFixed(2) : null;
    const lianbanSeg = [], blockSeg = [];
    for (let d = T; d <= E; d++) {
      const l = lianbanByDate.get(String(d)); if (l) lianbanSeg.push(l);
      const b = blockByDateMap.get(String(d)); if (b) blockSeg.push(b);
    }
    const themeTop = rankThemesExcluded(lianbanSeg).slice(0, 3);
    const sectorTop = rankSectorsExcluded(blockSeg).slice(0, 3);
    // 最大涨幅个股：候选 = 题材冠军的涨停股 ∪ 板块冠军名命中（board 子串）的涨停股
    const blockWinner = sectorTop[0]?.name || '';
    const themeWinner = themeTop[0]?.name || '';
    const cand = new Map();
    for (const d of lianbanSeg) {
      for (const t of d.themes) {
        const hitTheme = t.board === themeWinner;
        const hitBlock = blockWinner.length >= 2 && t.board.includes(blockWinner);
        if (!hitTheme && !hitBlock) continue;
        for (const s of t.stocks) {
          const key = s.marketCode || s.code;
          if (!key) continue;
          const prevItem = cand.get(key);
          if (!prevItem || (s.lianbanCount || 0) >= (prevItem.lianbanCount || 0)) {
            cand.set(key, {
              code: key, name: s.name, board: t.board,
              lianbanText: s.lianbanText || '', lianbanCount: s.lianbanCount || 0,
            });
          }
        }
      }
    }
    let stockNoKline = 0;
    const stockRanked = [];
    for (const c of cand.values()) {
      const g = stockWindowGainFromCache(c.code, T, E);
      if (!g) { stockNoKline++; continue; }
      stockRanked.push({ ...c, gain: g.gain, basis: g.basis });
    }
    stockRanked.sort((a, b) => b.gain - a.gain);
    results.push({
      startDate: w.startDate, endDate: w.endDate, turnDownDate: w.turnDownDate,
      openEnded: w.turnDownDate == null,
      clippedStart: w.startDate === daily[0]?.date,
      days: w.days, indexGain,
      themeTop, sectors: sectorTop,
      stockTop: stockRanked.slice(0, 3),
      candidates: cand.size, stockNoKline,
    });
  }
  return { daily, windows: results };
}

// ==================== 5. 执行分析 ====================
const allDays = loadLianbanDays();
const blockDays = loadBlockDays();
const blockByDate = new Map(blockDays.map(d => [d.date, d]));
const hongliSet = loadHongliNames();
const phases = segmentPhases(allDays);

const report = {
  start: START, end: END,
  tradingDays: allDays.length,
  avgTemp: +(allDays.reduce((t, d) => t + d.temperature, 0) / (allDays.length || 1)).toFixed(0),
  maxLianban: allDays.reduce((m, d) => Math.max(m, d.maxLianban), 0),
  totalLimitUp: allDays.reduce((t, d) => t + d.totalCount, 0),
  phases: phases.map(p => {
    const segDays = p.dayIndexes.map(i => allDays[i]);
    const blockSegDays = segDays.map(d => blockByDate.get(d.date)).filter(Boolean);
    return {
      ...p,
      stats: {
        avgLimitUp: +(segDays.reduce((t, d) => t + d.totalCount, 0) / p.days).toFixed(0),
        avgLianbanCount: +(segDays.reduce((t, d) => t + d.lianbanCount, 0) / p.days).toFixed(1),
        maxLianban: segDays.reduce((m, d) => Math.max(m, d.maxLianban), 0),
      },
      lianban: aggregateLianbanThemes(segDays, hongliSet),
      blocks: aggregateBlockSectors(blockSegDays, blockDays, hongliSet),
      temperature: p.dayIndexes.map(i => allDays[i].temperature),
    };
  }),
};

// ==================== 6. 控制台摘要 ====================
console.log(`\n===== 主线/支线阶段分析 ${fmtDate(START)} ~ ${fmtDate(END)}（${allDays.length} 个交易日，共 ${report.totalLimitUp} 家涨停，最高 ${report.maxLianban} 连板）=====\n`);
for (const p of report.phases) {
  console.log(`【阶段${p.index}】${fmtDate(p.startDate)} ~ ${fmtDate(p.endDate)}（${p.days}天）${p.name} · 平均温度${p.avgTemp}`);
  console.log(`  题材主线: ${p.lianban.main.map(t => `${t.name}(涨停${t.total}/最高${t.maxLb}板${t.leader ? `/龙头${t.leader.name}` : ''})`).join('、') || '无'}`);
  console.log(`  题材支线: ${p.lianban.side.map(t => `${t.name}(涨停${t.total}/最高${t.maxLb}板)`).join('、') || '无'}`);
  console.log(`  板块主线: ${p.blocks.main.map(s => `${s.name}(累计+${s.cum}%)`).join('、') || '无'}`);
  console.log(`  板块支线: ${p.blocks.side.map(s => `${s.name}(累计+${s.cum}%)`).join('、') || '无'}`);
  if (p.blocks.hongli.length) console.log(`  防御线: ${p.blocks.hongli.map(s => `${s.name}(+${s.cum}%)`).join('、')}`);
  console.log('');
}

// ==================== 6.5 指数斜率窗口分析（异步） + 输出 ====================
(async () => {
  try {
    report.indexWindows = await analyzeIndexWindows(allDays, blockDays);
  } catch (e) {
    console.error(`指数 3 日线斜率窗口分析失败: ${e.message}`);
    report.indexWindows = { daily: [], windows: [] };
  }

  const iw = report.indexWindows;
  if (iw.windows.length) {
    console.log(`----- 上证指数 3 日线斜率窗口（收盘口径，区间内 ${iw.windows.length} 个正斜率窗口）-----`);
    for (const w of iw.windows) {
      const endText = w.openEnded ? `${fmtDate(w.endDate)}（区间末仍为正，未转负）` : `${fmtDate(w.endDate)}，${fmtDate(w.turnDownDate)} 转负`;
      console.log(`【窗口】${fmtDate(w.startDate)} ~ ${endText}（${w.days}天）指数 ${w.indexGain > 0 ? '+' : ''}${w.indexGain}%`);
      console.log(`  题材Top3(剔除算力/芯片/通信/并购重组/其他): ${w.themeTop.map(t => `${t.name}(涨停${t.total}/最高${t.maxLb}板${t.leader ? `/龙头${t.leader.name}` : ''})`).join('、') || '无'}`);
      console.log(`  板块Top3(剔除科技): ${w.sectors.map(s => `${s.name}(累计${s.cum > 0 ? '+' : ''}${s.cum}%)`).join('、') || '无'}`);
      console.log(`  涨幅最大股票: ${w.stockTop.length
        ? w.stockTop.map((s, i) => `${i === 0 ? '🥇 ' : ''}${s.name}(${s.gain > 0 ? '+' : ''}${s.gain}%${s.basis ? '/' + s.basis : ''}，${s.lianbanText || s.board})`).join('、')
        : '无候选或无K线数据'}${w.stockNoKline ? `（${w.stockNoKline} 只候选无K线未计入）` : ''}`);
      console.log('');
    }
  }
  console.log(`报告输出: ${OUT_FILE}`);

// ==================== 7. 生成 HTML ====================
const buildHtml = (r) => {
  const json = JSON.stringify(r).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>市场主线/支线阶段分析 ${fmtDate(r.start)} ~ ${fmtDate(r.end)}</title>
<style>
  :root {
    --bg: #0b1020; --card: #121a2e; --card2: #0e1526; --border: #223052;
    --text: #e6ecff; --muted: #8292b8; --red: #f43f5e; --green: #10b981;
    --amber: #f59e0b; --blue: #38bdf8; --purple: #a78bfa;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 28px 20px 60px; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; min-width: 140px; }
  .stat .v { font-size: 22px; font-weight: 700; }
  .stat .k { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .red { color: var(--red); } .green { color: var(--green); } .amber { color: var(--amber); } .blue { color: var(--blue); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin-bottom: 22px; }
  .card h2 { font-size: 16px; margin-bottom: 12px; }
  .card h2 small { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 12px; }
  .chart-box svg { width: 100%; height: auto; display: block; }
  .legend { display: flex; gap: 16px; color: var(--muted); font-size: 12px; margin-top: 8px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  /* 演变时间轴 */
  table.evo { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.evo th { color: var(--muted); text-align: left; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  table.evo td { padding: 9px 10px; border-bottom: 1px solid #1a2440; vertical-align: top; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; margin: 1px 4px 1px 0; white-space: nowrap; }
  .chip.main { background: rgba(244,63,94,.15); color: var(--red); border: 1px solid rgba(244,63,94,.35); }
  .chip.side { background: rgba(245,158,11,.12); color: var(--amber); border: 1px solid rgba(245,158,11,.3); }
  .chip.blk-main { background: rgba(244,63,94,.15); color: var(--red); border: 1px solid rgba(244,63,94,.35); }
  .chip.blk-side { background: rgba(56,189,248,.12); color: var(--blue); border: 1px solid rgba(56,189,248,.3); }
  .chip.def { background: rgba(130,146,184,.12); color: var(--muted); border: 1px solid rgba(130,146,184,.3); }
  .phase-name { font-weight: 700; white-space: nowrap; }
  .phase-name .rng { color: var(--muted); font-weight: 400; font-size: 12px; display: block; }
  /* 阶段卡 */
  .phase-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; margin-bottom: 20px; overflow: hidden; }
  .phase-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 20px; background: var(--card2); border-bottom: 1px solid var(--border); }
  .phase-head .no { font-size: 13px; color: var(--muted); }
  .phase-head h3 { font-size: 16px; }
  .phase-head .rng { color: var(--muted); font-size: 13px; }
  .badge { padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .badge.hot { background: rgba(244,63,94,.15); color: var(--red); }
  .badge.warm { background: rgba(245,158,11,.12); color: var(--amber); }
  .badge.cold { background: rgba(16,185,129,.12); color: var(--green); }
  .mini-stats { display: flex; gap: 18px; margin-left: auto; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
  .mini-stats b { color: var(--text); font-size: 14px; }
  .phase-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  @media (max-width: 860px) { .phase-body { grid-template-columns: 1fr; } }
  .col { padding: 14px 20px; }
  .col + .col { border-left: 1px solid var(--border); }
  @media (max-width: 860px) { .col + .col { border-left: none; border-top: 1px solid var(--border); } }
  .col h4 { font-size: 13px; margin-bottom: 10px; color: var(--muted); font-weight: 500; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; font-size: 13px; }
  .row .nm { width: 92px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
  .tagline { font-size: 11px; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; }
  .tag-main { background: rgba(244,63,94,.18); color: var(--red); }
  .tag-side { background: rgba(245,158,11,.15); color: var(--amber); }
  .tag-def { background: rgba(130,146,184,.15); color: var(--muted); }
  .bar-wrap { flex: 1; height: 16px; background: #0d1425; border-radius: 4px; overflow: hidden; position: relative; }
  .bar { height: 100%; border-radius: 4px; }
  .bar.main-b { background: linear-gradient(90deg, #be123c, var(--red)); }
  .bar.side-b { background: linear-gradient(90deg, #b45309, var(--amber)); }
  .bar.blk-main-b { background: linear-gradient(90deg, #be123c, var(--red)); }
  .bar.blk-side-b { background: linear-gradient(90deg, #0369a1, var(--blue)); }
  .row .val { width: 120px; flex-shrink: 0; text-align: right; color: var(--muted); font-size: 12px; }
  .row .val b { color: var(--text); font-size: 13px; }
  .leader { color: var(--muted); font-size: 11px; margin: -6px 0 8px 92px; }
  .leader b { color: var(--text); }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 0; }
  .foot { color: var(--muted); font-size: 12px; margin-top: 26px; line-height: 1.7; }
</style>
</head>
<body>
<div class="wrap">
  <h1>市场主线 / 支线阶段分析</h1>
  <div class="sub" id="sub"></div>
  <div class="stats" id="stats"></div>

  <div class="card chart-box">
    <h2>情绪温度与阶段划分 <small>连板快照 sentiment.temperature，3 日平滑 zigzag 分段</small></h2>
    <div id="tempChart"></div>
    <div class="legend">
      <span><i style="background:rgba(244,63,94,.25)"></i>上行/高潮阶段</span>
      <span><i style="background:rgba(16,185,129,.2)"></i>下行/退潮阶段</span>
      <span><i style="background:rgba(130,146,184,.15)"></i>震荡阶段</span>
    </div>
  </div>

  <div class="card">
    <h2>主线演变时间轴 <small>每阶段题材端与板块端的主线 / 支线</small></h2>
    <table class="evo" id="evoTable"></table>
  </div>

  <div class="card chart-box">
    <h2>上证指数 3 日线斜率窗口 <small>收盘口径：MA3 斜率由负转正 → 由正转负；红底为正斜率窗口</small></h2>
    <div id="indexChart"></div>
    <div class="legend">
      <span><i style="background:#38bdf8"></i>上证收盘</span>
      <span><i style="background:#a78bfa"></i>MA3</span>
      <span><i style="background:rgba(244,63,94,.18)"></i>正斜率窗口</span>
      <span><i style="background:#f59e0b"></i>转正/转负拐点</span>
    </div>
    <table class="evo" id="winTable" style="margin-top:16px"></table>
  </div>

  <div id="phaseCards"></div>

  <div class="card">
    <h2>全周期强度排名 <small>左：题材涨停家数合计（连板快照）｜右：板块阶段累计涨幅（板块日历史）</small></h2>
    <div class="phase-body">
      <div class="col"><h4>题材端 Top12（涨停家数 / 连板高度）</h4><div id="themeRank"></div></div>
      <div class="col"><h4>板块端 Top12（区间累计涨幅 %）</h4><div id="sectorRank"></div></div>
    </div>
  </div>

  <div class="foot" id="foot"></div>
</div>

<script>
window.__REPORT__ = ${json};
</script>
<script>
const R = window.__REPORT__;
const fd = d => d.slice(4,6) + '/' + d.slice(6,8);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

document.getElementById('sub').textContent =
  '区间 ' + fd(R.start) + ' ~ ' + fd(R.end) + ' · 共 ' + R.tradingDays + ' 个交易日 · 数据源：lianbanSnapshot 涨停题材快照 + block_data_day_history 板块日历史（key_blocks 板块分类分析底层数据）';

// 顶部统计
document.getElementById('stats').innerHTML = [
  ['交易日', R.tradingDays, ''],
  ['涨停总家数', R.totalLimitUp, 'red'],
  ['最高连板', R.maxLianban + ' 板', 'red'],
  ['平均情绪温度', R.avgTemp, R.avgTemp >= 55 ? 'red' : R.avgTemp >= 35 ? 'amber' : 'green'],
  ['阶段数', R.phases.length, 'blue'],
].map(([k, v, c]) => '<div class="stat"><div class="v ' + c + '">' + v + '</div><div class="k">' + k + '</div></div>').join('');

// ==================== 情绪温度曲线 + 阶段带 ====================
(function drawTemp() {
  // 重建逐日序列（用阶段切分拼接）
  const series = [];
  R.phases.forEach(p => { p.temperature.forEach(t => series.push({ t, phase: p })); });
  const W = 1080, H = 280, PADL = 38, PADR = 14, PADT = 26, PADB = 34;
  const iw = W - PADL - PADR, ih = H - PADT - PADB;
  const x = i => PADL + (series.length <= 1 ? iw / 2 : iw * i / (series.length - 1));
  const y = t => PADT + ih * (1 - t / 100);
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
  // 阶段背景带
  let idx0 = 0;
  R.phases.forEach((p, pi) => {
    const len = p.temperature.length;
    const x1 = x(idx0) - (idx0 === 0 ? 0 : (iw / (series.length - 1)) / 2);
    const x2 = x(idx0 + len - 1) + (idx0 + len - 1 === series.length - 1 ? 0 : (iw / (series.length - 1)) / 2);
    const fill = p.rising && p.avgTemp >= 55 ? 'rgba(244,63,94,.13)' : !p.rising && p.avgTemp < 35 ? 'rgba(16,185,129,.14)' : 'rgba(130,146,184,.10)';
    svg += '<rect x="' + x1 + '" y="' + PADT + '" width="' + Math.max(2, x2 - x1) + '" height="' + ih + '" fill="' + fill + '" rx="4"/>';
    const mid = (x1 + x2) / 2;
    svg += '<text x="' + mid + '" y="' + (PADT - 8) + '" text-anchor="middle" font-size="11" fill="#8292b8">' + p.index + '. ' + esc(p.name) + '</text>';
    svg += '<text x="' + mid + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#5b6a91">' + fd(p.startDate) + '~' + fd(p.endDate) + '</text>';
    idx0 += len;
  });
  // 网格与 y 轴
  [0, 25, 50, 75, 100].forEach(t => {
    svg += '<line x1="' + PADL + '" y1="' + y(t) + '" x2="' + (W - PADR) + '" y2="' + y(t) + '" stroke="#1a2440" stroke-width="1"/>';
    svg += '<text x="' + (PADL - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="10" fill="#5b6a91">' + t + '</text>';
  });
  // 面积 + 折线
  let area = 'M ' + x(0) + ' ' + y(series[0].t);
  let line = area;
  series.forEach((s, i) => { if (i > 0) { line += ' L ' + x(i) + ' ' + y(s.t); } });
  area = line + ' L ' + x(series.length - 1) + ' ' + (PADT + ih) + ' L ' + x(0) + ' ' + (PADT + ih) + ' Z';
  svg += '<path d="' + area + '" fill="url(#gradT)"/>';
  svg += '<path d="' + line + '" fill="none" stroke="#f43f5e" stroke-width="2" stroke-linejoin="round"/>';
  // 拐点圆点：每阶段首尾
  let di = 0;
  R.phases.forEach(p => {
    p.temperature.forEach((t, i) => {
      if (i === 0 || i === p.temperature.length - 1) {
        svg += '<circle cx="' + x(di) + '" cy="' + y(t) + '" r="3.5" fill="#0b1020" stroke="#f43f5e" stroke-width="1.6"/>';
        svg += '<text x="' + x(di) + '" y="' + (y(t) - 8) + '" text-anchor="middle" font-size="10" fill="#e6ecff">' + t + '</text>';
      }
      di++;
    });
  });
  svg += '<defs><linearGradient id="gradT" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="rgba(244,63,94,.35)"/><stop offset="100%" stop-color="rgba(244,63,94,0)"/></linearGradient></defs>';
  svg += '</svg>';
  document.getElementById('tempChart').innerHTML = svg;
})();

// ==================== 主线演变时间轴 ====================
(function drawEvo() {
  let html = '<tr><th style="width:150px">阶段</th><th>题材主线（连板快照）</th><th>题材支线</th><th>板块主线（日历史）</th><th>板块支线</th></tr>';
  R.phases.forEach(p => {
    const chips = (arr, cls) => arr.length
      ? arr.map(t => '<span class="chip ' + cls + '">' + esc(t.name) + (t.maxLb ? ' · ' + t.maxLb + '板' : '') + (cls === 'blk-main' || cls === 'blk-side' ? ' +' + t.cum + '%' : '') + '</span>').join('')
      : '<span style="color:#5b6a91">—</span>';
    const def = p.blocks.hongli.length ? ' <span class="chip def">防御:' + esc(p.blocks.hongli.map(h => h.name).join('/')) + '</span>' : '';
    html += '<tr>'
      + '<td class="phase-name">' + p.index + '. ' + esc(p.name) + '<span class="rng">' + fd(p.startDate) + ' ~ ' + fd(p.endDate) + ' · ' + p.days + '天</span></td>'
      + '<td>' + chips(p.lianban.main, 'main') + '</td>'
      + '<td>' + chips(p.lianban.side, 'side') + '</td>'
      + '<td>' + chips(p.blocks.main, 'blk-main') + '</td>'
      + '<td>' + chips(p.blocks.side, 'blk-side') + def + '</td>'
      + '</tr>';
  });
  document.getElementById('evoTable').innerHTML = html;
})();

// ==================== 上证指数 3 日线斜率窗口 ====================
(function drawIndex() {
  const IW = R.indexWindows || { daily: [], windows: [] };
  if (!IW.daily || IW.daily.length === 0) {
    document.getElementById('indexChart').innerHTML = '<div class="empty">指数数据获取失败，无斜率窗口</div>';
    document.getElementById('winTable').innerHTML = '';
    return;
  }
  const D = IW.daily, WL = IW.windows;
  const dateIdx = new Map(D.map((d, i) => [d.date, i]));
  // ---- SVG 曲线 ----
  const Wd = 1080, H = 300, PADL = 44, PADR = 14, PADT = 26, PADB = 34;
  const iw = Wd - PADL - PADR, ih = H - PADT - PADB;
  const vals = D.flatMap(d => [d.close, d.ma3].filter(v => v != null));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const padV = (hi - lo) * 0.08 || 1;
  const y = v => PADT + ih * (1 - (v - (lo - padV)) / ((hi + padV) - (lo - padV)));
  const x = i => PADL + (D.length <= 1 ? iw / 2 : iw * i / (D.length - 1));
  let svg = '<svg viewBox="0 0 ' + Wd + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
  // 正斜率窗口底色
  WL.forEach((w, wi) => {
    const i1 = dateIdx.get(w.startDate), i2 = dateIdx.get(w.endDate);
    if (i1 == null || i2 == null) return;
    svg += '<rect x="' + (x(i1) - 5) + '" y="' + PADT + '" width="' + Math.max(8, x(i2) - x(i1) + 10) + '" height="' + ih + '" fill="rgba(244,63,94,.16)" rx="5"/>';
    svg += '<text x="' + ((x(i1) + x(i2)) / 2) + '" y="' + (PADT - 7) + '" text-anchor="middle" font-size="11" fill="#f43f5e">'
      + '窗口' + (wi + 1) + ' ' + (w.indexGain != null ? (w.indexGain > 0 ? '+' : '') + w.indexGain + '%' : '') + '</text>';
  });
  // 网格
  for (let s = 0; s <= 4; s++) {
    const v = lo - padV + ((hi + padV) - (lo - padV)) * s / 4;
    svg += '<line x1="' + PADL + '" y1="' + y(v) + '" x2="' + (Wd - PADR) + '" y2="' + y(v) + '" stroke="#1a2440"/>';
    svg += '<text x="' + (PADL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" fill="#5b6a91">' + v.toFixed(0) + '</text>';
  }
  // 折线：收盘 + MA3
  const lineOf = key => D.map((d, i) => (d[key] != null ? (i === 0 ? 'M ' : ' L ') + x(i) + ' ' + y(d[key]) : '')).join('');
  svg += '<path d="' + lineOf('close') + '" fill="none" stroke="#38bdf8" stroke-width="1.8"/>';
  svg += '<path d="' + lineOf('ma3') + '" fill="none" stroke="#a78bfa" stroke-width="1.4"/>';
  // 转正/转负拐点
  WL.forEach(w => {
    [w.startDate, w.endDate].forEach(dt => {
      const i = dateIdx.get(dt);
      if (i == null) return;
      svg += '<circle cx="' + x(i) + '" cy="' + y(D[i].close) + '" r="4" fill="#0b1020" stroke="#f59e0b" stroke-width="2"/>';
    });
  });
  // x 轴日期
  const xStep = Math.max(1, Math.ceil(D.length / 9));
  D.forEach((d, i) => {
    if (i % xStep === 0 || i === D.length - 1) {
      svg += '<text x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#5b6a91">' + fd(String(d.date)) + '</text>';
    }
  });
  svg += '</svg>';
  document.getElementById('indexChart').innerHTML = svg;

  // ---- 窗口明细表 ----
  const chipOf = (t, cls) => '<span class="chip ' + cls + '">' + esc(t.name) + ' ' + (t.total != null ? t.total + '家/' + t.maxLb + '板' : (t.cum > 0 ? '+' : '') + t.cum + '%') + '</span>';
  let html = '<tr><th style="width:160px">窗口（转正 → 转负）</th><th>指数涨幅</th>'
    + '<th>题材 Top3（剔除算力/芯片/通信/并购重组/其他）</th><th>板块 Top3（剔除科技）</th><th style="width:270px">涨幅最大股票（K线实算）</th></tr>';
  WL.forEach((w, i) => {
    const range = fd(String(w.startDate)) + ' ~ ' + fd(String(w.endDate))
      + (w.openEnded ? '（未转负）' : '') + (w.clippedStart ? '（区间起始即为正）' : '');
    const gain = w.indexGain != null
      ? '<b class="' + (w.indexGain >= 0 ? 'red' : 'green') + '">' + (w.indexGain > 0 ? '+' : '') + w.indexGain + '%</b>'
      : '—';
    const themeHtml = w.themeTop.length ? w.themeTop.map(t => chipOf(t, 'main')).join('') : '<span style="color:#5b6a91">—</span>';
    const secHtml = w.sectors.length ? w.sectors.map(t => chipOf(t, 'blk-side')).join('') : '<span style="color:#5b6a91">—</span>';
    const stockHtml = w.stockTop.length
      ? '<div class="row" style="margin-bottom:3px"><span class="chip main">' + esc(w.stockTop[0].name) + '</span>'
        + '<b class="red">+' + w.stockTop[0].gain + '%</b>&nbsp;<span style="color:#8292b8;font-size:12px">'
        + esc(w.stockTop[0].lianbanText || '') + (w.stockTop[0].basis ? ' · ' + w.stockTop[0].basis : '') + '</span></div>'
        + w.stockTop.slice(1).map(s => '<div style="color:#8292b8;font-size:12px;margin:1px 0 1px 4px">'
          + esc(s.name) + ' +' + s.gain + '%（' + esc(s.lianbanText || s.board || '') + '）</div>').join('')
      : '<span style="color:#5b6a91">无候选或无K线</span>';
    html += '<tr><td class="phase-name">窗口' + (i + 1) + '<span class="rng">' + range + ' · ' + w.days + '天</span></td>'
      + '<td>' + gain + '</td><td>' + themeHtml + '</td><td>' + secHtml + '</td><td>' + stockHtml + '</td></tr>';
  });
  document.getElementById('winTable').innerHTML = html;
})();

// ==================== 阶段卡 ====================
(function drawPhases() {
  let html = '';
  R.phases.forEach(p => {
    const badgeCls = p.avgTemp >= 75 ? 'hot' : p.avgTemp >= 40 ? 'warm' : 'cold';
    const lianMax = Math.max(1, ...p.lianban.all.map(t => t.total));
    const blkMax = Math.max(1, ...p.blocks.all.map(s => Math.abs(s.cum)));
    const themeRow = (t, cls, barCls, tagCls) =>
      '<div class="row"><div class="nm"><span class="tagline ' + tagCls + '">' + (tagCls === 'tag-main' ? '主线' : '支线') + '</span>' + esc(t.name) + '</div>'
      + '<div class="bar-wrap"><div class="bar ' + barCls + '" style="width:' + Math.max(4, t.total / lianMax * 100) + '%"></div></div>'
      + '<div class="val"><b>' + t.total + '</b> 家涨停 · ' + t.maxLb + '板 · ' + t.share + '%</div></div>'
      + (t.leader ? '<div class="leader">龙头 <b>' + esc(t.leader.name) + '</b>（' + esc(t.leader.text || '') + (t.leader.concept ? ' · ' + esc(t.leader.concept) : '') + '）</div>' : '');
    const blkRow = (s, tagCls, barCls) =>
      '<div class="row"><div class="nm"><span class="tagline ' + tagCls + '">' + (tagCls === 'tag-main' ? '主线' : '支线') + '</span>' + esc(s.name) + '</div>'
      + '<div class="bar-wrap"><div class="bar ' + barCls + '" style="width:' + Math.max(4, Math.abs(s.cum) / blkMax * 100) + '%"></div></div>'
      + '<div class="val"><b>+' + s.cum + '%</b> · 日均' + s.avgCh + '% · 涨' + s.upDays + '/' + s.presence + '天</div></div>';
    html += '<div class="phase-card"><div class="phase-head">'
      + '<span class="no">阶段 ' + p.index + '</span>'
      + '<h3>' + esc(p.name) + '</h3>'
      + '<span class="rng">' + fd(p.startDate) + ' ~ ' + fd(p.endDate) + '（' + p.days + ' 个交易日）</span>'
      + '<span class="badge ' + badgeCls + '">均温 ' + p.avgTemp + ' · 峰值 ' + p.maxTemp + '</span>'
      + '<div class="mini-stats">'
      + '<span>日均涨停 <b>' + p.stats.avgLimitUp + '</b></span>'
      + '<span>日均连板 <b>' + p.stats.avgLianbanCount + '</b></span>'
      + '<span>最高板 <b>' + p.stats.maxLianban + '</b></span>'
      + '</div></div>'
      + '<div class="phase-body">'
      + '<div class="col"><h4>题材主线 / 支线（连板快照：涨停家数 / 最高连板 / 占比）</h4>'
      + (p.lianban.main.map(t => themeRow(t, 'main', 'main-b', 'tag-main')).join('') || '<div class="empty">无</div>')
      + (p.lianban.side.map(t => themeRow(t, 'side', 'side-b', 'tag-side')).join('') || '<div class="empty">无</div>')
      + (p.lianban.hongli.length ? '<div class="row"><div class="nm"><span class="tagline tag-def">防御</span>' + esc(p.lianban.hongli.map(h => h.name).join('/')) + '</div><div class="bar-wrap"></div><div class="val">涨停 ' + p.lianban.hongli.reduce((a, b) => a + b.total, 0) + '</div></div>' : '')
      + '</div>'
      + '<div class="col"><h4>板块主线 / 支线（板块日历史：累计涨幅 / 日均 / 上涨天数）</h4>'
      + (p.blocks.main.map(s => blkRow(s, 'tag-main', 'blk-main-b')).join('') || '<div class="empty">无</div>')
      + (p.blocks.side.map(s => blkRow(s, 'tag-side', 'blk-side-b')).join('') || '<div class="empty">无</div>')
      + (p.blocks.hongli.length ? '<div class="row"><div class="nm"><span class="tagline tag-def">防御</span>' + esc(p.blocks.hongli.map(h => h.name).join('/')) + '</div><div class="bar-wrap"></div><div class="val">累计 +' + p.blocks.hongli.reduce((a, b) => a + b.cum, 0).toFixed(1) + '%</div></div>' : '')
      + '</div></div></div>';
  });
  document.getElementById('phaseCards').innerHTML = html;
})();

// ==================== 全周期排名 ====================
(function drawRank() {
  // 题材端：跨阶段合并
  const tm = {};
  R.phases.forEach(p => p.lianban.all.forEach(t => {
    tm[t.name] = tm[t.name] || { name: t.name, total: 0, maxLb: 0 };
    tm[t.name].total += t.total;
    tm[t.name].maxLb = Math.max(tm[t.name].maxLb, t.maxLb);
  }));
  const themes = Object.values(tm).sort((a, b) => b.total - a.total).slice(0, 12);
  const tMax = Math.max(1, ...themes.map(t => t.total));
  document.getElementById('themeRank').innerHTML = themes.map((t, i) =>
    '<div class="row"><div class="nm">' + (i + 1) + '. ' + esc(t.name) + '</div>'
    + '<div class="bar-wrap"><div class="bar side-b" style="width:' + Math.max(4, t.total / tMax * 100) + '%"></div></div>'
    + '<div class="val"><b>' + t.total + '</b> 家 · ' + t.maxLb + '板</div></div>'
  ).join('');
  // 板块端：区间整体累计（直接重算：用各阶段 all 合并近似，改为逐日重算更准）
  const dates = [];
  R.phases.forEach(p => { for (let i = 0; i < p.days; i++) dates.push(null); });
  const sm = {};
  R.phases.forEach(p => p.blocks.all.forEach(s => {
    sm[s.name] = sm[s.name] || { name: s.name, cum: 0 };
    sm[s.name].cum = Math.max(sm[s.name].cum, s.cum); // 取各阶段内最佳累计近似展示
  }));
  const sectors = Object.values(sm).sort((a, b) => b.cum - a.cum).slice(0, 12);
  const sMax = Math.max(1, ...sectors.map(s => s.cum));
  document.getElementById('sectorRank').innerHTML = sectors.map((s, i) =>
    '<div class="row"><div class="nm">' + (i + 1) + '. ' + esc(s.name) + '</div>'
    + '<div class="bar-wrap"><div class="bar blk-side-b" style="width:' + Math.max(4, s.cum / sMax * 100) + '%"></div></div>'
    + '<div class="val"><b>+' + s.cum + '%</b>（单阶段最佳）</div></div>'
  ).join('');
})();

document.getElementById('foot').innerHTML =
  '主线/支线判定规则：阶段由情绪温度 3 日平滑 zigzag 摆动（阈值 18、最短 3 日）切分；'
  + '题材端得分 = 涨停家数 + 连板高度×6 + 出现天数×2.5，得分≥最高分 55% 判为主线；'
  + '板块端得分 = 阶段累计涨幅 + 上涨天数占比×6 + 排名前 30% 天数×1.2，累计 &gt;1% 且上涨天数≥40% 判为主线。'
  + '红利防御类（hongliName.json）单独标注不参与主线竞争。'
  + '<br>指数斜率窗口：上证指数收盘价 MA3 斜率（MA3今日 − MA3昨日）由负转正当日开窗、由正转负前一日收窗；'
  + '窗口内题材排名剔除「算力/芯片/通信/并购重组/其他」（子串匹配），板块排名剔除科技类板块（关键词匹配），'
  + '个股涨幅 = 窗口末收盘 / 窗口首日前一交易日收盘 − 1（kline_cache 实算，候选为窗口内快照涨停股，无K线者剔除）。'
  + '生成时间 ' + new Date().toLocaleString('zh-CN') + ' · analyze_market_lines.js';
</script>
</body>
</html>`;
};

  fs.writeFileSync(OUT_FILE, buildHtml(report));
  console.log('HTML 报告已生成');
})();
