// 快进快出「资金净流入阈值动态调节」线上实盘同步服务（2026-10-21 用户新增）
// 目的：把回测端的动态阈值（buySellBacktest/engine/emoQuick.js createEmoQuickFundGate：连续 2 笔
//   已完结交易的折算收益率（半仓按 ×0.5 折算后，与 3% 直接比较）均未超过 3% → 阈值 20 → 30 亿；
//   此后任一笔交易折算收益率超过 3% → 阈值降回 20 亿并重置连续计数）同步到线上实盘买点诊断。
// 消费方：buySellDiagnose.getBuyPointChecks 检查2 fund_inflow（科技进攻模式与攻防兼备模式的
//   科技进攻腿共用该诊断，见 buyPointPushService.runDiagnosis）。
// 流程：
//   ① 每天首次启动后端时的既有回测（backtestPositionMirror：每天首次启动跑一次
//      「3日涨幅最大&三日情绪-30快进快出」highest_3d_gain_emoquick，范围=回测报告默认最近 60 个
//      可用回放交易日）完成后回调 onBacktestCompleted：按成交顺序（卖出时间升序）灌入状态机，
//      得到当前阈值并落盘 emo_quick_fund_gate.json——无论启动时是否有持仓，都先按回测报告设定阈值；
//   ② 持仓管理「增加股票 / 删除股票」操作（HTTP /add_stock_position、/delete_stock_position，
//      经 stockPosition.js 的变动监听回调到 index.js 注册的钩子）触发 requestRecomputeBacktest：
//      后台自动重跑同一回测并重新计算阈值（串行排队 + 合并多次触发，避免并发重跑/连续操作重复空跑；
//      回测镜像同步自身产生的 add 在启动回测中已计入，由 index.js 侧跳过）。
// 状态持久化：../data/emo_quick_fund_gate.json；状态缺失/异常时 getLiveFundInflowThreshold 回退固定 20 亿。
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getDefaultReportRange } = require('./backtestReport');
const { runRangeBacktest } = require('./buySellBacktest');
const { createEmoQuickFundGate } = require('./buySellBacktest/engine/emoQuick');
const { EMO_QUICK_FUND_INFLOW_RAISED } = require('./buySellBacktest/constants');
const { getStockPositions } = require('./stockPosition');
const { isTechWatchlistStock } = require('./monitorStock');
const wsServer = require('../wsServer');

// 与 backtestPositionMirror 同一策略：线上实盘科技进攻（快进快出）的镜像回测策略
const GATE_STRATEGY_ID = 'highest_3d_gain_emoquick';
const GATE_STRATEGY_NAME = '3日涨幅最大&三日情绪-30快进快出';
const DEFAULT_THRESHOLD = 20; // 状态缺失/异常时的回退阈值（与买点诊断原固定值一致）
const statePath = path.resolve(__dirname, '../data/emo_quick_fund_gate.json');

const readState = () => {
  try {
    if (!fs.existsSync(statePath)) return null;
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || 'null');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch (e) {
    console.error('[快进快出阈值] 读取状态失败:', e.message);
    return null;
  }
};

const writeState = (obj) => {
  try {
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[快进快出阈值] 写入状态失败:', e.message);
  }
};

// 供买点诊断消费：返回 { threshold, dynamic, consecutiveBelow, tradeCount, computedAt, reason, range }
// 状态缺失或 threshold 非法时回退固定 20 亿（dynamic=false）
const getLiveFundInflowThreshold = () => {
  const state = readState();
  const threshold = state ? Number(state.threshold) : NaN;
  if (!state || !Number.isFinite(threshold) || threshold <= 0) {
    return { threshold: DEFAULT_THRESHOLD, dynamic: false, consecutiveBelow: null, tradeCount: null, computedAt: null, reason: null, range: null };
  }
  return {
    threshold,
    dynamic: true,
    consecutiveBelow: Number.isFinite(Number(state.consecutiveBelow)) ? Number(state.consecutiveBelow) : null,
    tradeCount: Number.isFinite(Number(state.tradeCount)) ? Number(state.tradeCount) : null,
    computedAt: state.computedAt || null,
    reason: state.reason || null,
    range: state.range || null,
  };
};

// 供前端「刷新即取」的完整快照：getLiveFundInflowThreshold 基础上追加最近 10 笔成交明细
const getFundGateSnapshot = () => {
  const base = getLiveFundInflowThreshold();
  const state = readState();
  return { ...base, lastReturns: Array.isArray(state && state.lastReturns) ? state.lastReturns : [] };
};

// ---------- 「30 亿抬高态强制两次买入」线上持仓状态（2026-10-21 用户新增） ----------
// 科技进攻（快进快出）只买自选科技股、情绪游资-极致胜率候选池剔除自选科技股，两者持仓互不重叠，
// 故「tech 持仓」= 自选科技股（isTechWatchlistStock，isTech !== false）的持仓。
// 与回测 waitingSecondLeg（emoQuickHalfBuy && positions.length === 1 && positions[0].leg === 1）同口径：
// 恰好持有 1 笔仓位 50% 的 tech 持仓 → 待补买第二份（买点诊断 fund_inflow 阈值降回基准 20 亿，
// 第二份买入提醒文案同步提示）。不限制买入日期：当日已买第一份时「同日不能买第二份」由买入提醒
// 文案提示（对应回测 dateStr > positions[0].buyDate 约束）
const getTechHalfPositionState = () => {
  const techHoldings = (getStockPositions() || []).filter((p) => p && isTechWatchlistStock(p.code));
  const halfLegs = techHoldings.filter((p) => Number(p.weight) === 50);
  const toRow = (p) => ({ code: p.code, name: p.name, buyDate: p.buyDate || null, weight: Number(p.weight) });
  return {
    techCount: techHoldings.length,
    techHoldings: techHoldings.map(toRow),
    positions: halfLegs.map(toRow),
    count: halfLegs.length,
    waitingSecondLeg: halfLegs.length === 1,
  };
};

// 资金净流入阈值是否处于抬高态（≥ 30 亿）：该态下科技进攻首次建仓不分快进快出情形一律只买半仓
//（第一份 5 成），剩余半仓等后续交易日买点再次触发时补买
const isGateRaised = () => getLiveFundInflowThreshold().threshold >= EMO_QUICK_FUND_INFLOW_RAISED;

// 回测完成后按成交序列重算阈值并落盘
// result：runRangeBacktest 的结果（result.trades 为完整成交序列，每笔含 sellDate/sellTime/returnRate，
// returnRate 即折算收益率——半仓腿已按 ×0.5 折算，与回测端 fundGate 喂入口径完全一致）
const onBacktestCompleted = (result, reason) => {
  if (!result || result.success !== true || !Array.isArray(result.trades)) {
    console.log(`[快进快出阈值] 回测结果不可用（${reason || '-'}），跳过阈值重算`);
    return null;
  }
  // 按卖出时间升序重建成交顺序（回测单持仓策略买入序≈卖出序，此处按卖出时间排序兜底多腿/顺延场景）
  const trades = [...result.trades].sort((a, b) => {
    const d = String(a.sellDate || '').localeCompare(String(b.sellDate || ''));
    if (d !== 0) return d;
    return String(a.sellTime || '').localeCompare(String(b.sellTime || ''));
  });
  const gate = createEmoQuickFundGate();
  for (const t of trades) gate.onTradeClosed(t && t.returnRate);
  const state = gate.getState();
  const payload = {
    strategyId: GATE_STRATEGY_ID,
    strategyName: GATE_STRATEGY_NAME,
    computedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    reason: reason || null,
    range: result.range || null,
    tradeCount: trades.length,
    threshold: state.threshold,
    consecutiveBelow: state.consecutiveBelow,
    lastReturns: trades.slice(-10).map((t) => ({
      code: t.code, name: t.stockName, sellDate: t.sellDate, sellTime: t.sellTime,
      returnRate: Number.isFinite(Number(t.returnRate)) ? Number(t.returnRate) : null,
    })),
  };
  writeState(payload);
  console.log(`[快进快出阈值] 已按回测成交序列重算阈值：${payload.threshold} 亿（连续未超 3% 计数 ${payload.consecutiveBelow}，成交 ${payload.tradeCount} 笔，触发：${payload.reason || '-'}）`);
  // WebSocket 广播 fund_gate：前端（开盘实战买点卡片 / 悬浮持仓栏）实时更新资金净流入阈值文案
  try {
    wsServer.broadcast({ type: 'fund_gate', ts: Date.now(), data: { ...payload, ...getLiveFundInflowThreshold() } });
  } catch (e) {
    console.error('[快进快出阈值] WebSocket 广播失败:', e.message);
  }
  return payload;
};

// 持仓增删触发的后台重跑：串行排队 + 合并多次触发（跑完一轮后若又有新触发则再跑一轮，只跑最新状态）
let running = false;
let pendingReasons = [];
const requestRecomputeBacktest = (reason) => {
  pendingReasons.push(reason || '未注明');
  if (running) return;
  running = true;
  (async () => {
    while (pendingReasons.length > 0) {
      const reasons = pendingReasons.join('、');
      pendingReasons = [];
      try {
        const range = getDefaultReportRange();
        if (!range || !/^\d{8}$/.test(range.endDate || '')) {
          console.log('[快进快出阈值] 可用回放交易日未就绪，无法重跑回测，跳过');
          continue;
        }
        console.log(`[快进快出阈值] 触发后台重跑回测（${range.startDate} ~ ${range.endDate}，触发：${reasons}）...`);
        const result = await runRangeBacktest(range.startDate, range.endDate, GATE_STRATEGY_ID);
        if (result && result.success === true) {
          onBacktestCompleted(result, `持仓变动重跑（${reasons}）`);
        } else {
          console.error('[快进快出阈值] 重跑回测失败：', (result && result.message) || '未知原因');
        }
      } catch (e) {
        console.error('[快进快出阈值] 重跑回测异常:', e.message || e);
      }
    }
  })().finally(() => { running = false; });
};

module.exports = {
  GATE_STRATEGY_ID,
  GATE_STRATEGY_NAME,
  getLiveFundInflowThreshold,
  getFundGateSnapshot,
  getTechHalfPositionState,
  isGateRaised,
  onBacktestCompleted,
  requestRecomputeBacktest,
};
