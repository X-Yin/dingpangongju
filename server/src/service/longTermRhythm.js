const fs = require('fs');
const path = require('path');

const LONG_TERM_RHYTHM_DATA_PATH = path.resolve(__dirname, '../data/longTermRhythm.json');

const generateId = () => {
  return 'lt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
};

const ensureDataFile = () => {
  if (!fs.existsSync(LONG_TERM_RHYTHM_DATA_PATH)) {
    const defaultData = {
      projects: [
        {
          id: generateId(),
          title: '默认项目',
          description: '这是一个默认的长期炒作节奏项目',
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    };
    fs.writeFileSync(LONG_TERM_RHYTHM_DATA_PATH, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
};

// 读取数据，不进行自动修复，直接返回原始数据
const readData = () => {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(LONG_TERM_RHYTHM_DATA_PATH, 'utf-8'));
  } catch (error) {
    console.error('Error reading data file:', error);
    return { projects: [] };
  }
};

// 写入数据
const writeData = (data) => {
  fs.writeFileSync(LONG_TERM_RHYTHM_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

const getAllProjects = () => {
  const data = readData();
  return data.projects || [];
};

const createProject = (title, description) => {
  const data = readData();
  const newProject = {
    id: generateId(),
    title: title || '新项目',
    description: description || '',
    content: `gantt
    title 新项目规划
    dateFormat  YYYY-MM-DD
    section 第一阶段
    开始阶段           :a1, 2026-06-01, 30d`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  if (!data.projects) {
    data.projects = [];
  }
  
  data.projects.push(newProject);
  writeData(data);
  return newProject;
};

const updateProject = (id, updates) => {
  const data = readData();
  if (!data.projects) {
    data.projects = [];
  }
  
  const projectIndex = data.projects.findIndex(p => p.id === id);
  if (projectIndex === -1) {
    return null;
  }
  
  // 保留原有字段，只更新传入的字段
  const existingProject = data.projects[projectIndex];
  const updatedProject = {
    id: existingProject.id,
    title: updates.title !== undefined ? updates.title : existingProject.title,
    description: updates.description !== undefined ? updates.description : existingProject.description,
    content: updates.content !== undefined ? updates.content : existingProject.content,
    createdAt: existingProject.createdAt,
    updatedAt: new Date().toISOString()
  };
  
  data.projects[projectIndex] = updatedProject;
  writeData(data);
  return updatedProject;
};

const deleteProject = (id) => {
  const data = readData();
  if (!data.projects) {
    return false;
  }
  
  const initialLength = data.projects.length;
  data.projects = data.projects.filter(p => p.id !== id);
  
  if (data.projects.length !== initialLength) {
    writeData(data);
    return true;
  }
  
  return false;
};

// 向后兼容的旧接口
const getLongTermRhythmData = () => {
  const projects = getAllProjects();
  if (projects.length > 0) {
    return {
      content: projects[0].content,
      updatedAt: projects[0].updatedAt
    };
  }
  return { content: '', updatedAt: new Date().toISOString() };
};

const updateLongTermRhythmItem = (item) => {
  const projects = getAllProjects();
  if (projects.length > 0) {
    return updateProject(projects[0].id, { content: item.content });
  }
  
  const newProject = createProject('默认项目', '');
  return updateProject(newProject.id, { content: item.content });
};

module.exports = {
  getLongTermRhythmData,
  updateLongTermRhythmItem,
  getAllProjects,
  createProject,
  updateProject,
  deleteProject
};
