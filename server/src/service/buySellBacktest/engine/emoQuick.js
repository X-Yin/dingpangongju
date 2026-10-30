const {
  EMO_QUICK_FUND_GATE_CONSECUTIVE,
  EMO_QUICK_FUND_GATE_RETURN_PCT,
  EMO_QUICK_FUND_INFLOW_BASE,
  EMO_QUICK_FUND_INFLOW_RAISED,
  EMO_QUICK_RANGE_HIGH,
  EMO_QUICK_RANGE_LOW,
  EMO_SWITCH_EMA_THRESHOLD,
  TECH_ICE_THRESHOLD,
} = require('../constants');
const { getTechEmotionEmaMap, getTechEmotionRawMap, getTechIceDateSet } = require('../utils/techEmotion');

// 计算「快进快出」标注（买入时点判定）：
//   ① 上一交易日科技情绪 3 日 EMA < -30；② 上上个/上个交易日当日科技情绪均处 (-30, -10) 且回升。
// 两次买入系列（highest_{N}d_gain_two_buy）复用该能力，在首次建仓时调用并把结果挂到持仓上。
// 入参须与 pickBestStock 一致：di 为日期轴（含预热日）绝对索引、rangeDates 为日期轴，方能取到同一「上一交易日」。
const computeEmoQuickOutInfo = (di, rangeDates) => {
  const prevDateStr = di > 0 ? String(rangeDates[di - 1]) : null; // 上一交易日
  const prev2DateStr = di > 1 ? String(rangeDates[di - 2]) : null; // 上上个交易日
  const prevEma = prevDateStr != null ? getTechEmotionEmaMap().get(prevDateStr) : null;
  const prevRaw = prevDateStr != null ? getTechEmotionRawMap().get(prevDateStr) : null;
  const prev2Raw = prev2DateStr != null ? getTechEmotionRawMap().get(prev2DateStr) : null;
  const quickByEmaBelow = prevEma != null && prevEma < EMO_SWITCH_EMA_THRESHOLD;
  const quickByRangeRising = prev2Raw != null && prevRaw != null
    && prev2Raw > EMO_QUICK_RANGE_LOW && prev2Raw < EMO_QUICK_RANGE_HIGH
    && prevRaw > EMO_QUICK_RANGE_LOW && prevRaw < EMO_QUICK_RANGE_HIGH
    && prevRaw > prev2Raw;
  return {
    quickOut: quickByEmaBelow || quickByRangeRising,
    trigger: quickByEmaBelow ? 'ema_below' : (quickByRangeRising ? 'range_rising' : null),
    ema: prevEma != null ? Number(prevEma.toFixed(2)) : null,
    prevRaw: prevRaw != null ? Number(prevRaw.toFixed(2)) : null,
    prev2Raw: prev2Raw != null ? Number(prev2Raw.toFixed(2)) : null,
  };
};

// 读取时间桶的分时科技情绪（与情绪页分时线同源，每日 9:30 竞价起算、跨日不累计；缺失/非法返回 null）
const getBucketTechEmotion = (bucket) => (
  bucket && bucket.techEmotion != null && !Number.isNaN(Number(bucket.techEmotion)) ? Number(bucket.techEmotion) : null
);

// 读取时间桶的「当日截至该时点、任意分时点（分钟级）的最低科技情绪」；缺失/非法返回 null
const getBucketTechEmotionMin = (bucket) => (
  bucket && bucket.techEmotionMin != null && !Number.isNaN(Number(bucket.techEmotionMin)) ? Number(bucket.techEmotionMin) : null
);

// 快进快出系列「资金净流入阈值动态调节」状态机（2026-10-21 用户新增）：
//   初始阈值 20 亿；每完结一笔交易（按成交顺序）判定其折算收益率（半仓已按 ×0.5 折算，与 3% 直接比较）——
//   折算收益率 > 3% → 连续计数清零、阈值降回 20 亿；折算收益率 ≤ 3%（或数据缺失）→ 连续计数 +1，
//   累计连续 2 笔未超过 3% → 阈值提高到 30 亿（保持到下一次单笔折算收益率超 3% 为止）。
//   阈值处于抬高态 30 亿时，快进快出类策略（emoQuickOut 且非两次买入）强制执行两次买入（2026-10-21 用户新增）：
//   首次建仓不分快进快出情形一律半仓，剩余半仓等后续交易日买点再次触发时补买（不能与第一份同日），
//   第二份补买的资金净流入诊断阈值按基准 20 亿判定（见 rangeBacktest / rangeBacktestMulti / fusedEmoWinBacktest）。
// 仅限快进快出类策略（emoQuickOut 且非两次买入）启用；buyPoint 的 fund_inflow 检查按 getThreshold() 动态判定
const createEmoQuickFundGate = () => {
  let consecutiveBelow = 0;
  let threshold = EMO_QUICK_FUND_INFLOW_BASE;
  return {
    getThreshold: () => threshold,
    // 是否处于抬高态（阈值 ≥ 30 亿）：该态下快进快出类策略强制两次买入（供引擎建仓分支判定）
    isRaised: () => threshold >= EMO_QUICK_FUND_INFLOW_RAISED,
    getState: () => ({ threshold, consecutiveBelow }),
    onTradeClosed: (returnRate) => {
      const r = Number(returnRate);
      if (Number.isFinite(r) && r > EMO_QUICK_FUND_GATE_RETURN_PCT) {
        consecutiveBelow = 0;
        threshold = EMO_QUICK_FUND_INFLOW_BASE;
      } else {
        consecutiveBelow += 1;
        if (consecutiveBelow >= EMO_QUICK_FUND_GATE_CONSECUTIVE) threshold = EMO_QUICK_FUND_INFLOW_RAISED;
      }
    },
  };
};

// 「连续两日冰点」前置门禁（2026-10-23 用户新增；板块内选股 + 板块发酵延时共用）：
//   ① 上一交易日：tech_index.json 中该日 hasIce === true；
//   ② 当日（含买点触发桶）：回溯当日任意分时点（分钟级）的实时科技情绪，只要有过 <= TECH_ICE_THRESHOLD 即视为当日冰点
//      （2026-10-30 用户改：与线上 tech_index_intraday 分时序列口径一致，不再只看每 5 分钟桶，
//        避免漏掉桶间瞬时低点；旧缓存无 techEmotionMin 字段时退回桶情绪）；
// 当日不用 hasIce 判定——该字段由前端轮询在触冰时调用接口落盘，无法确定写盘时点，回测中不可靠。
const isTechIceGateOpen = (prevDateStr, timeBuckets, bi) => {
  if (prevDateStr == null || !getTechIceDateSet().has(String(prevDateStr))) return false;
  const end = Math.min(bi, (timeBuckets || []).length - 1);
  for (let i = 0; i <= end; i += 1) {
    const minEmotion = getBucketTechEmotionMin(timeBuckets[i]);
    const v = minEmotion != null ? minEmotion : getBucketTechEmotion(timeBuckets[i]);
    if (v != null && v <= TECH_ICE_THRESHOLD) return true;
  }
  return false;
};

module.exports = {
  computeEmoQuickOutInfo,
  createEmoQuickFundGate,
  getBucketTechEmotion,
  isTechIceGateOpen,
};
