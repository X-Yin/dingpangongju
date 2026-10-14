// 自选股估值快照（总市值/流通市值/市盈率）——2026-10-13 用户新增，供回测买入限制使用：
//   除「情绪游资」相关策略（顺/逆周期情绪游资、情绪游资-龙头战法；组合策略里仅豁免其情绪游资腿）外，
//   买入候选须同时满足：① 流通市值 ≥ 200 亿（2026-10-14 由总市值改为流通市值口径）；② 市盈率非亏损。
// 亏损判定用「滚动市盈率 ttm_pe」（基于最近 12 个月盈利，能反映当前亏损；静态市盈率 pe 基于上一份年报，
//   会滞后——如中科飞测 sh688361 静态 pe=2091.87 为正、但 ttm_pe=-2432.91 已亏损，故必须用 ttm_pe）。
// 数据来源：财联社个股基础信息接口（与 monitor_stocks_total_shares.json 同源；fields 含
//   mc＝总市值（元）、cmc＝流通市值（元）、ttm_pe＝滚动市盈率），拉取结果缓存到 data/monitor_stocks_valuation.json。
// 回测内同步读表比对：同一自然日复用缓存，跨日或文件缺失时由 ensureWatchlistValuation 重新拉取一次。
// 数据不足（无该股记录，或 mc 为空）时不拦截，与其它过滤器「数据不足不拦截」口径一致。
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getClsReqStockBasicUrl, batchParallel } = require('../utils');
const { getMonitorStocks } = require('./monitorStock');

const VALUATION_PATH = path.join(__dirname, '../data/monitor_stocks_valuation.json');

// 流通市值下限：200 亿元（接口 cmc 单位为元）
const MIN_MARKET_VALUE = 200 * 1e8;

// 本地自然日 'YYYY-MM-DD'（用于判定缓存是否当日有效；避免 ISO/UTC 时区偏差）
const localDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const readFile = () => {
  try {
    if (!fs.existsSync(VALUATION_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(VALUATION_PATH, 'utf8') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error reading watchlist valuation:', e.message);
    return [];
  }
};

let cache = { mtimeMs: -1, map: new Map() };
// 同步读取估值映射（回测热循环用）：Map<code, { marketValue, circulatingMarketValue, ttmPe }>，按文件 mtime 懒加载缓存
const getValuationMap = () => {
  try {
    const mtimeMs = fs.statSync(VALUATION_PATH).mtimeMs;
    if (mtimeMs !== cache.mtimeMs) {
      const map = new Map();
      for (const item of readFile()) {
        if (item && item.code) {
          map.set(item.code, {
            marketValue: item.marketValue != null ? Number(item.marketValue) : null,
            circulatingMarketValue: item.circulatingMarketValue != null ? Number(item.circulatingMarketValue) : null,
            ttmPe: item.ttmPe != null ? Number(item.ttmPe) : null,
          });
        }
      }
      cache = { mtimeMs, map };
    }
  } catch (e) {
    // 文件不存在/读取失败：返回空映射（不拦截任何候选）
  }
  return cache.map;
};

// 是否因估值原因禁止买入：
//   流通市值 < 200 亿 → 禁买（2026-10-14 由总市值口径改为流通市值）；市盈率亏损（滚动市盈率 ttm_pe ≤ 0 或缺失/空）→ 禁买。
// 无该股估值记录、或流通市值缺失（旧缓存/拉取失败）时不按市值拦截（数据不足不拦截），市盈率校验照常生效
const isBuyBlockedByValuation = (code) => {
  const v = getValuationMap().get(code);
  if (!v) return false;
  const { circulatingMarketValue, ttmPe } = v;
  if (circulatingMarketValue != null && Number.isFinite(circulatingMarketValue)
    && circulatingMarketValue < MIN_MARKET_VALUE) return true;
  if (ttmPe == null || !Number.isFinite(ttmPe) || ttmPe <= 0) return true;
  return false;
};

// 拉取自选股估值快照并写入本地缓存文件（codes 为空时拉取全部自选股）。
// 与已有记录合并（本次拉到的覆盖旧值），拉取失败的股票沿用旧记录
const syncWatchlistValuation = async (codes = null) => {
  const stocks = getMonitorStocks();
  const targetCodes = (Array.isArray(codes) && codes.length > 0)
    ? codes
    : stocks.map(s => s.code);
  if (targetCodes.length === 0) return readFile();
  const clsHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': 'https://www.cls.cn',
    'Referer': 'https://www.cls.cn/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  };
  const updatedAt = `${localDateStr()} ${new Date().toTimeString().slice(0, 8)}`;
  const fetched = await batchParallel(targetCodes, async (code) => {
    try {
      const { data: resp } = await axios.get(getClsReqStockBasicUrl(code), { headers: clsHeaders, timeout: 10000 });
      if (resp && resp.code === 200 && resp.data) {
        return {
          code: resp.data.secu_code || code,
          name: resp.data.secu_name || null,
          marketValue: resp.data.mc != null ? Number(resp.data.mc) : null,
          circulatingMarketValue: resp.data.cmc != null ? Number(resp.data.cmc) : null,
          ttmPe: resp.data.ttm_pe != null ? Number(resp.data.ttm_pe) : null,
          updatedAt,
        };
      }
    } catch (e) {
      console.error(`获取 ${code} 估值数据失败:`, e.message);
    }
    return null;
  }, 5);
  const rows = fetched.filter(Boolean);
  if (rows.length > 0) {
    const merged = new Map();
    for (const item of readFile()) if (item && item.code) merged.set(item.code, item);
    for (const item of rows) merged.set(item.code, item);
    fs.writeFileSync(VALUATION_PATH, JSON.stringify(Array.from(merged.values()), null, 2), 'utf8');
    cache = { mtimeMs: -1, map: new Map() };
  }
  return rows;
};

// 是否已有「当日」缓存（按本地自然日判定）
const isCacheFreshToday = () => {
  const rows = readFile();
  if (rows.length === 0) return false;
  const today = localDateStr();
  return rows.some(r => typeof r.updatedAt === 'string' && r.updatedAt.slice(0, 10) === today);
};

// 回测入口预取：文件缺失或缓存非当日时自动拉取一次（同日后续回测直接复用；拉取失败沿用旧缓存/空表，不阻塞回测）
// 并发调用（同进程内多个回测请求同时进入）共用同一次拉取，避免重复请求
let inflight = null;
const ensureWatchlistValuation = async (force = false) => {
  if (!force && isCacheFreshToday()) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      await syncWatchlistValuation();
    } catch (e) {
      console.error('同步自选股估值失败:', e.message);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
};

module.exports = {
  MIN_MARKET_VALUE,
  ensureWatchlistValuation,
  getValuationMap,
  isBuyBlockedByValuation,
  syncWatchlistValuation,
};