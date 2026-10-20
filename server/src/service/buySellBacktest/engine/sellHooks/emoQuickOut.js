// 情绪快进快出策略（emoQuickOut）专属卖点：
// 快进快出日（上一交易日 3 日 EMA < -30，或上两交易日当日科技情绪均处 -30~-10 区间且回升）买入的持仓，
// 次日上午 10:00 强制卖出（取当日第一个 minute ≥ 1000 的分时点价格，未覆盖 10:00 时取当日最后一分钟；
// 当日无该股分时数据时保持持仓、顺延至后续日期重试），不走通用 7 条件卖点。
// 2026-10-05 叠加盘中止损（先到先卖，口径与通用条件7一致，成本线 = 买入价 × (1 - costLinePct/100)）：默认 -2%。
// 2026-10-09 叠加强卖豁免（buildQuickOutExemptInfo）：未触发止损且命中任一「次日强势」判断 → 本次不强卖，
// 持仓转由通用 7 条件卖点接管（后续日期也不再强卖）。
// 2026-10-15 叠加盘中大跌强卖（先到先卖）：盘中当日跌幅（较昨收涨跌幅）≤ EMO_QUICK_CRASH_PCT（-7%）时
// 无条件卖出，先于止损与 10:00 强卖；2026-10-19 叠加竞价低开自救窗口（首个分时点即 ≤ 阈值时改为逐分钟
// 等待自救拉升结束的首个回落分钟，口径与成本线止损同规则，见 engine/crashSellWindow.js）。
// 返回本次发生强卖/止损的日期（用于当日禁止二次买入），未发生则返回 null。
// 本 hook 只做卖点行为，策略开关判定（strategy.emoQuickOut）由引擎负责调度。
const { buildQuickOutExemptInfo, buildQuickOutSellReason, buildQuickOutStopLossReason, buildQuickOutCrashSellReason } = require('../checkBuilders');
const { locateCrashSellPoint } = require('../crashSellWindow');
const { buildTwoBuyTradeExtra, getPositionLegWeight, getUnifiedCostLinePrice, isLegPosition } = require('../twoBuy');

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
    // 「两次买入（同一天）」统一成本线（2026-10-20）：两份均在持时成本线 = 两次买入价均值，两份共用；
    // 仅剩一份时用该份自身买入价。仅影响止损阈值判定，收益率仍按各自实际买入价计算
    const unifiedCost = getUnifiedCostLinePrice(pos, positions, strategy);
    const costBase = unifiedCost != null ? unifiedCost : pos.buyPrice;
    let stopPt = null;
    let stopDesc = '';
    const stopThreshold = costBase > 0 ? parseFloat((costBase * (1 - qPct / 100)).toFixed(2)) : null;
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
    // 盘中大跌强卖（2026-10-15 用户新增）：当日跌幅（较昨收涨跌幅）≤ EMO_QUICK_CRASH_PCT 的卖出点；
    // 2026-10-19 叠加竞价低开自救窗口（首个分时点即 ≤ 阈值时，改为逐分钟跟踪首个「回落且仍 ≤ 阈值」的
    // 分钟再卖，10:00 前未回落且仍 ≤ 阈值则按 10:00 时点价兜底），与大跌强卖原有「无条件卖出」口径一致
    const crashLoc = locateCrashSellPoint(pts);
    const crashPt = crashLoc.pt;
    // 先到先卖：止损点 / 盘中大卖点 / 10:00 强卖点取分钟最早者（同分钟时大跌强卖优先于止损）
    let sellPt = forcedPt;
    let sellKind = 'force'; // 'force' = 10:00 强卖 | 'stop' = 成本线止损 | 'crash' = 盘中大跌强卖
    if (crashPt && Number(crashPt.minute) < Number(sellPt.minute)) { sellPt = crashPt; sellKind = 'crash'; }
    if (stopPt && Number(stopPt.minute) < Number(sellPt.minute)) { sellPt = stopPt; sellKind = 'stop'; }
    const isStopLoss = sellKind === 'stop';
    // 强卖豁免（2026-10-09）：本次将由 10:00 强卖成交（未先触发止损 / 盘中大卖点）且命中任一「次日强势」判断
    // → 本次不强卖，持仓转由通用 7 条件卖点接管（本次及后续日期均不再强卖；止损与大跌卖点仍先到先卖）
    if (sellKind === 'force' && exemptInfo) {
      pos.emoQuickOut.exempted = { date: dateStr, via: exemptInfo.via, detail: exemptInfo.detail };
      continue;
    }
    const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
    // 分批建仓仓位（两次买入 / 快进快出半仓）：按本份仓位权重折算收益，每份各自独立、互不摊平成本
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
        ? buildQuickOutStopLossReason(costBase, sellPt, stopDesc, qPct)
        : (sellKind === 'crash'
          ? buildQuickOutCrashSellReason(sellPt, crashLoc)
          : buildQuickOutSellReason(pos.emoQuickOut)),
      returnRate,
    });
    positions.splice(pi, 1);
    pi--;
    quickOutSoldDate = dateStr; // 强卖/止损当日禁止二次买入（哪怕买点再次触发）
  }
  return quickOutSoldDate;
};

module.exports = { emoQuickOutSell };