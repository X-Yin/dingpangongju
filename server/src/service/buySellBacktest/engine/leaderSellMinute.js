// 情绪游资系列「价格类卖点」分钟级回溯扫描（2026-10-16 用户新增）
//
// 背景：原先卖出仅在每个 5min 桶的时点价上判定——若 9:35 桶现价已破位，实际破位可能发生在
// 9:31/9:33；成交时点与价格都应取「最先触发的那一分钟」的分时价与分钟，而非桶时点价。
// 用户要求：卖出时向前回溯到 09:30，找到最先触发卖点的那一分钟，在该分钟精准卖出；
// 新增卖点⑧（9:30 开盘后较开盘价直线下挫 ≥5 个点，不管当前较昨收涨幅）同样适用该回溯机制。
//
// 覆盖的价格类卖点（逐分钟扫描）：
//   ⑤ 竞价低开：开盘（当日首分钟）较昨收 < -5%
//      注：开启⑪⑫「开盘自救」时（enableOpenGapReboundSell 且低开 < -2%），本卖点当日不再于开盘分钟直接卖，
//          改由⑪⑫在自救观察期内按回落容忍线判定；⑦盘中跌幅回顾在自救观察期（≤9:35）同样跳过（避免把自救机会吃掉）
//   ① 成本线止损：现价 < 买入价 ×(1-成本线%) 且连续维持 ≥5 分钟
//      （成本线阈值/持续分钟可由调用方覆盖：极致胜率传 -5% + 0 分钟 → 现价 < 买入价 × 0.95 即卖）
//   ② 跌停：较昨收 < -9%
//   ⑦ 盘中分时跌幅：较昨收 ≤ -5%（不设持续性门槛）
//   ⑧ 开盘后直线下挫：较开盘价 ≤ -5%（不管当前较昨收涨幅，2026-10-16 用户新增）
//   ⑩ 单分钟跳水：相邻两分钟（1min 内）价格跌幅 ≤ -3%（2026-10-17 用户新增；可由 disableMinutePlummet 关闭）
//      豁免条件（2026-10-17 用户新增）：若「跳水的上一分钟」自身涨幅 > 2%（即上一分钟相对再上一分钟
//      的分时价涨幅 > 2%，属急拉），则该分钟不触发⑩卖出——视为上涨中的回调，不卖；后续分钟若再跳水仍可触发
//   ③ 高位放量大阴线：当日最高回落至现价 > 8% 且现价 < 开盘
//   ⑪ 竞价大幅低开后的冲高回落（2026-10-31 用户新增，需显式开启 enableOpenGapReboundSell）：
//      当日竞价低开超过 -2%（开盘价较昨收 < -2%）的隔夜持仓，自开盘起逐分钟跟踪当日分时最高涨幅；
//      拉升后回落幅度超过 2 个百分点（现价涨幅 < 此前最高涨幅 − 2%）即在该分钟卖出（2026-10-31 用户改版）
//   ⑫ 竞价大幅低开后的「开盘自救」（2026-10-31 用户新增，与⑪同一开关）：
//      低开超过 -2% 的隔夜持仓，自开盘起进入自救观察期（截至 9:35）——
//      ① 观察期内「回落不低于开盘价」且「距当日分时最高涨幅的回落幅度 ≤ 2 个百分点」时先不卖；
//      ② 跌破开盘价则在该分钟卖出；
//      ③ 9:35 时若当日涨幅已脱离 ≤ -5% 区域（涨幅 > -5%）→ 自救成功，当日剩余时间不再因⑪⑫卖出（交由其他卖点）；
//         9:35 时仍处于 ≤ -5% 区域 → 自救失败，在 9:35 按分时价卖出。
//      为让自救有机会执行，开启本开关时⑤竞价低开与⑦盘中跌幅在自救观察期（≤9:35）不再直接卖（见上）。
//
// 选取规则：命中分钟最早者胜出；同一分钟命中多条时按优先级 ⑤①②⑦⑧⑩③⑪⑫（序号小者先）打破平局。
// 注意：④（持仓第 3 日尾盘未拉开 +10%）与 ⑥（收盘抗分歧 < 6）属尾盘时点判定，不参与回溯，
// 仍由各引擎在尾盘桶按当时点价处理。

const STOP_LOSS_PCT = -5;
const STOP_LOSS_SUSTAIN_MINUTES = 5;
const LIMIT_DOWN_SELL_PCT = -9;
const INTRADAY_DROP_SELL_PCT = -5;
const OPEN_DROP_SELL_PCT = -5;        // ⑧ 较开盘价跌幅卖出门槛
const HIGH_POSITION_DROP_PCT = 8;
const AUCTION_GAP_DOWN_PCT = -5;
const MINUTE_PLUMMET_PCT = -3;           // ⑩ 单分钟跳水卖出门槛：相邻两分钟价格跌幅 ≤ -3%（2026-10-17 用户新增）
const MINUTE_PLUMMET_PREV_GAIN_PCT = 2;  // ⑩ 豁免门槛：跳水的上一分钟自身涨幅 > 2% 时本次不卖（视为急拉后的回调，2026-10-17 用户新增）
const OPEN_GAP_REBOUND_PCT = -2;         // ⑪⑫ 竞价低开门槛：开盘价较昨收 < -2% 才启用「开盘自救」（2026-10-31 用户新增）
const RESCUE_EVAL_MINUTE = 935;          // ⑫ 自救判定时点：9:35（当日涨幅脱离 ≤ -5% 区域即自救成功）
const RESCUE_TOLERANCE_PCT = 2;          // ⑪ 回落容忍：距当日分时最高涨幅的回落幅度 ≤ 2 个百分点时先不卖（2026-10-31 用户口径）

// 优先级（同分钟命中多条时序号小者先）：⑤①②⑦⑧⑩③⑪
const RANK_AUCTION = 2;
const RANK_STOP_LOSS = 3;
const RANK_LIMIT_DOWN = 4;
const RANK_INTRADAY_DROP = 5;
const RANK_OPEN_DROP = 6;
const RANK_MINUTE_PLUMMET = 7;
const RANK_HIGH_DROP = 8;
const RANK_OPEN_GAP_REBOUND = 9;         // ⑪ 优先级最低（同分钟命中时优先报告更强的价格类卖点）
const RANK_OPEN_SELF_RESCUE = 10;        // ⑫ 开盘自救首次回落（2026-10-31 用户新增），同分钟命中时排在⑪之后

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
// costLinePct / costLineSustainMinutes 可选覆盖①成本线止损的阈值与持续分钟
// resolveCostLinePct 可选：传入 (minute) => 阈值 时，①成本线阈值按分钟动态取值（极致胜率当前直接传 -5% + 0 分钟，不使用该动态口径）
// disableMinutePlummet 可选：传 true 时**关闭⑩单分钟跳水卖点**（2026-10-17 用户要求：情绪游资-反向抱团龙头策略不使用该卖点）
// enableOpenGapReboundSell 可选：传 true 时**开启⑪冲高回落与⑫开盘自救卖点**（2026-10-31 用户要求：仅「情绪游资-极致胜率」**顺周期腿**使用，逆周期腿不启用）；
//   开启后当低开 < -2% 时，⑤竞价低开与⑦盘中跌幅在开盘分钟不直接卖（给开盘自救留出逐分钟判定）
const scanLeaderPriceSell = ({ points, preclose, buyPrice, cutoffMinute, costLinePct = STOP_LOSS_PCT, costLineSustainMinutes = STOP_LOSS_SUSTAIN_MINUTES, resolveCostLinePct, disableMinutePlummet = false, enableOpenGapReboundSell = false }) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const mins = points.filter(p => p.minute <= cutoffMinute && p.lastPx > 0);
  if (mins.length === 0) return null;

  const openPx = mins[0].lastPx;
  const openMinute = mins[0].minute;
  const canStop = buyPrice > 0 && Number.isFinite(Number(buyPrice));
  const stopPctAt = (minute) => (typeof resolveCostLinePct === 'function' ? resolveCostLinePct(minute) : costLinePct);

  // ⑪⑫ 竞价低开幅度（开盘价较昨收）；仅在开启且低开超过 -2% 时进入自救观察期
  const openGapPct = preclose && preclose > 0 ? round2(((openPx - preclose) / preclose) * 100) : null;
  const gapReboundArmed = enableOpenGapReboundSell && openGapPct != null && openGapPct < OPEN_GAP_REBOUND_PCT;
  let rescuePeakChangePct = null; // 自救观察期内当日分时最高涨幅（较昨收）
  let rescueSuccess = false;      // 9:35 已脱离 ≤ -5% 区域 → 自救成功，当日剩余时间不再因⑪⑫卖出
  let rescueFailed = false;       // 9:35 仍未脱离 ≤ -5% 区域 → 自救失败并已记录卖出

  let best = null;
  const push = (minute, px, changePct, costReturn, rank, reason) => {
    if (!best || minute < best.minute || (minute === best.minute && rank < best.rank)) {
      best = { minute, px, changePct, costReturn, reason, rank };
    }
  };

  let dayHigh = 0;
  let prevPx = null; // 上一分钟分时价（用于 ⑩ 单分钟跳水判定）
  let prevPrevPx = null; // 再上一分钟分时价（用于 ⑩ 豁免：判定上一分钟自身涨幅）
  for (const p of mins) {
    const px = p.lastPx;
    if (px > dayHigh) dayHigh = px;
    const changePct = preclose && preclose > 0
      ? round2(((px - preclose) / preclose) * 100)
      : (p.change != null ? p.change : null);
    const costReturn = buyPrice > 0 ? round2(((px - buyPrice) / buyPrice) * 100) : null;

    // ⑤ 竞价低开：仅开盘分钟（当日首分钟）；开启⑫开盘自救时不在此直接卖（改由⑫逐分钟找第一次回落）
    if (!gapReboundArmed && p.minute === openMinute && changePct != null && changePct < AUCTION_GAP_DOWN_PCT) {
      push(p.minute, px, changePct, costReturn, RANK_AUCTION,
        `竞价低开（昨收 ${preclose != null ? preclose.toFixed(2) : '--'}，开盘 ${px.toFixed(2)}，低开 ${changePct}% < ${AUCTION_GAP_DOWN_PCT}%）`);
    }
    // ① 跌破成本线（阈值 stopPct，默认 -5%，可由 resolveCostLinePct 按分钟覆盖）且连续 ≥ costLineSustainMinutes 分钟（默认 5）
    const stopPct = stopPctAt(p.minute);
    const stopPx = canStop && Number.isFinite(Number(stopPct)) ? buyPrice * (1 + stopPct / 100) : null;
    if (stopPx != null && px < stopPx) {
      const belowMinutes = sustainedBelowStopMinutes(points, p.minute, stopPx);
      if (belowMinutes >= costLineSustainMinutes) {
        const lineText = stopPct === 0
          ? '成本线'
          : `成本线 ${stopPct}%`;
        const reason = costLineSustainMinutes <= 0
          ? `持仓股跌破${lineText}（成本 ${buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，较成本 ${costReturn}%）即卖出`
          : `持仓股跌破${lineText}（成本 ${buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，较成本 ${costReturn}% < ${stopPct}%）持续 ${belowMinutes} 分钟 ≥ ${costLineSustainMinutes} 分钟止损`;
        push(p.minute, px, changePct, costReturn, RANK_STOP_LOSS, reason);
      }
    }
    // ② 跌停：较昨收 < -9%
    if (changePct != null && changePct < LIMIT_DOWN_SELL_PCT) {
      push(p.minute, px, changePct, costReturn, RANK_LIMIT_DOWN,
        `持仓股触及跌停（昨收 ${preclose != null ? preclose.toFixed(2) : '--'}，现价 ${px.toFixed(2)}，跌幅 ${changePct}% < ${LIMIT_DOWN_SELL_PCT}%）`);
    }
    // ⑦ 盘中分时跌幅：较昨收 ≤ -5%（不设持续性门槛）；开启⑪⑫自救时自救观察期（≤9:35）不判定（交给自救规则）
    if (changePct != null && changePct <= INTRADAY_DROP_SELL_PCT && !(gapReboundArmed && p.minute <= RESCUE_EVAL_MINUTE)) {
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
    // ⑩ 单分钟跳水：相邻两分钟（1min 内）价格跌幅 ≤ -3%（2026-10-17 用户新增）
    //   豁免（2026-10-17 用户新增）：跳水的上一分钟自身涨幅 > 2%（急拉）时本次不卖——视为上涨中的回调
    if (!disableMinutePlummet && prevPx != null && prevPx > 0) {
      const plungePct = round2(((px - prevPx) / prevPx) * 100);
      const prevMinuteGainPct = prevPrevPx != null && prevPrevPx > 0
        ? round2(((prevPx - prevPrevPx) / prevPrevPx) * 100)
        : null;
      const prevWasSurge = prevMinuteGainPct != null && prevMinuteGainPct > MINUTE_PLUMMET_PREV_GAIN_PCT;
      if (plungePct != null && plungePct <= MINUTE_PLUMMET_PCT && !prevWasSurge) {
        push(p.minute, px, changePct, costReturn, RANK_MINUTE_PLUMMET,
          `盘中 1 分钟内跳水（上一分钟 ${prevPx.toFixed(2)} → 现价 ${px.toFixed(2)}，单分钟跌幅 ${plungePct}% ≤ ${MINUTE_PLUMMET_PCT}%）直接卖出`);
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
    // ⑪⑫ 竞价大幅低开后的「开盘自救」（2026-10-31 用户改版）：
    //   自救观察期 = 开盘 ~ 9:35。期内「回落不低于开盘价」且「距当日分时最高涨幅回落 ≤ 2 个百分点」时先不卖；
    //   · 跌破开盘价 → ⑫ 在该分钟卖出；· 自最高涨幅回落超过 2 个百分点 → ⑪ 在该分钟卖出；
    //   · 9:35 仍处于 ≤ -5% 区域 → ⑫ 自救失败，在 9:35 卖出；
    //   · 9:35 已脱离 -5% 区域（涨幅 > -5%）→ 自救成功，当日剩余时间不再因⑪⑫卖出（交由其他卖点规则）
    if (gapReboundArmed && !rescueSuccess && !rescueFailed && p.minute <= RESCUE_EVAL_MINUTE) {
      if (changePct != null && (rescuePeakChangePct == null || changePct > rescuePeakChangePct)) rescuePeakChangePct = changePct;
      const isEvalMinute = p.minute === RESCUE_EVAL_MINUTE;
      const gapText = `竞价大幅低开（开盘 ${openPx.toFixed(2)}，低开 ${openGapPct}% < ${OPEN_GAP_REBOUND_PCT}%）`;
      const brokeOpenPx = px < openPx;
      const overRetrace = rescuePeakChangePct != null && changePct != null && changePct < rescuePeakChangePct - RESCUE_TOLERANCE_PCT;
      if (isEvalMinute) {
        if (changePct != null && changePct <= INTRADAY_DROP_SELL_PCT) {
          rescueFailed = true;
          push(p.minute, px, changePct, costReturn, RANK_OPEN_SELF_RESCUE,
            `${gapText}后开盘自救失败：9:35 仍未脱离 ${INTRADAY_DROP_SELL_PCT}% 区域（现价 ${px.toFixed(2)}，涨幅 ${changePct}%），按分时价卖出`);
        } else {
          if (brokeOpenPx) {
            push(p.minute, px, changePct, costReturn, RANK_OPEN_SELF_RESCUE,
              `${gapText}后开盘自救期间跌破开盘价（开盘 ${openPx.toFixed(2)} → 现价 ${px.toFixed(2)}，涨幅 ${changePct != null ? `${changePct}%` : '--'}）即卖出`);
          } else if (overRetrace) {
            push(p.minute, px, changePct, costReturn, RANK_OPEN_GAP_REBOUND,
              `${gapText}后冲高回落超过 ${RESCUE_TOLERANCE_PCT} 个百分点（当日最高涨幅 ${rescuePeakChangePct}% → 现价涨幅 ${changePct}%）即卖出`);
          }
          rescueSuccess = true; // 9:35 脱离 -5% 区域 → 自救成功，当日剩余时间不再因⑪⑫卖出
        }
      } else if (brokeOpenPx) {
        push(p.minute, px, changePct, costReturn, RANK_OPEN_SELF_RESCUE,
          `${gapText}后开盘自救期间跌破开盘价（开盘 ${openPx.toFixed(2)} → 现价 ${px.toFixed(2)}，涨幅 ${changePct != null ? `${changePct}%` : '--'}）即卖出`);
      } else if (overRetrace) {
        push(p.minute, px, changePct, costReturn, RANK_OPEN_GAP_REBOUND,
          `${gapText}后冲高回落超过 ${RESCUE_TOLERANCE_PCT} 个百分点（当日最高涨幅 ${rescuePeakChangePct}% → 现价涨幅 ${changePct}%）即卖出`);
      }
    }
    prevPrevPx = prevPx;
    prevPx = px;
  }
  return best;
};

module.exports = { scanLeaderPriceSell };
