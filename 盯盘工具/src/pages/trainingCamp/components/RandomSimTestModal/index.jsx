import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Drawer, Button, InputNumber, Progress, Empty, Tag, message, Spin, Modal, Alert } from 'antd';
import { ExperimentOutlined, ReloadOutlined } from '@ant-design/icons';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
  Legend,
} from 'chart.js';
import { createChart, ColorType } from 'lightweight-charts';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../../../constant';
import { StrategyCard } from '../BacktestReportModal';

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, ChartTooltip, Legend);

const BASE = `http://${local_ip}:3000`;
const fmtDate = (d) => (d ? `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}` : '--');
const fmtPct = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};
const fmtDrawdown = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  return `${Number(v).toFixed(2)}%`; // 回撤为负数（如 -3.20%）
};

const DEFAULT_RUNS = 20;
const DEFAULT_STOCK_COUNT = 200;

// 把日K数组规范化为 lightweight-charts 蜡烛图（兼容 {trade_date, open_px...} 与 {time, open...} 两种字段）
const normalizeKlineForLC = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return { candles: [], ma5: [], ma10: [] };
  const candles = arr
    .map((d) => {
      const ts = Number(d.trade_date || d.day || d.time);
      if (!ts || !Number.isFinite(ts)) return null;
      const open = Number(d.open_px ?? d.open);
      const high = Number(d.high_px ?? d.high);
      const low = Number(d.low_px ?? d.low);
      const close = Number(d.close_px ?? d.close);
      if (![open, high, low, close].every(Number.isFinite)) return null;
      return { time: dayjs(String(ts)).format('YYYY-MM-DD'), open, high, low, close };
    })
    .filter(Boolean)
    .sort((a, b) => a.time.localeCompare(b.time));
  const calcMA = (n) => {
    const out = [];
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].close;
      if (i >= n) sum -= candles[i - n].close;
      if (i >= n - 1) out.push({ time: candles[i].time, value: sum / n });
    }
    return out;
  };
  return { candles, ma5: calcMA(5), ma10: calcMA(10) };
};

// 股票 K 线弹窗（展示真实个股日K，随机抽取注入的科技股同样走真实行情）
const StockKlineModal = ({ open, onClose, title, fetchBars }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [bars, setBars] = useState([]);

  useEffect(() => {
    if (!open || !fetchBars) return undefined;
    let cancelled = false;
    setLoading(true); setError(null); setBars([]);
    (async () => {
      try {
        const arr = await fetchBars();
        if (!cancelled) setBars(Array.isArray(arr) ? arr : []);
      } catch (e) {
        if (!cancelled) setError(e.message || '获取K线失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, fetchBars]);

  useEffect(() => {
    if (!open) return undefined;
    const container = containerRef.current;
    if (!container || loading || error) return undefined;
    const { candles, ma5, ma10 } = normalizeKlineForLC(bars);
    if (candles.length === 0) return undefined;
    if (chartRef.current) { try { chartRef.current.remove(); } catch { /* ignore */ } chartRef.current = null; }
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#6b7890', fontSize: 11 },
      width: container.clientWidth,
      height: 360,
      grid: { vertLines: { color: 'rgba(18,33,58,0.05)' }, horzLines: { color: 'rgba(18,33,58,0.05)' } },
      timeScale: { timeVisible: false, borderColor: 'rgba(18,33,58,0.08)' },
      rightPriceScale: { borderColor: 'rgba(18,33,58,0.08)', autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#f5222d', downColor: '#52c41a',
      borderUpColor: '#f5222d', borderDownColor: '#52c41a',
      wickUpColor: '#f5222d', wickDownColor: '#52c41a',
    });
    series.setData(candles);
    const ma5Series = chart.addLineSeries({ color: '#2196f3', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    ma5Series.setData(ma5);
    const ma10Series = chart.addLineSeries({ color: '#facc15', lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    ma10Series.setData(ma10);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    const handleResize = () => { if (chartRef.current && containerRef.current) chartRef.current.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) { try { chartRef.current.remove(); } catch { /* ignore */ } chartRef.current = null; }
    };
  }, [open, bars, loading, error]);

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={900} destroyOnHidden title={title}>
      {loading ? (
        <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>
      ) : error ? (
        <Empty description={error} />
      ) : bars.length === 0 ? (
        <Empty description="暂无K线数据" />
      ) : (
        <div ref={containerRef} style={{ width: '100%', height: 360 }} />
      )}
    </Modal>
  );
};

const RandomSimTestModal = ({ open, onClose, strategy, endDate, startDate: maxStartDate, strategyName }) => {
  const [runs, setRuns] = useState(DEFAULT_RUNS);
  const [stockCount, setStockCount] = useState(DEFAULT_STOCK_COUNT);
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ totalRuns: 0, currentRun: 0, currentDay: 0, totalDays: 0, progressPercent: 0, lastLog: '', config: null });
  const [simError, setSimError] = useState(null);
  const [detail, setDetail] = useState(null); // { runIndex, summary, simCodes, result }
  const [detailLoading, setDetailLoading] = useState(false);
  const [klineOpen, setKlineOpen] = useState(false);
  const [klineTitle, setKlineTitle] = useState('');
  const [klineFetch, setKlineFetch] = useState(null);
  const pollRef = useRef(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const startPoll = useCallback(() => {
    stopPoll();
    setRunning(true);
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/random_sim/status`);
        const s = r.data || {};
        if (Array.isArray(s.runs)) setItems(s.runs);
        setMeta({
          totalRuns: s.totalRuns || 0, currentRun: s.currentRun || 0,
          currentDay: s.currentDay || 0, totalDays: s.totalDays || 0,
          progressPercent: s.progressPercent || 0,
          lastLog: s.lastLog || '', config: s.config || null,
        });
        if (s.status === 'done' || s.status === 'error') {
          stopPoll();
          setRunning(false);
          setSimError(s.status === 'error' ? (s.error || '随机模拟测试失败') : null);
        }
      } catch {
        // 继续等待
      }
    }, 2000);
  }, [stopPoll]);

  const handleStart = async (override) => {
    setItems([]);
    setDetail(null);
    setSimError(null);
    const body = {
      strategy,
      startDate: maxStartDate || undefined,
      endDate,
      runs: override?.runs ?? runs,
      stockCount: override?.stockCount ?? stockCount,
    };
    try {
      const r = await axios.post(`${BASE}/training_camp/backtest/random_sim`, body);
      if (!r.data?.success) {
        setSimError(r.data?.message || '创建随机模拟测试任务失败');
        return;
      }
      startPoll();
    } catch (e) {
      setSimError(e.message || '创建随机模拟测试任务失败，请检查后端服务');
    }
  };

  // 打开弹窗：若上次结果仍在（status=done）直接展示，否则不自动跑（需用户点击开始并设定次数）
  useEffect(() => {
    if (!open) { stopPoll(); return undefined; }
    (async () => {
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/random_sim/status`);
        const s = r.data || {};
        if (Array.isArray(s.runs)) setItems(s.runs);
        setMeta({
          totalRuns: s.totalRuns || 0, currentRun: s.currentRun || 0,
          currentDay: s.currentDay || 0, totalDays: s.totalDays || 0,
          progressPercent: s.progressPercent || 0,
          lastLog: s.lastLog || '', config: s.config || null,
        });
        if (s.status === 'running') startPoll();
      } catch { /* 忽略 */ }
    })();
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const validItems = useMemo(
    () => items.filter(it => it.summary && Number.isFinite(Number(it.summary.overallReturn))).sort((a, b) => a.index - b.index),
    [items],
  );

  const lineChartData = useMemo(() => ({
    labels: validItems.map(it => `第${it.index}次`),
    datasets: [
      {
        label: '收益率 %',
        data: validItems.map(it => Number(it.summary.overallReturn)),
        borderColor: '#f5222d',
        backgroundColor: 'rgba(245,34,45,0.12)',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 7,
        pointBackgroundColor: '#f5222d',
        pointBorderColor: '#fff',
        pointBorderWidth: 1,
        tension: 0.25,
        fill: false,
      },
      {
        label: '平均回撤 %',
        data: validItems.map(it => (it.summary.avgDrawdown != null ? Math.abs(Number(it.summary.avgDrawdown)) : null)),
        borderColor: '#1677ff',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#1677ff',
        pointBorderColor: '#fff',
        pointBorderWidth: 1,
        tension: 0.25,
        fill: false,
        spanGaps: true,
      },
      {
        label: '最大回撤 %',
        data: validItems.map(it => (it.summary.maxDrawdown != null ? Math.abs(Number(it.summary.maxDrawdown)) : null)),
        borderColor: '#722ed1',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#722ed1',
        pointBorderColor: '#fff',
        pointBorderWidth: 1,
        tension: 0.25,
        fill: false,
        spanGaps: true,
      },
    ],
  }), [validItems]);

  const handlePointClick = useCallback(async (runIndex) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await axios.get(`${BASE}/training_camp/backtest/random_sim/detail`, { params: { run: runIndex } });
      if (r.data?.success) setDetail(r.data);
      else message.error(r.data?.message || '未找到该次回测结果');
    } catch (e) {
      message.error('拉取该次回测明细失败：' + (e.message || ''));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const lineChartOptions = useMemo(() => {
    const metaMap = {};
    validItems.forEach(it => { metaMap[`第${it.index}次`] = it.summary; });
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: {
          display: true, position: 'top', align: 'end',
          labels: { color: '#6b7890', font: { size: 11 }, boxWidth: 14, boxHeight: 8, usePointStyle: true, padding: 12 },
        },
        tooltip: {
          backgroundColor: 'rgba(18,33,58,0.92)',
          titleColor: '#fff',
          bodyColor: '#d1d9e6',
          borderColor: 'rgba(22,119,255,0.6)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: (ctx) => `第 ${ctx[0].dataIndex + 1} 次回测`,
            label: (ctx) => {
              const s = metaMap[ctx.label];
              if (!s) return '';
              return [
                `收益率：${fmtPct(s.overallReturn)}`,
                `最大回撤：${fmtDrawdown(s.maxDrawdown)}`,
                `平均回撤：${fmtDrawdown(s.avgDrawdown)}`,
                `交易笔数：${s.tradeCount ?? 0} 笔`,
              ];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#6b7890' }, grid: { color: 'rgba(18,33,58,0.05)' } },
        y: { ticks: { color: '#6b7890', callback: (v) => `${v}%` }, grid: { color: 'rgba(18,33,58,0.05)' } },
      },
      onClick: (_e, elements) => {
        if (!elements || elements.length === 0) return;
        const it = validItems[elements[0].index];
        if (it) handlePointClick(it.index);
      },
    };
  }, [validItems, handlePointClick]);

  // 所有参与回测的股票（含随机抽取注入的真实科技股）均走真实个股 K 线接口
  const openStockKline = useCallback((simCodes, code, name) => {
    const isSim = Array.isArray(simCodes) && simCodes.includes(code);
    setKlineTitle(`${name || code}${isSim ? '（随机注入）' : ''} 日K线`);
    setKlineFetch(() => async () => {
      const r = await axios.post(`${BASE}/data_center/stocks_kline`, { codes: [code], limit: 120 });
      return (r.data?.data?.[code]) || [];
    });
    setKlineOpen(true);
  }, []);

  const didRun = validItems.length > 0 || running;
  const progressPercent = useMemo(() => {
    const total = meta.totalRuns || 0;
    if (!total) return 0;
    // 并行回测下由后端聚合各子进程进度，优先使用
    if (typeof meta.progressPercent === 'number' && meta.progressPercent > 0) {
      return Math.max(0, Math.min(100, Math.round(meta.progressPercent)));
    }
    const inRun = running && meta.totalDays > 0 ? (meta.currentDay / meta.totalDays) : 0;
    return Math.max(0, Math.min(100, Math.round(((items.length + inRun) / total) * 100)));
  }, [meta, items.length, running]);

  return (
    <Drawer
      open={open}
      onClose={() => { stopPoll(); onClose?.(); }}
      width={1280}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#12213a' }}>随机模拟测试</span>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>{strategyName || strategy || '--'}</Tag>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            {fmtDate(maxStartDate)} → {fmtDate(endDate)}｜已完成 {items.length} / {meta.totalRuns || runs} 次
          </span>
        </div>
      }
      styles={{ body: { padding: 16, paddingBottom: 96, background: '#f7f9fc' } }}
      closable
      placement="right"
    >
      {/* 参数区 */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 12, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <ExperimentOutlined style={{ color: '#722ed1' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>回测次数</span>
          <InputNumber min={1} max={200} value={runs} onChange={(v) => setRuns(v || DEFAULT_RUNS)} disabled={running} style={{ width: 110 }} addonAfter="次" />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>随机注入股票数</span>
          <InputNumber min={1} max={2000} value={stockCount} onChange={(v) => setStockCount(v || DEFAULT_STOCK_COUNT)} disabled={running} style={{ width: 120 }} addonAfter="只" />
          <Button
            type="primary"
            icon={<ExperimentOutlined />}
            onClick={() => handleStart()}
            loading={running}
            style={{ marginLeft: 'auto', borderRadius: 8, background: '#722ed1', borderColor: '#722ed1' }}
          >
            开始随机模拟测试
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => handleStart()} disabled={running} style={{ borderRadius: 8 }}>
            重新跑一次
          </Button>
        </div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>
          每次回测都会从科技股清单（all_tech_stock_code.json）随机抽取指定数量的真实股票（排除当前自选股），
          混入当前策略的候选池一起参与回测，其日K/分时均取自真实行情，用于检验系统在候选池被大量噪声股票干扰时的稳定性与鲁棒性。
        </div>
      </div>

      {/* 折线图 */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 12, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>收益率 / 回撤幅度曲线（横轴为第 n 次回测）</span>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            <span style={{ color: '#f5222d', fontWeight: 700 }}>红线</span> 收益率 ·
            <span style={{ color: '#1677ff', fontWeight: 700 }}> 蓝线</span> 平均回撤 ·
            <span style={{ color: '#722ed1', fontWeight: 700 }}> 紫线</span> 最大回撤；点击折线点可查看该次完整回测报告
          </span>
        </div>

        {(running || meta.totalRuns > 0) && (
          <div style={{ marginBottom: 8 }}>
            <Progress
              percent={progressPercent}
              status={running ? 'active' : simError ? 'exception' : 'success'}
              size="small"
              format={() => `${items.length}/${meta.totalRuns || runs} 次`}
            />
            <div style={{ fontSize: 12, color: '#6b7890', marginTop: 4 }}>{meta.lastLog}</div>
          </div>
        )}

        {simError && (
          <Alert type="error" showIcon style={{ marginBottom: 8 }} message={simError} />
        )}

        {!didRun ? (
          <Empty description="设置回测次数与随机注入股票数后，点击「开始随机模拟测试」" style={{ padding: '40px 0' }} />
        ) : (
          <div style={{ width: '100%', height: 340 }}>
            <Line data={lineChartData} options={lineChartOptions} />
          </div>
        )}
      </div>

      {/* 点击选中的回测详情 */}
      {detailLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
          <Spin size="large" />
          <span style={{ marginLeft: 12, fontSize: 12, color: '#6b7890', alignSelf: 'center' }}>正在拉取该次回测明细…</span>
        </div>
      )}
      {detail && !detailLoading && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 12, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>第 {detail.runIndex} 次回测报告</span>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {fmtDate(detail?.result?.range?.startDate)} → {fmtDate(detail?.result?.range?.endDate)}
            </Tag>
            <Tag color={detail?.summary?.overallReturn >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
              整体收益 {fmtPct(detail?.summary?.overallReturn)}
            </Tag>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>点击股票名称可查看该股 K 线</span>
            <button
              type="button"
              onClick={() => setDetail(null)}
              style={{ marginLeft: 'auto', fontSize: 12, color: '#1677ff', border: 'none', background: 'transparent', cursor: 'pointer' }}
            >
              关闭
            </button>
          </div>
          {detail?.result ? (
            <StrategyCard
              strategy={{
                id: detail?.result?.strategy?.id || strategy,
                name: strategyName || detail?.result?.strategy?.name || strategy,
                desc: detail?.result?.strategy?.desc || '',
                summary: detail?.result?.summary || null,
                trades: detail?.result?.trades || [],
                currentHolding: detail?.result?.currentHolding || null,
              }}
              rank={null}
              onStockClick={(code, name) => openStockKline(detail.simCodes, code, name)}
            />
          ) : (
            <Empty description={detail?.summary ? '该次回测无可用明细' : '该次回测失败或无结果'} />
          )}
        </div>
      )}

      <StockKlineModal
        open={klineOpen}
        onClose={() => setKlineOpen(false)}
        title={klineTitle}
        fetchBars={klineFetch}
      />
    </Drawer>
  );
};

export default RandomSimTestModal;