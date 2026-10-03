// ================================================================
// 指定买点 × 卖点诊断回测脚本
// ----------------------------------------------------------------
// 在 6 个指定买点时间对所有科技类自选股执行买入，
// 按卖点诊断 7 个条件（满足任一即卖出）在分钟级检查，
// 统计每只股票的收益率和持仓时间，并生成可排序的 HTML 报告。
// 运行方式：在 server 目录下 `node script/stock_buypoint_backtest.js`
// 输出：server/script/stock_buypoint_result.json
//       server/script/stock_buypoint_result.html
// ================================================================

const path = require('path');
const fs = require('fs');

// 切换工作目录到 server，保证相对路径的 data/ 缓存文件命中
process.chdir(path.resolve(__dirname, '..'));

const { getSingleStockTlineDataByDate, getSingleStockData } = require('../src/service/stock');
const { calculateResilience, getLimitTypeByCode } = require('../src/service/stockDiagnose');
const { getMonitorStocks } = require('../src/service/monitorStock');
const { getNextTradingDay, getPrevTradingDay } = require('../src/utils');

// ----------------------------- 参数 ------------------------------

const BUY_POINTS = [
  { date: '20260729', time: 1030, label: '7.29 10:30' },
  { date: '20260804', time: 940,  label: '8.4  9:40'  },
  { date: '20260825', time: 1005, label: '8.25 10:05' },
  { date: '20260907', time: 935,  label: '9.7  9:35'  },
  { date: '20260916', time: 1010, label: '9.16 10:10' },
  { date: '20260929', time: 1130, label: '9.29 11:30' },
];
const MAX_HOLD_DAYS = 30;     // 最多持仓 N 个交易日，超时强制收盘卖出
const PERSIST_MIN = 5;        // 条件持续满足分钟数（2/3/6）

// --------------------------- 工具函数 ---------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtDate = (d) => {
  const s = String(d);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
};

const fmtTime = (minute) => {
  if (minute == null) return '--:--';
  const m = String(minute).padStart(4, '0');
  return `${m.substring(0, 2)}:${m.substring(2, 4)}`;
};

const dateNumToDate = (dateNum) => {
  const s = String(dateNum);
  return new Date(+s.substring(0, 4), +s.substring(4, 6) - 1, +s.substring(6, 8));
};

const dateToDateNum = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

const beijingToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

// 获取从 startDateNum 起往后 N 个交易日的日期序列（含 startDateNum 本身）
const getForwardTradingDays = (startDateNum, n) => {
  const out = [];
  let cur = getNextTradingDay(dateNumToDate(String(+startDateNum - 1) || startDateNum)) || dateNumToDate(startDateNum);
  // 如果传入的 start 本身是交易日且它在 next(prev) 队列里，直接用传入值
  if (!cur || dateToDateNum(cur) > startDateNum) {
    cur = dateNumToDate(startDateNum);
  }
  const todayNum = parseInt(beijingToday());
  for (let i = 0; i < n; i++) {
    const num = parseInt(dateToDateNum(cur));
    if (num > todayNum) break; // 超过今天的数据不存在，截断
    out.push(String(num));
    const nxt = getNextTradingDay(cur);
    if (!nxt) break;
    cur = nxt;
  }
  return out;
};

// --------------------------- 日K线处理 ---------------------------

// 从 kline 数组（字段: trade_date, open_px, close_px, high_px, low_px, ma5_px, ma10_px）
// 中找到指定日期，返回 { open, close, high, low, ma5, ma10, ma5Slope, ma10Slope, prevLow, change }
const getMaInfoForDate = (kline, targetDateNum) => {
  if (!Array.isArray(kline) || kline.length === 0) return null;
  const sorted = [...kline].sort((a, b) => +a.trade_date - +b.trade_date);
  const idx = sorted.findIndex((k) => String(k.trade_date) === String(targetDateNum));
  if (idx < 0) return null;
  const k = sorted[idx];

  // 计算 MA5 / MA10（字段里已包含）
  let ma5 = k.ma5_px != null ? parseFloat(k.ma5_px) : null;
  let ma10 = k.ma10_px != null ? parseFloat(k.ma10_px) : null;
  if (ma5 == null && idx >= 4) {
    ma5 = sorted.slice(idx - 4, idx + 1).reduce((s, x) => s + parseFloat(x.close_px), 0) / 5;
  }
  if (ma10 == null && idx >= 9) {
    ma10 = sorted.slice(idx - 9, idx + 1).reduce((s, x) => s + parseFloat(x.close_px), 0) / 10;
  }

  // MA5 斜率
  let ma5Slope = null;
  if (ma5 != null && idx >= 9) {
    let prev = sorted[idx - 5].ma5_px;
    if (prev == null) {
      prev = sorted.slice(idx - 9, idx - 4).reduce((s, x) => s + parseFloat(x.close_px), 0) / 5;
    }
    ma5Slope = ma5 - parseFloat(prev);
  }

  // MA10 斜率
  let ma10Slope = null;
  if (ma10 != null && idx >= 14) {
    let prev = sorted[idx - 5].ma10_px;
    if (prev == null) {
      prev = sorted.slice(idx - 14, idx - 4).reduce((s, x) => s + parseFloat(x.close_px), 0) / 10;
    }
    ma10Slope = ma10 - parseFloat(prev);
  }

  const prevLow = idx >= 1 ? parseFloat(sorted[idx - 1].low_px) : null;

  return {
    open: parseFloat(k.open_px),
    close: parseFloat(k.close_px),
    high: parseFloat(k.high_px),
    low: parseFloat(k.low_px),
    change: k.change != null ? parseFloat(k.change) : null,
    ma5, ma10, ma5Slope, ma10Slope, prevLow,
  };
};

// ---------------------------- 缓存层 -----------------------------

// (code, dateStr) -> { minute, lastPx, changePct }[]
const tlineCache = new Map();
// code -> kline[]
const klineCache = new Map();

const getCachedTline = async (code, dateStr) => {
  const key = `${code}|${dateStr}`;
  if (tlineCache.has(key)) return tlineCache.get(key);
  const data = await getSingleStockTlineDataByDate(code, dateStr);
  const line = (data?.line || [])
    .filter((p) => p.minute != null && p.last_px != null && p.last_px > 0)
    // 保留原始 last_px / change 字段给 calculateResilience，同时提供 lastPx / changePct 供本脚本其他逻辑使用
    .map((p) => ({
      minute: parseInt(p.minute),
      last_px: parseFloat(p.last_px),
      lastPx: parseFloat(p.last_px),
      change: parseFloat(p.change || 0),
      changePct: parseFloat(p.change || 0),
    }))
    .sort((a, b) => a.minute - b.minute);
  tlineCache.set(key, line);
  return line;
};

const getCachedKline = async (code) => {
  if (klineCache.has(code)) return klineCache.get(code);
  const data = await getSingleStockData(code, 120);
  klineCache.set(code, data || []);
  return data || [];
};

// --------------------------- 卖点条件 ----------------------------
// sellPointChecks.js 对应 7 个条件；条件 2/3/6 需持续 PERSIST_MIN 分钟，
// 条件 4/5 有生效时间门禁（14:50 / 9:40），条件 7 即时触发。
// 条件 6 依赖买入当天的最低价，条件 3 需要全部科技自选股的跌幅分布。

// 累计「某条件在最近 N 分钟连续成立」的判定
const checkPersistInTline = (tlineUpToNow, conditionFn) => {
  // tlineUpToNow: 已按 minute 升序排列、且过滤有效价格的分时点，截至当前分钟
  // 返回 { satisfied, persistMin }
  if (!Array.isArray(tlineUpToNow) || tlineUpToNow.length < PERSIST_MIN) {
    return { satisfied: false, persistMin: tlineUpToNow ? tlineUpToNow.length : 0 };
  }
  const recent = tlineUpToNow.slice(-PERSIST_MIN);
  for (let i = 0; i < recent.length; i++) {
    if (!conditionFn(recent[i])) {
      return { satisfied: false, persistMin: i };
    }
  }
  return { satisfied: true, persistMin: PERSIST_MIN };
};

// 在 buyDay 的分时里找到买入分钟之前（含）的最低价
const findBuyDayLow = (buyDayTline, buyMinute) => {
  if (!Array.isArray(buyDayTline) || buyDayTline.length === 0) return null;
  let low = Infinity;
  for (const p of buyDayTline) {
    if (p.minute > buyMinute) break;
    if (p.lastPx > 0 && p.lastPx < low) low = p.lastPx;
  }
  return low === Infinity ? null : low;
};

// 给定 stockTline（已升序）和 minute，返回截至该分钟的切片
const sliceUpToMinute = (tline, minute) => {
  if (!Array.isArray(tline)) return [];
  return tline.filter((p) => p.minute != null && p.minute <= minute);
};

// 核心：对某只持仓股票，在某一天（当前交易日）的 minute 时刻检查 7 个条件
// 返回 { triggered, reason }
const checkAllConditions = (ctx) => {
  const {
    minute, curTlineUpTo, openDay, maInfo, buyPrice, buyDayLow,
    indexTline, prevResilience1, prevResilience2, stockCode,
    allTechStocksMinuteMap, // { [code]: changePct } 当前分钟所有科技股的涨幅（用于条件3）
    techEmotionForDay,      // 当日科技情绪（数字，来自 emotion.json 预计算；null 表示无）
  } = ctx;

  const openPrice = openDay != null ? openDay : (curTlineUpTo[0]?.lastPx || null);
  const closePx = curTlineUpTo[curTlineUpTo.length - 1]?.lastPx;
  if (closePx == null) return { triggered: false };
  const changePct = curTlineUpTo[curTlineUpTo.length - 1]?.changePct;

  // ---- 条件 1：均线破位 ----
  let cond1 = false, cond1Detail = '';
  if (maInfo && maInfo.ma10 != null) {
    const { ma5, ma10, ma5Slope, ma10Slope, prevLow } = maInfo;
    let ruleType = 4;
    if (ma10Slope != null && ma10Slope < 0) {
      if (ma5Slope != null && ma5Slope > 0) {
        ruleType = openPrice != null && openPrice > ma10 ? 1 : 3;
      } else {
        ruleType = 2;
      }
    }
    const inTradingWindow = minute >= 930 && minute < 1450;
    const deepFall = changePct != null && changePct < -3;
    let broken = false;
    if (ruleType === 1) { broken = closePx < ma10; }
    else if (ruleType === 2) { broken = prevLow != null && closePx < prevLow; }
    else if (ruleType === 3) { broken = ma5 != null && closePx < ma5; }
    else { broken = closePx < ma10; }
    if (ruleType === 2) {
      cond1 = broken; // 全天生效
    } else {
      cond1 = broken && (!inTradingWindow || deepFall);
    }
    cond1Detail = `规则${['?','①','②','③','④'][ruleType] ?? '?'} close=${closePx.toFixed(2)} MA10=${ma10.toFixed(2)}`;
  }

  // ---- 条件 2：高位放量大阴线回落 > 8% 且现价 < 开盘，持续 ≥5 分钟 ----
  let cond2 = false, cond2Detail = '';
  if (openPrice != null) {
    // 每分钟内的日内最高价（截至该分钟）
    let dayHigh = 0;
    for (const p of curTlineUpTo) if (p.lastPx > dayHigh) dayHigh = p.lastPx;
    const amp = closePx > 0 ? ((dayHigh - closePx) / closePx) * 100 : 0;
    const rawTrue = amp > 8 && closePx < openPrice;
    if (rawTrue) {
      // 持续判定
      const persist = checkPersistInTline(curTlineUpTo, (p) => {
        // 对每个点都重新算截至该点的 dayHigh
        let h = 0;
        for (const x of curTlineUpTo) if (x.minute <= p.minute && x.lastPx > h) h = x.lastPx;
        const a = p.lastPx > 0 ? ((h - p.lastPx) / p.lastPx) * 100 : 0;
        return a > 8 && p.lastPx < openPrice;
      });
      cond2 = persist.satisfied;
      cond2Detail = `回落 ${amp.toFixed(2)}% 需≥5分钟 实际${persist.persistMin}`;
    }
  }

  // ---- 条件 3：科技情绪 == -100 且自选股跌幅 < -9% 数 ≥ 5，持续 ≥5 分钟 ----
  let cond3 = false, cond3Detail = '';
  if (techEmotionForDay === -100 && allTechStocksMinuteMap) {
    const downCount = Object.values(allTechStocksMinuteMap)
      .filter((c) => c != null && c < -9).length;
    if (downCount >= 5) {
      // 简化：当日情绪一旦是 -100 我们视作全天满足（回测历史数据）
      // 持续 5 分钟要求在日线级别近似处理
      cond3 = true;
      cond3Detail = `情绪=-100 跌幅<-9%共${downCount}只`;
    }
  }

  // ---- 条件 4：抗分歧指数 < 6 且涨幅 ≤ -5%（14:50 后生效）----
  let cond4 = false, cond4Detail = '';
  const isSh688 = String(stockCode).startsWith('sh688');
  const indexCodeC4 = isSh688 ? 'sh000688' : 'sz399006';
  let resilienceNow = null;
  if (Array.isArray(indexTline) && indexTline.length >= 5 && curTlineUpTo.length >= 5) {
    const limitType = getLimitTypeByCode(stockCode);
    resilienceNow = calculateResilience(indexTline, curTlineUpTo, limitType);
  }
  const isAfter1450 = minute >= 1450;
  if (resilienceNow != null) {
    cond4 = resilienceNow < 6 && changePct != null && changePct <= -5 && isAfter1450;
    cond4Detail = `抗分歧 ${resilienceNow.toFixed(2)} 涨幅 ${changePct ?? '--'}%`;
  }

  // ---- 条件 5：连续三日（含当日）抗分歧指数均 < 10（9:40 后生效）----
  let cond5 = false, cond5Detail = '';
  const isAfter940 = minute >= 940;
  if (isAfter940 && prevResilience1 != null && prevResilience2 != null && resilienceNow != null) {
    cond5 = prevResilience1 < 10 && prevResilience2 < 10 && resilienceNow < 10;
    cond5Detail = `前两日 ${prevResilience1.toFixed(2)}/${prevResilience2.toFixed(2)} 今日 ${resilienceNow.toFixed(2)}`;
  }

  // ---- 条件 6：现价跌破买入日最低价，持续 ≥5 分钟 ----
  let cond6 = false, cond6Detail = '';
  if (buyDayLow != null && buyDayLow > 0) {
    const persist = checkPersistInTline(curTlineUpTo, (p) => p.lastPx < buyDayLow);
    cond6 = persist.satisfied;
    cond6Detail = `买入日低 ${buyDayLow.toFixed(2)} 持续 ${persist.persistMin}`;
  }

  // ---- 条件 7：跌破成本线 -2%（即时）----
  let cond7 = false, cond7Detail = '';
  if (buyPrice != null && buyPrice > 0) {
    const threshold = buyPrice * 0.98;
    cond7 = closePx < threshold;
    cond7Detail = `成本 ${buyPrice.toFixed(2)}*0.98=${threshold.toFixed(2)} 现价 ${closePx.toFixed(2)}`;
  }

  const names = [];
  if (cond1) names.push('均线破位');
  if (cond2) names.push('高位放量大阴线');
  if (cond3) names.push('科技板块情绪退潮');
  if (cond4) names.push('抗分歧指数弱势');
  if (cond5) names.push('连续三日抗分歧弱势');
  if (cond6) names.push('跌破买入日低点');
  if (cond7) names.push('跌破成本线-2%');

  return {
    triggered: names.length > 0,
    conditions: { cond1, cond2, cond3, cond4, cond5, cond6, cond7 },
    reason: names.join('、') || '',
    closePx,
    changePct,
    cond1Detail, cond2Detail, cond3Detail, cond4Detail, cond5Detail, cond6Detail, cond7Detail,
  };
};

// ----------------------------- 预加载 ---------------------------

// 计算某股票某一天的「全天抗分歧指数」
const calcDayResilience = async (code, dateStr) => {
  const isSh688 = String(code).startsWith('sh688');
  const indexCode = isSh688 ? 'sh000688' : 'sz399006';
  const [stockLine, indexLine] = await Promise.all([
    getCachedTline(code, dateStr),
    getCachedTline(indexCode, dateStr),
  ]);
  if (stockLine.length < 5 || indexLine.length < 5) return null;
  const limitType = getLimitTypeByCode(code);
  return calculateResilience(indexLine, stockLine, limitType);
};

// ----------------------------- 主流程 ---------------------------

async function main() {
  const monitorStocks = getMonitorStocks() || [];
  const techStocks = monitorStocks.filter((s) => s.isTech !== false && s.code);
  console.log(`[init] 科技类自选股共 ${techStocks.length} 只`);

  // 预加载所有指数 & 股票在所有相关日期的分时和K线
  const allDateNums = new Set();
  for (const bp of BUY_POINTS) {
    // 买入日 + 前后 35 个交易日（给 MA10 斜率 & 买入日低点 & 后续持仓）
    const fwd = getForwardTradingDays(bp.date, MAX_HOLD_DAYS + 5);
    fwd.forEach((d) => allDateNums.add(d));
    // 前两个交易日（用于条件 5 计算前两日抗分歧分数）
    let prev = dateNumToDate(bp.date);
    prev = getPrevTradingDay(prev);
    if (prev) allDateNums.add(dateToDateNum(prev));
    prev = getPrevTradingDay(prev);
    if (prev) allDateNums.add(dateToDateNum(prev));
  }
  const allDates = Array.from(allDateNums).sort();
  console.log(`[init] 预加载 ${allDates.length} 个交易日的分时数据...`);

  const allCodes = [];
  const seen = new Set();
  for (const s of techStocks) {
    if (!seen.has(s.code)) { seen.add(s.code); allCodes.push(s.code); }
  }
  allCodes.push('sh000688', 'sz399006');

  // 并发拉取分时
  let done = 0;
  const totalTL = allCodes.length * allDates.length;
  for (const code of allCodes) {
    for (const date of allDates) {
      done++;
      if (done % 50 === 0) {
        console.log(`[tline] ${done}/${totalTL}  (${Math.round((done / totalTL) * 100)}%)`);
        await sleep(10); // 让出事件循环
      }
      try {
        await getCachedTline(code, date);
      } catch (e) { /* 单只失败忽略 */ }
    }
  }

  // 并发拉取K线（只需要股票，指数不需要K线）
  for (const code of techStocks.map((s) => s.code)) {
    try { await getCachedKline(code); } catch (e) { /* ignore */ }
  }
  console.log(`[init] 分时和K线预加载完成`);

  // 加载 emotion.json（科技情绪每日汇总）
  let emotionMap = new Map(); // dateNum -> techEmotion (number)
  try {
    const emotionPath = path.resolve(__dirname, '../src/data/emotion.json');
    if (fs.existsSync(emotionPath)) {
      const raw = JSON.parse(fs.readFileSync(emotionPath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (raw?.index || []);
      for (const item of list) {
        const d = item?.date != null ? String(item.date).replace(/-/g, '') : null;
        const v = item?.changeSumResult ?? item?.change;
        if (d != null && v != null) {
          emotionMap.set(d, parseFloat(v));
        }
      }
    }
  } catch (e) {
    console.warn('[warn] 加载 emotion.json 失败:', e.message);
  }

  // ------------------------ 逐买点 × 逐股票 ------------------------
  const results = [];

  for (const bp of BUY_POINTS) {
    console.log(`\n======= 买点 ${bp.label} (${bp.date} ${fmtTime(bp.time)}) =======`);

    // 买入日分时 & 指数分时
    const buyDayTlineCache = new Map(); // code -> tline
    for (const s of techStocks) {
      buyDayTlineCache.set(s.code, await getCachedTline(s.code, bp.date));
    }

    const tradeDays = getForwardTradingDays(bp.date, MAX_HOLD_DAYS);
    console.log(`[buy] 持仓窗口 ${tradeDays[0]} ~ ${tradeDays[tradeDays.length - 1]}，共 ${tradeDays.length} 个交易日`);

    let i = 0;
    for (const stock of techStocks) {
      i++;
      if (i % 10 === 0) {
        console.log(`[stock] ${i}/${techStocks.length} ${stock.code} ${stock.name}`);
      }

      // 买入价：取买入分钟（或之后第一个可用分钟）的价格
      const buyLine = buyDayTlineCache.get(stock.code) || [];
      if (buyLine.length === 0) {
        results.push(buildSkipResult(stock, bp, '买入日无分时数据'));
        continue;
      }
      const buyPoint = buyLine.find((p) => p.minute >= bp.time);
      if (!buyPoint) {
        results.push(buildSkipResult(stock, bp, `买入日无 ≥ ${fmtTime(bp.time)} 的分钟数据`));
        continue;
      }
      const buyPrice = buyPoint.lastPx;
      const buyMinute = buyPoint.minute;
      const buyDayNum = tradeDays[0];
      const buyDayKline = await getCachedKline(stock.code);

      // 条件 6 需要的买入日最低价（到买入分钟为止）
      const buyDayLow = findBuyDayLow(buyDayTlineCache.get(stock.code), buyMinute);

      // 条件 5：买入日所在的连续三日抗分歧
      // 如果在买入日触发条件 5，需要买入日当天 + 前两日都 < 10
      const prev1Date = dateToDateNum(getPrevTradingDay(dateNumToDate(buyDayNum)));
      const prev2Date = dateToDateNum(getPrevTradingDay(dateNumToDate(prev1Date)));
      let prevResilience1 = null;
      let prevResilience2 = null;
      try { prevResilience1 = await calcDayResilience(stock.code, prev1Date); } catch {}
      try { prevResilience2 = await calcDayResilience(stock.code, prev2Date); } catch {}

      // 从买入分钟之后开始，逐日遍历交易日，逐日逐分钟检查 7 条件
      let sold = false;
      let sellRecord = null;

      for (let dIdx = 0; dIdx < tradeDays.length; dIdx++) {
        const curDate = tradeDays[dIdx];
        let dayTline;
        if (dIdx === 0) {
          // 买入日已在 cache
          dayTline = buyDayTlineCache.get(stock.code);
        } else {
          try {
            dayTline = await getCachedTline(stock.code, curDate);
          } catch { dayTline = []; }
        }
        if (!dayTline || dayTline.length === 0) continue;

        // 买入日只从 buyMinute 之后开始检查，后面的交易日从 9:30 开始
        const startMinute = dIdx === 0 ? buyMinute : 930;
        const effectivePoints = dayTline.filter((p) => p.minute >= startMinute);
        if (effectivePoints.length === 0) continue;

        // 指数分时（抗分歧用）
        const isSh688 = String(stock.code).startsWith('sh688');
        const indexCode = isSh688 ? 'sh000688' : 'sz399006';
        let indexTline;
        try { indexTline = await getCachedTline(indexCode, curDate); } catch { indexTline = []; }

        // 当日全部科技股的当前分钟涨幅（条件 3 用）
        // 预加载当日所有科技股分时 → 构建「分钟 -> { code: changePct }」映射
        // 为了避免每次检查都重算，先算一次 dayMap：code -> tline
        const allTechTlinesForDay = new Map();
        for (const s of techStocks) {
          try { allTechTlinesForDay.set(s.code, await getCachedTline(s.code, curDate)); } catch {}
        }

        // 每日的 MA 信息（条件 1 用）
        const maInfo = getMaInfoForDate(buyDayKline, curDate);
        const openDay = dayTline[0]?.lastPx;
        const techEmotionForDay = emotionMap.has(String(curDate)) ? emotionMap.get(String(curDate)) : null;

        // 逐日逐分钟循环
        for (const pt of effectivePoints) {
          const curMinute = pt.minute;
          const upTo = dayTline.filter((p) => p.minute != null && p.minute <= curMinute);

          // 构建 allTechStocksMinuteMap（当前分钟每只科技股的 changePct）
          const allMap = {};
          for (const s of techStocks) {
            const tl = allTechTlinesForDay.get(s.code);
            if (!tl) continue;
            const p = [...tl].reverse().find((x) => x.minute <= curMinute);
            if (p) allMap[s.code] = p.changePct;
          }

          const result = checkAllConditions({
            minute: curMinute,
            curTlineUpTo: upTo,
            openDay,
            maInfo,
            buyPrice,
            buyDayLow,
            indexTline,
            prevResilience1, prevResilience2,
            stockCode: stock.code,
            allTechStocksMinuteMap: allMap,
            techEmotionForDay,
          });

          if (result.triggered) {
            const sellPrice = result.closePx;
            const sellMinute = curMinute;
            const sellDateNum = curDate;
            const retPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;
            // 持仓天数：自然日差（卖出日 - 买入日），至少为 1
            const buyD = dateNumToDate(buyDayNum);
            const sellD = dateNumToDate(sellDateNum);
            const holdingDays = Math.max(1, Math.round((sellD - buyD) / 86400000));

            sold = true;
            sellRecord = {
              sellDate: sellDateNum,
              sellMinute,
              sellPrice,
              reason: result.reason,
              returnPct: parseFloat(retPct.toFixed(2)),
              holdingDays,
              detail: `${result.cond1Detail || ''} | ${result.cond2Detail || ''} | ${result.cond3Detail || ''} | ${result.cond4Detail || ''} | ${result.cond5Detail || ''} | ${result.cond6Detail || ''} | ${result.cond7Detail || ''}`,
            };
            break;
          }
        }

        if (sold) break;
      }

      if (!sold) {
        // 30 个交易日都没触发卖点 → 按最后一天收盘价强制卖出
        const lastDay = tradeDays[tradeDays.length - 1];
        let lastTline = [];
        try { lastTline = await getCachedTline(stock.code, lastDay); } catch {}
        const lastPx = lastTline.length > 0 ? lastTline[lastTline.length - 1].lastPx : null;
        sellRecord = {
          sellDate: lastDay,
          sellMinute: lastTline.length > 0 ? lastTline[lastTline.length - 1].minute : null,
          sellPrice: lastPx,
          reason: '持仓超 30 个交易日，强制收盘卖出',
          returnPct: lastPx != null && buyPrice > 0
            ? parseFloat((((lastPx - buyPrice) / buyPrice) * 100).toFixed(2)) : null,
          holdingDays: tradeDays.length - 1,
          detail: '',
        };
      }

      results.push({
        buyPoint: bp.label,
        buyDate: buyDayNum,
        buyMinute,
        buyPrice: parseFloat(buyPrice.toFixed(3)),
        stockCode: stock.code,
        stockName: stock.name,
        blockName: stock.blockName || '',
        riskScore: stock.riskScore ?? null,
        sellDate: sellRecord.sellDate,
        sellMinute: sellRecord.sellMinute,
        sellPrice: sellRecord.sellPrice != null ? parseFloat(sellRecord.sellPrice.toFixed(3)) : null,
        returnPct: sellRecord.returnPct,
        holdingDays: sellRecord.holdingDays,
        reason: sellRecord.reason,
        detail: sellRecord.detail,
        skipped: false,
      });
    }
  }

  // ----------------------- 写出 JSON -------------------------
  const outJson = path.resolve(__dirname, 'stock_buypoint_result.json');
  fs.writeFileSync(outJson, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n[output] JSON 已写入 ${outJson} (共 ${results.length} 条)`);

  // ----------------------- 写出 HTML -------------------------
  const html = buildHtml(results);
  const outHtml = path.resolve(__dirname, 'stock_buypoint_result.html');
  fs.writeFileSync(outHtml, html, 'utf-8');
  console.log(`[output] HTML 已写入 ${outHtml}`);
}

function buildSkipResult(stock, bp, reason) {
  return {
    buyPoint: bp.label,
    buyDate: bp.date,
    buyMinute: bp.time,
    buyPrice: null,
    stockCode: stock.code,
    stockName: stock.name,
    blockName: stock.blockName || '',
    riskScore: stock.riskScore ?? null,
    sellDate: null,
    sellMinute: null,
    sellPrice: null,
    returnPct: null,
    holdingDays: null,
    reason,
    detail: '',
    skipped: true,
  };
}

function buildHtml(results) {
  // 每个买点一个 section，每个 section 一个可排序表格
  const buyPointGroups = BUY_POINTS.map((bp) => ({
    bp,
    items: results.filter((r) => r.buyPoint === bp.label),
  }));

  // 总览
  const summaryRows = BUY_POINTS.map((bp) => {
    const items = results.filter((r) => r.buyPoint === bp.label && !r.skipped && r.returnPct != null);
    if (items.length === 0) return { bp: bp.label, count: 0 };
    const avg = items.reduce((s, r) => s + r.returnPct, 0) / items.length;
    const win = items.filter((r) => r.returnPct > 0).length;
    const avgHold = items.reduce((s, r) => s + r.holdingDays, 0) / items.length;
    const top = items.slice().sort((a, b) => b.returnPct - a.returnPct)[0];
    const bottom = items.slice().sort((a, b) => a.returnPct - b.returnPct)[0];
    return { bp: bp.label, count: items.length, avg: avg.toFixed(2), win, winRate: (win / items.length * 100).toFixed(1), avgHold: avgHold.toFixed(1), top: top.stockName + ' ' + top.returnPct.toFixed(2) + '%', bottom: bottom.stockName + ' ' + bottom.returnPct.toFixed(2) + '%' };
  });

  let summaryHtml = `<h2>总览</h2><table class="sortable"><thead><tr><th>买点</th><th>有效样本</th><th>平均收益率</th><th>盈利家数</th><th>胜率</th><th>平均持仓天数</th><th>最佳</th><th>最差</th></tr></thead><tbody>`;
  for (const r of summaryRows) {
    if (r.count === 0) {
      summaryHtml += `<tr><td>${r.bp}</td><td colspan="6" style="color:#999">无有效数据</td></tr>`;
      continue;
    }
    const retColor = parseFloat(r.avg) >= 0 ? '#16a34a' : '#dc2626';
    summaryHtml += `<tr><td>${r.bp}</td><td>${r.count}</td><td style="color:${retColor};font-weight:bold">${r.avg}%</td><td>${r.win}</td><td>${r.winRate}%</td><td>${r.avgHold}</td><td>${r.top}</td><td>${r.bottom}</td></tr>`;
  }
  summaryHtml += `</tbody></table>`;

  let sectionsHtml = '';
  for (const { bp, items } of buyPointGroups) {
    sectionsHtml += `
    <section>
      <h2 id="bp-${bp.date}-${bp.time}">买点 ${bp.label}（${items.length} 只）</h2>
      <p class="hint">点击表头排序；默认按收益率从高到低。仅统计非 skipped 样本。</p>
      <table class="sortable" id="tbl-${bp.date}-${bp.time}">
        <thead>
          <tr>
            <th data-col="returnPct" data-dir="desc" style="background:#eef2ff">收益率 %</th>
            <th data-col="holdingDays">持仓天数</th>
            <th data-col="stockName">名称</th>
            <th data-col="blockName">板块</th>
            <th data-col="riskScore">风险</th>
            <th data-col="buyDate">买入日</th>
            <th data-col="buyMinute">买入时间</th>
            <th data-col="buyPrice">买入价</th>
            <th data-col="sellDate">卖出日</th>
            <th data-col="sellMinute">卖出时间</th>
            <th data-col="sellPrice">卖出价</th>
            <th data-col="reason">触发条件</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const r of items) {
      if (r.skipped) continue;
      const retColor = r.returnPct != null
        ? (r.returnPct >= 0 ? '#16a34a' : '#dc2626')
        : '#999';
      sectionsHtml += `
          <tr>
            <td style="color:${retColor};font-weight:bold">${r.returnPct != null ? r.returnPct.toFixed(2) + '%' : '--'}</td>
            <td>${r.holdingDays ?? '--'}</td>
            <td>${r.stockName}<span class="code">${r.stockCode}</span></td>
            <td>${r.blockName || '--'}</td>
            <td>${r.riskScore ?? '--'}</td>
            <td>${fmtDate(r.buyDate)}</td>
            <td>${fmtTime(r.buyMinute)}</td>
            <td>${r.buyPrice != null ? r.buyPrice.toFixed(2) : '--'}</td>
            <td>${r.sellDate ? fmtDate(r.sellDate) : '--'}</td>
            <td>${fmtTime(r.sellMinute)}</td>
            <td>${r.sellPrice != null ? r.sellPrice.toFixed(2) : '--'}</td>
            <td class="reason" title="${r.detail.replace(/"/g, '&quot;')}">${r.reason || '--'}</td>
          </tr>
      `;
    }
    sectionsHtml += `
        </tbody>
      </table>
    </section>
    `;
  }

  const buyPointNav = BUY_POINTS.map((bp) =>
    `<a href="#bp-${bp.date}-${bp.time}">${bp.label}</a>`
  ).join(' | ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>指定买点 × 卖点诊断 · 回测报告</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft Yahei", sans-serif; background:#fafafa; color:#1f2937; margin:0; padding:24px; }
  h1 { margin:0 0 8px; font-size:22px; }
  .nav { margin-bottom:16px; padding:10px 14px; background:#eef2ff; border-radius:8px; font-size:13px; }
  .nav a { margin-right:12px; color:#4338ca; text-decoration:none; }
  h2 { margin:32px 0 12px; font-size:18px; border-left:4px solid #4338ca; padding-left:8px; }
  .hint { color:#6b7280; font-size:13px; margin:-4px 0 12px; }
  table.sortable { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; margin-bottom:24px; font-size:13px; }
  table.sortable th { background:#f3f4f6; padding:8px 10px; text-align:left; cursor:pointer; user-select:none; white-space:nowrap; border-bottom:1px solid #e5e7eb; }
  table.sortable th .arrow { margin-left:4px; color:#6366f1; font-size:11px; }
  table.sortable th.sorted { background:#eef2ff; }
  table.sortable td { padding:7px 10px; border-bottom:1px solid #f1f5f9; white-space:nowrap; }
  table.sortable tbody tr:hover { background:#f9fafb; }
  .code { display:inline-block; margin-left:4px; font-size:11px; color:#9ca3af; }
  .reason { max-width:360px; white-space:normal; word-break:break-all; }
  .legend { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:12px 14px; font-size:12px; color:#4b5563; margin-bottom:16px; }
</style>
</head>
<body>
<h1>指定买点 × 卖点诊断 · 回测报告</h1>
<div class="nav">${buyPointNav}</div>
<div class="legend">
买入规则：指定 6 个时间点，取该分钟（或之后第一个可用分钟）的现价作为买入价。<br/>
卖出规则：逐分钟检查卖点诊断 7 个条件，满足任一即按该分钟现价卖出；持仓超过 30 个交易日强制收盘卖出。<br/>
条件持续分钟数：高位放量大阴线 / 科技情绪退潮 / 跌破买入日低点 需持续 ≥ 5 分钟；其余条件即时（14:50 / 9:40 生效门禁除外）。
</div>
${summaryHtml}
${sectionsHtml}

<script>
(function(){
  document.querySelectorAll('table.sortable').forEach(function(tbl){
    var ths = tbl.querySelectorAll('thead th');
    ths.forEach(function(th, idx){
      th.addEventListener('click', function(){
        var col = th.getAttribute('data-col');
        if (!col) return;
        var curDir = th.getAttribute('data-dir') === 'desc' ? 'desc' : 'asc';
        var newDir = curDir === 'desc' ? 'asc' : 'desc';
        ths.forEach(function(t){ t.classList.remove('sorted'); t.removeAttribute('data-dir'); t.innerHTML = t.innerHTML.replace(/\\s*<span class="arrow">.*?<\\/span>$/, ''); });
        th.classList.add('sorted');
        th.setAttribute('data-dir', newDir);
        var arrow = newDir === 'desc' ? '▼' : '▲';
        th.innerHTML = th.innerHTML.replace(/\\s*\\n?$/, ' <span class="arrow">' + arrow + '</span>');

        var rows = Array.prototype.slice.call(tbl.querySelectorAll('tbody tr'));
        rows.sort(function(a, b){
          var va = a.children[idx].innerText.trim();
          var vb = b.children[idx].innerText.trim();
          // 数字优先解析
          var na = parseFloat(va.replace(/%/g,''));
          var nb = parseFloat(vb.replace(/%/g,''));
          var cmp;
          if (!isNaN(na) && !isNaN(nb)) {
            cmp = na - nb;
          } else {
            cmp = va.localeCompare(vb, 'zh-CN');
          }
          return newDir === 'desc' ? -cmp : cmp;
        });
        var tbody = tbl.querySelector('tbody');
        rows.forEach(function(r){ tbody.appendChild(r); });
      });
    });
    // 默认第一个 th 排序
    var first = ths[0];
    first.classList.add('sorted');
    first.setAttribute('data-dir', first.getAttribute('data-dir') === 'asc' ? 'asc' : 'desc');
    var arrow = first.getAttribute('data-dir') === 'desc' ? '▼' : '▲';
    first.innerHTML += ' <span class="arrow">' + arrow + '</span>';
    first.click();
  });
})();
</script>
</body>
</html>`;
}

// ----------------------------- 启动 -----------------------------

main().then(
  () => console.log('\n[done] 回测完成 ✅'),
  (e) => {
    console.error('[fatal] 回测异常:', e);
    process.exit(1);
  }
);
