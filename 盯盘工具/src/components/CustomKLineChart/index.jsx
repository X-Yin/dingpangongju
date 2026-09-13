import { useState, useEffect, useRef, useMemo } from 'react';
import { createChart, ColorType } from 'lightweight-charts';
import { Button } from 'antd';
import { statusCodeColorMap, statusCodeLabelMap } from '../../constant';
import './index.scss';

export const calcAvgSlope = (stocks) => {
  if (!stocks || stocks.length < 3) return 0;
  const slopes = stocks.map(s => parseFloat(s.slope)).sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, 10);
  const trimmed = slopes.slice(1, -1);
  const sum = trimmed.reduce((acc, val) => acc + val, 0);
  return sum / trimmed.length;
};

const CustomKLineChart = ({ klineData, emotionCycleData, onStockClick, showFullData = false, onToggleFullData, onToggleCompact, hoveredEmotionData, setHoveredEmotionData, hoveredStrengthGap, setHoveredStrengthGap, isFixed, setIsFixed }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRefs = useRef({});
  const [lineVisibility, setLineVisibility] = useState({
    slope: true,
    strengthGap: true,
    strongSlope: false,
    weakSlope: false,
    slopeDiff: false,
  });
  const isFixedRef = useRef(false);
  const clickCountRef = useRef(0);
  const lastClickTimeRef = useRef(0);
  
  useEffect(() => {
    isFixedRef.current = isFixed;
  }, [isFixed]);

  const processedKlineData = useMemo(() => {
    if (!klineData || klineData.length === 0) return [];
    
    let data = klineData;
    if (!showFullData && klineData.length > 50) {
      data = klineData.slice(-50);
    }
    
    return data.map(item => {
      const date = item.trade_date;
      const emotionData = emotionCycleData?.find(e => e.tradeDate === date);
      const statusColor = emotionData ? statusCodeColorMap[emotionData.statusCode] || '#a0aec0' : '#a0aec0';
      const isUp = parseFloat(item.close_px) >= parseFloat(item.open_px);
      const change = item.pre_close_px 
        ? ((parseFloat(item.close_px) - parseFloat(item.pre_close_px)) / parseFloat(item.pre_close_px) * 100).toFixed(2)
        : ((parseFloat(item.close_px) - parseFloat(item.open_px)) / parseFloat(item.open_px) * 100).toFixed(2);
      const avgMarketSlope = emotionData?.stats?.avgMarketSlope || 0;
      
      let strengthGap = 0;
      let strongAvgSlope = 0;
      let weakAvgSlope = 0;
      let slopeDiff = 0;
      if (emotionData) {
        const strongStocks = emotionData.strongStocks || [];
        const weakStocks = emotionData.weakStocks || [];
        strongAvgSlope = calcAvgSlope(strongStocks);
        weakAvgSlope = calcAvgSlope(weakStocks);
        // if (date === 20260615) {
        //   console.log('123412341234', weakAvgSlope, weakStocks.map(s => parseFloat(s.slope)).sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, 10));
        // }
        strengthGap = parseFloat(strongAvgSlope - weakAvgSlope).toFixed(2);
        slopeDiff = parseFloat((strengthGap - parseFloat(avgMarketSlope)).toFixed(2));
      }
      
      const dateStr = String(date);
      const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
      return {
        time: formattedDate,
        open: parseFloat(item.open_px),
        high: parseFloat(item.high_px),
        low: parseFloat(item.low_px),
        close: parseFloat(item.close_px),
        volume: parseFloat(item.business_amount) || 0,
        color: statusColor,
        borderColor: statusColor,
        wickColor: statusColor,
        emotionData,
        change,
        avgMarketSlope,
        strengthGap,
        strongAvgSlope: parseFloat(strongAvgSlope.toFixed(2)),
        weakAvgSlope: parseFloat(weakAvgSlope.toFixed(2)),
        slopeDiff,
      };
    }).sort((a, b) => a.time.localeCompare(b.time));
  }, [klineData, emotionCycleData, showFullData]);

  const slopeLineData = useMemo(() => {
    return processedKlineData.map(d => ({
      time: d.time,
      value: parseFloat(d.avgMarketSlope),
    }));
  }, [processedKlineData]);

  const strengthGapLineData = useMemo(() => {
    return processedKlineData.map(d => ({
      time: d.time,
      value: parseFloat(d.strengthGap),
    }));
  }, [processedKlineData]);

  const strongSlopeLineData = useMemo(() => {
    return processedKlineData.map(d => ({
      time: d.time,
      value: parseFloat(d.strongAvgSlope),
    }));
  }, [processedKlineData]);

  const weakSlopeLineData = useMemo(() => {
    return processedKlineData.map(d => ({
      time: d.time,
      value: parseFloat(d.weakAvgSlope),
    }));
  }, [processedKlineData]);

  const slopeDiffLineData = useMemo(() => {
    return processedKlineData.map(d => ({
      time: d.time,
      value: parseFloat(d.slopeDiff),
    }));
  }, [processedKlineData]);

  useEffect(() => {
    if (!containerRef.current || processedKlineData.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      width: containerRef.current.clientWidth,
      height: 500,
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time) => time,
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'string') {
            const parts = time.split('-');
            return `${parts[1]}/${parts[2]}`;
          }
          if (time && typeof time === 'object') {
            return `${time.month}/${time.day}`;
          }
          return time;
        },
      },
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      handleScroll: false,
      handleScale: false,
    });

    const candlestick = chart.addCandlestickSeries({
      upColor: '#f5222d',
      downColor: '#52c41a',
      borderVisible: false,
      wickUpColor: '#f5222d',
      wickDownColor: '#52c41a',
    });

    candlestick.setData(processedKlineData);

    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '',
    });

    volumeSeries.setData(processedKlineData.map(d => ({
      time: d.time,
      value: d.volume,
      color: parseFloat(d.close) >= parseFloat(d.open) ? '#f5222d' : '#52c41a',
    })));

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.75,
        bottom: 0,
      },
    });

    candlestick.priceScale().applyOptions({
      scaleMargins: {
        top: 0.1,
        bottom: 0.25,
      },
    });

    const slopeLine = chart.addLineSeries({
      color: '#1890ff',
      lineWidth: 2,
      priceScaleId: 'slope',
    });

    slopeLine.setData(slopeLineData);

    slopeLine.priceScale().applyOptions({
      scaleMargins: {
        top: 0.1,
        bottom: 0.25,
      },
      borderColor: '#1890ff',
      position: 'right',
    });

    slopeLine.createPriceLine({
      price: 2.5,
      color: '#f5222d',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
    });

    const strengthGapLine = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 2,
      priceScaleId: 'slope',
    });

    strengthGapLine.setData(strengthGapLineData);

    const strongSlopeLine = chart.addLineSeries({
      color: '#fa8c16',
      lineWidth: 2,
      priceScaleId: 'slope',
    });

    strongSlopeLine.setData(strongSlopeLineData);

    const weakSlopeLine = chart.addLineSeries({
      color: '#13c2c2',
      lineWidth: 2,
      priceScaleId: 'slope',
    });

    weakSlopeLine.setData(weakSlopeLineData);

    const slopeDiffLine = chart.addLineSeries({
      color: '#eb2f96',
      lineWidth: 2,
      priceScaleId: 'slope',
    });

    slopeDiffLine.setData(slopeDiffLineData);

    seriesRefs.current = { slopeLine, strengthGapLine, strongSlopeLine, weakSlopeLine, slopeDiffLine };

    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
    });

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (param.time) {
        const timeStr = typeof param.time === 'object' 
          ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
          : String(param.time);
        const klineItem = processedKlineData.find(d => d.time === timeStr);
        const emotionData = klineItem?.emotionData;
        
        if (!isFixedRef.current) {
          setHoveredEmotionData(emotionData || null);
          setHoveredStrengthGap(parseFloat(klineItem?.strengthGap) || 0);
        }
        
        if (klineItem) {
          const changeVal = parseFloat(klineItem.change);
          const slopeVal = parseFloat(klineItem.avgMarketSlope);
          const strengthGapVal = parseFloat(klineItem.strengthGap) || 0;
          const customTooltip = document.getElementById('custom-chart-tooltip');
          if (customTooltip && param.point) {
            customTooltip.style.display = 'block';
            customTooltip.style.left = `${param.point.x}px`;
            customTooltip.style.top = `${param.point.y +140}px`;
            customTooltip.innerHTML = `
              <div class="custom-tooltip-date">${timeStr}</div>
              <div class="custom-tooltip-row">
                <span class="custom-tooltip-label">涨幅</span>
                <span class="custom-tooltip-value ${changeVal >= 0 ? 'up' : 'down'}">${changeVal >= 0 ? '+' : ''}${changeVal}%</span>
              </div>
              <div class="custom-tooltip-row">
                <span class="custom-tooltip-label">三日线斜率</span>
                <span class="custom-tooltip-value ${slopeVal >= 0 ? 'up' : 'down'}">${slopeVal >= 0 ? '+' : ''}${slopeVal}°</span>
              </div>
              <div class="custom-tooltip-row">
                <span class="custom-tooltip-label">强弱差距</span>
                <span class="custom-tooltip-value ${strengthGapVal >= 0 ? 'up' : 'down'}">${strengthGapVal >= 0 ? '+' : ''}${strengthGapVal}°</span>
              </div>
            `;
          }
        }
      } else {
        if (!isFixedRef.current) {
          setHoveredEmotionData(null);
        }
        const customTooltip = document.getElementById('custom-chart-tooltip');
        if (customTooltip) {
          customTooltip.style.display = 'none';
        }
      }
    });

    chart.subscribeClick((param) => {
      if (param.time) {
        const timeStr = typeof param.time === 'object' 
          ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
          : String(param.time);
        const klineItem = processedKlineData.find(d => d.time === timeStr);
        if (klineItem?.emotionData) {
          setHoveredEmotionData(klineItem.emotionData);
        }
        setIsFixed(true);
      }
    });

    chartRef.current = chart;

    return () => {
      chart.remove();
    };
  }, [processedKlineData]);

  useEffect(() => {
    const refs = seriesRefs.current;
    if (!refs || !refs.slopeLine) return;
    const keyMap = {
      slope: 'slopeLine',
      strengthGap: 'strengthGapLine',
      strongSlope: 'strongSlopeLine',
      weakSlope: 'weakSlopeLine',
      slopeDiff: 'slopeDiffLine',
    };
    Object.entries(keyMap).forEach(([key, refKey]) => {
      if (refs[refKey]) {
        refs[refKey].applyOptions({ visible: lineVisibility[key] });
      }
    });
  }, [lineVisibility, processedKlineData]);

  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const formatDateStr = (dateStr) => {
    if (!dateStr) return '';
    const str = String(dateStr);
    return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
  };

  if (processedKlineData.length === 0) {
    return <div className="custom-kline-empty">暂无K线数据</div>;
  }

  return (
    <div className="custom-kline-container">
      <div className="custom-kline-legend">
        <span className="legend-title">情绪周期颜色标识：</span>
        {Object.entries(statusCodeLabelMap).map(([code, label]) => (
          <div key={code} className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: statusCodeColorMap[code] }} />
            <span>{label}</span>
          </div>
        ))}
        {(klineData && klineData.length > 50 && !showFullData && onToggleFullData) && (
          <Button
            type="primary"
            size="small"
            onClick={onToggleFullData}
            style={{ marginLeft: 'auto' }}
          >
            查看更早数据
          </Button>
        )}
        {showFullData && onToggleCompact && (
          <Button
            type="default"
            size="small"
            onClick={onToggleCompact}
            style={{ marginLeft: 'auto' }}
          >
            收起
          </Button>
        )}
      </div>
      <div className="custom-kline-line-legend">
        {[
          { key: 'slope', color: '#1890ff', label: '三日线平均斜率' },
          { key: 'strengthGap', color: '#722ed1', label: '强弱差距值' },
          { key: 'strongSlope', color: '#fa8c16', label: '强势股平均斜率' },
          { key: 'weakSlope', color: '#13c2c2', label: '弱势股平均斜率' },
          { key: 'slopeDiff', color: '#eb2f96', label: '差距-斜率差值' },
        ].map(item => (
          <div
            key={item.key}
            className="line-legend-item clickable"
            onClick={() => setLineVisibility(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
          >
            <span className="line-legend-line" style={{ backgroundColor: lineVisibility[item.key] ? item.color : '#d9d9d9' }} />
            <span style={{ color: lineVisibility[item.key] ? '#333' : '#bbb' }}>{item.label}</span>
          </div>
        ))}
        <div className="line-legend-item">
          <span className="line-legend-line dashed" style={{ backgroundColor: '#f5222d' }} />
          <span>主升期阈值(2.5°)</span>
        </div>
      </div>
      <div className="custom-kline-chart-wrapper">
        <div ref={containerRef} className="custom-kline-chart" />
        <div id="custom-chart-tooltip" className="custom-chart-tooltip" />
      </div>
    </div>
  );
};

export default CustomKLineChart;