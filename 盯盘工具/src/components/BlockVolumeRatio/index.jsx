import { useEffect, useMemo, useState, useCallback } from 'react';
import axios from 'axios';
import { Button, DatePicker, Empty, Select, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend, Filler);

const TECH_NAME = '科技';

const COLORS = [
  '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#eb2f96', '#13c2c2', '#fa8c16', '#a0d911', '#2f54eb',
  '#fa541c', '#8c8c8c', '#36cfc9', '#73d13d', '#ffc53d',
  '#9254de', '#f759ab', '#08979c', '#d46b08', '#7cb305',
  '#1d39c4', '#ad4e00', '#595959', '#5cdbd3', '#95de64',
  '#ffd666', '#b37feb', '#ff85c0', '#006d75', '#a8071a',
  '#237804', '#003a8c', '#874d00', '#531dab',
];

const formatTime = (time) => {
  const str = String(time || '');
  if (str.length < 4) return str;
  return `${str.slice(0, 2)}:${str.slice(2, 4)}`;
};

const BlockVolumeRatio = () => {
  const [subTab, setSubTab] = useState('daily');
  const [history, setHistory] = useState({ blocks: [], live: null });
  const [intraday, setIntraday] = useState({ date: '', updatedAt: '', points: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // null 表示默认全选板块
  const [range, setRange] = useState(() => [dayjs().subtract(60, 'day'), dayjs()]);

  const fetchHistory = useCallback(async () => {
    try {
      const resp = await axios.get(`http://${local_ip}:3000/block_volume_ratio_history`);
      const data = resp.data || {};
      setHistory({
        blocks: Array.isArray(data.blocks) ? data.blocks : [],
        live: data.live || null,
      });
      setError(null);
    } catch (err) {
      console.error('获取板块历史成交量占比失败:', err);
      setError('获取板块历史成交量占比失败，请检查后端服务');
    }
  }, []);

  const fetchIntraday = useCallback(async () => {
    try {
      const resp = await axios.get(`http://${local_ip}:3000/block_volume_ratio_intraday`);
      const data = resp.data || {};
      setIntraday({
        date: data.date || '',
        updatedAt: data.updatedAt || '',
        points: Array.isArray(data.points) ? data.points : [],
      });
      setError(null);
    } catch (err) {
      console.error('获取板块成交量占比分时数据失败:', err);
      setError('获取板块成交量占比分时数据失败，请检查后端服务');
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchHistory(), fetchIntraday()]);
    setLoading(false);
  }, [fetchHistory, fetchIntraday]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // 每 10 分钟刷新一次，与后端 block_amount_poll 保持一致
  useEffect(() => {
    const timer = setInterval(() => {
      fetchAll();
    }, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  const availableNames = useMemo(() => {
    const names = history.blocks.map((block) => block.name);
    if (names.length > 0) return names;
    const point = intraday.points[intraday.points.length - 1];
    return point && point.ratios ? Object.keys(point.ratios) : [];
  }, [history, intraday]);

  // 未手动选择时展示全部板块；手动选择后按所选过滤
  const effectiveSelected = useMemo(() => {
    if (selected === null) return availableNames;
    return availableNames.filter((name) => selected.includes(name));
  }, [selected, availableNames]);

  // 按日期范围裁剪每个板块的历史占比，并标记当日实时点
  const dailyChartItems = useMemo(() => {
    if (!range || !range[0] || !range[1]) return [];
    const start = range[0].format('YYYYMMDD');
    const end = range[1].format('YYYYMMDD');
    const liveTime = history.live?.time ? formatTime(history.live.time) : '';

    return history.blocks
      .filter((block) => effectiveSelected.includes(block.name))
      .map((block) => {
        const points = (block.points || []).filter((point) => point.date >= start && point.date <= end);
        const colorIndex = availableNames.indexOf(block.name);
        const color = COLORS[(colorIndex >= 0 ? colorIndex : 0) % COLORS.length];
        const latest = points[points.length - 1] || null;
        const prev = points[points.length - 2] || null;
        // 相比前一日占比变化（百分点）
        const change = latest && prev && isFinite(Number(latest.ratio)) && isFinite(Number(prev.ratio))
          ? Number(latest.ratio) - Number(prev.ratio)
          : null;
        const liveIndex = points.findIndex((point) => point.live);

        return {
          name: block.name,
          color,
          latest,
          change,
          data: {
            labels: points.map((point) => `${point.date.slice(4, 6)}-${point.date.slice(6, 8)}`),
            datasets: [
              {
                label: block.name,
                data: points.map((point) => (isFinite(Number(point.ratio)) ? Number(point.ratio) : null)),
                borderColor: color,
                backgroundColor: `${color}1f`,
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                spanGaps: true,
                pointRadius: points.map((_, i) => (i === liveIndex ? 3 : 0)),
                pointHoverRadius: 4,
                pointBackgroundColor: points.map((_, i) => (i === liveIndex ? '#f97316' : color)),
                liveIndex,
                liveTime,
              },
            ],
          },
        };
      });
  }, [history, effectiveSelected, availableNames, range]);

  // 按「相比前一日占比变化」拆分：提升（含持平/无对比）与下降
  const upItems = useMemo(() => dailyChartItems
    .filter((item) => item.change === null || item.change >= 0)
    .sort((a, b) => (b.change || 0) - (a.change || 0)), [dailyChartItems]);

  const downItems = useMemo(() => dailyChartItems
    .filter((item) => item.change !== null && item.change < 0)
    .sort((a, b) => a.change - b.change), [dailyChartItems]);

  const dailyChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const value = ctx.parsed.y;
            if (value === null || value === undefined) return '无数据';
            const isLive = ctx.dataset.liveIndex === ctx.dataIndex;
            const timeText = ctx.dataset.liveTime ? ` ${ctx.dataset.liveTime}` : '';
            return `${isLive ? `实时${timeText} ` : ''}占比 ${Number(value).toFixed(2)}%`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: '#94a3b8', maxTicksLimit: 8, maxRotation: 45, minRotation: 45, font: { size: 9 } },
      },
      y: {
        grid: { color: 'rgba(148, 163, 184, 0.18)' },
        ticks: { color: '#94a3b8', font: { size: 10 }, callback: (value) => `${value}%` },
      },
    },
  }), []);

  const intradayAvailableNames = useMemo(() => {
    const point = intraday.points[intraday.points.length - 1];
    if (point && point.ratios) return Object.keys(point.ratios);
    return availableNames;
  }, [intraday, availableNames]);

  const intradaySelected = useMemo(() => {
    if (selected === null) return intradayAvailableNames;
    return intradayAvailableNames.filter((name) => selected.includes(name));
  }, [selected, intradayAvailableNames]);

  // 每个板块「最新日 vs 上一日」的占比变化：与日成交量占比使用同一口径
  const latestChangeByName = useMemo(() => {
    const map = new Map();
    for (const block of history.blocks) {
      const points = block.points || [];
      const latest = points[points.length - 1];
      const prev = points[points.length - 2];
      const change = latest && prev
        && isFinite(Number(latest.ratio)) && isFinite(Number(prev.ratio))
        ? Number(latest.ratio) - Number(prev.ratio)
        : null;
      map.set(block.name, change);
    }
    return map;
  }, [history]);

  // 分时图：每个板块一张独立折线图，涨跌分组与日成交量占比保持一致
  const intradayChartItems = useMemo(() => {
    const labels = intraday.points.map((point) => formatTime(point.time));

    return intradaySelected.map((name) => {
      const index = intradayAvailableNames.indexOf(name);
      const color = COLORS[index >= 0 ? index % COLORS.length : 0];
      const values = intraday.points.map((point) => {
        const value = point.ratios ? point.ratios[name] : null;
        return value === null || value === undefined || !isFinite(Number(value)) ? null : Number(value);
      });

      let latest = null;
      for (let i = values.length - 1; i >= 0; i -= 1) {
        if (values[i] !== null) {
          latest = values[i];
          break;
        }
      }

      const change = latestChangeByName.get(name);
      return {
        name,
        color,
        latest: latest !== null ? { ratio: latest } : null,
        change: change === undefined ? null : change,
        data: {
          labels,
          datasets: [
            {
              label: name,
              data: values,
              borderColor: color,
              backgroundColor: `${color}1f`,
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              spanGaps: true,
              pointRadius: 0,
              pointHoverRadius: 4,
            },
          ],
        },
      };
    });
  }, [intraday, intradaySelected, intradayAvailableNames, latestChangeByName]);

  // 按「相比上一日占比变化」拆分：提升（含持平/无对比）与下降
  const intradayUpItems = useMemo(() => intradayChartItems
    .filter((item) => item.change === null || item.change >= 0)
    .sort((a, b) => (b.change || 0) - (a.change || 0)), [intradayChartItems]);

  const intradayDownItems = useMemo(() => intradayChartItems
    .filter((item) => item.change !== null && item.change < 0)
    .sort((a, b) => a.change - b.change), [intradayChartItems]);

  const historySubtitle = useMemo(() => {
    if (subTab !== 'daily') {
      const dateText = intraday.date ? `数据日期 ${formatDate(intraday.date)}` : '';
      const updateText = intraday.updatedAt ? ` · 更新于 ${intraday.updatedAt}` : '';
      return `${dateText}${updateText}`;
    }
    if (!history.live) return '按日统计各板块成交量占全市场成交额的比例';
    return `当日实时占比 ${formatDate(history.live.date)} ${formatTime(history.live.time)} · 全市场成交额 ${Number(history.live.marketTotalAmount || 0).toFixed(0)}亿`;
  }, [subTab, intraday, history]);

  const renderLineCard = (item) => (
    <div className="bvr-line-card" key={item.name}>
      <div className="bvr-line-card-header">
        <span className="bvr-line-card-name">
          {item.name}
          {item.name === TECH_NAME ? <span className="bvr-badge">汇总</span> : null}
        </span>
        <span className="bvr-line-card-value">
          {item.latest ? `${Number(item.latest.ratio).toFixed(2)}%` : '--'}
        </span>
        {item.change !== null ? (
          <span className={`bvr-line-card-change ${item.change >= 0 ? 'up' : 'down'}`}>
            {item.change >= 0 ? '+' : ''}{item.change.toFixed(2)}pp
          </span>
        ) : null}
      </div>
      <div className="bvr-line-card-body">
        {item.data.labels.length > 0 ? (
          <Line data={item.data} options={dailyChartOptions} />
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="block-volume-ratio">
      <div className="bvr-header">
        <div className="bvr-header-left">
          <div className="bvr-title">板块成交量占比</div>
          <div className="bvr-subtitle">{historySubtitle}</div>
        </div>
        <div className="bvr-header-right">
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      <div className="bvr-sub-tabs">
        <Button
          size="small"
          type={subTab === 'daily' ? 'primary' : 'default'}
          onClick={() => setSubTab('daily')}
        >
          日成交量占比
        </Button>
        <Button
          size="small"
          type={subTab === 'intraday' ? 'primary' : 'default'}
          onClick={() => setSubTab('intraday')}
        >
          分时图
        </Button>
      </div>

      {error ? <div className="bvr-error">{error}</div> : null}

      {loading && history.blocks.length === 0 && intraday.points.length === 0 ? (
        <div className="bvr-loading"><Spin /></div>
      ) : null}

      {subTab === 'daily' && (
        <div className="bvr-daily">
          <div className="bvr-daily-toolbar">
            <span className="bvr-toolbar-label">日期范围</span>
            <DatePicker.RangePicker
              size="small"
              value={range}
              onChange={(dates) => dates && setRange(dates)}
              format="YYYY-MM-DD"
              allowClear={false}
              disabledDate={(current) => {
                if (!current) return false;
                return current.isBefore(dayjs('2026-04-01').startOf('day'))
                  || current.isAfter(dayjs().endOf('day'));
              }}
            />
            <span className="bvr-toolbar-label">展示板块</span>
            <Select
              mode="multiple"
              size="small"
              value={effectiveSelected}
              onChange={setSelected}
              options={availableNames.map((name) => ({ label: name, value: name }))}
              style={{ minWidth: 260, flex: 1, maxWidth: 560 }}
              maxTagCount="responsive"
              placeholder="选择板块"
            />
          </div>

          {dailyChartItems.length === 0 ? (
            <Empty
              description={effectiveSelected.length === 0 ? '请选择要展示的板块' : '暂无历史占比数据'}
              style={{ marginTop: 48 }}
            />
          ) : (
            <>
              {upItems.length > 0 && (
                <div className="bvr-group">
                  <div className="bvr-group-title up">
                    相比前一日占比提升
                    <span className="bvr-group-count">{upItems.length}</span>
                  </div>
                  <div className="bvr-line-grid">
                    {upItems.map(renderLineCard)}
                  </div>
                </div>
              )}
              {downItems.length > 0 && (
                <div className="bvr-group">
                  <div className="bvr-group-title down">
                    相比前一日占比下降
                    <span className="bvr-group-count">{downItems.length}</span>
                  </div>
                  <div className="bvr-line-grid">
                    {downItems.map(renderLineCard)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {subTab === 'intraday' && (
        <div className="bvr-intraday">
          <div className="bvr-intraday-toolbar">
            <span className="bvr-toolbar-label">展示板块</span>
            <Select
              mode="multiple"
              size="small"
              value={intradaySelected}
              onChange={setSelected}
              options={intradayAvailableNames.map((name) => ({ label: name, value: name }))}
              style={{ minWidth: 320, flex: 1, maxWidth: 640 }}
              maxTagCount="responsive"
              placeholder="选择板块"
            />
          </div>
          {intraday.points.length === 0 ? (
            <Empty description="暂无分时数据，交易时段内每 10 分钟自动采集一次" />
          ) : intradayChartItems.length === 0 ? (
            <Empty description="请选择要展示的板块" style={{ marginTop: 48 }} />
          ) : (
            <>
              {intradayUpItems.length > 0 && (
                <div className="bvr-group">
                  <div className="bvr-group-title up">
                    相比上一日占比提升
                    <span className="bvr-group-count">{intradayUpItems.length}</span>
                  </div>
                  <div className="bvr-line-grid">
                    {intradayUpItems.map(renderLineCard)}
                  </div>
                </div>
              )}
              {intradayDownItems.length > 0 && (
                <div className="bvr-group">
                  <div className="bvr-group-title down">
                    相比上一日占比下降
                    <span className="bvr-group-count">{intradayDownItems.length}</span>
                  </div>
                  <div className="bvr-line-grid">
                    {intradayDownItems.map(renderLineCard)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

function formatDate(dateStr) {
  const str = String(dateStr || '');
  if (str.length !== 8) return str;
  return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}

export default BlockVolumeRatio;
