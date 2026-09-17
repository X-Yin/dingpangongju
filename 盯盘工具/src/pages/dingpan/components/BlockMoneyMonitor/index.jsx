import { Card, Button, Empty, Typography } from 'antd';
import { DollarOutlined } from '@ant-design/icons';
import { getThemeColor } from '../../../../utils/theme';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const BlockMoneyMonitor = ({ blockMoneyData, blockMoneyAlerts, displayBlocks, onBlockClick, onViewMore, themeColor }) => {
    const displayData = blockMoneyData.filter(item => displayBlocks.includes(item.block));

    return (
        <Card
            title={<><DollarOutlined style={{ color: getThemeColor(), marginRight: 8 }} /> 板块资金监控</>}
            className="monitor-card block-money-card"
            variant="borderless"
            extra={
                <Button type="link" size="small" onClick={onViewMore}>
                    查看更多
                </Button>
            }
            style={{ marginBottom: 16 }}
        >
            {blockMoneyAlerts.length > 0 && (
                <div className="block-money-alerts">
                    {blockMoneyAlerts.map((alert, idx) => {
                        const isBigInflow = alert.type === 'inflow';
                        const yiValue = Math.abs(alert.diff) / 100000000;
                        return (
                            <span
                                key={idx}
                                className="block-money-alert-tag"
                                style={{ ...numberStyle(themeColor) }}
                            >
                                {alert.block} {isBigInflow ? '流入' : '流出'} {isBigInflow ? '+' : '-'}{yiValue.toFixed(1)}亿
                            </span>
                        );
                    })}
                </div>
            )}
            <div className="block-money-grid">
                {displayData.map((item, index) => {
                    const isInflow = item.money >= 0;
                    return (
                        <div
                            key={index}
                            className="unified-list-item"
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
            </div>
            {displayData.length === 0 && (
                <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
        </Card>
    );
};

export default BlockMoneyMonitor;
