// 情绪周期-择时为主-N 日涨幅最大（2026-11-22 用户新增；仅回测；独立引擎）
//
// 买点：前一日科技情绪 < -40（情绪冰点），今日盘中分时科技情绪首次 > -20 的那个 5 分钟桶，
//       按该桶时点的分时价买入；买入时段沿用普通策略 9:30 – 13:30 门禁。
// 选股：全量自选股中的科技股（isTech !== false）中最近 N 个交易日（含当日盘中涨幅）累计涨幅最大的一只；
//       买点时刻已涨停（主板 > 9.5%、创业板/科创板 > 19%）则按涨幅排名顺延下一只；全部涨停则当日不买。
// 仓位：全仓单持仓（同一时间只持有一只，未卖出前不再买入）。
// 卖点（买入次日起生效，满足其一即卖）：
//   ① 盘中现价跌破 10 日线（现价 < 当日 MA10）；
//   ② 高位放量大阴线（当日分时最高价回落到现价幅度 > 8%，且现价 < 当日开盘价）；
//   ③ 科技情绪指数 ≤ -40 且自选科技股中跌幅 ≤ -9% 的个股 ≥ 5 只；
//   ④ 自身抗分歧分数 < 6 且当前涨幅 ≤ -5%（仅 14:50 后生效，沿用现有卖点诊断条件4口径）；
//   ⑤ 现价跌破成本线 -3%（现价 < 买入价 × 0.97）。
const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  clearTlineMemCache,
  getSingleStockTlineDataByDate,
  getTrainingCampDates,
  loadTrainingCampData,
} = require('../deps');
const { buildWindowAxis, isNonTechWatchlistStock, passWatchlistGate } = require('./pickHelpers');
const { calcResilienceAtMinute, computeWindowGain, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { EXCLUDED_CODES } = require('../constants');
const { round2 } = require('./extremeWinScores');

const ICE_PREV_TECH_EMOTION_MAX = -40; // 前一日科技情绪 < -40 视为情绪冰点
const BUY_TECH_EMOTION_MIN = -20;      // 今日盘中科技情绪首次 > -20 的时点买入
const BUY_TIME_MAX_MINUTE = 1330;      // 买入时段门禁：9:30 – 13:30
const HIGH_BEARISH_PULLBACK_PCT = 8;   // ② 高位放量大阴线：最高回落 > 8% 且现价 < 开盘
const SELL_TECH_EMOTION_MAX = -40;     // ③ 科技情绪指数 ≤ -40
const SELL_TECH_DOWN_PCT = -9;         // ③ 自选科技股跌幅 ≤ -9%
const SELL_TECH_DOWN_COUNT = 5;        // ③ 跌幅达标个股 ≥ 5 只
const RESILIENCE_SELL_MAX = 6;         // ④ 抗分歧 < 6
const RESILIENCE_SELL_CHANGE_MAX = -5; // ④ 且当前涨幅 ≤ -5%
const RESILIENCE_SELL_MINUTE = 1450;   // ④ 仅 14:50 后生效
const COST_LINE_STOP_PCT = -3;         // ⑤ 跌破成本线 -3%
const DRAWDOWN_WINDOW = 10;            // 选股 N 日窗口的预热交易日数

const fmtMinute = (m) => (m != null
  ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`
  : '--');
const gainText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 真分钟分时点（与卖点诊断同源）：只保留有效分钟与有效价格
const mapTlinePoints = (tline) => (tline?.line || [])
  .filter((p) => p && p.minute != null && p.last_px != null)
  .map((p) => ({ minute: parseInt(p.minute, 10), change: p.change != null ? parseFloat(p.change) : 0, lastPx: parseFloat(p.last_px) }))
  .filter((p) => Number.isFinite(p.minute) && p.lastPx > 0)
  .sort((a, b) => a.minute - b.minute);

// 取截至某分钟的最后一个分时点
const pointAtMinute = (points, minute) => {
  let hit = null;
  for (const p of points || []) {
    if (p.minute <= minute) hit = p;
    else break;
  }
  return hit;
};

// 当日自选科技股中跌幅 ≤ -9% 的个股数量（卖点条件③，仅科技股参与计数）
const countTechStocksDown = (bucket) => {
  let count = 0;
  for (const sc of bucket?.stockChanges || []) {
    if (isNonTechWatchlistStock(sc.code)) continue;
    const pct = sc.changePct != null ? Number(sc.changePct) : null;
    if (pct != null && Number.isFinite(pct) && pct <= SELL_TECH_DOWN_PCT) count += 1;
  }
  return count;
};

const buildBuyChecks = (pos) => {
  const t = pos.buyInfo;
  return [
    {
      id: 'mt_prev_ice',
      title: `前一日科技情绪 < ${ICE_PREV_TECH_EMOTION_MAX}（情绪冰点）`,
      passed: true,
      value: `前一日科技情绪 ${Number(t.prevTechEmotion).toFixed(2)} < ${ICE_PREV_TECH_EMOTION_MAX}`,
      reason: `取训练营回放的前一日科技情绪指数，低于 ${ICE_PREV_TECH_EMOTION_MAX} 视为情绪冰点，今日进入择时买入观察`,
    },
    {
      id: 'mt_intraday_emotion',
      title: `盘中科技情绪首次 > ${BUY_TECH_EMOTION_MIN}`,
      passed: true,
      value: `${fmtMinute(t.triggerMinute)} 科技情绪 ${Number(t.triggerEmotion).toFixed(2)} > ${BUY_TECH_EMOTION_MIN}`,
      reason: `逐 5 分钟桶读取分时科技情绪，取当日首次突破 ${BUY_TECH_EMOTION_MIN} 的桶作为买点（须在 9:30 – 13:30 买入时段内）`,
    },
    {
      id: 'mt_pick_gain',
      title: `选股：全量自选科技股 ${t.days} 日涨幅最大（涨停顺延）`,
      passed: true,
      value: `候选 ${t.candidateCount} 只，选中 ${pos.stockName}（${t.days} 日涨幅 ${gainText(t.pickGain)}，当日 ${gainText(t.pickChange)}）`
        + (t.skippedLimitUp.length > 0
          ? `；涨停顺延 ${t.skippedLimitUp.map((x) => `${x.name}(${gainText(x.change)})`).join('、')}`
          : ''),
      reason: `按最近 ${t.days} 个交易日累计涨幅降序取第一只未涨停的科技股；主板涨幅 > 9.5%、创业板/科创板 > 19% 视为涨停`,
    },
    {
      id: 'mt_full_position',
      title: '仓位：全仓买入',
      passed: true,
      value: `成交价 ${pos.buyPrice.toFixed(2)}，仓位 100%`,
      reason: '每次买入均全仓、单持仓，未卖出前不再买入其它股票',
    },
  ];
};

const runMoodTimingBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.moodTimingMode !== true) {
    return { success: false, message: '未找到「情绪周期-择时为主」策略' };
  }
  const days = Number(strategy.moodTimingDays) || 3;

  if (onProgress) onProgress({ current: 0, total: 0, date: '', status: 'loading' });

  const allDates = getTrainingCampDates();
  const rangeDates = allDates.filter((d) => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) return { success: false, message: '所选日期范围内无可回测交易日' };

  // 历史每日 EOD（用于 N 日窗口涨幅）：预热起点日前 10 个交易日，避免起始日附近窗口被截断
  const dailyInfos = new Map();
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, DRAWDOWN_WINDOW, dailyInfos);

  const positions = []; // 全仓单持仓（同一时间最多 1 只）
  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map();

  for (let di = 0; di < total; di += 1) {
    const dateStr = rangeDates[di];
    const dateDisplay = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const dateNum = parseInt(dateStr, 10);
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    let campData;
    try {
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
    } catch (e) {
      skippedDates.push({ date: dateStr, message: e.message || '加载失败' });
      continue;
    }
    if (!campData || campData.success === false) {
      skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' });
      continue;
    }
    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      skippedDates.push({ date: dateStr, message: '无回放数据' });
      continue;
    }
    // 登记当日 EOD，供后续交易日的 N 日窗口使用
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));

    // ---- 买点触发桶：前一日情绪冰点 + 今日盘中科技情绪首次 > -20 ----
    const prevTechEmotion = campData.prevDayTechEmotion != null && Number.isFinite(Number(campData.prevDayTechEmotion))
      ? Number(campData.prevDayTechEmotion)
      : null;
    let buyTrigger = null; // { minute, emotion }
    if (prevTechEmotion != null && prevTechEmotion < ICE_PREV_TECH_EMOTION_MAX) {
      for (const b of timeBuckets) {
        const minute = Number(b.minute);
        if (!Number.isFinite(minute) || minute < 930 || minute > BUY_TIME_MAX_MINUTE) continue;
        const emotion = b.techEmotion != null && !Number.isNaN(Number(b.techEmotion)) ? Number(b.techEmotion) : null;
        if (emotion != null && emotion > BUY_TECH_EMOTION_MIN) {
          buyTrigger = { minute, emotion };
          break;
        }
      }
    }

    // ---- 隔夜持仓当日真分钟分时（买入当日不卖，仅取 dateStr > buyDate 的持仓）----
    const overnight = positions.filter((p) => dateStr > p.buyDate);
    const posTlineMap = new Map(); // code -> points
    const indexTlineMap = new Map(); // indexCode -> points
    if (overnight.length > 0) {
      const indexCodes = new Set(overnight.map((p) => (String(p.code).toLowerCase().startsWith('sh688') ? 'sh000688' : 'sz399006')));
      await batchParallel([...new Set(overnight.map((p) => p.code)), ...indexCodes], async (code) => {
        try {
          const t = await getSingleStockTlineDataByDate(code, dateNum);
          const points = mapTlinePoints(t);
          if (points.length > 0) {
            if (code === 'sh000688' || code === 'sz399006') indexTlineMap.set(code, points);
            else posTlineMap.set(code, points);
          }
        } catch (e) { /* 单只失败忽略 */ }
      }, 8);
    }

    for (const bucket of timeBuckets) {
      const bucketMinute = Number(bucket.minute);

      // ---- 卖出（先卖后买；买入次日起生效）----
      for (const pos of Array.from(positions)) {
        if (dateStr <= pos.buyDate) continue;
        const sc = (bucket.stockChanges || []).find((s) => s.code === pos.code);
        const points = posTlineMap.get(pos.code) || [];
        const atPt = pointAtMinute(points, bucketMinute);
        const px = atPt?.lastPx != null ? Number(atPt.lastPx) : (sc?.lastPx != null ? Number(sc.lastPx) : null);
        if (px == null || !(px > 0)) continue;
        const changePct = atPt?.change != null
          ? Number(atPt.change)
          : (sc?.changePct != null ? Number(sc.changePct) : null);

        let sellReason = null;

        // ⑤ 跌破成本线 -3%（最优先保障止损）
        if (pos.buyPrice > 0 && (px / pos.buyPrice - 1) * 100 <= COST_LINE_STOP_PCT) {
          const ret = (px / pos.buyPrice - 1) * 100;
          sellReason = `跌破成本线 ${COST_LINE_STOP_PCT}%（成本 ${pos.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${ret.toFixed(2)}%）`;
        }

        // ① 盘中现价跌破 10 日线
        if (!sellReason) {
          const ma10 = sc?.dailyMa10 != null ? Number(sc.dailyMa10) : null;
          if (ma10 != null && Number.isFinite(ma10) && px < ma10) {
            sellReason = `现价 ${px.toFixed(2)} 跌破 10 日线 ${ma10.toFixed(2)}`;
          }
        }

        // ② 高位放量大阴线：当日最高回落 > 8% 且现价 < 当日开盘
        if (!sellReason && points.length > 0) {
          const dayHigh = points.reduce((mx, p) => (p.minute <= bucketMinute ? Math.max(mx, p.lastPx) : mx), 0);
          const openPx = points[0].lastPx;
          const pullback = dayHigh > 0 ? ((dayHigh - px) / px) * 100 : 0;
          if (pullback > HIGH_BEARISH_PULLBACK_PCT && px < openPx) {
            sellReason = `高位放量大阴线（当日最高 ${dayHigh.toFixed(2)} 回落 ${pullback.toFixed(2)}% > ${HIGH_BEARISH_PULLBACK_PCT}%，现价 ${px.toFixed(2)} < 开盘 ${openPx.toFixed(2)}）`;
          }
        }

        // ③ 科技情绪指数 ≤ -40 且自选科技股中跌幅 ≤ -9% 的个股 ≥ 5 只
        if (!sellReason) {
          const emotion = bucket.techEmotion != null && !Number.isNaN(Number(bucket.techEmotion)) ? Number(bucket.techEmotion) : null;
          if (emotion != null && emotion <= SELL_TECH_EMOTION_MAX) {
            const downCount = countTechStocksDown(bucket);
            if (downCount >= SELL_TECH_DOWN_COUNT) {
              sellReason = `科技情绪指数 ${emotion.toFixed(2)} ≤ ${SELL_TECH_EMOTION_MAX}，且自选科技股中跌幅 ≤ ${SELL_TECH_DOWN_PCT}% 的个股 ${downCount} 只（≥ ${SELL_TECH_DOWN_COUNT}）`;
            }
          }
        }

        // ④ 抗分歧 < 6 且涨幅 ≤ -5%（仅 14:50 后生效）
        if (!sellReason && bucketMinute >= RESILIENCE_SELL_MINUTE
          && changePct != null && changePct <= RESILIENCE_SELL_CHANGE_MAX) {
          const replayStocks = [
            { code: pos.code, tlinePoints: points },
            ...Array.from(indexTlineMap.entries()).map(([code, pts]) => ({ code, tlinePoints: pts })),
          ];
          const resilience = calcResilienceAtMinute(replayStocks, pos.code, bucketMinute);
          if (resilience != null && Number(resilience) < RESILIENCE_SELL_MAX) {
            sellReason = `抗分歧指数 ${Number(resilience)} < ${RESILIENCE_SELL_MAX} 且涨幅 ${changePct.toFixed(2)}% ≤ ${RESILIENCE_SELL_CHANGE_MAX}%（14:50 后生效）`;
          }
        }

        if (!sellReason) continue;
        const rawReturnRate = pos.buyPrice > 0 ? round2(((px - pos.buyPrice) / pos.buyPrice) * 100) : null;
        trades.push({
          seq: trades.length + 1,
          metric: pos.metric,
          code: pos.code,
          stockName: pos.stockName,
          positionMode: 'offense',
          buyDate: pos.buyDate,
          buyDateDisplay: pos.buyDateDisplay,
          buyTime: pos.buyTime,
          buyPrice: pos.buyPrice,
          buyChange: pos.buyChange,
          buyReason: pos.buyReason,
          buyChecks: pos.buyChecks,
          weight: 1,
          rawReturnRate,
          sellDate: dateStr,
          sellDateDisplay: dateDisplay,
          sellTime: fmtMinute(bucketMinute),
          sellPrice: round2(px),
          sellChange: changePct != null ? round2(changePct) : null,
          sellReason: `${sellReason}，情绪周期-择时为主（${days}日涨幅最大）卖出`,
          returnRate: rawReturnRate,
        });
        const idx = positions.indexOf(pos);
        if (idx >= 0) positions.splice(idx, 1);
      }

      // ---- 买入：买点触发桶到达且当前无持仓 ----
      if (!buyTrigger || bucketMinute !== buyTrigger.minute) continue;
      if (positions.length > 0) continue;

      const winDates = dateAxis.slice(Math.max(0, di + axisOffset - days + 1), di + axisOffset + 1);
      const candidates = [];
      for (const sc of bucket.stockChanges || []) {
        if (!sc || !sc.code) continue;
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (isNonTechWatchlistStock(sc.code)) continue; // 候选池 = 全量自选科技股
        if (sc.lastPx == null || Number(sc.lastPx) <= 0) continue;
        if (positions.some((p) => p.code === sc.code)) continue;
        if (!passWatchlistGate(sc.code, dateStr, bucketMinute)) continue;
        const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
        if (gain == null || !Number.isFinite(gain)) continue;
        candidates.push({ sc, gain });
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => b.gain - a.gain);

      const skippedLimitUp = [];
      let picked = null;
      for (const cand of candidates) {
        if (isLimitUpAtBuy(cand.sc.code, cand.sc.changePct)) {
          skippedLimitUp.push({
            code: cand.sc.code,
            name: cand.sc.name || cand.sc.code,
            change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null,
          });
          continue;
        }
        picked = cand;
        break;
      }
      if (!picked) continue;

      for (const cand of candidates) {
        if (!seenStocks.has(cand.sc.code)) seenStocks.set(cand.sc.code, { code: cand.sc.code, name: cand.sc.name || cand.sc.code });
      }

      const pos = {
        code: picked.sc.code,
        stockName: picked.sc.name || picked.sc.code,
        buyDate: dateStr,
        buyDateDisplay: dateDisplay,
        buyTime: fmtMinute(bucketMinute),
        buyMinute: bucketMinute,
        buyPrice: round2(picked.sc.lastPx),
        buyChange: picked.sc.changePct != null ? round2(picked.sc.changePct) : null,
        metric: round2(picked.gain),
        weight: 1,
        buyInfo: {
          prevTechEmotion,
          triggerMinute: bucketMinute,
          triggerEmotion: buyTrigger.emotion,
          days,
          candidateCount: candidates.length,
          pickGain: round2(picked.gain),
          pickChange: picked.sc.changePct != null ? round2(picked.sc.changePct) : null,
          skippedLimitUp,
        },
      };
      pos.buyReason = `前一日科技情绪 ${prevTechEmotion.toFixed(2)} < ${ICE_PREV_TECH_EMOTION_MAX}（情绪冰点），`
        + `今日 ${fmtMinute(bucketMinute)} 分时科技情绪 ${buyTrigger.emotion.toFixed(2)} 首次 > ${BUY_TECH_EMOTION_MIN}，`
        + `买入全量自选科技股中 ${days} 日涨幅最大 ${pos.stockName}（${gainText(round2(picked.gain))}，当日 ${gainText(pos.buyChange)}）`
        + `${skippedLimitUp.length > 0 ? `，涨停顺延 ${skippedLimitUp.map((x) => x.name).join('、')}` : ''}`
        + `，成交价 ${pos.buyPrice.toFixed(2)}（全仓）`;
      pos.buyChecks = buildBuyChecks(pos);
      positions.push(pos);
      break; // 全仓单持仓：当日买入一只后不再买
    }

    // 每日结束释放分时进程缓存，避免全区间回测撑爆堆内存
    clearTlineMemCache();
  }

  // ---- 组装结果 ----
  const currentHoldings = [];
  for (const pos of positions) {
    const h = { ...pos };
    let closePx = null;
    for (let i = rangeDates.length - 1; i >= 0; i -= 1) {
      const info = dailyInfos.get(rangeDates[i])?.get(pos.code);
      if (info && info.closePx != null && info.closePx > 0) { closePx = info.closePx; break; }
    }
    h.buyReturn = closePx != null && pos.buyPrice > 0
      ? round2(((closePx - pos.buyPrice) / pos.buyPrice) * 100)
      : null;
    h.rawBuyReturn = h.buyReturn;
    currentHoldings.push(h);
  }

  // 全仓单持仓：逐笔复利即等价账户口径；期末持仓按最近收盘价估算浮盈一并折算
  const overallReturn = (() => {
    let acc = 1;
    for (const t of trades) {
      if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
    }
    for (const h of currentHoldings) acc *= 1 + (h.buyReturn || 0) / 100;
    return round2((acc - 1) * 100);
  })();

  const validTrades = trades.filter((t) => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter((t) => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (currentHoldings.length > 0) await attachBuyDayReturn(currentHoldings);

  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: sortTradesByBuyTime(trades),
    currentHolding: currentHoldings[0] || null,
    currentHoldings,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: currentHoldings.length > 0,
    },
  };
};

module.exports = { runMoodTimingBacktest };
