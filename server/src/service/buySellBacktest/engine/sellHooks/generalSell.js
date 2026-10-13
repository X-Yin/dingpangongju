// 通用卖点 hook：逐份诊断持仓（普通单股策略最多 1 份；两次买入策略最多 2 份，各自独立卖点），
// 走通用 7 条件卖点诊断（runSellPointDiagnosis），命中即记账并移除持仓。
// 情绪快进快出持仓（未豁免 ever）不进入通用卖点诊断（由 emoQuickOut hook 接管）；
// 三日情绪均值策略（nextDayOpenSell）走次日开盘专属卖点（已按日处理），同样不进入通用卖点诊断。
const { runSellPointDiagnosis } = require('../../diagnose/sellPoint');
const { buildTwoBuyTradeExtra, getPositionLegWeight, isLegPosition } = require('../twoBuy');
const { buildQuickOutExemptSuffix } = require('../checkBuilders');

const generalSellPositions = async ({ positions, strategy, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades }) => {
  const bucket = timeBuckets[bi];
  for (let pi = 0; pi < positions.length; pi++) {
    const pos = positions[pi];
    if (!pos) continue;
    if (dateStr <= pos.buyDate) continue; // 当日买入不可当日卖出（T+1）
    // 情绪快进快出持仓：不走通用 7 条件卖点，仅由 emoQuickOut hook 按日处理（盘中跌破成本线止损先到先卖 + 10:00 强卖；分时缺失时顺延）；
    // 2026-10-09 起命中强势豁免的快进快出持仓（exempted）转为普通持仓，由通用 7 条件卖点接管
    if (strategy.emoQuickOut === true && pos.emoQuickOut?.quickOut === true && !pos.emoQuickOut?.exempted) continue;
    // 三日情绪均值策略走次日开盘专属卖点（已在桶循环前按日处理），不进入通用卖点诊断
    const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate, tailDipSell: strategy.tailDip === true && strategy.nextDayOpenSell !== true, costLinePct: strategy.costLinePct };
    const result = await runSellPointDiagnosis(position, bucket, replayStocks, timeBuckets, bi, dateStr);
    if (result.isSell && result.closePrice != null) {
      const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
      // 分批建仓仓位（两次买入 / 快进快出半仓）：每份仓位各自独立按权重折算收益，保留个股原始收益率供前端悬停展示
      const isTwoBuy = isLegPosition(pos, strategy);
      const rawReturnRate = result.returnRate;
      const legWeight = getPositionLegWeight(pos, strategy);
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
        sellTime: result.displayTime,
        sellPrice: result.closePrice,
        sellChange: result.change,
        sellReason: (satisfiedNames || '卖出条件触发') + buildQuickOutExemptSuffix(pos),
        returnRate,
      });
      positions.splice(pi, 1);
      pi--;
    }
  }
};

module.exports = { generalSellPositions };