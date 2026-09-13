import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import { getThemeColor, getThemeColorRgba } from '../../utils/theme';
import './IntradayResilienceChart.scss';

/**
 * 分时抗分歧诊断图组件
 * 上方展示个股分时图和跟踪指数分时图，下方用颜色条标注每个10分钟分段的抗分歧得分
 * 样式和交互与 IntradayIntentChart 保持一致
 *
 * @param {Array} timelineData 个股分时数据 [{ date, minute, last_px, change, business_amount }]
 * @param {Array} indexTimelineData 指数分时数据
 * @param {Array} segmentResults 分段抗分歧结果 [{ startMinute, endMinute, resilienceScore, status, stockChange, indexChange }]
 * @param {Number} height 图表高度（不含底部标注条）
 * @param {String} stockName 股票名称
 * @param {String} indexName 指数名称
 */
export default function IntradayResilienceChart({
  timelineData = [],
  indexTimelineData = [],
  segmentResults = [],
  height = 350,
  stockName = '',
  indexName = '',
  overallResilience,
  overallStatus,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);
  const overlayRef = useRef(null);
  const [plotAreaWidth, setPlotAreaWidth] = useState(0);

  // 根据抗分歧得分获取指示器颜色
  const getScoreColor = (score) => {
    if (score >= 15) return '#cf1322';
    if (score >= 10) return '#fa8c16';
    if (score >= 5) return getThemeColor();
    if (score > 0) return '#389e0d';
    return '#bfbfbf';
  };

  // 根据抗分歧得分获取细分背景色
  const getScoreBgColor = (score) => {
    if (score >= 15) return 'rgba(207, 19, 34, 0.05)';
    if (score >= 10) return 'rgba(250, 140, 22, 0.05)';
    if (score >= 5) return getThemeColorRgba(0.05);
    if (score > 0) return 'rgba(56, 158, 13, 0.05)';
    return 'rgba(191, 191, 191, 0.04)';
  };

  // 根据抗分歧得分获取遮罩色（透明度极低，避免遮挡分时折线轨迹）
  const getScoreOverlayColor = (score) => {
    if (score >= 15) return 'rgba(207, 19, 34, 0.03)';
    if (score >= 10) return 'rgba(250, 140, 22, 0.025)';
    if (score >= 5) return getThemeColorRgba(0.02);
    if (score > 0) return 'rgba(56, 158, 13, 0.02)';
    return 'rgba(140, 140, 140, 0.015)';
  };

  // 将分钟数（如930, 1000, 1300, 1430）转换为相对于开盘时间9:30的分钟数
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

  const getTotalTradingMinutes = () => 240;

  // 格式化时间戳
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

  // 根据分钟数查找最近的实际数据点时间戳
  const getTimestampForMinute = (minute) => {
    if (!timelineData.length) return null;
    const exact = timelineData.find(item => item.minute === minute);
    if (exact) return formatTimestamp(exact.date, exact.minute);
    const after = timelineData.find(item => item.minute >= minute);
    if (after) return formatTimestamp(after.date, after.minute);
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
        const currentSegment = segmentResults.find(item =>
          currentMinute >= item.startMinute && currentMinute < item.endMinute
        );

        let resilienceHtml = '';
        if (currentSegment) {
          const segColor = getScoreColor(currentSegment.resilienceScore);
          resilienceHtml = `
            <div class="intent-info" style="border-left: 3px solid ${segColor}; padding-left: 6px; margin-top: 4px;">
              <div style="font-weight: bold; color: ${segColor}; font-size: 11px;">抗分歧：${currentSegment.resilienceScore.toFixed(2)} · ${currentSegment.status}</div>
              <div style="font-size: 10px; color: #666; margin-top: 2px;">分段涨幅 个股${currentSegment.stockChange >= 0 ? '+' : ''}${currentSegment.stockChange}% / 指数${currentSegment.indexChange >= 0 ? '+' : ''}${currentSegment.indexChange}%</div>
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
            ${resilienceHtml}
          </div>
        `;

        const tooltipWidth = 200;
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
  }, [timelineData, indexTimelineData, segmentResults, height]);

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
      const color = getScoreColor(item.resilienceScore);
      const bgColor = getScoreOverlayColor(item.resilienceScore);

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

  const renderSegmentBar = () => {
    if (!segmentResults || segmentResults.length === 0) return null;

    const totalMinutes = getTotalTradingMinutes();

    return (
      <div className="interval-bar-container">
        <div className="interval-bar-label">抗分歧分段</div>
        <div className="interval-bar-wrapper">
          <div className="interval-bar" style={{ width: plotAreaWidth || '100%' }}>
            {segmentResults.map((item, index) => {
              const color = getScoreColor(item.resilienceScore);
              const bgColor = getScoreBgColor(item.resilienceScore);
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
                    {item.error ? '--' : item.resilienceScore.toFixed(1)}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="interval-time-row" style={{ width: plotAreaWidth || '100%' }}>
            {segmentResults.map((item, index) => {
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
    <div className="intraday-resilience-chart-container">
      {stockName && (
        <div className="chart-header">
          <span className="stock-name">{stockName}</span>
          {overallResilience !== undefined && (
            <span className="overall-resilience" style={{ color: getScoreColor(overallResilience) }}>
              抗分歧指数：{overallResilience} · {overallStatus}
            </span>
          )}
          <span className="chart-title">分时抗分歧诊断</span>
          {indexName && <span className="chart-index-name">跟踪：{indexName}</span>}
        </div>
      )}
      <div className="chart-wrapper" style={{ height }}>
        <div ref={containerRef} className="chart-container" />
        <div ref={tooltipRef} className="timeline-tooltip" />
        <div ref={overlayRef} className="chart-overlay" />
      </div>
      {renderSegmentBar()}
    </div>
  );
}
