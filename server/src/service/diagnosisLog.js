// 买点 / 卖点诊断落盘日志
//   - 目录：server/src/data/logs/buy_and_sell_diagnoise
//   - 每天一个文件：YYYYMMDD.jsonl（一行一条 JSON，便于 grep / jq 排查）
//   - 不论是否命中，每个诊断周期都写一条；只保留最近 30 天
//   - 记录诊断模式、时间桶、命中结果、条件摘要、个股摘要、耗时与异常
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const LOG_DIR = path.resolve(__dirname, '../data/logs/buy_and_sell_diagnoise');
const KEEP_DAYS = 30;

let lastPruneDate = null;

const ensureDir = () => {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    // 日志目录不可写时不影响诊断主流程
  }
};

// 清理超过保留天数的日志（每天最多执行一次）
const pruneOldLogs = (todayNum) => {
  if (lastPruneDate === todayNum) return;
  lastPruneDate = todayNum;
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = dayjs(todayNum, 'YYYYMMDD').subtract(KEEP_DAYS, 'day');
    for (const name of fs.readdirSync(LOG_DIR)) {
      const m = name.match(/^(\d{8})\.(jsonl|log)$/);
      if (!m) continue;
      const day = dayjs(m[1], 'YYYYMMDD');
      if (!day.isValid()) continue;
      if (day.isBefore(cutoff, 'day')) {
        try { fs.unlinkSync(path.join(LOG_DIR, name)); } catch (e) { /* 忽略 */ }
      }
    }
  } catch (e) {
    // 清理失败不影响写入
  }
};

const clip = (v, max = 800) => {
  if (v == null) return null;
  const text = typeof v === 'string' ? v : String(v);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// 条件摘要（买点 checks）
const summarizeChecks = (checks) => {
  if (!Array.isArray(checks)) return [];
  return checks.map((c) => ({
    id: c && c.id,
    title: clip(c && c.title, 120),
    passed: !!(c && c.passed),
    exempted: !!(c && c.exempted),
    value: clip(c && c.value, 240),
    reason: clip(c && c.reason, 500),
  }));
};

// 个股摘要
const summarizeStocks = (stocks) => {
  if (!Array.isArray(stocks)) return [];
  return stocks.map((s) => ({
    code: s && s.code,
    name: s && (s.stockName || s.name),
    change: s && s.change != null ? s.change : null,
    change3d: s && s.change3d != null ? s.change3d : null,
    resilienceScore: s && s.resilienceScore != null ? s.resilienceScore : null,
    strengthScore: s && s.strengthScore != null ? s.strengthScore : null,
    diffScore: s && s.diffScore != null ? s.diffScore : null,
    delta: s && s.delta != null ? s.delta : null,
    isReverse: !!(s && s.isReverse),
    source: s && s.source,
  }));
};

const writeLine = (type, payload) => {
  try {
    ensureDir();
    const now = dayjs();
    const dateNum = now.format('YYYYMMDD');
    pruneOldLogs(dateNum);
    const file = path.join(LOG_DIR, `${dateNum}.jsonl`);
    const record = {
      ts: now.format('YYYY-MM-DD HH:mm:ss.SSS'),
      type,
      ...payload,
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (e) {
    console.error('写入买卖点诊断日志失败:', e.message);
  }
};

// 买点诊断日志
//   payload: { mode, bucket, hit, sources, checks, reverseChecks, stocks, stockEmptyReason, durationMs, error, note }
const logBuy = (payload = {}) => {
  const { checks, techChecks, reverseChecks, stocks, ...rest } = payload;
  writeLine('buy', {
    mode: rest.mode || null,
    bucket: rest.bucket != null ? rest.bucket : null,
    hit: rest.hit === true,
    sources: Array.isArray(rest.sources) ? rest.sources : [],
    stockCount: Array.isArray(stocks) ? stocks.length : 0,
    stocks: summarizeStocks(stocks),
    stockEmptyReason: clip(rest.stockEmptyReason, 500),
    checks: summarizeChecks(checks),
    techChecks: summarizeChecks(techChecks),
    reverseChecks: summarizeChecks(reverseChecks),
    durationMs: rest.durationMs != null ? rest.durationMs : null,
    error: clip(rest.error, 500),
    note: clip(rest.note, 500),
  });
};

// 卖点诊断日志
//   payload: { mode, bucket, results, hitCount, total, durationMs, error }
const logSell = (payload = {}) => {
  const results = Array.isArray(payload.results) ? payload.results : [];
  writeLine('sell', {
    mode: payload.mode || null,
    bucket: payload.bucket != null ? payload.bucket : null,
    hit: Number(payload.hitCount) > 0,
    hitCount: payload.hitCount != null ? payload.hitCount : results.filter((r) => r && r.isSell === true).length,
    total: payload.total != null ? payload.total : results.length,
    positions: results.map((r) => ({
      positionId: r && r.positionId,
      code: r && r.code,
      stockName: r && r.stockName,
      buyDate: r && r.buyDate,
      costPrice: r && r.costPrice,
      strategy: r && r.sellStrategy,
      isSell: !!(r && r.isSell === true),
      buyToday: !!(r && r.buyToday),
      reasons: Array.isArray(r && r.reasons) ? r.reasons.map((x) => clip(x, 200)) : [],
      error: clip(r && r.error, 300),
    })),
    durationMs: payload.durationMs != null ? payload.durationMs : null,
    error: clip(payload.error, 500),
  });
};

// 情绪游资-极致赔率诊断日志（每 3s 一轮，记录候选池与命中摘要）
//   payload: { date, firstBoardCount, secondBoardCount, rows, durationMs, error, note }
const logWashFusion = (payload = {}) => {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  writeLine('wash_fusion', {
    date: payload.date || null,
    mode: 'wash_fusion_extreme_odds',
    firstBoardCount: payload.firstBoardCount != null ? payload.firstBoardCount : 0,
    secondBoardCount: payload.secondBoardCount != null ? payload.secondBoardCount : 0,
    stockCount: rows.length,
    stocks: summarizeStocks(rows.map((r) => ({ ...r, name: r.name || r.stockName }))),
    durationMs: payload.durationMs != null ? payload.durationMs : null,
    error: clip(payload.error, 500),
    note: clip(payload.note, 500),
  });
};

module.exports = { logBuy, logSell, logWashFusion, LOG_DIR, KEEP_DAYS };
