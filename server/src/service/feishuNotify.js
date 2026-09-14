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

// 买点诊断卡片：绿色主题，附前三日涨幅最大前三名股票
function buildBuyPointCard({ topStocks, conclusion, timestamp }) {
  const elements = [
    {
      tag: "markdown",
      content: `**🎯【买点诊断】已命中，当前可择机买入**\n${conclusion || ''}\n> ${timestamp || '--'}`,
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

module.exports = { sendFeishuCard, buildBuyPointCard, buildSellPointCard };