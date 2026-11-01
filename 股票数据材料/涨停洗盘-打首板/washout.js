function isPotentialBullWashout(kline, date, options = {}) {
  const opt = {
    limitPct: 9.5,
    volMult: 2.0,
    minHistory: 3,

    maxBaseToPeak: 2,
    minWashDays: 5,
    maxWashDays: 12,

    maxWashVolRatio: 0.95,
    minShrinkRatio: 0.60,

    minRangePct: 0.08,
    maxRangePct: 0.35,

    upperToleranceHigh: 1.03,
    upperToleranceClose: 1.02,
    breakoutMinRatio: 0.80,

    includeD: true,

    // 新增过滤
    requireBreakoutLimitUp: true, // D 必须是涨停启动日
    forbidLimitUpInWash: true,    // 震荡期内不能有涨停

    ...options
  };

  if (!Array.isArray(kline) || kline.length === 0) return false;

  const toDateNum = (v) =>
    typeof v === 'number' ? v : Number(String(v).replace(/[^0-9]/g, ''));

  const dateNum = toDateNum(date);
  if (!Number.isFinite(dateNum)) return false;

  const data = kline
    .filter(r => r && Number.isFinite(toDateNum(r.trade_date)))
    .map(r => ({ ...r, trade_date_num: toDateNum(r.trade_date) }))
    .sort((a, b) => a.trade_date_num - b.trade_date_num);

  if (data.length < 10) return false;

  let dIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i].trade_date_num <= dateNum) dIdx = i;
    else break;
  }
  if (dIdx < 0) return false;

  const close = data.map(r => Number(r.close_px));
  const high  = data.map(r => Number(r.high_px));
  const low   = data.map(r => Number(r.low_px));
  const open  = data.map(r => Number(r.open_px));
  const vol   = data.map(r => Number(r.business_amount ?? r.business_balance ?? 0));

  const pct = data.map((r, i) => {
    if (Number.isFinite(Number(r.change))) return Number(r.change);
    const prevClose = i > 0 ? close[i - 1] : open[i];
    return prevClose > 0 ? (close[i] / prevClose - 1) * 100 : 0;
  });

  const isLimitUp = (i) =>
    i >= 0 && i < data.length && pct[i] >= opt.limitPct;

  // 新增：D 必须是涨停启动日
  if (opt.requireBreakoutLimitUp && !isLimitUp(dIdx)) return false;

  const avgVolBefore = (idx, n = 20) => {
    const start = Math.max(0, idx - n);
    const end = idx - 1;
    const count = end - start + 1;
    if (count < opt.minHistory) return null;
    let sum = 0;
    for (let i = start; i <= end; i++) sum += vol[i];
    return sum / count;
  };

  let eIdx;
  if (!opt.includeD) eIdx = dIdx - 1;
  else if (isLimitUp(dIdx)) eIdx = dIdx - 1;
  else eIdx = dIdx;

  if (eIdx < opt.minWashDays + 1) return false;

  const t0Start = Math.max(0, eIdx - opt.maxWashDays - opt.maxBaseToPeak - 3);
  const t0End = eIdx - opt.minWashDays - 1;

  for (let t0 = t0End; t0 >= t0Start; t0--) {
    if (!isLimitUp(t0)) continue;

    const t1 = t0 + 1;
    const twoBoard = t1 < eIdx && isLimitUp(t1);

    const peakStart = twoBoard ? t1 : t0;
    const peakEnd = Math.min(
      peakStart + opt.maxBaseToPeak,
      eIdx - opt.minWashDays
    );
    if (peakEnd < peakStart) continue;

    let p = -1;
    let peakVol = -1;
    for (let i = peakStart; i <= peakEnd; i++) {
      if (vol[i] > peakVol) {
        peakVol = vol[i];
        p = i;
      }
    }
    if (p < 0 || peakVol <= 0) continue;

    const avg20 = avgVolBefore(t0, 20);
    if (avg20 == null || avg20 <= 0) continue;
    if (peakVol < opt.volMult * avg20) continue;

    const washStart = p + 1;
    const washEnd = eIdx;
    const washDays = washEnd - washStart + 1;

    if (washDays < opt.minWashDays || washDays > opt.maxWashDays) continue;

    // 新增：震荡期内不能出现涨停
    let hasLimitUpInWash = false;
    if (opt.forbidLimitUpInWash) {
      for (let i = washStart; i <= washEnd; i++) {
        if (pct[i] >= opt.limitPct) {
          hasLimitUpInWash = true;
          break;
        }
      }
    }
    if (hasLimitUpInWash) continue;

    let U = -Infinity;
    for (let i = t0; i <= p; i++) {
      if (high[i] > U) U = high[i];
    }

    let L = Infinity;
    let washMaxVol = -Infinity;
    let washMinVol = Infinity;
    let washMaxHigh = -Infinity;
    let washMaxClose = -Infinity;

    for (let i = washStart; i <= washEnd; i++) {
      if (low[i] < L) L = low[i];
      if (vol[i] > washMaxVol) washMaxVol = vol[i];
      if (vol[i] < washMinVol) washMinVol = vol[i];
      if (high[i] > washMaxHigh) washMaxHigh = high[i];
      if (close[i] > washMaxClose) washMaxClose = close[i];
    }

    if (!Number.isFinite(U) || !Number.isFinite(L) || L <= 0) continue;

    const rangePct = (U - L) / L;
    if (rangePct < opt.minRangePct || rangePct > opt.maxRangePct) continue;
    if (washMaxVol > peakVol * opt.maxWashVolRatio) continue;
    if (washMinVol > peakVol * opt.minShrinkRatio) continue;
    if (washMaxHigh > U * opt.upperToleranceHigh) continue;
    if (washMaxClose > U * opt.upperToleranceClose) continue;
    if (isLimitUp(dIdx) && close[dIdx] < U * opt.breakoutMinRatio) continue;

    return true;
  }

  return false;
}

module.exports = { isPotentialBullWashout };