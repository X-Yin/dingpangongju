import { Card, Row, Col, Empty, Typography } from 'antd';
import { StockOutlined } from '@ant-design/icons';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const StockAlertCard = ({ stockUpAlerts, stockDownAlerts, waveList, onStockClick, bodyHeight = '200px', itemsPerRow = 1, themeColor }) => {
    const gridCols = itemsPerRow === 2 ? '1fr 1fr' : '1fr';

    const renderStockWaveItem = (item, index, isUp) => (
        <div
            key={index}
            className={`alert-item ${isUp ? 'up' : 'down'}`}
            onClick={() => onStockClick(item)}
            style={{ cursor: 'pointer', ...borderStyle(themeColor) }}
        >
            <div className="alert-item-main">
                <Text strong className="alert-item-name" style={titleStyle(themeColor)}>{item.name}</Text>
                <Text type="secondary" style={{ fontSize: '11px' }}>
                    {item.change_diff}
                </Text>
                <span className={`alert-item-change ${isUp ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                    {item.change}
                </span>
            </div>
        </div>
    );

    return (
        <Card
            title={
                <div className="all-stock-card-title">
                    <div className="all-stock-card-title-icon" style={{ background: 'linear-gradient(135deg, rgba(245, 34, 45, 0.18), rgba(250, 173, 20, 0.12)), rgba(255, 255, 255, 0.65)' }}>
                        <StockOutlined />
                    </div>
                    <div className="all-stock-card-title-content">
                        <span>个股异动监控</span>
                        <Text className="all-stock-card-title-subtext">Stock Alert Monitor</Text>
                    </div>
                </div>
            }
            className="monitor-card all-stock-card"
            variant="borderless"
            bodyStyle={{ height: bodyHeight, overflowY: 'auto', padding: '12px 14px' }}
            style={{ height: 'auto' }}
            extra={
                <div className="all-stock-card-extra">
                    <span className="all-stock-extra-dot" style={{ boxShadow: '0 0 10px rgba(245, 34, 45, 0.8)' }} />
                    <Text>涨 {stockUpAlerts.length}</Text>
                    <Text style={{ color: 'rgba(71, 85, 105, 0.5)', margin: '0 2px' }}>/</Text>
                    <Text>跌 {stockDownAlerts.length}</Text>
                </div>
            }
        >
            {waveList.length > 0 ? (
                <Row gutter={[8, 8]}>
                    <Col span={12}>
                        <div style={{ marginBottom: 6 }}>
                            <Text strong style={{ fontSize: '11px' }}>上涨</Text>
                        </div>
                        {stockUpAlerts.length > 0 ? (
                            <div className="alert-items-grid" style={{ gridTemplateColumns: gridCols }}>
                                {stockUpAlerts.map((item, index) => renderStockWaveItem(item, index, true))}
                            </div>
                        ) : (
                            <Empty description="暂无" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        )}
                    </Col>
                    <Col span={12}>
                        <div style={{ marginBottom: 6 }}>
                            <Text strong style={{ fontSize: '11px' }}>下跌</Text>
                        </div>
                        {stockDownAlerts.length > 0 ? (
                            <div className="alert-items-grid" style={{ gridTemplateColumns: gridCols }}>
                                {stockDownAlerts.map((item, index) => renderStockWaveItem(item, index, false))}
                            </div>
                        ) : (
                            <Empty description="暂无" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        )}
                    </Col>
                </Row>
            ) : (
                <Empty description="暂无个股异动数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
        </Card>
    );
};

export default StockAlertCard;
