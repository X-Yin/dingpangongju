import { useState, useEffect, useRef } from 'react';
import { Modal, Button, Input, Spin, Tooltip, Tag, message } from 'antd';
import {
  FileTextOutlined,
  ThunderboltOutlined,
  RobotOutlined,
  AreaChartOutlined,
  ReloadOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { marked } from 'marked';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import './index.scss';

marked.setOptions({ breaks: true, gfm: true });

// 全局分析提问文案（与 GlobalAnalysis 组件保持一致）
const GLOBAL_QUESTION = `1. 当前大盘的整体情况，风格如何，主线是什么，退潮的是什么？
2. 哪些板块的资金有明显异动？比如加速流出，流出放缓，加速流入，流入放缓，先流出后流入，先流入后流出等。
3. 哪些板块的涨幅有明显异动？比如加速下跌，下跌放缓，加速上涨，上涨放缓，先下跌后上涨，先上涨后下跌等。
4. 哪些个股的上涨或者下跌和机构的研报有明显关联的？
5. 整体做个总结`;

const formatDate = (d) => {
  if (!d) return '';
  return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
};

// 点击时间自动填充到感受输入框的市场数据文案字段（数据来源：/fupan/market_snapshot）
const SNAPSHOT_FIELDS = [
  { key: 'cybChange', label: '创业板', suffix: '%' },
  { key: 'kcbChange', label: '科创板', suffix: '%' },
  { key: 'techEmotion', label: '科技情绪' },
  { key: 'mainMoney', label: '资金流入', suffix: '亿', signed: true },
  { key: 'amountChangeDiff', label: '成交量', suffix: '亿', signed: true },
];

const isFieldEmpty = (v) => v === undefined || v === null || v === '';

const PersonalFeelingModal = ({
  visible,
  date,
  records,
  saving,
  onFeelingChange,
  onSave,
  onCancel,
}) => {
  // 正在自动填充市场数据文案的时段
  const [fillingTime, setFillingTime] = useState(null);
  // 中间列：AI 总结今日行情（流式）
  const [globalContent, setGlobalContent] = useState('');
  const [globalLoading, setGlobalLoading] = useState(false);
  const globalAbortRef = useRef(null);
  const globalRunIdRef = useRef(0);

  // 右侧列：AI 总结今日资金成交量行为
  const [fundLoading, setFundLoading] = useState(false);
  const [fundResult, setFundResult] = useState(null);
  const fundRunIdRef = useRef(0);

  // 弹窗关闭时中止进行中的流式请求
  useEffect(() => {
    if (!visible) {
      if (globalAbortRef.current) {
        globalAbortRef.current.abort();
        globalAbortRef.current = null;
      }
      return;
    }
  }, [visible]);

  // AI 分析模块是否已展开（中间/右列默认隐藏，点击标题栏「AI 分析今日行情」后展开并自动分析）
  const [showAI, setShowAI] = useState(false);
  // 当前获得焦点的感受输入框对应时段，用于展示输入框上方的快捷 tag
  const [focusedTime, setFocusedTime] = useState(null);

  // 情绪记录输入框上方快捷 tag：第一个回填市场数据，其余以换行追加文案
  const FEELING_TAGS = [
    { key: 'current', label: '当下行情' },
    { key: 'hengpan', label: '指数横盘震荡' },
    { key: 'lazheng', label: '大幅拉升' },
    { key: 'dadie', label: '大幅下跌' },
    { key: 'liangsuo', label: '成交量大幅萎缩' },
    { key: 'liangzeng', label: '成交量大幅增加' },
    { key: 'ziliu', label: '资金大幅流入' },
    { key: 'zichu', label: '资金大幅流出' },
  ];

  // 当前时间（每 30s 刷新一次），用于判定哪些时段已到可编辑、哪些未到需禁用
  const [nowStr, setNowStr] = useState(() => dayjs().format('HH:mm'));
  useEffect(() => {
    const timer = setInterval(() => setNowStr(dayjs().format('HH:mm')), 3000);
    return () => clearInterval(timer);
  }, []);

  // 组件卸载时中止请求
  useEffect(() => {
    return () => {
      if (globalAbortRef.current) {
        globalAbortRef.current.abort();
      }
    };
  }, []);

  // 全局分析（流式，逻辑与 GlobalAnalysis.fetchAnalysis 一致）
  const runGlobalAnalysis = async () => {
    // 中止上一次未完成的请求
    if (globalAbortRef.current) {
      globalAbortRef.current.abort();
    }
    const runId = ++globalRunIdRef.current;
    const controller = new AbortController();
    globalAbortRef.current = controller;
    setGlobalLoading(true);
    setGlobalContent('');

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
          content: `根据所传入的数据，分析一下相关行情，${GLOBAL_QUESTION}`,
          context,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (runId === globalRunIdRef.current) setGlobalContent('请求失败，请稍后重试');
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
              if (runId === globalRunIdRef.current) setGlobalContent(result);
            }
          } catch (e) {
            // 忽略解析失败的片段
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('全局分析请求失败:', err);
        if (runId === globalRunIdRef.current) setGlobalContent('请求失败，请稍后重试');
      }
    } finally {
      if (runId === globalRunIdRef.current) setGlobalLoading(false);
      if (globalAbortRef.current === controller) globalAbortRef.current = null;
    }
  };

  // 主力资金 AI 总结（逻辑与 MainFund.handleAiSummary 一致）
  const runFundSummary = async () => {
    const runId = ++fundRunIdRef.current;
    setFundLoading(true);
    setFundResult(null);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/main_fund/ai_summary`,
        {},
        { timeout: 300000 }
      );
      if (runId !== fundRunIdRef.current) return;
      if (res.data?.success) {
        setFundResult(res.data.data);
      } else {
        setFundResult({ analysis: res.data?.message || 'AI 总结失败' });
      }
    } catch (err) {
      if (runId !== fundRunIdRef.current) return;
      setFundResult({ analysis: 'AI 总结失败: ' + (err.response?.data?.message || err.message) });
    } finally {
      if (runId === fundRunIdRef.current) setFundLoading(false);
    }
  };

  const themeColor = getThemeColor();

  // 点击时间：拉取当前市场快照，把「创业板：xx，科创板：xx，…」文案填入右侧感受输入框
  // 「当下行情」独占一行：前面有内容时先换行再填入，行尾再补一个换行，让后续输入/标签从下一行开始，不覆盖用户输入
  const handleTimeClick = async (record) => {
    if (record.time > nowStr) return; // 未到时段不可填
    if (fillingTime) return;
    setFillingTime(record.time);
    try {
      const res = await axios.get(`http://${local_ip}:3000/fupan/market_snapshot`);
      const snap = res.data?.data || {};
      const parts = SNAPSHOT_FIELDS
        .filter(f => !isFieldEmpty(snap[f.key]))
        .map(f => {
          let v = snap[f.key];
          if (f.signed) v = Number(v) >= 0 ? `+${v}` : `${v}`;
          return `${f.label}：${v}${f.suffix || ''}`;
        });
      if (parts.length === 0) {
        message.warning('未获取到市场数据');
        return;
      }
      const line = parts.join('，');
      const prev = record.feeling || '';
      const prefix = prev && !prev.endsWith('\n') ? `${prev}\n` : prev;
      onFeelingChange(record.time, `${prefix}${line}\n`);
    } catch (err) {
      console.error('自动填充市场数据失败:', err);
      message.error('获取市场数据失败');
    } finally {
      setFillingTime(null);
    }
  };

  // 点击标题栏「AI 分析今日行情」：展开 AI 分析模块并默认直接调用后端 AI 进行分析
  const handleShowAI = () => {
    if (!showAI) setShowAI(true);
    runGlobalAnalysis();
    runFundSummary();
  };

  // 点击输入框上方快捷 tag：「当下行情」回填市场数据并在 textarea 新开一行，其余 tag 追加在最后一行末尾（与前面内容用逗号分隔）
  const handleFeelingTagClick = (tag, record) => {
    if (record.time > nowStr) return; // 未到时段不可操作
    if (tag.key === 'current') {
      handleTimeClick(record);
    } else {
      const prev = record.feeling || '';
      let next;
      if (!prev) {
        next = tag.label;
      } else if (prev.endsWith('\n')) {
        // 已有内容以换行结尾，直接在新行追加，无需逗号
        next = `${prev}${tag.label}`;
      } else {
        // 追加在最后一行末尾，用逗号分隔
        next = `${prev}，${tag.label}`;
      }
      onFeelingChange(record.time, next);
    }
  };

  return (
    <Modal
      title={
        <div className="pfm-modal-title">
          <span>
            <FileTextOutlined style={{ color: themeColor, marginRight: '8px' }} />
            📝 个人感受记录 {date ? `- ${formatDate(date)}` : ''}
          </span>
          <Button
            type="primary"
            size="small"
            icon={<RobotOutlined />}
            onClick={handleShowAI}
            loading={showAI && (globalLoading || fundLoading)}
            className="pfm-ai-toggle-btn"
          >
            AI 分析今日行情
          </Button>
        </div>
      }
      open={visible}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={onSave}>
          保存感受
        </Button>,
      ]}
      width={1800}
      centered
      className="personal-feeling-modal"
    >
      <div className={`pfm-container${showAI ? ' pfm-container-ai' : ''}`}>
        {/* 左列：情绪记录 */}
        <div className="pfm-col pfm-col-feeling">
          <div className="pfm-col-header">
            <div className="pfm-col-title-icon pfm-col-title-icon-feeling">
              <AreaChartOutlined />
            </div>
            <div className="pfm-col-title-content">
              <span className="pfm-col-title">情绪记录</span>
              <span className="pfm-col-subtitle">Feeling Journal</span>
            </div>
          </div>
          <div className="pfm-feeling-list">
            {records.length === 0 ? (
              <div className="pfm-empty">暂无记录时段</div>
            ) : (
              records.map((record) => {
                const editable = record.time <= nowStr;
                const isLatest = editable && record.time === records
                  .filter(r => r.time <= nowStr)
                  .reduce((latest, r) => (r.time > latest ? r.time : latest), '00:00');
                const filling = fillingTime === record.time;
                const showTags = editable && focusedTime === record.time;
                return (
                  <div
                    key={record.time}
                    className={`pfm-feeling-item${editable ? '' : ' pfm-feeling-item-disabled'}${isLatest ? ' pfm-feeling-item-latest' : ''}`}
                  >
                    <Tooltip title={editable ? '点击填入当前市场数据（创业板/科创板/科技情绪/资金流入/成交量）' : '该时段尚未到'}>
                      <div
                        className={`pfm-feeling-time${editable ? ' pfm-feeling-time-clickable' : ''}`}
                        onClick={() => handleTimeClick(record)}
                      >
                        {isLatest && (
                          <span className="pfm-feeling-badge">当前</span>
                        )}
                        {!editable && (
                          <span className="pfm-feeling-lock">未到</span>
                        )}
                        <span className="pfm-feeling-time-text">
                          {filling && <LoadingOutlined className="pfm-feeling-loading" />}
                          {record.time}
                        </span>
                      </div>
                    </Tooltip>
                    <div className="pfm-input-wrap">
                      {showTags && (
                        <div className="pfm-feeling-tags">
                          {FEELING_TAGS.map((tag) => (
                            <Tag
                              key={tag.key}
                              className="pfm-feeling-tag"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleFeelingTagClick(tag, record)}
                            >
                              {tag.label}
                            </Tag>
                          ))}
                        </div>
                      )}
                      <Input.TextArea
                        value={record.feeling}
                        onChange={(e) => onFeelingChange(record.time, e.target.value)}
                        onFocus={() => setFocusedTime(record.time)}
                        onBlur={() => setFocusedTime((t) => (t === record.time ? null : t))}
                        placeholder={editable ? '输入当时的感受，或点击左侧时间填入市场数据...' : '该时段尚未到，暂不可编辑'}
                        disabled={!editable}
                        autoSize={{ minRows: 2, maxRows: 6 }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 中列：AI 总结今日行情 */}
        {showAI && (<>
        <div className="pfm-col pfm-col-global">
          <div className="pfm-col-header">
            <div className="pfm-col-title-icon pfm-col-title-icon-global">
              <ThunderboltOutlined />
            </div>
            <div className="pfm-col-title-content">
              <span className="pfm-col-title">AI 总结今日行情</span>
              <span className="pfm-col-subtitle">Market Analysis</span>
            </div>
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={runGlobalAnalysis}
              loading={globalLoading}
              className="pfm-refresh-btn"
              title="重新分析"
            />
          </div>
          <div className="pfm-ai-body">
            {globalLoading && !globalContent ? (
              <div className="pfm-ai-loading">
                <Spin />
                <div className="pfm-ai-loading-text">正在生成行情分析报告…</div>
              </div>
            ) : globalContent ? (
              <div
                className="pfm-ai-text markdown-body"
                dangerouslySetInnerHTML={{ __html: marked.parse(globalContent) }}
              />
            ) : (
              <div className="pfm-ai-empty">
                <ThunderboltOutlined className="pfm-ai-empty-icon" />
                <div className="pfm-ai-empty-text">点击右上角刷新按钮生成分析</div>
              </div>
            )}
          </div>
        </div>

        {/* 右列：总结今日资金成交量行为 */}
        <div className="pfm-col pfm-col-fund">
          <div className="pfm-col-header">
            <div className="pfm-col-title-icon pfm-col-title-icon-fund">
              <RobotOutlined />
            </div>
            <div className="pfm-col-title-content">
              <span className="pfm-col-title">资金成交量总结</span>
              <span className="pfm-col-subtitle">Fund Behavior</span>
            </div>
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={runFundSummary}
              loading={fundLoading}
              className="pfm-refresh-btn"
              title="重新总结"
            />
          </div>
          <div className="pfm-ai-body">
            {fundLoading ? (
              <div className="pfm-ai-loading">
                <Spin />
                <div className="pfm-ai-loading-text">正在拉取资金数据并调用 AI 分析…</div>
                <div className="pfm-ai-loading-sub">首次运行需拉取历史数据，请耐心等待</div>
              </div>
            ) : fundResult ? (
              <div className="pfm-ai-content">
                <div className="pfm-ai-meta">
                  {fundResult.currentTime && <span>分析时间: {fundResult.currentTime}</span>}
                  {fundResult.model && <span>模型: {fundResult.model}</span>}
                  {fundResult.dataInfo && (
                    <span>
                      上下文: 创业板{fundResult.dataInfo.cybHistoryDays}天 + 科创
                      {fundResult.dataInfo.kcbHistoryDays}天
                    </span>
                  )}
                </div>
                <div
                  className="pfm-ai-text markdown-body"
                  dangerouslySetInnerHTML={{
                    __html: marked.parse(fundResult.analysis || ''),
                  }}
                />
              </div>
            ) : (
              <div className="pfm-ai-empty">
                <RobotOutlined className="pfm-ai-empty-icon" />
                <div className="pfm-ai-empty-text">点击右上角刷新按钮生成总结</div>
              </div>
            )}
          </div>
        </div>
        </>)}
      </div>
    </Modal>
  );
};

export default PersonalFeelingModal;
