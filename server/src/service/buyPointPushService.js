// 买点诊断后端集中调度（每 10s 一次）
//   - 每 10s 计算一次诊断，经 WebSocket 广播给所有前端（卡片/抽屉实时刷新，前端不再轮询）
//   - 命中且进入新的 5 分钟时间桶时（每桶最多一次）：后端发飞书 + 额外广播 open:true 让前端开抽屉/弹窗
//   - 5 分钟桶标签口径严格对齐回测（见 buyPointBuckets.js）
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
const { getExtremeWinBuyPointChecks, MODE_EXTREME_WIN } = require('./hotMoneyExtremeWin');

const INTERVAL_MS = 10 * 1000;
const statePath = path.resolve(__dirname, '../data/buy_point_notify_state.json');

let timer = null;
let running = false;
let lastNotifiedBucket = null;
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
  lastNotifiedBucket = s && s.date === today && s.bucket != null ? s.bucket : null;
  lastBlockedBucket = s && s.date === today && s.blockedBucket != null ? s.blockedBucket : null;
};

// 买点屏蔽检测（快进快出强卖当日禁买，2026-10-19 新增）：当日已有「情绪快进快出 10:00 强制卖出」
// 记录时买点诊断的 quick_out_no_rebuy 检查不通过（与回测 emoquick 策略「强卖当日禁止二次买入」对齐）。
// 若除该拦截项（及提示项/尾盘抄底或分支）外其余前置条件全部通过，说明买点本应命中、仅被该规则屏蔽，
// 返回屏蔽信息供推送 buy_point_blocked；其余条件也有失败时属「买点本来就不命中」，不算屏蔽。
const detectQuickOutBlock = (data) => {
  if (!data || data.allPassed !== false) return null;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const noRebuy = checks.find((c) => c && c.id === 'quick_out_no_rebuy');
  if (!noRebuy || noRebuy.passed !== false) return null;
  const otherFailed = checks.filter((c) => c && c.passed === false
    && c.id !== 'quick_out_no_rebuy' && c.id !== 'tail_dip_buying' && c.id !== 'quick_out_buy_hint');
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

const runDiagnosis = (mode) => (
  mode === MODE_EXTREME_WIN
    ? getExtremeWinBuyPointChecks(null, true)
    : getBuyPointChecks(null, true, false)
);

const tick = async () => {
  if (running) return; // 上一 tick 未完成则跳过，避免重入
  running = true;
  try {
    const now = new Date();
    if (!isInPushWindow(now)) return;

    const mode = strategyModeState.getMode();
    const res = await runDiagnosis(mode);
    const data = res && res.data ? res.data : null;
    if (!data) return;

    const bucket = getCurrentClosedBucket(now);

    // 1) 每 10s 广播诊断结果（仅供前端展示，不触发打开）
    wsServer.broadcast({ type: 'buy_point', mode, bucket, ts: Date.now(), data, open: false });

    // 2) 买点屏蔽（快进快出强卖当日禁买）：其余前置条件全部通过但被该规则拦截时，抑制买点命中
    //    通知（含尾盘抄底或分支）与飞书，改为推送 buy_point_blocked 屏蔽通知（每桶最多一次）
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
      || (data.reverse && data.reverse.allPassed === true)
      || data.tailDipBuyingHit === true;
    if (bucket == null || !canonicalHit) return;
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
