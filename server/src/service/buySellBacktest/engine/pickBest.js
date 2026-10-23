const { BUY_TIME_MAX_MINUTE, GLOBAL_RESILIENCE_MIN, RESILIENCE_GATE_INTRADAY_SORT_IDS, RESILIENCE_GATE_MIN, RESILIENCE_GATE_STRATEGY_IDS, STRATEGIES } = require('../strategies/registry');
const { isNonTechWatchlistStock, passWatchlistGate } = require('./pickHelpers');
const { EXCLUDED_CODES } = require('../constants');
const { isBuyBlockedByValuation } = require('../../watchlistValuation');
const { resolveDelegatePick } = require('./selectors/delegates');
const { loadReportIndex, sumReportCount } = require('../utils/reportIndex');
const { isOscExcluded } = require('../deps');
const { calcResilienceAtMinute, computeWindowGain, computeWindowGainWithHalf, computeWindowResilience, isLimitUpAtBuy } = require('./replayData');
const { cycCorrCache } = require('./cycleFilter');

// 快进快出类「N 日涨幅接近时按抗分歧优先」阈值（2026-10-23 用户新增）：
// 第一名与第二名 N 日涨幅相差 ≤ 1 个百分点时，改买当日抗分歧分数更高的一只
const GAIN_TIE_PCT = 1;

const pickBestStock = (stocks, rangeDates, di, bucket, replayStocks, dailyInfos, strategyId, axisOffset = 0, allowedMarkets = null, turnedPosInfo = null, prevOneWordSet = null, emoCycSet = null, restrictCodes = null, emoQuickTie = false) => {
  // 买入时段门禁（所有策略通用）：仅允许 9:30 – 11:30 和 13:00 – 13:30 之间的买点触发买入
  const mNum = Number(bucket.minute);
  if (Number.isFinite(mNum) && mNum > BUY_TIME_MAX_MINUTE) return null;

  const isReportStrategy = strategyId.includes('reports');
  const isTop5ReportGainMode = strategyId.includes('reports_top5_gain'); // 研报覆盖前五（含覆盖数相同）中取窗口涨幅最大
  const isPureReportMode = isReportStrategy && !isTop5ReportGainMode; // 研报覆盖数最多/第二多
  const dayMatch = strategyId.match(/(\d+)d/);
  const days = dayMatch ? Number(dayMatch[1]) : null;

  // 策略选股委派（情绪快进快出 / 研报双门）：见 selectors/delegates.js。
  // 命中委派时直接返回其结果（可能为 null），未命中（undefined）交回下方主流水线。
  const delegated = resolveDelegatePick({
    pickBestStock, stocks, rangeDates, di, bucket, replayStocks, dailyInfos,
    strategyId, axisOffset, allowedMarkets, turnedPosInfo, prevOneWordSet, emoCycSet, restrictCodes,
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
  const gainMode = strategyId === 'highest_gain' || strategyId.includes('_gain');
  // 「N.5 日涨幅最大」系列（highest_{N}d5_gain 及其 _two_buy 变体）：
  // 在 N 日窗口之外，额外复利计入「更前一个交易日（窗口最早交易日的再前一交易日）下午 13:00→收盘」的半日涨幅；
  // halfDayDate = 日期轴上 di - days 那一天（越界为 null，退化为常规 N 日窗口）
  const halfDayAfternoon = STRATEGIES[strategyId]?.halfDayAfternoon === true;
  const halfDayDate = halfDayAfternoon && days && di - days >= 0 ? rangeDates[di - days] : null;
  // 抗分歧门槛策略（当前仅买入最高涨幅）：选股排序依据 = 买点触发时点当日盘中涨幅（用户定义，
  // 非窗口累计涨幅），从高到低排序后从最高者起依次用触发时点抗分歧分数≥11 过滤；
  // 若未来加入按 N 日窗口涨幅排序的门槛策略，会走下方窗口涨幅计算分支，仅追加抗分歧顺延校验
  const gateEnabled = RESILIENCE_GATE_STRATEGY_IDS.has(strategyId);
  const gateIntradaySort = RESILIENCE_GATE_INTRADAY_SORT_IDS.has(strategyId);

  // 按 N 日窗口涨幅排名的策略「涨幅领先但当日爆发力不足」顺延规则（2026-10-22 用户新增，同日扩展至
  // 全部按 N 日窗口涨幅排名的策略：N 日涨幅最大、N 日涨幅最大-两次买入、快进快出系列）：
  //   对当前排名第一的候选：若其 N 日涨幅领先第二名 > N 个百分点，且买点触发时点抗分歧分数低于
  //   「第二名~第五名」均值达 N 分（均值 − 该股 ≥ N），说明它只是历史涨幅大、当日爆发力不强 → 剔除并顺延，
  //   顺延后对新排名第一的候选重新按同规则判定（循环内自然继续）。
  //   不适用：买入最高涨幅（按触发时点当日盘中涨幅排序）与研报覆盖类（按覆盖数排序）。
  const applyGainGapRule = days != null && gainMode && !isReportStrategy && !gateIntradaySort;

  // 「最近 N 日涨幅超过 10% × N」过热门槛（2026-10-22 用户新增）：
  //   N 日涨幅最大系列、N 日涨幅最大-两次买入系列、快进快出系列（含 10×1/10×2/10×3 科技情绪快进快出）。
  //   例：3 日涨幅最大 → 最近 3 日累计涨幅 > 30% 的个股直接不进入候选（不参与涨幅排名）；
  //   N.5 日窗口按 10% × (N + 0.5) 计算（2.5 日 → 25%、3.5 日 → 35%）。
  //   不适用：买入最高涨幅（按触发时点当日盘中涨幅排序、无固定 N 日窗口）、研报覆盖类（按覆盖数排序）、
  //   两次买入不同板块系列（用户未纳入本次限制）。
  const gainCapPct = days == null ? null : (halfDayAfternoon ? days + 0.5 : days) * 10;
  const applyGainCap = gainCapPct != null && gainMode && !isReportStrategy && !strategyId.includes('diff_block');

  // 快进快出类「N 日涨幅接近时按抗分歧优先」（2026-10-23 用户新增）：
  //   按 N 日窗口涨幅排名后，若第一名与第二名的 N 日涨幅相差 ≤ 1 个百分点，则改买买点触发时点
  //   「当日抗分歧分数」更高的一只（分数缺失或相等时保持原涨幅排名）。
  //   适用范围 = 快进快出类（emoQuickOut 且非两次买入：N日涨幅最大-快进快出 6 个、研报覆盖快进快出、
  //   10×n 科技情绪-快进快出 3 个、快进快出-科技情绪门禁）；纯 N 日涨幅最大 / 两次买入系列不适用。
  //   注：普通快进快出策略在 selectors/delegates 中委托为 highest_{N}d_gain 选股，故由委派层显式传 emoQuickTie=true；
  //   10×n / 科技情绪门禁策略直接以自身 id 走主流水线，此处按策略配置自动识别
  const strategyConf = STRATEGIES[strategyId] || {};
  const quickTieScope = emoQuickTie || (strategyConf.emoQuickOut === true && strategyConf.twoBuy !== true);
  const applyGainTieRule = quickTieScope && days != null && gainMode && !isReportStrategy && !gateIntradaySort;

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
    if (gateIntradaySort) {
      // 门槛策略（最高涨幅/2日涨幅最大）：按触发时点当日盘中涨幅排序（如买点触发在 13:10，即看 13:10 时谁的涨幅最大）
      const chg = sc.changePct != null ? Number(sc.changePct) : null;
      if (chg == null || !Number.isFinite(chg)) continue;
      candidates.push({ sc, val: chg, metric: parseFloat(chg.toFixed(4)) });
      continue;
    }
    let val;
    let metric = null;
    if (isTop5ReportGainMode) {
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
    } else {
      const intradayResilience = calcResilienceAtMinute(replayStocks, sc.code, bucket.minute);
      val = computeWindowResilience(sc.code, winDates, dailyInfos, intradayResilience);
    }
    if (val == null || !Number.isFinite(val)) continue;
    // 最近 N 日涨幅超过 10% × N 的个股视为已过度上涨，直接剔除、不进入候选
    if (applyGainCap && val > gainCapPct) continue;
    candidates.push({
      sc,
      val,
      metric: metric != null ? metric : parseFloat(val.toFixed(4)),
    });
  }

  // 构建策略排名序列
  let ordered; // [{ sc, metric }]
  if (isTop5ReportGainMode) {
    // 研报覆盖数降序取前五（覆盖数相同的股票全部纳入），组内按窗口涨幅降序；
    // 前五组之后按涨幅降序接在后面（仅在组内全部不满足抗分歧门槛时才会顺延到）
    if (!top5Candidates.length) return null;
    top5Candidates.sort((a, b) => b.reportCount - a.reportCount);
    const threshold = top5Candidates[Math.min(4, top5Candidates.length - 1)].reportCount;
    const topGroup = top5Candidates.filter(c => c.reportCount >= threshold).sort((a, b) => b.gain - a.gain);
    const restGroup = top5Candidates.filter(c => c.reportCount < threshold).sort((a, b) => b.gain - a.gain);
    ordered = topGroup.concat(restGroup).map(c => ({ sc: c.sc, metric: c.reportCount }));
  } else {
    ordered = candidates.slice().sort((a, b) => b.val - a.val).map(c => ({ sc: c.sc, metric: c.metric, val: c.val }));
  }

  // 快进快出类：N 日涨幅第一名与第二名相差 ≤ 1 个百分点 → 买点触发时点当日抗分歧更高者优先
  // （仅调整前两名的先后顺序；两者分数缺失或相等时保持原涨幅排名。顺延逻辑仍在下方循环里统一处理，
  //   若优先者后续因涨停/一字板/逆周期/抗分歧不足被顺延时，另一只仍会按原顺序被买入）
  let gainTieInfo = null;
  if (applyGainTieRule && ordered.length >= 2) {
    const first = ordered[0];
    const second = ordered[1];
    const gap = Number(first.val) - Number(second.val);
    if (Number.isFinite(gap) && gap <= GAIN_TIE_PCT) {
      const firstRes = calcResilienceAtMinute(replayStocks, first.sc.code, bucket.minute);
      const secondRes = calcResilienceAtMinute(replayStocks, second.sc.code, bucket.minute);
      const swapped = firstRes != null && secondRes != null && secondRes > firstRes;
      const pickEntry = swapped ? second : first;
      const dropEntry = swapped ? first : second;
      if (swapped) {
        ordered[0] = second;
        ordered[1] = first;
      }
      gainTieInfo = {
        threshold: GAIN_TIE_PCT,
        gap: Number(gap.toFixed(2)),
        swapped,
        picked: {
          code: pickEntry.sc.code,
          name: pickEntry.sc.name || pickEntry.sc.code,
          gain: Number(Number(pickEntry.val).toFixed(2)),
          resilience: swapped ? secondRes : firstRes,
        },
        dropped: {
          code: dropEntry.sc.code,
          name: dropEntry.sc.name || dropEntry.sc.code,
          gain: Number(Number(dropEntry.val).toFixed(2)),
          resilience: swapped ? firstRes : secondRes,
        },
      };
    }
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
  const gainGapSkipped = []; // 快进快出类：N 日涨幅领先第二名 > N 个百分点但买点时刻抗分歧低于第2~5名均值达 N 分被顺延跳过
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
    // 快进快出类「涨幅领先但当日爆发力不足」顺延（2026-10-22 用户新增）：
    //   当前候选 N 日涨幅领先第二名 > N 个百分点 → 对比其买点时刻抗分歧 与 第2~5名抗分歧均值，
    //   若「均值 − 该股 ≥ N」则剔除该股并顺延（顺延后循环会对新的第一名重新判定）
    if (applyGainGapRule && intradayResilience != null) {
      const second = ordered[i + 1];
      const curGain = cand.val;
      const secondGain = second ? second.val : null;
      if (curGain != null && Number.isFinite(curGain) && secondGain != null && Number.isFinite(secondGain)) {
        const gainLead = curGain - secondGain;
        if (gainLead > days) {
          const refResiliences = ordered.slice(i + 1, i + 5)
            .map(o => calcResilienceAtMinute(replayStocks, o.sc.code, bucket.minute))
            .filter(v => v != null && Number.isFinite(v));
          if (refResiliences.length > 0) {
            const avgResilience = refResiliences.reduce((s, v) => s + v, 0) / refResiliences.length;
            if (avgResilience - intradayResilience >= days) {
              gainGapSkipped.push({
                code: cand.sc.code,
                name: cand.sc.name || cand.sc.code,
                gain: Number(curGain.toFixed(2)),
                gainLead: Number(gainLead.toFixed(2)),
                resilience: Number(intradayResilience.toFixed(2)),
                avgResilience: Number(avgResilience.toFixed(2)),
                diff: Number((avgResilience - intradayResilience).toFixed(2)),
                threshold: days,
                refCount: refResiliences.length,
              });
              continue;
            }
          }
        }
      }
    }
    if (intradayResilience != null && intradayResilience < GLOBAL_RESILIENCE_MIN) {
      globalResilienceSkipped.push({
        code: cand.sc.code,
        name: cand.sc.name || cand.sc.code,
        resilience: Number(intradayResilience.toFixed(2)),
        reason: `买点时刻抗分歧 ${intradayResilience.toFixed(2)} < 全局最低 ${GLOBAL_RESILIENCE_MIN}`,
      });
      continue;
    }
    if (gateEnabled) {
      // RESILIENCE_GATE_STRATEGY_IDS（仅 highest_gain）：已经过了全局 ≥ 9 的线，这里再叠加 ≥ 11
      if (intradayResilience != null && intradayResilience >= RESILIENCE_GATE_MIN) {
        return { stock: cand.sc, metric: cand.metric, resilienceScore: intradayResilience, skipped, globalResilienceSkipped, limitUpSkipped, prevOneWordSkipped, emoCycSkipped, gainGapSkipped, gainTieInfo };
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
        gainGapSkipped,
        gainTieInfo,
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
