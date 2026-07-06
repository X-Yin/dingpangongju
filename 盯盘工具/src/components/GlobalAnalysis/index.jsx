import { useState, useRef, useEffect } from 'react';
import { Button, Spin, message } from 'antd';
import { ThunderboltOutlined, CopyOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const questionText = `1. 当前大盘的整体情况，风格如何，主线是什么，退潮的是什么？
2. 哪些板块的资金有明显异动？比如加速流出，流出放缓，加速流入，流入放缓，先流出后流入，先流入后流出等。
3. 哪些板块的涨幅有明显异动？比如加速下跌，下跌放缓，加速上涨，上涨放缓，先下跌后上涨，先上涨后下跌等。
4. 哪些个股的上涨或者下跌和机构的研报有明显关联的？
5. 整体做个总结`;

// 配置 marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

const MIN_INTERVAL_MS = 10 * 60 * 1000; // 两次分析至少间隔 10 分钟
const BLINK_THRESHOLD_MS = 10 * 60 * 1000; // 超过 10 分钟未分析则按钮闪烁

const GlobalAnalysis = () => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [lastAnalysisTime, setLastAnalysisTime] = useState(null); // 上次分析完成时间
  const [now, setNow] = useState(Date.now()); // 当前时间，每秒刷新
  const abortRef = useRef(null);

  // 每秒刷新当前时间，用于按钮禁用状态和闪烁判断
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 组件卸载时中止进行中的请求
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // 距离上次分析的时间（毫秒），null 表示从未分析过
  const elapsedSinceLast = lastAnalysisTime !== null ? now - lastAnalysisTime : null;

  // 按钮是否禁用：正在加载 或 距上次分析不足 10 分钟
  const isButtonDisabled = loading || (elapsedSinceLast !== null && elapsedSinceLast < MIN_INTERVAL_MS);

  // 距离下次可用的倒计时（秒）
  const remainingSeconds = isButtonDisabled && elapsedSinceLast !== null
    ? Math.ceil((MIN_INTERVAL_MS - elapsedSinceLast) / 1000)
    : 0;

  // 是否需要闪烁：从未分析过且页面打开超过 10 分钟，或距上次分析超过 10 分钟
  const shouldBlink = !loading && (
    lastAnalysisTime === null
      ? false // 从未分析不闪烁（只有曾经分析过再超过 10 分钟才闪）
      : elapsedSinceLast >= BLINK_THRESHOLD_MS
  );

  // 通知父组件（App.jsx）切换橙色按钮的闪烁状态
  useEffect(() => {
    if (window.onGlobalAnalysisBlinkChange) {
      window.onGlobalAnalysisBlinkChange(shouldBlink);
    }
  }, [shouldBlink]);

  // 获取提问数据并复制到剪贴板
  const fetchQuestionData = async () => {
    setCopyLoading(true);
    try {
      const dataRes = await fetch(`http://${local_ip}:3000/global_analysis_data`);
      if (!dataRes.ok) {
        message.error('获取数据失败');
        return;
      }
      const context = await dataRes.json();
      const text = `${JSON.stringify(context)}; 根据所传入的数据，分析一下相关行情，${questionText}`;
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch (err) {
      console.error('获取提问数据失败:', err);
      message.error('复制失败，请稍后重试');
    } finally {
      setCopyLoading(false);
    }
  };

  const fetchAnalysis = async () => {
    if (isButtonDisabled) return;
    setLoading(true);
    setContent('');
    setHasStarted(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 先拉取全局分析数据作为 AI 上下文
      let context = null;
      try {
        const dataRes = await fetch(`http://${local_ip}:3000/global_analysis_data`, {
          signal: controller.signal,
        });
        if (dataRes.ok) {
          context = await dataRes.json();
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn('获取全局分析数据失败，将不带上下文分析:', e);
      }

      const response = await fetch(`http://${local_ip}:3000/api/zhipu_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `根据所传入的数据，分析一下相关行情，${questionText}`,
          context,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        setContent('请求失败，请稍后重试');
        setLoading(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 智谱返回的是 SSE 格式，每行以 data: 开头
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              result += delta;
              setContent(result);
            }
          } catch (e) {
            // 忽略解析失败的片段
          }
        }
      }
      // 分析成功完成后记录时间
      setLastAnalysisTime(Date.now());
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('全局分析请求失败:', err);
        setContent('请求失败，请稍后重试');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const formatTime = (ts) => ts ? dayjs(ts).format('YYYY-MM-DD HH:mm:ss') : '--';

  return (
    <div className="global-analysis">
      <div className="global-analysis-header">
        <div className="global-analysis-times">
          <span className="time-item">
            <span className="time-label">上次分析：</span>
            <span className="time-value">{formatTime(lastAnalysisTime)}</span>
          </span>
          <span className="time-item">
            <span className="time-label">当前时间：</span>
            <span className="time-value">{formatTime(now)}</span>
          </span>
        </div>
        <div className="global-analysis-actions">
          <Button
            icon={<CopyOutlined />}
            onClick={fetchQuestionData}
            loading={copyLoading}
          >
            获取提问数据
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={fetchAnalysis}
            loading={loading}
            disabled={isButtonDisabled && !loading}
          >
            {loading ? '分析中...' : hasStarted ? '重新分析' : '开始分析'}
            {isButtonDisabled && !loading && remainingSeconds > 0 ? ` (${remainingSeconds}s)` : ''}
          </Button>
        </div>
      </div>
      <div className="global-analysis-content">
        {!hasStarted ? (
          <div className="global-analysis-empty">
            <ThunderboltOutlined style={{ fontSize: 48, color: '#fa8c16', marginBottom: 16 }} />
            <div style={{ color: '#8c8c8c', fontSize: 14 }}>
              点击「开始分析」按钮，AI 将为您生成今日 A 股行情分析报告
            </div>
          </div>
        ) : loading && !content ? (
          <div className="global-analysis-loading">
            <Spin tip="正在生成分析报告..." />
          </div>
        ) : (
          <div
            className="global-analysis-text markdown-body"
            dangerouslySetInnerHTML={{ __html: marked.parse(content) }}
          />
        )}
      </div>
    </div>
  );
};

export default GlobalAnalysis;
