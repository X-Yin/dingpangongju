import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Spin, Modal, Empty, Switch as AntSwitch } from 'antd';
import {
  ThunderboltOutlined, RocketOutlined, RiseOutlined, FallOutlined, StockOutlined,
  AreaChartOutlined, CrownOutlined, RadarChartOutlined, WarningOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, ReloadOutlined, LockOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import './index.scss';

const isAfterMarketClose = () => {
  const now = dayjs();
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) return true;
  const currentHour = now.hour();
  const currentMinute = now.minute();
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

// 解析资金数值，统一成「亿」为单位
const parseMoneyValue = (val) => {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  let str = String(val);
  const sign = str.startsWith('-') ? -1 : 1;
  if (str.startsWith('+') || str.startsWith('-')) str = str.slice(1);
  let num = parseFloat(str.replace(/亿|万/g, '')) || 0;
  if (String(val).indexOf('万') !== -1) {
    num = num / 10000;
  }
  return sign * num;
};

const formatSignedPercent = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const formatDisplayTime = (timeStr) => {
  if (!timeStr) return '';
  if (timeStr.length >= 6) {
    return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
  }
  return timeStr;
};

const timeStrToMinutes = (timeStr) => {
  if (!timeStr || timeStr.length < 4) return 0;
  const h = parseInt(timeStr.substring(0, 2));
  const m = parseInt(timeStr.substring(2, 4));
  return h * 60 + m;
};

const minutesToTimeStr = (totalMin) => {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
};

const formatMinute = (minute) => {
  const m = Number(minute);
  if (!Number.isFinite(m)) return '';
  const h = Math.floor(m / 100);
  const min = m % 100;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

const aggregateToInterval = (data, intervalMinutes) => {
  if (!data || data.length === 0) return [];
  const sortedData = [...data].sort((a, b) => {
    const ta = Array.isArray(a) ? a[0] : a.time;
    const tb = Array.isArray(b) ? b[0] : b.time;
    return ta.localeCompare(tb);
  });

  const buckets = {};
  const tradingSlots = [];
  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;

  for (let t = morningStart; t <= morningEnd; t += intervalMinutes) tradingSlots.push(t);
  for (let t = afternoonStart; t <= afternoonEnd; t += intervalMinutes) tradingSlots.push(t);

  sortedData.forEach((item) => {
    const timeStr = Array.isArray(item) ? item[0] : (item.rawTime || item.time);
    const val = Array.isArray(item) ? item[1] : item;
    const totalMin = timeStrToMinutes(timeStr);
    let bucketMin = null;
    for (const slot of tradingSlots) {
      if (totalMin <= slot + intervalMinutes / 2) {
        bucketMin = slot;
        break;
      }
    }
    if (bucketMin === null && totalMin > tradingSlots[tradingSlots.length - 1]) {
      bucketMin = tradingSlots[tradingSlots.length - 1];
    }
    if (bucketMin !== null) {
      buckets[bucketMin] = { timeStr, val };
    }
  });

  const result = [];
  tradingSlots.forEach((slot) => {
    const entry = buckets[slot];
    const bucketTimeStr = minutesToTimeStr(slot);
    if (entry) {
      const mainMoney = Array.isArray(entry.val)
        ? parseMoneyValue(entry.val[1]?.mainMoney)
        : parseMoneyValue(entry.val.mainMoney);
      const amountChangeDiff = Array.isArray(entry.val)
        ? parseMoneyValue(entry.val[1]?.amountChangeDiff)
        : parseMoneyValue(entry.val.amountChangeDiff);
      result.push({
        time: bucketTimeStr,
        displayTime: formatDisplayTime(bucketTimeStr),
        mainMoney,
        amountChangeDiff,
        rawTime: entry.timeStr,
      });
    }
  });
  return result;
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
  const [fiveMinAggEnabled, setFiveMinAggEnabled] = useState(false);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const volumeChartContainerRef = useRef(null);
  const volumeChartRef = useRef(null);

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_history`);
      const newData = response.data || [];
      setData(newData);
      setLoading(false);
    } catch (err) {
      console.error('Fetch main fund data failed:', err);
      setLoading(false);
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
    return aggregateToInterval(data, 5);
  }, [data]);

  // 表格数据：根据开关决定是否聚合（保持原始数据逻辑）
  const todayTableData = useMemo(() => {
    if (!data || data.length === 0) return [];
    if (fiveMinAggEnabled) {
      return aggregateToInterval(data, 5);
    }
    // 过了11:30后按1分钟聚合，避免数据过多展示不下
    if (shouldAggregateByOneMin(data)) {
      return aggregateToInterval(data, 1);
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
      let prevChangedVal = mainMoney;
      for (let i = index + 1; i < sorted.length; i++) {
        const prevItem = sorted[i];
        const prevValue = parseMoneyValue(prevItem.mainMoney);
        if (i === index + 1) prevChangedVal = prevValue;
        let nextPrevVal = prevValue;
        if (i + 1 < sorted.length) nextPrevVal = parseMoneyValue(sorted[i + 1].mainMoney);
        if (prevValue !== nextPrevVal) { prevChangedVal = prevValue; break; }
      }
      const diff = mainMoney - prevChangedVal;
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
                ({diff >= 0 ? '+' : ''}{diff.toFixed(2)})
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
      {/* 第一行：主力资金 + 资金明细 */}
      <div className="ob-fund-row-top">
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
      </div>
      {/* 第二行：成交量（整行） */}
      <div className="ob-fund-row-bottom">
        <div className="ob-fund-chart-card ob-fund-chart-volume">
          <div className="ob-fund-chart-header">
            <span className="ob-fund-chart-title">成交量</span>
            <span className="ob-fund-chart-value" style={{ color: '#1890ff' }}>
              {latestVolume !== null && latestVolume !== undefined ? `${latestVolume >= 0 ? '+' : ''}${latestVolume.toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="ob-fund-chart-body ob-fund-chart-body-volume">
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

const PositionIntradayModule = () => {
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
    if (!isAfterMarketClose()) schedulePoll(fetchTlines, 10000);
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [positions]);

  return (
    <div className="ob-module ob-intraday-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <AreaChartOutlined className="ob-module-icon" />
          <span>持仓股分时图</span>
        </div>
        <span className="ob-total-tag">{positions.length} 只持仓</span>
      </div>
      {positions.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无持仓" style={{ padding: '18px 0' }} />
      ) : (
        <div className={`ob-intraday-grid ${positions.length >= 2 ? 'two' : 'single'}`}>
          {positions.map((stock) => (
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

// ==================== 全量自选股 3 日涨幅排行榜（前5） ====================
const TopChange3dModule = ({ buyPointHit }) => {
  const [stocks, setStocks] = useState([]);

  const fetchStocks = useCallback(async () => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/buy_point_stocks`, { sortBy: 'change' });
      const matched = res.data?.data?.matchedStocks || [];
      setStocks(matched.slice(0, 5));
    } catch (err) {
      console.error('获取3日涨幅排行失败:', err);
    }
  }, []);

  // 仅在买点条件满足时拉取数据：命中瞬间立即刷新一次，随后每隔 5s 轮询，直至买点条件不再满足
  useEffect(() => {
    if (!buyPointHit) return;
    fetchStocks();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        // 非交易日（周末）与交易日的非交易时间（<9:15 或 ≥14:59）停止轮询，保留最后一次数据
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchStocks, 5000);
    return () => timers.forEach(clearTimeout);
  }, [buyPointHit, fetchStocks]);

  return (
    <div className="ob-module ob-rank3-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <CrownOutlined className="ob-module-icon" />
          <span>自选股 3 日涨幅榜</span>
        </div>
        <span className="ob-total-tag">前 5 名</span>
      </div>
      <div className="ob-rank3-body">
        {!buyPointHit ? (
          <div className="ob-buy-not-ready">
            <span className="ob-buy-not-ready-icon"><LockOutlined /></span>
            当前买点条件不满足，暂不提供数据，以免影响情绪
          </div>
        ) : (
          <>
            <div className="ob-rank3-head">
              <span>#</span>
              <span>股票</span>
              <span>3日涨幅</span>
              <span>当日</span>
            </div>
            {stocks.length === 0 ? (
              <div className="ob-empty-mini">暂无数据</div>
            ) : stocks.map((s, idx) => (
              <div className="ob-rank3-row" key={`${s.code}-${idx}`}>
                <span className={`ob-rank ${idx < 3 ? 'ob-rank-top' : ''}`}>{idx + 1}</span>
                <span className="ob-stock-name">{s.stockName}</span>
                <span className={`ob-change-cell ${s.change3d >= 0 ? 'ob-up' : 'ob-down'}`}>
                  {s.change3d !== null && s.change3d !== undefined ? `${s.change3d >= 0 ? '+' : ''}${Number(s.change3d).toFixed(2)}%` : '--'}
                </span>
                <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                  {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

// ==================== 买点诊断卡片（自动运行） ====================
const BuyPointDiagnosisCard = ({ onResultChange }) => {
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [popupVisible, setPopupVisible] = useState(false);
  // 弹窗频控：命中后 5 分钟内不重复弹出（仅内存，刷新页面即重置）
  const lastPopupRef = useRef(0);

  const run = useCallback(async () => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: 1 });
      const result = res.data?.data;
      if (!result) return;
      setData(result);
      const hit = result.allPassed === true || result.tailDipBuyingHit === true;
      // 向上层汇报买点是否命中，供 3 日涨幅榜决定是否展示数据
      onResultChange?.(hit);
      // 触发条件：其它前置检查全部通过（allPassed），或尾盘抄底命中（tailDipBuyingHit）
      if (hit) {
        const now = Date.now();
        if (now - lastPopupRef.current >= 5 * 60 * 1000) {
          lastPopupRef.current = now;
          setPopupVisible(true);
        }
      }
    } catch (err) {
      console.error('自动买点诊断失败:', err);
    }
  }, [onResultChange]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await run(); } finally { setRefreshing(false); }
  }, [run]);

  // 买点诊断自动轮询调度：
  // 1. 首次挂载无条件立即执行一次（非交易时间也基于最近交易日数据展示诊断结果）
  // 2. 交易时段强制对齐 5min 整倍数执行（9:35, 9:40, 9:45 ... 13:05, 13:10 ...）
  // 3. 开盘宽限窗口（9:30:00-9:34:59，不足 5min）：保持每 10 秒执行一次
  useEffect(() => {
    const timers = [];
    let stopped = false;
    run(); // 首次立即执行

    // 是否处于开盘宽限窗口（9:30:00 - 9:34:59）
    const isInOpeningGraceWindow = (d) => {
      const minutes = d.hour() * 60 + d.minute();
      return minutes >= 9 * 60 + 30 && minutes < 9 * 60 + 35;
    };

    const scheduleNext = (immediateAllowed) => {
      if (stopped) return;
      const now = dayjs();
      if (isAfterMarketClose()) return; // 收盘/周末停止轮询

      let delay;
      if (isInOpeningGraceWindow(now)) {
        // 开盘初期每 10 秒一次，但最后一次不越过 9:35:00（由整倍数逻辑接管）
        const openingEnd = now.hour(9).minute(35).second(0).millisecond(0);
        delay = Math.min(10 * 1000, Math.max(openingEnd.diff(now), 0));
      } else {
        const minute = now.minute();
        const second = now.second() + now.millisecond() / 1000;
        if (immediateAllowed && minute % 5 === 0 && second < 30) {
          delay = 0; // 刚进入 5min 整倍数分钟的前 30 秒，立即执行
        } else {
          const nextMinute = (Math.floor(minute / 5) + 1) * 5;
          const next = (nextMinute >= 60
            ? now.add(1, 'hour').minute(nextMinute - 60)
            : now.minute(nextMinute)
          ).second(0).millisecond(0);
          delay = Math.max(next.diff(now), 0);
        }
      }

      const timer = setTimeout(() => {
        if (stopped || isAfterMarketClose()) return;
        run();
        scheduleNext(false);
      }, delay);
      timers.push(timer);
    };

    scheduleNext(true);
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
  }, [run]);

  const checks = data?.checks || [];
  const allPassed = data?.allPassed === true;
  const tailDipHit = data?.tailDipBuyingHit === true;
  const hit = allPassed || tailDipHit;

  return (
    <div className="ob-diagnosis-card ob-buy-card">
      {refreshing && (
        <div className="ob-refresh-mask">
          <Spin size="large" />
        </div>
      )}
      <div className="ob-diagnosis-header">
        <div className="ob-module-title">
          <RadarChartOutlined className="ob-module-icon" />
          <span>买点诊断</span>
        </div>
        <div className="ob-diagnosis-actions">
          <span className={`ob-status-badge ${hit ? 'hit' : ''}`}>
            {!data ? '诊断中...' : hit ? '🎯 已命中' : `未满足 ${data.passedCount}/${data.totalCheckCount}`}
          </span>
          <button className="ob-refresh-btn" onClick={handleRefresh} title="手动刷新">
            <ReloadOutlined />
          </button>
        </div>
      </div>
      <div className="ob-diagnosis-body">
        {!data ? (
          <div className="ob-diagnosis-loading"><Spin size="small" /></div>
        ) : (
          <>
            {checks.map((c) => (
              <div key={c.id} className={`ob-buy-check ${c.exempted ? 'exempted' : c.passed ? 'passed' : 'failed'}`}>
                <span className="ob-buy-check-icon">
                  {c.exempted ? <ClockCircleOutlined /> : c.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                </span>
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
            ))}
            <div className={`ob-conclusion ${hit ? 'hit' : ''}`}>
              {data.conclusion}
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
          <div className="ob-alert-reason">{data?.conclusion}</div>
          <div className="ob-alert-sub">
            命中类型：
            {allPassed && '全部前置条件通过'}
            {allPassed && tailDipHit && ' + '}
            {tailDipHit && '尾盘抄底命中'}
          </div>
          <div className="ob-alert-time">诊断时间：{data?.timestamp}</div>
        </div>
      </Modal>
    </div>
  );
};

// ==================== 卖点诊断卡片（自动运行） ====================
const SellPointDiagnosisCard = () => {
  const [results, setResults] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [popupVisible, setPopupVisible] = useState(false);
  // 弹窗频控：命中后 5 分钟内不重复弹出（仅内存，刷新页面即重置）
  const lastPopupRef = useRef(0);

  const run = useCallback(async () => {
    try {
      const posRes = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      const positions = posRes.data || [];
      if (positions.length === 0) {
        setResults([]);
        return;
      }
      const list = await Promise.all(
        positions.map(async (stock) => {
          try {
            const res = await axios.post(`http://${local_ip}:3000/check_single_stock_sell_point`, { code: stock.code });
            return { ...res.data, stockName: stock.name, code: stock.code };
          } catch (err) {
            return { code: stock.code, stockName: stock.name, error: '诊断失败' };
          }
        })
      );
      setResults(list);
      // 任一持仓命中卖点则弹窗提示（应用频控避免反复弹出）
      const hit = list.some((r) => r.isSell === true);
      if (hit) {
        const now = Date.now();
        if (now - lastPopupRef.current >= 5 * 60 * 1000) {
          lastPopupRef.current = now;
          setPopupVisible(true);
        }
      }
    } catch (err) {
      console.error('自动卖点诊断失败:', err);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await run(); } finally { setRefreshing(false); }
  }, [run]);

  useEffect(() => {
    run();
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
    if (!isAfterMarketClose()) schedulePoll(run, 10 * 1000);
    return () => timers.forEach(clearTimeout);
  }, [run]);

  const hitStocks = results.filter((r) => r.isSell === true);

  return (
    <div className="ob-diagnosis-card ob-sell-card">
      {refreshing && (
        <div className="ob-refresh-mask">
          <Spin size="large" />
        </div>
      )}
      <div className="ob-diagnosis-header">
        <div className="ob-module-title">
          <WarningOutlined className="ob-module-icon" />
          <span>卖点诊断</span>
        </div>
        <div className="ob-diagnosis-actions">
          <span className={`ob-status-badge ${hitStocks.length > 0 ? 'hit' : ''}`}>
            {results.length === 0 ? '暂无持仓' : hitStocks.length > 0 ? `⚠️ ${hitStocks.length} 只命中` : `${results.length} 只持仓 · 未触发`}
          </span>
          <button className="ob-refresh-btn" onClick={handleRefresh} title="手动刷新">
            <ReloadOutlined />
          </button>
        </div>
      </div>
      <div className="ob-diagnosis-body">
        {results.length === 0 ? (
          <div className="ob-empty-mini">暂无持仓，无法诊断</div>
        ) : results.map((r) => (
          <div key={r.code} className={`ob-sell-stock ${r.isSell ? 'hit' : ''}`}>
            <div className="ob-sell-stock-header">
              <span className="ob-sell-stock-name">{r.stockName}</span>
              <span className="ob-sell-stock-code">{r.code}</span>
              {r.detail?.change !== undefined && (
                <span className={`ob-sell-stock-change ${r.detail.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                  {formatSignedPercent(r.detail.change)}
                </span>
              )}
              <span className={`ob-sell-stock-tag ${r.isSell ? 'hit' : 'safe'}`}>
                {r.error ? '诊断失败' : r.isSell ? '建议卖出' : '建议持有'}
              </span>
            </div>
            <div className="ob-sell-stock-conds">
              {r.error ? (
                <div className="ob-check-reason">{r.error}</div>
              ) : (r.conditions && r.conditions.length > 0 ? r.conditions.map((cond, cidx) => (
                <div key={cidx} className={`ob-sell-cond ${cond.satisfied ? 'hit' : cond.pending ? 'pending' : 'safe'}`}>
                  <span className="ob-sell-cond-icon">
                    {cond.satisfied ? <CloseCircleOutlined /> : cond.pending ? <ClockCircleOutlined /> : <CheckCircleOutlined />}
                  </span>
                  <span className="ob-sell-cond-name">{cond.name}</span>
                  <span className="ob-sell-cond-badge">
                    {cond.satisfied ? '触发' : cond.pending ? `确认中 ${cond.pendingMinutes || 0}/5min` : '未触发'}
                  </span>
                  <div className="ob-sell-cond-detail">{cond.detail}</div>
                </div>
              )) : (
                <div className="ob-check-reason">{r.conclusion}</div>
              ))}
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
            <div key={r.code} className="ob-alert-stock">
              <div className="ob-alert-stock-head">
                <b>{r.stockName}</b>
                <span className="ob-alert-stock-code">{r.code}</span>
                {r.detail?.change !== undefined && (
                  <span style={{ marginLeft: 'auto', fontWeight: 700, color: r.detail.change >= 0 ? '#e11d48' : '#059669' }}>
                    {formatSignedPercent(r.detail.change)}
                  </span>
                )}
              </div>
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
  const [buyPointHit, setBuyPointHit] = useState(false);

  return (
    <div className="opening-battle-container">
      <div className="ob-page-title">
        <ThunderboltOutlined /> 开盘攻防
      </div>
      <div className="ob-layout">
        <div className="ob-left-col">
          <FundChartModule />
          {/* 第三行：持仓股分时图（独占一行） */}
          <div className="ob-bottom-row">
            <div className="ob-bottom-col-intraday">
              <PositionIntradayModule />
            </div>
          </div>
          {/* 第四行：自选股 3 日涨幅榜（独占一行） */}
          <div className="ob-bottom-row ob-bottom-row-rank">
            <div className="ob-bottom-col-intraday">
              <TopChange3dModule buyPointHit={buyPointHit} />
            </div>
          </div>
        </div>
        <div className="ob-right-col">
          <BuyPointDiagnosisCard onResultChange={setBuyPointHit} />
          <SellPointDiagnosisCard />
        </div>
      </div>
    </div>
  );
};

export default OpeningBattle;
