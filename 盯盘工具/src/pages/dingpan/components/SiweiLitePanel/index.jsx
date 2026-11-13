import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Empty, Popover, Spin, message } from 'antd';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../../../constant';
import { getThemeColor } from '../../../../utils/theme';
import { isTradingDay } from '../../../../utils/tradingDay';
import './index.scss';

const API_BASE = `http://${local_ip}:3000`;
// 每 5 分钟轮询一次最新连板网数据
const POLL_INTERVAL = 5 * 60 * 1000;
const CHART_DAYS = 10;
const TOP_THEME_COUNT = 4;

// 题材情绪周期阶段配色（与四维立体页面一致）
const PHASE_COLORS = {
    全面高潮: '#f43f5e',
    一致加速: '#f59e0b',
    爆量分歧: '#38bdf8',
    弱势震荡: '#94a3b8',
    退潮: '#22c55e',
};

// 与后端 siweiLiti / themeMonitor 的 boardKeyOf 保持一致（去掉括号补充说明）
const boardKeyOf = (board) => String(board || '').replace(/（[^）]*）|\([^)]*\)/g, '').trim();

const formatYmd = (ymd) => {
    const s = String(ymd || '');
    if (s.length === 8) return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
    const d = dayjs(s);
    return d.isValid() ? d.format('MM/DD') : '--';
};

const fmtPct = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '--';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
};

// 盘中（9:05-15:05）才走实时快照；收盘后当日完整连板快照已落盘，
// 直接用落盘数据，避免实时接口按涨停原因重新归组导致题材被拆散
// （例如「文化传媒」会被拆成影视院线 / AI短剧 / 游戏等多个子题材）
const shouldUseRealtime = () => {
    const now = dayjs();
    if (!isTradingDay(now)) return false;
    const hm = now.hour() * 100 + now.minute();
    return hm >= 905 && hm < 1505;
};

// realtime 接口失败时，把当日实时情绪温度并入历史序列，保证折线仍能展示今天
const mergeTodayTemperature = (series, day) => {
    const base = Array.isArray(series) ? series.filter(Boolean) : [];
    const date = day?.date ? String(day.date) : '';
    const temperature = day?.sentiment?.temperature;
    if (!date || !Number.isFinite(Number(temperature))) return base;
    const next = base.filter((item) => String(item.date) !== date);
    next.push({
        date,
        value: Number(temperature),
        phase: day?.sentiment?.phase || '',
    });
    return next
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .slice(-CHART_DAYS);
};

// 大盘近 10 日情绪温度折线图（纯 SVG，固定宽度自适应卡片）
const TempLineChart = ({ data }) => {
    const points = useMemo(
        () => (Array.isArray(data) ? data : [])
            .filter((item) => item && Number.isFinite(Number(item.value)))
            .slice(-CHART_DAYS),
        [data],
    );

    if (!points.length) {
        return <div className="slp-chart-empty">暂无情绪温度数据</div>;
    }

    const width = 280;
    const height = 104;
    const padX = 6;
    const padTop = 12;
    const padBottom = 16;
    const values = points.map((item) => Number(item.value));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (lo === hi) {
        lo -= 1;
        hi += 1;
    }
    const usableHeight = height - padTop - padBottom;
    const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
    const coords = points.map((item, index) => ({
        ...item,
        x: padX + index * step,
        y: padTop + ((hi - Number(item.value)) / (hi - lo)) * usableHeight,
    }));
    const linePath = coords
        .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
        .join(' ');
    const baseY = height - padBottom;
    const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${baseY} L${coords[0].x.toFixed(1)},${baseY} Z`;
    const lastPoint = coords[coords.length - 1];

    return (
        <div className="slp-chart">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="大盘最近10日情绪温度">
                <defs>
                    <linearGradient id="slp-temp-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="#f43f5e" stopOpacity="0" />
                    </linearGradient>
                </defs>
                {[0.33, 0.66].map((ratio) => (
                    <line
                        key={ratio}
                        className="slp-chart-grid"
                        x1={padX}
                        x2={width - padX}
                        y1={padTop + usableHeight * ratio}
                        y2={padTop + usableHeight * ratio}
                    />
                ))}
                <path d={areaPath} fill="url(#slp-temp-fill)" />
                <path d={linePath} className="slp-chart-line" />
                {coords.map((point) => (
                    <g key={point.date}>
                        <circle cx={point.x} cy={point.y} r="2.2" className="slp-chart-dot" />
                        <circle cx={point.x} cy={point.y} r="9" fill="transparent">
                            <title>{`${formatYmd(point.date)} · ${point.phase || '--'} · ${point.value}°`}</title>
                        </circle>
                    </g>
                ))}
                <circle cx={lastPoint.x} cy={lastPoint.y} r="3.4" className="slp-chart-dot-last" />
                <text x={padX} y={height - 3} className="slp-chart-axis">{formatYmd(coords[0].date)}</text>
                <text x={width - padX} y={height - 3} className="slp-chart-axis" textAnchor="end">
                    {formatYmd(lastPoint.date)}
                </text>
            </svg>
        </div>
    );
};

// 简版四维立体：大盘情绪温度 + 自己勾选的置顶题材 + 当日涨停家数最多的四个题材
const SiweiLitePanel = ({ onStockClick, height }) => {
    const [state, setState] = useState({
        temperature: [],
        themes: [],
        pinnedKeys: [],
        todayThemes: [],
        dataDate: '',
        updatedAt: '',
    });
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const inFlightRef = useRef(false);
    const mountedRef = useRef(true);

    const fetchAll = useCallback(async (manual = false) => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        if (manual) setRefreshing(true);
        const today = dayjs().format('YYYYMMDD');
        const realtime = shouldUseRealtime();
        try {
            const [analysisRes, dayRes, selectionRes] = await Promise.allSettled([
                axios.get(`${API_BASE}/siwei_liti_analysis`, {
                    params: realtime
                        ? { realtime: 1, emotionDays: CHART_DAYS }
                        : { emotionDays: CHART_DAYS },
                    timeout: realtime ? 5 * 60 * 1000 : 60 * 1000,
                }),
                axios.get(`${API_BASE}/lianban_day`, {
                    params: realtime ? { date: today, realtime: 1 } : { date: today },
                    timeout: realtime ? 5 * 60 * 1000 : 30 * 1000,
                }),
                axios.get(`${API_BASE}/siwei_liti_selection`, { timeout: 15 * 1000 }),
            ]);
            if (!mountedRef.current) return;

            const analysis = analysisRes.status === 'fulfilled' ? analysisRes.value?.data : null;
            let day = dayRes.status === 'fulfilled' ? dayRes.value?.data : null;
            const selection = selectionRes.status === 'fulfilled' ? selectionRes.value?.data : null;

            // 非交易日 / 开盘前：today 没有连板快照，改用四维立体返回的最新快照日期
            const latestDate = analysis?.latestSnapshotDate ? String(analysis.latestSnapshotDate) : '';
            if (!day && latestDate && latestDate !== today) {
                day = await axios.get(`${API_BASE}/lianban_day`, {
                    params: { date: latestDate },
                    timeout: 30 * 1000,
                }).then((res) => res.data || null).catch(() => null);
                if (!mountedRef.current) return;
            }

            const anySuccess = Boolean(analysis || day || selection);

            setState((prev) => ({
                temperature: Array.isArray(analysis?.marketTemperature) && analysis.marketTemperature.length
                    ? analysis.marketTemperature.slice(-CHART_DAYS)
                    : mergeTodayTemperature(prev.temperature, day),
                themes: Array.isArray(analysis?.themes) && analysis.themes.length
                    ? analysis.themes
                    : prev.themes,
                pinnedKeys: Array.isArray(selection?.themeKeys) ? selection.themeKeys : prev.pinnedKeys,
                todayThemes: Array.isArray(day?.themes) && day.themes.length
                    ? day.themes
                    : prev.todayThemes,
                dataDate: day?.date || analysis?.latestSnapshotDate || prev.dataDate,
                updatedAt: dayjs().format('HH:mm:ss'),
            }));
            setError(anySuccess ? '' : '数据获取失败');
            if (manual) {
                if (anySuccess) message.success('连板网数据已刷新');
                else message.error('刷新失败，请稍后重试');
            }
        } finally {
            inFlightRef.current = false;
            if (mountedRef.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchAll();
        const timer = setInterval(() => fetchAll(), POLL_INTERVAL);
        return () => {
            mountedRef.current = false;
            clearInterval(timer);
        };
    }, [fetchAll]);

    // 当日各题材涨停家数与涨停股明细（lianban_day 快照）
    const todayThemeMap = useMemo(() => {
        const map = new Map();
        (state.todayThemes || []).forEach((theme) => {
            const key = boardKeyOf(theme.board) || theme.board;
            // 「其他」不是题材，不参与列表与 TOP 排名
            if (!key || key === '其他') return;
            const stocks = Array.isArray(theme.stocks) ? theme.stocks : [];
            const prev = map.get(key);
            if (prev) {
                prev.count += stocks.length;
                prev.stocks.push(...stocks);
            } else {
                map.set(key, { count: stocks.length, stocks: [...stocks] });
            }
        });
        return map;
    }, [state.todayThemes]);

    // 四维立体的题材数据（含当日情绪阶段），再补齐实时快照里新增的题材
    const themeStats = useMemo(() => {
        const map = new Map();
        (state.themes || []).forEach((theme) => {
            const dayTheme = todayThemeMap.get(theme.key);
            map.set(theme.key, {
                key: theme.key,
                board: theme.board,
                phase: theme.currentPhase || '',
                count: dayTheme ? dayTheme.count : (Number(theme.latestCount) || 0),
                stocks: dayTheme ? dayTheme.stocks : [],
                hasDetail: Boolean(dayTheme),
            });
        });
        todayThemeMap.forEach((dayTheme, key) => {
            if (map.has(key)) return;
            const source = (state.todayThemes || []).find((theme) => (boardKeyOf(theme.board) || theme.board) === key);
            map.set(key, {
                key,
                board: source?.board || key,
                phase: '',
                count: dayTheme.count,
                stocks: dayTheme.stocks,
                hasDetail: true,
            });
        });
        return map;
    }, [state.themes, state.todayThemes, todayThemeMap]);

    const pinnedThemes = useMemo(
        () => (state.pinnedKeys || []).map((key) => themeStats.get(key)).filter(Boolean),
        [state.pinnedKeys, themeStats],
    );

    const topThemes = useMemo(() => {
        const pinnedKeySet = new Set(pinnedThemes.map((theme) => theme.key));
        return [...themeStats.values()]
            .filter((theme) => theme.key !== '其他' && theme.count > 0 && !pinnedKeySet.has(theme.key))
            .sort((a, b) => b.count - a.count)
            .slice(0, TOP_THEME_COUNT);
    }, [themeStats, pinnedThemes]);

    const latest = useMemo(() => {
        const list = (state.temperature || []).filter((item) => Number.isFinite(Number(item.value)));
        return list[list.length - 1] || null;
    }, [state.temperature]);

    const hasData = state.temperature.length > 0 || themeStats.size > 0;

    const renderStockPopover = (theme) => {
        if (!theme.stocks.length) {
            return <div className="slp-pop-empty">暂无当日涨停明细</div>;
        }
        return (
            <div className="block-stock-list slp-pop-list">
                {theme.stocks.map((stock, index) => {
                    const change = stock?.quote?.changePct;
                    const changeNum = Number(change);
                    const changeClass = Number.isFinite(changeNum) ? (changeNum >= 0 ? 'up' : 'down') : '';
                    const lianbanText = stock?.lianbanText
                        || (Number(stock?.lianbanCount) > 1 ? `${stock.lianbanCount}板` : '首板');
                    return (
                        <div
                            key={`${stock?.code || index}-${index}`}
                            className="block-stock-item slp-pop-item"
                            title="点击查看 K 线"
                            onClick={() => stock?.code && onStockClick?.({
                                code: stock.code,
                                name: stock.name,
                                change,
                            })}
                        >
                            <span className="block-stock-name">{stock?.name || stock?.code}</span>
                            <span className="slp-pop-lb">{lianbanText}</span>
                            <span className={`block-stock-change ${changeClass}`}>
                                {fmtPct(change)}
                            </span>
                        </div>
                    );
                })}
            </div>
        );
    };

    const renderThemeRow = (theme, pinned) => (
        <Popover
            key={theme.key}
            content={renderStockPopover(theme)}
            title={<span style={{ fontSize: 13, fontWeight: 600 }}>{theme.board} · 今日涨停 {theme.count} 只</span>}
            trigger="click"
            placement="top"
            overlayClassName="block-stock-popover"
        >
            <div className="slp-row">
                <span className="slp-row-name">
                    {pinned && <i className="slp-pin-tag">置顶</i>}
                    <span className="slp-row-name-text" title={theme.board}>{theme.board}</span>
                </span>
                {theme.phase ? (
                    <span
                        className="slp-phase-tag"
                        style={{
                            color: PHASE_COLORS[theme.phase] || '#94a3b8',
                            borderColor: `${PHASE_COLORS[theme.phase] || '#94a3b8'}66`,
                            background: `${PHASE_COLORS[theme.phase] || '#94a3b8'}14`,
                        }}
                    >
                        {theme.phase}
                    </span>
                ) : (
                    <span className="slp-phase-tag is-empty">--</span>
                )}
                <span className="slp-row-count"><b>{theme.count}</b>家</span>
            </div>
        </Popover>
    );

    return (
        <div
            className="siwei-lite-panel"
            style={height ? { height: `${height}px` } : undefined}
        >
            <Card
                title={(
                    <div className="slp-title">
                        <ThunderboltOutlined style={{ color: getThemeColor() }} />
                        <span>大盘题材</span>
                    </div>
                )}
                extra={(
                    <Button
                        type="text"
                        size="small"
                        className="slp-refresh-btn"
                        title="刷新最新连板网数据"
                        icon={<ReloadOutlined spin={refreshing} />}
                        disabled={refreshing}
                        onClick={() => fetchAll(true)}
                    />
                )}
                className="monitor-card compact-head-card siwei-lite-card"
                variant="borderless"
                bodyStyle={{ padding: '10px 12px 12px' }}
            >
                {loading && !hasData ? (
                    <div className="slp-loading"><Spin size="small" /></div>
                ) : error && !hasData ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error} />
                ) : (
                    <>
                        <div className="slp-chart-head">
                            <span className="slp-chart-title">大盘情绪温度 · 近10日</span>
                            {latest && (
                                <span className="slp-chart-latest">
                                    <b>{Number(latest.value).toFixed(0)}°</b>
                                    {latest.phase && <em>{latest.phase}</em>}
                                </span>
                            )}
                        </div>
                        <TempLineChart data={state.temperature} />

                        <div className="slp-section-head">
                            <span>默认题材</span>
                            <span className="slp-section-hint">默认勾选</span>
                        </div>
                        <div className="slp-list">
                            {pinnedThemes.length
                                ? pinnedThemes.map((theme) => renderThemeRow(theme, true))
                                : <div className="slp-empty-line">在「四维立体」勾选题材后会置顶展示</div>}
                        </div>

                        <div className="slp-section-head">
                            <span>涨停最多 TOP{TOP_THEME_COUNT}</span>
                            <span className="slp-section-hint">已剔除置顶题材</span>
                        </div>
                        <div className="slp-list">
                            {topThemes.length
                                ? topThemes.map((theme) => renderThemeRow(theme, false))
                                : <div className="slp-empty-line">暂无题材涨停数据</div>}
                        </div>

                        <div className="slp-foot">
                            <span>{state.dataDate ? `数据 ${formatYmd(state.dataDate)}` : ''}</span>
                            <span>{state.updatedAt ? `更新 ${state.updatedAt}` : ''}</span>
                        </div>
                    </>
                )}
            </Card>
        </div>
    );
};

export default SiweiLitePanel;
