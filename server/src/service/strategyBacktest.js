const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getIndexTlineByDate } = require('./fupan');
const { getAllIndexKlineData, getAllTechIndexData } = require('./emotion');
const { getMonitorStocks } = require('./monitorStock');
const { getSingleStockTlineDataByDate } = require('./stock');
const { getActiveProvider, getHeaders, buildRequestBody } = require('../utils/aiProvider');

const amountSnapshotDir = path.resolve(__dirname, '../data/amountSnapshot');
const fundSnapshotDir = path.resolve(__dirname, '../data/fundSnapshot');

const STRATEGY_DEFINITIONS = {
  high_open_low_close: {
    id: 'high_open_low_close',
    name: '高开容易低走',
    type: 'bearish',
    description: '自选股中多只股票接近涨停板高开，易形成高开低走局面',
    detail: [
      '【检测时段】9:25 - 9:45（集合竞价至开盘15分钟内）',
      '【判断条件】同时满足以下两条：',
      '  ① 主板股（sh60/sz0开头，涨停10%）高开 ≥ 5%，创业板/科创板（sz3/sh688开头，涨停20%）高开 ≥ 10%',
      '  ② 高开股票占比 ≥ 10%，且高开股票只数 ≥ 3只',
      '【判定利空】大量个股高开接近涨停，往往形成高开低走、获利盘出逃局面',
    ].join('\n'),
  },
  v_shape_reversal: {
    id: 'v_shape_reversal',
    name: 'V形反转',
    type: 'bullish',
    description: '情绪冰点次日量价齐升，V形反转信号',
    detail: [
      '【前置条件】满足以下任一即视为情绪冰点（或关系）：',
      '  ① 前一交易日科技情绪指数 < -30',
      '  ② 当日科技情绪分时触及冰点（hasIce: true）',
      '【检测时段】全天交易时段（9:30-11:30, 13:00-15:00），每个快照检测点',
      '【判断条件】同时满足以下三条（在冰点前提下）：',
      '  ① 主力资金净流入较上一快照点增加（净流入扩大或净流出收窄）',
      '  ② 两市成交额较上一快照点放大 ≥ 50亿',
      '  ③ 创业板指或科创50在过去约5分钟内上涨',
      '【判定利好】冰点后量价齐升是市场V形反转的重要信号，资金回流+放量+指数上涨三者共振',
    ].join('\n'),
  },
  volume_shrink_stagnation: {
    id: 'volume_shrink_stagnation',
    name: '先放量后缩量滞涨',
    type: 'bearish',
    description: '成交量持续缩小，指数滞涨，警惕回调',
    detail: [
      '【检测时段】全天交易时段，每个快照检测点',
      '【判断条件】同时满足以下三条：',
      '  ① 当前成交量较约15-20分钟前萎缩 ≥ 80亿（持续缩量）',
      '  ② 最近3个快照点成交量未出现有效放大（持续缩小或横盘趋势）',
      '  ③ 创业板指或科创50在过去约5分钟内涨幅 ≤ 0.1%（指数滞涨，不再创新高）',
      '【判定利空】放量上攻后成交量持续萎缩而指数滞涨，说明上攻动能不足，多方力量衰竭，容易回落。触发后有冷却期避免重复提醒。',
    ].join('\n'),
  },
  outflow_fake_rally: {
    id: 'outflow_fake_rally',
    name: '资金流出诱多上涨',
    type: 'bearish',
    description: '主力资金持续净流出但指数仍在上涨，诱多信号',
    detail: [
      '【检测时段】全天交易时段，每个快照检测点',
      '【判断条件】同时满足以下两条：',
      '  ① 当前主力资金净流入 < 上一快照点，且当前值 < -5亿（资金净流出超过5亿且流出扩大）',
      '  ② 创业板指或科创50在过去约5分钟内涨幅 > 0.1%（指数还在涨）',
      '【判定利空】资金出逃但指数虚涨，属于典型的诱多走势，需警惕后续快速下跌',
    ].join('\n'),
  },
  low_open_wash_recovery: {
    id: 'low_open_wash_recovery',
    name: '低开假摔洗盘后拉升',
    type: 'bullish',
    description: '开盘下挫后V形反转，洗盘结束拉升信号',
    detail: [
      '【检测时段】10:30 - 11:00（开盘后1小时内完成洗盘拉升）',
      '【判断条件】同时满足以下三条（创业板或科创板任一满足）：',
      '  ① 指数从开盘价最低下跌 > 1.2%（假摔幅度足够大）',
      '  ② 从最低点反弹幅度 > 0.8%（有资金承接拉升）',
      '  ③ 当前价格回升至开盘价的 99.8% 以上（几乎完全收复失地）',
      '【判定利好】开盘下挫洗出恐慌盘后快速拉回，是典型的洗盘结束信号',
    ].join('\n'),
  },
  straight_rise_no_volume: {
    id: 'straight_rise_no_volume',
    name: '无量直线拉升易回落',
    type: 'bearish',
    description: '指数快速拉升但成交量不配合，容易冲高回落',
    detail: [
      '【检测时段】全天交易时段，每个快照检测点',
      '【判断条件】同时满足以下两条：',
      '  ① 创业板指或科创50在过去约5-8分钟内涨幅 > 0.5%（快速拉升）',
      '  ② 同期两市成交额增量 < 100亿（成交量明显不配合）',
      '【判定利空】无量直线拉升缺乏资金支撑，属于虚拉，后续大概率回落',
    ].join('\n'),
  },
  volume_price_surge: {
    id: 'volume_price_surge',
    name: '量价齐升',
    type: 'bullish',
    description: '成交量放大、资金净流入≥10亿且增加、指数上涨，三者共振偏利好',
    detail: [
      '【检测时段】全天交易时段（9:30-11:30, 13:00-15:00），每隔约5分钟检测一次',
      '【判断条件】同时满足以下四条：',
      '  ① 两市成交额较约5分钟前放大 ≥ 100亿（显著放量）',
      '  ② 主力资金净流入 ≥ 10亿（大规模资金进场）',
      '  ③ 主力资金净流入较约5分钟前增加（净流入扩大，资金在进场）',
      '  ④ 创业板指或科创50在过去约5分钟内上涨 > 0.3%（指数配合上涨）',
      '【判定利好】量、价、资金三者同步向上，且资金净流入≥10亿，是健康上涨信号，多方力量占优',
    ].join('\n'),
  },
  panic_outflow: {
    id: 'panic_outflow',
    name: '恐慌盘出逃',
    type: 'bearish',
    description: '成交量持续放大+主力资金持续净流出加速且净流出≥10亿，恐慌盘在出逃',
    detail: [
      '【检测时段】全天交易时段（9:30-11:30, 13:00-15:00），每约10分钟检测一次',
      '【判断条件】同时满足以下三条（无需指数配合）：',
      '  ① 两市成交额较约15分钟前放大 ≥ 100亿（放量，抛盘涌出）',
      '  ② 主力资金较约10分钟前开始减少（资金出逃加速）',
      '  ③ 主力资金净流出 ≥ 10亿（大规模资金出逃才算恐慌盘）',
      '【判定利空】放量+资金加速出逃+净流出≥10亿，说明恐慌盘正在涌出，空方力量占优。触发后有20分钟冷却期。',
    ].join('\n'),
  },
  prev_day_high_open_low_close_volume: {
    id: 'prev_day_high_open_low_close_volume',
    name: '前一日高开低走+放量',
    type: 'neutral',
    description: '前一日高开低走且放量，次日竞价方向决定走势方向',
    detail: [
      '【检测时段】9:30 开盘时检测一次（基于创业板指日K线）',
      '【前置条件】前一日K线同时满足以下两条：',
      '  ① 高开低走：开盘价 > 前收价（高开）且 收盘价 < 开盘价（低走）',
      '  ② 放量：前一日成交量 > 上上个交易日成交量 × 1.05（放量超过5%）',
      '【判断条件】在前置条件满足时，根据当日竞价方向判断：',
      '  • 当日竞价平开或高开（开盘价 ≥ 前日收盘价）→ 判定利好，当日大概率反弹',
      '  • 当日竞价低开（开盘价 < 前日收盘价）→ 判定利空，当日大概率继续下跌',
      '【交易启示】次日竞价是核心观察窗口。若资金愿意高开解放前日套牢盘，说明当日回落为洗盘而非出货；若直接低开闷杀，则前日放量多为真出货或恐慌盘涌出。',
    ].join('\n'),
  },
  prev_day_volume_price_bottom: {
    id: 'prev_day_volume_price_bottom',
    name: '前一日地量地价',
    type: 'neutral',
    description: '前一日缩量大幅下跌（地量地价），次日竞价方向决定走势方向',
    detail: [
      '【检测时段】9:30 开盘时检测一次（基于创业板指日K线）',
      '【前置条件】前一日K线同时满足以下两条：',
      '  ① 大幅下跌：涨跌幅 < -1%（地价）',
      '  ② 缩量：前一日成交量 < 上上个交易日成交量 × 0.95（缩量超过5%）',
      '【判断条件】在前置条件满足时，根据当日竞价方向判断：',
      '  • 当日竞价平开或高开（开盘价 ≥ 前日收盘价）→ 判定利好，当日大概率上涨反弹',
      '  • 当日竞价低开（开盘价 < 前日收盘价）→ 判定利空，当日大概率继续下跌',
      '【交易启示】地量地价后次日竞价高开/平开往往受隔夜情绪催化实现反弹；若继续大低开则可能受外围利空拖累继续下跌。',
    ].join('\n'),
  },
  afternoon_large_inflow: {
    id: 'afternoon_large_inflow',
    name: '午后大量流入',
    type: 'bullish',
    description: '午后主力资金大量流入，相较11:30大幅增加或近5分钟急速流入',
    detail: [
      '【检测时段】13:00 - 14:00，每3分钟轮询检测一次',
      '【判断条件】满足以下任一条即触发（或关系）：',
      '  ① 当前主力资金净流入相较 11:30 的资金净流入增加 ≥ 80亿',
      '  ② 最近5分钟主力资金净流入增加 ≥ 20亿',
      '【判定利好】午后资金大量流入说明主力在午后积极进场，是看多信号',
    ].join('\n'),
  },
  prev_day_tail_rally: {
    id: 'prev_day_tail_rally',
    name: '前一日尾盘拉升',
    type: 'neutral',
    description: '前一日尾盘（14:00至收盘）出现明显拉升，次日竞价方向决定走势方向',
    detail: [
      '【检测时段】9:30 开盘时检测一次（基于创业板指和科创50分时数据）',
      '【前置条件】前一日创业板指或科创50尾盘拉升：14:00至收盘区间，最低价到收盘价拉升幅度 ≥ 1%',
      '【判断条件】在前置条件满足时，根据当日竞价方向判断：',
      '  • 当日竞价高开（开盘价 > 前日收盘价）→ 判定中性，需要持续观察，可能高开低走或高举高打',
      '  • 当日竞价低开或平开（开盘价 ≤ 前日收盘价）→ 判定利空，当日大概率低开低走大阴线',
      '【交易启示】尾盘拉升次日高开五五开，但低开基本确定当日下跌，需及时清仓避险。',
    ].join('\n'),
  },
  inflow_rise_volume_shrink: {
    id: 'inflow_rise_volume_shrink',
    name: '资金流入+指数上涨+严重缩量',
    type: 'bearish',
    description: '资金持续净流入且指数上涨，但成交量严重萎缩，量价背离，容易冲高回落',
    detail: [
      '【检测时段】全天交易时段（9:30-11:30, 13:00-15:00），每隔约10分钟检测一次，午休时间不算',
      '【判断条件】同时满足以下四条：',
      '  ① 当前主力资金净流入较10分钟前增加 ≥ 5亿（资金持续净流入）',
      '  ② 创业板指或科创50当前价格较10分钟前处于上涨状态（指数配合上涨，任一满足即可）',
      '  ③ 当前成交量差值较10分钟前增加 ≤ 50亿（量能相对值增加不多）',
      '  ④ 当前成交量差值（相较昨日同时段）< -500亿（量能绝对值明显萎缩，严重缩量）',
      '【判定利空】资金虽然在持续净流入且指数配合上涨，但是量能萎缩严重，量价背离，容易冲高回落，切勿追高。',
    ].join('\n'),
  },
  overnight_crisis_escape: {
    id: 'overnight_crisis_escape',
    name: '隔夜危机跑路',
    type: 'bearish',
    description: '隔夜重大危机下，开盘科技股拉升但主力资金净流出，量价背离，冲高清仓机会',
    detail: [
      '【场景背景】隔夜发生重大危机事件（如美股暴跌、战争突发、关税利空等），9:30竞价开盘时科技情绪往往低于 -50',
      '【检测时段】9:30 - 10:00，每隔约2分钟轮询检测一次',
      '【判断条件】同时满足以下两条：',
      '  ① 大盘主力资金净流出（当前主力资金净流入 < 0）',
      '  ② 科技分时情绪相较约5分钟前上升（科技股虚拉，但资金在撤退，量价背离）',
      '【判定利空】开盘科技股直线拉升是诱多信号，主力资金实际在净流出，量价背离，是冲高清仓的机会。触发后有30分钟冷却期避免重复提醒。',
    ].join('\n'),
  },
  ebb_tide_direct_reversal: {
    id: 'ebb_tide_direct_reversal',
    name: '退潮直接反转',
    type: 'bearish',
    description: '前一日创业板指或科创50大跌超过-2%，次日直接反转概率仅23%，提示不要追涨',
    detail: [
      '【检测时段】9:30 开盘时检测一次（基于创业板指和科创50日K线）',
      '【前置条件】前一日创业板指或科创50涨跌幅 ≤ -2%（大跌超过2%）',
      '【判断条件】满足前置条件即触发（或关系，任一指数大跌即触发）',
      '【判定利空】前一日大跌退潮后，次日直接反转的概率只有 23%，不要追涨！就算参与只能 1/3 仓位参与',
    ].join('\n'),
  },
  opening_net_inflow: {
    id: 'opening_net_inflow',
    name: '开盘资金净流入',
    type: 'neutral',
    description: '通过9:30-9:35开盘前5分钟大盘主力资金净流动方向，预判当天大盘走势',
    detail: [
      '【检测时段】9:35 检测一次（判定 9:30 - 9:35 开盘前5分钟大盘主力资金净流动）',
      '【判定逻辑】设 F = 9:35 主力资金累计净流入 - 9:30 开盘累计净流入（负数为净流出）：',
      '  ① F < -60亿（净流出超过60亿）→ 判定利空，当天大概率大盘大幅下跌，谨慎出手',
      '  ② F ≥ -10亿（净流出≤10亿，含小幅流出与净流入）→ 判定利好，当天大概率大盘回暖，可适当出手',
      '  ③ -60亿 ~ -10亿 之间不触发',
    ].join('\n'),
  },
  high_open_high_walk: {
    id: 'high_open_high_walk',
    name: '高开高走',
    type: 'bullish',
    description: '指数高开>0.5%且科技情绪≥30，9:41确认未从高点回落、资金持续净流入且两波流入各≥10亿，命中后可出手',
    detail: [
      '【检测时段】9:30 开盘提示一次 + 9:41 确认检测一次（9:41 检测仅在 9:30 前置条件满足时进行）',
      '【前置条件】9:30 开盘时同时满足以下两条：',
      '  ① 创业板指或科创50开盘涨幅 > 0.5%',
      '  ② 科技情绪指数 ≥ 30',
      '【9:30 提示】满足前置条件时提示：高开高走需要满足 9:40 之前指数持续上攻 & 资金持续净流入，有量能放大配合最好；若量能不放大，前一日必须满足情绪冰点。9:40 之前不要出手，9:40 之后出手，当日买入一般能有 3-4 个点的利润垫',
      '【9:41 确认条件】同时满足以下三条：',
      '  ① 创业板指（或触发高开的指数）当前价距当日最高点回落 ≤ 0.5%',
      '  ② 主力资金持续净流入（当天累计净流入为正）',
      '  ③ 9:30-9:35、9:35-9:40 两波主力资金净流入均 ≥ 10亿（实时在 9:41 用 9:35 至当前的流入近似）',
      '【判定结果】满足确认条件 → 命中高开高走可以出手（展示当天资金净流入、指数涨幅、量能 amountChangeDiff）；不满足 → 提示极易高开低走或冲高回落，不适合出手',
    ].join('\n'),
  },
  tail_dip_buying: {
    id: 'tail_dip_buying',
    name: '尾盘抄底',
    type: 'bullish',
    description: '全天科技情绪弱势（情绪指数<0 且 ≥-70），14:00→14:30 尾盘半小时放量≥50亿且创业板指涨幅回落，适合尾盘抄底，博弈次日反弹',
    detail: [
      '【检测时段】14:30 检测一次',
      '【判断条件】同时满足以下四条：',
      '  ① 当前科技情绪指数 < 0（全天科技情绪弱势）',
      '  ② 科技情绪指数 ≥ -70（两点半科技情绪不能低于-70，排除极端冰点）',
      '  ③ 当前成交量 amountChangeDiff 相较 14:00 的 amountChangeDiff 放大 ≥ 50亿（尾盘半小时放量）',
      '  ④ 创业板指 14:30 涨幅 < 14:00 涨幅（尾盘涨幅回落）',
      '【判定利好】全天科技情绪弱势，尾盘半小时放量，适合尾盘抄底，博弈次日的反弹。',
    ].join('\n'),
  },
  high_open_max_half_position: {
    id: 'high_open_max_half_position',
    name: '高开最多半仓',
    type: 'bearish',
    description: '创业板指或科创50高开超过0.5%，大A惯例高开容易低走，开盘加仓最多只能半仓',
    detail: [
      '【检测时段】9:30 开盘时检测一次（基于创业板指和科创50开盘涨幅）',
      '【判断条件】创业板指 或 科创50（任一）开盘涨幅 > 0.5%（高开超过0.5%）',
      '【判定利空】大 A 惯例高开容易低走，此时如果开盘想要加仓，最多只能买单半仓，分摊到两个个股身上就是各自 1/4 仓位。最后等到收盘的时候再视情况是否要把剩下的仓位加上。',
    ].join('\n'),
  },
};

const readJsonFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
};

const timeKeyToHhmm = (timeKey) => {
  const str = String(timeKey).padStart(6, '0');
  return parseInt(str.substring(0, 4));
};

const timeKeyToTotalMinutes = (timeKey) => {
  const str = String(timeKey).padStart(6, '0');
  const h = parseInt(str.substring(0, 2));
  const m = parseInt(str.substring(2, 4));
  return h * 60 + m;
};

const normalizeTimeKey = (t) => {
  let str = String(t);
  if (str.length === 4) str = '0' + str;
  return str.padStart(6, '0').substring(0, 6);
};

const formatMinutesToTime = (totalMinutes) => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const getAvailableDates = () => {
  const dates = new Set();
  if (fs.existsSync(fundSnapshotDir)) {
    fs.readdirSync(fundSnapshotDir).forEach(f => {
      const match = f.match(/(\d{8})\.json/);
      if (match) dates.add(match[1]);
    });
  }
  return Array.from(dates).sort().reverse();
};

const loadSnapshotData = (dateStr) => {
  const fundPath = path.join(fundSnapshotDir, `${dateStr}.json`);
  const amountPath = path.join(amountSnapshotDir, `${dateStr}.json`);
  
  const fundData = readJsonFile(fundPath) || [];
  const amountData = readJsonFile(amountPath) || [];
  
  return { fundData, amountData };
};

const getHighOpenThreshold = (code) => {
  const pureCode = code.replace(/^sh|^sz/, '');
  if (pureCode.startsWith('688') || pureCode.startsWith('3')) {
    return 10;
  }
  return 5;
};

const getStockLimitTypeName = (code) => {
  const pureCode = code.replace(/^sh|^sz/, '');
  if (pureCode.startsWith('688')) return '科创板';
  if (pureCode.startsWith('3')) return '创业板';
  return '主板';
};

const runBacktest = async (dateStr, strategyIds = null) => {
  if (!dateStr || !/^\d{8}$/.test(dateStr)) {
    throw new Error('日期格式错误，应为YYYYMMDD');
  }

  const { fundData, amountData } = loadSnapshotData(dateStr);
  
  if (fundData.length === 0 && amountData.length === 0) {
    return {
      success: false,
      message: `未找到 ${dateStr} 的快照数据，请选择其他日期`,
      date: dateStr,
      signals: []
    };
  }

  const indexTlines = await getIndexTlineByDate(dateStr);
  const indexKlineData = await getAllIndexKlineData();
  const allTechIndexData = getAllTechIndexData();

  // 获取前一交易日科技情绪指数，判断是否为情绪冰点（< -30）
  const targetDate = dayjs(dateStr, 'YYYYMMDD');
  let prevDayTechEmotion = null;
  let prevDayIsIcePoint = false;
  let prevDayHasIce = false;
  const sortedTechData = [...allTechIndexData]
    .filter(d => d.date && String(d.date).length === 8)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // 检查当日科技情绪分时是否触及冰点（hasIce: true）
  const targetDateNum = parseInt(dateStr);
  const todayTechItem = sortedTechData.find(d => parseInt(d.date) === targetDateNum);
  const todayHasIce = !!(todayTechItem && todayTechItem.hasIce === true);

  for (const techItem of sortedTechData) {
    const itemDate = dayjs(String(techItem.date), 'YYYYMMDD');
    if (itemDate.isBefore(targetDate, 'day')) {
      prevDayTechEmotion = parseFloat(techItem.changeSumResult);
      if (!isNaN(prevDayTechEmotion) && prevDayTechEmotion < -30) {
        prevDayIsIcePoint = true;
      }
      prevDayHasIce = !!(techItem && techItem.hasIce === true);
      break;
    }
  }

  // V形反转前置条件：前一日情绪 < -30 或 当日 hasIce: true（任一满足即可）
  const vShapePrerequisiteMet = prevDayIsIcePoint || todayHasIce;
  
  const hhmmToChartTime = (hhmm) => {
    const str = String(hhmm).padStart(4, '0');
    return `${str.substring(0, 2)}:${str.substring(2, 4)}`;
  };

  const prepareTlineChartData = (line) => {
    if (!line || line.length === 0) return [];
    return line
      .filter(item => item.minute && item.last_px)
      .map(item => ({
        time: hhmmToChartTime(item.minute),
        value: parseFloat(item.last_px),
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  };

  const prepareSnapshotChartData = (data, valueField) => {
    if (!data || data.length === 0) return [];
    return data
      .filter(item => item.time && item[valueField] !== undefined)
      .map(item => {
        const key = normalizeTimeKey(item.time);
        const time = `${key.substring(0, 2)}:${key.substring(2, 4)}`;
        return { time, value: parseFloat(item[valueField]) || 0 };
      })
      .sort((a, b) => a.time.localeCompare(b.time));
  };

  const prepareKlineChartData = (klineArr) => {
    if (!klineArr || klineArr.length === 0) return [];
    return klineArr
      .filter(item => item.trade_date && item.open_px)
      .map(item => {
        const d = String(item.trade_date);
        return {
          time: `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`,
          open: parseFloat(item.open_px),
          high: parseFloat(item.high_px),
          low: parseFloat(item.low_px),
          close: parseFloat(item.close_px),
        };
      })
      .sort((a, b) => a.time.localeCompare(b.time));
  };

  const chartData = {
    kline: {
      cyb: prepareKlineChartData(indexKlineData.chuangyebanData),
      kcb: prepareKlineChartData(indexKlineData.kechuangbanData),
    },
    tline: {
      cyb: prepareTlineChartData(indexTlines?.chuangyeban?.line),
      kcb: prepareTlineChartData(indexTlines?.kechuangban?.line),
    },
    fundFlow: prepareSnapshotChartData(fundData, 'mainMoney'),
    volume: prepareSnapshotChartData(amountData, 'amountChangeDiff'),
  };

  const allTimes = new Set();
  
  const fundMap = new Map();
  fundData.forEach(f => {
    const key = normalizeTimeKey(f.time);
    fundMap.set(key, f);
    allTimes.add(key);
  });
  
  const amountMap = new Map();
  amountData.forEach(a => {
    const key = normalizeTimeKey(a.time);
    amountMap.set(key, a);
    allTimes.add(key);
  });

  const cybLine = indexTlines?.chuangyeban?.line || [];
  const kcbLine = indexTlines?.kechuangban?.line || [];
  
  const buildIndexHistory = (line) => {
    if (!line || line.length === 0) return [];
    return line
      .filter(item => item.minute && item.last_px)
      .map(item => ({
        hhmm: parseInt(item.minute),
        last_px: parseFloat(item.last_px),
        open_px: parseFloat(item.open_px) || parseFloat(item.last_px),
      }))
      .sort((a, b) => a.hhmm - b.hhmm);
  };

  const cybHistory = buildIndexHistory(cybLine);
  const kcbHistory = buildIndexHistory(kcbLine);
  
  let cybOpenPx = null;
  let kcbOpenPx = null;
  
  if (cybHistory.length > 0) {
    const openPoint = cybHistory.find(h => h.hhmm >= 930 && h.hhmm < 935) || cybHistory[0];
    cybOpenPx = openPoint.open_px || openPoint.last_px;
  }
  if (kcbHistory.length > 0) {
    const openPoint = kcbHistory.find(h => h.hhmm >= 930 && h.hhmm < 935) || kcbHistory[0];
    kcbOpenPx = openPoint.open_px || openPoint.last_px;
  }

  const getIndexStateAt = (history, openPx, currentHhmm) => {
    const points = history.filter(h => h.hhmm <= currentHhmm);
    if (points.length < 2) return null;
    
    const latest = points[points.length - 1];
    const lowPx = Math.min(...points.map(p => p.last_px));
    const highPx = Math.max(...points.map(p => p.last_px));
    const changeFromOpen = openPx ? ((latest.last_px - openPx) / openPx) * 100 : 0;
    const reboundFromLow = lowPx ? ((latest.last_px - lowPx) / lowPx) * 100 : 0;
    
    let prevPoint = null;
    for (let i = points.length - 1; i >= 0; i--) {
      const gapH = Math.floor(currentHhmm / 100) - Math.floor(points[i].hhmm / 100);
      const gapM = (currentHhmm % 100) - (points[i].hhmm % 100);
      const gapTotalMin = gapH * 60 + gapM;
      if (gapTotalMin >= 4) {
        prevPoint = points[i];
        break;
      }
    }
    const change5min = prevPoint ? ((latest.last_px - prevPoint.last_px) / prevPoint.last_px) * 100 : 0;
    
    return { latest, lowPx, highPx, changeFromOpen, reboundFromLow, change5min, points };
  };

  const sortedTimes = Array.from(allTimes)
    .map(normalizeTimeKey)
    .filter(t => {
      const totalMin = timeKeyToTotalMinutes(t);
      return (totalMin >= 570 && totalMin <= 690) || (totalMin >= 780 && totalMin <= 900);
    })
    .sort();

  const signals = [];
  const triggeredStrategies = new Set();
  let dayLowCyb = Infinity;
  let dayLowKcb = Infinity;
  let cybRecovered = false;
  let kcbRecovered = false;
  let volumeShrinkLastTriggerTime = -999;
  let volumePriceSurgeLastTriggerTime = -999;
  let panicOutflowLastTriggerTime = -999;
  let inflowRiseVolumeShrinkLastTriggerTime = -999;
  let tailDipChecked = false;

  // 找11:30（上午收盘）的主力资金净流入，用于午后大量流入策略
  let fundAt1130 = null;
  for (const t of sortedTimes) {
    const tm = timeKeyToTotalMinutes(t);
    if (tm <= 690) {
      const f = fundMap.get(t);
      if (f) fundAt1130 = f;
    } else {
      break;
    }
  }

  // 找14:00（两点）的成交量快照，用于尾盘抄底策略（14:30 时对比放量）
  let amountAt1400 = null;
  for (const t of sortedTimes) {
    const tm = timeKeyToTotalMinutes(t);
    if (tm <= 840) {
      const a = amountMap.get(t);
      if (a && typeof a.amountChangeDiff === 'number') amountAt1400 = a;
    } else {
      break;
    }
  }

  // === Strategy 1: high_open_low_close ===
  // Check at 9:25-9:45 window using monitor stocks tline data fetched from 分时接口
  if ((!strategyIds || strategyIds.includes('high_open_low_close'))) {
    try {
      const monitorStocks = getMonitorStocks();
      let highOpenCount = 0;
      let totalValidCount = 0;
      const highOpenStocks = [];

      for (const stock of monitorStocks) {
        try {
          const tlineData = await getSingleStockTlineDataByDate(stock.code, parseInt(dateStr));
          if (!tlineData || !tlineData.line || tlineData.line.length === 0) continue;
          
          const preclosePx = tlineData.preclose_px;
          if (!preclosePx || preclosePx <= 0) continue;

          const line = tlineData.line.filter(p => p.minute && p.last_px).sort((a, b) => a.minute - b.minute);
          if (line.length === 0) continue;

          const openPoint = line.find(p => p.minute >= 930 && p.minute < 935) || line[0];
          const openPx = openPoint.last_px;
          if (!openPx) continue;

          totalValidCount++;
          const openChange = ((openPx - preclosePx) / preclosePx) * 100;
          const threshold = getHighOpenThreshold(stock.code);
          const limitType = getStockLimitTypeName(stock.code);

          if (openChange >= threshold) {
            highOpenCount++;
            highOpenStocks.push({
              name: stock.name || stock.code,
              code: stock.code,
              openChange: parseFloat(openChange.toFixed(2)),
              limitType,
              threshold,
            });
          }
        } catch (e) {
          // skip individual stock errors
        }
      }

      if (totalValidCount > 0) {
        const ratio = highOpenCount / totalValidCount;
        if (ratio >= 0.1 && highOpenCount >= 3) {
          triggeredStrategies.add('high_open_low_close');
          
          const highOpenList = highOpenStocks.slice(0, 8).map(s => 
            `${s.name}(${s.code}) +${s.openChange}%[${s.limitType}≥${s.threshold}%]`
          ).join('、');
          
          signals.push({
            time: '09:35',
            timeKey: '093500',
            signals: [{
              strategyId: 'high_open_low_close',
              title: '⚠️ 高开低走风险预警',
              description: `自选股中有 ${highOpenCount} 只股票高开（占比 ${(ratio * 100).toFixed(1)}%），达到涨停板附近阈值，警惕高开低走。\n高开门个股：${highOpenList}${highOpenStocks.length > 8 ? '...' : ''}`,
              isBullish: false,
            }]
          });
        }
      }
    } catch (e) {
      console.error('[backtest] 高开低走策略检测失败:', e.message);
    }
  }

  // === Strategy 9: prev_day_high_open_low_close_volume（前一日高开低走+放量）===
  // === Strategy 10: prev_day_volume_price_bottom（前一日地量地价）===
  // 基于创业板指日K线，9:30开盘时检测一次
  const cybKlineRaw = (indexKlineData.chuangyebanData || []).filter(k => k.trade_date && k.open_px).sort((a, b) => a.trade_date - b.trade_date);
  const todayKlineIdx = cybKlineRaw.findIndex(k => parseInt(k.trade_date) === targetDateNum);

  if (todayKlineIdx >= 2) {
    const todayKline = cybKlineRaw[todayKlineIdx];
    const yesterdayKline = cybKlineRaw[todayKlineIdx - 1];
    const dayBeforeYesterdayKline = cybKlineRaw[todayKlineIdx - 2];

    const todayOpen = parseFloat(todayKline.open_px);
    const yesterdayOpen = parseFloat(yesterdayKline.open_px);
    const yesterdayClose = parseFloat(yesterdayKline.close_px);
    const yesterdayPreclose = parseFloat(yesterdayKline.preclose_px);
    const yesterdayChange = parseFloat(yesterdayKline.change);
    const yesterdayVolume = parseFloat(yesterdayKline.business_amount);
    const dayBeforeVolume = parseFloat(dayBeforeYesterdayKline.business_amount);

    // Strategy 9: 前一日高开低走+放量
    if (!strategyIds || strategyIds.includes('prev_day_high_open_low_close_volume')) {
      try {
        const isHighOpen = yesterdayOpen > yesterdayPreclose;
        const isLowClose = yesterdayClose < yesterdayOpen;
        const isVolumeSurge = dayBeforeVolume > 0 && yesterdayVolume > dayBeforeVolume * 1.05;
        const volumeChangePct = dayBeforeVolume > 0 ? ((yesterdayVolume - dayBeforeVolume) / dayBeforeVolume) * 100 : 0;

        if (isHighOpen && isLowClose && isVolumeSurge) {
          const todayOpenChangePct = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
          const isTodayLowOpen = todayOpen < yesterdayClose;
          const yesterdayOpenPct = ((yesterdayOpen - yesterdayPreclose) / yesterdayPreclose) * 100;
          const yesterdayClosePct = ((yesterdayClose - yesterdayOpen) / yesterdayOpen) * 100;

          if (isTodayLowOpen) {
            // 低开 → 利空，继续下跌
            triggeredStrategies.add('prev_day_high_open_low_close_volume');
            signals.push({
              time: '09:30',
              timeKey: '093000',
              signals: [{
                strategyId: 'prev_day_high_open_low_close_volume',
                title: '⚠️ 前日高开低走放量，今日低开继续下跌',
                description: `前一日创业板指高开低走且放量：开盘${yesterdayOpenPct.toFixed(2)}%（高开）、收盘跌${yesterdayClosePct.toFixed(2)}%（低走）、放量${volumeChangePct.toFixed(1)}%（>5%）。今日竞价低开${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} < 前日收盘${yesterdayClose.toFixed(2)}），前日放量多为真出货或恐慌盘涌出，当日大概率继续下跌。`,
                isBullish: false,
              }]
            });
          } else {
            // 平开或高开 → 利好，反弹
            triggeredStrategies.add('prev_day_high_open_low_close_volume');
            signals.push({
              time: '09:30',
              timeKey: '093000',
              signals: [{
                strategyId: 'prev_day_high_open_low_close_volume',
                title: '✅ 前日高开低走放量，今日平开/高开大概率反弹',
                description: `前一日创业板指高开低走且放量：开盘${yesterdayOpenPct.toFixed(2)}%（高开）、收盘跌${yesterdayClosePct.toFixed(2)}%（低走）、放量${volumeChangePct.toFixed(1)}%（>5%）。今日竞价${todayOpenChangePct >= 0 ? '高开' : '平开'}${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} ≥ 前日收盘${yesterdayClose.toFixed(2)}），资金愿意高开解放前日套牢盘，说明前日回落为洗盘而非出货，当日大概率反弹。`,
                isBullish: true,
              }]
            });
          }
        }
      } catch (e) {
        console.error('[backtest] 前一日高开低走放量策略检测失败:', e.message);
      }
    }

    // Strategy 10: 前一日地量地价
    if (!strategyIds || strategyIds.includes('prev_day_volume_price_bottom')) {
      try {
        const isBigDrop = !isNaN(yesterdayChange) && yesterdayChange < -1;
        const isVolumeShrink = dayBeforeVolume > 0 && yesterdayVolume < dayBeforeVolume * 0.95;
        const volumeChangePct = dayBeforeVolume > 0 ? ((yesterdayVolume - dayBeforeVolume) / dayBeforeVolume) * 100 : 0;

        if (isBigDrop && isVolumeShrink) {
          const todayOpenChangePct = ((todayOpen - yesterdayClose) / yesterdayClose) * 100;
          const isTodayLowOpen = todayOpen < yesterdayClose;

          if (isTodayLowOpen) {
            // 低开 → 利空，继续下跌
            triggeredStrategies.add('prev_day_volume_price_bottom');
            signals.push({
              time: '09:30',
              timeKey: '093000',
              signals: [{
                strategyId: 'prev_day_volume_price_bottom',
                title: '⚠️ 前日地量地价，今日低开继续下跌',
                description: `前一日创业板指地量地价：涨跌幅${yesterdayChange.toFixed(2)}%（<-1%大幅下跌）、缩量${volumeChangePct.toFixed(1)}%（>5%缩量）。今日竞价低开${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} < 前日收盘${yesterdayClose.toFixed(2)}），可能受外围利空拖累，当日大概率继续下跌。`,
                isBullish: false,
              }]
            });
          } else {
            // 平开或高开 → 利好，反弹上涨
            triggeredStrategies.add('prev_day_volume_price_bottom');
            signals.push({
              time: '09:30',
              timeKey: '093000',
              signals: [{
                strategyId: 'prev_day_volume_price_bottom',
                title: '✅ 前日地量地价，今日平开/高开大概率反弹',
                description: `前一日创业板指地量地价：涨跌幅${yesterdayChange.toFixed(2)}%（<-1%大幅下跌）、缩量${volumeChangePct.toFixed(1)}%（>5%缩量）。今日竞价${todayOpenChangePct >= 0 ? '高开' : '平开'}${todayOpenChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} ≥ 前日收盘${yesterdayClose.toFixed(2)}），可能受隔夜情绪催化，当日大概率上涨反弹。`,
                isBullish: true,
              }]
            });
          }
        }
      } catch (e) {
        console.error('[backtest] 前一日地量地价策略检测失败:', e.message);
      }
    }

    // Strategy 11: prev_day_tail_rally（前一日尾盘拉升）
    if (!strategyIds || strategyIds.includes('prev_day_tail_rally')) {
      try {
        // 取前一交易日日期
        const prevDate = cybKlineRaw[todayKlineIdx - 1]?.trade_date;
        if (prevDate) {
          const indexTlines = await getIndexTlineByDate(prevDate);
          if (indexTlines) {
            const checkTailRally = (line) => {
              if (!line || line.length === 0) return null;
              const tailPoints = line.filter(p => p.minute >= 1400 && p.last_px);
              if (tailPoints.length === 0) return null;
              const lowPx = Math.min(...tailPoints.map(p => parseFloat(p.last_px)));
              const closePx = parseFloat(tailPoints[tailPoints.length - 1].last_px);
              if (isNaN(lowPx) || isNaN(closePx) || lowPx <= 0) return null;
              const rallyPct = ((closePx - lowPx) / lowPx) * 100;
              return { lowPx, closePx, rallyPct };
            };

            const cybRally = checkTailRally(indexTlines.chuangyeban?.line);
            const kcbRally = checkTailRally(indexTlines.kechuangban?.line);

            const cybHit = cybRally && cybRally.rallyPct >= 1;
            const kcbHit = kcbRally && kcbRally.rallyPct >= 1;

            if (cybHit || kcbHit) {
              let todayOpen = null, prevClose = null;
              if (cybHit && cybKlineRaw[todayKlineIdx - 1]) {
                todayOpen = parseFloat(todayKline.open_px);
                prevClose = parseFloat(cybKlineRaw[todayKlineIdx - 1].close_px);
              } else if (kcbHit) {
                const kcbKlineRaw = (indexKlineData.kechuangbanData || []).filter(k => k.trade_date && k.open_px).sort((a, b) => a.trade_date - b.trade_date);
                const kcbTodayIdx = kcbKlineRaw.findIndex(k => parseInt(k.trade_date) === targetDateNum);
                if (kcbTodayIdx >= 1) {
                  todayOpen = parseFloat(kcbKlineRaw[kcbTodayIdx].open_px);
                  prevClose = parseFloat(kcbKlineRaw[kcbTodayIdx - 1].close_px);
                }
              }

              if (todayOpen && prevClose && !isNaN(todayOpen) && !isNaN(prevClose)) {
                const openChangePct = ((todayOpen - prevClose) / prevClose) * 100;
                const isHighOpen = openChangePct > 0;

                const hitDetails = [];
                if (cybHit) {
                  hitDetails.push(`创业板指：14:00后最低${cybRally.lowPx.toFixed(2)}→收盘${cybRally.closePx.toFixed(2)}，拉升${cybRally.rallyPct.toFixed(2)}%`);
                }
                if (kcbHit) {
                  hitDetails.push(`科创50：14:00后最低${kcbRally.lowPx.toFixed(2)}→收盘${kcbRally.closePx.toFixed(2)}，拉升${kcbRally.rallyPct.toFixed(2)}%`);
                }

                triggeredStrategies.add('prev_day_tail_rally');
                if (isHighOpen) {
                  signals.push({
                    time: '09:30',
                    timeKey: '093000',
                    signals: [{
                      strategyId: 'prev_day_tail_rally',
                      title: '📊 前一日尾盘拉升，今日高开需持续观察',
                      description: `前一日（${prevDate}）${hitDetails.join('；')}。今日竞价高开${openChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} > 前日收盘${prevClose.toFixed(2)}），需要持续观察，可能高开低走，也可能是高举高打，概率五五开。`,
                      isBullish: true,
                    }]
                  });
                } else {
                  signals.push({
                    time: '09:30',
                    timeKey: '093000',
                    signals: [{
                      strategyId: 'prev_day_tail_rally',
                      title: '⚠️ 前一日尾盘拉升，今日低开大概率下跌',
                      description: `前一日（${prevDate}）${hitDetails.join('；')}。今日竞价低开${openChangePct.toFixed(2)}%（开盘价${todayOpen.toFixed(2)} < 前日收盘${prevClose.toFixed(2)}），当日大概率低开低走大阴线，情况不对要赶快清仓！`,
                      isBullish: false,
                    }]
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[backtest] 前一日尾盘拉升策略检测失败:', e.message);
      }
    }
  }

  // === Strategy 14: ebb_tide_direct_reversal（退潮直接反转）===
  // 前一日创业板指或科创50大跌超过-2%，次日直接反转概率仅23%
  if (!strategyIds || strategyIds.includes('ebb_tide_direct_reversal')) {
    try {
      const hits = [];
      // 创业板指
      if (todayKlineIdx >= 1) {
        const cybYesterdayChange = parseFloat(cybKlineRaw[todayKlineIdx - 1].change);
        if (!isNaN(cybYesterdayChange) && cybYesterdayChange <= -2) {
          hits.push({ name: '创业板指', change: cybYesterdayChange });
        }
      }
      // 科创50
      const kcbKlineRaw = (indexKlineData.kechuangbanData || [])
        .filter(k => k.trade_date && k.open_px)
        .sort((a, b) => a.trade_date - b.trade_date);
      const kcbTodayIdx = kcbKlineRaw.findIndex(k => parseInt(k.trade_date) === targetDateNum);
      if (kcbTodayIdx >= 1) {
        const kcbYesterdayChange = parseFloat(kcbKlineRaw[kcbTodayIdx - 1].change);
        if (!isNaN(kcbYesterdayChange) && kcbYesterdayChange <= -2) {
          hits.push({ name: '科创50', change: kcbYesterdayChange });
        }
      }

      if (hits.length > 0) {
        const hitDetails = hits.map(h => `${h.name}前一日涨跌幅 ${h.change.toFixed(2)}%`).join('，');
        const hitNames = hits.map(h => h.name).join('/');
        triggeredStrategies.add('ebb_tide_direct_reversal');
        signals.push({
          time: '09:30',
          timeKey: '093000',
          signals: [{
            strategyId: 'ebb_tide_direct_reversal',
            title: '⚠️ 退潮直接反转概率低，切勿追涨',
            description: `${hitDetails}。${hitNames}前一个交易日大跌超过-2%，次日直接反转的概率只有 23%，不要追涨！就算参与只能 1/3 仓位参与。`,
            isBullish: false,
          }]
        });
      }
    } catch (e) {
      console.error('[backtest] 退潮直接反转策略检测失败:', e.message);
    }
  }

  // === Strategy 16: high_open_high_walk（高开高走）===
  // 9:30 开盘提示：创业板指/科创50高开>0.5% 且 当日科技情绪指数≥30
  // 9:41 确认检测在下方主循环中进行（首个 >= 9:41 的快照点，资金窗口按 9:30-9:35 / 9:35-9:40 完整计算）
  let howPrereqMet = false;
  let howIndexName = null;
  let howPreclose = null;
  let howChecked = false;

  if (!strategyIds || strategyIds.includes('high_open_high_walk')) {
    try {
      // 当日科技情绪指数（tech_index.json 中该日 changeSumResult）
      const todayTechEmotionVal = todayTechItem ? parseFloat(todayTechItem.changeSumResult) : NaN;

      const todayCybKline = todayKlineIdx >= 0 ? cybKlineRaw[todayKlineIdx] : null;
      const cybPreclose = todayCybKline ? parseFloat(todayCybKline.preclose_px) : NaN;
      const kcbKlineRawAll = (indexKlineData.kechuangbanData || [])
        .filter(k => k.trade_date && k.open_px)
        .sort((a, b) => a.trade_date - b.trade_date);
      const kcbTodayIdxAll = kcbKlineRawAll.findIndex(k => parseInt(k.trade_date) === targetDateNum);
      const kcbPreclose = kcbTodayIdxAll >= 0 ? parseFloat(kcbKlineRawAll[kcbTodayIdxAll].preclose_px) : NaN;

      const cybOpenChange = (cybOpenPx && !isNaN(cybPreclose) && cybPreclose > 0) ? ((cybOpenPx - cybPreclose) / cybPreclose) * 100 : null;
      const kcbOpenChange = (kcbOpenPx && !isNaN(kcbPreclose) && kcbPreclose > 0) ? ((kcbOpenPx - kcbPreclose) / kcbPreclose) * 100 : null;

      const cybHitOpen = cybOpenChange !== null && cybOpenChange > 0.5;
      const kcbHitOpen = kcbOpenChange !== null && kcbOpenChange > 0.5;
      const emotionOk = !isNaN(todayTechEmotionVal) && todayTechEmotionVal >= 30;

      if ((cybHitOpen || kcbHitOpen) && emotionOk) {
        howPrereqMet = true;
        howIndexName = cybHitOpen ? '创业板指' : '科创50';
        howPreclose = cybHitOpen ? cybPreclose : kcbPreclose;

        const openDesc = [
          cybHitOpen ? `创业板指高开+${cybOpenChange.toFixed(2)}%` : null,
          kcbHitOpen ? `科创50高开+${kcbOpenChange.toFixed(2)}%` : null,
        ].filter(Boolean).join('、');

        signals.push({
          time: '09:30',
          timeKey: '093000',
          signals: [{
            strategyId: 'high_open_high_walk',
            title: '📈 高开高走观察-9:40之前不要出手',
            description: `9:30 开盘：${openDesc}（>0.5%），科技情绪指数 ${todayTechEmotionVal.toFixed(1)}（≥30）。\n高开高走需要满足 9:40 之前指数持续上攻 & 资金持续净流入，当然有量能放大配合最好，如果量能不放大，前一日必须要满足情绪冰点。所以在 9:40 之前不要出手，等 9:40 之后出手即可，当日买入一般能有 3-4 个点的利润垫。`,
            isBullish: true,
          }]
        });
      }
    } catch (e) {
      console.error('[backtest] 高开高走开盘提示检测失败:', e.message);
    }
  }

  // === Strategy 18: high_open_max_half_position（高开最多半仓）===
  // 9:30 开盘检测：创业板指 或 科创50 高开超过 0.5% 即触发
  if (!strategyIds || strategyIds.includes('high_open_max_half_position')) {
    try {
      const mcybToday = todayKlineIdx >= 0 ? cybKlineRaw[todayKlineIdx] : null;
      const mcybPreclose = mcybToday ? parseFloat(mcybToday.preclose_px) : NaN;
      const mkcbKlineRawAll = (indexKlineData.kechuangbanData || [])
        .filter(k => k.trade_date && k.open_px)
        .sort((a, b) => a.trade_date - b.trade_date);
      const mkcTodayIdx = mkcbKlineRawAll.findIndex(k => parseInt(k.trade_date) === targetDateNum);
      const mkcbPreclose = mkcTodayIdx >= 0 ? parseFloat(mkcbKlineRawAll[mkcTodayIdx].preclose_px) : NaN;

      const mcybOpenChange = (cybOpenPx && !isNaN(mcybPreclose) && mcybPreclose > 0) ? ((cybOpenPx - mcybPreclose) / mcybPreclose) * 100 : null;
      const mkcbOpenChange = (kcbOpenPx && !isNaN(mkcbPreclose) && mkcbPreclose > 0) ? ((kcbOpenPx - mkcbPreclose) / mkcbPreclose) * 100 : null;

      const hitIndexes = [];
      if (mcybOpenChange !== null && mcybOpenChange > 0.5) hitIndexes.push({ name: '创业板指', openChange: mcybOpenChange });
      if (mkcbOpenChange !== null && mkcbOpenChange > 0.5) hitIndexes.push({ name: '科创50', openChange: mkcbOpenChange });

      if (hitIndexes.length > 0) {
        const openDesc = hitIndexes.map(i => `${i.name}高开 +${i.openChange.toFixed(2)}%`).join('、');
        triggeredStrategies.add('high_open_max_half_position');
        signals.push({
          time: '09:30',
          timeKey: '093000',
          signals: [{
            strategyId: 'high_open_max_half_position',
            title: '⚠️ 高开最多半仓',
            description: `9:30 开盘 ${openDesc}（>0.5%）。\n大A惯例高开容易低走，此时如果开盘想要加仓，最多只能买单半仓，分摊到两个个股身上就是各自1/4仓位。最后等到收盘的时候再视情况是否要把剩下的仓位加上。`,
            isBullish: false,
          }]
        });
      }
    } catch (e) {
      console.error('[backtest] 高开最多半仓策略检测失败:', e.message);
    }
  }

  for (let i = 0; i < sortedTimes.length; i++) {
    const timeKey = sortedTimes[i];
    const totalMinutes = timeKeyToTotalMinutes(timeKey);
    const currentHhmm = timeKeyToHhmm(timeKey);
    const displayTime = formatMinutesToTime(totalMinutes);
    
    const currentFund = fundMap.get(timeKey);
    const currentAmount = amountMap.get(timeKey);
    
    const cybState = getIndexStateAt(cybHistory, cybOpenPx, currentHhmm);
    const kcbState = getIndexStateAt(kcbHistory, kcbOpenPx, currentHhmm);
    
    if (cybState) dayLowCyb = Math.min(dayLowCyb, cybState.lowPx);
    if (kcbState) dayLowKcb = Math.min(dayLowKcb, kcbState.lowPx);

    const currentSignals = [];

    const addSignal = (strategyId, signalData) => {
      if (!triggeredStrategies.has(strategyId)) {
        currentSignals.push({ strategyId, ...signalData });
        triggeredStrategies.add(strategyId);
      }
    };

    // 获取最近几个快照点的成交量数据，用于判断持续缩量趋势
    const getRecentAmounts = (count) => {
      const result = [];
      for (let j = i; j >= 0 && result.length < count; j--) {
        const a = amountMap.get(sortedTimes[j]);
        if (a && typeof a.amountChangeDiff === 'number') {
          result.push({ time: sortedTimes[j], value: a.amountChangeDiff, totalMin: timeKeyToTotalMinutes(sortedTimes[j]) });
        }
      }
      return result.reverse();
    };

    if (currentFund) {
      let prevFund = null;
      for (let j = i - 1; j >= 0; j--) {
        const pf = fundMap.get(sortedTimes[j]);
        if (pf) {
          prevFund = pf;
          break;
        }
      }
      
      let prevAmountForVshape = null;
      for (let j = i - 1; j >= 0; j--) {
        const pa = amountMap.get(sortedTimes[j]);
        if (pa) {
          prevAmountForVshape = pa;
          break;
        }
      }

      // Strategy 2: v_shape_reversal（前置条件：前一日情绪<-30 或 当日 hasIce: true）
      if (vShapePrerequisiteMet && (!strategyIds || strategyIds.includes('v_shape_reversal')) && prevFund && prevAmountForVshape && currentAmount) {
        const moneyIncreased = currentFund.mainMoney > prevFund.mainMoney;
        const amountIncreased = currentAmount.amountChangeDiff - prevAmountForVshape.amountChangeDiff >= 50;
        const indexUp = (cybState && cybState.change5min > 0) || (kcbState && kcbState.change5min > 0);

        if (moneyIncreased && amountIncreased && indexUp) {
          const prereqDesc = prevDayIsIcePoint
            ? `前日科技情绪指数${prevDayTechEmotion.toFixed(1)}（<-30冰点）`
            : '当日科技情绪分时触及冰点（hasIce: true）';
          addSignal('v_shape_reversal', {
            title: '🚀 V形反转信号',
            description: `【前置条件满足】${prereqDesc}\n量价齐升：资金${prevFund.mainMoney.toFixed(1)}→${currentFund.mainMoney.toFixed(1)}亿（流入增加），成交量放大${(currentAmount.amountChangeDiff - prevAmountForVshape.amountChangeDiff).toFixed(0)}亿（≥50亿），指数5分钟上涨。冰点后三条件共振，V形反转信号。`,
            isBullish: true,
          });
        }
      }

      // Strategy 4: outflow_fake_rally
      if ((!strategyIds || strategyIds.includes('outflow_fake_rally')) && prevFund) {
        const moneyOutflow = currentFund.mainMoney < prevFund.mainMoney && currentFund.mainMoney < -5 && (prevFund.mainMoney - currentFund.mainMoney) >= 5;
        const indexRising = (cybState && cybState.change5min > 0.1) || (kcbState && kcbState.change5min > 0.1);
        
        if (moneyOutflow && indexRising) {
          addSignal('outflow_fake_rally', {
            title: '⚠️ 资金流出但指数上涨-诱多',
            description: `主力资金净流出扩大至${currentFund.mainMoney.toFixed(1)}亿（<-5亿，${prevFund.mainMoney.toFixed(1)}→${currentFund.mainMoney.toFixed(1)}亿），但指数5分钟仍涨${((cybState?.change5min || kcbState?.change5min) || 0).toFixed(2)}%（>0.1%），资金出逃但指数虚涨，警惕诱多。`,
            isBullish: false,
          });
        }
      }
    }

    // Strategy 3: volume_shrink_stagnation（持续监控缩量+滞涨）
    if ((!strategyIds || strategyIds.includes('volume_shrink_stagnation')) && currentAmount) {
      const isStagnating = (cybState && cybState.change5min <= 0.1) || (kcbState && kcbState.change5min <= 0.1);
      
      if (isStagnating) {
        // 找约15-20分钟前的成交量点（资金5分钟/成交量10分钟粒度，约2-3个快照点前）
        let pastAmount = null;
        for (let j = i - 1; j >= 0; j--) {
          const pa = amountMap.get(sortedTimes[j]);
          if (pa && typeof pa.amountChangeDiff === 'number') {
            const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
            if (gap >= 15) {
              pastAmount = pa;
              break;
            }
          }
        }

        if (pastAmount) {
          const shrinkFromPast = pastAmount.amountChangeDiff - currentAmount.amountChangeDiff;
          
          // 检查最近3个快照点是否呈缩量趋势（非放大）
          const recentAmounts = getRecentAmounts(3);
          let continuousShrink = true;
          if (recentAmounts.length >= 3) {
            // 最近3点不应出现明显放大（后一个比前一个放大量<30亿才算持续缩小/横盘）
            for (let k = 1; k < recentAmounts.length; k++) {
              if (recentAmounts[k].value - recentAmounts[k-1].value > 30) {
                continuousShrink = false;
                break;
              }
            }
          }

          // 冷却期：上次触发后20分钟内不再重复提醒
          const cooldownOk = (totalMinutes - volumeShrinkLastTriggerTime) >= 20;

          if (shrinkFromPast >= 80 && continuousShrink && cooldownOk) {
            volumeShrinkLastTriggerTime = totalMinutes;
            // 缩量滞涨允许多次触发（通过冷却期控制频率），不使用全局去重
            currentSignals.push({
              strategyId: 'volume_shrink_stagnation',
              title: '📉 缩量滞涨预警',
              description: `成交量较约15分钟前萎缩${shrinkFromPast.toFixed(0)}亿（≥80亿），最近3个快照点未出现有效放大（持续缩量/横盘），指数5分钟涨幅≤0.1%滞涨，上攻动能不足，警惕回落。`,
              isBullish: false,
            });
          }
        }
      }
    }

    // Strategy 5: low_open_wash_recovery (10:30-11:00)
    if ((!strategyIds || strategyIds.includes('low_open_wash_recovery')) && totalMinutes >= 630 && totalMinutes <= 660) {
      if (cybState && cybOpenPx && !cybRecovered) {
        const openToLow = ((dayLowCyb - cybOpenPx) / cybOpenPx) * 100;
        const recovered = cybState.latest.last_px >= cybOpenPx * 0.998;
        
        if (openToLow < -1.2 && cybState.reboundFromLow > 0.8 && recovered) {
          addSignal('low_open_wash_recovery', {
            title: '✅ 低开假摔后V形反转(创业板)',
            description: `创业板开盘最低${openToLow.toFixed(2)}%（跌幅>1.2%），从低点反弹${cybState.reboundFromLow.toFixed(2)}%（>0.8%），已回到开盘价99.8%以上，洗盘结束信号。`,
            isBullish: true,
          });
          cybRecovered = true;
        }
      }
      
      if (kcbState && kcbOpenPx && !kcbRecovered) {
        const openToLow = ((dayLowKcb - kcbOpenPx) / kcbOpenPx) * 100;
        const recovered = kcbState.latest.last_px >= kcbOpenPx * 0.998;
        
        if (openToLow < -1.2 && kcbState.reboundFromLow > 0.8 && recovered) {
          addSignal('low_open_wash_recovery', {
            title: '✅ 低开假摔后V形反转(科创板)',
            description: `科创板开盘最低${openToLow.toFixed(2)}%（跌幅>1.2%），从低点反弹${kcbState.reboundFromLow.toFixed(2)}%（>0.8%），已回到开盘价99.8%以上，洗盘结束信号。`,
            isBullish: true,
          });
          kcbRecovered = true;
        }
      }
    }

    // Strategy 6: straight_rise_no_volume
    if ((!strategyIds || strategyIds.includes('straight_rise_no_volume')) && currentAmount) {
      let amount5minAgo = null;
      for (let j = i - 1; j >= 0; j--) {
        const pa = amountMap.get(sortedTimes[j]);
        if (pa) {
          const prevKey = sortedTimes[j];
          const gap = totalMinutes - timeKeyToTotalMinutes(prevKey);
          if (gap >= 8) {
            amount5minAgo = pa;
            break;
          }
        }
      }
      
      if (amount5minAgo) {
        const amountDiff = currentAmount.amountChangeDiff - amount5minAgo.amountChangeDiff;
        const sharpRise = (cybState && cybState.change5min > 0.5) || (kcbState && kcbState.change5min > 0.5);
        
        if (sharpRise && amountDiff < 100) {
          const idxName = (cybState && cybState.change5min > 0.5) ? '创业板' : '科创板';
          const risePct = Math.max(cybState?.change5min || 0, kcbState?.change5min || 0);
          addSignal('straight_rise_no_volume', {
            title: '⚠️ 无量拉升警惕回落',
            description: `${idxName}约5-8分钟涨${risePct.toFixed(2)}%（>0.5%快速拉升），但成交量仅增${amountDiff.toFixed(0)}亿（<100亿不配合），无量上涨易回落。`,
            isBullish: false,
          });
        }
      }
    }

    // Strategy 7: volume_price_surge（量价齐升 - 偏利好，5分钟级别检测）
    if ((!strategyIds || strategyIds.includes('volume_price_surge')) && currentFund && currentAmount) {
      // 找约5分钟前的资金快照
      let fund5minAgo = null;
      for (let j = i - 1; j >= 0; j--) {
        const pf = fundMap.get(sortedTimes[j]);
        if (pf) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 4) {
            fund5minAgo = pf;
            break;
          }
        }
      }
      // 找约8-10分钟前的成交量快照（10分钟粒度，往前至少1个点）
      let amount5minAgoForVPS = null;
      for (let j = i - 1; j >= 0; j--) {
        const pa = amountMap.get(sortedTimes[j]);
        if (pa) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 8) {
            amount5minAgoForVPS = pa;
            break;
          }
        }
      }

      const vpCooldownOk = (totalMinutes - volumePriceSurgeLastTriggerTime) >= 20;
      if (fund5minAgo && amount5minAgoForVPS && vpCooldownOk) {
        const amountDiff = currentAmount.amountChangeDiff - amount5minAgoForVPS.amountChangeDiff;
        const fundIncreased = currentFund.mainMoney > fund5minAgo.mainMoney;
        const volumeSurge = amountDiff >= 100;
        const indexUp = (cybState && cybState.change5min > 0.3) || (kcbState && kcbState.change5min > 0.3);
        const massiveInflow = currentFund.mainMoney >= 10;

        if (volumeSurge && fundIncreased && indexUp && massiveInflow) {
          volumePriceSurgeLastTriggerTime = totalMinutes;
          const idxName = (cybState && cybState.change5min > 0.3) ? '创业板' : '科创板';
          const risePct = Math.max(cybState?.change5min || 0, kcbState?.change5min || 0);
          currentSignals.push({
            strategyId: 'volume_price_surge',
            title: '✅ 量价齐升',
            description: `成交量放大${amountDiff.toFixed(0)}亿（≥100亿显著放量），资金净流入${fund5minAgo.mainMoney.toFixed(1)}→${currentFund.mainMoney.toFixed(1)}亿（≥10亿，流入增加），${idxName}5分钟涨${risePct.toFixed(2)}%（>0.3%）。量价资金三者共振，多方占优。`,
            isBullish: true,
          });
        }
      }
    }

    // Strategy 8: panic_outflow（恐慌盘出逃 - 成交量放大+资金持续净流出，无需指数配合）
    if ((!strategyIds || strategyIds.includes('panic_outflow')) && currentFund && currentAmount) {
      // 找约10分钟前的资金快照，确认资金持续净流出
      let fund10minAgo = null;
      for (let j = i - 1; j >= 0; j--) {
        const pf = fundMap.get(sortedTimes[j]);
        if (pf) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 9) {
            fund10minAgo = pf;
            break;
          }
        }
      }
      // 找约15-20分钟前的成交量快照，确认持续放量
      let amount15minAgo = null;
      for (let j = i - 1; j >= 0; j--) {
        const pa = amountMap.get(sortedTimes[j]);
        if (pa) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 14) {
            amount15minAgo = pa;
            break;
          }
        }
      }

      const panicCooldownOk = (totalMinutes - panicOutflowLastTriggerTime) >= 20;
      if (fund10minAgo && amount15minAgo && panicCooldownOk) {
        const amountDiff = currentAmount.amountChangeDiff - amount15minAgo.amountChangeDiff;
        // 资金出逃：相较10分钟前开始减少即算（无需净流出为负）
        const fundOutflowAccelerating = currentFund.mainMoney < fund10minAgo.mainMoney;
        // 放量：量差≥100亿
        const volumeSurge = amountDiff >= 100;
        // 大规模净流出≥10亿才算恐慌盘
        const massiveOutflow = currentFund.mainMoney <= -10;

        if (volumeSurge && fundOutflowAccelerating && massiveOutflow) {
          panicOutflowLastTriggerTime = totalMinutes;
          currentSignals.push({
            strategyId: 'panic_outflow',
            title: '🚨 恐慌盘出逃',
            description: `成交量较约15分钟前放大${amountDiff.toFixed(0)}亿（≥100亿），主力资金净流出加速（${fund10minAgo.mainMoney.toFixed(1)}→${currentFund.mainMoney.toFixed(1)}亿），净流出≥10亿。放量下跌+资金出逃，恐慌盘涌出。`,
            isBullish: false,
          });
        }
      }
    }

    // Strategy: afternoon_large_inflow（午后大量流入，13:00-14:00）
    if ((!strategyIds || strategyIds.includes('afternoon_large_inflow')) &&
        totalMinutes >= 780 && totalMinutes <= 840 && currentFund && fundAt1130) {
      // 条件1：当前资金净流入相较11:30增加 ≥ 80亿
      const inflowVs1130 = currentFund.mainMoney - fundAt1130.mainMoney;
      const cond1 = inflowVs1130 >= 80;

      // 条件2：最近5分钟资金净流入增加 ≥ 20亿（仅在午后时段内查找，避免跨午休比较）
      let fund5minAgoForAfternoon = null;
      for (let j = i - 1; j >= 0; j--) {
        const pf = fundMap.get(sortedTimes[j]);
        if (pf) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 4 && gap <= 8) {
            fund5minAgoForAfternoon = pf;
            break;
          }
        }
      }
      let cond2 = false;
      let inflowVs5min = 0;
      if (fund5minAgoForAfternoon) {
        inflowVs5min = currentFund.mainMoney - fund5minAgoForAfternoon.mainMoney;
        cond2 = inflowVs5min >= 20;
      }

      if (cond1 || cond2) {
        addSignal('afternoon_large_inflow', {
          title: '💰 午后大量流入',
          description: cond1
            ? `午后资金大量流入：当前主力资金净流入${currentFund.mainMoney.toFixed(1)}亿，相较11:30的${fundAt1130.mainMoney.toFixed(1)}亿增加${inflowVs1130.toFixed(1)}亿（≥80亿），主力午后积极进场。`
            : `午后资金急速流入：最近5分钟主力资金净流入${fund5minAgoForAfternoon.mainMoney.toFixed(1)}→${currentFund.mainMoney.toFixed(1)}亿，增加${inflowVs5min.toFixed(1)}亿（≥20亿），主力午后积极进场。`,
          isBullish: true,
        });
      }
    }

    // Strategy 17: tail_dip_buying（尾盘抄底：14:30 检测一次，科技情绪<0 且 14:00→当前放量≥50亿 且创业板指涨幅回落）
    if ((!strategyIds || strategyIds.includes('tail_dip_buying')) && !tailDipChecked &&
        totalMinutes >= 870 && amountAt1400 && currentAmount) {
      tailDipChecked = true;
      const todayEmotionVal = todayTechItem ? parseFloat(todayTechItem.changeSumResult) : NaN;
      const tailSurge = currentAmount.amountChangeDiff - amountAt1400.amountChangeDiff;

      // 附加条件：创业板指 14:30 涨幅必须小于 14:00 涨幅（尾盘涨幅回落）
      const getCybChangeAtMin = (limitTotalMin) => {
        const todayCybKline = todayKlineIdx >= 0 ? cybKlineRaw[todayKlineIdx] : null;
        const preclose = todayCybKline ? parseFloat(todayCybKline.preclose_px) : NaN;
        if (isNaN(preclose) || preclose <= 0) return null;
        let px = null;
        for (const h of cybHistory) {
          const tm = Math.floor(h.hhmm / 100) * 60 + (h.hhmm % 100);
          if (tm > limitTotalMin) break;
          if (h.last_px) px = h.last_px;
        }
        if (px === null) return null;
        return ((px - preclose) / preclose) * 100;
      };
      const cybChangeNow = getCybChangeAtMin(totalMinutes);
      const cybChange1400 = getCybChangeAtMin(840);

      if (!isNaN(todayEmotionVal) && todayEmotionVal < 0 && todayEmotionVal >= -70 && tailSurge >= 50 &&
          cybChangeNow !== null && cybChange1400 !== null && cybChangeNow < cybChange1400) {
        addSignal('tail_dip_buying', {
          title: '✅ 尾盘抄底机会',
          description: `全天科技情绪弱势（科技情绪指数${todayEmotionVal.toFixed(1)}，-70 ≤ 情绪 < 0），尾盘半小时放量：14:00 量能 ${amountAt1400.amountChangeDiff.toFixed(0)}亿 → 当前 ${currentAmount.amountChangeDiff.toFixed(0)}亿，放量 ${tailSurge.toFixed(0)}亿（≥50亿），创业板指涨幅回落（14:00 ${cybChange1400 >= 0 ? '+' : ''}${cybChange1400.toFixed(2)}% → 14:30 ${cybChangeNow >= 0 ? '+' : ''}${cybChangeNow.toFixed(2)}%）。全天科技情绪弱势，尾盘半小时放量，适合尾盘抄底，博弈次日的反弹。`,
          isBullish: true,
        });
      }
    }

    // Strategy: inflow_rise_volume_shrink（资金流入+指数上涨+严重缩量-量价背离）
    if ((!strategyIds || strategyIds.includes('inflow_rise_volume_shrink')) && currentFund && currentAmount) {
      // 找约10分钟前的资金快照（跨午休则跳过）
      let fund10minAgoForShrink = null;
      for (let j = i - 1; j >= 0; j--) {
        const pf = fundMap.get(sortedTimes[j]);
        if (pf) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 9) {
            if (gap <= 15) fund10minAgoForShrink = pf;
            break;
          }
        }
      }
      // 找约10分钟前的成交量快照（跨午休则跳过）
      let amount10minAgoForShrink = null;
      for (let j = i - 1; j >= 0; j--) {
        const pa = amountMap.get(sortedTimes[j]);
        if (pa) {
          const gap = totalMinutes - timeKeyToTotalMinutes(sortedTimes[j]);
          if (gap >= 9) {
            if (gap <= 15) amount10minAgoForShrink = pa;
            break;
          }
        }
      }

      const inflowRiseShrinkCooldownOk = (totalMinutes - inflowRiseVolumeShrinkLastTriggerTime) >= 10;

      if (fund10minAgoForShrink && amount10minAgoForShrink && inflowRiseShrinkCooldownOk) {
        const fundIncrease = currentFund.mainMoney - fund10minAgoForShrink.mainMoney;
        const amountIncrease = currentAmount.amountChangeDiff - amount10minAgoForShrink.amountChangeDiff;
        const severeShrink = currentAmount.amountChangeDiff < -500;

        // 指数较10min前上涨（创业板或科创板任一）
        const findIndex10minChange = (history) => {
          if (!history || history.length === 0) return null;
          const points = history.filter(h => h.hhmm <= currentHhmm);
          if (points.length === 0) return null;
          const currPt = points[points.length - 1];
          let prevPt = null;
          for (let k = points.length - 2; k >= 0; k--) {
            const gapH = Math.floor(currentHhmm / 100) - Math.floor(points[k].hhmm / 100);
            const gapM = (currentHhmm % 100) - (points[k].hhmm % 100);
            const gapTotalMin = gapH * 60 + gapM;
            if (gapTotalMin >= 9) {
              if (gapTotalMin <= 15) prevPt = points[k];
              break;
            }
          }
          if (!prevPt || !currPt || !currPt.last_px || !prevPt.last_px) return null;
          return ((currPt.last_px - prevPt.last_px) / prevPt.last_px) * 100;
        };

        const cybChange10min = findIndex10minChange(cybHistory);
        const kcbChange10min = findIndex10minChange(kcbHistory);
        const indexUp = (cybChange10min !== null && cybChange10min > 0) || (kcbChange10min !== null && kcbChange10min > 0);

        if (fundIncrease >= 5 && amountIncrease <= 50 && severeShrink && indexUp) {
          inflowRiseVolumeShrinkLastTriggerTime = totalMinutes;
          const idxName = (cybChange10min !== null && cybChange10min > 0) ? '创业板' : '科创板';
          const risePct = Math.max(cybChange10min || 0, kcbChange10min || 0);
          currentSignals.push({
            strategyId: 'inflow_rise_volume_shrink',
            title: '⚠️ 资金流入&指数上涨但严重缩量-量价背离',
            description: `资金虽然持续净流入&指数配合上涨，但是量能萎缩严重，量价背离，容易冲高回落，切勿追高。主力资金净流入${fund10minAgoForShrink.mainMoney.toFixed(1)}→${currentFund.mainMoney.toFixed(1)}亿（增加${fundIncrease.toFixed(1)}亿，≥5亿），${idxName}指较10分钟前上涨${risePct.toFixed(2)}%，成交量差值${currentAmount.amountChangeDiff.toFixed(0)}亿（<-500亿严重缩量），较10分钟前仅增加${amountIncrease.toFixed(0)}亿（≤50亿）。`,
            isBullish: false,
          });
        }
      }
    }

    // Strategy 16: high_open_high_walk 9:41 确认检测（首个 >= 9:41 的快照点执行一次）
    if (howPrereqMet && !howChecked && totalMinutes >= 9 * 60 + 41) {
      howChecked = true;
      try {
        // 找 fundMap/amountMap 中不晚于 limitHhmm 的最近一个快照
        const findFundAtOrBefore = (limitHhmm) => {
          let found = null;
          for (const t of sortedTimes) {
            if (timeKeyToHhmm(t) > limitHhmm) break;
            const f = fundMap.get(t);
            if (f) found = f;
          }
          return found;
        };
        const findAmountAtOrBefore = (limitHhmm) => {
          let found = null;
          for (const t of sortedTimes) {
            if (timeKeyToHhmm(t) > limitHhmm) break;
            const a = amountMap.get(t);
            if (a) found = a;
          }
          return found;
        };

        const hist = howIndexName === '创业板指' ? cybHistory : kcbHistory;
        const howPoints = hist.filter(h => h.hhmm >= 930 && h.hhmm <= 941); // 9:41 检测时点
        const f930 = findFundAtOrBefore(930);   // 9:30 开盘快照
        const f935 = findFundAtOrBefore(935);   // 9:35 快照
        const f940 = findFundAtOrBefore(940);   // 9:40 快照（9:35-9:40 窗口结束）
        const a941 = findAmountAtOrBefore(941); // 9:41 时点量能快照

        if (howPoints.length > 0 && f930 && f935 && f940) {
          // 条件1：指数当前价距当日最高点回落 ≤ 0.5%
          const highPx = Math.max(...howPoints.map(p => p.last_px));
          const currPx = howPoints[howPoints.length - 1].last_px;
          const pullback = ((highPx - currPx) / highPx) * 100;
          const pullbackOk = pullback <= 0.5;
          const currChange = (!isNaN(howPreclose) && howPreclose > 0) ? ((currPx - howPreclose) / howPreclose) * 100 : null;

          // 条件2&3：资金持续净流入 + 9:30-9:35、9:35-9:40 两波净流入均≥10亿
          const flow1 = f935.mainMoney - f930.mainMoney;
          const flow2 = f940.mainMoney - f935.mainMoney;
          const currMoney = f940.mainMoney;
          const netInflowOk = currMoney > 0;
          const flow1Ok = flow1 >= 10;
          const flow2Ok = flow2 >= 10;

          const hit = pullbackOk && netInflowOk && flow1Ok && flow2Ok;
          const amountDiffNow = a941 ? parseFloat(a941.amountChangeDiff) : NaN;

          if (hit) {
            signals.push({
              time: '09:41',
              timeKey: '094100',
              signals: [{
                strategyId: 'high_open_high_walk',
                title: '✅ 命中高开高走-可以出手',
                description: `命中高开高走，可以出手。当天资金净流入 ${currMoney.toFixed(1)}亿，${howIndexName}上涨 ${currChange !== null ? currChange.toFixed(2) + '%' : '-'}，量能 ${!isNaN(amountDiffNow) ? amountDiffNow.toFixed(0) + '亿' : '-'}（amountChangeDiff 值）。\n确认明细：${howIndexName}距最高点回落 ${pullback.toFixed(2)}%（≤0.5%），9:30-9:35 流入 ${flow1.toFixed(1)}亿（≥10亿），9:35-9:40 流入 ${flow2.toFixed(1)}亿（≥10亿）。`,
                isBullish: true,
              }]
            });
          } else {
            const failed = [];
            if (!pullbackOk) failed.push(`${howIndexName}距最高点回落 ${pullback.toFixed(2)}%（>0.5%）`);
            if (!netInflowOk) failed.push(`当天主力资金净流出 ${Math.abs(currMoney).toFixed(1)}亿`);
            if (!flow1Ok) failed.push(`9:30-9:35 流入仅 ${flow1.toFixed(1)}亿（<10亿）`);
            if (!flow2Ok) failed.push(`9:35-9:40 流入仅 ${flow2.toFixed(1)}亿（<10亿）`);
            signals.push({
              time: '09:41',
              timeKey: '094100',
              signals: [{
                strategyId: 'high_open_high_walk',
                title: '⚠️ 未命中高开高走-不适合出手',
                description: `当前没有满足高开高走的条件，极易高低开走或者是冲高回落，不适合出手。\n未满足项：${failed.join('；')}`,
                isBullish: false,
              }]
            });
          }
        }
      } catch (e) {
        console.error('[backtest] 高开高走9:41确认检测失败:', e.message);
      }
    }

    if (currentSignals.length > 0) {
      signals.push({
        time: displayTime,
        timeKey,
        signals: currentSignals
      });
    }
  }

  // Sort all signals by time
  signals.sort((a, b) => a.timeKey.localeCompare(b.timeKey));

  let filteredSignals = signals;
  if (strategyIds && strategyIds.length > 0) {
    const idSet = new Set(strategyIds);
    filteredSignals = signals.map(tp => ({
      ...tp,
      signals: tp.signals.filter(s => idSet.has(s.strategyId))
    })).filter(tp => tp.signals.length > 0);
  }

  return {
    success: true,
    date: dateStr,
    dateDisplay: `${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}`,
    fundDataPoints: fundData.length,
    amountDataPoints: amountData.length,
    hasIndexData: cybHistory.length > 0 || kcbHistory.length > 0,
    cybOpenPx,
    kcbOpenPx,
    signals: filteredSignals,
    totalSignalCount: filteredSignals.reduce((sum, tp) => sum + tp.signals.length, 0),
    chartData,
    strategies: Object.values(STRATEGY_DEFINITIONS),
    prevDayTechEmotion: prevDayTechEmotion !== null && !isNaN(prevDayTechEmotion) ? prevDayTechEmotion : null,
    prevDayIsIcePoint,
    prevDayHasIce,
    todayHasIce,
    todayTechEmotion: (() => {
      const v = todayTechItem ? parseFloat(todayTechItem.changeSumResult) : NaN;
      return !isNaN(v) ? v : null;
    })(),
  };
};

const getStrategyDefinitions = () => {
  return Object.values(STRATEGY_DEFINITIONS);
};

// ==================== AI 诊断 ====================

// 将分时数据序列压缩为 "HH:MM:value HH:MM:value ..." 格式
const formatTimeline = (arr, decimals = 1) => {
  if (!arr || arr.length === 0) return '无数据';
  return arr.map(d => `${d.time}:${Number(d.value).toFixed(decimals)}`).join(' ');
};

// 将 K 线数据压缩为近 N 日摘要
const formatKlineRecent = (arr, n = 10) => {
  if (!arr || arr.length === 0) return '无数据';
  const recent = arr.slice(-n);
  return recent.map(d => `${d.time}(开${d.open}高${d.high}低${d.low}收${d.close})`).join(' ');
};

// 分钟数转 HH:MM
const minuteToHhmm = (minute) => {
  const str = String(minute).padStart(6, '0');
  return `${str.substring(0, 2)}:${str.substring(2, 4)}`;
};

// 从全量自选股中均匀抽样 N 只股票，拉取分时数据，返回每只股票的涨跌幅摘要 + 采样分时序列
const sampleStockIntradayForAi = async (dateStr, sampleCount = 20) => {
  const allStocks = getMonitorStocks();
  if (!allStocks || allStocks.length === 0) return { count: 0, total: 0, lines: [] };

  // 均匀抽样
  let sampled;
  if (allStocks.length <= sampleCount) {
    sampled = allStocks;
  } else {
    sampled = [];
    const step = allStocks.length / sampleCount;
    for (let i = 0; i < sampleCount; i++) {
      sampled.push(allStocks[Math.floor(i * step)]);
    }
  }

  // 15 分钟采样边界（minute 整数）
  const sampleMinutes = [930, 945, 1000, 1015, 1030, 1045, 1100, 1115, 1130, 1315, 1330, 1345, 1400, 1415, 1430, 1445, 1500];

  const lines = [];
  let valid = 0;
  for (const stock of sampled) {
    try {
      const tlineData = await getSingleStockTlineDataByDate(stock.code, parseInt(dateStr));
      if (!tlineData || !tlineData.line || tlineData.line.length === 0) continue;
      const preclose = parseFloat(tlineData.preclose_px);
      if (!preclose || preclose <= 0) continue;

      const line = tlineData.line
        .filter(p => p.minute && p.last_px)
        .sort((a, b) => a.minute - b.minute);
      if (line.length === 0) continue;

      const changes = line.map(p => ((parseFloat(p.last_px) - preclose) / preclose) * 100);
      const openIdx = line.findIndex(p => p.minute >= 930 && p.minute < 935);
      const openPoint = openIdx >= 0 ? line[openIdx] : line[0];
      const openChange = ((parseFloat(openPoint.last_px) - preclose) / preclose) * 100;
      const highChange = Math.max(...changes);
      const lowChange = Math.min(...changes);
      const closeChange = changes[changes.length - 1];

      // 采样分时涨跌%
      const sampledPoints = [];
      for (const targetMin of sampleMinutes) {
        const idx = line.findIndex(p => p.minute >= targetMin && p.minute < targetMin + 5);
        if (idx >= 0) {
          sampledPoints.push(`${minuteToHhmm(line[idx].minute)}:${changes[idx].toFixed(2)}%`);
        }
      }

      const limitType = getStockLimitTypeName(stock.code);
      const name = stock.name || stock.code;
      lines.push(`${name}(${stock.code})[${limitType}] 昨收${preclose.toFixed(2)} 开${openChange.toFixed(2)}% 高${highChange.toFixed(2)}% 低${lowChange.toFixed(2)}% 收${closeChange.toFixed(2)}% | 分时: ${sampledPoints.join(' ')}`);
      valid++;
    } catch (e) {
      // skip individual stock errors
    }
  }

  return { count: valid, total: allStocks.length, lines };
};

// 从回测结果构建 AI 独立诊断上下文 prompt（不包含本地代码已检测的信号）
const buildAiDiagnosisPrompt = (backtestResult, stockSamples) => {
  const { dateDisplay, fundDataPoints, amountDataPoints, hasIndexData, cybOpenPx, kcbOpenPx, chartData, prevDayTechEmotion, prevDayIsIcePoint, todayHasIce, todayTechEmotion } = backtestResult;

  // 策略库完整判定条件（含 detail）
  const strategyDefsText = Object.values(STRATEGY_DEFINITIONS).map(s => {
    const tag = s.type === 'bullish' ? '【利好】' : '【利空】';
    return `### ${s.id} - ${s.name} ${tag}
${s.description}
${s.detail}`;
  }).join('\n\n');

  // 原始资金流分时（亿）
  const fundTimeline = formatTimeline(chartData?.fundFlow, 1);

  // 原始成交量增量分时（亿）
  const volumeTimeline = formatTimeline(chartData?.volume, 0);

  // 创业板指分时
  const cybTimeline = formatTimeline(chartData?.tline?.cyb, 2);
  const kcbTimeline = formatTimeline(chartData?.tline?.kcb, 2);

  // 近 10 日 K 线
  const cybKlineRecent = formatKlineRecent(chartData?.kline?.cyb, 10);
  const kcbKlineRecent = formatKlineRecent(chartData?.kline?.kcb, 10);

  // 前日科技情绪 + 当日 hasIce
  const prevEmotionText = prevDayTechEmotion !== null && !isNaN(prevDayTechEmotion)
    ? `前一日科技情绪指数 changeSumResult = ${prevDayTechEmotion.toFixed(1)}（${prevDayIsIcePoint ? '低于 -30，属于情绪冰点' : '不低于 -30，非冰点'}）`
    : '前一日科技情绪指数数据缺失';
  const todayHasIceText = todayHasIce ? 'true（当日盘中分时触及冰点）' : 'false（当日未触及冰点）';
  const todayTechEmotionText = todayTechEmotion !== null && !isNaN(todayTechEmotion)
    ? `${todayTechEmotion.toFixed(1)}`
    : '数据缺失';

  const prompt = `你是专业的A股市场量化分析师。请基于以下 ${dateDisplay} 的原始市场数据，【独立】诊断当日哪些策略被触发。注意：你不要参考任何已检测的信号结论，必须完全依据下方原始数据自行判断每个策略是否满足触发条件，用于和本地代码的诊断结果做对比查漏补缺。

【回测日期】${dateDisplay}

【前一日科技情绪】${prevEmotionText}
【当日 hasIce】${todayHasIceText}
【当日科技情绪指数】${todayTechEmotionText}
（V形反转策略的前置条件：前一日科技情绪指数 < -30 冰点，或当日 hasIce = true，任一满足即可）
（高开高走策略的前置条件：当日科技情绪指数 ≥ 30）

【创业板指开盘价】${cybOpenPx || '缺失'}
【科创50开盘价】${kcbOpenPx || '缺失'}

========== 策略库（共 ${Object.keys(STRATEGY_DEFINITIONS).length} 个策略）==========

${strategyDefsText}

========== 原始市场数据 ==========

【主力资金净流入分时（亿）】共 ${fundDataPoints} 个数据点（格式 HH:MM:数值）
${fundTimeline}

【两市成交额增量分时（亿）】共 ${amountDataPoints} 个数据点（格式 HH:MM:数值，正值表示放量）
${volumeTimeline}

【创业板指分时价格】
${cybTimeline}

【科创50分时价格】
${kcbTimeline}

【创业板指近10日K线】(开高低收)
${cybKlineRecent}

【科创50近10日K线】(开高低收)
${kcbKlineRecent}

【自选股分时抽样】从全量 ${stockSamples?.total || 0} 只自选股中均匀抽样 ${stockSamples?.count || 0} 只，含开盘/最高/最低/收盘涨跌幅及15分钟采样分时涨跌%序列
${(stockSamples?.lines || []).length > 0 ? stockSamples.lines.join('\n') : '无自选股分时数据'}

【数据可用性】资金数据 ${fundDataPoints} 点，成交量数据 ${amountDataPoints} 点，指数分时 ${hasIndexData ? '已加载' : '缺失'}，前日情绪 ${prevDayTechEmotion !== null ? '已加载' : '缺失'}，自选股抽样 ${stockSamples?.count || 0}/${stockSamples?.total || 0}

========== 诊断任务 ==========

请你作为独立分析师，逐一判断上述 ${Object.keys(STRATEGY_DEFINITIONS).length} 个策略在当日是否被触发。对每个策略：
- 严格依据该策略的【判断条件】和原始数据进行判断
- 若触发：给出触发时间、触发时的具体数据证据
- 若未触发：说明哪条条件未满足
- 「高开容易低走」策略需依据【自选股分时抽样】中的个股开盘涨跌幅判断（主板≥5%、创业板/科创板≥10%，高开占比≥10%且≥3只）
- 「高开高走」策略需依据【创业板指/科创50分时价格】判断：开盘涨幅 = 分时首个价格相对前一日收盘价的涨幅（前一日收盘价取近10日K线中回测日期前一日的收盘价），9:30 满足前置条件后，再在 9:41 检查分时距当日最高点回落≤0.5%，且【主力资金净流入分时】中 9:30-9:35、9:35-9:40 两段各自增量均≥10亿

同时找出策略库未覆盖但值得关注的市场异动（additionalFindings）。

严格按照以下JSON格式输出（不要输出任何其他内容，不要使用markdown代码块）：

{
  "diagnosis": {
    "date": "${dateDisplay}",
    "overallSentiment": "偏多/偏空/中性 之一",
    "sentimentScore": -100到100之间的整数，正数偏多，负数偏空,
    "summary": "对当日市场整体情况的独立概述，2-4句话"
  },
  "strategyDiagnosis": [
    {
      "strategyId": "策略id，如 high_open_low_close",
      "strategyName": "策略名称",
      "type": "bullish 或 bearish",
      "triggered": true或false,
      "triggerTime": "触发时间 HH:MM，未触发则为空字符串",
      "evidence": "触发时的具体数据证据（数值、时间点对比）；若未触发，说明哪条条件未满足及对应数据",
      "analysis": "对该策略诊断结论的分析说明"
    }
  ],
  "additionalFindings": [
    {
      "time": "异动时间 HH:MM",
      "finding": "策略库未覆盖但值得关注的市场异动描述",
      "significance": "high/medium/low 重要程度"
    }
  ],
  "operationAdvice": {
    "action": "减仓/观望/加仓/清仓 之一",
    "position": "建议仓位比例，如 30-50%",
    "reason": "操作建议的理由"
  },
  "outlook": "对后市1-3天的展望，2-3句话"
}

要求：
1. strategyDiagnosis 数组必须包含全部 ${Object.keys(STRATEGY_DEFINITIONS).length} 个策略，每个都要给出 triggered 判断
2. evidence 必须引用具体数值（如"资金从12.5亿降至-8.3亿""成交量萎缩120亿""指数5分钟涨0.6%"）
3. 若数据缺失导致无法判断某策略，triggered 设为 false 并在 evidence 说明数据不足
4. additionalFindings 可为空数组
5. 只输出JSON，不要有任何额外文字或代码块标记`;

  return prompt;
};

// 调用 AI API 并解析返回的 JSON 诊断结果
const callAiForDiagnosis = async (prompt) => {
  const provider = getActiveProvider();
  console.log(`[strategyAiDiagnosis] 调用 ${provider.name} ${provider.model} 进行独立策略诊断`);
  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(buildRequestBody({
      messages: [
        { role: 'system', content: '你是专业的A股市场量化分析师，擅长根据资金流、成交量、指数分时等原始市场数据，独立判断各类交易策略是否被触发。你的诊断结论将与本地代码的诊断结果做对比查漏补缺，必须完全依据原始数据独立判断，不要假设任何已有结论。只输出JSON，不要输出其他任何内容。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      stream: false,
      thinking: false,
      responseFormat: { type: 'json_object' },
      maxTokens: 16384,
    })),
  });

  if (!response.ok) {
    throw new Error(`${provider.name}API请求失败: ${response.status}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = msg.content || msg.reasoning_content || '';
  console.log(`[strategyAiDiagnosis] ${provider.name}返回 finish_reason=${choice.finish_reason || ''}, 长度=${content.length}`);
  if (!content) {
    throw new Error(`${provider.name}返回内容为空`);
  }

  let jsonStr = content.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // 尝试修复截断的 JSON
    const repaired = repairTruncatedJson(jsonStr);
    if (repaired) {
      parsed = repaired;
    } else {
      throw new Error(`解析${provider.name}返回JSON失败: ${e.message}`);
    }
  }

  return parsed;
};

// 修复因 max_tokens 截断的 JSON
function repairTruncatedJson(str) {
  let s = str.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '');
  }
  let braces = 0, brackets = 0;
  let inString = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  if (inString) s += '"';
  s = s.replace(/,\s*$/, '');
  for (let i = 0; i < brackets; i++) s += ']';
  for (let i = 0; i < braces; i++) s += '}';
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// 执行 AI 诊断回测：运行回测获取原始数据 + 抽样自选股分时 + 调用 AI 独立诊断（不把本地信号喂给 AI）
const runAiDiagnosis = async (dateStr, strategyIds = null) => {
  const backtestResult = await runBacktest(dateStr, strategyIds);
  if (backtestResult.success === false) {
    return backtestResult;
  }
  console.log(`[strategyAiDiagnosis] 抽样自选股分时数据 ${dateStr}...`);
  const stockSamples = await sampleStockIntradayForAi(dateStr, 20);
  console.log(`[strategyAiDiagnosis] 自选股抽样完成: ${stockSamples.count}/${stockSamples.total} 只有效`);
  const prompt = buildAiDiagnosisPrompt(backtestResult, stockSamples);
  console.log(`[strategyAiDiagnosis] 开始 AI 独立诊断 ${dateStr}（本地检测信号 ${backtestResult.totalSignalCount} 次，不喂给 AI）`);
  const aiResult = await callAiForDiagnosis(prompt);
  // 本地检测到的策略 id 集合（供前端对比展示）
  const localTriggeredIds = new Set();
  backtestResult.signals.forEach(tp => tp.signals.forEach(s => localTriggeredIds.add(s.strategyId)));
  return {
    success: true,
    date: dateStr,
    dateDisplay: backtestResult.dateDisplay,
    localSignalCount: backtestResult.totalSignalCount,
    localTriggeredIds: Array.from(localTriggeredIds),
    backtestSummary: {
      fundDataPoints: backtestResult.fundDataPoints,
      amountDataPoints: backtestResult.amountDataPoints,
      hasIndexData: backtestResult.hasIndexData,
      cybOpenPx: backtestResult.cybOpenPx,
      kcbOpenPx: backtestResult.kcbOpenPx,
    },
    diagnosis: aiResult,
    model: getActiveProvider().name,
  };
};

// 获取 AI 诊断上下文（用于拷贝上下文功能）
const getAiDiagnosisContext = async (dateStr, strategyIds = null) => {
  const backtestResult = await runBacktest(dateStr, strategyIds);
  if (backtestResult.success === false) {
    return backtestResult;
  }
  const stockSamples = await sampleStockIntradayForAi(dateStr, 20);
  const prompt = buildAiDiagnosisPrompt(backtestResult, stockSamples);
  const localTriggeredIds = new Set();
  backtestResult.signals.forEach(tp => tp.signals.forEach(s => localTriggeredIds.add(s.strategyId)));
  return {
    prompt,
    date: dateStr,
    dateDisplay: backtestResult.dateDisplay,
    localSignalCount: backtestResult.totalSignalCount,
    localTriggeredIds: Array.from(localTriggeredIds),
    backtestSummary: {
      fundDataPoints: backtestResult.fundDataPoints,
      amountDataPoints: backtestResult.amountDataPoints,
      hasIndexData: backtestResult.hasIndexData,
      cybOpenPx: backtestResult.cybOpenPx,
      kcbOpenPx: backtestResult.kcbOpenPx,
    },
  };
};

module.exports = {
  getAvailableDates,
  runBacktest,
  STRATEGY_DEFINITIONS,
  getStrategyDefinitions,
  runAiDiagnosis,
  getAiDiagnosisContext,
};
