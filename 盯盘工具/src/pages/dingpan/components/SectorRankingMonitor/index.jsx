import { useEffect, useState } from 'react';
import { Card, Row, Col, Modal, Table, Empty, Spin } from 'antd';
import { RiseOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../../../constant';
import { isTradingDay } from '../../../../utils/tradingDay';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const API_BASE = `http://${local_ip}:3000/api/ak`;
// 板块行情轮询间隔（仅交易时段内轮询）
const POLL_INTERVAL = 60 * 1000;
// 涨幅榜/跌幅榜各展示的数量
const TOP_N = 10;

// 是否交易时段（交易日 9:30-11:30 / 13:00-15:00），仅此时段内轮询
const isTradingSession = () => {
    const now = dayjs();
    if (!isTradingDay(now)) return false;
    const t = now.hour() * 100 + now.minute();
    return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
};

// 板块涨跌幅前十：展示新浪板块行情涨幅前十与跌幅前十，
// 点击板块弹出成分股列表（支持按涨幅从高到低 / 从低到高排序）
const SectorRankingMonitor = ({ onStockClick, themeColor }) => {
    const [sectorList, setSectorList] = useState([]);
    const [loading, setLoading] = useState(true);
    const [detailOpen, setDetailOpen] = useState(false);
    const [activeSector, setActiveSector] = useState(null);
    const [detailList, setDetailList] = useState([]);
    const [detailLoading, setDetailLoading] = useState(false);

    const fetchSectorSpot = async () => {
        try {
            const res = await axios.get(`${API_BASE}/sector_spot`, { timeout: 90 * 1000 });
            if (res.data?.success && Array.isArray(res.data.data)) {
                // 新浪板块行情返回的涨跌幅已是百分比数值，无需换算
                setSectorList(res.data.data.filter((it) => typeof it['涨跌幅'] === 'number'));
            }
        } catch (error) {
            console.error('获取板块行情失败:', error.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSectorSpot();
        const timer = setInterval(() => {
            if (isTradingSession()) fetchSectorSpot();
        }, POLL_INTERVAL);
        return () => clearInterval(timer);
    }, []);

    const openSectorDetail = async (item) => {
        setActiveSector({ name: item['板块'], label: item['label'] });
        setDetailOpen(true);
        setDetailList([]);
        setDetailLoading(true);
        try {
            const res = await axios.get(`${API_BASE}/sector_detail`, { params: { sector: item['label'] }, timeout: 90 * 1000 });
            if (res.data?.success && Array.isArray(res.data.data)) {
                setDetailList(res.data.data);
            }
        } catch (error) {
            console.error('获取板块成分股失败:', error.message);
        } finally {
            setDetailLoading(false);
        }
    };

    const gainers = [...sectorList].sort((a, b) => b['涨跌幅'] - a['涨跌幅']).slice(0, TOP_N);
    const losers = [...sectorList].sort((a, b) => a['涨跌幅'] - b['涨跌幅']).slice(0, TOP_N);

    const numColor = (v) => (v > 0 ? '#f5222d' : v < 0 ? '#52c41a' : '#666');

    const columns = [
        { title: '代码', dataIndex: 'code', width: 90, render: (v) => v || '-' },
        { title: '名称', dataIndex: 'name', width: 130 },
        {
            title: '最新价',
            dataIndex: 'trade',
            width: 100,
            align: 'right',
            render: (v) => (typeof v === 'number' ? v.toFixed(2) : '-'),
        },
        {
            title: '涨跌幅',
            dataIndex: 'changepercent',
            width: 110,
            align: 'right',
            defaultSortOrder: 'descend',
            sorter: (a, b) => (typeof a.changepercent === 'number' ? a.changepercent : -Infinity)
                - (typeof b.changepercent === 'number' ? b.changepercent : -Infinity),
            render: (v) => (
                <span style={{ color: numColor(v), fontWeight: 600 }}>
                    {typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '-'}
                </span>
            ),
        },
        {
            title: '涨跌额',
            dataIndex: 'pricechange',
            width: 100,
            align: 'right',
            render: (v) => (
                <span style={{ color: numColor(v) }}>
                    {typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}` : '-'}
                </span>
            ),
        },
        {
            title: '成交额',
            dataIndex: 'amount',
            width: 110,
            align: 'right',
            render: (v) => (typeof v === 'number' ? `${(v / 100000000).toFixed(2)}亿` : '-'),
        },
    ];

    const renderList = (list) => (
        <div className="blocks-grid">
            {list.length === 0 ? (
                <Empty description="暂无" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
                list.map((item) => {
                    const value = Number(item['涨跌幅']);
                    return (
                        <div
                            key={item['label'] || item['板块']}
                            className="unified-list-item"
                            onClick={() => openSectorDetail(item)}
                            style={{ cursor: 'pointer', ...borderStyle(themeColor) }}
                        >
                            <div className="item-name">
                                <span style={{ userSelect: 'none', fontSize: '12px', ...titleStyle(themeColor) }}>
                                    {item['板块']}
                                </span>
                            </div>
                            <span className={`item-value ${value > 0 ? 'up' : 'down'}`} style={{ userSelect: 'none', fontVariantNumeric: 'tabular-nums', ...numberStyle(themeColor) }}>
                                {value > 0 ? '+' : ''}{value.toFixed(2)}%
                            </span>
                        </div>
                    );
                })
            )}
        </div>
    );

    return (
        <div className="sector-ranking-monitor">
            <Card
                title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <RiseOutlined />
                        <span style={{ fontSize: 15, fontWeight: 600 }}>全市场板块涨跌幅前十</span>
                    </div>
                }
                className="monitor-card"
                variant="borderless"
                bodyStyle={{ padding: '12px 14px' }}
            >
                {loading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}><Spin size="small" /></div>
                ) : (
                    <Row gutter={[12, 12]}>
                        <Col span={24}>
                            {renderList(gainers)}
                        </Col>
                        <Col span={24}>
                            <div style={{ borderTop: '1px solid rgba(60, 60, 67, 0.1)', marginTop: 2, marginBottom: 8 }} />
                            {renderList(losers)}
                        </Col>
                    </Row>
                )}
            </Card>

            <Modal
                title={activeSector ? `${activeSector.name} · 成分股` : '板块成分股'}
                open={detailOpen}
                onCancel={() => setDetailOpen(false)}
                footer={null}
                width={900}
                centered
                destroyOnClose
            >
                {detailLoading ? (
                    <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Spin tip="正在加载成分股数据..." size="large" />
                    </div>
                ) : (
                    <Table
                        size="small"
                        rowKey={(r) => r.symbol || r.code}
                        columns={columns}
                        dataSource={detailList}
                        pagination={false}
                        scroll={{ y: 420 }}
                        onRow={(record) => ({
                            // 点击成分股打开 K 线弹窗（不关闭当前成分股弹窗，可连续点击不同股票查看）
                            style: { cursor: 'pointer' },
                            onClick: () => onStockClick && onStockClick({
                                code: record.symbol || record.code,
                                name: record.name,
                                change: record.changepercent,
                            }),
                        })}
                    />
                )}
            </Modal>
        </div>
    );
};

export default SectorRankingMonitor;