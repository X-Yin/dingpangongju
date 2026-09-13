import { useEffect, useMemo, useState, useRef } from 'react';
import {
  Alert, Button, Card, DatePicker, Empty, Input, Modal, Spin, Table, Tag, Space, message,
} from 'antd';
import {
  ExperimentOutlined, ReloadOutlined, SearchOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import BacktestKLineChart from './BacktestKLineChart';

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

const BacktestDiagnosisTab = ({ onStockClick, preSelectedCode, preSelectedName, preSelectedCodes, preSelectedNames, autoBacktest, defaultDays }) => {
  const [stockList, setStockList] = useState([]);
  const [stockListLoading, setStockListLoading] = useState(false);

  const [selectModalOpen, setSelectModalOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [selectSearchText, setSelectSearchText] = useState('');

  const preSelectApplied = useRef(false);
  const autoRunTriggered = useRef(false);

  const days = parseInt(defaultDays) || 60;
  const [dateRange, setDateRange] = useState([
    dayjs().subtract(days, 'day'),
    dayjs(),
  ]);

  const [backtesting, setBacktesting] = useState(false);
  const [backtestError, setBacktestError] = useState('');
  const [backtestResults, setBacktestResults] = useState([]);

  // 拉取可选股票列表
  const fetchStockList = async () => {
    setStockListLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/buy_sell_selectable_stocks`);
      if (res.data?.success) {
        setStockList(res.data.data || []);
      } else {
        message.error(res.data?.message || '获取股票列表失败');
      }
    } catch (err) {
      console.error('获取可选股票失败:', err);
      message.error('获取可选股票失败');
    } finally {
      setStockListLoading(false);
    }
  };

  useEffect(() => {
    fetchStockList();
  }, []);

  // 多股票预选（来自 14:50 自动回测）
  useEffect(() => {
    if (preSelectedCodes && stockList.length > 0 && !preSelectApplied.current) {
      const codes = preSelectedCodes.split(',').map(c => c.trim()).filter(Boolean);
      const names = (preSelectedNames || '').split(',').map(n => n.trim()).filter(Boolean);
      const codesToAdd = [];
      const existingCodes = new Set(stockList.map(s => s.code));

      codes.forEach((code, idx) => {
        if (!existingCodes.has(code)) {
          codesToAdd.push({ code, stockName: names[idx] || code });
        }
      });

      if (codesToAdd.length > 0) {
        setStockList(prev => [...prev, ...codesToAdd]);
      }
      setSelectedRowKeys(codes);
      preSelectApplied.current = true;
    }
  }, [stockList, preSelectedCodes, preSelectedNames]);

  // 单股票预选（来自回测诊断按钮）
  useEffect(() => {
    if (preSelectedCode && !preSelectedCodes && stockList.length > 0 && !preSelectApplied.current) {
      const exists = stockList.some(s => s.code === preSelectedCode);
      if (exists) {
        setSelectedRowKeys([preSelectedCode]);
      } else {
        setStockList(prev => [...prev, { code: preSelectedCode, stockName: preSelectedName || preSelectedCode }]);
        setSelectedRowKeys([preSelectedCode]);
      }
      preSelectApplied.current = true;
    }
  }, [stockList, preSelectedCode, preSelectedName, preSelectedCodes]);

  const filteredStockList = useMemo(() => {
    if (!selectSearchText) return stockList;
    const txt = selectSearchText.toLowerCase();
    return stockList.filter(s =>
      (s.stockName || '').toLowerCase().includes(txt) ||
      (s.code || '').toLowerCase().includes(txt)
    );
  }, [stockList, selectSearchText]);

  const selectedStockItems = useMemo(
    () => stockList.filter(s => selectedRowKeys.includes(s.code)),
    [stockList, selectedRowKeys]
  );

  const handleOpenSelect = () => {
    setSelectSearchText('');
    setSelectModalOpen(true);
  };

  const handleConfirmSelect = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('请至少选择一只股票');
      return;
    }
    setSelectModalOpen(false);
  };

  const handleRemoveSelected = (code) => {
    setSelectedRowKeys(keys => keys.filter(k => k !== code));
  };

  const handleClearSelected = () => {
    setSelectedRowKeys([]);
  };

  const handleRunBacktest = async () => {
    if (selectedRowKeys.length === 0) {
      message.warning('请先选择股票');
      return;
    }
    if (!dateRange || dateRange.length !== 2) {
      message.warning('请选择回测日期范围');
      return;
    }

    setBacktesting(true);
    setBacktestError('');
    setBacktestResults([]);

    try {
      const [start, end] = dateRange;
      const res = await axios.post(`http://${local_ip}:3000/backtest_buy_sell`, {
        stockCodes: selectedRowKeys,
        startDate: start.format('YYYY-MM-DD'),
        endDate: end.format('YYYY-MM-DD'),
      });

      if (res.data?.success) {
        setBacktestResults(res.data.data || []);
        message.success(`回测完成，共 ${res.data.data?.length || 0} 只股票`);
      } else {
        setBacktestError(res.data?.message || '回测失败');
        message.error(res.data?.message || '回测失败');
      }
    } catch (err) {
      console.error('回测失败:', err);
      const msg = err?.response?.data?.message || err.message || '回测失败';
      setBacktestError(msg);
      message.error(msg);
    } finally {
      setBacktesting(false);
    }
  };

  // 自动回测：当 autoBacktest 为 true 且股票已预选时，自动触发回测
  useEffect(() => {
    if (autoBacktest && selectedRowKeys.length > 0 && !autoRunTriggered.current && !backtesting && stockList.length > 0) {
      autoRunTriggered.current = true;
      // 延迟一下确保 UI 渲染完成
      const timer = setTimeout(() => {
        handleRunBacktest();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [autoBacktest, selectedRowKeys.length, backtesting, stockList.length]);

  const selectColumns = [
    {
      title: '股票名称',
      dataIndex: 'stockName',
      key: 'stockName',
      width: 130,
      render: (text) => (
        <span style={{ fontWeight: 500, color: '#1a1a1a', fontSize: '14px' }}>{text}</span>
      ),
    },
    {
      title: '代码',
      dataIndex: 'code',
      key: 'code',
      width: 100,
      render: (text) => (
        <span style={{ color: '#595959', fontSize: '13px', fontFamily: 'monospace' }}>{text}</span>
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
      title: '重点',
      dataIndex: 'isImportant',
      key: 'isImportant',
      width: 70,
      align: 'center',
      render: (val) => val ? <Tag color="red">重点</Tag> : '--',
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 90,
      align: 'center',
      render: (val) => val === 'alarms'
        ? <Tag color="orange">告警</Tag>
        : <Tag color="blue">自选</Tag>,
    },
  ];

  return (
    <div className="backtest-diagnosis-tab">
      <Card className="diagnosis-card backtest-toolbar-card" bordered={false}>
        <div className="backtest-toolbar">
          <div className="backtest-toolbar-left">
            <Space wrap>
              <Button
                type="primary"
                icon={<SearchOutlined />}
                onClick={handleOpenSelect}
                className="trade-primary-btn"
              >
                选择股票({selectedRowKeys.length})
              </Button>
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
                disabled={selectedRowKeys.length === 0}
                className="trade-run-btn"
              >
                开始回测
              </Button>
            </Space>
          </div>
          <Button
            icon={<ReloadOutlined />}
            onClick={fetchStockList}
            loading={stockListLoading}
            className="trade-secondary-btn"
          >
            刷新股票列表
          </Button>
        </div>

        {selectedStockItems.length > 0 && (
          <div className="backtest-selected-wrap">
            <div className="selected-header">
              <span>已选股票（{selectedStockItems.length} 只）</span>
              <Button type="link" size="small" onClick={handleClearSelected}>清空全部</Button>
            </div>
            <div className="selected-tag-list">
              {selectedStockItems.map(item => (
                <Tag
                  key={item.code}
                  closable
                  onClose={() => handleRemoveSelected(item.code)}
                >
                  {item.stockName}({item.code})
                </Tag>
              ))}
            </div>
          </div>
        )}

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 14, borderRadius: 12, border: '1px solid rgba(54, 87, 214, 0.1)' }}
          message="买卖点诊断规则"
          description={
            <div style={{ fontSize: 12, lineHeight: 1.8, color: '#5b6b86' }}>
              <div><strong style={{ color: '#cf1322' }}>情绪冰点（满足任一）：</strong>① 当日盘中有分时触及冰点（hasIce）；② 前一日科技情绪指数 &lt; -40；③ 前两日科技情绪指数连续为负；④ 前三天科技情绪指数平均值 &lt; 0（前提：前一日情绪 &le; 45，否则不触发）</div>
              <div><strong style={{ color: '#cf1322' }}>买点（需全部满足）：</strong>① 前一日为情绪冰点；② 跟踪指数当日涨幅 &gt; 1%（sh688 跟踪科创板，其他跟踪创业板）；③ 当天科技情绪指数 &ge; -40；④ 10日线斜率非负；⑤ 抗分歧指数 &gt; 8；⑥ 价格不低于10日线。买入价 = (收盘价+开盘价)/2</div>
              <div><strong style={{ color: '#389e0d' }}>卖点（满足任一）：</strong>① MA10上升时收盘价跌破10日线，MA10下降时收盘价未站上5日线；② 高位大阴线（振幅&gt;5%且收盘价&lt;开盘价）；③ 科技情绪退潮 = -100 且自选股中跌幅&lt;-9%的个股≥5；④ 抗分歧指数 &lt; 6</div>
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
              正在拉取 K 线、分时数据并计算买卖点，请耐心等待...
            </div>
          </div>
        </Card>
      )}

      {!backtesting && backtestResults.length > 0 && (
        <div className="backtest-results">
          {backtestResults.map((result) => (
            <BacktestStockCard
              key={result.code}
              result={result}
              onStockClick={onStockClick}
            />
          ))}
        </div>
      )}

      {!backtesting && backtestResults.length === 0 && !backtestError && (
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <Empty
            description="选择股票并设置日期范围后，点击「开始回测」按钮"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: '50px 0' }}
          />
        </Card>
      )}

      <Modal
        title="选择回测股票"
        open={selectModalOpen}
        onCancel={() => setSelectModalOpen(false)}
        onOk={handleConfirmSelect}
        okText={`确认选择(${selectedRowKeys.length})`}
        cancelText="取消"
        width={720}
        centered
        destroyOnClose
      >
        <Input
          placeholder="搜索股票名称或代码"
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          allowClear
          value={selectSearchText}
          onChange={(e) => setSelectSearchText(e.target.value)}
          style={{ marginBottom: 12, borderRadius: 10 }}
        />
        <div style={{ border: '1px solid rgba(18, 33, 58, 0.06)', borderRadius: 12, overflow: 'hidden' }}>
          <Table
            columns={selectColumns}
            dataSource={filteredStockList}
            rowKey="code"
            size="middle"
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ y: 400 }}
            rowSelection={{
              selectedRowKeys,
              onChange: setSelectedRowKeys,
              preserveSelectedRowKeys: true,
            }}
          />
        </div>
      </Modal>
    </div>
  );
};

/**
 * 单只股票的回测结果卡片：K 线图 + 交易明细 + 胜率汇总
 */
const BacktestStockCard = ({ result, onStockClick }) => {
  const { code, stockName, klineData = [], trades = [], markers = [], summary = {}, error } = result;

  if (error) {
    return (
      <Card className="diagnosis-card" bordered={false} style={{ marginTop: 12 }}>
        <Alert
          type="error"
          showIcon
          message={`${stockName || code} 回测失败`}
          description={error}
        />
      </Card>
    );
  }

  const tradeColumns = [
    {
      title: '序号',
      key: 'index',
      width: 50,
      align: 'center',
      render: (_, __, idx) => idx + 1,
    },
    {
      title: '买入日期',
      dataIndex: 'buyDateStr',
      key: 'buyDateStr',
      width: 110,
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
      width: 110,
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
      width: 100,
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
      width: 100,
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
    <Card
      className="diagnosis-card backtest-stock-card"
      bordered={false}
      style={{ marginTop: 14 }}
      title={
        <div className="backtest-stock-title">
          <ExperimentOutlined style={{ color: '#6366f1' }} />
          <span
            className="stock-name"
            onClick={() => onStockClick?.({ code, stockName })}
            style={{ cursor: onStockClick ? 'pointer' : 'default' }}
          >
            {stockName || code}
          </span>
          <span className="stock-code">({code})</span>
        </div>
      }
      extra={
        <div className="backtest-stock-summary">
          <Tag color="blue">总交易 {summary.totalTrades || 0} 次</Tag>
          <Tag color={summary.winRate >= 50 ? 'red' : 'orange'}>胜率 {(summary.winRate || 0).toFixed(1)}%</Tag>
          <Tag color={(summary.totalProfitPct || 0) >= 0 ? 'red' : 'green'}>
            总收益 {formatProfitPct(summary.totalProfitPct)}
          </Tag>
          <Tag color="purple">平均 {formatProfitPct(summary.avgProfitPct)}</Tag>
        </div>
      }
    >
      {klineData.length > 0 ? (
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(18, 33, 58, 0.06)' }}>
          <BacktestKLineChart data={klineData} markers={markers} height={420} />
        </div>
      ) : (
        <Empty description="无 K 线数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      <div className="backtest-summary-grid">
        <div className="summary-metric">
          <span className="label">总交易次数</span>
          <span className="value">{summary.totalTrades || 0}</span>
        </div>
        <div className="summary-metric">
          <span className="label">已平仓</span>
          <span className="value">{summary.realizedTrades || 0}</span>
        </div>
        <div className="summary-metric">
          <span className="label">盈利次数</span>
          <span className="value" style={{ color: '#cf1322' }}>{summary.winTrades || 0}</span>
        </div>
        <div className="summary-metric">
          <span className="label">亏损次数</span>
          <span className="value" style={{ color: '#389e0d' }}>{summary.lossTrades || 0}</span>
        </div>
        <div className="summary-metric">
          <span className="label">胜率</span>
          <span className="value" style={{ color: (summary.winRate || 0) >= 50 ? '#cf1322' : '#fa8c16' }}>
            {(summary.winRate || 0).toFixed(1)}%
          </span>
        </div>
        <div className="summary-metric">
          <span className="label">总收益率</span>
          <span className="value" style={{ color: (summary.totalProfitPct || 0) >= 0 ? '#cf1322' : '#389e0d' }}>
            {formatProfitPct(summary.totalProfitPct)}
          </span>
        </div>
        <div className="summary-metric">
          <span className="label">平均盈亏比例</span>
          <span className="value" style={{ color: (summary.avgProfitPct || 0) >= 0 ? '#cf1322' : '#389e0d' }}>
            {formatProfitPct(summary.avgProfitPct)}
          </span>
        </div>
      </div>

      {trades.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{
            marginBottom: 10,
            fontSize: 14,
            fontWeight: 700,
            color: '#12213a',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            交易明细（{trades.length} 笔）
          </div>
          <Table
            columns={tradeColumns}
            dataSource={trades}
            rowKey={(record, idx) => `${record.buyDate}-${idx}`}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            rowClassName={(record) => record.isUnrealized ? 'unrealized-row' : ''}
            className="backtest-trade-table"
          />
        </div>
      ) : (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 18, borderRadius: 12 }}
          message="回测期间未触发任何买卖点"
          description="该股票在所选日期范围内未满足情绪冰点 → 高开持续拉升 → 触发卖点的完整循环。"
        />
      )}
    </Card>
  );
};

export default BacktestDiagnosisTab;
