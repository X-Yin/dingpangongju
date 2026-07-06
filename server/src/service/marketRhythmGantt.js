const fs = require('fs');
const path = require('path');

const GANTT_DATA_PATH = path.join(__dirname, '../data/marketRhythmGantt.json');

const getGanttData = () => {
  try {
    if (!fs.existsSync(GANTT_DATA_PATH)) {
      fs.writeFileSync(GANTT_DATA_PATH, JSON.stringify([]));
    }
    const data = fs.readFileSync(GANTT_DATA_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('读取甘特图数据失败:', error);
    return [];
  }
};

const updateGanttData = (events) => {
  try {
    fs.writeFileSync(GANTT_DATA_PATH, JSON.stringify(events, null, 2));
    return true;
  } catch (error) {
    console.error('更新甘特图数据失败:', error);
    return false;
  }
};

module.exports = {
  getGanttData,
  updateGanttData,
};
