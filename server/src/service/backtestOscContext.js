// 震荡测试（前端勾选隐藏个股后带 excludeCodes 重跑回测）的排除个股上下文。
// 用 AsyncLocalStorage 隔离并发回测任务：每次震荡测试运行只影响自己那次执行链，
// 候选选股处统一调用 isOscExcluded(code) 过滤被隐藏的股票。
const { AsyncLocalStorage } = require('async_hooks');

const oscExcludeStorage = new AsyncLocalStorage();

// 判断某股票是否被当前这次回测执行排除（震荡测试勾选隐藏）；非震荡测试运行时恒为 false
const isOscExcluded = (code) => {
  if (!code) return false;
  const set = oscExcludeStorage.getStore();
  return !!(set && set.has(String(code).trim().toLowerCase()));
};

// 以指定排除列表运行一次回测（excludeSet 为小写股票代码 Set 或 null）
const runWithOscExclude = (excludeSet, fn) => oscExcludeStorage.run(excludeSet || null, fn);

module.exports = { isOscExcluded, runWithOscExclude };
