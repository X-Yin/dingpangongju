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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  
  const mainMoneyContainerRef = useRef(null);
  const volumeContainerRef = useRef(null);
  const mainMoneyChartRef = useRef(null);
  const volumeChartRef = useRef(null);

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

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000); // 每 3 秒更新一次
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!loading && data.length > 0) {
      if (mainMoneyContainerRef.current) renderMainMoneyChart(data);
      if (volumeContainerRef.current) renderVolumeChart(data);
    }
  }, [loading, data]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      if (mainMoneyChartRef.current && mainMoneyContainerRef.current) {
        mainMoneyChartRef.current.applyOptions({ width: mainMoneyContainerRef.current.clientWidth });
      }
      if (volumeChartRef.current && volumeContainerRef.current) {
        volumeChartRef.current.applyOptions({ width: volumeContainerRef.current.clientWidth });
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
        tickMarkFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm:ss');
        },
      },
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm:ss');
        },
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

    const today = dayjs().format('YYYY-MM-DD');
    const sortedData = [...historyData].sort((a, b) => a[0].localeCompare(b[0]));
    
    const chartData = sortedData.map(([time, val]) => {
      const hh = time.substring(0, 2);
      const mm = time.substring(2, 4);
      const ss = time.substring(4, 6);
      return {
        time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(),
        value: parseFloat(val.mainMoney) || 0,
      };
    });

    series.setData(chartData);
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

    const today = dayjs().format('YYYY-MM-DD');
    const sortedData = [...historyData].sort((a, b) => a[0].localeCompare(b[0]));
    
    const chartData = sortedData.map(([time, val]) => {
      const hh = time.substring(0, 2);
      const mm = time.substring(2, 4);
      const ss = time.substring(4, 6);
      return {
        time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(),
        value: parseFloat(val.amountChangeDiff) || 0,
      };
    });

    series.setData(chartData);
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
