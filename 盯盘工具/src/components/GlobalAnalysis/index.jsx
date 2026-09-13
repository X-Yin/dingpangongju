import { useState, useRef, useEffect } from 'react';
import { Button, Spin, message, Modal, Checkbox } from 'antd';
import { ThunderboltOutlined, CopyOutlined, SelectOutlined } from '@ant-design/icons';
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
  const [contextModalVisible, setContextModalVisible] = useState(false);
  const [contextData, setContextData] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState([]);

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

  const getDataDescription = (value) => {
    if (Array.isArray(value)) return `数组 [${value.length}项]`;
    if (value !== null && typeof value === 'object') return `对象 [${Object.keys(value).length}字段]`;
    if (typeof value === 'string') return `字符串 [${value.length}字符]`;
    if (typeof value === 'number') return '数值';
    return typeof value;
  };

  const openContextModal = async () => {
    setContextModalVisible(true);
    setContextLoading(true);
    try {
      const res = await fetch(`http://${local_ip}:3000/global_analysis_data`);
      if (!res.ok) {
        message.error('获取数据失败');
        return;
      }
      const data = await res.json();
      setContextData(data);
      // setSelectedKeys(Object.keys(data));
    } catch (err) {
      console.error('获取上下文数据失败:', err);
      message.error('获取数据失败');
    } finally {
      setContextLoading(false);
    }
  };

  const handleCopyContext = async () => {
    const selectedObj = {};
    selectedKeys.forEach(key => {
      if (contextData[key] !== undefined) {
        selectedObj[key] = contextData[key];
      }
    });
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedObj));
      message.success('已复制到剪贴板');
      setContextModalVisible(false);
    } catch (err) {
      console.error('复制失败:', err);
      message.error('复制失败');
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
        // AI 返回的是 SSE 格式，每行以 data: 开头
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta || {};
            // 优先取 content，为空时回退到 reasoning_content（DeepSeek 思考模式）
            const text = delta.content || delta.reasoning_content || '';
            if (text) {
              result += text;
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
            icon={<SelectOutlined />}
            onClick={openContextModal}
          >
            选择复制上下文
          </Button>
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

      <Modal
        title="选择复制上下文"
        open={contextModalVisible}
        onCancel={() => setContextModalVisible(false)}
        onOk={handleCopyContext}
        okText="复制到剪贴板"
        cancelText="取消"
        width={600}
        centered
        okButtonProps={{ disabled: selectedKeys.length === 0 }}
      >
        <Spin spinning={contextLoading}>
          {contextData && Object.keys(contextData).length > 0 && (
            <div className="context-select-container">
              <div className="context-select-header">
                <Checkbox
                  indeterminate={selectedKeys.length > 0 && selectedKeys.length < Object.keys(contextData).length}
                  checked={selectedKeys.length === Object.keys(contextData).length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedKeys(Object.keys(contextData));
                    } else {
                      setSelectedKeys([]);
                    }
                  }}
                >
                  全选 ({selectedKeys.length}/{Object.keys(contextData).length})
                </Checkbox>
              </div>
              <div className="context-checkbox-list">
                {Object.keys(contextData).map(key => (
                  <div key={key} className="context-checkbox-item">
                    <Checkbox
                      checked={selectedKeys.includes(key)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedKeys([...selectedKeys, key]);
                        } else {
                          setSelectedKeys(selectedKeys.filter(k => k !== key));
                        }
                      }}
                    >
                      <span className="context-key">{key}</span>
                      <span className="context-desc">{getDataDescription(contextData[key])}</span>
                    </Checkbox>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Spin>
      </Modal>
    </div>
  );
};

export default GlobalAnalysis;
