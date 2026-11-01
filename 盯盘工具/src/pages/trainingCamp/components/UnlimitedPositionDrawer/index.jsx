import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer, Button, message, Progress, Tag, Empty, Alert, Select, Tooltip, Space } from 'antd';
import { RiseOutlined, FallOutlined, ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import StockKLineModal from '../../../../components/StockKLineModal';

// 无限仓位测试：在所选区间/策略下，不再因已有持仓占用仓位而放弃其他股票的买点——
// 规定时间内满足策略要求的不同股票都会执行买入（该全仓的全仓、该半仓的半仓）；
// 同一只股票仍遵循原有「买点 → 卖点」：持仓未卖出前即使再次触发买点也不重复买入。

const fmtDate = (d) => (d ? `${String(d).substring(0, 4)}-${String(d).substring(4, 6)}-${String(d).substring(6, 8)}` : '--');
const fmtPct = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
};
const fmtHoldingDays = (t) => (t && t.holdingDays != null ? `${t.holdingDaysApprox ? '≈' : ''}${t.holdingDays} 交易日` : '--');
const fmtIdleDays = (t) => (t && t.idleDays != null ? `${t.idleDaysApprox ? '≈' : ''}${t.idleDays} 交易日` : null);

const SORT_OPTIONS = [
  { value: 'profit_desc', label: '收益从高到低' },
  { value: 'profit_asc', label: '收益从低到高' },
  { value: 'win_only', label: '仅看盈利' },
  { value: 'loss_only', label: '仅看亏损' },
];

const MODE_LABEL = { offense: '进攻·全仓', defense: '防御·半仓' };

const ReturnTag = ({ rate, rawRate, weight, label = '收益' }) => {
  if (rate == null || !Number.isFinite(Number(rate))) return null;
  const rateNum = Number(rate);
  const color = rateNum > 0 ? 'red' : (rateNum < 0 ? 'green' : 'default');
  const half = weight != null && Number(weight) < 1;
  return (
    <Tooltip
      title={half
        ? `本份为半仓（权重 ${Number(weight).toFixed(1)}）：个股实际收益 ${fmtPct(rawRate)}，按仓位折算后计入概览的收益为 ${fmtPct(rate)}`
        : `个股实际收益 ${fmtPct(rawRate != null ? rawRate : rate)}（全仓）`}
    >
      <Tag color={color} style={{ marginInlineEnd: 0 }}>
        {label} {fmtPct(rate)}{half ? `（半仓 · 实际 ${fmtPct(rawRate)}）` : ''}
      </Tag>
    </Tooltip>
  );
};

const UnlimitedPositionDrawer = ({ open, onClose, strategy, dateRange, strategyName, extremeWin = false }) => {
  const [running, setRunning] = useState(false);
  // 点击交易记录/持仓的股票名称打开 K 线弹窗（与外部回测记录同一套交互）
  const [klineTarget, setKlineTarget] = useState(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, date: '', status: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [sortMode, setSortMode] = useState('profit_desc');
  const pollRef = useRef(null);
  const taskIdRef = useRef(null);
  const lastRunKeyRef = useRef('');

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const rangeKey = useMemo(() => {
    if (!dateRange || !dateRange[0] || !dateRange[1]) return '';
    return `${dateRange[0].format('YYYYMMDD')}|${dateRange[1].format('YYYYMMDD')}|${strategy}`;
  }, [dateRange, strategy]);

  const startPolling = useCallback((taskId) => {
    stopPolling();
    taskIdRef.current = taskId;
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/status/${taskId}`);
        const s = r.data || {};
        if (s.status === 'running') {
          setProgress(s.progress || null);
        } else {
          stopPolling();
          setRunning(false);
          if (s.status === 'done' && s.result) {
            setResult(s.result);
            message.success('无限仓位测试完成');
          } else if (s.status === 'error') {
            setError(s.error || '无限仓位测试失败');
          } else {
            setError('任务状态异常');
          }
        }
      } catch {
        // 忽略单次轮询失败，继续等待
      }
    }, 2000);
  }, [stopPolling]);

  const handleRun = useCallback(async (force = false) => {
    if (!dateRange || !dateRange[0] || !dateRange[1]) {
      message.warning('请选择回测日期范围');
      return;
    }
    const startDate = dateRange[0].format('YYYYMMDD');
    const endDate = dateRange[1].format('YYYYMMDD');
    if (startDate > endDate) {
      message.warning('开始日期不能晚于结束日期');
      return;
    }
    lastRunKeyRef.current = rangeKey;
    setError(null);
    setProgress({ current: 0, total: 0, date: '', status: '' });
    setRunning(true);
    try {
      const r = await axios.post(`http://${local_ip}:3000/training_camp/backtest`, {
        startDate,
        endDate,
        strategy,
        force,
        unlimited: true,
      });
      if (r.data?.success && r.data.taskId) {
        startPolling(r.data.taskId);
      } else if (r.data?.success && r.data.cached && r.data.result) {
        setResult(r.data.result);
        setRunning(false);
        message.success('已加载无限仓位测试缓存结果');
      } else {
        setRunning(false);
        setError(r.data?.message || '创建无限仓位测试任务失败');
      }
    } catch {
      setRunning(false);
      setError('创建无限仓位测试任务失败，请检查后端服务');
    }
  }, [dateRange, strategy, rangeKey, startPolling]);

  // 打开抽屉（或策略/区间变化）时自动运行一次：命中服务端无限仓位专用缓存时秒开
  useEffect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    if (rangeKey && lastRunKeyRef.current !== rangeKey) {
      setResult(null);
      handleRun(false);
    }
  }, [open, rangeKey, handleRun, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const trades = useMemo(() => {
    const list = Array.isArray(result?.trades) ? [...result.trades] : [];
    const rateOf = (t) => (t.returnRate != null && Number.isFinite(Number(t.returnRate)) ? Number(t.returnRate) : null);
    if (sortMode === 'profit_desc') {
      list.sort((a, b) => (rateOf(b) ?? -Infinity) - (rateOf(a) ?? -Infinity));
    } else if (sortMode === 'profit_asc') {
      list.sort((a, b) => (rateOf(a) ?? Infinity) - (rateOf(b) ?? Infinity));
    } else if (sortMode === 'win_only') {
      return list.filter((t) => rateOf(t) != null && rateOf(t) > 0)
        .sort((a, b) => rateOf(b) - rateOf(a));
    } else if (sortMode === 'loss_only') {
      return list.filter((t) => rateOf(t) != null && rateOf(t) < 0)
        .sort((a, b) => rateOf(a) - rateOf(b));
    }
    return list;
  }, [result, sortMode]);

  const holdings = useMemo(() => {
    const list = Array.isArray(result?.currentHoldings) ? result.currentHoldings : [];
    if (list.length > 0) return list;
    return result?.currentHolding ? [result.currentHolding] : [];
  }, [result]);

  const summary = result?.summary || {};
  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;
  const title = strategyName ? `无限仓位测试 · ${strategyName}` : '无限仓位测试';

  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      width={980}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="无限仓位口径"
        description="不再因已有持仓占用仓位而放弃其他股票的买点：规定时间内满足策略要求的股票都会执行买入（该全仓的全仓、该半仓的半仓），不同股票可同时持有；同一只股票仍按原有「买点 → 卖点」执行——持仓未卖出前，即使再次触发买点也不重复买入。"
      />

      <Space style={{ marginBottom: 12 }} wrap>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={() => handleRun(true)}
          loading={running}
        >
          重新运行（强制计算）
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => handleRun(false)} disabled={running}>
          读取缓存
        </Button>
        <Select
          value={sortMode}
          onChange={setSortMode}
          options={SORT_OPTIONS}
          style={{ width: 160 }}
          disabled={!result}
        />
      </Space>

      {running && (
        <div style={{ marginBottom: 12 }}>
          <Progress
            percent={progressPercent}
            status="active"
            size="small"
            format={() => (progress && progress.total > 0 ? `${progress.current}/${progress.total} 天` : '准备中')}
          />
        </div>
      )}

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      {result && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
          background: '#fff', borderRadius: 12, padding: '12px 16px', marginBottom: 12,
          boxShadow: '0 1px 4px rgba(18,33,58,0.06)',
        }}>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            区间 <b>{fmtDate(result.range?.startDate)} ~ {fmtDate(result.range?.endDate)}</b>
          </span>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            整体收益 <b style={{ color: (summary.overallReturn ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(summary.overallReturn)}</b>
          </span>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            成交 <b style={{ color: '#12213a' }}>{summary.tradeCount || 0}</b> 笔
          </span>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            胜率 <b style={{ color: '#12213a' }}>{summary.winRate != null ? `${Number(summary.winRate).toFixed(2)}%` : '--'}</b>
            {summary.winCount != null && <span style={{ color: '#9ca3af' }}>（盈 {summary.winCount} 笔）</span>}
          </span>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            平均回撤 <b style={{ color: '#12213a' }}>{fmtPct(summary.avgDrawdown)}</b>
          </span>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            单笔最大回撤 <b style={{ color: '#12213a' }}>{fmtPct(summary.maxDrawdown)}</b>
          </span>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            期末持仓 <b style={{ color: '#12213a' }}>{holdings.length}</b> 份
          </span>
          {Array.isArray(result.skippedDates) && result.skippedDates.length > 0 && (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>跳过 {result.skippedDates.length} 个交易日</span>
          )}
        </div>
      )}

      {result && (trades.length === 0 && holdings.length === 0 ? (
        <Empty description="所选范围内未产生任何成交" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {trades.map((t) => (
            <div key={`${t.seq}-${t.code}-${t.buyDate}`} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>第{t.seq}笔</span>
                <span
                  onClick={() => setKlineTarget({ code: t.code, name: t.stockName, trade: t })}
                  title="点击查看该股票 K 线（含买卖点标注）"
                  style={{ fontSize: 14, fontWeight: 700, color: '#1677ff', cursor: 'pointer', textDecoration: 'underline dotted' }}
                >
                  {t.stockName}
                </span>
                <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{t.code}</span>
                {t.positionMode && (
                  <Tag color={t.positionMode === 'offense' ? 'volcano' : 'blue'} style={{ marginInlineEnd: 0 }}>
                    {MODE_LABEL[t.positionMode] || t.positionMode}
                  </Tag>
                )}
                {t.cycle === 'counter' && (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>逆周期腿</Tag>
                )}
                {t.twoBuy && (
                  <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                    {`第${Number(t.leg) >= 2 ? '二' : '一'}份仓位`}
                  </Tag>
                )}
                {t.metric != null && (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    选股指标 {Number(t.metric).toFixed(4)}
                  </Tag>
                )}
                <ReturnTag rate={t.returnRate} rawRate={t.rawReturnRate} weight={t.weight} />
              </div>

              <div style={{ border: '1px solid #eef1f6', borderRadius: 8, padding: '8px 10px', background: '#fafbfd' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <RiseOutlined style={{ color: '#f5222d', fontSize: 12 }} />
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    买入 <b>{fmtDate(t.buyDate)} {t.buyTime}</b>
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    {fmtIdleDays(t) != null
                      ? <>距上笔开仓空仓 <b style={{ color: '#12213a' }}>{fmtIdleDays(t)}</b></>
                      : <span style={{ color: '#9ca3af' }}>首笔开仓</span>}
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.buyPrice).toFixed(2)}</b>
                  </span>
                  <span style={{ fontSize: 12 }}>
                    涨幅 <b style={{ color: t.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.buyChange)}</b>
                  </span>
                  <span style={{ fontSize: 12 }}>
                    买入当日收益 <b style={{ color: t.buyDayReturn == null ? undefined : (t.buyDayReturn >= 0 ? '#f5222d' : '#52c41a') }}>{fmtPct(t.buyDayReturn)}</b>
                    {t.buyDayClose != null && (
                      <span style={{ color: '#9ca3af' }}>（当日收盘 {Number(t.buyDayClose).toFixed(2)}）</span>
                    )}
                  </span>
                </div>
                {t.buyReason && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                    <Tooltip
                      overlayStyle={{ maxWidth: 760 }}
                      title={Array.isArray(t.buyChecks) && t.buyChecks.length > 0 ? (
                        <div style={{ fontSize: 12 }}>
                          {(t.buyChecks || []).map((c) => (
                            <div key={c.id} style={{ marginBottom: 4 }}>
                              {c.passed === false ? '✗' : '✓'} {c.title}{c.value != null ? `：${c.value}` : ''}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    >
                      <Tag color="volcano" style={{ marginInlineEnd: 0, whiteSpace: 'normal', height: 'auto' }}>
                        {t.buyReason}
                      </Tag>
                    </Tooltip>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                  <FallOutlined style={{ color: '#52c41a', fontSize: 12 }} />
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    卖出 <b>{fmtDate(t.sellDate)} {t.sellTime}</b>
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.sellPrice).toFixed(2)}</b>
                  </span>
                  <span style={{ fontSize: 12 }}>
                    涨幅 <b style={{ color: t.sellChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.sellChange)}</b>
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    持仓 <b style={{ color: '#12213a' }}>{fmtHoldingDays(t)}</b>
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    卖出原因 <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t.sellReason}</Tag>
                  </span>
                </div>
                {t.rawReturnRate != null && Number(t.weight) < 1 && (
                  <div style={{ fontSize: 12, color: '#d46b08', marginTop: 4 }}>
                    半仓口径：个股实际收益 {fmtPct(t.rawReturnRate)}，按 {Math.round(Number(t.weight) * 100)}% 仓位折算后计入概览的收益为 {fmtPct(t.returnRate)}
                  </div>
                )}
              </div>
            </div>
          ))}

          {holdings.map((h, hi) => (
            <div key={`${h.code}-${hi}`} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>持仓中（未卖出）{holdings.length > 1 ? ` · 第${hi + 1}份` : ''}</span>
                <span
                  onClick={() => setKlineTarget({ code: h.code, name: h.stockName, trade: h })}
                  title="点击查看该股票 K 线（含买点标注）"
                  style={{ fontSize: 14, fontWeight: 700, color: '#1677ff', cursor: 'pointer', textDecoration: 'underline dotted' }}
                >
                  {h.stockName}
                </span>
                <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{h.code}</span>
                {(h.mode || h.positionMode) && (
                  <Tag color={(h.mode || h.positionMode) === 'offense' ? 'volcano' : 'blue'} style={{ marginInlineEnd: 0 }}>
                    {MODE_LABEL[h.mode || h.positionMode] || (h.mode || h.positionMode)}
                  </Tag>
                )}
                {h.twoBuy && (
                  <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                    {`第${Number(h.leg) >= 2 ? '二' : '一'}份仓位`}
                  </Tag>
                )}
                {h.metric != null && (
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    选股指标 {Number(h.metric).toFixed(4)}
                  </Tag>
                )}
                {h.buyReturn != null && (
                  <ReturnTag rate={h.buyReturn} rawRate={h.rawBuyReturn} weight={h.weight} label="浮盈" />
                )}
              </div>
              <div style={{ border: '1px solid #eef1f6', borderRadius: 8, padding: '8px 10px', background: '#fafbfd' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <RiseOutlined style={{ color: '#f5222d', fontSize: 12 }} />
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    买入 <b>{fmtDate(h.buyDate)} {h.buyTime}</b>
                  </span>
                  <span style={{ fontSize: 12, color: '#6b7890' }}>
                    价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(h.buyPrice).toFixed(2)}</b>
                  </span>
                  <span style={{ fontSize: 12 }}>
                    涨幅 <b style={{ color: h.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(h.buyChange)}</b>
                  </span>
                  {h.buyDayReturn != null && (
                    <span style={{ fontSize: 12 }}>
                      买入当日收益 <b style={{ color: h.buyDayReturn >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(h.buyDayReturn)}</b>
                    </span>
                  )}
                </div>
                {h.buyReason && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                    <Tooltip
                      overlayStyle={{ maxWidth: 760 }}
                      title={Array.isArray(h.buyChecks) && h.buyChecks.length > 0 ? (
                        <div style={{ fontSize: 12 }}>
                          {(h.buyChecks || []).map((c) => (
                            <div key={c.id} style={{ marginBottom: 4 }}>
                              {c.passed === false ? '✗' : '✓'} {c.title}{c.value != null ? `：${c.value}` : ''}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    >
                      <Tag color="volcano" style={{ marginInlineEnd: 0, whiteSpace: 'normal', height: 'auto' }}>
                        {h.buyReason}
                      </Tag>
                    </Tooltip>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* 股票 K 线弹窗（点击交易记录/持仓的股票名称打开，带买卖点标注；与外部回测记录共用同一组件） */}
      <StockKLineModal
        visible={!!klineTarget}
        onCancel={() => setKlineTarget(null)}
        code={klineTarget?.code}
        stockInfo={{ code: klineTarget?.code, name: klineTarget?.name }}
        tradeRecord={klineTarget?.trade || null}
        extremeWin={extremeWin}
      />
    </Drawer>
  );
};

export default UnlimitedPositionDrawer;
