import { useState, useEffect, useMemo } from 'react';
import { Modal, DatePicker, Button, Spin, Alert, Tag, Input, List, Empty } from 'antd';
import { SearchOutlined, ClockCircleOutlined, CheckOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import IntradayResilienceChart from './IntradayResilienceChart';
import { getThemeColor } from '../../utils/theme';

const getScoreColor = (score) => {
  if (score >= 15) return { bg: '#fff1f0', text: '#cf1322', border: '#ffa39e' };
  if (score >= 10) return { bg: '#fff7e6', text: '#fa8c16', border: '#ffd591' };
  if (score >= 5) return { bg: '#e6f7ff', text: getThemeColor(), border: '#91d5ff' };
  return { bg: '#f6ffed', text: '#389e0d', border: '#b7eb8f' };
};

export default function IntradayDiagnosisModal({ visible, onCancel, stocks }) {
  const [selectedStock, setSelectedStock] = useState(null);
  const [selectedDate, setSelectedDate] = useState(dayjs());
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    if (visible) {
      setSelectedDate(dayjs());
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

  const handleDateChange = (date) => {
    setSelectedDate(date);
    setData(null);
    setError('');
  };

  const handleStockSelect = (stock) => {
    setSelectedStock(stock);
    setData(null);
    setError('');
  };

  const handleDiagnose = async () => {
    if (!selectedStock || !selectedDate) return;

    setLoading(true);
    setError('');

    try {
      const dateStr = selectedDate.format('YYYY-MM-DD');

      const res = await axios.post(`http://${local_ip}:3000/diagnose_intraday_resilience`, {
        code: selectedStock.code,
        date: dateStr,
      });

      if (res.data?.success) {
        setData(res.data.data);
      } else {
        setError(res.data?.message || '诊断失败');
      }
    } catch (err) {
      console.error('个股分时诊断请求失败:', err);
      setError(err?.response?.data?.message || err.message || '诊断失败');
    } finally {
      setLoading(false);
    }
  };

  const formatDateNum = (dateNum) => {
    if (!dateNum) return '--';
    const str = String(dateNum);
    return `${str.substring(0, 4)}-${str.substring(4, 6)}-${str.substring(6, 8)}`;
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClockCircleOutlined style={{ color: getThemeColor() }} />
          个股分时抗分歧诊断
        </div>
      }
      open={visible}
      onCancel={onCancel}
      width={1300}
      centered
      footer={null}
      bodyStyle={{ padding: '16px 24px' }}
    >
      <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 200px)' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>已选股票：</span>
              <Tag color="blue" style={{ fontSize: 13, padding: '4px 12px' }}>
                {selectedStock?.stockName || selectedStock?.code || '未选择'}
              </Tag>
              {selectedStock && (
                <Tag style={{ fontSize: 12, color: '#8c8c8c', borderColor: '#d9d9d9' }}>
                  跟踪指数：{selectedStock.code.startsWith('sh688') ? '科创50(sh000688)' : '创业板指(sz399006)'}
                </Tag>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>选择日期：</span>
              <DatePicker
                value={selectedDate}
                onChange={handleDateChange}
                allowClear={false}
                disabledDate={(current) => current && current > dayjs().endOf('day')}
                style={{ width: 200 }}
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
                正在拉取分时数据并计算分段抗分歧得分，请耐心等待...
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
                  <strong>诊断日期：</strong>{formatDateNum(data.date)}
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <IntradayResilienceChart
                  timelineData={data.stockLine || []}
                  indexTimelineData={data.indexLine || []}
                  segmentResults={data.segmentResults || []}
                  height={350}
                  stockName={data.stockName}
                  indexName={data.indexName}
                />
              </div>

              <div>
                <h4 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600 }}>分段抗分歧诊断明细</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {(data.segmentResults || []).map((seg, index) => {
                    const colors = getScoreColor(seg.resilienceScore);
                    return (
                      <div
                        key={index}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          minWidth: 70,
                          padding: '8px 6px',
                          borderRadius: 6,
                          backgroundColor: colors.bg,
                          border: `1px solid ${colors.border}`,
                        }}
                      >
                        <span style={{ fontSize: 11, color: '#8c8c8c' }}>
                          {String(Math.floor(seg.startMinute / 100)).padStart(2, '0')}:{String(seg.startMinute % 100).padStart(2, '0')}
                        </span>
                        <span style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: '2px 0' }}>
                          {seg.error ? '--' : seg.resilienceScore.toFixed(1)}
                        </span>
                        <span style={{ fontSize: 10, color: seg.error ? '#bfbfbf' : colors.text }}>
                          {seg.status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: '#999' }}>
              请选择股票和日期，点击下方「开始诊断」按钮
            </div>
          )}

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={loading}
              onClick={handleDiagnose}
              disabled={!selectedStock || !selectedDate}
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
