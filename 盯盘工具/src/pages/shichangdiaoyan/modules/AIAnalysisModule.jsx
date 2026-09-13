import React, { useState, useRef, useEffect } from 'react';
import { Button, Card, Spin, message, Empty, Space, Tooltip, Input } from 'antd';
import { ThunderboltOutlined, CopyOutlined, HistoryOutlined, EditOutlined, SaveOutlined, CloseOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import axios from 'axios';
import { local_ip } from '../../../constant';
import dayjs from 'dayjs';
import './AIAnalysisModule.scss';

// 配置 marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

const AIAnalysisModule = () => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  const abortRef = useRef(null);

  // 获取历史分析记录
  const fetchHistoryAnalysis = async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_market_style_analysis`);
      if (res.data && res.data.content) {
        setContent(res.data.content);
        setEditContent(res.data.content);
        setLastUpdateTime(res.data.updatedAt);
        setHasStarted(true);
      }
    } catch (error) {
      console.error('获取历史分析失败:', error);
    }
  };

  const handleManualSave = async () => {
    setSaveLoading(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/update_market_style_analysis`, {
        content: editContent
      });
      setContent(editContent);
      setLastUpdateTime(res.data.updatedAt);
      setIsEditing(false);
      message.success('保存成功');
    } catch (error) {
      console.error('保存失败:', error);
      message.error('保存失败');
    } finally {
      setSaveLoading(false);
    }
  };

  const handleStartEdit = () => {
    setEditContent(content);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent(content);
  };

  useEffect(() => {
    fetchHistoryAnalysis();
  }, []);

  // 组件卸载时中止进行中的请求
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const fetchAllData = async () => {
    try {
      const [blockRes, timelineRes, ganttRes] = await Promise.all([
        axios.get(`http://${local_ip}:3000/block_day_history`),
        axios.get(`http://${local_ip}:3000/get_timeline`),
        axios.get(`http://${local_ip}:3000/get_market_rhythm_gantt`)
      ]);

      return {
        '板块涨幅历史数据': blockRes.data,
        '未来大事时间线': timelineRes.data,
        '未开市场节奏甘特图数据': ganttRes.data
      };
    } catch (error) {
      console.error('获取上下文数据失败:', error);
      throw new Error('获取数据失败，请检查后端服务');
    }
  };

  const handleCopyData = async () => {
    setCopyLoading(true);
    try {
      const context = await fetchAllData();
      const question = `根据以下内容，分析一下接下来市场的主要风格是什么样的？需要回答几个问题：
1. 未来一段时间是炒业绩 or 炒概念
2. 未来一段时间是偏科技成长 or 偏红利老登
3. 如果是科技成长偏向哪几个板块？如果是老登红利又偏向哪几个板块？
4. 未来一段时间是极致抱团 or 快速轮动。
5. 分析一下接下来市场的主要风格是什么样的

Context Data:
${JSON.stringify(context, null, 2)}`;

      await navigator.clipboard.writeText(question);
      message.success('提问数据已复制到剪贴板');
    } catch (error) {
      message.error(error.message || '复制失败');
    } finally {
      setCopyLoading(false);
    }
  };

  const startAnalysis = async () => {
    setLoading(true);
    setContent('');
    setHasStarted(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const context = await fetchAllData();
      const question = `根据所传入的数据，分析一下接下来市场的主要风格是什么样的？需要回答几个问题：
1. 未来一段时间是炒业绩 or 炒概念
2. 未来一段时间是偏科技成长 or 偏红利老登
3. 如果是科技成长偏向哪几个板块？如果是老登红利又偏向哪几个板块？
4. 未来一段时间是极致抱团 or 快速轮动。
5. 分析一下接下来市场的主要风格是什么样的`;

      const response = await fetch(`http://${local_ip}:3000/api/zhipu_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: question,
          context: context,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        setContent('AI 分析请求失败，请稍后重试');
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
              setEditContent(result);
            }
          } catch (e) {
            // 忽略解析失败的片段
          }
        }
      }

      // 分析完成后，保存到后端
      try {
        const saveRes = await axios.post(`http://${local_ip}:3000/update_market_style_analysis`, {
          content: result
        });
        setLastUpdateTime(saveRes.data.updatedAt);
      } catch (saveError) {
        console.error('保存分析结果失败:', saveError);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('AI 分析失败:', err);
        setContent('分析过程中出错，请检查网络或后端服务');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="ai-analysis-module">
      <Card 
        title={
          <div className="analysis-title-wrapper">
            <div className="title-main">
              <ThunderboltOutlined style={{ color: '#722ed1' }} />
              <span>AI 分析市场风格</span>
            </div>
            {lastUpdateTime && (
              <div className="last-update">
                <HistoryOutlined style={{ fontSize: '12px' }} />
                <span>上次分析时间：{dayjs(lastUpdateTime).format('YYYY-MM-DD HH:mm:ss')}</span>
              </div>
            )}
          </div>
        }
        extra={
          <Space>
            {hasStarted && !loading && (
              <>
                {isEditing ? (
                  <Space>
                    <Button 
                      icon={<CloseOutlined />} 
                      onClick={handleCancelEdit}
                    >
                      取消
                    </Button>
                    <Button 
                      type="primary"
                      icon={<SaveOutlined />} 
                      onClick={handleManualSave}
                      loading={saveLoading}
                    >
                      保存修改
                    </Button>
                  </Space>
                ) : (
                  <Button 
                    icon={<EditOutlined />} 
                    onClick={handleStartEdit}
                  >
                    编辑内容
                  </Button>
                )}
              </>
            )}
            <Tooltip title="复制提问上下文">
              <Button 
                icon={<CopyOutlined />} 
                onClick={handleCopyData} 
                loading={copyLoading}
                shape="circle"
              />
            </Tooltip>
            <Button 
              type="primary" 
              icon={<ThunderboltOutlined />} 
              onClick={startAnalysis}
              loading={loading}
              className="analysis-btn"
              style={{ 
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #722ed1 0%, #2f54eb 100%)',
                border: 'none',
                boxShadow: '0 4px 12px rgba(114, 46, 209, 0.3)'
              }}
            >
              {loading ? '分析中...' : '开始 AI 风格分析'}
            </Button>
          </Space>
        }
      >
        <div className="ai-content-area">
          {!hasStarted ? (
            <Empty 
              description={
                <div style={{ color: '#8c8c8c' }}>
                  <p>点击「开始 AI 风格分析」</p>
                  <p style={{ fontSize: '12px' }}>AI 将结合板块走势、时间线及节奏推演数据为您深度解析</p>
                </div>
              } 
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: '40px 0' }}
            />
          ) : loading && !content ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 0' }}>
              <Spin size="large" />
              <div style={{ marginTop: 16, color: '#722ed1', fontWeight: 500 }}>正在解析市场风格，请稍候...</div>
            </div>
          ) : isEditing ? (
            <div style={{ padding: '12px' }}>
              <Input.TextArea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                autoSize={{ minRows: 10, maxRows: 30 }}
                style={{ 
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  borderRadius: '8px',
                  backgroundColor: '#f5f5f5'
                }}
              />
            </div>
          ) : (
            <div 
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: marked.parse(content) }}
            />
          )}
        </div>
      </Card>
    </div>
  );
};

export default AIAnalysisModule;
