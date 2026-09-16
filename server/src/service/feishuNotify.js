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

// 买点诊断卡片：绿色主题，附前三日涨幅最大前三名股票
function buildBuyPointCard({ topStocks, timestamp }) {
  const elements = [
    {
      tag: "markdown",
      content: `**🎯【买点诊断】近3日涨幅排名前三**\n> ${timestamp || '--'}`,
    },
    {
      tag: "hr",
    },
    {
      tag: "div",
      fields: [
        { is_short: true, text: { tag: "lark_md", content: "**排名**" } },
        { is_short: true, text: { tag: "lark_md", content: "**近3日涨幅最大个股**" } },
      ],
    },
  ];

  const list = (topStocks || []).slice(0, 3).map((s, i) => ({
    tag: "div",
    fields: [
      { is_short: true, text: { tag: "lark_md", content: `**TOP${i + 1}**` } },
      {
        is_short: true,
        text: {
          tag: "lark_md",
          content: `**${s.stockName || '--'}**（${s.code || '--'}）\n近3日涨幅：${s.change3d == null ? '--' : `${s.change3d > 0 ? '+' : ''}${Number(s.change3d).toFixed(2)}%`}`,
        },
      },
    ],
  }));
  elements.push(...list);

  elements.push({
    tag: "markdown",
    content: "**分仓管理是最后一道防火墙，谨防尾盘大盘跳水。**",
  });

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "🔔 买点诊断触发提醒" },
    },
    body: { elements },
  };
}

// 卖点诊断卡片：红色主题，列出每个触发卖点的持仓股及触发原因
function buildSellPointCard({ sellStocks, timestamp }) {
  const elements = [
    {
      tag: "markdown",
      content: `**⚠️【卖点诊断】以下持仓已触发卖出条件**\n> ${timestamp || '--'}`,
    },
    {
      tag: "hr",
    },
  ];

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
      title: { tag: "plain_text", content: "⚠️ 卖点诊断触发提醒" },
    },
    body: { elements },
  };
}

// 盘中市场快照卡片：资金净流入与成交量数据放在最前，随后是指数与科技情绪
module.exports = { sendFeishuCard, sendFeishuText, buildBuyPointCard, buildSellPointCard, buildMarketSnapshotText };