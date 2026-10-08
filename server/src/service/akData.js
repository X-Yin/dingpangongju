// akshare（python）数据源封装：调用 /ak/api.py 中封装的函数，并做短时内存缓存
// python 脚本每次冷启动需要数秒，配合前端的 10s / 5min 轮询频率做 TTL 缓存，
// 相同请求在 TTL 内直接复用结果；失败时退回上一次成功的数据
const { spawn } = require('child_process');
const path = require('path');

const PYTHON_BIN = 'python3';
const AK_SCRIPT = path.resolve(__dirname, '../../../ak/api.py');
const AK_TIMEOUT = 90 * 1000;

// 各命令的缓存时长：异动类与前端 10s 轮询对齐，新闻/热度与 5min 轮询对齐
const CACHE_TTL = {
  cls_news: 5 * 60 * 1000,
  board_change: 10 * 1000,
  stock_changes: 10 * 1000,
  stock_changes_all: 10 * 1000,
  hot_rank: 5 * 60 * 1000,
  foreign_commodity: 10 * 1000,
  stock_news: 5 * 60 * 1000,
  stock_zyjs: 60 * 60 * 1000,
  jgcyd: 10 * 60 * 1000,
  sector_spot: 30 * 1000,
  sector_detail: 60 * 1000,
};

const cache = new Map();   // key -> { ts, data }
const inflight = new Map(); // key -> Promise，避免并发请求重复拉起 python 子进程

// 从 stdout 中解析最后一行 JSON（防止库把警告等信息打到了 stdout）
const parseJsonLine = (stdout) => {
  const lines = String(stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        return JSON.parse(line);
      } catch (e) {
        // 继续向前找
      }
    }
  }
  return null;
};

// 运行 python 脚本：python3 ak/api.py <cmd> [参数]
const runAkScript = (cmd, symbol) => new Promise((resolve, reject) => {
  const args = [AK_SCRIPT, cmd];
  if (symbol) args.push(symbol);
  const child = spawn(PYTHON_BIN, args, { cwd: path.join(__dirname, '../../..') });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('akshare 脚本执行超时'));
  }, AK_TIMEOUT);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const parsed = parseJsonLine(stdout);
    if (!parsed) {
      reject(new Error(`akshare 脚本输出无法解析(code=${code}): ${(stderr || stdout).slice(-300)}`));
      return;
    }
    if (!parsed.success) {
      reject(new Error(parsed.message || 'akshare 数据获取失败'));
      return;
    }
    resolve(parsed.data);
  });
});

// 带 TTL 缓存 + 失败回退旧数据的统一获取入口
const getAkData = async (cmd, symbol) => {
  const key = symbol ? `${cmd}:${symbol}` : cmd;
  const hit = cache.get(key);

  if (hit && Date.now() - hit.ts < CACHE_TTL[cmd]) {
    return hit.data;
  }

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const task = runAkScript(cmd, symbol)
    .then((data) => {
      cache.set(key, { ts: Date.now(), data });
      return data;
    })
    .catch((err) => {
      // 失败时如有旧缓存则退回旧数据，保证前端轮询不中断
      if (hit) return hit.data;
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
};

// 财联社新闻
const getClsNews = (symbol) => getAkData('cls_news', symbol);
// 板块异动
const getBoardChange = () => getAkData('board_change');
// 盘口异动（全部 18 种异动类型并发抓取后合并，按时间倒序，最多 300 条）
const getStockChangesAll = () => getAkData('stock_changes_all');
// 个股新闻（东财，symbol 为 6 位股票代码）
const getStockNews = (symbol) => getAkData('stock_news', symbol);
// 主营介绍（同花顺，symbol 为 6 位股票代码）
const getStockZyjs = (symbol) => getAkData('stock_zyjs', symbol);
// 东财千股千评-机构参与度（symbol 为 6 位股票代码）
const getInstitutionParticipation = (symbol) => getAkData('jgcyd', symbol);
// 新浪行业-板块行情（indicator 可选: 新浪行业/启明星行业/概念/地域/行业）
const getSectorSpot = (indicator) => getAkData('sector_spot', indicator);
// 新浪行业-板块成分股详情（sector 取板块行情返回的 label）
const getSectorDetail = (sector) => getAkData('sector_detail', sector);
// 外盘期货实时行情（新浪，symbol 见 ak.futures_hq_subscribe_exchange_symbol，可逗号分隔多个）
const getForeignCommodity = (symbol) => getAkData('foreign_commodity', symbol);

module.exports = {
  getClsNews,
  getBoardChange,
  getStockChangesAll,
  getStockNews,
  getStockZyjs,
  getInstitutionParticipation,
  getSectorSpot,
  getSectorDetail,
  getForeignCommodity,
};
