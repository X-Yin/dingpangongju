// 板块成交量占比（实时）
// - 主路径 computeFromSpot：一次获取全部 A 股实时行情（东财，含每只股票当日成交额），
//   按成分股 code 匹配成交额后分别汇总各分类 + 科技板块，除以全 A 股成交额合计得到占比
// - 兜底路径 computeByPolling：东财、新浪的全量行情接口都不可用时，按平台配额逐只请求日K
//   （同花顺 20 / 财联社 10 / 新浪 10 / 东财 15 / 腾讯 5，每秒 60 只），
//   某只股票主平台失败时按 同花顺 → 财联社 兜底；请求结果写入临时缓存目录，结束后删除
// - 结果按 10 分钟粒度追加写入 src/data/block_volume_ratio_intraday.json，供前端分时图使用
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { CATEGORY_NAMES, getBlockCategoryRatio } = require('./板块成交量占比计算/category_amount_money');
const { getTechVolumeRatio } = require('./techCrowd');
const { fetchMarketTotalAmountYi } = require('./amount');
const { getASpot } = require('./akData');
const { StockKlineTempCache } = require('./stockKlineCache');
const {
    fetchKlineBatch,
    fetchSingleKline,
    closeKlineWorkers,
    PLATFORM_NAMES,
} = require('./stockKlinePlatforms');
const { isTradingDay } = require('../utils');

const INTRADAY_FILE = path.resolve(__dirname, '../data/block_volume_ratio_intraday.json');
const CONSTITUENTS_DIR = path.resolve(__dirname, '../data/东方财富板块成分股汇总');
const TECH_STOCK_FILE = path.resolve(__dirname, './科技板块拥挤度计算/all_tech_stock_code.json');
const AMOUNT_DAY_HISTORY_FILE = path.resolve(__dirname, '../data/amount_day_history.json');

const TECH_GROUP_NAME = '科技';

// 兜底轮询：每秒 60 只，按平台配额分配
const ROUND_SIZE = 60;
const ROUND_INTERVAL = 1000;
const PLATFORM_QUOTAS = [
    ['ths', 20],   // 同花顺
    ['cls', 10],   // 财联社
    ['sina', 10],  // 新浪
    ['em', 15],    // 东财
    ['tx', 5],     // 腾讯
];
// 平台连续失败达到该轮数后，本次轮询不再尝试（其股票直接走兜底链）
const PLATFORM_DOWN_THRESHOLD = 3;

const readJsonSafe = (file, fallback) => {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        return fallback;
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 并发执行（固定并发数，单个任务自行处理异常）
const runWithConcurrency = async (items, concurrency, fn) => {
    let cursor = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            await fn(items[index], index);
        }
    });
    await Promise.all(workers);
};

// 构建一轮 60 个平台槽位：按配额均匀穿插，避免同一平台连续扎堆
const buildRoundPattern = () => {
    const buckets = PLATFORM_QUOTAS.map(([name, quota]) => ({ name, quota, used: 0 }));
    const pattern = [];

    for (let i = 0; i < ROUND_SIZE; i++) {
        let picked = null;
        let pickedRatio = Infinity;
        for (const bucket of buckets) {
            if (bucket.used >= bucket.quota) continue;
            const ratio = (bucket.used + 1) / bucket.quota;
            if (ratio < pickedRatio) {
                pickedRatio = ratio;
                picked = bucket;
            }
        }
        if (!picked) break;
        pattern.push(picked.name);
        picked.used += 1;
    }

    return pattern;
};

// 构建「板块 → 成分股」分组（分类 + 科技汇总）
const buildGroups = () => {
    const groups = [];

    for (const name of CATEGORY_NAMES) {
        const file = path.join(CONSTITUENTS_DIR, `${name}.json`);
        const stocks = readJsonSafe(file, null);
        if (Array.isArray(stocks) && stocks.length > 0) {
            groups.push({ name, stocks });
        }
    }

    const techData = readJsonSafe(TECH_STOCK_FILE, null);
    if (techData && Array.isArray(techData.stocks) && techData.stocks.length > 0) {
        groups.push({ name: TECH_GROUP_NAME, stocks: techData.stocks });
    }

    return groups;
};

// 主路径：用全 A 股实时行情（每只股票当日成交额）按成分股 code 汇总
// onProgress: ({ done, total, matched, hitRate, current, label }) => void
const computeFromSpot = (groups, spot, onProgress) => {
    // 代码 → 当日成交额（元）；同时累加得到全市场成交额作为分母
    const amountByCode = new Map();
    let marketTotalAmount = 0;
    for (const item of spot) {
        const code = String(item['代码'] || '').trim();
        const amount = Number(item['成交额']);
        if (!code || !isFinite(amount) || amount <= 0) continue;
        amountByCode.set(code, amount);
        marketTotalAmount += amount;
    }

    if (marketTotalAmount <= 0) {
        throw new Error('全 A 股成交额合计为 0，无法计算成交量占比');
    }

    const totalTasks = groups.reduce((sum, group) => sum + group.stocks.length, 0);
    let done = 0;
    let matched = 0;
    const amounts = {};

    for (const group of groups) {
        let amountSum = 0;

        for (const stock of group.stocks) {
            const amount = amountByCode.get(String(stock.code || '').trim());
            if (amount !== undefined) {
                amountSum += amount;
                matched++;
            }
        }

        done += group.stocks.length;
        amounts[group.name] = amountSum;

        if (onProgress) {
            onProgress({
                done,
                total: totalTasks,
                matched,
                hitRate: totalTasks > 0 ? matched / totalTasks : 0,
                label: '成分股匹配率',
                current: group.name,
            });
        }
    }

    const ratios = {};
    for (const [name, amount] of Object.entries(amounts)) {
        ratios[name] = Number((amount / marketTotalAmount * 100).toFixed(4));
    }

    return {
        time: dayjs().format('HHmmss'),
        marketTotalAmount: Number((marketTotalAmount / 1e8).toFixed(2)),
        amounts,
        ratios,
        stats: {
            mode: 'spot',
            matched,
            total: totalTasks,
            hitRate: totalTasks > 0 ? matched / totalTasks : 0,
        },
    };
};

// 兜底路径：按平台配额逐只请求日K，取目标交易日的成交额汇总
const computeByPolling = async (groups, { onProgress } = {}) => {
    // 去重后的股票代码 + 每个代码在全部板块中出现的次数（重复出现后续请求命中临时缓存）
    const usage = new Map();
    let totalEntries = 0;

    for (const group of groups) {
        for (const stock of group.stocks) {
            const code = String(stock.code || '').trim();
            if (!code) continue;
            usage.set(code, (usage.get(code) || 0) + 1);
            totalEntries += 1;
        }
    }

    const codes = Array.from(usage.keys());
    if (codes.length === 0) {
        throw new Error('成分股代码为空，无法轮询计算成交量占比');
    }

    const startDate = dayjs().subtract(10, 'day').format('YYYY-MM-DD');
    const endDate = dayjs().format('YYYY-MM-DD');
    const pattern = buildRoundPattern();

    // 平台连续失败计数（达到阈值后本轮询不再使用该平台）
    const health = { ths: 0, cls: 0, sina: 0, em: 0, tx: 0 };
    // 代码 → 最新日K日期（用于确定目标交易日）
    const dateCounter = new Map();

    const stockCache = new StockKlineTempCache('block_amount_poll');

    let done = 0;
    let fetched = 0;

    const report = () => {
        if (!onProgress) return;
        onProgress({
            done,
            total: totalEntries,
            // 去重后实际请求数 / 已覆盖条目数：重复成分股走临时缓存即命中
            hitRate: done > 0 ? (done - fetched) / done : 0,
            label: '缓存命中率',
            current: '多平台兜底轮询',
        });
    };

    try {
        for (let i = 0; i < codes.length; i += ROUND_SIZE) {
            const roundStart = Date.now();
            const roundCodes = codes.slice(i, i + ROUND_SIZE);

            const primaryOf = new Map();
            const byPlatform = new Map();
            roundCodes.forEach((code, index) => {
                const platform = pattern[index % pattern.length];
                primaryOf.set(code, platform);
                if (!byPlatform.has(platform)) byPlatform.set(platform, []);
                byPlatform.get(platform).push(code);
            });

            const got = new Map();

            // 各平台按本轮配额并发拉取
            await Promise.all(Array.from(byPlatform.entries()).map(async ([platform, list]) => {
                if (health[platform] >= PLATFORM_DOWN_THRESHOLD) return;

                try {
                    const batch = await fetchKlineBatch(platform, list, startDate, endDate);
                    let okCount = 0;

                    for (const [code, rows] of batch.entries()) {
                        if (rows.length > 0) {
                            got.set(code, rows);
                            okCount += 1;
                        }
                    }

                    health[platform] = okCount > 0 ? 0 : health[platform] + 1;
                } catch (error) {
                    health[platform] += 1;
                    console.warn(`[${PLATFORM_NAMES[platform] || platform}] 批量获取日K失败: ${error.message}`);
                }
            }));

            const tryFetch = async (platform, list) => {
                const failed = [];
                await runWithConcurrency(list, 10, async (code) => {
                    try {
                        const rows = await fetchSingleKline(platform, code, startDate, endDate);
                        if (rows.length > 0) got.set(code, rows);
                        else failed.push(code);
                    } catch (error) {
                        failed.push(code);
                    }
                });

                if (list.length > 0) {
                    if (failed.length === list.length) health[platform] += 1;
                    else if (failed.length < list.length) health[platform] = 0;
                }

                return failed;
            };

            // 兜底：主平台失败的股票先走同花顺，再走财联社
            const missing = roundCodes.filter((code) => !got.has(code));
            if (missing.length > 0) {
                let needCls = missing;

                if (health.ths < PLATFORM_DOWN_THRESHOLD) {
                    // 主平台已经是同花顺的股票本轮已失败过，不再重复请求
                    const thsCandidates = missing.filter((code) => primaryOf.get(code) !== 'ths');
                    const thsFailed = thsCandidates.length > 0 ? await tryFetch('ths', thsCandidates) : [];
                    needCls = [...thsFailed, ...missing.filter((code) => primaryOf.get(code) === 'ths')];
                }

                if (needCls.length > 0) await tryFetch('cls', needCls);
            }

            // 写入临时缓存 + 统计目标交易日
            for (const [code, rows] of got.entries()) {
                stockCache.set(code, startDate, rows);
                const last = rows[rows.length - 1];
                if (last) dateCounter.set(last.date, (dateCounter.get(last.date) || 0) + 1);
            }

            // 无论成功与否，本轮股票都已处理（失败股票计为无数据）
            for (const code of roundCodes) {
                done += usage.get(code) || 0;
                fetched += 1;
            }

            report();

            const elapsed = Date.now() - roundStart;
            if (elapsed < ROUND_INTERVAL && i + ROUND_SIZE < codes.length) {
                await sleep(ROUND_INTERVAL - elapsed);
            }
        }

        // 目标交易日：出现次数最多的最新日期（周末/节假日为最近交易日）
        let targetDate = null;
        let targetCount = 0;
        for (const [date, count] of dateCounter.entries()) {
            if (count > targetCount) {
                targetDate = date;
                targetCount = count;
            }
        }
        if (!targetDate) {
            throw new Error('兜底轮询未获取到任何日K数据，无法计算成交量占比');
        }

        // 按板块汇总目标交易日成交额（停牌股没有当日数据，不计入）
        const amounts = {};
        let matched = 0;
        for (const group of groups) {
            let amountSum = 0;

            for (const stock of group.stocks) {
                const code = String(stock.code || '').trim();
                const rows = stockCache.get(code, startDate);
                if (!Array.isArray(rows) || rows.length === 0) continue;

                const row = rows.find((item) => item.date === targetDate);
                if (!row) continue;

                const amount = Number(row.amount);
                if (isFinite(amount) && amount > 0) {
                    amountSum += amount;
                    matched += 1;
                }
            }

            amounts[group.name] = amountSum;
        }

        if (matched === 0) {
            throw new Error(`兜底轮询未获取到 ${targetDate} 的成交额数据`);
        }

        // 分母：优先接口实时获取的全市场成交额，失败时回退当日历史记录
        let marketTotalAmount = null;
        try {
            const totalYi = Number(await fetchMarketTotalAmountYi());
            if (isFinite(totalYi) && totalYi > 0) {
                marketTotalAmount = totalYi * 1e8;
            }
        } catch (error) {
            console.warn('获取全市场成交额失败，尝试读取历史记录:', error.message);
        }
        if (!marketTotalAmount) {
            const history = readJsonSafe(AMOUNT_DAY_HISTORY_FILE, []);
            const record = Array.isArray(history)
                ? history.find((item) => String(item.date) === targetDate)
                : null;
            if (record && Number(record.totalAmount) > 0) {
                marketTotalAmount = Number(record.totalAmount) * 1e8;
            }
        }
        if (!marketTotalAmount) {
            throw new Error('全市场成交额获取失败，无法计算成交量占比');
        }

        const ratios = {};
        for (const [name, amount] of Object.entries(amounts)) {
            ratios[name] = Number((amount / marketTotalAmount * 100).toFixed(4));
        }

        const stats = {
            mode: 'poll',
            targetDate,
            cacheHits: Math.max(done - fetched, 0),
            cacheMisses: fetched,
            hitRate: done > 0 ? Math.max(done - fetched, 0) / done : 0,
            matched,
            total: totalEntries,
        };

        console.log(`\n[兜底轮询] 目标交易日 ${targetDate}，去重股票 ${codes.length} 只 / 成分股条目 ${totalEntries} 条，缓存命中率 ${(stats.hitRate * 100).toFixed(1)}%`);

        return {
            time: dayjs().format('HHmmss'),
            marketTotalAmount: Number((marketTotalAmount / 1e8).toFixed(2)),
            amounts,
            ratios,
            stats,
        };
    } finally {
        stockCache.cleanup();
        closeKlineWorkers();
    }
};

// 计算当日各板块成交量占比（单位：%）
// 优先一次性拉取全 A 股实时行情；东财、新浪两个全量接口都失败时回退多平台轮询
// onProgress: ({ done, total, hitRate, label, current }) => void
// forcePolling: true 时跳过全 A 股行情，强制走多平台轮询兜底（--all）
const computeTodayRatios = async ({ onProgress, forcePolling = false } = {}) => {
    const groups = buildGroups();

    if (groups.length === 0) {
        throw new Error('未找到任何板块成分股文件，无法计算成交量占比');
    }

    if (!forcePolling) {
        try {
            const spot = await getASpot();
            if (!Array.isArray(spot) || spot.length === 0) {
                throw new Error('全 A 股实时行情数据为空');
            }
            return computeFromSpot(groups, spot, onProgress);
        } catch (error) {
            console.warn(`获取全 A 股实时行情失败，回退多平台轮询兜底: ${error.message}`);
        }
    } else {
        console.log('已指定 --all，跳过全 A 股实时行情，直接走多平台轮询兜底');
    }

    return computeByPolling(groups, { onProgress });
};

// 读取分时缓存文件
const getIntradayData = () => {
    const data = readJsonSafe(INTRADAY_FILE, null);
    if (!data || !Array.isArray(data.points)) {
        return { date: '', updatedAt: '', points: [] };
    }
    return data;
};

// 写入一个分时点（同一天内按时间排序，同一时间点覆盖）
const saveIntradayPoint = (point) => {
    const today = dayjs().format('YYYYMMDD');
    const existing = getIntradayData();
    const points = existing.date === today && Array.isArray(existing.points) ? existing.points : [];

    const next = points.filter((item) => item.time !== point.time);
    next.push(point);
    next.sort((a, b) => String(a.time).localeCompare(String(b.time)));

    const payload = {
        date: today,
        updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        points: next,
    };
    fs.writeFileSync(INTRADAY_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    return payload;
};

// 计算并写入当前时点的分时数据
const runAndSaveIntradayPoint = async ({ onProgress, forcePolling = false } = {}) => {
    const { stats, ...point } = await computeTodayRatios({ onProgress, forcePolling });
    const payload = saveIntradayPoint(point);
    return { point, payload, stats };
};

// 各板块成交量占比历史日线（按日期升序），并把当日分时缓存中的最新占比作为实时点补上
// 返回：{ blocks: [{ name, points: [{ date, ratio, money, totalAmount, live? }] }], live: { date, time, marketTotalAmount } | null }
const getBlockVolumeRatioHistory = async () => {
    const todayTotalAmountYi = await fetchMarketTotalAmountYi().catch((e) => {
        console.error('获取全市场成交额失败，回退本地缓存:', e.message);
        return null;
    });

    const series = {};

    const categoryRatio = getBlockCategoryRatio(null, null, todayTotalAmountYi);
    for (const name of CATEGORY_NAMES) {
        const rows = Array.isArray(categoryRatio[name]) ? categoryRatio[name] : [];
        series[name] = rows.map((row) => ({
            date: String(row.date),
            ratio: Number(row.ratio),
            money: Number(row.money),
            totalAmount: Number(row.totalAmount),
        }));
    }

    const techRows = getTechVolumeRatio(null, null, todayTotalAmountYi);
    series[TECH_GROUP_NAME] = (Array.isArray(techRows) ? techRows : []).map((row) => ({
        date: String(row.date),
        ratio: Number(row.ratio),
        money: Number(row.techTotalMoney),
        totalAmount: Number(row.totalAmount),
    }));

    // 当日实时占比：取分时缓存当天最新时点，替换当日的历史点（历史点可能是盘中未更新的数据）
    // 非交易日（如周末补跑产生的全 0 时点）不接入实时点，避免污染当日数据
    const intraday = getIntradayData();
    const lastPoint = intraday.points[intraday.points.length - 1] || null;
    const isLiveToday = intraday.date === dayjs().format('YYYYMMDD') && isTradingDay(new Date());
    const live = lastPoint && isLiveToday
        ? {
            date: intraday.date,
            time: lastPoint.time,
            marketTotalAmount: lastPoint.marketTotalAmount,
            ratios: lastPoint.ratios || {},
            amounts: lastPoint.amounts || {},
        }
        : null;

    const blocks = Object.entries(series).map(([name, points]) => {
        const list = live ? points.filter((item) => item.date !== live.date) : [...points];
        const liveRatio = live ? live.ratios[name] : null;
        if (live && liveRatio !== null && liveRatio !== undefined && isFinite(Number(liveRatio))) {
            list.push({
                date: live.date,
                ratio: Number(liveRatio),
                money: live.amounts[name] !== undefined ? Number(live.amounts[name]) : null,
                totalAmount: live.marketTotalAmount,
                live: true,
            });
        }
        list.sort((a, b) => a.date.localeCompare(b.date));
        return { name, points: list };
    });

    return {
        blocks,
        live: live ? { date: live.date, time: live.time, marketTotalAmount: live.marketTotalAmount } : null,
    };
};

exports.TECH_GROUP_NAME = TECH_GROUP_NAME;
exports.computeTodayRatios = computeTodayRatios;
exports.runAndSaveIntradayPoint = runAndSaveIntradayPoint;
exports.getIntradayData = getIntradayData;
exports.getBlockVolumeRatioHistory = getBlockVolumeRatioHistory;
exports.INTRADAY_FILE = INTRADAY_FILE;
