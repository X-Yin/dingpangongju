// 随机模拟测试（random_sim）的随机股票注入上下文。
// 用 AsyncLocalStorage 隔离并发回测任务：每次随机模拟运行只影响自己那次执行链，
// 回测引擎在候选池组装处调用 isSimStock / getSimContext 把随机生成的股票混入候选池。
const { AsyncLocalStorage } = require('async_hooks');

const simStorage = new AsyncLocalStorage();

// 以指定随机股票集合运行一次回测（sim 为 { codeSet, codes, nameByCode } 或 null）
const runWithSimContext = (sim, fn) => simStorage.run(sim || null, fn);

// 取当前执行链上的随机股票集合（非随机模拟运行时返回 null）
const getSimContext = () => simStorage.getStore() || null;

// 判断某股票是否为本次随机模拟注入的合成股票（用于跳过自选股添加时间门禁等真实约束）
const isSimStock = (code) => {
  if (!code) return false;
  const sim = simStorage.getStore();
  return !!(sim && sim.codeSet && sim.codeSet.has(String(code)));
};

module.exports = { runWithSimContext, getSimContext, isSimStock };