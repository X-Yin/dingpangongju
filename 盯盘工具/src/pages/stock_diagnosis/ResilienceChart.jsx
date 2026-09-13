import { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export default function ResilienceChart({ klineData, resilienceData, height = 500 }) {
  const container = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!container.current) return;

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

    const resilienceSeries = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
      priceScaleId: 'resilience',
    });

    resilienceSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.1,
        bottom: 0.25,
      },
      borderColor: '#D1D4DC',
    });

    const klineFormatted = klineData.map(item => {
      const dateStr = String(item.trade_date);
      return {
        time: `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`,
        open: item.open_px,
        high: item.high_px,
        low: item.low_px,
        close: item.close_px,
      };
    }).filter(item => 
      typeof item.open === 'number' && 
      typeof item.high === 'number' && 
      typeof item.low === 'number' && 
      typeof item.close === 'number' &&
      !isNaN(item.open) && !isNaN(item.high) && !isNaN(item.low) && !isNaN(item.close)
    ).sort((a, b) => a.time.localeCompare(b.time)).slice(-50);

    const volumeFormatted = klineData.map(item => {
      const dateStr = String(item.trade_date);
      return {
        time: `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`,
        value: item.business_balance || 0,
        color: item.close_px >= item.open_px ? 'rgba(245, 34, 45, 0.5)' : 'rgba(82, 196, 26, 0.5)',
      };
    }).filter(item => typeof item.value === 'number' && !isNaN(item.value))
      .sort((a, b) => a.time.localeCompare(b.time)).slice(-50);

    const klineDates = new Set(klineFormatted.map(item => item.time));

    const resilienceFormatted = resilienceData
      .filter(item => !item.error && item.resilienceScore !== undefined && typeof item.resilienceScore === 'number' && !isNaN(item.resilienceScore))
      .map(item => {
        const dateStr = String(item.date);
        return {
          time: `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`,
          value: item.resilienceScore,
        };
      })
      .filter(item => klineDates.has(item.time))
      .sort((a, b) => a.time.localeCompare(b.time));

    candlestick.setData(klineFormatted);
    volumeSeries.setData(volumeFormatted);
    resilienceSeries.setData(resilienceFormatted);

    chart.timeScale().fitContent();

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
        const rData = param.seriesData.get(resilienceSeries);

        if (kData) {
          tooltip.style.display = 'block';
          const dateStr = typeof param.time === 'string' ? param.time : `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
          
          const resilienceDisplay = rData ? rData.value.toFixed(2) : '-';

          const change = kData.open > 0 ? ((kData.close - kData.open) / kData.open * 100) : 0;
          const changeColor = change > 0 ? '#f5222d' : change < 0 ? '#52c41a' : '#8c8c8c';
          
          tooltip.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #eee; padding-bottom: 4px;">${dateStr}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>开盘:</span><span style="font-weight: bold;">${kData.open.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最高:</span><span style="font-weight: bold;">${kData.high.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最低:</span><span style="font-weight: bold;">${kData.low.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>收盘:</span><span style="font-weight: bold; color: ${kData.close >= kData.open ? '#f5222d' : '#52c41a'}">${kData.close.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>涨幅:</span><span style="font-weight: bold; color: ${changeColor}">${change > 0 ? '+' : ''}${change.toFixed(2)}%</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>抗分歧:</span><span style="font-weight: bold; color: ${resilienceDisplay !== '-' && parseFloat(resilienceDisplay) >= 10 ? '#f5222d' : '#52c41a'}">${resilienceDisplay}</span></div>
          `;

          const coordinate = candlestick.priceToCoordinate(kData.close);
          const tooltipWidth = 150;
          const tooltipHeight = 160;
          const margin = 10;

          let left = param.point.x + margin;
          if (left + tooltipWidth > container.current.clientWidth - margin) {
            left = param.point.x - tooltipWidth - margin;
          }

          let top = coordinate !== undefined ? coordinate - tooltipHeight / 2 : param.point.y + margin;
          if (top < margin) {
            top = margin;
          }
          if (top + tooltipHeight > height - margin) {
            top = height - tooltipHeight - margin;
          }

          tooltip.style.left = left + 'px';
          tooltip.style.top = top + 'px';
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    chartRef.current = chart;

    const handleResize = () => {
      if (container.current && chartRef.current) {
        chartRef.current.applyOptions({ width: container.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [klineData, resilienceData, height]);

  return (
    <div className="resilience-chart-container" style={{ position: 'relative', width: '100%' }}>
      <div ref={container} style={{ height, width: '100%' }} />
      <div 
        ref={tooltipRef}
        style={{
          width: '150px',
          minHeight: '160px',
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
          background: 'rgba(255, 255, 255, 0.95)',
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          color: '#333',
        }}
      />
    </div>
  );
}
