import { useState, useEffect, useRef, useMemo } from 'react';
import { createChart, ColorType } from 'lightweight-charts';
import { Card, Typography, Spin, Button, Tag, Space, Empty } from 'antd';
import { ReloadOutlined, BarChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';

const { Title, Text } = Typography;

const PremiumDiagnosisTab = () => {
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [indexType, setIndexType] = useState('chuangyeban');
    const [selectedDate, setSelectedDate] = useState(null);
    const [selectedData, setSelectedData] = useState(null);
    const [klineModalOpen, setKlineModalOpen] = useState(false);
    const [selectedStock, setSelectedStock] = useState(null);
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const dataRef = useRef(null);

    const fetchPremiumData = async (forceRefresh = false) => {
        try {
            setLoading(true);
            setError('');
            const query = forceRefresh ? '?forceRefresh=1' : '';
            const res = await axios.get(`http://${local_ip}:3000/premium_diagnosis${query}`);
            if (res.data?.success) {
                setData(res.data.data || null);
                return;
            }
            setError(res.data?.message || '溢价诊断加载失败');
        } catch (error) {
            console.error('获取溢价诊断失败:', error);
            setError(error?.response?.data?.message || error.message || '溢价诊断加载失败');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPremiumData();
    }, []);

    useEffect(() => {
        dataRef.current = data;
        if (data?.premiumHistory && data.premiumHistory.length > 0) {
            const sortedHistory = [...data.premiumHistory].sort((a, b) => 
                String(b.date).localeCompare(String(a.date))
            );
            const latestItem = sortedHistory[0];
            const dateStr = String(latestItem.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
            setSelectedDate(dateStr);
            setSelectedData(latestItem);
        }
    }, [data]);

    const indexKlineData = useMemo(() => {
        if (!data?.indexKline) return [];
        const kline = indexType === 'chuangyeban' ? data.indexKline.chuangyeban : data.indexKline.kechuangban;
        return kline.map(item => ({
            time: String(item.trade_date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
            open: parseFloat(item.open_px),
            high: parseFloat(item.high_px),
            low: parseFloat(item.low_px),
            close: parseFloat(item.close_px),
            volume: parseFloat(item.business_amount) || 0,
            change: parseFloat(item.change || 0),
            trade_date: item.trade_date
        })).sort((a, b) => a.time.localeCompare(b.time));
    }, [data, indexType]);

    const premiumLineData = useMemo(() => {
        if (!data?.premiumHistory) return [];
        return data.premiumHistory.map(item => ({
            time: String(item.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
            value: item.premiumRate || 0
        })).sort((a, b) => a.time.localeCompare(b.time));
    }, [data]);

    useEffect(() => {
        if (!containerRef.current || indexKlineData.length === 0) return;

        let isDisposed = false;

        if (chartRef.current) {
            try {
                chartRef.current.remove();
            } catch (e) {
            }
            chartRef.current = null;
        }

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: '#ffffff' },
                textColor: '#333',
            },
            width: containerRef.current.clientWidth,
            height: 300,
            localization: {
                locale: 'zh-CN',
                timeFormatter: (time) => time,
            },
            timeScale: {
                borderColor: '#D1D4DC',
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time) => {
                    if (typeof time === 'string') {
                        const parts = time.split('-');
                        return `${parts[1]}/${parts[2]}`;
                    }
                    if (time && typeof time === 'object') {
                        return `${time.month}/${time.day}`;
                    }
                    return time;
                },
            },
            grid: {
                vertLines: { color: '#f0f0f0' },
                horzLines: { color: '#f0f0f0' },
            },
            handleScroll: false,
            handleScale: false,
        });

        const candlestick = chart.addCandlestickSeries({
            upColor: '#f5222d',
            downColor: '#52c41a',
            borderVisible: false,
            wickUpColor: '#f5222d',
            wickDownColor: '#52c41a',
        });

        candlestick.setData(indexKlineData);

        const volumeSeries = chart.addHistogramSeries({
            color: '#26a69a',
            priceFormat: {
                type: 'volume',
            },
            priceScaleId: '',
        });

        volumeSeries.setData(indexKlineData.map(d => ({
            time: d.time,
            value: d.volume,
            color: parseFloat(d.close) >= parseFloat(d.open) ? '#f5222d' : '#52c41a',
        })));

        volumeSeries.priceScale().applyOptions({
            scaleMargins: {
                top: 0.75,
                bottom: 0,
            },
        });

        candlestick.priceScale().applyOptions({
            scaleMargins: {
                top: 0.1,
                bottom: 0.25,
            },
        });

        const premiumLine = chart.addLineSeries({
            color: '#9c27b0',
            lineWidth: 2,
            priceScaleId: 'premium',
        });

        premiumLine.setData(premiumLineData);

        premiumLine.priceScale().applyOptions({
            scaleMargins: {
                top: 0.1,
                bottom: 0.25,
            },
            borderColor: '#9c27b0',
            position: 'right',
        });

        chart.timeScale().fitContent();

        const clickHandler = (param) => {
            if (isDisposed || !param.time) return;

            const timeStr = typeof param.time === 'object'
                ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`
                : String(param.time);

            const currentData = dataRef.current;
            const premiumItem = currentData?.premiumHistory?.find(item => {
                const itemDateStr = String(item.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
                return itemDateStr === timeStr;
            });

            setSelectedDate(timeStr);
            setSelectedData(premiumItem || null);
        };

        chart.subscribeClick(clickHandler);

        chartRef.current = chart;

        const handleResize = () => {
            if (isDisposed || !chartRef.current || !containerRef.current) return;
            try {
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth,
                });
            } catch (e) {
            }
        };

        window.addEventListener('resize', handleResize);

        return () => {
            isDisposed = true;
            window.removeEventListener('resize', handleResize);
            try {
                chart.remove();
            } catch (e) {
            }
            chartRef.current = null;
        };
    }, [indexKlineData, premiumLineData]);

    const handleStockClick = (record) => {
        setSelectedStock(record);
        setKlineModalOpen(true);
    };

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '400px' }}>
                <Spin size="large" tip="正在加载溢价诊断数据..." />
            </div>
        );
    }

    if (error) {
        return (
            <div style={{ padding: '24px', textAlign: 'center' }}>
                <Text type="danger">{error}</Text>
                <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={() => fetchPremiumData(true)}
                    style={{ marginLeft: '16px' }}
                >
                    重新加载
                </Button>
            </div>
        );
    }

    if (!data || !data.premiumHistory || data.premiumHistory.length === 0) {
        return <Empty description="暂无溢价诊断数据" />;
    }

    const latestData = data.latestData;

    return (
        <div className="premium-diagnosis-tab">
            <div className="tab-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <Space>
                    <Button
                        type={indexType === 'chuangyeban' ? 'primary' : 'default'}
                        onClick={() => setIndexType('chuangyeban')}
                    >
                        创业板指
                    </Button>
                    <Button
                        type={indexType === 'kechuangban' ? 'primary' : 'default'}
                        onClick={() => setIndexType('kechuangban')}
                    >
                        科创50
                    </Button>
                </Space>
                <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={() => fetchPremiumData(true)}
                >
                    刷新数据
                </Button>
            </div>

            <Card bordered={false} className="premium-chart-card">
                <div className="premium-chart-legend">
                    <div className="legend-item">
                        <span className="legend-line" style={{ backgroundColor: '#9c27b0' }} />
                        <span>溢价率(%)</span>
                    </div>
                </div>
                <div ref={containerRef} className="premium-chart" />
            </Card>

            <Card bordered={false} className="premium-summary-card" style={{ marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: '16px' }}>
                    <div className="summary-item">
                        <div className="summary-label">最新溢价率</div>
                        <div className="summary-value" style={{ color: latestData?.premiumRate >= 50 ? '#cf1322' : '#389e0d' }}>
                            {latestData?.premiumRate || 0}%
                        </div>
                    </div>
                    <div className="summary-item">
                        <div className="summary-label">昨日上涨股票</div>
                        <div className="summary-value">{latestData?.totalUpCount || 0}只</div>
                    </div>
                    <div className="summary-item">
                        <div className="summary-label">今日溢价股票</div>
                        <div className="summary-value" style={{ color: '#cf1322' }}>{latestData?.premiumCount || 0}只</div>
                    </div>
                    <div className="summary-item">
                        <div className="summary-label">今日掉队股票</div>
                        <div className="summary-value" style={{ color: '#389e0d' }}>{latestData?.laggingCount || 0}只</div>
                    </div>
                    <div className="summary-item">
                        <div className="summary-label">监控股票总数</div>
                        <div className="summary-value">{data?.totalStockCount || 0}只</div>
                    </div>
                    <div className="summary-item">
                        <div className="summary-label">有效数据股票</div>
                        <div className="summary-value">{data?.validStockCount || 0}只</div>
                    </div>
                </div>
            </Card>

            <Card
                    bordered={false}
                    className="premium-detail-card"
                    style={{ marginTop: '16px' }}
                    title={
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <BarChartOutlined />
                            <span>{selectedDate} 溢价详情</span>
                            {selectedData && (
                                <Tag color={selectedData.premiumRate >= 50 ? 'error' : 'success'}>
                                    溢价率 {selectedData.premiumRate}%
                                </Tag>
                            )}
                        </div>
                    }
                >
                    {selectedData ? (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                            <div>
                                <Title level={5} style={{ color: '#cf1322', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span>📈</span>
                                    <span>有溢价股票</span>
                                    <Tag color="error" style={{ fontSize: '12px', padding: '2px 8px' }}>{selectedData.premiumStocks.length}只</Tag>
                                </Title>
                                {selectedData.premiumStocks.length > 0 ? (
                                    <div style={{ border: '1px solid #ffccc7', borderRadius: '8px', overflow: 'hidden' }}>
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr',
                                            padding: '10px 16px',
                                            backgroundColor: '#fff7f7',
                                            borderBottom: '2px solid #ff4d4f',
                                            fontWeight: '500',
                                            fontSize: '12px',
                                            color: '#666'
                                        }}>
                                            <span>股票名称</span>
                                            <span>代码</span>
                                            <span>昨日涨幅</span>
                                            <span>今日涨幅</span>
                                            <span>溢价金额</span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            {selectedData.premiumStocks.map(stock => (
                                                <div
                                                    key={stock.code}
                                                    onClick={() => handleStockClick(stock)}
                                                    style={{
                                                        display: 'grid',
                                                        gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr',
                                                        padding: '10px 16px',
                                                        alignItems: 'center',
                                                        cursor: 'pointer',
                                                        transition: 'background-color 0.2s ease',
                                                        borderBottom: '1px solid #fff0f0'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.backgroundColor = '#fff0f0';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.backgroundColor = '#fff';
                                                    }}
                                                >
                                                    <span style={{ fontSize: '14px', fontWeight: '500', color: '#333' }}>{stock.stockName}</span>
                                                    <span style={{ fontSize: '13px', color: '#999' }}>{stock.code}</span>
                                                    <Tag color="error" style={{ fontSize: '11px', margin: 0 }}>
                                                        +{stock.prevChange}%
                                                    </Tag>
                                                    <Tag color={stock.currentChange >= 0 ? 'error' : 'success'} style={{ fontSize: '11px', margin: 0 }}>
                                                        {stock.currentChange >= 0 ? '+' : ''}{stock.currentChange}%
                                                    </Tag>
                                                    <span style={{ fontSize: '13px', color: '#cf1322', fontWeight: '500' }}>
                                                        {stock.premiumAmount >= 0 ? '+' : ''}{stock.premiumAmount}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <Empty description="暂无有溢价股票" />
                                )}
                            </div>

                            <div>
                                <Title level={5} style={{ color: '#389e0d', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span>📉</span>
                                    <span>掉队股票</span>
                                    <Tag color="success" style={{ fontSize: '12px', padding: '2px 8px' }}>{selectedData.laggingStocks.length}只</Tag>
                                </Title>
                                {selectedData.laggingStocks.length > 0 ? (
                                    <div style={{ border: '1px solid #b7eb8f', borderRadius: '8px', overflow: 'hidden' }}>
                                        <div style={{
                                            display: 'grid',
                                            gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr',
                                            padding: '10px 16px',
                                            backgroundColor: '#f6ffed',
                                            borderBottom: '2px solid #52c41a',
                                            fontWeight: '500',
                                            fontSize: '12px',
                                            color: '#666'
                                        }}>
                                            <span>股票名称</span>
                                            <span>代码</span>
                                            <span>昨日涨幅</span>
                                            <span>今日涨幅</span>
                                            <span>溢价金额</span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            {selectedData.laggingStocks.map(stock => (
                                                <div
                                                    key={stock.code}
                                                    onClick={() => handleStockClick(stock)}
                                                    style={{
                                                        display: 'grid',
                                                        gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr',
                                                        padding: '10px 16px',
                                                        alignItems: 'center',
                                                        cursor: 'pointer',
                                                        transition: 'background-color 0.2s ease',
                                                        borderBottom: '1px solid #e6fffb'
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.backgroundColor = '#e6fffb';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.backgroundColor = '#fff';
                                                    }}
                                                >
                                                    <span style={{ fontSize: '14px', fontWeight: '500', color: '#333' }}>{stock.stockName}</span>
                                                    <span style={{ fontSize: '13px', color: '#999' }}>{stock.code}</span>
                                                    <Tag color="error" style={{ fontSize: '11px', margin: 0 }}>
                                                        +{stock.prevChange}%
                                                    </Tag>
                                                    <Tag color={stock.currentChange >= 0 ? 'error' : 'success'} style={{ fontSize: '11px', margin: 0 }}>
                                                        {stock.currentChange >= 0 ? '+' : ''}{stock.currentChange}%
                                                    </Tag>
                                                    <span style={{ fontSize: '13px', color: '#389e0d', fontWeight: '500' }}>
                                                        {stock.premiumAmount >= 0 ? '+' : ''}{stock.premiumAmount}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <Empty description="暂无掉队股票" />
                                )}
                            </div>
                        </div>
                    ) : (
                        <Empty description="暂无数据" />
                    )}
                </Card>

            <StockKLineModal
                visible={klineModalOpen}
                onCancel={() => setKlineModalOpen(false)}
                code={selectedStock?.code}
                stockInfo={{
                    name: selectedStock?.stockName,
                    code: selectedStock?.code,
                    change: selectedStock?.currentChange,
                }}
            />
        </div>
    );
};

export default PremiumDiagnosisTab;