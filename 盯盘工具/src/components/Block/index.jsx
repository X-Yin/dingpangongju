import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Button, Card, Row, Col, Spin, Space, DatePicker, Typography, Tag
} from 'antd';
import { AppstoreOutlined, ClockCircleOutlined, LineChartOutlined, CheckOutlined, ArrowLeftOutlined, CaretRightOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import useRunOnce from '../../hooks/useRunOnce';
import StockKLineModal from '../../components/StockKLineModal';
import BlockRankingModal from '../../components/BlockRankingModal';
import MultiDayCompareModal from '../../components/MultiDayCompareModal';
import { getThemeColor } from '../../utils/theme';
import './index.scss';

const { Title, Text } = Typography;

const isAfterMarketClose = () => {
  const now = dayjs();
  const currentHour = now.hour();
  const currentMinute = now.minute();
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

// 板块颜色配置，用于图表线条颜色
const blockColors = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb',
  '#fa541c', '#1890ff', '#52c41a', '#faad14', '#f5222d',
  '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911',
  '#2f54eb', '#fa541c', '#cf1322', '#faad14', '#52c41a'
];

const Block = ({ embedded = false }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [blocks, setBlocks] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [rankingModalVisible, setRankingModalVisible] = useState(false);
  const [compareModalVisible, setCompareModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [selectedBlocks, setSelectedBlocks] = useState([]);
  const [showChart] = useState(true);
  const [dayHistoryData, setDayHistoryData] = useState([]);
  const [selectedDayBlocks, setSelectedDayBlocks] = useState([]);
  const [updatingDayHistory, setUpdatingDayHistory] = useState(false);
  const [dayStartDate, setDayStartDate] = useState(null);
  const [cpDayStartDate, setCpDayStartDate] = useState(null);
  const [blockSelectExpanded, setBlockSelectExpanded] = useState(false);
  const [dayBlockSelectExpanded, setDayBlockSelectExpanded] = useState(false);
  const isFirstLoad = useRef(true);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const dayChartContainerRef = useRef(null);
  const dayChartRef = useRef(null);
  const daySeriesRef = useRef({});
  // 海外算力 vs 国产算力 图表
  const cpIntradayContainerRef = useRef(null);
  const cpIntradayChartRef = useRef(null);
  const cpDailyContainerRef = useRef(null);
  const cpDailyChartRef = useRef(null);

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

      isFirstLoad.current = false;
      setLoading(false);
    } catch (error) {
      console.error('Fetch block data failed:', error);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

    schedulePoll(fetchData, 10000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchData]);

  // 使用 useRunOnce 设置初始选中板块（用于图表展示）
  useRunOnce(() => {
    const params = new URLSearchParams(location.search);
    const targetBlock = params.get('blockName');

    if (targetBlock) {
      // URL 携带 blockName 时，图表只展示该板块
      setSelectedBlocks([targetBlock]);
      setSelectedDayBlocks([targetBlock]);
    } else {
      // 默认选中的板块
      const initialSelected = ['银行', 'cpo', '光模块', '半导体', '存储', '电子布'];
      setSelectedBlocks(initialSelected);
      setSelectedDayBlocks(initialSelected);
    }
  }, !loading && blocks.length > 0);

  // 打开 K 线弹窗
  const showKLine = (stock) => {
    setSelectedStock(stock);
    setModalVisible(true);
  };

  // 显示排名弹窗
  const showRankingModal = () => {
    setRankingModalVisible(true);
  };

  // 显示多天对比弹窗
  const showCompareModal = () => {
    setCompareModalVisible(true);
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
      height: container.clientHeight || 350,
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
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
      },
    });
  }, []);

  // 渲染图表
  const renderChart = useCallback(() => {
    if (!chartContainerRef.current) return;

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

    // 始终创建基准线（100 线），即使没有历史数据也会显示空图
    const baselineSeries = chart.addLineSeries({
      color: '#94a3b8',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    if (historyData.length === 0) {
      // 无数据时绘制空图：显示一条居中的 100 基准线
      const emptyData = Array.from({ length: 10 }, (_, i) => ({ time: i, value: 100 }));
      baselineSeries.setData(emptyData);

      // 添加"暂无数据"标签
      const emptyLabel = document.createElement('div');
      emptyLabel.className = 'chart-empty-label';
      emptyLabel.textContent = '暂无分时数据';
      chartContainerRef.current.appendChild(emptyLabel);

      chart.timeScale().applyOptions({
        tickMarkFormatter: (time) => '',
      });
      chart.applyOptions({
        localization: { timeFormatter: () => '' },
      });
      chart.timeScale().fitContent();
      return;
    }

    // 过滤掉中午休盘的数据 (11:30 - 13:00)
    let filteredHistoryData = historyData.filter(item => {
      const time = item.time;
      // 大于等于 11:30 且小于 13:00 的数据会被过滤掉
      if (time >= '11:30' && time < '13:00') {
        return false;
      }
      return true;
    });

    // 将所有的数据分段成 10 个进行渲染
    if (filteredHistoryData.length > 10) {
      const sampledData = [];
      const chunkSize = filteredHistoryData.length / 10;
      for (let i = 0; i < 10; i++) {
        // 获取每个分段中的最后一个数据节点
        const index = Math.min(
          Math.floor((i + 1) * chunkSize) - 1,
          filteredHistoryData.length - 1
        );
        sampledData.push(filteredHistoryData[index]);
      }
      filteredHistoryData = sampledData;
    }

    // 为了tooltip准备各板块在各时间点的数据
    const intraDayBlockDataMap = {};
    let allPrices = []; // 收集所有价格用于计算范围
    selectedBlocks.forEach((blockName) => {
      let currentPrice = 100;
      let lastChange = 0; // 记录上一次的涨幅
      let isFirst = true;
      const blockDataPoints = filteredHistoryData.map((item) => {
        const block = item.blockData.find(b => b.blockName === blockName);
        if (!block) return null;
        
        // 将涨幅乘以 5，让波动看起来更明显
        const amplifiedChange = block.avgChange * 5;
        
        if (isFirst) {
          // 第一个数据点，强制为 100
          currentPrice = 100;
          lastChange = amplifiedChange;
          isFirst = false;
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

    // 创建时间到索引的映射，用于 tooltip 查找
    const timeIndexMap = {};
    filteredHistoryData.forEach((item, index) => {
      timeIndexMap[index] = item.time;
    });

    // 为每个选中的板块创建一条线 - 使用索引作为时间轴，避免中间空白
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

      // 使用索引作为时间，这样不会有中午休盘的空白
      const blockDataPoints = intraDayBlockDataMap[blockName];
      const blockChartData = blockDataPoints.map((item, idx) => {
        return {
          time: idx, // 使用索引作为时间
          value: item.price
        };
      });

      if (blockChartData.length > 0) {
        series.setData(blockChartData);
      }
    });

    // 使用顶部已创建的基准线（100 线）
    const baselineData = filteredHistoryData.map((_item, idx) => ({ time: idx, value: 100 }));
    baselineSeries.setData(baselineData);

    // 订阅十字光标移动事件
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        param.time === undefined ||
        param.point.x < 0 ||
        param.point.x > chartContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 350
      ) {
        tooltip.style.display = 'none';
      } else {
        const idx = param.time;
        const timeStr = timeIndexMap[idx];
        
        if (!timeStr) {
          tooltip.style.display = 'none';
          return;
        }
        
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
          if (y + tooltipHeight > 350) {
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

    // 设置 X 轴格式化 - 显示实际的时间而不是索引
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

  // 全选当日分时板块
  const selectAllBlocks = () => {
    setSelectedBlocks(blocks.map(b => b.blockName));
  };

  // 重置当日分时图表
  const resetChart = () => {
    setSelectedBlocks(['银行', 'cpo', '光纤', '半导体']);
  };

  // 全选日历史板块
  const selectAllDayBlocks = () => {
    setSelectedDayBlocks(blocks.map(b => b.blockName));
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
    if (!dayChartContainerRef.current) return;

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

    // 基准线始终创建
    const baselineSeries = chart.addLineSeries({
      color: '#94a3b8',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    if (dayHistoryData.length === 0) {
      const emptyData = Array.from({ length: 10 }, (_, i) => ({ time: i, value: 100 }));
      baselineSeries.setData(emptyData);

      const emptyLabel = document.createElement('div');
      emptyLabel.className = 'chart-empty-label';
      emptyLabel.textContent = '暂无历史数据';
      dayChartContainerRef.current.appendChild(emptyLabel);

      chart.timeScale().applyOptions({ tickMarkFormatter: () => '' });
      chart.applyOptions({ localization: { timeFormatter: () => '' } });
      chart.timeScale().fitContent();
      return;
    }

    // 首先，将数据按照从旧到新排序（原始数据是从新到旧）
    const sortedData = [...dayHistoryData].reverse();

    // 根据选择的开始日期过滤数据
    const filteredData = sortedData.filter(item => {
      if (!dayStartDate || !item.date) return true;
      const dateStr = String(item.date);
      let formattedDate = dateStr;
      if (dateStr.length === 8) {
        formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      }
      return !dayjs(formattedDate).startOf('day').isBefore(dayStartDate.startOf('day'));
    });

    // 为了tooltip准备各板块在各时间点的数据
    const blockDataMap = {};
    let allDayPrices = []; // 收集所有日历史价格用于计算范围
    selectedDayBlocks.forEach(blockName => {
      let currentPrice = 100;
      let isFirst = true;
      const blockDataPoints = filteredData
        .map(item => {
          // 兼容两种数据格式：数组格式和对象格式
          let blockData;
          if (Array.isArray(item.blocks)) {
            // 新数据格式：数组格式
            blockData = item.blocks.find(b => b.blockName === blockName);
          } else {
            // 旧数据格式：对象格式
            blockData = item.blocks && item.blocks[blockName];
          }
          
          if (!blockData || !item.date) return null;
          
          const dateStr = String(item.date);
          // 将 '20260612' 格式转换为 '2026-06-12'
          let formattedDate = dateStr;
          if (dateStr.length === 8) {
            formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
          }
          
          // 将涨幅乘以 5，让波动看起来更明显
          const amplifiedChange = blockData.avgChange * 5;
          
          if (isFirst) {
            currentPrice = 100;
            isFirst = false;
          } else {
            // 连续累积计算：新价格 = 前一天价格 * (1 + 今日涨幅/100)
            currentPrice = currentPrice * (1 + amplifiedChange / 100);
          }
          
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

    // 使用顶部已创建的基准线（100 线）
    const baselineData = filteredData
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
        param.point.y > 350
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
          if (y + tooltipHeight > 350) {
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
  }, [dayHistoryData, selectedDayBlocks, createBaseChart, dayStartDate]);

  // 海外算力 vs 国产算力 板块定义
  const overseasBlocks = ['光芯片', '电子布', '铜箔', 'pcb', '光模块', '光纤', 'MPO', 'PPE树脂', 'cpo'];
  const domesticBlocks = ['存储', '先进封装', '半导体', 'cpu', '国产超节点'];

  // 渲染海外算力 vs 国产算力 分时图
  const renderComputingPowerIntradayChart = useCallback(() => {
    if (!cpIntradayContainerRef.current) return;

    if (cpIntradayChartRef.current) {
      cpIntradayChartRef.current.remove();
    }

    const existingTooltips = cpIntradayContainerRef.current.querySelectorAll('.chart-tooltip');
    existingTooltips.forEach(tooltip => tooltip.remove());

    const chart = createBaseChart(cpIntradayContainerRef.current);
    cpIntradayChartRef.current = chart;

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    cpIntradayContainerRef.current.appendChild(tooltip);

    // 基准线（0轴）始终创建
    const baselineSeries = chart.addLineSeries({
      color: '#94a3b8',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    if (historyData.length === 0) {
      const emptyData = Array.from({ length: 10 }, (_, i) => ({ time: i, value: 0 }));
      baselineSeries.setData(emptyData);

      const emptyLabel = document.createElement('div');
      emptyLabel.className = 'chart-empty-label';
      emptyLabel.textContent = '暂无分时数据';
      cpIntradayContainerRef.current.appendChild(emptyLabel);

      chart.timeScale().applyOptions({ tickMarkFormatter: () => '' });
      chart.applyOptions({ localization: { timeFormatter: () => '' } });
      chart.timeScale().fitContent();
      return;
    }

    // 过滤掉中午休盘的数据 (11:30 - 13:00)
    let filteredHistoryData = historyData.filter(item => {
      const time = item.time;
      if (time >= '11:30' && time < '13:00') return false;
      return true;
    });

    // 采样为 10 个点
    // if (filteredHistoryData.length > 10) {
    //   const sampledData = [];
    //   const chunkSize = filteredHistoryData.length / 10;
    //   for (let i = 0; i < 10; i++) {
    //     const index = Math.min(Math.floor((i + 1) * chunkSize) - 1, filteredHistoryData.length - 1);
    //     sampledData.push(filteredHistoryData[index]);
    //   }
    //   filteredHistoryData = sampledData;
    // }

    const timeIndexMap = {};
    filteredHistoryData.forEach((item, index) => {
      timeIndexMap[index] = item.time;
    });

    // 计算每个时间点的海外算力和国产算力平均值
    const calcAvg = (item, blockList) => {
      const values = blockList
        .map(name => item.blockData.find(b => b.blockName === name)?.avgChange)
        .filter(v => v != null && !isNaN(v));
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    };

    const chartData = filteredHistoryData.map((item, idx) => {
      const domesticAvg = calcAvg(item, domesticBlocks);
      const overseasAvg = calcAvg(item, overseasBlocks);

      return {
        time: idx,
        domesticChange: domesticAvg,
        overseasChange: overseasAvg,
        timeStr: item.time,
      };
    });

    // 红色线 - 国产算力
    const domesticSeries = chart.addLineSeries({
      color: '#f5222d',
      lineWidth: 2,
      priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
    });
    domesticSeries.setData(chartData.map(d => ({ time: d.time, value: d.domesticChange })));

    // 蓝色线 - 海外算力
    const overseasSeries = chart.addLineSeries({
      color: getThemeColor(),
      lineWidth: 2,
      priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
    });
    overseasSeries.setData(chartData.map(d => ({ time: d.time, value: d.overseasChange })));

    // 使用顶部已创建的基准线（0轴）
    baselineSeries.setData(chartData.map(d => ({ time: d.time, value: 0 })));

    // Tooltip
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        param.time === undefined ||
        param.point.x < 0 ||
        param.point.x > cpIntradayContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 350
      ) {
        tooltip.style.display = 'none';
      } else {
        const idx = param.time;
        const dataPoint = chartData[idx];
        if (!dataPoint) {
          tooltip.style.display = 'none';
          return;
        }
        tooltip.style.display = 'block';
        tooltip.innerHTML = `
          <div class="tooltip-title">${dataPoint.timeStr}</div>
          <div class="tooltip-item">
            <span class="label" style="color: #f5222d">国产算力:</span>
            <span class="value ${dataPoint.domesticChange >= 0 ? 'up' : 'down'}">
              ${dataPoint.domesticChange > 0 ? '+' : ''}${dataPoint.domesticChange.toFixed(2)}%
            </span>
          </div>
          <div class="tooltip-item">
            <span class="label" style="color: ${getThemeColor()}">海外算力:</span>
            <span class="value ${dataPoint.overseasChange >= 0 ? 'up' : 'down'}">
              ${dataPoint.overseasChange > 0 ? '+' : ''}${dataPoint.overseasChange.toFixed(2)}%
            </span>
          </div>
        `;
        const tooltipWidth = tooltip.offsetWidth || 200;
        const tooltipHeight = tooltip.offsetHeight || 100;
        let x = param.point.x + 15;
        let y = param.point.y + 15;
        if (x + tooltipWidth > cpIntradayContainerRef.current.clientWidth) {
          x = param.point.x - tooltipWidth - 10;
        }
        if (x < 0) x = 10;
        if (y + tooltipHeight > 350) y = param.point.y - tooltipHeight - 10;
        if (y < 0) y = 10;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
      }
    });

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => timeIndexMap[time] || '',
    });
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => timeIndexMap[time] || '',
      },
    });
    chart.timeScale().fitContent();
  }, [historyData, createBaseChart]);

  // 渲染海外算力 vs 国产算力 日线图
  const renderComputingPowerDailyChart = useCallback(() => {
    if (!cpDailyContainerRef.current) return;

    if (cpDailyChartRef.current) {
      cpDailyChartRef.current.remove();
    }

    const existingTooltips = cpDailyContainerRef.current.querySelectorAll('.chart-tooltip');
    existingTooltips.forEach(tooltip => tooltip.remove());

    const chart = createBaseChart(cpDailyContainerRef.current);
    cpDailyChartRef.current = chart;

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    cpDailyContainerRef.current.appendChild(tooltip);

    // 基准线始终创建
    const baselineSeries = chart.addLineSeries({
      color: '#94a3b8',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    if (dayHistoryData.length === 0) {
      const emptyData = Array.from({ length: 10 }, (_, i) => ({ time: i, value: 100 }));
      baselineSeries.setData(emptyData);

      const emptyLabel = document.createElement('div');
      emptyLabel.className = 'chart-empty-label';
      emptyLabel.textContent = '暂无历史数据';
      cpDailyContainerRef.current.appendChild(emptyLabel);

      chart.timeScale().applyOptions({ tickMarkFormatter: () => '' });
      chart.applyOptions({ localization: { timeFormatter: () => '' } });
      chart.timeScale().fitContent();
      return;
    }

    // 从旧到新排序
    const sortedData = [...dayHistoryData].reverse();

    // 根据选择的开始日期过滤数据
    const filteredData = sortedData.filter(item => {
      if (!cpDayStartDate || !item.date) return true;
      const dateStr = String(item.date);
      let formattedDate = dateStr;
      if (dateStr.length === 8) {
        formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      }
      return !dayjs(formattedDate).startOf('day').isBefore(cpDayStartDate.startOf('day'));
    });

    const calcDayAvg = (item, blockList) => {
      const values = blockList.map(name => {
        let blockData;
        if (Array.isArray(item.blocks)) {
          blockData = item.blocks.find(b => b.blockName === name);
        } else {
          blockData = item.blocks && item.blocks[name];
        }
        return blockData?.avgChange;
      }).filter(v => v != null && !isNaN(v));
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    };

    // 累积价格法（与板块历史走势一致，起始100）
    let domesticPrice = 100, overseasPrice = 100;
    let isFirst = true;

    const chartData = filteredData.map(item => {
      if (!item.date) return null;
      const dateStr = String(item.date);
      let formattedDate = dateStr;
      if (dateStr.length === 8) {
        formattedDate = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      }

      const domesticAvg = calcDayAvg(item, domesticBlocks);
      const overseasAvg = calcDayAvg(item, overseasBlocks);

      const amplifiedDomestic = domesticAvg * 5;
      const amplifiedOverseas = overseasAvg * 5;

      if (isFirst) {
        domesticPrice = 100;
        overseasPrice = 100;
        isFirst = false;
      } else {
        domesticPrice = domesticPrice * (1 + amplifiedDomestic / 100);
        overseasPrice = overseasPrice * (1 + amplifiedOverseas / 100);
      }

      return {
        date: formattedDate,
        time: dayjs(formattedDate).unix(),
        domesticPrice,
        overseasPrice,
        domesticChange: domesticAvg,
        overseasChange: overseasAvg,
      };
    }).filter(Boolean);

    // 红色线 - 国产算力
    const domesticSeries = chart.addLineSeries({
      color: '#f5222d',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    domesticSeries.setData(chartData.map(d => ({ time: d.time, value: d.domesticPrice })));

    // 蓝色线 - 海外算力
    const overseasSeries = chart.addLineSeries({
      color: getThemeColor(),
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    overseasSeries.setData(chartData.map(d => ({ time: d.time, value: d.overseasPrice })));

    // 使用顶部已创建的基准线
    baselineSeries.setData(chartData.map(d => ({ time: d.time, value: 100 })));

    // Tooltip
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > cpDailyContainerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > 350
      ) {
        tooltip.style.display = 'none';
      } else {
        const timeUnix = param.time;
        const timeStr = dayjs.unix(timeUnix).format('YYYY-MM-DD');
        const dataPoint = chartData.find(d => d.date === timeStr);
        if (!dataPoint) {
          tooltip.style.display = 'none';
          return;
        }
        tooltip.style.display = 'block';
        tooltip.innerHTML = `
          <div class="tooltip-title">${timeStr}</div>
          <div class="tooltip-item">
            <span class="label" style="color: #f5222d">国产算力:</span>
            <span class="value ${dataPoint.domesticChange >= 0 ? 'up' : 'down'}">
              ${dataPoint.domesticPrice.toFixed(2)} (${dataPoint.domesticChange > 0 ? '+' : ''}${dataPoint.domesticChange.toFixed(2)}%)
            </span>
          </div>
          <div class="tooltip-item">
            <span class="label" style="color: ${getThemeColor()}">海外算力:</span>
            <span class="value ${dataPoint.overseasChange >= 0 ? 'up' : 'down'}">
              ${dataPoint.overseasPrice.toFixed(2)} (${dataPoint.overseasChange > 0 ? '+' : ''}${dataPoint.overseasChange.toFixed(2)}%)
            </span>
          </div>
        `;
        const tooltipWidth = tooltip.offsetWidth || 200;
        const tooltipHeight = tooltip.offsetHeight || 100;
        let x = param.point.x + 15;
        let y = param.point.y + 15;
        if (x + tooltipWidth > cpDailyContainerRef.current.clientWidth) {
          x = param.point.x - tooltipWidth - 10;
        }
        if (x < 0) x = 10;
        if (y + tooltipHeight > 350) y = param.point.y - tooltipHeight - 10;
        if (y < 0) y = 10;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
      }
    });

    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => dayjs.unix(time).format('MM-DD'),
    });
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => dayjs.unix(time).format('YYYY-MM-DD'),
      },
    });
    chart.timeScale().fitContent();
  }, [dayHistoryData, createBaseChart, cpDayStartDate]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      const updateChart = (chartRef, containerRef) => {
        if (chartRef.current && containerRef.current) {
          chartRef.current.applyOptions({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight || 350,
          });
        }
      };
      updateChart(chartRef, chartContainerRef);
      updateChart(dayChartRef, dayChartContainerRef);
      updateChart(cpIntradayChartRef, cpIntradayContainerRef);
      updateChart(cpDailyChartRef, cpDailyContainerRef);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 当历史数据或选中的板块变化时，重新渲染图表（即使没有数据也会渲染空图）
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

  // 渲染海外算力 vs 国产算力 分时图
  useEffect(() => {
    if (!loading) {
      renderComputingPowerIntradayChart();
    }
  }, [loading, renderComputingPowerIntradayChart]);

  // 渲染海外算力 vs 国产算力 日线图
  useEffect(() => {
    if (!loading) {
      renderComputingPowerDailyChart();
    }
  }, [loading, renderComputingPowerDailyChart]);

  return (
    <div className="block-container">
      <div className="page-header">
        <div className="header-left">
          {!embedded && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate(-1)}
              className="back-btn"
            />
          )}
          <Title level={4}><AppstoreOutlined /> 重点板块监控</Title>
          {lastUpdated && (
            <Text type="secondary">
              <ClockCircleOutlined /> 最后更新: {lastUpdated}
            </Text>
          )}
        </div>
        <div className="header-actions">
          <Space size="middle">
            <Button
              type='primary'
              onClick={showRankingModal}
              className="view-ranking-btn"
            >
              查看排名
            </Button>
            <Button
              type='default'
              onClick={showCompareModal}
              className="compare-btn"
            >
              多天对比
            </Button>
          </Space>
        </div>
      </div>

      <Row gutter={[24, 24]} style={{ marginBottom: '24px' }}>
        <Col xs={24} xl={12}>
          <Card 
            title={<span><LineChartOutlined /> 板块当日分时</span>} 
            bordered={false} 
            className="chart-card"
            bodyStyle={{ height: '440px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            extra={
              <Space>
                <Button 
                  type="default" 
                  size="small"
                  onClick={selectAllBlocks}
                >
                  全选
                </Button>
                <Button 
                  type="default" 
                  size="small"
                  onClick={resetChart}
                >
                  恢复默认
                </Button>
              </Space>
            }
          >
            {loading ? (
              <div className="loading-container"><Spin tip="加载中..." /></div>
            ) : (
              <>
                <div className="chart-toolbar">
                  <div
                    className={`block-select-trigger ${blockSelectExpanded ? 'expanded' : ''}`}
                    onClick={() => setBlockSelectExpanded(v => !v)}
                  >
                    <CaretRightOutlined className="trigger-caret" />
                    <span className="trigger-label">选择板块</span>
                    <Tag className="trigger-count">{selectedBlocks.length}/{blocks.length}</Tag>
                  </div>
                </div>
                <div className="chart-wrapper">
                  <div ref={chartContainerRef} className="chart-container chart-flex" />
                  {blockSelectExpanded && historyData.length > 0 && (
                    <div className="block-select-overlay">
                      <div className="custom-checkbox-group">
                        {blocks.map(b => {
                          const isChecked = selectedBlocks.includes(b.blockName);
                          const selectedIndex = selectedBlocks.indexOf(b.blockName);
                          const color = isChecked ? blockColors[selectedIndex % blockColors.length] : undefined;
                          return (
                            <div
                              key={b.blockName}
                              className={`custom-checkbox-item ${isChecked ? 'checked' : ''}`}
                              onClick={() => {
                                if (isChecked) {
                                  handleBlockSelect(selectedBlocks.filter(name => name !== b.blockName));
                                } else {
                                  handleBlockSelect([...selectedBlocks, b.blockName]);
                                }
                              }}
                              style={isChecked ? { '--custom-color': color } : {}}
                            >
                              <div className="custom-checkbox-box">
                                {isChecked && <CheckOutlined className="custom-checkbox-check" />}
                              </div>
                              <span className="custom-checkbox-label">{b.blockName}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </Card>
        </Col>

        {/* 板块历史走势图表 */}
        <Col xs={24} xl={12}>
          <Card 
            title={<span><LineChartOutlined /> 板块历史走势</span>} 
            bordered={false} 
            className="chart-card"
            bodyStyle={{ height: '440px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            extra={
                <Space>
                  <DatePicker
                    size="small"
                    placeholder="选择开始日期"
                    value={dayStartDate}
                    onChange={(date) => setDayStartDate(date)}
                    format="YYYY-MM-DD"
                  />
                  <Button 
                    type="default" 
                    size="small"
                    onClick={selectAllDayBlocks}
                  >
                    全选
                  </Button>
                  <Button 
                    type="default" 
                    size="small"
                    onClick={resetDayChart}
                  >
                    恢复默认
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
            ) : (
              <>
                <div className="chart-toolbar">
                  <div
                    className={`block-select-trigger ${dayBlockSelectExpanded ? 'expanded' : ''}`}
                    onClick={() => setDayBlockSelectExpanded(v => !v)}
                  >
                    <CaretRightOutlined className="trigger-caret" />
                    <span className="trigger-label">选择板块</span>
                    <Tag className="trigger-count">{selectedDayBlocks.length}/{blocks.length}</Tag>
                  </div>
                </div>
                <div className="chart-wrapper">
                  <div ref={dayChartContainerRef} className="chart-container chart-flex" />
                  {dayBlockSelectExpanded && dayHistoryData.length > 0 && (
                    <div className="block-select-overlay">
                      <div className="custom-checkbox-group">
                        {blocks.map(b => {
                          const isChecked = selectedDayBlocks.includes(b.blockName);
                          const selectedIndex = selectedDayBlocks.indexOf(b.blockName);
                          const color = isChecked ? blockColors[selectedIndex % blockColors.length] : undefined;
                          return (
                            <div
                              key={b.blockName}
                              className={`custom-checkbox-item ${isChecked ? 'checked' : ''}`}
                              onClick={() => {
                                if (isChecked) {
                                  handleDayBlockSelect(selectedDayBlocks.filter(name => name !== b.blockName));
                                } else {
                                  handleDayBlockSelect([...selectedDayBlocks, b.blockName]);
                                }
                              }}
                              style={isChecked ? { '--custom-color': color } : {}}
                            >
                              <div className="custom-checkbox-box">
                                {isChecked && <CheckOutlined className="custom-checkbox-check" />}
                              </div>
                              <span className="custom-checkbox-label">{b.blockName}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </Card>
        </Col>
      </Row>

      {/* 海外算力 vs 国产算力 */}
      <Row gutter={[24, 24]} style={{ marginBottom: '24px' }}>
        <Col xs={24} xl={12}>
          <Card
            title={<span><LineChartOutlined /> 海外算力 vs 国产算力 分时</span>}
            bordered={false}
            className="chart-card"
            bodyStyle={{ height: '440px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            {loading ? (
              <div className="loading-container"><Spin tip="加载中..." /></div>
            ) : (
              <>
                <div className="chart-checkbox-area">
                  {historyData.length > 0 && (
                    <>
                      <Text style={{ color: '#f5222d', marginRight: 24, fontWeight: 500 }}>● 国产算力（存储、先进封装、半导体、cpu、国产超节点）</Text>
                      <Text style={{ color: getThemeColor(), fontWeight: 500 }}>● 海外算力（光芯片、电子布、铜箔、pcb、光模块、光纤、MPO、PPE树脂、cpo）</Text>
                    </>
                  )}
                </div>
                <div ref={cpIntradayContainerRef} className="chart-container chart-flex" />
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card
            title={<span><LineChartOutlined /> 海外算力 vs 国产算力 历史</span>}
            bordered={false}
            className="chart-card"
            bodyStyle={{ height: '440px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            extra={
              <DatePicker
                size="small"
                placeholder="选择开始日期"
                value={cpDayStartDate}
                onChange={(date) => setCpDayStartDate(date)}
                format="YYYY-MM-DD"
              />
            }
          >
            {loading ? (
              <div className="loading-container"><Spin tip="加载中..." /></div>
            ) : (
              <>
                <div className="chart-checkbox-area">
                  {dayHistoryData.length > 0 && (
                    <>
                      <Text style={{ color: '#f5222d', marginRight: 24, fontWeight: 500 }}>● 国产算力（存储、先进封装、半导体、cpu、国产超节点）</Text>
                      <Text style={{ color: getThemeColor(), fontWeight: 500 }}>● 海外算力（光芯片、电子布、铜箔、pcb、光模块、光纤、MPO、PPE树脂、cpo）</Text>
                    </>
                  )}
                </div>
                <div ref={cpDailyContainerRef} className="chart-container chart-flex" />
              </>
            )}
          </Card>
        </Col>
      </Row>

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
        onStockClick={showKLine}
      />

      {/* 多天对比弹窗 */}
      <MultiDayCompareModal
        visible={compareModalVisible}
        onCancel={() => setCompareModalVisible(false)}
        dayHistoryData={dayHistoryData}
      />
    </div>
  );
};

export default Block;
