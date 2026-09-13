// AI 提供商统一封装：支持 DeepSeek、智谱 GLM、本地 Qwen2.5-3B 之间动态切换
// 切换方式：
//   1. 通过 /ai_provider 接口 POST 切换，配置持久化到 data/ai_settings.json
//   2. 修改下方 DEFAULT_PROVIDER 常量可调整默认引擎
// 切换后所有调用点（/api/zhipu_chat、aiPrediction 在线预测、历史探查）会自动使用对应提供商

const aiSettings = require('../service/aiSettings');

// 默认引擎（仅当 ai_settings.json 不存在或无效时使用）
const DEFAULT_PROVIDER = 'deepseek'; // 'deepseek' | 'zhipu' | 'qwen'

const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    apiKey: 'sk-8cd0476ed1324c57b835ed520a36fc0e',
    apiUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
  },
  zhipu: {
    name: '智谱',
    apiKey: '4838975859884e5195e58c2ad8af7e45.EtmZFUrw8bO0GbEr',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-5.2',
  },
  qwen: {
    name: '通义千问',
    apiKey: 'sk-ws-H.ELHPPIL.xY3y.MEQCIBfL1BqoO-J1JIjBM3HYFwYKwsr0PIWuzDHrCSlF-kKkAiByeq03dy9hdCs5Nzv3LVXE_AQQVDxW3fo7UTbMQQB9yw',
    // 使用 DashScope 的 OpenAI 兼容模式，与 DeepSeek/智谱保持同一套请求体格式
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-turbo',
  },
};

/**
 * 获取当前激活的引擎 key（运行时从 ai_settings.json 读取，支持热切换）
 */
function getActiveProviderKey() {
  try {
    return aiSettings.getProvider();
  } catch (e) {
    return DEFAULT_PROVIDER;
  }
}

function getActiveProvider() {
  const key = getActiveProviderKey();
  return PROVIDERS[key] || PROVIDERS[DEFAULT_PROVIDER];
}

function getHeaders() {
  const provider = getActiveProvider();
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${provider.apiKey}`,
  };
}

/**
 * 构建聊天补全请求体（自动适配 DeepSeek / 智谱 的参数格式）
 * @param {Object} opts
 * @param {Array} opts.messages - 消息列表
 * @param {number} [opts.temperature=0.8] - 温度
 * @param {boolean} [opts.stream=false] - 是否流式
 * @param {string} [opts.model] - 模型覆盖（不传则用 provider 默认模型）
 * @param {boolean|Object} [opts.thinking=false] - DeepSeek 思考模式：false=显式关闭，true=开启(低强度)，或传 { type: 'enabled' }
 * @param {Object} [opts.responseFormat] - 响应格式（仅 DeepSeek 生效）
 * @param {number} [opts.maxTokens=8192] - 最大 token 数（仅 DeepSeek 生效）
 */
function buildRequestBody({ messages, temperature, stream, model, thinking, responseFormat, maxTokens }) {
  const provider = getActiveProvider();
  const activeKey = getActiveProviderKey();
  const body = {
    model: model || provider.model,
    messages,
    temperature: temperature != null ? temperature : 0.8,
    stream: stream === true,
  };

  if (activeKey === 'deepseek') {
    // DeepSeek 专属参数
    body.response_format = responseFormat || { type: 'text' };
    body.max_tokens = maxTokens || 8192;
    body.stop = null;
    body.stream_options = null;
    body.top_p = 1;
    body.tools = null;
    body.tool_choice = 'none';
    body.logprobs = false;
    body.top_logprobs = null;
    // DeepSeek v4 模型默认开启思考模式，需显式关闭
    // thinking=false → { type: 'disabled' }，thinking=true → { type: 'enabled' } + reasoning_effort=low
    if (thinking && thinking !== false) {
      body.thinking = thinking === true ? { type: 'enabled' } : thinking;
      body.reasoning_effort = 'low';
    } else {
      body.thinking = { type: 'disabled' };
    }
  }
  // zhipu 使用标准 messages+temperature+stream，无需额外参数

  return body;
}

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDERS,
  getActiveProviderKey,
  getActiveProvider,
  getHeaders,
  buildRequestBody,
};
