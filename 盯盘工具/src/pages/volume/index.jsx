import { useEffect, useState, useRef } from 'react';
import { Card, Typography, Spin, Alert, Table, Space, Row, Col, Tag } from 'antd';
import { AreaChartOutlined, ArrowUpOutlined, ArrowDownOutlined, HistoryOutlined, LineChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import StockKLine from '../../components/StockKLine';
import './index.scss';

const { Title, Text } = Typography;

const isAfterMarketClose = () => {
  const now = dayjs();
  const currentHour = now.hour();
  const currentMinute = now.minute();
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return true;
  }
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

const VolumeStatistics = () => {
  const [data, setData] = useState([]);
  const [dayHistory, setDayHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [indexKlineData, setIndexKlineData] = useState(null);

  const mainMoneyContainerRef = useRef(null);
  const volumeContainerRef = useRef(null);
  const mainMoneyChartRef = useRef(null);
  const volumeChartRef = useRef(null);
  const dayHistoryContainerRef = useRef(null);
  const dayHistoryChartRef = useRef(null);
  const dayHistoryTooltipRef = useRef(null);
  const dayVolumeContainerRef = useRef(null);
  const dayVolumeChartRef = useRef(null);
  const dayVolumeTooltipRef = useRef(null);

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_history`);
      setData(response.data);
      setLastUpdated(dayjs().format('HH:mm:ss'));
      setError(null);
    } catch (err) {
      console.error('Fetch volume data failed:', err);
      setError('获取成交量数据失败，请检查后端服务是否正常运行');
    } finally {
      setLoading(false);
    }
  };

  // 拉取按天维度的历史数据
  const fetchDayHistory = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_day_history`);
      setDayHistory(response?.data?.filter(i => i.mainMoney !== undefined) || []);
    } catch (err) {
      console.error('Fetch day history failed:', err);
    }
  };

  // 拉取指数K线数据
  const fetchIndexKlineData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_index_kline_data`);
      setIndexKlineData(response.data || null);
    } catch (err) {
      console.error('Fetch index kline data failed:', err);
    }
  };

  useEffect(() => {
    fetchData();

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

    schedulePoll(fetchData, 3000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    fetchDayHistory();
    fetchIndexKlineData();

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

    schedulePoll(fetchDayHistory, 5 * 60 * 1000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (!loading && data.length > 0) {
      if (mainMoneyContainerRef.current) renderMainMoneyChart(data);
      if (volumeContainerRef.current) renderVolumeChart(data);
    }
  }, [loading, data]);

  // 渲染按天维度的历史折线图
  useEffect(() => {
    if (dayHistory.length > 0) {
      if (dayHistoryContainerRef.current) renderDayHistoryChart(dayHistory);
      if (dayVolumeContainerRef.current) renderDayVolumeChart(dayHistory);
    }
  }, [dayHistory]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      if (mainMoneyChartRef.current && mainMoneyContainerRef.current) {
        mainMoneyChartRef.current.applyOptions({ width: mainMoneyContainerRef.current.clientWidth });
      }
      if (volumeChartRef.current && volumeContainerRef.current) {
        volumeChartRef.current.applyOptions({ width: volumeContainerRef.current.clientWidth });
      }
      if (dayHistoryChartRef.current && dayHistoryContainerRef.current) {
        dayHistoryChartRef.current.applyOptions({ width: dayHistoryContainerRef.current.clientWidth });
      }
      if (dayVolumeChartRef.current && dayVolumeContainerRef.current) {
        dayVolumeChartRef.current.applyOptions({ width: dayVolumeContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const createBaseChart = (container) => {
    return createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: container.clientWidth,
      height: 300,
      grid: {
        vertLines: { color: '#f0f0f0' },
        horzLines: { color: '#f0f0f0' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        borderColor: '#D1D4DC',
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
      },
      handleScroll: false,
      handleScale: false,
    });
  };

  const renderMainMoneyChart = (historyData) => {
    if (mainMoneyChartRef.current) {
      mainMoneyChartRef.current.remove();
    }

    const chart = createBaseChart(mainMoneyContainerRef.current);
    mainMoneyChartRef.current = chart;

    const series = chart.addLineSeries({
      color: '#f5222d',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 0,
        minMove: 1,
      },
    });

    const sortedData = [...historyData].sort((a, b) => a[0].localeCompare(b[0]));
    
    // 过滤掉中午休盘的数据 (11:30 - 13:00)
    const filteredData = sortedData.filter(([time]) => {
      const timeStr = `${time.substring(0, 2)}:${time.substring(2, 4)}`;
      if (timeStr >= '11:30' && timeStr < '13:00') {
        return false;
      }
      return true;
    });

    // 创建时间到索引的映射
    const timeIndexMap = {};
    filteredData.forEach(([time], index) => {
      const formattedTime = `${time.substring(0, 2)}:${time.substring(2, 4)}:${time.substring(4, 6)}`;
      timeIndexMap[index] = formattedTime;
    });

    const chartData = filteredData.map(([time, val], idx) => {
      let mainMoneyVal = val.mainMoney;
      if (typeof mainMoneyVal === 'string') {
        mainMoneyVal = mainMoneyVal.replace('亿', '').replace('万', '');
        if (mainMoneyVal.startsWith('+')) {
          mainMoneyVal = mainMoneyVal.slice(1);
        }
      }
      return {
        time: idx,
        value: parseFloat(mainMoneyVal) || 0,
      };
    });

    series.setData(chartData);

    // series.setMarkers(chartData.filter((_, idx) => idx % 20 === 0).map(item => ({
    //   time: item.time,
    //   position: 'aboveBar',
    //   color: item.value >= 0 ? '#f5222d' : '#52c41a',
    //   shape: 'circle',
    //   size: 0.01,
    // })));

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return timeIndexMap[time] || '';
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return timeIndexMap[time] || '';
        },
      },
    });

    chart.timeScale().fitContent();
  };

  const renderVolumeChart = (historyData) => {
    if (volumeChartRef.current) {
      volumeChartRef.current.remove();
    }

    const chart = createBaseChart(volumeContainerRef.current);
    volumeChartRef.current = chart;

    const series = chart.addLineSeries({
      color: getThemeColor(),
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 0,
        minMove: 1,
      },
    });

    const sortedData = [...historyData].sort((a, b) => a[0].localeCompare(b[0]));
    
    // 过滤掉中午休盘的数据 (11:30 - 13:00)
    const filteredData = sortedData.filter(([time]) => {
      const timeStr = `${time.substring(0, 2)}:${time.substring(2, 4)}`;
      if (timeStr >= '11:30' && timeStr < '13:00') {
        return false;
      }
      return true;
    });

    // 创建时间到索引的映射
    const timeIndexMap = {};
    filteredData.forEach(([time], index) => {
      const formattedTime = `${time.substring(0, 2)}:${time.substring(2, 4)}:${time.substring(4, 6)}`;
      timeIndexMap[index] = formattedTime;
    });

    // 使用索引作为时间，取相邻四次数据的平均数进行绘制，减少毛刺
    const windowSize = 4;
    const chartData = filteredData.map(([time, val], idx) => {
      const start = Math.max(0, idx - windowSize + 1);
      let sum = 0;
      for (let i = start; i <= idx; i++) {
        let amountVal = filteredData[i][1].amountChangeDiff;
        if (typeof amountVal === 'string') {
          amountVal = amountVal.replace('亿', '').replace('万', '');
          if (amountVal.startsWith('+')) {
            amountVal = amountVal.slice(1);
          }
        }
        sum += parseFloat(amountVal) || 0;
      }
      return {
        time: idx,
        value: sum / (idx - start + 1),
      };
    });

    series.setData(chartData);

    // series.setMarkers(chartData.filter((_, idx) => idx % 20 === 0).map(item => ({
    //   time: item.time,
    //   position: 'aboveBar',
    //   color: item.value >= 0 ? '#f5222d' : '#52c41a',
    //   shape: 'circle',
    //   size: 0.5,
    // })));

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return timeIndexMap[time] || '';
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return timeIndexMap[time] || '';
        },
      },
    });

    chart.timeScale().fitContent();
  };

  // 按天维度的历史折线图：主力资金
  const renderDayHistoryChart = (historyData) => {
    if (dayHistoryChartRef.current) {
      dayHistoryChartRef.current.remove();
    }

    const chart = createBaseChart(dayHistoryContainerRef.current);
    dayHistoryChartRef.current = chart;

    // 后端数据按从新到旧排列，图表需要从旧到新
    const sortedData = [...historyData]
      .filter(item => item.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    // 'YYYYMMDD' -> 'YYYY-MM-DD'
    const formatDate = (dateStr) => `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;

    // 构建 time -> 数据映射，供 tooltip 查询（key 为 'YYYY-MM-DD'）
    const dataMap = {};
    sortedData.forEach(item => {
      dataMap[formatDate(item.date)] = item;
    });

    const mainMoneySeries = chart.addLineSeries({
      color: '#f5222d',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const mainMoneyChartData = sortedData.map(item => {
      const dateStr = formatDate(item.date);
      const [year, month, day] = dateStr.split('-');
      return {
        time: { year: parseInt(year), month: parseInt(month), day: parseInt(day) },
        value: parseFloat(item.mainMoney) || 0,
      };
    });

    mainMoneySeries.setData(mainMoneyChartData);

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        if (typeof time === 'object' && time.year) {
          const now = dayjs();
          if (String(time.year) === String(now.year())) {
            return `${time.month}-${time.day}`;
          }
          return `${time.year}-${time.month}-${time.day}`;
        }
        return '';
      },
    });

    // 十字线悬浮时 X 轴标签
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          if (typeof time === 'object' && time.year) {
            return `${time.year}-${time.month}-${time.day}`;
          }
          return '';
        },
      },
    });

    // 鼠标移动 tooltip
    const tooltip = dayHistoryTooltipRef.current;
    if (tooltip) {
      const formatVal = (v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
          tooltip.style.display = 'none';
          return;
        }
        const dateKey = typeof param.time === 'object' && param.time.year
          ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
          : '';
        const item = dateKey ? dataMap[dateKey] : null;
        if (!item) {
          tooltip.style.display = 'none';
          return;
        }
        const mainMoneyVal = parseFloat(item.mainMoney) || 0;
        const dateLabel = dateKey.replace(/-/g, '/');
        tooltip.innerHTML =
          `<div style="font-weight:600;margin-bottom:4px;">${dateLabel}</div>` +
          `<div style="color:#f5222d;">主力资金: ${formatVal(mainMoneyVal)} 亿</div>`;
        const containerWidth = dayHistoryContainerRef.current.clientWidth;
        let left = param.point.x + 15;
        if (left + 160 > containerWidth) left = param.point.x - 160;
        tooltip.style.left = `${Math.max(0, left)}px`;
        tooltip.style.top = `${Math.max(0, param.point.y - 10)}px`;
        tooltip.style.display = 'block';
      });
    }

    chart.timeScale().fitContent();
  };

  // 按天维度的历史折线图：成交量
  const renderDayVolumeChart = (historyData) => {
    if (dayVolumeChartRef.current) {
      dayVolumeChartRef.current.remove();
    }

    const chart = createBaseChart(dayVolumeContainerRef.current);
    dayVolumeChartRef.current = chart;

    const sortedData = [...historyData]
      .filter(item => item.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    const formatDate = (dateStr) => `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;

    const dataMap = {};
    sortedData.forEach(item => {
      dataMap[formatDate(item.date)] = item;
    });

    const volumeSeries = chart.addLineSeries({
      color: getThemeColor(),
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const volumeChartData = sortedData.map(item => {
      const dateStr = formatDate(item.date);
      const [year, month, day] = dateStr.split('-');
      return {
        time: { year: parseInt(year), month: parseInt(month), day: parseInt(day) },
        value: parseFloat(item.amountChangeDiff) || 0,
      };
    });

    volumeSeries.setData(volumeChartData);

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        if (typeof time === 'object' && time.year) {
          const now = dayjs();
          if (String(time.year) === String(now.year())) {
            return `${time.month}-${time.day}`;
          }
          return `${time.year}-${time.month}-${time.day}`;
        }
        return '';
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          if (typeof time === 'object' && time.year) {
            return `${time.year}-${time.month}-${time.day}`;
          }
          return '';
        },
      },
    });

    const tooltip = dayVolumeTooltipRef.current;
    if (tooltip) {
      const formatVal = (v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
          tooltip.style.display = 'none';
          return;
        }
        const dateKey = typeof param.time === 'object' && param.time.year
          ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
          : '';
        const item = dateKey ? dataMap[dateKey] : null;
        if (!item) {
          tooltip.style.display = 'none';
          return;
        }
        const volumeVal = parseFloat(item.amountChangeDiff) || 0;
        const dateLabel = dateKey.replace(/-/g, '/');
        tooltip.innerHTML =
          `<div style="font-weight:600;margin-bottom:4px;">${dateLabel}</div>` +
          `<div style="color:${getThemeColor()};">成交量相比昨日: ${formatVal(volumeVal)} 亿</div>`;
        const containerWidth = dayVolumeContainerRef.current.clientWidth;
        let left = param.point.x + 15;
        if (left + 160 > containerWidth) left = param.point.x - 160;
        tooltip.style.left = `${Math.max(0, left)}px`;
        tooltip.style.top = `${Math.max(0, param.point.y - 10)}px`;
        tooltip.style.display = 'block';
      });
    }

    chart.timeScale().fitContent();
  };

  const parseAmountValue = (val) => {
    if (typeof val === 'string') {
      val = val.replace('亿', '').replace('万', '');
      if (val.startsWith('+')) {
        val = val.slice(1);
      }
    }
    return parseFloat(val) || 0;
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      render: (text) => `${text.substring(0, 2)}:${text.substring(2, 4)}:${text.substring(4, 6)}`,
    },
    {
      title: '主力资金',
      dataIndex: 'mainMoney',
      key: 'mainMoney',
      render: (val) => {
        const num = parseAmountValue(val);
        return <Text strong style={{ color: num >= 0 ? '#f5222d' : '#52c41a' }}>{val} 亿</Text>;
      },
    },
    {
      title: '成交量相比昨日变化',
      dataIndex: 'amountChangeDiff',
      key: 'amountChangeDiff',
      render: (val) => {
        const num = parseAmountValue(val);
        return (
          <Space>
            {num >= 0 ? <ArrowUpOutlined style={{ color: '#f5222d' }} /> : <ArrowDownOutlined style={{ color: '#52c41a' }} />}
            <Text strong style={{ color: num >= 0 ? '#f5222d' : '#52c41a' }}>{val} 亿</Text>
          </Space>
        );
      },
    },
  ];

  const tableData = [...data].reverse().map(([time, val], index) => ({
    key: index,
    time,
    mainMoney: val.mainMoney,
    amountChangeDiff: val.amountChangeDiff,
  }));

  const getTrendStatus = () => {
    if (data.length < 2) return { moneyStatus: null, volumeStatus: null };
    
    const latest = data[data.length - 1][1];
    const prev = data[data.length - 2][1];
    
    const curMoney = parseAmountValue(latest.mainMoney);
    const preMoney = parseAmountValue(prev.mainMoney);
    
    const curVol = parseAmountValue(latest.amountChangeDiff);
    const preVol = parseAmountValue(prev.amountChangeDiff);
    
    return {
      moneyStatus: curMoney >= preMoney ? 
        { label: '加速流入', color: '#f5222d', icon: <ArrowUpOutlined /> } : 
        { label: '加速流出', color: '#52c41a', icon: <ArrowDownOutlined /> },
      volumeStatus: curVol >= preVol ? 
        { label: '持续放量', color: '#f5222d', icon: <ArrowUpOutlined /> } : 
        { label: '持续缩量', color: '#52c41a', icon: <ArrowDownOutlined /> }
    };
  };

  const { moneyStatus, volumeStatus } = getTrendStatus();

  return (
    <div className="volume-statistics">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Title level={2} style={{ margin: 0 }}>
            <AreaChartOutlined style={{ marginRight: '12px', color: getThemeColor() }} />
            成交量统计
            {lastUpdated && (
              <Text type="secondary" style={{ fontSize: '14px', marginLeft: '16px', fontWeight: 'normal' }}>
                更新时间: {lastUpdated}
              </Text>
            )}
          </Title>
        </div>
        <Text type="secondary">实时监控市场主力资金流向与成交量异动</Text>
      </div>

      {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 24 }} />}

      <Row gutter={[24, 24]}>
        {indexKlineData && (
          <Col span={24}>
            <div style={{ marginBottom: '16px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '12px',
                fontSize: '15px',
                fontWeight: 600,
                color: '#12213a',
              }}>
                <AreaChartOutlined style={{ color: getThemeColor() }} />
                指数行情回顾
              </div>
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
            </div>
          </Col>
        )}

        <Col span={24}>
          <Row gutter={[24, 24]}>
            <Col lg={12} span={24}>
              <Card 
                title={<span><LineChartOutlined style={{ color: '#f5222d' }} /> 主力资金趋势 (亿)</span>} 
                extra={moneyStatus && (
                  <Tag color={moneyStatus.color} icon={moneyStatus.icon}>
                    {moneyStatus.label}
                  </Tag>
                )}
                className="chart-card"
              >
                {loading ? (
                  <div className="loading-container"><Spin tip="加载中..." /></div>
                ) : data.length > 0 ? (
                  <div ref={mainMoneyContainerRef} className="chart-container" />
                ) : (
                  <Alert message="暂无今日统计数据" type="info" showIcon />
                )}
              </Card>
            </Col>
            <Col lg={12} span={24}>
              <Card 
                title={<span><AreaChartOutlined style={{ color: getThemeColor() }} /> 成交量变化趋势 (亿)</span>} 
                extra={volumeStatus && (
                  <Tag color={volumeStatus.color} icon={volumeStatus.icon}>
                    {volumeStatus.label}
                  </Tag>
                )}
                className="chart-card"
              >
                {loading ? (
                  <div className="loading-container"><Spin tip="加载中..." /></div>
                ) : data.length > 0 ? (
                  <div ref={volumeContainerRef} className="chart-container" />
                ) : (
                  <Alert message="暂无今日统计数据" type="info" showIcon />
                )}
              </Card>
            </Col>
          </Row>
        </Col>

        <Col span={24}>
          <Row gutter={[24, 24]}>
            <Col lg={12} span={24}>
              <Card
                title={<span><LineChartOutlined style={{ color: '#f5222d' }} /> 每日历史趋势 - 主力资金 (亿)</span>}
                className="chart-card"
              >
                {dayHistory.length > 0 ? (
                  <div style={{ position: 'relative' }}>
                    <div ref={dayHistoryContainerRef} className="chart-container" />
                    <div
                      ref={dayHistoryTooltipRef}
                      style={{
                        position: 'absolute',
                        display: 'none',
                        padding: '8px 12px',
                        background: 'rgba(255, 255, 255, 0.95)',
                        border: '1px solid #d9d9d9',
                        borderRadius: 4,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                        pointerEvents: 'none',
                        zIndex: 10,
                        fontSize: 12,
                        lineHeight: '18px',
                        whiteSpace: 'nowrap',
                      }}
                    />
                  </div>
                ) : (
                  <Alert message="暂无历史数据" type="info" showIcon />
                )}
              </Card>
            </Col>
            <Col lg={12} span={24}>
              <Card
                title={<span><AreaChartOutlined style={{ color: getThemeColor() }} /> 每日历史趋势 - 成交量 (亿)</span>}
                className="chart-card"
              >
                {dayHistory.length > 0 ? (
                  <div style={{ position: 'relative' }}>
                    <div ref={dayVolumeContainerRef} className="chart-container" />
                    <div
                      ref={dayVolumeTooltipRef}
                      style={{
                        position: 'absolute',
                        display: 'none',
                        padding: '8px 12px',
                        background: 'rgba(255, 255, 255, 0.95)',
                        border: '1px solid #d9d9d9',
                        borderRadius: 4,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                        pointerEvents: 'none',
                        zIndex: 10,
                        fontSize: 12,
                        lineHeight: '18px',
                        whiteSpace: 'nowrap',
                      }}
                    />
                  </div>
                ) : (
                  <Alert message="暂无历史数据" type="info" showIcon />
                )}
              </Card>
            </Col>
          </Row>
        </Col>

        <Col span={24}>
          <Card
            title={<span><HistoryOutlined /> 历史明细</span>}
            className="table-card"
          >
            <Table
              dataSource={tableData}
              columns={columns}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              size="middle"
              loading={loading}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default VolumeStatistics;
