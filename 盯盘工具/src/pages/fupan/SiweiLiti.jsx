import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Spin, Tooltip, message, Select } from 'antd';
import { ReloadOutlined, LineChartOutlined, ThunderboltOutlined, FundOutlined, BarChartOutlined, SwapOutlined, FileTextOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import './SiweiLiti.scss';

const API_BASE = `http://${local_ip}:3000`;

const PHASE_SCORE = {
  一致加速: 4,
  全面高潮: 3,
  爆量分歧: 2,
  弱势震荡: 1,
  退潮: 0,
};
const PHASE_NAMES = ['退潮', '弱势震荡', '爆量分歧', '全面高潮', '一致加速'];
// 板块情绪周期（新口径）配色
const SECTOR_PHASE_COLOR = {
  全面高潮: '#f43f5e',
  一致加速: '#f59e0b',
  爆量分歧: '#38bdf8',
  弱势震荡: '#94a3b8',
  退潮: '#22c55e',
};
// 大盘情绪周期（快照口径）配色
const PHASE_COLOR = {
  高潮期: '#f43f5e',
  一致期: '#f59e0b',
  分歧期: '#38bdf8',
  弱势震荡: '#94a3b8',
  退潮期: '#22c55e',
  修复期: '#a3e635',
  冰点期: '#64748b',
};
// 板块情绪周期多选时的曲线配色：红橙黄绿蓝靛紫，按题材顺序循环使用
const LINE_COLORS = [
  '#f87171', // 红
  '#fb923c', // 橙
  '#facc15', // 黄
  '#4ade80', // 绿
  '#60a5fa', // 蓝
  '#818cf8', // 靛
  '#c084fc', // 紫
];

// 周期分析 txt 末尾附带的提示词
const CYCLE_ANALYSIS_PROMPT = [
  '主线和支线的定义：主线是跟大盘情绪周期共振启动爆发的板块，在大盘情绪高涨的当日，该板块达到了全面高潮 or 一致加速，主线跟大盘是高度共振的。而支线则跟大盘的节奏不同步，往往早于大盘的爆发节点，或者是晚于大盘的爆发节点，支线往往会在主线板块分歧的时候，突然拉升站出来抢夺主线资金的流动性，属于搅屎棍类型，支线板块来得快去得也快。另外主线还有一个要求就是在和大盘共振爆发当日的次日，不能直接退潮，否则也是支线，这种是资金趁着大盘当日情绪好而做的一日游强套利。',
  '两个买点：这里只围绕主线做，不做支线。主线有两个买点，第一个买点在爆发的首日，第二个买点在第一次分歧退潮的时候做低吸。',
  '分析几个问题，第一个问题谁是主线，谁是支线。第二个问题，主线和支线的节奏问题，下一次出手应该大概在什么时间、买哪个板块。',
].join('\n');

const formatYmd = (ymd) => {
  const str = String(ymd || '');
  if (str.length !== 8) return '--';
  return `${str.slice(4, 6)}/${str.slice(6, 8)}`;
};

// 完整年月日（用于 txt 导出）
const formatDateFull = (ymd) => {
  const s = String(ymd || '');
  if (s.length !== 8) return String(ymd || '--');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
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
const SECTOR_PRICE_FORMAT = { type: 'price', precision: 2, minMove: 0.01 };

// 折线数据：{ date: YYYYMMDD, value } -> lightweight-charts time
const toChartData = (list) => (list || [])
  .filter((item) => item && item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value)))
  .map((item) => ({
    time: `${String(item.date).slice(0, 4)}-${String(item.date).slice(4, 6)}-${String(item.date).slice(6, 8)}`,
    value: Number(item.value),
  }));

// 迷你折线图（lightweight-charts）：透明底 + 白色文字，适配渐变卡
// series 单线；lines 多线（板块情绪周期多选时每条题材一条线）；统一带十字光标 tooltip
// fixedRange: 固定价格轴范围（如 { min: 0, max: 4 }），避免数据不满轴时刻度标签缺失
const MiniLineChart = ({ series, lines, height = 170, color = '#67e8f9', priceFormat, priceFormatter, extraLine, fixedRange, hotDates, sideTooltip }) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [tip, setTip] = useState(null);

  // 数据不足时仍按固定范围自动缩放，保证坐标轴刻度完整
  const autoscaleInfoProvider = fixedRange
    ? () => ({ priceRange: { minValue: fixedRange.min, maxValue: fixedRange.max } })
    : undefined;

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
      // 禁止鼠标滚轮缩放/滚动图表，滚轮只用于页面或弹窗滚动
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: false,
        pinch: false,
        axisPressedMouseMove: true,
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

    // 大盘情绪 ≥ 60 的日期打点（hotDates 为 YYYY-MM-DD → 温度值 的 Map），文字标注「大盘 xx°」
    const buildMarkers = (chartData) => {
      if (!hotDates || !hotDates.size) return [];
      return chartData
        .filter((d) => hotDates.has(String(d.time)))
        .map((d) => ({
          time: d.time,
          position: 'aboveBar',
          color: '#fbbf24',
          shape: 'circle',
          size: 0.5,
          text: `大盘 ${Math.round(Number(hotDates.get(String(d.time))))}°`,
        }));
    };

    const hasMultiLines = Array.isArray(lines) && lines.length > 0;
    if (hasMultiLines) {
      lines.forEach((ln, idx) => {
        const multiSeries = chart.addLineSeries({
          color: ln.color,
          lineWidth: 2,
          title: ln.name,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          priceFormat: priceFormat || BASE_PRICE_FORMAT,
          autoscaleInfoProvider,
        });
        const data = toChartData(ln.series);
        multiSeries.setData(data);
        // 合并模式只在第一条曲线上打一次标记，避免同一日期重复出现
        if (idx === 0) multiSeries.setMarkers(buildMarkers(data));
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
        autoscaleInfoProvider,
      });
      const data = toChartData(series);
      line.setData(data);
      line.setMarkers(buildMarkers(data));
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
  }, [series, lines, color, height, priceFormat, priceFormatter, extraLine, fixedRange, hotDates]);

  const wrapWidth = containerRef.current?.clientWidth || 360;
  // 板块情绪周期：左半区 tooltip 放在鼠标右 100px、上 200px；右半区放在鼠标左 100px 再左移自身宽度、上 200px
  // 卡片 overflow: hidden，超出图表范围时贴边显示，避免被裁掉
  let tipLeft = 0;
  let tipTop = 0;
  let tipAlignRight = false;
  if (tip) {
    if (sideTooltip) {
      if (tip.x < wrapWidth / 2) {
        tipLeft = Math.min(tip.x + 100, Math.max(4, wrapWidth - 204));
      } else {
        // 右半区：先放到鼠标左侧 100px，再用 translateX(-100%) 左移自身宽度
        tipLeft = Math.max(204, Math.min(tip.x - 100, wrapWidth - 4));
        tipAlignRight = true;
      }
      tipTop = Math.max(4, tip.y - 200);
    } else {
      tipLeft = tip.x > wrapWidth - 200 ? Math.max(6, wrapWidth - 200) : tip.x + 14;
      tipTop = Math.max(4, tip.y - 14);
    }
  }

  return (
    <div className="sl-chart" ref={containerRef}>
      <div className="sl-chart-canvas" ref={canvasRef} />
      {tip && (
        <div
          className="sl-chart-tooltip"
          style={{
            left: tipLeft,
            top: tipTop,
            transform: tipAlignRight ? 'translateX(-100%)' : undefined,
          }}
        >
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

// 单板块迷你图：板块名 + 一条折线，无数据时占位
const SectorMiniChart = ({ name, color, series, height = 170, priceFormat, priceFormatter, extraLine, fixedRange, hotDates, sideTooltip }) => (
  <div className="sl-sector-mini">
    <div className="sl-sector-mini-head">
      <i style={{ background: color }} />
      <span className="sl-sector-mini-name" title={name}>{name}</span>
      {series && series.length ? <span className="sl-sector-mini-days">{series.length} 日</span> : null}
    </div>
    {series && series.length ? (
      <MiniLineChart
        series={series}
        color={color}
        height={height}
        priceFormat={priceFormat}
        priceFormatter={priceFormatter}
        extraLine={extraLine}
        fixedRange={fixedRange}
        hotDates={hotDates}
        sideTooltip={sideTooltip}
      />
    ) : (
      <div className="sl-sector-mini-empty" style={{ height }}>暂无数据</div>
    )}
  </div>
);

// 单个题材卡片：龙头 / 中军 / 龙二~龙五
const ThemeCard = ({ theme, onOpenStock }) => {
  return (
    <div className="sl-theme-card">
      <div className="sl-theme-head">
        <div className="sl-theme-title">
          <span className="sl-theme-name">{theme.board}</span>
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
            <span className="sl-phase-chip" style={{ '--phase-color': SECTOR_PHASE_COLOR[theme.currentPhase] || PHASE_COLOR[theme.currentPhase] }}>
              {theme.currentPhase}
            </span>
          )}
        </div>
      </div>

      <div className="sl-stock-head">
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

// realtime=true 时用于盯盘页弹窗：后端会用同花顺（7 成）+ 财联社（3 成）并行刷新当日涨停/情绪快照，
// 并刷新板块成交量占比实时分时点，再强制重算情绪周期
// initialData / initialSelection / initialSectorPool / initialSectorData：由盯盘页按钮预取后传入，传入时跳过对应请求
const SiweiLiti = ({
  realtime = false,
  initialData = null,
  initialSelection = null,
  initialSectorPool = null,
  initialSectorData = null,
}) => {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedThemeKeys, setSelectedThemeKeys] = useState(() => (
    Array.isArray(initialSelection?.themeKeys) ? initialSelection.themeKeys : []
  ));
  const [selectionLoaded, setSelectionLoaded] = useState(Boolean(initialSelection));
  const [klineTarget, setKlineTarget] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);

  // 板块成交量占比 / 板块资金流入流出（共用同一个筛选框，选择存服务端）
  const [sectorCats, setSectorCats] = useState(() => (
    Array.isArray(initialSelection?.sectorCats) ? initialSelection.sectorCats : []
  ));
  const [sectorData, setSectorData] = useState(initialSectorData || null); // { ratio: {name:[...]}, fund: {name:[...]} }
  const [sectorLoading, setSectorLoading] = useState(false);
  // 板块情绪周期展示方式：合并（一张多线图）/ 分开（每个板块一张小图，一排两个）
  const [sectorChartMode, setSectorChartMode] = useState('merged');

  const fetchData = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true); else setLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/siwei_liti_analysis`, {
        params: realtime ? { realtime: 1 } : undefined,
        timeout: realtime ? 5 * 60 * 1000 : undefined,
      });
      setData(res.data || null);
      setError('');
      if (manual) message.success(realtime ? '实时数据已刷新' : '四维立体数据已刷新');
    } catch (e) {
      console.error('获取四维立体数据失败:', e);
      setError(e?.response?.data?.message || e.message || '获取失败');
      if (manual) message.error('刷新失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [realtime]);

  useEffect(() => { if (!initialData) fetchData(); }, [fetchData, initialData]);

  // 从服务端恢复上次选择（板块情绪周期题材 + 板块成交&资金日线板块）
  useEffect(() => {
    if (initialSelection) return undefined;
    let cancelled = false;
    axios.get(`${API_BASE}/siwei_liti_selection`)
      .then((res) => {
        if (cancelled) return;
        const themeKeys = Array.isArray(res.data?.themeKeys) ? res.data.themeKeys : [];
        const cats = Array.isArray(res.data?.sectorCats) ? res.data.sectorCats : [];
        setSelectedThemeKeys(themeKeys);
        setSectorCats(cats);
      })
      .catch((e) => {
        console.error('读取四维立体选择记忆失败:', e);
      })
      .finally(() => {
        if (!cancelled) setSelectionLoaded(true);
      });
    return () => { cancelled = true; };
  }, [initialSelection]);

  const themes = useMemo(() => data?.themes || [], [data]);

  // 恢复上次选中的板块情绪周期题材；数据刷新后剔除已不存在的题材，无有效选择时默认第一个
  useEffect(() => {
    if (!selectionLoaded || !themes.length) return;
    setSelectedThemeKeys((prev) => {
      const valid = prev.filter((k) => themes.some((t) => t.key === k));
      if (valid.length) return valid.length === prev.length ? prev : valid;
      return [themes[0].key];
    });
  }, [themes, selectionLoaded]);

  // 板块情绪周期可选题材：不再区分主线/支线，按题材顺序全部展示
  const chipThemes = themes;

  // 标签展示顺序：已选中的排在最前面，其余保持题材顺序
  const sortedChipThemes = useMemo(() => {
    const picked = [];
    const rest = [];
    chipThemes.forEach((t) => {
      (selectedThemeKeys.includes(t.key) ? picked : rest).push(t);
    });
    return [...picked, ...rest];
  }, [chipThemes, selectedThemeKeys]);

  // 选择变化后写回服务端（等首次读取完成，避免默认值覆盖历史选择）
  useEffect(() => {
    if (!selectionLoaded) return;
    const timer = setTimeout(() => {
      axios.post(`${API_BASE}/siwei_liti_selection`, {
        themeKeys: selectedThemeKeys,
        sectorCats,
      }).catch((e) => console.error('保存四维立体选择记忆失败:', e));
    }, 300);
    return () => clearTimeout(timer);
  }, [selectionLoaded, selectedThemeKeys, sectorCats]);

  // 已选题材（按标签列表顺序）
  const selectedThemes = useMemo(
    () => chipThemes.filter((t) => selectedThemeKeys.includes(t.key)),
    [chipThemes, selectedThemeKeys],
  );

  // 已选题材的曲线依次取「红橙黄绿蓝靛紫」，颜色与图例顺序一致
  const themeColorOf = useMemo(() => {
    const map = new Map();
    selectedThemes.forEach((t, idx) => map.set(t.key, LINE_COLORS[idx % LINE_COLORS.length]));
    return map;
  }, [selectedThemes]);

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

  // 大盘情绪温度 ≥ 60 的日期 → 温度值（YYYY-MM-DD），用于在板块情绪周期折线上打点
  const hotMarketDates = useMemo(() => {
    const map = new Map();
    marketSeries.forEach((item) => {
      if (Number(item?.value) < 60) return;
      const ymd = String(item.date || '');
      if (ymd.length !== 8) return;
      map.set(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`, Number(item.value));
    });
    return map;
  }, [marketSeries]);

  // 题材中出现的最高连板数（顶部概览用）
  const maxLianban = useMemo(
    () => themes.reduce((max, t) => Math.max(max, Number(t.maxLianban) || 0), 0),
    [themes],
  );

  const openStock = (stock) => {
    setKlineTarget(stock);
    setKlineVisible(true);
  };

  // ===== 一级板块池：严格取自 东方财富板块成分股汇总 下的 {分类}.json =====
  const [sectorPool, setSectorPool] = useState(() => (
    Array.isArray(initialSectorPool) ? initialSectorPool : []
  ));
  useEffect(() => {
    if (Array.isArray(initialSectorPool) && initialSectorPool.length) return undefined;
    axios.get(`${API_BASE}/block_category_names`)
      .then((res) => setSectorPool(Array.isArray(res.data) ? res.data : []))
      .catch((e) => console.error('获取一级板块清单失败:', e));
    return undefined;
  }, [initialSectorPool]);

  // ===== 板块成交量占比 + 板块资金（同一筛选框，两个子模块）=====
  const fetchSectorData = useCallback(async () => {
    if (sectorCats.length === 0) {
      setSectorData(null);
      return;
    }
    setSectorLoading(true);
    try {
      const startDate = dayjs().subtract(60, 'day').format('YYYY-MM-DD');
      const endDate = dayjs().format('YYYY-MM-DD');
      const [ratioRes, fundRes] = await Promise.all([
        axios.get(`${API_BASE}/block_category_ratio`, {
          params: { startDate, endDate, realtime: realtime ? 1 : 0 },
        }),
        axios.get(`${API_BASE}/get_block_money_day_by_category`, {
          params: { cats: sectorCats.join(','), realtime: realtime ? 1 : 0 },
        }),
      ]);
      const ratioAll = ratioRes.data || {};
      const byCat = {};
      sectorCats.forEach((name) => {
        if (ratioAll[name]) byCat[name] = ratioAll[name];
      });
      setSectorData({ ratio: byCat, fund: fundRes.data || {} });
    } catch (e) {
      console.error('获取板块日线数据失败:', e);
      message.error('获取板块日线数据失败');
    } finally {
      setSectorLoading(false);
    }
  }, [sectorCats, realtime]);

  // 实时模式下等四维立体主数据（含当日实时快照 + 成交量占比）返回后再拉板块日线，
  // 保证资金/占比图也能带上刚刷新的当日实时点；普通复盘页仍独立加载，避免重复请求
  const sectorDataGate = realtime ? Boolean(data) : true;
  // 盯盘页按钮已预取过板块日线数据时，跳过挂载后的首次重复请求
  const skipInitialSectorFetch = useRef(Boolean(initialSectorData));
  useEffect(() => {
    if (!sectorDataGate) return;
    if (skipInitialSectorFetch.current) {
      skipInitialSectorFetch.current = false;
      return;
    }
    fetchSectorData();
  }, [fetchSectorData, sectorDataGate]);

  // 每个板块独立一张图：颜色按所选顺序固定，缺失数据留空占位
  const ratioCharts = useMemo(() => sectorCats.map((name, idx) => ({
    key: name,
    name,
    color: LINE_COLORS[idx % LINE_COLORS.length],
    series: (sectorData?.ratio?.[name] || []).map((r) => ({
      date: r.date,
      value: Number.isFinite(Number(r.ratio)) ? Number(r.ratio) : null,
    })),
  })), [sectorCats, sectorData]);

  const fundCharts = useMemo(() => sectorCats.map((name, idx) => ({
    key: name,
    name,
    color: LINE_COLORS[idx % LINE_COLORS.length],
    series: (sectorData?.fund?.[name] || [])
      .slice()
      .sort((a, b) => Number(a.date) - Number(b.date))
      .map((r) => ({
        date: r.date,
        value: Number.isFinite(Number(r.moneyY)) ? Number(r.moneyY) : null,
      })),
  })), [sectorCats, sectorData]);

  // ===== 周期分析 txt 导出：包含页面全部数据 + 分析提示词 =====
  const numText = (v, suffix = '') => (
    v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : `${Number(v)}${suffix}`
  );

  const buildCycleAnalysisText = useCallback(() => {
    if (!data) return '';
    const L = [];
    const line = (t = '') => L.push(t);
    const lastTemp = data.marketTemperature?.[data.marketTemperature.length - 1];
    const lastTech = data.techEmotion?.[data.techEmotion.length - 1];

    line('==================== 四维立体 · 周期分析 ====================');
    line(`生成时间：${dayjs().format('YYYY-MM-DD HH:mm:ss')}`);
    line(`数据截至：${formatDateFull(data.latestSnapshotDate)}`);
    line(`服务端计算时间：${data.generatedAt || '--'}`);
    line('');

    line('一、市场概览');
    line(`题材总数：${themes.length} 个`);
    line(`最新情绪温度：${lastTemp ? `${numText(lastTemp.value)}（${lastTemp.phase || '--'}）` : '--'}`);
    line(`最新科技情绪指数：${lastTech && lastTech.value != null ? Number(lastTech.value).toFixed(2) : '--'}`);
    line('');

    line('二、大盘情绪周期（最近 60 个交易日）');
    line('日期        情绪温度  阶段        涨停家数');
    (data.marketTemperature || []).forEach((item) => {
      line(`${formatDateFull(item.date)}  ${numText(item.value)}\t${item.phase || '--'}\t${numText(item.limitUp)}`);
    });
    line('');

    line('三、科技情绪指数（最近 60 个交易日）');
    line('日期        指数值');
    (data.techEmotion || []).forEach((item) => {
      line(`${formatDateFull(item.date)}  ${item.value === null || item.value === undefined ? '--' : Number(item.value).toFixed(2)}`);
    });
    line('');

    line(`四、板块情绪周期（最近 ${(data.cycleDates || []).length || 30} 个交易日）`);
    line('判定规则：涨停≥10 且占比提升=全面高潮；涨停≥10 且占比降低=一致加速；涨停 6~9 且占比提升=爆量分歧（仅当前一日为全面高潮/一致加速，否则计全面高潮）；涨停 6~9 且占比降低=弱势震荡；涨停≤5 且较前一日增加=弱势震荡，涨停≤5 且未增加=退潮');
    themes.forEach((t) => {
      line('');
      line(`【${t.board}】${t.category ? `对应板块：${t.category}｜` : ''}当前阶段：${t.currentPhase || '--'}｜今日涨停 ${t.latestCount}｜10日合计 ${t.totalCount}｜最高 ${t.maxLianban}板｜涨停趋势 ${fmtPct(t.countTrend, 1)}｜量比趋势 ${fmtPct(t.ratioTrend, 1)}｜评分 ${fmtScore(t.score)}`);
      line('日期        涨停家数  成交占比%  阶段        判定原因');
      (t.emotionCycle || []).forEach((item) => {
        line(`${formatDateFull(item.date)}  ${numText(item.count)}\t${item.ratio == null ? '--' : item.ratio}\t${item.phase || '--'}\t${item.reason || ''}`);
      });
    });
    line('');

    line('五、题材个股明细');
    themes.forEach((t) => {
      line(`【${t.board}】题材池 ${t.stockPoolCount} 只`);
      line('股票            连板    区间涨幅%  评分    标签');
      (t.stocks || []).forEach((s) => {
        line(`${s.name}(${s.code})  ${s.maxLianban > 1 ? `${s.maxLianban}板` : '首板'}\t${fmtPct(s.gainPct)}\t${fmtScore(s.score)}\t${(s.tags || []).join('/') || '--'}`);
      });
      line('');
    });

    line('六、板块成交与资金日线（当前页面筛选）');
    if (!sectorCats.length) {
      line('（页面未选择板块）');
    } else {
      line(`已选板块：${sectorCats.join('、')}`);
      sectorCats.forEach((name) => {
        line('');
        line(`【${name}】板块成交量占比（近 60 个交易日）`);
        (sectorData?.ratio?.[name] || []).forEach((r) => {
          line(`  ${formatDateFull(r.date)}  ${Number.isFinite(Number(r.ratio)) ? `${Number(r.ratio)}%` : '--'}`);
        });
        line(`【${name}】板块资金净流入 / 净流出（亿）`);
        (sectorData?.fund?.[name] || [])
          .slice()
          .sort((a, b) => Number(a.date) - Number(b.date))
          .forEach((r) => {
            line(`  ${formatDateFull(r.date)}  ${Number.isFinite(Number(r.moneyY)) ? `${Number(r.moneyY)}亿` : '--'}`);
          });
      });
    }
    line('');

    line('==================== 周期分析提示词 ====================');
    line('请基于以上全部数据，按下面的定义与要求进行分析：');
    line(CYCLE_ANALYSIS_PROMPT);
    return L.join('\n');
  }, [data, themes, sectorCats, sectorData]);

  const handleExportCycleAnalysis = () => {
    const text = buildCycleAnalysisText();
    if (!text) {
      message.warning('暂无数据，无法生成周期分析文件');
      return;
    }
    // \ufeff BOM 保证 Windows 记事本打开不乱码
    const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `四维立体周期分析_${dayjs().format('YYYYMMDD_HHmmss')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    message.success('周期分析文件已生成');
  };

  return (
    <div className="siwei-liti-page">
      {/* 顶部主卡（与「科技进攻股票涨幅列表」同一渐变磨砂风格） */}
      <div className="sl-hero">
        <div className="sl-hero-header">
          <div className="sl-hero-title">
            <span className="sl-hero-icon"><ThunderboltOutlined /></span>
            <span>四维立体 · 板块与情绪周期</span>
          </div>
          <div className="sl-hero-actions">
            <span className="sl-total-tag">
              题材 {themes.length} 个
            </span>
            <button
              className="sl-cycle-analysis-btn"
              onClick={handleExportCycleAnalysis}
              disabled={!data}
              title="导出本页全部数据与周期分析提示词（txt）"
            >
              <FileTextOutlined /> 周期分析
            </button>
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

        <div className="sl-status-note">
          最近 10 个交易日板块涨停家数与成交量占比趋势概览
          {data?.latestSnapshotDate && (
            <span className="sl-status-sub">数据截至 {String(data.latestSnapshotDate).slice(0, 4)}-{String(data.latestSnapshotDate).slice(4, 6)}-{String(data.latestSnapshotDate).slice(6, 8)}</span>
          )}
        </div>

        <div className="sl-summary-grid">
          <div className="sl-summary-item">
            <span className="sl-summary-label">题材数量</span>
            <span className="sl-summary-value">{themes.length ? `${themes.length} 个` : '--'}</span>
          </div>
          <div className="sl-summary-item">
            <span className="sl-summary-label">最高连板</span>
            <span className="sl-summary-value">{maxLianban ? `${maxLianban} 板` : '--'}</span>
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
        <div className="sl-loading">
          <Spin size="large" />
          {realtime && <div className="sl-loading-tip">正在并行拉取同花顺 + 财联社当日实时数据与板块资金/成交量占比…</div>}
        </div>
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
            </div>
          </div>

          <div className="sl-glass-card sl-chart-card sl-sector-card">
            <div className="sl-chart-card-head sl-sector-head">
              <div className="sl-sector-head-main">
                <div>
                  <span className="sl-chart-title">板块情绪周期</span>
                  <span className="sl-chart-sub" style={{ marginLeft: 8 }}>
                    最近 {data?.cycleDates?.length || 30} 个交易日｜涨停家数 × 板块成交量占比变化（全面高潮 / 一致加速 / 爆量分歧 / 弱势震荡 / 退潮）
                  </span>
                </div>
                <button
                  type="button"
                  className={`sl-chart-mode-btn ${sectorChartMode === 'split' ? 'active' : ''}`}
                  onClick={() => setSectorChartMode((mode) => (mode === 'merged' ? 'split' : 'merged'))}
                  title={sectorChartMode === 'merged' ? '当前合并展示，点击分开展示' : '当前分开展示，点击合并展示'}
                >
                  <SwapOutlined />
                  {sectorChartMode === 'merged' ? '合并' : '分开'}
                </button>
              </div>
              <div className="sl-theme-chips">
                {sortedChipThemes.map((t) => {
                  const active = selectedThemeKeys.includes(t.key);
                  return (
                    <button
                      key={t.key}
                      className={`sl-theme-chip ${active ? 'active' : ''}`}
                      onClick={() => toggleThemeKey(t.key)}
                      title={active ? `取消 ${t.board}` : `添加 ${t.board} 曲线`}
                    >
                      {active && <i className="sl-chip-dot" style={{ background: themeColorOf.get(t.key) }} />}
                      {t.board}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedThemes.length ? (
              <>
                {sectorChartMode === 'merged' ? (
                  <MiniLineChart
                    lines={sectorLines}
                    height={390}
                    priceFormat={PHASE_PRICE_FORMAT}
                    priceFormatter={PHASE_FORMATTER}
                    fixedRange={{ min: 0, max: 4 }}
                    hotDates={hotMarketDates}
                    sideTooltip
                  />
                ) : (
                  <div className="sl-sector-mini-grid sl-sector-cycle-grid">
                    {sectorLines.map((c) => (
                      <SectorMiniChart
                        key={c.key}
                        name={c.name}
                        color={c.color}
                        series={c.series}
                        height={190}
                        priceFormat={PHASE_PRICE_FORMAT}
                        priceFormatter={PHASE_FORMATTER}
                        fixedRange={{ min: 0, max: 4 }}
                        hotDates={hotMarketDates}
                        sideTooltip
                      />
                    ))}
                  </div>
                )}
                {sectorChartMode === 'merged' && (
                  <div className="sl-selected-legend">
                    {selectedThemes.map((t) => (
                      <span key={t.key} className="sl-legend-item sl-legend-clickable" onClick={() => toggleThemeKey(t.key)}>
                        <i style={{ background: themeColorOf.get(t.key) }} />{t.board}
                      </span>
                    ))}
                  </div>
                )}
                <div className="sl-phase-strip sl-phase-strip-multi">
                  {selectedThemes.map((t) => (
                    <div className="sl-phase-row" key={t.key}>
                      <span
                        className="sl-phase-theme"
                        style={{ '--line-color': themeColorOf.get(t.key) }}
                        title={t.board}
                      >{t.board}</span>
                      <div className="sl-phase-cells">
                        {[...(t.emotionCycle || [])]
                          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                          .map((item) => (
                            <Tooltip key={`${t.key}-${item.date}`} title={`${t.board}｜${item.reason}`}>
                              <div className="sl-phase-cell" style={{ '--phase-color': SECTOR_PHASE_COLOR[item.phase] || '#94a3b8' }}>
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
                  {Object.entries(SECTOR_PHASE_COLOR).reverse().map(([name, color]) => (
                    <span key={name} className="sl-legend-item">
                      <i style={{ background: color }} />{name}
                    </span>
                  ))}
                  <span className="sl-legend-note">
                    规则：涨停≥10 且占比提升=全面高潮；涨停≥10 且占比降低=一致加速；涨停 6~9 且占比提升=爆量分歧（仅当前一日为全面高潮/一致加速，否则计全面高潮）；涨停 6~9 且占比降低=弱势震荡；涨停≤5 且较前一日增加=弱势震荡，涨停≤5 且未增加=退潮。上方标签支持多选，再次点击取消。
                  </span>
                </div>
              </>
            ) : (
              <Empty description="点击上方题材标签添加曲线，再次点击取消" />
            )}
          </div>

          {/* 板块成交量占比 + 板块资金流入流出（同一筛选框，两个子模块） */}
          <div className="sl-section-title">
            <BarChartOutlined /> 板块成交 &amp; 资金日线
            <span className="sl-section-sub">
              同一筛选框同时筛选成交量占比与资金净流入（近 60 个交易日）
            </span>
          </div>
          <div className="sl-glass-card sl-chart-card">
            <div className="sl-chart-card-head sl-sector-head">
              <div>
                <span className="sl-chart-title">板块成交 &amp; 资金</span>
                <span className="sl-chart-sub">每个板块独立一张日线图，方便单独对比</span>
              </div>
            </div>
            {sectorPool.length ? (
              <div className="sl-filter-row">
                <Select
                  className="sl-filter-select"
                  mode="multiple"
                  showSearch
                  allowClear
                  placeholder="搜索板块名称，点击可多选"
                  value={sectorCats}
                  onChange={setSectorCats}
                  filterOption={(input, option) => (
                    String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  )}
                  maxTagCount="responsive"
                  popupClassName="sl-sector-dropdown"
                  options={sectorPool.map((name) => ({
                    value: name,
                    label: name,
                  }))}
                />
                <span className="sl-filter-count">已选 {sectorCats.length} 个板块</span>
              </div>
            ) : null}

            <div className="sl-submodule">
              <div className="sl-submodule-head">
                <BarChartOutlined />
                <span className="sl-submodule-title">板块成交量占比</span>
                <span className="sl-submodule-sub">成分股成交额汇总 / 全市场成交额（%）</span>
              </div>
              {sectorLoading ? (
                <div className="sl-submodule-loading"><Spin /></div>
              ) : !sectorCats.length ? (
                <Empty description="请在上方下拉框中选择板块" />
              ) : (
                <div className="sl-sector-mini-grid">
                  {ratioCharts.map((c) => (
                    <SectorMiniChart
                      key={c.key}
                      name={c.name}
                      color={c.color}
                      series={c.series}
                      priceFormat={SECTOR_PRICE_FORMAT}
                      priceFormatter={(p) => `${Number(p).toFixed(2)}%`}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="sl-submodule">
              <div className="sl-submodule-head">
                <SwapOutlined />
                <span className="sl-submodule-title">板块资金净流入 / 净流出</span>
                <span className="sl-submodule-sub">东方财富概念板块（正=流入 / 负=流出，单位 亿）</span>
              </div>
              {sectorLoading ? (
                <div className="sl-submodule-loading"><Spin /></div>
              ) : !sectorCats.length ? (
                <Empty description="请在上方下拉框中选择板块" />
              ) : (
                <div className="sl-sector-mini-grid">
                  {fundCharts.map((c) => (
                    <SectorMiniChart
                      key={c.key}
                      name={c.name}
                      color={c.color}
                      series={c.series}
                      priceFormat={SECTOR_PRICE_FORMAT}
                      priceFormatter={(p) => `${Number(p).toFixed(2)}亿`}
                      extraLine={{ value: 0 }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 板块股票：不再区分主线/支线，按顺序平铺全部题材 */}
          <div className="sl-section-title">
            <FundOutlined /> 板块股票（{themes.length}）
          </div>
          {themes.length ? (
            <div className="sl-theme-grid">
              {themes.map((t) => (
                <ThemeCard key={t.key} theme={t} onOpenStock={openStock} />
              ))}
            </div>
          ) : (
            <div className="sl-empty-block">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无板块股票数据"
              />
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
