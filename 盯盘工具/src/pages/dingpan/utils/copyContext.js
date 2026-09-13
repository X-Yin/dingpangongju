import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../../constant';

const BASE = `http://${local_ip}:3000`;

const formatHHMM = (t) => {
    if (!t) return '';
    const s = String(t);
    return `${s.substring(0, 2)}:${s.substring(2, 4)}`;
};

const dateIntToLabel = (dateInt) => {
    const s = String(dateInt);
    return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
};

const formatMoney = (v) => {
    const n = Number(v) || 0;
    return (n >= 0 ? '+' : '') + n.toFixed(2);
};

// 后端历史数据中 mainMoney/amountChangeDiff 可能是 "+12.34亿" 形式的字符串
const parseMoneyValue = (val) => {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    let str = String(val);
    const sign = str.startsWith('-') ? -1 : 1;
    if (str.startsWith('+') || str.startsWith('-')) str = str.slice(1);
    let num = parseFloat(str.replace(/亿|万/g, '')) || 0;
    if (String(val).indexOf('万') !== -1) num = num / 10000;
    return sign * num;
};

// 指数分时按 N 分钟采样以控制体积，保留趋势形态并确保包含收盘点
const sampleIndexLine = (line, stepMin = 15) => {
    if (!line || !line.length) return [];
    const sorted = [...line].sort((a, b) => String(a.minute).localeCompare(String(b.minute)));
    const result = [];
    let lastEmittedMin = -Infinity;
    sorted.forEach((item) => {
        const m = String(item.minute);
        const total = parseInt(m.substring(0, 2)) * 60 + parseInt(m.substring(2, 4));
        const price = Number(item.last_px ?? item.av_px);
        if (Number.isNaN(price)) return;
        if (total - lastEmittedMin >= stepMin) {
            result.push({ time: `${m.substring(0, 2)}:${m.substring(2, 4)}`, price });
            lastEmittedMin = total;
        }
    });
    const last = sorted[sorted.length - 1];
    const lm = String(last.minute);
    const lt = `${lm.substring(0, 2)}:${lm.substring(2, 4)}`;
    const lastPrice = Number(last.last_px ?? last.av_px);
    if (!Number.isNaN(lastPrice) && (!result.length || result[result.length - 1].time !== lt)) {
        result.push({ time: lt, price: lastPrice });
    }
    return result;
};

const chunkedAll = async (items, fn, concurrency = 5, onProgress) => {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;
    const total = items.length;
    const run = async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            try {
                results[idx] = await fn(items[idx], idx);
            } catch (e) {
                results[idx] = null;
            }
            done++;
            if (onProgress) onProgress(done, total);
        }
    };
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(run);
    await Promise.all(workers);
    return results;
};

const copyToClipboard = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
};

const buildFundSeries = (fund, field) => {
    const arr = fund?.[field === 'mainMoney' ? 'fund5min' : 'amount10min'] || [];
    if (!arr.length) return [];
    const map = new Map();
    arr.forEach((it) => {
        const t = it.rawTime || it.time;
        if (t) map.set(t, it);
    });
    return [...map.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([t, it]) => ({ time: formatHHMM(t), value: parseMoneyValue(it[field]) }));
};

const buildTodaySeriesFromHistory = (historyData, field) => {
    if (!historyData || !historyData.length) return [];
    const map = new Map();
    historyData.forEach(([t, item]) => {
        if (t) map.set(t, item);
    });
    return [...map.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([t, item]) => ({ time: formatHHMM(t), value: parseMoneyValue(item[field]) }));
};

const renderSeries = (series, fmt) => {
    if (!series.length) return '（无数据）';
    return series.map((p) => `${p.time}  ${fmt(p.value)}`).join('\n');
};

const renderIndexSeries = (series) => {
    if (!series.length) return '（无数据）';
    return series.map((p) => `${p.time}  ${p.price.toFixed(2)}`).join('\n');
};

const INDEX_KEYS = [
    { key: 'chuangyeban', name: '创业板' },
    { key: 'kechuangban', name: '科创板' },
];

const buildText = ({ notes, perDate, todayFund, todayTline, todayNote, historyData }) => {
    const L = [];
    const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
    L.push('='.repeat(48));
    L.push('复盘上下文（供 AI 预测行情）');
    L.push(`生成时间：${now}`);
    L.push('='.repeat(48));
    L.push('');

    const noteByDate = new Map();
    notes.forEach((n) => noteByDate.set(n.date, n));

    L.push('='.repeat(48));
    L.push('一、历史复盘分析（按日期，最新在前）');
    L.push('='.repeat(48));
    L.push('');

    if (!perDate.length) {
        L.push('（暂无历史复盘记录）');
        L.push('');
    }

    perDate.forEach(({ date, fund, tline }) => {
        const note = noteByDate.get(date);
        L.push(`【日期：${dateIntToLabel(date)}】`);
        if (note?.tag) L.push(`标签：${note.tag}`);
        L.push('—— 复盘笔记 ——');
        const content = note?.content?.trim();
        L.push(content || '（无）');
        L.push('');

        const mmSeries = buildFundSeries(fund, 'mainMoney');
        L.push(`—— 主力资金净流入分时（亿，共 ${mmSeries.length} 点）——`);
        L.push(renderSeries(mmSeries, formatMoney));
        if (mmSeries.length) L.push(`当日收盘：${formatMoney(mmSeries[mmSeries.length - 1].value)}`);
        L.push('');

        const volSeries = buildFundSeries(fund, 'amountChangeDiff');
        L.push(`—— 成交量分时变化（亿，共 ${volSeries.length} 点）——`);
        L.push(renderSeries(volSeries, formatMoney));
        L.push('');

        INDEX_KEYS.forEach(({ key, name }) => {
            const sampled = sampleIndexLine(tline?.[key]?.line, 15);
            L.push(`—— ${name}指数分时（15 分钟采样，共 ${sampled.length} 点）——`);
            L.push(renderIndexSeries(sampled));
            if (sampled.length) L.push(`当日收盘：${sampled[sampled.length - 1].price.toFixed(2)}`);
            L.push('');
        });

        L.push('-'.repeat(48));
        L.push('');
    });

    L.push('='.repeat(48));
    L.push(`二、今日实时数据（${dayjs().format('YYYY-MM-DD')}）`);
    L.push('='.repeat(48));
    L.push('');

    // 今日主力资金 / 成交量：优先用当日 fund_snapshot 全量数据，缺失时回退到盯盘实时 historyData
    let todayMM = buildFundSeries(todayFund, 'mainMoney');
    if (!todayMM.length) todayMM = buildTodaySeriesFromHistory(historyData, 'mainMoney');
    let todayVol = buildFundSeries(todayFund, 'amountChangeDiff');
    if (!todayVol.length) todayVol = buildTodaySeriesFromHistory(historyData, 'amountChangeDiff');

    L.push(`—— 主力资金净流入分时（亿，实时，共 ${todayMM.length} 点）——`);
    L.push(renderSeries(todayMM, formatMoney));
    if (todayMM.length) L.push(`当前：${formatMoney(todayMM[todayMM.length - 1].value)}`);
    L.push('');

    L.push(`—— 成交量分时变化（亿，实时，共 ${todayVol.length} 点）——`);
    L.push(renderSeries(todayVol, formatMoney));
    L.push('');

    INDEX_KEYS.forEach(({ key, name }) => {
        const sampled = sampleIndexLine(todayTline?.[key]?.line, 15);
        L.push(`—— ${name}指数分时（实时，15 分钟采样，共 ${sampled.length} 点）——`);
        L.push(renderIndexSeries(sampled));
        if (sampled.length) L.push(`当前：${sampled[sampled.length - 1].price.toFixed(2)}`);
        L.push('');
    });

    L.push('—— 今日复盘笔记 ——');
    L.push(todayNote?.trim() || '（暂无）');
    L.push('');

    L.push('='.repeat(48));
    L.push('三、AI 提问');
    L.push('='.repeat(48));
    L.push('');
    L.push('基于以上历史复盘分析内容和今日的分时数据，请：');
    L.push('1. 预测接下来的行情会怎么走（如果今天收盘预测明天的行情，如果今天未收盘，预测今天接下来剩下时间的行情）');
    L.push('2. 有哪些需要特别注意的风险和机会；');
    L.push('3. 过去历史日期中有没有可重复借鉴的经验或规律，请具体引用日期与当时的分时特征进行说明。');
    L.push('');

    return L.join('\n');
};

// historyData: 盯盘页实时主力资金/成交量历史（[[timeStr, {mainMoney, amountChangeDiff, ...}], ...]）
// onProgress(done, total): 拉取历史日期数据时的进度回调
export const fetchAndCopyContext = async ({ historyData, onProgress }) => {
    const todayInt = parseInt(dayjs().format('YYYYMMDD'));

    const notesRes = await axios.get(`${BASE}/fupan/notes`).catch(() => null);
    const notes = (notesRes?.data?.data || []).filter((n) => n.content && String(n.content).trim());
    const noteDates = notes
        .map((n) => n.date)
        .filter((d) => d !== todayInt)
        .sort((a, b) => b - a);

    const perDate = await chunkedAll(noteDates, async (dateInt) => {
        const [fundRes, tlineRes] = await Promise.all([
            axios.get(`${BASE}/fund_snapshot/data?date=${dateInt}`).catch(() => null),
            axios.get(`${BASE}/fupan/index_tline?date=${dateInt}`).catch(() => null),
        ]);
        return {
            date: dateInt,
            fund: fundRes?.data?.success ? fundRes.data.data : null,
            tline: tlineRes?.data?.success ? tlineRes.data.data : null,
        };
    }, 5, onProgress);

    const [todayFundRes, todayTlineRes, todayNoteRes] = await Promise.all([
        axios.get(`${BASE}/fund_snapshot/data?date=${todayInt}`).catch(() => null),
        axios.get(`${BASE}/fupan/index_tline?date=${todayInt}`).catch(() => null),
        axios.get(`${BASE}/fupan/note?date=${todayInt}`).catch(() => null),
    ]);

    const text = buildText({
        notes,
        perDate,
        todayFund: todayFundRes?.data?.success ? todayFundRes.data.data : null,
        todayTline: todayTlineRes?.data?.success ? todayTlineRes.data.data : null,
        todayNote: todayNoteRes?.data?.success ? todayNoteRes.data.data?.content : '',
        historyData,
    });

    await copyToClipboard(text);
    return { charCount: text.length, dateCount: noteDates.length };
};
