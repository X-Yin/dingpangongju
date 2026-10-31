const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getClsReqStockBasicUrl, batchParallel } = require('../utils');

const DATA_PATH = path.join(__dirname, '../data/monitor_stocks.json');
const TOTAL_SHARES_PATH = path.join(__dirname, '../data/monitor_stocks_total_shares.json');

// 读取 monitor_stocks_total_shares.json（数组：[{ secu_code, secu_name, TotalShares }]）
const getTotalSharesData = () => {
    try {
        if (!fs.existsSync(TOTAL_SHARES_PATH)) return [];
        const data = fs.readFileSync(TOTAL_SHARES_PATH, 'utf8') || '[]';
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Error reading total shares data:', error);
        return [];
    }
};

// 拉取个股基础信息中的总股本（TotalShares）并写入 monitor_stocks_total_shares.json
// codes 为空时：只补拉文件中缺失的股票；传入 codes 时强制重新拉取指定股票
const syncTotalShares = async (codes = null) => {
    const stocks = getMonitorStocks();
    const existingArr = getTotalSharesData();
    const existingMap = {};
    existingArr.forEach(item => {
        if (item && item.secu_code) existingMap[item.secu_code] = item;
    });

    // 待拉取列表：显式传入则强制刷新；否则只拉缺失的
    let targetCodes;
    if (Array.isArray(codes) && codes.length > 0) {
        targetCodes = stocks.filter(s => codes.includes(s.code)).map(s => s.code)
            .concat(codes.filter(c => !stocks.find(s => s.code === c)));
    } else {
        targetCodes = stocks.map(s => s.code).filter(code =>
            !existingMap[code] || existingMap[code].TotalShares == null
        );
    }

    if (targetCodes.length > 0) {
        const clsHeaders = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': 'https://www.cls.cn',
            'Referer': 'https://www.cls.cn/',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        };
        const fetchOne = async (code) => {
            try {
                const { data: resp } = await axios.get(getClsReqStockBasicUrl(code), { headers: clsHeaders, timeout: 10000 });
                if (resp && resp.code === 200 && resp.data && resp.data.TotalShares != null) {
                    return {
                        secu_code: resp.data.secu_code,
                        secu_name: resp.data.secu_name,
                        TotalShares: resp.data.TotalShares,
                    };
                }
                console.error(`获取 ${code} 总股本失败: 响应异常`, resp && resp.msg);
            } catch (error) {
                console.error(`获取 ${code} 总股本失败:`, error.message);
            }
            return null;
        };
        const fetched = await batchParallel(targetCodes, fetchOne, 5);
        fetched.forEach(item => {
            if (item) existingMap[item.secu_code] = item;
        });
    }

    // 与监控列表保持同序，剔除已删除的自选股
    const merged = stocks
        .map(s => existingMap[s.code])
        .filter(Boolean);

    fs.writeFileSync(TOTAL_SHARES_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
};

const getMonitorStocks = () => {
    try {
        if (!fs.existsSync(DATA_PATH)) {
            return [];
        }
        const data = fs.readFileSync(DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading monitor stocks:', error);
        return [];
    }
};

const saveMonitorStocks = (stocks) => {
    try {
        fs.writeFileSync(DATA_PATH, JSON.stringify(stocks, null, 2), 'utf8');
        
        // 删除或更新后，立即清理 stockData.json 中的失效数据，确保前端 fetchData 拿到的是最新列表
        const stockDataPath = path.resolve(__dirname, '../data/stockData.json');
        if (fs.existsSync(stockDataPath)) {
            const stockData = JSON.parse(fs.readFileSync(stockDataPath, 'utf-8'));
            const monitorCodes = stocks.map(s => s.code);
            const newStockData = {};
            
            // 只保留当前监控列表中的股票数据
            monitorCodes.forEach(code => {
                if (stockData[code]) {
                    newStockData[code] = stockData[code];
                }
            });
            
            fs.writeFileSync(stockDataPath, JSON.stringify(newStockData, null, 2), 'utf-8');
        }
        
        return true;
    } catch (error) {
        console.error('Error saving monitor stocks:', error);
        return false;
    }
};

// 本地时间格式化 'YYYY-MM-DD HH:mm:ss'
const fmtLocalDateTime = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const addMonitorStock = (code, name, blockName = 'xxx', riskScore = null, isTech = true, watchMarketCap = true, watchPE = true) => {
    const stocks = getMonitorStocks();
    if (stocks.find(s => s.code === code)) {
        return false;
    }
    // 记录添加时刻（本地时间）：供买卖点回测判断「买点时刻该股是否已在自选股中」，
    // 防止后加自选股污染历史回测结果（历史上买的是 A，不能因后加了 B 就改成买 B）
    const addedAt = fmtLocalDateTime(new Date());
    stocks.push({ code, name, isImportant: false, blockName, riskScore, isTech, watchMarketCap, watchPE, addedAt });
    return saveMonitorStocks(stocks);
};

// 自选股添加时间索引（按文件 mtime 缓存，避免回测逐候选逐桶查询时反复读文件）：
// code -> { date: 'YYYYMMDD', minute: HHMM 整数 }；无 addedAt 的存量数据不入表（视为一直在自选股中）
let addedAtIndexCache = null; // { mtimeMs, map, checkedAt }
const ADDED_INDEX_CHECK_INTERVAL_MS = 1000; // mtime 检查节流：回测热循环中避免每次调用都 statSync
const getStockAddedAtIndex = () => {
    try {
        const now = Date.now();
        if (addedAtIndexCache && now - addedAtIndexCache.checkedAt < ADDED_INDEX_CHECK_INTERVAL_MS) {
            return addedAtIndexCache.map;
        }
        const mtimeMs = fs.statSync(DATA_PATH).mtimeMs;
        if (addedAtIndexCache && addedAtIndexCache.mtimeMs === mtimeMs) {
            addedAtIndexCache.checkedAt = now;
            return addedAtIndexCache.map;
        }
        const map = new Map();
        for (const s of getMonitorStocks()) {
            if (!s || !s.code || !s.addedAt) continue;
            const m = String(s.addedAt).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
            if (!m) {
                console.error(`自选股 ${s.code} addedAt 格式异常: ${s.addedAt}，按一直存在处理`);
                continue;
            }
            const date = `${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`;
            const minute = Number(m[4]) * 100 + Number(m[5]);
            map.set(s.code, { date, minute });
        }
        addedAtIndexCache = { mtimeMs, map, checkedAt: now };
        return map;
    } catch (error) {
        console.error('读取自选股添加时间索引失败:', error.message);
        return addedAtIndexCache ? addedAtIndexCache.map : new Map();
    }
};

// 判断股票在回放日 dateStr（YYYYMMDD）的第 minute（HHMM 整数）分钟买点时刻是否已在自选股中：
//   无 addedAt（存量数据）→ 视为一直在；
//   买点日之前添加 → 在；买点日之后添加 → 不在；
//   买点当日添加 → 添加时刻 ≤ 买点分钟才在（买点分钟未知时保守视为不在，宁可不买）
const isStockInWatchlistAt = (code, dateStr, minute) => {
    const added = getStockAddedAtIndex().get(code);
    if (!added) return true;
    const d = String(dateStr);
    if (added.date < d) return true;
    if (added.date > d) return false;
    if (minute == null || !Number.isFinite(Number(minute))) return false;
    return added.minute <= Number(minute);
};

// 自选股「是否关注市值 / 是否关注 PE」开关索引（按文件 mtime 缓存，供回测/线上热循环同步查询）：
// code -> { watchMarketCap, watchPE }；存量数据缺失字段时按 true（关注）处理
let watchFlagIndexCache = null; // { mtimeMs, map, checkedAt }
const getStockWatchFlagIndex = () => {
    try {
        const now = Date.now();
        if (watchFlagIndexCache && now - watchFlagIndexCache.checkedAt < ADDED_INDEX_CHECK_INTERVAL_MS) {
            return watchFlagIndexCache.map;
        }
        const mtimeMs = fs.statSync(DATA_PATH).mtimeMs;
        if (watchFlagIndexCache && watchFlagIndexCache.mtimeMs === mtimeMs) {
            watchFlagIndexCache.checkedAt = now;
            return watchFlagIndexCache.map;
        }
        const map = new Map();
        for (const s of getMonitorStocks()) {
            if (!s || !s.code) continue;
            map.set(s.code, {
                watchMarketCap: s.watchMarketCap !== false,
                watchPE: s.watchPE !== false,
            });
        }
        watchFlagIndexCache = { mtimeMs, map, checkedAt: now };
        return map;
    } catch (error) {
        console.error('读取自选股关注开关索引失败:', error.message);
        return watchFlagIndexCache ? watchFlagIndexCache.map : new Map();
    }
};

// 查询单只自选股的两个关注开关；不在自选股中或字段缺失时均按关注（true）
const getStockWatchFlags = (code) => getStockWatchFlagIndex().get(code) || { watchMarketCap: true, watchPE: true };

// 编辑自选股（右键菜单「编辑」）：名称 / 板块 / 风险偏好 / 是否科技股 / 是否关注市值 / 是否关注 PE 均可改；
// 股票代码允许改（视为替换该条记录），改代码时若新代码已在自选股中则拒绝，避免重复
const updateMonitorStockInfo = (originalCode, payload = {}) => {
    const stocks = getMonitorStocks();
    const idx = stocks.findIndex(s => s.code === originalCode);
    if (idx < 0) {
        return { success: false, message: '该股票不在自选股中' };
    }
    const prev = stocks[idx];
    const nextCode = payload.code || originalCode;
    if (nextCode !== originalCode && stocks.some(s => s.code === nextCode)) {
        return { success: false, message: '该股票已在自选股中，请勿重复添加' };
    }
    const nextName = payload.name != null && String(payload.name).trim() ? String(payload.name).trim() : prev.name;
    stocks[idx] = {
        ...prev,
        code: nextCode,
        name: nextName,
        blockName: payload.blockName != null ? payload.blockName : prev.blockName,
        riskScore: payload.riskScore != null && payload.riskScore !== '' ? payload.riskScore : null,
        isTech: payload.isTech !== false,
        watchMarketCap: payload.watchMarketCap !== false,
        watchPE: payload.watchPE !== false,
    };
    const success = saveMonitorStocks(stocks);
    return { success, codeChanged: nextCode !== originalCode, code: nextCode, message: success ? '更新成功' : '更新失败' };
};

const deleteMonitorStock = (code) => {
    const stocks = getMonitorStocks();
    const newStocks = stocks.filter(s => s.code !== code);
    if (stocks.length === newStocks.length) {
        return false;
    }
    // 同步移除总股本文件中的对应记录
    try {
        const filtered = getTotalSharesData().filter(item => item.secu_code !== code);
        fs.writeFileSync(TOTAL_SHARES_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    } catch (error) {
        console.error('清理总股本数据失败:', error);
    }
    return saveMonitorStocks(newStocks);
};

const toggleStockImportant = (code) => {
    const stocks = getMonitorStocks();
    const stock = stocks.find(s => s.code === code);
    if (!stock) {
        return false;
    }
    stock.isImportant = !stock.isImportant;
    return saveMonitorStocks(stocks);
};

const toggleStockTop = (code) => {
    const stocks = getMonitorStocks();
    const stock = stocks.find(s => s.code === code);
    if (!stock) {
        return false;
    }
    stock.isTop = !stock.isTop;
    return saveMonitorStocks(stocks);
};

const batchSetImportant = (codes) => {
    if (!Array.isArray(codes) || codes.length === 0) {
        return { success: false, message: '股票代码列表为空' };
    }
    const stocks = getMonitorStocks();
    let updatedCount = 0;
    for (const code of codes) {
        const stock = stocks.find(s => s.code === code);
        if (stock && !stock.isImportant) {
            stock.isImportant = true;
            updatedCount++;
        }
    }
    if (updatedCount > 0) {
        saveMonitorStocks(stocks);
    }
    return { success: true, updatedCount, totalRequested: codes.length };
};

const updateMonitorStockName = (code, newName) => {
    const stocks = getMonitorStocks();
    const stock = stocks.find(s => s.code === code);
    if (!stock) {
        return false;
    }
    stock.name = newName;
    return saveMonitorStocks(stocks);
};

// 判断股票是否属于「全量自选股中的科技股」（isTech !== false）：
// 攻防兼备模式下卖点诊断据此分流——科技股走科技卖点诊断，其余（非科技或不在自选股）视为连板股走龙头卖点诊断
const isTechWatchlistStock = (code) => {
    const s = getMonitorStocks().find(x => x.code === code);
    return !!s && s.isTech !== false;
};

module.exports = {
    getMonitorStocks,
    addMonitorStock,
    deleteMonitorStock,
    toggleStockImportant,
    batchSetImportant,
    updateMonitorStockName,
    updateMonitorStockInfo,
    toggleStockTop,
    getTotalSharesData,
    syncTotalShares,
    isStockInWatchlistAt,
    getStockWatchFlags,
    isTechWatchlistStock
};
