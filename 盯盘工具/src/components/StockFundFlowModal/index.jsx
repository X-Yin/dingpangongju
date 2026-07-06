import { useState, useEffect, useRef } from 'react';
import { Modal, Typography, Space, Tag, Spin, Empty } from 'antd';
import { LineChartOutlined } from '@ant-design/icons';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const { Text } = Typography;

const formatTimeToTimestamp = (timeStr) => {
  const padded = String(timeStr).padStart(6, '0');
  const hh = padded.substring(0, 2);
  const mm = padded.substring(2, 4);
  const today = dayjs();
  return today.hour(Number(hh)).minute(Number(mm)).second(0).unix();
};

const StockFundFlowChart = ({ data = [], height = 450 }) => {
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#333',
        fontSize: 12,
      },
      width: containerRef.current.clientWidth || 800,
      height: height,
      grid: {
        vertLines: { color: '#f0f0f0', style: LineStyle.Dotted },
        horzLines: { color: '#f0f0f0', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('HH:mm');
          }
          return time;
        },
      },
      localization: {
        timeFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('HH:mm');
          }
          return time;
        },
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
      },
      crosshair: {
        mode: 0,
        vertLine: { labelBackgroundColor: '#1890ff' },
        horzLine: { labelBackgroundColor: '#1890ff' },
      },
    });

    const areaSeries = chart.addAreaSeries({
      lineColor: '#1890ff',
      topColor: 'rgba(24, 144, 255, 0.25)',
      bottomColor: 'rgba(24, 144, 255, 0.02)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const changeSeries = chart.addLineSeries({
      color: '#ff4d4f',
      lineWidth: 2,
      priceScaleId: 'left', // 放在左侧
      priceFormat: {
        type: 'custom',
        formatter: (price) => `${price.toFixed(2)}%`,
      },
    });

    // 左侧坐标轴设置（用于涨幅，隐藏刻度但保留数据）
    chart.priceScale('left').applyOptions({
      visible: false, // 隐藏左侧刻度
    });

    // 零轴参考线
    areaSeries.createPriceLine({
      price: 0,
      color: '#999',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0',
    });

    if (data.length > 0) {
      const fundData = data
        .map((item) => ({
          time: formatTimeToTimestamp(item.time),
          value: item.mainFund,
        }))
        .sort((a, b) => a.time - b.time);
      areaSeries.setData(fundData);

      const changeData = data
        .filter(item => item.change !== undefined && item.change !== null)
        .map((item) => ({
          time: formatTimeToTimestamp(item.time),
          value: item.change,
        }))
        .sort((a, b) => a.time - b.time);
      changeSeries.setData(changeData);

      chart.timeScale().fitContent();
    }

    const tooltip = tooltipRef.current;
    chart.subscribeCrosshairMove((param) => {
      if (
        param.point === undefined ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > height
      ) {
        tooltip.style.display = 'none';
      } else {
        tooltip.style.display = 'block'; // 确保显示 tooltip
        const priceData = param.seriesData.get(areaSeries);
        const fundValue = (priceData && typeof priceData.value === 'number') ? priceData.value : 0;
        const fundColor = fundValue >= 0 ? '#f5222d' : '#52c41a';

        const changePriceData = param.seriesData.get(changeSeries);
        const changeValue = (changePriceData && typeof changePriceData.value === 'number') ? changePriceData.value : null;
        const changeColor = changeValue === null ? '#999' : (changeValue >= 0 ? '#f5222d' : '#52c41a');

        const timeStr = dayjs.unix(param.time).format('HH:mm');
        tooltip.innerHTML = `
          <div class="fund-flow-tooltip-header">
            <span class="time">${timeStr}</span>
          </div>
          <div class="fund-flow-tooltip-body">
            <div class="item">
              <span class="label">主力资金净流</span>
              <span class="value" style="color: ${fundColor}">${fundValue >= 0 ? '+' : ''}${fundValue.toFixed(2)}亿</span>
            </div>
            <div class="item">
              <span class="label">涨幅</span>
              <span class="value" style="color: ${changeColor}">${changeValue === null ? '--' : (changeValue >= 0 ? '+' : '') + changeValue.toFixed(2) + '%'}</span>
            </div>
          </div>
        `;
        const tooltipWidth = 160;
        const x = param.point.x;
        if (x > containerRef.current.clientWidth - tooltipWidth - 20) {
          tooltip.style.left = 'auto';
          tooltip.style.right = '20px';
        } else {
          tooltip.style.right = 'auto';
          tooltip.style.left = `${x + 20}px`;
        }
      }
    });

    const handleResize = () => {
      chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [data, height]);

  return (
    <div className="stock-fund-flow-container" style={{ height }}>
      <div ref={containerRef} className="chart-container" />
      <div ref={tooltipRef} className="fund-flow-tooltip" />
    </div>
  );
};

const StockFundFlowModal = ({ visible, onCancel, stockInfo = {}, code }) => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible && code) {
      fetchData();
    } else if (!visible) {
      setData([]);
    }
  }, [visible, code]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`http://${local_ip}:3000/stock_position_fund_flow`, {
        params: { code },
      });
      setData(response.data || []);
    } catch (error) {
      console.error('Fetch stock fund flow data failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const latestItem = data.length > 0 ? data[data.length - 1] : null;
  const latestValue = (latestItem && typeof latestItem.mainFund === 'number') ? latestItem.mainFund : null;
  const latestChange = (latestItem && typeof latestItem.change === 'number') ? latestItem.change : null;

  return (
    <Modal
      title={
        <Space>
          <LineChartOutlined style={{ color: '#1890ff' }} />
          <span>主力资金净流入</span>
          {stockInfo.name && <Text strong>{stockInfo.name}</Text>}
          {stockInfo.code && <Text type="secondary">({stockInfo.code})</Text>}
          {latestValue !== null && (
            <Tag color={latestValue > 0 ? 'error' : latestValue < 0 ? 'success' : 'default'} borderless>
              资金: {latestValue > 0 ? '+' : ''}{latestValue.toFixed(2)}亿
            </Tag>
          )}
          {latestChange !== null && (
            <Tag color={latestChange > 0 ? 'error' : latestChange < 0 ? 'success' : 'default'} borderless>
              涨幅: {latestChange > 0 ? '+' : ''}{latestChange.toFixed(2)}%
            </Tag>
          )}
        </Space>
      }
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={1000}
      centered
      destroyOnClose
      bodyStyle={{ padding: '24px', minHeight: '500px' }}
    >
      <div className="fund-flow-modal-content" style={{ width: '100%' }}>
        {loading ? (
          <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin tip="正在加载资金流向数据..." size="large" />
          </div>
        ) : data.length > 0 ? (
          <StockFundFlowChart data={data} height={500} />
        ) : (
          <Empty description="暂无资金流向数据" />
        )}
      </div>
    </Modal>
  );
};

export default StockFundFlowModal;
