// 10 分钟固定间隔盯盘监控快照
// - 每 10 分钟（交易日 9:40-15:00）读取一次本地分时缓存，计算最近 10 分钟变化：
//   ① 板块平均涨幅（block_data_change_time.json，avgChange 差值）
//   ② 板块主力资金净流入（blockMoneyChangeTime.json，money 差值，单位亿）
//   ③ 板块成交量占比（与 MainFund「板块成交量/分时图/近10min持续提升」同口径：
//      优先取近 10 分钟占比持续提升的板块，按「较上一日占比变化」排序，单位百分点）
//   每项分别取前 5 / 后 5，写入当日缓存文件 data/monitor_snapshots_YYYYMMDD.json 并经 WS 广播。
// - WS 类型：{ type:'monitor_snapshot', ts, open:true, data: snapshot }
//   open:true 只用于前端「收到即弹卡」，该类型不进入 pending_alerts 对账，避免重连补弹历史监控。
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { isTradingDay, isMiddayBreak, isAfterMarketClose, resolveAnalysisDate } = require('../utils');
const { getBlockCategoryRatio } = require('./板块成交量占比计算/category_amount_money');
const wsServer = require('../wsServer');

const DATA_DIR = path.resolve(__dirname, '../data');
const CHANGE_FILE = path.join(DATA_DIR, 'block_data_change_time.json');
const FUND_FILE = path.join(DATA_DIR, 'blockMoneyChangeTime.json');
const VOLUME_FILE = path.join(DATA_DIR, 'block_volume_ratio_intraday.json');

const WINDOW_MINUTES = 10;
const TOP_N = 5;
const CHECK_INTERVAL = 30 * 1000;
// 首个可算出的时点：9:40（9:30 没有 10 分钟前的基准）
const WINDOW_START_MINUTE = 9 * 60 + 40;
const WINDOW_END_MINUTE = 15 * 60;

let timer = null;
let lastRunKey = '';

const readJsonSafe = (file, fallback) => {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf-8');
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
};

const toNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

// 统一转换为「连续交易分钟」：跨午休不连续（9:30=0，11:30=120，13:00=120，15:00=240）
const toTradingMinute = (timeStr) => {
    const digits = String(timeStr || '').replace(/[^0-9]/g, '');
    if (digits.length < 4) return null;
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2, 4));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const totalMin = hour * 60 + minute;
    if (totalMin <= 11 * 60 + 30) return totalMin - (9 * 60 + 30);
    return 120 + (totalMin - 13 * 60);
};

// 在按时间升序排列的序列里，找到「不晚于 latestTm - windowMinutes」的最后一个点
const findBasePoint = (points, latestTm) => {
    const target = latestTm - WINDOW_MINUTES;
    let base = null;
    for (const point of points) {
        if (point.tm <= target) base = point;
        else break;
    }
    return base;
};

const sortWithTm = (list, timeKey) => list
    .map((item) => ({ ...item, tm: toTradingMinute(typeof timeKey === 'function' ? timeKey(item) : item[timeKey]) }))
    .filter((item) => item.tm !== null)
    .sort((a, b) => a.tm - b.tm);

// 拆分前 N / 后 N
const splitTopBottom = (list) => {
    const sortedDesc = [...list].sort((a, b) => b.delta - a.delta);
    return {
        up: sortedDesc.slice(0, TOP_N),
        down: [...list].sort((a, b) => a.delta - b.delta).slice(0, TOP_N),
    };
};

const round = (value, digits = 2) => Number(value.toFixed(digits));

// ① 板块平均涨幅：最近 10 分钟 avgChange 的变化（百分点）
//   limitTm：只取「不晚于该交易分钟」的数据，用于生成历史时点快照（默认取全部）
const buildChangeSection = (limitTm = Infinity) => {
    const frames = readJsonSafe(CHANGE_FILE, []);
    if (!Array.isArray(frames) || frames.length === 0) return { up: [], down: [], baseTime: null };
    const points = sortWithTm(frames, 'time').filter((item) => item.tm <= limitTm);
    if (points.length === 0) return { up: [], down: [], baseTime: null };
    const latest = points[points.length - 1];
    const base = findBasePoint(points, latest.tm);
    if (!base) return { up: [], down: [], baseTime: null };

    const baseMap = new Map(
        (base.blockData || []).map((item) => [item.blockName, toNumber(item.avgChange)])
    );
    const list = [];
    (latest.blockData || []).forEach((item) => {
        const prev = baseMap.get(item.blockName);
        const curr = toNumber(item.avgChange);
        if (prev === null || prev === undefined || curr === null) return;
        list.push({
            name: item.blockName,
            value: round(curr, 2),
            delta: round(curr - prev, 2),
        });
    });
    return { ...splitTopBottom(list), baseTime: base.time };
};

// 板块资金监控排除项：指数类板块不参与「板块资金」排名
const EXCLUDED_FUND_BLOCK_NAMES = new Set(['中证500']);
const isExcludedFundBlock = (name) => EXCLUDED_FUND_BLOCK_NAMES.has(String(name || '').replace(/\s/g, ''));

// ② 板块主力资金：最近 10 分钟净流入变化（亿元）
const buildFundSection = (limitTm = Infinity) => {
    const frames = readJsonSafe(FUND_FILE, []);
    if (!Array.isArray(frames) || frames.length === 0) return { up: [], down: [], baseTime: null };
    const points = sortWithTm(frames, 'time').filter((item) => item.tm <= limitTm);
    if (points.length === 0) return { up: [], down: [], baseTime: null };
    const latest = points[points.length - 1];
    const base = findBasePoint(points, latest.tm);
    if (!base) return { up: [], down: [], baseTime: null };

    const baseMap = new Map(
        (base.data || []).map((item) => [item.block, toNumber(item.money)])
    );
    const list = [];
    (latest.data || []).forEach((item) => {
        if (isExcludedFundBlock(item.block)) return;
        const prev = baseMap.get(item.block);
        const curr = toNumber(item.money);
        if (prev === null || prev === undefined || curr === null) return;
        list.push({
            name: item.block,
            value: round(curr / 1e8, 2),
            delta: round((curr - prev) / 1e8, 2),
        });
    });
    return { ...splitTopBottom(list), baseTime: base.time };
};

// ③ 板块成交量占比：与 MainFund「板块成交量 / 分时图 / 近10min持续提升」保持一致
//   - 分时点来自 block_volume_ratio_intraday.json；
//   - 「近10min持续提升」按 MainFund 的 isRiseSustained 口径判断（窗口内有效点逐段严格上升）；
//   - 排序使用「最新日占比 - 上一日占比」（百分点），与 MainFund 分组后的排序一致；
//   - 若无持续提升板块，则退回全部板块按较上一日占比变化排序（MainFund 的「其余板块」分组口径）。
const toClockMinute = (timeStr) => {
    const digits = String(timeStr || '').replace(/[^0-9]/g, '');
    if (digits.length < 4) return null;
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2, 4));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
};

const isRiseSustained = (points, name, windowMinutes) => {
    const required = windowMinutes / 10 + 1;
    const valid = [];
    for (const point of points) {
        const minute = toClockMinute(point.time);
        const raw = point.ratios ? point.ratios[name] : null;
        if (minute === null || raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
        valid.push({ minute, value: Number(raw) });
    }
    if (valid.length < required) return false;
    const latestMinute = valid[valid.length - 1].minute;
    const window = valid.filter((item) => latestMinute - item.minute <= windowMinutes);
    if (window.length < required) return false;
    for (let i = 1; i < window.length; i += 1) {
        if (!(window[i].value > window[i - 1].value)) return false;
    }
    return true;
};

// 各板块「最新日占比 - 上一日占比」（百分点），数据与 MainFund 日成交量占比一致
const buildVolumeDailyChangeMap = () => {
    const changeMap = new Map();
    try {
        const categoryRatio = getBlockCategoryRatio(null, null, null);
        Object.entries(categoryRatio).forEach(([name, rows]) => {
            if (!Array.isArray(rows) || rows.length < 2) return;
            const latest = rows[rows.length - 1];
            const prev = rows[rows.length - 2];
            const latestRatio = toNumber(latest && latest.ratio);
            const prevRatio = toNumber(prev && prev.ratio);
            if (latestRatio === null || prevRatio === null) return;
            changeMap.set(name, latestRatio - prevRatio);
        });
    } catch (e) {
        console.warn('[monitorSnapshot] 读取板块成交量占比日线失败:', e.message);
    }
    return changeMap;
};

const buildVolumeSection = (limitTm = Infinity) => {
    const payload = readJsonSafe(VOLUME_FILE, {});
    const points = sortWithTm(Array.isArray(payload.points) ? payload.points : [], 'time')
        .filter((item) => item.tm <= limitTm);
    if (points.length === 0) return { up: [], down: [], baseTime: null };
    const latest = points[points.length - 1];
    const latestRatios = latest.ratios || {};
    const changeMap = buildVolumeDailyChangeMap();

    const list = [];
    Object.keys(latestRatios).forEach((name) => {
        const current = toNumber(latestRatios[name]);
        if (current === null) return;
        list.push({
            name,
            value: round(current, 2),
            // 先保留原始变化值用于排序（避免四舍五入后并列导致顺序与 MainFund 不一致），输出时再取整
            delta: changeMap.has(name) ? changeMap.get(name) : 0,
            rise10m: isRiseSustained(points, name, 10),
        });
    });
    if (list.length === 0) return { up: [], down: [], baseTime: null };

    const sustained = list
        .filter((item) => item.rise10m)
        .sort((a, b) => b.delta - a.delta);
    // 「近10min持续提升」的板块保持优先展示（按较上一日变化降序）；
    // 不足 5 个时用其余板块按同一排序补齐，保证「前5」始终满 5 个（与 MainFund 其余板块同口径）
    const sustainedNames = new Set(sustained.map((item) => item.name));
    const restSorted = [...list]
        .filter((item) => !sustainedNames.has(item.name))
        .sort((a, b) => b.delta - a.delta);
    const upSource = [...sustained, ...restSorted];
    const formatItem = ({ rise10m, ...item }) => ({ ...item, delta: round(item.delta, 2) });
    const up = upSource.slice(0, TOP_N).map(formatItem);
    const upNames = new Set(up.map((item) => item.name));
    const down = [...list]
        .filter((item) => !upNames.has(item.name))
        .sort((a, b) => a.delta - b.delta)
        .slice(0, TOP_N)
        .map(formatItem);

    return { up, down, baseTime: null };
};

const hasSectionData = (section) => section && (section.up.length > 0 || section.down.length > 0);

// 生成一次监控快照（不落盘、不广播）
//   options.date/time：指定快照归属日期与时间（默认当前时刻）
//   options.limitTm：只使用不晚于该交易分钟的数据（用于按历史时点回放生成）
const buildSnapshot = ({ date, time, limitTm = Infinity } = {}) => {
    const change = buildChangeSection(limitTm);
    const fund = buildFundSection(limitTm);
    const volume = buildVolumeSection(limitTm);
    if (!hasSectionData(change) && !hasSectionData(fund) && !hasSectionData(volume)) return null;

    const now = dayjs();
    const snapshotDate = date || now.format('YYYY-MM-DD');
    const snapshotTime = time || now.format('HH:mm');
    return {
        id: `${snapshotDate.replace(/-/g, '')}${snapshotTime.replace(':', '')}`,
        date: snapshotDate,
        time: snapshotTime,
        createdAt: `${snapshotDate} ${snapshotTime}:00`,
        windowMinutes: WINDOW_MINUTES,
        change,
        fund,
        volume,
    };
};

const snapshotFile = (date) => path.join(DATA_DIR, `monitor_snapshots_${String(date).replace(/-/g, '')}.json`);

const readTodaySnapshots = (date = dayjs().format('YYYY-MM-DD')) => {
    const list = readJsonSafe(snapshotFile(date), []);
    return Array.isArray(list) ? list : [];
};

const appendSnapshot = (snapshot, cacheDate = snapshot.date) => {
    const list = readTodaySnapshots(cacheDate);
    if (list.some((item) => item && item.id === snapshot.id)) return;
    list.push(snapshot);
    try {
        fs.writeFileSync(snapshotFile(cacheDate), JSON.stringify(list, null, 2));
    } catch (e) {
        console.error('[monitorSnapshot] 写入当日监控缓存失败:', e.message);
    }
};

const formatDateLabel = (value) => {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    if (digits.length !== 8) return String(value || '');
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
};

// 所有快照缓存文件对应的日期（YYYYMMDD，升序）
const listSnapshotDates = () => {
    try {
        return fs.readdirSync(DATA_DIR)
            .map((name) => {
                const match = name.match(/^monitor_snapshots_(\d{8})\.json$/);
                return match ? match[1] : null;
            })
            .filter(Boolean)
            .sort();
    } catch (e) {
        return [];
    }
};

// 获取分页历史（最新在前）
// 未指定 date 时优先读当日缓存；当日缓存为空（如非交易日 / 刚清理）则回退到最近一个有数据的日期，
// 保证界面上始终能看到最近一次监控列表，而不是空白。
const getSnapshots = ({ limit = 10, offset = 0, date } = {}) => {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    let targetDate = date || dayjs().format('YYYY-MM-DD');
    let all = readTodaySnapshots(targetDate);

    if (!date && all.length === 0) {
        const dates = listSnapshotDates();
        for (let i = dates.length - 1; i >= 0; i -= 1) {
            const list = readTodaySnapshots(dates[i]);
            if (list.length > 0) {
                all = list;
                targetDate = dates[i];
                break;
            }
        }
    }

    all = all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return {
        date: formatDateLabel(targetDate),
        total: all.length,
        limit: safeLimit,
        offset: safeOffset,
        items: all.slice(safeOffset, safeOffset + safeLimit),
    };
};

const broadcastSnapshot = (snapshot, extra = {}) => {
    wsServer.broadcast({
        type: 'monitor_snapshot',
        ts: Date.now(),
        open: true,
        data: snapshot,
        ...extra,
    });
};

const runOnce = ({ mock = false } = {}) => {
    const snapshot = buildSnapshot();
    if (!snapshot) {
        console.warn('[monitorSnapshot] 当前分时缓存不足，跳过本次监控');
        return null;
    }
    if (mock) snapshot.mock = true;
    if (!mock) appendSnapshot(snapshot);
    broadcastSnapshot(snapshot);
    console.log(`[monitorSnapshot] ${snapshot.time} 监控快照已推送${mock ? '（MOCK）' : ''}`);
    return snapshot;
};

// 三个分时缓存文件里最新一帧的 HH:MM（按连续交易分钟取最大）
// 缓存只保留最近一个交易日的分时数据，故该时刻即「最新交易日的最近交易时间」
const getLatestDataTime = () => {
    const candidates = [];
    const changeFrames = readJsonSafe(CHANGE_FILE, []);
    if (Array.isArray(changeFrames)) changeFrames.forEach((f) => candidates.push(f && f.time));
    const fundFrames = readJsonSafe(FUND_FILE, []);
    if (Array.isArray(fundFrames)) fundFrames.forEach((f) => candidates.push(f && f.time));
    const volPayload = readJsonSafe(VOLUME_FILE, {});
    if (Array.isArray(volPayload.points)) volPayload.points.forEach((p) => candidates.push(p && p.time));

    let latest = null;
    let latestTm = -Infinity;
    candidates.forEach((t) => {
        const tm = toTradingMinute(t);
        if (tm !== null && tm > latestTm) {
            latestTm = tm;
            latest = t;
        }
    });
    return latest;
};

// 前端「即刻监控」按钮触发（2026-11-22 用户新增）：
//   点击即立刻用本地分时缓存生成一次监控快照并广播，不必等到整 10 分钟调度。
//   - 非交易时段（盘后 / 周末 / 节假日 / 午休 / 开盘前）也能生成：直接复用缓存里
//     「最新一个交易日的最近交易时间」往前取 10 分钟；快照时间标签取该帧的真实
//     交易时间（而非点击时刻），避免把周五数据标成周末时间；
//   - 不足 10 分钟（无 10 分钟前基准点）时 buildSnapshot 返回空，提示数据不足；
//   - 同一交易时点重复点击不重复落盘（snapshot.id = 日期+时分），但每次都重新广播弹卡；
//   - 返回 { ok, message, snapshot } 供 WS 回执给前端。
const triggerInstant = () => {
    // 缓存里持有的是「最新一个交易日」的分时数据：
    //   非交易日 / 交易日 09:30 前 → 上一个交易日；交易日盘中 / 盘后 → 当日。
    const latestTradingDate = dayjs(resolveAnalysisDate(new Date())).format('YYYY-MM-DD');
    const latestDataTime = getLatestDataTime();
    if (!latestDataTime) {
        return { ok: false, message: '当前分时缓存为空，暂无法生成监控快照' };
    }
    const snapshot = buildSnapshot({ date: latestTradingDate, time: latestDataTime });
    if (!snapshot) {
        return { ok: false, message: '当前分时数据不足（不足 10 分钟），暂无法生成监控快照' };
    }
    snapshot.instant = true;
    const exists = readTodaySnapshots(snapshot.date).some((s) => s && s.id === snapshot.id);
    if (!exists) appendSnapshot(snapshot);
    // 即刻监控：每次点击都重新广播弹卡（已存在则不重复落盘）
    broadcastSnapshot(snapshot);
    const message = exists
        ? `${snapshot.date} ${snapshot.time} 监控快照已存在，已重新推送`
        : `已生成 ${snapshot.date} ${snapshot.time} 监控快照`;
    console.log(`[monitorSnapshot] 即刻监控：${snapshot.date} ${snapshot.time} 快照已${exists ? '重新' : ''}推送`);
    return { ok: true, message, snapshot };
};

// 调试 MOCK：优先使用实时缓存；数据不足时构造一份可展示的示例快照
const runMock = () => {
    const snapshot = buildSnapshot() || buildFallbackMock();
    snapshot.mock = true;
    broadcastSnapshot(snapshot);
    console.log(`[monitorSnapshot] MOCK 监控快照已推送 ${snapshot.time}`);
    return snapshot;
};

// 兜底示例：直接从最新分时缓存取板块名，制造可辨识的涨跌差值
const buildFallbackMock = () => {
    const frames = readJsonSafe(CHANGE_FILE, []);
    const latestFrame = Array.isArray(frames) && frames.length ? frames[frames.length - 1] : null;
    const blocks = (latestFrame && latestFrame.blockData ? latestFrame.blockData : []).slice(0, 20);
    const buildItems = (key, step, digits) => blocks.map((item, index) => {
        const base = toNumber(item[key]) || 0;
        const delta = round((blocks.length - index) * step, digits);
        return {
            name: item.blockName,
            value: round(base, digits),
            delta,
        };
    });
    const changeList = buildItems('avgChange', 0.18, 2);
    const fundList = buildItems('avgChange', 0.8, 2);
    const volumeList = buildItems('avgChange', 0.12, 2);
    const now = dayjs();
    return {
        id: `${now.format('YYYYMMDDHHmm')}`,
        date: now.format('YYYY-MM-DD'),
        time: now.format('HH:mm'),
        createdAt: now.format('YYYY-MM-DD HH:mm:ss'),
        windowMinutes: WINDOW_MINUTES,
        mock: true,
        change: { ...splitTopBottom(changeList), baseTime: null },
        fund: { ...splitTopBottom(fundList), baseTime: null },
        volume: { ...splitTopBottom(volumeList), baseTime: null },
    };
};

const isInWindow = (now) => {
    if (!isTradingDay(now)) return false;
    if (isMiddayBreak(now) || isAfterMarketClose(now)) return false;
    const minute = now.getHours() * 60 + now.getMinutes();
    return minute >= WINDOW_START_MINUTE && minute <= WINDOW_END_MINUTE;
};

// 每 30s 检查一次：命中整 10 分钟时执行一次（同一分钟内幂等）
const start = () => {
    if (timer) return;
    timer = setInterval(() => {
        const now = new Date();
        const key = dayjs(now).format('YYYYMMDDHHmm');
        if (now.getMinutes() % 10 !== 0) return;
        if (lastRunKey === key) return;
        if (!isInWindow(now)) return;
        lastRunKey = key;
        try {
            runOnce();
        } catch (e) {
            console.error('[monitorSnapshot] 生成监控快照失败:', e.message);
        }
    }, CHECK_INTERVAL);
    console.log('[monitorSnapshot] 10 分钟监控调度已启动');
};

const stop = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};

module.exports = {
    start,
    stop,
    runOnce,
    runMock,
    triggerInstant,
    buildSnapshot,
    appendSnapshot,
    getSnapshots,
};
