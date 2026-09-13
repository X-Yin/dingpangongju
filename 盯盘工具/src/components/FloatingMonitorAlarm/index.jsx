import { useState, useEffect, useRef, useCallback } from 'react';
import { Drawer, Empty, Badge, Button, Space, Spin, Divider, message } from 'antd';
import { BellOutlined, CheckOutlined, RobotOutlined, CopyOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

marked.setOptions({
  breaks: true,
  gfm: true,
});

const POLL_INTERVAL = 1000;

const isAfterMarketClose = () => {
  const now = dayjs();
  const currentHour = now.hour();
  const currentMinute = now.minute();
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

const FloatingMonitorAlarm = () => {
  const navigate = useNavigate();
  const [alarms, setAlarms] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [aiContent, setAiContent] = useState('');
  const [aiTime, setAiTime] = useState('');
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiPanelVisible, setAiPanelVisible] = useState(false);
  const [pos, setPos] = useState({ x: window.innerWidth - 76, y: window.innerHeight / 2 - 28 });
  const [now, setNow] = useState(new Date());
  const seenIdsRef = useRef(new Set());
  const dragRef = useRef({ dragging: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0 });
  const containerRef = useRef(null);

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
    // 拖动则不触发点击
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    setDrawerOpen(true);
  };

  const fetchAlarms = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/monitor_alarms`);
      const list = Array.isArray(res.data) ? res.data : [];
      // 找出"新内容"：之前未见过的 id 且未读
      const newUnread = list.filter(g => g && g.id && !seenIdsRef.current.has(g.id) && !g.read);
      list.forEach(g => g && g.id && seenIdsRef.current.add(g.id));
      if (newUnread.length > 0 && !drawerOpen) {
        setBlinking(true);
      }
      setAlarms(list);
    } catch (e) {
      console.error('获取监控报警失败:', e);
    }
  }, [drawerOpen]);

  // 1s 轮询
  useEffect(() => {
    fetchAlarms();

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

    schedulePoll(fetchAlarms, POLL_INTERVAL);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchAlarms]);

  // 实时时间每秒更新
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // 打开抽屉时停止闪烁
  useEffect(() => {
    if (drawerOpen) setBlinking(false);
  }, [drawerOpen]);

  const markRead = useCallback(async (id) => {
    if (!id) return;
    try {
      await axios.post(`http://${local_ip}:3000/monitor_alarms/read`, { id });
      setAlarms(prev => prev.map(g => g.id === id ? { ...g, read: true } : g));
    } catch (e) {
      console.error('标记已读失败:', e);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await axios.post(`http://${local_ip}:3000/monitor_alarms/read_all`);
      setAlarms(prev => prev.map(g => ({ ...g, read: true })));
    } catch (e) {
      console.error('全部标记已读失败:', e);
    }
  }, []);

  const handleAIAnalysis = async () => {
    if (alarms.length === 0 || loadingAI) return;
    
    setAiPanelVisible(true);
    setLoadingAI(true);
    setAiContent('');
    const startTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setAiTime(startTime);
    
    try {
      // 提取所有报警信息作为上下文
      const alarmContext = alarms.map(g => ({
        time: g.time,
        status: g.read ? '已读' : '未读',
        details: g.alarms.map(a => `${a.title}: ${a.description}`).join('; ')
      }));

      const response = await fetch(`http://${local_ip}:3000/api/zhipu_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: "请根据以上报警信息内容总结分析一下，提取关键市场动向，指出潜在风险或机会，并给出简短的操作建议。请使用 markdown 格式。",
          context: { monitorAlarms: alarmContext },
        }),
      });

      if (!response.ok) throw new Error('AI 分析请求失败');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let result = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              result += delta;
              setAiContent(result);
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error('AI 分析失败:', err);
      setAiContent('AI 分析失败，请稍后重试。');
    } finally {
      setLoadingAI(false);
    }
  };

  const handleCopyAlarms = () => {
    if (alarms.length === 0) {
      message.warning('暂无报警数据可复制');
      return;
    }
    
    try {
      // 1. 格式化报警明细
      let copyText = '【监控报警明细】\n';
      sortedAlarms.forEach(group => {
        copyText += `时间: ${group.time}\n`;
        group.alarms.forEach(a => {
          // 去除 HTML 标签
          const plainDesc = a.description.replace(/<[^>]+>/g, '');
          copyText += `  - ${a.title}: ${plainDesc}\n`;
        });
        copyText += '\n';
      });

      // 2. 增加 AI 总结分析行
      copyText += '根据以上报警信息，进行总结分析';
      
      navigator.clipboard.writeText(copyText).then(() => {
        message.success('报警明细及 AI 总结已复制到剪贴板');
      }).catch(err => {
        console.error('复制失败:', err);
        message.error('复制失败，请手动选择复制');
      });
    } catch (e) {
      console.error('处理失败:', e);
      message.error('数据处理失败');
    }
  };

  const handleCardClick = (group) => {
    // 获取第一个报警的路径
    const path = group.alarms?.[0]?.path;
    
    // 1. 跳转路由
    if (path) {
      navigate(path);
    }
    
    // 2. 关闭抽屉
    setDrawerOpen(false);
    
    // 3. 标记已读
    if (!group.read) {
      markRead(group.id);
    }
  };

  // 按时间倒序展示（最新在上）
  const sortedAlarms = [...alarms].sort((a, b) => (a.time < b.time ? 1 : -1));
  const unreadCount = alarms.filter(g => !g.read).length;

  return (
    <>
      <div
        ref={containerRef}
        className={`floating-monitor-alarm ${blinking ? 'blinking' : ''}`}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        <div className="fma-content">
          <Badge count={unreadCount} size="small" offset={[-2, 2]} overflowCount={99}>
            <div className="fma-icon-wrap">
              <BellOutlined className="fma-icon" />
            </div>
          </Badge>
          <span className="fma-label">监控</span>
        </div>
      </div>

      <Drawer
        title={<span>监控报警 <span className="fma-live-time">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span></span>}
        placement="right"
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setAiPanelVisible(false);
        }}
        width={aiPanelVisible ? 850 : 500}
        className="monitor-alarm-drawer"
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
            <Button
              icon={<CopyOutlined />}
              onClick={handleCopyAlarms}
              className="glass-btn copy-btn"
            >
              复制报警
            </Button>
            <Button
              icon={<RobotOutlined />}
              onClick={handleAIAnalysis}
              loading={loadingAI}
              className="glass-btn ai-btn"
            >
              AI 分析
            </Button>
          </Space>
        }
      >
        <div className="drawer-split-container">
          <div className="drawer-left-panel">
            {sortedAlarms.length === 0 ? (
              <Empty description="暂无报警" />
            ) : (
              <div className="fma-list">
                {sortedAlarms.map(group => (
                  <div
                    key={group.id}
                    className={`fma-card ${group.read ? 'read' : 'unread'}`}
                    onClick={() => handleCardClick(group)}
                  >
                    <div className="fma-card-header">
                      <span className="fma-card-time">{group.time}</span>
                      {group.read ? (
                        <span className="fma-card-tag read-tag">已读</span>
                      ) : (
                        <Button
                          shape="circle"
                          size="small"
                          icon={<CheckOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            markRead(group.id);
                          }}
                          className="fma-mark-read-btn"
                        />
                      )}
                    </div>
                    {Array.isArray(group.alarms) && group.alarms.map((a, i) => (
                      <div key={i} className="fma-card-item">
                        <div className="fma-card-title">{a.title}</div>
                        <div className="fma-card-desc" dangerouslySetInnerHTML={{ __html: a.description }} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {aiPanelVisible && (
            <div className="drawer-right-panel">
              {loadingAI && !aiContent ? (
                <div className="fma-ai-loading">
                  <Spin tip="AI 正在分析报警信息..." />
                </div>
              ) : aiContent ? (
                <div className="fma-ai-content">
                  <div className="ai-header">
                    <div className="ai-title">
                      <RobotOutlined /> AI 分析结果
                    </div>
                    {aiTime && <span className="ai-time">{aiTime}</span>}
                  </div>
                  <div 
                    className="markdown-body" 
                    dangerouslySetInnerHTML={{ __html: marked.parse(aiContent) }} 
                  />
                </div>
              ) : (
                <div className="fma-ai-empty">
                  <RobotOutlined style={{ fontSize: 40, color: '#bfbfbf', marginBottom: 16 }} />
                  <p>点击上方「AI 分析」按钮<br/>获取深度市场解读</p>
                </div>
              )}
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
};

export default FloatingMonitorAlarm;
