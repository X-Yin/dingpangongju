// 交易日历工具：以项目根目录（盯盘工具/）下的 YYYY交易日.json（如 2026交易日.json）为唯一交易日数据源
// 通过 Vite import.meta.glob 构建期加载，与后端 server/src/utils/tradingDay.js 共用同一份日历文件
// 日历未覆盖的年份回退为「周一至周五」口径
import dayjs from 'dayjs';

// 加载根目录全部 YYYY交易日.json → { '2026': Set('MM-DD', ...) }
const calendarModules = import.meta.glob('../../../*交易日.json', { eager: true, import: 'default' });

const calendarByYear = {};
for (const [file, mod] of Object.entries(calendarModules)) {
  const year = (file.match(/(\d{4})交易日\.json$/) || [])[1];
  if (!year) continue;
  const days = Array.isArray(mod?.trading_days) ? mod.trading_days : [];
  calendarByYear[year] = new Set(days.map((d) => String(d).slice(5)));
}

// 是否为交易日（以交易日历为准；未覆盖年份按周一~周五回退）
export const isTradingDay = (date = new Date()) => {
  const d = dayjs(date);
  const set = calendarByYear[String(d.year())];
  if (!set || set.size === 0) {
    const dow = d.day();
    return dow !== 0 && dow !== 6;
  }
  return set.has(d.format('MM-DD'));
};

// 是否为非交易日（周末或法定节假日休市日）
export const isNonTradingDay = (date = new Date()) => !isTradingDay(date);

// 前一个交易日（不含当日），返回 dayjs 对象
export const getPrevTradingDay = (date = new Date()) => {
  const d = dayjs(date).startOf('day');
  for (let i = 1; i <= 40; i++) {
    const prev = d.subtract(i, 'day');
    if (isTradingDay(prev)) return prev;
  }
  return d;
};

// 下一个交易日（不含当日），返回 dayjs 对象
export const getNextTradingDay = (date = new Date()) => {
  const d = dayjs(date).startOf('day');
  for (let i = 1; i <= 40; i++) {
    const next = d.add(i, 'day');
    if (isTradingDay(next)) return next;
  }
  return d;
};

// 是否已收盘（非交易日视为已收盘；交易日 9:15 前或 14:59 及以后为非盘中）
export const isAfterMarketClose = (date = new Date()) => {
  if (!isTradingDay(date)) return true;
  const d = dayjs(date);
  const h = d.hour();
  const m = d.minute();
  return h < 9 || (h === 9 && m < 15) || h >= 15 || (h === 14 && m >= 59);
};
