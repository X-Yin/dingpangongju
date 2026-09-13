import { Card, Tag, Button } from 'antd';
import { ThunderboltOutlined, RiseOutlined, FallOutlined, UnorderedListOutlined } from '@ant-design/icons';

const StrategySidePanel = ({
  currentBucket, allSignals, currentIndex, dateDisplay,
  prevDayTechEmotion, prevDayIsIcePoint, todayHasIce,
  onOpenDrawer,
}) => {
  const hitSignals = allSignals.filter(s => s.index <= currentIndex);
  const bullishCount = hitSignals.reduce((sum, tp) => sum + tp.signals.filter(s => s.isBullish).length, 0);
  const bearishCount = hitSignals.reduce((sum, tp) => sum + tp.signals.filter(s => !s.isBullish).length, 0);

  const currentSignals = currentBucket?.signals || [];
  const recentHits = hitSignals
    .filter(tp => tp.index < currentIndex)
    .sort((a, b) => b.index - a.index)
    .slice(0, 3);

  const renderCard = (sig, time) => {
    const isBullish = sig.isBullish;
    return (
      <div key={`${time}-${sig.strategyId}`} className={`strategy-card ${isBullish ? 'bullish' : 'bearish'}`}>
        <div className="strategy-card-title">
          {time && <span className="strategy-card-time">{time}</span>}
          {isBullish ? <RiseOutlined style={{ color: '#389e0d' }} /> : <FallOutlined style={{ color: '#cf1322' }} />}
          {' '}{sig.title}
        </div>
        <div className="strategy-card-desc">{sig.description}</div>
      </div>
    );
  };

  return (
    <Card
      className="training-camp-strategy-panel"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ThunderboltOutlined style={{ color: '#1677ff' }} />
          <span>策略回测</span>
          {dateDisplay && <Tag color="blue" style={{ marginLeft: 8 }}>{dateDisplay}</Tag>}
        </div>
      }
      extra={
        <Button
          size="small"
          type="text"
          icon={<UnorderedListOutlined />}
          onClick={onOpenDrawer}
          disabled={hitSignals.length === 0}
        >
          全部({hitSignals.length})
        </Button>
      }
      variant="borderless"
      style={{ position: 'sticky', top: 16 }}
      styles={{ body: { padding: '12px 16px' } }}
    >
      <div className="strategy-stats">
        <div className="stat-card bullish">
          <div className="stat-num">{bullishCount}</div>
          <div className="stat-label">利好命中</div>
        </div>
        <div className="stat-card bearish">
          <div className="stat-num">{bearishCount}</div>
          <div className="stat-label">利空命中</div>
        </div>
      </div>

      {(prevDayTechEmotion !== null || todayHasIce) && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12, padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>
          {prevDayTechEmotion !== null && (
            <div>前日情绪: <strong style={{ color: prevDayIsIcePoint ? '#cf1322' : '#4b5563' }}>{prevDayTechEmotion.toFixed(1)}</strong>{prevDayIsIcePoint ? '（冰点）' : ''}</div>
          )}
          <div>当日冰点: {todayHasIce ? '触及' : '未触及'}</div>
        </div>
      )}

      <div className="strategy-current">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#374151' }}>
          当前桶 ({currentBucket?.displayTime || '--:--'})
        </div>
        {currentSignals.length > 0 ? (
          currentSignals.map(sig => renderCard(sig, currentBucket?.displayTime))
        ) : (
          <div className="strategy-empty">当前时间桶未命中策略</div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#374151', borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
          最近命中
        </div>
        {recentHits.length === 0 ? (
          <div className="strategy-empty">暂无历史命中</div>
        ) : (
          recentHits.map(tp => tp.signals.map(sig => renderCard(sig, tp.time)))
        )}
      </div>
    </Card>
  );
};

export default StrategySidePanel;
