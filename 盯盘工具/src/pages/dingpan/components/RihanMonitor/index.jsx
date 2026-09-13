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
            title={<><AreaChartOutlined style={{ color: getThemeColor(), marginRight: 8 }} /> 日韩涨跌监控</>}
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
                    return (
                        <div
                            key={index}
                            className="unified-list-item"
                            onClick={() => {
                                const url = item.name.includes('日经')
                                    ? 'https://quote.eastmoney.com/gb/zsN225.html'
                                    : 'https://quote.eastmoney.com/gb/zsKS11.html';
                                window.open(url, '_blank');
                            }}
                            style={borderStyle(themeColor)}
                        >
                            <div className="item-name">
                                <span style={{ fontSize: '12px', ...titleStyle(themeColor) }}>{item.name}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                <span className={`item-value ${isUp ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                    {item.change}
                                </span>
                                {isUp ? <CaretUpOutlined style={{ fontSize: '10px', color: 'var(--ios-red)' }} /> : <CaretDownOutlined style={{ fontSize: '10px', color: 'var(--ios-green)' }} />}
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
};

export default RihanMonitor;
