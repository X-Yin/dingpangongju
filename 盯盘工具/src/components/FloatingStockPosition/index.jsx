import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Spin, message, Tooltip, Tag, Drawer, InputNumber, Select } from 'antd';
import { PlusOutlined, DeleteOutlined, FolderOpenOutlined, WarningOutlined, RadarChartOutlined, CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined, RightCircleOutlined, ExperimentOutlined, ReloadOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import dayjs from 'dayjs';
import { isTradingDay, isAfterMarketClose } from '../../utils/tradingDay';
import { local_ip } from '../../constant';
import StockKLineModal from '../StockKLineModal';
import StockFundFlowModal from '../StockFundFlowModal';
import BuyPointDiagnosisDrawer from '../FloatingBuyPointDiagnosis';
import './index.scss';

const ALERT_THRESHOLD = 0.15;

// 是否已收盘（统一来自 utils/tradingDay，非交易日视为已收盘，交易日 9:15 前或 14:59 及以后）

// 是否处于午休时间（11:30 - 13:00），此时暂停买点/卖点自动诊断
const isInLunchBreak = (d) => {
  const minutes = d.hour() * 60 + d.minute();
  return minutes >= 11 * 60 + 30 && minutes < 13 * 60;
};

const formatSignedPercent = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const formatFundText = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num}亿`;
};

const FloatingStockPosition = ({ onOutflowDetected }) => {
  const navigate = useNavigate();
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newStock, setNewStock] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [watchlistStocks, setWatchlistStocks] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [fundFlowVisible, setFundFlowVisible] = useState(false);
  const [fundFlowStock, setFundFlowStock] = useState(null);
  const [changeMap, setChangeMap] = useState({});
  const [volumeDiffPercentMap, setVolumeDiffPercentMap] = useState({});
  // 卖点诊断抽屉：抽屉内每个持仓股为一张大卡片，卡片内含该股的卖点诊断条件卡片
  const [sellDrawerOpen, setSellDrawerOpen] = useState(false);
  const [sellDrawerLoading, setSellDrawerLoading] = useState(false);
  const [sellDrawerResults, setSellDrawerResults] = useState([]);
  // 持仓成本线价格输入框本地值（key: 股票代码），失焦时保存
  const [costInputs, setCostInputs] = useState({});
  const [buyPointDrawerOpen, setBuyPointDrawerOpen] = useState(false);
  // 自动买点诊断弹窗打开频控：记录最近一次因诊断通过而自动打开抽屉的时间戳（仅内存，刷新页面即重置）
  const lastAutoBuyPointOpenRef = useRef(0);
  // 自动卖点诊断弹窗打开频控：记录最近一次因诊断命中而自动打开抽屉的时间戳（仅内存，刷新页面即重置）
  const lastAutoSellOpenRef = useRef(0);
  const [pos, setPos] = useState({ x: 20, y: window.innerHeight - 300 });
  const dragRef = useRef({ dragging: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0 });
  const containerRef = useRef(null);
  const positionsRef = useRef([]);
  const backtestTriggeredRef = useRef(false);
  // 持仓数据刷新中：任一轮询/手动请求进行中时为 true，刷新按钮跟随转动，全部数据返回后恢复静止
  const [dataRefreshing, setDataRefreshing] = useState(false);
  const dataRefreshCountRef = useRef(0);

  // 持仓管理弹窗
  const [positionManageModalVisible, setPositionManageModalVisible] = useState(false);
  const [operationGuideCollapsed, setOperationGuideCollapsed] = useState(true);
  const [pipelineData, setPipelineData] = useState({});
  const [pipelineAdvancing, setPipelineAdvancing] = useState({});

  const openPositionManageModal = () => {
    setPositionManageModalVisible(true);
    fetchPipelineData();
    fetchWatchlistStocks();
  };

  const fetchWatchlistStocks = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_all_stock_data`);
      setWatchlistStocks(res.data || []);
    } catch (error) {
      console.error('获取自选股列表失败:', error);
    }
  };

  const fetchPipelineData = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_stock_pipeline`);
      setPipelineData(res.data || {});
    } catch (error) {
      console.error('获取流水线数据失败:', error);
    }
  };

  const handleAdvancePipeline = async (code, currentStage) => {
    const nextStage = currentStage + 1;
    if (nextStage > 4) return;
    setPipelineAdvancing(prev => ({ ...prev, [code]: true }));
    try {
      const res = await axios.post(`http://${local_ip}:3000/update_stock_pipeline`, { code, stage: nextStage });
      if (res.data.success) {
        const stock = positions.find((p) => p.code === code);
        const stockName = stock?.name || code;
        autoRecordOperation('pipeline', stockName, code, PIPELINE_STAGE_PERCENTS[nextStage]);
        message.success(`流水线推进至 ${PIPELINE_STAGE_LABELS[nextStage]}`);
        fetchPipelineData();
      } else {
        message.warning(res.data.message || '推进失败');
      }
    } catch (error) {
      console.error('推进流水线失败:', error);
      message.error('推进失败');
    } finally {
      setPipelineAdvancing(prev => ({ ...prev, [code]: false }));
    }
  };

  const handleReducePipeline = async (code, targetStage) => {
    setPipelineAdvancing(prev => ({ ...prev, [code]: true }));
    try {
      const res = await axios.post(`http://${local_ip}:3000/update_stock_pipeline`, { code, stage: targetStage });
      if (res.data.success) {
        const stock = positions.find((p) => p.code === code);
        const stockName = stock?.name || code;
        autoRecordOperation('pipeline', stockName, code, PIPELINE_STAGE_PERCENTS[targetStage]);
        message.success(`回滚至 ${PIPELINE_STAGE_LABELS[targetStage]}`);
        fetchPipelineData();
      } else {
        message.warning(res.data.message || '减仓失败');
      }
    } catch (error) {
      console.error('减仓失败:', error);
      message.error('减仓失败');
    } finally {
      setPipelineAdvancing(prev => ({ ...prev, [code]: false }));
    }
  };

  const PIPELINE_STAGE_LABELS = { 0: '未开始', 1: '25%', 2: '50%', 3: '75%', 4: '100%' };
  const PIPELINE_STAGE_PERCENTS = { 0: 0, 1: 25, 2: 50, 3: 75, 4: 100 };

  // 当弹窗打开且持仓变化时，刷新流水线
  useEffect(() => {
    if (positionManageModalVisible) {
      fetchPipelineData();
    }
  }, [positions.length]);

  const handleHeaderClick = () => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    openPositionManageModal();
  };

  const handleHeaderMouseDown = (e) => {
    if (e.target.closest('.fsp-action-icon')) return;
    const box = e.currentTarget.parentElement.getBoundingClientRect();
    dragRef.current = {
      dragging: true,
      moved: false,
      offsetX: e.clientX - box.left,
      offsetY: e.clientY - box.top,
      startX: e.clientX,
      startY: e.clientY,
    };
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current.dragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragRef.current.moved = true;
      }
      const x = e.clientX - dragRef.current.offsetX;
      const y = e.clientY - dragRef.current.offsetY;
      const maxX = window.innerWidth - 40;
      const maxY = window.innerHeight - 40;
      setPos({
        x: Math.max(0, Math.min(x, maxX)),
        y: Math.max(0, Math.min(y, maxY)),
      });
    };
    const handleUp = () => {
      if (dragRef.current.dragging) {
        dragRef.current.dragging = false;
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  // 刷新中计数：任一持仓数据请求开始 +1、结束 -1，归零后按钮恢复静止
  const beginDataRefresh = useCallback(() => {
    dataRefreshCountRef.current += 1;
    setDataRefreshing(true);
  }, []);
  const endDataRefresh = useCallback(() => {
    dataRefreshCountRef.current = Math.max(0, dataRefreshCountRef.current - 1);
    if (dataRefreshCountRef.current === 0) {
      setDataRefreshing(false);
    }
  }, []);

  const fetchPositions = useCallback(async () => {
    beginDataRefresh();
    try {
      setLoading(true);
      const res = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      console.log('res data', res.data);
      setPositions(res.data || []);
    } catch (error) {
      console.error('获取持仓失败:', error);
    } finally {
      setLoading(false);
      endDataRefresh();
    }
  }, [beginDataRefresh, endDataRefresh]);

  const fetchStockChanges = useCallback(async () => {
    const currentPositions = positionsRef.current;
    if (currentPositions.length === 0) return;
    beginDataRefresh();
    try {
      const results = await Promise.all(
        currentPositions.map(async (stock) => {
          try {
            const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, {
              params: { code: stock.code },
            });
            const line = res.data?.line || [];
            const latest = line[line.length - 1];
            return {
              code: stock.code,
              change: latest ? latest.change : null,
            };
          } catch (error) {
            return { code: stock.code, change: null };
          }
        })
      );
      const newChangeMap = {};
      results.forEach((item) => {
        newChangeMap[item.code] = item.change;
      });
      setChangeMap(newChangeMap);
    } catch (error) {
      console.error('获取涨幅失败:', error);
    } finally {
      endDataRefresh();
    }
  }, [beginDataRefresh, endDataRefresh]);

  const fetchVolumeDiff = useCallback(async () => {
    if (positionsRef.current.length === 0) return;
    beginDataRefresh();
    try {
      const res = await axios.get(`http://${local_ip}:3000/diff2_day_stock_tline`);
      const list = res.data || [];
      const map = {};
      list.forEach((item) => {
        if (item && item.code != null) {
          map[item.code] = item.volumeDiffPercent;
        }
      });
      setVolumeDiffPercentMap(map);
    } catch (error) {
      console.error('获取量能差失败:', error);
    } finally {
      endDataRefresh();
    }
  }, [beginDataRefresh, endDataRefresh]);

  // 手动刷新：立刻重新拉取持仓列表、涨幅与量能差数据
  const handleRefreshPositionData = useCallback(() => {
    fetchPositions();
    fetchStockChanges();
    fetchVolumeDiff();
  }, [fetchPositions, fetchStockChanges, fetchVolumeDiff]);

  // 拉取全部持仓股的卖点诊断结果（抽屉内容数据）
  const fetchAllSellDiagnosis = async () => {
    const currentPositions = positionsRef.current;
    if (currentPositions.length === 0) {
      message.warning('暂无持仓股票');
      return;
    }
    const todayStr = dayjs().format('YYYY-MM-DD');
    setSellDrawerLoading(true);
    setSellDrawerResults([]);
    try {
      const results = await Promise.all(
        currentPositions.map(async (stock) => {
          // 买入当日卖点诊断不生效，次日起生效
          if (stock.buyDate === todayStr) {
            return { code: stock.code, stockName: stock.name, buyToday: true };
          }
          try {
            const res = await axios.post(`http://${local_ip}:3000/check_single_stock_sell_point`, { code: stock.code, costPrice: stock.costPrice });
            return { ...res.data, stockName: stock.name, code: stock.code };
          } catch (error) {
            return { code: stock.code, stockName: stock.name, error: '诊断失败' };
          }
        })
      );
      setSellDrawerResults(results);
    } catch (error) {
      console.error('卖点诊断失败:', error);
      message.error('卖点诊断失败');
    } finally {
      setSellDrawerLoading(false);
    }
  };

  // 卖点诊断：点击后打开抽屉，抽屉内每个持仓股为一张大卡片
  const handleSellDiagnosis = () => {
    setSellDrawerOpen(true);
    fetchAllSellDiagnosis();
  };

  // 回测诊断：跳转到个股诊断/回测诊断页面
  const handleBacktestDiagnosis = (code, name) => {
    navigate(`/stock_diagnosis?backtest=1&code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}&days=10&autoBacktest=1`);
  };

  // 14:50 自动将所有持仓加入回测列表并跳转
  const handleAutoBacktestAll = useCallback(() => {
    const currentPositions = positionsRef.current;
    if (currentPositions.length === 0) return;
    const codes = currentPositions.map(p => p.code).join(',');
    const names = currentPositions.map(p => p.name).join(',');
    navigate(`/stock_diagnosis?backtest=1&codes=${encodeURIComponent(codes)}&names=${encodeURIComponent(names)}&autoBacktest=1&days=10`);
  }, [navigate]);

  // 14:50 自动回测定时检测
    useEffect(() => {
    const checkTime = () => {
      const now = dayjs();
      // 非交易日（周末/节假日，以交易日历为准）不触发
      if (!isTradingDay(now)) return;
      const hour = now.hour();
      const minute = now.minute();
      // 14:50 触发
      if (hour === 14 && minute === 50 && !backtestTriggeredRef.current) {
        backtestTriggeredRef.current = true;
        handleAutoBacktestAll();
      }
      // 每天重置标记（凌晨）
      if (hour === 0 && minute === 0) {
        backtestTriggeredRef.current = false;
      }
    };

    checkTime();
    const timer = setInterval(checkTime, 30000);
    return () => clearInterval(timer);
  }, [handleAutoBacktestAll]);

  useEffect(() => {
    positionsRef.current = positions;
    if (positions.length === 0) {
      setChangeMap({});
      setVolumeDiffPercentMap({});
    } else {
      fetchStockChanges();
    }
  }, [positions]);

  useEffect(() => {
    fetchPositions();
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
    schedulePoll(fetchPositions, 30000);
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchPositions]);

  useEffect(() => {
    fetchStockChanges();
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
    schedulePoll(fetchStockChanges, 1000);
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchStockChanges]);

  useEffect(() => {
    fetchVolumeDiff();
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
    schedulePoll(fetchVolumeDiff, 5000);
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchVolumeDiff]);

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
    schedulePoll(fetchStockChanges, 30000);
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchStockChanges]);

  // 买点诊断：交易日交易时间每 10 秒自动运行一次，前置检查全部通过则自动打开右侧抽屉
  const autoRunBuyPointDiagnosis = useCallback(async () => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: 1 });
      const result = res.data?.data;
      // 触发条件：其它前置检查全部通过（allPassed，与逻辑）
      if (result?.allPassed === true) {
        // 频控：自动打开抽屉间隔至少 5 分钟，避免重复弹出（仅内存时间戳，刷新页面即重置）
        const now = Date.now();
        if (now - lastAutoBuyPointOpenRef.current >= 5 * 60 * 1000) {
          lastAutoBuyPointOpenRef.current = now;
          setBuyPointDrawerOpen(true);
          // 发送买点诊断飞书卡片（前三日涨幅最大前三名由后端拉取并附在卡片中）
          try {
            await axios.post(`http://${local_ip}:3000/send_feishu_card`, { type: 'buy_point' });
          } catch (err) {
            console.error('发送买点飞书卡片失败:', err);
          }
        }
      }
    } catch (error) {
      console.error('自动买点诊断失败:', error);
    }
  }, []);

  // 买点诊断自动轮询调度：
  // 1. 强制对齐 5min 整倍数执行（9:35, 9:40, 9:45 ... 13:05, 13:10 ...）；
  //    页面在整倍数分钟的前 30 秒内加载时立即补跑一次，之后严格对齐下一个整倍数
  // 2. 开盘宽限窗口（9:30:00-9:34:59，不足 5min）：保持每 10 秒执行一次，
  //    配合后端"开盘至当前累计净流入"判定，开盘初期即可触发买点诊断
  useEffect(() => {
    const timers = [];
    let stopped = false;

    // 是否处于开盘宽限窗口（9:30:00 - 9:34:59）
    const isInOpeningGraceWindow = (d) => {
      const minutes = d.hour() * 60 + d.minute();
      return minutes >= 9 * 60 + 30 && minutes < 9 * 60 + 35;
    };

    const scheduleNext = (immediateAllowed) => {
      if (stopped) return;
      const now = dayjs();
      if (isAfterMarketClose()) return; // 收盘/周末停止轮询

      // 午休(11:30-13:00)暂停买点诊断，等到 13:00 再恢复
      if (isInLunchBreak(now)) {
        const waitMs = Math.max(dayjs().hour(13).minute(0).second(0).millisecond(0).diff(now), 0);
        const lunchTimer = setTimeout(() => {
          if (stopped || isAfterMarketClose()) return;
          autoRunBuyPointDiagnosis();
          scheduleNext(false);
        }, waitMs);
        timers.push(lunchTimer);
        return;
      }

      let delay;
      if (isInOpeningGraceWindow(now)) {
        // 开盘初期每 10 秒一次，但最后一次不越过 9:35:00（由整倍数逻辑接管）
        const openingEnd = now.hour(9).minute(35).second(0).millisecond(0);
        delay = Math.min(10 * 1000, Math.max(openingEnd.diff(now), 0));
      } else {
        const minute = now.minute();
        const second = now.second() + now.millisecond() / 1000;
        if (immediateAllowed && minute % 5 === 0 && second < 30) {
          delay = 0; // 刚进入 5min 整倍数分钟的前 30 秒，立即执行
        } else {
          const nextMinute = (Math.floor(minute / 5) + 1) * 5;
          const next = (nextMinute >= 60
            ? now.add(1, 'hour').minute(nextMinute - 60)
            : now.minute(nextMinute)
          ).second(0).millisecond(0);
          delay = Math.max(next.diff(now), 0);
        }
      }

      const timer = setTimeout(() => {
        if (stopped || isAfterMarketClose()) return;
        autoRunBuyPointDiagnosis();
        scheduleNext(false);
      }, delay);
      timers.push(timer);
    };

    scheduleNext(true);
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
  }, [autoRunBuyPointDiagnosis]);

  // 卖点诊断：交易日交易时间每 10 秒自动运行一次，任一持仓股命中卖点则自动打开抽屉（频控 5 分钟，仿买点诊断）
  const autoRunSellDiagnosis = useCallback(async () => {
    const currentPositions = positionsRef.current;
    if (currentPositions.length === 0) return;
    const todayStr = dayjs().format('YYYY-MM-DD');
    try {
      const results = await Promise.all(
        currentPositions.map(async (stock) => {
          // 买入当日卖点诊断不生效，次日起生效
          if (stock.buyDate === todayStr) {
            return { code: stock.code, stockName: stock.name, buyToday: true };
          }
          try {
            const res = await axios.post(`http://${local_ip}:3000/check_single_stock_sell_point`, { code: stock.code, costPrice: stock.costPrice });
            return { ...res.data, stockName: stock.name, code: stock.code };
          } catch (error) {
            return { code: stock.code, stockName: stock.name, error: '诊断失败' };
          }
        })
      );
      setSellDrawerResults(results);
      // 任一持仓命中卖点则自动打开抽屉，并应用频控避免反复弹出
      const hitResults = results.filter((r) => r.isSell === true);
      if (hitResults.length > 0) {
        const now = Date.now();
        if (now - lastAutoSellOpenRef.current >= 5 * 60 * 1000) {
          lastAutoSellOpenRef.current = now;
          setSellDrawerOpen(true);
          // 发送卖点诊断飞书卡片（携带触发卖点的持仓股名称及具体触发原因）
          try {
            const sellStocks = hitResults.map((r) => ({
              stockName: r.stockName,
              code: r.code,
              reasons: r.reasons || [],
              closePrice: r.detail?.closePrice,
            }));
            await axios.post(`http://${local_ip}:3000/send_feishu_card`, { type: 'sell_point', sellStocks });
          } catch (err) {
            console.error('发送卖点飞书卡片失败:', err);
          }
        }
      }
    } catch (error) {
      console.error('自动卖点诊断失败:', error);
    }
  }, []);

  useEffect(() => {
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (isAfterMarketClose()) return; // 收盘/周末停止轮询
        // 午休(11:30-13:00)暂停卖点诊断，但不终止轮询，13:00 后自动恢复
        if (!isInLunchBreak(dayjs())) {
          callback();
        }
        schedulePoll(callback, delay);
      }, delay);
      timers.push(timer);
      return timer;
    };
    schedulePoll(autoRunSellDiagnosis, 10 * 1000);
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [autoRunSellDiagnosis]);

  const autoRecordOperation = async (action, stockName, stockCode, position) => {
    const todayStr = dayjs().format('YYYY-MM-DD');
    const currentTime = dayjs().format('HH:mm');
    const newOp = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action,
      stockName,
      stockCode: stockCode || '',
      position: position !== undefined ? position : '',
      time: currentTime,
    };

    try {
      const res = await axios.get(`http://${local_ip}:3000/get_position_returns`);
      const returns = res.data || [];
      const existing = returns.find((r) => r.date === todayStr);
      let operations = existing?.operations ? [...existing.operations] : [];

      if (action === 'pipeline') {
        const idx = operations.findIndex(
          (op) => op.action === 'pipeline' && op.stockCode === stockCode && op.time === currentTime
        );
        if (idx !== -1) {
          operations[idx] = newOp;
        } else {
          operations.push(newOp);
        }
      } else {
        operations.push(newOp);
      }

      await axios.post(`http://${local_ip}:3000/save_position_return`, {
        date: todayStr,
        operations,
        totalReturn: existing?.totalReturn ?? null,
        principleViolated: existing?.principleViolated ?? false,
        score: existing?.score ?? null,
        review: existing?.review ?? '',
      });
    } catch (error) {
      console.error('自动记录操作失败:', error);
    }
  };

  const handleAdd = async () => {
    if (!newStock) {
      message.warning('请选择一只股票');
      return;
    }
    try {
      setSubmitting(true);
      const res = await axios.post(`http://${local_ip}:3000/add_stock_position`, {
        code: newStock.code,
        name: newStock.stockName,
      });
      if (res.data.success) {
        message.success('添加成功');
        autoRecordOperation('buy', newStock.stockName, newStock.code);
        setNewStock(null);
        setAdding(false);
        await fetchPositions();
      } else {
        message.warning('该股票已存在');
      }
    } catch (error) {
      console.error('添加失败:', error);
      message.error('添加失败');
    } finally {
      setSubmitting(false);
    }
  };

  const parseMainMoney = (str) => {
    if (!str) return 0;
    let s = str.trim();
    if (s.startsWith('+')) s = s.slice(1);
    const isNeg = s.startsWith('-');
    if (isNeg) s = s.slice(1);
    const num = parseFloat(s.replace(/亿|万/g, '')) || 0;
    if (s.indexOf('万') !== -1) {
      return (isNeg ? -1 : 1) * (num / 10000);
    }
    return (isNeg ? -1 : 1) * num;
  };

  const checkOutflowAndWarn = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/amount_history`);
      const data = res.data || [];
      if (data.length < 2) return;

      const sorted = [...data].sort((a, b) => a[0].localeCompare(b[0]));
      const latest = sorted[sorted.length - 1];
      const latestTime = latest[0];
      const latestSeconds = parseInt(latestTime.substring(0, 2)) * 3600 + parseInt(latestTime.substring(2, 4)) * 60 + parseInt(latestTime.substring(4, 6));

      const currentValue = parseMainMoney(latest[1]?.mainMoney);

      let targetEntry = null;
      let minDiff = Infinity;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const t = sorted[i][0];
        const sec = parseInt(t.substring(0, 2)) * 3600 + parseInt(t.substring(2, 4)) * 60 + parseInt(t.substring(4, 6));
        const diff = latestSeconds - sec;
        if (diff > 0 && diff < minDiff) {
          if (Math.abs(diff - 300) < minDiff) {
            minDiff = Math.abs(diff - 300);
            targetEntry = sorted[i];
          }
        }
      }

      if (!targetEntry) return;

      const prevValue = parseMainMoney(targetEntry[1]?.mainMoney);

      if (currentValue < prevValue) {
        onOutflowDetected?.();
      }
    } catch (error) {
      console.error('检查资金流出失败:', error);
    }
  };

  const handleDelete = async (code, name) => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/delete_stock_position`, { code });
      if (res.data.success) {
        message.success(`已删除 ${name}`);
        autoRecordOperation('sell', name, code);
        await fetchPositions();
        checkOutflowAndWarn();
      } else {
        message.warning('删除失败，未找到该股票');
      }
    } catch (error) {
      console.error('删除失败:', error);
      message.error('删除失败');
    }
  };

  // 持仓成本线价格输入框失焦时保存
  const handleCostBlur = async (stock) => {
    const raw = costInputs[stock.code];
    const prev = stock.costPrice != null && Number.isFinite(Number(stock.costPrice)) ? Number(stock.costPrice) : null;
    const num = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : null;
    // 无效输入或数值未变化：本地输入值恢复为后端存储的成本价
    if (num === null || !Number.isFinite(num) || num <= 0) {
      if (num !== null) message.warning('请输入有效的成本价');
      setCostInputs((prevInputs) => ({ ...prevInputs, [stock.code]: prev }));
      return;
    }
    if (prev !== null && Math.abs(num - prev) < 0.001) {
      setCostInputs((prevInputs) => ({ ...prevInputs, [stock.code]: prev }));
      return;
    }
    try {
      const res = await axios.post(`http://${local_ip}:3000/update_stock_position_cost`, {
        code: stock.code,
        costPrice: num,
      });
      if (res.data.success) {
        message.success(`${stock.name} 成本价已更新`);
        setCostInputs((prevInputs) => ({ ...prevInputs, [stock.code]: num }));
      } else {
        message.warning(res.data.message || '更新失败');
        setCostInputs((prevInputs) => ({ ...prevInputs, [stock.code]: prev }));
      }
    } catch (error) {
      console.error('更新成本价失败:', error);
      message.error('更新失败');
      setCostInputs((prevInputs) => ({ ...prevInputs, [stock.code]: prev }));
    } finally {
      await fetchPositions();
    }
  };

  const handleStockClick = (stock) => {
    setSelectedStock(stock);
    setModalVisible(true);
  };

  const handleFundClick = (stock) => {
    setFundFlowStock(stock);
    setFundFlowVisible(true);
  };

  const handleCancelAdd = () => {
    setAdding(false);
    setNewStock(null);
  };

  const hasPositions = positions.length > 0;

  const stopProp = (e) => e.stopPropagation();

  return (
    <div
      ref={containerRef}
      className={`floating-stock-position collapsed ${!hasPositions ? 'no-positions' : ''}`}
      style={{ left: pos.x, top: pos.y, bottom: 'auto' }}
    >
      {/* 头部标题栏 - 点击打开持仓管理弹窗，可拖拽 */}
      <div className="fsp-header" onMouseDown={handleHeaderMouseDown} onClick={handleHeaderClick}>
        <div className="fsp-title">
          <FolderOpenOutlined className="fsp-title-icon" />
          <span className="fsp-title-text">持仓</span>
        </div>
        <div className="fsp-header-actions" onClick={stopProp}>
          <Tooltip title="买点诊断">
            <ThunderboltOutlined
              className="fsp-action-icon fsp-buy-diagnosis-icon"
              onClick={(e) => { e.stopPropagation(); setBuyPointDrawerOpen(true); }}
            />
          </Tooltip>
          <Tooltip title="卖点诊断">
            <RadarChartOutlined
              className="fsp-action-icon fsp-sell-diagnosis-icon"
              onClick={(e) => { e.stopPropagation(); handleSellDiagnosis(); }}
            />
          </Tooltip>
        </div>
      </div>

      {/* 收缩状态下的股票概览列表 */}
      {hasPositions && (
        <div className="fsp-collapsed-list">
          {positions.map((stock) => {
            const change = changeMap[stock.code];
            const changeNum = change !== null && change !== undefined ? parseFloat(change) : null;
            const changeClass = changeNum === null ? 'neutral' : (changeNum > 0 ? 'up' : changeNum < 0 ? 'down' : 'neutral');
            return (
              <div key={stock.code} className="fsp-collapsed-item">
                <span className="fsp-collapsed-name" onClick={() => handleStockClick(stock)}>
                  {stock.name}
                </span>
                <span className={`fsp-collapsed-change ${changeClass}`} onClick={() => handleStockClick(stock)}>
                  {formatSignedPercent(changeNum)}
                </span>
                <Tooltip title="刷新持仓数据" placement="top">
                  <span
                    className="fsp-icon-btn fsp-backtest-icon-btn"
                    onClick={(e) => { e.stopPropagation(); handleRefreshPositionData(); }}
                  >
                    <ReloadOutlined spin={dataRefreshing} />
                  </span>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}

      <StockKLineModal
        visible={modalVisible}
        onCancel={() => setModalVisible(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.name,
        }}
      />

      <StockFundFlowModal
        visible={fundFlowVisible}
        onCancel={() => setFundFlowVisible(false)}
        code={fundFlowStock?.code}
        stockInfo={{
          name: fundFlowStock?.name,
        }}
      />

      {/* 卖点诊断抽屉：每个持仓股为一张大卡片，卡片内含该股的卖点诊断条件卡片 */}
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <RadarChartOutlined style={{ color: '#fa8c16', fontSize: 20 }} />
            <span style={{ fontSize: 16, fontWeight: 600 }}>卖点诊断</span>
            {sellDrawerResults.length > 0 && (
              <span style={{ fontSize: 12, color: '#8c8c8c' }}>{sellDrawerResults.length} 只持仓</span>
            )}
          </div>
        }
        placement="right"
        open={sellDrawerOpen}
        onClose={() => setSellDrawerOpen(false)}
        width={720}
        extra={
          <Tooltip title="刷新诊断">
            <ReloadOutlined
              style={{ color: '#1677ff', fontSize: 18, cursor: 'pointer' }}
              spin={sellDrawerLoading}
              onClick={() => fetchAllSellDiagnosis()}
            />
          </Tooltip>
        }
      >
        {sellDrawerLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
            <Spin size="large" />
          </div>
        ) : sellDrawerResults.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {sellDrawerResults.map((result, idx) => (
              // 持仓大卡片
              <div
                key={result.code || idx}
                style={{
                  background: '#fff',
                  borderRadius: 14,
                  border: `1px solid ${result.error ? '#ffd591' : result.buyToday ? '#d9d9d9' : result.isSell ? '#ffa39e' : '#91caff'}`,
                  boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
                  overflow: 'hidden',
                  flexShrink: 0,
                }}
              >
                {/* 大卡片头部：股票信息 */}
                <div
                  style={{
                    padding: '12px 16px',
                    background: result.error ? '#fff7e6' : result.buyToday ? '#fafafa' : result.isSell ? '#fff1f0' : '#f0f9ff',
                    borderBottom: `1px solid ${result.error ? '#ffd591' : result.buyToday ? '#d9d9d9' : result.isSell ? '#ffa39e' : '#91caff'}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 16, color: '#12213a' }}>{result.stockName}</span>
                  <span style={{ fontSize: 12, color: '#8c8c8c', fontFamily: 'monospace' }}>{result.code}</span>
                  {result.detail?.change !== undefined && (
                    <span style={{
                      color: result.detail.change >= 0 ? '#e11d48' : '#059669',
                      fontWeight: 700,
                      fontSize: 15,
                    }}>
                      {result.detail.change >= 0 ? '+' : ''}{result.detail.change?.toFixed(2)}%
                    </span>
                  )}
                  {result.error ? (
                    <Tag color="warning" style={{ marginLeft: 'auto' }}>诊断失败</Tag>
                  ) : result.buyToday ? (
                    <Tag color="default" style={{ marginLeft: 'auto' }}>买入当日</Tag>
                  ) : result.isSell ? (
                    <Tag color="error" style={{ marginLeft: 'auto' }}>建议卖出</Tag>
                  ) : (
                    <Tag color="processing" style={{ marginLeft: 'auto' }}>建议持有</Tag>
                  )}
                </div>

                {/* 大卡片主体：该股的卖点诊断条件卡片 */}
                <div style={{ padding: '14px 16px' }}>
                  {result.error ? (
                    <div style={{ fontSize: 13, color: '#ad8b00' }}>{result.error}</div>
                  ) : result.buyToday ? (
                    <div style={{ fontSize: 13, color: '#8c8c8c' }}>
                      买入当日卖点诊断不生效，次日起生效
                    </div>
                  ) : (
                    <>
                      {/* 条件卡片 */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {result.conditions && result.conditions.length > 0 ? result.conditions.map((cond, cidx) => (
                          <div
                            key={cidx}
                            style={{
                              borderRadius: 10,
                              padding: '10px 12px',
                              background: cond.satisfied ? '#fff1f0' : cond.pending ? '#fff7e6' : '#f6ffed',
                              border: `1px solid ${cond.satisfied ? '#ffa39e' : cond.pending ? '#ffd591' : '#b7eb8f'}`,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: cond.subConditions?.length ? 6 : 0 }}>
                              {cond.satisfied ? (
                                <CloseCircleOutlined style={{ color: '#cf1322', fontSize: 16, flexShrink: 0 }} />
                              ) : cond.pending ? (
                                <ClockCircleOutlined style={{ color: '#fa8c16', fontSize: 16, flexShrink: 0 }} />
                              ) : (
                                <CheckCircleOutlined style={{ color: '#389e0d', fontSize: 16, flexShrink: 0 }} />
                              )}
                              <span style={{ fontWeight: 600, fontSize: 13, color: cond.satisfied ? '#cf1322' : cond.pending ? '#fa8c16' : '#389e0d' }}>
                                {cond.name}
                              </span>
                              <span style={{
                                marginLeft: 'auto',
                                fontSize: 12,
                                fontWeight: 600,
                                padding: '1px 8px',
                                borderRadius: 999,
                                background: cond.satisfied ? '#ff4d4f' : cond.pending ? '#fa8c16' : '#52c41a',
                                color: '#fff',
                              }}>
                                {cond.satisfied ? '触发' : cond.pending ? `确认中 ${cond.pendingMinutes || 0}/5min` : '未触发'}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: '#595959', marginLeft: 24, marginBottom: cond.subConditions?.length ? 6 : 0 }}>
                              {cond.detail}
                            </div>
                            {cond.subConditions && cond.subConditions.length > 0 && (
                              <div style={{
                                marginLeft: 24,
                                display: 'grid',
                                gridTemplateColumns: 'repeat(2, 1fr)',
                                gap: '4px 16px',
                                fontSize: 11,
                              }}>
                                {cond.subConditions.map((sub, sidx) => (
                                  <div key={sidx} style={{ display: 'flex', gap: 4 }}>
                                    <span style={{ color: '#8c8c8c' }}>{sub.label}:</span>
                                    <span style={{ color: '#12213a', fontWeight: 600, fontFamily: '\'SF Mono\', monospace' }}>{sub.value}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )) : (
                          <div style={{ fontSize: 12, color: '#8c8c8c', textAlign: 'center', padding: '8px 0' }}>暂无诊断条件</div>
                        )}
                      </div>

                      {/* 结论卡片 */}
                      <div
                        style={{
                          borderRadius: 10,
                          padding: '12px 14px',
                          marginTop: 12,
                          background: result.isSell ? '#fff1f0' : '#f0f9ff',
                          border: `1px solid ${result.isSell ? '#ffa39e' : '#91caff'}`,
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                        }}
                      >
                        {result.isSell ? (
                          <WarningOutlined style={{ color: '#cf1322', fontSize: 18, flexShrink: 0, marginTop: 1 }} />
                        ) : (
                          <CheckCircleOutlined style={{ color: '#1677ff', fontSize: 18, flexShrink: 0, marginTop: 1 }} />
                        )}
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: result.isSell ? '#cf1322' : '#1677ff', marginBottom: 3 }}>
                            {result.isSell ? '⚠️ 建议卖出' : '✅ 建议持有'}
                          </div>
                          <div style={{ fontSize: 13, color: result.isSell ? '#a8071a' : '#0958d9', lineHeight: '20px' }}>
                            {result.conclusion}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8c8c8c' }}>
            暂无持仓股票
          </div>
        )}
      </Drawer>

      <BuyPointDiagnosisDrawer
        open={buyPointDrawerOpen}
        onClose={() => setBuyPointDrawerOpen(false)}
        onStockClick={(stock) => { handleStockClick(stock); }}
        hideTailDipCheck
      />

      {/* 持仓管理抽屉 */}
      <Drawer
        width={520}
        open={positionManageModalVisible}
        onClose={() => setPositionManageModalVisible(false)}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderOpenOutlined style={{ color: '#4f46e5', fontSize: 18 }} />
            <span style={{ fontSize: 16, fontWeight: 700 }}>持仓管理</span>
          </div>
        }
        className="position-manage-drawer"
        appendToBody={false}
      >
        <div className="pmm-content">
          {/* 左侧列：持仓管理 */}
          <div className="pmm-left">
            {/* 操作文字提示（可折叠，默认折叠） */}
            <div className="pmm-tips">
              <div
                className="pmm-tips-title"
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', userSelect: 'none' }}
                onClick={() => setOperationGuideCollapsed((v) => !v)}
              >
                <span>📋 操作指南</span>
                <span style={{ fontSize: 12, color: '#8c8c8c', fontWeight: 400 }}>
                  {operationGuideCollapsed ? '展开 ▾' : '收起 ▴'}
                </span>
              </div>
              {!operationGuideCollapsed && (
                <ol className="pmm-tips-list">
                  <li>操作两个股票，不要满仓单吊一个股票，两个股票各占一半仓位</li>
                  <li><span style={{ fontWeight: 'bold' }}>买点系统：</span>当符合买点的情况下，两个股票各自先买入 1/4 仓位。然后视尾盘的情况，再决定是否可以尾盘加仓。如果当日尾盘不跳水，那么就在尾盘再各自加 1/4 仓位，当天将全部仓位直接打满；如果当天尾盘回落，那么次日大概率竞价要低开跳水，这样就在次日竞价直接将所有持仓卖掉，这样亏的只是前一日的半仓的仓位</li>
                  <li><span style={{ fontWeight: 'bold' }}>买入注意事项：</span>正常情况下两天内全部建仓完成，只要后面趋势不走坏就继续持有，最好把持仓的股票从头做到尾，不要中间追涨杀跌来回频繁更换股票。就算手中持仓的股票中间有一天走的比较弱势，只要没有达到卖点就继续持有，等待后面轮动上涨。<span style={{ color: 'red', fontWeight: 'bold' }}>在大盘的一段上涨趋势当中，个股的涨幅其实都大差不差，有的三十个点，有的四十个点，相差不了多少，但是如果频繁更换股票，可能连二十个点都吃不到。前面两天通过让渡一部分利润来防止假突破，那么这一轮上涨中总共能吃到 20 - 30 个点左右就差不多了，其实也就是对应一个月的总收益为这个数字。</span></li>
                  <li><span style={{ fontWeight: 'bold' }}>卖点系统：</span>当某个股票触发了卖点诊断，不要一次性在当天将所有仓位全部卖掉，因为这样有可能会造成卖飞，而是要先卖掉该股票仓位的一半。然后次日看能否开盘快速拉升反包，如果能快速反包，那么甚至还需要将前一日卖掉的仓位加回来。因为这种情况说明前一天是错杀，或者是资金在主动洗盘，而非真正的出货。如果次日开盘低开并且往下直接兑现，又或者是再次触发卖点系统，这种情况才说明是真正的趋势走坏，这个时候再把剩下的仓位都卖掉</li>
                  <li><span style={{ fontWeight: 'bold' }}>卖点注意事项：</span>上涨和下跌本来就要设计成非对称的结构，这样才能做到收益无上限，风险有下限。上涨趋势中要尽可能降低自己的空仓时间，而下跌趋势中要尽可能降低自己的持仓时间。卖点系统中如果一旦某一天触发了卖点就要全部清仓，那么实际上就会降低自己的持仓时间，非常容易卖飞。所以需要将卖点分成两天，而不能一天内就全部清仓。</li>
                  <li><span style={{ fontWeight: 'bold' }}>亏损最大的情况：</span>第一，震荡期/退潮期频繁全仓试错（试错只能用小仓位试错，通过分批建仓，强制让自己避开高开低走/冲高回落的套人行情），少则亏两三个点，多则亏七八个点，前期的利润慢慢就亏完了；第二，退潮期死扛，下跌找利好，破位了也不走。</li>
                </ol>
              )}
            </div>

            {/* 持仓列表 */}
            <div className="pmm-section">
              <div className="pmm-section-title">📊 持仓列表</div>
              {loading && positions.length === 0 ? (
                <div className="fsp-loading"><Spin size="small" /></div>
              ) : positions.length === 0 ? (
                <div className="fsp-empty">暂无持仓</div>
              ) : (
                <>
                  <div className="fsp-list-header">
                    <span className="col-name">股票名称</span>
                    <span className="col-change">涨幅</span>
                    <span className="col-fund">资金净流入</span>
                    <span className="col-voldiff">量比</span>
                    <span className="col-cost">持仓成本</span>
                    <span className="col-actions">操作</span>
                  </div>
                  <div className="fsp-list">
                    {positions.map((stock) => {
                      const fund = parseFloat(stock.mainFund);
                      const fundClass = isNaN(fund) ? 'neutral' : (fund > 0 ? 'up' : fund < 0 ? 'down' : 'neutral');
                      const change = changeMap[stock.code];
                      const changeNum = change !== null && change !== undefined ? parseFloat(change) : null;
                      const changeClass = changeNum === null ? 'neutral' : (changeNum > 0 ? 'up' : changeNum < 0 ? 'down' : 'neutral');
                      const volDiffPercent = volumeDiffPercentMap[stock.code];
                      const volDiffNum = volDiffPercent !== null && volDiffPercent !== undefined ? parseFloat(volDiffPercent) : null;
                      const volDiffClass = volDiffNum === null ? 'neutral' : (volDiffNum > 0 ? 'up' : volDiffNum < 0 ? 'down' : 'neutral');
                      return (
                        <div key={stock.code} className="fsp-item">
                          <div className="fsp-item-row">
                            <div className="fsp-item-main" onClick={() => handleStockClick(stock)}>
                              <span className="fsp-item-name">
                                {stock.name}
                              </span>
                              <span className={`fsp-item-change ${changeClass}`}>
                                {formatSignedPercent(changeNum)}
                              </span>
                              <span
                                className={`fsp-item-fund ${fundClass} ${!isNaN(fund) ? 'clickable' : ''}`}
                                onClick={(e) => {
                                  if (!isNaN(fund)) {
                                    e.stopPropagation();
                                    handleFundClick(stock);
                                  }
                                }}
                              >
                                {formatFundText(fund)}
                              </span>
                              <span className={`fsp-item-voldiff ${volDiffClass}`}>
                                {formatSignedPercent(volDiffNum)}
                              </span>
                              <span className="fsp-item-cost" onClick={(e) => e.stopPropagation()}>
                                <InputNumber
                                  size="small"
                                  className="fsp-cost-input"
                                  value={costInputs[stock.code] !== undefined ? costInputs[stock.code] : (stock.costPrice != null && Number.isFinite(Number(stock.costPrice)) ? Number(stock.costPrice) : undefined)}
                                  onChange={(val) => setCostInputs((prev) => ({ ...prev, [stock.code]: val }))}
                                  onBlur={() => handleCostBlur(stock)}
                                  min={0.01}
                                  precision={2}
                                  step={0.01}
                                  placeholder="成本价"
                                  controls={false}
                                />
                              </span>
                            </div>
                            <div className="fsp-item-actions">
                              <Tooltip title="卖点分析">
                                <span
                                  className="fsp-icon-btn fsp-sell-icon-btn"
                                  onClick={(e) => { e.stopPropagation(); handleSellDiagnosis(); }}
                                >
                                  <RadarChartOutlined />
                                </span>
                              </Tooltip>
                              <Tooltip title="回测诊断">
                                <span
                                  className="fsp-icon-btn fsp-backtest-icon-btn"
                                  onClick={(e) => { e.stopPropagation(); handleBacktestDiagnosis(stock.code, stock.name); }}
                                >
                                  <ExperimentOutlined />
                                </span>
                              </Tooltip>
                              <Tooltip title="删除">
                                <DeleteOutlined
                                  className="fsp-item-delete"
                                  onClick={(e) => { e.stopPropagation(); handleDelete(stock.code, stock.name); }}
                                />
                              </Tooltip>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {adding ? (
                <div className="fsp-add-form" style={{ marginTop: 12 }}>
                  <Select
                    size="small"
                    showSearch
                    placeholder="输入股票名称搜索自选股"
                    value={newStock?.code}
                    onChange={(code) => {
                      const stock = watchlistStocks.find((s) => s.code === code);
                      setNewStock(stock || null);
                    }}
                    style={{ width: '100%' }}
                    filterOption={(input, option) =>
                      (option?.stockName || '').toLowerCase().includes(input.toLowerCase())
                    }
                    options={watchlistStocks.map((s) => ({
                      value: s.code,
                      label: `${s.stockName} (${s.code})`,
                      stockName: s.stockName,
                      code: s.code,
                    }))}
                  />
                  {newStock && (
                    <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 4 }}>
                      已选：{newStock.stockName} ({newStock.code})
                    </div>
                  )}
                  <div className="fsp-add-actions">
                    <Button size="small" type="primary" loading={submitting} onClick={handleAdd} disabled={!newStock}>
                      确认
                    </Button>
                    <Button size="small" onClick={handleCancelAdd}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="small"
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => setAdding(true)}
                  className="fsp-add-btn"
                  style={{ marginTop: 12 }}
                >
                  添加持仓
                </Button>
              )}
            </div>

            {/* 流水线 */}
            <div className="pmm-section">
              <div className="pmm-section-title">🔧 流水线</div>
              {positions.length === 0 ? (
                <div className="fsp-empty">暂无持仓，无法显示流水线</div>
              ) : (
                <div className="pmm-pipeline-list">
                  {positions.map((stock) => {
                    const pipeline = pipelineData[stock.code] || { stage: 0 };
                    const currentStage = pipeline.stage;
                    const isMaxStage = currentStage >= 4;
                    const isAdvancing = pipelineAdvancing[stock.code];
                    return (
                      <div key={stock.code} className="pmm-pipeline-item">
                        <div className="pmm-pipeline-header">
                          <span className="pmm-pipeline-stock-name">{stock.name}</span>
                          <span className="pmm-pipeline-stage-tag">
                            {PIPELINE_STAGE_LABELS[currentStage]}
                          </span>
                        </div>
                        <div className="pmm-pipeline-steps">
                          {[0, 1, 2, 3, 4].map((stage) => {
                            const isCompleted = stage <= currentStage;
                            const isCurrent = stage === currentStage;
                            return (
                              <div
                                key={stage}
                                className={`pmm-pipeline-step ${isCompleted ? 'completed' : ''} ${isCurrent ? 'current' : ''}`}
                              >
                                <div className="pmm-pipeline-dot">
                                  {isCompleted && stage > 0 ? <CheckCircleOutlined /> : null}
                                </div>
                                <div className="pmm-pipeline-label">
                                  {PIPELINE_STAGE_LABELS[stage]}
                                </div>
                                <div className="pmm-pipeline-percent">
                                  {PIPELINE_STAGE_PERCENTS[stage]}%
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="pmm-pipeline-bar">
                          <div
                            className="pmm-pipeline-bar-fill"
                            style={{ width: `${PIPELINE_STAGE_PERCENTS[currentStage]}%` }}
                          />
                        </div>
                        {!isMaxStage && (
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            icon={<RightCircleOutlined />}
                            loading={isAdvancing}
                            onClick={() => handleAdvancePipeline(stock.code, currentStage)}
                            className="pmm-pipeline-advance-btn"
                          >
                            推进至 {PIPELINE_STAGE_LABELS[currentStage + 1]}
                          </Button>
                        )}
                        {currentStage > 0 && (
                          <div className="pmm-pipeline-reduce">
                            <span className="pmm-pipeline-reduce-label">回滚至：</span>
                            {[...Array(currentStage)].map((_, i) => {
                              const stage = currentStage - 1 - i;
                              return (
                                <Button
                                  key={stage}
                                  size="small"
                                  danger
                                  loading={isAdvancing}
                                  onClick={() => handleReducePipeline(stock.code, stage)}
                                >
                                  {PIPELINE_STAGE_LABELS[stage]}
                                </Button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </Drawer>

    </div>
  );
};

export default FloatingStockPosition;
