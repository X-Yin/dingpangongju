// 大盘放量急拉 · 重点板块全局监控弹窗
// 触发条件：当日两市成交额较昨日同期放量 ≥ 500 亿，且
//   创业板指 1 分钟内涨幅 ≥ 0.2%，或 科创50 1 分钟内涨幅 ≥ 0.3%
// 弹窗内容：两份榜单（当前板块平均涨幅 / 提示后近 1 分钟平均涨幅变化），
// 板块行可点击展开成分股（按涨幅从高到低）。
// 板块涨幅来自 /api/key_blocks_realtime：后端不落盘、无 sleep、全部板块并行实时重算。
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Modal, Button, Spin, Empty, Tag, Typography } from 'antd';
import {
  CaretRightOutlined, FireOutlined, ReloadOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { local_ip } from '../../constant';
import { subscribeMarketSurgeAlertPush } from '../../utils/buyPointWs';
import StockKLineModal from '../StockKLineModal';

const { Text } = Typography;

// 需要实时重算涨幅的重点板块（与 constant/block_code.js 中的板块名保持一致）
const TARGET_BLOCKS = [
  '光模块', 'cpo', 'pcb', 'CCL', '光芯片', '半导体', '物理AI', 'AI 剧',
  '先进封装', '华为', 'MLCC', '电子布', '半导体材料', 'PPE树脂', '液冷',
  'cpu', 'MPO', '存储', '光刻胶', '光刻机',
];

const AMOUNT_DIFF_THRESHOLD = 500; // 亿（较昨日同期放量）
const BLOCK_REFRESH_INTERVAL = 60 * 1000; // 弹窗内板块涨幅刷新间隔（对应「近 1 分钟变化」）
const RATE_LIMIT_STORAGE_KEY = 'market_surge_alert_rate_limit';
const MAX_POPUPS_PER_DAY = 5; // 全天最多弹出次数
const MIN_POPUP_INTERVAL_MS = 10 * 60 * 1000; // 两次弹出最小间隔（10 分钟）

const fmtMinute = (m) => `${String(Math.floor(m / 100)).padStart(2, '0')}:${String(m % 100).padStart(2, '0')}`;
const fmtPct = (v, digits = 2) => {
  const num = Number(v);
  if (v == null || !Number.isFinite(num)) return '--';
  return `${num >= 0 ? '+' : ''}${num.toFixed(digits)}%`;
};
const fmtYi = (v) => {
  const num = Number(v);
  if (!Number.isFinite(num)) return '--';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)} 亿`;
};
const changeColor = (v) => (Number(v) >= 0 ? '#dc2626' : '#16a34a');

// 弹窗频控：全天最多 MAX_POPUPS_PER_DAY 次，两次间隔至少 MIN_POPUP_INTERVAL_MS。
// 记录写入 localStorage（按日期分桶），页面刷新后当日计数不重置。
const canPopup = () => {
  const now = Date.now();
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
  let times = [];
  try {
    const saved = JSON.parse(localStorage.getItem(RATE_LIMIT_STORAGE_KEY) || 'null');
    if (saved && saved.date === today) times = Array.isArray(saved.times) ? saved.times : [];
  } catch { /* 忽略损坏数据 */ }
  if (times.length >= MAX_POPUPS_PER_DAY) return false;
  const last = times.length ? Number(times[times.length - 1]) : 0;
  if (last && now - last < MIN_POPUP_INTERVAL_MS) return false;
  times.push(now);
  try {
    localStorage.setItem(RATE_LIMIT_STORAGE_KEY, JSON.stringify({ date: today, times }));
  } catch { /* 存储失败时仅限本次会话内生效 */ }
  return true;
};

const MarketSurgeAlert = () => {
  const [visible, setVisible] = useState(false);
  const [session, setSession] = useState(0); // 每次触发自增，确保重复触发时也会重新处理
  const [source, setSource] = useState('manual'); // 'ws' = 后端推送打开；'manual' = Debug 面板触发
  const [trigger, setTrigger] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [deltaMap, setDeltaMap] = useState(null); // 板块名 -> 近 1 分钟平均涨幅变化
  const [deltaHistoryTime, setDeltaHistoryTime] = useState(null); // 后端分时记录中「1 分钟前」的时间点
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [expanded, setExpanded] = useState([]);
  const [klineVisible, setKlineVisible] = useState(false);
  const [klineStock, setKlineStock] = useState(null);

  const fetchSeqRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/api/key_blocks_realtime`, {
        params: { names: TARGET_BLOCKS.join(',') },
        timeout: 120000,
      });
      if (seq !== fetchSeqRef.current) return;
      const list = Array.isArray(res.data?.data) ? res.data.data : [];
      // 近 1 分钟变化由后端直接返回：当前实时均值 − 板块分时文件中 1 分钟前的均值
      const next = new Map();
      for (const b of list) {
        if (Number.isFinite(Number(b.delta1m))) next.set(b.blockName, Number(b.delta1m));
      }
      setDeltaMap(next);
      setDeltaHistoryTime(res.data?.historyTime || null);
      setBlocks(list);
      setLastUpdated(new Date());
    } catch (e) {
      console.error('获取重点板块实时涨幅失败:', e.message);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, []);

  const triggerAlert = useCallback((info) => {
    fetchSeqRef.current += 1; // 丢弃上一轮在途请求
    setBlocks([]);
    setDeltaMap(null);
    setDeltaHistoryTime(null);
    setExpanded([]);
    setTrigger(info);
    setSource('manual');
    setVisible(true);
    setSession((s) => s + 1);
  }, []);

  // 后端推送：条件判定与板块数据请求都已完成，前端直接展示（受频控约束）
  const applyPush = useCallback((data) => {
    if (!canPopup()) return;
    const list = Array.isArray(data?.blocks) ? data.blocks : [];
    const next = new Map();
    for (const b of list) {
      if (Number.isFinite(Number(b.delta1m))) next.set(b.blockName, Number(b.delta1m));
    }
    fetchSeqRef.current += 1; // 丢弃前端在途请求
    setBlocks(list);
    setDeltaMap(next);
    setDeltaHistoryTime(data?.historyTime || null);
    setTrigger({ ...(data?.trigger || {}), manual: false });
    setExpanded([]);
    setLastUpdated(new Date());
    setSource('ws');
    setVisible(true);
    setSession((s) => s + 1);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
  }, []);

  // 订阅后端 WS 推送：命中条件且板块数据就绪后才会广播，收到即弹窗
  useEffect(() => {
    const unsubscribe = subscribeMarketSurgeAlertPush((msg) => {
      if (!msg || msg.open !== true || !msg.data) return;
      applyPush(msg.data);
    });
    return unsubscribe;
  }, [applyPush]);

  // Debug 面板手动触发（/components/DebugPanel 中 dispatch 该事件）
  useEffect(() => {
    const onTest = () => {
      triggerAlert({
        manual: true,
        amountDiff: 528.66,
        cyb: { minute: 1001, prevMinute: 1000, from: 0.35, to: 0.61, delta: 0.26 },
        kcb: { minute: 1001, prevMinute: 1000, from: 0.12, to: 0.38, delta: 0.26 },
        hitCyb: true,
        hitKcb: false,
        time: new Date(),
      });
    };
    window.addEventListener('market-surge-alert-test', onTest);
    return () => window.removeEventListener('market-surge-alert-test', onTest);
  }, [triggerAlert]);

  // 弹窗打开期间：WS 推送打开时数据已就绪，不再立即请求；Debug 手动触发才即时拉取。
  // 两种情况都每 60s 刷新一次，保持两份榜单最新。
  useEffect(() => {
    if (!visible) return undefined;
    if (source !== 'ws') fetchBlocks();
    const timer = setInterval(fetchBlocks, BLOCK_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [visible, session, source, fetchBlocks]);

  const toggleBlock = (name) => {
    setExpanded((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  };

  const currentList = [...blocks].sort((a, b) => {
    const av = Number.isFinite(Number(a.avgChange)) ? Number(a.avgChange) : -Infinity;
    const bv = Number.isFinite(Number(b.avgChange)) ? Number(b.avgChange) : -Infinity;
    return bv - av;
  });

  const deltaList = deltaMap
    ? blocks
      .map((b) => ({ ...b, delta: deltaMap.get(b.blockName) }))
      .filter((b) => Number.isFinite(Number(b.delta)))
      .sort((a, b) => Number(b.delta) - Number(a.delta))
    : [];

  const renderList = (items, mode) => (
    <div style={{ maxHeight: 430, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
      {items.map((block) => {
        const isOpen = expanded.includes(block.blockName);
        const value = mode === 'current' ? block.avgChange : block.delta;
        return (
          <div key={block.blockName} style={{ borderBottom: '1px solid #f1f5f9' }}>
            <div
              onClick={() => toggleBlock(block.blockName)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', cursor: 'pointer', userSelect: 'none',
              }}
            >
              <CaretRightOutlined
                style={{
                  fontSize: 10,
                  color: '#94a3b8',
                  transform: isOpen ? 'rotate(90deg)' : 'none',
                  transition: 'transform .2s ease',
                }}
              />
              <span style={{ flex: 1, fontWeight: 600, fontSize: 13, color: '#0f172a' }}>{block.blockName}</span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>{block.stockCount ?? block.stocks?.length ?? 0} 只</span>
              <span style={{ width: 72, textAlign: 'right', fontWeight: 700, fontSize: 13, color: changeColor(value) }}>
                {fmtPct(value)}
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '2px 10px 8px 22px' }}>
                {(block.stocks || []).map((stock) => (
                  <div
                    key={stock.code || stock.name}
                    onClick={() => {
                      setKlineStock(stock);
                      setKlineVisible(true);
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      padding: '3px 0',
                      cursor: 'pointer',
                      borderRadius: 4,
                    }}
                  >
                    <span style={{
                      flex: 1,
                      minWidth: 0,
                      color: '#334155',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {stock.name}
                    </span>
                    <span style={{ width: 78, color: '#94a3b8', flexShrink: 0 }}>{stock.code}</span>
                    <span style={{ width: 72, textAlign: 'right', fontWeight: 600, color: changeColor(stock.change), flexShrink: 0 }}>
                      {fmtPct(stock.change)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <Modal
        open={visible}
        onCancel={close}
        width={720}
        centered
        footer={[
          <Button key="ok" type="primary" onClick={close}>我知道了</Button>,
        ]}
        title={(
          <span>
            <FireOutlined style={{ color: '#dc2626', marginRight: 8 }} />
            大盘放量急拉 · 重点板块实时监控
          </span>
        )}
      >
      {trigger && (
        <div style={{
          background: 'linear-gradient(135deg, #fef2f2, #fff7ed)',
          border: '1px solid #fecaca',
          borderRadius: 12,
          padding: '14px 16px',
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 13, color: '#7f1d1d' }}>
            <span>
              <FireOutlined style={{ marginRight: 4 }} />
              两市成交额较昨日同期放量 <b style={{ color: '#dc2626' }}>{fmtYi(trigger.amountDiff)}</b>
              （阈值 {AMOUNT_DIFF_THRESHOLD} 亿）
            </span>
            {trigger.cyb && (
              <span style={{ color: trigger.hitCyb ? '#dc2626' : '#64748b' }}>
                创业板指 1 分钟 {fmtPct(trigger.cyb.delta)}
                （{fmtMinute(trigger.cyb.prevMinute)}→{fmtMinute(trigger.cyb.minute)}，阈值 0.2%）
              </span>
            )}
            {trigger.kcb && (
              <span style={{ color: trigger.hitKcb ? '#dc2626' : '#64748b' }}>
                科创50 1 分钟 {fmtPct(trigger.kcb.delta)}
                （{fmtMinute(trigger.kcb.prevMinute)}→{fmtMinute(trigger.kcb.minute)}，阈值 0.3%）
              </span>
            )}
            {trigger.manual && <Tag color="orange">调试触发</Tag>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <ThunderboltOutlined style={{ color: '#dc2626' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          板块涨幅实时重算（无缓存、全部并行），点击板块行可展开成分股（涨幅从高到低）
        </Text>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>
          {lastUpdated ? `刷新于 ${lastUpdated.toLocaleTimeString('zh-CN')}` : '加载中…'}
        </span>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={fetchBlocks}>
          刷新
        </Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>当前板块平均涨幅</span>
            <Tag color="red">{currentList.length}</Tag>
          </div>
          {loading && currentList.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center' }}>
              <Spin />
              <div style={{ marginTop: 10, color: '#94a3b8', fontSize: 12 }}>实时重算中…</div>
            </div>
          ) : currentList.length === 0 ? (
            <Empty description="暂无板块数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            renderList(currentList, 'current')
          )}
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>近 1 分钟平均涨幅变化</span>
            <Tag color="orange">{deltaList.length}</Tag>
            {deltaHistoryTime && (
              <span style={{ fontSize: 12, color: '#94a3b8' }}>
                对比分时记录 {deltaHistoryTime} → 现在
              </span>
            )}
          </div>
          {deltaList.length === 0 ? (
            <div style={{
              border: '1px dashed #e2e8f0',
              borderRadius: 10,
              padding: '36px 12px',
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: 13,
            }}>
              {loading ? <Spin size="small" /> : '暂无 1 分钟前的板块分时记录'}
              <div style={{ marginTop: 8 }}>需交易时段板块轮询（每 1 分钟记录一次）已运行满 1 分钟</div>
            </div>
          ) : (
            renderList(deltaList, 'delta')
          )}
        </div>
      </div>
      </Modal>

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        code={klineStock?.code}
        stockInfo={{ name: klineStock?.name, change: klineStock?.change }}
        zIndex={1100}
      />
    </>
  );
};

export default MarketSurgeAlert;
