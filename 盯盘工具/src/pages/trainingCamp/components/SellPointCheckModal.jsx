import { Modal, Button } from 'antd';
import { CloseCircleOutlined, CheckCircleOutlined, WarningOutlined, ClockCircleOutlined } from '@ant-design/icons';
import '../../../components/FloatingBuyPointDiagnosis/index.scss';

const formatReturn = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

// 训练营回放：模拟持仓卖点诊断弹窗（模仿 FloatingStockPosition 的卖点诊断弹窗）
// results 为数组（结构来自 utils/sellPointChecks.js 的 runSellPointDiagnosis，含 positionId），
// 支持同时展示多只触发卖点的股票卡片，弹窗高度固定为屏幕高度 80%，内容区内部上下滚动
const SellPointCheckModal = ({ open, results = [], onClose, onSellConfirmed }) => {
  if (!results || results.length === 0) return null;
  const displayTime = results[0]?.displayTime || '';

  const renderStockCard = (result, isLast) => {
    const {
      isSell = false,
      stockName = '',
      code = '',
      closePrice = null,
      change = null,
      returnRate = null,
      conditions = [],
      conclusion = '',
    } = result;
    const returnPositive = returnRate !== null && returnRate >= 0;

    return (
      <div key={result.positionId || code} style={{ padding: '14px 0', borderBottom: isLast ? 'none' : '1px dashed #d9e2ec' }}>
        {/* 股票信息 + 当前价 + 确认卖出 */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#12213a' }}>{stockName}</span>
          {code ? <span style={{ fontSize: 12, color: '#8c8c8c', fontFamily: "'SF Mono', monospace" }}>{code}</span> : null}
          {change !== null && change !== undefined && (
            <span style={{ color: change >= 0 ? '#e11d48' : '#059669', fontWeight: 600, fontSize: 14 }}>
              {change >= 0 ? '+' : ''}{Number(change).toFixed(2)}%
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#8c8c8c' }}>
            当前价{' '}
            <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace", fontSize: 15 }}>
              {closePrice !== null && closePrice !== undefined ? Number(closePrice).toFixed(2) : '--'}
            </b>
          </span>
          {isSell && onSellConfirmed && (
            <Button
              type="primary"
              danger
              size="small"
              style={{ borderRadius: 999, padding: '0 16px', marginLeft: 8 }}
              onClick={() => onSellConfirmed(result)}
            >
              确认卖出
            </Button>
          )}
        </div>

        {/* 收益率卡片 */}
        <div
          style={{
            borderRadius: 10,
            padding: '12px 16px',
            marginBottom: 14,
            background: returnPositive ? '#fff1f0' : '#f6ffed',
            border: `1px solid ${returnPositive ? '#ffa39e' : '#b7eb8f'}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 13, color: '#595959' }}>本次收益率</span>
          <span
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: returnPositive ? '#cf1322' : '#389e0d',
              fontFamily: "'SF Mono', monospace",
            }}
          >
            {formatReturn(returnRate)}
          </span>
          <span style={{ fontSize: 12, color: '#8c8c8c', marginLeft: 'auto' }}>
            {isSell ? '按当前卖点价格计算' : '按当前价格计算（浮盈浮亏）'}
          </span>
        </div>

        {/* 条件卡片 */}
        <div className="fbd-checks-list" style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {conditions.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#8c8c8c', padding: '16px 0', fontSize: 13 }}>{conclusion}</div>
          ) : (
            conditions.map((cond, idx) => (
              <div key={idx} style={{ borderRadius: 10, padding: '10px 12px', background: cond.satisfied ? '#fff1f0' : cond.pending ? '#fff7e6' : '#f6ffed', border: `1px solid ${cond.satisfied ? '#ffa39e' : cond.pending ? '#ffd591' : '#b7eb8f'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: cond.subConditions?.length ? 6 : 0 }}>
                  {cond.satisfied ? (
                    <CloseCircleOutlined style={{ color: '#cf1322', fontSize: 16, flexShrink: 0 }} />
                  ) : cond.pending ? (
                    <ClockCircleOutlined style={{ color: '#fa8c16', fontSize: 16, flexShrink: 0 }} />
                  ) : (
                    <CheckCircleOutlined style={{ color: '#389e0d', fontSize: 16, flexShrink: 0 }} />
                  )}
                  <span style={{ fontWeight: 600, fontSize: 13, color: cond.satisfied ? '#cf1322' : cond.pending ? '#fa8c16' : '#389e0d' }}>{cond.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, padding: '1px 8px', borderRadius: 999, background: cond.satisfied ? '#ff4d4f' : cond.pending ? '#fa8c16' : '#52c41a', color: '#fff' }}>
                    {cond.satisfied ? '触发' : cond.pending ? `确认中 ${cond.pendingMinutes || 0}/5min` : '未触发'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#595959', marginLeft: 24, marginBottom: cond.subConditions?.length ? 6 : 0 }}>{cond.detail}</div>
                {cond.subConditions && cond.subConditions.length > 0 && (
                  <div style={{ marginLeft: 24, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 16px', fontSize: 11 }}>
                    {cond.subConditions.map((sub, sidx) => (
                      <div key={sidx} style={{ display: 'flex', gap: 4 }}>
                        <span style={{ color: '#8c8c8c' }}>{sub.label}:</span>
                        <span style={{ color: '#12213a', fontWeight: 600, fontFamily: "'SF Mono', monospace" }}>{sub.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* 结论 */}
        <div
          style={{
            borderRadius: 10,
            padding: '14px 16px',
            background: isSell ? '#fff1f0' : '#f0f9ff',
            border: `1px solid ${isSell ? '#ffa39e' : '#91caff'}`,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          {isSell ? (
            <WarningOutlined style={{ color: '#cf1322', fontSize: 20, flexShrink: 0, marginTop: 1 }} />
          ) : (
            <CheckCircleOutlined style={{ color: '#1677ff', fontSize: 20, flexShrink: 0, marginTop: 1 }} />
          )}
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: isSell ? '#cf1322' : '#1677ff', marginBottom: 4 }}>
              {isSell ? '⚠️ 建议卖出' : '✅ 建议持有'}
            </div>
            <div style={{ fontSize: 13, color: isSell ? '#a8071a' : '#0958d9', lineHeight: '20px' }}>{conclusion}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={680}
      style={{ top: '10vh' }}
      styles={{ body: { height: 'calc(80vh - 130px)', overflowY: 'auto' } }}
      title={
        <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>
          ⚠️ 卖点诊断
          {displayTime ? <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7890', marginLeft: 8 }}>{displayTime}</span> : null}
          {results.length > 1 ? <span style={{ fontSize: 12, fontWeight: 600, color: '#cf1322', marginLeft: 8 }}>（{results.length} 只触发）</span> : null}
        </span>
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose} style={{ borderRadius: 999, padding: '0 20px' }}>
            继续播放
          </Button>
        </div>
      }
      className="buy-point-check-modal"
    >
      <div style={{ padding: '0 4px' }}>
        {results.map((result, idx) => renderStockCard(result, idx === results.length - 1))}
      </div>
    </Modal>
  );
};

export default SellPointCheckModal;
