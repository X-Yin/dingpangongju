import { useState, useEffect, useRef } from 'react';
import { Modal, Spin, Typography, Tag, Space, Empty, Button, message, Tooltip } from 'antd';
import { ThunderboltOutlined, CopyOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import axios from 'axios';
import { local_ip } from '../../constant';
import './index.scss';

marked.setOptions({ breaks: true, gfm: true });

// 根据股票代码前缀确定跟踪的指数：sh688 开头对应科创50，其余对应创业板指
const getIndexCode = (code) => {
  if (code && code.startsWith('sh688')) return 'sh000688';
  return 'sz399006';
};

const getIndexName = (indexCode) => {
  return indexCode === 'sh000688' ? '科创50指数' : '创业板指';
};

const PROMPT_TEXT = '根据当前股票分时数据和跟踪的指数分时数据，1. 分析一下该指数当天表现是否强势。强势的意思就是，指数下跌的时候它不怎么下跌，但是指数上涨的时候，它大幅度上涨，资金具备很强的主动性，而非是单纯跟着指数被动涨跌。具体你可以这么计算，比如指数每下跌 1%，股票下跌 x%，指数每上涨 1%，股票上涨 y%, 你可以通过对比 x 和 y 来看它的弹性如何，是否具备更强的抢筹主动性。2. 根据股票的分时盘口数据你来分析一下主导的资金是什么类型，比如游资还是大体量私募，还是稳健型公募。预测一下未来一段时间的趋势如何';

const StockDiagnosisModal = ({ visible, onCancel, code, stockName }) => {
  const [status, setStatus] = useState('idle'); // idle | fetching | ready | analyzing | done | error
  const [content, setContent] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [indexLabel, setIndexLabel] = useState('');
  const [contextObj, setContextObj] = useState(null);
  const [copyLoading, setCopyLoading] = useState(false);
  const abortRef = useRef(null);

  // 打开弹窗时只获取分时数据，不调用智谱接口
  const prepareData = async () => {
    setStatus('fetching');
    setContent('');
    setErrorMsg('');
    setContextObj(null);
    const indexCode = getIndexCode(code);
    setIndexLabel(`${getIndexName(indexCode)}(${indexCode})`);

    try {
      const stockRes = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code } });
      const stockLine = stockRes.data?.line || [];
      const indexRes = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: indexCode } });
      const indexLine = indexRes.data?.line || [];

      setContextObj({
        '当前股票名称': stockName,
        '当前股票代码': code,
        '当前股票分时数据': stockLine,
        '跟踪指数名称': getIndexName(indexCode),
        '跟踪指数代码': indexCode,
        '跟踪指数分时数据': indexLine,
      });
      setStatus('ready');
    } catch (err) {
      console.error('获取分时数据失败:', err);
      setStatus('error');
      setErrorMsg(err.message || '获取分时数据失败');
    }
  };

  // 点击「开始 AI 分析」后才调用智谱接口
  const startAnalysis = async () => {
    if (!contextObj) return;
    setStatus('analyzing');
    setContent('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`http://${local_ip}:3000/api/zhipu_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: PROMPT_TEXT, context: contextObj }),
        signal: controller.signal,
      });

      if (!response.ok) {
        setStatus('error');
        setErrorMsg(`AI 分析请求失败: ${response.status}`);
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
      setStatus('done');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('诊断失败:', err);
      setStatus('error');
      setErrorMsg(err.message || '诊断过程中出错');
    } finally {
      abortRef.current = null;
    }
  };

  // 复制 prompt + context 到剪贴板，便于粘贴到其他 AI 提问
  const handleCopyQuestion = async () => {
    if (!contextObj) return;
    setCopyLoading(true);
    try {
      const text = `${PROMPT_TEXT}\n\nContext Data:\n${JSON.stringify(contextObj, null, 2)}`;
      await navigator.clipboard.writeText(text);
      message.success('提问信息已复制到剪贴板');
    } catch (err) {
      console.error('复制失败:', err);
      message.error('复制失败');
    } finally {
      setCopyLoading(false);
    }
  };

  useEffect(() => {
    if (visible && code) {
      prepareData();
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, code]);

  const title = (
    <Space>
      <ThunderboltOutlined style={{ color: '#722ed1' }} />
      <span>个股诊断</span>
      {stockName && <Typography.Text strong>{stockName}</Typography.Text>}
      {code && <Typography.Text type="secondary">({code})</Typography.Text>}
      {indexLabel && <Tag color="purple">{indexLabel}</Tag>}
    </Space>
  );

  return (
    <Modal
      title={title}
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={800}
      centered
      destroyOnClose
      className="stock-diagnosis-modal"
    >
      <div className="diagnosis-content">
        {status === 'fetching' && (
          <div className="status-box">
            <Spin size="large" />
            <div className="status-text">正在获取分时数据...</div>
          </div>
        )}

        {status === 'error' && !contextObj && (
          <Empty description={errorMsg || '获取分时数据失败'} />
        )}

        {contextObj && (
          <>
            <div className="action-bar">
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={startAnalysis}
                loading={status === 'analyzing'}
                style={{
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #722ed1 0%, #2f54eb 100%)',
                  border: 'none',
                  boxShadow: '0 4px 12px rgba(114, 46, 209, 0.3)',
                }}
              >
                {status === 'analyzing' ? '分析中...' : '开始 AI 分析'}
              </Button>
              <Tooltip title="复制 prompt 和 context 数据，可粘贴到其他 AI 提问">
                <Button
                  icon={<CopyOutlined />}
                  onClick={handleCopyQuestion}
                  loading={copyLoading}
                >
                  复制信息(推荐去kimi)
                </Button>
              </Tooltip>
            </div>

            <div className="result-area">
              {status === 'analyzing' && !content && (
                <div className="status-box">
                  <Spin size="large" />
                  <div className="status-text">正在分析个股表现，请稍候...</div>
                </div>
              )}
              {status === 'error' && <Empty description={errorMsg || '分析失败'} />}
              {status === 'ready' && (
                <Empty
                  description="分时数据已就绪，点击「开始 AI 分析」开始诊断"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              )}
              {((status === 'analyzing' && content) || status === 'done') && (
                <div className="markdown-body" dangerouslySetInnerHTML={{ __html: marked.parse(content) }} />
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default StockDiagnosisModal;
