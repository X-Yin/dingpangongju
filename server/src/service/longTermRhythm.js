const fs = require('fs');
const path = require('path');

const LONG_TERM_RHYTHM_DATA_PATH = path.resolve(__dirname, '../data/longTermRhythm.json');

const ensureDataFile = () => {
  if (!fs.existsSync(LONG_TERM_RHYTHM_DATA_PATH)) {
    const defaultData = {
      content: `gantt
    title 长期炒作节奏规划
    dateFormat  YYYY-MM-DD
    section 第一阶段
    布局建仓期           :a1, 2026-06-01, 2026-06-15
    震荡洗盘期           :a2, 2026-06-16, 2026-06-30
    section 第二阶段
    初步拉升期           :b1, 2026-07-01, 2026-07-15
    回调确认期           :b2, 2026-07-16, 2026-07-31
    section 第三阶段
    主升浪阶段           :c1, 2026-08-01, 2026-08-20
    出货阶段             :c2, 2026-08-21, 2026-09-10`,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(LONG_TERM_RHYTHM_DATA_PATH, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
};

const getLongTermRhythmData = () => {
  ensureDataFile();
  const data = JSON.parse(fs.readFileSync(LONG_TERM_RHYTHM_DATA_PATH, 'utf-8'));
  return data;
};

const writeLongTermRhythmData = (data) => {
  ensureDataFile();
  fs.writeFileSync(LONG_TERM_RHYTHM_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

const updateLongTermRhythmItem = (item) => {
  const newItem = {
    ...item,
    updatedAt: new Date().toISOString()
  };
  writeLongTermRhythmData(newItem);
  return newItem;
};

module.exports = {
  getLongTermRhythmData,
  updateLongTermRhythmItem
};
