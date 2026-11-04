// 重点板块分时平均涨跌幅：按 5 分钟时间桶统计每个板块成分股的平均涨幅，并绘制折线图
//
// 数据来源：
//   1. 板块与成分股：src/constant/block_code.js（与 /block 接口一致，即 key_blocks 页面「板块列表监控」的板块）
//   2. 个股分时：getSingleStockTlineDataByDateLean（同花顺，失败回退财联社），自动落盘缓存
//
// 口径：
//   - 时间桶：09:35 ~ 11:30、13:05 ~ 15:00，间隔 5 分钟（跳过午休），共 48 个点
//   - 每个时间桶取该分钟及之前最近的分时点涨幅；无分时的成分股不计入平均
//   - 板块平均涨幅 = 板块内有分时数据的成分股涨幅算术平均
//
// 用法：
//   node script/block-intraday-avg-change.js                       默认统计 今天 + 20261023 + 20261102
//   node script/block-intraday-avg-change.js 20261104 20261023     指定交易日（可传多个，每个日期一个 tab）
//   node script/block-intraday-avg-change.js 20261102 --concurrency 12
// 输出：
//   script/block-intraday-avg-change.html
const fs = require('fs');
const path = require('path');
const { getSingleStockTlineDataByDateLean } = require('../src/service/stock');
const { getBlocksConfig } = require('../src/service/blockConfig');

const OUTPUT_PATH = path.join(__dirname, 'block-intraday-avg-change.html');
const DEFAULT_CONCURRENCY = 12;
const STOCK_FETCH_RETRY = 2;
const INTERVAL_MINUTES = 5;

// 时间桶（分钟数，9:30=570；跳过 11:30~13:00 午休）
const BUCKETS = [];
for (let m = 575; m <= 690; m += INTERVAL_MINUTES) BUCKETS.push(m);
for (let m = 785; m <= 900; m += INTERVAL_MINUTES) BUCKETS.push(m);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round2 = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

const timeLabel = (minuteOfDay) => {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const todayString = () => {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
};

const parseArgs = (argv) => {
  const args = {
    dates: [],
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (/^\d{8}$/.test(item) && !args.dates.includes(item)) args.dates.push(item);
  }
  if (args.dates.length === 0) args.dates = [todayString(), '20261023', '20261102'];
  return args;
};

// 读取板块配置并按板块聚合成分股（占位条目与重复代码剔除）
const loadBlocks = () => {
  const list = getBlocksConfig();
  const blocks = new Map();
  for (const item of list) {
    const blockName = String(item.blockName || '').trim();
    const code = String(item.code || '').trim();
    if (!blockName || !/^(sh|sz|bj)\d{6}$/.test(code)) continue;
    let block = blocks.get(blockName);
    if (!block) {
      block = { name: blockName, tag: '', stocks: [], seen: new Set() };
      blocks.set(blockName, block);
    }
    if (!block.tag && item.tag) block.tag = item.tag;
    if (block.seen.has(code)) continue;
    block.seen.add(code);
    block.stocks.push({ code, name: String(item.name || code).trim() });
  }
  return [...blocks.values()].map((block) => ({ name: block.name, tag: block.tag, stocks: block.stocks }));
};

// 分时点 → [{ minute, change }]（change 为涨幅 %）
const prepareStock = (tline) => {
  const preclose = Number(tline?.preclose_px) || 0;
  const points = [];
  for (const item of tline?.line || []) {
    const hhmm = Number(item.minute);
    if (!Number.isFinite(hhmm) || hhmm <= 0) continue;
    const minute = Math.floor(hhmm / 100) * 60 + (hhmm % 100);
    let change = Number(item.change);
    if (!Number.isFinite(change)) {
      const price = Number(item.last_px);
      change = preclose > 0 && Number.isFinite(price) ? ((price - preclose) / preclose) * 100 : null;
    }
    points.push({ minute, change });
  }
  points.sort((a, b) => a.minute - b.minute);
  return points;
};

// 二分查找最后一个 <= 目标分钟的涨幅
const sampleAt = (points, targetMinute) => {
  let left = 0;
  let right = points.length - 1;
  let hit = null;
  while (left <= right) {
    const middle = (left + right) >> 1;
    if (points[middle].minute <= targetMinute) {
      hit = points[middle];
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return hit;
};

const mapLimit = async (items, limit, worker) => {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
};

// 统计单个交易日的板块分时平均涨幅
const computeDate = async (targetDate, blocks, membership, concurrency) => {
  const codes = [...membership.keys()];
  console.log(`[板块分时均值] ${targetDate} 开始：板块 ${blocks.length} 个，成分股 ${codes.length} 只`);

  // 板块 × 时间桶聚合
  const stats = new Map(blocks.map((block) => [
    block.name,
    BUCKETS.map(() => ({ sumChange: 0, count: 0, up: 0, down: 0 })),
  ]));
  const matchedCodes = new Set();
  const missingCodes = [];
  let finished = 0;
  const startedAt = Date.now();

  await mapLimit(codes, concurrency, async (code) => {
    let points = null;
    for (let attempt = 0; attempt < STOCK_FETCH_RETRY && !points; attempt++) {
      try {
        const tline = await getSingleStockTlineDataByDateLean(code, Number(targetDate));
        const prepared = tline ? prepareStock(tline) : [];
        if (prepared.length > 0) points = prepared;
      } catch (e) {
        points = null;
      }
      if (!points && attempt < STOCK_FETCH_RETRY - 1) await sleep(200);
    }
    finished++;
    if (finished % 100 === 0 || finished === codes.length) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[板块分时均值] ${targetDate} 分时加载 ${finished}/${codes.length}，有效 ${matchedCodes.size}，失败 ${missingCodes.length}，已耗时 ${elapsed}s`);
    }
    if (!points) {
      missingCodes.push(code);
      return;
    }
    matchedCodes.add(code);

    const stock = membership.get(code);
    const bucketChanges = BUCKETS.map((bucketMinute) => {
      const at = sampleAt(points, bucketMinute);
      return at && Number.isFinite(at.change) ? at.change : null;
    });

    for (const blockName of stock.blocks) {
      const rows = stats.get(blockName);
      if (!rows) continue;
      for (let i = 0; i < BUCKETS.length; i++) {
        const change = bucketChanges[i];
        if (change === null) continue;
        const row = rows[i];
        row.sumChange += change;
        row.count += 1;
        if (change > 0) row.up += 1;
        else if (change < 0) row.down += 1;
      }
    }
  });

  const series = blocks.map((block) => {
    const rows = stats.get(block.name);
    const points = BUCKETS.map((bucketMinute, index) => {
      const row = rows[index];
      return {
        time: timeLabel(bucketMinute),
        avgChange: row.count > 0 ? round2(row.sumChange / row.count) : null,
        count: row.count,
        up: row.up,
        down: row.down,
      };
    });
    const last = [...points].reverse().find((point) => point.avgChange !== null) || null;
    return {
      name: block.name,
      tag: block.tag,
      memberCount: block.stocks.length,
      matchedCount: block.stocks.filter((stock) => matchedCodes.has(stock.code)).length,
      lastTime: last ? last.time : '',
      lastAvgChange: last ? last.avgChange : null,
      points,
    };
  });

  // 最新平均涨幅从高到低，无数据的排最后
  series.sort((a, b) => {
    const aLast = a.lastAvgChange === null ? -Infinity : a.lastAvgChange;
    const bLast = b.lastAvgChange === null ? -Infinity : b.lastAvgChange;
    return bLast - aLast;
  });

  const top = series[0];
  console.log(`[板块分时均值] ${targetDate} 完成：有效 ${matchedCodes.size}/${codes.length}，最新榜首 ${top ? `${top.name} ${top.lastAvgChange}%` : '--'}`);

  return {
    date: targetDate,
    buckets: BUCKETS.map((minute) => timeLabel(minute)),
    coverage: {
      blocks: blocks.length,
      totalStocks: membership.size,
      matchedStocks: matchedCodes.size,
      missingStocks: missingCodes.length,
    },
    missingCodes,
    series,
  };
};

const run = async () => {
  const args = parseArgs(process.argv);
  const blocks = loadBlocks();

  // 股票去重，记录所属板块
  const membership = new Map();
  for (const block of blocks) {
    for (const stock of block.stocks) {
      let item = membership.get(stock.code);
      if (!item) {
        item = { code: stock.code, name: stock.name, blocks: [] };
        membership.set(stock.code, item);
      }
      if (!item.blocks.includes(block.name)) item.blocks.push(block.name);
    }
  }

  console.log(`[板块分时均值] 待统计交易日：${args.dates.join(', ')}；时间桶 ${BUCKETS.length} 个（${timeLabel(BUCKETS[0])} ~ ${timeLabel(BUCKETS[BUCKETS.length - 1])}，${INTERVAL_MINUTES} 分钟，跳过午休）`);

  const dates = [];
  for (const date of args.dates) {
    dates.push(await computeDate(date, blocks, membership, args.concurrency));
  }

  const data = {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    intervalMinutes: INTERVAL_MINUTES,
    dates,
  };

  const html = renderHtml(data);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');
  console.log(`[板块分时均值] 已生成 ${OUTPUT_PATH}`);
};

const renderHtml = (data) => {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>重点板块分时平均涨跌幅</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:#f4f6f9;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.page-head{max-width:1680px;margin:0 auto 14px;padding:18px 22px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 8px 24px rgba(15,23,42,.06)}
.page-head h1{margin:0 0 12px;font-size:22px;letter-spacing:.5px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.tab-btn{border:1px solid #e2e8f0;background:#f8fafc;color:#475569;border-radius:10px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}
.tab-btn:hover{border-color:#c7d2fe;color:#4338ca}
.tab-btn.active{background:#4338ca;border-color:#4338ca;color:#fff;box-shadow:0 6px 16px rgba(67,56,202,.25)}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:#64748b;font-size:12px;line-height:1.7}
.meta strong{color:#1f2937;font-weight:600}
.grid{max-width:1680px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(700px,1fr));gap:14px}
.panel{display:none}
.panel.active{display:block}
.panel-meta{max-width:1680px;margin:0 auto 12px;padding:0 2px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px 8px;box-shadow:0 6px 18px rgba(15,23,42,.05);overflow:hidden}
.card-head{display:flex;align-items:baseline;gap:8px}
.rank{font-size:11px;color:#94a3b8;font-weight:700;min-width:22px}
.name{font-size:16px;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:11px;white-space:nowrap}
.avg{margin-left:auto;font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}
.avg-unit{font-size:11px;color:#94a3b8;font-weight:500;margin-left:2px}
.sub{margin-top:5px;font-size:11px;color:#64748b;line-height:1.6;font-variant-numeric:tabular-nums}
.sub b{color:#334155;font-weight:600}
.chart{margin-top:4px;cursor:crosshair}
.chart svg{display:block;width:100%;height:auto}
.tip{position:fixed;z-index:30;min-width:190px;padding:9px 11px;border-radius:10px;background:rgba(17,24,39,.95);color:#e5e7eb;font-size:11px;line-height:1.7;box-shadow:0 10px 30px rgba(15,23,42,.35);pointer-events:none;opacity:0;transition:opacity .12s}
.tip-time{font-size:12px;font-weight:700;color:#fff;margin-bottom:2px}
.tip-avg{font-size:15px;font-weight:800;margin-bottom:4px;font-variant-numeric:tabular-nums}
.tip-row{display:flex;justify-content:space-between;gap:16px;white-space:nowrap}
.tip-row span:last-child{font-variant-numeric:tabular-nums;color:#cbd5e1}
.foot{max-width:1680px;margin:16px auto 0;padding:14px 18px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;color:#64748b;font-size:12px;line-height:1.8}
.foot b{color:#334155}
.foot .tag{margin-right:6px;background:#eef2ff;color:#4338ca}
</style>
</head>
<body>
<div class="page-head">
<h1>重点板块分时平均涨跌幅</h1>
<div class="tabs" id="tabs"></div>
<div class="meta" id="head-meta"></div>
</div>
<div id="panels"></div>
<div class="tip" id="tip"></div>
<div class="foot">
<div><span class="tag">口径</span>板块平均涨幅 = 板块内当日有分时数据的成分股涨跌幅算术平均；每个时间点取该分钟及之前最近的分时点；缺失分时的成分股不计入平均。</div>
<div><span class="tag">时间轴</span>横轴按交易时间连续排列，间隔 ${data.intervalMinutes} 分钟，午休（11:30~13:00）跳过，图中虚线为午休分隔。</div>
</div>
<script>
const DATA = ${payload};
function esc(text){return String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function signed(value,digits){if(value===null||value===undefined||!isFinite(value))return "--";return (value>=0?"+":"")+Number(value).toFixed(digits===undefined?2:digits);}
function colorOf(value){if(value===null||value===undefined||!isFinite(value))return "#94a3b8";return value>=0?"#e11d48":"#059669";}
function dateDisplay(date){return date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6,8);}
function rangeOf(series){
const valid=[];
series.points.forEach(function(point){if(point.avgChange!==null)valid.push(point.avgChange);});
let minY=0,maxY=0;
if(valid.length){minY=Math.min.apply(null,valid);maxY=Math.max.apply(null,valid);}
if(maxY-minY<1){const mid=(maxY+minY)/2;minY=mid-0.5;maxY=mid+0.5;}
const pad=Math.max(0.2,(maxY-minY)*0.12);
minY-=pad;maxY+=pad;
if(minY>0)minY=0;
if(maxY<0)maxY=0;
return {minY:minY,maxY:maxY};
}

const W=560,H=200,L=40,R=14,T=14,B=46;
function chartSvg(series,buckets){
const n=buckets.length;
function xPos(index){return L+(n<=1?0:index/(n-1))*(W-L-R);}
const range=rangeOf(series);const minY=range.minY;const maxY=range.maxY;
function yPos(value){return T+(maxY-value)/(maxY-minY)*(H-T-B);}
const lunchIndex=buckets.indexOf("13:05");

let grids="";
for(let i=0;i<n;i++){
const label=buckets[i];
const major=(label.slice(-2)==="00"||label.slice(-2)==="30"||i===0||i===n-1);
if(major){grids+="<line x1=\\""+xPos(i)+"\\" y1=\\""+T+"\\" x2=\\""+xPos(i)+"\\" y2=\\""+(H-B)+"\\" stroke=\\"#eef2f7\\" stroke-width=\\"1\\"/>";}
}
const zeroLine="<line x1=\\""+L+"\\" y1=\\""+yPos(0)+"\\" x2=\\""+(W-R)+"\\" y2=\\""+yPos(0)+"\\" stroke=\\"#cbd5e1\\" stroke-dasharray=\\"3 3\\" stroke-width=\\"1\\"/><text x=\\""+(L-5)+"\\" y=\\""+(yPos(0)+3)+"\\" text-anchor=\\"end\\" font-size=\\"9\\" fill=\\"#94a3b8\\">0</text>";
const topLabel="<text x=\\""+(L-5)+"\\" y=\\""+(T+8)+"\\" text-anchor=\\"end\\" font-size=\\"9\\" fill=\\""+colorOf(maxY)+"\\">"+signed(maxY)+"</text>";
const bottomLabel="<text x=\\""+(L-5)+"\\" y=\\""+(H-B+2)+"\\" text-anchor=\\"end\\" font-size=\\"9\\" fill=\\""+colorOf(minY)+"\\">"+signed(minY)+"</text>";
const lunch=lunchIndex>0?"<line x1=\\""+xPos(lunchIndex-0.5)+"\\" y1=\\""+T+"\\" x2=\\""+xPos(lunchIndex-0.5)+"\\" y2=\\""+(H-B)+"\\" stroke=\\"#dbeafe\\" stroke-width=\\"4\\" stroke-dasharray=\\"6 4\\"/><text x=\\""+(xPos(lunchIndex-0.5)+4)+"\\" y=\\""+(T+9)+"\\" font-size=\\"8\\" fill=\\"#93c5fd\\">午休</text>":"";

// 连续有效点分段绘制，避免缺失数据被直线连接
let segments="";let dots="";let current="";
series.points.forEach(function(point,index){
if(point.avgChange===null){if(current){segments+="<polyline fill=\\"none\\" stroke=\\""+colorOf(series.lastAvgChange)+"\\" stroke-width=\\"1.6\\" points=\\""+current+"\\"/>";current="";}return;}
const x=xPos(index);const y=yPos(point.avgChange);
current+=(current?" ":"")+x+","+y;
dots+="<circle cx=\\""+x+"\\" cy=\\""+y+"\\" r=\\"2\\" fill=\\""+colorOf(point.avgChange)+"\\" pointer-events=\\"none\\"/>";
});
if(current)segments+="<polyline fill=\\"none\\" stroke=\\""+colorOf(series.lastAvgChange)+"\\" stroke-width=\\"1.6\\" points=\\""+current+"\\"/>";

const xLabels=buckets.map(function(label,index){
return "<text transform=\\"translate("+xPos(index)+","+(H-B+12)+") rotate(-45)\\" text-anchor=\\"end\\" font-size=\\"8\\" fill=\\"#94a3b8\\">"+label+"</text>";
}).join("");
const cross="<line class=\\"xhair\\" x1=\\"0\\" y1=\\""+T+"\\" x2=\\"0\\" y2=\\""+(H-B)+"\\" stroke=\\"#64748b\\" stroke-width=\\"1\\" stroke-dasharray=\\"3 3\\" style=\\"display:none\\"/><circle class=\\"xdot\\" r=\\"4\\" fill=\\"#fff\\" stroke=\\"#334155\\" stroke-width=\\"1.5\\" style=\\"display:none\\"/>";
return "<svg viewBox=\\"0 0 "+W+" "+H+"\\" preserveAspectRatio=\\"xMidYMid meet\\">"+grids+lunch+zeroLine+topLabel+bottomLabel+segments+dots+cross+xLabels+"</svg>";
}

function tipHtml(series,index){
const point=series.points[index];
return "<div class=\\"tip-time\\">"+esc(point.time)+"</div>"+
"<div class=\\"tip-avg\\" style=\\"color:"+colorOf(point.avgChange)+"\\">"+signed(point.avgChange)+"%</div>"+
"<div class=\\"tip-row\\"><span>有效成分股</span><span>"+point.count+" / "+series.memberCount+"</span></div>"+
"<div class=\\"tip-row\\"><span>上涨 / 下跌 / 平盘</span><span>"+point.up+" / "+point.down+" / "+(point.count-point.up-point.down)+"</span></div>"+
"<div class=\\"tip-row\\"><span>板块</span><span>"+esc(series.name)+"</span></div>";
}

const tip=document.getElementById("tip");
function attachHover(chart,series,buckets){
const svg=chart.querySelector("svg");
const xhair=svg.querySelector(".xhair");const xdot=svg.querySelector(".xdot");
const n=buckets.length;
const range=rangeOf(series);
function xPos(index){return L+(n<=1?0:index/(n-1))*(W-L-R);}
function yPos(value){return T+(range.maxY-value)/(range.maxY-range.minY)*(H-T-B);}
let activeIndex=-1;
function hideTip(){tip.style.opacity="0";xhair.style.display="none";xdot.style.display="none";activeIndex=-1;}
chart.addEventListener("mousemove",function(event){
const rect=svg.getBoundingClientRect();
const viewX=(event.clientX-rect.left)/rect.width*W;
let nearest=-1;let nearestDist=Infinity;
series.points.forEach(function(point,i){
if(point.avgChange===null)return;
const dist=Math.abs(xPos(i)-viewX);
if(dist<nearestDist){nearestDist=dist;nearest=i;}
});
if(nearest<0)return;
if(nearest!==activeIndex){
activeIndex=nearest;
const point=series.points[nearest];
tip.innerHTML=tipHtml(series,nearest);
const px=xPos(nearest);const py=yPos(point.avgChange);
xhair.setAttribute("x1",px);xhair.setAttribute("x2",px);xhair.style.display="block";
xdot.setAttribute("cx",px);xdot.setAttribute("cy",py);xdot.style.display="block";
}
const offset=14;let left=event.clientX+offset;let top=event.clientY+offset;
if(left+tip.offsetWidth>window.innerWidth-8)left=event.clientX-tip.offsetWidth-offset;
if(top+tip.offsetHeight>window.innerHeight-8)top=event.clientY-tip.offsetHeight-offset;
tip.style.left=left+"px";tip.style.top=top+"px";tip.style.opacity="1";
});
chart.addEventListener("mouseleave",hideTip);
}

function renderPanel(tab,panel){
const covered=tab.coverage.matchedStocks+"/"+tab.coverage.totalStocks;
const panelMeta=document.createElement("div");
panelMeta.className="panel-meta meta";
panelMeta.innerHTML="<span><strong>交易日</strong> "+dateDisplay(tab.date)+"</span>"+
"<span><strong>时间桶</strong> "+DATA.intervalMinutes+" 分钟（09:35 ~ 11:30 / 13:05 ~ 15:00，跳过午休）</span>"+
"<span><strong>板块</strong> "+tab.coverage.blocks+" 个</span>"+
"<span><strong>成分股</strong> "+covered+" 只有效分时</span>";
panel.appendChild(panelMeta);

const grid=document.createElement("div");grid.className="grid";
tab.series.forEach(function(series,index){
const card=document.createElement("div");card.className="card";
const sampleCount=series.points.filter(function(point){return point.avgChange!==null;}).length;
card.innerHTML="<div class=\\"card-head\\"><span class=\\"rank\\">#"+(index+1)+"</span><span class=\\"name\\">"+esc(series.name)+"</span>"+
(series.tag?"<span class=\\"tag\\">"+esc(series.tag)+"</span>":"")+
"<span class=\\"avg\\" style=\\"color:"+colorOf(series.lastAvgChange)+"\\">"+signed(series.lastAvgChange)+"<span class=\\"avg-unit\\">%</span></span></div>"+
"<div class=\\"sub\\">成分股 <b>"+series.matchedCount+"/"+series.memberCount+"</b> 只有效分时 · 最新 <b>"+esc(series.lastTime||"--")+"</b> · 采样点 <b>"+sampleCount+"</b></div>"+
"<div class=\\"chart\\">"+chartSvg(series,tab.buckets)+"</div>";
grid.appendChild(card);
attachHover(card.querySelector(".chart"),series,tab.buckets);
});
panel.appendChild(grid);
}

const tabs=document.getElementById("tabs");
const panels=document.getElementById("panels");
document.getElementById("head-meta").innerHTML="<span><strong>采样间隔</strong> "+DATA.intervalMinutes+" 分钟</span>"+
"<span><strong>交易日</strong> "+DATA.dates.length+" 天</span>"+
"<span><strong>生成时间</strong> "+esc(DATA.generatedAt)+"</span>";

const panelNodes=[];
DATA.dates.forEach(function(tab,index){
const btn=document.createElement("button");
btn.className="tab-btn"+(index===0?" active":"");
btn.textContent=dateDisplay(tab.date);
tabs.appendChild(btn);
const panel=document.createElement("div");
panel.className="panel"+(index===0?" active":"");
panels.appendChild(panel);
panelNodes.push(panel);
renderPanel(tab,panel);
btn.addEventListener("click",function(){
document.querySelectorAll(".tab-btn").forEach(function(node){node.classList.remove("active");});
panelNodes.forEach(function(node){node.classList.remove("active");});
btn.classList.add("active");
panel.classList.add("active");
tip.style.opacity="0";
});
});
</script>
</body>
</html>`;
};

run().catch((error) => {
  console.error('[板块分时均值] 执行失败:', error.message || error);
  process.exit(1);
});
