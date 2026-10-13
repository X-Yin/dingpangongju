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
const {
  fetchDayHtml,
  extractSentiment,
  getLianbanDayData,
  getAvailableLianbanDates,
} = require('./lianban');

const {
  thsSnapshotUrl,
  thsSnapshotHeaders,
} = require('../constant');

// ==================== 1. 市场情绪概览 ====================

const OVERVIEW_CACHE_TTL = 60 * 1000;
let overviewCache = { ts: 0, data: null };
let overviewFetching = null;

const stripTags = (str) => String(str == null ? '' : str).replace(/<[^>]+>/g, '').trim();

// 解析当日复盘页 KPI 情绪卡片（id="s-env"）
const parseMarketKpi = (html) => {
  const startIdx = html.indexOf('id="s-env"');
  if (startIdx === -1) return null;
  const endIdx = html.indexOf('<div class="qnav"', startIdx);
  const seg = html.slice(startIdx, endIdx === -1 ? startIdx + 8000 : endIdx);

  const numOf = (label) => {
    const re = new RegExp(`<div class="l"[^>]*>${label}</div><div class="v[^"]*"[^>]*>([\\d,.]+)(?:<small[^>]*>([^<]*)</small>)?</div>`);
    const m = seg.match(re);
    if (!m) return null;
    return { value: parseFloat(m[1].replace(/,/g, '')), unit: m[2] || '' };
  };

  const upDownM = seg.match(/<div class="l">上涨\/下跌<\/div>[\s\S]*?<span class="up">([\d,]+)<\/span><small>\/<\/small><span class="dn">([\d,]+)<\/span>/);
  const amountM = seg.match(/<div class="l">两市成交<\/div><div class="v"[^>]*>([\d.]+[^<]*)</);

  return {
    limitUpCount: numOf('涨停')?.value ?? null,
    limitDownCount: numOf('跌停')?.value ?? null,
    maxLianban: numOf('最高板') ?? null,
    lianbanCount: numOf('连板')?.value ?? null,
    sealRate: numOf('封板率')?.value ?? null,
    brokenBoardCount: numOf('炸板')?.value ?? null,
    yesterdayZtPerf: numOf('昨涨停今表现')?.value ?? null,
    upCount: upDownM ? parseInt(upDownM[1].replace(/,/g, ''), 10) : null,
    downCount: upDownM ? parseInt(upDownM[2].replace(/,/g, ''), 10) : null,
    totalAmount: amountM ? stripTags(amountM[1]) : null,
  };
};

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
    return { windowDates: [], themes: [], mainLines: [], branches: [] };
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

  return {
    windowDates: dates,
    themes,
    mainLines: themes.filter((t) => t.type === '主线').map((t) => ({ board: t.board, score: t.score, todayCount: t.todayCount })),
    branches: themes.filter((t) => t.type === '支线').slice(0, 6).map((t) => ({ board: t.board, score: t.score, todayCount: t.todayCount })),
    generatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  };
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

// 同花顺 multi_last_snapshot 批量快照
// 响应 value 数组（字段顺序以响应 data_fields 为准）：[成交量(股), 昨收, 今开, 最高, 均价, 最新价]
const fetchThsBatchQuotes = async (codes) => {
  const groups = new Map(); // market -> [pureCode]
  codes.forEach(({ market, pureCode }) => {
    if (!groups.has(market)) groups.set(market, []);
    const arr = groups.get(market);
    if (!arr.includes(pureCode)) arr.push(pureCode);
  });

  const codeList = Array.from(groups.entries()).map(([market, arr]) => ({ codes: arr, market }));
  const body = {
    code_list: codeList,
    trade_class: 'intraday',
    data_fields: ['6', '7', '8', '13', '30', '10'],
    lang: 'zh_hans',
    gpid: 1,
  };

  const res = await axios.post(thsSnapshotUrl, body, { headers: thsSnapshotHeaders, timeout: 10000 });
  if (res.data?.status_code !== 0) {
    throw new Error(`同花顺批量行情返回错误: ${res.data?.status_msg || res.data?.status_code}`);
  }
  const out = {};
  (res.data?.data?.quote_data || []).forEach((item) => {
    const value = Array.isArray(item.value) ? item.value[0] : null;
    if (!Array.isArray(value) || value.length < 3) return;
    const prevClose = Number(value[1]);
    const last = Number(value[value.length - 1]);
    if (!Number.isFinite(prevClose) || !Number.isFinite(last)) return;
    const market = String(item.market);
    const prefix = market === '17' ? 'sh' : 'sz';
    const marketCode = `${prefix}${item.code}`;
    out[marketCode] = {
      code: marketCode,
      price: last,
      prevClose,
      changePct: prevClose > 0 ? Math.round(((last - prevClose) / prevClose) * 10000) / 100 : null,
    };
  });
  return out;
};

const getStockQuotes = async (marketCodes) => {
  const list = (Array.isArray(marketCodes) ? marketCodes : [])
    .map(normalizeQuoteCode)
    .filter(Boolean);
  if (list.length === 0) return {};
  return fetchThsBatchQuotes(list);
};

module.exports = {
  getMarketOverview,
  getThemeAnalysis,
  getStockQuotes,
  parseMarketKpi,
  boardKeyOf,
  dragonScoreOf,
};
