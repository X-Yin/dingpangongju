// 买点诊断后端集中调度（每 10s 一次）
//   - 每 10s 计算一次诊断，经 WebSocket 广播给所有前端（卡片/抽屉实时刷新，前端不再轮询）
//   - 命中且进入新的 5 分钟时间桶时（每桶最多一次）：后端发飞书 + 额外广播 open:true 让前端开抽屉/弹窗
//   - 5 分钟桶标签口径严格对齐回测（见 buyPointBuckets.js）
//   - 例外（2026-10-31 用户要求）：「情绪游资-极致胜率」（MODE_EXTREME_WIN）与「科技进攻-情绪游资-极致胜率」
//     （MODE_ATTACK_DEFENSE）的情绪游资腿，买点诊断只在 3 的整数倍分钟（9:30 / 9:33 / 9:36 … 11:30、
//     13:00 / 13:03 … 15:00）执行与命中（后端仍每 10s 轮询，非整数分钟不产生新命中）；其余模式维持 10s 一次
//   - 非交易日 / 午休 / 收盘后不发；幂等状态落盘，重启同桶不重复发
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils');
const { getCurrentClosedBucket } = require('./buyPointBuckets');
const strategyModeState = require('./strategyModeState');
const wsServer = require('../wsServer');
const { notifyBuyPointFeishu } = require('./buyPointNotifier');
const { getBuyPointChecks } = require('./buySellDiagnose');
const { getExtremeWinBuyPointChecks, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE, ATTACK_DEFENSE_BUY_CUTOFF_MINUTE } = require('./hotMoneyExtremeWin');
const iceDelayBuy = require('./iceDelayBuy');

const INTERVAL_MS = 10 * 1000;
const statePath = path.resolve(__dirname, '../data/buy_point_notify_state.json');

let timer = null;
let running = false;
let lastNotifiedBucket = null;
// 攻防兼备分源桶门控：科技进攻(tech)与情绪游资(ew)各自独立记桶（每桶每源至多一次通知）
let lastNotifiedBuckets = { tech: null, ew: null };
let lastBlockedBucket = null; // 买点屏蔽通知独立桶门控（快进快出强卖当日禁买）

const readState = () => {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
};

const writeState = (obj) => {
  try {
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('写入买点通知状态失败:', e.message);
  }
};

// 启动时恢复「今日已通知到的桶」，避免同桶内重启重复发送
const loadLastNotifiedBucket = () => {
  const s = readState();
  const today = dayjs().format('YYYYMMDD');
  const sameDay = s && s.date === today;
  lastNotifiedBucket = sameDay && s.bucket != null ? s.bucket : null;
  lastBlockedBucket = sameDay && s.blockedBucket != null ? s.blockedBucket : null;
  // 攻防兼备分源恢复：优先读 buckets；仅有旧单桶字段时保守视为两源均已通知到该桶
  if (sameDay && s.buckets && typeof s.buckets === 'object') {
    lastNotifiedBuckets = { tech: s.buckets.tech ?? null, ew: s.buckets.ew ?? null };
  } else if (sameDay && s.bucket != null) {
    lastNotifiedBuckets = { tech: s.bucket, ew: s.bucket };
  } else {
    lastNotifiedBuckets = { tech: null, ew: null };
  }
};

// 买点屏蔽检测（快进快出强卖当日禁买，2026-10-19 新增）：当日已有「情绪快进快出 10:00 强制卖出」
// 记录时买点诊断的 quick_out_no_rebuy 检查不通过（与回测 emoquick 策略「强卖当日禁止二次买入」对齐）。
// 若除该拦截项（及提示项）外其余前置条件全部通过，说明买点本应命中、仅被该规则屏蔽，
// 返回屏蔽信息供推送 buy_point_blocked；其余条件也有失败时属「买点本来就不命中」，不算屏蔽。
const detectQuickOutBlock = (data) => {
  if (!data || data.allPassed !== false) return null;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const noRebuy = checks.find((c) => c && c.id === 'quick_out_no_rebuy');
  if (!noRebuy || noRebuy.passed !== false) return null;
  const otherFailed = checks.filter((c) => c && c.passed === false
    && c.id !== 'quick_out_no_rebuy' && c.id !== 'quick_out_buy_hint');
  if (otherFailed.length > 0) return null;
  return {
    reason: noRebuy.reason || '当日已发生情绪快进快出 10:00 强制卖出，当日禁止二次买入，买点诊断不命中',
    value: noRebuy.value || null,
    failedChecks: otherFailed.map((c) => c.id),
  };
};

// 推送时间窗：非交易日不发；9:30 前不发；15:00 后不发；午休（11:31-12:59）不发。
// 注意：11:30 那一分钟仍运行，以捕获回测口径中的 11:30 桶。
const isInPushWindow = (date = new Date()) => {
  if (!isTradingDay(date)) return false;
  const m = date.getHours() * 60 + date.getMinutes();
  if (m < 9 * 60 + 30) return false;
  if (m > 15 * 60) return false;
  if (m >= 11 * 60 + 31 && m < 13 * 60) return false;
  return true;
};

const runDiagnosis = (mode, ewEvalNow = true) => {
  if (mode === MODE_ATTACK_DEFENSE) {
    // 攻防兼备：双策略并行诊断，组合 data = 情绪游资顺周期（顶层）+ tech 字段（科技进攻完整诊断）
    //   情绪游资腿只在 3 的整数倍分钟才允许命中（非整数分钟抑制命中，科技腿不受影响）
    return Promise.all([
      getBuyPointChecks(null, true, false),
      getExtremeWinBuyPointChecks(null, true, ATTACK_DEFENSE_BUY_CUTOFF_MINUTE),
    ]).then(([techRes, ewRes]) => {
      const ewData = ewRes?.data || {};
      return {
        data: {
          ...(ewEvalNow ? ewData : suppressEwBuyHit(ewData)),
          tech: techRes?.data || null,
          mode: MODE_ATTACK_DEFENSE,
        },
      };
    });
  }
  return getBuyPointChecks(null, true, false);
};

// ============================================================
// 「情绪游资-极致胜率」买点诊断执行门禁（2026-10-31 用户要求，线上两个模式同步）：
//   后端仍是每 10s 轮询，但买点诊断「命中」只允许在 3 的整数倍分钟评估/触发——
//   9:30 / 9:33 / 9:36 … 11:30、13:00 / 13:03 … 15:00（自 0 点起分钟数为 3 的倍数）；
//   非整数分钟不重新执行诊断，直接复用最近一次整数分钟的结果（命中标记同样保持，不会在非整数分钟新命中）
// ============================================================
const buildEwEvalMinutes = () => {
  const set = new Set();
  for (let m = 9 * 60 + 30; m <= 11 * 60 + 30; m += 3) set.add(m);
  for (let m = 13 * 60; m <= 15 * 60; m += 3) set.add(m);
  return set;
};
const EW_BUY_EVAL_MINUTES = buildEwEvalMinutes();
let ewBuyEvalDate = null;
let lastEwBuyData = null;

// 非整数分钟（当日尚无缓存）的展示兜底：算一份结果但不允许命中
const suppressEwBuyHit = (d) => {
  if (!d) return d;
  return {
    ...d,
    allPassed: false,
    reverse: d.reverse ? { ...d.reverse, allPassed: false, triggeredCount: 0, triggered: [] } : d.reverse,
    hitGate: '当前非 3 分钟整数分钟，买点命中暂不评估（9:30 / 9:33 / 9:36 … 等 3 的整数倍分钟才判定）',
  };
};

const runExtremeWinBuyDiagnosis = async (now) => {
  const today = dayjs().format('YYYYMMDD');
  if (ewBuyEvalDate !== today) {
    ewBuyEvalDate = today;
    lastEwBuyData = null;
  }
  const m = now.getHours() * 60 + now.getMinutes();
  if (EW_BUY_EVAL_MINUTES.has(m)) {
    const res = await getExtremeWinBuyPointChecks(null, true);
    lastEwBuyData = res && res.data ? res.data : null;
    return lastEwBuyData;
  }
  if (lastEwBuyData != null) return lastEwBuyData;
  const res = await getExtremeWinBuyPointChecks(null, true);
  lastEwBuyData = suppressEwBuyHit(res && res.data ? res.data : null);
  return lastEwBuyData;
};

// 攻防兼备状态落盘：同时保留单桶字段（旧逻辑兼容）与分源 buckets 字段
const writeDefenseState = (mode, bucket) => {
  writeState({
    date: dayjs().format('YYYYMMDD'),
    bucket,
    buckets: { ...lastNotifiedBuckets },
    blockedBucket: lastBlockedBucket,
    mode,
  });
};

// 攻防兼备 tick：双策略分源桶门控——科技进攻(tech)与情绪游资(ew)各自独立判定命中与通知（每桶每源至多一次），
// 任一源命中新桶即广播 open:true；tech 源的快进快出强卖当日禁买屏蔽检测独立生效（不遮蔽 ew 源）
const tickAttackDefense = async (mode, data, bucket, ewBucket = null) => {
  const techData = data.tech || null;
  const techBlocked = detectQuickOutBlock(techData);
  const techHit = !techBlocked && techData != null && techData.allPassed === true;
  // 情绪游资腿只在 3 的整数倍分钟（ewBucket 非空）才允许命中与通知
  const ewHit = ewBucket != null && (data.allPassed === true
    || (data.reverse && data.reverse.allPassed === true));

  // tech 屏蔽（其余前置条件全部通过但被禁买拦截）且 ew 未命中时，推买点屏蔽通知（独立桶门控，每桶一次）
  if (techBlocked && !ewHit && bucket != null && lastBlockedBucket !== bucket) {
    lastBlockedBucket = bucket;
    writeDefenseState(mode, bucket);
    wsServer.broadcast({
      type: 'buy_point_blocked',
      mode,
      bucket,
      ts: Date.now(),
      open: true, // 实时推送才弹窗；前端晚挂载补发时 open 被去掉，不重复弹
      data: {
        ...techBlocked,
        strategy: 'highest_3d_gain_emoquick',
        strategyName: '3日涨幅最大&三日情绪-30快进快出',
      },
    });
    console.log(`[买点屏蔽] 桶 ${bucket} 科技进攻买点命中被快进快出强卖当日禁买规则拦截：${techBlocked.reason}`);
  }

  if (bucket == null && ewBucket == null) return;

  const techNewBucket = bucket != null && techHit && lastNotifiedBuckets.tech !== bucket;
  const ewNewBucket = ewBucket != null && ewHit && lastNotifiedBuckets.ew !== ewBucket;
  if (!techNewBucket && !ewNewBucket) return;

  // 冰点转折延时买入（2026-10-23）：科技腿命中且属冰点转折时，不立即通知买入，
  // 改为延时 15min 观察资金聚焦主线板块，到点由 iceDelayBuy.tick 推送个股
  const iceTriggered = techNewBucket && iceDelayBuy.canTrigger(bucket) && iceDelayBuy.isIceTransition();
  // 当日已进入冰点转折延时模式：科技腿后续普通买点通知一律抑制
  const techSuppressed = iceTriggered || iceDelayBuy.shouldSuppressTech();

  if (techNewBucket) lastNotifiedBuckets.tech = bucket;
  if (ewNewBucket) lastNotifiedBuckets.ew = ewBucket;
  writeDefenseState(mode, bucket);
  // 广播用的桶键：情绪游资腿命中且科技桶未闭合时（如 9:30 / 9:33）用 3 分钟整数分钟 HHMM
  const msgBucket = bucket != null ? bucket : ewBucket;

  if (iceTriggered) {
    try {
      await iceDelayBuy.trigger({ mode, bucket });
    } catch (e) {
      console.error('冰点转折延时触发失败:', e.message);
    }
  } else if (techNewBucket && !techSuppressed) {
    try {
      await notifyBuyPointFeishu({ mode, source: 'tech' });
    } catch (e) {
      console.error('科技进攻买点飞书发送失败:', e.message);
    }
  }
  if (ewNewBucket) {
    try {
      await notifyBuyPointFeishu({ mode, source: 'ew' });
    } catch (e) {
      console.error('情绪游资买点飞书发送失败:', e.message);
    }
  }
  if (techSuppressed) {
    // 科技腿已转为延时观察（或当日已完成延时买入）：仅情绪游资同时命中时才广播买点卡片（且只展示情绪游资腿）
    if (ewNewBucket) {
      wsServer.broadcast({
        type: 'buy_point',
        mode,
        bucket: msgBucket,
        ts: Date.now(),
        data: { ...data, tech: data.tech ? { ...data.tech, allPassed: false } : null },
        open: true,
      });
    }
    return;
  }
  wsServer.broadcast({ type: 'buy_point', mode, bucket: msgBucket, ts: Date.now(), data, open: true });
};

const tick = async () => {
  if (running) return; // 上一 tick 未完成则跳过，避免重入
  running = true;
  try {
    const now = new Date();
    if (!isInPushWindow(now)) return;

    const mode = strategyModeState.getMode();
    const ewMinute = now.getHours() * 60 + now.getMinutes();
    // 情绪游资腿（极致胜率 / 攻防兼备）只在 3 的整数倍分钟允许命中
    const ewEvalNow = (mode === MODE_EXTREME_WIN || mode === MODE_ATTACK_DEFENSE)
      && EW_BUY_EVAL_MINUTES.has(ewMinute);
    const res = mode === MODE_EXTREME_WIN
      ? { data: await runExtremeWinBuyDiagnosis(now) }
      : await runDiagnosis(mode, ewEvalNow);
    const data = res && res.data ? res.data : null;
    // 命中门控用的桶键：情绪游资腿在 3 的整数倍分钟用「当前分钟 HHMM」（9:30 / 9:33 无闭合桶也能命中通知、
    //   每个整数分钟至多通知一次）；其余情形沿用 5min 闭合桶标签
    const bucket = mode === MODE_EXTREME_WIN
      ? (ewEvalNow ? now.getHours() * 100 + now.getMinutes() : getCurrentClosedBucket(now))
      : getCurrentClosedBucket(now);
    const ewBucket = ewEvalNow ? now.getHours() * 100 + now.getMinutes() : null;

    // 冰点转折延时买入到点：达到 15min 延时目标后选股并推送买入标的（13:30 之后同样执行；
    // 即使本轮诊断失败也按时执行，避免错过买入时点）
    try {
      await iceDelayBuy.tick({ data });
    } catch (e) {
      console.error('冰点转折延时买入任务异常:', e.message);
    }

    if (!data) return;

    // 1) 每 10s 广播诊断结果（仅供前端展示，不触发打开）
    wsServer.broadcast({ type: 'buy_point', mode, bucket, ts: Date.now(), data, open: false });

    // 攻防兼备：双策略分源桶门控 + 分源飞书通知，独立于单模式逻辑
    if (mode === MODE_ATTACK_DEFENSE) {
      await tickAttackDefense(mode, data, bucket, ewBucket);
      return;
    }

    // 情绪游资-极致胜率：命中通知只允许在 3 的整数倍分钟（非整数分钟仅广播展示、不再命中通知）
    if (mode === MODE_EXTREME_WIN && !ewEvalNow) return;

    // 2) 买点屏蔽（快进快出强卖当日禁买）：其余前置条件全部通过但被该规则拦截时，抑制买点命中
    //    通知与飞书，改为推送 buy_point_blocked 屏蔽通知（每桶最多一次）
    const block = detectQuickOutBlock(data);
    if (block) {
      if (bucket != null && lastBlockedBucket !== bucket) {
        lastBlockedBucket = bucket;
        writeState({ date: dayjs().format('YYYYMMDD'), bucket, mode, blockedBucket: bucket });
        wsServer.broadcast({
          type: 'buy_point_blocked',
          mode,
          bucket,
          ts: Date.now(),
          open: true, // 实时推送才弹窗；前端晚挂载补发时 open 被去掉，不重复弹
          data: {
            ...block,
            strategy: 'highest_3d_gain_emoquick',
            strategyName: '3日涨幅最大&三日情绪-30快进快出',
          },
        });
        console.log(`[买点屏蔽] 桶 ${bucket} 买点命中被快进快出强卖当日禁买规则拦截：${block.reason}`);
      }
      return;
    }

    // 3) 桶门控命中：命中且进入新的合法桶时，发飞书 + 额外广播 open:true（每桶最多一次）
    const canonicalHit = data.allPassed === true
      || (data.reverse && data.reverse.allPassed === true);
    if (bucket == null || !canonicalHit) return;

    // 冰点转折延时买入（2026-10-23）：科技进攻模式命中且属冰点转折时，不立即通知买入，
    // 改为延时 15min 观察资金聚焦主线板块，到点由 iceDelayBuy.tick 推送个股
    if (mode === strategyModeState.MODE_TECH_ATTACK && iceDelayBuy.canTrigger(bucket) && iceDelayBuy.isIceTransition()) {
      lastNotifiedBucket = bucket;
      writeState({ date: dayjs().format('YYYYMMDD'), bucket, mode });
      try {
        await iceDelayBuy.trigger({ mode, bucket });
      } catch (e) {
        console.error('冰点转折延时触发失败:', e.message);
      }
      return;
    }

    // 当日已进入冰点转折延时模式：后续普通科技买点通知一律抑制（避免延时买入后又弹普通卡片）
    if (mode === strategyModeState.MODE_TECH_ATTACK && iceDelayBuy.shouldSuppressTech()) return;

    if (lastNotifiedBucket === bucket) return;

    lastNotifiedBucket = bucket;
    writeState({ date: dayjs().format('YYYYMMDD'), bucket, mode });

    try {
      await notifyBuyPointFeishu({ mode });
    } catch (e) {
      console.error('买点飞书发送失败:', e.message);
    }
    wsServer.broadcast({ type: 'buy_point', mode, bucket, ts: Date.now(), data, open: true });
  } catch (e) {
    console.error('买点诊断推送任务异常:', e.message);
  } finally {
    running = false;
  }
};

// 启动调度（挂在常驻 HTTP 服务进程上；进程退出即停止）
const start = () => {
  if (timer) return;
  loadLastNotifiedBucket();
  tick(); // 立即执行一次，启动即有数据
  timer = setInterval(tick, INTERVAL_MS);
  console.log('买点诊断集中推送服务已启动（每 10s 一次）');
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, isInPushWindow };
