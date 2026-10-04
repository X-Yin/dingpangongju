import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Drawer, Segmented, Button, Progress, Spin, Empty, Tag, message } from 'antd';
import { ReloadOutlined, SearchOutlined, SwapOutlined } from '@ant-design/icons';
import { createChart, ColorType } from 'lightweight-charts';
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

const INDEX_OPTIONS = [
  { key: 'shangzheng', label: '上证指数', field: 'shangzhengData' },
  { key: 'chuangyeban', label: '创业板指', field: 'chuangyebanData' },
  { key: 'kechuangban', label: '科创板指', field: 'kechuangbanData' },
];

// 计算简单移动平均线（MA N）：以 close 序列为基础
const calcMA = (data, n) => {
  const out = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i].close;
    if (i >= n) sum -= data[i - n].close;
    if (i >= n - 1) {
      out.push({ time: data[i].time, value: sum / n });
    }
  }
  return out;
};

// 把 /get_index_kline_data 返回的数组规范化为 lightweight-charts 蜡烛图
// CLS 指数 k 线字段形如：{ trade_date, open_px, high_px, low_px, close_px, ma5_px, ma10_px, ma20_px }
// lightweight-charts v4 支持 ISO 字符串时间：'YYYY-MM-DD'
const normalizeKlineForLC = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return { candles: [], ma3: [], ma5: [], ma10: [] };
  const candles = arr
    .map((d) => {
      const ts = Number(d.trade_date || d.day || d.time);
      if (!ts || !Number.isFinite(ts)) return null;
      const open = Number(d.open_px ?? d.open);
      const high = Number(d.high_px ?? d.high);
      const low = Number(d.low_px ?? d.low);
      const close = Number(d.close_px ?? d.close);
      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
      return { time: dayjs(String(ts)).format('YYYY-MM-DD'), open, high, low, close };
    })
    .filter((x) => x)
    .sort((a, b) => a.time.localeCompare(b.time));
  return {
    candles,
    ma3: calcMA(candles, 3),
    ma5: calcMA(candles, 5),
    ma10: calcMA(candles, 10),
  };
};

// 从 /get_index_kline_data 数组中取指定指数的数据
const pickIndexData = (rawIndexData, field) => {
  if (!rawIndexData) return [];
  const data = rawIndexData[field];
  return Array.isArray(data) ? data : [];
};

const TimeFlexTestModal = ({ open, onClose, strategy, endDate, startDate: maxStartDate, strategyName }) => {
  const [indexType, setIndexType] = useState('chuangyeban');
  const [indexRaw, setIndexRaw] = useState(null); // 完整的 { shangzhengData, chuangyebanData, kechuangbanData }
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexError, setIndexError] = useState(null);

  // 时间伸缩测试任务
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState([]); // [{ startDate, endDate, summary }]
  const [progress, setProgress] = useState({ current: 0, total: 0, lastLog: '' });
  const [flexError, setFlexError] = useState(null);
  const [detail, setDetail] = useState(null); // 选中的回测完整结果（给 StrategyCard 渲染）
  const [detailLoading, setDetailLoading] = useState(false);
  const pollRef = useRef(null);

  // 指数 K 线图
  const klineContainerRef = useRef(null);
  const klineChartRef = useRef(null);
  const klineSeriesRef = useRef(null);
  const ma3SeriesRef = useRef(null);
  const ma5SeriesRef = useRef(null);
  const ma10SeriesRef = useRef(null);

  // 收益率折线图
  const lineChartRef = useRef(null);

  // 停止轮询
  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 拉指数 K 线（三段）
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      setIndexLoading(true);
      setIndexError(null);
      try {
        const r = await axios.get(`${BASE}/get_index_kline_data`);
        if (cancelled) return;
        if (r.data && typeof r.data === 'object') {
          setIndexRaw(r.data);
        } else {
          setIndexError('指数K线数据异常');
        }
      } catch (e) {
        if (!cancelled) setIndexError('获取指数K线失败：' + (e.message || ''));
      } finally {
        if (!cancelled) setIndexLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 渲染 lightweight-charts K 线图
  useEffect(() => {
    if (!open) return undefined;
    const container = klineContainerRef.current;
    if (!container) return undefined;

    // 销毁旧实例
    if (klineChartRef.current) {
      try { klineChartRef.current.remove(); } catch (e) {}
      klineChartRef.current = null;
      klineSeriesRef.current = null;
    }

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6b7890',
        fontSize: 11,
      },
      width: container.clientWidth,
      height: 300,
      grid: {
        vertLines: { color: 'rgba(18, 33, 58, 0.05)' },
        horzLines: { color: 'rgba(18, 33, 58, 0.05)' },
      },
      timeScale: {
        timeVisible: false,
        secondsVisible: false,
        borderColor: 'rgba(18, 33, 58, 0.08)',
      },
      rightPriceScale: {
        borderColor: 'rgba(18, 33, 58, 0.08)',
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#f5222d',
      downColor: '#52c41a',
      borderUpColor: '#f5222d',
      borderDownColor: '#52c41a',
      wickUpColor: '#f5222d',
      wickDownColor: '#52c41a',
    });
    const ma3 = chart.addLineSeries({
      color: '#9c27b0', lineWidth: 1,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: false, priceLineVisible: false,
    });
    const ma5 = chart.addLineSeries({
      color: '#2196f3', lineWidth: 1,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: false, priceLineVisible: false,
    });
    const ma10 = chart.addLineSeries({
      color: '#facc15', lineWidth: 1,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      lastValueVisible: false, priceLineVisible: false,
    });
    klineChartRef.current = chart;
    klineSeriesRef.current = series;
    ma3SeriesRef.current = ma3;
    ma5SeriesRef.current = ma5;
    ma10SeriesRef.current = ma10;

    // 填充数据
    const field = INDEX_OPTIONS.find((o) => o.key === indexType)?.field;
    const rawArr = field ? pickIndexData(indexRaw, field) : [];
    const { candles, ma3: ma3Data, ma5: ma5Data, ma10: ma10Data } = normalizeKlineForLC(rawArr);
    if (candles.length > 0) {
      series.setData(candles);
      ma3.setData(ma3Data);
      ma5.setData(ma5Data);
      ma10.setData(ma10Data);
      if (maxStartDate && endDate) {
        const fitFrom = dayjs(fmtDate(maxStartDate)).subtract(20, 'day').format('YYYY-MM-DD');
        const fitTo = dayjs(fmtDate(endDate)).add(5, 'day').format('YYYY-MM-DD');
        chart.timeScale().setVisibleRange({ from: fitFrom, to: fitTo });
      } else {
        chart.timeScale().fitContent();
      }
    }

    const handleResize = () => {
      if (klineChartRef.current && klineContainerRef.current) {
        klineChartRef.current.applyOptions({
          width: klineContainerRef.current.clientWidth,
        });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (klineChartRef.current) {
        try { klineChartRef.current.remove(); } catch (e) {}
        klineChartRef.current = null;
        klineSeriesRef.current = null;
        ma3SeriesRef.current = null;
        ma5SeriesRef.current = null;
        ma10SeriesRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, indexType, indexRaw, maxStartDate, endDate]);

  // 打开弹窗：自动启动伸缩任务并轮询
  useEffect(() => {
    if (!open) {
      stopPoll();
      return undefined;
    }
    setDetail(null);
    setItems([]);
    setFlexError(null);
    (async () => {
      try {
        const r = await axios.post(`${BASE}/training_camp/backtest/time_flex`, {
          endDate,
          strategy,
          maxStartDate: maxStartDate || undefined,
        });
        if (!r.data?.success) {
          setFlexError(r.data?.message || '创建时间伸缩测试任务失败');
          return;
        }
        startPoll();
      } catch (e) {
        setFlexError(e.message || '创建时间伸缩测试任务失败，请检查后端服务');
      }
    })();
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startPoll = () => {
    stopPoll();
    setRunning(true);
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/time_flex/status`);
        const s = r.data || {};
        if (Array.isArray(s.result)) setItems(s.result);
        setProgress({ current: s.current || 0, total: s.total || 0, lastLog: s.lastLog || '' });
        if (s.status === 'done' || s.status === 'error') {
          stopPoll();
          setRunning(false);
          if (s.status === 'error' && s.error) setFlexError(s.error);
          else setFlexError(null);
        }
      } catch {
        // 继续等待
      }
    }, 2500);
  };

  // 手动重新启动（如用户点击「重新跑一次」）
  const handleRerun = async () => {
    setItems([]);
    setDetail(null);
    setFlexError(null);
    try {
      await axios.post(`${BASE}/training_camp/backtest/time_flex`, {
        endDate,
        strategy,
        maxStartDate: maxStartDate || undefined,
      });
      startPoll();
    } catch (e) {
      setFlexError(e.message || '创建时间伸缩测试任务失败');
    }
  };

  // 点击折线点：拉完整回测结果并展示在下方
  const handlePointClick = useCallback(async (startDateKey) => {
    const target = items.find((i) => i.startDate === startDateKey);
    if (!target) return;
    // 1) 先看 items 里是否已经有完整结果（如果 running 过程中已经返回就直接拿）
    if (target._fullResult) {
      setDetail(target._fullResult);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await axios.get(`${BASE}/training_camp/backtest/cache`, {
        params: { startDate: startDateKey, endDate, strategy },
      });
      if (r.data?.cached && r.data.result) {
        setDetail(r.data.result);
      } else {
        // 没有缓存，回测并拉
        const rt = await axios.post(`${BASE}/training_camp/backtest`, {
          startDate: startDateKey,
          endDate,
          strategy,
          force: false,
        });
        if (rt.data?.cached && rt.data.result) {
          setDetail(rt.data.result);
        } else if (rt.data?.taskId) {
          // 轮询一次
          for (let k = 0; k < 60; k++) {
            await new Promise((res) => setTimeout(res, 1000));
            const st = await axios.get(`${BASE}/training_camp/backtest/status/${rt.data.taskId}`);
            if (st.data?.status === 'done' && st.data.result) {
              setDetail(st.data.result);
              return;
            }
            if (st.data?.status === 'error') break;
          }
          message.error('回测超时');
        } else {
          message.error('未找到该窗口的回测结果');
        }
      }
    } catch (e) {
      message.error('拉取回测明细失败：' + (e.message || ''));
    } finally {
      setDetailLoading(false);
    }
  }, [items, endDate, strategy]);

  // Line chart 数据
  const lineChartData = useMemo(() => {
    const valid = items
      .filter((it) => it.summary && Number.isFinite(Number(it.summary.overallReturn)))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    return {
      labels: valid.map((it) => fmtDate(it.startDate)),
      datasets: [
        {
          label: '整体收益率 %',
          yAxisID: 'yLeft',
          data: valid.map((it) => Number(it.summary.overallReturn)),
          borderColor: '#1677ff',
          backgroundColor: 'rgba(22, 119, 255, 0.15)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: valid.map((it) => (Number(it.summary.overallReturn) >= 0 ? '#f5222d' : '#52c41a')),
          pointBorderColor: '#fff',
          pointBorderWidth: 1,
          tension: 0.25,
          fill: false,
        },
        {
          label: '胜率 %',
          yAxisID: 'yLeft',
          data: valid.map((it) => (it.summary.winRate != null ? Number(it.summary.winRate) : null)),
          borderColor: '#ff9800',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ff9800',
          pointBorderColor: '#fff',
          pointBorderWidth: 1,
          tension: 0.25,
          fill: false,
          spanGaps: true,
        },
        {
          label: '最大回撤 ×10',
          yAxisID: 'yRight',
          data: valid.map((it) => {
            const v = Number(it.summary.maxDrawdown);
            return Number.isFinite(v) ? v * 10 : null;
          }),
          borderColor: '#52c41a',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: '#52c41a',
          pointBorderColor: '#fff',
          pointBorderWidth: 1,
          tension: 0.25,
          fill: false,
          spanGaps: true,
        },
      ],
    };
  }, [items]);

  const lineChartOptions = useMemo(() => {
    const valid = items.filter((it) => it.summary && Number.isFinite(Number(it.summary.overallReturn)));
    const metaMap = {};
    valid.forEach((it) => { metaMap[fmtDate(it.startDate)] = it.summary; });
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: '#6b7890',
            font: { size: 11 },
            boxWidth: 14,
            boxHeight: 8,
            usePointStyle: true,
            padding: 12,
          },
        },
        tooltip: {
          backgroundColor: 'rgba(18, 33, 58, 0.92)',
          titleColor: '#fff',
          bodyColor: '#d1d9e6',
          borderColor: 'rgba(22,119,255,0.6)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: (ctx) => `起始日：${ctx[0].label}`,
            label: (ctx) => {
              const s = metaMap[ctx.label];
              if (!s) return '';
              if (ctx.datasetIndex === 0) {
                return [
                  `整体收益率：${fmtPct(s.overallReturn)}`,
                  `成交笔数：${s.tradeCount ?? 0}`,
                ];
              }
              if (ctx.datasetIndex === 1) {
                return [
                  `胜率：${s.winRate != null ? `${s.winRate.toFixed(1)}%` : '--'}`,
                  `盈利 ${s.winCount ?? 0} / ${s.tradeCount ?? 0}`,
                ];
              }
              if (ctx.datasetIndex === 2) {
                return [
                  `最大回撤：${fmtPct(s.maxDrawdown)}`,
                  `平均回撤：${fmtPct(s.avgDrawdown)}`,
                ];
              }
              return '';
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 45, minRotation: 45, color: '#6b7890' },
          grid: { color: 'rgba(18,33,58,0.05)' },
        },
        yLeft: {
          position: 'left',
          ticks: { color: '#6b7890', callback: (v) => `${v}%` },
          grid: { color: 'rgba(18,33,58,0.05)' },
        },
        yRight: {
          position: 'right',
          ticks: { color: '#52c41a', callback: (v) => `${(v / 10).toFixed(1)}%` },
          grid: { drawOnChartArea: false },
        },
      },
      onClick: (_e, elements) => {
        if (!elements || elements.length === 0) return;
        // 用 index 轴第一个点定位（不同 dataset 但同一个 x 位置）
        const idx = elements[0].index;
        const point = valid[idx];
        if (point) handlePointClick(point.startDate);
      },
    };
  }, [items, handlePointClick]);

  const summaryValidCount = items.filter((i) => i.summary).length;

  return (
    <Drawer
      open={open}
      onClose={() => {
        stopPoll();
        onClose?.();
      }}
      width={1280}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#12213a' }}>时间伸缩测试</span>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>{strategyName || strategy || '--'}</Tag>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            结束日 {fmtDate(endDate)}｜已跑完 {summaryValidCount} 个起始日
          </span>
        </div>
      }
      styles={{ body: { padding: 16, paddingBottom: 96, background: '#f7f9fc' } }}
      closable
      placement="right"
    >
      {/* 第一行：指数 K 线（三指数切换） */}
      <div style={{
        background: '#fff', borderRadius: 12, padding: 12, marginBottom: 16,
        boxShadow: '0 1px 4px rgba(18,33,58,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <SwapOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>基准指数日 K（可切换）</span>
          <div style={{ display: 'flex' }}>
            {
              [{color: '#9c27b0', label: '3日线'}, {color: '#2196f3', label: '5日线'}, {color: '#facc15', label: '10日线'}].map(i => (
                <div key={i.label} style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
                  <span style={{ color: i.color, fontSize: 12, fontWeight: 600 }}>{i.label}</span>
                </div>
              ))
            }
          </div>
          <Segmented
            size="small"
            value={indexType}
            onChange={(v) => setIndexType(v)}
            options={INDEX_OPTIONS.map((o) => ({ label: o.label, value: o.key }))}
            style={{ marginLeft: 'auto' }}
          />
        </div>
        {indexLoading ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin size="small" />
          </div>
        ) : indexError ? (
          <Empty description={indexError} />
        ) : (
          <div ref={klineContainerRef} style={{ width: '100%', height: 300 }} />
        )}
      </div>

      {/* 第二行：收益率折线图 */}
      <div style={{
        background: '#fff', borderRadius: 12, padding: 12, marginBottom: 16,
        boxShadow: '0 1px 4px rgba(18,33,58,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <SearchOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>
            收益率曲线（固定结束日 {fmtDate(endDate)}，横轴为回测起始日）
          </span>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            曲线为每个起始日→{fmtDate(endDate)} 的整体收益率；点按鼠标左键可打开该窗口完整回测
          </span>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={handleRerun}
            loading={running}
            style={{ marginLeft: 'auto', borderRadius: 999 }}
          >
            重新跑一次
          </Button>
        </div>

        {progress.total > 0 && (
          <div style={{ marginBottom: 8 }}>
            <Progress
              percent={Math.round((progress.current / progress.total) * 100)}
              status={running ? 'active' : flexError ? 'exception' : 'success'}
              size="small"
              format={() => `${progress.current}/${progress.total} 窗口`}
            />
            <div style={{ fontSize: 12, color: '#6b7890', marginTop: 4 }}>{progress.lastLog}</div>
          </div>
        )}

        {flexError && (
          <div style={{ fontSize: 12, color: '#cf1322', marginBottom: 8 }}>⚠️ {flexError}</div>
        )}

        {summaryValidCount === 0 && !running ? (
          <Empty description="暂无结果，点击「重新跑一次」发起时间伸缩测试" style={{ padding: '40px 0' }} />
        ) : (
          <div style={{ width: '100%', height: 320 }}>
            <Line ref={lineChartRef} data={lineChartData} options={lineChartOptions} />
          </div>
        )}
      </div>

      {/* 点击选中的窗口详情（完整回测报告） */}
      {detailLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
          <Spin size="large" />
          <span style={{ marginLeft: 12, fontSize: 12, color: '#6b7890', alignSelf: 'center' }}>正在拉取该窗口完整回测明细…</span>
        </div>
      )}
      {detail && !detailLoading && (
        <div style={{
          background: '#fff', borderRadius: 12, padding: 12,
          boxShadow: '0 1px 4px rgba(18,33,58,0.06)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>选中窗口完整回测报告</span>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              {fmtDate(detail?.range?.startDate)} → {fmtDate(detail?.range?.endDate)}
            </Tag>
            <Tag color={detail?.summary?.overallReturn >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
              整体收益 {fmtPct(detail?.summary?.overallReturn)}
            </Tag>
            <button
              type="button"
              onClick={() => setDetail(null)}
              style={{ marginLeft: 'auto', fontSize: 12, color: '#1677ff', border: 'none', background: 'transparent', cursor: 'pointer' }}
            >
              关闭
            </button>
          </div>
          <StrategyCard
            strategy={{
              id: detail?.strategy?.id || strategy,
              name: strategyName || detail?.strategy?.name || strategy,
              desc: detail?.strategy?.desc || '',
              summary: detail?.summary || null,
              trades: detail?.trades || [],
              currentHolding: detail?.currentHolding || null,
            }}
            rank={null}
          />
        </div>
      )}
    </Drawer>
  );
};

export default TimeFlexTestModal;
