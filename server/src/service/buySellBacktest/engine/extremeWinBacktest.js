const { STRATEGIES } = require('../strategies/registry');
const {
  batchParallel,
  ensureBarsForCodes,
  getPastTradingDates,
  getRecentMultiLianbanStocks,
  getSingleStockTlineDataByDate,
  getStockCloseOnOrBefore,
  getTrainingCampDates,
  loadTrainingCampData,
  stockVolumeRatio,
  stockWindowGain,
} = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { calculateReplayResilience } = require('../diagnose/sellPoint');
const { iceResilienceIndexCode } = require('./indexGate');
const { scanLeaderPriceSell } = require('./leaderSellMinute');
const { EXCLUDED_CODES } = require('../constants');
const { fmtTime } = require('../diagnose/buyPoint');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
// 差劲分 / 强度分的口径与打分函数（与「个股历史分析」接口共用同一份实现）
const {
  DIFF_A_MAX, DIFF_B_MAX, DIFF_C_MAX, DIFF_D_MAX,
  STRENGTH_A_MAX, STRENGTH_B_MAX, STRENGTH_C_MAX, STRENGTH_W,
  DIFF_MIN_SCORE,
  clamp100, round2,
  loadTlinePoints, clearTlineCache,
  maxMinuteDrop, closeDropFromHigh, fanbanCount,
  scoreDiffFromRaw, strengthAtMinute,
} = require('./extremeWinScores');

// ============================================================
// 情绪游资-极致胜率（extremeWinMode: true，2026-10-16 用户新增；独立引擎）
//   选股 = 过去 20 个交易日（不含当日）内出现过三连板及以上（连板数 >= 3）的个股，
//          且最近 6 个交易日（不含当日）累计涨幅 < 70%；
//   差劲分（昨日，0~100，越高越差）= 0.3×A + 0.2×B + 0.3×C + 0.2×D，各分项先按上限归一化到 0~100：
//          A 放量比 = (昨日量 − 更前 3 日日均量) ÷ 更前 3 日日均量（上限 3）
//          B 单分钟最大跳水 = 昨日分时相邻分钟最大跌幅（上限 5%）
//          C 冲高回落 = (昨日分时最高 − 昨日收盘) ÷ 昨日收盘 × 100（上限 10%）
//          D 炸板次数 = 昨日分时触及涨停价后回落次数（上限 5）
//   强度分（今日盘中，0~100，越高越强）= 0.4×A + 0.3×B + 0.3×C，各分项归一化到 0~100：
//          A 竞价高开 = (当日开盘价 − 昨收) ÷ 昨收 × 100（上限 10%）
//          B 单分钟最大涨幅 = 当日分时相邻分钟最大涨幅（上限 10%；一字板直接取 10%/20%）
//          C 抗分歧分数 = calculateReplayResilience（原始 0~30，上限 20）
//   买点 = 今日盘中逐桶实时判定：仅当「强度分 − 差劲分 > 0」且「差劲分 >= 45」时买入，
//          多候选取「强度分 − 差劲分」差值最大者；买入时点已涨停（主板 > 9.5%、创业/科创 > 19%）不可买、顺延下一只；
//   卖点 = 完全沿用「情绪游资-龙头战法」的 8 条卖点（跌破成本线 -5% 连续 ≥5 分钟 ∪ 跌停 ∪ 高位放量大阴线
//          ∪ 持仓第 3 日尾盘未拉开 +10% ∪ 竞价低开 < -5% ∪ 收盘抗分歧 < 6 ∪ 盘中分时跌幅（较昨收）≤ -5% 直接卖
//          ∪ 开盘后较开盘价直线下挫 ≤ -5% 直接卖；价格类卖点按分钟级回溯取最先触发分钟精准成交）；全仓，收益率不做半仓折算。
// ============================================================

const LOOKBACK_DAYS = 20;          // 选股回溯窗口：过去 20 个交易日
const MIN_BOARD_COUNT = 3;         // 连板门槛：三连板及以上
const WINDOW_GAIN_DAYS = 6;        // 涨幅窗口：最近 6 个交易日（不含当日）
const MAX_WINDOW_GAIN_PCT = 70;    // 涨幅上限：窗口累计涨幅须 < 70%

// 差劲分 / 强度分 的分项上限、权重、买点门槛（DIFF_MIN_SCORE）均取自 ./extremeWinScores

// 价格类卖点门槛（止损/跌停/昨收跌幅/开盘跌幅/高位回落/竞价低开）统一由 ./leaderSellMinute 持有
const WEAK_TRADE_HOLD_DAYS = 3;
const WEAK_TRADE_MIN_GAIN_PCT = 10;
const TAIL_MINUTE = 1457;
const RESILIENCE_SELL_MAX = 6;
const LEADER_RESILIENCE_INDEX_CODE = 'sh000001'; // 抗分歧/涨停口径统一跟踪上证指数（与龙头战法一致）

// 价格类卖点的分钟级回溯统一走 ./leaderSellMinute.scanLeaderPriceSell

const fmtMinute = (m) => (m != null ? `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}` : '--');
const priceAtMinute = (points, minute) => {
  let atPt = null;
  for (const p of points) { if (p.minute <= minute) atPt = p; else break; }
  return atPt;
};

// 个股分时点缓存与加载统一走 ./extremeWinScores（loadTlinePoints / clearTlineCache）

// 昨日差劲分（0~100）：A 放量比 / B 单分钟最大跳水 / C 冲高回落 / D 炸板次数
const computeDiffScore = async (code, dateStr, yesterdayNum) => {
  // A 放量比（来自日K）
  let aRaw = null;
  try { aRaw = stockVolumeRatio(code, dateStr); } catch (e) { aRaw = null; }
  // 昨日分时：B / C / D
  const yt = await loadTlinePoints(code, yesterdayNum);
  return scoreDiffFromRaw(
    aRaw,
    maxMinuteDrop(yt.points),
    closeDropFromHigh(yt.points),
    fanbanCount(yt.points, yt.preclose, code),
  );
};

// 今日强度分（截至 bucketMinute 的盘中分时，0~100）：A 竞价高开 / B 单分钟最大涨幅 / C 抗分歧分数
// 统一走 ./extremeWinScores.strengthAtMinute（与「个股历史分析」接口口径一致）
const computeStrength = (t, bucketMinute, code, idxPointsMap) =>
  strengthAtMinute(t, bucketMinute, code, idxPointsMap.get(iceResilienceIndexCode(code)) || []);

const runExtremeWinBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.extremeWinMode !== true) {
    return { success: false, message: `未知情绪游资-极致胜率策略: ${strategyId}` };
  }

  // 不依赖资金快照：日期序列并入 tech_index 覆盖的交易日（与龙头战法引擎同口径）
  const allDates = Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]));
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });

  // 启动预拉取：扫描整个回测区间每个交易日可能出现的候选股，一次性拉取日K（供放量比 / 6 日涨幅窗口使用）
  try {
    const presetAll = new Set();
    for (const d of rangeDates) {
      const { stocks } = await getRecentMultiLianbanStocks(d, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      for (const s of stocks) presetAll.add(s.code);
    }
    if (presetAll.size > 0) await ensureBarsForCodes(presetAll);
  } catch (e) { /* 预拉失败时逐日兜底 ensureBarsForCodes */ }

  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }

  let position = null;      // 单股持仓（全仓）
  let lastSellDate = null;  // 卖出当日不再追买

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
    const dateNum = parseInt(dateStr, 10);
    const hasTailBucket = timeBuckets.some(b => Number(b.minute) >= TAIL_MINUTE);
    const todayIdx = di;

    // 上一交易日（用于差劲分）
    let yesterdayNum = null;
    try {
      const prev = await getPastTradingDates(dateStr, 1);
      yesterdayNum = prev.length > 0 ? Number(prev[0]) : null;
    } catch (e) { yesterdayNum = null; }

    // 候选池基本面（连板股名单，读快照，较廉价）
    let candidatesRaw = [];
    try {
      const info = await getRecentMultiLianbanStocks(dateStr, LOOKBACK_DAYS, MIN_BOARD_COUNT);
      candidatesRaw = (info.stocks || []).filter(s => !EXCLUDED_CODES.has(s.code));
    } catch (e) { candidatesRaw = []; }
    if (candidatesRaw.length > 0) {
      for (const s of candidatesRaw) if (!seenStocks.has(s.code)) seenStocks.set(s.code, { code: s.code, name: s.name || s.code });
    }

    // 每日分时缓存重建，控制内存
    clearTlineCache();

    // 隔夜持仓当日分时（卖点用）
    let posTline = null;
    if (position && dateStr > position.buyDate) {
      posTline = await loadTlinePoints(position.code, dateNum);
    }
    // 持仓股当日收盘抗分歧指数（卖点⑥用；懒计算）
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
        const stockLine = (stockT?.line || [])
          .filter(p => p && p.minute != null && p.last_px != null)
          .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
          .filter(p => p.lastPx > 0);
        const indexLine = (indexT?.line || [])
          .filter(p => p && p.minute != null && p.last_px != null)
          .map(p => ({ minute: parseInt(p.minute, 10), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
          .filter(p => p.lastPx > 0);
        if (stockLine.length >= 5 && indexLine.length >= 5) {
          const s = calculateReplayResilience(stockLine, indexLine, position.code);
          if (s != null && Number.isFinite(Number(s))) posResilience = round2(s);
        }
      } catch (e) { /* 数据不足则不触发该卖点 */ }
      return posResilience;
    };

    // 候选池数据（懒加载：仅当空仓需要评估买入时构建）：6 日涨幅过滤 + 昨日差劲分 + 今日分时 + 指数分时
    let poolReady = false;
    let candidates = [];
    const diffScores = new Map();   // code -> 差劲分明细
    const todayTline = new Map();   // code -> { preclose, points }
    const idxPointsMap = new Map(); // idxCode -> points

    const ensurePoolData = async () => {
      if (poolReady) return;
      poolReady = true;
      if (candidatesRaw.length === 0) return;
      // 确保候选股日K已在缓存（6 日窗口涨幅 / 放量比依赖）
      try {
        await ensureBarsForCodes(new Set(candidatesRaw.map(s => s.code)));
      } catch (e) { /* 单只失败后续按 null 处理 */ }
      let winDates = [];
      try { winDates = await getPastTradingDates(dateStr, WINDOW_GAIN_DAYS); } catch (e) { winDates = []; }
      candidates = candidatesRaw.filter(s => {
        if (winDates.length < WINDOW_GAIN_DAYS) return false;
        const gain = stockWindowGain(s.code, winDates);
        return gain != null && Number.isFinite(gain) && gain < MAX_WINDOW_GAIN_PCT;
      });
      if (candidates.length === 0) return;
      // 昨日差劲分（逐候选；A 走日K，B/C/D 走昨日分时）
      await batchParallel(candidates, async (c) => {
        try { diffScores.set(c.code, await computeDiffScore(c.code, dateStr, yesterdayNum)); } catch (e) { diffScores.set(c.code, null); }
      }, 8);
      // 今日分时（逐候选）
      await batchParallel(candidates, async (c) => {
        try { todayTline.set(c.code, await loadTlinePoints(c.code, dateNum)); } catch (e) { todayTline.set(c.code, { preclose: null, points: [] }); }
      }, 8);
      // 指数分时（主板 sh000001 / 创业板 sz399006 / 科创50 sh000688）
      await Promise.all(['sh000001', 'sz399006', 'sh000688'].map(async (ic) => {
        try {
          const r = await loadTlinePoints(ic, dateNum);
          idxPointsMap.set(ic, r.points || []);
        } catch (e) { idxPointsMap.set(ic, []); }
      }));
    };

    // 评估某桶的候选：返回按「强度分 − 差劲分」降序排列的达标候选数组
    const evalBucket = (bucketMinute) => {
      const out = [];
      for (const c of candidates) {
        const diff = diffScores.get(c.code);
        if (!diff || diff.score < DIFF_MIN_SCORE) continue;
        const t = todayTline.get(c.code);
        if (!t || t.points.length === 0 || !(t.preclose > 0)) continue;
        // 上界剪枝：强度分上限 = 0.4×A_max(100) + 30 + 30 = 0.4×A分 + 60；差劲分 >= 该上界则不可能满足 强度 > 差劲
        const aUpper = clamp100((((t.points[0].lastPx - t.preclose) / t.preclose) * 100 / STRENGTH_A_MAX) * 100);
        if (diff.score >= STRENGTH_W.a * aUpper + 60) continue;
        const s = computeStrength(t, bucketMinute, c.code, idxPointsMap);
        if (!s) continue;
        const delta = round2(s.score - diff.score);
        if (delta == null || delta <= 0) continue;
        out.push({ ...c, delta, strength: s.score, diffScore: diff.score, s, d: diff, px: s.px, changePct: s.changePct, limitUp: s.limitUp });
      }
      out.sort((a, b) => b.delta - a.delta);
      return out;
    };

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      const isTailBucket = hasTailBucket ? bucketMinute >= TAIL_MINUTE : bi === timeBuckets.length - 1;
      const timeText = fmtTime(bucket.timeKey).substring(0, 5);

      // ===== 卖出（隔夜持仓；沿用龙头战法 8 条卖点，价格类卖点分钟级回溯）=====
      if (position && dateStr > position.buyDate && posTline && posTline.points.length > 0) {
        const atPt = priceAtMinute(posTline.points, bucketMinute);
        if (atPt && atPt.lastPx > 0) {
          const px = atPt.lastPx;
          const preclose = posTline.preclose;
          const changePct = preclose && preclose > 0
            ? round2(((px - preclose) / preclose) * 100)
            : (atPt.change != null ? atPt.change : null);
          const costReturn = position.buyPrice > 0
            ? round2(((px - position.buyPrice) / position.buyPrice) * 100)
            : null;

          let sellReason = null;
          let sellMinute = atPt.minute; // 默认按当前桶时点成交（④⑥属尾盘时点卖点）
          let sellPx = px;
          let sellChange = changePct;

          // 价格类卖点（⑤竞价低开 / ①成本线止损 / ②跌停 / ⑦昨收跌幅 / ⑧开盘跌幅 / ③高位大阴线）：
          // 分钟级回溯——自 9:30 起逐分钟扫描分时，取「最先触发」的那一分钟精准卖出
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
          // ④ 持仓第 3 个交易日尾盘收益仍未拉开至 +10%
          if (!sellReason && position.buyDi != null && (di - position.buyDi + 1) === WEAK_TRADE_HOLD_DAYS && isTailBucket) {
            if (costReturn != null && costReturn < WEAK_TRADE_MIN_GAIN_PCT) {
              sellReason = `持仓第 ${WEAK_TRADE_HOLD_DAYS} 个交易日尾盘收益仍未拉开至 +${WEAK_TRADE_MIN_GAIN_PCT}%（成本 ${position.buyPrice.toFixed(2)}，现价 ${px.toFixed(2)}，收益 ${costReturn}%）`;
            }
          }
          // ⑥ 收盘抗分歧指数 < 6
          if (!sellReason && isTailBucket) {
            const res = await ensurePosResilience();
            if (res != null && Number(res) < RESILIENCE_SELL_MAX) {
              sellReason = `当日收盘抗分歧指数 ${Number(res)} < ${RESILIENCE_SELL_MAX}（收盘抗分歧过弱）`;
            }
          }

          if (sellReason) {
            const rawReturnRate = position.buyPrice > 0
              ? round2(((sellPx - position.buyPrice) / position.buyPrice) * 100)
              : null;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              board: position.board,
              positionMode: 'offense',
              weight: 1,
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
              sellPrice: round2(sellPx),
              sellChange,
              sellReason: `${sellReason}，情绪游资-极致胜率持仓卖出（全仓）`,
              returnRate: rawReturnRate,
              rawReturnRate,
            });
            position = null;
            lastSellDate = dateStr; // 卖出当日不再追买
          }
        }
      }

      // ===== 买入（空仓、当日未卖出过、逐桶实时判定）=====
      if (!position && dateStr !== lastSellDate) {
        await ensurePoolData();
        if (candidates.length > 0) {
          const ranked = evalBucket(bucketMinute);
          const pick = ranked.find(r => !r.limitUp); // 买入时点已涨停不可买 → 顺延至差值排名下一只
          if (pick) {
            position = buildPosition({ pick, ranked, dateStr, dateDisplay, timeText });
            position.buyDi = todayIdx;
            for (const c of candidates) if (!seenStocks.has(c.code)) seenStocks.set(c.code, { code: c.code, name: c.name || c.code });
          }
        }
      }
    }
  }

  // 组装结果（type:'single'：全仓单持仓，整体收益率 = 逐笔复利；期末持仓按最近收盘价估算浮盈并入复利）
  let acc = 1;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (position) {
    holding = { ...position, weight: 1 };
    let rawBuyReturn = null;
    const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
    if (closePx != null && closePx > 0 && position.buyPrice > 0) {
      rawBuyReturn = round2(((closePx - position.buyPrice) / position.buyPrice) * 100);
    }
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn;
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) acc *= 1 + holding.buyReturn / 100;
  }
  const overallReturn = round2((acc - 1) * 100);
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
      winRate: validTrades.length > 0 ? round2((winCount / validTrades.length) * 100) : null,
      ...calcDrawdownStats(validTrades),
      overallReturn,
      holding: position != null,
    },
  };
};

// 构建持仓对象（含买入原因与差劲分/强度分诊断明细）
const buildPosition = ({ pick, ranked, dateStr, dateDisplay, timeText }) => {
  const s = pick.s;
  const d = pick.d;
  const diff = pick.diffScore;
  const strength = pick.strength;
  const delta = pick.delta;
  const limitUpText = (v) => (v > 0 ? `+${v}%` : `${v}%`);
  const buyReason = `${timeText} 昨日差劲分 ${diff}（≥ ${DIFF_MIN_SCORE}）且今日强度分 ${strength}，强度 − 差劲 = ${delta} > 0，买入候选 ${pick.name}（${pick.code}，${pick.lianbanCount} 连板），触发时点价 ${pick.px.toFixed(2)}`;
  const checks = [
    {
      id: 'extreme_win_pool',
      title: '选股（过去 20 个交易日三连板及以上 + 最近 6 日涨幅 < 70%）',
      passed: true,
      value: `${pick.name}（${pick.code}）· ${pick.lianbanCount} 连板`,
      reason: `候选 = 过去 ${LOOKBACK_DAYS} 个交易日内出现连板数 ≥ ${MIN_BOARD_COUNT} 的个股（命中日 ${pick.date}，板块 ${pick.board || '--'}），且最近 ${WINDOW_GAIN_DAYS} 个交易日（不含当日）累计涨幅 < ${MAX_WINDOW_GAIN_PCT}%；本桶达标候选共 ${ranked.length} 只，按「强度分 − 差劲分」降序取第一名（已排除买入时点涨停者）`,
    },
    {
      id: 'extreme_win_diff',
      title: `昨日差劲分 ${diff}（门槛 ≥ ${DIFF_MIN_SCORE}，越高越差）`,
      passed: true,
      value: `A 放量 ${d.aRaw == null ? '--' : d.aRaw}（分 ${d.aScore}）· B 跳水 ${d.bRaw}%（分 ${d.bScore}）· C 冲高回落 ${d.cRaw}%（分 ${d.cScore}）· D 炸板 ${d.dRaw} 次（分 ${d.dScore}）`,
      reason: `差劲分 = 0.3×A + 0.2×B + 0.3×C + 0.2×D = 0.3×${d.aScore} + 0.2×${d.bScore} + 0.3×${d.cScore} + 0.2×${d.dScore} = ${diff}（各分项已按上限归一化到 0~100：A 上限 ${DIFF_A_MAX}、B 上限 ${DIFF_B_MAX}%、C 上限 ${DIFF_C_MAX}%、D 上限 ${DIFF_D_MAX}）`,
    },
    {
      id: 'extreme_win_strength',
      title: `今日强度分 ${strength}（越高越强）`,
      passed: true,
      value: `A 竞价高开 ${s.aRaw}%（分 ${s.aScore}）· B 分钟最大涨幅 ${s.bRaw}%（分 ${s.bScore}）${s.isOneWord ? '（一字板）' : ''} · C 抗分歧 ${s.cRaw}（分 ${s.cScore}）`,
      reason: `强度分 = 0.4×A + 0.3×B + 0.3×C = 0.4×${s.aScore} + 0.3×${s.bScore} + 0.3×${s.cScore} = ${strength}（各分项已按上限归一化到 0~100：A 上限 ${STRENGTH_A_MAX}%、B 上限 ${STRENGTH_B_MAX}%、C 上限 ${STRENGTH_C_MAX}）；时点价 ${pick.px.toFixed(2)}（昨收 ${s.preclose}，现价涨幅 ${limitUpText(s.changePct)}）`,
    },
    {
      id: 'extreme_win_threshold',
      title: `买点判定：强度分 − 差劲分 > 0 且 差劲分 ≥ ${DIFF_MIN_SCORE}`,
      passed: true,
      value: `${strength} − ${diff} = ${delta} > 0`,
      reason: `今日强度分 ${strength} 高于昨日差劲分 ${diff}，且差劲分 ${diff} ≥ ${DIFF_MIN_SCORE}，满足「分歧转一致」低吸反转买入条件`,
    },
  ];
  return {
    code: pick.code,
    stockName: pick.name,
    mode: 'offense',
    board: pick.board,
    buyDate: dateStr,
    buyDateDisplay: dateDisplay,
    buyTime: timeText,
    buyPrice: round2(pick.px),
    buyChange: round2(s.changePct),
    metric: delta,
    weight: 1,
    buyReason,
    buyChecks: checks,
  };
};

module.exports = { runExtremeWinBacktest };
