import { Modal, Button, Empty, Tag, Tooltip, Popconfirm } from 'antd';
import { DeleteOutlined, RadarChartOutlined, WalletOutlined, UndoOutlined } from '@ant-design/icons';

const toNumber = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

const formatPrice = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(2));

const formatDate = (d) => {
  const s = String(d || '');
  return s.length === 8 ? `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}` : s;
};

const formatReturn = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const returnColor = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '#8c8c8c';
  return v >= 0 ? '#cf1322' : '#059669';
};

// 训练营回放：查看模拟持仓弹窗
const SimPositionsModal = ({ open, onClose, positions = [], currentBucket, onSellDiagnosis, onDelete, onRollback, onReset }) => {
  const stockMap = new Map((currentBucket?.stockChanges || []).map(s => [s.code, s]));
  const holdings = positions.filter(p => p.status !== 'sold');
  const sold = positions.filter(p => p.status === 'sold');

  const renderPosition = (p) => {
    const cur = stockMap.get(p.code);
    const currentPrice = cur?.lastPx != null ? toNumber(cur.lastPx) : null;
    const change = cur?.changePct != null ? toNumber(cur.changePct) : null;
    const isSold = p.status === 'sold';
    // 已卖出：使用卖出价计算收益率；持有中：使用当前价计算浮盈浮亏
    const refPrice = isSold ? toNumber(p.sellPrice) : currentPrice;
    const buyPrice = toNumber(p.buyPrice);
    const returnRate = buyPrice !== null && buyPrice > 0 && refPrice !== null
      ? parseFloat((((refPrice - buyPrice) / buyPrice) * 100).toFixed(2))
      : null;

    return (
      <div
        key={p.id}
        style={{
          borderRadius: 10,
          padding: '10px 14px',
          marginBottom: 8,
          background: isSold ? '#fafafa' : '#fff',
          border: `1px solid ${isSold ? '#e5e7eb' : '#e5e7eb'}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 180px', minWidth: 180 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#12213a' }}>{p.stockName || p.code}</span>
            {p.code ? <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{p.code}</span> : null}
            {isSold ? (
              <Tag color="default" style={{ marginLeft: 4 }}>已卖出</Tag>
            ) : (
              <Tag color="blue" style={{ marginLeft: 4 }}>持有中</Tag>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            买入价 {formatPrice(buyPrice)} @ {p.buyDate ? `${formatDate(p.buyDate)} ` : ''}{p.buyDisplayTime || '--'}
            {isSold ? ` · 卖出价 ${formatPrice(p.sellPrice)} @ ${p.sellTimeKey || '--'}` : ` · 当前价 ${formatPrice(currentPrice)}`}
          </div>
        </div>

        <div style={{ flex: '0 0 110px', textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>收益率</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'SF Mono', monospace", color: returnColor(returnRate) }}>
            {formatReturn(returnRate)}
          </div>
        </div>

        <div style={{ flex: '0 0 80px', textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>当日涨幅</div>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'SF Mono', monospace", color: change !== null ? (change >= 0 ? '#cf1322' : '#059669') : '#8c8c8c' }}>
            {change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '--'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {isSold && (
            <Tooltip title="回退为持有中（买入日期与价格保持不变）">
              <Button
                size="small"
                icon={<UndoOutlined />}
                style={{ color: '#1677ff', borderColor: '#1677ff' }}
                onClick={() => onRollback(p.id)}
              >
                回退
              </Button>
            </Tooltip>
          )}
          <Button
            size="small"
            icon={<RadarChartOutlined />}
            style={{ color: '#fa8c16', borderColor: '#fa8c16' }}
            onClick={() => onSellDiagnosis(p)}
          >
            卖点诊断
          </Button>
          <Tooltip title="删除该模拟持仓">
            <Popconfirm title={`删除模拟持仓「${p.stockName || p.code}」？`} onConfirm={() => onDelete(p.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={720}
      title={
        <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>
          <WalletOutlined style={{ color: '#1677ff', marginRight: 8 }} />
          查看模拟持仓
          <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7890', marginLeft: 10 }}>
            持有 {holdings.length} 只 · 已卖出 {sold.length} 只
          </span>
        </span>
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {positions.length > 0 && (
            <Popconfirm title="确定重置所有模拟持仓吗？将清空 localStorage 中的全部持仓记录" onConfirm={onReset} okText="重置" cancelText="取消" okButtonProps={{ danger: true }}>
              <Button danger icon={<DeleteOutlined />}>重置</Button>
            </Popconfirm>
          )}
          <Button type="primary" size="large" style={{ borderRadius: 999, padding: '0 28px' }} onClick={onClose}>
            关闭
          </Button>
        </div>
      }
      centered
    >
      {positions.length === 0 ? (
        <Empty description="暂无模拟持仓，可在买点诊断命中弹窗中添加" style={{ padding: '24px 0' }} />
      ) : (
        <div style={{ maxHeight: 480, overflowY: 'auto', padding: '4px 2px' }}>
          {positions.map(renderPosition)}
        </div>
      )}
    </Modal>
  );
};

export default SimPositionsModal;
