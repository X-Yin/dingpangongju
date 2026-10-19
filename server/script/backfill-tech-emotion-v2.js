// 科技情绪指数 V2 历史全量回溯脚本（2026-10-19）
// 用户指令：按 V2 标准（板块限制归一化 × 市值加权 + 冲高回落惩罚 × 0.2）把所有历史情绪回溯一遍，
// 覆盖买卖点回测与训练营消费的全部历史情绪数据（含历史分时情绪）。
//
// 用法：node script/backfill-tech-emotion-v2.js [day|intraday|camp|all]
//   day      → tech_index.json 全部历史日级条目 V2 重算（回测日级情绪唯一数据源）
//   intraday → tech_index_intraday.json + tech_index_intraday_5day.json 分时情绪 V2 重算
//              （保留原 time 时间轴，重拉历史分时逐点重算）
//   camp     → backtest_camp_cache/ 全部缓存 timeBuckets[].techEmotion（V1 分时情绪）原地重算为 V2，
//              并用回溯后的 tech_index.json 重算 prevDayTechEmotion / prevDayIsIcePoint / prevDayHasIce
//   all      → day → intraday → camp 依次执行（camp 依赖回溯后的 tech_index.json）
//
// 说明：
// - hasIce 标记（当日分时曾触及 -100，旧口径）保留原样不重算——超过 5 天的历史分时无法重拉，
//   且该标记记录的是历史事实（被买点诊断冰点豁免消费）。
// - 旧 V1 值留档在条目 v1ChangeSumResult 字段，便于对比与回滚。
// - 股票池口径：当前自选股中 isTech !== false 的科技股（与训练营回放构建、实时计算口径一致）。
// - 阈值校准（EMA3<-60、前日<-30、===-100 强卖等）不在本脚本范围，回溯后数值大幅缩小，
//   是否校准阈值需用户另行决策。

const path = require('path');
const fs = require('fs');
const axios = require('axios');

const { getClsReqUrl, getClsReqIndexUrl, batchParallel } = require('../src/utils');
const {
  computeTechEmotionV2Base,
  computeTechAvgChangeV2,
  computeTechEmotionV2,
  computePullbackPenaltyFromPullback,
} = require('../src/service/emotion');
const { getMonitorStocks } = require('../src/service/monitorStock');
const { getSingleStockTlineDataByDate } = require('../src/service/stock');

const DATA_DIR = path.resolve(__dirname, '../src/data');
const TECH_INDEX_FILE = path.join(DATA_DIR, 'tech_index.json');
const INTRADAY_FILE = path.join(DATA_DIR, 'tech_index_intraday.json');
const INTRADAY_5DAY_FILE = path.join(DATA_DIR, 'tech_index_intraday_5day.json');
const CAMP_DIR = path.join(DATA_DIR, 'backtest_camp_cache');
const CYB = 'sz399006';
const KCB = 'sh000688';

const techCodes = () => getMonitorStocks().filter(s => s.isTech !== false).map(s => s.code);

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; }
};

const atomicWrite = (f, content) => {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, f);
};

// 分时中 ≤ minute 的最近点；minute 早于首点（竞价时段 0918/0925 等）取首点
// （开盘价即竞价结果，竞价时点涨幅≈开盘涨幅，与原实时记录语义一致）
const findPointAt = (sortedLine, minute) => {
  if (!sortedLine || sortedLine.length === 0) return null;
  let point = null;
  for (const p of sortedLine) {
    if (Number(p.minute) <= minute) point = p;
    else break;
  }
  return point !== null ? point : sortedLine[0];
};

// 备份文件（存在 .bak_v1 时跳过，支持重跑）
const backupFile = (f) => {
  const bak = `${f}.bak_v1`;
  if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
};

// ============ 1. 日级回溯（tech_index.json） ============
const backfillDaily = async () => {
  console.log('========== [day] tech_index.json 日级历史回溯 ==========');
  backupFile(TECH_INDEX_FILE);
  const codes = techCodes();
  console.log(`科技股池 ${codes.length} 只（当前自选股 isTech !== false）`);

  // 每股拉 160 天日K → Map<'YYYYMMDD', klineItem>
  const fetchKline = async (code) => {
    try {
      const { data: { data: kline } } = await axios.get(getClsReqUrl(code, 160));
      const m = new Map();
      (Array.isArray(kline) ? kline : []).forEach(it => {
        if (it && it.trade_date != null) m.set(String(it.trade_date), it);
      });
      return m;
    } catch (e) {
      console.error(`  获取 ${code} 日K失败: ${e.message}`);
      return new Map();
    }
  };
  console.log('拉取个股历史日K（160 天）...');
  const klineMaps = await batchParallel(codes, fetchKline, 5);
  const okStocks = klineMaps.filter(m => m.size > 0).length;
  console.log(`个股日K获取成功 ${okStocks}/${codes.length} 只`);

  // 指数 K 线 250 天
  const fetchIndex = async (code) => {
    try {
      const { data: { data: kline } } = await axios.get(getClsReqIndexUrl(code, 250));
      const m = new Map();
      (Array.isArray(kline) ? kline : []).forEach(it => {
        if (it && it.trade_date != null) m.set(String(it.trade_date), it);
      });
      return m;
    } catch (e) {
      console.error(`  获取指数 ${code} K线失败: ${e.message}`);
      return new Map();
    }
  };
  const [cybMap, kcbMap] = await Promise.all([fetchIndex(CYB), fetchIndex(KCB)]);
  console.log(`指数K线: 创业板指 ${cybMap.size} 天、科创50 ${kcbMap.size} 天`);

  const arr = readJson(TECH_INDEX_FILE, []);
  let changed = 0, skipped = 0;
  const report = [];
  for (const item of arr) {
    const dateStr = String(item.date);
    const items = [];
    codes.forEach((code, i) => {
      const k = klineMaps[i] && klineMaps[i].get(dateStr);
      if (k && k.change != null && !isNaN(k.change) && k.close_px > 0) {
        items.push({ code, change: Number(k.change), price: Number(k.close_px) });
      }
    });
    const cybK = cybMap.get(dateStr);
    const kcbK = kcbMap.get(dateStr);
    if (items.length === 0 || !cybK || !kcbK) {
      skipped++;
      report.push({ date: dateStr, skipped: true, stocks: items.length, indexOk: !!(cybK && kcbK), v1: item.changeSumResult });
      continue; // 数据缺失的日期保留原值不覆盖
    }
    const baseEmotion = computeTechEmotionV2Base(items);
    const avgChange = computeTechAvgChangeV2(items);
    // 指数冲高回落惩罚：与实时路径同口径——两指数回落幅度平均后 tanh 映射
    const pbs = [];
    [cybK, kcbK].forEach(k => {
      if (k && k.preclose_px > 0 && k.high_px != null && k.close_px != null) {
        pbs.push(parseFloat(((k.close_px - k.high_px) / k.preclose_px * 100).toFixed(2)));
      }
    });
    const avgPb = pbs.length > 0 ? pbs.reduce((a, b) => a + b, 0) / pbs.length : 0;
    const penalty = computePullbackPenaltyFromPullback(avgPb);
    const finalEmotion = computeTechEmotionV2(baseEmotion, penalty);

    const v1 = item.changeSumResult;
    if (v1 !== undefined && item.v1ChangeSumResult === undefined) item.v1ChangeSumResult = v1;
    item.changeSumResult = finalEmotion;
    item.baseEmotion = baseEmotion;
    item.pullbackPenalty = penalty;
    item.avgChange = avgChange;
    item.stockCount = items.length;
    item.algorithm = 2;
    changed++;
    report.push({ date: dateStr, v1, v2: finalEmotion, base: baseEmotion, penalty, avgChange, stocks: items.length });
  }
  fs.writeFileSync(TECH_INDEX_FILE, JSON.stringify(arr, null, 2));
  console.log(`日级回溯完成：重算 ${changed} 条、跳过 ${skipped} 条（数据缺失保留原值）`);
  console.log('对比样例（前5 / 后5）:');
  const valid = report.filter(r => !r.skipped);
  valid.slice(0, 5).concat(valid.slice(-5)).forEach(r => {
    console.log(`  ${r.date}: V1 ${r.v1} → V2 ${r.v2}（base ${r.base} + penalty ${r.penalty}×0.2, 加权涨幅 ${r.avgChange}%, ${r.stocks}只）`);
  });
  report.filter(r => r.skipped).slice(0, 10).forEach(r => {
    console.log(`  [跳过] ${r.date}: 个股${r.stocks}只 指数${r.indexOk ? 'ok' : '缺失'}，保留 V1 值 ${r.v1}`);
  });
};

// ============ 2. 分时回溯（intraday + 5day，保留原 time 时间轴） ============
const backfillIntraday = async () => {
  console.log('========== [intraday] 分时情绪历史回溯 ==========');
  backupFile(INTRADAY_FILE);
  backupFile(INTRADAY_5DAY_FILE);
  const codes = techCodes();
  const i1 = readJson(INTRADAY_FILE, {});
  const i5 = readJson(INTRADAY_5DAY_FILE, {});
  const dates = Array.from(new Set([...Object.keys(i1), ...Object.keys(i5)])).sort();
  console.log(`待回溯日期: ${dates.join(', ')}（科技股池 ${codes.length} 只）`);

  for (const dateStr of dates) {
    // 个股分时（历史日优先命中本地缓存，今日收盘后实拉）
    const stockLines = await batchParallel(codes, async (code) => {
      try {
        const r = await getSingleStockTlineDataByDate(code, Number(dateStr));
        return r && Array.isArray(r.line) && r.line.length > 0 ? r.line : null;
      } catch { return null; }
    }, 5);
    const haveLines = stockLines.filter(Boolean).length;
    const [cybT, kcbT] = await Promise.all([
      getSingleStockTlineDataByDate(CYB, Number(dateStr)).catch(() => null),
      getSingleStockTlineDataByDate(KCB, Number(dateStr)).catch(() => null),
    ]);
    const cybLine = cybT?.line || [];
    const kcbLine = kcbT?.line || [];
    if (haveLines === 0) {
      console.log(`  ${dateStr}: 无个股分时数据（超出5天分时窗口），跳过保留原值`);
      continue;
    }
    console.log(`  ${dateStr}: 个股分时 ${haveLines}/${codes.length} 只、指数 ${cybLine.length}/${kcbLine.length} 点`);

    // 指数「截至 t 的最高涨幅回落」预计算：分时全量数据的 max 前缀
    const indexPullbackAt = (line, t) => {
      if (!line || line.length === 0) return null;
      let maxC = null, cur = null;
      for (const p of line) {
        if (Number(p.minute) <= t) {
          if (maxC === null || p.change > maxC) maxC = p.change;
          cur = p.change;
        } else break;
      }
      return maxC !== null && cur !== null ? cur - maxC : null;
    };

    const recalcPoint = (tStr) => {
      const t = Number(tStr);
      const items = [];
      codes.forEach((code, i) => {
        const line = stockLines[i];
        if (!line) return;
        const p = findPointAt(line, t);
        if (p && p.change != null && !isNaN(p.change)) {
          items.push({ code, change: Number(p.change), price: p.last_px > 0 ? Number(p.last_px) : null });
        }
      });
      const base = computeTechEmotionV2Base(items);
      const pbs = [];
      const pb1 = indexPullbackAt(cybLine, t);
      const pb2 = indexPullbackAt(kcbLine, t);
      if (pb1 !== null) pbs.push(pb1);
      if (pb2 !== null) pbs.push(pb2);
      const avgPb = pbs.length > 0 ? pbs.reduce((a, b) => a + b, 0) / pbs.length : 0;
      const penalty = computePullbackPenaltyFromPullback(avgPb);
      return computeTechEmotionV2(base, penalty);
    };

    if (i1[dateStr]) {
      const before = i1[dateStr];
      i1[dateStr] = before.map(r => ({ time: r.time, value: recalcPoint(r.time) }));
      const first = before.find(r => r.value !== null);
      const last = before[before.length - 1];
      console.log(`    intraday ${before.length} 点重算（旧首 ${first ? first.value : '-'}→${i1[dateStr][0].value}，旧末 ${last ? last.value : '-'}→${i1[dateStr][i1[dateStr].length - 1].value}）`);
    }
    if (i5[dateStr]) {
      const before = i5[dateStr];
      i5[dateStr] = before.map(r => ({ time: r.time, value: recalcPoint(r.time) }));
      console.log(`    5day ${before.length} 点重算完成`);
    }
  }
  fs.writeFileSync(INTRADAY_FILE, JSON.stringify(i1, null, 2));
  fs.writeFileSync(INTRADAY_5DAY_FILE, JSON.stringify(i5, null, 2));
  console.log('分时回溯完成');
};

// ============ 3. camp 缓存原地重算（timeBuckets[].techEmotion + prevDay*） ============
const backfillCamp = () => {
  console.log('========== [camp] 训练营回放缓存原地重算 ==========');
  // 备份目录（157MB 左右，一次性）
  const bakDir = path.join(DATA_DIR, 'backtest_camp_cache_v1_backup');
  if (!fs.existsSync(bakDir)) {
    console.log(`备份 camp 缓存目录 → ${bakDir}`);
    fs.mkdirSync(bakDir, { recursive: true });
    fs.readdirSync(CAMP_DIR).forEach(f => fs.copyFileSync(path.join(CAMP_DIR, f), path.join(bakDir, f)));
  }

  // 回溯后的 tech_index.json（V2），供 prevDay* 重算（逻辑与 strategyBacktest.js 完全一致）
  const techIndexArr = readJson(TECH_INDEX_FILE, []);
  const sortedDesc = [...techIndexArr]
    .filter(d => d && d.date && String(d.date).length === 8)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // 科技股过滤：当前自选股中 isTech === false 的才排除（缓存中已删除的历史股票保守计入，与 V1 参与口径一致）
  const nonTechSet = new Set(getMonitorStocks().filter(s => s.isTech === false).map(s => s.code));

  const files = fs.readdirSync(CAMP_DIR).filter(f => f.endsWith('.json'));
  console.log(`camp 缓存文件 ${files.length} 个`);
  let ok = 0, fail = 0, bucketsTotal = 0;
  for (const f of files) {
    const fp = path.join(CAMP_DIR, f);
    let c;
    try { c = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { fail++; continue; }
    if (!c || !c.data || !Array.isArray(c.data.timeBuckets)) { fail++; continue; }
    const data = c.data;

    // prevDay 重算（依赖回溯后的 tech_index.json，阈值 -30 暂保留原口径，校准问题另行汇报）
    const targetDateNum = parseInt(data.date || f.replace(/\.nomfund\.json$/, '').replace(/\.json$/, ''));
    let prevDayTechEmotion = null;
    let prevDayIsIcePoint = false;
    let prevDayHasIce = false;
    for (const it of sortedDesc) {
      if (parseInt(it.date) < targetDateNum) {
        prevDayTechEmotion = parseFloat(it.changeSumResult);
        if (!isNaN(prevDayTechEmotion) && prevDayTechEmotion < -30) prevDayIsIcePoint = true;
        prevDayHasIce = it.hasIce === true;
        break;
      }
    }
    data.prevDayTechEmotion = prevDayTechEmotion !== null && !isNaN(prevDayTechEmotion) ? prevDayTechEmotion : null;
    data.prevDayIsIcePoint = prevDayIsIcePoint;
    data.prevDayHasIce = prevDayHasIce;
    // todayHasIce 保留原值（tech_index.json 的 hasIce 历史标记未重算，口径一致）

    // timeBuckets 逐桶 V2 重算（与 trainingCamp.js V2 构建逻辑同口径：桶序累计指数 max + 科技股池过滤）
    let cybMax = null, kcbMax = null;
    for (const bucket of data.timeBuckets) {
      const cybC = bucket.indexTline && bucket.indexTline.cyb ? bucket.indexTline.cyb.changePct : null;
      const kcbC = bucket.indexTline && bucket.indexTline.kcb ? bucket.indexTline.kcb.changePct : null;
      if (cybC != null && (cybMax === null || cybC > cybMax)) cybMax = cybC;
      if (kcbC != null && (kcbMax === null || kcbC > kcbMax)) kcbMax = kcbC;

      const items = (bucket.stockChanges || [])
        .filter(s => s && s.code && s.changePct != null && !isNaN(s.changePct) && !nonTechSet.has(s.code))
        .map(s => ({ code: s.code, change: Number(s.changePct), price: s.lastPx > 0 ? Number(s.lastPx) : null }));
      const base = computeTechEmotionV2Base(items);
      const pbs = [];
      if (cybC != null && cybMax !== null) pbs.push(cybC - cybMax);
      if (kcbC != null && kcbMax !== null) pbs.push(kcbC - kcbMax);
      const avgPb = pbs.length > 0 ? pbs.reduce((a, b) => a + b, 0) / pbs.length : 0;
      const penalty = computePullbackPenaltyFromPullback(avgPb);
      bucket.techEmotion = computeTechEmotionV2(base, penalty);
      bucketsTotal++;
    }
    atomicWrite(fp, JSON.stringify(c));
    ok++;
  }
  console.log(`camp 重算完成：${ok} 个文件 / ${bucketsTotal} 个桶（失败/跳过 ${fail}）`);
};

// ============ 入口 ============
(async () => {
  const step = process.argv[2] || 'all';
  const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
  log(`回溯开始（step=${step}）`);
  if (step === 'day' || step === 'all') await backfillDaily();
  if (step === 'intraday' || step === 'all') await backfillIntraday();
  if (step === 'camp' || step === 'all') backfillCamp();
  log('回溯结束');
  process.exit(0);
})().catch(e => {
  console.error('回溯失败:', e);
  process.exit(1);
});
