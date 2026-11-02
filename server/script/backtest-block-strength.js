// 一级板块强度回测：按 10 分钟时间桶回放最近一个交易日的板块强度分（10:00 ~ 15:00）
//
// 数据来源：
//   1. 个股分时（同花顺，失败回退财联社）：涨幅、累计成交额，用于平均涨幅 / 涨停家数 / 板块成交额
//      - 复用 /get_stock_tline_data?code=&date= 的底层实现 getSingleStockTlineDataByDateLean，自动落盘缓存
//   2. data/amount.json：当日全市场实时累计成交额（占比分母）
//   3. service/板块成交量占比计算/category_amount_money_result.json + data/amount_day_history.json：
//      上一交易日各一级板块成交额与全市场成交额（昨日占比）
//
// 评分口径与 /block_strength_analysis 保持一致（满分 110，涨停家数最低 0 分，其余可为负分）：
//   平均涨幅 ±10% → ±30 分；涨停家数 50 个封顶 → 0~40 分；
//   日成交量占比相对昨日 ±100% → ±20 分；较 30 分钟前占比 ±100% → ±20 分。
//
// 用法：
//   node script/backtest-block-strength.js                 默认回测 amount.json 中最新交易日
//   node script/backtest-block-strength.js 20261030        指定交易日
//   node script/backtest-block-strength.js 20261030 --limit 30 --concurrency 8
// 输出：
//   script/block-strength-backtest.html
const fs = require('fs');
const path = require('path');
const { getSingleStockTlineDataByDateLean } = require('../src/service/stock');
const { CATEGORY_NAMES } = require('../src/service/板块成交量占比计算/category_amount_money');
const { parseAmountToYi } = require('../src/service/amount');

const DATA_DIR = path.resolve(__dirname, '../src/data');
const CONSTITUENT_DIR = path.join(DATA_DIR, '东方财富板块成分股汇总');
const AMOUNT_PATH = path.join(DATA_DIR, 'amount.json');
const AMOUNT_HISTORY_PATH = path.join(DATA_DIR, 'amount_day_history.json');
const CATEGORY_MONEY_PATH = path.resolve(__dirname, '../src/service/板块成交量占比计算/category_amount_money_result.json');
const OUTPUT_PATH = path.join(__dirname, 'block-strength-backtest.html');

const SCORE_WEIGHTS = { avgChange: 30, limitUp: 40, dayRatio: 20, ratio30m: 20 };
const AVG_CHANGE_RANGE = 10;
const MAX_LIMIT_UP = 50;
const MAX_RATIO_CHANGE_PCT = 100;
const RATIO_30M_MINUTES = 30;
const RATIO_30M_EARLIEST_MINUTE = 575; // 9:35（分钟数，9:30=570）
const STOCK_CONCURRENCY = 10;
const STOCK_FETCH_RETRY = 2;

// 时间桶（分钟数，10:00=600；跳过 11:30~13:00 午休）
const BUCKETS = [];
for (let m = 600; m <= 690; m += 10) BUCKETS.push(m);
for (let m = 780; m <= 900; m += 10) BUCKETS.push(m);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : value);

const minuteToHHmm = (minuteOfDay) => Math.floor(minuteOfDay / 60) * 100 + (minuteOfDay % 60);
const timeLabel = (minuteOfDay) => {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};
// 分钟数 → 交易分钟（9:30=0，11:30=120，13:00=120，15:00=240）
const toTradingMinute = (minuteOfDay) => {
  if (minuteOfDay <= 690) return minuteOfDay - 570;
  if (minuteOfDay <= 780) return 120;
  return 120 + (minuteOfDay - 780);
};
// 30 分钟前的基准分钟数（最早 9:35；11:30~13:00 之间统一按午休处理）
const baselineMinuteOf = (bucketMinute) => {
  const tradingMinute = toTradingMinute(bucketMinute);
  const target = Math.max(tradingMinute - RATIO_30M_MINUTES, RATIO_30M_EARLIEST_MINUTE - 570);
  if (target < 120) return 570 + target;
  if (target === 120) return bucketMinute >= 780 ? 780 : 690;
  return 780 + (target - 120);
};

const parseArgs = (argv) => {
  const args = { date: null, limit: 0, concurrency: STOCK_CONCURRENCY };
  for (let i = 2; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--limit') args.limit = Number(argv[++i]) || 0;
    else if (item === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || STOCK_CONCURRENCY);
    else if (/^\d{8}$/.test(item)) args.date = item;
  }
  return args;
};

// 读取 amount.json 并推断默认交易日
const loadAmountFile = () => {
  const raw = JSON.parse(fs.readFileSync(AMOUNT_PATH, 'utf-8'));
  const dates = raw
    .map((item) => item?.[1]?.date)
    .filter((d) => /^\d{8}$/.test(String(d)))
    .map(String);
  const latestDate = dates.sort()[dates.length - 1];
  return { raw, latestDate };
};

// 当日全市场累计成交额时间线（单位：亿），按秒升序
const buildAmountTimeline = (raw, date) => {
  const timeline = raw
    .filter((item) => item?.[1]?.date === date)
    .map((item) => ({
      sec: Number(item[0]),
      yi: parseAmountToYi(item[1].totalAmount),
    }))
    .filter((row) => Number.isFinite(row.sec) && Number.isFinite(row.yi) && row.yi > 0)
    .sort((a, b) => a.sec - b.sec);
  return timeline;
};

// 取某个分钟数对应的全市场成交额（亿）
// 优先取之前的最近一条；若距目标时间超过 2 分钟（如 13:00 午休后首条在 13:00:59），取之后 60 秒内的首条
const marketTotalAt = (timeline, minuteOfDay) => {
  const target = minuteToHHmm(minuteOfDay) * 100; // 如 10:00 → 100000
  let before = null;
  let after = null;
  for (const row of timeline) {
    if (row.sec <= target) before = row;
    else {
      after = row;
      break;
    }
  }
  if (before && target - before.sec <= 120) return before.yi;
  if (after && after.sec - target <= 60) return after.yi;
  return before ? before.yi : (after ? after.yi : null);
};

// 读取一级板块成分股
const loadCategories = () => {
  return CATEGORY_NAMES.map((name) => {
    const file = path.join(CONSTITUENT_DIR, `${name}.json`);
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const seen = new Set();
    const stocks = [];
    for (const item of list) {
      const code = String(item.code || '').trim();
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      stocks.push({ code, name: String(item.name || code).trim() });
    }
    return { name, stocks };
  }).filter((item) => item.stocks.length > 0);
};

// 上一交易日板块占比（板块成交额 / 全市场成交额）
const loadPrevDayRatios = (targetDate) => {
  const moneyData = JSON.parse(fs.readFileSync(CATEGORY_MONEY_PATH, 'utf-8'));
  const history = JSON.parse(fs.readFileSync(AMOUNT_HISTORY_PATH, 'utf-8'));
  const dates = new Set();
  for (const rows of Object.values(moneyData)) {
    for (const row of rows || []) {
      const date = String(row.date || '');
      if (date && date < targetDate) dates.add(date);
    }
  }
  const prevDate = [...dates].sort().pop() || null;
  const prevTotalYi = history.find((row) => String(row.date) === prevDate)?.totalAmount;
  const ratios = {};
  if (prevDate && Number.isFinite(Number(prevTotalYi)) && Number(prevTotalYi) > 0) {
    const prevTotalYuan = Number(prevTotalYi) * 1e8;
    for (const name of CATEGORY_NAMES) {
      const row = (moneyData[name] || []).find((item) => String(item.date) === prevDate);
      if (row && Number.isFinite(Number(row.money)) && Number(row.money) > 0) {
        ratios[name] = (Number(row.money) / prevTotalYuan) * 100;
      }
    }
  }
  return { prevDate, prevTotalYi: Number(prevTotalYi) || null, ratios };
};

// 把分时点转换为分钟数 + 涨幅 + 累计成交额
const prepareStock = (tline) => {
  const preclose = Number(tline?.preclose_px) || 0;
  let cumulative = 0;
  const points = [];
  for (const item of tline?.line || []) {
    const hhmm = Number(item.minute);
    if (!Number.isFinite(hhmm) || hhmm <= 0) continue;
    const minuteOfDay = Math.floor(hhmm / 100) * 60 + (hhmm % 100);
    const amount = Number(item.business_balance);
    if (Number.isFinite(amount) && amount > 0) cumulative += amount;
    let change = Number(item.change);
    if (!Number.isFinite(change)) {
      const price = Number(item.last_px);
      change = preclose > 0 && Number.isFinite(price) ? ((price - preclose) / preclose) * 100 : null;
    }
    points.push({ minute: minuteOfDay, change, amount: cumulative });
  }
  points.sort((a, b) => a.minute - b.minute);
  return points;
};

// 二分查找最后一个 <= 目标分钟的分时点
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

const isLimitUp = (code, name, changePct) => {
  if (!Number.isFinite(changePct)) return false;
  if (/ST/i.test(name)) return changePct >= 4.8;
  const prefix = code.slice(0, 2);
  if (prefix === '30' || prefix === '68') return changePct >= 19.8;
  return changePct >= 9.8;
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

const run = async () => {
  const args = parseArgs(process.argv);
  const { raw, latestDate } = loadAmountFile();
  const targetDate = args.date || latestDate;
  if (!targetDate) throw new Error('amount.json 中没有可用的交易日');

  const timeline = buildAmountTimeline(raw, targetDate);
  if (timeline.length === 0) {
    throw new Error(`amount.json 中没有 ${targetDate} 的全市场成交额数据，无法回测`);
  }

  const categories = loadCategories();
  const prevDay = loadPrevDayRatios(targetDate);

  // 股票去重 + 记录所属板块（同一只股票可能属于多个一级板块）
  const membership = new Map();
  for (const category of categories) {
    for (const stock of category.stocks) {
      let item = membership.get(stock.code);
      if (!item) {
        item = { code: stock.code, name: stock.name, categories: [] };
        membership.set(stock.code, item);
      }
      if (!item.categories.includes(category.name)) item.categories.push(category.name);
    }
  }
  let codes = [...membership.keys()];
  if (args.limit > 0) codes = codes.slice(0, args.limit);

  console.log(`[强度回测] 交易日 ${targetDate}，一级板块 ${categories.length} 个，成分股 ${membership.size} 只（本次加载 ${codes.length} 只）`);
  console.log(`[强度回测] 时间桶 ${BUCKETS.length} 个（${timeLabel(BUCKETS[0])} ~ ${timeLabel(BUCKETS[BUCKETS.length - 1])}，10min，跳过午休）`);
  console.log(`[强度回测] 昨日占比基准 ${prevDay.prevDate || '缺失'}，全市场成交额 ${prevDay.prevTotalYi || '缺失'} 亿`);

  // 逐只加载分时，直接聚合到板块 × 时间桶，避免把数千只股票的全量分时驻留内存
  const stats = new Map(categories.map((category) => [
    category.name,
    BUCKETS.map(() => ({ sumChange: 0, count: 0, limitUp: 0, amount: 0, baseAmount: 0 })),
  ]));
  const matchedCodes = new Set();
  const missingCodes = [];
  let finished = 0;
  const startedAt = Date.now();

  await mapLimit(codes, args.concurrency, async (code) => {
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
      console.log(`[强度回测] 分时加载 ${finished}/${codes.length}，有效 ${matchedCodes.size}，失败 ${missingCodes.length}，已耗时 ${elapsed}s`);
    }
    if (!points) {
      missingCodes.push(code);
      return;
    }
    matchedCodes.add(code);

    const bucketSamples = BUCKETS.map((bucketMinute) => {
      const at = sampleAt(points, bucketMinute);
      const base = sampleAt(points, baselineMinuteOf(bucketMinute));
      return {
        change: at && Number.isFinite(at.change) ? at.change : null,
        amount: at ? at.amount : 0,
        baseAmount: base ? base.amount : 0,
      };
    });

    const stock = membership.get(code);
    for (const categoryName of stock.categories) {
      const rows = stats.get(categoryName);
      if (!rows) continue;
      for (let i = 0; i < BUCKETS.length; i++) {
        const sample = bucketSamples[i];
        const row = rows[i];
        if (sample.change !== null) {
          row.sumChange += sample.change;
          row.count += 1;
          if (isLimitUp(stock.code, stock.name, sample.change)) row.limitUp += 1;
        }
        row.amount += sample.amount || 0;
        row.baseAmount += sample.baseAmount || 0;
      }
    }
  });

  // 分母：各时间桶与 30 分钟前基准时点的全市场累计成交额（亿）
  const marketTotals = BUCKETS.map((minute) => marketTotalAt(timeline, minute));
  const baseMarketTotals = BUCKETS.map((minute) => marketTotalAt(timeline, baselineMinuteOf(minute)));

  const series = categories.map((category) => {
    const rows = stats.get(category.name);
    const prevRatio = prevDay.ratios[category.name];
    const points = BUCKETS.map((bucketMinute, index) => {
      const row = rows[index];
      const avgChange = row.count > 0 ? row.sumChange / row.count : null;
      const avgChangeScore = avgChange !== null ? clamp(avgChange / AVG_CHANGE_RANGE, -1, 1) * SCORE_WEIGHTS.avgChange : 0;
      const limitUpScore = clamp(row.limitUp / MAX_LIMIT_UP, 0, 1) * SCORE_WEIGHTS.limitUp;

      const marketYi = marketTotals[index];
      const todayRatio = marketYi > 0 && Number.isFinite(row.amount) ? (row.amount / (marketYi * 1e8)) * 100 : null;
      const dayRatioChangePct = todayRatio !== null && Number.isFinite(prevRatio) && prevRatio > 0
        ? clamp(((todayRatio - prevRatio) / prevRatio) * 100, -MAX_RATIO_CHANGE_PCT, MAX_RATIO_CHANGE_PCT)
        : null;
      const dayRatioScore = dayRatioChangePct !== null ? (dayRatioChangePct / MAX_RATIO_CHANGE_PCT) * SCORE_WEIGHTS.dayRatio : 0;

      const baseMarketYi = baseMarketTotals[index];
      const baseRatio = baseMarketYi > 0 && Number.isFinite(row.baseAmount) ? (row.baseAmount / (baseMarketYi * 1e8)) * 100 : null;
      const ratio30mChangePct = todayRatio !== null && baseRatio !== null && baseRatio > 0
        ? clamp(((todayRatio - baseRatio) / baseRatio) * 100, -MAX_RATIO_CHANGE_PCT, MAX_RATIO_CHANGE_PCT)
        : null;
      const ratio30mScore = ratio30mChangePct !== null ? (ratio30mChangePct / MAX_RATIO_CHANGE_PCT) * SCORE_WEIGHTS.ratio30m : 0;

      const totalScore = avgChangeScore + limitUpScore + dayRatioScore + ratio30mScore;
      return {
        time: timeLabel(bucketMinute),
        total: round2(totalScore),
        avgChange: round2(avgChange),
        avgChangeScore: round2(avgChangeScore),
        limitUp: row.limitUp,
        limitUpScore: round2(limitUpScore),
        todayRatio: round2(todayRatio),
        dayRatioChangePct: round2(dayRatioChangePct),
        dayRatioScore: round2(dayRatioScore),
        ratio30mTime: timeLabel(baselineMinuteOf(bucketMinute)),
        ratio30mAgo: round2(baseRatio),
        ratio30mChangePct: round2(ratio30mChangePct),
        ratio30mScore: round2(ratio30mScore),
        stockCount: row.count,
      };
    });

    return {
      name: category.name,
      memberCount: category.stocks.length,
      matchedCount: category.stocks.filter((stock) => matchedCodes.has(stock.code)).length,
      points,
    };
  });

  series.sort((a, b) => {
    const aLast = a.points[a.points.length - 1]?.total ?? -Infinity;
    const bLast = b.points[b.points.length - 1]?.total ?? -Infinity;
    return bLast - aLast;
  });

  const xLabels = [
    { index: 0, label: timeLabel(BUCKETS[0]) },
    { index: BUCKETS.indexOf(690), label: '11:30' },
    { index: BUCKETS.indexOf(780), label: '13:00' },
    { index: BUCKETS.length - 1, label: timeLabel(BUCKETS[BUCKETS.length - 1]) },
  ].filter((item) => item.index >= 0);

  const data = {
    date: targetDate,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    weights: SCORE_WEIGHTS,
    limits: { avgChangeRange: AVG_CHANGE_RANGE, maxLimitUp: MAX_LIMIT_UP, maxRatioChangePct: MAX_RATIO_CHANGE_PCT },
    coverage: {
      totalStocks: membership.size,
      matchedStocks: matchedCodes.size,
      loadedStocks: codes.length,
      missingStocks: missingCodes.length,
      categories: categories.length,
    },
    prevDay: { date: prevDay.prevDate, marketTotalYi: prevDay.prevTotalYi },
    buckets: BUCKETS.map((minute, index) => ({
      time: timeLabel(minute),
      marketTotalYi: round2(marketTotals[index]),
      baseTime: timeLabel(baselineMinuteOf(minute)),
      baseMarketTotalYi: round2(baseMarketTotals[index]),
    })),
    xLabels,
    series,
  };

  const html = renderHtml(data);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf-8');
  console.log(`[强度回测] 已生成 ${OUTPUT_PATH}`);
  if (missingCodes.length > 0) {
    console.log(`[强度回测] 缺失分时的股票 ${missingCodes.length} 只，前 20 个：${missingCodes.slice(0, 20).join(',')}`);
  }
  const latest = series[0];
  console.log(`[强度回测] 最新时间桶榜首：${latest.name} ${latest.points[latest.points.length - 1].total} 分`);
};

const renderHtml = (data) => {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const htmlParts = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>一级板块强度回测 ${data.date}</title>`,
    '<style>',
    ':root{color-scheme:light}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:24px;background:#f4f6f9;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.page-head{max-width:1680px;margin:0 auto 18px;padding:18px 22px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 8px 24px rgba(15,23,42,.06)}',
    '.page-head h1{margin:0 0 8px;font-size:22px;letter-spacing:.5px}',
    '.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:#64748b;font-size:12px;line-height:1.7}',
    '.meta strong{color:#1f2937;font-weight:600}',
    '.grid{max-width:1680px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}',
    '.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px 10px;box-shadow:0 6px 18px rgba(15,23,42,.05);overflow:hidden}',
    '.card-head{display:flex;align-items:baseline;gap:8px}',
    '.rank{font-size:11px;color:#94a3b8;font-weight:700;min-width:20px}',
    '.name{flex:1;font-size:16px;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.score{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}',
    '.score-unit{font-size:11px;color:#94a3b8;font-weight:500;margin-left:2px}',
    '.sub{margin-top:5px;font-size:11px;color:#64748b;line-height:1.6;font-variant-numeric:tabular-nums}',
    '.sub b{color:#334155;font-weight:600}',
    '.chart{margin-top:6px;cursor:crosshair}',
    '.chart svg{display:block;width:100%;height:auto}',
    '.tip{position:fixed;z-index:30;min-width:210px;padding:9px 11px;border-radius:10px;background:rgba(17,24,39,.95);color:#e5e7eb;font-size:11px;line-height:1.7;box-shadow:0 10px 30px rgba(15,23,42,.35);pointer-events:none;opacity:0;transition:opacity .12s}',
    '.tip-time{font-size:12px;font-weight:700;color:#fff;margin-bottom:2px}',
    '.tip-total{font-size:14px;font-weight:800;margin-bottom:4px;font-variant-numeric:tabular-nums}',
    '.tip-row{display:flex;justify-content:space-between;gap:16px;white-space:nowrap}',
    '.tip-row span:last-child{font-variant-numeric:tabular-nums;color:#cbd5e1}',
    '.foot{max-width:1680px;margin:16px auto 0;padding:14px 18px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;color:#64748b;font-size:12px;line-height:1.8}',
    '.foot b{color:#334155}',
    '.tag{display:inline-block;padding:1px 7px;margin-right:6px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:11px}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="page-head">',
    `<h1>一级板块强度回测 · ${data.date}</h1>`,
    '<div class="meta">',
    `<span><strong>时间桶</strong> 10 分钟（${data.buckets[0].time} ~ ${data.buckets[data.buckets.length - 1].time}，跳过午休）</span>`,
    `<span><strong>权重</strong> 平均涨幅 ${data.weights.avgChange} · 涨停 ${data.weights.limitUp} · 日占比 ${data.weights.dayRatio} · 较30分钟 ${data.weights.ratio30m}</span>`,
    `<span><strong>成分股覆盖</strong> ${data.coverage.matchedStocks}/${data.coverage.totalStocks}（${data.series.length} 个板块）</span>`,
    `<span><strong>昨日基准</strong> ${data.prevDay.date || '缺失'}（全市场 ${data.prevDay.marketTotalYi || '--'} 亿）</span>`,
    `<span><strong>生成时间</strong> ${data.generatedAt}</span>`,
    '</div>',
    '</div>',
    '<div class="grid" id="grid"></div>',
    '<div class="tip" id="tip"></div>',
    '<div class="foot">',
    '<div><span class="tag">口径</span>平均涨幅按 ±10% 线性映射到 ±30 分；涨停家数 50 个封顶、最低 0 分（主板 ≥9.8%、创业板/科创板 ≥19.8%、ST ≥4.8%）；日成交量占比与较 30 分钟前占比均按相对变化 ±100% 映射到 ±20 分，降低即为负分。</div>',
    `<div><span class="tag">数据</span>分子为个股分时累计成交额之和；分母为 amount.json 当日全市场累计成交额；昨日占比 = 上一交易日板块成交额 / 上一交易日全市场成交额。首个时间桶的 30 分钟基准为 9:35（${data.buckets[0].baseTime}），此后按交易分钟回溯 30 分钟并跨午休。</div>`,
    '</div>',
    '<script>',
    `const DATA = ${payload};`,
    'function esc(text){return String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
    'function fmt(value,digits){if(value===null||value===undefined||!isFinite(value))return "--";return Number(value).toFixed(digits===undefined?2:digits);}',
    'function signed(value,digits){if(value===null||value===undefined||!isFinite(value))return "--";return (value>=0?"+":"")+Number(value).toFixed(digits===undefined?2:digits);}',
    'function scoreColor(value){return value>=0?"#e5484d":"#2f9e44";}',
    'const totalValues=[];',
    'DATA.series.forEach(function(item){item.points.forEach(function(point){if(isFinite(point.total))totalValues.push(point.total);});});',
    'let minY=Math.floor((Math.min.apply(null,totalValues)||0)/10)*10-5;',
    'let maxY=Math.ceil((Math.max.apply(null,totalValues)||0)/10)*10+5;',
    'if(maxY-minY<60){const mid=(maxY+minY)/2;minY=mid-30;maxY=mid+30;}',
    'const W=360,H=158,L=34,R=10,T=10,B=22;',
    'function xPos(index,count){return L+(count<=1?0:index/(count-1))*(W-L-R);}',
    'function yPos(value){return T+(maxY-value)/(maxY-minY)*(H-T-B);}',
    'function tipHtml(point){',
    'const rows=[',
    '["平均涨幅",signed(point.avgChange)+"%（"+signed(point.avgChangeScore)+"分）"],',
    '["涨停家数",point.limitUp+" 家（"+signed(point.limitUpScore)+"分）"],',
    '["日成交量占比",signed(point.dayRatioChangePct)+"%（"+signed(point.dayRatioScore)+"分）"],',
    '["较"+esc(point.ratio30mTime||"30分钟前"),signed(point.ratio30mChangePct)+"%（"+signed(point.ratio30mScore)+"分）"]',
    '];',
    'return "<div class=\\"tip-time\\">"+esc(point.time)+" · 综合强度</div>"+',
    '"<div class=\\"tip-total\\" style=\\"color:"+scoreColor(point.total)+"\\">"+fmt(point.total)+" 分</div>"+',
    'rows.map(function(row){return "<div class=\\"tip-row\\"><span>"+row[0]+"</span><span>"+row[1]+"</span></div>";}).join("")+',
    '"<div class=\\"tip-row\\"><span>有效成分股</span><span>"+point.stockCount+" 只</span></div>";',
    '}',
    'function chartSvg(series){',
    'const points=series.points;const count=points.length;',
    'const line=points.map(function(point,index){return xPos(index,count)+","+yPos(point.total);}).join(" ");',
    'const dots=points.map(function(point,index){return "<circle cx=\\""+xPos(index,count)+"\\" cy=\\""+yPos(point.total)+"\\" r=\\"2.8\\" fill=\\""+scoreColor(point.total)+"\\" pointer-events=\\"none\\"/>";}).join("");',
    'const cross="<line class=\\"xhair\\" x1=\\"0\\" y1=\\""+T+"\\" x2=\\"0\\" y2=\\""+(H-B)+"\\" stroke=\\"#94a3b8\\" stroke-width=\\"1\\" stroke-dasharray=\\"3 3\\" style=\\"display:none\\"/><circle class=\\"xdot\\" r=\\"4\\" fill=\\"#fff\\" stroke=\\"#5470c6\\" stroke-width=\\"1.5\\" style=\\"display:none\\"/>";',
    'const labels=DATA.xLabels.map(function(item){',
    'const anchor=item.index===0?"start":(item.index===count-1?"end":"middle");',
    'return "<text x=\\""+xPos(item.index,count)+"\\" y=\\""+(H-6)+"\\" text-anchor=\\""+anchor+"\\" font-size=\\"9\\" fill=\\"#94a3b8\\">"+item.label+"</text>";',
    '}).join("");',
    'const zero=0>=minY&&0<=maxY?"<line x1=\\""+L+"\\" y1=\\""+yPos(0)+"\\" x2=\\""+(W-R)+"\\" y2=\\""+yPos(0)+"\\" stroke=\\"#cbd5e1\\" stroke-dasharray=\\"3 3\\" stroke-width=\\"1\\"/><text x=\\""+(L-4)+"\\" y=\\""+(yPos(0)+3)+"\\" text-anchor=\\"end\\" font-size=\\"9\\" fill=\\"#94a3b8\\">0</text>":"";',
    'const top="<text x=\\""+(L-4)+"\\" y=\\""+(T+8)+"\\" text-anchor=\\"end\\" font-size=\\"9\\" fill=\\"#94a3b8\\">"+Math.round(maxY)+"</text>";',
    'const bottom="<text x=\\""+(L-4)+"\\" y=\\""+(H-B+2)+"\\" text-anchor=\\"end\\" font-size=\\"9\\" fill=\\"#94a3b8\\">"+Math.round(minY)+"</text>";',
    'return "<svg viewBox=\\""+0+" "+0+" "+W+" "+H+"\\" preserveAspectRatio=\\"xMidYMid meet\\">"+zero+top+bottom+"<polyline fill=\\"none\\" stroke=\\"#5470c6\\" stroke-width=\\"1.8\\" points=\\""+line+"\\"/>"+dots+cross+labels+"</svg>";',
    '}',
    'const grid=document.getElementById("grid");',
    'const tip=document.getElementById("tip");',
    'DATA.series.forEach(function(series,index){',
    'const last=series.points[series.points.length-1]||{};',
    'const card=document.createElement("div");card.className="card";',
    'card.innerHTML="<div class=\\"card-head\\"><span class=\\"rank\\">#"+(index+1)+"</span><span class=\\"name\\">"+esc(series.name)+"</span><span class=\\"score\\" style=\\"color:"+scoreColor(last.total)+"\\">"+fmt(last.total)+"<span class=\\"score-unit\\">分</span></span></div>"+',
    '"<div class=\\"sub\\">成分股 <b>"+series.matchedCount+"/"+series.memberCount+"</b> · 最新 "+esc(last.time||"")+" · 平均涨幅 <b style=\\"color:"+(last.avgChange>=0?"#e5484d":"#2f9e44")+"\\">"+signed(last.avgChange)+"%</b>（"+signed(last.avgChangeScore)+"分） · 涨停 <b>"+last.limitUp+"</b> 家（"+signed(last.limitUpScore)+"分）</div>"+',
    '"<div class=\\"sub\\">日占比 "+signed(last.dayRatioChangePct)+"%（"+signed(last.dayRatioScore)+"分） · 较"+esc(last.ratio30mTime||"30分钟前")+" "+signed(last.ratio30mChangePct)+"%（"+signed(last.ratio30mScore)+"分） · 今日占比 "+fmt(last.todayRatio,3)+"%</div>"+',
    '"<div class=\\"chart\\">"+chartSvg(series)+"</div>";',
    'grid.appendChild(card);',
    'const chart=card.querySelector(".chart");const svg=chart.querySelector("svg");const xhair=svg.querySelector(".xhair");const xdot=svg.querySelector(".xdot");',
    'let activeIndex=-1;',
    'function hideTip(){tip.style.opacity="0";xhair.style.display="none";xdot.style.display="none";activeIndex=-1;}',
    'chart.addEventListener("mousemove",function(event){',
    'const rect=svg.getBoundingClientRect();const viewX=(event.clientX-rect.left)/rect.width*W;',
    'let nearest=0;for(let i=1;i<series.points.length;i++){if(Math.abs(xPos(i,series.points.length)-viewX)<Math.abs(xPos(nearest,series.points.length)-viewX))nearest=i;}',
    'if(nearest!==activeIndex){activeIndex=nearest;const point=series.points[nearest];const px=xPos(nearest,series.points.length);const py=yPos(point.total);',
    'tip.innerHTML=tipHtml(point);xhair.setAttribute("x1",px);xhair.setAttribute("x2",px);xhair.style.display="block";xdot.setAttribute("cx",px);xdot.setAttribute("cy",py);xdot.style.display="block";}',
    'const offset=14;let left=event.clientX+offset;let top=event.clientY+offset;',
    'if(left+tip.offsetWidth>window.innerWidth-8)left=event.clientX-tip.offsetWidth-offset;',
    'if(top+tip.offsetHeight>window.innerHeight-8)top=event.clientY-tip.offsetHeight-offset;',
    'tip.style.left=left+"px";tip.style.top=top+"px";tip.style.opacity="1";',
    '});',
    'chart.addEventListener("mouseleave",hideTip);',
    '});',
    '</script>',
    '</body>',
    '</html>',
  ];
  return htmlParts.join('\n');
};

run().catch((error) => {
  console.error('[强度回测] 执行失败:', error.message || error);
  process.exit(1);
});
