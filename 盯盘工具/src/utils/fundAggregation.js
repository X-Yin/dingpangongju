// 主力资金分时序列统一聚合口径（实时盯盘 / 开盘作战 / 训练营回放 / 买卖点回测共用）
//
// 规则（与服务端 service/fundSnapshot.js 的 aggregateByInterval 完全一致）：
//   · 窗口边界从 9:35 / 13:05 开始（没有 9:30 / 13:00 桶），步长为 intervalMinutes；
//   · 每个原始点归属到「严格大于该时间的最近边界」所在窗口；
//   · 窗口值取窗口内最后一条快照的累计净流入；
//   · 相邻窗口的累计值之差即该 5min 的资金净流入增量。
//
// 注意：任何需要展示/比较「某时点主力资金」的地方都必须走这里，避免各页面各自分桶导致口径不一致。

export const parseMoneyValue = (val) => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  let str = String(val);
  const sign = str.startsWith('-') ? -1 : 1;
  if (str.startsWith('+') || str.startsWith('-')) str = str.slice(1);
  let num = parseFloat(str.replace(/亿|万/g, '')) || 0;
  if (String(val).indexOf('万') !== -1) {
    num = num / 10000;
  }
  return sign * num;
};

export const formatDisplayTime = (timeStr) => {
  if (!timeStr) return '';
  if (timeStr.length >= 6) {
    return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
  }
  return timeStr;
};

const timeStrToMinutes = (timeStr) => {
  const h = parseInt(timeStr.substring(0, 2));
  const m = parseInt(timeStr.substring(2, 4));
  return h * 60 + m;
};

const minutesToTimeStr = (totalMin) => {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
};

// data: [[timeStr, { mainMoney, amountChangeDiff }], ...]（时间升序或乱序均可）
// 返回：时间升序的分桶数组 [{ time, displayTime, mainMoney, amountChangeDiff, rawTime }]
export const aggregateFundByInterval = (data, intervalMinutes = 5) => {
  if (!data || data.length === 0) return [];

  const sortedData = [...data].sort((a, b) => a[0].localeCompare(b[0]));

  const buckets = {};
  const tradingSlots = [];

  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;

  for (let t = morningStart + intervalMinutes; t <= morningEnd; t += intervalMinutes) {
    tradingSlots.push(t);
  }
  for (let t = afternoonStart + intervalMinutes; t <= afternoonEnd; t += intervalMinutes) {
    tradingSlots.push(t);
  }

  sortedData.forEach(([timeStr, item]) => {
    const totalMin = timeStrToMinutes(timeStr);
    let bucketMin = null;
    // 归属到「严格大于该时间的最近边界」对应的窗口：例如 13:20~13:24 计入标签 13:25
    for (const slot of tradingSlots) {
      if (totalMin < slot) {
        bucketMin = slot;
        break;
      }
    }
    if (bucketMin === null && tradingSlots.length > 0) {
      bucketMin = tradingSlots[tradingSlots.length - 1];
    }
    if (bucketMin !== null) {
      // 窗口内后点覆盖前点，取最后一条快照的累计净流入
      buckets[bucketMin] = { timeStr, item };
    }
  });

  const result = [];
  tradingSlots.forEach((slot) => {
    const entry = buckets[slot];
    const bucketTimeStr = minutesToTimeStr(slot);
    if (entry) {
      result.push({
        time: bucketTimeStr,
        displayTime: formatDisplayTime(bucketTimeStr),
        mainMoney: parseMoneyValue(entry.item.mainMoney),
        amountChangeDiff: parseMoneyValue(entry.item.amountChangeDiff),
        rawTime: entry.timeStr,
      });
    }
  });

  return result;
};