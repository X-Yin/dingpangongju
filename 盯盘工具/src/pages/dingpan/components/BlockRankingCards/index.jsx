import { Row, Col, Card, Popover } from 'antd';
import { RiseOutlined, FallOutlined } from '@ant-design/icons';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const BlockRankingCards = ({ topAndBottomBlockData, onBlockClick, renderBlockStockList, themeColor, vertical = false, fillContainer = false }) => (
    <Row gutter={[12, 12]} style={{ marginBottom: 12, height: fillContainer ? '100%' : undefined, flex: fillContainer ? 1 : undefined }}>
        <Col span={vertical ? 24 : 12} style={{ display: 'flex', flexDirection: 'column' }}>
            {fillContainer ? (
                <Card
                    className="monitor-card"
                    variant="borderless"
                    bodyStyle={{ padding: '12px 14px', flex: 1, overflow: 'auto' }}
                    style={{ flex: 1, overflow: 'hidden' }}
                >
                    <div className="blocks-grid">
                        {topAndBottomBlockData && topAndBottomBlockData.firstNumList.map((item, index) => (
                            <Popover
                                key={index}
                                content={renderBlockStockList(item)}
                                title={<span style={{ fontSize: '13px', fontWeight: 600 }}>{item.blockName} · 成分股涨跌幅</span>}
                                trigger="hover"
                                placement="top"
                                mouseEnterDelay={0.3}
                                mouseLeaveDelay={0.1}
                            >
                                <div
                                    className="unified-list-item"
                                    onClick={() => onBlockClick(item.blockName)}
                                    style={borderStyle(themeColor)}
                                >
                                    <div className="item-name">
                                        <span style={{ fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                                        {item.rankChange !== 0 && (
                                            <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                                                {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                                            </span>
                                        )}
                                    </div>
                                    <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                        {item.avgChange > 0 ? '+' : ''}{item.avgChange}%
                                    </span>
                                </div>
                            </Popover>
                        ))}
                    </div>
                </Card>
            ) : (
                <Card
                    title={<><RiseOutlined style={{ marginRight: 8 }} /> 涨幅前十</>}
                    className="monitor-card"
                    variant="borderless"
                    bodyStyle={{ padding: '12px 14px' }}
                >
                    <div className="blocks-grid">
                        {topAndBottomBlockData && topAndBottomBlockData.firstNumList.map((item, index) => (
                            <Popover
                                key={index}
                                content={renderBlockStockList(item)}
                                title={<span style={{ fontSize: '13px', fontWeight: 600 }}>{item.blockName} · 成分股涨跌幅</span>}
                                trigger="hover"
                                placement="top"
                                overlayClassName="block-stock-popover"
                                mouseEnterDelay={0.3}
                                mouseLeaveDelay={0.1}
                            >
                                <div
                                    className="unified-list-item"
                                    onClick={() => onBlockClick(item.blockName)}
                                    style={borderStyle(themeColor)}
                                >
                                    <div className="item-name">
                                        <span style={{ fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                                        {item.rankChange !== 0 && (
                                            <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                                                {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                                            </span>
                                        )}
                                    </div>
                                    <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                        {item.avgChange > 0 ? '+' : ''}{item.avgChange}%
                                    </span>
                                </div>
                            </Popover>
                        ))}
                    </div>
                </Card>
            )}
        </Col>
        <Col span={vertical ? 24 : 12} style={{ display: 'flex', flexDirection: 'column' }}>
            {fillContainer ? (
                <Card
                    className="monitor-card"
                    variant="borderless"
                    bodyStyle={{ padding: '12px 14px', flex: 1, overflow: 'auto' }}
                    style={{ flex: 1, overflow: 'hidden' }}
                >
                    <div className="blocks-grid">
                        {topAndBottomBlockData && topAndBottomBlockData.lastNumList.map((item, index) => (
                            <Popover
                                key={index}
                                content={renderBlockStockList(item)}
                                title={<span style={{ fontSize: '13px', fontWeight: 600 }}>{item.blockName} · 成分股涨跌幅</span>}
                                trigger="hover"
                                placement="top"
                                mouseEnterDelay={0.3}
                                mouseLeaveDelay={0.1}
                            >
                                <div
                                    className="unified-list-item"
                                    onClick={() => onBlockClick(item.blockName)}
                                    style={borderStyle(themeColor)}
                                >
                                    <div className="item-name">
                                        <span style={{ fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                                        {item.rankChange !== 0 && (
                                            <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                                                {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                                            </span>
                                        )}
                                    </div>
                                    <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                        {item.avgChange > 0 ? '+' : ''}{item.avgChange}%
                                    </span>
                                </div>
                            </Popover>
                        ))}
                    </div>
                </Card>
            ) : (
                <Card
                    title={<><FallOutlined style={{ marginRight: 8 }} /> 跌幅前十</>}
                    className="monitor-card"
                    variant="borderless"
                    bodyStyle={{ padding: '12px 14px' }}
                >
                    <div className="blocks-grid">
                        {topAndBottomBlockData && topAndBottomBlockData.lastNumList.map((item, index) => (
                            <Popover
                                key={index}
                                content={renderBlockStockList(item)}
                                title={<span style={{ fontSize: '13px', fontWeight: 600 }}>{item.blockName} · 成分股涨跌幅</span>}
                                trigger="hover"
                                placement="top"
                                overlayClassName="block-stock-popover"
                                mouseEnterDelay={0.3}
                                mouseLeaveDelay={0.1}
                            >
                                <div
                                    className="unified-list-item"
                                    onClick={() => onBlockClick(item.blockName)}
                                    style={borderStyle(themeColor)}
                                >
                                    <div className="item-name">
                                        <span style={{ fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                                        {item.rankChange !== 0 && (
                                            <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                                                {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                                            </span>
                                        )}
                                    </div>
                                    <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                        {item.avgChange > 0 ? '+' : ''}{item.avgChange}%
                                    </span>
                                </div>
                            </Popover>
                        ))}
                    </div>
                </Card>
            )}
        </Col>
    </Row>
);

export default BlockRankingCards;
