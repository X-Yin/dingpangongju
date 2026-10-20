// 买点诊断飞书卡片：构建并发送
//   - 从 index.js 的 /send_feishu_card 路由抽出（该路由保留给卖点与手动调用）
//   - 后端集中诊断（buyPointPushService）在命中且进入新 5 分钟桶时调用本函数发送
//   - 攻防兼备（attack_defense）模式由 buyPointPushService 按 source='tech'/'ew' 分源调用，
//     两策略同桶都命中时各发一张卡片
const dayjs = require('dayjs');
const feishuNotify = require('./feishuNotify');
const { getHotMoneyLeaderList, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE } = require('./hotMoneyExtremeWin');
const { getTopGainersByMarket, checkEmoQuickOutDay } = require('./buySellDiagnose');

// 科技进攻（快进快出）仓位提示：与回测 fusedEmoWinBacktest 的 A 风格仓位管理完全一致——
//   快进快出日 → 首次半仓 50%，次日买点再次触发补足第二份半仓，该笔次日 10:00 强卖；
//   普通买入日 → 全仓 100%
const buildTechPositionHint = (mode) => {
  let hint;
  try {
    const quickOut = checkEmoQuickOutDay(dayjs().format('YYYYMMDD'))?.quickOut === true;
    hint = quickOut
      ? '半仓（50%）——快进快出日：首次买入半仓，次日买点再次触发时补足第二份半仓，该笔次日 10:00 强卖'
      : '全仓（100%）——普通买入日';
  } catch (e) {
    hint = '全仓（100%）——普通买入日';
  }
  if (mode === MODE_ATTACK_DEFENSE) {
    hint += '；攻防兼备模式下两策略同时触发时科技进攻（快进快出）优先';
  }
  return hint;
};

// 情绪游资-极致胜率仓位提示：与回测 B 风格双腿结构一致——顺周期、逆周期各半仓 50%
const buildEwPositionHint = (mode) => {
  let hint = '半仓（50%）——情绪游资为双腿结构，顺周期、逆周期各半仓';
  if (mode === MODE_ATTACK_DEFENSE) {
    hint += '；若科技进攻（快进快出）同时触发则其优先，本笔情绪游资暂缓，待上一笔完全结束后再考虑';
  }
  return hint;
};

// 构建并发送买点飞书卡片
// @param {Object} opts
//   mode       : 全局策略模式
//   source     : 攻防兼备模式下的命中源——'tech'（科技进攻）/ 'ew'（情绪游资）；单模式无需传
//   buyStocks  : 可选，直接指定卡片标的（优先）
//   topStocks  : 可选，指定科技进攻榜单前三
// @returns {Object} { success, skipped?, message?, data?, error? }
const notifyBuyPointFeishu = async ({ mode, source = null, buyStocks = null, topStocks = null } = {}) => {
  let card = null;

  const isEwSource = source === 'ew' || (!source && mode === MODE_EXTREME_WIN);

  if (isEwSource) {
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
    const ewPositionHint = buildEwPositionHint(mode);
    if (resultStocks && resultStocks.length > 0) {
      card = feishuNotify.buildHotMoneyLeaderCard({
        buyStocks: resultStocks,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        positionHint: ewPositionHint,
      });
    } else {
      card = feishuNotify.buildHotMoneyReverseLeaderCard({
        buyStocks: reverseStocks,
        timing: reverseTiming,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        positionHint: ewPositionHint,
      });
    }
  } else {
    // 买点卡片（科技进攻）：优先使用传入的标的；未传入时与「开盘实战」页自选股 3 日涨幅榜同源，
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
      positionHint: buildTechPositionHint(mode),
    });
  }

  return feishuNotify.sendFeishuCard(card);
};

module.exports = { notifyBuyPointFeishu };
