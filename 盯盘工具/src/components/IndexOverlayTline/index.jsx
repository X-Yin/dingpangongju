import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Card, DatePicker, Button, Tag, Empty, Spin, Segmented, message, Tooltip } from 'antd';
import { LineChartOutlined, PlusOutlined, ApartmentOutlined } from '@ant-design/icons';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../constant';
import IndexOverlayGroupModal from '../IndexOverlayGroupModal';
import './index.scss';

const STORAGE_KEY_DATES = 'index_overlay_tline_dates';
const STORAGE_KEY_INDEX = 'index_overlay_tline_index';

const INDEX_OPTIONS = [
    { label: '创业板指', value: 'sz399006' },
    { label: '科创50', value: 'sh000688' },
];

const INDEX_KEY_MAP = {
    'sz399006': 'chuangyeban',
    'sh000688': 'kechuangban',
};

// 历史日期折线颜色调色板（实时线使用 REALTIME_COLOR）
const DATE_COLORS = [
    '#cf1322', '#389e0d', '#fa8c16', '#722ed1', '#13c2c2',
    '#eb2f96', '#faad14', '#1677ff', '#a8071a', '#08979c',
];

// 最新一天（实时）折线颜色：实线红色
const REALTIME_COLOR = '#f5222d';

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

const isMarketClosed = () => {
    const now = dayjs();
    if (isWeekendDay(now)) return true;
    const h = now.hour();
    const m = now.minute();
    return h >= 15 || (h === 14 && m >= 59);
};

// 获取最近一个交易日（用于默认填充）
const getLastTradingDay = () => {
    let d = dayjs().subtract(1, 'day');
    while (isWeekendDay(d)) {
        d = d.subtract(1, 'day');
    }
    return d;
};

// 获取最新一个交易日（今天为工作日返回今天，否则回退到最近的工作日）
const getLatestTradingDay = () => {
    let d = dayjs();
    while (isWeekendDay(d)) {
        d = d.subtract(1, 'day');
    }
    return d;
};

// 从指数分时数据中提取 {minute, change} 序列
const extractChangeLine = (indexData) => {
    if (!indexData || !indexData.line || !Array.isArray(indexData.line)) return [];
    return indexData.line
        .filter(item => item && item.minute && item.change != null)
        .map(item => ({ minute: item.minute, change: parseFloat(item.change) || 0 }));
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

const readStoredDates = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_DATES);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const validDates = parsed
                    .filter(d => d && typeof d === 'string')
                    .map(d => dayjs(d))
                    .filter(d => d.isValid() && !d.isAfter(dayjs().endOf('day')) && !isWeekendDay(d));
                if (validDates.length > 0) return validDates;
            }
        }
    } catch (e) {
        console.warn('读取本地存储日期失败:', e);
    }
    return null;
};

const readStoredIndex = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_INDEX);
        if (raw && (raw === 'sz399006' || raw === 'sh000688')) return raw;
    } catch (e) { /* noop */ }
    return null;
};

const IndexOverlayTline = ({ 
    embedded = true,
    onTitleClick,
    showCard = true,
}) => {
    const [indexCode, setIndexCode] = useState(() => readStoredIndex() || 'sz399006');
    const [selectedDates, setSelectedDates] = useState(() => {
        const stored = readStoredDates();
        if (stored) return stored;
        // 默认填充最近一个交易日
        const lastDay = getLastTradingDay();
        return lastDay ? [lastDay] : [];
    });
    const [pickDate, setPickDate] = useState(null);
    const [historicalLoading, setHistoricalLoading] = useState(false);
    // historicalData: { 'YYYYMMDD': { shangzheng, chuangyeban, kechuangban } }
    const [historicalData, setHistoricalData] = useState({});
    const [realtimeData, setRealtimeData] = useState([]);
    const [groupModalVisible, setGroupModalVisible] = useState(false);
    const [groups, setGroups] = useState([]);

    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const tooltipRef = useRef(null);
    const seriesInfoRef = useRef([]);
    const realtimeSeriesRef = useRef(null);
    const pollingTimerRef = useRef(null);
    const indexCodeRef = useRef(indexCode);
    const historicalDataRef = useRef({});
    const realtimeDataRef = useRef([]);
    const selectedDatesRef = useRef(selectedDates);

    useEffect(() => { indexCodeRef.current = indexCode; }, [indexCode]);
    useEffect(() => { historicalDataRef.current = historicalData; }, [historicalData]);
    useEffect(() => { realtimeDataRef.current = realtimeData; }, [realtimeData]);
    useEffect(() => { selectedDatesRef.current = selectedDates; }, [selectedDates]);

    // 持久化到 localStorage
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY_INDEX, indexCode);
        } catch (e) { console.warn('保存指数选择失败:', e); }
    }, [indexCode]);
    useEffect(() => {
        try {
            const serialized = selectedDates.map(d => d.format('YYYY-MM-DD'));
            localStorage.setItem(STORAGE_KEY_DATES, JSON.stringify(serialized));
        } catch (e) { console.warn('保存日期选择失败:', e); }
    }, [selectedDates]);

    const todayStr = dayjs().format('YYYYMMDD');

    // 收集所有要绘制的折线（历史 + 实时）
    const allLines = useMemo(() => {
        const lines = [];
        const latestTradingDayStr = getLatestTradingDay().format('YYYYMMDD');
        const hasRealtime = realtimeData.length > 0;
        selectedDates.forEach((d, idx) => {
            const dateStr = dayjs(d).format('YYYYMMDD');
            const fullData = historicalData[dateStr];
            if (!fullData) return;
            const indexKey = INDEX_KEY_MAP[indexCode];
            const line = extractChangeLine(fullData[indexKey]);
            if (line.length > 0) {
                // 无实时数据时，最新交易日按实线红色渲染
                const isLatest = !hasRealtime && dateStr === latestTradingDayStr;
                lines.push({
                    key: dateStr,
                    label: dayjs(d).format('MM-DD'),
                    color: isLatest ? REALTIME_COLOR : DATE_COLORS[idx % DATE_COLORS.length],
                    isRealtime: isLatest,
                    line,
                });
            }
        });
        if (hasRealtime) {
            lines.push({
                key: 'realtime',
                label: `${dayjs().format('MM-DD')} 实时`,
                color: REALTIME_COLOR,
                isRealtime: true,
                line: realtimeData,
            });
        }
        return lines;
    }, [selectedDates, historicalData, indexCode, realtimeData]);

    // 构建图表（全量重建）
    const renderChart = useCallback(() => {
        if (!containerRef.current) return;

        const lines = [];
        const latestTradingDayStr = getLatestTradingDay().format('YYYYMMDD');
        const hasRealtime = realtimeDataRef.current.length > 0;
        selectedDatesRef.current.forEach((d, idx) => {
            const dateStr = dayjs(d).format('YYYYMMDD');
            const fullData = historicalDataRef.current[dateStr];
            if (!fullData) return;
            const indexKey = INDEX_KEY_MAP[indexCodeRef.current];
            const line = extractChangeLine(fullData[indexKey]);
            if (line.length > 0) {
                const isLatest = !hasRealtime && dateStr === latestTradingDayStr;
                lines.push({
                    key: dateStr,
                    label: dayjs(d).format('MM-DD'),
                    color: isLatest ? REALTIME_COLOR : DATE_COLORS[idx % DATE_COLORS.length],
                    isRealtime: isLatest,
                    line,
                });
            }
        });
        if (hasRealtime) {
            lines.push({
                key: 'realtime',
                label: `${dayjs().format('MM-DD')} 实时`,
                color: REALTIME_COLOR,
                isRealtime: true,
                line: realtimeDataRef.current,
            });
        }

        // 清理旧图表
        if (chartRef.current) {
            try { chartRef.current.remove(); } catch (e) { /* noop */ }
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
    }, []);

    // 历史数据 / 日期 / 指数变化时全量重建图表
    useEffect(() => {
        renderChart();
    }, [selectedDates, historicalData, indexCode, renderChart]);

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

    // 实时数据变化时仅更新实时折线（避免全量重建闪烁）
    useEffect(() => {
        // 同步更新 ref，确保 renderChart 能读到最新值
        realtimeDataRef.current = realtimeData;
        if (!chartRef.current) {
            renderChart();
            return;
        }
        if (realtimeSeriesRef.current && realtimeData.length > 0) {
            realtimeSeriesRef.current.series.setData(toChartData(realtimeData));
        } else {
            // 实时线从无到有，需要重建
            renderChart();
        }
    }, [realtimeData, renderChart]);

    // 获取历史分时数据（一次请求返回三个指数，切换指数无需重新请求）
    const fetchHistoricalData = useCallback(async (dates) => {
        if (!dates.length) {
            setHistoricalData({});
            return;
        }
        setHistoricalLoading(true);
        try {
            const results = await Promise.all(
                dates.map(async (d) => {
                    const dateStr = dayjs(d).format('YYYYMMDD');
                    try {
                        const res = await axios.get(`http://${local_ip}:3000/fupan/index_tline?date=${dateStr}`);
                        if (res.data.success && res.data.data) {
                            return [dateStr, res.data.data];
                        }
                    } catch (e) {
                        console.error(`获取 ${dateStr} 指数分时数据失败`, e);
                    }
                    return [dateStr, null];
                })
            );
            setHistoricalData(Object.fromEntries(results.filter(([, v]) => v !== null)));
        } finally {
            setHistoricalLoading(false);
        }
    }, []);

    // 获取当日实时分时数据
    const fetchRealtimeData = useCallback(async () => {
        if (isWeekendDay(dayjs())) {
            return;
        }
        try {
            const res = await axios.get(`http://${local_ip}:3000/get_stock_tline?code=${indexCodeRef.current}`);
            const line = extractChangeLine(res.data);
            setRealtimeData(line);
        } catch (e) {
            console.error('获取实时指数分时数据失败', e);
        }
    }, []);

    // 递归 setTimeout 轮询实时数据
    const scheduleNextPoll = useCallback(() => {
        if (pollingTimerRef.current) {
            clearTimeout(pollingTimerRef.current);
            pollingTimerRef.current = null;
        }
        pollingTimerRef.current = setTimeout(async () => {
            await fetchRealtimeData();
            // 收盘后或周末停止轮询
            if (!isMarketClosed()) {
                scheduleNextPoll();
            } else {
                pollingTimerRef.current = null;
            }
        }, 3000);
    }, [fetchRealtimeData]);

    // 初始化：拉取历史数据 + 拉取一次实时数据 + 启动轮询
    useEffect(() => {
        fetchHistoricalData(selectedDates);
        // 无论是否交易时段，先拉一次当日数据（收盘后也能展示完整分时）
        fetchRealtimeData();
        // 仅交易时段启动轮询
        if (!isMarketClosed()) {
            scheduleNextPoll();
        }
        return () => {
            if (pollingTimerRef.current) {
                clearTimeout(pollingTimerRef.current);
                pollingTimerRef.current = null;
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // 拉取分组列表，用于匹配当前选中日期对应的分组名称
    useEffect(() => {
        const fetchGroups = async () => {
            try {
                const res = await axios.get(`http://${local_ip}:3000/indexOverlayGroup/list`);
                if (res.data && res.data.success) {
                    setGroups(res.data.data || []);
                }
            } catch (e) {
                console.error('获取分组列表失败:', e);
            }
        };
        fetchGroups();
    }, [groupModalVisible]);

    // 当前选中日期与分组日期完全重合时，返回该分组
    const matchedGroupName = useMemo(() => {
        if (selectedDates.length === 0 || groups.length === 0) return null;
        const currentSet = selectedDates
            .map(d => dayjs(d).format('YYYY-MM-DD'))
            .sort();
        const currentKey = currentSet.join(',');
        for (const g of groups) {
            const gDates = (g.dates || []).map(d => dayjs(d).format('YYYY-MM-DD')).sort();
            if (gDates.length === currentSet.length && gDates.join(',') === currentKey) {
                return g;
            }
        }
        return null;
    }, [selectedDates, groups]);

    // 指数切换时重新拉取实时数据（跳过首次挂载，由初始化 effect 处理）
    const isFirstMountRef = useRef(true);
    useEffect(() => {
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            return;
        }
        fetchRealtimeData();
        if (!isMarketClosed()) {
            scheduleNextPoll();
        }
    }, [indexCode]); // eslint-disable-line react-hooks/exhaustive-deps

    // 添加日期
    const handleAddDate = () => {
        if (!pickDate) {
            message.warning('请先选择日期');
            return;
        }
        if (isWeekendDay(pickDate)) {
            message.warning('周末非交易日，请选择工作日');
            return;
        }
        const dateStr = dayjs(pickDate).format('YYYYMMDD');
        if (dateStr === todayStr) {
            message.info('当日数据以实时折线展示，无需重复添加');
            return;
        }
        if (dayjs(pickDate).isAfter(dayjs())) {
            message.warning('不能选择未来日期');
            return;
        }
        if (selectedDates.some(d => dayjs(d).format('YYYYMMDD') === dateStr)) {
            message.warning('该日期已添加');
            return;
        }
        const newDates = [...selectedDates, pickDate];
        setSelectedDates(newDates);
        setPickDate(null);
        fetchHistoricalData(newDates);
    };

    // 移除日期
    const handleRemoveDate = (dateStr) => {
        const newDates = selectedDates.filter(d => dayjs(d).format('YYYYMMDD') !== dateStr);
        setSelectedDates(newDates);
        setHistoricalData(prev => {
            const next = { ...prev };
            delete next[dateStr];
            return next;
        });
    };

    // 应用分组的日期：一键替换当前叠加分时的所有日期
    const handleApplyGroupDates = (dateStrings) => {
        const validDates = (dateStrings || [])
            .map(d => dayjs(d))
            .filter(d => d.isValid() && !isWeekendDay(d) && !d.isAfter(dayjs().endOf('day')))
            .filter(d => dayjs(d).format('YYYYMMDD') !== todayStr);
        if (validDates.length === 0) {
            message.warning('该分组没有可用的历史日期');
            return;
        }
        const newDates = validDates;
        setSelectedDates(newDates);
        setHistoricalData({});
        fetchHistoricalData(newDates);
        setGroupModalVisible(false);
    };

    // 图表卸载清理
    useEffect(() => {
        return () => {
            if (chartRef.current) {
                if (chartRef.current._cleanupResize) {
                    window.removeEventListener('resize', chartRef.current._cleanupResize);
                }
                try { chartRef.current.remove(); } catch (e) { /* noop */ }
                chartRef.current = null;
            }
        };
    }, []);

    // 禁用周末和未来日期
    const disabledDate = (current) => {
        if (!current) return false;
        if (current.isAfter(dayjs().endOf('day'))) return true;
        return isWeekendDay(current);
    };

    const latestTradingDayStr = getLatestTradingDay().format('YYYYMMDD');
    const hasRealtime = realtimeData.length > 0;
    const hasLatestHistorical = !hasRealtime && selectedDates.some(d => dayjs(d).format('YYYYMMDD') === latestTradingDayStr);

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
                    <Button
                        size="small"
                        icon={<ApartmentOutlined />}
                        onClick={() => setGroupModalVisible(true)}
                    >
                        分组
                    </Button>
                    <Segmented
                        options={INDEX_OPTIONS}
                        value={indexCode}
                        onChange={setIndexCode}
                        size="small"
                    />
                </div>
            )}
            <div className="iot-toolbar">
                <div className="iot-toolbar-row">
                    <DatePicker
                        value={pickDate}
                        onChange={setPickDate}
                        disabledDate={disabledDate}
                        allowClear
                        size="small"
                        placeholder="选择日期"
                    />
                    <Button
                        type="primary"
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={handleAddDate}
                    >
                        添加日期
                    </Button>
                    {matchedGroupName?.title && (
                        <Tooltip title={matchedGroupName.description || '暂无描述'}>
                            <span className="iot-matched-group">
                                <ApartmentOutlined />
                                {matchedGroupName.title}
                            </span>
                        </Tooltip>
                    )}
                </div>
                {selectedDates.length > 0 && (
                    <div className="iot-date-tags">
                        {selectedDates.map((d, idx) => {
                            const dateStr = dayjs(d).format('YYYYMMDD');
                            const isLatest = !hasRealtime && dateStr === latestTradingDayStr;
                            const tagColor = isLatest ? REALTIME_COLOR : DATE_COLORS[idx % DATE_COLORS.length];
                            return (
                                <Tag
                                    key={dateStr}
                                    className="iot-date-tag"
                                    closable
                                    onClose={() => handleRemoveDate(dateStr)}
                                    style={{ borderColor: tagColor + '55' }}
                                >
                                    <span className="iot-date-dot" style={{ background: tagColor }} />
                                    <span className="iot-date-label">{dayjs(d).format('MM-DD')}</span>
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
                {historicalLoading && (
                    <div className="iot-loading-overlay">
                        <Spin tip="加载历史数据..." />
                    </div>
                )}
                {!historicalLoading && allLines.length === 0 && (
                    <div className="iot-empty-overlay">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分时数据，请添加日期" />
                    </div>
                )}
            </div>

            {/* 实时/最新线图例 */}
            {(hasRealtime || hasLatestHistorical) && (
                <div className="iot-realtime-legend">
                    <span className="iot-realtime-dot" style={{ background: REALTIME_COLOR }} />
                    <span className="iot-realtime-label">
                        {hasRealtime
                            ? `${dayjs().format('MM-DD')} 实时`
                            : `${dayjs(latestTradingDayStr, 'YYYYMMDD').format('MM-DD')} 最新`}
                    </span>
                </div>
            )}
        </>
    );

    if (!showCard) {
        return (
            <div className={`index-overlay-content ${!embedded ? 'iot-fullscreen' : ''}`}>
                {renderContent()}
                <IndexOverlayGroupModal
                    open={groupModalVisible}
                    onClose={() => setGroupModalVisible(false)}
                    onApplyDates={handleApplyGroupDates}
                />
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
