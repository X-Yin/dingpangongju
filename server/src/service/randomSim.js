// 随机模拟测试（random_sim）：在同一回测区间/策略下，反复随机抽取多批真实股票混入候选池并跑回测，
// 用于检验系统在候选池被大量噪声股票稀释/干扰时的稳定性与鲁棒性。
//
// 股票来源：server/src/service/科技板块拥挤度计算/all_tech_stock_code.json（真实 A 股科技股清单）。
// 并发模型（模仿 script/backtest-worker.js）：父进程 fork 最多 8 个常驻子进程，以工作队列派发 run，
//   子进程内自行按 seed 抽取股票并调用 runRangeBacktest，进度经 IPC 上报，完整结果落盘按需读取。
// 每次运行（run）：
//   1) 依据 run 专属 seed 从清单中随机抽取 N 只（默认 200，排除当前自选股，避免与真实候选池重叠）
//   2) 通过 runRangeBacktest(..., { sim }) 把这些真实股票注入该次回测的候选池，
//      其日K/分时/均线/抗分歧均取自真实行情缓存（与真实自选股同源），保证形态真实。
//   3) 收集该次回测的 summary（收益率/平均回撤/单笔最大回撤/交易笔数等）与完整结果
// 多次运行得到多个样本点，供前端绘制收益率/回撤折线图，并可点击查看某次完整回测报告。
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { getMonitorStocks } = require('./monitorStock');
const { getTrainingCampDates } = require('./trainingCamp');
const {
  DEFAULT_RUNS, DEFAULT_STOCK_COUNT, MAX_RUNS, MAX_STOCK_COUNT, WORKER_COUNT,
  clampInt, loadTechPool, seedForRun,
} = require('./randomSimPool');

const WORKER_PATH = path.join(__dirname, 'randomSimWorker.js');
const RUNS_DIR = path.join(__dirname, '../data/random_sim_runs');

const state = {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  endedAt: null,
  error: null,
  config: null, // { strategy, startDate, endDate, runs, stockCount }
  totalRuns: 0,
  currentRun: 0,
  currentDay: 0,
  totalDays: 0,
  completedRuns: 0,
  activeRuns: 0,
  progressPercent: 0,
  lastLog: '',
  runs: [], // [{ index, success, message, summary, simCount, simCodes, resultFile }]
};

let sessionDir = null; // 本次任务结果落盘目录（子进程写入，父进程按需读取）
const children = []; // 存活子进程

const getRealCodes = () => {
  try {
    return new Set((getMonitorStocks() || []).map(s => s.code).filter(Boolean));
  } catch { return new Set(); }
};

const getRangeDates = (startDate, endDate) => {
  const all = [...getTrainingCampDates()].sort();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return all.filter(d => d >= startDate && d <= endDate && d < today);
};

// 清理历史会话目录，避免结果文件无限堆积
const cleanupOldSessions = (keepDir) => {
  try {
    if (!fs.existsSync(RUNS_DIR)) return;
    for (const name of fs.readdirSync(RUNS_DIR)) {
      const p = path.join(RUNS_DIR, name);
      if (p === keepDir) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
};

// 依据各子进程上报的 in-flight 进度聚合总体百分比
const refreshProgress = (activeMap, runCount, totalDays) => {
  let inflight = 0;
  for (const v of activeMap.values()) {
    if (v.total > 0) inflight += Math.min(1, v.current / v.total);
  }
  state.completedRuns = state.runs.length;
  state.activeRuns = activeMap.size;
  state.currentRun = state.runs.length;
  state.currentDay = Math.round(inflight * totalDays);
  state.progressPercent = Math.max(0, Math.min(100, Math.round(((state.runs.length + inflight) / runCount) * 100)));
};

const pushRun = (entry) => {
  state.runs.push(entry);
};

// 启动随机模拟测试（异步后台执行，前端轮询 /status）
const startRandomSim = ({ strategy, startDate, endDate, runs, stockCount }) => {
  if (state.status === 'running') {
    return { success: false, message: '随机模拟测试已在进行中' };
  }
  if (!/^\d{8}$/.test(String(startDate || '')) || !/^\d{8}$/.test(String(endDate || ''))) {
    return { success: false, message: '参数错误：startDate / endDate 需为 YYYYMMDD' };
  }
  const runCount = clampInt(runs, DEFAULT_RUNS, 1, MAX_RUNS);
  const simCount = clampInt(stockCount, DEFAULT_STOCK_COUNT, 1, MAX_STOCK_COUNT);
  const range = getRangeDates(startDate, endDate);
  if (range.length === 0) {
    return { success: false, message: '所选区间内无可回测交易日' };
  }
  if (loadTechPool().length === 0) {
    return { success: false, message: '未读取到科技股清单，无法抽取随机股票' };
  }

  const baseSeed = (Date.now() % 1000000000) >>> 0;
  const realCodes = [...getRealCodes()];
  const sessionId = String(Date.now());
  sessionDir = path.join(RUNS_DIR, sessionId);
  try { fs.mkdirSync(sessionDir, { recursive: true }); } catch { /* 忽略 */ }
  cleanupOldSessions(sessionDir);

  state.status = 'running';
  state.startedAt = Date.now();
  state.endedAt = null;
  state.error = null;
  state.config = { strategy, startDate, endDate, runs: runCount, stockCount: simCount };
  state.totalRuns = runCount;
  state.currentRun = 0;
  state.currentDay = 0;
  state.totalDays = range.length;
  state.completedRuns = 0;
  state.activeRuns = 0;
  state.progressPercent = 0;
  state.lastLog = `策略 ${strategy}｜${startDate}→${endDate}｜${runCount} 次回测 × 每次随机 ${simCount} 只科技股（${Math.min(WORKER_COUNT, runCount)} 路并行）`;
  state.runs = [];

  const activeMap = new Map(); // runIndex -> { current, total }
  let nextRun = 1; // 下一个待派发的 run 序号

  const finishIfDone = () => {
    if (state.status !== 'running') return;
    if (state.runs.length >= runCount) {
      state.status = 'done';
      state.endedAt = Date.now();
      state.progressPercent = 100;
      state.activeRuns = 0;
      state.lastLog = `随机模拟测试完成，共 ${state.runs.length} 次回测`;
      for (const c of children) { try { c.kill('SIGTERM'); } catch { /* 忽略 */ } }
    }
  };

  const dispatch = (child) => {
    if (state.status !== 'running') return;
    if (nextRun > runCount) {
      try { child.send({ type: 'worker-stop' }); } catch { /* 忽略 */ }
      return;
    }
    const runIndex = nextRun++;
    const seed = seedForRun(baseSeed, runIndex);
    activeMap.set(runIndex, { current: 0, total: range.length });
    child._runIndex = runIndex;
    child.send({ type: 'run', runIndex, seed });
  };

  const handleChildMessage = (child, msg) => {
    if (!msg || typeof msg !== 'object') return;
    const runIndex = Number(msg.runIndex);
    switch (msg.type) {
      case 'worker-ready':
        dispatch(child);
        break;
      case 'run-start':
        state.lastLog = `第 ${runIndex}/${runCount} 次回测：已抽取 ${msg.simCount} 只，开始回测…`;
        break;
      case 'run-progress': {
        const cur = activeMap.get(runIndex);
        if (cur) { cur.current = msg.current || 0; cur.total = msg.total || cur.total; }
        refreshProgress(activeMap, runCount, range.length);
        state.lastLog = `并行回测中：已完成 ${state.runs.length}/${runCount} 次，进行中 ${activeMap.size} 次`;
        break;
      }
      case 'run-done': {
        activeMap.delete(runIndex);
        child._runIndex = null;
        pushRun({
          index: runIndex,
          success: msg.success !== false,
          message: msg.message || null,
          summary: msg.summary || null,
          simCount: msg.simCount || 0,
          simCodes: Array.isArray(msg.simCodes) ? msg.simCodes : [],
          resultFile: msg.resultFile || null,
        });
        const s = msg.summary || {};
        state.lastLog = `第 ${runIndex}/${runCount} 次回测完成：整体收益 ${s.overallReturn != null ? Number(s.overallReturn).toFixed(2) + '%' : '--'}，成交 ${s.tradeCount ?? 0} 笔`;
        refreshProgress(activeMap, runCount, range.length);
        dispatch(child);
        finishIfDone();
        break;
      }
      case 'run-fail': {
        activeMap.delete(runIndex);
        child._runIndex = null;
        pushRun({
          index: runIndex,
          success: false,
          message: msg.message || '未知错误',
          summary: null,
          simCount: 0,
          simCodes: [],
          resultFile: null,
        });
        state.lastLog = `第 ${runIndex}/${runCount} 次回测失败：${msg.message || '未知错误'}`;
        refreshProgress(activeMap, runCount, range.length);
        dispatch(child);
        finishIfDone();
        break;
      }
      default:
        break;
    }
  };

  const handleChildExit = (child, code) => {
    const idx = children.indexOf(child);
    if (idx >= 0) children.splice(idx, 1);
    const runIndex = child._runIndex;
    if (runIndex != null && activeMap.has(runIndex)) {
      activeMap.delete(runIndex);
      pushRun({
        index: runIndex,
        success: false,
        message: `子进程异常退出（code=${code}）`,
        summary: null,
        simCount: 0,
        simCodes: [],
        resultFile: null,
      });
      refreshProgress(activeMap, runCount, range.length);
    }
    // 子进程崩溃后其剩余任务由存活子进程继续消费；若已无存活进程则收尾
    if (children.length === 0 && state.status === 'running') {
      if (nextRun <= runCount || activeMap.size === 0) {
        finishIfDone();
        if (state.status === 'running') {
          state.status = 'error';
          state.error = '全部回测子进程已退出，任务提前结束';
          state.endedAt = Date.now();
          state.lastLog = `随机模拟测试异常：${state.error}`;
        }
      }
    }
  };

  const workerCount = Math.min(WORKER_COUNT, runCount);
  const payload = JSON.stringify({ strategy, startDate, endDate, stockCount: simCount, realCodes, sessionDir });
  for (let i = 0; i < workerCount; i++) {
    let child;
    try {
      child = fork(WORKER_PATH, [payload], { silent: true });
    } catch (e) {
      state.lastLog = `创建回测子进程失败：${e.message}`;
      continue;
    }
    child._runIndex = null;
    child.stderr?.on('data', (buf) => {
      const text = String(buf).trim();
      if (text) console.error(`[randomSim worker ${child.pid}] ${text}`);
    });
    child.on('message', (msg) => handleChildMessage(child, msg));
    child.on('exit', (code) => handleChildExit(child, code));
    child.on('error', () => { /* 由 exit 统一处理 */ });
    children.push(child);
  }

  if (children.length === 0) {
    state.status = 'error';
    state.error = '无法创建回测子进程';
    state.endedAt = Date.now();
    return { success: false, message: state.error };
  }

  return { success: true, total: runCount, stockCount: simCount, workers: workerCount, rangeStart: range[0], rangeEnd: range[range.length - 1] };
};

const getRandomSimStatus = () => ({
  success: true,
  status: state.status,
  config: state.config,
  totalRuns: state.totalRuns,
  currentRun: state.currentRun,
  currentDay: state.currentDay,
  totalDays: state.totalDays,
  completedRuns: state.completedRuns,
  activeRuns: state.activeRuns,
  progressPercent: state.progressPercent,
  lastLog: state.lastLog,
  error: state.error,
  startedAt: state.startedAt,
  endedAt: state.endedAt,
  runs: state.runs.map(r => ({
    index: r.index,
    success: r.success,
    message: r.message,
    summary: r.summary,
    simCount: r.simCount,
  })),
});

// 取某次运行的完整回测结果（供点击折线点后展示完整报告）
const getRandomSimDetail = (runIndex) => {
  const run = state.runs.find(r => r.index === Number(runIndex));
  if (!run) return { success: false, message: '该次回测不存在或已过期' };
  let result = null;
  if (run.resultFile) {
    try { result = JSON.parse(fs.readFileSync(run.resultFile, 'utf8')); } catch { result = null; }
  }
  return { success: true, runIndex: run.index, summary: run.summary, simCodes: run.simCodes, result };
};

module.exports = { startRandomSim, getRandomSimStatus, getRandomSimDetail };