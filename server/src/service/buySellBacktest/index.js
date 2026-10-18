// 训练营 - 买卖点历史回测（拆分后的聚合入口，对外符号契约与原单文件保持一致）
const { runRangeBacktest } = require('./engine/rangeBacktest');
const { runRangeBacktestMulti } = require('./engine/rangeBacktestMulti');
const {
  STRATEGIES,
  GLOBAL_RESILIENCE_MIN,
  BUY_TIME_MAX_MINUTE,
} = require('./strategies/registry');
const {
  readCachedBacktest,
  writeCachedBacktest,
  attachHoldingDays,
  attachBuyDayReturn,
  sortTradesByBuyTime,
} = require('./utils/tradeStats');
const { loadReportIndex, sumReportCount, getStockRecentReports } = require('./utils/reportIndex');
const { getTechEmotionEmaMap, getTechEmotionRawMap, getTechIndexDates } = require('./utils/techEmotion');
const {
  queryLiveIndexGate,
  codeToGateIndex,
  gateIndexName,
  CYB_INDEX_CODE,
  STAR_INDEX_CODE,
} = require('./engine/indexGate');

module.exports = {
  runRangeBacktest,
  runRangeBacktestMulti,
  STRATEGIES,
  readCachedBacktest,
  writeCachedBacktest,
  attachHoldingDays,
  attachBuyDayReturn, // 「买入当日收益」补写（供缓存读取路由为历史缓存补字段）
  sortTradesByBuyTime, // 供回测报告读取旧快照时统一按买入时间排序
  loadReportIndex,
  sumReportCount,
  getStockRecentReports,
  getTechEmotionEmaMap,
  getTechEmotionRawMap, // 供 buySellDiagnose 线上卖点诊断条件8/买点提示按当日科技情绪原始分判定快进快出
  getTechIndexDates, // 供 backtest-worker 对三日情绪冰点日期范围（含缺资金快照日期）做兜底预构建
  queryLiveIndexGate, // 无状态实时门禁查询（供前端 /api/index-slope-gate 使用）
  codeToGateIndex,    // 供 buySellDiagnose 的 getSingleStockBuyPointDiagnosis 复用
  gateIndexName,      // 供 buySellDiagnose 里生成可读标签
  CYB_INDEX_CODE,
  STAR_INDEX_CODE,
  GLOBAL_RESILIENCE_MIN, // 全局最低抗分歧门槛（供 buySellDiagnose 复用，此前未导出导致比较恒为 false）
  BUY_TIME_MAX_MINUTE,   // 买入时段门禁上限 13:30（供 buySellDiagnose 复用，此前未导出导致门禁恒不通过）
};