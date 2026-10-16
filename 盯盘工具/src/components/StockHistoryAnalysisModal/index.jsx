import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, DatePicker, Spin, Button, Empty } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { createChart, ColorType } from 'lightweight-charts';
import { local_ip } from '../../constant';
import StockSearchInput from '../StockSearchInput';
import './index.scss';

const { RangePicker } = DatePicker;

const MA_COLORS = { ma3: '#ff9800', ma5: '#1677ff', ma10: '#9c27b0' };
const DIFF_COLOR = '#595959';   // 差劲分（深灰，与红色的强度分区分开）
const STRENGTH_COLOR = '#f5222d'; // 强度分（红）

// 默认区间：当年 7 月 1 日 → 今天（若 7 月 1 日尚未到来则取去年 7 月 1 日）
const defaultRange = () => {
  const now = dayjs();
  let start = now.startOf('year').add(6, 'month');
  if (start.isAfter(now)) start = start.subtract(1, 'year');
  return [start, now];
};

const fmtNum = (v, digits = 2) => (v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(digits));
const fmtVolume = (v) => (v == null || !Number.isFinite(Number(v)) ? '0.00亿' : `${(Number(v) / 1e8).toFixed(2)}亿`);

/**
 * 个股历史分析弹窗：
 *   搜索个股 → 选择日期区间 → 拉取区间内日K + MA3/MA5/MA10 + 每日差劲分/强度分，
 *   全部叠加在同一张图上（K线主刻度；差劲分/强度分共用一个 0~100 的独立刻度）。
 */
const StockHistoryAnalysisModal = ({ visible, onCancel }) => {
  const [stockName, setStockName] = useState('');
  const [stockCode, setStockCode] = useState('');
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const chartRef = useRef(null);

  // 查询：显式传入 code / 区间，避免读到过期 state
  const fetchData = async (codeArg, rangeArg) => {
    const c = codeArg || stockCode;
    const r = rangeArg || range;
    if (!c) { setError('请先搜索并选择个股'); return; }
    if (!r || !r[0] || !r[1]) { setError('请选择时间范围'); return; }
    setLoading(true);
    setError('');
    try {
      const { data: res } = await axios.get(`http://${local_ip}:3000/stock_history_analysis`, {
        params: {
          code: c,
          startDate: r[0].format('YYYYMMDD'),
          endDate: r[1].format('YYYYMMDD'),
        },
      });
      if (!res?.success) {
        setData(null);
        setError(res?.message || '获取数据失败');
      } else {
        setData(res);
      }
    } catch (e) {
      setData(null);
      setError(e?.response?.data?.message || e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  };

  // 选中个股即查询；改区间后若已选个股则重新查询
  const handleStockChange = (name, code) => {
    setStockName(name);
    setStockCode(code);
    if (code && range?.[0] && range?.[1]) fetchData(code, range);
  };
  const handleRangeChange = (v) => {
    setRange(v);
    if (stockCode && v?.[0] && v?.[1]) fetchData(stockCode, v);
  };

  const bars = useMemo(() => data?.bars || [], [data]);

  // 图表：打开（或数据变化）时整张重建；关闭时销毁，避免复用已卸载的 DOM
  useEffect(() => {
    const el = containerRef.current;
    if (!visible || !el || bars.length === 0) {
      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }
      return undefined;
    }

    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#333' },
      width: el.clientWidth || 900,
      height: 520,
      localization: { locale: 'zh-CN', timeFormatter: (t) => t },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'string') { const p = time.split('-'); return `${p[1]}/${p[2]}`; }
          if (time && typeof time === 'object') return `${time.month}/${time.day}`;
          return time;
        },
      },
      grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
      handleScroll: false,
      handleScale: false,
    });

    const candlestick = chart.addCandlestickSeries({
      upColor: '#f5222d', downColor: '#52c41a', borderVisible: false,
      wickUpColor: '#f5222d', wickDownColor: '#52c41a',
    });
    candlestick.priceScale().applyOptions({ scaleMargins: { top: 0.02, bottom: 0.42 } });

    const mkMa = (color) => chart.addLineSeries({
      color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false,
    });
    const ma3 = mkMa(MA_COLORS.ma3);
    const ma5 = mkMa(MA_COLORS.ma5);
    const ma10 = mkMa(MA_COLORS.ma10);

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });

    // 差劲分 / 强度分共用 'score' 独立刻度，固定 0~100，落在图表中部区域
    const scoreOptions = {
      lineWidth: 2, lastValueVisible: true, priceLineVisible: false, priceScaleId: 'score',
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    };
    const diffSeries = chart.addLineSeries({ ...scoreOptions, color: DIFF_COLOR });
    const strengthSeries = chart.addLineSeries({ ...scoreOptions, color: STRENGTH_COLOR });
    diffSeries.priceScale().applyOptions({ scaleMargins: { top: 0.6, bottom: 0.2 }, borderColor: '#ccc' });

    const klineData = [];
    const volData = [];
    const ma3Data = [];
    const ma5Data = [];
    const ma10Data = [];
    const diffData = [];
    const strengthData = [];
    const barMap = {};
    bars.forEach((b) => {
      barMap[b.time] = b;
      klineData.push({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
      const chg = b.change;
      volData.push({
        time: b.time,
        value: b.volume || 0,
        color: chg == null
          ? (b.close >= b.open ? 'rgba(245,34,45,0.5)' : 'rgba(82,196,26,0.5)')
          : chg > 0 ? 'rgba(245,34,45,0.5)' : chg < 0 ? 'rgba(82,196,26,0.5)' : 'rgba(166,166,166,0.5)',
      });
      if (b.ma3 != null) ma3Data.push({ time: b.time, value: b.ma3 });
      if (b.ma5 != null) ma5Data.push({ time: b.time, value: b.ma5 });
      if (b.ma10 != null) ma10Data.push({ time: b.time, value: b.ma10 });
      if (b.diffScore != null) diffData.push({ time: b.time, value: b.diffScore });
      if (b.strengthScore != null) strengthData.push({ time: b.time, value: b.strengthScore });
    });

    candlestick.setData(klineData);
    ma3.setData(ma3Data);
    ma5.setData(ma5Data);
    ma10.setData(ma10Data);
    volumeSeries.setData(volData);
    diffSeries.setData(diffData);
    strengthSeries.setData(strengthData);
    chart.timeScale().fitContent();

    // Tooltip
    const tooltip = tooltipRef.current;
    chart.subscribeCrosshairMove((param) => {
      if (!tooltip) return;
      if (!param.time || param.point === undefined || param.point.x < 0 || param.point.x > (el.clientWidth || 900)) {
        tooltip.style.display = 'none';
        return;
      }
      const timeStr = typeof param.time === 'string'
        ? param.time
        : `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
      const b = barMap[timeStr];
      const k = param.seriesData.get(candlestick);
      if (!b || !k) { tooltip.style.display = 'none'; return; }

      const changeColor = b.change == null ? '#333' : b.change > 0 ? '#f5222d' : b.change < 0 ? '#52c41a' : '#666';
      const row = (label, value, color) => `
        <div class="skha-tip-row"><span>${label}</span><span style="font-weight:600;${color ? `color:${color};` : ''}">${value}</span></div>`;
      tooltip.innerHTML = `
        <div class="skha-tip-title">${timeStr}</div>
        ${row('开盘', fmtNum(b.open))}
        ${row('最高', fmtNum(b.high))}
        ${row('最低', fmtNum(b.low))}
        ${row('收盘', fmtNum(b.close), changeColor)}
        ${row('涨跌', b.change == null ? '-' : `${b.change > 0 ? '+' : ''}${b.change.toFixed(2)}%`, changeColor)}
        ${row('成交额', fmtVolume(b.volume))}
        ${row('MA3', fmtNum(b.ma3), MA_COLORS.ma3)}
        ${row('MA5', fmtNum(b.ma5), MA_COLORS.ma5)}
        ${row('MA10', fmtNum(b.ma10), MA_COLORS.ma10)}
        ${row('差劲分', fmtNum(b.diffScore), DIFF_COLOR)}
        ${row('强度分', fmtNum(b.strengthScore), STRENGTH_COLOR)}
      `;
      // 固定在图表左上角，不跟随光标
      tooltip.style.display = 'block';
    });

    const onResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', onResize);
    chartRef.current = chart;

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [visible, bars]);

  const legend = useMemo(() => ([
    { label: 'MA3', color: MA_COLORS.ma3 },
    { label: 'MA5', color: MA_COLORS.ma5 },
    { label: 'MA10', color: MA_COLORS.ma10 },
    { label: '差劲分', color: DIFF_COLOR },
    { label: '强度分', color: STRENGTH_COLOR },
  ]), []);

  return (
    <Modal
      title="个股历史分析"
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={1000}
      zIndex={1050}
      destroyOnHidden
    >
      <div className="stock-history-analysis">
        <div className="skha-toolbar">
          <StockSearchInput
            value={stockName}
            code={stockCode}
            onChange={handleStockChange}
            placeholder="输入个股名称，按回车搜索"
            style={{ width: 260 }}
          />
          <RangePicker
            value={range}
            onChange={handleRangeChange}
            allowClear={false}
            disabledDate={(d) => d && d.isAfter(dayjs(), 'day')}
          />
          <Button type="primary" icon={<SearchOutlined />} disabled={!stockCode || loading} onClick={() => fetchData()}>
            查询
          </Button>
          {data?.success && <span className="skha-count">共 {bars.length} 个交易日</span>}
        </div>

        <div className="skha-legend">
          {legend.map((l) => (
            <span className="skha-legend-item" key={l.label}>
              <i style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>

        <div className="skha-chart-wrap">
          <div ref={containerRef} className="skha-chart" />
          <div ref={tooltipRef} className="skha-tooltip" />
          {loading && (
            <div className="skha-mask">
              <Spin size="large" />
              <span className="skha-loading-text">加载中...</span>
            </div>
          )}
          {!loading && error && (
            <div className="skha-mask"><span className="skha-error">{error}</span></div>
          )}
          {!loading && !error && bars.length === 0 && (
            <div className="skha-mask">
              <Empty description={stockCode ? '暂无数据，请调整时间范围' : '请输入个股名称并回车搜索'} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default StockHistoryAnalysisModal;
