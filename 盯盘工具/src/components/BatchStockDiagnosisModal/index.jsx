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

const PROMPT_TEXT = '根据这些股票的分时数据和他们跟踪的指数（sh688开头的跟踪科创板，其他的跟踪创业板）分时数据，1. 判断哪些个股当天表现更主动强势。强势的意思就是，指数下跌的时候它不怎么下跌，但是指数上涨的时候，它大幅度上涨，资金具备很强的主动性，而非是单纯跟着指数被动涨跌。具体你可以这么计算，比如指数每下跌 1%，股票下跌 x%，指数每上涨 1%，股票上涨 y%, 你可以通过对比 x 和 y 来看它的弹性如何，是否具备更强的抢筹主动性。然后你需要给这些个股进行强势主动性的排名，从高到低，并且给出你计算的弹性数据。2. 根据股票的分时盘口数据你来分析一下主导的资金是什么类型，比如游资还是大体量私募，还是稳健型公募。预测一下未来一段时间的趋势如何';

const BatchStockDiagnosisModal = ({ visible, onCancel, stocks = [] }) => {
  const [status, setStatus] = useState('idle'); // idle | fetching | ready | analyzing | done | error
  const [content, setContent] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [indexLabels, setIndexLabels] = useState([]);
  const [contextObj, setContextObj] = useState(null);
  const [copyLoading, setCopyLoading] = useState(false);
  const abortRef = useRef(null);

  const prepareData = async () => {
    if (!stocks.length) return;
    setStatus('fetching');
    setContent('');
    setErrorMsg('');
    setContextObj(null);

    try {
      // 并行获取所有个股分时数据
      const stockRequests = stocks.map((s) =>
        axios
          .get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: s.code } })
          .then((res) => ({
            stock: s,
            line: res.data?.line || [],
          }))
          .catch((err) => {
            console.error(`获取 ${s.code} 分时数据失败:`, err);
            return { stock: s, line: [], error: true };
          })
      );
      const stockResults = await Promise.all(stockRequests);

      // 确定需要获取的指数：sh688 开头取科创50，其余取创业板指，混合则两者都取
      const indexCodeSet = new Set();
      stocks.forEach((s) => indexCodeSet.add(getIndexCode(s.code)));
      const indexCodes = Array.from(indexCodeSet);

      const indexResults = await Promise.all(
        indexCodes.map((code) =>
          axios
            .get(`http://${local_ip}:3000/stock_tline_data`, { params: { code } })
            .then((res) => ({ code, line: res.data?.line || [] }))
        )
      );

      setIndexLabels(indexCodes.map((c) => `${getIndexName(c)}(${c})`));

      const stockList = stockResults.map(({ stock, line }) => ({
        股票名称: stock.stockName,
        股票代码: stock.code,
        跟踪指数: getIndexName(getIndexCode(stock.code)),
        分时数据: line,
      }));

      const indexList = indexResults.map(({ code, line }) => ({
        指数名称: getIndexName(code),
        指数代码: code,
        分时数据: line,
      }));

      setContextObj({
        待诊断股票列表: stockList,
        跟踪指数分时数据: indexList,
      });
      setStatus('ready');
    } catch (err) {
      console.error('获取分时数据失败:', err);
      setStatus('error');
      setErrorMsg(err.message || '获取分时数据失败');
    }
  };

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
    if (visible && stocks.length) {
      prepareData();
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, stocks]);

  const title = (
    <Space wrap>
      <ThunderboltOutlined style={{ color: '#722ed1' }} />
      <span>批量个股诊断</span>
      <Typography.Text strong>共 {stocks.length} 只</Typography.Text>
      {indexLabels.map((label) => (
        <Tag color="purple" key={label}>
          {label}
        </Tag>
      ))}
    </Space>
  );

  return (
    <Modal
      title={title}
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={900}
      centered
      destroyOnClose
      className="stock-diagnosis-modal batch-diagnosis-modal"
    >
      <div className="diagnosis-content">
        {status === 'fetching' && (
          <div className="status-box">
            <Spin size="large" />
            <div className="status-text">正在获取 {stocks.length} 只个股分时数据...</div>
          </div>
        )}

        {status === 'error' && !contextObj && (
          <Empty description={errorMsg || '获取分时数据失败'} />
        )}

        {contextObj && (
          <>
            <div className="stock-summary">
              {contextObj.待诊断股票列表.map((s) => (
                <Tag key={s.股票代码} color="blue">
                  {s.股票名称}({s.股票代码})
                </Tag>
              ))}
            </div>

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
                <Button icon={<CopyOutlined />} onClick={handleCopyQuestion} loading={copyLoading}>
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

export default BatchStockDiagnosisModal;
