import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { Typography, Card, Collapse, Row, Col, Tag, Spin, Empty, Space, Button, Divider } from 'antd';
import { AppstoreOutlined, CaretRightOutlined, ClockCircleOutlined, MenuUnfoldOutlined, MenuFoldOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
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
  const [selectedStock, setSelectedStock] = useState(null);
  const isFirstLoad = useRef(true); // 记录是否是初次加载

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/block`);
      setBlocks(response.data);
      setLastUpdated(dayjs().format('HH:mm:ss'));
      
      // 处理自动定位逻辑
      const params = new URLSearchParams(location.search);
      const targetBlock = params.get('blockName');

      if (isFirstLoad.current && response.data.length > 0) {
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
          setExpandedKeys(response.data.map(b => b.blockName));
        }
        isFirstLoad.current = false;
      }
      
      setLoading(false);
    } catch (error) {
      console.error('Fetch block data failed:', error);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 10000); // 10秒刷新一次
    return () => clearInterval(timer);
  }, []);

  // 切换单个展开状态，增加 e.stopPropagation() 防止意外冒泡
  const toggleExpand = (e, blockName) => {
    if (e) {
      e.stopPropagation();
    }
    setExpandedKeys(prev => 
      prev.includes(blockName) 
        ? prev.filter(k => k !== blockName) 
        : [...prev, blockName]
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
            icon={isAllExpanded ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            onClick={isAllExpanded ? collapseAll : expandAll}
            className="toggle-all-btn"
          >
            {isAllExpanded ? '全部收起' : '全部展开'}
          </Button>
        </div>
      </div>

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
    </div>
  );
};

export default Block;
