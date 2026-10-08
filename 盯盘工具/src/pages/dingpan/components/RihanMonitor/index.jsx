import { useState } from 'react';
import { Card } from 'antd';
import { AreaChartOutlined, CaretUpOutlined, CaretDownOutlined, ReloadOutlined } from '@ant-design/icons';
import { getThemeColor } from '../../../../utils/theme';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const RihanMonitor = ({ rihanData, themeColor, onRefresh }) => {
    const [refreshing, setRefreshing] = useState(false);

    if (!rihanData || rihanData.length === 0) return null;

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await onRefresh?.();
        } finally {
            setRefreshing(false);
        }
    };

    return (
        <Card
            className="monitor-card rihan-simple-card"
            variant="borderless"
            style={{ marginBottom: 16 }}
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
                                let url = 'https://quote.eastmoney.com/gb/zsKS11.html';
                                if (item.name.includes('日经')) {
                                    url = 'https://quote.eastmoney.com/gb/zsN225.html';
                                } else if (item.name.includes('布伦特')) {
                                    url = 'https://quote.eastmoney.com/globalfuture/B00Y.html';
                                } else if (item.name.includes('纽约金')) {
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
