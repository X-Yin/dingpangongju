// 调试面板 MOCK 服务：手动触发「买点 / 卖点」命中，走与实盘一致的推送 + 飞书链路
//   - 绕过 10s ticker 的 5 分钟桶门控，点击即刻推送
//   - 飞书卡片额外标注【MOCK 测试卡片】
//   - 2026-10-21 用户要求：MOCK 数据按线上真实诊断条件结构填充（条件名 / 阈值 / 文案与实盘一致），
//     数值可 mock 但必须满足各条件的最低阈值要求——买点 9 项检查全部通过、卖点命中 1~2 个真实条件
const dayjs = require('dayjs');
const { getMonitorStocks } = require('./monitorStock');
const { getStockPositions } = require('./stockPosition');
const { getSingleStockTlineData } = require('./stock');
const strategyModeState = require('./strategyModeState');
const wsServer = require('../wsServer');
const feishuNotify = require('./feishuNotify');

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

module.exports = { mockBuyPoint, mockSellPoint };
