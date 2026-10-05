// 随机模拟测试 - fork 子进程入口（模仿 script/backtest-worker.js 的子进程模式）
// 由 randomSim.js 父进程 fork，常驻等待 run 任务：
//   父进程经 IPC 下发 { type:'run', runIndex, seed }
//   子进程在本进程内依据 seed 抽取真实科技股 → 构建 sim 上下文 → runRangeBacktest
//   进度经 IPC 上报（run-progress），完整回测结果落盘为 JSON 文件（避免大对象走 IPC），
//   仅把 summary + 结果文件路径回传父进程。
// 用法：node src/service/randomSimWorker.js '<json-config>'   （请勿手动调用）
const fs = require('fs');
const path = require('path');
const { runRangeBacktest } = require('./buySellBacktest');
const { pickRandomStocks, buildSimContext } = require('./randomSimPool');

const payload = (() => {
  try { return JSON.parse(process.argv[2] || '{}'); } catch { return {}; }
})();

const { strategy, startDate, endDate, stockCount, realCodes, sessionDir } = payload;
const excludeCodes = new Set(Array.isArray(realCodes) ? realCodes : []);
const send = (m) => { if (process.send) process.send(m); };

// 完整结果落盘（父进程在 /detail 时按需读取），失败时静默忽略不影响回测
const writeRunResult = (runIndex, result) => {
  if (!sessionDir) return null;
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, `run_${runIndex}.json`);
    fs.writeFileSync(file, JSON.stringify(result), 'utf8');
    return file;
  } catch (e) {
    return null;
  }
};

let busy = false;

process.on('message', async (msg) => {
  if (!msg || msg.type !== 'run') {
    if (msg && msg.type === 'worker-stop') process.exit(0);
    return;
  }
  if (busy) return;
  busy = true;
  const { runIndex, seed } = msg;
  try {
    const picked = pickRandomStocks(stockCount, excludeCodes, seed);
    const sim = buildSimContext(picked);
    send({ type: 'run-start', runIndex, simCount: picked.length });
    const result = await runRangeBacktest(startDate, endDate, strategy, (p) => {
      if (p && p.current) send({ type: 'run-progress', runIndex, current: p.current, total: p.total || 0 });
    }, { sim });
    const ok = result?.success !== false;
    const resultFile = ok ? writeRunResult(runIndex, result) : null;
    send({
      type: 'run-done',
      runIndex,
      success: ok,
      message: result?.message || null,
      summary: result?.summary || null,
      simCount: picked.length,
      simCodes: sim.codes,
      resultFile,
    });
  } catch (err) {
    send({ type: 'run-fail', runIndex, message: err.message || String(err) });
  } finally {
    busy = false;
  }
});

send({ type: 'worker-ready' });

// 父进程（服务）退出导致 IPC 断开时自动退出，避免残留孤儿进程
process.on('disconnect', () => process.exit(0));