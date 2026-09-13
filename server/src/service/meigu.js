const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const axios = require('axios');
const { MEI_GU_STOCK_CODE } = require('../constant/meigu');

const MEIGU_DIR = path.join(__dirname, '../data/meiguSnapshot');

function ensureDir() {
  if (!fs.existsSync(MEIGU_DIR)) {
    fs.mkdirSync(MEIGU_DIR, { recursive: true });
  }
}

function getMeiguFilePath(dateStr) {
  return path.join(MEIGU_DIR, `${dateStr}.json`);
}

async function fetchMeiguData() {
  const codes = Object.values(MEI_GU_STOCK_CODE);
  const url = `https://w.sinajs.cn/list=${codes.join(',')}`;
  const response = await axios.get(url, {
    headers: {
      'Referer': 'https://finance.sina.com.cn',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    responseType: 'text',
    timeout: 15000,
  });

  const text = response.data;
  const codeToName = {};
  for (const [cnName, code] of Object.entries(MEI_GU_STOCK_CODE)) {
    codeToName[code] = cnName;
  }

  const stocks = [];
  const regex = /var\s+hq_str_(gb_\w+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const code = match[1];
    const fields = match[2].split(',');
    if (fields.length < 8 || !fields[0]) continue;
    stocks.push({
      name: codeToName[code] || fields[0],
      code,
      price: parseFloat(fields[1]) || 0,
      changePercent: parseFloat(fields[2]) || 0,
      datetime: fields[3] || '',
      changeAmount: parseFloat(fields[4]) || 0,
      open: parseFloat(fields[5]) || 0,
      high: parseFloat(fields[6]) || 0,
      low: parseFloat(fields[7]) || 0,
    });
  }
  stocks.sort((a, b) => b.changePercent - a.changePercent);
  return stocks;
}

// 拉取最新隔夜美股数据并按当天日期存储
async function refreshOvernightMeiguData() {
  ensureDir();
  const dateStr = dayjs().format('YYYYMMDD');
  const stocks = await fetchMeiguData();
  const payload = {
    date: dateStr,
    fetchTime: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    data: stocks,
  };
  fs.writeFileSync(getMeiguFilePath(dateStr), JSON.stringify(payload, null, 2));
  return payload;
}

// 读取指定日期的隔夜美股数据，dateStr 为 YYYYMMDD
function getOvernightMeiguData(dateStr) {
  if (!dateStr) return null;
  const filePath = getMeiguFilePath(dateStr);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error('读取隔夜美股数据失败:', e.message);
    return null;
  }
}

// 获取已有数据中最新的日期（YYYYMMDD），无数据返回 null
function getLatestMeiguDate() {
  ensureDir();
  const files = fs.readdirSync(MEIGU_DIR)
    .filter(f => /^\d{8}\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return files[files.length - 1].replace('.json', '');
}

module.exports = {
  refreshOvernightMeiguData,
  getOvernightMeiguData,
  getLatestMeiguDate,
  fetchMeiguData,
};
