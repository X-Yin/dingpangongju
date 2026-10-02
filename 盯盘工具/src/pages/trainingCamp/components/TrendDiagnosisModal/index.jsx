import { useState, useEffect, useRef } from 'react';
import { Modal, Button, Tabs, Tag, Empty, Spin, Alert, message } from 'antd';
import {
  DownloadOutlined,
  LineChartOutlined,
  ReloadOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import { StrategyCard } from '../BacktestReportModal';
import MonthlyCurveTab from './MonthlyCurveTab';

const BASE = `http://${local_ip}:3000`;
const fmtDate = (d) => (d ? `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}` : '--');

// 策略趋势诊断弹窗：三档时间范围（默认范围 / 30 交易日 / 15 交易日）× 全部策略自动回测，
// 打开弹窗先加载历史曲线（自然月）数据，完成后再自动启动三档范围诊断（服务端逐范围补测缺失缓存的策略），
// 完成后按 4 个 tab 展示（三份策略报告 + 历史曲线，曲线下方按回测报告格式逐月展示已选策略的每一笔交易），
// 报告卡片复用回测报告弹窗的 StrategyCard 格式；顶部支持一键下载全部结果 JSON
const TrendDiagnosisModal = ({ open, onClose }) => {
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null); // { generatedAt, ranges: [{ key, label, days, startDate, endDate, report }] }
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [activeTab, setActiveTab] = useState('default');
  const pollRef = useRef(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = () => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/status`);
        const s = r.data || {};
        setLogs(Array.isArray(s.logs) ? s.logs : []);
        if (s.result) setResult(s.result);
        if (s.status !== 'running') {
          stopPoll();
          setStatus(s.status);
          if (s.status === 'done') message.success('策略趋势诊断完成');
          else if (s.status === 'error') setError(s.error || '策略趋势诊断失败');
        } else {
          setStatus('running');
        }
      } catch {
        // 单次轮询失败继续等待
      }
    }, 3000);
  };

  // 启动诊断（服务端复用 backtest-worker --trend：不清缓存，逐范围补测缺失缓存的策略）
  const startDiagnosis = async () => {
    if (starting) return false;
    setStarting(true);
    setError(null);
    try {
      const r = await axios.post(`${BASE}/training_camp/backtest/trend_diagnosis`, {});
      if (r.data?.success) {
        setStatus('running');
        startPolling();
        return true;
      }
      setError(r.data?.message || '启动策略趋势诊断失败');
      return false;
    } catch {
      setError('启动策略趋势诊断失败，请检查后端服务');
      return false;
    } finally {
      setStarting(false);
    }
  };

  // 打开弹窗：初始落在历史曲线 tab，先等自然月回测完成（无任务则自动启动），完成后再启动三档时间范围诊断
  useEffect(() => {
    if (!open) {
      stopPoll();
      return;
    }
    setActiveTab('monthly');
    let cancelled = false;
    const getMonthlyStatus = () => axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/monthly/status`).then(r => r.data || {});
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    (async () => {
      // 先水合三档范围已有结果（若有），页面可立即展示上一次的诊断数据
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/status`);
        if (cancelled) return;
        const s = r.data || {};
        setLogs(Array.isArray(s.logs) ? s.logs : []);
        if (s.result) setResult(s.result);
      } catch { /* 忽略：随后启动诊断时再处理 */ }

      // 第一步：历史曲线（自然月）先行加载——无任务则启动，进行中则轮询等待完成（失败/超时不阻塞三档范围诊断）
      try {
        let s = await getMonthlyStatus();
        if (cancelled) return;
        if (s.status === 'idle') {
          await axios.post(`${BASE}/training_camp/backtest/trend_diagnosis/monthly`, {}).catch(() => {});
          s = await getMonthlyStatus();
          if (cancelled) return;
        }
        const startedAt = Date.now();
        while (s.status === 'running' && !cancelled && Date.now() - startedAt < 10 * 60 * 1000) {
          await sleep(3000);
          s = await getMonthlyStatus().catch(() => ({}));
        }
      } catch { /* 历史曲线加载失败不阻塞三档范围诊断 */ }
      if (cancelled) return;

      // 第二步：历史曲线完成后再加载三档时间范围 tab（复用原有诊断启动/轮询逻辑）
      try {
        const r = await axios.get(`${BASE}/training_camp/backtest/trend_diagnosis/status`);
        if (cancelled) return;
        const s = r.data || {};
        setLogs(Array.isArray(s.logs) ? s.logs : []);
        if (s.result) setResult(s.result);
        if (s.status === 'running') {
          setStatus('running');
          startPolling();
          return;
        }
        setStatus(s.status);
        if (s.status === 'error' && !s.result) setError(s.error || '策略趋势诊断失败');
        startDiagnosis(); // 自动回测三档范围全部策略
      } catch {
        if (!cancelled) setError('获取策略趋势诊断状态失败，请检查后端服务');
      }
    })();

    return () => {
      cancelled = true;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 下载 JSON：包含三种时间范围所有策略的回测结果（汇总指标 + 逐笔交易 + 跳过项）
  const handleDownload = () => {
    if (!result) return;
    const payload = {
      type: 'strategy_trend_diagnosis',
      generatedAt: result.generatedAt,
      ranges: (result.ranges || []).map(r => ({
        key: r.key,
        label: r.label,
        days: r.days,
        startDate: r.startDate,
        endDate: r.endDate,
        strategyCount: r.report?.strategyCount ?? 0,
        skipped: r.report?.skipped || [],
        strategies: r.report?.strategies || [],
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `策略趋势诊断_${dayjs().format('YYYYMMDD_HHmm')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    message.success('已下载策略趋势诊断 JSON 文件');
  };

  const running = status === 'running';
  const ranges = result?.ranges || [];

  // 三档范围的报告未生成前（ranges 为空）activeTab 默认值 'default' 无对应项，回退到历史曲线 tab
  const effectiveActiveKey = [...ranges.map(r => r.key), 'monthly'].includes(activeTab)
    ? activeTab
    : (ranges.length > 0 ? 'default' : 'monthly');

  // 单个范围的报告内容（与回测报告弹窗同格式：按整体收益排名的策略卡片列表）
  // 注意：必须声明在 tabItems 之前——tabItems 构建时 ranges.map 会同步调用本函数
  const renderRangeContent = (r) => {
    const report = r?.report;
    if (!report) {
      return <Empty description={r?.message || '该范围暂无报告'} />;
    }
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: '#6b7890' }}>
            回测范围：{fmtDate(r.startDate)} ~ {fmtDate(r.endDate)}（最近 {r.days} 个交易日）
          </span>
          <Tag style={{ marginInlineEnd: 0 }} color="blue">{report.strategyCount} 策略</Tag>
          {(report.skipped || []).length > 0 && (
            <Tag style={{ marginInlineEnd: 0 }} color="orange">跳过 {report.skipped.length} 个策略</Tag>
          )}
        </div>
        {(report.strategies || []).length === 0 ? (
          <Empty description="暂无可展示的策略回测数据" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(report.strategies || []).map(s => <StrategyCard key={s.id} strategy={s} rank={s.rank} />)}
          </div>
        )}
      </>
    );
  };

  // tab 项：三档时间范围报告 + 历史曲线（自然月 × 全部策略，始终展示，首次激活时自动补测）
  const tabItems = [
    ...ranges.map(r => ({
      key: r.key,
      label: (
        <span>
          <TrophyOutlined style={{ color: '#d48806', marginRight: 4 }} />
          {r.label}
          {r.startDate && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>{fmtDate(r.startDate)}~{fmtDate(r.endDate)}</span>}
        </span>
      ),
      children: renderRangeContent(r),
    })),
    {
      key: 'monthly',
      label: (
        <span>
          <LineChartOutlined style={{ color: '#1677ff', marginRight: 4 }} />
          历史曲线
        </span>
      ),
      children: <MonthlyCurveTab active={effectiveActiveKey === 'monthly'} />,
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LineChartOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>策略趋势诊断</span>
          <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>默认 / 30交易日 / 15交易日 × 全部策略 · 自然月历史曲线</span>
        </div>
      }
      footer={null}
      width="80%"
      styles={{ body: { padding: 16, background: '#f7f9fc', maxHeight: '70vh', overflowY: 'auto' } }}
    >
      {/* 顶部操作区：下载 JSON + 重新诊断 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16, background: '#fff', borderRadius: 12, padding: '12px 14px', boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={handleDownload}
          disabled={!result}
          style={{ borderRadius: 999 }}
        >
          下载 JSON
        </Button>
        <Button
          icon={<ReloadOutlined />}
          onClick={startDiagnosis}
          loading={running || starting}
          style={{ borderRadius: 999 }}
        >
          {running ? '诊断中…' : '重新诊断'}
        </Button>
        {result?.generatedAt && (
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            上次完成时间：{result.generatedAt}
          </span>
        )}
      </div>

      {/* 诊断进行中提示（含最近日志） */}
      {running && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="策略趋势诊断进行中：三档时间范围（默认范围 / 30 交易日 / 15 交易日）× 全部策略自动回测，已有缓存的策略自动跳过"
          description={
            <div>
              <Spin size="small" style={{ marginRight: 8 }} />
              {logs.length > 0 ? logs[logs.length - 1] : '正在启动诊断 worker 进程…'}
            </div>
          }
        />
      )}

      {error && (
        <Alert type="error" showIcon message="策略趋势诊断" description={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      )}

      {/* 三档时间范围 tab + 历史曲线 tab（策略报告复用回测报告弹窗卡片格式） */}
      <Tabs
        activeKey={effectiveActiveKey}
        onChange={setActiveTab}
        items={tabItems}
      />

      <div style={{ height: 8 }} />
    </Modal>
  );
};

export default TrendDiagnosisModal;
