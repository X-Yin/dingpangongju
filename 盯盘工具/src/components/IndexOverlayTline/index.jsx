import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Card, Tag, Empty, Spin, Segmented } from 'antd';
import { LineChartOutlined } from '@ant-design/icons';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../constant';
import './index.scss';

const STORAGE_KEY_INDEX = 'index_overlay_tline_index';

const INDEX_OPTIONS = [
    { label: '创业板指', value: 'sz399006' },
    { label: '科创50', value: 'sh000688' },
];

// 历史日期折线颜色调色板（相似度 Top3 依次取色，当下线使用 REALTIME_COLOR）
const DATE_COLORS = ['#cf1322', '#389e0d', '#fa8c16'];

// 当下（实时）折线颜色：实线红色
const REALTIME_COLOR = '#f5222d';

// ===== 相似度对比算法 =====
const HISTORY_DAYS = 100;      // 回看历史交易日数
const MIN_COMPARE_POINTS = 5;  // 当下分时至少积累的网格点数，不足则暂不比较
const HISTORY_POOL_SIZE = 6;   // 历史分时并发拉取数

// 交易分钟网格：9:31-11:30（120 格）+ 13:01-15:00（120 格），共 240 格
const GRID_MINUTES = (() => {
    const arr = [];
    for (let m = 931; m <= 1130; m++) arr.push(m);
    for (let m = 1301; m <= 1500; m++) arr.push(m);
    return arr;
})();

// 从指数分时数据中提取 {minute, change} 序列
const extractChangeLine = (indexData) => {
    if (!indexData || !indexData.line || !Array.isArray(indexData.line)) return [];
    return indexData.line
        .filter(item => item && item.minute && item.change != null)
        .map(item => ({ minute: item.minute, change: parseFloat(item.change) || 0 }));
};

// 分时序列映射到固定网格：每个网格刻度取 ≤ 该时刻的最近一分钟涨幅（前值填充）
// 9:30/9:25 竞价点并入首个网格刻度；午休空档由 11:30 值自然填充
const mapLineToGrid = (line) => {
    const grid = new Array(GRID_MINUTES.length).fill(null);
    if (!Array.isArray(line)) return grid;
    const points = line
        .filter(p => p && Number.isFinite(p.minute) && Number.isFinite(p.change))
        .sort((a, b) => a.minute - b.minute);
    let lastVal = null;
    let ptr = 0;
    for (let i = 0; i < grid.length; i++) {
        const gm = GRID_MINUTES[i];
        while (ptr < points.length && points[ptr].minute <= gm) {
            lastVal = points[ptr].change;
            ptr += 1;
        }
        grid[i] = lastVal;
    }
    return grid;
};

// 网格中最后一个非空刻度下标（= "当下"时刻）
const getGridCutoff = (grid) => {
    for (let i = grid.length - 1; i >= 0; i--) {
        if (grid[i] != null) return i;
    }
    return -1;
};

// 统计 [0, cutoff] 区间内有效点数
const countGridValid = (grid, cutoff) => {
    let count = 0;
    for (let i = 0; i <= cutoff && i < grid.length; i++) {
        if (grid[i] != null) count += 1;
    }
    return count;
};

// 截取 [0, cutoff] 切片，头部缺失用首个有效值回填（视为开盘即该值）；全空返回 null
const sliceAndFill = (grid, cutoff) => {
    const out = grid.slice(0, cutoff + 1);
    let first = null;
    for (let i = 0; i < out.length; i++) {
        if (out[i] != null) { first = out[i]; break; }
    }
    if (first == null) return null;
    for (let i = 0; i < out.length; i++) {
        if (out[i] == null) out[i] = first;
    }
    return out;
};

// 相似度得分 [0, 1] = 0.5 × 形状相似度（皮尔逊相关，负相关记 0） + 0.5 × 幅度接近度（1/(1+RMSE)）
// 形状：去均值后趋势形态的一致性；幅度：逐点涨幅差异的均方根越小越接近
const computeSimilarity = (vecA, vecB) => {
    const n = vecA.length;
    let sumA = 0, sumB = 0, sqDiff = 0;
    for (let i = 0; i < n; i++) {
        const diff = vecA[i] - vecB[i];
        sqDiff += diff * diff;
        sumA += vecA[i];
        sumB += vecB[i];
    }
    const rmse = Math.sqrt(sqDiff / n);
    const levelScore = 1 / (1 + rmse);

    const meanA = sumA / n, meanB = sumB / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
        const da = vecA[i] - meanA;
        const db = vecB[i] - meanB;
        num += da * db;
        denA += da * da;
        denB += db * db;
    }
    let corr = 0;
    if (denA > 1e-9 && denB > 1e-9) {
        corr = num / Math.sqrt(denA * denB);
        if (!Number.isFinite(corr)) corr = 0;
    }
    const shapeScore = Math.max(0, corr);
    return 0.5 * shapeScore + 0.5 * levelScore;
};

const formatTimestamp = (minute) => {
    const minStr = String(minute).padStart(4, '0');
    const hh = minStr.substring(0, 2);
    const mm = minStr.substring(2, 4);
    const today = dayjs().format('YYYY-MM-DD');
    return dayjs(`${today} ${hh}:${mm}`).unix();
};

const isWeekendDay = (date) => {
    const day = dayjs(date).day();
    return day === 0 || day === 6;
};

// 是否交易时段（工作日 9:30-11:30 / 13:00-15:00，含收盘分钟点边界）
// 所有轮询（实时线 10s、相似度对比 5min）仅在该时段内发请求
const isTradingSession = () => {
    const now = dayjs();
    if (isWeekendDay(now)) return false;
    const t = now.hour() * 100 + now.minute();
    return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
};

// 格式化 lightweight-charts 所需数据（排序 + 去重）
const toChartData = (line) => {
    const formatted = line.map(item => ({
        time: formatTimestamp(item.minute),
        value: item.change,
    }));
    formatted.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (let i = 0; i < formatted.length; i++) {
        if (i === 0 || formatted[i].time !== deduped[deduped.length - 1].time) {
            deduped.push(formatted[i]);
        } else {
            deduped[deduped.length - 1] = formatted[i];
        }
    }
    return deduped;
};

const readStoredIndex = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_INDEX);
        if (raw && (raw === 'sz399006' || raw === 'sh000688')) return raw;
    } catch { /* noop */ }
    return null;
};

const IndexOverlayTline = ({
    embedded = true,
    onTitleClick,
    showCard = true,
}) => {
    const [indexCode, setIndexCode] = useState(() => readStoredIndex() || 'sz399006');
    // historyDates: 参与比较的历史交易日（YYYYMMDD 升序，最多 100 个，不含今天）
    // historyMap: { 'YYYYMMDD': [{minute, change}] }
    const [historyDates, setHistoryDates] = useState([]);
    const [historyMap, setHistoryMap] = useState({});
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyProgress, setHistoryProgress] = useState({ loaded: 0, total: 0 });
    // realtimeInfo: { date: 'YYYYMMDD' | null, line: [{minute, change}] }
    const [realtimeInfo, setRealtimeInfo] = useState({ date: null, line: [] });

    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const tooltipRef = useRef(null);
    const seriesInfoRef = useRef([]);
    const realtimeSeriesRef = useRef(null);
    const pollingTimerRef = useRef(null);
    const indexCodeRef = useRef(indexCode);
    // 按指数缓存历史数据（切换创业板/科创板秒回，无需重新拉取）
    const historyCacheRef = useRef({});

    useEffect(() => { indexCodeRef.current = indexCode; }, [indexCode]);

    // 持久化指数选择
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY_INDEX, indexCode);
        } catch (e) { console.warn('保存指数选择失败:', e); }
    }, [indexCode]);

    // 获取历史分时数据：交易日历取自指数日K线，再并发拉取各日分时
    // （loadSeqRef 防竞态：切换指数后旧加载的响应仍会写入缓存，但不再覆盖新指数的状态）
    const loadSeqRef = useRef(0);
    const loadHistory = useCallback(async (code) => {
        const seq = ++loadSeqRef.current;
        const cached = historyCacheRef.current[code];
        if (cached) {
            setHistoryDates(cached.dates);
            setHistoryMap(cached.map);
            setHistoryLoading(false);
            return;
        }
        setHistoryDates([]);
        setHistoryMap({});
        setHistoryLoading(true);
        setHistoryProgress({ loaded: 0, total: 0 });

        // 1. 交易日历：指数日K线最近 100 个交易日（剔除今天，今天以实时线展示）
        let dates = [];
        try {
            const res = await axios.get(`http://${local_ip}:3000/get_index_kline_data`);
            const klineKey = code === 'sz399006' ? 'chuangyebanData' : 'kechuangbanData';
            const kline = res.data?.[klineKey] || [];
            const todayStr = dayjs().format('YYYYMMDD');
            dates = [...new Set(kline.map(k => String(k.trade_date)).filter(Boolean))]
                .filter(d => d !== todayStr)
                .sort()
                .slice(-HISTORY_DAYS);
        } catch (e) {
            console.error('获取指数日K线（交易日历）失败', e);
        }
        if (!dates.length || loadSeqRef.current !== seq) {
            if (loadSeqRef.current === seq) setHistoryLoading(false);
            return;
        }
        setHistoryDates(dates);
        setHistoryProgress({ loaded: 0, total: dates.length });

        // 2. 并发池拉取各日分时（服务端有文件缓存，首次较慢、后续秒回）
        const map = {};
        let loaded = 0;
        const queue = [...dates];
        const worker = async () => {
            while (queue.length > 0) {
                const dateStr = queue.shift();
                try {
                    const res = await axios.get(`http://${local_ip}:3000/stock_tline_data?code=${code}&date=${dateStr}`);
                    const line = extractChangeLine(res.data);
                    if (line.length > 0) {
                        map[dateStr] = line;
                    }
                } catch (e) {
                    console.error(`获取 ${dateStr} 指数分时数据失败`, e);
                }
                loaded += 1;
                if (loadSeqRef.current === seq) {
                    setHistoryProgress({ loaded, total: dates.length });
                }
            }
        };
        await Promise.all(Array.from({ length: HISTORY_POOL_SIZE }, worker));
        historyCacheRef.current[code] = { dates, map };
        if (loadSeqRef.current !== seq) return;
        setHistoryMap(map);
        setHistoryLoading(false);
    }, []);

    // 获取当下实时分时数据
    const fetchRealtimeData = useCallback(async () => {
        if (isWeekendDay(dayjs())) {
            return;
        }
        const code = indexCodeRef.current;
        try {
            const res = await axios.get(`http://${local_ip}:3000/get_stock_tline?code=${code}`);
            // 已切换指数，丢弃过期响应
            if (code !== indexCodeRef.current) return;
            setRealtimeInfo({
                date: res.data?.date ? String(res.data.date) : null,
                line: extractChangeLine(res.data),
            });
        } catch (e) {
            console.error('获取实时指数分时数据失败', e);
        }
    }, []);

    // 当下线：实时优先；实时缺失（周末/收盘后未拉到）时回退最近一个有数据的历史日
    const realtimeDateStr = realtimeInfo.line.length > 0 ? realtimeInfo.date : null;
    const fallbackDateStr = useMemo(() => {
        for (let i = historyDates.length - 1; i >= 0; i--) {
            const d = historyDates[i];
            if (historyMap[d] && historyMap[d].length > 0) return d;
        }
        return null;
    }, [historyDates, historyMap]);
    const currentDateStr = realtimeDateStr || fallbackDateStr;
    const currentLine = useMemo(() => (
        realtimeDateStr ? realtimeInfo.line : (fallbackDateStr ? (historyMap[fallbackDateStr] || []) : [])
    ), [realtimeDateStr, realtimeInfo, fallbackDateStr, historyMap]);

    const currentGrid = useMemo(() => mapLineToGrid(currentLine), [currentLine]);
    const cutoffIdx = useMemo(() => getGridCutoff(currentGrid), [currentGrid]);
    // 当下分时的比较切片（截至当前分钟，头部缺失用首个有效值回填）
    const currentVec = useMemo(() => (
        cutoffIdx >= MIN_COMPARE_POINTS - 1 ? sliceAndFill(currentGrid, cutoffIdx) : null
    ), [currentGrid, cutoffIdx]);

    // ===== 相似度对比（每 5 分钟一轮，仅交易时段） =====
    // comparison: { cutoffIdx, vec } —— 触发时刻的当下分时快照
    const [comparison, setComparison] = useState(null);
    const currentVecRef = useRef(null);
    const cutoffIdxRef = useRef(-1);
    useEffect(() => {
        currentVecRef.current = currentVec;
        cutoffIdxRef.current = cutoffIdx;
    }, [currentVec, cutoffIdx]);

    const runComparison = useCallback(() => {
        const vec = currentVecRef.current;
        const cutoff = cutoffIdxRef.current;
        if (!vec || cutoff < MIN_COMPARE_POINTS - 1) {
            setComparison(null);
            return;
        }
        setComparison({ cutoffIdx: cutoff, vec });
    }, []);

    // 历史数据加载完成 / 指数切换后立即对比一次（收盘后、周末也能展示）
    useEffect(() => {
        runComparison();
    }, [runComparison, historyMap, indexCode]);

    // 每 5 分钟做一次相似度比较并更新图表（仅交易时段，非交易时段定时器空转）
    useEffect(() => {
        const timer = setInterval(() => {
            if (!isTradingSession()) return;
            runComparison();
        }, 5 * 60 * 1000);
        return () => clearInterval(timer);
    }, [runComparison]);

    // 实时线轮询：每 10s 拉取一次（递归调用经由 ref，避免 useCallback 自引用）
    // 定时器常驻、tick 内判断交易时段：非交易时段（收盘/周末/午休）空转不发请求，下一交易时段自动恢复
    const scheduleNextPollRef = useRef(() => {});
    const wasInSessionRef = useRef(isTradingSession());
    const scheduleNextPoll = useCallback(() => {
        if (pollingTimerRef.current) {
            clearTimeout(pollingTimerRef.current);
            pollingTimerRef.current = null;
        }
        pollingTimerRef.current = setTimeout(async () => {
            const inSession = isTradingSession();
            if (inSession) {
                await fetchRealtimeData();
            } else if (wasInSessionRef.current) {
                // 交易时段刚结束（午休/收盘）：补一次最终相似度对比（纯本地计算，不发请求），
                // 锁定该时段最后状态（如收盘 15:00 分钟点）后的 Top3
                runComparison();
            }
            wasInSessionRef.current = inSession;
            scheduleNextPollRef.current();
        }, 10000);
    }, [fetchRealtimeData, runComparison]);
    useEffect(() => { scheduleNextPollRef.current = scheduleNextPoll; }, [scheduleNextPoll]);

    // 初始化：拉取历史数据 + 拉取一次实时数据（收盘后/周末也能展示完整分时）+ 启动实时轮询循环
    useEffect(() => {
        loadHistory(indexCodeRef.current);
        fetchRealtimeData();
        scheduleNextPoll();
        return () => {
            if (pollingTimerRef.current) {
                clearTimeout(pollingTimerRef.current);
                pollingTimerRef.current = null;
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // 指数切换时重新拉取历史与实时数据（跳过首次挂载，由初始化 effect 处理）
    const isFirstMountRef = useRef(true);
    useEffect(() => {
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            return;
        }
        setRealtimeInfo({ date: null, line: [] });
        fetchRealtimeData();
        loadHistory(indexCode);
    }, [indexCode]); // eslint-disable-line react-hooks/exhaustive-deps

    // 相似度 Top3：对比快照切片 vs 过去 100 天同期切片，得分降序取前 3
    const topMatches = useMemo(() => {
        if (!comparison || !historyDates.length) return [];
        const cutoff = comparison.cutoffIdx;
        const vec = comparison.vec;
        const need = Math.max(MIN_COMPARE_POINTS, Math.ceil(vec.length * 0.9));
        const scored = [];
        for (const d of historyDates) {
            if (d === currentDateStr) continue;
            const grid = mapLineToGrid(historyMap[d]);
            if (countGridValid(grid, cutoff) < need) continue;
            const candVec = sliceAndFill(grid, cutoff);
            if (!candVec) continue;
            scored.push({ date: d, score: computeSimilarity(vec, candVec) });
        }
        scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
        return scored.slice(0, 3);
    }, [comparison, historyDates, historyMap, currentDateStr]);

    // 所有要绘制的折线：Top3 完整历史线 + 当下线
    const allLines = useMemo(() => {
        const lines = topMatches.map((m, idx) => ({
            key: m.date,
            label: `${dayjs(m.date).format('MM-DD')} · ${Math.round(m.score * 100)}%`,
            color: DATE_COLORS[idx % DATE_COLORS.length],
            isRealtime: false,
            line: historyMap[m.date] || [],
        }));
        if (currentLine.length > 0) {
            lines.push({
                key: 'current',
                label: `${dayjs(currentDateStr || dayjs().format('YYYYMMDD')).format('MM-DD')} ${realtimeDateStr ? '实时' : '最新'}`,
                color: REALTIME_COLOR,
                isRealtime: true,
                line: currentLine,
            });
        }
        return lines;
    }, [topMatches, historyMap, currentLine, currentDateStr, realtimeDateStr]);
    const allLinesRef = useRef([]);
    useEffect(() => { allLinesRef.current = allLines; }, [allLines]);

    // 构建图表（全量重建）
    const renderChart = useCallback(() => {
        if (!containerRef.current) return;

        const lines = allLinesRef.current;

        // 清理旧图表
        if (chartRef.current) {
            try { chartRef.current.remove(); } catch { /* noop */ }
            chartRef.current = null;
        }
        seriesInfoRef.current = [];
        realtimeSeriesRef.current = null;

        if (lines.length === 0) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: '#ffffff' },
                textColor: '#64748b',
                fontSize: 11,
            },
            width: containerRef.current.clientWidth || 800,
            height: containerRef.current.clientHeight || (embedded ? 280 : 600),
            grid: {
                vertLines: { color: 'rgba(157, 176, 207, 0.12)', style: LineStyle.Dotted },
                horzLines: { color: 'rgba(157, 176, 207, 0.12)', style: LineStyle.Dotted },
            },
            timeScale: {
                borderColor: '#D1D4DC',
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time) => {
                    if (typeof time === 'number') return dayjs.unix(time).format('HH:mm');
                    return time;
                },
            },
            localization: {
                locale: 'zh-CN',
                timeFormatter: (time) => {
                    if (typeof time === 'number') return dayjs.unix(time).format('HH:mm');
                    return time;
                },
            },
            rightPriceScale: {
                borderColor: '#D1D4DC',
                autoScale: true,
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            handleScroll: false,
            handleScale: false,
            crosshair: {
                mode: 1,
                vertLine: { width: 1, color: '#94a3b8', style: LineStyle.Dotted, labelBackgroundColor: '#1e293b' },
                horzLine: { width: 1, color: '#94a3b8', style: LineStyle.Dotted, labelBackgroundColor: '#1e293b' },
            },
        });
        chartRef.current = chart;

        lines.forEach((lineInfo) => {
            const series = chart.addLineSeries({
                color: lineInfo.color,
                lineWidth: lineInfo.isRealtime ? 2.5 : 1.5,
                lineStyle: lineInfo.isRealtime ? LineStyle.Solid : LineStyle.Dashed,
                priceFormat: {
                    type: 'custom',
                    formatter: (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`,
                },
            });
            series.setData(toChartData(lineInfo.line));
            const info = { series, key: lineInfo.key, label: lineInfo.label, color: lineInfo.color, isRealtime: lineInfo.isRealtime };
            seriesInfoRef.current.push(info);
            if (lineInfo.isRealtime) realtimeSeriesRef.current = info;
        });

        chart.timeScale().fitContent();
        chart.timeScale().applyOptions({
            fixLeftEdge: true,
            fixRightEdge: true,
            lockVisibleTimeRangeOnResize: true,
            rightOffset: 0,
        });

        // 自定义 Tooltip
        const tooltip = tooltipRef.current;
        const TOOLTIP_MARGIN = 15;
        chart.subscribeCrosshairMove(param => {
            if (
                !param.point || !param.time ||
                param.point.x < 0 || param.point.x > containerRef.current.clientWidth ||
                param.point.y < 0 || param.point.y > containerRef.current.clientHeight
            ) {
                tooltip.style.display = 'none';
            } else {
                tooltip.style.display = 'block';
                const seriesData = [];
                seriesInfoRef.current.forEach((info) => {
                    const data = param.seriesData.get(info.series);
                    if (data) {
                        seriesData.push({ label: info.label, value: data.value, color: info.color, isRealtime: info.isRealtime });
                    }
                });
                const timeStr = typeof param.time === 'number' ? dayjs.unix(param.time).format('HH:mm') : param.time;
                let html = `<div class="iot-tooltip-header">${timeStr}</div>`;
                seriesData.forEach(item => {
                    const sign = item.value > 0 ? '+' : '';
                    html += `<div class="iot-tooltip-item${item.isRealtime ? ' iot-realtime' : ''}">
                        <span class="iot-tooltip-dot" style="background:${item.color}"></span>
                        <span class="iot-tooltip-date">${item.label}</span>
                        <span class="iot-tooltip-value" style="color:${item.color}">${sign}${item.value.toFixed(2)}%</span>
                    </div>`;
                });
                tooltip.innerHTML = html;

                const tw = tooltip.offsetWidth;
                const th = tooltip.offsetHeight;
                const cw = containerRef.current.clientWidth;
                const ch = containerRef.current.clientHeight;
                let left = param.point.x + TOOLTIP_MARGIN + tw > cw
                    ? param.point.x - TOOLTIP_MARGIN - tw
                    : param.point.x + TOOLTIP_MARGIN;
                if (left < 0) left = 4;
                if (left + tw > cw) left = cw - tw - 4;
                let top = param.point.y - th / 2;
                if (top < 4) top = 4;
                if (top + th > ch - 4) top = ch - th - 4;
                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${top}px`;
            }
        });

        const handleResize = () => {
            if (chartRef.current && containerRef.current) {
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight
                });
            }
        };
        window.addEventListener('resize', handleResize);
        chartRef.current._cleanupResize = handleResize;
    }, [embedded]);

    // 图表全量重建信号：仅当 Top3 日期/相似度百分比、当下线来源或指数变化时重建
    // （Top3 每 5 分钟一轮更新；红色实时线由 realtime effect 每 10s 单独 setData，不走全量重建）
    const chartRebuildKey = `${indexCode}|${currentDateStr}|${topMatches.map(m => `${m.date}:${Math.round(m.score * 100)}`).join(',')}`;
    useEffect(() => {
        renderChart();
    }, [chartRebuildKey, renderChart]);

    // 组件挂载后延迟重新调整大小，确保容器尺寸正确（嵌入 & 全屏均需要）
    useEffect(() => {
        const timer = setTimeout(() => {
            if (chartRef.current && containerRef.current) {
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight,
                });
                chartRef.current.timeScale().fitContent();
            } else {
                renderChart();
            }
        }, 200);
        return () => clearTimeout(timer);
    }, [embedded, renderChart]);

    // 监听容器尺寸变化（CSS 布局变化不会触发 window resize）
    useEffect(() => {
        if (!containerRef.current) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (chartRef.current && width > 0 && height > 0) {
                    chartRef.current.applyOptions({ width, height });
                }
            }
        });
        ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, []);

    // 实时数据变化时仅更新当下折线（避免全量重建闪烁）
    useEffect(() => {
        if (!chartRef.current) {
            renderChart();
            return;
        }
        if (realtimeSeriesRef.current && realtimeInfo.line.length > 0) {
            realtimeSeriesRef.current.series.setData(toChartData(realtimeInfo.line));
        } else {
            // 当下线从无到有，需要重建
            renderChart();
        }
    }, [realtimeInfo, renderChart]);

    // 图表卸载清理
    useEffect(() => {
        return () => {
            if (chartRef.current) {
                if (chartRef.current._cleanupResize) {
                    window.removeEventListener('resize', chartRef.current._cleanupResize);
                }
                try { chartRef.current.remove(); } catch { /* noop */ }
                chartRef.current = null;
            }
        };
    }, []);

    const renderContent = () => (
        <>
            {!showCard && (
                <div className="iot-fullscreen-header" style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: '12px'
                }}>
                    <Segmented
                        options={INDEX_OPTIONS}
                        value={indexCode}
                        onChange={setIndexCode}
                        size="small"
                    />
                </div>
            )}
            <div className="iot-toolbar">
                {topMatches.length > 0 && (
                    <div className="iot-date-tags">
                        <span className="iot-tags-title">相似度 Top3</span>
                        {topMatches.map((m, idx) => {
                            const tagColor = DATE_COLORS[idx % DATE_COLORS.length];
                            return (
                                <Tag
                                    key={m.date}
                                    className="iot-date-tag"
                                    style={{ borderColor: tagColor + '55' }}
                                >
                                    <span className="iot-date-dot" style={{ background: tagColor }} />
                                    <span className="iot-date-label">{dayjs(m.date).format('MM-DD')}</span>
                                    <span className="iot-match-score" style={{ color: tagColor }}>
                                        {Math.round(m.score * 100)}%
                                    </span>
                                </Tag>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="iot-chart-wrapper" style={!embedded ? { flex: 1, minHeight: 0 } : {}}>
                <div className="iot-lw-chart-container">
                    <div ref={containerRef} className="iot-lw-chart" style={!embedded ? { height: '100%' } : {}} />
                    <div ref={tooltipRef} className="iot-lw-tooltip" />
                </div>
                {historyLoading && (
                    <div className="iot-loading-overlay">
                        <Spin tip={historyProgress.total > 0
                            ? `已加载 ${historyProgress.loaded}/${historyProgress.total} 天历史分时`
                            : '正在加载历史分时数据...'}
                        />
                    </div>
                )}
                {!historyLoading && currentLine.length === 0 && (
                    <div className="iot-empty-overlay">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分时数据" />
                    </div>
                )}
            </div>

            {/* 当下线图例 */}
            {currentLine.length > 0 && (
                <div className="iot-realtime-legend">
                    <span className="iot-realtime-dot" style={{ background: REALTIME_COLOR }} />
                    <span className="iot-realtime-label">
                        {`${dayjs(currentDateStr || dayjs().format('YYYYMMDD')).format('MM-DD')} ${realtimeDateStr ? '实时' : '最新'}`}
                    </span>
                </div>
            )}
        </>
    );

    if (!showCard) {
        return (
            <div className={`index-overlay-content ${!embedded ? 'iot-fullscreen' : ''}`}>
                {renderContent()}
            </div>
        );
    }

    return (
        <Card
            title={
                <div
                    className="iot-card-title"
                    onClick={onTitleClick}
                    style={{
                        cursor: onTitleClick ? 'pointer' : 'default',
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center'
                    }}
                >
                    <div className="iot-card-title-icon">
                        <LineChartOutlined />
                    </div>
                    <div className="iot-card-title-content">
                        <span>指数叠加分时</span>
                        <span className="iot-card-title-subtext">Index Overlay Timeline</span>
                    </div>
                </div>
            }
            className="monitor-card index-overlay-card"
            variant="borderless"
            bodyStyle={{ padding: '12px 20px 16px', display: 'flex', flexDirection: 'column' }}
            extra={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <Segmented
                        options={INDEX_OPTIONS}
                        value={indexCode}
                        onChange={setIndexCode}
                        size="small"
                    />
                </div>
            }
        >
            {renderContent()}
        </Card>
    );
};

export default IndexOverlayTline;
