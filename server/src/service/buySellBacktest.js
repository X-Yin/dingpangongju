// 门面（Facade）：回测服务已按策略维度拆分到 ./buySellBacktest/ 目录。
// 本文件仅保留既有 require 路径与对外导出契约，实现见 ./buySellBacktest/index.js。
module.exports = require('./buySellBacktest/index');