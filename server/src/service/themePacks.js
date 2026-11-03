/**
 * 主题包配置服务（工厂）
 *
 * 每个页面一份独立数据文件：
 * - 盯盘页（dingpan）    落盘 src/data/theme_packs.json
 * - 开盘作战页（OpeningBattle）落盘 src/data/ob_theme_packs.json
 * 数据结构：{ packs: [{ id, name, desc, source, tokens: { [tokenKey]: string } }] }
 *
 * 主题包列表由后端统一维护，前端弹窗通过 /theme_packs/list、/ob_theme_packs/list 获取；
 * 新增主题包时校验 JSON 对象结构，字段内容原样保存。
 */
const fs = require('fs');
const path = require('path');

const isPlainObject = (val) => !!val && typeof val === 'object' && !Array.isArray(val);

const createThemePackService = (dataFileName) => {
  const dataPath = path.resolve(__dirname, '../data', dataFileName);

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
      console.error(`读取主题包数据失败(${dataFileName}):`, error);
      return emptyStore();
    }
  };

  const writeStore = (store) => {
    ensureDataFile();
    fs.writeFileSync(dataPath, JSON.stringify(store, null, 2));
  };

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

  return { getPacks, addPack, updatePack, deletePack };
};

// 盯盘页主题包服务（原有接口 /theme_packs/* 继续使用）
const dingpanService = createThemePackService('theme_packs.json');

// 开盘作战页主题包服务（/ob_theme_packs/*）
const openingBattleService = createThemePackService('ob_theme_packs.json');

module.exports = {
  // 盯盘页（保持原有导出兼容）
  getPacks: dingpanService.getPacks,
  addPack: dingpanService.addPack,
  updatePack: dingpanService.updatePack,
  deletePack: dingpanService.deletePack,
  // 开盘作战页
  getObPacks: openingBattleService.getPacks,
  addObPack: openingBattleService.addPack,
  updateObPack: openingBattleService.updatePack,
  deleteObPack: openingBattleService.deletePack,
  // 工厂（后续新页面主题包可复用）
  createThemePackService,
};
