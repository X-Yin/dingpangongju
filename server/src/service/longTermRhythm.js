const fs = require('fs');
const path = require('path');

const LONG_TERM_RHYTHM_DATA_PATH = path.resolve(__dirname, '../data/longTermRhythm.json');

const ensureDataFile = () => {
  if (!fs.existsSync(LONG_TERM_RHYTHM_DATA_PATH)) {
    const defaultData = {
      content: `gantt
    title 长期炒作节奏规划
    dateFormat  YYYY-MM-DD
    
    section 第一阶段 - 布局建仓
    建仓布局期           :active, a1, 2026-06-01, 2026-06-15
    震荡洗盘期           :done, a2, 2026-06-16, 2026-06-30
    
    section 第二阶段 - 初步拉升
    初步拉升期           :crit, b1, 2026-07-01, 2026-07-15
    回调确认期           :active, b2, 2026-07-16, 2026-07-31
    
    section 第三阶段 - 主升浪
    主升浪上攻           :done, c1, 2026-08-01, 2026-08-15
    高位整理期           :c2, 2026-08-16, 2026-08-25
    
    section 第四阶段 - 分批出货
    分批出货期           :active, d1, 2026-08-26, 2026-09-10
    
    section 第五阶段 - 观察等待
    等待机会期           :e1, 2026-09-11, 2026-09-20
    
    section 第六阶段 - 第二波
    第二波启动           :active, f1, 2026-09-21, 2026-09-30
    
    section 第七阶段 - 主升
    主升浪加速           :crit, g1, 2026-10-01, 2026-10-15
    
    section 第八阶段 - 调整
    调整整理期           :done, h1, 2026-10-16, 2026-10-25
    
    section 第九阶段 - 收尾
    最终冲刺期           :active, i1, 2026-10-26, 2026-11-10
    
    section 第十阶段 - 总结
    总结观察期           :j1, 2026-11-11, 2026-11-20
    
    section 第十一阶段 - 准备
    前期准备期           :k1, 2026-11-21, 2026-11-30
    
    section 第十二阶段 - 执行
    开始执行期           :active, l1, 2026-12-01, 2026-12-10
    
    section 第十三阶段 - 操作
    操作执行期           :m1, 2026-12-11, 2026-12-20
    
    section 第十四阶段 - 调整
    策略调整期           :done, n1, 2026-12-21, 2026-12-25
    
    section 第十五阶段 - 结束
    结束观察期           :milestone, o1, 2026-12-26, 2026-12-31`,
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
