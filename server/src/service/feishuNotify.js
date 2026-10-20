const axios = require('axios');

// ========== 配置项 ==========
const WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/107cc21e-c391-426a-b3f2-052091cc3883";
// ============================

// 通用发送飞书交互卡片（card 已按 schema 2.0 组装）
async function sendFeishuCard(card) {
  const payload = {
    msg_type: "interactive",
    card,
  };
  try {
    const res = await axios.post(WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
    });
    return { success: true, data: res.data };
  } catch (err) {
    console.error("❌飞书卡片发送失败：", err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// 发送纯文本消息（msg_type: text）
async function sendFeishuText(content) {
  const payload = {
    msg_type: "text",
    content: { text: content },
  };
  try {
    const res = await axios.post(WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
    });
    return { success: true, data: res.data };
  } catch (err) {
    console.error("❌飞书文本消息发送失败：", err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

// 构建盘中市场快照纯文本消息：纯罗列数据
// 资金：xxx、成交量：xxx、创业指数：xxx、科创指数：xxx、科技情绪：xxx
function buildMarketSnapshotText({ mainMoney, amountChangeDiff, chuangyeban, kechuangban, techEmotion }) {
  const formatIndex = (item) => {
    if (!item || item.close_px == null || isNaN(item.close_px)) return '--';
    let text = `${Number(item.close_px).toFixed(2)}`;
    if (item.change != null && !isNaN(item.change)) {
      const p = Number(item.change);
      text += `(${p > 0 ? '+' : ''}${p.toFixed(2)}%)`;
    }
    return text;
  };

  const emotionText = (techEmotion !== null && techEmotion !== undefined && !isNaN(Number(techEmotion)))
    ? `${Number(techEmotion) > 0 ? '+' : ''}${Number(techEmotion).toFixed(2)}`
    : '--';

  return `资金：${mainMoney || '--'}、成交量：${amountChangeDiff || '--'}、创业指数：${formatIndex(chuangyeban)}、科创指数：${formatIndex(kechuangban)}、科技情绪：${emotionText}`;
}

// 买点诊断卡片：绿色主题，列出「开盘实战」页自选股 3 日涨幅榜前三，并点出其中的买点候选
//   mock=true 时为调试面板触发的 MOCK 测试卡片，卡片中额外标注说明
//   positionHint：买入仓位提示（与回测仓位管理一致的口径）
function buildBuyPointCard({ buyStocks, topStocks, timestamp, mock, positionHint }) {
  const list = Array.isArray(buyStocks) ? buyStocks : (Array.isArray(topStocks) ? topStocks : []);
  const fmtPct = (v) => (v == null || isNaN(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const elements = [
    {
      tag: "markdown",
      content: `**🎯【买点诊断】命中买点**\n> ${timestamp || '--'}`,
    },
  ];
  if (mock) {
    elements.push({ tag: "markdown", content: "**🧪【MOCK 测试卡片】本条为调试用途，非实盘信号**" });
  }
  elements.push({ tag: "hr" });
  if (positionHint) {
    elements.push({ tag: "markdown", content: `**📦 建议买入仓位：${positionHint}**` });
  }

  if (list.length === 0) {
    elements.push({ tag: "markdown", content: "当前自选股 3 日涨幅榜无可展示标的（创业板指 / 科创50 均不满足买点门槛）。" });
  } else {
    elements.push({ tag: "markdown", content: "**自选股 3 日涨幅榜前三**（与开盘实战页榜单一致）" });
    list.forEach((s, i) => {
      const resilience = (s.resilienceScore == null || isNaN(Number(s.resilienceScore)))
        ? '--'
        : Number(s.resilienceScore).toFixed(2);
      const candidateTag = s.isCandidate ? '　🎯**买点候选**' : '';
      elements.push({
        tag: "div",
        fields: [
          { is_short: true, text: { tag: "lark_md", content: `**${i + 1}. ${s.stockName || '--'}**（${s.code || '--'}）${candidateTag}` } },
          { is_short: true, text: { tag: "lark_md", content: `市场：${s.market || '--'}` } },
          { is_short: true, text: { tag: "lark_md", content: `当日：${fmtPct(s.change)}` } },
          { is_short: true, text: { tag: "lark_md", content: `3日：${fmtPct(s.change3d)}　抗分歧：${resilience}` } },
        ],
      });
    });
    if (list.some((s) => s.isCandidate)) {
      elements.push({ tag: "markdown", content: "**🎯 买点候选：榜单内满足买点资格且未封涨停的标的。**" });
    }
  }

  elements.push({
    tag: "markdown",
    content: "**分仓管理是最后一道防火墙，谨防尾盘大盘跳水。**",
  });

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: { tag: "plain_text", content: mock ? "🔔 买点诊断触发提醒（MOCK 测试）" : "🔔 买点诊断触发提醒" },
    },
    body: { elements },
  };
}

// 情绪游资-极致胜率买点卡片：绿色主题，列出「情绪游资-龙头列表」中的完整买点标的
//   positionHint：买入仓位提示（顺周期腿半仓，与回测双腿结构一致）
function buildHotMoneyLeaderCard({ buyStocks, timestamp, positionHint }) {
  const list = Array.isArray(buyStocks) ? buyStocks : [];
  const fmtPct = (v) => (v == null || isNaN(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const fmtNum = (v) => (v == null || isNaN(Number(v)) ? '--' : Number(v).toFixed(2));
  const elements = [
    {
      tag: "markdown",
      content: `**🎯【情绪游资-极致胜率】龙头列表出现完整买点标的**\n> ${timestamp || '--'}`,
    },
    {
      tag: "hr",
    },
  ];
  if (positionHint) {
    elements.push({ tag: "markdown", content: `**📦 建议买入仓位：${positionHint}**` });
  }

  if (list.length === 0) {
    elements.push({ tag: "markdown", content: "龙头列表当前无完整买点标的。" });
  } else {
    elements.push({ tag: "markdown", content: "**情绪游资-龙头列表 · 完整买点标的**（强度分 − 差劲分 ≥ 30 且上证 3 日线斜率为正、未封涨停）" });
    list.forEach((s, i) => {
      elements.push({
        tag: "div",
        fields: [
          { is_short: true, text: { tag: "lark_md", content: `**${i + 1}. ${s.stockName || s.name || '--'}**（${s.code || '--'}）🎯**买点触发**` } },
          { is_short: true, text: { tag: "lark_md", content: `连板：${s.lianbanCount != null ? `${s.lianbanCount} 连板` : '--'}` } },
          { is_short: true, text: { tag: "lark_md", content: `当日：${fmtPct(s.change)}` } },
          { is_short: true, text: { tag: "lark_md", content: `强度−差劲：${fmtNum(s.delta)}` } },
        ],
      });
    });
  }

  elements.push({
    tag: "markdown",
    content: "**分仓管理是最后一道防火墙，谨防尾盘大盘跳水。**",
  });

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "🔔 情绪游资-极致胜率 买点触发提醒" },
    },
    body: { elements },
  };
}

// 情绪游资-反向抱团龙头（逆周期）买点卡片：红色主题，列出反向抱团池中已触发择时的买点标的
//   positionHint：买入仓位提示（逆周期腿半仓，与回测双腿结构一致）
function buildHotMoneyReverseLeaderCard({ buyStocks, timing, timestamp, positionHint }) {
  const list = Array.isArray(buyStocks) ? buyStocks : [];
  const fmtPct = (v) => (v == null || isNaN(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const fmtNum = (v) => (v == null || isNaN(Number(v)) ? '--' : Number(v).toFixed(2));
  const elements = [
    {
      tag: "markdown",
      content: `**🎯【情绪游资-反向抱团龙头】逆周期择时触发反向抱团买点**\n> ${timestamp || '--'}`,
    },
    {
      tag: "hr",
    },
  ];
  if (positionHint) {
    elements.push({ tag: "markdown", content: `**📦 建议买入仓位：${positionHint}**` });
  }

  if (timing) {
    const slopeText = timing.slopeClose == null ? '--' : fmtNum(timing.slopeClose);
    const dayText = timing.daysSinceTurnNeg == null ? '--' : `连续为负第 ${timing.daysSinceTurnNeg + 1} 天`;
    elements.push({
      tag: "markdown",
      content: `**大盘择时**：上证 3 日线斜率（收盘口径）${slopeText}，${dayText}；当日上证跌幅 ${fmtPct(timing.indexChange)}（门槛 ≤ ${timing.indexDropPct != null ? timing.indexDropPct : -0.5}%）`,
    });
  }

  if (list.length === 0) {
    elements.push({ tag: "markdown", content: "反向抱团池当前无已触发买点标的。" });
  } else {
    elements.push({ tag: "markdown", content: "**反向抱团池 · 逆周期买点标的**（窗口内盘中强度分累计命中第 2 次且未封涨停）" });
    list.forEach((s, i) => {
      elements.push({
        tag: "div",
        fields: [
          { is_short: true, text: { tag: "lark_md", content: `**${i + 1}. ${s.stockName || s.name || '--'}**（${s.code || '--'}）🎯**逆周期买点触发**` } },
          { is_short: true, text: { tag: "lark_md", content: `连板：${s.lianbanCount != null ? `${s.lianbanCount} 连板` : '--'}` } },
          { is_short: true, text: { tag: "lark_md", content: `当日：${fmtPct(s.change)}` } },
          { is_short: true, text: { tag: "lark_md", content: `强度分：${fmtNum(s.strengthScore)}（命中 ${s.hitCount != null ? s.hitCount : '--'} 次）` } },
        ],
      });
    });
  }

  elements.push({
    tag: "markdown",
    content: "**逆周期反向抱团为左侧博弈，波动更大，务必控制仓位、严守止损。**",
  });

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "red",
      title: { tag: "plain_text", content: "🔔 情绪游资-反向抱团龙头 买点触发提醒" },
    },
    body: { elements },
  };
}

// 卖点诊断卡片：红色主题，列出每个触发卖点的持仓股及触发原因
//   mock=true 时为调试面板触发的 MOCK 测试卡片，卡片中额外标注说明
function buildSellPointCard({ sellStocks, timestamp, mock }) {
  const elements = [
    {
      tag: "markdown",
      content: `**⚠️【卖点诊断】以下持仓已触发卖出条件**\n> ${timestamp || '--'}`,
    },
  ];
  if (mock) {
    elements.push({ tag: "markdown", content: "**🧪【MOCK 测试卡片】本条为调试用途，非实盘信号**" });
  }
  elements.push({ tag: "hr" });

  (sellStocks || []).forEach((s, i) => {
    const reasons = (s.reasons || []).join('\n');
    elements.push({
      tag: "div",
      fields: [
        {
          is_short: false,
          text: {
            tag: "lark_md",
            content: `**${i + 1}. ${s.stockName || '--'}（${s.code || '--'}）**\n现价：${s.closePrice ?? '--'}　触发条件：\n${reasons || '--'}`,
          },
        },
      ],
    });
  });

  elements.push({
    tag: "markdown",
    content: "**请及时关注并考虑减仓或卖出。**",
  });

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "red",
      title: { tag: "plain_text", content: mock ? "⚠️ 卖点诊断触发提醒（MOCK 测试）" : "⚠️ 卖点诊断触发提醒" },
    },
    body: { elements },
  };
}

module.exports = { sendFeishuCard, sendFeishuText, buildBuyPointCard, buildHotMoneyLeaderCard, buildHotMoneyReverseLeaderCard, buildSellPointCard, buildMarketSnapshotText };