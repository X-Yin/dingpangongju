import { useState, useEffect, useRef } from 'react';
import { Modal, Button, Tag, Empty, Spin, Progress, Popover, Collapse, message, Alert, Tooltip } from 'antd';
import {
  ReloadOutlined,
  HistoryOutlined,
  RiseOutlined,
  FallOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../../constant';

const fmtDate = (d) => (d ? `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}` : '--');
const fmtTime = (t) => t || '--';
const fmtPct = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '--';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};
const fmtPctColor = (v) => (v == null || Number.isNaN(Number(v)) ? undefined : (Number(v) >= 0 ? '#f5222d' : '#52c41a'));
// 持仓交易日数展示（服务端按 amountSnapshot 交易日历计算；≈ 表示日期超出日历覆盖、按周一~周五退化估算）
const fmtHoldingDays = (t) => (t && t.holdingDays != null ? `${t.holdingDaysApprox ? '≈' : ''}${t.holdingDays} 交易日` : '--');
// 新报告 createdAt 已是北京时间字符串（YYYY-MM-DD-HH:mm）直接展示；旧报告 ISO 串转换为北京时间
const fmtReportTime = (t) => {
  if (!t) return '--';
  if (/^\d{4}-\d{2}-\d{2}-\d{2}:\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
};

const BASE = `http://${local_ip}:3000`;

// 买入原因标签：显示命中了哪些买入条件（悬停展示逐项明细：条件标题、数值与判定理由）
const BuyReasonTag = ({ reason, checks }) => {
  if (!reason) return null;
  // 顺延明细表格单元格样式（Tooltip 深色底：白边框、涨红/跌绿）
  const gateCellStyle = { border: '1px solid rgba(255,255,255,0.3)', padding: '1px 8px', whiteSpace: 'nowrap' };
  const hasDetail = Array.isArray(checks) && checks.length > 0;
  const detail = hasDetail ? (
    <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {checks.map((c, i) => (
        <div key={c.id || i}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {c.passed ? '✓' : '✗'} {c.title}
            {c.value ? `（${c.value}）` : ''}
          </div>
          {c.reason && <div style={{ fontSize: 11, opacity: 0.75 }}>{c.reason}</div>}
          {Array.isArray(c.skippedStocks) && c.skippedStocks.length > 0 && (
            <table style={{ borderCollapse: 'collapse', marginTop: 3, fontSize: 11 }}>
              <thead>
                <tr>
                  {['顺延前序股票', '窗口涨幅(排序依据)', '触发时涨幅', '抗分歧分数'].map(h => (
                    <th key={h} style={{ ...gateCellStyle, fontWeight: 600, opacity: 0.75 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.skippedStocks.map((s, j) => (
                  <tr key={s.code || j}>
                    <td style={gateCellStyle}>{s.name || s.code}</td>
                    <td style={{ ...gateCellStyle, color: s.metric != null ? (s.metric > 0 ? '#ff7875' : s.metric < 0 ? '#95de64' : undefined) : undefined }}>
                      {s.metric != null ? `${s.metric > 0 ? '+' : ''}${Number(s.metric).toFixed(2)}%` : '--'}
                    </td>
                    <td style={{ ...gateCellStyle, color: s.change != null ? (s.change > 0 ? '#ff7875' : s.change < 0 ? '#95de64' : undefined) : undefined }}>
                      {s.change != null ? `${s.change > 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                    </td>
                    <td style={gateCellStyle}>{s.resilience != null ? Number(s.resilience).toFixed(1) : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  ) : undefined;
  return (
    <Tooltip title={detail} placement="topLeft">
      <Tag color="volcano" style={{ marginInlineEnd: 0, whiteSpace: 'normal', height: 'auto', cursor: hasDetail ? 'help' : 'default' }}>
        {reason}
      </Tag>
    </Tooltip>
  );
};

// 单个策略卡片：概览汇总 + 每一笔交易明细
const StrategyCard = ({ strategy, rank }) => {
  const s = strategy.summary || {};
  const hasTrades = (strategy.trades || []).length > 0 || strategy.currentHolding;

  const items = (strategy.trades || []).map(t => ({
    key: `T${t.seq}`,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>第{t.seq}笔</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#12213a' }}>{t.stockName}</span>
        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{t.code}</span>
        {t.metric != null && <Tag color="purple" style={{ marginInlineEnd: 0 }}>选股指标 {Number(t.metric).toFixed(4)}</Tag>}
        <Tag color={fmtPctColor(t.returnRate)} style={{ marginInlineEnd: 0 }}>收益 {fmtPct(t.returnRate)}</Tag>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{fmtDate(t.buyDate)} {fmtTime(t.buyTime)} 买 → {fmtDate(t.sellDate)} {fmtTime(t.sellTime)} 卖</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(t)}</b></span>
      </div>
    ),
    children: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ color: '#6b7890' }}>
            <RiseOutlined style={{ color: '#f5222d', marginRight: 4 }} />
            买入价 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.buyPrice).toFixed(2)}</b>（涨幅 <b style={{ color: fmtPctColor(t.buyChange) }}>{fmtPct(t.buyChange)}</b>）
          </span>
          <span style={{ color: '#6b7890' }}>
              <FallOutlined style={{ color: '#52c41a', marginRight: 4 }} />
              卖出价 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{t.sellPrice != null ? Number(t.sellPrice).toFixed(2) : '--'}</b>（涨幅 <b style={{ color: fmtPctColor(t.sellChange) }}>{fmtPct(t.sellChange)}</b>）
            </span>
        </div>
        {t.buyReason && (
          <div style={{ color: '#6b7890', display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ lineHeight: '22px' }}>买入原因：</span>
            <BuyReasonTag reason={t.buyReason} checks={t.buyChecks} />
          </div>
        )}
        <div style={{ color: '#6b7890' }}>
          卖出原因：<Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t.sellReason || '卖出条件触发'}</Tag>
        </div>
      </div>
    ),
  }));

  if (strategy.currentHolding) {
    const h = strategy.currentHolding;
    items.push({
      key: 'HOLD',
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#ad6800' }}>持仓中（未卖出）</span>
          {h.holdingDays != null && <span style={{ fontSize: 11, color: '#9ca3af' }}>已持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(h)}</b></span>}
          <span style={{ fontSize: 13, fontWeight: 700, color: '#12213a' }}>{h.stockName}</span>
          <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{h.code}</span>
          {h.buyReturn != null && <Tag color={fmtPctColor(h.buyReturn)} style={{ marginInlineEnd: 0 }}>浮盈 {fmtPct(h.buyReturn)}</Tag>}
        </div>
      ),
      children: (
        <div style={{ fontSize: 12, color: '#6b7890', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            买入 {fmtDate(h.buyDate)} {fmtTime(h.buyTime)} 价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(h.buyPrice).toFixed(2)}</b>
            {h.buyChange != null && <>（涨幅 <b style={{ color: fmtPctColor(h.buyChange) }}>{fmtPct(h.buyChange)}</b>）</>}
          </span>
          {h.buyReason && (
            <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
              买入原因：<BuyReasonTag reason={h.buyReason} checks={h.buyChecks} />
            </span>
          )}
        </div>
      ),
    });
  }

  const metricItems = [
    { label: '整体收益率', value: s.overallReturn != null ? fmtPct(s.overallReturn) : '--', color: fmtPctColor(s.overallReturn) },
    { label: '胜率', value: s.winRate != null ? `${s.winRate.toFixed(1)}%` : '--', color: s.winRate != null && s.winRate >= 50 ? '#f5222d' : '#52c41a' },
    { label: '成交笔数', value: `${s.tradeCount || 0} 笔` },
    { label: '盈利笔数', value: `${s.winCount || 0} 笔` },
    { label: '平均持仓', value: s.avgHoldingDays != null ? `${s.avgHoldingDaysApprox ? '≈' : ''}${Number(s.avgHoldingDays).toFixed(1)} 交易日` : '--' },
    { label: '期末持仓', value: s.holding ? '1 只' : '0 只' },
  ];

  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
      {/* 概览汇总 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 26, height: 26, borderRadius: 8, flexShrink: 0,
          background: rank === 1 ? '#fff1cc' : '#f0f3f9', color: rank === 1 ? '#d48806' : '#64748b',
          fontSize: 13, fontWeight: 700,
        }}>
          {rank === 1 ? <TrophyOutlined /> : rank}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{strategy.name}</span>
        <span style={{ fontSize: 16, fontWeight: 800, color: fmtPctColor(s.overallReturn) }}>
          {fmtPct(s.overallReturn)}
        </span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{strategy.desc || ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {metricItems.map(m => (
          <div key={m.label} style={{ flex: 1, minWidth: 72, background: '#f7f9fc', borderRadius: 8, padding: '6px 10px' }}>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>{m.label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: m.color || '#12213a', marginTop: 1 }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* 交易明细 */}
      {hasTrades ? (
        <Collapse items={items} size="small" bordered={false} defaultActiveKey={items.slice(0, 1).map(i => i.key)} />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无可展示的成交明细" />
      )}
    </div>
  );
};

const BacktestReportModal = ({ open, onClose }) => {
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const loadLatest = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await axios.get(`${BASE}/training_camp/backtest/report/latest`);
      if (r.data?.success) setReport(r.data.report);
      else setError(r.data?.message || '获取回测报告失败');
    } catch {
      setError('获取回测报告失败，请检查后端服务');
    } finally {
      setLoading(false);
    }
  };

  const refreshHistory = async () => {
    try {
      const r = await axios.get(`${BASE}/training_camp/backtest/report/history`);
      if (r.data?.success) setHistory(r.data.list || []);
    } catch {
      // 历史列表拉取失败不阻塞主流程
    }
  };

  useEffect(() => {
    if (open) {
      loadLatest();
      refreshHistory();
    } else {
      stopPoll();
      setGenerating(false);
      setProgress(null);
    }
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleRegenerate = async () => {
    if (generating) return;
    setGenerating(true);
    setProgress(null);
    setError(null);
    stopPoll();
    try {
      const r = await axios.post(`${BASE}/training_camp/backtest/report/generate`, {});
      if (!r.data?.success || !r.data.taskId) {
        setGenerating(false);
        setError(r.data?.message || '创建回测报告生成任务失败');
        return;
      }
      const taskId = r.data.taskId;
      pollRef.current = setInterval(async () => {
        try {
          const s = await axios.get(`${BASE}/training_camp/backtest/report/status/${taskId}`);
          if (s.data.status === 'done') {
            stopPoll();
            setGenerating(false);
            setProgress(null);
            setReport(s.data.report);
            refreshHistory();
            message.success('已重新生成最新回测报告');
          } else if (s.data.status === 'error') {
            stopPoll();
            setGenerating(false);
            setError(s.data.error || '回测报告生成失败');
          } else {
            setProgress(s.data.progress || null);
          }
        } catch {
          // 单次轮询失败继续等待
        }
      }, 2000);
    } catch {
      setGenerating(false);
      setError('创建回测报告生成任务失败，请检查后端服务');
    }
  };

  const loadReport = async (id) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    stopPoll();
    try {
      const r = await axios.get(`${BASE}/training_camp/backtest/report/${id}`);
      if (r.data?.success) setReport(r.data.report);
      else setError(r.data?.message || '获取回测报告失败');
    } catch {
      setError('获取历史回测报告失败');
    } finally {
      setLoading(false);
    }
  };

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const historyContent = (
    <div style={{ width: 300 }}>
      {history.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 4px' }}>暂无历史回测报告</div>
      ) : (
        history.map(h => (
          <div
            key={h.id}
            onClick={() => loadReport(h.id)}
            style={{
              padding: '8px 10px', cursor: 'pointer', borderRadius: 8,
              background: report?.id === h.id ? '#e6f4ff' : 'transparent',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = report?.id === h.id ? '#e6f4ff' : '#f5f6fa'; }}
            onMouseLeave={e => { e.currentTarget.style.background = report?.id === h.id ? '#e6f4ff' : 'transparent'; }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>
              {fmtDate(h.range?.startDate)} ~ {fmtDate(h.range?.endDate)}
              <Tag style={{ marginInlineStart: 6 }} color={h.generatedFromCache ? 'default' : 'blue'}>
                {h.strategyCount} 策略
              </Tag>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              生成于 {fmtReportTime(h.createdAt)}
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={() => { onClose(); }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrophyOutlined style={{ color: '#d48806' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>买卖点策略回测报告</span>
        </div>
      }
      footer={null}
      width={980}
      styles={{ body: { padding: 16, background: '#f7f9fc', maxHeight: '70vh', overflowY: 'auto' } }}
    >
      {/* 顶部操作区 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16, background: '#fff', borderRadius: 12, padding: '12px 14px', boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={handleRegenerate}
          loading={generating}
          style={{ borderRadius: 999 }}
        >
          {generating ? '回测生成中…' : '重新生成最新报告'}
        </Button>
        <Popover content={historyContent} title="历史回测报告（最近 5 次）" trigger="click" placement="bottom">
          <Button icon={<HistoryOutlined />} style={{ borderRadius: 999 }}>
            查看历史报告
          </Button>
        </Popover>
        {report ? (
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            当前范围：{fmtDate(report.range?.startDate)} ~ {fmtDate(report.range?.endDate)}｜共 {report.strategyCount} 个策略
          </span>
        ) : null}
      </div>

      {generating && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 12, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
          <Progress percent={progressPercent} status="active" size="small" />
          <div style={{ fontSize: 12, color: '#6b7890', marginTop: 4 }}>
            {progress && progress.total > 0
              ? `正在回测 ${progress.current}/${progress.total}｜${progress.strategy}`
              : '正在初始化回测报告生成任务……'}
          </div>
        </div>
      )}

      {error && (
        <Alert type="error" showIcon message="加载失败" description={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      )}

      {/* 策略卡片列表 */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><Spin tip="加载中…" /></div>
      ) : report ? (
        (report.strategies || []).length === 0 ? (
          <Empty description="暂无可展示的策略回测数据" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(report.strategies || []).map(s => <StrategyCard key={s.id} strategy={s} rank={s.rank} />)}
          </div>
        )
      ) : (
        <Empty description="暂无回测报告" />
      )}

      <div style={{ height: 8 }} />
    </Modal>
  );
};

export default BacktestReportModal;