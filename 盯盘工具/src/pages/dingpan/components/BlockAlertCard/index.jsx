import { Card, Row, Col, Empty, Typography } from 'antd';
import { AlertOutlined } from '@ant-design/icons';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const BlockAlertCard = ({ blockAlerts, blockUpAlerts, blockDownAlerts, onBlockClick, bodyHeight = '200px', themeColor }) => {
    const renderBlockAlertItem = (item, index, isUp) => (
        <div
            key={index}
            className={`alert-item ${isUp ? 'up' : 'down'}`}
            onClick={() => onBlockClick(item.blockName)}
            style={{ cursor: 'pointer', ...borderStyle(themeColor) }}
        >
            <div className="alert-item-main">
                <Text strong className="alert-item-name" style={titleStyle(themeColor)}>{item.blockName}</Text>
                <span className={`alert-item-change ${isUp ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                    {item.changeDiff > 0 ? '+' : ''}{item.changeDiff.toFixed(2)}%
                </span>
            </div>
        </div>
    );

    return (
        <Card
            title={
                <div className="all-stock-card-title">
                    <div className="all-stock-card-title-icon" style={{ background: 'linear-gradient(135deg, rgba(250, 173, 20, 0.18), rgba(245, 34, 45, 0.12)), rgba(255, 255, 255, 0.65)' }}>
                        <AlertOutlined />
                    </div>
                    <div className="all-stock-card-title-content">
                        <span>板块异动监控</span>
                        <Text className="all-stock-card-title-subtext">Block Alert Monitor</Text>
                    </div>
                </div>
            }
            className="monitor-card all-stock-card"
            variant="borderless"
            bodyStyle={{ height: bodyHeight, overflowY: 'auto', padding: '12px 14px' }}
            style={{ height: 'auto' }}
            extra={
                <div className="all-stock-card-extra">
                    <span className="all-stock-extra-dot" style={{ boxShadow: '0 0 10px rgba(250, 173, 20, 0.8)' }} />
                    <Text>涨 {blockUpAlerts.length}</Text>
                    <Text style={{ color: 'rgba(71, 85, 105, 0.5)', margin: '0 2px' }}>/</Text>
                    <Text>跌 {blockDownAlerts.length}</Text>
                </div>
            }
        >
            {blockAlerts.length > 0 ? (
                <Row gutter={[8, 8]}>
                    <Col span={12}>
                        <div style={{ marginBottom: 6 }}>
                            <Text strong style={{ fontSize: '11px' }}>上涨</Text>
                        </div>
                        {blockUpAlerts.length > 0 ? (
                            <div className="alert-items-grid" style={{ gridTemplateColumns: '1fr' }}>
                                {blockUpAlerts.map((item, index) => renderBlockAlertItem(item, index, true))}
                            </div>
                        ) : (
                            <Empty description="暂无" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        )}
                    </Col>
                    <Col span={12}>
                        <div style={{ marginBottom: 6 }}>
                            <Text strong style={{ fontSize: '11px' }}>下跌</Text>
                        </div>
                        {blockDownAlerts.length > 0 ? (
                            <div className="alert-items-grid" style={{ gridTemplateColumns: '1fr' }}>
                                {blockDownAlerts.map((item, index) => renderBlockAlertItem(item, index, false))}
                            </div>
                        ) : (
                            <Empty description="暂无" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        )}
                    </Col>
                </Row>
            ) : (
                <Empty description="暂无板块异动数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
        </Card>
    );
};

export default BlockAlertCard;
