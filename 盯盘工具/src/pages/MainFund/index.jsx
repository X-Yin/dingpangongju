import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import { Tabs, Switch as AntSwitch, Select, Spin, Button, Modal, message, Checkbox, Input, Tag } from 'antd';
import { RobotOutlined, CopyOutlined, ThunderboltOutlined, LineChartOutlined, AppstoreOutlined, PlusOutlined, SearchOutlined, CloseOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { marked } from 'marked';
import { local_ip } from '../../constant';
import FloatingTechEmotion from '../../components/FloatingTechEmotion';
import BuyPointDiagnosisDrawer from '../../components/FloatingBuyPointDiagnosis';
import '../../components/FloatingBuyPointDiagnosis/index.scss';
import './index.scss';

marked.setOptions({ breaks: true, gfm: true });

const { Option } = Select;

const isAfterMarketClose = () => {
  const now = dayjs();
  const currentHour = now.hour();
  const currentMinute = now.minute();
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return true;
  }
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

const parseMoneyValue = (val) => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  let str = String(val);
  const sign = str.startsWith('-') ? -1 : 1;
  if (str.startsWith('+') || str.startsWith('-')) str = str.slice(1);
  let num = parseFloat(str.replace(/亿|万/g, '')) || 0;
  if (String(val).indexOf('万') !== -1) {
    num = num / 10000;
  }
  return sign * num;
};

const timeStrToMinutes = (timeStr) => {
  const h = parseInt(timeStr.substring(0, 2));
  const m = parseInt(timeStr.substring(2, 4));
  return h * 60 + m;
};

const minutesToTimeStr = (totalMin) => {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
};

const formatDisplayTime = (timeStr) => {
  if (timeStr.length >= 6) {
    return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
  }
  return timeStr;
};

const aggregateToInterval = (data, intervalMinutes) => {
  if (!data || data.length === 0) return [];
  const sortedData = [...data].sort((a, b) => {
    const ta = Array.isArray(a) ? a[0] : a.time;
    const tb = Array.isArray(b) ? b[0] : b.time;
    return ta.localeCompare(tb);
  });

  const buckets = {};
  const tradingSlots = [];
  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;

  // tradingSlots 为每个间隔窗的结束边界（标签）：例如 5min 时 9:35, 9:40, ... 15:00
  for (let t = morningStart + intervalMinutes; t <= morningEnd; t += intervalMinutes) tradingSlots.push(t);
  for (let t = afternoonStart + intervalMinutes; t <= afternoonEnd; t += intervalMinutes) tradingSlots.push(t);

  sortedData.forEach((item) => {
    const timeStr = Array.isArray(item) ? item[0] : (item.rawTime || item.time);
    const val = Array.isArray(item) ? item[1] : item;
    const totalMin = timeStrToMinutes(timeStr);
    let bucketMin = null;
    // 归属到「不小于该时间的下一个结束边界」对应的窗口：例如 9:35~9:39 计入标签 9:40
    for (const slot of tradingSlots) {
      if (totalMin < slot) {
        bucketMin = slot;
        break;
      }
    }
    if (bucketMin === null && tradingSlots.length > 0) {
      bucketMin = tradingSlots[tradingSlots.length - 1];
    }
    if (bucketMin !== null) {
      // 主力和成交量为累计值，取窗口内最新一条作为该窗口值；末值相对上一窗口的增量由展示端计算
      buckets[bucketMin] = {
        lastMain: Array.isArray(val) ? parseMoneyValue(val[1]?.mainMoney) : parseMoneyValue(val.mainMoney),
        lastAmount: Array.isArray(val) ? parseMoneyValue(val[1]?.amountChangeDiff) : parseMoneyValue(val.amountChangeDiff),
        rawTime: timeStr,
      };
    }
  });

  const result = [];
  tradingSlots.forEach((slot) => {
    const entry = buckets[slot];
    if (entry) {
      const bucketTimeStr = minutesToTimeStr(slot);
      result.push({
        time: bucketTimeStr,
        displayTime: formatDisplayTime(bucketTimeStr),
        mainMoney: entry.lastMain,
        amountChangeDiff: entry.lastAmount,
        rawTime: entry.rawTime,
      });
    }
  });
  return result;
};

const normalizeHistoryData = (fund5min, amount10min) => {
  const map = new Map();
  (fund5min || []).forEach(item => {
    map.set(item.time, {
      time: item.time,
      displayTime: formatDisplayTime(item.time),
      mainMoney: parseMoneyValue(item.mainMoney),
      amountChangeDiff: null,
    });
  });
  (amount10min || []).forEach(item => {
    const existing = map.get(item.time);
    if (existing) {
      existing.amountChangeDiff = parseMoneyValue(item.amountChangeDiff);
    } else {
      map.set(item.time, {
        time: item.time,
        displayTime: formatDisplayTime(item.time),
        mainMoney: null,
        amountChangeDiff: parseMoneyValue(item.amountChangeDiff),
      });
    }
  });
  const sorted = Array.from(map.values()).sort((a, b) => a.time.localeCompare(b.time));
  let lastFund = 0;
  let lastAmount = 0;
  sorted.forEach(item => {
    if (item.mainMoney !== null && item.mainMoney !== undefined) {
      lastFund = item.mainMoney;
    } else {
      item.mainMoney = lastFund;
    }
    if (item.amountChangeDiff !== null && item.amountChangeDiff !== undefined) {
      lastAmount = item.amountChangeDiff;
    } else {
      item.amountChangeDiff = lastAmount;
    }
  });
  return sorted;
};


// 板块资金折线图颜色数组
const BLOCK_LINE_COLORS = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d',
  '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16',
  '#a0d911', '#2f54eb',
];

// 板块资金默认选中板块
const DEFAULT_SELECTED_BLOCKS = [
  'PCB', '半导体概念', '光通信模块', '创新药', '银行Ⅱ', '存储芯片',
  '液冷服务器', '黄金概念'
];

// 热力图最小面积占比（百分比）
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
const allocateAreas = (values, minPercent) => {
  const n = values.length;
  if (n === 0) return [];
  const effectiveMin = Math.min(minPercent, 100 / n);
  const absValues = values.map(v => Math.abs(v));
  const total = absValues.reduce((a, b) => a + b, 0);
  const totalArea = 100;
  if (total <= 0) {
    return new Array(n).fill(totalArea / n);
  }
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

// Squarified treemap 算法
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
  const containerArea = startW * startH;
  const scaleFactor = containerArea / totalItemArea;
  const scaled = sorted.map(it => ({ ...it, area: it.area * scaleFactor }));
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
      const stripWidth = h > 0 ? rowArea / h : 0;
      let cy = y;
      for (const it of rowItems) {
        const itemH = stripWidth > 0 ? it.area / stripWidth : 0;
        results.push({ index: it.index, x, y: cy, w: stripWidth, h: itemH });
        cy += itemH;
      }
      process(rest, x + stripWidth, y, w - stripWidth, h);
    } else {
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

// 给定一组数值，计算 treemap 布局
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

// 构建热力图数据项
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

export const MainFundContent = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // 明细数据固定为只看变化，5min 级别可勾选（默认开启）
  const [fiveMinAggEnabled, setFiveMinAggEnabled] = useState(true);
  // 自动买点诊断：命中后弹窗展示条件卡片，仅当前浏览器 tab 激活时弹出
  const [buyPointModalOpen, setBuyPointModalOpen] = useState(false);
  const [buyPointResult, setBuyPointResult] = useState(null);
  const lastAutoBuyPointOpenRef = useRef(0);
  // 手动买点诊断抽屉：点击控制栏「买点诊断」按钮打开，展示各条件是否符合
  const [buyPointDrawerOpen, setBuyPointDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('today');
  const [availableDates, setAvailableDates] = useState([]);
  const [historyDate, setHistoryDate] = useState(null);
  const [historyData, setHistoryData] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryResult, setAiSummaryResult] = useState(null);
  const [aiSummaryModalOpen, setAiSummaryModalOpen] = useState(false);
  const [aiContextLoading, setAiContextLoading] = useState(false);
  // 板块资金 tab 相关状态
  const [blockTimeSeriesData, setBlockTimeSeriesData] = useState([]);
  const [blockLoading, setBlockLoading] = useState(true);
  const [blockTab, setBlockTab] = useState('line');
  const [selectedBlocks, setSelectedBlocks] = useState(DEFAULT_SELECTED_BLOCKS);
  const [blockDetailSelected, setBlockDetailSelected] = useState(null);
  const [blockRightAxisLabels, setBlockRightAxisLabels] = useState([]);
  const [blockFiveMinAgg, setBlockFiveMinAgg] = useState(false);
  // 板块折线图 hover 高亮 + 批量添加面板相关状态
  const [blockHoveredBlock, setBlockHoveredBlock] = useState(null);
  const blockHoveredBlockRef = useRef(null);
  const [showBlockBatchPanel, setShowBlockBatchPanel] = useState(false);
  const [blockPanelSearch, setBlockPanelSearch] = useState('');
  const [selectedNewBlocks, setSelectedNewBlocks] = useState([]);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const volumeChartContainerRef = useRef(null);
  const volumeChartRef = useRef(null);
  const historyChartContainerRef = useRef(null);
  const historyChartRef = useRef(null);
  const historyVolumeChartContainerRef = useRef(null);
  const historyVolumeChartRef = useRef(null);
  // 板块资金图表相关 refs
  const blockChartContainerRef = useRef(null);
  const blockChartRef = useRef(null);
  const blockTooltipRef = useRef(null);
  const blockSeriesRef = useRef([]);
  const blockInfoListRef = useRef([]);
  const blockLastValuesRef = useRef([]);
  const blockDummySeriesRef = useRef(null);
  const blockTimeRangeRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_history`);
      const newData = response.data || [];
      setData(newData);
      setError(null);
    } catch (err) {
      console.error('Fetch main fund data failed:', err);
      setError('获取主力资金数据失败，请检查后端服务是否正常运行');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAvailableDates = useCallback(async () => {
    try {
      const resp = await axios.get(`http://${local_ip}:3000/fund_snapshot/dates`);
      if (resp.data?.success) {
        const dates = resp.data.data || [];
        setAvailableDates(dates);
        if (dates.length > 0 && !historyDate) {
          setHistoryDate(dates[0]);
        }
      }
    } catch (err) {
      console.error('获取快照日期列表失败:', err);
    }
  }, [historyDate]);

  const fetchHistoryData = useCallback(async (date) => {
    if (!date) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const resp = await axios.get(`http://${local_ip}:3000/fund_snapshot/data?date=${date}`);
      if (resp.data?.success) {
        setHistoryData(resp.data.data);
      } else {
        setHistoryError(resp.data?.message || '获取历史数据失败');
        setHistoryData(null);
      }
    } catch (err) {
      console.error('获取历史快照数据失败:', err);
      setHistoryError('获取历史数据失败，请检查后端服务');
      setHistoryData(null);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchAvailableDates();
    }
  }, [activeTab, fetchAvailableDates]);

  useEffect(() => {
    if (activeTab === 'history' && historyDate) {
      fetchHistoryData(historyDate);
    }
  }, [activeTab, historyDate, fetchHistoryData]);

  // 获取板块资金分时数据
  const fetchBlockTimeData = useCallback(async () => {
    try {
      const resp = await axios.get(`http://${local_ip}:3000/get_block_money_change_time`);
      const newData = resp.data || [];
      setBlockTimeSeriesData(newData.filter(i => Number(i.time) > 93000));
    } catch (err) {
      console.error('获取板块资金分时数据失败:', err);
    } finally {
      setBlockLoading(false);
    }
  }, []);

  // 板块资金分时数据轮询：每 30 秒拉取一次，仅在交易时段内；today tab 也需要叠加板块数据
  useEffect(() => {
    if (activeTab !== 'block' && activeTab !== 'today') return;
    fetchBlockTimeData();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
      return timer;
    };
    if (!isAfterMarketClose()) {
      schedulePoll(fetchBlockTimeData, 30000);
    }
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [activeTab, fetchBlockTimeData]);

  useEffect(() => {
    fetchData();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
      return timer;
    };
    if (!isAfterMarketClose()) {
      schedulePoll(fetchData, 3000);
    }
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchData]);

  // 自动买点诊断：与 FloatingStockPosition 保持一致，交易日交易时段每 10 秒运行一次
  // 命中后弹窗（频控 5 分钟），且仅当前浏览器 tab 激活（可见）时才弹出
  const autoRunBuyPointDiagnosis = useCallback(async () => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: 1 });
      const result = res.data?.data;
      // 触发条件：其它前置检查全部通过（allPassed，与逻辑）
      //          或尾盘抄底命中（tailDipBuyingHit，或逻辑分支，14:30-15:00 内任一时刻满足即可）
      if (result?.allPassed === true || result?.tailDipBuyingHit === true) {
        const now = Date.now();
        if (now - lastAutoBuyPointOpenRef.current >= 5 * 60 * 1000) {
          // 只有当前浏览器 tab 页被激活（可见）时才能弹出
          if (document.visibilityState === 'visible' && !document.hidden) {
            lastAutoBuyPointOpenRef.current = now;
            setBuyPointResult(result);
            setBuyPointModalOpen(true);
          }
        }
      }
    } catch (error) {
      console.error('自动买点诊断失败:', error);
    }
  }, []);

  useEffect(() => {
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
      return timer;
    };
    schedulePoll(autoRunBuyPointDiagnosis, 10 * 1000);
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [autoRunBuyPointDiagnosis]);

  const renderChartToContainers = useCallback((chartData, mainContainer, volContainer, mainChartRef, volChartRef) => {
    // chart 已存在且容器有效时，只更新 series 数据，避免轮询重建 chart 导致闪烁
    if (mainChartRef.current && mainContainer && mainContainer.querySelector('.tv-lightweight-charts')) {
      const chart = mainChartRef.current;
      const mainSeries = chart._mainSeries;
      const volChart = volChartRef.current;
      const volSeries = volChart ? volChart._volSeries : null;

      const sortedData = chartData && chartData.length > 0
        ? [...chartData].sort((a, b) => {
            const ta = a.rawTime || a.time;
            const tb = b.rawTime || b.time;
            return ta.localeCompare(tb);
          })
        : [];

      const today = dayjs().format('YYYY-MM-DD');

      // 更新主力资金数据
      if (mainSeries) {
        const cData = sortedData.map((item) => {
          const timeStr = item.rawTime || item.time;
          const hh = timeStr.substring(0, 2);
          const mm = timeStr.substring(2, 4);
          const ss = timeStr.substring(4, 6);
          const v = parseMoneyValue(item.mainMoney);
          return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: v };
        });
        mainSeries.setData(cData);
      }

      // 更新成交量数据
      if (volSeries) {
        const vData = sortedData.map((item) => {
          const timeStr = item.rawTime || item.time;
          const hh = timeStr.substring(0, 2);
          const mm = timeStr.substring(2, 4);
          const ss = timeStr.substring(4, 6);
          const v = parseMoneyValue(item.amountChangeDiff);
          return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: v };
        });
        volSeries.setData(vData);
      }

      // 数据更新后重新 fitContent，确保时间轴始终包含全天范围（dummy series 已覆盖 9:30-15:00）
      chart.timeScale().fitContent();
      if (volChart) volChart.timeScale().fitContent();

      return;
    }

    // 以下为创建新 chart 的逻辑
    try {
      if (mainChartRef.current) {
        mainChartRef.current.remove();
      }
    } catch (e) {
      console.error('remove main chart failed:', e);
    }
    mainChartRef.current = null;
    try {
      if (volChartRef.current) {
        volChartRef.current.remove();
      }
    } catch (e) {
      console.error('remove volume chart failed:', e);
    }
    volChartRef.current = null;

    if (!mainContainer) return;

    // 显式清空容器内残留的 lightweight-charts DOM，避免 createChart 在旧 DOM 旁创建新实例
    if (mainContainer) mainContainer.innerHTML = '';
    if (volContainer) volContainer.innerHTML = '';

    const sortedData = chartData && chartData.length > 0
      ? [...chartData].sort((a, b) => {
          const ta = a.rawTime || a.time;
          const tb = b.rawTime || b.time;
          return ta.localeCompare(tb);
        })
      : [];

    const today = dayjs().format('YYYY-MM-DD');
    
    const chart = createChart(mainContainer, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6b7890',
        fontSize: 11,
      },
      width: mainContainer.clientWidth,
      height: mainContainer.clientHeight,
      grid: {
        vertLines: { color: 'rgba(18, 33, 58, 0.05)' },
        horzLines: { color: 'rgba(18, 33, 58, 0.05)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(18, 33, 58, 0.08)',
        tickMarkFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(18, 33, 58, 0.08)',
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      handleScroll: false,
      handleScale: false,
    });
    mainChartRef.current = chart;

    // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
    const dummySeries = chart.addLineSeries({
      color: 'transparent',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // 生成全天的时间点 (09:30-11:30, 13:00-15:00)
    const allTimePoints = [];
    
    // 上午 09:30 - 11:30
    let curr = dayjs(`${today} 09:30`);
    const amEnd = dayjs(`${today} 11:30`);
    while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }
    
    // 下午 13:00 - 15:00
    curr = dayjs(`${today} 13:00`);
    const pmEnd = dayjs(`${today} 15:00`);
    while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    // 填充隐藏系列，确保 X 轴拥有全天所有的"坑位"
    dummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));

    const series = chart.addAreaSeries({
      lineColor: '#7c3aed',
      topColor: 'rgba(124, 58, 237, 0.35)',
      bottomColor: 'rgba(124, 58, 237, 0.02)',
      lineWidth: 2.5,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const cData = sortedData.map((item) => {
      const timeStr = item.rawTime || item.time;
      const hh = timeStr.substring(0, 2);
      const mm = timeStr.substring(2, 4);
      const ss = timeStr.substring(4, 6);
      const v = parseMoneyValue(item.mainMoney);
      return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: v };
    });
    series.setData(cData);
    series.createPriceLine({ price: -100, color: 'red', lineStyle: LineStyle.Dashed });
    chart._mainSeries = series;

    // dummy series 始终包含全天时间点（09:30-15:00），始终 fitContent 以确保时间轴从 9:30 开始
    chart.timeScale().fitContent();

    if (volContainer) {
      const volumeChart = createChart(volContainer, {
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: '#6b7890',
          fontSize: 11,
        },
        width: volContainer.clientWidth,
        height: volContainer.clientHeight,
        grid: {
          vertLines: { color: 'rgba(18, 33, 58, 0.05)' },
          horzLines: { color: 'rgba(18, 33, 58, 0.05)' },
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: false,
          borderColor: 'rgba(18, 33, 58, 0.08)',
          tickMarkFormatter: (time) => {
            return dayjs.unix(time).format('HH:mm');
          },
        },
        localization: {
          timeFormatter: (time) => {
            return dayjs.unix(time).format('HH:mm');
          },
        },
        rightPriceScale: {
          borderColor: 'rgba(18, 33, 58, 0.08)',
          autoScale: true,
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        handleScroll: false,
        handleScale: false,
      });
      volChartRef.current = volumeChart;

      // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
      const volDummySeries = volumeChart.addLineSeries({
        color: 'transparent',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      // 填充隐藏系列，确保 X 轴拥有全天所有的"坑位"
      volDummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));

      const volumeSeries = volumeChart.addAreaSeries({
        lineColor: '#1890ff',
        topColor: 'rgba(24, 144, 255, 0.35)',
        bottomColor: 'rgba(24, 144, 255, 0.02)',
        lineWidth: 2.5,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });

      const vData = sortedData.map((item) => {
        const timeStr = item.rawTime || item.time;
        const hh = timeStr.substring(0, 2);
        const mm = timeStr.substring(2, 4);
        const ss = timeStr.substring(4, 6);
        const v = parseMoneyValue(item.amountChangeDiff);
        return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: v };
      });
      volumeSeries.setData(vData);
      volumeChart._volSeries = volumeSeries;

      // dummy series 始终包含全天时间点，始终 fitContent
      volumeChart.timeScale().fitContent();
    }
  }, []);

  const todayChartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return aggregateToInterval(data, 5);
  }, [data]);

  // 表格数据：勾选 5min 级别时按 5 分钟桶聚合，否则展示 1min 原始数据
  const todayTableData = useMemo(() => {
    if (!data || data.length === 0) return [];
    if (fiveMinAggEnabled) return aggregateToInterval(data, 5);
    return (data || []).map(item => {
      const timeStr = Array.isArray(item) ? item[0] : (item.rawTime || item.time);
      const val = Array.isArray(item) ? item[1] : item;
      return {
        time: timeStr,
        displayTime: formatDisplayTime(timeStr),
        mainMoney: parseMoneyValue(val?.mainMoney),
        amountChangeDiff: parseMoneyValue(val?.amountChangeDiff),
        rawTime: timeStr,
      };
    });
  }, [data, fiveMinAggEnabled]);

  const historyChartData = useMemo(() => {
    if (!historyData) return [];
    return normalizeHistoryData(historyData.fund5min, historyData.amount10min);
  }, [historyData]);

  // 用 ref 持有最新数据，避免轮询数据变化时取消 chart 创建的 rAF
  const todayChartDataRef = useRef(todayChartData);
  todayChartDataRef.current = todayChartData;

  // chart 创建/重建：仅依赖 activeTab，不依赖轮询数据
  useEffect(() => {
    if (activeTab !== 'today') return;
    if (!chartContainerRef.current) return;
    const rafId = requestAnimationFrame(() => {
      if (!chartContainerRef.current) return;
      try {
        renderChartToContainers(
          todayChartDataRef.current,
          chartContainerRef.current,
          volumeChartContainerRef.current,
          chartRef,
          volumeChartRef
        );
      } catch (e) {
        console.error('[MainFund] chart creation error:', e);
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [activeTab, renderChartToContainers]);

  // 数据更新（轮询）：chart 已存在时只更新 series 数据，不会取消上面的创建 rAF
  useEffect(() => {
    if (activeTab !== 'today') return;
    if (!chartRef.current || !chartContainerRef.current) return;
    renderChartToContainers(
      todayChartData,
      chartContainerRef.current,
      volumeChartContainerRef.current,
      chartRef,
      volumeChartRef
    );
  }, [todayChartData, activeTab, renderChartToContainers]);

  useEffect(() => {
    if (activeTab !== 'history') return;
    if (!historyChartContainerRef.current) return;
    const rafId = requestAnimationFrame(() => {
      if (!historyChartContainerRef.current) return;
      renderChartToContainers(historyChartData, historyChartContainerRef.current, historyVolumeChartContainerRef.current, historyChartRef, historyVolumeChartRef);
    });
    return () => cancelAnimationFrame(rafId);
  }, [historyChartData, activeTab, renderChartToContainers]);

  // 从最新一帧数据提取全部板块列表
  const allBlocks = useMemo(() => {
    if (!blockTimeSeriesData.length) return [];
    const latestFrame = blockTimeSeriesData[blockTimeSeriesData.length - 1];
    return (latestFrame.data || []).map(item => item.block);
  }, [blockTimeSeriesData]);

  // 板块折线图 tag 展示信息：板块名 + 颜色 + 最新一帧资金净流入(亿)
  const blockTagInfoList = useMemo(() => {
    if (!blockTimeSeriesData.length) return selectedBlocks.map((name, idx) => ({ name, color: BLOCK_LINE_COLORS[idx % BLOCK_LINE_COLORS.length], money: 0 }));
    const latestFrame = blockTimeSeriesData[blockTimeSeriesData.length - 1];
    return selectedBlocks.map((blockName, idx) => {
      const color = BLOCK_LINE_COLORS[idx % BLOCK_LINE_COLORS.length];
      const blockItem = latestFrame.data?.find(item => item.block === blockName);
      const money = blockItem ? blockItem.money / 100000000 : 0;
      return { name: blockName, color, money };
    });
  }, [blockTimeSeriesData, selectedBlocks]);

  // allBlocks 变化时同步 selectedBlocks 和 blockDetailSelected
  useEffect(() => {
    if (!allBlocks.length) return;
    setSelectedBlocks(prev => {
      const validPrev = prev.filter(block => allBlocks.includes(block));
      if (validPrev.length > 0) return validPrev;
      const preferred = DEFAULT_SELECTED_BLOCKS.filter(block => allBlocks.includes(block));
      return preferred.length > 0 ? preferred : allBlocks.slice(0, Math.min(BLOCK_LINE_COLORS.length, allBlocks.length));
    });
    setBlockDetailSelected(prev => {
      if (prev && allBlocks.includes(prev)) return prev;
      // return allBlocks[0];
      return 'PCB'
    });
  }, [allBlocks]);

  // 热力图数据：取最新一帧并按选中板块过滤，与折线图共用同一份选中状态
  const blockHeatmapItems = useMemo(() => {
    if (!blockTimeSeriesData.length) return [];
    const latestFrame = blockTimeSeriesData[blockTimeSeriesData.length - 1];
    const filtered = (latestFrame.data || []).filter(item => selectedBlocks.includes(item.block));
    return buildHeatmapItems(filtered, 'money');
  }, [blockTimeSeriesData, selectedBlocks]);

  // 右侧明细数据：选中板块在各时间点的资金净流入（按时间倒序）
  const blockDetailData = useMemo(() => {
    if (!blockTimeSeriesData.length || !blockDetailSelected) return [];
    const result = [];
    blockTimeSeriesData.forEach(frame => {
      const blockItem = frame.data?.find(item => item.block === blockDetailSelected);
      if (blockItem) {
        result.push({
          time: frame.time,
          displayTime: formatDisplayTime(frame.time),
          money: blockItem.money / 100000000,
        });
      }
    });
    return result.sort((a, b) => b.time.localeCompare(a.time));
  }, [blockTimeSeriesData, blockDetailSelected]);

  // 明细展示数据：开启 5min 聚合时按 5 分钟桶聚合（取每桶最新一条），否则原样返回
  const blockDetailDisplayData = useMemo(() => {
    if (!blockDetailData.length || !blockFiveMinAgg) return blockDetailData;
    // 先按时间升序便于分桶
    const asc = [...blockDetailData].sort((a, b) => a.time.localeCompare(b.time));
    const morningStart = 9 * 60 + 30, morningEnd = 11 * 60 + 30;
    const afternoonStart = 13 * 60, afternoonEnd = 15 * 60;
    const slots = [];
    for (let t = morningStart; t <= morningEnd; t += 5) slots.push(t);
    for (let t = afternoonStart; t <= afternoonEnd; t += 5) slots.push(t);

    const buckets = {};
    asc.forEach(item => {
      const hh = parseInt(item.time.substring(0, 2));
      const mm = parseInt(item.time.substring(2, 4));
      const totalMin = hh * 60 + mm;
      let bucket = null;
      for (const slot of slots) {
        if (totalMin <= slot + 2) { bucket = slot; break; }
      }
      if (bucket === null && totalMin > slots[slots.length - 1]) bucket = slots[slots.length - 1];
      if (bucket !== null) buckets[bucket] = item; // 后来的覆盖先来的（取桶内最新）
    });

    const result = [];
    slots.forEach(slot => {
      if (buckets[slot]) {
        const h = Math.floor(slot / 60), m = slot % 60;
        const timeStr = `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
        result.push({
          time: timeStr,
          displayTime: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`,
          money: buckets[slot].money,
        });
      }
    });
    return result.reverse(); // 按时间倒序，最新的在最上面
  }, [blockDetailData, blockFiveMinAgg]);

  // 折线图数据帧：11:30 前按原有序列展示，11:30 后（午后）按 5min 维度聚合
  const blockChartFrames = useMemo(() => {
    if (!blockTimeSeriesData.length) return [];
    const morning = [];
    const afternoon = [];
    blockTimeSeriesData.forEach(frame => {
      if (frame.time < '113000') {
        morning.push(frame);
      } else {
        afternoon.push(frame);
      }
    });

    // 午后按 5min 桶聚合，取每桶最新一帧的数据
    const slots = [];
    for (let t = 13 * 60; t <= 15 * 60; t += 5) slots.push(t);
    const buckets = {};
    afternoon.forEach(frame => {
      const hh = parseInt(frame.time.substring(0, 2));
      const mm = parseInt(frame.time.substring(2, 4));
      const totalMin = hh * 60 + mm;
      let bucket = null;
      for (const slot of slots) {
        if (totalMin <= slot + 2) { bucket = slot; break; }
      }
      if (bucket === null && totalMin > slots[slots.length - 1]) bucket = slots[slots.length - 1];
      if (bucket !== null) {
        const h = Math.floor(bucket / 60), m = bucket % 60;
        buckets[bucket] = {
          time: `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`,
          data: frame.data,
        };
      }
    });
    const aggregatedAfternoon = slots
      .filter(slot => buckets[slot])
      .map(slot => buckets[slot]);

    return [...morning, ...aggregatedAfternoon];
  }, [blockTimeSeriesData]);


  const formatBlockMoney = (money) => {
    const yi = money / 100000000;
    const sign = money > 0 ? '+' : '';
    return `${sign}${yi.toFixed(1)}亿`;
  };

  const formatBlockLegendYi = (money) => {
    const yi = money / 100000000;
    if (Math.abs(yi) >= 10) return yi.toFixed(0);
    return yi.toFixed(1);
  };

  const handleBlockCircleClick = (url) => {
    if (url) window.open(url, '_blank');
  };

  // 移除某个已选板块
  const handleRemoveBlock = (blockName) => {
    setSelectedBlocks(prev => prev.filter(b => b !== blockName));
  };

  // 确认批量添加板块：受 BLOCK_LINE_COLORS 数量限制
  const handleConfirmBlockBatchAdd = () => {
    const remaining = BLOCK_LINE_COLORS.length - selectedBlocks.length;
    const newBlocks = allBlocks.filter(b => selectedNewBlocks.includes(b) && !selectedBlocks.includes(b));
    const toAdd = newBlocks.slice(0, Math.max(0, remaining));
    if (newBlocks.length > toAdd.length) message.warning(`最多选择 ${BLOCK_LINE_COLORS.length} 个板块`);
    if (toAdd.length > 0) setSelectedBlocks(prev => [...prev, ...toAdd]);
    setSelectedNewBlocks([]);
    setShowBlockBatchPanel(false);
  };

  // 批量添加面板按搜索词过滤后的板块列表
  const filteredPanelBlocks = blockPanelSearch
    ? allBlocks.filter(b => b.toLowerCase().includes(blockPanelSearch.toLowerCase()))
    : allBlocks;

  // 计算板块折线图右侧轴标签位置
  const updateBlockRightAxisLabels = useCallback(() => {
    if (!blockChartRef.current || !blockChartContainerRef.current) return;
    const containerHeight = blockChartContainerRef.current.clientHeight;
    const infoList = blockInfoListRef.current;
    const lastValues = blockLastValuesRef.current;

    const labels = [];
    blockSeriesRef.current.forEach((series, idx) => {
      const info = infoList[idx];
      const lastValue = lastValues[idx];
      if (!info || lastValue == null) return;
      const y = series.priceToCoordinate(lastValue);
      if (y == null) return;
      labels.push({
        key: info.name,
        name: info.name,
        color: info.color,
        value: lastValue,
        valueStr: `${lastValue > 0 ? '+' : ''}${lastValue.toFixed(2)}亿`,
        valueClass: lastValue > 0 ? 'up' : lastValue < 0 ? 'down' : 'neutral',
        y,
      });
    });

    labels.sort((a, b) => a.y - b.y);
    const minGap = 18;
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < minGap) {
        labels[i].y = labels[i - 1].y + minGap;
      }
    }
    labels.forEach(label => {
      label.y = Math.max(10, Math.min(containerHeight - 10, label.y));
    });
    setBlockRightAxisLabels(labels);
  }, []);

  // 悬浮 tag 时只展示该板块折线，其他折线全部隐藏，坐标轴自动适配到该板块取值范围
  const applyBlockHoverHighlight = useCallback((blockName) => {
    blockSeriesRef.current.forEach((series, idx) => {
      const info = blockInfoListRef.current[idx];
      if (!info) return;
      if (blockName && info.name === blockName) {
        series.applyOptions({ visible: true, color: info.color, lineWidth: 3, lineStyle: LineStyle.Solid });
      } else if (blockName) {
        series.applyOptions({ visible: false });
      } else {
        series.applyOptions({ visible: true, color: info.color, lineWidth: 2, lineStyle: LineStyle.Solid });
      }
    });
    // dummy series 在独立不可见价格刻度上，保持可见以维持全天时间轴范围
    // 等待坐标轴自动调整后重新计算右侧标签位置
    requestAnimationFrame(() => updateBlockRightAxisLabels());
  }, [updateBlockRightAxisLabels]);

  // tag 悬浮进入：只展示该板块折线，右侧明细同步切换到该板块
  const handleBlockTagEnter = (e) => {
    const blockName = e.currentTarget.getAttribute('data-block-name');
    if (!blockName) return;
    blockHoveredBlockRef.current = blockName;
    setBlockHoveredBlock(blockName);
    applyBlockHoverHighlight(blockName);
    // 右侧明细同步切换到 hover 的板块（移开后不恢复）
    setBlockDetailSelected(blockName);
  };

  // tag 悬浮离开：恢复所有折线显示，右侧明细保持 hover 时选中的板块
  const handleBlockTagLeave = () => {
    blockHoveredBlockRef.current = null;
    setBlockHoveredBlock(null);
    applyBlockHoverHighlight(null);
  };

  // 渲染板块资金叠加折线图
  const renderBlockOverlayChart = useCallback(() => {
    if (!blockChartContainerRef.current) return;
    if (blockChartRef.current) {
      blockChartRef.current.remove();
      blockChartRef.current = null;
    }
    blockSeriesRef.current = [];
    setBlockRightAxisLabels([]);

    const container = blockChartContainerRef.current;
    const today = dayjs().format('YYYY-MM-DD');

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6b7890',
        fontSize: 11,
      },
      width: container.clientWidth,
      height: container.clientHeight,
      grid: {
        vertLines: { color: 'rgba(18, 33, 58, 0.05)' },
        horzLines: { color: 'rgba(18, 33, 58, 0.05)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(18, 33, 58, 0.08)',
        tickMarkFormatter: (time) => dayjs.unix(time).format('HH:mm'),
      },
      localization: {
        timeFormatter: (time) => dayjs.unix(time).format('HH:mm'),
      },
      rightPriceScale: {
        borderColor: 'rgba(18, 33, 58, 0.08)',
        autoScale: true,
        minimumWidth: 130,
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
    blockChartRef.current = chart;

    // 添加隐藏的辅助系列锁定 09:30-15:00 全天时间轴范围
    // 放到独立不可见价格刻度上，不参与右侧 Y 轴自适应缩放（避免 0 值压缩范围）
    const dummySeries = chart.addLineSeries({
      color: 'transparent',
      priceScaleId: 'dummy',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale('dummy').applyOptions({ visible: false });
    const allTimePoints = [];
    let curr = dayjs(`${today} 09:30`);
    const amEnd = dayjs(`${today} 11:30`);
    while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }
    curr = dayjs(`${today} 13:00`);
    const pmEnd = dayjs(`${today} 15:00`);
    while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }
    dummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));
    blockDummySeriesRef.current = dummySeries;

    // 为每个选中板块添加折线
    const infoList = [];
    const lastValues = [];
    selectedBlocks.forEach((blockName, idx) => {
      if (idx >= BLOCK_LINE_COLORS.length) return;
      const color = BLOCK_LINE_COLORS[idx];
      const lineData = [];
      blockChartFrames.forEach(frame => {
        const blockItem = frame.data?.find(item => item.block === blockName);
        if (blockItem) {
          const hh = frame.time.substring(0, 2);
          const mm = frame.time.substring(2, 4);
          const ss = frame.time.substring(4, 6);
          const yi = blockItem.money / 100000000;
          lineData.push({ time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: yi });
        }
      });
      if (lineData.length === 0) return;
      lineData.sort((a, b) => a.time - b.time);
      // 去重相邻重复时间戳
      const deduplicated = [];
      for (let i = 0; i < lineData.length; i++) {
        if (i === 0 || lineData[i].time !== lineData[i - 1].time) {
          deduplicated.push(lineData[i]);
        } else {
          deduplicated[deduplicated.length - 1] = lineData[i];
        }
      }
      const series = chart.addLineSeries({
        color,
        lineWidth: 2,
        priceFormat: {
          type: 'custom',
          formatter: (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}亿`,
        },
        lastValueVisible: false,
      });
      series.setData(deduplicated);
      blockSeriesRef.current.push(series);
      infoList.push({ name: blockName, color });
      lastValues.push(deduplicated.length > 0 ? deduplicated[deduplicated.length - 1].value : null);
    });

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
      rightOffset: 0,
    });

    // 缓存全天时间范围，悬浮时隐藏其他系列后用于显式锁定
    blockTimeRangeRef.current = chart.timeScale().getVisibleRange();

    blockInfoListRef.current = infoList;
    blockLastValuesRef.current = lastValues;
    requestAnimationFrame(() => updateBlockRightAxisLabels());

    // 图表重建后恢复悬浮高亮状态
    if (blockHoveredBlockRef.current) {
      applyBlockHoverHighlight(blockHoveredBlockRef.current);
    }

    // tooltip 悬浮显示
    const tooltip = blockTooltipRef.current;
    const TOOLTIP_MARGIN = 15;
    chart.subscribeCrosshairMove(param => {
      if (
        !param.point || !param.time ||
        param.point.x < 0 || param.point.x > container.clientWidth ||
        param.point.y < 0 || param.point.y > container.clientHeight
      ) {
        tooltip.style.display = 'none';
      } else {
        tooltip.style.display = 'block';
        const seriesData = [];
        blockSeriesRef.current.forEach((series, idx) => {
          const data = param.seriesData.get(series);
          if (data) {
            const info = blockInfoListRef.current[idx];
            seriesData.push({ name: info.name, value: data.value, color: info.color });
          }
        });
        const timeStr = typeof param.time === 'number' ? dayjs.unix(param.time).format('HH:mm:ss') : param.time;
        let content = `<div class="block-tooltip-header">${timeStr}</div>`;
        seriesData.forEach(item => {
          const sign = item.value > 0 ? '+' : '';
          content += `<div class="block-tooltip-item"><span class="block-tooltip-dot" style="background: ${item.color}"></span><span class="block-tooltip-name">${item.name}</span><span class="block-tooltip-value" style="color: ${item.color}">${sign}${item.value.toFixed(2)}亿</span></div>`;
        });
        tooltip.innerHTML = content;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        let left;
        if (param.point.x + TOOLTIP_MARGIN + tw > cw) {
          left = param.point.x - TOOLTIP_MARGIN - tw;
        } else {
          left = param.point.x + TOOLTIP_MARGIN;
        }
        if (left < 0) left = 4;
        if (left + tw > cw) left = cw - tw - 4;
        let top = param.point.y - th / 2;
        if (top < 4) top = 4;
        if (top + th > ch - 4) top = ch - th - 4;
        tooltip.style.left = `${left}px`;
        tooltip.style.right = 'auto';
        tooltip.style.top = `${top}px`;
      }
    });
  }, [blockChartFrames, selectedBlocks, updateBlockRightAxisLabels, applyBlockHoverHighlight]);

  // 板块折线图渲染 effect
  useEffect(() => {
    if (blockChartContainerRef.current && activeTab === 'block' && blockTab === 'line') {
      renderBlockOverlayChart();
    }
    return () => {
      if (blockChartRef.current) {
        blockChartRef.current.remove();
        blockChartRef.current = null;
      }
    };
  }, [activeTab, blockTab, blockChartFrames, selectedBlocks, renderBlockOverlayChart]);

  useEffect(() => {
    const handleResize = () => {
      [
        { ref: chartRef, container: chartContainerRef },
        { ref: volumeChartRef, container: volumeChartContainerRef },
        { ref: historyChartRef, container: historyChartContainerRef },
        { ref: historyVolumeChartRef, container: historyVolumeChartContainerRef },
      ].forEach(({ ref, container }) => {
        if (ref.current && container.current) {
          // 同时设置 width 与 height，修复 tab 切换后 canvas 高度异常
          ref.current.applyOptions({
            width: container.current.clientWidth,
            height: container.current.clientHeight,
          });
        }
      });
      // 板块资金图表 resize
      if (blockChartRef.current && blockChartContainerRef.current) {
        blockChartRef.current.applyOptions({ width: blockChartContainerRef.current.clientWidth });
        requestAnimationFrame(() => updateBlockRightAxisLabels());
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateBlockRightAxisLabels]);

  // 用 ResizeObserver 监听主力资金图容器尺寸变化（tab 切换 display:none→block 时触发）
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    let prevW = container.clientWidth;
    let prevH = container.clientHeight;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      // 尺寸从 0 恢复为非 0 时，说明 tab 切回来了，调用 chart.applyOptions 恢复 canvas 尺寸
      if ((prevW === 0 && w > 0) || (prevH === 0 && h > 0)) {
        if (chartRef.current) {
          chartRef.current.applyOptions({ width: w, height: h });
          if (volumeChartRef.current && volumeChartContainerRef.current) {
            volumeChartRef.current.applyOptions({
              width: volumeChartContainerRef.current.clientWidth,
              height: volumeChartContainerRef.current.clientHeight,
            });
          }
        }
      }
      prevW = w;
      prevH = h;
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const getAccelerationStatus = (currentValue, previousValue) => {
    if (currentValue > previousValue) return { status: '加速流入', color: '#f5222d', className: 'up' };
    if (currentValue < previousValue) return { status: '加速流出', color: '#52c41a', className: 'down' };
    return { status: '保持不变', color: '#999999', className: 'neutral' };
  };

  const getRecent5MinStatus = useCallback((sourceData) => {
    const dataToUse = sourceData || todayChartData;
    if (!dataToUse || dataToUse.length < 2) {
      return { status: '数据不足', color: '#999999', diff: 0, showWarning: false, className: 'neutral' };
    }
    const sorted = [...dataToUse].sort((a, b) => (a.rawTime || a.time).localeCompare(b.rawTime || b.time));
    const latest = sorted[sorted.length - 1];
    const latestVal = parseMoneyValue(latest.mainMoney);
    const latestTime = latest.rawTime || latest.time;
    const latestTotalMin = timeStrToMinutes(latestTime);

    let refValue = null;
    for (let i = sorted.length - 2; i >= 0; i--) {
      const item = sorted[i];
      const t = item.rawTime || item.time;
      const totalMin = timeStrToMinutes(t);
      if (latestTotalMin - totalMin >= 5) {
        refValue = parseMoneyValue(item.mainMoney);
        break;
      }
    }
    if (refValue === null) {
      return { status: '数据不足', color: '#999999', diff: 0, showWarning: false, className: 'neutral' };
    }
    const diff = latestVal - refValue;
    const sr = getAccelerationStatus(latestVal, refValue);
    const showWarning = sr.status === '加速流入' && diff < 60;
    return { ...sr, diff, showWarning };
  }, [todayChartData]);

  const fiveMinStatus = getRecent5MinStatus();

  const renderTableData = (sourceData, valueKey = 'mainMoney', filterUnchanged = false) => {
    if (!sourceData || sourceData.length === 0) return null;
    const sorted = [...sourceData].sort((a, b) => (b.rawTime || b.time).localeCompare(a.rawTime || a.time));
    const displayData = sorted;

    return displayData.map((item, index) => {
      const timeStr = item.rawTime || item.time;
      const currentValue = parseMoneyValue(item[valueKey]);
      let prevChangedVal = currentValue;
      for (let i = index + 1; i < sorted.length; i++) {
        const prevItem = sorted[i];
        const prevValue = parseMoneyValue(prevItem[valueKey]);
        if (i === index + 1) prevChangedVal = prevValue;
        let nextPrevVal = prevValue;
        if (i + 1 < sorted.length) {
          nextPrevVal = parseMoneyValue(sorted[i + 1][valueKey]);
        }
        if (prevValue !== nextPrevVal) {
          prevChangedVal = prevValue;
          break;
        }
      }
      const { status, className } = getAccelerationStatus(currentValue, prevChangedVal);
      const diff = currentValue - prevChangedVal;
      if (filterUnchanged && status === '保持不变') return null;
      const dt = item.displayTime || formatDisplayTime(timeStr);

      const isBigOutflow = diff <= -4;
      const isBigInflow = diff >= 4;

      return (
        <div key={timeStr} className={`data-item ${currentValue >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow' : ''} ${isBigInflow ? 'big-inflow' : ''}`}>
          <span className="item-time">{dt}</span>
          <span className={`item-value ${currentValue >= 0 ? 'up' : 'down'}`}>
            {currentValue >= 0 ? '+' : ''}{currentValue.toFixed(2)}
            {diff !== 0 && (
              <span className={`item-diff ${diff >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow-text' : ''} ${isBigInflow ? 'big-inflow-text' : ''}`}>
                ({diff >= 0 ? '+' : ''}{diff.toFixed(2)})
              </span>
            )}
          </span>
          <span className={`item-status ${className}`}>{status}</span>
        </div>
      );
    });
  };

  const handleDateChange = (dateStr) => {
    if (dateStr) {
      setHistoryDate(dateStr);
    }
  };

  const openAiSummaryModal = () => {
    setAiSummaryResult(null);
    setAiSummaryModalOpen(true);
  };

  const handleAiSummary = async () => {
    setAiSummaryLoading(true);
    setAiSummaryResult(null);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/main_fund/ai_summary`,
        {},
        { timeout: 300000 }
      );
      if (res.data?.success) {
        setAiSummaryResult(res.data.data);
        message.success('AI 总结完成');
      } else {
        message.error(res.data?.message || 'AI 总结失败');
      }
    } catch (err) {
      message.error('AI 总结失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setAiSummaryLoading(false);
    }
  };

  const handleCopyAiContext = async () => {
    setAiContextLoading(true);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/main_fund/ai_context`,
        {},
        { timeout: 300000 }
      );
      if (res.data?.success) {
        await navigator.clipboard.writeText(res.data.data.prompt);
        message.success('上下文已复制，可粘贴到豆包/千问等 AI 平台');
      } else {
        message.error(res.data?.message || '拷贝上下文失败');
      }
    } catch (err) {
      message.error('拷贝上下文失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setAiContextLoading(false);
    }
  };

  const renderTodayContent = () => {
    const latestToday = todayChartData.length ? todayChartData[todayChartData.length - 1] : null;
    const latestMainMoney = latestToday ? latestToday.mainMoney : null;
    const latestVolume = latestToday ? latestToday.amountChangeDiff : null;
    return (
    <div className="history-content">
      <div className="content-area">
        <div className="chart-section">
          <div className="chart-title-row">
            <div className="chart-left-section">
              <div className="chart-title">主力资金趋势</div>
              <div className="chart-subtitle">实时监控主力资金流入流出变化</div>
            </div>
            <div className="chart-right-section">
              {fiveMinStatus && (
                <span className={`chart-value ${fiveMinStatus.className}`}>
                  {fiveMinStatus.status}
                </span>
              )}
              <Button
                type="primary"
                icon={<RobotOutlined />}
                onClick={openAiSummaryModal}
                className="ai-summary-btn"
              >
                AI 总结
              </Button>
            </div>
          </div>
          <div className="chart-container-wrapper">
            {loading && (
              <div className="chart-overlay">
                <div className="loading-spinner"></div>
                <span className="loading-text">加载中...</span>
              </div>
            )}
            {error && (
              <div className="chart-overlay error-overlay">
                <span className="error-text">{error}</span>
              </div>
            )}
            <div className="crowd-chart-container">
              <div className="crowd-chart-card main-fund-chart-card">
                <div className="crowd-chart-header">
                  <div className="crowd-chart-title">主力资金</div>
                  <div className="crowd-chart-value">
                    <span className="crowd-value-number" style={{ color: '#7c3aed' }}>
                      {latestMainMoney !== null && latestMainMoney !== undefined ? `${latestMainMoney >= 0 ? '+' : ''}${latestMainMoney.toFixed(2)}` : '-'}
                    </span>
                  </div>
                </div>
                <div className="crowd-chart-body">
                  <div ref={chartContainerRef} className="crowd-chart"></div>
                </div>
              </div>
              <div className="crowd-chart-card">
                <div className="crowd-chart-header">
                  <div className="crowd-chart-title">成交量</div>
                  <div className="crowd-chart-value">
                    <span className="crowd-value-number" style={{ color: '#1890ff' }}>
                      {latestVolume !== null && latestVolume !== undefined ? `${latestVolume >= 0 ? '+' : ''}${latestVolume.toFixed(2)}` : '-'}
                    </span>
                  </div>
                </div>
                <div className="crowd-chart-body">
                  <div ref={volumeChartContainerRef} className="crowd-chart"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="table-section">
          {/* 主力资金明细与成交量明细共用的控制栏：5min 级别开关（默认开启，可取消查看 1min 明细）+ 买点诊断按钮 */}
          <div className="table-header">
            <div className="filter-row">
              <label className="switch-label five-min-switch">
                <AntSwitch
                  size="small"
                  checked={fiveMinAggEnabled}
                  onChange={setFiveMinAggEnabled}
                />
                <span className="switch-text">5min级别</span>
              </label>
              <Button
                type="primary"
                size="small"
                icon={<ThunderboltOutlined />}
                onClick={() => setBuyPointDrawerOpen(true)}
              >
                买点诊断
              </Button>
            </div>
          </div>
          <div className="table-cards">
            <div className="detail-card detail-card-fund">
              <div className="detail-card-header">
                <span className="table-title">主力资金明细数据</span>
                <span className={`five-min-status ${fiveMinStatus.className}`}>
                  5min 内{fiveMinStatus.status} {fiveMinStatus.diff >= 0 ? '+' : ''}{fiveMinStatus.diff.toFixed(2)}亿
                </span>
              </div>
              <div className="table-wrapper">
                {renderTableData(todayTableData, 'mainMoney', true)}
              </div>
            </div>
            <div className="detail-card detail-card-volume">
              <div className="detail-card-header">
                <span className="table-title">成交量明细数据</span>
              </div>
              <div className="table-wrapper">
                {renderTableData(todayTableData, 'amountChangeDiff', true)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    );
  };

  const renderHistoryContent = () => {
    const latestHistory = historyChartData.length ? historyChartData[historyChartData.length - 1] : null;
    const hMainMoney = latestHistory ? latestHistory.mainMoney : null;
    const hVolume = latestHistory ? latestHistory.amountChangeDiff : null;
    return (
    <div className="history-content">
      <div className="history-toolbar">
        <div className="history-date-picker">
          <span className="toolbar-label">选择日期：</span>
          <Select
            value={historyDate}
            onChange={handleDateChange}
            style={{ width: 180 }}
            placeholder="选择日期"
            showSearch
            optionFilterProp="children"
          >
            {availableDates.map(d => (
              <Option key={d} value={d}>{d}</Option>
            ))}
          </Select>
        </div>
        {historyData && (
          <span className="history-update-time">数据日期: {historyData.date}</span>
        )}
      </div>
      <div className="content-area">
        <div className="chart-section">
          <div className="chart-title-row">
            <div className="chart-left-section">
              <div className="chart-title">主力资金趋势（5分钟级别）</div>
              <div className="chart-subtitle">历史快照数据 - {historyDate || '--'}</div>
            </div>
          </div>
          <div className="chart-container-wrapper">
            {historyLoading && (
              <div className="chart-overlay">
                <Spin size="large" />
                <span className="loading-text">加载中...</span>
              </div>
            )}
            {historyError && (
              <div className="chart-overlay error-overlay">
                <span className="error-text">{historyError}</span>
              </div>
            )}
            <div className="crowd-chart-container">
              <div className="crowd-chart-card main-fund-chart-card">
                <div className="crowd-chart-header">
                  <div className="crowd-chart-title">主力资金（5min）</div>
                  <div className="crowd-chart-value">
                    <span className="crowd-value-number" style={{ color: '#7c3aed' }}>
                      {hMainMoney !== null && hMainMoney !== undefined ? `${hMainMoney >= 0 ? '+' : ''}${hMainMoney.toFixed(2)}` : '-'}
                    </span>
                  </div>
                </div>
                <div className="crowd-chart-body">
                  <div ref={historyChartContainerRef} className="crowd-chart"></div>
                </div>
              </div>
              <div className="crowd-chart-card">
                <div className="crowd-chart-header">
                  <div className="crowd-chart-title">成交量（10min）</div>
                  <div className="crowd-chart-value">
                    <span className="crowd-value-number" style={{ color: '#1890ff' }}>
                      {hVolume !== null && hVolume !== undefined ? `${hVolume >= 0 ? '+' : ''}${hVolume.toFixed(2)}` : '-'}
                    </span>
                  </div>
                </div>
                <div className="crowd-chart-body">
                  <div ref={historyVolumeChartContainerRef} className="crowd-chart"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="table-section">
          <div className="table-header">
            <div className="header-top">
              <span className="table-title">主力资金明细（5min）</span>
            </div>
          </div>
          <div className="table-wrapper">
            {historyLoading ? (
              <div className="table-loading"><Spin /></div>
            ) : !historyData || historyChartData.filter(d => d.mainMoney !== null).length === 0 ? (
              <div className="table-empty">暂无数据</div>
            ) : (
              renderTableData(historyChartData.filter(d => d.mainMoney !== null))
            )}
          </div>
        </div>
      </div>
    </div>
    );
  };

  // 渲染板块资金明细数据列表
  const renderBlockDetailData = () => {
    if (!blockDetailDisplayData.length) return null;
    return blockDetailDisplayData.map((item, index) => {
      const prevItem = blockDetailDisplayData[index + 1];
      const prevMoney = prevItem ? prevItem.money : item.money;
      const { status, className } = getAccelerationStatus(item.money, prevMoney);
      const diff = item.money - prevMoney;
      return (
        <div key={item.time} className={`data-item ${item.money >= 0 ? 'up' : 'down'}`}>
          <span className="item-time">{item.displayTime}</span>
          <span className={`item-value ${item.money >= 0 ? 'up' : 'down'}`}>
            {item.money >= 0 ? '+' : ''}{item.money.toFixed(2)}
            {diff !== 0 && (
              <span className={`item-diff ${diff >= 0 ? 'up' : 'down'}`}>
                ({diff >= 0 ? '+' : ''}{diff.toFixed(2)})
              </span>
            )}
          </span>
          <span className={`item-status ${className}`}>{status}</span>
        </div>
      );
    });
  };

  // 渲染板块资金 tab
  const renderBlockTab = () => {
    return (
      <div className="history-content">
        <div className="content-area">
          <div className="chart-section">
            <div className="chart-title-row">
              <div className="chart-left-section">
                <div className="chart-title">板块资金趋势</div>
                <div className="chart-subtitle">实时监控各板块资金净流入变化</div>
              </div>
              <div className="chart-right-section">
                <Button
                  type={blockTab === 'line' ? 'primary' : 'default'}
                  icon={<LineChartOutlined />}
                  onClick={() => setBlockTab('line')}
                  size="small"
                >
                  折线图
                </Button>
                <Button
                  type={blockTab === 'heatmap' ? 'primary' : 'default'}
                  icon={<AppstoreOutlined />}
                  onClick={() => setBlockTab('heatmap')}
                  size="small"
                >
                  热力图
                </Button>
                <Button
                  icon={<PlusOutlined />}
                  onClick={() => setShowBlockBatchPanel(!showBlockBatchPanel)}
                  size="small"
                  type={showBlockBatchPanel ? 'primary' : 'default'}
                >
                  {showBlockBatchPanel ? '收起批量添加' : '批量添加'}
                </Button>
              </div>
            </div>

            {blockTab === 'line' && (
              <>
                {/* tag 展示区 */}
                <div className="block-tags">
                  {blockTagInfoList.map(item => (
                    <div
                      key={item.name}
                      data-block-name={item.name}
                      className={`block-tag-item ${blockHoveredBlock === item.name ? 'tag-highlighted' : ''} ${blockHoveredBlock && blockHoveredBlock !== item.name ? 'tag-dimmed' : ''}`}
                      onMouseEnter={handleBlockTagEnter}
                      onMouseLeave={handleBlockTagLeave}
                    >
                      <span className="block-tag-name" style={{ color: item.color }}>{item.name}</span>
                      <span className={`block-tag-money ${item.money > 0 ? 'up' : item.money < 0 ? 'down' : 'neutral'}`}>
                        {item.money > 0 ? '+' : ''}{item.money.toFixed(2)}亿
                      </span>
                      <span className="block-tag-close" onClick={(e) => { e.stopPropagation(); handleRemoveBlock(item.name); }}>
                        <CloseOutlined />
                      </span>
                    </div>
                  ))}
                </div>

                {/* 图表 + 批量添加面板并排 */}
                <div className="block-chart-body">
                  <div className="block-chart-wrapper">
                    {blockLoading && (
                      <div className="chart-overlay">
                        <div className="loading-spinner"></div>
                        <span className="loading-text">加载中...</span>
                      </div>
                    )}
                    <div className="block-chart-container">
                      <div ref={blockChartContainerRef} className="block-chart" />
                      <div ref={blockTooltipRef} className="block-tooltip" />
                      <div className="block-right-axis-labels">
                        {blockRightAxisLabels
                          .filter(label => !blockHoveredBlock || label.key === blockHoveredBlock)
                          .map(label => (
                          <div
                            key={label.key}
                            className={`block-right-label ${blockHoveredBlock === label.key ? 'label-highlighted' : ''}`}
                            style={{ top: `${label.y}px`, borderColor: label.color }}
                          >
                            <span className="block-right-label-name" style={{ color: label.color }}>
                              {label.name}
                            </span>
                            <span className={`block-right-label-value ${label.valueClass}`}>
                              {label.valueStr}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {showBlockBatchPanel && (
                    <div className="block-batch-panel">
                      <div className="block-batch-header">
                        <span className="block-batch-title">板块列表 <span className="block-batch-count">{selectedNewBlocks.length}</span></span>
                        <Input
                          placeholder="搜索板块名称"
                          prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                          allowClear
                          size="small"
                          value={blockPanelSearch}
                          onChange={e => setBlockPanelSearch(e.target.value)}
                        />
                      </div>
                      <div className="block-batch-body">
                        {filteredPanelBlocks.length === 0 ? (
                          <div className="block-batch-empty">暂无板块</div>
                        ) : (
                          filteredPanelBlocks.map(b => {
                            const alreadyAdded = selectedBlocks.includes(b);
                            return (
                              <div key={b} className={`block-batch-item ${alreadyAdded ? 'disabled' : ''}`}>
                                <Checkbox
                                  checked={selectedNewBlocks.includes(b)}
                                  disabled={alreadyAdded}
                                  onChange={e => {
                                    if (e.target.checked) setSelectedNewBlocks(prev => [...prev, b]);
                                    else setSelectedNewBlocks(prev => prev.filter(x => x !== b));
                                  }}
                                />
                                <span className="block-batch-name">{b}</span>
                                {alreadyAdded ? <Tag className="block-batch-tag">已叠加</Tag> : null}
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="block-batch-footer">
                        <Button size="small" onClick={() => setShowBlockBatchPanel(false)}>取消</Button>
                        <Button size="small" type="primary" disabled={selectedNewBlocks.length === 0} onClick={handleConfirmBlockBatchAdd}>
                          确定（{selectedNewBlocks.length}）
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {blockTab === 'heatmap' && (
              <div className="block-heatmap-stage">
                {blockHeatmapItems.length > 0 ? (
                  <div className="heatmap-panel">
                    <div className="heatmap-header">
                      <div className="heatmap-title">板块资金热力图</div>
                      <div className="heatmap-legend">
                        <span className="legend-item legend-positive">流入增强</span>
                        <span className="legend-item legend-neutral">矩形越大、颜色越深代表净额越强</span>
                        <span className="legend-item legend-negative">流出增强</span>
                      </div>
                    </div>
                    <div className="heatmap-board">
                      <div className="heatmap-treemap">
                        <div className="heatmap-treemap-caption">所有行业</div>
                        <div className="heatmap-treemap-area">
                          {blockHeatmapItems.map(item => (
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
                              onClick={() => handleBlockCircleClick(item.jumpUrl)}
                              title={`${item.block} ${formatBlockMoney(item.money)}`}
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
                                  <div className="tile-money">{formatBlockMoney(item.money)}</div>
                                  <div className="tile-meta">{item.money >= 0 ? '净流入' : '净流出'}</div>
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
                          {(() => {
                            const maxAbs = blockHeatmapItems.reduce((max, item) => Math.max(max, Math.abs(item.money || 0)), 0);
                            const vals = maxAbs > 0 ? [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs] : [0, 0, 0, 0, 0];
                            return vals.map((v, i) => (
                              <span key={i} className="heatmap-scale-label">{formatBlockLegendYi(v)}</span>
                            ));
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="table-empty">{blockLoading ? '加载中...' : '暂无数据'}</div>
                )}
              </div>
            )}
          </div>

          <div className="table-section">
            <div className="table-header">
              <div className="header-top">
                <span className="table-title">板块资金明细</span>
                <div className="header-controls">
                  <label className="switch-label five-min-switch">
                    <AntSwitch
                      size="small"
                      checked={blockFiveMinAgg}
                      onChange={setBlockFiveMinAgg}
                    />
                    <span className="switch-text">5分钟级别</span>
                  </label>
                  <Select
                    value={blockDetailSelected || undefined}
                    onChange={setBlockDetailSelected}
                    style={{ width: 160 }}
                    placeholder="选择板块"
                    showSearch
                    optionFilterProp="children"
                    size="small"
                  >
                    {allBlocks.map(b => (
                      <Option key={b} value={b}>{b}</Option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
            <div className="table-wrapper">
              {blockDetailDisplayData.length === 0 ? (
                <div className="table-empty">{blockLoading ? '加载中...' : '暂无数据'}</div>
              ) : (
                renderBlockDetailData()
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="main-fund-content">
      {/* 自动买点诊断命中弹窗：展示各个买点诊断的条件卡片 */}
      <Modal
        open={buyPointModalOpen}
        onCancel={() => setBuyPointModalOpen(false)}
        width={680}
        title={
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>
            🎯 买点诊断命中
            {buyPointResult?.timestamp ? <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7890', marginLeft: 8 }}>{buyPointResult.timestamp}</span> : null}
          </span>
        }
        footer={
          <Button type="primary" size="large" onClick={() => setBuyPointModalOpen(false)} style={{ borderRadius: 999, padding: '0 28px' }}>
            知道了
          </Button>
        }
        className="buy-point-check-modal"
        centered
        destroyOnClose
      >
        {buyPointResult && (
          <div className="buy-diagnosis-drawer">
            <div className="panel-header">
              <span className="panel-title">买点条件诊断</span>
              <span className={`panel-badge ${buyPointResult.allPassed ? 'pass' : 'fail'}`}>
                {buyPointResult.passedCount}/{buyPointResult.totalCheckCount}
              </span>
            </div>
            <div className="fbd-checks-list" style={{ maxHeight: 420, overflowY: 'auto' }}>
              {buyPointResult.checks.map((check, idx) => (
                <div key={check.id} className={`fbd-check-card ${check.passed ? 'passed' : 'failed'}`}>
                  <div className="fbd-card-header">
                    <div className="fbd-title-row">
                      <span className={`fbd-num ${check.passed ? 'num-pass' : 'num-fail'}`}>{idx + 1}</span>
                      <span className="fbd-title">{check.title}</span>
                    </div>
                    {check.passed ? (
                      <CheckCircleFilled className="fbd-status-icon pass-icon" />
                    ) : (
                      <CloseCircleFilled className="fbd-status-icon fail-icon" />
                    )}
                  </div>
                  <div className="fbd-card-body">
                    <div className="fbd-value-row">
                      <span className="fbd-value-label">当前值</span>
                      <span className={`fbd-value ${check.passed ? 'value-pass' : 'value-fail'}`}>{check.value}</span>
                    </div>
                    {check.detail && (
                      <div className="fbd-detail-row">
                        {check.id === 'fund_inflow' && check.detail.pastValue != null && check.detail.currentValue != null && (
                          <span className="fbd-detail-item">
                            资金 <b>{check.detail.pastValue >= 0 ? '+' : ''}{check.detail.pastValue.toFixed(2)}亿</b>
                            <span className="fbd-arrow"> → </span>
                            <b>{check.detail.currentValue >= 0 ? '+' : ''}{check.detail.currentValue.toFixed(2)}亿</b>
                            <span className="fbd-detail-time">（{check.detail.pastTime} → {check.detail.currentTime}）</span>
                          </span>
                        )}
                        {check.id === 'volume_expansion' && check.detail.prev5minVol != null && check.detail.last5minVol != null && (
                          <span className="fbd-detail-item">
                            量能变化 <b>{check.detail.prev5minVol.toFixed(2)}亿</b>
                            <span className="fbd-arrow"> → </span>
                            <b>{check.detail.last5minVol.toFixed(2)}亿</b>
                            <span className="fbd-detail-time">（{check.detail.pastTime} → {check.detail.currentTime}）</span>
                          </span>
                        )}
                      </div>
                    )}
                    <div className="fbd-reason">{check.reason}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className={`fbd-conclusion ${buyPointResult.allPassed ? 'conclusion-pass' : 'conclusion-fail'}`}>
              <div className={`fbd-conclusion-title ${buyPointResult.allPassed ? 'title-pass' : 'title-fail'}`}>
                {buyPointResult.allPassed ? '🚀 诊断结果：可以出手' : '⚠️ 诊断结果：暂不可出手'}
              </div>
              <div className="fbd-conclusion-text">{buyPointResult.conclusion}</div>
            </div>
          </div>
        )}
      </Modal>

      {/* 手动买点诊断抽屉：点击控制栏「买点诊断」按钮打开，展示各条件是否符合 */}
      <BuyPointDiagnosisDrawer
        open={buyPointDrawerOpen}
        onClose={() => setBuyPointDrawerOpen(false)}
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        className="main-fund-tabs"
        items={[
          {
            key: 'today',
            label: '当天数据',
            children: renderTodayContent(),
          },
          {
            key: 'block',
            label: '板块资金',
            children: renderBlockTab(),
          },
          {
            key: 'history',
            label: '历史数据',
            children: renderHistoryContent(),
          },
        ]}
      />

      <Modal
        title="AI 行情总结"
        open={aiSummaryModalOpen}
        onCancel={() => setAiSummaryModalOpen(false)}
        footer={null}
        width={820}
        className="ai-summary-modal"
      >
        <div className="ai-summary-actions">
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={aiSummaryLoading}
            onClick={handleAiSummary}
            className="ai-action-btn ai-action-summary"
          >
            开始总结
          </Button>
          <Button
            icon={<CopyOutlined />}
            loading={aiContextLoading}
            onClick={handleCopyAiContext}
            className="ai-action-btn ai-action-copy"
          >
            拷贝上下文
          </Button>
          <span className="ai-action-tip">拷贝上下文后可粘贴到豆包/千问等 AI 平台进行分析</span>
        </div>

        {aiSummaryLoading ? (
          <div className="ai-summary-loading">
            <Spin size="large" />
            <div className="loading-text">正在拉取历史分时数据并调用 AI 分析…</div>
            <div className="loading-sub">首次运行需拉取历史数据，请耐心等待</div>
          </div>
        ) : aiSummaryResult ? (
          <div className="ai-summary-content">
            <div className="ai-summary-meta">
              <span>分析时间: {aiSummaryResult.currentTime}</span>
              <span>模型: {aiSummaryResult.model}</span>
              {aiSummaryResult.dataInfo && (
                <span>
                  上下文: 创业板{aiSummaryResult.dataInfo.cybHistoryDays}天 + 科创{aiSummaryResult.dataInfo.kcbHistoryDays}天
                </span>
              )}
            </div>
            <div
              className="ai-summary-answer markdown-body"
              dangerouslySetInnerHTML={{ __html: marked.parse(aiSummaryResult.analysis || '') }}
            />
          </div>
        ) : (
          <div className="ai-summary-empty">
            <RobotOutlined className="empty-icon" />
            <div className="empty-title">点击「开始总结」生成 AI 行情分析</div>
            <div className="empty-desc">或点击「拷贝上下文」将数据粘贴到其他 AI 平台</div>
          </div>
        )}
      </Modal>
    </div>
  );
};

const MainFund = () => (
  <div className="main-fund-page">
    <MainFundContent />
    <FloatingTechEmotion />
  </div>
);

export default MainFund;
