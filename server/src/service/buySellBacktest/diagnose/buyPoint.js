const { getTechEmotionEmaMap } = require('../utils/techEmotion');

// ============================================================
const minuteToSeconds = (minute) => {
  const m = Number(minute);
  const h = Math.floor(m / 100);
  const mm = m % 100;
  return h * 3600 + mm * 60;
};

const fmtTime = (timeKey) => {
  const t = String(timeKey || '').padStart(6, '0');
  if (t.length < 4) return '--:--:--';
  return `${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`;
};

// 在当前桶之前寻找约 targetMin 分钟前的桶（targetMin±1 分钟内取最近的；找不到回退到至少 targetMin-1 分钟前最近的）
const findBucketMinutesAgo = (buckets, currentIndex, targetMin = 5) => {
  if (currentIndex <= 0) return null;
  const currentSec = minuteToSeconds(buckets[currentIndex].minute);
  const minSec = (targetMin - 1) * 60;
  const maxSec = (targetMin + 1) * 60;
  let hit = null;
  let hitIdx = -1;
  let minDelta = Infinity;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const diff = currentSec - minuteToSeconds(buckets[i].minute);
    if (diff >= minSec && diff <= maxSec) {
      if (diff < minDelta) { minDelta = diff; hit = buckets[i]; hitIdx = i; }
    } else if (diff > maxSec) {
      break;
    }
  }
  if (!hit) {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (currentSec - minuteToSeconds(buckets[i].minute) >= minSec) {
        hit = buckets[i];
        hitIdx = i;
        break;
      }
    }
  }
  return hit ? { bucket: hit, index: hitIdx } : null;
};

// 训练营回放买点诊断（对齐前端 buyPointChecks.js，返回 { success, data } 或 null）
// 资金净流入检查构建（常规买点诊断与重点板块策略共用）：最近 5min 大盘主力资金净流入差值，> 20 亿通过
// 返回 { fundResult, fundDiff, check }；fundResult.hasData=false 表示数据不足
const buildFundInflowCheck = (buckets, currentIndex) => {
  const list = buckets || [];
  const current = list[currentIndex];
  const currentFund = Number(current.fundFlow) || 0;
  const pastFundHit = findBucketMinutesAgo(list, currentIndex, 5);
  const fundResult = pastFundHit
    ? {
      hasData: true,
      diff: currentFund - (Number(pastFundHit.bucket.fundFlow) || 0),
      currentValue: currentFund,
      pastValue: Number(pastFundHit.bucket.fundFlow) || 0,
      currentTime: fmtTime(current.timeKey),
      pastTime: fmtTime(pastFundHit.bucket.timeKey),
    }
    : { hasData: false, diff: 0, currentValue: currentFund, pastValue: 0, currentTime: fmtTime(current.timeKey), pastTime: null };
  const fundDiff = parseFloat(fundResult.diff.toFixed(2));
  const checkFundPassed = fundResult.hasData && fundDiff > 20;
  // 资金明细文案（随买入原因汇总展示）：最近 5min 净流入差值
  const fundText = fundResult.hasData ? `5min 内资金净流入 ${fundDiff.toFixed(2)}亿` : null;
  const check = {
    id: 'fund_inflow',
    title: '最近 5min 资金净流入大于 20 亿',
    passed: checkFundPassed,
    value: fundResult.hasData ? `${fundDiff >= 0 ? '+' : ''}${fundDiff.toFixed(2)}亿` : '数据不足',
    fundText,
    reason: checkFundPassed
      ? `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），超过 20 亿阈值`
      : !fundResult.hasData
        ? '资金数据不足，无法判断最近 5 分钟净流入'
        : `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），未达到 20 亿阈值`,
  };
  return { fundResult, fundDiff, check };
};

// 量能检查构建（常规买点诊断与重点板块策略共用）：当前量能（今日累计成交额 − 昨日全天成交额）
// 为正时较 5min 前增加即可，为负时需增加 ≥ 100 亿；今日/昨日科技情绪触及 -100 冰点时自动豁免
const buildVolumeExpansionCheck = (buckets, currentIndex, campData) => {
  const list = buckets || [];
  const current = list[currentIndex];
  const volNow = current.volume !== null && current.volume !== undefined && !Number.isNaN(Number(current.volume)) ? Number(current.volume) : null;
  const pastVolHit = findBucketMinutesAgo(list, currentIndex, 5);
  const past2VolHit = pastVolHit ? findBucketMinutesAgo(list, pastVolHit.index, 5) : null;
  let volumeResult;
  if (volNow === null) {
    volumeResult = {
      hasData: false, diff: 0, last5minVol: 0, prev5minVol: 0,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
    };
  } else {
    const last5minVol = parseFloat(volNow.toFixed(2));
    const prev5minVol = pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : 0;
    volumeResult = {
      hasData: true,
      diff: parseFloat((last5minVol - prev5minVol).toFixed(2)),
      last5minVol,
      prev5minVol,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
      currentCumulative: parseFloat(volNow.toFixed(2)),
      pastCumulative: pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : null,
      past2Cumulative: past2VolHit ? parseFloat((Number(past2VolHit.bucket.volume) || 0).toFixed(2)) : null,
    };
  }
  const volDiff = volumeResult.hasData ? volumeResult.diff : 0;
  // 判定规则（对齐线上 buySellDiagnose.js）：当前量能为正时只需较 5min 前增加；为负时需增加 100 亿以上
  const checkVolumePassed = !volumeResult.hasData ? false
    : volumeResult.last5minVol > 0
      ? volumeResult.last5minVol > volumeResult.prev5minVol
      : volDiff >= 100;
  const todayHasIceFlag = campData?.todayHasIce === true;
  const prevDayHasIceFlag = campData?.prevDayHasIce === true;
  if (todayHasIceFlag || prevDayHasIceFlag) {
    const targetDateStr = String(campData?.date || '').replace(/-/g, '');
    const iceSource = todayHasIceFlag ? `今日(${targetDateStr.substring(4, 6)}-${targetDateStr.substring(6, 8)})` : '前一交易日';
    // 豁免文案：明确说明「冰点期豁免成交量」，并带出实际量能变化数值（无数据时仅说明豁免）
    const exemptVolText = volumeResult.hasData
      ? `冰点期豁免成交量，成交量${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿`
      : '冰点期豁免成交量';
    return {
      check: {
        id: 'volume_expansion',
        title: '当前量能为正（今日累计成交额超昨日全天）',
        passed: true,
        exempted: true,
        value: exemptVolText,
        volumeText: exemptVolText,
        reason: volumeResult.hasData
          ? `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），${exemptVolText}`
          : `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），情绪已达冰点量能条件自动豁免`,
      },
      volumeResult,
    };
  }
  // 量能明细文案（随买入原因汇总展示）：最近 5min 成交量变化量
  const volumeText = volumeResult.hasData
    ? `成交量${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿`
    : null;
  return {
    check: {
      id: 'volume_expansion',
      title: '量能较 5min 前增加（负值需增加超 100 亿）',
      passed: checkVolumePassed,
      value: volumeResult.hasData ? `${volDiff >= 0 ? '+' : '-'} ${Math.abs(volDiff).toFixed(2)}亿` : '数据不足',
      volumeText,
      reason: !volumeResult.hasData
        ? '量能数据不足，无法判断当前量能'
        : (() => {
          const volChangeText = volDiff >= 0 ? `+ ${volDiff.toFixed(2)} 亿` : `- ${Math.abs(volDiff).toFixed(2)} 亿`;
          return volumeResult.last5minVol > 0
            ? checkVolumePassed
              ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为正，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，持续放量`
              : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿虽为正，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}`
            : checkVolumePassed
              ? `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，但较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿${volChangeText}，达到 100 亿阈值`
              : `当前量能 ${volumeResult.last5minVol.toFixed(2)} 亿为负，较 5min 前的 ${volumeResult.prev5minVol.toFixed(2)} 亿仅${volChangeText}，未达到增加 100 亿的阈值`;
        })(),
    },
    volumeResult,
  };
};

const runBuyPointDiagnosis = (timeBuckets, currentIndex, campData) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return null;
  const current = buckets[currentIndex];
  const checks = [];
  let allPassed = true;
  const targetDateStr = String(campData?.date || '').replace(/-/g, '');

  // 检查2：最近 5min 资金净流入大于 20 亿（构建函数与重点板块策略共用）
  const { check: fundCheck } = buildFundInflowCheck(buckets, currentIndex);
  checks.push(fundCheck);
  if (!fundCheck.passed) allPassed = false;

  // 检查3：量能较 5min 前增加（负值需增加超 100 亿；情绪冰点自动豁免，构建函数与重点板块策略共用）
  const { check: volumeCheck } = buildVolumeExpansionCheck(buckets, currentIndex, campData);
  checks.push(volumeCheck);
  if (!volumeCheck.passed) allPassed = false;

  // 检查4：开盘后自选股低于开盘价不超过 30 只（仅 9:30-10:00 生效）
  const changes = current.stockChanges || [];
  const inOpeningWindow = Number(current.minute) >= 930 && Number(current.minute) <= 1000;
  if (inOpeningWindow) {
    const openingBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
    const openingMap = new Map((openingBucket?.stockChanges || []).map(s => [s.code, s.changePct]));
    let belowCount = 0;
    let validCount = 0;
    changes.forEach(s => {
      const openPct = openingMap.get(s.code);
      if (openPct !== undefined && openPct !== null) {
        validCount++;
        if (Number(s.changePct) < Number(openPct)) belowCount++;
      }
    });
    const checkOpeningPassed = belowCount <= 30;
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: checkOpeningPassed,
      value: `${belowCount} / ${validCount}只`,
      reason: checkOpeningPassed
        ? `开盘后自选股共 ${validCount} 只，${belowCount} 只现价低于 9:30 开盘价，未超过 30 只`
        : belowCount > 30
          ? `开盘后自选股共 ${validCount} 只，${belowCount} 只现价低于 9:30 开盘价，超过 30 只阈值，市场开盘跳水严重`
          : '分时数据获取异常',
    });
    if (!checkOpeningPassed) allPassed = false;
  } else {
    checks.push({
      id: 'opening_below',
      title: '开盘后自选股低于开盘价不超过 30 只',
      passed: true,
      value: '非交易时段',
      reason: '此项检查仅在交易日 9:30-10:00 之间生效，当前时段跳过',
    });
  }

  // 检查6：9:30 竞价开盘科技情绪 > 80 时，后续触发买点要求当前科技情绪 < 40
  const openEmotionBucket = buckets.find(b => Number(b.minute) === 930) || buckets[0];
  const openingAuctionEmotion = openEmotionBucket && openEmotionBucket.techEmotion !== null && openEmotionBucket.techEmotion !== undefined && !Number.isNaN(Number(openEmotionBucket.techEmotion))
    ? Number(openEmotionBucket.techEmotion)
    : null;
  const currentRetraceEmotion = current.techEmotion !== null && current.techEmotion !== undefined && !Number.isNaN(Number(current.techEmotion))
    ? Number(current.techEmotion)
    : null;

  let checkEmotionRetracePassed;
  let emotionRetraceReason;
  if (openingAuctionEmotion === null) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = '暂无 9:30 竞价科技情绪分时数据，跳过该检查';
  } else if (openingAuctionEmotion <= 80) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 未超过 80，当前情绪须低于 40 的限制不生效`;
  } else if (currentRetraceEmotion === null) {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，但暂无当前分时数据，无法确认情绪回落至 40 以下`;
  } else if (currentRetraceEmotion < 40) {
    checkEmotionRetracePassed = true;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentRetraceEmotion.toFixed(2)} 已回落至 40 以下，允许买入`;
  } else {
    checkEmotionRetracePassed = false;
    emotionRetraceReason = `9:30 竞价科技情绪 ${openingAuctionEmotion.toFixed(2)} 超过 80，当前科技情绪 ${currentRetraceEmotion.toFixed(2)} 未回落至 40 以下，禁止买入`;
  }
  checks.push({
    id: 'emotion_retrace_after_open',
    title: '竞价情绪超 80 时当前情绪须低于 40',
    passed: checkEmotionRetracePassed,
    value: openingAuctionEmotion === null ? '暂无分时数据' : `开盘 ${openingAuctionEmotion.toFixed(2)} / 当前 ${currentRetraceEmotion === null ? '--' : currentRetraceEmotion.toFixed(2)}`,
    reason: emotionRetraceReason,
  });
  if (!checkEmotionRetracePassed) allPassed = false;

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timeKey: current.timeKey,
      displayTime: current.displayTime || fmtTime(current.timeKey),
      checks,
      allPassed,
      passedCount: checks.filter(c => c.passed).length,
      totalCheckCount: checks.length,
    },
  };
};

// 尾盘抄底命中检查（买卖点回测专用）：
// 抄底时机固定在尾盘 14:57（收盘集合竞价挂单，按触发桶价格成交，价格≈当日收盘价）：
// 判断点取当日第一个 minute ≥ 1457 的回放桶（通常即 1500 收盘桶）；
// 若当日分时数据未覆盖 14:57（如最后一桶为 1455），回退用当日最后一个桶，其余桶一律不触发。
// 命中条件（唯一）：当日科技情绪分时曾触及 -100 退潮冰点（等价于当日科技情绪指数 hasIce: true）
const checkTailDipHit = (timeBuckets, currentIndex) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return false;
  // 注意：回放桶的 minute 为 HHMM 整数（如 1457 表示 14:57），与 runBuyPointDiagnosis 开盘窗口（930-1000）口径一致
  let triggerIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) >= 1457) { triggerIdx = i; break; }
  }
  if (triggerIdx === -1) triggerIdx = buckets.length - 1; // 数据未覆盖 14:57 时回退最后一个桶，避免条件永不命中
  if (currentIndex !== triggerIdx) return false;

  // 当日科技情绪分时曾触及 -100（hasIce）；仅统计截至当前时点的分时，避免使用未来数据
  return buckets.slice(0, currentIndex + 1).some((b) => {
    const e = b.techEmotion == null ? null : Number(b.techEmotion);
    return e != null && !Number.isNaN(e) && e <= -100;
  });
};

// 情绪页同源数据：tech_index.json 每日收盘情绪分（changeSumResult）序列，
// 复刻 sentiment 页「三日均值」EMA 线算法（emaAlpha = 2/(3+1) = 0.5，首点 = 前三个值简单均值，
// 之后 currentEma = 0.5 * 当日值 + 0.5 * 前一日 EMA；按文件全量序列递推，含周末重复数据点，与页面展示一致）。
// 返回 Map<'YYYYMMDD', EMA值>（序列前两个点无 EMA，存 null）
const EMO_AVG3_THRESHOLD = -60;
const checkEmoAvg3Hit = (timeBuckets, currentIndex, dateStr) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return false;
  let triggerIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (Number(buckets[i].minute) >= 1457) { triggerIdx = i; break; }
  }
  if (triggerIdx === -1) triggerIdx = buckets.length - 1; // 数据未覆盖 14:57 时回退最后一个桶，避免条件永不命中
  if (currentIndex !== triggerIdx) return false;
  const ema = getTechEmotionEmaMap().get(String(dateStr));
  return ema != null && ema < EMO_AVG3_THRESHOLD;
};

// ===== 买入原因构建（随成交记录/缓存/回测报告落盘，供前端与报告展示命中了哪些买入条件） =====
// 尾盘抄底策略的固定买入原因（命中条件唯一：当日科技情绪分时曾触及 -100 退潮冰点）
const TAIL_DIP_BUY_INFO = {
  buyReason: '尾盘抄底命中：当日科技情绪曾触及-100退潮冰点',
  buyChecks: [{
    id: 'tail_dip',
    title: '尾盘抄底命中（当日科技情绪曾触及-100退潮冰点）',
    passed: true,
    value: '14:57',
    reason: '当日科技情绪分时曾触及 -100 退潮冰点（等价 hasIce: true），14:57 尾盘挂单买入（收盘集合竞价成交）',
  }],
};

// 三日情绪均值尾盘抄底策略的固定买入原因（命中条件：情绪页三日均值EMA线 < -60）
const EMO_AVG3_BUY_INFO = {
  buyReason: '尾盘抄底命中：情绪页三日均值线(EMA) < -60',
  buyChecks: [{
    id: 'tail_dip_emo3',
    title: '尾盘抄底命中（情绪页三日均值EMA线<-60）',
    passed: true,
    value: '14:57',
    reason: '情绪页「三日均值」EMA 线（每日收盘情绪分 changeSumResult 递推，与 sentiment 页同源同算法）当日读数 < -60，14:57 尾盘挂单买入（收盘集合竞价成交）',
  }],
};

// 由买点诊断结果构建买入原因：buyReason 为全部命中条件标题汇总（与 sellReason 命中卖出条件名口径一致），
// 资金净流入/量能项额外附带明细数值（如「5min 内资金净流入 24.00亿」「成交量增加 120.00亿」「冰点期豁免成交量，成交量增加 50.00亿」）；
// buyChecks 为逐项明细（含数值与判定理由），allPassed !== true 时返回空
const buildBuyReasonFromDiag = (diagData) => {
  if (!diagData || diagData.allPassed !== true) return { buyReason: '', buyChecks: [] };
  const passedChecks = (diagData.checks || []).filter(c => c.passed);
  return {
    buyReason: passedChecks.map(c => (
      c.id === 'volume_expansion' && c.volumeText
        ? `${c.volumeText}`
        : c.id === 'fund_inflow' && c.fundText
          ? `${c.fundText}`
          : c.title
    )).join('、') || '买点诊断全部通过',
    buyChecks: (diagData.checks || []).map(c => ({
      id: c.id,
      title: c.title,
      passed: !!c.passed,
      exempted: !!c.exempted,
      value: c.value,
      reason: c.reason,
      ...(c.volumeText ? { volumeText: c.volumeText } : {}),
      ...(c.fundText ? { fundText: c.fundText } : {}),
    })),
  };
};

// ============================================================
// 以下为抗分歧指数移植（对齐 src/utils/replayResilience.js）

module.exports = {
  EMO_AVG3_BUY_INFO,
  EMO_AVG3_THRESHOLD,
  TAIL_DIP_BUY_INFO,
  buildBuyReasonFromDiag,
  buildFundInflowCheck,
  buildVolumeExpansionCheck,
  checkEmoAvg3Hit,
  checkTailDipHit,
  findBucketMinutesAgo,
  fmtTime,
  minuteToSeconds,
  runBuyPointDiagnosis,
};
