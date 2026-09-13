const fs = require('fs');
const path = require('path');
const { generateUniqueId } = require('../utils');

const RESEARCH_REPORTS_DIR = path.resolve(__dirname, '../data/research_reports');
const MENU_FILE = path.resolve(RESEARCH_REPORTS_DIR, 'menu.json');

const ensureDataDir = () => {
  if (!fs.existsSync(RESEARCH_REPORTS_DIR)) {
    fs.mkdirSync(RESEARCH_REPORTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(MENU_FILE)) {
    fs.writeFileSync(MENU_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
};

const getMenu = () => {
  ensureDataDir();
  const data = JSON.parse(fs.readFileSync(MENU_FILE, 'utf-8'));
  return data;
};

const writeMenu = (data) => {
  ensureDataDir();
  fs.writeFileSync(MENU_FILE, JSON.stringify(data, null, 2), 'utf-8');
};

const getReportContentPath = (id) => {
  return path.resolve(RESEARCH_REPORTS_DIR, `${id}.json`);
};

const saveReportContent = (id, content) => {
  const contentPath = getReportContentPath(id);
  fs.writeFileSync(contentPath, JSON.stringify({ content }, null, 2), 'utf-8');
};

const getReportContent = (id) => {
  const contentPath = getReportContentPath(id);
  if (fs.existsSync(contentPath)) {
    const data = JSON.parse(fs.readFileSync(contentPath, 'utf-8'));
    return data.content;
  }
  return '';
};

const deleteReportContent = (id) => {
  const contentPath = getReportContentPath(id);
  if (fs.existsSync(contentPath)) {
    fs.unlinkSync(contentPath);
  }
};

const findItemById = (items, id) => {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }
    if (item.children) {
      const found = findItemById(item.children, id);
      if (found) return found;
    }
  }
  return null;
};

const removeItemById = (items, id) => {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) {
      const removedItem = items[i];
      items.splice(i, 1);
      return removedItem;
    }
    if (items[i].children) {
      const removed = removeItemById(items[i].children, id);
      if (removed) return removed;
    }
  }
  return null;
};

const updateItemById = (items, id, updates) => {
  for (const item of items) {
    if (item.id === id) {
      Object.assign(item, updates);
      return true;
    }
    if (item.children) {
      if (updateItemById(item.children, id, updates)) {
        return true;
      }
    }
  }
  return false;
};

const addItemToParent = (items, parentId, newItem) => {
  if (!parentId) {
    items.push(newItem);
    return true;
  }
  for (const item of items) {
    if (item.id === parentId && item.type === 'folder') {
      if (!item.children) {
        item.children = [];
      }
      item.children.push(newItem);
      return true;
    }
    if (item.children) {
      if (addItemToParent(item.children, parentId, newItem)) {
        return true;
      }
    }
  }
  return false;
};

const findParentAndIndex = (items, id, parent = null) => {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) {
      return { parent, items, index: i };
    }
    if (items[i].children) {
      const result = findParentAndIndex(items[i].children, id, items[i]);
      if (result) return result;
    }
  }
  return null;
};

const pinResearchReport = (id) => {
  const menu = getMenu();
  const item = findItemById(menu, id);
  if (!item || item.type !== 'report') return false;

  // 切换置顶状态
  const newIsPinned = !item.isPinned;
  
  // 更新状态并处理位置
  const result = findParentAndIndex(menu, id);
  if (result) {
    const { items, index } = result;
    const targetItem = items[index];
    targetItem.isPinned = newIsPinned;
    
    // 如果是置顶操作，则移动到其所在层级的开头
    if (newIsPinned) {
      items.splice(index, 1);
      items.unshift(targetItem);
    }
  }
  
  writeMenu(menu);
  return true;
};

const deleteItemRecursively = (items, id) => {
  const removedItem = removeItemById(items, id);
  if (!removedItem) return;

  if (removedItem.type === 'report') {
    deleteReportContent(id);
  } else if (removedItem.type === 'folder' && removedItem.children) {
    const deleteChildren = (children) => {
      for (const child of children) {
        if (child.type === 'report') {
          deleteReportContent(child.id);
        } else if (child.children) {
          deleteChildren(child.children);
        }
      }
    };
    deleteChildren(removedItem.children);
  }
};

const getResearchReports = () => {
  return getMenu();
};

const getResearchReportById = (id) => {
  const menu = getMenu();
  const item = findItemById(menu, id);
  if (!item) return null;
  
  if (item.type === 'report') {
    return {
      ...item,
      content: getReportContent(id)
    };
  }
  return item;
};

const createResearchReport = (parentId, name, type, content = '') => {
  const menu = getMenu();
  const newItem = {
    id: generateUniqueId(),
    name,
    type,
    isImportant: false,
    isHidden: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (type === 'folder') {
    newItem.children = [];
  }
  addItemToParent(menu, parentId, newItem);
  writeMenu(menu);
  
  if (type === 'report') {
    saveReportContent(newItem.id, content);
  }
  
  return newItem;
};

const updateResearchReport = (id, updates) => {
  const menu = getMenu();
  const item = findItemById(menu, id);
  if (!item) return null;
  
  const updatedItem = {
    ...item,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  
  updateItemById(menu, id, updatedItem);
  writeMenu(menu);
  
  if (item.type === 'report' && updates.content !== undefined) {
    saveReportContent(id, updates.content);
  }
  
  return updatedItem;
};

const deleteResearchReport = (id) => {
  const menu = getMenu();
  deleteItemRecursively(menu, id);
  writeMenu(menu);
  return true;
};

const deleteResearchReports = (ids) => {
  const menu = getMenu();
  for (const id of ids) {
    deleteItemRecursively(menu, id);
  }
  writeMenu(menu);
  return true;
};

const moveResearchReport = (id, newParentId) => {
  const menu = getMenu();
  const removedItem = removeItemById(menu, id);
  if (!removedItem) return false;

  addItemToParent(menu, newParentId, removedItem);
  writeMenu(menu);
  return true;
};

/**
 * 取最近 N 个文件夹（按 name 即日期字符串降序）内所有研报及其内容
 * 用于「复制上下文」功能
 */
const getRecentFoldersReports = (folderCount = 30) => {
  const menu = getMenu();
  const folders = menu
    .filter((item) => item && item.type === 'folder')
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));

  const recentFolders = folders.slice(0, folderCount);
  const result = [];

  for (const folder of recentFolders) {
    const reports = [];
    const collectReports = (items) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item.type === 'report') {
          reports.push({
            id: item.id,
            name: item.name,
            content: getReportContent(item.id),
            isImportant: !!item.isImportant,
            isPinned: !!item.isPinned,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          });
        } else if (item.type === 'folder' && item.children) {
          collectReports(item.children);
        }
      }
    };
    collectReports(folder.children);
    // 文件夹内按 updatedAt 降序排列研报
    reports.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    result.push({
      folderName: folder.name,
      reports,
    });
  }

  return result;
};

module.exports = {
  getResearchReports,
  getResearchReportById,
  createResearchReport,
  updateResearchReport,
  deleteResearchReport,
  deleteResearchReports,
  moveResearchReport,
  pinResearchReport,
  getRecentFoldersReports,
};
