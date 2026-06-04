import { useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

export default function KLine({ data = [], height = 500 }) {
  const container = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!container.current) return;

    // 创建图表
    const chart = createChart(container.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
      },
      width: container.current.clientWidth || 800,
      height: height,
      // 这里的 localization 用于自定义 tooltip 中的时间格式
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time) => {
          return time; // time 已经是 YYYY-MM-DD 格式
        },
      },
      // timeScale 用于自定义横轴的时间格式
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time) => {
          // time 是 { day: 29, month: 5, year: 2026 } 或者 字符串 "2026-05-29"
          // 这里可以根据需要自定义横轴展示的文案
          if (typeof time === 'string') {
            const parts = time.split('-');
            return `${parts[1]}/${parts[2]}`; // 例如展示 05/29
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
    });

    const candlestick = chart.addCandlestickSeries({
      upColor: '#f5222d',
      downColor: '#52c41a',
      borderVisible: false,
      wickUpColor: '#f5222d',
      wickDownColor: '#52c41a',
    });

    // 添加 MA5 均线
    const ma5Series = chart.addLineSeries({
      color: '#ff9800',
      lineWidth: 1,
      lastValueVisible: false, // 隐藏坐标轴上的最新价格标签
      priceLineVisible: false, // 隐藏横向的价格基准线
    });

    // 添加 MA10 均线
    const ma10Series = chart.addLineSeries({
      color: '#2196f3',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // 添加 MA20 均线
    const ma20Series = chart.addLineSeries({
      color: '#9c27b0',
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // 添加成交额系列
    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', // 置为空字符串，使其在底部独立展示
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8, // 放在底部 20% 的位置
        bottom: 0,
      },
    });

    // 处理数据格式
    const klineData = [];
    const volumeData = [];
    const ma5Data = [];
    const ma10Data = [];
    const ma20Data = [];

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

      volumeData.push({
        time: formattedDate,
        value: i.business_balance || 0,
        color: i.close_px >= i.open_px ? 'rgba(245, 34, 45, 0.5)' : 'rgba(82, 196, 26, 0.5)',
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

    // 确保时间有序
    klineData.sort((a, b) => a.time.localeCompare(b.time));
    volumeData.sort((a, b) => a.time.localeCompare(b.time));
    ma5Data.sort((a, b) => a.time.localeCompare(b.time));
    ma10Data.sort((a, b) => a.time.localeCompare(b.time));
    ma20Data.sort((a, b) => a.time.localeCompare(b.time));

    candlestick.setData(klineData);
    volumeSeries.setData(volumeData);
    ma5Series.setData(ma5Data);
    ma10Series.setData(ma10Data);
    ma20Series.setData(ma20Data);
    
    chart.timeScale().fitContent();

    // 添加 Tooltip 逻辑
    const tooltip = document.getElementById('kline-tooltip');
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

          tooltip.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #eee; padding-bottom: 4px;">${dateStr}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>开盘:</span><span style="font-weight: bold;">${kData.open.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最高:</span><span style="font-weight: bold;">${kData.high.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最低:</span><span style="font-weight: bold;">${kData.low.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>收盘:</span><span style="font-weight: bold; color: ${kData.close >= kData.open ? '#f5222d' : '#52c41a'}">${kData.close.toFixed(2)}</span></div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>涨跌:</span><span style="font-weight: bold; color: ${kData.close >= kData.open ? '#f5222d' : '#52c41a'}">${(((kData.close - kData.open) / kData.open) * 100).toFixed(2)}%</span></div>
          `;

          const coordinate = candlestick.priceToCoordinate(kData.close);
          let left = param.point.x + 15;
          if (left > container.current.clientWidth - 170) {
            left = param.point.x - 175;
          }

          let top = param.point.y + 15;
          if (top > height - 200) { // 稍微增加 Tooltip 高度判断
            top = param.point.y - 205;
          }

          tooltip.style.left = left + 'px';
          tooltip.style.top = top + 'px';
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    chartRef.current = chart;

    // 响应式调整大小
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
  }, [data, height]);

  return (
    <div className="stock-kline-container" style={{ position: 'relative', width: '100%' }}>
      <div ref={container} style={{ height, width: '100%' }} />
      <div 
        id="kline-tooltip" 
        style={{
          width: '160px',
          height: '140px',
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