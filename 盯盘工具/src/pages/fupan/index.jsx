import { useEffect, useState, useRef, useCallback } from 'react';
import { Layout, Row, Col, Card, Button, Input, message, Spin, Empty, Tag, Space, Tooltip as AntTooltip, Popconfirm } from 'antd';
import { FileTextOutlined, LineChartOutlined, SaveOutlined, DeleteOutlined, HistoryOutlined, ReloadOutlined, CalendarOutlined, EditOutlined, TagOutlined, GlobalOutlined } from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const { Sider, Content } = Layout;

const TAG_COLORS = [
  { name: 'red', color: '#f5222d', label: '红' },
  { name: 'green', color: '#52c41a', label: '绿' },
  { name: 'orange', color: '#fa8c16', label: '橙' },
];

const formatDateStr = (dateNum) => {
  if (!dateNum) return '';
  const str = String(dateNum);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
};

const parseDateStr = (dateStr) => {
  return parseInt(dateStr.replace(/-/g, ''));
};

const formatMinuteToTime = (minute) => {
  const minStr = String(minute).padStart(4, '0');
  return `${minStr.substring(0, 2)}:${minStr.substring(2, 4)}`;
};

const formatMoney = (num) => {
  if (num === null || num === undefined || isNaN(num)) return '-';
  const absNum = Math.abs(num);
  const sign = num >= 0 ? '' : '-';
  if (absNum >= 10000) {
    return sign + (absNum / 10000).toFixed(2) + '亿';
  } else if (absNum >= 1) {
    return sign + absNum.toFixed(2) + '万';
  }
  return sign + (absNum * 10000).toFixed(0);
};

const ChartTooltip = ({ visible, data }) => {
  if (!visible || !data) return null;
  return (
    <div 
      className="chart-tooltip"
      style={{ 
        position: 'absolute',
        left: data.x + 15,
        top: data.y - 10,
        zIndex: 100,
        pointerEvents: 'none',
      }}
    >
      {data.content}
    </div>
  );
};

const ClickableKLineChart = ({ data = [], height = 300, title = '', selectedDate, onDateClick }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candlestickSeriesRef = useRef(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipData, setTooltipData] = useState(null);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: containerRef.current.clientWidth,
      height: height,
      localization: {
        locale: 'zh-CN',
        priceFormatter: (price) => price?.toFixed(2) || '-',
        timeFormatter: (time) => {
          if (typeof time === 'object' && time.year) {
            return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
          }
          if (typeof time === 'string') {
            return time;
          }
          return time;
        },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'object' && time.year) {
            const now = dayjs();
            if (String(time.year) === String(now.year())) {
              return `${time.month}-${time.day}`;
            }
            return `${time.year}-${time.month}-${time.day}`;
          }
          if (typeof time === 'string') {
            const parts = time.split('-');
            const now = dayjs();
            if (parts[0] === String(now.year())) {
              return `${parts[1]}-${parts[2]}`;
            }
            return `${parts[0]}-${parts[1]}-${parts[2]}`;
          }
          return time;
        },
      },
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#999',
        },
        horzLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#999',
        },
      },
    });

    const candlestick = chart.addCandlestickSeries({
      upColor: '#f5222d',
      downColor: '#52c41a',
      borderVisible: false,
      wickUpColor: '#f5222d',
      wickDownColor: '#52c41a',
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const ma5Series = chart.addLineSeries({
      color: '#ff9800',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    const ma10Series = chart.addLineSeries({
      color: '#2196f3',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    const ma20Series = chart.addLineSeries({
      color: '#9c27b0',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    const klineData = [];
    const ma5Data = [];
    const ma10Data = [];
    const ma20Data = [];
    const originalDataMap = new Map();

    data.forEach((item) => {
      const dateStr = String(item.trade_date);
      const year = parseInt(dateStr.substring(0, 4));
      const month = parseInt(dateStr.substring(4, 6));
      const day = parseInt(dateStr.substring(6, 8));

      const open = parseFloat(item.open_px);
      const high = parseFloat(item.high_px);
      const low = parseFloat(item.low_px);
      const close = parseFloat(item.close_px);

      if (!isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
        const timeKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const kItem = { time: { year, month, day }, open, high, low, close };
        klineData.push(kItem);
        originalDataMap.set(timeKey, item);
      }
    });

    const validKlineData = klineData.sort((a, b) => {
      const aTime = `${a.time.year}-${String(a.time.month).padStart(2, '0')}-${String(a.time.day).padStart(2, '0')}`;
      const bTime = `${b.time.year}-${String(b.time.month).padStart(2, '0')}-${String(b.time.day).padStart(2, '0')}`;
      return aTime.localeCompare(bTime);
    });

    for (let i = 0; i < validKlineData.length; i++) {
      let ma5Sum = 0, ma10Sum = 0, ma20Sum = 0;
      let ma5Count = 0, ma10Count = 0, ma20Count = 0;

      for (let j = Math.max(0, i - 4); j <= i; j++) {
        ma5Sum += validKlineData[j].close;
        ma5Count++;
      }
      for (let j = Math.max(0, i - 9); j <= i; j++) {
        ma10Sum += validKlineData[j].close;
        ma10Count++;
      }
      for (let j = Math.max(0, i - 19); j <= i; j++) {
        ma20Sum += validKlineData[j].close;
        ma20Count++;
      }

      if (ma5Count >= 5) ma5Data.push({ time: validKlineData[i].time, value: parseFloat((ma5Sum / ma5Count).toFixed(2)) });
      if (ma10Count >= 10) ma10Data.push({ time: validKlineData[i].time, value: parseFloat((ma10Sum / ma10Count).toFixed(2)) });
      if (ma20Count >= 20) ma20Data.push({ time: validKlineData[i].time, value: parseFloat((ma20Sum / ma20Count).toFixed(2)) });
    }

    candlestick.setData(validKlineData);
    ma5Series.setData(ma5Data);
    ma10Series.setData(ma10Data);
    ma20Series.setData(ma20Data);

    chart.timeScale().fitContent();

    chart.subscribeClick((param) => {
      if (param.time) {
        let dateStr;
        if (typeof param.time === 'object' && param.time.year) {
          dateStr = `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
        } else {
          dateStr = param.time;
        }
        const dateNum = parseDateStr(dateStr);
        onDateClick(dateNum);
      }
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point || !containerRef.current) {
        setTooltipVisible(false);
        return;
      }

      let dateStr;
      if (typeof param.time === 'object' && param.time.year) {
        dateStr = `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
      } else {
        dateStr = param.time;
      }

      const candleData = param.seriesData.get(candlestick);
      const ma5Val = param.seriesData.get(ma5Series);
      const ma10Val = param.seriesData.get(ma10Series);
      const ma20Val = param.seriesData.get(ma20Series);

      if (candleData) {
        const change = candleData.close - candleData.open;
        const changePercent = candleData.open > 0 ? ((change / candleData.open) * 100).toFixed(2) : 0;
        const color = change >= 0 ? '#f5222d' : '#52c41a';
        
        const content = (
          <div style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
            <div style={{ fontSize: 12 }}>开: <span style={{ color }}>{candleData.open?.toFixed(2)}</span></div>
            <div style={{ fontSize: 12 }}>高: <span style={{ color: '#f5222d' }}>{candleData.high?.toFixed(2)}</span></div>
            <div style={{ fontSize: 12 }}>低: <span style={{ color: '#52c41a' }}>{candleData.low?.toFixed(2)}</span></div>
            <div style={{ fontSize: 12 }}>收: <span style={{ color }}>{candleData.close?.toFixed(2)}</span></div>
            <div style={{ fontSize: 12, color, marginTop: 4 }}>
              涨跌: {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePercent}%)
            </div>
            {ma5Val?.value !== undefined && <div style={{ fontSize: 12, color: '#ff9800' }}>MA5: {ma5Val.value.toFixed(2)}</div>}
            {ma10Val?.value !== undefined && <div style={{ fontSize: 12, color: '#2196f3' }}>MA10: {ma10Val.value.toFixed(2)}</div>}
            {ma20Val?.value !== undefined && <div style={{ fontSize: 12, color: '#9c27b0' }}>MA20: {ma20Val.value.toFixed(2)}</div>}
          </div>
        );

        setTooltipData({
          x: param.point.x,
          y: param.point.y,
          content,
        });
        setTooltipVisible(true);
      } else {
        setTooltipVisible(false);
      }
    });

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    chartRef.current = chart;
    candlestickSeriesRef.current = candlestick;

    return () => {
      window.removeEventListener('resize', handleResize);
      try {
        if (chartRef.current) {
          chartRef.current.remove();
          chartRef.current = null;
          candlestickSeriesRef.current = null;
        }
      } catch (e) {
        console.warn('Cleanup kline chart error:', e);
      }
    };
  }, [data, height, onDateClick]);

  useEffect(() => {
    if (!candlestickSeriesRef.current || data.length === 0) return;

    const markerDates = [];
    
    if (selectedDate) {
      const selectedFormatted = formatDateStr(selectedDate);
      const parts = selectedFormatted.split('-');
      // markerDates.push({
      //   time: { year: parseInt(parts[0]), month: parseInt(parts[1]), day: parseInt(parts[2]) },
      //   position: 'inBar',
      //   color: '#1890ff',
      //   shape: 'circle',
      //   size: 2,
      // });
    }

    const klineData = [];
    data.forEach((item) => {
      const dateStr = String(item.trade_date);
      const year = parseInt(dateStr.substring(0, 4));
      const month = parseInt(dateStr.substring(4, 6));
      const day = parseInt(dateStr.substring(6, 8));
      const open = parseFloat(item.open_px);
      const close = parseFloat(item.close_px);
      if (!isNaN(open) && !isNaN(close)) {
        klineData.push({ time: { year, month, day }, open, close });
      }
    });

    const validKlineData = klineData.sort((a, b) => {
      const aTime = `${a.time.year}-${String(a.time.month).padStart(2, '0')}-${String(a.time.day).padStart(2, '0')}`;
      const bTime = `${b.time.year}-${String(b.time.month).padStart(2, '0')}-${String(b.time.day).padStart(2, '0')}`;
      return aTime.localeCompare(bTime);
    });
    
    if (validKlineData.length > 0) {
      const lastData = validKlineData[validKlineData.length - 1];
      const lastTimeStr = `${lastData.time.year}-${String(lastData.time.month).padStart(2, '0')}-${String(lastData.time.day).padStart(2, '0')}`;
      const isSelectedLast = selectedDate && formatDateStr(selectedDate) === lastTimeStr;
      if (!isSelectedLast) {
        markerDates.push({
          time: lastData.time,
          position: 'inBar',
          color: lastData.close >= lastData.open ? '#f5222d' : '#52c41a',
          shape: 'circle',
          size: 1.5,
        });
      }
    }

    // candlestickSeriesRef.current.setMarkers(markerDates);
  }, [selectedDate, data]);

  return (
    <Card title={title} bordered={false} className="kline-card" size="small">
      <div style={{ position: 'relative', width: '100%', height }}>
        <div 
          ref={containerRef} 
          style={{ width: '100%', height: '100%' }}
        />
        <ChartTooltip visible={tooltipVisible} data={tooltipData} />
      </div>
    </Card>
  );
};

const TlineChart = ({ data = null, height = 280, title = '' }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipData, setTooltipData] = useState(null);

  const hasData = data && data.line && data.line.length > 0;

  useEffect(() => {
    if (!containerRef.current) return;

    if (chartRef.current) {
      try {
        chartRef.current.remove();
      } catch (e) {
        console.warn('Chart already removed:', e);
      }
      chartRef.current = null;
    }

    if (!hasData) {
      return;
    }

    const basePrice = data.preclose_px || (data.line[0]?.last_px || 0);
    
    const filteredLine = data.line.filter(item => {
      const minute = item.minute;
      if (!minute) return false;
      const timeStr = formatMinuteToTime(minute);
      if (timeStr >= '11:30' && timeStr < '13:00') {
        return false;
      }
      return true;
    });

    const sortedLine = [...filteredLine].sort((a, b) => a.minute - b.minute);

    const timeIndexMap = {};
    const chartData = [];
    const volumeChartData = [];
    const originalDataMap = new Map();

    sortedLine.forEach((item, index) => {
      const minute = item.minute;
      const minStr = String(minute).padStart(4, '0');
      const timeStr = `${minStr.substring(0, 2)}:${minStr.substring(2, 4)}`;
      timeIndexMap[index] = timeStr;

      const lastPx = parseFloat(item.last_px || item.av_px || 0);
      if (lastPx <= 0) return;

      chartData.push({
        time: index,
        value: lastPx,
      });

      const volume = item.business_amount || 0;
      volumeChartData.push({
        time: index,
        value: volume,
      });

      originalDataMap.set(index, item);
    });

    if (chartData.length === 0) {
      return;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
      },
      width: containerRef.current.clientWidth,
      height: height,
      grid: {
        vertLines: { color: '#f0f0f0', style: LineStyle.Dotted },
        horzLines: { color: '#f0f0f0', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          return timeIndexMap[time] || '';
        },
      },
      localization: {
        timeFormatter: (time) => {
          return timeIndexMap[time] || '';
        },
        priceFormatter: (price) => price?.toFixed(2) || '-',
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#999',
        },
        horzLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#999',
        },
      },
    });

    const lineSeries = chart.addLineSeries({
      color: '#1890ff',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const areaSeries = chart.addAreaSeries({
      topColor: 'rgba(24, 144, 255, 0.2)',
      bottomColor: 'rgba(24, 144, 255, 0.0)',
      lineColor: 'rgba(24, 144, 255, 0.0)',
      lineWidth: 0,
    });

    const volumeSeries = chart.addLineSeries({
      color: '#fa8c16',
      lineWidth: 1.5,
      priceFormat: {
        type: 'price',
        precision: 0,
        minMove: 1,
      },
      priceScaleId: 'volume-scale',
    });

    chart.priceScale('volume-scale').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    let lineColor = '#1890ff';
    if (chartData.length > 0) {
      const lastVal = chartData[chartData.length - 1].value;
      const change = basePrice > 0 ? ((lastVal - basePrice) / basePrice) * 100 : 0;
      lineColor = change >= 0 ? '#f5222d' : '#52c41a';
      lineSeries.applyOptions({ color: lineColor });
      areaSeries.applyOptions({
        topColor: change >= 0 ? 'rgba(245, 34, 45, 0.15)' : 'rgba(82, 196, 26, 0.15)',
        bottomColor: 'rgba(255, 255, 255, 0.0)',
      });
    }

    lineSeries.setData(chartData);
    areaSeries.setData(chartData);
    volumeSeries.setData(volumeChartData);

    const baselineSeries = chart.addLineSeries({
      color: '#999',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    baselineSeries.setData(chartData.map(d => ({ time: d.time, value: basePrice })));

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
      rightOffset: 0,
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point || !containerRef.current) {
        setTooltipVisible(false);
        return;
      }

      const timeIdx = param.time;
      const priceData = param.seriesData.get(lineSeries);
      const volData = param.seriesData.get(volumeSeries);
      const timeStr = timeIndexMap[timeIdx] || '';

      if (priceData && priceData.value !== undefined) {
        const price = priceData.value;
        const change = basePrice > 0 ? price - basePrice : 0;
        const changePercent = basePrice > 0 ? ((change / basePrice) * 100).toFixed(2) : 0;
        const color = change >= 0 ? '#f5222d' : '#52c41a';
        
        const content = (
          <div style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{timeStr}</div>
            <div style={{ fontSize: 12 }}>价格: <span style={{ color }}>{price.toFixed(2)}</span></div>
            <div style={{ fontSize: 12 }}>均价: <span style={{ color }}>-</span></div>
            <div style={{ fontSize: 12, color }}>
              涨跌: {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePercent}%)
            </div>
            {volData?.value !== undefined && (
              <div style={{ fontSize: 12, color: '#fa8c16' }}>
                成交量: {formatMoney(volData.value)}
              </div>
            )}
          </div>
        );

        setTooltipData({
          x: param.point.x,
          y: param.point.y,
          content,
        });
        setTooltipVisible(true);
      } else {
        setTooltipVisible(false);
      }
    });

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    chartRef.current = chart;

    return () => {
      window.removeEventListener('resize', handleResize);
      try {
        if (chartRef.current) {
          chartRef.current.remove();
          chartRef.current = null;
        }
      } catch (e) {
        console.warn('Cleanup chart error:', e);
      }
    };
  }, [data, height, hasData]);

  return (
    <Card title={title} bordered={false} className="tline-card" size="small">
      <div style={{ position: 'relative', width: '100%', height }}>
        <div 
          ref={containerRef} 
          style={{ 
            width: '100%', 
            height: '100%',
            display: hasData ? 'block' : 'none'
          }} 
        />
        {!hasData && (
          <div 
            style={{ 
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center' 
            }}
          >
            <Empty description="暂无分时数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        )}
        <ChartTooltip visible={tooltipVisible} data={tooltipData} />
      </div>
    </Card>
  );
};

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

const formatFundDisplayTime = (timeStr) => {
  if (timeStr.length >= 6) {
    return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
  }
  return timeStr;
};

const normalizeFundHistoryData = (fund5min, amount10min) => {
  const map = new Map();
  (fund5min || []).forEach(item => {
    map.set(item.time, {
      time: item.time,
      displayTime: formatFundDisplayTime(item.time),
      mainMoney: parseMoneyValue(item.mainMoney),
      amountChangeDiff: null,
    });
  });
  (amount10min || []).forEach(item => {
    const existing = map.get(item.time);
    if (existing) {
      existing.amountChangeDiff = parseMoneyValue(item.amountChangeDiff);
      // 若 fund5min 在该时间点缺少 mainMoney，但 amount10min 自带，则回退使用
      if ((existing.mainMoney === null || existing.mainMoney === undefined) &&
          item.mainMoney !== null && item.mainMoney !== undefined) {
        existing.mainMoney = parseMoneyValue(item.mainMoney);
      }
    } else {
      map.set(item.time, {
        time: item.time,
        displayTime: formatFundDisplayTime(item.time),
        mainMoney: item.mainMoney !== null && item.mainMoney !== undefined
          ? parseMoneyValue(item.mainMoney)
          : null,
        amountChangeDiff: parseMoneyValue(item.amountChangeDiff),
      });
    }
  });
  const sorted = Array.from(map.values()).sort((a, b) => a.time.localeCompare(b.time));
  let lastFund = 0;
  let lastAmount = 0;
  sorted.forEach(item => {
    if (item.mainMoney !== null && item.mainMoney !== undefined) {
      lastFund = item.mainMoney;
    } else {
      item.mainMoney = lastFund;
    }
    if (item.amountChangeDiff !== null && item.amountChangeDiff !== undefined) {
      lastAmount = item.amountChangeDiff;
    } else {
      item.amountChangeDiff = lastAmount;
    }
  });
  return sorted;
};

const FundCharts = ({ fundData = null, mainHeight = 250, volHeight = 250 }) => {
  const mainContainerRef = useRef(null);
  const volContainerRef = useRef(null);
  const mainChartRef = useRef(null);
  const volChartRef = useRef(null);
  const [mainTooltipVisible, setMainTooltipVisible] = useState(false);
  const [mainTooltipData, setMainTooltipData] = useState(null);
  const [volTooltipVisible, setVolTooltipVisible] = useState(false);
  const [volTooltipData, setVolTooltipData] = useState(null);

  const hasData = fundData && (fundData.fund5min?.length > 0 || fundData.amount10min?.length > 0);

  useEffect(() => {
    if (!mainContainerRef.current || !volContainerRef.current) return;

    if (mainChartRef.current) {
      try { mainChartRef.current.remove(); } catch (e) {}
      mainChartRef.current = null;
    }
    if (volChartRef.current) {
      try { volChartRef.current.remove(); } catch (e) {}
      volChartRef.current = null;
    }

    if (!hasData) {
      return;
    }

    const chartData = normalizeFundHistoryData(fundData.fund5min, fundData.amount10min);
    
    if (chartData.length === 0) return;

    const sortedData = [...chartData].sort((a, b) => a.time.localeCompare(b.time));

    const timeIndexMap = {};
    sortedData.forEach((item, index) => {
      timeIndexMap[index] = item.displayTime || formatFundDisplayTime(item.time);
    });

    const mainChart = createChart(mainContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
      },
      width: mainContainerRef.current.clientWidth,
      height: mainHeight,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#D1D4DC',
        tickMarkFormatter: (time) => timeIndexMap[time] || '',
      },
      localization: {
        timeFormatter: (time) => timeIndexMap[time] || '',
        priceFormatter: (price) => formatMoney(price),
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
        },
        horzLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
        },
      },
    });
    mainChartRef.current = mainChart;

    const mainSeries = mainChart.addLineSeries({
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const mainDataPoints = sortedData.map((item, idx) => ({
      time: idx,
      value: item.mainMoney,
      color: item.mainMoney >= 0 ? '#f5222d' : '#52c41a',
    }));
    mainSeries.setData(mainDataPoints);

    const zeroLine = mainChart.addLineSeries({
      color: '#999',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    zeroLine.setData(sortedData.map((_, idx) => ({ time: idx, value: 0 })));

    mainChart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setMainTooltipVisible(false);
        return;
      }
      const timeIdx = param.time;
      const fundVal = param.seriesData.get(mainSeries);
      const timeStr = timeIndexMap[timeIdx] || '';

      if (fundVal && fundVal.value !== undefined) {
        const color = fundVal.value >= 0 ? '#f5222d' : '#52c41a';
        const content = (
          <div style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{timeStr}</div>
            <div style={{ fontSize: 12 }}>
              主力净流入: <span style={{ color }}>{formatMoney(fundVal.value)}</span>
            </div>
          </div>
        );
        setMainTooltipData({ x: param.point.x, y: param.point.y, content });
        setMainTooltipVisible(true);
      } else {
        setMainTooltipVisible(false);
      }
    });

    mainChart.timeScale().fitContent();

    const volChart = createChart(volContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
      },
      width: volContainerRef.current.clientWidth,
      height: volHeight,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#D1D4DC',
        tickMarkFormatter: (time) => timeIndexMap[time] || '',
      },
      localization: {
        timeFormatter: (time) => timeIndexMap[time] || '',
        priceFormatter: (price) => formatMoney(price),
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
        },
        horzLine: {
          width: 1,
          color: '#999',
          style: LineStyle.Dashed,
        },
      },
    });
    volChartRef.current = volChart;

    const volSeries = volChart.addLineSeries({
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const volDataPoints = sortedData.map((item, idx) => ({
      time: idx,
      value: item.amountChangeDiff,
      color: item.amountChangeDiff >= 0 ? '#f5222d' : '#52c41a',
    }));
    volSeries.setData(volDataPoints);

    const zeroLineVol = volChart.addLineSeries({
      color: '#999',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    zeroLineVol.setData(sortedData.map((_, idx) => ({ time: idx, value: 0 })));

    volChart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setVolTooltipVisible(false);
        return;
      }
      const timeIdx = param.time;
      const volVal = param.seriesData.get(volSeries);
      const timeStr = timeIndexMap[timeIdx] || '';

      if (volVal && volVal.value !== undefined) {
        const color = volVal.value >= 0 ? '#f5222d' : '#52c41a';
        const content = (
          <div style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{timeStr}</div>
            <div style={{ fontSize: 12 }}>
              成交量变化: <span style={{ color }}>{formatMoney(volVal.value)}</span>
            </div>
          </div>
        );
        setVolTooltipData({ x: param.point.x, y: param.point.y, content });
        setVolTooltipVisible(true);
      } else {
        setVolTooltipVisible(false);
      }
    });

    volChart.timeScale().fitContent();

    const handleResize = () => {
      if (mainContainerRef.current && mainChartRef.current) {
        mainChartRef.current.applyOptions({ width: mainContainerRef.current.clientWidth });
      }
      if (volContainerRef.current && volChartRef.current) {
        volChartRef.current.applyOptions({ width: volContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      try { if (mainChartRef.current) { mainChartRef.current.remove(); mainChartRef.current = null; } } catch (e) {}
      try { if (volChartRef.current) { volChartRef.current.remove(); volChartRef.current = null; } } catch (e) {}
    };
  }, [fundData, mainHeight, volHeight, hasData]);

  return (
    <>
      <Col span={12}>
        <Card title="主力资金净流入（5分钟）" bordered={false} size="small" className="fund-card">
          <div style={{ position: 'relative', width: '100%', height: mainHeight }}>
            <div 
              ref={mainContainerRef} 
              style={{ 
                width: '100%', 
                height: '100%',
                display: hasData ? 'block' : 'none'
              }} 
            />
            {!hasData && (
              <div style={{ 
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center' 
              }}>
                <Empty description="暂无主力资金数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            )}
            <ChartTooltip visible={mainTooltipVisible} data={mainTooltipData} />
          </div>
        </Card>
      </Col>
      <Col span={12}>
        <Card title="成交量变化（10分钟）" bordered={false} size="small" className="fund-card">
          <div style={{ position: 'relative', width: '100%', height: volHeight }}>
            <div 
              ref={volContainerRef} 
              style={{ 
                width: '100%', 
                height: '100%',
                display: hasData ? 'block' : 'none'
              }} 
            />
            {!hasData && (
              <div style={{ 
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center' 
              }}>
                <Empty description="暂无成交量数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            )}
            <ChartTooltip visible={volTooltipVisible} data={volTooltipData} />
          </div>
        </Card>
      </Col>
    </>
  );
};

const OvernightMeigu = ({ data = [], loading = false }) => {
  if (loading && data.length === 0) {
    return (
      <Card bordered={false} size="small" className="overnight-meigu-card">
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin />
        </div>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card bordered={false} size="small" className="overnight-meigu-card">
        <Empty description="暂无隔夜美股数据" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '16px 0' }} />
      </Card>
    );
  }

  const sortedData = [...data].sort((a, b) => b.changePercent - a.changePercent);

  return (
    <Card bordered={false} size="small" className="overnight-meigu-card">
      <Row gutter={[8, 8]}>
        {sortedData.map((stock) => {
          const isUp = stock.changePercent >= 0;
          const color = isUp ? '#f5222d' : '#52c41a';
          return (
            <Col span={4} key={stock.code}>
              <div className="meigu-item" style={{ borderLeftColor: color }}>
                <div className="meigu-name" title={stock.name}>{stock.name}</div>
                <div className="meigu-price" style={{ color }}>
                  {stock.price.toFixed(2)}
                </div>
                <div className="meigu-change" style={{ color, background: isUp ? 'rgba(245,34,45,0.08)' : 'rgba(82,196,26,0.08)' }}>
                  {isUp ? '+' : ''}{stock.changePercent.toFixed(2)}%
                </div>
              </div>
            </Col>
          );
        })}
      </Row>
    </Card>
  );
};

const Fupan = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryDate = searchParams.get('date');
  const [indexKlineData, setIndexKlineData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(null);
  const [tlineData, setTlineData] = useState(null);
  const [tlineLoading, setTlineLoading] = useState(false);
  const [fundData, setFundData] = useState(null);
  const [fundLoading, setFundLoading] = useState(false);
  const [meiguData, setMeiguData] = useState([]);
  const [meiguLoading, setMeiguLoading] = useState(false);
  const [personalFeelings, setPersonalFeelings] = useState([]);
  const [personalFeelingsLoading, setPersonalFeelingsLoading] = useState(false);
  const [notesList, setNotesList] = useState([]);
  const [currentNote, setCurrentNote] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [currentTag, setCurrentTag] = useState('');
  const [currentTagColor, setCurrentTagColor] = useState('red');
  const [saving, setSaving] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [isContentModified, setIsContentModified] = useState(false);
  const vditorRef = useRef(null);
  const editorInstance = useRef(null);
  const vditorInitStartedRef = useRef(false);
  const currentNoteRef = useRef('');
  const currentTitleRef = useRef('');
  const currentTagRef = useRef('');
  const currentTagColorRef = useRef('red');
  const selectedDateRef = useRef(null);
  const notesListRef = useRef([]);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  useEffect(() => {
    currentNoteRef.current = currentNote;
  }, [currentNote]);

  useEffect(() => {
    currentTitleRef.current = currentTitle;
  }, [currentTitle]);

  useEffect(() => {
    currentTagRef.current = currentTag;
  }, [currentTag]);

  useEffect(() => {
    currentTagColorRef.current = currentTagColor;
  }, [currentTagColor]);

  useEffect(() => {
    notesListRef.current = notesList;
  }, [notesList]);

  const fetchNotesList = useCallback(async () => {
    setNotesLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/fupan/notes`);
      if (res.data.success) {
        const sortedNotes = (res.data.data || []).sort((a, b) => b.date - a.date);
        setNotesList(sortedNotes);
      }
    } catch (error) {
      console.error('获取复盘笔记列表失败:', error);
    } finally {
      setNotesLoading(false);
    }
  }, []);

  const fetchIndexKlineData = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/emotion_data`);
      const klineData = res.data.indexKlineData || null;
      setIndexKlineData(klineData);
      
      if (klineData?.shangzhengData?.length > 0) {
        const dates = klineData.shangzhengData.map(item => item.trade_date);
        // 如果 URL 有 date 参数，优先使用
        const queryDateNum = queryDate ? parseInt(queryDate) : null;
        if (queryDateNum && dates.includes(queryDateNum)) {
          setSelectedDate(queryDateNum);
        } else {
          const latestDate = Math.max(...dates);
          setSelectedDate(latestDate);
        }
      }
    } catch (error) {
      console.error('获取指数K线数据失败:', error);
      message.error('获取指数数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchTlineData = useCallback(async (date) => {
    if (!date) return;
    setTlineLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/fupan/index_tline?date=${date}`);
      if (res.data.success) {
        setTlineData(res.data.data);
      } else {
        setTlineData(null);
      }
    } catch (error) {
      console.error('获取分时数据失败:', error);
      setTlineData(null);
    } finally {
      setTlineLoading(false);
    }
  }, []);

  const fetchFundData = useCallback(async (date) => {
    if (!date) return;
    setFundLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/fund_snapshot/data?date=${date}`);
      if (res.data?.success) {
        setFundData(res.data.data);
      } else {
        setFundData(null);
      }
    } catch (error) {
      console.error('获取主力资金历史数据失败:', error);
      setFundData(null);
    } finally {
      setFundLoading(false);
    }
  }, []);

  const fetchMeiguData = useCallback(async (date, forceRefresh = false) => {
    setMeiguLoading(true);
    try {
      const params = new URLSearchParams();
      if (date) params.append('date', date);
      if (forceRefresh) params.append('refresh', '1');
      const query = params.toString();
      const res = await axios.get(`http://${local_ip}:3000/overnight_meigu${query ? `?${query}` : ''}`);
      if (res.data?.success) {
        setMeiguData(res.data.data || []);
      } else {
        setMeiguData([]);
      }
    } catch (error) {
      console.error('获取隔夜美股数据失败:', error);
      setMeiguData([]);
    } finally {
      setMeiguLoading(false);
    }
  }, []);

  const fetchNoteByDate = useCallback(async (date) => {
    if (!date) return;
    try {
      const res = await axios.get(`http://${local_ip}:3000/fupan/note?date=${date}`);
      if (res.data.success && res.data.data) {
        setCurrentNote(res.data.data.content || '');
        setCurrentTitle(res.data.data.title || formatDateStr(date) + ' 复盘');
        setCurrentTag(res.data.data.tag || '');
        setCurrentTagColor(res.data.data.tagColor || 'red');
      } else {
        setCurrentNote('');
        setCurrentTitle(formatDateStr(date) + ' 复盘');
        setCurrentTag('');
        setCurrentTagColor('red');
      }
    } catch (error) {
      console.error('获取复盘笔记失败:', error);
      setCurrentNote('');
      setCurrentTitle(formatDateStr(date) + ' 复盘');
      setCurrentTag('');
      setCurrentTagColor('red');
    }
  }, []);

  const fetchPersonalFeelings = useCallback(async (date) => {
    if (!date) return;
    setPersonalFeelingsLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/fupan/personal_feelings?date=${date}`);
      if (res.data?.success) {
        setPersonalFeelings(res.data.data?.records || []);
      } else {
        setPersonalFeelings([]);
      }
    } catch (error) {
      console.error('获取个人感受记录失败:', error);
      setPersonalFeelings([]);
    } finally {
      setPersonalFeelingsLoading(false);
    }
  }, []);

  const handleDateClick = useCallback((dateNum) => {
    setSelectedDate(dateNum);
    setTlineData(null);
    setFundData(null);
    setMeiguData([]);
  }, []);

  const handleNoteDateClick = useCallback((date) => {
    setSelectedDate(date);
    setTlineData(null);
    setFundData(null);
    setMeiguData([]);
  }, []);

  const handleTitleChange = (e) => {
    setCurrentTitle(e.target.value);
    setIsContentModified(true);
  };

  const handleTagChange = (e) => {
    setCurrentTag(e.target.value);
    setIsContentModified(true);
  };

  const handleTagColorChange = (color) => {
    setCurrentTagColor(color);
    setIsContentModified(true);
  };

  const handleSave = async () => {
    if (!selectedDate) {
      message.warning('请先点击K线选择日期');
      return;
    }
    if (!editorInstance.current) {
      message.warning('编辑器尚未加载完成');
      return;
    }
    
    const content = editorInstance.current.getValue() || '';
    const title = currentTitleRef.current?.trim() || formatDateStr(selectedDate) + ' 复盘';
    const tag = currentTagRef.current?.trim() || '';
    const tagColor = currentTagColorRef.current || 'red';
    
    setSaving(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/fupan/save`, {
        date: selectedDate,
        title,
        content,
        tag,
        tagColor
      });
      
      if (res.data.success) {
        message.success('复盘笔记保存成功');
        setCurrentNote(content);
        setCurrentTitle(res.data.title || title);
        setCurrentTag(tag);
        setCurrentTagColor(tagColor);
        setIsContentModified(false);
        fetchNotesList();
      } else {
        message.error('保存失败: ' + (res.data.error || '未知错误'));
      }
    } catch (error) {
      console.error('保存复盘笔记失败:', error);
      message.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteNote = async (date) => {
    try {
      const res = await axios.delete(`http://${local_ip}:3000/fupan/note?date=${date}`);
      if (res.data.success) {
        message.success('删除成功');
        fetchNotesList();
        if (date === selectedDate) {
          setCurrentNote('');
          setCurrentTitle(formatDateStr(date) + ' 复盘');
          setCurrentTag('');
          setCurrentTagColor('red');
          if (editorInstance.current) {
            editorInstance.current.setValue('');
          }
        }
      }
    } catch (error) {
      console.error('删除复盘笔记失败:', error);
      message.error('删除失败');
    }
  };

  const handleRefresh = () => {
    setLoading(true);
    setIndexKlineData(null);
    fetchIndexKlineData();
    fetchNotesList();
  };

  useEffect(() => {
    fetchIndexKlineData();
    fetchNotesList();
  }, [fetchNotesList]);

  useEffect(() => {
    if (selectedDate) {
      fetchTlineData(selectedDate);
      fetchNoteByDate(selectedDate);
      fetchFundData(selectedDate);
      fetchPersonalFeelings(selectedDate);
      fetchMeiguData(selectedDate);
    }
  }, [selectedDate, fetchTlineData, fetchNoteByDate, fetchFundData, fetchPersonalFeelings, fetchMeiguData]);

  useEffect(() => {
    if (loading || !indexKlineData) return;
    if (vditorInitStartedRef.current || editorInstance.current) return;
    vditorInitStartedRef.current = true;

    let initTimer = null;

    const initVditor = () => {
      if (!vditorRef.current) {
        initTimer = setTimeout(initVditor, 100);
        return;
      }

      const currentVditor = new Vditor(vditorRef.current, {
        minHeight: 300,
        height: 400,
        type: 'markdown',
        cache: { enable: false },
        placeholder: selectedDate ? `编写 ${formatDateStr(selectedDate)} 的复盘总结...` : '请先点击K线选择日期',
        toolbar: [
          'emoji',
          'headings',
          'bold',
          'italic',
          'strike',
          'line',
          'quote',
          'list',
          'ordered-list',
          'check',
          'outdent',
          'indent',
          'code',
          'inline-code',
          'link',
          'table',
          'color',
          'highlight',
          'undo',
          'redo',
          'fullscreen',
          'info',
          'help'
        ],
        input: (value) => {
          const savedNote = notesListRef.current.find(n => n.date === selectedDateRef.current);
          const savedTitle = savedNote?.title || formatDateStr(selectedDateRef.current) + ' 复盘';
          const savedTag = savedNote?.tag || '';
          const savedTagColor = savedNote?.tagColor || 'red';
          setIsContentModified(
            value !== currentNoteRef.current ||
            currentTitleRef.current !== savedTitle ||
            currentTagRef.current !== savedTag ||
            currentTagColorRef.current !== savedTagColor
          );
        },
        after: () => {
          editorInstance.current = currentVditor;
          if (currentNoteRef.current) {
            currentVditor.setValue(currentNoteRef.current);
          }
          setIsContentModified(false);
        }
      });
    };

    initTimer = setTimeout(initVditor, 300);

    return () => {
      if (initTimer) {
        clearTimeout(initTimer);
      }
    };
  }, [loading, indexKlineData]);

  useEffect(() => {
    if (editorInstance.current && currentNote !== undefined) {
      try {
        const currentVal = editorInstance.current.getValue();
        if (currentVal !== currentNote && !isContentModified) {
          editorInstance.current.setValue(currentNote || '');
          setIsContentModified(false);
        }
      } catch (e) {
        console.warn('Set editor value error:', e);
      }
    }
  }, [currentNote, isContentModified]);

  useEffect(() => {
    if (editorInstance.current) {
      try {
        const vditor = editorInstance.current;
        const textarea = vditor.vditor?.element?.querySelector('textarea');
        if (textarea && textarea.placeholder !== undefined) {
          textarea.placeholder = selectedDate ? `编写 ${formatDateStr(selectedDate)} 的复盘总结...` : '请先点击K线选择日期';
        }
      } catch (e) {
        console.warn('Update placeholder error:', e);
      }
    }
  }, [selectedDate]);

  useEffect(() => {
    return () => {
      if (editorInstance.current) {
        try {
          editorInstance.current.destroy();
        } catch (e) {
          console.warn('Destroy editor error:', e);
        }
        editorInstance.current = null;
      }
    };
  }, []);

  return (
    <Layout className="fupan-layout">
      <Content className="fupan-content">
        {loading ? (
          <div className="loading-container">
            <Spin size="large" tip="加载中..." />
          </div>
        ) : (
          <>
            {indexKlineData && (
              <>
                <div className="section-divider">
                  <LineChartOutlined /> 三大指数K线图（点击K线选择日期）
                </div>
                <Row gutter={[16, 16]}>
                  <Col span={8}>
                    <ClickableKLineChart 
                      data={indexKlineData.shangzhengData} 
                      height={300} 
                      title={<span><Tag color="red">上证指数</Tag></span>}
                      selectedDate={selectedDate}
                      onDateClick={handleDateClick}
                    />
                  </Col>
                  <Col span={8}>
                    <ClickableKLineChart 
                      data={indexKlineData.chuangyebanData} 
                      height={300} 
                      title={<span><Tag color="green">创业板指</Tag></span>}
                      selectedDate={selectedDate}
                      onDateClick={handleDateClick}
                    />
                  </Col>
                  <Col span={8}>
                    <ClickableKLineChart 
                      data={indexKlineData.kechuangbanData} 
                      height={300} 
                      title={<span><Tag color="blue">科创50</Tag></span>}
                      selectedDate={selectedDate}
                      onDateClick={handleDateClick}
                    />
                  </Col>
                </Row>

                <div className="section-divider">
                  <LineChartOutlined /> 当日分时图 {selectedDate ? `(${formatDateStr(selectedDate)})` : ''}
                  {tlineLoading && <Spin size="small" style={{ marginLeft: 12 }} />}
                </div>

                <Row gutter={[16, 16]}>
                  <Col span={8}>
                    {tlineLoading ? (
                      <Card bordered={false} size="small">
                        <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Spin />
                        </div>
                      </Card>
                    ) : (
                      <TlineChart data={tlineData?.shangzheng} height={280} title="上证指数分时" />
                    )}
                  </Col>
                  <Col span={8}>
                    {tlineLoading ? (
                      <Card bordered={false} size="small">
                        <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Spin />
                        </div>
                      </Card>
                    ) : (
                      <TlineChart data={tlineData?.chuangyeban} height={280} title="创业板指分时" />
                    )}
                  </Col>
                  <Col span={8}>
                    {tlineLoading ? (
                      <Card bordered={false} size="small">
                        <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Spin />
                        </div>
                      </Card>
                    ) : (
                      <TlineChart data={tlineData?.kechuangban} height={280} title="科创50分时" />
                    )}
                  </Col>
                </Row>

                <div className="section-divider">
                  <LineChartOutlined /> 主力资金与成交量 {selectedDate ? `(${formatDateStr(selectedDate)})` : ''}
                  {fundLoading && <Spin size="small" style={{ marginLeft: 12 }} />}
                </div>

                <Row gutter={[16, 16]} className="fund-row">
                  {fundLoading ? (
                    <Col span={24}>
                      <Card bordered={false} size="small">
                        <div style={{ height: 250, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Spin size="large" />
                        </div>
                      </Card>
                    </Col>
                  ) : (
                    <FundCharts fundData={fundData} mainHeight={250} volHeight={250} />
                  )}
                </Row>

                <div className="section-divider">
                  <GlobalOutlined /> 隔夜美股 {selectedDate ? `(${formatDateStr(selectedDate)})` : ''}
                  {meiguLoading && <Spin size="small" style={{ marginLeft: 12 }} />}
                  <span style={{ marginLeft: 'auto' }}>
                    <AntTooltip title="刷新（重新拉取当天数据）">
                      <Button
                        size="small"
                        type="text"
                        icon={<ReloadOutlined />}
                        onClick={() => fetchMeiguData(selectedDate, true)}
                        loading={meiguLoading}
                      />
                    </AntTooltip>
                  </span>
                </div>

                <OvernightMeigu data={meiguData} loading={meiguLoading} />

                <div className="section-divider">
                  <EditOutlined /> 个人感受记录 {selectedDate ? `(${formatDateStr(selectedDate)})` : ''}
                  {personalFeelingsLoading && <Spin size="small" style={{ marginLeft: 12 }} />}
                </div>

                <Card bordered={false} className="personal-feelings-card" size="small">
                  {personalFeelingsLoading ? (
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                      <Spin size="small" />
                    </div>
                  ) : personalFeelings.length === 0 ? (
                    <Empty description="当日暂无感受记录" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '16px 0' }} />
                  ) : (
                    <div className="personal-feelings-list">
                      {personalFeelings.map((record, idx) => (
                        <div key={record.time} className="personal-feelings-row">
                          <div className="personal-feelings-time">
                            <Tag color={idx === personalFeelings.length - 1 ? 'orange' : 'blue'} style={{ margin: 0 }}>
                              {record.time}
                            </Tag>
                          </div>
                          <div className="personal-feelings-content">
                            {record.feeling || <span style={{ color: '#ccc' }}>（未填写）</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <div className="section-divider">
                  <FileTextOutlined /> 复盘总结
                </div>

                <Card bordered={false} className="editor-card">
                  <div className="editor-header">
                    <div className="editor-header-row">
                      <div className="editor-title-input">
                        <EditOutlined style={{ color: '#999', marginRight: 8 }} />
                        <Input
                          value={currentTitle}
                          onChange={handleTitleChange}
                          placeholder="输入复盘标题..."
                          bordered={false}
                          style={{ fontSize: 16, fontWeight: 600, flex: 1 }}
                        />
                      </div>
                      <Space>
                        <CalendarOutlined style={{ color: '#999' }} />
                        <span style={{ color: '#666' }}>
                          {selectedDate ? formatDateStr(selectedDate) : '请选择日期'}
                        </span>
                        {isContentModified && (
                          <Tag color="orange" style={{ marginLeft: 8 }}>
                            未保存
                          </Tag>
                        )}
                      </Space>
                    </div>
                    <div className="editor-tag-row">
                      <span className="editor-tag-label">
                        <TagOutlined /> 标签
                      </span>
                      <Input
                        value={currentTag}
                        onChange={handleTagChange}
                        placeholder="为当天复盘添加标签（可选）"
                        size="small"
                        maxLength={10}
                        style={{ width: 200 }}
                      />
                      <div className="tag-color-selector">
                        {TAG_COLORS.map(c => (
                          <div
                            key={c.name}
                            className={`tag-color-dot ${currentTagColor === c.name ? 'selected' : ''}`}
                            style={{ background: c.color }}
                            onClick={() => handleTagColorChange(c.name)}
                            title={c.label}
                          />
                        ))}
                      </div>
                      {currentTag && (
                        <Tag color={currentTagColor} style={{ margin: 0 }}>
                          {currentTag}
                        </Tag>
                      )}
                    </div>
                  </div>
                  <div className="editor-toolbar">
                    <Space>
                      <AntTooltip title="刷新数据">
                        <Button 
                          icon={<ReloadOutlined />} 
                          onClick={handleRefresh}
                          loading={loading}
                          size="small"
                        >
                          刷新
                        </Button>
                      </AntTooltip>
                    </Space>
                    <Space>
                      <Button
                        onClick={() => navigate('/block?tab=smart&subTab=ai')}
                      >
                        主线分析
                      </Button>
                      <Button
                        type="primary"
                        icon={<SaveOutlined />}
                        onClick={handleSave}
                        loading={saving}
                        disabled={!selectedDate}
                      >
                        保存复盘
                      </Button>
                    </Space>
                  </div>
                  <div ref={vditorRef} style={{ minHeight: 400 }} />
                </Card>
              </>
            )}
          </>
        )}
      </Content>
      <Sider width={260} className="fupan-sider" theme="light">
        <Card 
          title={
            <span>
              <HistoryOutlined /> 复盘列表
            </span>
          } 
          size="small" 
          bordered={false}
          className="notes-card"
        >
          {notesLoading ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <Spin size="small" />
            </div>
          ) : notesList.length === 0 ? (
            <Empty 
              description="暂无复盘记录" 
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: '20px 0' }}
            />
          ) : (
            <div className="notes-list">
              {notesList.map(note => (
                <div 
                  key={note.date}
                  className={`note-item ${note.date === selectedDate ? 'active' : ''}`}
                  onClick={() => handleNoteDateClick(note.date)}
                >
                  <div className="note-info">
                    <div className="note-title" title={note.title || (formatDateStr(note.date) + ' 复盘')}>
                      <span className="note-title-text">
                        {note.title || (formatDateStr(note.date) + ' 复盘')}
                      </span>
                      {note.tag && (
                        <Tag color={note.tagColor || 'red'} className="note-tag">{note.tag}</Tag>
                      )}
                    </div>
                    <div className="note-date">
                      <CalendarOutlined style={{ marginRight: 6, fontSize: 12 }} />
                      {formatDateStr(note.date)}
                    </div>
                  </div>
                  <div className="note-actions">
                    {note.date === selectedDate && (
                      <Popconfirm
                        title="确定要删除这条复盘吗？"
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          handleDeleteNote(note.date);
                        }}
                        onCancel={(e) => e?.stopPropagation()}
                        okText="删除"
                        cancelText="取消"
                      >
                        <Button 
                          type="text" 
                          danger 
                          size="small" 
                          icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Popconfirm>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Sider>
    </Layout>
  );
};

export default Fupan;
