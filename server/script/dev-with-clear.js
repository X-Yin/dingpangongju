const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const MARKER_FILE = path.resolve(__dirname, '../.dev_last_clear_date');
const MEIGU_MARKER_FILE = path.resolve(__dirname, '../.dev_last_meigu_date');
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function getLastClearDate() {
  try {
    if (fs.existsSync(MARKER_FILE)) {
      return fs.readFileSync(MARKER_FILE, 'utf-8').trim();
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function saveTodayMarker() {
  try {
    fs.writeFileSync(MARKER_FILE, today, 'utf-8');
  } catch (e) {
    console.warn('写入启动日期标记失败:', e.message);
  }
}

function getLastMeiguDate() {
  try {
    if (fs.existsSync(MEIGU_MARKER_FILE)) {
      return fs.readFileSync(MEIGU_MARKER_FILE, 'utf-8').trim();
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function saveMeiguMarker() {
  try {
    fs.writeFileSync(MEIGU_MARKER_FILE, today, 'utf-8');
  } catch (e) {
    console.warn('写入美股拉取日期标记失败:', e.message);
  }
}

function runClear() {
  console.log(`[dev] 今日首次启动（${today}），执行数据清理...`);
  try {
    execSync('node script/clear.js', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
    });
    console.log('[dev] 数据清理完成');
    saveTodayMarker();
  } catch (e) {
    console.error('[dev] 数据清理失败，但将继续启动服务:', e.message);
    saveTodayMarker();
  }
}

// 拉取隔夜美股数据并按日期存储（每日首次启动时执行，含周末）
async function refreshMeigu() {
  console.log(`[dev] 今日首次启动，拉取隔夜美股数据...`);
  try {
    const { refreshOvernightMeiguData } = require('../src/service/meigu');
    const result = await refreshOvernightMeiguData();
    console.log(`[dev] 隔夜美股数据拉取完成（${result.data.length} 只股票，日期 ${result.date}）`);
  } catch (e) {
    console.error('[dev] 隔夜美股数据拉取失败，将继续启动服务:', e.message);
  }
  saveMeiguMarker();
}

function runDev() {
  console.log('[dev] 启动服务 node src/index.js ...');
  const child = spawn('node', ['src/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
}

async function main() {
  const lastDate = getLastClearDate();
  const lastMeiguDate = getLastMeiguDate();
  // 以交易日历为准判断今天是否为交易日（自动跳过周末与法定节假日）
  const { isTradingDay } = require('../src/utils/tradingDay');
  const isTradingDayToday = isTradingDay(new Date());

  if (!isTradingDayToday) {
    console.log(`[dev] 今日是非交易日（周末/节假日，${today}），跳过清理直接启动`);
  } else if (lastDate !== today) {
    runClear();
  } else {
    console.log(`[dev] 今日已清理过（${today}），跳过清理直接启动`);
  }

  // 隔夜美股数据拉取：每日首次启动时执行（含周末）
  if (lastMeiguDate !== today) {
    await refreshMeigu();
  } else {
    console.log(`[dev] 今日已拉取过隔夜美股数据（${today}），跳过`);
  }

  runDev();
}

main();
