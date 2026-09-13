import { useState, useEffect, useMemo } from 'react';
import { Modal, DatePicker, Button, Spin, Alert, Tag, Table, Input, List, Empty, message } from 'antd';
import { SearchOutlined, BarChartOutlined, CheckOutlined, CopyOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import ResilienceChart from './ResilienceChart';
import { getThemeColor } from '../../utils/theme';

const { RangePicker } = DatePicker;

const formatDate = (dateNum) => {
  if (!dateNum) return '--';
  const str = String(dateNum);
  return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
};

const getScoreColor = (score) => {
  if (score >= 15) return { bg: '#fff1f0', text: '#cf1322', border: '#ffa39e' };
  if (score >= 10) return { bg: '#fff7e6', text: '#fa8c16', border: '#ffd591' };
  if (score >= 5) return { bg: '#e6f7ff', text: getThemeColor(), border: '#91d5ff' };
  return { bg: '#f6ffed', text: '#389e0d', border: '#b7eb8f' };
};

export default function SingleStockDiagnosisModal({ visible, onCancel, stocks }) {
  const [selectedStock, setSelectedStock] = useState(null);
  const [dateRange, setDateRange] = useState(null);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    if (visible) {
      const today = dayjs();
      const lastWeek = dayjs().subtract(7, 'day');
      setDateRange([lastWeek, today]);
      setSelectedStock(stocks?.[0] || null);
      setData(null);
      setError('');
      setSearchText('');
    }
  }, [visible, stocks]);

  const filteredStocks = useMemo(() => {
    if (!stocks || !searchText) return stocks || [];
    const lowerText = searchText.toLowerCase();
    return stocks.filter(stock =>
      (stock.stockName && stock.stockName.toLowerCase().includes(lowerText)) ||
      (stock.code && stock.code.toLowerCase().includes(lowerText))
    );
  }, [stocks, searchText]);

  const handleDateChange = (dates) => {
    setDateRange(dates);
    setData(null);
    setError('');
  };

  const handleStockSelect = (stock) => {
    setSelectedStock(stock);
    setData(null);
    setError('');
  };

  const handleDiagnose = async () => {
    if (!selectedStock || !dateRange || dateRange.length !== 2) return;

    setLoading(true);
    setError('');

    try {
      const startDate = dateRange[0].format('YYYY-MM-DD');
      const endDate = dateRange[1].format('YYYY-MM-DD');

      const res = await axios.post(`http://${local_ip}:3000/diagnose_single_stock_resilience`, {
        code: selectedStock.code,
        startDate,
        endDate,
      });

      if (res.data?.success) {
        setData(res.data.data);
      } else {
        setError(res.data?.message || '诊断失败');
      }
    } catch (err) {
      console.error('个股诊断请求失败:', err);
      setError(err?.response?.data?.message || err.message || '诊断失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;

    const copyData = {
      stockName: data.stockName,
      code: data.code,
      indexName: data.indexName,
      indexCode: data.indexCode,
      startDate: data.startDate,
      endDate: data.endDate,
      klineData: data.klineData,
      resilienceData: data.dailyResults,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(copyData, null, 2));
      message.success('数据已复制到剪贴板');
    } catch (err) {
      const textArea = document.createElement('textarea');
      textArea.value = JSON.stringify(copyData, null, 2);
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      message.success('数据已复制到剪贴板');
    }
  };

  const dailyColumns = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      width: 100,
      render: (text) => formatDate(text),
    },
    {
      title: '抗分歧得分',
      key: 'resilienceScore',
      width: 120,
      align: 'center',
      render: (_, record) => {
        const score = record.resilienceScore || 0;
        const colors = getScoreColor(score);
        return (
          <div style={{
            display: 'inline-block',
            minWidth: '52px',
            padding: '4px 8px',
            borderRadius: '6px',
            backgroundColor: colors.bg,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            fontWeight: 600,
            fontSize: 13,
            textAlign: 'center',
          }}>
            {score.toFixed(2)}
          </div>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      align: 'center',
      render: (_, record) => {
        if (record.error) return <Tag color="error">异常</Tag>;
        const score = record.resilienceScore || 0;
        if (score >= 15) return <Tag color="error">极强抗跌</Tag>;
        if (score >= 10) return <Tag color="warning">较强抗跌</Tag>;
        if (score >= 5) return <Tag color="processing">跟随指数</Tag>;
        return <Tag color="success">偏弱</Tag>;
      },
    },
    {
      title: '个股涨幅',
      dataIndex: 'stockChange',
      key: 'stockChange',
      width: 100,
      align: 'right',
      render: (val) => {
        const numVal = typeof val === 'number' ? val : parseFloat(val) || 0;
        return (
          <span style={{ fontWeight: 500, color: numVal > 0 ? '#cf1322' : numVal < 0 ? '#389e0d' : '#8c8c8c' }}>
            {numVal > 0 ? '+' : ''}{numVal.toFixed(2)}%
          </span>
        );
      },
    },
    {
      title: '指数涨幅',
      dataIndex: 'indexChange',
      key: 'indexChange',
      width: 100,
      align: 'right',
      render: (val) => {
        const numVal = typeof val === 'number' ? val : parseFloat(val) || 0;
        return (
          <span style={{ fontWeight: 500, color: numVal > 0 ? '#cf1322' : numVal < 0 ? '#389e0d' : '#8c8c8c' }}>
            {numVal > 0 ? '+' : ''}{numVal.toFixed(2)}%
          </span>
        );
      },
    },
  ];

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChartOutlined style={{ color: getThemeColor() }} />
          个股抗分歧诊断
        </div>
      }
      open={visible}
      onCancel={onCancel}
      width={1300}
      centered
      footer={null}
      bodyStyle={{ padding: '16px 24px' }}
    >
      <div style={{ display: 'flex', gap: 16, height: 'min(calc(100vh - 200px), 800px)' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>已选股票：</span>
              <Tag color="blue" style={{ fontSize: 13, padding: '4px 12px' }}>
                {selectedStock?.stockName || selectedStock?.code || '未选择'}
              </Tag>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>选择日期：</span>
              <RangePicker
                value={dateRange}
                onChange={handleDateChange}
                style={{ width: 280 }}
              />
            </div>
          </div>

          {error && (
            <Alert type="error" showIcon message="诊断失败" description={error} style={{ marginBottom: 16 }} />
          )}

          {loading ? (
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <Spin size="large" />
              <div style={{ marginLeft: 16, fontSize: 14, color: '#999' }}>
                正在拉取分时数据并计算抗分歧得分，请耐心等待...
              </div>
            </div>
          ) : data ? (
            <div style={{ flex: 1, overflow: 'auto' }}>
              <div style={{ marginBottom: 16, padding: '12px 16px', backgroundColor: '#f9f9f9', borderRadius: 8, fontSize: 13 }}>
                <div style={{ marginBottom: 4 }}>
                  <strong>股票：</strong>{data.stockName}({data.code})
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong>跟踪指数：</strong>{data.indexName}({data.indexCode})
                </div>
                <div>
                  <strong>诊断区间：</strong>{data.startDate} ~ {data.endDate}
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <h4 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600 }}>K线图与抗分歧指数</h4>
                <ResilienceChart klineData={data.klineData || []} resilienceData={data.dailyResults || []} height={400} />
              </div>

              <div>
                <h4 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600 }}>每日抗分歧诊断明细</h4>
                <Table columns={dailyColumns} dataSource={data.dailyResults || []} rowKey="date" size="middle" pagination={false} />
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: '#999' }}>
              请选择股票和日期范围，点击下方「开始诊断」按钮
            </div>
          )}

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Button
              icon={<CopyOutlined />}
              onClick={handleCopy}
              disabled={!data}
              style={{ borderRadius: 6, width: 120, marginRight: 12 }}
            >
              复制数据
            </Button>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={loading}
              onClick={handleDiagnose}
              disabled={!selectedStock || !dateRange}
              style={{ borderRadius: 6, width: 160 }}
            >
              开始诊断
            </Button>
          </div>
        </div>

        <div style={{ width: 260, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #f0f0f0', paddingLeft: 16 }}>
          <div style={{ marginBottom: 12 }}>
            <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>股票列表</h4>
            <Input
              placeholder="搜索股票名称或代码"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              prefix={<SearchOutlined />}
              style={{ borderRadius: 6 }}
            />
          </div>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {filteredStocks.length > 0 ? (
              <List
                dataSource={filteredStocks}
                renderItem={(stock) => (
                  <List.Item
                    onClick={() => handleStockSelect(stock)}
                    style={{
                      cursor: 'pointer',
                      borderRadius: 6,
                      padding: '8px 12px',
                      marginBottom: 4,
                      backgroundColor: selectedStock?.code === stock.code ? '#e6f7ff' : '#fff',
                      border: selectedStock?.code === stock.code ? '1px solid #91d5ff' : '1px solid transparent',
                      transition: 'all 0.2s',
                    }}
                    hoverStyle={{ backgroundColor: '#f5f5f5' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{stock.stockName}</div>
                        <div style={{ fontSize: 11, color: '#999' }}>{stock.code}</div>
                      </div>
                      {selectedStock?.code === stock.code && (
                        <CheckOutlined style={{ color: getThemeColor(), fontSize: 14 }} />
                      )}
                    </div>
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="没有找到匹配的股票" />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
