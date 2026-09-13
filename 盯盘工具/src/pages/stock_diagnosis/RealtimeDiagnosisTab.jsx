import { useState } from 'react';
import {
  Alert, Button, Card, Empty, Spin, Table, Tag, Space, message, DatePicker,
} from 'antd';
import { ReloadOutlined, ThunderboltOutlined, StarOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';

/**
 * 即时诊断 Tab
 * 买点诊断逻辑：
 *   1. 前置检查7项容灾条件（科创/创业板涨幅、科技情绪、情绪冰点、资金流入、涨跌家数、开盘跳水情况）
 *   2. 7项全部通过后，筛选当日抗分歧指数 > 8 的个股
 *   3. 点击「开始诊断」按钮执行；支持选择日期回溯
 *   4. 重点股票有特殊样式标识
 *   5. 点击股票名称弹出 K 线弹窗
 */
const RealtimeDiagnosisTab = () => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [targetDate, setTargetDate] = useState(dayjs());
  const [klineModalVisible, setKlineModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);

  const handleRefresh = async (refresh = false) => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const dateStr = targetDate ? targetDate.format('YYYYMMDD') : null;
      const res = await axios.post(`http://${local_ip}:3000/diagnose_realtime_buy_points`, {
        targetDate: dateStr,
        refresh: refresh ? 1 : 0,
      });
      if (res.data?.success) {
        setResult(res.data.data);
      } else {
        const msg = res.data?.message || '诊断失败';
        setError(msg);
        message.error(msg);
      }
    } catch (err) {
      console.error('即时买点诊断失败:', err);
      const msg = err?.response?.data?.message || err.message || '诊断失败';
      setError(msg);
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateNum) => {
    if (!dateNum) return '-';
    const s = String(dateNum);
    return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
  };

  const formatTechValue = (val) => {
    if (val === null || val === undefined || typeof val !== 'number') return '-';
    return (
      <span style={{ color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c', fontWeight: 500 }}>
        {val > 0 ? '+' : ''}{val}
      </span>
    );
  };

  const columns = [
    {
      title: '排名',
      key: 'rank',
      width: 60,
      align: 'center',
      render: (_, __, idx) => (
        <span className={`rank-badge rank-${idx < 3 ? 'top' : 'normal'}`}>
          {idx + 1}
        </span>
      ),
    },
    {
      title: '股票名称',
      dataIndex: 'stockName',
      key: 'stockName',
      width: 140,
      render: (text, record) => (
        <span
          onClick={() => {
            setSelectedStock({ code: record.code, name: record.stockName });
            setKlineModalVisible(true);
          }}
          style={{
            fontWeight: 600,
            color: record.isImportant ? '#d4a017' : '#1a1a1a',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            transition: 'color 0.2s ease',
          }}
          className="diagnosis-stock-name"
        >
          {record.isImportant && <StarOutlined style={{ color: '#faad14', fontSize: 14 }} />}
          {text || '-'}
        </span>
      ),
    },
    {
      title: '代码',
      dataIndex: 'code',
      key: 'code',
      width: 100,
      render: (text) => <span style={{ fontFamily: 'monospace', color: '#595959' }}>{text}</span>,
    },
    {
      title: '板块',
      dataIndex: 'blockName',
      key: 'blockName',
      width: 120,
      render: (text) => text ? <Tag>{text}</Tag> : '--',
    },
    {
      title: '前收价',
      dataIndex: 'prevClose',
      key: 'prevClose',
      width: 90,
      align: 'right',
      render: (val) => val != null ? val.toFixed(2) : '-',
    },
    {
      title: '开盘价',
      dataIndex: 'openPrice',
      key: 'openPrice',
      width: 90,
      align: 'right',
      render: (val) => val != null ? val.toFixed(2) : '-',
    },
    {
      title: '建议买入价',
      dataIndex: 'buyPrice',
      key: 'buyPrice',
      width: 100,
      align: 'right',
      render: (val) => val != null ? <span style={{ color: '#cf1322', fontWeight: 600 }}>{val.toFixed(2)}</span> : '-',
    },
    {
      title: '开盘涨幅',
      dataIndex: 'openChange',
      key: 'openChange',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.openChange || 0) - (b.openChange || 0),
      render: (val) => (
        <span style={{ fontWeight: 600, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
          {val != null ? `${val > 0 ? '+' : ''}${val.toFixed(2)}%` : '-'}
        </span>
      ),
    },
    {
      title: '涨跌幅',
      dataIndex: 'change',
      key: 'change',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.change || 0) - (b.change || 0),
      render: (val) => (
        <span style={{ fontWeight: 600, color: val > 0 ? '#cf1322' : val < 0 ? '#389e0d' : '#8c8c8c' }}>
          {val != null ? `${val > 0 ? '+' : ''}${val.toFixed(2)}%` : '-'}
        </span>
      ),
    },
    {
      title: '抗分歧分数',
      dataIndex: 'resilienceScore',
      key: 'resilienceScore',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.resilienceScore || 0) - (b.resilienceScore || 0),
      defaultSortOrder: 'descend',
      render: (val) => (
        <span style={{ fontWeight: 600, color: val >= 10 ? '#cf1322' : val >= 8 ? '#d4a017' : '#8c8c8c' }}>
          {val != null ? val.toFixed(2) : '-'}
        </span>
      ),
    },
    {
      title: '推荐理由',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
      render: (text) => <span style={{ fontSize: 12, color: '#595959' }}>{text}</span>,
    },
  ];

  return (
    <div className="realtime-diagnosis-tab">
      <Card className="diagnosis-card realtime-toolbar-card" bordered={false}>
        <div className="realtime-toolbar">
          <Space>
            <DatePicker
              value={targetDate}
              onChange={(date) => setTargetDate(date)}
              style={{ width: 200 }}
              placeholder="选择日期"
              allowClear={false}
              format="YYYY-MM-DD"
            />
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={loading}
              onClick={() => handleRefresh(true)}
              className="trade-run-btn"
            >
              开始即时诊断
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => handleRefresh(true)}
              loading={loading}
              className="trade-refresh-btn"
            >
              刷新数据
            </Button>
          </Space>
        </div>

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 14, borderRadius: 12, border: '1px solid rgba(54, 87, 214, 0.1)' }}
          message="买点诊断规则"
          description={
            <div style={{ fontSize: 12, lineHeight: 1.8, color: '#5b6b86' }}>
              <div><strong style={{ color: '#cf1322' }}>前置条件（7项需全部满足）：</strong></div>
              <div style={{ paddingLeft: 12 }}>
                1. 科创指数涨幅 {'>'} 1% &nbsp;&nbsp; 2. 创业板指数涨幅 {'>'} 1%<br/>
                3. 科技情绪指数 {'>'} -40 &nbsp;&nbsp; 4. 前一日为情绪冰点<br/>
                5. 最近5分钟资金净流入 {'>'} 20亿 &nbsp;&nbsp; 6. 自选股上涨家数 {'>'} 下跌家数<br/>
                7. 开盘时段(9:30-10:00)低于开盘价个股不超过30只（非此时段跳过）
              </div>
              <div style={{ marginTop: 4 }}><strong style={{ color: '#cf1322' }}>个股筛选：</strong>前置条件全部通过后，筛选当日抗分歧指数 {'>'} 8 的个股</div>
              <div><strong>说明：</strong>可选择日期进行回溯诊断；点击「刷新数据」将实时拉取最新大盘和个股数据。</div>
            </div>
          }
        />
      </Card>

      {loading && (
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '50px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 14, color: '#7b8ba6', fontSize: 14, fontWeight: 500 }}>
              正在拉取分时数据并诊断买点，请耐心等待...
            </div>
          </div>
        </Card>
      )}

      {!loading && error && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 14, borderRadius: 12 }}
          message="诊断失败"
          description={error}
        />
      )}

      {!loading && !error && result && (
        <>
          {/* 前置条件检查结果 */}
          <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>
                前置条件诊断
              </div>
              <Space>
                <Tag color={result.allPassed ? 'success' : 'error'} style={{ margin: 0, fontSize: 12 }}>
                  通过 {result.passedCount}/{result.totalCheckCount} 项
                </Tag>
                {result.timestamp && (
                  <span style={{ fontSize: 12, color: '#8c8c8c' }}>{result.timestamp}</span>
                )}
              </Space>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {result.checks?.map((check, idx) => (
                <div
                  key={check.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: check.passed ? '#f6ffed' : '#fff2f0',
                    border: `1px solid ${check.passed ? '#b7eb8f' : '#ffccc7'}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#fff',
                        background: check.passed ? '#52c41a' : '#f5222d',
                        flexShrink: 0,
                      }}>{idx + 1}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>{check.title}</span>
                    </div>
                    {check.passed ? (
                      <CheckCircleFilled style={{ color: '#52c41a', fontSize: 18, flexShrink: 0 }} />
                    ) : (
                      <CloseCircleFilled style={{ color: '#f5222d', fontSize: 18, flexShrink: 0 }} />
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#595959', marginBottom: 4, paddingLeft: 30 }}>
                    当前值：<span style={{ color: check.passed ? '#389e0d' : '#cf1322', fontWeight: 600 }}>{check.value}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#8c8c8c', lineHeight: 1.5, paddingLeft: 30 }}>
                    {check.reason}
                  </div>
                </div>
              ))}
            </div>

            {/* 结论 */}
            <Alert
              type={result.allPassed ? 'success' : 'warning'}
              showIcon
              style={{ marginTop: 14, borderRadius: 8 }}
              message={result.allPassed ? '🚀 诊断结果：可以出手' : '⚠️ 诊断结果：暂不可出手'}
              description={result.conclusion}
            />
          </Card>

          {/* 符合条件的股票列表 */}
          {result.allPassed && (
            <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
              <div style={{
                marginBottom: 12,
                fontSize: 15,
                fontWeight: 700,
                color: '#12213a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span>符合买点的股票</span>
                <Tag color="error" style={{ margin: 0 }}>
                  {result.matchedStocks?.length || 0} 只 / 共诊断 {result.checkedCount || 0} 只
                </Tag>
              </div>
              {result.matchedStocks?.length > 0 ? (
                <Table
                  columns={columns}
                  dataSource={result.matchedStocks}
                  rowKey="code"
                  size="middle"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  rowClassName={(record) => record.isImportant ? 'important-stock-row' : ''}
                />
              ) : (
                <Empty
                  description="前置条件已满足，但暂无抗分歧指数 > 8 的个股，请继续观望"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  style={{ padding: '30px 0' }}
                />
              )}
            </Card>
          )}

          {/* 情绪冰点信息展示 */}
          {result.isFreezingDay !== undefined && (
            <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#12213a', marginBottom: 10 }}>
                情绪冰点状态
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#8c8c8c', minWidth: 100 }}>诊断日期：</span>
                  <span style={{ color: '#12213a', fontWeight: 600 }}>{formatDate(result.targetDate)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: '#8c8c8c', minWidth: 100 }}>情绪冰点：</span>
                  {result.isFreezingDay ? (
                    <Tag color="error">已触发</Tag>
                  ) : (
                    <Tag color="default">未触发</Tag>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: '#8c8c8c', minWidth: 100 }}>触发原因：</span>
                  <span style={{ color: '#595959', flex: 1 }}>{result.freezingReason || '-'}</span>
                </div>
                {result.prev1 && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: '#8c8c8c', minWidth: 100 }}>前一日情绪：</span>
                    <span>{formatDate(result.prev1.date)} = {formatTechValue(result.prev1.changeSumResult)}</span>
                  </div>
                )}
                {result.prev2 && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: '#8c8c8c', minWidth: 100 }}>前两日情绪：</span>
                    <span>{formatDate(result.prev2.date)} = {formatTechValue(result.prev2.changeSumResult)}</span>
                  </div>
                )}
              </div>
            </Card>
          )}
        </>
      )}

      {!loading && !error && !result && (
        <Card className="diagnosis-card" bordered={false} style={{ marginTop: 14 }}>
          <Empty
            description="点击「开始即时诊断」按钮进行当日买点筛选"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: '50px 0' }}
          />
        </Card>
      )}

      <StockKLineModal
        visible={klineModalVisible}
        onCancel={() => setKlineModalVisible(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.name,
        }}
      />
    </div>
  );
};

export default RealtimeDiagnosisTab;
