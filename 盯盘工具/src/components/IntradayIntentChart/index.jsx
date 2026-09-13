import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import { getThemeColor } from '../../utils/theme';
import './index.scss';

/**
 * 分时资金意图图组件
 * 在分时图下方用颜色条标注每个时间段的资金意图状态
 * 
 * @param {Array} timelineData 分时数据 [{ date, minute, last_px, change, business_amount }]
 * @param {Array} intervalAnalysis 区间分析数据 [{ intervalLabel, capitalIntent, intentType, priceChange, startMinute, endMinute }]
 * @param {Number} height 图表高度（不含底部标注条）
 * @param {String} stockName 股票名称（可选，用于标题显示）
 */
export default function IntradayIntentChart({ 
  timelineData = [], 
  indexTimelineData = [], 
  intervalAnalysis = [], 
  height = 350,
  stockName = ''
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);
  const overlayRef = useRef(null);
  const [plotAreaWidth, setPlotAreaWidth] = useState(0);

  // 资金意图类型对应的指示器颜色
  const getIntentColor = (intentType) => {
    switch (intentType) {
      case 'strong_bullish': return '#f5222d';
      case 'bullish': return '#cf1322';
      case 'mild_bullish': return '#ff7875';
      case 'strong_warning': return '#52c41a';
      case 'warning': return '#389e0d';
      case 'mild_warning': return '#95de64';
      case 'mixed': return '#d48806';
      case 'neutral': return '#6b7a96';
      default: return '#6b7a96';
    }
  };

  // 资金意图类型对应的细分背景色（极淡，仅做区分用）
  const getIntentBgColor = (intentType) => {
    switch (intentType) {
      case 'strong_bullish':
      case 'bullish':
      case 'mild_bullish':
        return 'rgba(245, 34, 45, 0.022)';
      case 'strong_warning':
      case 'warning':
      case 'mild_warning':
        return 'rgba(82, 196, 26, 0.022)';
      case 'mixed':
        return 'rgba(212, 136, 6, 0.022)';
      case 'neutral':
      default:
        return 'rgba(107, 122, 150, 0.022)';
    }
  };

  // 资金意图类型对应的遮罩色（透明度极低，避免遮挡分时折线轨迹）
  const getIntentOverlayColor = (intentType) => {
    switch (intentType) {
      case 'strong_bullish': return 'rgba(245, 34, 45, 0.02)';
      case 'bullish': return 'rgba(207, 19, 34, 0.015)';
      case 'mild_bullish': return 'rgba(207, 19, 34, 0.01)';
      case 'strong_warning': return 'rgba(82, 196, 26, 0.02)';
      case 'warning': return 'rgba(56, 158, 13, 0.015)';
      case 'mild_warning': return 'rgba(56, 158, 13, 0.01)';
      case 'mixed': return 'rgba(212, 136, 6, 0.015)';
      case 'neutral': return 'rgba(140, 140, 140, 0.01)';
      default: return 'rgba(140, 140, 140, 0.01)';
    }
  };

  // 将分钟数（如930, 1000, 1300, 1430）转换为相对于开盘时间9:30的分钟数
  // 上午：9:30-11:30 = 120分钟
  // 下午：13:00-15:00 = 120分钟
  // 总计：240分钟
  const minuteToRelative = (minute) => {
    const h = Math.floor(minute / 100);
    const m = minute % 100;
    
    if (h >= 9 && h < 11) {
      if (h === 9) {
        return Math.max(0, m - 30);
      }
      return (h - 9) * 60 + m - 30;
    } else if (h >= 11 && h < 13) {
      if (h === 11) {
        return Math.min(120, (h - 9) * 60 + m - 30);
      }
      return 120;
    } else if (h >= 13 && h < 15) {
      return 120 + (h - 13) * 60 + m;
    } else if (h >= 15) {
      return 240;
    }
    return 0;
  };

  // 获取交易时段的总分钟数
  const getTotalTradingMinutes = () => 240;

  // 格式化时间
  const formatTimestamp = (date, minute) => {
    const dateStr = String(date);
    const minStr = String(minute).padStart(4, '0');
    const hh = minStr.substring(0, 2);
    const mm = minStr.substring(2, 4);
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    const dateObj = dayjs(`${year}-${month}-${day} ${hh}:${mm}`);
    return dateObj.unix();
  };

  // 根据分钟数查找最近的实际数据点时间戳（解决 timeToCoordinate 对非数据点返回 null 的问题）
  const getTimestampForMinute = (minute) => {
    if (!timelineData.length) return null;
    // 精确匹配
    const exact = timelineData.find(item => item.minute === minute);
    if (exact) return formatTimestamp(exact.date, exact.minute);
    // 向后找第一个 >= minute 的数据点
    const after = timelineData.find(item => item.minute >= minute);
    if (after) return formatTimestamp(after.date, after.minute);
    // 向前找最后一个 <= minute 的数据点
    const before = [...timelineData].reverse().find(item => item.minute <= minute);
    if (before) return formatTimestamp(before.date, before.minute);
    return null;
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 11,
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
      leftPriceScale: { visible: false },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.3 },
        priceFormat: {
          type: 'custom',
          minMove: 0.01,
          formatter: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
        },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 0,
        vertLine: { labelBackgroundColor: getThemeColor() },
        horzLine: { labelBackgroundColor: getThemeColor() },
      },
    });

    chartRef.current = chart;

    const stockLineSeries = chart.addLineSeries({
      color: getThemeColor(),
      lineWidth: 2,
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
      },
    });

    const indexLineSeries = chart.addLineSeries({
      color: '#919191',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceFormat: {
        type: 'custom',
        minMove: 0.01,
        formatter: (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`,
      },
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume-scale',
    });

    chart.priceScale('volume-scale').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    const dummySeries = chart.addLineSeries({
      color: 'transparent',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    if (timelineData.length > 0) {
      const firstItem = timelineData[0];
      const dateStr = String(firstItem.date);
      const YYYY = dateStr.substring(0, 4);
      const MM = dateStr.substring(4, 6);
      const DD = dateStr.substring(6, 8);

      const stockFormattedData = [];
      const volumeData = [];

      timelineData.forEach((item, index) => {
        const timestamp = formatTimestamp(item.date, item.minute);
        const change = parseFloat(item.change) || 0;
        
        stockFormattedData.push({ time: timestamp, value: change });

        let color = '#f5222d';
        if (index > 0) {
          const prevChange = parseFloat(timelineData[index - 1].change) || 0;
          color = change >= prevChange ? '#f5222d' : '#52c41a';
        } else {
          color = change >= 0 ? '#f5222d' : '#52c41a';
        }

        volumeData.push({
          time: timestamp,
          value: item.business_amount,
          color: color,
        });
      });

      stockFormattedData.sort((a, b) => a.time - b.time);
      volumeData.sort((a, b) => a.time - b.time);

      const deduplicate = (arr) => {
        const result = [];
        for (let i = 0; i < arr.length; i++) {
          if (i === 0 || arr[i].time !== arr[i - 1].time) {
            result.push(arr[i]);
          } else {
            result[result.length - 1] = arr[i];
          }
        }
        return result;
      };

      stockLineSeries.setData(deduplicate(stockFormattedData));
      volumeSeries.setData(deduplicate(volumeData));

      if (indexTimelineData && indexTimelineData.length > 0) {
        const indexFormattedData = indexTimelineData.map(item => ({
          time: formatTimestamp(item.date, item.minute),
          value: parseFloat(item.change) || 0,
        })).sort((a, b) => a.time - b.time);
        indexLineSeries.setData(deduplicate(indexFormattedData));
      }

      const allTimePoints = [];
      let curr = dayjs(`${YYYY}-${MM}-${DD} 09:30`);
      const amEnd = dayjs(`${YYYY}-${MM}-${DD} 11:30`);
      while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
        allTimePoints.push(curr.unix());
        curr = curr.add(1, 'minute');
      }
      curr = dayjs(`${YYYY}-${MM}-${DD} 13:00`);
      const pmEnd = dayjs(`${YYYY}-${MM}-${DD} 15:00`);
      while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
        allTimePoints.push(curr.unix());
        curr = curr.add(1, 'minute');
      }

      const baseValue = stockFormattedData.length > 0 ? stockFormattedData[0].value : 0;
      dummySeries.setData(allTimePoints.map(t => ({ time: t, value: baseValue })));

      const startTime = dayjs(`${YYYY}-${MM}-${DD} 09:30`).unix();
      const endTime = dayjs(`${YYYY}-${MM}-${DD} 15:00`).unix();
      
      chart.timeScale().setVisibleRange({
        from: startTime,
        to: endTime,
      });
      chart.timeScale().applyOptions({
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        rightOffset: 0,
      });
    }

    // 精确测量图表绘图区宽度，确保底部 bar 对齐
    const measurePlotWidth = () => {
      try {
        const w = chart.timeScale().width();
        if (w > 0) setPlotAreaWidth(w);
      } catch (e) {
        // ignore
      }
    };
    requestAnimationFrame(measurePlotWidth);

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
        const stockData = param.seriesData.get(stockLineSeries);
        const stockChange = stockData ? stockData.value : 0;
        
        const indexData = param.seriesData.get(indexLineSeries);
        const indexChange = indexData ? indexData.value : '--';
        
        const volData = param.seriesData.get(volumeSeries);
        const volume = volData ? volData.value : 0;
        
        const originalItem = timelineData.find(item => formatTimestamp(item.date, item.minute) === param.time);
        const price = originalItem ? originalItem.last_px : 0;
        
        const color = parseFloat(stockChange) >= 0 ? '#f5222d' : '#52c41a';
        const timeStr = dayjs.unix(param.time).format('HH:mm');

        const currentMinute = parseInt(timeStr.replace(':', ''));
        const currentInterval = intervalAnalysis.find(item => {
          return currentMinute >= item.startMinute && currentMinute < item.endMinute;
        });

        let intentHtml = '';
        if (currentInterval) {
          const intentColor = getIntentColor(currentInterval.intentType);
          intentHtml = `
            <div class="intent-info" style="border-left: 3px solid ${intentColor}; padding-left: 6px; margin-top: 4px;">
              <div style="font-weight: bold; color: ${intentColor}; font-size: 11px;">${currentInterval.capitalIntent}</div>
            </div>
          `;
        }

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
              <span class="label">个股涨跌</span>
              <span class="value" style="color: ${color}">${stockChange >= 0 ? '+' : ''}${stockChange.toFixed(2)}%</span>
            </div>
            <div class="item">
              <span class="label">指数涨跌</span>
              <span class="value" style="color: #919191">${typeof indexChange === 'number' ? (indexChange >= 0 ? '+' : '') + indexChange.toFixed(2) + '%' : '--'}</span>
            </div>
            <div class="item">
              <span class="label">成交量</span>
              <span class="value">${(volume / 10000).toFixed(2)}万</span>
            </div>
            ${intentHtml}
          </div>
        `;
        
        const tooltipWidth = 180;
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
      requestAnimationFrame(() => {
        try {
          const w = chart.timeScale().width();
          if (w > 0) setPlotAreaWidth(w);
        } catch (e) {
          // ignore
        }
      });
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [timelineData, indexTimelineData, intervalAnalysis, height]);

  // 底部区间 hover → 图表遮罩
  const handleSegmentMouseEnter = (item) => {
    const chart = chartRef.current;
    const overlay = overlayRef.current;
    if (!chart || !overlay) return;

    const startTs = getTimestampForMinute(item.startMinute);
    const endTs = getTimestampForMinute(item.endMinute);
    const startX = startTs != null ? chart.timeScale().timeToCoordinate(startTs) : null;
    let endX = endTs != null ? chart.timeScale().timeToCoordinate(endTs) : null;

    if (endX == null) {
      try {
        endX = chart.timeScale().width();
      } catch (e) {
        endX = containerRef.current.clientWidth;
      }
    }

    if (startX != null) {
      const color = getIntentColor(item.intentType);
      const bgColor = getIntentOverlayColor(item.intentType);

      overlay.style.display = 'block';
      overlay.style.left = `${startX}px`;
      overlay.style.width = `${Math.max(0, endX - startX)}px`;
      overlay.style.backgroundColor = bgColor;
      overlay.style.borderLeft = `1px solid ${color}`;
      overlay.style.borderRight = `1px solid ${color}`;
    }
  };

  const handleSegmentMouseLeave = () => {
    if (overlayRef.current) {
      overlayRef.current.style.display = 'none';
    }
  };

  const formatMinute = (minute) => {
    const h = Math.floor(minute / 100);
    const m = minute % 100;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const renderIntervalBar = () => {
    if (!intervalAnalysis || intervalAnalysis.length === 0) return null;

    const totalMinutes = getTotalTradingMinutes();

    return (
      <div className="interval-bar-container">
        <div className="interval-bar-label">资金意图</div>
        <div className="interval-bar-wrapper">
          <div className="interval-bar" style={{ width: plotAreaWidth || '100%' }}>
            {intervalAnalysis.map((item, index) => {
              const color = getIntentColor(item.intentType);
              const bgColor = getIntentBgColor(item.intentType);
              const startRelative = minuteToRelative(item.startMinute);
              const endRelative = minuteToRelative(item.endMinute);
              const widthPercent = ((endRelative - startRelative) / totalMinutes) * 100;
              
              return (
                <div
                  key={index}
                  className="interval-segment"
                  style={{
                    '--indicator-color': color,
                    '--segment-bg': bgColor,
                    width: `${widthPercent}%`,
                    flex: 'none',
                  }}
                  onMouseEnter={() => handleSegmentMouseEnter(item)}
                  onMouseLeave={handleSegmentMouseLeave}
                >
                  <div className="interval-indicator" />
                  <div className="interval-text">
                    {item.capitalIntent}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="interval-time-row" style={{ width: plotAreaWidth || '100%' }}>
            {intervalAnalysis.map((item, index) => {
              const startRelative = minuteToRelative(item.startMinute);
              const endRelative = minuteToRelative(item.endMinute);
              const widthPercent = ((endRelative - startRelative) / totalMinutes) * 100;
              
              return (
                <div key={index} className="interval-time-cell" style={{ width: `${widthPercent}%`, flex: 'none' }}>
                  <span className="interval-time-text">{formatMinute(item.startMinute)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="intraday-intent-chart-container">
      {stockName && (
        <div className="chart-header">
          <span className="stock-name">{stockName}</span>
          <span className="chart-title">分时资金意图分析</span>
        </div>
      )}
      <div className="chart-wrapper" style={{ height }}>
        <div ref={containerRef} className="chart-container" />
        <div ref={tooltipRef} className="timeline-tooltip" />
        <div ref={overlayRef} className="chart-overlay" />
      </div>
      {renderIntervalBar()}
    </div>
  );
}
