// 题材爆发 + 龙头首次分歧 低吸回测
// 规则（题材爆发模式，默认）：
//   1. 扫描 lianbanSnapshot 全部交易日，找「单日题材涨停数 > 15」的题材（排除 算力/通信/芯片/其他）
//   2. 题材龙头 = 该题材当日连板数最高的涨停股，连板数 < 4 直接过滤
// 规则（全市场模式 --all）：
//   1. 不看题材效应：扫描全部交易日中 lianbanCount ≥ 4（四连板及以上）的所有个股，按「个股 + 本轮行情」去重
// 通用规则：
//   3. 个股从本轮第一个涨停板开始扫描，第一次分歧 = 量能 > 过去5日量能均值 且 当日未涨停
//   4. 分歧日两种买入：
//      A 尾盘买入：分歧日 14:55 买入（无分时数据退化为收盘价）
//      B 回踩5日线分时买入：分歧日起 10 个交易日内，盘中价格回踩至 5 日线（最低价 <= MA5）时买入；
//        有分时数据按触发分钟的最新价成交（开盘已低于 5 日线则按开盘价），无分时数据按 min(开盘价, MA5) 近似
//   5. 统计：买入后 10 个交易日内盘中最大亏损、二次涨停等待天数（未涨停单列）、持仓 5 / 10 个交易日收益率
// 用法：node script/leader-divergence-backtest.js           题材爆发模式（题材涨停数>15 → 龙头≥4连板），生成 leader-divergence-backtest.html
//       node script/leader-divergence-backtest.js --all     全市场模式：不看题材，全部四连板及以上个股，生成 all-lianban4-backtest.html
const fs = require('fs');
const path = require('path');

const ALL_MODE = process.argv.includes('--all');
const DATA_DIR = path.resolve(__dirname, '../src/data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'lianbanSnapshot');
const KLINE_DIR = path.join(DATA_DIR, 'kline_cache');
const MINUTE_DIR = '/Users/xieyin/Desktop/盯盘工具/自选股全量股票过去分时数据';
const OUT_HTML = path.join(__dirname, ALL_MODE ? 'all-lianban4-backtest.html' : 'leader-divergence-backtest.html');

const EXCLUDE_THEMES = ['算力', '通信', '芯片', '其他'];
const THEME_COUNT_MIN = 15;          // 题材涨停数须 > 15
const LEADER_MIN_LIANBAN = 4;        // 龙头至少四连板
const DIVERGENCE_SCAN_CAP = 30;      // 首板起最多扫描 30 个交易日找分歧
const PULLBACK_WAIT_CAP = 10;        // 分歧日后最多等 10 个交易日回踩 5 日线
const HOLD_MAX = 10;                 // 最长持仓观察 10 个交易日

// ===== 基础工具 =====
const fmtDate = (d) => `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}`;
const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const round2 = (v) => Math.round(v * 100) / 100;
const mean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; } };

// 涨停判定：按昨收(由涨幅反推)×涨停幅度四舍五入到分，与收盘价比对（兼容 10/20/30cm 与 ST）
const limitPctOf = (code, name) => {
  const pure = String(code).replace(/^[a-zA-Z]+/, '');
  let p = 0.10;
  if (/^(68|30)/.test(pure)) p = 0.20;
  else if (/^(8|4|92)/.test(pure) && String(code).startsWith('bj')) p = 0.30;
  if ((name || '').includes('ST') && p === 0.10) p = 0.05;
  return p;
};
const isLimitUp = (bar, code, name) => {
  const chg = Number(bar.change);
  if (!Number.isFinite(chg) || !Number.isFinite(Number(bar.close_px)) || Number(bar.close_px) <= 0) return false;
  const prevClose = round2(Number(bar.close_px) / (1 + chg / 100));
  if (!(prevClose > 0)) return false;
  const limitPrice = round2(prevClose * (1 + limitPctOf(code, name)));
  return Math.abs(Number(bar.close_px) - limitPrice) <= 0.011;
};

// ===== 日K加载：优先读 kline_cache（不限当日），覆盖不足再拉同花顺接口 =====
const klineMem = new Map();
const loadKline = async (marketCode) => {
  if (klineMem.has(marketCode)) return klineMem.get(marketCode);
  const cached = readJson(path.join(KLINE_DIR, `${marketCode}.json`));
  let bars = cached && Array.isArray(cached.kline) ? cached.kline.filter(b => Number.isFinite(Number(b.trade_date))) : [];
  bars.sort((a, b) => a.trade_date - b.trade_date);
  // 覆盖不足（回测区间末尾缺K线）时重新拉取 140 根
  const lastSnapshotDate = snapshotDates[snapshotDates.length - 1];
  if (bars.length === 0 || Number(bars[bars.length - 1].trade_date) < Number(lastSnapshotDate)) {
    try {
      const { getSingleStockData } = require('../src/service/stock');
      const fresh = await getSingleStockData(marketCode, 140);
      if (fresh && fresh.length > 0) {
        const freshBars = fresh.filter(b => Number.isFinite(Number(b.trade_date))).sort((a, b) => a.trade_date - b.trade_date);
        if (Number(freshBars[freshBars.length - 1].trade_date) > Number(bars[bars.length - 1]?.trade_date || 0)) bars = freshBars;
      }
      console.log(`  [kline] ${marketCode} 缓存覆盖不足，已重新拉取 ${bars.length} 根`);
    } catch (e) {
      console.log(`  [kline] ${marketCode} 重新拉取失败（使用本地缓存）: ${e.message}`);
    }
  }
  klineMem.set(marketCode, bars);
  return bars;
};

// ===== 分时加载（自选股全量股票过去分时数据）=====
const minuteMem = new Map();
const loadMinute = (marketCode) => {
  if (minuteMem.has(marketCode)) return minuteMem.get(marketCode);
  const days = readJson(path.join(MINUTE_DIR, `${marketCode}.json`)) || [];
  const byDate = new Map();
  for (const d of days) {
    if (!d || !Number.isFinite(Number(d.trade_date)) || !Array.isArray(d.line)) continue;
    byDate.set(Number(d.trade_date), d.line.filter(x => Number.isFinite(Number(x.minute)) && Number.isFinite(Number(x.last_px))));
  }
  minuteMem.set(marketCode, byDate);
  return byDate;
};
// 取某日 14:55（或其后最近一分钟）最新价
const minuteTailPrice = (line) => {
  for (const m of line) if (Number(m.minute) >= 1455) return Number(m.last_px);
  return null;
};
// 取某日回踩 5 日线的触发价：开盘已低于 ma5 → 开盘价；否则第一根 last_px <= ma5 的分钟价
const minutePullbackPrice = (line, ma5) => {
  if (!line.length) return null;
  const openPx = Number(line[0].last_px);
  if (openPx < ma5) return { price: openPx, minute: Number(line[0].minute), type: '开盘低于5日线' };
  for (const m of line) {
    if (Number(m.last_px) <= ma5 + 0.005) return { price: Number(m.last_px), minute: Number(m.minute), type: '盘中回踩5日线' };
  }
  return null;
};
// 某分钟之后（含当分钟）的盘中最低价
const minuteLowAfter = (line, fromMinute) => {
  let lo = null;
  for (const m of line) {
    if (Number(m.minute) < fromMinute) continue;
    const p = Number(m.last_px);
    if (lo === null || p < lo) lo = p;
  }
  return lo;
};

// ===== 第一步：扫描题材爆发日（涨停数>15 且非排除题材）=====
const snapshotFiles = fs.readdirSync(SNAPSHOT_DIR).filter(f => /^2\d{7}\.json$/.test(f)).sort();
const snapshotDates = snapshotFiles.map(f => f.replace('.json', ''));
const themeDays = [];

for (let di = 0; di < snapshotFiles.length; di++) {
  const snap = readJson(path.join(SNAPSHOT_DIR, snapshotFiles[di]));
  if (!snap) continue;
  for (const th of (snap.themes || [])) {
    const name = th.board || '';
    const count = Number(th.count) || 0;
    const excluded = EXCLUDE_THEMES.some(k => name.includes(k));
    // 龙头：连板数最高（同板数优先 leader 标记、更早封板）
    const stocks = (th.stocks || []).slice().sort((a, b) =>
      (Number(b.lianbanCount) || 0) - (Number(a.lianbanCount) || 0) ||
      (b.leader === true) - (a.leader === true) ||
      String(a.sealTime || '99:99').localeCompare(String(b.sealTime || '99:99')));
    const top = stocks[0] || null;
    const rec = {
      date: snapshotDates[di], theme: name, count, excluded,
      leaderName: top ? top.name : null, leaderCode: top ? top.marketCode || top.code : null,
      leaderLianban: top ? Number(top.lianbanCount) || 0 : 0,
      leaderText: top ? top.lianbanText : null,
      qualify: false, reason: '',
    };
    if (excluded) rec.reason = '排除题材';
    else if (count <= THEME_COUNT_MIN) rec.reason = `涨停数 ${count} ≤ 15`;
    else if (!top) rec.reason = '题材内无个股';
    else if (rec.leaderLianban < LEADER_MIN_LIANBAN) rec.reason = `龙头 ${rec.leaderName} 仅 ${rec.leaderLianban} 连板（${rec.leaderText || '-'}）`;
    else { rec.qualify = true; }
    themeDays.push(rec);
  }
}

// 全市场模式（--all）：不看题材效应，收集全部交易日中连板数 ≥ 4 的所有个股
// 同一股票同一天可能出现在多个题材下，先按 code+date 去重；同一轮行情的连续触发日由第二步 runStart 去重
const scanAllBoards = () => {
  const seen = new Set();
  const recs = [];
  for (let di = 0; di < snapshotFiles.length; di++) {
    const snap = readJson(path.join(SNAPSHOT_DIR, snapshotFiles[di]));
    if (!snap) continue;
    for (const th of (snap.themes || [])) {
      for (const s of (th.stocks || [])) {
        const lianban = Number(s.lianbanCount) || 0;
        if (lianban < LEADER_MIN_LIANBAN) continue;
        const code = s.marketCode || s.code;
        const key = `${code}@${snapshotDates[di]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recs.push({
          date: snapshotDates[di], theme: th.board || '', count: null,
          leaderName: s.name, leaderCode: code, leaderLianban: lianban, leaderText: s.lianbanText || null,
          qualify: true, reason: '',
        });
      }
    }
  }
  return recs;
};

async function runAll() {
// ===== 第二步：对入选个股计算本轮 run / 首次分歧 / 双策略回测 =====
const cases = [];
const skipped = [];
const pending = ALL_MODE ? scanAllBoards() : themeDays.filter(r => r.qualify);
const seenRuns = new Set(); // 去重：同一龙头同一轮行情只保留最早触发
const skip = (rec, reason) => {
  rec.reason = reason; rec.qualify = false;
  skipped.push({ date: rec.date, theme: rec.theme, name: rec.leaderName, code: rec.leaderCode, lianban: rec.leaderLianban, text: rec.leaderText, reason });
};

for (const rec of pending) {
  console.log(`\n== ${rec.date} ${rec.theme || ''}${rec.count ? `（${rec.count} 家涨停）` : ''} ${rec.leaderName} ${rec.leaderLianban}连板 ==`);
  const bars = await loadKline(rec.leaderCode);
  const idxOf = (d) => bars.findIndex(b => Number(b.trade_date) === Number(d));
  const ei = idxOf(rec.date);
  if (ei < 0) { skip(rec, '日K缺失，无法回测'); continue; }

  // 1) 从爆发日向前走连板，找本轮第一个涨停板
  let first = ei;
  while (first - 1 >= 0 && isLimitUp(bars[first - 1], rec.leaderCode, rec.leaderName)) first--;
  const runBoards = ei - first + 1;
  if (runBoards < LEADER_MIN_LIANBAN) { skip(rec, `日K复算连板 ${runBoards} < ${LEADER_MIN_LIANBAN}`); continue; }

  // 同一轮去重（同一 code + 同一首板日）
  const runKey = `${rec.leaderCode}@${bars[first].trade_date}`;
  if (seenRuns.has(runKey)) { skip(rec, '与更早触发日重复（同一轮行情）'); continue; }
  seenRuns.add(runKey);

  // 2) 首板起找第一次分歧：量能 > 过去5日均量 且 当日未涨停
  let divIdx = -1;
  const scanEnd = Math.min(bars.length - 1, first + DIVERGENCE_SCAN_CAP);
  for (let i = first; i <= scanEnd; i++) {
    if (i < 5) continue;
    if (isLimitUp(bars[i], rec.leaderCode, rec.leaderName)) continue;
    const avg5 = mean(bars.slice(i - 5, i).map(b => Number(b.business_amount) || 0));
    if (avg5 > 0 && Number(bars[i].business_amount) > avg5) { divIdx = i; break; }
  }
  if (divIdx < 0) { skip(rec, `${DIVERGENCE_SCAN_CAP} 个交易日内未出现分歧`); continue; }
  const divBar = bars[divIdx];
  const divAvg5 = mean(bars.slice(divIdx - 5, divIdx).map(b => Number(b.business_amount) || 0));
  console.log(`   首板 ${fmtDate(bars[first].trade_date)} → 触发 ${fmtDate(rec.date)}（${runBoards}连板）→ 首次分歧 ${fmtDate(divBar.trade_date)}（量能 ${(Number(divBar.business_amount) / divAvg5).toFixed(2)}× 过去5日均量，当日 ${Number(divBar.change)}%）`);

  // 中途每日状态（供明细展示：首板→分歧之间每天的板数/量能）
  const runDays = [];
  for (let i = first; i <= divIdx; i++) {
    const b = bars[i];
    runDays.push({
      date: String(b.trade_date), close: Number(b.close_px), change: Number(b.change),
      vol: Number(b.business_amount), avg5: Number((mean(bars.slice(Math.max(0, i - 5), i).map(x => Number(x.business_amount) || 0)) || 0).toFixed(0)),
      isLU: isLimitUp(b, rec.leaderCode, rec.leaderName), ma5: b.ma5_px != null ? Number(b.ma5_px) : null, low: Number(b.low_px), high: Number(b.high_px), open: Number(b.open_px),
    });
  }

  // 3) 双策略回测
  const minByDate = loadMinute(rec.leaderCode);
  const buildMetrics = (buyIdx, buyPrice, entryLabel, entryMinute) => {
    // 盘中最大亏损（买入时点起 ~ 买入后第 10 个交易日，含买入日剩余时段）
    // 买入日剩余时段：分时数据可得用分时低点，并与日K低点取更保守值（分时源可能缺低价毛刺）
    let loPrice = null, loDate = null;
    const entryLine = entryMinute != null ? minByDate.get(Number(bars[buyIdx].trade_date)) : null;
    let sameDayLow = null;
    if (entryLabel === '尾盘') {
      const mLow = entryLine ? minuteLowAfter(entryLine, 1455) : null;
      const closePx = Number(bars[buyIdx].close_px);
      sameDayLow = Math.min(mLow != null ? mLow : Infinity, Number.isFinite(closePx) ? closePx : Infinity);
    } else {
      const mLow = entryLine ? minuteLowAfter(entryLine, entryMinute) : null;
      const dayLow = Number(bars[buyIdx].low_px);
      sameDayLow = Math.min(mLow != null ? mLow : Infinity, Number.isFinite(dayLow) ? dayLow : Infinity);
    }
    if (Number.isFinite(sameDayLow)) { loPrice = sameDayLow; loDate = String(bars[buyIdx].trade_date); }
    for (let j = buyIdx + 1; j <= Math.min(bars.length - 1, buyIdx + HOLD_MAX); j++) {
      const lo = Number(bars[j].low_px);
      if (Number.isFinite(lo) && (loPrice === null || lo < loPrice)) { loPrice = lo; loDate = String(bars[j].trade_date); }
    }
    const maxLoss = loPrice != null ? loPrice / buyPrice - 1 : null;

    // 二次涨停等待天数（自然扫描至数据末尾；数据末尾前未出现 → 未涨停）
    let luDays = null, luDate = null, luChange = null;
    const startJ = buyIdx + (entryLabel === '尾盘' ? 1 : 0);
    if (entryLabel !== '尾盘' && isLimitUp(bars[buyIdx], rec.leaderCode, rec.leaderName)) {
      luDays = 0; luDate = String(bars[buyIdx].trade_date); luChange = Number(bars[buyIdx].change);
    } else {
      for (let j = Math.max(startJ, buyIdx + 1); j < bars.length; j++) {
        if (isLimitUp(bars[j], rec.leaderCode, rec.leaderName)) { luDays = j - buyIdx; luDate = String(bars[j].trade_date); luChange = Number(bars[j].change); break; }
      }
    }

    // 持仓 5 / 10 个交易日收益（按买入后第 N 个交易日收盘价）
    const retAt = (n) => {
      const j = buyIdx + n;
      if (j > bars.length - 1) return { ret: null, date: null, insufficient: true };
      return { ret: Number(bars[j].close_px) / buyPrice - 1, date: String(bars[j].trade_date), insufficient: false };
    };
    const r5 = retAt(5), r10 = retAt(10);
    return {
      entryLabel, buyDate: String(bars[buyIdx].trade_date), buyPrice: round2(buyPrice),
      maxLoss, maxLossDate: loDate, maxLossPrice: loPrice != null ? round2(loPrice) : null,
      luDays, luDate, luChange,
      ret5: r5.ret, ret5Date: r5.date, ret5Insufficient: r5.insufficient,
      ret10: r10.ret, ret10Date: r10.date, ret10Insufficient: r10.insufficient,
      sell5: r5.date ? round2(Number(bars[buyIdx + 5].close_px)) : null,
      sell10: r10.date ? round2(Number(bars[buyIdx + 10].close_px)) : null,
    };
  };

  // 策略A：分歧日尾盘（14:55）买入
  const divLine = minByDate.get(Number(divBar.trade_date)) || null;
  const aPrice = divLine ? (minuteTailPrice(divLine) ?? Number(divBar.close_px)) : Number(divBar.close_px);
  const mA = buildMetrics(divIdx, aPrice, '尾盘', divLine ? 1455 : null);

  // 策略B：分歧日起 10 个交易日内回踩 5 日线分时买入（触板判定以日K最低价为准，分时仅细化成交价）
  let mB = null, pullbackInfo = null;
  for (let j = divIdx; j <= Math.min(bars.length - 1, divIdx + PULLBACK_WAIT_CAP); j++) {
    const ma5 = bars[j].ma5_px != null ? Number(bars[j].ma5_px) : null;
    if (ma5 == null || !(Number(bars[j].low_px) <= ma5 + 0.005)) continue;
    const line = minByDate.get(Number(bars[j].trade_date)) || null;
    const openPx = Number(bars[j].open_px);
    let price = null, minute = null, type = null;
    if (line) {
      const r = minutePullbackPrice(line, ma5);
      if (r) { price = r.price; minute = r.minute; type = r.type; }
    }
    if (price == null) {
      // 分时缺失或未确认触发（分时源可能缺低价毛刺）：按日线口径近似成交
      price = Math.min(openPx, ma5);
      type = openPx < ma5 ? '开盘低于5日线' : '盘中回踩5日线(日线近似)';
      minute = null;
    }
    pullbackInfo = { date: String(bars[j].trade_date), ma5: round2(ma5), waitDays: j - divIdx, type, minute };
    console.log(`   回踩买入 ${fmtDate(bars[j].trade_date)} MA5=${round2(ma5)} 成交 ${round2(price)}（${type}${minute != null ? ' ' + String(minute).padStart(4, '0') : ''}，等待 ${j - divIdx} 个交易日）`);
    mB = buildMetrics(j, price, '盘中', minute);
    break;
  }
  if (!mB) console.log(`   分歧后 ${PULLBACK_WAIT_CAP} 个交易日内未回踩 5 日线，策略B未成交`);

  cases.push({
    theme: rec.theme, triggerDate: rec.date, themeCount: rec.count,
    code: rec.leaderCode, name: rec.leaderName, lianbanAtTrigger: rec.leaderLianban, lianbanText: rec.leaderText,
    firstBoardDate: String(bars[first].trade_date), runBoards,
    divergenceDate: String(divBar.trade_date), divergenceVolX: Number((Number(divBar.business_amount) / divAvg5).toFixed(2)),
    divergenceChange: Number(divBar.change),
    runDays,
    strategyA: mA,
    strategyB: mB ? { ...mB, pullback: pullbackInfo } : null,
  });
}

// ===== 汇总统计 =====
const agg = (vals) => {
  const v = vals.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return { avg: null, max: null, min: null, n: 0 };
  return { avg: mean(v), max: Math.max(...v), min: Math.min(...v), n: v.length };
};
const buildStats = (key) => {
  const list = cases.map(c => c[key]).filter(Boolean);
  return {
    cases: list.length,
    maxLoss: agg(list.map(m => m.maxLoss)),
    luDays: agg(list.map(m => m.luDays)),
    luMissing: list.filter(m => m.luDays == null).length,
    ret5: agg(list.map(m => m.ret5)),
    ret5Insufficient: list.filter(m => m.ret5 == null).length,
    ret10: agg(list.map(m => m.ret10)),
    ret10Insufficient: list.filter(m => m.ret10 == null).length,
  };
};
const result = {
  generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  mode: ALL_MODE ? 'all' : 'theme',
  range: { start: snapshotDates[0], end: snapshotDates[snapshotDates.length - 1] },
  params: { THEME_COUNT_MIN: `> ${THEME_COUNT_MIN}`, EXCLUDE_THEMES, LEADER_MIN_LIANBAN, PULLBACK_WAIT_CAP, HOLD_MAX, DIVERGENCE_SCAN_CAP },
  themeDays,
  skipped,
  cases,
  stats: { A: buildStats('strategyA'), B: buildStats('strategyB') },
};

// ===== 控制台摘要 =====
console.log(`\n========== 回测摘要（${result.range.start} ~ ${result.range.end}）==========`);
if (ALL_MODE) {
  console.log(`全市场四连板及以上个股（按个股+本轮行情去重）: ${pending.length} 条触发，完成回测 ${cases.length} 个 case，跳过 ${skipped.length} 条`);
} else {
  console.log(`题材爆发日（涨停数>15，非排除题材）: ${result.themeDays.filter(t => t.count > 15 && !t.excluded).length} 个，其中龙头≥4连板: ${cases.length} 个 case`);
}
for (const k of ['A', 'B']) {
  const s = result.stats[k];
  const label = k === 'A' ? 'A 尾盘买入' : 'B 回踩5日线分时买入';
  console.log(`\n[${label}] 有效 case ${s.cases} 个`);
  if (!s.cases) continue;
  console.log(`  盘中最大亏损: 平均 ${pct(s.maxLoss.avg)}，最深 ${pct(s.maxLoss.min)}`);
  console.log(`  二次涨停等待: 平均 ${s.luDays.n ? s.luDays.avg.toFixed(1) : '—'} 个交易日，最长 ${s.luDays.max ?? '—'}，未涨停 ${s.luMissing} 个`);
  console.log(`  持仓5日收益: 平均 ${pct(s.ret5.avg)}，最大 ${pct(s.ret5.max)}${s.ret5Insufficient ? `（${s.ret5Insufficient} 个数据不足）` : ''}`);
  console.log(`  持仓10日收益: 平均 ${pct(s.ret10.avg)}，最大 ${pct(s.ret10.max)}${s.ret10Insufficient ? `（${s.ret10Insufficient} 个数据不足）` : ''}`);
}

// ===== 生成 HTML =====
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cls = (v) => v == null ? '' : (v >= 0 ? 'up' : 'down');
const fmtPctCell = (v, ins) => ins ? '<span class="muted">数据不足</span>' : (v == null ? '—' : `<span class="${cls(v)}">${(v * 100).toFixed(2)}%</span>`);
const fmtLoss = (v) => v == null ? '—' : `<span class="down">${(v * 100).toFixed(2)}%</span>`;

// 单 case 走势小图（首板前2日 → 分歧后12日）：收盘价折线 + MA5 + 事件标记
const chartSvg = (c) => {
  const days = c.runDays;
  if (!days || days.length < 2) return '';
  const W = 760, H = 200, padL = 46, padR = 14, padT = 16, padB = 34;
  const lo = Math.min(...days.map(d => Math.min(d.low, d.ma5 || Infinity))) * 0.985;
  const hi = Math.max(...days.map(d => Math.max(d.high, d.ma5 || 0))) * 1.015;
  const x = (i) => padL + (i / (days.length - 1)) * (W - padL - padR);
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);
  const path = (arr, key) => arr.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const marks = [];
  days.forEach((d, i) => {
    if (d.date === c.firstBoardDate) marks.push({ i, label: '首板', color: '#f5a623' });
    if (d.date === c.triggerDate) marks.push({ i, label: ALL_MODE ? '触发' : '爆发', color: '#e0509a' });
    if (d.date === c.divergenceDate) marks.push({ i, label: '分歧', color: '#4da3ff' });
    if (c.strategyA && d.date === c.strategyA.buyDate) marks.push({ i, label: 'A买', color: '#ff5252' });
    if (c.strategyB && d.date === c.strategyB.buyDate) marks.push({ i, label: 'B买', color: '#00c896' });
  });
  const grid = [];
  for (let g = 0; g <= 4; g++) {
    const p = lo + (hi - lo) * g / 4;
    grid.push(`<line x1="${padL}" y1="${y(p).toFixed(1)}" x2="${W - padR}" y2="${y(p).toFixed(1)}" stroke="rgba(255,255,255,.06)"/><text x="${padL - 6}" y="${(y(p) + 4).toFixed(1)}" fill="#7d8aa0" font-size="10" text-anchor="end">${p.toFixed(2)}</text>`);
  }
  const tickEvery = Math.ceil(days.length / 10);
  const xTicks = days.map((d, i) => (i % tickEvery === 0 ? `<text x="${x(i).toFixed(1)}" y="${H - 12}" fill="#7d8aa0" font-size="9" text-anchor="middle">${d.date.slice(4, 6)}/${d.date.slice(6, 8)}</text>` : '')).join('');
  const markSvg = marks.map(m => `
    <line x1="${x(m.i)}" y1="${padT}" x2="${x(m.i)}" y2="${H - padB}" stroke="${m.color}" stroke-dasharray="3,3" opacity=".55"/>
    <text x="${x(m.i)}" y="${padT - 4}" fill="${m.color}" font-size="10" text-anchor="middle">${m.label}</text>`).join('');
  const candle = days.map((d, i) => {
    const up = d.change >= 0, col = up ? '#e05555' : '#3fae7a';
    const top = y(Math.max(d.open, d.close)), bot = y(Math.min(d.open, d.close));
    return `<line x1="${x(i)}" y1="${y(d.high)}" x2="${x(i)}" y2="${y(d.low)}" stroke="${col}" stroke-width="1"/>` +
      `<rect x="${(x(i) - 3).toFixed(1)}" y="${top.toFixed(1)}" width="6" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px">
    ${grid.join('')}
    ${candle}
    <path d="${path(days, 'ma5')}" fill="none" stroke="#f5c542" stroke-width="1.4" opacity=".9"/>
    <path d="${path(days, 'close')}" fill="none" stroke="#9ecbff" stroke-width="1.8"/>
    ${markSvg}${xTicks}
  </svg>`;
};

const caseRows = (key) => cases.map((c, i) => {
  const m = c[key];
  if (!m) {
    return `<tr><td>${i + 1}</td><td>${esc(c.theme)}</td><td>${fmtDate(c.triggerDate)}</td><td>${esc(c.name)} ${esc(c.code)}</td>
      <td colspan="9" class="muted">${key === 'strategyB' ? `分歧后 ${PULLBACK_WAIT_CAP} 个交易日内未回踩 5 日线，未成交` : '未成交'}</td></tr>`;
  }
  const pb = m.pullback;
  const luCell = m.luDays == null
    ? '<span class="warn">未涨停</span>'
    : `<span class="up">${m.luDays} 天</span> <span class="muted">(${fmtDate(m.luDate).slice(5)} +${m.luChange != null ? m.luChange.toFixed(1) : '?'}%)</span>`;
  return `<tr>
    <td>${i + 1}</td><td>${esc(c.theme)}</td><td>${fmtDate(c.triggerDate)}</td>
    <td>${esc(c.name)}<span class="muted"> ${c.code}</span></td>
    <td>${c.lianbanAtTrigger}连板<br><span class="muted">首板 ${fmtDate(c.firstBoardDate).slice(5)}</span></td>
    <td>${fmtDate(c.divergenceDate).slice(5)}<br><span class="muted">量能 ${c.divergenceVolX}×</span></td>
    <td>${key === 'strategyB' && pb ? `${fmtDate(pb.date).slice(5)}<br><span class="muted">${pb.type} ${pb.minute != null ? String(pb.minute).padStart(4, '0') : ''} / 等${pb.waitDays}天</span>` : fmtDate(m.buyDate).slice(5)}</td>
    <td>${m.buyPrice.toFixed(2)}</td>
    <td>${fmtLoss(m.maxLoss)}<br><span class="muted">${m.maxLossDate ? fmtDate(m.maxLossDate).slice(5) : ''}</span></td>
    <td>${luCell}</td>
    <td>${fmtPctCell(m.ret5, m.ret5Insufficient)}<br><span class="muted">${m.ret5Date ? '卖' + fmtDate(m.ret5Date).slice(5) : ''}</span></td>
    <td>${fmtPctCell(m.ret10, m.ret10Insufficient)}<br><span class="muted">${m.ret10Date ? '卖' + fmtDate(m.ret10Date).slice(5) : ''}</span></td>
  </tr>`;
}).join('');

const statsCards = (key, label) => {
  const s = result.stats[key];
  if (!s.cases) return `<div class="cards"><div class="card"><div class="k">${label}</div><div class="v">0 个成交 case</div></div></div>`;
  return `<div class="cards">
    <div class="card"><div class="k">成交 case</div><div class="v">${s.cases}</div></div>
    <div class="card"><div class="k">盘中最大亏损·平均</div><div class="v down">${pct(s.maxLoss.avg)}</div><div class="s">最深 ${pct(s.maxLoss.min)}</div></div>
    <div class="card"><div class="k">二次涨停等待·平均</div><div class="v">${s.luDays.n ? s.luDays.avg.toFixed(1) + ' 天' : '—'}</div><div class="s">最长 ${s.luDays.max ?? '—'} 天 · 未涨停 ${s.luMissing} 个</div></div>
    <div class="card"><div class="k">持仓5日收益·平均</div><div class="v ${cls(s.ret5.avg)}">${pct(s.ret5.avg)}</div><div class="s">最大 ${pct(s.ret5.max)} / 最小 ${pct(s.ret5.min)}</div></div>
    <div class="card"><div class="k">持仓10日收益·平均</div><div class="v ${cls(s.ret10.avg)}">${pct(s.ret10.avg)}</div><div class="s">最大 ${pct(s.ret10.max)} / 最小 ${pct(s.ret10.min)}</div></div>
  </div>`;
};

const themeDayRows = result.themeDays
  .filter(t => t.count > THEME_COUNT_MIN && !t.excluded)
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((t, i) => `<tr class="${t.qualify ? 'hit' : ''}">
    <td>${i + 1}</td><td>${fmtDate(t.date)}</td><td>${esc(t.theme)}</td><td>${t.count}</td>
    <td>${esc(t.leaderName || '—')}<span class="muted"> ${t.leaderCode || ''}</span></td>
    <td>${t.leaderLianban || '—'}</td>
    <td>${t.qualify ? '<span class="up">入选</span>' : `<span class="muted">${esc(t.reason)}</span>`}</td>
  </tr>`).join('');

const caseBlocks = cases.map((c, i) => {
  const mB = c.strategyB;
  const countTxt = c.themeCount != null ? `（${c.themeCount} 家涨停）` : '';
  const trigTxt = ALL_MODE ? '触发日' : '题材爆发';
  return `<details class="case" ${i === 0 ? 'open' : ''}>
    <summary>#${i + 1} ${fmtDate(c.triggerDate)} ${esc(c.theme)}${countTxt} · ${esc(c.name)} ${c.lianbanAtTrigger}连板 · 分歧 ${fmtDate(c.divergenceDate)}</summary>
    <div class="case-body">
      ${chartSvg(c)}
      <table class="kv">
        <tr><td>${trigTxt}</td><td>${fmtDate(c.triggerDate)}${c.themeCount != null ? ` · ${c.themeCount} 家涨停` : ''}</td><td>个股</td><td>${esc(c.name)}（${c.code}）${c.lianbanAtTrigger}连板 · 题材参考：${esc(c.theme) || '—'}</td></tr>
        <tr><td>本轮首板</td><td>${fmtDate(c.firstBoardDate)}（日K复算 ${c.runBoards} 连板）</td><td>首次分歧</td><td>${fmtDate(c.divergenceDate)} · 量能 ${c.divergenceVolX}× 过去5日均量 · 当日 ${c.divergenceChange}%</td></tr>
        <tr><td>A 尾盘买入</td><td>${fmtDate(c.strategyA.buyDate)} 14:55 @ ${c.strategyA.buyPrice}</td>
            <td>B 回踩买入</td><td>${mB ? `${fmtDate(mB.buyDate)} ${mB.pullback.minute != null ? String(mB.pullback.minute).padStart(4, '0') : ''} @ ${mB.buyPrice}（${mB.pullback.type}，等 ${mB.pullback.waitDays} 天）` : `未回踩 5 日线，未成交`}</td></tr>
        <tr><td>A：最大亏损 / 二板等待 / 5日 / 10日</td>
            <td colspan="3">${fmtLoss(c.strategyA.maxLoss)}（${fmtDate(c.strategyA.maxLossDate).slice(5)}） ·
              ${c.strategyA.luDays == null ? '<span class="warn">未涨停</span>' : `${c.strategyA.luDays} 天(${fmtDate(c.strategyA.luDate).slice(5)})`} ·
              ${fmtPctCell(c.strategyA.ret5, c.strategyA.ret5Insufficient)} · ${fmtPctCell(c.strategyA.ret10, c.strategyA.ret10Insufficient)}</td></tr>
        ${mB ? `<tr><td>B：最大亏损 / 二板等待 / 5日 / 10日</td>
            <td colspan="3">${fmtLoss(mB.maxLoss)}（${fmtDate(mB.maxLossDate).slice(5)}） ·
              ${mB.luDays == null ? '<span class="warn">未涨停</span>' : `${mB.luDays} 天(${fmtDate(mB.luDate).slice(5)})`} ·
              ${fmtPctCell(mB.ret5, mB.ret5Insufficient)} · ${fmtPctCell(mB.ret10, mB.ret10Insufficient)}</td></tr>` : ''}
      </table>
    </div>
  </details>`;
}).join('');

const skippedRows = skipped.map((s, i) => `<tr>
    <td>${i + 1}</td><td>${fmtDate(s.date)}</td><td>${esc(s.theme)}</td><td>${esc(s.name)}<span class="muted"> ${s.code}</span></td>
    <td>${s.lianban}连板</td><td class="muted">${esc(s.reason)}</td>
  </tr>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ALL_MODE ? '全市场四连板个股 · 首次分歧低吸回测' : '题材爆发 · 龙头首次分歧低吸回测'}</title>
<style>
  :root { --bg:#0e1420; --panel:#151d2e; --line:#24304a; --txt:#d7e0ef; --muted:#7d8aa0; --up:#e05555; --down:#3fae7a; --accent:#4da3ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; padding:28px; }
  h1 { font-size:22px; margin:0 0 6px; }
  h2 { font-size:17px; margin:34px 0 12px; border-left:4px solid var(--accent); padding-left:10px; }
  .sub { color:var(--muted); font-size:12.5px; margin-bottom:20px; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; margin:10px 0 6px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 18px; min-width:150px; }
  .card .k { color:var(--muted); font-size:12px; }
  .card .v { font-size:21px; font-weight:600; margin-top:2px; }
  .card .s { color:var(--muted); font-size:11.5px; margin-top:2px; }
  table { border-collapse:collapse; width:100%; background:var(--panel); border-radius:10px; overflow:hidden; font-size:13px; }
  th, td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; white-space:nowrap; }
  th { background:#1a2438; color:#aebad0; font-weight:500; font-size:12px; }
  tr.hit td { background:rgba(77,163,255,.07); }
  .up { color:var(--up); } .down { color:var(--down); } .muted { color:var(--muted); font-size:11.5px; } .warn { color:#f5a623; }
  details.case { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin-bottom:10px; padding:10px 16px; }
  details.case summary { cursor:pointer; font-weight:600; }
  .case-body { margin-top:12px; }
  table.kv { margin-top:10px; font-size:12.5px; }
  table.kv td { white-space:normal; }
  table.kv td:nth-child(odd) { color:var(--muted); width:110px; }
  .note { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; color:var(--muted); font-size:12.5px; }
  .note b { color:var(--txt); }
</style>
</head>
<body>
  <h1>${ALL_MODE ? '全市场四连板个股 · 首次分歧低吸回测' : '题材爆发 · 龙头首次分歧低吸回测'}</h1>
  <div class="sub">${ALL_MODE ? '不看题材效应：全部交易日中连板数 ≥ 4 的个股（按个股+本轮行情去重）' : '入选题材：单日涨停数 &gt; 15（排除 算力/通信/芯片/其他）且龙头 ≥ 4 连板'} · 回测区间 ${fmtDate(result.range.start)} ~ ${fmtDate(result.range.end)}（lianbanSnapshot ${snapshotDates.length} 个交易日） · 生成于 ${esc(result.generatedAt)}</div>

  <h2>策略 A：分歧日尾盘买入（14:55）</h2>
  ${statsCards('A', 'A 尾盘买入')}
  <div style="overflow-x:auto"><table>
    <tr><th>#</th><th>题材</th><th>${ALL_MODE ? '触发日' : '爆发日'}</th><th>${ALL_MODE ? '个股' : '龙头'}</th><th>连板</th><th>分歧日</th><th>买入日</th><th>买入价</th><th>盘中最大亏损</th><th>二次涨停等待</th><th>持仓5日收益</th><th>持仓10日收益</th></tr>
    ${caseRows('strategyA')}
  </table></div>

  <h2>策略 B：回踩 5 日线分时买入（分歧日起 10 个交易日内）</h2>
  ${statsCards('B', 'B 回踩5日线')}
  <div style="overflow-x:auto"><table>
    <tr><th>#</th><th>题材</th><th>${ALL_MODE ? '触发日' : '爆发日'}</th><th>${ALL_MODE ? '个股' : '龙头'}</th><th>连板</th><th>分歧日</th><th>回踩买入日</th><th>买入价</th><th>盘中最大亏损</th><th>二次涨停等待</th><th>持仓5日收益</th><th>持仓10日收益</th></tr>
    ${caseRows('strategyB')}
  </table></div>

  <h2>股票 Case 明细与走势</h2>
  ${caseBlocks || '<div class="note">无入选 case</div>'}
  ${ALL_MODE ? '' : `
  <h2>全部「单日题材涨停数 &gt; 15」爆发日（含被过滤）</h2>
  <div style="overflow-x:auto"><table>
    <tr><th>#</th><th>日期</th><th>题材</th><th>涨停数</th><th>龙头（连板最高）</th><th>连板数</th><th>结果</th></tr>
    ${themeDayRows}
  </table></div>`}
  ${ALL_MODE && skipped.length ? `
  <h2>未完成回测的触发记录（${skipped.length}）</h2>
  <div style="overflow-x:auto"><table>
    <tr><th>#</th><th>日期</th><th>题材</th><th>个股</th><th>连板</th><th>原因</th></tr>
    ${skippedRows}
  </table></div>` : ''}

  <h2>回测口径说明</h2>
  <div class="note">
    <b>入选条件</b>：${ALL_MODE
      ? `不看题材效应，扫描全部交易日中连板数 ≥ ${result.params.LEADER_MIN_LIANBAN}（四连板及以上）的所有个股（反包板按 lianbanCount 连板口径计），同一「个股 + 本轮行情」只保留最早触发日，题材列仅为该股当日所属题材参考。`
      : `单日题材涨停数 &gt; ${result.params.THEME_COUNT_MIN.replace('> ', '')}（排除含「${result.params.EXCLUDE_THEMES.join('/')}」的题材）；题材龙头取当日连板数最高者，连板数 ≥ ${result.params.LEADER_MIN_LIANBAN} 才入选（反包板按 lianbanCount 连板口径计）。`}<br>
    <b>首次分歧</b>：个股本轮第一个涨停板（按日K连续涨停向前复算）起，首个「成交量 &gt; 过去 5 日均量 且 当日未涨停」的交易日。<br>
    <b>策略 A</b>：分歧日 14:55 分时价买入（无分时数据按收盘价）；<b>策略 B</b>：分歧日起 ${result.params.PULLBACK_WAIT_CAP} 个交易日内首个「最低价触及 5 日线」的交易日，按分时触发价买入（开盘低于 5 日线按开盘价；无分时数据按 min(开盘, MA5) 近似）。<br>
    <b>盘中最大亏损</b>：买入时点起至买入后第 ${result.params.HOLD_MAX} 个交易日内的最低价对买入价的最大跌幅（尾盘买入当日按 14:55 后分时最低、无分时按收盘价）。<br>
    <b>二次涨停等待</b>：买入后首个涨停交易日的间隔交易日数（策略B买入日当日涨停记 0 天），扫描至数据末尾仍未涨停则标注「未涨停」。<br>
    <b>持仓收益</b>：买入后第 5 / 第 10 个交易日收盘价对买入价的收益率（=「持仓 N 个交易日」口径）；数据未覆盖则标注「数据不足」。<br>
    <b>数据源</b>：lianbanSnapshot（题材/涨停/连板）、kline_cache 日K（OHLC/量能/MA5，覆盖不足自动重拉）、自选股全量过去分时数据（分时成交与盘中低点）。
  </div>
</body>
</html>`;

fs.writeFileSync(OUT_HTML, html, 'utf-8');
console.log(`\nHTML 已生成: ${OUT_HTML}`);
}

runAll().catch(err => {
  console.error('回测失败:', err.message || err);
  process.exit(1);
});
