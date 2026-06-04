import React, { useState, useEffect } from 'react';
import { Modal, Typography, Space, Tag, Spin, Empty } from 'antd';
import { AreaChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockTimeLine from '../StockTimeLine';

const { Text } = Typography;

const StockTimeLineModal = ({ 
  visible, 
  onCancel, 
  stockInfo = {}, 
  code 
}) => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [preClose, setPreClose] = useState(null);

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
      // 获取真实分时数据
      const response = await axios.get(`http://${local_ip}:3000/stock_tlline_data`, {
        params: { code }
      });
      
      if (response.data && response.data.length > 0) {
        // 后端返回的数据项应包含 time, last_px, change 等字段
        setData(response.data);
      }
    } catch (error) {
      console.error('Fetch stock timeline data failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <AreaChartOutlined style={{ color: '#1890ff' }} />
          <span>个股分时走势</span>
          {stockInfo.name && <Text strong>{stockInfo.name}</Text>}
          {stockInfo.code && <Text type="secondary">({stockInfo.code})</Text>}
          {stockInfo.change !== undefined && (
            <Tag color={parseFloat(stockInfo.change) > 0 ? 'error' : 'success'} borderless>
              {stockInfo.change > 0 ? '+' : ''}{stockInfo.change}%
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
      <div className="timeline-modal-content" style={{ width: '100%' }}>
        {loading ? (
          <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin tip="正在加载分时数据..." size="large" />
          </div>
        ) : data.length > 0 ? (
          <StockTimeLine data={data} height={500} preClose={preClose} />
        ) : (
          <Empty description="暂无分时数据" />
        )}
      </div>
    </Modal>
  );
};

export default StockTimeLineModal;
