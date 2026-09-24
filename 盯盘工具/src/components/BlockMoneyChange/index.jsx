import { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { local_ip } from '../../constant';
import { AppstoreOutlined, BarChartOutlined, LineChartOutlined, FundOutlined, ReloadOutlined, CheckOutlined } from '@ant-design/icons';
import { Button, Checkbox, Modal, Tabs, Empty, DatePicker, Card, Row, Col, Divider, Alert, Spin, Tag, Space, Typography } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { Bar, Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Filler, Title as ChartTitle, Tooltip as ChartTooltip, Legend } from 'chart.js';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import StockKLine from '../../components/StockKLine';
import dayjs from 'dayjs';
import { getThemeColor, getThemeColorRgba } from '../../utils/theme';
import './index.scss';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Filler, ChartTitle, ChartTooltip, Legend);

const { Title, Text } = Typography;

const BLOCK_COLORS = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d',
  '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16',
  '#a0d911', '#2f54eb', '#fa541c', '#1890ff',
  '#8c8c8c', '#36cfc9', '#73d13d', '#ffc53d',
  '#ff7875', '#9254de', '#ffadd2', '#5cdbd3',
  '#b7eb8f', '#69c0ff', '#ffc069', '#ff85c0',
  '#87d068', '#61a9e9', '#fca739', '#fc5252',
  '#c169ef', '#66d7eb', '#f7ba1e', '#82ca9d',
];

const DEFAULT_SELECTED_BLOCKS = [
    '光通信模块',
    '液冷',
    '保险Ⅱ',
    '银行Ⅱ',
    '证券Ⅱ',
    '半导体概念',
    'PCB',
    '中证500',
    'MLCC',
    '商业航天',
    '机器人概念',
    '锂电池概念',
    '创新药',
    '存储芯片'
];

// 最小面积占比（百分比），防止板块被压缩得太狠
const MIN_AREA_PERCENT = 2;

const getSizeClass = (areaPercent) => {
    if (areaPercent >= 15) return 'size-xl';
    if (areaPercent >= 10) return 'size-lg';
    if (areaPercent >= 7) return 'size-md';
    if (areaPercent >= 4) return 'size-sm';
    if (areaPercent >= 2.5) return 'size-s';
    return 'size-xs';
};

// 按比例瓜分总面积（100%），同时保证每个板块不小于最小面积
// 返回数组之和恒等于 100，严格按 |value| 比例分配
const allocateAreas = (values, minPercent) => {
    const n = values.length;
    if (n === 0) return [];

    // 如果板块数量太多导致最小面积之和超过 100，则自动降低最小面积
    const effectiveMin = Math.min(minPercent, 100 / n);

    const absValues = values.map(v => Math.abs(v));
    const total = absValues.reduce((a, b) => a + b, 0);
    const totalArea = 100;

    if (total <= 0) {
        return new Array(n).fill(totalArea / n);
    }

    // 迭代式夹紧：低于最小面积的板块被固定为最小值，剩余面积在其它板块间按比例重新分配
    const clamped = new Array(n).fill(false);
    let changed = true;
    while (changed) {
        changed = false;
        const clampedCount = clamped.filter(Boolean).length;
        const remainingArea = totalArea - clampedCount * effectiveMin;
        let remainingTotal = 0;
        for (let i = 0; i < n; i++) {
            if (!clamped[i]) remainingTotal += absValues[i];
        }
        if (remainingTotal <= 0 || remainingArea <= 0) break;

        for (let i = 0; i < n; i++) {
            if (clamped[i]) continue;
            const proportional = (absValues[i] / remainingTotal) * remainingArea;
            if (proportional < effectiveMin) {
                clamped[i] = true;
                changed = true;
            }
        }
    }

    // 最终分配
    const areas = new Array(n);
    const clampedCount = clamped.filter(Boolean).length;
    const remainingArea = totalArea - clampedCount * effectiveMin;
    let remainingTotal = 0;
    for (let i = 0; i < n; i++) {
        if (clamped[i]) {
            areas[i] = effectiveMin;
        } else {
            remainingTotal += absValues[i];
        }
    }
    const unclampedCount = n - clampedCount;
    for (let i = 0; i < n; i++) {
        if (!clamped[i]) {
            areas[i] = remainingTotal > 0
                ? (absValues[i] / remainingTotal) * remainingArea
                : remainingArea / unclampedCount;
        }
    }

    return areas;
};

// Squarified treemap 算法（Bruls, Huijsen, van Wijk 2000）
// 将 items 按面积比例填入 rect，无留白，尽量让每个矩形接近正方形
// items: [{ area, index }]  rect: { x, y, w, h }（百分比单位）
// 返回: [{ index, x, y, w, h }]
const squarify = (items, rect) => {
    const results = [];
    const { x: startX, y: startY, w: startW, h: startH } = rect;

    if (items.length === 0 || startW <= 0 || startH <= 0) return results;

    const sorted = [...items].sort((a, b) => b.area - a.area);

    const totalItemArea = sorted.reduce((s, it) => s + it.area, 0);
    if (totalItemArea <= 0) {
        const n = sorted.length;
        sorted.forEach((it, i) => {
            results.push({ index: it.index, x: startX, y: startY + (startH / n) * i, w: startW, h: startH / n });
        });
        return results;
    }

    // 缩放使面积之和恰好等于容器面积
    const containerArea = startW * startH;
    const scaleFactor = containerArea / totalItemArea;
    const scaled = sorted.map(it => ({ ...it, area: it.area * scaleFactor }));

    // 计算一行中最差长宽比
    const worstRatio = (rowAreas, side) => {
        if (rowAreas.length === 0 || side <= 0) return Infinity;
        const sum = rowAreas.reduce((a, b) => a + b, 0);
        if (sum <= 0) return Infinity;
        const max = Math.max(...rowAreas);
        const min = Math.min(...rowAreas);
        if (min <= 0) return Infinity;
        const s2 = side * side;
        return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
    };

    const process = (remaining, x, y, w, h) => {
        if (remaining.length === 0) return;
        if (remaining.length === 1) {
            results.push({ index: remaining[0].index, x, y, w, h });
            return;
        }
        if (w <= 0 || h <= 0) return;

        const isHorizontal = w >= h;
        const side = Math.min(w, h);

        // 贪心地往当前行里塞板块，只要最差长宽比不恶化就继续
        const rowItems = [];
        const rowAreas = [];
        let bestWorst = Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const trialAreas = [...rowAreas, remaining[i].area];
            const trialWorst = worstRatio(trialAreas, side);

            if (rowItems.length === 0 || trialWorst <= bestWorst) {
                rowItems.push(remaining[i]);
                rowAreas.push(remaining[i].area);
                bestWorst = trialWorst;
            } else {
                break;
            }
        }

        const rest = remaining.slice(rowItems.length);
        const rowArea = rowAreas.reduce((a, b) => a + b, 0);

        if (isHorizontal) {
            // h 为短边，行是竖向条带（贴在左侧），条带宽度 = rowArea / h
            const stripWidth = h > 0 ? rowArea / h : 0;
            let cy = y;
            for (const it of rowItems) {
                const itemH = stripWidth > 0 ? it.area / stripWidth : 0;
                results.push({ index: it.index, x, y: cy, w: stripWidth, h: itemH });
                cy += itemH;
            }
            process(rest, x + stripWidth, y, w - stripWidth, h);
        } else {
            // w 为短边，行是横向条带（贴在上方），条带高度 = rowArea / w
            const stripHeight = w > 0 ? rowArea / w : 0;
            let cx = x;
            for (const it of rowItems) {
                const itemW = stripHeight > 0 ? it.area / stripHeight : 0;
                results.push({ index: it.index, x: cx, y, w: itemW, h: stripHeight });
                cx += itemW;
            }
            process(rest, x, y + stripHeight, w, h - stripHeight);
        }
    };

    process(scaled, startX, startY, startW, startH);
    return results;
};

// 给定一组数值，计算 treemap 布局（位置和尺寸均为百分比）
const computeTreemapLayout = (values) => {
    const n = values.length;
    if (n === 0) return [];

    const areas = allocateAreas(values, MIN_AREA_PERCENT);
    const treemapItems = areas.map((area, index) => ({ area, index }));
    const layout = squarify(treemapItems, { x: 0, y: 0, w: 100, h: 100 });

    const layoutMap = new Map();
    layout.forEach(l => layoutMap.set(l.index, l));

    return areas.map((_area, index) => {
        const pos = layoutMap.get(index);
        const areaPercent = (pos.w * pos.h) / 100;
        return {
            tileX: pos.x,
            tileY: pos.y,
            tileW: pos.w,
            tileH: pos.h,
            areaPercent,
            sizeClass: getSizeClass(areaPercent),
        };
    });
};

const buildHeatmapItems = (dataList, valueKey = 'money') => {
    if (!dataList || dataList.length === 0) return [];

    const sortedItems = [...dataList].sort((a, b) => Math.abs(b[valueKey]) - Math.abs(a[valueKey]));

    const maxAbsValue = sortedItems.length > 0 ? Math.abs(sortedItems[0][valueKey] || 0) : 0;

    const values = sortedItems.map(item => Math.abs(item[valueKey] || 0));
    const layouts = computeTreemapLayout(values);

    return sortedItems.map((item, index) => {
        const value = item[valueKey] || 0;
        const absValue = Math.abs(value);
        const intensity = maxAbsValue > 0 ? absValue / maxAbsValue : 0;
        const isPositive = value >= 0;

        const layout = layouts[index];
        const areaPercent = layout.areaPercent;

        const saturation = 0.25 + intensity * 0.65;
        const brightness = isPositive ? `rgba(245, 34, 45, ${saturation})` : `rgba(82, 196, 26, ${saturation})`;
        const borderLightness = isPositive ? 'rgba(220, 20, 60, 0.45)' : 'rgba(67, 160, 71, 0.45)';

        const shouldUseWhiteText = intensity >= 0.4 || areaPercent >= 8;

        return {
            ...item,
            rank: index + 1,
            intensity,
            value,
            toneClass: isPositive ? 'positive' : 'negative',
            sizeClass: layout.sizeClass,
            tileX: layout.tileX,
            tileY: layout.tileY,
            tileW: layout.tileW,
            tileH: layout.tileH,
            areaPercent,
            heatColor: brightness,
            borderColor: borderLightness,
            textColor: shouldUseWhiteText ? '#ffffff' : '#1f2937',
            subTextColor: shouldUseWhiteText ? 'rgba(255, 255, 255, 0.85)' : 'rgba(75, 85, 99, 0.8)',
        };
    });
};

const BlockMoneyChange = ({ defaultTab = 'intraday' }) => {
    const [timeSeriesData, setTimeSeriesData] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [selectedBlocks, setSelectedBlocks] = useState(DEFAULT_SELECTED_BLOCKS);
    const [viewMode, setViewMode] = useState('line'); // 'heatmap' or 'bar' or 'line'
    const [historyViewMode, setHistoryViewMode] = useState('line'); // 'line' or 'heatmap'
    const [historyHeatmapTab, setHistoryHeatmapTab] = useState('today'); // 'today' or 'fiveDay'
    const [modalBlock, setModalBlock] = useState(null); // 当前打开折线图弹窗的板块名
    const [activeTab, setActiveTab] = useState(defaultTab); // 'intraday' 当日资金 | 'history' 历史资金 | 'rzrq' 融资余额 | 'crowd' 拥挤度
    const [dayHistory, setDayHistory] = useState([]); // 按天维度的板块资金历史
    const [rzrqData, setRzrqData] = useState([]);
    const [rzrqLoading, setRzrqLoading] = useState(false);
    const [dateRange, setDateRange] = useState([
        dayjs().subtract(30, 'day'),
        dayjs(),
    ]);
    const rzBalanceChartRef = useRef(null);
    const rzBuyChartRef = useRef(null);
    const rzBalanceContainerRef = useRef(null);
    const rzBuyContainerRef = useRef(null);
    // 拥挤度 tab
    const [crowdData, setCrowdData] = useState([]);
    const [crowdLoading, setCrowdLoading] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [crowdDateRange, setCrowdDateRange] = useState([
        dayjs('2026-04-01'),
        dayjs(),
    ]);
    const crowdChartRef = useRef(null);
    const crowdContainerRef = useRef(null);
    const ratioChartRef = useRef(null);
    const ratioContainerRef = useRef(null);
    const [indexKlineData, setIndexKlineData] = useState(null);
    const [indexLoading, setIndexLoading] = useState(false);
    // 页面已移除手动回放控制，默认保持实时跟随最新一帧
    const isRealTimeRef = useRef(true);

    // 历史成交 tab
    const [dayAmountData, setDayAmountData] = useState([]);
    const [dayChangeData, setDayChangeData] = useState([]);
    const [dayAmountLoading, setDayAmountLoading] = useState(true);
    const [dayAmountRefreshing, setDayAmountRefreshing] = useState(false);
    const [dayAmountViewMode, setDayAmountViewMode] = useState('grid');
    const [dayAmountSelectedBlocks, setDayAmountSelectedBlocks] = useState([]);
    const [dayAmountAllBlocks, setDayAmountAllBlocks] = useState([]);
    const [dayAmountDiagnosisModalVisible, setDayAmountDiagnosisModalVisible] = useState(false);
    const [dayAmountDiagnosisLoading, setDayAmountDiagnosisLoading] = useState(false);
    const [dayAmountDiagnosisResult, setDayAmountDiagnosisResult] = useState(null);
    const dayAmountChartRefs = useRef({});
    const dayAmountCombinedChartRef = useRef(null);
    const dayAmountCombinedChartContainerRef = useRef(null);
    const dayAmountTooltipRef = useRef(null);

    // 将 time 字段解析为当日分钟数，便于区间过滤；无法解析时返回 -1
    const parseTimeToMinutes = (time) => {
        if (time === undefined || time === null) return -1;
        const digitOnlyTime = String(time).trim().replace(/\D/g, '');
        if (digitOnlyTime.length < 4) return -1;
        const hh = parseInt(digitOnlyTime.slice(0, 2), 10);
        const mm = parseInt(digitOnlyTime.slice(2, 4), 10);
        return hh * 60 + mm;
    };

    // 过滤掉中午休盘(11:30 ~ 13:00)和下午闭盘后(>15:00)的数据
    const filterTradingTime = (data) => {
        return data.filter((item) => {
            const minutes = parseTimeToMinutes(item.time);
            if (minutes < 0) return true; // 无法解析的时间保留
            if (minutes > 11 * 60 + 30 && minutes < 13 * 60) return false; // 午休
            if (minutes > 15 * 60) return false; // 闭盘后
            return true;
        });
    };

    const fetchTimeData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_block_money_change_time`);
            if (response.data && Array.isArray(response.data)) {
                const filtered = filterTradingTime(response.data);
                setTimeSeriesData(filtered);
                if (isRealTimeRef.current && filtered.length > 0) {
                    setCurrentIndex(filtered.length - 1);
                }
            }
        } catch (error) {
            console.error('Fetch block money change time failed:', error);
            setTimeSeriesData([]);
            setCurrentIndex(0);
        }
    };

    useEffect(() => {
        fetchTimeData();
        const timer = setInterval(fetchTimeData, 3000);
        return () => clearInterval(timer);
    }, []);

    // 拉取按天维度的板块资金历史，每 5 分钟刷新一次
    const fetchDayHistory = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_block_money_change_day_history`);
            if (response.data && Array.isArray(response.data)) {
                setDayHistory(response.data);
            }
        } catch (error) {
            console.error('Fetch block money change day history failed:', error);
            setDayHistory([]);
        }
    };

    useEffect(() => {
    fetchDayHistory();
    const timer = setInterval(fetchDayHistory, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // ============ 历史成交 tab 相关函数 ============
  const formatDayAmountDate = (dateStr) => {
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  const formatDayAmount = (amount) => {
    if (amount >= 100000000) {
      return `${(amount / 100000000).toFixed(2)} 亿`;
    } else if (amount >= 10000) {
      return `${(amount / 10000).toFixed(2)} 万`;
    }
    return `${amount}`;
  };

  const fetchDayAmountData = async () => {
    try {
      setDayAmountLoading(true);
      const [amountRes, changeRes] = await Promise.all([
        axios.get(`http://${local_ip}:3000/get_block_money_day_history`),
        axios.get(`http://${local_ip}:3000/block_day_history`),
      ]);

      const sortedAmountData = [...amountRes.data].sort((a, b) => a.date.localeCompare(b.date));
      const sortedChangeData = [...changeRes.data].sort((a, b) => a.date.localeCompare(b.date));

      setDayAmountData(sortedAmountData);
      setDayChangeData(sortedChangeData);

      if (sortedAmountData.length > 0) {
        const blocks = Object.keys(sortedAmountData[sortedAmountData.length - 1].blockAmounts);
        setDayAmountAllBlocks(blocks);
        if (dayAmountSelectedBlocks.length === 0) {
          setDayAmountSelectedBlocks(['光模块', 'cpo', '半导体', '银行', '存储']);
        }
      }
    } catch (err) {
      console.error('Fetch block money day history failed:', err);
    } finally {
      setDayAmountLoading(false);
    }
  };

  const refreshDayAmountData = async () => {
    try {
      setDayAmountRefreshing(true);
      await axios.get(`http://${local_ip}:3000/update_block_money_day_history`);
      await fetchDayAmountData();
    } catch (err) {
      console.error('Refresh day amount data failed:', err);
    } finally {
      setDayAmountRefreshing(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'dayAmount') {
      fetchDayAmountData();
    }
  }, [activeTab]);

  useEffect(() => {
    if (!dayAmountLoading && dayAmountData.length > 0 && dayChangeData.length > 0) {
      if (dayAmountViewMode === 'grid') {
        renderDayAmountGridCharts();
      } else if (dayAmountViewMode === 'combined') {
        renderDayAmountCombinedChart();
      }
    }
  }, [dayAmountLoading, dayAmountData, dayChangeData, dayAmountViewMode, dayAmountSelectedBlocks]);

  useEffect(() => {
    const handleResize = () => {
      if (dayAmountViewMode === 'grid') {
        Object.values(dayAmountChartRefs.current).forEach((chart) => {
          if (chart && chart.container && chart.instance) {
            chart.instance.applyOptions({ width: chart.container.clientWidth });
          }
        });
      } else if (dayAmountCombinedChartRef.current && dayAmountCombinedChartContainerRef.current) {
        dayAmountCombinedChartRef.current.applyOptions({ width: dayAmountCombinedChartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [dayAmountViewMode]);

  const createDayAmountBaseChart = (container, height = 250) => {
    return createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: container.clientWidth,
      height: height,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      timeScale: {
        timeVisible: false,
        secondsVisible: false,
        borderColor: '#D1D4DC',
        visible: true,
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        visible: true,
      },
      handleScroll: false,
      handleScale: false,
    });
  };

  const renderDayAmountGridCharts = () => {
    Object.values(dayAmountChartRefs.current).forEach((chart) => {
      if (chart && chart.instance) {
        chart.instance.remove();
      }
    });
    dayAmountChartRefs.current = {};

    if (!dayAmountData || dayAmountData.length === 0 || !dayChangeData || dayChangeData.length === 0) {
      return;
    }

    const changeDateMap = {};
    dayChangeData.forEach((item) => {
      changeDateMap[item.date] = item;
    });

    dayAmountSelectedBlocks.forEach((blockName, index) => {
      const containerId = `day-amount-chart-${blockName}`;
      const container = document.getElementById(containerId);
      if (!container) return;

      const chart = createDayAmountBaseChart(container, 200);

      const changeChartData = [];
      dayAmountData.forEach((amountItem) => {
        const changeItem = changeDateMap[amountItem.date];
        if (changeItem) {
          const blockData = changeItem.blocks[blockName];
          if (blockData && blockData.avgChange !== undefined) {
            const dateStr = formatDayAmountDate(amountItem.date);
            const [year, month, day] = dateStr.split('-');
            changeChartData.push({
              time: {
                year: parseInt(year),
                month: parseInt(month),
                day: parseInt(day),
              },
              value: blockData.avgChange,
            });
          }
        }
      });

      if (changeChartData.length === 0) return;

      const maxAmount = Math.max(...dayAmountData.map(item => item.blockAmounts[blockName] || 0));
      const minChange = Math.min(...changeChartData.map(d => d.value));
      const maxChange = Math.max(...changeChartData.map(d => d.value));
      const changeRange = maxChange - minChange;

      const histogramSeries = chart.addHistogramSeries({
        color: `${BLOCK_COLORS[index % BLOCK_COLORS.length]}30`,
        priceFormat: {
          type: 'custom',
          formatter: (value) => '',
        },
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
      });

      const amountChartData = dayAmountData.map((item) => {
        const amount = item.blockAmounts[blockName] || 0;
        const normalizedValue = changeRange > 0 ? (amount / maxAmount) * changeRange : 0;
        const dateStr = formatDayAmountDate(item.date);
        const [year, month, day] = dateStr.split('-');
        return {
          time: {
            year: parseInt(year),
            month: parseInt(month),
            day: parseInt(day),
          },
          value: normalizedValue,
          color: `${BLOCK_COLORS[index % BLOCK_COLORS.length]}30`,
        };
      });

      histogramSeries.setData(amountChartData);

      const lineSeries = chart.addLineSeries({
        color: BLOCK_COLORS[index % BLOCK_COLORS.length],
        lineWidth: 2,
        priceFormat: {
          type: 'price',
          precision: 2,
          formatter: (value) => `${value.toFixed(2)}%`,
        },
        priceScaleId: 'left',
      });

      lineSeries.setData(changeChartData);

      chart.priceScale('left').applyOptions({
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
        borderVisible: true,
        borderColor: '#D1D4DC',
        visible: true,
      });

      chart.priceScale('right').applyOptions({
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
        borderVisible: false,
        visible: false,
      });

      chart.timeScale().applyOptions({
        tickMarkFormatter: (time) => {
          if (typeof time === 'object' && time.year) {
            return `${time.month}-${time.day}`;
          }
          return '';
        },
      });

      chart.applyOptions({
        localization: {
          timeFormatter: (time) => {
            if (typeof time === 'object' && time.year) {
              return `${time.year}-${time.month}-${time.day}`;
            }
            return '';
          },
        },
      });

      chart.timeScale().fitContent();

      dayAmountChartRefs.current[blockName] = {
        instance: chart,
        container,
        lineSeries,
        histogramSeries,
        blockName,
      };

      const dateToDataMap = {};
      dayAmountData.forEach((item) => {
        const dateStr = formatDayAmountDate(item.date);
        const [year, month, day] = dateStr.split('-');
        const businessDay = {
          year: parseInt(year),
          month: parseInt(month),
          day: parseInt(day),
        };
        dateToDataMap[JSON.stringify(businessDay)] = item;
      });

      let tooltipEl = container.querySelector('.chart-tooltip');
      if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'chart-tooltip';
        tooltipEl.style.cssText = `
          position: absolute;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 8px 12px;
          border-radius: 4px;
          font-size: 12px;
          pointer-events: none;
          z-index: 1000;
          display: none;
        `;
        container.style.position = 'relative';
        container.appendChild(tooltipEl);
      }

      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData) {
          tooltipEl.style.display = 'none';
          return;
        }

        const lineData = param.seriesData.get(lineSeries);
        if (!lineData) {
          tooltipEl.style.display = 'none';
          return;
        }

        tooltipEl.style.display = 'block';
        const x = param.point?.x || 0;
        const y = param.point?.y || 0;
        tooltipEl.style.left = `${Math.min(x + 10, container.clientWidth - 160)}px`;
        tooltipEl.style.top = `${Math.min(y + 10, container.clientHeight - 60)}px`;

        const dateStr = typeof param.time === 'object' && param.time.year
          ? `${param.time.year}-${param.time.month}-${param.time.day}`
          : '';
        const changeValue = lineData.value.toFixed(2);

        const dateItem = dateToDataMap[JSON.stringify(param.time)];
        const amountValue = dateItem?.blockAmounts[blockName] || 0;
        let amountStr;
        if (amountValue >= 100000000) {
          amountStr = `${(amountValue / 100000000).toFixed(2)} 亿`;
        } else if (amountValue >= 10000) {
          amountStr = `${(amountValue / 10000).toFixed(2)} 万`;
        } else {
          amountStr = `${amountValue}`;
        }

        tooltipEl.innerHTML = `
          <div><strong>${dateStr}</strong></div>
          <div>涨幅: ${changeValue}%</div>
          <div>成交: ${amountStr}</div>
        `;
      });
    });
  };

  const renderDayAmountCombinedChart = () => {
    if (dayAmountCombinedChartRef.current) {
      dayAmountCombinedChartRef.current.remove();
    }

    if (!dayAmountCombinedChartContainerRef.current) return;

    const chart = createDayAmountBaseChart(dayAmountCombinedChartContainerRef.current, 500);
    dayAmountCombinedChartRef.current = chart;

    const dateIndexMap = {};
    dayAmountData.forEach((item, index) => {
      dateIndexMap[index] = formatDayAmountDate(item.date);
    });

    const seriesMap = {};
    dayAmountSelectedBlocks.forEach((blockName, index) => {
      const series = chart.addLineSeries({
        color: BLOCK_COLORS[index % BLOCK_COLORS.length],
        lineWidth: 2,
        priceFormat: {
          type: 'custom',
          formatter: (value) => {
            if (value >= 100000000) {
              return `${(value / 100000000).toFixed(2)} 亿`;
            } else if (value >= 10000) {
              return `${(value / 10000).toFixed(2)} 万`;
            }
            return `${value}`;
          },
        },
        lastValueVisible: true,
        priceLineVisible: true,
      });

      const chartData = dayAmountData.map((item, idx) => ({
        time: idx,
        value: item.blockAmounts[blockName] || 0,
      }));

      series.setData(chartData);
      seriesMap[blockName] = { series, color: BLOCK_COLORS[index % BLOCK_COLORS.length] };
    });

    chart.subscribeCrosshairMove((param) => {
      if (!dayAmountTooltipRef.current || !dayAmountCombinedChartContainerRef.current) return;

      if (param.time === undefined || !param.seriesData || param.seriesData.size === 0) {
        dayAmountTooltipRef.current.style.display = 'none';
        return;
      }

      dayAmountTooltipRef.current.style.display = 'block';

      const containerRect = dayAmountCombinedChartContainerRef.current.getBoundingClientRect();
      const x = param.point?.x || 0;
      const y = param.point?.y || 0;

      dayAmountTooltipRef.current.style.left = `${Math.min(x + 10, containerRect.width - 180)}px`;
      dayAmountTooltipRef.current.style.top = `${Math.min(y + 10, containerRect.height - 200)}px`;

      const dateStr = dateIndexMap[param.time] || '';
      let tooltipContent = `<div class="tooltip-date">${dateStr}</div>`;

      dayAmountSelectedBlocks.forEach((blockName) => {
        const seriesData = param.seriesData.get(seriesMap[blockName].series);
        if (seriesData) {
          const value = seriesData.value;
          let formattedValue;
          if (value >= 100000000) {
            formattedValue = `${(value / 100000000).toFixed(2)} 亿`;
          } else if (value >= 10000) {
            formattedValue = `${(value / 10000).toFixed(2)} 万`;
          } else {
            formattedValue = value;
          }
          tooltipContent += `
            <div class="tooltip-item">
              <span>
                <span class="color-dot" style="background-color: ${seriesMap[blockName].color}"></span>
                ${blockName}
              </span>
              <span>${formattedValue}</span>
            </div>
          `;
        }
      });

      dayAmountTooltipRef.current.innerHTML = tooltipContent;
    });

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        const dateStr = dateIndexMap[time] || '';
        return dateStr.substring(5);
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => dateIndexMap[time] || '',
      },
    });

    chart.timeScale().fitContent();
  };

  const handleDayAmountBlockChange = (checkedValues) => {
    setDayAmountSelectedBlocks((prev) => {
      const prevSet = new Set(prev);
      const added = checkedValues.filter((v) => !prevSet.has(v));
      const kept = prev.filter((v) => checkedValues.includes(v));
      return [...added, ...kept];
    });
  };

  const selectAllDayAmountBlocks = () => {
    setDayAmountSelectedBlocks(dayAmountAllBlocks);
  };

  const resetDayAmountToDefault = () => {
    setDayAmountSelectedBlocks(['光模块', 'cpo', '半导体', '银行']);
  };

  const handleDayAmountDiagnosis = async () => {
    try {
      setDayAmountDiagnosisLoading(true);
      setDayAmountDiagnosisModalVisible(true);

      const [changeDataRes, amountDataRes] = await Promise.all([
        axios.get(`http://${local_ip}:3000/block_day_history`),
        axios.get(`http://${local_ip}:3000/get_block_money_day_history`),
      ]);

      const changeData = changeDataRes.data;
      const amountData = amountDataRes.data;

      const sortedChangeData = [...changeData].sort((a, b) => b.date.localeCompare(a.date));
      const sortedAmountData = [...amountData].sort((a, b) => b.date.localeCompare(a.date));

      if (sortedChangeData.length < 2 || sortedAmountData.length < 2) {
        return;
      }

      const changeDates = new Set(sortedChangeData.map(d => d.date));
      const amountDates = new Set(sortedAmountData.map(d => d.date));
      const commonDates = [...changeDates].filter(d => amountDates.has(d)).sort((a, b) => b.localeCompare(a));

      if (commonDates.length < 2) {
        return;
      }

      const latestDate = commonDates[0];
      const avgDates = commonDates.slice(1, 6);

      if (avgDates.length === 0) {
        return;
      }

      const latestChange = sortedChangeData.find(d => d.date === latestDate);
      const latestAmount = sortedAmountData.find(d => d.date === latestDate);

      const avgAmountDataList = avgDates.map(date =>
        sortedAmountData.find(d => d.date === date)
      ).filter(Boolean);

      const allBlockNames = new Set([
        ...Object.keys(latestChange.blocks),
        ...Object.keys(latestAmount.blockAmounts),
        ...avgAmountDataList.reduce((acc, d) => [...acc, ...Object.keys(d.blockAmounts)], []),
      ]);

      const result = {
        priceUpVolumeUp: [],
        priceDownVolumeUp: [],
        priceDownVolumeDown: [],
        priceUpVolumeDown: [],
      };

      allBlockNames.forEach((blockName) => {
        const latestBlockChange = latestChange.blocks[blockName];
        const latestBlockAmount = latestAmount.blockAmounts[blockName];

        const avgAmounts = avgAmountDataList
          .map(d => d.blockAmounts[blockName])
          .filter(v => v !== undefined);

        if (latestBlockChange && latestBlockAmount && avgAmounts.length > 0) {
          const avgAmount = avgAmounts.reduce((sum, v) => sum + v, 0) / avgAmounts.length;
          const isPriceUp = latestBlockChange.avgChange > 0;
          const isVolumeUp = latestBlockAmount > avgAmount;
          const volumeChangePercent = ((latestBlockAmount - avgAmount) / avgAmount * 100);

          const blockInfo = {
            name: blockName,
            change: latestBlockChange.avgChange,
            volumeChange: volumeChangePercent.toFixed(2),
            isVolumeUp,
            currentAmount: latestBlockAmount,
            prevAmount: avgAmount,
          };

          if (isPriceUp && isVolumeUp) {
            result.priceUpVolumeUp.push(blockInfo);
          } else if (!isPriceUp && isVolumeUp) {
            result.priceDownVolumeUp.push(blockInfo);
          } else if (!isPriceUp && !isVolumeUp) {
            result.priceDownVolumeDown.push(blockInfo);
          } else {
            result.priceUpVolumeDown.push(blockInfo);
          }
        }
      });

      result.priceUpVolumeUp.sort((a, b) => b.change - a.change);
      result.priceDownVolumeUp.sort((a, b) => a.change - b.change);
      result.priceDownVolumeDown.sort((a, b) => a.change - b.change);
      result.priceUpVolumeDown.sort((a, b) => b.change - a.change);

      setDayAmountDiagnosisResult(result);
    } catch (err) {
      console.error('Diagnosis failed:', err);
    } finally {
      setDayAmountDiagnosisLoading(false);
    }
  };

  const handleDayAmountDiagnosisBlockClick = (blockName) => {
    setDayAmountSelectedBlocks((prev) => {
      const filtered = prev.filter((b) => b !== blockName);
      return [blockName, ...filtered];
    });
    setDayAmountDiagnosisModalVisible(false);
  };

  // ============ 历史成交 tab 相关函数结束 ============

  const fetchRZRQData = async () => {
    if (!dateRange[0] || !dateRange[1]) return;
    setRzrqLoading(true);
    try {
      const startDate = dateRange[0].format('YYYY-MM-DD');
      const endDate = dateRange[1].format('YYYY-MM-DD');
      const response = await axios.get(`http://${local_ip}:3000/get_rzrq_data`, {
        params: { startDate, endDate },
      });
      if (response.data && Array.isArray(response.data)) {
        setRzrqData(response.data);
      }
    } catch (error) {
      console.error('Fetch RZRQ data failed:', error);
      setRzrqData([]);
    } finally {
      setRzrqLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'rzrq') {
      fetchRZRQData();
    }
  }, [activeTab, dateRange]);

  useEffect(() => {
    if (!rzrqData.length || !rzBalanceContainerRef.current || !rzBuyContainerRef.current) return;

    if (rzBalanceChartRef.current) {
      rzBalanceChartRef.current.remove();
    }
    if (rzBuyChartRef.current) {
      rzBuyChartRef.current.remove();
    }

    const createRZChart = (container, data, valueKey, title, color, gradientTop, gradientBottom) => {
      const chart = createChart(container, {
        layout: {
          background: { type: ColorType.Solid, color: '#ffffff' },
          textColor: '#666666',
          fontSize: 12,
        },
        width: container.clientWidth || 600,
        height: 400,
        grid: {
          vertLines: { color: '#f5f5f5', style: LineStyle.Dotted },
          horzLines: { color: '#f5f5f5', style: LineStyle.Dotted },
        },
        timeScale: {
          borderColor: '#e8e8e8',
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time) => {
            if (typeof time === 'number') {
              return dayjs.unix(time).format('MM-DD');
            }
            return time;
          },
        },
        localization: {
          timeFormatter: (time) => {
            if (typeof time === 'number') {
              return dayjs.unix(time).format('MM-DD');
            }
            return time;
          },
        },
        leftPriceScale: {
          borderColor: '#e8e8e8',
          autoScale: true,
          scaleMargins: {
            top: 0.05,
            bottom: 0.05,
          },
        },
        handleScroll: false,
        handleScale: false,
        crosshair: {
          mode: 1,
          vertLine: {
            color: '#999',
            style: LineStyle.Dotted,
            labelBackgroundColor: '#1f2937',
            labelFormat: (time) => {
              if (typeof time === 'number') {
                return dayjs.unix(time).format('YYYY-MM-DD');
              }
              return time;
            },
          },
          horzLine: {
            color: '#999',
            style: LineStyle.Dotted,
            labelBackgroundColor: '#1f2937',
          },
        },
      });

      const areaSeries = chart.addAreaSeries({
        lineColor: color,
        topColor: gradientTop,
        bottomColor: gradientBottom,
        lineWidth: 2.5,
        priceFormat: {
          type: 'custom',
          formatter: (value) => `${value.toFixed(2)}亿`,
        },
      });

      const formattedData = data.map(item => ({
        time: dayjs(item.date).unix(),
        value: item[valueKey],
      }));

      areaSeries.setData(formattedData);
      chart.timeScale().fitContent();

      chart.timeScale().applyOptions({
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
      });

      return chart;
    };

    rzBalanceChartRef.current = createRZChart(
      rzBalanceContainerRef.current,
      rzrqData,
      'rzBalance',
      '融资余额',
      '#cf1322',
      'rgba(207, 19, 34, 0.3)',
      'rgba(207, 19, 34, 0.02)'
    );

    rzBuyChartRef.current = createRZChart(
      rzBuyContainerRef.current,
      rzrqData,
      'rzBuy',
      '融资买入',
      getThemeColor(),
      getThemeColorRgba(0.3),
      getThemeColorRgba(0.02)
    );

    const handleResize = () => {
      if (rzBalanceChartRef.current && rzBalanceContainerRef.current) {
        rzBalanceChartRef.current.applyOptions({ width: rzBalanceContainerRef.current.clientWidth });
      }
      if (rzBuyChartRef.current && rzBuyContainerRef.current) {
        rzBuyChartRef.current.applyOptions({ width: rzBuyContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (rzBalanceChartRef.current) {
        rzBalanceChartRef.current.remove();
        rzBalanceChartRef.current = null;
      }
      if (rzBuyChartRef.current) {
        rzBuyChartRef.current.remove();
        rzBuyChartRef.current = null;
      }
    };
  }, [rzrqData]);

  // ============ 拥挤度 tab ============
  const fetchCrowdData = async () => {
    if (!crowdDateRange[0] || !crowdDateRange[1]) return;
    setCrowdLoading(true);
    try {
      const startDate = crowdDateRange[0].format('YYYY-MM-DD');
      const endDate = crowdDateRange[1].format('YYYY-MM-DD');
      const response = await axios.get(`http://${local_ip}:3000/tech_block_crowd`, {
        params: { startDate, endDate },
      });
      if (response.data && Array.isArray(response.data)) {
        setCrowdData(response.data);
      } else {
        setCrowdData([]);
      }
    } catch (error) {
      console.error('Fetch tech_block_crowd data failed:', error);
      setCrowdData([]);
    } finally {
      setCrowdLoading(false);
    }
  };

  const refreshCrowdData = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await axios.get(`http://${local_ip}:3000/refresh_tech_block_crowd`);
      await fetchCrowdData();
    } catch (error) {
      console.error('Refresh tech_block_crowd data failed:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const fetchIndexKlineData = async () => {
    setIndexLoading(true);
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_index_kline_data`);
      if (response.data) {
        setIndexKlineData(response.data);
      }
    } catch (error) {
      console.error('Fetch index kline data failed:', error);
    } finally {
      setIndexLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'crowd') {
      fetchCrowdData();
      fetchIndexKlineData();
    }
  }, [activeTab, crowdDateRange]);

  useEffect(() => {
    if (activeTab !== 'crowd') return;
    if (!crowdContainerRef.current) return;

    if (crowdChartRef.current) {
      crowdChartRef.current.remove();
      crowdChartRef.current = null;
    }

    if (!crowdData.length) return;

    const chart = createChart(crowdContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#64748b',
        fontSize: 12,
      },
      width: crowdContainerRef.current.clientWidth || 600,
      height: 380,
      grid: {
        vertLines: { color: '#f1f5f9', style: LineStyle.Dotted },
        horzLines: { color: '#f1f5f9', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#e2e8f0',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('MM-DD');
          }
          return time;
        },
      },
      localization: {
        timeFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('YYYY-MM-DD');
          }
          return time;
        },
      },
      rightPriceScale: {
        borderColor: '#e2e8f0',
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#cbd5e1',
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1e293b',
          labelFormat: (time) => {
            if (typeof time === 'number') {
              return dayjs.unix(time).format('YYYY-MM-DD');
            }
            return time;
          },
        },
        horzLine: {
          color: '#cbd5e1',
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1e293b',
        },
      },
    });

    const areaSeries = chart.addAreaSeries({
      lineColor: '#7c3aed',
      topColor: 'rgba(124, 58, 237, 0.4)',
      bottomColor: 'rgba(124, 58, 237, 0.02)',
      lineWidth: 3,
      priceFormat: {
        type: 'custom',
        formatter: (value) => `${value.toFixed(1)}`,
      },
    });

    const formattedData = crowdData
      .filter(item => item.score !== null && item.score !== undefined)
      .map(item => ({
        time: dayjs(item.date, 'YYYYMMDD').unix(),
        value: item.score,
        color: item.score >= 85 ? '#ef4444' : item.score >= 70 ? '#f97316' : item.score >= 55 ? '#eab308' : item.score >= 40 ? '#22c55e' : '#3b82f6',
        level: item.level,
        date: item.date,
      }))
      .sort((a, b) => a.time - b.time);

    areaSeries.setData(formattedData);

    const levelLines = [
      { value: 85, label: '极端拥挤', color: '#ef4444' },
      { value: 70, label: '高度拥挤', color: '#f97316' },
      { value: 55, label: '轻度拥挤', color: '#eab308' },
      { value: 40, label: '正常', color: '#22c55e' },
    ];

    levelLines.forEach(({ value, label, color }) => {
      const lineSeries = chart.addLineSeries({
        color: color,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      lineSeries.setData(formattedData.map(d => ({ time: d.time, value: value })));
      
      if (formattedData.length > 0) {
        lineSeries.createPriceLine({
          price: value,
          color: color,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          title: label,
          axisLabelVisible: true,
        });
      }
    });

    const dataMap = new Map();
    formattedData.forEach(item => {
      dataMap.set(item.time, item);
    });

    const container = crowdContainerRef.current;
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-crowd-tooltip';
    tooltip.style.display = 'none';
    container.appendChild(tooltip);

    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > container.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 380
      ) {
        tooltip.style.display = 'none';
      } else {
        const dataItem = dataMap.get(param.time);
        if (!dataItem) {
          tooltip.style.display = 'none';
          return;
        }
        tooltip.innerHTML = `
          <div class="tooltip-date">${dayjs(dataItem.date, 'YYYYMMDD').format('YYYY-MM-DD')}</div>
          <div class="tooltip-score">拥挤度: <span style="color: ${dataItem.color}; font-weight: bold;">${dataItem.value.toFixed(2)}</span></div>
          <div class="tooltip-level">等级: <span style="color: ${dataItem.color}; font-weight: bold;">${dataItem.level}</span></div>
        `;
        tooltip.style.left = `${param.point.x - 100}px`;
        tooltip.style.top = `${param.point.y - 80}px`;
        tooltip.style.display = 'block';
      }
    });

    chart.timeScale().fitContent();

    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
    });

    crowdChartRef.current = chart;

    const handleCrowdResize = () => {
      if (crowdChartRef.current && crowdContainerRef.current) {
        crowdChartRef.current.applyOptions({ width: crowdContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleCrowdResize);

    return () => {
      window.removeEventListener('resize', handleCrowdResize);
      if (crowdChartRef.current) {
        crowdChartRef.current.remove();
        crowdChartRef.current = null;
      }
    };
  }, [crowdData, activeTab]);

  useEffect(() => {
    if (activeTab !== 'crowd') return;
    if (!ratioContainerRef.current) return;

    if (ratioChartRef.current) {
      ratioChartRef.current.remove();
      ratioChartRef.current = null;
    }

    if (!crowdData.length) return;

    const chart = createChart(ratioContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#64748b',
        fontSize: 12,
      },
      width: ratioContainerRef.current.clientWidth || 600,
      height: 380,
      grid: {
        vertLines: { color: '#f1f5f9', style: LineStyle.Dotted },
        horzLines: { color: '#f1f5f9', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#e2e8f0',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('MM-DD');
          }
          return time;
        },
      },
      localization: {
        timeFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('YYYY-MM-DD');
          }
          return time;
        },
      },
      rightPriceScale: {
        borderColor: '#e2e8f0',
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#cbd5e1',
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1e293b',
          labelFormat: (time) => {
            if (typeof time === 'number') {
              return dayjs.unix(time).format('YYYY-MM-DD');
            }
            return time;
          },
        },
        horzLine: {
          color: '#cbd5e1',
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1e293b',
        },
      },
    });

    const areaSeries = chart.addAreaSeries({
      lineColor: '#3b82f6',
      topColor: 'rgba(59, 130, 246, 0.4)',
      bottomColor: 'rgba(59, 130, 246, 0.02)',
      lineWidth: 3,
      priceFormat: {
        type: 'custom',
        formatter: (value) => `${value.toFixed(2)}%`,
      },
    });

    const formattedData = crowdData
      .map(item => ({
        time: dayjs(item.date, 'YYYYMMDD').unix(),
        value: item.ratio,
      }))
      .sort((a, b) => a.time - b.time);

    areaSeries.setData(formattedData);
    chart.timeScale().fitContent();

    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
    });

    ratioChartRef.current = chart;

    const handleRatioResize = () => {
      if (ratioChartRef.current && ratioContainerRef.current) {
        ratioChartRef.current.applyOptions({ width: ratioContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleRatioResize);

    return () => {
      window.removeEventListener('resize', handleRatioResize);
      if (ratioChartRef.current) {
        ratioChartRef.current.remove();
        ratioChartRef.current = null;
      }
    };
  }, [crowdData, activeTab]);

  const allBlocks = useMemo(() => {
        if (!dayHistory.length) return [];

        const sortedHistory = [...dayHistory]
            .filter(item => item?.date)
            .sort((a, b) => b.date.localeCompare(a.date));
        const latestBlocks = sortedHistory[0]?.data || [];
        const blockSet = new Set(latestBlocks.map(item => item.block));

        sortedHistory.forEach(historyItem => {
            historyItem.data?.forEach(item => {
                if (!blockSet.has(item.block)) {
                    blockSet.add(item.block);
                }
            });
        });
        return Array.from(blockSet);
    }, [dayHistory]);

    useEffect(() => {
        if (!allBlocks.length) {
            setSelectedBlocks([]);
            return;
        }

        setSelectedBlocks(prev => {
            const validPrev = prev.filter(block => allBlocks.includes(block));
            if (validPrev.length > 0) {
                return validPrev;
            }

            const preferredBlocks = DEFAULT_SELECTED_BLOCKS.filter(block => allBlocks.includes(block));
            if (preferredBlocks.length > 0) {
                return preferredBlocks;
            }

            return allBlocks.slice(0, Math.min(14, allBlocks.length));
        });
    }, [allBlocks]);

    const currentData = useMemo(() => {
        const data = timeSeriesData[currentIndex]?.data || [];
        return data.filter(item => selectedBlocks.includes(item.block));
    }, [timeSeriesData, currentIndex, selectedBlocks]);

    const latestIntradayData = useMemo(() => {
        const latestData = timeSeriesData[timeSeriesData.length - 1]?.data || [];
        return latestData.filter(item => selectedBlocks.includes(item.block));
    }, [timeSeriesData, selectedBlocks]);

    // 柱状图数据 - 复用 currentData，按资金净流入排序，并计算排名变化
    const barChartData = useMemo(() => {
        if (!currentData || currentData.length === 0) return null;

        // 按资金净流入降序排序（正数在前，负数在后）
        const sortedData = [...currentData].sort((a, b) => b.money - a.money);

        // 计算上一帧的排名（按 money 降序）
        const prevData = timeSeriesData[currentIndex - 1]?.data || [];
        const prevFiltered = prevData.filter(item => selectedBlocks.includes(item.block));
        const prevSorted = [...prevFiltered].sort((a, b) => b.money - a.money);
        const prevRankMap = new Map();
        prevSorted.forEach((item, idx) => {
            prevRankMap.set(item.block, idx);
        });

        // rankChange > 0 表示排名前进（名次数字变小），< 0 表示后退
        const rankChanges = sortedData.map((item, currentRank) => {
            const prevRank = prevRankMap.get(item.block);
            if (prevRank === undefined) return 0; // 上一帧不存在该板块
            return prevRank - currentRank;
        });

        return {
            labels: sortedData.map((item) => item.block),
            datasets: [
                {
                    label: '资金净流入',
                    data: sortedData.map((item) => item.money),
                    backgroundColor: sortedData.map((item) => {
                        if (item.money > 0) return 'rgba(207, 19, 34, 0.6)';
                        if (item.money < 0) return 'rgba(56, 158, 13, 0.6)';
                        return 'rgba(89, 89, 89, 0.6)';
                    }),
                    borderColor: sortedData.map((item) => {
                        if (item.money > 0) return 'rgba(207, 19, 34, 1)';
                        if (item.money < 0) return 'rgba(56, 158, 13, 1)';
                        return 'rgba(89, 89, 89, 1)';
                    }),
                    borderWidth: 1,
                    rankChanges,
                    jumpUrls: sortedData.map((item) => item.jumpUrl),
                },
            ],
        };
    }, [currentData, timeSeriesData, currentIndex, selectedBlocks]);

    // 大幅流入/流出提示 - 对比上一帧，变化超过 5 亿的板块
    const BIG_CHANGE_THRESHOLD = 500000000; // 5 亿
    const bigChanges = useMemo(() => {
        if (currentIndex <= 0) return [];
        const prevData = timeSeriesData[currentIndex - 1]?.data || [];
        const prevMap = new Map();
        prevData.forEach((item) => {
            if (selectedBlocks.includes(item.block)) {
                prevMap.set(item.block, item.money);
            }
        });
        const changes = [];
        currentData.forEach((item) => {
            const prevMoney = prevMap.get(item.block);
            if (prevMoney === undefined) return;
            const diff = item.money - prevMoney;
            if (Math.abs(diff) >= BIG_CHANGE_THRESHOLD) {
                changes.push({
                    block: item.block,
                    diff,
                    type: diff > 0 ? 'inflow' : 'outflow',
                });
            }
        });
        // 按绝对值降序
        changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
        return changes;
    }, [timeSeriesData, currentIndex, currentData, selectedBlocks]);

    const formatMoney = (money) => {
        const yi = money / 100000000;
        const sign = money > 0 ? '+' : '';
        return `${sign}${yi.toFixed(1)}亿`;
    };

    const heatmapItems = useMemo(() => {
        return buildHeatmapItems(currentData, 'money');
    }, [currentData]);

    const todayHistoryHeatmapItems = useMemo(() => {
        return buildHeatmapItems(latestIntradayData, 'money');
    }, [latestIntradayData]);

    const formatTime = (time) => {
        if (!time) {
            return '--:--';
        }

        const rawTime = String(time).trim();
        const hhmmMatch = rawTime.match(/^(\d{2})(\d{2})/);

        if (hhmmMatch) {
            return `${hhmmMatch[1]}:${hhmmMatch[2]}`;
        }

        const digitOnlyTime = rawTime.replace(/\D/g, '');
        if (digitOnlyTime.length >= 4) {
            return `${digitOnlyTime.slice(0, 2)}:${digitOnlyTime.slice(2, 4)}`;
        }

        return rawTime;
    };

    const barChartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { bottom: 8 } },
        // 点击柱子或 x 轴标签打开该板块资金折线图弹窗
        onClick: (event, elements) => {
            if (elements && elements.length > 0) {
                const index = elements[0].index;
                const label = event.chart.data.labels[index];
                setModalBlock(label);
            }
        },
        // 鼠标悬停在可跳转柱子上时显示手型
        onHover: (event, elements) => {
            if (event.native && event.native.target) {
                event.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
            }
        },
        plugins: {
            legend: { position: 'top' },
            title: {
                display: true,
                text: `板块资金净流入 (${formatTime(timeSeriesData[currentIndex]?.time)})`,
            },
            tooltip: {
                callbacks: {
                    label: (context) => {
                        const money = context.parsed.y;
                        const yi = money / 100000000;
                        const sign = money > 0 ? '+' : '';
                        return `资金: ${sign}${yi.toFixed(2)} 亿`;
                    },
                },
            },
        },
        scales: {
            x: {
                title: { display: true, text: '板块名称' },
                ticks: {
                    autoSkip: false,
                    maxRotation: 75,
                    minRotation: 75,
                    padding: 4,
                    font: { size: 12 },
                    // 在标签后追加排名变化箭头
                    callback: function(value, index) {
                        const rankChanges = this.chart.data.datasets[0]?.rankChanges;
                        if (!rankChanges) return this.getLabelForValue(value);
                        const change = rankChanges[index];
                        const label = this.getLabelForValue(value);
                        if (change > 0) return `${label} ↑${change}`;
                        if (change < 0) return `${label} ↓${Math.abs(change)}`;
                        return `${label} -`;
                    },
                    // 根据排名变化设置标签颜色：红涨绿跌
                    color: function(context) {
                        const rankChanges = context.chart.data.datasets[0]?.rankChanges;
                        if (!rankChanges) return '#666';
                        const change = rankChanges[context.index];
                        if (change > 0) return 'rgba(207, 19, 34, 1)';   // 前进-红色
                        if (change < 0) return 'rgba(56, 158, 13, 1)';   // 后退-绿色
                        return '#999'; // 不变-灰色
                    },
                },
            },
            y: {
                title: { display: true, text: '资金净流入 (元)' },
                ticks: {
                    callback: (value) => {
                        const yi = value / 100000000;
                        return `${yi.toFixed(1)}亿`;
                    },
                },
            },
        },
    }), [timeSeriesData, currentIndex]);

    // 折线图视图：展示所有选中板块在整个时间序列上的资金净流入趋势
    const LINE_COLOR_PALETTE = [
        'rgba(207, 19, 34, 1)',
        'rgba(56, 158, 13, 1)',
        'rgba(47, 84, 235, 1)',
        'rgba(250, 173, 20, 1)',
        'rgba(114, 46, 209, 1)',
        'rgba(19, 194, 194, 1)',
        'rgba(235, 47, 150, 1)',
        'rgba(82, 196, 26, 1)',
        'rgba(24, 144, 255, 1)',
        'rgba(255, 159, 64, 1)',
        'rgba(153, 102, 255, 1)',
        'rgba(0, 188, 212, 1)',
        'rgba(233, 30, 99, 1)',
        'rgba(139, 195, 74, 1)',
        'rgba(3, 169, 244, 1)',
        'rgba(255, 87, 34, 1)',
    ];

    // 折线图视图：每个板块独立一个折线图，一行四个
    const lineChartItems = useMemo(() => {
        if (!timeSeriesData.length || selectedBlocks.length === 0) return [];
        const labels = timeSeriesData.map(timeFrame => formatTime(timeFrame.time));
        return selectedBlocks.map((block, idx) => {
            const color = LINE_COLOR_PALETTE[idx % LINE_COLOR_PALETTE.length];
            const data = timeSeriesData.map(timeFrame => {
                const blockItem = timeFrame.data?.find(item => item.block === block);
                return blockItem ? blockItem.money : null;
            });
            return {
                block,
                data: {
                    labels,
                    datasets: [{
                        label: block,
                        data,
                        borderColor: color,
                        backgroundColor: color.replace(/, 1\)$/, ', 0.08)'),
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2,
                        pointHoverRadius: 4,
                        spanGaps: true,
                        pointBackgroundColor: data.map(m => {
                            if (m === null || m === undefined) return '#999';
                            if (m > 0) return 'rgba(207, 19, 34, 1)';
                            if (m < 0) return 'rgba(56, 158, 13, 1)';
                            return '#999';
                        }),
                    }],
                },
            };
        });
    }, [timeSeriesData, selectedBlocks]);

    // 'YYYYMMDD' -> 'MM-DD'，跨年显示 'YYYY-MM-DD'
    const formatDayLabel = (dateStr) => {
        if (!dateStr || dateStr.length !== 8) return dateStr || '';
        const y = dateStr.substring(0, 4);
        const m = dateStr.substring(4, 6);
        const d = dateStr.substring(6, 8);
        const now = new Date();
        if (y === String(now.getFullYear())) return `${m}-${d}`;
        return `${y}-${m}-${d}`;
    };

    // 历史资金折线图：每个选中板块一张图，X 轴为日期（从旧到新）
    const dayHistoryChartItems = useMemo(() => {
        if (!dayHistory.length || selectedBlocks.length === 0) return [];
        // 后端数据按从新到旧排列，图表需要从旧到新
        const sorted = [...dayHistory]
            .filter(item => item.date)
            .sort((a, b) => a.date.localeCompare(b.date));
        const labels = sorted.map(item => formatDayLabel(item.date));
        return selectedBlocks.map((block, idx) => {
            const color = LINE_COLOR_PALETTE[idx % LINE_COLOR_PALETTE.length];
            const data = sorted.map(item => {
                const blockItem = item.data?.find(d => d.block === block);
                return blockItem ? blockItem.money : null;
            });
            return {
                block,
                data: {
                    labels,
                    datasets: [{
                        label: block,
                        data,
                        borderColor: color,
                        backgroundColor: color.replace(/, 1\)$/, ', 0.08)'),
                        fill: true,
                        tension: 0.3,
                        pointRadius: 2,
                        pointHoverRadius: 4,
                        spanGaps: true,
                        pointBackgroundColor: data.map(m => {
                            if (m === null || m === undefined) return '#999';
                            if (m > 0) return 'rgba(207, 19, 34, 1)';
                            if (m < 0) return 'rgba(56, 158, 13, 1)';
                            return '#999';
                        }),
                    }],
                },
            };
        });
    }, [dayHistory, selectedBlocks]);

    const historyHeatmapItems = useMemo(() => {
        if (!dayHistory.length || selectedBlocks.length === 0) return [];

        const recentFiveDays = [...dayHistory]
            .filter(item => item?.date)
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-5);

        if (!recentFiveDays.length) return [];

        const latestHistory = [...dayHistory]
            .filter(item => item?.date)
            .sort((a, b) => b.date.localeCompare(a.date));

        const summaryItems = selectedBlocks.map((block) => {
            const latestBlockItem = [...dayHistory]
                .sort((a, b) => b.date.localeCompare(a.date))
                .flatMap(item => item.data || [])
                .find(item => item.block === block);
            const totalMoney = recentFiveDays.reduce((sum, dayItem) => {
                const blockItem = dayItem.data?.find(item => item.block === block);
                return sum + (blockItem?.money ?? 0);
            }, 0);

            return {
                block,
                jumpUrl: latestBlockItem?.jumpUrl,
                latestMoney: latestHistory[0]?.data?.find(item => item.block === block)?.money ?? 0,
                totalMoney,
            };
        });

        const sortedSummaryItems = [...summaryItems].sort((a, b) => Math.abs(b.totalMoney) - Math.abs(a.totalMoney));
        const maxAbsMoney = Math.max(...sortedSummaryItems.map(item => Math.abs(item.totalMoney)), 0);

        const values = sortedSummaryItems.map(item => Math.abs(item.totalMoney));
        const layouts = computeTreemapLayout(values);

        return sortedSummaryItems.map((item, index) => {
            const value = item.totalMoney;
            const absValue = Math.abs(value);
            const intensity = maxAbsMoney > 0 ? absValue / maxAbsMoney : 0;
            const isPositive = value >= 0;

            const layout = layouts[index];
            const areaPercent = layout.areaPercent;

            const saturation = 0.25 + intensity * 0.65;
            const brightness = isPositive ? `rgba(245, 34, 45, ${saturation})` : `rgba(82, 196, 26, ${saturation})`;
            const borderLightness = isPositive ? 'rgba(220, 20, 60, 0.45)' : 'rgba(67, 160, 71, 0.45)';

            const shouldUseWhiteText = intensity >= 0.4 || areaPercent >= 8;

            return {
                ...item,
                rank: index + 1,
                intensity,
                value,
                toneClass: isPositive ? 'positive' : 'negative',
                sizeClass: layout.sizeClass,
                tileX: layout.tileX,
                tileY: layout.tileY,
                tileW: layout.tileW,
                tileH: layout.tileH,
                areaPercent,
                heatColor: brightness,
                borderColor: borderLightness,
                textColor: shouldUseWhiteText ? '#ffffff' : '#1f2937',
                subTextColor: shouldUseWhiteText ? 'rgba(255, 255, 255, 0.85)' : 'rgba(75, 85, 99, 0.8)',
            };
        });
    }, [dayHistory, selectedBlocks]);

    const dayHistoryChartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            title: { display: false },
            tooltip: {
                callbacks: {
                    label: (context) => {
                        const money = context.parsed.y;
                        if (money === null || money === undefined) return '无数据';
                        const yi = money / 100000000;
                        const sign = money > 0 ? '+' : '';
                        return `资金: ${sign}${yi.toFixed(2)} 亿`;
                    },
                },
            },
        },
        scales: {
            x: {
                ticks: {
                    autoSkip: true,
                    maxTicksLimit: 8,
                    maxRotation: 45,
                    minRotation: 45,
                    font: { size: 9 },
                },
                grid: { display: false },
            },
            y: {
                ticks: {
                    callback: (value) => {
                        const yi = value / 100000000;
                        return `${yi.toFixed(1)}亿`;
                    },
                },
            },
        },
    }), []);

    const lineChartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            title: { display: false },
            tooltip: {
                callbacks: {
                    label: (context) => {
                        const money = context.parsed.y;
                        if (money === null || money === undefined) return '无数据';
                        const yi = money / 100000000;
                        const sign = money > 0 ? '+' : '';
                        return `资金: ${sign}${yi.toFixed(2)} 亿`;
                    },
                },
            },
        },
        scales: {
            x: {
                ticks: {
                    autoSkip: true,
                    maxTicksLimit: 6,
                    maxRotation: 45,
                    minRotation: 45,
                    font: { size: 9 },
                },
                grid: { display: false },
            },
            y: {
                ticks: {
                    callback: (value) => {
                        const yi = value / 100000000;
                        return `${yi.toFixed(1)}亿`;
                    },
                    font: { size: 9 },
                    maxTicksLimit: 5,
                },
            },
        },
    }), []);

    const handleCircleClick = (url) => {
        if (url) {
            window.open(url, '_blank');
        }
    };

    const handleCheckboxChange = (checkedValues) => {
        setSelectedBlocks(checkedValues);
    };

    const handleCheckAll = (checked) => {
        if (checked) {
            setSelectedBlocks(allBlocks);
        } else {
            setSelectedBlocks([]);
        }
    };

    const handleResetDefaultBlocks = () => {
        const preferredBlocks = DEFAULT_SELECTED_BLOCKS.filter(block => allBlocks.includes(block));
        setSelectedBlocks(preferredBlocks.length > 0 ? preferredBlocks : allBlocks.slice(0, Math.min(14, allBlocks.length)));
    };

    const formatLegendYi = (money) => {
        const yi = money / 100000000;
        if (Math.abs(yi) >= 10) {
            return yi.toFixed(0);
        }
        return yi.toFixed(1);
    };

    const renderHeatmapPanel = ({
        title,
        items,
        positiveText,
        neutralText,
        negativeText,
        valueKey = 'value',
        valueFormatter,
        secondaryFormatter,
    }) => {
        const maxAbsValue = items.reduce((max, item) => Math.max(max, Math.abs(item[valueKey] || 0)), 0);
        const legendValues = maxAbsValue > 0
            ? [maxAbsValue, maxAbsValue / 2, 0, -maxAbsValue / 2, -maxAbsValue]
            : [0, 0, 0, 0, 0];

        return (
            <div className="heatmap-panel">
                <div className="heatmap-header">
                    <div className="heatmap-title">{title}</div>
                    <div className="heatmap-legend">
                        <span className="legend-item legend-positive">{positiveText}</span>
                        <span className="legend-item legend-neutral">{neutralText}</span>
                        <span className="legend-item legend-negative">{negativeText}</span>
                    </div>
                </div>
                <div className="heatmap-board">
                    <div className="heatmap-treemap">
                        <div className="heatmap-treemap-caption">所有行业</div>
                        <div className="heatmap-treemap-area">
                            {items.map((item) => (
                                <button
                                    key={item.blockCode || item.block}
                                    type="button"
                                    className={`heatmap-tile ${item.toneClass} ${item.sizeClass}`}
                                    style={{
                                        '--tile-x': item.tileX,
                                        '--tile-y': item.tileY,
                                        '--tile-w': item.tileW,
                                        '--tile-h': item.tileH,
                                    }}
                                    onClick={() => handleCircleClick(item.jumpUrl)}
                                    title={`${item.block} ${valueFormatter(item)}`}
                                >
                                    <div
                                        className="heatmap-tile-inner"
                                        style={{
                                            '--tile-fill': item.heatColor,
                                            '--tile-border': item.borderColor,
                                            '--tile-text': item.textColor,
                                            '--tile-subtext': item.subTextColor,
                                        }}
                                    >
                                        <div className="heatmap-tile-content">
                                            <div className="tile-block">{item.block}</div>
                                            <div className="tile-money">{valueFormatter(item)}</div>
                                            {secondaryFormatter ? (
                                                <div className="tile-meta">{secondaryFormatter(item)}</div>
                                            ) : null}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="heatmap-scale">
                        <div className="heatmap-scale-title">净额(亿)</div>
                        <div className="heatmap-scale-bar"></div>
                        <div className="heatmap-scale-labels">
                            {legendValues.map((value, index) => (
                                <span key={`${title}-${index}`} className="heatmap-scale-label">
                                    {formatLegendYi(value)}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    // 弹窗折线图数据：所选板块在整个时间序列上的资金净流入
    const blockLineChartData = useMemo(() => {
        if (!modalBlock) return null;
        const labels = [];
        const moneyData = [];
        timeSeriesData.forEach(timeFrame => {
            labels.push(formatTime(timeFrame.time));
            const blockItem = timeFrame.data?.find(item => item.block === modalBlock);
            moneyData.push(blockItem ? blockItem.money : null);
        });
        return {
            labels,
            datasets: [{
                label: `${modalBlock} 资金净流入`,
                data: moneyData,
                borderColor: 'rgba(47, 84, 235, 1)',
                backgroundColor: 'rgba(47, 84, 235, 0.08)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: moneyData.map(m => {
                    if (m === null || m === undefined) return '#999';
                    if (m > 0) return 'rgba(207, 19, 34, 1)';
                    if (m < 0) return 'rgba(56, 158, 13, 1)';
                    return '#999';
                }),
            }],
        };
    }, [modalBlock, timeSeriesData]);

    const blockLineChartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'top' },
            title: {
                display: true,
                text: modalBlock ? `${modalBlock} - 资金净流入趋势` : '',
            },
            tooltip: {
                callbacks: {
                    label: (context) => {
                        const money = context.parsed.y;
                        if (money === null) return '资金: 无数据';
                        const yi = money / 100000000;
                        const sign = money > 0 ? '+' : '';
                        return `资金: ${sign}${yi.toFixed(2)} 亿`;
                    },
                },
            },
        },
        scales: {
            x: {
                title: { display: true, text: '时间' },
                ticks: {
                    autoSkip: true,
                    maxTicksLimit: 20,
                    maxRotation: 45,
                    minRotation: 45,
                    font: { size: 10 },
                },
            },
            y: {
                title: { display: true, text: '资金净流入 (元)' },
                ticks: {
                    callback: (value) => {
                        const yi = value / 100000000;
                        return `${yi.toFixed(1)}亿`;
                    },
                },
            },
        },
    }), [modalBlock]);

    // 复用的板块选择栏，两个 Tab 共享同一份选中状态
    const filterBar = (
        <div className="filter-bar">
            <div className="filter-header">
                <span className="filter-title">板块选择:</span>
                <Checkbox
                    checked={selectedBlocks.length === allBlocks.length && allBlocks.length > 0}
                    indeterminate={selectedBlocks.length > 0 && selectedBlocks.length < allBlocks.length}
                    onChange={(e) => handleCheckAll(e.target.checked)}
                >
                    全选
                </Checkbox>
                <Button
                    type="link"
                    size="small"
                    onClick={handleResetDefaultBlocks}
                    className="reset-default-btn"
                >
                    恢复默认
                </Button>
            </div>
            <Checkbox.Group
                options={allBlocks}
                value={selectedBlocks}
                onChange={handleCheckboxChange}
                className="checkbox-group"
            />
        </div>
    );

    return (
        <div className="block-money-container">
        <Tabs
            className="block-money-tabs"
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
                {
                    key: 'intraday',
                    label: '当日资金',
                    children: (
                        <>
                            <div className="control-bar">
                                <div className="view-toggle">
                                    <Button
                                        type={viewMode === 'heatmap' ? 'primary' : 'default'}
                                        icon={<AppstoreOutlined />}
                                        onClick={() => setViewMode('heatmap')}
                                        size="small"
                                    >
                                        热力图
                                    </Button>
                                    <Button
                                        type={viewMode === 'bar' ? 'primary' : 'default'}
                                        icon={<BarChartOutlined />}
                                        onClick={() => setViewMode('bar')}
                                        size="small"
                                    >
                                        柱状图
                                    </Button>
                                    <Button
                                        type={viewMode === 'line' ? 'primary' : 'default'}
                                        icon={<LineChartOutlined />}
                                        onClick={() => setViewMode('line')}
                                        size="small"
                                    >
                                        折线图
                                    </Button>
                                </div>
                            </div>

                            {filterBar}
            {bigChanges.length > 0 && (
                <div className="big-changes-banner">
                    {bigChanges.map((change) => {
                        const yi = Math.abs(change.diff) / 100000000;
                        const sign = change.diff > 0 ? '+' : '-';
                        return (
                            <span
                                key={change.block}
                                className={`big-change-tag ${change.type}`}
                            >
                                {change.block} {change.type === 'inflow' ? '大幅流入' : '大幅流出'} {sign}{yi.toFixed(1)}亿
                            </span>
                        );
                    })}
                </div>
            )}
            
            {viewMode === 'heatmap' && (
                <div className="heatmap-stage">
                    {heatmapItems.length > 0 ? (
                        renderHeatmapPanel({
                            title: '板块资金热力图',
                            items: heatmapItems,
                            positiveText: '流入增强',
                            neutralText: '矩形越大、颜色越深代表净额越强',
                            negativeText: '流出增强',
                            valueKey: 'money',
                            valueFormatter: (item) => formatMoney(item.money),
                            secondaryFormatter: (item) => (item.money >= 0 ? '净流入' : '净流出'),
                        })
                    ) : (
                        <div className="bar-chart-empty">暂无数据</div>
                    )}
                </div>
            )}

            {viewMode === 'bar' && (
                <div className="bar-chart-stage">
                    {barChartData ? (
                        <Bar data={barChartData} options={barChartOptions} />
                    ) : (
                        <div className="bar-chart-empty">暂无数据</div>
                    )}
                </div>
            )}

            {viewMode === 'line' && (
                <div className="line-chart-grid">
                    {lineChartItems.length > 0 ? (
                        lineChartItems.map((item) => (
                            <div key={item.block} className="line-chart-card">
                                <div className="line-chart-card-title">{item.block}</div>
                                <div className="line-chart-card-body">
                                    <Line data={item.data} options={lineChartOptions} />
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="bar-chart-empty">暂无数据</div>
                    )}
                </div>
            )}
                        </>
                    ),
                },
                {
                    key: 'history',
                    label: '历史资金',
                    children: (
                        <>
                            <div className="control-bar history-control-bar">
                                <div className="view-toggle">
                                    <Button
                                        type={historyViewMode === 'line' ? 'primary' : 'default'}
                                        icon={<LineChartOutlined />}
                                        onClick={() => setHistoryViewMode('line')}
                                        size="small"
                                    >
                                        折线图
                                    </Button>
                                    <Button
                                        type={historyViewMode === 'heatmap' ? 'primary' : 'default'}
                                        icon={<AppstoreOutlined />}
                                        onClick={() => setHistoryViewMode('heatmap')}
                                        size="small"
                                    >
                                        热力图
                                    </Button>
                                </div>
                            </div>
                            {filterBar}
                            {historyViewMode === 'line' && dayHistoryChartItems.length > 0 ? (
                                <>
                                    <div className="line-chart-grid">
                                        {dayHistoryChartItems.map((item) => (
                                            <div key={item.block} className="line-chart-card">
                                                <div className="line-chart-card-title">{item.block}</div>
                                                <div className="line-chart-card-body">
                                                    <Line data={item.data} options={dayHistoryChartOptions} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            ) : null}
                            {historyViewMode === 'line' && dayHistoryChartItems.length === 0 ? (
                                <Empty description="暂无按天维度历史数据，收盘后会自动记录" style={{ marginTop: 48 }} />
                            ) : null}
                            {historyViewMode === 'heatmap' ? (
                                <div className="history-heatmap-stage">
                                    <Tabs
                                        className="history-heatmap-tabs"
                                        activeKey={historyHeatmapTab}
                                        onChange={setHistoryHeatmapTab}
                                        items={[
                                            {
                                                key: 'today',
                                                label: '今日热力图',
                                                children: todayHistoryHeatmapItems.length > 0 ? (
                                                    renderHeatmapPanel({
                                                        title: '今日热力图',
                                                        items: todayHistoryHeatmapItems,
                                                        positiveText: '今日净流入增强',
                                                        neutralText: '矩形越大、颜色越深代表当日净额越强',
                                                        negativeText: '今日净流出增强',
                                                        valueKey: 'money',
                                                        valueFormatter: (item) => formatMoney(item.money),
                                                        secondaryFormatter: (item) => (item.money >= 0 ? '今日净流入' : '今日净流出'),
                                                    })
                                                ) : (
                                                    <Empty description="暂无当日热力图数据" style={{ marginTop: 24 }} />
                                                ),
                                            },
                                            {
                                                key: 'fiveDay',
                                                label: '近 5 日热力图',
                                                children: historyHeatmapItems.length > 0 ? (
                                                    renderHeatmapPanel({
                                                        title: '近 5 日累计资金净流入热力图',
                                                        items: historyHeatmapItems,
                                                        positiveText: '近 5 日累计流入增强',
                                                        neutralText: '矩形越大、颜色越深代表 5 日累计净额越强',
                                                        negativeText: '近 5 日累计流出增强',
                                                        valueKey: 'totalMoney',
                                                        valueFormatter: (item) => formatMoney(item.totalMoney),
                                                        secondaryFormatter: (item) => `最新日 ${formatMoney(item.latestMoney)}`,
                                                    })
                                                ) : (
                                                    <Empty description="暂无近 5 日热力图数据" style={{ marginTop: 24 }} />
                                                ),
                                            },
                                        ]}
                                    />
                                </div>
                            ) : null}
                        </>
                    ),
                },
                {
                    key: 'rzrq',
                    label: '融资余额',
                    children: (
                        <>
                            <div className="control-bar history-control-bar">
                                <div className="date-range-picker">
                                    <DatePicker.RangePicker
                                        value={dateRange}
                                        onChange={(dates) => setDateRange(dates)}
                                        format="YYYY-MM-DD"
                                        allowClear={false}
                                    />
                                </div>
                            </div>
                            {rzrqLoading ? (
                                <div className="rzrq-loading">加载中...</div>
                            ) : rzrqData.length > 0 ? (
                                <div className="rzrq-chart-container">
                                    <div className="rzrq-chart-card">
                                        <div className="rzrq-chart-header">
                                            <div className="rzrq-chart-title">融资余额</div>
                                            <div className="rzrq-chart-value">
                                                <span className="rzrq-value-label">最新值</span>
                                                <span className="rzrq-value-number" style={{ color: '#cf1322' }}>
                                                    {rzrqData[rzrqData.length - 1]?.rzBalance.toFixed(2)}
                                                </span>
                                                <span className="rzrq-value-unit">亿元</span>
                                            </div>
                                        </div>
                                        <div className="rzrq-chart-body">
                                            <div ref={rzBalanceContainerRef} className="rzrq-chart" />
                                        </div>
                                    </div>
                                    <div className="rzrq-chart-card">
                                        <div className="rzrq-chart-header">
                                            <div className="rzrq-chart-title">融资买入</div>
                                            <div className="rzrq-chart-value">
                                                <span className="rzrq-value-label">最新值</span>
                                                <span className="rzrq-value-number" style={{ color: getThemeColor() }}>
                                                    {rzrqData[rzrqData.length - 1]?.rzBuy.toFixed(2)}
                                                </span>
                                                <span className="rzrq-value-unit">亿元</span>
                                            </div>
                                        </div>
                                        <div className="rzrq-chart-body">
                                            <div ref={rzBuyContainerRef} className="rzrq-chart" />
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <Empty description="暂无融资余额数据，请选择时间范围" style={{ marginTop: 48 }} />
                            )}
                        </>
                    ),
                },
                {
                    key: 'crowd',
                    label: '拥挤度',
                    children: (
                        <>
                            <div className="control-bar history-control-bar">
                                <div className="crowd-info-bar">
                    {crowdData.length > 0 && (
                        <>
                            {/* <span className="crowd-info-label">最新拥挤度</span> */}
                            {/* <span
                                className="crowd-info-value"
                                style={{ color: '#722ed1' }}
                            >
                                {crowdData[crowdData.length - 1]?.score !== null && crowdData[crowdData.length - 1]?.score !== undefined 
                                    ? crowdData[crowdData.length - 1]?.score.toFixed(2) 
                                    : '-'}
                            </span> */}
                            {/* <span className="crowd-info-sub">
                                ({crowdData[crowdData.length - 1]?.level || '-'})
                            </span> */}
                        </>
                    )}
                </div>
                                <div className="date-range-picker">
                                    <DatePicker.RangePicker
                                        value={crowdDateRange}
                                        onChange={(dates) => dates && setCrowdDateRange(dates)}
                                        format="YYYY-MM-DD"
                                        allowClear={false}
                                        disabledDate={(current) => {
                                            if (!current) return false;
                                            const earliest = dayjs('2026-04-01').startOf('day');
                                            return current.isBefore(earliest) || current.isAfter(dayjs().endOf('day'));
                                        }}
                                    />
                                </div>
                            </div>
                            <div className="crowd-alerts-section">
                                <Alert
                                    message="拥挤度分析提醒"
                                    description={
                                        <div className="crowd-alerts-content">
                                            <p className="alert-item">
                                                <span className="alert-number">1</span>
                                                <span>拥挤度有滞后性，K线先出现下跌趋势，随后拥挤度才开始逐渐回落。所以K线的量价分析是逃顶的最先指标，拥挤度只能用来做趋势性分析，不能用来精准择时。</span>
                                            </p>
                                            <p className="alert-item">
                                                <span className="alert-number">2</span>
                                                <span>结合拥挤度和K线来看，拥挤度在大幅度下挫之后，往往会有一个大幅的反抽，形成一个双头结构（创业板的20260603、科创板的20260709），但是这并非反转，后面会继续下挫。真正的底部区间需要有长达一周左右的磨底（创业板的20260608-0615）。</span>
                                            </p>
                                        </div>
                                    }
                                    type="warning"
                                    showIcon
                                    className="crowd-alert"
                                />
                            </div>
                            {indexKlineData && (
                                <div className="crowd-index-section">
                                    <Divider orientation="left"><LineChartOutlined /> 指数行情回顾</Divider>
                                    <Row gutter={[16, 16]}>
                                        <Col span={12}>
                                            <Card title="创业板指" bordered={false} className="index-kline-card">
                                                <StockKLine data={indexKlineData.chuangyebanData} height={300} />
                                            </Card>
                                        </Col>
                                        <Col span={12}>
                                            <Card title="科创50" bordered={false} className="index-kline-card">
                                                <StockKLine data={indexKlineData.kechuangbanData} height={300} />
                                            </Card>
                                        </Col>
                                    </Row>
                                </div>
                            )}
                            {crowdLoading ? (
                                <div className="rzrq-loading">加载中...</div>
                            ) : crowdData.length > 0 ? (
                                <div className="crowd-chart-container">
                                    <div className="crowd-chart-card">
                                        <div className="crowd-chart-header">
                                            <div className="crowd-chart-title">拥挤度</div>
                                            <div className="crowd-chart-value">
                                                <span className="crowd-value-number" style={{ color: '#722ed1' }}>
                                                    {crowdData[crowdData.length - 2]?.score !== null && crowdData[crowdData.length - 2]?.score !== undefined 
                                                        ? crowdData[crowdData.length - 2]?.score.toFixed(2) 
                                                        : '-'}
                                                </span>
                                                <span className="crowd-value-unit">{crowdData[crowdData.length - 2]?.level || '-'}</span>
                                            </div>
                                        </div>
                                        <div className="crowd-chart-body">
                                            <div ref={crowdContainerRef} className="crowd-chart" />
                                        </div>
                                    </div>
                                    <div className="crowd-chart-card">
                                        <div className="crowd-chart-header">
                                            <div className="crowd-chart-title">科技板块成交量占比</div>
                                            <div className="crowd-chart-right">
                                                <div className="crowd-chart-value">
                                                    <span className="crowd-value-number" style={{ color: getThemeColor() }}>
                                                        {crowdData[crowdData.length - 1]?.ratio.toFixed(2)}%
                                                    </span>
                                                </div>
                                                <Button
                                                    type="primary"
                                                    size="small"
                                                    onClick={refreshCrowdData}
                                                    loading={isRefreshing}
                                                    icon={<SyncOutlined spin={isRefreshing} />}
                                                    className="crowd-refresh-btn"
                                                >
                                                    {/* 刷新当前最新数据 */}
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="crowd-chart-body">
                                            <div ref={ratioContainerRef} className="crowd-chart" />
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <Empty description="暂无拥挤度数据，请选择时间范围" style={{ marginTop: 48 }} />
                            )}
                        </>
                    ),
                },
                {
                    key: 'dayAmount',
                    label: '历史成交',
                    children: (
                        <>
                            <div className="control-bar history-control-bar">
                                <div className="view-toggle">
                                    <Button
                                        type={dayAmountViewMode === 'grid' ? 'primary' : 'default'}
                                        icon={<AppstoreOutlined />}
                                        onClick={() => setDayAmountViewMode('grid')}
                                        size="small"
                                    >
                                        网格视图
                                    </Button>
                                    <Button
                                        type={dayAmountViewMode === 'combined' ? 'primary' : 'default'}
                                        icon={<FundOutlined />}
                                        onClick={() => setDayAmountViewMode('combined')}
                                        size="small"
                                    >
                                        合并视图
                                    </Button>
                                    <Button
                                        type="primary"
                                        onClick={handleDayAmountDiagnosis}
                                        size="small"
                                    >
                                        自动诊断
                                    </Button>
                                    <Button
                                        type="primary"
                                        icon={<ReloadOutlined />}
                                        onClick={refreshDayAmountData}
                                        loading={dayAmountRefreshing}
                                        size="small"
                                    >
                                        刷新当日数据
                                    </Button>
                                </div>
                            </div>
                            <Card style={{ marginBottom: 16 }}>
                                <Space direction="vertical" style={{ width: '100%' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text strong>选择板块：</Text>
                                        <Space>
                                            <Button size="small" onClick={selectAllDayAmountBlocks}>
                                                全选
                                            </Button>
                                            <Button size="small" onClick={resetDayAmountToDefault}>
                                                恢复默认
                                            </Button>
                                        </Space>
                                    </div>
                                    <div className="custom-checkbox-group">
                                        {dayAmountAllBlocks.map((blockName) => {
                                            const isChecked = dayAmountSelectedBlocks.includes(blockName);
                                            const selectedIndex = dayAmountSelectedBlocks.indexOf(blockName);
                                            const color = isChecked ? BLOCK_COLORS[selectedIndex % BLOCK_COLORS.length] : undefined;
                                            return (
                                                <div
                                                    key={blockName}
                                                    className={`custom-checkbox-item ${isChecked ? 'checked' : ''}`}
                                                    onClick={() => {
                                                        if (isChecked) {
                                                            handleDayAmountBlockChange(dayAmountSelectedBlocks.filter((name) => name !== blockName));
                                                        } else {
                                                            handleDayAmountBlockChange([...dayAmountSelectedBlocks, blockName]);
                                                        }
                                                    }}
                                                    style={isChecked ? { '--custom-color': color } : {}}
                                                >
                                                    <div className="custom-checkbox-box">
                                                        {isChecked && <CheckOutlined className="custom-checkbox-check" />}
                                                    </div>
                                                    <span className="custom-checkbox-label">{blockName}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </Space>
                            </Card>
                            {dayAmountLoading ? (
                                <div className="loading-container"><Spin tip="加载中..." /></div>
                            ) : dayAmountData.length > 0 ? (
                                dayAmountViewMode === 'grid' ? (
                                    <Row gutter={[16, 16]}>
                                        {dayAmountSelectedBlocks.map((blockName, index) => (
                                            <Col xs={24} sm={12} md={12} lg={6} xl={6} key={blockName}>
                                                <Card
                                                    title={
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <span
                                                                style={{ color: BLOCK_COLORS[index % BLOCK_COLORS.length] }}
                                                                className="block-card-title"
                                                            >
                                                                {blockName}
                                                            </span>
                                                        </div>
                                                    }
                                                    size="small"
                                                >
                                                    <div id={`day-amount-chart-${blockName}`} className="small-chart-container" />
                                                </Card>
                                            </Col>
                                        ))}
                                    </Row>
                                ) : (
                                    <Card title="板块成交金额趋势对比">
                                        <div
                                            ref={dayAmountCombinedChartContainerRef}
                                            className="combined-chart-container"
                                        >
                                            <div
                                                ref={dayAmountTooltipRef}
                                                className="custom-tooltip"
                                                style={{ display: 'none' }}
                                            />
                                        </div>
                                        <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
                                            {dayAmountSelectedBlocks.map((blockName, index) => (
                                                <div key={blockName} style={{ display: 'flex', alignItems: 'center' }}>
                                                    <div
                                                        style={{
                                                            width: 12,
                                                            height: 12,
                                                            backgroundColor: BLOCK_COLORS[index % BLOCK_COLORS.length],
                                                            marginRight: 8,
                                                            borderRadius: 2
                                                        }}
                                                    />
                                                    <Text>{blockName}</Text>
                                                </div>
                                            ))}
                                        </div>
                                    </Card>
                                )
                            ) : (
                                <Alert message="暂无数据" type="info" showIcon />
                            )}
                        </>
                    ),
                },
            ]}
        />

            <Modal
                title={`${modalBlock || ''} - 资金净流入趋势`}
                open={!!modalBlock}
                onCancel={() => setModalBlock(null)}
                footer={null}
                width={900}
                destroyOnClose
            >
                <div style={{ height: 450 }}>
                    {blockLineChartData && (
                        <Line data={blockLineChartData} options={blockLineChartOptions} />
                    )}
                </div>
            </Modal>

            <Modal
                title="板块自动诊断"
                open={dayAmountDiagnosisModalVisible}
                onCancel={() => {
                    setDayAmountDiagnosisModalVisible(false);
                    setDayAmountDiagnosisResult(null);
                }}
                footer={null}
                width={1000}
            >
                {dayAmountDiagnosisLoading ? (
                    <div style={{ textAlign: 'center', padding: '50px 0' }}>
                        <Spin size="large" tip="正在诊断中..." />
                    </div>
                ) : dayAmountDiagnosisResult ? (
                    <Row gutter={[16, 16]}>
                        <Col xs={24} md={12}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Tag color="error" style={{ fontSize: '14px', padding: '4px 12px' }}>
                                            量价齐升
                                        </Tag>
                                        <span style={{ color: '#999', fontSize: '14px' }}>
                                            ({dayAmountDiagnosisResult.priceUpVolumeUp.length})
                                        </span>
                                    </div>
                                }
                                size="small"
                                style={{ height: '100%' }}
                            >
                                {dayAmountDiagnosisResult.priceUpVolumeUp.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                                        暂无数据
                                    </div>
                                ) : (
                                    dayAmountDiagnosisResult.priceUpVolumeUp.map((block) => (
                                        <div
                                            key={block.name}
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                padding: '8px 0',
                                                borderBottom: '1px solid #f0f0f0',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => handleDayAmountDiagnosisBlockClick(block.name)}
                                        >
                                            <span style={{ fontWeight: 500 }}>{block.name}</span>
                                            <Space size="middle">
                                                <span style={{ color: '#ff4d4f' }}>
                                                    涨 {block.change.toFixed(2)}%
                                                </span>
                                                <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                                                    量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                                                </span>
                                            </Space>
                                        </div>
                                    ))
                                )}
                            </Card>
                        </Col>

                        <Col xs={24} md={12}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Tag color="warning" style={{ fontSize: '14px', padding: '4px 12px' }}>
                                            放量下跌
                                        </Tag>
                                        <span style={{ color: '#999', fontSize: '14px' }}>
                                            ({dayAmountDiagnosisResult.priceDownVolumeUp.length})
                                        </span>
                                    </div>
                                }
                                size="small"
                                style={{ height: '100%' }}
                            >
                                {dayAmountDiagnosisResult.priceDownVolumeUp.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                                        暂无数据
                                    </div>
                                ) : (
                                    dayAmountDiagnosisResult.priceDownVolumeUp.map((block) => (
                                        <div
                                            key={block.name}
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                padding: '8px 0',
                                                borderBottom: '1px solid #f0f0f0',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => handleDayAmountDiagnosisBlockClick(block.name)}
                                        >
                                            <span style={{ fontWeight: 500 }}>{block.name}</span>
                                            <Space size="middle">
                                                <span style={{ color: '#52c41a' }}>
                                                    跌 {Math.abs(block.change).toFixed(2)}%
                                                </span>
                                                <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                                                    量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                                                </span>
                                            </Space>
                                        </div>
                                    ))
                                )}
                            </Card>
                        </Col>

                        <Col xs={24} md={12}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Tag color="success" style={{ fontSize: '14px', padding: '4px 12px' }}>
                                            缩量下跌
                                        </Tag>
                                        <span style={{ color: '#999', fontSize: '14px' }}>
                                            ({dayAmountDiagnosisResult.priceDownVolumeDown.length})
                                        </span>
                                    </div>
                                }
                                size="small"
                                style={{ height: '100%' }}
                            >
                                {dayAmountDiagnosisResult.priceDownVolumeDown.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                                        暂无数据
                                    </div>
                                ) : (
                                    dayAmountDiagnosisResult.priceDownVolumeDown.map((block) => (
                                        <div
                                            key={block.name}
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                padding: '8px 0',
                                                borderBottom: '1px solid #f0f0f0',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => handleDayAmountDiagnosisBlockClick(block.name)}
                                        >
                                            <span style={{ fontWeight: 500 }}>{block.name}</span>
                                            <Space size="middle">
                                                <span style={{ color: '#52c41a' }}>
                                                    跌 {Math.abs(block.change).toFixed(2)}%
                                                </span>
                                                <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                                                    量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                                                </span>
                                            </Space>
                                        </div>
                                    ))
                                )}
                            </Card>
                        </Col>

                        <Col xs={24} md={12}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Tag color="blue" style={{ fontSize: '14px', padding: '4px 12px' }}>
                                            缩量上涨
                                        </Tag>
                                        <span style={{ color: '#999', fontSize: '14px' }}>
                                            ({dayAmountDiagnosisResult.priceUpVolumeDown.length})
                                        </span>
                                    </div>
                                }
                                size="small"
                                style={{ height: '100%' }}
                            >
                                {dayAmountDiagnosisResult.priceUpVolumeDown.length === 0 ? (
                                    <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                                        暂无数据
                                    </div>
                                ) : (
                                    dayAmountDiagnosisResult.priceUpVolumeDown.map((block) => (
                                        <div
                                            key={block.name}
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                padding: '8px 0',
                                                borderBottom: '1px solid #f0f0f0',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => handleDayAmountDiagnosisBlockClick(block.name)}
                                        >
                                            <span style={{ fontWeight: 500 }}>{block.name}</span>
                                            <Space size="middle">
                                                <span style={{ color: '#ff4d4f' }}>
                                                    涨 {block.change.toFixed(2)}%
                                                </span>
                                                <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                                                    量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                                                </span>
                                            </Space>
                                        </div>
                                    ))
                                )}
                            </Card>
                        </Col>
                    </Row>
                ) : null}
            </Modal>
        </div>
    );
};

export default BlockMoneyChange;
