const { GLOBAL_RESILIENCE_MIN, STRATEGIES } = require('../strategies/registry');
const { batchParallel, ensureBarsForCodes, ensureKeyBlockBars, getHistoricalLianbanDefenseStocks, getHongliMultiLianbanStocks, getKeyBlockConstituents, getKeyBlockTagMap, getKlineCached, getMonitorStocks, getSimContext, getSingleStockTlineDataByDate, getStockCloseOnOrBefore, getTrainingCampDates, isOscExcluded, isStockInWatchlistAt, loadTrainingCampData, scanAllLianbanCodesInRange, scanHongliMultiLianbanCodesInRange, stockWindowGain } = require('../deps');
const { getTechIndexDates } = require('../utils/techEmotion');
const { buildWindowAxis, injectSimStocksIntoCampData } = require('./pickHelpers');
const { ICE_SIGNAL_INDEX_CODE, ICE_SIGNAL_INDEX_NAME, ensureIndexMa3SlopeSeries, fmtCybGateDate, fmtKeyBlockSlope, getIceMa3Slope, getIceMa3SlopeIntraday, getKeyBlockCybMa3Slope, getKeyBlockCybMa3SlopeIntraday, iceIndexName, iceResilienceIndexCode } = require('./indexGate');
const { EXCLUDED_CODES } = require('../constants');
const { calculateReplayResilience, runSellPointDiagnosis } = require('../diagnose/sellPoint');
const { buildReplayStocksWithTline, extractDailyInfo, isLimitUpAtBuy, isPrevDayOneWordBoard } = require('./replayData');
const { fmtTime } = require('../diagnose/buyPoint');
const { buildKeyBlockSyntheticBucketEntry, buildKeyBlockSyntheticDay } = require('./keyBlockSynthetic');
const { attachBuyDayReturn, calcDrawdownStats } = require('../utils/tradeStats');
const { isBuyBlockedByValuation } = require('../../watchlistValuation');

const KEY_BLOCK_POSITION_WEIGHT = { offense: 1, defense: 0.5 };
const KEY_BLOCK_MODE_LABEL = { offense: '进攻·全仓', defense: '防御·半仓' };
// 防御持仓止损线（个股成本线下 -5%，任一卖点先触发即卖出；2026-10-01 用户新增）
const KEY_BLOCK_DEFENSE_STOP_LOSS_PCT = 5;

const runKeyBlockBacktest = async (startDate, endDate, strategyId, onProgress) => {
  const strategy = STRATEGIES[strategyId];
  if (!strategy || strategy.keyBlockDays == null) {
    return { success: false, message: `未知重点板块策略: ${strategyId}` };
  }
  const days = Number(strategy.keyBlockDays);
  // 情绪游资系列（iceMode）：只用 tag 板块∪红利连板候选池、全仓、-2% 止损、14:55 长下影强卖；
  //   顺周期情绪游资（iceReverse: false）＝斜率由负转正才买、由正转负即卖；
  //   逆周期情绪游资（iceReverse: true，2026-10-10 新增）＝完全镜像——斜率由正转负的次日 9:40 依旧为负才买、由负转正当桶即卖
  const iceMode = strategy.iceMode === true;
  const iceReverse = strategy.iceReverse === true;
  // 逆周期情绪游资 1 日变体（hot_money_ice_rev_1d_gain）：选股排序依据 = 触发时点当日分时涨幅（非 N 日窗口累计）
  const iceRevIntradayGain = iceReverse && strategy.iceIntradayGain === true;
  // 情绪游资展示名（买入/卖出原因等文案中区分顺/逆周期）
  const iceName = iceReverse ? '逆周期情绪游资' : '顺周期情绪游资';
  // 情绪游资（iceMode）不依赖资金快照，日期序列并入 tech_index 覆盖的交易日（补上缺资金快照的日期，如 20260730），
  // 与三日情绪均值系列口径一致；否则这类日期整日不参与回放，会漏掉当日的斜率翻转/止损等卖点判定
  const allDates = iceMode
    ? Array.from(new Set([...getTrainingCampDates(), ...getTechIndexDates()]))
    : getTrainingCampDates();
  // 升序处理（按时间先后）
  const rangeDates = allDates.filter(d => d >= startDate && d <= endDate).sort();
  const total = rangeDates.length;
  if (total === 0) {
    return { success: false, message: '所选日期范围内无可回测交易日' };
  }

  const blocks = getKeyBlockConstituents();
  if (blocks.size === 0) {
    return { success: false, message: '无重点板块配置（block_code.js 为空）' };
  }
  // 预拉取全部重点板块成分股日K（回测时现算板块/个股涨幅；进程内缓存，多策略/多子进程共享磁盘缓存）
  // 同时预扫描整个回测窗口可能出现的历史涨停板块防御候选股（创业板下跌日的涨停第一板块），一并预拉 bars
  if (onProgress) onProgress({ current: 0, total, date: '', status: 'loading' });
  try {
    let extraCodes = new Set();
    if (!iceMode) {
      try {
        extraCodes = await scanAllLianbanCodesInRange(rangeDates);
      } catch (e) { /* 历史涨停扫描失败忽略，防御池退化为仅 tag 板块成分股 */ }
    } else {
      // 情绪游资系列：预扫描红利板块连板候选股（近20交易日出现三板及以上连板的红利板块个股），一并预拉 bars
      try {
        extraCodes = await scanHongliMultiLianbanCodesInRange(rangeDates);
      } catch (e) { /* 红利连板扫描失败忽略，防御池退化为仅 tag 板块成分股 */ }
    }
    await ensureKeyBlockBars(extraCodes);
    // 随机模拟：预拉随机抽取的真实科技股日K，供 keyBlock 引擎的「N 日涨幅最大」筛选与期末收盘估值现算
    const simPreload = getSimContext();
    if (simPreload && Array.isArray(simPreload.codes) && simPreload.codes.length > 0) {
      try { await ensureBarsForCodes(simPreload.codes); } catch (e) { /* 个别股票拉取失败不影响整体 */ }
    }
  } catch (e) {
    return { success: false, message: `重点板块成分股日K拉取失败: ${e.message || e}` };
  }

  let position = null; // 单股持仓（mode: 'offense' 进攻=自选科技股 / 'defense' 防御=防御+中性 tag 股）
  const trades = [];
  const skippedDates = [];
  const seenStocks = new Map(); // code -> { code, name }（回测期间出现过的自选股，供复制K线等使用）
  const dailyInfos = new Map(); // date -> Map<code, {changePct, closePx, resilience}>（期末持仓收益率估算用）
  // 预热起始日前 days 个交易日 EOD，日期轴前移，保证起点附近「最近 N 日」窗口不被起始日截断
  const { dateAxis, axisOffset } = await buildWindowAxis(allDates, rangeDates, startDate, days, dailyInfos);

  // 斜率符号状态机（2026-10-01 重构：买卖只由斜率正负翻转驱动，不再按斜率正负直接分模式）：
  //   lastSlopeSign/Value：最近一个有效盘中实时斜率的符号与数值，跨日连续追踪；初值取回测首日前一交易日收盘斜率
  //   pendingEntry：空仓时的入场意图（斜率翻转事件/次日9:40复测），在后续桶持续尝试直到建仓或被反向翻转覆盖
  //   offenseBlockDate：进攻持仓卖点诊断卖出且当时斜率仍为正的交易日，当日剩余桶禁止进攻追买（次日9:40复测）
  let lastSlopeSign = null; // null | 1（正）| -1（非正）
  let lastSlopeValue = null;
  let pendingEntry = null; // null | { mode: 'offense'|'defense', trigger, fromValue, toValue }
  let offenseBlockDate = null;
  try {
    // 情绪游资系列以「上证指数」3 日线斜率为信号，与创业板口径不同（顺周期＝为正买为负卖；逆周期＝方向镜像）
    const { dates: seedDates, slopes: seedSlopes } = await ensureIndexMa3SlopeSeries(iceMode ? ICE_SIGNAL_INDEX_CODE : 'sz399006');
    for (let i = seedDates.length - 1; i >= 0; i--) {
      if (seedDates[i] < Number(rangeDates[0])) {
        const v = seedSlopes.get(seedDates[i]);
        if (v != null && Number.isFinite(Number(v))) {
          lastSlopeSign = v > 0 ? 1 : -1;
          lastSlopeValue = v;
        }
        break;
      }
    }
  } catch (e) { /* 无初值时首个有效斜率桶建立基准，当日不触发翻转事件 */ }

  // 候选池（每轮回测固定）：进攻 = 自选股中 isTech ≠ false 的科技股；防御 = 防御+中性 tag 板块成分股
  const { getMonitorStocks } = require('../../monitorStock');
  const techPool = (getMonitorStocks() || [])
    .filter(s => s && s.code && s.isTech !== false && !EXCLUDED_CODES.has(s.code))
    .map(s => ({ code: s.code, name: s.name || s.code }));
  const tagBlocks = [];
  const tagMap = getKeyBlockTagMap();
  for (const [blockName, members] of blocks) {
    const tag = tagMap.get(blockName);
    if (tag && ['防御', '中性'].includes(tag)) tagBlocks.push({ blockName, tag, members });
  }

  // 按入场意图在触发桶时点选股建仓（涨停顺延、买入价取桶时点分时价）；成功建仓返回 true 并写入 position
  // trigger：slope_turn_positive（斜率由负转正=进攻）/ slope_turn_negative（由正转负且空仓=防御）/
  //          retry_next_day_940（进攻卖出后次日开盘10分钟复测仍为正）
  const openPosition = async (intent, ctx) => {
    const { mode, trigger, fromValue, toValue, icePrevCloseSlope } = intent;
    const { dateStr, dateDisplay, dateNum, winDates, bucket, bucketMinute, buyDi } = ctx;
    const isOffense = mode === 'offense';
    const allMembers = [];
    let lianbanAdded = []; // 防御池动态追加的历史涨停候选股（用于日志/文案）
    let lianbanDownDays = [];
    let hongliAdded = []; // 情绪游资（顺/逆周期）：防御池追加的红利板块连板候选股（用于日志/文案）
    let hongliBoards = []; // 命中的红利板块名
    if (isOffense) {
      for (const m of techPool) allMembers.push(m);
    } else {
      for (const tb of tagBlocks) for (const m of tb.members) allMembers.push(m);
      if (iceMode) {
        // 情绪游资（顺/逆周期共用）防御池扩展（2026-10-04 用户口径）：往前 20 个交易日内，
        // 属红利板块名单（hongliName.json）的板块中、出现过连板数 ≥ 3（三板及以上）的个股；
        // 与 tag 板块成分股合并去重后一起做 n 日涨幅最大筛选
        try {
          const hlKey = dateStr; // 同一回测日的 openPosition 可能被多次调用（重试），缓存结果
          if (!openPosition._hongliCache) openPosition._hongliCache = new Map();
          let hlResult;
          if (openPosition._hongliCache.has(hlKey)) {
            hlResult = openPosition._hongliCache.get(hlKey);
          } else {
            hlResult = await getHongliMultiLianbanStocks(dateStr);
            openPosition._hongliCache.set(hlKey, hlResult);
          }
          hongliBoards = hlResult.boards || [];
          const existCodes = new Set(allMembers.map(m => m.code));
          for (const s of hlResult.stocks || []) {
            if (!existCodes.has(s.code)) {
              allMembers.push(s);
              hongliAdded.push(s);
            }
          }
        } catch (e) { /* 红利连板候选获取失败，退化为仅 tag 板块 */ }
      } else {
        // 防御池扩展：往前 20 个交易日中创业板日跌幅 < -1% 的天，取涨停数最多的第一板块的所有股票
        // 与 tag 板块成分股合并去重后一起做 n 日涨幅最大筛选
        try {
          const lbKey = dateStr; // 同一回测日的 openPosition 可能被多次调用（重试），缓存结果
          if (!openPosition._lianbanCache) openPosition._lianbanCache = new Map();
          let lbResult;
          if (openPosition._lianbanCache.has(lbKey)) {
            lbResult = openPosition._lianbanCache.get(lbKey);
          } else {
            lbResult = await getHistoricalLianbanDefenseStocks(dateStr);
            openPosition._lianbanCache.set(lbKey, lbResult);
          }
          lianbanDownDays = lbResult.downDays || [];
          const tagCodes = new Set(allMembers.map(m => m.code));
          for (const s of lbResult.stocks || []) {
            if (!tagCodes.has(s.code)) {
              allMembers.push(s);
              lianbanAdded.push(s);
            }
          }
        } catch (e) { /* 历史涨停候选获取失败，退化为仅 tag 板块 */ }
      }
    }
    // 随机模拟：把随机抽取的真实科技股并入当前候选池一起参与 N 日涨幅最大筛选（进攻/防御池均注入，
    // 检验候选池被大量噪声股票稀释/干扰时的稳定性；这些股票日涨幅/分时均取自真实行情缓存）
    const simCtx = getSimContext();
    if (simCtx && Array.isArray(simCtx.codes) && simCtx.codes.length > 0) {
      const existCodes = new Set(allMembers.map(m => m.code));
      for (const code of simCtx.codes) {
        if (!existCodes.has(code)) allMembers.push({ code, name: (simCtx.nameByCode && simCtx.nameByCode.get(code)) || code });
      }
    }
    if (allMembers.length === 0) return false;
    // 逆周期情绪游资（防御池）抗分歧门槛：买入时点抗分歧指数需 ≥ GLOBAL_RESILIENCE_MIN。
    // 防御股不跟科技绑定的创业板指——主板跟踪上证指数 sh000001（创业板跟创业板指、科创板跟科创50），
    // 按候选实际市场预拉当日指数分时（按「日期+指数」进程内缓存，同日多次重试复用）
    let iceIndexPointsMap = null;
    if (iceMode && !isOffense) {
      const idxCodes = new Set(allMembers.map(m => iceResilienceIndexCode(m.code)));
      if (!openPosition._iceIndexCache) openPosition._iceIndexCache = new Map();
      iceIndexPointsMap = new Map();
      await Promise.all([...idxCodes].map(async (idxCode) => {
        const key = `${dateNum}|${idxCode}`;
        let pts = openPosition._iceIndexCache.get(key);
        if (!pts) {
          try {
            const it = await getSingleStockTlineDataByDate(idxCode, dateNum);
            pts = (it?.line || [])
              .filter(p => p && p.minute != null && p.last_px != null)
              .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
              .filter(p => p.lastPx > 0)
              .sort((a, b) => a.minute - b.minute);
          } catch (e) { pts = []; }
          openPosition._iceIndexCache.set(key, pts);
        }
        iceIndexPointsMap.set(idxCode, pts);
      }));
    }
    // 候选：进攻含自选股添加时间门禁（候选来自当前自选配置，防后加股票污染历史回测）；
    // 涨停判定取该桶时点当日涨幅；买入价从当日分时线现取（minute ≤ 该桶 minute 的最后一点），停牌/无分时个股自动跳过
    const candidateList = await batchParallel(allMembers, async (m) => {
      if (EXCLUDED_CODES.has(m.code)) return null;
      // 估值限制：总市值 < 200 亿 或 市盈率亏损 不买（情绪游资 iceMode 豁免；2026-10-13）
      if (!iceMode && isBuyBlockedByValuation(m.code)) return null;
      if (isOscExcluded(m.code)) return null; // 震荡测试：勾选隐藏的股票不参与选股
      if (isOffense && !isStockInWatchlistAt(m.code, dateStr, bucketMinute)) return null;
      // 逆周期情绪游资 1 日变体（iceRevIntradayGain）：排序依据 = 触发时点当日分时涨幅（下方 changePct），
      // 不用 N 日窗口涨幅；此处仅放占位值 0 通过校验
      const gain = iceRevIntradayGain ? 0 : stockWindowGain(m.code, winDates);
      if (gain == null || !Number.isFinite(gain)) return null;
      let tline = null;
      try {
        tline = await getSingleStockTlineDataByDate(m.code, dateNum);
      } catch (e) {
        return null;
      }
      const preclose = tline?.preclose_px != null ? parseFloat(tline.preclose_px) : null;
      const points = (tline?.line || [])
        .filter(p => p && p.minute != null && p.last_px != null)
        .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px), change: p.change != null ? parseFloat(p.change) : 0 }))
        .filter(p => p.lastPx > 0 && p.minute <= bucketMinute)
        .sort((a, b) => a.minute - b.minute);
      const atBucket = points.length > 0 ? points[points.length - 1] : null;
      if (!atBucket) return null;
      const changePct = preclose && preclose > 0
        ? parseFloat((((atBucket.lastPx - preclose) / preclose) * 100).toFixed(2))
        : null;
      // 逆周期情绪游资：按候选市场跟踪指数现算买入时点抗分歧分数（主板跟踪上证指数，非创业板指）
      let iceResilience = null;
      let iceIndexCode = null;
      if (iceIndexPointsMap) {
        iceIndexCode = iceResilienceIndexCode(m.code);
        const idxPoints = (iceIndexPointsMap.get(iceIndexCode) || []).filter(p => p.minute <= bucketMinute);
        if (points.length >= 5 && idxPoints.length >= 5) {
          const raw = calculateReplayResilience(points, idxPoints, m.code);
          if (raw != null) iceResilience = parseFloat(Number(raw).toFixed(2));
        }
      }
      // 上一交易日一字板过滤（全策略通用，2026-10-05 新增）：昨日一字板（开盘/收盘/最低涨幅均达阈值，
      // 主板 9.5%、创业/科创 19.5%）的候选次日不买；数据不足（null）不拦截
      let prevOneWord = null;
      try {
        prevOneWord = isPrevDayOneWordBoard(m.code, await getKlineCached(m.code, dateStr), dateStr);
      } catch (e) { prevOneWord = null; }
      // 逆周期情绪游资 1 日变体：排序依据改为触发时点当日分时涨幅（changePct），无昨收/无有效涨幅则剔除
      const sortGain = iceRevIntradayGain ? changePct : gain;
      if (iceRevIntradayGain && (sortGain == null || !Number.isFinite(sortGain))) return null;
      return { code: m.code, name: m.name || m.code, gain: sortGain, lastPx: atBucket.lastPx, changePct, limitUp: isLimitUpAtBuy(m.code, changePct), prevOneWord: prevOneWord === true, iceResilience, iceIndexCode };
    }, 8);
    const candidates = candidateList.filter(Boolean);
    candidates.sort((a, b) => b.gain - a.gain); // 并列涨幅保持配置顺序（batchParallel 保序）
    // 逆周期情绪游资：叠加抗分歧门槛（≥ GLOBAL_RESILIENCE_MIN）——不满足的按涨幅排名顺延至下一只，
    // 全部候选（涨停或抗分歧不足）均不可买时本桶不买、后续桶继续重试
    const iceResilienceSkipped = [];
    const best = candidates.find(c => {
      if (c.limitUp) return false;
      // 上一交易日一字板过滤（全策略通用）：昨日一字板的候选次日不买，顺延至排名下一只
      if (c.prevOneWord) return false;
      if (iceMode && c.iceResilience != null && c.iceResilience < GLOBAL_RESILIENCE_MIN) {
        iceResilienceSkipped.push(c);
        return false;
      }
      return true;
    }) || null;
    if (!best) return false; // 全部候选涨停/无有效候选：调用方在后续桶继续重试

    if (!seenStocks.has(best.code)) seenStocks.set(best.code, { code: best.code, name: best.name });
    const blocksText = tagBlocks.map(tb => `${tb.blockName}[${tb.tag}]`).join('、');
    const slopeText = `${toValue > 0 ? '+' : ''}${Number(toValue).toFixed(2)}`;
    const fromText = fromValue == null ? '无（首值）' : `${fromValue > 0 ? '+' : ''}${Number(fromValue).toFixed(2)}`;
    const triggerTimeText = fmtTime(bucket.timeKey);
    // 选股依据文案（逆周期情绪游资 1 日变体＝当日分时涨幅；其余＝最近 N 日涨幅之和）
    const gainBasisText = iceRevIntradayGain ? '当日分时涨幅（触发时点实时涨幅）' : `${days} 日涨幅`;
    const gateReasonMap = {
      slope_turn_positive: `创业板指 3 日线斜率在 ${triggerTimeText} 由负转正（${fromText} → ${slopeText}）：进攻买点触发，不看资金/量能/情绪等任何配合条件，买入自选科技股中 ${days} 日涨幅最大的一只`,
      slope_turn_negative: `创业板指 3 日线斜率在 ${triggerTimeText} 由正转负（${fromText} → ${slopeText}）且当前空仓：防御买点触发，买入防御+中性 tag 板块 ∪ 近20交易日创业板下跌日的涨停前3板块 ∩ 20日有≥3连板个股中 ${days} 日涨幅最大的一只`,
      ice_slope_turn_positive: `上证指数 3 日线斜率由负转正（${fromText} → ${slopeText}）且当前空仓、前一交易日收盘口径斜率为负：顺周期情绪游资买点触发，在 ${triggerTimeText} 执行买入（转正当日起至少等 9:40，给抗分歧分数留出分时计算窗口），买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${gainBasisText}最大的一只`,
      retry_next_day_940: `进攻持仓按卖点诊断卖出后，卖出当时 3 日线斜率仍为正（${fromText}），当日不继续买；次日开盘 10 分钟后（${triggerTimeText}，9:40 桶）复测斜率仍为正（${slopeText}），继续买入自选科技股中 ${days} 日涨幅最大的一只`,
      ice_next_day_940: `前一交易日上证指数 3 日线斜率由负转正，今日开盘 10 分钟后（${triggerTimeText}，9:40 桶）仍空仓补买：顺周期情绪游资买点触发，买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${gainBasisText}最大的一只`,
      ice_rev_next_day_940: `前一交易日（${fmtCybGateDate(pendingEntry?.armDate)}）上证指数 3 日线斜率盘中由正转负（${fromText} → ${slopeText}），今日开盘 10 分钟后（${triggerTimeText}，9:40 桶）斜率依旧为负且仍空仓：逆周期情绪游资买点触发，买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${gainBasisText}最大的一只`,
    };
    const modeGateCheck = {
      id: 'key_block_cyb_gate',
      title: iceMode
        ? (trigger === 'ice_rev_next_day_940'
          ? '转负次日 9:40 斜率依旧为负、空仓（逆周期情绪游资买点）'
          : trigger === 'ice_next_day_940'
            ? '转正次日 9:40 空仓补买（顺周期情绪游资买点）'
            : '上证指数3日线斜率由负转正且空仓（顺周期情绪游资买点，9:40 及以后执行）')
        : (trigger === 'retry_next_day_940'
          ? '次日开盘10分钟后斜率复测（进攻买点）'
          : `创业板指3日线斜率${isOffense ? '由负转正（进攻买点）' : '由正转负且空仓（防御买点）'}`),
      passed: true,
      value: iceMode
        ? `${triggerTimeText} ${slopeText}（前一日收盘 ${fmtKeyBlockSlope(icePrevCloseSlope)}）`
        : `${triggerTimeText} ${slopeText}`,
      reason: gateReasonMap[trigger] || gateReasonMap.slope_turn_positive,
    };
    const poolCheck = isOffense ? {
      id: 'key_block_watchlist_tech',
      title: '自选科技股筛选（进攻）',
      passed: true,
      value: `${techPool.length} 只`,
      reason: `进攻候选 = 自选股（monitor_stocks.json）中 isTech ≠ false 的科技股共 ${techPool.length} 只（剔除排除股；含自选股添加时间门禁）`,
    } : (() => {
      const tagCount = tagBlocks.reduce((s, tb) => s + tb.members.length, 0);
      // 顺/逆周期情绪游资共用：防御+中性 tag 板块 ∪ 红利板块三板及以上连板扩展
      if (iceMode) {
        const hongliInfo = hongliAdded.length > 0
          ? `；红利板块连板扩展 = 往前20交易日出现三板及以上连板的红利板块（${hongliBoards.join('、') || '无'}）个股，与Tag板块去重后新增 ${hongliAdded.length} 只`
          : `；红利板块连板扩展 = 往前20交易日无符合条件（三板及以上）的红利板块个股（或均已在 tag 板块）`;
        return {
          id: 'key_block_tag_blocks',
          title: `${iceName}候选池（防御+中性 Tag板块 ∪ 红利板块三板及以上·全仓）`,
          passed: true,
          value: `${tagBlocks.length} 个Tag板块 ${tagCount} 只 + 红利板块 ${hongliAdded.length} 只`,
          reason: `参与选股的防御+中性 tag 板块 ${tagBlocks.length} 个：${blocksText}${hongliInfo}；合并去重后共 ${allMembers.length} 只候选`,
        };
      }
      const lbInfo = lianbanAdded.length > 0
        ? `；历史涨停扩展 = 往前20交易日中创业板日跌幅<-1%的 ${lianbanDownDays.length} 天涨停前3板块 ∩ 20日有≥3连板个股，与Tag板块去重后新增 ${lianbanAdded.length} 只（下跌日：${lianbanDownDays.join('、') || '无'}）`
        : `；历史涨停扩展 = 往前20交易日中创业板日跌幅<-1%的天数 = ${lianbanDownDays.length}，均已在 tag 板块或无数据，无新增`;
      return {
        id: 'key_block_tag_blocks',
        title: '防御候选池（Tag板块 + 历史涨停扩展）',
        passed: true,
        value: `${tagBlocks.length} 个Tag板块 ${tagCount} 只 + 涨停扩展 ${lianbanAdded.length} 只`,
        reason: `参与选股的防御+中性 tag 板块 ${tagBlocks.length} 个：${blocksText}${lbInfo}；合并去重后共 ${allMembers.length} 只候选`,
      };
    })();
    const limitUpSkipped = candidates.filter(c => c.limitUp && c.gain > best.gain);
    // 上一交易日一字板过滤明细（全策略通用，2026-10-05 新增）：记录排名高于最终买入的一字板候选
    const oneWordSkipped = candidates.filter(c => c.prevOneWord && c.gain > best.gain);
    const oneWordBoardCheck = {
      id: 'one_word_board_defer',
      title: '上一交易日一字板过滤（主板≥8%、创业/科创≥16%）',
      passed: true,
      value: oneWordSkipped.length > 0 ? `顺延 ${oneWordSkipped.length} 只` : '无一字板候选',
      skippedStocks: oneWordSkipped.map(c => ({ code: c.code, name: c.name })),
      reason: oneWordSkipped.length > 0
        ? `上一交易日一字板候选已剔除并顺延：${oneWordSkipped.map(c => (c.changePct != null ? `${c.name} +${c.changePct}%` : c.name)).join('、')}；${days} 日涨幅排名后延至 ${best.name}（昨日开盘/收盘/最低涨幅均达涨停阈值，全天封死一字板，次日不买）`
        : `买入时点候选中无上一交易日一字板股（主板开盘/收盘/最低涨幅均≥8%、创业/科创均≥16% 视为一字板；一字板次日不买，顺延排名下一只）`,
    };
    const limitUpCheck = {
      id: 'key_block_limit_up',
      title: '涨停过滤（主板>9.5%、创业/科创>19%）',
      passed: true,
      value: limitUpSkipped.length > 0 ? `顺延 ${limitUpSkipped.length} 只` : '无涨停候选',
      reason: limitUpSkipped.length > 0
        ? `买入时点（${triggerTimeText}）涨停候选已剔除并顺延：${limitUpSkipped.map(c => (c.changePct != null ? `${c.name} +${c.changePct}%` : c.name)).join('、')}；${days} 日涨幅排名后延至 ${best.name}`
        : `买入时点候选中无涨停股（主板涨幅 >9.5%、创业板/科创板 >19% 视为涨停；涨停股不可买，顺延排名下一只）`,
    };
    // 逆周期情绪游资专属：抗分歧 ≥ 9 门槛（主板跟踪上证指数 sh000001，非创业板指）
    const iceResilienceCheck = iceMode ? {
      id: 'ice_resilience_gate',
      title: `抗分歧门槛（买入时点 ≥ ${GLOBAL_RESILIENCE_MIN}，主板跟踪上证指数）`,
      passed: true,
      value: `${best.iceResilience != null ? Number(best.iceResilience).toFixed(2) : '数据不足'}（${iceIndexName(best.iceIndexCode)}）`,
      reason: `买入时点抗分歧指数需 ≥ ${GLOBAL_RESILIENCE_MIN}：${best.name}(${best.code}) 跟踪${iceIndexName(best.iceIndexCode)}，抗分歧 ${best.iceResilience != null ? Number(best.iceResilience).toFixed(2) : '数据不足（放行）'}${iceResilienceSkipped.length > 0 ? `；前序已顺延抗分歧不足的 ${iceResilienceSkipped.length} 只（${iceResilienceSkipped.map(c => `${c.name} ${Number(c.iceResilience).toFixed(2)}`).join('、')}）` : ''}（防御股不跟科技绑定的创业板指：主板跟踪上证指数 sh000001，创业板跟 sz399006，科创板跟 sh000688）`,
    } : null;
    const bestCheck = {
      id: 'key_block_best_stock',
      title: iceRevIntradayGain
        ? '候选池内当日分时涨幅最大（触发时点实时涨幅）的股票'
        : `${isOffense ? '自选科技股' : (iceMode ? '防御+中性 Tag板块∪红利连板' : '防御候选池(Tag板块+涨停扩展)')}内最近${days}日涨幅最大的股票`,
      passed: true,
      value: `${best.gain > 0 ? '+' : ''}${best.gain.toFixed(2)}%`,
      reason: `在${isOffense ? `自选科技股池共 ${allMembers.length} 只` : (iceMode ? `防御+中性 tag 板块 ∪ 红利板块三板及以上候选股共 ${allMembers.length} 只（其中红利板块扩展 ${hongliAdded.length} 只）` : `防御候选池共 ${allMembers.length} 只（Tag板块 + 历史涨停扩展 ${lianbanAdded.length} 只）`)}中（有效候选 ${candidates.length} 只，已剔除 20日涨幅≤30%/流通市值>100亿/买点时刻涨幅≥3% 者），${iceRevIntradayGain ? '按触发时点当日分时涨幅（较昨收的实时涨幅）取最大' : `按最近 ${days} 日个股涨幅之和取最大`}${limitUpSkipped.length > 0 ? '（涨停股顺延后）' : ''}${iceResilienceSkipped.length > 0 ? `（抗分歧不足顺延 ${iceResilienceSkipped.length} 只后）` : ''}；买入价取 ${triggerTimeText} 分时价`,
    };
    const buyReasonMap = {
      slope_turn_positive: `${triggerTimeText.substring(0, 5)}创业板指3日线斜率由负转正（${fromText}→${slopeText}），买入自选科技股池内${days}日涨幅最大的股票（进攻买点，无需资金/量能配合）`,
      slope_turn_negative: `${triggerTimeText.substring(0, 5)}创业板指3日线斜率由正转负（${fromText}→${slopeText}）且空仓，买入防御候选池（Tag板块 + 近20交易日创业板下跌日涨停前3板块 ∩ 20日有≥3连板个股）内${days}日涨幅最大的股票（防御买点）`,
      ice_slope_turn_positive: `${triggerTimeText.substring(0, 5)}上证指数3日线斜率由负转正（${fromText}→${slopeText}）且空仓、前一交易日收盘口径斜率为负，买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${gainBasisText}最大的股票（顺周期情绪游资买点，9:40 及以后执行）`,
      retry_next_day_940: `${triggerTimeText.substring(0, 5)}开盘10分钟后复测创业板指3日线斜率仍为正（${slopeText}，卖出当时${fromText}），买入自选科技股池内${days}日涨幅最大的股票（卖点诊断卖出后次日复测继续买）`,
      ice_next_day_940: `${triggerTimeText.substring(0, 5)}前一交易日上证指数3日线斜率由负转正，今日开盘10分钟后（9:40 桶）仍空仓补买（上证指数3日线斜率 ${slopeText}），买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${gainBasisText}最大的股票（顺周期情绪游资次日9:40补买）`,
      ice_rev_next_day_940: `${triggerTimeText.substring(0, 5)}前一交易日上证指数3日线斜率盘中由正转负（${fromText}→${slopeText}），今日开盘10分钟后（9:40 桶）斜率依旧为负且仍空仓，买入防御+中性 tag 板块 ∪ 近20交易日出现三板及以上连板的红利板块个股中${gainBasisText}最大的股票（逆周期情绪游资买点，转负次日9:40）`,
    };
    position = {
      code: best.code,
      stockName: best.name,
      mode: isOffense ? 'offense' : 'defense',
      buyDate: dateStr,
      buyDateDisplay: dateDisplay,
      buyTime: triggerTimeText.substring(0, 5),
      buyPrice: parseFloat(Number(best.lastPx).toFixed(2)),
      buyChange: best.changePct != null ? parseFloat(Number(best.changePct).toFixed(2)) : null,
      metric: parseFloat(best.gain.toFixed(4)),
      costLinePct: Number(strategy.costLinePct) || 2,
      buyReason: buyReasonMap[trigger] || buyReasonMap.slope_turn_positive,
      buyChecks: [modeGateCheck, poolCheck, limitUpCheck, oneWordBoardCheck, ...(iceResilienceCheck ? [iceResilienceCheck] : []), bestCheck],
    };
    return true;
  };

  for (let di = 0; di < total; di++) {
    const dateStr = rangeDates[di];
    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'loading' });
    let campData;
    try {
      // 所有策略统一允许缺失资金快照的日期用兜底（.nomfund）回放数据构建（此前仅 ice/emoAvg 开放）：
      // 这类日期（如 20260730 快照缺失）整日跳过会导致当日止损/斜率翻转等卖点判定全部漏执行，
      // 前一日买入的持仓被迫等到下一个有快照的交易日才能卖出；兜底构建仅缺 fundFlow/成交量字段，
      // 卖出所需分时/情绪数据齐全，买入的量能条件在无成交量数据时自然判不通过（当日不新买入）
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
    await injectSimStocksIntoCampData(campData, dateStr); // 随机模拟：把合成股票混入当日候选池（重点板块/情绪游资系列）
    const replayStocks = await buildReplayStocksWithTline(campData, dateStr);
    const dateDisplay = campData.dateDisplay || dateStr;
    dailyInfos.set(dateStr, extractDailyInfo(campData, dateStr));
    for (const bucket of timeBuckets) {
      for (const sc of bucket.stockChanges) {
        if (EXCLUDED_CODES.has(sc.code)) continue;
        if (!seenStocks.has(sc.code)) seenStocks.set(sc.code, { code: sc.code, name: sc.name || sc.code });
      }
    }

    if (onProgress) onProgress({ current: di + 1, total, date: dateStr, status: 'running' });

    // 当日隔夜持仓卖出数据预建（当日买入次日才可卖，同日买入不可同日卖出）：
    //   进攻持仓 → 通用 7 条件卖点诊断所需的日收盘斜率门禁（「科技板块情绪退潮」条件）+ 非自选股合成逐桶数据
    // 防御持仓 → 持仓股当日分时（卖点：斜率翻转当桶 ∪ 个股分时价跌破成本线止损 -5%/-2% ∪ 情绪游资 14:55 长下影强卖）
    let sellBuckets = timeBuckets;
    let sellReplayStocks = replayStocks;
    let cybMa3SlopeForGate = null;
    let defensePoints = null;
    let defensePreclose = null;
    if (position && dateStr > position.buyDate) {
      if (position.mode === 'offense') {
        cybMa3SlopeForGate = await getKeyBlockCybMa3Slope(dateStr);
        // 非自选股持仓：回放数据无该股，为卖出诊断合成逐桶 stockChanges 与 replayStocks 条目
        // （仅浅拷贝桶并追加条目，不改动共享回放缓存；合成失败当日安全跳过，次日重试）
        const hasRealEntry = timeBuckets.some(b => (b.stockChanges || []).some(sc => sc.code === position.code));
        if (!hasRealEntry) {
          const synth = await buildKeyBlockSyntheticDay(position.code, position.stockName, dateStr);
          if (synth) {
            sellBuckets = timeBuckets.map(b => {
              const entry = buildKeyBlockSyntheticBucketEntry(position.code, position.stockName, synth.sortedPoints, synth.maInfo, synth.r3d, Number(b.minute));
              return entry ? { ...b, stockChanges: [...(b.stockChanges || []), entry] } : b;
            });
            sellReplayStocks = [...replayStocks, synth.replayEntry];
          }
        }
      } else {
        try {
          const tline = await getSingleStockTlineDataByDate(position.code, parseInt(dateStr, 10));
          defensePreclose = tline?.preclose_px != null ? parseFloat(tline.preclose_px) : null;
          defensePoints = (tline?.line || [])
            .filter(p => p && p.minute != null && p.last_px != null)
            .map(p => ({ minute: parseInt(p.minute), lastPx: parseFloat(p.last_px) }))
            .filter(p => p.lastPx > 0)
            .sort((a, b) => a.minute - b.minute);
          } catch (e) {
            defensePoints = null; // 分时拉取失败当日安全跳过卖出（次日重试）
          }
        }
    }

    const diA = di + axisOffset;
    const winDates = diA + 1 >= days ? dateAxis.slice(diA + 1 - days, diA + 1) : [];
    const dateNum = parseInt(dateStr, 10);
    // 情绪游资系列：前一交易日「收盘口径」上证指数 3 日线斜率。
    // 顺周期：出手门禁要求「前一日收盘斜率为负、今日盘中才转正」才算一次有效买点（前一日已为正则今日盘中 −→+ 不计）；
    // 逆周期（iceReverse）：门禁镜像为「前一日收盘斜率为正、今日盘中才转负」（前一日已为负则今日盘中 +→− 不计）
    const icePrevCloseSlope = iceMode && diA - 1 >= 0 ? await getIceMa3Slope(dateAxis[diA - 1]) : null;

    // 逐桶状态机（2026-10-01 重构）：
    //   ① 盘中实时斜率（null 桶不参与翻转识别，符号基准跨缺失桶连续）→ 识别由负转正/由正转负
    //   ② 卖出：防御持仓遇斜率翻转或「个股跌破成本线止损（重点板块 -5% / 情绪游资 -2%）」即按分时价卖出；进攻持仓走通用 7 条件卖点诊断，
    //          卖出后斜率仍为正则当日不再追买（offenseBlockDate），挂次日 9:40 复测意图
    //   ③ 空仓时翻转事件生成入场意图：由正转负→防御（独立规则，即使刚卖出也生效）；
    //          由负转正→进攻（进攻卖出当日除外）；同桶允许先卖后买转手
    //   ④ 按意图建仓：9:40 复测意图仅在 ≥9:40 且斜率仍为正的桶执行；候选全部不可买时后续桶持续重试
    for (let bi = 0; bi < timeBuckets.length; bi++) {
      const bucket = timeBuckets[bi];
      const bucketMinute = Number(bucket.minute);
      // 逆周期情绪游资改用上证指数 3 日线斜率（方向相反：为正买、为负卖）
      const slopeNow = iceMode
        ? await getIceMa3SlopeIntraday(dateStr, bucketMinute)
        : await getKeyBlockCybMa3SlopeIntraday(dateStr, bucketMinute);
      const signNow = slopeNow == null ? null : (slopeNow > 0 ? 1 : -1);
      const turnedPositive = lastSlopeSign !== null && signNow === 1 && lastSlopeSign === -1;
      const turnedNegative = lastSlopeSign !== null && signNow === -1 && lastSlopeSign === 1;

      // ===== ② 卖出（仅隔夜持仓） =====
      if (position && dateStr > position.buyDate) {
        if (position.mode === 'defense' && defensePoints && defensePoints.length > 0) {
          // 防御卖点：① 斜率翻转的当桶 ② 个股分时价跌破成本线止损 ③（情绪游资）14:55 长下影强卖
          //   重点板块防御持仓 → -5%（KEY_BLOCK_DEFENSE_STOP_LOSS_PCT）；情绪游资（顺/逆周期）→ -2%（策略 costLinePct）
          // 任一先触发即卖出；止损在每个桶都会检查（因为不依赖斜率翻转事件）
          // 竞价低开自救窗口（2026-10-05 新增；2026-10-08 修订，仅作用于成本线止损）：当日竞价开盘价（首分钟价）已跌破
          //   成本线止损线时，不在 9:30 直接止损——大低开往往开盘先直线拉升（资金自救），逐分钟跟踪：
          //   拉升过程中（尚未出现「某分钟价低于上一分钟」的回落）继续持有（即使仍在成本线下方）；
          //   若拉升回补至阈值上方则视为自救成功、不再止损，待后续再次跌破阈值时再卖；
          //   只有当「拉升结束、开始回落」且该回落分钟价仍跌破阈值时，才卖出（成交价/时间取该回落点，精确到分钟）。
          //   若开盘未破线、盘中才跌破 → 即时止损（桶级触发后逐分钟回溯定位首次跌破分钟，按该分钟分时价成交）。
          const stopLossPct = iceMode
            ? (position.costLinePct != null ? Number(position.costLinePct) : 2)
            : KEY_BLOCK_DEFENSE_STOP_LOSS_PCT;
          let atPt = null;
          let atPtIdx = -1;
          for (let pi = 0; pi < defensePoints.length; pi++) {
            if (defensePoints[pi].minute <= bucketMinute) { atPt = defensePoints[pi]; atPtIdx = pi; } else break;
          }
          if (atPt) {
            const rawReturnRate = position.buyPrice > 0
              ? parseFloat((((atPt.lastPx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
              : null;
            const defenseCostLineThreshold = position.buyPrice > 0 ? position.buyPrice * (1 - stopLossPct / 100) : null;
            const defenseOpenPx = defensePoints[0].lastPx;
            const openBrokeCostLine = defenseCostLineThreshold != null && defenseOpenPx != null && defenseOpenPx > 0 && defenseOpenPx < defenseCostLineThreshold;
            // 自救窗口观察：在 minute ≤ 当前桶的分时点中找首个「分钟价低于上一分钟、且该分钟价仍跌破阈值」的回落点
            //（拉升已回补至阈值上方的回落不计入；待再次跌破阈值并回落才触发）
            let openBreakFirstDecline = null;
            let openBreakFirstDeclinePrev = null;
            if (openBrokeCostLine) {
              for (let pi = 1; pi < defensePoints.length; pi++) {
                if (defensePoints[pi].minute > bucketMinute) break;
                if (defensePoints[pi].lastPx < defensePoints[pi - 1].lastPx && defensePoints[pi].lastPx < defenseCostLineThreshold) {
                  openBreakFirstDecline = defensePoints[pi];
                  openBreakFirstDeclinePrev = defensePoints[pi - 1];
                  break;
                }
              }
            }
            const fmtMinuteD = (m) => `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`;
            // 开盘已破线 → 成本线止损被自救窗口规则取代（回补至阈值上方则不再止损；回落且仍跌破阈值才卖）；开盘未破线 → 原即时止损
            const stopLossHit = !openBrokeCostLine && rawReturnRate != null && rawReturnRate <= -stopLossPct;
            const openBreakSellHit = openBrokeCostLine && openBreakFirstDecline != null;
            // 精确分钟回溯（2026-10-05 新增）：桶级触发成本线卖出后，逐分钟回溯定位真实触发分钟并按该分钟分时价成交
            //（线上环境在触发当分钟即已卖出，桶级成交最多晚 4 分钟，回溯后回测更贴近实盘）：
            //   - 盘中破线止损：从桶前一分钟向回逐分钟检查是否仍跌破阈值（口径与触发一致：较买入价跌幅 ≤ -stopLossPct%），
            //     直到首次不跌破（或回溯至 9:30 开盘）为止，取连续跌破区间最早一分钟为成交分钟；
            //     破线就发生在当前桶（前一分钟未跌破）→ 维持按桶价成交；
            //   - 开盘破线（自救窗口）：成交价/时间由桶改为「回落且仍跌破阈值」的回落点（与线上在回落当分钟立即卖出一致）；
            //     斜率翻转 / 14:55 长下影卖点不回溯，仍按当桶分时价成交。
            let preciseSellPt = null;
            if (stopLossHit) {
              for (let pw = atPtIdx - 1; pw >= 0; pw--) {
                const px = defensePoints[pw].lastPx;
                if (!(position.buyPrice > 0) || !(((px - position.buyPrice) / position.buyPrice) * 100 <= -stopLossPct)) break;
                preciseSellPt = defensePoints[pw];
              }
            } else if (openBreakSellHit) {
              preciseSellPt = openBreakFirstDecline;
            }
            const sellPtFinal = preciseSellPt || atPt;
            // 情绪游资卖点斜率方向：顺周期＝斜率由正转负卖出；逆周期（iceReverse）＝斜率由负转正当桶卖出（与重点板块防御口径相同、与顺周期情绪游资相反）
            const slopeSellHit = iceMode ? (iceReverse ? turnedPositive : turnedNegative) : turnedPositive;
            // 情绪游资新增卖点（2026-10-04 用户新增）：当日 14:55 检查 K 线形态——
            // 下影线 ≥ 实体长度的 2 倍（长下影＝盘中被砸后拉起、上方承压）→ 14:55 强制卖出。
            // 仅用 minute ≤ 1455 的当日分时点现算（无未来数据）：开=首个分时价，收=14:55 价，低=区间 min。
            let shadowSellHit = false;
            let shadowInfo = null;
            if (iceMode && bucketMinute === 1455) {
              const pts = defensePoints.filter(p => p.minute <= 1455 && p.lastPx > 0);
              if (pts.length > 0) {
                const openPx = pts[0].lastPx;
                const closePx = pts[pts.length - 1].lastPx;
                const lowPx = pts.reduce((mn, p) => Math.min(mn, p.lastPx), Infinity);
                const body = Math.abs(closePx - openPx);
                const lowerShadow = Math.min(openPx, closePx) - lowPx;
                if (lowerShadow > 0 && lowerShadow >= 2 * body) {
                  shadowSellHit = true;
                  shadowInfo = {
                    openPx: parseFloat(openPx.toFixed(2)),
                    closePx: parseFloat(closePx.toFixed(2)),
                    body: parseFloat(body.toFixed(2)),
                    lowerShadow: parseFloat(lowerShadow.toFixed(2)),
                  };
                }
              }
            }
            if (slopeSellHit || stopLossHit || shadowSellHit || openBreakSellHit) {
              const finalRawReturnRate = position.buyPrice > 0
                ? parseFloat((((sellPtFinal.lastPx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
                : rawReturnRate;
              const sellChange = defensePreclose && defensePreclose > 0
                ? parseFloat((((sellPtFinal.lastPx - defensePreclose) / defensePreclose) * 100).toFixed(2))
                : null;
              // 防御半仓折算：个股实际收益 × 0.5 才是对全仓账户的收益贡献（回撤/整体收益均按折算口径）
              // 逆周期情绪游资（iceMode）为全仓买入，不做折算
              const weight = iceMode ? 1 : KEY_BLOCK_POSITION_WEIGHT.defense;
              const returnRate = finalRawReturnRate != null ? parseFloat((finalRawReturnRate * weight).toFixed(2)) : null;
              const slopeTurnText = iceMode
                ? (iceReverse
                  ? `${ICE_SIGNAL_INDEX_NAME}3日线斜率盘中由负转正（${fmtKeyBlockSlope(lastSlopeValue)} → ${fmtKeyBlockSlope(slopeNow)}）`
                  : `${ICE_SIGNAL_INDEX_NAME}3日线斜率盘中由正转负（${fmtKeyBlockSlope(lastSlopeValue)} → ${fmtKeyBlockSlope(slopeNow)}）`)
                : `创业板指3日线斜率盘中由负转正（${fmtKeyBlockSlope(lastSlopeValue)} → ${fmtKeyBlockSlope(slopeNow)}）`;
              const sellTrigger = slopeSellHit
                ? slopeTurnText
                : shadowSellHit
                  ? `当日 14:55 下影线 ${shadowInfo.lowerShadow.toFixed(2)} ≥ 实体长度 ${shadowInfo.body.toFixed(2)} 的 2 倍（开 ${shadowInfo.openPx.toFixed(2)} → 14:55 价 ${shadowInfo.closePx.toFixed(2)}），K 线形态走坏强制卖出`
                  : openBreakSellHit
                    ? `竞价开盘 ${defenseOpenPx.toFixed(2)} 已跌破成本线 -${stopLossPct}%（阈值 ${defenseCostLineThreshold.toFixed(2)}），不在 9:30 直接止损、等待开盘自救拉升；${fmtMinuteD(openBreakFirstDecline.minute)} 价 ${openBreakFirstDecline.lastPx.toFixed(2)} 低于 ${fmtMinuteD(openBreakFirstDeclinePrev.minute)} 价 ${openBreakFirstDeclinePrev.lastPx.toFixed(2)} 且仍跌破阈值，自救拉升结束回落即卖出，按回落分钟 ${fmtMinuteD(sellPtFinal.minute)} 价格 ${parseFloat(Number(sellPtFinal.lastPx).toFixed(2))} 成交（较成本 ${finalRawReturnRate}%，桶级触发于 ${fmtMinuteD(atPt.minute)}）`
                    : (preciseSellPt != null
                      ? `持仓个股分时价跌破成本线 -${stopLossPct}% 止损（成本 ${position.buyPrice.toFixed(2)}，桶级触发现价 ${parseFloat(Number(atPt.lastPx).toFixed(2))}）；逐分钟回溯：实际于 ${fmtMinuteD(preciseSellPt.minute)} 首次跌破（价 ${parseFloat(Number(preciseSellPt.lastPx).toFixed(2))}，较成本 ${finalRawReturnRate}%），按该分钟价格成交`
                      : `持仓个股分时价跌破成本线 -${stopLossPct}% 止损（成本 ${position.buyPrice.toFixed(2)} → 现价 ${parseFloat(Number(atPt.lastPx).toFixed(2))}，浮亏 ${finalRawReturnRate}%；破线发生在当前桶，按桶价成交）`);
              trades.push({
                seq: trades.length + 1,
                metric: position.metric,
                code: position.code,
                stockName: position.stockName,
                positionMode: position.mode,
                weight,
                buyDate: position.buyDate,
                buyDateDisplay: position.buyDateDisplay,
                buyTime: position.buyTime,
                buyPrice: position.buyPrice,
                buyChange: position.buyChange,
                buyReason: position.buyReason,
                buyChecks: position.buyChecks,
                sellDate: dateStr,
                sellDateDisplay: dateDisplay,
                sellTime: `${String(Math.floor(sellPtFinal.minute / 100)).padStart(2, '0')}:${String(sellPtFinal.minute % 100).padStart(2, '0')}`,
                sellPrice: parseFloat(Number(sellPtFinal.lastPx).toFixed(2)),
                sellChange,
                sellReason: iceMode
                  ? `${sellTrigger}，${iceName}持仓卖出（全仓买入）`
                  : `${sellTrigger}，防御半仓持仓卖出（防御为半仓买入，收益率按半仓折算）`,
                returnRate,
                rawReturnRate: finalRawReturnRate,
              });
              position = null;
            }
          }
        } else if (position.mode === 'offense') {
          // 进攻卖点：通用 7 条件卖点诊断（条件7 跌破成本线 -2%；「科技板块情绪退潮」受日收盘斜率>0 门禁）
          const pos = { code: position.code, stockName: position.stockName, buyPrice: position.buyPrice, buyDate: position.buyDate, costLinePct: position.costLinePct, keyBlockCybMa3Slope: cybMa3SlopeForGate };
          const result = await runSellPointDiagnosis(pos, sellBuckets[bi], sellReplayStocks, sellBuckets, bi, dateStr);
          if (result.isSell && result.closePrice != null) {
            const satisfiedNames = result.conditions.filter(c => c.satisfied).map(c => c.name).join('、');
            const weight = KEY_BLOCK_POSITION_WEIGHT.offense;
            const rawReturnRate = result.returnRate != null && Number.isFinite(Number(result.returnRate))
              ? parseFloat(Number(result.returnRate).toFixed(2))
              : result.returnRate;
            trades.push({
              seq: trades.length + 1,
              metric: position.metric,
              code: position.code,
              stockName: position.stockName,
              positionMode: position.mode,
              weight,
              buyDate: position.buyDate,
              buyDateDisplay: position.buyDateDisplay,
              buyTime: position.buyTime,
              buyPrice: position.buyPrice,
              buyChange: position.buyChange,
              buyReason: position.buyReason,
              buyChecks: position.buyChecks,
              sellDate: dateStr,
              sellDateDisplay: dateDisplay,
              sellTime: result.displayTime,
              sellPrice: result.closePrice,
              sellChange: result.change,
              sellReason: satisfiedNames || '卖出条件触发',
              returnRate: rawReturnRate,
              rawReturnRate,
            });
            position = null;
            // 卖出后斜率仍为正：当日不再继续买，次日开盘 10 分钟后（9:40 桶）复测仍为正才再买
            // （卖出时斜率为负且本桶由正转负的情形，交由下方③的防御事件处理）
            if (signNow === 1) {
              pendingEntry = { mode: 'offense', trigger: 'retry_next_day_940', armDate: dateStr, fromValue: slopeNow, toValue: slopeNow };
              offenseBlockDate = dateStr;
            }
          }
        }
      }

      // ===== ③ 空仓时由翻转事件生成/覆盖入场意图 =====
      if (!position) {
        if (iceMode) {
          if (iceReverse) {
            // 逆周期情绪游资（2026-10-10 新增，与顺周期完全镜像）：上证 3 日线斜率「由正转负」为买点信号，
            //   出手在转负的次一交易日 9:40（且斜率依旧为负）：
            //   ① 仅当「前一交易日收盘口径斜率为正」时，今日盘中由正转负才算一次有效转负事件；
            //      前一日收盘已为负时，今日盘中的 +→− 不算买点（不生成/不覆盖意图，继续空仓等待）
            //   ② 斜率「由负转正」是卖点信号，同时作废尚未成交的买点意图
            // armDate/armDi 记录转负发生日：仅转负次日 9:40 执行买入，超过次日意图作废
            if (turnedNegative) {
              if (icePrevCloseSlope != null && icePrevCloseSlope > 0) {
                pendingEntry = { mode: 'defense', trigger: 'ice_rev_next_day_940', armDate: dateStr, armDi: di, fromValue: lastSlopeValue, toValue: slopeNow, icePrevCloseSlope };
              }
            } else if (turnedPositive) {
              pendingEntry = null;
            }
          } else {
            // 顺周期情绪游资：上证 3 日线斜率「由负转正」为买点（方向与创业板口径相反）：
            //   ① 仅当「前一交易日收盘口径斜率为负」时，今日盘中由负转正才算一次出手机会；
            //      前一日收盘已为正时，今日盘中的 −→+ 不算买点（不生成/不覆盖意图，继续空仓等待）
            //   ② 斜率「由正转负」是卖点信号，同时作废尚未成交的买点意图
            // armDate/armDi 记录转正发生日：仅在转正当日与次日 9:40 补买
            if (turnedPositive) {
              if (icePrevCloseSlope != null && icePrevCloseSlope < 0) {
                pendingEntry = { mode: 'defense', trigger: 'ice_slope_turn_positive', armDate: dateStr, armDi: di, fromValue: lastSlopeValue, toValue: slopeNow, icePrevCloseSlope };
              }
            } else if (turnedNegative) {
              pendingEntry = null;
            }
          }
        } else if (turnedNegative) {
          // 防御买点：斜率变成负数且当前空仓（独立于进攻卖出的不追买限制）
          pendingEntry = { mode: 'defense', trigger: 'slope_turn_negative', armDate: dateStr, armDi: di, fromValue: lastSlopeValue, toValue: slopeNow };
        } else if (turnedPositive && offenseBlockDate !== dateStr) {
          // 进攻买点：斜率转为正数（防御持仓当桶卖出后的转手买入同样走这里；进攻卖出当日禁止追买）
          pendingEntry = { mode: 'offense', trigger: 'slope_turn_positive', fromValue: lastSlopeValue, toValue: slopeNow };
        }
      }
      // 情绪游资：出手窗口仅限翻转事件当日 + 次日（顺周期：转正当日 9:40 起、次日 9:40 补买；
      // 逆周期：仅在转负次日 9:40），超过次日的未成交意图作废
      if (iceMode && pendingEntry && (pendingEntry.trigger === 'ice_slope_turn_positive' || pendingEntry.trigger === 'ice_rev_next_day_940')
        && pendingEntry.armDi != null && di > pendingEntry.armDi + 1) {
        pendingEntry = null;
      }

      // ===== ④ 按意图建仓（同桶先卖后买；候选全部涨停/无效时后续桶继续重试） =====
      if (!position && winDates.length === days && pendingEntry) {
        // 顺周期情绪游资：转正当日 9:40 起持续重试；次日起仅在 9:40 及以后的桶补买
        const iceNextDay = iceMode && pendingEntry.trigger === 'ice_slope_turn_positive'
          && pendingEntry.armDi != null && di > pendingEntry.armDi;
        let canAttempt = true;
        if (pendingEntry.trigger === 'retry_next_day_940') {
          // 仅在卖出的次一交易日生效：9:40 前不买；斜率数据不足等后续桶；复测斜率 ≤ 0 本桶不买
          // （当日由正转负时③已把意图切为防御；卖出当日一律不执行，落实「当日不要继续买」）
          if (dateStr <= pendingEntry.armDate || bucketMinute < 940 || slopeNow == null || slopeNow <= 0) canAttempt = false;
        } else if (iceMode && pendingEntry.trigger === 'ice_slope_turn_positive' && bucketMinute < 940) {
          // 顺周期情绪游资：无论转正当日还是次日，都要等到 9:40 及以后才买——给抗分歧分数留出盘中分时窗口
          // （9:40 时股价与跟踪指数各约 11 个分时点，满足抗分歧函数 ≥5 点的计算要求，避免 9:30 桶「数据不足」放行）
          canAttempt = false;
        } else if (iceMode && pendingEntry.trigger === 'ice_rev_next_day_940') {
          // 逆周期情绪游资：仅在转负的次一交易日 9:40 及以后、且斜率依旧为负时才买（转负当日不买）
          //（9:40 前股价与跟踪指数分时点不足 5 个、无法计算抗分歧分数；斜率已由负转正时③已作废意图；
          //  候选不可买时在 9:40 及以后的桶持续重试）
          if (dateStr <= pendingEntry.armDate || bucketMinute < 940 || slopeNow == null || slopeNow >= 0) canAttempt = false;
        }
        if (canAttempt) {
          // 复测/补买（顺周期次日 9:40 补买）：明细中的斜率取执行桶当时值（fromValue 仍为翻转当时值）
          const intent = pendingEntry.trigger === 'retry_next_day_940'
            ? { ...pendingEntry, toValue: slopeNow }
            : (iceNextDay ? { ...pendingEntry, trigger: 'ice_next_day_940', toValue: slopeNow } : pendingEntry);
          const opened = await openPosition(intent, { dateStr, dateDisplay, dateNum, winDates, bucket, bucketMinute });
          if (opened) {
            pendingEntry = null;
          }
        }
      }

      // 更新斜率符号基准（null 桶不更新，翻转识别跨缺失桶连续）
      if (signNow !== null) {
        lastSlopeSign = signNow;
        lastSlopeValue = slopeNow;
      }
    }
  }

  // 组装结果（type:'single'：单股顺序持仓，整体收益率 = 逐笔复利，与 rangeBacktest/sentimentHotMoney 口径一致；
  // 半仓（防御/冰点）成交的 returnRate 已按权重折算，复利即为账户口径；期末持仓浮动收益并入复利）
  let acc = 1;
  for (const t of trades) {
    if (t.returnRate != null && Number.isFinite(t.returnRate)) acc *= 1 + t.returnRate / 100;
  }
  let holding = null;
  if (position) {
    holding = { ...position };
    holding.weight = (iceMode && position.mode === 'defense') ? 1 : (KEY_BLOCK_POSITION_WEIGHT[position.mode] ?? 1);
    let rawBuyReturn = null; // 期末持仓的个股实际浮盈（未折算）
    for (let i = rangeDates.length - 1; i >= 0; i--) {
      const info = dailyInfos.get(rangeDates[i])?.get(position.code);
      if (info && info.closePx != null && info.closePx > 0) {
        rawBuyReturn = position.buyPrice > 0
          ? parseFloat((((info.closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2))
          : null;
        break;
      }
    }
    // 非自选股持仓（重点板块策略买入板块全部成分股）：回放数据无该股，用成分股日K收盘价兜底估值
    if (rawBuyReturn == null) {
      const closePx = getStockCloseOnOrBefore(position.code, rangeDates[rangeDates.length - 1]);
      if (closePx != null && closePx > 0 && position.buyPrice > 0) {
        rawBuyReturn = parseFloat((((closePx - position.buyPrice) / position.buyPrice) * 100).toFixed(2));
      }
    }
    // 防御半仓持仓：浮盈同样按 0.5 折算后计入整体收益
    holding.rawBuyReturn = rawBuyReturn;
    holding.buyReturn = rawBuyReturn != null ? parseFloat((rawBuyReturn * holding.weight).toFixed(2)) : null;
    if (holding.buyReturn != null && Number.isFinite(holding.buyReturn)) {
      acc *= 1 + holding.buyReturn / 100;
    }
  }
  const overallReturn = parseFloat(((acc - 1) * 100).toFixed(2));
  const validTrades = trades.filter(t => t.returnRate != null && Number.isFinite(t.returnRate));
  const winCount = validTrades.filter(t => t.returnRate > 0).length;
  // 买入当日收益（2026-10-10 用户新增）：为每笔成交与期末持仓补写「买入价 → 买入当日收盘价」收益率
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

module.exports = {
  KEY_BLOCK_DEFENSE_STOP_LOSS_PCT,
  KEY_BLOCK_MODE_LABEL,
  KEY_BLOCK_POSITION_WEIGHT,
  runKeyBlockBacktest,
};
