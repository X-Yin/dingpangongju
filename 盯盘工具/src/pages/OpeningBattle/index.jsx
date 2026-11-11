import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Spin, Empty, Select, Switch as AntSwitch, Modal, Checkbox, message, Tooltip } from 'antd';
import {
  RocketOutlined, RiseOutlined, FallOutlined, StockOutlined,
  AreaChartOutlined, CrownOutlined, RadarChartOutlined, WarningOutlined,
  ReloadOutlined, BgColorsOutlined, QuestionCircleOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { isAfterMarketClose } from '../../utils/tradingDay';
import { local_ip } from '../../constant';
import { parseMoneyValue, formatDisplayTime, aggregateFundByInterval } from '../../utils/fundAggregation';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import StockKLineModal from '../../components/StockKLineModal';
import StrategyRuleModal from '../../components/StrategyRuleModal';
import { createPortal } from 'react-dom';
import { useStrategyMode, useStrategyModes, setStrategyMode, getStrategyMode, STRATEGY_MODE_OPTIONS, MULTI_CHECKABLE_OPTIONS, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE, MODE_WASH_FUSION, MODE_MULTI, getStrategyModes, cacheStrategyModes, setStrategyModes } from '../../utils/strategyMode';
import { subscribeBuyPointPush, subscribeSellPointPush, subscribeWashFusionCandidatesPush, subscribeWashFusionBuyPush, fetchStrategyModes } from '../../utils/buyPointWs';
import ThemeColorModal from './components/ThemeColorModal';
import { DEFAULT_THEME_COLOR, buildDiyVars, hasDiyFields } from './utils/themeColor';
import { buildPackVars, getThemePacks, setRemoteThemePacks } from './utils/themePacks';
import './index.scss';

// 首屏「旧数据秒开」：各诊断模块把最近一次结果写入 localStorage，页面重新挂载时先用缓存渲染，
// 请求返回后覆盖；仅使用当日缓存，避免跨日展示过期榜单/诊断。
const readTodayLocalCache = (key) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || cached.date !== dayjs().format('YYYYMMDD')) return null;
    return cached.value;
  } catch {
    return null;
  }
};

const writeLocalCache = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify({ date: dayjs().format('YYYYMMDD'), value, ts: Date.now() }));
  } catch {
    // localStorage 写入失败（容量/隐私模式）时忽略，不影响主流程
  }
};

// 手动刷新的最短 loading 展示时长：后端命中缓存时可能几十毫秒返回，不加下限用户会以为没触发
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ==================== 网络检测轮询 ====================
// 每 3s 探测一次外网（百度），单次请求超过 1s 未返回即判定为网络差/断网，
// 由「正常」转为「异常」时通过浏览器通知提醒（持续断网不重复弹窗，恢复后再次异常会重新提醒）
// 说明：用图片探测而非 fetch —— 图片加载不受跨域限制（fetch 抓百度首页 HTML 会被浏览器
//       跨域保护 ORB 拦截而恒定失败），且只能用图片类资源：把 HTML 页面当图片加载必然报错。
//       故探测百度静态图片资源（favicon，同属百度域名：www.baidu.com）
const NET_PROBE_URL = 'https://www.baidu.com/favicon.ico';
const NET_PROBE_INTERVAL_MS = 3000;
const NET_PROBE_TIMEOUT_MS = 1000;

// 单次探测：图片 onload 视为网络正常；onerror / 1s 超时视为网络异常
const probeNetworkOnce = () => new Promise((resolve) => {
  const img = new Image();
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    img.onload = null;
    img.onerror = null;
    resolve(ok);
  };
  const timer = setTimeout(() => finish(false), NET_PROBE_TIMEOUT_MS);
  img.onload = () => finish(true);
  img.onerror = () => finish(false);
  img.src = `${NET_PROBE_URL}?t=${Date.now()}`;
});

const useNetworkWatch = () => {
  const offlineRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // 提前申请通知权限，保证检测到断网时能立即弹出提醒
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { });
    }

    const notifyOffline = () => {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        new Notification('网络异常', { body: '当前网络较差，请检查网络状况' });
      } catch (e) {
        // 通知发送失败不影响后续轮询
      }
    };

    const probe = async () => {
      const ok = await probeNetworkOnce();
      if (cancelled) return;
      if (!ok && !offlineRef.current) notifyOffline();
      offlineRef.current = !ok;
    };

    probe();
    const interval = setInterval(probe, NET_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
};

// 是否已收盘（统一来自 utils/tradingDay，非交易日视为已收盘，交易日 9:15 前或 14:59 及以后）

const formatSignedPercent = (value) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const formatMinute = (minute) => {
  const m = Number(minute);
  if (!Number.isFinite(m)) return '';
  const h = Math.floor(m / 100);
  const min = m % 100;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

// 判断数据中是否包含 11:30 之后的时间点，用于决定是否按1分钟聚合
const shouldAggregateByOneMin = (rawData) => {
  if (!rawData || rawData.length === 0) return false;
  return rawData.some(item => {
    const timeStr = Array.isArray(item) ? item[0] : (item.rawTime || item.time);
    if (!timeStr || timeStr.length < 4) return false;
    const h = parseInt(timeStr.substring(0, 2));
    const m = parseInt(timeStr.substring(2, 4));
    return h > 11 || (h === 11 && m >= 30);
  });
};

// ==================== 模块（供其他页面复用，未在本页渲染） ====================
// 开盘拉升 vs 下跌 + 斜率前5
export const OpeningSurgeModule = ({ stockList }) => {
  const { surgeList, declineList, surgeCount, declineCount } = useMemo(() => {
    const all = [];
    let surgeCount = 0;
    let declineCount = 0;
    (Array.isArray(stockList) ? stockList : []).forEach((item) => {
      const openPx = parseFloat(item.open_px);
      const closePx = parseFloat(item.close_px);
      const change = parseFloat(item.change);
      if (!Number.isFinite(openPx) || !Number.isFinite(closePx) || openPx <= 0) return;
      const curChange = Number.isFinite(change) ? change : 0;
      // 涨幅差 = 当前涨幅 - 开盘涨幅
      // 开盘涨幅 = (开盘价 - 昨收) / 昨收 * 100
      // 昨收 = 当前价 / (1 + 当前涨幅/100)
      const prevClose = curChange !== 0 ? closePx / (1 + curChange / 100) : closePx;
      const openChange = prevClose > 0 ? ((openPx - prevClose) / prevClose) * 100 : 0;
      const changeDiff = curChange - openChange;
      // 价差用于排序
      const slope = closePx - openPx;
      all.push({
        name: item.name || item.stockName,
        code: item.code,
        change: curChange,
        changeDiff,
        openChange,
        openPx,
        closePx,
      });
      if (slope >= 0) surgeCount++;
      else declineCount++;
    });
    // 按涨幅差排序：最高前5从高到低，最低前5从低到高
    const sorted = [...all].sort((a, b) => b.changeDiff - a.changeDiff);
    return {
      surgeList: sorted.slice(0, 5),
      declineList: sorted.slice(-5).reverse(),
      surgeCount,
      declineCount,
    };
  }, [stockList]);

  return (
    <div className="ob-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <RocketOutlined className="ob-module-icon" />
          <span>开盘攻防</span>
        </div>
        <div className="ob-count-pair">
          <span className="ob-up ob-count-num">拉升 {surgeCount}</span>
          <span className="ob-vs">vs</span>
          <span className="ob-down ob-count-num">下跌 {declineCount}</span>
        </div>
      </div>
      <div className="ob-slope-body">
        <div className="ob-slope-col">
          <div className="ob-slope-col-title ob-up">
            <RiseOutlined /> 拉升斜率最高前5
          </div>
          <div className="ob-slope-head">
            <span></span>
            <span>股票</span>
            <span>涨幅</span>
            <span>涨幅差</span>
            <span>开盘涨幅</span>
          </div>
          {surgeList.length === 0 ? (
            <div className="ob-empty-mini">暂无数据</div>
          ) : surgeList.map((s, idx) => (
            <div className="ob-slope-row" key={`s-${s.code}-${idx}`}>
              <span className={`ob-rank ${idx < 3 ? 'ob-rank-top' : ''}`}>{idx + 1}</span>
              <span className="ob-stock-name">{s.name}</span>
              <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.changeDiff >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.changeDiff >= 0 ? '+' : ''}{s.changeDiff.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.openChange >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.openChange >= 0 ? '+' : ''}{s.openChange.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
        <div className="ob-slope-divider" />
        <div className="ob-slope-col">
          <div className="ob-slope-col-title ob-down">
            <FallOutlined /> 拉升斜率最低前5
          </div>
          <div className="ob-slope-head">
            <span></span>
            <span>股票</span>
            <span>涨幅</span>
            <span>涨幅差</span>
            <span>开盘涨幅</span>
          </div>
          {declineList.length === 0 ? (
            <div className="ob-empty-mini">暂无数据</div>
          ) : declineList.map((s, idx) => (
            <div className="ob-slope-row" key={`d-${s.code}-${idx}`}>
              <span className="ob-rank">{idx + 1}</span>
              <span className="ob-stock-name">{s.name}</span>
              <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.changeDiff >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.changeDiff >= 0 ? '+' : ''}{s.changeDiff.toFixed(2)}%
              </span>
              <span className={`ob-change-cell ${s.openChange >= 0 ? 'ob-up' : 'ob-down'}`}>
                {s.openChange >= 0 ? '+' : ''}{s.openChange.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// 开盘攻防统计
export const WatchlistUpDownModule = ({ stockList }) => {
  const {
    surgeCount, declineCount, surgePercent, declinePercent,
    posCount, negCount, posPercent, negPercent,
    avgSurge, avgDecline,
  } = useMemo(() => {
    let surgeCount = 0;
    let declineCount = 0;
    let surgeSum = 0;
    let declineSum = 0;
    let posCount = 0;
    let negCount = 0;
    (Array.isArray(stockList) ? stockList : []).forEach((item) => {
      const openPx = parseFloat(item.open_px);
      const closePx = parseFloat(item.close_px);
      const change = parseFloat(item.change);
      if (!Number.isFinite(openPx) || !Number.isFinite(closePx) || openPx <= 0) return;
      const curChange = Number.isFinite(change) ? change : 0;
      // 涨幅差 = 当前涨幅 - 开盘涨幅（百分比）
      // 昨收 = 当前价 / (1 + 当前涨幅/100)
      const prevClose = curChange !== 0 ? closePx / (1 + curChange / 100) : closePx;
      const openChange = prevClose > 0 ? ((openPx - prevClose) / prevClose) * 100 : 0;
      const changeDiff = curChange - openChange;
      // 开盘拉升/下跌：基于涨幅差
      if (changeDiff >= 0) { surgeCount++; surgeSum += changeDiff; }
      else { declineCount++; declineSum += changeDiff; }
      // 开盘涨幅为正/负：基于 change 字段
      if (curChange > 0) posCount++;
      else if (curChange < 0) negCount++;
    });
    const total = surgeCount + declineCount;
    return {
      surgeCount,
      declineCount,
      surgePercent: total > 0 ? (surgeCount / total) * 100 : 0,
      declinePercent: total > 0 ? (declineCount / total) * 100 : 0,
      posCount,
      negCount,
      posPercent: total > 0 ? (posCount / total) * 100 : 0,
      negPercent: total > 0 ? (negCount / total) * 100 : 0,
      avgSurge: surgeCount > 0 ? surgeSum / surgeCount : 0,
      avgDecline: declineCount > 0 ? declineSum / declineCount : 0,
    };
  }, [stockList]);

  return (
    <div className="ob-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <StockOutlined className="ob-module-icon" />
          <span>开盘统计</span>
        </div>
      </div>
      <div className="ob-stat-body">
        <div className="ob-stat-row">
          <div className="ob-stat-label">开盘拉升 vs 开盘下跌</div>
          <div className="ob-stat-pair">
            <span className="ob-up"><em>{surgePercent.toFixed(0)}%</em><small>{surgeCount}只</small></span>
            <span className="ob-vs">vs</span>
            <span className="ob-down"><em>{declinePercent.toFixed(0)}%</em><small>{declineCount}只</small></span>
          </div>
        </div>
        <div className="ob-stat-row">
          <div className="ob-stat-label">涨幅为正 vs 为负</div>
          <div className="ob-stat-pair">
            <span className="ob-up"><em>{posPercent.toFixed(0)}%</em><small>{posCount}只</small></span>
            <span className="ob-vs">vs</span>
            <span className="ob-down"><em>{negPercent.toFixed(0)}%</em><small>{negCount}只</small></span>
          </div>
        </div>
        <div className="ob-stat-row">
          <div className="ob-stat-label">平均拉升 vs 平均下跌</div>
          <div className="ob-stat-pair">
            <span className="ob-up">
              {surgeCount > 0 ? `+${avgSurge.toFixed(2)}%` : '--'}
            </span>
            <span className="ob-vs">vs</span>
            <span className="ob-down">
              {declineCount > 0 ? `${avgDecline.toFixed(2)}%` : '--'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ==================== 主力资金 & 成交量（左列窄容器适配） ====================
const FundChartModule = () => {
  // 首屏秒开：先用当日 localStorage 缓存渲染，接口返回后覆盖（后端 getAmountHistory 读本地 JSON 本应很快，
  // 但首次渲染要等接口往返；加缓存后刷新即显）
  const FUND_CACHE_KEY = 'ob_fund_amount_cache';
  const [data, setData] = useState(() => readTodayLocalCache(FUND_CACHE_KEY) || []);
  // 默认只看变化（筛选掉 diff === 0 的条目），不再提供开关
  const [fiveMinAggEnabled, setFiveMinAggEnabled] = useState(true);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const volumeChartContainerRef = useRef(null);
  const volumeChartRef = useRef(null);

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/amount_history`);
      const fresh = response.data || [];
      setData(fresh);
      writeLocalCache(FUND_CACHE_KEY, fresh);
    } catch (err) {
      console.error('Fetch main fund data failed:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchData, 3000);
    return () => timers.forEach(clearTimeout);
  }, []);

  // 图表数据：始终按 5min 聚合
  const todayChartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return aggregateFundByInterval(data, 5);
  }, [data]);

  // 表格数据：根据开关决定是否聚合（保持原始数据逻辑）
  const todayTableData = useMemo(() => {
    if (!data || data.length === 0) return [];
    if (fiveMinAggEnabled) {
      return aggregateFundByInterval(data, 5);
    }
    // 过了11:30后按1分钟聚合，避免数据过多展示不下
    if (shouldAggregateByOneMin(data)) {
      return aggregateFundByInterval(data, 1);
    }
    const sorted = [...data].sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.map(([timeStr, item]) => ({
      time: timeStr,
      displayTime: formatDisplayTime(timeStr),
      mainMoney: parseMoneyValue(item.mainMoney),
      amountChangeDiff: parseMoneyValue(item.amountChangeDiff),
      rawTime: timeStr,
    }));
  }, [data, fiveMinAggEnabled]);

  const renderChartToContainers = useCallback((chartData, mainContainer, volContainer) => {
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }
    if (volumeChartRef.current) { volumeChartRef.current.remove(); volumeChartRef.current = null; }
    if (!mainContainer) return;

    const sortedData = chartData && chartData.length > 0
      ? [...chartData].sort((a, b) => {
        const ta = a.rawTime || a.time;
        const tb = b.rawTime || b.time;
        return ta.localeCompare(tb);
      })
      : [];

    const today = dayjs().format('YYYY-MM-DD');

    const baseOpts = {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: 'rgba(255,255,255,0.75)', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.09)' }, horzLines: { color: 'rgba(255,255,255,0.09)' } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(255,255,255,0.18)',
        tickMarkFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
      localization: {
        timeFormatter: (time) => {
          return dayjs.unix(time).format('HH:mm');
        },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.18)', autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
      handleScroll: false,
      handleScale: false,
    };

    const chart = createChart(mainContainer, { ...baseOpts, width: mainContainer.clientWidth, height: mainContainer.clientHeight });
    chartRef.current = chart;

    // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
    const dummySeries = chart.addLineSeries({
      color: 'transparent',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // 生成全天的时间点 (09:30-11:30, 13:00-15:00)
    const allTimePoints = [];

    // 上午 09:30 - 11:30
    let curr = dayjs(`${today} 09:30`);
    const amEnd = dayjs(`${today} 11:30`);
    while (curr.isBefore(amEnd) || curr.isSame(amEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    // 下午 13:00 - 15:00
    curr = dayjs(`${today} 13:00`);
    const pmEnd = dayjs(`${today} 15:00`);
    while (curr.isBefore(pmEnd) || curr.isSame(pmEnd)) {
      allTimePoints.push(curr.unix());
      curr = curr.add(1, 'minute');
    }

    // 填充隐藏系列，确保 X 轴拥有全天所有的"坑位"
    dummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));

    const series = chart.addAreaSeries({
      lineColor: '#a5b4fc', topColor: 'rgba(165, 180, 252, 0.45)', bottomColor: 'rgba(165, 180, 252, 0.02)',
      lineWidth: 2.5, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const cData = sortedData.map((item) => {
      const timeStr = item.rawTime || item.time;
      const hh = timeStr.substring(0, 2);
      const mm = timeStr.substring(2, 4);
      const ss = timeStr.substring(4, 6);
      return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: parseMoneyValue(item.mainMoney) };
    });
    series.setData(cData);
    series.createPriceLine({ price: -100, color: 'rgba(255,255,255,0.35)', lineStyle: LineStyle.Dashed });
    if (cData.length > 0) chart.timeScale().fitContent();

    if (volContainer) {
      const volumeChart = createChart(volContainer, { ...baseOpts, width: volContainer.clientWidth, height: volContainer.clientHeight });
      volumeChartRef.current = volumeChart;

      // 添加一个隐藏的辅助系列，用于锁定 X 轴范围从 09:30 到 15:00
      const volDummySeries = volumeChart.addLineSeries({
        color: 'transparent',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      // 填充隐藏系列，确保 X 轴拥有全天所有的"坑位"
      volDummySeries.setData(allTimePoints.map(t => ({ time: t, value: 0 })));

      const volumeSeries = volumeChart.addAreaSeries({
        lineColor: '#67e8f9', topColor: 'rgba(103, 232, 249, 0.4)', bottomColor: 'rgba(103, 232, 249, 0.02)',
        lineWidth: 2.5, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      const vData = sortedData.map((item) => {
        const timeStr = item.rawTime || item.time;
        const hh = timeStr.substring(0, 2);
        const mm = timeStr.substring(2, 4);
        const ss = timeStr.substring(4, 6);
        return { time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(), value: parseMoneyValue(item.amountChangeDiff) };
      });
      volumeSeries.setData(vData);
      if (vData.length > 0) volumeChart.timeScale().fitContent();
    }
  }, []);

  useEffect(() => {
    if (chartContainerRef.current) {
      renderChartToContainers(todayChartData, chartContainerRef.current, volumeChartContainerRef.current);
    }
  }, [todayChartData, renderChartToContainers]);

  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      if (volumeChartRef.current && volumeChartContainerRef.current) volumeChartRef.current.applyOptions({ width: volumeChartContainerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const renderTableData = () => {
    if (!todayTableData || todayTableData.length === 0) return null;
    const sorted = [...todayTableData].sort((a, b) => (b.rawTime || b.time).localeCompare(a.rawTime || a.time));
    return sorted.map((item, index) => {
      const timeStr = item.rawTime || item.time;
      const mainMoney = parseMoneyValue(item.mainMoney);
      // 与盯盘页口径一致：增量 = 本桶累计值 − 相邻上一桶（更早）累计值
      const prevItem = index + 1 < sorted.length ? sorted[index + 1] : null;
      const diff = prevItem ? mainMoney - parseMoneyValue(prevItem.mainMoney) : 0;
      if (!fiveMinAggEnabled && diff === 0) return null;
      const dt = item.displayTime || formatDisplayTime(timeStr);
      const isBigOutflow = diff <= -4;
      const isBigInflow = diff >= 4;
      return (
        <div key={timeStr} className={`data-item ${mainMoney >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow' : ''} ${isBigInflow ? 'big-inflow' : ''}`}>
          <span className="item-time">{dt}</span>
          <span className={`item-value ${mainMoney >= 0 ? 'up' : 'down'}`}>
            {mainMoney >= 0 ? '+' : ''}{mainMoney.toFixed(2)}
            {diff !== 0 && (
              <span className={`item-diff ${diff >= 0 ? 'up' : 'down'} ${isBigOutflow ? 'big-outflow-text' : ''} ${isBigInflow ? 'big-inflow-text' : ''}`}>
                {diff >= 0 ? '+' : ''}{diff.toFixed(2)}
              </span>
            )}
          </span>
        </div>
      );
    });
  };

  const latestToday = todayChartData.length ? todayChartData[todayChartData.length - 1] : null;
  const latestMainMoney = latestToday ? latestToday.mainMoney : null;
  const latestVolume = latestToday ? latestToday.amountChangeDiff : null;

  return (
    <div className="ob-module ob-fund-module">
      {/* 第一行：主力资金 + 资金明细 + 成交量（三列同行） */}
      <div className="ob-fund-row">
        <div className="ob-fund-chart-card ob-fund-chart-main">
          <div className="ob-fund-chart-header">
            <span className="ob-fund-chart-title">主力资金</span>
            <span className="ob-fund-chart-value" style={{ color: '#fde68a' }}>
              {latestMainMoney !== null && latestMainMoney !== undefined ? `${latestMainMoney >= 0 ? '+' : ''}${latestMainMoney.toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="ob-fund-chart-body">
            <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
        <div className="ob-fund-detail">
          <div className="ob-fund-detail-header">
            <span className="ob-fund-detail-title">资金数据</span>
            <div className="ob-fund-filter-row">
              <label className="ob-fund-switch-label">
                <AntSwitch size="small" checked={fiveMinAggEnabled} onChange={setFiveMinAggEnabled} />
                <span>5min</span>
              </label>
            </div>
          </div>
          <div className="ob-fund-table-wrapper">
            {renderTableData()}
          </div>
        </div>
        <div className="ob-fund-chart-card ob-fund-chart-volume">
          <div className="ob-fund-chart-header">
            <span className="ob-fund-chart-title">成交量</span>
            <span className="ob-fund-chart-value" style={{ color: '#a5f3fc' }}>
              {latestVolume !== null && latestVolume !== undefined ? `${latestVolume >= 0 ? '+' : ''}${latestVolume.toFixed(2)}` : '-'}
            </span>
          </div>
          <div className="ob-fund-chart-body">
            <div ref={volumeChartContainerRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ==================== 持仓股分时图 ====================
const PositionIntradayChart = ({ name, code, preclose, line }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  const data = useMemo(() => {
    if (!Array.isArray(line) || line.length === 0) return [];
    return line
      .filter((item) => {
        const v = parseFloat(item.last_px);
        if (!Number.isFinite(v) || v <= 0) return false;
        const m = Number(item.minute);
        return !(m > 1130 && m < 1300); // 过滤午休 11:30-13:00
      })
      .map((item, idx) => ({
        time: idx,
        value: parseFloat(item.last_px),
        label: formatMinute(item.minute),
      }));
  }, [line]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || data.length === 0) return;

    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: 'rgba(255,255,255,0.75)', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.08)' }, horzLines: { color: 'rgba(255,255,255,0.08)' } },
      width: container.clientWidth,
      height: container.clientHeight,
      timeScale: {
        visible: true,
        borderColor: 'rgba(255,255,255,0.18)',
        tickMarkFormatter: (time) => data[time]?.label || '',
      },
      localization: {
        timeFormatter: (time) => data[time]?.label || '',
        priceFormatter: (price) => {
          if (price === undefined || price === null) return '-';
          // 右侧坐标轴展示相对昨收的涨幅百分比
          if (preclose > 0) {
            const pct = ((price - preclose) / preclose) * 100;
            return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
          }
          return price.toFixed(2);
        },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.18)', autoScale: true, scaleMargins: { top: 0.1, bottom: 0.1 } },
      handleScroll: false,
      handleScale: false,
    });

    const lastVal = data[data.length - 1].value;
    // 渐变卡内统一用浅青色线条，保证在紫蓝背景上清晰可见
    const lineColor = '#67e8f9';
    const lineSeries = chart.addLineSeries({
      color: lineColor,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    lineSeries.setData(data.map((d) => ({ time: d.time, value: d.value })));

    if (preclose > 0) {
      const baseline = chart.addLineSeries({
        color: 'rgba(255,255,255,0.4)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      baseline.setData(data.map((d) => ({ time: d.time, value: preclose })));
    }

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({ fixLeftEdge: true, fixRightEdge: true, rightOffset: 0 });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (chartRef.current && container) {
        chartRef.current.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, preclose]);

  const lastVal = data.length > 0 ? data[data.length - 1].value : null;
  const changePct = preclose > 0 && lastVal !== null ? ((lastVal - preclose) / preclose) * 100 : null;

  return (
    <div className="ob-intraday-chart-card">
      <div className="ob-intraday-chart-header">
        <span className="ob-intraday-chart-name">{name}</span>
        <span className="ob-intraday-chart-code">{code}</span>
        <span className="ob-intraday-chart-change" style={{ color: '#a5f3fc' }}>
          {formatSignedPercent(changePct)}
        </span>
      </div>
      <div ref={containerRef} className="ob-intraday-chart-body" />
    </div>
  );
};

const PositionIntradayModule = ({ expanded, onToggleExpanded }) => {
  // 首屏秒开：持仓列表 + 每只的分时线分别缓存到 localStorage
  // 原来的串行加载链：positions 接口 → 对每只持仓发 /stock_tline_data → 渲染
  // 现在先从缓存秒出，接口回来后覆盖
  const POS_CACHE_KEY = 'ob_position_list_cache';
  const TL_CACHE_PREFIX = 'ob_position_tline_cache_';
  const [positions, setPositions] = useState(() => readTodayLocalCache(POS_CACHE_KEY) || []);
  const [tlineMap, setTlineMap] = useState(() => {
    try {
      const cachedPositions = readTodayLocalCache(POS_CACHE_KEY) || [];
      const map = {};
      cachedPositions.forEach((p) => {
        const cachedTL = readTodayLocalCache(TL_CACHE_PREFIX + p.code);
        if (cachedTL) map[p.code] = cachedTL;
      });
      return map;
    } catch {
      return {};
    }
  });

  const fetchPositions = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      const fresh = res.data || [];
      setPositions(fresh);
      writeLocalCache(POS_CACHE_KEY, fresh);
    } catch (err) {
      console.error('获取持仓失败:', err);
    }
  }, []);

  useEffect(() => {
    fetchPositions();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchPositions, 30000);
    return () => timers.forEach(clearTimeout);
  }, [fetchPositions]);

  useEffect(() => {
    if (positions.length === 0) {
      setTlineMap({});
      return;
    }
    let cancelled = false;
    const fetchTlines = async () => {
      try {
        const results = await Promise.all(
          positions.map(async (stock) => {
            try {
              const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: stock.code } });
              return { code: stock.code, data: res.data || {} };
            } catch (err) {
              return { code: stock.code, data: {} };
            }
          })
        );
        if (cancelled) return;
        const map = {};
        results.forEach((r) => {
          map[r.code] = r.data;
          if (r.data && r.data.line) writeLocalCache(TL_CACHE_PREFIX + r.code, r.data);
        });
        setTlineMap(map);
      } catch (err) {
        console.error('获取分时数据失败:', err);
      }
    };
    fetchTlines();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchTlines, 1000);
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [positions]);

  // 同一股票可能有多笔持仓（不同仓位/成本线），分时图按股票去重展示
  const uniquePositions = useMemo(() => {
    const seen = new Set();
    return positions.filter((p) => {
      if (seen.has(p.code)) return false;
      seen.add(p.code);
      return true;
    });
  }, [positions]);

  return (
    <div className="ob-module ob-intraday-module">
      <div className="ob-module-header">
        <div className="ob-module-title">
          <AreaChartOutlined className="ob-module-icon" />
          <span>持仓股分时图</span>
        </div>
        <div className="ob-intraday-header-actions">
          <span className="ob-total-tag">{uniquePositions.length} 只持仓</span>
        </div>
      </div>
      {positions.length === 0 ? (
        <div className="ob-intraday-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无持仓" />
        </div>
      ) : (
        <div className={`ob-intraday-grid ${uniquePositions.length >= 2 ? 'two' : 'single'}`}>
          {uniquePositions.map((stock) => (
            <PositionIntradayChart
              key={stock.code}
              name={stock.name}
              code={stock.code}
              preclose={parseFloat(tlineMap[stock.code]?.preclose_px) || 0}
              line={tlineMap[stock.code]?.line}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ==================== 自选股 3 日涨幅前五（创业板+主板 / 科创板 上下分行） ====================
const formatSlope = (v) => (
  v === null || v === undefined || Number.isNaN(Number(v))
    ? '--'
    : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}°`
);

// 指数 3 日线斜率状态文案：正斜率披露由负转正第几天，负斜率披露由正转负第几天
const slopeTurnText = (gate) => {
  if (!gate || gate.slope === null || gate.slope === undefined) return '指数 3 日线斜率数据不足';
  const slope = Number(gate.slope);
  if (slope >= 0) {
    if (gate.turnedPosToday) return '指数今日由负转正';
    const d = gate.daysSinceTurnPos;
    if (d === null || d === undefined) return '指数处于正斜率区间';
    return d === 0 ? '指数今日由负转正' : `指数由负转正第 ${d} 天`;
  }
  if (gate.turnedNegToday) return '指数今日由正转负';
  const d = gate.daysSinceTurnNeg;
  if (d === null || d === undefined) return '指数处于负斜率区间';
  return d === 0 ? '指数今日由正转负' : `指数由正转负第 ${d} 天`;
};

// ==================== 多选模式弹窗 ====================
// 勾选当下需要同时使用的策略模式，保存后缓存到后端（strategy_mode.json），
// 后端买点诊断按全部勾选模式并行执行；卖点诊断不受影响（按每笔持仓自身策略独立诊断）
const MultiModeModal = ({ open, onClose, onSaved }) => {
  const [checked, setChecked] = useState([]);
  const [saving, setSaving] = useState(false);

  // 打开时回显：优先后端持久化配置，失败回退本地缓存
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchStrategyModes().then((modes) => {
      if (!alive) return;
      setChecked(cacheStrategyModes(modes || getStrategyModes()));
    });
    return () => { alive = false; };
  }, [open]);

  const toggleMode = (value, isChecked) => {
    setChecked((prev) => (isChecked ? [...prev, value] : prev.filter((m) => m !== value)));
  };

  const handleSave = async () => {
    if (checked.length === 0) {
      message.warning('请至少勾选一种模式');
      return;
    }
    setSaving(true);
    try {
      const list = setStrategyModes(checked); // 本地缓存 + 广播 + POST /set_strategy_modes 缓存到后端
      setStrategyMode(MODE_MULTI); // 下拉显示「多选模式」；后端多选列表已由上一行单独缓存
      message.success(`多选模式已保存：同时诊断 ${list.length} 种模式（${list.map((m) => STRATEGY_MODE_OPTIONS.find((o) => o.value === m)?.label || m).join('、')}）`);
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="多选模式 · 勾选需要同时诊断的策略"
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: checked.length === 0 }}
      width={440}
      destroyOnClose
    >
      <div style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginBottom: 12 }}>
        保存后缓存到后端：以后买点诊断统计会同时按勾选的全部模式并行执行；卖点诊断仍按每笔持仓自身所属模式独立进行。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {MULTI_CHECKABLE_OPTIONS.map((o) => (
          <Checkbox
            key={o.value}
            checked={checked.includes(o.value)}
            onChange={(e) => toggleMode(o.value, e.target.checked)}
          >
            {o.label}
          </Checkbox>
        ))}
      </div>
    </Modal>
  );
};

// 单个模式的股票列表模块（按传入 mode 独立取数 / 渲染）：
//   tech_attack            → 科技进攻 · 3日涨幅榜
//   hot_money_extreme_win  → 情绪游资-极致胜率 · 龙头列表（顺周期 + 逆周期）
//   attack_defense         → 攻防兼备 · 涨幅榜 / 龙头列表（双列并示）
//   wash_fusion_extreme_odds → 情绪游资-极致赔率 · 首板/二板候选池
// 多选模式下由 TopChange3dModule 按勾选列表逐个渲染本模块（showModeSwitch 仅首个模块展示模式下拉）
// 开盘实战模式 → 回测页策略 id（策略说明弹窗复用回测页内容，2026-11-04）
const HELP_STRATEGY_MAP = {
  tech_attack: 'highest_3d_gain',
  attack_defense: 'highest_3d_gain',
  hot_money_extreme_win: 'hot_money_extreme_win',
  wash_fusion_extreme_odds: 'wash_fusion_extreme_odds',
};

// 两组候选列表的展示顺序（2026-11-04 用户要求）：
//   某组为空 → 空组排最后，有内容的排最前；
//   两组都有内容 → 数量少的一组排最前。
// 返回 [A 组 order, B 组 order]（flex order 值，1 在前 2 在后）
const computeGroupOrders = (aCount, bCount) => {
  if (aCount === 0 && bCount === 0) return [1, 2];
  if (aCount === 0) return [2, 1];
  if (bCount === 0) return [1, 2];
  return aCount <= bCount ? [1, 2] : [2, 1];
};

const ModeStockModule = ({ mode: modeProp, buyPointHit = false, showModeSwitch = true, multiLabel = '' }) => {
  const mode = modeProp;
  const isExtreme = mode === MODE_EXTREME_WIN;
  const isDefense = mode === MODE_ATTACK_DEFENSE;
  const isWashFusion = mode === MODE_WASH_FUSION;
  // 策略说明弹窗：当前打开的说明所对应的回测策略 id（null 表示关闭）
  const [helpStrategy, setHelpStrategy] = useState(null);
  const rankCacheKey = `ob_rank3_cache_${mode}`;
  const cachedRank = useMemo(() => readTodayLocalCache(rankCacheKey), [rankCacheKey]);
  // 记录当前 data 对应的策略模式，避免切换模式时把旧模式数据写进新模式缓存
  const dataModeRef = useRef(cachedRank ? mode : null);
  // 首屏优先用当日缓存渲染，接口返回后再覆盖，避免每次进入页面都先白屏等待
  const [data, setData] = useState(cachedRank?.data || null);        // 科技进攻：自选股 3 日涨幅榜
  const [leaderData, setLeaderData] = useState(cachedRank?.leaderData || null); // 情绪游资-极致胜率：龙头列表
  // 点击股票名称打开 K 线弹窗
  const [selectedStock, setSelectedStock] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);
  // 卡片右上角手动刷新：强制重拉涨幅榜 + 龙头列表（含指数斜率），不用缓存
  const [refreshing, setRefreshing] = useState(false);
  // 只看符合条件：开启后仅展示完全符合条件的个股（后端 qualifiedTop，按 3 日涨幅降序），默认关闭
  const [onlyQualified, setOnlyQualified] = useState(true);
  // 显示涨幅开关（2026-11-03 用户要求）：默认关闭，隐藏候选列表中今日涨幅 / 3 日涨幅列
  const [showChange, setShowChange] = useState(false);
  // 涨幅列隐藏时同步收缩表格网格列数，保持单元格对齐
  const techGrid = showChange ? undefined : '22px minmax(0, 1fr) 54px';
  const ewGrid = showChange ? undefined : '22px minmax(0, 1fr) 54px 72px';
  const revGrid = showChange ? '22px minmax(0, 1fr) 58px 54px 44px' : '22px minmax(0, 1fr) 54px 44px';
  // 情绪游资-极致赔率：双候选池（首板起爆 / 二板起爆），首屏用当日缓存，后端 3s WS 推送实时刷新
  const [wfData, setWfData] = useState(() => readTodayLocalCache('ob_wash_fusion_cache') || null);
  const [wfRefreshing, setWfRefreshing] = useState(false);
  // 多选模式弹窗（2026-11-04 新增）：下拉选择「多选模式」时打开，勾选的模式列表缓存到后端
  const [multiModalOpen, setMultiModalOpen] = useState(false);
  // 模式下拉统一入口：选「多选模式」打开勾选弹窗（不动当前单模式）；其余照常切换单模式
  const handleModeSelect = useCallback((v) => {
    if (v === MODE_MULTI) {
      setMultiModalOpen(true);
      return;
    }
    setStrategyMode(v);
  }, []);
  const cybPassed = data?.cybGate?.passed === true;
  const starPassed = data?.starGate?.passed === true;

  // 挂载立即拉一次；交易时段每 5s 轮询，收盘后保留最后一次数据
  //   tech_attack            → /top_gainers_by_market（limit=10，每市场最多 10 只，合并后展示前十）
  //   hot_money_extreme_win  → /hot_money_leader_list（除 delta≥30 与上证斜率>0 外全部买点条件满足）
  //   attack_defense         → 两个接口同时拉（科技进攻 + 情绪游资双策略并示）
  const fetchStocks = useCallback(async (force = false) => {
    // 情绪游资-极致赔率：候选池来自 wash_fusion 专属接口与 WS，不拉涨幅榜/龙头列表
    if (isWashFusion) return;
    // force=true：手动刷新按钮传入，后端强制重算，绕过缓存直接拿最新数据
    const refreshFlag = force ? 1 : 0;
    // 攻防兼备需要同时拉两份数据，改为并行请求（原先串行等待两个接口，首屏耗时翻倍）
    const tasks = [];
    if (isExtreme || isDefense) {
      tasks.push(
        axios.post(`http://${local_ip}:3000/hot_money_leader_list`, { limit: 50, force: refreshFlag })
          .then((res) => {
            dataModeRef.current = mode;
            setLeaderData(res.data?.data || null);
          })
          .catch((err) => console.error('获取情绪游资龙头列表失败:', err))
      );
    }
    if (!isExtreme) {
      tasks.push(
        axios.post(`http://${local_ip}:3000/top_gainers_by_market`, { limit: 10, force: refreshFlag })
          .then((res) => {
            dataModeRef.current = mode;
            setData(res.data?.data || null);
          })
          .catch((err) => console.error('获取自选股 3 日涨幅榜失败:', err))
      );
    }
    await Promise.all(tasks);
  }, [mode, isExtreme, isDefense, isWashFusion]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await fetchStocks(true); } finally { setRefreshing(false); }
  }, [fetchStocks]);

  // 情绪游资-极致赔率：首次加载 / 手动刷新拉快照（含实时价/竞价/状态），之后由 WS 每 3s 覆盖
  const fetchWashFusion = useCallback(async (force = false) => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/wash_fusion_extreme_odds_snapshot`, {
        params: force ? { refresh: 1 } : {},
      });
      const d = res.data?.data;
      if (d) {
        setWfData(d);
        writeLocalCache('ob_wash_fusion_cache', d);
      }
    } catch (err) {
      console.error('获取情绪游资-极致赔率候选池失败:', err);
    }
  }, []);

  const handleWfRefresh = useCallback(async () => {
    setWfRefreshing(true);
    const startedAt = Date.now();
    try { await fetchWashFusion(true); } finally {
      // 保证刷新有可感知的 loading（后端缓存命中时可能几十毫秒返回）
      await sleep(Math.max(0, 500 - (Date.now() - startedAt)));
      setWfRefreshing(false);
    }
  }, [fetchWashFusion]);

  useEffect(() => {
    if (!isWashFusion) return undefined;
    fetchWashFusion();
    const unsub = subscribeWashFusionCandidatesPush((msg) => {
      if (!msg?.data) return;
      setWfData(msg.data);
      writeLocalCache('ob_wash_fusion_cache', msg.data);
    });
    return unsub;
  }, [isWashFusion, fetchWashFusion]);

  // 最近一次成功结果按「数据所属模式」写入 localStorage，供下次进入页面秒开
  useEffect(() => {
    if (!dataModeRef.current || (!data && !leaderData)) return;
    writeLocalCache(`ob_rank3_cache_${dataModeRef.current}`, { data, leaderData });
  }, [data, leaderData]);

  // 合并榜单：后端已按门槛筛选市场、按 3 日涨幅降序取前十，并补充 excludeReason（2026-10-22）
  const mergedList = useMemo(() => data?.mergedTop || [], [data]);
  // 只看符合条件榜单：后端全量扫描得到的完全符合条件个股，已按 3 日涨幅降序，首位即买点候选
  const qualifiedList = useMemo(() => data?.qualifiedTop || [], [data]);
  // 「只看符合条件」为空时回退展示完整榜单（2026-11-09 用户要求：即使没有符合条件的也能看到候选股列表）
  const onlyQualifiedEmpty = onlyQualified && qualifiedList.length === 0;
  // 科技进攻列当前展示的榜单（开关开启时切换到只看符合条件；为空则回退完整榜单）
  const techList = onlyQualifiedEmpty ? mergedList : (onlyQualified ? qualifiedList : mergedList);

  // 情绪游资龙头列表（后端已按 delta 降序返回全部达标股；attack_defense 模式下也计算，供顺周期列展示）
  const showEwCols = isExtreme || isDefense;
  const leaderList = useMemo(() => (showEwCols ? (leaderData?.stocks || []) : []), [showEwCols, leaderData]);
  // 逆周期（反向抱团龙头）：池全部 + 择时状态（列表下半部分）
  const reverse = leaderData?.reverse || null;
  const reverseList = useMemo(() => (showEwCols ? (reverse?.stocks || []) : []), [showEwCols, reverse]);
  // 顺周期 / 逆周期两组：为空者置后；两组都有内容时内容少的在前；
  // 任一组 ≤ 2 只时不做均分高度，直接由内容撑开（2026-11-04 用户要求）
  const [ewOrder, reverseOrder] = computeGroupOrders(leaderList.length, reverseList.length);
  const ewSplit = leaderList.length > 2 && reverseList.length > 2;
  const indexSlope = leaderData?.indexSlope;
  const slopeOk = indexSlope != null && Number(indexSlope) > 0;
  const reverseSlope = reverse?.slopeClose ?? null;
  const reverseSlopeOk = reverse?.eligible === true;

  useEffect(() => {
    fetchStocks();
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
    };
    if (!isAfterMarketClose()) schedulePoll(fetchStocks, 5000);
    return () => timers.forEach(clearTimeout);
  }, [fetchStocks]);

  // 全局唯一推荐标的：后端 pickCode（已应用市场门槛、3日涨幅过热剔除与「涨幅领先但当日爆发力不足」顺延）；
  // 未入选买点的原因见行内 excludeReason
  const globalPick = useMemo(() => {
    if (data?.pickCode) return mergedList.find(s => s.code === data.pickCode) || null;
    return mergedList.find(s => s.isCandidate) || null;
  }, [mergedList, data]);

  // ==================== 情绪游资-极致赔率：首板起爆 / 二板起爆 双列表 ====================
  if (isWashFusion) {
    const firstList = wfData?.firstBoard || [];
    const secondList = wfData?.secondBoard || [];
    // 首板 / 二板两组：为空者置后；两组都有内容时内容少的在前；
    // 任一组 ≤ 2 只时不做均分高度，直接由内容撑开（2026-11-04 用户要求）
    const [fbOrder, sbOrder] = computeGroupOrders(firstList.length, secondList.length);
    const wfSplit = firstList.length > 2 && secondList.length > 2;
    const rules = wfData?.rules || {};
    const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
      ? '--'
      : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
    const wfRow = (s, idx, keyPrefix) => (
      <div className="ob-gainer-row ob-gainer-row-wf ob-gainer-row-wf-nostatus" key={`${keyPrefix}-${s.code}-${idx}`}>
        <span className={`ob-rank ${idx < 3 ? 'ob-rank-' + (idx + 1) : ''}`}>{idx + 1}</span>
        <span className="ob-gainer-name-cell">
          <span
            className="ob-stock-name ob-stock-name-clickable"
            title="点击查看K线"
            onClick={() => { setSelectedStock({ code: s.code, stockName: s.name, change: s.change }); setKlineVisible(true); }}
          >{s.name}</span>
          <span className="ob-gainer-market cyb">{s.board ? `${s.board} 板` : '--'}</span>
          {s.status === 'auction_buy' || s.status === 'burst_buy'
            ? <span className="ob-gainer-buyflag">买点触发</span>
            : null}
          {s.status === 'limit_open' && <span className="ob-gainer-limitup">涨停</span>}
          {s.washout?.washDays != null && <span className="ob-gainer-reason">洗盘 {s.washout.washDays} 日</span>}
        </span>
        <span className={`ob-change-cell ${Number(s.change) >= 0 ? 'ob-up' : 'ob-down'}`}>
          {pct(s.change)}
        </span>
        <span className={`ob-change-cell ${Number(s.auctionGap) >= 0 ? 'ob-up' : 'ob-down'}`}>
          {pct(s.auctionGap)}
        </span>
        <span className="ob-gainer-resilience">
          {s.totalMvYi != null ? `${Number(s.totalMvYi).toFixed(2)}亿` : '--'}
        </span>
      </div>
    );

    return (
      <div className="ob-module ob-rank3-module">
        {wfRefreshing && (
          <div className="ob-refresh-mask">
            <Spin size="large" />
          </div>
        )}
        <div className="ob-module-header">
          <div className="ob-module-title" title="情绪游资-极致赔率 · 首板/二板候选池">
            <CrownOutlined className="ob-module-icon" />
            <span>情绪游资-极致赔率</span>
            <Tooltip title="策略说明">
              <QuestionCircleOutlined
                className="ob-help-icon"
                onClick={() => setHelpStrategy(HELP_STRATEGY_MAP[MODE_WASH_FUSION])}
              />
            </Tooltip>
          </div>
          <div className="ob-module-actions">
            {showModeSwitch && (
              <Select
                size="small"
                className="ob-mode-switch"
                value={mode}
                options={STRATEGY_MODE_OPTIONS}
                onSelect={handleModeSelect}
                popupMatchSelectWidth={false}
                style={{ fontSize: 12 }}
                title="切换策略模式"
                classNames={{ popup: { root: 'ob-mode-dropdown' } }}
              />
            )}
            <button className="ob-refresh-btn" onClick={handleWfRefresh} disabled={wfRefreshing} title="刷新候选池">
              <ReloadOutlined spin={wfRefreshing} />
            </button>
          </div>
        </div>
        <div className={`ob-gainer-body defense ${wfSplit ? 'split' : 'single'}`}>
          <div className="ob-gainer-col" style={{ order: fbOrder }}>
            <div className="ob-gainer-col-head">
              <span className="ob-gainer-section-label">首板起爆 · {firstList.length}</span>
              <span className="ob-total-tag">9:25-9:30 每 {rules.auctionRemindSeconds ?? 30}s 提醒</span>
            </div>
            <div className="ob-gainer-head ob-gainer-head-wf ob-gainer-head-wf-nostatus">
              <span>#</span>
              <span>股票</span>
              <span>当日</span>
              <span>竞价</span>
              <span>总市值</span>
            </div>
            {firstList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无首板起爆候选</div>
            ) : firstList.map((s, idx) => wfRow(s, idx, 'fb'))}
          </div>
          <div className="ob-gainer-col" style={{ order: sbOrder }}>
            <div className="ob-gainer-col-head">
              <span className="ob-gainer-section-label">二板起爆 · {secondList.length}</span>
              <span className="ob-total-tag">9:30-14:30 盘中 +{rules.buyTriggerPct ?? 8}% 触发</span>
            </div>
            <div className="ob-gainer-head ob-gainer-head-wf ob-gainer-head-wf-nostatus">
              <span>#</span>
              <span>股票</span>
              <span>当日</span>
              <span>竞价</span>
              <span>总市值</span>
            </div>
            {secondList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无二板起爆候选</div>
            ) : secondList.map((s, idx) => wfRow(s, idx, 'sb'))}
          </div>
        </div>
        <StockKLineModal
          visible={klineVisible}
          onCancel={() => setKlineVisible(false)}
          code={selectedStock?.code}
          stockInfo={{ name: selectedStock?.stockName, change: selectedStock?.change }}
        />
        {showModeSwitch && <MultiModeModal open={multiModalOpen} onClose={() => setMultiModalOpen(false)} />}
        <StrategyRuleModal
          open={!!helpStrategy}
          onClose={() => setHelpStrategy(null)}
          strategy={helpStrategy}
          label={STRATEGY_MODE_OPTIONS.find((o) => o.value === (helpStrategy === 'highest_3d_gain' ? 'tech_attack' : helpStrategy))?.label || ''}
        />
      </div>
    );
  }

  return (
    <div className="ob-module ob-rank3-module">
      <div className="ob-module-header">
        <div className="ob-module-title" title={
          isExtreme ? '情绪游资-极致胜率 · 龙头列表' : isDefense ? '攻防兼备 · 涨幅榜 / 龙头列表' : '自选股 · 3日涨幅前十'
        }>
          <CrownOutlined className="ob-module-icon" />
          <span>{multiLabel
            ? (isExtreme ? multiLabel : `${multiLabel} · ${isDefense ? '涨幅榜/龙头' : '3日涨幅前十'}`)
            : isExtreme ? '情绪游资-极致胜率' : isDefense ? '涨幅榜/龙头' : '自选股 · 3日涨幅前十'}</span>
          <Tooltip title="策略说明">
            <QuestionCircleOutlined
              className="ob-help-icon"
              onClick={() => setHelpStrategy(HELP_STRATEGY_MAP[mode])}
            />
          </Tooltip>
        </div>
        <div className="ob-module-actions">
          <label
            className="ob-gainer-filter-row"
            style={{ marginRight: 4, marginBottom: 0 }}
            title="开启后展示候选列表中的今日涨幅 / 3 日涨幅列"
          >
            <AntSwitch size="small" checked={showChange} onChange={setShowChange} />
            <span>显示涨幅</span>
          </label>
          {showModeSwitch && (
            <Select
              size="small"
              className="ob-mode-switch"
              value={mode}
              options={STRATEGY_MODE_OPTIONS}
              onSelect={handleModeSelect}
              popupMatchSelectWidth={false}
              style={{ fontSize: 12 }}
              title="切换策略模式"
              classNames={{ popup: { root: 'ob-mode-dropdown' } }}
            />
          )}
          <button className="ob-refresh-btn" onClick={handleRefresh} disabled={refreshing} title="刷新卡片数据">
            <ReloadOutlined spin={refreshing} />
          </button>
        </div>
      </div>
      {data?.gainTie && (
        <div className={`ob-gainer-gate-note ${data.gainTie.swapped ? 'both' : 'partial'}`}>
          {data.gainTie.swapped
            ? `3日涨幅第一名与第二名相差 ${Number(data.gainTie.gap).toFixed(2)} 个百分点（≤ ${data.gainTie.threshold}），按当日抗分歧优先：${data.gainTie.picked.stockName}（抗分歧 ${data.gainTie.picked.resilienceScore != null ? Number(data.gainTie.picked.resilienceScore).toFixed(2) : '--'}）优先于 ${data.gainTie.dropped.stockName}（抗分歧 ${data.gainTie.dropped.resilienceScore != null ? Number(data.gainTie.dropped.resilienceScore).toFixed(2) : '--'}）`
            : `3日涨幅第一名与第二名相差 ${Number(data.gainTie.gap).toFixed(2)} 个百分点（≤ ${data.gainTie.threshold}），但抗分歧分数缺失或第一名不低于第二名，保持原涨幅排名：${data.gainTie.picked.stockName} 优先于 ${data.gainTie.dropped.stockName}`}
        </div>
      )}
      <div className={`ob-gainer-body ${isDefense ? 'defense' : ''} ${isExtreme ? (ewSplit ? 'split' : 'single') : ''}`}>
        {/* 科技进攻列（tech_attack / attack_defense） */}
        {!isExtreme && (
          <div className="ob-gainer-col ob-gainer-col-tech">
            <div className="ob-gainer-col-head">
              {isDefense && <span className="ob-gainer-section-label">科技进攻 · {techList.length}</span>}
              {[
                { name: '创业板指', gate: data?.cybGate, passed: cybPassed },
                { name: '科创50', gate: data?.starGate, passed: starPassed },
              ].map(({ name, gate, passed }) => (
                <div key={name} className={`ob-gainer-gate ${passed ? 'passed' : 'failed'}`}>
                  <span className="ob-gainer-gate-slope">{name} {formatSlope(gate?.slope)}</span>
                  <span className="ob-gainer-gate-turn">{slopeTurnText(gate)}</span>
                  <span className="ob-gainer-gate-badge">{passed ? '满足买点门槛' : '不满足买点门槛'}</span>
                </div>
              ))}
            </div>
            <div className="ob-gainer-filter-row">
              <AntSwitch size="small" checked={onlyQualified} onChange={setOnlyQualified} />
              <span>只看符合条件{onlyQualifiedEmpty && mergedList.length > 0 ? '（无符合条件，已展示全部候选）' : ''}</span>
            </div>
            <div className="ob-gainer-head" style={{ gridTemplateColumns: techGrid }}>
              <>
                <span>#</span>
                <span>股票</span>
                {showChange && <span>当日</span>}
                <span>抗分歧</span>
                {showChange && <span>3日涨幅</span>}
              </>
            </div>
            {techList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">{onlyQualified && !onlyQualifiedEmpty ? '暂无完全符合条件的标的' : '暂无数据'}</div>
            ) : techList.map((s, idx) => {
              // 全部符合条件时买点候选必为 3 日涨幅第一名（idx 0）；否则以后端唯一推荐标的为准
              //（回退展示全部候选时不按 idx 0 标记，避免把不符合条件的个股误标为买点候选）
              const isPick = onlyQualified && !onlyQualifiedEmpty
                ? idx === 0
                : (globalPick != null && s.code === globalPick.code);
              return (
                <div className="ob-gainer-row" key={`${s.code}-${idx}`} style={{ gridTemplateColumns: techGrid }}>
                  <span className={`ob-rank ${idx < 3 ? 'ob-rank-' + (idx + 1) : ''}`}>{idx + 1}</span>
                  <span className="ob-gainer-name-cell">
                    <span
                      className="ob-stock-name ob-stock-name-clickable"
                      title="点击查看K线"
                      onClick={() => { setSelectedStock(s); setKlineVisible(true); }}
                    >{s.stockName}</span>
                    <span className={`ob-gainer-market ${s.isSh688 ? 'star' : 'cyb'}`}>{s.isSh688 ? '科创' : '创业/主板'}</span>
                    {s.isLimitUp && <span className="ob-gainer-limitup">涨停</span>}
                    {!isPick && s.excludeReason && s.excludeReason !== '涨停' && (
                      <span className="ob-gainer-reason">{s.excludeReason}</span>
                    )}
                    {isPick && <span className="ob-gainer-buyflag">{buyPointHit ? '买点触发' : '买点候选'}</span>}
                  </span>
                  {showChange && (
                    <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                      {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                    </span>
                  )}
                  <span className="ob-gainer-resilience">
                    {s.resilienceScore !== null && s.resilienceScore !== undefined ? Number(s.resilienceScore).toFixed(2) : '--'}
                  </span>
                  {showChange && (
                    <span className={`ob-change-cell ${s.change3d >= 0 ? 'ob-up' : 'ob-down'}`}>
                      {s.change3d !== null && s.change3d !== undefined ? `${s.change3d >= 0 ? '+' : ''}${Number(s.change3d).toFixed(2)}%` : '--'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* 顺周期列（hot_money_extreme_win / attack_defense） */}
        {showEwCols && (
          <div className="ob-gainer-col ob-gainer-col-ew" style={{ order: ewOrder }}>
            <div className="ob-gainer-col-head">
              <span className="ob-gainer-section-label">顺周期 · 情绪游资-极致胜率 {leaderList.length}</span>
              <div className={`ob-gainer-gate ${slopeOk ? 'passed' : 'failed'}`}>
                <span className="ob-gainer-gate-slope">上证指数 {formatSlope(indexSlope)}</span>
                <span className="ob-gainer-gate-turn">3 日线分时斜率</span>
                <span className="ob-gainer-gate-badge">{slopeOk ? '满足买点门槛' : '不满足买点门槛'}</span>
              </div>
            </div>
            <div className="ob-gainer-head" style={{ gridTemplateColumns: ewGrid }}>
              <>
                <span>#</span>
                <span>股票</span>
                {showChange && <span>当日</span>}
                <span>强度−差劲</span>
                <span>连板</span>
              </>
            </div>
            {leaderList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无数据</div>
            ) : leaderList.map((s, idx) => (
              <div className="ob-gainer-row" key={`${s.code}-${idx}`} style={{ gridTemplateColumns: ewGrid }}>
                <span className={`ob-rank ${idx < 3 ? 'ob-rank-' + (idx + 1) : ''}`}>{idx + 1}</span>
                <span className="ob-gainer-name-cell">
                  <span
                    className="ob-stock-name ob-stock-name-clickable"
                    title="点击查看K线"
                    onClick={() => { setSelectedStock({ code: s.code, stockName: s.stockName, change: s.change }); setKlineVisible(true); }}
                  >{s.stockName}</span>
                  {s.isLimitUp && <span className="ob-gainer-limitup">涨停</span>}
                  {s.buyPointHit && <span className="ob-gainer-buyflag">买点触发</span>}
                </span>
                {showChange && (
                  <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                    {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                  </span>
                )}
                <span className={`ob-gainer-resilience ${s.delta != null && s.delta >= 30 ? 'ob-up' : ''}`}>
                  {s.delta !== null && s.delta !== undefined ? Number(s.delta).toFixed(2) : '--'}
                </span>
                <span className="ob-gainer-resilience">
                  {s.lianbanCount != null ? `${s.lianbanCount} 连板` : '--'}
                </span>
              </div>
            ))}
          </div>
        )}
        {showEwCols && (
          <div className={`ob-gainer-col ob-gainer-col-reverse ${reverseSlopeOk ? 'active' : ''}`} style={{ order: reverseOrder }}>
            <div className="ob-gainer-col-head">
              <span className="ob-gainer-section-label reverse">逆周期 · 反向抱团 {reverseList.length}</span>
              <div className={`ob-gainer-gate ${reverseSlopeOk ? 'passed' : 'failed'}`}>
                <span className="ob-gainer-gate-slope">上证指数 {formatSlope(reverseSlope)}</span>
                <span className="ob-gainer-gate-turn">{reverse && reverse.slopeDayNo != null ? `连续为负第 ${reverse.slopeDayNo} 天` : '3 日线收盘口径斜率'}</span>
                <span className="ob-gainer-gate-badge">{reverseSlopeOk ? '逆周期窗口已开启' : '未进入逆周期窗口'}</span>
              </div>
            </div>
            <div className="ob-gainer-head ob-gainer-head-reverse" style={{ gridTemplateColumns: revGrid }}>
              <span>#</span>
              <span>股票</span>
              {showChange && <span>当日</span>}
              <span>强度−差劲</span>
              <span>连板</span>
            </div>
            {reverseList.length === 0 ? (
              <div className="ob-empty-mini ob-gainer-empty">暂无满足条件的反向抱团标的</div>
            ) : reverseList.map((s, idx) => (
              <div className="ob-gainer-row ob-gainer-row-reverse" key={`rev-${s.code}-${idx}`} style={{ gridTemplateColumns: revGrid }}>
                <span className={`ob-rank ${idx < 3 ? 'ob-rank-' + (idx + 1) : ''}`}>{idx + 1}</span>
                <span className="ob-gainer-name-cell">
                  <span
                    className="ob-stock-name ob-stock-name-clickable"
                    title="点击查看K线"
                    onClick={() => { setSelectedStock({ code: s.code, stockName: s.stockName, change: s.change }); setKlineVisible(true); }}
                  >{s.stockName}</span>
                  {s.isLimitUp && <span className="ob-gainer-limitup">涨停</span>}
                  {s.timingPassed && <span className="ob-gainer-buyflag">逆周期买点</span>}
                </span>
                {showChange && (
                  <span className={`ob-change-cell ${s.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                    {s.change !== null && s.change !== undefined ? `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)}%` : '--'}
                  </span>
                )}
                <span className={`ob-gainer-resilience ${s.delta != null && s.delta >= 30 ? 'ob-up' : ''}`}>
                  {s.delta !== null && s.delta !== undefined ? Number(s.delta).toFixed(2) : '--'}
                </span>
                <span className="ob-gainer-resilience">
                  {s.lianbanCount != null ? `${s.lianbanCount} 板` : '--'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <StockKLineModal
        visible={klineVisible}
        onCancel={() => setKlineVisible(false)}
        code={selectedStock?.code}
        stockInfo={{ name: selectedStock?.stockName, change: selectedStock?.change }}
      />
      {showModeSwitch && <MultiModeModal open={multiModalOpen} onClose={() => setMultiModalOpen(false)} />}
      <StrategyRuleModal
        open={!!helpStrategy}
        onClose={() => setHelpStrategy(null)}
        strategy={helpStrategy}
        label={STRATEGY_MODE_OPTIONS.find((o) => o.value === (helpStrategy === 'highest_3d_gain' ? 'tech_attack' : helpStrategy))?.label || ''}
      />
    </div>
  );
};

// ==================== 股票列表模块入口 ====================
// 单模式：按当前模式展示对应股票列表模块；
// 多选模式（2026-11-04 用户新增）：勾选的每个模式各渲染一个独立模块，全部同屏分模块展示
const TopChange3dModule = ({ buyPointHit }) => {
  const mode = useStrategyMode();
  const multiModes = useStrategyModes();
  const [multiModalOpen, setMultiModalOpen] = useState(false);
  const handleModeSelect = useCallback((v) => {
    if (v === MODE_MULTI) {
      setMultiModalOpen(true);
      return;
    }
    setStrategyMode(v);
  }, []);
  if (mode !== MODE_MULTI) {
    return <ModeStockModule mode={mode} buyPointHit={buyPointHit} />;
  }
  if (multiModes.length === 0) {
    return (
      <div className="ob-module ob-rank3-module">
        <div className="ob-module-header">
          <div className="ob-module-title">
            <CrownOutlined className="ob-module-icon" />
            <span>股票列表 · 多选模式</span>
          </div>
          <div className="ob-module-actions">
            <Select
              size="small"
              className="ob-mode-switch"
              value={mode}
              options={STRATEGY_MODE_OPTIONS}
              onSelect={handleModeSelect}
              popupMatchSelectWidth={false}
              style={{ fontSize: 12 }}
              title="切换策略模式"
              classNames={{ popup: { root: 'ob-mode-dropdown' } }}
            />
          </div>
        </div>
        <div className="ob-empty-mini" style={{ padding: '32px 0', textAlign: 'center' }}>
          尚未勾选任何策略模式，请点击右上角下拉选择「多选模式」勾选需要同时展示的模式
        </div>
        <MultiModeModal open={multiModalOpen} onClose={() => setMultiModalOpen(false)} />
      </div>
    );
  }
  return (
    <div className="ob-multi-modules">
      {multiModes.map((m, i) => (
        <ModeStockModule
          key={m}
          mode={m}
          buyPointHit={buyPointHit}
          showModeSwitch={i === 0}
          multiLabel={STRATEGY_MODE_OPTIONS.find((o) => o.value === m)?.label || ''}
        />
      ))}
    </div>
  );
};

// ==================== 买点诊断卡片（自动运行） ====================
// 命中弹窗已移除（2026-10-21 用户调整）：命中提醒改由 App.jsx 全局诊断卡片（GlobalDiagnosisAlert）负责，
// 本卡片仅负责诊断数据展示与命中状态上报

// 指定模式诊断结果的「命中」口径（与单模式一致）：攻防兼备任一策略命中即命中；
// 情绪游资-极致胜率逆周期（反向抱团）择时触发也算命中
const modeResultHit = (m, result) => {
  if (m === MODE_ATTACK_DEFENSE) {
    return result?.tech?.allPassed === true || result?.allPassed === true || result?.reverse?.allPassed === true;
  }
  if (m === MODE_EXTREME_WIN) {
    return result?.allPassed === true || result?.reverse?.allPassed === true;
  }
  return result?.allPassed === true;
};

// 单个模式的买点诊断展示视图（条件分组 / 命中口径 / 结论 / 建议仓位）：
// 单模式渲染一节；多选模式按勾选顺序逐模式各渲染一节（2026-11-04）
const buildBuyModeView = (m, d) => {
  const sortChecks = (list) => [...(list || [])].sort((a, b) => a.passed - b.passed);
  const isExtreme = m === MODE_EXTREME_WIN;
  const isDefense = m === MODE_ATTACK_DEFENSE;
  let checkGroups;
  if (isDefense) {
    const revItems = sortChecks(d?.reverseChecks || []);
    checkGroups = [
      { label: '科技进攻 · 快进快出', items: sortChecks(d?.tech?.checks || []) },
      { label: '顺周期 · 情绪游资-极致胜率', items: sortChecks(d?.checks || []) },
      ...(revItems.length > 0
        ? [{ label: '逆周期 · 反向抱团龙头', items: revItems, reverse: true }]
        : []),
    ];
  } else {
    const checks = sortChecks(d?.checks || []);
    const reverseChecks = isExtreme ? (d?.reverseChecks || []) : [];
    checkGroups = [
      { label: isExtreme ? '顺周期 · 情绪游资-极致胜率' : '', items: checks },
      ...(reverseChecks.length > 0
        ? [{ label: '逆周期 · 反向抱团龙头', items: sortChecks(reverseChecks), reverse: true }]
        : []),
    ];
  }
  // 顺周期前置全部通过（attack_defense 时 data 顶层即情绪游资顺周期结果）
  const allPassed = d?.allPassed === true;
  // 科技进攻全部通过（tech_attack 时即 allPassed；attack_defense 时读 tech 嵌套）
  const techAllPassed = isDefense ? d?.tech?.allPassed === true : allPassed;
  const hit = isDefense
    ? (techAllPassed || allPassed || d?.reverse?.allPassed === true)
    : allPassed;
  // 建议买入仓位提示（与回测仓位管理完全一致）：
  //   科技进攻——快进快出日首次半仓、次日补足第二份半仓（次日10:00强卖），普通日全仓；
  //   情绪游资——双腿结构，顺/逆周期各半仓；攻防兼备下两策略同时触发时科技进攻优先
  const quickOutHint = (isDefense ? (d?.tech?.checks || []) : (d?.checks || []))
    .find((c) => c.id === 'quick_out_buy_hint')?.value;
  const isQuickOutDay = typeof quickOutHint === 'string' && quickOutHint.includes('快进快出');
  const posHints = [];
  if (!isExtreme) {
    posHints.push({
      ew: false,
      text: `📦 科技进攻建议仓位：${isQuickOutDay
        ? '半仓（50%）——快进快出日：首次买入半仓，次日买点再次触发时补足第二份半仓，该笔次日 10:00 强卖'
        : '全仓（100%）——普通买入日'}${isDefense ? '；两策略同时触发时科技进攻（快进快出）优先' : ''}`,
    });
  }
  if (isExtreme || isDefense) {
    posHints.push({
      ew: true,
      text: `📦 情绪游资建议仓位：半仓（50%）——双腿结构，顺周期、逆周期各半仓${isDefense ? '；若科技进攻（快进快出）同时触发则其优先，本笔情绪游资暂缓，待上一笔完全结束后再考虑' : ''}`,
    });
  }
  return {
    mode: m,
    label: STRATEGY_MODE_OPTIONS.find((o) => o.value === m)?.label || m,
    checkGroups,
    hit,
    conclusionText: isDefense
      ? `科技进攻：${d?.tech?.conclusion || '--'}｜情绪游资：${d?.conclusion || '--'}`
      : d?.conclusion,
    posHints,
  };
};

const BuyPointDiagnosisCard = ({ onResultChange }) => {
  const mode = useStrategyMode();
  const multiModes = useStrategyModes(); // 多选模式勾选列表（持久化于后端，弹窗保存后同步）
  const isExtreme = mode === MODE_EXTREME_WIN;
  const isDefense = mode === MODE_ATTACK_DEFENSE;
  const isWashFusion = mode === MODE_WASH_FUSION;
  const isMulti = mode === MODE_MULTI;
  const buyCacheKey = `ob_buy_point_cache_${mode}`;
  const cachedBuyDiagnosis = useMemo(() => readTodayLocalCache(buyCacheKey), [buyCacheKey]);
  // 记录当前诊断数据对应的策略模式，避免切换模式时把旧模式数据写进新模式缓存
  const dataModeRef = useRef(cachedBuyDiagnosis ? mode : null);
  // 首屏直接用当日缓存的诊断结果渲染，接口/WS 返回后再覆盖，避免每次进入页面都等 1~3 秒
  const [data, setData] = useState(cachedBuyDiagnosis || null);
  // 多选模式（2026-11-04）：按模式分桶维护诊断数据（WS 推送 / REST 刷新各自落到对应模式），
  // 首屏用各模式当日缓存秒开
  const [multiData, setMultiData] = useState(() => {
    if (getStrategyMode() !== MODE_MULTI) return {};
    const init = {};
    getStrategyModes().forEach((m) => {
      const cached = readTodayLocalCache(`ob_buy_point_cache_${m}`);
      if (cached) init[m] = cached;
    });
    return init;
  });
  // 情绪游资-极致赔率：最近一次买点命中（wash_fusion_buy）与候选池（wash_fusion_candidates，3s 推送）
  const [wfSignal, setWfSignal] = useState(null);
  const [wfCandidates, setWfCandidates] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // 标题旁实时时钟：每秒跳动，便于对照 3 分钟整点（9:30 / 9:33 / 9:36 …）判断下一次自动诊断时机
  const [now, setNow] = useState(() => dayjs());

  useEffect(() => {
    const timer = setInterval(() => setNow(dayjs()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 手动 / 初始一次性刷新：仅拉取当前最新诊断数据用于展示，不发飞书、不弹窗（这些由后端集中处理）
  const run = useCallback(async (force = false) => {
    // 情绪游资-极致赔率：不走科技进攻集中诊断，改由 wash_fusion 快照 + WS 推送
    if (isWashFusion) return;
    // 多选模式（2026-11-04）：对勾选的每个模式分别拉取最新诊断（wash_fusion 走候选池快照）
    if (isMulti) {
      const list = getStrategyModes();
      await Promise.all(list.map(async (m) => {
        if (m === MODE_WASH_FUSION) {
          try {
            const res = await axios.get(`http://${local_ip}:3000/wash_fusion_extreme_odds_snapshot`);
            if (res.data?.data) setWfCandidates(res.data.data);
          } catch (err) { console.error('获取极致赔率候选池失败:', err); }
          return;
        }
        try {
          const res = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: 1, force: force ? 1 : 0, mode: m });
          const result = res.data?.data;
          if (!result) return;
          setMultiData((prev) => ({ ...prev, [m]: result }));
          writeLocalCache(`ob_buy_point_cache_${m}`, result);
          onResultChange?.(modeResultHit(m, result));
        } catch (err) {
          console.error(`买点诊断刷新失败(${m}):`, err);
        }
      }));
      return;
    }
    try {
      // force=true：手动刷新按钮传入，绕过后端 30 秒重度刷新节流，随时点击随时真正重拉
      const res = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: 1, force: force ? 1 : 0, mode });
      const result = res.data?.data;
      if (!result) return;
      dataModeRef.current = mode;
      setData(result);
      // 命中口径：攻防兼备模式下科技进攻 / 顺周期 / 逆周期任一命中即算命中；
      // 情绪游资模式下逆周期（反向抱团）择时触发也算命中
      const techHit = isDefense && result.tech?.allPassed === true;
      const forwardHit = result.allPassed === true;
      const reverseHit = (isExtreme || isDefense) && result.reverse?.allPassed === true;
      // 向上层汇报买点是否命中，供 3 日涨幅榜决定是否高亮展示
      onResultChange?.(techHit || forwardHit || reverseHit);
    } catch (err) {
      console.error('买点诊断刷新失败:', err);
    }
  }, [onResultChange, mode, isExtreme, isDefense, isWashFusion, isMulti]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    const startedAt = Date.now();
    try {
      if (isMulti) {
        await run(true); // 多选模式：逐模式拉取最新诊断 + 极致赔率候选池快照
      } else if (isWashFusion) {
        const res = await axios.get(`http://${local_ip}:3000/wash_fusion_extreme_odds_snapshot`, { params: { refresh: 1 } });
        if (res.data?.data) setWfCandidates(res.data.data);
      } else {
        await run(true);
      }
    } finally {
      // 极致赔率模式下后端可能几十毫秒返回，加最短展示时长避免「点了没反应」的错觉
      if (isWashFusion) await sleep(Math.max(0, 500 - (Date.now() - startedAt)));
      setRefreshing(false);
    }
  }, [run, isWashFusion, isMulti]);

  // 最近一次诊断结果按「数据所属模式」落 localStorage，供下次进入页面秒开
  useEffect(() => {
    if (!data || !dataModeRef.current) return;
    writeLocalCache(`ob_buy_point_cache_${dataModeRef.current}`, data);
  }, [data]);

  // 买点诊断：由后端 WebSocket 集中推送（每 10s 一次），前端不再轮询
  //   - 每条消息更新诊断数据（供卡片展示）
  //   - 命中弹窗不再由本组件处理（改由 App.jsx 全局诊断卡片弹出）
  //   - 初次挂载仍一次性拉取一次（非交易时段也能展示最近交易日的诊断结果）
  useEffect(() => {
    // 情绪游资-极致赔率：候选池 3s 推送 + 买点命中推送（不限频控，命中即展示）
    if (isWashFusion) {
      axios.get(`http://${local_ip}:3000/wash_fusion_extreme_odds_snapshot`)
        .then((res) => { if (res.data?.data) setWfCandidates(res.data.data); })
        .catch((err) => console.error('获取极致赔率候选池失败:', err));
      const unsubCandidates = subscribeWashFusionCandidatesPush((msg) => {
        if (msg?.data) setWfCandidates(msg.data);
      });
      const unsubBuy = subscribeWashFusionBuyPush((msg) => {
        if (msg?.open !== true || !msg.data) return;
        setWfSignal(msg.data);
        onResultChange?.(true);
      });
      return () => { unsubCandidates(); unsubBuy(); };
    }
    // 多选模式（2026-11-04）：后端逐模式广播 buy_point（消息自带 mode），按模式分桶落到对应模式；
    // 勾选了极致赔率时另订阅其 3s 推送（候选池 + 买点命中）
    if (isMulti) {
      run(false);
      const handleBuyPointMsg = (msg) => {
        const result = msg?.data;
        const m = msg?.mode;
        if (!result || !m || m === MODE_WASH_FUSION) return;
        setMultiData((prev) => ({ ...prev, [m]: result }));
        writeLocalCache(`ob_buy_point_cache_${m}`, result);
        onResultChange?.(modeResultHit(m, result));
      };
      if (multiModes.includes(MODE_WASH_FUSION)) {
        axios.get(`http://${local_ip}:3000/wash_fusion_extreme_odds_snapshot`)
          .then((res) => { if (res.data?.data) setWfCandidates(res.data.data); })
          .catch((err) => console.error('获取极致赔率候选池失败:', err));
        const unsubCandidates = subscribeWashFusionCandidatesPush((msg) => {
          if (msg?.data) setWfCandidates(msg.data);
        });
        const unsubBuy = subscribeWashFusionBuyPush((msg) => {
          if (msg?.open !== true || !msg.data) return;
          setWfSignal(msg.data);
          onResultChange?.(true);
        });
        const unsubscribe = subscribeBuyPointPush(handleBuyPointMsg);
        return () => { unsubCandidates(); unsubBuy(); unsubscribe(); };
      }
      return subscribeBuyPointPush(handleBuyPointMsg);
    }
    run(false);
    const unsubscribe = subscribeBuyPointPush((msg) => {
      const result = msg?.data;
      if (!result) return;
      dataModeRef.current = msg?.mode || mode;
      setData(result);
      const techHit = isDefense && result.tech?.allPassed === true;
      const forwardHit = result.allPassed === true;
      const reverseHit = (isExtreme || isDefense) && result.reverse?.allPassed === true;
      onResultChange?.(techHit || forwardHit || reverseHit);
    });
    return unsubscribe;
  }, [run, onResultChange, isExtreme, isDefense, isWashFusion, isMulti, multiModes, mode]);

  // 情绪游资-极致赔率候选池统计（极致赔率视图的结论与头部徽标使用）
  const wfFirstCount = (wfCandidates?.firstBoard || []).length;
  const wfSecondCount = (wfCandidates?.secondBoard || []).length;

  // 逐模式构建展示视图（2026-11-04 多选模式）：单模式渲染一节（视觉与原来一致）；
  // 多选模式按勾选顺序每个模式各渲染一节（含模式名分组标题），极致赔率用 3s 推送信号
  const sortChecks = (list) => [...(list || [])].sort((a, b) => a.passed - b.passed);
  const views = (() => {
    const list = [];
    const pushWfView = () => {
      list.push({
        mode: MODE_WASH_FUSION,
        label: STRATEGY_MODE_OPTIONS.find((o) => o.value === MODE_WASH_FUSION)?.label,
        checkGroups: [
          {
            label: wfSignal ? `${wfSignal.sourceLabel || '极致赔率'} · 买点诊断（3s 时间桶，不限频控）` : '',
            items: sortChecks(wfSignal?.checks || []),
          },
        ],
        hit: wfSignal != null,
        conclusionText: wfSignal
          ? `${wfSignal.sourceLabel || '极致赔率'}买点命中：${(wfSignal.stocks || []).map((s) => `${s.stockName}（${s.code}）`).join('、')}；${wfSignal.positionHint || ''}`
          : `等待买点触发：首板起爆 ${wfFirstCount} 只、二板起爆 ${wfSecondCount} 只候选；盘中每 3 秒扫描一次，命中即推送（不限频控）`,
        posHints: [
          {
            ew: true,
            text: `📦 极致赔率建议仓位：半仓（50%）——账户拆两份、每份半仓，最多同时持有 2 只不同股票${wfSignal?.positionHint ? `；${wfSignal.positionHint.replace(/^半仓（50%）——/, '')}` : ''}`,
          },
        ],
      });
    };
    if (isMulti) {
      getStrategyModes().forEach((m) => {
        if (m === MODE_WASH_FUSION) {
          pushWfView();
          return;
        }
        list.push(buildBuyModeView(m, multiData[m]));
      });
    } else if (isWashFusion) {
      pushWfView();
    } else {
      list.push(buildBuyModeView(mode, data));
    }
    return list;
  })();
  const totalCheckCount = views.reduce((n, v) => n + v.checkGroups.reduce((x, g) => x + g.items.length, 0), 0);
  const totalPassedCount = views.reduce((n, v) => n + v.checkGroups.reduce((x, g) => x + g.items.filter(c => c.passed).length, 0), 0);
  const hit = views.some((v) => v.hit);

  // 情绪游资模式按 3 分钟整点（9:30/9:33/9:36…）高亮（与买点诊断触发口径一致），其余模式仍按 5 分钟整点；
  // 极致赔率（3 秒桶）本身推送频率极高，不再加背景闪烁，避免视觉干扰
  const isTickMinute = isWashFusion
    ? false
    : (isMulti
      ? multiModes.some((m) => m === MODE_EXTREME_WIN || m === MODE_ATTACK_DEFENSE)
      : (isExtreme || isDefense))
      ? now.minute() % 3 === 0
      : now.minute() % 5 === 0;

  return (
    <div className={`ob-diagnosis-card ob-buy-card ${isTickMinute ? 'is-tick' : ''}`}>
      {refreshing && (
        <div className="ob-refresh-mask">
          <Spin size="large" />
        </div>
      )}
      <div className="ob-diagnosis-header">
        <div className="ob-module-title">
          <RadarChartOutlined className="ob-module-icon" />
          <span>买点诊断</span>
          {/* 2026-11-04：标题栏不再展示当前策略名称；改为实时时钟 HH:mm:ss */}
          <span className="ob-diagnosis-clock">{now.format('HH:mm:ss')}</span>
        </div>
        <div className="ob-diagnosis-actions">
          <span className={`ob-status-badge ${hit ? 'hit' : ''}`}>
            {isWashFusion
              ? `${wfFirstCount + wfSecondCount} 候选 · ${hit ? '🎯 已命中' : '未触发'}`
              : (isMulti && totalCheckCount === 0) ? '诊断中...' : (!data && !isWashFusion && !isMulti) ? '诊断中...' : hit ? '🎯 已命中' : `未满足 ${totalPassedCount}/${totalCheckCount}`}
          </span>
          <button className="ob-refresh-btn" onClick={handleRefresh} disabled={refreshing} title="手动刷新">
            <ReloadOutlined />
          </button>
        </div>
      </div>
      <div className="ob-diagnosis-body" style={{ maxHeight: 530,overflowY: 'auto', minHeight: 522 }}>
        {(!data && !isWashFusion && !isMulti) ? (
          <div className="ob-diagnosis-loading"><Spin size="small" /></div>
        ) : (
          <>
            {views.map((v) => (
              <div key={v.mode}>
                {isMulti && (
                  <div className="ob-check-group-label">{v.label}</div>
                )}
                {v.checkGroups.map((g, gi) => [
                  g.label
                    ? <div key={`g-${gi}`} className={`ob-check-group-label${g.reverse ? ' reverse' : ''}`}>{g.label}</div>
                    : null,
                  ...g.items.map((c) => (
                    <div key={c.id} className={`ob-buy-check ${c.exempted ? 'exempted' : c.passed ? 'passed' : 'failed'}`}>
                      <span className="ob-buy-check-name">{c.title}</span>
                      <span className={`ob-buy-check-badge ${c.exempted ? 'exempted' : c.passed ? 'passed' : 'failed'}`}>
                        {c.exempted ? '已豁免' : c.passed ? '通过' : '未通过'}
                      </span>
                      {(c.value || !c.passed) && (
                        <span className="ob-buy-check-detail">
                          {c.value ? <b>{c.value}</b> : null}
                          {!c.passed && c.reason ? <span>{c.reason}</span> : null}
                        </span>
                      )}
                    </div>
                  )),
                ])}
                <div className={`ob-conclusion ${v.hit ? 'hit' : ''}`}>
                  {v.conclusionText}
                </div>
                {(v.posHints || []).map((p, pi) => (
                  <div key={pi} className={`ob-position-hint${p.ew ? ' ew' : ''}`}>{p.text}</div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

// 单笔持仓的卖点诊断：同一股票的不同仓位各自独立诊断（各自买入日期 / 成本线 / 仓位）。
// 每笔持仓以 id 区分，买入当日不诊断、次日起生效，按各笔自身买入日期判断。
const diagnosePositionSellPoint = async (stock, todayStr, mode) => {
  const base = {
    positionId: stock.id || stock.code,
    code: stock.code,
    stockName: stock.name,
    weight: stock.weight != null ? stock.weight : null,
    buyDate: stock.buyDate || null,
    buyTime: stock.buyTime || null,
    costPrice: stock.costPrice != null && Number.isFinite(Number(stock.costPrice)) ? Number(stock.costPrice) : null,
  };
  if (stock.buyDate === todayStr) {
    return { ...base, buyToday: true };
  }
  try {
    // mode='hot_money_extreme_win' 时后端返回「情绪游资-极致胜率」11 条龙头战法卖点（含⑪冲高回落 / ⑫开盘自救）；
    // buyDate 供「持仓第 N 日未拉开 +10%」判定
    const res = await axios.post(`http://${local_ip}:3000/check_single_stock_sell_point`, {
      code: stock.code,
      costPrice: stock.costPrice,
      buyDate: stock.buyDate || null,
      mode,
      // 持仓显式指定的统一卖点策略优先（首板起爆 / 二板起爆等），未设置时后端按模式回退
      sellStrategy: stock.sellStrategy || null,
      // 顺逆周期标记：逆周期持仓不启用⑪⑫「竞价大幅低开后冲高回落 / 开盘自救」
      cycle: stock.cycle || 'pro',
    });
    return { ...res.data, ...base };
  } catch (err) {
    return { ...base, error: '诊断失败' };
  }
};

// 卖出提示文案：卖出 xx 股票的 xx 仓位（在 xx 时间买入，成本线为 xx）
const buildSellHint = (result) => {
  const weightText = result.weight != null ? `${result.weight}%` : '半仓';
  const buyAt = result.buyDate ? (result.buyTime ? `${result.buyDate} ${result.buyTime}` : result.buyDate) : '--';
  const costText = result.costPrice != null ? Number(result.costPrice).toFixed(2) : '--';
  return `建议卖出 ${result.stockName} ${weightText} 仓位（在 ${buyAt} 买入，成本线为 ${costText}）`;
};

// ==================== 卖点诊断卡片（自动运行） ====================
// 命中弹窗已移除（2026-10-21 用户调整）：命中提醒改由 App.jsx 全局诊断卡片（GlobalDiagnosisAlert）负责，
// 本卡片仅负责诊断数据展示；命中时保留卡片背景闪烁提示
const SellPointDiagnosisCard = () => {
  const mode = useStrategyMode();
  const isExtreme = mode === MODE_EXTREME_WIN;
  const isWashFusion = mode === MODE_WASH_FUSION;
  const [results, setResults] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  // 卖点提醒开关：默认打开；状态持久化在后端 sell_point_reminder.json
  // 关闭后后端不再发飞书消息、也不再广播 open:true，前端因此不再弹提醒卡片 / 闪烁
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderSaving, setReminderSaving] = useState(false);
  // 命中闪烁：后端下发 open:true 时卡片背景闪烁提示，数秒后自动恢复
  const [flash, setFlash] = useState(false);
  const flashTimerRef = useRef(null);

  // 初次挂载读取后端持久化的提醒开关状态
  useEffect(() => {
    axios.get(`http://${local_ip}:3000/get_sell_point_reminder`)
      .then((res) => {
        const enabled = res.data?.data?.enabled;
        if (typeof enabled === 'boolean') setReminderEnabled(enabled);
      })
      .catch(() => { /* 读取失败保持默认打开 */ });
  }, []);

  const handleToggleReminder = useCallback(async (checked) => {
    setReminderEnabled(checked);
    setReminderSaving(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/set_sell_point_reminder`, { enabled: checked });
      const saved = res.data?.data?.enabled;
      if (typeof saved === 'boolean') setReminderEnabled(saved);
    } catch {
      setReminderEnabled(!checked);
      message.error('卖点提醒开关保存失败');
    } finally {
      setReminderSaving(false);
    }
  }, []);

  // 独立接口拉取最新卖点诊断数据（卡片刷新按钮 / 初次挂载使用；不发飞书、不触发弹窗）
  const run = useCallback(async () => {
    try {
      const posRes = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      const positions = posRes.data || [];
      if (positions.length === 0) {
        setResults([]);
        return;
      }
      const todayStr = dayjs().format('YYYY-MM-DD');
      // 每笔持仓各自独立诊断（同一股票的多笔仓位会分别产生一张卡片）
      const list = await Promise.all(
        positions.map((stock) => diagnosePositionSellPoint(stock, todayStr, mode))
      );
      setResults(list);
    } catch (err) {
      console.error('卖点诊断刷新失败:', err);
    }
  }, [mode]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await run(); } finally { setRefreshing(false); }
  }, [run]);

  // 卖点诊断：由后端 WebSocket 集中推送（每 10s 一次），前端不再轮询
  //   - 每条消息更新卡片诊断数据
  //   - 命中弹窗不再由本组件处理（改由 App.jsx 全局诊断卡片弹出）；命中时保留卡片闪烁
  //   - 卡片内刷新按钮仍走独立接口拉取最新数据（handleRefresh）
  //   - 初次挂载一次性拉取一次（非交易时段也能展示最近诊断结果）
  useEffect(() => {
    run();
    const unsubscribe = subscribeSellPointPush((msg) => {
      const list = msg?.data?.results;
      if (Array.isArray(list)) setResults(list);
      if (msg?.open === true) {
        setFlash(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlash(false), 6000);
      }
    });
    return () => {
      unsubscribe();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [run]);

  const hitStocks = results.filter((r) => r.isSell === true);

  return (
    <div className={`ob-diagnosis-card ob-sell-card ${flash ? 'is-flash' : ''}`}>
      {refreshing && (
        <div className="ob-refresh-mask">
          <Spin size="large" />
        </div>
      )}
      <div className="ob-diagnosis-header">
        <div className="ob-module-title" title={
          isWashFusion
            ? '卖点条件：首板起爆 5 条 / 二板起爆 7 条（按持仓「卖点类型」区分，1min 时间桶集中诊断；未设置时按首板起爆兜底）'
            : isExtreme
              ? '卖点条件：完整龙头战法 9 条 + 竞价大幅低开后「冲高回落 / 开盘自救」（共 11 条，情绪游资-极致胜率）'
              : '卖点条件：N 日涨幅最大策略'
        }>
          <WarningOutlined className="ob-module-icon" />
          <span>卖点诊断</span>
          {/* 2026-11-04：标题栏不再展示当前策略名称（策略由每笔持仓自身所属模式决定，见各持仓诊断明细） */}
        </div>
        <div className="ob-diagnosis-actions">
          <div className="ob-reminder-switch" title="关闭后不再发送飞书提醒，也不弹出提醒卡片">
            <span className="ob-reminder-switch-label">打开提醒</span>
            <AntSwitch
              size="small"
              checked={reminderEnabled}
              loading={reminderSaving}
              onChange={handleToggleReminder}
            />
          </div>
          <span className={`ob-status-badge ${hitStocks.length > 0 ? 'hit' : ''}`}>
            {results.length === 0 ? '暂无持仓' : hitStocks.length > 0 ? `⚠️ ${hitStocks.length} 笔命中` : `${results.length} 笔持仓 · 未触发`}
          </span>
          <button className="ob-refresh-btn" onClick={handleRefresh} title="手动刷新">
            <ReloadOutlined />
          </button>
        </div>
      </div>
      <div className="ob-diagnosis-body" style={{ maxHeight: 530,overflowY: 'auto', minHeight: 522 }}>
        {results.length === 0 ? (
          <div className="ob-empty-mini" style={{ height: 500, fontSize: 16 }}>暂无持仓</div>
        ) : results.map((r) => (
          <div key={r.positionId || r.code} className={`ob-sell-stock ${r.isSell ? 'hit' : ''}`}>
            <div className="ob-sell-stock-header">
              {/* 第一行：股票名称 + 代码 */}
              <div className="ob-sell-header-row ob-sell-header-row--title">
                <div>
                  <span className="ob-sell-stock-name">{r.stockName}</span>
                  <span className="ob-sell-stock-code">{r.code}</span>
                </div>
                <span className={`ob-sell-stock-tag ${r.isSell ? 'hit' : 'safe'}`}>
                  {r.buyToday ? '买入当日' : r.error ? '诊断失败' : r.isSell ? '建议卖出' : '建议持有'}
                </span>
              </div>
              {/* 第二行：仓位 / 买入时间 / 成本线 / 涨幅 / 状态 */}
              <div className="ob-sell-header-row">
                {r.weight != null && (
                  <span className="ob-sell-stock-weight">仓位 {r.weight}%</span>
                )}
                <span className="ob-sell-stock-buytime">
                  买入 {r.buyDate || '--'}{r.buyTime ? ` ${r.buyTime}` : ''}
                </span>
                {r.costPrice != null && (
                  <span className="ob-sell-stock-cost">成本线 {Number(r.costPrice).toFixed(2)}</span>
                )}
                {r.detail?.change !== undefined && (
                  <span className={`ob-sell-stock-change ${r.detail.change >= 0 ? 'ob-up' : 'ob-down'}`}>
                    {formatSignedPercent(r.detail.change)}
                  </span>
                )}
              </div>
            </div>
            <div className="ob-sell-stock-conds">
              {r.buyToday ? (
                <div className="ob-check-reason">买入当日卖点诊断不生效，次日起生效</div>
              ) : r.error ? (
                <div className="ob-check-reason">{r.error}</div>
              ) : (r.conditions && r.conditions.length > 0 ? r.conditions.sort((a, b) => (b.satisfied ? 3 : b.exempted ? 2 : b.pending ? 1 : 0) - (a.satisfied ? 3 : a.exempted ? 2 : a.pending ? 1 : 0)).map((cond, cidx) => (
                <div key={cidx} className={`ob-sell-cond ${cond.satisfied ? 'hit' : cond.exempted ? 'exempted' : cond.pending ? 'pending' : 'safe'}`}>
                  <span className="ob-sell-cond-name">{cond.name}</span>
                  <span className="ob-sell-cond-badge">
                    {cond.satisfied ? '触发' : cond.exempted ? '已豁免' : cond.pending ? (cond.pendingMinutes != null ? `确认中 ${cond.pendingMinutes}/5min` : '确认中') : '未触发'}
                  </span>
                  <div className="ob-sell-cond-detail">{cond.detail}</div>
                </div>
              )) : (
                <div className="ob-check-reason">{r.conclusion}</div>
              ))}
              {r.isSell && !r.buyToday && !r.error && (
                <div className="ob-sell-hint">{buildSellHint(r)}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ==================== 主页面 ====================
const OpeningBattle = () => {
  // 进入页面时回到顶部，避免沿用上一页面遗留的滚动位置（路由切换或刷新都会重新触发）
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // 网络检测轮询：每 3s 探测外网，超过 1s 未返回即通过浏览器通知提醒网络差
  useNetworkWatch();

  // 买点是否命中（由买点诊断卡片回调），命中时 3 日涨幅榜中唯一推荐标的的标签改为「买点触发」
  const [buyPointHit, setBuyPointHit] = useState(false);

  // 持仓分时图展开状态，状态持久化到 localStorage
  const [rankExpanded, setRankExpanded] = useState(() => {
    try {
      return localStorage.getItem('ob_rank_expanded') === '1';
    } catch (e) {
      return false;
    }
  });

  const toggleRankExpanded = useCallback(() => {
    setRankExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem('ob_rank_expanded', next ? '1' : '0'); } catch (e) { }
      return next;
    });
  }, []);

  // ==================== 主题包 / DIY 主题色（与盯盘页同款功能体系） ====================
  // themeColor 结构: { pack, randomPlay, itemTitleColor, itemBorderColor, numberFontFamily, numberFontSize }
  // pack: 主题包 id（'' 为默认样式），生效时 DIY 字段禁用，样式由主题包 CSS 变量接管
  const [themeColor, setThemeColor] = useState(() => {
    try {
      const saved = localStorage.getItem('ob_themeColor');
      return saved ? { ...DEFAULT_THEME_COLOR, ...JSON.parse(saved) } : { ...DEFAULT_THEME_COLOR };
    } catch {
      return { ...DEFAULT_THEME_COLOR };
    }
  });
  const [themeColorModalVisible, setThemeColorModalVisible] = useState(false);
  // 弹窗内未保存的实时预览主题包（null 表示无预览）；不写入 localStorage，取消时自动失效
  const [themePreviewPack, setThemePreviewPack] = useState(null);
  // 编辑主题包颜色时的实时预览数据（仅内存，点击保存才写入后端）
  const [themePreviewPackData, setThemePreviewPackData] = useState(null);
  // 主题包列表：由后端 /ob_theme_packs/list 返回，加载失败时回退到本地静态列表
  const [themePacks, setThemePacks] = useState(() => getThemePacks());

  // 预览优先于已保存配置，用于弹窗中悬停/点选时即时生效
  const themeColorView = useMemo(
    () => (themePreviewPack === null ? themeColor : { ...themeColor, pack: themePreviewPack }),
    [themeColor, themePreviewPack]
  );

  // 当前生效的主题包（null 表示默认样式）
  const activeThemePack = useMemo(() => {
    if (!themeColorView.pack) return null;
    // 编辑颜色中的实时预览数据优先
    const previewData = themePreviewPackData?.id === themeColorView.pack ? themePreviewPackData : null;
    return previewData || themePacks.find(p => p.id === themeColorView.pack) || null;
  }, [themeColorView.pack, themePacks, themePreviewPackData]);

  // 主题包 CSS 变量（挂到 .opening-battle-container 上）
  const packVars = useMemo(
    () => (activeThemePack ? buildPackVars(activeThemePack) : undefined),
    [activeThemePack]
  );

  // 主题包未生效时的 DIY 变量（仅 DIY 已设置字段；与主题包互斥）
  const diyActive = useMemo(
    () => !activeThemePack && hasDiyFields(themeColorView),
    [activeThemePack, themeColorView]
  );
  const diyVars = useMemo(
    () => (diyActive ? buildDiyVars(themeColorView) : undefined),
    [diyActive, themeColorView]
  );

  // 监听主题色配置变化并存入 localStorage
  useEffect(() => {
    localStorage.setItem('ob_themeColor', JSON.stringify(themeColor));
  }, [themeColor]);

  // 主题随机播放：开启后每隔 5 分钟随机切换一个主题包（不会切到当前包）
  useEffect(() => {
    if (!themeColor.randomPlay) return undefined;
    const timer = setInterval(() => {
      setThemeColor(prev => {
        const ids = themePacks.map(p => p.id);
        if (!ids.length) return prev;
        let next = prev.pack;
        while (next === prev.pack && ids.length > 1) {
          next = ids[Math.floor(Math.random() * ids.length)];
        }
        if (next === prev.pack) return prev;
        return { ...prev, pack: next };
      });
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [themeColor.randomPlay, themePacks]);

  // 应用后端返回的主题包列表：同步到模块级缓存
  const applyThemePacks = (packs) => {
    if (!Array.isArray(packs)) return;
    setRemoteThemePacks(packs);
    setThemePacks(packs);
  };

  // 从后端加载主题包列表；失败时保留当前列表（首次加载失败则使用本地静态列表）
  const loadThemePacks = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/ob_theme_packs/list`);
      if (res.data?.success) applyThemePacks(res.data.data);
    } catch (error) {
      console.error('加载主题包列表失败:', error);
    }
  };

  useEffect(() => {
    loadThemePacks();
    // 仅首次进入页面加载一次，之后由弹窗打开/增删操作刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新增主题包：后端校验 JSON 结构，成功后刷新列表
  const handleAddThemePack = async (pack) => {
    const res = await axios.post(`http://${local_ip}:3000/ob_theme_packs/add`, { pack });
    if (!res.data?.success) throw new Error(res.data?.message || '新增主题包失败');
    applyThemePacks(res.data.data);
    return res.data.data;
  };

  // 更新主题包（编辑颜色后保存）：后端按 token 合并，成功后刷新列表
  const handleUpdateThemePack = async (id, tokens) => {
    const res = await axios.post(`http://${local_ip}:3000/ob_theme_packs/update`, { id, pack: { tokens } });
    if (!res.data?.success) throw new Error(res.data?.message || '更新主题包失败');
    applyThemePacks(res.data.data);
    return res.data.data;
  };

  // 删除主题包；若删除的是当前生效主题，则回退到默认主题
  const handleDeleteThemePack = async (id) => {
    const res = await axios.post(`http://${local_ip}:3000/ob_theme_packs/delete`, { id });
    if (!res.data?.success) throw new Error(res.data?.message || '删除主题包失败');
    applyThemePacks(res.data.data);
    setThemeColor(prev => (prev.pack === id ? { ...prev, pack: '' } : prev));
    setThemePreviewPack(prev => (prev === id ? '' : prev));
    setThemePreviewPackData(prev => (prev?.id === id ? null : prev));
    return res.data.data;
  };

  const handleSaveThemeColor = (next) => {
    setThemeColor(next);
    setThemePreviewPack(null);
    setThemePreviewPackData(null);
    setThemeColorModalVisible(false);
  };

  // 关闭弹窗：未保存的预览失效，恢复已保存的主题
  const handleCancelThemeColor = () => {
    setThemePreviewPack(null);
    setThemePreviewPackData(null);
    setThemeColorModalVisible(false);
  };

  return (
    <div
      className={`opening-battle-container${activeThemePack ? ' pack-active' : ''}${diyActive ? ' diy-active' : ''}`}
      style={packVars || diyVars}
    >
      <div className="ob-layout">
        {/* 第一行：资金分时图 | 资金明细 | 成交量（左） + 持仓分时图（右，与左侧模块等高） */}
        <div className="ob-row ob-row-first">
          <FundChartModule />
          <PositionIntradayModule expanded={rankExpanded} onToggleExpanded={toggleRankExpanded} />
        </div>
        {/* 第二行：候选列表卡片（单模式一个卡片；多选模式每个勾选模式各一个卡片，平分宽度、等高、超内容滚动） */}
        {/* 重点板块涨跌幅前十已移除（2026-11-03 用户要求） */}
        <div className="ob-row ob-row-second">
          <TopChange3dModule buyPointHit={buyPointHit} />
        </div>
        {/* 第三行：买点诊断（6 成宽度） | 卖点诊断（4 成宽度） */}
        <div className="ob-row ob-row-third">
          <BuyPointDiagnosisCard onResultChange={setBuyPointHit} />
          <SellPointDiagnosisCard />
        </div>
      </div>

      {/* 右下角固定主题切换按钮：渲染到 body 上，避免页面祖先（.content-inner 的 backdrop-filter）
          创建包含块，导致 position: fixed 相对长页面底部定位（2026-11-04 修复） */}
      {createPortal(
        <button
          type="button"
          className="ob-theme-fab"
          title="主题与 DIY 主题色设置"
          style={packVars || diyVars}
          onClick={() => setThemeColorModalVisible(true)}
        >
          <BgColorsOutlined />
        </button>,
        document.body
      )}

      <ThemeColorModal
        open={themeColorModalVisible}
        onCancel={handleCancelThemeColor}
        onOk={handleSaveThemeColor}
        onPreview={setThemePreviewPack}
        value={themeColor}
        packs={themePacks}
        onAddPack={handleAddThemePack}
        onUpdatePack={handleUpdateThemePack}
        onDeletePack={handleDeleteThemePack}
        onPreviewPackData={setThemePreviewPackData}
      />
    </div>
  );
};

export default OpeningBattle;
