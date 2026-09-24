import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Card,
  Select,
  Button,
  Checkbox,
  Space,
  Tag,
  Spin,
  message,
  Empty,
  Statistic,
  Row,
  Col,
  Tooltip,
  Modal,
  Input,
  Tabs,
} from 'antd';
import {
  PlayCircleOutlined,
  HistoryOutlined,
  ThunderboltOutlined,
  StockOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  CopyOutlined,
  SnippetsOutlined,
  DatabaseOutlined,
  SearchOutlined
} from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import { marked } from 'marked';
import { local_ip } from '../../constant';
import AiDiagnosisResult from '../../components/AiDiagnosisResult';
import DataCenter from '../data_center/index.jsx';
import './index.scss';

marked.setOptions({ breaks: true, gfm: true });

const KLineChart = ({ data, height = 220, title = '' }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!containerRef.current || !data || data.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
      },
      width: containerRef.current.clientWidth,
      height,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'string') {
            const parts = time.split('-');
            return `${parts[1]}-${parts[2]}`;
          }
          return time;
        },
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      crosshair: {
        mode: 1,
        vertLine: { width: 1, color: '#999', style: LineStyle.Dashed, labelBackgroundColor: '#999' },
        horzLine: { width: 1, color: '#999', style: LineStyle.Dashed, labelBackgroundColor: '#999' },
      },
      handleScroll: false,
      handleScale: false,
    });

    const candlestick = chart.addCandlestickSeries({
      upColor: '#f5222d',
      downColor: '#52c41a',
      borderVisible: false,
      wickUpColor: '#f5222d',
      wickDownColor: '#52c41a',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    candlestick.setData(data);

    const ma5Data = [];
    const ma10Data = [];
    const ma20Data = [];
    for (let i = 0; i < data.length; i++) {
      if (i >= 4) {
        const sum5 = data.slice(i - 4, i + 1).reduce((s, d) => s + d.close, 0);
        ma5Data.push({ time: data[i].time, value: sum5 / 5 });
      }
      if (i >= 9) {
        const sum10 = data.slice(i - 9, i + 1).reduce((s, d) => s + d.close, 0);
        ma10Data.push({ time: data[i].time, value: sum10 / 10 });
      }
      if (i >= 19) {
        const sum20 = data.slice(i - 19, i + 1).reduce((s, d) => s + d.close, 0);
        ma20Data.push({ time: data[i].time, value: sum20 / 20 });
      }
    }

    const ma5 = chart.addLineSeries({ color: '#ff9800', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    const ma10 = chart.addLineSeries({ color: '#2196f3', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    const ma20 = chart.addLineSeries({ color: '#9c27b0', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    ma5.setData(ma5Data);
    ma10.setData(ma10Data);
    ma20.setData(ma20Data);

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        chartRef.current.timeScale().fitContent();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch (e) { }
        chartRef.current = null;
      }
    };
  }, [data, height]);

  return (
    <div className="chart-container">
      <div className="chart-header">
        {title && <div className="chart-title">{title}</div>}
        <div className="chart-legend">
          <span className="legend-item"><span className="legend-dot" style={{ background: '#ff9800' }} />MA5</span>
          <span className="legend-item"><span className="legend-dot" style={{ background: '#2196f3' }} />MA10</span>
          <span className="legend-item"><span className="legend-dot" style={{ background: '#9c27b0' }} />MA20</span>
        </div>
      </div>
      <div ref={containerRef} className="chart-wrapper" />
    </div>
  );
};

const IntradayChart = ({ data, height = 240, title = '', basePrice = 0, isFundFlow = false }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !data || data.length === 0) return;

    const filteredData = data.filter(item => {
      const t = item.time;
      return !(t > '11:30' && t < '13:00');
    });

    if (filteredData.length === 0) return;

    const timeIndexMap = {};
    const chartData = filteredData.map((item, idx) => {
      timeIndexMap[idx] = item.time;
      return { time: idx, value: item.value };
    });

    const bp = basePrice;
    const lastVal = filteredData[filteredData.length - 1].value;
    const isUp = lastVal >= bp;
    const lineColor = isFundFlow
      ? (lastVal >= 0 ? '#f5222d' : '#52c41a')
      : (isUp ? '#f5222d' : '#52c41a');

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
      },
      width: containerRef.current.clientWidth,
      height,
      grid: {
        vertLines: { color: '#f0f0f0', style: LineStyle.Dotted },
        horzLines: { color: '#f0f0f0', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => timeIndexMap[time] || '',
      },
      localization: {
        timeFormatter: (time) => timeIndexMap[time] || '',
        priceFormatter: (price) => {
          if (price === undefined || price === null) return '-';
          return isFundFlow ? `${price.toFixed(1)}亿` : price.toFixed(2);
        },
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      crosshair: {
        mode: 1,
        vertLine: { width: 1, color: '#999', style: LineStyle.Dashed, labelBackgroundColor: '#999' },
        horzLine: { width: 1, color: '#999', style: LineStyle.Dashed, labelBackgroundColor: '#999' },
      },
      handleScroll: false,
      handleScale: false,
    });

    const lineSeries = chart.addLineSeries({
      color: lineColor,
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: isFundFlow ? 1 : 2,
        minMove: isFundFlow ? 0.1 : 0.01,
      },
    });

    const areaSeries = chart.addAreaSeries({
      topColor: isUp
        ? (isFundFlow ? 'rgba(245, 34, 45, 0.12)' : 'rgba(245, 34, 45, 0.15)')
        : 'rgba(82, 196, 26, 0.15)',
      bottomColor: 'rgba(255, 255, 255, 0.0)',
      lineColor: 'rgba(255,255,255,0)',
      lineWidth: 0,
    });

    lineSeries.setData(chartData);
    areaSeries.setData(chartData);

    const baseline = chart.addLineSeries({
      color: '#999',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    baseline.setData(chartData.map(d => ({ time: d.time, value: bp })));

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
      rightOffset: 0,
    });

    chartRef.current = chart;

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        chartRef.current.timeScale().fitContent();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch (e) { }
        chartRef.current = null;
      }
    };
  }, [data, height, basePrice, isFundFlow]);

  return (
    <div className="chart-container">
      {title && <div className="chart-header"><div className="chart-title">{title}</div></div>}
      <div ref={containerRef} className="chart-wrapper" />
    </div>
  );
};

const VolumeChart = ({ data, height = 240, title = '' }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !data || data.length === 0) return;

    const filteredData = data.filter(item => {
      const t = item.time;
      return !(t > '11:30' && t < '13:00');
    });

    if (filteredData.length === 0) return;

    const timeIndexMap = {};
    const chartData = filteredData.map((item, idx) => {
      timeIndexMap[idx] = item.time;
      return { time: idx, value: item.value };
    });

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
      },
      width: containerRef.current.clientWidth,
      height,
      grid: {
        vertLines: { color: '#f0f0f0', style: LineStyle.Dotted },
        horzLines: { color: '#f0f0f0', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => timeIndexMap[time] || '',
      },
      localization: {
        timeFormatter: (time) => timeIndexMap[time] || '',
        priceFormatter: (price) => {
          if (price === undefined || price === null) return '-';
          return `${price.toFixed(0)}亿`;
        },
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      crosshair: {
        mode: 1,
        vertLine: { width: 1, color: '#999', style: LineStyle.Dashed, labelBackgroundColor: '#999' },
        horzLine: { width: 1, color: '#999', style: LineStyle.Dashed, labelBackgroundColor: '#999' },
      },
      handleScroll: false,
      handleScale: false,
    });

    const lineSeries = chart.addLineSeries({
      color: '#fa8c16',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });

    const areaSeries = chart.addAreaSeries({
      topColor: 'rgba(250, 140, 22, 0.12)',
      bottomColor: 'rgba(255, 255, 255, 0.0)',
      lineColor: 'rgba(255,255,255,0)',
      lineWidth: 0,
    });

    lineSeries.setData(chartData);
    areaSeries.setData(chartData);

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
      rightOffset: 0,
    });

    chartRef.current = chart;

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        chartRef.current.timeScale().fitContent();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch (e) { }
        chartRef.current = null;
      }
    };
  }, [data, height]);

  return (
    <div className="chart-container">
      {title && <div className="chart-header"><div className="chart-title">{title}</div></div>}
      <div ref={containerRef} className="chart-wrapper" />
    </div>
  );
};

const StrategyCenter = () => {
  const [availableDates, setAvailableDates] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedStrategies, setSelectedStrategies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);

  // AI 诊断
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDiagnosisResult, setAiDiagnosisResult] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const storedContextRef = useRef(null);

  // 历史探查
  const [indexes, setIndexes] = useState([]);
  const [indexCode, setIndexCode] = useState('sz399006');
  const [historyQuestion, setHistoryQuestion] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyResult, setHistoryResult] = useState(null);
  const [historyContextLoading, setHistoryContextLoading] = useState(false);

  const fetchAvailableDates = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/backtest/dates`);
      setAvailableDates(res.data || []);
      if (res.data && res.data.length > 0) {
        setSelectedDate(res.data[0]);
      }
    } catch (error) {
      console.error('获取可回测日期失败:', error);
      message.error('获取可回测日期失败');
    }
  }, []);

  const fetchStrategies = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/backtest/strategies`);
      setStrategies(res.data || []);
      setSelectedStrategies((res.data || []).map(s => s.id));
    } catch (error) {
      console.error('获取策略列表失败:', error);
      message.error('获取策略列表失败');
    }
  }, []);

  const fetchIndexes = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/ai_prediction/indexes`);
      if (res.data?.success) {
        setIndexes(res.data.data || []);
      }
    } catch (e) {
      setIndexes([
        { code: 'sz399006', name: '创业板指' },
        { code: 'sh000688', name: '科创50' },
      ]);
    }
  }, []);

  useEffect(() => {
    fetchAvailableDates();
    fetchStrategies();
    fetchIndexes();
  }, [fetchAvailableDates, fetchStrategies, fetchIndexes]);

  const handleStrategyChange = (strategyId, checked) => {
    if (checked) {
      setSelectedStrategies(prev => [...prev, strategyId]);
    } else {
      setSelectedStrategies(prev => prev.filter(id => id !== strategyId));
    }
  };

  const handleSelectAll = () => {
    if (selectedStrategies.length === strategies.length) {
      setSelectedStrategies([]);
    } else {
      setSelectedStrategies(strategies.map(s => s.id));
    }
  };

  const runBacktest = async () => {
    if (!selectedDate) {
      message.warning('请选择回测日期');
      return;
    }
    if (selectedStrategies.length === 0) {
      message.warning('请至少选择一个策略');
      return;
    }

    setLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/backtest/run`, {
        params: {
          date: selectedDate,
          strategies: selectedStrategies.join(','),
        },
      });

      if (res.data.success === false) {
        message.warning(res.data.message || '回测失败');
        setBacktestResult(null);
      } else {
        setBacktestResult(res.data);
        message.success(`回测完成，共命中 ${res.data.totalSignalCount} 次信号`);
      }
    } catch (error) {
      console.error('回测失败:', error);
      message.error(error.response?.data?.message || '回测执行失败');
      setBacktestResult(null);
    } finally {
      setLoading(false);
    }
  };

  // AI 诊断回测
  const runAiDiagnosis = async () => {
    if (!selectedDate) {
      message.warning('请选择回测日期');
      return;
    }
    if (selectedStrategies.length === 0) {
      message.warning('请至少选择一个策略');
      return;
    }
    setAiLoading(true);
    setAiDiagnosisResult(null);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/backtest/ai_run`,
        { date: selectedDate, strategies: selectedStrategies },
        { timeout: 300000 }
      );
      if (res.data?.success === false) {
        message.warning(res.data.message || 'AI 诊断失败');
        setAiDiagnosisResult(null);
      } else if (res.data?.success) {
        setAiDiagnosisResult(res.data.data);
        message.success(`AI 独立诊断完成（${res.data.data.dateDisplay}）`);
      }
    } catch (error) {
      console.error('AI 诊断失败:', error);
      message.error('AI 诊断失败: ' + (error.response?.data?.message || error.message));
      setAiDiagnosisResult(null);
    } finally {
      setAiLoading(false);
    }
  };

  // 拷贝上下文
  const handleCopyContext = async () => {
    if (!selectedDate) {
      message.warning('请选择回测日期');
      return;
    }
    if (selectedStrategies.length === 0) {
      message.warning('请至少选择一个策略');
      return;
    }
    setContextLoading(true);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/backtest/get_context`,
        { date: selectedDate, strategies: selectedStrategies },
        { timeout: 120000 }
      );
      if (res.data?.success) {
        storedContextRef.current = res.data.data;
        await navigator.clipboard.writeText(res.data.data.prompt);
        message.success('上下文已复制到剪贴板，可粘贴到智谱对话');
      } else {
        message.error(res.data?.message || '获取上下文失败');
      }
    } catch (error) {
      message.error('获取上下文失败: ' + (error.response?.data?.message || error.message));
    } finally {
      setContextLoading(false);
    }
  };

  // 粘贴结果
  const handleOpenPaste = () => {
    if (!storedContextRef.current) {
      message.warning('请先拷贝上下文');
      return;
    }
    setPasteValue('');
    setPasteModalOpen(true);
  };

  const handleConfirmPaste = () => {
    let parsed;
    try {
      parsed = JSON.parse(pasteValue);
    } catch (e) {
      message.error('JSON 解析失败: ' + e.message);
      return;
    }
    const ctx = storedContextRef.current;
    if (!ctx) {
      message.error('上下文已失效，请重新拷贝');
      return;
    }
    setAiDiagnosisResult({
      success: true,
      date: ctx.date,
      dateDisplay: ctx.dateDisplay,
      localSignalCount: ctx.localSignalCount,
      localTriggeredIds: ctx.localTriggeredIds || [],
      backtestSummary: ctx.backtestSummary,
      diagnosis: parsed,
      model: 'zhipu-manual',
    });
    setPasteModalOpen(false);
    message.success('已应用粘贴的诊断结果');
  };

  // 历史探查
  const handleHistoryExplore = async () => {
    if (!historyQuestion.trim()) {
      message.warning('请输入要分析的问题');
      return;
    }
    setHistoryLoading(true);
    setHistoryResult(null);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/ai_prediction/history_explore`,
        { indexCode, userQuestion: historyQuestion },
        { timeout: 300000 }
      );
      if (res.data?.success) {
        setHistoryResult(res.data.data);
        message.success('历史探查完成');
      } else {
        message.error(res.data?.message || '历史探查失败');
      }
    } catch (e) {
      message.error('历史探查失败: ' + (e.response?.data?.message || e.message));
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleCopyHistoryContext = async () => {
    if (!historyQuestion.trim()) {
      message.warning('请输入要分析的问题');
      return;
    }
    setHistoryContextLoading(true);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/ai_prediction/history_explore_context`,
        { indexCode, userQuestion: historyQuestion },
        { timeout: 300000 }
      );
      if (res.data?.success) {
        await navigator.clipboard.writeText(res.data.data.prompt);
        message.success(`上下文已复制（${res.data.data.daysCount} 天分时数据），可粘贴到豆包/千问等平台`);
      } else {
        message.error(res.data?.message || '获取上下文失败');
      }
    } catch (e) {
      message.error('获取上下文失败: ' + (e.response?.data?.message || e.message));
    } finally {
      setHistoryContextLoading(false);
    }
  };

  const formatDateDisplay = (dateStr) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  const cybKlineData = backtestResult?.chartData?.kline?.cyb || [];
  const kcbKlineData = backtestResult?.chartData?.kline?.kcb || [];
  const cybTlineData = backtestResult?.chartData?.tline?.cyb || [];
  const kcbTlineData = backtestResult?.chartData?.tline?.kcb || [];
  const fundFlowData = backtestResult?.chartData?.fundFlow || [];
  const volumeData = backtestResult?.chartData?.volume || [];

  return (
    <div className="strategy-center-page">
      <div className="page-header">
        <div className="page-header-main">
          <div className="page-header-icon"><ThunderboltOutlined /></div>
          <div className="page-header-text">
            <h2>策略中心</h2>
            <div className="page-header-sub">策略回测与数据库管理</div>
          </div>
        </div>
      </div>

      <Tabs
        defaultActiveKey="backtest"
        className="sc-tabs"
        items={[
          {
            key: 'backtest',
            label: <span><ThunderboltOutlined /> 策略回测</span>,
            children: (
              <>
                <Card className="control-card" size="small">
                  <div className="control-row">
                    <div className="control-item">
                      <label className="control-label"><HistoryOutlined /> 回测日期</label>
                      <Select
                        style={{ width: 160 }}
                        placeholder="选择日期"
                        value={selectedDate}
                        onChange={setSelectedDate}
                        showSearch
                        optionFilterProp="children"
                        size="middle"
                      >
                        {availableDates.map(date => (
                          <Select.Option key={date} value={date}>{formatDateDisplay(date)}</Select.Option>
                        ))}
                      </Select>
                    </div>

                    <div className="control-item strategy-select">
                      <label className="control-label"><StockOutlined /> 选择策略</label>
                      <div className="strategy-checkboxes">
                        <Space size={[8, 4]} wrap>
                          <Button size="small" type="link" onClick={handleSelectAll} style={{ padding: 0, height: 'auto' }}>
                            {selectedStrategies.length === strategies.length ? '取消全选' : '全选'}
                          </Button>
                          {strategies.map(strategy => (
                            <Checkbox
                              key={strategy.id}
                              checked={selectedStrategies.includes(strategy.id)}
                              onChange={e => handleStrategyChange(strategy.id, e.target.checked)}
                            >
                              <Tooltip
                                title={<div style={{ whiteSpace: 'pre-line', fontSize: '12px', lineHeight: '1.6' }}>{strategy.detail || strategy.description}</div>}
                                placement="top"
                                overlayStyle={{ maxWidth: 420 }}
                              >
                                <Tag
                                  color={strategy.type === 'bullish' ? 'red' : strategy.type === 'bearish' ? 'green' : 'default'}
                                  style={{ cursor: 'help' }}
                                >
                                  {strategy.name} <QuestionCircleOutlined style={{ fontSize: '11px', opacity: 0.7 }} />
                                </Tag>
                              </Tooltip>
                            </Checkbox>
                          ))}
                        </Space>
                      </div>
                    </div>
                  </div>

                  <div className="action-row">
                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      onClick={runBacktest}
                      loading={loading}
                      disabled={aiLoading}
                      size="middle"
                      className="action-btn"
                    >
                      开始回测
                    </Button>
                    <Button
                      icon={<RobotOutlined />}
                      onClick={runAiDiagnosis}
                      loading={aiLoading}
                      disabled={loading}
                      size="middle"
                      className="action-btn ai-btn"
                    >
                      AI 回测
                    </Button>
                    <Button
                      icon={<CopyOutlined />}
                      onClick={handleCopyContext}
                      loading={contextLoading}
                      disabled={loading || aiLoading}
                      size="middle"
                      className="action-btn"
                    >
                      拷贝上下文
                    </Button>
                    <Button
                      icon={<SnippetsOutlined />}
                      onClick={handleOpenPaste}
                      disabled={loading || aiLoading}
                      size="middle"
                      className="action-btn"
                    >
                      粘贴结果
                    </Button>
                  </div>
                </Card>

                <Spin spinning={loading} description="回测中...">
                  {backtestResult ? (
                    <>
                      <Row gutter={[16, 16]} className="stats-summary">
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic
                              title="命中信号"
                              value={backtestResult.totalSignalCount}
                              valueStyle={{ color: '#1890ff', fontSize: '22px' }}
                              prefix={<ThunderboltOutlined />}
                            />
                          </Card>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic title="资金数据点" value={backtestResult.fundDataPoints} valueStyle={{ fontSize: '18px' }} />
                          </Card>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic title="成交量数据点" value={backtestResult.amountDataPoints} valueStyle={{ fontSize: '18px' }} />
                          </Card>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Card size="small">
                            <Statistic
                              title="指数数据"
                              value={backtestResult.hasIndexData ? '已加载' : '无数据'}
                              valueStyle={{ color: backtestResult.hasIndexData ? '#52c41a' : '#faad14', fontSize: '18px' }}
                            />
                          </Card>
                        </Col>
                      </Row>

                      <Row gutter={[16, 16]} className="charts-section">
                        <Col xs={24} lg={12}>
                          <Card size="small" className="chart-card">
                            <KLineChart data={cybKlineData} height={220} title="📈 创业板指 K线 (近100日)" />
                          </Card>
                        </Col>
                        <Col xs={24} lg={12}>
                          <Card size="small" className="chart-card">
                            <KLineChart data={kcbKlineData} height={220} title="📈 科创50 K线 (近100日)" />
                          </Card>
                        </Col>
                      </Row>

                      <Row gutter={[16, 16]} className="charts-section">
                        <Col xs={24} lg={12}>
                          <Card size="small" className="chart-card">
                            <IntradayChart
                              data={cybTlineData}
                              title="📊 创业板指 分时"
                              height={240}
                              basePrice={backtestResult.cybOpenPx}
                            />
                          </Card>
                        </Col>
                        <Col xs={24} lg={12}>
                          <Card size="small" className="chart-card">
                            <IntradayChart
                              data={kcbTlineData}
                              title="📊 科创50 分时"
                              height={240}
                              basePrice={backtestResult.kcbOpenPx}
                            />
                          </Card>
                        </Col>
                      </Row>

                      <Row gutter={[16, 16]} className="charts-section">
                        <Col xs={24} lg={12}>
                          <Card size="small" className="chart-card">
                            <IntradayChart
                              data={fundFlowData}
                              title="💰 主力资金净流入 (亿)"
                              height={240}
                              basePrice={0}
                              isFundFlow
                            />
                          </Card>
                        </Col>
                        <Col xs={24} lg={12}>
                          <Card size="small" className="chart-card">
                            <VolumeChart
                              data={volumeData}
                              title="📦 两市成交额 (亿)"
                              height={240}
                            />
                          </Card>
                        </Col>
                      </Row>

                      <Card
                        className="result-card"
                        title={`回测结果 - ${backtestResult.dateDisplay} 信号时间线`}
                        size="small"
                      >
                        {backtestResult.signals.length === 0 ? (
                          <Empty description="当日未命中任何策略信号" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        ) : (
                          <div className="signal-timeline">
                            {backtestResult.signals.map((timePoint, idx) => (
                              <div key={idx} className="time-point-group">
                                <div className="time-badge">{timePoint.time}</div>
                                <div className="signals-list">
                                  {timePoint.signals.map((signal, sIdx) => (
                                    <Card
                                      key={sIdx}
                                      size="small"
                                      className={`signal-card ${signal.isBullish ? 'bullish' : 'bearish'}`}
                                    >
                                      <div className="signal-title">
                                        <Tag color={signal.isBullish ? 'red' : 'green'}>
                                          {signal.isBullish ? '利好' : '利空'}
                                        </Tag>
                                        <span className="signal-name">{signal.title}</span>
                                      </div>
                                      <div className="signal-desc">{signal.description}</div>
                                    </Card>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </Card>
                    </>
                  ) : (
                    <Card className="placeholder-card">
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="选择日期和策略后点击「开始回测」查看图表和信号"
                      />
                    </Card>
                  )}
                </Spin>

                {/* AI 诊断结果 */}
                {(aiLoading || aiDiagnosisResult) && (
                  <Card
                    className="ai-diagnosis-card"
                    title={
                      <span className="ai-diagnosis-title">
                        <RobotOutlined /> AI 独立诊断
                        {aiDiagnosisResult && (
                          <span className="ai-diagnosis-meta">
                            {aiDiagnosisResult.dateDisplay} · {aiDiagnosisResult.model === 'zhipu-manual' ? '智谱(手动)' : aiDiagnosisResult.model}
                          </span>
                        )}
                      </span>
                    }
                    size="small"
                  >
                    <AiDiagnosisResult diagnosis={aiDiagnosisResult?.diagnosis} loading={aiLoading} />
                  </Card>
                )}

                <Modal
                  title="粘贴 AI 返回的 JSON 诊断结果"
                  open={pasteModalOpen}
                  onOk={handleConfirmPaste}
                  onCancel={() => setPasteModalOpen(false)}
                  okText="渲染诊断"
                  cancelText="取消"
                  width={680}
                >
                  <div style={{ marginBottom: 8, color: '#64748b', fontSize: 13 }}>
                    请将智谱对话返回的完整 JSON 粘贴到下方（包含 diagnosis / strategyDiagnosis / additionalFindings / operationAdvice / outlook 字段），系统将自动解析并与本地代码诊断结果对比渲染。
                  </div>
                  <Input.TextArea
                    value={pasteValue}
                    onChange={(e) => setPasteValue(e.target.value)}
                    rows={12}
                    placeholder='{"diagnosis":{"overallSentiment":"偏空","sentimentScore":-25,"summary":"..."},"strategyDiagnosis":[{"strategyId":"high_open_low_close","strategyName":"高开容易低走","type":"bearish","triggered":true,"triggerTime":"09:35","evidence":"...","analysis":"..."}],"additionalFindings":[...],"operationAdvice":{"action":"减仓","position":"30%","reason":"..."},"outlook":"..."}'
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </Modal>
              </>
            ),
          },
          {
            key: 'data',
            label: <span><DatabaseOutlined /> 数据库</span>,
            children: <DataCenter hideHeader />,
          },
          {
            key: 'history',
            label: <span><SearchOutlined /> 历史探查</span>,
            children: (
              <div className="history-explore">
                <div className="sc-history-controls">
                  <div className="sc-history-control-item">
                    <span className="sc-ctrl-label">指数</span>
                    <Select
                      style={{ width: 150 }}
                      value={indexCode}
                      onChange={setIndexCode}
                      options={indexes.map(i => ({ label: i.name, value: i.code }))}
                      size="middle"
                    />
                  </div>
                  <Button
                    type="primary"
                    size="middle"
                    icon={<SearchOutlined />}
                    onClick={handleHistoryExplore}
                    loading={historyLoading}
                    disabled={historyContextLoading || !historyQuestion.trim()}
                    className="sc-history-btn"
                  >
                    开始探查
                  </Button>
                  <Button
                    size="middle"
                    icon={<CopyOutlined />}
                    onClick={handleCopyHistoryContext}
                    loading={historyContextLoading}
                    disabled={historyLoading || !historyQuestion.trim()}
                  >
                    拷贝上下文
                  </Button>
                </div>
                <div className="history-input-area">
                  <Input.TextArea
                    value={historyQuestion}
                    onChange={(e) => setHistoryQuestion(e.target.value)}
                    rows={4}
                    placeholder="输入你想分析的问题，例如：分析过去100天的整体走势特征和趋势规律"
                    className="history-question-input"
                  />
                  <div className="history-presets">
                    <span className="preset-label">快捷问题：</span>
                    {[
                      '分析过去100天的整体走势特征和趋势规律',
                      '找出尾盘（14:30后）拉升超过1%的交易日',
                      '对比早盘和午盘的波动特征',
                      '哪些日期出现了V型反转？',
                      '统计各交易日开盘前30分钟的涨跌方向与全天涨跌的相关性',
                    ].map((q, i) => (
                      <span
                        key={i}
                        className="preset-chip"
                        onClick={() => setHistoryQuestion(q)}
                      >
                        {q}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="sc-history-tip">
                  获取过去 100 个交易日的 5 分钟分时数据（首次运行较慢，后续自动缓存只补缺失日期），结合你的问题交给 AI 分析。也可「拷贝上下文」后粘贴到豆包/千问等平台提问。
                </div>
                {historyLoading ? (
                  <Card className="sc-history-loading-card" bordered={false}>
                    <Spin size="large" />
                    <div className="loading-text">正在拉取分时数据并调用 AI 分析…</div>
                    <div className="loading-sub">首次运行需拉取 100 天数据，请耐心等待</div>
                  </Card>
                ) : historyResult ? (
                  <div className="history-result">
                    <Card className="sc-history-summary-card" bordered={false}>
                      <div className="summary-grid">
                        <div className="summary-item"><span className="s-label">指数</span><span className="s-value">{historyResult.indexName}</span></div>
                        <div className="summary-item"><span className="s-label">数据天数</span><span className="s-value">{historyResult.daysCount} 天</span></div>
                        <div className="summary-item"><span className="s-label">模型</span><span className="s-value">{historyResult.model}</span></div>
                      </div>
                    </Card>
                    <Card className="history-answer-card" bordered={false}>
                      <div className="history-question-display">
                        <span className="hq-label">问题</span>
                        <span className="hq-text">{historyResult.question}</span>
                      </div>
                      <div
                        className="history-answer-display markdown-body"
                        dangerouslySetInnerHTML={{ __html: marked.parse(historyResult.answer || '') }}
                      />
                    </Card>
                  </div>
                ) : (
                  <div className="sc-history-empty">
                    <div className="empty-icon"><SearchOutlined /></div>
                    <div className="empty-title">输入问题，开始历史探查</div>
                    <div className="empty-desc">基于过去 100 个交易日的 5 分钟分时数据，AI 将为你深入分析走势规律</div>
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};

export default StrategyCenter;
