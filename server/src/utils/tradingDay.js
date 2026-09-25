// 交易日历工具：以项目根目录（盯盘工具/）下的 YYYY交易日.json（如 2026交易日.json）为唯一交易日数据源
// 日历未覆盖的年份回退为「周一至周五」口径，避免跨年后判断失效
const fs = require('fs');
const path = require('path');

const CALENDAR_DIR = path.resolve(__dirname, '../../..');

// { '2026': Set('01-05', '01-06', ...) }
let calendarByYear = null;

const loadCalendars = () => {
    if (calendarByYear) return calendarByYear;
    calendarByYear = {};
    try {
        const files = fs.readdirSync(CALENDAR_DIR).filter(f => /^\d{4}交易日\.json$/.test(f));
        for (const file of files) {
            const year = file.slice(0, 4);
            try {
                const json = JSON.parse(fs.readFileSync(path.join(CALENDAR_DIR, file), 'utf-8'));
                const days = Array.isArray(json.trading_days) ? json.trading_days : [];
                calendarByYear[year] = new Set(days.map(d => String(d).slice(5))); // 只保留 'MM-DD'
            } catch (e) {
                console.error(`交易日历文件解析失败: ${file}`, e.message);
            }
        }
    } catch (e) {
        console.error('读取交易日历目录失败:', e.message);
    }
    return calendarByYear;
};

const pad2 = (n) => String(n).padStart(2, '0');
const toMonthDay = (date) => `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

// 是否为交易日（以交易日历为准；未覆盖年份按周一~周五回退）
const isTradingDay = (date = new Date()) => {
    const calendars = loadCalendars();
    const set = calendars[String(date.getFullYear())];
    if (!set || set.size === 0) {
        const dow = date.getDay();
        return dow !== 0 && dow !== 6;
    }
    return set.has(toMonthDay(date));
};

// 是否为非交易日（周末或法定节假日休市日）
const isNonTradingDay = (date = new Date()) => !isTradingDay(date);

// 前一个交易日（不含当日）
const getPrevTradingDay = (date = new Date()) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let i = 0; i < 40; i++) {
        d.setDate(d.getDate() - 1);
        if (isTradingDay(d)) return d;
    }
    return d;
};

// 下一个交易日（不含当日）
const getNextTradingDay = (date = new Date()) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    for (let i = 0; i < 40; i++) {
        d.setDate(d.getDate() + 1);
        if (isTradingDay(d)) return d;
    }
    return d;
};

// 截止 endDate（含当日）往前取 n 个交易日，返回升序 Date 数组
const getRecentTradingDays = (n = 5, endDate = new Date()) => {
    const dates = [];
    const d = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    let guard = 0;
    while (dates.length < n && guard < 200) {
        if (isTradingDay(d)) dates.unshift(new Date(d));
        d.setDate(d.getDate() - 1);
        guard += 1;
    }
    return dates;
};

// 'YYYYMMDD' 数字/字符串（或 'YYYY-MM-DD'）是否为交易日
const isTradingDateNum = (dateNum) => {
    const d = parseDateNum(dateNum);
    return d ? isTradingDay(d) : false;
};

// 'YYYYMMDD' 数字/字符串或 'YYYY-MM-DD' 解析为本地 Date（非法输入返回 null）
const parseDateNum = (dateNum) => {
    const str = String(dateNum == null ? '' : dateNum).replace(/-/g, '');
    if (!/^\d{8}$/.test(str)) return null;
    return new Date(Number(str.slice(0, 4)), Number(str.slice(4, 6)) - 1, Number(str.slice(6, 8)));
};

// 日期（Date 或 'YYYYMMDD'/'YYYY-MM-DD' 字符串）所在年份是否有交易日历数据
// 无日历数据的年份相关计算会按周一~周五回退，调用方可据此标记「退化估算」
const isYearCovered = (date) => {
    const d = date instanceof Date ? date : parseDateNum(date);
    if (!d) return false;
    const set = loadCalendars()[String(d.getFullYear())];
    return !!(set && set.size > 0);
};

// 统计 (start, end] 区间内的交易日数量（start/end 支持 Date 或 'YYYYMMDD'/'YYYY-MM-DD' 字符串）
// 常用于持仓天数：卖出日相对买入日的交易日跨度（当日买入卖出为 0）
// 区间内未覆盖年份的日期按周一~周五回退判断；参数非法或 start 晚于 end 返回 null
const countTradingDaysBetween = (start, end) => {
    const s = start instanceof Date ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : parseDateNum(start);
    const e = end instanceof Date ? new Date(end.getFullYear(), end.getMonth(), end.getDate()) : parseDateNum(end);
    if (!s || !e || e < s) return null;
    let count = 0;
    const cur = new Date(s);
    cur.setDate(cur.getDate() + 1);
    while (cur <= e) {
        if (isTradingDay(cur)) count += 1;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
};

module.exports = { isTradingDay, isNonTradingDay, getPrevTradingDay, getNextTradingDay, getRecentTradingDays, isTradingDateNum, parseDateNum, isYearCovered, countTradingDaysBetween };
