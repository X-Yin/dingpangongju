import { useEffect, useState, useRef } from 'react';
import { Card, Typography, Spin, Alert, Table, Space, Statistic, Row, Col, Tag } from 'antd';
import { AreaChartOutlined, ArrowUpOutlined, ArrowDownOutlined, HistoryOutlined, LineChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const { Title, Text } = Typography;

const VolumeStatistics = () => {
  const [data, setData] = useState([]);
  const [dayHistory, setDayHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const mainMoneyContainerRef = useRef(null);
  const volumeContainerRef = useRef(null);
  const mainMoneyChartRef = useRef(null);
  const volumeChartRef = useRef(null);
  const dayHistoryContainerRef = useRef(null);
  const dayHistoryChartRef = useRef(null);
  const dayHistoryTooltipRef = useRef(null);

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
      setDayHistory(response.data || []);
    } catch (err) {
      console.error('Fetch day history failed:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000); // 每 3 秒更新一次
    return () => clearInterval(interval);
  }, []);

  // 按天维度历史数据：挂载时拉取一次，之后每 5 分钟刷新一次
  useEffect(() => {
    fetchDayHistory();
    const interval = setInterval(fetchDayHistory, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!loading && data.length > 0) {
      if (mainMoneyContainerRef.current) renderMainMoneyChart(data);
      if (volumeContainerRef.current) renderVolumeChart(data);
    }
  }, [loading, data]);

  // 渲染按天维度的历史折线图
  useEffect(() => {
    if (dayHistoryContainerRef.current && dayHistory.length > 0) {
      renderDayHistoryChart(dayHistory);
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
      handleScroll: true,
      handleScale: true,
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

    // 使用索引作为时间
    const chartData = filteredData.map(([time, val], idx) => {
      return {
        time: idx,
        value: parseFloat(val.mainMoney) || 0,
      };
    });

    series.setData(chartData);

    // 设置 X 轴格式化
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
      color: '#1890ff',
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

    // 使用索引作为时间
    const chartData = filteredData.map(([time, val], idx) => {
      return {
        time: idx,
        value: parseFloat(val.amountChangeDiff) || 0,
      };
    });

    series.setData(chartData);

    // 设置 X 轴格式化
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

  // 按天维度的历史折线图：主力资金 + 成交量变化
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
      title: '主力资金(亿)',
    });

    const volumeSeries = chart.addLineSeries({
      color: '#1890ff',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      title: '成交量相比昨日(亿)',
    });

    // time 使用 BusinessDay 对象，与重点板块走势保持一致
    mainMoneySeries.setData(
      sortedData.map(item => {
        const dateStr = formatDate(item.date);
        const [year, month, day] = dateStr.split('-');
        return {
          time: { year: parseInt(year), month: parseInt(month), day: parseInt(day) },
          value: parseFloat(item.mainMoney) || 0,
        };
      })
    );

    volumeSeries.setData(
      sortedData.map(item => {
        const dateStr = formatDate(item.date);
        const [year, month, day] = dateStr.split('-');
        return {
          time: { year: parseInt(year), month: parseInt(month), day: parseInt(day) },
          value: parseFloat(item.amountChangeDiff) || 0,
        };
      })
    );

    // X 轴标签序列化：time 为 BusinessDay 对象，显示 'MM-DD'，跨年显示 'YYYY-MM-DD'
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

    // 十字线悬浮时 X 轴黑色标签的日期序列化
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          // time 为 BusinessDay 对象
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
        // param.time 为 BusinessDay 对象，转成 'YYYY-MM-DD' 去查 dataMap
        const dateKey = typeof param.time === 'object' && param.time.year
          ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
          : '';
        const item = dateKey ? dataMap[dateKey] : null;
        if (!item) {
          tooltip.style.display = 'none';
          return;
        }
        const mainMoneyVal = parseFloat(item.mainMoney) || 0;
        const volumeVal = parseFloat(item.amountChangeDiff) || 0;
        const dateLabel = dateKey.replace(/-/g, '/');
        tooltip.innerHTML =
          `<div style="font-weight:600;margin-bottom:4px;">${dateLabel}</div>` +
          `<div style="color:#f5222d;">主力资金: ${formatVal(mainMoneyVal)} 亿</div>` +
          `<div style="color:#1890ff;">成交量相比昨日: ${formatVal(volumeVal)} 亿</div>`;
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
        const num = parseFloat(val) || 0;
        return <Text strong style={{ color: num >= 0 ? '#f5222d' : '#52c41a' }}>{val} 亿</Text>;
      },
    },
    {
      title: '成交量相比昨日变化',
      dataIndex: 'amountChangeDiff',
      key: 'amountChangeDiff',
      render: (val) => {
        const num = parseFloat(val) || 0;
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

  const latestData = data.length > 0 ? data[data.length - 1][1] : { mainMoney: '0', amountChangeDiff: '0' };
  const latestMainMoney = parseFloat(latestData.mainMoney) || 0;
  const latestAmountChange = parseFloat(latestData.amountChangeDiff) || 0;

  const getTrendStatus = () => {
    if (data.length < 2) return { moneyStatus: null, volumeStatus: null };
    
    const latest = data[data.length - 1][1];
    const prev = data[data.length - 2][1];
    
    const curMoney = parseFloat(latest.mainMoney) || 0;
    const preMoney = parseFloat(prev.mainMoney) || 0;
    
    const curVol = parseFloat(latest.amountChangeDiff) || 0;
    const preVol = parseFloat(prev.amountChangeDiff) || 0;
    
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
            <AreaChartOutlined style={{ marginRight: '12px', color: '#1890ff' }} />
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
        <Col span={24}>
          <Row gutter={24}>
            <Col span={12}>
              <Card className="stat-card main-money">
                <Statistic
                  title="当前主力资金净流入"
                  value={latestMainMoney}
                  precision={0}
                  valueStyle={{ color: latestMainMoney >= 0 ? '#f5222d' : '#52c41a' }}
                  prefix={latestMainMoney >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                  suffix="亿"
                />
              </Card>
            </Col>
            <Col span={12}>
              <Card className="stat-card amount-change">
                <Statistic
                  title="成交量相比昨日同期"
                  value={latestAmountChange}
                  precision={0}
                  valueStyle={{ color: latestAmountChange >= 0 ? '#f5222d' : '#52c41a' }}
                  prefix={latestAmountChange >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                  suffix="亿"
                />
              </Card>
            </Col>
          </Row>
        </Col>

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
                title={<span><AreaChartOutlined style={{ color: '#1890ff' }} /> 成交量变化趋势 (亿)</span>} 
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
          <Card
            title={<span><LineChartOutlined style={{ color: '#722ed1' }} /> 每日历史趋势（按天维度）</span>}
            extra={
              <Space size="middle">
                <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#f5222d', marginRight: 6, verticalAlign: 'middle' }} />主力资金(亿)</span>
                <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#1890ff', marginRight: 6, verticalAlign: 'middle' }} />成交量相比昨日(亿)</span>
              </Space>
            }
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
              <Alert message="暂无按天维度历史数据，收盘后会自动记录" type="info" showIcon />
            )}
          </Card>
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
