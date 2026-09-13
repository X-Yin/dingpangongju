const { sleep } = require('../utils');
const path = require('path');
const { getSingleStockData } = require('./stock');
/**
 * 基于 3 日均线 (MA3) 斜率及 15 日真龙头表现，判断市场情绪周期
 * 
 * @param {Array} stocks - 股票数据列表 [{ stockName, stockCode, klineData }]
 * @param {Object} options - 配置参数
 * @returns {Array} 逐日情绪周期分析结果
 */
function analyzeMarketByMA3Slope(stocks, options = {}) {
  if (!stocks || stocks.length === 0) return [];

  const FLAT_THRESHOLD = options.flatThreshold || 0.15;
  const STEEP_THRESHOLD = options.steepThreshold || 2.5; 

  const dateSet = new Set();
  stocks.forEach(stock => {
    (stock.klineData || []).forEach(item => dateSet.add(item.trade_date));
  });
  const sortedDates = Array.from(dateSet).sort((a, b) => a - b);

  const stockMapByDate = new Map();

  stocks.forEach(stock => {
    const sortedKline = [...stock.klineData].sort((a, b) => a.trade_date - b.trade_date);

    sortedKline.forEach((item, index) => {
      if (index < 3) return;

      const ma3Today = (sortedKline[index].close_px + sortedKline[index - 1].close_px + sortedKline[index - 2].close_px) / 3;
      const ma3Yesterday = (sortedKline[index - 1].close_px + sortedKline[index - 2].close_px + sortedKline[index - 3].close_px) / 3;
      const slope = ((ma3Today - ma3Yesterday) / ma3Yesterday) * 100;

      let status = 'FLAT';
      if (slope > FLAT_THRESHOLD) status = 'UP';
      else if (slope < -FLAT_THRESHOLD) status = 'DOWN';

      const lookback = 15;
      const startIndex15d = Math.max(0, index - lookback + 1);
      const startPx15d = sortedKline[startIndex15d].close_px;
      const rolling15dReturn = ((item.close_px - startPx15d) / startPx15d) * 100;

      if (!stockMapByDate.has(item.trade_date)) {
        stockMapByDate.set(item.trade_date, new Map());
      }

      stockMapByDate.get(item.trade_date).set(stock.stockName, {
        close_px: item.close_px,
        ma3: ma3Today,
        slope: slope,
        status: status,
        stockCode: stock.stockCode || 'UNKNOWN',
        rolling15dReturn: rolling15dReturn
      });
    });
  });

  const dailyAnalysis = [];

  sortedDates.forEach((date) => {
    const dayMap = stockMapByDate.get(date);
    if (!dayMap || dayMap.size === 0) return;

    const totalCount = dayMap.size;
    const allStocksToday = [];
    const upStocks = [];
    const flatStocks = [];
    const downStocks = [];
    let totalSlope = 0;

    dayMap.forEach((info, stockName) => {
      const item = { stockName, stockCode: info.stockCode, slope: info.slope, ma3: info.ma3, return15d: info.rolling15dReturn };
      allStocksToday.push(item);
      totalSlope += info.slope;

      if (info.status === 'UP') upStocks.push(item);
      else if (info.status === 'FLAT') flatStocks.push(item);
      else downStocks.push(item);
    });

    const sortedBy15d = [...allStocksToday].sort((a, b) => b.return15d - a.return15d);
    const leaderCount = Math.min(5, Math.max(1, Math.ceil(totalCount * 0.05)));
    const trueLeaders = sortedBy15d.slice(0, leaderCount);
    
    // ★新增：提取出这些龙头的名字，用顿号拼接，方便在 reasoning 中直接点名
    const leaderNames = trueLeaders.map(l => l.stockName).join('、');
    
    const avgLeaderSlope = trueLeaders.reduce((sum, l) => sum + l.slope, 0) / trueLeaders.length;
    const isLeaderCrashing = avgLeaderSlope < -FLAT_THRESHOLD;

    const upRatio = upStocks.length / totalCount;
    const flatRatio = flatStocks.length / totalCount;
    const downRatio = downStocks.length / totalCount;
    const avgMarketSlope = totalSlope / totalCount; 
    const avgUpSlope = upStocks.length ? upStocks.reduce((sum, s) => sum + s.slope, 0) / upStocks.length : 0;

    let phase = '';
    let reasoning = '';
    let statusCode = '';

    // ★在以下判断逻辑中，将 ${leaderNames} 动态注入到结论中

    if (isLeaderCrashing && upRatio >= 0.20) {
      statusCode = 'BULL_TRAP';
      phase = '【退潮初期】龙头补跌 / 低位诱多陷阱';
      reasoning = `近15日涨幅最大的真龙头（如：${leaderNames}）已开始补跌（龙头平均斜率 ${avgLeaderSlope.toFixed(2)}%）。此时即便有 ${Math.round(upRatio * 100)}% 的新题材在补涨抬头，也大概率是高低切换的诱多陷阱，龙头退潮随时会把低位股带崩。`;
    }
    else if (isLeaderCrashing && downRatio >= 0.50) {
      statusCode = 'CAPITULATION';
      phase = '【全面退潮期】龙头补跌 / 泥沙俱下';
      reasoning = `全市场 ${Math.round(downRatio * 100)}% 股票 3 日线转负，且近15日核心龙头（如：${leaderNames}）彻底崩溃补跌（平均斜率 ${avgLeaderSlope.toFixed(2)}%）。最后的避风港瓦解，市场处于真正的极度恐慌和出清阶段。`;
    }
    else if (downRatio >= 0.85 && avgMarketSlope > -STEEP_THRESHOLD && !isLeaderCrashing) {
      statusCode = 'CONSOLIDATION_WEAK';
      phase = '【震荡整理期】弱势阴跌 / 钝刀割肉';
      reasoning = `虽然 ${Math.round(downRatio * 100)}% 股票斜率为负，但全市场平均斜率仅为 ${avgMarketSlope.toFixed(2)}%，且核心龙头（${leaderNames}）暂未崩盘，属于平缓阴跌，混沌期未见底。`;
    }
    else if (downRatio >= 0.50 && !isLeaderCrashing) {
      statusCode = 'EARLY_DOWNTREND';
      phase = '【下跌前期】弱势掉队 / 龙头高位死扛';
      reasoning = `大部分股票（${Math.round(downRatio * 100)}%）已转负走弱，但近15日龙头（如：${leaderNames}）仍在强行死扛（平均斜率 ${avgLeaderSlope.toFixed(2)}%）。进入下跌中段，死扛的高位龙头随时面临补跌风险。`;
    }
    else if (upRatio >= 0.70 && avgMarketSlope >= STEEP_THRESHOLD) {
      statusCode = 'UPTREND';
      phase = '【主升期】全盘普涨 / 多头大面积共振';
      reasoning = `超过 70% 股票（实际 ${Math.round(upRatio * 100)}%）向上冲刺，且全市场平均斜率达 ${avgMarketSlope.toFixed(2)}%。动能充沛，是真正的主升浪。`;
    }
    else if (upRatio >= 0.70 && avgMarketSlope < STEEP_THRESHOLD) {
      statusCode = 'CONSOLIDATION_STRONG';
      phase = '【震荡整理期】虚假繁荣 / 动能不足';
      reasoning = `虽然有 ${Math.round(upRatio * 100)}% 股票 3 日线转正，但全市场平均斜率仅为 ${avgMarketSlope.toFixed(2)}%，属于横盘震荡而非强势主升。`;
    }
    else if (upRatio < 0.70 && upRatio >= 0.10 && avgLeaderSlope >= STEEP_THRESHOLD) {
      statusCode = 'TOPPING';
      phase = '【分化赶顶期】后排减缓 / 龙头加速诱多';
      reasoning = `后排股票斜率大幅减缓，但近15日核心龙头（如：${leaderNames}）仍在极端加速飙车（平均斜率高达 ${avgLeaderSlope.toFixed(2)}%）。资金极端抱团，随时可能见顶变盘。`;
    }
    else {
      statusCode = 'CONSOLIDATION';
      phase = '【震荡整理期】强弱方向不明显';
      reasoning = `多空双方均无明显加速度，处于多空平衡的震荡期。`;
    }

    upStocks.sort((a, b) => b.slope - a.slope);
    downStocks.sort((a, b) => a.slope - b.slope);

    dailyAnalysis.push({
      tradeDate: date,
      statusCode: statusCode,
      phase: phase,
      stats: {
        avgMarketSlope: `${avgMarketSlope.toFixed(2)}%`, 
        avgLeaderSlope: `${avgLeaderSlope.toFixed(2)}%`, 
        upRatio: `${(upRatio * 100).toFixed(1)}%`,
        flatRatio: `${(flatRatio * 100).toFixed(1)}%`,
        downRatio: `${(downRatio * 100).toFixed(1)}%`
      },
      trueLeaders: trueLeaders.map(l => ({
        stockName: l.stockName,
        stockCode: l.stockCode,
        return15d: `${l.return15d.toFixed(2)}%`,
        slope: `${l.slope.toFixed(2)}%`
      })),
      strongStocks: upStocks.map(s => ({ stockName: s.stockName, stockCode: s.stockCode, slope: s.slope.toFixed(2) })),
      weakStocks: downStocks.map(s => ({ stockName: s.stockName, stockCode: s.stockCode, slope: s.slope.toFixed(2) })),
      reasoning: reasoning
    });
  });

  return dailyAnalysis;
}

async function analyzeMonitorStocks() {
    const fs = require('fs');
    const stockKlineList = [];
    const stocks = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../data/monitor_stocks.json'), 'utf8')
    )
    ;
    for (let i = 0; i < stocks.length; i++) {
        const stockData = await getSingleStockData(stocks[i].code, 100);
        stockKlineList.push({
            stockName: stocks[i].name,
            stockCode: stocks[i].code,
            klineData: stockData,
        });
        await sleep(200);
    }
    const result = analyzeMarketByMA3Slope(stockKlineList);
    return result;
}

// (async () => {
//     const result = await analyzeMonitorStocks();
//     const fs = require('fs');
//     fs.writeFileSync(
//         path.join(__dirname, '../test/monitor_emotion_cycle.json'),
//         JSON.stringify(result, null, 2)
//     );
// })()

module.exports={
    analyzeMonitorStocks
};