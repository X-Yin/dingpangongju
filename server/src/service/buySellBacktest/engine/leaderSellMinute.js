// 情绪游资系列「价格类卖点」分钟级回溯扫描（2026-10-16 用户新增）
//
// 背景：原先卖出仅在每个 5min 桶的时点价上判定——若 9:35 桶现价已破位，实际破位可能发生在
// 9:31/9:33；成交时点与价格都应取「最先触发的那一分钟」的分时价与分钟，而非桶时点价。
// 用户要求：卖出时向前回溯到 09:30，找到最先触发卖点的那一分钟，在该分钟精准卖出；
// 新增卖点⑧（9:30 开盘后较开盘价直线下挫 ≥5 个点，不管当前较昨收涨幅）同样适用该回溯机制。
//
// 覆盖的价格类卖点（逐分钟扫描）：
//   ⑤ 竞价低开：开盘（当日首分钟）较昨收 < -5%
//   ① 成本线止损：现价 < 买入价 ×(1-5%) 且连续维持 ≥5 分钟
//   ② 跌停：较昨收 < -9%
//   ⑦ 盘中分时跌幅：较昨收 ≤ -5%（不设持续性门槛）
//   ⑧ 开盘后直线下挫：较开盘价 ≤ -5%（不管当前较昨收涨幅，2026-10-16 用户新增）
//   ③ 高位放量大阴线：当日最高回落至现价 > 8% 且现价 < 开盘
//
// 选取规则：命中分钟最早者胜出；同一分钟命中多条时按优先级 ⑤①②⑦⑧③（序号小者先）打破平局。
// 注意：④（持仓第 3 日尾盘未拉开 +10%）与 ⑥（收盘抗分歧 < 6）属尾盘时点判定，不参与回溯，
// 仍由各引擎在尾盘桶按当时点价处理。

const STOP_LOSS_PCT = -5;
const STOP_LOSS_SUSTAIN_MINUTES = 5;
const LIMIT_DOWN_SELL_PCT = -9;
const INTRADAY_DROP_SELL_PCT = -5;
const OPEN_DROP_SELL_PCT = -5;        // ⑧ 较开盘价跌幅卖出门槛
const HIGH_POSITION_DROP_PCT = 8;
const AUCTION_GAP_DOWN_PCT = -5;

// 优先级（同分钟命中多条时序号小者先）：⑤①②⑦⑧③
const RANK_AUCTION = 1;
const RANK_STOP_LOSS = 2;
const RANK_LIMIT_DOWN = 3;
const RANK_INTRADAY_DROP = 4;
const RANK_OPEN_DROP = 5;
const RANK_HIGH_DROP = 6;

// HHMM 分钟转「当日绝对分钟数」（用于计算持续时长）
const toAbsMinute = (mm) => Math.floor(mm / 100) * 60 + (mm % 100);

// 成本线止损持续性：截至 minute 时刻，现价「连续低于止损价」的持续分钟数。
// 仅在分钟数据连续（相邻间隙 ≤ 1 分钟，或跨午休 11:30→13:00）时累计，避免把数据缺口误判为持续跌破。
const sustainedBelowStopMinutes = (points, minute, stopPx) => {
  const upto = points.filter(p => p.minute <= minute && p.lastPx > 0);
  if (upto.length === 0) return 0;
  const last = upto[upto.length - 1];
  if (!(last.lastPx < stopPx)) return 0;
  let start = last;
  for (let i = upto.length - 2; i >= 0; i--) {
    const p = upto[i];
    if (!(p.lastPx < stopPx)) break;
    const gap = toAbsMinute(start.minute) - toAbsMinute(p.minute);
    const isLunch = p.minute <= 1130 && start.minute >= 1300;
    if (gap > 1 && !isLunch) break; // 数据缺口，不视为连续跌破
    start = p;
  }
  return toAbsMinute(last.minute) - toAbsMinute(start.minute);
};

const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : parseFloat(Number(v).toFixed(2)));

// 分时点结构：{ minute:int, lastPx:number, change:number }，当日、minute 升序、lastPx>0
// 返回：命中则 { minute, px, changePct, costReturn, reason, rank }，未命中返回 null
const scanLeaderPriceSell = ({ points, preclose, buyPrice, cutoffMinute }) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const mins = points.filter(p => p.minute <= cutoffMinute && p.lastPx > 0);
  if (mins.length === 0) return null;

  const openPx = mins[0].lastPx;
  const openMinute = mins[0].minute;
  const stopPx = (buyPrice > 0 && Number.isFinite(Number(buyPrice))) ? buyPrice * (1 + STOP_LOSS_PCT / 100) : null;

  let best = null;
  const push = (minute, px, changePct, costReturn, rank, reason) => {
    if (!best || minute < best.minute || (minute === best.minute && rank < best.rank)) {
      best = { minute, px, changePct, costReturn, reason, rank };
    }
  };

  let dayHigh = 0;
  for (const p of mins) {
    const px = p.lastPx;
    if (px > dayHigh) dayHigh = px;
    const changePct = preclose && preclose > 0
      ? round2(((px - preclose) / preclose) * 100)
      : (p.change != null ? p.change : null);
    const costReturn = buyPrice > 0 ? round2(((px - buyPrice) / buyPrice) * 100) : null;

    // ⑤ 竞价低开：仅开盘分钟（当日首分钟）
    if (p.minute === openMinute && changePct != null && changePct < AUCTION_GAP_DOWN_PCT) {
      push(p.minute, px, changePct, costReturn, RANK_AUCTION,
        `竞价低开（昨收 ${preclose != null ? preclose.toFixed(2) : '--'}，开盘 ${px.toFixed(2)}，低开 ${changePct}% < ${AUCTION_GAP_DOWN_PCT}%）`);
    }
    // ① 跌破成本线 -5% 且连续 ≥5 分钟
    if (stopPx != null && px < stopPx) {
      const belowMinutes = sustainedBelowStopMinutes(points, p.minute, stopPx);
      if (belowMinutes >= STOP_LOSS_SUSTAIN_MINUTES) {
        push(p.minute, px, changePct, costReturn, RANK_STOP_LOSS,
          `持仓股跌破成本线（成本 ${buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，较成本 ${costReturn}% < ${STOP_LOSS_PCT}%）持续 ${belowMinutes} 分钟 ≥ ${STOP_LOSS_SUSTAIN_MINUTES} 分钟止损`);
      }
    }
    // ② 跌停：较昨收 < -9%
    if (changePct != null && changePct < LIMIT_DOWN_SELL_PCT) {
      push(p.minute, px, changePct, costReturn, RANK_LIMIT_DOWN,
        `持仓股触及跌停（昨收 ${preclose != null ? preclose.toFixed(2) : '--'}，现价 ${px.toFixed(2)}，跌幅 ${changePct}% < ${LIMIT_DOWN_SELL_PCT}%）`);
    }
    // ⑦ 盘中分时跌幅：较昨收 ≤ -5%
    if (changePct != null && changePct <= INTRADAY_DROP_SELL_PCT) {
      push(p.minute, px, changePct, costReturn, RANK_INTRADAY_DROP,
        `盘中分时跌幅（较昨收 ${preclose != null ? preclose.toFixed(2) : '--'}，现价 ${px.toFixed(2)}，跌幅 ${changePct}% ≤ ${INTRADAY_DROP_SELL_PCT}%）直接卖出`);
    }
    // ⑧ 开盘后直线下挫：较开盘价 ≤ -5%（不管当前较昨收涨幅）
    if (openPx > 0) {
      const openDropPct = round2(((px - openPx) / openPx) * 100);
      if (openDropPct != null && openDropPct <= OPEN_DROP_SELL_PCT) {
        push(p.minute, px, changePct, costReturn, RANK_OPEN_DROP,
          `开盘后直线下挫（开盘 ${openPx.toFixed(2)}，现价 ${px.toFixed(2)}，较开盘 ${openDropPct}% ≤ ${OPEN_DROP_SELL_PCT}%）直接卖出`);
      }
    }
    // ③ 高位放量大阴线：当日最高回落至现价 > 8% 且现价 < 开盘
    if (px > 0) {
      const amplitude = ((dayHigh - px) / px) * 100;
      if (amplitude > HIGH_POSITION_DROP_PCT && px < openPx) {
        push(p.minute, px, changePct, costReturn, RANK_HIGH_DROP,
          `高位放量大阴线（当日最高 ${dayHigh.toFixed(2)} 回落至现价 ${px.toFixed(2)}，跌幅 ${amplitude.toFixed(2)}% > ${HIGH_POSITION_DROP_PCT}%，且现价 < 开盘 ${openPx.toFixed(2)}）`);
      }
    }
  }
  return best;
};

module.exports = { scanLeaderPriceSell };
