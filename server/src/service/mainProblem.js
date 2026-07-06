// 市场当前的主要矛盾判断
const fs = require('fs');
const path = require('path');
const { generateUniqueId } = require('../utils');

const mainProblemPath = path.resolve(__dirname, '../data/main_problem.json');
const personalSuggPath = path.resolve(__dirname, '../data/personal_sugg.json');

const getMainProblem = async () => {
  //  读取本地的 main_problem.json 文件的内容
  const mainProblemData = JSON.parse(fs.readFileSync(mainProblemPath, 'utf-8') || '[]');
  const personalSuggData = JSON.parse(fs.readFileSync(personalSuggPath, 'utf-8') || '{}');
  
  return {
    mainProblemData,
    personalSuggData
  };
}


const writeMainProblem = ({ title, content, id }) => {
  // 读取本地的 main_problem.json 的内容 ，如果 id 已经存在，那么就直接覆盖 title 和 content 的内容，如果不存在，那么就新增一个对象
  const mainProblemData = JSON.parse(fs.readFileSync(mainProblemPath, 'utf-8') || '[]');
  if (!id) {
    id = generateUniqueId();
  }
  // 找到对应的对象，然后覆盖 title 和 content 的内容
  const index = mainProblemData.findIndex(item => item.id === id);
  if (index !== -1) {
    mainProblemData[index].title = title;
    mainProblemData[index].content = content;
  } else {
    mainProblemData.push({
      id,
      title,
      content,
    });
  }
  // 写入本地的 main_problem.json 文件
  fs.writeFileSync(mainProblemPath, JSON.stringify(mainProblemData, null, 2));
}

const delMainProblem = async ({ id }) => {
  // 读取本地的 main_problem.json 的内容 ，如果 id 已经存在，那么就直接删除
  const mainProblemData = JSON.parse(fs.readFileSync(mainProblemPath, 'utf-8') || '[]');
  // 找到对应的对象，然后删除
  const index = mainProblemData.findIndex(item => item.id === id);
  if (index !== -1) {
    mainProblemData.splice(index, 1);
  }
  // 写入本地的 main_problem.json 文件
  fs.writeFileSync(mainProblemPath, JSON.stringify(mainProblemData, null, 2));
}

const updateMainProblemSeq = async ({ seq_ids }) => {
  // 读取本地的 main_problem.json 的内容 ，如果 id 已经存在，那么就直接覆盖 seq 的内容
  const mainProblemData = JSON.parse(fs.readFileSync(mainProblemPath, 'utf-8') || '[]');
  const newList = [];

  seq_ids.forEach((id) => {
    const item = mainProblemData.find(item => item.id === id);
    if (item) {
      newList.push(item);
    }
  });

  // 写入本地的 main_problem.json 文件
  fs.writeFileSync(mainProblemPath, JSON.stringify(newList, null, 2));
}

const updatePersonalSugg = async ({ globalSuggContent, tempSuggContent }) => {
  // 读取本地的 personal_sugg.json 的内容 ，如果 id 已经存在，那么就直接覆盖 title 和 content 的内容，如果不存在，那么就新增一个对象
  const personalSuggData = JSON.parse(fs.readFileSync(personalSuggPath, 'utf-8') || '{}');
  if (globalSuggContent) {
    personalSuggData.globalSuggContent = globalSuggContent;
  }
  if (tempSuggContent) {
    personalSuggData.tempSuggContent = tempSuggContent;
  }
  // 写入本地的 personal_sugg.json 文件
  fs.writeFileSync(personalSuggPath, JSON.stringify(personalSuggData, null, 2));
}

// (async () => {
//     updatePersonalSugg({ globalSuggContent: '1234', tempSuggContent: '5678' });
// })();

exports.getMainProblem = getMainProblem;
exports.writeMainProblem = writeMainProblem;
exports.delMainProblem = delMainProblem;
exports.updateMainProblemSeq = updateMainProblemSeq;
exports.updatePersonalSugg = updatePersonalSugg;