#!/usr/bin/env node
/**
 * 重刷 tech_index.json 的 hasIce 冰点标记（全部历史日期）
 *
 * 新标准：当日「5 分钟分时桶」中任一时点的科技情绪 <= -39（ICE_THRESHOLD）即为命中冰点，
 * 不再依据当天收盘定型值判断。
 *
 * 数据源优先级（逐日）：
 *   ① data/backtest_camp_cache/{date}.json 的 timeBuckets[].techEmotion —— 该日 5 分钟桶情绪序列
 *      （与实时路径 / trainingCamp 回放同口径，V2；已覆盖 20260601~20261016）
 *   ② data/tech_index_intraday.json 当日实时记录点（粒度细于 5 分钟；覆盖当日 20261019）
 *   ③ 以上均无（如 2026 年 5 月历史日）：调用 tech-emotion-5min.js 的 computeDayBuckets 现算（走 HTTP 拉分时）
 *   ④ 全部不可得（如周末误写条目）：保持原值不动
 *
 * 用法：node script/refresh-tech-index-ice.js [--dry]
 *   --dry 仅输出差异报告，不写回文件
 */
const fs = require('fs');
const path = require('path');
const { computeDayBuckets } = require('./tech-emotion-5min');

const DATA_DIR = path.resolve(__dirname, '../src/data');
const TECH_INDEX_FILE = path.join(DATA_DIR, 'tech_index.json');
const CAMP_DIR = path.join(DATA_DIR, 'backtest_camp_cache');
const INTRADAY_FILE = path.join(DATA_DIR, 'tech_index_intraday.json');
const ICE_THRESHOLD = -39;

const DRY = process.argv.includes('--dry');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
};

const fmt = (n) => (n === null || n === undefined ? '--' : (n > 0 ? '+' : '') + Number(n).toFixed(2));

(async () => {
  const records = readJson(TECH_INDEX_FILE, null);
  if (!Array.isArray(records)) {
    console.error(`无法读取 ${TECH_INDEX_FILE}`);
    process.exit(1);
  }
  const intradayAll = readJson(INTRADAY_FILE, {});

  console.log(`[重刷 hasIce] 共 ${records.length} 个日期，阈值 <= ${ICE_THRESHOLD}${DRY ? '（dry-run 不写回）' : ''}\n`);

  const results = [];
  for (const rec of records) {
    const dateStr = String(rec.date);
    const oldIce = rec.hasIce === true;
    let source = null;
    let values = [];

    const campFile = path.join(CAMP_DIR, `${dateStr}.json`);
    const campFallbackFile = path.join(CAMP_DIR, `${dateStr}.nomfund.json`);
    const campContent = fs.existsSync(campFile) ? readJson(campFile, null) : readJson(campFallbackFile, null);
    const campBuckets = campContent?.data?.timeBuckets;

    if (Array.isArray(campBuckets) && campBuckets.length > 0) {
      source = 'camp-cache';
      values = campBuckets.map(b => b.techEmotion).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    } else if (Array.isArray(intradayAll[dateStr]) && intradayAll[dateStr].length > 0) {
      source = 'intraday';
      values = intradayAll[dateStr].map(r => r.value).filter(v => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
    } else {
      // 无缓存的历史日：现算（会走 HTTP 拉分时；失败则保持原值）
      try {
        const { buckets, stockCount, indexOk } = await computeDayBuckets(dateStr);
        const vals = buckets.map(b => b.value).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
        // 拉不到个股/指数分时（如周末误写条目）视为无数据，保持原值
        if (vals.length > 0 && stockCount > 0 && indexOk) { source = 'computed'; values = vals; }
      } catch (e) {
        console.error(`  ! ${dateStr} 现算失败：${e.message}`);
      }
    }

    if (values.length === 0) {
      results.push({ dateStr, oldIce, newIce: oldIce, min: null, source: 'none(保持原值)' });
      continue;
    }

    const min = Math.min(...values);
    const newIce = min <= ICE_THRESHOLD;
    results.push({ dateStr, oldIce, newIce, min, source, bucketCount: values.length });
  }

  // 明细
  results.forEach(r => {
    const flag = r.oldIce === r.newIce ? '   ' : (r.newIce ? ' + ' : ' - ');
    console.log(`${flag}${r.dateStr}  最低分时 ${String(fmt(r.min)).padStart(7)}  冰点 ${String(r.oldIce).padEnd(5)}→ ${String(r.newIce).padEnd(5)}  [${r.source}${r.bucketCount ? ',' + r.bucketCount + '点' : ''}]`);
  });

  const added = results.filter(r => !r.oldIce && r.newIce).map(r => r.dateStr);
  const removed = results.filter(r => r.oldIce && !r.newIce).map(r => r.dateStr);
  const kept = results.filter(r => r.oldIce && r.newIce).map(r => r.dateStr);
  const skipped = results.filter(r => r.source === 'none(保持原值)').map(r => r.dateStr);

  console.log(`\n===== 差异汇总 =====`);
  console.log(`冰点日期：${kept.length + added.length} 天（原 ${kept.length + removed.length} 天）`);
  console.log(`新增冰点（${added.length}）：${added.length ? added.join(', ') : '无'}`);
  console.log(`移除冰点（${removed.length}）：${removed.length ? removed.join(', ') : '无'}`);
  console.log(`保持冰点（${kept.length}）：${kept.join(', ')}`);
  console.log(`无数据未处理（${skipped.length}）：${skipped.length ? skipped.join(', ') : '无'}`);

  if (DRY) {
    console.log('\n[--dry] 未写回 tech_index.json');
    return;
  }

  // 备份 + 写回（仅在命中时写 hasIce: true；未命中则移除该字段）
  const backupFile = path.join(DATA_DIR, `tech_index.json.bak_ice_${Date.now()}`);
  fs.copyFileSync(TECH_INDEX_FILE, backupFile);
  const byDate = new Map(results.map(r => [r.dateStr, r]));
  const next = records.map(rec => {
    const r = byDate.get(String(rec.date));
    const out = { ...rec };
    if (r && r.source !== 'none(保持原值)') {
      if (r.newIce) out.hasIce = true;
      else delete out.hasIce;
    }
    return out;
  });
  fs.writeFileSync(TECH_INDEX_FILE, JSON.stringify(next, null, 2));
  console.log(`\n已写回 ${TECH_INDEX_FILE}（备份：${path.basename(backupFile)}）`);
})().catch(e => {
  console.error('重刷失败：', e);
  process.exit(1);
});
