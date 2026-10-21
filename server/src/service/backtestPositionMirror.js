// 回测持仓镜像同步服务（2026-10-19 新增）
// 目的：保证每天线上实盘操作与回测策略操作完全一致。
// 流程：每天首次启动后端服务时（以「回测范围最新交易日已同步」为幂等判据），后台执行一次
//   「3日涨幅最大&三日情绪-30快进快出」（highest_3d_gain_emoquick）策略回测（范围=回测报告默认
//   范围：最近 60 个可用回放交易日，与抽屉/全量回测缓存口径一致，现算不读写回测缓存），
//   读取回测期末持仓（currentHoldings，快进快出半仓 / 两次买入可能有多份腿）：
//     - 有期末持仓且持仓管理中不存在「同股票 + 同买入日」的镜像持仓 → 自动生成持仓：
//       仓位 50%、成本价 = 回测买入价、买入日期 = 回测买入日——买入日期取回测值是关键：
//       卖点诊断「买入当日不诊断、次日起生效」与条件8（快进快出次日 10:00 强卖，要求买入日
//       = 上一交易日）均按持仓 buyDate 判定，回测买入日才能让实时卖点诊断与回测卖点完全同轨；
//     - 无期末持仓（回测中该持仓已卖出）→ 不做任何动作。
// 强卖后的当日禁买：卖点诊断条件8 触发时自动写入 quick_out_force_sell.json，买点诊断内置的
//   「快进快出强卖当日禁买」检查随即不通过（见 buySellDiagnose.js），本服务不重复实现。
// 回测失败重试：同一自然日最多尝试 3 次，避免每次启动重复空跑。
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getDefaultReportRange } = require('./backtestReport');
const { runRangeBacktest, STRATEGIES } = require('./buySellBacktest');
const { addStockPosition, getStockPositions } = require('./stockPosition');
const emoQuickFundGateLive = require('./emoQuickFundGateLive');

const MIRROR_STRATEGY_ID = 'highest_3d_gain_emoquick';
const MIRROR_STRATEGY_NAME = STRATEGIES[MIRROR_STRATEGY_ID]?.name || '3日涨幅最大&三日情绪-30快进快出';
const MIRROR_POSITION_WEIGHT = 50; // 镜像持仓默认仓位 50%
const MAX_ATTEMPTS_PER_DAY = 3; // 同一自然日回测失败重试上限
const STARTUP_DELAY_MS = 8 * 1000; // 启动后延迟执行，避免与前端首屏请求 / 诊断初始化抢资源

const statePath = path.resolve(__dirname, '../data/backtest_position_mirror.json');

let started = false;

const readState = () => {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    console.error('[回测持仓镜像] 读取同步状态失败:', e.message);
    return {};
  }
};

const writeState = (obj) => {
  try {
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[回测持仓镜像] 写入同步状态失败:', e.message);
  }
};

// 幂等：持仓管理中是否已存在「同策略镜像 + 同股票 + 同买入日」的持仓
const findMirroredPosition = (code, buyDateDash) => (getStockPositions() || []).find((p) =>
  p && p.mirror && p.mirror.strategy === MIRROR_STRATEGY_ID
  && String(p.code) === String(code)
  && String(p.buyDate) === String(buyDateDash));

const syncOnce = async () => {
  const range = getDefaultReportRange();
  if (!range || !/^\d{8}$/.test(range.endDate || '')) {
    console.log('[回测持仓镜像] 可用回放交易日未就绪，无法确定回测范围，本次跳过（下次启动重试）');
    return false;
  }
  const state = readState();
  if (state.lastSyncedEndDate === range.endDate) {
    console.log(`[回测持仓镜像] 回测范围截至 ${range.endDate} 已同步过，跳过`);
    return true;
  }
  const today = dayjs().format('YYYY-MM-DD');
  const attempts = state.attemptsDate === today ? (Number(state.attempts) || 0) : 0;
  if (attempts >= MAX_ATTEMPTS_PER_DAY) {
    console.log(`[回测持仓镜像] 今日回测已失败 ${attempts} 次，跳过（下次启动重试）`);
    return true;
  }
  writeState({ ...state, attemptsDate: today, attempts: attempts + 1 });
  console.log(`[回测持仓镜像] 开始执行「${MIRROR_STRATEGY_NAME}」回测（${range.startDate} ~ ${range.endDate}），完成后同步期末持仓...`);
  const result = await runRangeBacktest(range.startDate, range.endDate, MIRROR_STRATEGY_ID, (p) => {
    if (p && (p.status || p.date)) {
      console.log(`[回测持仓镜像] 回测进度：${p.date || ''} ${p.current != null ? `${p.current}/${p.total}` : ''} ${p.status || ''}`.trim());
    }
  });
  if (!result || result.success !== true) {
    throw new Error((result && result.message) || '回测执行失败');
  }
  // 快进快出「资金净流入阈值动态调节」：启动回测完成后按成交序列重算实盘买点诊断阈值
  //（无论启动时是否有持仓都先按回测报告设定；后续持仓增删会触发后台重跑重算，见 emoQuickFundGateLive.js）
  emoQuickFundGateLive.onBacktestCompleted(result, '每日首次启动回测');

  // 期末持仓同步：每份腿独立生成一笔镜像持仓（仓位 50%、成本价 = 回测买入价、买入日 = 回测买入日）
  const holdings = Array.isArray(result.currentHoldings) ? result.currentHoldings : [];
  const added = [];
  const skipped = [];
  for (const leg of holdings) {
    const code = leg && leg.code;
    const name = (leg && leg.stockName) || code;
    const buyDateRaw = String((leg && leg.buyDate) || '');
    const buyPrice = Number(leg && leg.buyPrice);
    const buyDateDash = /^\d{8}$/.test(buyDateRaw)
      ? `${buyDateRaw.slice(0, 4)}-${buyDateRaw.slice(4, 6)}-${buyDateRaw.slice(6, 8)}`
      : null;
    if (!code || !buyDateDash || !Number.isFinite(buyPrice) || buyPrice <= 0) {
      skipped.push(`${name || code || '?'}（回测持仓数据不完整，跳过）`);
      continue;
    }
    if (findMirroredPosition(code, buyDateDash)) {
      skipped.push(`${name}（镜像持仓已存在）`);
      continue;
    }
    const res = addStockPosition(code, name, MIRROR_POSITION_WEIGHT, {
      buyDate: buyDateDash,
      buyTime: leg.buyTime || undefined,
      costPrice: buyPrice,
      mirror: {
        strategy: MIRROR_STRATEGY_ID,
        strategyName: MIRROR_STRATEGY_NAME,
        syncedDate: today,
        buyDateRaw,
        source: 'backtest_position_mirror',
      },
    });
    if (res.success) {
      added.push(`${name}(${code}) 成本 ${buyPrice.toFixed(2)} 买入日 ${buyDateDash}`);
    } else {
      skipped.push(`${name}（${res.message}）`);
    }
  }

  writeState({
    lastSyncedEndDate: range.endDate,
    lastRange: range,
    lastSyncedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    lastHoldings: holdings.map((h) => ({
      code: h.code, name: h.stockName, buyDate: h.buyDate, buyPrice: h.buyPrice, buyTime: h.buyTime, weight: h.weight ?? null,
    })),
    added,
    skipped,
    attempts: 0,
    attemptsDate: today,
  });
  if (holdings.length === 0) {
    console.log(`[回测持仓镜像] 回测期末无持仓（已全部卖出），无需同步（截至 ${range.endDate}）`);
  } else if (added.length > 0) {
    console.log(`[回测持仓镜像] 已同步 ${added.length} 笔镜像持仓：${added.join('；')}${skipped.length ? `；跳过：${skipped.join('；')}` : ''}`);
  } else {
    console.log(`[回测持仓镜像] 期末持仓均已存在，未新增（${skipped.join('；')}）`);
  }
  return true;
};

// 挂在 HTTP 服务启动回调上（与买点/卖点推送服务同点调用）；进程退出即停止
const start = () => {
  if (started) return;
  started = true;
  setTimeout(() => {
    syncOnce().catch((e) => {
      console.error('[回测持仓镜像] 同步失败（下次启动重试）:', e.message || e);
    });
  }, STARTUP_DELAY_MS);
};

module.exports = { start, syncOnce, MIRROR_STRATEGY_ID, MIRROR_STRATEGY_NAME };
