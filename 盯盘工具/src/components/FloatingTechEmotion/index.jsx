import { useState, useEffect, useRef } from 'react';
import { ArrowUpOutlined, ArrowDownOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { replayTechEmotionStore } from '../../utils/replayTechEmotion';
import './index.scss';

const isAfterMarketClose = () => {
  const now = dayjs();
  const currentHour = now.hour();
  const currentMinute = now.minute();
  return currentHour < 9 || (currentHour === 9 && currentMinute < 15) || currentHour >= 15 || (currentHour === 14 && currentMinute >= 59);
};

const FloatingTechEmotion = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isReplayMode = location.pathname === '/training_camp';
  const [currentValue, setCurrentValue] = useState(null);
  const [prevValue, setPrevValue] = useState(null);
  const prevValueRef = useRef(null);
  const [jxhcChange, setJxhcChange] = useState(null);
  const [refreshLoading, setRefreshLoading] = useState(false);

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

      // 刷新后检查当日分时是否达到冰点（<= -100），若是则标记 hasIce
      try {
        const intraRes = await axios.get(`http://${local_ip}:3000/tech_emotion_intraday`);
        const today = dayjs().format('YYYYMMDD');
        const todayData = intraRes.data?.data?.[today] || [];
        const hasIce = todayData.some(item =>
          item.value !== null && item.value !== undefined && !isNaN(item.value) && Number(item.value) <= -100
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
        </div>
      </div>
    </div>
  );
};

export default FloatingTechEmotion;
