// 买点诊断飞书卡片：构建并发送
//   - 从 index.js 的 /send_feishu_card 路由抽出（该路由保留给卖点与手动调用）
//   - 后端集中诊断（buyPointPushService）在命中且进入新 5 分钟桶时调用本函数发送
const dayjs = require('dayjs');
const feishuNotify = require('./feishuNotify');
const { getHotMoneyLeaderList, MODE_EXTREME_WIN } = require('./hotMoneyExtremeWin');
const { getTopGainersByMarket } = require('./buySellDiagnose');

// 构建并发送买点飞书卡片
// @param {Object} opts
//   mode       : 全局策略模式
//   buyStocks  : 可选，直接指定卡片标的（优先）
//   topStocks  : 可选，指定科技进攻榜单前三
// @returns {Object} { success, skipped?, message?, data?, error? }
const notifyBuyPointFeishu = async ({ mode, buyStocks = null, topStocks = null } = {}) => {
  let card = null;

  if (mode === MODE_EXTREME_WIN) {
    // 情绪游资-极致胜率：优先推「完整买点股」（同时满足 delta ≥ 30 且上证 3 日线斜率 > 0，且未封涨停）；
    // 无完整买点股时，若逆周期（反向抱团）择时已触发，则改推「反向抱团买点股」；两者都无则不推
    let resultStocks = Array.isArray(buyStocks) && buyStocks.length > 0 ? buyStocks : null;
    let reverseTiming = null;
    let reverseStocks = [];
    if (!resultStocks) {
      const listRes = await getHotMoneyLeaderList(null, 50);
      const stocks = listRes?.data?.stocks || [];
      resultStocks = stocks.filter((s) => s.buyPointHit && !s.isLimitUp).slice(0, 3);
      if (resultStocks.length === 0) {
        const rev = listRes?.data?.reverse || null;
        if (rev) {
          reverseStocks = (rev.stocks || []).filter((s) => s.timingPassed).slice(0, 3);
          if (reverseStocks.length > 0) reverseTiming = rev;
        }
      }
    }
    if ((!resultStocks || resultStocks.length === 0) && reverseStocks.length === 0) {
      return { success: true, skipped: true, message: '当前无完整买点标的，不发送通知' };
    }
    if (resultStocks && resultStocks.length > 0) {
      card = feishuNotify.buildHotMoneyLeaderCard({
        buyStocks: resultStocks,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      });
    } else {
      card = feishuNotify.buildHotMoneyReverseLeaderCard({
        buyStocks: reverseStocks,
        timing: reverseTiming,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      });
    }
  } else {
    // 买点卡片：优先使用传入的标的；未传入时与「开盘实战」页自选股 3 日涨幅榜同源，
    // 严格取榜单前三，并点出其中的买点候选（榜单内首个满足买点资格且未封涨停的标的）
    let resultStocks = Array.isArray(buyStocks) && buyStocks.length > 0
      ? buyStocks
      : (Array.isArray(topStocks) && topStocks.length > 0 ? topStocks : null);
    if (!resultStocks) {
      const gainers = await getTopGainersByMarket(null, 10);
      const d = gainers?.data || {};
      const cybPassed = d.cybGate?.passed === true;
      const starPassed = d.starGate?.passed === true;
      // 仅纳入满足买点门槛的市场，按 3 日涨幅降序合并前十（与前端 mergedList 口径完全一致）
      const merged = [
        ...(cybPassed ? (d.markets?.cybMain || []) : []),
        ...(starPassed ? (d.markets?.star || []) : []),
      ].sort((a, b) => (b.change3d ?? -Infinity) - (a.change3d ?? -Infinity)).slice(0, 10);
      const toRow = (s) => ({
        stockName: s.stockName,
        code: s.code,
        market: s.isSh688 ? '科创板' : '创业板/主板',
        change: s.change,
        change3d: s.change3d,
        resilienceScore: s.resilienceScore,
      });
      // 买点候选：与前端 globalPick 一致，榜单内首个满足买点资格且未封涨停的标的
      const candidate = merged.find((s) => s.matchesBuyPoint && !s.isLimitUp) || null;
      const top3 = merged.slice(0, 3);
      resultStocks = top3.map((s) => ({
        ...toRow(s),
        isCandidate: candidate != null && s.code === candidate.code,
      }));
      // 候选不在前三时补一行，保证买点候选始终被点出
      if (candidate && !top3.some((s) => s.code === candidate.code)) {
        resultStocks.push({ ...toRow(candidate), isCandidate: true });
      }
    }
    card = feishuNotify.buildBuyPointCard({
      buyStocks: resultStocks,
      timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    });
  }

  return feishuNotify.sendFeishuCard(card);
};

module.exports = { notifyBuyPointFeishu };
