/**
 * 情绪周期实时快照：同花顺 + 财联社并行取数（请求分工 7:3）
 *
 * - 同花顺（7 成）：涨停池明细（题材/连板/封板时间/封单）+ 70% 个股实时快照
 * - 财联社（3 成）：市场情绪 KPI（涨跌家数/两市成交/封板率/炸板/连板结构/市场温度）+ 30% 个股基础行情
 *
 * 目标 10s 内完成全部请求；不做整体硬超时，由前端继续计时等待所有请求返回。
 * 历史快照仍以 lianbanSnapshot 为准，本模块只生成「当日实时」快照，不落盘。
 */
const axios = require('axios');
const dayjs = require('dayjs');
const { getRealtimeQuotes } = require('./stock');
const { getLianbanDayData, getAvailableLianbanDates } = require('./lianban');
const {
  getClsReqEmotionUrl,
  getClsReqStockBasicUrl,
  batchParallel,
  isTradingDay,
} = require('../utils');

const THS_SHARE = 0.7;
const TARGET_MS = 10 * 1000;
const REQUEST_TIMEOUT = 8 * 1000;
const CLS_QUOTE_TIMEOUT = 3 * 1000;

const THS_POOL_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool';
const THS_FIELDS = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9004,9005';
const THS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html',
  'Accept': 'application/json, text/plain, */*',
};
const CLS_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Origin': 'https://www.cls.cn',
  'Referer': 'https://www.cls.cn/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const round = (v, digits = 2) => {
  if (!Number.isFinite(Number(v))) return null;
  const p = Math.pow(10, digits);
  return Math.round(Number(v) * p) / p;
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const pureCodeOf = (code) => String(code || '').replace(/^[a-zA-Z]+/, '').trim();

const marketCodeOf = (code, marketId) => {
  const c = String(code || '').trim();
  if (/^[69]/.test(c)) return `sh${c}`;
  if (/^[023]/.test(c)) return `sz${c}`;
  if (/^[48]/.test(c)) return `bj${c}`;
  return `${Number(marketId) === 17 ? 'sh' : 'sz'}${c}`;
};

// 同花顺 high_days_value 高 16 位为连板数、低 16 位为统计天数；异常时回退解析 high_days 文本
const boardCountOf = (item) => {
  const encoded = Number(item?.high_days_value);
  if (Number.isFinite(encoded) && encoded > 0) {
    const count = encoded >> 16;
    if (count > 0) return count;
  }
  const m = String(item?.high_days || '').match(/(\d+)\s*板/);
  return m ? Number(m[1]) : 1;
};

const splitReason = (reason) => String(reason || '')
  .split(/[+＋、,，;；]/)
  .map((s) => s.trim())
  .filter(Boolean);

// 题材归一：同花顺涨停原因的细分表述（人形机器人/机器人关节/机器人股东/防冰机器人…）
// 统一归并到主题材，键名与连板网快照历史口径保持一致（否则 10 日涨停家数序列会断）
const THEME_CANON = [
  { test: /机器人/, key: '机器人概念' },
];

const normalizeThemeKey = (name) => {
  const s = String(name || '')
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .trim();
  if (!s) return '';
  const rule = THEME_CANON.find((r) => r.test.test(s));
  return rule ? rule.key : s;
};

// 通用利好段（回购/业绩/三季报扭亏等）：没有题材指向性，作为归组依据时跳过
const GENERIC_REASON_RE = /(回购|增持|减持|中标|业绩|预增|预亏|扭亏|减亏|增亏|三季报|中报|年报|季报|股权激励|并购|重组|收购|摘帽|高送转|分红|派息|次新|破净|债务|控制权变更|实控人变更)/;

// 当日题材归属：与连板网今日页口径对齐
// 1. 前一交易日已归组且当日原因仍能印证原板块 → 沿用（保持个股板块稳定）；
// 2. 原因分段归一后命中 THEME_CANON 主题材（新题材爆发日优先级最高）；
// 3. 分段命中近期快照已有的题材（保持与历史序列连续）；
// 4. 兜底取第一个非通用利好分段，再退回旧板块/其他
const boardOfReason = (reason, ref, knownBoards) => {
  const segs = [];
  splitReason(reason).forEach((seg) => {
    const k = normalizeThemeKey(seg);
    if (k && !segs.includes(k)) segs.push(k);
  });
  const refBoard = ref?.board ? String(ref.board).trim() : '';
  const refKey = normalizeThemeKey(refBoard);
  const refConfirmed = refKey && refKey !== '其他'
    && segs.some((s) => s === refKey || s.includes(refKey) || refKey.includes(s));
  if (refConfirmed) return refBoard;
  const canonKey = segs.find((s) => THEME_CANON.some((r) => r.key === s));
  if (canonKey) return canonKey;
  const fromKnown = segs.find((s) => knownBoards.has(s));
  if (fromKnown) return fromKnown;
  const firstReal = segs.find((s) => !GENERIC_REASON_RE.test(s));
  return firstReal || segs[0] || refBoard || '其他';
};

const sealTimeOf = (timestamp) => {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = dayjs.unix(ts);
  if (d.year() < 2000 || d.year() > 2100) return '';
  return d.format('HH:mm');
};

const derivePhase = (limitUp) => {
  if (limitUp <= 20) return '冰点期';
  if (limitUp <= 40) return '退潮期';
  if (limitUp <= 60) return '弱势震荡';
  if (limitUp <= 90) return '修复期';
  return '高潮期';
};

// ==================== 同花顺 ====================

const fetchThsLimitUpPool = async (ymd) => {
  const all = [];
  let total = Infinity;
  for (let page = 1; page <= 5 && all.length < total; page += 1) {
    const { data } = await axios.get(THS_POOL_URL, {
      params: {
        page,
        limit: 200,
        field: THS_FIELDS,
        filter: 'HS,GEM2STAR',
        order_field: '330324',
        order_type: 0,
        date: ymd,
      },
      headers: THS_HEADERS,
      timeout: REQUEST_TIMEOUT,
    });
    const info = data?.data?.info;
    if (!Array.isArray(info) || info.length === 0) break;
    total = Number(data?.data?.page?.total) || info.length;
    all.push(...info);
    if (info.length < 200) break;
  }
  return all;
};

// ==================== 财联社 ====================

const fetchClsEmotion = async () => {
  const { data } = await axios.get(getClsReqEmotionUrl(), {
    headers: CLS_HEADERS,
    timeout: REQUEST_TIMEOUT,
  });
  return data?.code === 200 ? data.data : null;
};

const fetchClsQuote = async (marketCode) => {
  try {
    const { data } = await axios.get(getClsReqStockBasicUrl(marketCode), {
      headers: CLS_HEADERS,
      timeout: CLS_QUOTE_TIMEOUT,
    });
    const d = data?.code === 200 ? data.data : null;
    if (!d) return null;
    return {
      price: num(d.last_px),
      // 财联社 change / tr 为小数比例
      changePct: num(d.change) != null ? round(num(d.change) * 100, 2) : null,
      open: num(d.open_px),
      prevClose: num(d.preclose_px),
      turnoverRate: num(d.tr) != null ? round(num(d.tr) * 100, 2) : null,
      amountWan: num(d.business_balance) != null ? round(num(d.business_balance) / 1e4, 0) : null,
      pe: num(d.pe),
      pb: num(d.pb),
      floatMarketValueYi: num(d.cmc) != null ? round(num(d.cmc) / 1e8, 2) : null,
    };
  } catch (e) {
    return null;
  }
};

const buildLimitUpHistory = (todayYmd) => {
  const dates = getAvailableLianbanDates().filter((d) => d < todayYmd).slice(0, 20);
  return dates.map((ymd) => {
    const day = getLianbanDayData(ymd);
    const set = new Set();
    (day?.themes || []).forEach((theme) => {
      (theme.stocks || []).forEach((s) => {
        const code = pureCodeOf(s.code);
        if (code) set.add(code);
      });
    });
    return set;
  }).filter((set) => set.size > 0);
};

// 连板数 = 含今日在内、连续出现在涨停快照中的天数（与连板网口径一致）
const streakOf = (code, history) => {
  let count = 1;
  for (const set of history) {
    if (!set.has(code)) break;
    count += 1;
  }
  return count;
};

// ==================== 快照组装 ====================

// 题材名沿用最近一份连板网快照的分组（保留历史口径）；新出现的股票用同花顺涨停原因首段兜底
const getReferenceThemes = (todayYmd) => {
  const today = getLianbanDayData(todayYmd);
  const refDay = today || (() => {
    const prev = getAvailableLianbanDates().filter((d) => d < todayYmd);
    return prev.length ? getLianbanDayData(prev[0]) : null;
  })();
  const map = new Map();
  if (!refDay || !Array.isArray(refDay.themes)) return map;
  refDay.themes.forEach((theme) => {
    (theme.stocks || []).forEach((s) => {
      const code = pureCodeOf(s.code);
      if (!code) return;
      map.set(code, {
        board: theme.board,
        concept: s.concept,
        concepts: s.concepts,
        reason: s.reason,
      });
    });
  });
  return map;
};

const buildTodaySnapshot = async () => {
  const startedAt = Date.now();
  const todayYmd = dayjs().format('YYYYMMDD');
  if (!isTradingDay(new Date())) return null;

  // 第一步：同花顺涨停池 + 财联社市场情绪，并行发出
  let pool = [];
  let emotion = null;
  await Promise.all([
    fetchThsLimitUpPool(todayYmd)
      .then((list) => { pool = list; })
      .catch((e) => console.warn('[emotionCycleRealtime] 同花顺涨停池获取失败:', e.message)),
    fetchClsEmotion()
      .then((data) => { emotion = data; })
      .catch((e) => console.warn('[emotionCycleRealtime] 财联社情绪数据获取失败:', e.message)),
  ]);

  if (!Array.isArray(pool) || pool.length === 0) {
    console.log('[emotionCycleRealtime] 当日暂无涨停池数据，沿用历史快照');
    return null;
  }

  const refThemes = getReferenceThemes(todayYmd);
  const limitUpHistory = buildLimitUpHistory(todayYmd);
  // 近期快照中出现过的题材（归一后），供当日归组保持序列连续
  const knownBoards = new Set();
  refThemes.forEach((v) => {
    const k = normalizeThemeKey(v.board);
    if (k && k !== '其他') knownBoards.add(k);
  });
  const stocks = pool.map((item) => {
    const code = pureCodeOf(item.code);
    const marketCode = marketCodeOf(code, item.market_id);
    const lianbanCount = limitUpHistory.length ? streakOf(code, limitUpHistory) : boardCountOf(item);
    const reasonParts = splitReason(item.reason_type);
    const ref = refThemes.get(code);
    const board = boardOfReason(item.reason_type, ref, knownBoards);
    const sealTime = sealTimeOf(item.first_limit_up_time);
    const sealMinutes = sealTime
      ? Number(sealTime.slice(0, 2)) * 60 + Number(sealTime.slice(3, 5))
      : null;
    const price = num(item.latest);
    const changePct = num(item.change_rate);
    const prevClose = price != null && changePct != null && changePct !== -100
      ? round(price / (1 + changePct / 100), 2)
      : null;
    const fmv = num(item.currency_value) != null ? round(num(item.currency_value) / 1e8, 2) : null;
    return {
      code,
      name: item.name,
      board,
      marketCode,
      sealTime,
      early: sealMinutes != null ? sealMinutes <= 9 * 60 + 35 : false,
      leader: false,
      lianbanCount,
      lianbanText: item.high_days || (lianbanCount > 1 ? `${lianbanCount}连板` : '首板'),
      fanbao: Number(item.is_again_limit) === 1,
      concept: ref?.concept || reasonParts[0] || '',
      concepts: ref?.concepts || reasonParts.slice(1).join('、'),
      reason: item.reason_type || '',
      quote: {
        price,
        changePct,
        open: null,
        prevClose,
        amplitude: null,
        turnoverRate: num(item.turnover_rate),
        amountWan: null,
        pe: null,
        pb: null,
        floatMarketValueYi: fmv,
        totalMarketValueYi: null,
        fmv,
        tn: num(item.turnover_rate),
      },
    };
  });

  // 第二步：个股行情按 7:3 分工——同花顺 70%，财联社 30%，两边并行
  const thsCount = Math.round(stocks.length * THS_SHARE);
  const thsStocks = stocks.slice(0, thsCount);
  const clsStocks = stocks.slice(thsCount);

  await Promise.all([
    thsStocks.length
      ? getRealtimeQuotes(thsStocks.map((s) => s.code))
        .then((quotes) => {
          thsStocks.forEach((s) => {
            const q = quotes?.[s.code];
            if (!q) return;
            if (q.price != null) s.quote.price = q.price;
            if (q.change != null) s.quote.changePct = q.change;
            if (q.preclose != null) s.quote.prevClose = q.preclose;
          });
        })
        .catch((e) => console.warn('[emotionCycleRealtime] 同花顺个股快照失败:', e.message))
      : Promise.resolve(),
    clsStocks.length
      ? batchParallel(clsStocks, async (s) => {
        const q = await fetchClsQuote(s.marketCode);
        if (!q) return;
        ['price', 'changePct', 'open', 'prevClose', 'turnoverRate', 'amountWan', 'pe', 'pb', 'floatMarketValueYi'].forEach((key) => {
          if (q[key] != null) s.quote[key] = q[key];
        });
        if (q.floatMarketValueYi != null) s.quote.fmv = q.floatMarketValueYi;
      }, 10)
      : Promise.resolve(),
  ]);

  // 题材分组 + 每个题材按连板/封单挑一只龙头
  const themeMap = new Map();
  stocks.forEach((s) => {
    if (!themeMap.has(s.board)) themeMap.set(s.board, []);
    themeMap.get(s.board).push(s);
  });
  const themes = Array.from(themeMap.entries())
    .map(([board, list], index) => {
      const sorted = [...list].sort((a, b) => {
        if (b.lianbanCount !== a.lianbanCount) return b.lianbanCount - a.lianbanCount;
        return (Number(b.quote.fmv) || 0) - (Number(a.quote.fmv) || 0);
      });
      if (sorted.length) sorted[0].leader = true;
      return {
        rank: index + 1,
        board,
        count: list.length,
        reason: null,
        stocks: sorted,
      };
    })
    .sort((a, b) => b.count - a.count)
    .map((theme, index) => ({ ...theme, rank: index + 1 }));

  const firstBoardCount = stocks.filter((s) => s.lianbanCount <= 1).length;
  const lianbanCount = stocks.length - firstBoardCount;
  const maxBoard = stocks.reduce((mx, s) => Math.max(mx, s.lianbanCount), 0);

  const dis = emotion?.up_down_dis || {};
  const limitUp = num(emotion?.up_ratio_num) ?? stocks.length;
  const broken = num(emotion?.up_open_num) ?? 0;
  const sealRate = limitUp + broken > 0 ? round((limitUp / (limitUp + broken)) * 100, 1) : null;
  const temperature = num(emotion?.market_degree);

  const snapshot = {
    date: todayYmd,
    pageDate: dayjs().format('YYYY-MM-DD'),
    sourceUrl: 'ths+cls',
    fetchedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    summary: {
      totalCount: stocks.length,
      themeCount: themes.length,
      lianbanCount,
      firstBoardCount,
      leaderCount: themes.length,
    },
    sentiment: {
      phase: derivePhase(limitUp),
      temperature: temperature != null ? temperature : null,
    },
    kpi: {
      limitUpCount: limitUp,
      limitDownCount: num(dis.down_num),
      maxLianban: { value: maxBoard, unit: '板' },
      lianbanCount,
      sealRate,
      brokenBoardCount: broken,
      yesterdayZtPerf: num(emotion?.performance),
      upCount: num(dis.rise_num),
      downCount: num(dis.fall_num),
      totalAmount: emotion?.shsz_balance || null,
    },
    ladder: (() => {
      const byBoard = new Map();
      stocks.forEach((s) => {
        const board = s.lianbanCount;
        if (!byBoard.has(board)) byBoard.set(board, []);
        byBoard.get(board).push(s.code);
      });
      return Array.from(byBoard.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([board, codes]) => ({
          board: `${board}板`,
          lianbanCount: board,
          count: codes.length,
          codes,
        }));
    })(),
    themes,
  };

  const elapsed = Date.now() - startedAt;
  const over = elapsed > TARGET_MS ? `（超出 10s 目标）` : '';
  console.log(
    `[emotionCycleRealtime] 同花顺 ${thsStocks.length} 只 / 财联社 ${clsStocks.length} 只，涨停 ${stocks.length} 只，耗时 ${elapsed}ms${over}`,
  );

  return snapshot;
};

module.exports = {
  buildTodaySnapshot,
};
