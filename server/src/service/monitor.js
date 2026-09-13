const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dayjs = require('dayjs');

const amountPath = path.resolve(__dirname, '../data/amount.json');
const blockDataChangeTimePath = path.resolve(__dirname, '../data/block_data_change_time.json');
const blockMoneyChangeTimePath = path.resolve(__dirname, '../data/blockMoneyChangeTime.json');
const alarmsPath = path.resolve(__dirname, '../data/monitor_alarms.json');

// 报警阈值（单位：亿）
const MAIN_MONEY_THRESHOLD = 5;   // 主力资金变化超过 3亿
const AMOUNT_CHANGE_THRESHOLD = 200; // 成交量变化超过 100亿
const BLOCK_RANK_THRESHOLD = 2;   // 板块排名变化超过 2名
const BLOCK_MONEY_THRESHOLD = 5;  // 板块资金变化绝对值超过 5亿
const ALARM_RETENTION_HOURS = 0.5;  // 报警信息保留时长（小时）
const POLL_INTERVAL = 3000;       // 轮询间隔 3s

// 生成随机 id
const genId = () => crypto.randomBytes(8).toString('hex');

// 从文件读取报警列表
const readAlarms = () => {
    try {
        return fs.existsSync(alarmsPath) ? JSON.parse(fs.readFileSync(alarmsPath, 'utf8') || '[]') : [];
    } catch (e) {
        console.error('[monitor] 读取报警文件失败:', e.message);
        return [];
    }
};

// 把报警列表写入文件
const writeAlarms = (list) => {
    try {
        fs.writeFileSync(alarmsPath, JSON.stringify(list, null, 2));
    } catch (e) {
        console.error('[monitor] 写入报警文件失败:', e.message);
    }
};

// 从带单位的字符串（如 "-873.55亿" / "+3216.55亿" / "1234.56万"）中解析出数值（单位：亿）
const parseAmountToYi = (str) => {
    if (!str) return 0;
    const isPositive = str.startsWith('+');
    const isNegative = str.startsWith('-');
    const valueStr = (isPositive || isNegative) ? str.slice(1) : str;
    const num = parseFloat(valueStr.replace(/亿|万/g, '')) || 0;
    if (valueStr.indexOf('万') !== -1) {
        // 万 -> 亿
        return (isNegative ? -1 : 1) * (num / 10000);
    }
    return (isNegative ? -1 : 1) * num;
};

// 内部状态
let lastSeenAmountTime = null;   // amount.json 上一次最新数据的时间戳（HHmmss）
let lastSeenAmountData = null;   // amount.json 上一次最新数据的内容
let lastSeenBlockTime = null;    // block_data_change_time.json 上一次最新数据的时间戳
let lastSeenBlockData = null;    // block_data_change_time.json 上一次最新数据的内容
let lastSeenBlockMoneyTime = null; // blockMoneyChangeTime.json 上一次最新数据的时间戳
let lastSeenBlockMoneyData = null; // blockMoneyChangeTime.json 上一次最新数据的内容
let pollingStarted = false;

// 读取 amount.json 中最新的一条数据
const readLatestAmount = () => {
    const data = fs.existsSync(amountPath) ? JSON.parse(fs.readFileSync(amountPath, 'utf8') || '[]') : [];
    if (!data || data.length === 0) return null;
    return data[data.length - 1]; // [time, { mainMoney, amountChangeDiff, ... }]
};

// 读取 block_data_change_time.json 中最新的一条数据
const readLatestBlockData = () => {
    const data = fs.existsSync(blockDataChangeTimePath) ? JSON.parse(fs.readFileSync(blockDataChangeTimePath, 'utf8') || '[]') : [];
    if (!data || data.length === 0) return null;
    return data[data.length - 1]; // { time, blockData: [{ blockName, avgChange }, ...] }
};

// 读取 blockMoneyChangeTime.json 中最新的一条数据
const readLatestBlockMoneyChange = () => {
    const data = fs.existsSync(blockMoneyChangeTimePath) ? JSON.parse(fs.readFileSync(blockMoneyChangeTimePath, 'utf8') || '[]') : [];
    if (!data || data.length === 0) return null;
    return data[data.length - 1]; // { time, data: [{ money, block, blockCode, jumpUrl }, ...] }
};

// 清理超过 1h 的报警信息，并写回文件
const cleanupAlarms = () => {
    const cutoff = dayjs().subtract(ALARM_RETENTION_HOURS, 'hour');
    const groups = readAlarms();
    const filtered = groups.filter(group => group && group.time && dayjs(group.time).isAfter(cutoff));
    if (filtered.length !== groups.length) {
        writeAlarms(filtered);
    }
    return filtered;
};

// 比对板块数据变化，返回发生变化的板块列表
const compareBlockData = (prevBlockData, currBlockData) => {
    const prevMap = new Map();
    prevBlockData.forEach((b, i) => prevMap.set(b.blockName, { rank: i, avgChange: b.avgChange }));
    const changes = [];
    const totalBlocks = currBlockData.length;
    currBlockData.forEach((b, currRank) => {
        const prev = prevMap.get(b.blockName);
        if (!prev) return; // 新增板块，跳过
        const rankDiff = currRank - prev.rank;
        if (Math.abs(rankDiff) > BLOCK_RANK_THRESHOLD) {
            changes.push({ blockName: b.blockName, rankDiff, currentRank: currRank, totalBlocks });
        }
    });
    return changes;
};

// 轮询一次：读取最新数据并与上一次最新数据进行比对
const pollOnce = () => {
    const nowStr = dayjs().format('YYYY-MM-DD HH:mm:ss');
    const newAlarms = [];

    // 1. 比对 amount.json —— 大盘资金
    const amountLatest = readLatestAmount();
    if (amountLatest) {
        const [time, info] = amountLatest;
        if (time !== lastSeenAmountTime) {
            if (lastSeenAmountData !== null) {
                const prevMainMoney = parseAmountToYi(lastSeenAmountData.mainMoney);
                const currMainMoney = parseAmountToYi(info.mainMoney);
                const prevAmountChange = parseAmountToYi(lastSeenAmountData.amountChangeDiff);
                const currAmountChange = parseAmountToYi(info.amountChangeDiff);
                const mainMoneyDiff = currMainMoney - prevMainMoney;
                const amountChangeDiff = currAmountChange - prevAmountChange;

                const parts = [];
                if (Math.abs(mainMoneyDiff) > MAIN_MONEY_THRESHOLD) {
                    const color = mainMoneyDiff > 0 ? '#ff4d4f' : '#52c41a';
                    parts.push(`主力资金变化 <span style="color: ${color}; font-weight: bold;">${(mainMoneyDiff > 0 ? '+' : '') + mainMoneyDiff.toFixed(2)}亿</span>`);
                }
                if (Math.abs(amountChangeDiff) > AMOUNT_CHANGE_THRESHOLD) {
                    const color = amountChangeDiff > 0 ? '#ff4d4f' : '#52c41a';
                    parts.push(`成交量变化 <span style="color: ${color}; font-weight: bold;">${(amountChangeDiff > 0 ? '+' : '') + amountChangeDiff.toFixed(2)}亿</span>`);
                }
                if (parts.length > 0) {
                    newAlarms.push({
                        time: nowStr,
                        title: '大盘主力资金变化',
                        description: parts.join('<br/>'),
                        path: '/volume'
                    });
                }
            }
            lastSeenAmountTime = time;
            lastSeenAmountData = info;
        }
    }

    // 2. 比对 block_data_change_time.json —— 板块排名
    const blockLatest = readLatestBlockData();
    if (blockLatest) {
        const { time, blockData } = blockLatest;
        if (time !== lastSeenBlockTime) {
            if (lastSeenBlockData !== null) {
                const blockChanges = compareBlockData(lastSeenBlockData, blockData);
                if (blockChanges.length > 0) {
                    blockChanges.sort((a, b) => {
                        const aIsUp = a.rankDiff < 0;
                        const bIsUp = b.rankDiff < 0;
                        if (aIsUp !== bIsUp) {
                            return aIsUp ? -1 : 1;
                        }
                        return Math.abs(b.rankDiff) - Math.abs(a.rankDiff);
                    });
                    const parts = blockChanges.map(c => {
                        const sub = [];
                        if (Math.abs(c.rankDiff) > BLOCK_RANK_THRESHOLD) {
                            const color = c.rankDiff < 0 ? '#ff4d4f' : '#52c41a';
                            const rankType = c.rankDiff < 0 ? '上升' : '下降';
                            sub.push(`排名${rankType} <span style="color: ${color}; font-weight: bold;">${Math.abs(c.rankDiff)}名</span>`);
                            sub.push(`当前 <span style="color: #8c8c8c; font-weight: bold;">${c.currentRank + 1}/${c.totalBlocks}</span>`);
                        }
                        return sub.length > 0 ? `<b>${c.blockName}</b>: ${sub.join('，')}` : null;
                    }).filter(Boolean);
                    if (parts.length > 0) {
                        newAlarms.push({
                            time: nowStr,
                            title: '板块排名变化',
                            description: parts.join('<br/>'),
                            path: '/block'
                        });
                    }
                }
            }
            lastSeenBlockTime = time;
            lastSeenBlockData = blockData;
        }
    }

    // 3. 比对 blockMoneyChangeTime.json —— 板块资金
    const blockMoneyLatest = readLatestBlockMoneyChange();
    if (blockMoneyLatest) {
        const { time, data } = blockMoneyLatest;
        if (time !== lastSeenBlockMoneyTime) {
            if (lastSeenBlockMoneyData !== null) {
                const prevMoneyMap = new Map();
                lastSeenBlockMoneyData.forEach(b => prevMoneyMap.set(b.block, b.money || 0));
                const moneyItems = [];
                for (const b of data) {
                    const prev = prevMoneyMap.get(b.block);
                    if (prev === undefined) continue;
                    const moneyDiff = (b.money || 0) - prev;
                    if (Math.abs(moneyDiff / 100000000) > BLOCK_MONEY_THRESHOLD) {
                        moneyItems.push({ block: b.block, moneyDiff });
                    }
                }
                moneyItems.sort((a, b) => Math.abs(b.moneyDiff) - Math.abs(a.moneyDiff));
                const parts = moneyItems.map(item => {
                    const color = item.moneyDiff > 0 ? '#f5222d' : '#389e0d';
                    return `<b>${item.block}</b> 资金变化 <span style="color: ${color}; font-weight: bold;">${item.moneyDiff > 0 ? '+' : ''}${(item.moneyDiff / 100000000).toFixed(2)}亿</span>`;
                });
                if (parts.length > 0) {
                    newAlarms.push({
                        time: nowStr,
                        title: '板块资金变化',
                        description: parts.join('<br/>'),
                        path: '/block_money_change'
                    });
                }
            }
            lastSeenBlockMoneyTime = time;
            lastSeenBlockMoneyData = data;
        }
    }

    // 4. 有报警则写入文件
    if (newAlarms.length > 0) {
        const alarms = readAlarms();
        
        // 增加去重逻辑：如果最近 1 分钟内已经存在相同 title 和 description 的报警，则不再重复添加
        const oneMinuteAgo = dayjs().subtract(1, 'minute');
        const isDuplicate = alarms.some(group => {
            if (dayjs(group.time).isBefore(oneMinuteAgo)) return false;
            return group.alarms.some(existingAlarm => 
                newAlarms.some(newAlarm => 
                    newAlarm.title === existingAlarm.title && 
                    newAlarm.description === existingAlarm.description
                )
            );
        });

        if (isDuplicate) {
            console.log('[monitor] 检测到内容重复的报警，已跳过写入');
            return;
        }

        alarms.push({ id: genId(), time: nowStr, read: false, alarms: newAlarms });
        const cutoff = dayjs().subtract(ALARM_RETENTION_HOURS, 'hour');
        const filtered = alarms.filter(group => group && group.time && dayjs(group.time).isAfter(cutoff));
        writeAlarms(filtered);
        console.log('[monitor] 检测到报警:', { time: nowStr, alarms: newAlarms });
    }
};

// 开启轮询（幂等，重复调用只会启动一次）
const startMonitor = () => {
    if (pollingStarted) return;
    pollingStarted = true;
    console.log(`[monitor] 开始轮询主力资金与成交量，间隔 ${POLL_INTERVAL / 1000}s`);
    // 启动时清理一次过期报警
    cleanupAlarms();
    pollOnce();
    setInterval(pollOnce, POLL_INTERVAL);
};

// 获取最近 1h 内的报警信息
const getMonitorAlarms = () => {
    return cleanupAlarms();
};

// 根据 id 标记某条报警为已读
const markAlarmRead = (id) => {
    const alarms = readAlarms();
    let changed = false;
    for (const group of alarms) {
        if (group && group.id === id && group.read !== true) {
            group.read = true;
            changed = true;
            break;
        }
    }
    if (changed) writeAlarms(alarms);
    return changed;
};

// 标记所有报警为已读
const markAllAlarmsRead = () => {
    const alarms = readAlarms();
    let changed = false;
    for (const group of alarms) {
        if (group && group.read !== true) {
            group.read = true;
            changed = true;
        }
    }
    if (changed) writeAlarms(alarms);
    return changed;
};

// (async () => {
//     startMonitor();
// })()

module.exports = {
    startMonitor,
    getMonitorAlarms,
    markAlarmRead,
    markAllAlarmsRead,
};

