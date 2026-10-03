// 临时脚本：手动计算 2026-03-15 ~ 2026-04-15 科技情绪变化，并生成同目录 HTML 折线图（含 EMA 3 日线）
// 算法与 server/src/service/emotion.js 完全同源：
//   rawSum      = Σ(成分股当日涨幅% × 市值因子)，市值因子 = 个股总市值(总股本×当日收盘价) / 当日平均总市值（缺失按 1）
//   baseEmotion = 100·tanh(rawSum/300)                          （normalizeTechEmotion，TECH_EMOTION_SCALE=300）
//   pullback    = 创业板指(sz399006)+科创50(sh000688) 各自 (收盘-最高)/昨收×100 的均值
//                 惩罚 = -100·tanh(|avgPullback|/2)（avgPullback>=0 时为 0，PULLBACK_PENALTY_SCALE=2）
//   final       = clip(baseEmotion + pullback×0.4, -100, 100)   （computeTechEmotion，PULLBACK_WEIGHT=0.4）
//   EMA3        = 与 buySellBacktest.getTechEmotionEmaMap / 情绪页同算法：首值=三日简单均值，此后 ema=0.5×当日值+0.5×上一ema
// 成分股：monitorStocks 中 isTech !== false 的全部监控股（与 updateCurrentTechIndexData 一致）
// 说明：tech_index.json 仅覆盖最近约 105 个交易日（20260508 起），不含 3-4 月，故用日K历史重算。
//       个股某日停牌无K线时按实时路径 fetchChange 失败的同款兜底处理：涨幅 0、市值因子 1。
// 用法：node script/calc_tech_emotion_0315_0415.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { getClsReqUrl, getClsReqIndexUrl } = require('../src/utils');
const { getMonitorStocks } = require('../src/service/monitorStock');

const SHOW_START = '20260315'; // 展示起点
const SHOW_END = '20260415';   // 展示终点
const WARMUP_START = '20260220'; // EMA 预热起点（展示起点前若干交易日，EMA3 递推预热）
const TECH_EMOTION_SCALE = 300;
const PULLBACK_PENALTY_SCALE = 2;
const PULLBACK_WEIGHT = 0.4;
const CHUANGYEBAN_CODE = 'sz399006';
const KECHUANGBAN_CODE = 'sh000688';
const KLINE_LIMIT = 170; // 日K条数：覆盖 20260220 至今（约 150 个交易日）

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': 'https://www.cls.cn/',
};

const normalizeTechEmotion = (raw) => parseFloat((100 * Math.tanh(raw / TECH_EMOTION_SCALE)).toFixed(2));

const computePullbackPenaltyFromKline = (k) => {
  if (!k || !k.preclose_px || k.preclose_px <= 0) return 0;
  if (k.high_px == null || isNaN(k.high_px) || k.close_px == null || isNaN(k.close_px)) return 0;
  const pullback = parseFloat(((k.close_px - k.high_px) / k.preclose_px * 100).toFixed(2));
  if (pullback >= 0) return 0;
  return parseFloat((-100 * Math.tanh(Math.abs(pullback) / PULLBACK_PENALTY_SCALE)).toFixed(2));
};

const computeTechEmotion = (baseEmotion, pullbackPenalty) =>
  parseFloat(Math.max(-100, Math.min(100, baseEmotion + pullbackPenalty * PULLBACK_WEIGHT)).toFixed(2));

// 简单并发池
const batchParallel = async (list, worker, concurrency) => {
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      results[idx] = await worker(list[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
};

// 拉日K：返回 { [tradeDateStr]: klineItem }（升序原始数据转映射）
const fetchKlineMap = async (code, isIndex) => {
  const rawUrl = isIndex ? getClsReqIndexUrl(code, KLINE_LIMIT) : getClsReqUrl(code, KLINE_LIMIT);
  const url = rawUrl.replace('$code', code).replace('$limit', String(KLINE_LIMIT));
  const { data: resp } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const arr = Array.isArray(resp?.data) ? resp.data : [];
  const map = {};
  arr.forEach(k => { if (k && k.trade_date != null) map[String(k.trade_date)] = k; });
  return map;
};

(async () => {
  const stocks = getMonitorStocks().filter(s => s.isTech !== false);
  console.log(`成分股数量: ${stocks.length}`);

  // 总股本映射（与 getTotalSharesMap 同源同格式）
  let sharesMap = {};
  try {
    const sharesPath = path.join(__dirname, '../src/data/monitor_stocks_total_shares.json');
    const arr = JSON.parse(fs.readFileSync(sharesPath, 'utf-8'));
    (Array.isArray(arr) ? arr : []).forEach(item => {
      if (item && item.secu_code && item.TotalShares != null && !isNaN(Number(item.TotalShares))) {
        sharesMap[item.secu_code] = Number(item.TotalShares);
      }
    });
  } catch (e) { console.warn('总股本数据缺失，全部按等权处理:', e.message); }
  console.log(`总股本覆盖: ${Object.keys(sharesMap).length} 只`);

  // 交易日轴：以创业板指日K为准
  const cybMap = await fetchKlineMap(CHUANGYEBAN_CODE, true);
  const kcbMap = await fetchKlineMap(KECHUANGBAN_CODE, true);
  const allDates = Object.keys(cybMap).filter(d => d >= WARMUP_START && d <= SHOW_END).sort();
  const showDates = allDates.filter(d => d >= SHOW_START);
  console.log(`交易日轴: ${allDates[0]} ~ ${allDates[allDates.length - 1]}，共 ${allDates.length} 天（展示 ${showDates.length} 天）`);

  // 拉全部成分股日K（并发 10）
  let done = 0;
  const stockKlineMaps = await batchParallel(stocks, async (s) => {
    let map = {};
    try { map = await fetchKlineMap(s.code, false); } catch (e) { console.warn(`  ${s.code} ${s.name} 拉取失败: ${e.message}`); }
    done++;
    if (done % 20 === 0) console.log(`  个股日K进度: ${done}/${stocks.length}`);
    return map;
  }, 10);

  // 逐日计算科技情绪（与 fetchWeightedChangeSum + computePullbackPenalty 同口径）
  const daily = [];
  for (const date of allDates) {
    const items = stocks.map((s, i) => {
      const k = stockKlineMaps[i][date];
      return {
        code: s.code,
        change: k && k.change != null && !isNaN(k.change) ? k.change : 0,
        price: k && k.close_px != null && !isNaN(k.close_px) ? k.close_px : null,
      };
    });
    // 市值因子：个股总市值 / 当日平均总市值（缺失按 1）
    const caps = items.map(it => {
      const shares = sharesMap[it.code];
      if (!shares || !it.price || isNaN(shares) || isNaN(it.price)) return null;
      return shares * it.price;
    });
    const validCaps = caps.filter(c => c !== null && c > 0);
    const avgCap = validCaps.length > 0 ? validCaps.reduce((a, c) => a + c, 0) / validCaps.length : 0;
    const factors = caps.map(c => (c !== null && c > 0 && avgCap > 0 ? c / avgCap : 1));
    const rawSum = items.reduce((acc, cur, i) => acc + cur.change * factors[i], 0);
    const baseEmotion = normalizeTechEmotion(rawSum);

    // 冲高回落惩罚：创业板指 + 科创50 当日K线 (收盘-最高)/昨收 均值映射
    const penalties = [cybMap[date], kcbMap[date]].map(computePullbackPenaltyFromKline);
    const avgPenalty = penalties.reduce((a, p) => a + p, 0) / penalties.length;
    const finalEmotion = computeTechEmotion(baseEmotion, avgPenalty);

    daily.push({ date, changeSumResult: finalEmotion, rawSum: parseFloat(rawSum.toFixed(2)), baseEmotion, pullbackPenalty: parseFloat(avgPenalty.toFixed(2)) });
  }

  // EMA3：与 getTechEmotionEmaMap 同算法（首值=三日简单均值，此后 ema=0.5×值+0.5×ema）
  let prevEma = null;
  const withEma = daily.map((item, i) => {
    let ema = null;
    if (i >= 2) {
      if (prevEma === null) {
        prevEma = (daily[i - 2].changeSumResult + daily[i - 1].changeSumResult + item.changeSumResult) / 3;
      } else {
        prevEma = 0.5 * item.changeSumResult + 0.5 * prevEma;
      }
      ema = parseFloat(prevEma.toFixed(2));
    }
    return { ...item, ema3: ema };
  });

  const showData = withEma.filter(d => d.date >= SHOW_START);

  // 控制台输出
  console.log('\n日期        情绪值    EMA3     rawSum    baseEmotion  回落惩罚');
  showData.forEach(d => {
    console.log(
      `${d.date}  ${String(d.changeSumResult).padStart(7)}  ${d.ema3 == null ? '  --  ' : String(d.ema3).padStart(7)}  ${String(d.rawSum).padStart(8)}  ${String(d.baseEmotion).padStart(8)}  ${String(d.pullbackPenalty).padStart(6)}`
    );
  });
  const sum = showData.reduce((a, d) => a + d.changeSumResult, 0);
  console.log(`\n展示区间: ${SHOW_START} ~ ${SHOW_END}，共 ${showData.length} 个交易日，情绪总和 ${sum.toFixed(2)}，日均 ${(sum / showData.length).toFixed(2)}`);
  const max = showData.reduce((m, d) => (d.changeSumResult > m.changeSumResult ? d : m), showData[0]);
  const min = showData.reduce((m, d) => (d.changeSumResult < m.changeSumResult ? d : m), showData[0]);
  console.log(`峰值: ${max.date} = ${max.changeSumResult}；谷值: ${min.date} = ${min.changeSumResult}`);

  // 生成 HTML（模仿 盯盘工具/src/pages/sentiment/index.jsx 科技板块情绪折线图）
  const htmlPath = path.join(__dirname, 'tech_emotion_0315_0415.html');
  const html = buildHtml(showData);
  fs.writeFileSync(htmlPath, html);
  console.log(`\nHTML 已生成: ${htmlPath}`);
})().catch(e => { console.error('执行失败:', e); process.exit(1); });

function buildHtml(data) {
  const payload = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>科技情绪变化 ${SHOW_START.slice(0,4)}-${SHOW_START.slice(4,6)}-${SHOW_START.slice(6,8)} ~ ${SHOW_END.slice(0,4)}-${SHOW_END.slice(4,6)}-${SHOW_END.slice(6,8)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 24px; }
  .page-header { max-width: 1280px; margin: 0 auto 16px; }
  .page-header h1 { font-size: 22px; color: #262626; }
  .page-header .sub { font-size: 13px; color: #8c8c8c; margin-top: 4px; }
  .chart-card { max-width: 1280px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .chart-title { font-size: 16px; font-weight: 600; color: #262626; margin-bottom: 16px; display: flex; align-items: center; gap: 6px; }
  .chart-title::before { content: ''; width: 3px; height: 14px; background: #722ed1; border-radius: 2px; }
  .legend { display: flex; gap: 20px; font-size: 12px; color: #666; margin-bottom: 8px; }
  .legend .item { display: flex; align-items: center; gap: 6px; }
  .legend .swatch { display: inline-block; width: 18px; height: 3px; border-radius: 2px; }
  #chart-container { position: relative; width: 100%; height: 500px; }
  #chart-container svg { display: block; }
  .chart-tooltip { position: absolute; pointer-events: none; display: none; background: #fff; border: 1px solid #eee; border-radius: 6px; box-shadow: 0 3px 14px rgba(0,0,0,0.15); padding: 10px 12px; font-size: 12px; z-index: 10; min-width: 150px; }
  .tooltip-title { font-weight: 600; color: #262626; margin-bottom: 6px; }
  .tooltip-item { display: flex; justify-content: space-between; gap: 16px; line-height: 20px; }
  .tooltip-item .label { color: #8c8c8c; }
  .tooltip-item .value.up { color: #f5222d; }
  .tooltip-item .value.down { color: #52c41a; }
  .sentiment-sum-module { margin-top: 16px; border-top: 1px solid #f0f0f0; padding-top: 14px; }
  .sentiment-sum-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .sentiment-sum-header input { border: 1px solid #d9d9d9; border-radius: 6px; padding: 4px 8px; font-size: 13px; width: 110px; }
  .sentiment-sum-label { font-size: 13px; color: #666; }
  .sentiment-sum-result { display: flex; gap: 32px; }
  .sentiment-sum-item { display: flex; flex-direction: column; gap: 2px; }
  .sentiment-sum-item-label { font-size: 12px; color: #8c8c8c; }
  .sentiment-sum-item-value { font-size: 20px; font-weight: 600; }
  .sentiment-sum-item-value.up { color: #f5222d; }
  .sentiment-sum-item-value.down { color: #52c41a; }
</style>
</head>
<body>
  <div class="page-header">
    <h1>科技情绪变化（临时计算）</h1>
    <div class="sub">区间 ${SHOW_START.slice(0,4)}-${SHOW_START.slice(4,6)}-${SHOW_START.slice(6,8)} ~ ${SHOW_END.slice(0,4)}-${SHOW_END.slice(4,6)}-${SHOW_END.slice(6,8)} · 算法与 emotion.js 科技情绪同源（成分股涨幅市值加权 + 冲高回落惩罚），EMA3 与情绪页「三日均值」同算法</div>
  </div>
  <div class="chart-card">
    <div class="chart-title">科技板块情绪</div>
    <div class="legend">
      <span class="item"><span class="swatch" style="background:#722ed1"></span>科技情绪指数</span>
      <span class="item"><span class="swatch" style="background:#1890ff; border-top:1px dashed #1890ff; background:transparent; height:0;"></span>EMA 3 日线</span>
      <span class="item"><span class="swatch" style="background:#ff4d4f; height:1px; border-top:1px dashed #ff4d4f; background:transparent;"></span>0 轴基准</span>
    </div>
    <div id="chart-container"><div class="chart-tooltip" id="tooltip"></div></div>
    <div class="sentiment-sum-module">
      <div class="sentiment-sum-header">
        <span class="sentiment-sum-label">时间范围</span>
        <input type="date" id="range-start" value="${SHOW_START.slice(0,4)}-${SHOW_START.slice(4,6)}-${SHOW_START.slice(6,8)}">
        <span class="sentiment-sum-label">~</span>
        <input type="date" id="range-end" value="${SHOW_END.slice(0,4)}-${SHOW_END.slice(4,6)}-${SHOW_END.slice(6,8)}">
      </div>
      <div class="sentiment-sum-result">
        <div class="sentiment-sum-item"><span class="sentiment-sum-item-label">数据天数</span><span class="sentiment-sum-item-value" id="sum-count">-</span></div>
        <div class="sentiment-sum-item"><span class="sentiment-sum-item-label">情绪总和</span><span class="sentiment-sum-item-value" id="sum-total">-</span></div>
        <div class="sentiment-sum-item"><span class="sentiment-sum-item-label">日均情绪</span><span class="sentiment-sum-item-value" id="sum-avg">-</span></div>
      </div>
    </div>
  </div>
<script>
const DATA = ${payload};
// EMA 递推与后端/情绪页一致：区间数据直接整体递推（首值=三日简单均值，此后 ema=0.5×值+0.5×ema）
(() => {
  const container = document.getElementById('chart-container');
  const tooltip = document.getElementById('tooltip');
  const PAD = { top: 20, right: 60, bottom: 30, left: 20 };
  const COLOR_MAIN = '#722ed1', COLOR_EMA = '#1890ff', COLOR_ZERO = '#ff4d4f';
  const fmtDate = (d) => d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
  const fmtShort = (d) => d.slice(4,6) + '-' + d.slice(6,8);

  let points = []; // { x, y, date, value, ema }

  const draw = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;

    const values = DATA.map(d => d.changeSumResult).concat(DATA.filter(d => d.ema3 != null).map(d => d.ema3));
    let minV = Math.min(0, ...values), maxV = Math.max(0, ...values);
    const pad = (maxV - minV) * 0.08 || 5;
    minV -= pad; maxV += pad;
    const x = (i) => PAD.left + (DATA.length === 1 ? innerW / 2 : (i / (DATA.length - 1)) * innerW);
    const y = (v) => PAD.top + (1 - (v - minV) / (maxV - minV)) * innerH;

    const gridVals = [];
    const step = (maxV - minV) / 5;
    for (let v = minV; v <= maxV + 1e-9; v += step) gridVals.push(v);

    let svg = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">';
    // 网格 + Y 轴刻度（右侧，模仿 rightPriceScale）
    gridVals.forEach(v => {
      const yy = y(v);
      svg += '<line x1="' + PAD.left + '" y1="' + yy + '" x2="' + (width - PAD.right) + '" y2="' + yy + '" stroke="#f0f0f0" stroke-width="1"/>';
      svg += '<text x="' + (width - PAD.right + 8) + '" y="' + (yy + 4) + '" font-size="11" fill="#333">' + v.toFixed(1) + '</text>';
    });
    // 0 轴基准（红色虚线）
    svg += '<line x1="' + PAD.left + '" y1="' + y(0) + '" x2="' + (width - PAD.right) + '" y2="' + y(0) + '" stroke="' + COLOR_ZERO + '" stroke-width="1" stroke-dasharray="4 4"/>';
    // X 轴刻度（约每 5 个交易日）
    const tickEvery = Math.max(1, Math.round(DATA.length / 10));
    DATA.forEach((d, i) => {
      if (i % tickEvery !== 0 && i !== DATA.length - 1) return;
      svg += '<text x="' + x(i) + '" y="' + (height - 8) + '" font-size="11" fill="#333" text-anchor="middle">' + fmtShort(d.date) + '</text>';
    });
    // EMA3 虚线
    const emaPts = DATA.map((d, i) => ({ d, i })).filter(p => p.d.ema3 != null);
    if (emaPts.length > 1) {
      const path = emaPts.map((p, idx) => (idx === 0 ? 'M' : 'L') + x(p.i).toFixed(1) + ' ' + y(p.d.ema3).toFixed(1)).join(' ');
      svg += '<path d="' + path + '" fill="none" stroke="' + COLOR_EMA + '" stroke-width="2" stroke-dasharray="5 4"/>';
    }
    // 主线
    const mainPath = DATA.map((d, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(d.changeSumResult).toFixed(1)).join(' ');
    svg += '<path d="' + mainPath + '" fill="none" stroke="' + COLOR_MAIN + '" stroke-width="3" stroke-linejoin="round"/>';
    // 悬浮竖线 + 数据点（默认隐藏）
    svg += '<line id="cross-v" x1="0" y1="' + PAD.top + '" x2="0" y2="' + (height - PAD.bottom) + '" stroke="#d9d9d9" stroke-width="1" style="display:none"/>';
    svg += '<circle id="dot-main" r="4" fill="' + COLOR_MAIN + '" stroke="#fff" stroke-width="1.5" style="display:none"/>';
    svg += '<circle id="dot-ema" r="3.5" fill="' + COLOR_EMA + '" stroke="#fff" stroke-width="1.5" style="display:none"/>';
    svg += '</svg>';

    container.querySelectorAll('svg').forEach(el => el.remove());
    container.insertBefore(svgToNode(svg), tooltip);
    points = DATA.map((d, i) => ({ x: x(i), y: y(d.changeSumResult), date: d.date, value: d.changeSumResult, ema: d.ema3, yEma: d.ema3 != null ? y(d.ema3) : null, i }));
  };
  const svgToNode = (svgStr) => { const div = document.createElement('div'); div.innerHTML = svgStr; return div.firstChild; };

  container.addEventListener('mousemove', (e) => {
    if (!points.length) return;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let nearest = points[0];
    let minDist = Infinity;
    points.forEach(p => { const dist = Math.abs(p.x - mx); if (dist < minDist) { minDist = dist; nearest = p; } });
    const crossV = document.getElementById('cross-v');
    const dotMain = document.getElementById('dot-main');
    const dotEma = document.getElementById('dot-ema');
    if (!crossV) return;
    crossV.setAttribute('x1', nearest.x); crossV.setAttribute('x2', nearest.x); crossV.style.display = '';
    dotMain.setAttribute('cx', nearest.x); dotMain.setAttribute('cy', nearest.y); dotMain.style.display = '';
    if (nearest.ema != null) { dotEma.setAttribute('cx', nearest.x); dotEma.setAttribute('cy', nearest.yEma); dotEma.style.display = ''; } else { dotEma.style.display = 'none'; }
    tooltip.style.display = 'block';
    tooltip.innerHTML =
      '<div class="tooltip-title">' + fmtDate(nearest.date) + '</div>' +
      '<div class="tooltip-item"><span class="label">科技情绪指数:</span><span class="value ' + (nearest.value >= 0 ? 'up' : 'down') + '">' + nearest.value.toFixed(2) + '</span></div>' +
      (nearest.ema != null ? '<div class="tooltip-item"><span class="label">三日EMA:</span><span class="value ' + (nearest.ema >= 0 ? 'up' : 'down') + '">' + nearest.ema.toFixed(2) + '</span></div>' : '');
    let tx = nearest.x + 15;
    if (tx > container.clientWidth - 180) tx = nearest.x - 195;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = (Math.min(nearest.y, nearest.yEma != null ? nearest.yEma : nearest.y) + 15) + 'px';
  });
  container.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    ['cross-v', 'dot-main', 'dot-ema'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  });

  // 统计条（模仿情绪页「时间范围 + 情绪总和/日均」模块，支持改区间）
  const renderSum = () => {
    const s = document.getElementById('range-start').value.replace(/-/g, '');
    const e = document.getElementById('range-end').value.replace(/-/g, '');
    const filtered = DATA.filter(d => d.date >= s && d.date <= e);
    const count = filtered.length;
    const sum = filtered.reduce((a, d) => a + d.changeSumResult, 0);
    const avg = count > 0 ? sum / count : 0;
    document.getElementById('sum-count').textContent = count + ' 天';
    const totalEl = document.getElementById('sum-total');
    totalEl.textContent = (sum >= 0 ? '+' : '') + sum.toFixed(2);
    totalEl.className = 'sentiment-sum-item-value ' + (sum >= 0 ? 'up' : 'down');
    const avgEl = document.getElementById('sum-avg');
    avgEl.textContent = (avg >= 0 ? '+' : '') + avg.toFixed(2);
    avgEl.className = 'sentiment-sum-item-value ' + (avg >= 0 ? 'up' : 'down');
  };
  document.getElementById('range-start').addEventListener('change', renderSum);
  document.getElementById('range-end').addEventListener('change', renderSum);

  window.addEventListener('resize', draw);
  draw();
  renderSum();
})();
</script>
</body>
</html>`;
}
