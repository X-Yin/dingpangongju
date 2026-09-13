import { useEffect, useState, useRef, useMemo } from 'react';
import { Card, Typography, Spin, Alert, Row, Col, Divider, Button, message, Tag, Tabs, DatePicker, Table, Collapse, Radio, Modal } from 'antd';
import { CoffeeOutlined, LineChartOutlined, AreaChartOutlined, ReloadOutlined, AppstoreOutlined, CloseOutlined, BarChartOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip, statusCodeColorMap, statusCodeLabelMap } from '../../constant';
import StockKLine from '../../components/StockKLine';
import { getThemeColor } from '../../utils/theme';
import StockKLineModal from '../../components/StockKLineModal';
import CustomKLineChart, { calcAvgSlope } from '../../components/CustomKLineChart';
import './index.scss';

const { Title, Text } = Typography;

const isAfterMarketClose = () => {
  const now = dayjs();
  const currentHour = now.hour();
  const currentMinute = now.minute();
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

const formatDateStr = (dateStr) => {
  const str = String(dateStr);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
};



const toneClassMap = {
  up: 'tone-up',
  down: 'tone-down',
  neutral: 'tone-neutral',
};

const toneTagColorMap = {
  up: 'red',
  down: 'green',
  neutral: 'gold',
};

const moneyTrendTextMap = {
  increasing: '资金加速流入',
  decreasing: '资金持续流出',
  stable: '资金流平稳',
};

const changeTrendTextMap = {
  improving: '板块表现改善',
  deteriorating: '板块表现走弱',
  stable: '板块表现平稳',
};

const formatSignedNumber = (value, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}`;
};

const formatChartDate = (dateValue) => {
  const dateStr = String(dateValue);
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
};

/**
 * 板块分类分析查看器：左侧日期目录（含主线描述）+ 右侧详情
 */
const ClassifyViewer = ({ dailyResults, initialDate, onBlockClick }) => {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const sidebarRef = useRef(null);

  // 数据加载完成后，定位到最新日期并滚动到对应位置
  useEffect(() => {
    if (initialDate) {
      setSelectedDate(initialDate);
      // 滚动到最新日期（最后一项）
      requestAnimationFrame(() => {
        const sidebar = sidebarRef.current;
        if (sidebar) {
          const activeItem = sidebar.querySelector('.sidebar-item.active');
          if (activeItem) {
            // activeItem.scrollIntoView({ behavior: 'auto', block: 'nearest' });
          }
        }
      });
    }
  }, [initialDate]);

  const day = dailyResults.find(d => d.date === selectedDate) || dailyResults[dailyResults.length - 1];

  return (
    <div className="classify-viewer">
      <div className="classify-sidebar" ref={sidebarRef}>
        {dailyResults.map((d) => {
          const mainLines = d.classification?.['主线'] || [];
          const description = mainLines.length > 0 ? `主线: ${mainLines.join('、')}` : '暂无主线';
          return (
            <div
              key={d.date}
              className={`sidebar-item ${d.date === selectedDate ? 'active' : ''}`}
              onClick={() => setSelectedDate(d.date)}
            >
              <div className="sidebar-date">{formatDateStr(d.date)}</div>
              <div className="sidebar-desc">{description}</div>
            </div>
          );
        })}
      </div>
      <div className="classify-detail">
        <ClassifyDayCard day={day} onBlockClick={onBlockClick} />
      </div>
    </div>
  );
};

/**
 * 单日分类详情卡片
 */
const ClassifyDayCard = ({ day, onBlockClick }) => {
  if (!day) return null;
  const { classification, breadth, marketJudgment } = day;
  const formattedDate = formatDateStr(day.date);

  return (
    <Card
      title={
        <div className="classify-card-title">
          <span>{formattedDate}</span>
          {marketJudgment && (
            <Tag color={marketJudgment.sentimentScore >= 60 ? 'red' : marketJudgment.sentimentScore >= 40 ? 'orange' : 'blue'}>
              {marketJudgment.sentimentEmoji} {marketJudgment.sentimentLabel} ({marketJudgment.sentimentScore}/100)
            </Tag>
          )}
        </div>
      }
      bordered={true}
      className="classify-day-card"
      style={{ border: '1px solid #d9d9d9' }}
    >
      <div className="classify-breadth">
        <Tag color="red">涨 {breadth.upCount}</Tag>
        <Tag color="green">跌 {breadth.downCount}</Tag>
        <Tag>平 {breadth.flatCount}</Tag>
        <Tag color={breadth.marketAvg >= 0 ? 'red' : 'green'}>
          均值 {breadth.marketAvg >= 0 ? '+' : ''}{breadth.marketAvg}%
        </Tag>
        <Tag color={breadth.upRatio >= 0.5 ? 'red' : 'green'}>
          上涨率 {(breadth.upRatio * 100).toFixed(1)}%
        </Tag>
      </div>

      <div className="classify-categories">
        {classification['主线']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label main">主线</span>
            <div className="category-tags">
              {classification['主线'].map(name => (
                <Tag key={name} color="red" className="block-tag-clickable" onClick={() => onBlockClick(name)}>{name}</Tag>
              ))}
            </div>
          </div>
        )}
        {classification['轮动']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label rotating">轮动</span>
            <div className="category-tags">
              {classification['轮动'].map(name => (
                <Tag key={name} color="orange" className="block-tag-clickable" onClick={() => onBlockClick(name)}>{name}</Tag>
              ))}
            </div>
          </div>
        )}
        {classification['退潮']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label ebbing">退潮</span>
            <div className="category-tags">
              {classification['退潮'].map(name => (
                <Tag key={name} color="default" className="block-tag-clickable" onClick={() => onBlockClick(name)}>{name}</Tag>
              ))}
            </div>
          </div>
        )}
      </div>

      {marketJudgment?.summaryLines && (
        <div className="classify-judgment">
          {marketJudgment.summaryLines.map((line, idx) => (
            <div key={idx} className="judgment-line">{line}</div>
          ))}
        </div>
      )}
    </Card>
  );
};

const Sentiment = () => {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [indexKlineData, setIndexKlineData] = useState(null);
  const [techIndexData, setTechIndexData] = useState([]);
  const [classifyData, setClassifyData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [classifyLoading, setClassifyLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [klineBoard, setKlineBoard] = useState('chuangyeban');
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const techContainerRef = useRef(null);
  const techChartRef = useRef(null);
  const techIntradayContainerRef = useRef(null);
  const techIntradayChartRef = useRef(null);
  const [techIntradayData, setTechIntradayData] = useState([]);
  const [techIntraday5DayData, setTechIntraday5DayData] = useState({});
  const [intradayMode, setIntradayMode] = useState('today');
  const [sumDateRange, setSumDateRange] = useState(null);
  const [riskScoreData, setRiskScoreData] = useState([]);
  const riskScoreContainerRef = useRef(null);
  const riskScoreChartRef = useRef(null);
  const [emotionCycleData, setEmotionCycleData] = useState([]);
  const [emotionCycleLoading, setEmotionCycleLoading] = useState(false);
  const [klineModalVisible, setKlineModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [activeTab, setActiveTab] = useState('realTime');
  const [showFullCycleData, setShowFullCycleData] = useState(false);
  const [hoveredEmotionData, setHoveredEmotionData] = useState(null);
  const [hoveredStrengthGap, setHoveredStrengthGap] = useState(0);
  const [isFixed, setIsFixed] = useState(false);

  // 首屏优先加载情绪数据，板块分类分析延后加载
  const fetchData = async () => {
    try {
      const emotionRes = await axios.get(`http://${local_ip}:3000/emotion_data`);
      setData(emotionRes.data.emotionData || []);
      setIndexKlineData(emotionRes.data.indexKlineData || null);
      setTechIndexData(emotionRes.data.techIndexData || []);
    } catch (err) {
      console.error('Fetch emotion data failed:', err);
    } finally {
      setLoading(false);
    }
    // 首屏数据就绪后，再加载板块分类分析（页面底部，非首屏）
    // setClassifyLoading(true);
    // try {
    //   const classifyRes = await axios.get(`http://${local_ip}:3000/classify_sector_blocks_daily`);
    //   setClassifyData(classifyRes.data || null);
    // } catch (err) {
    //   console.error('Fetch classify data failed:', err);
    // } finally {
    //   setClassifyLoading(false);
    // }
  };

  const fetchRiskScore = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/market_risk_score`);
      setRiskScoreData(res.data || []);
    } catch (err) {
      console.error('Fetch risk score data failed:', err);
    }
  };

  const handleUpdateRiskScore = async () => {
    setUpdating(true);
    try {
      await axios.post(`http://${local_ip}:3000/update_market_risk_score`);
      message.success('市场风险偏好指数更新成功');
      fetchRiskScore();
    } catch (err) {
      console.error('Update risk score failed:', err);
      message.error('更新失败，请重试');
    } finally {
      setUpdating(false);
    }
  };

  const handleUpdateEmotion = async () => {
    setUpdating(true);
    try {
      await axios.post(`http://${local_ip}:3000/update_emotion_data`);
      message.success('今日情绪数据更新成功');

      // 更新后检查当日分时是否达到冰点（<= -100），若是则标记 hasIce
      try {
        const intraRes = await axios.get(`http://${local_ip}:3000/tech_emotion_intraday`);
        const today = dayjs().format('YYYYMMDD');
        const todayData = intraRes.data?.data?.[today] || [];
        const hasIce = todayData.some(item =>
          item.value !== null && item.value !== undefined && !isNaN(item.value) && Number(item.value) <= -100
        );
        if (hasIce) {
          await axios.post(`http://${local_ip}:3000/mark_tech_index_ice`);
        }
      } catch (e) {
        console.error('更新后检查冰点失败:', e);
      }

      fetchData();
    } catch (err) {
      console.error('Update emotion data failed:', err);
      message.error('更新数据失败，请重试');
    } finally {
      setUpdating(false);
    }
  };

  const fetchEmotionCycle = async () => {
    setEmotionCycleLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/market_emotion_cycle`);
      const data = res.data || [];
      data.sort((a, b) => b.tradeDate - a.tradeDate);
      setEmotionCycleData(data);
    } catch (err) {
      console.error('Fetch emotion cycle failed:', err);
      setEmotionCycleData([]);
    } finally {
      setEmotionCycleLoading(false);
    }
  };

  const refreshEmotionCycle = async () => {
    setEmotionCycleLoading(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/refresh_market_emotion_cycle`);
      const data = res.data.data || [];
      data.sort((a, b) => b.tradeDate - a.tradeDate);
      setEmotionCycleData(data);
      message.success('情绪周期数据已刷新');
    } catch (err) {
      console.error('Refresh emotion cycle failed:', err);
      message.error('刷新失败，请重试');
    } finally {
      setEmotionCycleLoading(false);
    }
  };

  const showKLine = (stock) => {
    setSelectedStock(stock);
    setKlineModalVisible(true);
  };

  useEffect(() => {
    fetchData();
    fetchRiskScore();
    fetchEmotionCycle();
  }, []);

  useEffect(() => {
    if (!loading) {
      if (data.length > 0 && containerRef.current) {
        renderChart(data);
      }
      if (techIndexData.length > 0 && techContainerRef.current) {
        renderTechChart(techIndexData);
      }
      if (techIndexData.length > 0 && !sumDateRange) {
        const dates = techIndexData.map(item => item.date).sort();
        const minDate = dayjs(formatChartDate(dates[0]));
        const maxDate = dayjs(formatChartDate(dates[dates.length - 1]));
        setSumDateRange([minDate, maxDate]);
      }
      if (riskScoreData.length > 0 && riskScoreContainerRef.current) {
        renderRiskScoreChart(riskScoreData);
      }
    }
  }, [loading, data, techIndexData, sumDateRange, riskScoreData]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
      if (techChartRef.current && techContainerRef.current) {
        techChartRef.current.applyOptions({ width: techContainerRef.current.clientWidth });
      }
      if (techIntradayChartRef.current && techIntradayContainerRef.current) {
        techIntradayChartRef.current.applyOptions({ width: techIntradayContainerRef.current.clientWidth });
      }
      if (riskScoreChartRef.current && riskScoreContainerRef.current) {
        riskScoreChartRef.current.applyOptions({ width: riskScoreContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 拉取当日科技情绪分时数据 + 5日数据
  useEffect(() => {
    const fetchIntraday = async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/tech_emotion_intraday`);
        const today = dayjs().format('YYYYMMDD');
        const todayData = res.data?.data?.[today] || [];
        setTechIntradayData(todayData);

        // 检查当日分时是否达到冰点（<= -100），若是则标记 hasIce
        const hasIce = todayData.some(item =>
          item.value !== null && item.value !== undefined && !isNaN(item.value) && Number(item.value) <= -100
        );
        if (hasIce) {
          try {
            await axios.post(`http://${local_ip}:3000/mark_tech_index_ice`);
          } catch (e) {
            console.error('标记冰点失败:', e);
          }
        }
      } catch (err) {
        console.error('Fetch tech emotion intraday failed:', err);
      }
    };

    const fetch5Day = async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/tech_emotion_intraday_5day`);
        setTechIntraday5DayData(res.data?.data || {});
      } catch (err) {
        console.error('Fetch tech emotion intraday 5day failed:', err);
      }
    };

    fetchIntraday();
    fetch5Day();

    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
      return timer;
    };

    schedulePoll(fetchIntraday, 60 * 1000);
    schedulePoll(fetch5Day, 60 * 1000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  // 渲染科技情绪分时图（当日或5日模式）
  useEffect(() => {
    if (intradayMode === 'today') {
      if (techIntradayData.length > 0 && techIntradayContainerRef.current) {
        renderTechIntradayChart(techIntradayData);
      }
    } else {
      const hasData = Object.keys(techIntraday5DayData).length > 0 &&
        Object.values(techIntraday5DayData).some(arr => arr && arr.length > 0);
      if (hasData && techIntradayContainerRef.current) {
        renderTechIntraday5DayChart(techIntraday5DayData);
      }
    }
  }, [intradayMode, techIntradayData, techIntraday5DayData]);

  const renderTechIntradayChart = (intradayData) => {
    if (techIntradayChartRef.current) {
      techIntradayChartRef.current.remove();
    }

    const chart = createBaseChart(techIntradayContainerRef.current, 300);
    techIntradayChartRef.current = chart;

    const today = dayjs().format('YYYY-MM-DD');

    const chartData = intradayData.map(item => {
      const timeStr = item.time;
      const hh = timeStr.substring(0, 2);
      const mm = timeStr.substring(2, 4);
      const value = parseFloat(item.value) || 0;
      return {
        time: dayjs(`${today} ${hh}:${mm}`).unix(),
        value: value,
        color: value >= 0 ? '#f5222d' : '#52c41a',
      };
    }).sort((a, b) => a.time - b.time);

    const series = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    series.setData(chartData);

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs.unix(time).format('HH:mm');
      },
      secondsVisible: false,
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
    });

    chart.timeScale().fitContent();
  };

  // 渲染最近5日科技情绪分时图：使用 UNIX 时间戳拼接5天数据为连贯折线
  // 不同日期不同时间戳，避免多日数据在 0925-1500 轴上重叠
  const renderTechIntraday5DayChart = (dataMap) => {
    if (techIntradayChartRef.current) {
      techIntradayChartRef.current.remove();
    }

    const chart = createBaseChart(techIntradayContainerRef.current, 300);
    techIntradayChartRef.current = chart;

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    techIntradayContainerRef.current.appendChild(tooltip);

    // 为每天分配一个颜色，便于区分
    const dayColors = ['#722ed1', '#1677ff', '#13c2c2', '#fa8c16', '#eb2f96'];
    const sortedDates = Object.keys(dataMap).sort();
    const dayColorMap = {};
    sortedDates.forEach((date, idx) => {
      dayColorMap[date] = dayColors[idx % dayColors.length];
    });

    const allData = [];
    sortedDates.forEach(date => {
      const records = dataMap[date] || [];
      records.forEach(item => {
        const timeStr = item.time;
        if (!timeStr || timeStr.length < 4) return;
        const hh = timeStr.substring(0, 2);
        const mm = timeStr.substring(2, 4);
        const value = parseFloat(item.value) || 0;
        const dateStr = `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
        allData.push({
          time: dayjs(`${dateStr} ${hh}:${mm}`).unix(),
          value: value,
          color: value >= 0 ? '#f5222d' : '#52c41a',
          date: date,
          rawTime: timeStr,
          dayColor: dayColorMap[date],
        });
      });
    });

    // 排序并去重相同时间戳（轻量图表要求严格升序且无重复）
    allData.sort((a, b) => a.time - b.time);
    const deduped = [];
    let lastTime = null;
    allData.forEach(d => {
      if (d.time !== lastTime) {
        deduped.push(d);
        lastTime = d.time;
      }
    });

    const series = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    series.setData(deduped);

    // 0 轴基准线
    const baselineSeries = chart.addLineSeries({
      color: '#ff4d4f',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    baselineSeries.setData(deduped.map(d => ({ time: d.time, value: 0 })));

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs.unix(time).format('MM-DD HH:mm');
      },
      secondsVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > techIntradayContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 300
      ) {
        tooltip.style.display = 'none';
      } else {
        const dataPoint = deduped.find(d => d.time === param.time);
        if (dataPoint) {
          tooltip.style.display = 'block';
          const dateStr = `${dataPoint.date.substring(0, 4)}-${dataPoint.date.substring(4, 6)}-${dataPoint.date.substring(6, 8)}`;
          const hh = dataPoint.rawTime.substring(0, 2);
          const mm = dataPoint.rawTime.substring(2, 4);
          const value = dataPoint.value;
          tooltip.innerHTML = `
            <div class="tooltip-title">${dateStr} ${hh}:${mm}</div>
            <div class="tooltip-item">
              <span class="label">科技情绪:</span>
              <span class="value ${value >= 0 ? 'up' : 'down'}">${value.toFixed(2)}</span>
            </div>
          `;
          let x = param.point.x + 15;
          const y = param.point.y + 15;
          if (x > techIntradayContainerRef.current.clientWidth - 160) {
            x = param.point.x - 175;
          }
          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        }
      }
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('MM-DD HH:mm');
        },
      },
    });

    chart.timeScale().fitContent();
  };

  const renderRiskScoreChart = (riskScoreData) => {
    if (riskScoreChartRef.current) {
      riskScoreChartRef.current.remove();
    }

    const chart = createBaseChart(riskScoreContainerRef.current, 220);
    riskScoreChartRef.current = chart;

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    riskScoreContainerRef.current.appendChild(tooltip);

    const riskScoreColorMap = {
      1: '#52c41a',
      2: '#73d13d',
      3: '#faad14',
      4: '#ff7a45',
      5: '#ff4d4f',
      6: '#f5222d',
    };

    const chartData = riskScoreData.map(item => {
      const value = parseFloat(item.score) || 0;
      return {
        time: formatChartDate(item.date),
        value: value,
        color: riskScoreColorMap[item.level] || '#faad14',
      };
    }).sort((a, b) => a.time.localeCompare(b.time));

    const lineSeries = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 3,
      priceFormat: {
        type: 'price',
        precision: 0,
        minMove: 1,
      },
    });
    lineSeries.setData(chartData);

    const areaSeries = chart.addAreaSeries({
      color: 'rgba(114, 46, 209, 0.1)',
      topColor: 'rgba(114, 46, 209, 0.15)',
      bottomColor: 'rgba(114, 46, 209, 0)',
      lineWidth: 0,
      priceFormat: {
        type: 'price',
        precision: 0,
        minMove: 1,
      },
    });
    areaSeries.setData(chartData);

    const baselineSeries = chart.addLineSeries({
      color: '#ff4d4f',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    baselineSeries.setData(chartData.map(d => ({ time: d.time, value: 100 })));

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs(time).format('MM-DD');
      },
      rightOffset: 0,
      borderColor: 'transparent',
    });

    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > riskScoreContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 300
      ) {
        tooltip.style.display = 'none';
      } else {
        const dateStr = param.time;
        const dataPoint = chartData.find(d => d.time === dateStr);
        const rawItem = riskScoreData.find(item => formatChartDate(item.date) === dateStr);

        if (dataPoint && rawItem) {
          tooltip.style.display = 'block';
          const { value, color } = dataPoint;

          tooltip.innerHTML = `
             <div class="tooltip-title">${dayjs(dateStr).format('YYYY-MM-DD')}</div>
             <div class="tooltip-item">
               <span class="label">风险偏好:</span>
               <span class="value" style="color: ${color}">${value}</span>
             </div>
             <div class="tooltip-item">
               <span class="label">等级:</span>
               <span class="value" style="color: ${color}">${rawItem.label}</span>
             </div>
             <div class="tooltip-item">
               <span class="label">描述:</span>
               <span class="value">${rawItem.desc}</span>
             </div>
           `;

          let x = param.point.x + 15;
          const y = param.point.y + 15;

          if (x > riskScoreContainerRef.current.clientWidth - 180) {
            x = param.point.x - 195;
          }

          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        }
      }
    });

    chart.applyOptions({
      layout: {
        padding: {
          top: 10,
          right: 10,
          bottom: 0,
          left: 10,
        },
      },
      localization: {
        timeFormatter: (time) => {
          return dayjs(time).format('YYYY-MM-DD');
        },
      },
    });

    chart.timeScale().fitContent();
  };

  const createBaseChart = (container, height = 500) => {
    return createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: container.clientWidth,
      height: height,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 0,
      },
    });
  };

  const renderTechChart = (techData) => {
    if (techChartRef.current) {
      techChartRef.current.remove();
    }

    const themeColor = getThemeColor();
    const chart = createBaseChart(techContainerRef.current);
    techChartRef.current = chart;

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    techContainerRef.current.appendChild(tooltip);

    const chartData = techData.map(item => {
      const value = parseFloat(item.changeSumResult) || 0;
      return {
        time: formatChartDate(item.date),
        value: value,
      };
    }).sort((a, b) => a.time.localeCompare(b.time));

    const lineSeries = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 3,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });
    lineSeries.setData(chartData);

    let prevEma = null;
    const emaAlpha = 2 / (3 + 1);
    const ma3Data = chartData
      .map((item, index) => {
        if (index < 2) return null;
        if (prevEma === null) {
          prevEma = (chartData[index - 2].value + chartData[index - 1].value + item.value) / 3;
          return { time: item.time, value: prevEma };
        }
        const currentEma = (item.value - prevEma) * emaAlpha + prevEma;
        prevEma = currentEma;
        return { time: item.time, value: currentEma };
      })
      .filter(Boolean);

    const ma3Series = chart.addLineSeries({
      color: themeColor,
      lineWidth: 2,
      lineStyle: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });
    ma3Series.setData(ma3Data);

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs(time).format('MM-DD');
      },
    });

    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > techContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 500
      ) {
        tooltip.style.display = 'none';
      } else {
        const dateStr = param.time;
        const dataPoint = chartData.find(d => d.time === dateStr);
        const ma3Point = ma3Data.find(d => d.time === dateStr);
        const phasePoint = emotionCycleData.find((d) => formatChartDate(d.tradeDate) === dateStr);

        if (dataPoint) {
          tooltip.style.display = 'block';
          const { value } = dataPoint;
          const ma3Value = ma3Point?.value;

          tooltip.innerHTML = `
             <div class="tooltip-title">${dayjs(dateStr).format('YYYY-MM-DD')}</div>
             <div class="tooltip-item">
               <span class="label">科技情绪指数:</span>
               <span class="value ${value >= 0 ? 'up' : 'down'}">${value.toFixed(2)}</span>
             </div>
             ${ma3Value !== undefined && ma3Value !== null ? `
             <div class="tooltip-item">
               <span class="label">三日EMA:</span>
               <span class="value ${ma3Value >= 0 ? 'up' : 'down'}">${ma3Value.toFixed(2)}</span>
             </div>
             ` : ''}
             
           `;

          let x = param.point.x + 15;
          const y = param.point.y + 15;

          if (x > techContainerRef.current.clientWidth - 150) {
            x = param.point.x - 165;
          }

          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        }
      }
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return dayjs(time).format('YYYY-MM-DD');
        },
      },
    });

    const baselineSeries = chart.addLineSeries({
      color: '#ff4d4f',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    baselineSeries.setData(chartData.map(d => ({ time: d.time, value: 0 })));

    chart.timeScale().fitContent();
  };

  const renderChart = (historyData) => {
    if (chartRef.current) {
      chartRef.current.remove();
    }

    const themeColor = getThemeColor();
    const chart = createBaseChart(containerRef.current);
    chartRef.current = chart;

    // 创建 Tooltip 元素
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    containerRef.current.appendChild(tooltip);

    const lineSeries = chart.addLineSeries({
      color: themeColor,
      lineWidth: 3,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    // 准备数据
    const chartData = historyData.map(item => {
      const dateStr = String(item.date);
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      const formattedDate = `${year}-${month}-${day}`;

      return {
        time: formattedDate,
        value: parseFloat(item.emotion) || 0,
        // 保存原始数据供 tooltip 使用
        detail: item
      };
    }).sort((a, b) => a.time.localeCompare(b.time));

    lineSeries.setData(chartData);

    // 设置 X 轴日期格式化
    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs(time).format('MM-DD');
      },
    });

    // 订阅十字光标移动事件
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 500
      ) {
        tooltip.style.display = 'none';
      } else {
        const dateStr = param.time;
        const dataPoint = chartData.find(d => d.time === dateStr);

        if (dataPoint) {
          tooltip.style.display = 'block';
          const { detail, value } = dataPoint;
          const { up_num, down_num, up_ratio } = detail.originData;

          tooltip.innerHTML = `
             <div class="tooltip-title">${dayjs(dateStr).format('YYYY-MM-DD')}</div>
             <div class="tooltip-item">
               <span class="label">情绪指数:</span>
               <span class="value ${value >= 0 ? 'up' : 'down'}">${value.toFixed(2)}</span>
             </div>
             <div class="tooltip-item">
               <span class="label">涨停板:</span>
               <span class="value up">${up_num}</span>
             </div>
             <div class="tooltip-item">
               <span class="label">跌停板:</span>
               <span class="value down">${down_num}</span>
             </div>
             <div class="tooltip-item">
               <span class="label">封板率:</span>
               <span class="value">${up_ratio}%</span>
             </div>
           `;

          let x = param.point.x + 15;
          const y = param.point.y + 15;

          if (x > containerRef.current.clientWidth - 150) {
            x = param.point.x - 165;
          }

          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        }
      }
    });

    // 添加基准线 (0 轴)
    const baselineSeries = chart.addLineSeries({
      color: '#ff4d4f',
      lineWidth: 1,
      lineStyle: 2, // 虚线
      priceLineVisible: false,
      lastValueVisible: false,
    });

    baselineSeries.setData(chartData.map(d => ({ time: d.time, value: 0 })));

    chart.timeScale().fitContent();
  };

  const sumResult = useMemo(() => {
    if (!sumDateRange || sumDateRange.length !== 2 || techIndexData.length === 0) {
      return { sum: 0, count: 0, avg: 0 };
    }

    const [startDate, endDate] = sumDateRange;
    const startStr = startDate.format('YYYYMMDD');
    const endStr = endDate.format('YYYYMMDD');

    const filteredData = techIndexData.filter(item => {
      const itemDate = String(item.date);
      return itemDate >= startStr && itemDate <= endStr;
    });

    const sum = filteredData.reduce((acc, item) => {
      const value = parseFloat(item.changeSumResult) || 0;
      return acc + value;
    }, 0);

    const count = filteredData.length;
    const avg = count > 0 ? sum / count : 0;

    return { sum, count, avg };
  }, [sumDateRange, techIndexData]);

  const explanationBlock = (
    <Collapse defaultActiveKey={[]} className="emotion-cycle-explanation">
      <Collapse.Panel header="📖 说明解释" key="1">
        <ul className="explanation-list">
          <li><span className="explanation-label">上涨初期</span>：三日线斜率持续抬高，k 线也逐渐升高，例如20260615-20260617</li>
          <li><span className="explanation-label">上涨末期</span>：三日线斜率持续降低，k 线还在升高，例如20260618-20260622。说明后排有股票开始掉队了。这个时候往往是上涨的末期</li>
          <li><span className="explanation-label">高位横盘震荡期</span>：三日线斜率在下面，而紫色线强弱差距值先低后高。这说明现在并非全面普涨，而是结构型分化，部分股票在走二波上涨，而其他股票都已经开始下跌了。例如 20260617-20260630：这里其实是海外算力链掉队，而国产半导体在强势上涨导致的分化</li>
          <li><span className="explanation-label">全面退潮期</span>：三日线和强弱差距线同时掉头向下，也就是紫色线和蓝色线同时降低。例如20260701-20260702</li>
          <li><span className="explanation-label">低位横盘震荡期</span>：三日线蓝色线向上，强弱差距线紫色线向下。说明之前的高位强势股补跌，低位补涨上来，此时强弱差距值变小。而之前大跌的开始止跌，并且还有新的低位补涨顶上，所以整体三日线斜率开始向上。例如 20260717</li>
          <li className="explanation-summary">
            <span className="explanation-label">总结</span>：
            <div>1. 蓝色线和紫色线同时向上，说明是健康上涨。</div>
            <div>2. 蓝色线向下紫色线向上，说明结构型分化，有些开始掉队，其他的还在上涨，但是这种状态不可能持续，如果是高位最终一定是紫色和蓝色同时拐头向下，如果是低位高位股必须要补跌，最终导致的结果就是蓝色线和紫色线之间的距离变小。</div>
            <div>3. 蓝色线和紫色线同时向下，全面退潮。</div>
            <div>4. 蓝色线向上紫色线向下，说明高位股补跌，前期大跌的止跌企稳。</div>
          </li>
        </ul>
      </Collapse.Panel>
    </Collapse>
  );

  return (
    <div className="sentiment-page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={2} style={{ marginBottom: 4 }}>
            <CoffeeOutlined style={{ marginRight: '12px', color: '#722ed1' }} />
            情绪复盘
          </Title>
          <Text type="secondary">基于涨跌停家数、炸板率等指标量化市场情绪走势</Text>
        </div>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          loading={updating}
          onClick={handleUpdateEmotion}
        >
          更新当日数据
        </Button>
      </div>

      <Row gutter={[24, 24]}>
        <Col span={24}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'realTime',
                label: '即时情绪',
              },
              {
                key: 'cycle',
                label: '情绪周期',
              },
            ]}
            style={{ marginBottom: '24px' }}
            size="large"
          />
        </Col>

        {activeTab === 'realTime' && (
          <>
            {indexKlineData && (
              <Col span={24}>
                <Divider orientation="left"><AreaChartOutlined /> 指数行情回顾</Divider>
                <Row gutter={[16, 16]}>
                  <Col span={8}>
                    <Card title="上证指数" bordered={false} className="index-kline-card">
                      <StockKLine data={indexKlineData.shangzhengData} height={350} />
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card title="创业板指" bordered={false} className="index-kline-card">
                      <StockKLine data={indexKlineData.chuangyebanData} height={350} />
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card title="科创50" bordered={false} className="index-kline-card">
                      <StockKLine data={indexKlineData.kechuangbanData} height={350} />
                    </Card>
                  </Col>
                </Row>
              </Col>
            )}

            <Col span={24}>
              <Card
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <span><LineChartOutlined /> 市场风险偏好日线图</span>
                    {riskScoreData.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '14px' }}>
                          当前：
                          <span style={{ fontWeight: 'bold', color: { 1: '#52c41a', 2: '#73d13d', 3: '#faad14', 4: '#ff7a45', 5: '#ff4d4f', 6: '#f5222d' }[riskScoreData[0].level] || '#faad14' }}>
                            {riskScoreData[riskScoreData.length - 1].label}
                          </span>
                          <span style={{ marginLeft: '8px', color: '#666' }}>
                            分数：{riskScoreData[riskScoreData.length - 1].score}
                          </span>
                        </span>
                        <Button
                          type="primary"
                          icon={<ReloadOutlined />}
                          loading={updating}
                          onClick={handleUpdateRiskScore}
                          size="small"
                        >
                          刷新
                        </Button>
                      </div>
                    )}
                    {riskScoreData.length === 0 && (
                      <Button
                        type="primary"
                        icon={<ReloadOutlined />}
                        loading={updating}
                        onClick={handleUpdateRiskScore}
                        size="small"
                      >
                        刷新
                      </Button>
                    )}
                  </div>
                }
                bordered={false}
                className="chart-card"
              >
                {riskScoreData.length > 0 ? (
                  <div ref={riskScoreContainerRef} className="chart-container" style={{ height: '220px' }} />
                ) : (
                  <div className="chart-placeholder">
                    <div className="chart-placeholder-icon">📊</div>
                    <div className="chart-placeholder-text">暂无市场风险偏好数据</div>
                    <div className="chart-placeholder-hint">交易时段收盘后（15:05）自动计算并记录</div>
                  </div>
                )}
              </Card>
            </Col>

            <Col span={24}>
              <Card
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <span><LineChartOutlined /> 科技情绪分时图</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Radio.Group
                        value={intradayMode}
                        onChange={(e) => setIntradayMode(e.target.value)}
                        size="small"
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="today">当日</Radio.Button>
                        <Radio.Button value="5day">最近五日</Radio.Button>
                      </Radio.Group>
                      <Button
                        type="primary"
                        icon={<ReloadOutlined />}
                        onClick={async () => {
                          try {
                            await axios.post(`http://${local_ip}:3000/update_emotion_data`);
                            const [resToday, res5Day] = await Promise.all([
                              axios.get(`http://${local_ip}:3000/tech_emotion_intraday`),
                              axios.get(`http://${local_ip}:3000/tech_emotion_intraday_5day`),
                            ]);
                            const today = dayjs().format('YYYYMMDD');
                            const todayData = resToday.data?.data?.[today] || [];
                            setTechIntradayData(todayData);
                            setTechIntraday5DayData(res5Day.data?.data || {});

                            const hasIce = todayData.some(item =>
                              item.value !== null && item.value !== undefined && !isNaN(item.value) && Number(item.value) <= -100
                            );
                            if (hasIce) {
                              try {
                                await axios.post(`http://${local_ip}:3000/mark_tech_index_ice`);
                              } catch (e) {
                                console.error('标记冰点失败:', e);
                              }
                            }

                            message.success('科技情绪分时数据已刷新');
                          } catch (err) {
                            console.error('Refresh tech emotion intraday failed:', err);
                            message.error('刷新失败，请重试');
                          }
                        }}
                        size="small"
                      >
                        刷新
                      </Button>
                    </div>
                  </div>
                }
                bordered={false}
                className="chart-card"
              >
                {intradayMode === 'today' ? (
                  techIntradayData.length > 0 ? (
                    <div ref={techIntradayContainerRef} className="chart-container chart-container-intraday" />
                  ) : (
                    <div className="chart-placeholder">
                      <div className="chart-placeholder-icon">📈</div>
                      <div className="chart-placeholder-text">暂无当日分时数据</div>
                      <div className="chart-placeholder-hint">交易时段内（9:25-11:30, 13:00-15:00）每分钟自动更新</div>
                    </div>
                  )
                ) : (
                  Object.keys(techIntraday5DayData).length > 0 && Object.values(techIntraday5DayData).some(arr => arr && arr.length > 0) ? (
                    <div ref={techIntradayContainerRef} className="chart-container chart-container-intraday" />
                  ) : (
                    <div className="chart-placeholder">
                      <div className="chart-placeholder-icon">📈</div>
                      <div className="chart-placeholder-text">暂无最近五日分时数据</div>
                      <div className="chart-placeholder-hint">收盘后（15:01）自动缓存当日数据，最多保留最近5天</div>
                    </div>
                  )
                )}
              </Card>
            </Col>

            <Col span={24}>
              <Card
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span><LineChartOutlined /> 科技板块情绪</span>
                    <Button
                      type="primary"
                      icon={<ReloadOutlined />}
                      loading={updating}
                      onClick={handleUpdateEmotion}
                      size="small"
                    >
                      更新
                    </Button>
                  </div>
                }
                bordered={false}
                className="chart-card"
              >
                {loading ? (
                  <div className="loading-container"><Spin tip="加载中..." /></div>
                ) : techIndexData.length > 0 ? (
                  <>
                    <div ref={techContainerRef} className="chart-container" />
                    <div className="sentiment-sum-module">
                      <div className="sentiment-sum-header">
                        <span className="sentiment-sum-label">时间范围</span>
                        <DatePicker.RangePicker
                          value={sumDateRange}
                          onChange={setSumDateRange}
                          format="YYYY-MM-DD"
                          style={{ width: '320px' }}
                        />
                      </div>
                      <div className="sentiment-sum-result">
                        <div className="sentiment-sum-item">
                          <span className="sentiment-sum-item-label">数据天数</span>
                          <span className="sentiment-sum-item-value">{sumResult.count} 天</span>
                        </div>
                        <div className="sentiment-sum-item">
                          <span className="sentiment-sum-item-label">情绪总和</span>
                          <span className={`sentiment-sum-item-value ${sumResult.sum >= 0 ? 'up' : 'down'}`}>
                            {sumResult.sum >= 0 ? '+' : ''}{sumResult.sum.toFixed(2)}
                          </span>
                        </div>
                        <div className="sentiment-sum-item">
                          <span className="sentiment-sum-item-label">日均情绪</span>
                          <span className={`sentiment-sum-item-value ${sumResult.avg >= 0 ? 'up' : 'down'}`}>
                            {sumResult.avg >= 0 ? '+' : ''}{sumResult.avg.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <Alert message="暂无科技板块情绪数据" type="info" showIcon />
                )}
              </Card>
            </Col>


          </>
        )}

        {activeTab === 'cycle' && (
          <Col span={24}>
            <Card
              title={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span><LineChartOutlined /> 情绪周期分析（基于MA3斜率分布）</span>
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={refreshEmotionCycle}
                    size="small"
                  >
                    刷新数据
                  </Button>
                </div>
              }
              bordered={false}
              className="chart-card"
            >
              {emotionCycleLoading ? (
                <div className="loading-container"><Spin tip="加载中..." /></div>
              ) : emotionCycleData.length > 0 ? (
                showFullCycleData ? (
                  <>
                    {explanationBlock}
                    <div style={{ marginBottom: 12 }}>
                      <Radio.Group
                        value={klineBoard}
                        onChange={(e) => setKlineBoard(e.target.value)}
                        size="small"
                        optionType="button"
                        buttonStyle="solid"
                      >
                        <Radio.Button value="chuangyeban">创业板</Radio.Button>
                        <Radio.Button value="kechuangban">科创板</Radio.Button>
                      </Radio.Group>
                    </div>
                    <CustomKLineChart
                      klineData={indexKlineData?.[`${klineBoard}Data`] || []}
                      emotionCycleData={emotionCycleData}
                      onStockClick={showKLine}
                      showFullData={true}
                      onToggleCompact={() => setShowFullCycleData(false)}
                      hoveredEmotionData={hoveredEmotionData}
                      setHoveredEmotionData={setHoveredEmotionData}
                      hoveredStrengthGap={hoveredStrengthGap}
                      setHoveredStrengthGap={setHoveredStrengthGap}
                      isFixed={isFixed}
                      setIsFixed={setIsFixed}
                    />
                  </>
                ) : (
                  <Row gutter={[16, 16]}>
                    <Col span={16} style={{ width: 'calc(66.6667% - 100px)' }}>
                      {explanationBlock}
                      <div style={{ marginTop: 12, marginBottom: 12 }}>
                        <Radio.Group
                          value={klineBoard}
                          onChange={(e) => setKlineBoard(e.target.value)}
                          size="small"
                          optionType="button"
                          buttonStyle="solid"
                        >
                          <Radio.Button value="chuangyeban">创业板</Radio.Button>
                          <Radio.Button value="kechuangban">科创板</Radio.Button>
                        </Radio.Group>
                      </div>
                      <CustomKLineChart
                        klineData={indexKlineData?.[`${klineBoard}Data`] || []}
                        emotionCycleData={emotionCycleData}
                        onStockClick={showKLine}
                        showFullData={false}
                        onToggleFullData={() => setShowFullCycleData(true)}
                        hoveredEmotionData={hoveredEmotionData}
                        setHoveredEmotionData={setHoveredEmotionData}
                        hoveredStrengthGap={hoveredStrengthGap}
                        setHoveredStrengthGap={setHoveredStrengthGap}
                        isFixed={isFixed}
                        setIsFixed={setIsFixed}
                      />
                    </Col>
                    <Col span={8} style={{ width: 'calc(33.3333% + 500px)' }}>
                      {(hoveredEmotionData || isFixed) && (() => {
                        const currentDate = hoveredEmotionData?.tradeDate;
                        const currentIndex = emotionCycleData.findIndex(d => d.tradeDate === currentDate);
                        const prevDayData = currentIndex >= 0 && currentIndex + 1 < emotionCycleData.length 
                          ? emotionCycleData[currentIndex + 1] 
                          : null;
                        
                        const currentAllStocks = [
                          ...(hoveredEmotionData?.strongStocks || []).map(s => ({ ...s, type: 'strong' })),
                          ...(hoveredEmotionData?.weakStocks || []).map(s => ({ ...s, type: 'weak' }))
                        ].sort((a, b) => parseFloat(b.slope) - parseFloat(a.slope));
                        
                        const prevAllStocks = [
                          ...(prevDayData?.strongStocks || []).map(s => ({ ...s, type: 'strong' })),
                          ...(prevDayData?.weakStocks || []).map(s => ({ ...s, type: 'weak' }))
                        ].sort((a, b) => parseFloat(b.slope) - parseFloat(a.slope));
                        
                        const getRankChange = (stockCode) => {
                          if (prevAllStocks.length === 0) return null;
                          const currentRank = currentAllStocks.findIndex(s => s.stockCode === stockCode);
                          const prevRank = prevAllStocks.findIndex(s => s.stockCode === stockCode);
                          if (prevRank === -1 || currentRank === -1) return null;
                          return prevRank - currentRank;
                        };
                        
                        const strongStocksWithChange = (hoveredEmotionData?.strongStocks || []).map((stock) => {
                          const currentRank = currentAllStocks.findIndex(s => s.stockCode === stock.stockCode);
                          return {
                            ...stock,
                            rankChange: getRankChange(stock.stockCode),
                            currentRank: currentRank >= 0 ? currentRank : stock.slope > 0 ? 0 : 999
                          };
                        });
                        
                        const weakStocksWithChange = (hoveredEmotionData?.weakStocks || []).map((stock) => {
                          const currentRank = currentAllStocks.findIndex(s => s.stockCode === stock.stockCode);
                          return {
                            ...stock,
                            rankChange: getRankChange(stock.stockCode),
                            currentRank: currentRank >= 0 ? currentRank : stock.slope > 0 ? 0 : 999
                          };
                        });
                        
                        return (
                        <div className="custom-kline-tooltip-card right-column-card">
                          <div className="tooltip-header">
                            <span className="tooltip-date">{hoveredEmotionData?.tradeDate ? formatDateStr(hoveredEmotionData.tradeDate) : '-'}</span>
                            <span className="tooltip-status-tag" style={{ backgroundColor: statusCodeColorMap[hoveredEmotionData?.statusCode] || '#a0aec0' }}>
                              {statusCodeLabelMap[hoveredEmotionData?.statusCode] || '-'}
                            </span>
                            <Button
                              type="text"
                              icon={<CloseOutlined />}
                              onClick={() => setIsFixed(!isFixed)}
                              className="tooltip-unfix-btn"
                            >
                              {isFixed ? '取消固定' : '固定'}
                            </Button>
                          </div>
                          <div className="tooltip-phase">{hoveredEmotionData?.phase || '-'}</div>
                          <div className="tooltip-stats">
                            <div className="tooltip-stat-item">
                              <span className="stat-label">上涨</span>
                              <span className="stat-value up">{hoveredEmotionData?.stats?.upRatio || '-'}</span>
                            </div>
                            <div className="tooltip-stat-item">
                              <span className="stat-label">下跌</span>
                              <span className="stat-value down">{hoveredEmotionData?.stats?.downRatio || '-'}</span>
                            </div>
                            <div className="tooltip-stat-item">
                              <span className="stat-label">三日线斜率</span>
                              <span className={`stat-value ${parseFloat(hoveredEmotionData?.stats?.avgMarketSlope) >= 0 ? 'up' : 'down'}`}>
                                {parseFloat(hoveredEmotionData?.stats?.avgMarketSlope) >= 0 ? '+' : ''}{hoveredEmotionData?.stats?.avgMarketSlope || '-'}°
                              </span>
                            </div>
                            <div className="tooltip-stat-item">
                              <span className="stat-label">强弱差距</span>
                              <span className={`stat-value ${hoveredStrengthGap >= 0 ? 'up' : 'down'}`}>
                                {hoveredStrengthGap >= 0 ? '+' : ''}{hoveredStrengthGap}°
                              </span>
                            </div>
                          </div>
                          <div className="tooltip-reasoning">{hoveredEmotionData?.reasoning || '暂无分析'}</div>
                          
                          <div className="tooltip-stock-container">
                            <div className="tooltip-stock-column">
                              <div className="stock-column-header up">
                                <span>🚀 强势股({hoveredEmotionData?.strongStocks?.length || 0})</span>
                                <span className="stock-column-avg-slope">平均斜率: {calcAvgSlope(hoveredEmotionData?.strongStocks || []).toFixed(2)}°</span>
                              </div>
                              <div className="stock-list-header up">
                                <span className="stock-list-header-name">股票名称</span>
                                <span className="stock-list-header-slope">斜率</span>
                                <span className="stock-list-header-change">变化</span>
                              </div>
                              <div className="stock-list">
                                {strongStocksWithChange.map((stock) => (
                                  <div
                                    key={stock.stockCode}
                                    className="stock-item up"
                                    onClick={() => showKLine && showKLine({ code: stock.stockCode, stockName: stock.stockName })}
                                  >
                                    <span className="stock-name">{stock.stockName}</span>
                                    <span className="stock-slope">{stock.slope}°</span>
                                    <span className="stock-change">
                                      {stock.rankChange !== null ? (
                                        stock.rankChange > 0 
                                          ? <span className="rank-up">↑{stock.rankChange}</span>
                                          : stock.rankChange < 0 
                                            ? <span className="rank-down">↓{Math.abs(stock.rankChange)}</span>
                                            : <span className="rank-same">—</span>
                                      ) : (
                                        <span className="rank-same">—</span>
                                      )}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="tooltip-stock-column">
                              <div className="stock-column-header down">
                                <span>💧 弱势股({hoveredEmotionData?.weakStocks?.length || 0})</span>
                                <span className="stock-column-avg-slope">平均斜率: {calcAvgSlope(hoveredEmotionData?.weakStocks || []).toFixed(2)}°</span>
                              </div>
                              <div className="stock-list-header down">
                                <span className="stock-list-header-name">股票名称</span>
                                <span className="stock-list-header-slope">斜率</span>
                                <span className="stock-list-header-change">变化</span>
                              </div>
                              <div className="stock-list">
                                {weakStocksWithChange.map((stock) => (
                                  <div
                                    key={stock.stockCode}
                                    className="stock-item down"
                                    onClick={() => showKLine && showKLine({ code: stock.stockCode, stockName: stock.stockName })}
                                  >
                                    <span className="stock-name">{stock.stockName}</span>
                                    <span className="stock-slope">{stock.slope}°</span>
                                    <span className="stock-change">
                                      {stock.rankChange !== null ? (
                                        stock.rankChange > 0 
                                          ? <span className="rank-up">↑{stock.rankChange}</span>
                                          : stock.rankChange < 0 
                                            ? <span className="rank-down">↓{Math.abs(stock.rankChange)}</span>
                                            : <span className="rank-same">—</span>
                                      ) : (
                                        <span className="rank-same">—</span>
                                      )}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                        );
                      })()}
                    </Col>
                  </Row>
                )
              ) : (
                <Alert message="暂无情绪周期数据" type="info" showIcon />
              )}
            </Card>
          </Col>
        )}
      </Row>

      <StockKLineModal
        visible={klineModalVisible}
        onCancel={() => setKlineModalVisible(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.stockName,
          code: selectedStock?.code
        }}
      />


    </div>
  );
};

export default Sentiment;
