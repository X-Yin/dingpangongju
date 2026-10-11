// 三日情绪均值策略（nextDayOpenSell）专属卖点：
// 买入次日按竞价开盘涨幅一次性卖出——开盘涨幅为负 → 9:30 开盘卖出；开盘涨幅 ≥ 0（含 0~1%）→ 固定 10:00 卖出。
// 当日无该股分时数据时保持持仓、顺延至后续日期重试。
// 本 hook 只做卖点行为，策略开关判定（strategy.nextDayOpenSell）由引擎负责调度。
const nextDayOpenSell = ({ positions, dateStr, dateDisplay, replayStocks, singleTrades }) => {
  for (let pi = 0; pi < positions.length; pi++) {
    const pos = positions[pi];
    if (!pos || !(dateStr > pos.buyDate)) continue;
    const entry = (replayStocks || []).find(s => s.code === pos.code);
    const pts = (entry?.tlinePoints || [])
      .filter(p => p.minute != null && p.lastPx != null && p.lastPx > 0)
      .sort((a, b) => a.minute - b.minute);
    if (pts.length === 0) continue; // 当日无该股分时数据 → 保持持仓、顺延至后续日期重试
    const openPt = pts[0]; // 竞价开盘 = 当日第一分钟分时点（开盘价≈集合竞价成交价）
    const openChange = openPt.change != null && !Number.isNaN(Number(openPt.change)) ? Number(openPt.change) : null;
    let sellPt;
    let sellReason;
    if (openChange != null && openChange < 0) {
      sellPt = openPt;
      sellReason = `次日竞价开盘涨幅 ${openChange.toFixed(2)}% 为负，9:30 开盘直接卖出`;
    } else {
      // 开盘涨幅 ≥ 0（含 0~1% 及无法读取开盘涨幅）：固定次日 10:00 卖出（取当日第一个 minute ≥ 1000 的分时点，未覆盖时回退当日最后一分钟）
      sellPt = pts.find(p => Number(p.minute) >= 1000) || pts[pts.length - 1];
      sellReason = openChange != null
        ? `次日竞价开盘涨幅 +${openChange.toFixed(2)}% ≥ 0，固定 10:00 卖出`
        : '次日开盘涨幅缺失，按非负口径固定 10:00 卖出';
    }
    const sellPrice = parseFloat(Number(sellPt.lastPx).toFixed(2));
    const returnRate = pos.buyPrice > 0
      ? parseFloat((((sellPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
      : null;
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
      sellDate: dateStr,
      sellDateDisplay: dateDisplay,
      sellTime: `${String(Math.floor(Number(sellPt.minute) / 100)).padStart(2, '0')}:${String(Number(sellPt.minute) % 100).padStart(2, '0')}`,
      sellPrice,
      sellChange: sellPt.change != null ? parseFloat(Number(sellPt.change).toFixed(2)) : null,
      sellReason,
      returnRate,
    });
    positions.splice(pi, 1);
    pi--;
  }
};

module.exports = { nextDayOpenSell };