import { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

/**
 * 回测 K 线图组件
 * 在 StockKLine 基础上支持买卖点 markers 和抗分歧分数
 *
 * @param {Array} data K 线数据 [{ trade_date, open_px, high_px, low_px, close_px, business_balance, change, ma5_px, ma10_px, ma20_px, resilienceScore }]
 * @param {Array} markers 标记点 [{ time: 'YYYY-MM-DD', position: 'aboveBar'|'belowBar', color, shape: 'arrowUp'|'arrowDown', text }]
 * @param {Number} height 图表高度
 */
export default function BacktestKLineChart({ data = [], markers = [], height = 420 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: containerRef.current.clientWidth || 800,
      height: height,
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'string') {
            const parts = time.split('-');
            return `${parts[1]}/${parts[2]}`;
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

    chartRef.current = chart;

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

    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    const klineData = [];
    const volumeData = [];
    const ma5Data = [];
    const ma10Data = [];
    const ma20Data = [];
    const changeMap = {};
    const resilienceMap = {};

    data.forEach(i => {
      const dateStr = String(i.trade_date);
      const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;

      if (
        typeof i.open_px !== 'number' || typeof i.high_px !== 'number' ||
        typeof i.low_px !== 'number' || typeof i.close_px !== 'number' ||
        isNaN(i.open_px) || isNaN(i.high_px) || isNaN(i.low_px) || isNaN(i.close_px)
      ) {
        return;
      }

      klineData.push({
        time: formattedDate,
        open: i.open_px,
        high: i.high_px,
        low: i.low_px,
        close: i.close_px,
      });
      changeMap[formattedDate] = i.change;
      resilienceMap[formattedDate] = i.resilienceScore;

      volumeData.push({
        time: formattedDate,
        value: i.business_balance || 0,
        color: i.close_px >= i.open_px ? 'rgba(245, 34, 45, 0.5)' : 'rgba(82, 196, 26, 0.5)',
      });

      if (i.ma5_px != null) ma5Data.push({ time: formattedDate, value: i.ma5_px });
      if (i.ma10_px != null) ma10Data.push({ time: formattedDate, value: i.ma10_px });
      if (i.ma20_px != null) ma20Data.push({ time: formattedDate, value: i.ma20_px });
    });

    const dedupSorted = (arr) => {
      if (arr.length === 0) return [];
      const sorted = arr.sort((a, b) => String(a.time).localeCompare(String(b.time)));
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

    const klineFinal = dedupSorted(klineData);
    candlestick.setData(klineFinal);
    volumeSeries.setData(dedupSorted(volumeData));
    ma5Series.setData(dedupSorted(ma5Data));
    ma10Series.setData(dedupSorted(ma10Data));
    ma20Series.setData(dedupSorted(ma20Data));

    if (markers.length > 0) {
      const sortedMarkers = [...markers].sort((a, b) => {
        const t = String(a.time).localeCompare(String(b.time));
        if (t !== 0) return t;
        const aPriority = a.position === 'belowBar' ? 0 : 1;
        const bPriority = b.position === 'belowBar' ? 0 : 1;
        return aPriority - bPriority;
      });
      candlestick.setMarkers(sortedMarkers);
    }

    chart.timeScale().fitContent();

    const tooltip = tooltipRef.current;
    chart.subscribeCrosshairMove(param => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > height
      ) {
        tooltip.style.display = 'none';
      } else {
        const kData = param.seriesData.get(candlestick);
        const vData = param.seriesData.get(volumeSeries);

        if (kData) {
          tooltip.style.display = 'block';
          const dateStr = typeof param.time === 'string' ? param.time : '';
          const volDisplay = vData ? (vData.value / 100000000).toFixed(2) + '亿' : '0.00亿';
          const changeVal = changeMap[dateStr];
          const resilienceVal = resilienceMap[dateStr];

          const dateMarker = markers.find(m => m.time === dateStr);

          tooltip.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #eee; padding-bottom: 4px;">${dateStr}${dateMarker ? `<span style="margin-left:6px;color:${dateMarker.color};font-weight:600;">${dateMarker.text}</span>` : ''}</div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span>开盘:</span><span style="font-weight:bold;">${kData.open.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span>最高:</span><span style="font-weight:bold;">${kData.high.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span>最低:</span><span style="font-weight:bold;">${kData.low.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span>收盘:</span><span style="font-weight:bold;color:${kData.close >= kData.open ? '#f5222d' : '#52c41a'}">${kData.close.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span>成交额:</span><span style="font-weight:bold;">${volDisplay}</span></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span>涨跌:</span><span style="font-weight:bold;color:${changeVal >= 0 ? '#f5222d' : '#52c41a'}">${changeVal !== undefined ? (changeVal >= 0 ? '+' : '') + changeVal.toFixed(2) + '%' : '-'}</span></div>
            <div style="display:flex;justify-content:space-between;"><span>抗分歧:</span><span style="font-weight:bold;color:${resilienceVal !== null && resilienceVal > 8 ? '#f5222d' : resilienceVal !== null && resilienceVal < 5 ? '#52c41a' : '#8c8c8c'}">${resilienceVal !== null ? resilienceVal.toFixed(2) : '-'}</span></div>
          `;

          const coordinate = candlestick.priceToCoordinate(kData.close);
          const tooltipWidth = 180;
          const tooltipHeight = 180;
          const margin = 10;
          let left = param.point.x + margin;
          if (left + tooltipWidth > containerRef.current.clientWidth - margin) {
            left = param.point.x - tooltipWidth - margin;
          }
          let top = coordinate !== undefined ? coordinate - tooltipHeight / 2 : param.point.y + margin;
          if (top < margin) top = margin;
          if (top + tooltipHeight > height - margin) top = height - tooltipHeight - margin;
          tooltip.style.left = left + 'px';
          tooltip.style.top = top + 'px';
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [data, markers, height]);

  return (
    <div className="backtest-kline-container" style={{ position: 'relative', width: '100%' }}>
      <div ref={containerRef} style={{ height, width: '100%' }} />
      <div
        ref={tooltipRef}
        style={{
          width: '180px',
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
