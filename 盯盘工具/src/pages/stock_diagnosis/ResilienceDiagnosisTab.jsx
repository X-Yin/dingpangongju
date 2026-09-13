import { useState } from 'react';
import { Alert, Button, Card, Empty, Radio, Space, Spin, Table, Tag, Tooltip, Tabs, Typography } from 'antd';
import { BarChartOutlined, ClockCircleOutlined, LineChartOutlined, ReloadOutlined, StarOutlined, ThunderboltOutlined, ArrowUpOutlined, ArrowDownOutlined, RiseOutlined } from '@ant-design/icons';
import { getThemeColor, getThemeColorRgba } from '../../utils/theme';

const { Text } = Typography;

const formatDate = (dateNum) => {
  if (!dateNum) return '--';
  const str = String(dateNum);
  return `${str.substring(4, 6)}-${str.substring(6, 8)}`;
};

const getScoreColor = (score) => {
  if (score >= 15) return { bg: '#fff1f0', text: '#cf1322', border: '#ffa39e' };
  if (score >= 10) return { bg: '#fff7e6', text: '#fa8c16', border: '#ffd591' };
  if (score >= 5) return { bg: '#e6f7ff', text: getThemeColor(), border: '#91d5ff' };
  return { bg: '#f6ffed', text: '#389e0d', border: '#b7eb8f' };
};

const getStatusTag = (score) => {
  if (score >= 15) return <Tag color="error">极强抗跌</Tag>;
  if (score >= 10) return <Tag color="warning">较强抗跌</Tag>;
  if (score >= 5) return <Tag color="processing">跟随指数</Tag>;
  return <Tag color="success">偏弱</Tag>;
};

const getTrendTag = (trend) => {
  switch (trend) {
    case 'improving':
      return <Tag color="error" style={{ fontWeight: 600 }}>转强</Tag>;
    case 'declining':
      return <Tag color="success" style={{ fontWeight: 600 }}>转弱</Tag>;
    case 'strong':
      return <Tag color="red" style={{ fontWeight: 600 }}>持续强</Tag>;
    case 'stable':
      return <Tag color="default">稳定</Tag>;
    default:
      return <Tag color="default">--</Tag>;
  }
};

const ResilienceDiagnosisTab = ({
  multiDayData,
  multiDayLoading,
  multiDayError,
  onRefreshMultiDay,
  onOpenCompare,
  onStockClick,
  onOpenMultiTimeLine,
  onBatchAddImportant,
  batchAddImportantLoading,
  onOpenSingleStockDiagnosis,
  onOpenIntradayDiagnosis,
}) => {
  const [activeSubTab, setActiveSubTab] = useState('multiDay');
  const [viewMode, setViewMode] = useState('transitioned');
  const [sortOrder, setSortOrder] = useState('descend');
  const [averageSortKey, setAverageSortKey] = useState('ma3');
  const [averageSortOrder, setAverageSortOrder] = useState('descend');

  const dates = multiDayData?.dates || [];
  const stocks = multiDayData?.stocks || [];
  const transitionedStocks = multiDayData?.transitionedStocks || [];

  const rawStocks = viewMode === 'transitioned' ? transitionedStocks : stocks;

  const displayStocks = [...rawStocks].sort((a, b) => {
    const scoreA = a.dailyResults?.[0]?.resilienceScore || 0;
    const scoreB = b.dailyResults?.[0]?.resilienceScore || 0;
    if (sortOrder === 'descend') {
      return scoreB - scoreA;
    }
    if (sortOrder === 'ascend') {
      return scoreA - scoreB;
    }
    return 0;
  });

  const buildDailyMap = (dailyResults) => {
    const map = {};
    if (!Array.isArray(dailyResults)) return map;
    for (const item of dailyResults) {
      map[item.date] = item;
    }
    return map;
  };

  const calculateAverages = (stock) => {
    const results = stock.dailyResults || [];
    if (!results.length) {
      return { ma3: null, ma5: null };
    }
    const scores = results.map(r => r.resilienceScore || 0).filter(s => typeof s === 'number' && !isNaN(s));
    const ma3 = scores.slice(0, 3);
    const ma5 = scores.slice(0, 5);
    return {
      ma3: ma3.length ? (ma3.reduce((sum, s) => sum + s, 0) / ma3.length).toFixed(2) : null,
      ma5: ma5.length ? (ma5.reduce((sum, s) => sum + s, 0) / ma5.length).toFixed(2) : null,
    };
  };

  const sortedAverageStocks = [...stocks].map(stock => ({
    ...stock,
    ...calculateAverages(stock),
  })).sort((a, b) => {
    const valA = Number(a[averageSortKey]) || 0;
    const valB = Number(b[averageSortKey]) || 0;
    if (averageSortOrder === 'descend') {
      return valB - valA;
    }
    return valA - valB;
  });

  const baseColumns = [
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
        <span
          className="stock-name clickable"
          onClick={() => onStockClick(record)}
          style={{ fontWeight: 500, cursor: 'pointer', color: getThemeColor() }}
        >
          {text || record.code}
        </span>
      ),
    },
    {
      title: '板块',
      dataIndex: 'blockName',
      key: 'blockName',
      width: 100,
      render: (text) => text ? <Tag>{text}</Tag> : '--',
    },
    {
      title: '最新涨幅',
      key: 'change',
      width: 90,
      align: 'right',
      render: (_, record) => {
        const val = record.change || 0;
        return (
          <span style={{ fontWeight: 500, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
            {val > 0 ? '+' : ''}{val.toFixed(2)}%
          </span>
        );
      },
    },
  ];

  const dailyColumns = dates.map((date, index) => {
    const isLatest = index === 0;
    const title = isLatest ? (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', minHeight: '24px' }}>
        <span>{formatDate(date)}</span>
        <div 
          style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '0px',
            cursor: 'pointer',
            padding: '1px 3px',
            borderRadius: '4px',
            background: sortOrder ? 'rgba(99, 102, 241, 0.06)' : 'transparent',
            transition: 'background 0.2s',
          }}
        >
          <svg 
            onClick={() => setSortOrder('descend')}
            width="14" 
            height="14" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke={sortOrder === 'descend' ? getThemeColor() : '#bfbfbf'} 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            style={{ 
              transition: 'stroke 0.2s, transform 0.15s',
              transform: sortOrder === 'descend' ? 'scale(1.1)' : 'scale(1)',
            }}
          >
            <path d="M12 5v14M5 12l7-7 7 7"/>
          </svg>
          <svg 
            onClick={() => setSortOrder('ascend')}
            width="14" 
            height="14" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke={sortOrder === 'ascend' ? getThemeColor() : '#bfbfbf'} 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            style={{ 
              transition: 'stroke 0.2s, transform 0.15s',
              transform: sortOrder === 'ascend' ? 'scale(1.1)' : 'scale(1)',
            }}
          >
            <path d="M12 19V5M19 12l-7 7-7-7"/>
          </svg>
        </div>
      </div>
    ) : formatDate(date);
    return {
      title,
      key: `date_${date}`,
      width: isLatest ? 110 : 85,
      align: 'center',
      render: (_, record) => {
        const dailyMap = buildDailyMap(record.dailyResults);
        const item = dailyMap[date];
        if (!item || item.error) {
          return <span style={{ color: '#bfbfbf', fontSize: 12 }}>--</span>;
        }
        const score = item.resilienceScore || 0;
        const colors = getScoreColor(score);
        return (
          <Tooltip
            title={
              <div style={{ fontSize: 12 }}>
                <div>日期：{formatDate(date)}</div>
                <div>抗分歧得分：{score.toFixed(2)}</div>
                <div>个股涨幅：{item.stockChange > 0 ? '+' : ''}{item.stockChange}%</div>
                <div>指数涨幅：{item.indexChange > 0 ? '+' : ''}{item.indexChange}%</div>
                <div>状态：{item.status}</div>
              </div>
            }
          >
            <div
              style={{
                display: 'inline-block',
                minWidth: '48px',
                padding: '4px 8px',
                borderRadius: '6px',
                backgroundColor: colors.bg,
                color: colors.text,
                border: `1px solid ${colors.border}`,
                fontWeight: 600,
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              {score.toFixed(1)}
            </div>
          </Tooltip>
        );
      },
    };
  });

  const actionColumns = [
    {
      title: '趋势',
      dataIndex: 'trend',
      key: 'trend',
      width: 90,
      align: 'center',
      render: (trend) => getTrendTag(trend),
    },
    {
      title: '3日均值',
      key: 'latestStatus',
      width: 100,
      align: 'center',
      render: (_, record) => (
        <Tooltip title={`3日均值：${(record.latestScore || 0).toFixed(2)}`}>
          {getStatusTag(record.latestScore)}
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      align: 'center',
      render: (_, record) => (
        <Button
          size="small"
          icon={<LineChartOutlined />}
          onClick={() => onOpenMultiTimeLine([{ code: record.code, stockName: record.stockName, change: record.change }])}
        >
          分时
        </Button>
      ),
    },
  ];

  const columns = [...baseColumns, ...dailyColumns, ...actionColumns];

  const averageColumns = [
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
            {record.blockName ? <Tag color="blue">{record.blockName}</Tag> : null}
          </div>
        </div>
      ),
    },
    {
      title: '最新涨幅',
      key: 'change',
      width: 100,
      align: 'right',
      render: (_, record) => {
        const val = record.change || 0;
        return (
          <span style={{ fontWeight: 500, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
            {val > 0 ? '+' : ''}{val.toFixed(2)}%
          </span>
        );
      },
    },
    {
      title: '3日均值',
      dataIndex: 'ma3',
      key: 'ma3',
      width: 120,
      align: 'right',
      sorter: (a, b) => (Number(a.ma3) || 0) - (Number(b.ma3) || 0),
      render: (value) => (
        <span style={{ fontWeight: 600, fontSize: 14, color: Number(value) >= 15 ? '#cf1322' : Number(value) >= 10 ? '#fa8c16' : Number(value) >= 5 ? getThemeColor() : '#bfbfbf' }}>
          {value != null ? value : '--'}
        </span>
      ),
    },
    {
      title: '5日均值',
      dataIndex: 'ma5',
      key: 'ma5',
      width: 120,
      align: 'right',
      sorter: (a, b) => (Number(a.ma5) || 0) - (Number(b.ma5) || 0),
      render: (value) => (
        <span style={{ fontWeight: 600, fontSize: 14, color: Number(value) >= 15 ? '#cf1322' : Number(value) >= 10 ? '#fa8c16' : Number(value) >= 5 ? getThemeColor() : '#bfbfbf' }}>
          {value != null ? value : '--'}
        </span>
      ),
    },
    {
      title: '最新得分',
      key: 'latestScore',
      width: 120,
      align: 'right',
      render: (_, record) => {
        const score = record.dailyResults?.[0]?.resilienceScore || 0;
        return (
          <span style={{ fontWeight: 600, fontSize: 14, color: score >= 15 ? '#cf1322' : score >= 10 ? '#fa8c16' : score >= 5 ? getThemeColor() : '#bfbfbf' }}>
            {score ? score.toFixed(2) : '--'}
          </span>
        );
      },
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
          <Button size="small" icon={<LineChartOutlined />} onClick={() => onOpenMultiTimeLine([{ code: record.code, stockName: record.stockName, change: record.change }])}>
            分时
          </Button>
        </Space>
      ),
    },
  ];

  const renderMultiDayTab = () => (
    <div className="resilience-diagnosis-tab">
      <Card className="diagnosis-card resilience-summary-card" bordered={false}>
        <div className="resilience-summary-header">
          <div>
            <div className="resilience-summary-title">抗分歧多日诊断</div>
            <div className="resilience-summary-subtitle">
              对全部监控股票计算最近 5 个交易日的抗分歧得分，自动筛选从偏弱/跟随指数转为极强抗跌的标的。
            </div>
          </div>
          <Space>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={onOpenCompare}
              style={{
                borderRadius: '8px',
                background: `linear-gradient(135deg, ${getThemeColor()} 0%, ${getThemeColor('--theme-color-dark', '#096dd9')} 100%)`,
                border: 'none',
                boxShadow: `0 4px 12px ${getThemeColorRgba(0.3)}`,
              }}
            >
              对比诊断
            </Button>
            <Button
              type="primary"
              icon={<BarChartOutlined />}
              onClick={onOpenSingleStockDiagnosis}
              style={{
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #722ed1 0%, #2f54eb 100%)',
                border: 'none',
                boxShadow: '0 4px 12px rgba(114, 46, 209, 0.3)',
              }}
            >
              个股多日诊断
            </Button>
            <Button
              type="primary"
              icon={<ClockCircleOutlined />}
              onClick={onOpenIntradayDiagnosis}
              style={{
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #13c2c2 0%, #08979c 100%)',
                border: 'none',
                boxShadow: '0 4px 12px rgba(19, 194, 194, 0.3)',
              }}
            >
              个股分时诊断
            </Button>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={multiDayLoading}
              onClick={() => onRefreshMultiDay(true)}
              style={{ borderRadius: '8px' }}
            >
              刷新多日诊断
            </Button>
          </Space>
        </div>

        <div className="resilience-summary-grid">
          <div className="summary-metric">
            <span className="label">分析股票数</span>
            <span className="value">{stocks.length}</span>
          </div>
          <div className="summary-metric">
            <span className="label">转强股票数</span>
            <span className="value" style={{ color: '#cf1322' }}>{transitionedStocks.length}</span>
          </div>
          <div className="summary-metric">
            <span className="label">交易日数</span>
            <span className="value">{dates.length}</span>
          </div>
          <div className="summary-metric">
            <span className="label">更新时间</span>
            <span className="value small">
              {multiDayData?.updatedAt ? new Date(multiDayData.updatedAt).toLocaleString() : '--'}
            </span>
          </div>
        </div>

        {multiDayData?.fromCache && (
          <Tag color="default" style={{ marginTop: 8 }}>缓存数据</Tag>
        )}
      </Card>

      <Alert
        type="info"
        showIcon
        className="resilience-diagnosis-alert"
        message="抗分歧诊断说明"
        description={
          <div>
            <p style={{ margin: '4px 0' }}>
              <strong>抗分歧得分：</strong>5~25+，得分越高代表抗跌性越强。≥15 极强抗跌，10~15 较强抗跌，5~10 跟随指数，&lt;5 偏弱。
            </p>
            <p style={{ margin: '4px 0' }}>
              <strong>跟踪指数：</strong>sh688 开头股票跟踪科创50(sh000688)，其他股票跟踪创业板指(sz399006)。
            </p>
            <p style={{ margin: '4px 0' }}>
              <strong>转强筛选：</strong>基于3日均线均值判定，最近3日均值 ≥10 且最早3日均值 &lt;10 视为持续弱转强。
            </p>
            <p style={{ margin: '4px 0' }}>
              <strong>颜色说明：</strong>
              <span style={{ display: 'inline-block', padding: '2px 6px', margin: '0 4px', backgroundColor: '#fff1f0', color: '#cf1322', borderRadius: '4px', fontSize: 12 }}>红色=极强</span>
              <span style={{ display: 'inline-block', padding: '2px 6px', margin: '0 4px', backgroundColor: '#fff7e6', color: '#fa8c16', borderRadius: '4px', fontSize: 12 }}>橙色=较强</span>
              <span style={{ display: 'inline-block', padding: '2px 6px', margin: '0 4px', backgroundColor: '#e6f7ff', color: getThemeColor(), borderRadius: '4px', fontSize: 12 }}>蓝色=跟随</span>
              <span style={{ display: 'inline-block', padding: '2px 6px', margin: '0 4px', backgroundColor: '#f6ffed', color: '#389e0d', borderRadius: '4px', fontSize: 12 }}>绿色=偏弱</span>
            </p>
          </div>
        }
      />

      {multiDayError ? (
        <Alert
          type="error"
          showIcon
          className="resilience-diagnosis-alert"
          message="多日诊断加载失败"
          description={multiDayError}
        />
      ) : null}

      <Card className="diagnosis-card" bordered={false}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Radio.Group value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
            <Radio.Button value="transitioned">转强股票({transitionedStocks.length})</Radio.Button>
            <Radio.Button value="all">全部股票({stocks.length})</Radio.Button>
          </Radio.Group>
          {viewMode === 'transitioned' && transitionedStocks.length > 0 && (
            <Button
              icon={<StarOutlined />}
              loading={batchAddImportantLoading}
              onClick={() => onBatchAddImportant(transitionedStocks.map(s => s.code))}
              style={{
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #faad14 0%, #d48806 100%)',
                border: 'none',
                color: '#fff',
                fontWeight: 500,
              }}
            >
              一键添加全部转强股到重点
            </Button>
          )}
        </div>

        {multiDayLoading ? (
          <div className="loading-container resilience-loading-container">
            <Spin size="large" />
            <div className="resilience-loading-text">
              正在拉取最近 5 个交易日的分时数据并计算抗分歧得分，请耐心等待...
            </div>
          </div>
        ) : multiDayData ? (
          displayStocks.length ? (
            <Table
              columns={columns}
              dataSource={displayStocks}
              rowKey="code"
              pagination={false}
              size="middle"
              scroll={{ x: 'max-content' }}
            />
          ) : (
            <Empty description={viewMode === 'transitioned' ? '暂无转强股票' : '暂无数据'} />
          )
        ) : (
          <div className="loading-container resilience-loading-container">
            <div style={{ fontSize: '14px', color: '#999', marginBottom: 16 }}>
              点击上方「刷新多日诊断」按钮加载数据
            </div>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => onRefreshMultiDay(true)}
              style={{ borderRadius: '8px' }}
            >
              刷新多日诊断
            </Button>
          </div>
        )}
      </Card>
    </div>
  );

  const renderAverageTab = () => (
    <div className="resilience-average-tab">
      <Card className="diagnosis-card resilience-summary-card" bordered={false}>
        <div className="resilience-summary-header">
          <div>
            <div className="resilience-summary-title">抗分歧均值排序</div>
            <div className="resilience-summary-subtitle">
              对全部监控股票计算抗分歧分数的3日均值和5日均值，支持按均值正向排序和倒序。
            </div>
          </div>
          <Space>
            <Button
              type="primary"
              icon={<RiseOutlined />}
              onClick={() => {
                setAverageSortKey('ma3');
                setAverageSortOrder(averageSortOrder === 'descend' ? 'ascend' : 'descend');
              }}
              size="small"
            >
              按3日均值排序
            </Button>
            <Button
              type="primary"
              icon={<RiseOutlined />}
              onClick={() => {
                setAverageSortKey('ma5');
                setAverageSortOrder(averageSortOrder === 'descend' ? 'ascend' : 'descend');
              }}
              size="small"
            >
              按5日均值排序
            </Button>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={multiDayLoading}
              onClick={() => onRefreshMultiDay(true)}
            >
              刷新诊断数据
            </Button>
          </Space>
        </div>

        <div className="resilience-summary-grid">
          <div className="summary-metric">
            <span className="label">股票总数</span>
            <span className="value">{stocks.length}</span>
          </div>
          <div className="summary-metric">
            <span className="label">当前排序</span>
            <span className="value small">{averageSortKey === 'ma3' ? '3日均值' : '5日均值'} {averageSortOrder === 'descend' ? '降序' : '升序'}</span>
          </div>
          <div className="summary-metric">
            <span className="label">更新时间</span>
            <span className="value small">
              {multiDayData?.updatedAt ? new Date(multiDayData.updatedAt).toLocaleString() : '--'}
            </span>
          </div>
        </div>

        {multiDayData?.fromCache && (
          <Tag color="default" style={{ marginTop: 8 }}>缓存数据</Tag>
        )}
      </Card>

      <Alert
        type="info"
        showIcon
        className="resilience-diagnosis-alert"
        message="抗分歧均值说明"
        description={
          <div>
            <p style={{ margin: '4px 0' }}>
              <strong>3日均值：</strong>最近3个交易日的抗分歧得分平均值。
            </p>
            <p style={{ margin: '4px 0' }}>
              <strong>5日均值：</strong>最近5个交易日的抗分歧得分平均值。
            </p>
            <p style={{ margin: '4px 0' }}>
              <strong>得分颜色：</strong>
              <span style={{ color: '#cf1322', fontWeight: 600 }}>红色(≥15)极强</span>、
              <span style={{ color: '#fa8c16', fontWeight: 600 }}>橙色(10~15)较强</span>、
              <span style={{ color: getThemeColor(), fontWeight: 600 }}>蓝色(5~10)跟随</span>、
              <span style={{ color: '#bfbfbf', fontWeight: 600 }}>灰色(&lt;5)偏弱</span>
            </p>
          </div>
        }
      />

      {multiDayError ? (
        <Alert
          type="error"
          showIcon
          className="resilience-diagnosis-alert"
          message="抗分歧诊断加载失败"
          description={multiDayError}
        />
      ) : null}

      <Card className="diagnosis-card" bordered={false}>
        {multiDayLoading ? (
          <div className="loading-container resilience-loading-container">
            <Spin size="large" />
            <div className="resilience-loading-text">
              正在拉取最近 5 个交易日的分时数据并计算抗分歧得分，请耐心等待...
            </div>
          </div>
        ) : multiDayData ? (
          sortedAverageStocks.length ? (
            <Table
              columns={averageColumns}
              dataSource={sortedAverageStocks}
              rowKey="code"
              pagination={{ pageSize: 20, showSizeChanger: true }}
              size="middle"
              scroll={{ x: 'max-content' }}
            />
          ) : (
            <Empty description="暂无数据" />
          )
        ) : (
          <div className="loading-container resilience-loading-container">
            <div style={{ fontSize: '14px', color: '#999', marginBottom: 16 }}>
              点击上方「刷新诊断数据」按钮加载数据
            </div>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => onRefreshMultiDay(true)}
              style={{ borderRadius: '8px' }}
            >
              刷新诊断数据
            </Button>
          </div>
        )}
      </Card>
    </div>
  );

  return (
    <div className="resilience-diagnosis-tab-wrapper">
      <Tabs
        activeKey={activeSubTab}
        onChange={setActiveSubTab}
        className="technical-sub-tabs"
        items={[
          {
            key: 'multiDay',
            label: (
              <span>
                <BarChartOutlined style={{ marginRight: 4 }} />
                多日诊断
              </span>
            ),
            children: renderMultiDayTab(),
          },
          {
            key: 'average',
            label: (
              <span>
                <RiseOutlined style={{ marginRight: 4 }} />
                均值排序
              </span>
            ),
            children: renderAverageTab(),
          },
        ]}
      />
    </div>
  );
};

export default ResilienceDiagnosisTab;