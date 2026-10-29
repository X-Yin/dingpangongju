/**
 * 盯盘页主题包配置服务
 *
 * 落盘 src/data/theme_packs.json：
 * { packs: [{ id, name, desc, source, tokens: { [tokenKey]: string } }] }
 *
 * 主题包列表由后端统一维护，前端弹窗通过 /theme_packs/list 获取；
 * 新增主题包时校验 JSON 对象结构、token key 白名单与 id 唯一性。
 */
const fs = require('fs');
const path = require('path');

const dataPath = path.resolve(__dirname, '../data/theme_packs.json');

// token key 白名单（与前端 themePacks.js 的 THEME_PACK_TOKEN_KEYS 保持一致）
const ALLOWED_TOKEN_KEYS = [
  'pageBg', 'fontFamily', 'numberFontFamily',
  'cardBg', 'cardBorderColor', 'cardBorderWidth', 'cardRadius', 'cardShadow',
  'titleColor', 'descColor',
  'itemBg', 'itemTitleColor', 'itemDescColor', 'itemBorderColor', 'itemBorderStyle', 'itemBorderWidth', 'itemRadius',
  'upColor', 'downColor', 'upBg', 'downBg',
  'btnBg', 'btnColor', 'btnFontFamily', 'btnRadius', 'btnBorderColor', 'btnBorderStyle', 'btnBorderWidth', 'btnShadow',
  'tagBg', 'tagColor', 'tagFontFamily', 'tagBorderColor', 'tagBorderStyle', 'tagBorderWidth', 'tagRadius',
];


const emptyStore = () => ({ packs: [] });

const ensureDataFile = () => {
  if (!fs.existsSync(dataPath)) {
    const dir = path.dirname(dataPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(emptyStore(), null, 2));
  }
};

const readStore = () => {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(dataPath, 'utf-8') || '';
    const data = JSON.parse(raw || '{}');
    return { packs: Array.isArray(data.packs) ? data.packs : [] };
  } catch (error) {
    console.error('读取主题包数据失败:', error);
    return emptyStore();
  }
};

const writeStore = (store) => {
  ensureDataFile();
  fs.writeFileSync(dataPath, JSON.stringify(store, null, 2));
};

const isPlainObject = (val) => !!val && typeof val === 'object' && !Array.isArray(val);

// 仅校验 JSON 合法性；对象非法时才报错，字段不做校验
const parsePackObject = (input) => {
  let obj = input;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch (error) {
      throw new Error(`JSON 格式错误：${error.message}`);
    }
  }
  if (!isPlainObject(obj)) {
    throw new Error('主题包必须是一个 JSON 对象');
  }
  return obj;
};

const normalizePack = (input) => {
  const obj = parsePackObject(input);

  // 补齐渲染与删除所需的 id / name，字段内容保持原样
  const id = typeof obj.id === 'string' && obj.id.trim()
    ? obj.id.trim()
    : `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : id;

  return {
    ...obj,
    id,
    name,
    tokens: isPlainObject(obj.tokens) ? obj.tokens : {},
  };
};

const getPacks = () => readStore().packs;

const addPack = (input) => {
  try {
    const store = readStore();
    const pack = normalizePack(input);
    store.packs.push(pack);
    writeStore(store);
    return { success: true, pack, packs: store.packs };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const updatePack = (id, input) => {
  try {
    const store = readStore();
    const packId = String(id || '').trim();
    if (!packId) return { success: false, error: '缺少 id 参数' };
    const idx = store.packs.findIndex((p) => p.id === packId);
    if (idx === -1) return { success: false, error: `主题包不存在：${packId}` };

    const patch = parsePackObject(input);
    const prev = store.packs[idx];
    const next = { ...prev, ...patch, id: packId };
    // tokens 做合并更新，避免只提交单个颜色字段时丢失其他 token
    if (isPlainObject(patch.tokens)) {
      next.tokens = { ...(isPlainObject(prev.tokens) ? prev.tokens : {}), ...patch.tokens };
    }
    store.packs[idx] = next;
    writeStore(store);
    return { success: true, packs: store.packs };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const deletePack = (id) => {
  try {
    const store = readStore();
    const packId = String(id || '').trim();
    if (!packId) return { success: false, error: '缺少 id 参数' };
    const exists = store.packs.some((p) => p.id === packId);
    if (!exists) return { success: false, error: `主题包不存在：${packId}` };
    store.packs = store.packs.filter((p) => p.id !== packId);
    writeStore(store);
    return { success: true, packs: store.packs };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

module.exports = {
  getPacks,
  addPack,
  updatePack,
  deletePack,
  ALLOWED_TOKEN_KEYS,
};
