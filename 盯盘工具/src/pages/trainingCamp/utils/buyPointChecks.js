// 训练营回放 - 买点诊断
// 对齐后端 server/src/service/buySellDiagnose.js 的 getBuyPointChecks 逻辑，
// 基于回放时间桶数据（fundFlow / volume / stockChanges / techEmotion）计算 4 项前置条件（已移除"科技情绪指数大于 -40"与"自选股上涨家数大于下跌家数"）。

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

const runBuyPointDiagnosis = (timeBuckets, currentIndex, campData) => {
  const buckets = timeBuckets || [];
  if (buckets.length === 0 || currentIndex < 0 || currentIndex >= buckets.length) return null;
  const current = buckets[currentIndex];
  const checks = [];
  let allPassed = true;
  const targetDateStr = String(campData?.date || '').replace(/-/g, '');

  // ============================================================
  // 检查1：情绪冰点（前一日 < -40 或 当日 hasIce）【已注释停用，保留代码】
  // 暂停该前置条件，不再作为买点必要条件
  // ============================================================
  // const todayHasIce = campData?.todayHasIce === true;
  // const prevEmotion = campData?.prevDayTechEmotion;
  // const prevNum = prevEmotion !== null && prevEmotion !== undefined && !Number.isNaN(Number(prevEmotion)) ? Number(prevEmotion) : null;
  // const isPrevFreezing = prevNum !== null && prevNum < -40;
  // const checkFreezingPassed = todayHasIce || isPrevFreezing;
  // let emotionFreezingReason;
  // if (todayHasIce) {
  //   emotionFreezingReason = '当日盘中有分时触及冰点（hasIce）';
  // } else if (isPrevFreezing) {
  //   emotionFreezingReason = `前一日科技情绪指数 ${prevNum.toFixed(2)} < -40`;
  // } else {
  //   emotionFreezingReason = '前一日未触发情绪冰点条件，今日分时也未破 -40';
  // }
  // checks.push({
  //   id: 'emotion_freezing',
  //   title: '情绪冰点（前一日或今日分时）',
  //   passed: checkFreezingPassed,
  //   value: checkFreezingPassed ? '是' : '否',
  //   reason: emotionFreezingReason,
  // });
  // if (!checkFreezingPassed) allPassed = false;

  // 检查2：最近 5min 资金净流入大于 20 亿
  const currentFund = Number(current.fundFlow) || 0;
  const pastFundHit = findBucketMinutesAgo(buckets, currentIndex, 5);
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
  checks.push({
    id: 'fund_inflow',
    title: '最近 5min 资金净流入大于 20 亿',
    passed: checkFundPassed,
    value: fundResult.hasData ? `${fundDiff >= 0 ? '+' : ''}${fundDiff.toFixed(2)}亿` : '数据不足',
    detail: {
      currentTime: fundResult.currentTime,
      pastTime: fundResult.pastTime,
      currentValue: fundResult.pastTime ? fundResult.currentValue : null,
      pastValue: fundResult.pastTime ? fundResult.pastValue : null,
    },
    reason: checkFundPassed
      ? `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），超过 20 亿阈值`
      : !fundResult.hasData
        ? '资金数据不足，无法判断最近 5 分钟净流入'
        : `最近 5 分钟资金净流入 ${fundDiff.toFixed(2)} 亿（${fundResult.pastTime}→${fundResult.currentTime}），未达到 20 亿阈值`,
  });
  if (!checkFundPassed) allPassed = false;

  // 检查3：当前量能（amountChangeDiff = 今日累计成交额 − 昨日全天成交额）为正，且大于 5min 前的值
  // 说明：回放成交量字段为 amountChangeDiff（今日成交额较昨日同时段的差额，单位亿，可为负，约每10分钟一条快照）。
  // 与线上 buySellDiagnose.js 一致：需当前量能为正且大于 5min 前的值；5min 前对比（prev5minVol/diff）同时用于展示。
  const volNow = current.volume !== null && current.volume !== undefined && !Number.isNaN(Number(current.volume)) ? Number(current.volume) : null;
  const pastVolHit = findBucketMinutesAgo(buckets, currentIndex, 5);
  const past2VolHit = pastVolHit ? findBucketMinutesAgo(buckets, pastVolHit.index, 5) : null;
  let volumeResult;
  if (volNow === null) {
    volumeResult = {
      hasData: false, diff: 0, last5minVol: 0, prev5minVol: 0,
      currentTime: fmtTime(current.timeKey),
      pastTime: pastVolHit ? fmtTime(pastVolHit.bucket.timeKey) : null,
      past2Time: past2VolHit ? fmtTime(past2VolHit.bucket.timeKey) : null,
    };
  } else {
    const last5minVol = parseFloat(volNow.toFixed(2)); // 当前量能
    const prev5minVol = pastVolHit ? parseFloat((Number(pastVolHit.bucket.volume) || 0).toFixed(2)) : 0; // 5min前量能（仅展示参考）
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
  // 判定规则（对齐线上 buySellDiagnose.js）：当前量能为正时，只需较 5min 前增加即可（无阈值）；当前量能为负时，需较 5min 前增加 100 亿以上
  const checkVolumePassed = !volumeResult.hasData ? false
    : volumeResult.last5minVol > 0
      ? volumeResult.last5minVol > volumeResult.prev5minVol
      : volDiff >= 100;
  const volumeDirection = volumeResult.hasData && volDiff > 0 ? '放大' : '缩量';
  // 豁免规则（对齐线上 buySellDiagnose.js）：今日或前一交易日 hasIce: true（盘中情绪触及 -100 退潮冰点）时，量能条件自动豁免
  const todayHasIceFlag = campData?.todayHasIce === true;
  const prevDayHasIceFlag = campData?.prevDayHasIce === true;
  const targetDateDisplay = targetDateStr ? `${targetDateStr.substring(4, 6)}-${targetDateStr.substring(6, 8)}` : '';
  if (todayHasIceFlag || prevDayHasIceFlag) {
    const iceSource = todayHasIceFlag ? `今日(${targetDateDisplay})` : '前一交易日';
    checks.push({
      id: 'volume_expansion',
      title: '当前量能为正（今日累计成交额超昨日全天）',
      passed: true,
      exempted: true,
      value: volumeResult.hasData ? `${volDiff >= 0 ? '增加' : '减少'} ${Math.abs(volDiff).toFixed(2)}亿（已豁免）` : '已豁免',
      detail: {
        currentTime: volumeResult.currentTime,
        pastTime: volumeResult.pastTime,
        past2Time: volumeResult.past2Time,
        prev5minVol: volumeResult.hasData ? volumeResult.prev5minVol : null,
        last5minVol: volumeResult.hasData ? volumeResult.last5minVol : null,
      },
      reason: `${iceSource}盘中科技情绪触及 -100 退潮冰点（hasIce: true），情绪已达冰点量能条件自动豁免`,
    });
  } else {
  checks.push({
    id: 'volume_expansion',
    title: '量能较 5min 前增加（负值需增加超 100 亿）',
    passed: checkVolumePassed,
    value: volumeResult.hasData ? `${volDiff >= 0 ? '+' : '-'} ${Math.abs(volDiff).toFixed(2)}亿` : '数据不足',
    detail: {
      currentTime: volumeResult.currentTime,
      pastTime: volumeResult.pastTime,
      past2Time: volumeResult.past2Time,
      prev5minVol: volumeResult.hasData ? volumeResult.prev5minVol : null,
      last5minVol: volumeResult.hasData ? volumeResult.last5minVol : null,
      increase5min: volumeResult.hasData ? volDiff : null,
    },
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
  });
  if (!checkVolumePassed) allPassed = false;
  }

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

  // 检查6：9:30 竞价开盘科技情绪 > 80 时，后续触发买点要求当前科技情绪 < 40（开盘过热需回落才可买）
  // 与线上 buySellDiagnose.js 一致：取 9:30 竞价桶（minute 930）科技情绪，找不到时回退当日第一个桶
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

  // ============================================================
  // 尾盘抄底（或逻辑分支）已移除：买点诊断仅看前置检查全部通过（allPassed），
  // 尾盘抄底仅保留在回测策略（buySellBacktest.js tail_dip_* 系列）中
  // ============================================================

  const passedCount = checks.filter(c => c.passed).length;
  const totalCheckCount = checks.length;
  const conclusion = allPassed
    ? '全部前置条件已满足，可以出手买入，但是请分仓 1/3，随后逐步分批买入，分仓管理是最后一道防火墙，谨防尾盘大盘跳水！'
    : '当前前置条件未全部满足，请耐心等待，不要盲目出手。';

  return {
    success: true,
    data: {
      targetDate: targetDateStr,
      timeKey: current.timeKey,
      displayTime: current.displayTime || fmtTime(current.timeKey),
      checks,
      allPassed,
      passedCount,
      totalCheckCount,
      isFreezingDay: false, // 情绪冰点检查已注释停用，固定返回 false
      freezingReason: null, // 情绪冰点检查已注释停用，固定返回 null
      conclusion,
    },
  };
};

export default runBuyPointDiagnosis;
