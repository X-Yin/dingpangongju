import { Card, Input, Button, Tooltip, Tag, Typography, Empty, Space, Dropdown } from 'antd';
import {
    AreaChartOutlined, CaretDownOutlined, CaretUpOutlined, SearchOutlined, ReloadOutlined,
    PlusOutlined, StarOutlined, StarFilled, ThunderboltOutlined, ArrowUpOutlined, ArrowDownOutlined,
    InfoCircleOutlined, DeleteOutlined, PushpinOutlined, RadarChartOutlined, FileSearchOutlined,
    EditOutlined, LineChartOutlined, ExperimentOutlined,
} from '@ant-design/icons';
import { titleStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

const WatchlistMonitor = ({
    isWatchlistCollapsed,
    onToggleCollapse,
    allStockOverview,
    searchQuery,
    setSearchQuery,
    refreshingStockData,
    onRefresh,
    onAddStock,
    showOnlyImportant,
    setShowOnlyImportant,
    sortOrder,
    sortField,
    onSortChange,
    showOnlyGoodNews,
    setShowOnlyGoodNews,
    filteredAllStockData,
    watchlistMainFund,
    hasGoodNews,
    onViewGoodNews,
    onStockClick,
    onToggleImportant,
    onDeleteStock,
    onToggleStockTop,
    onBuyPointDiagnosis,
    onLogicExplore,
    onOpenOverlayTimeLine,
    onBacktest,
    onRename,
    themeColor,
}) => {
    if (isWatchlistCollapsed) {
        return (
            <Card
                title={
                    <div
                        className="all-stock-card-title"
                        onClick={() => onToggleCollapse(false)}
                        style={{ cursor: 'pointer', width: '100%' }}
                    >
                        <div className="all-stock-card-title-icon">
                            <AreaChartOutlined />
                        </div>
                        <div className="all-stock-card-title-content">
                            <span>自选股全量监控</span>
                            <Text className="all-stock-card-title-subtext">Watchlist Flow Board</Text>
                        </div>
                    </div>
                }
                className="monitor-card all-stock-card premium-style"
                variant="borderless"
                bodyStyle={{ display: 'none' }}
                style={{ marginBottom: 12, height: 'auto' }}
                extra={
                    <div className="all-stock-card-extra" style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                        <span className="all-stock-extra-dot" />
                        <Text>{allStockOverview.filteredCount} / {allStockOverview.totalCount}</Text>
                        <Tooltip title="刷新股票数据">
                            <Button
                                size="small"
                                type="text"
                                icon={<ReloadOutlined />}
                                loading={refreshingStockData}
                                onClick={onRefresh}
                                style={{ color: 'rgba(0,0,0,0.45)', padding: '0 4px', height: 24 }}
                            />
                        </Tooltip>
                        <Tooltip title="展开自选股监控">
                            <Button
                                size="small"
                                type="text"
                                icon={<CaretDownOutlined />}
                                onClick={() => onToggleCollapse(false)}
                                style={{ color: 'rgba(0,0,0,0.45)', padding: '0 4px', height: 24 }}
                            />
                        </Tooltip>
                    </div>
                }
            />
        );
    }

    return (
        <Card
            title={
                <div
                    className="all-stock-card-title"
                    onClick={() => onToggleCollapse(true)}
                    style={{ cursor: 'pointer', width: '100%' }}
                >
                    <div className="all-stock-card-title-icon">
                        <AreaChartOutlined />
                    </div>
                    <div className="all-stock-card-title-content">
                        <span>自选股全量监控</span>
                        <Text className="all-stock-card-title-subtext">Watchlist Flow Board</Text>
                    </div>
                </div>
            }
            className="monitor-card all-stock-card premium-style"
            variant="borderless"
            bodyStyle={{ padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            style={{ maxHeight: '900px', display: 'flex', flexDirection: 'column' }}
            extra={
                <div className="all-stock-card-extra" style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <span className="all-stock-extra-dot" />
                    <Text>{allStockOverview.filteredCount} / {allStockOverview.totalCount}</Text>
                    <Tooltip title="收起自选股监控">
                        <Button
                            size="small"
                            type="text"
                            icon={<CaretUpOutlined />}
                            onClick={() => onToggleCollapse(true)}
                            style={{ color: 'rgba(0,0,0,0.45)', padding: '0 4px', height: 24 }}
                        />
                    </Tooltip>
                </div>
            }
        >
            <div className="all-stock-toolbar">
                <Space direction="vertical" style={{ width: '100%' }} size={10}>
                    <div className="all-stock-filter-row">
                        <Input
                            placeholder="搜索股票名称/代码"
                            prefix={<SearchOutlined className="all-stock-search-icon" />}
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            allowClear
                            size="small"
                            className="all-stock-input search-input"
                            style={{ flex: 1 }}
                        />
                        <Tooltip title="刷新股票数据">
                            <Button
                                size="small"
                                type="primary"
                                icon={<ReloadOutlined />}
                                loading={refreshingStockData}
                                onClick={onRefresh}
                                className="all-stock-filter-btn refresh-filter-btn"
                            />
                        </Tooltip>
                        <Tooltip title="新增股票">
                            <Button
                                size="small"
                                type="primary"
                                icon={<PlusOutlined />}
                                onClick={onAddStock}
                                className="all-stock-filter-btn add-filter-btn"
                            />
                        </Tooltip>
                        <Tooltip title={showOnlyImportant ? "取消重点筛选" : "只看重点"}>
                            <Button
                                size="small"
                                type={showOnlyImportant ? "primary" : "default"}
                                icon={showOnlyImportant ? <StarFilled /> : <StarOutlined />}
                                onClick={() => setShowOnlyImportant(!showOnlyImportant)}
                                className={`all-stock-filter-btn important-filter-btn ${showOnlyImportant ? 'active' : ''}`}
                            />
                        </Tooltip>
                        <Tooltip title={sortField === 'change' && sortOrder !== 'none' ? (sortOrder === 'asc' ? '按涨幅倒序' : '取消排序') : '按涨幅排序'}>
                            <Button
                                size="small"
                                type={sortField === 'change' && sortOrder !== 'none' ? "primary" : "default"}
                                icon={sortField === 'change' && sortOrder === 'asc' ? <ArrowUpOutlined /> : sortField === 'change' && sortOrder === 'desc' ? <ArrowDownOutlined /> : <ThunderboltOutlined />}
                                onClick={() => onSortChange('change')}
                                className={`all-stock-filter-btn sort-filter-btn ${sortField === 'change' && sortOrder !== 'none' ? 'active' : ''}`}
                            />
                        </Tooltip>
                        <Tooltip title={showOnlyGoodNews ? "取消利好筛选" : "只看有利好"}>
                            <Button
                                size="small"
                                type={showOnlyGoodNews ? "primary" : "default"}
                                icon={<InfoCircleOutlined />}
                                onClick={() => setShowOnlyGoodNews(!showOnlyGoodNews)}
                                className={`all-stock-filter-btn good-news-filter-btn ${showOnlyGoodNews ? 'active' : ''}`}
                            />
                        </Tooltip>
                    </div>
                </Space>
            </div>
            <div className="all-stock-list">
                {filteredAllStockData && filteredAllStockData.length > 0 ? (
                    <>
                        <div className="all-stock-list-header">
                            <span />
                            <span>股票名称</span>
                            <span
                                className={`col-change sortable ${sortField === 'change' && sortOrder !== 'none' ? `active ${sortOrder}` : ''}`}
                                onClick={() => onSortChange('change')}
                            >
                                涨幅
                                {sortField === 'change' && sortOrder !== 'none' && (
                                    sortOrder === 'asc' ? <CaretUpOutlined className="sort-caret" /> : <CaretDownOutlined className="sort-caret" />
                                )}
                            </span>
                            <span
                                className={`col-fund sortable ${sortField === 'mainFund' && sortOrder !== 'none' ? `active ${sortOrder}` : ''}`}
                                onClick={() => onSortChange('mainFund')}
                            >
                                主力资金
                                {sortField === 'mainFund' && sortOrder !== 'none' && (
                                    sortOrder === 'asc' ? <CaretUpOutlined className="sort-caret" /> : <CaretDownOutlined className="sort-caret" />
                                )}
                            </span>
                            <span />
                        </div>
                        {filteredAllStockData.map((stock, index) => {
                            const kline = stock || {};
                            const isUp = kline.change >= 0;
                            const currentChange = kline.change || 0;
                            const fundRaw = watchlistMainFund?.[stock.code];
                            const fundNum = (fundRaw !== undefined && fundRaw !== null) ? Number(fundRaw) : NaN;
                            const fundClass = Number.isNaN(fundNum) ? 'neutral' : (fundNum > 0 ? 'up' : fundNum < 0 ? 'down' : 'neutral');
                            const fundText = Number.isNaN(fundNum) ? '--' : `${fundNum > 0 ? '+' : ''}${fundNum}亿`;

                            return (
                                <Dropdown
                                    key={stock.code || index}
                                    trigger={['contextMenu']}
                                    menu={{
                                        items: [
                                            {
                                                key: 'top',
                                                label: stock.isTop ? '取消置顶' : '置顶',
                                                icon: <PushpinOutlined />,
                                                onClick: () => onToggleStockTop(stock),
                                            },
                                            { type: 'divider' },
                                            {
                                                key: 'buy-point-diagnosis',
                                                label: '买点诊断',
                                                icon: <RadarChartOutlined />,
                                                onClick: () => onBuyPointDiagnosis(stock),
                                            },
                                            {
                                                key: 'logic-explore',
                                                label: '逻辑探查',
                                                icon: <FileSearchOutlined />,
                                                onClick: () => onLogicExplore(stock),
                                            },
                                            {
                                                key: 'rename',
                                                label: '重命名',
                                                icon: <EditOutlined />,
                                                onClick: () => onRename(stock),
                                            },
                                            {
                                                key: 'overlay-timeline',
                                                label: '叠加分时',
                                                icon: <LineChartOutlined />,
                                                onClick: () => onOpenOverlayTimeLine(stock),
                                            },
                                            {
                                                key: 'backtest',
                                                label: '回测',
                                                icon: <ExperimentOutlined />,
                                                onClick: () => onBacktest(stock),
                                            },
                                            { type: 'divider' },
                                            {
                                                key: 'delete',
                                                label: '删除股票',
                                                icon: <DeleteOutlined />,
                                                danger: true,
                                                onClick: ({ domEvent }) => onDeleteStock(domEvent, stock.code),
                                            },
                                        ],
                                    }}
                                >
                                    <div
                                        className={`all-stock-item ${stock.isImportant ? 'important' : ''} ${stock.isTop ? 'top' : ''}`}
                                        data-is-up={isUp}
                                        data-code={stock.code}
                                        onClick={() => onStockClick({ name: stock.stockName, code: stock.code, change: kline.change })}
                                    >
                                        <div
                                            className="star-btn"
                                            onClick={(e) => onToggleImportant(e, stock.code)}
                                        >
                                            {stock.isImportant ? <StarFilled /> : <StarOutlined />}
                                        </div>
                                        <div className="stock-info-cell">
                                            <div className="stock-name-row" style={{ flexWrap: 'nowrap' }}>
                                                <Text className="stock-name" style={titleStyle(themeColor)}>
                                                    {stock.stockName}
                                                    {hasGoodNews(stock.stockName) && (
                                                        <span
                                                            className="good-news-badge"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                onViewGoodNews(stock.stockName);
                                                            }}
                                                        >
                                                            (研报)
                                                        </span>
                                                    )}
                                                </Text>
                                                {stock.blockName && stock.blockName !== 'xxx' && (
                                                    <Tag size="small" className="stock-block-tag">{stock.blockName}</Tag>
                                                )}
                                            </div>
                                        </div>
                                        <div className="change-cell">
                                            <Text className="current-change" style={numberStyle(themeColor)}>{currentChange.toFixed(2)}%</Text>
                                        </div>
                                        <div className="main-fund-cell">
                                            <Text className={`main-fund-value ${fundClass}`} style={numberStyle(themeColor)}>{fundText}</Text>
                                        </div>
                                        <div
                                            className="delete-btn"
                                            onClick={(e) => onDeleteStock(e, stock.code)}
                                        >
                                            <DeleteOutlined />
                                        </div>
                                    </div>
                                </Dropdown>
                            );
                        })}
                    </>
                ) : (
                    <div style={{ padding: '40px 0' }}>
                        <Empty description="暂无股票数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                )}
            </div>
        </Card>
    );
};

export default WatchlistMonitor;
