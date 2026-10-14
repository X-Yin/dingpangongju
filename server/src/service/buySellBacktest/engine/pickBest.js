const { BUY_TIME_MAX_MINUTE, GLOBAL_RESILIENCE_MIN, RESILIENCE_GATE_INTRADAY_SORT_IDS, RESILIENCE_GATE_MIN, RESILIENCE_GATE_STRATEGY_IDS, STRATEGIES } = require('../strategies/registry');
const { computeMaSlopeAngle, isNonTechWatchlistStock, passWatchlistGate } = require('./pickHelpers');
const { EXCLUDED_CODES } = require('../constants');
const { isBuyBlockedByValuation } = require('../../watchlistValuation');
const { resolveDelegatePick } = require('./selectors/delegates');
const { loadReportIndex, sumReportCount } = require('../utils/reportIndex');
const { isOscExcluded } = require('../deps');
const { countStockPositiveSlopeDays, emo3IndexGateCache, trackedIndexCodeOf } = require('./emo3Gate');
const { calcResilienceAtMinute, computeHistoricalWindowGain, computeWindowGain, computeWindowGainWithHalf, computeWindowResilience, isLimitUpAtBuy } = require('./replayData');
const { cycCorrCache } = require('./cycleFilter');

const pickBestStock = (stocks, rangeDates, di, bucket, replayStocks, dailyInfos, strategyId, axisOffset = 0, allowedMarkets = null, turnedPosInfo = null, prevOneWordSet = null, emoCycSet = null, restrictCodes = null) => {
  // 买入时段门禁（所有策略通用）：仅允许 9:30 – 11:30 和 13:00 – 13:30 之间的买点触发买入
  const mNum = Number(bucket.minute);
  if (Number.isFinite(mNum) && mNum > BUY_TIME_MAX_MINUTE) return null;

  const isReportStrategy = strategyId.includes('reports');
  const isTop5ReportGainMode = strategyId.includes('reports_top5_gain'); // 研报覆盖前五（含覆盖数相同）中取窗口涨幅最大
  const isPureReportMode = isReportStrategy && !isTop5ReportGainMode; // 研报覆盖数最多/第二多
  const isMaSlopeMode = strategyId.includes('ma_slope'); // 均线斜率最陡峭（3日/5日）
  // 尾盘抄底反向选股：跌幅最大/抗分歧分数最低（取窗口指标最小值而非最大值）
  const lowMode = strategyId.includes('_fall') || strategyId.includes('_resilience_low');
  const dayMatch = strategyId.match(/(\d+)d/);
  const days = dayMatch ? Number(dayMatch[1]) : null;
  // 三日情绪冰点 1d 系列决胜规则：主指标（当日涨幅/跌幅/抗分歧分数）相同时，
  // 按最近 2 个交易日窗口的同向指标决胜（如当日涨幅相同取最近 2 日累计涨幅更大的一只）
  const isEmo3Tiebreak = /^tail_dip_emo3_1d_(gain|fall|resilience)$/.test(strategyId);
  const tiebreakWinDates = isEmo3Tiebreak ? rangeDates.slice(Math.max(0, di - 1), di + 1) : null;
  // 三日情绪冰点系列：候选股按各自跟踪指数的当日环境门禁过滤（满足其一才可买，结果由 ensureEmo3DayGates 按日预计算）
  const isEmo3GateStrategy = /^tail_dip_emo3_/.test(strategyId);
  // 当日抗分歧分数最大：实时抗分歧分数选股，分数相同按触发时点当日实时涨幅决胜
  const isResilienceMaxToday = strategyId === 'highest_1d_resilience';
  // 前N日「跌幅最大/波动最小」前五&当日指标最大（prev{N}d_fall_top5_day_* / prev{N}d_fall_low5_day_*）：两阶段选股——
  // 第一阶段按前 N 个交易日（不含今日）累计涨幅取前五（top5=跌幅最大；low5=波动最小版，无论涨跌按
  // 累计涨幅绝对值取最小的五只），第二阶段组内选当日实时指标最大
  const prevFallMatch = strategyId.match(/^prev(\d)d_fall_(top|low)5_day_(gain|resilience)$/);
  const isPrevFall5Mode = prevFallMatch != null;
  const prevFallLowMode = isPrevFall5Mode && prevFallMatch[2] === 'low';
  const prevFallWinDays = isPrevFall5Mode ? Number(prevFallMatch[1]) : 0;
  const prevFallStage2Resilience = isPrevFall5Mode && prevFallMatch[3] === 'resilience';

  // 策略选股委派（弱转强 / 情绪开关 / 情绪快进快出 / 研报双门 / 科技板块前三）：见 selectors/delegates.js。
  // 命中委派时直接返回其结果（可能为 null），未命中（undefined）交回下方主流水线。
  const delegated = resolveDelegatePick({
    pickBestStock, stocks, rangeDates, di, bucket, replayStocks, dailyInfos,
    strategyId, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet,
  });
  if (delegated !== undefined) return delegated;

  // 涨幅/抗分歧窗口按 days 天
  let winDates;
  if (strategyId === 'highest_gain') {
    // 买入最高涨幅：窗口固定为「回测起始日至当日」——从 axisOffset（日期轴上预热日的数量）起切，
    // 避免预热日改变该策略的全期窗口语义；其余策略的最近 N 日窗口可自然覆盖预热日
    winDates = rangeDates.slice(axisOffset, di + 1);
  } else if (days) {
    winDates = rangeDates.slice(Math.max(0, di - days + 1), di + 1);
  } else {
    winDates = rangeDates.slice(Math.max(0, di - 2), di + 1); // 最近 3 个交易日
  }
  // 研报覆盖窗口与涨幅/抗分歧窗口一致（按对应 3 天/5 天统计）
  let reportWinDates = null;
  if (isReportStrategy && days) {
    reportWinDates = winDates;
  }
  // 跌幅最大（_fall）与涨幅共用窗口涨幅指标，仅取最小值；其余照旧
  const gainMode = strategyId === 'highest_gain' || strategyId.includes('_gain') || strategyId.includes('_fall');
  // 「N.5 日涨幅最大」系列（highest_{N}d5_gain 及其 _emoquick/_two_buy/tech_block_top3 变体）：
  // 在 N 日窗口之外，额外复利计入「更前一个交易日（窗口最早交易日的再前一交易日）下午 13:00→收盘」的半日涨幅；
  // halfDayDate = 日期轴上 di - days 那一天（越界为 null，退化为常规 N 日窗口）
  const halfDayAfternoon = STRATEGIES[strategyId]?.halfDayAfternoon === true;
  const halfDayDate = halfDayAfternoon && days && di - days >= 0 ? rangeDates[di - days] : null;
  // 抗分歧门槛策略（当前仅买入最高涨幅）：选股排序依据 = 买点触发时点当日盘中涨幅（用户定义，
  // 非窗口累计涨幅），从高到低排序后从最高者起依次用触发时点抗分歧分数≥11 过滤；
  // 若未来加入按 N 日窗口涨幅排序的门槛策略，会走下方窗口涨幅计算分支，仅追加抗分歧顺延校验
  const gateEnabled = RESILIENCE_GATE_STRATEGY_IDS.has(strategyId);
  const gateIntradaySort = RESILIENCE_GATE_INTRADAY_SORT_IDS.has(strategyId);

  // 收集全部候选（与原 best/second 口径一致：按指标值排序，同值保持自选股原顺序）
  const candidates = [];
  const top5Candidates = isTop5ReportGainMode ? [] : null;
  const reportIndex = isReportStrategy ? loadReportIndex() : null;
  // 研报创建时间门禁：买点时间戳（回测分时为北京时区，menu.json 的 createdAt 为 UTC，统一为绝对时间戳比较）。
  // 买点之后才创建的研报（如收盘后补录）不计入该买点时点的覆盖统计
  let reportBuyTs = null;
  if (isReportStrategy) {
    const dStr = String(rangeDates[di]);
    const mNum = Number(bucket.minute);
    if (/^\d{8}$/.test(dStr) && Number.isFinite(mNum)) {
      const hh = String(Math.floor(mNum / 100)).padStart(2, '0');
      const mi = String(mNum % 100).padStart(2, '0');
      const ts = Date.parse(`${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}T${hh}:${mi}:00+08:00`);
      if (Number.isFinite(ts)) reportBuyTs = ts;
    }
  }
  for (const sc of bucket.stockChanges) {
    if (EXCLUDED_CODES.has(sc.code)) continue;
    if (isNonTechWatchlistStock(sc.code)) continue; // 非科技股不参与选股（候选池=全量自选股）
    if (isBuyBlockedByValuation(sc.code)) continue; // 估值限制：流通市值 < 200 亿 或 市盈率亏损 不买（2026-10-14 由总市值改为流通市值口径）
    if (isOscExcluded(sc.code)) continue; // 震荡测试：勾选隐藏的股票不参与选股
    // 候选池限制（科技板块前三系列）：只保留「进攻 tag 板块当日涨幅前三 ∩ 全量自选科技股」交集内的股票
    if (restrictCodes && !restrictCodes.has(sc.code)) continue;
    if (sc.lastPx == null || sc.lastPx <= 0) continue;
    if (stocks.has(sc.code) && stocks.get(sc.code).holding) continue;
    // 跨指数双门禁的市场过滤（allowedMarkets=null 表示不做过滤，默认留空或非适用策略）
    if (allowedMarkets && allowedMarkets.size > 0) {
      const code = String(sc.code).replace(/^SH|^SZ|^BJ/i, '');
      if (/^68/.test(code)) {
        if (!allowedMarkets.has('star')) continue; // 科创板 → 需要 star gate
      } else {
        if (!allowedMarkets.has('mainboard') && !allowedMarkets.has('gem')) continue; // 主板/创业板 → 需要 cyb gate
      }
    }
    // 自选股添加时间门禁：买点时刻尚未加入自选股的股票不参与选股（防止后加自选股污染历史回测）
    if (!passWatchlistGate(sc.code, rangeDates[di], bucket.minute)) continue;
    if (isEmo3GateStrategy) {
      // 三日情绪冰点：跟踪指数环境门禁（当日满足其一才可买；未预计算/数据不足按不满足处理）
      const gate = emo3IndexGateCache.get(`${rangeDates[di]}_${trackedIndexCodeOf(sc.code)}`);
      if (!gate || gate.passed !== true) continue;
    }
    if (gateIntradaySort) {
      // 门槛策略（最高涨幅/2日涨幅最大）：按触发时点当日盘中涨幅排序（如买点触发在 13:10，即看 13:10 时谁的涨幅最大）
      const chg = sc.changePct != null ? Number(sc.changePct) : null;
      if (chg == null || !Number.isFinite(chg)) continue;
      candidates.push({ sc, val: chg, metric: parseFloat(chg.toFixed(4)) });
      continue;
    }
    // 当日抗分歧分数最大：取触发时点截至当时的日内实时抗分歧分数（非收盘口径），同分按实时涨幅决胜
    if (isResilienceMaxToday) {
      const r = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      if (r == null || !Number.isFinite(r)) continue;
      const chg = sc.changePct != null && Number.isFinite(Number(sc.changePct)) ? Number(sc.changePct) : null;
      candidates.push({
        sc,
        val: r,
        // 分数相同时按触发时点当日实时涨幅决胜（涨幅缺失排同分组末尾）
        val2: chg != null ? chg : -Infinity,
        metric: parseFloat(r.toFixed(2)),
      });
      continue;
    }
    // 前N日跌幅前五&当日指标最大：收集第一阶段指标（前 N 个交易日不含今日的累计涨幅，纯历史收盘口径）
    // 与第二阶段指标（触发时点当日实时涨幅 / 日内实时抗分歧分数）；循环结束后统一做「前五 → 组内排序」
    if (isPrevFall5Mode) {
      const winPrev = rangeDates.slice(Math.max(0, di - prevFallWinDays), di); // 不含今日
      if (winPrev.length === 0) continue; // 无任何历史交易日（回测最早日），无法构成跌幅窗口
      const prevGain = computeHistoricalWindowGain(sc.code, winPrev, dailyInfos);
      if (prevGain == null || !Number.isFinite(prevGain)) continue;
      let stage2 = null;
      if (prevFallStage2Resilience) {
        stage2 = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      } else {
        stage2 = sc.changePct != null && Number.isFinite(Number(sc.changePct)) ? Number(sc.changePct) : null;
      }
      // 第二阶段指标无法计算的候选保留 prevGain 参与前五筛选，但组内不参与买入排序（见下方 ordered 构建）
      candidates.push({
        sc,
        prevGain,
        stage2: stage2 != null && Number.isFinite(stage2) ? stage2 : -Infinity,
      });
      continue;
    }
    let val;
    let val2; // 三日情绪冰点 1d 系列的决胜指标（最近 2 个交易日窗口的同向指标）
    let metric = null;
    if (isMaSlopeMode) {
      // 涨幅均线斜率角度：用当前盘中涨幅作为"今日涨幅均线"的今日成分，避免未来数据
      const angle = computeMaSlopeAngle(sc.code, days, di, rangeDates, dailyInfos, Number(sc.changePct));
      if (angle == null || !Number.isFinite(angle)) continue;
      val = angle;
      metric = parseFloat(angle.toFixed(4));
    } else if (isTop5ReportGainMode) {
      // 收集研报覆盖数与涨幅候选，事后按覆盖数取前五再按涨幅最大选股
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex, reportBuyTs);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      top5Candidates.push({ sc, reportCount, gain });
      continue;
    }
    if (isPureReportMode) {
      // 研报覆盖数最多/第二多（按对应 days 天统计）；覆盖数相同取 days 天涨幅最大
      const reportCount = sumReportCount(sc.name, reportWinDates, reportIndex, reportBuyTs);
      const gain = computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (gain == null || !Number.isFinite(gain)) continue;
      val = reportCount * 100000 + gain;
      metric = reportCount;
    } else if (gainMode) {
      val = halfDayDate != null
        ? computeWindowGainWithHalf(sc.code, winDates, dailyInfos, sc.changePct, halfDayDate)
        : computeWindowGain(sc.code, winDates, dailyInfos, sc.changePct);
      if (isEmo3Tiebreak) val2 = computeWindowGain(sc.code, tiebreakWinDates, dailyInfos, sc.changePct);
    } else {
      const intradayResilience = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      val = computeWindowResilience(sc.code, winDates, dailyInfos, intradayResilience);
      if (isEmo3Tiebreak) val2 = computeWindowResilience(sc.code, tiebreakWinDates, dailyInfos, intradayResilience);
    }
    if (val == null || !Number.isFinite(val)) continue;
    candidates.push({
      sc,
      val,
      // 决胜指标：2 日窗口数据缺失（如回测首日无昨日数据）时排到同分组末尾——
      // 降序（涨幅/抗分歧）用 -Infinity，升序（跌幅）用 +Infinity
      val2: isEmo3Tiebreak
        ? (val2 != null && Number.isFinite(val2) ? val2 : (lowMode ? Infinity : -Infinity))
        : undefined,
      metric: metric != null ? metric : parseFloat(val.toFixed(4)),
    });
  }

  // 构建策略排名序列
  let ordered; // [{ sc, metric }]
  if (isPrevFall5Mode) {
    // 前N日「跌幅最大 / 波动最小」前五&当日指标最大：
    // 第一阶段：按前 N 日（不含今日）累计涨幅取前五（与第 5 名并列的全部纳入）
    //   top5：升序（跌幅最大在前）；low5（波动最小）：无论涨跌，按累计涨幅绝对值升序（波动最小在前）
    if (candidates.length === 0) return null;
    let topGroup;
    if (prevFallLowMode) {
      const byVol = candidates.slice().sort((a, b) => Math.abs(a.prevGain) - Math.abs(b.prevGain));
      const volThreshold = byVol[Math.min(4, byVol.length - 1)].prevGain;
      topGroup = byVol.filter(c => Math.abs(c.prevGain) <= Math.abs(volThreshold));
    } else {
      const byFall = candidates.slice().sort((a, b) => a.prevGain - b.prevGain);
      const fallThreshold = byFall[Math.min(4, byFall.length - 1)].prevGain;
      topGroup = byFall.filter(c => c.prevGain <= fallThreshold);
    }
    // 第二阶段：组内按当日实时指标（触发时点实时涨幅 / 日内实时抗分歧分数）降序；
    // 指标无法计算（-Infinity 占位）的候选不参与买入排序
    ordered = topGroup
      .filter(c => c.stage2 !== -Infinity)
      .sort((a, b) => b.stage2 - a.stage2)
      .map(c => ({ sc: c.sc, metric: parseFloat(c.stage2.toFixed(2)) }));
  } else if (isTop5ReportGainMode) {
    // 研报覆盖数降序取前五（覆盖数相同的股票全部纳入），组内按窗口涨幅降序；
    // 前五组之后按涨幅降序接在后面（仅在组内全部不满足抗分歧门槛时才会顺延到）
    if (!top5Candidates.length) return null;
    top5Candidates.sort((a, b) => b.reportCount - a.reportCount);
    const threshold = top5Candidates[Math.min(4, top5Candidates.length - 1)].reportCount;
    const topGroup = top5Candidates.filter(c => c.reportCount >= threshold).sort((a, b) => b.gain - a.gain);
    const restGroup = top5Candidates.filter(c => c.reportCount < threshold).sort((a, b) => b.gain - a.gain);
    ordered = topGroup.concat(restGroup).map(c => ({ sc: c.sc, metric: c.reportCount }));
  } else {
    ordered = candidates.slice().sort((a, b) => {
      const primary = lowMode ? a.val - b.val : b.val - a.val;
      if (primary !== 0 || a.val2 === undefined) return primary;
      // 主指标（当日指标）相同时按最近 2 日窗口指标决胜；双方均缺失（±Infinity 相等）保持自选股原顺序
      if (a.val2 === b.val2) return 0;
      return lowMode ? a.val2 - b.val2 : b.val2 - a.val2;
    }).map(c => ({ sc: c.sc, metric: c.metric }));
  }

  // 抗分歧≥11 门槛：门槛策略从排名最高者起向后找第一只满足的股票；其余策略不做校验，
  // 直接取策略排名指定名次的第一只（与原逻辑一致）。
  // 涨停顺延（全策略通用）：买点触发时点已涨停的候选（主板涨幅>9.5%、创业/科创>19%）实际无法成交，
  // 一律剔除并顺延至排名下一只；全部候选均涨停（或无有效候选）时当日不买入
  const skipped = []; // 因门槛策略抗分歧分数<11 被顺延跳过的前序股票（仅 RESILIENCE_GATE_STRATEGY_IDS 使用）
  const globalResilienceSkipped = []; // 因全局最低抗分歧 < GLOBAL_RESILIENCE_MIN 被顺延跳过（所有策略通用）
  const limitUpSkipped = []; // 因买点时点涨停被顺延跳过的候选（全策略通用，追加 limit_up_defer 买入明细）
  const prevOneWordSkipped = []; // 因上一交易日一字板被顺延跳过的候选（全策略通用，追加 one_word_board_defer 买入明细）
  const emoCycSkipped = []; // 因逆周期（与创业板指负相关）被顺延跳过的候选（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略，追加 cycle_defer 买入明细）
  const stockSlopeSkipped = []; // 因个股 MA3 切线正斜率连续天数 > 4 被顺延跳过
  // 个股斜率过滤触发条件：**仅指数今日盘中由负转正当日**（turnedPosToday=true）
  // 过滤规则：个股 MA3 切线正斜率连续天数 > 4 → 顺延下一只（= 4 允许）
  // 原因：指数刚由负转正，个股如果已经抢先连涨 ≥5 天是提前反应过大盘，不该再追
  const shouldCheckStockSlope = turnedPosInfo && (
    turnedPosInfo.cybTurnedPosToday || turnedPosInfo.starTurnedPosToday
  );
  for (let i = 0; i < ordered.length; i++) {
    const cand = ordered[i];
    if (isLimitUpAtBuy(cand.sc.code, cand.sc.changePct)) {
      limitUpSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时点涨幅
      });
      continue;
    }
    // 上一交易日一字板过滤（全策略通用，2026-10-05 新增）：昨日一字板的候选次日不买，
    // 剔除并顺延至排名下一只（set 为空视为无候选命中，不逐一判定）
    if (prevOneWordSet && prevOneWordSet.size > 0 && prevOneWordSet.has(cand.sc.code)) {
      prevOneWordSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时点涨幅
      });
      continue;
    }
    // 顺/逆周期过滤（除情绪游资/三日情绪冰点/尾盘抄底外的全部策略，emoCycSet 非空时生效，2026-10-06 新增）：
    // 与创业板指最近 20 个交易日日收益率负相关/零相关的候选 = 逆周期 → 剔除并顺延至排名下一只
    if (emoCycSet && emoCycSet.size > 0 && emoCycSet.has(cand.sc.code)) {
      emoCycSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时点涨幅
        corr: cycCorrCache.get(`${cand.sc.code}_${rangeDates[di]}`), // 相关系数（可能为 null=数据不足，理论上不进集合）
      });
      continue;
    }
    // 全局最低抗分歧门槛（所有策略）：买点触发时刻个股抗分歧 < GLOBAL_RESILIENCE_MIN → 顺延
    const intradayResilience = calcResilienceAtMinute(replayStocks, cand.sc.code, bucket.minute);
    if (intradayResilience != null && intradayResilience < GLOBAL_RESILIENCE_MIN) {
      globalResilienceSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        resilience: Number(intradayResilience.toFixed(2)),
        reason: `买点时刻抗分歧 ${intradayResilience.toFixed(2)} < 全局最低 ${GLOBAL_RESILIENCE_MIN}`,
      });
      continue;
    }
    // 指数今日由负转正当日，检查个股 MA3 切线正斜率连续天数；> 4 则顺延（= 4 允许）
    if (shouldCheckStockSlope) {
      const slopeDays = countStockPositiveSlopeDays(cand.sc.code, rangeDates[di], dailyInfos);
      if (slopeDays != null && slopeDays > 4) {
        stockSlopeSkipped.push({
          code: cand.sc.code,
          name: cand.sc.name || cand.sc.code,
          slopeDays,
          reason: `跟踪指数今日由负转正，个股 MA3 切线正斜率已连续 ${slopeDays} 天（≤ 4 才允许）`,
        });
        continue;
      }
    }
    if (gateEnabled) {
      // RESILIENCE_GATE_STRATEGY_IDS（仅 highest_gain）：已经过了全局 ≥ 9 的线，这里再叠加 ≥ 11
      if (intradayResilience != null && intradayResilience >= RESILIENCE_GATE_MIN) {
        return { stock: cand.sc, metric: cand.metric, resilienceScore: intradayResilience, skipped, globalResilienceSkipped, limitUpSkipped, prevOneWordSkipped, emoCycSkipped, stockSlopeSkipped };
      }
      skipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        change: cand.sc.changePct != null ? Number(cand.sc.changePct) : null, // 触发时间点涨幅
        metric: gateIntradaySort ? undefined : cand.metric, // 窗口涨幅（排序依据，仅 N 日窗口涨幅排序的门槛策略输出）
        resilience: intradayResilience,
      });
    } else {
      return {
        stock: cand.sc,
        metric: cand.metric,
        resilienceScore: intradayResilience,
        limitUpSkipped,
        prevOneWordSkipped,
        emoCycSkipped,
        globalResilienceSkipped,
        stockSlopeSkipped,
        // 三日情绪冰点：附带命中的跟踪指数环境门禁明细（withResilienceGateInfo 会追加到买入条件明细）
        emo3Gate: isEmo3GateStrategy
          ? emo3IndexGateCache.get(`${rangeDates[di]}_${trackedIndexCodeOf(cand.sc.code)}`)
          : undefined,
      };
    }
  }
  return null; // 门槛策略：全部候选均不满足门槛；其余策略：候选全部涨停/抗分歧不足/无候选——均不买入
};

// ============================================================
// 买入条件明细中的选股顺延标注（抗分歧门槛）
// ============================================================
// 抗分歧门槛明细项：
//   - 全部策略：全局最低门槛 ≥ GLOBAL_RESILIENCE_MIN（当前 9）
//   - RESILIENCE_GATE_STRATEGY_IDS 门槛策略：叠加专项门槛 ≥ RESILIENCE_GATE_MIN（当前 11）
// passed 恒为 true：能入选即代表满足所有门槛

module.exports = {
  pickBestStock,
};
