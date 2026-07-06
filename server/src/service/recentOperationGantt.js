const fs = require('fs');
const path = require('path');

const GANTT_DATA_PATH = path.join(__dirname, '../data/recentOperationGantt.json');

const getRecentOperationGanttData = () => {
  try {
    if (!fs.existsSync(GANTT_DATA_PATH)) {
      fs.writeFileSync(GANTT_DATA_PATH, JSON.stringify([]));
    }
    const data = fs.readFileSync(GANTT_DATA_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('读取近期操作方案甘特图数据失败:', error);
    return [];
  }
};

const updateRecentOperationGanttData = (events) => {
  try {
    fs.writeFileSync(GANTT_DATA_PATH, JSON.stringify(events, null, 2));
    return true;
  } catch (error) {
    console.error('更新近期操作方案甘特图数据失败:', error);
    return false;
  }
};

module.exports = {
  getRecentOperationGanttData,
  updateRecentOperationGanttData,
};
