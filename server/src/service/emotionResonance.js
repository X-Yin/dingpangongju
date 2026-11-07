/**
 * 盘中情绪共振监测
 *
 * 由 block_amount_poll.js 每 5 分钟触发一次「即时情绪周期」运算（与点击盯盘页情绪周期按钮同一套数据链路：
 * 同花顺 + 财联社实时涨停/情绪快照 → 四维立体分析 → 板块情绪周期）。
 *
 * 判定条件：
 *   1. 当日大盘情绪温度 ≥ 60；
 *   2. 某板块当日情绪周期为「全面高潮 / 一致加速」；
 * 满足时通过 WebSocket 广播 { type:'emotion_resonance' }，前端弹出全局共振提示。
 *
 * 同一交易日同一板块同一相位只提醒一次，避免每 5 分钟重复弹窗。
 */
const dayjs = require('dayjs');
const wsServer = require('../wsServer');

const MARKET_TEMP_MIN = 60;
const HOT_PHASES = new Set(['全面高潮', '一致加速']);

let currentDate = '';
const alertedKeys = new Set();

const round2 = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : null);

// 从四维立体分析结果中提取共振板块并广播
const evaluate = (data) => {
  const series = Array.isArray(data?.marketTemperature) ? data.marketTemperature : [];
  const last = series.length ? series[series.length - 1] : null;
  const date = String(last?.date || '');
  const marketTemperature = last && Number.isFinite(Number(last.value)) ? Number(last.value) : null;
  const result = { date, marketTemperature, threshold: MARKET_TEMP_MIN, blocks: [] };

  // 只判断当日盘中数据
  if (!date || date !== dayjs().format('YYYYMMDD')) return result;
  if (marketTemperature === null || marketTemperature < MARKET_TEMP_MIN) return result;

  // 按日重置去重记录
  if (currentDate !== date) {
    currentDate = date;
    alertedKeys.clear();
  }

  // 大盘情绪温度按日索引，供前端在板块情绪周期图上标注 ≥60° 的日期
  const tempMap = new Map(series.map((item) => [String(item.date), Number(item.value)]));

  (Array.isArray(data?.themes) ? data.themes : []).forEach((theme) => {
    const cycle = Array.isArray(theme?.emotionCycle) ? theme.emotionCycle : [];
    const day = cycle.length ? cycle[cycle.length - 1] : null;
    if (!day || String(day.date) !== date) return;
    if (!HOT_PHASES.has(day.phase)) return;

    const key = `${date}|${theme.board}|${day.phase}`;
    if (alertedKeys.has(key)) return;
    alertedKeys.add(key);

    const ratio = round2(day.ratio);
    const prevRatio = round2(day.prevRatio);
    result.blocks.push({
      board: theme.board,
      phase: day.phase,
      count: Number(day.count) || 0,
      ratio,
      prevRatio,
      deltaRatio: ratio !== null && prevRatio !== null ? round2(ratio - prevRatio) : null,
      // 近 10 个交易日板块情绪周期，供前端弹窗复刻四维立体的折线图
      cycle: cycle.slice(-10).map((item) => ({
        date: item.date,
        phase: item.phase,
        count: item.count,
        ratio: item.ratio,
        marketTemperature: Number.isFinite(tempMap.get(String(item.date))) ? tempMap.get(String(item.date)) : null,
      })),
    });
  });

  if (!result.blocks.length) return result;

  wsServer.broadcast({
    type: 'emotion_resonance',
    ts: Date.now(),
    open: true,
    data: {
      date,
      marketTemperature,
      threshold: MARKET_TEMP_MIN,
      blocks: result.blocks,
    },
  });
  console.log(
    `[emotionResonance] 大盘 ${marketTemperature}° 共振板块：` +
    result.blocks.map((b) => `${b.board}(${b.phase} 涨停${b.count} 占比${b.ratio}%)`).join('、')
  );
  return result;
};

// 真实检查：现算当日实时快照 + 重算四维立体（不额外刷新成交量占比，调用方应已刷新）
const checkEmotionResonance = async () => {
  const { buildTodaySnapshot } = require('./emotionCycleRealtime');
  const { getSiweiLitiAnalysis } = require('./siweiLiti');
  const snapshot = await buildTodaySnapshot();
  const data = await getSiweiLitiAnalysis({ force: true, todayOverride: snapshot || null });
  return evaluate(data);
};

// 调试 MOCK：构造一条与实盘结构一致的 WS 消息（不参与去重、不写任何数据）
const buildMockCycle = (phases) => {
  const dates = [];
  let cursor = dayjs();
  while (dates.length < phases.length) {
    if (cursor.day() !== 0 && cursor.day() !== 6) dates.unshift(cursor.format('YYYYMMDD'));
    cursor = cursor.subtract(1, 'day');
  }
  // 模拟大盘温度：部分日期 ≥60，便于验证折线图上的「大盘 xx°」标注
  const temps = [52, 58, 63, 66, 59, 55, 61, 68, 64, 68];
  return dates.map((date, i) => ({
    date,
    phase: phases[i],
    count: 5 + i,
    ratio: Number((2.2 + i * 0.35).toFixed(2)),
    marketTemperature: temps[i] ?? null,
  }));
};

const mockResonance = () => {
  const date = dayjs().format('YYYYMMDD');
  const blocks = [
    {
      board: '半导体概念',
      phase: '全面高潮',
      count: 12,
      ratio: 5.86,
      prevRatio: 4.21,
      deltaRatio: 1.65,
      cycle: buildMockCycle(['弱势震荡', '爆量分歧', '全面高潮', '一致加速', '爆量分歧', '弱势震荡', '全面高潮', '全面高潮', '一致加速', '全面高潮']),
    },
    {
      board: '光通信模块',
      phase: '一致加速',
      count: 11,
      ratio: 4.32,
      prevRatio: 5.01,
      deltaRatio: -0.69,
      cycle: buildMockCycle(['退潮', '弱势震荡', '爆量分歧', '全面高潮', '一致加速', '全面高潮', '爆量分歧', '弱势震荡', '全面高潮', '一致加速']),
    },
  ];
  wsServer.broadcast({
    type: 'emotion_resonance',
    ts: Date.now(),
    open: true,
    mock: true,
    data: { date, marketTemperature: 68, threshold: MARKET_TEMP_MIN, blocks },
  });
  return { success: true, date, marketTemperature: 68, blocks: blocks.map((b) => b.board) };
};

module.exports = { checkEmotionResonance, mockResonance, MARKET_TEMP_MIN };
