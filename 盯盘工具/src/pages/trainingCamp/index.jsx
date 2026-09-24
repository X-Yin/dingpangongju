import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Row, Col, Spin, Empty, message, Card } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import { replayTechEmotionStore } from '../../utils/replayTechEmotion';
import useReplay from './utils/useReplay';
import TopBar from './components/TopBar';
import ReplayProgressBar from './components/ReplayProgressBar';
import MainMoneyCharts from '../dingpan/components/MainMoneyCharts';
import BlockRankingCards from '../dingpan/components/BlockRankingCards';
import StockChangeMonitor from '../dingpan/components/StockChangeMonitor';
import MultiStockTimeLineModal from '../../components/MultiStockTimeLineModal';
import BuyPointCheckModal from './components/BuyPointCheckModal';
import SellPointCheckModal from './components/SellPointCheckModal';
import SimPositionsModal from './components/SimPositionsModal';
import runBuyPointDiagnosis from './utils/buyPointChecks';
import runSellPointDiagnosis from './utils/sellPointChecks';
import { ensureReplayMinuteTlineByDate, subscribeMinuteTlineUpdate } from '../../utils/replayResilience';
import './index.scss';

const SIM_POSITIONS_KEY = 'trainingCamp_simPositions';
const SELECTED_DATE_KEY = 'trainingCamp_selectedDate';
const CURRENT_INDEX_KEY = 'trainingCamp_currentIndex';

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

const timeKeyToUnix = (timeKey, dateStr) => {
  const hh = timeKey.substring(0, 2);
  const mm = timeKey.substring(2, 4);
  const ss = timeKey.substring(4, 6);
  return dayjs(`${dateStr} ${hh}:${mm}:${ss}`).unix();
};

const TrainingCamp = () => {
  const [dates, setDates] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [campData, setCampData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stockViewMode, setStockViewMode] = useState('grouped');
  const [isMainMoneyExpanded, setIsMainMoneyExpanded] = useState(false);
  const [volumeRefreshKey, setVolumeRefreshKey] = useState(0);
  const lastVolumeRefreshKeyRef = useRef(0);
  // 展开/收起时卸载并重新挂载主力资金与成交量图表（key 递增触发重渲染重建）
  const [chartEpoch, setChartEpoch] = useState(0);
  const prevExpandedRef = useRef(isMainMoneyExpanded);
  const [buyPointModal, setBuyPointModal] = useState({ open: false, result: null });
  const buyPointWasPlayingRef = useRef(false);
  const isPlayingRef = useRef(false);
  // 模拟持仓（useState 初始化时从 localStorage 恢复，避免挂载时保存 effect 先写入空数组覆盖）
  const [simPositions, setSimPositions] = useState(() => {
    try {
      const saved = localStorage.getItem(SIM_POSITIONS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    return [];
  });
  const simPositionsRef = useRef([]);
  const [sellPointModal, setSellPointModal] = useState({ open: false, results: [] });
  const sellPointModalRef = useRef({ open: false, results: [] });
  const [simPositionsModalOpen, setSimPositionsModalOpen] = useState(false);
  const sellAlertWasPlayingRef = useRef(false);

  const mainMoneyContainerRef = useRef(null);
  const mainMoneyChartRef = useRef(null);
  const mainMoneySeriesRef = useRef(null);
  const cybOverlaySeriesRef = useRef(null);   // 主力资金图上叠加的创业板分时（紫色虚线）
  const kcbOverlaySeriesRef = useRef(null);   // 主力资金图上叠加的科创板分时（橙色虚线）
  const volumeContainerRef = useRef(null);
  const volumeChartRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const cybTlineContainerRef = useRef(null);
  const cybTlineChartRef = useRef(null);
  const cybSeriesRef = useRef(null);
  const kcbTlineContainerRef = useRef(null);
  const kcbTlineChartRef = useRef(null);
  const kcbSeriesRef = useRef(null);

  useEffect(() => {
    axios.get(`http://${local_ip}:3000/training_camp/dates`).then(r => {
      const list = Array.isArray(r.data) ? r.data : [];
      setDates(list);
      if (list.length > 0) setSelectedDate(readSavedDate(list));
    }).catch(() => message.error('获取可回放日期失败'));
    axios.get(`http://${local_ip}:3000/training_camp/groups`).then(r => setGroups(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  // 读取上次缓存的日期：若仍在可选日期列表内则恢复，否则回退到最新一天
  const readSavedDate = (list) => {
    try {
      const saved = localStorage.getItem(SELECTED_DATE_KEY);
      if (saved && list.includes(saved)) return saved;
    } catch (e) {}
    return list[0];
  };

  // 每次切换日期时缓存到 localStorage
  useEffect(() => {
    if (selectedDate) {
      try { localStorage.setItem(SELECTED_DATE_KEY, selectedDate); } catch (e) {}
    }
  }, [selectedDate]);

  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    setCampData(null);
    // 模拟持仓保存在组件内存中，切换日期时保留（仅在刷新页面/切换tab时随组件卸载重置）
    // 同时重置卖点告警标记，避免上个交易日的告警状态延续到新日期
    setSimPositions(prev => prev.map(p => ({ ...p, sellAlertActive: false })));
    [mainMoneyChartRef, volumeChartRef, cybTlineChartRef, kcbTlineChartRef].forEach(ref => {
      if (ref.current) { try { ref.current.remove(); } catch { /* noop */ } ref.current = null; }
    });
    mainMoneySeriesRef.current = null;
    cybOverlaySeriesRef.current = null;
    kcbOverlaySeriesRef.current = null;
    volumeSeriesRef.current = null;
    cybSeriesRef.current = null;
    kcbSeriesRef.current = null;
    axios.get(`http://${local_ip}:3000/training_camp/data`, { params: { date: selectedDate } }).then(r => {
      if (r.data?.success === false) {
        message.error(r.data.message || '加载回放数据失败');
        setCampData(null);
      } else if (r.data?.timeBuckets) {
        setCampData(r.data);
      }
    }).catch(() => message.error('加载回放数据失败')).finally(() => setLoading(false));
  }, [selectedDate]);

  useEffect(() => {
    return () => replayTechEmotionStore.reset();
  }, []);

  const timeBuckets = campData?.timeBuckets || [];
  const replay = useReplay(timeBuckets, { intervalMs: 5000 });
  const { currentIndex, currentBucket, isPlaying, toggle, pause, play, seek, stepForward, stepBackward } = replay;
  isPlayingRef.current = isPlaying;

  // 每次播放/拖动时间桶时缓存该日期的进度（按日期分别存储）
  useEffect(() => {
    if (timeBuckets.length > 0 && selectedDate) {
      try {
        const obj = JSON.parse(localStorage.getItem(CURRENT_INDEX_KEY) || '{}');
        obj[selectedDate] = currentIndex;
        localStorage.setItem(CURRENT_INDEX_KEY, JSON.stringify(obj));
      } catch (e) {}
    }
  }, [currentIndex, selectedDate, timeBuckets]);

  // 页面刷新首次加载数据后，恢复上次缓存的该日期时间桶进度（仅恢复一次）
  const restoreRef = useRef(false);
  useEffect(() => {
    if (restoreRef.current) return;
    if (!campData || timeBuckets.length === 0) return;
    try {
      const obj = JSON.parse(localStorage.getItem(CURRENT_INDEX_KEY) || '{}');
      const saved = obj[selectedDate];
      if (saved != null && Number.isInteger(Number(saved)) && Number(saved) > 0 && Number(saved) < timeBuckets.length) {
        seek(Number(saved));
      }
    } catch (e) {}
    restoreRef.current = true;
  }, [campData, timeBuckets, selectedDate, seek]);

  // 每切换到一个时间桶自动运行一次买点诊断，命中则弹出弹窗并暂停播放
  useEffect(() => {
    if (!campData || timeBuckets.length === 0 || currentIndex < 1) return;
    const result = runBuyPointDiagnosis(timeBuckets, currentIndex, campData);
    // 触发条件：前置检查全部通过（allPassed，与逻辑）；尾盘抄底或逻辑分支已移除
    if (result?.data?.allPassed === true) {
      buyPointWasPlayingRef.current = isPlayingRef.current;
      if (isPlayingRef.current) pause();
      setBuyPointModal({ open: true, result: result.data });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, campData, timeBuckets]);

  const handleBuyPointModalClose = () => {
    setBuyPointModal({ open: false, result: null });
    if (buyPointWasPlayingRef.current) {
      buyPointWasPlayingRef.current = false;
      play();
    }
  };

  // 手动买点诊断：对当前时间桶执行诊断并打开弹窗，查看各条件命中情况（不暂停播放）
  const handleManualBuyPointDiagnosis = useCallback(() => {
    if (!campData || timeBuckets.length === 0 || !currentBucket) return;
    const result = runBuyPointDiagnosis(timeBuckets, currentIndex, campData);
    if (result?.data) {
      setBuyPointModal({ open: true, result: result.data });
    }
  }, [campData, timeBuckets, currentIndex, currentBucket]);

  // ===== 模拟持仓（localStorage 持久化，刷新页面仍保留）=====
  const replayStocksRef = useRef([]);
  useEffect(() => {
    simPositionsRef.current = simPositions;
    try { localStorage.setItem(SIM_POSITIONS_KEY, JSON.stringify(simPositions)); } catch (e) {}
  }, [simPositions]);

  const handleAddSimPosition = useCallback((position) => {
    setSimPositions(prev => [...prev, {
      id: `sp${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ...position,
      status: 'holding',
      sellAlertActive: false,
    }]);
  }, []);

  const handleDeleteSimPosition = useCallback((id) => {
    setSimPositions(prev => prev.filter(p => p.id !== id));
  }, []);

  // 回退卖出：将已卖出持仓恢复为持有状态，买入日期与价格保持不变
  const handleRollbackSimPosition = useCallback((id) => {
    setSimPositions(prev => prev.map(p => (
      p.id === id
        ? { ...p, status: 'holding', sellPrice: undefined, sellTimeKey: undefined, returnRate: undefined, sellAlertActive: false }
        : p
    )));
  }, []);

  // 重置所有模拟持仓（清除 localStorage 与内存状态）
  const handleResetSimPositions = useCallback(() => {
    setSimPositions([]);
    simPositionsRef.current = [];
    try { localStorage.removeItem(SIM_POSITIONS_KEY); } catch (e) {}
    message.success('模拟持仓已重置');
  }, []);

  // 一键重置：清空日期、时间桶进度、模拟持仓等所有缓存，并回到最新一天
  const handleResetAll = useCallback(() => {
    try {
      localStorage.removeItem(SELECTED_DATE_KEY);
      localStorage.removeItem(CURRENT_INDEX_KEY);
      localStorage.removeItem(SIM_POSITIONS_KEY);
    } catch (e) {}
    setSimPositions([]);
    simPositionsRef.current = [];
    restoreRef.current = false;
    seek(0);
    setSelectedDate(dates.length > 0 ? dates[0] : '');
    message.success('已重置回放进度与模拟持仓，加载最新一天');
  }, [dates, seek]);

  // 成交量图刷新：点击后重新触发图表加载
  const handleVolumeRefresh = useCallback(() => setVolumeRefreshKey(k => k + 1), []);

  // 手动触发卖点诊断（查看模拟持仓弹窗中点击）
  const handleManualSellDiagnosis = useCallback((position) => {
    const result = runSellPointDiagnosis(position, currentBucket, replayStocksRef.current, timeBuckets, currentIndex, String(campData?.date || ''));
    setSellPointModal({ open: true, results: [{ ...result, positionId: position.id }] });
  }, [currentBucket, timeBuckets, currentIndex, campData]);

  // 确认卖出：标记对应持仓为已卖出并记录卖出价与收益率，弹窗内移除该股票卡片；
  // 全部卡片处理完后关闭弹窗并恢复播放
  const handleSellConfirmed = useCallback((result) => {
    if (result?.positionId) {
      setSimPositions(prev => prev.map(p => (
        p.id === result.positionId
          ? { ...p, status: 'sold', sellPrice: result.closePrice, sellTimeKey: result.displayTime, returnRate: result.returnRate, sellAlertActive: false }
          : p
      )));
    }
    const rest = (sellPointModalRef.current.results || []).filter(r => r.positionId !== result?.positionId);
    sellPointModalRef.current = { open: rest.length > 0, results: rest };
    setSellPointModal(sellPointModalRef.current);
    if (rest.length === 0 && sellAlertWasPlayingRef.current) {
      sellAlertWasPlayingRef.current = false;
      play();
    }
  }, [play]);

  const handleSellPointModalClose = useCallback(() => {
    sellPointModalRef.current = { open: false, results: [] };
    setSellPointModal({ open: false, results: [] });
    if (sellAlertWasPlayingRef.current) {
      sellAlertWasPlayingRef.current = false;
      play();
    }
  }, [play]);

  useEffect(() => {
    if (currentBucket?.techEmotion != null) {
      replayTechEmotionStore.set(currentBucket.techEmotion);
    }
  }, [currentIndex, currentBucket]);

  const historyData = useMemo(() => {
    if (!campData) return [];
    return timeBuckets.slice(0, currentIndex + 1).map(b => [
      b.timeKey,
      { mainMoney: b.fundFlow, amountChangeDiff: b.volume, rawTime: b.timeKey },
    ]);
  }, [campData, timeBuckets, currentIndex]);

  const moneyStatus = useMemo(() => {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1][1];
    const prev = historyData[historyData.length - 2][1];
    const cur = parseMoneyValue(latest.mainMoney);
    const pre = parseMoneyValue(prev.mainMoney);
    if (cur > pre) return { label: '加速流入', color: '#f5222d', icon: <span>↑</span> };
    if (cur < pre) return { label: '加速流出', color: '#52c41a', icon: <span>↓</span> };
    return null;
  }, [historyData]);

  // 表头展示主力资金相邻时间桶的 diff 变化值（如 +2.3亿 / -1.8亿），而非净流入绝对值
  const latestMoneyValue = useMemo(() => {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1][1];
    const prev = historyData[historyData.length - 2][1];
    const cur = parseMoneyValue(latest.mainMoney);
    const pre = parseMoneyValue(prev.mainMoney);
    return cur - pre;
  }, [historyData]);

  // 成交量（展开主力资金时成交量图被隐藏，需在表头补充显示）真实数值与 diff 值，单位亿
  const latestVolumeValue = useMemo(() => {
    if (historyData.length === 0) return null;
    const last = historyData[historyData.length - 1][1];
    const v = last.amountChangeDiff;
    return v != null && v !== '' ? parseFloat(v) : null;
  }, [historyData]);

  const volumeDiffValue = useMemo(() => {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1][1];
    const prev = historyData[historyData.length - 2][1];
    const cur = parseFloat(latest.amountChangeDiff) || 0;
    const pre = parseFloat(prev.amountChangeDiff) || 0;
    return cur - pre;
  }, [historyData]);

  const volumeStatus = useMemo(() => {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1][1];
    const prev = historyData[historyData.length - 2][1];
    const cur = parseFloat(latest.amountChangeDiff) || 0;
    const pre = parseFloat(prev.amountChangeDiff) || 0;
    if (cur > pre) return { label: '持续放量', color: '#1677ff', icon: <span>↑</span> };
    if (cur < pre) return { label: '持续缩量', color: '#52c41a', icon: <span>↓</span> };
    return null;
  }, [historyData]);

  const indexTlineData = useMemo(() => {
    if (!campData || timeBuckets.length === 0) return { cyb: [], kcb: [] };
    const dateStr = campData.dateDisplay.replace(/-/g, '');
    const buckets = timeBuckets.slice(0, currentIndex + 1);
    const cyb = buckets.filter(b => b.indexTline?.cyb).map(b => ({
      time: timeKeyToUnix(b.timeKey, dateStr),
      value: b.indexTline.cyb.changePct,
    }));
    const kcb = buckets.filter(b => b.indexTline?.kcb).map(b => ({
      time: timeKeyToUnix(b.timeKey, dateStr),
      value: b.indexTline.kcb.changePct,
    }));
    return { cyb, kcb };
  }, [campData, timeBuckets, currentIndex]);

  const topAndBottomBlockData = useMemo(() => {
    if (!currentBucket?.blockRanking) return { firstNumList: [], lastNumList: [] };
    return currentBucket.blockRanking;
  }, [currentBucket]);


  const fullStockData = useMemo(() => {
    if (!currentBucket) return { changeList: [], aboveOpeningList: [], belowOpeningList: [], upCount: 0, downCount: 0 };
    const changeList = currentBucket.stockChanges.map(s => ({
      code: s.code,
      name: s.name,
      changeValue: s.changePct,
      change: `${s.changePct > 0 ? '+' : ''}${s.changePct}%`,
      isImportant: false,
      statusKey: (s.changePct || 0) >= 0 ? 'Red' : 'Green',
    }));
    changeList.sort((a, b) => b.changeValue - a.changeValue);
    const above = changeList.filter(s => s.changeValue >= 0);
    const below = changeList.filter(s => s.changeValue < 0);
    // 小于开盘价分组按跌幅从高到低排序
    below.sort((a, b) => a.changeValue - b.changeValue);
    return { changeList, aboveOpeningList: above, belowOpeningList: below, upCount: above.length, downCount: below.length };
  }, [currentBucket]);

  const createBaseChart = useCallback((container) => {
    return createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6b7890',
        fontSize: 11,
      },
      width: container.clientWidth,
      height: container.clientHeight || 220,
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
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      handleScroll: false,
      handleScale: false,
    });
  }, []);

  useEffect(() => {
    if (historyData.length === 0) return;
    const dateStr = campData?.dateDisplay.replace(/-/g, '') || dayjs().format('YYYYMMDD');

    const buildChartData = (data, field) => {
      const sorted = [...data].sort((a, b) => a[0].localeCompare(b[0]));
      return sorted.map(([time, item]) => ({
        time: timeKeyToUnix(time, dateStr),
        value: parseFloat(item[field]) || 0,
      }));
    };

    if (mainMoneyContainerRef.current) {
      if (!mainMoneyChartRef.current) {
        const chart = createBaseChart(mainMoneyContainerRef.current);
        mainMoneyChartRef.current = chart;
        const series = chart.addLineSeries({
          color: '#f5222d', lineWidth: 2,
          priceFormat: { type: 'price', precision: 0, minMove: 1 },
        });
        mainMoneySeriesRef.current = series;
        series.setData(buildChartData(historyData, 'mainMoney'));
        series.createPriceLine({ price: -100, color: 'red', lineStyle: LineStyle.Dashed });
        // 叠加创业板分时（紫色虚线）与科创板分时（橙色虚线），共用顶部独立价格刻度
        cybOverlaySeriesRef.current = chart.addLineSeries({
          color: '#722ed1', lineWidth: 2, lineStyle: LineStyle.Dashed,
          priceScaleId: 'index',
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        kcbOverlaySeriesRef.current = chart.addLineSeries({
          color: '#fa8c16', lineWidth: 2, lineStyle: LineStyle.Dashed,
          priceScaleId: 'index',
          priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        chart.priceScale('index').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.05 } });
        cybOverlaySeriesRef.current.setData(indexTlineData.cyb);
        kcbOverlaySeriesRef.current.setData(indexTlineData.kcb);
        chart.timeScale().fitContent();
      } else {
        mainMoneySeriesRef.current?.setData(buildChartData(historyData, 'mainMoney'));
        cybOverlaySeriesRef.current?.setData(indexTlineData.cyb);
        kcbOverlaySeriesRef.current?.setData(indexTlineData.kcb);
        mainMoneyChartRef.current?.timeScale().fitContent();
      }
    }

    if (volumeContainerRef.current) {
      // 点击刷新按钮时强制重建成交量图，解决偶发图表不展示问题
      const needsRecreate = volumeRefreshKey !== lastVolumeRefreshKeyRef.current;
      lastVolumeRefreshKeyRef.current = volumeRefreshKey;
      if (needsRecreate && volumeChartRef.current) {
        try { volumeChartRef.current.remove(); } catch (e) {}
        volumeChartRef.current = null;
        volumeSeriesRef.current = null;
      }
      if (!volumeChartRef.current) {
        const chart = createBaseChart(volumeContainerRef.current);
        volumeChartRef.current = chart;
        const series = chart.addLineSeries({
          color: getThemeColor(), lineWidth: 2,
          priceFormat: { type: 'price', precision: 0, minMove: 1 },
        });
        volumeSeriesRef.current = series;
        series.setData(buildChartData(historyData, 'amountChangeDiff'));
        chart.timeScale().fitContent();
      } else {
        volumeSeriesRef.current?.setData(buildChartData(historyData, 'amountChangeDiff'));
        volumeChartRef.current?.timeScale().fitContent();
      }
    }
  }, [historyData, campData, createBaseChart, indexTlineData, volumeRefreshKey, chartEpoch]);

  useEffect(() => {
    if (cybTlineContainerRef.current && indexTlineData.cyb.length > 0) {
      if (!cybTlineChartRef.current) {
        const chart = createBaseChart(cybTlineContainerRef.current);
        cybTlineChartRef.current = chart;
        cybSeriesRef.current = chart.addLineSeries({ color: '#f5222d', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
      }
      cybSeriesRef.current?.setData(indexTlineData.cyb);
      cybTlineChartRef.current?.timeScale().fitContent();
    }
  }, [indexTlineData, createBaseChart]);

  useEffect(() => {
    if (kcbTlineContainerRef.current && indexTlineData.kcb.length > 0) {
      if (!kcbTlineChartRef.current) {
        const chart = createBaseChart(kcbTlineContainerRef.current);
        kcbTlineChartRef.current = chart;
        kcbSeriesRef.current = chart.addLineSeries({ color: '#1677ff', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
      }
      kcbSeriesRef.current?.setData(indexTlineData.kcb);
      kcbTlineChartRef.current?.timeScale().fitContent();
    }
  }, [indexTlineData, createBaseChart]);

  useEffect(() => {
    const handleResize = () => {
      const refs = [
        { chart: mainMoneyChartRef, container: mainMoneyContainerRef },
        { chart: volumeChartRef, container: volumeContainerRef },
        { chart: cybTlineChartRef, container: cybTlineContainerRef },
        { chart: kcbTlineChartRef, container: kcbTlineContainerRef },
      ];
      for (const { chart, container } of refs) {
        if (chart.current && container.current) {
          chart.current.applyOptions({ width: container.current.clientWidth, height: container.current.clientHeight });
          chart.current.timeScale().fitContent();
        }
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 展开/收起时卸载主力资金与成交量图表实例，配合 MainMoneyCharts 的 key 重新挂载，按新容器宽度重建
  useEffect(() => {
    if (prevExpandedRef.current === isMainMoneyExpanded) return;
    prevExpandedRef.current = isMainMoneyExpanded;
    [mainMoneyChartRef, volumeChartRef].forEach((chartRef) => {
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch (e) {}
        chartRef.current = null;
      }
    });
    mainMoneySeriesRef.current = null;
    cybOverlaySeriesRef.current = null;
    kcbOverlaySeriesRef.current = null;
    volumeSeriesRef.current = null;
    setChartEpoch((k) => k + 1);
  }, [isMainMoneyExpanded]);

  const replayStocks = useMemo(() => {
    if (!campData) return [];
    const stockMap = new Map();
    // 基准指数分时序列（科创/创业板指数），用于实时抗分歧指数计算与展示
    const indexTline = { sh000688: [], sz399006: [] };
    const indexNames = { sh000688: '科创指数', sz399006: '创业板指数' };
    for (const bucket of timeBuckets.slice(0, currentIndex + 1)) {
      const itl = bucket.indexTline || {};
      if (itl.kcb && itl.kcb.changePct != null) {
        indexTline.sh000688.push({ minute: bucket.minute, change: itl.kcb.changePct, lastPx: itl.kcb.price });
      }
      if (itl.cyb && itl.cyb.changePct != null) {
        indexTline.sz399006.push({ minute: bucket.minute, change: itl.cyb.changePct, lastPx: itl.cyb.price });
      }
      for (const sc of bucket.stockChanges) {
        if (!stockMap.has(sc.code)) {
          const lowByCode = campData.dailyLowByCode || {};
          stockMap.set(sc.code, { code: sc.code, stockName: sc.name, tlinePoints: [], dailyLowMap: lowByCode[sc.code] || null });
        }
        if (sc.changePct != null) {
          stockMap.get(sc.code).tlinePoints.push({ minute: bucket.minute, change: sc.changePct, lastPx: sc.lastPx });
        }
      }
    }
    Object.entries(indexTline).forEach(([code, points]) => {
      if (points.length > 0) {
        stockMap.set(code, { code, stockName: indexNames[code], isDefaultIndex: true, tlinePoints: points });
      }
    });
    return Array.from(stockMap.values()).filter(s => s.tlinePoints.length > 0);
  }, [campData, timeBuckets, currentIndex]);

  useEffect(() => { replayStocksRef.current = replayStocks; }, [replayStocks]);

  // 每切换到一个时间桶自动运行模拟持仓卖点诊断，命中则弹出卖点诊断弹窗并暂停播放
  // 规则：添加持仓的当天不运行卖点诊断，仅当回放日期晚于买入日期时才自动诊断
  // 条件5当日实时分数依赖分钟级分时（与叠加分时 tag 同源缓存），先确保持仓股票及基准指数已拉取，
  // 拉取完成触发 minuteTlineVersion 变化后本 effect 会重算
  const [minuteTlineVersion, setMinuteTlineVersion] = useState(0);
  useEffect(() => subscribeMinuteTlineUpdate(() => setMinuteTlineVersion(v => v + 1)), []);
  useEffect(() => {
    if (!campData || timeBuckets.length === 0 || currentIndex < 1) return;
    const replayDate = String(campData.date || '');
    const holdings = simPositionsRef.current.filter(p => {
      if (p.status === 'sold') return false;
      const buyDate = String(p.buyDate || '');
      return buyDate !== '' && replayDate !== '' && buyDate < replayDate;
    });
    if (holdings.length === 0) return;
    if (replayDate) {
      ensureReplayMinuteTlineByDate([...new Set([...holdings.map(p => p.code), 'sh000688', 'sz399006'])], replayDate);
    }
    const updated = simPositionsRef.current.map(p => ({ ...p }));
    const posById = new Map(updated.map(p => [p.id, p]));
    const triggered = [];
    for (const pos of holdings) {
      const diagnosis = runSellPointDiagnosis(pos, currentBucket, replayStocksRef.current, timeBuckets, currentIndex, replayDate);
      const cur = posById.get(pos.id);
      if (!cur) continue;
      if (diagnosis.isSell) {
        if (!cur.sellAlertActive) {
          cur.sellAlertActive = true;
          triggered.push({ ...diagnosis, positionId: pos.id });
        }
      } else {
        cur.sellAlertActive = false;
      }
    }
    const changed = updated.some((p, i) => p.sellAlertActive !== simPositionsRef.current[i].sellAlertActive);
    if (changed) setSimPositions(updated);
    if (triggered.length > 0) {
      sellAlertWasPlayingRef.current = isPlayingRef.current;
      if (isPlayingRef.current) pause();
      sellPointModalRef.current = { open: true, results: triggered };
      setSellPointModal(sellPointModalRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, campData, timeBuckets, currentBucket, pause, minuteTlineVersion]);

  // 买点弹窗内可选择的模拟持仓股票列表（当前时间桶自选股）
  const availableStocks = useMemo(() => {
    const list = currentBucket?.stockChanges || [];
    return list.map(s => ({ code: s.code, name: s.name, lastPx: s.lastPx }));
  }, [currentBucket]);

  // 自选股全量列表（全部时间桶内出现过的股票去重，按出现顺序），供「个股指数对照」抽屉多选
  const watchlistOptions = useMemo(() => {
    if (!campData) return [];
    const map = new Map();
    (campData.timeBuckets || []).forEach(bucket => {
      (bucket.stockChanges || []).forEach(s => {
        if (s.code && !map.has(s.code)) map.set(s.code, { code: s.code, name: s.name });
      });
    });
    return Array.from(map.values());
  }, [campData]);

    useEffect(() => {
      window.scrollTo(0, 0);
    }, []);

  const handleStockClick = useCallback((stock) => {
    if (stock?.code) message.info(`查看 ${stock.name || stock.code}（回放模式暂不支持K线跳转）`);
  }, []);

  const handleGroupsChange = useCallback((newGroups) => setGroups(newGroups), []);

  return (
    <div className="training-camp-container">
      <TopBar
        dates={dates}
        groups={groups}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        onGroupsChange={handleGroupsChange}
        simPositionCount={simPositions.length}
        onOpenSimPositions={() => setSimPositionsModalOpen(true)}
        onReset={handleResetAll}
        watchlistOptions={watchlistOptions}
      />

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '400px', gap: 16 }}>
          <Spin size="large" />
          <span style={{ color: '#6b7280', fontSize: 13 }}>正在加载回放数据，需获取自选股历史分时，可能需要数十秒...</span>
        </div>
      ) : !campData ? (
        <Empty description="暂无回放数据，请选择日期" />
      ) : (
        <>
          <Row gutter={[24, 24]} style={{ marginBottom: 80 }}>
            <Col xs={24}>
              {/* 第一行：叠加分时观察 + 个股幅度异动 并排 */}
              <Row gutter={[12, 12]} style={{ marginBottom: 12, height: 580 }}>
                <Col xs={24} md={12} style={{ height: '100%' }}>
                  <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <MultiStockTimeLineModal
                      replayMode
                      replayStocks={replayStocks}
                      replayCurrentTimeKey={currentBucket?.timeKey}
                      replayDate={campData?.date || ''}
                      onStockClick={handleStockClick}
                      embedded
                      title="叠加分时回放"
                    />
                  </div>
                </Col>
                <Col xs={24} md={12} style={{ height: '100%', overflow: 'auto' }}>
                  <StockChangeMonitor
                    stockViewMode={stockViewMode}
                    onStockViewModeChange={setStockViewMode}
                    stockData={{ changeList: fullStockData.changeList }}
                    fullStockData={fullStockData}
                    marketRiskWarning={false}
                    reportStockData={{ topGain: [], topCoverage: [], intersection: [] }}
                    researchReportsLoading={false}
                    researchReportsLoaded={false}
                    allStockData={[]}
                    watchlistMainFund={{}}
                    onStockClick={handleStockClick}
                    onViewYanbaoDetail={() => {}}
                    themeColor={null}
                    hideFundFlow
                    viewModes={['grouped', 'merged']}
                  />
                </Col>
              </Row>

              {/* 第二行：主力资金+成交量 与 涨跌幅前十 并排 */}
              <Row gutter={[12, 12]} style={{ marginBottom: 12, height: 340 }}>
                <Col xs={24} md={17}style={{ height: '100%' }}>
                  <MainMoneyCharts
                    isMainMoneyExpanded={isMainMoneyExpanded}
                    key={chartEpoch}
                    onToggleExpand={() => setIsMainMoneyExpanded(v => !v)}
                    moneyStatus={moneyStatus}
                    volumeStatus={volumeStatus}
                    latestMoneyValue={latestMoneyValue}
                    latestVolumeValue={latestVolumeValue}
                    volumeDiffValue={volumeDiffValue}
                    onVolumeRefresh={handleVolumeRefresh}
                    themeColor={null}
                    historyData={historyData}
                    mainMoneyDetailWidth={200}
                    mainMoneyContainerRef={mainMoneyContainerRef}
                    volumeContainerRef={volumeContainerRef}
                    fillContainer
                  />
                </Col>
                <Col xs={24} md={7} style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
                  <BlockRankingCards
                    topAndBottomBlockData={topAndBottomBlockData}
                    onBlockClick={() => {}}
                    renderBlockStockList={() => <span style={{ fontSize: 12, color: '#999' }}>训练营回放模式</span>}
                    themeColor={null}
                    vertical
                    fillContainer
                  />
                </Col>
              </Row>

              {/* 原个股幅度异动位置：创业板分时 + 科创板分时 并排 */}
              <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
                <Card
                  className="index-tline-card"
                  title={<span style={{ fontSize: 13, fontWeight: 600, color: '#f5222d' }}>创业板分时回放</span>}
                  variant="borderless"
                  styles={{ body: { padding: '8px 12px', height: 'calc(100% - 40px)' } }}
                  style={{ flex: 1, height: 286, overflow: 'hidden' }}
                >
                  <div style={{ height: '100%', width: '100%' }} ref={cybTlineContainerRef} />
                </Card>
                <Card
                  className="index-tline-card"
                  title={<span style={{ fontSize: 13, fontWeight: 600, color: '#1677ff' }}>科创板分时回放</span>}
                  variant="borderless"
                  styles={{ body: { padding: '8px 12px', height: 'calc(100% - 40px)' } }}
                  style={{ flex: 1, height: 286, overflow: 'hidden' }}
                >
                  <div style={{ height: '100%', width: '100%' }} ref={kcbTlineContainerRef} />
                </Card>
              </div>
            </Col>
          </Row>
        </>
      )}

      <ReplayProgressBar
        timeBuckets={timeBuckets}
        currentIndex={currentIndex}
        isPlaying={isPlaying}
        onToggle={toggle}
        onPause={pause}
        onSeek={seek}
        onStepForward={stepForward}
        onStepBackward={stepBackward}
        currentBucket={currentBucket}
        onBuyPointDiagnosis={handleManualBuyPointDiagnosis}
      />

      <BuyPointCheckModal
        open={buyPointModal.open}
        result={buyPointModal.result}
        onClose={handleBuyPointModalClose}
        availableStocks={availableStocks}
        onAddPosition={handleAddSimPosition}
        positionCount={simPositions.length}
      />

      <SellPointCheckModal
        open={sellPointModal.open}
        results={sellPointModal.results}
        onClose={handleSellPointModalClose}
        onSellConfirmed={handleSellConfirmed}
      />

      <SimPositionsModal
        open={simPositionsModalOpen}
        onClose={() => setSimPositionsModalOpen(false)}
        positions={simPositions}
        currentBucket={currentBucket}
        onSellDiagnosis={handleManualSellDiagnosis}
        onDelete={handleDeleteSimPosition}
        onRollback={handleRollbackSimPosition}
        onReset={handleResetSimPositions}
      />
    </div>
  );
};

export default TrainingCamp;
