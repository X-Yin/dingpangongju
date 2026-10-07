import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Modal, Typography, Space, Tag, Spin, Empty, Segmented, Button, message, Switch, List } from 'antd';
import { LineChartOutlined, BarChartOutlined, AreaChartOutlined, HistoryOutlined, RadarChartOutlined, StarOutlined, FileTextOutlined } from '@ant-design/icons';
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
  code,
  // 可选：交易记录（回测报告点击股票名称查看时传入），用于在日K图上标注买卖点与买卖价格虚线，并在 K 线下方内嵌展示当日分时
  // 结构：{ buyDate, buyTime, buyPrice, sellDate, sellTime, sellPrice }（buyDate/sellDate 为 YYYYMMDD，时间字段可缺省）
  tradeRecord = null,
  // 可选：打开弹窗时默认展示的 tab（'kline' | 'quantTimeline' | 'resilienceTimeline'），缺省为 'kline'
  initialTab = 'kline',
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
  const [showInstitution, setShowInstitution] = useState(false);
  const [dayTlineVisible, setDayTlineVisible] = useState(false);
  const [dayTlineData, setDayTlineData] = useState([]);
  const [dayTlineLoading, setDayTlineLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState('');
  const [stockName, setStockName] = useState('');
  const [zyjsText, setZyjsText] = useState('');
  const [newsVisible, setNewsVisible] = useState(false);
  const [newsData, setNewsData] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
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

  // KLine 组件只在初始化时注册一次点击回调，用 ref 读取最新 tradeRecord 避免闭包捕获旧值
  const tradeRecordRef = useRef(tradeRecord);
  useEffect(() => {
    tradeRecordRef.current = tradeRecord;
  }, [tradeRecord]);

  // YYYYMMDD → 'YYYY-MM-DD'（K 线图 time 轴格式），非法值返回 null
  const fmtTradeDay = (d) => {
    const s = String(d || '');
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
  };

  // 日K图买卖点 marker：买入红 B（K线柱下方、向上箭头），卖出蓝 S（K线柱上方、向下箭头）
  // 同日先卖后买时两个 marker 都画（lightweight-charts 支持同一 time 多个 marker 叠放）
  const tradeMarkers = useMemo(() => {
    if (!tradeRecord) return [];
    const markers = [];
    const buyDay = fmtTradeDay(tradeRecord.buyDate);
    const sellDay = tradeRecord.sellDate ? fmtTradeDay(tradeRecord.sellDate) : null;
    if (buyDay) markers.push({ time: buyDay, position: 'belowBar', color: '#f5222d', shape: 'arrowUp', text: 'B' });
    if (sellDay) markers.push({ time: sellDay, position: 'aboveBar', color: '#722ed1', shape: 'arrowDown', text: 'S' });
    return markers;
  }, [tradeRecord]);

  // 日K图买卖价格虚线：买入价红色、卖出价绿色（仍持仓无 sellPrice 时只画买入线）
  const tradePriceLines = useMemo(() => {
    if (!tradeRecord) return [];
    const lines = [];
    const buyPrice = Number(tradeRecord.buyPrice);
    const sellPrice = tradeRecord.sellPrice != null ? Number(tradeRecord.sellPrice) : NaN;
    if (Number.isFinite(buyPrice) && buyPrice > 0) lines.push({ price: buyPrice, color: '#f5222d', title: '买入' });
    if (Number.isFinite(sellPrice) && sellPrice > 0) lines.push({ price: sellPrice, color: '#722ed1', title: '卖出' });
    return lines;
  }, [tradeRecord]);

  // 分时图时间 marker：点击日期等于买入/卖出日期时，在当日分时图上标注买卖时间点（B/S）
  const tradeDayMarkers = useMemo(() => {
    if (!tradeRecord || !selectedDay) return [];
    const markers = [];
    const buyDay = fmtTradeDay(tradeRecord.buyDate);
    const sellDay = tradeRecord.sellDate ? fmtTradeDay(tradeRecord.sellDate) : null;
    if (tradeRecord.buyTime && selectedDay === buyDay) {
      markers.push({ time: tradeRecord.buyTime, color: '#f5222d', text: 'B', position: 'belowBar' });
    }
    if (tradeRecord.sellTime && sellDay && selectedDay === sellDay) {
      markers.push({ time: tradeRecord.sellTime, color: '#52c41a', text: 'S', position: 'aboveBar' });
    }
    return markers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeRecord, selectedDay]);

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

  // 主营业务介绍（同花顺）：symbol 需去掉市场前缀
  const fetchZyjsData = async () => {
    if (!code) return;
    const symbol = code.replace(/^(sh|sz|bj)/i, '');
    try {
      const res = await axios.get(`http://${local_ip}:3000/api/ak/stock_zyjs`, { params: { code: symbol } });
      if (res.data?.success && Array.isArray(res.data.data) && res.data.data.length > 0) {
        setZyjsText(res.data.data[0]['主营业务'] || '');
      }
    } catch (error) {
      console.error('Fetch zyjs data failed:', error);
    }
  };

  // 个股新闻（东财）：打开新闻弹窗时懒加载
  const fetchNewsData = async () => {
    if (!code) return;
    const symbol = code.replace(/^(sh|sz|bj)/i, '');
    setNewsLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/api/ak/stock_news`, { params: { code: symbol } });
      if (res.data?.success) {
        setNewsData(res.data.data || []);
      } else {
        message.error(res.data?.message || '获取个股新闻失败');
      }
    } catch (error) {
      console.error('Fetch stock news failed:', error);
      message.error('获取个股新闻失败，请稍后重试');
    } finally {
      setNewsLoading(false);
    }
  };

  const handleOpenNews = () => {
    setNewsVisible(true);
    if (newsData.length === 0 && !newsLoading) {
      fetchNewsData();
    }
  };

  useEffect(() => {
    if (visible && code) {
      // 每次打开弹窗按 initialTab 定位 tab（盘口异动点击股票名会传 quantTimeline）
      setChartType(initialTab || 'kline');
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
      fetchZyjsData();
    } else if (!visible) {
      setKData([]);
      setTData([]);
      setIndexTData([]);
      setLoading(true);
      setIntervalAnalysis([]);
      setResilienceData(null);
      setResilienceLoading(false);
      setShowResilienceKline(false);
      setShowInstitution(false);
      setDayTlineVisible(false);
      setDayTlineData([]);
      setSelectedDay('');
      setStockName('');
      setZyjsText('');
      setNewsVisible(false);
      setNewsData([]);
      setNewsLoading(false);
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

  // 机构参与度：东财千股千评（按交易日），symbol 需去掉市场前缀
  const fetchInstitutionData = async () => {
    if (!code) return null;
    const symbol = code.replace(/^(sh|sz|bj)/i, '');
    try {
      const res = await axios.get(`http://${local_ip}:3000/api/ak/jgcyd`, { params: { code: symbol } });
      if (res.data?.success) {
        return res.data.data;
      }
    } catch (error) {
      console.error('Fetch institution participation data failed:', error);
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
    const inTradeMode = !!tradeRecordRef.current;
    // 最新一天的日期（kData 按从新到旧排序，index 0 为最新）
    const latestDateStr = String(kData[0].trade_date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    if (!inTradeMode && dateStr === latestDateStr) {
      // 点击最新一天，直接切换到量化分时 tab（原有行为）
      setChartType('quantTimeline');
      return;
    }
    // 其他日期：交易标注模式下在 K 线下方内嵌展示当日分时图；普通模式弹独立分时弹窗
    const dateInt = dateStr.replace(/-/g, '');
    setSelectedDay(dateStr);
    setDayTlineLoading(true);
    setDayTlineData([]);
    setDayTlineVisible(!inTradeMode);
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
              <Button
                size="small"
                icon={<FileTextOutlined />}
                onClick={handleOpenNews}
                style={{ fontSize: '12px', padding: '2px 8px' }}
              >
                个股新闻
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
                    justifyContent: 'space-between',
                    marginBottom: '8px',
                    alignItems: 'center',
                    gap: '12px'
                  }}>
                    {zyjsText && (
                      <Text
                        type="secondary"
                        title={zyjsText}
                        style={{
                          fontSize: 12,
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Text strong style={{ fontSize: 12, color: getThemeColor() }}>主营业务：</Text>
                        {zyjsText}
                      </Text>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      <span style={{ fontSize: '13px', color: showResilienceKline ? '#722ed1' : '#666' }}>抗分歧 K 线</span>
                      <Switch
                        checked={showResilienceKline}
                        onChange={(checked) => setShowResilienceKline(checked)}
                        checkedChildren="开启"
                        unCheckedChildren="关闭"
                      />
                      <span style={{ fontSize: '13px', color: showInstitution ? '#1677ff' : '#666', marginLeft: '8px' }}>机构参与度</span>
                      <Switch
                        checked={showInstitution}
                        onChange={(checked) => setShowInstitution(checked)}
                        checkedChildren="开启"
                        unCheckedChildren="关闭"
                      />
                    </div>
                  </div>
                  <StockKLine
                    data={kData}
                    height={500}
                    showResilience={showResilienceKline}
                    onFetchResilience={fetchMultiDayResilienceData}
                    showInstitution={showInstitution}
                    onFetchInstitution={fetchInstitutionData}
                    onClickCandle={handleCandleClick}
                    tradeMarkers={tradeMarkers}
                    priceLines={tradePriceLines}
                  />
                  {/* 交易标注模式：点击日K柱后，在 K 线下方内嵌展示该日分时图（买入/卖出日自动标注 B/S 时间点） */}
                  {tradeRecord && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>
                        {selectedDay ? (
                          <Space size={8}>
                            <AreaChartOutlined style={{ color: getThemeColor() }} />
                            <Text strong>{selectedDay} 分时图</Text>
                            {dayTlineData.length > 0 && tradeDayMarkers.length > 0 && (
                              <Text type="secondary">
                                （{tradeDayMarkers.map(m => `${m.text} ${m.time}`).join('、')} 已标注）
                              </Text>
                            )}
                          </Space>
                        ) : (
                          <Text type="secondary">
                            点击上方日K线任意交易日的K线柱，可在下方查看当日分时图；买入/卖出日会自动标注 B/S 时间点
                          </Text>
                        )}
                      </div>
                      {selectedDay && (
                        dayTlineLoading ? (
                          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Spin tip="正在加载分时数据..." size="large" />
                          </div>
                        ) : dayTlineData.length > 0 ? (
                          <StockTimeLine data={dayTlineData} height={300} timeMarkers={tradeDayMarkers} />
                        ) : (
                          <Empty description="暂无该日分时数据" />
                        )
                      )}
                    </div>
                  )}
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

      {/* 个股新闻弹窗：叠在主弹窗之上，新闻列表可点击跳转原文 */}
      <Modal
        title={
          <Space>
            <FileTextOutlined style={{ color: getThemeColor() }} />
            {displayName && <Text strong>{displayName}</Text>}
            <Text type="secondary">个股新闻</Text>
          </Space>
        }
        open={newsVisible}
        onCancel={() => setNewsVisible(false)}
        footer={null}
        width={720}
        centered
        destroyOnClose
        zIndex={1100}
        bodyStyle={{ padding: '8px 24px', maxHeight: '65vh', overflowY: 'auto' }}
      >
        {newsLoading ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin tip="正在加载个股新闻..." size="large" />
          </div>
        ) : newsData.length > 0 ? (
          <List
            dataSource={newsData}
            rowKey={(item, idx) => `${item['新闻链接'] || ''}-${idx}`}
            renderItem={(item) => (
              <List.Item style={{ padding: '10px 0' }}>
                <a
                  href={item['新闻链接']}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'block', width: '100%', color: 'inherit' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                    <Text strong style={{ fontSize: 13, color: 'rgba(0,0,0,0.88)' }}>{item['新闻标题']}</Text>
                    <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{item['发布时间']}</Text>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: '#666',
                      marginTop: 4,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {item['新闻内容']}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>来源：{item['文章来源']}</Text>
                </a>
              </List.Item>
            )}
          />
        ) : (
          <Empty description="暂无个股新闻" />
        )}
      </Modal>
    </>
  );
};

export default StockKLineModal;
