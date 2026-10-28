/**
 * 四维立体（复盘页第二个 Tab）分析服务
 *
 * 1. 读取 src/data/lianbanSnapshot 最近 10 个交易日快照，按题材（概念板块）聚合涨停股；
 * 2. 用「题材涨停股集合 ∩ 东方财富板块成分股集合」把连板题材映射到成交量占比口径的板块
 *    （交集最多的板块即视为该题材对应的板块），并读取该板块近 10 日成交量占比；
 * 3. 结合「涨停家数趋势 + 板块成交量占比趋势」判定主线 / 支线；无主线时全部视为支线并标记快速轮动；
 * 4. 每个题材内按 连板个数 60% + 30 日区间涨幅 40% 计算个股评分，输出龙头 / 龙二~龙五 / 中军；
 * 5. 输出科技情绪指数（现成数据）、大盘情绪温度（快照 sentiment）、板块情绪周期（按规则计算）三条序列。
 */
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getAvailableLianbanDates, getLianbanDayData } = require('./lianban');
const { getAllTechIndexData } = require('./emotion');
const {
  getBlockCategoryRatio,
  CATEGORY_NAMES,
} = require('./板块成交量占比计算/category_amount_money');

const WINDOW_DAYS = 10; // 主窗口：最近 10 个交易日
const GAIN_LOOKBACK_DAYS = 30; // 涨幅统计窗口：最近 30 个交易日
const EMOTION_DAYS = 60; // 科技情绪 / 大盘情绪折线：最近 60 个交易日
const CONSTITUENTS_DIR = path.resolve(__dirname, '../data/东方财富板块成分股汇总');
const KLINE_CACHE_DIR = path.resolve(__dirname, '../data/kline_cache');

// ==================== 工具 ====================

// 板块名归一化：去掉括号后缀（如 化工(分散染料) → 化工）
const boardKeyOf = (board) => String(board || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();

const pureCodeOf = (code) => String(code || '').replace(/^[a-zA-Z]+/, '').trim();

const round = (v, digits = 2) => {
  if (!Number.isFinite(Number(v))) return null;
  const p = Math.pow(10, digits);
  return Math.round(Number(v) * p) / p;
};

const avg = (arr) => {
  const list = (arr || []).filter((v) => Number.isFinite(Number(v)));
  if (!list.length) return null;
  return list.reduce((sum, v) => sum + Number(v), 0) / list.length;
};

const trendPct = (recent, prev) => {
  if (!Number.isFinite(Number(recent)) || !Number.isFinite(Number(prev))) return null;
  if (Number(prev) === 0) return Number(recent) > 0 ? 100 : 0;
  return ((Number(recent) - Number(prev)) / Number(prev)) * 100;
};

// 东方财富板块成分股：分类 -> Set(纯代码)
let constituentsCache = null;
const getConstituents = () => {
  if (constituentsCache) return constituentsCache;
  const map = new Map();
  CATEGORY_NAMES.forEach((name) => {
    const file = path.join(CONSTITUENTS_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return;
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Array.isArray(list)) return;
      map.set(name, new Set(list.map((s) => pureCodeOf(s.code)).filter(Boolean)));
    } catch (e) {
      console.error(`[siweiLiti] 读取成分股失败 ${name}:`, e.message);
    }
  });
  constituentsCache = map;
  return map;
};

// 读取本地日K缓存的收盘价序列（升序），用于补全「起点前收 / 截止价」
const klineCloseCache = new Map();
const getCachedCloses = (marketCode) => {
  const mc = String(marketCode || '').trim();
  if (!mc) return [];
  if (klineCloseCache.has(mc)) return klineCloseCache.get(mc);
  const file = path.join(KLINE_CACHE_DIR, `${mc}.json`);
  let list = [];
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const rows = Array.isArray(data?.kline) ? data.kline : [];
      const map = new Map();
      rows.forEach((item) => {
        const d = Number(item?.trade_date);
        const c = Number(item?.close_px);
        if (Number.isFinite(d) && Number.isFinite(c) && c > 0) map.set(d, c);
      });
      list = Array.from(map.entries())
        .map(([d, c]) => ({ d, c }))
        .sort((a, b) => a.d - b.d);
    } catch (e) {
      list = [];
    }
  }
  klineCloseCache.set(mc, list);
  return list;
};

const getLatestCachedClose = (marketCode) => {
  const list = getCachedCloses(marketCode);
  return list.length ? list[list.length - 1] : null;
};

// 指定日期之前（不含）的最近一个有收盘价的交易日
const getCachedCloseBefore = (marketCode, ymd) => {
  const target = Number(ymd);
  if (!Number.isFinite(target)) return null;
  const list = getCachedCloses(marketCode);
  let found = null;
  list.forEach((row) => {
    if (row.d < target) found = row;
  });
  return found;
};

// 板块情绪周期规则：返回 { phase, reason }
const calcPhase = ({ count, prevCount, ratio, prevRatio, isFirst }) => {
  const ratioText = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}%` : '--');
  const countText = `${prevCount ?? '--'}→${count}`;
  const dropPct = Number.isFinite(Number(prevCount)) && Number(prevCount) > 0
    ? ((Number(prevCount) - count) / Number(prevCount)) * 100
    : null;
  const ratioUp = Number.isFinite(Number(ratio)) && Number.isFinite(Number(prevRatio))
    ? Number(ratio) > Number(prevRatio)
    : null;
  const countUp = Number.isFinite(Number(prevCount)) ? count > Number(prevCount) : true;
  const countDown = Number.isFinite(Number(prevCount)) ? count < Number(prevCount) : false;

  if (count <= 5) {
    return { phase: '退潮期', reason: `涨停 ${count} 家（≤5），${prevCount != null ? `较前一日 ${countText}` : '情绪冰点'}` };
  }
  if (isFirst || !Number.isFinite(Number(prevCount))) {
    return { phase: ratioUp === false ? '一致期' : '高潮期', reason: `窗口首日，涨停 ${count} 家，占比 ${ratioText(ratio)}` };
  }
  if (countUp) {
    if (ratioUp === null) {
      return { phase: '高潮期', reason: `涨停 ${countText}（增加），无对应板块占比数据` };
    }
    return ratioUp
      ? { phase: '高潮期', reason: `涨停 ${countText}（增加），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（提升）` }
      : { phase: '一致期', reason: `涨停 ${countText}（增加），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（降低）` };
  }
  if (countDown) {
    if (ratioUp) {
      // 按用户口径：减少 ≥30% 且占比提升仍记为高潮期；30% 以内且占比提升为分歧期
      return Number(dropPct) >= 30
        ? { phase: '高潮期', reason: `涨停 ${countText}（-${Number(dropPct).toFixed(1)}%，≥30%），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（提升）` }
        : { phase: '分歧期', reason: `涨停 ${countText}（-${Number(dropPct).toFixed(1)}%），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（提升）` };
    }
    return { phase: '弱势震荡', reason: `涨停 ${countText}（减少），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（降低）` };
  }
  // 家数持平
  return ratioUp
    ? { phase: '分歧期', reason: `涨停 ${countText}（持平），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（提升）` }
    : { phase: '弱势震荡', reason: `涨停 ${countText}（持平），占比 ${ratioText(prevRatio)}→${ratioText(ratio)}（降低）` };
};

const PHASE_ORDER = { 高潮期: 4, 一致期: 3, 分歧期: 2, 弱势震荡: 1, 退潮期: 0 };

// ==================== 主计算 ====================

let cache = { ts: 0, data: null };
let fetching = null;
const CACHE_TTL = 60 * 1000;

const buildSiweiLiti = () => {
  const todayYmd = dayjs().format('YYYYMMDD');
  const allDates = getAvailableLianbanDates().filter((d) => d <= todayYmd); // 降序
  if (!allDates.length) {
    return {
      windowDates: [],
      latestSnapshotDate: null,
      generatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      marketStatus: { isFastRotation: true, mainLineCount: 0, description: '暂无连板快照数据' },
      techEmotion: [],
      marketTemperature: [],
      themes: [],
      mainLines: [],
      branches: [],
    };
  }

  const windowDates = allDates.slice(0, WINDOW_DAYS).reverse(); // 升序
  const longDates = allDates.slice(0, GAIN_LOOKBACK_DAYS).reverse(); // 升序
  const emotionDates = allDates.slice(0, EMOTION_DAYS).reverse(); // 升序：科技/大盘情绪取最近 60 个交易日
  const latestSnapshotDate = windowDates[windowDates.length - 1];

  // 预先加载快照（避免重复读文件）
  const dayCache = new Map();
  const getDay = (ymd) => {
    if (!dayCache.has(ymd)) dayCache.set(ymd, getLianbanDayData(ymd));
    return dayCache.get(ymd);
  };

  // ---------- 1. 聚合题材（10 日窗口） + 个股长窗口轨迹（30 日） ----------
  const themesMap = new Map();

  windowDates.forEach((ymd) => {
    const day = getDay(ymd);
    if (!day || !Array.isArray(day.themes)) return;
    day.themes.forEach((theme) => {
      const key = boardKeyOf(theme.board) || theme.board;
      if (!key || key === '其他') return;
      let agg = themesMap.get(key);
      if (!agg) {
        agg = {
          key,
          board: theme.board,
          nameCount: {},
          dailyCounts: {},
          stockCodes: new Set(),
        };
        themesMap.set(key, agg);
      }
      agg.nameCount[theme.board] = (agg.nameCount[theme.board] || 0) + 1;
      agg.dailyCounts[ymd] = (agg.dailyCounts[ymd] || 0) + (theme.stocks?.length || 0);
      (theme.stocks || []).forEach((s) => {
        const code = pureCodeOf(s.code);
        if (code) agg.stockCodes.add(code);
      });
    });
  });

  // 个股在 30 日窗口内的涨停轨迹：{ ymd, price, prevClose, lianbanCount, lianbanText, name, marketCode, fmv }
  const stockTrail = new Map();
  longDates.forEach((ymd) => {
    const day = getDay(ymd);
    if (!day || !Array.isArray(day.themes)) return;
    day.themes.forEach((theme) => {
      (theme.stocks || []).forEach((s) => {
        const code = pureCodeOf(s.code);
        if (!code) return;
        const rec = {
          ymd,
          price: Number(s.quote?.price),
          prevClose: Number(s.quote?.prevClose),
          lianbanCount: Number(s.lianbanCount) || 1,
          lianbanText: s.lianbanText || '',
          name: s.name || code,
          marketCode: s.marketCode || '',
          fmv: Number(s.quote?.floatMarketValueYi),
        };
        if (!stockTrail.has(code)) stockTrail.set(code, []);
        stockTrail.get(code).push(rec);
      });
    });
  });

  // ---------- 2. 板块成交量占比 ----------
  let categoryRatio = {};
  try {
    categoryRatio = getBlockCategoryRatio(windowDates[0], windowDates[windowDates.length - 1]) || {};
  } catch (e) {
    console.error('[siweiLiti] 获取板块成交量占比失败:', e.message);
  }
  const ratioMap = new Map(); // category -> Map(date -> ratio)
  Object.entries(categoryRatio).forEach(([name, rows]) => {
    if (!Array.isArray(rows) || name.includes('_blocks')) return;
    const m = new Map();
    rows.forEach((r) => {
      if (r && r.date) m.set(String(r.date), Number(r.ratio));
    });
    ratioMap.set(name, m);
  });

  // ---------- 3. 题材 -> 板块映射（集合交集最大） ----------
  const constituents = getConstituents();
  const mappingCache = new Map();
  const mapThemeToCategory = (codes) => {
    let best = null;
    constituents.forEach((set, name) => {
      if (!set || set.size === 0) return;
      let inter = 0;
      codes.forEach((c) => { if (set.has(c)) inter += 1; });
      if (inter <= 0) return;
      const ratio = inter / Math.max(1, codes.size);
      // 置信度过滤：交集过少或覆盖率过低不视为对应板块，避免宽泛题材误映射
      if (inter < 2 || ratio < 0.35) return;
      if (
        !best
        || inter > best.intersection
        || (inter === best.intersection && ratio > best.ratio)
      ) {
        best = { category: name, intersection: inter, ratio };
      }
    });
    return best;
  };

  // ---------- 4. 科技情绪 & 大盘温度 ----------
  let techRows = [];
  try { techRows = getAllTechIndexData() || []; } catch (e) { techRows = []; }
  const techMap = new Map();
  techRows.forEach((r) => {
    if (r && r.date != null) techMap.set(String(r.date), Number(r.changeSumResult));
  });

  const techEmotion = emotionDates.map((d) => ({
    date: d,
    value: Number.isFinite(techMap.get(d)) ? techMap.get(d) : null,
  }));

  const marketTemperature = emotionDates.map((d) => {
    const day = getDay(d);
    return {
      date: d,
      value: day?.sentiment?.temperature ?? null,
      phase: day?.sentiment?.phase || null,
      limitUp: day?.summary?.totalCount ?? null,
    };
  });

  // ---------- 5. 逐题材计算 ----------
  const themes = [];

  themesMap.forEach((agg) => {
    // 展示名取出现次数最多的题材名
    let board = agg.board;
    let maxNameCount = -1;
    Object.entries(agg.nameCount).forEach(([name, cnt]) => {
      if (cnt > maxNameCount) { board = name; maxNameCount = cnt; }
    });

    const dailyCounts = windowDates.map((d) => agg.dailyCounts[d] || 0);
    const latestCount = dailyCounts[dailyCounts.length - 1] || 0;
    const totalCount = dailyCounts.reduce((a, b) => a + b, 0);
    if (totalCount <= 0) return;

    // 板块映射
    let mapping = mappingCache.get(agg.key);
    if (mapping === undefined) {
      mapping = mapThemeToCategory(agg.stockCodes);
      mappingCache.set(agg.key, mapping);
    }
    const category = mapping?.category || null;
    const categoryRatios = category ? ratioMap.get(category) : null;
    const ratioSeries = windowDates.map((d) => {
      const v = categoryRatios?.get(d);
      if (v === null || v === undefined || v === '') return null;
      return Number.isFinite(Number(v)) ? Number(v) : null;
    });

    // 趋势：近 3 日 vs 前 3 日
    const countTrend = trendPct(avg(dailyCounts.slice(-3)), avg(dailyCounts.slice(-6, -3)));
    const ratioTrend = trendPct(avg(ratioSeries.slice(-3)), avg(ratioSeries.slice(-6, -3)));

    // 权重得分：10 日涨停家数衰减加权 + 连板高度 + 趋势
    let weightedCount = 0;
    dailyCounts.forEach((cnt, idx) => {
      weightedCount += cnt * Math.pow(0.85, dailyCounts.length - 1 - idx);
    });

    // 个股评分
    const stockList = Array.from(agg.stockCodes).map((code) => {
      const trail = stockTrail.get(code) || [];
      if (!trail.length) return null;
      const windowTrail = trail.filter((t) => t.ymd >= windowDates[0]);
      const lbTrail = windowTrail.length ? windowTrail : trail;
      const last = trail[trail.length - 1];
      const maxLianban = lbTrail.reduce((mx, t) => Math.max(mx, t.lianbanCount || 1), 1);
      const latestText = lbTrail[lbTrail.length - 1]?.lianbanText
        || (maxLianban > 1 ? `${maxLianban}连板` : '首板');
      const fmv = last.fmv && Number.isFinite(last.fmv) ? last.fmv : (trail[0].fmv || null);

      // 起始价：30 日窗口内「第一次涨停日」的前收盘（优先用本地日K缓存前一交易日收盘）
      const firstLimit = trail[0];
      const marketCode = last.marketCode || trail[0].marketCode || code;
      const cachedPrev = getCachedCloseBefore(marketCode, firstLimit.ymd);
      const firstPriced = trail.find((t) => t.prevClose > 0 || t.price > 0);
      const prevClose = cachedPrev?.c
        || (firstPriced ? (firstPriced.prevClose > 0 ? firstPriced.prevClose : firstPriced.price) : null);
      // 截止价：优先取本地日K缓存的最新收盘（更接近截止日）；否则取最后一次涨停日收盘
      let endPrice = last.price > 0 ? last.price : null;
      const cached = getLatestCachedClose(marketCode);
      if (cached && cached.d >= Number(last.ymd) && cached.c > 0) endPrice = cached.c;
      const gainPct = prevClose > 0 && endPrice > 0 ? ((endPrice / prevClose) - 1) * 100 : 0;

      return {
        code,
        marketCode,
        name: last.name || trail[0].name || code,
        maxLianban,
        latestLianbanText: latestText,
        firstLimitUpDate: firstLimit.ymd,
        lastLimitUpDate: last.ymd,
        gainPct: round(gainPct, 2),
        price: round(endPrice, 2),
        floatMarketValueYi: fmv != null ? round(fmv, 2) : null,
        tags: [],
      };
    }).filter(Boolean);

    const maxLb = Math.max(1, ...stockList.map((s) => s.maxLianban || 1));
    const maxGain = Math.max(1, ...stockList.map((s) => Math.max(0, Number(s.gainPct) || 0)));
    stockList.forEach((s) => {
      const lbPart = (s.maxLianban || 1) / maxLb;
      const gainPart = Math.max(0, Number(s.gainPct) || 0) / maxGain;
      s.score = round((lbPart * 0.6 + gainPart * 0.4) * 100, 1);
    });

    const sorted = [...stockList].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.maxLianban !== a.maxLianban) return b.maxLianban - a.maxLianban;
      return (Number(b.gainPct) || 0) - (Number(a.gainPct) || 0);
    });

    // 龙头 / 龙二~龙五 标签
    const rankTags = ['龙头', '龙二', '龙三', '龙四', '龙五'];
    sorted.forEach((s, idx) => {
      if (idx < rankTags.length) s.tags.push(rankTags[idx]);
      if (Number(s.floatMarketValueYi) > 100) s.tags.push('中军');
    });

    // 每个板块 3~10 只：优先前 7 + 中军（最多 3 只），不足 3 只时全部返回
    const picks = new Map();
    sorted.slice(0, 7).forEach((s) => picks.set(s.code, s));
    sorted.filter((s) => Number(s.floatMarketValueYi) > 100).slice(0, 3).forEach((s) => picks.set(s.code, s));
    let picked = Array.from(picks.values()).sort((a, b) => b.score - a.score).slice(0, 10);
    if (picked.length < 3) picked = sorted.slice(0, 10);

    const maxLianban = sorted.length ? sorted[0].maxLianban : 0;
    const score = weightedCount + maxLianban * 1.5 + Math.max(0, ratioTrend || 0) / 10 + Math.max(0, countTrend || 0) / 20;

    // 板块情绪周期
    const emotionCycle = windowDates.map((d, idx) => {
      const count = dailyCounts[idx];
      const prevCount = idx > 0 ? dailyCounts[idx - 1] : null;
      const ratio = ratioSeries[idx];
      const prevRatio = idx > 0 ? ratioSeries[idx - 1] : null;
      const { phase, reason } = calcPhase({ count, prevCount, ratio, prevRatio, isFirst: idx === 0 });
      return { date: d, count, ratio: round(ratio, 2), prevRatio: round(prevRatio, 2), phase, reason };
    });

    themes.push({
      key: agg.key,
      board,
      type: '支线',
      category,
      categoryIntersection: mapping?.intersection || 0,
      categoryRatio: mapping ? round(mapping.ratio * 100, 1) : null,
      dailyCounts,
      latestCount,
      totalCount,
      maxLianban,
      countTrend: round(countTrend, 1),
      ratioTrend: round(ratioTrend, 1),
      ratioSeries: ratioSeries.map((v) => round(v, 2)),
      score: round(score, 1),
      emotionCycle,
      currentPhase: emotionCycle[emotionCycle.length - 1]?.phase || null,
      stocks: picked,
      stockPoolCount: sorted.length,
      _mainCond: {
        latestCount,
        countTrend,
        ratioTrend,
        hasRatio: ratioSeries.some((v) => Number.isFinite(v)),
        score,
      },
    });
  });

  // ---------- 6. 主线 / 支线判定 ----------
  const candidates = themes.filter((t) => {
    const c = t._mainCond;
    if (c.latestCount < 3) return false;
    if (c.countTrend == null || c.countTrend <= 0) return false;
    // 主线必须同时满足：涨停家数增加 + 对应板块成交量占比提升（无占比数据视为无法确认，归为支线）
    return c.hasRatio && c.ratioTrend != null && c.ratioTrend > 0;
  }).sort((a, b) => b.score - a.score);

  const mainKeys = new Set(candidates.slice(0, 2).map((t) => t.key));
  themes.forEach((t) => {
    delete t._mainCond;
    t.type = mainKeys.has(t.key) ? '主线' : '支线';
  });
  themes.sort((a, b) => {
    if (a.type !== b.type) return a.type === '主线' ? -1 : 1;
    return b.score - a.score;
  });
  themes.forEach((t, idx) => { t.rank = idx + 1; });

  const mainLines = themes.filter((t) => t.type === '主线').map((t) => ({
    board: t.board,
    category: t.category,
    latestCount: t.latestCount,
    score: t.score,
    currentPhase: t.currentPhase,
  }));
  const branches = themes.filter((t) => t.type === '支线').map((t) => ({
    board: t.board,
    category: t.category,
    latestCount: t.latestCount,
    score: t.score,
    currentPhase: t.currentPhase,
  }));

  const isFastRotation = mainLines.length === 0;

  return {
    windowDates,
    latestSnapshotDate,
    generatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    marketStatus: {
      isFastRotation,
      mainLineCount: mainLines.length,
      description: isFastRotation
        ? '当前无同时满足「涨停家数增加 + 板块成交量占比提升」的主线题材，市场处于快速轮动状态'
        : `主线 ${mainLines.map((m) => m.board).join('、')}，其余题材为支线`,
    },
    techEmotion,
    marketTemperature,
    themes,
    mainLines,
    branches,
  };
};

const getSiweiLitiAnalysis = async () => {
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) return cache.data;
  if (fetching) return fetching;
  fetching = (async () => {
    const data = buildSiweiLiti();
    cache = { ts: Date.now(), data };
    return data;
  })();
  try {
    return await fetching;
  } finally {
    fetching = null;
  }
};

exports.getSiweiLitiAnalysis = getSiweiLitiAnalysis;
exports.PHASE_ORDER = PHASE_ORDER;
