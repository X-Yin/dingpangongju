// 买点预热提醒（2026-11-15 用户新增）
//   在各自策略原本的诊断频控内（科技进攻 5min / 情绪游资 3min / 极致赔率 3s）评估「预热条件」，
//   只有「预热条件满足且本轮买点诊断尚未命中」时才经 WS 推送 open:true 的预热卡片；
//   条卡样式与买点诊断卡片一致（前端 GlobalDiagnosisAlert 的 PreheatCard）。
//   预热条件：
//     科技进攻：双指数 3 日线斜率门禁通过，且最近 5min 资金净流入 ≥ 10 亿
//     极致胜率：候选龙头「强度分 − 差劲分」≥ 15（可多只）
//     极致赔率：打板模式（首板盘中 / 二板盘中，忽略首板竞价）候选涨幅 ≥ 5%（可多只）
//   去重：同一自然日、同一标的只提醒一次（科技进攻按策略每天一次），避免每个诊断间隔重复弹卡
const dayjs = require('dayjs');
const wsServer = require('../wsServer');

const PREHEAT_TYPE = 'buy_point_preheat';
const TECH_FUND_INFLOW_MIN_YI = 10;
const EW_DELTA_MIN = 15;
const WF_CHANGE_MIN = 5;

let firedDate = '';
let firedKeys = new Set();

const todayStr = () => dayjs().format('YYYYMMDD');
const resetIfNewDay = () => {
  const d = todayStr();
  if (firedDate !== d) {
    firedDate = d;
    firedKeys = new Set();
  }
};
const wasFired = (key) => firedKeys.has(key);
const markFired = (key) => firedKeys.add(key);

const round2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

// 资金净流入（亿）：优先用基金检查项的 detail 数值（当前累计 − 过去累计），缺失时回退解析展示值
const techFundInflowYi = (data) => {
  const checks = Array.isArray(data?.checks) ? data.checks : [];
  const check = checks.find((c) => c && c.id === 'fund_inflow');
  if (!check) return null;
  const d = check.detail || {};
  const cur = Number(d.currentValue);
  const past = Number(d.pastValue);
  if (Number.isFinite(cur) && Number.isFinite(past)) return round2(cur - past);
  const m = String(check.value || '').match(/[-+]?\d+(\.\d+)?/);
  return m ? round2(Number(m[0])) : null;
};

const broadcastPreheat = ({
  kind, mode, title, message, stocks = [], threshold = null, value = null, mock = false,
}) => {
  wsServer.broadcast({
    type: PREHEAT_TYPE,
    ts: Date.now(),
    open: true,
    mode,
    data: {
      kind,
      mode,
      title,
      message,
      stocks,
      threshold,
      value,
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      mock: !!mock,
    },
  });
  const names = stocks.map((s) => `${s.stockName || s.code}${s.change != null ? ` ${round2(s.change)}%` : ''}`).join('、');
  console.log(`[买点预热·${kind}] ${message}${names ? `（${names}）` : ''}`);
};

// 科技进攻预热：指数门禁通过 + 资金净流入 ≥ 10 亿，且本轮买点未命中
const maybeTechPreheat = ({ data, mode, mock = false }) => {
  if (!data || data.allPassed === true) return false;
  resetIfNewDay();
  const key = `tech:${mode}`;
  if (!mock && wasFired(key)) return false;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  // 买入时段已过（如科技进攻 14:00 截止）不再预热，避免提示关注无法买入的标的
  const buyTimeGate = checks.find((c) => c && c.id === 'buy_time_gate');
  if (!mock && buyTimeGate && buyTimeGate.passed !== true) return false;
  const indexGate = checks.find((c) => c && c.id === 'index_ma3_slope_gate');
  if (!mock && (!indexGate || indexGate.passed !== true)) return false;
  const diff = mock ? 12.86 : techFundInflowYi(data);
  if (!mock && (diff == null || diff < TECH_FUND_INFLOW_MIN_YI)) return false;
  if (!mock) markFired(key);
  broadcastPreheat({
    kind: 'tech',
    mode,
    title: '科技进攻 · 买点预热',
    message: `双指数 3 日线斜率门禁已通过，最近 5 分钟资金净流入 ${diff >= 0 ? '+' : ''}${Number(diff).toFixed(2)} 亿（≥ ${TECH_FUND_INFLOW_MIN_YI} 亿），买点尚未完全满足，请提前关注科技进攻候选股列表。`,
    threshold: { fundInflowYi: TECH_FUND_INFLOW_MIN_YI },
    value: round2(diff),
    mock,
  });
  return true;
};

// 极致胜率预热：候选龙头强度 − 差劲 ≥ 15（诊断结果已带 preheatCandidates），且本轮买点未命中
const maybeExtremeWinPreheat = ({ data, mode, mock = false }) => {
  if (!data || data.allPassed === true) return false;
  if (data.reverse && data.reverse.allPassed === true) return false;
  // 买入窗口关闭（过 14:30 截止）后不再预热
  if (!mock && data.buyWindowOpen === false) return false;
  resetIfNewDay();
  let candidates = Array.isArray(data.preheatCandidates) ? data.preheatCandidates : [];
  if (mock) {
    candidates = [
      { code: '300308', stockName: '中际旭创', change: 6.82, strengthScore: 62.4, diffScore: 44.1, delta: 18.3 },
      { code: '002049', stockName: '紫光国微', change: 4.15, strengthScore: 58.7, diffScore: 42.2, delta: 16.5 },
    ];
  }
  const fresh = candidates.filter((s) => s && s.code && (mock || !wasFired(`ew:${s.code}`)));
  if (fresh.length === 0) return false;
  if (!mock) fresh.forEach((s) => markFired(`ew:${s.code}`));
  broadcastPreheat({
    kind: 'extreme_win',
    mode,
    title: '极致胜率 · 买点预热',
    message: `极致胜率候选股 ${fresh.map((s) => `${s.stockName}（强度−差劲 ${Number(s.delta).toFixed(2)}）`).join('、')} 已达到 ${EW_DELTA_MIN} 以上，买点尚未完全满足，请重点关注极致胜率候选股列表。`,
    stocks: fresh.map((s) => ({
      code: s.code,
      stockName: s.stockName || s.code,
      change: s.change ?? null,
      strengthScore: s.strengthScore ?? null,
      diffScore: s.diffScore ?? null,
      delta: s.delta ?? null,
    })),
    threshold: { deltaMin: EW_DELTA_MIN },
    mock,
  });
  return true;
};

// 极致赔率预热：打板模式（忽略首板竞价）候选涨幅 ≥ 5%，且该股尚未触发正式买点
const maybeWashFusionPreheat = ({
  dateStr, pools, quotes, minute, signaledCodes, mock = false,
}) => {
  resetIfNewDay();
  const firstBoard = Array.isArray(pools?.firstBoard) ? pools.firstBoard : [];
  const secondBoard = Array.isArray(pools?.secondBoard) ? pools.secondBoard : [];
  const rows = [...firstBoard, ...secondBoard].filter((c) => {
    if (!c || !c.code) return false;
    if (signaledCodes && signaledCodes.has(c.code)) return false;
    const q = quotes ? quotes[c.code] : null;
    if (!q || q.change == null) return false;
    if (!mock && (Number(minute) < 570 || Number(minute) > 870)) return false; // 仅盘中打板窗口，忽略首板竞价
    // 首板起爆盘中追买窗口 9:30-9:40；二板起爆 9:30-14:30（与各自买点窗口一致）
    if (!mock) {
      const isFirstBoard = c.source === 'first_board_wash';
      if (Number(minute) > (isFirstBoard ? 580 : 870)) return false;
    }
    return Number(q.change) >= WF_CHANGE_MIN;
  });
  const fresh = mock
    ? [
      { code: '600519', stockName: '贵州茅台', change: 5.62, sourceLabel: '首板起爆' },
      { code: '300750', stockName: '宁德时代', change: 5.18, sourceLabel: '二板起爆' },
    ]
    : rows.filter((c) => !wasFired(`wf:${c.code}`)).map((c) => ({
      code: c.code,
      stockName: c.name || c.code,
      change: round2(quotes[c.code].change),
      sourceLabel: c.sourceLabel || (c.source === 'second_board_wash' ? '二板起爆' : '首板起爆'),
    }));
  if (fresh.length === 0) return false;
  if (!mock) rows.forEach((c) => markFired(`wf:${c.code}`));
  broadcastPreheat({
    kind: 'wash_fusion',
    mode: 'wash_fusion',
    title: '极致赔率 · 买点预热',
    message: `极致赔率候选股 ${fresh.map((s) => `${s.stockName} 涨幅 ${Number(s.change) > 0 ? '+' : ''}${Number(s.change).toFixed(2)}%`).join('、')}（盘中打板模式，不含竞价），请关注极致赔率候选股列表。`,
    stocks: fresh,
    threshold: { changePct: WF_CHANGE_MIN },
    mock,
  });
  return true;
};

// 按模式统一入口：单模式 / 攻防兼备（两腿分别判断）在每次诊断结束后调用
const maybePushForMode = (mode, data) => {
  try {
    if (!data) return;
    if (mode === 'tech_attack') {
      maybeTechPreheat({ data, mode });
      return;
    }
    if (mode === 'hot_money_extreme_win') {
      maybeExtremeWinPreheat({ data, mode });
      return;
    }
    if (mode === 'attack_defense') {
      // 科技腿与情绪游资腿分别判断：任一腿已命中只跳过该腿的预热
      if (data.tech) maybeTechPreheat({ data: data.tech, mode });
      maybeExtremeWinPreheat({ data, mode });
    }
  } catch (e) {
    console.error('买点预热评估失败:', e.message);
  }
};

// 调试面板：绕过条件与去重，直接推一张与实盘同结构的预热卡片
const mockPreheat = (kind) => {
  if (kind === 'tech') {
    return maybeTechPreheat({ data: { checks: [] }, mode: 'tech_attack', mock: true });
  }
  if (kind === 'extreme_win') {
    return maybeExtremeWinPreheat({ data: { stocks: [], checks: [] }, mode: 'hot_money_extreme_win', mock: true });
  }
  if (kind === 'wash_fusion') {
    return maybeWashFusionPreheat({ dateStr: todayStr(), pools: {}, quotes: {}, minute: 600, signaledCodes: new Set(), mock: true });
  }
  throw new Error(`未知预热类型：${kind}`);
};

module.exports = {
  maybePushForMode,
  maybeTechPreheat,
  maybeExtremeWinPreheat,
  maybeWashFusionPreheat,
  mockPreheat,
  PREHEAT_TYPE,
};
