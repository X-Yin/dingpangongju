import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Card, Popover, Button, Modal, Input, Empty, Tooltip, message, Popconfirm } from 'antd';
import { StarFilled, LineChartOutlined, ReloadOutlined, PlusOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { local_ip } from '../../../../constant';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

const POLL_INTERVAL = 15 * 1000;

// 自治组件：自己轮询重点板块列表 + 实时板块数据。
// 展示样式与「自定义板块涨幅前十」（BlockRankingCards）完全一致：
// blocks-grid + unified-list-item 紧凑卡片，hover Popover 展示成分股涨跌幅
// 卡片 extra 区域提供「添加」按钮打开重点板块管理弹窗（搜索 + 切换）；
// 每个重点板块 item hover 时左上角出现删除按钮（取消重点）。
const KeyBlocksMonitor = ({ onBlockClick, onOpenOverlayTimeLine, overlayInlineAddStock, onShowKLine, themeColor }) => {
    // 重点板块列表（已排好顺序，用于卡片展示）
    const [orderedBlocks, setOrderedBlocks] = useState([]);
    // 当前重点板块名称 Set（用于快速判断某个板块是否重点）
    const [keyBlockNames, setKeyBlockNames] = useState(new Set());
    // 全部板块数据（blockName -> { avgChange, stocks:[...] }），Modal 打开时展示
    const [allBlocks, setAllBlocks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    // 管理弹窗
    const [manageOpen, setManageOpen] = useState(false);
    const [searchKeyword, setSearchKeyword] = useState('');
    const [togglingBlock, setTogglingBlock] = useState(null); // 当前正在切换的板块名

    const fetchAll = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        try {
            let names = [];
            try {
                const r1 = await axios.get(`http://${local_ip}:3000/api/key_blocks`);
                names = Array.isArray(r1.data?.data) ? r1.data.data : [];
            } catch (e) {
                console.error('KeyBlocksMonitor 拉重点板块失败:', e.message);
                names = [];
            }

            let blocks = [];
            try {
                const r2 = await axios.get(`http://${local_ip}:3000/block`);
                blocks = Array.isArray(r2.data) ? r2.data : [];
            } catch (e) {
                console.error('KeyBlocksMonitor 拉板块数据失败:', e.message);
                blocks = [];
            }

            const dataMap = new Map();
            const allBlockList = blocks.map((b) => {
                const stocks = Array.isArray(b.data) ? b.data : [];
                const sorted = stocks.slice().sort((s1, s2) => (Number(s2.change) || 0) - (Number(s1.change) || 0));
                dataMap.set(b.blockName, {
                    avgChange: Number(b.avgChange) || 0,
                    stocks: sorted,
                });
                return {
                    blockName: b.blockName,
                    avgChange: Number(b.avgChange) || 0,
                    stockCount: stocks.length,
                };
            });

            const ordered = names.map((n) => {
                const hit = dataMap.get(n);
                return {
                    blockName: n,
                    avgChange: hit?.avgChange || 0,
                    stockCount: hit ? hit.stocks.length : 0,
                    allStocks: hit ? hit.stocks : [],
                };
            });

            setKeyBlockNames(new Set(names));
            setAllBlocks(allBlockList);
            setOrderedBlocks(ordered);
        } catch (err) {
            console.error('KeyBlocksMonitor fetchAll 异常:', err);
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    useEffect(() => {
        let alive = true;
        fetchAll(false);
        const timer = setInterval(() => {
            if (alive) fetchAll(true);
        }, POLL_INTERVAL);
        return () => { alive = false; clearInterval(timer); };
    }, [fetchAll]);

    const handleManualRefresh = async () => {
        setRefreshing(true);
        try {
            await fetchAll(true);
        } finally {
            setRefreshing(false);
        }
    };

    // 切换某板块是否为重点（add/remove），同时保持本地 Set 乐观更新
    const toggleKeyBlock = async (blockName, isKey) => {
        if (!blockName) return;
        setTogglingBlock(blockName);
        // 乐观更新：先改本地 Set，失败时回滚
        const prevSet = new Set(keyBlockNames);
        const nextSet = new Set(keyBlockNames);
        if (isKey) nextSet.add(blockName); else nextSet.delete(blockName);
        setKeyBlockNames(nextSet);
        // orderedBlocks 也乐观更新顺序（remove 时直接过滤；add 时追加）
        let prevOrdered = orderedBlocks;
        let nextOrdered = orderedBlocks.slice();
        if (!isKey) {
            nextOrdered = nextOrdered.filter((b) => b.blockName !== blockName);
        } else {
            const info = allBlocks.find((b) => b.blockName === blockName);
            nextOrdered.push({
                blockName,
                avgChange: info?.avgChange || 0,
                stockCount: info?.stockCount || 0,
                allStocks: [],
            });
        }
        setOrderedBlocks(nextOrdered);

        try {
            const res = await axios.post(`http://${local_ip}:3000/api/key_blocks`, {
                action: isKey ? 'add' : 'remove',
                blockName,
            });
            if (res.data?.success) {
                // 用后端返回的顺序纠正（后端可能有自己的重排逻辑）
                const finalNames = Array.isArray(res.data.data) ? res.data.data : Array.from(nextSet);
                const hitMap = new Map(nextOrdered.map((b) => [b.blockName, b]));
                setKeyBlockNames(new Set(finalNames));
                setOrderedBlocks(finalNames.map((n) => hitMap.get(n) || {
                    blockName: n,
                    avgChange: 0,
                    stockCount: 0,
                    allStocks: [],
                }));
                message.success(isKey ? `已将「${blockName}」设为重点板块` : `已取消「${blockName}」的重点标记`);
            } else {
                throw new Error(res.data?.message || '保存失败');
            }
        } catch (e) {
            // 回滚
            setKeyBlockNames(prevSet);
            setOrderedBlocks(prevOrdered);
            message.error(`保存失败：${e.message}`);
        } finally {
            setTogglingBlock(null);
        }
    };

    // 叠加整个板块的成分股到分时观察
    const overlayAllStocks = (block) => {
        if (!block?.allStocks?.length) return;
        block.allStocks.forEach((s, idx) => {
            setTimeout(() => {
                try {
                    localStorage.setItem('dingpan_overlay_add_stock', JSON.stringify({
                        code: s.code,
                        stockName: s.name,
                        change: s.change,
                        _ts: Date.now(),
                        _fromKeyBlocks: true,
                    }));
                    localStorage.setItem('dingpan_overlay_add_stock_ts', String(Date.now()));
                } catch (e) { /* 忽略 */ }
            }, idx * 100);
        });
    };

    const overlayOneStock = (s) => {
        onOpenOverlayTimeLine && onOpenOverlayTimeLine({
            code: s.code,
            stockName: s.name,
            change: s.change,
            _ts: Date.now(),
        });
    };

    const pct = (v) => {
        const num = Number(v);
        if (!Number.isFinite(num)) return '--';
        return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
    };

    // 搜索过滤后的全部板块列表：重点优先，非重点按名称排序
    const filteredBlocks = useMemo(() => {
        const kw = (searchKeyword || '').trim().toLowerCase();
        const all = allBlocks.filter((b) => !kw || b.blockName.toLowerCase().includes(kw));
        const keyList = all.filter((b) => keyBlockNames.has(b.blockName)).sort((a, b) => {
            // 保持重点板块顺序与后端一致
            const ai = Array.from(keyBlockNames).indexOf(a.blockName);
            const bi = Array.from(keyBlockNames).indexOf(b.blockName);
            return ai - bi;
        });
        const otherList = all.filter((b) => !keyBlockNames.has(b.blockName)).sort((a, b) => a.blockName.localeCompare(b.blockName));
        return [...keyList, ...otherList];
    }, [allBlocks, keyBlockNames, searchKeyword]);

    const renderBlockStockPopover = (b) => (
        <div className="kb-pop-body">
            {/* <div className="kb-pop-toolbar">
                <Button
                    size="small"
                    type="link"
                    icon={<LineChartOutlined />}
                    disabled={!b.allStocks.length}
                    onClick={(e) => {
                        e.stopPropagation();
                        overlayAllStocks(b);
                    }}
                >全部叠加分时</Button>
            </div> */}
            {b.allStocks.length === 0 ? (
                <div className="kb-pop-empty">暂无成分股数据</div>
            ) : (
                <div className="block-stock-list">
                    {b.allStocks.map((s, i) => (
                        <div
                            key={s.code || i}
                            className="block-stock-item"
                            onClick={(e) => {
                                // 点击 tooltip 里的股票 → 打开通用 K 线弹窗
                                e.stopPropagation();
                                onShowKLine && onShowKLine({
                                    code: s.code,
                                    name: s.name,
                                    change: s.change,
                                });
                            }}
                        >
                            <span className="block-stock-name">{s.name}</span>
                            <span className={`block-stock-change ${Number(s.change) >= 0 ? 'up' : 'down'}`}>
                                {pct(s.change)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <>
            <Card
                title={<><StarFilled style={{ color: '#f59e0b', marginRight: 8, userSelect: 'none' }} /> 重点板块</>}
                className="monitor-card key-blocks-card compact-head-card"
                variant="borderless"
                bodyStyle={{ padding: '12px 14px' }}
                extra={
                    <div className="kb-card-extra">
                        <Tooltip title="添加 / 管理重点板块">
                            <PlusOutlined
                                className="kb-extra-btn"
                                style={{ cursor: 'pointer', fontSize: 14, color: '#ea580c' }}
                                onClick={() => {
                                    setSearchKeyword('');
                                    setManageOpen(true);
                                }}
                            />
                        </Tooltip>
                        <ReloadOutlined
                            spin={refreshing}
                            style={{ cursor: 'pointer', fontSize: 14, marginLeft: 12 }}
                            onClick={handleManualRefresh}
                        />
                    </div>
                }
                style={{ marginBottom: 8 }}
            >
                {loading && orderedBlocks.length === 0 ? (
                    <div className="kb-empty-tip">加载中...</div>
                ) : orderedBlocks.length === 0 ? (
                    <div className="kb-empty-tip">
                        暂无重点板块 ·
                        <a
                            onClick={() => {
                                setSearchKeyword('');
                                setManageOpen(true);
                            }}
                        >点此添加</a>
                    </div>
                ) : (
                    <div className="blocks-grid">
                        {orderedBlocks.map((b) => {
                            const isToggling = togglingBlock === b.blockName;
                            return (
                                <Popover
                                    key={b.blockName}
                                    content={renderBlockStockPopover(b)}
                                    title={<span style={{ fontSize: '13px', fontWeight: 600 }}>{b.blockName} · 成分股涨跌幅（{b.stockCount} 只）</span>}
                                    trigger="hover"
                                    placement="top"
                                    overlayClassName="block-stock-popover"
                                    mouseEnterDelay={0.3}
                                    mouseLeaveDelay={0.1}
                                >
                                    <div
                                        className="unified-list-item kb-item-with-delete"
                                        onClick={() => onBlockClick && onBlockClick(b.blockName)}
                                        style={borderStyle(themeColor)}
                                    >
                                        {/* 悬浮删除按钮（交互参考主题包弹窗：白底灰字 + 左侧滑入 + Popconfirm 防误触） */}
                                        <Popconfirm
                                            title={`取消重点板块「${b.blockName}」？`}
                                            okText="取消重点"
                                            cancelText="算了"
                                            okButtonProps={{ danger: true, loading: isToggling }}
                                            onConfirm={(e) => {
                                                e.stopPropagation();
                                                if (isToggling) return;
                                                toggleKeyBlock(b.blockName, false);
                                            }}
                                        >
                                            <span
                                                className="kb-item-delete"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <DeleteOutlined />
                                            </span>
                                        </Popconfirm>
                                        <div className="item-name">
                                            <span style={{ userSelect: 'none', fontSize: '12px', ...titleStyle(themeColor) }}>{b.blockName}</span>
                                        </div>
                                        <span
                                            className={`item-value ${Number(b.avgChange) >= 0 ? 'up' : 'down'}`}
                                            style={{ userSelect: 'none', ...numberStyle(themeColor) }}
                                        >
                                            {pct(b.avgChange)}
                                        </span>
                                    </div>
                                </Popover>
                            );
                        })}
                    </div>
                )}
            </Card>

            {/* 重点板块管理弹窗 */}
            <Modal
                open={manageOpen}
                onCancel={() => setManageOpen(false)}
                footer={null}
                width={540}
                centered
                className="kb-manage-modal"
                title={
                    <div className="kb-manage-header">
                        <StarFilled style={{ color: '#f59e0b', marginRight: 8 }} />
                        <span>管理重点板块</span>
                        <span className="kb-manage-count">
                            已选 {keyBlockNames.size} / 共 {allBlocks.length} 个板块
                        </span>
                    </div>
                }
            >
                <div className="kb-manage-search">
                    <Input
                        allowClear
                        prefix={<SearchOutlined style={{ color: '#8a97ae' }} />}
                        placeholder="搜索板块名称"
                        value={searchKeyword}
                        onChange={(e) => setSearchKeyword(e.target.value)}
                    />
                </div>
                {filteredBlocks.length === 0 ? (
                    <Empty description="暂无匹配板块" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '28px 0' }} />
                ) : (
                    <div className="kb-manage-list">
                        {filteredBlocks.map((b) => {
                            const isKey = keyBlockNames.has(b.blockName);
                            const isToggling = togglingBlock === b.blockName;
                            return (
                                <div
                                    key={b.blockName}
                                    className={`kb-manage-item ${isKey ? 'is-key' : ''}`}
                                    onClick={() => {
                                        if (isToggling) return;
                                        toggleKeyBlock(b.blockName, !isKey);
                                    }}
                                >
                                    <div className="kb-manage-item-info">
                                        <span className="kb-manage-item-name">
                                            {isKey && <StarFilled className="kb-manage-item-star" />}
                                            {b.blockName}
                                        </span>
                                        <span className="kb-manage-item-count">{b.stockCount} 只</span>
                                    </div>
                                    <div className="kb-manage-item-right">
                                        <span className={`kb-manage-item-change ${Number(b.avgChange) >= 0 ? 'up' : 'down'}`}>
                                            {pct(b.avgChange)}
                                        </span>
                                        <Button
                                            size="small"
                                            type={isKey ? 'primary' : 'default'}
                                            ghost={!isKey}
                                            loading={isToggling}
                                            icon={isKey ? <StarFilled /> : <StarFilled />}
                                        >
                                            {isKey ? '已重点' : '设为重点'}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </Modal>
        </>
    );
};

export default KeyBlocksMonitor;
