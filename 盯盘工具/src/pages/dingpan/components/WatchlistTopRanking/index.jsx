import { Card, Row, Col, Empty } from 'antd';
import { RiseOutlined } from '@ant-design/icons';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';

// 当前自选股个股涨跌幅前十：展示自选股中涨幅前十与跌幅前十
const WatchlistTopRanking = ({ stocks = [], onStockClick, themeColor }) => {
    const valid = Array.isArray(stocks)
        ? stocks.filter((s) => s && s.change != null)
        : [];

    const gainers = [...valid].sort((a, b) => (b.change || 0) - (a.change || 0)).slice(0, 10);
    const losers = [...valid].sort((a, b) => (a.change || 0) - (b.change || 0)).slice(0, 10);

    // 上涨/下跌 与 高于/低于开盘价 统计（涨幅前十上方 tag 展示）
    const upCount = valid.filter((s) => Number(s.change) > 0).length;
    const downCount = valid.filter((s) => Number(s.change) < 0).length;
    const aboveOpenCount = valid.filter((s) => parseFloat(s.open_px) > 0 && parseFloat(s.close_px) >= parseFloat(s.open_px)).length;
    const belowOpenCount = valid.filter((s) => parseFloat(s.open_px) > 0 && parseFloat(s.close_px) < parseFloat(s.open_px)).length;

    // 平均拉升 / 平均下跌：基于“当前涨幅 - 开盘涨幅”的涨幅差，与个股幅度异动·统计 tab 口径一致
    let surgeCount = 0;
    let declineCount = 0;
    let surgeSum = 0;
    let declineSum = 0;
    valid.forEach((item) => {
        const openPx = parseFloat(item.open_px);
        const closePx = parseFloat(item.close_px);
        const change = parseFloat(item.change);
        if (!Number.isFinite(openPx) || !Number.isFinite(closePx) || openPx <= 0) return;
        const curChange = Number.isFinite(change) ? change : 0;
        const prevClose = curChange !== 0 ? closePx / (1 + curChange / 100) : closePx;
        const openChange = prevClose > 0 ? ((openPx - prevClose) / prevClose) * 100 : 0;
        const changeDiff = curChange - openChange;
        if (changeDiff >= 0) { surgeCount++; surgeSum += changeDiff; }
        else { declineCount++; declineSum += changeDiff; }
    });
    const avgSurge = surgeCount > 0 ? surgeSum / surgeCount : 0;
    const avgDecline = declineCount > 0 ? declineSum / declineCount : 0;
    const avgSurgeText = surgeCount > 0 ? `+${avgSurge.toFixed(2)}%` : '--';
    const avgDeclineText = declineCount > 0 ? `${avgDecline.toFixed(2)}%` : '--';

    // tag 背景跟随全局主题色（App.jsx 通过 --theme-color-rgb 注入），带透明度，未设置时回退默认浅灰
    const tagStyle = { fontSize: 11, fontWeight: 500, color: '#12213a', background: 'rgba(var(--theme-color-rgb, 22, 119, 255), 0.15)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' };
    const upColorStyle = { color: '#e11d48' };
    const downColorStyle = { color: '#059669' };

    const statsTags = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={tagStyle}>
                上涨 vs 下跌：<span style={upColorStyle}>{upCount}</span> : <span style={downColorStyle}>{downCount}</span>
            </span>
            <span style={tagStyle}>
                大于开盘价：<span style={upColorStyle}>{aboveOpenCount}</span> : <span style={downColorStyle}>{belowOpenCount}</span>
            </span>
            <span style={tagStyle}>
                平均拉升：<span style={surgeCount > 0 ? upColorStyle : undefined}>{avgSurgeText}</span> : <span style={declineCount > 0 ? downColorStyle : undefined}>{avgDeclineText}</span>
            </span>
        </div>
    );

    const renderList = (list) => (
        <div className="blocks-grid">
            {list.length === 0 ? (
                <Empty description="暂无" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
                list.map((s) => {
                    const value = Number(s.change);
                    return (
                        <div
                            key={s.code}
                            className="unified-list-item"
                            onClick={() => onStockClick && onStockClick(s)}
                            style={{ cursor: onStockClick ? 'pointer' : 'default', ...borderStyle(themeColor) }}
                        >
                            <div className="item-name">
                                <span style={{ fontSize: '12px', ...titleStyle(themeColor) }}>
                                    {s.stockName || s.code}
                                </span>
                            </div>
                            <span className={`item-value ${value > 0 ? 'up' : 'down'}`} style={{ fontVariantNumeric: 'tabular-nums', ...numberStyle(themeColor) }}>
                                {value > 0 ? '+' : ''}{value.toFixed(2)}%
                            </span>
                        </div>
                    );
                })
            )}
        </div>
    );

    return (
        <Card
            title={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <RiseOutlined />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>自选股涨跌幅前十</span>
                </div>
            }
            className="monitor-card"
            variant="borderless"
            bodyStyle={{ padding: '12px 14px' }}
        >
            {statsTags}
            <Row gutter={[12, 12]}>
                <Col span={24}>
                    {renderList(gainers)}
                </Col>
                <Col span={24}>
                    <div style={{ borderTop: '1px solid rgba(60, 60, 67, 0.1)', marginTop: 2, marginBottom: 8 }} />
                    {renderList(losers)}
                </Col>
            </Row>
        </Card>
    );
};

export default WatchlistTopRanking;