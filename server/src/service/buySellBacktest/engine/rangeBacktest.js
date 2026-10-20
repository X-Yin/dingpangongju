const { STRATEGIES, isCycleFilterStrategy } = require('../strategies/registry');
const { runKeyBlockBacktest } = require('./keyBlockBacktest');
const { runExtremeWinBacktest } = require('./extremeWinBacktest');
const { runReverseLeaderBacktest } = require('./reverseLeaderBacktest');
const { runNBoardBacktest } = require('./nBoardBacktest');
const { runVolumeShareBacktest } = require('./volumeShareBacktest');
const { runFusedEmoWinBacktest } = require('./fusedEmoWinBacktest');
const { getTrainingCampDates, loadTrainingCampData, runWithOscExclude, runWithSimContext } = require('../deps');
const { buildWindowAxis, injectSimStocksIntoCampData } = require('./pickHelpers');
const { CYB_GATE_STRATEGY_IDS, CYB_INDEX_CODE, STAR_INDEX_CODE, annotateIndexGateChecksWithStock, precomputeTurnMap, withDualGateInfo } = require('./indexGate');
const { buildPrevOneWordBoardSet, buildReplayStocksWithTline, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { EXCLUDED_CODES, OPENING_BELOW_RATIO_STRATEGY_IDS } = require('../constants');
const { withResilienceGateInfo } = require('./checkBuilders');
const { TWO_BUY_LEG_WEIGHT, TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT, computeTwoBuyAccountReturn, getPositionLegWeight, getStockBlockName } = require('./twoBuy');
const { emoQuickOutSell } = require('./sellHooks/emoQuickOut');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { buildBuyReasonFromDiag, fmtTime, runBuyPointDiagnosis } = require('../diagnose/buyPoint');
const { buildCounterCycSet } = require('./cycleFilter');
const { pickBestStock } = require('./pickBest');
const { computeEmoQuickOutInfo } = require('./emoQuick');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { ensureWatchlistValuation } = require('../../watchlistValuation');

const runRangeBacktestInner = async (startDate, endDate, strategyId = 'highest_gain', onProgress) => {
  // 买入估值限制预取：非当日缓存时拉取自选股流通市值/市盈率快照（除情绪游资相关策略外，买入候选须满足
  // 流通市值 ≥ 200 亿且市盈率非亏损；见 watchlistValuation.js）。覆盖全部路由（常规/重点板块/龙头战法）
  await ensureWatchlistValuation();
  // 重点板块-N日最高涨幅系列走独立的板块驱动回测逻辑（尾盘 14:50 买入，不走大盘买点诊断）
  if (STRATEGIES[strategyId]?.keyBlockDays != null) {
    return runKeyBlockBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 情绪游资-极致胜率走独立引擎（过去20交易日三连板及以上个股，昨日差劲分/今日强度分阈值买入，卖点沿用龙头战法 10 条）
  if (STRATEGIES[strategyId]?.extremeWinMode === true) {
    return runExtremeWinBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 情绪游资-反向抱团龙头走独立引擎（上证 3 日线斜率连续为负第 3 天起，当日上证跌幅 ≥ 0.5% 时
  // 候选股盘中强度分第 2 次 > 50 买入；卖点沿用龙头战法全部卖点并新增「上证斜率盘中由负转正」卖出；全仓单持仓）
  if (STRATEGIES[strategyId]?.reverseLeaderMode === true) {
    return runReverseLeaderBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 情绪游资-n板打板（n=2/3）走独立引擎（上证 3 日线斜率分时 > 0 时，买入上一交易日 n-1 板个股中
  // 当日首次冲高至 +8% 者；卖点沿用「情绪游资-极致胜率」顺周期腿；半仓单持仓）
  if (STRATEGIES[strategyId]?.nBoardMode === true) {
    return runNBoardBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 情绪游资-成交量占比（N=2/3/5）走独立引擎（板块成交量占比 3 日线斜率前 3 板块成分股 ∩ 近 5 日连板，
  // 买 N 日涨幅最大者、9:40 起逐桶重试；卖点 = 所属板块占比斜率转负 → 次日开盘卖出；半仓单持仓）
  if (STRATEGIES[strategyId]?.volumeShareMode === true) {
    return runVolumeShareBacktest(startDate, endDate, strategyId, onProgress);
  }
  // 科技进攻-情绪游资极致胜率走独立引擎（快进快出 + 情绪游资-极致胜率双腿融合，账户被单一风格独占；
  // 空仓时谁先触发买谁、同一时间桶内快进快出优先；见 engine/fusedEmoWinBacktest.js）
  if (STRATEGIES[strategyId]?.fusedEmoWinMode === true) {
    return runFusedEmoWinBacktest(startDate, endDate, strategyId, onProgress);
  }
  const strategy = STRATEGIES[strategyId];
  // 「N日涨幅最大-快进快出」系列（emoQuickOut 且非两次买入）：快进快出半仓（2026-10-13 用户新增）——
  // 买点触发时看该笔买入是否属于「快进快出」情形（emoQuickOut.quickOut：情绪冰点/温和回升日买入、
  // 次日 10:00 强制卖出的持仓）：属于则首次仅半仓买入（第一份），至少次日买点再次触发时再买入剩余半仓
  // （与两次买入策略同口径：同一标的、各自独立买卖与收益、均按半仓折算）；
  // 非快进快出情形（走通用 7 条件卖点）则首次即全仓买入。已有两次买入系列（twoBuy）保持原有恒定半仓行为不变。
  const emoQuickHalfBuy = strategy.emoQuickOut === true && strategy.twoBuy !== true;
  const allDates = getTrainingCampDates();
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
  // 「两次买入（同一天）」变体：当日 14:55 尾盘补买评估标记（每交易日评估一次，盈利未达标/涨停不重试）
  let sameDayTailChecked = false;
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
    sameDayTailChecked = false; // 「两次买入（同一天）」尾盘补买评估标记按日重置
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

    // 情绪快进快出策略专属卖点：次日 10:00 强卖 + 盘中跌破成本线止损（先到先卖）+ 强卖豁免
    // （见 engine/sellHooks/emoQuickOut.js）。返回强卖/止损发生日期，用于当日禁止二次买入
    if (strategy.emoQuickOut === true) {
      const soldDate = emoQuickOutSell({ positions, strategy, dateStr, dateDisplay, replayStocks, timeBuckets, campData, singleTrades });
      if (soldDate) quickOutSoldDate = soldDate;
    }

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];

      // 买入信号：情绪快进快出策略当日已发生 10:00 强制卖出 → 当日禁止二次买入（哪怕买点再次触发）；其余沿用买点诊断 allPassed
      const quickOutNoRebuy = strategy.emoQuickOut === true && quickOutSoldDate === dateStr;
      // 24 个涨幅最大/快进快出策略启用检查4 比例收紧：阈值 = ceil(科技股数 × 25%)，其余策略固定 30 只
      const buyDiag = runBuyPointDiagnosis(timeBuckets, bi, campData, { ratioGatedOpeningBelow: OPENING_BELOW_RATIO_STRATEGY_IDS.has(strategy.id) })?.data;
      const buyHit = !quickOutNoRebuy && buyDiag?.allPassed === true;
      // 买入原因：取买点诊断全部通过项汇总
      const buyInfo = buyHit ? buildBuyReasonFromDiag(buyDiag) : null;
      if (buyHit) {
        // N 日涨幅最大系列策略：跨指数双门禁 + 选股市场过滤
        const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(buyInfo, strategy.id, dateStr, bucket.minute,
          { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState });
        if (!gatePassed) {
          continue;
        }
        const buyTime = fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

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
            // 快进快出半仓：本次买入属快进快出情形（次日 10:00 强制卖出）→ 仅半仓（第一份），剩余半仓等次日买点再次触发补买
            const halfByQuickOut = emoQuickHalfBuy && picked.emoQuickOut?.quickOut === true;
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
              // 两次买入策略 / 快进快出半仓（第一份）：按半仓权重，标记 leg=1；非快进快出时全仓不标记
              ...(strategy.twoBuy === true || halfByQuickOut ? { twoBuy: true, leg: 1, weight: TWO_BUY_LEG_WEIGHT } : {}),
            });
          }
        } else if ((strategy.twoBuy === true || emoQuickHalfBuy) && positions.length === 1 && positions[0].leg === 1
          && dateStr > positions[0].buyDate) {
          // 两次买入 / 快进快出半仓策略：已持有第一份（半仓），买点再次触发 → 买入第二份 5 成
          // 约束：① 须在第一份建仓日之后的交易日买入（含「两次买入（同一天）」变体——当日不再因买点二次触发补买，
          //          改由下方 14:55 尾盘补买规则处理）；② 补买同样过滤涨停（买入时点该股已涨停不可成交）；
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

        // 「两次买入（同一天）」尾盘补买第二份（2026-10-20 用户改版）：当日不再因买点二次触发补买，
        // 改为 14:55（当日首个 minute ≥ 1455 的桶）评估一次——当日盈利（14:55 分时价 vs 第一份买入价）
        // 超过 2% 且该股未涨停 → 按 14:55 分时价尾盘买入第二份 5 成（同一只股票）；
        // 已涨停或盈利未达标 → 当日不补，等后续交易日买点再次触发时再买（见上方建仓分支）
        if (strategy.twoBuySameDay === true && !sameDayTailChecked
          && positions.length === 1 && positions[0].leg === 1 && dateStr === positions[0].buyDate
          && Number(bucket.minute) >= 1455) {
          sameDayTailChecked = true;
          const first = positions[0];
          const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
          const tailPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
          const tailLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
          const tailProfitPct = tailPx != null && first.buyPrice > 0
            ? parseFloat((((tailPx - first.buyPrice) / first.buyPrice) * 100).toFixed(2))
            : null;
          if (tailPx != null && tailPx > 0 && !tailLimitUp && tailProfitPct != null && tailProfitPct > TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT) {
            positions.push({
              code: first.code,
              stockName: first.stockName,
              buyDate: dateStr,
              buyDateDisplay: dateDisplay,
              buyTime: fmtTime(bucket.timeKey).substring(0, 5),
              buyPrice: tailPx,
              buyChange: heldSc.changePct != null ? parseFloat(Number(heldSc.changePct).toFixed(2)) : null,
              metric: first.metric,
              buyReason: `尾盘补买第二份 5 成：14:55 检查当日盈利达标（14:55 价 ${tailPx.toFixed(2)} 较第一份买入价 ${first.buyPrice.toFixed(2)} 盈利 +${tailProfitPct.toFixed(2)}% > ${TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT}% 且未涨停），按 14:55 价买入同一股票 ${first.stockName}`,
              buyChecks: first.buyChecks,
              emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
              twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
            });
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
    const legWeight = getPositionLegWeight(pos, strategy);
    if (legWeight < 1) {
      // 分批建仓（两次买入 / 快进快出半仓）：每份仓位按自身权重折算期末浮盈
      h.weight = legWeight;
      h.rawBuyReturn = rawBuyReturn;
      h.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * legWeight).toFixed(2)) : null;
    } else {
      h.buyReturn = rawBuyReturn;
    }
    currentHoldings.push(h);
  }
  const holding = currentHoldings[0] || null;
  // 整体收益：分批建仓（两次买入 / 快进快出半仓）按真实账户口径（同一轮多份同时持有 → 轮内收益相加，跨轮复利）；
  // 其余单份全仓策略同一时刻只持有一份，逐笔复利即等价账户口径
  const overallReturn = strategy.twoBuy === true || emoQuickHalfBuy
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
