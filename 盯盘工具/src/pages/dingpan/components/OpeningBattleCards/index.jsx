import { Row, Col, Card, Tag, Typography } from 'antd';
import { RiseOutlined, ThunderboltOutlined, FallOutlined, CloseOutlined } from '@ant-design/icons';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const OpeningBattleCards = ({
    jingJiaQiangChouData,
    kaiPanZhuDongData,
    kaiPanXiaCuoData,
    showJingJiaQiangChou,
    showKaiPanZhuDong,
    showKaiPanXiaCuo,
    emotionSuggestion,
    onCloseJingJia,
    onCloseKaiPanZhuDong,
    onCloseKaiPanXiaCuo,
    onStockClick,
    themeColor,
}) => {
    const showJingJia = showJingJiaQiangChou && jingJiaQiangChouData && jingJiaQiangChouData.length > 0;
    const showZhuDong = showKaiPanZhuDong && kaiPanZhuDongData && kaiPanZhuDongData.length > 0;
    const showXiaCuo = showKaiPanXiaCuo && kaiPanXiaCuoData && kaiPanXiaCuoData.length > 0;

    if (!showJingJia && !showZhuDong && !showXiaCuo) return null;

    const renderGrouped = (list, tagColor = 'purple') => {
        const grouped = list.reduce((acc, item) => {
            const block = item.blockName || '其他';
            if (!acc[block]) acc[block] = [];
            acc[block].push(item);
            return acc;
        }, {});
        const sortedBlocks = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);
        return (
            <div className="jingjia-block-group">
                {sortedBlocks.map((blockName) => (
                    <div key={blockName} className="jingjia-block-item">
                        <div className="jingjia-block-header">
                            <Tag color={tagColor} style={{ fontSize: '11px', fontWeight: 600 }}>{blockName}</Tag>
                            <span style={{ fontSize: '11px', color: 'var(--ios-gray)' }}>{grouped[blockName].length}只</span>
                        </div>
                        <div className="jingjia-grid">
                            {grouped[blockName].map((item, idx) => {
                                const isUp = item.change >= 0;
                                const color = isUp ? 'var(--ios-red)' : 'var(--ios-green)';
                                return (
                                    <div
                                        key={idx}
                                        className="jingjia-item compact"
                                        onClick={() => onStockClick({ name: item.stockName, code: item.code, change: item.change })}
                                        style={{ cursor: 'pointer', ...borderStyle(themeColor) }}
                                    >
                                        <Text strong style={{ fontSize: '13px', ...titleStyle(themeColor) }}>{item.stockName}</Text>
                                        <Text strong style={{ color: color, fontSize: '13px', ...numberStyle(themeColor) }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <>
            {(showJingJia || showZhuDong) && (
                <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                    {showJingJia && (
                        <Col span={showZhuDong ? 12 : 24}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        <span><RiseOutlined style={{ color: 'var(--ios-red)' }} /> 竞价抢筹监控</span>
                                        {emotionSuggestion?.canTrade && (
                                            <span style={{ fontSize: 12, color: 'var(--ios-orange)', fontWeight: 'normal' }}>
                                                {emotionSuggestion.message}
                                            </span>
                                        )}
                                    </div>
                                }
                                className="monitor-card jingjia-card"
                                variant="borderless"
                                extra={
                                    <CloseOutlined
                                        style={{ cursor: 'pointer', color: 'var(--ios-gray)' }}
                                        onClick={(e) => { e.stopPropagation(); onCloseJingJia(); }}
                                    />
                                }
                            >
                                {renderGrouped(jingJiaQiangChouData, 'purple')}
                            </Card>
                        </Col>
                    )}
                    {showZhuDong && (
                        <Col span={showJingJia ? 12 : 24}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        <span><ThunderboltOutlined style={{ color: 'var(--ios-orange)' }} /> 开盘主动拉升</span>
                                        {emotionSuggestion?.canTrade && (
                                            <span style={{ fontSize: 12, color: 'var(--ios-orange)', fontWeight: 'normal' }}>
                                                {emotionSuggestion.message}
                                            </span>
                                        )}
                                    </div>
                                }
                                className="monitor-card zhudong-card"
                                variant="borderless"
                                extra={
                                    <CloseOutlined
                                        style={{ cursor: 'pointer', color: 'var(--ios-gray)' }}
                                        onClick={(e) => { e.stopPropagation(); onCloseKaiPanZhuDong(); }}
                                    />
                                }
                            >
                                {renderGrouped(kaiPanZhuDongData, 'orange')}
                            </Card>
                        </Col>
                    )}
                </Row>
            )}

            {showXiaCuo && (
                <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                    <Col span={24}>
                        <Card
                            title={<><FallOutlined style={{ color: 'var(--ios-green)' }} /> 开盘持续下挫</>}
                            className="monitor-card zhudong-card"
                            variant="borderless"
                            extra={
                                <CloseOutlined
                                    style={{ cursor: 'pointer', color: 'var(--ios-gray)' }}
                                    onClick={(e) => { e.stopPropagation(); onCloseKaiPanXiaCuo(); }}
                                />
                            }
                        >
                            {renderGrouped(kaiPanXiaCuoData, 'green')}
                        </Card>
                    </Col>
                </Row>
            )}
        </>
    );
};

export default OpeningBattleCards;
