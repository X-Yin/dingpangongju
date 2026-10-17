#!/usr/bin/env node
'use strict';

// ============================================================================
// 前五板块 · 首/二板 · 强势分时回测（情绪游资龙头战法的「选股池变体」）
//
// 择时（买点）：沿用「情绪游资-龙头战法」——盘中（分时）上证指数 3 日线斜率「由负转正」的当分钟触发，
//              买入执行不早于 09:40（09:40 之前触发的一律顺延到 09:40）。
// 选股范围  ：前三个交易日内出现过的涨停板股票（src/data/lianbanSnapshot/{YYYYMMDD}.json），且需同时满足：
//              1) 只取每个交易日内「涨停个数排名前五」的板块（按当日题材涨停数降序取前 5）；
//              2) 该股在该窗口内「首次涨停」时的连板数 ≤ 2（首板 / 二板）；
//              3) 剔除创业板（30 开头）与科创板（688 开头）。
// 买入过滤  ：在买入分钟（= max(触发分钟, 09:40)，已涨停买不进则剔除）逐条校验：
//              a) 当日分时涨幅 ∈ [-5%, +5%]；
//              b) 板块内「当日分时涨幅」排名第 1；
//              c) 板块内「3 日涨幅」排名 ≤ 2、板块内「5 日涨幅」排名 ≤ 2、板块内「10 日涨幅」排名 ≤ 3；
//              d) 买入时「过去 10 分钟涨幅」> +0.2%。
// 卖点      ：与「情绪游资-龙头战法」完全一致（10 条）：
//             ① 跌破成本线 -5% 且连续 ≥5 分钟；② 跌停（较昨收 < -9%）；③ 高位放量大阴线；
//             ④ 持仓第 3 个交易日（含买入当日为第 1 天）尾盘 14:57 收益仍 < +10%；
//             ⑤ 竞价低开 < -5%；⑥ 收盘抗分歧指数 < 6；⑦ 盘中分时跌幅 ≤ -5%；
//             ⑧ 开盘后直线下挫（较开盘价 ≤ -5%）；⑨ 上证指数竞价低开 < -0.5% → 9:30 按个股开盘价卖；
//             ⑩ 盘中单分钟跳水 ≤ -3%。
//
// 输出      ：对「每个买点触发时点」，回测通过全部过滤条件的股票（在该时点买入 + 龙头战法卖点卖出）的收益率，
//             取收益率前 N（默认 10）名，并列出：所属板块、首次涨停距触发相差几个交易日、
//             该板块在「首次涨停当日」所有题材中的排名、该板块当日涨停个数、以及各项板块内排名。
//             结果同时写入 JSON 与自包含 HTML 可视化。
//
// 用法：
//   node script/top-board-leader-backtest.js                       默认跑最近 20 个交易日
//   node script/top-board-leader-backtest.js --start 20260728 --end 20261016
//   node script/top-board-leader-backtest.js --days 30 --top 10 --maxhold 10
// ============================================================================

const fs = require('fs');
const path = require('path');

const {
  getSingleStockTlineDataByDate,
  loadIndexKline,
  batchParallel,
  calculateResilience,
  getLimitTypeByCode,
} = require('../src/service/buySellBacktest/deps');
const { getIceMa3SlopeIntraday, getIceMa3Slope } = require('../src/service/buySellBacktest/engine/indexGate');
const { scanLeaderPriceSell, indexAuctionOpenDropPct } = require('../src/service/buySellBacktest/engine/leaderSellMinute');

// ===== 常量 =====
const INDEX_CODE = 'sh000001';
const INDEX_NAME = '上证指数';
const LOOKBACK_DAYS = 3;          // 前三个交易日
const LIMIT_UP_PCT = 9.5;         // 涨停判定（主板，涨幅 > 9.5% 视为封涨停买不进）
const EARLY_BUY_MINUTE = 940;     // 最早可买入分钟：09:40 之前触发的买点统一顺延到 09:40 执行
// —— 选股 / 买入过滤（本变体专属）——
const TOP_BOARDS = 5;             // 每个交易日内只取涨停个数排名前五的板块
const MAX_LIANBAN = 2;            // 首次涨停时的连板数上限（首板 / 二板）
const BUY_CHG_MIN = -5;           // 买入时的当日分时涨幅下限（%）
const BUY_CHG_MAX = 5;            // 买入时的当日分时涨幅上限（%）
const RANK_GAIN3_MAX = 2;         // 板块内 3 日涨幅排名上限
const RANK_GAIN5_MAX = 2;         // 板块内 5 日涨幅排名上限
const RANK_GAIN10_MAX = 3;        // 板块内 10 日涨幅排名上限
const MIN_M10_GAIN = 0.2;         // 买入时「过去 10 分钟涨幅」下限（%）
const TAIL_MINUTE = 1457;         // 尾盘判定分钟
const WEAK_HOLD_DAYS = 3;         // 持仓第 3 个交易日（含买入日为第 1 天）
const WEAK_MIN_GAIN = 10;         // 收益门槛 +10%
const RESILIENCE_MAX = 6;         // 收盘抗分歧指数卖出门槛
const DEFAULT_MAX_HOLD = 10;      // 向后模拟上限（交易日）
const DEFAULT_DAYS = 20;          // 默认回测交易日数
const DEFAULT_TOP = 10;           // 每个触发点输出前 N 名
const CONCURRENCY = 6;

const SNAPSHOT_DIR = path.resolve(__dirname, '../src/data/lianbanSnapshot');
const OUT_JSON = path.resolve(__dirname, 'top-board-leader-backtest.result.json');
const OUT_HTML = path.resolve(__dirname, 'top-board-leader-backtest.html');

// ===== 字段中文注释（作为结果的一个全局字段输出，便于人/AI 理解本文件） =====
const FIELD_DOCS = {
  _说明: '本对象是「所有字段的中文注释」字典；本文件其余顶层字段为回测数据本体，字段含义见下。',
  _术语: 'D = 触发日（买点触发当日）；D−N = 触发日往前第 N 个交易日。',
  策略: '择时（买点）：盘中上证指数(sh000001) 3 日线斜率「由负转正」的那一分钟触发买入信号，与「情绪游资-龙头战法」择时一致。买入执行：不早于 09:40，09:40 之前触发的买点统一顺延到 09:40 执行；买入时刻该股已涨停（涨幅 > 9.5%，买不进）则剔除、不计入 Top10。选股范围：触发日（含）前 3 个交易日内的涨停股（数据源 lianbanSnapshot），只取每个交易日内涨停个数排名前 5 的板块，且该股首次涨停时连板数 ≤ 2（首板/二板），剔除创业板（30 开头）与科创板（688 开头）。买入过滤：当日分时涨幅 ∈ [-5%, +5%]、板块内当日分时涨幅排名第 1、板块内 3 日涨幅排名 ≤ 2、板块内 5 日涨幅排名 ≤ 2、板块内 10 日涨幅排名 ≤ 3、买入时过去 10 分钟涨幅 > +0.2%。卖点：与「情绪游资-龙头战法」一致的 10 条卖点。输出：对每个买点触发时点，列出候选池中收益率前 N 名，及其板块、N 日涨幅、板块内排名等。',
  generatedAt: '结果生成时间（ISO 8601）。',
  range: {
    说明: '回测覆盖的交易日区间。',
    startDate: '起始交易日（YYYY-MM-DD，含）。',
    endDate: '结束交易日（YYYY-MM-DD，含）。',
  },
  params: {
    说明: '回测参数。',
    index: '择时所用指数（上证指数 sh000001）。',
    lookbackDays: '选股回看天数：取触发日前多少个交易日内的涨停股（=3）。',
    topBoards: '只取每个交易日内涨停个数排名前 N 的板块（=5）。',
    maxLianban: '该股首次涨停时的连板数上限（=2，即首板/二板）。',
    buyChangeRange: '买入时的当日分时涨幅允许区间（%，= [-5, +5]）。',
    rankLimits: '板块内排名上限：3 日涨幅 ≤2、5 日涨幅 ≤2、10 日涨幅 ≤3；当日分时涨幅必须排名第 1。',
    minM10Gain: '买入时「过去 10 分钟涨幅」下限（%，=0.2）。',
    limitUpPct: '涨停/买不进的判定阈值：买入时刻涨幅 > 9.5% 视为封涨停买不进，剔除、不计入 Top10。',
    earlyBuyMinute: '最早可买入分钟（940 = 09:40）：09:40 之前触发的买点统一顺延到该分钟执行。',
    tailMinute: '尾盘判定分钟（1457 = 14:57）。',
    weakHoldDays: '弱势持仓判定：持仓第 N 个交易日（含买入当日为第 1 天，=3）。',
    weakMinGain: '第 3 个交易日尾盘收益低于该值（%）则卖出（=+10）。',
    resilienceMax: '收盘抗分歧指数低于该值则卖出（=6）。',
    maxHoldDays: '单笔向后模拟卖出的最大交易日数（上限）。',
    top: '每个触发时点输出的股票数量（=10）。',
    exclude: '选股剔除规则说明。',
  },
  summary: {
    说明: '回测汇总统计。',
    scannedDays: '实际扫描的交易日数。',
    triggerDays: '出现过买点触发的交易日数。',
    triggerCount: '买点触发点总数（一天可能多次触发）。',
    avgCandidates: '日均候选池股票数。',
    elapsedSec: '本次回测耗时（秒）。',
  },
  days: {
    说明: '按触发日组织的明细数组（仅包含有触发的交易日）。',
    元素: {
      date: '触发日（YYYYMMDD 数字）。',
      dateDisplay: '触发日（YYYY-MM-DD）。',
      candidateCount: '该触发日候选池股票数（前 3 个交易日涨停股，仅保留涨停个数排名前 5 的板块、且首次涨停连板数 ≤2，剔除创业板/科创板后）。',
      triggers: {
        说明: '该日的买点触发点数组（一天可能出现多次「斜率由负转正」）。',
        元素: {
          minute: '触发分钟（HHMM 数字，如 945 表示 09:45）。',
          timeText: '触发分钟（HH:MM）。',
          buyMinute: '实际买入分钟（HHMM）：= max(触发分钟, 09:40)，即 09:40 之前触发的一律顺延到 09:40。',
          buyTimeText: '实际买入分钟（HH:MM）。',
          slope: '触发时上证指数 3 日线斜率值（由负转正，故为正）。',
          buyableCount: '该买入分钟「可买入」候选数（已剔除已涨停买不进/无分时数据者）。',
          passCount: '通过全部买入过滤条件（分时涨幅区间、板块内排名、10 分钟涨幅）的股票数。',
          evaluatedCount: '完成买卖模拟并算出收益率的候选数。',
          top: {
            说明: '收益率前 N 名的股票明细（按 returnPct 降序）。',
            元素: {
              rank: '名次（1 为收益率最高）。',
              code: '股票代码（带市场前缀，如 sh600xxx / sz000xxx）。',
              name: '股票名称。',
              board: '所属板块（题材）名称（取自该股「首次涨停当日」lianbanSnapshot 中所属题材）。',
              firstLimitUpDate: '该股在前 3 个交易日内「首次涨停」的日期（YYYY-MM-DD）。',
              daysAgo: '首次涨停日距触发日的交易日数（1/2/3）。',
              boardRank: '该板块在「首次涨停当日」所有题材中的排名（第几名）。',
              boardCount: '该板块在「首次涨停当日」的涨停个数。',
              boardSize: '板块内参与排名的有效样本数（该题材当日涨停股中、有当日分时数据者）。',
              gain3d: '买入时 3 日涨幅（%）=（买入分钟价 ÷ D−3 收盘价 − 1）×100，含买入当日盘中分时涨幅。',
              gain5d: '买入时 5 日涨幅（%）=（买入分钟价 ÷ D−5 收盘价 − 1）×100。',
              gain10d: '买入时 10 日涨幅（%）=（买入分钟价 ÷ D−10 收盘价 − 1）×100。',
              boardGain3dRank: '该股 3 日涨幅在其板块内所有涨停股中的排名（从高到低）。',
              boardGain5dRank: '该股 5 日涨幅在其板块内的排名。',
              boardGain10dRank: '该股 10 日涨幅在其板块内的排名。',
              boardIntradayRank: '该股「当日分时涨幅（买入分钟）」在其板块内的排名。',
              intraday10Pct: '买入时「过去 10 分钟涨幅（%）」=（买入分钟价 ÷ 买入前 10 个分时点（约 10 分钟）的价格 − 1）×100；不足 10 点时以当日首个分时点为基准。',
              boardIntraday10Rank: '该股「过去 10 分钟涨幅」在其板块内的排名（从高到低）。',
              lianbanCount: '首次涨停当日的连板数（1=首板）。',
              buyPrice: '买入价 = 买入分钟该股的价格。',
              buyChangePct: '买入时的当日分时涨幅（%）=（买入分钟价 ÷ 昨收 − 1）×100。',
              sellDate: '卖出日（YYYY-MM-DD）。',
              sellTime: '卖出时间（HH:MM）。',
              sellPx: '卖出价。',
              holdDays: '持有交易日数（含买入当日为第 1 天）。',
              sold: '是否触发卖点（true=按卖点卖出；false=到模拟窗口末端仍未触发，按最后一日尾盘价计）。',
              returnPct: '收益率（%）=（卖出价 − 买入价）÷ 买入价 ×100。',
              sellReason: '卖出原因（触发的是哪一条卖点）。',
            },
          },
        },
      },
    },
  },
};

// ===== 小工具 =====
const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : parseFloat(Number(v).toFixed(2)));
const fmt8 = (d) => { const s = String(d); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s; };
const fmtMinute = (m) => (m == null ? '--' : `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`);
const isChiNextOrStar = (pureCode) => /^(30|688)/.test(pureCode);

const priceAtMinute = (points, minute) => {
  let at = null;
  for (const p of points) { if (p.minute <= minute) at = p; else break; }
  return at;
};

// ===== 分时缓存（原始数据 + 规范化点），全局复用，避免重复读盘/HTTP =====
const rawTlineCache = new Map();   // `${code}|${dateNum}` -> 原始结果 | null
const pointsCache = new Map();     // `${code}|${dateNum}` -> [{minute,lastPx,change}]
const indexOpenDropCache = new Map(); // dateNum -> number|null

const getRawTline = async (code, dateNum) => {
  const key = `${code}|${dateNum}`;
  if (rawTlineCache.has(key)) return rawTlineCache.get(key);
  let res = null;
  try { res = await getSingleStockTlineDataByDate(code, dateNum); } catch (e) { res = null; }
  rawTlineCache.set(key, res);
  return res;
};

const toPoints = (raw) => (raw && Array.isArray(raw.line) ? raw.line : [])
  .filter((p) => p && p.minute != null && p.last_px != null)
  .map((p) => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
  .filter((p) => p.lastPx > 0)
  .sort((a, b) => a.minute - b.minute);

const getPoints = async (code, dateNum) => {
  const key = `${code}|${dateNum}`;
  if (pointsCache.has(key)) return pointsCache.get(key);
  const raw = await getRawTline(code, dateNum);
  const pts = toPoints(raw);
  pointsCache.set(key, pts);
  return pts;
};

const getIndexOpenDrop = async (dateNum) => {
  if (indexOpenDropCache.has(dateNum)) return indexOpenDropCache.get(dateNum);
  const raw = await getRawTline(INDEX_CODE, dateNum);
  const v = raw ? indexAuctionOpenDropPct(raw) : null;
  indexOpenDropCache.set(dateNum, v);
  return v;
};

const getDayResilience = async (code, dateNum) => {
  const [sRaw, iRaw] = await Promise.all([getRawTline(code, dateNum), getRawTline(INDEX_CODE, dateNum)]);
  const sLine = sRaw && Array.isArray(sRaw.line) ? sRaw.line : [];
  const iLine = iRaw && Array.isArray(iRaw.line) ? iRaw.line : [];
  if (sLine.length >= 5 && iLine.length >= 5) {
    const r = calculateResilience(iLine, sLine, getLimitTypeByCode(code));
    return r != null && Number.isFinite(Number(r)) ? Number(r) : null;
  }
  return null;
};

// 某交易日收盘价：优先取该日分时最后一个点，兜底取其次一交易日分时的前收盘
const getCloseAt = async (code, baseDate, nextDate) => {
  const t = await getRawTline(code, baseDate);
  const p = toPoints(t);
  if (p.length > 0) return p[p.length - 1].lastPx;
  const tn = nextDate != null ? await getRawTline(code, nextDate) : null;
  if (tn && tn.preclose_px != null) { const v = parseFloat(tn.preclose_px); if (v > 0) return v; }
  return null;
};

// 板块内排名：对某板块在当前触发分钟，计算板块内每只票的「N 日涨幅」与「当日分时涨幅」，并排名
// closeSpecs: [{ key: 'g3'|'g5'|'g10', baseDate, nextDate }]
const boardRankCache = new Map(); // `${date}|${minute}|${codes.join(',')}` -> {valueMaps,rankMaps,size}
const getBoardRanks = async (codes, dateNum, minute, closeSpecs) => {
  const key = `${dateNum}|${minute}|${codes.join(',')}`;
  if (boardRankCache.has(key)) return boardRankCache.get(key);
  const rows = [];
  await batchParallel(codes, async (code) => {
    const rawD = await getRawTline(code, dateNum);
    const pts = await getPoints(code, dateNum);
    const at = priceAtMinute(pts, minute);
    if (!at || !(at.lastPx > 0)) return;
    const pre = rawD && rawD.preclose_px != null ? parseFloat(rawD.preclose_px) : null;
    // 触发前 10 个分时点（约 10 分钟）的整体涨幅；不足 10 点时以当日首个分时点为基准
    const atIdx = pts.indexOf(at);
    const backPt = pts[atIdx - 10 >= 0 ? atIdx - 10 : 0];
    const intraday10 = backPt && backPt.lastPx > 0 ? ((at.lastPx / backPt.lastPx) - 1) * 100 : null;
    const row = { code, intraday: pre && pre > 0 ? ((at.lastPx - pre) / pre) * 100 : null, intraday10 };
    for (const sp of closeSpecs) {
      const c = await getCloseAt(code, sp.baseDate, sp.nextDate);
      row[sp.key] = c != null && c > 0 ? ((at.lastPx / c) - 1) * 100 : null;
    }
    rows.push(row);
  }, CONCURRENCY);

  const valueMaps = {}, rankMaps = {};
  const fields = ['intraday', 'intraday10', ...closeSpecs.map((s) => s.key)];
  for (const f of fields) {
    const sorted = rows.filter((r) => r[f] != null).sort((a, b) => b[f] - a[f]);
    const vm = new Map(), rm = new Map();
    sorted.forEach((r, i) => { vm.set(r.code, r[f]); rm.set(r.code, i + 1); });
    valueMaps[f] = vm; rankMaps[f] = rm;
  }
  const res = { valueMaps, rankMaps, size: rows.length };
  boardRankCache.set(key, res);
  return res;
};

// ===== lianbanSnapshot 读取 =====
const snapshotCache = new Map();
const readSnapshot = (dateNum) => {
  if (snapshotCache.has(dateNum)) return snapshotCache.get(dateNum);
  const file = path.join(SNAPSHOT_DIR, `${dateNum}.json`);
  let data = null;
  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { data = null; }
  snapshotCache.set(dateNum, data);
  return data;
};

const listSnapshotDates = () => {
  let files = [];
  try { files = fs.readdirSync(SNAPSHOT_DIR); } catch (e) { return []; }
  return files.filter((f) => /^\d{8}\.json$/.test(f)).map((f) => Number(f.slice(0, 8))).sort((a, b) => a - b);
};

// 候选池：前三个交易日内涨停股，仅保留「每个交易日涨停个数排名前五」的板块、且首次涨停时连板数 ≤ 2
// （每只取「首次涨停日」的板块/排名/涨停数）
const buildCandidates = (prevDates) => {
  const byCode = new Map();
  for (let i = 0; i < prevDates.length; i++) {
    const d = prevDates[i];
    const snap = readSnapshot(d);
    if (!snap || !Array.isArray(snap.themes)) continue;
    const daysAgo = prevDates.length - i; // 距回测触发日相差的交易日数（1/2/3）
    const themes = snap.themes.filter((t) => t && Array.isArray(t.stocks));
    // 涨停个数排名前五：优先用快照自带的 rank，缺失时用列表位次兜底
    const topThemes = themes.filter((t, pos) => {
      const r = t.rank != null ? Number(t.rank) : null;
      return r != null ? r <= TOP_BOARDS : pos < TOP_BOARDS;
    });
    for (const theme of topThemes) {
      for (const st of theme.stocks) {
        const code = (st && (st.marketCode || st.code)) || null;
        if (!code) continue;
        const pure = String(code).replace(/^(sh|sz|bj)/i, '');
        if (isChiNextOrStar(pure)) continue;         // 剔除创业板/科创板
        const lianbanCount = st.lianbanCount != null ? Number(st.lianbanCount) : null;
        if (!(lianbanCount != null && lianbanCount <= MAX_LIANBAN)) continue; // 首次涨停时最多首板/二板
        if (byCode.has(code)) continue;              // 只保留最早（第一次涨停当日）
        byCode.set(code, {
          code,
          name: st.name || code,
          board: theme.board || theme.name || '',
          boardRank: theme.rank != null ? Number(theme.rank) : null,
          boardCount: theme.count != null ? Number(theme.count) : null,
          boardCodes: theme.stocks.map((s) => s.marketCode || s.code).filter(Boolean), // 板块内全部涨停股（用于板块内排名）
          firstLimitUpDate: d,
          daysAgo,
          lianbanCount,
        });
      }
    }
  }
  return Array.from(byCode.values());
};

// ===== 卖点模拟：自买入次日起，逐交易日按龙头战法 10 条卖点回放，返回最先卖出的那笔 =====
const simulateSell = async (code, buyDi, buyPrice, tradeDates, maxHold) => {
  let lastPx = null, lastDate = null, lastMinute = null, lastHoldDays = null;
  for (let k = 1; k <= maxHold; k++) {
    const di = buyDi + k;
    if (di >= tradeDates.length) break;
    const dateNum = tradeDates[di];
    const raw = await getRawTline(code, dateNum);
    const points = await getPoints(code, dateNum);
    if (points.length === 0) continue;
    const preclose = raw && raw.preclose_px != null ? parseFloat(raw.preclose_px) : null;
    const idxOpenDrop = await getIndexOpenDrop(dateNum);

    // 价格类卖点（分钟级回溯，取最先触发的那一分钟）
    const hit = scanLeaderPriceSell({ points, preclose, buyPrice, cutoffMinute: TAIL_MINUTE, indexOpenDropPct: idxOpenDrop });
    if (hit) {
      return {
        sold: true, sellDate: dateNum, sellMinute: hit.minute, sellPx: round2(hit.px),
        sellReason: hit.reason, holdDays: k + 1,
        returnPct: buyPrice > 0 ? round2(((hit.px - buyPrice) / buyPrice) * 100) : null,
      };
    }

    const tailPt = priceAtMinute(points, TAIL_MINUTE) || points[points.length - 1];
    const tailPx = tailPt.lastPx;
    const costReturn = buyPrice > 0 ? ((tailPx - buyPrice) / buyPrice) * 100 : null;
    lastPx = tailPx; lastDate = dateNum; lastMinute = tailPt.minute; lastHoldDays = k + 1;

    // ④ 持仓第 3 个交易日尾盘收益仍 < +10%
    if ((k + 1) === WEAK_HOLD_DAYS && costReturn != null && costReturn < WEAK_MIN_GAIN) {
      return {
        sold: true, sellDate: dateNum, sellMinute: tailPt.minute, sellPx: round2(tailPx),
        sellReason: `持仓第 ${WEAK_HOLD_DAYS} 个交易日尾盘收益 ${round2(costReturn)}% 仍未拉开至 +${WEAK_MIN_GAIN}%`,
        holdDays: k + 1, returnPct: round2(costReturn),
      };
    }

    // ⑥ 收盘抗分歧指数 < 6
    const res = await getDayResilience(code, dateNum);
    if (res != null && res < RESILIENCE_MAX) {
      return {
        sold: true, sellDate: dateNum, sellMinute: tailPt.minute, sellPx: round2(tailPx),
        sellReason: `当日收盘抗分歧指数 ${res} < ${RESILIENCE_MAX}`,
        holdDays: k + 1, returnPct: round2(costReturn),
      };
    }
  }
  if (lastPx != null) {
    return {
      sold: false, sellDate: lastDate, sellMinute: lastMinute, sellPx: round2(lastPx),
      sellReason: `未触发卖点（持有至 ${maxHold} 个交易日后按尾盘价计）`, holdDays: lastHoldDays,
      returnPct: buyPrice > 0 ? round2(((lastPx - buyPrice) / buyPrice) * 100) : null,
    };
  }
  return null;
};

// ===== 单日回测：扫描触发点 → 每个触发点评估候选池 → 取前 N =====
const runDay = async (dateNum, di, tradeDates, opts) => {
  const prevDates = [tradeDates[di - 3], tradeDates[di - 2], tradeDates[di - 1]].filter((d) => Number.isFinite(d));
  if (prevDates.length < LOOKBACK_DAYS) return null;

  const candidates = buildCandidates(prevDates);
  if (candidates.length === 0) return null;

  // N 日涨幅基准日（3/5/10 个交易日前）
  const closeSpecs = [];
  if (di - 3 >= 0) closeSpecs.push({ key: 'g3', baseDate: tradeDates[di - 3], nextDate: tradeDates[di - 2] });
  if (di - 5 >= 0) closeSpecs.push({ key: 'g5', baseDate: tradeDates[di - 5], nextDate: tradeDates[di - 4] });
  if (di - 10 >= 0) closeSpecs.push({ key: 'g10', baseDate: tradeDates[di - 10], nextDate: tradeDates[di - 9] });

  const idxPoints = await getPoints(INDEX_CODE, dateNum);
  if (idxPoints.length === 0) return null;

  // 斜率符号初值：前一交易日收盘口径
  let lastSign = null;
  try {
    const seed = await getIceMa3Slope(prevDates[prevDates.length - 1]);
    if (seed != null && Number.isFinite(Number(seed))) lastSign = Number(seed) > 0 ? 1 : -1;
  } catch (e) { /* 无初值 */ }

  // 逐分钟扫描触发点：斜率由负转正
  const triggers = [];
  for (const p of idxPoints) {
    const slope = await getIceMa3SlopeIntraday(dateNum, p.minute);
    if (slope == null || !Number.isFinite(Number(slope))) continue;
    const positive = Number(slope) > 0;
    if (positive && (lastSign == null || lastSign <= 0)) triggers.push({ minute: p.minute, slope: Number(slope) });
    lastSign = positive ? 1 : -1;
  }
  if (triggers.length === 0) return { date: dateNum, dateDisplay: fmt8(dateNum), candidateCount: candidates.length, triggers: [] };

  const triggerResults = [];
  for (const tg of triggers) {
    // 09:40 之前触发的买点顺延到 09:40 执行（买入时刻与买入价均取该分钟）
    const buyMinute = Math.max(tg.minute, EARLY_BUY_MINUTE);
    // 1) 该买入分钟可买入的候选（剔除已涨停买不进 / 无分时）
    const buyable = [];
    await batchParallel(candidates, async (c) => {
      const raw = await getRawTline(c.code, dateNum);
      const points = await getPoints(c.code, dateNum);
      const atPt = priceAtMinute(points, buyMinute);
      if (!atPt || !(atPt.lastPx > 0)) return;
      const preclose = raw && raw.preclose_px != null ? parseFloat(raw.preclose_px) : null;
      const changePct = preclose && preclose > 0 ? round2(((atPt.lastPx - preclose) / preclose) * 100) : (atPt.change != null ? atPt.change : null);
      if (changePct != null && changePct > LIMIT_UP_PCT) return; // 买入时刻已涨停买不进 → 剔除，不计入 Top10
      buyable.push({ ...c, buyPrice: round2(atPt.lastPx), buyChangePct: changePct });
    }, CONCURRENCY);

    // 2) 板块内排名：对该触发点所有可买候选涉及的板块统一计算一次
    //    （3/5/10 日涨幅、当日分时涨幅、过去 10 分钟涨幅 —— 均以买入分钟为基准）
    const boardRankByKey = new Map();
    for (const b of buyable) {
      if (!Array.isArray(b.boardCodes) || b.boardCodes.length === 0) continue;
      const bk = b.boardCodes.join(',');
      if (boardRankByKey.has(bk)) continue;
      boardRankByKey.set(bk, await getBoardRanks(b.boardCodes, dateNum, buyMinute, closeSpecs));
    }
    const brOf = (b) => (Array.isArray(b.boardCodes) ? boardRankByKey.get(b.boardCodes.join(',')) : null);
    const valOf = (b, kk) => { const br = brOf(b); return br && br.valueMaps[kk] && br.valueMaps[kk].has(b.code) ? br.valueMaps[kk].get(b.code) : null; };
    const rkOf = (b, kk) => { const br = brOf(b); return br && br.rankMaps[kk] && br.rankMaps[kk].has(b.code) ? br.rankMaps[kk].get(b.code) : null; };

    // 3) 买入过滤：分时涨幅区间 + 板块内分时涨幅第 1 + 板块内 3/5/10 日涨幅排名 + 过去 10 分钟涨幅
    const passed = buyable.filter((b) => {
      if (b.buyChangePct == null) return false;
      if (b.buyChangePct < BUY_CHG_MIN || b.buyChangePct > BUY_CHG_MAX) return false;
      if (rkOf(b, 'intraday') !== 1) return false;
      const r3 = rkOf(b, 'g3'), r5 = rkOf(b, 'g5'), r10 = rkOf(b, 'g10');
      if (!(r3 != null && r3 <= RANK_GAIN3_MAX)) return false;
      if (!(r5 != null && r5 <= RANK_GAIN5_MAX)) return false;
      if (!(r10 != null && r10 <= RANK_GAIN10_MAX)) return false;
      const m10 = valOf(b, 'intraday10');
      if (!(m10 != null && m10 > MIN_M10_GAIN)) return false;
      return true;
    });

    // 4) 对通过过滤的股票模拟卖出，计算收益率
    const evaluated = [];
    await batchParallel(passed, async (b) => {
      const sim = await simulateSell(b.code, di, b.buyPrice, tradeDates, opts.maxHold);
      if (!sim || sim.returnPct == null) return;
      evaluated.push({ ...b, ...sim });
    }, CONCURRENCY);

    evaluated.sort((a, x) => (x.returnPct ?? -1e9) - (a.returnPct ?? -1e9));
    const topList = evaluated.slice(0, opts.top);

    const top = topList.map((e, i) => {
      const br = Array.isArray(e.boardCodes) ? boardRankByKey.get(e.boardCodes.join(',')) : null;
      const val = (kk) => (br && br.valueMaps[kk] && br.valueMaps[kk].has(e.code) ? round2(br.valueMaps[kk].get(e.code)) : null);
      const rk = (kk) => (br && br.rankMaps[kk] && br.rankMaps[kk].has(e.code) ? br.rankMaps[kk].get(e.code) : null);
      return {
        rank: i + 1,
        code: e.code,
        name: e.name,
        board: e.board,
        firstLimitUpDate: fmt8(e.firstLimitUpDate),
        daysAgo: e.daysAgo,
        boardRank: e.boardRank,
        boardCount: e.boardCount,
        boardSize: br ? br.size : null,
        gain3d: val('g3'),
        gain5d: val('g5'),
        gain10d: val('g10'),
        boardGain3dRank: rk('g3'),
        boardGain5dRank: rk('g5'),
        boardGain10dRank: rk('g10'),
        boardIntradayRank: rk('intraday'),
        intraday10Pct: val('intraday10'),
        boardIntraday10Rank: rk('intraday10'),
        lianbanCount: e.lianbanCount,
        buyPrice: e.buyPrice,
        buyChangePct: e.buyChangePct,
        sellDate: fmt8(e.sellDate),
        sellTime: fmtMinute(e.sellMinute),
        sellPx: e.sellPx,
        holdDays: e.holdDays,
        sold: e.sold,
        returnPct: e.returnPct,
        sellReason: e.sellReason,
      };
    });

    triggerResults.push({
      minute: tg.minute,
      timeText: fmtMinute(tg.minute),
      buyMinute,
      buyTimeText: fmtMinute(buyMinute),
      slope: round2(tg.slope),
      buyableCount: buyable.length,
      passCount: passed.length,
      evaluatedCount: evaluated.length,
      top,
    });
  }

  return { date: dateNum, dateDisplay: fmt8(dateNum), candidateCount: candidates.length, triggers: triggerResults };
};

// ===== 交易日历 =====
const loadTradeDates = async () => {
  const kline = await loadIndexKline('sh_kline.json', '1A0001', '16', 500);
  return (kline || [])
    .filter((k) => Number.isFinite(Number(k.trade_date)) && Number(k.close_px) > 0)
    .map((k) => Number(k.trade_date))
    .sort((a, b) => a - b);
};

// ===== 参数 =====
const parseArgs = (argv) => {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--start') a.start = argv[++i];
    else if (k === '--end') a.end = argv[++i];
    else if (k === '--days') a.days = Number(argv[++i]);
    else if (k === '--top') a.top = Number(argv[++i]);
    else if (k === '--maxhold') a.maxHold = Number(argv[++i]);
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node script/lianban-leader-backtest.js [--start YYYYMMDD] [--end YYYYMMDD] [--days N] [--top N] [--maxhold N]');
    return;
  }

  const tradeDates = await loadTradeDates();
  if (tradeDates.length < 10) throw new Error('上证指数日K数据不足，无法构建交易日历');

  const snapshotDates = listSnapshotDates();
  const fallbackEnd = snapshotDates.length > 0 ? snapshotDates[snapshotDates.length - 1] : tradeDates[tradeDates.length - 1];

  const end = args.end ? Number(args.end) : fallbackEnd;
  let start;
  if (args.start) start = Number(args.start);
  else {
    const endIdx = tradeDates.findIndex((d) => d >= end);
    const idx = endIdx < 0 ? tradeDates.length - 1 : endIdx;
    const days = Number.isFinite(args.days) && args.days > 0 ? args.days : DEFAULT_DAYS;
    start = tradeDates[Math.max(0, idx - days + 1)];
  }
  const top = Number.isFinite(args.top) && args.top > 0 ? args.top : DEFAULT_TOP;
  const maxHold = Number.isFinite(args.maxHold) && args.maxHold > 0 ? args.maxHold : DEFAULT_MAX_HOLD;

  if (start > end) throw new Error(`参数错误：开始日期 ${start} 晚于结束日期 ${end}`);

  const rangeIdx = [];
  tradeDates.forEach((d, i) => { if (d >= start && d <= end) rangeIdx.push(i); });
  if (rangeIdx.length === 0) throw new Error(`日期范围 ${start} ~ ${end} 内无可用交易日`);

  const opts = { top, maxHold };
  console.log(`[前五板块·首二板·强势分时回测] 区间 ${fmt8(start)} ~ ${fmt8(end)}（${rangeIdx.length} 个交易日），每触发点取前 ${top} 名，向后模拟上限 ${maxHold} 个交易日`);
  console.log(`  择时：${INDEX_NAME} 3 日线斜率盘中由负转正触发（${fmtMinute(EARLY_BUY_MINUTE)} 前触发顺延至 ${fmtMinute(EARLY_BUY_MINUTE)} 执行）`);
  console.log(`  选股：前 ${LOOKBACK_DAYS} 个交易日涨停股 ｜ 仅取当日涨停数前 ${TOP_BOARDS} 的板块 ｜ 首次涨停连板数 ≤ ${MAX_LIANBAN} ｜ 剔除创业板/科创板`);
  console.log(`  买入过滤：分时涨幅 ∈ [${BUY_CHG_MIN}%, ${BUY_CHG_MAX}%] ｜ 板块内分时涨幅第 1 ｜ 板块内 3 日涨幅 ≤${RANK_GAIN3_MAX} / 5 日涨幅 ≤${RANK_GAIN5_MAX} / 10 日涨幅 ≤${RANK_GAIN10_MAX} ｜ 过去 10 分钟涨幅 > ${MIN_M10_GAIN}%`);
  console.log(`  卖点：龙头战法 10 条\n`);

  const t0 = Date.now();
  const days = [];
  let triggerDays = 0, triggerCount = 0, candidateSum = 0, scannedDays = 0;

  for (let n = 0; n < rangeIdx.length; n++) {
    const di = rangeIdx[n];
    const dateNum = tradeDates[di];
    if (di < LOOKBACK_DAYS) { continue; } // 需要前三个交易日
    let res = null;
    try { res = await runDay(dateNum, di, tradeDates, opts); } catch (e) {
      console.log(`  ${fmt8(dateNum)} 回测异常：${e.message}`);
      continue;
    }
    scannedDays++;
    if (res) {
      candidateSum += res.candidateCount;
      if (res.triggers.length > 0) {
        triggerDays++;
        triggerCount += res.triggers.length;
        days.push(res);
        const best = res.triggers.reduce((mx, t) => (t.top[0] && t.top[0].returnPct != null && t.top[0].returnPct > (mx ?? -1e9) ? t.top[0].returnPct : mx), null);
        console.log(`  ${res.dateDisplay}  候选 ${res.candidateCount} 只  触发 ${res.triggers.length} 次（${res.triggers.map((t) => t.timeText).join('、')}）  最高收益 ${best != null ? best + '%' : '--'}`);
      } else {
        console.log(`  ${fmt8(dateNum)}  候选 ${res.candidateCount} 只  无触发`);
      }
    } else {
      console.log(`  ${fmt8(dateNum)}  跳过（无候选池或无指数分时）`);
    }
  }

  const result = {
    fieldDocs: FIELD_DOCS,
    generatedAt: new Date().toISOString(),
    range: { startDate: fmt8(start), endDate: fmt8(end) },
    params: {
      index: INDEX_NAME, lookbackDays: LOOKBACK_DAYS, limitUpPct: LIMIT_UP_PCT,
      earlyBuyMinute: EARLY_BUY_MINUTE,
      topBoards: TOP_BOARDS, maxLianban: MAX_LIANBAN,
      buyChangeRange: [BUY_CHG_MIN, BUY_CHG_MAX],
      rankLimits: { gain3: RANK_GAIN3_MAX, gain5: RANK_GAIN5_MAX, gain10: RANK_GAIN10_MAX, intraday: 1 },
      minM10Gain: MIN_M10_GAIN,
      tailMinute: TAIL_MINUTE, weakHoldDays: WEAK_HOLD_DAYS, weakMinGain: WEAK_MIN_GAIN,
      resilienceMax: RESILIENCE_MAX, maxHoldDays: maxHold, top,
      exclude: '剔除创业板(30)/科创板(688)',
    },
    summary: {
      scannedDays,
      triggerDays,
      triggerCount,
      avgCandidates: scannedDays > 0 ? round2(candidateSum / scannedDays) : null,
      elapsedSec: round2((Date.now() - t0) / 1000),
    },
    days,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(OUT_HTML, buildHtml(result), 'utf-8');

  console.log(`\n完成：触发日 ${triggerDays} 天 / 触发点 ${triggerCount} 个 / 扫描交易日 ${scannedDays} 天 / 耗时 ${result.summary.elapsedSec}s`);
  console.log(`JSON: ${OUT_JSON}`);
  console.log(`HTML: ${OUT_HTML}`);
};

// ===== HTML 生成（数据内嵌，避免 file:// fetch 限制） =====
const buildHtml = (result) => {
  const json = JSON.stringify(result);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>连板龙头 · 择时回测</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--panel2:#1e2230;--line:#2a2f3a;--txt:#e6e9ef;--sub:#9aa4b2;--pos:#33d18b;--neg:#ff5f7a;--acc:#4a9eff;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  .wrap{max-width:1680px;margin:0 auto;padding:24px 20px 60px}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:var(--sub);font-size:13px;margin:0 0 18px}
  .sub b{color:var(--txt)}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0 8px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:150px}
  .card .k{color:var(--sub);font-size:12px}
  .card .v{font-size:20px;font-weight:600;margin-top:4px}
  .day{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-top:20px;overflow:hidden}
  .day-head{display:flex;align-items:center;gap:12px;padding:12px 16px;background:linear-gradient(90deg,#1b2030,#171a21);border-bottom:1px solid var(--line)}
  .day-head .date{font-size:16px;font-weight:700}
  .chip{background:var(--panel2);border:1px solid var(--line);color:var(--sub);border-radius:999px;padding:2px 10px;font-size:12px}
  .tg{padding:14px 16px;border-top:1px solid var(--line)}
  .tg:first-of-type{border-top:none}
  .tg-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .tg-time{font-weight:700;color:var(--acc)}
  .slope-pos{color:var(--pos);font-weight:600}
  .tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
  table{border-collapse:collapse;width:100%;min-width:2250px;font-size:12.5px}
  th,td{padding:7px 10px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}
  th{background:var(--panel2);color:var(--sub);font-weight:600;position:sticky;top:0}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#1c212e}
  .pos{color:var(--pos);font-weight:600}
  .neg{color:var(--neg);font-weight:600}
  .flat{color:var(--sub)}
  .muted{color:var(--sub)}
  .rk{display:inline-block;min-width:20px;text-align:center;border-radius:6px;background:var(--panel2);border:1px solid var(--line);padding:1px 6px;font-weight:600}
  .rk.g1{background:#3a2f0e;border-color:#6b5410;color:#ffd166}
  .rk.g2{background:#2c2f38;border-color:#454b59}
  .rk.g3{background:#3a2a1a;border-color:#6b4620;color:#e0a06a}
  .reason{max-width:360px;white-space:normal;color:var(--sub);font-size:12px}
  .empty{padding:20px 16px;color:var(--sub)}
  .legend{margin-top:10px;color:var(--sub);font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>前五板块 · 首/二板 · 强势分时回测</h1>
  <p class="sub">择时：<b>上证指数 3 日线斜率盘中由负转正</b> 触发买入信号（情绪游资-龙头战法择时），<b>最早 09:40 执行</b>（09:40 前触发顺延至 09:40，已涨停买不进则剔除）；选股：前三个交易日的涨停股，<b>仅取当日涨停数前 5 的板块</b>，<b>首次涨停连板数 ≤ 2</b>（剔除创业板/科创板）；买入过滤：分时涨幅 ∈ [-5%, +5%]、板块内分时涨幅第 1、板块内 3/5 日涨幅 ≤2、10 日涨幅 ≤3、过去 10 分钟涨幅 &gt; 0.2%；卖点：<b>龙头战法 10 条</b>。对每个触发时点列出收益率前 N 名。</p>
  <div id="meta"></div>
  <div id="summary" class="cards"></div>
  <div id="days"></div>
  <div class="legend">
    「收益率」= （卖出价 − 买入价）÷ 买入价 × 100%。<br>
    买入执行：不早于 09:40；09:40 之前触发的买点统一顺延到 09:40 执行（买入时刻与买入价均取该分钟），表中所有「买入时」指标也以该分钟计算；买入时刻该股已涨停（涨幅 &gt; 9.5%，买不进）则剔除、不计入 Top10。<br>
    选股：前三个交易日的涨停股中，仅保留「该交易日涨停个数排名前五」的板块、且首次涨停时连板数 ≤ 2（首板/二板）的股票。<br>
    买入过滤（必须全部满足）：当日分时涨幅 ∈ [-5%, +5%]；板块内当日分时涨幅排名第 1；板块内 3 日涨幅排名 ≤ 2；板块内 5 日涨幅排名 ≤ 2；板块内 10 日涨幅排名 ≤ 3；买入时「过去 10 分钟涨幅」&gt; +0.2%。<br>
    「首次涨停距触发」= 该股在前三个交易日内首次涨停日距触发日的交易日数；「该板块当日排名 / 涨停数」取该股首次涨停当日 lianbanSnapshot 中所属题材的 rank 与 count。<br>
    「买入时N日涨幅（N=3/5/10）」= （买入分钟价 ÷ D−N 收盘价 − 1）× 100%，即前 N 个交易日到买入时点的累计涨幅（含买入当日盘中分时涨幅；D 为触发日）。<br>
    「过去10min涨幅」= （买入分钟价 ÷ 买入前 10 个分时点（约 10 分钟）的价格 − 1）× 100%；不足 10 点时以当日首个分时点为基准。<br>
    「板块内 3/5/10 日涨幅排名 / 分时涨幅排名 / 10min涨幅排名」= 在该股所属板块（首次涨停当日 lianbanSnapshot 该题材的全部涨停股）中，按对应指标从高到低的名次（名次 / 板块内有效样本数）。
  </div>
</div>
<script>
var DATA = ${json};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function pct(v){if(v==null||isNaN(v))return '<span class="flat">--</span>';var c=v>0?'pos':(v<0?'neg':'flat');var s=(v>0?'+':'')+Number(v).toFixed(2)+'%';return '<span class="'+c+'">'+s+'</span>';}
function num(v,dig){if(v==null||isNaN(v))return '<span class="muted">--</span>';return Number(v).toFixed(dig===undefined?2:dig);}
function rk(i){var g=i<=3?' g'+i:'';return '<span class="rk'+g+'">'+i+'</span>';}

var p=DATA.params;
document.getElementById('meta').innerHTML =
  '<div class="sub">区间 <b>'+DATA.range.startDate+'</b> ~ <b>'+DATA.range.endDate+'</b>'+
  ' ｜ ' + p.exclude +
  ' ｜ 尾盘 '+p.tailMinute+' ｜ 弱势持仓第 '+p.weakHoldDays+' 日尾盘 &lt;+'+p.weakMinGain+'% 卖 ｜ 抗分歧 &lt;'+p.resilienceMax+' 卖 ｜ 向后模拟上限 '+p.maxHoldDays+' 个交易日'+
  '<br>生成时间 '+esc(DATA.generatedAt)+'</div>';

var s=DATA.summary;
document.getElementById('summary').innerHTML =
  '<div class="card"><div class="k">扫描交易日</div><div class="v">'+s.scannedDays+'</div></div>'+
  '<div class="card"><div class="k">触发天数</div><div class="v">'+s.triggerDays+'</div></div>'+
  '<div class="card"><div class="k">触发点总数</div><div class="v">'+s.triggerCount+'</div></div>'+
  '<div class="card"><div class="k">日均候选池</div><div class="v">'+(s.avgCandidates==null?'--':s.avgCandidates)+'</div></div>'+
  '<div class="card"><div class="k">耗时(秒)</div><div class="v">'+s.elapsedSec+'</div></div>';

var head=['排名','代码','名称','板块','首次涨停距触发','该板块当日排名','该板块当日涨停数','买入时3日涨幅','板块内3日涨幅排名','买入时5日涨幅','板块内5日涨幅排名','买入时10日涨幅','板块内10日涨幅排名','板块内分时涨幅排名','过去10min涨幅','板块内10min涨幅排名','连板数','买入价','买入涨幅','卖出日','卖出时间','卖出价','持有交易日','收益率','卖出原因'];
function table(t){
  if(!t.top.length) return '<div class="empty">该触发点无通过全部买入过滤条件的股票</div>';
  var h='<div class="tblwrap"><table><thead><tr>'+head.map(function(x){return '<th>'+x+'</th>';}).join('')+'</tr></thead><tbody>';
  t.top.forEach(function(r){
    h+='<tr>'+
      '<td>'+rk(r.rank)+'</td>'+
      '<td>'+esc(r.code)+'</td>'+
      '<td>'+esc(r.name)+'</td>'+
      '<td>'+esc(r.board)+'</td>'+
      '<td>'+r.daysAgo+' 个交易日 <span class="muted">('+esc(r.firstLimitUpDate)+')</span></td>'+
      '<td>'+(r.boardRank==null?'<span class="muted">--</span>':'第 '+r.boardRank+' 名')+'</td>'+
      '<td>'+(r.boardCount==null?'<span class="muted">--</span>':r.boardCount+' 家')+'</td>'+
      '<td>'+pct(r.gain3d)+'</td>'+
      '<td>'+(r.boardGain3dRank==null?'<span class="muted">--</span>':'第 '+r.boardGain3dRank+(r.boardSize?' / '+r.boardSize:'')+' 名')+'</td>'+
      '<td>'+pct(r.gain5d)+'</td>'+
      '<td>'+(r.boardGain5dRank==null?'<span class="muted">--</span>':'第 '+r.boardGain5dRank+(r.boardSize?' / '+r.boardSize:'')+' 名')+'</td>'+
      '<td>'+pct(r.gain10d)+'</td>'+
      '<td>'+(r.boardGain10dRank==null?'<span class="muted">--</span>':'第 '+r.boardGain10dRank+(r.boardSize?' / '+r.boardSize:'')+' 名')+'</td>'+
      '<td>'+(r.boardIntradayRank==null?'<span class="muted">--</span>':'第 '+r.boardIntradayRank+(r.boardSize?' / '+r.boardSize:'')+' 名')+'</td>'+
      '<td>'+pct(r.intraday10Pct)+'</td>'+
      '<td>'+(r.boardIntraday10Rank==null?'<span class="muted">--</span>':'第 '+r.boardIntraday10Rank+(r.boardSize?' / '+r.boardSize:'')+' 名')+'</td>'+
      '<td>'+(r.lianbanCount==null?'<span class="muted">--</span>':r.lianbanCount+' 板')+'</td>'+
      '<td>'+num(r.buyPrice)+'</td>'+
      '<td>'+pct(r.buyChangePct)+'</td>'+
      '<td>'+esc(r.sellDate)+'</td>'+
      '<td>'+esc(r.sellTime)+'</td>'+
      '<td>'+num(r.sellPx)+'</td>'+
      '<td>'+r.holdDays+'</td>'+
      '<td>'+pct(r.returnPct)+'</td>'+
      '<td class="reason">'+esc(r.sellReason)+(r.sold?'':' <span class="muted">[未卖出]</span>')+'</td>'+
    '</tr>';
  });
  return h+'</tbody></table></div>';
}
var out='';
DATA.days.forEach(function(d){
  out+='<div class="day">';
  out+='<div class="day-head"><span class="date">'+esc(d.dateDisplay)+'</span>'+
       '<span class="chip">候选池 '+d.candidateCount+' 只</span>'+
       '<span class="chip">触发 '+d.triggers.length+' 次</span></div>';
  d.triggers.forEach(function(t){
    out+='<div class="tg"><div class="tg-head">'+
      '<span class="tg-time">'+esc(t.timeText)+'</span>'+
      (t.buyTimeText && t.buyMinute!==t.minute?'<span class="chip">买入顺延至 '+esc(t.buyTimeText)+'</span>':'')+
      '<span class="slope-pos">斜率 '+(t.slope>0?'+':'')+Number(t.slope).toFixed(2)+'</span>'+
      '<span class="chip">可买 '+t.buyableCount+' 只</span>'+
      '<span class="chip">通过过滤 '+t.passCount+' 只</span>'+
      '<span class="chip">有效评估 '+t.evaluatedCount+' 只</span>'+
      '</div>'+table(t)+'</div>';
  });
  out+='</div>';
});
document.getElementById('days').innerHTML = out || '<div class="empty">区间内无触发点</div>';
</script>
</body>
</html>`;
};

main().catch((err) => {
  console.error('执行失败:', err && err.message ? err.message : err);
  process.exit(1);
});
