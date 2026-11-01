/**
 * 判断首板日期之前是否存在“拉升放量 + 震荡缩量”的潜在牛股洗盘结构。
 *
 * @param {Array<Object>} klineData K线数据，支持升序或降序，字段至少包含：
 *   trade_date, open_px, high_px, low_px, close_px,
 *   business_amount, change
 * @param {number|string} firstBoardDate 首板涨停日期，如 20260727
 * @returns {boolean} 满足返回 true，否则 false
 */
function isPotentialBullWashout(klineData, firstBoardDate) {
  const P = {
    LOOKBACK: 60,

    // 拉升放量段
    PULL_MIN_DAYS: 1,
    PULL_MAX_DAYS: 3,
    PRE_VOL_DAYS: 5,
    PULL_AVG_VOL_RATIO: 1.8,        // 拉升段均量 >= 前5日均量 * 1.8
    PULL_DAY_VOL_RATIO: 1.3,        // 单日量 >= 前5日均量 * 1.3
    PULL_SINGLE_DAY_VOL_RATIO: 2.0, // 若只有1天拉升，单日量 >= 2.0倍
    PULL_MIN_GAIN_PCT: 3.5,         // 拉升段累计涨幅 >= 3.5%
    PULL_MIN_MAX_DAY_GAIN_PCT: 2.0, // 拉升段最大单日涨幅 >= 2%
    PULL_BREAK_PRE_HIGH_RATIO: 1.02,// 拉升最高价 / 前5日最高价 >= 1.02

    // 震荡洗盘段
    SHOCK_MIN_DAYS: 2,
    SHOCK_MAX_DAYS: 12,
    SHOCK_UP_TOL: 1.05,             // 震荡最高收盘 <= 拉升最高收盘 * 1.05
    SHOCK_DOWN_TOL: 0.85,           // 震荡最低收盘 >= 拉升最低收盘 * 0.85
    MAX_SHOCK_RANGE: 0.20,          // 震荡期振幅 <= 20%
    MAX_PLATFORM_RANGE: 0.25,       // 平台总振幅 <= 25%
    SHOCK_VOL_RATIO: 0.8,           // 震荡均量 <= 拉升均量 * 0.8
    SHOCK_MAX_VOL_RATIO: 0.95,      // 震荡最大量 <= 拉升最大量 * 0.95
    SHOCK_HALF_VOL_RATIO: 0.95,     // 后半段均量 <= 前半段均量 * 0.95

    // 首板确认
    BOARD_LIMIT_CHANGE: 9.5,
    BOARD_BREAK_SHOCK_CLOSE_RATIO: 1.01, // 首板收盘 / 震荡最高收盘 >= 1.01
    BOARD_LAST_VOL_RATIO: 1.2,           // 首板量 / 震荡最后一日量 >= 1.2
  };

  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };
  const avg = (arr) =>
    arr.length ? arr.reduce((s, x) => s + num(x), 0) / arr.length : 0;
  const maxBy = (arr, fn) => Math.max(...arr.map(fn));
  const minBy = (arr, fn) => Math.min(...arr.map(fn));

  if (!Array.isArray(klineData) || klineData.length === 0) return false;

  // 统一按交易日升序排序
  const data = [...klineData]
    .map((x) => ({ ...x }))
    .sort((a, b) => Number(a.trade_date) - Number(b.trade_date));

  const targetDate = String(firstBoardDate);
  const boardIdx = data.findIndex(
    (x) => String(x.trade_date) === targetDate
  );

  // 首板日必须存在，且前面至少有5个交易日
  if (boardIdx < 0 || boardIdx < P.PRE_VOL_DAYS) return false;

  const board = data[boardIdx];
  const prevDay = data[boardIdx - 1];

  // 首板日本身必须涨停
  const boardChange = num(board.change);
  const boardClose = num(board.close_px);
  const prevClose = num(prevDay.close_px);
  const isLimitUp =
    boardChange >= P.BOARD_LIMIT_CHANGE ||
    (prevClose > 0 && boardClose >= prevClose * 1.095);
  if (!isLimitUp) return false;

  const startLimit = Math.max(0, boardIdx - P.LOOKBACK);

  // 枚举震荡长度
  for (
    let shockLen = P.SHOCK_MIN_DAYS;
    shockLen <= P.SHOCK_MAX_DAYS;
    shockLen++
  ) {
    // 震荡段为 [e+1, boardIdx-1]，e 为拉升段最后一天
    const e = boardIdx - 1 - shockLen;
    if (e < startLimit) continue;

    // 枚举拉升长度
    for (
      let pullLen = P.PULL_MIN_DAYS;
      pullLen <= P.PULL_MAX_DAYS;
      pullLen++
    ) {
      const s = e - pullLen + 1; // 拉升段第一天
      if (s - P.PRE_VOL_DAYS < 0) continue;

      const pre5 = data.slice(s - P.PRE_VOL_DAYS, s);
      const pull = data.slice(s, e + 1);
      const shock = data.slice(e + 1, boardIdx);

      if (pre5.length !== P.PRE_VOL_DAYS) continue;
      if (pull.length !== pullLen) continue;
      if (shock.length !== shockLen) continue;

      // ---------- 1. 拉升放量条件 ----------
      const pre5AvgVol = avg(pre5.map((x) => x.business_amount));
      const pullAvgVol = avg(pull.map((x) => x.business_amount));
      const pullMaxVol = maxBy(pull, (x) => num(x.business_amount));

      if (pre5AvgVol <= 0 || pullAvgVol <= 0) continue;

      // 拉升段均量显著高于前5日均量
      if (pullAvgVol < pre5AvgVol * P.PULL_AVG_VOL_RATIO) continue;

      // 拉升段每日放量：至少 min(2, pullLen) 天满足
      const dayVolOk = pull.filter(
        (x) =>
          num(x.business_amount) >=
          pre5AvgVol * P.PULL_DAY_VOL_RATIO
      ).length;
      if (dayVolOk < Math.min(2, pullLen)) continue;

      // 若只有1天拉升，要求单日爆量更强
      if (
        pullLen === 1 &&
        num(pull[0].business_amount) <
          pre5AvgVol * P.PULL_SINGLE_DAY_VOL_RATIO
      ) {
        continue;
      }

      // 拉升段累计涨幅
      const prevCloseBeforePull = num(data[s - 1].close_px);
      const pullEndClose = num(pull[pull.length - 1].close_px);
      if (prevCloseBeforePull <= 0) continue;

      const pullGainPct =
        ((pullEndClose / prevCloseBeforePull) - 1) * 100;
      if (pullGainPct < P.PULL_MIN_GAIN_PCT) continue;

      // 拉升段最大单日涨幅
      const pullMaxDayGain = Math.max(
        ...pull.map((x) => {
          const ch = Number(x.change);
          if (Number.isFinite(ch)) return ch;
          const idx = data.indexOf(x);
          if (idx > 0) {
            return (
              (num(x.close_px) / num(data[idx - 1].close_px) - 1) *
              100
            );
          }
          return 0;
        })
      );
      if (pullMaxDayGain < P.PULL_MIN_MAX_DAY_GAIN_PCT) continue;

      // 拉升段最高价突破前5日最高价
      const pre5High = maxBy(pre5, (x) => num(x.high_px));
      const pullHigh = maxBy(pull, (x) => num(x.high_px));
      if (pullHigh < pre5High * P.PULL_BREAK_PRE_HIGH_RATIO) continue;

      // ---------- 2. 震荡区间与缩量条件 ----------
      const pullHighClose = maxBy(pull, (x) => num(x.close_px));
      const pullLowClose = minBy(pull, (x) => num(x.close_px));
      const pullLow = minBy(pull, (x) => num(x.low_px));

      const shockHigh = maxBy(shock, (x) => num(x.high_px));
      const shockLow = minBy(shock, (x) => num(x.low_px));
      const shockHighClose = maxBy(shock, (x) => num(x.close_px));
      const shockLowClose = minBy(shock, (x) => num(x.close_px));

      if (pullHighClose <= 0 || pullLowClose <= 0) continue;
      if (shockHigh <= 0 || shockLow <= 0) continue;

      // 震荡期不显著突破拉升段最高收盘
      if (shockHighClose > pullHighClose * P.SHOCK_UP_TOL) continue;

      // 震荡期不明显跌破拉升段最低收盘
      if (shockLowClose < pullLowClose * P.SHOCK_DOWN_TOL) continue;

      // 震荡期自身振幅
      const shockRange = (shockHigh - shockLow) / shockLow;
      if (shockRange > P.MAX_SHOCK_RANGE) continue;

      // 拉升 + 震荡整体平台振幅
      const platformHigh = Math.max(pullHigh, shockHigh);
      const platformLow = Math.min(pullLow, shockLow);
      if (platformLow <= 0) continue;

      const platformRange =
        (platformHigh - platformLow) / platformLow;
      if (platformRange > P.MAX_PLATFORM_RANGE) continue;

      // 震荡期缩量
      const shockAvgVol = avg(shock.map((x) => x.business_amount));
      const shockMaxVol = maxBy(shock, (x) => num(x.business_amount));

      if (shockAvgVol > pullAvgVol * P.SHOCK_VOL_RATIO) continue;
      if (shockMaxVol > pullMaxVol * P.SHOCK_MAX_VOL_RATIO) continue;

      // 震荡期量能递减：后半段均量 <= 前半段均量 * 0.95
      if (shock.length >= 4) {
        const mid = Math.floor(shock.length / 2);
        const firstHalfAvg = avg(
          shock.slice(0, mid).map((x) => x.business_amount)
        );
        const secondHalfAvg = avg(
          shock.slice(mid).map((x) => x.business_amount)
        );
        if (
          firstHalfAvg > 0 &&
          secondHalfAvg >
            firstHalfAvg * P.SHOCK_HALF_VOL_RATIO
        ) {
          continue;
        }
      }

      // ---------- 3. 首板突破确认 ----------
      // 首板收盘突破震荡最高收盘
      if (
        boardClose <
        shockHighClose * P.BOARD_BREAK_SHOCK_CLOSE_RATIO
      ) {
        continue;
      }

      // 首板量 >= 震荡最后一日量 * 1.2
      const lastShockVol = num(
        shock[shock.length - 1].business_amount
      );
      if (
        num(board.business_amount) <
        lastShockVol * P.BOARD_LAST_VOL_RATIO
      ) {
        continue;
      }

      return true;
    }
  }

  return false;
}

module.exports = { isPotentialBullWashout };