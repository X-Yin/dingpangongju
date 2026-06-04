import React, { useState, useEffect } from 'react';
import { Modal, Typography, Space, Tag, Spin, Empty, Segmented, Button } from 'antd';
import { LineChartOutlined, BarChartOutlined, AreaChartOutlined, HistoryOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockKLine from '../StockKLine';
import StockTimeLine from '../StockTimeLine';
import StockTimeLineModal from '../StockTimeLineModal';

const { Text } = Typography;

const StockKLineModal = ({ 
  visible, 
  onCancel, 
  title = '个股行情图表', 
  stockInfo = {}, 
  code 
}) => {
  const [kData, setKData] = useState([]);
  const [tData, setTData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [chartType, setChartType] = useState('kline'); // 默认展示 K 线
  const [timelineVisible, setTimelineVisible] = useState(false);

  useEffect(() => {
    if (visible && code) {
      fetchStockData();
    } else if (!visible) {
      setKData([]);
      setTData([]);
    }
  }, [visible, code]);

  const fetchStockData = async () => {
    setLoading(true);
    try {
      // 1. 获取 K 线数据
      const kResponse = await axios.get(`http://${local_ip}:3000/stock_data`, {
        params: { code }
      });
      setKData(kResponse.data || []);

      // 2. 获取真实分时数据
      const tResponse = await axios.get(`http://${local_ip}:3000/stock_tline_data`, {
        params: { code }
      });
      // 根据后端返回的数据结构，直接使用数组
      setTData(tResponse.data?.line || []);
    } catch (error) {
      console.error('Fetch stock data failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Modal
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '95%' }}>
            <Space size="middle">
              <Space>
                <LineChartOutlined style={{ color: '#1890ff' }} />
                {stockInfo.name && <Text strong>{stockInfo.name}</Text>}
                {stockInfo.code && <Text type="secondary">({stockInfo.code})</Text>}
                {stockInfo.change !== undefined && (
                  <Tag color={parseFloat(stockInfo.change) > 0 ? 'error' : 'success'} borderless>
                    {stockInfo.change > 0 ? '+' : ''}{stockInfo.change}%
                  </Tag>
                )}
              </Space>
              <Button 
                type="primary" 
                size="small" 
                icon={<AreaChartOutlined />}
                onClick={() => setTimelineVisible(true)}
                style={{ borderRadius: '4px' }}
              >
                查看分时
              </Button>
            </Space>
            <Segmented
              options={[
                { label: 'K线图', value: 'kline', icon: <BarChartOutlined /> },
                { label: '分时图', value: 'timeline', icon: <AreaChartOutlined /> },
              ]}
              value={chartType}
              onChange={setChartType}
            />
          </div>
        }
        open={visible}
        onCancel={onCancel}
        footer={null}
        width={1000}
        centered
        destroyOnClose
        bodyStyle={{ padding: '24px', minHeight: '500px' }}
      >
        <div className="stock-chart-modal-content" style={{ width: '100%' }}>
          {loading ? (
            <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip="正在加载行情数据..." size="large" />
            </div>
          ) : (
            <>
              {chartType === 'timeline' ? (
                tData.length > 0 ? (
                  <StockTimeLine data={tData} height={500} preClose={kData[kData.length - 2]?.close} />
                ) : (
                  <Empty description="暂无分时数据" />
                )
              ) : (
                kData.length > 0 ? (
                  <StockKLine data={kData} height={500} />
                ) : (
                  <Empty description="暂无 K 线数据" />
                )
              )}
            </>
          )}
        </div>
      </Modal>

      <StockTimeLineModal 
        visible={timelineVisible}
        onCancel={() => setTimelineVisible(false)}
        code={code}
        stockInfo={stockInfo}
      />
    </>
  );
};

export default StockKLineModal;
