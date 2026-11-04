// 策略说明弹窗（2026-11-04）：开盘实战页候选卡片标题旁「?」图标打开，
// 内容与回测页（trainingCamp/BacktestDrawer）的「策略说明」弹窗保持一致：
//   基本信息 + 决策流程图 + 本策略专属说明 + 买入/卖出规则
import { Modal, Tabs, Tag } from 'antd';
import { BookOutlined } from '@ant-design/icons';
import StrategyFlowDiagram, {
  getStrategyFlow,
  parseNoteBullet,
  splitBoldClauses,
} from '../../pages/trainingCamp/components/BacktestDrawer/StrategyFlowDiagram';
import { STRATEGY_SPECIFIC_NOTES, getStrategyRuleSets } from '../../pages/trainingCamp/components/BacktestDrawer';

// 粗体解析：**xxx** → <strong>
const renderBold = (text, keyPrefix = 'b') => String(text).split('**').map((p, i) => (
  i % 2 === 1 ? <strong key={`${keyPrefix}-${i}`}>{p}</strong> : <span key={`${keyPrefix}-${i}`}>{p}</span>
));

// 编号圆点
const numDot = (n) => (
  <span style={{
    flexShrink: 0, width: 20, height: 20, borderRadius: '50%',
    background: '#1677ff', color: '#fff', fontSize: 11.5, fontWeight: 700,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
  }}>{n}</span>
);

// 单行子句：› 前缀 + 粗体解析
const clauseLine = (ln, keyPrefix) => (
  <div key={keyPrefix} style={{ fontSize: 12.5, color: '#4b5563', lineHeight: 1.75, display: 'flex', gap: 7, alignItems: 'flex-start', marginBottom: 3 }}>
    <span style={{ color: '#b7c1d4', flexShrink: 0, fontSize: 12 }}>›</span>
    <span style={{ flex: 1, minWidth: 0 }}>{renderBold(ln, keyPrefix)}</span>
  </div>
);

// 单条买入/卖出规则
const ruleRow = (item, idx) => (
  <div key={item.key || idx} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px dashed #eef1f6' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
      {numDot(idx + 1)}
      <div style={{ fontSize: 13, fontWeight: 700, color: '#12213a', flex: 1, minWidth: 0, paddingTop: 1 }}>
        {item.title}
      </div>
    </div>
    <div style={{ marginLeft: 28 }}>
      {splitBoldClauses(item.desc).map((ln, j) => clauseLine(ln, `rule-${idx}-${j}`))}
    </div>
  </div>
);

const StrategyRuleModal = ({ open, onClose, strategy, label }) => {
  if (!strategy) return null;
  const notes = STRATEGY_SPECIFIC_NOTES[strategy];
  const { buyRules, sellRules } = getStrategyRuleSets(strategy);
  const flow = getStrategyFlow(strategy);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="94vw"
      style={{ top: 20 }}
      styles={{ body: { maxHeight: 'calc(100vh - 150px)', overflowY: 'auto' } }}
      destroyOnHidden
      title={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BookOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>策略说明</span>
          <Tag color="blue" style={{ marginLeft: 8 }}>{notes?.group || '策略说明'}</Tag>
        </div>
      )}
    >
      {/* 基本信息 */}
      <div style={{ background: '#f7f9fc', borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#6b7890', marginBottom: 4 }}>当前选中策略</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>{label || strategy}</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, fontFamily: "'SF Mono', monospace" }}>{strategy}</div>
      </div>

      {/* 决策流程图 */}
      {flow && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#12213a', marginBottom: 10 }}>
            🗺 决策流程图
          </div>
          <StrategyFlowDiagram strategyId={strategy} height={540} />
        </div>
      )}

      {/* 本策略专属说明 */}
      {notes?.bullets?.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#12213a', marginBottom: 10 }}>
            🎯 本策略专属说明
          </div>
          <div style={{ border: '1px solid #e6f0ff', background: '#f0f6ff', borderRadius: 8, padding: '14px 16px' }}>
            {notes.bullets.map((b, i) => {
              const { title, lines } = parseNoteBullet(b);
              return (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: i < notes.bullets.length - 1 ? 14 : 0 }}>
                  {numDot(i + 1)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {title && (
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#12213a', marginBottom: 4 }}>{title}</div>
                    )}
                    {lines.map((ln, j) => clauseLine(ln, `note-${i}-${j}`))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 通用买入 / 卖出规则 */}
      <Tabs
        defaultActiveKey="buy"
        items={[
          { key: 'buy', label: `买入规则（${buyRules.length} 条）`, children: (<div style={{ height: 460, overflowY: 'auto' }}>{buyRules.map(ruleRow)}</div>) },
          { key: 'sell', label: `卖出规则（${sellRules.length} 条）`, children: (<div style={{ height: 460, overflowY: 'auto' }}>{sellRules.map(ruleRow)}</div>) },
        ]}
      />
    </Modal>
  );
};

export default StrategyRuleModal;
