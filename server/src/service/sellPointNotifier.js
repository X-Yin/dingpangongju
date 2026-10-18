// 卖点诊断飞书卡片：构建并发送（由后端集中诊断 sellPointPushService 调用）
//   - 前端不再触发卖点飞书（改造前由 FloatingStockPosition 前端轮询后调用 /send_feishu_card）
//   - 仅在存在命中持仓时发送；无命中返回 { success: true, skipped: true }
const dayjs = require('dayjs');
const feishuNotify = require('./feishuNotify');

// 将卖点诊断结果（命中）映射为卡片标的；口径与改造前前端一致
const buildSellStocks = (hitResults = []) => (hitResults || []).map((r) => ({
  stockName: r.stockName,
  code: r.code,
  weight: r.weight,
  buyDate: r.buyDate,
  buyTime: r.buyTime,
  costPrice: r.costPrice,
  reasons: r.reasons || [],
  closePrice: r.detail?.closePrice,
}));

// 构建并发送卖点飞书卡片
// @param {Object} opts
//   hitResults : 命中卖点的持仓诊断结果数组（必填）
// @returns {Object} { success, skipped?, message?, data?, error? }
const notifySellPointFeishu = async ({ hitResults } = {}) => {
  const sellStocks = buildSellStocks(hitResults);
  if (sellStocks.length === 0) {
    return { success: true, skipped: true, message: '当前无卖点命中，不发送通知' };
  }
  const card = feishuNotify.buildSellPointCard({
    sellStocks,
    timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
  });
  return feishuNotify.sendFeishuCard(card);
};

module.exports = { notifySellPointFeishu, buildSellStocks };
