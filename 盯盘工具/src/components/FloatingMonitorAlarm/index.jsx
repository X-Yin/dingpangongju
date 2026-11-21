import { useState, useEffect, useRef, useCallback } from 'react';
import { Drawer, Empty, Button, Space, Spin, message } from 'antd';
import {
  BellOutlined,
  RobotOutlined,
  CopyOutlined,
  ReloadOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import { marked } from 'marked';
import axios from 'axios';
import { local_ip } from '../../constant';
import { subscribeMonitorSnapshotPush } from '../../utils/buyPointWs';
import './index.scss';

marked.setOptions({
  breaks: true,
  gfm: true,
});

// 抽屉分页：默认最近 10 次，点击「加载更多」每页再取 10 个
const PAGE_SIZE = 10;

const fmtSigned = (value, digits = 2, unit = '') => {
  const num = Number(value);
  if (value === null || value === undefined || Number.isNaN(num)) return '--';
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}${unit}`;
};

const mergeSnapshots = (list, incoming) => {
  const map = new Map();
  [...(list || []), ...(incoming || [])].forEach((item) => {
    if (item && item.id) map.set(item.id, item);
  });
  return Array.from(map.values()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
};

const sectionText = (section, unit) => {
  const fmt = (item) => `${item.name} ${fmtSigned(item.delta, 2, unit)}`;
  const up = (section?.up || []).map(fmt).join('、') || '--';
  const down = (section?.down || []).map(fmt).join('、') || '--';
  return `  前5：${up}\n  后5：${down}`;
};

const buildSnapshotText = (snapshot) => {
  const lines = [
    `【10分钟盯盘监控】${snapshot.createdAt || snapshot.time}`,
    '一、板块平均涨幅（近10min变化）',
    sectionText(snapshot.change, '%'),
    '二、板块资金净流入（近10min变化）',
    sectionText(snapshot.fund, '亿'),
    '三、板块成交量占比（近10min变化）',
    sectionText(snapshot.volume, '%'),
  ];
  return lines.join('\n');
};

// 单组排名：左列前 5 / 右列后 5
const MonitorRankSection = ({ title, hint, section, unit, dark }) => {
  const renderColumn = (items, headLabel, headClass) => (
    <div className="fma-snap-col">
      <div className={`fma-snap-col-head ${headClass}`}>{headLabel}</div>
      {(items || []).length === 0 ? (
        <div className="fma-snap-empty">暂无</div>
      ) : (
        items.map((item, index) => {
          const delta = Number(item.delta);
          return (
            <div className="fma-snap-row" key={`${item.name}-${index}`}>
              <span className="fma-snap-rank">{index + 1}</span>
              <span className="fma-snap-name" title={`${item.name} 当前 ${item.value}${unit}`}>{item.name}</span>
              <span className={`fma-snap-val ${delta >= 0 ? 'up' : 'down'}`}>{fmtSigned(item.delta, 2, unit)}</span>
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div className={`fma-snap-section ${dark ? 'is-dark' : ''}`}>
      <div className="fma-snap-title">
        {title}
        <span className="fma-snap-hint">{hint}</span>
      </div>
      <div className="fma-snap-cols">
        {renderColumn(section?.up, '前 5', 'up')}
        {renderColumn(section?.down, '后 5', 'down')}
      </div>
    </div>
  );
};

// 板块资金监控排除项：与后端保持一致，历史缓存里的记录同样过滤
const EXCLUDED_FUND_BLOCK_NAMES = new Set(['中证500']);
const isExcludedFundBlock = (name) => EXCLUDED_FUND_BLOCK_NAMES.has(String(name || '').replace(/\s/g, ''));
const filterFundSection = (section) => ({
  ...section,
  up: (section?.up || []).filter((item) => !isExcludedFundBlock(item.name)),
  down: (section?.down || []).filter((item) => !isExcludedFundBlock(item.name)),
});

const MonitorSnapshotBody = ({ snapshot, dark = false }) => {
  const fundSection = filterFundSection(snapshot.fund);
  return (
    <div className={`fma-snap-body ${dark ? 'is-dark' : ''}`}>
      <MonitorRankSection title="板块平均涨幅" hint="近 10min 变化" section={snapshot.change} unit="%" dark={dark} />
      <MonitorRankSection title="板块资金净流入" hint="近 10min 变化" section={fundSection} unit="亿" dark={dark} />
      <MonitorRankSection title="板块成交量占比" hint="近10min持续 · 较上一日" section={snapshot.volume} unit="pp" dark={dark} />
    </div>
  );
};

const FloatingMonitorAlarm = () => {
  const [snapshots, setSnapshots] = useState([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [popupSnapshot, setPopupSnapshot] = useState(null);
  const [aiContent, setAiContent] = useState('');
  const [aiTime, setAiTime] = useState('');
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiPanelVisible, setAiPanelVisible] = useState(false);
  const [pos, setPos] = useState({ x: window.innerWidth - 76, y: window.innerHeight / 2 - 28 });
  const [now, setNow] = useState(new Date());
  const knownIdsRef = useRef(new Set());
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
    setBlinking(false);
    setPopupSnapshot(null);
  };

  const fetchSnapshots = useCallback(async ({ offset = 0, append = false } = {}) => {
    if (append) setLoadingMore(true);
    else setListLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/monitor_snapshots`, {
        params: { limit: PAGE_SIZE, offset },
      });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      setTotal(Number(res.data?.total) || 0);
      items.forEach((item) => item?.id && knownIdsRef.current.add(item.id));
      setSnapshots((prev) => (append ? mergeSnapshots(prev, items) : mergeSnapshots([], items)));
    } catch (e) {
      console.error('获取监控快照失败:', e);
      if (!append) message.error('获取监控快照失败');
    } finally {
      if (append) setLoadingMore(false);
      else setListLoading(false);
    }
  }, []);

  // 首次挂载加载最近 10 次
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSnapshots();
  }, [fetchSnapshots]);

  // 后端每 10 分钟推送一次：写入列表，并右下角弹出监控卡片
  useEffect(() => {
    const unsubscribe = subscribeMonitorSnapshotPush((msg) => {
      const snapshot = msg?.data;
      if (!snapshot || !snapshot.id) return;
      const isNew = !knownIdsRef.current.has(snapshot.id);
      knownIdsRef.current.add(snapshot.id);
      setSnapshots((prev) => mergeSnapshots(prev, [snapshot]));
      if (isNew) setTotal((prev) => prev + 1);
      // 仅实时推送（open:true）弹卡；晚挂载补发 / 对账回放不弹
      if (msg.open === true) {
        setPopupSnapshot(snapshot);
        setBlinking(true);
      }
    });
    return unsubscribe;
  }, []);

  // 实时时间每秒更新
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const handleAIAnalysis = async () => {
    if (snapshots.length === 0 || loadingAI) return;

    setAiPanelVisible(true);
    setLoadingAI(true);
    setAiContent('');
    setAiTime(new Date().toLocaleTimeString('zh-CN', { hour12: false }));

    try {
      const monitorContext = snapshots.map((s) => ({
        time: s.createdAt || s.time,
        change: { up: s.change?.up || [], down: s.change?.down || [] },
        fund: { up: s.fund?.up || [], down: s.fund?.down || [] },
        volume: { up: s.volume?.up || [], down: s.volume?.down || [] },
      }));

      const response = await fetch(`http://${local_ip}:3000/api/zhipu_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '请根据以上每 10 分钟监控快照，总结板块平均涨幅、资金净流入、成交量占比的变化趋势，指出资金/量能共振的主线板块与潜在风险，并给出简短的操作建议。请使用 markdown 格式。',
          context: { monitorSnapshots: monitorContext },
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
          } catch {
            /* 忽略非 JSON 行 */
          }
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
    if (snapshots.length === 0) {
      message.warning('暂无监控数据可复制');
      return;
    }

    try {
      const copyText = `${snapshots.map(buildSnapshotText).join('\n\n')}\n\n根据以上监控数据，进行总结分析`;
      navigator.clipboard.writeText(copyText).then(() => {
        message.success('监控数据及 AI 总结已复制到剪贴板');
      }).catch((err) => {
        console.error('复制失败:', err);
        message.error('复制失败，请手动选择复制');
      });
    } catch (e) {
      console.error('处理失败:', e);
      message.error('数据处理失败');
    }
  };

  const sortedSnapshots = [...snapshots].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const hasMore = sortedSnapshots.length < total;

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
          <div className="fma-icon-wrap">
            <BellOutlined className="fma-icon" />
          </div>
          <span className="fma-label">监控</span>
        </div>
      </div>

      {/* 全局监控提示卡片：样式复用全局买点卡片（蓝紫玻璃渐变），收到推送时右下角弹出 */}
      {popupSnapshot && (
        <div className="fma-monitor-pop">
          <div className="gda-card gda-buy fma-monitor-card">
            <div className="gda-header">
              <span className="gda-header-icon buy">
                <BellOutlined />
              </span>
              <span className="gda-title">10分钟盯盘监控</span>
              {popupSnapshot.mock && <span className="gda-mode-badge">MOCK</span>}
              <span
                className="gda-close"
                onClick={() => {
                  setPopupSnapshot(null);
                  setBlinking(false);
                }}
              >
                <CloseOutlined />
              </span>
            </div>
            <div className="gda-body">
              <MonitorSnapshotBody snapshot={popupSnapshot} dark />
            </div>
            <div className="gda-footer">
              监控时间 {popupSnapshot.createdAt || popupSnapshot.time} · 每 10 分钟自动推送
            </div>
          </div>
        </div>
      )}

      <Drawer
        title={<span>10分钟盯盘监控 <span className="fma-live-time">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span></span>}
        placement="right"
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setAiPanelVisible(false);
        }}
        width={aiPanelVisible ? 900 : 520}
        className="monitor-alarm-drawer"
        destroyOnClose={false}
        extra={
          <Space size="middle">
            <Button
              icon={<ReloadOutlined />}
              onClick={() => fetchSnapshots()}
              loading={listLoading}
              className="glass-btn"
            >
              刷新
            </Button>
            <Button
              icon={<CopyOutlined />}
              onClick={handleCopyAlarms}
              className="glass-btn copy-btn"
            >
              复制监控
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
            {listLoading && sortedSnapshots.length === 0 ? (
              <div className="fma-list-loading"><Spin tip="加载监控数据..." /></div>
            ) : sortedSnapshots.length === 0 ? (
              <Empty description="暂无监控数据" />
            ) : (
              <div className="fma-list">
                {sortedSnapshots.map((snapshot) => (
                  <div key={snapshot.id} className={`fma-snap-card ${snapshot.mock ? 'is-mock' : ''}`}>
                    <div className="fma-snap-card-head">
                      <span className="fma-snap-card-time">
                        <ClockCircleOutlined /> {snapshot.time}
                      </span>
                      <span className="fma-snap-card-date">{snapshot.date}</span>
                      {snapshot.mock && <span className="fma-snap-mock">MOCK</span>}
                    </div>
                    <MonitorSnapshotBody snapshot={snapshot} />
                  </div>
                ))}
                {hasMore ? (
                  <Button
                    block
                    icon={<ArrowDownOutlined />}
                    loading={loadingMore}
                    onClick={() => fetchSnapshots({ offset: sortedSnapshots.length, append: true })}
                    className="fma-load-more"
                  >
                    加载更多（已展示 {sortedSnapshots.length}/{total}）
                  </Button>
                ) : (
                  <div className="fma-snap-end">已加载全部 {total} 条监控</div>
                )}
              </div>
            )}
          </div>

          {aiPanelVisible && (
            <div className="drawer-right-panel">
              {loadingAI && !aiContent ? (
                <div className="fma-ai-loading">
                  <Spin tip="AI 正在分析监控数据..." />
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
                  <p>点击上方「AI 分析」按钮<br/>获取监控数据深度解读</p>
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
