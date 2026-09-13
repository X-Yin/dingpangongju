import { useState, useEffect } from 'react';
import {
  Alert, Button, Card, DatePicker, Empty, Radio, Spin, Table, Tag, Space, message, Modal,
} from 'antd';
import { ThunderboltOutlined, ExperimentOutlined, FileTextOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { local_ip } from '../../constant';

const { RangePicker } = DatePicker;

const formatProfit = (val) => {
  if (val == null) return '-';
  const num = Number(val);
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}`;
};

const formatProfitPct = (val) => {
  if (val == null) return '-';
  const num = Number(val);
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const STRATEGY_OPTIONS = [
  { value: 'ma3_slope', label: '3日线斜率' },
  { value: 'resilience_top3', label: '抗分歧分数前三' },
  { value: 'gain_top3', label: '涨幅前三' },
  { value: 'gain_resilience_overlap', label: '涨幅+抗分歧' },
];

const SmartBacktestDiagnosisTab = ({ onStockClick }) => {
  const [dateRange, setDateRange] = useState([
    dayjs('2025-05-09'),
    dayjs(),
  ]);
  const [selectedStrategy, setSelectedStrategy] = useState('ma3_slope');
  const [backtesting, setBacktesting] = useState(false);
  const [backtestResults, setBacktestResults] = useState(null);
  const [backtestError, setBacktestError] = useState('');
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisContent, setAnalysisContent] = useState('');

  useEffect(() => {
    fetch('/智能回测诊断分析.md')
      .then(res => res.text())
      .then(setAnalysisContent)
      .catch(() => setAnalysisContent('加载分析文档失败'));
  }, []);

  const handleRunBacktest = async () => {
    if (!selectedStrategy) {
      message.warning('请选择一个策略');
      return;
    }
    if (!dateRange || dateRange.length !== 2) {
      message.warning('请选择回测日期范围');
      return;
    }

    setBacktesting(true);
    setBacktestError('');
    setBacktestResults(null);

    try {
      const [start, end] = dateRange;
      const res = await axios.post(`http://${local_ip}:3000/smart_backtest_run`, {
        startDate: start.format('YYYY-MM-DD'),
        endDate: end.format('YYYY-MM-DD'),
        strategy: selectedStrategy,
      });

      if (res.data?.success) {
        setBacktestResults(res.data.data);
        message.success(`回测完成，共 ${res.data.data?.dates?.length || 0} 个日期组`);
      } else {
        setBacktestError(res.data?.message || '回测失败');
        message.error(res.data?.message || '回测失败');
      }
    } catch (err) {
      console.error('智能回测失败:', err);
      const msg = err?.response?.data?.message || err.message || '回测失败';
      setBacktestError(msg);
      message.error(msg);
    } finally {
      setBacktesting(false);
    }
  };

  const tradeColumns = [
    {
      title: '排名',
      key: 'rank',
      width: 50,
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
          onClick={() => onStockClick?.({ code: record.code, stockName: record.stockName })}
        >
          {text}
        </span>
      ),
    },
    {
      title: '策略指标',
      dataIndex: 'metricLabel',
      key: 'metricLabel',
      width: 110,
      align: 'right',
      render: (text) => <span style={{ fontWeight: 600, color: '#3657d6' }}>{text}</span>,
    },
    {
      title: '买入日期',
      dataIndex: 'buyDateStr',
      key: 'buyDateStr',
      width: 100,
      render: (text) => <span style={{ color: '#cf1322', fontWeight: 500 }}>{text}</span>,
    },
    {
      title: '买入价',
      dataIndex: 'buyPrice',
      key: 'buyPrice',
      width: 80,
      align: 'right',
      render: (val) => val?.toFixed(2) || '-',
    },
    {
      title: '卖出日期',
      dataIndex: 'sellDateStr',
      key: 'sellDateStr',
      width: 100,
      render: (text, record) => (
        <span style={{ color: record.isUnrealized ? '#fa8c16' : '#389e0d', fontWeight: 500 }}>
          {text}
        </span>
      ),
    },
    {
      title: '卖出价',
      dataIndex: 'sellPrice',
      key: 'sellPrice',
      width: 80,
      align: 'right',
      render: (val) => val?.toFixed(2) || '-',
    },
    {
      title: '持有天数',
      dataIndex: 'holdingDays',
      key: 'holdingDays',
      width: 80,
      align: 'center',
      render: (val) => `${val} 天`,
    },
    {
      title: '盈亏金额',
      dataIndex: 'profit',
      key: 'profit',
      width: 90,
      align: 'right',
      render: (val) => (
        <span style={{ fontWeight: 600, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
          {formatProfit(val)}
        </span>
      ),
    },
    {
      title: '盈亏比例',
      dataIndex: 'profitPct',
      key: 'profitPct',
      width: 90,
      align: 'right',
      render: (val) => (
        <span style={{ fontWeight: 600, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
          {formatProfitPct(val)}
        </span>
      ),
    },
    {
      title: '买入理由',
      dataIndex: 'buyReason',
      key: 'buyReason',
      ellipsis: true,
      render: (text) => <span style={{ fontSize: 12, color: '#595959' }}>{text}</span>,
    },
    {
      title: '卖出理由',
      dataIndex: 'sellReason',
      key: 'sellReason',
      ellipsis: true,
      render: (text, record) => (
        <span style={{ fontSize: 12, color: record.isUnrealized ? '#fa8c16' : '#595959' }}>{text}</span>
      ),
    },
  ];

  return (
    <div className="backtest-diagnosis-tab smart-backtest-tab">
      <Card className="diagnosis-card backtest-toolbar-card" bordered={false}>
        <div className="backtest-toolbar">
          <div className="backtest-toolbar-left">
            <Space wrap>
              <RangePicker
                value={dateRange}
                onChange={setDateRange}
                format="YYYY-MM-DD"
                allowClear={false}
                disabledDate={(current) => current && current > dayjs().endOf('day')}
                style={{ width: 260, borderRadius: 10 }}
              />
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={backtesting}
                onClick={handleRunBacktest}
                className="trade-run-btn"
              >
                开始回测
              </Button>
              <Button
                icon={<FileTextOutlined />}
                onClick={() => setAnalysisOpen(true)}
                className="trade-secondary-btn"
              >
                回测对比说明
              </Button>
            </Space>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#12213a', marginRight: 12 }}>选择策略：</span>
          <Radio.Group
            options={STRATEGY_OPTIONS}
            value={selectedStrategy}
            onChange={(e) => setSelectedStrategy(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          />
        </div>

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 14, borderRadius: 12, border: '1px solid rgba(54, 87, 214, 0.1)' }}
          message="智能回测诊断规则"
          description={
            <div style={{ fontSize: 12, lineHeight: 1.8, color: '#5b6b86' }}>
              <div><strong style={{ color: '#cf1322' }}>大盘买点条件（创业板和科创板分别判断）：</strong></div>
              <div style={{ paddingLeft: 12 }}>
                ① 前一日为情绪冰点<br />
                ② 跟踪指数当日涨幅 &gt; 1%（sh688 跟踪科创板，其他跟踪创业板）<br />
                ③ 当天科技情绪指数 &ge; -40
              </div>
              <div style={{ marginTop: 4 }}><strong style={{ color: '#3657d6' }}>策略说明：</strong></div>
              <div style={{ paddingLeft: 12 }}>
                <strong>3日线斜率：</strong>按MA3斜率从高到低排序，选取排名前3的股票买入<br />
                <strong>抗分歧分数前三：</strong>按当日抗分歧分数从高到低排序，选取排名前3的股票买入<br />
                <strong>涨幅前三：</strong>按当日涨幅从高到低排序，选取排名前3的股票买入<br />
                <strong>涨幅+抗分歧：</strong>涨幅前10中，按涨幅70% + 抗分歧30% 加权打分，取前3<br />
                <strong>卖出：</strong>根据卖点诊断（MA10破位/高位大阴线/情绪退潮）自动卖出
              </div>
              <div style={{ marginTop: 4 }}><strong>买入价：</strong>(收盘价+开盘价)/2</div>
            </div>
          }
        />
      </Card>

      {backtestError && (
        <Alert
          type="error"
          showIcon
          message="回测失败"
          description={backtestError}
          style={{ marginTop: 14, borderRadius: 12 }}
        />
      )}

      {backtesting && (
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '50px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 14, color: '#7b8ba6', fontSize: 14, fontWeight: 500 }}>
              正在寻找大盘买点、计算策略排名、模拟买卖，请耐心等待...
            </div>
          </div>
        </Card>
      )}

      {!backtesting && backtestResults && backtestResults.dates?.length > 0 && (
        <div className="backtest-results">
          {/* 汇总信息 */}
          <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <Tag color="blue">命中日期：{backtestResults.summary?.totalDates || 0} 个</Tag>
              {(backtestResults.summary?.mergedDates || 0) > 0 && (
                <Tag color="volcano">双板合并：{backtestResults.summary?.mergedDates} 天</Tag>
              )}
              <Tag color="purple">科创板命中：{backtestResults.summary?.kcDateCount || 0} 次</Tag>
              <Tag color="orange">创业板命中：{backtestResults.summary?.cyDateCount || 0} 次</Tag>
              <Tag color="magenta">{backtestResults.summary?.strategy?.name}</Tag>
            </div>
          </Card>

          {backtestResults.dates.map((dateGroup) => (
            <Card
              key={dateGroup.dateStr}
              className="diagnosis-card backtest-stock-card"
              bordered={false}
              style={{ marginTop: 14 }}
              title={
                <div className="backtest-stock-title">
                  <ExperimentOutlined style={{ color: '#6366f1' }} />
                  <span style={{ fontWeight: 800 }}>
                    {dateGroup.dateStr}
                  </span>
                  <Tag color={
                    dateGroup.indexType === '科创板+创业板' ? 'volcano'
                    : dateGroup.indexType === '科创板' ? 'purple'
                    : 'orange'
                  }>
                    {dateGroup.indexType}
                  </Tag>
                  <span style={{ fontSize: 13, color: '#7b8ba6', fontWeight: 500 }}>
                    指数涨幅 {dateGroup.indexChange}
                  </span>
                </div>
              }
              extra={
                <span style={{ fontSize: 12, color: '#8c8c8c', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  冰点：{dateGroup.freezingReason}
                </span>
              }
            >
              <div>
                <div style={{
                  marginBottom: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  color: '#12213a',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <span style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: '#6366f1',
                  }} />
                  {dateGroup.strategy?.name}
                  <Tag color="blue" style={{ margin: 0 }}>{dateGroup.strategy?.stocks?.length || 0} 只股票</Tag>
                </div>
                {dateGroup.strategy?.stocks?.length > 0 ? (
                  <Table
                    columns={tradeColumns}
                    dataSource={dateGroup.strategy.stocks}
                    rowKey={(record) => `${record.code}_${record.buyDate}`}
                    size="small"
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                    rowClassName={(record) => record.isUnrealized ? 'unrealized-row' : ''}
                    className="backtest-trade-table"
                  />
                ) : (
                  <Empty
                    description="无符合条件的股票"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    style={{ padding: '20px 0' }}
                  />
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {!backtesting && !backtestError && !backtestResults && (
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <Empty
            description="设置日期范围并选择策略后，点击「开始回测」按钮"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: '50px 0' }}
          />
        </Card>
      )}
      
      <Modal
        title="回测对比说明"
        open={analysisOpen}
        onCancel={() => setAnalysisOpen(false)}
        footer={null}
        width={820}
        centered
        destroyOnClose
      >
        <div style={{ maxHeight: '70vh', overflow: 'auto', paddingRight: 8 }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children }) => (
                <table style={{ borderCollapse: 'collapse', width: '100%', margin: '12px 0' }}>
                  {children}
                </table>
              ),
              th: ({ children }) => (
                <th style={{ border: '1px solid #d9d9d9', padding: '8px 12px', background: '#fafafa', fontWeight: 600, textAlign: 'left' }}>
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td style={{ border: '1px solid #d9d9d9', padding: '8px 12px' }}>
                  {children}
                </td>
              ),
            }}
          >
            {analysisContent}
          </ReactMarkdown>
        </div>
      </Modal>
    </div>
  );
};

export default SmartBacktestDiagnosisTab;