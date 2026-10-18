// 买点诊断 5 分钟时间桶标签（严格对齐回测口径）
// 回测桶骨架来自资金快照 fundSnapshot.aggregateByInterval（server/src/service/fundSnapshot.js L48-103）：
//   上午从 9:30+5=9:35 起、到 11:30；下午从 13:00+5=13:05 起、到 15:00；步长 5 分钟，向前归属。
// 合法标签唯一集合即 9:35..11:30 与 13:05..15:00（无 9:30 / 13:00 桶，与前端原本的 minute%5===0 含 9:30 不同）。
// 说明：本文件只使用「标签集合」，不复制 fundSnapshot 的归属 quirk，避免改动该敏感文件造成回归。
const MORNING_START = 9 * 60 + 30; // 570  9:30
const MORNING_END = 11 * 60 + 30; // 690 11:30
const AFTERNOON_START = 13 * 60; // 780 13:00
const AFTERNOON_END = 15 * 60; // 900 15:00
const INTERVAL = 5;

const buildLabels = () => {
  const labels = [];
  for (let t = MORNING_START + INTERVAL; t <= MORNING_END; t += INTERVAL) labels.push(t);
  for (let t = AFTERNOON_START + INTERVAL; t <= AFTERNOON_END; t += INTERVAL) labels.push(t);
  return labels;
};

const TRADING_BUCKET_LABELS = buildLabels();

// 返回全部合法桶标签（「自 0 点起的分钟数」，与 fundSnapshot 的 slot 表示完全一致）
//   例如 575=9:35、580=9:40、690=11:30、785=13:05、900=15:00；共 24（上午）+ 24（下午）= 48 个
const getTradingBucketLabels = () => TRADING_BUCKET_LABELS.slice();

// 当前时刻「最近一个已闭合的桶标签」（即 ≤ 当前分钟的最大标签）；9:35 之前返回 null（无已闭合桶）
//   语义与 fundSnapshot.aggregateByInterval 的归属一致：标签为该窗口的结束边界，
//   如 9:36 时最近闭合的是标签 575（9:35，覆盖 9:30~9:34 的窗口）
const getCurrentClosedBucket = (date = new Date()) => {
  const minutes = date.getHours() * 60 + date.getMinutes();
  let label = null;
  for (const t of TRADING_BUCKET_LABELS) {
    if (t <= minutes) label = t;
    else break;
  }
  return label;
};

module.exports = { TRADING_BUCKET_LABELS, getTradingBucketLabels, getCurrentClosedBucket };
