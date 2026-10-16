const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  calculateResilience,
  getLeaderPool,
  getLimitTypeByCode,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  hasRecentVolumeSurge,
  loadTrainingCampData,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { buildWindowAxis, injectSimStocksIntoCampData } = require('./pickHelpers');
const {
  CYB_INDEX_CODE,
  ICE_SIGNAL_INDEX_NAME,
  STAR_INDEX_CODE,
  annotateIndexGateChecksWithStock,
  getIceMa3Slope,
  getIceMa3SlopeIntraday,
  precomputeTurnMap,
  withDualGateInfo,
} = require('./indexGate');
const { EXCLUDED_CODES } = require('../constants');
const { buildPrevOneWordBoardSet, buildReplayStocksWithTline, extractDailyInfo } = require('./replayData');
const { buildBuyReasonFromDiag, fmtTime, runBuyPointDiagnosis } = require('../diagnose/buyPoint');
const { withResilienceGateInfo } = require('./checkBuilders');
const { buildCounterCycSet } = require('./cycleFilter');
const { pickBestStock } = require('./pickBest');
const { emoQuickOutSell } = require('./sellHooks/emoQuickOut');
const { generalSellPositions } = require('./sellHooks/generalSell');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');

// 情绪游资-龙头战法（2026-10-11 用户新增；2026-10-11 二次改版：合并为单一「板块口径」策略）：
//   选股 = 过去 10 个交易日内掀起涨停潮（涨停个股数 >= 20）的板块（剔除 芯片/通信/算力/其他/中报增长，候选池仅保留主板）；
//          候选池两次过滤：① 最近 5 个交易日内须出现过一次放量（成交量较前一交易日 ≥ +200%，即 ≥ 前一日 × 3，且该放量日须为从放量之日起往前回溯 10 个交易日内的量能最大日，且该放量日不得是该股的首板或二板[当日连板数 ≠ 1、2]），否则跳过；② 自板块爆发日以来涨幅须处 10%~30%；
//          再选「板块内最优个股自爆发以来涨幅最高」的板块，
//          在该板块内买「自板块爆发日以来涨幅最大」的那只；板块内无符合个股则本次不买；
//          买点触发门槛：买点触发时龙头（拟买那只）当日实时涨幅 < -8% 则该股剔除、不买（当日大跌、追买风险高；顺延买入同样适用，次日 9:30 大跌 < -8% 则放弃顺延）；
//          若涨幅第 1 已涨停 → 买涨幅第 2；若第 2 也涨停 → 顺延到次日 9:30 买涨幅第 2 那只（仍涨停则继续顺延）。
//   买点 = 上证指数 3 日线斜率**盘中由负转正**的当桶出手（择时提高胜率）；顺延买点在次日 9:30 且斜率仍为正时执行；
//   卖点 = 持仓股跌破成本线 -5% 且连续维持 ≥5 分钟（止损，防瞬时假跌破）∪ 持仓股跌停（较昨收 <-9%）∪ 高位放量大阴线（当日最高回落 > 8% 且现价 < 开盘）
//          ∪ 弱势持仓时限（持仓第 3 个交易日[含买入当日为第 1 天]尾盘 14:57 收益仍未拉开至 +10% 即卖出）
//          ∪ 竞价低开（开盘价较昨收低开 < -5% 时按开盘价卖出）
//          ∪ 收盘抗分歧指数（当日收盘抗分歧分数 < 6 即尾盘卖出）
//          ∪ 盘中分时跌幅（较昨收 ≤ -5% 直接卖出，不设持续性门槛）
//          ∪ 开盘后直线下挫（自 9:30 开盘起，现价较当日开盘价跌幅 ≤ -5%，不管当前较昨收涨幅如何，直接卖出；2026-10-16 用户新增）。
//   价格类卖点（⑤竞价低开 / ①成本线止损 / ②跌停 / ⑦昨收跌幅 / ⑧开盘跌幅 / ③高位大阴线）均按**分钟级回溯**成交：
//   自 9:30 逐分钟扫描分时，取「最先触发」的那一分钟的分钟与分时价精准卖出（不再只按 5min 桶时点价成交）。
//   买入次日起生效；当日买入次日才可卖；当日卖出后当日不再追买。半仓，每笔用当前总资金 50% 逐笔复利（整体收益 = 期末总资产 ÷ 本金 − 1）。
//
// 情绪龙头+科技进攻（leaderTechCombo: true，2026-10-12 用户新增；走本引擎的组合分支）：
//   在「情绪游资-龙头战法」基础上叠加「3日涨幅最大&三日情绪-60快进快出」的独立买点，两者共用一个单持仓账户
//   （①情绪游资按半仓计收益[权重 0.5]、②快进快出按全仓计收益[权重 1]）：
//   空仓时逐桶判定：同一桶两套买点同时触发 → 先买情绪游资（①龙头战法）；非同时触发 → 谁先触发买谁（先成交即持仓）；
//   卖点各用各的：①情绪游资仓位走龙头战法 8 条卖点；②快进快出仓位走快进快出卖点（次日 10:00 强卖 / 盘中 -2% 止损 / 否则通用 7 条件）；
//   当日卖出仅禁止同路再买：快进快出强卖/止损当日仅②那路不再买入（①仍可出手）；①卖出当日仅①那路不再追买（②仍可出手）。
const LEADER_TECH_EMOQUICK_ID = 'highest_3d_gain_emoquick'; // 组合②路：快进快出买点/卖点直接复用该策略口径
const LEADER_LOOKBACK_DAYS = 10;        // 回溯窗口：过去 10 个交易日
const LEADER_MIN_LIMIT_UP_COUNT = 20;   // 涨停潮门槛：板块涨停个股数 >= 20
const LEADER_EXCLUDED_BOARDS = ['芯片', '通信', '算力', '其他', '中报增长']; // 整体剔除的板块（不触发候选、成分股不计入候选池）
const LEADER_MIN_BOARD_GAIN_PCT = 10;   // 买入门槛下限：自板块爆发日以来涨幅 < 10% 的个股剔除（无爆发动能）
const LEADER_MAX_BOARD_GAIN_PCT = 30;   // 买入门槛上限：自板块爆发日以来涨幅 > 30% 的个股剔除（已透支）
const LEADER_MAX_BUY_DROP_PCT = -8;     // 买点触发门槛：买点触发时龙头当日实时涨幅 < -8% 则不买（当日大跌、追买风险高）
const LEADER_VOLUME_LOOKBACK_DAYS = 5;  // 放量分歧窗口：最近 5 个交易日内须出现过一次放量
const LEADER_VOLUME_SURGE_PCT = 200;    // 放量门槛：某日成交量较前一交易日增加 ≥ 200%（即 ≥ 前一日 × 3）即视为放量
const LEADER_VOLUME_PEAK_DAYS = 10;     // 放量须为峰值：从放量之日起往前回溯 10 个交易日（含放量当日）内量能最大的一天
const MAIN_BOARD_LIMIT_UP_PCT = 9.5;    // 涨停判定（候选池仅主板，涨幅 > 9.5%）
// 价格类卖点门槛（止损 -5%/持续 5min、跌停 -9%、昨收跌幅 -5%、开盘跌幅 -5%、高位回落 8%、竞价低开 -5%）
// 统一由 ./leaderSellMinute.scanLeaderPriceSell 内部持有，本引擎不再重复定义
const WEAK_TRADE_HOLD_DAYS = 3;         // 弱势持仓时限：持仓第 3 个交易日（含买入当日为第 1 天）
const WEAK_TRADE_MIN_GAIN_PCT = 10;     // 收益门槛：到第 3 个交易日尾盘收益仍未拉开至 +10% 即卖出
const TAIL_MINUTE = 1457;               // 尾盘判定分钟（未覆盖 14:57 时回退当日最后一分钟）
const RESILIENCE_SELL_MAX = 6;          // 收盘抗分歧指数卖出门槛：当日收盘抗分歧分数 < 6 即卖出
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001'; // 抗分歧跟踪指数：候选池仅主板，统一跟踪上证指数

// 剔除科创板（688）/ 创业板（300/301）个股，只保留主板标的
const isStarOrChiNext = (code) => /^(30|688)/.test(String(code).replace(/^(sh|sz|bj)/i, ''));

// 价格类卖点的分钟级回溯统一走 ./leaderSellMinute.scanLeaderPriceSell

// 个股分时点缓存：`${code}|${dateNum}` -> { preclose, points:[{minute,lastPx,change}] }（升序，过滤无效价）
// 每个交易日开始前清空，避免整轮回测累积占用内存
const tlineCache = new Map();
const loadTlinePoints = async (code, dateNum) => {
  const key = `${code}|${dateNum}`;
  if (tlineCache.has(key)) return tlineCache.get(key);
  let res = { preclose: null, points: [] };
  try {
    const t = await getSingleStockTlineDataByDate(code, dateNum);
    res = {
      preclose: t?.preclose_px != null ? parseFloat(t.preclose_px) : null,
      points: (t?.line || [])
        .filter(p => p && p.minute != null && p.last_px != null)
        .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
        .filter(p => p.lastPx > 0)
        .sort((a, b) => a.minute - b.minute),
    };
  } catch (e) { /* 拉取失败返回空 */ }
  tlineCache.set(key, res);
  return res;
};

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');

// 个股分时点是否已封涨停（买不进）：候选池仅主板，涨幅 > 9.5% 即视为涨停
const isLimitUpAtBucket = (changePct) => {
  if (changePct == null || !Number.isFinite(changePct)) return false;
  return changePct > MAIN_BOARD_LIMIT_UP_PCT;
};

// 取分时中 minute <= 目标分钟的最后一点
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};

const runLeaderBacktest = async (startDate, endDate, strategyId, onProgress, opts = {}) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.leaderMode !== true) {
    return { success: false, message: `未知龙头战法策略: ${strategyId}` };
  }
  const combo = strategy.leaderTechCombo === true; // 情绪龙头+科技进攻 / 科技进攻+情绪龙头：叠加②快进快出买点/卖点
  const techFirst = strategy.techFirst === true;   // 科技进攻+情绪龙头：反优先级（同一桶②优先、持仓①龙头时②触发立即切换卖出）
  // ①情绪龙头仓位权重：一律半仓（占当前总资金 50%，逐笔复利滚动）——纯「情绪游资-龙头战法」自 2026-10-16 起改按半仓计收益：
  // 每笔用当前总资产的 50%（本金 100 → 首笔买 50；赚 20% 后总资产 110 → 次笔买 55 ……），整体收益 = 期末总资产 ÷ 本金 − 1。
  // 组合策略下①半仓、②科技进攻仍按全仓。逐笔复利口径下即为账户真实收益。
  // opts.weight 可显式覆盖（「情绪游资-精准择时」把仓位 A 按半仓 0.5 跑）。
  const leaderWeight = (opts && opts.weight != null && Number.isFinite(Number(opts.weight)))
    ? Number(opts.weight)
    : 0.5;
  // 不依赖资金快照：日期序列并入 tech_index 覆盖的交易日（补上缺资金快照的日期）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }
  const dailyInfos = new Map(); // date -> Map<code, {changePct, closePx, resilience}>
  // 预热起始日前 10 个交易日 EOD，保证起点附近期末估值与窗口一致
  // （组合②路复用「3日涨幅最大」选股，窗口用 di + axisOffset 在 dateAxis 上切片，需要 axisOffset；
  //  同时复用「指数由负转正当日个股 MA3 正斜率连续天数 > 4 顺延」过滤——该过滤最多回溯 10 个收盘日，
  //  预热不足 10 天会因数据不足而静默放行，导致②路选股与独立「3日涨幅最大」策略不一致，故取 10 与 rangeBacktest 对齐）
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, 10, dailyInfos);

  // 组合②路（快进快出）：跨指数双门禁预计算（创业板指 sz399006 + 科创50 sh000688）与运行态；
  // 组合策略 id 未落在 CYB_GATE_EXCLUDE_PREFIX 内，天然属于双门禁适用集合，此处显式预计算
  let cybGatePrecomputed = null, starGatePrecomputed = null;
  const cybGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  const starGateRuntimeState = { lastPosTurnDate: null, lastNegTurnDate: null };
  if (combo) {
    try {
      [cybGatePrecomputed, starGatePrecomputed] = await Promise.all([
        precomputeTurnMap(CYB_INDEX_CODE, rangeDates),
        precomputeTurnMap(STAR_INDEX_CODE, rangeDates),
      ]);
    } catch (e) {
      cybGatePrecomputed = null; starGatePrecomputed = null;
    }
  }

  // 斜率符号初值（回测首日前一交易日收盘口径）：仅用于判定当日是否走「前一交易日已为正 → 9:40 买」通道
  let lastSlopeSign = null;
  try {
    const seed = await getIceMa3Slope(dateAxis[0]);
    if (seed != null && Number.isFinite(Number(seed))) lastSlopeSign = seed > 0 ? 1 : -1;
  } catch (e) { /* 无初值，首个有效斜率桶建立基准 */ }

  let position = null; // 单股持仓（组合策略下 position.branch = 'leader' | 'emoquick' 区分①/②路）
  let lastSellDate = null; // ①情绪游资路：卖出当日不再追买（仅约束①，不影响②）
  let quickOutSoldDate = null; // ②快进快出路：强卖/止损当日不再买入（仅约束②，不影响①）
  let pendingBuy = null; // 顺延买点：板块内涨幅前两名均涨停时，次日 9:30 买入的目标

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
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
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    const hasTailBucket = timeBuckets.some(b => Number(b.minute) >= TAIL_MINUTE); // 当日是否有 14:57 之后的桶

    // 组合②路：注入随机模拟合成股票 + 构建带分时的回放股票表
    // （「3日涨幅最大」选股 pickBestStock 与快进快出卖点 hook 都依赖 replayStocks）
    let replayStocks = null;
    if (combo) {
      await injectSimStocksIntoCampData(campData, dateStr);
      replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    }

    const dateNum = parseInt(dateStr, 10);

    // 当日涨停潮板块（过去 10 个交易日掀起过涨停潮的板块；芯片/通信/算力/其他/中报增长 已剔除；候选池仅保留主板）
    let boardList = [];
    let hotBoardsText = '无';
    try {
      const poolInfo = await getLeaderPool(dateStr, LEADER_LOOKBACK_DAYS, LEADER_MIN_LIMIT_UP_COUNT, LEADER_EXCLUDED_BOARDS);
      // eligible = 非黑名单 + 有基准价 + 仅主板 + 最近 5 个交易日出现过一次放量（成交量较前一交易日 ≥ +200%，且该放量日须为从放量之日起往前回溯 10 个交易日内的量能最大日，且该放量日不得是该股的首板或二板），否则跳过
      const eligible = (p) => !EXCLUDED_CODES.has(p.code) && p.base > 0 && !isStarOrChiNext(p.code)
        && hasRecentVolumeSurge(p.code, dateStr, LEADER_VOLUME_LOOKBACK_DAYS, LEADER_VOLUME_SURGE_PCT, LEADER_VOLUME_PEAK_DAYS);
      boardList = (poolInfo.boards || [])
        .map(b => ({ ...b, stocks: b.stocks.filter(eligible) }))
        .filter(b => b.stocks.length > 0);
      hotBoardsText = Array.from(new Set((poolInfo.hotBoards || []).map(b => b.board))).join('、') || '无';
    } catch (e) { /* 保持空池 */ }
    const poolCodes = Array.from(new Set(boardList.flatMap(b => b.stocks.map(s => s.code))));
    const poolTotal = boardList.reduce((n, b) => n + b.stocks.length, 0);

    // 当日分时（清空跨日缓存，逐日重建，控制内存）
    tlineCache.clear();
    const poolTline = new Map(); // code -> { preclose, points }
    let poolLoaded = false;
    const ensurePoolTlines = async () => {
      if (poolLoaded) return;
      poolLoaded = true;
      await batchParallel(poolCodes, async (code) => {
        poolTline.set(code, await loadTlinePoints(code, dateNum));
      }, 8);
    };

    // 隔夜持仓当日分时（用于止损/跌停卖出；仅①情绪游资路用本引擎的 7 条卖点，②快进快出路走 hook）
    let posTline = null;
    if (position && (!combo || position.branch === 'leader') && dateStr > position.buyDate) {
      posTline = await loadTlinePoints(position.code, dateNum);
    }

    // 持仓股当日收盘抗分歧指数（卖出规则⑥用；懒计算，持仓股不在回放池内故需现算）
    let posResilience = null;
    let posResilienceLoaded = false;
    const ensurePosResilience = async () => {
      if (posResilienceLoaded) return posResilience;
      posResilienceLoaded = true;
      if (!position) return null;
      try {
        const [stockT, indexT] = await Promise.all([
          getSingleStockTlineDataByDate(position.code, dateNum),
          getSingleStockTlineDataByDate(LEADER_RESILIENCE_INDEX_CODE, dateNum),
        ]);
        const stockLine = stockT?.line || [];
        const indexLine = indexT?.line || [];
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const s = calculateResilience(indexLine, stockLine, getLimitTypeByCode(position.code));
          if (s != null && Number.isFinite(Number(s))) posResilience = parseFloat(Number(s).toFixed(2));
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResilience;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 组合②路专属卖点（每日桶循环前评估一次）：次日 10:00 强制卖出 + 盘中跌破成本线 -2% 先到先卖 + 强卖豁免
    // （见 sellHooks/emoQuickOut.js）。返回强卖/止损日期 → 当日禁止②路二次买入（仅约束②，①路不受影响）；
    // 若②路为普通持仓（非快进快出）则不在此处理，改由桶内通用 7 条件卖点接管
    if (combo && position && position.branch === 'emoquick') {
      const soldDate = emoQuickOutSell({
        positions: [position],
        strategy: { costLinePct: undefined, twoBuy: false },
        dateStr, dateDisplay, replayStocks, timeBuckets, campData, singleTrades: trades,
      });
      if (soldDate) {
        quickOutSoldDate = soldDate;
        position = null;
      }
    }

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1; // 尾盘桶
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);
      const slopeNow = await getIceMa3SlopeIntraday(dateStr, bucketMinute);
      const slopePositive = slopeNow != null && Number.isFinite(Number(slopeNow)) && slopeNow > 0;
      // 买点通道：上证 3 日线斜率「盘中由负转正」的当桶（择时提高胜率）
      const turnedPos = slopePositive && (lastSlopeSign == null || lastSlopeSign <= 0);

      // 组合②路买入逻辑（函数化，便于按优先级分别在①前/①后调用）：按「3日涨幅最大&三日情绪-60快进快出」
      // 买点出手，命中则返回新持仓对象（branch='emoquick'）并登记 seenStocks，未命中返回 null。
      const tryEmoQuickBuy = async () => {
        const buyDiag = runBuyPointDiagnosis(timeBuckets, bi, campData)?.data;
        if (buyDiag?.allPassed !== true) return null;
        const buyInfo = buildBuyReasonFromDiag(buyDiag);
        // 跨指数双门禁（创业板指 + 科创50）：②路沿用「3日涨幅最大」系列的门禁口径
        const { gatedBuyInfo, gatePassed, gateAllowedMarkets, gateTurnedPosInfo } = await withDualGateInfo(
          buyInfo, LEADER_TECH_EMOQUICK_ID, dateStr, bucketMinute,
          { cybPrecomputed: cybGatePrecomputed, starPrecomputed: starGatePrecomputed, cybRuntime: cybGateRuntimeState, starRuntime: starGateRuntimeState },
        );
        if (!gatePassed) return null;
        // 上一交易日一字板过滤 + 顺/逆周期过滤（②路属「N日涨幅最大系列」适用策略）
        const prevOneWordSet = await buildPrevOneWordBoardSet((bucket.stockChanges || []).map(s => s.code), dateStr);
        const emoCycSet = await buildCounterCycSet((bucket.stockChanges || []).map(s => s.code), dateStr);
        const picked = pickBestStock(new Map(), dateAxis, di + axisOffset, bucket, replayStocks, dailyInfos, LEADER_TECH_EMOQUICK_ID, axisOffset, gateAllowedMarkets, gateTurnedPosInfo, prevOneWordSet, emoCycSet);
        if (!picked) return null;
        // picked.emoQuickOut 已由委派层（delegates.js）按快进快出条件附着，须在 withResilienceGateInfo 之前读取
        const finalBuyInfo = withResilienceGateInfo(gatedBuyInfo, picked);
        const sc = picked.stock;
        const pos = {
          code: sc.code,
          stockName: sc.name || sc.code,
          branch: 'emoquick',
          buyDate: dateStr,
          buyDateDisplay: dateDisplay,
          buyTime: timeText, // 归一化 HH:MM（与桶时间一致）
          buyPrice: parseFloat(Number(sc.lastPx).toFixed(2)),
          buyChange: sc.changePct != null ? parseFloat(Number(sc.changePct).toFixed(2)) : null,
          metric: picked.metric,
          buyReason: finalBuyInfo.buyReason,
          buyChecks: annotateIndexGateChecksWithStock(finalBuyInfo.buyChecks, sc.code, sc.name),
          emoQuickOut: picked.emoQuickOut || null, // 快进快出标注：quickOut=true → 次日 10:00 强卖；否则走通用 7 条件
          buyDi: di,
        };
        if (!seenStocks.has(pos.code)) seenStocks.set(pos.code, { code: pos.code, name: pos.stockName });
        return pos;
      };

      // ===== ①情绪游资路卖出（仅隔夜持仓；组合策略下仅对 branch==='leader' 生效）=====
      if (position && (!combo || position.branch === 'leader') && dateStr > position.buyDate && posTline && posTline.points.length > 0) {
        const atPt = priceAtMinute(posTline.points, bucketMinute);
        if (atPt && atPt.lastPx > 0) {
          const px = atPt.lastPx;
          const preclose = posTline.preclose;
          const changePct = preclose && preclose > 0
            ? parseFloat((((px - preclose) / preclose) * 100).toFixed(2))
            : (atPt.change != null ? atPt.change : null);
          // 成本线收益率（相对买入价）
          const costReturn = position.buyPrice > 0
            ? parseFloat((((px - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
            : null;

          let sellReason = null;
          let sellMinute = atPt.minute; // 默认按当前桶时点成交（④⑥属尾盘时点卖点）
          let sellPx = px;
          let sellChange = changePct;

          // 价格类卖点（⑤竞价低开 / ①成本线止损 / ②跌停 / ⑦昨收跌幅 / ⑧开盘跌幅 / ③高位大阴线）：
          // 分钟级回溯——自 9:30 起逐分钟扫描分时，取「最先触发」的那一分钟的分钟与分时价精准卖出
          // （不再只按当前 5min 桶时点价判定，避免 9:35 桶破位却在 9:31 就已触发时卖晚）。
          const priceHit = scanLeaderPriceSell({
            points: posTline.points,
            preclose,
            buyPrice: position.buyPrice,
            cutoffMinute: bucketMinute,
          });
          if (priceHit) {
            sellReason = priceHit.reason;
            sellMinute = priceHit.minute;
            sellPx = priceHit.px;
            sellChange = priceHit.changePct;
          }

          // ④ 弱势持仓时限：持仓第 3 个交易日（含买入当日为第 1 天）尾盘收益仍未拉开至 +10% → 卖出
          if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
            if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
              sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
            }
          }

          // ⑥ 收盘抗分歧指数 < 6：当日尾盘（收盘）抗分歧分数低于阈值即卖出
          //（抗分歧分数现算：跟踪指数统一取上证指数，与候选池仅主板一致）
          if (!sellReason && isTailBucket) {
            const res = await ensurePosResilience();
            if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
              sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
            }
          }

          if (sellReason) {
            const rawReturnRate = position.buyPrice > 0
              ? parseFloat((((sellPx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
              : null;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              board: position.board,
              base: position.base,
              baseDate: position.baseDate,
              positionMode: 'offense',
              weight: leaderWeight,
              buyDate: position.buyDate,
              buyDateDisplay: position.buyDateDisplay,
              buyTime: position.buyTime,
              buyPrice: position.buyPrice,
              buyChange: position.buyChange,
              buyReason: position.buyReason,
              buyChecks: position.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: fmtMinute(sellMinute),
              sellPrice: parseFloat(sellPx.toFixed(2)),
              sellChange,
              sellReason: `${sellReason}，情绪游资-龙头战法持仓卖出（${leaderWeight === 0.5 ? '半仓' : '全仓'}）`,
              returnRate: rawReturnRate != null ? parseFloat((rawReturnRate * leaderWeight).toFixed(2)) : null,
              rawReturnRate,
            });
            position = null;
            lastSellDate = dateStr; // 卖出后当日不再追买（等次日再看）
          }
        }
      }

      // ===== 反优先级（科技进攻 + 情绪龙头，techFirst）：②路优先，排在①买入块之前 =====
      //   ①持仓情绪龙头（隔夜）时，②买点触发 → 立刻按当桶分时价卖出龙头、改买②选中的股票（强制切换）；
      //   ②空仓时，②买点触发 → 直接买入②（与①同一桶同时触发时先买②）；
      //   处理完 position 即被占用，①顺延/买入块因 !position 天然不再出手。
      //   当日②路已强卖/止损（quickOutSoldDate === dateStr）时不再切换、不再买入。
      if (combo && techFirst && quickOutSoldDate !== dateStr) {
        if (position && position.branch === 'leader' && dateStr > position.buyDate && posTline && posTline.points.length > 0) {
          const atPt = priceAtMinute(posTline.points, bucketMinute);
          if (atPt && atPt.lastPx > 0) {
            const emoPick = await tryEmoQuickBuy();
            if (emoPick) {
              const px = atPt.lastPx;
              const preclose = posTline.preclose;
              const changePct = preclose && preclose > 0
                ? parseFloat((((px - preclose) / preclose) * 100).toFixed(2))
                : (atPt.change != null ? atPt.change : null);
              const rawReturnRate = position.buyPrice > 0
                ? parseFloat((((px - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
                : null;
              trades.push({
                seq: trades.length + 1,
                metric: position.metric,
                code: position.code,
                stockName: position.stockName,
                board: position.board,
                base: position.base,
                baseDate: position.baseDate,
                positionMode: 'offense',
                weight: leaderWeight,
                buyDate: position.buyDate,
                buyDateDisplay: position.buyDateDisplay,
                buyTime: position.buyTime,
                buyPrice: position.buyPrice,
                buyChange: position.buyChange,
                buyReason: position.buyReason,
                buyChecks: position.buyChecks,
                sellDate: dateStr,
                sellDateDisplay: dateDisplay,
                sellTime: fmtMinute(atPt.minute),
                sellPrice: parseFloat(px.toFixed(2)),
                sellChange: changePct,
                sellReason: `科技进攻（②快进快出）买点盘中触发，立即切换卖出情绪游资-龙头持仓（${leaderWeight === 0.5 ? '半仓' : '全仓'}），改买科技进攻选中个股 ${emoPick.stockName}`,
                returnRate: rawReturnRate != null ? parseFloat((rawReturnRate * leaderWeight).toFixed(2)) : null,
                rawReturnRate,
              });
              position = emoPick;
              lastSellDate = dateStr; // 切换卖出龙头当日仅①情绪游资路不再追买（②刚买入不受影响）
            }
          }
        } else if (!position && !pendingBuy) {
          const emoPick = await tryEmoQuickBuy();
          if (emoPick) position = emoPick;
        }
      }

      // ===== 顺延买点：前一交易日涨幅前两名均涨停 → 次日首个桶（9:30）买入（要求斜率仍为正）=====
      if (!position && pendingBuy && bi === 0 && dateStr !== lastSellDate) {
        if (!slopePositive) {
          pendingBuy = null; // 斜率不为正 → 放弃本次顺延
        } else {
          const t = await loadTlinePoints(pendingBuy.code, dateNum);
          const atPt = priceAtMinute(t.points, bucketMinute);
          if (atPt && atPt.lastPx > 0) {
            const chg = t.preclose && t.preclose > 0
              ? parseFloat((((atPt.lastPx - t.preclose) / t.preclose) * 100).toFixed(2))
              : (atPt.change != null ? atPt.change : null);
            if (chg != null && chg < LEADER_MAX_BUY_DROP_PCT) {
              pendingBuy = null; // 龙头当日大跌 < -8% → 放弃本次顺延买入
            } else if (!isLimitUpAtBucket(chg)) {
              const pick = { ...pendingBuy, px: atPt.lastPx, changePct: chg, gain: parseFloat(((atPt.lastPx / pendingBuy.base - 1) * 100).toFixed(4)) };
              position = buildPosition({
                pick, dateStr, dateDisplay, timeText, slopeNow, hotBoardsText, poolTotal, deferred: true,
                boardCount: pendingBuy.boardCount,
                roster: pendingBuy.roster, hotDate: pendingBuy.hotDate, rank: 2,
              });
              position.buyDi = di;
              if (combo) position.branch = 'leader';
              if (!seenStocks.has(position.code)) seenStocks.set(position.code, { code: position.code, name: position.stockName });
              pendingBuy = null;
            }
            // 仍封涨停 → 保留 pendingBuy，次日 9:30 再试
          }
        }
      }

      // ===== 买入（空仓、无待顺延、斜率盘中由负转正、当日未卖出过）=====
      if (!position && !pendingBuy && turnedPos && dateStr !== lastSellDate && boardList.length > 0) {
        await ensurePoolTlines();
        // 逐板块统计：各成分股「自板块爆发日（hotDate）以来」涨幅（按涨幅降序）
        const boardStats = [];
        for (const b of boardList) {
          const rows = [];
          for (const s of b.stocks) {
            const t = poolTline.get(s.code);
            if (!t || t.points.length === 0) continue;
            const atPt = priceAtMinute(t.points, bucketMinute);
            if (!atPt || !(atPt.lastPx > 0)) continue;
            const changePct = t.preclose && t.preclose > 0
              ? parseFloat((((atPt.lastPx - t.preclose) / t.preclose) * 100).toFixed(2))
              : (atPt.change != null ? atPt.change : null);
            const gain = parseFloat(((atPt.lastPx / s.base - 1) * 100).toFixed(4));
            // 买入门槛：自板块爆发日以来涨幅须处 [10%, 30%] 区间，区间外个股整体剔除（先过滤候选池，再选板块）
            if (gain < LEADER_MIN_BOARD_GAIN_PCT || gain > LEADER_MAX_BOARD_GAIN_PCT) continue;
            // 买点触发门槛：买点触发时当日实时涨幅 < -8% 的候选整体剔除（龙头当日大跌则不买）
            if (changePct != null && changePct < LEADER_MAX_BUY_DROP_PCT) continue;
            rows.push({
              code: s.code, name: s.name, board: b.board, base: s.base, baseDate: s.baseDate,
              px: atPt.lastPx, changePct, gain,
              limitUp: isLimitUpAtBucket(changePct),
            });
          }
          if (rows.length === 0) continue;
          rows.sort((a, x) => x.gain - a.gain);
          boardStats.push({
            board: b.board, hotDate: b.hotDate, roster: b.stocks.length, rows,
          });
        }
        if (boardStats.length > 0) {
          // 选「板块内最优个股自爆发以来涨幅最高」的板块，再买入该板块内涨幅最大的那只
          boardStats.sort((a, x) => x.rows[0].gain - a.rows[0].gain);
          const top = boardStats[0];
          const first = top.rows[0];
          const second = top.rows[1] || null;
          const ctx = { boardCount: boardStats.length, roster: top.roster, hotDate: top.hotDate };
          if (!first.limitUp) {
            position = buildPosition({ pick: first, dateStr, dateDisplay, timeText, slopeNow, hotBoardsText, poolTotal, ...ctx });
          } else if (second && !second.limitUp) {
            position = buildPosition({ pick: second, dateStr, dateDisplay, timeText, slopeNow, hotBoardsText, poolTotal, rank: 2, ...ctx });
          } else if (second) {
            // 前两名均已涨停 → 顺延到次日 9:30 买「涨幅第 2」那只
            pendingBuy = { ...second, ...ctx };
          }
          if (position) {
            position.buyDi = di; // 记录买入日索引，用于「持仓第 3 个交易日」判定
            if (combo) position.branch = 'leader';
            if (!seenStocks.has(position.code)) seenStocks.set(position.code, { code: position.code, name: position.stockName });
          }
        }
      }

      // ===== 组合②路买入（快进快出）：①情绪游资路未成交的空仓桶，按「3日涨幅最大&三日情绪-60快进快出」
      //       买点出手（原优先级策略：与①同一桶同时触发时优先①，故本块排在①买入块之后；
      //       反优先级策略 techFirst 已在①块之前处理，本块跳过）=====
      if (combo && !techFirst && !position && !pendingBuy && quickOutSoldDate !== dateStr) {
        const emoPick = await tryEmoQuickBuy();
        if (emoPick) position = emoPick;
      }

      // ===== 组合②路卖出（通用 7 条件；快进快出持仓已由桶前 hook 接管，此处由 hook 内部自动跳过）=====
      if (combo && position && position.branch === 'emoquick') {
        const arr = [position];
        await generalSellPositions({
          positions: arr,
          strategy: { emoQuickOut: true, tailDip: false, nextDayOpenSell: false, twoBuy: false },
          bi, replayStocks, timeBuckets, dateStr, dateDisplay, singleTrades: trades,
        });
        if (arr.length === 0) position = null;
      }

      if (slopeNow != null && Number.isFinite(Number(slopeNow))) lastSlopeSign = slopeNow > 0 ? 1 : -1;
    }
  }

  // 组装结果（type:'single'：单持仓（半仓：每笔用当前总资金 50% 逐笔复利），整体收益率 = 逐笔复利，与 rangeBacktest/sentimentHotMoney 口径一致；
  // 期末持仓按最近收盘价估算的浮动收益并入复利）
  let acc = 1;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (position) {
    holding = { ...position, weight: position.branch === 'emoquick' ? 1 : leaderWeight };
    let rawBuyReturn = null;
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(position.code);
      if (info && info.closePx != null && info.closePx > 0) {
        rawBuyReturn = position.buyPrice > 0
          ? parseFloat((((info.closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    if (rawBuyReturn == null) {
      const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
      if (closePx != null && closePx > 0 && position.buyPrice > 0) {
        rawBuyReturn = parseFloat((((closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2));
      }
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * holding.weight).toFixed(2)) : null;
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) acc *= 1 + holding.buyReturn / 100;
  }
  const overallReturn = parseFloat(((acc - 1) * 100).toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  await attachBuyDayReturn(trades);
  if (holding) await attachBuyDayReturn([holding]);
  return {
    success: true,
    type: 'single',
    strategy: { id: strategy.id, name: strategy.name, desc: strategy.desc },
    range: { startDate, endDate },
    skippedDates,
    seenStocks: Array.from(seenStocks.values()),
    trades,
    currentHolding: holding,
    summary: {
      tradeCount: trades.length,
      winCount,
      winRate: validTrades.length > 0 ? parseFloat((winCount / validTrades.length * 100).toFixed(2)) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: position != null,
    },
  };
};

// 构建持仓对象（含买入原因与诊断明细）
const buildPosition = ({ pick, dateStr, dateDisplay, timeText, slopeNow, hotBoardsText, poolTotal, boardCount, roster, hotDate, rank, deferred }) => {
  const t = timeText.substring(0, 5);
  const slopeText = `${slopeNow > 0 ? '+' : ''}${Number(slopeNow).toFixed(2)}`;
  const gainText = `${pick.gain > 0 ? '+' : ''}${pick.gain.toFixed(2)}%`;
  const boardCtx = `「${pick.board}」（爆发日 ${hotDate}，名册 ${roster} 只）`;
  const buyReason = deferred
    ? `${t} ${ICE_SIGNAL_INDEX_NAME} 3 日线斜率 ${slopeText}（为正），执行上一交易日顺延买入：涨停潮板块 ${boardCtx} 内自爆发以来涨幅第 ${rank || 2} 的 ${pick.name}`
    : `${t} ${ICE_SIGNAL_INDEX_NAME} 3 日线斜率由负转正（${slopeText}），买入过去 ${LEADER_LOOKBACK_DAYS} 个交易日涨停潮（涨停数 ≥ ${LEADER_MIN_LIMIT_UP_COUNT}）板块中自爆发以来涨幅最高的 ${boardCtx} 内${rank === 2 ? '涨幅第 2' : '自爆发以来涨幅最大'}的 ${pick.name}`;
  const checks = [
    {
      id: 'leader_slope_gate',
      title: `${ICE_SIGNAL_INDEX_NAME} 3 日线斜率盘中由负转正`,
      passed: true,
      value: `${t} ${slopeText}`,
      reason: deferred
        ? `顺延买点：次日 9:30 要求斜率仍为正（当前 ${slopeText}），按开盘价买入`
        : `买点通道 = 斜率「盘中由负转正」的当桶（择时提高胜率），当前 ${slopeText}`,
    },
    {
      id: 'leader_board_pick',
      title: `选自爆发以来涨幅最高的涨停潮板块`,
      passed: true,
      value: `${pick.board}（名册 ${roster} 只）`,
      reason: `回溯窗口内掀起涨停潮的板块：${hotBoardsText}（已剔除 ${LEADER_EXCLUDED_BOARDS.join('、')}，候选池仅主板；各成分股须在最近 ${LEADER_VOLUME_LOOKBACK_DAYS} 个交易日内出现过一次放量[成交量较前一交易日 ≥ +${LEADER_VOLUME_SURGE_PCT}%，且该放量日须为从放量之日起往前回溯 ${LEADER_VOLUME_PEAK_DAYS} 个交易日内的量能最大日]，否则跳过）；候选池再按买入门槛过滤——仅保留「自板块爆发日以来涨幅」处 ${LEADER_MIN_BOARD_GAIN_PCT}%~${LEADER_MAX_BOARD_GAIN_PCT}% 的个股，其余整体剔除；买点触发时当日实时涨幅 < ${LEADER_MAX_BUY_DROP_PCT}%（当日大跌）的个股亦整体剔除；过滤后共 ${boardCount} 个板块，取「板块内最优个股自爆发以来涨幅最高」的板块`,
    },
    {
      id: 'leader_best_stock',
      title: `板块内自爆发以来涨幅最大的龙头`,
      passed: true,
      value: `${pick.name}（${pick.code}）${gainText}`,
      reason: `该股自板块爆发日 ${pick.baseDate} 收盘 ${pick.base.toFixed(2)} 起算，至触发时点价 ${pick.px.toFixed(2)}，涨幅 ${gainText}（已通过 ${LEADER_MIN_BOARD_GAIN_PCT}%~${LEADER_MAX_BOARD_GAIN_PCT}% 买入门槛，且触发时点当日实时涨幅 ${pick.changePct != null ? `${pick.changePct > 0 ? '+' : ''}${pick.changePct}%` : '--'} ≥ ${LEADER_MAX_BUY_DROP_PCT}%；板块名册共 ${roster} 只，候选合计 ${poolTotal} 只）；涨幅第 1 已涨停则买第 2，前两名均涨停则顺延次日 9:30${rank === 2 ? '；本次买入为涨幅第 2（第 1 已封涨停）' : ''}`,
    },
  ];
  if (deferred) {
    checks.push({
      id: 'leader_deferred',
      title: '顺延买入（前两名均涨停 → 次日 9:30）',
      passed: true,
      value: `${dateDisplay} ${t}`,
      reason: `上一交易日该板块涨幅前两名均已封涨停无法成交，按规则顺延到次日 9:30 开盘买入当时选定的那只（要求 9:30 实时涨幅 ≥ ${LEADER_MAX_BUY_DROP_PCT}%，当日大跌 < ${LEADER_MAX_BUY_DROP_PCT}% 则放弃本次顺延）`,
    });
  }
  return {
    code: pick.code,
    stockName: pick.name,
    mode: 'offense',
    board: pick.board,
    base: pick.base,
    baseDate: pick.baseDate,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: t,
    buyPrice: parseFloat(pick.px.toFixed(2)),
    buyChange: pick.changePct != null ? parseFloat(Number(pick.changePct).toFixed(2)) : null,
    metric: pick.gain,
    weight: 1,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runLeaderBacktest };
