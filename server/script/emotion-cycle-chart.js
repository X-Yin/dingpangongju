/**
 * 四维立体 · 情绪周期可视化（离线 HTML）
 *
 * 模仿 盯盘工具/src/pages/fupan/SiweiLiti.jsx 中的「情绪周期」模块：
 *   - 大盘情绪周期（连板快照情绪温度 0~100）
 *   - 板块情绪周期（每个板块单独一张折线图，不合并）
 *
 * 日期范围：2026-07-01 ~ 2026-11-06
 *
 * 用法：
 *   node server/script/emotion-cycle-chart.js
 *
 * 输出：
 *   server/script/emotion-cycle-chart.html（与脚本同级）
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { calcPhase } = require('../src/service/emotionCyclePhase');

const API_URL = 'http://localhost:3000/siwei_liti_analysis';
const OUTPUT_FILE = path.join(__dirname, 'emotion-cycle-chart.html');

// 日期范围（YYYYMMDD）
const START_DATE = 20260701;
const END_DATE = 20261106;

// 请求足够大的窗口以覆盖 7.1 ~ 11.6（约 88 个交易日）
const WINDOW_DAYS = 100;

// 板块情绪周期阶段分值
const PHASE_SCORE = {
  一致加速: 4,
  全面高潮: 3,
  爆量分歧: 2,
  弱势震荡: 1,
  退潮: 0,
};
const PHASE_NAMES = ['退潮', '弱势震荡', '爆量分歧', '全面高潮', '一致加速'];

// 板块情绪周期配色
const SECTOR_PHASE_COLOR = {
  全面高潮: '#f43f5e',
  一致加速: '#f59e0b',
  爆量分歧: '#38bdf8',
  弱势震荡: '#94a3b8',
  退潮: '#22c55e',
};

// 板块曲线配色（红橙黄绿蓝靛紫，按题材顺序循环）
const LINE_COLORS = [
  '#f87171',
  '#fb923c',
  '#facc15',
  '#4ade80',
  '#60a5fa',
  '#818cf8',
  '#c084fc',
];

const inRange = (date) => {
  const n = Number(date);
  return Number.isFinite(n) && n >= START_DATE && n <= END_DATE;
};

const toYmd = (date) => {
  const s = String(date || '');
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const formatYmdShort = (date) => {
  const s = String(date || '');
  if (s.length !== 8) return '--';
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
};

const buildHtml = (data) => {
  const themes = (data.themes || [])
    .map((t, idx) => {
      // 与复盘页 / 盯盘页 / 盘中轮询共用同一套情绪周期算法：用原始涨停家数与占比重新判定
      const cycle = (t.emotionCycle || []).map((c, i, arr) => {
        const prev = i > 0 ? arr[i - 1] : null;
        const { phase, reason } = calcPhase({
          count: Number(c.count) || 0,
          prevCount: prev ? (Number(prev.count) || 0) : null,
          ratio: c.ratio,
          prevRatio: prev ? prev.ratio : null,
        });
        return { ...c, phase, reason };
      });
      return {
        key: t.key,
        board: t.board,
        category: t.category,
        currentPhase: cycle.length ? cycle[cycle.length - 1].phase : t.currentPhase,
        latestCount: t.latestCount,
        totalCount: t.totalCount,
        maxLianban: t.maxLianban,
        countTrend: t.countTrend,
        ratioTrend: t.ratioTrend,
        score: t.score,
        color: LINE_COLORS[idx % LINE_COLORS.length],
        emotionCycle: cycle.filter((c) => inRange(c.date)),
      };
    })
    .filter((t) => t.emotionCycle.length > 0);

  const marketTemperature = (data.marketTemperature || []).filter((d) => inRange(d.date));
  const latestSnapshotDate = data.latestSnapshotDate || '';

  const payload = JSON.stringify({
    latestSnapshotDate,
    marketTemperature,
    themes,
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>四维立体 · 情绪周期（2026.07.01 - 2026.11.06）</title>
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    background: #f1f5f9;
    color: #0f172a;
  }
  .page { display: flex; flex-direction: column; gap: 14px; width: 100%; margin: 0; }

  /* 渐变磨砂卡 */
  .glass-card {
    position: relative;
    overflow: hidden;
    border-radius: 18px;
    padding: 14px 16px 12px;
    color: #fff;
    background:
      radial-gradient(118% 86% at 8% -8%, rgba(162,124,255,0.95) 0%, rgba(162,124,255,0) 62%),
      radial-gradient(108% 94% at 106% 8%, rgba(48,197,210,0.92) 0%, rgba(48,197,210,0) 58%),
      radial-gradient(130% 110% at -8% 108%, rgba(132,94,255,0.9) 0%, rgba(132,94,255,0) 64%),
      linear-gradient(116deg, #7b4dff 0%, #4d55d8 46%, #1ba7c6 100%);
    box-shadow: 0 18px 38px -26px rgba(30,27,75,0.55);
  }
  .glass-card::after {
    content: '';
    position: absolute; inset: 0;
    border-radius: inherit;
    border: 1px solid rgba(255,255,255,0.24);
    pointer-events: none;
  }

  .hero { padding: 16px 18px 18px; }
  .hero-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; position: relative; z-index: 1; }
  .hero-title { display: inline-flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 800; text-shadow: 0 1px 2px rgba(30,27,75,0.28); }
  .hero-icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 10px; font-size: 15px; background: rgba(255,255,255,0.22); border: 1px solid rgba(255,255,255,0.35); box-shadow: inset 0 1px 0 rgba(255,255,255,0.4); }
  .total-tag { font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px; color: #fff; background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.32); }
  .status-note { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0 10px; font-size: 11.5px; font-weight: 600; color: rgba(255,255,255,0.92); }
  .status-note::before { content: ''; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: #5eead4; box-shadow: 0 0 0 3px rgba(94,234,212,0.22); }
  .status-sub { color: rgba(255,255,255,0.65); font-weight: 500; }

  .summary-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
  @media (max-width: 800px) { .summary-grid { grid-template-columns: minmax(0,1fr); } }
  .summary-item { display: flex; flex-direction: column; gap: 4px; padding: 9px 11px; border-radius: 13px; background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.24); min-width: 0; }
  .summary-label { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; color: rgba(255,255,255,0.7); text-transform: uppercase; }
  .summary-value { font-size: 16px; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .section-title { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 14px; font-weight: 700; color: #1e293b; }
  .section-title .icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 8px; color: #fff; font-size: 12px; background: linear-gradient(135deg, #7b4dff, #1ba7c6); box-shadow: 0 6px 14px -8px rgba(77,85,216,0.8); }

  .chart-grid { display: grid; grid-template-columns: minmax(0,1fr); gap: 14px; }
  .chart-card-head { position: relative; z-index: 1; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .chart-title { font-size: 13px; font-weight: 800; color: #fff; }
  .chart-sub { font-size: 10.5px; color: rgba(255,255,255,0.68); }
  .chart { position: relative; z-index: 1; width: 100%; }
  .chart-canvas { width: 100%; }

  /* 板块单独小图 */
  .sector-mini-grid { display: grid; grid-template-columns: minmax(0,1fr); gap: 10px; }
  .sector-mini { min-width: 0; padding: 8px 10px 4px; border-radius: 12px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18); }
  .sector-mini-head { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
  .sector-mini-head i { width: 8px; height: 8px; border-radius: 3px; flex-shrink: 0; }
  .sector-mini-name { font-size: 11.5px; font-weight: 800; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sector-mini-days { margin-left: auto; font-size: 9.5px; color: rgba(255,255,255,0.5); font-family: 'SF Mono', Monaco, Consolas, monospace; }

  /* tooltip */
  .chart-tooltip {
    position: absolute; z-index: 20; min-width: 118px; max-width: 220px;
    padding: 7px 9px; border-radius: 10px;
    background: rgba(15,23,42,0.9); border: 1px solid rgba(255,255,255,0.22);
    box-shadow: 0 8px 22px rgba(2,6,23,0.38); pointer-events: none;
  }
  .tip-date { font-size: 10.5px; font-weight: 700; color: rgba(255,255,255,0.72); letter-spacing: 0.02em; margin-bottom: 4px; }
  .tip-row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #fff; line-height: 1.6; }
  .tip-row i { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .tip-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,0.82); }
  .tip-value { margin-left: auto; font-weight: 800; font-variant-numeric: tabular-nums; color: #fff; }

  /* 阶段条 */
  .phase-strip { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .phase-row { display: flex; align-items: stretch; gap: 8px; min-width: 0; }
  .phase-theme { flex: 0 0 88px; max-width: 88px; display: flex; align-items: center; padding: 0 6px; font-size: 10px; font-weight: 700; color: rgba(255,255,255,0.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 3px solid var(--line-color, #94a3b8); background: rgba(255,255,255,0.08); border-radius: 6px; }
  .phase-cells { display: flex; gap: 6px; flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.3) transparent; }
  .phase-cell { flex: 1 0 108px; min-width: 108px; display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 10px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); border-left: 3px solid var(--phase-color, #94a3b8); }
  .phase-date { font-size: 9.5px; color: rgba(255,255,255,0.66); font-family: 'SF Mono', Monaco, Consolas, monospace; }
  .phase-name { font-size: 11.5px; font-weight: 800; color: #fff; }
  .phase-detail { font-size: 9.5px; color: rgba(255,255,255,0.72); white-space: nowrap; }

  .phase-legend { position: relative; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 10px; color: rgba(255,255,255,0.78); }
  .legend-item { display: inline-flex; align-items: center; gap: 4px; }
  .legend-item i { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
  .legend-note { flex: 1 1 100%; color: rgba(255,255,255,0.55); line-height: 1.6; }

  .empty { padding: 26px 0; text-align: center; color: rgba(255,255,255,0.7); font-size: 13px; }
</style>
</head>
<body>
<div class="page">
  <!-- 顶部主卡 -->
  <div class="glass-card hero">
    <div class="hero-header">
      <div class="hero-title">
        <span class="hero-icon">⚡</span>
        <span>四维立体 · 情绪周期</span>
      </div>
      <span class="total-tag">题材 <span id="themeCount">0</span> 个</span>
    </div>
    <div class="status-note">
      2026.07.01 ~ 2026.11.06 大盘情绪周期与板块情绪周期
      <span class="status-sub" id="snapshotDate"></span>
    </div>
    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-label">题材数量</span>
        <span class="summary-value" id="sumThemeCount">--</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">最新情绪温度</span>
        <span class="summary-value" id="sumTemperature">--</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">区间交易日</span>
        <span class="summary-value" id="sumDays">--</span>
      </div>
    </div>
  </div>

  <!-- 大盘情绪周期 -->
  <div class="section-title"><span class="icon">📈</span>情绪周期</div>
  <div class="glass-card chart-card">
    <div class="chart-card-head">
      <div>
        <span class="chart-title">大盘情绪周期</span>
        <span class="chart-sub" style="margin-left:8px">连板快照情绪温度（0 ~ 100）｜50 为牛熊分界线</span>
      </div>
    </div>
    <div class="chart" id="marketChartWrap">
      <div class="chart-canvas" id="marketChart"></div>
      <div class="chart-tooltip" id="marketTooltip" style="display:none"></div>
    </div>
  </div>

  <!-- 板块情绪周期（每个板块单独一张图） -->
  <div class="glass-card chart-card">
    <div class="chart-card-head">
      <div>
        <span class="chart-title">板块情绪周期</span>
        <span class="chart-sub" style="margin-left:8px">每个板块单独一张折线图｜涨停家数 × 板块成交量占比变化（退潮 / 弱势震荡 / 爆量分歧 / 全面高潮 / 一致加速）</span>
      </div>
    </div>
    <div class="sector-mini-grid" id="sectorCharts"></div>

    <!-- 阶段条 -->
    <div class="phase-strip" id="phaseStrip"></div>

    <div class="phase-legend">
      <span class="legend-item"><i style="background:#f43f5e"></i>全面高潮</span>
      <span class="legend-item"><i style="background:#f59e0b"></i>一致加速</span>
      <span class="legend-item"><i style="background:#38bdf8"></i>爆量分歧</span>
      <span class="legend-item"><i style="background:#94a3b8"></i>弱势震荡</span>
      <span class="legend-item"><i style="background:#22c55e"></i>退潮</span>
      <span class="legend-note">规则：涨停≥10 且占比提升=全面高潮；涨停≥10 且占比降低=一致加速；涨停 6~9 且占比提升=爆量分歧（仅当前一日为全面高潮/一致加速，否则计全面高潮）；涨停 6~9 且占比降低=弱势震荡；涨停≤5 且较前一日增加=弱势震荡，涨停≤5 且未增加=退潮。曲线上黄色圆点表示当日大盘情绪温度 ≥ 60°。</span>
    </div>
  </div>
</div>

<script>
const DATA = ${payload};

const PHASE_SCORE = ${JSON.stringify(PHASE_SCORE)};
const PHASE_NAMES = ${JSON.stringify(PHASE_NAMES)};
const SECTOR_PHASE_COLOR = ${JSON.stringify(SECTOR_PHASE_COLOR)};

const toChartTime = (date) => {
  const s = String(date || '');
  if (s.length !== 8) return null;
  return s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
};
const fmtMd = (time) => {
  const s = typeof time === 'string' ? time : (time && time.year ? time.year + '-' + String(time.month).padStart(2,'0') + '-' + String(time.day).padStart(2,'0') : '');
  return s.length >= 10 ? s.slice(5,7) + '/' + s.slice(8,10) : s;
};
const timeKeyOf = (time) => {
  if (typeof time === 'string') return time;
  if (time && time.year) return time.year + '-' + String(time.month).padStart(2,'0') + '-' + String(time.day).padStart(2,'0');
  return null;
};

// 大盘情绪温度 ≥ 60 的日期 → 温度值
const hotMarketDates = new Map();
(DATA.marketTemperature || []).forEach((item) => {
  const v = Number(item.value);
  if (v >= 60) hotMarketDates.set(toChartTime(item.date), v);
});

/* ================= 大盘情绪周期图 ================= */
function renderMarketChart() {
  const el = document.getElementById('marketChart');
  const wrap = document.getElementById('marketChartWrap');
  const tipEl = document.getElementById('marketTooltip');
  el.innerHTML = '';

  const chart = LightweightCharts.createChart(el, {
    width: wrap.clientWidth || 320,
    height: 300,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: 'rgba(255,255,255,0.82)', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,0.08)' }, horzLines: { color: 'rgba(255,255,255,0.08)' } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(255,255,255,0.45)', style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#334155' },
      horzLine: { color: 'rgba(255,255,255,0.45)', style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#334155' },
    },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: true },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.18)', scaleMargins: { top: 0.16, bottom: 0.12 } },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.18)', fixLeftEdge: true, fixRightEdge: true,
      tickMarkFormatter: (t) => fmtMd(t),
    },
    localization: {
      locale: 'zh-CN',
      priceFormatter: (p) => Number.isFinite(Number(p)) ? Number(p).toFixed(0) : '--',
      timeFormatter: (t) => timeKeyOf(t) || '',
    },
  });

  const data = (DATA.marketTemperature || [])
    .filter((d) => d.value !== null && d.value !== undefined && Number.isFinite(Number(d.value)))
    .map((d) => ({ time: toChartTime(d.date), value: Number(d.value), phase: d.phase, limitUp: d.limitUp }));

  const valueMap = new Map(data.map((d) => [d.time, d]));

  const line = chart.addLineSeries({
    color: '#fda4af', lineWidth: 2,
    priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
    priceFormat: { type: 'price', precision: 0, minMove: 1 },
  });
  line.setData(data.map(({ time, value }) => ({ time, value })));

  // 50 分界线
  line.createPriceLine({
    price: 50, color: 'rgba(255,255,255,0.4)', lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '',
  });

  // 热温打点
  const markers = data
    .filter((d) => hotMarketDates.has(d.time))
    .map((d) => ({ time: d.time, position: 'aboveBar', color: '#fbbf24', shape: 'circle', size: 0.5, text: '大盘 ' + Math.round(d.value) + '°' }));
  line.setMarkers(markers);

  const showTip = (timeKey, x, y) => {
    const d = valueMap.get(timeKey);
    if (!d) { tipEl.style.display = 'none'; return; }
    const wrapRect = wrap.getBoundingClientRect();
    tipEl.style.display = 'block';
    let left = x > wrap.clientWidth - 200 ? Math.max(6, wrap.clientWidth - 200) : x + 14;
    let top = Math.max(4, y - 14);
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
    tipEl.innerHTML =
      '<div class="tip-date">' + timeKey + '</div>' +
      '<div class="tip-row"><i style="background:#fda4af"></i><span class="tip-name">情绪温度</span><span class="tip-value">' + d.value + '°</span></div>' +
      '<div class="tip-row"><i style="background:#facc15"></i><span class="tip-name">阶段</span><span class="tip-value">' + (d.phase || '--') + '</span></div>' +
      '<div class="tip-row"><i style="background:#f87171"></i><span class="tip-name">涨停家数</span><span class="tip-value">' + (d.limitUp ?? '--') + '</span></div>';
  };
  const hideTip = () => { tipEl.style.display = 'none'; };

  chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) { hideTip(); return; }
    showTip(timeKeyOf(param.time), param.point.x, param.point.y);
  });
  wrap.addEventListener('mousemove', (ev) => {
    const rect = wrap.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) { hideTip(); return; }
    if (!data.length) return;
    const logical = chart.timeScale().coordinateToLogical(x);
    if (logical === null || logical === undefined || !Number.isFinite(Number(logical))) return;
    const idx = Math.min(data.length - 1, Math.max(0, Math.round(Number(logical))));
    showTip(data[idx].time, x, y);
  });
  wrap.addEventListener('mouseleave', hideTip);

  chart.timeScale().fitContent();
  const ro = new ResizeObserver(() => chart.applyOptions({ width: wrap.clientWidth || 320 }));
  ro.observe(wrap);
}

/* ================= 板块情绪周期单图 ================= */
function renderSectorCharts() {
  const container = document.getElementById('sectorCharts');
  container.innerHTML = '';
  const phaseFormatter = (p) => PHASE_NAMES[Math.round(Number(p))] || '';

  (DATA.themes || []).forEach((t) => {
    const wrap = document.createElement('div');
    wrap.className = 'sector-mini';

    const head = document.createElement('div');
    head.className = 'sector-mini-head';
    head.innerHTML = '<i style="background:' + t.color + '"></i>' +
      '<span class="sector-mini-name" title="' + t.board + '">' + t.board + '</span>' +
      '<span class="sector-mini-days">' + t.emotionCycle.length + ' 日</span>';
    wrap.appendChild(head);

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'chart';
    const canvas = document.createElement('div');
    canvas.className = 'chart-canvas';
    const tipEl = document.createElement('div');
    tipEl.className = 'chart-tooltip';
    tipEl.style.display = 'none';
    canvasWrap.appendChild(canvas);
    canvasWrap.appendChild(tipEl);
    wrap.appendChild(canvasWrap);
    container.appendChild(wrap);

    const data = (t.emotionCycle || [])
      .filter((c) => PHASE_SCORE[c.phase] !== undefined)
      .map((c) => ({ time: toChartTime(c.date), value: PHASE_SCORE[c.phase], phase: c.phase, count: c.count, ratio: c.ratio, reason: c.reason }));
    const valueMap = new Map(data.map((d) => [d.time, d]));

    const chart = LightweightCharts.createChart(canvas, {
      width: canvasWrap.clientWidth || 320,
      height: 200,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: 'rgba(255,255,255,0.82)', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.08)' }, horzLines: { color: 'rgba(255,255,255,0.08)' } },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.45)', style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#334155' },
        horzLine: { color: 'rgba(255,255,255,0.45)', style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#334155' },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: true },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.18)', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.18)', fixLeftEdge: true, fixRightEdge: true,
        tickMarkFormatter: (tt) => fmtMd(tt),
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: phaseFormatter,
        timeFormatter: (tt) => timeKeyOf(tt) || '',
      },
      // 固定 0~4 范围，保证阶段刻度完整
    });

    const line = chart.addLineSeries({
      color: t.color, lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      priceFormat: { type: 'custom', formatter: phaseFormatter, minMove: 1 },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 4 } }),
    });
    line.setData(data.map(({ time, value }) => ({ time, value })));

    // 大盘热温打点
    const markers = data
      .filter((d) => hotMarketDates.has(d.time))
      .map((d) => ({ time: d.time, position: 'aboveBar', color: '#fbbf24', shape: 'circle', size: 0.5, text: '大盘 ' + Math.round(hotMarketDates.get(d.time)) + '°' }));
    line.setMarkers(markers);

    const showTip = (timeKey, x, y) => {
      const d = valueMap.get(timeKey);
      if (!d) { tipEl.style.display = 'none'; return; }
      tipEl.style.display = 'block';
      let left = x > canvasWrap.clientWidth - 210 ? Math.max(6, canvasWrap.clientWidth - 210) : x + 14;
      let top = Math.max(4, y - 14);
      tipEl.style.left = left + 'px';
      tipEl.style.top = top + 'px';
      tipEl.innerHTML =
        '<div class="tip-date">' + timeKey + '</div>' +
        '<div class="tip-row"><i style="background:' + t.color + '"></i><span class="tip-name">阶段</span><span class="tip-value">' + (d.phase || '--') + '</span></div>' +
        '<div class="tip-row"><i style="background:#f87171"></i><span class="tip-name">涨停家数</span><span class="tip-value">' + (d.count ?? '--') + '</span></div>' +
        '<div class="tip-row"><i style="background:#60a5fa"></i><span class="tip-name">成交占比</span><span class="tip-value">' + (d.ratio == null ? '--' : d.ratio + '%') + '</span></div>' +
        (d.reason ? '<div class="tip-row" style="flex-direction:column;align-items:flex-start;gap:2px"><span class="tip-name" style="overflow:visible;white-space:normal">' + d.reason + '</span></div>' : '');
    };
    const hideTip = () => { tipEl.style.display = 'none'; };

    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) { hideTip(); return; }
      showTip(timeKeyOf(param.time), param.point.x, param.point.y);
    });
    canvasWrap.addEventListener('mousemove', (ev) => {
      const rect = canvasWrap.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      if (x < 0 || y < 0 || x > canvasWrap.clientWidth || y > canvasWrap.clientHeight) { hideTip(); return; }
      if (!data.length) return;
      const logical = chart.timeScale().coordinateToLogical(x);
      if (logical === null || logical === undefined || !Number.isFinite(Number(logical))) return;
      const idx = Math.min(data.length - 1, Math.max(0, Math.round(Number(logical))));
      showTip(data[idx].time, x, y);
    });
    canvasWrap.addEventListener('mouseleave', hideTip);

    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: canvasWrap.clientWidth || 320 }));
    ro.observe(canvasWrap);
  });
}

/* ================= 阶段条 ================= */
function renderPhaseStrip() {
  const strip = document.getElementById('phaseStrip');
  strip.innerHTML = '';
  (DATA.themes || []).forEach((t) => {
    const row = document.createElement('div');
    row.className = 'phase-row';
    const themeLabel = document.createElement('span');
    themeLabel.className = 'phase-theme';
    themeLabel.style.setProperty('--line-color', t.color);
    themeLabel.title = t.board;
    themeLabel.textContent = t.board;
    row.appendChild(themeLabel);

    const cells = document.createElement('div');
    cells.className = 'phase-cells';
    [...(t.emotionCycle || [])]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .forEach((c) => {
        const cell = document.createElement('div');
        cell.className = 'phase-cell';
        cell.style.setProperty('--phase-color', SECTOR_PHASE_COLOR[c.phase] || '#94a3b8');
        cell.title = t.board + '｜' + (c.reason || '');
        cell.innerHTML =
          '<span class="phase-date">' + (function(){ var s=String(c.date||''); return s.length===8?s.slice(4,6)+'/'+s.slice(6,8):'--'; })() + '</span>' +
          '<span class="phase-name">' + (c.phase || '--') + '</span>' +
          '<span class="phase-detail">涨停 ' + (c.count ?? '--') + ' · 占比 ' + (c.ratio == null ? '--' : c.ratio + '%') + '</span>';
        cells.appendChild(cell);
      });
    row.appendChild(cells);
    strip.appendChild(row);
  });
}

/* ================= 顶部概览 ================= */
function renderSummary() {
  const lastTemp = (DATA.marketTemperature || []).slice(-1)[0];
  document.getElementById('themeCount').textContent = (DATA.themes || []).length;
  document.getElementById('sumThemeCount').textContent = (DATA.themes || []).length + ' 个';
  document.getElementById('sumTemperature').textContent = lastTemp ? lastTemp.value + '（' + (lastTemp.phase || '--') + '）' : '--';
  document.getElementById('sumDays').textContent = (DATA.marketTemperature || []).length + ' 日';
  if (DATA.latestSnapshotDate) {
    const s = String(DATA.latestSnapshotDate);
    if (s.length === 8) document.getElementById('snapshotDate').textContent = '数据截至 ' + s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
  }
}

/* ================= 启动 ================= */
document.addEventListener('DOMContentLoaded', () => {
  if (!DATA.themes || !DATA.themes.length) {
    document.getElementById('sectorCharts').innerHTML = '<div class="empty">暂无板块情绪周期数据</div>';
  }
  renderSummary();
  renderMarketChart();
  renderSectorCharts();
  renderPhaseStrip();
});
</script>
</body>
</html>`;
};

const main = async () => {
  console.log('正在拉取四维立体数据：' + API_URL);
  const res = await axios.get(API_URL, {
    params: { cycleDays: WINDOW_DAYS, emotionDays: WINDOW_DAYS },
    timeout: 5 * 60 * 1000,
  });
  const data = res.data || {};
  console.log('数据拉取成功，题材数：' + ((data.themes || []).length));

  const html = buildHtml(data);
  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
  console.log('HTML 已生成：' + OUTPUT_FILE);
};

main().catch((err) => {
  console.error('生成失败：', err.message);
  process.exit(1);
});
