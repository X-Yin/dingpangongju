const axios = require('axios');

// ========== 配置项 ==========
const WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/107cc21e-c391-426a-b3f2-052091cc3883";
const CARD_TITLE = "🚨【紧急告警】买点诊断";
const CARD_CONTENT = `**服务异常提醒**
业务检测到异常，请尽快处理
通知：<at id=all></at>`;
// ============================

async function sendFeishuCard() {
  const payload = {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "red", // red / blue / green / orange / gray
        title: {
          tag: "plain_text",
          content: CARD_TITLE
        }
      },
      body: {
        elements: [
          {
            // ✅ 修复点：body根元素tag改为 markdown
            tag: "markdown",
            content: CARD_CONTENT
          }
        ]
      }
    }
  };

  try {
    const res = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        "Content-Type": "application/json"
      }
    });
    console.log("✅发送成功：", res.data);
  } catch (err) {
    console.error("❌发送失败：", err.response?.data || err.message);
  }
}

sendFeishuCard();
