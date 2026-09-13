import { useMemo, useState } from 'react';
import { Typography, Tag, Empty, Tooltip } from 'antd';
import { BarChartOutlined } from '@ant-design/icons';
import './index.scss';

const { Text } = Typography;

// 判断板块：科创板 sh688，创业板 sz30，其余主板
const getBoard = (code) => {
    if (!code) return '主板';
    if (code.startsWith('sh688')) return '科创板';
    if (code.startsWith('sz30')) return '创业板';
    return '主板';
};

const isLimitUp = (change, board) => {
    if (board === '创业板' || board === '科创板') return change > 19.5;
    return change > 9.5;
};

const isLimitDown = (change, board) => {
    if (board === '创业板' || board === '科创板') return change < -19.5;
    return change < -9.5;
};

const boardTagClass = { 主板: 'main', 创业板: 'cyb', 科创板: 'kcb' };

// 涨幅区间配置（含展示标签与配色）
const rangeConfig = [
    { key: '>10%', label: '>10%', color: '#e11d48' },
    { key: '5%-10%', label: '5%~10%', color: '#f87171' },
    { key: '0%-5%', label: '0%~5%', color: '#fca5a5' },
    { key: '-5%-0%', label: '-5%~0%', color: '#86efac' },
    { key: '-5%--10%', label: '-10%~-5%', color: '#4ade80' },
    { key: '<-10%', label: '<-10%', color: '#059669' },
];

// SVG 极坐标转笛卡尔坐标
const polarToCartesian = (cx, cy, r, angleDeg) => {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

// 生成环形扇区路径
const arcPath = (cx, cy, rOuter, rInner, startAngle, endAngle) => {
    // 限制角度避免整圆路径绘制异常
    const safeEnd = startAngle + Math.min(endAngle - startAngle, 359.99);
    const startOuter = polarToCartesian(cx, cy, rOuter, safeEnd);
    const endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
    const startInner = polarToCartesian(cx, cy, rInner, safeEnd);
    const endInner = polarToCartesian(cx, cy, rInner, startAngle);
    const largeArc = safeEnd - startAngle <= 180 ? '0' : '1';
    return [
        'M', startOuter.x, startOuter.y,
        'A', rOuter, rOuter, 0, largeArc, 0, endOuter.x, endOuter.y,
        'L', endInner.x, endInner.y,
        'A', rInner, rInner, 0, largeArc, 1, startInner.x, startInner.y,
        'Z',
    ].join(' ');
};

const StockStatisticsPanel = ({ stocks, onStockClick }) => {
    const [activeRange, setActiveRange] = useState(null);

    const stats = useMemo(() => {
        const list = Array.isArray(stocks) ? stocks : [];

        // 1. 涨幅区间统计
        const ranges = { '>10%': 0, '5%-10%': 0, '0%-5%': 0, '-5%-0%': 0, '-5%--10%': 0, '<-10%': 0 };

        // 2. 涨停 / 跌停统计（区分板块，保留股票列表用于 tooltip）
        const limitStats = {
            主板: { up: [], down: [] },
            创业板: { up: [], down: [] },
            科创板: { up: [], down: [] },
        };

        // 3. 板块分组
        const sectorMap = {};

        list.forEach(s => {
            const change = Number(s.change) || 0;
            const board = getBoard(s.code);

            // 涨幅区间
            if (change > 10) ranges['>10%']++;
            else if (change > 5) ranges['5%-10%']++;
            else if (change >= 0) ranges['0%-5%']++;
            else if (change >= -5) ranges['-5%-0%']++;
            else if (change >= -10) ranges['-5%--10%']++;
            else ranges['<-10%']++;

            // 涨停 / 跌停（保留具体股票）
            if (limitStats[board]) {
                if (isLimitUp(change, board)) limitStats[board].up.push(s);
                if (isLimitDown(change, board)) limitStats[board].down.push(s);
            }

            // 板块分组
            const block = s.blockName || '未分类';
            if (!sectorMap[block]) sectorMap[block] = [];
            sectorMap[block].push(s);
        });

        const sectors = Object.entries(sectorMap)
            .map(([name, items]) => {
                const avg = items.reduce((sum, s) => sum + (Number(s.change) || 0), 0) / items.length;
                return { name, list: items, avg };
            })
            .sort((a, b) => b.avg - a.avg);

        const totalLimitUp = Object.values(limitStats).reduce((s, b) => s + b.up.length, 0);
        const totalLimitDown = Object.values(limitStats).reduce((s, b) => s + b.down.length, 0);
        const allLimitUp = Object.values(limitStats).flatMap(b => b.up);
        const allLimitDown = Object.values(limitStats).flatMap(b => b.down);

        return { ranges, limitStats, totalLimitUp, totalLimitDown, allLimitUp, allLimitDown, sectors, total: list.length };
    }, [stocks]);

    const formatChange = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

    // 环形图数据
    const donutSegments = useMemo(() => {
        const total = stats.total || 0;
        let accPct = 0;
        return rangeConfig.map(cfg => {
            const count = stats.ranges[cfg.key] || 0;
            const pct = total > 0 ? count / total : 0;
            const startAngle = accPct * 360;
            accPct += pct;
            const endAngle = accPct * 360;
            return { ...cfg, count, pct, startAngle, endAngle };
        });
    }, [stats]);

    const activeSeg = activeRange ? donutSegments.find(s => s.key === activeRange) : null;

    // 渲染涨停/跌停 tooltip 内容
    const renderLimitTooltip = (stockList, type) => {
        if (!stockList || stockList.length === 0) {
            return <div className="limit-tooltip-content"><span className="limit-tooltip-empty">暂无</span></div>;
        }
        return (
            <div className="limit-tooltip-content">
                <div className="limit-tooltip-header">
                    {type === 'up' ? '涨停股票' : '跌停股票'}
                    <span className="limit-tooltip-count">共 {stockList.length} 只</span>
                </div>
                <div className="limit-tooltip-list">
                    {stockList.map((s, idx) => {
                        const c = Number(s.change) || 0;
                        return (
                            <div
                                key={`${s.code}-${idx}`}
                                className="limit-tooltip-item"
                                onClick={() => onStockClick && onStockClick(s)}
                            >
                                <span className="limit-tooltip-name">{s.stockName || s.name}</span>
                                <span className="limit-tooltip-code">{s.code}</span>
                                <span className={`limit-tooltip-change ${type}`}>{formatChange(c)}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    const tooltipProps = {
        color: '#ffffff',
        overlayInnerStyle: { maxWidth: 320, padding: 0, borderRadius: 8 },
        mouseLeaveDelay: 0.3,
        placement: 'top',
    };

    return (
        <div className="stock-statistics-panel">
            <div className="statistics-summary">
                {/* 涨幅区间分布：自定义 SVG 环形图 + 区间明细 */}
                <div className="stat-distribution-card">
                    <div className="stat-title">
                        <BarChartOutlined style={{ color: '#4f46e5' }} />
                        涨幅区间分布
                    </div>
                    <div className="distribution-body">
                        <div className="donut-wrap">
                            <svg viewBox="0 0 200 200" width="100%" height="100%">
                                {donutSegments.map(seg => {
                                    if (seg.count === 0) return null;
                                    const isActive = activeRange === seg.key;
                                    const isDimmed = activeRange && !isActive;
                                    return (
                                        <path
                                            key={seg.key}
                                            d={arcPath(100, 100, 82, 54, seg.startAngle, seg.endAngle)}
                                            fill={seg.color}
                                            className={`donut-segment ${isActive ? 'active' : ''} ${isDimmed ? 'dimmed' : ''}`}
                                            onMouseEnter={() => setActiveRange(seg.key)}
                                            onMouseLeave={() => setActiveRange(null)}
                                        />
                                    );
                                })}
                            </svg>
                            <div className="donut-center">
                                {activeSeg ? (
                                    <>
                                        <div className="donut-center-num">{activeSeg.count}</div>
                                        <div className="donut-center-label" style={{ color: activeSeg.color }}>{activeSeg.label}</div>
                                        <div className="donut-center-pct">{(activeSeg.pct * 100).toFixed(1)}%</div>
                                    </>
                                ) : (
                                    <>
                                        <div className="donut-center-num">{stats.total}</div>
                                        <div className="donut-center-label">总股票数</div>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className="range-legend">
                            {donutSegments.map(seg => {
                                const isActive = activeRange === seg.key;
                                return (
                                    <div
                                        key={seg.key}
                                        className={`range-legend-item ${isActive ? 'active' : ''}`}
                                        onMouseEnter={() => setActiveRange(seg.key)}
                                        onMouseLeave={() => setActiveRange(null)}
                                    >
                                        <span className="range-color-dot" style={{ background: seg.color }} />
                                        <span className="range-label">{seg.label}</span>
                                        <span className="range-count">{seg.count}</span>
                                        <span className="range-pct">{(seg.pct * 100).toFixed(1)}%</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* 涨停 / 跌停统计（悬浮显示股票列表） */}
                <div className="stat-limit-card">
                    <div className="stat-title">
                        <Text style={{ color: '#12213a' }}>涨停 / 跌停统计</Text>
                    </div>
                    <div className="limit-summary-row">
                        <Tooltip {...tooltipProps} title={renderLimitTooltip(stats.allLimitUp, 'up')}>
                            <div className="limit-total-item up">
                                <div className="limit-total-num up">{stats.totalLimitUp}</div>
                                <div className="limit-total-label">涨停</div>
                            </div>
                        </Tooltip>
                        <Tooltip {...tooltipProps} title={renderLimitTooltip(stats.allLimitDown, 'down')}>
                            <div className="limit-total-item down">
                                <div className="limit-total-num down">{stats.totalLimitDown}</div>
                                <div className="limit-total-label">跌停</div>
                            </div>
                        </Tooltip>
                    </div>
                    <table className="limit-board-table">
                        <tbody>
                            {[['主板', stats.limitStats['主板']], ['创业板', stats.limitStats['创业板']], ['科创板', stats.limitStats['科创板']]].map(([board, b]) => (
                                <tr key={board}>
                                    <td>
                                        <span className={`board-tag ${boardTagClass[board]}`}>{board}</span>
                                    </td>
                                    <td>
                                        <Tooltip {...tooltipProps} title={renderLimitTooltip(b.up, 'up')}>
                                            <span className="limit-up-num limit-hoverable">涨停 {b.up.length}</span>
                                        </Tooltip>
                                        <span style={{ color: '#cbd5e1', margin: '0 6px' }}>|</span>
                                        <Tooltip {...tooltipProps} title={renderLimitTooltip(b.down, 'down')}>
                                            <span className="limit-down-num limit-hoverable">跌停 {b.down.length}</span>
                                        </Tooltip>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* 板块分类小卡片 */}
            <div className="statistics-sectors">
                <div className="sector-title">
                    <Text style={{ color: '#12213a' }}>板块分类</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: 400 }}>{stats.sectors.length} 个板块</Text>
                </div>
                {stats.sectors.length === 0 ? (
                    <Empty description="暂无板块数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                    stats.sectors.map(sector => (
                        <div key={sector.name} className="sector-card">
                            <div className="sector-header">
                                <div className="sector-name-cell">
                                    <span className="sector-name">{sector.name}</span>
                                    <Tag className="sector-count">{sector.list.length} 只</Tag>
                                </div>
                                <span className={`sector-avg ${sector.avg >= 0 ? 'up' : 'down'}`}>
                                    {formatChange(sector.avg)}
                                </span>
                            </div>
                            <div className="sector-stock-list">
                                {sector.list.map((s, idx) => {
                                    const c = Number(s.change) || 0;
                                    return (
                                        <div
                                            key={`${s.code}-${idx}`}
                                            className="sector-stock-item"
                                            onClick={() => onStockClick && onStockClick(s)}
                                        >
                                            <span className="sector-stock-name">{s.stockName || s.name}</span>
                                            <span className={`sector-stock-change ${c >= 0 ? 'up' : 'down'}`}>
                                                {formatChange(c)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default StockStatisticsPanel;
