const { dayjs, fs, getMonitorStocks, path } = require('../deps');
const { researchReportsDir } = require('../paths');

let reportIndexCache = null; // { YYYYMMDD: { stockName: [createdAtMs, ...] } }（每条命中研报记录一次创建时间）
let reportIndexMtime = 0; // menu.json 修改时间，用于检测新增/编辑研报后自动重建索引

// 读取报告正文内容（id.json 存放 { content }），供正文匹配股票名使用
const readReportContent = (id) => {
  try {
    const contentPath = path.join(researchReportsDir, `${id}.json`);
    if (!fs.existsSync(contentPath)) return '';
    return JSON.parse(fs.readFileSync(contentPath, 'utf-8')).content || '';
  } catch {
    return '';
  }
};

const loadReportIndex = () => {
  const menuFile = path.join(researchReportsDir, 'menu.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(menuFile).mtimeMs;
  } catch {
    // menu.json 不存在时按 0 处理
  }
  if (reportIndexCache && mtime === reportIndexMtime) return reportIndexCache;
  const { getMonitorStocks } = require('../../monitorStock');
  const stockNames = Array.from(new Set(
    getMonitorStocks().map(s => s.name).filter(Boolean)
  )).sort((a, b) => b.length - a.length); // 长名优先，避免"天孚通信"被"通信"误配
  const index = {};
  try {
    const menu = JSON.parse(fs.readFileSync(menuFile, 'utf-8'));
    const walk = (node, folderDate) => {
      if (!node) return;
      if (node.type === 'folder') {
        const date = String(node.name || '');
        if (!/^\d{8}$/.test(date)) return;
        for (const child of (node.children || [])) walk(child, date);
      } else if (node.type === 'report') {
        const id = String(node.id || '');
        if (!folderDate || !id) return;
        // 标题或正文命中股票名的都计入覆盖（正文如"相关国内标的：天孚通信，仕佳光子"）
        const text = `${String(node.name || '')}\n${readReportContent(id)}`;
        const matchedNames = stockNames.filter(n => text.includes(n));
        if (matchedNames.length === 0) return;
        if (!index[folderDate]) index[folderDate] = {};
        // 记录该研报的创建时间（ms，UTC ISO 转绝对时间戳）；缺失/非法按 0（视为始终已存在）
        const createdAtMs = Date.parse(node.createdAt) || 0;
        for (const n of matchedNames) {
          if (!index[folderDate][n]) index[folderDate][n] = [];
          index[folderDate][n].push(createdAtMs);
        }
      }
    };
    for (const root of menu) walk(root, null);
  } catch (e) {
    console.error('研报索引加载失败:', e.message);
  }
  reportIndexCache = index;
  reportIndexMtime = mtime;
  return index;
};

// 某只股票在 winDates（升序）内的研报覆盖总数
// beforeTs：买点时间戳（ms）。传入时只统计 createdAt ≤ 买点时间的研报，
// 排除买点之后才录入（如盘后补录）的研报对历史回测统计的污染；不传则统计全部
const sumReportCount = (stockName, winDates, reportIndex, beforeTs) => {
  if (!stockName || !reportIndex) return 0;
  let count = 0;
  for (const d of winDates) {
    const day = reportIndex[d];
    if (!day) continue;
    const arr = day[stockName];
    if (!arr) continue;
    if (beforeTs == null) {
      count += arr.length;
    } else {
      for (const ts of arr) {
        if (ts <= beforeTs) count += 1;
      }
    }
  }
  return count;
};

/**
 * 获取某只股票最近 N 个报告日内（以 menu.json 文件夹名 YYYYMMDD 为报告日）
 * 标题或正文命中该股票名的全部研报（含 id / 标题 / 正文 / 报告日 / 更新时间）。
 * 报告日筛选窗口与 loadReportIndex 一致：研报目录中 ≤ 今日 的最近 N 个报告日。
 * stockNames 按「长名优先」匹配避免短名误配（与 loadReportIndex 保持一致）。
 */
const getStockRecentReports = (stockName, days = 5) => {
  if (!stockName) return [];
  const menuFile = path.join(researchReportsDir, 'menu.json');
  let menu;
  try {
    menu = JSON.parse(fs.readFileSync(menuFile, 'utf-8'));
  } catch (e) {
    return [];
  }

  // 收集所有 folderDate（只取 8 位数字，视作报告日）
  const allDates = new Set();
  const collectDates = (node) => {
    if (!node) return;
    if (node.type === 'folder') {
      const d = String(node.name || '');
      if (/^\d{8}$/.test(d)) {
        allDates.add(d);
      }
      for (const c of (node.children || [])) collectDates(c);
    }
  };
  for (const root of menu) collectDates(root);

  const today = dayjs().format('YYYYMMDD');
  const winDates = Array.from(allDates)
    .filter(d => d <= today)
    .sort()
    .slice(-days);

  if (winDates.length === 0) return [];
  const winSet = new Set(winDates);

  // 构造 stockNames（若只给了一个名字，取它自己即可；长名优先匹配）
  const stockNames = [stockName].sort((a, b) => b.length - a.length);

  const results = [];
  const walk = (node, folderDate) => {
    if (!node) return;
    if (node.type === 'folder') {
      const d = String(node.name || '');
      if (!/^\d{8}$/.test(d)) return;
      for (const child of (node.children || [])) walk(child, d);
    } else if (node.type === 'report') {
      if (!winSet.has(folderDate)) return;
      const id = String(node.id || '');
      if (!id) return;
      const content = readReportContent(id);
      const text = `${String(node.name || '')}\n${content}`;
      const matched = stockNames.some(n => n && text.includes(n));
      if (!matched) return;
      results.push({
        id,
        name: node.name || '',
        content: content || '',
        folderDate,
        updatedAt: node.updatedAt || '',
        createdAt: node.createdAt || '',
      });
    }
  };
  for (const root of menu) walk(root, null);

  // 按报告日降序、同一天内按更新时间降序
  results.sort((a, b) => {
    if (b.folderDate !== a.folderDate) return b.folderDate.localeCompare(a.folderDate);
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return results;
};

// ============================================================
// 以下为买点诊断移植（对齐 src/pages/trainingCamp/utils/buyPointChecks.js）

module.exports = {
  getStockRecentReports,
  loadReportIndex,
  readReportContent,
  reportIndexCache,
  reportIndexMtime,
  sumReportCount,
};
