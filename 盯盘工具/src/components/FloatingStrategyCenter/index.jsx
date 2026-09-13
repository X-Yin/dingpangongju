import { useState, useEffect, useRef, useCallback } from 'react';
import { Drawer, Empty, Badge, Button, Space, Tabs, Tag, Modal, Input, Select } from 'antd';
import { BulbOutlined, CheckOutlined, InfoCircleOutlined, WarningOutlined, ArrowUpOutlined, ArrowDownOutlined, RobotOutlined, CopyOutlined, SnippetsOutlined, HistoryOutlined, ThunderboltOutlined, SwapOutlined, RiseOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import AiDiagnosisResult from '../AiDiagnosisResult';
import './index.scss';

const POLL_INTERVAL = 3000;

const isAfterMarketClose = () => {
  const now = dayjs();
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) return true;
  const currentHour = now.hour();
  const currentMinute = now.minute();
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

const STRATEGY_ICONS = {
  high_open_low_close: <WarningOutlined />,
  v_shape_reversal: <ArrowUpOutlined />,
  volume_shrink_stagnation: <ArrowDownOutlined />,
  outflow_fake_rally: <WarningOutlined />,
  low_open_wash_recovery: <ArrowUpOutlined />,
  straight_rise_no_volume: <WarningOutlined />,
  volume_price_surge: <ThunderboltOutlined />,
  panic_outflow: <ArrowDownOutlined />,
  prev_day_high_open_low_close_volume: <SwapOutlined />,
  prev_day_volume_price_bottom: <SwapOutlined />,
  afternoon_large_inflow: <RiseOutlined />,
  prev_day_tail_rally: <RiseOutlined />,
  inflow_rise_volume_shrink: <WarningOutlined />,
  overnight_crisis_escape: <ThunderboltOutlined />,
  ebb_tide_direct_reversal: <ArrowDownOutlined />,
  opening_net_inflow: <RiseOutlined />,
  high_open_high_walk: <RiseOutlined />,
  tail_dip_buying: <RiseOutlined />,
  high_open_max_half_position: <WarningOutlined />,
};

const FloatingStrategyCenter = () => {
  const [signals, setSignals] = useState([]);
  const [definitions, setDefinitions] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [activeTab, setActiveTab] = useState('signals');
  const [now, setNow] = useState(new Date());
  const [pos, setPos] = useState({ x: window.innerWidth - 76, y: window.innerHeight / 2 - 28 + 100 });
  const seenIdsRef = useRef(new Set());
  const dragRef = useRef({ dragging: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0 });
  const containerRef = useRef(null);

  // AI 诊断
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDiagnosisResult, setAiDiagnosisResult] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [backtestDates, setBacktestDates] = useState([]);
  const [selectedBacktestDate, setSelectedBacktestDate] = useState(null);
  const storedContextRef = useRef(null);

  const handleMouseDown = (e) => {
    dragRef.current = {
      dragging: true,
      moved: false,
      offsetX: e.clientX - pos.x,
      offsetY: e.clientY - pos.y,
      startX: e.clientX,
      startY: e.clientY,
    };
    document.body.style.userSelect = 'none';
    if (containerRef.current) {
      containerRef.current.style.transition = 'none';
      containerRef.current.style.willChange = 'left, top';
    }
  };

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current.dragging || !containerRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragRef.current.moved = true;
      }
      const x = e.clientX - dragRef.current.offsetX;
      const y = e.clientY - dragRef.current.offsetY;
      const maxX = window.innerWidth - 72;
      const maxY = window.innerHeight - 72;
      const newX = Math.max(0, Math.min(x, maxX));
      const newY = Math.max(0, Math.min(y, maxY));
      containerRef.current.style.left = `${newX}px`;
      containerRef.current.style.top = `${newY}px`;
    };
    const handleUp = () => {
      if (!dragRef.current.dragging) return;
      dragRef.current.dragging = false;
      document.body.style.userSelect = '';
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setPos({ x: rect.left, y: rect.top });
        containerRef.current.style.transition = '';
        containerRef.current.style.willChange = '';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const handleClick = () => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    setDrawerOpen(true);
  };

  const fetchSignals = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/strategy_signals`);
      const list = Array.isArray(res.data) ? res.data : [];
      const newUnread = list.filter(g => g && g.id && !seenIdsRef.current.has(g.id) && !g.read);
      list.forEach(g => g && g.id && seenIdsRef.current.add(g.id));
      if (newUnread.length > 0 && !drawerOpen) {
        setBlinking(true);
      }
      setSignals(list);
    } catch (e) {
      console.error('获取策略信号失败:', e);
    }
  }, [drawerOpen]);

  const fetchDefinitions = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/strategy_definitions`);
      setDefinitions(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      console.error('获取策略定义失败:', e);
    }
  }, []);

  useEffect(() => {
    fetchSignals();
    fetchDefinitions();

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

    schedulePoll(fetchSignals, POLL_INTERVAL);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchSignals, fetchDefinitions]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (drawerOpen) setBlinking(false);
  }, [drawerOpen]);

  const markRead = useCallback(async (id) => {
    if (!id) return;
    try {
      await axios.post(`http://${local_ip}:3000/strategy_signals/read`, { id });
      setSignals(prev => prev.map(g => g.id === id ? { ...g, read: true } : g));
    } catch (e) {
      console.error('标记已读失败:', e);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await axios.post(`http://${local_ip}:3000/strategy_signals/read_all`);
      setSignals(prev => prev.map(g => ({ ...g, read: true })));
    } catch (e) {
      console.error('全部标记已读失败:', e);
    }
  }, []);

  // 获取可回测日期
  const fetchBacktestDates = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/backtest/dates`);
      const dates = Array.isArray(res.data) ? res.data : [];
      setBacktestDates(dates);
      if (dates.length > 0 && !selectedBacktestDate) {
        setSelectedBacktestDate(dates[0]);
      }
    } catch (e) {
      console.error('获取可回测日期失败:', e);
    }
  }, [selectedBacktestDate]);

  // AI 诊断回测
  const runAiDiagnosis = useCallback(async () => {
    if (!selectedBacktestDate) {
      return;
    }
    setAiLoading(true);
    setAiDiagnosisResult(null);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/backtest/ai_run`,
        { date: selectedBacktestDate, strategies: null },
        { timeout: 300000 }
      );
      if (res.data?.success === false) {
        setAiDiagnosisResult(null);
      } else if (res.data?.success) {
        setAiDiagnosisResult(res.data.data);
      }
    } catch (e) {
      console.error('AI 诊断失败:', e);
    } finally {
      setAiLoading(false);
    }
  }, [selectedBacktestDate]);

  // 拷贝上下文
  const handleCopyContext = useCallback(async () => {
    if (!selectedBacktestDate) return;
    setContextLoading(true);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/backtest/get_context`,
        { date: selectedBacktestDate, strategies: null },
        { timeout: 120000 }
      );
      if (res.data?.success) {
        storedContextRef.current = res.data.data;
        await navigator.clipboard.writeText(res.data.data.prompt);
      }
    } catch (e) {
      console.error('获取上下文失败:', e);
    } finally {
      setContextLoading(false);
    }
  }, [selectedBacktestDate]);

  // 粘贴结果
  const handleOpenPaste = useCallback(() => {
    if (!storedContextRef.current) return;
    setPasteValue('');
    setPasteModalOpen(true);
  }, []);

  const handleConfirmPaste = useCallback(() => {
    let parsed;
    try {
      parsed = JSON.parse(pasteValue);
    } catch (e) {
      return;
    }
    const ctx = storedContextRef.current;
    if (!ctx) return;
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
  }, [pasteValue]);

  // 抽屉打开时拉取回测日期
  useEffect(() => {
    if (drawerOpen && backtestDates.length === 0) {
      fetchBacktestDates();
    }
  }, [drawerOpen, backtestDates.length, fetchBacktestDates]);

  const sortedSignals = [...signals].sort((a, b) => (a.time < b.time ? 1 : -1));
  const unreadCount = signals.filter(g => !g.read).length;

  const getStrategyTypeColor = (isBullish) => {
    return isBullish ? '#f5222d' : '#52c41a';
  };

  const getStrategyTypeLabel = (isBullish) => {
    return isBullish ? '利好' : '利空';
  };

  const getDefTypeColor = (type) => {
    if (type === 'bullish') return '#f5222d';
    if (type === 'bearish') return '#52c41a';
    return '#8c8c8c';
  };

  const getDefTypeLabel = (type) => {
    if (type === 'bullish') return '偏利好';
    if (type === 'bearish') return '偏利空';
    return '中性';
  };

  const formatDateDisplay = (dateStr) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  const tabItems = [
    {
      key: 'signals',
      label: '策略命中',
      children: (
        <div className="fsc-signals-panel">
          {sortedSignals.length === 0 ? (
            <Empty description="暂无策略信号" />
          ) : (
            <div className="fsc-list">
              {sortedSignals.map(signal => (
                <div
                  key={signal.id}
                  className={`fsc-card ${signal.read ? 'read' : 'unread'} ${signal.isBullish ? 'bullish' : 'bearish'}`}
                >
                  <div className="fsc-card-header">
                    <div className="fsc-card-header-left">
                      <span className="fsc-card-icon" style={{ color: getStrategyTypeColor(signal.isBullish) }}>
                        {STRATEGY_ICONS[signal.strategyId] || <InfoCircleOutlined />}
                      </span>
                      <span className="fsc-card-time">{signal.time}</span>
                    </div>
                    <div className="fsc-card-header-right">
                      <Tag color={getStrategyTypeColor(signal.isBullish)} className="fsc-type-tag">
                        {getStrategyTypeLabel(signal.isBullish)}
                      </Tag>
                      {signal.read ? (
                        <span className="fsc-card-tag read-tag">已读</span>
                      ) : (
                        <Button
                          shape="circle"
                          size="small"
                          icon={<CheckOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            markRead(signal.id);
                          }}
                          className="fsc-mark-read-btn"
                        />
                      )}
                    </div>
                  </div>
                  <div className="fsc-card-content">
                    <div className="fsc-card-title">{signal.title}</div>
                    <div className="fsc-card-desc" dangerouslySetInnerHTML={{ __html: signal.description }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'definitions',
      label: 'AI策略说明',
      children: (
        <div className="fsc-definitions-panel">
          <div className="fsc-definitions-intro">
            <InfoCircleOutlined style={{ marginRight: 8, color: '#1890ff' }} />
            以下是策略中心内置的{definitions.length}个交易策略说明，系统会根据市场实时数据自动检测信号。
          </div>
          <div className="fsc-definitions-list">
            {definitions.map(def => (
              <div key={def.id} className={`fsc-def-card ${def.type}`}>
                <div className="fsc-def-header">
                  <span className="fsc-def-icon" style={{ color: getDefTypeColor(def.type) }}>
                    {STRATEGY_ICONS[def.id] || <InfoCircleOutlined />}
                  </span>
                  <span className="fsc-def-name">{def.name}</span>
                  <Tag color={getDefTypeColor(def.type)} className="fsc-def-type">
                    {getDefTypeLabel(def.type)}
                  </Tag>
                </div>
                <div className="fsc-def-desc">{def.description}</div>
                <div className="fsc-def-detail">{def.detail}</div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      key: 'ai-diagnosis',
      label: 'AI 诊断',
      children: (
        <div className="fsc-ai-panel">
          <div className="fsc-ai-controls">
            <div className="fsc-ai-control-item">
              <span className="fsc-ai-ctrl-label"><HistoryOutlined /> 回测日期</span>
              <Select
                style={{ width: 150 }}
                placeholder="选择日期"
                value={selectedBacktestDate}
                onChange={setSelectedBacktestDate}
                showSearch
                optionFilterProp="children"
                size="small"
              >
                {backtestDates.map(date => (
                  <Select.Option key={date} value={date}>{formatDateDisplay(date)}</Select.Option>
                ))}
              </Select>
            </div>
            <Button
              type="primary"
              icon={<RobotOutlined />}
              onClick={runAiDiagnosis}
              loading={aiLoading}
              disabled={contextLoading || !selectedBacktestDate}
              size="small"
              className="fsc-ai-btn"
            >
              AI 回测
            </Button>
            <Button
              icon={<CopyOutlined />}
              onClick={handleCopyContext}
              loading={contextLoading}
              disabled={aiLoading || !selectedBacktestDate}
              size="small"
              className="fsc-ai-btn"
            >
              拷贝上下文
            </Button>
            <Button
              icon={<SnippetsOutlined />}
              onClick={handleOpenPaste}
              disabled={aiLoading || !storedContextRef.current}
              size="small"
              className="fsc-ai-btn"
            >
              粘贴结果
            </Button>
          </div>
          <div className="fsc-ai-tip">
            <InfoCircleOutlined style={{ marginRight: 6, color: '#1890ff' }} />
            AI 基于原始数据独立诊断当日策略命中情况，给出命中时间线和整体诊断。也可「拷贝上下文」手动粘贴到智谱对话，再「粘贴结果」渲染。
          </div>
          <div className="fsc-ai-result">
            {aiLoading || aiDiagnosisResult ? (
              <AiDiagnosisResult diagnosis={aiDiagnosisResult?.diagnosis} loading={aiLoading} />
            ) : (
              <Empty description="选择日期后点击「AI 回测」生成诊断报告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </div>
        </div>
      ),
    },
  ];

  return (
    <>
      <div
        ref={containerRef}
        className={`floating-strategy-center ${blinking ? 'blinking' : ''}`}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        <div className="fsc-content">
          <Badge count={unreadCount} size="small" offset={[-2, 2]} overflowCount={99}>
            <div className="fsc-icon-wrap">
              <BulbOutlined className="fsc-icon" />
            </div>
          </Badge>
          <span className="fsc-label">策略</span>
        </div>
      </div>

      <Drawer
        title={<span>策略中心 <span className="fsc-live-time">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span></span>}
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={750}
        className="strategy-center-drawer"
        destroyOnClose={false}
        extra={
          <Space size="middle">
            <Button
              type="primary"
              icon={<CheckOutlined />}
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="glass-btn read-all-btn"
            >
              全部已读
            </Button>
          </Space>
        }
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
          className="fsc-tabs"
        />
      </Drawer>

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
  );
};

export default FloatingStrategyCenter;
