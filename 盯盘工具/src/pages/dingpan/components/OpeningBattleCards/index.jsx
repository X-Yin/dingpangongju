import { useEffect, useRef, useState } from 'react';
import { Row, Col, Card, Tag, Typography, Modal } from 'antd';
import { RiseOutlined, ThunderboltOutlined, FallOutlined, CloseOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { isTradingDay } from '../../../../utils/tradingDay';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

// 竞价抢筹弹窗自动打开时段：9:25 - 9:30（含 9:25 整、不含 9:30）
// 2026-11-28 用户要求：竞价抢筹由盯盘页内嵌卡片改为弹窗展示，且每次打开盯盘页时在该时段自动弹出
const JINGJIA_AUTO_OPEN_START = 925;
const JINGJIA_AUTO_OPEN_END = 930;
const inJingJiaAutoOpenWindow = () => {
    const now = dayjs();
    if (!isTradingDay(now.toDate())) return false;
    const hm = Number(now.format('HHmm'));
    return hm >= JINGJIA_AUTO_OPEN_START && hm < JINGJIA_AUTO_OPEN_END;
};

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

    // 竞价抢筹弹窗开关（2026-11-28）：9:25-9:30 进入盯盘页时自动打开一次
    const [jingJiaModalOpen, setJingJiaModalOpen] = useState(false);
    const autoOpenedRef = useRef(false);

    useEffect(() => {
        if (autoOpenedRef.current) return;
        if (!showJingJia) return;
        if (!inJingJiaAutoOpenWindow()) return;
        autoOpenedRef.current = true;
        setJingJiaModalOpen(true);
    }, [showJingJia]);

    // 关闭弹窗同时沿用原「关闭后本次不再展示」语义（onCloseJingJia → 隐藏模块与入口）
    const closeJingJiaModal = () => {
        setJingJiaModalOpen(false);
        if (onCloseJingJia) onCloseJingJia();
    };

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
                            <span style={{ fontSize: '11px', color: 'var(--dp-title-color, #12213a)' }}>{grouped[blockName].length}只</span>
                        </div>
                        <div className="jingjia-grid">
                            {grouped[blockName].map((item, idx) => {
                                return (
                                    <div
                                        key={idx}
                                        className="jingjia-item compact"
                                        onClick={() => onStockClick({ name: item.stockName, code: item.code, change: item.change })}
                                        style={{ cursor: 'pointer', ...borderStyle(themeColor) }}
                                    >
                                        <Text strong style={{ fontSize: '13px', color: 'var(--dp-title-color, #12213a)', ...titleStyle(themeColor) }}>{item.stockName}</Text>
                                        <Text strong style={{ fontSize: '13px', color: item.change > 0 ? '#e11d48' : item.change < 0 ? '#059669' : 'var(--dp-title-color, #12213a)', ...numberStyle(themeColor) }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
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
            {/* 弹窗关闭后的再次入口：保留竞价抢筹数据的查看能力（9:25 前 / 手动关闭后点击打开） */}
            {showJingJia && !jingJiaModalOpen && (
                <div className="jingjia-modal-trigger" onClick={() => setJingJiaModalOpen(true)}>
                    <RiseOutlined />
                    <span className="jingjia-trigger-title">竞价抢筹监控 · {jingJiaQiangChouData.length} 只</span>
                    {emotionSuggestion?.canTrade && (
                        <span className="jingjia-trigger-tip">{emotionSuggestion.message}</span>
                    )}
                    <span className="jingjia-trigger-action">点击查看</span>
                </div>
            )}

            {/* 竞价抢筹弹窗（2026-11-28 用户要求：内嵌卡片改为弹窗，9:25-9:30 每次进入盯盘页自动打开） */}
            <Modal
                open={!!showJingJia && jingJiaModalOpen}
                onCancel={closeJingJiaModal}
                footer={null}
                width={760}
                rootClassName="jingjia-modal"
                destroyOnHidden
                title={(
                    <div className="jingjia-modal-title">
                        <span><RiseOutlined /> 竞价抢筹监控</span>
                        {emotionSuggestion?.canTrade && (
                            <span className="jingjia-modal-sub">{emotionSuggestion.message}</span>
                        )}
                    </div>
                )}
            >
                {renderGrouped(jingJiaQiangChouData, 'purple')}
            </Modal>

            {(showZhuDong || showXiaCuo) && (
                <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                    {showZhuDong && (
                        <Col span={24}>
                            <Card
                                title={
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        <span><ThunderboltOutlined /> 开盘主动拉升</span>
                                        {emotionSuggestion?.canTrade && (
                                            <span style={{ fontSize: 12, fontWeight: 'normal' }}>
                                                {emotionSuggestion.message}
                                            </span>
                                        )}
                                    </div>
                                }
                                className="monitor-card zhudong-card"
                                variant="borderless"
                                extra={
                                    <CloseOutlined
                                        style={{ cursor: 'pointer' }}
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
                            title={<><FallOutlined /> 开盘持续下挫</>}
                            className="monitor-card zhudong-card"
                            variant="borderless"
                            extra={
                                <CloseOutlined
                                    style={{ cursor: 'pointer' }}
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
