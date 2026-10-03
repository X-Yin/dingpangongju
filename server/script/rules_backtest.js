#!/usr/bin/env node
/**
 * 特定规则回测：自选股科技股，在指定时点买入，次交易日 10:00 卖出
 *
 * 场景 1：2026-09-07 09:35 买入 -> 2026-09-08 10:00 卖出
 * 场景 2：2026-09-29 11:30 买入 -> 2026-09-30 10:00 卖出
 *
 * 数据源：server/src/data/backtest_camp_cache/YYYYMMDD.json
 * 输出：同目录下的 rules_backtest_report.html
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.resolve(__dirname, '../src/data/backtest_camp_cache');
const OUT_HTML = path.resolve(__dirname, 'rules_backtest_report.html');

const SCENARIOS = [
  {
    id: 's1',
    label: '场景1：2026-09-07 09:35 买入 → 2026-09-08 10:00 卖出',
    buyDate: '20260907',
    buyTimeKey: '093500',
    sellDate: '20260908',
    sellTimeKey: '100000',
  },
  {
    id: 's2',
    label: '场景2：2026-09-29 11:30 买入 → 2026-09-30 10:00 卖出',
    buyDate: '20260929',
    buyTimeKey: '113000',
    sellDate: '20260930',
    sellTimeKey: '100000',
  },
];

function readCache(date) {
  const fp = path.join(CACHE_DIR, `${date}.json`);
  if (!fs.existsSync(fp)) return null;
  const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
  return obj.data || obj;
}

function buildBucketIndex(buckets) {
  const map = new Map();
  for (const b of buckets) {
    if (b.timeKey) map.set(b.timeKey, b);
  }
  return map;
}

function buildStockMap(stockChanges) {
  const m = new Map();
  for (const s of stockChanges || []) m.set(s.code, s);
  return m;
}

/**
 * 返回缓存目录中 buyDate 之前最近 N 个交易日的日期字符串（YYYYMMDD）
 * 排序：最近的在前。若不足 N 个则返回可用的全部。
 */
function findPrevTradingDays(buyDate, n = 2) {
  const all = fs
    .readdirSync(CACHE_DIR)
    .filter(f => f.endsWith('.json') && !f.includes('.nomfund.'))
    .map(f => f.replace(/\.json$/, ''))
    .filter(d => d < buyDate)
    .sort((a, b) => b.localeCompare(a));
  return all.slice(0, n);
}

/**
 * 取某日期缓存里收盘 bucket（最后一个 timeBucket）的 changePct map：code -> changePct
 */
function buildClosePctMap(date) {
  const data = readCache(date);
  if (!data) return new Map();
  const lastBucket = (data.timeBuckets || []).slice(-1)[0];
  if (!lastBucket) return new Map();
  const m = new Map();
  for (const s of lastBucket.stockChanges || []) {
    m.set(s.code, s.changePct);
  }
  return m;
}

/**
 * 构造一张回测结果表
 * @returns {{ rows: [], summary: {} }}
 */
function runScenario(sc) {
  const buyData = readCache(sc.buyDate);
  const sellData = readCache(sc.sellDate);
  if (!buyData || !sellData) {
    console.error(`[${sc.label}] 缓存缺失`);
    return { rows: [], summary: { skip: true } };
  }
  const buyBuckets = buildBucketIndex(buyData.timeBuckets || []);
  const sellBuckets = buildBucketIndex(sellData.timeBuckets || []);

  const buyBucket = buyBuckets.get(sc.buyTimeKey);
  const sellBucket = sellBuckets.get(sc.sellTimeKey);
  const closeBucketBuyDay = (buyData.timeBuckets || []).slice(-1)[0]; // 买入日收盘

  if (!buyBucket || !sellBucket || !closeBucketBuyDay) {
    console.error(`[${sc.label}] 某个时点 bucket 缺失`);
    return { rows: [], summary: { skip: true } };
  }

  // 前两个交易日收盘涨幅（从缓存目录动态推导交易日）
  const prevDays = findPrevTradingDays(sc.buyDate, 2);
  const prevMaps = prevDays.map(d => buildClosePctMap(d));
  const prevDayLabels = prevDays.map(d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);

  // 自选股（科技股）= monitorStocks 交集
  const watchlist = buyData.monitorStocks || [];
  const buyStockMap = buildStockMap(buyBucket.stockChanges);
  const sellStockMap = buildStockMap(sellBucket.stockChanges);
  const closeStockMap = buildStockMap(closeBucketBuyDay.stockChanges);

  const rows = [];
  for (const stk of watchlist) {
    const code = stk.code;
    const name = stk.name;
    const buy = buyStockMap.get(code);
    const sell = sellStockMap.get(code);
    const closeBuyDay = closeStockMap.get(code);

    if (!buy || !sell || !closeBuyDay) {
      continue;
    }

    const buyPx = buy.lastPx;
    const sellPx = sell.lastPx;
    const closePx = closeBuyDay.lastPx;

    // changePct 在缓存中已经是百分点（如 1.02 表示 1.02%）
    const buyGain = buy.changePct;
    const closeGain = closeBuyDay.changePct;
    const sellNextGain = sell.changePct;

    const dayReturn = closePx / buyPx - 1;         // 比例（如 0.0166）
    const nextDayReturn = sellPx / closePx - 1;
    const overallReturn = sellPx / buyPx - 1;

    // 前两交易日涨幅和（缺失按 0 算，保证可加总）
    const prevTwoDayGain = prevMaps.reduce((sum, m) => sum + (m.get(code) || 0), 0);

    rows.push({
      code, name,
      buyPx, sellPx, closePx,
      buyGain, closeGain, sellNextGain,
      dayReturn, nextDayReturn, overallReturn,
      prevTwoDayGain,
    });
  }

  // 汇总
  const n = rows.length;
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const wins = (arr) => arr.filter(x => x > 0).length;

  const summary = {
    count: n,
    avgDayReturn: avg(rows.map(r => r.dayReturn)),
    avgNextDayReturn: avg(rows.map(r => r.nextDayReturn)),
    avgOverallReturn: avg(rows.map(r => r.overallReturn)),
    winRate: wins(rows.map(r => r.overallReturn)) / n,
    maxWin: rows.reduce((m, r) => (r.overallReturn > m.overallReturn ? r : m), rows[0]),
    maxLoss: rows.reduce((m, r) => (r.overallReturn < m.overallReturn ? r : m), rows[0]),
    skip: false,
  };

  return { rows, summary };
}

// 缓存 changePct 类字段（已是百分点，3.26 表示 3.26%）
function fmtPctDirect(x, digits = 2) {
  if (x == null || isNaN(x)) return '-';
  const s = x.toFixed(digits);
  return (x >= 0 ? '+' : '') + s + '%';
}
// 收益率类字段（是比例，0.03 表示 3%）
function fmtPctRatio(x, digits = 2) {
  if (x == null || isNaN(x)) return '-';
  const v = x * 100;
  const s = v.toFixed(digits);
  return (v >= 0 ? '+' : '') + s + '%';
}

function pctClass(x) {
  if (x == null || isNaN(x)) return 'c-neutral';
  if (x > 0) return 'c-up';
  if (x < 0) return 'c-down';
  return 'c-neutral';
}

function buildHtml(results) {
  const tableHtml = (title, res) => {
    if (res.summary?.skip) {
      return `<section class="scene"><h2>${title}</h2><div class="skip">缓存缺失，跳过</div></section>`;
    }
    const s = res.summary;
    const summaryBox = `
      <div class="summary">
        <div class="sum-item"><span class="sum-label">参与只数</span><span class="sum-val">${s.count}</span></div>
        <div class="sum-item"><span class="sum-label">平均当天收益</span><span class="sum-val ${pctClass(s.avgDayReturn)}">${fmtPctRatio(s.avgDayReturn)}</span></div>
        <div class="sum-item"><span class="sum-label">平均次日收益</span><span class="sum-val ${pctClass(s.avgNextDayReturn)}">${fmtPctRatio(s.avgNextDayReturn)}</span></div>
        <div class="sum-item"><span class="sum-label">平均整体收益</span><span class="sum-val ${pctClass(s.avgOverallReturn)}">${fmtPctRatio(s.avgOverallReturn)}</span></div>
        <div class="sum-item"><span class="sum-label">胜率</span><span class="sum-val">${(s.winRate * 100).toFixed(1)}%</span></div>
        <div class="sum-item"><span class="sum-label">最佳</span><span class="sum-val c-up">${s.maxWin.code} ${fmtPctRatio(s.maxWin.overallReturn)}</span></div>
        <div class="sum-item"><span class="sum-label">最差</span><span class="sum-val c-down">${s.maxLoss.code} ${fmtPctRatio(s.maxLoss.overallReturn)}</span></div>
      </div>`;

    // 每行数据为数组，渲染时再补齐 class（HTML 内用 JS 控制排序更方便）
    const rowsJson = JSON.stringify(res.rows);
    return `
      <section class="scene">
        <h2>${title}</h2>
        ${summaryBox}
        <div class="tbl-wrap">
          <table class="sortable" data-rows='${rowsJson}'>
            <thead>
              <tr>
                <th data-col="code" data-col-type="str">代码</th>
                <th data-col="name" data-col-type="str">名称</th>
                <th data-col="buyGain" data-col-type="pct">买入时涨幅</th>
                <th data-col="closeGain" data-col-type="pct">收盘涨幅</th>
                <th data-col="dayReturn" data-col-type="ratio">当天收益率</th>
                <th data-col="sellNextGain" data-col-type="pct">次日10:00涨幅</th>
                <th data-col="nextDayReturn" data-col-type="ratio">次日收益率</th>
                <th data-col="overallReturn" data-col-type="ratio">整体收益率</th>
                <th data-col="prevTwoDayGain" data-col-type="pct">前两日涨幅和</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>`;
  };

  const sections = results.map(r => tableHtml(r.label, r.result)).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>特定规则回测报告</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #0f1320; color: #d1d5db;
  }
  h1 { font-size: 22px; margin: 0 0 12px 0; color: #fff; }
  .intro { font-size: 13px; color: #8892a4; margin-bottom: 20px; line-height: 1.7; }
  h2 { font-size: 16px; margin: 0 0 14px 0; color: #fff; padding-bottom: 8px; border-bottom: 1px solid #1e2538; }
  .scene { margin-bottom: 32px; }
  .skip { padding: 12px; color: #999; background: #1a2030; border-radius: 8px; font-size: 13px; }
  .summary {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px; margin-bottom: 14px;
  }
  .sum-item {
    background: #1a2030; border-radius: 8px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .sum-label { font-size: 12px; color: #8892a4; }
  .sum-val { font-size: 15px; font-weight: 600; color: #e6e9ef; }
  .tbl-wrap { overflow-x: auto; border: 1px solid #1e2538; border-radius: 10px; }
  table.sortable {
    width: 100%; border-collapse: collapse;
    font-size: 13px; background: #141824;
  }
  table.sortable thead th {
    position: sticky; top: 0;
    background: #1b2133; color: #c8cdd8;
    padding: 10px 12px; text-align: right; font-weight: 600;
    cursor: pointer; user-select: none; white-space: nowrap;
    border-bottom: 1px solid #2a3248;
  }
  table.sortable thead th:first-child, table.sortable thead th:nth-child(2) { text-align: left; }
  table.sortable thead th:hover { color: #fff; background: #222a42; }
  table.sortable thead th.asc::after { content: ' ▲'; font-size: 11px; color: #f59e0b; }
  table.sortable thead th.desc::after { content: ' ▼'; font-size: 11px; color: #f59e0b; }
  table.sortable tbody td {
    padding: 8px 12px; text-align: right;
    border-bottom: 1px solid #1e2538; white-space: nowrap;
  }
  table.sortable tbody td:first-child, table.sortable tbody td:nth-child(2) { text-align: left; }
  table.sortable tbody tr:hover { background: #1a2030; }
  .c-up { color: #ef4444; }
  .c-down { color: #10b981; }
  .c-neutral { color: #9aa0ae; }
  .code-link { color: #60a5fa; text-decoration: none; }
</style>
</head>
<body>
  <h1>特定规则回测报告 — 自选股科技股时点买入 / 次日10:00卖出</h1>
  <div class="intro">
    数据源：server/src/data/backtest_camp_cache 下的训练营地级缓存。
    股票范围：当日 monitorStocks 全量自选科技股。
    收益率口径：卖出 lastPx / 买入 lastPx − 1（未计手续费）。
    点击表头即可在「从高到低 ↔ 从低到高」间切换排序。
  </div>
  ${sections}

<script>
(function() {
  // type: 'pct' 已是百分点(3.26=3.26%)；'ratio' 是比例(0.03=3%)；其它当作字符串
  const pct = (x, type, digits) => {
    digits = digits || 2;
    if (x == null || isNaN(x)) return '-';
    let v = x;
    if (type === 'ratio') v = v * 100;
    const s = v.toFixed(digits);
    return (v >= 0 ? '+' : '') + s + '%';
  };
  const cls = (x, type) => {
    if (x == null || isNaN(x)) return 'c-neutral';
    let v = x;
    if (type === 'ratio') v = v * 100;
    if (v > 0) return 'c-up';
    if (v < 0) return 'c-down';
    return 'c-neutral';
  };
  const COL_TYPE = {
    code: 'str', name: 'str',
    buyGain: 'pct', closeGain: 'pct', sellNextGain: 'pct', prevTwoDayGain: 'pct',
    dayReturn: 'ratio', nextDayReturn: 'ratio', overallReturn: 'ratio',
  };
  const render = (tbody, rows) => {
    tbody.innerHTML = rows.map(r => \`
      <tr>
        <td><span class="code-link">\${r.code}</span></td>
        <td>\${r.name}</td>
        <td class="\${cls(r.buyGain, COL_TYPE.buyGain)}">\${pct(r.buyGain, COL_TYPE.buyGain)}</td>
        <td class="\${cls(r.closeGain, COL_TYPE.closeGain)}">\${pct(r.closeGain, COL_TYPE.closeGain)}</td>
        <td class="\${cls(r.dayReturn, COL_TYPE.dayReturn)}">\${pct(r.dayReturn, COL_TYPE.dayReturn)}</td>
        <td class="\${cls(r.sellNextGain, COL_TYPE.sellNextGain)}">\${pct(r.sellNextGain, COL_TYPE.sellNextGain)}</td>
        <td class="\${cls(r.nextDayReturn, COL_TYPE.nextDayReturn)}">\${pct(r.nextDayReturn, COL_TYPE.nextDayReturn)}</td>
        <td class="\${cls(r.overallReturn, COL_TYPE.overallReturn)}">\${pct(r.overallReturn, COL_TYPE.overallReturn)}</td>
        <td class="\${cls(r.prevTwoDayGain, COL_TYPE.prevTwoDayGain)}">\${pct(r.prevTwoDayGain, COL_TYPE.prevTwoDayGain)}</td>
      </tr>\`).join('');
  };

  document.querySelectorAll('table.sortable').forEach(table => {
    const rows = JSON.parse(table.dataset.rows || '[]');
    const tbody = table.querySelector('tbody');
    let state = { col: 'overallReturn', dir: 'desc' };

    const applySort = () => {
      const col = state.col;
      const dir = state.dir;
      const sorted = [...rows].sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string' && typeof bv === 'string') {
          return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        }
        return dir === 'asc' ? av - bv : bv - av;
      });
      render(tbody, sorted);
      table.querySelectorAll('thead th').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.col === col) th.classList.add(dir);
      });
    };

    table.querySelectorAll('thead th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (state.col === col) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.col = col;
          state.dir = 'desc';
        }
        applySort();
      });
    });

    applySort();
  });
})();
</script>
</body>
</html>`;
}

// ============ main ============
const results = SCENARIOS.map(sc => ({ label: sc.label, result: runScenario(sc) }));

// 控制台打印汇总
for (const r of results) {
  const s = r.result.summary;
  if (s?.skip) {
    console.log(`\n[${r.label}] 缓存缺失`);
    continue;
  }
  console.log(`\n=== ${r.label} ===`);
  console.log(`参与只数: ${s.count}`);
  console.log(`平均当天收益: ${fmtPctRatio(s.avgDayReturn)}`);
  console.log(`平均次日收益: ${fmtPctRatio(s.avgNextDayReturn)}`);
  console.log(`平均整体收益: ${fmtPctRatio(s.avgOverallReturn)}`);
  console.log(`胜率: ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`最佳: ${s.maxWin.code} ${s.maxWin.name} ${fmtPctRatio(s.maxWin.overallReturn)}`);
  console.log(`最差: ${s.maxLoss.code} ${s.maxLoss.name} ${fmtPctRatio(s.maxLoss.overallReturn)}`);
}

const html = buildHtml(results);
fs.writeFileSync(OUT_HTML, html, 'utf8');
console.log(`\nHTML 已生成: ${OUT_HTML}`);
