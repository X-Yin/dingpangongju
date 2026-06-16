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

const moveResearchReport = (id, newParentId) => {
  const menu = getMenu();
  const removedItem = removeItemById(menu, id);
  if (!removedItem) return false;
  
  addItemToParent(menu, newParentId, removedItem);
  writeMenu(menu);
  return true;
};

module.exports = {
  getResearchReports,
  getResearchReportById,
  createResearchReport,
  updateResearchReport,
  deleteResearchReport,
  moveResearchReport
};
