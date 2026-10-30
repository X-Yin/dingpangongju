// 板块成交量占比（实时）
// - 主路径 computeFromSpot：一次获取全部 A 股实时行情（东财，含每只股票当日成交额），
//   按成分股 code 匹配成交额后分别汇总各分类 + 科技板块；
//   分母优先取 amount.json 里的全市场成交额（不被残缺快照带偏，避免向上突刺），
//   缺失时退回新浪接口、最后才用快照合计。
// - 快照完整性校验：有效股票数、成分股匹配率过低时判定为上游返回了不完整快照，
//   直接回退同花顺 + 财联社多平台轮询兜底，避免写进向下的突刺
// - 兜底路径 computeByPolling：全量行情接口不可用或不完整时，按平台配额逐只请求日K
//   （同花顺 45 / 财联社 45，每秒 90 只），
//   某只股票主平台失败时按 同花顺 → 财联社 兜底；请求结果写入临时缓存目录，结束后删除
// - 结果按 10 分钟粒度追加写入 src/data/block_volume_ratio_intraday.json，供前端分时图使用
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { CATEGORY_NAMES, getBlockCategoryRatio } = require('./板块成交量占比计算/category_amount_money');
const { getTechVolumeRatio } = require('./techCrowd');
const { fetchMarketTotalAmountYi, parseAmountToYi } = require('./amount');
const { getASpot } = require('./akData');
const { StockKlineTempCache } = require('./stockKlineCache');
const {
    fetchKlineBatch,
    fetchSingleKline,
    PLATFORM_NAMES,
} = require('./stockKlinePlatforms');
const { isTradingDay } = require('../utils');

const INTRADAY_FILE = path.resolve(__dirname, '../data/block_volume_ratio_intraday.json');
// 全市场成交额的分母数据源：amount.json（每 10s 由新浪接口写入，含 totalAmount）
const AMOUNT_FILE = path.resolve(__dirname, '../data/amount.json');
const CONSTITUENTS_DIR = path.resolve(__dirname, '../data/东方财富板块成分股汇总');
const TECH_STOCK_FILE = path.resolve(__dirname, './科技板块拥挤度计算/all_tech_stock_code.json');
const AMOUNT_DAY_HISTORY_FILE = path.resolve(__dirname, '../data/amount_day_history.json');
// 按日历史文件（拥挤度 tab 折线图的日线数据源）
const TECH_MONEY_FILE = path.resolve(__dirname, './科技板块拥挤度计算/block_amount_money_result.json');
const CATEGORY_MONEY_FILE = path.resolve(__dirname, './板块成交量占比计算/category_amount_money_result.json');

const TECH_GROUP_NAME = '科技';

// 兜底轮询：每秒 90 只，按平台配额分配
const ROUND_SIZE = 90;
const ROUND_INTERVAL = 1000;
const PLATFORM_QUOTAS = [
    ['ths', 45],   // 同花顺
    ['cls', 45],   // 财联社
];
// 平台连续失败达到该轮数后，本次轮询不再尝试（其股票直接走兜底链）
const PLATFORM_DOWN_THRESHOLD = 3;

// 快照完整性校验：全 A 股实时行情偶发只返回部分股票（或部分股票成交额为空），
// 各板块的分子成交额随之偏小，占比就会画出向下的突刺（如 10:31 军工、14:50 银行）。
// 校验不通过时抛错，由轮询侧等待 10s 后强制重新拉取，而不是把坏点写进分时缓存。
const MIN_SPOT_ROWS = 4800;          // 全 A 股约 5600 只，低于该数量视为不完整快照
const MIN_HIT_RATE = 0.95;           // 成分股匹配率，完整快照实测约 0.998
const MAX_TOTAL_DROP_RATIO = 0.95;   // 同一交易日内成交额是累计值，容忍 5% 抖动
const MIN_BLOCK_AMOUNT_RATIO = 0.98; // 单板块累计成交额只增不减，容忍 2% 抖动
// amount.json 记录超过该时长未更新则视为过期，改用新浪接口实时获取分母
const AMOUNT_FILE_MAX_AGE_SEC = 5 * 60;

const readJsonSafe = (file, fallback) => {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        return fallback;
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 快照不完整错误：与网络失败区分开，避免因为一次残缺快照就触发耗时的多平台轮询兜底
const createIncompleteError = (message) => {
    const error = new Error(message);
    error.incompleteSnapshot = true;
    return error;
};

// 从 amount.json 读取今日最新一条全市场成交额（单位：亿）
// 该文件由成交量轮询每 10s 写入，与前端「成交量」图同一口径；记录日期不符或过期时返回 null
const getAmountFileTotalYi = () => {
    const list = readJsonSafe(AMOUNT_FILE, []);
    if (!Array.isArray(list) || list.length === 0) return null;

    const today = dayjs().format('YYYYMMDD');
    for (let i = list.length - 1; i >= 0; i--) {
        const record = list[i];
        if (!Array.isArray(record)) continue;
        const info = record[1];
        if (!info || String(info.date) !== today) continue;

        const totalYi = parseAmountToYi(info.totalAmount);
        if (!isFinite(totalYi) || totalYi <= 0) continue;

        const time = String(record[0] || '');
        const ts = dayjs(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`);
        const ageSec = ts.isValid() ? Math.abs(dayjs().diff(ts, 'second')) : Infinity;
        if (ageSec > AMOUNT_FILE_MAX_AGE_SEC) {
            console.warn(`amount.json 最新成交额记录已过期（${time}，约 ${ageSec}s 前），改用新浪接口获取分母`);
            return null;
        }
        return totalYi;
    }
    return null;
};

// 分母来源：优先 amount.json（不受全 A 股快照残缺影响，避免向上突刺），
// 过期时改用新浪接口实时获取；两者都不可用时退回快照合计（此时靠完整性校验兜底）
const resolveMarketTotalYi = async () => {
    const fromFile = getAmountFileTotalYi();
    if (fromFile !== null) return { marketTotalYi: fromFile, totalSource: 'amount_file' };

    try {
        const yi = await fetchMarketTotalAmountYi();
        if (isFinite(yi) && yi > 0) return { marketTotalYi: yi, totalSource: 'sina_api' };
    } catch (error) {
        console.warn('获取全市场成交额失败，回退实时行情合计:', error.message);
    }
    return { marketTotalYi: null, totalSource: 'spot' };
};

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

// 构建一轮 90 个平台槽位：按配额均匀穿插，避免同一平台连续扎堆
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
// 分母优先取外部全市场成交额（amount.json / 新浪接口），缺省时退回快照合计
// onProgress: ({ done, total, matched, current, detail }) => void
const computeFromSpot = (groups, spot, onProgress, totalInfo = {}) => {
    const { marketTotalYi = null, totalSource = 'spot' } = totalInfo;

    // 代码 → 当日成交额（元）；快照合计仅在缺少外部分母时兜底使用
    const amountByCode = new Map();
    let spotTotalAmount = 0;
    for (const item of spot) {
        const code = String(item['代码'] || '').trim();
        const amount = Number(item['成交额']);
        if (!code || !isFinite(amount) || amount <= 0) continue;
        amountByCode.set(code, amount);
        spotTotalAmount += amount;
    }

    if (amountByCode.size < MIN_SPOT_ROWS) {
        throw createIncompleteError(`全 A 股实时行情数据不完整（有效 ${amountByCode.size} 只），放弃本次计算`);
    }

    const useExternalTotal = isFinite(Number(marketTotalYi)) && Number(marketTotalYi) > 0;
    const marketTotalAmount = useExternalTotal ? Number(marketTotalYi) * 1e8 : spotTotalAmount;

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
                detail: `成分股匹配 ${matched}/${totalTasks}`,
                current: group.name,
            });
        }
    }

    // 匹配率过低说明快照漏掉了大量成分股：即使分母正确，各板块占比也会偏小（向下突刺）
    const hitRate = totalTasks > 0 ? matched / totalTasks : 0;
    if (hitRate < MIN_HIT_RATE) {
        throw createIncompleteError(`成分股匹配率过低（${(hitRate * 100).toFixed(1)}%），判定为行情快照不完整，放弃本次计算`);
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
            totalSource: useExternalTotal ? totalSource : 'spot',
            spotRows: amountByCode.size,
            matched,
            total: totalTasks,
            hitRate,
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
    const health = { ths: 0, cls: 0 };
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
            // 同一只股票在多个板块重复出现时只请求一次，重复条目数即为免请求数
            detail: `已请求 ${fetched}/${codes.length} 只（重复条目免请求 ${Math.max(done - fetched, 0)} 条）`,
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
            requested: fetched,
            uniqueCodes: codes.length,
            dedupSaved: Math.max(done - fetched, 0),
            dedupRate: done > 0 ? Math.max(done - fetched, 0) / done : 0,
            matched,
            total: totalEntries,
        };

        console.log(`\n[兜底轮询] 目标交易日 ${targetDate}，去重股票 ${codes.length} 只 / 成分股条目 ${totalEntries} 条，实际请求 ${fetched} 只（重复条目免请求 ${stats.dedupSaved} 条）`);

        return {
            time: dayjs().format('HHmmss'),
            marketTotalAmount: Number((marketTotalAmount / 1e8).toFixed(2)),
            amounts,
            ratios,
            stats,
        };
    } finally {
        stockCache.cleanup();
    }
};

// 计算当日各板块成交量占比（单位：%）
// 优先一次性拉取全 A 股实时行情；接口失败或返回股票数量过少（快照不完整）时回退同花顺 + 财联社多平台轮询兜底
// onProgress: ({ done, total, detail, current }) => void
// forcePolling: true 时跳过全 A 股行情，强制走多平台轮询兜底（--all）
// forceRefresh: true 时跳过实时行情缓存重新拉取（校验失败后的重试使用）
const computeTodayRatios = async ({ onProgress, forcePolling = false, forceRefresh = false } = {}) => {
    const groups = buildGroups();

    if (groups.length === 0) {
        throw new Error('未找到任何板块成分股文件，无法计算成交量占比');
    }

    if (!forcePolling) {
        try {
            const spot = await getASpot(forceRefresh);
            if (!Array.isArray(spot) || spot.length === 0) {
                throw new Error('全 A 股实时行情数据为空');
            }
            const totalInfo = await resolveMarketTotalYi();
            return computeFromSpot(groups, spot, onProgress, totalInfo);
        } catch (error) {
            // 全 A 股行情不可用（东财/新浪接口挂掉，或返回股票数量过少、匹配率过低）。
            // 手动刷新时不能直接失败，统一改走同花顺 + 财联社兜底轮询，保证能拿到真实数据
            console.warn(`获取全 A 股实时行情失败，回退多平台轮询兜底: ${error.message}`);
        }
    } else {
        console.log('已指定 --all，跳过全 A 股实时行情，直接走多平台轮询兜底');
    }

    return computeByPolling(groups, { onProgress });
};

// 分时点合理性校验，两层保证：
// 1) 分母：全市场成交额是当日累计值，只增不减；明显低于当日已有时点说明外部分母异常
// 2) 分子：各板块累计成交额同样只增不减；某板块明显下降说明该板块成分股未完整返回（向下突刺来源）
// 兜底轮询（mode='poll'）逐只拉取全部成分股，成交额可能略滞后于实时快照，不做分子下降校验，
// 否则从快照切换到轮询时会因为 2% 的抖动被误判为失败
const validateIntradayPoint = (point, existing, mode) => {
    const total = Number(point && point.marketTotalAmount);
    if (!isFinite(total) || total <= 0) {
        throw new Error('全市场成交额无效，放弃本次写入');
    }

    const today = dayjs().format('YYYYMMDD');
    const sameDay = existing && existing.date === today && Array.isArray(existing.points) ? existing.points : [];
    if (sameDay.length === 0) return;

    let maxTotal = 0;
    const maxAmountByName = {};
    for (const item of sameDay) {
        const value = Number(item.marketTotalAmount);
        if (isFinite(value) && value > maxTotal) maxTotal = value;
        for (const [name, amount] of Object.entries(item.amounts || {})) {
            const current = Number(amount);
            if (isFinite(current) && current > (maxAmountByName[name] || 0)) {
                maxAmountByName[name] = current;
            }
        }
    }

    if (maxTotal > 0 && total < maxTotal * MAX_TOTAL_DROP_RATIO) {
        throw new Error(`全市场成交额异常（${total.toFixed(2)}亿，当日已有时点最大 ${maxTotal.toFixed(2)}亿），判定为分母异常，放弃本次写入`);
    }

    if (mode === 'poll') return;

    for (const [name, amount] of Object.entries(point.amounts || {})) {
        const prevMax = maxAmountByName[name];
        const current = Number(amount);
        if (!prevMax || !isFinite(current)) continue;
        if (current < prevMax * MIN_BLOCK_AMOUNT_RATIO) {
            throw createIncompleteError(`板块「${name}」成交额较当日已有时点明显下降，判定为成分股未完整返回，放弃本次写入`);
        }
    }
};

// 过滤分时缓存中的历史坏点：分母骤降（向上突刺）或任一板块累计成交额下降（向下突刺）的时点
const sanitizeIntradayPoints = (points) => {
    const list = [];
    let maxTotal = 0;
    const maxAmountByName = {};

    for (const item of points) {
        const total = Number(item.marketTotalAmount);
        if (!isFinite(total) || total <= 0) continue;
        if (maxTotal > 0 && total < maxTotal * MAX_TOTAL_DROP_RATIO) continue;

        const amounts = item.amounts || {};
        const hasShrink = Object.entries(amounts).some(([name, amount]) => {
            const prevMax = maxAmountByName[name];
            const current = Number(amount);
            return prevMax && isFinite(current) && current < prevMax * MIN_BLOCK_AMOUNT_RATIO;
        });
        if (hasShrink) continue;

        maxTotal = Math.max(maxTotal, total);
        for (const [name, amount] of Object.entries(amounts)) {
            const current = Number(amount);
            if (isFinite(current)) maxAmountByName[name] = Math.max(maxAmountByName[name] || 0, current);
        }
        list.push(item);
    }
    return list;
};

// 读取分时缓存文件
const getIntradayData = () => {
    const data = readJsonSafe(INTRADAY_FILE, null);
    if (!data || !Array.isArray(data.points)) {
        return { date: '', updatedAt: '', points: [] };
    }
    return { ...data, points: sanitizeIntradayPoints(data.points) };
};

// 把收盘时点的实时汇总结果补写进按日历史文件（科技板块成交额 / 各分类成交额）
// 分时缓存跨日滚动时只保留当天时点，若不落盘，次日「上一天」的占比折线点会消失
const persistClosedDayToHistory = (point, date) => {
    if (!point || !point.amounts || !date) return;

    const techMoney = Number(point.amounts[TECH_GROUP_NAME]);
    if (isFinite(techMoney) && techMoney > 0) {
        const list = readJsonSafe(TECH_MONEY_FILE, []);
        if (Array.isArray(list)) {
            const next = list.filter((item) => String(item.date) !== String(date));
            next.push({ date, techTotalMoney: techMoney });
            next.sort((a, b) => String(a.date).localeCompare(String(b.date)));
            fs.writeFileSync(TECH_MONEY_FILE, JSON.stringify(next, null, 2), 'utf-8');
        }
    }

    const categoryMoney = readJsonSafe(CATEGORY_MONEY_FILE, {});
    if (categoryMoney && typeof categoryMoney === 'object' && !Array.isArray(categoryMoney)) {
        let changed = false;
        for (const name of CATEGORY_NAMES) {
            const amount = Number(point.amounts[name]);
            if (!isFinite(amount) || amount <= 0) continue;
            const list = Array.isArray(categoryMoney[name]) ? categoryMoney[name] : [];
            categoryMoney[name] = [...list.filter((row) => String(row.date) !== String(date)), { date, money: amount }]
                .sort((a, b) => String(a.date).localeCompare(String(b.date)));
            changed = true;
        }
        if (changed) {
            fs.writeFileSync(CATEGORY_MONEY_FILE, JSON.stringify(categoryMoney, null, 2), 'utf-8');
        }
    }
};

// 写入一个分时点（同一天内按时间排序，同一时间点覆盖）
const saveIntradayPoint = (point) => {
    const today = dayjs().format('YYYYMMDD');
    const existing = getIntradayData();

    // 跨日滚动前先把上一天最后一个收盘时点落盘，避免旧数据随分时缓存清空而丢失
    if (existing.date && existing.date !== today && Array.isArray(existing.points) && existing.points.length > 0) {
        const lastPoint = existing.points[existing.points.length - 1];
        if (lastPoint && String(lastPoint.time) >= '150000') {
            persistClosedDayToHistory(lastPoint, existing.date);
        }
    }

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
const runAndSaveIntradayPoint = async ({ onProgress, forcePolling = false, forceRefresh = false } = {}) => {
    const { stats, ...point } = await computeTodayRatios({ onProgress, forcePolling, forceRefresh });
    validateIntradayPoint(point, getIntradayData(), stats.mode);
    const payload = saveIntradayPoint(point);

    // 15:00 收盘后的时点即当日最终成交额，落盘到按日历史，次日刷新时上一天的数据不会消失
    const now = new Date();
    const timeVal = now.getHours() * 60 + now.getMinutes();
    if (isTradingDay(now) && timeVal >= 900) {
        persistClosedDayToHistory(point, dayjs().format('YYYYMMDD'));
    }

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

// 读取板块成分股列表（科技汇总读科技股票池，其余读分类成分股文件），并补充沪深市场代码
const getBlockConstituents = (name) => {
    if (!name) return [];
    const list = name === TECH_GROUP_NAME
        ? (readJsonSafe(TECH_STOCK_FILE, null) || {}).stocks
        : readJsonSafe(path.join(CONSTITUENTS_DIR, `${name}.json`), null);
    if (!Array.isArray(list)) return [];

    const seen = new Set();
    const result = [];
    for (const stock of list) {
        const code = String(stock.code || '').trim();
        if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
        seen.add(code);
        const prefix = code.startsWith('6') ? 'sh' : (code.startsWith('0') || code.startsWith('3') ? 'sz' : null);
        result.push({
            code,
            name: stock.name || code,
            marketCode: prefix ? `${prefix}${code}` : null,
        });
    }
    return result;
};

exports.TECH_GROUP_NAME = TECH_GROUP_NAME;
exports.computeTodayRatios = computeTodayRatios;
exports.runAndSaveIntradayPoint = runAndSaveIntradayPoint;
exports.persistClosedDayToHistory = persistClosedDayToHistory;
exports.getIntradayData = getIntradayData;
exports.getBlockVolumeRatioHistory = getBlockVolumeRatioHistory;
exports.getBlockConstituents = getBlockConstituents;
exports.INTRADAY_FILE = INTRADAY_FILE;
