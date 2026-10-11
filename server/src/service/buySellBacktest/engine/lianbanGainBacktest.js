const { STRATEGIES } = require('../strategies/registry');
const {
  ensureBarsForCodes,
  getBoardLimitUpCandidates,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  scanBoardLimitUpCodesInRange,
  stockVolumeRatio,
  stockWindowGain,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { buildWindowAxis } = require('./pickHelpers');
const { ICE_SIGNAL_INDEX_CODE, ICE_SIGNAL_INDEX_NAME, getIceMa3Slope, getIceMa3SlopeIntraday } = require('./indexGate');
const { EXCLUDED_CODES } = require('../constants');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { extractDailyInfo } = require('./replayData');
const { fmtTime } = require('../diagnose/buyPoint');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');

// 情绪游资-连板 N 日涨幅最大（2026-10-11 用户新增）：
//   买点 = 上证指数 3 日线斜率为正即可买（前一日收盘为正则 9:30 起、盘中由负转正则转正桶买），空仓才买、卖出后当日不追买；
//   选股 = 上一交易日涨停个股数 > 15 的板块内「非首板」主板个股（沪 60 / 深 00）中 N 日涨幅最大者；
//          上一交易日无此类板块则当日不买；不做一字板顺延——涨幅第一的那只若全天封涨停（买不进）则当日跳过；
//   卖点 = 持仓股抗分歧 < 9 ∪ 高位放量大阴线 ∪ 爆量分歧（成交量 ≥ 上一交易日 ×1.2，收盘桶判定）∪ 跌停 ∪ 跌破成本线 -2%；
//          买入次日起生效，任一先触发即按当桶分时价卖出。全仓，收益率不做半仓折算。
const BOARD_MIN_LIMIT_UP_COUNT = 15; // 板块涨停个股数门槛（> 15）
const MAIN_BOARD_LIMIT_UP_PCT = 9.5;  // 主板涨停判定（涨幅 > 9.5%）
const MAIN_BOARD_LIMIT_DOWN_RATIO = 0.9; // 主板跌停价 = 昨收 × 0.9
const VOLUME_SURGE_RATIO = 1.2; // 爆量分歧：当日成交量 ≥ 上一交易日 × 1.2（放量 > 20%）
const SHADOW_AMPLITUDE_PCT = 8; // 高位放量大阴线：自当日最高回落 > 8%
const SHADOW_PERSIST_MIN = 5; // 高位放量大阴线：需持续 ≥ 5 分钟
const CLOSE_BUCKET_MINUTE = 1455; // 收盘桶（爆量分歧判定时点）
const RESILIENCE_SELL_MIN = 9; // 抗分歧卖点阈值（持仓股自身抗分歧分数 < 9 即卖）

// 个股分时点缓存：`${code}|${dateNum}` -> { preclose, points:[{minute,lastPx,change}] }（升序，过滤无效价）
const tlineCache = new Map();
const loadTlinePoints = async (code, dateNum) => {
  const key = `${code}|${dateNum}`;
  if (tlineCache.has(key)) return tlineCache.get(key);
  let res = { preclose: null, points: [] };
  try {
    const t = await getSingleStockTlineDataByDate(code, dateNum);
    res = {
      preclose: t?.preclose_px != null ? parseFloat(t.preclose_px) : null,
      points: (t?.line || [])
        .filter(p => p && p.minute != null && p.last_px != null)
        .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
        .filter(p => p.lastPx > 0)
        .sort((a, b) => a.minute - b.minute),
    };
  } catch (e) { /* 拉取失败返回空 */ }
  tlineCache.set(key, res);
  return res;
};

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');

const runLianbanGainBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.lianbanGainDays == null) {
    return { success: false, message: `未知连板涨幅最大策略: ${strategyId}` };
  }
  const days = Number(strategy.lianbanGainDays);
  const costLinePct = strategy.costLinePct != null ? Number(strategy.costLinePct) : 2;
  // 不依赖资金快照：日期序列并入 tech_index 覆盖的交易日（补上缺资金快照的日期）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });
  // 预拉全部可能用到的连板候选股日K（N 日涨幅现算 + 成交量口径），并缓存日K到 barsCache
  try {
    const extraCodes = await scanBoardLimitUpCodesInRange(rangeDates, BOARD_MIN_LIMIT_UP_COUNT, 2);
    await ensureBarsForCodes(extraCodes);
  } catch (e) {
    return { success: false, message: `连板候选股日K拉取失败: ${e.message || e}` };
  }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }
  const dailyInfos = new Map(); // date -> Map<code, {changePct, closePx, resilience}>
  // 预热起始日前 days 个交易日 EOD，保证起点附近「最近 N 日」窗口不被截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, days, dailyInfos);

  // 斜率符号初值（回测首日前一交易日收盘口径）：仅用于判定当日 9:30 起是否已可买
  let lastSlopeSign = null;
  try {
    const seed = await getIceMa3Slope(dateAxis[0]);
    if (seed != null && Number.isFinite(Number(seed))) lastSlopeSign = seed > 0 ? 1 : -1;
  } catch (e) { /* 无初值，首个有效斜率桶建立基准 */ }

  let position = null; // 单股持仓
  let lastSellDate = null; // 卖出发生的交易日：当日不再追买

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
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
      skippedDates.push({ date: dateStr, message: '无时间桶数据' });
      continue;
    }
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));

    const diA = di + axisOffset;
    const dateNum = parseInt(dateStr, 10);
    const winDates = diA + 1 >= days ? dateAxis.slice(diA + 1 - days, diA + 1) : [];
    const prevDateStr = diA - 1 >= 0 ? dateAxis[diA - 1] : null;

    // 当日候选池：上一交易日 lianbanSnapshot 中涨停数 > 15 的板块内非首板主板个股
    let topCandidate = null; // { code, name, gain, board }
    let boardMeta = { matched: false, boards: [], count: 0 };
    if (prevDateStr) {
      const cand = getBoardLimitUpCandidates(prevDateStr, BOARD_MIN_LIMIT_UP_COUNT, 2);
      boardMeta = { matched: cand.matched, boards: cand.boards, count: cand.stocks.length };
      if (cand.matched && winDates.length === days) {
        const ranked = cand.stocks
          .map(s => ({ ...s, gain: stockWindowGain(s.code, winDates) }))
          .filter(s => s.gain != null && Number.isFinite(s.gain) && !EXCLUDED_CODES.has(s.code))
          .sort((a, b) => b.gain - a.gain);
        if (ranked.length > 0) topCandidate = ranked[0];
        for (const s of ranked) if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name });
      }
    }

    // 持仓（隔夜）当日卖出数据预建：持仓股当日分时 + 上证指数当日分时（抗分歧用）
    let posTline = null;
    let idxTline = null;
    if (position && dateStr > position.buyDate) {
      posTline = await loadTlinePoints(position.code, dateNum);
      idxTline = await loadTlinePoints(ICE_SIGNAL_INDEX_CODE, dateNum);
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);
      const slopeNow = await getIceMa3SlopeIntraday(dateStr, bucketMinute);

      // ===== 卖出（仅隔夜持仓）=====
      if (position && dateStr > position.buyDate && posTline && posTline.points.length > 0) {
        const pts = posTline.points.filter(p => p.minute <= bucketMinute);
        if (pts.length > 0) {
          const atPt = pts[pts.length - 1];
          const px = atPt.lastPx;
          const dayOpen = posTline.points[0].lastPx;
          const preclose = posTline.preclose;
          const costLineThreshold = position.buyPrice > 0 ? position.buyPrice * (1 - costLinePct / 100) : null;

          // ① 跌破成本线 -2%
          const stopLossHit = costLineThreshold != null && px < costLineThreshold;
          // ② 跌停（主板 10%）
          let limitDownHit = false;
          if (preclose && preclose > 0) {
            limitDownHit = px <= preclose * MAIN_BOARD_LIMIT_DOWN_RATIO + 0.001;
          }
          // ③ 持仓股自身抗分歧分数 < 9（与上证指数对比现算）
          let resilience = null;
          let resilienceHit = false;
          if (pts.length >= 5 && idxTline && idxTline.points.length >= 5) {
            const idxPts = idxTline.points.filter(p => p.minute <= bucketMinute);
            if (idxPts.length >= 5) {
              const raw = calculateReplayResilience(pts, idxPts, position.code);
              if (raw != null) {
                resilience = parseFloat(Number(raw).toFixed(2));
                resilienceHit = resilience < RESILIENCE_SELL_MIN;
              }
            }
          }
          // ④ 高位放量大阴线（自当日最高回落 > 8% 且现价 < 开盘，持续 ≥ 5 分钟）
          let shadowHit = false;
          let shadowInfo = null;
          {
            const recent = pts.slice(-SHADOW_PERSIST_MIN);
            if (recent.length >= SHADOW_PERSIST_MIN) {
              let all = true;
              let lastAmp = 0;
              for (const p of recent) {
                const hi = posTline.points.filter(q => q.minute <= p.minute).reduce((mx, q) => Math.max(mx, q.lastPx), 0);
                const amp = p.lastPx > 0 ? ((hi - p.lastPx) / p.lastPx) * 100 : 0;
                if (!(amp > SHADOW_AMPLITUDE_PCT && p.lastPx < dayOpen)) { all = false; break; }
                lastAmp = amp;
              }
              if (all) {
                shadowHit = true;
                shadowInfo = { amplitude: parseFloat(lastAmp.toFixed(2)) };
              }
            }
          }
          // ⑤ 爆量分歧（收盘桶：当日成交量 ≥ 上一交易日 × 1.2）
          let volumeHit = false;
          let volumeRatio = null;
          if (bucketMinute >= CLOSE_BUCKET_MINUTE) {
            const vr = stockVolumeRatio(position.code, dateStr);
            if (vr != null) {
              volumeRatio = parseFloat(vr.ratio.toFixed(2));
              volumeHit = vr.ratio >= VOLUME_SURGE_RATIO;
            }
          }

          // 优先级：跌破成本线 > 跌停 > 抗分歧 <9 > 高位放量大阴线 > 爆量分歧
          let sellReason = null;
          if (stopLossHit) {
            sellReason = `持仓股分时价跌破成本线 -${costLinePct}% 止损（成本 ${position.buyPrice.toFixed(2)}，阈值 ${costLineThreshold.toFixed(2)}，现价 ${px.toFixed(2)}，浮亏 ${parseFloat((((px - position.buyPrice) / position.buyPrice) * 100).toFixed(2))}%）`;
          } else if (limitDownHit) {
            sellReason = `持仓股触及跌停（昨收 ${preclose.toFixed(2)}，跌停价 ${(preclose * MAIN_BOARD_LIMIT_DOWN_RATIO).toFixed(2)}，现价 ${px.toFixed(2)}）`;
          } else if (resilienceHit) {
            sellReason = `持仓股自身抗分歧分数 ${resilience.toFixed(2)} < ${RESILIENCE_SELL_MIN}（与${ICE_SIGNAL_INDEX_NAME}对比现算），资金分歧加剧离场`;
          } else if (shadowHit) {
            sellReason = `高位放量大阴线（自当日最高回落 ${shadowInfo.amplitude}% > ${SHADOW_AMPLITUDE_PCT}% 且现价 ${px.toFixed(2)} < 开盘 ${dayOpen.toFixed(2)}，持续 ≥ ${SHADOW_PERSIST_MIN} 分钟）`;
          } else if (volumeHit) {
            sellReason = `爆量分歧（当日成交量 ≥ 上一交易日 × ${VOLUME_SURGE_RATIO}，量比 ${volumeRatio}，收盘桶判定）`;
          }

          if (sellReason) {
            const sellChange = preclose && preclose > 0
              ? parseFloat((((px - preclose) / preclose) * 100).toFixed(2))
              : null;
            const rawReturnRate = position.buyPrice > 0
              ? parseFloat((((px - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
              : null;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              positionMode: 'offense',
              weight: 1,
              buyDate: position.buyDate,
              buyDateDisplay: position.buyDateDisplay,
              buyTime: position.buyTime,
              buyPrice: position.buyPrice,
              buyChange: position.buyChange,
              buyReason: position.buyReason,
              buyChecks: position.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: fmtMinute(atPt.minute),
              sellPrice: parseFloat(px.toFixed(2)),
              sellChange,
              sellReason: `${sellReason}，情绪游资-连板持仓卖出（全仓）`,
              returnRate: rawReturnRate,
              rawReturnRate,
            });
            position = null;
            lastSellDate = dateStr;
          }
        }
      }

      // ===== 买入（空仓、斜率 > 0、当日未卖出过、有连板候选）=====
      if (!position && winDates.length === days && slopeNow != null && slopeNow > 0
        && dateStr !== lastSellDate && topCandidate) {
        const candTline = await loadTlinePoints(topCandidate.code, dateNum);
        const pts = candTline.points.filter(p => p.minute <= bucketMinute && p.lastPx > 0);
        const atPt = pts.length > 0 ? pts[pts.length - 1] : null;
        const preclose = candTline.preclose;
        const changePct = atPt && preclose && preclose > 0
          ? parseFloat((((atPt.lastPx - preclose) / preclose) * 100).toFixed(2))
          : null;
        // 涨停（含一字板）封死买不进：本桶不买；若全天封死则当日跳过（不顺延到下一只）
        const locked = changePct != null && changePct > MAIN_BOARD_LIMIT_UP_PCT;
        if (atPt && !locked) {
          const slopeText = `${slopeNow > 0 ? '+' : ''}${Number(slopeNow).toFixed(2)}`;
          const boardsText = boardMeta.boards.join('、') || '无';
          position = {
            code: topCandidate.code,
            stockName: topCandidate.name,
            mode: 'offense',
            buyDate: dateStr,
            buyDateDisplay: dateDisplay,
            buyTime: timeText.substring(0, 5),
            buyPrice: parseFloat(atPt.lastPx.toFixed(2)),
            buyChange: changePct,
            metric: parseFloat(topCandidate.gain.toFixed(4)),
            costLinePct,
            buyReason: `${timeText.substring(0, 5)} ${ICE_SIGNAL_INDEX_NAME} 3 日线斜率 ${slopeText}（为正即可买${lastSlopeSign === 1 ? '，前一交易日收盘已为正，9:30 起可买' : ''}），从上一交易日涨停数 > ${BOARD_MIN_LIMIT_UP_COUNT} 的板块（${boardsText}）内非首板主板个股中买入连板 ${days} 日涨幅最大的一只`,
            buyChecks: [
              {
                id: 'lianban_slope_gate',
                title: `${ICE_SIGNAL_INDEX_NAME} 3 日线斜率为正（即可买入）`,
                passed: true,
                value: `${timeText} ${slopeText}`,
                reason: `斜率 > 0 即可买入（无需翻转事件）：前一日收盘口径斜率 ${lastSlopeSign === 1 ? '为正 → 当日 9:30 起即可买' : '非正 → 盘中由负转正后买入'}；满足后空仓即出手，卖出当日不追买`,
              },
              {
                id: 'lianban_board_pool',
                title: `上一交易日涨停数 > ${BOARD_MIN_LIMIT_UP_COUNT} 的板块内「非首板」主板个股`,
                passed: true,
                value: `${boardMeta.count} 只`,
                reason: `上一交易日（${prevDateStr}）涨停个股数 > ${BOARD_MIN_LIMIT_UP_COUNT} 的板块：${boardsText}；从中取非首板（连板数 ≥ 2）且主板（60/00）个股合并去重共 ${boardMeta.count} 只候选`,
              },
              {
                id: 'lianban_best_stock',
                title: `候选内最近 ${days} 日涨幅最大的股票`,
                passed: true,
                value: `${topCandidate.gain > 0 ? '+' : ''}${topCandidate.gain.toFixed(2)}%`,
                reason: `候选池内按最近 ${days} 个交易日（含触发日）个股涨幅之和取最大：${topCandidate.name}（${topCandidate.code}，${topCandidate.board}，${topCandidate.lianbanCount}连板）涨幅 ${topCandidate.gain.toFixed(2)}%；不做一字板顺延（该股全天封涨停买不进则当日跳过）`,
              },
            ],
          };
        }
      }

      if (slopeNow != null && Number.isFinite(Number(slopeNow))) lastSlopeSign = slopeNow > 0 ? 1 : -1;
    }
  }

  // 组装结果（type:'single'：整体收益率 = 已卖出收益 + 期末持仓按最近收盘价估算的浮动收益）
  let overallReturn = 0;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) overallReturn += t.returnRate;
  }
  let holding = null;
  if (position) {
    holding = { ...position, weight: 1 };
    let rawBuyReturn = null;
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(position.code);
      if (info && info.closePx != null && info.closePx > 0) {
        rawBuyReturn = position.buyPrice > 0
          ? parseFloat((((info.closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    if (rawBuyReturn == null) {
      const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
      if (closePx != null && closePx > 0 && position.buyPrice > 0) {
        rawBuyReturn = parseFloat((((closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2));
      }
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn;
    if (rawBuyReturn != null && Number.isFinite(rawBuyReturn)) overallReturn += rawBuyReturn;
  }
  overallReturn = parseFloat(overallReturn.toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (holding) await attachBuyDayReturn([holding]);
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: position != null,
    },
  };
};

module.exports = { runLianbanGainBacktest };