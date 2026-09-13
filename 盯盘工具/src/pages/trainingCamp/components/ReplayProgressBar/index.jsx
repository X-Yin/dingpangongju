import { Slider } from 'antd';
import { createPortal } from 'react-dom';
import {
  BackwardOutlined, ForwardOutlined, PlayCircleOutlined, PauseCircleOutlined, AimOutlined,
} from '@ant-design/icons';

const ReplayProgressBar = ({
  timeBuckets, currentIndex, isPlaying, onToggle, onPause, onSeek, onStepForward, onStepBackward, currentBucket, onBuyPointDiagnosis,
}) => {
  const total = timeBuckets.length;
  const lastBucket = timeBuckets[total - 1];
  const currentDisplay = currentBucket?.displayTime || '--:--';
  const lastDisplay = lastBucket?.displayTime || '--:--';

  const signalMarks = {};
  timeBuckets.forEach((b, i) => {
    if (b.signals && b.signals.length > 0) {
      signalMarks[i] = { style: { display: 'none' } };
    }
  });

  const handleSliderChange = (val) => {
    if (isPlaying) onPause();
    onSeek(val);
  };

  return createPortal(
    <div className="training-camp-replay-bar">
      <div className="replay-controls">
        <div className="replay-btn" title="倒推一个时间桶" onClick={onStepBackward}>
          <BackwardOutlined />
        </div>
        <div className="replay-btn play-btn" title={isPlaying ? '暂停' : '播放'} onClick={onToggle}>
          {isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
        </div>
        <div className="replay-btn" title="快进一个时间桶" onClick={onStepForward}>
          <ForwardOutlined />
        </div>
        <div
          className="replay-action-btn"
          title="对当前时间桶执行买点诊断，查看各条件命中情况"
          onClick={onBuyPointDiagnosis}
        >
          <AimOutlined />
          <span>买点诊断</span>
        </div>
      </div>

      <div className="replay-slider-wrap">
        <div className="replay-marks">
          {timeBuckets.map((b, i) => b.signals && b.signals.length > 0 ? (
            <div
              key={i}
              className="replay-mark"
              style={{
                left: `${total > 1 ? (i / (total - 1)) * 100 : 0}%`,
                background: b.signals.some(s => s.isBullish) ? '#52c41a' : '#f5222d',
              }}
              title={`${b.displayTime} 命中 ${b.signals.length} 条策略`}
            />
          ) : null)}
        </div>
        <Slider
          min={0}
          max={Math.max(total - 1, 0)}
          value={currentIndex}
          onChange={handleSliderChange}
          marks={signalMarks}
          tooltip={{ formatter: () => currentDisplay }}
          style={{ margin: '0 4px' }}
        />
      </div>

      <div className="replay-time-display">
        {currentDisplay} / {lastDisplay}
        <span style={{ color: '#9ca3af', marginLeft: 8 }}>
          ({currentIndex + 1}/{total})
        </span>
      </div>
    </div>,
    document.body
  );
};

export default ReplayProgressBar;
