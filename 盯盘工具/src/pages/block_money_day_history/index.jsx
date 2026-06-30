import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Typography, Spin, Alert, Button, Row, Col, Space, message, Modal, Tag } from 'antd';
import { ReloadOutlined, AppstoreOutlined, FundOutlined, BarChartOutlined, CheckOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const { Title, Text } = Typography;

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
  const [data, setData] = useState([]); // 成交金额数据
  const [changeData, setChangeData] = useState([]); // 涨幅数据
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'combined'
  const [selectedBlocks, setSelectedBlocks] = useState([]);
  const [allBlocks, setAllBlocks] = useState([]);
  const [diagnosisModalVisible, setDiagnosisModalVisible] = useState(false);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [diagnosisResult, setDiagnosisResult] = useState(null);

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
      // 并行获取成交金额和涨幅数据
      const [amountRes, changeRes] = await Promise.all([
        axios.get(`http://${local_ip}:3000/get_block_money_day_history`),
        axios.get(`http://${local_ip}:3000/block_day_history`),
      ]);

      const sortedAmountData = [...amountRes.data].sort((a, b) => a.date.localeCompare(b.date));
      const sortedChangeData = [...changeRes.data].sort((a, b) => a.date.localeCompare(b.date));

      setData(sortedAmountData);
      setChangeData(sortedChangeData);

      if (sortedAmountData.length > 0) {
        const blocks = Object.keys(sortedAmountData[sortedAmountData.length - 1].blockAmounts);
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

  // 诊断弹窗中点击板块：关闭弹窗，勾选该板块并置顶
  const handleDiagnosisBlockClick = (blockName) => {
    setSelectedBlocks((prev) => {
      // 移除已存在的同名板块，然后放到第一个
      const filtered = prev.filter((b) => b !== blockName);
      return [blockName, ...filtered];
    });
    setDiagnosisModalVisible(false);
  };

  const resetToDefault = () => {
    setSelectedBlocks(['光模块', 'cpo', '半导体', '银行']);
  };

  // 勾选板块时，新增的板块放到数组最前面，对应图表也展示在第一个位置
  const handleBlocksChange = (checkedValues) => {
    setSelectedBlocks((prev) => {
      const prevSet = new Set(prev);
      const added = checkedValues.filter((v) => !prevSet.has(v));
      const kept = prev.filter((v) => checkedValues.includes(v));
      return [...added, ...kept];
    });
  };

  const handleDiagnosis = async () => {
    try {
      setDiagnosisLoading(true);
      setDiagnosisModalVisible(true);
      
      // 调用两个接口
      const [changeDataRes, amountDataRes] = await Promise.all([
        axios.get(`http://${local_ip}:3000/block_day_history`),
        axios.get(`http://${local_ip}:3000/get_block_money_day_history`),
      ]);

      const changeData = changeDataRes.data;
      const amountData = amountDataRes.data;

      console.log('Change data dates:', changeData.map(d => d.date));
      console.log('Amount data dates:', amountData.map(d => d.date));

      // 分别对两个数据按日期降序排序
      const sortedChangeData = [...changeData].sort((a, b) => b.date.localeCompare(a.date));
      const sortedAmountData = [...amountData].sort((a, b) => b.date.localeCompare(a.date));

      if (sortedChangeData.length < 2 || sortedAmountData.length < 2) {
        message.error('数据不足，无法进行诊断');
        return;
      }

      // 找出两个数据都有的日期，并按降序排序
      const changeDates = new Set(sortedChangeData.map(d => d.date));
      const amountDates = new Set(sortedAmountData.map(d => d.date));
      const commonDates = [...changeDates].filter(d => amountDates.has(d)).sort((a, b) => b.localeCompare(a));

      if (commonDates.length < 2) {
        message.error('数据不足，无法进行诊断');
        return;
      }

      // 最新日期
      const latestDate = commonDates[0];
      // 用于计算 5 日均值的日期（最新日期之前的 5 天，不含最新日期）
      const avgDates = commonDates.slice(1, 6); // 取最新日期之后的 5 天

      if (avgDates.length === 0) {
        message.error('历史数据不足，无法计算 5 日均值');
        return;
      }

      // 根据找到的日期获取数据
      const latestChange = sortedChangeData.find(d => d.date === latestDate);
      const latestAmount = sortedAmountData.find(d => d.date === latestDate);

      // 获取用于计算均值的成交金额数据
      const avgAmountDataList = avgDates.map(date =>
        sortedAmountData.find(d => d.date === date)
      ).filter(Boolean);

      console.log('Using dates:', {
        latestDate,
        avgDates,
        avgDataCount: avgAmountDataList.length,
      });

      // 获取所有板块名称
      const allBlockNames = new Set([
        ...Object.keys(latestChange.blocks),
        ...Object.keys(latestAmount.blockAmounts),
        ...avgAmountDataList.reduce((acc, d) => [...acc, ...Object.keys(d.blockAmounts)], []),
      ]);

      const result = {
        priceUpVolumeUp: [], // 量价齐升
        priceDownVolumeUp: [], // 放量下跌
        priceDownVolumeDown: [], // 缩量下跌
        priceUpVolumeDown: [], // 缩量上涨
      };

      allBlockNames.forEach((blockName) => {
        const latestBlockChange = latestChange.blocks[blockName];
        const latestBlockAmount = latestAmount.blockAmounts[blockName];

        // 计算最近 5 天成交金额平均值（不含最新一天）
        const avgAmounts = avgAmountDataList
          .map(d => d.blockAmounts[blockName])
          .filter(v => v !== undefined);

        // 确保有足够的数据
        if (latestBlockChange && latestBlockAmount && avgAmounts.length > 0) {
          const avgAmount = avgAmounts.reduce((sum, v) => sum + v, 0) / avgAmounts.length;
          const isPriceUp = latestBlockChange.avgChange > 0;
          const isVolumeUp = latestBlockAmount > avgAmount;
          const volumeChangePercent = ((latestBlockAmount - avgAmount) / avgAmount * 100);

          console.log('Block:', blockName, {
            latestAmount: latestBlockAmount,
            avgAmount,
            avgDays: avgAmounts.length,
            volumeChangePercent: volumeChangePercent.toFixed(2),
          });

          const blockInfo = {
            name: blockName,
            change: latestBlockChange.avgChange,
            volumeChange: volumeChangePercent.toFixed(2),
            isVolumeUp,
            currentAmount: latestBlockAmount,
            prevAmount: avgAmount,
          };

          if (isPriceUp && isVolumeUp) {
            result.priceUpVolumeUp.push(blockInfo);
          } else if (!isPriceUp && isVolumeUp) {
            result.priceDownVolumeUp.push(blockInfo);
          } else if (!isPriceUp && !isVolumeUp) {
            result.priceDownVolumeDown.push(blockInfo);
          } else {
            result.priceUpVolumeDown.push(blockInfo);
          }
        }
      });

      // 按涨幅绝对值排序
      result.priceUpVolumeUp.sort((a, b) => b.change - a.change);
      result.priceDownVolumeUp.sort((a, b) => a.change - b.change);
      result.priceDownVolumeDown.sort((a, b) => a.change - b.change);
      result.priceUpVolumeDown.sort((a, b) => b.change - a.change);

      setDiagnosisResult(result);
    } catch (err) {
      console.error('Diagnosis failed:', err);
      message.error('诊断失败，请稍后重试');
    } finally {
      setDiagnosisLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!loading && data.length > 0 && changeData.length > 0) {
      if (viewMode === 'grid') {
        renderGridCharts();
      } else {
        renderCombinedChart();
      }
    }
  }, [loading, data, changeData, viewMode, selectedBlocks]);

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
        timeVisible: false, // 不显示时间，只显示日期
        secondsVisible: false,
        borderColor: '#D1D4DC',
        visible: true, // 确保时间轴可见
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        visible: true, // 确保价格轴可见
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

    if (!data || data.length === 0 || !changeData || changeData.length === 0) {
      console.log('No data available');
      return;
    }

    // 创建日期索引映射
    const dateIndexMap = {};
    data.forEach((item, index) => {
      dateIndexMap[index] = formatDate(item.date);
    });

    // 创建涨幅数据的日期映射
    const changeDateMap = {};
    changeData.forEach((item, index) => {
      changeDateMap[item.date] = index;
    });

    console.log('Data dates:', data.map(d => d.date));
    console.log('Change dates:', changeData.map(d => d.date));
    console.log('Selected blocks:', selectedBlocks);

    selectedBlocks.forEach((blockName, index) => {
      const containerId = `chart-${blockName}`;
      const container = document.getElementById(containerId);
      if (!container) {
        console.log(`Container not found for ${blockName}`);
        return;
      }

      const chart = createBaseChart(container, 200);

      // 准备涨幅数据 - 将日期转换为 BusinessDay 格式
      const changeChartData = [];
      data.forEach((amountItem, idx) => {
        const changeIdx = changeDateMap[amountItem.date];
        if (changeIdx !== undefined && changeData[changeIdx]) {
          const blockData = changeData[changeIdx].blocks[blockName];
          if (blockData && blockData.avgChange !== undefined) {
            // 将日期字符串转换为 BusinessDay 格式
            const dateStr = formatDate(amountItem.date);
            const [year, month, day] = dateStr.split('-');
            changeChartData.push({
              time: {
                year: parseInt(year),
                month: parseInt(month),
                day: parseInt(day),
              },
              value: blockData.avgChange,
            });
          } else {
            console.log(`No change data for ${blockName} on date ${amountItem.date}`);
          }
        } else {
          console.log(`No changeIdx for date ${amountItem.date}`);
        }
      });

      console.log(`Change chart data for ${blockName}:`, changeChartData.length, changeChartData.slice(0, 3));

      // 如果没有涨幅数据，跳过该板块
      if (changeChartData.length === 0) {
        console.log(`No change data available for ${blockName}`);
        return;
      }

      // 计算涨幅范围用于归一化成交金额
      const maxAmount = Math.max(...data.map(item => item.blockAmounts[blockName] || 0));
      const minChange = Math.min(...changeChartData.map(d => d.value));
      const maxChange = Math.max(...changeChartData.map(d => d.value));
      const changeRange = maxChange - minChange;

      console.log(`Range for ${blockName}:`, { maxAmount, minChange, maxChange, changeRange });

      // 添加成交金额柱状图（归一化到涨幅范围，半透明）
      const histogramSeries = chart.addHistogramSeries({
        color: `${BLOCK_COLORS[index % BLOCK_COLORS.length]}30`,
        priceFormat: {
          type: 'custom',
          formatter: (value) => '',
        },
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
      });

      // 将成交金额归一化到 [0, changeRange] 正数范围内，确保所有柱子方向朝上
      const amountChartData = data.map((item) => {
        const amount = item.blockAmounts[blockName] || 0;
        // 归一化到正数范围，柱子始终从 0 向上
        const normalizedValue = changeRange > 0 ? (amount / maxAmount) * changeRange : 0;

        const dateStr = formatDate(item.date);
        const [year, month, day] = dateStr.split('-');

        return {
          time: {
            year: parseInt(year),
            month: parseInt(month),
            day: parseInt(day),
          },
          value: normalizedValue,
          color: `${BLOCK_COLORS[index % BLOCK_COLORS.length]}30`,
        };
      });

      histogramSeries.setData(amountChartData);

      // 添加涨幅折线图 - 使用左侧 Y 轴
      const lineSeries = chart.addLineSeries({
        color: BLOCK_COLORS[index % BLOCK_COLORS.length],
        lineWidth: 2,
        priceFormat: {
          type: 'price',
          precision: 2,
          formatter: (value) => `${value.toFixed(2)}%`,
        },
        priceScaleId: 'left',
      });

      lineSeries.setData(changeChartData);

      // 配置左侧 Y 轴（涨幅）可见
      chart.priceScale('left').applyOptions({
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
        borderVisible: true,
        borderColor: '#D1D4DC',
        visible: true,
      });

      // 配置右侧 Y 轴（成交金额柱状图）隐藏
      chart.priceScale('right').applyOptions({
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
        borderVisible: false,
        visible: false,
      });

      // 设置 X 轴格式化
      chart.timeScale().applyOptions({
        tickMarkFormatter: (time) => {
          // time 是 BusinessDay 对象 { year, month, day }
          if (typeof time === 'object' && time.year) {
            return `${time.month}-${time.day}`;
          }
          return '';
        },
      });

      chart.applyOptions({
        localization: {
          timeFormatter: (time) => {
            // time 是 BusinessDay 对象
            if (typeof time === 'object' && time.year) {
              return `${time.year}-${time.month}-${time.day}`;
            }
            return '';
          },
        },
      });

      chart.timeScale().fitContent();

      chartRefs.current[blockName] = {
        instance: chart,
        container,
        lineSeries,
        histogramSeries,
        blockName,
      };
    });

    // 为每个图表添加 tooltip
    selectedBlocks.forEach((blockName) => {
      const chartObj = chartRefs.current[blockName];
      if (!chartObj) return;

      const { instance: chart, lineSeries, histogramSeries } = chartObj;
      const container = document.getElementById(`chart-${blockName}`);
      if (!container) return;

      // 创建日期到数据的映射（使用 BusinessDay 格式）
      const dateToDataMap = {};
      data.forEach((item) => {
        const dateStr = formatDate(item.date);
        const [year, month, day] = dateStr.split('-');
        const businessDay = {
          year: parseInt(year),
          month: parseInt(month),
          day: parseInt(day),
        };
        dateToDataMap[JSON.stringify(businessDay)] = item;
      });

      // 创建 tooltip 元素
      let tooltipEl = container.querySelector('.chart-tooltip');
      if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'chart-tooltip';
        tooltipEl.style.cssText = `
          position: absolute;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 8px 12px;
          border-radius: 4px;
          font-size: 12px;
          pointer-events: none;
          z-index: 1000;
          display: none;
        `;
        container.style.position = 'relative';
        container.appendChild(tooltipEl);
      }

      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData) {
          tooltipEl.style.display = 'none';
          return;
        }

        const lineData = param.seriesData.get(lineSeries);
        const histData = param.seriesData.get(histogramSeries);

        if (!lineData) {
          tooltipEl.style.display = 'none';
          return;
        }

        tooltipEl.style.display = 'block';

        // 计算 tooltip 位置
        const x = param.point?.x || 0;
        const y = param.point?.y || 0;
        tooltipEl.style.left = `${Math.min(x + 10, container.clientWidth - 160)}px`;
        tooltipEl.style.top = `${Math.min(y + 10, container.clientHeight - 60)}px`;

        // param.time 是 BusinessDay 对象
        const dateStr = typeof param.time === 'object' && param.time.year
          ? `${param.time.year}-${param.time.month}-${param.time.day}`
          : '';
        const changeValue = lineData.value.toFixed(2);

        // 从映射中获取实际成交金额
        const dateItem = dateToDataMap[JSON.stringify(param.time)];
        const amountValue = dateItem?.blockAmounts[blockName] || 0;
        let amountStr;
        if (amountValue >= 100000000) {
          amountStr = `${(amountValue / 100000000).toFixed(2)} 亿`;
        } else if (amountValue >= 10000) {
          amountStr = `${(amountValue / 10000).toFixed(2)} 万`;
        } else {
          amountStr = `${amountValue}`;
        }

        tooltipEl.innerHTML = `
          <div><strong>${dateStr}</strong></div>
          <div>涨幅: ${changeValue}%</div>
          <div>成交: ${amountStr}</div>
        `;
      });
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
              onClick={handleDiagnosis}
            >
              自动诊断
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
          <div className="custom-checkbox-group">
            {allBlocks.map((blockName) => {
              const isChecked = selectedBlocks.includes(blockName);
              const selectedIndex = selectedBlocks.indexOf(blockName);
              const color = isChecked ? BLOCK_COLORS[selectedIndex % BLOCK_COLORS.length] : undefined;
              return (
                <div
                  key={blockName}
                  className={`custom-checkbox-item ${isChecked ? 'checked' : ''}`}
                  onClick={() => {
                    if (isChecked) {
                      handleBlocksChange(selectedBlocks.filter((name) => name !== blockName));
                    } else {
                      handleBlocksChange([...selectedBlocks, blockName]);
                    }
                  }}
                  style={isChecked ? { '--custom-color': color } : {}}
                >
                  <div className="custom-checkbox-box">
                    {isChecked && <CheckOutlined className="custom-checkbox-check" />}
                  </div>
                  <span className="custom-checkbox-label">{blockName}</span>
                </div>
              );
            })}
          </div>
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span 
                        style={{ color: BLOCK_COLORS[index % BLOCK_COLORS.length] }}
                        className="block-card-title"
                        onClick={() => handleBlockTitleClick(blockName)}
                      >
                        {blockName}
                      </span>
                      <Button 
                        type="link" 
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleBlockTitleClick(blockName);
                        }}
                      >
                        查看成分股
                      </Button>
                    </div>
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

      <Modal
        title="板块自动诊断"
        open={diagnosisModalVisible}
        onCancel={() => {
          setDiagnosisModalVisible(false);
          setDiagnosisResult(null);
        }}
        footer={null}
        width={1000}
      >
        {diagnosisLoading ? (
          <div style={{ textAlign: 'center', padding: '50px 0' }}>
            <Spin size="large" tip="正在诊断中..." />
          </div>
        ) : diagnosisResult ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Card
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color="error" style={{ fontSize: '14px', padding: '4px 12px' }}>
                      量价齐升
                    </Tag>
                    <span style={{ color: '#999', fontSize: '14px' }}>
                      ({diagnosisResult.priceUpVolumeUp.length})
                    </span>
                  </div>
                }
                size="small"
                style={{ height: '100%' }}
              >
                {diagnosisResult.priceUpVolumeUp.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                    暂无数据
                  </div>
                ) : (
                  diagnosisResult.priceUpVolumeUp.map((block) => (
                    <div
                      key={block.name}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid #f0f0f0',
                        cursor: 'pointer',
                      }}
                      onClick={() => handleDiagnosisBlockClick(block.name)}
                    >
                      <span style={{ fontWeight: 500 }}>{block.name}</span>
                      <Space size="middle">
                        <span style={{ color: '#ff4d4f' }}>
                          涨 {block.change.toFixed(2)}%
                        </span>
                        <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                          量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                        </span>
                      </Space>
                    </div>
                  ))
                )}
              </Card>
            </Col>

            <Col xs={24} md={12}>
              <Card
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color="warning" style={{ fontSize: '14px', padding: '4px 12px' }}>
                      放量下跌
                    </Tag>
                    <span style={{ color: '#999', fontSize: '14px' }}>
                      ({diagnosisResult.priceDownVolumeUp.length})
                    </span>
                  </div>
                }
                size="small"
                style={{ height: '100%' }}
              >
                {diagnosisResult.priceDownVolumeUp.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                    暂无数据
                  </div>
                ) : (
                  diagnosisResult.priceDownVolumeUp.map((block) => (
                    <div
                      key={block.name}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid #f0f0f0',
                        cursor: 'pointer',
                      }}
                      onClick={() => handleDiagnosisBlockClick(block.name)}
                    >
                      <span style={{ fontWeight: 500 }}>{block.name}</span>
                      <Space size="middle">
                        <span style={{ color: '#52c41a' }}>
                          跌 {Math.abs(block.change).toFixed(2)}%
                        </span>
                        <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                          量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                        </span>
                      </Space>
                    </div>
                  ))
                )}
              </Card>
            </Col>

            <Col xs={24} md={12}>
              <Card
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color="success" style={{ fontSize: '14px', padding: '4px 12px' }}>
                      缩量下跌
                    </Tag>
                    <span style={{ color: '#999', fontSize: '14px' }}>
                      ({diagnosisResult.priceDownVolumeDown.length})
                    </span>
                  </div>
                }
                size="small"
                style={{ height: '100%' }}
              >
                {diagnosisResult.priceDownVolumeDown.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                    暂无数据
                  </div>
                ) : (
                  diagnosisResult.priceDownVolumeDown.map((block) => (
                    <div
                      key={block.name}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid #f0f0f0',
                        cursor: 'pointer',
                      }}
                      onClick={() => handleDiagnosisBlockClick(block.name)}
                    >
                      <span style={{ fontWeight: 500 }}>{block.name}</span>
                      <Space size="middle">
                        <span style={{ color: '#52c41a' }}>
                          跌 {Math.abs(block.change).toFixed(2)}%
                        </span>
                        <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                          量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                        </span>
                      </Space>
                    </div>
                  ))
                )}
              </Card>
            </Col>

            <Col xs={24} md={12}>
              <Card
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Tag color="blue" style={{ fontSize: '14px', padding: '4px 12px' }}>
                      缩量上涨
                    </Tag>
                    <span style={{ color: '#999', fontSize: '14px' }}>
                      ({diagnosisResult.priceUpVolumeDown.length})
                    </span>
                  </div>
                }
                size="small"
                style={{ height: '100%' }}
              >
                {diagnosisResult.priceUpVolumeDown.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                    暂无数据
                  </div>
                ) : (
                  diagnosisResult.priceUpVolumeDown.map((block) => (
                    <div
                      key={block.name}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid #f0f0f0',
                        cursor: 'pointer',
                      }}
                      onClick={() => handleDiagnosisBlockClick(block.name)}
                    >
                      <span style={{ fontWeight: 500 }}>{block.name}</span>
                      <Space size="middle">
                        <span style={{ color: '#ff4d4f' }}>
                          涨 {block.change.toFixed(2)}%
                        </span>
                        <span style={{ color: block.isVolumeUp ? '#ff4d4f' : '#52c41a' }}>
                          量 {block.isVolumeUp ? '+' : ''}{block.volumeChange}%
                        </span>
                      </Space>
                    </div>
                  ))
                )}
              </Card>
            </Col>
          </Row>
        ) : null}
      </Modal>
    </div>
  );
};

export default BlockMoneyDayHistory;