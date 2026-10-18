// 调试面板 MOCK 服务：手动触发「买点 / 卖点」命中，走与实盘一致的推送 + 飞书链路
//   - 绕过 10s ticker 的 5 分钟桶门控，点击即刻推送
//   - 飞书卡片额外标注【MOCK 测试卡片】
const dayjs = require('dayjs');
const { getMonitorStocks } = require('./monitorStock');
const { getStockPositions } = require('./stockPosition');
const strategyModeState = require('./strategyModeState');
const wsServer = require('../wsServer');
const feishuNotify = require('./feishuNotify');

const MOCK_TAG = '【MOCK 测试】';

const pickRandom = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);
const fmtNow = () => dayjs().format('YYYY-MM-DD HH:mm:ss');

// MOCK 买点：从全量自选股随机取一只，判定命中买点，推送 WS（open:true）+ 发送飞书
const mockBuyPoint = async () => {
  const stocks = getMonitorStocks() || [];
  const target = pickRandom(stocks);
  if (!target) return { success: false, error: '自选股为空，无法 mock' };

  const mode = strategyModeState.getMode();
  const timestamp = fmtNow();
  const data = {
    allPassed: true,
    checks: [{
      id: 'mock',
      title: `${MOCK_TAG}调试触发：${target.name}（${target.code}）模拟买点全部前置条件通过`,
      passed: true,
      value: '--',
      reason: '调试面板手动触发',
    }],
    reverseChecks: [],
    conclusion: `${MOCK_TAG}调试触发：${target.name}（${target.code}）模拟命中买点诊断`,
    timestamp,
    // buyable 仅用于 MOCK：让前端弹窗直接展示本次随机命中的标的（实盘数据无此字段，不影响线上）
    buyable: [{
      code: target.code,
      stockName: target.name,
      name: target.name,
      market: 'MOCK',
      change: null,
      change3d: null,
      resilienceScore: null,
    }],
  };

  wsServer.broadcast({ type: 'buy_point', mode, bucket: null, ts: Date.now(), data, open: true });

  let feishu;
  try {
    const card = feishuNotify.buildBuyPointCard({
      buyStocks: [{
        stockName: target.name,
        code: target.code,
        market: 'MOCK',
        change: null,
        change3d: null,
        resilienceScore: null,
        isCandidate: true,
      }],
      timestamp,
      mock: true,
    });
    feishu = await feishuNotify.sendFeishuCard(card);
  } catch (e) {
    feishu = { success: false, error: e.message };
  }

  return { success: true, target: { code: target.code, name: target.name }, mode, feishu };
};

// MOCK 卖点：优先从当前持仓随机取一仓，无持仓则从全量自选股随机取一只；推送 WS（open:true）+ 发送飞书
const mockSellPoint = async () => {
  const positions = getStockPositions() || [];
  const stocks = getMonitorStocks() || [];
  const position = positions.length ? pickRandom(positions) : null;
  const fallbackStock = position ? null : pickRandom(stocks);
  if (!position && !fallbackStock) return { success: false, error: '持仓与自选股均为空，无法 mock' };

  const mode = strategyModeState.getMode();
  const timestamp = fmtNow();

  const hit = position
    ? {
        positionId: position.id || position.code,
        code: position.code,
        stockName: position.name,
        weight: position.weight != null ? position.weight : null,
        buyDate: position.buyDate || null,
        buyTime: position.buyTime || null,
        costPrice: position.costPrice != null && Number.isFinite(Number(position.costPrice)) ? Number(position.costPrice) : null,
        isSell: true,
        reasons: [`${MOCK_TAG}调试触发：模拟卖点条件命中（持仓诊断）`],
        conditions: [{ id: 'mock', title: `${MOCK_TAG}模拟卖点条件命中`, passed: true, value: '--', reason: '调试面板手动触发' }],
        detail: { closePrice: null, change: null },
        conclusion: `${MOCK_TAG}调试触发：${position.name}（${position.code}）模拟命中卖点诊断`,
      }
    : {
        positionId: fallbackStock.code,
        code: fallbackStock.code,
        stockName: fallbackStock.name,
        weight: 25,
        buyDate: null,
        buyTime: null,
        costPrice: null,
        isSell: true,
        reasons: [`${MOCK_TAG}调试触发：模拟卖点条件命中（当前无持仓，取自选股）`],
        conditions: [{ id: 'mock', title: `${MOCK_TAG}模拟卖点条件命中`, passed: true, value: '--', reason: '调试面板手动触发' }],
        detail: { closePrice: null, change: null },
        conclusion: `${MOCK_TAG}调试触发：${fallbackStock.name}（${fallbackStock.code}）模拟命中卖点诊断`,
      };

  wsServer.broadcast({
    type: 'sell_point',
    mode,
    bucket: null,
    ts: Date.now(),
    data: { results: [hit], hitCount: 1, total: 1 },
    open: true,
  });

  let feishu;
  try {
    const card = feishuNotify.buildSellPointCard({
      sellStocks: [{
        stockName: hit.stockName,
        code: hit.code,
        weight: hit.weight,
        buyDate: hit.buyDate,
        buyTime: hit.buyTime,
        costPrice: hit.costPrice,
        reasons: hit.reasons,
        closePrice: hit.detail.closePrice,
      }],
      timestamp,
      mock: true,
    });
    feishu = await feishuNotify.sendFeishuCard(card);
  } catch (e) {
    feishu = { success: false, error: e.message };
  }

  return {
    success: true,
    target: { code: hit.code, name: hit.stockName },
    source: position ? 'position' : 'watchlist',
    mode,
    feishu,
  };
};

module.exports = { mockBuyPoint, mockSellPoint };
