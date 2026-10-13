// 情绪快进快出策略（emoQuickOut）专属卖点：
// 快进快出日（上一交易日 3 日 EMA < -60，或上两交易日当日科技情绪均处 -30~20 区间且回升）买入的持仓，
// 次日上午 10:00 强制卖出（取当日第一个 minute ≥ 1000 的分时点价格，未覆盖 10:00 时取当日最后一分钟；
// 当日无该股分时数据时保持持仓、顺延至后续日期重试），不走通用 7 条件卖点。
// 2026-10-05 叠加盘中止损（先到先卖，口径与通用条件7一致，成本线 = 买入价 × (1 - costLinePct/100)）：默认 -2%。
// 2026-10-09 叠加强卖豁免（buildQuickOutExemptInfo）：未触发止损且命中任一「次日强势」判断 → 本次不强卖，
// 持仓转由通用 7 条件卖点接管（后续日期也不再强卖）。
// 返回本次发生强卖/止损的日期（用于当日禁止二次买入），未发生则返回 null。
// 本 hook 只做卖点行为，策略开关判定（strategy.emoQuickOut）由引擎负责调度。
const { buildQuickOutExemptInfo, buildQuickOutSellReason, buildQuickOutStopLossReason } = require('../checkBuilders');
const { buildTwoBuyTradeExtra, getPositionLegWeight, isLegPosition } = require('../twoBuy');

const emoQuickOutSell = ({ positions, strategy, dateStr, dateDisplay, replayStocks, timeBuckets, campData, singleTrades }) => {
  let quickOutSoldDate = null;
  // 当日存在待强卖（未豁免过的）快进快出持仓时才评估豁免判定（每策略每日一次）
  const hasDueQuickOut = positions.some(p => p?.emoQuickOut?.quickOut === true && !p.emoQuickOut?.exempted && dateStr > p.buyDate);
  const exemptInfo = hasDueQuickOut ? buildQuickOutExemptInfo(timeBuckets, campData) : null;
  for (let pi = 0; pi < positions.length; pi++) {
    const pos = positions[pi];
    if (!pos || pos.emoQuickOut?.quickOut !== true || pos.emoQuickOut?.exempted || !(dateStr > pos.buyDate)) continue;
    const entry = (replayStocks || []).find(s => s.code === pos.code);
    const pts = (entry?.tlinePoints || [])
      .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
    if (pts.length === 0) continue; // 当日无该股分时数据 → 保持持仓、顺延至后续日期重试
    const fmtMin = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
    const forcedPt = pts.find(p => Number(p.minute) >= 1000) || pts[pts.length - 1];
    // 盘中跌破成本线止损点（先到先卖）
    const qPct = strategy.costLinePct != null && Number.isFinite(Number(strategy.costLinePct)) ? Number(strategy.costLinePct) : 2;
    let stopPt = null;
    let stopDesc = '';
    const stopThreshold = pos.buyPrice > 0 ? parseFloat((pos.buyPrice * (1 - qPct / 100)).toFixed(2)) : null;
    if (stopThreshold != null) {
      if (Number(pts[0].lastPx) <= stopThreshold) {
        // 竞价低开自救窗口：首分钟已破线，拉升中继续持有；回补至阈值上方则不再止损（待再次跌破再卖）；回落且仍跌破阈值才卖（到 10:00 交由强卖）
        for (let i = 1; i < pts.length && Number(pts[i].minute) < 1000; i++) {
          if (Number(pts[i].lastPx) < Number(pts[i - 1].lastPx) && Number(pts[i].lastPx) <= stopThreshold) {
            stopPt = pts[i];
            stopDesc = `开盘首分钟 ${fmtMin(pts[0].minute)} 价 ${Number(pts[0].lastPx).toFixed(2)} 已跌破止损线，自救拉升于 ${fmtMin(stopPt.minute)} 回落且仍跌破止损线`;
            break;
          }
        }
      } else {
        // 盘中才跌破 → 即时止损（仅看 10:00 前分钟，10:00 起由强卖接管）
        stopPt = pts.find(p => Number(p.minute) < 1000 && Number(p.lastPx) <= stopThreshold) || null;
        if (stopPt) stopDesc = `盘中 ${fmtMin(stopPt.minute)} 跌破止损线`;
      }
    }
    const sellPt = stopPt && Number(stopPt.minute) < Number(forcedPt.minute) ? stopPt : forcedPt;
    const isStopLoss = sellPt === stopPt;
    // 强卖豁免（2026-10-09）：未触发止损且命中任一「次日强势」判断 → 本次不强卖，
    // 持仓转由通用 7 条件卖点接管（本次及后续日期均不再强卖；止损仍先到先卖）
    if (!isStopLoss && exemptInfo) {
      pos.emoQuickOut.exempted = { date: dateStr, via: exemptInfo.via, detail: exemptInfo.detail };
      continue;
    }
    const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
    // 分批建仓仓位（两次买入 / 斜率门控半仓）：按本份仓位权重折算收益，每份各自独立、互不摊平成本
    const isTwoBuy = isLegPosition(pos, strategy);
    const legWeight = getPositionLegWeight(pos, strategy);
    const rawReturnRate = pos.buyPrice > 0
      ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
      : null;
    const returnRate = rawReturnRate != null
      ? parseFloat((rawReturnRate * legWeight).toFixed(2))
      : rawReturnRate;
    singleTrades.push({
      seq: singleTrades.length + 1,
      metric: pos.metric,
      code: pos.code,
      stockName: pos.stockName,
      buyDate: pos.buyDate,
      buyDateDisplay: pos.buyDateDisplay,
      buyTime: pos.buyTime,
      buyPrice: pos.buyPrice,
      buyChange: pos.buyChange,
      buyReason: pos.buyReason,
      buyChecks: pos.buyChecks,
      ...(isTwoBuy ? buildTwoBuyTradeExtra({ ...pos, rawReturnRate }) : {}),
      sellDate: dateStr,
      sellDateDisplay: dateDisplay,
      sellTime: fmtMin(sellPt.minute),
      sellPrice,
      sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
      sellReason: isStopLoss
        ? buildQuickOutStopLossReason(pos.buyPrice, sellPt, stopDesc, qPct)
        : buildQuickOutSellReason(pos.emoQuickOut),
      returnRate,
    });
    positions.splice(pi, 1);
    pi--;
    quickOutSoldDate = dateStr; // 强卖/止损当日禁止二次买入（哪怕买点再次触发）
  }
  return quickOutSoldDate;
};

module.exports = { emoQuickOutSell };