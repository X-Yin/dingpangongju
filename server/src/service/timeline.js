const fs = require('fs');
const path = require('path');

const TIMELINE_DATA_PATH = path.resolve(__dirname, '../data/timeline.json');

// 确保数据文件存在
const ensureDataFile = () => {
  if (!fs.existsSync(TIMELINE_DATA_PATH)) {
    fs.writeFileSync(TIMELINE_DATA_PATH, JSON.stringify([]), 'utf-8');
  }
};

// 获取时间线数据
const getTimelineData = () => {
  ensureDataFile();
  const data = JSON.parse(fs.readFileSync(TIMELINE_DATA_PATH, 'utf-8'));
  return data;
};

// 写入时间线数据
const writeTimelineData = (data) => {
  ensureDataFile();
  fs.writeFileSync(TIMELINE_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

// 更新或添加时间线事件
const updateTimelineEvent = (event) => {
  let data = getTimelineData();
  
  if (event.id) {
    // 更新现有事件
    const index = data.findIndex(item => item.id === event.id);
    if (index !== -1) {
      data[index] = { ...data[index], ...event };
    }
  } else {
    // 添加新事件
    const newId = data.length > 0 ? Math.max(...data.map(item => item.id)) + 1 : 1;
    data.push({
      id: newId,
      ...event,
      createdAt: new Date().toISOString()
    });
  }
  
  // 按时间排序（最旧的在最前面，从低到高）
  data.sort((a, b) => new Date(a.date) - new Date(b.date));
  writeTimelineData(data);
};

// 删除时间线事件
const deleteTimelineEvent = (id) => {
  let data = getTimelineData();
  data = data.filter(item => item.id !== id);
  writeTimelineData(data);
};

module.exports = {
  getTimelineData,
  updateTimelineEvent,
  deleteTimelineEvent
};
