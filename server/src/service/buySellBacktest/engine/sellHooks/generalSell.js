// 通用卖点 hook：逐份诊断持仓（普通单股策略最多 1 份；两次买入策略最多 2 份，各自独立卖点），
// 走通用 7 条件卖点诊断（runSellPointDiagnosis），命中即记账并移除持仓。
// 情绪快进快出持仓（未豁免 ever）不进入通用卖点诊断（由 emoQuickOut hook 接管）；
// 三日情绪均值策略（nextDayOpenSell）走次日开盘专属卖点（已按日处理），同样不进入通用卖点诊断。
// 2026-10-15 叠加快进快出系列「盘中大跌强卖」预检（emoQuickOut / crashSell 策略）：
// 当桶该股当日跌幅（较昨收涨跌幅）≤ EMO_QUICK_CRASH_PCT（-7%）时无条件卖出，先于通用 7 条件判定。
// 覆盖该系列全部持仓（普通持仓 + 强卖豁免后的快进快出持仓；未豁免的快进快出持仓由 emoQuickOut hook
// 以分钟级精度接管，不会进入本 hook）。2026-10-19 叠加竞价低开自救窗口（见 engine/crashSellWindow.js）：
// 首个分时点即 ≤ 阈值时改为逐分钟等待自救拉升结束的首个回落分钟，桶级调用只使用不晚于当桶分钟的分钟点。
const { runSellPointDiagnosis } = require('../../diagnose/sellPoint');
const { buildTwoBuyTradeExtra, getPositionLegWeight, getUnifiedCostLinePrice, isLegPosition } = require('../twoBuy');
const { buildQuickOutExemptSuffix } = require('../checkBuilders');
const { locateCrashSellPoint, describeCrashSell, fmtMin } = require('../crashSellWindow');

const generalSellPositions = async ({ positions, strategy, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades }) => {
  const bucket = timeBuckets[bi];
  for (let pi = 0; pi < positions.length; pi++) {
    const pos = positions[pi];
    if (!pos) continue;
    if (dateStr <= pos.buyDate) continue; // 当日买入不可当日卖出（T+1）
    // 情绪快进快出持仓：不走通用 7 条件卖点，仅由 emoQuickOut hook 按日处理（盘中跌破成本线止损先到先卖 + 10:00 强卖；分时缺失时顺延）；
    // 2026-10-09 起命中强势豁免的快进快出持仓（exempted）转为普通持仓，由通用 7 条件卖点接管
    if (strategy.emoQuickOut === true && pos.emoQuickOut?.quickOut === true && !pos.emoQuickOut?.exempted) continue;
    // 盘中大跌强卖（2026-10-15 快进快出系列新增；2026-10-16 扩展至其余常规策略）：该股当日跌幅（较昨收）
    // ≤ -7% 时无条件卖出（卖出原因独立标注，不走通用 7 条件诊断）。2026-10-19 叠加竞价低开自救窗口：
    // 卖出点由「当桶价」改为按真分钟分时定位（upToMinute = 当桶分钟，不使用未来数据）；首分钟即 ≤ 阈值时
    // 需等到首个回落分钟才卖，尚未等到则本桶不卖、后续桶继续跟踪
    if (strategy.emoQuickOut === true || strategy.crashSell === true) {
      const crashEntry = (replayStocks || []).find(s => s && s.code === pos.code);
      const crashLoc = locateCrashSellPoint(crashEntry?.tlinePoints, { upToMinute: Number(bucket.minute) });
      const crashPt = crashLoc.pt;
      if (crashPt) {
        const sellPrice = parseFloat(Number(crashPt.lastPx).toFixed(2));
        const isTwoBuy = isLegPosition(pos, strategy);
        const rawReturnRate = pos.buyPrice > 0
          ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
          : null;
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
          raisedBlockDelay: pos.raisedBlockDelay || null,
          ...(isTwoBuy ? buildTwoBuyTradeExtra({ ...pos, rawReturnRate }) : {}),
          sellDate: dateStr,
          sellDateDisplay: dateDisplay,
          sellTime: fmtMin(crashPt.minute),
          sellPrice,
          sellChange: crashPt.change != null ? parseFloat(Number(crashPt.change).toFixed(2)) : null,
          sellReason: strategy.emoQuickOut === true
            ? `快进快出系列盘中大跌强卖：${describeCrashSell(crashLoc)}，无条件卖出${buildQuickOutExemptSuffix(pos)}`
            : `策略通用盘中大跌强卖：${describeCrashSell(crashLoc)}，无条件卖出`,
          returnRate,
        });
        positions.splice(pi, 1);
        pi--;
        continue;
      }
    }
    // 「两次买入（同一天）」统一成本线（2026-10-20）：两份均在持时传两次买入价均价作为成本线基准
    //（仅条件7「跌破成本线 -2%」判定使用；收益率 returnRate 仍按各自实际买入价计算）
    const unifiedCost = getUnifiedCostLinePrice(pos, positions, strategy);
    const position = { code: pos.code, stockName: pos.stockName, buyPrice: pos.buyPrice, buyDate: pos.buyDate, costLinePct: strategy.costLinePct, ...(unifiedCost != null ? { costLinePrice: unifiedCost } : {}) };
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
        raisedBlockDelay: pos.raisedBlockDelay || null,
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