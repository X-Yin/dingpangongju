import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Spin, Empty, Switch as AntSwitch, Tooltip } from 'antd';
import {
  FireOutlined, ThunderboltOutlined, AreaChartOutlined,
  RiseOutlined, FallOutlined, CaretDownOutlined, CaretUpOutlined,
  PieChartOutlined, FlagOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { parseMoneyValue, formatDisplayTime, aggregateFundByInterval } from '../../utils/fundAggregation';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import StockKLineModal from '../../components/StockKLineModal';
import './index.scss';

const TOP_THEME_COUNT = 6;

const formatPct = (v, { sign = true } = {}) => {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return '--';
  const num = Number(v);
  const prefix = sign && num > 0 ? '+' : '';
  return `${prefix}${num.toFixed(2)}%`;
};

const fmt = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? '--' : Number(v));

// ==================== 顶部情绪概览行 ====================
const OverviewBar = ({ overview }) => {
  const kpi = overview?.kpi || {};
  const sentiment = overview?.sentiment || {};
  const items = [
    { label: '情绪', value: sentiment.phase || '--', extra: sentiment.temperature != null ? `${sentiment.temperature}°` : '--', cls: 'phase' },
    { label: '涨停', value: fmt(kpi.limitUpCount), cls: 'up' },
    { label: '跌停', value: fmt(kpi.limitDownCount), cls: 'down' },
    { label: '连板', value: fmt(kpi.lianbanCount), cls: 'up' },
    { label: '最高板', value: kpi.maxLianban ? `${kpi.maxLianban.value}${kpi.maxLianban.unit || '板'}` : '--', cls: 'gold' },
    { label: '封板率', value: kpi.sealRate != null ? `${kpi.sealRate}%` : '--', cls: 'plain' },
    { label: '炸板', value: fmt(kpi.brokenBoardCount), cls: 'warn' },
    { label: '上涨/下跌', value: kpi.upCount != null ? `${fmt(kpi.upCount)}/${fmt(kpi.downCount)}` : '--', cls: 'plain' },
    { label: '两市成交', value: kpi.totalAmount || '--', cls: 'plain' },
  ];
  return (
    <div className="tm-overview">
      <div className="tm-overview-title">
        <FireOutlined className="tm-overview-icon" />
        <span>市场情绪</span>
        <span className="tm-overview-date">{overview?.pageDate || ''}</span>
      </div>
      <div className="tm-overview-cards">
        {items.map((it) => (
          <div key={it.label} className={`tm-kpi-card tm-kpi-${it.cls}`}>
            <div className="tm-kpi-label">{it.label}</div>
            <div className="tm-kpi-value">{it.value}</div>
            {it.extra && <div className="tm-kpi-extra">{it.extra}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

// ==================== 主线 / 支线 结论条 ====================
const MainlineStrip = ({ analysis }) => {
  if (!analysis?.themes?.length) return null;
  const renderChips = (list, type) => (
    <div className={`tm-line-group tm-line-${type === '主线' ? 'main' : 'branch'}`}>
      <span className="tm-line-label"><FlagOutlined /> {type}</span>
      {list.map((t) => (
        <Tooltip key={t.board} title={`权重 ${t.score} · 今日涨停 ${t.todayCount} 家`}>
          <span className="tm-line-chip">
            {t.board}
            <em>{t.todayCount > 0 ? `${t.todayCount}家` : '--'}</em>
          </span>
        </Tooltip>
      ))}
    </div>
  );
  return (
    <div className="tm-mainline-strip">
      {renderChips(analysis.mainLines || [], '主线')}
      <span className="tm-line-divider" />
      {renderChips(analysis.branches || [], '支线')}
    </div>
  );
};

// ==================== 自选股板块涨跌幅前十（市场情绪下方） ====================
const BlockRankingStrip = ({ blocks }) => {
  if (!blocks) return null;
  const renderGroup = (list, type) => (
    <div className={`tm-blk-group ${type}`}>
      <span className="tm-blk-label">{type === 'up' ? '涨幅前十' : '跌幅前十'}</span>
      {(list || []).map((b, idx) => (
        <Tooltip
          key={`${b.blockName}-${idx}`}
          title={(b.stocks || []).length > 0 ? (
            <div className="tm-blk-tip">
              {b.stocks.map((s) => (
                <div key={s.code} className="tm-blk-tip-row">
                  <span>{s.name}</span>
                  <span className={s.change >= 0 ? 'up' : 'down'}>{formatPct(s.change)}</span>
                </div>
              ))}
            </div>
          ) : '暂无成分股行情'}
        >
          <span className={`tm-blk-chip ${type}`}>
            <em className="tm-blk-idx">{idx + 1}</em>
            {b.blockName}
            <b className={b.avgChange >= 0 ? 'up' : 'down'}>{formatPct(b.avgChange)}</b>
            {!!b.rankChange && (
              <i className={`tm-blk-rank ${b.rankChange > 0 ? 'up' : 'down'}`}>
                {b.rankChange > 0 ? <CaretUpOutlined /> : <CaretDownOutlined />}
                {Math.abs(b.rankChange)}
              </i>
            )}
          </span>
        </Tooltip>
      ))}
    </div>
  );
  return (
    <div className="tm-block-ranking">
      <div className="tm-blk-title"><AppstoreOutlined /> 板块涨跌幅前十</div>
      <div className="tm-blk-groups">
        {renderGroup(blocks.first, 'up')}
        {renderGroup(blocks.last, 'down')}
      </div>
    </div>
  );
};

// ==================== 题材卡片（第一列） ====================
const ThemeCard = ({ theme, quotes, onOpenKline, sortDir, onToggleSort }) => {
  const dragonCodes = useMemo(() => new Set(theme.dragons.map((d) => d.code)), [theme]);

  const restStocks = useMemo(() => {
    const rest = theme.stocks.filter((s) => !dragonCodes.has(s.code));
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rest].sort((a, b) => {
      const ca = quotes[a.marketCode]?.changePct;
      const cb = quotes[b.marketCode]?.changePct;
      const va = Number.isFinite(Number(ca)) ? Number(ca) : -999;
      const vb = Number.isFinite(Number(cb)) ? Number(cb) : -999;
      return (va - vb) * dir;
    });
  }, [theme, quotes, sortDir, dragonCodes]);

  const avgChange = useMemo(() => {
    const vals = theme.stocks
      .map((s) => Number(quotes[s.marketCode]?.changePct))
      .filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [theme, quotes]);

  const DRAGON_NAMES = ['龙一', '龙二', '龙三', '龙四', '龙五'];

  const renderRow = (stock, idx, isDragon) => {
    const q = quotes[stock.marketCode];
    const change = q?.changePct;
    const upCls = change == null ? '' : Number(change) >= 0 ? 'up' : 'down';
    return (
      <div
        key={`${stock.code}-${idx}`}
        className={`tm-stock-row${isDragon ? ' is-dragon' : ''}`}
        data-is-up={Number(change) >= 0 ? 'true' : 'false'}
      >
        <span className={`tm-dragon-badge d${stock.dragonRank || 0}`}>{isDragon ? DRAGON_NAMES[idx] : idx + 1}</span>
        <div className="tm-stock-info" title={stock.concept}>
          <div className="tm-stock-name-row">
            <span className="tm-stock-name" onClick={() => onOpenKline(stock)}>{stock.name}</span>
            {stock.isLeader && <span className="tm-leader-tag">龙头</span>}
          </div>
        </div>
        <div className="tm-lianban-cell" title={`近10日涨停 ${stock.limitUpDays} 次${stock.isLeader ? ' · 题材龙头' : ''}`}>
          {stock.lianbanText || '首板'}
          {stock.limitUpDays > 1 && <em>{stock.limitUpDays}次</em>}
        </div>
        <div className="tm-change-cell">
          <span className={`tm-current-change ${upCls}`}>{formatPct(change)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className={`tm-theme-card ${theme.type === '主线' ? 'main' : 'branch'}`}>
      <div className="tm-theme-header">
        <div className="tm-theme-title-icon"><FireOutlined /></div>
        <div className="tm-theme-title-content">
          <div className="tm-theme-title-row">
            <span className={`tm-theme-rank r${theme.rank}`}>{theme.rank}</span>
            <span className="tm-theme-name">{theme.board}</span>
            <span className={`tm-theme-type ${theme.type === '主线' ? 'main' : 'branch'}`}>{theme.type}</span>
          </div>
          <span className="tm-theme-subtext">WEIGHT {theme.score} · {theme.totalLimitUp} LIMIT-UP · 10D</span>
        </div>
        <div className="tm-theme-extra">
          <span className="tm-theme-today">今日 {theme.todayCount} 家</span>
          <span className={`tm-theme-avg ${avgChange != null && avgChange >= 0 ? 'up' : 'down'}`}>{formatPct(avgChange)}</span>
          <button className="tm-sort-btn" onClick={() => onToggleSort(theme.key)} title="切换剩余个股涨跌排序">
            {sortDir === 'asc' ? <CaretUpOutlined /> : <CaretDownOutlined />}
          </button>
        </div>
      </div>
      <div className="tm-theme-list">
        <div className="tm-list-header">
          <span className="col-dragon">龙头</span>
          <span className="col-name">名称</span>
          <span className="col-lianban">连板</span>
          <span className="col-change">涨幅</span>
        </div>
        <div className="tm-list-body">
          {theme.dragons.map((s, idx) => renderRow(s, idx, true))}
          {restStocks.map((s, idx) => renderRow(s, idx, false))}
          {theme.stocks.length === 0 && <div className="tm-empty-mini">暂无数据</div>}
        </div>
      </div>
    </div>
  );
};

// ==================== 异动监控（第二列第一行） ====================
const MovementPanel = ({ movements, onOpenKline }) => (
  <div className="tm-movement-panel">
    <div className="tm-panel-header">
      <div className="tm-panel-title">
        <ThunderboltOutlined className="tm-panel-icon" />
        <span>异动监控</span>
      </div>
      <span className="tm-panel-sub">个股 ±1% / 板块 ±0.5%</span>
    </div>
    <div className="tm-movement-list">
      {movements.length === 0 ? (
        <div className="tm-empty-mini" style={{ padding: '24px 0' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无异动，等待下一次轮询" />
        </div>
      ) : movements.map((m, idx) => (
        <div key={`${m.time}-${m.code || m.board}-${idx}`} className={`tm-mv-row ${m.delta >= 0 ? 'up' : 'down'}`}>
          <span className="tm-mv-time">{m.time}</span>
          {m.type === 'board' ? (
            <>
              <span className="tm-mv-tag">板块</span>
              <span className="tm-mv-name">{m.board}</span>
            </>
          ) : (
            <>
              <span className="tm-mv-tag stock">个股</span>
              <span className="tm-mv-name" onClick={() => onOpenKline(m)}>{m.name}</span>
            </>
          )}
          <span className="tm-mv-from">{formatPct(m.from)}</span>
          <span className="tm-mv-arrow">→</span>
          <span className="tm-mv-to">{formatPct(m.to)}</span>
          <span className={`tm-mv-delta ${m.delta >= 0 ? 'up' : 'down'}`}>
            {m.delta >= 0 ? <RiseOutlined /> : <FallOutlined />}
            {formatPct(Math.abs(m.delta), { sign: false })}
          </span>
        </div>
      ))}
    </div>
  </div>
);

// ==================== 资金分时图 + 明细 + 成交量（第二列第二行） ====================
const FundChartsPanel = () => {
  const [data, setData] = useState([]);
  const [fiveMinAggEnabled, setFiveMinAggEnabled] = useState(true);

  const fundContainerRef = useRef(null);
  const fundChartRef = useRef(null);
  const volContainerRef = useRef(null);
  const volChartRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_history`);
      setData(response.data || []);
    } catch (err) {
      console.error('Fetch main fund data failed:', err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 10000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const chartData = useMemo(() => (data.length ? aggregateFundByInterval(data, 5) : []), [data]);

  const tableData = useMemo(() => {
    if (!data.length) return [];
    if (fiveMinAggEnabled) return aggregateFundByInterval(data, 5);
    const sorted = [...data].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([timeStr, item]) => ({
      time: timeStr,
      displayTime: formatDisplayTime(timeStr),
      mainMoney: parseMoneyValue(item.mainMoney),
      amountChangeDiff: parseMoneyValue(item.amountChangeDiff),
      rawTime: timeStr,
    }));
  }, [data, fiveMinAggEnabled]);

  const renderCharts = useCallback((chartData) => {
    if (fundChartRef.current) { fundChartRef.current.remove(); fundChartRef.current = null; }
    if (volChartRef.current) { volChartRef.current.remove(); volChartRef.current = null; }
    if (!fundContainerRef.current) return;

    const sortedData = [...chartData].sort((a, b) => (a.rawTime || a.time).localeCompare(b.rawTime || b.time));
    const today = dayjs().format('YYYY-MM-DD');

    const baseOpts = {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#6b7890', fontSize: 9 },
      grid: { vertLines: { color: 'rgba(18, 33, 58, 0.05)' }, horzLines: { color: 'rgba(18, 33, 58, 0.05)' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(18, 33, 58, 0.08)',
        tickMarkFormatter: (time) => dayjs.unix(time).format('HH:mm'),
      },
      localization: { timeFormatter: (time) => dayjs.unix(time).format('HH:mm') },
      rightPriceScale: { borderColor: 'rgba(18, 33, 58, 0.08)', autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
      handleScroll: false,
      handleScale: false,
    };

    // 锁定 X 轴 09:30-15:00 全天坑位
    const allTimePoints = [];
    let curr = dayjs(`${today} 09:30`);
    const amEnd = dayjs(`${today} 11:30`);
    while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }
    curr = dayjs(`${today} 13:00`);
    const pmEnd = dayjs(`${today} 15:00`);
    while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    const fundChart = createChart(fundContainerRef.current, {
      ...baseOpts,
      width: fundContainerRef.current.clientWidth,
      height: fundContainerRef.current.clientHeight,
    });
    fundChartRef.current = fundChart;
    const dummy = fundChart.addLineSeries({ color: 'transparent', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    dummy.setData(allTimePoints.map((t) => ({ time: t, value: 0 })));
    const series = fundChart.addAreaSeries({
      lineColor: '#7c3aed', topColor: 'rgba(124, 58, 237, 0.35)', bottomColor: 'rgba(124, 58, 237, 0.02)',
      lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const fData = sortedData.map((item) => {
      const t = item.rawTime || item.time;
      return { time: dayjs(`${today} ${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`).unix(), value: parseMoneyValue(item.mainMoney) };
    });
    series.setData(fData);
    series.createPriceLine({ price: 0, color: 'rgba(0,0,0,0.25)', lineStyle: LineStyle.Dashed });
    if (fData.length > 0) fundChart.timeScale().fitContent();

    if (volContainerRef.current) {
      const volChart = createChart(volContainerRef.current, {
        ...baseOpts,
        width: volContainerRef.current.clientWidth,
        height: volContainerRef.current.clientHeight,
      });
      volChartRef.current = volChart;
      const volDummy = volChart.addLineSeries({ color: 'transparent', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      volDummy.setData(allTimePoints.map((t) => ({ time: t, value: 0 })));
      const volSeries = volChart.addAreaSeries({
        lineColor: '#1890ff', topColor: 'rgba(24, 144, 255, 0.35)', bottomColor: 'rgba(24, 144, 255, 0.02)',
        lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      const vData = sortedData.map((item) => {
        const t = item.rawTime || item.time;
        return { time: dayjs(`${today} ${t.substring(0, 2)}:${t.substring(2, 4)}:${t.substring(4, 6)}`).unix(), value: parseMoneyValue(item.amountChangeDiff) };
      });
      volSeries.setData(vData);
      if (vData.length > 0) volChart.timeScale().fitContent();
    }
  }, []);

  useEffect(() => {
    renderCharts(chartData);
  }, [chartData, renderCharts]);

  useEffect(() => {
    const handleResize = () => {
      if (fundChartRef.current && fundContainerRef.current) {
        fundChartRef.current.applyOptions({ width: fundContainerRef.current.clientWidth });
      }
      if (volChartRef.current && volContainerRef.current) {
        volChartRef.current.applyOptions({ width: volContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const latest = chartData.length ? chartData[chartData.length - 1] : null;

  const renderTable = () => {
    if (!tableData.length) return <div className="tm-empty-mini">暂无资金数据</div>;
    const sorted = [...tableData].sort((a, b) => (b.rawTime || b.time).localeCompare(a.rawTime || a.time));
    return sorted.map((item, index) => {
      const timeStr = item.rawTime || item.time;
      const mainMoney = parseMoneyValue(item.mainMoney);
      const prevItem = index + 1 < sorted.length ? sorted[index + 1] : null;
      const diff = prevItem ? mainMoney - parseMoneyValue(prevItem.mainMoney) : 0;
      if (!fiveMinAggEnabled && diff === 0) return null;
      const dt = item.displayTime || formatDisplayTime(timeStr);
      const bigOut = diff <= -4;
      const bigIn = diff >= 4;
      return (
        <div key={timeStr} className={`tm-fund-item ${mainMoney >= 0 ? 'up' : 'down'}${bigOut ? ' big-outflow' : ''}${bigIn ? ' big-inflow' : ''}`}>
          <span className="item-time">{dt}</span>
          <span className={`item-value ${mainMoney >= 0 ? 'up' : 'down'}`}>
            {mainMoney >= 0 ? '+' : ''}{mainMoney.toFixed(2)}
            {diff !== 0 && (
              <span className={`item-diff ${diff >= 0 ? 'up' : 'down'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(2)}</span>
            )}
          </span>
        </div>
      );
    });
  };

  return (
    <div className="tm-fund-panel">
      <div className="tm-fund-row1">
        <div className="tm-fund-chart-card">
          <div className="tm-fund-chart-header">
            <span className="tm-fund-chart-title"><AreaChartOutlined /> 主力资金</span>
            <span className="tm-fund-chart-value" style={{ color: '#7c3aed' }}>
              {latest ? `${latest.mainMoney >= 0 ? '+' : ''}${Number(latest.mainMoney).toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="tm-fund-chart-body" ref={fundContainerRef} />
        </div>
        <div className="tm-fund-detail">
          <div className="tm-fund-detail-header">
            <span className="tm-fund-detail-title">资金明细</span>
            <label className="tm-fund-switch">
              <AntSwitch size="small" checked={fiveMinAggEnabled} onChange={setFiveMinAggEnabled} />
              <span>5min</span>
            </label>
          </div>
          <div className="tm-fund-table">{renderTable()}</div>
        </div>
      </div>
      <div className="tm-fund-row2">
        <div className="tm-fund-chart-card">
          <div className="tm-fund-chart-header">
            <span className="tm-fund-chart-title"><PieChartOutlined /> 成交量</span>
            <span className="tm-fund-chart-value" style={{ color: '#1890ff' }}>
              {latest ? `${latest.amountChangeDiff >= 0 ? '+' : ''}${Number(latest.amountChangeDiff).toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="tm-fund-chart-body" ref={volContainerRef} />
        </div>
      </div>
    </div>
  );
};

// ==================== 主页面 ====================
const ThemeMonitor = () => {
  const [overview, setOverview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [movements, setMovements] = useState([]);
  const [sortDirs, setSortDirs] = useState({});
  const [klineStock, setKlineStock] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);
  const [blocks, setBlocks] = useState(null);
  const [loading, setLoading] = useState(true);

  const prevQuotesRef = useRef({});
  const prevSectorRef = useRef({});
  const pollingRef = useRef(false);
  const analysisRef = useRef(null);
  useEffect(() => { analysisRef.current = analysis; }, [analysis]);

  const handleToggleSort = useCallback((key) => {
    setSortDirs((prev) => ({ ...prev, [key]: prev[key] === 'asc' ? 'desc' : 'asc' }));
  }, []);

  const openKline = useCallback((stock) => {
    if (!stock?.marketCode) return;
    setKlineStock(stock);
    setKlineVisible(true);
  }, []);

  // 异动检测：个股相较上次请求涨幅波动 |Δ|>1%，板块（个股平均涨幅）|Δ|>0.5%
  const detectMovements = useCallback((newQuotes, analysisData) => {
    const now = dayjs().format('HH:mm:ss');
    const events = [];
    const topThemes = (analysisData?.themes || []).slice(0, TOP_THEME_COUNT);
    const nextSector = {};

    topThemes.forEach((theme) => {
      const vals = theme.stocks
        .map((s) => Number(newQuotes[s.marketCode]?.changePct))
        .filter((v) => Number.isFinite(v));
      if (vals.length === 0) return;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      nextSector[theme.key] = avg;
      const prevAvg = prevSectorRef.current[theme.key];
      if (Number.isFinite(prevAvg) && Math.abs(avg - prevAvg) > 0.5) {
        events.push({
          type: 'board', board: theme.board, code: `board_${theme.key}`,
          from: prevAvg, to: avg, delta: avg - prevAvg, time: now,
        });
      }
      theme.stocks.forEach((s) => {
        const cur = Number(newQuotes[s.marketCode]?.changePct);
        const prev = Number(prevQuotesRef.current[s.marketCode]?.changePct);
        if (!Number.isFinite(cur) || !Number.isFinite(prev)) return;
        if (Math.abs(cur - prev) > 1) {
          events.push({
            type: 'stock', name: s.name, code: s.marketCode, marketCode: s.marketCode, board: theme.board,
            from: prev, to: cur, delta: cur - prev, time: now,
          });
        }
      });
    });

    prevQuotesRef.current = newQuotes;
    prevSectorRef.current = nextSector;

    if (events.length > 0) {
      // 板块异动在前，个股在后；各自按波动幅度降序
      events.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'board' ? -1 : 1;
        return Math.abs(b.delta) - Math.abs(a.delta);
      });
      setMovements((prev) => [...events, ...prev].slice(0, 120));
    }
  }, []);

  // 每 10s 轮询：概览 + 分析 + 批量行情
  useEffect(() => {
    const poll = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const [overviewRes, analysisRes, blocksRes] = await Promise.all([
          axios.get(`http://${local_ip}:3000/theme_monitor_overview`),
          axios.get(`http://${local_ip}:3000/theme_monitor_analysis`),
          axios.get(`http://${local_ip}:3000/theme_monitor_blocks`).catch(() => null),
        ]);
        const analysisData = analysisRes.data || null;
        setOverview(overviewRes.data || null);
        setAnalysis(analysisData);
        if (blocksRes?.data) setBlocks(blocksRes.data);

        const codes = (analysisData?.themes || [])
          .slice(0, TOP_THEME_COUNT)
          .flatMap((t) => t.stocks.map((s) => s.marketCode))
          .filter(Boolean);
        if (codes.length > 0) {
          const quotesRes = await axios.get(`http://${local_ip}:3000/theme_monitor_quotes`, {
            params: { codes: codes.join(',') },
          });
          const newQuotes = quotesRes.data || {};
          setQuotes(newQuotes);
          detectMovements(newQuotes, analysisData);
        }
      } catch (err) {
        console.error('题材盯盘轮询失败:', err);
      } finally {
        pollingRef.current = false;
        setLoading(false);
      }
    };

    poll();
    const timer = setInterval(poll, 10000);
    return () => clearInterval(timer);
  }, [detectMovements]);

  const topThemes = useMemo(() => (analysis?.themes || []).slice(0, TOP_THEME_COUNT), [analysis]);

  return (
    <div className="theme-monitor-container">
      <OverviewBar overview={overview} />
      <BlockRankingStrip blocks={blocks} />
      <MainlineStrip analysis={analysis} />

      {loading && !analysis ? (
        <div className="tm-loading"><Spin size="large" /></div>
      ) : (
        <div className="tm-body">
          <div className="tm-left">
            <div className="tm-cards-grid">
              {topThemes.map((theme) => (
                <ThemeCard
                  key={theme.key}
                  theme={theme}
                  quotes={quotes}
                  onOpenKline={openKline}
                  sortDir={sortDirs[theme.key] || 'desc'}
                  onToggleSort={handleToggleSort}
                />
              ))}
              {topThemes.length === 0 && (
                <div className="tm-empty-mini" style={{ gridColumn: '1 / -1' }}>暂无题材数据（需先抓取连板快照）</div>
              )}
            </div>
          </div>
          <div className="tm-right">
            <MovementPanel movements={movements} onOpenKline={openKline} />
            <FundChartsPanel />
          </div>
        </div>
      )}

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        code={klineStock?.marketCode}
        stockInfo={{ name: klineStock?.name, change: quotes[klineStock?.marketCode]?.changePct }}
      />
    </div>
  );
};

export default ThemeMonitor;
