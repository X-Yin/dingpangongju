import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Spin, Tooltip, message } from 'antd';
import { ReloadOutlined, RiseOutlined, LineChartOutlined, ThunderboltOutlined, FundOutlined } from '@ant-design/icons';
import axios from 'axios';
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import './SiweiLiti.scss';

const API_BASE = `http://${local_ip}:3000`;

const PHASE_SCORE = {
  高潮期: 4,
  一致期: 3,
  分歧期: 2,
  弱势震荡: 1,
  退潮期: 0,
};
const PHASE_NAMES = ['退潮期', '弱势震荡', '分歧期', '一致期', '高潮期'];
const PHASE_COLOR = {
  高潮期: '#f43f5e',
  一致期: '#f59e0b',
  分歧期: '#38bdf8',
  弱势震荡: '#94a3b8',
  退潮期: '#22c55e',
  修复期: '#a3e635',
  冰点期: '#64748b',
};
// 板块情绪周期多选时的曲线配色（按题材在标签列表中的顺序取色，保证颜色稳定）
const LINE_COLORS = [
  '#c4b5fd', '#67e8f9', '#fda4af', '#fde68a', '#86efac', '#f0abfc',
  '#93c5fd', '#fdba74', '#bef264', '#f9a8d4', '#7dd3fc', '#fca5a5',
];

const formatYmd = (ymd) => {
  const str = String(ymd || '');
  if (str.length !== 8) return '--';
  return `${str.slice(4, 6)}/${str.slice(6, 8)}`;
};

const fmtPct = (v, digits = 2) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
  const num = Number(v);
  return `${num > 0 ? '+' : ''}${num.toFixed(digits)}%`;
};

const fmtScore = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(1));

const ZERO_LINE = { value: 0 };
const FIFTY_LINE = { value: 50 };
const BASE_PRICE_FORMAT = { type: 'price', precision: 1, minMove: 0.1 };
const INT_FORMATTER = (p) => `${Number(p).toFixed(0)}`;
const PHASE_FORMATTER = (p) => PHASE_NAMES[Math.round(Number(p))] || '';
const PHASE_PRICE_FORMAT = { type: 'custom', formatter: PHASE_FORMATTER, minMove: 1 };

// 折线数据：{ date: YYYYMMDD, value } -> lightweight-charts time
const toChartData = (list) => (list || [])
  .filter((item) => item && item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value)))
  .map((item) => ({
    time: `${String(item.date).slice(0, 4)}-${String(item.date).slice(4, 6)}-${String(item.date).slice(6, 8)}`,
    value: Number(item.value),
  }));

// 迷你折线图（lightweight-charts）：透明底 + 白色文字，适配渐变卡
// series 单线；lines 多线（板块情绪周期多选时每条题材一条线）；统一带十字光标 tooltip
const MiniLineChart = ({ series, lines, height = 170, color = '#67e8f9', priceFormat, priceFormatter, extraLine }) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [tip, setTip] = useState(null);

  useEffect(() => {
    const el = canvasRef.current;
    const wrap = containerRef.current;
    if (!el || !wrap) return undefined;

    el.innerHTML = '';
    const chart = createChart(el, {
      width: wrap.clientWidth || 320,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.82)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.08)' },
        horzLines: { color: 'rgba(255,255,255,0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.45)', style: LineStyle.Dashed, labelBackgroundColor: '#334155' },
        horzLine: { color: 'rgba(255,255,255,0.45)', style: LineStyle.Dashed, labelBackgroundColor: '#334155' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.18)',
        scaleMargins: { top: 0.16, bottom: 0.12 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.18)',
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time) => {
          const s = typeof time === 'string'
            ? time
            : (time && time.year
              ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
              : '');
          // 横轴统一显示「月/日」
          return s.length >= 10 ? `${s.slice(5, 7)}/${s.slice(8, 10)}` : s;
        },
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: priceFormatter || ((p) => (Number.isFinite(Number(p)) ? Number(p).toFixed(1) : '--')),
        // 十字光标日期标签显示完整年月日
        timeFormatter: (time) => {
          if (typeof time === 'string') return time;
          if (time && time.year) {
            return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
          }
          return '';
        },
      },
    });

    const metas = [];
    const pushMeta = (name, lineColor, data) => metas.push({
      name,
      color: lineColor,
      formatter: priceFormatter,
      times: data.map((d) => String(d.time)),
      values: new Map(data.map((d) => [String(d.time), d.value])),
    });

    const hasMultiLines = Array.isArray(lines) && lines.length > 0;
    if (hasMultiLines) {
      lines.forEach((ln) => {
        const multiSeries = chart.addLineSeries({
          color: ln.color,
          lineWidth: 2,
          title: ln.name,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          priceFormat: priceFormat || BASE_PRICE_FORMAT,
        });
        const data = toChartData(ln.series);
        multiSeries.setData(data);
        pushMeta(ln.name, ln.color, data);
      });
    } else {
      const line = chart.addLineSeries({
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        priceFormat: priceFormat || BASE_PRICE_FORMAT,
      });
      const data = toChartData(series);
      line.setData(data);
      pushMeta('', color, data);

      if (extraLine && extraLine.value !== undefined && Number.isFinite(Number(extraLine.value))) {
        line.createPriceLine({
          price: Number(extraLine.value),
          color: 'rgba(255,255,255,0.4)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: '',
        });
      }
    }

    const timeKeyOf = (time) => {
      if (typeof time === 'string') return time;
      if (time && time.year) {
        return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
      }
      return null;
    };

    const buildRows = (timeKey) => metas
      .map((m) => {
        const v = m.values.get(timeKey);
        if (v === undefined || v === null || !Number.isFinite(Number(v))) return null;
        return {
          name: m.name,
          color: m.color,
          text: m.formatter ? m.formatter(v) : Number(v).toFixed(1),
        };
      })
      .filter(Boolean);

    const showTip = (timeKey, x, y) => {
      if (!timeKey) {
        setTip(null);
        return;
      }
      const rows = buildRows(timeKey);
      if (!rows.length) {
        setTip(null);
        return;
      }
      setTip({ x, y, date: timeKey, rows });
    };

    // 十字光标事件（库内实现）
    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        setTip(null);
        return;
      }
      showTip(timeKeyOf(param.time), param.point.x, param.point.y);
    });

    // 原生 mousemove 兜底：按横坐标取最近的交易日，保证 tooltip 一定可用
    const onMouseMove = (ev) => {
      const rect = wrap.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        setTip(null);
        return;
      }
      const baseTimes = metas[0]?.times || [];
      if (!baseTimes.length) return;
      const logical = chart.timeScale().coordinateToLogical(x);
      if (logical === null || logical === undefined || !Number.isFinite(Number(logical))) return;
      const idx = Math.min(baseTimes.length - 1, Math.max(0, Math.round(Number(logical))));
      showTip(baseTimes[idx], x, y);
    };
    const onMouseLeave = () => setTip(null);
    wrap.addEventListener('mousemove', onMouseMove);
    wrap.addEventListener('mouseleave', onMouseLeave);

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (wrap) chart.applyOptions({ width: wrap.clientWidth || 320 });
    });
    ro.observe(wrap);

    return () => {
      ro.disconnect();
      wrap.removeEventListener('mousemove', onMouseMove);
      wrap.removeEventListener('mouseleave', onMouseLeave);
      chart.remove();
    };
  }, [series, lines, color, height, priceFormat, priceFormatter, extraLine]);

  const wrapWidth = containerRef.current?.clientWidth || 360;
  const tipLeft = tip ? (tip.x > wrapWidth - 200 ? Math.max(6, wrapWidth - 200) : tip.x + 14) : 0;
  const tipTop = tip ? Math.max(4, tip.y - 14) : 0;

  return (
    <div className="sl-chart" ref={containerRef}>
      <div className="sl-chart-canvas" ref={canvasRef} />
      {tip && (
        <div className="sl-chart-tooltip" style={{ left: tipLeft, top: tipTop }}>
          <div className="sl-tip-date">{tip.date}</div>
          {tip.rows.map((r, idx) => (
            <div className="sl-tip-row" key={`${r.name || 'value'}-${idx}`}>
              <i style={{ background: r.color }} />
              {r.name ? <span className="sl-tip-name">{r.name}</span> : null}
              <span className="sl-tip-value">{r.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// 单个题材（主线/支线）卡片：龙头 / 中军 / 龙二~龙五
const ThemeCard = ({ theme, onOpenStock }) => {
  const isMain = theme.type === '主线';
  return (
    <div className={`sl-theme-card ${isMain ? 'is-main' : 'is-branch'}`}>
      <div className="sl-theme-head">
        <div className="sl-theme-title">
          <span className="sl-theme-name">{theme.board}</span>
          <span className={`sl-type-badge ${isMain ? 'main' : 'branch'}`}>{theme.type}</span>
          {theme.category && (
            <Tooltip title={`题材涨停股与「${theme.category}」板块成分股交集 ${theme.categoryIntersection} 只（覆盖 ${theme.categoryRatio}%），成交量占比取该板块口径`}>
              <span className="sl-map-badge">→ {theme.category}</span>
            </Tooltip>
          )}
        </div>
        <div className="sl-theme-meta">
          <span>今日涨停 <b>{theme.latestCount}</b></span>
          <span>10日合计 <b>{theme.totalCount}</b></span>
          <span>最高 <b>{theme.maxLianban}板</b></span>
          <span className={Number(theme.countTrend) > 0 ? 'sl-up' : 'sl-down'}>
            涨停趋势 {fmtPct(theme.countTrend, 1)}
          </span>
          <span className={Number(theme.ratioTrend) > 0 ? 'sl-up' : 'sl-down'}>
            量比趋势 {fmtPct(theme.ratioTrend, 1)}
          </span>
          {theme.currentPhase && (
            <span className="sl-phase-chip" style={{ '--phase-color': PHASE_COLOR[theme.currentPhase] }}>
              {theme.currentPhase}
            </span>
          )}
        </div>
      </div>

      <div className={`sl-stock-head ${isMain ? 'main' : ''}`}>
        <span>#</span>
        <span>股票</span>
        <span>连板</span>
        <span>区间涨幅</span>
        <span>评分</span>
      </div>
      {(theme.stocks || []).map((s, idx) => (
        <div
          className="sl-stock-row"
          key={`${theme.key}-${s.code}-${idx}`}
          onClick={() => onOpenStock(s)}
          title="点击查看 K 线"
        >
          <span className={`sl-rank ${idx === 0 ? 'rank-1' : idx < 3 ? 'rank-top' : ''}`}>{idx + 1}</span>
          <span className="sl-stock-name-cell">
            <span className="sl-stock-name">{s.name}</span>
            {s.tags?.includes('龙头') && <span className="sl-tag dragon">龙头</span>}
            {s.tags?.includes('龙二') && <span className="sl-tag dragon">龙二</span>}
            {s.tags?.includes('龙三') && <span className="sl-tag dragon">龙三</span>}
            {s.tags?.includes('龙四') && <span className="sl-tag dragon">龙四</span>}
            {s.tags?.includes('龙五') && <span className="sl-tag dragon">龙五</span>}
            {s.tags?.includes('中军') && <span className="sl-tag mid">中军</span>}
          </span>
          <span className="sl-mono">{s.maxLianban > 1 ? `${s.maxLianban}板` : '首板'}</span>
          <span className={`sl-mono ${Number(s.gainPct) >= 0 ? 'sl-up' : 'sl-down'}`}>{fmtPct(s.gainPct)}</span>
          <span className="sl-mono sl-score">{fmtScore(s.score)}</span>
        </div>
      ))}
      {(!theme.stocks || theme.stocks.length === 0) && (
        <div className="sl-empty-row">暂无个股数据</div>
      )}
      <div className="sl-theme-foot">
        题材池 {theme.stockPoolCount} 只，按「连板 60% + 30日区间涨幅 40%」取前 10（保证含中军）
      </div>
    </div>
  );
};

const SiweiLiti = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedThemeKeys, setSelectedThemeKeys] = useState([]);
  const [showAllBranches, setShowAllBranches] = useState(false);
  const [klineTarget, setKlineTarget] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);

  const fetchData = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true); else setLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/siwei_liti_analysis`);
      setData(res.data || null);
      setError('');
      if (manual) message.success('四维立体数据已刷新');
    } catch (e) {
      console.error('获取四维立体数据失败:', e);
      setError(e?.response?.data?.message || e.message || '获取失败');
      if (manual) message.error('刷新失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const themes = data?.themes || [];
  const mainThemes = useMemo(() => themes.filter((t) => t.type === '主线'), [themes]);
  const branchThemes = useMemo(() => themes.filter((t) => t.type === '支线'), [themes]);

  // 默认选中主线第一个，其次第一个支线；数据刷新后剔除已不存在的题材
  useEffect(() => {
    if (!themes.length) return;
    setSelectedThemeKeys((prev) => {
      const valid = prev.filter((k) => themes.some((t) => t.key === k));
      if (valid.length) return valid.length === prev.length ? prev : valid;
      const def = mainThemes[0] || branchThemes[0];
      return def ? [def.key] : [];
    });
  }, [themes, mainThemes, branchThemes]);

  // 情绪图可选题材：主线全部 + 前 10 个支线（已选中的题材一定在列表内）
  const chipThemes = useMemo(() => {
    const list = [...mainThemes, ...branchThemes.slice(0, 10)];
    selectedThemeKeys.forEach((k) => {
      if (!list.some((t) => t.key === k)) {
        const sel = themes.find((t) => t.key === k);
        if (sel) list.push(sel);
      }
    });
    return list;
  }, [mainThemes, branchThemes, themes, selectedThemeKeys]);

  // 题材 -> 曲线颜色（按标签列表顺序，切换选中不影响其他题材颜色）
  const themeColorOf = useMemo(() => {
    const map = new Map();
    chipThemes.forEach((t, idx) => map.set(t.key, LINE_COLORS[idx % LINE_COLORS.length]));
    return map;
  }, [chipThemes]);

  // 已选题材（按标签列表顺序）
  const selectedThemes = useMemo(
    () => chipThemes.filter((t) => selectedThemeKeys.includes(t.key)),
    [chipThemes, selectedThemeKeys],
  );

  // 每个已选题材一条折线
  const sectorLines = useMemo(() => selectedThemes.map((t) => ({
    key: t.key,
    name: t.board,
    color: themeColorOf.get(t.key),
    series: (t.emotionCycle || []).map((item) => ({
      date: item.date,
      value: PHASE_SCORE[item.phase] ?? null,
    })),
  })), [selectedThemes, themeColorOf]);

  // 标签多选：已选则取消，未选则加入
  const toggleThemeKey = (key) => {
    setSelectedThemeKeys((prev) => (
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    ));
  };

  const marketSeries = useMemo(() => (data?.marketTemperature || []).map((item) => ({ ...item })), [data]);

  const visibleBranches = showAllBranches ? branchThemes : branchThemes.slice(0, 6);

  const openStock = (stock) => {
    setKlineTarget(stock);
    setKlineVisible(true);
  };

  const fastRotation = data?.marketStatus?.isFastRotation;

  return (
    <div className="siwei-liti-page">
      {/* 顶部主卡（与「科技进攻股票涨幅列表」同一渐变磨砂风格） */}
      <div className="sl-hero">
        <div className="sl-hero-header">
          <div className="sl-hero-title">
            <span className="sl-hero-icon"><ThunderboltOutlined /></span>
            <span>四维立体 · 主线与情绪周期</span>
          </div>
          <div className="sl-hero-actions">
            <span className="sl-total-tag">
              主线 {mainThemes.length} · 支线 {branchThemes.length}
            </span>
            <button
              className="sl-refresh-btn"
              onClick={() => fetchData(true)}
              disabled={refreshing}
              title="刷新四维立体数据"
            >
              <ReloadOutlined spin={refreshing} />
            </button>
          </div>
        </div>

        <div className={`sl-status-note ${fastRotation ? 'rotation' : 'main'}`}>
          {data?.marketStatus?.description || '正在计算最近 10 个交易日的主线与支线…'}
          {data?.latestSnapshotDate && (
            <span className="sl-status-sub">数据截至 {String(data.latestSnapshotDate).slice(0, 4)}-{String(data.latestSnapshotDate).slice(4, 6)}-{String(data.latestSnapshotDate).slice(6, 8)}</span>
          )}
        </div>

        <div className="sl-summary-grid">
          <div className="sl-summary-item">
            <span className="sl-summary-label">市场状态</span>
            <span className={`sl-summary-value ${fastRotation ? 'rotation' : ''}`}>
              {fastRotation ? '快速轮动' : (mainThemes.length ? '主线明确' : '--')}
            </span>
          </div>
          <div className="sl-summary-item">
            <span className="sl-summary-label">主线题材</span>
            <span className="sl-summary-value small">
              {mainThemes.length ? mainThemes.map((t) => t.board).join('、') : '无（全部为支线）'}
            </span>
          </div>
          <div className="sl-summary-item">
            <span className="sl-summary-label">最新情绪温度</span>
            <span className="sl-summary-value">
              {data?.marketTemperature?.length
                ? `${data.marketTemperature[data.marketTemperature.length - 1]?.value ?? '--'}（${data.marketTemperature[data.marketTemperature.length - 1]?.phase || '--'}）`
                : '--'}
            </span>
          </div>
          <div className="sl-summary-item">
            <span className="sl-summary-label">科技情绪指数</span>
            <span className={`sl-summary-value ${Number(data?.techEmotion?.[data.techEmotion.length - 1]?.value) >= 0 ? 'sl-up' : 'sl-down'}`}>
              {data?.techEmotion?.length ? Number(data.techEmotion[data.techEmotion.length - 1]?.value).toFixed(2) : '--'}
            </span>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="sl-loading"><Spin size="large" /></div>
      ) : error && !data ? (
        <div className="sl-error">
          <Empty description={error} />
        </div>
      ) : (
        <>
          {/* 情绪周期：科技 / 大盘 / 板块 */}
          <div className="sl-section-title">
            <LineChartOutlined /> 情绪周期
          </div>

          <div className="sl-chart-grid">
            <div className="sl-glass-card sl-chart-card">
              <div className="sl-chart-card-head">
                <span className="sl-chart-title">科技情绪指数</span>
                <span className="sl-chart-sub">现成科技情绪口径（-100 ~ 100）</span>
              </div>
              <MiniLineChart
                series={data?.techEmotion || []}
                color="#67e8f9"
                extraLine={ZERO_LINE}
                priceFormatter={INT_FORMATTER}
              />
            </div>

            <div className="sl-glass-card sl-chart-card">
              <div className="sl-chart-card-head">
                <span className="sl-chart-title">大盘情绪周期</span>
                <span className="sl-chart-sub">连板快照情绪温度（0 ~ 100）</span>
              </div>
              <MiniLineChart
                series={marketSeries}
                color="#fda4af"
                extraLine={FIFTY_LINE}
                priceFormatter={INT_FORMATTER}
              />
              <div className="sl-mini-phase-row">
                {(data?.marketTemperature || []).map((item) => (
                  <Tooltip key={item.date} title={`${formatYmd(item.date)} 情绪温度 ${item.value ?? '--'}（${item.phase || '--'}），涨停 ${item.limitUp ?? '--'} 家`}>
                    <span className="sl-mini-phase-dot" style={{ '--phase-color': PHASE_COLOR[item.phase] || '#94a3b8' }} />
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>

          <div className="sl-glass-card sl-chart-card sl-sector-card">
            <div className="sl-chart-card-head sl-sector-head">
              <div>
                <span className="sl-chart-title">板块情绪周期</span>
                <span className="sl-chart-sub">
                  涨停家数变化 × 板块成交量占比变化（高潮 / 一致 / 分歧 / 弱势震荡 / 退潮）
                </span>
              </div>
              <div className="sl-theme-chips">
                {chipThemes.map((t) => {
                  const active = selectedThemeKeys.includes(t.key);
                  return (
                    <button
                      key={t.key}
                      className={`sl-theme-chip ${active ? 'active' : ''} ${t.type === '主线' ? 'main' : ''}`}
                      onClick={() => toggleThemeKey(t.key)}
                      title={active ? `取消 ${t.board}` : `添加 ${t.board} 曲线`}
                    >
                      {active && <i className="sl-chip-dot" style={{ background: themeColorOf.get(t.key) }} />}
                      {t.board}
                      {t.type === '主线' && <span className="sl-chip-star">主线</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedThemes.length ? (
              <>
                <MiniLineChart
                  lines={sectorLines}
                  height={190}
                  priceFormat={PHASE_PRICE_FORMAT}
                  priceFormatter={PHASE_FORMATTER}
                />
                <div className="sl-selected-legend">
                  {selectedThemes.map((t) => (
                    <span key={t.key} className="sl-legend-item sl-legend-clickable" onClick={() => toggleThemeKey(t.key)}>
                      <i style={{ background: themeColorOf.get(t.key) }} />{t.board}
                    </span>
                  ))}
                </div>
                <div className="sl-phase-strip sl-phase-strip-multi">
                  {selectedThemes.map((t) => (
                    <div className="sl-phase-row" key={t.key}>
                      <span
                        className="sl-phase-theme"
                        style={{ '--line-color': themeColorOf.get(t.key) }}
                        title={t.board}
                      >{t.board}</span>
                      <div className="sl-phase-cells">
                        {(t.emotionCycle || []).map((item) => (
                          <Tooltip key={`${t.key}-${item.date}`} title={`${t.board}｜${item.reason}`}>
                            <div className="sl-phase-cell" style={{ '--phase-color': PHASE_COLOR[item.phase] }}>
                              <span className="sl-phase-date">{formatYmd(item.date)}</span>
                              <span className="sl-phase-name">{item.phase}</span>
                              <span className="sl-phase-detail">涨停 {item.count} · 占比 {item.ratio != null ? `${item.ratio}%` : '--'}</span>
                            </div>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="sl-phase-legend">
                  {Object.entries(PHASE_COLOR).reverse().map(([name, color]) => (
                    <span key={name} className="sl-legend-item">
                      <i style={{ background: color }} />{name}
                    </span>
                  ))}
                  <span className="sl-legend-note">
                    规则：家数增加+占比提升=高潮；增加+占比降低=一致；减少(&lt;30%)+占比提升=分歧；减少+占比降低=弱势震荡；家数≤5=退潮（减少≥30%且占比提升仍按高潮计）。上方标签支持多选，再次点击取消。
                  </span>
                </div>
              </>
            ) : (
              <Empty description="点击上方题材标签添加曲线，再次点击取消" />
            )}
          </div>

          {/* 主线 */}
          <div className="sl-section-title">
            <RiseOutlined /> 主线 {mainThemes.length ? `（${mainThemes.length}）` : ''}
            {fastRotation && <span className="sl-fast-rotation">当前无主线，市场快速轮动</span>}
          </div>
          {mainThemes.length ? (
            <div className="sl-theme-grid">
              {mainThemes.map((t) => (
                <ThemeCard key={t.key} theme={t} onOpenStock={openStock} />
              ))}
            </div>
          ) : (
            <div className="sl-empty-block">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="最近 10 个交易日没有同时满足「涨停家数增加 + 板块成交量占比提升」的题材，全部题材按支线处理（快速轮动）"
              />
            </div>
          )}

          {/* 支线 */}
          <div className="sl-section-title">
            <FundOutlined /> 支线（{branchThemes.length}）
          </div>
          <div className="sl-theme-grid">
            {visibleBranches.map((t) => (
              <ThemeCard key={t.key} theme={t} onOpenStock={openStock} />
            ))}
          </div>
          {branchThemes.length > 6 && (
            <div className="sl-more-row">
              <button className="sl-more-btn" onClick={() => setShowAllBranches((v) => !v)}>
                {showAllBranches ? '收起支线' : `展开全部支线（${branchThemes.length - 6}）`}
              </button>
            </div>
          )}
        </>
      )}

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        code={klineTarget?.marketCode || klineTarget?.code}
        stockInfo={{ name: klineTarget?.name, code: klineTarget?.code, change: klineTarget?.gainPct }}
      />
    </div>
  );
};

export default SiweiLiti;
