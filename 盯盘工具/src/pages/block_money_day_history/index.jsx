import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Typography, Spin, Alert, Button, Row, Col, Checkbox, Space, message } from 'antd';
import { ReloadOutlined, AppstoreOutlined, FundOutlined, BarChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const { Title, Text } = Typography;
const { Group: CheckboxGroup } = Checkbox;

// 定义不同板块的颜色
const BLOCK_COLORS = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d',
  '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16',
  '#a0d911', '#2f54eb', '#fa541c', '#1890ff',
  '#8c8c8c', '#36cfc9', '#73d13d', '#ffc53d',
  '#ff7875', '#9254de', '#ffadd2', '#5cdbd3',
  '#b7eb8f', '#69c0ff', '#ffc069', '#ff85c0',
  '#87d068', '#61a9e9', '#fca739', '#fc5252',
  '#c169ef', '#66d7eb', '#f7ba1e', '#82ca9d',
];

const BlockMoneyDayHistory = () => {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'combined'
  const [selectedBlocks, setSelectedBlocks] = useState([]);
  const [allBlocks, setAllBlocks] = useState([]);
  
  const chartRefs = useRef({});
  const combinedChartRef = useRef(null);
  const combinedChartContainerRef = useRef(null);
  const tooltipRef = useRef(null);

  // 点击板块标题跳转到板块页面
  const handleBlockTitleClick = (blockName) => {
    navigate(`/block?blockName=${encodeURIComponent(blockName)}`);
  };

  const formatDate = (dateStr) => {
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  };

  const formatAmount = (amount) => {
    if (amount >= 100000000) {
      return `${(amount / 100000000).toFixed(2)} 亿`;
    } else if (amount >= 10000) {
      return `${(amount / 10000).toFixed(2)} 万`;
    }
    return `${amount}`;
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`http://${local_ip}:3000/get_block_money_day_history`);
      const sortedData = [...response.data].sort((a, b) => a.date.localeCompare(b.date));
      setData(sortedData);
      
      if (sortedData.length > 0) {
        const blocks = Object.keys(sortedData[sortedData.length - 1].blockAmounts);
        setAllBlocks(blocks);
        if (selectedBlocks.length === 0) {
          // 默认选中的板块
          setSelectedBlocks(['光模块', 'cpo', '半导体', '银行', '存储']);
        }
      }
    } catch (err) {
      console.error('Fetch block money day history failed:', err);
      message.error('获取板块历史成交数据失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshData = async () => {
    try {
      setRefreshing(true);
      await axios.get(`http://${local_ip}:3000/update_block_money_day_history`);
      message.success('刷新成功');
      await fetchData();
    } catch (err) {
      console.error('Refresh failed:', err);
      message.error('刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const selectAllBlocks = () => {
    setSelectedBlocks(allBlocks);
  };

  const resetToDefault = () => {
    setSelectedBlocks(['光模块', 'cpo', '半导体', '银行']);
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!loading && data.length > 0) {
      if (viewMode === 'grid') {
        renderGridCharts();
      } else {
        renderCombinedChart();
      }
    }
  }, [loading, data, viewMode, selectedBlocks]);

  useEffect(() => {
    const handleResize = () => {
      if (viewMode === 'grid') {
        Object.values(chartRefs.current).forEach((chart) => {
          if (chart && chart.container && chart.instance) {
            chart.instance.applyOptions({ width: chart.container.clientWidth });
          }
        });
      } else if (combinedChartRef.current && combinedChartContainerRef.current) {
        combinedChartRef.current.applyOptions({ width: combinedChartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [viewMode]);

  const createBaseChart = (container, height = 250) => {
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
        timeVisible: true,
        secondsVisible: false,
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

  const renderGridCharts = () => {
    Object.values(chartRefs.current).forEach((chart) => {
      if (chart && chart.instance) {
        chart.instance.remove();
      }
    });
    chartRefs.current = {};

    // 创建日期索引映射
    const dateIndexMap = {};
    data.forEach((item, index) => {
      dateIndexMap[index] = formatDate(item.date);
    });

    selectedBlocks.forEach((blockName, index) => {
      const containerId = `chart-${blockName}`;
      const container = document.getElementById(containerId);
      if (!container) return;

      const chart = createBaseChart(container, 180);
      chartRefs.current[blockName] = { instance: chart, container };

      const series = chart.addLineSeries({
        color: BLOCK_COLORS[index % BLOCK_COLORS.length],
        lineWidth: 2,
        priceFormat: {
          type: 'custom',
          formatter: (value) => {
            if (value >= 100000000) {
              return `${(value / 100000000).toFixed(2)} 亿`;
            } else if (value >= 10000) {
              return `${(value / 10000).toFixed(2)} 万`;
            }
            return `${value}`;
          },
        },
      });

      const chartData = data.map((item, idx) => ({
        time: idx,
        value: item.blockAmounts[blockName] || 0,
      }));

      series.setData(chartData);

      // 设置 X 轴格式化
      chart.timeScale().applyOptions({
        tickMarkFormatter: (time) => {
          const dateStr = dateIndexMap[time] || '';
          return dateStr.substring(5); // 只显示 MM-DD
        },
      });

      chart.applyOptions({
        localization: {
          timeFormatter: (time) => dateIndexMap[time] || '',
        },
      });

      chart.timeScale().fitContent();
    });
  };

  const renderCombinedChart = () => {
    if (combinedChartRef.current) {
      combinedChartRef.current.remove();
    }

    if (!combinedChartContainerRef.current) return;

    const chart = createBaseChart(combinedChartContainerRef.current, 500);
    combinedChartRef.current = chart;

    // 创建日期索引映射
    const dateIndexMap = {};
    data.forEach((item, index) => {
      dateIndexMap[index] = formatDate(item.date);
    });

    // 为每个板块设置名称用于 tooltip
    const seriesMap = {};
    selectedBlocks.forEach((blockName, index) => {
      const series = chart.addLineSeries({
        color: BLOCK_COLORS[index % BLOCK_COLORS.length],
        lineWidth: 2,
        priceFormat: {
          type: 'custom',
          formatter: (value) => {
            if (value >= 100000000) {
              return `${(value / 100000000).toFixed(2)} 亿`;
            } else if (value >= 10000) {
              return `${(value / 10000).toFixed(2)} 万`;
            }
            return `${value}`;
          },
        },
        lastValueVisible: true,
        priceLineVisible: true,
      });

      const chartData = data.map((item, idx) => ({
        time: idx,
        value: item.blockAmounts[blockName] || 0,
      }));

      series.setData(chartData);
      seriesMap[blockName] = { series, color: BLOCK_COLORS[index % BLOCK_COLORS.length] };
    });

    // 自定义 tooltip
    chart.subscribeCrosshairMove((param) => {
      if (!tooltipRef.current || !combinedChartContainerRef.current) return;
      
      if (param.time === undefined || !param.seriesData || param.seriesData.size === 0) {
        tooltipRef.current.style.display = 'none';
        return;
      }

      tooltipRef.current.style.display = 'block';
      
      // 计算 tooltip 位置
      const containerRect = combinedChartContainerRef.current.getBoundingClientRect();
      const time = param.time;
      const x = param.point?.x || 0;
      const y = param.point?.y || 0;
      
      // 定位 tooltip
      tooltipRef.current.style.left = `${Math.min(x + 10, containerRect.width - 180)}px`;
      tooltipRef.current.style.top = `${Math.min(y + 10, containerRect.height - 200)}px`;
      
      // 构建 tooltip 内容
      const dateStr = dateIndexMap[time] || '';
      let tooltipContent = `<div class="tooltip-date">${dateStr}</div>`;
      
      selectedBlocks.forEach((blockName, index) => {
        const seriesData = param.seriesData.get(seriesMap[blockName].series);
        if (seriesData) {
          const value = seriesData.value;
          let formattedValue;
          if (value >= 100000000) {
            formattedValue = `${(value / 100000000).toFixed(2)} 亿`;
          } else if (value >= 10000) {
            formattedValue = `${(value / 10000).toFixed(2)} 万`;
          } else {
            formattedValue = value;
          }
          tooltipContent += `
            <div class="tooltip-item">
              <span>
                <span class="color-dot" style="background-color: ${seriesMap[blockName].color}"></span>
                ${blockName}
              </span>
              <span>${formattedValue}</span>
            </div>
          `;
        }
      });
      
      tooltipRef.current.innerHTML = tooltipContent;
    });

    // 设置 X 轴格式化
    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        const dateStr = dateIndexMap[time] || '';
        return dateStr.substring(5); // 只显示 MM-DD
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => dateIndexMap[time] || '',
      },
    });

    chart.timeScale().fitContent();
  };

  return (
    <div className="block-money-day-history">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Title level={2} style={{ margin: 0 }}>
            <BarChartOutlined style={{ marginRight: '12px', color: '#1890ff' }} />
            板块历史成交
          </Title>
          <Space>
            <Button 
              type={viewMode === 'grid' ? 'primary' : 'default'}
              icon={<AppstoreOutlined />}
              onClick={() => setViewMode('grid')}
            >
              网格视图
            </Button>
            <Button 
              type={viewMode === 'combined' ? 'primary' : 'default'}
              icon={<FundOutlined />}
              onClick={() => setViewMode('combined')}
            >
              合并视图
            </Button>
            <Button 
              type="primary"
              icon={<ReloadOutlined />}
              onClick={refreshData}
              loading={refreshing}
            >
              刷新当日数据
            </Button>
          </Space>
        </div>
        <Text type="secondary">查看各板块历史成交金额趋势</Text>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text strong>选择板块：</Text>
            <Space>
              <Button size="small" onClick={selectAllBlocks}>
                全选
              </Button>
              <Button size="small" onClick={resetToDefault}>
                恢复默认
              </Button>
            </Space>
          </div>
          <CheckboxGroup
            options={allBlocks}
            value={selectedBlocks}
            onChange={setSelectedBlocks}
            style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
          />
        </Space>
      </Card>

      {loading ? (
        <div className="loading-container"><Spin tip="加载中..." /></div>
      ) : data.length > 0 ? (
        viewMode === 'grid' ? (
          <Row gutter={[16, 16]}>
            {selectedBlocks.map((blockName, index) => (
              <Col xs={24} sm={12} md={12} lg={6} xl={6} key={blockName}>
                <Card 
                  title={
                    <span 
                      style={{ color: BLOCK_COLORS[index % BLOCK_COLORS.length] }}
                      className="block-card-title"
                      onClick={() => handleBlockTitleClick(blockName)}
                    >
                      {blockName}
                    </span>
                  }
                  size="small"
                >
                  <div id={`chart-${blockName}`} className="small-chart-container" />
                </Card>
              </Col>
            ))}
          </Row>
        ) : (
          <Card title="板块成交金额趋势对比">
            <div 
              ref={combinedChartContainerRef} 
              className="combined-chart-container" 
            >
              <div 
                ref={tooltipRef} 
                className="custom-tooltip" 
                style={{ display: 'none' }} 
              />
            </div>
            <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
              {selectedBlocks.map((blockName, index) => (
                <div key={blockName} style={{ display: 'flex', alignItems: 'center' }}>
                  <div 
                    style={{ 
                      width: 12, 
                      height: 12, 
                      backgroundColor: BLOCK_COLORS[index % BLOCK_COLORS.length],
                      marginRight: 8,
                      borderRadius: 2
                    }} 
                  />
                  <Text>{blockName}</Text>
                </div>
              ))}
            </div>
          </Card>
        )
      ) : (
        <Alert message="暂无数据" type="info" showIcon />
      )}
    </div>
  );
};

export default BlockMoneyDayHistory;