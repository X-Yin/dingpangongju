import { Modal, Tabs, List, Empty, Tag, Typography, Space, Divider, Card, Row, Col } from 'antd';
import { HistoryOutlined, ClockCircleOutlined } from '@ant-design/icons';
import './index.scss';

const { Text } = Typography;
const { TabPane } = Tabs;

const HistoryModal = ({ open, onCancel, history, jisuYidongUpList, jisuYidongDownList, onStockClick, themeColor }) => (
    <Modal
        title={<span><HistoryOutlined /> 异动历史记录汇总</span>}
        open={open}
        onCancel={onCancel}
        footer={null}
        width={1000}
        className="history-modal"
    >
        <Tabs defaultActiveKey="1" style={{ marginTop: -16 }}>
            <TabPane tab="最新异动" key="1">
                <List
                    itemLayout="horizontal"
                    dataSource={history}
                    locale={{ emptyText: <Empty description="今日暂无历史异动记录" /> }}
                    renderItem={(item) => (
                        <List.Item
                            className={`history-item ${item.type}`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => onStockClick({ name: item.name, code: item.code, change: item.changeValue || 0 })}
                        >
                            <List.Item.Meta
                                avatar={
                                    <div className={`history-avatar ${item.type}`}>
                                        {item.type === 'up' ? '🚀' : '📉'}
                                    </div>
                                }
                                title={
                                    <div className="history-title">
                                        <Text strong>{item.name}</Text>
                                        <Tag color={item.type === 'up' ? 'error' : 'success'} borderless className="history-tag">
                                            {item.label}
                                        </Tag>
                                    </div>
                                }
                                description={
                                    <div className="history-desc">
                                        <Space split={<Divider type="vertical" />} wrap>
                                            <Text type="secondary"><ClockCircleOutlined /> {item.time}</Text>
                                            <Text strong>
                                                异动幅度: {item.changeDiff}
                                            </Text>
                                        </Space>
                                    </div>
                                }
                            />
                        </List.Item>
                    )}
                />
            </TabPane>
            <TabPane tab="急速异动排名" key="2">
                <Row gutter={[16, 16]}>
                    <Col span={12}>
                        <Card title="📈 急速拉升榜" size="small" headStyle={{ backgroundColor: '#f6ffed', borderBottom: '1px solid #b7eb8f' }}>
                            {jisuYidongUpList.length > 0 ? (
                                <List
                                    itemLayout="horizontal"
                                    dataSource={jisuYidongUpList}
                                    renderItem={(item, index) => (
                                        <List.Item onClick={() => onStockClick({ name: item.name, code: item.code, change: item.change })}
                                            style={{ cursor: 'pointer' }}>
                                            <List.Item.Meta
                                                avatar={<Text type="secondary">{index + 1}.</Text>}
                                                title={
                                                    <Space>
                                                        <Text strong>{item.stockName} ({item.code?.replace('sh', '').replace('sz', '')})</Text>
                                                        <Tag color="error" bordered={false}>{item.change}%</Tag>
                                                    </Space>
                                                }
                                                description={
                                                    <Space>
                                                        <Text type="secondary">上涨次数: {item.up}</Text>
                                                        <Text type="secondary">下跌次数: {item.down}</Text>
                                                    </Space>
                                                }
                                            />
                                        </List.Item>
                                    )}
                                />
                            ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无急速拉升数据" />
                            )}
                        </Card>
                    </Col>
                    <Col span={12}>
                        <Card title="📉 急速下跌榜" size="small" headStyle={{ backgroundColor: 'rgba(255, 59, 48, 0.08)', borderBottom: '1px solid rgba(255, 59, 48, 0.3)' }}>
                            {jisuYidongDownList.length > 0 ? (
                                <List
                                    itemLayout="horizontal"
                                    dataSource={jisuYidongDownList}
                                    renderItem={(item, index) => (
                                        <List.Item onClick={() => onStockClick({ name: item.name, code: item.code, change: item.change })}
                                            style={{ cursor: 'pointer' }}>
                                            <List.Item.Meta
                                                avatar={<Text type="secondary">{index + 1}.</Text>}
                                                title={
                                                    <Space>
                                                        <Text strong>{item.stockName} ({item.code?.replace('sh', '').replace('sz', '')})</Text>
                                                        <Tag color="success" bordered={false}>{item.change}%</Tag>
                                                    </Space>
                                                }
                                                description={
                                                    <Space>
                                                        <Text type="secondary">上涨次数: {item.up}</Text>
                                                        <Text type="secondary">下跌次数: {item.down}</Text>
                                                    </Space>
                                                }
                                            />
                                        </List.Item>
                                    )}
                                />
                            ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无急速下跌数据" />
                            )}
                        </Card>
                    </Col>
                </Row>
            </TabPane>
        </Tabs>
    </Modal>
);

export default HistoryModal;
