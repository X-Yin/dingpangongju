// ============================================================
// 冰点反弹-率先冲击n%（2026-11-28 用户新增；仅回测；独立引擎，n = 5 / 6 / 7 / 8）
// 2026-11-28 用户追加 4 条限制：
//   ① 触发时涨幅窗口 [n, n+3]：最多向上浮动 3 个点，超过 n+3 不能买——个股「率先达到 n%」那一刻
//     的涨幅若已 > n+3（含 9:30 开盘即 > n+3），该股整日不买，向后顺延其他股票；
//   ② 买点不严格按 5 分钟桶：候选股命中桶后向前回溯 1 分钟分时，取当日第一个涨幅达到 n% 的分钟
//     按该分钟分时价成交（模糊 1 分钟买点诊断）；买点时段仅限上午 9:30–11:30（2026-11-28 用户改：
//     下午不买——首个达标分钟出现在下午的候选整日不参与，也不阻塞上午候选的顺延）；
//   ③ 买入个股总市值（按当日股价折算）须 ≥ 300 亿元（2026-11-28 用户追加；口径修正说明：最初按
//     「所属板块整体市值」实现，但实测全部置顶板块整体市值均远超 300 亿（最小 mpo 1312 亿），无法
//     剔除华正新材（196 亿）这类小市值股——用户实际意图是个股市值门槛，故改为个股总市值口径）；
//   ④ 候选池不再是全量自选科技股，改为盯盘页「板块涨跌幅」置顶板块（PINNED_BLOCKS，与
//     BlockRankingCards / BlockChangeBoard 保持一致）的成分股 ∩ 当日自选股回放。
// 买点：前一交易日科技情绪指数（收盘 changeSumResult）≤ -20（情绪冰点）→ 次日就可以出手（9:30–13:30）。
// 卖点：与「3日涨幅最大&三日情绪-30快进快出」的通用卖点基本一致——复用通用卖点 hook
//       （generalSellPositions：通用 7 条件卖点 + 盘中大跌 -7% 强卖，T+1 买入当日不卖），
//       差异点（2026-11-28 用户改）：
//       ① 成本线止损阈值 costLinePct = 0——只要现价低于成本价就卖（不再等 -2%）；
//       ② 禁用「竞价低开自救窗口」（disableCostLineSelfRescue）——9:30 开盘价低于成本线即直接卖，
//         不再观察开盘拉升/回落；不含快进快出机制。全仓买入，单持仓（未卖出前不再买）。
// ============================================================
const { STRATEGIES } = require('../strategies/registry');
const { getTrainingCampDates, loadTrainingCampData, batchParallel, getStockCloseOnOrBefore, stockHighChangeAt, ensureBarsForCodes } = require('../deps');
const { buildReplayStocksWithTline, extractDailyInfo, isLimitUpAtBuy } = require('./replayData');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { passWatchlistGate } = require('./pickHelpers');
const { EXCLUDED_CODES } = require('../constants');
const { attachBuyDayReturn, calcDrawdownStats, sortTradesByBuyTime } = require('../utils/tradeStats');
const { round2 } = require('./extremeWinScores');
const { loadTlinePoints, clearTlineCache } = require('./extremeWinScores');
const { ensureBacktestValuation, getBacktestValuationMap, getValuationMap } = require('../../watchlistValuation');
const { getTechEmotionRawMap, getTechIndexDates } = require('../utils/techEmotion');
const blockCodeList = require('../../../constant/block_code').default || [];

const PREV_EMO_ICE_MAX = -20;        // 前一交易日科技情绪 ≤ -20（情绪冰点）→ 次日可出手
const BUY_TIME_MAX_MINUTE = 1130;    // 买入时段门禁：9:30 – 11:30（2026-11-28 用户改：买点只能出现在上午，下午的不买）
const BUY_TIME_MIN_MINUTE = 930;
const MAX_FLOAT_OVER_HIT = 3;        // 触发时涨幅最多向上浮动 3 个点：涨幅 > n+3 不能买（2026-11-28 用户追加）
const STOCK_MIN_TOTAL_MV_YI = 300;   // 买入个股总市值下限（亿元，2026-11-28 用户追加；口径为个股总市值而非板块整体市值）
const RECENT_EMO_OVER_MAX = 20;      // 往前数两个交易日内出现过科技情绪 ≥ 20 → 当日不能出手（2026-11-28 用户追加）
const RECENT_EMO_OVER_LOOKBACK = 2;  // 近端过热回看交易日数
const TRIGGER_EMO_MAX = 30;          // 触发买点那一刻盘中科技情绪 ≥ 30 → 该候选不买、顺延（2026-11-28 用户追加）

// 置顶板块（与盯盘页 BlockRankingCards / 训练营 BlockChangeBoard 保持一致；匹配时统一小写并去掉空格）。
// 回测候选池专用（2026-11-28 用户要求）：剔除「物理AI」「AI剧」两个板块——仅影响策略回测候选池，
// 盯盘页 / 训练营的置顶板块展示不受影响
const PINNED_BLOCKS = ['光通信', 'mpo', 'pcb', 'ccl', '电子布', '铜箔', '半导体', '国产超节点', '华为', '先进封装'];
const normBlockName = (name) => String(name || '').toLowerCase().replace(/\s+/g, '');
const PINNED_SET = new Set(PINNED_BLOCKS.map(normBlockName));

// 置顶板块成分索引（block_code 清单 → 板块名 → 成分股集合；个股代码 → 所属置顶板块名集合）
const pinnedBlockMembers = new Map(); // normBlockName -> { name, codes: Set<code> }
const codePinnedBlocks = new Map();   // code -> Set<原始板块名>
for (const item of blockCodeList) {
  if (!item || !item.code || !item.blockName) continue;
  if (!PINNED_SET.has(normBlockName(item.blockName))) continue;
  const key = normBlockName(item.blockName);
  if (!pinnedBlockMembers.has(key)) pinnedBlockMembers.set(key, { name: item.blockName, codes: new Set() });
  pinnedBlockMembers.get(key).codes.add(item.code);
  if (!codePinnedBlocks.has(item.code)) codePinnedBlocks.set(item.code, new Set());
  codePinnedBlocks.get(item.code).add(item.blockName);
}

const fmtMinute = (m) => (m != null
  ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`
  : '--');
const gainText = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

// 近端过热检查（2026-11-28 用户追加）：往前数两个交易日（T-1、T-2）的科技情绪指数收盘值，
// 任一日 ≥ 20 → 当日不能出手购买。数据缺失的日期跳过；两个交易日均无情绪数据时不拦截
// （返回 null = 数据不足；{ overheated: false } = 通过；{ overheated: true, ... } = 拦截并附明细）
const hasRecentEmotionOverheated = (dateStr) => {
  const raw = getTechEmotionRawMap();
  const dates = getTechIndexDates().filter((d) => d < String(dateStr)).sort();
  const recent = dates.slice(-RECENT_EMO_OVER_LOOKBACK);
  let checked = false;
  for (const d of recent) {
    const v = raw.get(d);
    if (v == null || !Number.isFinite(Number(v))) continue;
    checked = true;
    if (Number(v) >= RECENT_EMO_OVER_MAX) return { overheated: true, date: d, value: Number(v) };
  }
  return checked ? { overheated: false, recent } : null;
};

// 触发时点的盘中科技情绪：取「时间桶分钟 ≤ 触发分钟」的最近一个 5 分钟桶的 techEmotion
// （如 09:31 触发 → 取 09:30 桶情绪）；缺失返回 null（数据不足不拦截）
const buildBucketEmoList = (timeBuckets) => timeBuckets
  .map((b) => ({ minute: Number(b.minute), emo: b.techEmotion != null && !Number.isNaN(Number(b.techEmotion)) ? Number(b.techEmotion) : null }))
  .filter((x) => Number.isFinite(x.minute))
  .sort((a, b) => a.minute - b.minute);
const getTechEmotionAt = (bucketEmoList, minute) => {
  let emo = null;
  for (const x of bucketEmoList) {
    if (x.minute > minute) break;
    if (x.emo != null) emo = x.emo;
  }
  return emo;
};

// 个股「当下」总市值（元）：优先回测通用估值缓存 marketValue（财联社 mc，缺总市值的旧记录由
// ensureBacktestValuation 自动补拉），回退自选股估值快照 marketValue。均缺失返回 null
const totalMvNowOf = (code) => {
  const bt = getBacktestValuationMap().get(code);
  if (bt && Number.isFinite(Number(bt.marketValue)) && Number(bt.marketValue) > 0) {
    return Number(bt.marketValue);
  }
  const watch = getValuationMap().get(code);
  if (watch && Number.isFinite(Number(watch.marketValue)) && Number(watch.marketValue) > 0) {
    return Number(watch.marketValue);
  }
  return null;
};

// 个股总市值（亿元，按目标日股价折算：总股本近似不变、市值 ∝ 股价）：
//   当下总市值 ÷ 当下收盘价 × 目标日收盘价。估值或日K缺失返回 null（数据不足，不拦截——与其它过滤器口径一致）
// 2026-11-28 用户明确口径：按「个股」总市值 ≥ 300 亿过滤（只买中盘/权重股，不要小盘股），
//   而非板块整体市值——实测全部置顶板块整体市值均远超 300 亿（最小 mpo 1312 亿），按板块口径
//   华正新材（总市值 196 亿，属华为/CCL 板块）永远拦不住
const stockTotalMvYiAt = (code, dateStr) => {
  const mcNow = totalMvNowOf(code);
  if (mcNow == null) return null;
  const baseClose = getStockCloseOnOrBefore(code, 99999999);
  const targetClose = getStockCloseOnOrBefore(code, dateStr);
  if (!(baseClose > 0) || !(targetClose > 0)) return null;
  return round2((mcNow / baseClose) * targetClose / 1e8);
};

// 个股当日分时（1 分钟级，懒加载缓存；每日清空）——供「率先达到 n%」分钟回溯
const buildDayTlineCache = () => ({ map: new Map() });
const getDayTline = async (cache, code, dateNum) => {
  if (cache.map.has(code)) return cache.map.get(code);
  let pts = null;
  try {
    const t = await loadTlinePoints(code, dateNum);
    if (t && t.preclose > 0 && Array.isArray(t.points) && t.points.length > 0) {
      pts = {
        preclose: t.preclose,
        points: t.points
          .filter((p) => p && p.minute != null && p.lastPx > 0)
          .map((p) => ({
            minute: parseInt(p.minute, 10),
            lastPx: parseFloat(p.lastPx),
            pct: ((parseFloat(p.lastPx) - t.preclose) / t.preclose) * 100,
          }))
          .filter((p) => Number.isFinite(p.minute))
          .sort((a, b) => a.minute - b.minute),
      };
    }
  } catch (e) { /* 分时缺失按无候选处理 */ }
  cache.map.set(code, pts);
  return pts;
};

// 个股当日「第一个涨幅达到 n%」的分钟事件（9:30–13:30 内首次触及；返回 { minute, px, pct } 或 null）
const firstHitEventOf = (pts, hitPct) => {
  if (!pts) return null;
  for (const p of pts.points) {
    if (p.minute < BUY_TIME_MIN_MINUTE) continue;
    if (p.minute > BUY_TIME_MAX_MINUTE) break;
    if (p.pct >= hitPct) return { minute: p.minute, px: p.lastPx, pct: p.pct };
  }
  return null;
};

const buildBuyChecks = ({ prevTechEmotion, recentOver, hitPct, event, poolSize, skippedOverCap, skippedLimitUp, skippedStockCap, skippedTriggerEmo, stockCapYi, triggerEmo }) => [
  {
    id: 'ice_rebound_prev_ice',
    title: `前一交易日科技情绪 ≤ ${PREV_EMO_ICE_MAX}（情绪冰点）`,
    passed: true,
    value: `前一日科技情绪 ${Number(prevTechEmotion).toFixed(2)} ≤ ${PREV_EMO_ICE_MAX}`,
    reason: `取前一交易日科技情绪指数收盘值，≤ ${PREV_EMO_ICE_MAX} 视为情绪冰点，今日进入「冰点反弹」出手观察（9:30–11:30，仅上午；2026-11-28 用户改：下午不买）`,
  },
  {
    id: 'ice_rebound_recent_emo',
    title: `近两日无过热：往前数两个交易日科技情绪均 < ${RECENT_EMO_OVER_MAX}`,
    passed: true,
    value: recentOver && recentOver.overheated
      ? `${recentOver.date} 科技情绪 ${recentOver.value.toFixed(2)} ≥ ${RECENT_EMO_OVER_MAX}`
      : '近两个交易日科技情绪均低于阈值',
    reason: `往前数两个交易日（T-1、T-2）任一日科技情绪指数收盘值 ≥ ${RECENT_EMO_OVER_MAX} 即视为情绪已回暖/过热，当日不能出手购买（数据缺失的日期跳过，两日均无数据不拦截）`,
  },
  {
    id: 'ice_rebound_pool',
    title: '候选池：盯盘页板块涨跌幅「置顶板块」成分股',
    passed: true,
    value: `当日候选 ${poolSize} 只`,
    reason: `候选池 = 置顶板块（${PINNED_BLOCKS.join('、')}）成分股 ∩ 当日自选股回放，不再使用「全量自选科技股」口径；已剔除黑名单个股`,
  },
  {
    id: 'ice_rebound_first_hit',
    title: `选股：率先盘中涨幅达到 +${hitPct}%（1 分钟回溯买点）`,
    passed: true,
    value: `${fmtMinute(event.minute)} 首次触及 +${hitPct}%（涨幅 ${gainText(event.pct)}）`
      + (skippedOverCap.length > 0 ? `；超浮动顺延 ${skippedOverCap.map((x) => `${x.name}(${gainText(x.pct)})`).join('、')}` : '')
      + (skippedLimitUp.length > 0 ? `；涨停买不进顺延 ${skippedLimitUp.map((x) => `${x.name}(${gainText(x.pct)})`).join('、')}` : '')
      + (skippedStockCap.length > 0 ? `；总市值不足顺延 ${skippedStockCap.map((x) => `${x.name}(${x.reason})`).join('、')}` : ''),
    reason: `逐 1 分钟回溯分时，取个股当日第一个涨幅达到 +${hitPct}% 的分钟（不严格按 5 分钟桶成交）；跨个股取「首次触及最早」者（同分钟取涨幅更大者），被过滤的候选按触发先后向后顺延`,
  },
  {
    id: 'ice_rebound_float_cap',
    title: `触发涨幅窗口：+${hitPct}% ≤ 触发时涨幅 ≤ +${hitPct + MAX_FLOAT_OVER_HIT}%`,
    passed: true,
    value: `触发时涨幅 ${gainText(event.pct)}（≤ +${hitPct + MAX_FLOAT_OVER_HIT}%）`
      + (skippedTriggerEmo.length > 0 ? `；触发时情绪过热顺延 ${skippedTriggerEmo.map((x) => `${x.name}(${x.emo})`).join('、')}` : ''),
    reason: `最多向上浮动 ${MAX_FLOAT_OVER_HIT} 个点：个股「率先达到 +${hitPct}%」那一刻的涨幅若已 > +${hitPct + MAX_FLOAT_OVER_HIT}%（含 9:30 开盘即超过），该股整日不买、向后顺延其他股票；触发那一刻的盘中科技情绪 ≥ ${TRIGGER_EMO_MAX}（取触发分钟所在 5 分钟桶情绪）同样视为过热、该候选不买顺延（2026-11-28 用户追加；情绪数据缺失不拦截）`,
  },
  {
    id: 'ice_rebound_trigger_emo',
    title: `触发时盘中科技情绪 < ${TRIGGER_EMO_MAX}`,
    passed: true,
    value: `触发时盘中科技情绪 ${triggerEmo != null ? Number(triggerEmo).toFixed(1) : '--'}（< ${TRIGGER_EMO_MAX}）`,
    reason: `触发买点那一刻的盘中科技情绪（取触发分钟所在 5 分钟桶 techEmotion）≥ ${TRIGGER_EMO_MAX} 即视为情绪过热，该候选不买、向后顺延（2026-11-28 用户追加；情绪数据缺失时不拦截）`,
  },
  {
    id: 'ice_rebound_stock_cap',
    title: `个股总市值 ≥ ${STOCK_MIN_TOTAL_MV_YI} 亿（只买中盘/权重股）`,
    passed: true,
    value: stockCapYi != null ? `个股总市值 ${stockCapYi} 亿（按当日股价折算）` : '个股估值数据不足，顺延（严格口径）',
    reason: `买入个股自身总市值（按当日股价折算）须 ≥ ${STOCK_MIN_TOTAL_MV_YI} 亿，总市值不足或数据不足的候选均顺延下一只（2026-11-28 用户明确：按个股而非板块整体市值口径，只要中盘/权重股、不要小盘股）`,
  },
  {
    id: 'ice_rebound_not_limit_up',
    title: '涨停过滤：触发时未涨停（涨停价买不进）',
    passed: true,
    value: `触发时涨幅 ${gainText(event.pct)} 未达涨停阈值`,
    reason: '触发分钟已涨停（主板涨幅 > 9.5%、创业/科创板 > 19%）的候选整日不买、向后顺延',
  },
  {
    id: 'ice_rebound_full_position',
    title: '仓位：全仓直接买入',
    passed: true,
    value: `成交价 ${Number(event.px).toFixed(2)}，仓位 100%`,
    reason: '每次买入均全仓、单持仓，未卖出前不再买入其它股票；当日「率先达标」事件仅一次，正持仓错过则当日不再补买',
  },
];

const runIceReboundFirstHitBacktest = async (startDate, endDate, strategyId, onProgress, options = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.iceReboundFirstHitMode !== true) {
    return { success: false, message: `未知「冰点反弹-率先冲击」策略: ${strategyId}` };
  }
  const hitPct = Number(strategy.firstHitPct);
  if (!Number.isFinite(hitPct) || hitPct <= 0) {
    return { success: false, message: `「冰点反弹-率先冲击」策略配置错误（firstHitPct=${strategy.firstHitPct}）` };
  }
  const floatCapPct = hitPct + MAX_FLOAT_OVER_HIT;

  const allDates = getTrainingCampDates();
  const rangeDates = allDates.filter((d) => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) return { success: false, message: '所选日期范围内无可回测交易日' };

  const positions = [];       // 全仓单持仓（同一时间最多 1 只）
  const trades = [];          // 通用卖点 hook 记账（含盘中大跌强卖）
  const skippedDates = [];
  const seenStocks = new Map();
  const dailyInfos = new Map();

  for (let di = 0; di < total; di += 1) {
    const dateStr = rangeDates[di];
    const dateDisplay = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const dateNum = parseInt(dateStr, 10);
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });

    let campData;
    try {
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

    // 当日 EOD（供期末持仓按最近收盘价估算浮盈）；登记回测期间出现过的置顶板块候选股
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    const dayPool = new Map(); // code -> { name, changePct(最后桶) }
    for (const bucket of timeBuckets) {
      const minute = Number(bucket.minute);
      for (const sc of bucket.stockChanges || []) {
        if (!sc || !sc.code || EXCLUDED_CODES.has(sc.code)) continue;
        if (!codePinnedBlocks.has(sc.code)) continue; // 候选池 = 置顶板块成分股
        if (!passWatchlistGate(sc.code, dateStr, minute)) continue; // 防止后加自选股污染历史回测
        if (!dayPool.has(sc.code)) dayPool.set(sc.code, { name: sc.name || sc.code, changePct: null });
        dayPool.get(sc.code).name = sc.name || sc.code;
        if (sc.changePct != null) dayPool.get(sc.code).changePct = Number(sc.changePct);
      }
    }
    for (const [code, info] of dayPool) {
      if (!seenStocks.has(code)) seenStocks.set(code, { code, name: info.name });
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);

    // 买点门禁：前一交易日科技情绪指数 ≤ -20 → 次日可出手
    const prevTechEmotion = campData.prevDayTechEmotion != null && Number.isFinite(Number(campData.prevDayTechEmotion))
      ? Number(campData.prevDayTechEmotion)
      : null;
    // 近端过热门禁（2026-11-28 用户追加）：往前数两个交易日任一日科技情绪 ≥ 20 → 当日不能出手
    const recentOver = hasRecentEmotionOverheated(dateStr);
    if (recentOver && !Array.isArray(recentOver.recent)) {
      recentOver.recent = getTechIndexDates().filter((d) => d < String(dateStr)).sort().slice(-RECENT_EMO_OVER_LOOKBACK);
    }
    const gateOpen = prevTechEmotion != null && prevTechEmotion <= PREV_EMO_ICE_MAX
      && !(recentOver && recentOver.overheated === true);

    // 当日 1 分钟分时缓存（懒加载，每日清空控制内存）
    const dayTline = buildDayTlineCache();
    clearTlineCache();

    // ---- 确定当日「率先达标」事件序列：候选按「第一个达到 n% 的分钟」升序，逐个过滤（顺延）----
    // 候选 = 置顶板块候选池中「当日最高涨幅曾 ≥ n%（日K口径预筛；缺失时保守保留）」的个股
    let dayEvent = null; // { code, name, event: { minute, px, pct }, stockCapYi }
    let poolSize = 0;
    const skippedOverCap = [];
    const skippedLimitUp = [];
    const skippedStockCap = [];
    const skippedTriggerEmo = [];
    const bucketEmoList = buildBucketEmoList(timeBuckets);
    if (gateOpen && positions.length === 0 && dayPool.size > 0) {
      const potential = [];
      for (const [code, info] of dayPool) {
        const highChg = stockHighChangeAt(code, dateStr);
        if (highChg != null && Number.isFinite(Number(highChg)) && Number(highChg) < hitPct) continue; // 全天最高都没到 n%，不可能率先达标
        potential.push({ code, name: info.name });
      }
      poolSize = potential.length;
      if (potential.length > 0) {
        // 候选估值/日K预拉取（个股总市值门槛用）：候选池预筛对日K缺失的个股「保守保留」，
        // 但市值折算依赖日K（当下收盘价/目标日收盘价），不补齐会算出 null；
        // 市值门槛为严格口径（用户要求只买总市值 ≥ 300 亿），数据不足一律顺延
        try { await ensureBacktestValuation(potential.map((c) => c.code)); } catch (e) { /* 拉取失败按缺失处理 */ }
        try { await ensureBarsForCodes(potential.map((c) => c.code)); } catch (e) { /* 拉取失败按缺失处理 */ }
        // 仅对潜在候选加载 1 分钟分时并计算首个达标分钟
        await batchParallel(potential, async (c) => {
          c.pts = await getDayTline(dayTline, c.code, dateNum);
        }, 8);
        const events = [];
        for (const c of potential) {
          const ev = firstHitEventOf(c.pts, hitPct);
          if (ev) events.push({ code: c.code, name: c.name, event: ev });
        }
        // 触发先后排序（同分钟取涨幅更大者）
        events.sort((a, b) => (a.event.minute - b.event.minute) || (b.event.pct - a.event.pct));
        for (const cand of events) {
          // ① 涨幅窗口：触发那一刻涨幅 > n+3（含开盘即超过）→ 整日不买，顺延下一只
          if (cand.event.pct > floatCapPct) {
            skippedOverCap.push({ code: cand.code, name: cand.name, pct: round2(cand.event.pct) });
            continue;
          }
          // ② 涨停过滤：触发分钟已涨停（涨停价买不进）→ 顺延下一只
          if (isLimitUpAtBuy(cand.code, cand.event.pct)) {
            skippedLimitUp.push({ code: cand.code, name: cand.name, pct: round2(cand.event.pct) });
            continue;
          }
          // ③ 触发时盘中科技情绪 ≥ 30（2026-11-28 用户追加）：触发那一刻的盘中科技情绪已过热 → 该候选不买、顺延
          const triggerEmo = getTechEmotionAt(bucketEmoList, cand.event.minute);
          if (triggerEmo != null && triggerEmo >= TRIGGER_EMO_MAX) {
            skippedTriggerEmo.push({ code: cand.code, name: cand.name, emo: round2(triggerEmo), minute: cand.event.minute });
            continue;
          }
          // ④ 个股总市值 ≥ 300 亿（2026-11-28 用户明确：按「个股」总市值过滤，只买中盘/权重股，
          //    不要小盘股——华正新材总市值 196 亿、华胜天成 229 亿这类均拦住；总市值按当日股价折算；
          //    严格口径：市值数据不足的候选同样顺延，不放过未验证的小市值股）
          const stockCapYi = stockTotalMvYiAt(cand.code, dateStr);
          if (stockCapYi == null || stockCapYi < STOCK_MIN_TOTAL_MV_YI) {
            skippedStockCap.push({
              code: cand.code,
              name: cand.name,
              reason: stockCapYi != null ? `总市值${stockCapYi}亿` : '市值数据不足',
            });
            continue;
          }
          dayEvent = { ...cand, stockCapYi, triggerEmo };
          break; // 率先达标且通过全部过滤 → 当日事件确定
        }
      }
    }

    for (let bi = 0; bi < timeBuckets.length; bi += 1) {
      const bucket = timeBuckets[bi];
      const minute = Number(bucket.minute);

      // ---- 卖出（与「3日涨幅最大&三日情绪-30快进快出」通用卖点一致：通用 7 条件 + 盘中大跌强卖）----
      await generalSellPositions({ positions, strategy, bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades: trades });

      // ---- 买入：到达事件触发所在桶（事件分钟 ≤ 本桶分钟）且已空仓时，按回溯到的达标分钟价成交 ----
      if (!dayEvent || positions.length > 0) continue;
      if (!Number.isFinite(minute) || minute < dayEvent.event.minute) continue;
      if (minute < BUY_TIME_MIN_MINUTE || minute > BUY_TIME_MAX_MINUTE) continue;

      const { code, name, event, stockCapYi, triggerEmo } = dayEvent;
      const pos = {
        code,
        stockName: name,
        buyDate: dateStr,
        buyDateDisplay: dateDisplay,
        buyTime: fmtMinute(event.minute),
        buyPrice: round2(event.px),
        buyChange: round2(event.pct),
        metric: round2(event.pct),
        weight: 1,
        buyInfo: {
          prevTechEmotion,
          recentOver,
          hitPct,
          triggerMinute: event.minute,
          poolSize,
          skippedOverCap,
          skippedLimitUp,
          skippedStockCap,
          skippedTriggerEmo,
          stockCapYi,
          triggerEmo,
        },
      };
      pos.buyReason = `前一交易日科技情绪 ${prevTechEmotion.toFixed(2)} ≤ ${PREV_EMO_ICE_MAX}（情绪冰点）`
        + `，近两日科技情绪无过热（${(recentOver?.recent || []).map((d) => `${d}:${getTechEmotionRawMap().get(d) != null ? Number(getTechEmotionRawMap().get(d)).toFixed(1) : '--'}`).join('、') || '数据不足'} 均 < ${RECENT_EMO_OVER_MAX}）`
        + `，置顶板块候选 ${name} 于 ${fmtMinute(event.minute)} 率先盘中涨幅达到 +${hitPct}%（${gainText(pos.buyChange)} ≤ +${floatCapPct}%）`
        + `${triggerEmo != null ? `，触发时盘中科技情绪 ${Number(triggerEmo).toFixed(1)} < ${TRIGGER_EMO_MAX}` : ''}`
        + `${stockCapYi != null ? `，个股总市值 ${stockCapYi} 亿 ≥ ${STOCK_MIN_TOTAL_MV_YI} 亿（只买中盘/权重股）` : ''}`
        + `，按 1 分钟回溯价 ${pos.buyPrice.toFixed(2)} 全仓买入`
        + `${skippedOverCap.length > 0 ? `；超浮动顺延 ${skippedOverCap.map((x) => x.name).join('、')}` : ''}`
        + `${skippedLimitUp.length > 0 ? `；涨停顺延 ${skippedLimitUp.map((x) => x.name).join('、')}` : ''}`
        + `${skippedTriggerEmo.length > 0 ? `；触发时情绪过热顺延 ${skippedTriggerEmo.map((x) => `${x.name}(${x.emo})`).join('、')}` : ''}`
        + `${skippedStockCap.length > 0 ? `；总市值不足顺延 ${skippedStockCap.map((x) => `${x.name}(${x.reason})`).join('、')}` : ''}`
        + `；卖点与「3日涨幅最大&三日情绪-30快进快出」通用卖点基本一致（差异：跌破成本价即卖，costLinePct=0）`;
      pos.buyChecks = buildBuyChecks({ prevTechEmotion, recentOver, hitPct, event, poolSize, skippedOverCap, skippedLimitUp, skippedStockCap, skippedTriggerEmo, stockCapYi, triggerEmo });
      positions.push(pos);
      dayEvent = null; // 当日事件已消费（单持仓买入后不再评估）
    }
  }

  // ---- 组装结果 ----
  const currentHoldings = [];
  for (const pos of positions) {
    const h = { ...pos };
    let closePx = null;
    for (let i = rangeDates.length - 1; i >= 0; i -= 1) {
      const info = dailyInfos.get(rangeDates[i])?.get(pos.code);
      if (info && info.closePx != null && info.closePx > 0) { closePx = info.closePx; break; }
    }
    h.buyReturn = closePx != null && pos.buyPrice > 0
      ? round2(((closePx - pos.buyPrice) / pos.buyPrice) * 100)
      : null;
    h.rawBuyReturn = h.buyReturn;
    currentHoldings.push(h);
  }

  // 全仓单持仓：逐笔复利即等价账户口径；期末持仓按最近收盘价估算浮盈一并折算
  const overallReturn = (() => {
    let acc = 1;
    for (const t of trades) {
      if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
    }
    for (const h of currentHoldings) acc *= 1 + (h.buyReturn || 0) / 100;
    return round2((acc - 1) * 100);
  })();

  const validTrades = trades.filter((t) => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter((t) => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (currentHoldings.length > 0) await attachBuyDayReturn(currentHoldings);

  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades: sortTradesByBuyTime(trades),
    currentHolding: currentHoldings[0] || null,
    currentHoldings,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: currentHoldings.length > 0,
    },
  };
};

module.exports = { runIceReboundFirstHitBacktest };
