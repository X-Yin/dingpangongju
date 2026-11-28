import { useState, useRef, useLayoutEffect } from 'react';
import { Row, Col, Card, Popover, Button, Tooltip } from 'antd';
import { RiseOutlined, FallOutlined, ReloadOutlined, ThunderboltOutlined, ExpandAltOutlined, ShrinkOutlined } from '@ant-design/icons';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

// 置顶板块（与训练营 BlockChangeBoard 保持一致；匹配时统一小写并去掉空格）
const PINNED_BLOCKS = ['光通信', 'mpo', 'pcb', 'ccl', '电子布', '铜箔', '半导体', '物理ai', 'ai剧', '国产超节点', '华为', '先进封装'];
const normalizeBlockName = (name) => String(name || '').toLowerCase().replace(/\s+/g, '');
const PINNED_INDEX = new Map(PINNED_BLOCKS.map((n, i) => [normalizeBlockName(n), i]));

const isPinnedBlock = (name) => PINNED_INDEX.has(normalizeBlockName(name));

const BlockRankingCards = ({ topAndBottomBlockData, onBlockClick, renderBlockStockList, themeColor, vertical = false, fillContainer = false, onRefresh, refreshing = false, onEmotionCycle, emotionLoading = false, emotionLoadingSeconds = 0, expandable = false }) => {
    // 展开/折叠（仅 expandable 时可用）：默认折叠，保持原涨幅/跌幅前十两卡片布局
    const [expanded, setExpanded] = useState(false);
    const collapsedRef = useRef(null);
    const [collapsedHeight, setCollapsedHeight] = useState(null);

    // 折叠态下测量两卡片总高度，展开后合并卡片使用相同高度（保证页面布局不跳动）
    useLayoutEffect(() => {
        if (expandable && !expanded && collapsedRef.current) {
            setCollapsedHeight(collapsedRef.current.offsetHeight);
        }
    }, [expandable, expanded, topAndBottomBlockData]);

    // 展开态数据：置顶板块 + 全部板块（全部板块包含置顶板块，保证完整排名）
    const allBlocks = topAndBottomBlockData?.allNumList || [];
    const pinnedBlocks = allBlocks.filter(item => isPinnedBlock(item.blockName));

    const renderBlockChip = (item) => (
        <Popover
            key={item.blockName}
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
                    <span style={{ userSelect: 'none', fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                    {item.rankChange !== 0 && (
                        <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                            {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                        </span>
                    )}
                </div>
                <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={{ userSelect: 'none', ...numberStyle(themeColor) }}>
                    {item.avgChange > 0 ? '+' : ''}{item.avgChange}%
                </span>
            </div>
        </Popover>
    );

    // 展开开关：置于「情绪周期」和「刷新」之间
    const expandToggle = expandable && (
        <Tooltip title={expanded ? '折叠（恢复涨跌前十两卡片）' : '展开（置顶板块 + 全部板块完整排名）'}>
            <Button
                size="small"
                type="text"
                className="block-ranking-expand-btn"
                icon={expanded ? <ShrinkOutlined /> : <ExpandAltOutlined />}
                onClick={() => setExpanded(v => !v)}
            />
        </Tooltip>
    );

    // ==================== 展开态：合并为一个卡片（置顶板块在上，全部板块在下） ====================
    if (expandable && expanded) {
        return (
            <div style={{ marginBottom: 8 }}>
                <Card
                    title={<><RiseOutlined style={{ marginRight: 8, userSelect: 'none' }} /> 自定义板块涨跌幅</>}
                    className="monitor-card compact-head-card block-ranking-expanded-card"
                    variant="borderless"
                    bodyStyle={{ padding: '12px 14px', overflow: 'auto' }}
                    style={{ height: collapsedHeight || undefined }}
                    extra={onRefresh || onEmotionCycle ? (
                        <div className="block-ranking-extra">
                            {onEmotionCycle && (
                                <Button
                                    size="small"
                                    type="link"
                                    className="block-ranking-strength-btn"
                                    onClick={onEmotionCycle}
                                    loading={emotionLoading}
                                >
                                    <span style={{ display: 'inline-block', padding: 2 }}>
                                        <ThunderboltOutlined style={{ marginRight: 2 }} />
                                        {emotionLoading ? `${Number(emotionLoadingSeconds || 0).toFixed(1)}s` : '情绪周期'}
                                    </span>
                                </Button>
                            )}
                            {expandToggle}
                            {onRefresh && (
                                <ReloadOutlined
                                    spin={refreshing}
                                    style={{ cursor: 'pointer', fontSize: 14 }}
                                    onClick={onRefresh}
                                />
                            )}
                        </div>
                    ) : null}
                >
                    {pinnedBlocks.length > 0 && (
                        <div className="block-ranking-section">
                            <div className="block-ranking-section-label">置顶板块</div>
                            <div className="blocks-grid block-ranking-flat-grid">
                                {pinnedBlocks.map(renderBlockChip)}
                            </div>
                        </div>
                    )}
                    <div className="block-ranking-section">
                        <div className="block-ranking-section-label">全部板块</div>
                        <div className="blocks-grid block-ranking-flat-grid">
                            {allBlocks.map(renderBlockChip)}
                        </div>
                    </div>
                </Card>
            </div>
        );
    }

    // ==================== 折叠态：原涨幅前十 / 跌幅前十两卡片 ====================
    const collapsedBody = (
        <Row gutter={[12, 8]} style={{ marginBottom: 8, height: fillContainer ? '100%' : undefined, flex: fillContainer ? 1 : undefined }}>
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
                        title={<><RiseOutlined style={{ marginRight: 8, userSelect: 'none' }} /> 自定义板块涨幅前十</>}
                        className="monitor-card compact-head-card"
                        variant="borderless"
                        bodyStyle={{ padding: '12px 14px' }}
                        extra={onRefresh || onEmotionCycle ? (
                            <div className="block-ranking-extra">
                                {onEmotionCycle && (
                                    <Button
                                        size="small"
                                        type="link"
                                        className="block-ranking-strength-btn"
                                        onClick={onEmotionCycle}
                                        loading={emotionLoading}
                                    >
                                        <span
                                            style={{ display: 'inline-block', padding: 2, }}>
                                            <ThunderboltOutlined style={{ marginRight: 2 }} />
                                            {emotionLoading ? `${Number(emotionLoadingSeconds || 0).toFixed(1)}s` : '情绪周期'}
                                        </span>
                                    </Button>
                                )}
                                {expandToggle}
                                {onRefresh && (
                                    <ReloadOutlined
                                        spin={refreshing}
                                        style={{ cursor: 'pointer', fontSize: 14 }}
                                        onClick={onRefresh}
                                    />
                                )}
                            </div>
                        ) : null}
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
                                            <span style={{ userSelect: 'none', fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                                            {item.rankChange !== 0 && (
                                                <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                                                    {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                                                </span>
                                            )}
                                        </div>
                                        <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={{ userSelect: 'none', ...numberStyle(themeColor) }}>
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
                                            <span style={{ userSelect: 'none', fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
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
                        title={<><FallOutlined style={{ marginRight: 8 }} /> 自定义板块跌幅前十</>}
                        className="monitor-card compact-head-card"
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
                                            <span style={{ userSelect: 'none', fontSize: '12px', ...titleStyle(themeColor) }}>{item.blockName}</span>
                                            {item.rankChange !== 0 && (
                                                <span className={`item-rank-change ${item.rankChange > 0 ? 'up' : 'down'}`}>
                                                    {item.rankChange > 0 ? '↑' : '↓'}{Math.abs(item.rankChange)}
                                                </span>
                                            )}
                                        </div>
                                        <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={{ userSelect: 'none', ...numberStyle(themeColor), }}>
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

    return expandable ? <div ref={collapsedRef}>{collapsedBody}</div> : collapsedBody;
};

export default BlockRankingCards;
