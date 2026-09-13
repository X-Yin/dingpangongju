const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '../data');

// 需要排除的文件/目录（非数据文件或体积过大无意义）
const EXCLUDE_NAMES = new Set([
  'intraday_history_cache.json', // 100 天分时缓存，体积过大
  'tech_index.backup.json',      // 备份文件
]);

// 列出 data 目录下所有数据文件（仅两级：根目录文件 + 子目录内文件）
const listDataFiles = () => {
  const result = [];

  let rootEntries;
  try {
    rootEntries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (e) {
    return result;
  }

  for (const entry of rootEntries) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dataDir, entry.name);

    if (entry.isDirectory()) {
      // 第二级：子目录内的文件（不再递归）
      const children = [];
      let subEntries;
      try {
        subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const subEntry of subEntries) {
        if (EXCLUDE_NAMES.has(subEntry.name)) continue;
        if (!subEntry.isFile() || !subEntry.name.endsWith('.json')) continue;
        const subFullPath = path.join(fullPath, subEntry.name);
        let stat;
        try { stat = fs.statSync(subFullPath); } catch (e) { continue; }
        children.push({
          name: subEntry.name,
          path: `${entry.name}/${subEntry.name}`,
          type: 'file',
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
      if (children.length > 0) {
        result.push({
          name: entry.name,
          path: entry.name,
          type: 'directory',
          children,
        });
      }
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      let stat;
      try { stat = fs.statSync(fullPath); } catch (e) { continue; }
      result.push({
        name: entry.name,
        path: entry.name,
        type: 'file',
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  return result;
};

// 读取单个数据文件内容（返回解析后的 JSON）
const readDataFile = (relPath) => {
  // 安全检查：禁止路径穿越
  const fullPath = path.resolve(dataDir, relPath);
  if (!fullPath.startsWith(dataDir)) {
    throw new Error('非法路径');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error('文件不存在');
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    throw new Error('不能读取目录');
  }
  // 限制文件大小（20MB）
  if (stat.size > 20 * 1024 * 1024) {
    throw new Error('文件过大，暂不支持读取（>20MB）');
  }
  const raw = fs.readFileSync(fullPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 非 JSON 文件，返回原始字符串
    return { __rawText: raw };
  }
};

// 批量读取多个数据文件，返回 { path: content } 映射（前端负责别名重映射）
const readDataFilesBatch = (relPaths) => {
  const result = {};
  for (const p of relPaths) {
    try {
      result[p] = readDataFile(p);
    } catch (e) {
      result[p] = { __error: e.message };
    }
  }
  return result;
};

// ========== 别名映射管理 ==========
const aliasFilePath = path.resolve(dataDir, 'dc_file_aliases.json');

// 确保别名文件存在
const ensureAliasFile = () => {
  if (!fs.existsSync(aliasFilePath)) {
    fs.writeFileSync(aliasFilePath, JSON.stringify({}, null, 2));
  }
};

// 读取所有别名映射 { path: alias }
const getAliases = () => {
  ensureAliasFile();
  try {
    return JSON.parse(fs.readFileSync(aliasFilePath, 'utf-8')) || {};
  } catch {
    return {};
  }
};

// 保存别名映射（整体覆盖）
const saveAliases = (aliases) => {
  ensureAliasFile();
  fs.writeFileSync(aliasFilePath, JSON.stringify(aliases, null, 2));
};

// 设置单个别名（alias 为空字符串则删除）
const setAlias = (filePath, alias) => {
  const aliases = getAliases();
  if (alias && alias.trim()) {
    aliases[filePath] = alias.trim();
  } else {
    delete aliases[filePath];
  }
  saveAliases(aliases);
  return aliases;
};

// ========== 隐藏路径管理 ==========
const hiddenFilePath = path.resolve(dataDir, 'dc_hidden_paths.json');

const ensureHiddenFile = () => {
  if (!fs.existsSync(hiddenFilePath)) {
    fs.writeFileSync(hiddenFilePath, JSON.stringify([], null, 2));
  }
};

// 读取所有隐藏路径（数组）
const getHiddenPaths = () => {
  ensureHiddenFile();
  try {
    return JSON.parse(fs.readFileSync(hiddenFilePath, 'utf-8')) || [];
  } catch {
    return [];
  }
};

// 设置隐藏/显示（hidden=false 则移除）
const setHiddenPath = (filePath, hidden) => {
  const list = getHiddenPaths();
  const idx = list.indexOf(filePath);
  if (hidden && idx === -1) {
    list.push(filePath);
  } else if (!hidden && idx !== -1) {
    list.splice(idx, 1);
  }
  fs.writeFileSync(hiddenFilePath, JSON.stringify(list, null, 2));
  return list;
};

module.exports = {
  listDataFiles,
  readDataFile,
  readDataFilesBatch,
  getAliases,
  saveAliases,
  setAlias,
  getHiddenPaths,
  setHiddenPath,
};
