import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Tabs, Button, Card, Tag, Modal, Input, Form, message,
  Spin, Empty, Typography, InputNumber, Alert, Divider, Tooltip
} from 'antd';
import {
  AppstoreOutlined, CopyOutlined, ThunderboltOutlined, PlusOutlined,
  EditOutlined, DeleteOutlined, ReloadOutlined, RobotOutlined,
  CaretRightOutlined, SearchOutlined, AreaChartOutlined, LineChartOutlined,
  BulbOutlined, MinusCircleOutlined, SortDescendingOutlined, SortAscendingOutlined, FontSizeOutlined,
  CalendarOutlined, FireOutlined
} from '@ant-design/icons';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { local_ip } from '../../constant';
import Block from '../../components/Block';
import BlockMoneyChange from '../../components/BlockMoneyChange';
import StockKLineModal from '../../components/StockKLineModal';
import './index.scss';

const { Title, Text, Paragraph } = Typography;

// 日期格式化 YYYYMMDD -> YYYY-MM-DD
const formatDateStr = (dateValue) => {
  const s = String(dateValue);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
};

// 红涨绿跌颜色
const getChangeColor = (change) => change >= 0 ? '#e11d48' : '#059669';

// ==================== 板块分类分析（重构为 dingpan 自选股全量监控风格） ====================
const ClassifySection = ({ onBlockClick }) => {
  const [classifyData, setClassifyData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [expandedKeys, setExpandedKeys] = useState(['主线', '轮动', '退潮']);

  const fetchClassify = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/classify_sector_blocks_daily`);
      setClassifyData(res.data || null);
      if (res.data?.dailyResults?.[0]?.date) {
        setSelectedDate(res.data.dailyResults[0].date);
      }
    } catch (err) {
      console.error('Fetch classify data failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClassify();
  }, [fetchClassify]);

    useEffect(() => {
      window.scrollTo(0, 0);
    }, []);

  const toggleExpand = (key) => {
    setExpandedKeys(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const dailyResults = classifyData?.dailyResults || [];
  const currentDay = dailyResults.find(d => d.date === selectedDate) || dailyResults[0];

  const totalMain = currentDay?.classification?.['主线']?.length || 0;
  const totalRotating = currentDay?.classification?.['轮动']?.length || 0;
  const totalEbbing = currentDay?.classification?.['退潮']?.length || 0;

  // 获取指定日期的主线板块
  const getMainBlocks = (dayData) => {
    return dayData?.classification?.['主线'] || [];
  };

  return (
    <Card
      className="block-config-card all-stock-card premium-style classify-section-card"
      variant="borderless"
      title={
        <div className="all-stock-card-title">
          <div className="all-stock-card-title-icon">
            <LineChartOutlined />
          </div>
          <div className="all-stock-card-title-content">
            <span>板块分类分析</span>
            <Text className="all-stock-card-title-subtext">Sector Classification</Text>
          </div>
        </div>
      }
      extra={
        <div className="all-stock-card-extra">
          <span className="all-stock-extra-dot" />
          <Text>主线 {totalMain} · 轮动 {totalRotating} · 退潮 {totalEbbing}</Text>
        </div>
      }
      bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="classify-layout">
        {/* 左侧日期菜单 */}
        <div className="classify-sidebar">
          <div className="classify-sidebar-header">
            <CalendarOutlined /> 历史日期
          </div>
          <div className="classify-date-list">
            {dailyResults.map(dayData => {
              const dateValue = dayData.date;
              const isSelected = selectedDate === dateValue;
              const mainBlocks = getMainBlocks(dayData);
              return (
                <div
                  key={dateValue}
                  className={`classify-date-item ${isSelected ? 'active' : ''}`}
                  onClick={() => setSelectedDate(dateValue)}
                >
                  <div className="classify-date-header">
                    <Text className="classify-date-label">
                      {formatDateStr(dateValue).split('-')[1]}-{formatDateStr(dateValue).split('-')[2]}
                    </Text>
                    <Text className="classify-date-year">
                      {formatDateStr(dateValue).split('-')[0]}
                    </Text>
                  </div>
                  {mainBlocks.length > 0 && (
                    <div className="classify-main-blocks">
                      <FireOutlined className="fire-icon" />
                      <div className="classify-main-block-tags">
                        {mainBlocks.slice(0, 2).map(blockName => (
                          <span key={blockName} className="main-block-tag">
                            {blockName}
                          </span>
                        ))}
                        {mainBlocks.length > 2 && (
                          <span className="main-block-more">+{mainBlocks.length - 2}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 右侧内容区域 */}
        <div className="classify-content">
          <Spin spinning={loading}>
            {!currentDay ? (
              <div style={{ padding: '40px 0' }}>
                <Empty description="暂无分类数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </div>
            ) : (
              <div className="block-groups-list classify-groups-list">
                {['主线', '轮动', '退潮'].map((category) => {
                  const expanded = expandedKeys.includes(category);
                  const list = currentDay.classification?.[category] || [];
                  const details = currentDay.details || {};
                  return (
                    <div key={category} className={`block-group-item classify-group ${expanded ? 'expanded' : ''}`}>
                      <div
                        className="block-group-header classify-group-header"
                        onClick={() => toggleExpand(category)}
                      >
                        <div className="block-group-name-cell">
                          <CaretRightOutlined className={`block-group-caret ${expanded ? 'rotated' : ''}`} />
                          <span className={`category-badge ${category === '主线' ? 'main' : category === '轮动' ? 'rotating' : 'ebbing'}`}>
                            {category}
                          </span>
                          <Tag className="block-group-count">{list.length} 个</Tag>
                        </div>
                        <div className="block-group-meta-cell">
                          <span className="category-hint">
                            {category === '主线' ? '强势持续' : category === '轮动' ? '过渡状态' : '走弱退潮'}
                          </span>
                        </div>
                      </div>
                      {expanded && (
                        <div className="block-stock-list classify-stock-list">
                          {list.length === 0 ? (
                            <div className="classify-empty">暂无 {category} 板块</div>
                          ) : (
                            list.map(name => {
                              const detail = details[name] || {};
                              const recentAvg = detail.recentAvg ?? 0;
                              return (
                                <div
                                  key={name}
                                  className="all-stock-item classify-item"
                                  onClick={() => onBlockClick(name)}
                                >
                                  <div className="stock-info-cell">
                                    <div className="stock-name-row">
                                      <Text className="stock-name">{name}</Text>
                                      {detail.reasons?.[0] && (
                                        <Text className="stock-code classify-reason">{detail.reasons[0]}</Text>
                                      )}
                                    </div>
                                  </div>
                                  <div className="change-cell">
                                    <Text className="current-change" style={{ color: getChangeColor(recentAvg) }}>
                                      {recentAvg >= 0 ? '+' : ''}{recentAvg}%
                                    </Text>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {currentDay.marketJudgment?.summaryLines && (
                  <div className="classify-judgment-card">
                    <div className="classify-judgment-title">
                      <BulbOutlined /> {formatDateStr(currentDay.date)} 情绪研判
                    </div>
                    <div className="classify-judgment-list">
                      {currentDay.marketJudgment.summaryLines.map((line, idx) => (
                        <div key={idx} className="judgment-line">{line}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Spin>
        </div>
      </div>
    </Card>
  );
};

// ==================== 板块配置 CRUD 面板（板块列表展示） ====================
const BlockConfigPanel = () => {
  const location = useLocation();
  const [blocks, setBlocks] = useState([]); // 实时板块数据（含涨跌幅）
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState('stock'); // 'stock' | 'block'
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const [klineModalVisible, setKlineModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('change'); // 'change' | 'name'
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'

  // 折叠状态：默认全部折叠；URL 携带 blockName 时仅展开该板块
  const [expandedKeys, setExpandedKeys] = useState(() => {
    const params = new URLSearchParams(location.search);
    const bn = params.get('blockName');
    return bn ? [bn] : [];
  });

  // 拉取实时板块数据（含股票涨跌幅）
  const fetchBlocks = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      if (forceRefresh) {
        // 强制刷新：先调用后端刷新 API，等待所有数据更新完成
        const refreshRes = await axios.post(`http://${local_ip}:3000/api/block/refresh`);
        if (!refreshRes.data?.success) {
          message.warning('刷新完成，但部分数据可能未更新');
        } else {
          message.success(`刷新成功！共更新 ${refreshRes.data.totalBlocks} 个板块`);
        }
      }
      // 然后加载最新数据
      const res = await axios.get(`http://${local_ip}:3000/block`);
      setBlocks(res.data || []);
    } catch (err) {
      message.error('获取板块数据失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  const toggleExpand = (blockName) => {
    setExpandedKeys(prev =>
      prev.includes(blockName) ? prev.filter(k => k !== blockName) : [...prev, blockName]
    );
  };

  const handleAdd = (blockName) => {
    setEditing(null);
    setModalMode('stock');
    form.resetFields();
    if (blockName) {
      form.setFieldsValue({ blockName });
    }
    setModalOpen(true);
  };

  const handleAddBlock = () => {
    setEditing(null);
    setModalMode('block');
    form.resetFields();
    setModalOpen(true);
  };

  const handleEdit = (stock, blockName) => {
    setEditing({ code: stock.code, name: stock.name, blockName });
    form.setFieldsValue({ code: stock.code, name: stock.name, blockName });
    setModalOpen(true);
  };

  const showKLine = (stock) => {
    setSelectedStock(stock);
    setKlineModalVisible(true);
  };

  const handleDeleteStock = (stock, blockName) => {
    Modal.confirm({
      title: '确认删除',
      content: `确认删除 ${stock.name} (${stock.code}) 从 ${blockName} 板块？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await axios.post(`http://${local_ip}:3000/api/blocks_config`, {
            action: 'delete',
            block: { code: stock.code },
          });
          if (res.data?.success) {
            message.success('删除成功');
            fetchBlocks();
          } else {
            message.error(res.data?.message || '删除失败');
          }
        } catch (err) {
          message.error('删除失败: ' + (err.response?.data?.message || err.message));
        }
      },
    });
  };

  const handleDeleteBlock = (blockName, stockCount) => {
    Modal.confirm({
      title: '确认删除整个板块',
      content: `确认删除整个 "${blockName}" 板块及其全部 ${stockCount} 只股票？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await axios.post(`http://${local_ip}:3000/api/blocks_config`, {
            action: 'deleteByName',
            blockName,
          });
          if (res.data?.success) {
            message.success('删除板块成功');
            fetchBlocks();
          } else {
            message.error(res.data?.message || '删除失败');
          }
        } catch (err) {
          message.error('删除失败: ' + (err.response?.data?.message || err.message));
        }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      let action, messageText, payload;
      if (editing) {
        action = 'update';
        messageText = '更新成功';
        payload = { block: values };
      } else if (modalMode === 'block') {
        action = 'addBlock';
        messageText = '新增板块成功';
        payload = {
          blockName: values.blockName,
          stocks: (values.stocks || []).map(s => ({
            blockName: values.blockName,
            code: s.code,
            name: s.name,
          }))
        };
      } else {
        action = 'add';
        messageText = '添加成功';
        payload = { block: values };
      }
      const res = await axios.post(`http://${local_ip}:3000/api/blocks_config`, {
        action,
        ...payload,
      });
      if (res.data?.success) {
        message.success(messageText);
        setModalOpen(false);
        form.resetFields();
        fetchBlocks();
      } else {
        message.error(res.data?.message || '操作失败');
      }
    } catch (err) {
      if (err.errorFields) return; // 表单校验错误
      message.error('操作失败: ' + (err.response?.data?.message || err.message));
    }
  };

  // 搜索过滤：匹配板块名或股票名/代码
  const filteredBlocks = blocks
    .filter(block => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      if (block.blockName.toLowerCase().includes(q)) return true;
      return block.data.some(s =>
        s.name.toLowerCase().includes(q) || (s.code || '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (sortBy === 'change') {
        const diff = sortOrder === 'desc' ? b.avgChange - a.avgChange : a.avgChange - b.avgChange;
        return diff !== 0 ? diff : a.blockName.localeCompare(b.blockName, 'zh-CN');
      } else {
        const cmp = a.blockName.localeCompare(b.blockName, 'zh-CN');
        return sortOrder === 'desc' ? -cmp : cmp;
      }
    });

  const totalCount = blocks.reduce((s, b) => s + (b.data?.length || 0), 0);

  return (
    <Card
      className="block-config-card all-stock-card premium-style"
      variant="borderless"
      title={
        <div className="all-stock-card-title">
          <div className="all-stock-card-title-icon">
            <AreaChartOutlined />
          </div>
          <div className="all-stock-card-title-content">
            <span>板块列表监控</span>
            <Text className="all-stock-card-title-subtext">Block Flow Board</Text>
          </div>
        </div>
      }
      extra={
        <div className="all-stock-card-extra">
          <span className="all-stock-extra-dot" />
          <Text>{filteredBlocks.length} / {blocks.length} 板块 · {totalCount} 只股票</Text>
        </div>
      }
      bodyStyle={{ padding: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="all-stock-toolbar">
        <div className="all-stock-filter-row">
          <Input
            placeholder="搜索板块 / 股票名称 / 代码"
            prefix={<SearchOutlined className="all-stock-search-icon" />}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            allowClear
            className="all-stock-input search-input"
            style={{ flex: 1, height: 40 }}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => fetchBlocks(true)}
            className="all-stock-filter-btn refresh-filter-btn"
            style={{ height: 40 }}
          >
            刷新
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={handleAddBlock}
            className="all-stock-filter-btn add-filter-btn"
            style={{ height: 40 }}
          >
            新增板块
          </Button>
          <Button
            icon={sortBy === 'change' ? (sortOrder === 'desc' ? <SortDescendingOutlined /> : <SortAscendingOutlined />) : <FontSizeOutlined />}
            onClick={() => {
              if (sortBy === 'change') {
                setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
              } else {
                setSortBy('change');
                setSortOrder('desc');
              }
            }}
            className="all-stock-filter-btn"
            style={{ height: 40 }}
          >
            {sortBy === 'change' ? (sortOrder === 'desc' ? '涨幅从高到低' : '涨幅从低到高') : '按名称排序'}
          </Button>
        </div>
      </div>

      <Spin spinning={loading}>
        {filteredBlocks.length === 0 ? (
          <div style={{ padding: '40px 0' }}>
            <Empty description={searchQuery ? "未匹配到板块" : "暂无板块数据"} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          <div className="block-groups-list">
            {filteredBlocks.map(block => {
              const expanded = expandedKeys.includes(block.blockName);
              const avgUp = block.avgChange >= 0;
              return (
                <div key={block.blockName} className={`block-group-item ${expanded ? 'expanded' : ''}`}>
                  <div
                    className="block-group-header"
                    onClick={() => toggleExpand(block.blockName)}
                  >
                    <div className="block-group-name-cell">
                      <CaretRightOutlined className={`block-group-caret ${expanded ? 'rotated' : ''}`} />
                      <Text strong className="block-group-name">{block.blockName}</Text>
                      <Tag className="block-group-count">{block.data.length} 只</Tag>
                    </div>
                    <div className="block-group-meta-cell">
                      <Text
                        className={`block-group-avg ${avgUp ? 'up' : 'down'}`}
                      >
                        {block.avgChange > 0 ? '+' : ''}{block.avgChange}%
                      </Text>
                      <Button
                        size="small"
                        type="text"
                        icon={<PlusOutlined />}
                        className="block-group-add-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAdd(block.blockName);
                        }}
                      >
                        添加
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        className="block-group-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteBlock(block.blockName, block.data.length);
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="block-stock-list">
                      {block.data.length === 0 ? (
                        <div style={{ padding: '20px', textAlign: 'center', color: '#999', fontSize: '13px' }}>
                          暂无股票，点击「添加」按钮添加股票
                        </div>
                      ) : block.data
                        .filter(s => {
                          if (!searchQuery) return true;
                          // 板块名命中搜索时，展示该板块全部股票
                          if (block.blockName.toLowerCase().includes(searchQuery.toLowerCase())) return true;
                          // 否则仅展示命中搜索的股票
                          return s.name.toLowerCase().includes(searchQuery.toLowerCase())
                            || (s.code || '').toLowerCase().includes(searchQuery.toLowerCase());
                        })
                        .map(stock => {
                          const isUp = stock.change >= 0;
                          const hasMarketData = !stock.noMarketData;
                          return (
                            <div
                              key={stock.code || stock.name}
                              className={`all-stock-item ${hasMarketData ? '' : 'no-market-data'}`}
                              data-is-up={isUp}
                              onClick={() => hasMarketData && showKLine(stock)}
                              style={hasMarketData ? {} : { cursor: 'default' }}
                            >
                              <div className="stock-info-cell">
                                <div className="stock-name-row">
                                  <Text className="stock-name">{stock.name}</Text>
                                  <Text className="stock-code">{stock.code}</Text>
                                </div>
                              </div>
                              <div className="change-cell">
                                {hasMarketData ? (
                                  <Text className="current-change">
                                    {stock.change > 0 ? '+' : ''}{stock.change}%
                                  </Text>
                                ) : (
                                  <Text className="current-change no-data" style={{ color: '#999' }}>
                                    待更新
                                  </Text>
                                )}
                              </div>
                              <div className="stock-action-cell">
                                <Tooltip title="编辑">
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={<EditOutlined />}
                                    className="stock-edit-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleEdit(stock, block.blockName);
                                    }}
                                  />
                                </Tooltip>
                                <div
                                  className="delete-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteStock(stock, block.blockName);
                                  }}
                                >
                                  <DeleteOutlined />
                                </div>
                              </div>
                            </div>
                          );
                        })
                      }
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Spin>

      <Modal
        title={editing ? '编辑股票' : modalMode === 'block' ? '新增板块' : '新增股票'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={modalMode === 'block' ? 600 : 480}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="blockName" label="板块名称" rules={[{ required: true, message: '请输入板块名' }]}>
            <Input placeholder="请输入板块名称" />
          </Form.Item>
          {modalMode === 'block' && !editing ? (
            <Form.List name="stocks">
              {(fields, { add, remove }) => (
                <>
                  <div style={{ marginBottom: 8, color: '#64748b', fontSize: 13 }}>
                    可在此添加多只股票（选填）
                  </div>
                  {fields.map(({ key, name, ...restField }) => (
                    <div key={key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <Form.Item
                        {...restField}
                        name={[name, 'code']}
                        rules={[{ required: true, message: '必填' }]}
                        style={{ marginBottom: 0, flex: 1 }}
                      >
                        <Input placeholder="股票代码，如 sh688981" />
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'name']}
                        rules={[{ required: true, message: '必填' }]}
                        style={{ marginBottom: 0, flex: 1 }}
                      >
                        <Input placeholder="股票名称，如 中芯国际" />
                      </Form.Item>
                      <MinusCircleOutlined
                        onClick={() => remove(name)}
                        style={{ fontSize: 22, color: '#ff4d4f', marginTop: 4 }}
                      />
                    </div>
                  ))}
                  <Button
                    type="dashed"
                    onClick={() => add()}
                    block
                    icon={<PlusOutlined />}
                  >
                    添加股票
                  </Button>
                </>
              )}
            </Form.List>
          ) : (
            <>
              <Form.Item name="code" label="股票代码" rules={[{ required: true, message: '请输入股票代码' }]}>
                <Input placeholder="例如：sh688981、sz002371" disabled={!!editing} />
              </Form.Item>
              <Form.Item name="name" label="股票名称" rules={[{ required: true, message: '请输入股票名称' }]}>
                <Input placeholder="例如：中芯国际" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      <StockKLineModal
        visible={klineModalVisible}
        onCancel={() => setKlineModalVisible(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.name,
          change: selectedStock?.change,
        }}
      />
    </Card>
  );
};

// ==================== AI 分析面板 ====================
const BlockAiPanel = () => {
  const [days, setDays] = useState(10);
  const [contextLoading, setContextLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [analysis, setAnalysis] = useState('');
  const [contextInfo, setContextInfo] = useState(null);
  const storedContextRef = useRef(null);

  const handleCopyContext = async () => {
    setContextLoading(true);
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/api/block_ai_context`,
        { days },
        { timeout: 120000 }
      );
      if (res.data?.success) {
        storedContextRef.current = res.data;
        setContextInfo(res.data);
        await navigator.clipboard.writeText(res.data.prompt);
        message.success('上下文已复制到剪贴板，可粘贴到智谱/豆包等对话');
      } else {
        message.error(res.data?.message || '获取上下文失败');
      }
    } catch (err) {
      message.error('获取上下文失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setContextLoading(false);
    }
  };

  const handleRunAi = async () => {
    setAiLoading(true);
    setAnalysis('');
    try {
      const res = await axios.post(
        `http://${local_ip}:3000/api/block_ai_analysis`,
        { days },
        { timeout: 300000 }
      );
      if (res.data?.success) {
        setAnalysis(res.data.analysis);
      } else {
        message.error(res.data?.message || 'AI 分析失败');
      }
    } catch (err) {
      message.error('AI 分析失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="block-ai-panel">
      <Card
        className="ai-analysis-card all-stock-card premium-style"
        variant="borderless"
        title={
          <div className="ai-card-header">
            <div className="ai-card-header-title">
              <RobotOutlined className="ai-card-header-icon" />
              <div>
                <div className="ai-card-header-main">AI 分析</div>
                <div className="ai-card-header-sub">板块资金流向与轮动智能研判</div>
              </div>
            </div>
            <div className="ai-card-header-actions">
              <div className="ai-days-row">
                <Text type="secondary" className="ai-days-label">分析天数</Text>
                <InputNumber min={3} max={30} value={days} onChange={(v) => setDays(v || 10)} style={{ width: 70 }} />
              </div>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleRunAi}
                loading={aiLoading}
                disabled={contextLoading}
                className="ai-action-btn ai-run-btn"
              >
                AI 分析
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={handleCopyContext}
                loading={contextLoading}
                disabled={aiLoading}
                className="ai-action-btn ai-copy-btn"
              >
                拷贝上下文
              </Button>
            </div>
          </div>
        }
        bodyStyle={{ padding: 0 }}
      >
        <div className="ai-content">

          {contextInfo && (
            <div className="context-info">
              <Tag color="blue">区间：{contextInfo.dateDisplay}</Tag>
              <Tag color="cyan">天数：{contextInfo.days}</Tag>
              <Tag color="purple">资金分时点：{contextInfo.dataInfo?.blockMoneyTimeCount || 0}</Tag>
              <Tag color="geekblue">涨跌分时点：{contextInfo.dataInfo?.blockChangeTimeCount || 0}</Tag>
              <Tag color="magenta">研究报告：{contextInfo.dataInfo?.researchReportsCount || 0}</Tag>
              <Tag color="orange">机构调研：{contextInfo.dataInfo?.jigouReportsCount || 0}</Tag>
              <Tag color="green">创业板K线：{contextInfo.dataInfo?.cybKlineCount || 0}</Tag>
              <Tag color="red">科技情绪：{contextInfo.dataInfo?.techIndexCount || 0}</Tag>
            </div>
          )}

          <div className="ai-result-wrapper">
            <Spin spinning={aiLoading} tip="AI 分析中...">
              {analysis ? (
                <div className="ai-analysis-result">
                  <Divider orientation="left"><RobotOutlined /> AI 分析结果</Divider>
                  <div className="ai-markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{analysis}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                <Empty description="点击「AI 分析」生成报告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </Spin>
          </div>
        </div>
      </Card>
    </div>
  );
};

// ==================== 智能分析 Tab（含 技术分析 + AI 分析 两个子 tab） ====================
const SmartAnalysisPanel = ({ onBlockClick, defaultSubTab = 'tech' }) => {
  return (
    <Tabs
      defaultActiveKey={defaultSubTab}
      className="smart-analysis-tabs"
      items={[
        {
          key: 'tech',
          label: '技术分析',
          children: <ClassifySection onBlockClick={onBlockClick} />,
        },
        {
          key: 'ai',
          label: 'AI 分析',
          children: <BlockAiPanel />,
        },
      ]}
    />
  );
};

// ==================== 主页面 ====================
const KeyBlocks = () => {
  const location = useLocation();
  const navigate = useNavigate();

  // 当前 tab 从 URL 派生，避免 useEffect 中同步 setState
  const activeTab = useMemo(() => {
    // 兼容旧 /block_money_change 路径，默认进入资金 tab
    if (location.pathname.includes('block_money_change')) return 'money';
    const params = new URLSearchParams(location.search);
    const t = params.get('tab');
    if (t === 'money' || t === 'smart') return t;
    return 'trend';
  }, [location.search, location.pathname]);

  // 智能分析子 tab（tech / ai），支持从其他页面直达 AI 分析
  const smartSubTab = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const s = params.get('subTab');
    return s === 'ai' ? 'ai' : 'tech';
  }, [location.search]);

  // 板块资金内部子 tab（intraday/history/rzrq/crowd/dayAmount），支持从收盘流水线等外部直达拥挤度
  const moneySubTab = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const s = params.get('subTab');
    return ['intraday', 'history', 'rzrq', 'crowd', 'dayAmount'].includes(s) ? s : 'intraday';
  }, [location.search]);

  const handleTabChange = (key) => {
    const params = new URLSearchParams(location.search);
    if (key === 'trend') params.delete('tab');
    else params.set('tab', key);
    navigate({ search: params.toString() }, { replace: true });
  };

  // 点击板块名（分类标签 / 资金面板）跳转到走势 tab 并定位
  const handleBlockClick = (blockName) => {
    const params = new URLSearchParams();
    params.set('blockName', blockName);
    params.set('no_auto_scroll', '1');
    params.set('tab', 'trend');
    navigate({ search: params.toString() });
  };

  return (
    <div className="key-blocks-container">
      <div className="page-header">
        <div className="header-left">
          <Title level={4}><AppstoreOutlined /> 重点板块</Title>
        </div>
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        destroyInactiveTabPane={false}
        items={[
          {
            key: 'trend',
            label: '板块走势',
            children: (
              <>
                <Block embedded />
                <div className="key-blocks-extra">
                  <BlockConfigPanel />
                </div>
              </>
            ),
          },
          {
            key: 'money',
            label: '板块资金',
            children: <BlockMoneyChange key={moneySubTab} defaultTab={moneySubTab} />,
          },
          {
            key: 'smart',
            label: '智能分析',
            children: <SmartAnalysisPanel key={smartSubTab} onBlockClick={handleBlockClick} defaultSubTab={smartSubTab} />,
          },
        ]}
      />
    </div>
  );
};

export default KeyBlocks;
