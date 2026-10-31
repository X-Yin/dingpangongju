const { STRATEGIES, isCycleFilterStrategy } = require('../strategies/registry');
const { runKeyBlockBacktest } = require('./keyBlockBacktest');
const { runReverseLeaderBacktest } = require('./reverseLeaderBacktest');
const { runNBoardBacktest } = require('./nBoardBacktest');
const { runVolumeShareBacktest } = require('./volumeShareBacktest');
const { runGainVolumeShareBacktest } = require('./gainVolumeShareBacktest');
const { runExtremeWinBacktest } = require('./extremeWinBacktest');
const { runFusedEmoWinBacktest } = require('./fusedEmoWinBacktest');
const { runEmotionBurstDriftBacktest } = require('./emotionBurstDriftBacktest');
const { runEmotionBurstFollowBacktest } = require('./emotionBurstFollowBacktest');
const { getTrainingCampDates, loadTrainingCampData } = require('../deps');
const { buildWindowAxis } = require('./pickHelpers');
const { CYB_GATE_STRATEGY_IDS, CYB_INDEX_CODE, STAR_INDEX_CODE, annotateIndexGateChecksWithStock, precomputeTurnMap, withDualGateInfo } = require('./indexGate');
const { buildPrevOneWordBoardSet, buildReplayStocksWithTline, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { EXCLUDED_CODES, EMO_QUICK_FUND_INFLOW_BASE, OPENING_BELOW_RATIO_STRATEGY_IDS } = require('../constants');
const { withResilienceGateInfo } = require('./checkBuilders');
const { TWO_BUY_LEG_WEIGHT, TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT, computeTwoBuyAccountReturn, getPositionLegWeight, getStockBlockName } = require('./twoBuy');
const { buildBuyReasonFromDiag, fmtTime, runBuyPointDiagnosis } = require('../diagnose/buyPoint');
const { buildCounterCycSet } = require('./cycleFilter');
const { pickBestStock } = require('./pickBest');
const { resolveQuickRaisedBlocks, resolveRaisedBlockLookbackBucket, resolveRaisedBlockDelayTarget, isRaisedBlockDelayBucket, isRaisedBlockDelayExpired, buildIceGainWindowMax, isIceGainConfirmed } = require('./quickRaisedBlock');
const { buildAttackDelayWindowCheck, resolveAttackBlocks, resolveAttackDelayTarget } = require('./attackDelay');
const { computeEmoQuickOutInfo, getBucketTechEmotion, createEmoQuickFundGate, isTechIceGateOpen } = require('./emoQuick');
const { emoQuickOutSell } = require('./sellHooks/emoQuickOut');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { ensureWatchlistValuation } = require('../../watchlistValuation');

const runRangeBacktestMulti = async (startDate, endDate, strategyIds, onProgress) => {
  const ids = (Array.isArray(strategyIds) ? strategyIds : []).filter(id => STRATEGIES[id]);
  if (ids.length === 0) return [];
  // 买入估值限制预取：非当日缓存时拉取自选股流通市值/市盈率快照（除情绪游资相关策略外，买入候选须满足
  // 流通市值 ≥ 200 亿且市盈率非亏损；见 watchlistValuation.js）。覆盖本组全部策略（重点板块/龙头战法/常规）
  await ensureWatchlistValuation();
  // 重点板块-N日最高涨幅系列走独立回测（板块驱动、尾盘 14:50 买入，不走共享数据循环的买点诊断）
  const keyBlockIds = ids.filter(id => STRATEGIES[id]?.keyBlockDays != null);
  // 情绪游资-反向抱团龙头走独立引擎（上证 3 日线斜率连续为负第 3 天起、当日上证跌幅 ≥ 0.5% 时
  // 候选股盘中强度分第 2 次 > 50 买入；卖点沿用龙头战法全部卖点并新增「上证斜率盘中由负转正」卖出；全仓单持仓）
  const reverseLeaderIds = ids.filter(id => STRATEGIES[id]?.reverseLeaderMode === true);
  // 情绪游资-n板打板（n=2/3）走独立引擎（同单策略路径，避免落入常规循环）
  const nBoardIds = ids.filter(id => STRATEGIES[id]?.nBoardMode === true);
  // 情绪游资-成交量占比（N=2/3/5）走独立引擎（同单策略路径，避免落入常规循环）
  const volumeShareIds = ids.filter(id => STRATEGIES[id]?.volumeShareMode === true);
  // N 日涨幅最大-成交量占比（N=2/3/4/5）走独立引擎（同单策略路径，避免落入常规自选股循环）
  const gainVolumeShareIds = ids.filter(id => STRATEGIES[id]?.gainVolumeShareMode === true);
  // 情绪游资-极致胜率走独立引擎（双腿结构：顺周期腿 + 逆周期腿，账户拆两份各半仓；同单策略路径）。
  // 2026-10-19 补上：此前本 multi 路径未分发 extremeWinMode，worker 全量重跑会把它按常规循环回测并覆盖其正确缓存
  const extremeWinIds = ids.filter(id => STRATEGIES[id]?.extremeWinMode === true);
  // 科技进攻-情绪游资极致胜率（快进快出 + 极致胜率双腿融合，风格独占锁）走独立引擎（同单策略路径）
  const fusedIds = ids.filter(id => STRATEGIES[id]?.fusedEmoWinMode === true);
  // 连板题材-情绪瞬爆-惯性漂移-龙头走独立引擎（同单策略路径，避免落入常规循环）
  const emotionBurstDriftIds = ids.filter(id => STRATEGIES[id]?.emotionBurstDriftMode === true);
  // 连板题材-情绪瞬爆-惯性漂移-补涨走独立引擎（同单策略路径）
  const emotionBurstFollowIds = ids.filter(id => STRATEGIES[id]?.emotionBurstFollowMode === true);
  const regularIds = ids.filter(id => STRATEGIES[id]?.keyBlockDays == null && STRATEGIES[id]?.extremeWinMode !== true && STRATEGIES[id]?.fusedEmoWinMode !== true && STRATEGIES[id]?.reverseLeaderMode !== true && STRATEGIES[id]?.nBoardMode !== true && STRATEGIES[id]?.volumeShareMode !== true && STRATEGIES[id]?.gainVolumeShareMode !== true && STRATEGIES[id]?.emotionBurstDriftMode !== true && STRATEGIES[id]?.emotionBurstFollowMode !== true);
  const results = [];
  for (const strategyId of keyBlockIds) {
    const result = await runKeyBlockBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of reverseLeaderIds) {
    const result = await runReverseLeaderBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of nBoardIds) {
    const result = await runNBoardBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of volumeShareIds) {
    const result = await runVolumeShareBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of gainVolumeShareIds) {
    const result = await runGainVolumeShareBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of extremeWinIds) {
    const result = await runExtremeWinBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of fusedIds) {
    const result = await runFusedEmoWinBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of emotionBurstDriftIds) {
    const result = await runEmotionBurstDriftBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  for (const strategyId of emotionBurstFollowIds) {
    const result = await runEmotionBurstFollowBacktest(startDate, endDate, strategyId, onProgress);
    results.push({ strategyId, result });
  }
  if (regularIds.length === 0) return results;

  const allDates = getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return results.concat(regularIds.map(strategyId => ({ strategyId, result: { success: false, message: '所选日期范围内无可回测交易日' } })));
  }

  // 每个策略独立的持仓状态与成交流水
  const states = regularIds.map(strategyId => ({
    strategy: STRATEGIES[strategyId],
    // 持仓列表：普通单股策略最多 1 个；两次买入策略最多 2 个（两份仓位各自独立买卖，均半仓）
    positions: [], // { code, stockName, buyDate, buyDateDisplay, buyTime, buyPrice, buyChange, metric, ... }
    // 情绪快进快出策略：最近一次 10:00 强制卖出的日期（该日禁止二次买入，哪怕买点再次触发）
    quickOutSoldDate: null,
    // 「两次买入（同一天）」变体：当日 14:55 尾盘补买评估标记（每交易日评估一次，盈利未达标/涨停不重试）
    sameDayTailChecked: false,
    singleTrades: [],
    skippedDates: [],
    // 「资金净流入阈值动态调节」状态机（2026-10-21 用户新增；2026-10-21 用户扩展适用范围，与 rangeBacktest 同口径）：
    // ①「N日涨幅最大-快进快出」系列（emoQuickOut 且非两次买入）②「N日涨幅最大」系列（dynamicFundGate: true）
    // 连续 2 笔已完结交易折算收益率（半仓 ×0.5 折算后）均未超 3% → 阈值 20 → 30 亿；任一笔超 3% → 降回 20 亿
    fundGate: ((STRATEGIES[strategyId].emoQuickOut === true && STRATEGIES[strategyId].twoBuy !== true) || STRATEGIES[strategyId].dynamicFundGate === true)
      ? createEmoQuickFundGate() : null,
    fundGateFedCount: 0,
  }));

  // 整组策略共享：每日 EOD 信息与期间出现过的自选股（均由 campData 派生）
  const dailyInfos = new Map();
  const seenStocks = new Map(); // code -> { code, name }
  // 预热起始日前 10 个交易日 EOD，日期轴前移，保证起点附近「最近 N 日」窗口不被起始日截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, 10, dailyInfos);

  // 跨指数双门禁预计算（整组 regular 策略共享一次，每个策略各自在 buyHit 时判定）
  let cybGatePrecomputed = null, starGatePrecomputed = null;
  const cybGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const starGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const anyApplyCybGate = regularIds.some(id => CYB_GATE_STRATEGY_IDS.has(id));
  if (anyApplyCybGate) {
    try {
      [cybGatePrecomputed, starGatePrecomputed] = await Promise.all([
        precomputeTurnMap(CYB_INDEX_CODE, rangeDates),
        precomputeTurnMap(STAR_INDEX_CODE, rangeDates),
      ]);
    } catch (e) { cybGatePrecomputed = null; starGatePrecomputed = null; }
  }

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      // 统一允许缺失资金快照的日期兜底构建（见 runKeyBlockBacktest 内说明），避免整日跳过漏执行卖点
      campData = await loadTrainingCampData(dateStr, { allowMissingFund: true });
    } catch (e) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: e.message || '加载失败' }));
      continue;
    }
    if (!campData || campData.success === false) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: campData?.message || '无回放数据' }));
      continue;
    }

    const timeBuckets = campData.timeBuckets || [];
    if (timeBuckets.length === 0) {
      states.forEach(st => st.skippedDates.push({ date: dateStr, message: '无时间桶数据' }));
      continue;
    }
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    const dateDisplay = campData.dateDisplay || dateStr;
    // 记录当日 EOD 信息（供后续日期选股使用，与策略无关）
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    // 记录回测期间出现过的全部自选股（供前端复制K线等使用）
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 内层策略：同一天数据依次跑本组全部策略的买卖点诊断
    for (const st of states) {
      const { strategy, singleTrades } = st;
      st.sameDayTailChecked = false; // 「两次买入（同一天）」尾盘补买评估标记按日重置
      // 「N日涨幅最大-快进快出」系列（emoQuickOut 且非两次买入）：快进快出半仓（2026-10-13 用户新增）——
      // 买点触发时看该笔买入是否属于「快进快出」情形（emoQuickOut.quickOut：情绪冰点/温和回升日买入、
      // 次日 10:00 强制卖出）：属于则首次仅半仓（第一份），至少次日买点再次触发时补剩余半仓
      // （与两次买入同口径，同一标的）；非快进快出情形（走通用 7 条件卖点）则首次即全仓。已有 twoBuy 系列不变。
      // 「30 亿抬高态强制两次买入」（2026-10-21 用户新增，与 rangeBacktest 单策略路径同口径）：资金净流入动态阈值
      // 处于抬高态（30 亿）时，首次建仓不分快进快出情形一律只买半仓（第一份），剩余半仓等后续交易日买点再次触发时
      // 补买（第二份不能与第一份同日，与「N日涨幅最大-两次买入」同效果），且第二份补买诊断阈值降回基准 20 亿
      const emoQuickHalfBuy = strategy.emoQuickOut === true && strategy.twoBuy !== true;
      // 脉冲最强系列（2026-10-23 用户新增）：每次买点触发都无条件走「板块发酵延时」选股，跳过冰点门禁
      const isPulseBlockPick = strategy.pulseBlockPick === true;

      // 情绪快进快出策略专属卖点：次日 10:00 强卖 + 盘中跌破成本线止损（先到先卖）+ 强卖豁免
      // （见 engine/sellHooks/emoQuickOut.js）。每策略各自记录强卖日期，用于当日禁止二次买入
      if (strategy.emoQuickOut === true) {
        const soldDate = emoQuickOutSell({ positions: st.positions, strategy, dateStr, dateDisplay, replayStocks, timeBuckets, campData, singleTrades });
        if (soldDate) st.quickOutSoldDate = soldDate;
      }
      // 资金净流入阈值动态调节：当日成交即时喂入状态机（后续时间桶买点诊断按新阈值判定）
      if (st.fundGate) {
        while (st.fundGateFedCount < singleTrades.length) {
          st.fundGate.onTradeClosed(singleTrades[st.fundGateFedCount]?.returnRate);
          st.fundGateFedCount += 1;
        }
      }

      // 「板块发酵延时」待执行买入（2026-10-23 用户新增）：连续两日冰点下买点触发后等待 15 分钟，目标桶到达时
      // 按区间涨幅差值选板块并建仓。仅当日有效，每日按策略重置
      st.pendingRaisedBuy = null;
      // 冰点转折·延时后涨幅确认待执行买入（2026-10-30 用户新增）：延时 15 分钟到点锁定个股后不立即买入，
      // 记录该股延时窗口内的最高当日涨幅，之后每 5min 桶监控，涨幅超过窗口最高 +1 个百分点才成交。仅当日有效
      st.pendingIceConfirm = null;
      // 「进攻延迟 n 分钟」待执行买入：买点触发后等 n 分钟，窗口内逐 5min 桶校验
      // 资金净流入增量为正，通过后在目标桶按「全量重点板块中 3 日涨幅最大」选股建仓。仅当日有效，每日重置
      st.pendingAttackBuy = null;
      // 上一交易日（日期轴上一位）：用于「连续两日冰点」前置门禁的昨日 hasIce 判定
      const prevDateStr = di + axisOffset > 0 ? String(dateAxis[di + axisOffset - 1]) : null;
      // 上上个交易日（日期轴上两位）：用于「重点板块-进攻延迟」板块 3 日涨幅（前天收盘涨幅）
      const prev2DateStr = di + axisOffset > 1 ? String(dateAxis[di + axisOffset - 2]) : null;
      // 首次建仓（板块内即时路径 / 延时目标桶路径共用）：execBucket 为实际成交桶（延时路径即 T+15 桶）；
      // iceGateOpen = 连续两日冰点门禁是否成立（成立才启用板块内选股）
      const openFirstPosition = async (execBucket, gatedBuyInfo, gateAllowedMarkets, gateTurnedPosInfo, delayInfo, iceGateOpen, attackInfo, opts = {}) => {
        // 上一交易日一字板过滤（全策略通用）：预取候选池昨日一字板集合传入选股（进程内按 股票_日期 缓存）
        const prevOneWordSet = await buildPrevOneWordBoardSet((execBucket.stockChanges || []).map(s => s.code), dateStr);
        // 顺/逆周期过滤（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略）：预取逆周期候选集合传入选股
        const emoCycSet = isCycleFilterStrategy(strategy)
          ? await buildCounterCycSet((execBucket.stockChanges || []).map(s => s.code), dateStr)
          : null;
        // 「进攻延迟」路径：窗口已由调用方确定，选股在「全量重点板块中 3 日涨幅最大、且与全量自选股有交集」
        // 的板块成分股池中按 3 日涨幅降序逐个尝试选 3 日涨幅最大者；均选不出时不回退全量自选股（本次不买）
        // 「连续两日冰点」板块内选股：门禁成立（昨日 hasIce + 当日分时曾触冰）时首次建仓改为板块内选股，
        // 排序依据 = 区间（T+15 往前回溯 20 分钟）涨幅差值；交集内选不出则顺延下一板块，全部失败回退全量自选股
        const attackMode = !!attackInfo;
        const raisedBlocks = attackMode
          ? []
          : (iceGateOpen
            ? resolveQuickRaisedBlocks(execBucket, dateStr, resolveRaisedBlockLookbackBucket(timeBuckets, execBucket.minute))
            : []);
        // 资金净流入阈值抬高态（30 亿）仍驱动「强制两次买入·首次仅半仓」
        const gateRaised = st.fundGate != null && st.fundGate.isRaised();
        let picked = opts.lockedPick || null;
        let raisedBlock = null;
        let attackBlock = null;
        if (picked) {
          // 冰点转折·涨幅确认通过：沿用延时到点已锁定的标的，不在确认桶重新选股（仅按本桶价成交）
        } else if (attackMode) {
          // 按全量重点板块 3 日涨幅降序逐个尝试：某板块交集内选不出可买标的（涨停/抗分歧/过热等被过滤）→ 顺延下一板块
          for (const blk of attackInfo.blocks) {
            picked = pickBestStock(new Map(), dateAxis, di + axisOffset, execBucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet, blk.codes);
            if (picked) { attackBlock = blk; break; }
          }
          if (!picked) return; // 全量重点板块均选不出 → 本次不买（不回退全量自选股）
        } else {
          for (const rb of raisedBlocks) {
            picked = pickBestStock(new Map(), dateAxis, di + axisOffset, execBucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet, rb.codes);
            if (picked) { raisedBlock = rb; break; }
          }
          if (!picked) {
            // 全部板块交集内均选不出（或本就没有交集非空的板块）→ 回退原逻辑：全量自选股选 N 日涨幅最大
            picked = pickBestStock(new Map(), dateAxis, di + axisOffset, execBucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet, null);
            if (picked && raisedBlocks.length > 0) picked.raisedBlockFallbackInfo = { triedCount: raisedBlocks.length, pulse: isPulseBlockPick };
          }
        }
        if (!picked) return;
        if (raisedBlock && !attackMode) picked.raisedBlockInfo = { ...raisedBlock, pulse: isPulseBlockPick }; // 买入明细 raised_block_pick
        if (delayInfo) picked.raisedBlockDelayInfo = { ...delayInfo, pulse: isPulseBlockPick }; // 买入明细 raised_block_delay
        if (attackMode) {
          // 买入明细 attack_delay_window（延时窗口逐桶校验）+ attack_block_pick（3 日涨幅最大板块内选股）
          picked.attackDelayInfo = {
            delayMin: attackInfo.delayMin,
            triggerTime: attackInfo.triggerTime,
            execTime: attackInfo.execTime,
            window: attackInfo.window,
          };
          picked.attackBlockInfo = { ...(attackBlock || {}) };
        }
        // 快进快出标注（须在 withResilienceGateInfo 之前挂载，买入明细方可写入 emo_quick_out 判定项）
        if (strategy.emoQuickOut === true && (strategy.twoBuy === true || strategy.emoBreak != null || strategy.emoGate != null || strategy.pulseBlockPick === true)) {
          picked.emoQuickOut = computeEmoQuickOutInfo(di + axisOffset, dateAxis);
        }
        // 冰点转折·延时后涨幅确认（2026-10-30 用户新增）：延时 15 分钟到点选好个股后不立即买入，
        // 取该股「T → T+15」窗口内最高当日涨幅，之后每 5min 桶监控，涨幅超过窗口最高 +1 个百分点才成交；
        // 未达到确认条件时把已选标的存入 pendingIceConfirm，等后续桶确认（始终未确认 → 当日不买）
        if (opts.iceConfirmInfo) picked.iceConfirmInfo = opts.iceConfirmInfo;
        if (opts.iceConfirm === true) {
          const curGain = picked.stock.changePct != null ? Number(picked.stock.changePct) : null;
          const winMax = opts.iceGainWindowMax instanceof Map ? opts.iceGainWindowMax.get(picked.stock.code) : null;
          const maxGain = winMax != null ? Number(winMax) : curGain;
          if (!isIceGainConfirmed(curGain, maxGain)) {
            st.pendingIceConfirm = {
              picked,
              gatedBuyInfo,
              gateAllowedMarkets,
              gateTurnedPosInfo,
              delayInfo: delayInfo || null,
              iceGateOpen,
              targetMinute: Number(execBucket.minute),
              windowMaxGain: maxGain,
            };
            return;
          }
          picked.iceConfirmInfo = {
            triggerTime: delayInfo?.triggerTime,
            execTime: delayInfo?.execTime,
            windowMaxGain: maxGain,
            confirmTime: fmtTime(execBucket.timeKey).substring(0, 5),
            confirmGain: curGain,
          };
        }
        const finalBuyInfo = withResilienceGateInfo(gatedBuyInfo, picked);
        const sc = picked.stock;
        const firstBuyPrice = parseFloat(Number(sc.lastPx).toFixed(2));
        const buyTime = fmtTime(execBucket.timeKey).substring(0, 5); // 延时路径为实际成交桶时点
        const halfByQuickOut = emoQuickHalfBuy && (picked.emoQuickOut?.quickOut === true || gateRaised);
        const forcedRaisedHalf = emoQuickHalfBuy && gateRaised && picked.emoQuickOut?.quickOut !== true;
        st.positions.push({
          code: sc.code,
          stockName: sc.name || sc.code,
          buyDate: dateStr,
          buyDateDisplay: dateDisplay,
          buyTime,
          buyPrice: firstBuyPrice,
          buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
          metric: picked.metric,
          buyReason: forcedRaisedHalf
            ? `${finalBuyInfo.buyReason}；资金净流入阈值处于抬高态 30 亿，强制两次买入——本次仅买第一份 5 成，剩余半仓等后续交易日买点再次触发时补买（补买阈值降为 20 亿）`
            : finalBuyInfo.buyReason,
          buyChecks: annotateIndexGateChecksWithStock(finalBuyInfo.buyChecks, sc.code, sc.name),
          raisedBlockDelay: delayInfo || null, // 板块发酵延时（触发时点 → 实际成交时点）
          emoQuickOut: picked.emoQuickOut || null,
          ...(strategy.twoBuy === true || halfByQuickOut ? { twoBuy: true, leg: 1, weight: TWO_BUY_LEG_WEIGHT } : {}),
        });
      };

      for (let bi = 0; bi < timeBuckets.length; bi++) {
        const bucket = timeBuckets[bi];

        // 抬高态延时建仓：到达目标桶 → 本桶执行建仓；超过目标 10 分钟仍无桶 → 放弃本次买入
        let delayedExec = null;
        if (st.pendingRaisedBuy) {
          if (isRaisedBlockDelayBucket(bucket.minute, st.pendingRaisedBuy.targetMinute)) {
            delayedExec = st.pendingRaisedBuy;
            st.pendingRaisedBuy = null;
          } else if (isRaisedBlockDelayExpired(bucket.minute, st.pendingRaisedBuy.targetMinute)) {
            st.pendingRaisedBuy = null;
          }
        }
        // 冰点转折·涨幅确认监控（2026-10-30 用户新增）：延时到点已锁定个股但尚未确认时，每个 5min 桶检查该股涨幅，
        // 超过窗口最高涨幅 +1 个百分点即本桶成交；本桶不做新买点评估，始终未确认 → 当日不买
        let iceConfirmHit = null;
        if (st.pendingIceConfirm && st.positions.length === 0 && Number(bucket.minute) > st.pendingIceConfirm.targetMinute) {
          const confirmSc = (bucket.stockChanges || []).find(s => s.code === st.pendingIceConfirm.picked.stock.code);
          const curGain = confirmSc && confirmSc.changePct != null ? Number(confirmSc.changePct) : null;
          if (isIceGainConfirmed(curGain, st.pendingIceConfirm.windowMaxGain)) {
            iceConfirmHit = {
              ...st.pendingIceConfirm,
              confirmSc,
              confirmGain: curGain,
              confirmTime: fmtTime(bucket.timeKey).substring(0, 5),
            };
          }
        }
        // 「进攻延迟 n 分钟」建仓：到达目标桶 → 本桶校验延时窗口并建仓；超过目标 10 分钟仍无桶 → 放弃本次买入
        let attackExec = null;
        if (st.pendingAttackBuy) {
          if (isRaisedBlockDelayBucket(bucket.minute, st.pendingAttackBuy.targetMinute)) {
            attackExec = st.pendingAttackBuy;
            st.pendingAttackBuy = null;
          } else if (isRaisedBlockDelayExpired(bucket.minute, st.pendingAttackBuy.targetMinute)) {
            st.pendingAttackBuy = null;
          }
        }

        // 买入信号：情绪快进快出策略当日已发生 10:00 强制卖出 → 当日禁止二次买入（哪怕买点再次触发）；其余沿用买点诊断 allPassed
        const quickOutNoRebuy = strategy.emoQuickOut === true && st.quickOutSoldDate === dateStr;
        // 「10n 科技情绪-快进快出」系列（emoBreak 阈值 = 10×n）：买点时机不走买点诊断，改为盘中分时科技情绪
        // 突破 10×n——当前桶分时科技情绪 ≥ 阈值即处于突破买点窗口（情绪线每日 9:30 竞价起算、跨日不累计，
        // 首个满足的桶即为突破时点）；该桶选股失败时情绪仍 ≥ 阈值的后续桶持续重试。其余机制与快进快出系列一致
        let buyInfo = null;
        // 抬高态延时等待中或本桶即延时成交桶 → 不重复评估新买点
        if (!st.pendingRaisedBuy && !delayedExec && !st.pendingAttackBuy && !attackExec && !st.pendingIceConfirm) {
        if (strategy.emoBreak != null) {
          const breakThreshold = Number(strategy.emoBreak);
          const emoNow = getBucketTechEmotion(bucket);
          if (!quickOutNoRebuy && emoNow != null && emoNow >= breakThreshold) {
            buyInfo = {
              buyReason: `分时科技情绪突破 ${breakThreshold}（当前 ${emoNow.toFixed(2)}）`,
              buyChecks: [{
                id: 'emo_break_buy',
                title: `分时科技情绪突破 ${breakThreshold}（10×${breakThreshold / 10}）`,
                passed: true,
                value: emoNow.toFixed(2),
                reason: `当前分时科技情绪 ${emoNow.toFixed(2)} 已突破 ${breakThreshold}（本策略不走通用买点诊断，买点时机 = 分时科技情绪突破 10×${breakThreshold / 10}），触发买入`,
              }],
            };
          }
        } else {
          // 24 个涨幅最大/快进快出策略启用检查4 比例收紧：阈值 = ceil(科技股数 × 25%)，其余策略固定 30 只
          // 资金净流入阈值动态调节：策略启用状态机时按当前动态阈值判定（见 states 初始化处 fundGate 说明）；
          // 已持第一份半仓待补买第二份时，检查2 固定按基准 20 亿判定（2026-10-21 用户新增：第二份补买阈值降回 20 亿）
          const waitingSecondLeg = emoQuickHalfBuy && st.positions.length === 1 && st.positions[0].leg === 1;
          const buyDiag = runBuyPointDiagnosis(timeBuckets, bi, campData, { ratioGatedOpeningBelow: OPENING_BELOW_RATIO_STRATEGY_IDS.has(strategy.id), ...(st.fundGate ? { fundInflowThreshold: waitingSecondLeg ? EMO_QUICK_FUND_INFLOW_BASE : st.fundGate.getThreshold() } : {}) })?.data;
          if (!quickOutNoRebuy && buyDiag?.allPassed === true) {
            // 「快进快出-科技情绪门禁」系列（emoGate，2026-10-20 用户新增）：通用买点诊断全部通过后，
            // 还要求当前桶分时科技情绪 ≥ 阈值才可买入；不满足（或数据缺失）该桶不买，后续桶买点诊断
            // 再次全部通过时重新判断该门禁。通过时门禁作为一条附加检查项写入买入明细
            const gateThreshold = strategy.emoGate != null ? Number(strategy.emoGate) : null;
            const emoNow = gateThreshold != null ? getBucketTechEmotion(bucket) : null;
            if (gateThreshold == null || (emoNow != null && emoNow >= gateThreshold)) {
              // 买入原因：取买点诊断全部通过项汇总
              buyInfo = buildBuyReasonFromDiag(buyDiag);
              if (gateThreshold != null) {
                buyInfo.buyReason = `${buyInfo.buyReason}；分时科技情绪 ${emoNow.toFixed(2)} ≥ ${gateThreshold}`;
                buyInfo.buyChecks = [
                  ...(buyInfo.buyChecks || []),
                  {
                    id: 'emo_gate_buy',
                    title: `分时科技情绪 ≥ ${gateThreshold}`,
                    passed: true,
                    value: emoNow.toFixed(2),
                    reason: `当前分时科技情绪 ${emoNow.toFixed(2)} 已达到 ${gateThreshold}（在通用买点诊断全部通过的基础上叠加该门禁），允许买入`,
                  },
                ];
              }
            }
          }
        }
        }
        const buyHit = buyInfo != null;
        if (buyHit) {
          // N 日涨幅最大系列策略：跨指数双门禁 + 选股市场过滤
          const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(buyInfo, strategy.id, dateStr, bucket.minute,
            { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState });
          if (!gatePassed) {
            continue;
          }
          const buyTime = fmtTime(bucket.timeKey).substring(0, 5); // 归一化 HH:MM

          if (st.positions.length === 0) {
            // 未持仓时按指标选最优的一只买入（普通策略同一时刻仅持有一只；两次买入策略建第一份）
            // 「板块发酵延时」（2026-10-23 用户改）：连续两日冰点下买点触发后不立刻买入，等待 15 分钟到目标桶后
            // 按区间涨幅差值重新选板块与个股（给板块发酵时间）；目标落在非买入时段 → 本次不买
            // 「进攻延迟 n 分钟」：买点触发后等待 n 分钟，先校验窗口内每 5min 桶资金净流入增量为正，
            // 通过才按「全量重点板块中 3 日涨幅最大」选股建仓；目标落在非买入时段 → 本次不买
            const attackDelayMin = strategy.keyBlockAttackDelay != null ? Number(strategy.keyBlockAttackDelay) : null;
            const iceGateOpen = emoQuickHalfBuy && (isPulseBlockPick || isTechIceGateOpen(prevDateStr, timeBuckets, bi));
            if (attackDelayMin != null) {
              const targetMinute = resolveAttackDelayTarget(bucket.minute, attackDelayMin);
              if (targetMinute != null) {
                st.pendingAttackBuy = {
                  delayMin: attackDelayMin,
                  triggerIndex: bi,
                  targetMinute,
                  triggerTime: buyTime,
                  gatedBuyInfo,
                  gateAllowedMarkets,
                  gateTurnedPosInfo,
                };
              }
            } else if (iceGateOpen) {
              const targetMinute = resolveRaisedBlockDelayTarget(bucket.minute);
              if (targetMinute != null) {
                st.pendingRaisedBuy = {
                  targetMinute,
                  triggerTime: buyTime,
                  gatedBuyInfo,
                  gateAllowedMarkets,
                  gateTurnedPosInfo,
                };
              }
            } else {
              await openFirstPosition(bucket, gatedBuyInfo, gateAllowedMarkets, gateTurnedPosInfo, null, false);
            }
          } else if ((strategy.twoBuy === true || emoQuickHalfBuy) && st.positions.length === 1 && st.positions[0].leg === 1
            && dateStr > st.positions[0].buyDate) {
            // 两次买入 / 快进快出半仓策略：已持有第一份（半仓），买点再次触发 → 买入第二份 5 成
            // 约束：① 须在第一份建仓日之后的交易日买入（含「两次买入（同一天）」变体——当日不再因买点二次触发补买，
            //          改由下方 14:55 尾盘补买规则处理）；② 补买同样过滤涨停（买入时点该股已涨停不可成交）；
            //       ③ 普通两次买入系列第二份必须与第一份同一只股票（不重新择股）；
            //          「不同板块」变体（diffBlock）第二份则在「板块与第一份不同」的候选中重新按 N 日涨幅最大择股
            const first = st.positions[0];
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
                st.positions.push({
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
            } else if (strategy.twoBuyDiffStock === true) {
              // 两次买入（不同股）：第二份在买点再次触发时重新按 N 日涨幅最大择股（不限板块）——
              // 若仍选中第一份同一只股票 → 合并持有（两份共用摊平成本线，见 engine/twoBuy.js）；
              // 若已变为另一只股票 → 买入该股票（两份不同股票、各自独立买卖与独立成本线）
              const secondPrevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
              const secondEmoCycSet = isCycleFilterStrategy(strategy)
                ? await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr)
                : null;
              const secondPicked = pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, strategy.id, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, secondPrevOneWordSet, secondEmoCycSet, null);
              if (secondPicked) {
                const secondBuyInfo = withResilienceGateInfo(gatedBuyInfo, secondPicked);
                const sc2 = secondPicked.stock;
                const secondPx = parseFloat(Number(sc2.lastPx).toFixed(2));
                const sameStock = sc2.code === first.code;
                if (sameStock) first.mergedCostLine = true;
                st.positions.push({
                  code: sc2.code,
                  stockName: sc2.name || sc2.code,
                  buyDate: dateStr,
                  buyDateDisplay: dateDisplay,
                  buyTime,
                  buyPrice: secondPx,
                  buyChange: sc2.changePct != null ? parseFloat(Number(sc2.changePct).toFixed(2)) : null,
                  metric: secondPicked.metric,
                  buyReason: `${secondBuyInfo.buyReason}；买点第二次触发，买入第二份 5 成（${sameStock
                    ? `N 日涨幅最大仍是同一股票 ${first.stockName}，合并持有（成本线摊平为两次买入价均值，卖出止损按该均价判定；回测仍记两条交易）`
                    : `N 日涨幅最大已变为 ${sc2.name || sc2.code}，本份买入该股票（与第一份 ${first.stockName} 各自独立买卖）`}，${buyTime} 价 ${secondPx.toFixed(2)}）`,
                  buyChecks: annotateIndexGateChecksWithStock(secondBuyInfo.buyChecks, sc2.code, sc2.name),
                  emoQuickOut: strategy.emoQuickOut === true ? computeEmoQuickOutInfo(di + axisOffset, dateAxis) : null,
                  ...(sameStock ? { mergedCostLine: true } : {}),
                  twoBuy: true, leg: 2, weight: TWO_BUY_LEG_WEIGHT,
                });
              }
            } else {
              const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
              const secondPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
              const heldLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
              if (secondPx != null && secondPx > 0 && !heldLimitUp) {
                st.positions.push({
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

        // 「两次买入（同一天）」尾盘补买第二份（2026-10-20 用户改版）：当日不再因买点二次触发补买，
        // 改为 14:55（当日首个 minute ≥ 1455 的桶）评估一次——当日盈利（14:55 分时价 vs 第一份买入价）
        // 超过 2% 且该股未涨停 → 按 14:55 分时价尾盘买入第二份 5 成（同一只股票）；
        // 已涨停或盈利未达标 → 当日不补，等后续交易日买点再次触发时再买（见上方建仓分支）
        if (strategy.twoBuySameDay === true && !st.sameDayTailChecked
          && st.positions.length === 1 && st.positions[0].leg === 1 && dateStr === st.positions[0].buyDate
          && Number(bucket.minute) >= 1455) {
          st.sameDayTailChecked = true;
          const first = st.positions[0];
          const heldSc = (bucket.stockChanges || []).find(s => s.code === first.code);
          const tailPx = heldSc && heldSc.lastPx != null ? parseFloat(Number(heldSc.lastPx).toFixed(2)) : null;
          const tailLimitUp = heldSc ? isLimitUpAtBuy(first.code, heldSc.changePct) : false;
          const tailProfitPct = tailPx != null && first.buyPrice > 0
            ? parseFloat((((tailPx - first.buyPrice) / first.buyPrice) * 100).toFixed(2))
            : null;
          if (tailPx != null && tailPx > 0 && !tailLimitUp && tailProfitPct != null && tailProfitPct > TWO_BUY_SAME_DAY_TAIL_PROFIT_PCT) {
            st.positions.push({
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

        // 延时建仓执行：目标桶（买点触发后 15 分钟）到达时，按区间涨幅差值重新选板块与个股，按本桶价成交；
        // 连续两日冰点（非脉冲最强）路径下还要先做「延时后涨幅确认」：到点只锁定标的、不成交，
        // 待后续 5min 桶涨幅超过窗口最高 +1 个百分点才由 pendingIceConfirm 确认成交
        if (delayedExec && st.positions.length === 0 && !quickOutNoRebuy) {
          const iceNow = emoQuickHalfBuy && isTechIceGateOpen(prevDateStr, timeBuckets, bi);
          const iceGateOpen = emoQuickHalfBuy && (isPulseBlockPick || iceNow);
          const needIceConfirm = emoQuickHalfBuy && !isPulseBlockPick && iceNow;
          await openFirstPosition(bucket, delayedExec.gatedBuyInfo, delayedExec.gateAllowedMarkets, delayedExec.gateTurnedPosInfo, {
            triggerTime: delayedExec.triggerTime,
            execTime: fmtTime(bucket.timeKey).substring(0, 5),
          }, iceGateOpen, null, needIceConfirm
            ? { iceConfirm: true, iceGainWindowMax: buildIceGainWindowMax(timeBuckets, delayedExec.targetMinute) }
            : undefined);
        }

        // 冰点转折·涨幅确认通过：沿用延时到点锁定的标的，按本桶（确认桶）价成交
        if (iceConfirmHit && st.positions.length === 0 && !quickOutNoRebuy) {
          const saved = iceConfirmHit;
          st.pendingIceConfirm = null;
          const lockedPick = {
            ...saved.picked,
            stock: {
              ...saved.picked.stock,
              lastPx: saved.confirmSc.lastPx,
              changePct: saved.confirmSc.changePct != null ? saved.confirmSc.changePct : saved.picked.stock.changePct,
              name: saved.confirmSc.name || saved.picked.stock.name,
            },
          };
          await openFirstPosition(bucket, saved.gatedBuyInfo, saved.gateAllowedMarkets, saved.gateTurnedPosInfo, saved.delayInfo, saved.iceGateOpen, null, {
            lockedPick,
            iceConfirmInfo: {
              ...(saved.picked.iceConfirmInfo || {}),
              triggerTime: saved.delayInfo?.triggerTime,
              execTime: saved.delayInfo?.execTime,
              windowMaxGain: saved.windowMaxGain,
              confirmTime: saved.confirmTime,
              confirmGain: saved.confirmGain,
            },
          });
        }

        // 「进攻延迟 n 分钟」建仓执行：目标桶到达时先逐 5min 桶校验延时窗口（资金净流入增量为正），
        // 未通过则本次买点作废、不买入；通过则在全量重点板块中取 3 日涨幅最大（前天+昨天+实时，复利）且与
        // 全量自选股有交集的板块，在板块成分股池内选 3 日涨幅最大者
        if (attackExec && st.positions.length === 0 && !quickOutNoRebuy) {
          const window = buildAttackDelayWindowCheck(timeBuckets, attackExec.triggerIndex, bi);
          if (window.passed) {
            const blocks = await resolveAttackBlocks(bucket, dateStr, prevDateStr, prev2DateStr);
            await openFirstPosition(bucket, attackExec.gatedBuyInfo, attackExec.gateAllowedMarkets, attackExec.gateTurnedPosInfo, null, false, {
              delayMin: attackExec.delayMin,
              triggerTime: attackExec.triggerTime,
              execTime: fmtTime(bucket.timeKey).substring(0, 5),
              window,
              blocks,
            });
          }
        }

        // 卖出信号（同日买入不可同日卖出；通用 7 条件卖点，见 engine/sellHooks/generalSell.js）
        await generalSellPositions({ positions: st.positions, strategy, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades });
        // 资金净流入阈值动态调节：通用卖点成交即时喂入状态机（后续时间桶买入评估按新阈值判定）
        if (st.fundGate) {
          while (st.fundGateFedCount < singleTrades.length) {
            st.fundGate.onTradeClosed(singleTrades[st.fundGateFedCount]?.returnRate);
            st.fundGateFedCount += 1;
          }
        }
      }
    }
  }

  // 逐策略组装结果（与 runRangeBacktest 单策略版完全一致）
  // 注意：必须 concat 前面独立回测（重点板块系列）已推入 results 的结果，
  // 否则混合组跑常规阶段时这些策略的结果会被静默丢弃（子进程不写缓存、也不报错，
  // 汇总阶段仅读缓存时即显示为「回测失败」——重点板块因总在独立阶段跑（regularIds 为空
  // 走上方提前 return results）从未触发此问题）
  return results.concat(states.map(st => {
    const { strategy, singleTrades, skippedDates } = st;
    // 「N日涨幅最大-快进快出」系列（emoQuickOut 且非两次买入）：快进快出半仓（见上方循环内说明）
    const emoQuickHalfBuy = strategy.emoQuickOut === true && strategy.twoBuy !== true;
    // 期末持仓：逐份按最近一个有效日期的收盘价估算浮盈，计入整体收益（两次买入策略可能同时持有两份）
    const currentHoldings = [];
    for (const pos of st.positions) {
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
    return {
      strategyId: strategy.id,
      result: {
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
      },
    };
  }));
};

module.exports = {
  runRangeBacktestMulti,
};
