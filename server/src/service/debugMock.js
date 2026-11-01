// 调试面板 MOCK 服务：手动触发「买点 / 卖点」命中，走与实盘一致的推送 + 飞书链路
//   - 绕过 10s ticker 的 5 分钟桶门控，点击即刻推送
//   - 飞书卡片额外标注【MOCK 测试卡片】
//   - 2026-10-21 用户要求：MOCK 数据按线上真实诊断条件结构填充（条件名 / 阈值 / 文案与实盘一致），
//     数值可 mock 但必须满足各条件的最低阈值要求——买点 9 项检查全部通过、卖点命中 1~2 个真实条件
const dayjs = require('dayjs');
const { getMonitorStocks } = require('./monitorStock');
const { getStockPositions } = require('./stockPosition');
const { getSingleStockTlineData, getRealtimeQuotes } = require('./stock');
const strategyModeState = require('./strategyModeState');
const wsServer = require('../wsServer');
const feishuNotify = require('./feishuNotify');
const iceDelayBuy = require('./iceDelayBuy');
const firstBoardWashLive = require('./firstBoardWashLive');
const { limitUpThresholdOf } = require('./buySellBacktest/engine/extremeWinScores');
const { WASHOUT_OPT } = require('./buySellBacktest/engine/firstBoardWashBacktest');
const { getPastTradingDates } = require('./buySellBacktest/deps');

const MOCK_TAG = '【MOCK 测试】';

const pickRandom = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);
const fmtNow = () => dayjs().format('YYYY-MM-DD HH:mm:ss');
const rnd = (min, max, digits = 2) => +(min + Math.random() * (max - min)).toFixed(digits);
const rndInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// ==================== MOCK 买点 ====================
// 结构与 getBuyPointChecks 返回一致：9 项检查全部通过（阈值取最低要求），
// 结论 / 命中类型 / 仓位提示（普通买入日 → 全仓）与实盘同文案
const mockBuyPoint = async () => {
  const stocks = getMonitorStocks() || [];
  const target = pickRandom(stocks);
  if (!target) return { success: false, error: '自选股为空，无法 mock' };

  const mode = strategyModeState.getMode();
  const timestamp = fmtNow();

  // ---- 数值构造（全部满足最低阈值） ----
  const nowT = dayjs();
  const curHm = nowT.format('HHmm');
  const inAllowedWindow = (curHm >= '0930' && curHm <= '1130') || (curHm >= '1300' && curHm <= '1330');
  const buyMinuteText = inAllowedWindow ? nowT.format('HH:mm') : '11:25';

  const fundThreshold = 20;                        // 资金净流入基准阈值 20 亿
  const inflowDiff = rnd(25, 60);                  // > 20 亿阈值
  const tCurrent = nowT.format('HH:mm');
  const tPast = nowT.subtract(5, 'minute').format('HH:mm');
  const inflowCurrent = rnd(280, 420);
  const inflowPast = +(inflowCurrent - inflowDiff).toFixed(2);

  const volNow = rnd(40, 180);                     // 今日累计成交额 − 昨日全天 > 0
  const volPrev = +(volNow - rnd(15, 40)).toFixed(2);

  const techCount = 98;
  const openingBelowMax = Math.ceil(techCount * 0.25);   // 25
  const belowCount = rndInt(6, 18);                      // ≤ 25

  const openEmotion = rnd(12, 26);                 // ≤ 30 → 回落限制不生效
  const curEmotion = rnd(-32, 6);

  const cybSlope = rnd(1.2, 4.5);
  const starSlope = rnd(0.8, 3.5);

  const checks = [
    {
      id: 'fund_inflow',
      title: `最近 5min 资金净流入大于 ${fundThreshold} 亿`,
      passed: true,
      value: `+${inflowDiff.toFixed(2)}亿`,
      detail: {
        currentTime: tCurrent, pastTime: tPast,
        currentValue: inflowCurrent, pastValue: inflowPast,
        sinceOpen: false,
        fundGate: { threshold: fundThreshold, dynamic: false, consecutiveBelow: null, tradeCount: null, computedAt: null, reason: null, range: null },
        waitingSecondLeg: false,
      },
      reason: `最近 5 分钟资金净流入 +${inflowDiff.toFixed(2)} 亿（${tPast}→${tCurrent}），超过 ${fundThreshold} 亿阈值`,
    },
    {
      id: 'volume_expansion',
      title: '当前量能为正（今日累计成交额超昨日全天）',
      passed: true,
      value: `+ ${volNow.toFixed(2)}亿`,
      detail: {
        currentTime: tCurrent, pastTime: tPast,
        prev5minVol: volPrev, last5minVol: volNow,
        increase5min: +(volNow - volPrev).toFixed(2),
      },
      reason: `当前量能 ${volNow.toFixed(2)} 亿为正，今日累计成交额已超过昨日全天`,
    },
    {
      id: 'opening_below',
      title: `开盘后自选科技股低于开盘价不超过科技股数的 25%（${openingBelowMax} 只）`,
      passed: true,
      value: `${belowCount} / ${techCount}只`,
      reason: `开盘后自选科技股共 ${techCount} 只，${belowCount} 只现价低于 9:30 开盘价，未超过 ${openingBelowMax} 只阈值（阈值 = 科技股数 ${techCount} 只的 25% 向上取整）`,
    },
    {
      id: 'emotion_retrace_after_open',
      title: '竞价情绪超 30 时当前情绪须低于 10',
      passed: true,
      value: `开盘 ${openEmotion.toFixed(2)} / 当前 ${curEmotion.toFixed(2)}`,
      reason: `9:30 竞价科技情绪 ${openEmotion.toFixed(2)} 未超过 30，当前情绪须低于 10 的限制不生效`,
    },
    {
      id: 'buy_time_gate',
      title: '买入时段门禁（仅 9:30 – 11:30 / 13:00 – 13:30）',
      passed: true,
      value: `买点时刻 ${buyMinuteText} 在允许时段内`,
      reason: `买点触发时刻 ${buyMinuteText} 在允许时段（9:30 – 11:30 或 13:00 – 13:30）内`,
    },
    {
      id: 'index_ma3_slope_gate',
      title: '双指数 3 日线斜率门禁',
      passed: true,
      value: '两个指数均允许出手',
      reason: `创业板指 +${cybSlope.toFixed(2)}°：3 日线斜率为正，允许出手；科创50 +${starSlope.toFixed(2)}°：3 日线斜率为正，允许出手`,
    },
    {
      id: 'quick_out_no_rebuy',
      title: '快进快出强卖当日禁买',
      passed: true,
      value: '当日无快进快出强卖记录',
      reason: '当日无「情绪快进快出 10:00 强制卖出」记录，不影响买入',
    },
    {
      id: 'quick_out_buy_hint',
      title: '快进快出买入提示',
      passed: true,
      value: '普通买入日',
      reason: '今日为普通买入日，买入后走通用卖点诊断（情绪数据缺失时同样按普通持仓处理）',
    },
  ];

  const conclusion = `${MOCK_TAG}全部前置条件已满足，可以出手买入，但是请分仓 1/3，随后逐步分批买入，分仓管理是最后一道防火墙，谨防尾盘大盘跳水！`;

  const data = {
    allPassed: true,
    checks,
    reverseChecks: [],
    conclusion,
    timestamp,
    // 攻防兼备：实盘科技进攻腿为嵌套结构（data.tech），单模式直接用顶层字段
    ...(mode === 'attack_defense'
      ? { tech: { allPassed: true, checks, conclusion }, reverse: { allPassed: false } }
      : {}),
    // buyable 仅用于 MOCK：前端卡片直接展示本次命中标的（实盘无此字段，不影响线上）。
    //   数值满足各自门槛：抗分歧 ≥ 9、强度−差劲 ≥ 30、3 日涨幅为正
    buyable: [{
      code: target.code,
      stockName: target.name,
      name: target.name,
      market: 'MOCK',
      change: rnd(1.5, 7.5),
      change3d: rnd(9, 18),
      resilienceScore: rnd(9.5, 12.5),
      delta: rnd(32, 55),
      lianbanCount: rndInt(1, 4),
      strengthScore: rnd(32, 58),
      timingTag: pickRandom(['龙头首阴反包', '5日线企稳', '回踩10日线不破', '缩量回踩']),
      matchesBuyPoint: true,
      buyPointHit: true,
      timingPassed: true,
      isLimitUp: false,
      isTechPick: mode !== 'hot_money_extreme_win',
    }],
  };

  wsServer.broadcast({ type: 'buy_point', mode, bucket: null, ts: Date.now(), data, open: true });

  const b = data.buyable[0];
  let feishu;
  try {
    const card = feishuNotify.buildBuyPointCard({
      buyStocks: [{
        stockName: b.stockName,
        code: b.code,
        market: 'MOCK',
        change: b.change,
        change3d: b.change3d,
        resilienceScore: b.resilienceScore,
        isCandidate: true,
      }],
      timestamp,
      mock: true,
    });
    feishu = await feishuNotify.sendFeishuCard(card);
  } catch (e) {
    feishu = { success: false, error: e.message };
  }

  return { success: true, target: { code: target.code, name: target.name }, mode, feishu };
};

// ==================== MOCK 卖点 ====================
// 结构与 checkSingleStockSellPoint 返回一致：10 个真实卖出条件（含未触发项），
// 命中「均线破位」＋「跌破成本线-2%」（现价真实跌破成本阈值时），现价 / 当日涨幅取真实分时
const mockSellPoint = async () => {
  const positions = getStockPositions() || [];
  const stocks = getMonitorStocks() || [];
  const position = positions.length ? pickRandom(positions) : null;
  const fallbackStock = position ? null : pickRandom(stocks);
  if (!position && !fallbackStock) return { success: false, error: '持仓与自选股均为空，无法 mock' };

  const mode = strategyModeState.getMode();
  const timestamp = fmtNow();
  const code = position ? position.code : fallbackStock.code;
  const stockName = position ? position.name : fallbackStock.name;

  // ---- 现价 / 当日涨幅：取真实分时（失败回退 mock 值） ----
  let closePrice = rnd(20, 80);
  let change = rnd(-6, -2);
  try {
    const tline = await getSingleStockTlineData(code);
    const line = tline?.line || [];
    const last = line[line.length - 1];
    if (last && last.last_px != null && Number(last.last_px) > 0) {
      closePrice = Number(last.last_px);
      if (last.change != null && Number.isFinite(Number(last.change))) change = Number(last.change);
    }
  } catch (e) { /* 分时失败用 mock 值 */ }
  closePrice = +Number(closePrice).toFixed(2);
  change = +Number(change).toFixed(2);

  // ---- 成本线：持仓用真实成本，否则 mock 一条高于现价的成本线（浮亏 3%~9%） ----
  const realCost = position && position.costPrice != null && Number.isFinite(Number(position.costPrice)) && Number(position.costPrice) > 0
    ? Number(position.costPrice)
    : null;
  const costPrice = realCost ?? +(closePrice * rnd(1.03, 1.09)).toFixed(2);
  const costLineThreshold = +(costPrice * 0.98).toFixed(2);
  const brokenCost = closePrice < costLineThreshold;

  // ---- 均线 / 情绪数值（mock，保证与命中文案自洽） ----
  const ma10 = +(closePrice * rnd(1.008, 1.03)).toFixed(2);   // 现价跌破10日线
  const ma5 = +(closePrice * rnd(1.002, 1.02)).toFixed(2);
  const ma10Slope = -rnd(0.12, 0.65);
  const ma5Slope = -rnd(0.05, 0.35);
  const prevDayLow = +(closePrice * rnd(1.004, 1.018)).toFixed(2);
  const openPrice = +(closePrice * rnd(1.005, 1.03)).toFixed(2);
  const resilience = rnd(4.2, 5.8);                            // < 6 弱势
  const techEmotion = rnd(-45, -12);
  const amp = +(((openPrice - closePrice) / openPrice) * 100).toFixed(2);
  const buyDateStr = position?.buyDate || dayjs().subtract(3, 'day').format('YYYY-MM-DD');
  const buyTimeStr = position?.buyTime || '10:05';
  const weight = position?.weight != null ? position.weight : 25;
  const d1 = dayjs().subtract(2, 'day').format('MMDD');
  const d2 = dayjs().subtract(1, 'day').format('MMDD');
  const d3 = dayjs().format('MMDD');

  const conditions = [
    { // 条件1（命中）：规则② MA10斜率<0 且 MA5斜率≤0 → 跌破前一日最低价
      name: '均线破位',
      satisfied: true,
      pending: false,
      pendingMinutes: 0,
      detail: `现价 ${closePrice.toFixed(2)} 跌破前一日最低价 ${prevDayLow.toFixed(2)}，触发卖点（10日线斜率 ${ma10Slope.toFixed(2)} < 0，5日线斜率 ${ma5Slope.toFixed(2)} ≤ 0，采用规则②）`,
      subConditions: [
        { label: '10日线斜率', value: ma10Slope.toFixed(2) },
        { label: '5日线斜率', value: ma5Slope.toFixed(2) },
        { label: '开盘价', value: openPrice.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '前一日最低价', value: prevDayLow.toFixed(2) },
        { label: '当前涨幅', value: `${change.toFixed(2)}%` },
        { label: '判断规则', value: '规则②：MA10↓ MA5≤0 → 跌破前一日最低价（持续≥5分钟才触发）' },
      ],
    },
    {
      name: '高位放量大阴线',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: `回落 ${amp.toFixed(2)}% ≤ 8%，收盘 ${closePrice.toFixed(2)} < 开盘 ${openPrice.toFixed(2)}，未触发`,
      subConditions: [
        { label: '开盘价', value: openPrice.toFixed(2) },
        { label: '收盘价', value: closePrice.toFixed(2) },
        { label: '回落幅度', value: `${amp.toFixed(2)}%` },
        { label: '判断规则', value: '回落 > 8% 且 收盘 < 开盘（持续≥5分钟才触发）' },
      ],
    },
    {
      name: '科技板块情绪退潮',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: `科技情绪指数 ${techEmotion.toFixed(2)}，未低于 -30（需 < -30 且自选股中跌幅<-9%个股 >=5 才触发）`,
      subConditions: [
        { label: '科技情绪指数', value: techEmotion.toFixed(2) },
        { label: '阈值', value: '< -30（持续≥5分钟才触发）' },
      ],
    },
    {
      name: '抗分歧指数弱势',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: change <= -5
        ? `抗分歧指数 ${resilience.toFixed(2)} < 6，且涨幅 ${change.toFixed(2)}% ≤ -5%，但当前时间未到 14:50，条件暂不生效`
        : `抗分歧指数 ${resilience.toFixed(2)} < 6，但涨幅 ${change.toFixed(2)}% > -5%，未触发`,
      subConditions: [
        { label: '抗分歧指数', value: resilience.toFixed(2) },
        { label: '当前涨幅', value: `${change.toFixed(2)}%` },
        { label: '阈值', value: '< 6 且 涨幅 ≤ -5%（14:50后生效）' },
      ],
    },
    {
      name: '连续三日抗分歧弱势',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: `近三日抗分歧指数未全部 < 10（${d1}: 12.4、${d2}: 10.8、${d3}: ${resilience.toFixed(2)}），未触发`,
      subConditions: [
        { label: '近3日抗分歧', value: `${d1}: 12.4 | ${d2}: 10.8 | ${d3}: ${resilience.toFixed(2)}` },
        { label: '阈值', value: '连续3日均 < 10（9:40 后生效）' },
      ],
    },
    {
      name: '跌破最迟买入日低点',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: '未找到该股票的买入/加仓记录，无法判断最迟买入日低点',
      subConditions: [{ label: '状态', value: '无买入记录' }],
    },
    { // 条件7：现价真实跌破成本阈值时命中
      name: '跌破成本线-2%',
      satisfied: brokenCost,
      pending: false,
      pendingMinutes: 0,
      detail: brokenCost
        ? `现价 ${closePrice.toFixed(2)} 已跌破成本线 -2% 阈值 ${costLineThreshold.toFixed(2)}（成本价 ${costPrice.toFixed(2)}），触发卖点`
        : `现价 ${closePrice.toFixed(2)} 未跌破成本线 -2% 阈值 ${costLineThreshold.toFixed(2)}（成本价 ${costPrice.toFixed(2)}），未触发`,
      subConditions: [
        { label: '成本价', value: costPrice.toFixed(2) },
        { label: '阈值（成本价-2%）', value: costLineThreshold.toFixed(2) },
        { label: '现价', value: closePrice.toFixed(2) },
        { label: '判断规则', value: '现价 < 成本价 × 0.98 即触发' },
      ],
    },
    {
      name: '情绪快进快出强卖（3日EMA<-30）',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: `买入日（${buyDateStr}）上一交易日科技情绪 3 日 EMA -12.35 ≥ -30，非快进快出日，未触发`,
      subConditions: [
        { label: '买入日', value: buyDateStr },
        { label: '上一交易日3日EMA', value: '-12.35' },
        { label: '阈值', value: '< -30' },
      ],
    },
    {
      name: '情绪快进快出强卖（情绪温和回升）',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: `买入日（${buyDateStr}）上两交易日科技情绪原始分未同时处于 -30~-10 回升区间，未触发`,
      subConditions: [
        { label: '买入日', value: buyDateStr },
        { label: '判定区间', value: '(-30, -10) 且逐日回升' },
      ],
    },
    {
      name: '盘中大跌强卖（跌幅≤-7%）',
      satisfied: false,
      pending: false,
      pendingMinutes: 0,
      detail: '非快进快出系列持仓（买入日非快进快出日），本条件不适用',
      subConditions: [
        { label: '买入日', value: buyDateStr },
        { label: '跌幅阈值（较昨收）', value: '≤ -7%' },
        { label: '状态', value: '不适用' },
      ],
    },
  ];

  const hitNames = conditions.filter((c) => c.satisfied).map((c) => c.name);
  const reasons = conditions.filter((c) => c.satisfied).map((c) => c.detail);
  const conclusion = `${MOCK_TAG}共触发 ${hitNames.length} 个卖出条件（${hitNames.join('、')}），建议关注并考虑减仓或卖出`;

  const hit = {
    positionId: position ? (position.id || position.code) : fallbackStock.code,
    code,
    stockName,
    weight,
    buyDate: buyDateStr,
    buyTime: buyTimeStr,
    costPrice,
    isSell: true,
    reasons,
    conditions,
    conclusion,
    detail: {
      closePrice,
      ma5,
      ma10,
      ma10Slope,
      change,
      techEmotion,
      resilienceScore: resilience,
    },
  };

  wsServer.broadcast({
    type: 'sell_point',
    mode,
    bucket: null,
    ts: Date.now(),
    data: { results: [hit], hitCount: 1, total: 1 },
    open: true,
  });

  let feishu;
  try {
    const card = feishuNotify.buildSellPointCard({
      sellStocks: [{
        stockName: hit.stockName,
        code: hit.code,
        weight: hit.weight,
        buyDate: hit.buyDate,
        buyTime: hit.buyTime,
        costPrice: hit.costPrice,
        reasons: hit.reasons,
        closePrice: hit.detail.closePrice,
      }],
      timestamp,
      mock: true,
    });
    feishu = await feishuNotify.sendFeishuCard(card);
  } catch (e) {
    feishu = { success: false, error: e.message };
  }

  return {
    success: true,
    target: { code: hit.code, name: hit.stockName },
    source: position ? 'position' : 'watchlist',
    mode,
    feishu,
  };
};

// ==================== MOCK 冰点转折延时观察 ====================
// 仅广播前端等待卡片（ice_delay_wait），不发飞书、不写 pending，避免影响真实延时状态
const mockIceDelay = async () => {
  const mode = strategyModeState.getMode();
  const now = dayjs();
  const executeAt = iceDelayBuy.computeExecuteAt(now);
  const data = {
    phase: 'wait',
    mock: true,
    source: 'tech',
    delayMin: iceDelayBuy.DELAY_MIN,
    triggerTime: now.format('HH:mm'),
    executeTime: executeAt.format('HH:mm'),
    message: '（MOCK）冰点转折：买点已触发，需延时 15 分钟观察资金聚焦主线板块后再执行买入',
  };
  wsServer.broadcast({ type: 'ice_delay_wait', mode, bucket: null, ts: Date.now(), data, open: true });
  return { success: true, mode, target: null };
};

// ==================== MOCK 首板起爆（2026-11-01 用户要求）====================
// 三个入口：竞价买点诊断 / 开盘买点诊断（盘中 +8%）/ 卖点诊断
//   均走与线上一致的链路：WS 推送（first_board_wash_buy / sell_point，open:true）+ 飞书卡片；
//   卡片中的买入时间、买入条件、卖出条件全部引用线上真实常量，不做自定义阈值
const fmtHm = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
const gainText2 = (v) => (v == null || Number.isNaN(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 标的：优先候选股（非交易日/盘前为上一交易日候选），没有则从全量自选股随机取一只
const pickFirstBoardWashTarget = async () => {
  try {
    const d = await firstBoardWashLive.getDisplayData();
    const c = pickRandom(d && d.candidates);
    if (c && c.code) {
      return {
        code: c.code,
        name: c.name || c.code,
        board: c.board || '',
        washout: c.washout || null,
        floatMvYi: c.floatMvYi != null ? c.floatMvYi : null,
        source: 'candidate',
      };
    }
  } catch (e) { /* 候选股计算失败 → 回退自选股 */ }
  const s = pickRandom(getMonitorStocks() || []);
  if (!s) return null;
  return { code: s.code, name: s.name || s.code, board: '', washout: null, floatMvYi: null, source: 'watchlist' };
};

// 真实盘口（失败回退 mock 价），让卡片价格尽量贴近真实行情
const fetchQuoteSafe = async (code) => {
  try {
    const q = await getRealtimeQuotes([code]);
    const item = q && q[code];
    if (!item) return null;
    const price = item.price != null ? Number(item.price) : null;
    const preclose = item.preclose != null ? Number(item.preclose) : null;
    if (!(price > 0) || !(preclose > 0)) return null;
    return { price, preclose, change: ((price - preclose) / preclose) * 100 };
  } catch (e) { return null; }
};

const firstBoardWashRules = () => ({
  buyTriggerPct: firstBoardWashLive.BUY_TRIGGER_PCT,
  auctionBuyPct: firstBoardWashLive.BUY_OPEN_GAP_AUCTION_PCT,
  buyWindow: `${fmtHm(firstBoardWashLive.BUY_START_MINUTE)}-${fmtHm(firstBoardWashLive.BUY_CUTOFF_MINUTE)}`,
  maxPullbacks: firstBoardWashLive.MAX_INTRADAY_PULLBACKS,
  maxFloatMvYi: firstBoardWashLive.MAX_FLOAT_MV_YI,
});

// 候选股缺失（回退自选股）时补齐一份符合线上阈值的洗盘形态/流通市值，便于卡片完整展示真实阈值口径
const mockWashout = (target, price) => target.washout || {
  washDays: rndInt(WASHOUT_OPT.minWashDays, WASHOUT_OPT.maxWashDays),
  rangePct: rnd(WASHOUT_OPT.minRangePct * 100 + 1, WASHOUT_OPT.maxRangePct * 100 - 1),
  platformHigh: +(Number(price) * rnd(1.0, 1.1)).toFixed(2),
  maxWin3Pct: rnd(8, 19),
};

const emitFirstBoardWashBuyMock = async (stock, { checks = [], remind = false } = {}) => {
  wsServer.broadcast({
    type: 'first_board_wash_buy',
    ts: Date.now(),
    open: true,
    data: {
      date: dayjs().format('YYYYMMDD'),
      stocks: [stock],
      checks,
      positionHint: stock.positionHint,
      remind,
      strategy: 'first_board_wash',
      rules: firstBoardWashRules(),
      mock: true,
    },
  });
  let feishu;
  try {
    feishu = await feishuNotify.sendFeishuCard(feishuNotify.buildFirstBoardWashBuyCard({
      buyStocks: [stock],
      timestamp: stock.timestamp,
      positionHint: stock.positionHint,
      mock: true,
    }));
  } catch (e) {
    feishu = { success: false, error: e.message };
  }
  return feishu;
};

// 竞价买点：竞价涨幅 ≥ 5% 且未到涨停（一字板买不进）→ 9:30 按竞价开盘价直接买入
const mockFirstBoardWashAuctionBuy = async () => {
  const target = await pickFirstBoardWashTarget();
  if (!target) return { success: false, error: '候选股与自选股均为空，无法 mock' };

  const timestamp = fmtNow();
  const quote = await fetchQuoteSafe(target.code);
  const preclose = quote ? quote.preclose : rnd(20, 80);
  const limitThr = limitUpThresholdOf(target.code);
  const minGap = firstBoardWashLive.BUY_OPEN_GAP_AUCTION_PCT;
  const upper = Math.max(minGap + 1.5, limitThr - 0.3);
  let gap = quote && quote.change >= minGap && quote.change < limitThr ? quote.change : rnd(minGap + 0.3, upper);
  gap = +Math.min(gap, limitThr - 0.01).toFixed(2);
  const price = +(preclose * (1 + gap / 100)).toFixed(2);

  const stock = {
    stockName: target.name,
    name: target.name,
    code: target.code,
    board: target.board,
    mode: 'auction',
    modeText: `${fmtHm(firstBoardWashLive.BUY_START_MINUTE)} 竞价高开 ${gainText2(gap)}（≥ ${minGap}%）按竞价开盘价直接买入`,
    minute: fmtHm(firstBoardWashLive.BUY_START_MINUTE),
    price,
    change: gap,
    auctionGap: gap,
    floatMvYi: target.floatMvYi != null ? target.floatMvYi : rnd(20, 95),
    washout: mockWashout(target, price),
    positionHint: '半仓（50%）——账户拆两份、每份半仓，最多同时持有 2 只不同股票，各自独立买卖',
    timestamp,
    mock: true,
  };

  const feishu = await emitFirstBoardWashBuyMock(stock, {
    checks: firstBoardWashLive.buildBuyChecks({
      cand: { code: stock.code, washout: stock.washout, floatMvYi: stock.floatMvYi, lastClose: preclose },
      mode: 'auction', minute: firstBoardWashLive.BUY_START_MINUTE, price, change: gap, auctionGap: gap,
    }),
    remind: true,
  });
  return { success: true, target: { code: target.code, name: target.name }, source: target.source, kind: 'auction', feishu };
};

// 开盘买点：9:30-9:40 分时涨幅首次达 +8%（最多 1 次回落、起爆价 ≥ 平台高点 × 0.80）
const mockFirstBoardWashBurstBuy = async () => {
  const target = await pickFirstBoardWashTarget();
  if (!target) return { success: false, error: '候选股与自选股均为空，无法 mock' };

  const timestamp = fmtNow();
  const quote = await fetchQuoteSafe(target.code);
  const preclose = quote ? quote.preclose : rnd(20, 80);
  const limitThr = limitUpThresholdOf(target.code);
  const minChg = firstBoardWashLive.BUY_TRIGGER_PCT;
  const upper = Math.max(minChg + 1.5, Math.min(limitThr - 0.3, 9.8));
  let chg = quote && quote.change >= minChg && quote.change < limitThr ? quote.change : rnd(minChg + 0.3, upper);
  chg = +Math.min(chg, limitThr - 0.01).toFixed(2);
  const price = +(preclose * (1 + chg / 100)).toFixed(2);
  const nowMinute = dayjs().hour() * 100 + dayjs().minute();
  const minute = nowMinute >= firstBoardWashLive.BUY_START_MINUTE && nowMinute <= firstBoardWashLive.BUY_CUTOFF_MINUTE
    ? nowMinute
    : rndInt(firstBoardWashLive.BUY_START_MINUTE + 1, firstBoardWashLive.BUY_CUTOFF_MINUTE - 1);
  // 走 +8% 买点说明竞价未达 5%（否则 9:30 已竞价买入）
  const auctionGap = +(quote ? Math.min(quote.change, firstBoardWashLive.BUY_OPEN_GAP_AUCTION_PCT - 0.3) : rnd(0.5, 4.5)).toFixed(2);

  const stock = {
    stockName: target.name,
    name: target.name,
    code: target.code,
    board: target.board,
    mode: 'burst',
    modeText: `盘中 ${fmtHm(minute)} 分时涨幅 ${gainText2(chg)} 首次达到 +${minChg}%（最多 ${firstBoardWashLive.MAX_INTRADAY_PULLBACKS} 次回落；起爆价 ≥ 平台高点 × ${WASHOUT_OPT.breakoutMinRatio}）`,
    minute: fmtHm(minute),
    price,
    change: chg,
    auctionGap,
    floatMvYi: target.floatMvYi != null ? target.floatMvYi : rnd(20, 95),
    washout: mockWashout(target, price),
    positionHint: '半仓（50%）——账户拆两份、每份半仓，最多同时持有 2 只不同股票，各自独立买卖',
    timestamp,
    mock: true,
  };

  const feishu = await emitFirstBoardWashBuyMock(stock, {
    checks: firstBoardWashLive.buildBuyChecks({
      cand: { code: stock.code, washout: stock.washout, floatMvYi: stock.floatMvYi, lastClose: preclose },
      mode: 'burst', minute, price, change: chg, auctionGap,
    }),
  });
  return { success: true, target: { code: target.code, name: target.name }, source: target.source, kind: 'burst', feishu };
};

// 卖点诊断：命中「跌破 5 日线（盘中）」+「跌破成本线 -5%（立即卖出）」两个真实条件，
//   其余条件按线上真实阈值给出未触发明细（成本 -3% 连续 5 分钟、盘中 ≤ -9%、涨停次日收盘变脸、+20% 后收盘破 5 日线）
const mockFirstBoardWashSell = async () => {
  const target = await pickFirstBoardWashTarget();
  if (!target) return { success: false, error: '候选股与自选股均为空，无法 mock' };

  const positions = getStockPositions() || [];
  const pos = positions.find((p) => p && p.code === target.code) || null;
  const timestamp = fmtNow();
  const quote = await fetchQuoteSafe(target.code);
  const closePrice = +(quote ? quote.price : rnd(20, 80)).toFixed(2);
  const change = +(quote ? quote.change : rnd(-7, -5)).toFixed(2);
  const preclose = +(quote ? quote.preclose : closePrice / (1 + change / 100)).toFixed(2);

  // 成本价：持仓用真实成本；否则按浮亏 5.5%~7.5% 反推（保证跌破 -5% 与 -3%）
  const realCost = pos && pos.costPrice != null && Number.isFinite(Number(pos.costPrice)) && Number(pos.costPrice) > 0
    ? Number(pos.costPrice)
    : +(closePrice / (1 - rnd(0.055, 0.075))).toFixed(2);
  const costPrice = +realCost.toFixed(2);
  const stopPx = +(costPrice * (1 + -3 / 100)).toFixed(2);
  const hardStopPx = +(costPrice * (1 + -5 / 100)).toFixed(2);
  const costPct = +(((closePrice - costPrice) / costPrice) * 100).toFixed(2);

  const ma5 = +(closePrice * rnd(1.004, 1.02)).toFixed(2);
  const ma5GapPct = +(((closePrice - ma5) / ma5) * 100).toFixed(2);
  const openChg = -rnd(1, 3);
  const openPx = +(preclose * (1 + openChg / 100)).toFixed(2);
  const minChg = +Math.min(change, 0).toFixed(2);
  const costRun = rndInt(1, 4);

  // 买入日：持仓用真实买入日；否则取最近一个交易日（getPastTradingDates 为 async，需 await 后取最后一项）
  let buyDate = pos && pos.buyDate ? pos.buyDate : null;
  if (!buyDate) {
    try {
      const dates = ((await getPastTradingDates(dayjs().format('YYYYMMDD'), 1)) || []).map(String);
      const last = dates[dates.length - 1];
      if (last) buyDate = `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`;
    } catch (e) { /* 忽略，走兜底 */ }
    if (!buyDate) buyDate = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  }
  const buyTime = (pos && pos.buyTime) || '09:35';
  const weight = pos && pos.weight != null ? pos.weight : 25;

  const mk = (name, satisfied, detail, extra = {}) => ({
    name,
    satisfied,
    detail,
    exempted: !!extra.exempted,
    pending: !!extra.pending,
    pendingMinutes: extra.pendingMinutes != null ? extra.pendingMinutes : null,
  });

  const conditions = [
    mk('买入次一交易日竞价低开 → 9:30 直接卖出', true,
      `今日为买入次一交易日，竞价开盘 09:30 价 ${openPx.toFixed(2)}（昨收 ${preclose.toFixed(2)}，开盘涨幅 ${openChg.toFixed(2)}%），竞价低开 → 9:30 按竞价价直接卖出`),
    mk('盘中跌停（当日 ≤ -9%）', minChg <= -9,
      `当日最低分时涨跌幅 ${minChg}%（昨收 ${preclose.toFixed(2)}），${minChg <= -9 ? '已跌停，立即卖出' : '未达 -9%'}`),
    mk('跌破成本线 -5%（立即卖出）', true,
      `成本 ${costPrice.toFixed(2)}，止损价 ${hardStopPx.toFixed(2)}，现价 ${closePrice.toFixed(2)}（较成本 ${costPct}%），已跌破 -5%，立即卖出`),
    mk('连续 5 分钟跌破成本线 -3%', false,
      `成本 ${costPrice.toFixed(2)}，观察价 ${stopPx.toFixed(2)}；当前最长连续跌破 ${costRun} 分钟，未满足`,
      { pendingMinutes: costRun }),
    mk('跌破 5 日线（盘中）', true,
      `MA5 ${ma5.toFixed(2)}，现价 ${closePrice.toFixed(2)}（低于 5 日线 ${ma5GapPct}%）`),
    mk('买入当日涨停而次日收盘未涨停 → 收盘卖出', false,
      '未到收盘判定时间（14:56 起判定）', { pending: true }),
    mk('收益率已拉开 +20% 后收盘跌破 5 日线', false,
      '收益率未拉开 +20%，不适用'),
  ];

  const hitConds = conditions.filter((c) => c.satisfied && !c.exempted);
  const reasons = hitConds.map((c) => c.detail);
  const hit = {
    positionId: pos ? (pos.id || pos.code) : target.code,
    code: target.code,
    stockName: target.name,
    weight,
    buyDate,
    buyTime,
    costPrice,
    isSell: true,
    reasons,
    conditions,
    conclusion: '已触发首板洗盘-起爆拉升卖点条件，建议卖出 / 减仓。',
    sellStrategy: 'first_board_wash',
    minuteBased: true,
    detail: {
      closePrice,
      change,
      preclose,
      ma5,
      maxCloseGainPct: rnd(3, 12),
      costPrice,
    },
    mock: true,
  };

  wsServer.broadcast({
    type: 'sell_point',
    mode: strategyModeState.getMode(),
    bucket: null,
    ts: Date.now(),
    data: { results: [hit], hitCount: 1, total: 1, mock: true },
    open: true,
  });

  let feishu;
  try {
    feishu = await feishuNotify.sendFeishuCard(feishuNotify.buildSellPointCard({
      sellStocks: [{
        stockName: hit.stockName,
        code: hit.code,
        weight: hit.weight,
        buyDate: hit.buyDate,
        buyTime: hit.buyTime,
        costPrice: hit.costPrice,
        reasons: hit.reasons,
        closePrice: hit.detail.closePrice,
      }],
      timestamp,
      mock: true,
    }));
  } catch (e) {
    feishu = { success: false, error: e.message };
  }

  return { success: true, target: { code: hit.code, name: hit.stockName }, source: pos ? 'position' : target.source, kind: 'sell', feishu };
};

module.exports = { mockBuyPoint, mockSellPoint, mockIceDelay, mockFirstBoardWashAuctionBuy, mockFirstBoardWashBurstBuy, mockFirstBoardWashSell };
