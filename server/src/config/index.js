// 数据源配置：日K/分时图的多数据源加权随机路由 + 兜底顺序
// CLS = 财联社（主力 60%）、THS = 同花顺（主力 40%）、LB = 连板网（仅分时兜底）
// 说明：连板网只有当日分时接口（腾讯底层 app/minute/query），没有日K接口，也不支持历史日期分时。
//   - tline          : 当日分时 → CLS/THS 主源 + 另一主力兜底 + LB 兜底
//   - tlineHistorical: 历史日期分时 → CLS/THS 主源 + 另一主力兜底（LB 不支持按日期查）
//   - kline          : 日K → CLS/THS 主源 + 另一主力兜底（连板网无日K接口）
const DATA_SOURCE_ROUTE = {
    tline: {
        primaryWeights: { cls: 0.6, ths: 0.4 },
        fallbackOrder: { cls: ['ths', 'lb'], ths: ['cls', 'lb'] },
    },
    tlineHistorical: {
        primaryWeights: { cls: 0.6, ths: 0.4 },
        fallbackOrder: { cls: ['ths'], ths: ['cls'] },
    },
    kline: {
        primaryWeights: { cls: 0.6, ths: 0.4 },
        fallbackOrder: { cls: ['ths'], ths: ['cls'] },
    },
};

// 按权重选一个主源。weights: { cls: 0.6, ths: 0.4 } 这种
// contextKey（如 "code|date"）存在时改用 FNV-1a 稳定哈希选择：同一 (场景, 股票, 日期)
// 永远命中同一数据源，且不同股票间仍按权重均匀散开（负载均衡不变）。
// 此前 Math.random 每次请求独立随机，收盘后重算 / 回测重跑同一日期会选出不同源，
// 两个源的分时粒度差异导致抗分歧分与榜单结果跳动（2026-11-14 用户要求收盘后结果可复现）
function pickWeighted(weights, contextKey) {
    let r;
    if (contextKey != null) {
        const str = String(contextKey);
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        r = ((h >>> 0) % 100000) / 100000;
    } else {
        r = Math.random();
    }
    let acc = 0;
    for (const [k, w] of Object.entries(weights)) {
        acc += Number(w) || 0;
        if (r < acc) return k;
    }
    // 兜底返回 weights 最后一个 key
    return Object.keys(weights).pop();
}

let config = {
    useCLS: false,
    // 默认走加权随机路由；显式传平台会绕过随机（如旧调用方显式 'cls'/'ths'）
    dataSourceRoute: DATA_SOURCE_ROUTE,
};

exports.setConfig = (newConfig) => {
    config = { ...config, ...newConfig };
};

exports.getConfig = () => config;

exports.useCLS = () => config.useCLS;

// ---------- 对外暴露的路由工具 ----------
// 根据 scene('tline' | 'kline') 选一个主源；contextKey 传入时同键稳定命中同一源
exports.pickPrimarySource = (scene, contextKey) => {
    const route = config.dataSourceRoute?.[scene];
    if (!route || !route.primaryWeights) return 'cls';
    return pickWeighted(route.primaryWeights, contextKey);
};

// 主源失败时，按顺序返回兜底链
exports.getFallbackOrder = (scene, primary) => {
    const route = config.dataSourceRoute?.[scene];
    if (!route || !route.fallbackOrder) return [];
    return route.fallbackOrder[primary] || [];
};

// 按权重一次性决定「完整尝试顺序」，返回数组（含主源 + 兜底）
// 例如：['cls', 'ths', 'lb']，调用方直接按顺序 try 即可
// contextKey（如 "code|tradeDate"）：同键稳定命中同一主源，保证重算结果可复现
exports.buildTryOrder = (scene, contextKey) => {
    const primary = exports.pickPrimarySource(scene, contextKey);
    const fallbacks = exports.getFallbackOrder(scene, primary);
    return [primary, ...fallbacks];
};

// 允许运行时调整权重（例如临时把 cls 调到 50% 压限流）
exports.setSourceWeights = (scene, weights) => {
    if (!config.dataSourceRoute?.[scene] || !weights) return;
    config.dataSourceRoute[scene].primaryWeights = { ...weights };
};
