import { useState, useEffect, useRef } from 'react';
import { Drawer, Empty, Spin, Typography, Space } from 'antd';
import { EyeOutlined, AreaChartOutlined, LineChartOutlined } from '@ant-design/icons';
import { createChart, ColorType } from 'lightweight-charts';
import axios from 'axios';
import StockSearchInput from '../StockSearchInput';
import StockTimeLine from '../StockTimeLine';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import './index.scss';

const { Text } = Typography;

// K 线均线配置：3 日 / 5 日 / 10 日
const MA_LINES = [
    { key: 'ma3', color: '#13c2c2', label: 'MA3' },
    { key: 'ma5', color: '#ff9800', label: 'MA5' },
    { key: 'ma10', color: '#2196f3', label: 'MA10' },
];

/**
 * 看股 K 线图：K 线 + 成交额 + 3/5/10 日均线，点击 K 线柱回调对应日期（YYYY-MM-DD）
 * 模仿 StockKLine 简化实现（不含抗分歧/机构参与度等附加能力）
 */
function ViewerKLine({ data = [], height = 420, onClickCandle }) {
    const container = useRef(null);
    const tooltipRef = useRef(null);
    const chartRef = useRef(null);
    const candlestickRef = useRef(null);
    const volumeSeriesRef = useRef(null);
    const maSeriesRefs = useRef([]);
    const maValueMapsRef = useRef({});
    const changeMapRef = useRef({});
    const initializedRef = useRef(false);

    // 初始化图表（只执行一次）
    useEffect(() => {
        if (!container.current || initializedRef.current) return;
        initializedRef.current = true;

        const chart = createChart(container.current, {
            layout: {
                background: { type: ColorType.Solid, color: '#ffffff' },
                textColor: '#333',
            },
            width: container.current.clientWidth || 700,
            height: height,
            localization: {
                locale: 'zh-CN',
            },
            timeScale: {
                borderColor: '#D1D4DC',
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time) => {
                    if (typeof time === 'string') {
                        const parts = time.split('-');
                        return `${parts[1]}/${parts[2]}`;
                    }
                    if (time && typeof time === 'object') {
                        return `${time.month}/${time.day}`;
                    }
                    return time;
                },
            },
            grid: {
                vertLines: { color: '#f0f0f0' },
                horzLines: { color: '#f0f0f0' },
            },
            handleScroll: false,
            handleScale: false,
        });

        const candlestick = chart.addCandlestickSeries({
            upColor: '#f5222d',
            downColor: '#52c41a',
            borderVisible: false,
            wickUpColor: '#f5222d',
            wickDownColor: '#52c41a',
        });

        const volumeSeries = chart.addHistogramSeries({
            color: '#26a69a',
            priceFormat: {
                type: 'volume',
            },
            priceScaleId: '',
        });
        volumeSeries.priceScale().applyOptions({
            scaleMargins: {
                top: 0.8,
                bottom: 0,
            },
        });

        maSeriesRefs.current = MA_LINES.map(cfg => chart.addLineSeries({
            color: cfg.color,
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
        }));

        chartRef.current = chart;
        candlestickRef.current = candlestick;
        volumeSeriesRef.current = volumeSeries;

        // 十字光标 Tooltip
        const tooltip = tooltipRef.current;
        chart.subscribeCrosshairMove(param => {
            if (
                param.point === undefined ||
                !param.time ||
                param.point.x < 0 ||
                param.point.x > container.current.clientWidth ||
                param.point.y < 0 ||
                param.point.y > height
            ) {
                tooltip.style.display = 'none';
                return;
            }
            const kData = param.seriesData.get(candlestick);
            const vData = param.seriesData.get(volumeSeries);
            if (!kData) {
                tooltip.style.display = 'none';
                return;
            }
            tooltip.style.display = 'block';
            const dateStr = typeof param.time === 'string' ? param.time : `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
            const volDisplay = vData ? (vData.value / 100000000).toFixed(2) + '亿' : '0.00亿';
            // 红涨绿跌严格按真实涨跌（vs 昨收）
            const changeVal = changeMapRef.current[dateStr];
            const changeColor = changeVal === undefined ? '#333' : changeVal > 0 ? '#f5222d' : changeVal < 0 ? '#52c41a' : '#666';
            const maRows = MA_LINES.map(cfg => {
                const v = maValueMapsRef.current[cfg.key]?.[dateStr];
                return `<div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span style="color: ${cfg.color};">${cfg.label}:</span><span style="font-weight: bold;">${v !== undefined ? v.toFixed(2) : '-'}</span></div>`;
            }).join('');
            tooltip.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #eee; padding-bottom: 4px;">${dateStr}</div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>开盘:</span><span style="font-weight: bold;">${kData.open.toFixed(2)}</span></div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最高:</span><span style="font-weight: bold;">${kData.high.toFixed(2)}</span></div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>最低:</span><span style="font-weight: bold;">${kData.low.toFixed(2)}</span></div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>收盘:</span><span style="font-weight: bold; color: ${changeColor}">${kData.close.toFixed(2)}</span></div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>成交额:</span><span style="font-weight: bold;">${volDisplay}</span></div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span>涨跌:</span><span style="font-weight: bold; color: ${changeColor}">${changeVal !== undefined ? (changeVal > 0 ? '+' : '') + changeVal.toFixed(2) + '%' : '-'}</span></div>
                ${maRows}
            `;

            const coordinate = candlestick.priceToCoordinate(kData.close);
            const tooltipWidth = 160;
            const margin = 10;
            setTimeout(() => {
                const actualHeight = tooltip.offsetHeight || 200;
                let left = param.point.x + margin;
                if (left + tooltipWidth > container.current.clientWidth - margin) {
                    left = param.point.x - tooltipWidth - margin;
                }
                let top = coordinate !== undefined ? coordinate - actualHeight / 2 : param.point.y + margin;
                if (top < margin) top = margin;
                if (top + actualHeight > height - margin) top = height - actualHeight - margin;
                tooltip.style.left = left + 'px';
                tooltip.style.top = top + 'px';
            }, 0);
        });

        // 点击 K 线柱回调日期
        if (onClickCandle) {
            chart.subscribeClick(param => {
                if (!param.time) return;
                let dateStr;
                if (typeof param.time === 'string') {
                    dateStr = param.time;
                } else if (typeof param.time === 'object') {
                    dateStr = `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}`;
                } else {
                    return;
                }
                onClickCandle(dateStr);
            });
        }

        const handleResize = () => {
            if (container.current && chartRef.current) {
                chartRef.current.applyOptions({ width: container.current.clientWidth });
            }
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
            }
            initializedRef.current = false;
        };
    }, [height]);

    // 数据更新：MA3 前端按收盘价计算（后端只有 ma5/ma10/ma20），MA5/MA10 直接用后端字段
    useEffect(() => {
        if (!initializedRef.current || !chartRef.current) return;
        if (!data || data.length === 0) return;

        const candlestick = candlestickRef.current;
        const volumeSeries = volumeSeriesRef.current;
        const chart = chartRef.current;

        const ascending = [...data].sort((a, b) => a.trade_date - b.trade_date);
        const ma3Map = {};
        for (let i = 2; i < ascending.length; i++) {
            ma3Map[ascending[i].trade_date] = parseFloat(
                ((ascending[i].close_px + ascending[i - 1].close_px + ascending[i - 2].close_px) / 3).toFixed(2)
            );
        }

        const klineData = [];
        const volumeData = [];
        const maData = {};
        MA_LINES.forEach(cfg => { maData[cfg.key] = []; });
        const changeMap = {};

        data.forEach(item => {
            const dateStr = String(item.trade_date);
            const formattedDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
            klineData.push({
                time: formattedDate,
                open: item.open_px,
                high: item.high_px,
                low: item.low_px,
                close: item.close_px,
            });

            const chg = typeof item.change === 'number' && !isNaN(item.change) ? item.change : null;
            if (chg !== null) changeMap[formattedDate] = chg;

            // 成交量柱颜色严格按涨跌（vs 昨收）红绿
            const volColor = chg === null
                ? (item.close_px >= item.open_px ? 'rgba(245, 34, 45, 0.5)' : 'rgba(82, 196, 26, 0.5)')
                : chg > 0 ? 'rgba(245, 34, 45, 0.5)' : chg < 0 ? 'rgba(82, 196, 26, 0.5)' : 'rgba(166, 166, 166, 0.5)';
            volumeData.push({
                time: formattedDate,
                value: item.business_balance || 0,
                color: volColor,
            });

            if (ma3Map[item.trade_date] !== undefined) {
                maData.ma3.push({ time: formattedDate, value: ma3Map[item.trade_date] });
            }
            if (item.ma5_px) {
                maData.ma5.push({ time: formattedDate, value: item.ma5_px });
            }
            if (item.ma10_px) {
                maData.ma10.push({ time: formattedDate, value: item.ma10_px });
            }
        });

        changeMapRef.current = changeMap;
        maValueMapsRef.current = {};
        MA_LINES.forEach(cfg => {
            maValueMapsRef.current[cfg.key] = {};
            maData[cfg.key].forEach(d => {
                maValueMapsRef.current[cfg.key][d.time] = d.value;
            });
        });

        const deduplicate = (arr) => {
            if (arr.length === 0) return [];
            const filtered = arr.filter(item => {
                if (item.open !== undefined && item.high !== undefined && item.low !== undefined && item.close !== undefined) {
                    return typeof item.open === 'number' && typeof item.high === 'number' && typeof item.low === 'number' && typeof item.close === 'number' && !isNaN(item.open) && !isNaN(item.high) && !isNaN(item.low) && !isNaN(item.close);
                }
                if (item.value !== undefined) {
                    return typeof item.value === 'number' && !isNaN(item.value);
                }
                return true;
            });
            if (filtered.length === 0) return [];
            const sorted = filtered.sort((a, b) => a.time.localeCompare(b.time));
            const result = [sorted[0]];
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i].time !== sorted[i - 1].time) {
                    result.push(sorted[i]);
                } else {
                    result[result.length - 1] = sorted[i];
                }
            }
            return result;
        };

        candlestick.setData(deduplicate(klineData));
        volumeSeries.setData(deduplicate(volumeData));
        maSeriesRefs.current.forEach((series, idx) => {
            series.setData(deduplicate(maData[MA_LINES[idx].key]));
        });
        chart.timeScale().fitContent();
    }, [data]);

    return (
        <div className="fsv-kline-container" style={{ position: 'relative', width: '100%' }}>
            <div ref={container} style={{ height, width: '100%' }} />
            <div
                ref={tooltipRef}
                style={{
                    width: '150px',
                    maxHeight: '220px',
                    position: 'absolute',
                    display: 'none',
                    padding: '8px',
                    boxSizing: 'border-box',
                    fontSize: '12px',
                    textAlign: 'left',
                    zIndex: 1000,
                    top: '12px',
                    left: '12px',
                    pointerEvents: 'none',
                    border: '1px solid #d1d4dc',
                    borderRadius: '4px',
                    background: 'rgba(255, 255, 255, 0.9)',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                    color: '#333',
                }}
            />
        </div>
    );
}

const FloatingStockViewer = () => {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [pos, setPos] = useState({ x: window.innerWidth - 76, y: window.innerHeight / 2 - 28 + 100 + 80 });
    const dragRef = useRef({ dragging: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0 });
    const containerRef = useRef(null);

    // 搜索选股（交互同全量自选股的添加股票弹窗）
    const [stockName, setStockName] = useState('');
    const [stockCode, setStockCode] = useState('');
    const stockCodeRef = useRef('');

    // 行情数据
    const [kData, setKData] = useState([]);
    const [kLoading, setKLoading] = useState(false);
    const [zyjsText, setZyjsText] = useState('');
    const [valuation, setValuation] = useState(null);
    const [valuationLoading, setValuationLoading] = useState(false);

    // 点击 K 线后展示的当日分时
    const [selectedDay, setSelectedDay] = useState('');
    const [dayTlineData, setDayTlineData] = useState([]);
    const [dayTlineLoading, setDayTlineLoading] = useState(false);

    const handleMouseDown = (e) => {
        dragRef.current = {
            dragging: true,
            moved: false,
            offsetX: e.clientX - pos.x,
            offsetY: e.clientY - pos.y,
            startX: e.clientX,
            startY: e.clientY,
        };
        document.body.style.userSelect = 'none';
        if (containerRef.current) {
            containerRef.current.style.transition = 'none';
            containerRef.current.style.willChange = 'left, top';
        }
    };

    useEffect(() => {
        const handleMove = (e) => {
            if (!dragRef.current.dragging || !containerRef.current) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                dragRef.current.moved = true;
            }
            const x = e.clientX - dragRef.current.offsetX;
            const y = e.clientY - dragRef.current.offsetY;
            const maxX = window.innerWidth - 72;
            const maxY = window.innerHeight - 72;
            const newX = Math.max(0, Math.min(x, maxX));
            const newY = Math.max(0, Math.min(y, maxY));
            containerRef.current.style.left = `${newX}px`;
            containerRef.current.style.top = `${newY}px`;
        };
        const handleUp = () => {
            if (!dragRef.current.dragging) return;
            dragRef.current.dragging = false;
            document.body.style.userSelect = '';
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setPos({ x: rect.left, y: rect.top });
                containerRef.current.style.transition = '';
                containerRef.current.style.willChange = '';
            }
        };
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', handleUp);
        return () => {
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', handleUp);
        };
    }, []);

    const handleClick = () => {
        if (dragRef.current.moved) {
            dragRef.current.moved = false;
            return;
        }
        setDrawerOpen(true);
    };

    const resetQuoteData = () => {
        setKData([]);
        setZyjsText('');
        setValuation(null);
        setSelectedDay('');
        setDayTlineData([]);
        setDayTlineLoading(false);
        setKLoading(false);
        setValuationLoading(false);
    };

    // 并行拉取 K 线、主营业务、估值数据；切换股票后丢弃过期结果
    const fetchQuoteData = async (code) => {
        const symbol = code.replace(/^(sh|sz|bj)/i, '');
        setKLoading(true);
        setValuationLoading(true);
        const [kRes, zyjsRes, valRes] = await Promise.allSettled([
            axios.get(`http://${local_ip}:3000/stock_data`, { params: { code, limit: 60 } }),
            axios.get(`http://${local_ip}:3000/api/ak/stock_zyjs`, { params: { code: symbol } }),
            axios.get(`http://${local_ip}:3000/stock_valuation`, { params: { code } }),
        ]);
        if (stockCodeRef.current !== code) return;
        if (kRes.status === 'fulfilled' && Array.isArray(kRes.value?.data)) {
            setKData(kRes.value.data);
        } else {
            setKData([]);
        }
        if (zyjsRes.status === 'fulfilled' && zyjsRes.value?.data?.success && Array.isArray(zyjsRes.value.data.data) && zyjsRes.value.data.data.length > 0) {
            setZyjsText(zyjsRes.value.data.data[0]['主营业务'] || '');
        } else {
            setZyjsText('');
        }
        if (valRes.status === 'fulfilled' && valRes.value?.data?.success) {
            setValuation(valRes.value.data.data);
        } else {
            setValuation(null);
        }
        setKLoading(false);
        setValuationLoading(false);
    };

    const handleSelectStock = (name, code) => {
        setStockName(name);
        setStockCode(code);
        stockCodeRef.current = code;
        resetQuoteData();
        if (code) {
            fetchQuoteData(code);
        }
    };

    // 点击 K 线柱 → 加载该日分时数据展示在 K 线下方（读取 ref 中的最新 code，避免闭包捕获旧值）
    const handleCandleClick = async (dateStr) => {
        const code = stockCodeRef.current;
        if (!code) return;
        const dateInt = dateStr.replace(/-/g, '');
        setSelectedDay(dateStr);
        setDayTlineLoading(true);
        setDayTlineData([]);
        try {
            const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code, date: dateInt } });
            setDayTlineData(res.data?.line || []);
        } catch (e) {
            console.error('获取当日分时数据失败:', e);
        } finally {
            setDayTlineLoading(false);
        }
    };

    // 市值展示：单位亿
    const formatYi = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '--' : `${(Number(v) / 100000000).toFixed(2)}亿`;
    const hasValuation = !!valuation;
    // 市盈率：接口返回 null 表示亏损
    const peText = !hasValuation
        ? '--'
        : (valuation.peRatio === null || valuation.peRatio === undefined || isNaN(Number(valuation.peRatio))) ? '亏损' : Number(valuation.peRatio).toFixed(2);

    return (
        <>
            <div
                ref={containerRef}
                className="floating-stock-viewer"
                style={{ left: pos.x, top: pos.y }}
                onMouseDown={handleMouseDown}
                onClick={handleClick}
            >
                <div className="fsv-content">
                    <div className="fsv-icon-wrap">
                        <EyeOutlined className="fsv-icon" />
                    </div>
                    <span className="fsv-label">看股</span>
                </div>
            </div>

            <Drawer
                title={<span><LineChartOutlined style={{ color: getThemeColor(), marginRight: 8 }} />看股</span>}
                placement="right"
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                width={750}
                className="stock-viewer-drawer"
                destroyOnClose={false}
            >
                <div className="fsv-search-panel">
                    <Text type="secondary" style={{ fontSize: '13px' }}>股票名称 (输入后按回车搜索)</Text>
                    <StockSearchInput
                        value={stockName}
                        code={stockCode}
                        onChange={handleSelectStock}
                        style={{ marginTop: 8 }}
                    />
                </div>

                {!stockCode ? (
                    <Empty description="搜索并选中股票后查看 K 线" style={{ marginTop: 80 }} />
                ) : (
                    <div className="fsv-quote-panel">
                        <div className="fsv-quote-header">
                            <span className="fsv-stock-name">{stockName}</span>
                            <span className="fsv-stock-code">{stockCode}</span>
                            <span className="fsv-valuation-item">总市值: <b>{hasValuation ? formatYi(valuation.totalMarketValue) : '--'}</b></span>
                            <span className="fsv-valuation-item">流通市值: <b>{hasValuation ? formatYi(valuation.circulatingMarketValue) : '--'}</b></span>
                            <span className="fsv-valuation-item">
                                市盈率: {peText === '亏损' ? <b className="fsv-pe-loss">亏损</b> : <b>{peText}</b>}
                            </span>
                            {(kLoading || valuationLoading) && <Spin size="small" />}
                        </div>

                        {zyjsText && (
                            <div className="fsv-zyjs" title={zyjsText}>
                                <Text strong style={{ fontSize: 12, color: getThemeColor() }}>主营业务：</Text>
                                <span>{zyjsText}</span>
                            </div>
                        )}

                        <div className="fsv-ma-legend">
                            {MA_LINES.map(cfg => (
                                <span key={cfg.key} className="fsv-ma-legend-item" style={{ color: cfg.color }}>{cfg.label}</span>
                            ))}
                            <span className="fsv-ma-legend-tip">点击 K 线柱在下方查看当日分时图</span>
                        </div>

                        {kLoading ? (
                            <div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Spin tip="正在加载K线数据..." size="large" />
                            </div>
                        ) : kData.length > 0 ? (
                            <ViewerKLine data={kData} height={420} onClickCandle={handleCandleClick} />
                        ) : (
                            <Empty description="暂无 K 线数据" />
                        )}

                        {selectedDay && (
                            <div className="fsv-day-tline">
                                <div className="fsv-day-tline-title">
                                    <Space size={8}>
                                        <AreaChartOutlined style={{ color: getThemeColor() }} />
                                        <Text strong>{selectedDay} 分时图</Text>
                                    </Space>
                                </div>
                                {dayTlineLoading ? (
                                    <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <Spin tip="正在加载分时数据..." size="large" />
                                    </div>
                                ) : dayTlineData.length > 0 ? (
                                    <StockTimeLine data={dayTlineData} height={300} />
                                ) : (
                                    <Empty description="暂无该日分时数据" />
                                )}
                            </div>
                        )}
                    </div>
                )}
            </Drawer>
        </>
    );
};

export default FloatingStockViewer;
