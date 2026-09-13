import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export default function KLine({ data = [], height = 500, showResilience = false, onFetchResilience, onClickCandle }) {
  const container = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);
  const resilienceSeriesRef = useRef(null);
  const candlestickRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const ma5SeriesRef = useRef(null);
  const ma10SeriesRef = useRef(null);
  const ma20SeriesRef = useRef(null);
  const chartInitializedRef = useRef(false);
  const resilienceScoreMapRef = useRef({});
  const changeMapRef = useRef({});
  const [resilienceData, setResilienceData] = useState(null);
  const [resilienceLoading, setResilienceLoading] = useState(false);

  useEffect(() => {
    if (showResilience && onFetchResilience && !resilienceData && !resilienceLoading) {
      setResilienceLoading(true);
      onFetchResilience().then((data) => {
        setResilienceData(data);
        setResilienceLoading(false);
      }).catch((error) => {
        console.error('Fetch resilience data error:', error);
        setResilienceLoading(false);
      });
    }
    if (!showResilience && resilienceData) {
      setResilienceData(null);
    }
  }, [showResilience, onFetchResilience, resilienceData, resilienceLoading]);

  // 初始化图表（只执行一次）
  useEffect(() => {
    if (!container.current || chartInitializedRef.current) return;
    chartInitializedRef.current = true;

    const chart = createChart(container.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      width: container.current.clientWidth || 800,
      height: height,
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time) => {
          return time;
        },
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

    const resilienceSeries = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: 'price',
        precision: 2,
      },
      priceScaleId: 'resilience',
    });

    resilienceSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.05,
        bottom: 0.5,
      },
      borderColor: '#722ed1',
    });

    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '',
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    candlestickRef.current = candlestick;
    volumeSeriesRef.current = volumeSeries;
    ma5SeriesRef.current = ma5Series;
    ma10SeriesRef.current = ma10Series;
    ma20SeriesRef.current = ma20Series;
    resilienceSeriesRef.current = resilienceSeries;
    chartRef.current = chart;

    // Tooltip 逻辑
    const tooltip = tooltipRef.current;
    chart.subscribeCrosshairMove(param => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > container.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > height
      ) {
        tooltip.style.display = 'none';
      } else {
        const kData = param.seriesData.get(candlestick);
        const vData = param.seriesData.get(volumeSeries);
        const m5Data = param.seriesData.get(ma5Series);
        const m10Data = param.seriesData.get(ma10Series);
        const m20Data = param.seriesData.get(ma20Series);

        if (kData) {
          tooltip.style.display = 'block';
          const dateStr = typeof param.time === 'string' ? param.time : `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
          
          const volDisplay = vData ? (vData.value / 100000000).toFixed(2) + '亿' : '0.00亿';
          const ma5Display = m5Data ? m5Data.value.toFixed(2) : '-';
          const ma10Display = m10Data ? m10Data.value.toFixed(2) : '-';
          const ma20Display = m20Data ? m20Data.value.toFixed(2) : '-';
          const resilienceScore = resilienceScoreMapRef.current[dateStr];
          const resilienceDisplay = resilienceScore !== undefined ? resilienceScore.toFixed(2) : '-';
          const resilienceColor = resilienceScore >= 15 ? '#cf1322' : resilienceScore >= 10 ? '#fa8c16' : resilienceScore >= 5 ? '#722ed1' : '#bfbfbf';
          // 红绿严格按真实涨跌（vs 昨收）：涨红、跌绿、平盘灰
          const changeVal = changeMapRef.current[dateStr];
          const changeColor = changeVal === undefined ? '#333' : changeVal > 0 ? '#f5222d' : changeVal < 0 ? '#52c41a' : '#666';

          tooltip.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #eee; padding-bottom: 4px;">${dateStr}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>开盘:</span><span style="font-weight: bold;">${kData.open.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最高:</span><span style="font-weight: bold;">${kData.high.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最低:</span><span style="font-weight: bold;">${kData.low.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>收盘:</span><span style="font-weight: bold; color: ${changeColor}">${kData.close.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>成交额:</span><span style="font-weight: bold;">${volDisplay}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>涨跌:</span><span style="font-weight: bold; color: ${changeColor}">${changeVal !== undefined ? (changeVal > 0 ? '+' : '') + changeVal.toFixed(2) + '%' : '-'}</span></div>
            ${showResilience ? `<div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>抗分歧:</span><span style="font-weight: bold; color: ${resilienceColor}">${resilienceDisplay}</span></div>` : ''}
          `;

          const coordinate = candlestick.priceToCoordinate(kData.close);
          const tooltipWidth = 170;
          const margin = 10;
          
          setTimeout(() => {
            const actualHeight = tooltip.offsetHeight || 180;
            
            let left = param.point.x + margin;
            if (left + tooltipWidth > container.current.clientWidth - margin) {
              left = param.point.x - tooltipWidth - margin;
            }

            let top = coordinate !== undefined ? coordinate - actualHeight / 2 : param.point.y + margin;
            if (top < margin) {
              top = margin;
            }
            if (top + actualHeight > height - margin) {
              top = height - actualHeight - margin;
            }

            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
          }, 0);
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    chartRef.current = chart;

    // 点击 K 线回调
    if (onClickCandle) {
      chart.subscribeClick(param => {
        if (!param.time) return;
        let dateStr;
        if (typeof param.time === 'string') {
          dateStr = param.time;
        } else if (typeof param.time === 'object') {
          dateStr = `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
        } else {
          return;
        }
        onClickCandle(dateStr);
      });
    }

    // 响应式调整大小
    const handleResize = () => {
      if (container.current && chartRef.current) {
        chartRef.current.applyOptions({ width: container.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      chartInitializedRef.current = false;
    };
  }, [height]);

  // 数据更新：当 data 变化时更新图表数据（不重建图表）
  useEffect(() => {
    if (!chartInitializedRef.current || !chartRef.current) return;
    if (!data || data.length === 0) return;

    const candlestick = candlestickRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const ma5Series = ma5SeriesRef.current;
    const ma10Series = ma10SeriesRef.current;
    const ma20Series = ma20SeriesRef.current;
    const resilienceSeries = resilienceSeriesRef.current;
    const chart = chartRef.current;

    const klineData = [];
    const volumeData = [];
    const ma5Data = [];
    const ma10Data = [];
    const ma20Data = [];
    const resilienceScoreData = [];
    // 后端已按真实昨收算好的涨跌幅（data 为从新到旧排列，不能直接用相邻项互算）
    const rawChangeMap = {};

    data.forEach(i => {
      const dateStr = String(i.trade_date);
      const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;

      const item = {
        time: formattedDate,
        open: i.open_px,
        high: i.high_px,
        low: i.low_px,
        close: i.close_px,
      };

      klineData.push(item);

      if (typeof i.change === 'number' && !isNaN(i.change)) {
        rawChangeMap[formattedDate] = i.change;
      }

      // 成交量柱颜色严格按涨跌（vs 昨收）红绿，与主流行情软件一致
      const chg = typeof i.change === 'number' && !isNaN(i.change) ? i.change : null;
      const volColor = chg === null
        ? (i.close_px >= i.open_px ? 'rgba(245, 34, 45, 0.5)' : 'rgba(82, 196, 26, 0.5)')
        : chg > 0 ? 'rgba(245, 34, 45, 0.5)' : chg < 0 ? 'rgba(82, 196, 26, 0.5)' : 'rgba(166, 166, 166, 0.5)';

      volumeData.push({
        time: formattedDate,
        value: i.business_balance || 0,
        color: volColor,
      });

      if (i.ma5_px) {
        ma5Data.push({ time: formattedDate, value: i.ma5_px });
      }
      if (i.ma10_px) {
        ma10Data.push({ time: formattedDate, value: i.ma10_px });
      }
      if (i.ma20_px) {
        ma20Data.push({ time: formattedDate, value: i.ma20_px });
      }
    });

    if (showResilience && resilienceData && resilienceData.dailyResults) {
      const map = {};
      resilienceData.dailyResults.forEach(item => {
        const dateStr = String(item.date);
        const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        if (item.resilienceScore && typeof item.resilienceScore === 'number' && !isNaN(item.resilienceScore)) {
          resilienceScoreData.push({ time: formattedDate, value: item.resilienceScore });
          map[formattedDate] = item.resilienceScore;
        }
      });
      resilienceScoreMapRef.current = map;
    } else {
      resilienceScoreMapRef.current = {};
    }

    // 涨跌幅：优先后端 change 字段；缺失的日期按时间升序用收盘价补算
    const changeMap = { ...rawChangeMap };
    const ascending = [...klineData].sort((a, b) => a.time.localeCompare(b.time));
    for (let idx = 0; idx < ascending.length; idx++) {
      if (changeMap[ascending[idx].time] !== undefined) continue;
      if (idx > 0 && ascending[idx - 1].close) {
        changeMap[ascending[idx].time] = ((ascending[idx].close - ascending[idx - 1].close) / ascending[idx - 1].close) * 100;
      }
    }
    changeMapRef.current = changeMap;

    const deduplicate = (arr) => {
      if (arr.length === 0) return [];
      const filtered = arr.filter(item => {
        if (item.open !== undefined && item.high !== undefined && item.low !== undefined && item.close !== undefined) {
          return typeof item.open === 'number' && typeof item.high === 'number' && typeof item.low === 'number' && typeof item.close === 'number' && !isNaN(item.open) && !isNaN(item.high) && !isNaN(item.low) && !isNaN(item.close);
        }
        if (item.value !== undefined) {
          return typeof item.value === 'number' && !isNaN(item.value);
        }
        return true;
      });
      if (filtered.length === 0) return [];
      const sorted = filtered.sort((a, b) => a.time.localeCompare(b.time));
      const result = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].time !== sorted[i - 1].time) {
          result.push(sorted[i]);
        } else {
          result[result.length - 1] = sorted[i];
        }
      }
      return result;
    };

    candlestick.setData(deduplicate(klineData));
    volumeSeries.setData(deduplicate(volumeData));
    ma5Series.setData(deduplicate(ma5Data));
    ma10Series.setData(deduplicate(ma10Data));
    ma20Series.setData(deduplicate(ma20Data));

    if (showResilience && resilienceSeries) {
      resilienceSeries.setData(deduplicate(resilienceScoreData));
    }

    chart.timeScale().fitContent();
  }, [data, showResilience, resilienceData]);

  return (
    <div className="stock-kline-container" style={{ position: 'relative', width: '100%' }}>
      <div ref={container} style={{ height, width: '100%' }} />
      {showResilience && resilienceLoading && (
        <div 
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(255, 255, 255, 0.9)',
            padding: '12px 24px',
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            zIndex: 1001,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <svg 
            width="16" 
            height="16" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="#722ed1" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            style={{ animation: 'spin 1s linear infinite' }}
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <span style={{ color: '#722ed1', fontSize: '13px', fontWeight: 500 }}>加载抗分歧数据...</span>
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      )}
      <div 
        ref={tooltipRef}
        style={{
          width: '160px',
          maxHeight: '200px',
          position: 'absolute',
          display: 'none',
          padding: '8px',
          boxSizing: 'border-box',
          fontSize: '12px',
          textAlign: 'left',
          zIndex: 1000,
          top: '12px',
          left: '12px',
          pointerEvents: 'none',
          border: '1px solid #d1d4dc',
          borderRadius: '4px',
          background: 'rgba(255, 255, 255, 0.9)',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          color: '#333',
        }}
      />
    </div>
  );
}