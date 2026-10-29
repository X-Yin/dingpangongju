/**
 * 题材盯盘服务
 *
 * 1. 市场情绪概览：请求 https://lianban.net/today.html（服务端改走 manifest.json 定位最新复盘页），
 *    解析当日 KPI 情绪卡片区（涨停家数 / 跌停 / 封板率 / 炸板 / 情绪温度 / 上涨下跌 / 两市成交等）。
 * 2. 题材 10 日回溯分析：读取 src/data/lianbanSnapshot 最近 10 个交易日的连板快照，
 *    按题材聚合所有涨停过的股票，计算题材权重得分并区分主线 / 支线，
 *    再按龙头评分在每个题材内定位龙一 ~ 龙五。
 * 3. 批量实时行情：同花顺 multi_last_snapshot 接口一次批量拉取全部题材股最新涨跌幅，
 *    供前端每 10s 轮询做异动监控。
 */
const axios = require('axios');
const dayjs = require('dayjs');
const { isTradingDay } = require('../utils/tradingDay');
const { getSingleStockData } = require('./stock');
const { getStore: getThemeCustomStore } = require('./themeCustom');
const {
  fetchDayHtml,
  extractSentiment,
  getLianbanDayData,
  getAvailableLianbanDates,
  parseMarketKpi,
} = require('./lianban');

const {
  thsSnapshotUrl,
  thsSnapshotHeaders,
} = require('../constant');

// ==================== 1. 市场情绪概览 ====================

const OVERVIEW_CACHE_TTL = 60 * 1000;
let overviewCache = { ts: 0, data: null };
let overviewFetching = null;

// 定位最新复盘页日期：manifest.json 第一个条目即最新交易日（需带站内 referer）
const fetchLatestReviewDate = async () => {
  try {
    const res = await axios.get('https://lianban.net/manifest.json', {
      params: { v: dayjs().format('YYYY-MM-DD') },
      headers: {
        referer: 'https://lianban.net/today.html',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    });
    const first = Array.isArray(res.data) ? res.data[0] : null;
    if (first && first.d) return first.d; // 'YYYY-MM-DD'
  } catch (e) {
    console.error('[themeMonitor] 获取最新复盘日期失败，回退本地快照:', e.message);
  }
  return null;
};

const fallbackLatestDate = () => {
  const todayDash = dayjs().format('YYYY-MM-DD');
  if (isTradingDay(new Date())) return todayDash;
  const dates = getAvailableLianbanDates(); // 降序
  if (dates.length > 0) {
    const ymd = dates[0];
    return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  }
  return todayDash;
};

const getMarketOverview = async () => {
  if (overviewCache.data && Date.now() - overviewCache.ts < OVERVIEW_CACHE_TTL) {
    return overviewCache.data;
  }
  if (overviewFetching) return overviewFetching;

  overviewFetching = (async () => {
    const dashDate = (await fetchLatestReviewDate()) || fallbackLatestDate();
    const html = await fetchDayHtml(dashDate);
    const sentiment = extractSentiment(html);
    const kpi = parseMarketKpi(html);
    const data = {
      date: dashDate.replace(/-/g, ''),
      pageDate: dashDate,
      sentiment,
      kpi,
      fetchedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    };
    overviewCache = { ts: Date.now(), data };
    return data;
  })();

  try {
    return await overviewFetching;
  } finally {
    overviewFetching = null;
  }
};

// ==================== 2. 题材 10 日回溯分析 ====================

const ANALYSIS_CACHE_TTL = 60 * 1000;
let analysisCache = { ts: 0, data: null };
let analysisFetching = null;

const WINDOW_DAYS = 10;

// 板块名归一化 key：去掉括号后缀（如 化工(分散染料) → 化工），用于跨日合并同名题材
const boardKeyOf = (board) => String(board || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();

const sealTimeMinutes = (time) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return 24 * 60; // 无封板时间排最后
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

// 龙头评分：连板高度主导，叠加窗口内涨停次数 / 龙头标记 / 近期活跃度 / 今日仍在榜
const dragonScoreOf = (stock) => {
  const lastSeenDaysAgo = stock.lastSeenDaysAgo;
  const recency = lastSeenDaysAgo === 0 ? 6 : lastSeenDaysAgo === 1 ? 4 : lastSeenDaysAgo === 2 ? 2 : 0;
  return (
    (stock.maxLianban || 1) * 10
    + stock.limitUpDays * 3
    + (stock.isLeader ? 8 : 0)
    + recency
    + (stock.todayLimitUp ? 3 : 0)
  );
};

// 排序比较：评分 → 连板高度 → 涨停天数 → 龙头 → 封板时间早者优先
const compareDragon = (a, b) => {
  if (b.dragonScore !== a.dragonScore) return b.dragonScore - a.dragonScore;
  if (b.maxLianban !== a.maxLianban) return (b.maxLianban || 1) - (a.maxLianban || 1);
  if (b.limitUpDays !== a.limitUpDays) return b.limitUpDays - a.limitUpDays;
  if (b.isLeader !== a.isLeader) return b.isLeader ? 1 : -1;
  return sealTimeMinutes(a.minSealTime) - sealTimeMinutes(b.minSealTime);
};

const buildThemeAnalysis = () => {
  const todayYmd = dayjs().format('YYYYMMDD');
  const allDates = getAvailableLianbanDates(); // 降序
  const dates = allDates.filter((d) => d <= todayYmd).slice(0, WINDOW_DAYS).reverse(); // 升序
  if (dates.length === 0) {
    const { customThemes } = applyThemeOverrides([]);
    return { windowDates: [], themes: [], customThemes, overrides: {}, mainLines: [], branches: [] };
  }

  const themesMap = new Map(); // key -> 聚合题材
  const totalDays = dates.length;

  dates.forEach((ymd, dayIdx) => {
    const day = getLianbanDayData(ymd);
    if (!day || !Array.isArray(day.themes)) return;
    day.themes.forEach((theme) => {
      const key = boardKeyOf(theme.board) || theme.board;
      if (!key || key === '其他') return; // 排除“其他”兜底题材
      let agg = themesMap.get(key);
      if (!agg) {
        agg = {
          key,
          displayName: theme.board,
          displayNameCount: {},
          dailyCounts: {},
          firstDate: ymd,
          lastDate: ymd,
          stocks: new Map(),
          leaderCodes: new Set(),
        };
        themesMap.set(key, agg);
      }
      agg.displayNameCount[theme.board] = (agg.displayNameCount[theme.board] || 0) + 1;
      agg.dailyCounts[ymd] = (agg.dailyCounts[ymd] || 0) + (theme.stocks?.length || 0);
      agg.lastDate = ymd > agg.lastDate ? ymd : agg.lastDate;
      agg.firstDate = ymd < agg.firstDate ? ymd : agg.firstDate;

      (theme.stocks || []).forEach((s) => {
        if (!s.code) return;
        let st = agg.stocks.get(s.code);
        if (!st) {
          st = {
            code: s.code,
            marketCode: s.marketCode || '',
            name: s.name,
            concept: s.concept || '',
            days: [],
            dayRecords: [],
            maxLianban: 1,
            latestLianbanText: '',
            latestTextDate: '',
            isLeader: false,
            minSealTime: '',
            minSealMinutes: 24 * 60,
            floatMarketValueYi: null,
          };
          agg.stocks.set(s.code, st);
        }
        st.days.push(ymd);
        const lb = Number(s.lianbanCount);
        st.dayRecords.push({ ymd, lianbanCount: Number.isFinite(lb) ? lb : 1 });
        if (Number.isFinite(lb) && lb > st.maxLianban) st.maxLianban = lb;
        if (s.lianbanText) {
          if (!st.latestTextDate || ymd >= st.latestTextDate) {
            st.latestLianbanText = s.lianbanText;
            st.latestTextDate = ymd;
          }
        }
        if (s.leader) {
          st.isLeader = true;
          agg.leaderCodes.add(s.code);
        }
        const mins = sealTimeMinutes(s.sealTime);
        if (mins < st.minSealMinutes) {
          st.minSealMinutes = mins;
          st.minSealTime = s.sealTime || '';
        }
        const fmv = s.quote?.floatMarketValueYi;
        if (Number.isFinite(Number(fmv))) st.floatMarketValueYi = Number(fmv);
      });
    });
  });

  const themes = Array.from(themesMap.values()).map((agg) => {
    // 展示名取出现次数最多（次数相同取最近）的板块名
    let displayName = agg.displayName;
    let maxCount = -1;
    Object.entries(agg.displayNameCount).forEach(([name, count]) => {
      if (count > maxCount || (count === maxCount && name.length > displayName.length)) {
        displayName = name;
        maxCount = count;
      }
    });

    const dailyCounts = dates.map((ymd) => agg.dailyCounts[ymd] || 0);
    const totalLimitUp = dailyCounts.reduce((a, b) => a + b, 0);
    const todayCount = dailyCounts[dailyCounts.length - 1] || 0;

    // 题材权重：近 10 日涨停家数按 0.85^(间隔天数) 衰减加权 + 连板高度加成 + 龙头数量加成
    let score = 0;
    let lianbanBonus = 0;
    dailyCounts.forEach((cnt, idx) => {
      const decay = Math.pow(0.85, totalDays - 1 - idx);
      score += cnt * decay;
    });
    const stockList = Array.from(agg.stocks.values()).map((st) => {
      const lastSeenDaysAgo = totalDays - 1 - dates.indexOf(st.days[st.days.length - 1]);
      const todayLimitUp = st.days.includes(dates[dates.length - 1]);
      // 连板加成：Σ 每次涨停的超额连板高度
      st.limitUpDays = st.days.length;
      st.lastSeenDaysAgo = lastSeenDaysAgo;
      st.todayLimitUp = todayLimitUp;
      st.dragonScore = dragonScoreOf(st);
      st.dayRecords.forEach(({ ymd, lianbanCount }) => {
        const decay = Math.pow(0.85, totalDays - 1 - dates.indexOf(ymd));
        lianbanBonus += Math.max(0, lianbanCount - 1) * 0.6 * decay;
      });
      return st;
    });
    score += lianbanBonus + agg.leaderCodes.size * 1.5;
    score = Math.round(score * 10) / 10;

    const sortedStocks = [...stockList].sort(compareDragon).map((s) => ({
      code: s.code,
      marketCode: s.marketCode,
      name: s.name,
      concept: s.concept,
      limitUpDays: s.limitUpDays,
      maxLianban: s.maxLianban,
      lianbanText: s.latestLianbanText,
      lastSeenDate: s.days[s.days.length - 1],
      lastSeenDaysAgo: s.lastSeenDaysAgo,
      todayLimitUp: s.todayLimitUp,
      isLeader: s.isLeader,
      minSealTime: s.minSealTime,
      floatMarketValueYi: s.floatMarketValueYi,
      dragonScore: s.dragonScore,
    }));
    const dragons = sortedStocks.slice(0, 5).map((s, idx) => ({ ...s, dragonRank: idx + 1 }));

    return {
      board: displayName,
      key: agg.key,
      score,
      dailyCounts,
      todayCount,
      totalLimitUp,
      stockCount: stockList.length,
      maxLianban: stockList.reduce((mx, s) => Math.max(mx, s.maxLianban || 1), 1),
      leaderCount: agg.leaderCodes.size,
      stocks: sortedStocks,
      dragons,
    };
  }).sort((a, b) => b.score - a.score);

  themes.forEach((t, idx) => {
    t.rank = idx + 1;
    t.type = idx < 3 ? '主线' : '支线';
  });

  const { customThemes, overrides } = applyThemeOverrides(themes);

  return {
    windowDates: dates,
    // 最近一次快照日期（YYYYMMDD）。快照为每日复盘数据，盘中当天文件尚未生成时，
    // todayCount 实际是上一交易日的涨停家数，前端需据此标注口径
    latestSnapshotDate: dates[dates.length - 1],
    themes,
    customThemes,
    overrides,
    mainLines: themes.filter((t) => t.type === '主线').map((t) => ({ board: t.board, score: t.score, todayCount: t.todayCount })),
    branches: themes.filter((t) => t.type === '支线').slice(0, 6).map((t) => ({ board: t.board, score: t.score, todayCount: t.todayCount })),
    generatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };
};

// 股票条目标识：优先用带市前缀的 marketCode，缺省回退纯代码
const stockKeyOf = (s) => String(s?.marketCode || s?.code || '').trim();

// 由 { code, name }（code 为 marketCode）构造最小展示字段的股票对象，供个股增删覆盖 / 自定义题材使用
const buildMinimalStock = ({ code, name }) => {
  const mc = String(code || '').trim();
  const pureCode = mc.replace(/^(sh|sz|bj)/i, '');
  return {
    code: pureCode || mc,
    marketCode: mc,
    name: String(name || mc).trim(),
    concept: '',
    limitUpDays: 0,
    maxLianban: 1,
    lianbanText: '--',
    isLeader: false,
    lastSeenDaysAgo: null,
    todayLimitUp: false,
    minSealTime: '',
    floatMarketValueYi: null,
    dragonScore: 0,
  };
};

// 读取自定义题材 store，对系统题材应用个股增删覆盖，并产出 customThemes 列表
const applyThemeOverrides = (themes) => {
  let store = { themes: [], overrides: {}, order: [] };
  try {
    store = getThemeCustomStore();
  } catch (e) {
    console.error('[themeMonitor] 读取自定义题材数据失败:', e.message);
  }
  const overrides = store.overrides || {};

  (themes || []).forEach((theme) => {
    const ov = overrides[theme.key];
    if (!ov) return;
    const removedSet = new Set((ov.removed || []).map((c) => String(c || '').trim()).filter(Boolean));
    const existingKeys = new Set((theme.stocks || []).map(stockKeyOf));
    const keptStocks = (theme.stocks || []).filter((s) => !removedSet.has(stockKeyOf(s)));
    const addedStocks = (ov.added || [])
      .filter((s) => s && s.code && !removedSet.has(String(s.code).trim()) && !existingKeys.has(String(s.code).trim()))
      .map(buildMinimalStock);
    addedStocks.forEach((s) => existingKeys.add(stockKeyOf(s)));
    theme.stocks = [...keptStocks, ...addedStocks];
    theme.dragons = (theme.dragons || []).filter((d) => !removedSet.has(stockKeyOf(d)));
    theme.stockCount = theme.stocks.length;
  });

  const customThemes = (store.themes || []).map((t) => ({
    key: `custom:${t.id}`,
    id: t.id,
    board: t.name,
    custom: true,
    type: '自定义',
    rank: 0,
    score: null,
    totalLimitUp: 0,
    todayCount: 0,
    dailyCounts: [],
    maxLianban: 0,
    leaderCount: 0,
    stockCount: (t.stocks || []).length,
    stocks: (t.stocks || []).map(buildMinimalStock),
    dragons: [],
  }));

  return { customThemes, overrides };
};

const getThemeAnalysis = async () => {
  if (analysisCache.data && Date.now() - analysisCache.ts < ANALYSIS_CACHE_TTL) {
    return analysisCache.data;
  }
  if (analysisFetching) return analysisFetching;

  analysisFetching = (async () => {
    const data = buildThemeAnalysis();
    analysisCache = { ts: Date.now(), data };
    return data;
  })();

  try {
    return await analysisFetching;
  } finally {
    analysisFetching = null;
  }
};

// ==================== 3. 批量实时行情 ====================

// marketCode -> { sh|sz 前缀 + 纯代码 }；北交所(bj) 等不支持的市场跳过
const normalizeQuoteCode = (marketCode) => {
  const code = String(marketCode || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = /^(sh|sz)(\d{6})$/.exec(code);
  if (!m) return null;
  const market = m[1] === 'sh' ? '17' : '33';
  return { market, pureCode: m[2], marketCode: `${m[1]}${m[2]}` };
};

// 同花顺 multi_last_snapshot 单次请求代码数上限约 200 只，超出后整批返回空（status_code 仍为 0），
// 因此按市场分组后拆成不超过 100 只的批次并发请求，再合并结果
const THS_QUOTE_CHUNK_SIZE = 100;

// 响应 value 数组（字段顺序以响应 data_fields 为准）：[成交量(股), 昨收, 今开, 最高, 均价, 最新价]
const fetchThsBatchQuotes = async (codes) => {
  const groups = new Map(); // market -> [pureCode]
  codes.forEach(({ market, pureCode }) => {
    if (!groups.has(market)) groups.set(market, []);
    const arr = groups.get(market);
    if (!arr.includes(pureCode)) arr.push(pureCode);
  });

  const chunks = [];
  groups.forEach((arr, market) => {
    for (let i = 0; i < arr.length; i += THS_QUOTE_CHUNK_SIZE) {
      chunks.push({ market, codes: arr.slice(i, i + THS_QUOTE_CHUNK_SIZE) });
    }
  });
  if (chunks.length === 0) return {};

  const out = {};
  const responses = await Promise.all(chunks.map((chunk) => axios.post(thsSnapshotUrl, {
    code_list: [chunk],
    trade_class: 'intraday',
    data_fields: ['6', '7', '8', '13', '30', '10'],
    lang: 'zh_hans',
    gpid: 1,
  }, { headers: thsSnapshotHeaders, timeout: 10000 }).catch((e) => {
    // 单块失败不影响其它块，记录日志后按无行情处理
    console.error('[themeMonitor] 批量行情分块请求失败:', e.message);
    return null;
  })));

  responses.forEach((res) => {
    if (!res) return;
    if (res.data?.status_code !== 0) {
      console.error(`[themeMonitor] 同花顺批量行情返回错误: ${res.data?.status_msg || res.data?.status_code}`);
      return;
    }
    (res.data?.data?.quote_data || []).forEach((item) => {
      const value = Array.isArray(item.value) ? item.value[0] : null;
      if (!Array.isArray(value) || value.length < 3) return;
      const market = String(item.market);
      const prefix = market === '17' ? 'sh' : 'sz';
      const marketCode = `${prefix}${item.code}`;
      const prevClose = Number(value[1]);
      const rawLast = value[value.length - 1];
      const last = Number(rawLast);
      if (!Number.isFinite(prevClose)) return;
      // 停牌股：同花顺返回最新价为 null（Number(null)===0，不能直接参与计算），标记 suspended
      if (rawLast == null || !Number.isFinite(last) || last <= 0) {
        out[marketCode] = { code: marketCode, price: null, prevClose, changePct: null, suspended: true };
        return;
      }
      out[marketCode] = {
        code: marketCode,
        price: last,
        prevClose,
        changePct: prevClose > 0 ? Math.round(((last - prevClose) / prevClose) * 10000) / 100 : null,
      };
    });
  });
  return out;
};

// ==================== 4. 题材历史弹窗（近 N 日情绪 + 题材每日涨停数） ====================

const HISTORY_CACHE_TTL = 60 * 1000;
let themeHistoryCache = { ts: 0, data: null, days: 0 };

// 近 days 个交易日：每日情绪温度 / 各题材每日涨停家数（boardKeyOf 归一化聚合）/ 每日涨停最多的题材
const getThemeHistory = (days = 30) => {
  if (themeHistoryCache.data && themeHistoryCache.days === days && Date.now() - themeHistoryCache.ts < HISTORY_CACHE_TTL) {
    return themeHistoryCache.data;
  }
  const todayYmd = dayjs().format('YYYYMMDD');
  const dates = getAvailableLianbanDates().filter((d) => d <= todayYmd).slice(0, days).reverse(); // 升序
  const perTheme = new Map(); // key -> { nameCount, ymdCounts: Map(ymd -> count) }
  const sentiment = [];
  const topByDate = [];

  dates.forEach((ymd) => {
    const day = getLianbanDayData(ymd);
    sentiment.push(day?.sentiment
      ? { phase: day.sentiment.phase || null, temperature: day.sentiment.temperature ?? null }
      : null);

    const dayKeyCount = new Map();
    let topBoard = null;
    let topCount = -1;
    (day?.themes || []).forEach((t) => {
      const key = boardKeyOf(t.board) || t.board;
      const cnt = t.stocks?.length || 0;
      if (!key || key === '其他') return;
      if (cnt > topCount) { topCount = cnt; topBoard = t.board; }
      dayKeyCount.set(key, (dayKeyCount.get(key) || 0) + cnt);
      let agg = perTheme.get(key);
      if (!agg) {
        agg = { nameCount: {}, ymdCounts: new Map() };
        perTheme.set(key, agg);
      }
      agg.nameCount[t.board] = (agg.nameCount[t.board] || 0) + 1;
      agg.ymdCounts.set(ymd, (agg.ymdCounts.get(ymd) || 0) + cnt);
    });
    topByDate.push(topBoard ? { board: topBoard, count: topCount } : null);
  });

  const themeCounts = {};
  Array.from(perTheme.entries()).forEach(([key, agg]) => {
    // 展示名取窗口内出现次数最多（次数相同取名字最长）的板块名
    let name = key;
    let maxCount = -1;
    Object.entries(agg.nameCount).forEach(([nm, c]) => {
      if (c > maxCount || (c === maxCount && nm.length > name.length)) {
        name = nm;
        maxCount = c;
      }
    });
    const counts = dates.map((ymd) => agg.ymdCounts.get(ymd) || 0);
    themeCounts[key] = { name, counts, total: counts.reduce((a, b) => a + b, 0) };
  });

  const data = {
    dates,
    sentiment,
    themeCounts,
    topByDate,
    generatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };
  themeHistoryCache = { ts: Date.now(), data, days };
  return data;
};

// 个股日 K 内存缓存（历史区间数据不可变，短 TTL 防御当日实时更新）
const klineCache = new Map(); // code -> { data, ts }
const KLINE_CACHE_TTL = 10 * 60 * 1000;
const getKlineCached = async (code) => {
  const hit = klineCache.get(code);
  if (hit && Date.now() - hit.ts < KLINE_CACHE_TTL) return hit.data;
  const data = await getSingleStockData(code, 60);
  if (klineCache.size > 800) klineCache.clear();
  klineCache.set(code, { data, ts: Date.now() });
  return data;
};

// 某交易日某题材的涨停股列表：当日涨幅（快照）、连板标签、近 3 个交易日历史涨幅（日 K）
const getThemeDayStocks = async (dateYmd, themeKey) => {
  const key = String(themeKey || '');
  const day = getLianbanDayData(String(dateYmd || '').replace(/\D/g, ''));
  const theme = day && Array.isArray(day.themes)
    ? day.themes.find((t) => (boardKeyOf(t.board) || t.board) === key)
    : null;
  if (!theme) {
    return { date: dateYmd, theme: key, name: key, stocks: [] };
  }

  const stocks = await Promise.all((theme.stocks || []).map(async (s) => {
    let prevChanges = null;
    let changePct = s.quote?.changePct ?? null;
    try {
      const kline = await getKlineCached(s.code);
      if (Array.isArray(kline) && kline.length > 0) {
        const numDate = Number(dateYmd);
        // 快照当日涨幅缺失时，用所选交易日当日的日 K 涨幅兜底（保证展示的是该日当日涨幅）
        if (changePct == null) {
          const sameDay = kline.find((k) => Number(k.trade_date) === numDate);
          if (sameDay && sameDay.change != null) changePct = sameDay.change;
        }
        // 日 K 降序，取所选交易日之前最近 3 天的涨跌幅，反转为时间正序 [T-3, T-2, T-1]
        prevChanges = kline
          .filter((k) => k.trade_date < numDate)
          .slice(0, 3)
          .map((k) => (k.change != null ? k.change : null))
          .reverse();
      }
    } catch (e) {
      prevChanges = null;
    }
    return {
      code: s.code,
      marketCode: s.marketCode || '',
      name: s.name,
      lianbanText: s.lianbanText || (Number(s.lianbanCount) === 1 ? '首板' : ''),
      changePct,
      prevChanges,
    };
  }));

  return { date: dateYmd, theme: key, name: theme.board, stocks };
};

const getStockQuotes = async (marketCodes) => {
  const list = (Array.isArray(marketCodes) ? marketCodes : [])
    .map(normalizeQuoteCode)
    .filter(Boolean);
  if (list.length === 0) return {};
  return fetchThsBatchQuotes(list);
};

// 自定义题材 / 个股增删 / 横幅排序写操作后调用，使 60s 分析缓存立即失效
const invalidateThemeAnalysisCache = () => {
  analysisCache = { ts: 0, data: null };
};

module.exports = {
  getMarketOverview,
  getThemeAnalysis,
  getStockQuotes,
  getThemeHistory,
  getThemeDayStocks,
  invalidateThemeAnalysisCache,
  parseMarketKpi,
  boardKeyOf,
  dragonScoreOf,
};
