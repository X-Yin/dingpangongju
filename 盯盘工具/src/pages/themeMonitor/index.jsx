import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Spin, Empty, Switch as AntSwitch, Tooltip, Modal, Select, Tabs, Input, Button, message, Segmented, Dropdown } from 'antd';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale,
  PointElement, LineElement, Tooltip as ChartTooltip, Filler, Legend,
} from 'chart.js';
import {
  FireOutlined, ThunderboltOutlined, AreaChartOutlined,
  RiseOutlined, FallOutlined, CaretDownOutlined, CaretUpOutlined,
  PieChartOutlined, AppstoreOutlined, LineChartOutlined,
  PlusOutlined, DeleteOutlined, PushpinOutlined,
} from '@ant-design/icons';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { parseMoneyValue, formatDisplayTime, aggregateFundByInterval } from '../../utils/fundAggregation';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import StockKLineModal from '../../components/StockKLineModal';
import StockHistoryAnalysisModal from '../../components/StockHistoryAnalysisModal';
import './index.scss';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip, Filler, Legend);

const TOP_THEME_COUNT = 6;
const CARD_LAYOUT_OPTIONS = [
  { label: '3 板块', value: 3 },
  { label: '6 板块', value: 6 },
];
const PIN_STORAGE_KEY = 'theme_monitor_pinned_stocks'; // { [themeKey]: [{ code, pinnedAt }] }
const FAST_POLL_INTERVAL = 3000; // 龙头 + 置顶个股行情刷新间隔（其余个股仍跟随 10s 聚合轮询）
const CHIP_THEME_COUNT = 9; // 横幅条题材 chip 上限（与后端 /theme_monitor_all 一致）
const API_BASE = `http://${local_ip}:3000`;

const formatPct = (v, { sign = true } = {}) => {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return '--';
  const num = Number(v);
  const prefix = sign && num > 0 ? '+' : '';
  return `${prefix}${num.toFixed(2)}%`;
};

const fmt = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? '--' : Number(v));

// 按实时行情判断个股当前是否封在涨停价：
// 创业板(300/301)/科创板(688/689) 20%，主板 ST 5%，其余主板 10%；涨停价 = 昨收 × (1 + 幅度) 四舍五入到分
const isStockLimitUp = (stock, quote) => {
  if (!quote || quote.suspended) return false;
  const prev = Number(quote.prevClose);
  const last = Number(quote.price);
  if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(last) || last <= 0) return false;
  const pureCode = String(quote.code || '').replace(/^[a-zA-Z]+/, '');
  let pct = 0.1;
  if (/^(300|301|688|689)/.test(pureCode)) pct = 0.2;
  else if (/ST/i.test(String(stock?.name || ''))) pct = 0.05;
  const limitPrice = Math.round(prev * (1 + pct) * 100) / 100;
  return last >= limitPrice - 0.0001;
};

// A 股严重异常波动（异动）指标：连续 10 个交易日累计涨幅 +100% / 跌幅 -50%，
// 连续 30 个交易日累计涨幅 +200% / 跌幅 -70%（以收盘价累计涨跌幅近似交易所的偏离值累计）
const ABNORMAL_ALERT_RULES = [
  { days: 10, up: 100, down: -50 },
  { days: 30, up: 200, down: -70 },
];
const ABNORMAL_ALERT_NEAR_POINTS = 10; // 距阈值 10 个百分点以内视为「临近异动」

// 结合「历史基准收盘价 + 当前实时价」计算某只个股的异动状态
// 返回 { level: 'trigger' | 'near', days, threshold, currentPct, targetPrice, gap }，未临近时返回 null
const getAbnormalAlert = (basis, price) => {
  const last = Number(price);
  if (!basis || !Number.isFinite(last) || last <= 0) return null;
  const candidates = [];
  ABNORMAL_ALERT_RULES.forEach(({ days, up, down }) => {
    const base = Number(days === 10 ? basis.base10 : basis.base30);
    if (!Number.isFinite(base) || base <= 0) return;
    const currentPct = (last / base - 1) * 100;
    [up, down].forEach((threshold) => {
      const dir = threshold > 0 ? 1 : -1;
      const gap = dir > 0 ? threshold - currentPct : currentPct - threshold;
      const targetPrice = base * (1 + threshold / 100);
      if (gap <= 0) candidates.push({ level: 'trigger', days, threshold, currentPct, targetPrice, gap: 0 });
      else if (gap <= ABNORMAL_ALERT_NEAR_POINTS) {
        candidates.push({ level: 'near', days, threshold, currentPct, targetPrice, gap });
      }
    });
  });
  if (candidates.length === 0) return null;
  const triggered = candidates.filter((c) => c.level === 'trigger');
  if (triggered.length > 0) return triggered.sort((a, b) => a.days - b.days)[0];
  return candidates.sort((a, b) => a.gap - b.gap)[0];
};

// ==================== 情绪温度历史弹窗（点击概览"情绪"卡片打开） ====================
const SentimentHistoryModal = ({ visible, onCancel }) => {
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    axios.get(`http://${local_ip}:3000/lianban_sentiment_series`)
      .then((res) => {
        if (!cancelled) setSeries(Array.isArray(res.data) ? res.data : []);
      })
      .catch((err) => {
        console.error('获取情绪历史失败:', err);
        if (!cancelled) setSeries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [visible]);

  const chartData = useMemo(() => ({
    labels: series.map((s) => (s.pageDate || '').slice(5) || s.date),
    datasets: [{
      label: '情绪温度',
      data: series.map((s) => s.temperature),
      borderColor: '#7c3aed',
      backgroundColor: 'rgba(124, 58, 237, 0.08)',
      fill: true,
      tension: 0.3,
      pointRadius: 2.5,
      pointHoverRadius: 5,
      pointBackgroundColor: '#7c3aed',
      spanGaps: true,
    }],
  }), [series]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => {
            const s = series[items[0]?.dataIndex];
            return s ? `${s.pageDate || s.date} · ${s.phase || '情绪'}` : '';
          },
          label: (item) => {
            const s = series[item.dataIndex];
            return [
              s?.temperature != null ? `情绪温度: ${s.temperature}°` : '情绪温度: --',
              `涨停: ${s?.limitUp != null ? s.limitUp : '--'} 家`,
              `跌停: ${s?.limitDown != null ? s.limitDown : '--'} 家`,
            ];
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0, font: { size: 10 }, color: '#6b7890' },
      },
      y: {
        title: { display: true, text: '温度', font: { size: 10 }, color: '#6b7890' },
        ticks: { callback: (v) => `${v}°`, font: { size: 10 }, color: '#6b7890' },
        grid: { color: 'rgba(18, 33, 58, 0.06)' },
      },
    },
  }), [series]);

  return (
    <Modal
      title="情绪温度历史"
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={860}
      destroyOnHidden
    >
      <Spin spinning={loading}>
        {series.length > 0 ? (
          <div className="tm-sentiment-chart">
            <Line data={chartData} options={chartOptions} />
            {/* <div className="tm-sentiment-chart-tip">悬停查看每日情绪阶段 / 温度 / 涨跌停家数；历史日期跌停数据未存档时显示 --</div> */}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '加载中...' : '暂无情绪历史数据'} style={{ padding: '48px 0' }} />
        )}
      </Spin>
    </Modal>
  );
};

// ==================== 题材历史弹窗（点击题材标题打开） ====================
// 折线：市场情绪（紫，左轴）+ 各选中题材每日涨停数（初始题材蓝，其余配色区分，右轴）
// 悬浮 tooltip：各线数值 + 当日涨停最多的题材；点击图表选日期，右侧展示该日各题材涨停股列表
const THEME_LINE_COLORS = ['#13c2c2', '#fa8c16', '#eb2f96', '#52c41a', '#2f54eb', '#a0d911'];

const ThemeBacktrackPanel = ({ active, initialTheme, onOpenStockKline }) => {
  const [history, setHistory] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [stocksByTheme, setStocksByTheme] = useState({});
  const [stocksLoading, setStocksLoading] = useState(false);
  const stocksCacheRef = useRef(new Map()); // `${date}|${key}` -> stocks
  const chartRef = useRef(null);

  // 打开时拉取近 30 日历史，默认选中点击的题材 + 最新日期
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setHistory(null);
    setSelectedDate(null);
    setStocksByTheme({});
    stocksCacheRef.current.clear();
    setSelectedKeys(initialTheme?.key ? [initialTheme.key] : []);
    axios.get(`http://${local_ip}:3000/theme_history`, { params: { days: 30 } })
      .then((res) => {
        if (cancelled) return;
        const d = res.data || {};
        setHistory(d);
        const dates = d.dates || [];
        if (dates.length > 0) setSelectedDate(dates[dates.length - 1]);
      })
      .catch((err) => {
        console.error('获取题材历史失败:', err);
        if (!cancelled) setHistory({ dates: [], sentiment: [], themeCounts: {}, topByDate: [] });
      });
    return () => { cancelled = true; };
  }, [active, initialTheme]);

  // 拉取选中日期各题材的涨停股列表（前端缓存避免重复请求）
  useEffect(() => {
    if (!active || !selectedDate || selectedKeys.length === 0) {
      if (selectedKeys.length === 0) setStocksByTheme({});
      return;
    }
    const cache = stocksCacheRef.current;
    const missing = selectedKeys.filter((k) => !cache.has(`${selectedDate}|${k}`));
    if (missing.length === 0) {
      setStocksByTheme(Object.fromEntries(selectedKeys.map((k) => [k, cache.get(`${selectedDate}|${k}`) || []])));
      return;
    }
    let cancelled = false;
    setStocksLoading(true);
    Promise.all(missing.map((k) => (
      axios.get(`http://${local_ip}:3000/theme_day_stocks`, { params: { date: selectedDate, theme: k } })
        .then((res) => [k, res.data?.stocks || []])
        .catch(() => [k, []])
    ))).then((entries) => {
      if (cancelled) return;
      entries.forEach(([k, stocks]) => cache.set(`${selectedDate}|${k}`, stocks));
      setStocksByTheme(Object.fromEntries(selectedKeys.map((k) => [k, cache.get(`${selectedDate}|${k}`) || []])));
      setStocksLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, selectedDate, selectedKeys]);

  const themeOptions = useMemo(() => {
    if (!history?.themeCounts) return [];
    return Object.entries(history.themeCounts)
      .map(([key, t]) => ({ value: key, name: t.name, total: t.total }))
      .sort((a, b) => b.total - a.total)
      .map(({ value, name, total }) => ({ value, label: `${name}（30日${total}家）` }));
  }, [history]);

  const chartData = useMemo(() => {
    if (!history) return null;
    const labels = (history.dates || []).map((d) => `${d.slice(4, 6)}/${d.slice(6, 8)}`);
    const datasets = [{
      label: '市场情绪',
      data: (history.sentiment || []).map((s) => (s && s.temperature != null ? s.temperature : null)),
      borderColor: '#7c3aed',
      backgroundColor: 'rgba(124, 58, 237, 0.06)',
      borderDash: [6, 4],
      fill: true,
      tension: 0.3,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: '#7c3aed',
      yAxisID: 'y',
    }];
    selectedKeys.forEach((k, i) => {
      const t = history.themeCounts?.[k];
      if (!t) return;
      const color = k === initialTheme?.key ? '#1890ff' : THEME_LINE_COLORS[i % THEME_LINE_COLORS.length];
      datasets.push({
        label: `${t.name} 涨停`,
        data: t.counts,
        borderColor: color,
        backgroundColor: color,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4,
        yAxisID: 'y1',
      });
    });
    return { labels, datasets };
  }, [history, selectedKeys, initialTheme]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    onClick: (event) => {
      const chart = chartRef.current;
      if (!chart || !history?.dates?.length) return;
      const elements = chart.getElementsAtEventForMode(event.native || event, 'index', { intersect: false }, false);
      const idx = elements[0]?.index;
      if (idx != null && history.dates[idx]) setSelectedDate(history.dates[idx]);
    },
    plugins: {
      legend: { display: true, labels: { boxWidth: 14, font: { size: 10 } } },
      tooltip: {
        callbacks: {
          title: (items) => {
            const idx = items[0]?.dataIndex;
            const d = history?.dates?.[idx];
            return d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
          },
          label: (item) => (item.datasetIndex === 0
            ? `市场情绪: ${item.parsed.y != null ? item.parsed.y : '--'}°`
            : `${item.dataset.label}: ${item.parsed.y ?? 0} 家`),
          afterBody: (items) => {
            const idx = items[0]?.dataIndex;
            const top = history?.topByDate?.[idx];
            return top ? [`当日涨停最多: ${top.board}（${top.count} 家）`] : [];
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { autoSkip: true, maxTicksLimit: 15, maxRotation: 0, font: { size: 10 }, color: '#6b7890' },
      },
      y: {
        position: 'left',
        title: { display: true, text: '温度', font: { size: 10 }, color: '#7c3aed' },
        ticks: { callback: (v) => `${v}°`, font: { size: 10 }, color: '#6b7890' },
        grid: { color: 'rgba(18, 33, 58, 0.06)' },
      },
      y1: {
        position: 'right',
        beginAtZero: true,
        title: { display: true, text: '涨停家数', font: { size: 10 }, color: '#1890ff' },
        ticks: { precision: 0, font: { size: 10 }, color: '#6b7890' },
        grid: { display: false },
      },
    },
  }), [history]);

  const selectedDateLabel = selectedDate
    ? `${selectedDate.slice(4, 6)}-${selectedDate.slice(6, 8)}`
    : '';

  return (
    <div className="tm-th-wrap">
        <div className="tm-th-toolbar">
          <span className="tm-th-toolbar-label">对比题材</span>
          <Select
            mode="multiple"
            showSearch
            allowClear
            placeholder="搜索历史题材后添加，可添加多个"
            value={selectedKeys}
            onChange={setSelectedKeys}
            options={themeOptions}
            optionFilterProp="label"
            maxTagCount="responsive"
            style={{ flex: 1, minWidth: 0 }}
            size="small"
          />
          {selectedDateLabel && (
            <span className="tm-th-toolbar-date">已选日期 <b>{selectedDateLabel}</b>（点击图表切换）</span>
          )}
        </div>
        <div className="tm-th-body">
          <div className="tm-th-chart">
            {chartData && chartData.labels.length > 0 ? (
              <Line ref={chartRef} data={chartData} options={chartOptions} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={history ? '暂无题材历史数据' : '加载中...'} style={{ paddingTop: 120 }} />
            )}
          </div>
          <div className="tm-th-lists">
            {selectedKeys.map((k) => {
              const t = history?.themeCounts?.[k];
              const stocks = stocksByTheme[k] || [];
              return (
                <div key={k} className="tm-th-stocklist">
                  <div className="tm-th-stocklist-header">
                    <span className="tm-th-stocklist-name">{t?.name || k}</span>
                    <span className="tm-th-stocklist-meta">{selectedDateLabel} 涨停 {stocks.length} 家</span>
                  </div>
                  <div className="tm-th-stocklist-body">
                    {stocks.length === 0 ? (
                      <div className="tm-th-stocklist-empty">{stocksLoading ? '加载中...' : '当日该题材无涨停数据'}</div>
                    ) : stocks.map((s) => (
                      <div key={s.code} className="tm-th-stock-row">
                        <span
                          className="tm-th-stock-name"
                          onClick={() => s.marketCode && onOpenStockKline?.(s)}
                          title={s.marketCode ? '点击查看 K 线' : ''}
                        >
                          {s.name}
                        </span>
                        <span className="tm-th-stock-lianban">{s.lianbanText || '首板'}</span>
                        <span className={`tm-th-stock-change ${Number(s.changePct) >= 0 ? 'up' : 'down'}`}>
                          {formatPct(s.changePct)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {selectedKeys.length === 0 && (
              <div className="tm-th-stocklist-empty" style={{ padding: '40px 0' }}>暂未选择题材</div>
            )}
          </div>
        </div>
    </div>
  );
};

// ==================== 新增自定义题材弹窗 ====================
// 批量解析股票文本（每行一个名称或代码，支持逗号/空格分隔）→ [{code, name}]
// code 为带市前缀的 marketCode（/search_stock 返回格式），解析不到的行原样记录在 failed
const resolveStockLines = async (text) => {
  const lines = Array.from(new Set(
    String(text || '').split(/[\n,，;；、\s]+/).map((s) => s.trim()).filter(Boolean),
  ));
  const settled = await Promise.all(lines.map(async (line) => {
    try {
      const res = await axios.get(`${API_BASE}/search_stock`, { params: { query: line } });
      const first = (res.data?.data || [])[0];
      return first?.code ? { code: String(first.code), name: first.name || first.code } : { line, failed: true };
    } catch {
      return { line, failed: true };
    }
  }));
  const stocks = [];
  const failed = [];
  const seen = new Set();
  settled.forEach((r) => {
    if (r.failed) { failed.push(r.line); return; }
    if (seen.has(r.code)) return;
    seen.add(r.code);
    stocks.push({ code: r.code, name: r.name });
  });
  return { stocks, failed };
};

const CustomThemeModal = ({ visible, onCancel, onSaved }) => {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [wasVisible, setWasVisible] = useState(visible);

  // 每次打开时重置表单（渲染期同步重置，避免 effect 级联渲染）
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) { setName(''); setText(''); setSaving(false); }
  }

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { message.warning('请输入题材名称'); return; }
    setSaving(true);
    try {
      const { stocks, failed } = await resolveStockLines(text);
      const res = await axios.post(`${API_BASE}/theme_custom/save_theme`, { name: trimmed, stocks });
      if (res.data?.success) {
        message.success(`已新增自定义题材「${trimmed}」（${stocks.length} 只股票）${failed.length ? `，${failed.length} 个未解析：${failed.join('、')}` : ''}`);
        await onSaved?.();
        onCancel?.();
      } else {
        message.error(res.data?.message || '保存失败');
      }
    } catch {
      message.error('保存自定义题材失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="新增自定义题材"
      open={visible}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={saving}
      okText="保存"
      destroyOnHidden
      width={520}
    >
      <div className="tm-ct-form">
        <div className="tm-ct-field">
          <span className="tm-ct-label">题材名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：低空经济" maxLength={20} />
        </div>
        <div className="tm-ct-field">
          <span className="tm-ct-label">题材股票</span>
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder="每行一个股票名称或代码（支持逗号/空格分隔），保存时自动解析"
          />
        </div>
      </div>
    </Modal>
  );
};

// ==================== 题材设置弹窗（基础配置 / 题材回溯） ====================
const ThemeSettingsModal = ({ visible, onCancel, initialTheme, onOpenStockKline, customStore, onSaved }) => {
  const [tab, setTab] = useState('base');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [wasVisible, setWasVisible] = useState(false);

  // 每次打开时重置为基础配置 tab（渲染期同步重置，避免 effect 级联渲染）
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) { setTab('base'); setText(''); setSaving(false); }
  }

  const isCustom = !!initialTheme?.custom;
  const storeTheme = useMemo(
    () => (customStore?.themes || []).find((t) => t.id === initialTheme?.id) || null,
    [customStore, initialTheme],
  );
  const override = customStore?.overrides?.[initialTheme?.key] || null;

  // 当前题材股票列表：系统题材用分析结果（已含覆盖后的增删），自定义题材用 store 原始数据
  const currentStocks = useMemo(() => {
    if (isCustom) {
      return (storeTheme?.stocks || [])
        .map((s) => ({ code: String(s.code || '').trim(), name: s.name }))
        .filter((s) => s.code);
    }
    return (initialTheme?.stocks || [])
      .map((s) => ({ code: String(s.marketCode || s.code || '').trim(), name: s.name }))
      .filter((s) => s.code);
  }, [isCustom, storeTheme, initialTheme]);

  const themeName = storeTheme?.name || initialTheme?.board || '';

  const handleDelete = async (code) => {
    if (saving) return;
    setSaving(true);
    try {
      if (isCustom) {
        const next = currentStocks.filter((s) => s.code !== code);
        const res = await axios.post(`${API_BASE}/theme_custom/save_theme`, { id: storeTheme?.id, name: themeName, stocks: next });
        if (!res.data?.success) throw new Error(res.data?.message);
      } else {
        const prevAdded = override?.added || [];
        const wasAdded = prevAdded.some((s) => String(s.code).trim() === code);
        const added = prevAdded.filter((s) => String(s.code).trim() !== code);
        const removedSet = new Set((override?.removed || []).map((c) => String(c).trim()));
        if (!wasAdded) removedSet.add(code);
        const res = await axios.post(`${API_BASE}/theme_custom/save_override`, {
          themeKey: initialTheme.key, added, removed: Array.from(removedSet),
        });
        if (!res.data?.success) throw new Error(res.data?.message);
      }
      message.success('已删除股票');
      await onSaved?.();
    } catch (e) {
      message.error(e.message || '删除失败');
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    const trimmed = text.trim();
    if (!trimmed) { message.warning('请输入股票名称或代码'); return; }
    setSaving(true);
    try {
      const { stocks: parsed, failed } = await resolveStockLines(trimmed);
      if (parsed.length === 0) { message.warning('未解析到有效股票'); return; }
      if (isCustom) {
        const existing = new Set(currentStocks.map((s) => s.code));
        const next = [...currentStocks, ...parsed.filter((p) => !existing.has(p.code))];
        const res = await axios.post(`${API_BASE}/theme_custom/save_theme`, { id: storeTheme?.id, name: themeName, stocks: next });
        if (!res.data?.success) throw new Error(res.data?.message);
      } else {
        const prevAdded = override?.added || [];
        const removedSet = new Set((override?.removed || []).map((c) => String(c).trim()));
        const existing = new Set([...currentStocks.map((s) => s.code), ...prevAdded.map((s) => String(s.code).trim())]);
        const addedMap = new Map(prevAdded.map((s) => [String(s.code).trim(), { code: String(s.code).trim(), name: s.name }]));
        parsed.forEach((p) => {
          const c = String(p.code).trim();
          removedSet.delete(c);
          if (!existing.has(c)) { addedMap.set(c, { code: c, name: p.name }); existing.add(c); }
        });
        const res = await axios.post(`${API_BASE}/theme_custom/save_override`, {
          themeKey: initialTheme.key, added: Array.from(addedMap.values()), removed: Array.from(removedSet),
        });
        if (!res.data?.success) throw new Error(res.data?.message);
      }
      message.success(`已添加 ${parsed.length} 只股票${failed.length ? `，${failed.length} 个未解析` : ''}`);
      setText('');
      await onSaved?.();
    } catch (e) {
      message.error(e.message || '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`「${initialTheme?.board || ''}」题材设置`}
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={1280}
      destroyOnHidden
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'base',
            label: '基础配置',
            children: (
              <div className="tm-ts-base">
                <div className="tm-ts-base-header">
                  <span className="tm-ts-base-title">题材股票（{currentStocks.length}）</span>
                  <span className="tm-ts-base-sub">{isCustom ? '自定义题材' : '系统题材'} · 增删即时生效</span>
                </div>
                <div className="tm-ts-stock-list">
                  {currentStocks.length === 0 ? (
                    <div className="tm-ts-empty">暂无股票，请在下方添加</div>
                  ) : currentStocks.map((s) => (
                    <div key={s.code} className="tm-ts-stock-row">
                      <span className="tm-ts-stock-name">{s.name}</span>
                      <span className="tm-ts-stock-code">{s.code}</span>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={saving}
                        onClick={() => handleDelete(s.code)}
                      />
                    </div>
                  ))}
                </div>
                <div className="tm-ts-add">
                  <Input.TextArea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={4}
                    placeholder="批量添加：每行一个股票名称或代码（支持逗号/空格分隔）"
                  />
                  <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={handleAdd}>添加股票</Button>
                </div>
              </div>
            ),
          },
          {
            key: 'back',
            label: '题材回溯',
            children: (
              <ThemeBacktrackPanel
                active={tab === 'back'}
                initialTheme={initialTheme}
                onOpenStockKline={onOpenStockKline}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
};

// ==================== 顶部情绪概览行 ====================
const OverviewBar = ({ overview, onOpenSentiment }) => {
  const kpi = overview?.kpi || {};
  const sentiment = overview?.sentiment || {};
  const items = [
    { label: '情绪', value: sentiment.phase || '--', extra: sentiment.temperature != null ? `${sentiment.temperature}°` : '--', cls: 'phase', clickable: true },
    { label: '涨停', value: fmt(kpi.limitUpCount), cls: 'up' },
    { label: '跌停', value: fmt(kpi.limitDownCount), cls: 'down' },
    { label: '连板', value: fmt(kpi.lianbanCount), cls: 'up' },
    { label: '最高板', value: kpi.maxLianban ? `${kpi.maxLianban.value}${kpi.maxLianban.unit || '板'}` : '--', cls: 'gold' },
    { label: '封板率', value: kpi.sealRate != null ? `${kpi.sealRate}%` : '--', cls: 'plain' },
    { label: '炸板', value: fmt(kpi.brokenBoardCount), cls: 'warn' },
    { label: '上涨/下跌', value: kpi.upCount != null ? `${fmt(kpi.upCount)}/${fmt(kpi.downCount)}` : '--', cls: 'plain' },
    { label: '两市成交', value: kpi.totalAmount || '--', cls: 'plain' },
  ];
  return (
    <div className="tm-overview">
      <div className="tm-overview-title">
        <FireOutlined className="tm-overview-icon" />
        <span>市场情绪</span>
        <span className="tm-overview-date">{overview?.pageDate || ''}</span>
      </div>
      <div className="tm-overview-cards">
        {items.map((it) => (
          <div
            key={it.label}
            className={`tm-kpi-card tm-kpi-${it.cls}${it.clickable ? ' clickable' : ''}`}
            onClick={it.clickable ? onOpenSentiment : undefined}
            title={it.clickable ? '点击查看情绪温度历史' : undefined}
          >
            <div className="tm-kpi-label">{it.label}</div>
            <div className="tm-kpi-value">{it.value}</div>
            {it.extra && <div className="tm-kpi-extra">{it.extra}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

// ==================== 题材横幅条（可拖拽排序 + 新增/删除自定义题材） ====================
const ThemeChip = ({ chip, quotes, onDeleteCustom }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chip.key });
  const isMain = chip.type === '主线';
  // 今日实时涨停家数：按涨停价规则（主板/创业科创/ST 区分）对题材股票池逐只判断
  const cnt = (chip.stocks || []).filter((s) => isStockLimitUp(s, quotes?.[s.marketCode])).length;
  const cls = `tm-line-chip ${isMain ? 'main' : chip.custom ? 'custom' : 'branch'}${isDragging ? ' is-dragging' : ''}`;
  return (
    <Tooltip
      title={chip.custom
        ? `${chip.board} · 自定义题材 · 今日涨停 ${cnt} 家（双击删除）`
        : `${chip.board} · ${chip.type} · 权重 ${chip.score} · 今日涨停 ${cnt} 家`}
    >
      <span
        ref={setNodeRef}
        className={cls}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        onDoubleClick={chip.custom ? () => onDeleteCustom?.(chip) : undefined}
        {...attributes}
        {...listeners}
      >
        {chip.board}
        <em>{cnt > 0 ? `${cnt}家` : '--'}</em>
        {chip.custom && <i className="tm-line-chip-custom-tag">自定义</i>}
      </span>
    </Tooltip>
  );
};

const ThemeChipsStrip = ({ chips, quotes, onOpenHistoryAnalysis, onAddTheme, onDeleteCustom, onReorder, cardCount, onCardCountChange }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = chips.findIndex((c) => c.key === active.id);
    const newIndex = chips.findIndex((c) => c.key === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder?.(arrayMove(chips, oldIndex, newIndex).map((c) => c.key));
  };
  return (
    <div className="tm-mainline-strip">
      {chips.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={chips.map((c) => c.key)} strategy={horizontalListSortingStrategy}>
            <div className="tm-line-chips">
              {chips.map((chip) => (
                <ThemeChip key={chip.key} chip={chip} quotes={quotes} onDeleteCustom={onDeleteCustom} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <span className="tm-line-empty">暂无题材数据</span>
      )}
      <div className="tm-line-actions">
        <Segmented
          size="small"
          value={cardCount}
          options={CARD_LAYOUT_OPTIONS}
          onChange={onCardCountChange}
          title="切换下方板块卡片数量"
        />
        <button type="button" className="tm-add-theme-btn" onClick={onAddTheme}>
          <PlusOutlined /> 新增板块
        </button>
        <button type="button" className="tm-history-analysis-btn" onClick={onOpenHistoryAnalysis}>
          <LineChartOutlined /> 个股历史分析
        </button>
      </div>
    </div>
  );
};

// ==================== 自选股板块涨跌幅前十（市场情绪下方） ====================
const BlockRankingStrip = ({ blocks, onOpenKline }) => {
  if (!blocks) return null;
  const renderGroup = (list, type) => (
    <div className={`tm-blk-group ${type}`}>
      <span className="tm-blk-label">{type === 'up' ? '涨幅前十' : '跌幅前十'}</span>
      {(list || []).map((b, idx) => (
        <Tooltip
          key={`${b.blockName}-${idx}`}
          title={(b.stocks || []).length > 0 ? (
            <div className="tm-blk-tip">
              {b.stocks.map((s) => (
                <div
                  key={s.code}
                  className="tm-blk-tip-row clickable"
                  onClick={() => s.code && onOpenKline?.({ marketCode: s.code, name: s.name })}
                  title="点击查看 K 线"
                >
                  <span className="tm-blk-tip-name">{s.name}</span>
                  <span className={s.change >= 0 ? 'up' : 'down'}>{formatPct(s.change)}</span>
                </div>
              ))}
            </div>
          ) : '暂无成分股行情'}
        >
          <span className={`tm-blk-chip ${type}`}>
            <em className="tm-blk-idx">{idx + 1}</em>
            <span className="tm-blk-name">{b.blockName}</span>
            <b className={b.avgChange >= 0 ? 'up' : 'down'}>{formatPct(b.avgChange)}</b>
            {!!b.rankChange && (
              <i className={`tm-blk-rank ${b.rankChange > 0 ? 'up' : 'down'}`}>
                {b.rankChange > 0 ? <CaretUpOutlined /> : <CaretDownOutlined />}
                {Math.abs(b.rankChange)}
              </i>
            )}
          </span>
        </Tooltip>
      ))}
    </div>
  );
  return (
    <div className="tm-block-ranking">
      <div className="tm-blk-title"><AppstoreOutlined /> 板块涨跌幅前十</div>
      <div className="tm-blk-groups">
        {renderGroup(blocks.first, 'up')}
        {renderGroup(blocks.last, 'down')}
      </div>
    </div>
  );
};

// ==================== 题材卡片（第一列） ====================
const ThemeCard = ({ theme, quotes, onOpenKline, sortDir, onToggleSort, onOpenThemeHistory, pins, onPin, onUnpin, alertBasis }) => {
  const dragonCodes = useMemo(() => new Set(theme.dragons.map((d) => d.code)), [theme]);
  // 「今日 N 家」点击后仅展示当日涨停股，再次点击恢复全量
  const [limitOnly, setLimitOnly] = useState(false);

  // 置顶股票：按置顶时间倒序（越晚置顶越靠前），仅保留当前题材仍存在的个股
  // 龙头本身已固定在最前，不重复参与置顶区
  const pinnedStocks = useMemo(() => {
    const byCode = new Map(theme.stocks.map((s) => [s.code, s]));
    return (pins || [])
      .slice()
      .sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0))
      .map((p) => byCode.get(p.code))
      .filter((s) => s && !dragonCodes.has(s.code));
  }, [pins, theme, dragonCodes]);

  const pinnedCodes = useMemo(() => new Set(pinnedStocks.map((s) => s.code)), [pinnedStocks]);

  // 今日实时涨停家数：按涨停价规则（主板/创业科创/ST 区分）对题材股票池逐只判断
  const todayLiveCount = useMemo(
    () => theme.stocks.filter((s) => isStockLimitUp(s, quotes[s.marketCode])).length,
    [theme, quotes],
  );

  const restStocks = useMemo(() => {
    const rest = theme.stocks.filter((s) => !dragonCodes.has(s.code) && !pinnedCodes.has(s.code));
    const dir = sortDir === 'asc' ? 1 : -1;
    const valOf = (s) => {
      const q = quotes[s.marketCode];
      if (!q || q.suspended) return null;
      const v = Number(q.changePct);
      return Number.isFinite(v) ? v : null;
    };
    return [...rest].sort((a, b) => {
      const va = valOf(a);
      const vb = valOf(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // 停牌/无行情股固定排最后
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }, [theme, quotes, sortDir, dragonCodes, pinnedCodes]);

  const avgChange = useMemo(() => {
    const vals = theme.stocks
      .filter((s) => !quotes[s.marketCode]?.suspended)
      .map((s) => Number(quotes[s.marketCode]?.changePct))
      .filter((v) => v != null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [theme, quotes]);

  // 仅涨停筛选：龙头、置顶与其余个股各自过滤
  const dragonsShown = useMemo(
    () => (limitOnly ? theme.dragons.filter((s) => isStockLimitUp(s, quotes[s.marketCode])) : theme.dragons),
    [limitOnly, theme, quotes],
  );
  const pinnedShown = useMemo(
    () => (limitOnly ? pinnedStocks.filter((s) => isStockLimitUp(s, quotes[s.marketCode])) : pinnedStocks),
    [limitOnly, pinnedStocks, quotes],
  );
  const restShown = useMemo(
    () => (limitOnly ? restStocks.filter((s) => isStockLimitUp(s, quotes[s.marketCode])) : restStocks),
    [limitOnly, restStocks, quotes],
  );
  const shownCount = dragonsShown.length + pinnedShown.length + restShown.length;

  const DRAGON_NAMES = ['龙一', '龙二', '龙三', '龙四', '龙五'];

  const renderRow = (stock, idx, isDragon, isPinned) => {
    const q = quotes[stock.marketCode];
    const suspended = !!q?.suspended;
    const change = suspended ? null : q?.changePct;
    const upCls = change == null ? '' : Number(change) >= 0 ? 'up' : 'down';
    const badge = isDragon ? DRAGON_NAMES[idx] : isPinned ? '顶' : idx + 1;
    const alert = suspended ? null : getAbnormalAlert(alertBasis?.[stock.marketCode], q?.price);
    const alertTip = alert
      ? `当前价 ${Number(q.price).toFixed(2)}，异动价 ${alert.targetPrice.toFixed(2)}\n`
        + `连续 ${alert.days} 个交易日累计${alert.threshold > 0 ? '涨幅' : '跌幅'}达 ${formatPct(alert.threshold, { sign: false })}`
        + `（当前 ${formatPct(alert.currentPct)}）`
      : '';
    return (
      <Dropdown
        key={`${stock.code}-${idx}`}
        trigger={['contextMenu']}
        menu={{
          items: isPinned
            ? [{ key: 'unpin', label: '取消置顶' }]
            : [{ key: 'pin', label: '置顶', icon: <PushpinOutlined /> }],
          onClick: ({ key }) => {
            if (key === 'pin') onPin?.(theme.key, stock);
            if (key === 'unpin') onUnpin?.(theme.key, stock);
          },
        }}
      >
        <div
          className={`tm-stock-row${isDragon ? ' is-dragon' : ''}${isPinned ? ' is-pinned' : ''}${suspended ? ' is-suspended' : ''}`}
          data-is-up={change != null && Number(change) >= 0 ? 'true' : 'false'}
        >
          <span className={`tm-dragon-badge d${isDragon ? stock.dragonRank || 0 : 0}${isPinned ? ' pinned' : ''}`}>{badge}</span>
          <div className="tm-stock-info" title={stock.concept}>
            <div className="tm-stock-name-row">
              <span className="tm-stock-name" onClick={() => onOpenKline(stock)}>{stock.name}</span>
              {alert && (
                <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{alertTip}</span>}>
                  <span className={`tm-alert-tag ${alert.level}`}>
                    {alert.level === 'trigger' ? '触发异动' : '临近异动'}
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
          <div className="tm-lianban-cell" title={`近10日涨停 ${stock.limitUpDays} 次${stock.isLeader ? ' · 题材龙头' : ''}`}>
            {stock.lianbanText || '首板'}
            {stock.limitUpDays > 1 && <em>{stock.limitUpDays}次</em>}
          </div>
          <div className="tm-change-cell">
            {suspended ? (
              <span className="tm-suspended-tag">停牌</span>
            ) : (
              <span className={`tm-current-change ${upCls}`}>{formatPct(change)}</span>
            )}
          </div>
        </div>
      </Dropdown>
    );
  };

  return (
    <div className={`tm-theme-card ${theme.type === '主线' ? 'main' : 'branch'}`}>
      <div className="tm-theme-header">
        <div className="tm-theme-title-icon"><FireOutlined /></div>
        <div className="tm-theme-title-content">
          <div className="tm-theme-title-row">
            <span className={`tm-theme-rank ${theme.custom ? 'custom' : `r${theme.rank}`}`}>{theme.custom ? '自' : theme.rank}</span>
            <span className="tm-theme-name" onClick={() => onOpenThemeHistory?.(theme)} title="点击打开题材设置（基础配置 / 题材回溯）">{theme.board}</span>
            <span className={`tm-theme-type ${theme.custom ? 'custom' : theme.type === '主线' ? 'main' : 'branch'}`}>{theme.type}</span>
          </div>
          {theme.custom ? (
            <span className="tm-theme-subtext">自定义题材 · {theme.stockCount ?? theme.stocks.length} 只</span>
          ) : (
            <span className="tm-theme-subtext">WEIGHT {theme.score} · {theme.totalLimitUp} LIMIT-UP · 10D</span>
          )}
        </div>
        <div className="tm-theme-extra">
          <span
            className={`tm-theme-today${limitOnly ? ' active' : ''}`}
            onClick={() => setLimitOnly((v) => !v)}
            title={limitOnly ? '点击恢复全部股票' : '点击仅看今日涨停股'}
          >
            今日 {todayLiveCount} 家
          </span>
          <span className={`tm-theme-avg ${avgChange != null && avgChange >= 0 ? 'up' : 'down'}`}>{formatPct(avgChange)}</span>
          <button className="tm-sort-btn" onClick={() => onToggleSort(theme.key)} title="切换剩余个股涨跌排序">
            {sortDir === 'asc' ? <CaretUpOutlined /> : <CaretDownOutlined />}
          </button>
        </div>
      </div>
      <div className="tm-theme-list">
        <div className="tm-list-header">
          <span className="col-dragon">龙头</span>
          <span className="col-name">名称</span>
          <span className="col-lianban">连板</span>
          <span className="col-change">涨幅</span>
        </div>
        <div className="tm-list-body">
          {dragonsShown.map((s) => renderRow(s, (s.dragonRank || 1) - 1, true))}
          {pinnedShown.map((s, idx) => renderRow(s, idx, false, true))}
          {restShown.map((s, idx) => renderRow(s, idx, false))}
          {shownCount === 0 && (
            <div className="tm-empty-mini">{limitOnly ? '今日暂无涨停股' : '暂无数据'}</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ==================== 异动监控（第二列第一行） ====================
const MovementPanel = ({ movements, onOpenKline }) => (
  <div className="tm-movement-panel">
    <div className="tm-panel-header">
      <div className="tm-panel-title">
        <ThunderboltOutlined className="tm-panel-icon" />
        <span>异动监控</span>
      </div>
      <span className="tm-panel-sub">个股 ±1% / 板块 ±0.5%</span>
    </div>
    <div className="tm-movement-list">
      {movements.length === 0 ? (
        <div className="tm-empty-mini" style={{ padding: '24px 0' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无异动，等待下一次轮询" />
        </div>
      ) : movements.map((m, idx) => (
        <div key={`${m.time}-${m.code || m.board}-${idx}`} className={`tm-mv-row ${m.delta >= 0 ? 'up' : 'down'}`}>
          <span className="tm-mv-time">{m.time}</span>
          {m.type === 'board' ? (
            <>
              <span className="tm-mv-tag">板块</span>
              <span className="tm-mv-name">{m.board}</span>
            </>
          ) : (
            <>
              <span className="tm-mv-tag stock">个股</span>
              <span className="tm-mv-name" onClick={() => onOpenKline(m)}>{m.name}</span>
            </>
          )}
          <span className="tm-mv-from">{formatPct(m.from)}</span>
          <span className="tm-mv-arrow">→</span>
          <span className="tm-mv-to">{formatPct(m.to)}</span>
          <span className={`tm-mv-delta ${m.delta >= 0 ? 'up' : 'down'}`}>
            {m.delta >= 0 ? <RiseOutlined /> : <FallOutlined />}
            {formatPct(Math.abs(m.delta), { sign: false })}
          </span>
        </div>
      ))}
    </div>
  </div>
);

// ==================== 资金分时图 + 明细 + 成交量（第二列第二行） ====================
// 数据由主组件聚合轮询（/theme_monitor_all 的 fundHistory）通过 props 下发，本组件不再自行轮询
const FundChartsPanel = ({ historyData }) => {
  const data = historyData || [];
  const [fiveMinAggEnabled, setFiveMinAggEnabled] = useState(true);

  const fundContainerRef = useRef(null);
  const fundChartRef = useRef(null);
  const volContainerRef = useRef(null);
  const volChartRef = useRef(null);

  const chartData = useMemo(() => (data.length ? aggregateFundByInterval(data, 5) : []), [data]);

  const tableData = useMemo(() => {
    if (!data.length) return [];
    if (fiveMinAggEnabled) return aggregateFundByInterval(data, 5);
    const sorted = [...data].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([timeStr, item]) => ({
      time: timeStr,
      displayTime: formatDisplayTime(timeStr),
      mainMoney: parseMoneyValue(item.mainMoney),
      amountChangeDiff: parseMoneyValue(item.amountChangeDiff),
      rawTime: timeStr,
    }));
  }, [data, fiveMinAggEnabled]);

  const renderCharts = useCallback((chartData) => {
    if (fundChartRef.current) { fundChartRef.current.remove(); fundChartRef.current = null; }
    if (volChartRef.current) { volChartRef.current.remove(); volChartRef.current = null; }
    if (!fundContainerRef.current) return;

    const sortedData = [...chartData].sort((a, b) => (a.rawTime || a.time).localeCompare(b.rawTime || b.time));
    const today = dayjs().format('YYYY-MM-DD');

    const baseOpts = {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#6b7890', fontSize: 9 },
      grid: { vertLines: { color: 'rgba(18, 33, 58, 0.05)' }, horzLines: { color: 'rgba(18, 33, 58, 0.05)' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(18, 33, 58, 0.08)',
        tickMarkFormatter: (time) => dayjs.unix(time).format('HH:mm'),
      },
      localization: { timeFormatter: (time) => dayjs.unix(time).format('HH:mm') },
      rightPriceScale: { borderColor: 'rgba(18, 33, 58, 0.08)', autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
      handleScroll: false,
      handleScale: false,
    };

    // 锁定 X 轴 09:30-15:00 全天坑位
    const allTimePoints = [];
    let curr = dayjs(`${today} 09:30`);
    const amEnd = dayjs(`${today} 11:30`);
    while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }
    curr = dayjs(`${today} 13:00`);
    const pmEnd = dayjs(`${today} 15:00`);
    while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    const fundChart = createChart(fundContainerRef.current, {
      ...baseOpts,
      width: fundContainerRef.current.clientWidth,
      height: fundContainerRef.current.clientHeight,
    });
    fundChartRef.current = fundChart;
    const dummy = fundChart.addLineSeries({ color: 'transparent', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    dummy.setData(allTimePoints.map((t) => ({ time: t, value: 0 })));
    const series = fundChart.addAreaSeries({
      lineColor: '#7c3aed', topColor: 'rgba(124, 58, 237, 0.35)', bottomColor: 'rgba(124, 58, 237, 0.02)',
      lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const fData = sortedData.map((item) => {
      const t = item.rawTime || item.time;
      return { time: dayjs(`${today} ${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`).unix(), value: parseMoneyValue(item.mainMoney) };
    });
    series.setData(fData);
    series.createPriceLine({ price: 0, color: 'rgba(0,0,0,0.25)', lineStyle: LineStyle.Dashed });
    if (fData.length > 0) fundChart.timeScale().fitContent();

    if (volContainerRef.current) {
      const volChart = createChart(volContainerRef.current, {
        ...baseOpts,
        width: volContainerRef.current.clientWidth,
        height: volContainerRef.current.clientHeight,
      });
      volChartRef.current = volChart;
      const volDummy = volChart.addLineSeries({ color: 'transparent', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      volDummy.setData(allTimePoints.map((t) => ({ time: t, value: 0 })));
      const volSeries = volChart.addAreaSeries({
        lineColor: '#1890ff', topColor: 'rgba(24, 144, 255, 0.35)', bottomColor: 'rgba(24, 144, 255, 0.02)',
        lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      const vData = sortedData.map((item) => {
        const t = item.rawTime || item.time;
        return { time: dayjs(`${today} ${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`).unix(), value: parseMoneyValue(item.amountChangeDiff) };
      });
      volSeries.setData(vData);
      if (vData.length > 0) volChart.timeScale().fitContent();
    }
  }, []);

  useEffect(() => {
    renderCharts(chartData);
  }, [chartData, renderCharts]);

  useEffect(() => {
    const handleResize = () => {
      if (fundChartRef.current && fundContainerRef.current) {
        fundChartRef.current.applyOptions({ width: fundContainerRef.current.clientWidth });
      }
      if (volChartRef.current && volContainerRef.current) {
        volChartRef.current.applyOptions({ width: volContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const latest = chartData.length ? chartData[chartData.length - 1] : null;

  const renderTable = () => {
    if (!tableData.length) return <div className="tm-empty-mini">暂无资金数据</div>;
    const sorted = [...tableData].sort((a, b) => (b.rawTime || b.time).localeCompare(a.rawTime || a.time));
    return sorted.map((item, index) => {
      const timeStr = item.rawTime || item.time;
      const mainMoney = parseMoneyValue(item.mainMoney);
      const prevItem = index + 1 < sorted.length ? sorted[index + 1] : null;
      const diff = prevItem ? mainMoney - parseMoneyValue(prevItem.mainMoney) : 0;
      if (!fiveMinAggEnabled && diff === 0) return null;
      const dt = item.displayTime || formatDisplayTime(timeStr);
      const bigOut = diff <= -4;
      const bigIn = diff >= 4;
      return (
        <div key={timeStr} className={`tm-fund-item ${mainMoney >= 0 ? 'up' : 'down'}${bigOut ? ' big-outflow' : ''}${bigIn ? ' big-inflow' : ''}`}>
          <span className="item-time">{dt}</span>
          <span className={`item-value ${mainMoney >= 0 ? 'up' : 'down'}`}>
            {mainMoney >= 0 ? '+' : ''}{mainMoney.toFixed(2)}
            {diff !== 0 && (
              <span className={`item-diff ${diff >= 0 ? 'up' : 'down'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(2)}</span>
            )}
          </span>
        </div>
      );
    });
  };

  return (
    <div className="tm-fund-panel">
      <div className="tm-fund-row1">
        <div className="tm-fund-chart-card">
          <div className="tm-fund-chart-header">
            <span className="tm-fund-chart-title"><AreaChartOutlined /> 主力资金</span>
            <span className="tm-fund-chart-value" style={{ color: '#7c3aed' }}>
              {latest ? `${latest.mainMoney >= 0 ? '+' : ''}${Number(latest.mainMoney).toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="tm-fund-chart-body" ref={fundContainerRef} />
        </div>
        <div className="tm-fund-detail">
          <div className="tm-fund-detail-header">
            <span className="tm-fund-detail-title">资金明细</span>
            <label className="tm-fund-switch">
              <AntSwitch size="small" checked={fiveMinAggEnabled} onChange={setFiveMinAggEnabled} />
              <span>5min</span>
            </label>
          </div>
          <div className="tm-fund-table">{renderTable()}</div>
        </div>
      </div>
      <div className="tm-fund-row2">
        <div className="tm-fund-chart-card">
          <div className="tm-fund-chart-header">
            <span className="tm-fund-chart-title"><PieChartOutlined /> 成交量</span>
            <span className="tm-fund-chart-value" style={{ color: '#1890ff' }}>
              {latest ? `${latest.amountChangeDiff >= 0 ? '+' : ''}${Number(latest.amountChangeDiff).toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="tm-fund-chart-body" ref={volContainerRef} />
        </div>
      </div>
    </div>
  );
};

// ==================== 主页面 ====================
const ThemeMonitor = () => {
  const [overview, setOverview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [movements, setMovements] = useState([]);
  const [sortDirs, setSortDirs] = useState({});
  const [klineStock, setKlineStock] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);
  const [blocks, setBlocks] = useState(null);
  const [fundHistory, setFundHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sentimentVisible, setSentimentVisible] = useState(false);
  const [themeModal, setThemeModal] = useState({ visible: false, theme: null });
  const [historyAnalysisVisible, setHistoryAnalysisVisible] = useState(false);
  const [customStore, setCustomStore] = useState({ themes: [], overrides: {}, order: [] });
  const [customModalVisible, setCustomModalVisible] = useState(false);
  // 下方板块卡片数量：默认 3 个板块，可切换为 6 个板块
  const [cardCount, setCardCount] = useState(3);
  // 置顶个股（按题材持久化到 localStorage）
  const [pins, setPins] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(PIN_STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(pins));
    } catch (err) {
      console.error('保存置顶个股失败:', err);
    }
  }, [pins]);

  const handlePin = useCallback((themeKey, stock) => {
    setPins((prev) => {
      const list = prev[themeKey] || [];
      if (list.some((p) => p.code === stock.code)) return prev;
      return { ...prev, [themeKey]: [...list, { code: stock.code, pinnedAt: Date.now() }] };
    });
  }, []);

  const handleUnpin = useCallback((themeKey, stock) => {
    setPins((prev) => ({
      ...prev,
      [themeKey]: (prev[themeKey] || []).filter((p) => p.code !== stock.code),
    }));
  }, []);

  const handleOpenThemeHistory = useCallback((theme) => {
    setThemeModal({ visible: true, theme });
  }, []);
  const handleCloseThemeHistory = useCallback(() => {
    setThemeModal({ visible: false, theme: null });
  }, []);

  const prevQuotesRef = useRef({});
  const prevSectorRef = useRef({});
  const pollingRef = useRef(false);
  const analysisRef = useRef(null);
  useEffect(() => { analysisRef.current = analysis; }, [analysis]);

  const handleToggleSort = useCallback((key) => {
    setSortDirs((prev) => ({ ...prev, [key]: prev[key] === 'asc' ? 'desc' : 'asc' }));
  }, []);

  const openKline = useCallback((stock) => {
    if (!stock?.marketCode) return;
    setKlineStock(stock);
    setKlineVisible(true);
  }, []);

  // 异动检测：个股相较上次请求涨幅波动 |Δ|>1%，板块（个股平均涨幅）|Δ|>0.5%
  const detectMovements = useCallback((newQuotes, analysisData) => {
    const now = dayjs().format('HH:mm:ss');
    const events = [];
    const topThemes = (analysisData?.themes || []).slice(0, TOP_THEME_COUNT);
    const nextSector = {};

    topThemes.forEach((theme) => {
      const vals = theme.stocks
        .filter((s) => !newQuotes[s.marketCode]?.suspended)
        .map((s) => Number(newQuotes[s.marketCode]?.changePct))
        .filter((v) => v != null && Number.isFinite(v));
      if (vals.length === 0) return;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      nextSector[theme.key] = avg;
      const prevAvg = prevSectorRef.current[theme.key];
      if (Number.isFinite(prevAvg) && Math.abs(avg - prevAvg) > 0.5) {
        events.push({
          type: 'board', board: theme.board, code: `board_${theme.key}`,
          from: prevAvg, to: avg, delta: avg - prevAvg, time: now,
        });
      }
      theme.stocks.forEach((s) => {
        const curRaw = newQuotes[s.marketCode]?.changePct;
        const prevRaw = prevQuotesRef.current[s.marketCode]?.changePct;
        const cur = Number(curRaw);
        const prev = Number(prevRaw);
        // 停牌/无行情（null）不参与异动检测：Number(null)===0，直接 Number 会产生假异动
        if (curRaw == null || prevRaw == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return;
        if (Math.abs(cur - prev) > 1) {
          events.push({
            type: 'stock', name: s.name, code: s.marketCode, marketCode: s.marketCode, board: theme.board,
            from: prev, to: cur, delta: cur - prev, time: now,
          });
        }
      });
    });

    prevQuotesRef.current = newQuotes;
    prevSectorRef.current = nextSector;

    if (events.length > 0) {
      // 板块异动在前，个股在后；各自按波动幅度降序
      events.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'board' ? -1 : 1;
        return Math.abs(b.delta) - Math.abs(a.delta);
      });
      setMovements((prev) => [...events, ...prev].slice(0, 120));
    }
  }, []);

  // 每 10s 轮询：单一聚合接口一次返回页面全部数据（概览/分析/板块前十/行情/资金分时）
  // 同时挂载时拉取一次自定义题材 store（自定义题材 / 个股增删 / 横幅排序）
  const pollRef = useRef(null);
  const fetchCustomRef = useRef(null);

  useEffect(() => {
    const fetchCustom = async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/theme_custom/list`);
        setCustomStore(res.data?.data || { themes: [], overrides: {}, order: [] });
      } catch (err) {
        console.error('获取自定义题材数据失败:', err);
      }
    };
    const poll = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const res = await axios.get(`http://${local_ip}:3000/theme_monitor_all`);
        const d = res.data || {};
        const analysisData = d.analysis || null;
        setOverview(d.overview || null);
        setAnalysis(analysisData);
        if (d.blocks) setBlocks(d.blocks);
        if (d.fundHistory) setFundHistory(d.fundHistory);

        const newQuotes = d.quotes || {};
        setQuotes(newQuotes);
        detectMovements(newQuotes, analysisData);
      } catch (err) {
        console.error('题材盯盘轮询失败:', err);
      } finally {
        pollingRef.current = false;
        setLoading(false);
      }
    };
    pollRef.current = poll;
    fetchCustomRef.current = fetchCustom;
    poll();
    fetchCustom();
    const timer = setInterval(poll, 10000);
    return () => {
      clearInterval(timer);
      pollRef.current = null;
      fetchCustomRef.current = null;
    };
  }, [detectMovements]);

  // 写操作后：刷新 store 并立即拉一次聚合数据，使卡片/横幅即时更新
  const reloadCustom = useCallback(async () => {
    await fetchCustomRef.current?.();
    await pollRef.current?.();
  }, []);

  const handleReorder = useCallback((keys) => {
    setCustomStore((prev) => ({ ...prev, order: keys }));
    axios.post(`http://${local_ip}:3000/theme_custom/save_order`, { order: keys }).catch((err) => {
      console.error('保存题材排序失败:', err);
    });
  }, []);

  const handleDeleteCustom = useCallback((chip) => {
    Modal.confirm({
      title: '删除自定义题材',
      content: `确认删除自定义题材「${chip.board}」？删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await axios.post(`http://${local_ip}:3000/theme_custom/delete_theme`, { id: chip.id });
          if (!res.data?.success) throw new Error(res.data?.message);
          message.success(`已删除自定义题材「${chip.board}」`);
          await reloadCustom();
        } catch (err) {
          message.error(err.message || '删除失败');
        }
      },
    });
  }, [reloadCustom]);

  const handleAddTheme = useCallback(() => setCustomModalVisible(true), []);

  const customThemes = useMemo(() => analysis?.customThemes || [], [analysis]);

  // 横幅 chip：系统题材前 9 个 + 自定义题材，按持久化 order 重排（order 未记录的新 chip 追加末尾）
  const chipList = useMemo(() => {
    const base = [...(analysis?.themes || []).slice(0, CHIP_THEME_COUNT), ...customThemes];
    const byKey = new Map(base.map((t) => [t.key, t]));
    const ordered = [];
    (customStore.order || []).forEach((k) => {
      if (byKey.has(k)) { ordered.push(byKey.get(k)); byKey.delete(k); }
    });
    byKey.forEach((t) => ordered.push(t));
    return ordered;
  }, [analysis, customThemes, customStore.order]);

  // 下方板块卡片 = 横幅排序前 N 个（含自定义题材），N 由 3/6 板块布局决定
  const cardThemes = useMemo(() => chipList.slice(0, cardCount), [chipList, cardCount]);

  // 高频刷新的个股：当前展示板块的龙一~龙五 + 置顶个股（其余个股仍由 10s 聚合轮询更新）
  const fastQuoteCodes = useMemo(() => {
    const codes = new Set();
    cardThemes.forEach((theme) => {
      (theme.dragons || []).slice(0, 5).forEach((d) => d.marketCode && codes.add(d.marketCode));
      const byCode = new Map((theme.stocks || []).map((s) => [s.code, s]));
      (pins?.[theme.key] || []).forEach((p) => {
        const stock = byCode.get(p.code);
        if (stock?.marketCode) codes.add(stock.marketCode);
      });
    });
    return Array.from(codes);
  }, [cardThemes, pins]);

  // codes 未变化时保持同一个轮询实例，避免每 10s 聚合刷新就重置 3s 定时器
  const fastQuoteCodesKey = useMemo(() => fastQuoteCodes.join(','), [fastQuoteCodes]);

  useEffect(() => {
    if (!fastQuoteCodesKey) return;
    let cancelled = false;
    let polling = false;
    const fetchFastQuotes = async () => {
      if (polling) return;
      polling = true;
      try {
        const res = await axios.get(`${API_BASE}/theme_monitor_quotes`, { params: { codes: fastQuoteCodesKey } });
        if (cancelled) return;
        const data = res.data || {};
        if (Object.keys(data).length > 0) {
          setQuotes((prev) => ({ ...prev, ...data }));
        }
      } catch (err) {
        console.error('龙头/置顶个股行情刷新失败:', err);
      } finally {
        polling = false;
      }
    };
    fetchFastQuotes();
    const timer = setInterval(fetchFastQuotes, FAST_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fastQuoteCodesKey]);

  // 异动阈值基准（10/30 个交易日前的收盘价）：每天拉取一次，临近/触发状态由实时价即时计算
  const [alertBasis, setAlertBasis] = useState({});
  const alertBasisCodesKey = useMemo(() => {
    const codes = new Set();
    cardThemes.forEach((theme) => {
      (theme.stocks || []).forEach((s) => s.marketCode && codes.add(s.marketCode));
    });
    return Array.from(codes).join(',');
  }, [cardThemes]);

  useEffect(() => {
    if (!alertBasisCodesKey) return;
    let cancelled = false;
    axios.get(`${API_BASE}/theme_monitor_alert_basis`, { params: { codes: alertBasisCodesKey } })
      .then((res) => {
        if (!cancelled) setAlertBasis((prev) => ({ ...prev, ...(res.data || {}) }));
      })
      .catch((err) => console.error('获取异动阈值基准失败:', err));
    return () => {
      cancelled = true;
    };
  }, [alertBasisCodesKey]);

  return (
    <div className="theme-monitor-container">
      <OverviewBar overview={overview} onOpenSentiment={() => setSentimentVisible(true)} />
      <BlockRankingStrip blocks={blocks} onOpenKline={openKline} />
      <ThemeChipsStrip
        chips={chipList}
        quotes={quotes}
        onOpenHistoryAnalysis={() => setHistoryAnalysisVisible(true)}
        onAddTheme={handleAddTheme}
        onDeleteCustom={handleDeleteCustom}
        onReorder={handleReorder}
        cardCount={cardCount}
        onCardCountChange={setCardCount}
      />

      {loading && !analysis ? (
        <div className="tm-loading"><Spin size="large" /></div>
      ) : (
        <div className="tm-body">
          <div className="tm-left">
            <div className={`tm-cards-grid${cardCount === 3 ? ' is-three' : ''}`}>
              {cardThemes.map((theme) => (
                <ThemeCard
                  key={theme.key}
                  theme={theme}
                  quotes={quotes}
                  onOpenKline={openKline}
                  sortDir={sortDirs[theme.key] || 'desc'}
                  onToggleSort={handleToggleSort}
                  onOpenThemeHistory={handleOpenThemeHistory}
                  pins={pins[theme.key]}
                  onPin={handlePin}
                  onUnpin={handleUnpin}
                  alertBasis={alertBasis}
                />
              ))}
              {cardThemes.length === 0 && (
                <div className="tm-empty-mini" style={{ gridColumn: '1 / -1' }}>暂无题材数据（需先抓取连板快照）</div>
              )}
            </div>
          </div>
          <div className="tm-right">
            <MovementPanel movements={movements} onOpenKline={openKline} />
            <FundChartsPanel historyData={fundHistory} />
          </div>
        </div>
      )}

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        code={klineStock?.marketCode}
        stockInfo={{ name: klineStock?.name, change: quotes[klineStock?.marketCode]?.changePct }}
        zIndex={1050}
      />

      <SentimentHistoryModal
        visible={sentimentVisible}
        onCancel={() => setSentimentVisible(false)}
      />

      <StockHistoryAnalysisModal
        visible={historyAnalysisVisible}
        onCancel={() => setHistoryAnalysisVisible(false)}
      />

      <CustomThemeModal
        visible={customModalVisible}
        onCancel={() => setCustomModalVisible(false)}
        onSaved={reloadCustom}
      />

      <ThemeSettingsModal
        visible={themeModal.visible}
        initialTheme={themeModal.theme}
        onCancel={handleCloseThemeHistory}
        onOpenStockKline={openKline}
        customStore={customStore}
        onSaved={reloadCustom}
      />
    </div>
  );
};

export default ThemeMonitor;
