// AI 引擎设置服务：持久化用户在前端选择的 AI 引擎（deepseek / zhipu / local）
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.resolve(__dirname, '../data/ai_settings.json');

// 可选引擎列表
const PROVIDERS = [
  { key: 'deepseek', name: 'DeepSeek', model: 'deepseek-v4-flash', desc: '云端 · 通用强推理' },
  { key: 'zhipu', name: '智谱 GLM', model: 'glm-5.2', desc: '云端 · 国内访问稳定' },
  { key: 'qwen', name: '通义千问', model: 'qwen-turbo', desc: '阿里云 · 兼容 OpenAI 格式' },
];

const DEFAULT_PROVIDER = 'deepseek';

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { provider: DEFAULT_PROVIDER, updatedAt: null };
    }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !PROVIDERS.some(p => p.key === data.provider)) {
      return { provider: DEFAULT_PROVIDER, updatedAt: data?.updatedAt || null };
    }
    return { provider: data.provider, updatedAt: data.updatedAt || null };
  } catch (e) {
    console.error('[aiSettings] 读取配置失败:', e.message);
    return { provider: DEFAULT_PROVIDER, updatedAt: null };
  }
}

function writeSettings(provider) {
  if (!PROVIDERS.some(p => p.key === provider)) {
    throw new Error(`不支持的引擎: ${provider}`);
  }
  const data = { provider, updatedAt: new Date().toISOString() };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
  return data;
}

function getProvider() {
  return readSettings().provider;
}

function getProviderList() {
  const current = getProvider();
  return PROVIDERS.map(p => ({ ...p, active: p.key === current }));
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  readSettings,
  writeSettings,
  getProvider,
  getProviderList,
};
