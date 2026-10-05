import { useState, useEffect, useMemo, useRef } from 'react';
import { Button, Checkbox, Empty, Input, Spin, Tag, Tooltip } from 'antd';
import { LineChartOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, LineElement, PointElement, Tooltip as ChartTooltip } from 'chart.js';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import { StrategyCard } from '../BacktestReportModal';

const BASE = `http://${local_ip}:3000`;
const fmtDate = (d) => (d ? `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}` : '--');
const fmtPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
const signColor = (v) => (v == null || !Number.isFinite(Number(v)) ? '#8c8c8c' : (Number(v) > 0 ? '#cf1322' : (Number(v) < 0 ? '#389e0d' : '#6b7890')));

const hexToRgba = (hex, alpha = 1) => {
  if (!hex || !hex.startsWith('#')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

// 与叠加分时观察一致的 7 色循环调色板（红/橙/黄/青/蓝/紫/粉）
const PALETTE = ['#ef4444', '#f97316', '#facc15', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

// 默认展示的三个策略：3日涨幅最大 / 3日研报覆盖数最多 / 5日研报覆盖数最多
const DEFAULT_SELECTED = ['highest_3d_gain', 'highest_3d_reports', 'highest_5d_reports'];

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, ChartTooltip);

// 历史曲线 tab：按自然月回测全部策略（月度整体收益跨月累乘），多策略累计收益率曲线叠加在同一条时间轴上；
// 交互样式模仿盯盘页「叠加分时观察」：彩色策略 tag（悬停高亮对应曲线、双击移除）+ 批量添加面板（搜索/多选/全选）
const MonthlyCurveTab = ({ active, onStockClick }) => {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { generatedAt, months, strategies, missingCount }
  const [lastLog, setLastLog] = useState('');
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(DEFAULT_SELECTED); // 已选策略 id 顺序即添加顺序
  const [showPanel, setShowPanel] = useState(false);
  const [panelSearch, setPanelSearch] = useState('');
  const [panelSelected, setPanelSelected] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);
  const [rerunLoading, setRerunLoading] = useState(false);
  const [detail, setDetail] = useState([]); // 月度明细：[{ id, name, desc, months: [{ key, label, startDate, endDate, days, summary, trades, currentHolding }] }]
  const [detailLoading, setDetailLoading] = useState(false);
  const pollRef = useRef(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPoll = () => {
    stopPoll();
    setRunning(true);
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/monthly/status`);
        const s = r.data || {};
        if (s.result) setResult(s.result);
        if (Array.isArray(s.logs) && s.logs.length > 0) setLastLog(s.logs[s.logs.length - 1]);
        if (s.status !== 'running') {
          stopPoll();
          setRunning(false);
          if (s.status === 'error' && s.error) setError(s.error);
          else setError(null);
        }
      } catch {
        // 单次轮询失败继续等待
      }
    }, 3000);
  };

  const startJob = async () => {
    try {
      const r = await axios.post(`${BASE}/training_camp/backtest/trend_diagnosis/monthly`, {});
      if (r.data?.success) {
        startPoll();
        return true;
      }
      setError(r.data?.message || '启动自然月回测失败');
      return false;
    } catch {
      setError('启动自然月回测失败，请检查后端服务');
      return false;
    }
  };

  // tab 激活：拉取状态，无进行中任务时自动补测一次（已有缓存时秒完成），有进行中任务则续接轮询
  useEffect(() => {
    if (!active) {
      stopPoll();
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/monthly/status`);
        if (cancelled) return;
        const s = r.data || {};
        if (s.result) setResult(s.result);
        if (s.status === 'running') {
          startPoll();
          return;
        }
        if (s.status === 'error' && s.error) setError(s.error);
        startJob();
      } catch {
        if (!cancelled) setError('获取历史曲线状态失败，请检查后端服务');
      }
    })();
    return () => {
      cancelled = true;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleRerun = async () => {
    if (running || rerunLoading) return;
    setRerunLoading(true);
    try {
      await startJob();
    } finally {
      setRerunLoading(false);
    }
  };

  // 已选策略变化或月度结果更新（重新回测完成）时，拉取各策略各自然月的完整回测明细（曲线下方按回测报告格式展示）
  const selectedKey = selected.join(',');
  useEffect(() => {
    if (selectedKey === '') {
      setDetail([]);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/monthly/detail`, { params: { ids: selectedKey } })
      .then(r => { if (!cancelled) setDetail(r.data?.success ? (r.data.strategies || []) : []); })
      .catch(() => { if (!cancelled) setDetail([]); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, result?.generatedAt]);

  const detailMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(detail) ? detail : []).forEach(s => map.set(s.id, s));
    return map;
  }, [detail]);

  const strategyMap = useMemo(() => {
    const map = new Map();
    (result?.strategies || []).forEach(s => map.set(s.id, s));
    return map;
  }, [result]);

  const months = result?.months || [];

  // 已选且有有效数据的策略（全月缺失的策略无法画线，绘制时跳过但保留在 tag 列表外）
  const drawable = useMemo(
    () => selected.map(id => strategyMap.get(id)).filter(s => s && s.monthly?.some(p => p.cumulative != null)),
    [selected, strategyMap],
  );

  // 颜色按「期末累计收益」排名分配（与叠加分时按涨幅排名取色同理，相邻位置的曲线取相邻色）
  const colorById = useMemo(() => {
    const order = drawable
      .map((s, idx) => ({ idx, v: Number.isFinite(Number(s.latestCumulative)) ? Number(s.latestCumulative) : -Infinity }))
      .sort((a, b) => b.v - a.v || a.idx - b.idx);
    const map = new Map();
    order.forEach((item, rank) => map.set(drawable[item.idx].id, PALETTE[rank % PALETTE.length]));
    return map;
  }, [drawable]);

  const chartData = useMemo(() => ({
    labels: months.map(m => m.label),
    datasets: drawable.map(s => {
      const color = colorById.get(s.id) || PALETTE[0];
      const dimmed = hoveredId != null && hoveredId !== s.id;
      return {
        key: s.id, // 自定义字段：tooltip 回调按 id 反查策略
        label: s.name,
        data: s.monthly.map(p => p.cumulative),
        borderColor: dimmed ? hexToRgba(color, 0.12) : color,
        backgroundColor: hexToRgba(color, dimmed ? 0.1 : 1),
        pointBackgroundColor: dimmed ? hexToRgba(color, 0.15) : color,
        pointBorderColor: dimmed ? hexToRgba(color, 0.15) : '#fff',
        pointRadius: dimmed ? 3 : 4.5,
        pointHoverRadius: 6,
        borderWidth: dimmed ? 1.5 : 2.5,
        tension: 0.3,
        spanGaps: false,
      };
    }),
  }), [months, drawable, colorById, hoveredId]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false }, // tag 行即图例
      tooltip: {
        callbacks: {
          title: (items) => {
            const m = months[items[0]?.dataIndex];
            return m ? `${m.label}（${fmtDate(m.startDate)} ~ ${fmtDate(m.endDate)}，${m.days} 个交易日）` : '';
          },
          label: (ctx) => {
            const st = strategyMap.get(ctx.dataset.key);
            const p = st?.monthly?.[ctx.dataIndex];
            const cum = ctx.parsed.y != null ? fmtPct(ctx.parsed.y) : '无数据';
            return `${st?.name || ctx.dataset.label}：累计 ${cum}（当月 ${fmtPct(p?.ret)}，${p?.tradeCount ?? 0} 笔）`;
          },
        },
      },
    },
    scales: {
      y: {
        ticks: { callback: (v) => `${v}%` },
        title: { display: true, text: '累计收益率（跨月累乘）' },
      },
      x: {
        grid: { display: false },
      },
    },
  }), [months, strategyMap]);

  const filteredStrategies = useMemo(() => {
    const kw = panelSearch.trim().toLowerCase();
    return (result?.strategies || []).filter(s => !kw || s.name.toLowerCase().includes(kw) || s.id.toLowerCase().includes(kw));
  }, [result, panelSearch]);

  const handleConfirmPanel = () => {
    setSelected(prev => [...prev, ...panelSelected.filter(id => !prev.includes(id))]);
    setShowPanel(false);
    setPanelSelected([]);
    setPanelSearch('');
  };

  const allFilteredSelectedInPanel = filteredStrategies.length > 0
    && filteredStrategies.every(s => selected.includes(s.id) || panelSelected.includes(s.id));

  return (
    <div>
      {/* 顶部说明 + 重新回测 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12, background: '#fff', borderRadius: 12, padding: '10px 14px', boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <LineChartOutlined style={{ color: '#1677ff' }} />
        <span style={{ fontSize: 12, color: '#6b7890' }}>
          按自然月回测全部策略，月度整体收益跨月累乘为累计收益率曲线{months.length > 0 && <>（{months.length} 个月：{fmtDate(months[0].startDate)} ~ {fmtDate(months[months.length - 1].endDate)}）</>}
        </span>
        {result?.missingCount > 0 && (
          <Tag style={{ marginInlineEnd: 0 }} color="orange">{result.missingCount} 个「策略×月份」无数据（曲线断点）</Tag>
        )}
        <span style={{ flex: 1 }} />
        <Button icon={<ReloadOutlined />} onClick={handleRerun} loading={running || rerunLoading} style={{ borderRadius: 999 }}>
          {running ? '回测中…' : '重新回测'}
        </Button>
      </div>

      {running && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: '#1677ff', background: '#e6f4ff', borderRadius: 8, padding: '8px 12px' }}>
          <Spin size="small" />
          <span>自然月回测进行中（已有缓存的月份/策略自动跳过）…{lastLog ? `最近日志：${lastLog}` : ''}</span>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#cf1322', background: '#fff1f0', borderRadius: 8, padding: '8px 12px' }}>
          {error}
        </div>
      )}

      {!result && !running ? (
        <Empty description="暂无历史曲线数据，点击「重新回测」生成" style={{ padding: '40px 0' }} />
      ) : (
        <>
          {/* 策略 tag 行（模仿叠加分时观察：彩色 tag = 图例，悬停高亮曲线、双击移除） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {selected.length === 0 && <span style={{ fontSize: 12, color: '#9ca3af' }}>尚未选择策略，点击「添加策略」开始</span>}
            {selected.map((id) => {
              const s = strategyMap.get(id);
              const color = colorById.get(id) || '#94a3b8';
              const hovered = hoveredId === id;
              const dimmed = hoveredId != null && !hovered;
              return (
                <Tooltip
                  key={id}
                  title={(
                    <div>
                      <div>{s?.name || id}</div>
                      {(s?.monthly || []).map(p => (
                        <div key={p.month}>{p.month}: 累计 {fmtPct(p.cumulative)}（当月 {fmtPct(p.ret)}，{p.tradeCount ?? 0} 笔）</div>
                      ))}
                      <div style={{ marginTop: 4, opacity: 0.75 }}>双击移除</div>
                    </div>
                  )}
                >
                  <div
                    onMouseEnter={() => setHoveredId(id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onDoubleClick={() => setSelected(prev => prev.filter(x => x !== id))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, cursor: 'default',
                      border: `1px solid ${hexToRgba(color, hovered ? 0.9 : 0.35)}`,
                      background: hexToRgba(color, hovered ? 0.16 : 0.08),
                      opacity: dimmed ? 0.45 : 1,
                      transition: 'all 0.15s',
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, color }}>{s?.name || id}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: signColor(s?.latestCumulative) }}>{fmtPct(s?.latestCumulative)}</span>
                  </div>
                </Tooltip>
              );
            })}
            <Button
              size="small"
              type={showPanel ? 'default' : 'primary'}
              icon={<PlusOutlined />}
              onClick={() => { setShowPanel(v => !v); setPanelSelected([]); setPanelSearch(''); }}
              style={{ borderRadius: 999 }}
            >
              {showPanel ? '收起添加面板' : '添加策略'}
            </Button>
          </div>

          {/* 批量添加面板（模仿叠加分时的批量添加：搜索 + 多选 + 全选） */}
          {showPanel && (
            <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(18,33,58,0.06)', padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <Input
                  size="small"
                  placeholder="搜索策略名称"
                  prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                  allowClear
                  style={{ width: 220 }}
                  value={panelSearch}
                  onChange={e => setPanelSearch(e.target.value)}
                />
                <Button
                  size="small"
                  onClick={() => {
                    setPanelSelected(prev => {
                      const set = new Set(prev);
                      filteredStrategies.forEach(s => { if (!selected.includes(s.id)) set.add(s.id); });
                      return Array.from(set);
                    });
                  }}
                  disabled={allFilteredSelectedInPanel}
                >
                  全选
                </Button>
                <Button size="small" onClick={() => setPanelSelected([])} disabled={panelSelected.length === 0}>清空</Button>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>共 {result?.strategies?.length || 0} 个策略，已选 {selected.length + panelSelected.filter(id => !selected.includes(id)).length} 个</span>
                <span style={{ flex: 1 }} />
                <Button size="small" onClick={() => { setShowPanel(false); setPanelSelected([]); }}>取消</Button>
                <Button size="small" type="primary" disabled={panelSelected.length === 0} onClick={handleConfirmPanel}>
                  确定（{panelSelected.filter(id => !selected.includes(id)).length}）
                </Button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', maxHeight: 220, overflowY: 'auto' }}>
                {filteredStrategies.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配策略" />}
                {filteredStrategies.map(s => {
                  const already = selected.includes(s.id);
                  const checked = already || panelSelected.includes(s.id);
                  return (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, width: 280, padding: '3px 4px', opacity: already ? 0.55 : 1 }}>
                      <Checkbox
                        checked={checked}
                        disabled={already}
                        onChange={e => setPanelSelected(prev => (e.target.checked ? [...prev, s.id] : prev.filter(x => x !== s.id)))}
                      />
                      <span style={{ fontSize: 12, color: '#12213a' }}>{s.name}</span>
                      {already ? (
                        <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', padding: '0 6px' }}>已添加</Tag>
                      ) : (
                        <span style={{ fontSize: 12, fontWeight: 600, color: signColor(s.latestCumulative) }}>{fmtPct(s.latestCumulative)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 曲线图：多策略累计收益率叠加 */}
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(18,33,58,0.06)', padding: '14px 16px 8px' }}>
            {drawable.length === 0 ? (
              <Empty description="所选策略均无可用月度数据，请添加其他策略" style={{ padding: '60px 0' }} />
            ) : (
              <div style={{ height: 420 }}>
                <Line data={chartData} options={chartOptions} />
              </div>
            )}
          </div>

          {/* 月度交易明细：已选策略 × 自然月，逐月按回测报告的 StrategyCard 格式展示每一笔交易 */}
          {selected.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {selected.map((id) => {
                const s = strategyMap.get(id);
                const entry = detailMap.get(id);
                const color = colorById.get(id) || '#94a3b8';
                return (
                  <div key={id} style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color }} />
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{s?.name || id}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: signColor(s?.latestCumulative) }}>{fmtPct(s?.latestCumulative)}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>期末累计收益率 · 各月明细如下</span>
                    </div>
                    {!entry ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7890', background: '#fff', borderRadius: 12, padding: '12px 14px', boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                        {detailLoading ? <><Spin size="small" /> 正在加载月度交易明细…</> : '月度交易明细加载失败，请稍后重试'}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {entry.months.map((m) => (
                          m.summary == null ? (
                            <div key={m.key} style={{ background: '#fff', borderRadius: 12, padding: '12px 14px', boxShadow: '0 1px 4px rgba(18,33,58,0.06)', fontSize: 12, color: '#9ca3af' }}>
                              {m.label}（{fmtDate(m.startDate)} ~ {fmtDate(m.endDate)}）：该月无回测缓存数据
                            </div>
                          ) : (
                            <StrategyCard
                              key={m.key}
                              strategy={{
                                id,
                                name: `${m.label}（${fmtDate(m.startDate)} ~ ${fmtDate(m.endDate)}，${m.days} 个交易日）`,
                                summary: m.summary,
                                trades: m.trades,
                                currentHolding: m.currentHolding,
                              }}
                              onStockClick={onStockClick}
                            />
                          )
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default MonthlyCurveTab;
