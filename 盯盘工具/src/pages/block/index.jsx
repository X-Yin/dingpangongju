import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Typography, Card, Row, Col, Tag, Spin, Empty, Space, Button, Divider, Checkbox, Alert } from 'antd';
import { AppstoreOutlined, CaretRightOutlined, ClockCircleOutlined, MenuUnfoldOutlined, MenuFoldOutlined, LineChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import BlockRankingModal from '../../components/BlockRankingModal';
import './index.scss';

const { Title, Text } = Typography;

const colorMap = {
  up: {
    text: '#cf1322',
    bg: '#fff1f0',
    border: '#ffa39e'
  },
  down: {
    text: '#389e0d',
    bg: '#f6ffed',
    border: '#b7eb8f'
  },
  neutral: {
    text: '#595959',
    bg: '#fafafa',
    border: '#d9d9d9'
  }
};

// 板块颜色配置，用于图表线条颜色
const blockColors = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb',
  '#fa541c', '#1890ff', '#52c41a', '#faad14', '#f5222d',
  '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911',
  '#2f54eb', '#fa541c', '#cf1322', '#faad14', '#52c41a'
];

const getStatus = (change) => {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'neutral';
};

const Block = () => {
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [blocks, setBlocks] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [expandedKeys, setExpandedKeys] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [rankingModalVisible, setRankingModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [selectedBlocks, setSelectedBlocks] = useState([]);
  const [showChart, setShowChart] = useState(true);
  const [dayHistoryData, setDayHistoryData] = useState([]);
  const [selectedDayBlocks, setSelectedDayBlocks] = useState([]);
  const [updatingDayHistory, setUpdatingDayHistory] = useState(false);
  const isFirstLoad = useRef(true);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const dayChartContainerRef = useRef(null);
  const dayChartRef = useRef(null);
  const daySeriesRef = useRef({});

  const fetchData = useCallback(async () => {
    try {
      const [blockResponse, historyResponse, dayHistoryResponse] = await Promise.all([
        axios.get(`http://${local_ip}:3000/block`),
        axios.get(`http://${local_ip}:3000/block_history`),
        axios.get(`http://${local_ip}:3000/block_day_history`)
      ]);
      
      setBlocks(blockResponse.data);
      setHistoryData(historyResponse.data);
      setDayHistoryData(dayHistoryResponse.data);
      setLastUpdated(dayjs().format('HH:mm:ss'));
      
      // 初始化选中的板块（默认选中银行、cpo、光纤、半导体）
      if (isFirstLoad.current && blockResponse.data.length > 0) {
        const initialSelected = ['银行', 'cpo', '半导体'];
        setSelectedBlocks(initialSelected);
        setSelectedDayBlocks(initialSelected);
      }
      
      // 处理自动定位逻辑
      const params = new URLSearchParams(location.search);
      const targetBlock = params.get('blockName');

      if (isFirstLoad.current && blockResponse.data.length > 0) {
        if (targetBlock) {
          // 如果有目标板块，仅展开该板块
          setExpandedKeys([targetBlock]);
          // 延迟滚动，确保 DOM 已渲染
          setTimeout(() => {
            const element = document.getElementById(`block-${targetBlock}`);
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 500);
        } else {
          // 否则默认全部展开
          setExpandedKeys(blockResponse.data.map(b => b.blockName));
        }
        isFirstLoad.current = false;
      }
      
      setLoading(false);
    } catch (error) {
      console.error('Fetch block data failed:', error);
      setLoading(false);
    }
  }, [location]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
    const timer = setInterval(fetchData, 10000); // 10秒刷新一次
    return () => clearInterval(timer);
  }, [fetchData]);

  // 切换单个展开状态，增加 e.stopPropagation() 防止意外冒泡
  const toggleExpand = (e, blockName) => {
    if (e) {
      e.stopPropagation();
    }
    setExpandedKeys(prev => 
      prev.includes(blockName) ? 
        prev.filter(k => k !== blockName) : 
        [...prev, blockName]
    );
  };

  // 全部展开
  const expandAll = () => {
    setExpandedKeys(blocks.map(b => b.blockName));
  };

  // 打开 K 线弹窗
  const showKLine = (stock) => {
    setSelectedStock(stock);
    setModalVisible(true);
  };

  // 全部收起
  const collapseAll = () => {
    setExpandedKeys([]);
  };

  // 显示排名弹窗
  const showRankingModal = () => {
    setRankingModalVisible(true);
  };

  // 处理板块选择变化
  const handleBlockSelect = (checkedValues) => {
    setSelectedBlocks(checkedValues);
  };

  // 创建基础图表
  const createBaseChart = useCallback((container) => {
    return createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: container.clientWidth,
      height: 500,
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
        scaleMargins: {
          top: 0.1, // 顶部留出 10% 空间
          bottom: 0.1, // 底部留出 10% 空间
        },
      },
      handleScroll: true,
      handleScale: true,
      crosshair: {
        mode: 1,
      },
    });
  }, []);

  // 渲染图表
  const renderChart = useCallback(() => {
    if (!chartContainerRef.current || historyData.length === 0) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    // 清理旧的 tooltip 元素
    const existingTooltips = chartContainerRef.current.querySelectorAll('.chart-tooltip');
    existingTooltips.forEach(tooltip => tooltip.remove());

    const chart = createBaseChart(chartContainerRef.current);
    chartRef.current = chart;
    seriesRef.current = {};

    // 创建 Tooltip 元素
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    chartContainerRef.current.appendChild(tooltip);

    // 获取今天日期用于构建完整时间
    const today = dayjs().format('YYYY-MM-DD');

    // 计算所有板块的起始价格
    const startingPrices = {};
    selectedBlocks.forEach((blockName) => {
      let startingPrice = 100;
      if (dayHistoryData.length > 0) {
        let historyPrice = 100;
        for (const historyItem of dayHistoryData) {
          const blockData = historyItem.blocks && historyItem.blocks[blockName];
          if (blockData) {
            historyPrice = historyPrice * (1 + blockData.avgChange / 100);
          }
        }
        startingPrice = historyPrice;
      }
      startingPrices[blockName] = startingPrice;
    });

    // 为了tooltip准备各板块在各时间点的数据
    const intraDayBlockDataMap = {};
    let allPrices = []; // 收集所有价格用于计算范围
    selectedBlocks.forEach((blockName) => {
      let currentPrice = startingPrices[blockName];
      let lastChange = 0; // 记录上一次的涨幅
      const blockDataPoints = historyData.map((item, index) => {
        const block = item.blockData.find(b => b.blockName === blockName);
        if (!block) return null;
        
        // 将涨幅乘以 5，让波动看起来更明显
        const amplifiedChange = block.avgChange * 5;
        
        if (index === 0) {
          // 第一个数据点，直接使用当前涨幅计算
          currentPrice = currentPrice * (1 + amplifiedChange / 100);
          lastChange = amplifiedChange;
        } else {
          // 后续数据点：价格变化 = (当前涨幅 - 上一次涨幅) * 上一次价格 / 100
          const priceChange = (amplifiedChange - lastChange) * currentPrice / 100;
          currentPrice = currentPrice + priceChange;
          lastChange = amplifiedChange;
        }
        
        const dataPoint = {
          time: item.time,
          price: currentPrice,
          change: block.avgChange
        };
        allPrices.push(currentPrice);
        return dataPoint;
      }).filter(Boolean);
      
      intraDayBlockDataMap[blockName] = blockDataPoints;
    });

    // 为每个选中的板块创建一条线
    selectedBlocks.forEach((blockName, index) => {
      const color = blockColors[index % blockColors.length];
      const series = chart.addLineSeries({
        color: color,
        lineWidth: 2,
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
      });
      
      seriesRef.current[blockName] = series;

      // 准备该板块的数据 - 基于历史最后价格，连续累积计算价格
      const blockDataPoints = intraDayBlockDataMap[blockName];
      const blockChartData = blockDataPoints.map(item => {
        const [hh, mm] = item.time.split(':');
        const time = dayjs(`${today} ${hh}:${mm}`).unix();
        
        return {
          time: time,
          value: item.price
        };
      });

      if (blockChartData.length > 0) {
        series.setData(blockChartData);
      }
    });

    // 为每个板块添加基准线（起始价格线）
    selectedBlocks.forEach((blockName, index) => {
      const color = blockColors[index % blockColors.length];
      const baselineSeries = chart.addLineSeries({
        color: color,
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        opacity: 0.5,
      });
      
      const startingPrice = startingPrices[blockName];
      const baselineData = historyData.map(item => {
        const [hh, mm] = item.time.split(':');
        const time = dayjs(`${today} ${hh}:${mm}`).unix();
        return { time: time, value: startingPrice };
      });
      baselineSeries.setData(baselineData);
    });

    // 订阅十字光标移动事件
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > chartContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 500
      ) {
        tooltip.style.display = 'none';
      } else {
        const timeUnix = param.time;
        const timeStr = dayjs.unix(timeUnix).format('HH:mm');
        
        tooltip.style.display = 'block';
        
        let tooltipHtml = `<div class="tooltip-title">${timeStr}</div>`;
        let hasData = false;
        
        selectedBlocks.forEach(blockName => {
          const blockDataPoints = intraDayBlockDataMap[blockName];
          const dataPoint = blockDataPoints?.find(p => p.time === timeStr);
          if (dataPoint) {
            hasData = true;
            const color = blockColors[selectedBlocks.indexOf(blockName) % blockColors.length];
            tooltipHtml += `
              <div class="tooltip-item">
                <span class="label" style="color: ${color}">${blockName}:</span>
                <span class="value ${dataPoint.change >= 0 ? 'up' : 'down'}">
                  ${dataPoint.price.toFixed(2)} (${dataPoint.change > 0 ? '+' : ''}${dataPoint.change.toFixed(2)}%)
                </span>
              </div>
            `;
          }
        });
        
        if (hasData) {
          tooltip.innerHTML = tooltipHtml;

          // 获取 tooltip 的实际尺寸
          const tooltipWidth = tooltip.offsetWidth || 200;
          const tooltipHeight = tooltip.offsetHeight || 100;
          
          // 计算 tooltip 的位置，避免超出容器
          let x = param.point.x + 15;
          let y = param.point.y + 15;
          
          // 检查右侧边界
          if (x + tooltipWidth > chartContainerRef.current.clientWidth) {
            x = param.point.x - tooltipWidth - 10;
          }
          
          // 检查左侧边界
          if (x < 0) {
            x = 10;
          }
          
          // 检查底部边界
          if (y + tooltipHeight > 500) {
            y = param.point.y - tooltipHeight - 10;
          }
          
          // 检查顶部边界
          if (y < 0) {
            y = 10;
          }

          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    // 设置 X 轴格式化
    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs.unix(time).format('HH:mm');
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
    });

    chart.timeScale().fitContent();
    
    // 设置自定义价格范围，让折线变化更明显
    if (allPrices.length > 0) {
      const minPrice = Math.min(...allPrices);
      const maxPrice = Math.max(...allPrices);
      const priceRange = maxPrice - minPrice;
      
      // 计算更紧凑的范围：增加一些边距但不要太多
      const padding = priceRange * 0.15; // 15% 的边距
      const newMin = minPrice - padding;
      const newMax = maxPrice + padding;
      
      // 为每个系列设置价格范围
      selectedBlocks.forEach((blockName) => {
        const series = seriesRef.current[blockName];
        if (series) {
          series.applyOptions({
            priceRange: {
              minValue: newMin,
              maxValue: newMax,
            },
          });
        }
      });
    }
  }, [historyData, selectedBlocks, dayHistoryData, createBaseChart]);

  // 重置图表
  const resetChart = () => {
    setSelectedBlocks(['银行', 'cpo', '光纤', '半导体']);
  };

  // 重置日历史图表
  const resetDayChart = () => {
    setSelectedDayBlocks(['银行', 'cpo', '光纤', '半导体']);
  };

  // 更新板块日历史数据
  const updateDayHistory = async () => {
    try {
      setUpdatingDayHistory(true);
      await axios.post(`http://${local_ip}:3000/update_block_day_history`);
      // 重新获取数据
      const response = await axios.get(`http://${local_ip}:3000/block_day_history`);
      setDayHistoryData(response.data);
      setLastUpdated(dayjs().format('HH:mm:ss'));
    } catch (error) {
      console.error('更新板块日历史数据失败:', error);
    } finally {
      setUpdatingDayHistory(false);
    }
  };

  // 处理日历史板块选择变化
  const handleDayBlockSelect = (checkedValues) => {
    setSelectedDayBlocks(checkedValues);
  };

  // 渲染日历史图表
  const renderDayChart = useCallback(() => {
    if (!dayChartContainerRef.current || dayHistoryData.length === 0) return;

    if (dayChartRef.current) {
      dayChartRef.current.remove();
    }

    // 清理旧的 tooltip 元素
    const existingTooltips = dayChartContainerRef.current.querySelectorAll('.chart-tooltip');
    existingTooltips.forEach(tooltip => tooltip.remove());

    const chart = createBaseChart(dayChartContainerRef.current);
    dayChartRef.current = chart;
    daySeriesRef.current = {};

    // 创建 Tooltip 元素
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    dayChartContainerRef.current.appendChild(tooltip);

    // 首先，将数据按照从旧到新排序（原始数据是从新到旧）
    const sortedData = [...dayHistoryData].reverse();

    // 为了tooltip准备各板块在各时间点的数据
    const blockDataMap = {};
    let allDayPrices = []; // 收集所有日历史价格用于计算范围
    selectedDayBlocks.forEach(blockName => {
      let currentPrice = 100;
      const blockDataPoints = sortedData
        .map(item => {
          const blockData = item.blocks && item.blocks[blockName];
          if (!blockData || !item.date) return null;
          
          const dateStr = String(item.date);
          // 将 '20260612' 格式转换为 '2026-06-12'
          let formattedDate = dateStr;
          if (dateStr.length === 8) {
            formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
          }
          
          // 将涨幅乘以 5，让波动看起来更明显
          const amplifiedChange = blockData.avgChange * 5;
          
          // 连续累积计算：新价格 = 前一天价格 * (1 + 今日涨幅/100)
          currentPrice = currentPrice * (1 + amplifiedChange / 100);
          
          const dataPoint = {
            date: formattedDate,
            price: currentPrice,
            change: blockData.avgChange
          };
          allDayPrices.push(currentPrice);
          return dataPoint;
        })
        .filter(Boolean);
      
      blockDataMap[blockName] = blockDataPoints;
    });

    // 为每个选中的板块创建一条线
    selectedDayBlocks.forEach((blockName, index) => {
      const color = blockColors[index % blockColors.length];
      const series = chart.addLineSeries({
        color: color,
        lineWidth: 2,
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01,
        },
      });
      
      daySeriesRef.current[blockName] = series;

      const blockDataPoints = blockDataMap[blockName];
      const blockChartData = blockDataPoints.map(item => ({
        time: dayjs(item.date).unix(),
        value: item.price
      }));

      if (blockChartData.length > 0) {
        series.setData(blockChartData);
      }
    });

    // 添加基准线 (100 线)
    const baselineSeries = chart.addLineSeries({
      color: '#ff4d4f',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    
    const baselineData = sortedData
      .map(item => {
        if (!item.date) return null;
        const dateStr = String(item.date);
        let formattedDate = dateStr;
        if (dateStr.length === 8) {
          formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
        }
        return { 
          time: dayjs(formattedDate).unix(), 
          value: 100 
        };
      })
      .filter(Boolean);
    baselineSeries.setData(baselineData);

    // 订阅十字光标移动事件
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > dayChartContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 500
      ) {
        tooltip.style.display = 'none';
      } else {
        const timeUnix = param.time;
        const timeStr = dayjs.unix(timeUnix).format('YYYY-MM-DD');
        
        tooltip.style.display = 'block';
        
        let tooltipHtml = `<div class="tooltip-title">${timeStr}</div>`;
        let hasData = false;
        
        selectedDayBlocks.forEach(blockName => {
          const blockDataPoints = blockDataMap[blockName];
          const dataPoint = blockDataPoints?.find(p => p.date === timeStr);
          if (dataPoint) {
            hasData = true;
            const color = blockColors[selectedDayBlocks.indexOf(blockName) % blockColors.length];
            tooltipHtml += `
              <div class="tooltip-item">
                <span class="label" style="color: ${color}">${blockName}:</span>
                <span class="value ${dataPoint.change >= 0 ? 'up' : 'down'}">
                  ${dataPoint.price.toFixed(2)} (${dataPoint.change > 0 ? '+' : ''}${dataPoint.change.toFixed(2)}%)
                </span>
              </div>
            `;
          }
        });
        
        if (hasData) {
          tooltip.innerHTML = tooltipHtml;

          // 获取 tooltip 的实际尺寸
          const tooltipWidth = tooltip.offsetWidth || 200;
          const tooltipHeight = tooltip.offsetHeight || 100;
          
          // 计算 tooltip 的位置，避免超出容器
          let x = param.point.x + 15;
          let y = param.point.y + 15;
          
          // 检查右侧边界
          if (x + tooltipWidth > dayChartContainerRef.current.clientWidth) {
            x = param.point.x - tooltipWidth - 10;
          }
          
          // 检查左侧边界
          if (x < 0) {
            x = 10;
          }
          
          // 检查底部边界
          if (y + tooltipHeight > 500) {
            y = param.point.y - tooltipHeight - 10;
          }
          
          // 检查顶部边界
          if (y < 0) {
            y = 10;
          }

          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    // 设置 X 轴格式化
    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => {
        return dayjs.unix(time).format('MM-DD');
      },
    });

    chart.applyOptions({
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('YYYY-MM-DD');
        },
      },
    });

    chart.timeScale().fitContent();
    
    // 设置自定义价格范围，让折线变化更明显
    if (allDayPrices.length > 0) {
      const minPrice = Math.min(...allDayPrices);
      const maxPrice = Math.max(...allDayPrices);
      const priceRange = maxPrice - minPrice;
      
      // 计算更紧凑的范围：增加一些边距但不要太多
      const padding = priceRange * 0.15; // 15% 的边距
      const newMin = minPrice - padding;
      const newMax = maxPrice + padding;
      
      // 为每个系列设置价格范围
      selectedDayBlocks.forEach((blockName) => {
        const series = daySeriesRef.current[blockName];
        if (series) {
          series.applyOptions({
            priceRange: {
              minValue: newMin,
              maxValue: newMax,
            },
          });
        }
      });
    }
  }, [dayHistoryData, selectedDayBlocks, createBaseChart]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
      if (dayChartRef.current && dayChartContainerRef.current) {
        dayChartRef.current.applyOptions({ width: dayChartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 当历史数据或选中的板块变化时，重新渲染图表
  useEffect(() => {
    if (!loading && showChart) {
      renderChart();
    }
  }, [loading, showChart, renderChart]);

  // 当日历史数据或选中的板块变化时，重新渲染日历史图表
  useEffect(() => {
    if (!loading) {
      renderDayChart();
    }
  }, [loading, renderDayChart]);

  const isAllExpanded = blocks.length > 0 && expandedKeys.length === blocks.length;

  return (
    <div className="block-container">
      <div className="page-header">
        <div className="header-left">
          <Title level={4}><AppstoreOutlined /> 重点板块监控</Title>
          {lastUpdated && (
            <Text type="secondary">
              <ClockCircleOutlined /> 最后更新: {lastUpdated}
            </Text>
          )}
        </div>
        <div className="header-actions">
          <Button
            type='primary'
            onClick={showRankingModal}
            className="view-ranking-btn"
            style={{ marginRight: '10px' }}
          >
            查看排名
          </Button>
          <Button 
            icon={isAllExpanded ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            onClick={isAllExpanded ? collapseAll : expandAll}
            className="toggle-all-btn"
            style={{ marginRight: '10px' }}
          >
            {isAllExpanded ? '全部收起' : '全部展开'}
          </Button>
          <Button 
            type={showChart ? 'default' : 'primary'}
            icon={<LineChartOutlined />}
            onClick={() => setShowChart(!showChart)}
          >
            {showChart ? '隐藏图表' : '显示图表'}
          </Button>
        </div>
      </div>

      {showChart && (
        <Row gutter={[24, 24]} style={{ marginBottom: '24px' }}>
          <Col span={24}>
            <Card 
              title={<span><LineChartOutlined /> 板块当日分时</span>} 
              bordered={false} 
              className="chart-card"
              extra={
                <Button 
                  type="default" 
                  size="small"
                  onClick={resetChart}
                >
                  重置
                </Button>
              }
            >
              {loading ? (
                <div className="loading-container"><Spin tip="加载中..." /></div>
              ) : historyData.length > 0 ? (
                <>
                  <div style={{ marginBottom: '16px' }}>
                    <Text type="secondary" style={{ marginRight: '16px' }}>选择板块:</Text>
                    <Checkbox.Group 
                      options={blocks.map(b => ({ label: b.blockName, value: b.blockName }))}
                      value={selectedBlocks}
                      onChange={handleBlockSelect}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}
                    />
                  </div>
                  <div ref={chartContainerRef} className="chart-container" style={{ height: '500px' }} />
                </>
              ) : (
                <Alert message="暂无板块历史数据" type="info" showIcon />
              )}
            </Card>
          </Col>
        </Row>
      )}

      {/* 板块历史走势图表 */}
      <Row gutter={[24, 24]} style={{ marginBottom: '24px' }}>
        <Col span={24}>
          <Card 
            title={<span><LineChartOutlined /> 板块历史走势</span>} 
            bordered={false} 
            className="chart-card"
            extra={
              <Space>
                <Button 
                  type="default" 
                  size="small"
                  onClick={resetDayChart}
                >
                  重置
                </Button>
                <Button 
                  type="primary" 
                  size="small"
                  loading={updatingDayHistory}
                  onClick={updateDayHistory}
                >
                  {updatingDayHistory ? '更新中...' : '更新数据'}
                </Button>
              </Space>
            }
          >
            {loading ? (
              <div className="loading-container"><Spin tip="加载中..." /></div>
            ) : dayHistoryData.length > 0 ? (
              <>
                <div style={{ marginBottom: '16px' }}>
                  <Text type="secondary" style={{ marginRight: '16px' }}>选择板块:</Text>
                  <Checkbox.Group 
                    options={blocks.map(b => ({ label: b.blockName, value: b.blockName }))}
                    value={selectedDayBlocks}
                    onChange={handleDayBlockSelect}
                    style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}
                  />
                </div>
                <div ref={dayChartContainerRef} className="chart-container" style={{ height: '500px' }} />
              </>
            ) : (
              <Alert message="暂无板块历史走势数据" type="info" showIcon />
            )}
          </Card>
        </Col>
      </Row>

      {loading ? (
        <div className="loading-wrapper">
          <Spin size="large" description="正在加载板块数据..." />
        </div>
      ) : blocks.length > 0 ? (
        <Row gutter={[20, 20]} className="block-grid">
          {blocks.map((block) => {
            const status = getStatus(block.avgChange);
            const colors = colorMap[status];
            const isExpanded = expandedKeys.includes(block.blockName);

            return (
              <Col xs={24} sm={12} lg={8} key={block.blockName} id={`block-${block.blockName}`}>
                <Card 
                  variant="borderless" 
                  className={`block-card ${status} ${isExpanded ? 'expanded' : ''}`}
                  title={
                    <div className="card-title-content" onClick={(e) => toggleExpand(e, block.blockName)} style={{ cursor: 'pointer' }}>
                      <Text strong className="block-name">{block.blockName}</Text>
                      <Tag
                        color={colors.bg} 
                        style={{ color: colors.text, borderColor: colors.border, fontWeight: 'bold' }}
                      >
                        {block.avgChange > 0 ? '+' : ''}{block.avgChange}%
                      </Tag>
                    </div>
                  }
                  extra={
                    <Button 
                      type="text" 
                      size="small"
                      icon={<CaretRightOutlined rotate={isExpanded ? 90 : 0} />}
                      onClick={(e) => toggleExpand(e, block.blockName)}
                    />
                  }
                >
                  <div className="card-body-wrapper">
                    {isExpanded ? (
                      <div className="stock-details-list">
                        <Space direction="vertical" style={{ width: '100%' }} size={8}>
                          {block.data.map((stock) => {
                            const stockStatus = getStatus(stock.change);
                            const stockColors = colorMap[stockStatus];
                            return (
                              <div 
                                key={stock.name} 
                                className="stock-detail-item"
                                style={{ backgroundColor: stockColors.bg, color: stockColors.text, cursor: 'pointer' }}
                                onClick={() => showKLine(stock)}
                              >
                                <span>{stock.name}</span>
                                <span style={{ fontWeight: 'bold' }}>
                                  {stock.change > 0 ? '+' : ''}{stock.change}%
                                </span>
                              </div>
                            );
                          })}
                        </Space>
                      </div>
                    ) : (
                      <div className="stock-preview" onClick={(e) => toggleExpand(e, block.blockName)} style={{ cursor: 'pointer' }}>
                        <Text type="secondary" size="small">包含 {block.data.length} 只个股</Text>
                        <Divider type="vertical" />
                        <Text type="link" size="small">点击查看详情</Text>
                      </div>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      ) : (
        <Empty description="暂无板块监控数据" />
      )}

      {/* K 线弹窗 */}
      <StockKLineModal
        visible={modalVisible}
        onCancel={() => setModalVisible(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.name,
          change: selectedStock?.change
        }}
      />

      {/* 板块排名弹窗 */}
      <BlockRankingModal
        visible={rankingModalVisible}
        onCancel={() => setRankingModalVisible(false)}
        blocks={blocks}
      />
    </div>
  );
};

export default Block;
