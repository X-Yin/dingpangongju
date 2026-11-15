// 数据源配置：日K/分时图的多数据源加权随机路由 + 兜底顺序
// CLS = 财联社、THS = 同花顺、XQ = 雪球（2026-11-15 新增）、LB = 连板网（仅分时兜底）
// 说明：连板网只有当日分时接口（腾讯底层 app/minute/query），没有日K接口，也不支持历史日期分时。
//   雪球有日K + 最新一日分时，同样不支持按历史日期查分时。
// 2026-11-15 用户要求（负载均衡）：不再让所有股票都先打雪球，而是按股票把请求均匀分散到
//   雪球 / 财联社 / 同花顺（约 1/3 each），某只股票主源失败时再按 fallbackOrder 依次兜底，
//   避免单一接口方被同时打满触发限流。
//   - tline          : 当日分时 → XQ / CLS / THS 各约 1/3 + LB 最终兜底
//   - tlineHistorical: 历史日期分时 → CLS / THS 各 1/2（雪球/连板网不支持历史日期）
//   - kline          : 日K → XQ / CLS / THS 各约 1/3（连板网无日K接口）
const DATA_SOURCE_ROUTE = {
    tline: {
        primaryWeights: { xq: 0.34, cls: 0.33, ths: 0.33 },
        fallbackOrder: {
            xq: ['cls', 'ths', 'lb'],
            cls: ['ths', 'xq', 'lb'],
            ths: ['cls', 'xq', 'lb'],
        },
    },
    tlineHistorical: {
        primaryWeights: { cls: 0.5, ths: 0.5 },
        fallbackOrder: { cls: ['ths'], ths: ['cls'] },
    },
    kline: {
        primaryWeights: { xq: 0.34, cls: 0.33, ths: 0.33 },
        fallbackOrder: {
            xq: ['cls', 'ths'],
            cls: ['ths', 'xq'],
            ths: ['cls', 'xq'],
        },
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
