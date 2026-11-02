// 板块强度全局预警
// 每 1 分钟轮询一次 /block_strength_intraday，当某板块强度首次向上突破 30 分时弹出全局提示。
// 弹窗内容：板块强度总分、各项分项得分与具体数据，以及该板块成分股与 key_blocks 自定义板块股票的
// 重叠股票（按涨幅从高到低），点击股票名称可打开通用 K 线图。
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Button, Modal, Spin, Table, Tag } from 'antd';
import { FireOutlined, RiseOutlined, ThunderboltOutlined, CloseOutlined } from '@ant-design/icons';
import { local_ip } from '../../constant';
import StockKLineModal from '../StockKLineModal';

const THRESHOLD = 20;
const POLL_INTERVAL = 60 * 1000;

const normalizeCode = (code) => String(code || '').trim().replace(/^(sh|sz|bj)/i, '');

const format = (value, digits = 2) => (
  Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--'
);

const gradeOf = (score) => {
  const value = Number(score) || 0;
  if (value >= 60) return { label: '极强', color: '#7c3aed', gradient: 'linear-gradient(135deg, #7c3aed, #db2777)' };
  if (value >= 45) return { label: '强势', color: '#dc2626', gradient: 'linear-gradient(135deg, #dc2626, #f97316)' };
  if (value >= THRESHOLD) return { label: '突破', color: '#ea580c', gradient: 'linear-gradient(135deg, #ea580c, #f59e0b)' };
  return { label: '一般', color: '#64748b', gradient: 'linear-gradient(135deg, #64748b, #94a3b8)' };
};

const MetricCard = ({ label, value, extra, score, maxScore, color }) => {
  const percent = maxScore > 0 ? Math.max(0, Math.min(100, (Number(score) / maxScore) * 100)) : 0;
  return (
    <div style={{
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 12,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ color: '#64748b', fontSize: 12 }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 700, color, fontSize: 15 }}>{format(score, 1)} 分</span>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>{value}</div>
      {extra && <div style={{ color: '#94a3b8', fontSize: 12 }}>{extra}</div>}
      <div style={{ height: 5, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: color, transition: 'width .4s ease' }} />
      </div>
    </div>
  );
};

const BlockStrengthAlert = () => {
  const [alerts, setAlerts] = useState([]); // 待展示的突破板块队列
  const [overlapLoading, setOverlapLoading] = useState(false);
  const [overlaps, setOverlaps] = useState([]);
  const [klineVisible, setKlineVisible] = useState(false);
  const [klineStock, setKlineStock] = useState(null);

  const previousScoresRef = useRef(new Map()); // 板块 → 上一次强度分
  const alertedRef = useRef(new Set()); // 当日已提示过的板块
  const dateRef = useRef('');
  const customBlocksRef = useRef([]);
  const pollRef = useRef(null);

  // 拉取自定义板块股票，用于计算重叠股票
  const loadCustomBlocks = useCallback(async () => {
    try {
      const resp = await axios.get(`http://${local_ip}:3000/block`, { timeout: 30 * 1000 });
      const blocks = Array.isArray(resp.data) ? resp.data : [];
      customBlocksRef.current = blocks;
    } catch (error) {
      console.warn('获取自定义板块股票失败:', error.message);
    }
  }, []);

  useEffect(() => {
    loadCustomBlocks();
  }, [loadCustomBlocks]);

  // 拉取突破板块的重叠股票：板块成分股 ∩ 自定义板块股票，按涨幅从高到低
  const loadOverlaps = useCallback(async (blockName) => {
    setOverlapLoading(true);
    setOverlaps([]);
    try {
      const resp = await axios.get(`http://${local_ip}:3000/block_volume_ratio_stocks`, {
        params: { name: blockName },
        timeout: 60 * 1000,
      });
      const stocks = Array.isArray(resp.data?.stocks) ? resp.data.stocks : [];
      const customMap = new Map();
      for (const block of customBlocksRef.current) {
        for (const stock of block.data || []) {
          const code = normalizeCode(stock.code);
          if (!code) continue;
          if (!customMap.has(code)) customMap.set(code, { blocks: [], customChange: null });
          const entry = customMap.get(code);
          entry.blocks.push(block.blockName);
          if (Number.isFinite(Number(stock.change))) entry.customChange = Number(stock.change);
        }
      }

      const list = stocks
        .map((stock) => {
          const code = normalizeCode(stock.code);
          const custom = customMap.get(code);
          if (!custom) return null;
          return {
            key: `${code}-${stock.marketCode || ''}`,
            code,
            marketCode: stock.marketCode || '',
            name: stock.name,
            price: stock.price,
            changePct: Number.isFinite(Number(stock.changePct)) ? Number(stock.changePct) : custom.customChange,
            blocks: Array.from(new Set(custom.blocks)),
          };
        })
        .filter(Boolean)
        .sort((a, b) => (Number(b.changePct) || -999) - (Number(a.changePct) || -999));

      setOverlaps(list);
    } catch (error) {
      console.warn('获取重叠股票失败:', error.message);
      setOverlaps([]);
    } finally {
      setOverlapLoading(false);
    }
  }, []);

  // 轮询强度分时数据，检测向上突破 30 分
  const poll = useCallback(async () => {
    try {
      const resp = await axios.get(`http://${local_ip}:3000/block_strength_intraday`, { timeout: 30 * 1000 });
      const data = resp.data || {};
      const points = Array.isArray(data.points) ? data.points : [];
      const latest = points[points.length - 1];
      if (!latest || !Array.isArray(latest.blocks)) return;

      const date = String(data.date || '');
      if (dateRef.current !== date) {
        // 跨交易日重置基线，避免把昨天的高分当成今天的突破
        dateRef.current = date;
        previousScoresRef.current = new Map();
        alertedRef.current = new Set();
        setAlerts([]);
      }

      const prevMap = previousScoresRef.current;
      const firstObservation = prevMap.size === 0;
      const crossed = [];

      for (const block of latest.blocks) {
        const score = Number(block.totalScore);
        if (!Number.isFinite(score)) continue;
        const prev = prevMap.get(block.name);
        const isBreakthrough = score >= THRESHOLD
          && (firstObservation ? false : (prev === undefined ? true : prev < THRESHOLD));
        if (isBreakthrough && !alertedRef.current.has(block.name)) {
          alertedRef.current.add(block.name);
          crossed.push(block);
        }
        prevMap.set(block.name, score);
      }

      if (firstObservation && prevMap.size > 0) {
        // 首次轮询只建立基线，避免启动时把已在高位的板块全部弹出
        return;
      }

      if (crossed.length > 0) {
        crossed.sort((a, b) => (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0));
        setAlerts((list) => [...list, ...crossed]);
      }
    } catch {
      // 盘中接口偶发失败时静默，等待下一次轮询
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [poll]);

  const current = alerts[0] || null;

  // 队列变化时加载当前突破板块的重叠股票
  useEffect(() => {
    if (current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadOverlaps(current.name);
    } else {
      setOverlaps([]);
    }
  }, [current, loadOverlaps]);

  const closeCurrent = () => setAlerts((list) => list.slice(1));

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 130,
      render: (value, record) => (
        <Button
          type="link"
          style={{ padding: 0, fontWeight: 600 }}
          onClick={() => {
            setKlineStock({ code: record.marketCode || record.code, name: record.name, change: record.changePct });
            setKlineVisible(true);
          }}
        >
          {value}
        </Button>
      ),
    },
    { title: '代码', dataIndex: 'code', width: 90 },
    { title: '最新价', dataIndex: 'price', width: 90, render: (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '-') },
    {
      title: '涨幅',
      dataIndex: 'changePct',
      width: 90,
      sorter: (a, b) => (Number(a.changePct) || -999) - (Number(b.changePct) || -999),
      defaultSortOrder: 'descend',
      render: (value) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return (
          <span style={{ color: num >= 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
            {num >= 0 ? '+' : ''}{num.toFixed(2)}%
          </span>
        );
      },
    },
    {
      title: '所属自定义板块',
      dataIndex: 'blocks',
      render: (value) => (
        <span>
          {(value || []).map((name) => <Tag key={name} color="blue" style={{ marginBottom: 2 }}>{name}</Tag>)}
        </span>
      ),
    },
  ];

  if (!current) {
    return (
      <>
        <StockKLineModal
          visible={klineVisible}
          onCancel={() => setKlineVisible(false)}
          stockInfo={klineStock || {}}
          code={klineStock?.code}
          zIndex={1200}
        />
      </>
    );
  }

  const grade = gradeOf(current.totalScore);
  const more = alerts.length - 1;

  return (
    <>
      <Modal
        open={Boolean(current)}
        onCancel={closeCurrent}
        footer={null}
        width={920}
        centered
        zIndex={1050}
        styles={{ body: { padding: 0 } }}
        title={null}
        closable={false}
      >
        <div style={{ background: grade.gradient, padding: '22px 28px', color: '#fff', position: 'relative' }}>
          <Button
            type="text"
            aria-label="关闭"
            onClick={closeCurrent}
            icon={<CloseOutlined />}
            style={{ position: 'absolute', right: 14, top: 12, color: 'rgba(255,255,255,.85)' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, opacity: 0.92 }}>
            <ThunderboltOutlined />
            <span>板块强度突破 {THRESHOLD} 分</span>
            {more > 0 && (
              <span style={{ marginLeft: 'auto', background: 'rgba(255,255,255,.22)', padding: '3px 10px', borderRadius: 999 }}>
                另有 {more} 个板块待提示
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 12 }}>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 1 }}>
              {current.name}
              <Tag
                style={{
                  marginLeft: 12,
                  verticalAlign: 'middle',
                  background: 'rgba(255,255,255,.22)',
                  border: '1px solid rgba(255,255,255,.35)',
                  color: '#fff',
                  fontWeight: 600,
                  borderRadius: 999,
                }}
              >
                {grade.label}
              </Tag>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: 12, opacity: 0.85 }}>强度总分</div>
              <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>{format(current.totalScore, 1)}</div>
            </div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 18, fontSize: 13, opacity: 0.95, flexWrap: 'wrap' }}>
            <span><RiseOutlined /> 平均涨幅 <b>{format(current.avgChange)}%</b></span>
            <span><FireOutlined /> 涨停 <b>{current.limitUpCount ?? 0}</b> 家</span>
            <span>成交占比 <b>{format(current.todayRatio)}%</b>（昨日 {format(current.prevDayRatio)}%）</span>
            <span>覆盖 <b>{current.matchedCount ?? 0}/{current.stockCount ?? 0}</b> 只</span>
          </div>
        </div>

        <div style={{ padding: '18px 24px 8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <MetricCard
              label="板块平均涨幅"
              value={`${format(current.avgChange)}%`}
              extra="±10% 线性映射，满分 40 分"
              score={current.avgChangeScore}
              maxScore={40}
              color="#2563eb"
            />
            <MetricCard
              label="当日涨停家数"
              value={`${current.limitUpCount ?? 0} 家`}
              extra="以 50 家为满格，满分 30 分"
              score={current.limitUpScore}
              maxScore={30}
              color="#dc2626"
            />
            <MetricCard
              label="较昨日成交占比变化"
              value={`${format(current.ratioChangePct)}%`}
              extra={`今日 ${format(current.todayRatio)}% / 昨日 ${format(current.prevDayRatio)}%${current.prevDayDate ? `（${current.prevDayDate}）` : ''}`}
              score={current.ratioScore}
              maxScore={30}
              color="#ea580c"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 8px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
              与自定义板块重叠股票
            </div>
            <Tag color="blue">{overlaps.length} 只</Tag>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>按涨幅从高到低</span>
          </div>

          {overlapLoading ? (
            <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div>
          ) : overlaps.length === 0 ? (
            <div style={{ color: '#94a3b8', padding: '12px 4px 20px' }}>暂无与 key_blocks 自定义板块重叠的股票</div>
          ) : (
            <Table
              rowKey="key"
              size="small"
              columns={columns}
              dataSource={overlaps}
              pagination={{ pageSize: 8, showSizeChanger: false }}
              style={{ marginBottom: 12 }}
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 18 }}>
            <Button type="primary" onClick={closeCurrent}>知道了</Button>
          </div>
        </div>
      </Modal>

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        stockInfo={klineStock || {}}
        code={klineStock?.code}
        zIndex={1200}
      />
    </>
  );
};

export default BlockStrengthAlert;
