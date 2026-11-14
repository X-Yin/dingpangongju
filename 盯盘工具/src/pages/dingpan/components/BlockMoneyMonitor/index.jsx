import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Card, Button, Typography } from 'antd';
import { DollarOutlined } from '@ant-design/icons';
import { local_ip } from '../../../../constant';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const POLL_INTERVAL = 15 * 1000; // 后端板块资金 30s 更新，15s 拉一次足够

// 板块资金监控：自治组件，自己拉取数据并计算告警，
// 数据更新时只重渲染本卡片，不再触发盯盘整页重渲染
const BlockMoneyMonitor = ({ targetBlocks, displayBlocks, bigChangeThreshold, onBlockClick, onViewMore, themeColor }) => {
    const [blockMoneyData, setBlockMoneyData] = useState([]);
    const [blockMoneyAlerts, setBlockMoneyAlerts] = useState([]);
    const prevBlockMoneyRef = useRef(null);

    useEffect(() => {
        let cancelled = false;

        const fetchBlockMoneyChange = async () => {
            try {
                const response = await axios.get(`http://${local_ip}:3000/get_block_money_change`);
                const data = response.data || [];
                // 筛选目标板块，按资金从大到小排序
                const filteredData = data.filter(item => targetBlocks.includes(item.block));
                const sortedData = [...filteredData].sort((a, b) => b.money - a.money);

                // 对比上一次数据，计算大幅流入/流出
                const prevMap = prevBlockMoneyRef.current;
                if (prevMap) {
                    const alerts = [];
                    sortedData.forEach((item) => {
                        const prevMoney = prevMap.get(item.block);
                        if (prevMoney !== undefined) {
                            const diff = item.money - prevMoney;
                            if (Math.abs(diff) >= bigChangeThreshold) {
                                alerts.push({
                                    block: item.block,
                                    diff,
                                    type: diff > 0 ? 'inflow' : 'outflow',
                                });
                            }
                        }
                    });
                    alerts.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
                    if (!cancelled) setBlockMoneyAlerts(alerts);
                }

                // 保存本次数据供下次对比
                const currentMap = new Map();
                sortedData.forEach((item) => {
                    currentMap.set(item.block, item.money);
                });
                prevBlockMoneyRef.current = currentMap;

                if (!cancelled) setBlockMoneyData(sortedData);
            } catch (err) {
                console.error('Fetch block money change data failed:', err);
            }
        };

        fetchBlockMoneyChange();
        const timer = setInterval(fetchBlockMoneyChange, POLL_INTERVAL);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [targetBlocks, bigChangeThreshold]);

    const displayData = blockMoneyData.filter(item => displayBlocks.includes(item.block));

    // 标题与内容同处一行：内容超出卡片宽度时横向滚动；
    // 复用 all-stock-card 卡片头部结构，与右侧「自选股全量监控」缩略态高度完全一致
    return (
        <Card
            title={
                <div className="block-money-strip">
                    <div className="block-money-strip-title">
                        <div className="all-stock-card-title-icon">
                            <DollarOutlined />
                        </div>
                        <span>板块资金监控</span>
                    </div>
                    <div className="block-money-strip-list">
                        {blockMoneyAlerts.map((alert, idx) => {
                            const isBigInflow = alert.type === 'inflow';
                            const yiValue = Math.abs(alert.diff) / 100000000;
                            return (
                                <span
                                    key={`alert-${idx}`}
                                    className="block-money-alert-tag"
                                    style={{ ...numberStyle(themeColor) }}
                                >
                                    {alert.block} {isBigInflow ? '流入' : '流出'} {isBigInflow ? '+' : '-'}{yiValue.toFixed(1)}亿
                                </span>
                            );
                        })}
                        {displayData.map((item, index) => {
                            const isInflow = item.money >= 0;
                            return (
                                <div
                                    key={index}
                                    className="unified-list-item block-money-item"
                                    onClick={() => onBlockClick(item.block)}
                                    style={borderStyle(themeColor)}
                                >
                                    <Text strong className="item-name" style={{ fontSize: '12px', ...titleStyle(themeColor) }}>{item.block}</Text>
                                    <Text strong className={`item-value ${isInflow ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                        {isInflow ? '+' : ''}{(item.money / 100000000).toFixed(2)}亿
                                    </Text>
                                </div>
                            );
                        })}
                        {displayData.length === 0 && (
                            <span className="block-money-empty">暂无数据</span>
                        )}
                    </div>
                </div>
            }
            className="monitor-card all-stock-card block-money-card"
            variant="borderless"
            bodyStyle={{ display: 'none' }}
            extra={
                <Button type="link" size="small" onClick={onViewMore}>
                    查看更多
                </Button>
            }
            style={{ marginBottom: 0, height: 'auto' }}
        />
    );
};

export default BlockMoneyMonitor;
