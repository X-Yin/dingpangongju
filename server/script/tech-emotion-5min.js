#!/usr/bin/env node
/**
 * 科技情绪指数 5 分钟粒度回溯脚本
 *
 * 用法：node script/tech-emotion-5min.js [YYYYMMDD]   （默认 20261013）
 * 产出：script/tech_emotion_{YYYYMMDD}_5min.html（自包含折线图，无外部依赖，双击即可打开）
 *
 * 口径与 src/service/emotion.js 实时路径、src/service/trainingCamp.js 回放桶级口径完全一致：
 *   ① 科技股（自选股 isTech !== false）分时涨幅 ÷ 所属板块涨跌幅限制 × 100，截断 [-100, 100]
 *   ② 基础情绪 = 上述得分的市值加权平均（权重因子 = 总股本 × 分时当时价 / 线内平均市值）
 *   ③ 科技情绪 = 基础情绪 + 冲高回落惩罚 × 0.2，截断 [-100, 100]
 *      冲高回落惩罚取创业板指(sz399006)/科创50(sh000688) 自当日最高涨幅的回落幅度（按各桶截至分钟的实时高点）
 *
 * 桶骨架：交易时段每 5 分钟一个桶（09:35 ~ 11:30、13:05 ~ 15:00，共 48 桶，与盯盘/回放标签口径一致）。
 */
const fs = require('fs');
const path = require('path');
const { getMonitorStocks } = require('../src/service/monitorStock');
const { getSingleStockTlineDataByDate } = require('../src/service/stock');
const {
  computeTechEmotionV2Base,
  computeTechEmotionV2,
  computePullbackPenaltyFromPullback,
} = require('../src/service/emotion');
const { batchParallel } = require('../src/utils');

const DEFAULT_DATE = '20261013';
const CYB_CODE = 'sz399006'; // 创业板指
const KCB_CODE = 'sh000688'; // 科创50

// 5 分钟桶：09:35~11:30 + 13:05~15:00（不含 9:30/13:00，与前端 5 分钟聚合标签口径一致）
// 按 HHMM 语义步进（避免 09:55 → 09:60 这类非法时刻）
const buildBucketMinutes = (start, end) => {
  const out = [];
  let h = Math.floor(start / 100);
  let m = start % 100;
  const endH = Math.floor(end / 100);
  const endM = end % 100;
  while (h < endH || (h === endH && m <= endM)) {
    out.push(h * 100 + m);
    m += 5;
    if (m >= 60) { h += 1; m -= 60; }
  }
  return out;
};
const BUCKET_MINUTES = [...buildBucketMinutes(935, 1130), ...buildBucketMinutes(1305, 1500)];

const fmtMinute = (minute) => `${String(Math.floor(minute / 100)).padStart(2, '0')}:${String(minute % 100).padStart(2, '0')}`;

// 由分时原始 line 构造 { minute, lastPx, changePct } 升序序列（changePct 相对昨收）
const buildSortedLine = (tlineData) => {
  const preclose = parseFloat(tlineData?.preclose_px);
  if (!preclose || preclose <= 0) return null;
  const line = (tlineData.line || [])
    .filter(p => p.minute && p.last_px != null)
    .map(p => {
      const lastPx = parseFloat(p.last_px);
      return {
        minute: parseInt(p.minute, 10),
        lastPx,
        changePct: parseFloat((((lastPx - preclose) / preclose) * 100).toFixed(2)),
      };
    })
    .filter(p => Number.isFinite(p.minute) && Number.isFinite(p.lastPx))
    .sort((a, b) => a.minute - b.minute);
  return line.length > 0 ? line : null;
};

// 取不晚于 minute 的最后一个分时点
const findPoint = (line, minute) => {
  let point = null;
  for (const p of line) {
    if (p.minute <= minute) point = p;
    else break;
  }
  return point;
};

// 回溯指定日期当天的 5 分钟桶科技情绪序列（供本脚本 CLI 与 script/refresh-tech-index-ice.js 复用）
// 返回 { date, buckets, stockCount, indexOk }
const computeDayBuckets = async (dateStr) => {
  const dateInt = parseInt(dateStr, 10);
  const stocks = getMonitorStocks().filter(s => s.isTech !== false);

  const stockResults = await batchParallel(stocks, async (st) => {
    try {
      const tlineData = await getSingleStockTlineDataByDate(st.code, dateInt);
      const line = tlineData ? buildSortedLine(tlineData) : null;
      return line ? { code: st.code, name: st.name || st.code, line } : null;
    } catch (e) {
      console.error(`  ! ${st.code} 分时拉取失败：${e.message}`);
      return null;
    }
  }, 10);
  const stockLines = stockResults.filter(Boolean);

  const [cybTline, kcbTline] = await Promise.all([
    getSingleStockTlineDataByDate(CYB_CODE, dateInt).catch(() => null),
    getSingleStockTlineDataByDate(KCB_CODE, dateInt).catch(() => null),
  ]);
  const cybLine = cybTline ? buildSortedLine(cybTline) : null;
  const kcbLine = kcbTline ? buildSortedLine(kcbTline) : null;

  // 按桶逐点回溯：指数高点随桶推进（只用截至当前桶的实时高点，不引入未来数据）
  let cybMaxChange = null;
  let kcbMaxChange = null;
  const buckets = BUCKET_MINUTES.map(minute => {
    const cybPoint = cybLine ? findPoint(cybLine, minute) : null;
    const kcbPoint = kcbLine ? findPoint(kcbLine, minute) : null;
    if (cybPoint && (cybMaxChange === null || cybPoint.changePct > cybMaxChange)) cybMaxChange = cybPoint.changePct;
    if (kcbPoint && (kcbMaxChange === null || kcbPoint.changePct > kcbMaxChange)) kcbMaxChange = kcbPoint.changePct;

    const techItems = stockLines
      .map(st => {
        const p = findPoint(st.line, minute);
        return p ? { code: st.code, change: p.changePct, price: p.lastPx } : null;
      })
      .filter(Boolean);

    const baseEmotion = computeTechEmotionV2Base(techItems);

    const pullbacks = [];
    if (cybPoint && cybMaxChange !== null) pullbacks.push(cybPoint.changePct - cybMaxChange);
    if (kcbPoint && kcbMaxChange !== null) pullbacks.push(kcbPoint.changePct - kcbMaxChange);
    const avgPullback = pullbacks.length > 0 ? pullbacks.reduce((a, b) => a + b, 0) / pullbacks.length : 0;
    const pullbackPenalty = computePullbackPenaltyFromPullback(avgPullback);
    const value = computeTechEmotionV2(baseEmotion, pullbackPenalty);

    return {
      minute,
      time: fmtMinute(minute),
      value,
      baseEmotion,
      pullbackPenalty,
      avgPullback: parseFloat(avgPullback.toFixed(2)),
      stockCount: techItems.length,
      cybChange: cybPoint ? cybPoint.changePct : null,
      kcbChange: kcbPoint ? kcbPoint.changePct : null,
    };
  });

  return { date: dateStr, buckets, stockCount: stockLines.length, indexOk: !!(cybLine && kcbLine) };
};

const main = async () => {
  const DATE = process.argv[2] || DEFAULT_DATE;
  console.log(`[科技情绪5分钟回溯] 日期 ${DATE}`);
  const { buckets, stockCount, indexOk } = await computeDayBuckets(DATE);
  if (!indexOk) console.warn('  ! 指数分时缺失，回落惩罚按缺省值 0 计算');

  console.log(`数据点 ${buckets.length} 个（复权股票 ${stockCount} 只）：`);
  buckets.forEach(b => console.log(`  ${b.time}  情绪 ${String(b.value).padStart(7)}  基础 ${String(b.baseEmotion).padStart(7)}  惩罚 ${String(b.pullbackPenalty).padStart(7)}  个股 ${b.stockCount}`));

  const outFile = path.join(__dirname, `tech_emotion_${DATE}_5min.html`);
  fs.writeFileSync(outFile, buildHtml(buckets, stockCount, DATE), 'utf-8');
  console.log(`\n已生成：${outFile}`);
};

if (require.main === module) {
  main().catch(e => {
    console.error('回溯失败：', e);
    process.exit(1);
  });
}

module.exports = { computeDayBuckets, BUCKET_MINUTES };

function buildHtml(buckets, stockCount, dateStr) {
  const dateDisplay = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>科技情绪指数 5分钟回溯 ${dateDisplay}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 24px; color: #262626; }
  .page-header { max-width: 1280px; margin: 0 auto 16px; }
  .page-header h1 { font-size: 22px; }
  .page-header .sub { font-size: 13px; color: #8c8c8c; margin-top: 6px; line-height: 1.7; }
  .summary { max-width: 1280px; margin: 0 auto 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat { background: #fff; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .stat .label { font-size: 12px; color: #8c8c8c; }
  .stat .val { font-size: 22px; font-weight: 600; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .stat .extra { font-size: 12px; color: #bfbfbf; margin-top: 2px; }
  .up { color: #f5222d; }
  .down { color: #52c41a; }
  .chart-card { max-width: 1280px; margin: 0 auto 16px; background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .chart-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 6px; }
  .chart-title::before { content: ''; width: 3px; height: 14px; background: #722ed1; border-radius: 2px; }
  #chart-container { position: relative; width: 100%; height: 460px; }
  #chart-container svg { display: block; }
  .chart-tooltip { position: absolute; pointer-events: none; display: none; background: #fff; border: 1px solid #eee; border-radius: 6px; box-shadow: 0 3px 14px rgba(0,0,0,0.15); padding: 10px 12px; font-size: 12px; z-index: 10; min-width: 168px; }
  .tooltip-title { font-weight: 600; margin-bottom: 6px; }
  .tooltip-item { display: flex; justify-content: space-between; gap: 16px; line-height: 20px; }
  .tooltip-item .label { color: #8c8c8c; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #f0f0f0; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #8c8c8c; font-weight: 500; background: #fafafa; position: sticky; top: 0; }
  tbody tr:hover { background: #fafafa; }
</style>
</head>
<body>
<div class="page-header">
  <h1>科技情绪指数 · 5 分钟粒度回溯</h1>
  <div class="sub">
    日期：${dateDisplay}（${buckets.length} 个 5 分钟桶，参与计算科技股 ${stockCount} 只）<br>
    V2 口径：个股涨幅 ÷ 板块涨跌幅限制 × 100 → 市值加权平均（基础情绪） + 创业板指/科创50 冲高回落惩罚 × 0.2<br>
    生成时间：${generatedAt}
  </div>
</div>

<div class="summary" id="summary"></div>

<div class="chart-card">
  <div class="chart-title">当日分时情绪走势</div>
  <div id="chart-container">
    <div class="chart-tooltip" id="tooltip"></div>
  </div>
</div>

<div class="chart-card">
  <div class="chart-title">数据明细</div>
  <div style="max-height: 520px; overflow: auto;">
    <table>
      <thead>
        <tr>
          <th>时间</th><th>科技情绪</th><th>基础情绪</th><th>回落惩罚</th><th>平均回落(pp)</th><th>创业板指</th><th>科创50</th><th>个股数</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</div>

<script>
const BUCKETS = /*__DATA__*/;

const COLOR_MAIN = '#722ed1';
const COLOR_ZERO = '#d9d9d9';
const PAD = { top: 24, right: 56, bottom: 34, left: 52 };
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

const container = document.getElementById('chart-container');
const tooltip = document.getElementById('tooltip');

function renderSummary() {
  const first = BUCKETS[0], last = BUCKETS[BUCKETS.length - 1];
  let max = BUCKETS[0], min = BUCKETS[0];
  BUCKETS.forEach(b => { if (b.value > max.value) max = b; if (b.value < min.value) min = b; });
  const change = Number((last.value - first.value).toFixed(2));
  const items = [
    { label: '开盘情绪（' + first.time + '）', val: first.value, extra: '基础 ' + fmt(first.baseEmotion) },
    { label: '收盘情绪（' + last.time + '）', val: last.value, extra: '基础 ' + fmt(last.baseEmotion) },
    { label: '当日最高', val: max.value, extra: max.time },
    { label: '当日最低', val: min.value, extra: min.time },
    { label: '首尾变化（收盘 − 开盘）', val: change, extra: '' },
  ];
  document.getElementById('summary').innerHTML = items.map(it =>
    '<div class="stat"><div class="label">' + it.label + '</div>' +
    '<div class="val ' + cls(it.val) + '">' + fmt(it.val) + '</div>' +
    (it.extra ? '<div class="extra">' + it.extra + '</div>' : '') + '</div>'
  ).join('');
}

let chartGeom = null;

function renderChart() {
  const width = container.clientWidth || 1200;
  const height = 460;
  const values = BUCKETS.map(b => b.value);
  let vMax = Math.max(100, Math.ceil((Math.max(...values) + 8) / 10) * 10);
  let vMin = Math.min(-100, Math.floor((Math.min(...values) - 8) / 10) * 10);
  const x = (i) => PAD.left + (BUCKETS.length <= 1 ? 0 : i * (width - PAD.left - PAD.right) / (BUCKETS.length - 1));
  const y = (v) => PAD.top + (vMax - v) * (height - PAD.top - PAD.bottom) / (vMax - vMin);

  let svg = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">';
  // 横向网格与刻度
  for (let v = vMin; v <= vMax; v += 25) {
    const yy = y(v);
    svg += '<line x1="' + PAD.left + '" y1="' + yy + '" x2="' + (width - PAD.right) + '" y2="' + yy + '" stroke="#f0f0f0" stroke-width="1"/>';
    svg += '<text x="' + (PAD.left - 8) + '" y="' + (yy + 4) + '" font-size="11" fill="#8c8c8c" text-anchor="end">' + v + '</text>';
  }
  // 0 轴
  svg += '<line x1="' + PAD.left + '" y1="' + y(0) + '" x2="' + (width - PAD.right) + '" y2="' + y(0) + '" stroke="' + COLOR_ZERO + '" stroke-width="1.5" stroke-dasharray="4 4"/>';
  // x 轴刻度（每 4 个桶 + 最后一个）
  const xLabels = [];
  for (let i = 0; i < BUCKETS.length; i++) {
    if (i % 4 === 0 || i === BUCKETS.length - 1) xLabels.push(i);
  }
  xLabels.forEach(i => {
    svg += '<text x="' + x(i) + '" y="' + (height - 10) + '" font-size="11" fill="#8c8c8c" text-anchor="middle">' + BUCKETS[i].time + '</text>';
  });
  // 折线 + 面积
  const pts = BUCKETS.map((b, i) => [x(i), y(b.value)]);
  const areaPath = 'M' + pts[0][0] + ',' + y(0) + ' L' + pts.map(p => p[0] + ',' + p[1]).join(' L') + ' L' + pts[pts.length - 1][0] + ',' + y(0) + ' Z';
  svg += '<path d="' + areaPath + '" fill="rgba(114,46,209,0.07)" stroke="none"/>';
  svg += '<path d="' + 'M' + pts.map(p => p[0] + ',' + p[1]).join(' L') + '" fill="none" stroke="' + COLOR_MAIN + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
  pts.forEach(p => { svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.5" fill="' + COLOR_MAIN + '" stroke="#fff" stroke-width="1"/>'; });
  // 最后一个点标记
  svg += '<circle cx="' + pts[pts.length - 1][0] + '" cy="' + pts[pts.length - 1][1] + '" r="4.5" fill="#fff" stroke="' + COLOR_MAIN + '" stroke-width="2.5"/>';
  // hover 辅助线
  svg += '<line id="cross-v" x1="0" y1="' + PAD.top + '" x2="0" y2="' + (height - PAD.bottom) + '" stroke="#d9d9d9" stroke-width="1" style="display:none"/>';
  svg += '<circle id="dot-hover" r="5" fill="' + COLOR_MAIN + '" stroke="#fff" stroke-width="2" style="display:none"/>';
  svg += '</svg>';

  container.querySelectorAll('svg').forEach(el => el.remove());
  const div = document.createElement('div');
  div.innerHTML = svg;
  container.insertBefore(div.firstChild, tooltip);
  chartGeom = { x, y, width, height };
}

function bindHover() {
  container.addEventListener('mousemove', (e) => {
    if (!chartGeom) return;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const { x, y, width } = chartGeom;
    let nearest = 0, minDist = Infinity;
    for (let i = 0; i < BUCKETS.length; i++) {
      const d = Math.abs(x(i) - mx);
      if (d < minDist) { minDist = d; nearest = i; }
    }
    const b = BUCKETS[nearest];
    const svg = container.querySelector('svg');
    const crossV = svg.querySelector('#cross-v');
    const dot = svg.querySelector('#dot-hover');
    crossV.setAttribute('x1', x(nearest));
    crossV.setAttribute('x2', x(nearest));
    crossV.style.display = '';
    dot.setAttribute('cx', x(nearest));
    dot.setAttribute('cy', y(b.value));
    dot.style.display = '';

    tooltip.style.display = 'block';
    const tw = 190;
    const left = Math.min(Math.max(x(nearest) + 14, 8), width - tw - 8);
    tooltip.style.left = left + 'px';
    tooltip.style.top = Math.max(y(b.value) - 90, 8) + 'px';
    tooltip.innerHTML =
      '<div class="tooltip-title">' + b.time + '　情绪 <span class="' + cls(b.value) + '">' + fmt(b.value) + '</span></div>' +
      '<div class="tooltip-item"><span class="label">基础情绪</span><span class="' + cls(b.baseEmotion) + '">' + fmt(b.baseEmotion) + '</span></div>' +
      '<div class="tooltip-item"><span class="label">回落惩罚</span><span class="' + cls(b.pullbackPenalty) + '">' + fmt(b.pullbackPenalty) + '</span></div>' +
      '<div class="tooltip-item"><span class="label">创业板指</span><span class="' + cls(b.cybChange) + '">' + fmt(b.cybChange) + '</span></div>' +
      '<div class="tooltip-item"><span class="label">科创50</span><span class="' + cls(b.kcbChange) + '">' + fmt(b.kcbChange) + '</span></div>' +
      '<div class="tooltip-item"><span class="label">个股数</span><span>' + b.stockCount + '</span></div>';
  });
  container.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    const svg = container.querySelector('svg');
    if (svg) {
      svg.querySelector('#cross-v').style.display = 'none';
      svg.querySelector('#dot-hover').style.display = 'none';
    }
  });
}

function renderTable() {
  document.getElementById('tbody').innerHTML = BUCKETS.map(b =>
    '<tr><td>' + b.time + '</td>' +
    '<td class="' + cls(b.value) + '">' + fmt(b.value) + '</td>' +
    '<td class="' + cls(b.baseEmotion) + '">' + fmt(b.baseEmotion) + '</td>' +
    '<td class="' + cls(b.pullbackPenalty) + '">' + fmt(b.pullbackPenalty) + '</td>' +
    '<td>' + fmt(b.avgPullback) + '</td>' +
    '<td class="' + cls(b.cybChange) + '">' + fmt(b.cybChange) + '</td>' +
    '<td class="' + cls(b.kcbChange) + '">' + fmt(b.kcbChange) + '</td>' +
    '<td>' + b.stockCount + '</td></tr>'
  ).join('');
}

function renderAll() { renderSummary(); renderChart(); renderTable(); }
renderAll();
bindHover();
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderChart(); }, 150);
});
</script>
</body>
</html>
`;
  // 注入回溯结果（数据为纯数值 JSON，无需转义）
  return html.replace('/*__DATA__*/', JSON.stringify(buckets));
}
