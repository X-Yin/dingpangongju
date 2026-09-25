import { useState, useEffect, useCallback, useRef } from 'react';
import { List, Card, Typography, Spin, Empty, message, Badge, Tag, Button, Modal, Input, Switch, Space } from 'antd';
import { BookOutlined, SyncOutlined, ClockCircleOutlined, ReloadOutlined, FileAddOutlined } from '@ant-design/icons';
import axios from 'axios';
import { isAfterMarketClose } from '../../utils/tradingDay';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { local_ip } from '../../constant';
import './index.scss';

const { Title, Text, Paragraph } = Typography;

// 是否已收盘（统一来自 utils/tradingDay，非交易日视为已收盘，交易日 9:15 前或 14:59 及以后）

// 将纯文本研报内容转换为 markdown 格式
const convertTextToMarkdown = (text) => {
  if (!text) return '';
  const lines = text.split('\n');
  const markdownLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    // 中文章节标题（一、二、三、...）
    if (/^[一二三四五六七八九十]+[、.．]/.test(trimmed)) {
      return `## ${trimmed}`;
    }
    // 数字章节标题（1. 2. 3. 或 1、2、3、），且长度较短（大概率是标题）
    if (/^\d+[、.．]/.test(trimmed) && trimmed.length < 30) {
      return `## ${trimmed}`;
    }
    return trimmed;
  });
  return markdownLines.join('\n');
};

const JigouReports = () => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reports, setReports] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  // 本次打开页面时尚未查看的新增研报 id 集合（用于标记"新增"）
  const [newIds, setNewIds] = useState(() => new Set());

  // 添加近期研报弹窗相关状态
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [addModalTitle, setAddModalTitle] = useState('');
  const [addModalImportant, setAddModalImportant] = useState(false);
  const [addModalSaving, setAddModalSaving] = useState(false);
  const addVditorRef = useRef(null);
  const addEditorInstance = useRef(null);
  // 用于在 Vditor 初始化前暂存 markdown 内容
  const addModalContentRef = useRef('');

  // 打开页面时拉取新增列表快照，随后确认查看（清空后端 pending），使左侧菜单徽标消失
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/get_jigou_reports_new`);
        if (cancelled) return;
        const ids = new Set((res.data?.newReports || []).map((r) => r.id));
        setNewIds(ids);
      } catch (e) {
        // 拉取失败不影响主流程
      }
      // 确认查看，清空后端 pending 列表
      axios.post(`http://${local_ip}:3000/ack_jigou_reports_new`).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // mode: 'init' 初次加载(全屏loading) | 'auto' 30s静默轮询 | 'manual' 手动刷新(按钮loading)
  const fetchReports = useCallback(async (mode = 'init') => {
    const isInit = mode === 'init';
    const isManual = mode === 'manual';
    const showError = mode !== 'auto';
    try {
      if (isInit) setLoading(true);
      if (isManual) setRefreshing(true);
      // 手动刷新调用 POST 接口触发 puppeteer 重新抓取，其余调用 GET 读缓存
      const res = isManual
        ? await axios.post(`http://${local_ip}:3000/refresh_jigou_reports`)
        : await axios.get(`http://${local_ip}:3000/get_jigou_reports`);
      if (res.data && Array.isArray(res.data.reports)) {
        // 过滤掉标题包含"电话会音频"的项，并去除正文中的 <e xxx> 标签
        const filtered = res.data.reports
          .filter((item) => !item.title?.includes('电话会音频'))
          .map((item) => ({
            ...item,
            text: (item.text || '').replace(/<e\s+[^>]*>/gi, ''),
          }));
        setReports(filtered);
        setLastUpdated(new Date().toLocaleTimeString());
      }
    } catch (error) {
      console.error('获取机构研报失败:', error);
      if (showError) {
        const errMsg = error.response?.data?.message || error.message;
        message.error(isManual ? `刷新研报失败: ${errMsg}` : '获取机构研报失败');
      }
    } finally {
      if (isInit) setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);
  
  useEffect(() => {
    fetchReports('init');

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

    schedulePoll(() => fetchReports('auto'), 30000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [fetchReports]);
  
  const handleRefresh = () => {
    fetchReports('manual');
  };

  // 点击"添加近期研报"按钮：打开弹窗并预填标题和内容
  const handleAddToResearchReport = (item) => {
    setAddModalTitle(item.title || '');
    setAddModalImportant(false);
    addModalContentRef.current = convertTextToMarkdown(item.text || '');
    setAddModalVisible(true);
  };

  // 弹窗打开时初始化 Vditor，关闭时销毁
  useEffect(() => {
    if (!addModalVisible) {
      // 关闭弹窗时销毁编辑器实例，避免内存泄漏与重复实例
      if (addEditorInstance.current) {
        try {
          addEditorInstance.current.destroy();
        } catch (e) {
          // 忽略销毁异常
        }
        addEditorInstance.current = null;
      }
      return;
    }
    // 弹窗打开后延迟初始化，确保 DOM 已渲染
    const timer = setTimeout(() => {
      if (!addVditorRef.current) return;
      if (addEditorInstance.current) {
        try {
          addEditorInstance.current.destroy();
        } catch (e) {
          // 忽略
        }
        addEditorInstance.current = null;
      }
      try {
        addEditorInstance.current = new Vditor(addVditorRef.current, {
          minHeight: 320,
          type: 'markdown',
          value: addModalContentRef.current,
          cache: { enable: false },
          toolbar: [
            'emoji', 'headings', 'bold', 'italic', 'strike', 'line', 'quote',
            'list', 'ordered-list', 'check', 'outdent', 'indent', 'code',
            'inline-code', 'link', 'table', 'undo', 'redo'
          ],
          input: (value) => {
            addModalContentRef.current = value;
          }
        });
      } catch (error) {
        console.error('初始化编辑器失败:', error);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [addModalVisible]);

  // 组件卸载时清理 Vditor 实例
  useEffect(() => {
    return () => {
      if (addEditorInstance.current) {
        try {
          addEditorInstance.current.destroy();
        } catch (e) {
          // 忽略
        }
        addEditorInstance.current = null;
      }
    };
  }, []);

  // 保存：自动创建当日文件夹（如不存在），将研报写入该文件夹
  const handleSaveResearchReport = async () => {
    if (!addModalTitle.trim()) {
      message.error('请输入标题');
      return;
    }
    try {
      setAddModalSaving(true);

      // 当日文件夹名称 YYYYMMDD
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const folderName = `${year}${month}${day}`;

      // 查询当前研报树，确认当日文件夹是否存在
      const treeResponse = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      const treeData = treeResponse.data || [];
      let todayFolder = treeData.find(
        (it) => it.type === 'folder' && it.name === folderName
      );

      // 不存在则创建当日文件夹
      if (!todayFolder) {
        const createFolderRes = await axios.post(
          `http://${local_ip}:3000/create_research_report`,
          { parentId: null, name: folderName, type: 'folder', content: '' }
        );
        todayFolder = createFolderRes.data.data;
      }

      // 获取编辑器内容
      const content = addEditorInstance.current
        ? addEditorInstance.current.getValue()
        : addModalContentRef.current;

      // 在当日文件夹下创建研报
      const createReportRes = await axios.post(
        `http://${local_ip}:3000/create_research_report`,
        { parentId: todayFolder.id, name: addModalTitle, type: 'report', content }
      );
      const newReport = createReportRes.data.data;

      // 若勾选"标记为重点"，调用切换接口（新建默认 isImportant=false，切换后为 true）
      if (addModalImportant) {
        await axios.post(`http://${local_ip}:3000/toggle_research_report_important`, {
          id: newReport.id
        });
      }

      message.success('已添加到近期研报');
      setAddModalVisible(false);
    } catch (error) {
      console.error('添加到近期研报失败:', error);
      message.error('添加到近期研报失败');
    } finally {
      setAddModalSaving(false);
    }
  };

  return (
    <div className="jigou-reports-page">
      <div className="page-header">
        <div className="header-left">
          <Title level={4}><BookOutlined /> 机构研报</Title>
          {lastUpdated && (
            <Text type="secondary" className="update-time">
              <ClockCircleOutlined /> 最后更新: {lastUpdated}
            </Text>
          )}
        </div>
        <div className="header-right">
          <Tag color="blue" icon={<SyncOutlined spin={loading || refreshing} />}>
            30s 自动刷新
          </Tag>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            loading={refreshing}
          >
            刷新
          </Button>
        </div>
      </div>

      <Spin spinning={loading}>
        {reports.length === 0 && !loading ? (
          <Empty description="暂无研报数据" />
        ) : (
          <List
            grid={{ gutter: 16, column: 1 }}
            dataSource={reports}
            renderItem={(item, index) => {
              const isNew = item.id != null && newIds.has(item.id);
              return (
                <List.Item>
                  <Card
                    className={`report-card${isNew ? ' report-card-new' : ''}`}
                    title={
                      <div className="report-title-container">
                        {isNew && <Tag color="red" className="new-tag">新增</Tag>}
                        <span className="report-title">{item.title || `研报内容 ${index + 1}`}</span>
                        {item.createTime && (
                          <Text type="secondary" className="report-time-inline">
                            {new Date(item.createTime).toLocaleString()}
                          </Text>
                        )}
                      </div>
                    }
                    extra={
                      <Space>
                        <Badge status="processing" text="实时" />
                        <Button
                          size="small"
                          icon={<FileAddOutlined />}
                          onClick={() => handleAddToResearchReport(item)}
                        >
                          添加近期研报
                        </Button>
                      </Space>
                    }
                  >
                    <Paragraph
                      ellipsis={{ rows: 5, expandable: true, symbol: '展开全文' }}
                      className="report-text"
                    >
                      {item.text}
                    </Paragraph>
                  </Card>
                </List.Item>
              );
            }}
          />
        )}
      </Spin>

      {/* 添加近期研报弹窗 */}
      <Modal
        title="添加到近期研报"
        open={addModalVisible}
        onOk={handleSaveResearchReport}
        onCancel={() => setAddModalVisible(false)}
        confirmLoading={addModalSaving}
        width={820}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        className="add-research-report-modal"
      >
        <div className="arr-form-row">
          <Text strong className="arr-label">标题</Text>
          <Input
            value={addModalTitle}
            onChange={(e) => setAddModalTitle(e.target.value)}
            placeholder="请输入研报标题"
            className="arr-title-input"
          />
        </div>
        <div className="arr-form-row arr-important-row">
          <Text strong className="arr-label">标记为重点</Text>
          <Switch
            checked={addModalImportant}
            onChange={(checked) => setAddModalImportant(checked)}
          />
        </div>
        <div className="arr-form-row arr-editor-row">
          <Text strong className="arr-label">内容（Markdown 格式，可二次修改）</Text>
          <div ref={addVditorRef} className="arr-vditor-container" />
        </div>
      </Modal>
    </div>
  );
};

export default JigouReports;
