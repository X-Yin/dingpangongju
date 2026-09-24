import { useState, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal, message } from 'antd';
import { CheckOutlined, CloseOutlined, ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import './index.scss';

const STORAGE_KEY = 'dingpan_close_pipeline';
// 15:01 触发（收盘后）
const TRIGGER_MINUTE = 15 * 60 + 1;

// 收盘流水线节点定义
const PIPELINE_NODES = [
  { key: 'crowd', name: '拥挤度计算', desc: '板块资金 / 拥挤度', path: '/block?tab=money&subTab=crowd' },
  { key: 'dingpan', name: '市场当日概况', desc: '市场盯盘', path: '/dingpan' },
  { key: 'fupan', name: '复盘分析', desc: '复盘分析', path: '/fupan' },
  { key: 'ai', name: '主线 AI 分析', desc: '智能分析 / AI 分析', path: '/block?tab=smart&subTab=ai' },
];

const isTradingDay = (d) => {
  const dow = d.day();
  return dow !== 0 && dow !== 6;
};

const readState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.date ? parsed : null;
  } catch (e) {
    return null;
  }
};

const writeState = (state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // ignore
  }
};

const clearState = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
};

// 收盘流水线：15:01 自动启动并跳转第一个节点，吸底常驻直到全部节点完成
const ClosePipeline = () => {
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState(null);

  useEffect(() => {
    const todayStr = dayjs().format('YYYYMMDD');

    // 启动时检查并清理过期流水线状态（前一天未清除的节点进度/完成标记）
    const stored = readState();
    if (stored && stored.date !== todayStr) {
      clearState();
    } else if (stored) {
      setPipeline(stored);
    }

    // 启动检查：工作日且已过 15:01，且今天尚未启动过流水线
    const tryStart = () => {
      const now = dayjs();
      if (!isTradingDay(now)) return;
      if (now.hour() * 60 + now.minute() < TRIGGER_MINUTE) return;
      const today = now.format('YYYYMMDD');
      const current = readState();
      if (current && current.date === today) return; // 今天已启动（进行中或已完成）
      const fresh = { date: today, index: 0, done: false };
      writeState(fresh);
      setPipeline(fresh);
      message.info('收盘流水线已启动，正在进入【拥挤度计算】');
      navigate(PIPELINE_NODES[0].path);
    };

    tryStart(); // 打开页面时已过 15:01 且今天未启动 → 立即启动
    const timer = setInterval(tryStart, 30000); // 轮询兜底，覆盖 15:01 定时触发

    return () => clearInterval(timer);
  }, [navigate]);

  // 完成当前节点：清除当前节点状态并推进到下一节点（自动跳转对应页面）
  const handleComplete = () => {
    if (!pipeline || pipeline.done) return;
    const nextIndex = pipeline.index + 1;
    if (nextIndex >= PIPELINE_NODES.length) {
      // 全部完成：仅保留当日完成标记（避免重复触发与无限写入），流水线消失
      writeState({ date: pipeline.date, index: PIPELINE_NODES.length - 1, done: true });
      setPipeline(null);
      message.success('收盘流水线已全部完成');
      return;
    }
    const next = { date: pipeline.date, index: nextIndex, done: false };
    writeState(next);
    setPipeline(next);
    navigate(PIPELINE_NODES[nextIndex].path);
  };

  // 点击节点直接跳转到对应页面（不改变进度）
  const handleNodeClick = (node) => {
    navigate(node.path);
  };

  // 放弃今日流水线
  const handleAbort = () => {
    Modal.confirm({
      title: '放弃收盘流水线',
      content: '确定要放弃今天的收盘流水线吗？今天将不再提示。',
      okText: '放弃',
      okType: 'danger',
      cancelText: '继续',
      onOk: () => {
        if (pipeline) {
          writeState({ date: pipeline.date, index: pipeline.index, done: true });
        }
        setPipeline(null);
      },
    });
  };

  if (!pipeline || pipeline.done) return null;

  const isLast = pipeline.index === PIPELINE_NODES.length - 1;

  return (
    <div className="close-pipeline-bar">
      <div className="close-pipeline-header">
        <ClockCircleOutlined className="close-pipeline-icon" />
        <span className="close-pipeline-title">收盘流水线</span>
        <span className="close-pipeline-progress">{pipeline.index + 1}/{PIPELINE_NODES.length}</span>
      </div>
      <div className="close-pipeline-nodes">
        {PIPELINE_NODES.map((node, idx) => (
          <Fragment key={node.key}>
            {idx > 0 && <span className="close-pipeline-arrow">→</span>}
            <div
              className={`close-pipeline-node${idx === pipeline.index ? ' active' : ''}${idx < pipeline.index ? ' done' : ''}`}
              onClick={() => handleNodeClick(node)}
              title={node.desc}
            >
              <span className="close-pipeline-node-index">
                {idx < pipeline.index ? <CheckOutlined /> : idx + 1}
              </span>
              <span className="close-pipeline-node-name">{node.name}</span>
            </div>
          </Fragment>
        ))}
      </div>
      <div className="close-pipeline-actions">
        <Button type="primary" size="small" onClick={handleComplete}>
          {isLast ? '完成并结束' : '完成并下一步'}
        </Button>
        <CloseOutlined className="close-pipeline-close" onClick={handleAbort} />
      </div>
    </div>
  );
};

export default ClosePipeline;
