import { Tag, Empty } from 'antd';
import {
  RobotOutlined,
  AimOutlined,
  WarningOutlined,
  RiseOutlined,
  FallOutlined,
  MinusOutlined,
  CheckCircleFilled,
} from '@ant-design/icons';
import './index.scss';

const SENTIMENT_META = {
  偏多: { color: '#f5222d', icon: <RiseOutlined />, bg: 'bullish' },
  偏空: { color: '#52c41a', icon: <FallOutlined />, bg: 'bearish' },
  中性: { color: '#fa8c16', icon: <MinusOutlined />, bg: 'neutral' },
};

const ACTION_META = {
  减仓: { color: '#52c41a', bg: 'bearish' },
  清仓: { color: '#52c41a', bg: 'bearish' },
  观望: { color: '#fa8c16', bg: 'neutral' },
  加仓: { color: '#f5222d', bg: 'bullish' },
};

const SIGNIFICANCE_META = {
  high: { color: '#f5222d', label: '高' },
  medium: { color: '#fa8c16', label: '中' },
  low: { color: '#52c41a', label: '低' },
};

const getSentimentMeta = (sentiment) => {
  if (!sentiment) return { color: '#fa8c16', icon: <MinusOutlined />, bg: 'neutral' };
  return SENTIMENT_META[sentiment] || { color: '#fa8c16', icon: <MinusOutlined />, bg: 'neutral' };
};

const getActionMeta = (action) => {
  if (!action) return { color: '#fa8c16', bg: 'neutral' };
  return ACTION_META[action] || { color: '#fa8c16', bg: 'neutral' };
};

const getSignificanceMeta = (sig) => {
  if (!sig) return { color: '#bfbfbf', label: '未知' };
  return SIGNIFICANCE_META[sig] || { color: '#bfbfbf', label: sig };
};

const scoreToPercent = (score) => {
  const s = Number(score);
  if (isNaN(s)) return 50;
  return Math.max(0, Math.min(100, (s + 100) / 2));
};

const AiDiagnosisResult = ({ diagnosis, loading = false }) => {
  if (loading) {
    return (
      <div className="ai-diagnosis-result ai-diagnosis-loading">
        <div className="loading-pulse">
          <RobotOutlined className="loading-icon" />
          <div className="loading-text">AI 正在基于原始数据独立诊断策略命中情况…</div>
          <div className="loading-sub">AI 完全依据原始数据独立判断，通常需要 10-30 秒</div>
        </div>
      </div>
    );
  }

  if (!diagnosis) return null;

  const diag = diagnosis.diagnosis || {};
  const strategyDiagnosis = diagnosis.strategyDiagnosis || [];
  const additionalFindings = diagnosis.additionalFindings || [];
  const operationAdvice = diagnosis.operationAdvice || {};
  const outlook = diagnosis.outlook || '';
  const sentimentMeta = getSentimentMeta(diag.overallSentiment);
  const actionMeta = getActionMeta(operationAdvice.action);
  const scorePercent = scoreToPercent(diag.sentimentScore);

  // 仅保留触发的策略，按触发时间排序，组成命中时间线
  const triggeredSignals = strategyDiagnosis
    .filter(s => s.triggered)
    .slice()
    .sort((a, b) => {
      const ta = a.triggerTime || '';
      const tb = b.triggerTime || '';
      return ta.localeCompare(tb);
    });

  // 按触发时间分组
  const timeGroups = [];
  triggeredSignals.forEach(s => {
    const t = s.triggerTime || '未知时间';
    let group = timeGroups.find(g => g.time === t);
    if (!group) {
      group = { time: t, signals: [] };
      timeGroups.push(group);
    }
    group.signals.push(s);
  });

  const hasContent = diag.summary || triggeredSignals.length > 0 || additionalFindings.length > 0 || operationAdvice.action || outlook;
  if (!hasContent) {
    return (
      <div className="ai-diagnosis-result">
        <Empty description="诊断结果为空" />
      </div>
    );
  }

  return (
    <div className="ai-diagnosis-result">
      {/* 整体诊断概览 */}
      <div className={`adr-section adr-overview ${sentimentMeta.bg}`}>
        <div className="adr-section-title">
          <RobotOutlined />
          <span>整体诊断</span>
          {diag.date && <span className="adr-date">{diag.date}</span>}
        </div>
        <div className="adr-overview-body">
          <div className="adr-sentiment-block">
            <div className="adr-sentiment-row">
              <span className="adr-sentiment-label">市场情绪</span>
              <span className="adr-sentiment-value" style={{ color: sentimentMeta.color }}>
                {sentimentMeta.icon}
                {diag.overallSentiment || '未知'}
              </span>
            </div>
            {diag.sentimentScore !== undefined && diag.sentimentScore !== null && (
              <div className="adr-score-row">
                <span className="adr-score-label">情绪评分</span>
                <div className="adr-score-bar">
                  <div className="adr-score-track">
                    <div className="adr-score-mid" />
                    <div className="adr-score-fill" style={{ width: `${scorePercent}%`, background: sentimentMeta.color }} />
                  </div>
                  <span className="adr-score-num" style={{ color: sentimentMeta.color }}>
                    {Number(diag.sentimentScore) > 0 ? '+' : ''}{diag.sentimentScore}
                  </span>
                </div>
              </div>
            )}
          </div>
          {diag.summary && <div className="adr-summary-text">{diag.summary}</div>}
        </div>
      </div>

      {/* 策略命中时间线 */}
      <div className="adr-section adr-timeline">
        <div className="adr-section-title">
          <AimOutlined />
          <span>策略命中时间线</span>
          <span className="adr-count">{triggeredSignals.length} 次命中</span>
        </div>
        <div className="adr-timeline-body">
          {triggeredSignals.length === 0 ? (
            <Empty description="当日无策略命中" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            timeGroups.map((group, gIdx) => (
              <div key={gIdx} className="adr-tl-group">
                <div className="adr-tl-time">{group.time}</div>
                <div className="adr-tl-signals">
                  {group.signals.map((s, sIdx) => {
                    const isBullish = s.type === 'bullish';
                    return (
                      <div key={sIdx} className={`adr-tl-card ${isBullish ? 'bullish' : 'bearish'}`}>
                        <div className="adr-tl-card-header">
                          <CheckCircleFilled className="adr-tl-trigger" />
                          <span className="adr-tl-name">{s.strategyName}</span>
                          <Tag color={isBullish ? '#f5222d' : '#52c41a'} className="adr-type-tag">
                            {isBullish ? '利好' : '利空'}
                          </Tag>
                        </div>
                        {s.evidence && (
                          <div className="adr-tl-evidence">
                            <span className="adr-evidence-label">数据证据</span>
                            <span className="adr-evidence-text">{s.evidence}</span>
                          </div>
                        )}
                        {s.analysis && <div className="adr-tl-analysis">{s.analysis}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 策略库未覆盖的异动 */}
      {additionalFindings.length > 0 && (
        <div className="adr-section adr-findings">
          <div className="adr-section-title">
            <WarningOutlined />
            <span>策略库未覆盖的市场异动</span>
            <span className="adr-count">{additionalFindings.length} 项</span>
          </div>
          <div className="adr-findings-list">
            {additionalFindings.map((f, idx) => {
              const sigMeta = getSignificanceMeta(f.significance);
              return (
                <div key={idx} className="adr-finding-card">
                  <div className="adr-finding-header">
                    {f.time && <span className="adr-finding-time">{f.time}</span>}
                    <span className="adr-finding-text">{f.finding}</span>
                    <Tag color={sigMeta.color} className="adr-finding-sig">{sigMeta.label}</Tag>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 操作建议 */}
      {operationAdvice.action && (
        <div className={`adr-section adr-advice ${actionMeta.bg}`}>
          <div className="adr-section-title">
            <AimOutlined />
            <span>操作建议</span>
            <Tag color={actionMeta.color} className="adr-action-tag">{operationAdvice.action}</Tag>
          </div>
          <div className="adr-advice-body">
            {operationAdvice.position && (
              <div className="adr-advice-row">
                <span className="adr-advice-label">建议仓位</span>
                <span className="adr-advice-value">{operationAdvice.position}</span>
              </div>
            )}
            {operationAdvice.reason && <div className="adr-advice-reason">{operationAdvice.reason}</div>}
          </div>
        </div>
      )}

      {/* 后市展望 */}
      {outlook && (
        <div className="adr-section adr-outlook">
          <div className="adr-section-title">
            <RiseOutlined />
            <span>后市展望</span>
          </div>
          <div className="adr-outlook-text">{outlook}</div>
        </div>
      )}
    </div>
  );
};

export default AiDiagnosisResult;
