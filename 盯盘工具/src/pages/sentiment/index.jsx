import { useEffect, useState, useRef } from 'react';
import { Card, Typography, Spin, Alert, Row, Col, Statistic, Divider, Button, message, Tag } from 'antd';
import { CoffeeOutlined, LineChartOutlined, AreaChartOutlined, ReloadOutlined, AppstoreOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { createChart, ColorType } from 'lightweight-charts';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLine from '../../components/StockKLine';
import { useEmotionSuggestion } from '../../hooks/emotion';
import './index.scss';

const { Title, Text } = Typography;

/**
 * 情绪周期分析函数（3日均线 + 操作建议）
 * @param {Array<{time: string, value: number}>} data
 * @returns {object|null} 结构化分析结果
 */
function analyzeMarketEmotion(data) {
  if (!Array.isArray(data) || data.length < 3) {
    return null;
  }

  // 1. 按时间排序（防止乱序）
  const sorted = [...data].sort((a, b) => new Date(a.time) - new Date(b.time));

  // 2. 计算3日均线
  const ma3 = [];

  for (let i = 2; i < sorted.length; i++) {
    const v =
      (sorted[i].value +
        sorted[i - 1].value +
        sorted[i - 2].value) /
      3;

    ma3.push({
      time: sorted[i].time,
      value: v,
    });
  }

  const latest = ma3[ma3.length - 1];
  const prev = ma3[ma3.length - 2];

  const latestVal = latest.value;
  const prevVal = prev.value;

  // 3. 计算趋势（斜率）
  const slope = latestVal - prevVal;

  // 4. 分层决策逻辑
  let action = "观望";
  let positionChange = 0;
  let reason = "";
  let level = "neutral";

  // 🔴 极端过热区
  if (latestVal >= 140) {
    action = "强减仓";
    positionChange = -60;
    reason = "情绪极度过热（>140），历史上属于加速末期，容易出现快速退潮";
    level = "extremeOverheat";
  }

  // 🟠 高危区
  else if (latestVal >= 120) {
    action = "减仓";
    positionChange = -40;
    reason = "情绪进入高位区（120-140），属于加速后期，需防退潮";
    level = "highRisk";
  }

  // 🟡 偏热区
  else if (latestVal >= 90) {
    action = "小幅减仓";
    positionChange = -20;
    reason = "情绪进入偏热区（90-120），赚钱效应扩散但风险开始累积";
    level = "overheat";
  }

  // 🟢 健康上涨区
  else if (latestVal >= 0) {
    action = "持仓/小幅加仓";
    positionChange = 10;
    reason = "情绪处于正常区间（0-90），市场结构健康，可参与趋势或轮动";
    level = "healthy";
  }

  // 🔵 冰点区
  else {
    action = "逐步加仓";
    positionChange = 30;
    reason = "情绪处于冰点（<0），容易出现反弹或修复行情";
    level = "cold";
  }

  // 5. 趋势修正（非常关键）
  let trendAdjustment = null;
  if (latestVal > 120 && slope < 0) {
    action = "强烈减仓";
    positionChange = -70;
    reason += "；且情绪开始走弱（高位拐头），属于明确退潮信号";
    trendAdjustment = "highLevelTurnDown";
  }

  if (latestVal > 90 && slope < -20) {
    action = "减仓";
    positionChange = Math.min(positionChange, -40);
    reason += "；短期情绪快速回落，需提前防守";
    trendAdjustment = "fastFallback";
  }

  // 6. 输出结构化结果
  return {
    latestMa3: latestVal,
    previousMa3: prevVal,
    slope,
    action,
    positionChange,
    level,
    trendAdjustment,
    reason,
  };
}

const formatDateStr = (dateStr) => {
  const str = String(dateStr);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
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
            activeItem.scrollIntoView({ behavior: 'auto', block: 'nearest' });
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
        {classification['支线']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label branch">支线</span>
            <div className="category-tags">
              {classification['支线'].map(name => (
                <Tag key={name} color="orange" className="block-tag-clickable" onClick={() => onBlockClick(name)}>{name}</Tag>
              ))}
            </div>
          </div>
        )}
        {classification['止跌企稳']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label stable">止跌企稳</span>
            <div className="category-tags">
              {classification['止跌企稳'].map(name => (
                <Tag key={name} color="blue" className="block-tag-clickable" onClick={() => onBlockClick(name)}>{name}</Tag>
              ))}
            </div>
          </div>
        )}
        {classification['掉队']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label lagging">掉队</span>
            <div className="category-tags">
              {classification['掉队'].map(name => (
                <Tag key={name} color="volcano" className="block-tag-clickable" onClick={() => onBlockClick(name)}>{name}</Tag>
              ))}
            </div>
          </div>
        )}
        {classification['弱势']?.length > 0 && (
          <div className="classify-category">
            <span className="category-label weak">弱势</span>
            <div className="category-tags">
              {classification['弱势'].map(name => (
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
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const techContainerRef = useRef(null);
  const techChartRef = useRef(null);

  // 首屏优先加载情绪数据，板块分类分析延后加载
  const fetchData = async () => {
    try {
      const emotionRes = await axios.get(`http://${local_ip}:3000/emotion_data`);
      setData(emotionRes.data.emotionData || []);
      setIndexKlineData(emotionRes.data.indexKlineData || null);
      setTechIndexData(emotionRes.data.techIndexData || []);
      setError(null);
    } catch (err) {
      console.error('Fetch emotion data failed:', err);
      setError('获取情绪数据失败，请检查后端服务是否正常运行');
    } finally {
      setLoading(false);
    }
    // 首屏数据就绪后，再加载板块分类分析（页面底部，非首屏）
    setClassifyLoading(true);
    try {
      const classifyRes = await axios.get(`http://${local_ip}:3000/classify_sector_blocks_daily`);
      setClassifyData(classifyRes.data || null);
    } catch (err) {
      console.error('Fetch classify data failed:', err);
    } finally {
      setClassifyLoading(false);
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
    if (!loading) {
      if (data.length > 0 && containerRef.current) {
        renderChart(data);
      }
      if (techIndexData.length > 0 && techContainerRef.current) {
        renderTechChart(techIndexData);
      }
    }
  }, [loading, data, techIndexData]);

  // 处理窗口缩放
  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
      if (techChartRef.current && techContainerRef.current) {
        techChartRef.current.applyOptions({ width: techContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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
      handleScroll: true,
      handleScale: true,
      crosshair: {
        mode: 0,
      },
    });
  };

  const renderTechChart = (techData) => {
    if (techChartRef.current) {
      techChartRef.current.remove();
    }

    const chart = createBaseChart(techContainerRef.current);
    techChartRef.current = chart;

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    techContainerRef.current.appendChild(tooltip);

    const lineSeries = chart.addLineSeries({
      color: '#722ed1',
      lineWidth: 3,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const chartData = techData.map(item => {
      const dateStr = String(item.date);
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      const formattedDate = `${year}-${month}-${day}`;
      return {
        time: formattedDate,
        value: parseFloat(item.changeSumResult) || 0,
      };
    }).sort((a, b) => a.time.localeCompare(b.time));

    lineSeries.setData(chartData);

    const ma3Data = chartData
      .map((item, index) => {
        if (index < 2) return null;
        const sum = chartData[index - 2].value + chartData[index - 1].value + item.value;
        return { time: item.time, value: sum / 3 };
      })
      .filter(Boolean);

    console.log('科技情绪原始数据:', JSON.stringify(chartData));
    console.log('科技情绪三日均线数据:', JSON.stringify(ma3Data));

    const ma3Series = chart.addLineSeries({
      color: '#1890ff',
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
        
        if (dataPoint) {
          tooltip.style.display = 'block';
          const { value } = dataPoint;
          const ma3Value = ma3Point?.value;
          
          tooltip.innerHTML = `
             <div class="tooltip-title">${dayjs(dateStr).format('YYYY-MM-DD')}</div>
             <div class="tooltip-item">
               <span class="label">科技情绪:</span>
               <span class="value ${value >= 0 ? 'up' : 'down'}">${value.toFixed(2)}</span>
             </div>
             ${ma3Value !== undefined && ma3Value !== null ? `
             <div class="tooltip-item">
               <span class="label">三日均线:</span>
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

    const chart = createBaseChart(containerRef.current);
    chartRef.current = chart;

    // 创建 Tooltip 元素
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    containerRef.current.appendChild(tooltip);

    const lineSeries = chart.addLineSeries({
      color: '#1890ff',
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

  const latestData = data.length > 0 ? data[data.length - 1] : null;
  
  const currentEmotion = latestData ? parseFloat(latestData.emotion) : 0;
  const currentUpRatio = latestData?.originData?.up_ratio;
  
  const latestTechData = techIndexData.length > 0 ? techIndexData[techIndexData.length - 1] : null;
  const currentTechEmotion = latestTechData ? parseFloat(latestTechData.changeSumResult) : 0;

  const suggestion = useEmotionSuggestion(techIndexData);

  const techAnalysisResult = (() => {
    const formattedData = techIndexData.map(item => {
      const dateStr = String(item.date);
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      return {
        time: `${year}-${month}-${day}`,
        value: parseFloat(item.changeSumResult) || 0,
      };
    }).sort((a, b) => a.time.localeCompare(b.time));
    return analyzeMarketEmotion(formattedData);
  })();

  const levelColorMap = {
    extremeOverheat: { bg: '#fff1f0', text: '#a8071a', border: '#ffa39e', label: '极端过热' },
    highRisk: { bg: '#fff2e8', text: '#ad2102', border: '#ffbb96', label: '高危' },
    overheat: { bg: '#fffbe6', text: '#ad6800', border: '#ffe58f', label: '偏热' },
    healthy: { bg: '#f6ffed', text: '#389e0d', border: '#b7eb8f', label: '健康' },
    cold: { bg: '#e6f7ff', text: '#096dd9', border: '#91d5ff', label: '冰点' },
    neutral: { bg: '#f5f5f5', text: '#595959', border: '#d9d9d9', label: '观望' },
  };

  const currentTechLevel = techAnalysisResult ? levelColorMap[techAnalysisResult.level] : null;

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
          <Card 
            title={<span><LineChartOutlined /> 科技板块情绪</span>} 
            bordered={false} 
            className="chart-card"
          >
            {loading ? (
              <div className="loading-container"><Spin tip="加载中..." /></div>
            ) : techIndexData.length > 0 ? (
              <>
                <div ref={techContainerRef} className="chart-container" />
                {techAnalysisResult && currentTechLevel && (
                  <div style={{
                    marginTop: '16px',
                    padding: '20px',
                    backgroundColor: currentTechLevel.bg,
                    border: `1px solid ${currentTechLevel.border}`,
                    borderRadius: '12px',
                    color: currentTechLevel.text,
                    lineHeight: '1.8',
                  }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      marginBottom: '12px',
                      fontSize: '16px',
                      fontWeight: 600,
                    }}>
                      <span>📊 情绪周期分析结果</span>
                      <span style={{
                        padding: '2px 10px',
                        borderRadius: '12px',
                        backgroundColor: currentTechLevel.text,
                        color: '#fff',
                        fontSize: '12px',
                      }}>
                        {currentTechLevel.label}
                      </span>
                    </div>

                    <Row gutter={[24, 8]}>
                      <Col span={8}>
                        <div style={{ fontSize: '13px', opacity: 0.85 }}>最新3日均线</div>
                        <div style={{ fontSize: '20px', fontWeight: 700 }}>
                          {techAnalysisResult.latestMa3.toFixed(2)}
                        </div>
                      </Col>
                      <Col span={8}>
                        <div style={{ fontSize: '13px', opacity: 0.85 }}>趋势变化</div>
                        <div style={{
                          fontSize: '20px',
                          fontWeight: 700,
                          color: techAnalysisResult.slope > 0 ? '#cf1322' : techAnalysisResult.slope < 0 ? '#389e0d' : 'inherit',
                        }}>
                          {techAnalysisResult.slope > 0 ? '+' : ''}{techAnalysisResult.slope.toFixed(2)}
                        </div>
                      </Col>
                      <Col span={8}>
                        <div style={{ fontSize: '13px', opacity: 0.85 }}>仓位调整</div>
                        <div style={{
                          fontSize: '20px',
                          fontWeight: 700,
                          color: techAnalysisResult.positionChange > 0 ? '#cf1322' : techAnalysisResult.positionChange < 0 ? '#389e0d' : 'inherit',
                        }}>
                          {techAnalysisResult.positionChange > 0 ? '+' : ''}{techAnalysisResult.positionChange}%
                        </div>
                      </Col>
                    </Row>

                    <div style={{
                      marginTop: '12px',
                      padding: '12px',
                      backgroundColor: 'rgba(255, 255, 255, 0.6)',
                      borderRadius: '8px',
                      fontSize: '14px',
                    }}>
                      <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                        👉 操作建议：{techAnalysisResult.action}
                      </div>
                      <div style={{ fontSize: '13px', opacity: 0.9 }}>
                        📌 {techAnalysisResult.reason}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <Alert message="暂无科技板块情绪数据" type="info" showIcon />
            )}
          </Card>
        </Col>
      </Row>

      {/* 板块分类分析结果 */}
      <div className="classify-section">
        <Divider orientation="left"><AppstoreOutlined /> 板块分类分析</Divider>
        {classifyLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
            <Spin tip="加载板块分类数据..." />
          </div>
        ) : classifyData && classifyData.dailyResults && classifyData.dailyResults.length > 0 ? (
          <ClassifyViewer
            dailyResults={classifyData.dailyResults}
            initialDate={classifyData.dailyResults[0]?.date}
            onBlockClick={(blockName) => navigate(`/block?blockName=${encodeURIComponent(blockName)}`)}
          />
        ) : null}
      </div>
    </div>
  );
};

export default Sentiment;
