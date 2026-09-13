// 板块配置 CRUD 服务：读取 / 重写 constant/block_code.js 文件
const fs = require('fs');
const path = require('path');

const blockCodePath = path.resolve(__dirname, '../constant/block_code.js');

// 读取板块配置列表
const getBlocksConfig = () => {
  // 每次重新 require 以拿到最新文件内容（require 缓存在写入时会被刷新）
  delete require.cache[require.resolve('../constant/block_code.js')];
  const { default: blockCodeList } = require('../constant/block_code.js');
  return blockCodeList;
};

// 将列表写回 block_code.js 文件
const writeBlocksConfig = (list) => {
  // 保持与原文件一致的格式：exports.default = [...] （无分号、无尾换行）
  const content = 'exports.default = ' + JSON.stringify(list, null, 4);
  fs.writeFileSync(blockCodePath, content, 'utf-8');
  // 刷新 require 缓存，让后续 getBlockData 等使用最新配置
  delete require.cache[require.resolve('../constant/block_code.js')];
};

// 新增板块条目
const addBlock = (block) => {
  const { blockName, code, name } = block;
  if (!blockName || !code || !name) {
    throw new Error('blockName / code / name 不能为空');
  }
  const list = getBlocksConfig();
  if (list.some(item => item.code === code)) {
    throw new Error(`股票代码 ${code} 已存在`);
  }
  list.push({ blockName, code, name });
  writeBlocksConfig(list);
  return list;
};

// 新增板块（可包含多只股票）
const addBlockName = ({ blockName, stocks = [] }) => {
  if (!blockName) throw new Error('blockName 不能为空');
  const list = getBlocksConfig();
  
  // 检查板块是否已存在
  if (list.some(item => item.blockName === blockName)) {
    throw new Error(`板块 ${blockName} 已存在`);
  }
  
  // 如果有股票，直接添加
  if (stocks.length > 0) {
    for (const stock of stocks) {
      if (!stock.code || !stock.name) {
        throw new Error('每只股票必须包含 code 和 name');
      }
      if (list.some(item => item.code === stock.code)) {
        throw new Error(`股票代码 ${stock.code} 已存在`);
      }
      list.push({ blockName, code: stock.code, name: stock.name });
    }
  } else {
    // 仅创建板块，添加占位条目
    list.push({ blockName, code: '__block_placeholder__', name: blockName });
  }
  
  writeBlocksConfig(list);
  return list;
};

// 更新板块条目（按 code 匹配）
const updateBlock = (block) => {
  const { blockName, code, name } = block;
  if (!code) throw new Error('code 不能为空');
  const list = getBlocksConfig();
  const idx = list.findIndex(item => item.code === code);
  if (idx === -1) throw new Error(`股票代码 ${code} 不存在`);
  list[idx] = {
    blockName: blockName || list[idx].blockName,
    code,
    name: name || list[idx].name,
  };
  writeBlocksConfig(list);
  return list;
};

// 删除板块条目（按 code 匹配）
const deleteBlock = (code) => {
  if (!code) throw new Error('code 不能为空');
  const list = getBlocksConfig();
  const newList = list.filter(item => item.code !== code);
  if (newList.length === list.length) {
    throw new Error(`股票代码 ${code} 不存在`);
  }
  writeBlocksConfig(newList);
  return newList;
};

// 按板块名批量删除
const deleteBlockByName = (blockName) => {
  if (!blockName) throw new Error('blockName 不能为空');
  const list = getBlocksConfig();
  const newList = list.filter(item => item.blockName !== blockName);
  if (newList.length === list.length) {
    throw new Error(`板块 ${blockName} 不存在`);
  }
  writeBlocksConfig(newList);
  return newList;
};

module.exports = {
  getBlocksConfig,
  addBlock,
  addBlockName,
  updateBlock,
  deleteBlock,
  deleteBlockByName,
};
