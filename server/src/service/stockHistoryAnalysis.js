// 个股历史分析：给定个股代码与日期区间，返回区间内每个交易日的
//   日K（开高低收、涨跌幅、MA3/MA5/MA10）+ 差劲分 + 强度分
// 差劲分 / 强度分的口径与「情绪游资-极致胜率」策略完全一致，直接复用 engine/extremeWinScores，
// 保证前端展示与回测引擎同源，不会出现两套公式。
const { getSingleStockData } = require('./stock');
const { batchParallel } = require('../utils');
const {
  loadTlinePoints,
  maxMinuteDrop, closeDropFromHigh, fanbanCount, volumeRatioAtDate,
  scoreDiffFromRaw, strengthAtMinute,
} = require('./buySellBacktest/engine/extremeWinScores');
const { iceResilienceIndexCode } = require('./buySellBacktest/engine/indexGate');

const FETCH_LIMIT = 400;    // 日K预取条数（需覆盖区间起点之前的 MA 前置窗口）
const MAX_RANGE_DAYS = 200; // 区间交易日上限（防止一次拉取过多分时）
const CLOSE_MINUTE = 1500;  // 收盘分钟：强度分按收盘口径计算
const TLINE_CONCURRENCY = 6;

const fmtDate = (d) => {
  const s = String(d == null ? '' : d);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

// 截至第 i 根的 period 日均线（收盘价；不足 period 根返回 null）
const maAt = (closesAsc, i, period) => {
  if (i + 1 < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += closesAsc[k];
  return parseFloat((sum / period).toFixed(2));
};

const toNum = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const analyzeStockHistory = async (code, startDate, endDate) => {
  if (!code) return { success: false, message: '缺少 code 参数' };
  const startNum = Number(String(startDate || '').replace(/-/g, ''));
  const endNum = Number(String(endDate || '').replace(/-/g, ''));
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) {
    return { success: false, message: '缺少或非法的 startDate / endDate 参数' };
  }
  if (startNum > endNum) return { success: false, message: '开始日期不能晚于结束日期' };

  let kline = [];
  try {
    kline = await getSingleStockData(code, FETCH_LIMIT);
  } catch (e) {
    return { success: false, message: `获取K线失败: ${e.message}` };
  }
  if (!kline || kline.length === 0) {
    return { success: false, message: '未获取到该股K线数据' };
  }

  const asc = [...kline].sort((a, b) => Number(a.trade_date) - Number(b.trade_date));
  const closes = asc.map((k) => Number(k.close_px));
  // 放量比 A 用成交量序列（与策略 stockVolumeRatio / getStockBars 口径一致：business_amount）
  const volBars = asc.map((k) => ({ d: Number(k.trade_date), v: toNum(k.business_amount) }));

  const rangeIdx = [];
  for (let i = 0; i < asc.length; i++) {
    const d = Number(asc[i].trade_date);
    if (d >= startNum && d <= endNum) rangeIdx.push(i);
  }
  if (rangeIdx.length === 0) {
    return { success: false, message: '所选时间范围内无该股K线数据（可能停牌或超出可取范围）' };
  }
  if (rangeIdx.length > MAX_RANGE_DAYS) {
    return { success: false, message: `时间范围过长，最多支持 ${MAX_RANGE_DAYS} 个交易日` };
  }

  const idxCode = iceResilienceIndexCode(code);

  const bars = await batchParallel(rangeIdx, async (i) => {
    const bar = asc[i];
    const d = Number(bar.trade_date);
    const t = await loadTlinePoints(code, d);

    // 差劲分：A 放量比（本日量对比其前 3 日均量）+ B 单分钟最大跳水 + C 冲高回落 + D 炸板次数
    const diff = scoreDiffFromRaw(
      volumeRatioAtDate(volBars, d),
      maxMinuteDrop(t.points),
      closeDropFromHigh(t.points),
      fanbanCount(t.points, t.preclose, code),
    );

    // 强度分：按收盘口径（A 竞价高开 + B 单分钟最大涨幅 + C 抗分歧分数）
    let strength = null;
    if (t.points.length > 0 && t.preclose > 0) {
      const idxT = await loadTlinePoints(idxCode, d);
      strength = strengthAtMinute(t, CLOSE_MINUTE, code, idxT.points);
    }

    return {
      tradeDate: d,
      time: fmtDate(d),
      open: Number(bar.open_px),
      high: Number(bar.high_px),
      low: Number(bar.low_px),
      close: Number(bar.close_px),
      change: toNum(bar.change),
      volume: toNum(bar.business_balance) || 0,
      ma3: maAt(closes, i, 3),
      ma5: maAt(closes, i, 5),
      ma10: maAt(closes, i, 10),
      diffScore: diff.score,
      strengthScore: strength ? strength.score : null,
      diffDetail: diff,
      strengthDetail: strength,
    };
  }, TLINE_CONCURRENCY);

  bars.sort((a, b) => a.tradeDate - b.tradeDate);
  return {
    success: true,
    code,
    startDate: fmtDate(startNum),
    endDate: fmtDate(endNum),
    indexCode: idxCode,
    bars,
  };
};

module.exports = { analyzeStockHistory };
