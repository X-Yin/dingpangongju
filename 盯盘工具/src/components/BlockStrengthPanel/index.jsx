// 板块强度图表（日线 / 分时共用）
// mode='daily'     : 读取 /block_strength_history，绘制每个板块的日线强度折线
// mode='intraday'  : 读取 /block_strength_intraday，绘制每个板块的强度分时折线（与板块成交量占比同步）
// 支持关键字搜索、板块多选、点击标题查看成分股列表（点击股票可打开通用 K 线图）
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Button, Card, Empty, Input, Modal, Select, Spin, Table, Tag, Tooltip } from 'antd';
import { ReloadOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
  Filler,
  Legend,
} from 'chart.js';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLineModal from '../StockKLineModal';

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, ChartTooltip, Filler, Legend);

const COLORS = [
  '#2563eb', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
  '#f43f5e', '#14b8a6', '#a855f7', '#eab308', '#22c55e',
  '#3b82f6', '#e11d48', '#0ea5e9', '#d97706', '#7c3aed',
  '#db2777', '#0891b2', '#65a30d', '#4f46e5', '#be123c',
  '#0d9488', '#9333ea', '#ca8a04', '#15803d', '#1d4ed8',
  '#9f1239', '#0369a1', '#b45309', '#6d28d9',
];

const formatTime = (time) => {
  const str = String(time || '');
  if (str.length < 4) return str;
  return `${str.slice(0, 2)}:${str.slice(2, 4)}`;
};

const formatScore = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '--');

const scoreColor = (score) => {
  const value = Number(score);
  if (!Number.isFinite(value)) return '#94a3b8';
  if (value >= 50) return '#dc2626';
  if (value >= 30) return '#ea580c';
  if (value >= 10) return '#d97706';
  return '#64748b';
};

const BlockStrengthPanel = ({ mode = 'daily', showAll = false, groupByDelta = false }) => {
  const isDaily = mode === 'daily';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dailyData, setDailyData] = useState({ blocks: [], updatedAt: null });
  const [intradayData, setIntradayData] = useState({ date: '', updatedAt: '', points: [] });
  const [refreshing, setRefreshing] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [selected, setSelected] = useState(null); // null = 默认展示最新强度最高的前 12 个板块
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [stockModalBlock, setStockModalBlock] = useState('');
  const [stockList, setStockList] = useState([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);
  const [klineStock, setKlineStock] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      if (isDaily) {
        const resp = await axios.get(`http://${local_ip}:3000/block_strength_history`);
        const data = resp.data || {};
        setDailyData({
          blocks: Array.isArray(data.blocks) ? data.blocks : [],
          updatedAt: data.updatedAt || null,
        });
      } else {
        const resp = await axios.get(`http://${local_ip}:3000/block_strength_intraday`);
        const data = resp.data || {};
        setIntradayData({
          date: data.date || '',
          updatedAt: data.updatedAt || '',
          points: Array.isArray(data.points) ? data.points : [],
        });
      }
      setError(null);
    } catch (err) {
      console.error('获取板块强度数据失败:', err);
      setError('获取板块强度数据失败，请检查后端服务');
    }
  }, [isDaily]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await fetchData();
    setLoading(false);
  }, [fetchData]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (isDaily) {
        await fetchData();
      } else {
        await axios.get(`http://${local_ip}:3000/refresh_block_strength_intraday`, { timeout: 5 * 60 * 1000 });
        await fetchData();
      }
      setError(null);
    } catch (err) {
      console.error('刷新板块强度失败:', err);
      setError('刷新板块强度失败，请检查后端服务');
    } finally {
      setRefreshing(false);
    }
  }, [isDaily, refreshing, fetchData]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAll();
  }, [fetchAll]);

  // 分时：每 5 分钟拉取一次，与板块成交量占比轮询保持一致
  useEffect(() => {
    if (isDaily) return undefined;
    const timer = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [isDaily, fetchData]);

  // 统一转换为 [{ name, latest, points: [{ label, score, detail }] }]
  const series = useMemo(() => {
    if (isDaily) {
      return (dailyData.blocks || []).filter((block) => block && block.name).map((block) => {
        const points = (block.points || []).map((point) => ({
          label: `${String(point.date).slice(4, 6)}-${String(point.date).slice(6, 8)}`,
          date: String(point.date),
          score: Number(point.totalScore),
          detail: point,
        }));
        return {
          name: block.name,
          points,
          latest: points[points.length - 1] || null,
          prev: points[points.length - 2] || null,
        };
      });
    }
    const points = intradayData.points || [];
    const names = new Set();
    for (const point of points) {
      for (const block of point.blocks || []) {
        if (block && block.name) names.add(block.name);
      }
    }
    return Array.from(names).map((name) => {
      const list = points
        .map((point) => {
          const block = (point.blocks || []).find((item) => item.name === name);
          if (!block) return null;
          return {
            label: formatTime(point.time),
            time: String(point.time),
            score: Number(block.totalScore),
            detail: block,
          };
        })
        .filter(Boolean);
      return {
        name,
        points: list,
        latest: list[list.length - 1] || null,
        prev: list[list.length - 2] || null,
      };
    });
  }, [isDaily, dailyData, intradayData]);

  const availableNames = useMemo(() => series.map((item) => item.name), [series]);
  const keywordNorms = useMemo(
    () => keywords.split(/[,，\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean),
    [keywords]
  );

  const latestSorted = useMemo(() => (
    [...series].sort((a, b) => (b.latest?.score ?? -999) - (a.latest?.score ?? -999))
  ), [series]);

  // 默认展示最新强度最高的前 12 个板块（showAll 时展示全部）；手动选择后按所选展示
  const effectiveSelected = useMemo(() => {
    if (selected === null) {
      return showAll ? availableNames : latestSorted.slice(0, 12).map((item) => item.name);
    }
    return availableNames.filter((name) => selected.includes(name));
  }, [selected, latestSorted, availableNames, showAll]);

  const displayItems = useMemo(() => (
    latestSorted.filter((item) => {
      const matchKeyword = !keywordNorms.length
        || keywordNorms.some((kw) => String(item.name ?? '').toLowerCase().includes(kw));
      if (!matchKeyword) return false;
      // 有关键字时在全部板块中搜索；无关键字时按默认/手动选择展示
      if (keywordNorms.length) return true;
      return effectiveSelected.includes(item.name);
    })
  ), [latestSorted, effectiveSelected, keywordNorms]);

  const rowItems = useMemo(() => (
    [...series].map((item) => ({ name: item.name }))
      .sort((a, b) => availableNames.indexOf(a.name) - availableNames.indexOf(b.name))
  ), [series, availableNames]);

  // 与上一交易日相比的强度变化
  const deltaOf = useCallback((item) => (
    item.latest && item.prev
      && Number.isFinite(item.latest.score) && Number.isFinite(item.prev.score)
      ? item.latest.score - item.prev.score
      : null
  ), []);

  // 按「较上一日提升 / 下降」分区（提升组按提升幅度降序，下降组按下跌幅度降序）
  const deltaSections = useMemo(() => {
    if (!groupByDelta) return null;
    const up = displayItems
      .filter((item) => (deltaOf(item) ?? 0) >= 0)
      .sort((a, b) => (deltaOf(b) ?? 0) - (deltaOf(a) ?? 0));
    const down = displayItems
      .filter((item) => (deltaOf(item) ?? 0) < 0)
      .sort((a, b) => (deltaOf(a) ?? 0) - (deltaOf(b) ?? 0));
    return [
      { key: 'up', title: '较上一日提升', color: '#dc2626', background: 'linear-gradient(90deg, rgba(220,38,38,.10), rgba(255,255,255,0))', items: up },
      { key: 'down', title: '较上一日下降', color: '#16a34a', background: 'linear-gradient(90deg, rgba(22,163,74,.10), rgba(255,255,255,0))', items: down },
    ];
  }, [groupByDelta, displayItems, deltaOf]);

  const openBlockStocks = useCallback(async (name) => {
    if (!name) return;
    setStockModalOpen(true);
    setStockModalBlock(name);
    setStockList([]);
    setStockError(null);
    setStockLoading(true);
    try {
      const resp = await axios.get(`http://${local_ip}:3000/block_volume_ratio_stocks`, {
        params: { name },
        timeout: 60 * 1000,
      });
      const data = resp.data || {};
      const list = Array.isArray(data.stocks) ? data.stocks : [];
      setStockList([...list].sort((a, b) => (Number(b.changePct) || -999) - (Number(a.changePct) || -999)));
    } catch (err) {
      console.error('获取板块成分股行情失败:', err);
      setStockError('获取板块成分股行情失败，请检查后端服务');
    } finally {
      setStockLoading(false);
    }
  }, []);

  const stockColumns = useMemo(() => [
    {
      title: '名称',
      dataIndex: 'name',
      width: 150,
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
    { title: '代码', dataIndex: 'marketCode', width: 110, render: (value, record) => value || record.code || '-' },
    { title: '最新价', dataIndex: 'price', width: 100, render: (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '-') },
    {
      title: '涨跌幅',
      dataIndex: 'changePct',
      width: 100,
      render: (value) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return <span style={{ color: num >= 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{num >= 0 ? '+' : ''}{num.toFixed(2)}%</span>;
      },
    },
  ], []);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => {
            const meta = items[0]?.dataset?.pointsMeta?.[items[0].dataIndex];
            return meta?.date || meta?.time || '';
          },
          label: (ctx) => {
            const meta = ctx.dataset.pointsMeta?.[ctx.dataIndex];
            if (!meta) return '';
            const d = meta.detail || {};
            if (isDaily) {
              return [
                `强度总分：${formatScore(d.totalScore)}`,
                `平均涨幅：${formatScore(d.avgChange)}%（${formatScore(d.avgChangeScore)} 分）`,
                `涨停家数：${d.limitUpCount ?? 0} 个（${formatScore(d.limitUpScore)} 分）`,
                `成交占比：${formatScore(d.ratio)}% → 变化 ${formatScore(d.ratioChangePct)}%（${formatScore(d.ratioScore)} 分）`,
              ];
            }
            return [
              `强度总分：${formatScore(d.totalScore)}`,
              `平均涨幅：${formatScore(d.avgChange)}%（${formatScore(d.avgChangeScore)} 分）`,
              `涨停家数：${d.limitUpCount ?? 0} 个（${formatScore(d.limitUpScore)} 分）`,
              `成交占比：${formatScore(d.todayRatio)}%（${formatScore(d.ratioScore)} 分）`,
            ];
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8', maxTicksLimit: 8, maxRotation: 45, minRotation: 45, font: { size: 9 } },
      },
      y: {
        grid: { color: 'rgba(148, 163, 184, 0.18)' },
        ticks: { color: '#94a3b8', font: { size: 10 }, callback: (value) => `${Number(value).toFixed(0)}` },
        suggestedMin: 0,
      },
    },
  }), [isDaily]);

  const renderCard = (item) => {
    const color = COLORS[availableNames.indexOf(item.name) % COLORS.length] || '#2563eb';
    const delta = deltaOf(item);
    return (
      <Card
        key={item.name}
        size="small"
        styles={{ body: { padding: '10px 12px 6px' } }}
        style={{ borderRadius: 12, boxShadow: '0 4px 16px rgba(15, 23, 42, 0.08)', border: '1px solid #e2e8f0' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Tooltip title="点击查看成分股列表">
            <Button
              type="text"
              style={{ padding: 0, fontWeight: 700, fontSize: 14, color: '#0f172a' }}
              onClick={() => openBlockStocks(item.name)}
            >
              {item.name}
            </Button>
          </Tooltip>
          <span style={{ marginLeft: 'auto', fontWeight: 700, color: scoreColor(item.latest?.score), fontSize: 16 }}>
            {formatScore(item.latest?.score)}
          </span>
          {delta !== null && (
            <Tag color={delta >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
              较昨日 {delta >= 0 ? '+' : ''}{delta.toFixed(1)}
            </Tag>
          )}
        </div>
        <div style={{ height: 170 }}>
          <Line
            data={{
              labels: item.points.map((point) => point.label),
              datasets: [
                {
                  label: item.name,
                  data: item.points.map((point) => point.score),
                  borderColor: color,
                  backgroundColor: `${color}1f`,
                  borderWidth: 2,
                  fill: true,
                  tension: 0.3,
                  spanGaps: true,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  pointsMeta: item.points,
                },
              ],
            }}
            options={chartOptions}
          />
        </div>
      </Card>
    );
  };

  const updatedText = isDaily
    ? (dailyData.updatedAt ? `更新于 ${dailyData.updatedAt}` : '')
    : `${intradayData.date ? `数据日期 ${dayjs(intradayData.date, 'YYYYMMDD').format('YYYY-MM-DD')}` : ''}${intradayData.updatedAt ? ` · 更新于 ${intradayData.updatedAt}` : ''}`;

  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <Tag color="red" style={{ fontSize: 12, padding: '2px 10px', borderRadius: 10 }}>
          强度 = 平均涨幅 40 + 涨停家数 30 + 较昨日成交占比变化 30
        </Tag>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{updatedText}</span>
        <div style={{ flex: 1 }} />
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索板块，支持空格/逗号分隔多个关键字"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          style={{ width: 320 }}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount={4}
          placeholder={showAll ? '选择板块（默认展示全部板块）' : '选择板块（默认展示强度最高的 12 个）'}
          value={selected ?? undefined}
          onChange={(value) => setSelected(value && value.length ? value : null)}
          options={rowItems.map((item) => ({ value: item.name, label: item.name }))}
          style={{ minWidth: 260, maxWidth: 420 }}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>刷新</Button>
        {!isDaily && (
          <Button type="primary" icon={<SyncOutlined spin={refreshing} />} onClick={refresh} loading={refreshing}>
            立即计算
          </Button>
        )}
      </div>

      {error && <div style={{ color: '#dc2626', marginBottom: 12 }}>{error}</div>}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
      ) : displayItems.length === 0 ? (
        <Empty description={isDaily ? '暂无板块强度日线数据' : '暂无板块强度分时数据'} style={{ marginTop: 48 }} />
      ) : groupByDelta && deltaSections ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          {deltaSections.map((section) => (
            <div key={section.key}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                marginBottom: 14,
                borderRadius: 10,
                background: section.background,
                borderLeft: `4px solid ${section.color}`,
              }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: section.color }}>{section.title}</span>
                <Tag color={section.key === 'up' ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                  {section.items.length} 个板块
                </Tag>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>按强度总分较上一交易日的变化幅度排序</span>
              </div>
              {section.items.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 12, padding: '4px 14px 16px' }}>暂无板块</div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                  gap: 16,
                  height: 750,
                  overflowY: 'auto'
                }}>
                  {section.items.map(renderCard)}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
          gap: 16,
          height: 750,
          overflowY: 'auto'
        }}>
          {displayItems.map(renderCard)}
        </div>
      )}

      <Modal
        title={`${stockModalBlock} 成分股`}
        open={stockModalOpen}
        onCancel={() => setStockModalOpen(false)}
        footer={null}
        width={720}
        styles={{ body: { maxHeight: 560, overflow: 'auto' } }}
      >
        {stockLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : stockError ? (
          <div style={{ color: '#dc2626' }}>{stockError}</div>
        ) : (
          <Table
            rowKey={(record, index) => `${record.code}-${index}`}
            size="small"
            columns={stockColumns}
            dataSource={stockList}
            pagination={{ pageSize: 15, showSizeChanger: false }}
          />
        )}
      </Modal>

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        stockInfo={klineStock || {}}
        code={klineStock?.code}
        zIndex={1100}
      />
    </div>
  );
};

export default BlockStrengthPanel;
