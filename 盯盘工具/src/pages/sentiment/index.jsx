import { useEffect, useState, useRef } from 'react';
import { Card, Typography, Spin, Alert, Row, Col, Statistic, Divider, Button, message } from 'antd';
import { CoffeeOutlined, LineChartOutlined, ArrowUpOutlined, ArrowDownOutlined, AreaChartOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLine from '../../components/StockKLine';
import './index.scss';

const { Title, Text } = Typography;

const Sentiment = () => {
  const [data, setData] = useState([]);
  const [indexKlineData, setIndexKlineData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/emotion_data`);
      setData(response.data.emotionData || []);
      setIndexKlineData(response.data.indexKlineData || null);
      setError(null);
    } catch (err) {
      console.error('Fetch emotion data failed:', err);
      setError('获取情绪数据失败，请检查后端服务是否正常运行');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateEmotion = async () => {
    setUpdating(true);
    try {
      await axios.post(`http://${local_ip}:3000/update_emotion_data`);
      message.success('今日情绪数据更新成功');
      fetchData(); // 重新拉取数据刷新页面
    } catch (err) {
      console.error('Update emotion data failed:', err);
      message.error('更新数据失败，请重试');
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!loading && data.length > 0 && containerRef.current) {
      renderChart(data);
    }
  }, [loading, data]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const renderChart = (historyData) => {
    if (chartRef.current) {
      chartRef.current.remove();
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: containerRef.current.clientWidth,
      height: 500,
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
      handleScroll: true,
      handleScale: true,
      crosshair: {
        mode: 0,
      },
    });

    chartRef.current = chart;

    // 创建 Tooltip 元素
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    containerRef.current.appendChild(tooltip);

    const lineSeries = chart.addLineSeries({
      color: '#1890ff',
      lineWidth: 3,
      title: '市场情绪指数',
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

  const latestData = data.length > 0 ? data[data.length - 1] : null;
  const prevData = data.length > 1 ? data[data.length - 2] : null;
  
  const currentEmotion = latestData ? parseFloat(latestData.emotion) : 0;
  const emotionDiff = (latestData && prevData) ? (parseFloat(latestData.emotion) - parseFloat(prevData.emotion)) : 0;
  const currentUpRatio = latestData?.originData?.up_ratio;

  const getEmotionSuggestion = () => {
    if (!latestData) return null;
    const emotion = currentEmotion;
    if (emotion > 80) {
      return {
        message: '⚠️ 情绪过热预警：当前情绪指数已超过 80',
        description: '次日市场存在较大的退潮风险，请谨慎出手，防止大盘次日冲高回落，建议以减仓观望为主。',
        type: 'error'
      };
    } else if (emotion < 60) {
      return {
        message: '🚀 情绪修复预期：当前情绪指数低于 60',
        description: '明天大盘有较强的情绪修复预期，次日可以积极寻找开盘表现强势的龙头股票，考虑重仓出手博弈。',
        type: 'success'
      };
    } else {
      return {
        message: '🔎 情绪不明朗：当前情绪指数在 60-80 之间',
        description: '市场情绪处于混沌期，多空博弈激烈，次日建议保持耐心，观察开盘后的承接力度再决定是否出手。',
        type: 'info'
      };
    }
  };

  const suggestion = getEmotionSuggestion();

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

      {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 24 }} />}

      {suggestion && (
        <Alert
          message={<Text strong style={{ fontSize: '16px' }}>{suggestion.message}</Text>}
          description={suggestion.description}
          type={suggestion.type}
          showIcon
          style={{ marginBottom: 24, borderRadius: '8px' }}
        />
      )}

      <Row gutter={[24, 24]}>
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
          <Card bordered={false} className="summary-card">
            <Row gutter={24}>
              <Col span={6}>
                <Statistic
                  title="当前情绪指数"
                  value={currentEmotion}
                  precision={2}
                  valueStyle={{ color: currentEmotion >= 0 ? '#f5222d' : '#52c41a' }}
                  prefix={<LineChartOutlined />}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="较上一交易日"
                  value={Math.abs(emotionDiff)}
                  precision={2}
                  valueStyle={{ color: emotionDiff >= 0 ? '#f5222d' : '#52c41a' }}
                  prefix={emotionDiff >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="涨停 / 跌停"
                  value={latestData?.originData?.up_num || 0}
                  suffix={`/ ${latestData?.originData?.down_num || 0}`}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="封板率"
                  value={currentUpRatio}
                  suffix="%"
                  valueStyle={{ color: parseFloat(currentUpRatio) >= 70 ? '#f5222d' : '#8c8c8c' }}
                />
              </Col>
            </Row>
          </Card>
        </Col>

        <Col span={24}>
          <Card 
            title={<span><LineChartOutlined /> 情绪走势图</span>} 
            bordered={false} 
            className="chart-card"
          >
            {loading ? (
              <div className="loading-container"><Spin tip="加载中..." /></div>
            ) : data.length > 0 ? (
              <div ref={containerRef} className="chart-container" />
            ) : (
              <Alert message="暂无情绪统计数据" type="info" showIcon />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Sentiment;
