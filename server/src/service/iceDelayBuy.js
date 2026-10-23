// 冰点转折延时买入（线上实盘同步，2026-10-23 用户新增）
//   规则对齐回测「快进快出」系列：连续两日冰点（上一交易日 hasIce + 当日分时科技情绪 ≤ TECH_ICE_THRESHOLD）
//   时，买点触发后不立即给出个股，先延时 15 分钟观察资金是否聚焦主线板块，再按「板块区间涨幅差」选股：
//     delta(板块) = 当前板块平均涨幅 − 触发时点前 5 分钟板块平均涨幅
//   板块范围：中性 / 进攻；只买板块成分股与科技自选股的交集，板块内按 3 日涨幅降序取第一只；
//   所有板块均选不出时回退全量科技自选股（与回测一致）。
//   - 由 buyPointPushService 的 10s tick 驱动（不用 setTimeout，重启可恢复）
//   - 延时到点若落在午休（11:30–13:00）则顺延到 13:00 执行；不受 13:30 买入时段限制
//   - 触发 / 到点均发飞书；触发时广播 ice_delay_wait，到点广播 buy_point（data.iceDelay.phase='ready'）
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const wsServer = require('../wsServer');
const { getAllTechIndexData, getTechEmotionIntraday } = require('./emotion');
const { getBlockData, getBlockHistory } = require('./block');
const { getTopGainersByMarket } = require('./buySellDiagnose');
const { notifyBuyPointFeishu } = require('./buyPointNotifier');
const feishuNotify = require('./feishuNotify');
const { TECH_ICE_THRESHOLD } = require('./buySellBacktest/constants');
const { getPrevTradingDay } = require('../utils/tradingDay');

const DELAY_MIN = 15;
// 回溯起点 = 触发时点 − 5 分钟；终点 = 触发 + 15 分钟，两者相隔 20 分钟
const LOOKBACK_MIN = 20;
const BLOCK_TAGS = ['中性', '进攻'];
const statePath = path.resolve(__dirname, '../data/ice_delay_buy_state.json');

const MODE_LABELS = {
  tech_attack: '科技进攻',
  hot_money_extreme_win: '情绪游资',
  attack_defense: '攻防兼备',
};

let pending = null; // { date, mode, source, triggerTime, triggerBucket, executeAt, executeAtTs, startMap }
let lastTrigger = null; // { date, bucket } —— 同一桶只触发一次
let doneDate = null; // 当日已完成延时买入（避免同日重复触发）
let executing = false; // 到点选股 + 推送期间加锁

const todayStr = () => dayjs().format('YYYYMMDD');

const readState = () => {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
};

const writeState = () => {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ pending, lastTrigger, doneDate }, null, 2));
  } catch (e) {
    console.error('写入冰点转折延时买入状态失败:', e.message);
  }
};

// 启动时恢复：仅恢复当日状态（跨日自动丢弃）
const load = () => {
  const s = readState();
  const today = todayStr();
  doneDate = s.doneDate === today ? today : null;
  lastTrigger = s.lastTrigger && s.lastTrigger.date === today ? s.lastTrigger : null;
  pending = s.pending && s.pending.date === today ? s.pending : null;
};

load();

// 冰点转折判定：上一交易日 hasIce: true，且当日分时科技情绪任一点 ≤ 冰点阈值
const isIceTransition = () => {
  try {
    const prevDateStr = dayjs(getPrevTradingDay()).format('YYYYMMDD');
    const rows = getAllTechIndexData() || [];
    const prev = rows.find((r) => r && String(r.date) === prevDateStr);
    if (!prev || prev.hasIce !== true) return false;
    const { data } = getTechEmotionIntraday();
    const records = (data && data[todayStr()]) || [];
    return records.some((r) => r && r.value != null && Number(r.value) <= TECH_ICE_THRESHOLD);
  } catch (e) {
    console.error('冰点转折判定失败:', e.message);
    return false;
  }
};

// 触发时点前 5 分钟的板块涨幅快照（板块历史每分钟一条，time 为 HH:mm）
const captureStartMap = (now = dayjs()) => {
  const target = now.subtract(5, 'minute').format('HH:mm');
  const map = {};
  try {
    const history = getBlockHistory() || [];
    let snap = null;
    for (const row of history) {
      if (row && row.time && row.time <= target) snap = row;
    }
    if (snap && Array.isArray(snap.blockData)) {
      snap.blockData.forEach((b) => {
        if (b && b.blockName && b.avgChange != null) map[b.blockName] = Number(b.avgChange);
      });
    }
    if (Object.keys(map).length === 0) {
      (getBlockData() || []).forEach((b) => {
        if (b && b.blockName && b.avgChange != null) map[b.blockName] = Number(b.avgChange);
      });
    }
  } catch (e) {
    console.error('获取板块回溯快照失败:', e.message);
  }
  return map;
};

// 计划买入时间：触发 + 15 分钟；落在午休（11:30–13:00）则顺延到 13:00
const computeExecuteAt = (triggerAt) => {
  let t = triggerAt.add(DELAY_MIN, 'minute');
  const hm = Number(t.format('HHmm'));
  if (hm > 1130 && hm < 1300) {
    t = t.hour(13).minute(0).second(0).millisecond(0);
  }
  return t;
};

const hasPending = () => pending != null;

// 是否允许在指定桶触发：无进行中的延时、当日未完成、且该桶未触发过
const canTrigger = (bucket) => {
  if (bucket == null) return false;
  if (pending) return false;
  if (doneDate === todayStr()) return false;
  if (lastTrigger && lastTrigger.date === todayStr() && lastTrigger.bucket === bucket) return false;
  return true;
};

// 当日已进入冰点转折延时模式（等待中 / 已完成 / 今日已触发过）：
// 该日后续普通科技买点通知一律抑制，避免延时买入后又立刻弹普通买入卡片形成重复提示
const shouldSuppressTech = () => {
  if (pending) return true;
  if (doneDate === todayStr()) return true;
  return !!(lastTrigger && lastTrigger.date === todayStr());
};

// 买点命中且属冰点转折：开始 15 分钟计时，返回 true 表示调用方应抑制普通买点通知
const trigger = async ({ mode, bucket } = {}) => {
  const now = dayjs();
  const executeAt = computeExecuteAt(now);
  pending = {
    date: todayStr(),
    mode,
    source: 'tech',
    triggerTime: now.format('HH:mm'),
    triggerBucket: bucket,
    executeAt: executeAt.format('HH:mm'),
    executeAtTs: executeAt.valueOf(),
    startMap: captureStartMap(now),
  };
  lastTrigger = { date: todayStr(), bucket };
  writeState();

  const message = `冰点转折：买点已触发，需延时 ${DELAY_MIN} 分钟观察资金聚焦主线板块后再执行买入`;
  wsServer.broadcast({
    type: 'ice_delay_wait',
    mode,
    bucket,
    ts: Date.now(),
    open: true,
    data: {
      phase: 'wait',
      source: 'tech',
      delayMin: DELAY_MIN,
      triggerTime: pending.triggerTime,
      executeTime: pending.executeAt,
      message,
    },
  });

  try {
    await feishuNotify.sendFeishuText(
      `⏳【冰点转折·延时观察】\n模式：${MODE_LABELS[mode] || mode}\n买点触发：${pending.triggerTime}\n计划买入：${pending.executeAt}（延时 ${DELAY_MIN} 分钟）\n${message}`,
    );
  } catch (e) {
    console.error('冰点转折延时观察飞书发送失败:', e.message);
  }
  console.log(`[冰点转折] ${pending.triggerTime} 触发延时观察，计划 ${pending.executeAt} 执行买入`);
  return true;
};

const toStockRow = (s, boardName) => ({
  code: s.code,
  stockName: s.stockName,
  name: s.stockName,
  market: s.isSh688 ? '科创板' : '创业板/主板',
  blockName: s.blockName || boardName || null,
  change: s.change,
  change3d: s.change3d,
  resilienceScore: s.resilienceScore,
  isLimitUp: false,
  matchesBuyPoint: true,
  isCandidate: true,
  isTechPick: true,
});

// 到点选股：板块区间涨幅差降序 → 板块成分股 ∩ 可买池 → 3 日涨幅最大；全失败回退全量可买池
const resolveDelayedPick = async (startMap = {}) => {
  const blocks = (getBlockData() || []).filter((b) => b && BLOCK_TAGS.includes(b.tag) && Array.isArray(b.data));
  const candidates = blocks
    .map((b) => {
      const start = startMap[b.blockName];
      const startChange = typeof start === 'number' && Number.isFinite(start) ? start : null;
      const delta = startChange == null ? null : Number((Number(b.avgChange) - startChange).toFixed(2));
      return { blockName: b.blockName, avgChange: Number(b.avgChange), startChange, delta, data: b.data };
    })
    .filter((c) => c.delta != null)
    .sort((a, b) => b.delta - a.delta);

  let rows = [];
  try {
    const res = await getTopGainersByMarket(null, 1000);
    const d = res?.data || {};
    rows = [...(d.markets?.cybMain || []), ...(d.markets?.star || [])];
  } catch (e) {
    console.error('冰点转折延时选股获取榜单失败:', e.message);
  }

  const byCode = new Map();
  for (const s of rows) {
    if (s && s.code && !byCode.has(s.code)) byCode.set(s.code, s);
  }
  const byChange3d = (a, b) => (b.change3d ?? -Infinity) - (a.change3d ?? -Infinity);
  // 可买池：满足买点资格、非昨日一字板、未封涨停（matchesBuyPoint 已含指数门禁 / 抗分歧 / 估值）
  const buyable = [...byCode.values()]
    .filter((s) => s.matchesBuyPoint === true && s.prevOneWord !== true && s.isLimitUp !== true)
    .sort(byChange3d);
  const buyableMap = new Map(buyable.map((s) => [s.code, s]));

  for (const c of candidates) {
    const hits = [];
    for (const m of c.data) {
      if (!m || !m.code) continue;
      const row = buyableMap.get(m.code);
      if (row) hits.push(row);
    }
    if (hits.length === 0) continue;
    hits.sort(byChange3d);
    return {
      stock: toStockRow(hits[0], c.blockName),
      board: c.blockName,
      fallback: false,
      delta: c.delta,
      reason: `资金聚焦板块「${c.blockName}」（区间涨幅差 ${c.delta > 0 ? '+' : ''}${c.delta}%），板块内 3 日涨幅最大且满足买点条件`,
    };
  }

  if (buyable.length > 0) {
    return {
      stock: toStockRow(buyable[0], null),
      board: null,
      fallback: true,
      delta: null,
      reason: '各板块交集中均无可买标的，回退全量科技自选股取 3 日涨幅最大者',
    };
  }
  return {
    stock: null,
    board: null,
    fallback: true,
    delta: null,
    reason: '全量科技自选股当前无满足买点条件的可买标的',
  };
};

// 到点推送数据：保留触发时最近一次诊断（供卡片展示仓位 / 理由）+ 冰点转折说明 + 买入标的
const buildReadyData = (p, data, pick) => {
  const iceDelay = {
    phase: 'ready',
    source: 'tech',
    delayMin: DELAY_MIN,
    triggerTime: p.triggerTime,
    executeTime: p.executeAt,
    board: pick.board,
    fallback: pick.fallback,
    reason: pick.reason,
  };
  let base;
  if (p.mode === 'attack_defense') {
    // 攻防兼备：只展示科技进攻这条腿（本次延时买入由科技腿触发）
    base = {
      ...(data || {}),
      tech: { ...((data && data.tech) || {}), allPassed: true },
      allPassed: false,
      reverse: { allPassed: false },
      reverseChecks: [],
    };
  } else {
    base = { ...(data || {}), allPassed: true };
  }
  return { ...base, iceDelay, buyable: pick.stock ? [pick.stock] : [] };
};

// 到点执行：选股 → 广播 buy_point（前端直接展示 buyable）→ 飞书买点卡片
const tick = async ({ data = null } = {}) => {
  if (!pending || executing) return false;
  if (Date.now() < pending.executeAtTs) return false;
  executing = true;
  const p = pending;
  try {
    // 先落盘清空，避免推送异常导致重复执行
    pending = null;
    doneDate = todayStr();
    writeState();

    const pick = await resolveDelayedPick(p.startMap);
    const payload = buildReadyData(p, data, pick);
    wsServer.broadcast({ type: 'buy_point', mode: p.mode, bucket: p.triggerBucket, ts: Date.now(), data: payload, open: true });

    if (pick.stock) {
      try {
        await notifyBuyPointFeishu({ mode: p.mode, source: 'tech', buyStocks: [pick.stock] });
      } catch (e) {
        console.error('冰点转折延时买入飞书发送失败:', e.message);
      }
    } else {
      try {
        await feishuNotify.sendFeishuText(`⚠️【冰点转折·延时买入】\n延时 ${DELAY_MIN} 分钟观察结束（${p.triggerTime} → ${p.executeAt}），${pick.reason}`);
      } catch (e) {
        console.error('冰点转折延时买入无标的提醒发送失败:', e.message);
      }
    }
    console.log(`[冰点转折] ${p.executeAt} 延时观察结束，${pick.stock ? `买入 ${pick.stock.stockName}（${pick.stock.code}）` : '无可买标的'}`);
    return true;
  } catch (e) {
    console.error('冰点转折延时买入执行异常:', e.message);
    return false;
  } finally {
    executing = false;
  }
};

module.exports = {
  DELAY_MIN,
  LOOKBACK_MIN,
  isIceTransition,
  canTrigger,
  shouldSuppressTech,
  trigger,
  tick,
  hasPending,
  computeExecuteAt,
};
