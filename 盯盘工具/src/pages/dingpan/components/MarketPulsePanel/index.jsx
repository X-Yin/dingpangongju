import { useEffect, useRef, useState } from 'react';
import { Card, Col, Row } from 'antd';
import { DashboardOutlined, FireOutlined, NotificationOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../../../constant';
import { getThemeColor } from '../../../../utils/theme';
import { titleStyle, borderStyle, numberStyle } from '../../utils/themeColor';
import './index.scss';

// 异动类快照最多保留的轮询次数（超过则丢弃最早的一次）
const MAX_SNAPSHOTS = 5;
// 轮询间隔：盘口异动 10s，财联社新闻/同花顺热度 5min
const CHANGES_INTERVAL = 10 * 1000;
const NEWS_INTERVAL = 5 * 60 * 1000;
const API_BASE = `http://${local_ip}:3000/api/ak`;

// 积极异动类型（红色展示），其余类型均视为消极（绿色展示）
const POSITIVE_TYPES = new Set([
    '火箭发射', '快速反弹', '大笔买入', '封涨停板', '打开跌停板', '有大买盘', '竞价上涨', '60日新高', '60日大幅上涨',
]);

// 三列行情面板：盘口异动（全类型）| 财联社快讯 | 同花顺热度榜，三列等高 408px
// 盘口异动每 10s 轮询一次（内存最多保留最近 5 次快照），
// 财联社新闻与同花顺热度每 5min 轮询一次；点击股票名称回调 onStockClick 打开通用 K 线弹窗
const MarketPulsePanel = ({ onStockClick, themeColor }) => {
    const [stockChangesPolls, setStockChangesPolls] = useState([]); // [{ ts, list }]
    const [clsNews, setClsNews] = useState([]);
    const [clsNewsUpdated, setClsNewsUpdated] = useState(0);
    const [hotRankList, setHotRankList] = useState([]);
    const [hotRankUpdated, setHotRankUpdated] = useState(0);
    const inFlightRef = useRef({});

    // 带防重入的轮询请求：上一轮未返回时跳过本轮
    const poll = async (key, url, params, onSuccess) => {
        if (inFlightRef.current[key]) return;
        inFlightRef.current[key] = true;
        try {
            const res = await axios.get(url, { params, timeout: 90 * 1000 });
            if (res.data?.success && Array.isArray(res.data.data)) {
                onSuccess(res.data.data);
            }
        } catch (error) {
            console.error(`轮询 ${key} 失败:`, error.message);
        } finally {
            inFlightRef.current[key] = false;
        }
    };

    useEffect(() => {
        // 盘口异动（全部类型合并）：10s 一次，快照栈最多保留 5 次
        const fetchStockChanges = () => poll('stockChanges', `${API_BASE}/stock_changes`, {},
            (list) => setStockChangesPolls((prev) => [{ ts: Date.now(), list }, ...prev].slice(0, MAX_SNAPSHOTS)));
        // 财联社新闻：5min 一次
        const fetchClsNews = () => poll('clsNews', `${API_BASE}/cls_news`, {},
            (list) => { setClsNews(list); setClsNewsUpdated(Date.now()); });
        // 同花顺热度榜：5min 一次
        const fetchHotRank = () => poll('hotRank', `${API_BASE}/hot_rank`, {},
            (list) => { setHotRankList(list); setHotRankUpdated(Date.now()); });

        fetchStockChanges();
        fetchClsNews();
        fetchHotRank();
        const t1 = setInterval(fetchStockChanges, CHANGES_INTERVAL);
        const t2 = setInterval(fetchClsNews, NEWS_INTERVAL);
        const t3 = setInterval(fetchHotRank, NEWS_INTERVAL);
        return () => [t1, t2, t3].forEach(clearInterval);
    }, []);

    const latestStockChanges = stockChangesPolls[0]?.list || [];
    // 快讯按发布日期+时间倒序，最新在前
    const sortedClsNews = [...clsNews].sort((a, b) =>
        `${b['发布日期'] || ''} ${b['发布时间'] || ''}`.localeCompare(`${a['发布日期'] || ''} ${a['发布时间'] || ''}`));

    return (
        <div className="market-pulse-panel">
            <Row gutter={[8, 8]}>

                                {/* 第二列：财联社快讯（最新在前，内容全量展示） */}
                <Col xs={24} lg={11}>
                    <Card
                        className="monitor-card"
                        variant="borderless"
                        size="small"
                        title={<span style={titleStyle(themeColor)}><NotificationOutlined style={{ color: getThemeColor(), marginRight: 6 }} />财联社快讯</span>}
                        extra={<span className="mp-extra">{dayjs(clsNewsUpdated).format('HH:mm:ss')}</span>}
                        style={{ height: 408, display: 'flex', flexDirection: 'column' }}
                        styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px', marginBottom: 12 } }}
                    >
                        <div className="mp-list">
                            {sortedClsNews.length === 0 && <div className="mp-placeholder">加载中...</div>}
                            {sortedClsNews.map((it, idx) => (
                                <div className="mp-news-item" key={idx} style={borderStyle(themeColor)}>
                                    <span className="mp-time">{it['发布时间']}&nbsp;</span>
                                    <span className="mp-news-text" style={titleStyle(themeColor)}>{it['内容'] || it['标题']}</span>
                                </div>
                            ))}
                        </div>
                    </Card>
                </Col>
                {/* 第一列：盘口异动（全部类型，超出滚动） */}
                <Col xs={24} lg={7}>
                    <Card
                        className="monitor-card"
                        variant="borderless"
                        size="small"
                        title={<span style={titleStyle(themeColor)}><DashboardOutlined style={{ color: getThemeColor(), marginRight: 6 }} />盘口异动</span>}
                        extra={<span className="mp-extra">{dayjs(stockChangesPolls[0]?.ts).format('HH:mm:ss')} · 存{stockChangesPolls.length}/{MAX_SNAPSHOTS}次</span>}
                        style={{ height: 408, display: 'flex', flexDirection: 'column' }}
                        styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px', marginBottom: 12 } }}
                    >
                        <div className="mp-list">
                            {latestStockChanges.length === 0 && <div className="mp-placeholder">加载中...</div>}
                            {latestStockChanges.map((it, idx) => {
                                const isPositive = POSITIVE_TYPES.has(it['板块']);
                                return (
                                    <div
                                        className="mp-row"
                                        key={`${it['代码']}-${it['板块']}-${it['时间']}-${idx}`}
                                        style={borderStyle(themeColor)}
                                        onClick={() => onStockClick?.({ code: toStdCode(it['代码']), name: it['名称'] })}
                                    >
                                        <span className="mp-name" style={titleStyle(themeColor)}>{it['名称']}</span>
                                        <span className={`mp-type ${isPositive ? 'pos' : 'neg'}`}>{it['板块']}</span>
                                        <span className="mp-time">{it['时间']}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </Col>

                {/* 第三列：同花顺热度股票列表（超出滚动） */}
                <Col xs={24} lg={6}>
                    <Card
                        className="monitor-card"
                        variant="borderless"
                        size="small"
                        title={<span style={titleStyle(themeColor)}><FireOutlined style={{ color: getThemeColor(), marginRight: 6 }} />同花顺热度Top100</span>}
                        extra={<span className="mp-extra">{dayjs(hotRankUpdated).format('HH:mm:ss')}</span>}
                        style={{ height: 408, display: 'flex', flexDirection: 'column' }}
                        styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px', marginBottom: 12 } }}
                    >
                        <div className="mp-list">
                            {hotRankList.length === 0 && <div className="mp-placeholder">加载中...</div>}
                            {hotRankList.map((it, idx) => {
                                const pct = typeof it['涨跌幅'] === 'number' ? it['涨跌幅'] : parseFloat(it['涨跌幅']);
                                const up = Number.isFinite(pct) && pct >= 0;
                                return (
                                    <div
                                        className="mp-row"
                                        key={it['代码'] || idx}
                                        style={borderStyle(themeColor)}
                                        onClick={() => onStockClick?.({ code: toStdCode(it['代码']), name: it['股票名称'], change: Number.isFinite(pct) ? pct : undefined })}
                                    >
                                        <span className="mp-rank">{it['当前排名'] ?? idx + 1}</span>
                                        <span className="mp-name" style={titleStyle(themeColor)}>{it['股票名称']}</span>
                                        <span className={`mp-num ${up ? 'up' : 'down'}`} style={numberStyle(themeColor)}>
                                            {Number.isFinite(pct) ? `${up ? '+' : ''}${pct.toFixed(2)}%` : '--'}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </Col>
            </Row>
        </div>
    );
};

// 代码统一为 sh/sz/bj + 6位数字 的格式（兼容 'SH603127' 与 '603127' 两种入参）
function toStdCode(code) {
    const c = String(code || '').trim();
    if (/^(sh|sz|bj)/i.test(c)) return c.toLowerCase();
    if (/^(60|68|9)/.test(c)) return `sh${c}`;
    if (/^(8|4|92)/.test(c)) return `bj${c}`;
    return `sz${c}`;
}

export default MarketPulsePanel;
