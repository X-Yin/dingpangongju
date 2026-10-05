// 随机模拟测试 - 共享工具（主进程调度器与 fork 子进程共同使用）
// 负责：读取真实科技股清单、按 seed 确定性抽取股票（排除自选股）。
const fs = require('fs');
const path = require('path');

const TECH_POOL_PATH = path.join(__dirname, '科技板块拥挤度计算/all_tech_stock_code.json');

const DEFAULT_RUNS = 20;
const DEFAULT_STOCK_COUNT = 200;
const MAX_RUNS = 200;
const MAX_STOCK_COUNT = 2000;
const WORKER_COUNT = 8;

const clampInt = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

// 确定性伪随机（mulberry32）：同 seed 抽取同一批股票，便于复现某次回测
const mulberry32 = (a) => {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

// 6 位纯代码补市场前缀（与自选股代码口径一致）：6→sh，0/3→sz，4/8→bj
const toFullCode = (raw) => {
  const c = String(raw || '').trim();
  if (!c) return null;
  if (/^(sh|sz|bj)/i.test(c)) return c.toLowerCase();
  if (/^6/.test(c)) return `sh${c}`;
  if (/^[03]/.test(c)) return `sz${c}`;
  if (/^[48]/.test(c)) return `bj${c}`;
  return `sz${c}`;
};

let techPoolCache = null;
const loadTechPool = () => {
  if (techPoolCache) return techPoolCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TECH_POOL_PATH, 'utf8'));
    const list = Array.isArray(raw && raw.stocks) ? raw.stocks : [];
    techPoolCache = list
      .map(s => ({ code: toFullCode(s.code), name: (s && s.name) || String(s.code) }))
      .filter(s => s.code);
  } catch (e) {
    console.error('读取科技股清单失败:', e.message);
    techPoolCache = [];
  }
  return techPoolCache;
};

// 从科技股清单中随机抽取 count 只（排除自选股）；Fisher-Yates 洗牌保证确定性与均匀性
const pickRandomStocks = (count, excludeCodes, seed) => {
  const pool = loadTechPool().filter(s => !excludeCodes.has(s.code));
  const arr = pool.slice();
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
};

// 由抽取结果构建回测注入上下文（供 runRangeBacktest 的 sim 选项使用）
const buildSimContext = (picked) => ({
  codeSet: new Set(picked.map(p => p.code)),
  codes: picked.map(p => p.code),
  nameByCode: new Map(picked.map(p => [p.code, p.name])),
});

// 每个 run 的确定性 seed（与 runIndex 绑定，便于复现）
const seedForRun = (baseSeed, runIndex) => (baseSeed + runIndex * 104729) >>> 0;

module.exports = {
  TECH_POOL_PATH,
  DEFAULT_RUNS,
  DEFAULT_STOCK_COUNT,
  MAX_RUNS,
  MAX_STOCK_COUNT,
  WORKER_COUNT,
  clampInt,
  mulberry32,
  toFullCode,
  loadTechPool,
  pickRandomStocks,
  buildSimContext,
  seedForRun,
};