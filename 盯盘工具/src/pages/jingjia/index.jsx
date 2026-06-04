import { useEffect, useState, useRef } from "react";
import axios from 'axios';
import { Card, Typography, Empty, Spin, Row, Col, Space, Button, Divider } from 'antd';
import { ThunderboltOutlined, RiseOutlined, ArrowUpOutlined, ArrowDownOutlined, ClockCircleOutlined, ReloadOutlined, AreaChartOutlined, CaretUpOutlined, CaretDownOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import StockTimeLine from '../../components/StockTimeLine';
import './index.scss';

const { Title, Text } = Typography;

const JingJiaQiangChou = () => {
    const [data, setData] = useState([]);
    const [tlineDataMap, setTlineDataMap] = useState({}); // 存储每只股票的分时数据
    const [loading, setLoading] = useState(true);
    const [tlineLoading, setTlineLoading] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [klineModalVisible, setKlineModalVisible] = useState(false);
    const [selectedStock, setSelectedStock] = useState(null);
    const prevDataRef = useRef({}); // 缓存上一次的涨幅数据
    const timerRef = useRef(null);

    const fetchData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/jingjia_data`);
            const jingjiaList = response.data || [];
            
            // 为每项注入上一次的涨幅数据
            const dataWithPrev = jingjiaList.map(item => ({
                ...item,
                prevChange: prevDataRef.current[item.code] !== undefined ? prevDataRef.current[item.code] : item.change
            }));

            // 更新缓存
            const nextPrevMap = {};
            jingjiaList.forEach(item => {
                nextPrevMap[item.code] = item.change;
            });
            prevDataRef.current = nextPrevMap;

            setData(dataWithPrev);
            setLastUpdated(dayjs().format('HH:mm:ss'));
            
            // 拿到竞价数据后，立即请求全部分时图数据
            if (jingjiaList.length > 0) {
                fetchAllTlineData(jingjiaList);
            }
        } catch (error) {
            console.error('Fetch jingjia data failed:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchAllTlineData = async (list) => {
        setTlineLoading(true);
        const newTlineMap = {};
        
        try {
            // 批量请求所有股票的分时数据
            const promises = list.map(stock => 
                axios.get(`http://${local_ip}:3000/stock_tline_data`, {
                    params: { code: stock.code }
                }).then(res => {
                    newTlineMap[stock.code] = res.data?.line || [];
                }).catch(err => {
                    console.error(`Fetch tline for ${stock.code} failed:`, err);
                    newTlineMap[stock.code] = [];
                })
            );

            await Promise.all(promises);
            setTlineDataMap(newTlineMap);
        } catch (error) {
            console.error('Fetch all tline data failed:', error);
        } finally {
            setTlineLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        // 开启 5s 定时器
        timerRef.current = setInterval(fetchData, 5000);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, []);

    const showKLine = (stock) => {
        setSelectedStock(stock);
        setKlineModalVisible(true);
    };

    return (
        <div className="jingjia-page">
            <div className="page-header" style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <Title level={3} style={{ margin: 0 }}>
                        <ThunderboltOutlined style={{ color: '#ff4d4f', marginRight: 8 }} />
                        竞价抢筹实时监控
                    </Title>
                    {lastUpdated && (
                        <Text type="secondary">
                            <ClockCircleOutlined /> 最后更新: {lastUpdated}
                        </Text>
                    )}
                </div>
                <Space>
                    <Button icon={<ReloadOutlined />} onClick={fetchData}>手动刷新</Button>
                </Space>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
                    <Spin size="large" tip="正在加载竞价数据..." />
                </div>
            ) : (
                <>

                    {data.length > 0 ? (
                        <Row gutter={[16, 16]} className="tline-grid">
                            {data.map((item, index) => {
                                const isUp = item.change >= 0;
                                const color = isUp ? '#f5222d' : '#52c41a';
                                const tData = tlineDataMap[item.code] || [];

                                return (
                                    <Col key={index} xs={24} sm={12} md={8} lg={6}>
                                        <Card 
                                            hoverable
                                            className={`tline-card ${item.change > item.prevChange ? 'trend-up' : item.change < item.prevChange ? 'trend-down' : ''}`}
                                            variant="borderless"
                                            bodyStyle={{ padding: '12px' }}
                                            onClick={() => showKLine({ name: item.stockName, code: item.code, change: item.change })}
                                        >
                                            <div className="tline-card-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                                <div className="stock-info">
                                                    <Text strong style={{ fontSize: '14px' }}>{item.stockName}</Text>
                                                    <Text type="secondary" style={{ fontSize: '11px', marginLeft: 4 }}>{item.code?.replace('sh', '').replace('sz', '')}</Text>
                                                </div>
                                                <div className="stock-values" style={{ textAlign: 'right' }}>
                                                    <Space size={4} style={{ fontSize: '12px' }}>
                                                        <Text type="secondary" style={{ fontSize: '11px' }}>{item.prevChange?.toFixed(2)}%</Text>
                                                        <Text type="secondary">→</Text>
                                                        <Text strong style={{ color: color, fontSize: '14px' }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
                                                        <div style={{ marginLeft: 2, display: 'inline-flex', alignItems: 'center' }}>
                                                            {item.change > item.prevChange && <CaretUpOutlined style={{ color: '#f5222d', fontSize: '12px' }} />}
                                                            {item.change < item.prevChange && <CaretDownOutlined style={{ color: '#52c41a', fontSize: '12px' }} />}
                                                        </div>
                                                    </Space>
                                                </div>
                                            </div>
                                            
                                            <div className="tline-chart-container" style={{ height: '200px', background: '#f9f9f9', borderRadius: '4px', overflow: 'hidden' }}>
                                                {tData.length > 0 ? (
                                                    <StockTimeLine data={tData} height={200} />
                                                ) : (
                                                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                        <Spin size="small" />
                                                    </div>
                                                )}
                                            </div>

                                            {item.desc && (
                                                <div className="item-desc" style={{ marginTop: 8, fontSize: '11px', borderTop: '1px dashed #f0f0f0', paddingTop: 4 }}>
                                                    <Text type="secondary" italic ellipsis={{ tooltip: item.desc }}>{item.desc}</Text>
                                                </div>
                                            )}
                                        </Card>
                                    </Col>
                                );
                            })}
                        </Row>
                    ) : (
                        <Card variant="borderless">
                            <Empty description="当前暂无符合竞价抢筹标准的个股" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        </Card>
                    )}
                </>
            )}

            <StockKLineModal
                visible={klineModalVisible}
                onCancel={() => setKlineModalVisible(false)}
                code={selectedStock?.code}
                stockInfo={{
                    name: selectedStock?.name,
                    change: selectedStock?.change
                }}
            />
        </div>
    );
};

export default JingJiaQiangChou;
