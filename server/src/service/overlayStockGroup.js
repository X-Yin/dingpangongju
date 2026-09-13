const fs = require('fs');
const path = require('path');

const groupDataPath = path.resolve(__dirname, '../data/overlay_stock_groups.json');

const ensureDataFile = () => {
  if (!fs.existsSync(groupDataPath)) {
    fs.writeFileSync(groupDataPath, JSON.stringify([], null, 2));
  }
};

const readGroups = () => {
  ensureDataFile();
  try {
    const data = fs.readFileSync(groupDataPath, 'utf-8') || '[]';
    const groups = JSON.parse(data);
    if (!Array.isArray(groups)) return [];
    return groups;
  } catch (error) {
    console.error('读取叠加分时股票分组失败:', error);
    return [];
  }
};

const writeGroups = (groups) => {
  ensureDataFile();
  fs.writeFileSync(groupDataPath, JSON.stringify(groups, null, 2));
};

const cleanStocks = (stocks) => {
  if (!Array.isArray(stocks)) return [];
  const map = new Map();
  stocks.filter(Boolean).forEach((s) => {
    if (!s || !s.code) return;
    map.set(s.code, {
      code: s.code,
      stockName: s.stockName || s.code,
      change: s.change != null ? s.change : undefined,
    });
  });
  return Array.from(map.values());
};

const getAllGroups = () => {
  return readGroups().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
};

const saveGroup = ({ id, name, stocks }) => {
  try {
    const groups = readGroups();
    const groupId = id || (`g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const now = new Date().toISOString();
    const cleanName = (name && String(name).trim()) ? String(name).trim() : '未命名分组';
    const cleanStockList = cleanStocks(stocks);

    const existingIndex = groups.findIndex(g => g.id === groupId);
    if (existingIndex !== -1) {
      groups[existingIndex] = {
        ...groups[existingIndex],
        name: cleanName,
        stocks: cleanStockList,
        updatedAt: now,
      };
    } else {
      groups.push({
        id: groupId,
        name: cleanName,
        stocks: cleanStockList,
        createdAt: now,
        updatedAt: now,
      });
    }

    writeGroups(groups);
    return { success: true, group: groups.find(g => g.id === groupId) };
  } catch (error) {
    console.error('保存叠加分时股票分组失败:', error);
    return { success: false, error: error.message };
  }
};

const deleteGroup = (id) => {
  try {
    const groups = readGroups().filter(g => g.id !== id);
    writeGroups(groups);
    return { success: true };
  } catch (error) {
    console.error('删除叠加分时股票分组失败:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  getAllGroups,
  saveGroup,
  deleteGroup,
};