import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import './index.scss';

/**
 * 股票分时图组件 (折线图形式)
 * @param {Array} data 分时数据 [{ date: 20260601, minute: 941, last_px: 437.1, change: -3.98, business_amount: 493800 }]
 * @param {Number} height 图表高度
 */
export default function StockTimeLine({ data = [], height = 450 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);

  // 格式化时间的辅助函数
  const formatTimestamp = (date, minute) => {
    const dateStr = String(date);
    const minStr = String(minute).padStart(4, '0');
    const hh = minStr.substring(0, 2);
    const mm = minStr.substring(2, 4);
    
    // 明确使用 YYYY-MM-DD HH:mm 格式，并确保 dayjs 解析为本地时间
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    const dateObj = dayjs(`${year}-${month}-${day} ${hh}:${mm}`);
    
    return dateObj.unix();
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // 1. 初始化图表
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: containerRef.current.clientWidth || 800,
      height: height,
      grid: {
        vertLines: { color: '#f0f0f0', style: LineStyle.Dotted },
        horzLines: { color: '#f0f0f0', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        // 强制 X 轴显示时间格式，增加对各种时间类型的兼容处理
        tickMarkFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('HH:mm');
          }
          return time;
        },
      },
      localization: {
        timeFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('HH:mm');
          }
          return time;
        },
      },
      leftPriceScale: {
        visible: false, // 隐藏左侧坐标轴
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.3, // 价格线占上部 70%
        },
      },
      handleScroll: true,
      handleScale: true,
      crosshair: {
        mode: 0,
        vertLine: { labelBackgroundColor: '#1890ff' },
        horzLine: { labelBackgroundColor: '#1890ff' },
      },
    });

    chartRef.current = chart;

    // 2. 添加价格面积图
    const areaSeries = chart.addAreaSeries({
      lineColor: '#1890ff',
      topColor: 'rgba(24, 144, 255, 0.2)',
      bottomColor: 'rgba(24, 144, 255, 0.01)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    // 2.1 添加成交量柱状图
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: 'volume-scale', // 使用独立的坐标轴
    });

    chart.priceScale('volume-scale').applyOptions({
      scaleMargins: {
        top: 0.8, // 成交量占底部 20%
        bottom: 0,
      },
    });

    // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
    const dummySeries = chart.addLineSeries({
      color: 'transparent',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // 3. 数据填充
    if (data.length > 0) {
      const firstItem = data[0];
      const dateStr = String(firstItem.date);
      const YYYY = dateStr.substring(0, 4);
      const MM = dateStr.substring(4, 6);
      const DD = dateStr.substring(6, 8);

      // 生成全天的时间点 (09:30-11:30, 13:00-15:00)
      const allTimePoints = [];
      
      // 上午 09:30 - 11:30
      let curr = dayjs(`${YYYY}-${MM}-${DD} 09:30`);
      const amEnd = dayjs(`${YYYY}-${MM}-${DD} 11:30`);
      while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
        allTimePoints.push(curr.unix());
        curr = curr.add(1, 'minute');
      }
      
      // 下午 13:00 - 15:00
      curr = dayjs(`${YYYY}-${MM}-${DD} 13:00`);
      const pmEnd = dayjs(`${YYYY}-${MM}-${DD} 15:00`);
      while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
        allTimePoints.push(curr.unix());
        curr = curr.add(1, 'minute');
      }

      // 填充隐藏系列，确保 X 轴拥有全天所有的“坑位”
      const basePrice = data[0].last_px;
      dummySeries.setData(allTimePoints.map(t => ({ time: t, value: basePrice })));

      // 填充实际数据
      const formattedData = [];
      const volumeData = [];

      data.forEach((item, index) => {
        const timestamp = formatTimestamp(item.date, item.minute);
        const price = item.last_px;
        
        formattedData.push({
          time: timestamp,
          value: price,
        });

        // 成交量颜色逻辑：上涨红 (#f5222d)，下跌绿 (#52c41a)
        // 与前一个点位比较
        let color = '#f5222d';
        if (index > 0) {
          color = price >= data[index - 1].last_px ? '#f5222d' : '#52c41a';
        } else {
          // 第一个点位如果 change > 0 也是红色
          color = item.change >= 0 ? '#f5222d' : '#52c41a';
        }

        volumeData.push({
          time: timestamp,
          value: item.business_amount,
          color: color,
        });
      });

      formattedData.sort((a, b) => a.time - b.time);
      volumeData.sort((a, b) => a.time - b.time);

      areaSeries.setData(formattedData);
      volumeSeries.setData(volumeData);

      // 锁定 X 轴视图：展示全天
      chart.timeScale().fitContent();

      // 禁用缩放和滚动
      chart.timeScale().applyOptions({
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        rightOffset: 0,
      });
    }

    // 4. Tooltip 交互
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
        tooltip.style.display = 'block';
        const priceData = param.seriesData.get(areaSeries);
        const price = priceData ? priceData.value : 0;
        
        const volData = param.seriesData.get(volumeSeries);
        const volume = volData ? volData.value : 0;
        
        // 从原始数据找对应的 change
        const originalItem = data.find(item => formatTimestamp(item.date, item.minute) === param.time);
        const change = originalItem ? originalItem.change : '--';
        
        const color = originalItem && parseFloat(change) >= 0 ? '#f5222d' : '#52c41a';
        const timeStr = dayjs.unix(param.time).format('HH:mm');

        tooltip.innerHTML = `
          <div class="timeline-tooltip-header">
            <span class="time">${timeStr}</span>
            <span class="status" style="background: ${color}"></span>
          </div>
          <div class="timeline-tooltip-body">
            <div class="item">
              <span class="label">价格</span>
              <span class="value" style="color: ${color}">${price.toFixed(2)}</span>
            </div>
            <div class="item">
              <span class="label">涨跌</span>
              <span class="value" style="color: ${color}">${change}%</span>
            </div>
            <div class="item">
              <span class="label">成交量</span>
              <span class="value">${(volume / 10000).toFixed(2)}万</span>
            </div>
          </div>
        `;
        
        const tooltipWidth = 140;
        const x = param.point.x;
        if (x > containerRef.current.clientWidth - tooltipWidth - 20) {
          tooltip.style.left = 'auto';
          tooltip.style.right = '20px';
        } else {
          tooltip.style.right = 'auto';
          tooltip.style.left = `${x + 20}px`;
        }
      }
    });

    const handleResize = () => {
      chart.applyOptions({ width: containerRef.current.clientWidth });
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [data, height]);

  return (
    <div className="stock-timeline-container" style={{ height }}>
      <div ref={containerRef} className="chart-container" />
      <div ref={tooltipRef} className="timeline-tooltip" />
    </div>
  );
}


