// 千亿市值高开走强监控（2026-11-12 用户新增）
//   每个交易日开盘阶段监控全量自选股，条件全部满足时在 9:31 经 WebSocket 推送股票列表：
//     ① 总市值 ≥ 1000 亿（watchlistValuation 缓存的当日总市值，单位元）；
//     ② 9:30 开盘价对应的竞价涨幅 ≥ 1%（9:30:10 后首次实时快照的 price/change 即开盘价 / 竞价涨幅，
//        与 washFusionLive 竞价快照同口径：9:25 集合竞价定格后 9:30 前无成交）；
//     ③ 9:31 实时涨幅 > 9:30 竞价涨幅（高开后继续走强，未回落）。
//   广播 { type:'bigcap_open_surge', open:true, data:{ date, stocks:[...] } }，
//   前端 GlobalDiagnosisAlert 以买点诊断同风格全局卡片弹出；调试面板可 MOCK 触发。
//   内存安全：仅保留当日竞价快照与日去重标记，跨日自动清理。
const dayjs = require('dayjs');
const wsServer = require('../wsServer');
const { isTradingDay } = require('../utils');
const { getMonitorStocks } = require('./monitorStock');
const { getRealtimeQuotes } = require('./stock');
const { ensureWatchlistValuation, getValuationMap } = require('./watchlistValuation');

const MIN_TOTAL_MV = 1000 * 1e8;        // 总市值下限：1000 亿（估值表 mc 单位为元）
const MIN_AUCTION_CHANGE = 1;           // 9:30 竞价涨幅下限（%）
const CHECK_INTERVAL_MS = 10 * 1000;    // 每 10s 检查一次是否到达 9:30 / 9:31 触发点
const CAPTURE_START_SEC = 10;           // 9:30 后第 10s 起可采集竞价快照（确保开盘价已生成）
const WINDOW_SEC = 60;                  // 每个阶段 1 分钟窗口，窗口内失败可重试

let timer = null;
let started = false;
let dayKey = '';                        // 'YYYY-MM-DD'，跨日重置状态
let auctionSnapshot = null;             // Map<code, { name, preclose, openPrice, openChange, totalMvYi }>
let snapshotCaptured = false;           // 当日 9:30 竞价快照是否已采集
let pushed = false;                     // 当日 9:31 是否已推送

const round2 = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : null);

const daykey = () => dayjs().format('YYYY-MM-DD');

// 当日候选：全量自选股中总市值 ≥ 1000 亿的股票（估值缺失的剔除，不参与监控）
const pickBigCapStocks = () => {
  const stocks = getMonitorStocks();
  if (!stocks.length) return [];
  const valuation = getValuationMap();
  return stocks
    .map((s) => {
      const mv = valuation.get(s.code)?.marketValue;
      if (mv == null || !Number.isFinite(mv) || mv < MIN_TOTAL_MV) return null;
      return { code: s.code, name: s.name, totalMvYi: round2(mv / 1e8) };
    })
    .filter(Boolean);
};

// 阶段①：9:30 后采集竞价快照（实时快照的 price/change 即开盘价 / 竞价涨幅），只保留竞价涨幅 ≥ 1% 的
const captureAuctionSnapshot = async () => {
  const candidates = pickBigCapStocks();
  if (candidates.length === 0) return;
  const quotes = await getRealtimeQuotes(candidates.map((s) => s.code));
  const map = new Map();
  for (const s of candidates) {
    const q = quotes[s.code];
    if (!q || q.price == null || q.change == null || !Number.isFinite(Number(q.change))) continue;
    const openChange = Number(q.change);
    if (openChange < MIN_AUCTION_CHANGE) continue;
    map.set(s.code, {
      name: s.name,
      totalMvYi: s.totalMvYi,
      preclose: round2(q.preclose),
      openPrice: round2(q.price),
      openChange: round2(openChange),
    });
  }
  auctionSnapshot = map;
  console.log(
    `[bigcapOpenSurge] ${dayjs().format('HH:mm:ss')} 竞价快照：千亿市值自选股 ${candidates.length} 只，` +
    `竞价涨幅 ≥ ${MIN_AUCTION_CHANGE}% 的 ${map.size} 只` +
    (map.size ? `：${Array.from(map.values()).map((v) => `${v.name}(${v.openChange}%)`).join('、')}` : '')
  );
};

// 阶段②：9:31 复查涨幅，取「9:31 涨幅 > 竞价涨幅」的走强股并 WS 推送
const pushStrongStocks = async () => {
  if (!auctionSnapshot || auctionSnapshot.size === 0) return;
  const codes = Array.from(auctionSnapshot.keys());
  const quotes = await getRealtimeQuotes(codes);
  const stocks = [];
  for (const code of codes) {
    const base = auctionSnapshot.get(code);
    const q = quotes[code];
    if (!q || q.change == null || !Number.isFinite(Number(q.change))) continue;
    const change = Number(q.change);
    if (change <= base.openChange) continue; // 9:31 涨幅须高于开盘涨幅（高开走强）
    stocks.push({
      code,
      name: base.name,
      totalMvYi: base.totalMvYi,
      preclose: base.preclose,
      openPrice: base.openPrice,
      openChange: base.openChange,
      price: round2(q.price),
      change: round2(change),
    });
  }
  if (stocks.length === 0) return;
  // 按 9:31 涨幅降序
  stocks.sort((a, b) => b.change - a.change);
  wsServer.broadcast({
    type: 'bigcap_open_surge',
    ts: Date.now(),
    open: true,
    data: {
      date: daykey(),
      openTime: '09:30',
      checkTime: '09:31',
      rules: { minTotalMvYi: MIN_TOTAL_MV / 1e8, minAuctionChange: MIN_AUCTION_CHANGE },
      stocks,
    },
  });
  console.log(
    `[bigcapOpenSurge] ${dayjs().format('HH:mm:ss')} 千亿市值高开走强 ${stocks.length} 只：` +
    stocks.map((s) => `${s.name}(${s.openChange}%→${s.change}%)`).join('、')
  );
};

const secOfDay = (now) => now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

// 定时检查（幂等）：9:30 窗口采集竞价快照 → 9:31 窗口推送走强股
const check = async () => {
  const now = new Date();
  if (!isTradingDay(now)) return;
  const key = daykey();
  if (dayKey !== key) {
    dayKey = key;
    auctionSnapshot = null;
    snapshotCaptured = false;
    pushed = false;
  }

  const sec = secOfDay(now);
  const captureStart = 9 * 3600 + 30 * 60 + CAPTURE_START_SEC;
  const captureEnd = 9 * 3600 + 30 * 60 + WINDOW_SEC;
  const pushStart = 9 * 3600 + 31 * 60;
  const pushEnd = 9 * 3600 + 31 * 60 + WINDOW_SEC;

  try {
    if (!snapshotCaptured && sec >= captureStart && sec < captureEnd) {
      // 估值缓存当日未就绪时先补拉一次（幂等，已有当日缓存则为空操作）
      await ensureWatchlistValuation();
      await captureAuctionSnapshot();
      snapshotCaptured = true;
    }
    if (!pushed && sec >= pushStart && sec < pushEnd) {
      await pushStrongStocks();
      pushed = true;
    }
  } catch (e) {
    console.error('[bigcapOpenSurge] 检查失败:', e.message);
  }
};

// 启动监控（幂等）
const start = () => {
  if (started) return;
  started = true;
  timer = setInterval(check, CHECK_INTERVAL_MS);
  console.log('[bigcapOpenSurge] 千亿市值高开走强监控已启动（9:30 采集竞价快照，9:31 推送走强股）');
};

// 停止监控并释放定时器
const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
  auctionSnapshot = null;
};

// 调试 MOCK：优先取真实千亿市值自选股 + 实时行情构造走强数据（取不到时用内置假数据），
// 走与实盘完全一致的 WS 链路（type:'bigcap_open_surge'，仅多 mock:true 标记）
const mockSurge = async () => {
  let bases = [];
  try {
    await ensureWatchlistValuation();
    const candidates = pickBigCapStocks();
    if (candidates.length > 0) {
      const quotes = await getRealtimeQuotes(candidates.map((s) => s.code));
      bases = candidates
        .filter((s) => quotes[s.code] && quotes[s.code].preclose > 0)
        .slice(0, 8)
        .map((s) => ({ ...s, preclose: round2(quotes[s.code].preclose) }));
    }
  } catch (e) { /* 拉取失败走兜底假数据 */ }
  if (bases.length === 0) {
    bases = [
      { code: 'sh688981', name: '中芯国际', totalMvYi: 4852.3, preclose: 96.5 },
      { code: 'sh601138', name: '工业富联', totalMvYi: 3120.8, preclose: 24.86 },
      { code: 'sz300750', name: '宁德时代', totalMvYi: 10866.2, preclose: 256.4 },
    ];
  }
  const picked = [...bases].sort(() => Math.random() - 0.5).slice(0, Math.min(3, bases.length));
  const stocks = picked.map((s, i) => {
    const openChange = round2(MIN_AUCTION_CHANGE + Math.random() * 2 + i * 0.3);
    const price = round2(s.preclose * (1 + (openChange + 0.3 + Math.random() * 1.2) / 100));
    return {
      code: s.code,
      name: s.name,
      totalMvYi: s.totalMvYi,
      preclose: s.preclose,
      openPrice: round2(s.preclose * (1 + openChange / 100)),
      openChange,
      price,
      change: round2(((price - s.preclose) / s.preclose) * 100),
    };
  });
  stocks.sort((a, b) => b.change - a.change);
  wsServer.broadcast({
    type: 'bigcap_open_surge',
    ts: Date.now(),
    open: true,
    mock: true,
    data: {
      date: daykey(),
      openTime: '09:30',
      checkTime: '09:31',
      rules: { minTotalMvYi: MIN_TOTAL_MV / 1e8, minAuctionChange: MIN_AUCTION_CHANGE },
      stocks,
    },
  });
  return { success: true, stocks: stocks.map((s) => s.name) };
};

module.exports = { start, stop, mockSurge, check, MIN_TOTAL_MV, MIN_AUCTION_CHANGE };
