import { useCallback, useState } from 'react';
import { Card, Empty, Popover, Spin } from 'antd';
import { RiseOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../constant';

// 板块成分股分钟级涨幅缓存（key: `${date}_${blockName}`）
// 板块成分股不在自选股清单内，回放数据包里没有它们的分时，故 hover 板块时按需拉取一次后常驻内存
const blockStocksCache = new Map();
const blockStocksFetching = new Set();

// 取回放时间点（HHMM）对应的涨幅：分时序列中取最后一个 minute <= 当前 minute 的点
const pickChangeAtMinute = (points, minute) => {
  if (!Array.isArray(points) || minute == null) return null;
  let value = null;
  for (const [m, c] of points) {
    if (m <= minute) value = c;
    else break;
  }
  return value;
};

// 置顶板块（按此顺序排在卡片最前面，其余板块按涨幅降序跟在后面）。
// 匹配时统一小写并去掉空格，兼容数据里 MPO / cpo / 「AI 剧」这类大小写与空格差异
const PINNED_BLOCKS = ['光通信', 'mpo', 'pcb', 'ccl', '电子布', '铜箔', '半导体', '物理ai', 'ai剧', '国产超节点', '华为', '先进封装'];
const normalizeBlockName = (name) => String(name || '').toLowerCase().replace(/\s+/g, '');
const PINNED_INDEX = new Map(PINNED_BLOCKS.map((n, i) => [normalizeBlockName(n), i]));

// 置顶板块在前展示；「全部板块」区包含所有板块（含置顶），保证完整排名可见
const splitBlocksWithPinned = (list) => {
  const pinned = [];
  for (const item of list) {
    if (PINNED_INDEX.has(normalizeBlockName(item.blockName))) pinned.push(item);
  }
  const byChangeDesc = (a, b) => b.avgChange - a.avgChange;
  pinned.sort(byChangeDesc);
  const rest = [...list].sort(byChangeDesc);
  return { pinned, rest };
};

// 板块涨跌幅统一卡片：展示全部板块涨跌幅，hover 板块弹出成分股在该回放时间点的实时涨幅
const BlockChangeBoard = ({ blocks = [], replayDate, replayMinute, displayTime, onBlockClick, onStockClick }) => {
  const [, setTick] = useState(0);

  const ensureBlockStocks = useCallback((blockName) => {
    if (!replayDate || !blockName) return;
    const key = `${replayDate}_${blockName}`;
    if (blockStocksCache.has(key) || blockStocksFetching.has(key)) return;
    blockStocksFetching.add(key);
    axios.get(`http://${local_ip}:3000/training_camp/block_stocks`, { params: { date: replayDate, block: blockName } })
      .then((res) => {
        // 先进先出淘汰，避免来回切换多个回放日期时缓存无限增长
        if (blockStocksCache.size >= 600) {
          const oldest = blockStocksCache.keys().next().value;
          if (oldest !== undefined) blockStocksCache.delete(oldest);
        }
        blockStocksCache.set(key, Array.isArray(res.data?.stocks) ? res.data.stocks : []);
      })
      .catch(() => blockStocksCache.set(key, []))
      .finally(() => {
        blockStocksFetching.delete(key);
        setTick(t => t + 1);
      });
  }, [replayDate]);

  const renderBlockStocks = (blockName) => {
    const key = `${replayDate}_${blockName}`;
    const stocks = blockStocksCache.get(key);
    if (!stocks) {
      return <div className="block-change-pop-tip"><Spin size="small" /> 加载成分股...</div>;
    }
    const rows = stocks
      .map(s => ({ code: s.code, name: s.name, change: pickChangeAtMinute(s.points, replayMinute) }))
      .filter(s => s.change != null)
      .sort((a, b) => b.change - a.change);
    if (rows.length === 0) {
      return <div className="block-change-pop-tip">暂无成分股分时数据</div>;
    }
    return (
      <div className="block-stock-list">
        {rows.map(s => (
          <div
            key={s.code}
            className={`block-stock-item ${onStockClick ? 'clickable' : ''}`}
            onClick={() => onStockClick?.({ code: s.code, name: s.name, change: s.change })}
          >
            <span className="block-stock-name">{s.name}</span>
            <span className={`block-stock-change ${s.change >= 0 ? 'up' : 'down'}`}>
              {s.change > 0 ? '+' : ''}{s.change}%
            </span>
          </div>
        ))}
      </div>
    );
  };

  const renderBlockChip = (item, isPinned) => (
    <Popover
      key={item.blockName}
      trigger="hover"
      placement="left"
      overlayClassName="block-stock-popover"
      mouseEnterDelay={0.2}
      mouseLeaveDelay={0.1}
      title={<span style={{ fontSize: 13, fontWeight: 600 }}>{item.blockName} · 成分股涨跌幅（{displayTime || '--'}）</span>}
      content={renderBlockStocks(item.blockName)}
    >
      <div
        className={`unified-list-item ${isPinned ? 'pinned-block' : ''}`}
        onMouseEnter={() => ensureBlockStocks(item.blockName)}
        onClick={() => onBlockClick?.(item.blockName)}
      >
        <div className="item-name">
          {isPinned && <span className="pinned-dot" />}
          <span style={{ userSelect: 'none', fontSize: 12 }}>{item.blockName}</span>
        </div>
        <span className={`item-value ${item.avgChange > 0 ? 'up' : 'down'}`} style={{ userSelect: 'none' }}>
          {item.avgChange > 0 ? '+' : ''}{item.avgChange}%
        </span>
      </div>
    </Popover>
  );

  const { pinned, rest } = splitBlocksWithPinned(blocks);

  return (
    <Card
      className="monitor-card"
      variant="borderless"
      title={<span style={{ fontSize: 13, fontWeight: 600 }}><RiseOutlined style={{ marginRight: 6 }} />板块涨跌幅</span>}
      extra={<span style={{ fontSize: 12, color: '#6b7890' }}>{displayTime ? `回放 ${displayTime}` : '--'} · 悬停看成分股</span>}
      styles={{ body: { padding: '10px 12px', flex: 1, overflow: 'auto' } }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {blocks.length === 0 ? (
        <Empty description="暂无板块数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <>
          {pinned.length > 0 && (
            <div className="block-change-section">
              <div className="block-change-section-label">置顶板块</div>
              <div className="blocks-grid block-change-grid pinned-grid">
                {pinned.map(item => renderBlockChip(item, true))}
              </div>
            </div>
          )}
          {rest.length > 0 && (
            <div className="block-change-section">
              <div className="block-change-section-label">全部板块</div>
              <div className="blocks-grid block-change-grid">
                {rest.map(item => renderBlockChip(item, false))}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default BlockChangeBoard;
