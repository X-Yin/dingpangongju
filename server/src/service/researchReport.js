const fs = require('fs');
const path = require('path');
const { generateUniqueId } = require('../utils');

const RESEARCH_REPORTS_PATH = path.resolve(__dirname, '../data/research_reports.json');

const ensureDataFile = () => {
  if (!fs.existsSync(RESEARCH_REPORTS_PATH)) {
    fs.writeFileSync(RESEARCH_REPORTS_PATH, JSON.stringify([], null, 2), 'utf-8');
  }
};

const getResearchReports = () => {
  ensureDataFile();
  const data = JSON.parse(fs.readFileSync(RESEARCH_REPORTS_PATH, 'utf-8'));
  return data;
};

const writeResearchReports = (data) => {
  ensureDataFile();
  fs.writeFileSync(RESEARCH_REPORTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
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
      items.splice(i, 1);
      return true;
    }
    if (items[i].children) {
      if (removeItemById(items[i].children, id)) {
        return true;
      }
    }
  }
  return false;
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

const getResearchReportById = (id) => {
  const data = getResearchReports();
  return findItemById(data, id);
};

const createResearchReport = (parentId, name, type, content = '') => {
  const data = getResearchReports();
  const newItem = {
    id: generateUniqueId(),
    name,
    type,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (type === 'report') {
    newItem.content = content;
  }
  if (type === 'folder') {
    newItem.children = [];
  }
  addItemToParent(data, parentId, newItem);
  writeResearchReports(data);
  return newItem;
};

const updateResearchReport = (id, updates) => {
  const data = getResearchReports();
  const item = findItemById(data, id);
  if (!item) return null;
  
  const updatedItem = {
    ...item,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  updateItemById(data, id, updatedItem);
  writeResearchReports(data);
  return updatedItem;
};

const deleteResearchReport = (id) => {
  const data = getResearchReports();
  const success = removeItemById(data, id);
  if (success) {
    writeResearchReports(data);
  }
  return success;
};

const moveResearchReport = (id, newParentId) => {
  const data = getResearchReports();
  const item = findItemById(data, id);
  if (!item) return false;
  
  removeItemById(data, id);
  addItemToParent(data, newParentId, item);
  writeResearchReports(data);
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
