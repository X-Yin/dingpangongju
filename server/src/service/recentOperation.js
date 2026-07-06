const fs = require('fs');
const path = require('path');

const RECENT_OPERATION_DATA_PATH = path.resolve(__dirname, '../data/recentOperation.json');

const ensureDataFile = () => {
  if (!fs.existsSync(RECENT_OPERATION_DATA_PATH)) {
    fs.writeFileSync(RECENT_OPERATION_DATA_PATH, JSON.stringify(null), 'utf-8');
  }
};

const getRecentOperationData = () => {
  ensureDataFile();
  const data = JSON.parse(fs.readFileSync(RECENT_OPERATION_DATA_PATH, 'utf-8'));
  return data;
};

const writeRecentOperationData = (data) => {
  ensureDataFile();
  fs.writeFileSync(RECENT_OPERATION_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

const updateRecentOperationItem = (item) => {
  const newItem = {
    ...item,
    updatedAt: new Date().toISOString()
  };
  writeRecentOperationData(newItem);
  return newItem;
};

module.exports = {
  getRecentOperationData,
  updateRecentOperationItem
};
