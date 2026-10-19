import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Spin, Modal, Empty, Select, Switch as AntSwitch } from 'antd';
import {
  RocketOutlined, RiseOutlined, FallOutlined, StockOutlined,
  AreaChartOutlined, CrownOutlined, RadarChartOutlined, WarningOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { isAfterMarketClose } from '../../utils/tradingDay';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import { parseMoneyValue, formatDisplayTime, aggregateFundByInterval } from '../../utils/fundAggregation';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import StockKLineModal from '../../components/StockKLineModal';
import { useStrategyMode, setStrategyMode, STRATEGY_MODE_OPTIONS, MODE_EXTREME_WIN } from '../../utils/strategyMode';
import { subscribeBuyPointPush, subscribeSellPointPush } from '../../utils/buyPointWs';
import './index.scss';

// 是否已收盘（统一来自 utils/tradingDay，非交易日视为已收盘，交易日 9:15 前或 14:59 及以后）

const formatSignedPercent = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const formatMinute = (minute) => {
  const m = Number(minute);
  if (!Number.isFinite(m)) return '';
  const h = Math.floor(m / 100);
  const min = m % 100;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

// 判断数据中是否包含 11:30 之后的时间点，用于决定是否按1分钟聚合
const shouldAggregateByOneMin = (rawData) => {
  if (!rawData || rawData.length === 0) return false;
  return rawData.some(item => {
    const timeStr = Array.isArray(item) ? item[0] : (item.rawTime || item.time);
    if (!timeStr || timeStr.length < 4) return false;
    const h = parseInt(timeStr.substring(0, 2));
    const m = parseInt(timeStr.substring(2, 4));
    return h > 11 || (h === 11 && m >= 30);
  });
};

// ==================== 模块（供其他页面复用，未在本页渲染） ====================
// 开盘拉升 vs 下跌 + 斜率前5
export const OpeningSurgeModule = ({ stockList }) => {
  const { surgeList, declineList, surgeCount, declineCount } = useMemo(() => {
    const all = [];
    let surgeCount = 0;
    let declineCount = 0;
    (Array.isArray(stockList) ? stockList : []).forEach((item) => {
      const openPx = parseFloat(item.open_px);
      const closePx = parseFloat(item.close_px);
      const change = parseFloat(item.change);
      if (!Number.isFinite(openPx) || !Number.isFinite(closePx) || openPx <= 0) return;
      const curChange = Number.isFinite(change) ? change : 0;
      // 涨幅差 = 当前涨幅 - 开盘涨幅
      // 开盘涨幅 = (开盘价 - 昨收) / 昨收 * 100
      // 昨收 = 当前价 / (1 + 当前涨幅/100)
      const prevClose = curChange !== 0 ? closePx / (1 + curChange / 100) : closePx;
      const openChange = prevClose > 0 ? ((openPx - prevClose) / prevClose) * 100 : 0;
      const changeDiff = curChange - openChange;
      // 价差用于排序
      const slope = closePx - openPx;
      all.push({
        name: item.name || item.stockName,
        code: item.code,
        change: curChange,
        changeDiff,
        openChange,
        openPx,
        closePx,
      });
      if (slope >= 0) surgeCount++;
      else declineCount++;
    });
    // 按涨幅差排序：最高前5从高到低，最低前5从低到高
    const sorted = [...all].sort((a, b) => b.changeDiff - a.changeDiff);
    return {
      surgeList: sorted.slice(0, 5),
      declineList: sorted.slice(-5).reverse(),
      surgeCount,
      declineCount,
    };
  }, [stockList]);

  return (
    <div className="ob-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <RocketOutlined className="ob-module-icon" />
          <span>开盘攻防</span>
        </div>
        <div className="ob-count-pair">
          <span className="ob-up ob-count-num">拉升 {surgeCount}</span>
          <span className="ob-vs">vs</span>
          <span className="ob-down ob-count-num">下跌 {declineCount}</span>
        </div>
      </div>
      <div className="ob-slope-body">
        <div className="ob-slope-col">
          <div className="ob-slope-col-title ob-up">
            <RiseOutlined /> 拉升斜率最高前5
          </div>
          <div className="ob-slope-head">
            <span></span>
            <span>股票</span>
            <span>涨幅</span>
            <span>涨幅差</span>
            <span>开盘涨幅</span>
          </div>
          {surgeList.length === 0 ? (
            <div className="ob-empty-mini">暂无数据</div>
          ) : surgeList.map((s, idx) => (
            <div className="ob-slope-row" key={`s-${s.code}-${idx}`}>
              <span className={`ob-rank ${idx < 3 ? 'ob-rank-top' : ''}`}>{idx + 1}</span>
              <span className="ob-stock-name">{s.name}</span>
              <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.changeDiff >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.changeDiff >= 0 ? '+' : ''}{s.changeDiff.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.openChange >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.openChange >= 0 ? '+' : ''}{s.openChange.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
        <div className="ob-slope-divider" />
        <div className="ob-slope-col">
          <div className="ob-slope-col-title ob-down">
            <FallOutlined /> 拉升斜率最低前5
          </div>
          <div className="ob-slope-head">
            <span></span>
            <span>股票</span>
            <span>涨幅</span>
            <span>涨幅差</span>
            <span>开盘涨幅</span>
          </div>
          {declineList.length === 0 ? (
            <div className="ob-empty-mini">暂无数据</div>
          ) : declineList.map((s, idx) => (
            <div className="ob-slope-row" key={`d-${s.code}-${idx}`}>
              <span className="ob-rank">{idx + 1}</span>
              <span className="ob-stock-name">{s.name}</span>
              <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.changeDiff >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.changeDiff >= 0 ? '+' : ''}{s.changeDiff.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.openChange >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.openChange >= 0 ? '+' : ''}{s.openChange.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// 开盘攻防统计
export const WatchlistUpDownModule = ({ stockList }) => {
  const {
    surgeCount, declineCount, surgePercent, declinePercent,
    posCount, negCount, posPercent, negPercent,
    avgSurge, avgDecline,
  } = useMemo(() => {
    let surgeCount = 0;
    let declineCount = 0;
    let surgeSum = 0;
    let declineSum = 0;
    let posCount = 0;
    let negCount = 0;
    (Array.isArray(stockList) ? stockList : []).forEach((item) => {
      const openPx = parseFloat(item.open_px);
      const closePx = parseFloat(item.close_px);
      const change = parseFloat(item.change);
      if (!Number.isFinite(openPx) || !Number.isFinite(closePx) || openPx <= 0) return;
      const curChange = Number.isFinite(change) ? change : 0;
      // 涨幅差 = 当前涨幅 - 开盘涨幅（百分比）
      // 昨收 = 当前价 / (1 + 当前涨幅/100)
      const prevClose = curChange !== 0 ? closePx / (1 + curChange / 100) : closePx;
      const openChange = prevClose > 0 ? ((openPx - prevClose) / prevClose) * 100 : 0;
      const changeDiff = curChange - openChange;
      // 开盘拉升/下跌：基于涨幅差
      if (changeDiff >= 0) { surgeCount++; surgeSum += changeDiff; }
      else { declineCount++; declineSum += changeDiff; }
      // 开盘涨幅为正/负：基于 change 字段
      if (curChange > 0) posCount++;
      else if (curChange < 0) negCount++;
    });
    const total = surgeCount + declineCount;
    return {
      surgeCount,
      declineCount,
      surgePercent: total > 0 ? (surgeCount / total) * 100 : 0,
      declinePercent: total > 0 ? (declineCount / total) * 100 : 0,
      posCount,
      negCount,
      posPercent: total > 0 ? (posCount / total) * 100 : 0,
      negPercent: total > 0 ? (negCount / total) * 100 : 0,
      avgSurge: surgeCount > 0 ? surgeSum / surgeCount : 0,
      avgDecline: declineCount > 0 ? declineSum / declineCount : 0,
    };
  }, [stockList]);

  return (
    <div className="ob-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <StockOutlined className="ob-module-icon" />
          <span>开盘统计</span>
        </div>
      </div>
      <div className="ob-stat-body">
        <div className="ob-stat-row">
          <div className="ob-stat-label">开盘拉升 vs 开盘下跌</div>
          <div className="ob-stat-pair">
            <span className="ob-up"><em>{surgePercent.toFixed(0)}%</em><small>{surgeCount}只</small></span>
            <span className="ob-vs">vs</span>
            <span className="ob-down"><em>{declinePercent.toFixed(0)}%</em><small>{declineCount}只</small></span>
          </div>
        </div>
        <div className="ob-stat-row">
          <div className="ob-stat-label">涨幅为正 vs 为负</div>
          <div className="ob-stat-pair">
            <span className="ob-up"><em>{posPercent.toFixed(0)}%</em><small>{posCount}只</small></span>
            <span className="ob-vs">vs</span>
            <span className="ob-down"><em>{negPercent.toFixed(0)}%</em><small>{negCount}只</small></span>
          </div>
        </div>
        <div className="ob-stat-row">
          <div className="ob-stat-label">平均拉升 vs 平均下跌</div>
          <div className="ob-stat-pair">
            <span className="ob-up">
              {surgeCount > 0 ? `+${avgSurge.toFixed(2)}%` : '--'}
            </span>
            <span className="ob-vs">vs</span>
            <span className="ob-down">
              {declineCount > 0 ? `${avgDecline.toFixed(2)}%` : '--'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ==================== 主力资金 & 成交量（左列窄容器适配） ====================
const FundChartModule = () => {
  const [data, setData] = useState([]);
  // 默认只看变化（筛选掉 diff === 0 的条目），不再提供开关
  const [fiveMinAggEnabled, setFiveMinAggEnabled] = useState(true);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const volumeChartContainerRef = useRef(null);
  const volumeChartRef = useRef(null);

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_history`);
      setData(response.data || []);
    } catch (err) {
      console.error('Fetch main fund data failed:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchData, 3000);
    return () => timers.forEach(clearTimeout);
  }, []);

  // 图表数据：始终按 5min 聚合
  const todayChartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return aggregateFundByInterval(data, 5);
  }, [data]);

  // 表格数据：根据开关决定是否聚合（保持原始数据逻辑）
  const todayTableData = useMemo(() => {
    if (!data || data.length === 0) return [];
    if (fiveMinAggEnabled) {
      return aggregateFundByInterval(data, 5);
    }
    // 过了11:30后按1分钟聚合，避免数据过多展示不下
    if (shouldAggregateByOneMin(data)) {
      return aggregateFundByInterval(data, 1);
    }
    const sorted = [...data].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([timeStr, item]) => ({
      time: timeStr,
      displayTime: formatDisplayTime(timeStr),
      mainMoney: parseMoneyValue(item.mainMoney),
      amountChangeDiff: parseMoneyValue(item.amountChangeDiff),
      rawTime: timeStr,
    }));
  }, [data, fiveMinAggEnabled]);

  const renderChartToContainers = useCallback((chartData, mainContainer, volContainer) => {
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }
    if (volumeChartRef.current) { volumeChartRef.current.remove(); volumeChartRef.current = null; }
    if (!mainContainer) return;

    const sortedData = chartData && chartData.length > 0
      ? [...chartData].sort((a, b) => {
        const ta = a.rawTime || a.time;
        const tb = b.rawTime || b.time;
        return ta.localeCompare(tb);
      })
      : [];

    const today = dayjs().format('YYYY-MM-DD');

    const baseOpts = {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#6b7890', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(18, 33, 58, 0.05)' }, horzLines: { color: 'rgba(18, 33, 58, 0.05)' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(18, 33, 58, 0.08)',
        tickMarkFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
      rightPriceScale: { borderColor: 'rgba(18, 33, 58, 0.08)', autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
      handleScroll: false,
      handleScale: false,
    };

    const chart = createChart(mainContainer, { ...baseOpts, width: mainContainer.clientWidth, height: mainContainer.clientHeight });
    chartRef.current = chart;

    // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
    const dummySeries = chart.addLineSeries({
      color: 'transparent',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // 生成全天的时间点 (09:30-11:30, 13:00-15:00)
    const allTimePoints = [];

    // 上午 09:30 - 11:30
    let curr = dayjs(`${today} 09:30`);
    const amEnd = dayjs(`${today} 11:30`);
    while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    // 下午 13:00 - 15:00
    curr = dayjs(`${today} 13:00`);
    const pmEnd = dayjs(`${today} 15:00`);
    while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    // 填充隐藏系列，确保 X 轴拥有全天所有的"坑位"
    dummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));

    const series = chart.addAreaSeries({
      lineColor: '#7c3aed', topColor: 'rgba(124, 58, 237, 0.35)', bottomColor: 'rgba(124, 58, 237, 0.02)',
      lineWidth: 2.5, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const cData = sortedData.map((item) => {
      const timeStr = item.rawTime || item.time;
      const hh = timeStr.substring(0, 2);
      const mm = timeStr.substring(2, 4);
      const ss = timeStr.substring(4, 6);
      return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: parseMoneyValue(item.mainMoney) };
    });
    series.setData(cData);
    series.createPriceLine({ price: -100, color: 'red', lineStyle: LineStyle.Dashed });
    if (cData.length > 0) chart.timeScale().fitContent();

    if (volContainer) {
      const volumeChart = createChart(volContainer, { ...baseOpts, width: volContainer.clientWidth, height: volContainer.clientHeight });
      volumeChartRef.current = volumeChart;

      // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
      const volDummySeries = volumeChart.addLineSeries({
        color: 'transparent',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      // 填充隐藏系列，确保 X 轴拥有全天所有的"坑位"
      volDummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));

      const volumeSeries = volumeChart.addAreaSeries({
        lineColor: '#1890ff', topColor: 'rgba(24, 144, 255, 0.35)', bottomColor: 'rgba(24, 144, 255, 0.02)',
        lineWidth: 2.5, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      const vData = sortedData.map((item) => {
        const timeStr = item.rawTime || item.time;
        const hh = timeStr.substring(0, 2);
        const mm = timeStr.substring(2, 4);
        const ss = timeStr.substring(4, 6);
        return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: parseMoneyValue(item.amountChangeDiff) };
      });
      volumeSeries.setData(vData);
      if (vData.length > 0) volumeChart.timeScale().fitContent();
    }
  }, []);

  useEffect(() => {
    if (chartContainerRef.current) {
      renderChartToContainers(todayChartData, chartContainerRef.current, volumeChartContainerRef.current);
    }
  }, [todayChartData, renderChartToContainers]);

  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      if (volumeChartRef.current && volumeChartContainerRef.current) volumeChartRef.current.applyOptions({ width: volumeChartContainerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const renderTableData = () => {
    if (!todayTableData || todayTableData.length === 0) return null;
    const sorted = [...todayTableData].sort((a, b) => (b.rawTime || b.time).localeCompare(a.rawTime || a.time));
    return sorted.map((item, index) => {
      const timeStr = item.rawTime || item.time;
      const mainMoney = parseMoneyValue(item.mainMoney);
      // 与盯盘页口径一致：增量 = 本桶累计值 − 相邻上一桶（更早）累计值
      const prevItem = index + 1 < sorted.length ? sorted[index + 1] : null;
      const diff = prevItem ? mainMoney - parseMoneyValue(prevItem.mainMoney) : 0;
      if (!fiveMinAggEnabled && diff === 0) return null;
      const dt = item.displayTime || formatDisplayTime(timeStr);
      const isBigOutflow = diff <= -4;
      const isBigInflow = diff >= 4;
      return (
        <div key={timeStr} className={`data-item ${mainMoney >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow' : ''} ${isBigInflow ? 'big-inflow' : ''}`}>
          <span className="item-time">{dt}</span>
          <span className={`item-value ${mainMoney >= 0 ? 'up' : 'down'}`}>
            {mainMoney >= 0 ? '+' : ''}{mainMoney.toFixed(2)}
            {diff !== 0 && (
              <span className={`item-diff ${diff >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow-text' : ''} ${isBigInflow ? 'big-inflow-text' : ''}`}>
                {diff >= 0 ? '+' : ''}{diff.toFixed(2)}
              </span>
            )}
          </span>
        </div>
      );
    });
  };

  const latestToday = todayChartData.length ? todayChartData[todayChartData.length - 1] : null;
  const latestMainMoney = latestToday ? latestToday.mainMoney : null;
  const latestVolume = latestToday ? latestToday.amountChangeDiff : null;

  return (
    <div className="ob-module ob-fund-module">
      {/* 第一行：主力资金 + 资金明细 + 成交量（三列同行） */}
      <div className="ob-fund-row">
        <div className="ob-fund-chart-card ob-fund-chart-main">
          <div className="ob-fund-chart-header">
            <span className="ob-fund-chart-title">主力资金</span>
            <span className="ob-fund-chart-value" style={{ color: '#7c3aed' }}>
              {latestMainMoney !== null && latestMainMoney !== undefined ? `${latestMainMoney >= 0 ? '+' : ''}${latestMainMoney.toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="ob-fund-chart-body">
            <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
        <div className="ob-fund-detail">
          <div className="ob-fund-detail-header">
            <span className="ob-fund-detail-title">资金数据</span>
            <div className="ob-fund-filter-row">
              <label className="ob-fund-switch-label">
                <AntSwitch size="small" checked={fiveMinAggEnabled} onChange={setFiveMinAggEnabled} />
                <span>5min</span>
              </label>
            </div>
          </div>
          <div className="ob-fund-table-wrapper">
            {renderTableData()}
          </div>
        </div>
        <div className="ob-fund-chart-card ob-fund-chart-volume">
          <div className="ob-fund-chart-header">
            <span className="ob-fund-chart-title">成交量</span>
            <span className="ob-fund-chart-value" style={{ color: '#1890ff' }}>
              {latestVolume !== null && latestVolume !== undefined ? `${latestVolume >= 0 ? '+' : ''}${latestVolume.toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="ob-fund-chart-body">
            <div ref={volumeChartContainerRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ==================== 持仓股分时图 ====================
const PositionIntradayChart = ({ name, code, preclose, line }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  const data = useMemo(() => {
    if (!Array.isArray(line) || line.length === 0) return [];
    return line
      .filter((item) => {
        const v = parseFloat(item.last_px);
        if (!Number.isFinite(v) || v <= 0) return false;
        const m = Number(item.minute);
        return !(m > 1130 && m < 1300); // 过滤午休 11:30-13:00
      })
      .map((item, idx) => ({
        time: idx,
        value: parseFloat(item.last_px),
        label: formatMinute(item.minute),
      }));
  }, [line]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || data.length === 0) return;

    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6b7890', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(18, 33, 58, 0.04)' }, horzLines: { color: 'rgba(18, 33, 58, 0.04)' } },
      width: container.clientWidth,
      height: container.clientHeight,
      timeScale: {
        visible: true,
        borderColor: 'rgba(18, 33, 58, 0.08)',
        tickMarkFormatter: (time) => data[time]?.label || '',
      },
      localization: {
        timeFormatter: (time) => data[time]?.label || '',
        priceFormatter: (price) => {
          if (price === undefined || price === null) return '-';
          // 右侧坐标轴展示相对昨收的涨幅百分比
          if (preclose > 0) {
            const pct = ((price - preclose) / preclose) * 100;
            return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
          }
          return price.toFixed(2);
        },
      },
      rightPriceScale: { borderColor: 'rgba(18, 33, 58, 0.08)', autoScale: true, scaleMargins: { top: 0.1, bottom: 0.1 } },
      handleScroll: false,
      handleScale: false,
    });

    const lastVal = data[data.length - 1].value;
    // 持仓股分时图线条统一使用主题色
    const lineColor = getThemeColor();
    const lineSeries = chart.addLineSeries({
      color: lineColor,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    lineSeries.setData(data.map((d) => ({ time: d.time, value: d.value })));

    if (preclose > 0) {
      const baseline = chart.addLineSeries({
        color: '#999',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      baseline.setData(data.map((d) => ({ time: d.time, value: preclose })));
    }

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({ fixLeftEdge: true, fixRightEdge: true, rightOffset: 0 });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (chartRef.current && container) {
        chartRef.current.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, preclose]);

  const lastVal = data.length > 0 ? data[data.length - 1].value : null;
  const changePct = preclose > 0 && lastVal !== null ? ((lastVal - preclose) / preclose) * 100 : null;

  return (
    <div className="ob-intraday-chart-card">
      <div className="ob-intraday-chart-header">
        <span className="ob-intraday-chart-name">{name}</span>
        <span className="ob-intraday-chart-code">{code}</span>
        <span className="ob-intraday-chart-change" style={{ color: getThemeColor() }}>
          {formatSignedPercent(changePct)}
        </span>
      </div>
      <div ref={containerRef} className="ob-intraday-chart-body" />
    </div>
  );
};

const PositionIntradayModule = ({ expanded, onToggleExpanded }) => {
  const [positions, setPositions] = useState([]);
  const [tlineMap, setTlineMap] = useState({});

  const fetchPositions = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      setPositions(res.data || []);
    } catch (err) {
      console.error('获取持仓失败:', err);
    }
  }, []);

  useEffect(() => {
    fetchPositions();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchPositions, 30000);
    return () => timers.forEach(clearTimeout);
  }, [fetchPositions]);

  useEffect(() => {
    if (positions.length === 0) {
      setTlineMap({});
      return;
    }
    let cancelled = false;
    const fetchTlines = async () => {
      try {
        const results = await Promise.all(
          positions.map(async (stock) => {
            try {
              const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: stock.code } });
              return { code: stock.code, data: res.data || {} };
            } catch (err) {
              return { code: stock.code, data: {} };
            }
          })
        );
        if (cancelled) return;
        const map = {};
        results.forEach((r) => { map[r.code] = r.data; });
        setTlineMap(map);
      } catch (err) {
        console.error('获取分时数据失败:', err);
      }
    };
    fetchTlines();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchTlines, 1000);
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [positions]);

  // 同一股票可能有多笔持仓（不同仓位/成本线），分时图按股票去重展示
  const uniquePositions = useMemo(() => {
    const seen = new Set();
    return positions.filter((p) => {
      if (seen.has(p.code)) return false;
      seen.add(p.code);
      return true;
    });
  }, [positions]);

  return (
    <div className="ob-module ob-intraday-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <AreaChartOutlined className="ob-module-icon" />
          <span>持仓股分时图</span>
        </div>
        <div className="ob-intraday-header-actions">
          <span className="ob-total-tag">{uniquePositions.length} 只持仓</span>
        </div>
      </div>
      {positions.length === 0 ? (
        <div className="ob-intraday-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无持仓" />
        </div>
      ) : (
        <div className={`ob-intraday-grid ${uniquePositions.length >= 2 ? 'two' : 'single'}`}>
          {uniquePositions.map((stock) => (
            <PositionIntradayChart
              key={stock.code}
              name={stock.name}
              code={stock.code}
              preclose={parseFloat(tlineMap[stock.code]?.preclose_px) || 0}
              line={tlineMap[stock.code]?.line}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ==================== 自选股 3 日涨幅前五（创业板+主板 / 科创板 上下分行） ====================
const formatSlope = (v) => (
  v === null || v === undefined || Number.isNaN(Number(v))
    ? '--'
    : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}°`
);

// 指数 3 日线斜率状态文案：正斜率披露由负转正第几天，负斜率披露由正转负第几天
const slopeTurnText = (gate) => {
  if (!gate || gate.slope === null || gate.slope === undefined) return '指数 3 日线斜率数据不足';
  const slope = Number(gate.slope);
  if (slope >= 0) {
    if (gate.turnedPosToday) return '指数今日由负转正';
    const d = gate.daysSinceTurnPos;
    if (d === null || d === undefined) return '指数处于正斜率区间';
    return d === 0 ? '指数今日由负转正' : `指数由负转正第 ${d} 天`;
  }
  if (gate.turnedNegToday) return '指数今日由正转负';
  const d = gate.daysSinceTurnNeg;
  if (d === null || d === undefined) return '指数处于负斜率区间';
  return d === 0 ? '指数今日由正转负' : `指数由正转负第 ${d} 天`;
};

// 逆周期（反向抱团）择时状态标签样式：已触发 / 涨停不可买 / 斜率未就绪 / 等待命中
const reverseTimingClass = (tag) => (
  tag === '已触发买点' ? 'hit' : tag === '涨停不可买' ? 'limitup' : tag === '斜率未就绪' ? 'idle' : 'wait'
);

const TopChange3dModule = ({ buyPointHit = false, onBuyableChange }) => {
  const mode = useStrategyMode();
  const isExtreme = mode === MODE_EXTREME_WIN;
  const [data, setData] = useState(null);        // 科技进攻：自选股 3 日涨幅榜
  const [leaderData, setLeaderData] = useState(null); // 情绪游资-极致胜率：龙头列表
  // 点击股票名称打开 K 线弹窗
  const [selectedStock, setSelectedStock] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);
  const cybPassed = data?.cybGate?.passed === true;
  const starPassed = data?.starGate?.passed === true;

  // 挂载立即拉一次；交易时段每 5s 轮询，收盘后保留最后一次数据
  //   tech_attack            → /top_gainers_by_market（limit=10，每市场最多 10 只）
  //   hot_money_extreme_win  → /hot_money_leader_list（除 delta≥30 与上证斜率>0 外全部买点条件满足）
  const fetchStocks = useCallback(async () => {
    if (isExtreme) {
      try {
        const res = await axios.post(`http://${local_ip}:3000/hot_money_leader_list`, { limit: 50 });
        setLeaderData(res.data?.data || null);
      } catch (err) {
        console.error('获取情绪游资龙头列表失败:', err);
      }
      return;
    }
    try {
      const res = await axios.post(`http://${local_ip}:3000/top_gainers_by_market`, { limit: 10 });
      setData(res.data?.data || null);
    } catch (err) {
      console.error('获取自选股 3 日涨幅榜失败:', err);
    }
  }, [isExtreme]);

  // 市场门槛说明（标题下方展示）：仅展示满足指数 3 日线斜率买点门槛的市场的股票
  const gateNote = !data
    ? '正在检测创业板指 / 科创50 的 3 日线斜率买点门槛…'
    : cybPassed && starPassed
      ? '创业板指、科创50 均满足买点门槛：两个市场合并按 3 日涨幅排名'
      : cybPassed
        ? '仅创业板指满足买点门槛：仅展示创业板 + 主板'
        : starPassed
          ? '仅科创50 满足买点门槛：仅展示科创板'
          : '创业板指、科创50 均不满足买点门槛：暂无可展示标的';

  // 合并榜单：仅纳入满足门槛的市场，按 3 日涨幅降序取前 10
  const mergedList = useMemo(() => {
    const cybMainList = data?.markets?.cybMain || [];
    const starList = data?.markets?.star || [];
    return [
      ...(cybPassed ? cybMainList : []),
      ...(starPassed ? starList : []),
    ].sort((a, b) => (b.change3d ?? -Infinity) - (a.change3d ?? -Infinity)).slice(0, 10);
  }, [data, cybPassed, starPassed]);

  // 情绪游资龙头列表（后端已按 delta 降序返回全部达标股）
  const leaderList = useMemo(() => (isExtreme ? (leaderData?.stocks || []) : []), [isExtreme, leaderData]);
  // 逆周期（反向抱团龙头）：池全部 + 择时状态（列表下半部分）
  const reverse = leaderData?.reverse || null;
  const reverseList = useMemo(() => (isExtreme ? (reverse?.stocks || []) : []), [isExtreme, reverse]);
  const indexSlope = leaderData?.indexSlope;
  const slopeOk = indexSlope != null && Number(indexSlope) > 0;
  const reverseSlope = reverse?.slopeClose ?? null;
  const reverseSlopeOk = reverse?.eligible === true;

  useEffect(() => {
    fetchStocks();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchStocks, 5000);
    return () => timers.forEach(clearTimeout);
  }, [fetchStocks]);

  // 全局唯一推荐标的：合并前十中 3 日涨幅最高且满足买点资格、未封涨停者（仅来自满足门槛的市场）
  const globalPick = useMemo(
    () => mergedList.find(s => s.matchesBuyPoint && !s.isLimitUp) || null,
    [mergedList]
  );

  // 供买点弹窗与飞书通知使用：
  //   tech_attack            → 唯一一只标的
  //   hot_money_extreme_win  → 顺周期完整买点股前 3（delta≥30 且上证斜率>0 且未涨停）+ 逆周期已触发买点的反向抱团股前 3
  const buyableStocks = useMemo(() => {
    if (isExtreme) {
      const forward = leaderList.filter(s => s.buyPointHit && !s.isLimitUp).slice(0, 3);
      const rev = reverseList.filter(s => s.timingPassed).slice(0, 3).map(s => ({ ...s, isReverse: true }));
      return [...forward, ...rev];
    }
    return globalPick ? [globalPick] : [];
  }, [isExtreme, leaderList, reverseList, globalPick]);

  useEffect(() => {
    onBuyableChange?.(buyableStocks);
  }, [buyableStocks, onBuyableChange]);

  const rowCount = isExtreme ? leaderList.length : mergedList.length;
  const extremeGateNote = !leaderData
    ? '正在检测上证指数 3 日线斜率买点门槛…'
    : `上证指数 3 日线斜率 ${formatSlope(indexSlope)}（需 > 0）；龙头池共 ${leaderData.poolCount ?? 0} 只（过去 10 交易日四连板及以上，剔除创业板/科创板/题材黑名单/科技自选股重叠/近期大幅拉升）`;
  const reverseGateNote = !leaderData
    ? '正在检测逆周期（反向抱团）择时状态…'
    : !reverse
      ? '逆周期（反向抱团）数据获取失败，暂无法展示'
      : `当日上证跌幅 ${reverse.indexChange == null ? '--' : `${Number(reverse.indexChange).toFixed(2)}%`}（触发须 ≤ ${reverse.indexDropPct}%）；反向抱团池共 ${reverse.poolCount ?? 0} 只（过去 20 交易日连板 ≥ 2，剔除创业板/科创板/题材黑名单，近 20 日内滑动 10 日区间最大涨幅 ≥ 60%）`;

  return (
    <div className="ob-module ob-rank3-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <CrownOutlined className="ob-module-icon" />
          <span>{isExtreme ? '情绪游资-龙头列表' : '自选股 · 3日涨幅前十'}</span>
        </div>
        <span className="ob-mode-switch-label">切换模式</span>
        <Select
          size="small"
          className="ob-mode-switch"
          value={mode}
          options={STRATEGY_MODE_OPTIONS}
          onChange={setStrategyMode}
          popupMatchSelectWidth={false}
        />
        <span className="ob-total-tag">{isExtreme ? `顺周期 ${rowCount} · 逆周期 ${reverseList.length}` : `共 ${rowCount} 只`}</span>
      </div>
      <div className={`ob-gainer-gate-note ${(isExtreme ? slopeOk : (cybPassed && starPassed)) ? 'both' : (isExtreme ? false : (cybPassed || starPassed)) ? 'partial' : 'none'}`}>
        {isExtreme ? extremeGateNote : gateNote}
      </div>
      <div className="ob-gainer-body">
        <div className="ob-gainer-col">
          <div className="ob-gainer-col-head">
            {isExtreme && <span className="ob-gainer-section-label">顺周期 · 情绪游资-极致胜率</span>}
            {isExtreme ? (
              <div className={`ob-gainer-gate ${slopeOk ? 'passed' : 'failed'}`}>
                <span className="ob-gainer-gate-slope">上证指数 {formatSlope(indexSlope)}</span>
                <span className="ob-gainer-gate-turn">3 日线分时斜率</span>
                <span className="ob-gainer-gate-badge">{slopeOk ? '满足买点门槛' : '不满足买点门槛'}</span>
              </div>
            ) : [
              { name: '创业板指', gate: data?.cybGate, passed: cybPassed },
              { name: '科创50', gate: data?.starGate, passed: starPassed },
            ].map(({ name, gate, passed }) => (
              <div key={name} className={`ob-gainer-gate ${passed ? 'passed' : 'failed'}`}>
                <span className="ob-gainer-gate-slope">{name} {formatSlope(gate?.slope)}</span>
                <span className="ob-gainer-gate-turn">{slopeTurnText(gate)}</span>
                <span className="ob-gainer-gate-badge">{passed ? '满足买点门槛' : '不满足买点门槛'}</span>
              </div>
            ))}
          </div>
          <div className="ob-gainer-head">
            {isExtreme ? (
              <>
                <span>#</span>
                <span>股票</span>
                <span>当日</span>
                <span>强度−差劲</span>
                <span>连板</span>
              </>
            ) : (
              <>
                <span>#</span>
                <span>股票</span>
                <span>当日</span>
                <span>抗分歧</span>
                <span>3日涨幅</span>
              </>
            )}
          </div>
          {isExtreme ? (
            leaderList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无数据</div>
            ) : leaderList.map((s, idx) => (
              <div className="ob-gainer-row" key={`${s.code}-${idx}`}>
                <span className={`ob-rank ${idx < 3 ? 'ob-rank-top' : ''}`}>{idx + 1}</span>
                <span className="ob-gainer-name-cell">
                  <span
                    className="ob-stock-name ob-stock-name-clickable"
                    title="点击查看K线"
                    onClick={() => { setSelectedStock({ code: s.code, stockName: s.stockName, change: s.change }); setKlineVisible(true); }}
                  >{s.stockName}</span>
                  {s.isLimitUp && <span className="ob-gainer-limitup">涨停</span>}
                  {s.buyPointHit && <span className="ob-gainer-buyflag">买点触发</span>}
                </span>
                <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                  {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                </span>
                <span className={`ob-gainer-resilience ${s.delta != null && s.delta >= 30 ? 'ob-up' : ''}`}>
                  {s.delta !== null && s.delta !== undefined ? Number(s.delta).toFixed(2) : '--'}
                </span>
                <span className="ob-gainer-resilience">
                  {s.lianbanCount != null ? `${s.lianbanCount} 连板` : '--'}
                </span>
              </div>
            ))
          ) : (
            mergedList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无数据</div>
            ) : mergedList.map((s, idx) => {
              // 全局唯一推荐标的：只在名称旁打一个标签，不做整行高亮
              const isPick = globalPick != null && s.code === globalPick.code;
              return (
                <div className="ob-gainer-row" key={`${s.code}-${idx}`}>
                  <span className={`ob-rank ${idx < 3 ? 'ob-rank-top' : ''}`}>{idx + 1}</span>
                  <span className="ob-gainer-name-cell">
                    <span
                      className="ob-stock-name ob-stock-name-clickable"
                      title="点击查看K线"
                      onClick={() => { setSelectedStock(s); setKlineVisible(true); }}
                    >{s.stockName}</span>
                    <span className={`ob-gainer-market ${s.isSh688 ? 'star' : 'cyb'}`}>{s.isSh688 ? '科创' : '创业/主板'}</span>
                    {s.isLimitUp && <span className="ob-gainer-limitup">涨停</span>}
                    {isPick && <span className="ob-gainer-buyflag">{buyPointHit ? '买点触发' : '买点候选'}</span>}
                  </span>
                  <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                    {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                  </span>
                  <span className="ob-gainer-resilience">
                    {s.resilienceScore !== null && s.resilienceScore !== undefined ? Number(s.resilienceScore).toFixed(2) : '--'}
                  </span>
                  <span className={`ob-change-cell ${s.change3d >= 0 ? 'ob-up' : 'ob-down'}`}>
                    {s.change3d !== null && s.change3d !== undefined ? `${s.change3d >= 0 ? '+' : ''}${Number(s.change3d).toFixed(2)}%` : '--'}
                  </span>
                </div>
              );
            })
          )}
        </div>
        {isExtreme && (
          <div className={`ob-gainer-col ob-gainer-col-reverse ${reverseSlopeOk ? 'active' : ''}`}>
            <div className="ob-gainer-col-head">
              <span className="ob-gainer-section-label reverse">逆周期 · 反向抱团龙头</span>
              <div className={`ob-gainer-gate ${reverseSlopeOk ? 'passed' : 'failed'}`}>
                <span className="ob-gainer-gate-slope">上证指数 {formatSlope(reverseSlope)}</span>
                <span className="ob-gainer-gate-turn">{reverse && reverse.slopeDayNo != null ? `连续为负第 ${reverse.slopeDayNo} 天` : '3 日线收盘口径斜率'}</span>
                <span className="ob-gainer-gate-badge">{reverseSlopeOk ? '逆周期窗口已开启' : '未进入逆周期窗口'}</span>
              </div>
            </div>
            <div className={`ob-gainer-gate-note ${reverseSlopeOk ? 'both' : 'none'}`}>{reverseGateNote}</div>
            <div className="ob-gainer-head ob-gainer-head-reverse">
              <span>#</span>
              <span>股票</span>
              <span>当日</span>
              <span>强度分</span>
              <span>连板</span>
              <span>逆周期择时</span>
            </div>
            {reverseList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无满足条件的反向抱团标的</div>
            ) : reverseList.map((s, idx) => (
              <div className="ob-gainer-row ob-gainer-row-reverse" key={`rev-${s.code}-${idx}`}>
                <span className={`ob-rank ${idx < 3 ? 'ob-rank-top' : ''}`}>{idx + 1}</span>
                <span className="ob-gainer-name-cell">
                  <span
                    className="ob-stock-name ob-stock-name-clickable"
                    title="点击查看K线"
                    onClick={() => { setSelectedStock({ code: s.code, stockName: s.stockName, change: s.change }); setKlineVisible(true); }}
                  >{s.stockName}</span>
                  {s.isLimitUp && <span className="ob-gainer-limitup">涨停</span>}
                  {s.timingPassed && <span className="ob-gainer-buyflag">逆周期买点</span>}
                </span>
                <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                  {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                </span>
                <span className="ob-gainer-resilience">
                  {s.strengthScore !== null && s.strengthScore !== undefined ? Number(s.strengthScore).toFixed(2) : '--'}
                </span>
                <span className="ob-gainer-resilience">
                  {s.lianbanCount != null ? `${s.lianbanCount} 板` : '--'}
                </span>
                <span className="ob-rev-timing-cell">
                  <span
                    className={`ob-rev-timing-tag ${reverseTimingClass(s.timingTag)}`}
                    title={s.timingDetail || ''}
                  >{s.timingTag || '--'}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        code={selectedStock?.code}
        stockInfo={{ name: selectedStock?.stockName, change: selectedStock?.change }}
      />
    </div>
  );
};

// ==================== 买点诊断卡片（自动运行） ====================
const BuyPointDiagnosisCard = ({ onResultChange, buyableStocks = [] }) => {
  const mode = useStrategyMode();
  const isExtreme = mode === MODE_EXTREME_WIN;
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [popupVisible, setPopupVisible] = useState(false);
  const [popupStocks, setPopupStocks] = useState([]);
  // 标题旁实时时钟：每秒跳动，便于对照 5 分钟整点判断下一次自动诊断时机
  const [now, setNow] = useState(() => dayjs());
  // 可买标的实时快照：命中时刻打开弹窗时取用，避免闭包拿到旧值
  const buyableRef = useRef(buyableStocks);
  useEffect(() => { buyableRef.current = buyableStocks; }, [buyableStocks]);

  useEffect(() => {
    const timer = setInterval(() => setNow(dayjs()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 手动 / 初始一次性刷新：仅拉取当前最新诊断数据用于展示，不发飞书、不弹窗（这些由后端集中处理）
  const run = useCallback(async (force = false) => {
    try {
      // force=true：手动刷新按钮传入，绕过后端 30 秒重度刷新节流，随时点击随时真正重拉
      const res = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: 1, force: force ? 1 : 0, mode });
      const result = res.data?.data;
      if (!result) return;
      setData(result);
      // 命中口径：顺周期前置全部通过；情绪游资模式下逆周期（反向抱团）择时触发也算命中
      const forwardHit = result.allPassed === true;
      const reverseHit = isExtreme && result.reverse?.allPassed === true;
      // 向上层汇报买点是否命中，供 3 日涨幅榜决定是否高亮展示
      onResultChange?.(forwardHit || reverseHit);
    } catch (err) {
      console.error('买点诊断刷新失败:', err);
    }
  }, [onResultChange, mode, isExtreme]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await run(true); } finally { setRefreshing(false); }
  }, [run]);

  // 买点诊断：由后端 WebSocket 集中推送（每 10s 一次），前端不再轮询
  //   - 每条消息更新诊断数据（供卡片展示）
  //   - 命中且进入新的 5 分钟桶时后端下发 open:true（频控在后端完成），前端据此打开弹窗
  //   - 初次挂载仍一次性拉取一次（非交易时段也能展示最近交易日的诊断结果）
  useEffect(() => {
    run(false);
    const unsubscribe = subscribeBuyPointPush((msg) => {
      const result = msg?.data;
      if (!result) return;
      setData(result);
      const forwardHit = result.allPassed === true;
      const reverseHit = isExtreme && result.reverse?.allPassed === true;
      onResultChange?.(forwardHit || reverseHit);
      if (msg.open === true) {
        // 优先使用消息内 buyable（仅 MOCK 调试会携带），否则用页面实时可买列表
        setPopupStocks(result.buyable || buyableRef.current || []);
        setPopupVisible(true);
      }
    });
    return unsubscribe;
  }, [run, onResultChange, isExtreme]);

  // 过滤掉「尾盘抄底」检查项（或逻辑分支，已从买点诊断移除），并同步修正计数与结论文案
  const checks = (data?.checks || []).filter(c => c.id !== 'tail_dip_buying');
  const allPassed = data?.allPassed === true;
  const hit = allPassed;
  // 逆周期（反向抱团）一组条件（后端在 checks 之外单独返回），独立分组展示
  const reverseChecks = isExtreme ? (data?.reverseChecks || []) : [];
  const sortChecks = (list) => [...list].sort((a, b) => a.passed - b.passed);
  const checkGroups = [
    { label: isExtreme ? '顺周期 · 情绪游资-极致胜率' : '', items: sortChecks(checks) },
    ...(reverseChecks.length > 0
      ? [{ label: '逆周期 · 反向抱团龙头', items: sortChecks(reverseChecks), reverse: true }]
      : []),
  ];
  const totalCheckCount = checkGroups.reduce((n, g) => n + g.items.length, 0);
  const totalPassedCount = checkGroups.reduce((n, g) => n + g.items.filter(c => c.passed).length, 0);
  const conclusionText = !allPassed && typeof data?.conclusion === 'string' && data.conclusion.includes('尾盘抄底')
    ? '当前前置条件未全部满足，请耐心等待，不要盲目出手。'
    : data?.conclusion;

  // 5 分钟整点（9:30/9:35/9:40…）：整分钟内背景闪烁做重点提示，进入下一分钟自动恢复
  const isFiveMinTick = now.minute() % 5 === 0;

  return (
    <div className={`ob-diagnosis-card ob-buy-card ${isFiveMinTick ? 'is-tick' : ''}`}>
      {refreshing && (
        <div className="ob-refresh-mask">
          <Spin size="large" />
        </div>
      )}
      <div className="ob-diagnosis-header">
        <div className="ob-module-title">
          <RadarChartOutlined className="ob-module-icon" />
          <span>买点诊断</span>
          <span className="ob-diagnosis-clock">{now.format('HH:mm:ss')}</span>
        </div>
        <div className="ob-diagnosis-actions">
          <span className={`ob-status-badge ${hit ? 'hit' : ''}`}>
            {!data ? '诊断中...' : hit ? '🎯 已命中' : `未满足 ${totalPassedCount}/${totalCheckCount}`}
          </span>
          <button className="ob-refresh-btn" onClick={handleRefresh} disabled={refreshing} title="手动刷新">
            <ReloadOutlined />
          </button>
        </div>
      </div>
      <div className="ob-diagnosis-body" style={{ maxHeight: 530,overflowY: 'auto', minHeight: 522 }}>
        {!data ? (
          <div className="ob-diagnosis-loading"><Spin size="small" /></div>
        ) : (
          <>
            {checkGroups.map((g, gi) => [
              g.label
                ? <div key={`g-${gi}`} className={`ob-check-group-label${g.reverse ? ' reverse' : ''}`}>{g.label}</div>
                : null,
              ...g.items.map((c) => (
                <div key={c.id} className={`ob-buy-check ${c.exempted ? 'exempted' : c.passed ? 'passed' : 'failed'}`}>
                  <span className="ob-buy-check-name">{c.title}</span>
                  <span className={`ob-buy-check-badge ${c.exempted ? 'exempted' : c.passed ? 'passed' : 'failed'}`}>
                    {c.exempted ? '已豁免' : c.passed ? '通过' : '未通过'}
                  </span>
                  {(c.value || !c.passed) && (
                    <span className="ob-buy-check-detail">
                      {c.value ? <b>{c.value}</b> : null}
                      {!c.passed && c.reason ? <span>{c.reason}</span> : null}
                    </span>
                  )}
                </div>
              )),
            ])}
            <div className={`ob-conclusion ${hit ? 'hit' : ''}`}>
              {conclusionText}
            </div>
          </>
        )}
      </div>

      <Modal
        open={popupVisible}
        onCancel={() => setPopupVisible(false)}
        onOk={() => setPopupVisible(false)}
        okText="知道了"
        cancelButtonProps={{ style: { display: 'none' } }}
        title={<span><WarningOutlined style={{ color: '#fa8c16', marginRight: 8 }} />买点诊断命中</span>}
        className="ob-alert-modal"
      >
        <div className="ob-alert-content">
          <div className="ob-alert-big">🎯 买点信号触发，可以关注买入时机</div>
          <div className="ob-alert-reason">{conclusionText}</div>
          <div className="ob-alert-sub">
            命中类型：
            {allPassed && '全部前置条件通过'}
          </div>
          {popupStocks.length > 0 ? (
            <>
              <div className="ob-alert-buy-title">
                {isExtreme ? '情绪游资-龙头列表 · 完整买点标的 / 反向抱团逆周期买点标的（已过滤涨停板）' : '可买标的（已过滤涨停板）'}
              </div>
              {popupStocks.map((s) => (
                <div key={`${s.isReverse ? 'rev-' : ''}${s.code}`} className="ob-alert-stock">
                  {isExtreme ? (
                    s.isReverse ? (
                      <>
                        <div className="ob-alert-stock-head">
                          <b>{s.stockName}</b>
                          <span className="ob-alert-stock-code">{s.code}</span>
                          <span className="ob-alert-stock-market">逆周期 · {s.lianbanCount != null ? `${s.lianbanCount} 连板` : '--'}</span>
                          <span style={{ marginLeft: 'auto', fontWeight: 700, color: s.change >= 0 ? '#e11d48' : '#059669' }}>
                            当日 {formatSignedPercent(s.change)}
                          </span>
                        </div>
                        <div className="ob-alert-stock-meta">
                          强度分 {s.strengthScore != null ? Number(s.strengthScore).toFixed(2) : '--'} · {s.timingTag || '--'}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="ob-alert-stock-head">
                          <b>{s.stockName}</b>
                          <span className="ob-alert-stock-code">{s.code}</span>
                          <span className="ob-alert-stock-market">{s.lianbanCount != null ? `${s.lianbanCount} 连板` : ''}</span>
                          <span style={{ marginLeft: 'auto', fontWeight: 700, color: s.change >= 0 ? '#e11d48' : '#059669' }}>
                            当日 {formatSignedPercent(s.change)}
                          </span>
                        </div>
                        <div className="ob-alert-stock-meta">
                          强度−差劲 {s.delta != null ? Number(s.delta).toFixed(2) : '--'}
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <div className="ob-alert-stock-head">
                        <b>{s.stockName}</b>
                        <span className="ob-alert-stock-code">{s.code}</span>
                        <span className="ob-alert-stock-market">{s.isSh688 ? '科创板' : '创业板/主板'}</span>
                        <span style={{ marginLeft: 'auto', fontWeight: 700, color: s.change3d >= 0 ? '#e11d48' : '#059669' }}>
                          3日 {formatSignedPercent(s.change3d)}
                        </span>
                      </div>
                      <div className="ob-alert-stock-meta">
                        当日 {formatSignedPercent(s.change)} · 抗分歧 {s.resilienceScore != null ? Number(s.resilienceScore).toFixed(2) : '--'}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="ob-alert-sub">
              {isExtreme ? '当前无顺周期完整买点标的（需强度分 − 差劲分 ≥ 30 且上证 3 日线斜率为正、未封涨停），亦无逆周期反向抱团买点标的。' : '当前无满足买点条件且未封涨停的可买标的。'}
            </div>
          )}
          <div className="ob-alert-time">诊断时间：{data?.timestamp}</div>
        </div>
      </Modal>
    </div>
  );
};

// 单笔持仓的卖点诊断：同一股票的不同仓位各自独立诊断（各自买入日期 / 成本线 / 仓位）。
// 每笔持仓以 id 区分，买入当日不诊断、次日起生效，按各笔自身买入日期判断。
const diagnosePositionSellPoint = async (stock, todayStr, mode) => {
  const base = {
    positionId: stock.id || stock.code,
    code: stock.code,
    stockName: stock.name,
    weight: stock.weight != null ? stock.weight : null,
    buyDate: stock.buyDate || null,
    buyTime: stock.buyTime || null,
    costPrice: stock.costPrice != null && Number.isFinite(Number(stock.costPrice)) ? Number(stock.costPrice) : null,
  };
  if (stock.buyDate === todayStr) {
    return { ...base, buyToday: true };
  }
  try {
    // mode='hot_money_extreme_win' 时后端返回「情绪游资-极致胜率」9 条龙头战法卖点；
    // buyDate 供「持仓第 3 日未拉开 +10%」判定
    const res = await axios.post(`http://${local_ip}:3000/check_single_stock_sell_point`, {
      code: stock.code,
      costPrice: stock.costPrice,
      buyDate: stock.buyDate || null,
      mode,
    });
    return { ...res.data, ...base };
  } catch (err) {
    return { ...base, error: '诊断失败' };
  }
};

// 卖出提示文案：卖出 xx 股票的 xx 仓位（在 xx 时间买入，成本线为 xx）
const buildSellHint = (result) => {
  const weightText = result.weight != null ? `${result.weight}%` : '半仓';
  const buyAt = result.buyDate ? (result.buyTime ? `${result.buyDate} ${result.buyTime}` : result.buyDate) : '--';
  const costText = result.costPrice != null ? Number(result.costPrice).toFixed(2) : '--';
  return `建议卖出 ${result.stockName} ${weightText} 仓位（在 ${buyAt} 买入，成本线为 ${costText}）`;
};

// ==================== 卖点诊断卡片（自动运行） ====================
const SellPointDiagnosisCard = () => {
  const mode = useStrategyMode();
  const isExtreme = mode === MODE_EXTREME_WIN;
  const [results, setResults] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [popupVisible, setPopupVisible] = useState(false);
  // 命中闪烁：后端下发 open:true 时卡片背景闪烁提示，数秒后自动恢复
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef(null);

  // 独立接口拉取最新卖点诊断数据（卡片刷新按钮 / 初次挂载使用；不发飞书、不触发弹窗）
  const run = useCallback(async () => {
    try {
      const posRes = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      const positions = posRes.data || [];
      if (positions.length === 0) {
        setResults([]);
        return;
      }
      const todayStr = dayjs().format('YYYY-MM-DD');
      // 每笔持仓各自独立诊断（同一股票的多笔仓位会分别产生一张卡片）
      const list = await Promise.all(
        positions.map((stock) => diagnosePositionSellPoint(stock, todayStr, mode))
      );
      setResults(list);
    } catch (err) {
      console.error('卖点诊断刷新失败:', err);
    }
  }, [mode]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await run(); } finally { setRefreshing(false); }
  }, [run]);

  // 卖点诊断：由后端 WebSocket 集中推送（每 10s 一次），前端不再轮询
  //   - 每条消息更新卡片诊断数据
  //   - 命中且进入新的 5 分钟桶时后端下发 open:true（飞书与频控均由后端完成），前端据此弹窗 + 卡片闪烁
  //   - 卡片内刷新按钮仍走独立接口拉取最新数据（handleRefresh）
  //   - 初次挂载一次性拉取一次（非交易时段也能展示最近诊断结果）
  useEffect(() => {
    run();
    const unsubscribe = subscribeSellPointPush((msg) => {
      const list = msg?.data?.results;
      if (Array.isArray(list)) setResults(list);
      if (msg?.open === true) {
        setPopupVisible(true);
        setFlash(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlash(false), 6000);
      }
    });
    return () => {
      unsubscribe();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [run]);

  const hitStocks = results.filter((r) => r.isSell === true);

  return (
    <div className={`ob-diagnosis-card ob-sell-card ${flash ? 'is-flash' : ''}`}>
      {refreshing && (
        <div className="ob-refresh-mask">
          <Spin size="large" />
        </div>
      )}
      <div className="ob-diagnosis-header">
        <div className="ob-module-title" title={isExtreme ? '卖点条件：完整龙头战法 9 条（情绪游资-极致胜率）' : '卖点条件：N 日涨幅最大策略'}>
          <WarningOutlined className="ob-module-icon" />
          <span>卖点诊断</span>
          {isExtreme && <span className="ob-mode-switch-label">{STRATEGY_MODE_OPTIONS[1].label}</span>}
        </div>
        <div className="ob-diagnosis-actions">
          <span className={`ob-status-badge ${hitStocks.length > 0 ? 'hit' : ''}`}>
            {results.length === 0 ? '暂无持仓' : hitStocks.length > 0 ? `⚠️ ${hitStocks.length} 笔命中` : `${results.length} 笔持仓 · 未触发`}
          </span>
          <button className="ob-refresh-btn" onClick={handleRefresh} title="手动刷新">
            <ReloadOutlined />
          </button>
        </div>
      </div>
      <div className="ob-diagnosis-body" style={{ maxHeight: 530,overflowY: 'auto', minHeight: 522 }}>
        {results.length === 0 ? (
          <div className="ob-empty-mini" style={{ height: 500, fontSize: 16 }}>暂无持仓</div>
        ) : results.map((r) => (
          <div key={r.positionId || r.code} className={`ob-sell-stock ${r.isSell ? 'hit' : ''}`}>
            <div className="ob-sell-stock-header">
              {/* 第一行：股票名称 + 代码 */}
              <div className="ob-sell-header-row ob-sell-header-row--title">
                <div>
                  <span className="ob-sell-stock-name">{r.stockName}</span>
                  <span className="ob-sell-stock-code">{r.code}</span>
                </div>
                <span className={`ob-sell-stock-tag ${r.isSell ? 'hit' : 'safe'}`}>
                  {r.buyToday ? '买入当日' : r.error ? '诊断失败' : r.isSell ? '建议卖出' : '建议持有'}
                </span>
              </div>
              {/* 第二行：仓位 / 买入时间 / 成本线 / 涨幅 / 状态 */}
              <div className="ob-sell-header-row">
                {r.weight != null && (
                  <span className="ob-sell-stock-weight">仓位 {r.weight}%</span>
                )}
                <span className="ob-sell-stock-buytime">
                  买入 {r.buyDate || '--'}{r.buyTime ? ` ${r.buyTime}` : ''}
                </span>
                {r.costPrice != null && (
                  <span className="ob-sell-stock-cost">成本线 {Number(r.costPrice).toFixed(2)}</span>
                )}
                {r.detail?.change !== undefined && (
                  <span className={`ob-sell-stock-change ${r.detail.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                    {formatSignedPercent(r.detail.change)}
                  </span>
                )}
              </div>
            </div>
            <div className="ob-sell-stock-conds">
              {r.buyToday ? (
                <div className="ob-check-reason">买入当日卖点诊断不生效，次日起生效</div>
              ) : r.error ? (
                <div className="ob-check-reason">{r.error}</div>
              ) : (r.conditions && r.conditions.length > 0 ? r.conditions.sort((a, b) => (b.satisfied ? 3 : b.exempted ? 2 : b.pending ? 1 : 0) - (a.satisfied ? 3 : a.exempted ? 2 : a.pending ? 1 : 0)).map((cond, cidx) => (
                <div key={cidx} className={`ob-sell-cond ${cond.satisfied ? 'hit' : cond.exempted ? 'exempted' : cond.pending ? 'pending' : 'safe'}`}>
                  <span className="ob-sell-cond-name">{cond.name}</span>
                  <span className="ob-sell-cond-badge">
                    {cond.satisfied ? '触发' : cond.exempted ? '已豁免' : cond.pending ? (cond.pendingMinutes != null ? `确认中 ${cond.pendingMinutes}/5min` : '确认中') : '未触发'}
                  </span>
                  <div className="ob-sell-cond-detail">{cond.detail}</div>
                </div>
              )) : (
                <div className="ob-check-reason">{r.conclusion}</div>
              ))}
              {r.isSell && !r.buyToday && !r.error && (
                <div className="ob-sell-hint">{buildSellHint(r)}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={popupVisible}
        onCancel={() => setPopupVisible(false)}
        onOk={() => setPopupVisible(false)}
        okText="知道了"
        cancelButtonProps={{ style: { display: 'none' } }}
        title={<span><WarningOutlined style={{ color: '#cf1322', marginRight: 8 }} />卖点诊断命中</span>}
        className="ob-alert-modal"
      >
        <div className="ob-alert-content">
          <div className="ob-alert-big" style={{ color: '#cf1322' }}>⚠️ 以下持仓股触发卖点信号</div>
          {hitStocks.map((r) => (
            <div key={r.positionId || r.code} className="ob-alert-stock">
              <div className="ob-alert-stock-head">
                <b>{r.stockName}</b>
                <span className="ob-alert-stock-code">{r.code}</span>
                {r.weight != null && (
                  <span className="ob-alert-stock-weight">仓位 {r.weight}%</span>
                )}
                {r.detail?.change !== undefined && (
                  <span style={{ marginLeft: 'auto', fontWeight: 700, color: r.detail.change >= 0 ? '#e11d48' : '#059669' }}>
                    {formatSignedPercent(r.detail.change)}
                  </span>
                )}
              </div>
              <div className="ob-alert-hint">{buildSellHint(r)}</div>
              <div className="ob-alert-reason">{r.reasons?.join('；') || r.conclusion}</div>
            </div>
          ))}
          <div className="ob-alert-sub">建议分批减仓：先卖一半仓位，次日视开盘走势再决定是否清仓。</div>
        </div>
      </Modal>
    </div>
  );
};

// ==================== 主页面 ====================
const OpeningBattle = () => {
  // 进入页面时回到顶部，避免沿用上一页面遗留的滚动位置（路由切换或刷新都会重新触发）
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // 买点是否命中（由买点诊断卡片回调），命中时 3 日涨幅榜中唯一推荐标的的标签改为「买点触发」
  const [buyPointHit, setBuyPointHit] = useState(false);
  // 唯一推荐标的（3 日涨幅榜提供，供买点弹窗与飞书通知使用）
  const [buyableStocks, setBuyableStocks] = useState([]);

  // 持仓分时图展开状态，状态持久化到 localStorage
  const [rankExpanded, setRankExpanded] = useState(() => {
    try {
      return localStorage.getItem('ob_rank_expanded') === '1';
    } catch (e) {
      return false;
    }
  });

  const toggleRankExpanded = useCallback(() => {
    setRankExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem('ob_rank_expanded', next ? '1' : '0'); } catch (e) { }
      return next;
    });
  }, []);

  const handleBuyableChange = useCallback((stocks) => setBuyableStocks(stocks), []);

  return (
    <div className="opening-battle-container">
      <div className="ob-layout">
        {/* 第一行：资金分时图 | 资金明细 | 成交量（左） + 持仓分时图（右，与左侧模块等高） */}
        <div className="ob-row ob-row-first">
          <FundChartModule />
          <PositionIntradayModule expanded={rankExpanded} onToggleExpanded={toggleRankExpanded} />
        </div>
        {/* 第二行：自选股 3 日涨幅前五（上下分行） | 买点诊断 | 卖点诊断（三列等宽，高度由内容撑开） */}
        <div className="ob-row ob-row-second">
          <TopChange3dModule buyPointHit={buyPointHit} onBuyableChange={handleBuyableChange} />
          <BuyPointDiagnosisCard onResultChange={setBuyPointHit} buyableStocks={buyableStocks} />
          <SellPointDiagnosisCard />
        </div>
      </div>
    </div>
  );
};

export default OpeningBattle;
