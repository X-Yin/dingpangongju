import { useState, useEffect, useRef, useMemo } from 'react';
import { Drawer, Button, DatePicker, message, Progress, Tag, Empty, Alert, Select, Tooltip } from 'antd';
import {
  CopyOutlined,
  StopOutlined,
  BarChartOutlined,
  RiseOutlined,
  FallOutlined,
  ThunderboltOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import BacktestReportModal from '../BacktestReportModal';

// 回测最早支持日期（早于此日期无回放数据）
const EARLIEST_DATE = '20260803';
// 默认回测范围窗口（最近 N 个交易日），与后端 backtestReport.js 的 getDefaultReportRange /
// backtest-worker.js 的回测时间口径一致；可用交易日不足 N 个时自动取最早的一个日期
const REPORT_DAYS = 60;
const fmtDate = (d) => `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
const fmtPct = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '--';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

// 当前买卖点诊断规则说明（与训练营回放 / buySellBacktest 后端逻辑保持一致，供复制到外部分析）
const BUY_RULES = [
  { key: 'fund_inflow', title: '最近 5 分钟资金净流入', desc: '最近 5min 大盘主力资金净流入大于 20 亿才触发买入' },
  { key: 'volume_expansion', title: '量能变化', desc: '当前量能（今日累计成交额-昨日全天）为 0 以上：较 5min 前增加即可；量能为负：需较 5min 前增加不小于 100 亿。若今日或前一交易日科技情绪触及 -100 退潮冰点（hasIce）则此项自动豁免' },
  { key: 'opening_below', title: '开盘后自选股低于开盘价数量', desc: '仅 9:30-10:00 生效：现价低于 9:30 开盘价的自选股数量不超过 30 只' },
  { key: 'emotion_retrace_after_open', title: '竞价情绪回落', desc: '9:30 竞价科技情绪 > 80 时，需当前科技情绪 < 40 才允许买入；开盘情绪 ≤80 或无线数据时该项不限制' },
];
const SELL_RULES = [
  { key: 'condition1', title: '均线破位', desc: '根据 MA5/MA10 斜率与开盘价位置分四种规则，跌破对应均线或前一交易日最低价触发卖点' },
  { key: 'condition2', title: '高位放量大阴线', desc: '日内最高价到现价回落超过 8%，且现价低于日内开盘价，需持续 ≥5 分钟才触发' },
  { key: 'condition3', title: '科技板块情绪退潮', desc: '科技情绪指数 = -100 且自选股中跌幅 <-9% 的个股 ≥5 个，需持续 ≥5 分钟才触发' },
  { key: 'condition4', title: '抗分歧指数弱势', desc: '抗分歧指数 < 6 且当前涨幅 ≤ -5%，仅 14:50 后生效' },
  { key: 'condition5', title: '连续三日抗分歧弱势', desc: '近三日（含当日）抗分歧指数均 < 10，仅 9:40 后生效' },
  { key: 'condition6', title: '跌破最迟买入日低点', desc: '现价跌破买入当日最低点，需持续 ≥5 分钟才触发' },
];

// 回测策略选项（与后端 buySellBacktest.STRATEGIES 保持一致；全量自选股策略已移除）
const STRATEGY_OPTIONS = [
  { value: 'highest_gain', label: '买入最高涨幅' },
  { value: 'highest_5d_gain', label: '5日涨幅最大' },
  { value: 'highest_3d_gain', label: '3日涨幅最大' },
  { value: 'highest_3d_gain_switch', label: '连续切换三日涨幅' },
  { value: 'highest_4d_gain', label: '4日涨幅最大' },
  { value: 'highest_2d_gain', label: '2日涨幅最大' },
  { value: 'highest_10d_gain', label: '10日涨幅最大' },
  { value: 'highest_3d_gain_twice', label: '3日涨幅两次买入' },
  { value: 'highest_3d_gain_quarter', label: '三日涨幅四份仓位' },
  { value: 'highest_3d_gain_two', label: '三日涨幅两个股票' },
  { value: 'highest_5d_gain_2nd', label: '5日涨幅第二名' },
  { value: 'highest_3d_gain_2nd', label: '3日涨幅第二名' },
  { value: 'highest_3d_ma_slope', label: '3日线斜率最陡峭' },
  { value: 'highest_5d_ma_slope', label: '5日线斜率最陡峭' },
  { value: 'highest_5d_resilience', label: '5日抗分歧分数最大' },
  { value: 'highest_3d_resilience', label: '3日抗分歧分数最大' },
  { value: 'resilience_weak_to_strong', label: '抗分歧弱转强' },
  { value: 'highest_3d_reports', label: '3日研报覆盖数最多' },
  { value: 'highest_5d_reports', label: '5日研报覆盖数最多' },
  { value: 'highest_3d_reports_2nd', label: '3日研报覆盖数第二名' },
  { value: 'highest_5d_reports_2nd', label: '5日研报覆盖数第二名' },
  { value: 'highest_3d_reports_top5_gain', label: '3日研报前五&涨幅最大' },
  { value: 'highest_5d_reports_top5_gain', label: '5日研报前五&涨幅最大' },
  { value: 'tail_dip_1d_gain', label: '尾盘抄底-当日涨幅最大' },
  { value: 'tail_dip_3d_gain', label: '尾盘抄底-3日涨幅最大' },
  { value: 'tail_dip_1d_resilience', label: '尾盘抄底-当日抗分歧最大' },
  { value: 'tail_dip_3d_resilience', label: '尾盘抄底-3日抗分歧最大' },
  { value: 'tail_dip_1d_fall', label: '尾盘抄底-当日跌幅最大' },
  { value: 'tail_dip_3d_fall', label: '尾盘抄底-3日跌幅最大' },
  { value: 'tail_dip_1d_resilience_low', label: '尾盘抄底-当日抗分歧分数最低' },
];

// 买入原因标签：显示命中了哪些买入条件（悬停展示逐项明细：条件标题、数值与判定理由）
const BuyReasonTag = ({ reason, checks }) => {
  if (!reason) return null;
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

// 计算回测汇总指标（兼容全量策略 stocks 与单股策略 summary 两种结果结构）
const buildSummary = (result) => {
  if (result?.type === 'single') {
    const sum = result.summary || {};
    return {
      stockCount: (result.seenStocks || []).length,
      totalTrades: sum.tradeCount || 0,
      winTrades: sum.winCount || 0,
      winRate: sum.winRate != null ? Number(sum.winRate) : null,
      avgReturn: null,
      overallReturn: sum.overallReturn != null ? Number(sum.overallReturn) : null,
      holdingCount: sum.holding ? 1 : 0,
    };
  }
  const stocks = result?.stocks || [];
  let totalTrades = 0;
  let winTrades = 0;
  let returnSum = 0;
  let validReturns = 0;
  let holdingCount = 0;
  stocks.forEach(s => {
    s.trades.forEach(t => {
      totalTrades++;
      if (t.returnRate != null && !Number.isNaN(Number(t.returnRate))) {
        returnSum += Number(t.returnRate);
        validReturns++;
        if (Number(t.returnRate) > 0) winTrades++;
      }
    });
    if (s.holding) holdingCount++;
  });
  return {
    stockCount: stocks.length,
    totalTrades,
    winTrades,
    winRate: totalTrades > 0 ? (winTrades / totalTrades) * 100 : null,
    avgReturn: validReturns > 0 ? returnSum / validReturns : null,
    overallReturn: null,
    holdingCount,
  };
};

const BacktestDrawer = ({ open, onClose, dates = [] }) => {
  const [range, setRange] = useState(null);
  const [strategy, setStrategy] = useState('highest_gain');
  const [reportOpen, setReportOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { current, total, date, status }
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copying, setCopying] = useState(false);
  const pollRef = useRef(null);
  const taskIdRef = useRef(null);
  const [workerRunning, setWorkerRunning] = useState(false); // 全量回测（backtest-worker.js）后台执行中
  const [workerLog, setWorkerLog] = useState(''); // worker 最近一条日志
  const workerPollRef = useRef(null);

  const availableDates = useMemo(() => (Array.isArray(dates) ? dates : []), [dates]);
  const maxDateStr = availableDates.length > 0 ? availableDates[0] : dayjs().format('YYYYMMDD');
  // 未手动选择时默认取「最近 60 个可用交易日」（不足 60 个时取最早的一个日期），与后端回测报告 /
  // worker 预生成缓存的日期范围口径一致，
  // 保证 worker 跑完后打开抽屉能直接命中缓存（此前写死最早日期会因范围不一致查不到缓存而空白）
  const defaultRange = useMemo(() => {
    if (availableDates.length === 0) return [dayjs(EARLIEST_DATE, 'YYYYMMDD'), dayjs(maxDateStr, 'YYYYMMDD')];
    const sortedAsc = [...availableDates].sort();
    const start = sortedAsc[Math.max(0, sortedAsc.length - REPORT_DAYS)];
    const end = sortedAsc[sortedAsc.length - 1];
    return [dayjs(start, 'YYYYMMDD'), dayjs(end, 'YYYYMMDD')];
  }, [availableDates, maxDateStr]);
  const effectiveRange = range || defaultRange;

  // 组件卸载时停止轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (workerPollRef.current) clearInterval(workerPollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // 查询当前 策略+日期范围 是否已有缓存结果：有则直接展示，无需重新回测
  const checkCache = async () => {
    const pick = range || defaultRange;
    if (!pick || !pick[0] || !pick[1] || running) return;
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) return;
    try {
      const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/cache`, {
        params: { startDate, endDate, strategy },
      });
      if (r.data?.success && r.data.cached && r.data.result) {
        setResult(r.data.result);
        setError(null);
      } else if (r.data?.success && !r.data.cached) {
        // 无缓存：清空旧结果，避免展示与当前策略/日期不符的数据
        setResult(null);
      }
    } catch {
      // 网络异常时保持现状
    }
  };

  // 打开抽屉、切换策略或修改日期范围时检查缓存（延迟到宏任务，避免 effect 内同步 setState）
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(checkCache, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, strategy, range]);

  const startPolling = (taskId) => {
    stopPolling();
    taskIdRef.current = taskId;
    pollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/status/${taskId}`);
        const s = r.data;
        if (s.status === 'running') {
          setProgress(s.progress || null);
        } else {
          stopPolling();
          setRunning(false);
          if (s.status === 'done' && s.result) {
            setResult(s.result);
            message.success('回测完成');
          } else if (s.status === 'error') {
            setError(s.error || '回测失败');
          } else {
            setError('任务状态异常');
          }
        }
      } catch {
        // 忽略单次轮询失败，继续等待
      }
    }, 2000);
  };

  const handleStart = async (force = false) => {
    const pick = effectiveRange;
    if (!pick || !pick[0] || !pick[1]) {
      message.warning('请选择回测日期范围');
      return;
    }
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) {
      message.warning('开始日期不能晚于结束日期');
      return;
    }
    setResult(null);
    setError(null);
    setProgress({ current: 0, total: 0, date: '', status: '' });
    setRunning(true);
    try {
      const r = await axios.post(`http://${local_ip}:3000/training_camp/backtest`, { startDate, endDate, strategy, force });
      if (r.data?.success && r.data.taskId) {
        startPolling(r.data.taskId);
      } else if (r.data?.success && r.data.cached && r.data.result) {
        // 服务端命中缓存，直接展示
        setResult(r.data.result);
        setRunning(false);
        message.success('已加载缓存回测结果');
      } else {
        setRunning(false);
        setError(r.data?.message || '创建回测任务失败');
      }
    } catch {
      setRunning(false);
      setError('创建回测任务失败，请检查后端服务');
    }
  };

  const stopWorkerPolling = () => {
    if (workerPollRef.current) {
      clearInterval(workerPollRef.current);
      workerPollRef.current = null;
    }
  };

  const startWorkerPolling = () => {
    stopWorkerPolling();
    workerPollRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/worker/status`);
        const s = r.data || {};
        const logs = Array.isArray(s.logs) ? s.logs : [];
        setWorkerLog(logs[logs.length - 1] || '');
        if (s.status !== 'running') {
          stopWorkerPolling();
          setWorkerRunning(false);
          if (s.status === 'done') {
            message.success('全量回测完成，回测报告已重新生成');
            setTimeout(checkCache, 0); // 拉取重跑后的最新缓存结果
          } else {
            message.error('全量回测失败，详情见服务端日志');
          }
        }
      } catch {
        // 忽略单次轮询失败，继续等待
      }
    }, 3000);
  };

  // 回测全部：后台执行 backtest-worker.js（清空回测缓存 → 预热日K → 并行预构建 → 全部策略并行回测 → 自动汇总生成回测报告）
  const handleRunAll = async () => {
    const pick = effectiveRange;
    if (!pick || !pick[0] || !pick[1]) {
      message.warning('请选择回测日期范围');
      return;
    }
    const startDate = pick[0].format('YYYYMMDD');
    const endDate = pick[1].format('YYYYMMDD');
    if (startDate > endDate) {
      message.warning('开始日期不能晚于结束日期');
      return;
    }
    try {
      const r = await axios.post(`http://${local_ip}:3000/training_camp/backtest/worker`, { startDate, endDate });
      if (r.data?.success) {
        setWorkerRunning(true);
        setWorkerLog('全量回测已启动：清空回测缓存 → 预热日K线 → 预构建回放数据…');
        startWorkerPolling();
        message.info('全量回测已启动（全部策略强制重跑），完成后结果与报告自动刷新');
      } else {
        message.error(r.data?.message || '启动全量回测失败');
      }
    } catch {
      message.error('启动全量回测失败，请检查后端服务');
    }
  };

  // 打开抽屉时同步一次全量回测状态（worker 正在后台跑时恢复按钮态与轮询）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    axios.get(`http://${local_ip}:3000/training_camp/backtest/worker/status`).then((r) => {
      if (cancelled) return;
      const s = r.data || {};
      if (s.status === 'running') {
        const logs = Array.isArray(s.logs) ? s.logs : [];
        setWorkerRunning(true);
        setWorkerLog(logs[logs.length - 1] || '全量回测进行中…');
        startWorkerPolling();
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleCopy = async () => {
    if (!result) return;
    if (copying) return;
    setCopying(true);
    try {
      const pick = range || defaultRange;
      const startDate = pick[0].format('YYYYMMDD');
      const endDate = pick[1].format('YYYYMMDD');

      // 1) 批量拉取全部自选股 K 线数据（覆盖回测范围，limit 取 100）
      const codes = (result.stocks || result.seenStocks || []).map(s => s.code).filter(Boolean);
      let kline = {};
      if (codes.length > 0) {
        try {
          const kr = await axios.post(`http://${local_ip}:3000/data_center/stocks_kline`, { codes, limit: 100 });
          if (kr.data?.success) {
            // 清除单只获取失败的错误占位，避免混入 JSON
            Object.entries(kr.data.data || {}).forEach(([code, arr]) => {
              if (Array.isArray(arr)) kline[code] = arr;
            });
          }
        } catch {
          kline = {};
        }
      }

      // 2) 规则文本描述
      const buyRulesText = BUY_RULES.map(r => `- ${r.title}：${r.desc}`).join('\n');
      const sellRulesText = SELL_RULES.map(r => `- ${r.title}：${r.desc}`).join('\n');
      const rulesText = `【买入规则】\n${buyRulesText}\n\n【卖出规则】\n${sellRulesText}`;

      // 3) 拉取除「全量自选股」外所有策略的回测结果（优先命中缓存，未运行的策略跳过）
      const strategies = [];
      for (const opt of STRATEGY_OPTIONS) {
        if (opt.value === 'all') continue;
        try {
          const r = await axios.get(`http://${local_ip}:3000/training_camp/backtest/cache`, {
            params: { startDate, endDate, strategy: opt.value },
          });
          const cached = r.data?.cached && r.data?.result ? r.data.result : null;
          if (!cached) continue;
          const sum = cached.summary || {};
          strategies.push({
            id: opt.value,
            name: opt.label,
            summary: {
              tradeCount: sum.tradeCount || 0,
              winCount: sum.winCount || 0,
              winRate: sum.winRate != null ? Number(sum.winRate) : null,
              overallReturn: sum.overallReturn != null ? Number(sum.overallReturn) : null,
              holding: sum.holding ? 1 : 0,
            },
            trades: (cached.trades || []).map(t => ({
              seq: t.seq,
              stockName: t.stockName,
              code: t.code,
              metric: t.metric ?? null,
              buyDate: t.buyDate,
              buyTime: t.buyTime,
              buyPrice: t.buyPrice,
              buyChange: t.buyChange,
              buyReason: t.buyReason ?? null,
              buyChecks: t.buyChecks ?? null,
              sellDate: t.sellDate,
              sellTime: t.sellTime,
              sellPrice: t.sellPrice,
              returnRate: t.returnRate,
              sellReason: t.sellReason,
            })),
          });
        } catch {
          // 单策略拉取失败跳过
        }
      }

      // 4) 序列化全部策略回测结果（含汇总指标 + 交易明细 + 买卖点规则 + 全部自选股K线）并附上待分析问题
      const payload = JSON.stringify({
        strategies,
        rules: {
          buy: BUY_RULES,
          sell: SELL_RULES,
        },
        rulesText,
        kline,
        question: '将所有的策略进行收益率的高低排序，根据胜率和赔率进行打分，按照从高到低进行排序，给出理由和依据',
      }, null, 2);

      await copyText(payload);
      message.success(`已复制 ${strategies.length} 个策略的回测结果（含 ${codes.length} 只自选股 K 线、买点/卖点规则）`);
    } catch {
      message.error('复制失败，请重试或手动复制');
    } finally {
      setCopying(false);
    }
  };

  // 兼容不同环境的剪贴板写入
  const copyText = async (payload) => {
    try {
      await navigator.clipboard.writeText(payload);
      return;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const summary = result ? buildSummary(result) : null;

  const progressPercent = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const disabledDate = (current) => {
    if (!current) return false;
    const ds = current.format('YYYYMMDD');
    return ds < EARLIEST_DATE || ds > maxDateStr;
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={860}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChartOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>买卖点回测</span>
          <Button
            type="primary"
            ghost
            size="small"
            icon={<BarChartOutlined />}
            onClick={() => setReportOpen(true)}
            style={{ marginLeft: 12, borderRadius: 999 }}
          >
            回测报告
          </Button>
          {result && !running ? (
            <Button
              size="small"
              type="primary"
              icon={<CopyOutlined />}
              onClick={handleCopy}
              loading={copying}
              style={{ marginLeft: 12, borderRadius: 999 }}
            >
              {copying ? '正在获取K线…' : '复制结果内容'}
            </Button>
          ) : null}
        </div>
      }
      styles={{ body: { padding: 16, paddingBottom: 96, background: '#f7f9fc' } }}
    >
      {/* 参数选择区 */}
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>回测日期范围</span>
          <DatePicker.RangePicker
            value={effectiveRange}
            onChange={setRange}
            disabledDate={disabledDate}
            allowClear={false}
            format="YYYY-MM-DD"
            disabled={running || workerRunning}
            style={{ flex: 1, minWidth: 280, maxWidth: 380 }}
          />
          <Button
            type="primary"
            icon={running ? <StopOutlined /> : <ThunderboltOutlined />}
            onClick={() => handleStart(true)}
            loading={running}
            disabled={workerRunning}
            style={{ borderRadius: 999, padding: '0 24px' }}
          >
            {running ? '回测中' : '强制回测'}
          </Button>
          <Button
            icon={<RocketOutlined />}
            onClick={handleRunAll}
            loading={workerRunning}
            disabled={running}
            style={{ borderRadius: 999 }}
          >
            {workerRunning ? '全量回测中' : '回测全部'}
          </Button>
        </div>

        {/* 回测策略选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a' }}>回测策略</span>
          <Select
            value={strategy}
            onChange={setStrategy}
            disabled={running}
            style={{ flex: 1, minWidth: 240, maxWidth: 360 }}
            options={STRATEGY_OPTIONS}
          />
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            切换策略或日期后自动匹配缓存，无需重复回测
          </span>
        </div>

        {/* 进度条 */}
        {running && (
          <div style={{ marginTop: 14 }}>
            <Progress
              percent={progressPercent}
              status="active"
              size="small"
              format={() => (progress && progress.total > 0 ? `${progress.current}/${progress.total} 天` : '准备中')}
            />
            <div style={{ fontSize: 12, color: '#6b7890', marginTop: 4 }}>
              {progress && progress.current > 0
                ? `正在回测 ${fmtDate(progress.date)}（${progress.current}/${progress.total}）……逐日回放全部自选股的买点/卖点诊断，耗时较长，请耐心等待`
                : '正在初始化回测任务……'}
            </div>
          </div>
        )}
        {/* 全量回测进行中提示 */}
        {workerRunning && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 14 }}
            message="全量回测进行中（清空回测缓存 → 预热日K线 → 并行预构建 → 全部策略并行回测 → 自动生成回测报告）"
            description={workerLog || '正在启动 worker 进程…'}
          />
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <Alert type="error" showIcon message="回测失败" description={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      )}

      {/* 回测结果 */}
      {result && summary && !running ? (
        <>
          {/* 汇总统计 */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { label: '覆盖自选股', value: `${summary.stockCount} 只` },
                { label: '成交笔数', value: `${summary.totalTrades} 笔` },
                { label: '盈利笔数', value: `${summary.winTrades} 笔` },
                { label: '胜率', value: summary.winRate != null ? `${summary.winRate.toFixed(1)}%` : '--', color: summary.winRate != null && summary.winRate >= 50 ? '#f5222d' : '#52c41a' },
                result.type === 'single'
                  ? { label: '整体收益', value: summary.overallReturn != null ? fmtPct(summary.overallReturn) : '--', color: summary.overallReturn != null ? (summary.overallReturn >= 0 ? '#f5222d' : '#52c41a') : undefined }
                  : { label: '平均单笔收益', value: summary.avgReturn != null ? fmtPct(summary.avgReturn) : '--', color: summary.avgReturn != null ? (summary.avgReturn >= 0 ? '#f5222d' : '#52c41a') : undefined },
                { label: '期末仍持仓', value: result.type === 'single' ? (summary.holdingCount > 0 ? '1 只' : '0 只') : `${summary.holdingCount} 只` },
              ].map(item => (
                <div key={item.label} style={{ flex: 1, minWidth: 110, background: '#f7f9fc', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{item.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: item.color || '#12213a', marginTop: 2 }}>{item.value}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10 }}>
              回测范围：{fmtDate(result.range?.startDate)} ~ {fmtDate(result.range?.endDate)}
              {result.skippedDates && result.skippedDates.length > 0
                ? `｜跳过无数据交易日 ${result.skippedDates.length} 天`
                : ''}
            </div>
          </div>

          {/* 单股策略：逐笔交易明细 */}
          {result.type === 'single' ? (
            result.trades.length === 0 && !result.currentHolding ? (
              <Empty description="所选范围内未产生任何成交" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {result.trades.map(t => (
                  <div key={t.seq} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                    {/* 交易头部 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>第{t.seq}笔</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{t.stockName}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{t.code}</span>
                      {t.metric != null && (
                        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                          选股指标 {Number(t.metric).toFixed(4)}
                        </Tag>
                      )}
                      <Tag color={Number(t.returnRate) >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                        收益 {fmtPct(t.returnRate)}
                      </Tag>
                    </div>

                    {/* 买卖明细 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ border: '1px solid #eef1f6', borderRadius: 8, padding: '8px 10px', background: '#fafbfd' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <RiseOutlined style={{ color: '#f5222d', fontSize: 12 }} />
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            买入 <b>{fmtDate(t.buyDate)} {t.buyTime}</b>
                          </span>
                          <span style={{ fontSize: 12, color: '#6b7890' }}>
                            价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.buyPrice).toFixed(2)}</b>
                          </span>
                          <span style={{ fontSize: 12 }}>
                            涨幅 <b style={{ color: t.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.buyChange)}</b>
                          </span>
                        </div>
                        {t.buyReason && (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                            <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                            <BuyReasonTag reason={t.buyReason} checks={t.buyChecks} />
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
                            卖出原因 <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t.sellReason}</Tag>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {/* 期末持仓 */}
                {result.currentHolding && (
                  <div style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>持仓中（未卖出）</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{result.currentHolding.stockName}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{result.currentHolding.code}</span>
                      {result.currentHolding.metric != null && (
                        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                          选股指标 {Number(result.currentHolding.metric).toFixed(4)}
                        </Tag>
                      )}
                      {result.currentHolding.buyReturn != null && (
                        <Tag color={Number(result.currentHolding.buyReturn) >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                          浮盈 {fmtPct(result.currentHolding.buyReturn)}
                        </Tag>
                      )}
                    </div>
                    <div style={{ border: '1px dashed #f5c96b', borderRadius: 8, padding: '8px 10px', background: '#fffbea' }}>
                      <span style={{ fontSize: 12, color: '#6b7890' }}>
                        买入 {fmtDate(result.currentHolding.buyDate)} {result.currentHolding.buyTime} 价格{' '}
                        <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(result.currentHolding.buyPrice).toFixed(2)}</b>
                      </span>
                      <span style={{ fontSize: 12, marginLeft: 10 }}>
                        涨幅 <b style={{ color: result.currentHolding.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(result.currentHolding.buyChange)}</b>
                      </span>
                      {result.currentHolding.buyReason && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                          <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                          <BuyReasonTag reason={result.currentHolding.buyReason} checks={result.currentHolding.buyChecks} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          ) : (
          /* 全量策略：每只股票一张卡片 */
          result.stocks.length === 0 ? (
            <Empty description="所选范围内未产生任何成交" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {result.stocks.map(stock => {
                const stockTotalReturn = stock.trades.reduce((s, t) => s + (Number(t.returnRate) || 0), 0);
                return (
                  <div key={stock.code} style={{ background: '#fff', borderRadius: 12, padding: 14, boxShadow: '0 1px 4px rgba(18,33,58,0.06)' }}>
                    {/* 卡片头部 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#12213a' }}>{stock.stockName}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'SF Mono', monospace" }}>{stock.code}</span>
                      <Tag color="blue" style={{ marginInlineEnd: 0 }}>{stock.trades.length} 笔成交</Tag>
                      {stock.trades.length > 0 && (
                        <Tag color={stockTotalReturn >= 0 ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                          累计收益 {fmtPct(stockTotalReturn)}
                        </Tag>
                      )}
                      {stock.holding && (
                        <Tag color="gold" style={{ marginInlineEnd: 0 }}>期末持仓中</Tag>
                      )}
                    </div>

                    {/* 成交明细 */}
                    {stock.trades.length === 0 && !stock.holding ? (
                      <div style={{ fontSize: 12, color: '#9ca3af' }}>所选范围内无买入信号触发</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {stock.trades.map((t, idx) => (
                          <div key={idx} style={{ border: '1px solid #eef1f6', borderRadius: 8, padding: '8px 10px', background: '#fafbfd' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                              <RiseOutlined style={{ color: '#f5222d', fontSize: 12 }} />
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#12213a' }}>
                                第{idx + 1}笔
                              </span>
                              <span style={{ fontSize: 12, color: '#6b7890' }}>
                                买入 <b>{fmtDate(t.buyDate)} {t.buyTime}</b>
                              </span>
                              <span style={{ fontSize: 12, color: '#6b7890' }}>
                                价格 <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(t.buyPrice).toFixed(2)}</b>
                              </span>
                              <span style={{ fontSize: 12 }}>
                                涨幅 <b style={{ color: t.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(t.buyChange)}</b>
                              </span>
                            </div>
                            {t.buyReason && (
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                                <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                                <BuyReasonTag reason={t.buyReason} checks={t.buyChecks} />
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
                                卖出原因 <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t.sellReason}</Tag>
                              </span>
                              <span style={{ fontSize: 13, fontWeight: 700, color: t.returnRate >= 0 ? '#f5222d' : '#52c41a' }}>
                                收益 {fmtPct(t.returnRate)}
                              </span>
                            </div>
                          </div>
                        ))}

                        {/* 期末持仓 */}
                        {stock.holding && (
                          <div style={{ border: '1px dashed #f5c96b', borderRadius: 8, padding: '8px 10px', background: '#fffbea' }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#ad6800' }}>持仓中（未卖出）</span>
                            <span style={{ fontSize: 12, color: '#6b7890', marginLeft: 10 }}>
                              买入 {fmtDate(stock.holding.buyDate)} {stock.holding.buyTime} 价格{' '}
                              <b style={{ color: '#12213a', fontFamily: "'SF Mono', monospace" }}>{Number(stock.holding.buyPrice).toFixed(2)}</b>
                            </span>
                            <span style={{ fontSize: 12, marginLeft: 10 }}>
                              涨幅 <b style={{ color: stock.holding.buyChange >= 0 ? '#f5222d' : '#52c41a' }}>{fmtPct(stock.holding.buyChange)}</b>
                            </span>
                            {stock.holding.buyReason && (
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                                <span style={{ fontSize: 12, color: '#6b7890', lineHeight: '22px' }}>买入原因</span>
                                <BuyReasonTag reason={stock.holding.buyReason} checks={stock.holding.buyChecks} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      ) : null}

      <BacktestReportModal open={reportOpen} onClose={() => setReportOpen(false)} />
    </Drawer>
  );
};

export default BacktestDrawer;
