const fs = require('fs');
const path = require('path');
const { getSingleStockTlineDataByDate, getSingleStockTlineData } = require('./stock');
const { getAllIndexKlineData, getLatestTechEmotion } = require('./emotion');
const { getAmountHistory } = require('./amount');
const { timestampToMinute } = require('../utils');

const fupanDataPath = path.resolve(__dirname, '../data/fupan_notes.json');
const personalFeelingsPath = path.resolve(__dirname, '../data/personal_feelings.json');
const todayPlanPath = path.resolve(__dirname, '../data/today_plan.json');

const formatDateStr = (dateNum) => {
  if (!dateNum) return '';
  const str = String(dateNum);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
};

const ensureDataFile = () => {
  if (!fs.existsSync(fupanDataPath)) {
    fs.writeFileSync(fupanDataPath, JSON.stringify([], null, 2));
  }
};

const getAllFupanNotes = () => {
  ensureDataFile();
  try {
    const data = fs.readFileSync(fupanDataPath, 'utf-8') || '[]';
    const notes = JSON.parse(data);
    const notesWithDefaults = notes.map(note => ({
      ...note,
      title: note.title || formatDateStr(note.date) + ' 复盘'
    }));
    return notesWithDefaults.sort((a, b) => b.date - a.date);
  } catch (error) {
    console.error('读取复盘笔记失败:', error);
    return [];
  }
};

const getFupanNoteByDate = (date) => {
  ensureDataFile();
  try {
    const data = fs.readFileSync(fupanDataPath, 'utf-8') || '[]';
    const notes = JSON.parse(data);
    const note = notes.find(n => n.date === parseInt(date)) || null;
    if (note && !note.title) {
      note.title = formatDateStr(note.date) + ' 复盘';
    }
    return note;
  } catch (error) {
    console.error('读取复盘笔记失败:', error);
    return null;
  }
};

const saveFupanNote = ({ date, title, content, tag, tagColor }) => {
  ensureDataFile();
  try {
    const data = fs.readFileSync(fupanDataPath, 'utf-8') || '[]';
    const notes = JSON.parse(data);
    const dateInt = parseInt(date);
    const existingIndex = notes.findIndex(note => note.date === dateInt);

    const noteTitle = (title && title.trim()) ? title.trim() : formatDateStr(dateInt) + ' 复盘';
    const noteTag = (tag && tag.trim()) ? tag.trim() : '';
    const noteTagColor = tagColor || 'red';

    if (existingIndex !== -1) {
      notes[existingIndex].title = noteTitle;
      notes[existingIndex].content = content;
      notes[existingIndex].tag = noteTag;
      notes[existingIndex].tagColor = noteTagColor;
      notes[existingIndex].updatedAt = new Date().toISOString();
    } else {
      notes.push({
        date: dateInt,
        title: noteTitle,
        content,
        tag: noteTag,
        tagColor: noteTagColor,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    fs.writeFileSync(fupanDataPath, JSON.stringify(notes, null, 2));
    return { success: true, date: dateInt, title: noteTitle, tag: noteTag, tagColor: noteTagColor };
  } catch (error) {
    console.error('保存复盘笔记失败:', error);
    return { success: false, error: error.message };
  }
};

const deleteFupanNote = (date) => {
  ensureDataFile();
  try {
    const data = fs.readFileSync(fupanDataPath, 'utf-8') || '[]';
    let notes = JSON.parse(data);
    const dateInt = parseInt(date);
    notes = notes.filter(note => note.date !== dateInt);
    fs.writeFileSync(fupanDataPath, JSON.stringify(notes, null, 2));
    return { success: true };
  } catch (error) {
    console.error('删除复盘笔记失败:', error);
    return { success: false, error: error.message };
  }
};

const getTodayDateInt = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return parseInt(`${year}${month}${day}`);
};

const getIndexTlineByDate = async (tradeDate) => {
  try {
    const shangzhengCode = 'sh000001';
    const chuangyebanCode = 'sz399006';
    const kechuangbanCode = 'sh000688';
    const dateInt = parseInt(tradeDate);
    const todayInt = getTodayDateInt();
    
    const getTlineData = async (code) => {
      let result = await getSingleStockTlineDataByDate(code, dateInt);
      
      if (!result || !result.line || result.line.length === 0) {
        if (dateInt === todayInt) {
          console.log(`历史数据获取失败 ${code} ${dateInt}，尝试实时数据接口`);
          result = await getSingleStockTlineData(code);
          if (result) {
            result.date = dateInt;
            if (result.line && Array.isArray(result.line)) {
              result.line = result.line.map(item => {
                if (!item.minute && (item.time || item.timestamp)) {
                  item.minute = timestampToMinute(item.time || item.timestamp);
                }
                return { ...item, date: dateInt };
              });
            }
          }
        } else {
          console.log(`历史数据获取失败 ${code} ${dateInt}，非当天日期不尝试实时数据`);
        }
      }
      
      if (result && result.line && Array.isArray(result.line)) {
        const validLine = result.line.filter(item => {
          return item && item.minute && (item.last_px || item.av_px);
        });
        result.line = validLine;
        if (validLine.length === 0) {
          return null;
        }
      }
      
      return result;
    };
    
    const [shangzhengTline, chuangyebanTline, kechuangbanTline] = await Promise.all([
      getTlineData(shangzhengCode),
      getTlineData(chuangyebanCode),
      getTlineData(kechuangbanCode)
    ]);
    
    console.log(`获取指数分时数据完成 ${dateInt}:`, {
      shangzheng: shangzhengTline?.line?.length || 0,
      chuangyeban: chuangyebanTline?.line?.length || 0,
      kechuangban: kechuangbanTline?.line?.length || 0
    });
    
    return {
      shangzheng: shangzhengTline,
      chuangyeban: chuangyebanTline,
      kechuangban: kechuangbanTline,
    };
  } catch (error) {
    console.error('获取指数分时数据失败:', error);
    return {
      shangzheng: null,
      chuangyeban: null,
      kechuangban: null,
    };
  }
};

const ensurePersonalFeelingsFile = () => {
  if (!fs.existsSync(personalFeelingsPath)) {
    fs.writeFileSync(personalFeelingsPath, JSON.stringify([], null, 2));
  }
};

const getPersonalFeelings = (date) => {
  ensurePersonalFeelingsFile();
  try {
    const data = fs.readFileSync(personalFeelingsPath, 'utf-8') || '[]';
    const all = JSON.parse(data);
    const dateInt = parseInt(date);
    const entry = all.find(item => item.date === dateInt);
    if (entry) {
      const records = (entry.records || []).slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      return { date: dateInt, records };
    }
    return { date: dateInt, records: [] };
  } catch (error) {
    console.error('读取个人感受记录失败:', error);
    return { date: parseInt(date), records: [] };
  }
};

const savePersonalFeelings = ({ date, records }) => {
  ensurePersonalFeelingsFile();
  try {
    const data = fs.readFileSync(personalFeelingsPath, 'utf-8') || '[]';
    const all = JSON.parse(data);
    const dateInt = parseInt(date);
    const existingIndex = all.findIndex(item => item.date === dateInt);

    const cleanRecords = (records || [])
      .filter(r => r && r.time)
      .map(r => ({ time: r.time, feeling: r.feeling || '' }))
      .sort((a, b) => a.time.localeCompare(b.time));

    if (existingIndex !== -1) {
      all[existingIndex].records = cleanRecords;
      all[existingIndex].updatedAt = new Date().toISOString();
    } else {
      all.push({
        date: dateInt,
        records: cleanRecords,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    fs.writeFileSync(personalFeelingsPath, JSON.stringify(all, null, 2));
    return { success: true, date: dateInt, records: cleanRecords };
  } catch (error) {
    console.error('保存个人感受记录失败:', error);
    return { success: false, error: error.message };
  }
};

// ===== 今日交易计划 =====
const ensureTodayPlanFile = () => {
  if (!fs.existsSync(todayPlanPath)) {
    fs.writeFileSync(todayPlanPath, JSON.stringify({ content: '', updatedAt: null }, null, 2));
  }
};

const getTodayPlan = () => {
  ensureTodayPlanFile();
  try {
    const data = fs.readFileSync(todayPlanPath, 'utf-8');
    const parsed = JSON.parse(data);
    return { content: parsed.content || '', updatedAt: parsed.updatedAt || null };
  } catch (error) {
    console.error('读取今日计划失败:', error);
    return { content: '', updatedAt: null };
  }
};

const saveTodayPlan = ({ content }) => {
  ensureTodayPlanFile();
  try {
    const payload = {
      content: content || '',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(todayPlanPath, JSON.stringify(payload, null, 2));
    return { success: true, data: payload };
  } catch (error) {
    console.error('保存今日计划失败:', error);
    return { success: false, error: error.message };
  }
};

// 获取当前市场快照（用于个人感受记录自动填充）：
// 创业板指/科创50当前涨幅（分时最新点）、科技情绪、主力资金净流入、两市成交额
const getMarketSnapshot = async () => {
  const latestChange = (tline) => {
    if (!tline || !Array.isArray(tline.line) || tline.line.length === 0) return null;
    const changes = tline.line
      .map(i => i.change)
      .filter(c => c !== null && c !== undefined && !isNaN(c));
    return changes.length ? parseFloat(changes[changes.length - 1].toFixed(2)) : null;
  };

  const [cybTline, kcbTline] = await Promise.all([
    getSingleStockTlineData('sz399006').catch(() => null),
    getSingleStockTlineData('sh000688').catch(() => null),
  ]);

  // amount.json 最新一条（mainMoney/amountChangeDiff 已解析为亿数值）
  let amountLatest = null;
  try {
    const amountHistory = getAmountHistory();
    if (amountHistory.length > 0) {
      amountLatest = amountHistory[amountHistory.length - 1][1];
    }
  } catch (error) {
    console.error('读取主力资金/成交额数据失败:', error.message);
  }

  return {
    cybChange: latestChange(cybTline),
    kcbChange: latestChange(kcbTline),
    techEmotion: getLatestTechEmotion(),
    mainMoney: amountLatest?.mainMoney ?? null,
    amountChangeDiff: amountLatest?.amountChangeDiff ?? null,
  };
};

module.exports = {
  getAllFupanNotes,
  getFupanNoteByDate,
  saveFupanNote,
  deleteFupanNote,
  getIndexTlineByDate,
  getAllIndexKlineData,
  getPersonalFeelings,
  savePersonalFeelings,
  getMarketSnapshot,
  getTodayPlan,
  saveTodayPlan,
};
