/**
 * 题材盯盘 - 自定义题材与个股增删持久化服务
 *
 * 落盘 src/data/theme_custom.json：
 * {
 *   themes:    [{ id, name, stocks: [{ code, name }], createdAt, updatedAt }],  // 自定义题材
 *   overrides: { [themeKey]: { added: [{ code, name }], removed: [code] } },   // 系统题材的增/删股票覆盖
 *   order:     [chipId]                                                        // 横幅条 chip 拖拽顺序
 * }
 *
 * chipId：系统题材为聚合 key（boardKeyOf 结果），自定义题材为 `custom:${id}`。
 */
const fs = require('fs');
const path = require('path');

const dataPath = path.resolve(__dirname, '../data/theme_custom.json');

const emptyStore = () => ({ themes: [], overrides: {}, order: [] });

const ensureDataFile = () => {
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify(emptyStore(), null, 2));
  }
};

const readStore = () => {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(dataPath, 'utf-8') || '';
    const data = JSON.parse(raw || '{}');
    return {
      themes: Array.isArray(data.themes) ? data.themes : [],
      overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
      order: Array.isArray(data.order) ? data.order : [],
    };
  } catch (error) {
    console.error('读取自定义题材数据失败:', error);
    return emptyStore();
  }
};

const writeStore = (store) => {
  ensureDataFile();
  fs.writeFileSync(dataPath, JSON.stringify(store, null, 2));
};

// 股票条目规范化为 { code, name }，code 采用带市前缀的 marketCode，按 code 去重
const cleanStocks = (stocks) => {
  if (!Array.isArray(stocks)) return [];
  const map = new Map();
  stocks.filter(Boolean).forEach((s) => {
    if (!s || !s.code) return;
    const code = String(s.code).trim();
    if (!code) return;
    map.set(code, { code, name: String(s.name || s.stockName || code).trim() });
  });
  return Array.from(map.values());
};

const getStore = () => readStore();

const saveTheme = ({ id, name, stocks }) => {
  try {
    const store = readStore();
    const cleanName = String(name || '').trim();
    if (!cleanName) return { success: false, error: '题材名称不能为空' };
    const cleanStockList = cleanStocks(stocks);
    const now = new Date().toISOString();

    let themeId = id ? String(id) : '';
    let idx = themeId ? store.themes.findIndex((t) => t.id === themeId) : -1;
    if (idx === -1) {
      themeId = themeId || `ct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      store.themes.push({ id: themeId, name: cleanName, stocks: cleanStockList, createdAt: now, updatedAt: now });
    } else {
      store.themes[idx] = { ...store.themes[idx], name: cleanName, stocks: cleanStockList, updatedAt: now };
    }
    writeStore(store);
    return { success: true, theme: store.themes.find((t) => t.id === themeId) };
  } catch (error) {
    console.error('保存自定义题材失败:', error);
    return { success: false, error: error.message };
  }
};

const deleteTheme = (id) => {
  try {
    const store = readStore();
    const themeId = String(id || '');
    store.themes = store.themes.filter((t) => t.id !== themeId);
    store.order = store.order.filter((k) => k !== `custom:${themeId}`);
    writeStore(store);
    return { success: true };
  } catch (error) {
    console.error('删除自定义题材失败:', error);
    return { success: false, error: error.message };
  }
};

const saveOverride = (themeKey, { added, removed } = {}) => {
  try {
    const store = readStore();
    const key = String(themeKey || '').trim();
    if (!key) return { success: false, error: '缺少题材 key' };
    const cleanAdded = cleanStocks(added);
    const cleanRemoved = Array.from(new Set((Array.isArray(removed) ? removed : []).map((c) => String(c || '').trim()).filter(Boolean)));
    if (cleanAdded.length === 0 && cleanRemoved.length === 0) {
      delete store.overrides[key];
    } else {
      store.overrides[key] = { added: cleanAdded, removed: cleanRemoved };
    }
    writeStore(store);
    return { success: true, override: store.overrides[key] || null };
  } catch (error) {
    console.error('保存题材股票增删覆盖失败:', error);
    return { success: false, error: error.message };
  }
};

const saveOrder = (order) => {
  try {
    const store = readStore();
    store.order = (Array.isArray(order) ? order : []).map((k) => String(k || '').trim()).filter(Boolean);
    writeStore(store);
    return { success: true };
  } catch (error) {
    console.error('保存题材横幅排序失败:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  getStore,
  saveTheme,
  deleteTheme,
  saveOverride,
  saveOrder,
};
