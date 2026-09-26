import { Card, Empty, Spin, Tooltip, Typography, Button, Dropdown } from 'antd';
import { StockOutlined, RiseOutlined, FireOutlined, BookOutlined, FileSearchOutlined, CloseOutlined, ReloadOutlined, LineChartOutlined } from '@ant-design/icons';
import { OpeningSurgeModule, WatchlistUpDownModule } from '../../../OpeningBattle/index.jsx';
import StockStatisticsPanel from '../../../../components/StockStatisticsPanel';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const StockChangeMonitor = ({
    stockViewMode,
    onStockViewModeChange,
    stockData,
    fullStockData,
    marketRiskWarning,
    reportStockData,
    researchReportsLoading,
    researchReportsLoaded,
    allStockData,
    watchlistMainFund,
    onStockClick,
    onOpenOverlayTimeLine,
    onViewYanbaoDetail,
    onRefresh,
    refreshing = false,
    themeColor,
    hideFundFlow = false,
    viewModes = ['grouped', 'merged', 'statistics', 'research'],
    style = {}
}) => {
    const viewBtnStyle = (active) => ({
        cursor: 'pointer',
        padding: '2px 8px',
        borderRadius: 4,
        background: active ? 'var(--theme-color, #1677ff)' : 'transparent',
        color: active ? '#fff' : '#8e8e93',
        fontSize: 12,
    });

    const renderStockItem = (item, index, keyPrefix) => {
        const isUp = item.changeValue > 0;
        const isRedStock = item.statusKey?.includes('Red');
        const showRiskOverlay = marketRiskWarning && isRedStock;

        const isKeyStock = item.isImportant;
        const changeValue = item.changeValue;
        const isGold = isKeyStock && changeValue > 4;
        const isPurple = isKeyStock && changeValue < -4;

        const fundRaw = watchlistMainFund?.[item.code];
        const fundNum = (fundRaw !== undefined && fundRaw !== null) ? Number(fundRaw) : NaN;
        const fundClass = Number.isNaN(fundNum) ? 'neutral' : (fundNum > 0 ? 'up' : fundNum < 0 ? 'down' : 'neutral');
        const fundText = Number.isNaN(fundNum) ? '--' : `${fundNum > 0 ? '+' : ''}${fundNum}亿`;

        const stockItemContent = (
            <div
                key={`${keyPrefix}-${item.code}-${index}`}
                className={`stock-change-item ${isGold ? 'key-stock-gold' : ''} ${isPurple ? 'key-stock-purple' : ''}`}
                onClick={() => onStockClick(item)}
                style={borderStyle(themeColor)}
            >
                <Text strong className="stock-change-name" style={titleStyle(themeColor)}>{item.name}</Text>
                <span className={`stock-change-value ${isUp ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                    {item.change}
                </span>
                {!hideFundFlow && (
                    <span className={`stock-change-fund ${fundClass}`} style={numberStyle(themeColor)}>
                        {fundText}
                    </span>
                )}
                {/* {showRiskOverlay && (
                    <div className="risk-overlay">
                        <CloseOutlined className="risk-cross-icon" />
                    </div>
                )} */}
            </div>
        );

        // 右键菜单：叠加分时（与自选股全量监控保持一致）；未传回调时（如训练营页）不启用
        if (!onOpenOverlayTimeLine) {
            return stockItemContent;
        }

        return (
            <Dropdown
                key={`${keyPrefix}-${item.code}-${index}`}
                trigger={['contextMenu']}
                menu={{
                    items: [
                        {
                            key: 'overlay-timeline',
                            label: '叠加分时',
                            icon: <LineChartOutlined />,
                            onClick: () => onOpenOverlayTimeLine({ code: item.code, stockName: item.name, change: item.changeValue }),
                        },
                    ],
                }}
            >
                {stockItemContent}
            </Dropdown>
        );
    };

    return (
        <Card
            style={style}
            title={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span><StockOutlined /> 个股幅度异动</span>
                        <span style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontWeight: 600, color: '#e11d48' }}>涨: {fullStockData.upCount}</span>
                            <span style={{ color: '#64748b' }}>vs</span>
                            <span style={{ fontWeight: 600, color: '#059669' }}>跌: {fullStockData.downCount}</span>
                        </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <span>视图:</span>
                        {viewModes.includes('grouped') && <span className="stock-view-tab" onClick={() => onStockViewModeChange('grouped')} style={viewBtnStyle(stockViewMode === 'grouped')}>分区</span>}
                        {viewModes.includes('merged') && <span className="stock-view-tab" onClick={() => onStockViewModeChange('merged')} style={viewBtnStyle(stockViewMode === 'merged')}>合并</span>}
                        {viewModes.includes('statistics') && <span className="stock-view-tab" onClick={() => onStockViewModeChange('statistics')} style={viewBtnStyle(stockViewMode === 'statistics')}>统计</span>}
                        {viewModes.includes('research') && <span className="stock-view-tab" onClick={() => onStockViewModeChange('research')} style={viewBtnStyle(stockViewMode === 'research')}>研报</span>}
                        <Tooltip title="刷新股票数据">
                            <Button
                                size="small"
                                type="text"
                                icon={<ReloadOutlined />}
                                loading={refreshing}
                                onClick={onRefresh}
                                style={{ color: 'rgba(0,0,0,0.45)', padding: '0 4px', height: 24 }}
                            />
                        </Tooltip>
                    </div>
                </div>
            }
            className="monitor-card stock-card"
            variant="borderless"
        >
            {stockViewMode === 'research' ? (
                <Spin spinning={researchReportsLoading} tip="加载研报数据中...">
                    {researchReportsLoaded ? (
                        <div className="yanbao-view">
                            <div className="yanbao-module">
                                <div className="yanbao-module-title">
                                    <RiseOutlined /> 涨幅最大 Top 10
                                </div>
                                {reportStockData.topGain.length > 0 ? (
                                    <div className="yanbao-stock-grid">
                                        {reportStockData.topGain.map((stock, index) => (
                                            <div
                                                key={`gain-${stock.code}`}
                                                className="yanbao-stock-item"
                                                onClick={() => onStockClick({ name: stock.stockName, code: stock.code, change: stock.change })}
                                                style={borderStyle(themeColor)}
                                            >
                                                <span className="yanbao-rank">{index + 1}</span>
                                                <Text strong className="yanbao-stock-name" style={titleStyle(themeColor)}>{stock.stockName}</Text>
                                                <Tooltip title="查看相关研报">
                                                    <FileSearchOutlined
                                                        className="yanbao-report-icon"
                                                        onClick={(e) => { e.stopPropagation(); onViewYanbaoDetail(stock); }}
                                                    />
                                                </Tooltip>
                                                <span className={`yanbao-change ${stock.change >= 0 ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                                    {stock.change > 0 ? '+' : ''}{stock.change}%
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <Empty description="暂无研报覆盖的个股" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                )}
                            </div>
                            <div className="yanbao-module">
                                <div className="yanbao-module-title">
                                    <BookOutlined /> 研报覆盖最多 Top 10
                                </div>
                                {reportStockData.topCoverage.length > 0 ? (
                                    <div className="yanbao-stock-grid">
                                        {reportStockData.topCoverage.map((stock, index) => (
                                            <div
                                                key={`coverage-${stock.code}`}
                                                className="yanbao-stock-item"
                                                onClick={() => onStockClick({ name: stock.stockName, code: stock.code, change: stock.change })}
                                                style={borderStyle(themeColor)}
                                            >
                                                <span className="yanbao-rank">{index + 1}</span>
                                                <Text strong className="yanbao-stock-name" style={titleStyle(themeColor)}>{stock.stockName}</Text>
                                                <Tooltip title="查看相关研报">
                                                    <FileSearchOutlined
                                                        className="yanbao-report-icon"
                                                        onClick={(e) => { e.stopPropagation(); onViewYanbaoDetail(stock); }}
                                                    />
                                                </Tooltip>
                                                <span className="yanbao-coverage-badge" style={numberStyle(themeColor)}>{stock.totalCount} 篇</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <Empty description="暂无研报覆盖的个股" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                )}
                            </div>
                            <div className="yanbao-module yanbao-intersection">
                                <div className="yanbao-module-title">
                                    <FireOutlined /> 涨幅 & 覆盖交集
                                    <span className="yanbao-module-subtitle">（同时出现在涨幅Top10和覆盖Top10中）</span>
                                </div>
                                {reportStockData.intersection.length > 0 ? (
                                    <div className="yanbao-intersection-grid">
                                        {reportStockData.intersection.map((stock) => (
                                            <div
                                                key={`intersect-${stock.code}`}
                                                className="yanbao-intersection-card"
                                                onClick={() => onStockClick({ name: stock.stockName, code: stock.code, change: stock.change })}
                                                style={borderStyle(themeColor)}
                                            >
                                                <div className="yanbao-intersection-header">
                                                    <Text strong className="yanbao-stock-name" style={titleStyle(themeColor)}>{stock.stockName}</Text>
                                                    <Tooltip title="查看相关研报">
                                                        <FileSearchOutlined
                                                            className="yanbao-report-icon"
                                                            onClick={(e) => { e.stopPropagation(); onViewYanbaoDetail(stock); }}
                                                        />
                                                    </Tooltip>
                                                </div>
                                                <div className="yanbao-intersection-stats">
                                                    <span className={`yanbao-change ${stock.change >= 0 ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                                        {stock.change > 0 ? '+' : ''}{stock.change}%
                                                    </span>
                                                    <span className="yanbao-coverage-badge" style={numberStyle(themeColor)}>{stock.totalCount} 篇研报</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <Empty description="暂无交集个股" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                )}
                            </div>
                        </div>
                    ) : null}
                </Spin>
            ) : stockViewMode === 'statistics' ? (
                <div>
                    <div className="open-stats-row-pair">
                        <OpeningSurgeModule stockList={allStockData} />
                        <WatchlistUpDownModule stockList={allStockData} />
                    </div>
                    <StockStatisticsPanel
                        stocks={allStockData}
                        onStockClick={(s) => onStockClick({ code: s.code, name: s.stockName || s.name, change: s.change })}
                    />
                </div>
            ) : stockData.changeList.length === 0 && fullStockData.changeList.length === 0 ? (
                <Empty description="暂无个股异动数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : stockViewMode === 'merged' ? (
                <div className="stock-change-grid">
                    {fullStockData.changeList.map((item, index) => renderStockItem(item, index, 'merged'))}
                </div>
            ) : (
                <div>
                    {fullStockData.aboveOpeningList.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginBottom: 8,
                                paddingBottom: 4,
                                borderBottom: '1px solid rgba(60, 60, 67, 0.1)'
                            }}>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>大于等于开盘价</span>
                                <span style={{ fontSize: 12 }}>
                                    {fullStockData.aboveOpeningList.length} 只 · 涨 {fullStockData.aboveOpeningList.filter(s => s.changeValue > 0).length} / 跌 {fullStockData.aboveOpeningList.filter(s => s.changeValue < 0).length}
                                </span>
                            </div>
                            <div className="stock-change-grid">
                                {fullStockData.aboveOpeningList.map((item, index) => renderStockItem(item, index, 'above'))}
                            </div>
                        </div>
                    )}

                    {fullStockData.belowOpeningList.length > 0 && (
                        <div>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginBottom: 8,
                                paddingBottom: 4,
                                borderBottom: '1px solid rgba(60, 60, 67, 0.1)'
                            }}>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>小于开盘价</span>
                                <span style={{ fontSize: 12 }}>
                                    {fullStockData.belowOpeningList.length} 只 · 涨 {fullStockData.belowOpeningList.filter(s => s.changeValue > 0).length} / 跌 {fullStockData.belowOpeningList.filter(s => s.changeValue < 0).length}
                                </span>
                            </div>
                            <div className="stock-change-grid">
                                {fullStockData.belowOpeningList.map((item, index) => renderStockItem(item, index, 'below'))}
                            </div>
                        </div>
                    )}

                    {fullStockData.aboveOpeningList.length === 0 && fullStockData.belowOpeningList.length === 0 && (
                        <Empty description="暂无个股异动数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    )}
                </div>
            )}
        </Card>
    );
};

export default StockChangeMonitor;
