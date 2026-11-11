// 重点股 1 分钟涨跌幅异动全局监控（2026-11-10 用户新增）
// 每 1 分钟采样一次全量自选股行情（/get_all_stock_data，后端缓存，轻量），
// 对所有被标记为重点（isImportant）的股票对比 1 分钟前的涨跌幅：
//   任一重点股 1 分钟内涨跌幅绝对值变化 ≥ 2% → 经本地广播（important_stock_surge）
//   触发 GlobalDiagnosisAlert 弹出全局异动卡片，一次列出全部命中股票。
// 仅交易日盘中监控；首次采样与长时间挂起（标签页休眠等）后只重建基线，不触发提醒。
import { useEffect, useRef } from 'react';
import axios from 'axios';
import { local_ip } from '../../constant';
import { isTradingDay, isAfterMarketClose } from '../../utils/tradingDay';
import { publishLocalPush } from '../../utils/buyPointWs';

const POLL_INTERVAL = 60 * 1000; // 每 1 分钟监控一次
const THRESHOLD = 2;             // 1 分钟内涨跌幅变化阈值（百分点，按绝对值）
const STALE_MS = 90 * 1000;      // 上次采样距今超过 90s 视为采样中断，只重建基线

const ImportantStockSurgeMonitor = () => {
  // 上一次采样：{ ts, time, map: Map(code -> { change, stockName }) }
  const prevSampleRef = useRef(null);

  useEffect(() => {
    const sample = async () => {
      const now = new Date();
      // 非交易日 / 收盘后不监控，避免把隔夜跳空当成 1 分钟异动
      if (!isTradingDay(now) || isAfterMarketClose(now)) return;
      let stocks;
      try {
        const resp = await axios.get(`http://${local_ip}:3000/get_all_stock_data`, { timeout: 30 * 1000 });
        stocks = Array.isArray(resp.data) ? resp.data : [];
      } catch {
        return; // 拉取失败时保留上一次采样，等下一分钟重试
      }

      const prev = prevSampleRef.current;
      const cur = { ts: now.getTime(), map: new Map() };
      stocks.forEach((s) => {
        const change = Number(s?.change);
        if (Number.isFinite(change)) cur.map.set(s.code, { change, stockName: s.stockName || s.name || s.code });
      });
      prevSampleRef.current = cur;

      // 首次采样 / 采样中断：只建立基线，不触发提醒
      if (!prev || cur.ts - prev.ts > STALE_MS) return;

      const hits = [];
      cur.map.forEach((info, code) => {
        const prevInfo = prev.map.get(code);
        if (!prevInfo) return;
        const delta = info.change - prevInfo.change;
        if (Math.abs(delta) >= THRESHOLD) {
          hits.push({ code, stockName: info.stockName, change: info.change, prevChange: prevInfo.change, delta });
        }
      });

      if (hits.length === 0) return;
      hits.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)); // 变化幅度大的排前面
      publishLocalPush({
        type: 'important_stock_surge',
        data: {
          time: new Date(cur.ts).toLocaleTimeString('zh-CN', { hour12: false }),
          prevTime: new Date(prev.ts).toLocaleTimeString('zh-CN', { hour12: false }),
          threshold: THRESHOLD,
          stocks: hits,
        },
      });
    };

    sample();
    const timer = setInterval(sample, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  return null;
};

export default ImportantStockSurgeMonitor;
