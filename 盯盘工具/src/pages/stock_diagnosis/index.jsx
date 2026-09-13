import { useState, useEffect } from 'react';
import { Table, Card, Typography, Spin, Input, Button, Modal, Space, message, Tag, Tabs } from 'antd';
import { FundOutlined, SearchOutlined, RadarChartOutlined, ThunderboltOutlined, LineChartOutlined, RiseOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import StockDiagnosisModal from '../../components/StockDiagnosisModal';
import BatchStockDiagnosisModal from '../../components/BatchStockDiagnosisModal';
import MultiStockTimeLineModal from '../../components/MultiStockTimeLineModal';
import TechnicalDiagnosisTab from './TechnicalDiagnosisTab';
import ResilienceDiagnosisTab from './ResilienceDiagnosisTab';
import SingleStockDiagnosisModal from './SingleStockDiagnosisModal';
import IntradayDiagnosisModal from './IntradayDiagnosisModal';
import TradePointDiagnosisTab from './TradePointDiagnosisTab';
import TrendDiagnosisTab from './TrendDiagnosisTab';
import PremiumDiagnosisTab from './PremiumDiagnosisTab';
import { getThemeColor } from '../../utils/theme';
import './index.scss';

const { Title } = Typography;

const StockDiagnosis = () => {
  const [loading, setLoading] = useState(true);
  const [stockList, setStockList] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [klineModalOpen, setKlineModalOpen] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [diagnosisModalOpen, setDiagnosisModalOpen] = useState(false);
  const [diagnosisStock, setDiagnosisStock] = useState(null);
  const [selectModalOpen, setSelectModalOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [selectSearchText, setSelectSearchText] = useState('');
  const [batchDiagnosisOpen, setBatchDiagnosisOpen] = useState(false);
  const [batchStocks, setBatchStocks] = useState([]);
  const [searchParams] = useSearchParams();
  const [resilienceDiagnosisOpen, setResilienceDiagnosisOpen] = useState(false);
  const [resilienceResultOpen, setResilienceResultOpen] = useState(false);
  const [resilienceStocks, setResilienceStocks] = useState([]);
  const [resilienceResults, setResilienceResults] = useState([]);
  const [resilienceLoading, setResilienceLoading] = useState(false);
  const [resilienceSelectSearchText, setResilienceSelectSearchText] = useState('');
  const [multiTimeLineOpen, setMultiTimeLineOpen] = useState(false);
  const [multiTimeLineStocks, setMultiTimeLineStocks] = useState([]);
  const [activeTab, setActiveTab] = useState('tradePoint');
  const [technicalLoading, setTechnicalLoading] = useState(false);
  const [technicalData, setTechnicalData] = useState(null);
  const [technicalError, setTechnicalError] = useState('');
  const [multiDayData, setMultiDayData] = useState(null);
  const [multiDayLoading, setMultiDayLoading] = useState(false);
  const [multiDayError, setMultiDayError] = useState('');
  const [batchAddImportantLoading, setBatchAddImportantLoading] = useState(false);
  const [singleStockDiagnosisOpen, setSingleStockDiagnosisOpen] = useState(false);
  const [intradayDiagnosisOpen, setIntradayDiagnosisOpen] = useState(false);

  const fetchStockData = async () => {
    try {
      setLoading(true);
      const res = await axios.get(`http://${local_ip}:3000/get_all_stock_data`);
      if (Array.isArray(res.data)) {
        setStockList(res.data);
      }
    } catch (error) {
      console.error('获取个股诊断数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchTechnicalDiagnosis = async (forceRefresh = false) => {
    try {
      setTechnicalLoading(true);
      setTechnicalError('');
      const query = forceRefresh ? '?forceRefresh=1' : '';
      const res = await axios.get(`http://${local_ip}:3000/technical_diagnosis${query}`);
      if (res.data?.success) {
        setTechnicalData(res.data.data || null);
        return;
      }
      setTechnicalError(res.data?.message || '技术诊断加载失败');
    } catch (error) {
      console.error('获取技术诊断失败:', error);
      setTechnicalError(error?.response?.data?.message || error.message || '技术诊断加载失败');
    } finally {
      setTechnicalLoading(false);
    }
  };

  const fetchMultiDayResilience = async (forceRefresh = false) => {
    try {
      setMultiDayLoading(true);
      setMultiDayError('');
      const query = forceRefresh ? '?forceRefresh=1' : '';
      const res = await axios.get(`http://${local_ip}:3000/diagnose_resilience_multi_day${query}`);
      if (res.data?.success) {
        setMultiDayData(res.data.data || null);
        return;
      }
      setMultiDayError(res.data?.message || '多日诊断加载失败');
    } catch (error) {
      console.error('获取多日抗分歧诊断失败:', error);
      setMultiDayError(error?.response?.data?.message || error.message || '多日诊断加载失败');
    } finally {
      setMultiDayLoading(false);
    }
  };

  const handleBatchAddImportant = async (codes) => {
    if (!codes || !codes.length) {
      message.warning('暂无转强股票可添加');
      return;
    }
    try {
      setBatchAddImportantLoading(true);
      const res = await axios.post(`http://${local_ip}:3000/batch_set_important`, { codes });
      if (res.data?.success) {
        const { updatedCount, totalRequested } = res.data;
        if (updatedCount > 0) {
          message.success(`已将 ${updatedCount} 只股票加入重点监控（共 ${totalRequested} 只）`);
        } else {
          message.info('所有转强股票已在重点监控中，无需重复添加');
        }
        await fetchStockData();
      } else {
        message.error(res.data?.message || '添加重点失败');
      }
    } catch (error) {
      console.error('批量添加重点失败:', error);
      message.error('批量添加重点失败');
    } finally {
      setBatchAddImportantLoading(false);
    }
  };

  // 从抗分歧多日诊断表格打开单只股票+跟踪指数的叠加分时
  const handleOpenMultiTimeLineFromResilience = (stocks) => {
    const stocksWithIndex = [];
    const addedCodes = new Set();
    for (const s of stocks) {
      if (!addedCodes.has(s.code)) {
        stocksWithIndex.push(s);
        addedCodes.add(s.code);
      }
      const isSh688 = s.code.startsWith('sh688');
      const indexCode = isSh688 ? 'sh000688' : 'sz399006';
      const indexName = isSh688 ? '科创50' : '创业板指';
      if (!addedCodes.has(indexCode)) {
        stocksWithIndex.push({ code: indexCode, stockName: indexName });
        addedCodes.add(indexCode);
      }
    }
    setMultiTimeLineStocks(stocksWithIndex);
    setMultiTimeLineOpen(true);
  };

  const handleOpenSingleStockDiagnosis = () => {
    const stocks = stockList.map(item => ({
      code: item.code,
      stockName: item.stockName,
    }));
    setSingleStockDiagnosisOpen(true);
  };

  const handleOpenIntradayDiagnosis = () => {
    setIntradayDiagnosisOpen(true);
  };

  const handleToggleImportantFromTechnical = async (record) => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/toggle_stock_important`, { code: record.code });
      if (!res.data?.success) {
        message.error(res.data?.message || '加入重点监控失败');
        return;
      }

      const nextImportant = !record.isImportant;
      setTechnicalData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          categories: (prev.categories || []).map((category) => ({
            ...category,
            stocks: (category.stocks || []).map((item) => (
              item.code === record.code ? { ...item, isImportant: nextImportant } : item
            )),
          })),
        };
      });
      setStockList((prev) => prev.map((item) => (
        item.code === record.code ? { ...item, isImportant: nextImportant } : item
      )));
      message.success(nextImportant ? '已加入重点监控' : '已取消重点监控');
    } catch (error) {
      console.error('切换重点监控失败:', error);
      message.error('加入重点监控失败');
    }
  };

  useEffect(() => {
    fetchStockData();
  }, []);

  useEffect(() => {
    if (activeTab === 'technical' && !technicalData && !technicalLoading) {
      fetchTechnicalDiagnosis();
    }
  }, [activeTab, technicalData, technicalLoading]);

  // 切换到抗分歧诊断 tab 时，自动加载缓存数据（后端已通过 pollResilienceMultiDay 每 15 分钟刷新缓存）
  useEffect(() => {
    if (activeTab === 'resilience' && !multiDayData && !multiDayLoading) {
      fetchMultiDayResilience();
    }
  }, [activeTab, multiDayData, multiDayLoading]);

  

  // 通过路由查询参数自动打开指定股票的诊断弹窗
  useEffect(() => {
    const autoDiagnose = searchParams.get('autoDiagnose');
    const backtest = searchParams.get('backtest');
    const code = searchParams.get('code');
    const name = searchParams.get('name');
    if (autoDiagnose === '1' && code) {
      setDiagnosisStock({ code, stockName: name || '' });
      setDiagnosisModalOpen(true);
    }
    if (backtest === '1') {
      setActiveTab('tradePoint');
    }
  }, [searchParams]);

  // 打开抗分歧诊断选股弹窗
  const handleOpenResilienceDiagnosis = () => {
    setResilienceStocks([]);
    setResilienceSelectSearchText('');
    setResilienceDiagnosisOpen(true);
  };

  // 确认抗分歧诊断选股
  const handleConfirmResilienceSelect = () => {
    const picked = stockList.filter((item) => resilienceStocks.includes(item.code));
    if (!picked.length) {
      message.warning('请至少选择一只股票');
      return;
    }
    setResilienceDiagnosisOpen(false);
    executeResilienceDiagnosis(picked);
  };

  // 执行抗分歧诊断
  const executeResilienceDiagnosis = async (stocks) => {
    setResilienceLoading(true);
    setResilienceResultOpen(true);
    try {
      const stockCodes = stocks.map(s => s.code);
      const res = await axios.post(`http://${local_ip}:3000/diagnose_resilience`, { stockCodes });
      if (res.data.success) {
        setResilienceResults(res.data.data);
      } else {
        message.error(res.data.message || '诊断失败');
      }
    } catch (error) {
      console.error('抗分歧诊断失败:', error);
      message.error('诊断失败');
    } finally {
      setResilienceLoading(false);
    }
  };

  // 抗分歧诊断选股弹窗内的搜索过滤
  const resilienceSelectFilteredStockList = resilienceSelectSearchText
    ? stockList.filter(
        (item) =>
          item.stockName?.toLowerCase().includes(resilienceSelectSearchText.toLowerCase()) ||
          item.code?.toLowerCase().includes(resilienceSelectSearchText.toLowerCase())
      )
    : stockList;

  // 获取当前选中股票完整信息（抗分歧诊断）
  const resilienceSelectedStockItems = stockList.filter(item => resilienceStocks.includes(item.code));

  // 打开 K 线图弹窗
  const handleStockClick = (record) => {
    setSelectedStock(record);
    setKlineModalOpen(true);
  };

  // 打开个股诊断弹窗
  const handleDiagnosis = (record) => {
    setDiagnosisStock(record);
    setDiagnosisModalOpen(true);
  };

  // 打开批量选股弹窗
  const handleOpenBatchSelect = () => {
    setSelectedRowKeys([]);
    setSelectSearchText('');
    setSelectModalOpen(true);
  };

  // 确认批量选股，打开批量诊断弹窗
  const handleConfirmBatchSelect = () => {
    const picked = stockList.filter((item) => selectedRowKeys.includes(item.code));
    if (!picked.length) {
      message.warning('请至少选择一只股票');
      return;
    }
    setBatchStocks(picked);
    setSelectModalOpen(false);
    setBatchDiagnosisOpen(true);
  };

  // 取消单只选中
  const removeSelectItem = (code) => {
    setSelectedRowKeys(selectedRowKeys.filter(key => key !== code));
  };

  // 清空全部选中
  const clearAllSelect = () => {
    setSelectedRowKeys([]);
  };

  // 根据搜索文本过滤股票列表
  const filteredStockList = searchText
    ? stockList.filter(
        (item) =>
          item.stockName?.toLowerCase().includes(searchText.toLowerCase()) ||
          item.code?.toLowerCase().includes(searchText.toLowerCase())
      )
    : stockList;

  // 批量选股弹窗内的搜索过滤
  const selectFilteredStockList = selectSearchText
    ? stockList.filter(
        (item) =>
          item.stockName?.toLowerCase().includes(selectSearchText.toLowerCase()) ||
          item.code?.toLowerCase().includes(selectSearchText.toLowerCase())
      )
    : stockList;

  // 获取当前选中股票完整信息
  const selectedStockItems = stockList.filter(item => selectedRowKeys.includes(item.code));

  const columns = [
    {
      title: '排名',
      key: 'rank',
      width: 60,
      align: 'center',
      render: (_, __, index) => (
        <span className={`rank-badge rank-${index < 3 ? 'top' : 'normal'}`}>
          {index + 1}
        </span>
      ),
    },
    {
      title: '股票名称',
      dataIndex: 'stockName',
      key: 'stockName',
      width: 120,
      render: (text, record) => (
        <span className="stock-name clickable" onClick={() => handleStockClick(record)}>
          {text}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      align: 'center',
      render: (_, record) => (
        <Button
          type="primary"
          size="small"
          icon={<RadarChartOutlined />}
          onClick={() => handleDiagnosis(record)}
        >
          诊断
        </Button>
      ),
    },
    {
      title: '最新价',
      dataIndex: 'close_px',
      key: 'close_px',
      width: 100,
      align: 'right',
      render: (val) => val?.toFixed(2) || '-',
    },
    {
      title: '涨跌幅',
      dataIndex: 'change',
      key: 'change',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.change - b.change,
      defaultSortOrder: 'descend',
      render: (val) => (
        <span className={`change-value ${val > 0 ? 'up' : val < 0 ? 'down' : 'flat'}`}>
          {val > 0 ? '+' : ''}{val?.toFixed(2)}%
        </span>
      ),
    },
    {
      title: '涨跌额',
      dataIndex: 'change_px',
      key: 'change_px',
      width: 100,
      align: 'right',
      render: (val) => (
        <span className={val > 0 ? 'up' : val < 0 ? 'down' : 'flat'}>
          {val > 0 ? '+' : ''}{val?.toFixed(2)}
        </span>
      ),
    },
    {
      title: '最高价',
      dataIndex: 'high_px',
      key: 'high_px',
      width: 100,
      align: 'right',
      render: (val) => val?.toFixed(2) || '-',
    },
    {
      title: '最低价',
      dataIndex: 'low_px',
      key: 'low_px',
      width: 100,
      align: 'right',
      render: (val) => val?.toFixed(2) || '-',
    },
    {
      title: '成交额',
      dataIndex: 'business_balance',
      key: 'business_balance',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.business_balance || 0) - (b.business_balance || 0),
      render: (val) => {
        if (!val) return '-';
        if (val >= 100000000) return `${(val / 100000000).toFixed(2)}亿`;
        if (val >= 10000) return `${(val / 10000).toFixed(2)}万`;
        return val.toFixed(2);
      },
    },
  ];

const selectColumns = [
  {
    title: '股票名称',
    dataIndex: 'stockName',
    key: 'stockName',
    width: 130,
    render: (text) => (
      <span style={{ 
        fontWeight: 500,
        color: '#1a1a1a',
        fontSize: '14px',
        display: 'block',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        overflow: 'hidden'
      }}>
        {text}
      </span>
    )
  },
  {
    title: '代码',
    dataIndex: 'code',
    key: 'code',
    width: 100,
    render: (text) => (
      <span style={{ 
        color: '#595959',
        fontSize: '13px',
        fontFamily: 'monospace',
        letterSpacing: '0.5px'
      }}>
        {text}
      </span>
    )
  },
  {
    title: '最新价',
    dataIndex: 'close_px',
    key: 'close_px',
    width: 95,
    align: 'right',
    render: (val) => (
      <span style={{ 
        color: val != null ? '#1a1a1a' : '#bfbfbf',
        fontWeight: val != null ? 500 : 400,
        fontSize: '14px',
        display: 'inline-block',
        minWidth: '60px',
        textAlign: 'right'
      }}>
        {val != null ? val.toFixed(2) : '-'}
      </span>
    )
  },
  {
    title: '涨跌幅',
    dataIndex: 'change',
    key: 'change',
    width: 100,
    align: 'right',
    sorter: (a, b) => a.change - b.change,
    render: (val) => {
      // 语义化颜色处理（中国股市红涨绿跌）
      const getColor = () => {
        if (val == null) return '#bfbfbf';
        if (val > 0) return '#cf1322';  // 深红色（上涨）
        if (val < 0) return '#389e0d';  // 深绿色（下跌）
        return '#8c8c8c';  // 灰色（持平）
      };

      return (
        <span style={{ 
          color: getColor(),
          fontWeight: val !== 0 ? 500 : 400,
          fontSize: '14px',
          display: 'inline-block',
          minWidth: '65px',
          textAlign: 'right',
          fontFamily: 'Arial, sans-serif'
        }}>
          {val == null ? '-' : 
           `${val > 0 ? '+' : ''}${Math.abs(val).toFixed(2)}%`}
        </span>
      );
    }
  },
];

  const aiDiagnosisContent = (
    <>
      <div className="tab-toolbar">
        <Space>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={handleOpenBatchSelect}
            style={{
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #722ed1 0%, #2f54eb 100%)',
              border: 'none',
              boxShadow: '0 4px 12px rgba(114, 46, 209, 0.3)',
            }}
          >
            批量诊断
          </Button>
        </Space>
        <Input
          placeholder="搜索股票名称或代码"
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          allowClear
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="search-input"
          style={{ width: 240 }}
        />
      </div>
      <Card className="diagnosis-card" bordered={false}>
        {loading ? (
          <div className="loading-container">
            <Spin size="large" />
          </div>
        ) : (
          <Table
            columns={columns}
            dataSource={filteredStockList}
            rowKey="code"
            pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (total) => `共 ${total} 只股票` }}
            size="middle"
            scroll={{ x: 1200 }}
          />
        )}
      </Card>
    </>
  );

  const tabItems = [
    {
      key: 'tradePoint',
      label: (
        <span>
          <FundOutlined style={{ marginRight: 4 }} />
          买卖点诊断
        </span>
      ),
      children: <TradePointDiagnosisTab onStockClick={handleStockClick} backtest={searchParams.get('backtest')} code={searchParams.get('code')} name={searchParams.get('name')} codes={searchParams.get('codes')} names={searchParams.get('names')} autoBacktest={searchParams.get('autoBacktest')} days={searchParams.get('days')} />,
    },
        {
      key: 'technical',
      label: '技术诊断',
      children: (
        <TechnicalDiagnosisTab
          loading={technicalLoading}
          technicalData={technicalData}
          technicalError={technicalError}
          onRefresh={fetchTechnicalDiagnosis}
          onStockClick={handleStockClick}
          onDiagnosis={handleDiagnosis}
          onToggleImportant={handleToggleImportantFromTechnical}
        />
      ),
    },
        {
      key: 'resilience',
      label: '抗分歧诊断',
      children: (
        <ResilienceDiagnosisTab
          multiDayData={multiDayData}
          multiDayLoading={multiDayLoading}
          multiDayError={multiDayError}
          onRefreshMultiDay={fetchMultiDayResilience}
          onOpenCompare={handleOpenResilienceDiagnosis}
          onStockClick={handleStockClick}
          onOpenMultiTimeLine={handleOpenMultiTimeLineFromResilience}
          onBatchAddImportant={handleBatchAddImportant}
          batchAddImportantLoading={batchAddImportantLoading}
          onOpenSingleStockDiagnosis={handleOpenSingleStockDiagnosis}
          onOpenIntradayDiagnosis={handleOpenIntradayDiagnosis}
        />
      ),
    },
    {
      key: 'premium',
      label: '溢价诊断',
      children: <PremiumDiagnosisTab />,
    },
    {
      key: 'trend',
      label: (
        <span>
          <RiseOutlined style={{ marginRight: 4 }} />
          趋势诊断
        </span>
      ),
      children: <TrendDiagnosisTab onStockClick={handleStockClick} />,
    },
    {
      key: 'ai',
      label: 'AI 诊断',
      children: aiDiagnosisContent,
    },
  ];

  return (
    <div className="stock-diagnosis">
      <div className="page-header">
        <Title level={4}>
          <FundOutlined style={{ marginRight: 8, color: getThemeColor() }} />
          个股诊断
        </Title>
      </div>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} className="diagnosis-tabs" />

      <StockKLineModal
        visible={klineModalOpen}
        onCancel={() => setKlineModalOpen(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.stockName,
          code: selectedStock?.code,
          change: selectedStock?.change,
        }}
      />

      <StockDiagnosisModal
        visible={diagnosisModalOpen}
        onCancel={() => setDiagnosisModalOpen(false)}
        code={diagnosisStock?.code}
        stockName={diagnosisStock?.stockName}
      />

<Modal
  style={{ maxWidth: '95vw' }}
  bodyStyle={{ 
    padding: '16px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  }}
  title="批量选股诊断"
  open={selectModalOpen}
  onCancel={() => setSelectModalOpen(false)}
  onOk={handleConfirmBatchSelect}
  okText={`确认诊断(${selectedRowKeys.length})`}
  cancelText="取消"
  width={720}
  centered
  destroyOnClose
>
  {/* 顶部已选股票展示区域 */}
  <div style={{ 
    border: '1px solid #f0f0f0',
    borderRadius: '8px',
    padding: '12px 16px',
    backgroundColor: '#f9f9f9'
  }}>
    <div style={{ 
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '12px'
    }}>
      <span style={{ 
        fontWeight: 500,
        color: '#1a1a1a',
        fontSize: '14px'
      }}>已选股票（{selectedStockItems.length}只）</span>
      {selectedStockItems.length > 0 && (
        <Button 
          type="link" 
          size="small" 
          style={{ padding: 0, height: 'auto' }}
          onClick={clearAllSelect}
        >
          清空全部
        </Button>
      )}
    </div>
    
    <div style={{ 
      display: 'flex',
      flexWrap: 'wrap',
      gap: '8px',
      minHeight: '40px',
      padding: '4px 0',
      maxHeight: '120px',
      overflowY: 'auto',
      paddingRight: '8px'
    }}>
      {selectedStockItems.length === 0 ? (
        <span style={{ 
          color: '#bfbfbf',
          fontSize: '13px',
          padding: '8px 0'
        }}>暂无选中股票，请在下方表格勾选</span>
      ) : (
        selectedStockItems.map(item => (
          <Tag
            key={item.code}
            style={{ 
              display: 'flex',
              alignItems: 'center',
              background: '#e6f7ff',
              border: '1px solid #91d5ff',
              borderRadius: '4px',
              padding: '0 8px',
              height: '28px',
              fontSize: '13px'
            }}
            closable
            onClose={() => removeSelectItem(item.code)}
          >
            {item.stockName}({item.code})
          </Tag>
        ))
      )}
    </div>
  </div>

  <Input
    placeholder="搜索股票名称或代码"
    prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
    allowClear
    value={selectSearchText}
    onChange={(e) => setSelectSearchText(e.target.value)}
    style={{ 
      borderRadius: '6px',
      borderColor: '#d9d9d9',
      padding: '0 11px',
      height: '36px',
      fontSize: '14px'
    }}
  />
  
  <div style={{ 
    flex: 1,
    minHeight: '400px',
    border: '1px solid #f0f0f0',
    borderRadius: '8px',
    overflow: 'hidden'
  }}>
    <Table
      columns={selectColumns}
      dataSource={selectFilteredStockList}
      rowKey="code"
      size="middle"
      // scroll={{ y: 360 }}
      pagination={{ 
        pageSize: 20,
        showSizeChanger: false,
        style: { margin: '12px 16px' }
      }}
      rowSelection={{
        selectedRowKeys,
        onChange: setSelectedRowKeys,
        preserveSelectedRowKeys: true,
      }}
      style={{ 
        background: '#fff',
        boxShadow: '0 -1px 0 #f0f0f0 inset'
      }}
    />
  </div>
</Modal>

      <BatchStockDiagnosisModal
        visible={batchDiagnosisOpen}
        onCancel={() => setBatchDiagnosisOpen(false)}
        stocks={batchStocks}
      />

      <Modal
        style={{ maxWidth: '95vw' }}
        bodyStyle={{ 
          padding: '16px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxHeight: 800,
          overflow: 'hidden'
        }}
        title="抗分歧诊断 - 选择股票"
        open={resilienceDiagnosisOpen}
        onCancel={() => setResilienceDiagnosisOpen(false)}
        onOk={handleConfirmResilienceSelect}
        okText={`确认诊断(${resilienceStocks.length})`}
        cancelText="取消"
        width={720}
        centered
        destroyOnClose
      >
          <div style={{ 
            border: '1px solid #f0f0f0',
            borderRadius: '8px',
            padding: '12px 16px',
            backgroundColor: '#f9f9f9'
          }}>
          <div style={{ 
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px'
          }}>
            <span style={{ 
              fontWeight: 500,
              color: '#1a1a1a',
              fontSize: '14px'
            }}>已选股票（{resilienceSelectedStockItems.length}只）</span>
            {resilienceSelectedStockItems.length > 0 && (
              <Button 
                type="link" 
                size="small" 
                style={{ padding: 0, height: 'auto' }}
                onClick={() => setResilienceStocks([])}
              >
                清空全部
              </Button>
            )}
          </div>
          
          <div style={{ 
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            minHeight: '40px',
            padding: '4px 0',
            maxHeight: '120px',
            overflowY: 'auto',
            paddingRight: '8px'
          }}>
            {resilienceSelectedStockItems.length === 0 ? (
              <span style={{ 
                color: '#bfbfbf',
                fontSize: '13px',
                padding: '8px 0'
              }}>暂无选中股票，请在下方表格勾选</span>
            ) : (
              resilienceSelectedStockItems.map(item => (
                <Tag
                  key={item.code}
                  style={{ 
                    display: 'flex',
                    alignItems: 'center',
                    background: '#e6f7ff',
                    border: '1px solid #91d5ff',
                    borderRadius: '4px',
                    padding: '0 8px',
                    height: '28px',
                    fontSize: '13px'
                  }}
                  closable
                  onClose={() => setResilienceStocks(resilienceStocks.filter(c => c !== item.code))}
                >
                  {item.stockName}({item.code})
                </Tag>
              ))
            )}
          </div>
        </div>

        <Input
          placeholder="搜索股票名称或代码"
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          allowClear
          value={resilienceSelectSearchText}
          onChange={(e) => setResilienceSelectSearchText(e.target.value)}
          style={{ 
            borderRadius: '6px',
            borderColor: '#d9d9d9',
            padding: '0 11px',
            height: '36px',
            fontSize: '14px'
          }}
        />
        
        <div style={{ 
          flex: 1,
          height: 450,
          border: '1px solid #f0f0f0',
          borderRadius: '8px',
          overflow: 'hidden'
        }}>
          <Table
            columns={selectColumns}
            dataSource={resilienceSelectFilteredStockList}
            rowKey="code"
            size="middle"
            scroll={{ y: 360 }}
            pagination={{ 
              pageSize: 20,
              showSizeChanger: false,
              style: { margin: '12px 16px' }
            }}
            rowSelection={{
              selectedRowKeys: resilienceStocks,
              onChange: setResilienceStocks,
              preserveSelectedRowKeys: true,
            }}
            style={{ 
              background: '#fff',
              boxShadow: '0 -1px 0 #f0f0f0 inset'
            }}
          />
        </div>
      </Modal>

      <Modal
        style={{ maxWidth: '95vw' }}
        bodyStyle={{ 
          padding: '16px 24px',
        }}
        title="抗分歧诊断结果"
        open={resilienceResultOpen}
        onCancel={() => setResilienceResultOpen(false)}
        okText="关闭"
        cancelText={null}
        width={800}
        centered
        destroyOnClose
      >
        {resilienceLoading ? (
          <div style={{ 
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '300px'
          }}>
            <Spin size="large" />
          </div>
        ) : (
          <div>
            <div style={{ 
              marginBottom: '16px',
              padding: '12px 16px',
              backgroundColor: '#f9f9f9',
              borderRadius: '8px',
              fontSize: '13px',
              color: '#595959'
            }}>
              <p><strong style={{ color: '#1a1a1a' }}>诊断说明：</strong>抗分歧诊断通过分析个股与指数的分时弹性关系，计算抗跌性得分。</p>
              <p><strong>得分范围：</strong>5~25+，得分越高代表抗跌性越强</p>
              <p><strong>跟踪指数：</strong>sh688开头股票跟踪科创50(sh000688)，其他股票跟踪创业板指(sz399006)</p>
            </div>
            <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                type="primary"
                icon={<LineChartOutlined />}
                onClick={() => {
                  handleOpenMultiTimeLineFromResilience(resilienceResults.map(r => ({ code: r.code, stockName: r.stockName, change: r.change })));
                }}
                style={{
                  borderRadius: '6px',
                  background: `linear-gradient(135deg, ${getThemeColor()} 0%, ${getThemeColor('--theme-color-dark', '#096dd9')} 100%)`,
                  border: 'none',
                }}
              >
                查看叠加分时
              </Button>
            </div>
            <Table
              columns={[
                {
                  title: '排名',
                  key: 'rank',
                  width: 70,
                  align: 'center',
                  render: (_, __, index) => (
                    <span className={`rank-badge rank-${index < 3 ? 'top' : 'normal'}`}>
                      {index + 1}
                    </span>
                  ),
                },
                {
                  title: '股票名称',
                  dataIndex: 'stockName',
                  key: 'stockName',
                  width: 130,
                  render: (text, record) => (
                    <span 
                      className="stock-name clickable" 
                      onClick={() => {
                        setSelectedStock(record);
                        setKlineModalOpen(true);
                      }}
                      style={{ fontWeight: 500, cursor: 'pointer', color: getThemeColor() }}
                    >
                      {text || '-'}
                    </span>
                  ),
                },
                {
                  title: '涨幅',
                  dataIndex: 'change',
                  key: 'change',
                  width: 100,
                  align: 'right',
                  render: (val) => (
                    <span style={{ 
                      fontWeight: 500,
                      color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c'
                    }}>
                      {val > 0 ? '+' : ''}{val?.toFixed(2)}%
                    </span>
                  ),
                },
                {
                  title: '抗跌分数',
                  dataIndex: 'resilienceScore',
                  key: 'resilienceScore',
                  width: 120,
                  align: 'right',
                  render: (val) => (
                    <span style={{ 
                      fontWeight: 600,
                      fontSize: '16px',
                      color: val >= 15 ? '#cf1322' : val >= 10 ? '#fa8c16' : val >= 5 ? getThemeColor() : '#bfbfbf'
                    }}>
                      {val.toFixed(2)}
                    </span>
                  ),
                },
                {
                  title: '状态',
                  key: 'status',
                  width: 120,
                  align: 'center',
                  render: (_, record) => {
                    if (record.error) {
                      return <Tag color="error">异常</Tag>;
                    }
                    if (record.resilienceScore >= 15) {
                      return <Tag color="success">极强抗跌</Tag>;
                    }
                    if (record.resilienceScore >= 10) {
                      return <Tag color="warning">较强抗跌</Tag>;
                    }
                    if (record.resilienceScore >= 5) {
                      return <Tag color="default">跟随指数</Tag>;
                    }
                    return <Tag color="error">偏弱</Tag>;
                  },
                },
              ]}
              dataSource={resilienceResults}
              rowKey="code"
              size="middle"
              pagination={false}
            />
          </div>
        )}
      </Modal>

      <MultiStockTimeLineModal
        visible={multiTimeLineOpen}
        onCancel={() => setMultiTimeLineOpen(false)}
        stocks={multiTimeLineStocks}
        onStockClick={(stock) => {
          setSelectedStock(stock);
          setKlineModalOpen(true);
        }}
      />

      <SingleStockDiagnosisModal
        visible={singleStockDiagnosisOpen}
        onCancel={() => setSingleStockDiagnosisOpen(false)}
        stocks={stockList.map(item => ({ code: item.code, stockName: item.stockName }))}
      />

      <IntradayDiagnosisModal
        visible={intradayDiagnosisOpen}
        onCancel={() => setIntradayDiagnosisOpen(false)}
        stocks={stockList.map(item => ({ code: item.code, stockName: item.stockName }))}
      />
    </div>
  );
};

export default StockDiagnosis;
