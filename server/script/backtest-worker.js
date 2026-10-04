// 训练营 - 买卖点回测并行 worker
// 用途：直接 node script/backtest-worker.js 即自动清空回测缓存 → 预热日K线文件缓存 → 并行预构建各日期回放数据缓存
//       （data/backtest_camp_cache，只构建一次全进程共享，策略阶段只读文件）→ fork 8 个子进程并行回测常规策略
//       → 对三日情绪冰点日期范围补一轮兜底预构建（无资金快照日期落盘 .nomfund.json，构建失败写当日负缓存标记，
//       避免每次回测各策略进程重复全量 HTTP 重建）→ 以 3 进程（每进程 2 策略共享数据加载）回测三日情绪冰点策略
//       → 自动汇总生成回测报告。
// 分组规则：按进程数尽量平均分配（大组在前），如 20 个策略 8 进程 → 3/3/3/3/2/2/2/2。
// 用法：
//   node script/backtest-worker.js                 默认：清空缓存 → 预热K线 → 8 进程强制并行跑全部策略 → 自动汇总生成回测报告（实时进度看板）
//   node script/backtest-worker.js --list          查看分组与日期范围
//   node script/backtest-worker.js --aggregate     仅按当前缓存汇总生成回测报告（不清缓存、不回测）
//   node script/backtest-worker.js --trend         策略趋势诊断：三档时间范围（默认60/30/15个交易日）依次补测缺失缓存的全部策略（不清缓存）
//   node script/backtest-worker.js --monthly       历史曲线：把可用回放交易日按自然月拆分，逐月补测全部策略缺失缓存（不清缓存；服务端汇总月度收益画曲线）
//   node script/backtest-worker.js --workers 3     指定并行进程数（默认 8）
// 可选参数：
//   --start YYYYMMDD --end YYYYMMDD   指定日期范围（常规策略默认最近 60 个交易日）
//   --strategies id1,id2              单进程串行强制重跑指定策略（分类回测用；不清空其它缓存、不生成汇总报告）
//   --prebuild                        与 --strategies 连用：先预热日K线 + 预构建回放数据再回测
//   --group N                         单进程串行强制重跑第 N 组（调试用，兼容旧的分终端模式，组只含常规策略）
//   --run-missing                     汇总时对缺失缓存的策略现场串行回测补齐（默认仅汇总已有缓存）
//   --build-dates d1,d2,...           内部参数：预构建子进程，逐日构建回放数据并落盘，请勿手动使用
//   --allow-missing-fund              内部参数：与 --build-dates 连用，对无资金快照日期构建兜底缓存（三日情绪冰点策略专用），请勿手动使用
//   --child --strategies ...          内部参数：由父进程 fork 调用，进度经 IPC 上报，请勿手动使用
const fs = require('fs');
const path = require('path');
const { STRATEGIES, runRangeBacktestMulti, writeCachedBacktest, readCachedBacktest, isEmo3AvgStrategy, getEmo3DefaultRange, getTechIndexDates } = require('../src/service/buySellBacktest');
const { loadTrainingCampData, getTrainingCampDates, beijingToday, prewarmKlineCache } = require('../src/service/trainingCamp');
const { generateReport, getDefaultReportRange, getTrendDiagnosisRanges } = require('../src/service/backtestReport');
const { fork } = require('child_process');

// 解析命令行参数
const parseArgs = (argv) => {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--aggregate') args.aggregate = true;
    else if (a === '--trend') args.trend = true;
    else if (a === '--monthly') args.monthly = true;
    else if (a === '--run-missing') args.runMissing = true;
    else if (a === '--build-dates') args.buildDates = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--allow-missing-fund') args.allowMissingFund = true;
    else if (a === '--child') args.child = true;
    else if (a === '--group') args.group = Number(argv[++i]);
    else if (a === '--workers') args.workers = Number(argv[++i]);
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--strategies') args.strategies = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--prebuild') args.prebuild = true;
  }
  return args;
};

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// 把 ids 尽量平均分成 workerCount 组（大组在前）：
// 22 个 / 5 进程 → base=4, rem=2 → 5/5/4/4/4；27 个 → base=5, rem=2 → 6/6/5/5/5
const buildGroups = (ids, workerCount) => {
  const base = Math.floor(ids.length / workerCount);
  const rem = ids.length % workerCount;
  const groups = [];
  let idx = 0;
  for (let i = 0; i < workerCount; i++) {
    const size = base + (i < rem ? 1 : 0);
    if (size <= 0) break;
    groups.push(ids.slice(idx, idx + size));
    idx += size;
  }
  return groups;
};

// 清空回测结果缓存目录（backtest_*.json），强制全量重跑前调用；返回删除的文件数
const clearBacktestCache = () => {
  const dir = path.join(__dirname, '../src/data/backtest_results');
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^backtest_.*\.json$/.test(f)) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    } catch (e) {
      console.error(`[${ts()}] 删除缓存文件失败 ${f}: ${e.message}`);
    }
  }
  return removed;
};

// 串行执行一组策略：外层日期、内层策略，同一天的回放数据只加载一次依次喂给本组全部策略，
// 省去每个策略重复加载同份数据的开销（约占总耗时一半）；完成后逐策略写入缓存
const runStrategies = async (strategyIds, startDate, endDate, { report }) => {
  const results = [];
  const sharedName = strategyIds.length > 1
    ? `共享加载(${strategyIds.length}策略)`
    : (STRATEGIES[strategyIds[0]]?.name || '');
  report({ type: 'strategy-start', strategyId: strategyIds[0], name: sharedName });
  const rs = await runRangeBacktestMulti(startDate, endDate, strategyIds, (p) => {
    report({ type: 'progress', strategyId: strategyIds[0], name: sharedName, date: p.date, current: p.current, total: p.total, status: p.status });
  });
  for (const r of rs) {
    const name = STRATEGIES[r.strategyId]?.name || r.strategyId;
    if (!r.result?.success) {
      report({ type: 'strategy-fail', strategyId: r.strategyId, name, message: r.result?.message || '未知错误' });
      results.push({ strategyId: r.strategyId, name, status: 'failed', message: r.result?.message });
      continue;
    }
    writeCachedBacktest(r.strategyId, startDate, endDate, r.result);
    report({ type: 'strategy-done', strategyId: r.strategyId, name, summary: r.result.summary || {} });
    results.push({ strategyId: r.strategyId, name, status: 'done', summary: r.result.summary || {} });
  }
  report({ type: 'worker-done' });
  return results;
};

// 汇总 20 个策略的缓存结果生成回测报告
const aggregate = async (startDate, endDate, runMissing) => {
  console.log(`[${ts()}] 汇总生成回测报告（${startDate} ~ ${endDate}）${runMissing ? '，缺失缓存将现场补测' : '，仅汇总已有缓存'}`);
  const r = await generateReport({
    startDate, endDate,
    fromCacheOnly: !runMissing,
    onProgress: (p) => {
      if (p.status) process.stdout.write(`\r[${ts()}] (${p.current}/${p.total}) ${p.strategy} ${p.status}   `);
    },
  });
  process.stdout.write('\n');
  if (!r.success) {
    console.error(`[${ts()}] 报告生成失败: ${r.message}`);
    process.exitCode = 1;
    return;
  }
  const report = r.report;
  console.log(`\n[${ts()}] 报告已生成: ${report.id}（已保存，页面「最新报告」可直接查看）`);
  console.log(`日期范围: ${report.range.startDate} ~ ${report.range.endDate}，策略数: ${report.strategyCount}`);
  if ((report.skipped || []).length > 0) {
    console.log('跳过/缺失:');
    report.skipped.forEach(s => console.log(`  - ${s.strategy}: ${s.message}`));
  }
  console.log('\n排名（按整体收益从高到低）:');
  for (const s of report.strategies) {
    const sum = s.summary || {};
    console.log(
      `  #${String(s.rank).padStart(2, '0')} ${s.name.padEnd(12)} ` +
      `收益 ${sum.overallReturn != null ? sum.overallReturn + '%' : '-'} | ` +
      `胜率 ${sum.winRate != null ? sum.winRate + '%' : '-'} | ` +
      `交易 ${sum.tradeCount} 笔` +
      (sum.holding ? ' | 当前持仓中' : '')
    );
  }
};

// ===== 子进程模式：跑指定策略，进度经 IPC 上报给父进程 =====
const runAsChild = async (strategyIds, startDate, endDate) => {
  const report = (m) => { if (process.send) process.send(m); };
  try {
    const results = await runStrategies(strategyIds, startDate, endDate, { report });
    const failed = results.filter(r => r.status === 'failed');
    process.exitCode = failed.length > 0 ? 1 : 0;
  } catch (err) {
    report({ type: 'worker-crash', message: err.message || String(err) });
    process.exit(1);
  }
};

// ===== 预构建子进程：逐日构建回放数据（过去交易日结果自动落盘共享），进度经 IPC 上报 =====
// allowMissingFund=true 时对无资金快照日期构建兜底缓存（.nomfund.json，三日情绪冰点策略专用）
const runAsBuildChild = async (dates, allowMissingFund) => {
  const report = (m) => { if (process.send) process.send(m); };
  let done = 0;
  for (const d of dates) {
    try {
      const r = await loadTrainingCampData(d, { allowMissingFund: allowMissingFund === true });
      if (r && r.success === false) {
        report({ type: 'build-done', date: d, ok: false, done: ++done, total: dates.length, message: r.message || '构建失败' });
      } else {
        report({ type: 'build-done', date: d, ok: true, done: ++done, total: dates.length });
      }
    } catch (e) {
      report({ type: 'build-done', date: d, ok: false, done: ++done, total: dates.length, message: e.message || String(e) });
    }
  }
  report({ type: 'worker-done' });
};

// ===== 单进程串行模式（--group / --strategies，调试或兼容旧的分终端用法） =====
const runStandalone = async (strategyIds, startDate, endDate) => {
  console.log(`[${ts()}] 本进程共 ${strategyIds.length} 个任务: ${strategyIds.map(id => STRATEGIES[id].name).join(' / ')}`);
  let lastKey = '';
  const results = await runStrategies(strategyIds, startDate, endDate, {
    report: (m) => {
      if (m.type === 'progress') {
        const key = `${m.strategyId}:${m.date}`;
        if (key !== lastKey) {
          lastKey = key;
          process.stdout.write(`\r[${ts()}] [${m.name}] (${m.current}/${m.total}) ${m.date} ${m.status === 'loading' ? '加载回放数据' : '跑买卖点'}   `);
        }
      } else if (m.type === 'strategy-start') {
        lastKey = '';
      } else if (m.type === 'strategy-done') {
        process.stdout.write('\n');
        const s = m.summary;
        console.log(`[${ts()}] [${m.name}] 完成: 交易 ${s.tradeCount} 笔, 胜率 ${s.winRate ?? '-'}%, 整体收益 ${s.overallReturn ?? '-'}%（已写入缓存）`);
      } else if (m.type === 'strategy-fail') {
        process.stdout.write('\n');
        console.log(`[${ts()}] [${m.name}] 回测失败: ${m.message}`);
      }
    },
  });
  const failed = results.filter(r => r.status === 'failed');
  console.log(`\n[${ts()}] 本进程完成: 成功 ${results.filter(r => r.status === 'done').length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    failed.forEach(f => console.error(`  失败: ${f.name}: ${f.message}`));
    process.exitCode = 1;
  }
};

// ===== 预构建阶段：按日期切片并行构建回放数据缓存（策略线程随后只读文件，跳过重建与 HTTP 拉取） =====
// opts.allowMissingFund=true：对无资金快照日期构建兜底缓存（.nomfund.json），供三日情绪冰点策略阶段命中文件
const runPrebuild = (dates, workerCount, opts = {}) => new Promise((resolve) => {
  if (!dates || dates.length === 0) { resolve(0); return; }
  const noFund = opts.allowMissingFund === true;
  const slices = buildGroups(dates, Math.max(1, Math.min(workerCount, dates.length)));
  const children = [];
  let done = 0;
  let failed = 0;
  let remaining = slices.length;
  console.log(`[${ts()}] 预构建${noFund ? '（含无资金快照兜底缓存）' : ''}回放数据缓存: ${dates.length} 个交易日 → ${slices.length} 进程（${slices.map(g => g.length).join(' / ')}）`);
  const onSigint = () => {
    children.forEach((c) => { try { c.kill('SIGTERM'); } catch (e) { /* 忽略 */ } });
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  slices.forEach((slice) => {
    const child = fork(__filename, ['--build-dates', slice.join(','), ...(noFund ? ['--allow-missing-fund'] : [])], { silent: true });
    children.push(child);
    let errBuf = '';
    child.on('message', (m) => {
      if (m && m.type === 'build-done') {
        done += 1;
        if (!m.ok) {
          failed += 1;
          console.log(`\n[${ts()}] 预构建失败 ${m.date}: ${m.message || '未知错误'}`);
        }
        process.stdout.write(`\r[${ts()}] 预构建回放数据缓存 ${done}/${dates.length}   `);
      }
    });
    if (child.stderr) child.stderr.on('data', (d) => { errBuf += String(d); if (errBuf.length > 2000) errBuf = errBuf.slice(-2000); });
    child.on('exit', (code) => {
      if (code !== 0 && errBuf.trim()) console.error(`\n预构建子进程异常退出(code=${code}):\n${errBuf.trim()}`);
      remaining -= 1;
      if (remaining === 0) {
        process.stdout.write('\n');
        console.log(`[${ts()}] 预构建完成: 成功 ${done - failed}/${dates.length}${failed > 0 ? `，失败 ${failed}（对应日期将由策略线程现场构建）` : ''}\n`);
        process.removeListener('SIGINT', onSigint);
        resolve(failed);
      }
    });
  });
});

// ===== 策略趋势诊断模式（--trend）：按三档固定范围（默认60/30/15个交易日）依次回测全部策略 =====
// 不清空缓存：已有「策略+精确范围」缓存的策略直接跳过，只补测缺失的；回放数据预构建跨范围共享。
// 范围口径由 getTrendDiagnosisRanges 统一提供，服务端在 worker 结束后据此从缓存汇总三份报告
const runTrend = async (workerCount) => {
  const ranges = getTrendDiagnosisRanges();
  if (ranges.length === 0) throw new Error('无可用回放交易日，无法确定策略趋势诊断日期范围');
  const allIds = Object.keys(STRATEGIES);
  // 预热日K线文件缓存（跨进程共享，多范围回测共用一份）
  try {
    const t0 = Date.now();
    const warmed = await prewarmKlineCache();
    console.log(`日K线文件缓存预热完成: ${warmed.total - warmed.fetched} 命中 / ${warmed.fetched} 新拉取（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } catch (e) {
    console.error(`日K线预热失败（不影响后续流程，子进程将自行拉取）: ${e.message}`);
  }
  for (const r of ranges) {
    const missing = allIds.filter(id => !readCachedBacktest(id, r.startDate, r.endDate));
    console.log(`\n[${ts()}] 策略趋势诊断【${r.label}】${r.startDate} ~ ${r.endDate}（最近 ${r.days} 个交易日）：策略 ${allIds.length} 个，缺失缓存 ${missing.length} 个`);
    if (missing.length === 0) {
      console.log(`[${ts()}] 该范围全部策略已有缓存，跳过回测`);
      continue;
    }
    // 常规/三日情绪冰点策略依赖回放数据缓存，先预构建
    const needReplay = missing.length > 0;
    if (needReplay) {
      const buildDates = getTrainingCampDates().filter(d => d >= r.startDate && d <= r.endDate && d < beijingToday()).sort();
      await runPrebuild(buildDates, workerCount);
      // 缺失策略含三日情绪冰点时，对其固定范围（2026-07-01 起，含缺资金快照日期）补一轮兜底预构建；
      // 已构建过的日期读文件秒过，仅首次会现场构建并落盘 .nomfund.json
      if (missing.some(id => isEmo3AvgStrategy(id))) {
        let e3r = null;
        try { e3r = getEmo3DefaultRange(); } catch (e) { e3r = null; }
        if (e3r) {
          const e3Dates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
            .filter(d => d >= e3r.startDate && d <= e3r.endDate && d < beijingToday()).sort();
          await runPrebuild(e3Dates, workerCount, { allowMissingFund: true });
        }
      }
    }
    const exitCode = await runParallel(buildGroups(missing, workerCount), r.startDate, r.endDate);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
  console.log(`\n[${ts()}] 策略趋势诊断三档范围回测全部完成`);
};

// ===== 自然月回测模式（--monthly）：把可用回放交易日按自然月拆分，逐月补测全部策略的缺失缓存 =====
// 服务端「历史曲线」依赖「月 × 策略」粒度的回测缓存（月度整体收益 → 跨月累乘绘制策略累计曲线）
const buildMonthRanges = () => {
  const dates = [...getTrainingCampDates()].filter(d => d < beijingToday()).sort();
  const map = new Map(); // 'YYYYMM' -> { key, label, startDate, endDate, days }
  for (const d of dates) {
    const key = d.substring(0, 6);
    const entry = map.get(key) || {
      key,
      label: `${d.substring(0, 4)}-${d.substring(4, 6)}`,
      startDate: d,
      endDate: d,
      days: 0,
    };
    entry.endDate = d;
    entry.days += 1;
    map.set(key, entry);
  }
  return Array.from(map.values());
};

const runMonthlyTrend = async (workerCount) => {
  const months = buildMonthRanges();
  if (months.length === 0) throw new Error('无可用回放交易日，无法按自然月回测');
  const allIds = Object.keys(STRATEGIES);
  console.log(`自然月回测：${months.length} 个月（${months.map(m => `${m.label} ${m.days}日`).join('，')}），策略 ${allIds.length} 个`);
  // 预热日K线文件缓存（跨进程共享，多个月份共用一份）
  try {
    const t0 = Date.now();
    const warmed = await prewarmKlineCache();
    console.log(`日K线文件缓存预热完成: ${warmed.total - warmed.fetched} 命中 / ${warmed.fetched} 新拉取（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } catch (e) {
    console.error(`日K线预热失败（不影响后续流程，子进程将自行拉取）: ${e.message}`);
  }
  // 预构建全部月度日期的回放数据缓存（已构建过的日期读缓存秒过；月度日期均早于今日且含资金快照）
  await runPrebuild(months.flatMap(m => [...getTrainingCampDates()].filter(d => d >= m.startDate && d <= m.endDate).sort()), workerCount);
  // 逐月补测缺失缓存：单进程串行，月内日期数据只加载一次喂给整组缺失策略
  for (const m of months) {
    const missing = allIds.filter(id => !readCachedBacktest(id, m.startDate, m.endDate));
    console.log(`\n[${ts()}] 【${m.label}】${m.startDate} ~ ${m.endDate}（${m.days} 个交易日）：策略 ${allIds.length} 个，缺失缓存 ${missing.length} 个`);
    if (missing.length === 0) {
      console.log(`[${ts()}] 该月全部策略已有缓存，跳过回测`);
      continue;
    }
    await runStrategies(missing, m.startDate, m.endDate, {
      report: (msg) => {
        if (msg.type === 'progress') {
          const phase = msg.status === 'loading' ? '加载回放数据' : '跑买卖点';
          process.stdout.write(`\r[${ts()}] [${msg.name}] (${msg.current}/${msg.total}) ${msg.date} ${phase}   `);
        } else if (msg.type === 'strategy-start') {
          process.stdout.write('\n');
        } else if (msg.type === 'strategy-done') {
          process.stdout.write('\n');
          const s = msg.summary;
          console.log(`[${ts()}] [${msg.name}] 完成: 交易 ${s.tradeCount} 笔, 胜率 ${s.winRate ?? '-'}%, 整体收益 ${s.overallReturn ?? '-'}%（已写入缓存）`);
        } else if (msg.type === 'strategy-fail') {
          process.stdout.write('\n');
          console.log(`[${ts()}] [${msg.name}] 回测失败: ${msg.message}`);
        }
      },
    });
  }
  console.log(`\n[${ts()}] 自然月回测全部完成`);
};

// ===== 并行模式：fork 多个子进程，终端实时看板展示各线程进度 =====
const runParallel = (groups, startDate, endDate) => new Promise((resolve) => {
  const workerFile = __filename;
  const totalStrategies = groups.reduce((n, g) => n + g.length, 0);
  const useLive = !!process.stdout.isTTY; // 非 TTY（如管道/CI）退化为逐条日志输出
  const states = groups.map((ids, i) => ({
    id: i + 1,
    ids,
    ok: 0,
    failed: 0,
    current: null, // 当前策略进度 { name, date, current, total, status }
    finished: false,
    crashed: false,
    exitCode: null,
    errLines: [], // 捕获子进程 stderr，异常退出时打印
    results: [],
  }));
  let finishedAll = false;

  const doneCount = () => states.reduce((n, s) => n + s.ok + s.failed, 0);

  const bar = (cur, total) => {
    const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
    const filled = Math.round((pct / 100) * 14);
    return `[${'#'.repeat(filled)}${'-'.repeat(14 - filled)}]${String(pct).padStart(4)}%`;
  };

  const buildLines = () => {
    const lines = [`并行回测 ${startDate} ~ ${endDate} | 策略 ${totalStrategies} 个 / ${states.length} 进程 | 已完成 ${doneCount()}/${totalStrategies}`];
    for (const st of states) {
      if (st.crashed) {
        const err = (st.errLines[st.errLines.length - 1] || '').trim().slice(0, 50);
        lines.push(`线程${st.id} ✘ 异常退出(code=${st.exitCode ?? '-'}) ${err}`);
      } else if (st.finished) {
        lines.push(`线程${st.id} ✔ 完成: 成功 ${st.ok}, 失败 ${st.failed}`);
      } else if (!st.current) {
        lines.push(`线程${st.id} … 准备中`);
      } else {
        const c = st.current;
        const phase = c.status === 'loading' ? '加载回放数据' : '跑买卖点';
        const done = st.ok + st.failed;
        lines.push(`线程${st.id} ▶ ${c.name} ${c.total > 0 ? `${bar(c.current, c.total)} ` : ''}${c.date} (${c.current}/${c.total}) ${phase} | 完成 ${done}/${st.ids.length}`);
      }
    }
    return lines.map(l => (l.length > 110 ? `${l.slice(0, 107)}...` : l));
  };

  let rendered = false;
  let renderScheduled = false;
  const render = () => {
    const lines = buildLines();
    if (rendered) process.stdout.write(`\x1b[${lines.length}A`); // 光标上移到看板首行
    process.stdout.write(lines.map(l => `\x1b[2K${l}`).join('\n') + '\n');
    rendered = true;
  };
  const scheduleRender = () => {
    if (!useLive) return;
    if (renderScheduled) return;
    renderScheduled = true;
    setImmediate(() => { renderScheduled = false; render(); });
  };

  // 非 TTY：按策略粒度输出单行日志
  const logPlain = (text) => console.log(`[${ts()}] ${text}`);

  const handleMsg = (st, m) => {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'strategy-start':
        st.current = { name: m.name, date: '', current: 0, total: 0, status: '' };
        break;
      case 'progress':
        if (st.current) {
          st.current.date = m.date;
          st.current.current = m.current;
          st.current.total = m.total;
          st.current.status = m.status;
        }
        break;
      case 'strategy-done':
        st.ok += 1;
        st.current = null;
        st.results.push({ status: 'done', name: m.name, summary: m.summary });
        if (!useLive) logPlain(`线程${st.id} [${m.name}] 完成: 交易 ${m.summary.tradeCount ?? '-'} 笔, 胜率 ${m.summary.winRate ?? '-'}%, 整体收益 ${m.summary.overallReturn ?? '-'}%`);
        break;
      case 'strategy-fail':
        st.failed += 1;
        st.current = null;
        st.results.push({ status: 'failed', name: m.name, message: m.message });
        if (!useLive) logPlain(`线程${st.id} [${m.name}] 回测失败: ${m.message}`);
        break;
      case 'worker-crash':
        st.crashed = true;
        st.current = null;
        st.errLines.push(m.message || '未知崩溃');
        break;
      case 'worker-done':
        st.finished = true;
        break;
      default:
        return;
    }
    scheduleRender();
  };

  const maybeFinish = () => {
    if (finishedAll) return;
    if (!states.every(s => s.finished || s.crashed)) return;
    finishedAll = true;
    if (useLive) process.stdout.write('\x1b[?25h'); // 恢复光标
    if (useLive) render(); // 最终一帧
    console.log('');
    states.forEach((st) => {
      (st.results || []).forEach((r) => {
        const s = r.summary || {};
        if (r.status === 'done') console.log(`✔ ${r.name}: 交易 ${s.tradeCount ?? '-'} 笔, 胜率 ${s.winRate ?? '-'}%, 整体收益 ${s.overallReturn ?? '-'}%（已写入缓存）`);
        else console.log(`✘ ${r.name}: ${r.message || '失败'}`);
      });
    });
    const crashed = states.filter(s => s.crashed);
    crashed.forEach((s) => {
      console.error(`\n线程${s.id} 异常输出:\n${(s.errLines || []).join('\n')}`);
    });
    resolve(crashed.length > 0 ? 1 : 0);
  };

  const children = states.map((st) => {
    const child = fork(workerFile, [
      '--child',
      '--start', startDate, '--end', endDate,
      '--strategies', st.ids.join(','),
    ], { silent: true });
    child.on('message', (m) => handleMsg(st, m));
    if (child.stdout) child.stdout.on('data', () => {}); // 消费子进程 stdout，防管道阻塞
    if (child.stderr) child.stderr.on('data', (d) => { if (st.errLines.length < 50) st.errLines.push(String(d).trim()); });
    child.on('error', (err) => {
      st.crashed = true;
      st.errLines.push(err.message || '子进程启动失败');
      scheduleRender();
      maybeFinish();
    });
    child.on('exit', (code) => {
      st.exitCode = code;
      if (!st.finished) st.crashed = true;
      scheduleRender();
      maybeFinish();
    });
    return child;
  });

  // Ctrl+C：终止全部子进程并退出
  process.on('SIGINT', () => {
    if (useLive) process.stdout.write('\x1b[?25h\n');
    children.forEach((c) => { try { c.kill('SIGTERM'); } catch (e) { /* 忽略 */ } });
    process.exit(130);
  });

  scheduleRender();
});

const main = async () => {
  const args = parseArgs(process.argv);
  const range = getDefaultReportRange();
  const startDate = args.start || (range && range.startDate);
  const endDate = args.end || (range && range.endDate);
  if (!startDate || !endDate) {
    console.error('无可用回放交易日，无法确定日期范围');
    process.exit(1);
  }
  for (const [k, v] of [['--start', startDate], ['--end', endDate]]) {
    if (!/^\d{8}$/.test(v)) {
      console.error(`参数错误：${k} 需为 YYYYMMDD，实际为 ${v}`);
      process.exit(1);
    }
  }
  if (args.start && args.end && args.start > args.end) {
    console.error('参数错误：开始日期不能晚于结束日期');
    process.exit(1);
  }
  const explicitRange = !!(args.start || args.end);

  const allIds = Object.keys(STRATEGIES);
  // 两类策略拆分：常规（最近 60 个交易日）/ 三日情绪冰点（固定从 2026-07-01 开始，与其他策略区别开）
  const regularIds = allIds.filter(id => !isEmo3AvgStrategy(id));
  const emo3Ids = allIds.filter(id => isEmo3AvgStrategy(id));
  let emo3Range = null;
  if (emo3Ids.length > 0) {
    try { emo3Range = getEmo3DefaultRange(); } catch (e) { emo3Range = null; }
  }
  // 全组均为三日情绪冰点时，改用其固定起点范围（2026-07-01 起）
  const pickRange = (ids) => {
    if (explicitRange || ids.length === 0) return { startDate, endDate };
    if (ids.every(id => isEmo3AvgStrategy(id)) && emo3Range) return emo3Range;
    return { startDate, endDate };
  };
  const workerCount = Math.max(1, args.workers || 8);
  // 三日情绪冰点策略分组：每进程至少 2 个策略共享同一天回放数据加载（6 策略 → 3 进程），
  // 避免单策略单进程各自重复加载同一批日期缓存
  const emo3WorkerCount = Math.max(1, Math.min(workerCount, Math.ceil(emo3Ids.length / 2)));

  if (args.list) {
    const groups = buildGroups(regularIds, workerCount);
    console.log(`常规策略日期范围: ${startDate} ~ ${endDate}（默认最近 60 个交易日，可用 --start/--end 覆盖）`);
    if (emo3Range) console.log(`三日情绪冰点日期范围: ${emo3Range.startDate} ~ ${emo3Range.endDate}（固定从 2026-07-01 开始）`);
    console.log(`常规策略共 ${regularIds.length} 个，${workerCount} 进程分组: ${groups.map(g => g.length).join(' / ')}`);
    groups.forEach((ids, i) => {
      console.log(`\n线程 ${i + 1}（${ids.length} 个）:`);
      ids.forEach(id => console.log(`  - ${id}  ${STRATEGIES[id].name}`));
    });
    if (emo3Ids.length > 0) {
      const eGroups = buildGroups(emo3Ids, emo3WorkerCount);
      console.log(`\n三日情绪冰点策略共 ${emo3Ids.length} 个，${eGroups.length} 进程分组: ${eGroups.map(g => g.length).join(' / ')}（日期 ${emo3Range ? `${emo3Range.startDate} ~ ${emo3Range.endDate}` : '获取失败'}）`);
      eGroups.forEach((ids, i) => {
        console.log(`\n情绪冰点线程 ${i + 1}（${ids.length} 个）:`);
        ids.forEach(id => console.log(`  - ${id}  ${STRATEGIES[id].name}`));
      });
    }
    return;
  }

  if (args.aggregate) {
    await aggregate(startDate, endDate, args.runMissing);
    return;
  }

  // 自然月回测模式（历史曲线）：按自然月逐月补测全部策略缺失缓存（不清缓存、不生成常规报告）
  if (args.monthly) {
    await runMonthlyTrend(workerCount);
    return;
  }

  // 策略趋势诊断模式：三档时间范围（默认60/30/15个交易日）依次补测缺失缓存的全部策略
  // （不清缓存、不生成常规报告；服务端在 worker 结束后从缓存汇总三份报告）
  if (args.trend) {
    await runTrend(workerCount);
    return;
  }

  // 预构建子进程模式（由父进程 fork 调用）
  if (args.buildDates && args.buildDates.length > 0) {
    await runAsBuildChild(args.buildDates, args.allowMissingFund === true);
    return;
  }

  // 子进程模式（由父进程 fork 调用）
  if (args.child) {
    const ids = args.strategies || [];
    const r = pickRange(ids);
    await runAsChild(ids, r.startDate, r.endDate);
    return;
  }

  // 显式指定策略/分组：单进程串行（调试用，兼容旧的分终端模式，一律强制重跑）
  if (args.strategies || args.group) {
    let strategyIds;
    if (args.strategies) {
      const unknown = args.strategies.filter(id => !STRATEGIES[id]);
      if (unknown.length > 0) {
        console.error(`未知策略: ${unknown.join(', ')}（用 --list 查看全部策略）`);
        process.exit(1);
      }
      strategyIds = args.strategies;
    } else {
      const groups = buildGroups(regularIds, workerCount);
      if (args.group < 1 || args.group > groups.length) {
        console.error(`参数错误：--group 取值 1~${groups.length}`);
        process.exit(1);
      }
      strategyIds = groups[args.group - 1];
    }
    const r = pickRange(strategyIds);
    if (args.prebuild) {
      // 分类回测：先预热日K线 + 预构建回放数据，避免冷缓存时逐日串行重建
      try {
        const t0 = Date.now();
        const warmed = await prewarmKlineCache();
        console.log(`日K线文件缓存预热完成: ${warmed.total - warmed.fetched} 命中 / ${warmed.fetched} 新拉取（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      } catch (e) {
        console.error(`日K线预热失败（不影响后续流程，子进程将自行拉取）: ${e.message}`);
      }
      const hasEmo3 = strategyIds.some(id => isEmo3AvgStrategy(id));
      const allDates = hasEmo3
        ? Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
        : getTrainingCampDates();
      const buildDates = allDates.filter(d => d >= r.startDate && d <= r.endDate && d < beijingToday()).sort();
      await runPrebuild(buildDates, workerCount, { allowMissingFund: hasEmo3 });
    }
    await runStandalone(strategyIds, r.startDate, r.endDate);
    return;
  }

  // 默认：清空回测缓存 → 预热日K线文件缓存 → 并行预构建回放数据缓存 → 多进程并行强制重跑全部策略 → 自动汇总生成回测报告
  const groups = buildGroups(regularIds, workerCount);
  const removed = clearBacktestCache();
  console.log(`常规策略 ${regularIds.length} 个 → ${groups.length} 进程并行（${groups.map(g => g.length).join(' / ')}），日期 ${startDate} ~ ${endDate}`);
  if (emo3Ids.length > 0) {
    console.log(`三日情绪冰点策略 ${emo3Ids.length} 个${emo3Range ? `，日期 ${emo3Range.startDate} ~ ${emo3Range.endDate}（固定从 2026-07-01 开始）` : '，默认日期范围获取失败将跳过'}`);
  }
  console.log(`已清空回测缓存 ${removed} 个文件，全部策略强制重跑`);
  // 预热日K线文件缓存（跨进程共享）：一次性并发拉取全部自选股日K落盘，
  // 避免每个预构建/回测子进程各自重复拉取（原 5 进程 × 84 次 HTTP → 一次性 84 次）
  try {
    const t0 = Date.now();
    const warmed = await prewarmKlineCache();
    console.log(`日K线文件缓存预热完成: ${warmed.total - warmed.fetched} 命中 / ${warmed.fetched} 新拉取（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } catch (e) {
    console.error(`日K线预热失败（不影响后续流程，子进程将自行拉取）: ${e.message}`);
  }
  // 预构建过去交易日的回放数据缓存（已构建过的日期读缓存秒过；策略线程随后只读文件）
  // 下限取全部回放类策略（常规 + 三日情绪冰点）范围的最早起点
  const earliestStart = [startDate, emo3Range?.startDate].filter(Boolean).sort()[0];
  const buildDates = getTrainingCampDates().filter(d => d >= earliestStart && d <= endDate && d < beijingToday()).sort();
  await runPrebuild(buildDates, workerCount);
  console.log('Ctrl+C 可随时终止全部线程\n');
  const exitCode = await runParallel(groups, startDate, endDate);

  // 三日情绪冰点阶段：独立日期范围并行回测（固定从 2026-07-01 开始，与其他策略区别开）
  let emo3Exit = 0;
  if (emo3Ids.length > 0) {
    if (emo3Range) {
      // 先对 emo3 范围全部日期预构建兜底缓存：无资金快照日期（资金快照从 20260728 才开始）原先
      // 不落盘，每次回测都由各策略进程现场全量 HTTP 重复重建 —— 这是三日情绪冰点回测缓慢的主因；
      // 此处预构建一次落盘 .nomfund.json（构建失败的日期写当日负缓存标记），策略阶段全部命中文件
      const emo3BuildDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
        .filter(d => d >= emo3Range.startDate && d <= emo3Range.endDate && d < beijingToday()).sort();
      await runPrebuild(emo3BuildDates, workerCount, { allowMissingFund: true });
      console.log(`\n[${ts()}] 常规策略完成，开始三日情绪冰点策略回测（${emo3Range.startDate} ~ ${emo3Range.endDate}）...`);
      emo3Exit = await runParallel(buildGroups(emo3Ids, emo3WorkerCount), emo3Range.startDate, emo3Range.endDate);
    } else {
      console.error(`\n[${ts()}] 三日情绪冰点默认日期范围获取失败，跳过 ${emo3Ids.length} 个策略`);
    }
  }

  console.log(`\n[${ts()}] 全部线程结束，自动汇总生成回测报告...`);
  await aggregate(startDate, endDate, false);
  process.exitCode = exitCode || emo3Exit;
};

process.on('exit', () => {
  try { process.stdout.write('\x1b[?25h'); } catch (e) { /* 忽略 */ }
});

main().catch(err => {
  console.error('执行失败:', err.message || err);
  process.exit(1);
});
