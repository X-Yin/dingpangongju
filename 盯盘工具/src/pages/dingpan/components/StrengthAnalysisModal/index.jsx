import { useMemo, useState } from 'react';
import axios from 'axios';
import { Modal, Table, Input, Button, Spin, Tag, Tooltip } from 'antd';
import { SearchOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { local_ip } from '../../../../constant';
import './index.scss';

const CHANGE_COLOR = { up: '#e11d48', down: '#059669', flat: '#64748b' };

const formatScore = (value, max) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return `-- / ${max}`;
  return `${Number(value).toFixed(1)} / ${max}`;
};

const formatPct = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}%`;
};

const changeColor = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return CHANGE_COLOR.flat;
  if (Number(value) > 0) return CHANGE_COLOR.up;
  if (Number(value) < 0) return CHANGE_COLOR.down;
  return CHANGE_COLOR.flat;
};

// 涨停股明细表列
const LIMIT_UP_COLUMNS = [
  { title: '代码', dataIndex: 'code', width: 90 },
  { title: '名称', dataIndex: 'name', width: 140 },
  {
    title: '涨幅',
    dataIndex: 'changePct',
    width: 90,
    align: 'right',
    render: (value) => <span className="strength-limitup-change">{formatPct(value)}</span>,
  },
];

// 与 key_blocks 重点板块重叠的股票
const OVERLAP_COLUMNS = [
  { title: '代码', dataIndex: 'code', width: 88 },
  { title: '名称', dataIndex: 'name', width: 110 },
  {
    title: '涨幅',
    dataIndex: 'changePct',
    width: 88,
    align: 'right',
    render: (value) => <span className="strength-limitup-change">{formatPct(value)}</span>,
  },
  {
    title: '所属重点板块',
    dataIndex: 'blocks',
    render: (value) => (
      <span>
        {(value || []).map((name) => (
          <Tag key={name} color="blue" style={{ marginBottom: 2 }}>{name}</Tag>
        ))}
      </span>
    ),
  },
];

const normalizeCode = (code) => String(code || '').trim().replace(/^(sh|sz|bj)/i, '');

// 单元格：上方展示原始值，下方展示该项得分
const MetricCell = ({ value, color, score, max }) => (
  <div className="strength-metric-cell">
    <span className="strength-metric-value" style={color ? { color } : undefined}>{value}</span>
    <span className="strength-metric-score">得分 {formatScore(score, max)}</span>
  </div>
);

const StrengthAnalysisModal = ({ open, onCancel, result, loading, onRefresh, onStockClick }) => {
  const [keyword, setKeyword] = useState('');
  // 涨停股明细弹窗：{ name, stocks }，嵌套在当前强度分析弹窗之上
  const [limitUpDetail, setLimitUpDetail] = useState(null);
  // 当前板块成分股与 key_blocks 自定义板块的重叠股票
  const [overlapStocks, setOverlapStocks] = useState([]);
  // 各自定义板块的重叠股票数量：[{ name, count }]
  const [overlapBlockStats, setOverlapBlockStats] = useState([]);
  // 当前选中的重点板块 tag（为空表示展示全部重叠股票）
  const [activeBlock, setActiveBlock] = useState(null);
  const [overlapLoading, setOverlapLoading] = useState(false);

  const closeLimitUpDetail = () => {
    setLimitUpDetail(null);
    setOverlapStocks([]);
    setOverlapBlockStats([]);
    setActiveBlock(null);
    setOverlapLoading(false);
  };

  // 加载「当前板块全部成分股 ∩ key_blocks 自定义板块股票」，并记录每只股票所属的重点板块
  const loadOverlapStocks = async (blockName) => {
    if (!blockName) return;
    setOverlapStocks([]);
    setOverlapBlockStats([]);
    setActiveBlock(null);
    setOverlapLoading(true);
    try {
      const [blockResp, stocksResp] = await Promise.all([
        axios.get(`http://${local_ip}:3000/block`, { timeout: 30 * 1000 }),
        axios.get(`http://${local_ip}:3000/block_volume_ratio_stocks`, {
          params: { name: blockName },
          timeout: 60 * 1000,
        }),
      ]);

      const customMap = new Map();
      const customBlocks = Array.isArray(blockResp.data) ? blockResp.data : [];
      for (const block of customBlocks) {
        for (const stock of block.data || []) {
          const code = normalizeCode(stock.code);
          if (!code) continue;
          if (!customMap.has(code)) customMap.set(code, { blocks: new Set(), change: null });
          const entry = customMap.get(code);
          entry.blocks.add(block.blockName);
          if (Number.isFinite(Number(stock.change))) entry.change = Number(stock.change);
        }
      }

      const stocks = Array.isArray(stocksResp.data?.stocks) ? stocksResp.data.stocks : [];
      const list = stocks
        .map((stock) => {
          const code = normalizeCode(stock.code);
          const custom = customMap.get(code);
          if (!custom) return null;
          return {
            code,
            marketCode: stock.marketCode || '',
            name: stock.name,
            price: stock.price,
            changePct: Number.isFinite(Number(stock.changePct)) ? Number(stock.changePct) : custom.change,
            blocks: Array.from(custom.blocks),
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const aChange = Number(a.changePct);
          const bChange = Number(b.changePct);
          return (Number.isFinite(bChange) ? bChange : -999) - (Number.isFinite(aChange) ? aChange : -999);
        });

      setOverlapStocks(list);

      // 统计各自定义板块的重叠股票数量与平均涨幅（同一只股票属于多个板块时分别计数）
      const stats = new Map();
      for (const stock of list) {
        const change = Number(stock.changePct);
        for (const name of stock.blocks || []) {
          if (!stats.has(name)) stats.set(name, { count: 0, sum: 0, valid: 0 });
          const entry = stats.get(name);
          entry.count += 1;
          if (Number.isFinite(change)) {
            entry.sum += change;
            entry.valid += 1;
          }
        }
      }
      setOverlapBlockStats(
        Array.from(stats.entries())
          .map(([name, entry]) => ({
            name,
            count: entry.count,
            avgChange: entry.valid > 0 ? entry.sum / entry.valid : null,
          }))
          .sort((a, b) => b.count - a.count)
      );
    } catch (error) {
      console.warn('获取与重点板块重叠股票失败:', error.message);
      setOverlapStocks([]);
      setOverlapBlockStats([]);
    } finally {
      setOverlapLoading(false);
    }
  };

  // 关闭时清理搜索与涨停明细（数据由外层加载，打开前已准备完成）
  const handleCancel = () => {
    setKeyword('');
    closeLimitUpDetail();
    onCancel?.();
  };

  const rows = result?.rows || [];
  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter((row) => String(row.name).toLowerCase().includes(kw));
  }, [rows, keyword]);

  // 选中某个重点板块 tag 时，只展示属于该板块的重叠股票
  const visibleOverlapStocks = useMemo(() => (
    activeBlock
      ? overlapStocks.filter((stock) => (stock.blocks || []).includes(activeBlock))
      : overlapStocks
  ), [activeBlock, overlapStocks]);

  const weights = result?.weights || { avgChange: 30, limitUp: 40, dayRatio: 20, ratio30m: 20 };

  const columns = useMemo(() => [
    {
      title: '排名',
      key: 'rank',
      width: 56,
      align: 'center',
      render: (_, __, index) => <span className="strength-rank">{index + 1}</span>,
    },
    {
      title: '板块',
      dataIndex: 'name',
      width: 112,
      fixed: 'left',
      render: (value) => <span className="strength-block-name">{value}</span>,
    },
    {
      title: '综合评分',
      dataIndex: 'totalScore',
      width: 100,
      align: 'center',
      defaultSortOrder: 'descend',
      sortDirections: ['descend', 'ascend'],
      sorter: (a, b) => (Number(a.totalScore) || 0) - (Number(b.totalScore) || 0),
      render: (value) => (
        <span className="strength-total-score" style={{ color: changeColor(Number(value) - 50) }}>
          {Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '--'}
        </span>
      ),
    },
    {
      title: '平均涨幅',
      dataIndex: 'avgChange',
      width: 124,
      sortDirections: ['descend', 'ascend'],
      sorter: (a, b) => (a.avgChange === null ? -Infinity : a.avgChange) - (b.avgChange === null ? -Infinity : b.avgChange),
      render: (value, record) => (
        <MetricCell
          value={formatPct(value)}
          color={changeColor(value)}
          score={record.avgChangeScore}
          max={weights.avgChange}
        />
      ),
    },
    {
      title: '涨停家数',
      dataIndex: 'limitUpCount',
      width: 112,
      sortDirections: ['descend', 'ascend'],
      sorter: (a, b) => (Number(a.limitUpCount) || 0) - (Number(b.limitUpCount) || 0),
      render: (value, record) => {
        const clickable = value > 0;
        const cell = (
          <div
            className={clickable ? 'strength-limitup-clickable' : undefined}
            onClick={clickable
              ? () => {
                setLimitUpDetail({ name: record.name, stocks: record.limitUpStocks || [] });
                loadOverlapStocks(record.name);
              }
              : undefined}
          >
            <MetricCell
              value={`${value || 0} 个`}
              color={value > 0 ? CHANGE_COLOR.up : undefined}
              score={record.limitUpScore}
              max={weights.limitUp}
            />
          </div>
        );
        return clickable ? <Tooltip title="点击查看涨停股票">{cell}</Tooltip> : cell;
      },
    },
    {
      title: '日成交量占比',
      dataIndex: 'dayRatioChangePct',
      width: 156,
      sortDirections: ['descend', 'ascend'],
      sorter: (a, b) => (a.dayRatioChangePct === null ? -Infinity : a.dayRatioChangePct) - (b.dayRatioChangePct === null ? -Infinity : b.dayRatioChangePct),
      render: (value, record) => (
        <Tooltip
          title={`当日占比 ${formatPct(record.todayRatio)} ｜ 上一交易日（${record.prevDayDate || '--'}）占比 ${formatPct(record.prevDayRatio)}`}
        >
          <div>
            <MetricCell
              value={formatPct(value)}
              color={changeColor(value)}
              score={record.dayRatioScore}
              max={weights.dayRatio}
            />
          </div>
        </Tooltip>
      ),
    },
    {
      title: '较 30 分钟前占比',
      dataIndex: 'ratio30mChangePct',
      width: 168,
      sortDirections: ['descend', 'ascend'],
      sorter: (a, b) => (a.ratio30mChangePct === null ? -Infinity : a.ratio30mChangePct) - (b.ratio30mChangePct === null ? -Infinity : b.ratio30mChangePct),
      render: (value, record) => (
        <Tooltip
          title={`当日占比 ${formatPct(record.todayRatio)} ｜ ${record.ratio30mTime ? `${record.ratio30mTime.slice(0, 2)}:${record.ratio30mTime.slice(2, 4)}` : '30 分钟前'}占比 ${formatPct(record.ratio30mAgo)}`}
        >
          <div>
            <MetricCell
              value={formatPct(value)}
              color={changeColor(value)}
              score={record.ratio30mScore}
              max={weights.ratio30m}
            />
          </div>
        </Tooltip>
      ),
    },
  ], [weights]);

  return (
    <Modal
      title={
        <div className="strength-modal-title">
          <ThunderboltOutlined />
          <span>一级板块强度分析</span>
          {result && (
            <span className="strength-modal-sub">
              {rows.length} 个板块 · 更新于 {result.updatedAt}
            </span>
          )}
        </div>
      }
      open={open}
      onCancel={handleCancel}
      footer={null}
      width={1180}
      centered
      destroyOnClose
    >
      <div className="strength-toolbar">
        <div className="strength-meta">
          {result && (
            <>
              <Tag color="blue">个股行情 {result.spot?.source || '--'}</Tag>
              <Tag color="cyan">匹配 {((result.spot?.hitRate || 0) * 100).toFixed(1)}%</Tag>
              {result.intraday?.latestTime && (
                <Tag color="geekblue">
                  占比 {result.intraday.latestTime.slice(0, 2)}:{result.intraday.latestTime.slice(2, 4)}
                  {result.intraday.ratio30mTime
                    ? ` vs ${result.intraday.ratio30mTime.slice(0, 2)}:${result.intraday.ratio30mTime.slice(2, 4)}`
                    : ''}
                </Tag>
              )}
              <Tag color="purple">
                权重 涨幅{weights.avgChange} / 涨停{weights.limitUp} / 日占比{weights.dayRatio} / 30min{weights.ratio30m}
              </Tag>
            </>
          )}
        </div>
        <div className="strength-actions">
          <Input
            placeholder="搜索板块名称"
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            className="strength-search"
          />
          <span className="strength-count">{filteredRows.length} / {rows.length}</span>
          <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
            重新分析
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="strength-loading">
          <Spin size="large" />
          <div className="strength-loading-text">正在刷新全市场行情并计算板块强度…</div>
          <div className="strength-loading-sub">需要拉取全 A 股行情，请稍候</div>
        </div>
      ) : (
        <Table
          size="small"
          rowKey="name"
          columns={columns}
          dataSource={filteredRows}
          pagination={false}
          scroll={{ x: 900, y: 520 }}
          locale={{ emptyText: keyword ? '未匹配到板块' : '暂无强度分析数据' }}
          className="strength-table"
        />
      )}

      <div className="strength-tips">
        涨停口径：主板 ≥9.8%、创业板/科创板 ≥19.8%、ST ≥4.8%；占比增减为相对百分比，范围 ±{(result?.limits?.maxRatioChangePct ?? 100)}%，负值按比例扣分（仅涨停家数最低 0 分）。
        收盘后或非交易日，较 30 分钟前取最近交易日 15:00 对比 14:30。
      </div>

      <Modal
        title={`${limitUpDetail?.name || ''} 涨停股与重点板块重叠`}
        open={!!limitUpDetail}
        onCancel={closeLimitUpDetail}
        footer={null}
        width={1040}
        centered
        zIndex={1100}
        styles={{ body: { paddingTop: 8 } }}
      >
        <div className="strength-limitup-layout">
          <div className="strength-limitup-panel">
            <div className="strength-limitup-panel-title">
              <span>涨停股</span>
              <Tag color="red" style={{ marginInlineEnd: 0 }}>{limitUpDetail?.stocks?.length || 0}</Tag>
            </div>
            {limitUpDetail?.stocks?.length ? (
              <Table
                size="small"
                rowKey="code"
                columns={LIMIT_UP_COLUMNS}
                dataSource={[...limitUpDetail.stocks].sort(
                  (a, b) => (Number(b.changePct) || 0) - (Number(a.changePct) || 0)
                )}
                pagination={false}
                scroll={{ y: 420 }}
                className="strength-limitup-table"
                onRow={(record) => ({
                  onClick: () => onStockClick?.({
                    code: record.code,
                    name: record.name,
                    change: record.changePct,
                  }),
                  style: { cursor: 'pointer' },
                })}
              />
            ) : (
              <div className="strength-limitup-empty">暂无涨停股明细，请重启后端后重新分析</div>
            )}
          </div>

          <div className="strength-limitup-panel">
            <div className="strength-limitup-panel-title">
              <span>与重点板块重叠</span>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                {visibleOverlapStocks.length}{activeBlock ? ` / ${overlapStocks.length}` : ''}
              </Tag>
              <span className="strength-limitup-panel-hint">按涨幅从高到低，标签为所属 key_blocks 板块</span>
            </div>
            {overlapBlockStats.length > 0 && (
              <div className="strength-limitup-block-tags">
                {overlapBlockStats.map((item) => {
                  const checked = activeBlock === item.name;
                  return (
                    <Tag
                      key={item.name}
                      color={checked ? 'blue' : undefined}
                      onClick={() => setActiveBlock(checked ? null : item.name)}
                      style={{
                        cursor: 'pointer',
                        marginInlineEnd: 0,
                        userSelect: 'none',
                        opacity: activeBlock && !checked ? 0.55 : 1,
                        transition: 'opacity .2s',
                      }}
                    >
                      {item.name} {item.count} 只
                      <span style={{ marginLeft: 4 }}>
                        ·
                        <span style={{
                          marginLeft: 4,
                          color: item.avgChange === null ? '#94a3b8' : changeColor(item.avgChange),
                          fontWeight: 600,
                        }}>
                          {item.avgChange === null
                            ? '--'
                            : `${item.avgChange > 0 ? '+' : ''}${item.avgChange.toFixed(2)}%`}
                        </span>
                      </span>
                    </Tag>
                  );
                })}
              </div>
            )}
            {overlapLoading ? (
              <div className="strength-limitup-empty"><Spin size="small" /></div>
            ) : overlapStocks.length ? (
              <Table
                size="small"
                rowKey="code"
                columns={OVERLAP_COLUMNS}
                dataSource={visibleOverlapStocks}
                pagination={false}
                scroll={{ y: 420 }}
                className="strength-limitup-table"
                onRow={(record) => ({
                  onClick: () => onStockClick?.({
                    code: record.marketCode || record.code,
                    name: record.name,
                    change: record.changePct,
                  }),
                  style: { cursor: 'pointer' },
                })}
              />
            ) : (
              <div className="strength-limitup-empty">当前板块暂无与 key_blocks 重点板块重叠的股票</div>
            )}
          </div>
        </div>
      </Modal>
    </Modal>
  );
};

export default StrengthAnalysisModal;
