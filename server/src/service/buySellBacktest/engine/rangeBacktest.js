const { STRATEGIES, isCycleFilterStrategy } = require('../strategies/registry');
const { runKeyBlockBacktest } = require('./keyBlockBacktest');
const { runLianbanGainBacktest } = require('./lianbanGainBacktest');
const { getTrainingCampDates, loadTrainingCampData, runWithOscExclude, runWithSimContext } = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { buildWindowAxis, injectSimStocksIntoCampData } = require('./pickHelpers');
const { CYB_GATE_STRATEGY_IDS, CYB_INDEX_CODE, STAR_INDEX_CODE, annotateIndexGateChecksWithStock, precomputeTurnMap, withDualGateInfo } = require('./indexGate');
const { buildPrevOneWordBoardSet, buildReplayStocksWithTline, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { EXCLUDED_CODES } = require('../constants');
const { ensureEmo3DayGates } = require('./emo3Gate');
const { withResilienceGateInfo } = require('./checkBuilders');
const { TWO_BUY_LEG_WEIGHT, computeTwoBuyAccountReturn, getStockBlockName } = require('./twoBuy');
const { nextDayOpenSell } = require('./sellHooks/nextDayOpen');
const { emoQuickOutSell } = require('./sellHooks/emoQuickOut');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { EMO_AVG3_BUY_INFO, TAIL_DIP_BUY_INFO, buildBuyReasonFromDiag, checkEmoAvg3Hit, checkTailDipHit, fmtTime, runBuyPointDiagnosis } = require('../diagnose/buyPoint');
const { buildCounterCycSet } = require('./cycleFilter');
const { pickBestStock } = require('./pickBest');
const { computeEmoQuickOutInfo } = require('./emoQuick');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');

const runRangeBacktestInner = async (startDate, endDate, strategyId = 'highest_gain', onProgress) => {
  // 重点板块-N日最高涨幅系列走独立的板块驱动回测逻辑（尾盘 14:50 买入，不走大盘买点诊断）
  if (STRATEGIES[strategyId]?.keyBlockDays != null) {
    return runKeyBlockBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 情绪游资-连板 N 日涨幅最大系列走独立引擎（上证斜率>0 买、连板板块选股、专属 5 类卖点）
  if (STRATEGIES[strategyId]?.lianbanGainDays != null) {
    return runLianbanGainBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 三日情绪均值系列不依赖资金快照，日期序列并入 tech_index 覆盖的交易日（补上缺资金快照的日期，如 20260730）
  const strategy = STRATEGIES[strategyId];
  const allDates = strategy.emoAvgBuy === true
    ? Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    : getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  // 持仓列表：普通单股策略最多 1 个；两次买入策略最多 2 个（两份仓位各自独立买卖，均半仓）
  const positions = []; // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric, ... }
  // 情绪快进快出策略：最近一次 10:00 强制卖出的日期（该日禁止二次买入，哪怕买点再次触发）
  let quickOutSoldDate = null;
  const singleTrades = [];
  const skippedDates = [];

  // 历史每日 EOD 信息：{ date: Map<code, {changePct, closePx, resilience}> }
  const dailyInfos = new Map();
  // 预热起始日前 10 个交易日 EOD，日期轴前移，保证起点附近「最近 N 日」窗口不被起始日截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, 10, dailyInfos);
  // 回测期间出现过的全部自选股（供前端复制K线等使用）
  const seenStocks = new Map(); // code -> { code, name }

  // 跨指数双门禁预计算（仅对 N 日涨幅最大系列策略启用；其余策略跳过）
  let cybGatePrecomputed = null, starGatePrecomputed = null;
  const cybGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const starGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const applyCybGate = CYB_GATE_STRATEGY_IDS.has(strategyId);
  if (applyCybGate) {
    try {
      [cybGatePrecomputed, starGatePrecomputed] = await Promise.all([
        precomputeTurnMap(CYB_INDEX_CODE, rangeDates),
        precomputeTurnMap(STAR_INDEX_CODE, rangeDates),
      ]);
    } catch (e) {
      cybGatePrecomputed = null; starGatePrecomputed = null;
    }
  }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      // 统一允许缺失资金快照的日期兜底构建（见 runKeyBlockBacktest 内说明），避免整日跳过漏执行卖点
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
    await injectSimStocksIntoCampData(campData, dateStr); // 随机模拟：把合成股票混入当日候选池
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用）
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    // 记录回测期间出现过的全部自选股（供前端复制K线等使用）
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 三日情绪冰点策略：预计算当日跟踪指数环境门禁（pickBestStock 内同步查表过滤候选，见 calcEmo3IndexGate）
    if (strategy.emoAvgBuy === true) await ensureEmo3DayGates(dateStr);

    // 三日情绪均值策略专属卖点：买入次日按竞价开盘涨幅一次性卖出（见 engine/sellHooks/nextDayOpen.js）
    if (strategy.nextDayOpenSell === true) {
      nextDayOpenSell({ positions, dateStr, dateDisplay, replayStocks, singleTrades });
    }

    // 情绪快进快出策略专属卖点：次日 10:00 强卖 + 盘中跌破成本线止损（先到先卖）+ 强卖豁免
    // （见 engine/sellHooks/emoQuickOut.js）。返回强卖/止损发生日期，用于当日禁止二次买入
    if (strategy.emoQuickOut === true) {
      const soldDate = emoQuickOutSell({ positions, strategy, dateStr, dateDisplay, replayStocks, timeBuckets, campData, singleTrades });
      if (soldDate) quickOutSoldDate = soldDate;
    }

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];

      // 买入信号：尾盘抄底策略仅以尾盘抄底命中为买入前提（不跑买点诊断），其余策略沿用买点诊断 allPassed
      // 情绪快进快出策略：当日已发生 10:00 强制卖出 → 当日禁止二次买入（哪怕买点再次触发）
      const quickOutNoRebuy = strategy.emoQuickOut === true && quickOutSoldDate === dateStr;
      const buyDiag = strategy.tailDip === true ? null : runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
      const buyHit = !quickOutNoRebuy && (strategy.tailDip === true
        ? (strategy.emoAvgBuy === true ? checkEmoAvg3Hit(timeBuckets, bi, dateStr) : checkTailDipHit(timeBuckets, bi))
        : buyDiag?.allPassed === true);
      // 买入原因：命中了哪些买入条件（尾盘抄底为固定命中原因，三日情绪均值走专属命中原因，其余取买点诊断全部通过项汇总）
      const buyInfo = buyHit
        ? (strategy.tailDip === true ? (strategy.emoAvgBuy === true ? EMO_AVG3_BUY_INFO : TAIL_DIP_BUY_INFO) : buildBuyReasonFromDiag(buyDiag))
        : null;
      if (buyHit) {
        // N 日涨幅最大系列策略：跨指数双门禁 + 选股市场过滤
        const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(buyInfo, strategy.id, dateStr, bucket.minute,
          { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState });
        if (!gatePassed) {
          continue;
        }
        // 尾盘抄底策略 14:57 尾盘挂单买入（收盘集合竞价成交，价格取触发桶价），按挂单时间显示；其余策略按桶时间
        const buyTime = strategy.tailDip === true ? '14:57' : fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

        if (positions.length === 0) {
          // 未持仓时按指标选最优的一只买入（普通策略同一时刻仅持有一只；两次买入策略建第一份）
          // 上一交易日一字板过滤（全策略通用）：预取候选池昨日一字板集合传入选股（进程内按 股票_日期 缓存）
          const prevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
          // 顺/逆周期过滤（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略）：预取逆周期候选集合传入选股
          const emoCycSet = isCycleFilterStrategy(strategy)
            ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
            : null;
          const picked = pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet);
          if (picked) {
            // 两次买入系列叠加「快进快出」能力：首次建仓时按买入时点计算快进快出标注
            // （与 highest_{N}d_gain_emoquick 同口径，传入日期轴绝对索引 di + axisOffset），挂到持仓上驱动
            // 次日 10:00 强卖 + 盘中跌破成本线止损。必须在 withResilienceGateInfo 之前挂载，买入明细方可写入 emo_quick_out 判定项。
            if (strategy.twoBuy === true && strategy.emoQuickOut === true) {
              picked.emoQuickOut = computeEmoQuickOutInfo(di + axisOffset, dateAxis);
            }
            const finalBuyInfo = withResilienceGateInfo(gatedBuyInfo, picked);
            const sc = picked.stock;
            const firstBuyPrice = parseFloat(Number(sc.lastPx).toFixed(2));
            positions.push({
              code: sc.code,
              stockName: sc.name || sc.code,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime,
              buyPrice: firstBuyPrice,
              buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
              metric: picked.metric,
              buyReason: finalBuyInfo.buyReason,
              buyChecks: annotateIndexGateChecksWithStock(finalBuyInfo.buyChecks, sc.code, sc.name),
              emoQuickOut: picked.emoQuickOut || null, // 情绪快进快出标注（quickOut=true → 次日 10:00 强制卖出；其余策略为 null）
              // 两次买入策略：第一份按半仓权重，标记 leg=1
              ...(strategy.twoBuy === true ? { twoBuy: true, leg: 1, weight: TWO_BUY_LEG_WEIGHT } : {}),
            });
          }
        } else if (strategy.twoBuy === true && positions.length === 1 && positions[0].leg === 1 && dateStr > positions[0].buyDate) {
          // 两次买入策略：已持有第一份（半仓），买点再次触发 → 买入第二份 5 成
          // 约束：① 必须在第一份建仓之后的交易日（≥ 隔 1 天）买入；② 补买同样过滤涨停（买入时点该股已涨停不可成交）；
          //       ③ 普通两次买入系列第二份必须与第一份同一只股票（不重新择股）；
          //          「不同板块」变体（diffBlock）第二份则在「板块与第一份不同」的候选中重新按 N 日涨幅最大择股
          const first = positions[0];
          if (strategy.diffBlock === true) {
            // 两次买入不同板块：第二份在「所属板块（blockName）≠ 第一份板块」的候选中重新择股（N 日涨幅最大）
            const firstBlock = getStockBlockName(first.code);
            const restrictCodes = new Set(
              (bucket.stockChanges || [])
                .filter(s => s.lastPx != null && s.lastPx > 0 && getStockBlockName(s.code) !== firstBlock)
                .map(s => s.code)
            );
            const secondPrevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
            const secondEmoCycSet = isCycleFilterStrategy(strategy)
              ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
              : null;
            const secondPicked = restrictCodes.size > 0
              ? pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, secondPrevOneWordSet, secondEmoCycSet, restrictCodes)
              : null;
            if (secondPicked) {
              const secondBuyInfo = withResilienceGateInfo(gatedBuyInfo, secondPicked);
              const sc2 = secondPicked.stock;
              const secondPx = parseFloat(Number(sc2.lastPx).toFixed(2));
              positions.push({
                code: sc2.code,
                stockName: sc2.name || sc2.code,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: secondPx,
                buyChange: sc2.changePct != null ? parseFloat(Number(sc2.changePct).toFixed(2)) : null,
                metric: secondPicked.metric,
                buyReason: `${secondBuyInfo.buyReason}；买点第二次触发，买入第二份 5 成（第一份 ${first.stockName}·${firstBlock} 板块，本份改选其他板块中 N 日涨幅最大的 ${sc2.name || sc2.code}·${getStockBlockName(sc2.code)} 板块，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                buyChecks: annotateIndexGateChecksWithStock(secondBuyInfo.buyChecks, sc2.code, sc2.name),
                emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
              });
            }
          } else {
            const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
            const secondPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
            const heldLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
            if (secondPx != null && secondPx > 0 && !heldLimitUp) {
              positions.push({
                code: first.code,
                stockName: first.stockName,
                buyDate: dateStr,
                buyDateDisplay: dateDisplay,
                buyTime,
                buyPrice: secondPx,
                buyChange: heldSc.changePct != null ? parseFloat(Number(heldSc.changePct).toFixed(2)) : null,
                metric: first.metric,
                buyReason: `${gatedBuyInfo?.buyReason || first.buyReason}；买点第二次触发，买入第二份 5 成（同一股票 ${first.stockName}，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                buyChecks: annotateIndexGateChecksWithStock(gatedBuyInfo?.buyChecks || first.buyChecks, first.code, first.stockName),
                emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
              });
            }
          }
        }
      }

      // 卖出信号（通用 7 条件卖点，见 engine/sellHooks/generalSell.js）
      await generalSellPositions({ positions, strategy, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades });
    }

  }

  // 组装结果
  // 期末持仓：逐份按最近一个有效日期的收盘价估算浮盈，计入整体收益（两次买入策略可能同时持有两份）
  const currentHoldings = [];
  for (const pos of positions) {
    const h = { ...pos };
    let closePx = null;
    // 自最后一日起向前找到最近的收盘数据，用于估算期末浮盈
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(pos.code);
      if (info && info.closePx != null && info.closePx > 0) { closePx = info.closePx; break; }
    }
    const rawBuyReturn = closePx != null && pos.buyPrice > 0
      ? parseFloat((((closePx - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2))
      : null;
    if (strategy.twoBuy === true) {
      // 两次买入：每份仓位各自半仓折算期末浮盈
      h.weight = TWO_BUY_LEG_WEIGHT;
      h.rawBuyReturn = rawBuyReturn;
      h.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * TWO_BUY_LEG_WEIGHT).toFixed(2)) : null;
    } else {
      h.buyReturn = rawBuyReturn;
    }
    currentHoldings.push(h);
  }
  const holding = currentHoldings[0] || null;
  // 整体收益：两次买入按真实账户口径（同一轮两份同时持有 → 轮内收益相加，跨轮复利）；
  // 其余单份策略同一时刻只持有一份，逐笔复利即等价账户口径
  const overallReturn = strategy.twoBuy === true
    ? computeTwoBuyAccountReturn([
        ...singleTrades,
        ...currentHoldings.map(h => ({ ...h, returnRate: h.buyReturn })),
      ])
    : (() => {
        let acc = 1;
        for (const t of singleTrades) {
          if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
        }
        for (const h of currentHoldings) acc *= 1 + (h.buyReturn || 0) / 100;
        return parseFloat(((acc - 1) * 100).toFixed(2));
      })();
  const validTrades = singleTrades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  // 买入当日收益（2026-10-10 用户新增）：为每笔成交与期末持仓补写「买入价 → 买入当日收盘价」收益率
  await attachBuyDayReturn(singleTrades);
  await attachBuyDayReturn(currentHoldings);
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: sortTradesByBuyTime(singleTrades),
    currentHolding: holding,
    currentHoldings,
    summary: {
      tradeCount: singleTrades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: currentHoldings.length > 0,
    },
  };
};

// 多日回测入口：可选 options.excludeCodes（震荡测试勾选隐藏的股票代码列表）。
// 排除列表经 AsyncLocalStorage 注入整次回测执行链，候选选股处（pickBestStock / 弱转强 /
// 四份仓位 / 两个股票 / 重点板块）统一过滤，被隐藏的股票不参与选股买入
const runRangeBacktest = (startDate, endDate, strategyId = 'highest_gain', onProgress, options = {}) => {
  const excludeList = Array.isArray(options.excludeCodes)
    ? options.excludeCodes.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
    : [];
  const excludeSet = excludeList.length > 0 ? new Set(excludeList.map(c => c.toLowerCase())) : null;
  // options.sim：随机模拟测试注入的合成股票集合（AsyncLocalStorage 上下文，见 backtestSimContext）
  const sim = options.sim || null;
  return runWithSimContext(sim, () => runWithOscExclude(excludeSet, () => runRangeBacktestInner(startDate, endDate, strategyId, onProgress)));
};

// 多策略共享数据回测：外层日期、内层策略，同一天回放数据只加载一次依次喂给全部策略。
// 与 runRangeBacktest 的差异仅在于数据加载被整组策略共享（dailyInfos/seenStocks 由 campData 派生，与策略无关，可共享），
// 持仓状态与成交流水按策略独立维护，单策略结果结构与 runRangeBacktest 完全一致。
// 返回：[{ strategyId, result }]

module.exports = {
  runRangeBacktest,
  runRangeBacktestInner,
};
