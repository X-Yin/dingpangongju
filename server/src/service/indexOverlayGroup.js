const fs = require('fs');
const path = require('path');

const groupDataPath = path.resolve(__dirname, '../data/index_overlay_groups.json');

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
    console.error('读取指数叠加分组失败:', error);
    return [];
  }
};

const writeGroups = (groups) => {
  ensureDataFile();
  fs.writeFileSync(groupDataPath, JSON.stringify(groups, null, 2));
};

const getAllGroups = () => {
  return readGroups().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
};

const saveGroup = ({ id, title, description, dates }) => {
  try {
    const groups = readGroups();
    const groupId = id || (`g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const now = new Date().toISOString();
    const cleanTitle = (title && String(title).trim()) ? String(title).trim() : '未命名分组';
    const cleanDates = Array.isArray(dates)
      ? dates.filter(d => d && typeof d === 'string')
      : [];

    const existingIndex = groups.findIndex(g => g.id === groupId);
    if (existingIndex !== -1) {
      groups[existingIndex] = {
        ...groups[existingIndex],
        title: cleanTitle,
        description: (description && String(description).trim()) ? String(description).trim() : '',
        dates: cleanDates,
        updatedAt: now,
      };
    } else {
      groups.push({
        id: groupId,
        title: cleanTitle,
        description: (description && String(description).trim()) ? String(description).trim() : '',
        dates: cleanDates,
        createdAt: now,
        updatedAt: now,
      });
    }

    writeGroups(groups);
    return { success: true, group: groups.find(g => g.id === groupId) };
  } catch (error) {
    console.error('保存指数叠加分组失败:', error);
    return { success: false, error: error.message };
  }
};

const deleteGroup = (id) => {
  try {
    const groups = readGroups().filter(g => g.id !== id);
    writeGroups(groups);
    return { success: true };
  } catch (error) {
    console.error('删除指数叠加分组失败:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  getAllGroups,
  saveGroup,
  deleteGroup,
};