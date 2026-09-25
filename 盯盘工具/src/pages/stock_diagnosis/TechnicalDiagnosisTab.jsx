import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert, Button, Card, Collapse, Empty, Radio, Space, Spin, Table, Tag, Typography, Tabs, message } from 'antd';
import { LineChartOutlined, RadarChartOutlined, ReloadOutlined, RiseOutlined, BarChartOutlined, UnorderedListOutlined, StarOutlined } from '@ant-design/icons';
import axios from 'axios';
import { isTradingDay } from '../../utils/tradingDay';
import { local_ip } from '../../constant';
import StockKLine from '../../components/StockKLine';
import StockTimeLine from '../../components/StockTimeLine';

const { Text } = Typography;

const formatPrice = (value) => (value == null ? '--' : Number(value).toFixed(2));

const formatChange = (value) => {
  const num = Number(value || 0);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const TECHNICAL_DATA_CACHE_KEY = 'technical_diagnosis_cache';
const SLOPE_DATA_CACHE_KEY = 'ma_slope_diagnosis_cache';

const TechnicalDiagnosisTab = ({
  loading,
  technicalData,
  technicalError,
  onRefresh,
  onStockClick,
  onDiagnosis,
  onToggleImportant,
}) => {
  const [activeSubTab, setActiveSubTab] = useState('slope');
  const [slopeData, setSlopeData] = useState(null);
  const [slopeLoading, setSlopeLoading] = useState(false);
  const [slopeError, setSlopeError] = useState('');
  const [cachedTechnicalData, setCachedTechnicalData] = useState(null);
  const [cachedSlopeData, setCachedSlopeData] = useState(null);
  const [slopeViewMode, setSlopeViewMode] = useState('kline');
  const [slopeChartType, setSlopeChartType] = useState('kline');
  const [chartStocks, setChartStocks] = useState([]);
  const [stockKlineData, setStockKlineData] = useState({});
  const [stockTimelineData, setStockTimelineData] = useState({});
  const [pollingStocks, setPollingStocks] = useState([]);
  const pollingTimerRef = useRef(null);
  const isAfterMarketCloseRef = useRef(false);
  const pollingStocksRef = useRef([]);
  const slopeViewModeRef = useRef('list');
  const slopeChartTypeRef = useRef('kline');

  const checkMarketClose = useCallback(() => {
    const now = new Date();
    // 非交易日（周末/节假日，以交易日历为准）视为已收盘
    if (!isTradingDay(now)) return true;
    const hour = now.getHours();
    const minute = now.getMinutes();
    return hour >= 15 || (hour === 14 && minute >= 59);
  }, []);

  useEffect(() => {
    const cachedTech = localStorage.getItem(TECHNICAL_DATA_CACHE_KEY);
    if (cachedTech) {
      try {
        setCachedTechnicalData(JSON.parse(cachedTech));
      } catch (e) {
        console.error('Failed to parse cached technical data:', e);
      }
    }
    const cachedSlope = localStorage.getItem(SLOPE_DATA_CACHE_KEY);

    if (cachedSlope) {
      try {
        setCachedSlopeData(JSON.parse(cachedSlope));
      } catch (e) {
        console.error('Failed to parse cached slope data:', e);
      }
    }
  }, []);

  useEffect(() => {
    if (technicalData && !loading) {
      localStorage.setItem(TECHNICAL_DATA_CACHE_KEY, JSON.stringify(technicalData));
      setCachedTechnicalData(technicalData);
    }
  }, [technicalData, loading]);

  useEffect(() => {
    if (slopeData && !slopeLoading) {
      localStorage.setItem(SLOPE_DATA_CACHE_KEY, JSON.stringify(slopeData));
      setCachedSlopeData(slopeData);
    }
  }, [slopeData, slopeLoading]);

  const fetchSlopeData = async (forceRefresh = false) => {
    try {
      setSlopeLoading(true);
      setSlopeError('');
      const query = forceRefresh ? '?forceRefresh=1' : '';
      const res = await axios.get(`http://${local_ip}:3000/ma_slope_diagnosis${query}`);
      if (res.data?.success) {
        setSlopeData(res.data.data || null);
        return;
      }
      setSlopeError(res.data?.message || '均线斜率加载失败');
    } catch (error) {
      console.error('获取均线斜率失败:', error);
      setSlopeError(error?.response?.data?.message || error.message || '均线斜率加载失败');
    } finally {
      setSlopeLoading(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'slope' && !slopeData && !slopeLoading) {
      fetchSlopeData();
    }
  }, [activeSubTab, slopeData, slopeLoading]);

  const handleRefreshSlope = () => {
    localStorage.removeItem(SLOPE_DATA_CACHE_KEY);
    fetchSlopeData(true);
  };

  const displayTechnicalData = loading ? null : (technicalData || cachedTechnicalData);
  const displaySlopeData = slopeLoading ? null : (slopeData || cachedSlopeData);

  const categories = displayTechnicalData?.categories || [];
  const summary = displayTechnicalData?.summary || {};
  const slopeSummary = displaySlopeData?.summary || {};

  useEffect(() => {
    const stocks = displaySlopeData?.stocks || [];
    console.log('[TechnicalDiagnosisTab] displaySlopeData updated:', stocks.length, 'stocks');
    
    const top3Stocks = [...stocks].sort((a, b) => (Number(b.ma3Slope) || 0) - (Number(a.ma3Slope) || 0)).slice(0, 20);
    const top5Stocks = [...stocks].sort((a, b) => (Number(b.ma5Slope) || 0) - (Number(a.ma5Slope) || 0)).slice(0, 20);
    
    const top3Codes = new Set(top3Stocks.map(s => s.code));
    const top5Codes = new Set(top5Stocks.map(s => s.code));
    
    const commonCodes = [...top3Codes].filter(code => top5Codes.has(code));
    const commonStocks = stocks.filter(s => commonCodes.includes(s.code));
    
    console.log('[TechnicalDiagnosisTab] common stocks:', commonStocks.length);
    
    setChartStocks(commonStocks);
    setPollingStocks(commonStocks);
  }, [displaySlopeData]);

  useEffect(() => {
    pollingStocksRef.current = pollingStocks;
    slopeViewModeRef.current = slopeViewMode;
    slopeChartTypeRef.current = slopeChartType;
  }, [pollingStocks, slopeViewMode, slopeChartType]);

  useEffect(() => {
    console.log('[TechnicalDiagnosisTab] polling effect triggered:', 
      'pollingStocks.length:', pollingStocks.length, 
      'slopeViewMode:', slopeViewMode);
      
    if (pollingStocks.length === 0 || slopeViewMode !== 'kline') {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      return;
    }

    const poll = async () => {
      const stocks = pollingStocksRef.current;
      const chartType = slopeChartTypeRef.current;
      console.log('[TechnicalDiagnosisTab] polling:', stocks.length, 'stocks, type:', chartType);

      try {
        if (chartType === 'kline') {
          const promises = stocks.map(stock => 
            axios.get(`http://${local_ip}:3000/stock_data`, { params: { code: stock.code, limit: 30 } })
          );
          const results = await Promise.all(promises);
          const newKlineData = {};
          stocks.forEach((stock, index) => {
            const res = results[index];
            if (res.data && Array.isArray(res.data)) {
              newKlineData[stock.code] = res.data;
            }
          });
          setStockKlineData(newKlineData);
        } else {
          const promises = stocks.map(stock => 
            axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: stock.code } })
          );
          const results = await Promise.all(promises);
          const newTimelineData = {};
          stocks.forEach((stock, index) => {
            const res = results[index];
            if (res.data && res.data.line) {
              newTimelineData[stock.code] = res.data.line;
            }
          });
          setStockTimelineData(newTimelineData);
        }
      } catch (error) {
        console.error('轮询数据失败:', error);
      }

      pollingTimerRef.current = setTimeout(poll, 3000);
    };

    poll();

    return () => {
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
      }
    };
  }, [pollingStocks, slopeViewMode, checkMarketClose]);

  const columns = [
    {
      title: '股票',
      dataIndex: 'stockName',
      key: 'stockName',
      width: 180,
      render: (_, record) => (
        <div className="tech-stock-cell">
          <span className="stock-name clickable" onClick={() => onStockClick(record)}>
            {record.stockName}
          </span>
          <div className="tech-stock-meta">
            <Text type="secondary">{record.code}</Text>
            {record.isImportant ? <Tag color="red">重点</Tag> : null}
            {record.blockName ? <Tag color="blue">{record.blockName}</Tag> : null}
          </div>
        </div>
      ),
    },
    {
      title: '最新价',
      dataIndex: 'close_px',
      key: 'close_px',
      width: 100,
      align: 'right',
      render: (value) => formatPrice(value),
    },
    {
      title: '涨跌幅',
      dataIndex: 'change',
      key: 'change',
      width: 100,
      align: 'right',
      render: (value) => (
        <span className={`change-value ${Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'}`}>
          {formatChange(value)}
        </span>
      ),
    },
    {
      title: '均线',
      key: 'mas',
      width: 260,
      render: (_, record) => (
        <div className="tech-ma-wrap">
          <span>MA3 {formatPrice(record.ma3)}</span>
          <span>MA5 {formatPrice(record.ma5)}</span>
          <span>MA10 {formatPrice(record.ma10)}</span>
          <span>MA20 {formatPrice(record.ma20)}</span>
        </div>
      ),
    },
    {
      title: '归类说明',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      align: 'center',
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<LineChartOutlined />} onClick={() => onStockClick(record)}>
            K线
          </Button>
          <Button size="small" type="primary" icon={<RadarChartOutlined />} onClick={() => onDiagnosis(record)}>
            AI诊断
          </Button>
          <Button
            size="small"
            onClick={() => onToggleImportant(record)}
          >
            {record.isImportant ? '取消重点监控' : '加入重点监控'}
          </Button>
        </Space>
      ),
    },
  ];

  const collapseItems = categories.map((category) => ({
    key: category.key,
    label: (
      <div className="technical-collapse-label">
        <span>{category.label}</span>
        <Tag color="processing">{category.count}</Tag>
      </div>
    ),
    children: (
      <Table
        columns={columns}
        dataSource={category.stocks || []}
        rowKey="code"
        pagination={false}
        size="middle"
      />
    ),
  }));

  const slopeColumns = [
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
      title: '股票',
      dataIndex: 'stockName',
      key: 'stockName',
      width: 180,
      render: (_, record) => (
        <div className="tech-stock-cell">
          <span className="stock-name clickable" onClick={() => onStockClick(record)}>
            {record.stockName}
          </span>
          <div className="tech-stock-meta">
            <Text type="secondary">{record.code}</Text>
            {record.isImportant ? <Tag color="red">重点</Tag> : null}
            {record.blockName ? <Tag color="blue">{record.blockName}</Tag> : null}
          </div>
        </div>
      ),
    },
    {
      title: '最新价',
      dataIndex: 'close_px',
      key: 'close_px',
      width: 100,
      align: 'right',
      render: (value) => formatPrice(value),
    },
    {
      title: '涨跌幅',
      dataIndex: 'change',
      key: 'change',
      width: 100,
      align: 'right',
      render: (value) => (
        <span className={`change-value ${Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'}`}>
          {formatChange(value)}
        </span>
      ),
    },
    {
      title: '3日线斜率',
      dataIndex: 'ma3Slope',
      key: 'ma3Slope',
      width: 110,
      align: 'right',
      sorter: (a, b) => (Number(a.ma3Slope) || 0) - (Number(b.ma3Slope) || 0),
      render: (value) => (
        <span className={`change-value ${Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'}`}>
          {value != null ? `${Number(value) > 0 ? '+' : ''}${value}%` : '--'}
        </span>
      ),
    },
    {
      title: '5日线斜率',
      dataIndex: 'ma5Slope',
      key: 'ma5Slope',
      width: 110,
      align: 'right',
      sorter: (a, b) => (Number(a.ma5Slope) || 0) - (Number(b.ma5Slope) || 0),
      render: (value) => (
        <span className={`change-value ${Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'}`}>
          {value != null ? `${Number(value) > 0 ? '+' : ''}${value}%` : '--'}
        </span>
      ),
    },
    {
      title: '10日线斜率',
      dataIndex: 'ma10Slope',
      key: 'ma10Slope',
      width: 120,
      align: 'right',
      sorter: (a, b) => (Number(a.ma10Slope) || 0) - (Number(b.ma10Slope) || 0),
      render: (value) => (
        <span className={`change-value ${Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'}`}>
          {value != null ? `${Number(value) > 0 ? '+' : ''}${value}%` : '--'}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      align: 'center',
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<LineChartOutlined />} onClick={() => onStockClick(record)}>
            K线
          </Button>
          <Button size="small" type="primary" icon={<RadarChartOutlined />} onClick={() => onDiagnosis(record)}>
            AI诊断
          </Button>
        </Space>
      ),
    },
  ];

  const renderTrendTab = () => (
    <div className="technical-diagnosis-tab">
      <Card className="diagnosis-card technical-summary-card" bordered={false}>
        <div className="technical-summary-header">
          <div>
            <div className="technical-summary-title">技术诊断总览</div>
            <div className="technical-summary-subtitle">
              仅展示沿均线上行或回踩后重新站上的强势股，同时要求近 5 日涨幅不超过 15%，且近 3 日至少出现过一次 6% 以上大涨。
            </div>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => onRefresh(true)}
          >
            刷新技术诊断
          </Button>
        </div>

        <div className="technical-summary-grid">
          <div className="summary-metric">
            <span className="label">监控总数</span>
            <span className="value">{summary.total || 0}</span>
          </div>
          <div className="summary-metric">
            <span className="label">已归类</span>
            <span className="value">{summary.classified || 0}</span>
          </div>
          <div className="summary-metric">
            <span className="label">异常数</span>
            <span className="value">{summary.errorCount || 0}</span>
          </div>
          <div className="summary-metric">
            <span className="label">更新时间</span>
            <span className="value small">{technicalData?.updatedAt ? new Date(technicalData.updatedAt).toLocaleString() : '--'}</span>
          </div>
        </div>

        <Space wrap size={[8, 8]} className="technical-summary-tags">
          <Tag color={summary.fromCache ? 'default' : 'success'}>
            {summary.fromCache ? '缓存结果' : '实时拉取'}
          </Tag>
          {summary.stale ? <Tag color="warning">接口异常，展示上次缓存</Tag> : null}
          {summary.requestMode ? <Tag color="blue">{summary.requestMode}</Tag> : null}
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        className="technical-diagnosis-alert"
        message="技术诊断说明"
        description="首次进入或手动刷新时会对监控池全量拉取日 K 数据，接口采用串行限速方式，请耐心等待。结果会剔除所有被均线压制的股票，只保留沿均线上行或回踩转强的标的，并附加近 5 日不过热、近 3 日必须出现一次 6%+ 大阳的约束。"
      />

      {technicalError ? (
        <Alert
          type="error"
          showIcon
          className="technical-diagnosis-alert"
          message="技术诊断加载失败"
          description={technicalError}
        />
      ) : null}

      <Card className="diagnosis-card" bordered={false}>
        {loading ? (
          <div className="loading-container technical-loading-container">
            <Spin size="large" />
            <div className="technical-loading-text">正在串行拉取全量 K 线并计算均线分类，请稍候...</div>
          </div>
        ) : categories.length ? (
          <Collapse items={collapseItems} ghost className="technical-collapse" />
        ) : (
          <Empty description="暂无技术诊断结果" />
        )}
      </Card>

      {Array.isArray(technicalData?.errors) && technicalData.errors.length ? (
        <Card className="diagnosis-card technical-error-card" bordered={false} title={`异常股票 (${technicalData.errors.length})`}>
          <Table
            columns={[
              {
                title: '股票名称',
                dataIndex: 'stockName',
                key: 'stockName',
                width: 160,
                render: (_, record) => (
                  <Space size="small">
                    <span>{record.stockName}</span>
                    <Text type="secondary">{record.code}</Text>
                  </Space>
                ),
              },
              {
                title: '板块',
                dataIndex: 'blockName',
                key: 'blockName',
                width: 120,
                render: (value) => value || '--',
              },
              {
                title: '原因',
                dataIndex: 'reason',
                key: 'reason',
              },
            ]}
            dataSource={technicalData.errors}
            rowKey="code"
            pagination={false}
            size="small"
          />
        </Card>
      ) : null}
    </div>
  );

  const renderSlopeListTab = () => (
    <div className="technical-diagnosis-tab">
      <Card className="diagnosis-card" bordered={false}>
        {slopeLoading ? (
          <div className="loading-container technical-loading-container">
            <Spin size="large" />
            <div className="technical-loading-text">正在串行拉取全量 K 线并计算均线斜率，请稍候...</div>
          </div>
        ) : displaySlopeData?.stocks?.length ? (
          <Table
            columns={slopeColumns}
            dataSource={displaySlopeData.stocks}
            rowKey="code"
            pagination={{ pageSize: 20, showSizeChanger: true }}
            size="middle"
          />
        ) : (
          <Empty description="暂无均线斜率数据" />
        )}
      </Card>

      {Array.isArray(displaySlopeData?.errors) && displaySlopeData.errors.length ? (
        <Card className="diagnosis-card technical-error-card" bordered={false} title={`异常股票 (${displaySlopeData.errors.length})`}>
          <Table
            columns={[
              {
                title: '股票名称',
                dataIndex: 'stockName',
                key: 'stockName',
                width: 160,
                render: (_, record) => (
                  <Space size="small">
                    <span>{record.stockName}</span>
                    <Text type="secondary">{record.code}</Text>
                  </Space>
                ),
              },
              {
                title: '板块',
                dataIndex: 'blockName',
                key: 'blockName',
                width: 120,
                render: (value) => value || '--',
              },
              {
                title: '原因',
                dataIndex: 'reason',
                key: 'reason',
              },
            ]}
            dataSource={displaySlopeData.errors}
            rowKey="code"
            pagination={false}
            size="small"
          />
        </Card>
      ) : null}
    </div>
  );

  const renderSlopeKlineTab = () => (
    <div className="technical-diagnosis-tab">
      {slopeLoading ? (
        <div className="loading-container technical-loading-container">
          <Spin size="large" />
          <div className="technical-loading-text">正在串行拉取全量 K 线并计算均线斜率，请稍候...</div>
        </div>
      ) : chartStocks.length === 0 ? (
        <Empty description="暂无重合股票数据" />
      ) : (
        <div className="slope-chart-grid">
          {chartStocks.map((stock) => {
            const klineData = stockKlineData[stock.code] || [];
            const timelineData = stockTimelineData[stock.code] || [];
            return (
              <Card
                key={stock.code}
                className="slope-chart-card"
                bordered={false}
                title={
                  <div className="slope-chart-card-title">
                    <span
                      className="stock-name clickable"
                      onClick={() => onStockClick(stock)}
                      style={{ fontWeight: 500 }}
                    >
                      {stock.stockName}
                    </span>
                    <span className="stock-code">{stock.code}</span>
                    <span
                      className={`stock-change ${stock.change > 0 ? 'up' : stock.change < 0 ? 'down' : 'flat'}`}
                    >
                      {stock.change > 0 ? '+' : ''}{stock.change.toFixed(2)}%
                    </span>
                    <Button
                      size="small"
                      type="primary"
                      icon={<StarOutlined />}
                      onClick={() => {
                        axios.post(`http://${local_ip}:3000/toggle_stock_important`, { code: stock.code })
                          .then((res) => {
                            if (res.data.success) {
                              message.success(`已将 ${stock.stockName || stock.code} 标记为重点股票`);
                            } else {
                              message.error('标记失败');
                            }
                          })
                          .catch(() => {
                            message.error('标记失败，请稍后重试');
                          });
                      }}
                      style={{ marginLeft: '8px', fontSize: '12px', padding: '2px 8px' }}
                    >
                      添加重点股票
                    </Button>
                  </div>
                }
              >
                <div className="slope-chart-card-body">
                  {slopeChartType === 'kline' ? (
                    <StockKLine data={klineData} height={200} />
                  ) : (
                    <StockTimeLine data={timelineData} height={200} />
                  )}
                </div>
                <div className="slope-chart-card-footer">
                  <div className="slope-info">
                    <span>MA3斜率</span>
                    <span className={Number(stock.ma3Slope) > 0 ? 'up' : 'down'}>
                      {Number(stock.ma3Slope) > 0 ? '+' : ''}{stock.ma3Slope}%
                    </span>
                  </div>
                  <div className="slope-info">
                    <span>MA5斜率</span>
                    <span className={Number(stock.ma5Slope) > 0 ? 'up' : 'down'}>
                      {Number(stock.ma5Slope) > 0 ? '+' : ''}{stock.ma5Slope}%
                    </span>
                  </div>
                  <div className="slope-info">
                    <span>MA10斜率</span>
                    <span className={Number(stock.ma10Slope) > 0 ? 'up' : 'down'}>
                      {Number(stock.ma10Slope) > 0 ? '+' : ''}{stock.ma10Slope}%
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderSlopeTab = () => (
    <div className="technical-diagnosis-tab">
      <Card className="diagnosis-card technical-summary-card" bordered={false}>
        <div className="technical-summary-header">
          <div>
            <div className="technical-summary-title">均线斜率诊断</div>
            <div className="technical-summary-subtitle">
              对监控池所有股票计算均线斜率，按 5 日线斜率绝对值从高到低排序。斜率为正则均线向上，为负则均线向下。
            </div>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={slopeLoading}
            onClick={handleRefreshSlope}
          >
            刷新斜率诊断
          </Button>
        </div>

        <div className="technical-summary-grid">
          <div className="summary-metric">
            <span className="label">监控总数</span>
            <span className="value">{slopeSummary.total || 0}</span>
          </div>
          <div className="summary-metric">
            <span className="label">已处理</span>
            <span className="value">{slopeSummary.processed || 0}</span>
          </div>
          <div className="summary-metric">
            <span className="label">重合股票</span>
            <span className="value" style={{ color: '#fa8c16' }}>{chartStocks.length}</span>
          </div>
          <div className="summary-metric">
            <span className="label">更新时间</span>
            <span className="value small">{slopeData?.updatedAt ? new Date(slopeData.updatedAt).toLocaleString() : '--'}</span>
          </div>
        </div>

        <Space wrap size={[8, 8]} className="technical-summary-tags">
          <Tag color={slopeSummary.fromCache ? 'default' : 'success'}>
            {slopeSummary.fromCache ? '缓存结果' : '实时拉取'}
          </Tag>
          {slopeSummary.stale ? <Tag color="warning">接口异常，展示上次缓存</Tag> : null}
          {slopeSummary.requestMode ? <Tag color="blue">{slopeSummary.requestMode}</Tag> : null}
          {slopeViewMode === 'kline' && (
            <Tag color="processing">
              实时轮询中 (3s)
            </Tag>
          )}
        </Space>
      </Card>

      <div className="slope-view-tabs">
        <Radio.Group
          value={slopeViewMode}
          onChange={(e) => setSlopeViewMode(e.target.value)}
          size="small"
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="list" icon={<UnorderedListOutlined />}>列表视图</Radio.Button>
          <Radio.Button value="kline" icon={<BarChartOutlined />}>K线视图</Radio.Button>
        </Radio.Group>
      </div>

      {slopeViewMode === 'kline' && (
        <div className="slope-chart-type-tabs">
          <Radio.Group
            value={slopeChartType}
            onChange={(e) => setSlopeChartType(e.target.value)}
            size="small"
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="kline">K线图</Radio.Button>
            <Radio.Button value="timeline">分时图</Radio.Button>
          </Radio.Group>
        </div>
      )}

      {slopeViewMode === 'kline' && (
        <Alert
          type="info"
          showIcon
          className="technical-diagnosis-alert"
          message="K线视图说明"
          description={`当前展示 ${chartStocks.length} 只股票，这些股票同时出现在3日线斜率前20名和5日线斜率前20名中。图表每3秒自动刷新一次数据，收盘后停止轮询。`}
        />
      )}

      {slopeError ? (
        <Alert
          type="error"
          showIcon
          className="technical-diagnosis-alert"
          message="均线斜率加载失败"
          description={slopeError}
        />
      ) : null}

      {slopeViewMode === 'list' ? renderSlopeListTab() : renderSlopeKlineTab()}
    </div>
  );

  return (
    <div className="technical-diagnosis-tab-wrapper">
      <Tabs
        activeKey={activeSubTab}
        onChange={setActiveSubTab}
        className="technical-sub-tabs"
        items={[
          {
            key: 'slope',
            label: (
              <span>
                <RiseOutlined style={{ marginRight: 4 }} />
                均线斜率
              </span>
            ),
            children: renderSlopeTab(),
          },
          {
            key: 'trend',
            label: (
              <span>
                <BarChartOutlined style={{ marginRight: 4 }} />
                均线趋势
              </span>
            ),
            children: renderTrendTab(),
          },
        ]}
      />
    </div>
  );
};

export default TechnicalDiagnosisTab;