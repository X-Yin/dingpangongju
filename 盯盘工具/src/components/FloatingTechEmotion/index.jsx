import { useState, useEffect, useRef } from 'react';
import { ArrowUpOutlined, ArrowDownOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import dayjs from 'dayjs';
import { isAfterMarketClose } from '../../utils/tradingDay';
import { local_ip } from '../../constant';
import { replayTechEmotionStore } from '../../utils/replayTechEmotion';
import './index.scss';

// 是否已收盘（统一来自 utils/tradingDay，非交易日视为已收盘，交易日 9:15 前或 14:59 及以后）

const FloatingTechEmotion = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isReplayMode = location.pathname === '/training_camp';
  const [currentValue, setCurrentValue] = useState(null);
  const [prevValue, setPrevValue] = useState(null);
  const prevValueRef = useRef(null);
  const [jxhcChange, setJxhcChange] = useState(null);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [memoryMB, setMemoryMB] = useState(null);

  const fetchTechEmotion = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/latest_tech_emotion`);
      const val = res.data.value;
      if (val !== null && val !== undefined) {
        prevValueRef.current = currentValue;
        setPrevValue(prevValueRef.current);
        setCurrentValue(val);
      }
    } catch (err) {
      console.error('Fetch tech emotion failed:', err);
    }
  };

  const handleRefresh = async () => {
    setRefreshLoading(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/update_emotion_data`);
      setCurrentValue(res.data.data);

      // 刷新后检查当日分时是否达到冰点（<= -39），若是则标记 hasIce
      try {
        const intraRes = await axios.get(`http://${local_ip}:3000/tech_emotion_intraday`);
        const today = dayjs().format('YYYYMMDD');
        const todayData = intraRes.data?.data?.[today] || [];
        const hasIce = todayData.some(item =>
          item.value !== null && item.value !== undefined && !isNaN(item.value) && Number(item.value) <= -39
        );
        if (hasIce) {
          await axios.post(`http://${local_ip}:3000/mark_tech_index_ice`);
        }
      } catch (e) {
        console.error('刷新后检查冰点失败:', e);
      }
    } catch (err) {
      console.error('Refresh tech emotion failed:', err);
    } finally {
      setRefreshLoading(false);
    }
  };

  useEffect(() => {
    if (isReplayMode) {
      const unsubscribe = replayTechEmotionStore.subscribe((val, prev) => {
        setCurrentValue(val);
        setPrevValue(prev);
      });
      const { value, prev } = replayTechEmotionStore.get();
      setCurrentValue(value);
      setPrevValue(prev);
      return () => {
        unsubscribe();
      };
    }

    fetchTechEmotion();

    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        if (!isAfterMarketClose()) {
          callback();
          schedulePoll(callback, delay);
        }
      }, delay);
      timers.push(timer);
      return timer;
    };

    schedulePoll(fetchTechEmotion, 10000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [isReplayMode]);

  // 内存占用显示：优先用后端 /browser_memory 接口（top 命令拿 Chrome Heap 真实 RSS，
  // 1:1 对齐 Chrome 任务管理器）；后端不可用时 fallback 到 usedJSHeapSize × 7 估算；
  // 每 5 秒刷新一次
  useEffect(() => {
    const perf = performance;
    const hasHeapMemory = perf && typeof perf.memory !== 'undefined';

    const JS_ESTIMATE_RATIO = 7; // 仅 macOS Chrome 上：JS 堆 × 7 ≈ 进程内存
    let timer = null;
    let cancelled = false;

    // 启动时打印一次口径说明
    console.info('[FloatingTechEmotion Memory] 优先后端 /browser_memory (top 命令)，fallback usedJSHeapSize × 7');

    const tick = async () => {
      if (cancelled) return;

      // 先尝试后端接口（macOS top 命令拿真实内存）
      try {
        const res = await axios.get(`http://${local_ip}:3000/browser_memory`, { timeout: 2000 });
        if (!cancelled && res.data?.success && res.data.largestMB != null) {
          setMemoryMB(res.data.largestMB);
          return; // 后端返回成功就用后端的值
        }
      } catch (_) {
        // 后端不可用，fallback
      }

      // Fallback: JS 端估算
      if (hasHeapMemory) {
        try {
          if (cancelled) return;
          const heapMB = perf.memory.usedJSHeapSize / 1024 / 1024;
          setMemoryMB(heapMB * JS_ESTIMATE_RATIO);
        } catch (_) { /* ignore */ }
      }
    };

    tick();
    timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const isPositive = currentValue !== null && currentValue > 0;
  const isNegative = currentValue !== null && currentValue < 0;
  const isUp = prevValue !== null && currentValue !== null && currentValue > prevValue;
  const isDown = prevValue !== null && currentValue !== null && currentValue < prevValue;

  const displayValue = currentValue !== null ? currentValue.toFixed(2) : '--';
  const jxhcDisplayValue = jxhcChange !== null ? jxhcChange.toFixed(2) : '--';
  const showJxhcAlert = jxhcChange !== null && jxhcChange < -2;

  const handleClick = () => {
    if (isReplayMode) return;
    navigate('/sentiment');
  };

  return (
    <div className="floating-tech-emotion" onClick={handleClick} style={{ bottom: isReplayMode ? '100px' : '20px' }}>
      <div className="fte-header">
        <div className="fte-title-row">
          <div className="fte-title-left">
            <span className="fte-badge" />
            <span className="fte-title">科技情绪指数{isReplayMode ? '（回放）' : ''}</span>
          </div>
          {!isReplayMode && (
            <button
              className="fte-refresh-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleRefresh();
              }}
            >
              <ReloadOutlined style={{ fontSize: 14 }} spin={refreshLoading} />
            </button>
          )}
        </div>
        <div className="fte-value-container">
          <span className={`fte-value ${isPositive ? 'positive' : isNegative ? 'negative' : ''}`}>
            {displayValue}
          </span>
          {isUp && <ArrowUpOutlined style={{ color: '#f5222d', fontSize: 14 }} />}
          {isDown && <ArrowDownOutlined style={{ color: '#52c41a', fontSize: 14 }} />}
          {memoryMB != null && (
            <span className={`fte-memory-label${memoryMB >= 1500 ? ' warn' : memoryMB >= 1800 ? ' danger' : ''}`}>
              {(memoryMB >= 1024 ? (memoryMB / 1024).toFixed(1) + 'G' : memoryMB.toFixed(0) + 'M')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default FloatingTechEmotion;
