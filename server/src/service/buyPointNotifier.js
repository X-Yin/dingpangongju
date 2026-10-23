// 买点诊断飞书卡片：构建并发送
//   - 从 index.js 的 /send_feishu_card 路由抽出（该路由保留给卖点与手动调用）
//   - 后端集中诊断（buyPointPushService）在命中且进入新 5 分钟桶时调用本函数发送
//   - 攻防兼备（attack_defense）模式由 buyPointPushService 按 source='tech'/'ew' 分源调用，
//     两策略同桶都命中时各发一张卡片
const dayjs = require('dayjs');
const feishuNotify = require('./feishuNotify');
const { getHotMoneyLeaderList, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE } = require('./hotMoneyExtremeWin');
const { getTopGainersByMarket, checkEmoQuickOutDay } = require('./buySellDiagnose');
const { getStockPositions } = require('./stockPosition');
const { isTechWatchlistStock } = require('./monitorStock');
const { getTechEmotionIntraday } = require('./emotion');
const { getTechHalfPositionState, isGateRaised } = require('./emoQuickFundGateLive');

// 科技进攻（快进快出）仓位提示：与回测 fusedEmoWinBacktest 的 A 风格仓位管理完全一致——
//   快进快出日 → 首次半仓 50%，次日买点再次触发补足第二份半仓，该笔次日 10:00 强卖；
//   普通买入日 → 全仓 100%；
//   「30 亿抬高态强制两次买入」（2026-10-21 用户新增线上同步）：资金净流入阈值处于抬高态 30 亿时，
//   首次建仓不分快进快出情形一律只买半仓（第一份 5 成），剩余半仓等后续交易日买点再次触发时补买
//   （第二份 5 成，不能与第一份同一天买入，补买资金净流入诊断阈值降为基准 20 亿）；
//   已持第一份半仓时提示补买第二份，已持全仓/两份腿时提示本次不买入
const buildTechPositionHint = (mode) => {
  let hint;
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const quickOut = checkEmoQuickOutDay(dayjs().format('YYYYMMDD'))?.quickOut === true;
    const legState = getTechHalfPositionState();
    const firstLeg = legState.positions[0] || null;
    if (legState.count === 1 && firstLeg) {
      // 已持第一份半仓：提示补买第二份（不能与第一份同一天买入，对应回测 dateStr > buyDate 约束）
      if (firstLeg.buyDate === today) {
        hint = `本次不买入——今日已买第一份半仓 **${firstLeg.name}**（${firstLeg.code}），两份仓位不能同一天买入，剩余半仓等后续交易日买点再次触发时补买（补买资金净流入阈值降为 20 亿）`;
      } else {
        hint = `半仓（50%）——补买第二份：已持第一份半仓 **${firstLeg.name}**（${firstLeg.code}，${firstLeg.buyDate} 买入），本次买入剩余半仓 5 成（资金净流入诊断阈值降为基准 20 亿）${quickOut ? '；今日为快进快出日，本份买入后次日 10:00 强卖' : ''}`;
      }
    } else if (legState.techCount > 0) {
      // 已持全仓 / 两份腿：该笔未完全结束前不再买入（与回测单持仓规则一致）
      const listText = legState.techHoldings.map((p) => `**${p.name}**（${p.code}，仓位 ${p.weight}%）`).join('、');
      hint = `本次不买入——已持有科技进攻持仓：${listText}，待该笔完全平仓后再考虑下一次买入`;
    } else if (quickOut) {
      hint = '半仓（50%）——快进快出日：首次买入半仓，次日买点再次触发时补足第二份半仓，该笔次日 10:00 强卖';
    } else if (isGateRaised()) {
      hint = '半仓（50%）——资金净流入阈值处于抬高态 30 亿，强制两次买入：本次仅买第一份 5 成，剩余半仓等后续交易日买点再次触发时补买（补买阈值降为 20 亿，且不能与第一份同一天买入）';
    } else {
      hint = '全仓（100%）——普通买入日';
    }
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

// ---------- 攻防兼备·持仓联动提醒（2026-10-20 用户新增，与回测「科技进攻-情绪游资极致胜率」规则一致） ----------

// 持仓科技属性分类：自选股中的科技股（isTechWatchlistStock，isTech !== false）视为科技持仓，
// 其余（自选非科技 / 不在自选股）视为非科技持仓——与两风格候选池口径一致：
// 科技进攻（快进快出）只买自选科技股，情绪游资-极致胜率候选池剔除自选科技股（持仓均为非科技连板股）
const classifyHoldingsByTech = () => {
  const tech = [];
  const nonTech = [];
  for (const p of getStockPositions()) {
    const row = { code: p.code, name: p.name, buyDate: p.buyDate || null, weight: p.weight != null ? p.weight : 50 };
    (isTechWatchlistStock(p.code) ? tech : nonTech).push(row);
  }
  return { tech, nonTech };
};

// 当前实时科技情绪指数（分时最后一点，与买点诊断检查6同源；无数据返回 null）
const getCurrentTechEmotion = () => {
  try {
    const { data } = getTechEmotionIntraday();
    const records = data && data[dayjs().format('YYYYMMDD')];
    const last = Array.isArray(records) && records.length > 0 ? records[records.length - 1] : null;
    return last && typeof last.value === 'number' ? last.value : null;
  } catch (e) {
    return null;
  }
};

// 情况1·科技卡片「科技进攻抢仓」提醒：存在隔夜非科技连板持仓（买入日早于当日，即与本次科技买入不同日）、
// 且不存在当日买入的非科技持仓（存在则放弃抢仓——当日买入的保留不卖，同回测）、
// 且当前实时科技情绪 > 0（同回测「该桶实时科技情绪 > 0」门槛）时，提醒先卖出该持仓、再买入科技股；否则返回 null
const buildTechGrabWarn = () => {
  const { nonTech } = classifyHoldingsByTech();
  if (nonTech.length === 0) return null;
  const today = dayjs().format('YYYY-MM-DD');
  if (nonTech.some((p) => p.buyDate === today)) return null;
  const overnight = nonTech.filter((p) => p.buyDate && p.buyDate < today);
  if (overnight.length === 0) return null;
  const emotion = getCurrentTechEmotion();
  if (emotion == null || !(emotion > 0)) return null;
  const listText = overnight.map((p) => `**${p.name}**（${p.code}，买入日 ${p.buyDate}）`).join('、');
  return `**🔁 科技进攻抢仓提醒**：当前持有非科技连板持仓 ${listText}，请**先卖出上述持仓、再买入科技股**——与回测「科技进攻-情绪游资极致胜率」的科技进攻抢仓规则一致（科技买点触发 + 隔夜非科技持仓 + 当前实时科技情绪 ${Number(emotion).toFixed(2)} > 0）。`;
};

// 情况2·情绪游资卡片「仅提醒不买入」提示：当下已有科技股持仓时，连板股买点触发仅做提醒、
// 不执行买入（「科技进攻-情绪游资极致胜率」风格独占，科技持仓期间情绪游资不建仓）；无科技持仓返回 null
const buildEwHoldOnlyWarn = () => {
  const { tech } = classifyHoldingsByTech();
  if (tech.length === 0) return null;
  const listText = tech.map((p) => `**${p.name}**（${p.code}）`).join('、');
  return `**⚠️ 本条消息仅做提醒，不执行买入**：因为当下已经有科技股持仓：${listText}——「科技进攻-情绪游资极致胜率」为风格独占，科技持仓期间情绪游资（连板股）不建仓，待科技持仓全部平仓后恢复。`;
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
    // 攻防兼备（2026-10-20 用户新增）：当下已有科技股持仓时，连板股买点触发仅做提醒、不执行买入（与回测风格独占一致）
    const holdOnlyWarn = mode === MODE_ATTACK_DEFENSE ? buildEwHoldOnlyWarn() : null;
    if (resultStocks && resultStocks.length > 0) {
      card = feishuNotify.buildHotMoneyLeaderCard({
        buyStocks: resultStocks,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        positionHint: ewPositionHint,
        holdOnlyWarn,
      });
    } else {
      card = feishuNotify.buildHotMoneyReverseLeaderCard({
        buyStocks: reverseStocks,
        timing: reverseTiming,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        positionHint: ewPositionHint,
        holdOnlyWarn,
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
      // 归并：后端前十展示榜优先（已按门槛筛选市场、3 日涨幅降序），再补分市场明细（防止候选跌出前十），
      // 按 code 去重；候选只信任 isCandidate / pickCode，避免把过热、一字板个股当候选
      const mergedMap = new Map();
      for (const s of [
        ...(Array.isArray(d.mergedTop) ? d.mergedTop : []),
        ...(cybPassed ? (d.markets?.cybMain || []) : []),
        ...(starPassed ? (d.markets?.star || []) : []),
      ]) {
        if (s && s.code && !mergedMap.has(s.code)) mergedMap.set(s.code, s);
      }
      const merged = Array.from(mergedMap.values());
      const toRow = (s) => ({
        stockName: s.stockName,
        code: s.code,
        market: s.isSh688 ? '科创板' : '创业板/主板',
        change: s.change,
        change3d: s.change3d,
        resilienceScore: s.resilienceScore,
      });
      // 买点候选：后端已按「涨幅领先但当日爆发力不足」规则顺延后的唯一候选（pickCode）；
      // 缺省时只信任后端 isCandidate 标记，避免把过热/一字板个股当候选
      const candidate = d.pickCode
        ? (merged.find((s) => s.code === d.pickCode) || null)
        : (merged.find((s) => s.isCandidate) || null);
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
      // 攻防兼备（2026-10-20 用户新增）：存在隔夜非科技连板持仓且实时科技情绪 > 0 时，提醒先卖后买（与回测抢仓规则一致）
      grabWarn: mode === MODE_ATTACK_DEFENSE ? buildTechGrabWarn() : null,
    });
  }

  return feishuNotify.sendFeishuCard(card);
};

module.exports = { notifyBuyPointFeishu };
