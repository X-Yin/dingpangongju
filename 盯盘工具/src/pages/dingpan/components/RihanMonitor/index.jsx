import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Card, Spin } from 'antd';
import { AreaChartOutlined, ReloadOutlined } from '@ant-design/icons';
import { local_ip } from '../../../../constant';
import { getThemeColor } from '../../../../utils/theme';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const POLL_INTERVAL = 60 * 1000; // 后端 60s 更新一次，对齐即可

// 显示顺序常量（前后端统一）：纳指期货 → 韩国综合指数 → 日经225
const DISPLAY_ORDER = { '纳指期货': 0, '韩国综合指数': 1, '日经225': 2 };

// 外盘涨跌监控：自治组件，自己拉取数据并持有状态，
// 数据更新时只重渲染本卡片，不再触发盯盘整页重渲染
const RihanMonitor = ({ themeColor }) => {
    const [rihanData, setRihanData] = useState([]);
    const [refreshing, setRefreshing] = useState(false);
    const [loading, setLoading] = useState(true); // 首次加载态：保持卡片骨架避免布局抖动

    const fetchRiHanData = useCallback(async () => {
        try {
            const [rihanRes, foreignRes] = await Promise.all([
                axios.get(`http://${local_ip}:3000/rihan_data`),
                // 外盘期货（新浪，OIL 布伦特原油 / GC 纽约金）：失败时不影响日经/韩指展示
                axios.get(`http://${local_ip}:3000/api/ak/foreign_commodity?symbol=OIL,GC`).catch(() => null),
            ]);
            const list = Array.isArray(rihanRes.data) ? [...rihanRes.data] : [];
            const foreignRows = foreignRes?.data?.data;
            if (Array.isArray(foreignRows)) {
                [
                    { match: '布伦特', name: '布伦特原油', code: 'B00Y' },
                    { match: '黄金', name: '纽约金', code: 'GC00Y' },
                ].forEach(({ match, name, code }) => {
                    const row = foreignRows.find((d) => String(d['名称'] || '').includes(match));
                    if (!row) return;
                    const pct = Number(row['涨跌幅']);
                    const price = Number(row['最新价']);
                    list.push({
                        name,
                        code,
                        change: Number.isFinite(pct) ? `${pct.toFixed(2)}%` : '--',
                        value: Number.isFinite(price) ? price.toFixed(2) : '--',
                        showValue: true, // 名称后同时展示当前数值
                    });
                });
            }
            // 统一显示顺序：纳指期货 → 韩国综合指数 → 日经225 → 其余（布伦特/黄金等）保持原有尾部顺序
            list.sort((a, b) => (DISPLAY_ORDER[a.name] ?? 99) - (DISPLAY_ORDER[b.name] ?? 99));
            setRihanData(list);
        } catch (error) {
            console.error('Fetch rihan data failed:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchRiHanData();
        const timer = setInterval(fetchRiHanData, POLL_INTERVAL);
        return () => clearInterval(timer);
    }, [fetchRiHanData]);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await axios.post(`http://${local_ip}:3000/refresh_rihan_data`);
            await fetchRiHanData();
        } catch (error) {
            console.error('Refresh rihan data failed:', error);
        } finally {
            setRefreshing(false);
        }
    };

    if (loading) {
        return (
            <Card
                className="monitor-card rihan-simple-card"
                variant="borderless"
                style={{ marginBottom: 8 }}
                title={<><AreaChartOutlined style={{ color: getThemeColor(), marginRight: 8 }} /> 外盘涨跌监控</>}
            >
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 64 }}>
                    <Spin size="small" />
                </div>
            </Card>
        );
    }

    if (rihanData.length === 0) {
        return (
            <Card
                className="monitor-card rihan-simple-card"
                variant="borderless"
                style={{ marginBottom: 8 }}
                title={<><AreaChartOutlined style={{ color: getThemeColor(), marginRight: 8 }} /> 外盘涨跌监控</>}
                extra={
                    <ReloadOutlined
                        spin={refreshing}
                        style={{ cursor: 'pointer', fontSize: 14 }}
                        onClick={handleRefresh}
                    />
                }
            >
                <div style={{ fontSize: 12, color: '#999', textAlign: 'center', padding: '16px 0' }}>外盘指数暂无数据，点击刷新重试</div>
            </Card>
        );
    }

    return (
        <Card
            className="monitor-card rihan-simple-card"
            variant="borderless"
            style={{ marginBottom: 8 }}
            title={<><AreaChartOutlined style={{ color: getThemeColor(), marginRight: 8 }} /> 外盘涨跌监控</>}
            extra={
                <ReloadOutlined
                    spin={refreshing}
                    style={{ cursor: 'pointer', fontSize: 14 }}
                    onClick={handleRefresh}
                />
            }
        >
            <div className="rihan-simple-grid">
                {rihanData.map((item, index) => {
                    const isUp = !item.change.startsWith('-');
                    const titleColor = titleStyle(themeColor);
                    return (
                        <div
                            key={index}
                            className="unified-list-item"
                            onClick={() => {
                                // 按 name 精准匹配跳转链接，未覆盖的兜底保持 KS11
                                let url = 'https://quote.eastmoney.com/gb/zsKS11.html';
                                if (item.name === '纳指期货') {
                                    url = 'https://gu.sina.cn/ft/hq/hf.php?symbol=NQ&autocallup=no&isfromsina=yes';
                                } else if (item.name === '日经225') {
                                    url = 'https://quote.eastmoney.com/gb/zsN225.html';
                                } else if (item.name === '韩国综合指数') {
                                    url = 'https://quote.eastmoney.com/gb/zsKS11.html';
                                } else if (item.name === '布伦特原油') {
                                    url = 'https://quote.eastmoney.com/globalfuture/B00Y.html';
                                } else if (item.name === '纽约金') {
                                    url = 'https://quote.eastmoney.com/globalfuture/GC00Y.html';
                                }
                                window.open(url, '_blank');
                            }}
                            style={borderStyle(themeColor)}
                        >
                            <div className="item-name">
                                <span style={{ fontSize: '12px', ...titleColor }}>{item.name}</span>
                                {item.showValue && item.value !== '--' && (
                                    <span className="item-price" style={{ ...titleColor, ...numberStyle(themeColor), marginLeft: 12 }}>{item.value}</span>
                                )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                <span className={`item-value ${isUp ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                    {item.change}
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
};

export default RihanMonitor;
