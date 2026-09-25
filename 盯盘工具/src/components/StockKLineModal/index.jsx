import React, { useState, useEffect, useRef } from 'react';
import { Modal, Typography, Space, Tag, Spin, Empty, Segmented, Button, message, Switch } from 'antd';
import { LineChartOutlined, BarChartOutlined, AreaChartOutlined, HistoryOutlined, RadarChartOutlined, StarOutlined } from '@ant-design/icons';
import axios from 'axios';
import dayjs from 'dayjs';
import { isTradingDay, getPrevTradingDay } from '../../utils/tradingDay';
import { local_ip } from '../../constant';
import StockKLine from '../StockKLine';
import StockTimeLine from '../StockTimeLine';
import StockTimeLineModal from '../StockTimeLineModal';
import IntradayIntentChart from '../IntradayIntentChart';
import IntradayResilienceChart from '../../pages/stock_diagnosis/IntradayResilienceChart';
import { getThemeColor } from '../../utils/theme';

const { Text } = Typography;

const StockKLineModal = ({ 
  visible, 
  onCancel, 
  title = '个股行情图表', 
  stockInfo = {}, 
  code 
}) => {
  const [kData, setKData] = useState([]);
  const [tData, setTData] = useState([]);
  const [indexTData, setIndexTData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chartType, setChartType] = useState('kline');
  const [timelineVisible, setTimelineVisible] = useState(false);
  const [intervalAnalysis, setIntervalAnalysis] = useState([]);
  const [resilienceData, setResilienceData] = useState(null);
  const [resilienceLoading, setResilienceLoading] = useState(false);
  const [showResilienceKline, setShowResilienceKline] = useState(false);
  const [dayTlineVisible, setDayTlineVisible] = useState(false);
  const [dayTlineData, setDayTlineData] = useState([]);
  const [dayTlineLoading, setDayTlineLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState('');
  const [stockName, setStockName] = useState('');
  const pollingRef = useRef(null);
  const klinePollingRef = useRef(null);

  // 实时涨幅：优先取分时轮询数据的最新点（3秒更新），其次K线最新一天，最后回退传入的 stockInfo
  const liveChange = (() => {
    const lastPoint = tData.length > 0 ? tData[tData.length - 1] : null;
    if (lastPoint && lastPoint.change !== undefined && lastPoint.change !== null) return lastPoint.change;
    if (kData.length > 0 && kData[0]?.change !== undefined && kData[0]?.change !== null) return kData[0].change;
    return stockInfo.change;
  })();
  const displayName = stockName || stockInfo.name;

  const fetchTimelineData = async () => {
    if (!code) return;
    try {
      const indexCode = code.startsWith('sh688') ? 'sh000688' : 'sz399006';
      const [tResponse, indexResponse] = await Promise.all([
        axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code } }),
        axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: indexCode } })
      ]);
      setTData(tResponse.data?.line || []);
      setIndexTData(indexResponse.data?.line || []);
      if (tResponse.data?.stockName) setStockName(tResponse.data.stockName);
    } catch (error) {
      console.error('Fetch timeline data failed:', error);
    }
  };

  const fetchKlineData = async () => {
    if (!code) return;
    try {
      const res = await axios.get(`http://${local_ip}:3000/stock_data`, { params: { code } });
      setKData(res.data || []);
    } catch (error) {
      console.error('Fetch kline data failed:', error);
    }
  };

  useEffect(() => {
    if (visible && code) {
      fetchTimelineData();
      fetchKlineData();
      pollingRef.current = setInterval(fetchTimelineData, 3000);
      klinePollingRef.current = setInterval(fetchKlineData, 30000);
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      if (klinePollingRef.current) {
        clearInterval(klinePollingRef.current);
        klinePollingRef.current = null;
      }
    };
  }, [visible, code]);

  useEffect(() => {
    if (visible && code) {
      fetchStockData();
    } else if (!visible) {
      setKData([]);
      setTData([]);
      setIndexTData([]);
      setLoading(true);
      setIntervalAnalysis([]);
      setResilienceData(null);
      setResilienceLoading(false);
      setShowResilienceKline(false);
      setDayTlineVisible(false);
      setDayTlineData([]);
      setSelectedDay('');
      setStockName('');
    }
  }, [visible, code]);

  useEffect(() => {
    if (chartType === 'resilienceTimeline' && code && !resilienceData) {
      fetchResilienceData();
    }
  }, [chartType, code]);

  useEffect(() => {
    if (chartType === 'quantTimeline' && tData.length > 0 && intervalAnalysis.length === 0) {
      fetchIntervalAnalysis();
    }
  }, [chartType, tData]);

  const fetchStockData = async () => {
    setLoading(true);
    try {
      const indexCode = code.startsWith('sh688') ? 'sh000688' : 'sz399006';
      const [kResponse, tResponse, indexResponse] = await Promise.all([
        axios.get(`http://${local_ip}:3000/stock_data`, { params: { code } }),
        axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code } }),
        axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: indexCode } })
      ]);
      setKData(kResponse.data || []);
      setTData(tResponse.data?.line || []);
      setIndexTData(indexResponse.data?.line || []);
      if (tResponse.data?.stockName) setStockName(tResponse.data.stockName);
    } catch (error) {
      console.error('Fetch stock data failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchResilienceData = async () => {
    setResilienceLoading(true);
    try {
      const today = dayjs();
      // 非交易日（周末/节假日，以交易日历为准）回退到最近一个交易日
      let targetDate = today;
      if (!isTradingDay(today)) {
        targetDate = getPrevTradingDay(today);
      }

      const dateStr = targetDate.format('YYYY-MM-DD');

      const res = await axios.post(`http://${local_ip}:3000/diagnose_intraday_resilience`, {
        code,
        date: dateStr,
      });

      if (res.data?.success) {
        setResilienceData(res.data.data);
      } else {
        console.error('抗分歧分时诊断失败:', res.data?.message);
      }
    } catch (error) {
      console.error('Fetch resilience data failed:', error);
    } finally {
      setResilienceLoading(false);
    }
  };

  const fetchMultiDayResilienceData = async () => {
    if (!code || kData.length === 0) return;
    
    const latestDate = kData[0]?.trade_date;
    
    if (!latestDate) return;
    
    const endDate = String(latestDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    
    const startDateObj = dayjs(endDate).subtract(30, 'day');
    const startDate = startDateObj.format('YYYY-MM-DD');
    
    try {
      const res = await axios.post(`http://${local_ip}:3000/diagnose_single_stock_resilience`, {
        code,
        startDate,
        endDate,
      });
      
      if (res.data?.success) {
        return res.data.data;
      }
    } catch (error) {
      console.error('Fetch multi-day resilience data failed:', error);
    }
    return null;
  };

  const fetchIntervalAnalysis = async () => {
    if (!tData.length || !code) {
      console.log('No tData or code available for interval analysis');
      return;
    }
    try {
      console.log('Fetching interval analysis with tData length:', tData.length);
      const res = await axios.post(`http://${local_ip}:3000/api/intraday-intent-analysis`, {
        tlineData: tData,
        code
      });
      console.log('Interval analysis response:', res.data);
      if (res.data?.intervalAnalysis) {
        console.log('Setting intervalAnalysis:', res.data.intervalAnalysis.length, 'items');
        setIntervalAnalysis(res.data.intervalAnalysis);
      } else {
        console.log('No intervalAnalysis in response');
      }
    } catch (error) {
      console.error('Fetch interval analysis failed:', error);
    }
  };

  const handleCandleClick = async (dateStr) => {
    if (!code || kData.length === 0) return;
    // 最新一天的日期（kData 按从新到旧排序，index 0 为最新）
    const latestDateStr = String(kData[0].trade_date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    if (dateStr === latestDateStr) {
      // 点击最新一天，直接切换到量化分时 tab
      setChartType('quantTimeline');
      return;
    }
    // 其他日期：弹出该日分时图弹窗
    const dateInt = dateStr.replace(/-/g, '');
    setSelectedDay(dateStr);
    setDayTlineVisible(true);
    setDayTlineLoading(true);
    setDayTlineData([]);
    try {
      const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code, date: dateInt } });
      setDayTlineData(res.data?.line || []);
    } catch (error) {
      console.error('Fetch day tline data failed:', error);
    } finally {
      setDayTlineLoading(false);
    }
  };

  return (
    <>
      <Modal
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '95%' }}>
            <Space>
              <LineChartOutlined style={{ color: getThemeColor() }} />
              {displayName && <Text strong>{displayName}</Text>}
              {stockInfo.code && <Text type="secondary">({stockInfo.code})</Text>}
              {liveChange !== undefined && liveChange !== null && (
                <Tag color={parseFloat(liveChange) > 0 ? 'error' : 'success'} borderless>
                  {liveChange > 0 ? '+' : ''}{liveChange}%
                </Tag>
              )}
              <Button
                size="small"
                type="primary"
                icon={<StarOutlined />}
                onClick={() => {
                  axios.post(`http://${local_ip}:3000/toggle_stock_important`, { code })
                    .then((res) => {
                      if (res.data.success) {
                        message.success(`已将 ${stockInfo.name || code} 标记为重点股票`);
                      } else {
                        message.error('标记失败');
                      }
                    })
                    .catch(() => {
                      message.error('标记失败，请稍后重试');
                    });
                }}
                style={{ fontSize: '12px', padding: '2px 8px' }}
              >
                添加重点股票
              </Button>
            </Space>
            <Segmented
              options={[
                { label: 'K线图', value: 'kline', icon: <BarChartOutlined /> },
                // { label: '分时图', value: 'timeline', icon: <AreaChartOutlined /> },
                { label: '量化分时', value: 'quantTimeline', icon: <HistoryOutlined /> },
                { label: '抗分歧分时', value: 'resilienceTimeline', icon: <RadarChartOutlined /> },
              ]}
              value={chartType}
              onChange={(v) => {
                setChartType(v);
              }}
            />
          </div>
        }
        open={visible}
        onCancel={onCancel}
        footer={null}
        width={1400}
        centered
        destroyOnClose
        bodyStyle={{ padding: '24px', minHeight: '500px' }}
      >
        <div className="stock-chart-modal-content" style={{ width: '100%' }}>
          {loading ? (
            <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip="正在加载行情数据..." size="large" />
            </div>
          ) : (
            chartType === 'resilienceTimeline' ? (
              resilienceLoading ? (
                <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Spin tip="正在计算抗分歧得分..." size="large" />
                </div>
              ) : resilienceData ? (
                <IntradayResilienceChart
                  timelineData={resilienceData.stockLine || []}
                  indexTimelineData={resilienceData.indexLine || []}
                  segmentResults={resilienceData.segmentResults || []}
                  height={500}
                  stockName={resilienceData.stockName}
                  indexName={resilienceData.indexName}
                  overallResilience={resilienceData.overallResilience}
                  overallStatus={resilienceData.overallStatus}
                />
              ) : (
                <Empty description="暂无抗分歧分时数据" />
              )
            ) : chartType === 'quantTimeline' ? (
              tData.length > 0 ? (
                <IntradayIntentChart
                  timelineData={tData}
                  indexTimelineData={indexTData}
                  intervalAnalysis={intervalAnalysis}
                  height={500}
                  stockName={stockInfo.name}
                />
              ) : (
                <Empty description="暂无分时数据" />
              )
            ) : chartType === 'timeline' ? (
              tData.length > 0 ? (
                <StockTimeLine data={tData} height={500} preClose={kData[kData.length - 2]?.close} />
              ) : (
                <Empty description="暂无分时数据" />
              )
            ) : (
              kData.length > 0 ? (
                <>
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'flex-end', 
                    marginBottom: '8px',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <span style={{ fontSize: '13px', color: '#666' }}>抗分歧 K 线</span>
                    <Switch 
                      checked={showResilienceKline} 
                      onChange={(checked) => setShowResilienceKline(checked)}
                      checkedChildren="开启"
                      unCheckedChildren="关闭"
                    />
                  </div>
                  <StockKLine 
                    data={kData} 
                    height={500} 
                    showResilience={showResilienceKline}
                    onFetchResilience={fetchMultiDayResilienceData}
                    onClickCandle={handleCandleClick}
                  />
                </>
              ) : (
                <Empty description="暂无 K 线数据" />
              )
            )
          )}
        </div>
      </Modal>

      <StockTimeLineModal 
        visible={timelineVisible}
        onCancel={() => setTimelineVisible(false)}
        code={code}
        stockInfo={stockInfo}
      />

      <Modal
        title={
          selectedDay ? (
            <Space>
              <AreaChartOutlined style={{ color: getThemeColor() }} />
              {stockInfo.name && <Text strong>{stockInfo.name}</Text>}
              {stockInfo.code && <Text type="secondary">({stockInfo.code})</Text>}
              <Text type="secondary">{selectedDay} 分时图</Text>
            </Space>
          ) : '当日分时图'
        }
        open={dayTlineVisible}
        onCancel={() => setDayTlineVisible(false)}
        footer={null}
        width={1100}
        centered
        destroyOnClose
        bodyStyle={{ padding: '24px', minHeight: '400px' }}
      >
        {dayTlineLoading ? (
          <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin tip="正在加载分时数据..." size="large" />
          </div>
        ) : dayTlineData.length > 0 ? (
          <StockTimeLine data={dayTlineData} height={450} />
        ) : (
          <Empty description="暂无该日分时数据" />
        )}
      </Modal>
    </>
  );
};

export default StockKLineModal;
