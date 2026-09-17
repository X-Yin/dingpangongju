import { useState, useMemo } from 'react';
import { Button, Switch as AntSwitch, Tooltip } from 'antd';
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import './index.scss';

const parseMoneyValue = (val) => {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    let str = String(val);
    const sign = str.startsWith('-') ? -1 : 1;
    if (str.startsWith('+') || str.startsWith('-')) str = str.slice(1);
    let num = parseFloat(str.replace(/亿|万/g, '')) || 0;
    if (String(val).indexOf('万') !== -1) {
        num = num / 10000;
    }
    return sign * num;
};

const formatDisplayTime = (timeStr) => {
    if (timeStr.length >= 6) {
        return `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
    }
    return timeStr;
};

const timeStrToMinutes = (timeStr) => {
    const h = parseInt(timeStr.substring(0, 2));
    const m = parseInt(timeStr.substring(2, 4));
    return h * 60 + m;
};

const minutesToTimeStr = (totalMin) => {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
};

const aggregateTo5Min = (data) => {
    if (!data || data.length === 0) return [];
    const sortedData = [...data].sort((a, b) => a[0].localeCompare(b[0]));

    // tradingSlots 为每个 5min 窗的结束边界（标签）：9:35, 9:40, ... 15:00
    const tradingSlots = [];
    const morningStart = 9 * 60 + 30;
    const morningEnd = 11 * 60 + 30;
    const afternoonStart = 13 * 60;
    const afternoonEnd = 15 * 60;

    for (let t = morningStart + 5; t <= morningEnd; t += 5) tradingSlots.push(t);
    for (let t = afternoonStart + 5; t <= afternoonEnd; t += 5) tradingSlots.push(t);

    const buckets = {};
    sortedData.forEach((item) => {
        const timeStr = item[0];
        const val = item[1];
        const totalMin = timeStrToMinutes(timeStr);
        let bucketMin = null;
        // 归属到「不小于该时间的下一个结束边界」对应的窗口：例如 9:35~9:39 计入标签 9:40
        for (const slot of tradingSlots) {
            if (totalMin < slot) {
                bucketMin = slot;
                break;
            }
        }
        if (bucketMin === null && tradingSlots.length > 0) {
            bucketMin = tradingSlots[tradingSlots.length - 1];
        }
        if (bucketMin !== null) {
            // 取窗口内最新一条的累计净流入作为该窗口值；末值相对上一窗口的增量由展示端计算
            buckets[bucketMin] = { last: parseMoneyValue(val.mainMoney), rawTime: timeStr };
        }
    });

    const result = [];
    tradingSlots.forEach((slot) => {
        const entry = buckets[slot];
        if (entry) {
            result.push({
                time: minutesToTimeStr(slot),
                displayTime: formatDisplayTime(minutesToTimeStr(slot)),
                mainMoney: entry.last,
                rawTime: entry.rawTime,
            });
        }
    });
    return result.reverse();
};

const formatMoneyYi = (v) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
    const n = Number(v);
    const abs = Math.abs(n);
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    const decimals = abs >= 1 ? 1 : 2;
    return `${sign}${abs.toFixed(decimals)}亿`;
};

const MainMoneyCharts = ({ isMainMoneyExpanded, onToggleExpand, moneyStatus, volumeStatus, mainMoneyContainerRef, volumeContainerRef, themeColor, historyData, onCopyContext, copyContextLoading, fillContainer = false, latestMoneyValue, latestVolumeValue, volumeDiffValue, onVolumeRefresh, style, mainMoneyDetailWidth = 260 }) => {
    const [fiveMinAgg, setFiveMinAgg] = useState(true);

    const detailData = useMemo(() => {
        if (!historyData || historyData.length === 0) return [];
        if (fiveMinAgg) {
            return aggregateTo5Min(historyData);
        }
        const sorted = [...historyData].sort((a, b) => b[0].localeCompare(a[0]));
        const result = [];
        let lastMainMoney = null;
        for (const [timeStr, item] of sorted) {
            const mainMoney = parseMoneyValue(item.mainMoney);
            if (mainMoney !== lastMainMoney) {
                lastMainMoney = mainMoney;
                result.push({
                    time: timeStr,
                    displayTime: formatDisplayTime(timeStr),
                    mainMoney,
                    rawTime: timeStr,
                });
            }
        }
        return result;
    }, [historyData, fiveMinAgg]);

    return (
        <div className={`decision-chart-grid ${isMainMoneyExpanded ? 'expanded' : ''}`} style={fillContainer ? { height: '100%', ...style } : style}>
            <div className="decision-chart-card main-money-card" style={fillContainer ? { display: 'flex', flexDirection: 'column', height: '100%' } : undefined}>
                <div className="chart-title-row">
                    <div className="chart-title-left">
                        <div className="chart-title" style={{ cursor: 'pointer' }} onClick={() => { window.open('http://localhost:5173/main_fund', '_blank'); }}>
                            主力资金流入流出
                        </div>
                        {onCopyContext && (
                            <Tooltip title="汇总历史复盘笔记、各日主力资金/成交量/创业板与科创板分时数据，以及今日实时数据，生成供 AI 预测行情的提问上下文并复制到剪贴板">
                                <Button
                                    size="small"
                                    icon={<CopyOutlined />}
                                    loading={copyContextLoading}
                                    onClick={onCopyContext}
                                    className="copy-context-btn"
                                >
                                    复制上下文
                                </Button>
                            </Tooltip>
                        )}
                    </div>
                    <div className="chart-right-section">
                        {moneyStatus && (
                            <div className="chart-speed-status" style={{ color: moneyStatus.color }}>
                                {moneyStatus.icon} {moneyStatus.label}
                            </div>
                        )}
                        {latestMoneyValue !== undefined && latestMoneyValue !== null && (
                            <div className="chart-latest-money" style={{ color: latestMoneyValue > 0 ? '#e11d48' : latestMoneyValue < 0 ? '#059669' : '#12213a' }}>
                                {formatMoneyYi(latestMoneyValue)}
                            </div>
                        )}
                        {isMainMoneyExpanded && latestVolumeValue !== undefined && latestVolumeValue !== null && (
                            <div className="chart-volume-inline" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: '#12213a' }}>成交量</span>
                                <span className="chart-latest-money" style={{ color: parseFloat(latestVolumeValue) > 0 ? '#e11d48' : latestVolumeValue < 0 ? '#059669' : '#12213a' }}>
                                    {formatMoneyYi(latestVolumeValue)}
                                </span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: '#12213a' }}>diff</span>
                                <span className="chart-latest-money" style={{ color: (volumeDiffValue != null && parseFloat(volumeDiffValue) > 0) ? '#e11d48' : (volumeDiffValue != null && volumeDiffValue < 0) ? '#059669' : '#12213a' }}>
                                    {formatMoneyYi(volumeDiffValue != null ? volumeDiffValue : null)}
                                </span>
                            </div>
                        )}
                        <Button
                            size="small"
                            type="text"
                            onClick={onToggleExpand}
                            className="chart-expand-btn"
                        >
                            {isMainMoneyExpanded ? '收起' : '展开'}
                        </Button>
                    </div>
                </div>
                <div className={`chart-content-row ${isMainMoneyExpanded ? 'expanded' : ''}`} style={fillContainer ? { flex: 1, minHeight: 0, overflow: 'hidden' } : undefined}>
                    <div className="decision-chart-shell" style={{ height: fillContainer ? '100%' : '236px' }}>
                        <div ref={mainMoneyContainerRef} style={{ width: '100%', height: '100%' }} />
                    </div>
                    {isMainMoneyExpanded && (
                        <div className="main-money-detail" style={fillContainer ? { width: mainMoneyDetailWidth, height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column' } : undefined}>
                            <div className="detail-header">
                                <span className="detail-title">主力资金明细</span>
                                <label className="five-min-switch">
                                    <AntSwitch
                                        size="small"
                                        checked={fiveMinAgg}
                                        onChange={setFiveMinAgg}
                                    />
                                    <span className="switch-text">5分钟聚合</span>
                                </label>
                            </div>
                            <div className="detail-table-wrapper" style={fillContainer ? { flex: 1, minHeight: 0 } : undefined}>
                                {detailData.length === 0 ? (
                                    <div className="detail-empty">暂无数据</div>
                                ) : (
                                    detailData.map((item, index) => {
                                        const prevItem = index + 1 < detailData.length ? detailData[index + 1] : null;
                                        const diff = prevItem ? item.mainMoney - prevItem.mainMoney : 0;
                                        const isUp = item.mainMoney >= 0;
                                        const isBigOutflow = diff <= -4;
                                        const isBigInflow = diff >= 4;
                                        return (
                                            <div key={item.time} className={`detail-item ${isUp ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow' : ''} ${isBigInflow ? 'big-inflow' : ''}`}>
                                                <span className="item-time">{item.displayTime}</span>
                                                <span className={`item-value ${isUp ? 'up' : 'down'}`}>
                                                    {isUp ? '+' : ''}{item.mainMoney.toFixed(2)}
                                                    {prevItem && diff !== 0 && (
                                                        <span className={`item-diff ${diff >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow-text' : ''} ${isBigInflow ? 'big-inflow-text' : ''}`}>
                                                            ({diff >= 0 ? '+' : ''}{diff.toFixed(2)})
                                                        </span>
                                                    )}
                                                </span>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
            <div className="decision-chart-card volume-card" style={fillContainer ? { display: 'flex', flexDirection: 'column', height: '100%' } : undefined}>
                <div className="chart-title-row">
                    <div>
                        <div className="chart-title">成交量趋势</div>
                    </div>
                    <div className="chart-right-section">
                        {volumeStatus && (
                            <div className="chart-speed-status" style={{ color: volumeStatus.color }}>
                                {volumeStatus.icon} {volumeStatus.label}
                            </div>
                        )}
                        {onVolumeRefresh && (
                            <Button
                                size="small"
                                type="text"
                                icon={<ReloadOutlined />}
                                onClick={onVolumeRefresh}
                                className="chart-refresh-btn"
                                title="重新加载成交量图"
                            />
                        )}
                    </div>
                </div>
                <div className="decision-chart-shell" style={{ height: fillContainer ? '100%' : '236px', flex: fillContainer ? 1 : undefined, minHeight: 0 }}>
                    <div ref={volumeContainerRef} style={{ width: '100%', height: '100%' }} />
                </div>
            </div>
        </div>
    );
};

export default MainMoneyCharts;