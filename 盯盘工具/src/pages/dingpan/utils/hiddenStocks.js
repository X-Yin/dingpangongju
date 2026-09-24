import dayjs from 'dayjs';

// 暂时隐藏股票的本地存储管理（localStorage 持久化，按自然日计）
// 存储结构：{ [code]: { name, days, until } }，until 为恢复显示的时间戳

const STORAGE_KEY = 'dingpan_hidden_stocks';

export const getHiddenStockMap = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const saveHiddenStockMap = (map) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
};

// 是否处于隐藏期内
export const isStockHidden = (entry) => {
    return !!(entry && Number(entry.until) > Date.now());
};

// 隐藏股票 n 个自然日（含今天，共 n 天，到期日次日 0 点自动恢复显示）
export const hideStock = (code, name, days) => {
    const n = Math.max(1, Math.floor(Number(days) || 1));
    const map = getHiddenStockMap();
    map[code] = {
        name: name || code,
        days: n,
        until: dayjs().startOf('day').add(n, 'day').valueOf(),
    };
    saveHiddenStockMap(map);
    return map;
};

// 恢复显示
export const unhideStock = (code) => {
    const map = getHiddenStockMap();
    delete map[code];
    saveHiddenStockMap(map);
    return map;
};

// 清理已过期的隐藏记录，返回最新 map
export const cleanExpiredHiddenStocks = () => {
    const map = getHiddenStockMap();
    let changed = false;
    Object.keys(map).forEach((code) => {
        if (!isStockHidden(map[code])) {
            delete map[code];
            changed = true;
        }
    });
    if (changed) saveHiddenStockMap(map);
    return map;
};

// 过滤掉隐藏期内的股票（仅用于自选股全量监控/个股幅度异动/自选股涨跌幅前十三个模块）
export const filterHiddenStocks = (stocks, hiddenMap) => {
    if (!Array.isArray(stocks)) return [];
    const now = Date.now();
    return stocks.filter((s) => {
        const entry = s && s.code ? hiddenMap[s.code] : null;
        return !(entry && Number(entry.until) > now);
    });
};
