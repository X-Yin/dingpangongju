import { useState, useEffect, useCallback } from 'react';
import { Drawer, Empty, Button, Space, Spin, Modal, Tooltip, Segmented, message, Input } from 'antd';
import { ReloadOutlined, HistoryOutlined, CheckCircleFilled, CloseCircleFilled, StarFilled, InfoCircleOutlined, RobotOutlined, CopyOutlined, SnippetsOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import './index.scss';

const { TextArea } = Input;

const BuyPointDiagnosisDrawer = ({ open, onClose, onStockClick }) => {
  const navigate = useNavigate();

  const [checksData, setChecksData] = useState(null);
  const [stocksData, setStocksData] = useState(null);
  const [checksLoading, setChecksLoading] = useState(false);
  const [stocksLoading, setStocksLoading] = useState(false);
  const [now, setNow] = useState(new Date());
  const [jigouReports, setJigouReports] = useState([]);
  const [showGoodNewsModal, setShowGoodNewsModal] = useState(false);
  const [matchedReports, setMatchedReports] = useState([]);
  const [currentGoodNewsStock, setCurrentGoodNewsStock] = useState('');
  const [showOnlyGoodNews, setShowOnlyGoodNews] = useState(false);
  const [techEmotion, setTechEmotion] = useState(null);
  const [activeTab, setActiveTab] = useState('change');

  const [aiLoading, setAiLoading] = useState(false);
  const [aiResults, setAiResults] = useState(null);
  const [aiContext, setAiContext] = useState(null);
  const [aiContextLoading, setAiContextLoading] = useState(false);
  const [pasteModalVisible, setPasteModalVisible] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const fetchChecks = useCallback(async (refresh = false) => {
    setChecksLoading(true);
    try {
      const response = await axios.post(`http://${local_ip}:3000/buy_point_checks`, { refresh: refresh ? 1 : 0 });
      setChecksData(response.data);
    } catch (error) {
      console.error('Fetch buy point checks failed:', error);
    } finally {
      setChecksLoading(false);
    }
  }, []);

  const fetchStocks = useCallback(async (sort) => {
    setStocksLoading(true);
    try {
      const response = await axios.post(`http://${local_ip}:3000/buy_point_stocks`, { sortBy: sort });
      setStocksData(response.data);
    } catch (error) {
      console.error('Fetch buy point stocks failed:', error);
    } finally {
      setStocksLoading(false);
    }
  }, []);

  const fetchJigouReports = useCallback(async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_jigou_reports`);
      if (response.data && response.data.reports) {
        setJigouReports(response.data.reports);
      }
    } catch (error) {
      console.error('Fetch jigou reports failed:', error);
    }
  }, []);

  const fetchTechEmotion = useCallback(async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/latest_tech_emotion`);
      setTechEmotion(response.data?.value ?? null);
    } catch (error) {
      console.error('Fetch tech emotion failed:', error);
      setTechEmotion(null);
    }
  }, []);

  const fetchAiContext = useCallback(async () => {
    setAiContextLoading(true);
    try {
      const response = await axios.post(`http://${local_ip}:3000/ai_stock_screen/context`);
      if (response.data?.success) {
        setAiContext(response.data.data);
        return response.data.data;
      }
    } catch (error) {
      console.error('Fetch AI context failed:', error);
      message.error('获取AI上下文失败');
    } finally {
      setAiContextLoading(false);
    }
    return null;
  }, []);

  const fetchAiScreen = useCallback(async () => {
    setAiLoading(true);
    try {
      const response = await axios.post(`http://${local_ip}:3000/ai_stock_screen/run`);
      if (response.data?.success) {
        setAiResults(response.data.data);
      } else {
        message.error(response.data?.message || 'AI选股失败');
      }
    } catch (error) {
      console.error('Fetch AI screen failed:', error);
      message.error('AI选股失败');
    } finally {
      setAiLoading(false);
    }
  }, []);

  const handleCopyContext = useCallback(async () => {
    let promptText = aiContext?.prompt;
    if (!promptText) {
      const data = await fetchAiContext();
      promptText = data?.prompt;
    }
    try {
      if (promptText) {
        await navigator.clipboard.writeText(promptText);
        message.success('上下文已复制，可粘贴到豆包/千问等AI平台');
      } else {
        message.warning('上下文为空，请稍后重试');
      }
    } catch (error) {
      console.error('Copy failed:', error);
      const textarea = document.createElement('textarea');
      textarea.value = promptText || '';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      message.success('上下文已复制');
    }
  }, [aiContext, fetchAiContext]);

  const handlePasteResults = useCallback(() => {
    setPasteText('');
    setPasteModalVisible(true);
  }, []);

  const handlePasteConfirm = useCallback(() => {
    if (!pasteText.trim()) {
      message.warning('请输入AI返回的JSON结果');
      return;
    }
    try {
      let parsed;
      try {
        parsed = JSON.parse(pasteText);
      } catch (e) {
        const jsonMatch = pasteText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          message.error('JSON格式解析失败，请检查格式');
          return;
        }
      }
      if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) {
        message.error('JSON格式错误：缺少 recommendations 数组');
        return;
      }
      setAiResults({
        recommendations: parsed.recommendations,
        totalCount: parsed.recommendations.length,
        timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        fromPaste: true,
      });
      setPasteModalVisible(false);
      setPasteText('');
      message.success(`成功导入 ${parsed.recommendations.length} 条推荐`);
    } catch (error) {
      console.error('Parse paste failed:', error);
      message.error('JSON解析失败');
    }
  }, [pasteText]);

  const hasGoodNews = useCallback((stockName) => {
    if (!stockName || !jigouReports.length) return false;
    return jigouReports.some(report => {
      const titleMatch = report.title && report.title.includes(stockName);
      const textMatch = report.text && report.text.includes(stockName);
      return titleMatch || textMatch;
    });
  }, [jigouReports]);

  const highlightStockName = (text, stockName) => {
    if (!text || !stockName) return text;
    const cleanedText = text.replace(/<e[^>]*>/g, '');
    const regex = new RegExp(`(${stockName})`, 'g');
    return cleanedText.replace(regex, '<span class="highlight-stock">$1</span>');
  };

  const handleViewGoodNews = (e, stockName) => {
    e.stopPropagation();
    if (!stockName) return;
    const matched = jigouReports.filter(report => {
      const titleMatch = report.title && report.title.includes(stockName);
      const textMatch = report.text && report.text.includes(stockName);
      return titleMatch || textMatch;
    });
    setCurrentGoodNewsStock(stockName);
    setMatchedReports(matched);
    setShowGoodNewsModal(true);
  };

  const refreshAll = useCallback(() => {
    fetchChecks(true);
    if (activeTab === 'change' || activeTab === 'resilience' || activeTab === 'reports') {
      fetchStocks(activeTab);
    } else if (activeTab === 'ai') {
      fetchAiScreen();
    }
    fetchTechEmotion();
  }, [fetchChecks, fetchStocks, fetchAiScreen, fetchTechEmotion, activeTab]);

  useEffect(() => {
    if (open) {
      setNow(new Date());
      setChecksData(null);
      setStocksData(null);
      setShowOnlyGoodNews(false);
      setTechEmotion(null);
      setActiveTab('change');
      setAiResults(null);
      setAiContext(null);
      fetchChecks(false);
      fetchStocks('change');
      fetchTechEmotion();
      fetchJigouReports();
    }
  }, [open, fetchChecks, fetchStocks, fetchTechEmotion, fetchJigouReports]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const checksResult = checksData?.data;
  const stocksResult = stocksData?.data;
  let matchedStocks = stocksResult?.matchedStocks || [];
  const backtestRecommendation = stocksResult?.backtestRecommendation || null;
  const isChangeMode = activeTab === 'change';
  const isReportMode = activeTab === 'reports';

  if (showOnlyGoodNews) {
    matchedStocks = matchedStocks.filter(stock => hasGoodNews(stock.stockName));
  }

  const passedCount = checksResult?.passedCount || 0;
  const totalCheckCount = checksResult?.totalCheckCount || 5;
  const allPassed = checksResult?.allPassed === true;
  const checksList = checksResult?.checks || [];

  const handleStockItemClick = (item) => {
    if (onStockClick) {
      onStockClick({ code: item.code, name: item.stockName });
    }
  };

  const handleAiStockClick = (rec) => {
    if (onStockClick) {
      const code = rec.code || '';
      onStockClick({ code, name: rec.stockName });
    }
  };

  const renderStocksTab = () => (
    <>
      {checksResult && !allPassed && matchedStocks.length > 0 && (
        <div className="fbd-warning-tip" style={{ marginBottom: 10 }}>
          ⚠️ 前置条件未全部满足，个股列表仅供参考，不建议盲目出手
        </div>
      )}
      {/* {isChangeMode && backtestRecommendation && (
        <div
          className="fbd-warning-tip fbd-recommend-tip"
          style={{ marginBottom: 10 }}
          dangerouslySetInnerHTML={{ __html: `💡 ${backtestRecommendation}` }}
        />
      )} */}
      {stocksLoading && !stocksResult ? (
        <div className="fbd-panel-loading">
          <Spin size="small" tip="正在筛选个股..." />
        </div>
      ) : stocksResult ? (
        matchedStocks.length > 0 ? (
          <>
            <div className="fbd-stock-list">
              <div className={`fbd-list-header ${isChangeMode ? 'change-mode' : ''}`}>
                <div className="col-rank">#</div>
                <div className="col-name">股票名称</div>
                {isReportMode && <div className="col-resilience">研报覆盖</div>}
                {!isChangeMode && !isReportMode && <div className="col-resilience">抗分歧</div>}
                <div className="col-change">{isChangeMode || isReportMode ? '3日涨幅' : '涨跌幅'}</div>
              </div>
              {matchedStocks.map((item, idx) => {
                const rankColors = ['#f5222d', '#fa8c16', '#faad14'];
                const rankStyle = idx < 3 ? { background: rankColors[idx], color: '#fff' } : {};
                const stockHasGoodNews = hasGoodNews(item.stockName);
                const displayChange = isChangeMode || isReportMode ? item.change3d : item.change;
                return (
                  <div
                    key={item.code}
                    className={`fbd-stock-item ${item.isImportant ? 'important' : ''} ${idx < 3 ? 'top-rank' : ''} ${isChangeMode ? 'change-mode' : ''}`}
                    onClick={() => handleStockItemClick(item)}
                  >
                    <div className="col-rank">
                      <span className="rank-num" style={rankStyle}>{idx + 1}</span>
                    </div>
                    <div className="col-name">
                      <div className="name-row">
                        <span className="stock-name">{item.stockName}</span>
                        {item.isImportant && <StarFilled className="star-icon" />}
                        {stockHasGoodNews && (
                          <span
                            className="fbd-good-news-badge"
                            onClick={(e) => handleViewGoodNews(e, item.stockName)}
                          >
                            (研报)
                          </span>
                        )}
                      </div>
                      {item.blockName && <span className="block-tag">{item.blockName}</span>}
                    </div>
                    {isReportMode && (
                      <div className="col-resilience">
                        <span className={`resilience-value ${item.reportCount > 0 ? 'high' : ''}`}>
                          {item.reportCount != null ? item.reportCount : '-'}
                        </span>
                      </div>
                    )}
                    {!isChangeMode && !isReportMode && (
                      <div className="col-resilience">
                        <span className={`resilience-value ${item.resilienceScore >= 10 ? 'high' : item.resilienceScore >= 8 ? 'medium' : ''}`}>
                          {item.resilienceScore != null ? item.resilienceScore.toFixed(2) : '-'}
                        </span>
                      </div>
                    )}
                    <div className="col-change">
                      <span className={`change-value ${displayChange > 0 ? 'up' : displayChange < 0 ? 'down' : ''}`}>
                        {displayChange != null ? `${(displayChange > 0 ? '+' : '')}${displayChange.toFixed(2)}%` : '-'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="fbd-panel-empty">
            <Empty
              description={<span style={{ fontSize: 12, color: '#8c8c8c' }}>{showOnlyGoodNews ? '暂无当日有研报且符合条件的个股' : isChangeMode ? '暂无符合条件的个股' : isReportMode ? '暂无研报覆盖数据' : '暂无抗分歧 > 8 且 MA10 斜率非负的个股'}</span>}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        )
      ) : (
        <div className="fbd-panel-empty">
          <Empty
            description={<span style={{ fontSize: 12, color: '#8c8c8c' }}>点击刷新加载个股</span>}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      )}
    </>
  );

  const renderAiTab = () => {
    const recommendations = aiResults?.recommendations || [];

    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <Button
            size="small"
            icon={<RobotOutlined />}
            onClick={fetchAiScreen}
            loading={aiLoading}
            type="primary"
          >
            AI选股
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={handleCopyContext}
            loading={aiContextLoading}
          >
            {aiContext ? '复制上下文' : '获取上下文'}
          </Button>
          <Button
            size="small"
            icon={<SnippetsOutlined />}
            onClick={handlePasteResults}
          >
            粘贴结果
          </Button>
          {aiResults?.totalCount != null && (
            <span className="panel-badge neutral">{aiResults.totalCount} 只</span>
          )}
          {aiResults?.timestamp && (
            <span style={{ fontSize: 11, color: '#8c8c8c', marginLeft: 'auto' }}>
              {aiResults.fromPaste ? '手动导入' : (aiResults.model ? (aiResults.model + ' 分析') : '')} · {aiResults.timestamp}
            </span>
          )}
        </div>

        {aiResults?.marketOverview && (
          <div className="fbd-ai-market-overview">
            <span style={{ color: '#8c8c8c', marginRight: 12 }}>
              情绪: <b style={{ color: aiResults.marketOverview.sentiment === '强势' || aiResults.marketOverview.sentiment === '偏强' ? '#cf1322' : aiResults.marketOverview.sentiment === '弱势' || aiResults.marketOverview.sentiment === '偏弱' ? '#389e0d' : '#595959' }}>{aiResults.marketOverview.sentiment}</b>
            </span>
            <span style={{ color: '#8c8c8c', marginRight: 12 }}>
              涨停/跌停: <b style={{ color: '#cf1322' }}>{aiResults.marketOverview.limitUp}</b> / <b style={{ color: '#389e0d' }}>{aiResults.marketOverview.limitDown}</b>
            </span>
            <span style={{ color: '#8c8c8c', marginRight: 12 }}>
              站上5日线: <b>{aiResults.marketOverview.aboveMA5}</b>
            </span>
            <span style={{ color: '#8c8c8c' }}>
              站上10日线: <b>{aiResults.marketOverview.aboveMA10}</b>
            </span>
          </div>
        )}

        {aiLoading ? (
          <div className="fbd-panel-loading">
            <Spin size="small" tip="AI正在分析中..." />
          </div>
        ) : aiResults ? (
          recommendations.length > 0 ? (
            <div className="fbd-ai-recommendation-list">
              {recommendations.map((rec, idx) => {
                const rankClass = idx === 0 ? 'rank-gold' : idx === 1 ? 'rank-silver' : idx === 2 ? 'rank-bronze' : 'rank-normal';
                const changeVal = typeof rec.change === 'number' ? rec.change : parseFloat(rec.change);
                const changeColor = changeVal > 0 ? '#cf1322' : changeVal < 0 ? '#389e0d' : '#595959';
                const stockHasGoodNews = hasGoodNews(rec.stockName);
                return (
                  <div
                    key={`${rec.code || rec.stockName}_${idx}`}
                    className="fbd-ai-recommendation-item"
                    onClick={() => handleAiStockClick(rec)}
                  >
                    <div className="fbd-ai-rec-header">
                      <span className={`fbd-ai-rank ${rankClass}`}>{idx + 1}</span>
                      <span className="fbd-ai-rec-name">{rec.stockName}</span>
                      {rec.code && <span className="fbd-ai-rec-code">{rec.code}</span>}
                      {stockHasGoodNews && (
                        <span className="fbd-good-news-badge" onClick={(e) => handleViewGoodNews(e, rec.stockName)}>(研报)</span>
                      )}
                      <span className="fbd-ai-rec-change" style={{ color: changeColor }}>
                        {changeVal != null && !isNaN(changeVal) ? `${changeVal > 0 ? '+' : ''}${changeVal.toFixed(2)}%` : '--'}
                      </span>
                    </div>
                    <div className="fbd-ai-rec-reason">{rec.reason}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="fbd-panel-empty">
              <Empty
                description={<span style={{ fontSize: 12, color: '#8c8c8c' }}>AI未推荐个股，请调整筛选条件或稍后重试</span>}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            </div>
          )
        ) : (
          <div className="fbd-panel-empty">
            <Empty
              description={<span style={{ fontSize: 12, color: '#8c8c8c' }}>点击"AI选股"开始分析，或点击"复制上下文"到豆包/千问获取结果后粘贴</span>}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <Drawer
        title={
          <span>
            买点即时诊断
            <span className="fbd-live-time">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span>
          </span>
        }
        placement="right"
        open={open}
        onClose={onClose}
        width={900}
        className="buy-diagnosis-drawer"
        destroyOnClose={false}
        extra={
          <Space size="middle">
            <Button
              icon={<ReloadOutlined />}
              onClick={refreshAll}
              loading={checksLoading || stocksLoading || aiLoading}
              className="glass-btn refresh-btn"
            >
              刷新
            </Button>
            <Button
              icon={<HistoryOutlined />}
              onClick={() => {
                navigate('/stock_diagnosis');
                onClose?.();
              }}
              className="glass-btn history-btn"
            >
              回测历史
            </Button>
          </Space>
        }
      >
        <div className="drawer-split-container">
          {/* 左侧：诊断检查 */}
          <div className="drawer-left-panel">
            <div className="panel-header">
              <span className="panel-title">买点条件诊断</span>
              {checksResult && (
                <span className={`panel-badge ${allPassed ? 'pass' : 'fail'}`}>
                  {passedCount}/{totalCheckCount}
                </span>
              )}
            </div>

            {checksLoading && !checksResult ? (
              <div className="fbd-panel-loading">
                <Spin size="small" tip="正在诊断..." />
              </div>
            ) : checksResult ? (
              <>
                <div className="fbd-checks-list">
                  {checksList.map((check, idx) => (
                    <div
                      key={check.id}
                      className={`fbd-check-card ${check.passed ? 'passed' : 'failed'}`}
                    >
                      <div className="fbd-card-header">
                        <div className="fbd-title-row">
                          <span className={`fbd-num ${check.passed ? 'num-pass' : 'num-fail'}`}>{idx + 1}</span>
                          <span className="fbd-title">{check.title}</span>
                        </div>
                        {check.passed ? (
                          <CheckCircleFilled className="fbd-status-icon pass-icon" />
                        ) : (
                          <CloseCircleFilled className="fbd-status-icon fail-icon" />
                        )}
                      </div>
                      <div className="fbd-card-body">
                        <div className="fbd-value-row">
                          <span className="fbd-value-label">当前值</span>
                          <span className={`fbd-value ${check.passed ? 'value-pass' : 'value-fail'}`}>{check.value}</span>
                        </div>
                        {check.detail && (
                          <div className="fbd-detail-row">
                            {check.id === 'fund_inflow' && check.detail.pastValue != null && check.detail.currentValue != null && (
                              <span className="fbd-detail-item">
                                资金 <b>{check.detail.pastValue >= 0 ? '+' : ''}{check.detail.pastValue.toFixed(2)}亿</b>
                                <span className="fbd-arrow"> → </span>
                                <b>{check.detail.currentValue >= 0 ? '+' : ''}{check.detail.currentValue.toFixed(2)}亿</b>
                                <span className="fbd-detail-time">（{check.detail.pastTime} → {check.detail.currentTime}）</span>
                              </span>
                            )}
                            {check.id === 'volume_expansion' && check.detail.prev5minVol != null && check.detail.last5minVol != null && (
                              <span className="fbd-detail-item">
                                量能变化 <b>{check.detail.prev5minVol.toFixed(2)}亿</b>
                                <span className="fbd-arrow"> → </span>
                                <b>{check.detail.last5minVol.toFixed(2)}亿</b>
                                <span className="fbd-detail-time">（{check.detail.pastTime} → {check.detail.currentTime}）</span>
                              </span>
                            )}
                          </div>
                        )}
                        <div className="fbd-reason">{check.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 隔夜重大利好策略卡片（前端固定提示，无需后端） */}
                <div className="fbd-check-card fbd-strategy-card" style={{ marginTop: '8px' }}>
                  <div className="fbd-card-header">
                    <div className="fbd-title-row">
                      <span className="fbd-num strategy-num">💡</span>
                      <span className="fbd-title strategy-title">隔夜重大利好 · 低吸策略</span>
                    </div>
                    <span className="fbd-strategy-tag">策略提示</span>
                  </div>
                  <div className="fbd-card-body">
                    {/* <div className="fbd-strategy-desc">
                      隔夜出现重大利好事件（如英伟达财报公布、美联储议息会议等），
                      若开盘科技情绪未冲到 <b>50 以上</b>，且大部分个股保持正常 <b>1-2% 高开</b>（非 7-8% 高开），
                      则等待开盘后砸到 <b>零轴附近</b> 的位置，可考虑低吸入场。
                    </div> */}
                    <div className="fbd-strategy-conditions">
                      <div className="fbd-strategy-item">
                        <span className="fbd-strategy-icon">①</span>
                        <span>隔夜有重大利好事件（英伟达财报、美联储议息会议等）</span>
                      </div>
                      <div className="fbd-strategy-item">
                        <span className="fbd-strategy-icon">②</span>
                        <span>开盘科技情绪 <b className="warn">未突破 50</b></span>
                      </div>
                      <div className="fbd-strategy-item">
                        <span className="fbd-strategy-icon">③</span>
                        <span>个股正常高开，幅度大概在 <b className="warn">1-2%</b>，而非 7-8%</span>
                      </div>
                      <div className="fbd-strategy-item">
                        <span className="fbd-strategy-icon">④</span>
                        <span>等待开盘后指数砸到 <b className="warn">零轴附近</b> 再考虑低吸，一般在 9:50 之前会砸到零轴</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={`fbd-conclusion ${allPassed ? 'conclusion-pass' : 'conclusion-fail'}`}>
                  <div className={`fbd-conclusion-title ${allPassed ? 'title-pass' : 'title-fail'}`}>
                    {allPassed ? '🚀 诊断结果：可以出手' : '⚠️ 诊断结果：暂不可出手'}
                  </div>
                  <div className="fbd-conclusion-text">{checksResult.conclusion}</div>
                  {checksResult.timestamp && (
                    <div className="fbd-conclusion-time">诊断结果时间：{checksResult.timestamp}</div>
                  )}
                </div>

                {allPassed && (
                  <div className={`fbd-position-tip ${techEmotion !== null && techEmotion < 0 ? 'position-tip-negative' : 'position-tip-positive'}`}>
                    <div className="fbd-position-tip-title">
                      科技情绪指数：{techEmotion !== null ? `${techEmotion > 0 ? '+' : ''}${techEmotion.toFixed(2)}` : '--'}
                    </div>
                    <div className="fbd-position-tip-text">
                      {techEmotion !== null && techEmotion < 0
                        ? '当前科技情绪为负数，题材风险仍在。当天尾盘不要加仓，单个股票最多 1/4 仓位即可，等待次日量金齐升信号再加。'
                        : '当前科技情绪为正数，题材保持强势。当天尾盘可以继续加仓 1/4 仓位，但注意控制总体仓位、避免追高冲高回落。'}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="fbd-panel-empty">
                <Empty
                  description={<span style={{ fontSize: 12, color: '#8c8c8c' }}>点击刷新开始诊断</span>}
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              </div>
            )}
          </div>

          {/* 右侧：优选个股列表 */}
          <div className="drawer-right-panel">
            <div className="panel-header">
              <span className="panel-title">优选个股</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Segmented
                  size="small"
                  value={activeTab}
                  onChange={(val) => {
                    setActiveTab(val);
                    if (val === 'change' || val === 'resilience' || val === 'reports') {
                      fetchStocks(val);
                    } else if (val === 'ai') {
                      setAiResults(null);
                    }
                  }}
                  options={[
                    { value: 'change', label: '涨跌幅' },
                    { value: 'reports', label: '研报覆盖' },
                    { value: 'resilience', label: '抗分歧' },
                    { value: 'ai', label: <span><RobotOutlined /> AI筛选</span> },
                  ]}
                />
                {/* {(activeTab === 'change' || activeTab === 'resilience' || activeTab === 'reports') && (
                  <>
                    <Tooltip title={showOnlyGoodNews ? "取消研报筛选" : "只看当日有研报"}>
                      <Button
                        size="small"
                        type={showOnlyGoodNews ? "primary" : "default"}
                        icon={<InfoCircleOutlined />}
                        onClick={() => setShowOnlyGoodNews(!showOnlyGoodNews)}
                        className={`fbd-filter-btn good-news-filter-btn ${showOnlyGoodNews ? 'active' : ''}`}
                      />
                    </Tooltip>
                    {stocksResult && (
                      <span className="panel-badge neutral">{matchedStocks.length} 只</span>
                    )}
                  </>
                )} */}
                {activeTab === 'ai' && aiResults && (
                  <span className="panel-badge neutral">{aiResults.totalCount} 只</span>
                )}
              </div>
            </div>

            {(activeTab === 'change' || activeTab === 'resilience' || activeTab === 'reports') ? renderStocksTab() : renderAiTab()}
          </div>
        </div>
      </Drawer>

      {/* 粘贴结果弹窗 */}
      <Modal
        title={
          <span>
            <SnippetsOutlined style={{ marginRight: 8 }} />
            粘贴AI分析结果
          </span>
        }
        open={pasteModalVisible}
        onCancel={() => setPasteModalVisible(false)}
        onOk={handlePasteConfirm}
        okText="解析并导入"
        cancelText="取消"
        width={600}
      >
        <div style={{ marginBottom: 12, fontSize: 12, color: '#8c8c8c' }}>
          将从豆包/千问等AI平台获取的JSON结果粘贴到下方，格式需包含 <code>recommendations</code> 数组
        </div>
        <TextArea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder='粘贴格式：{"recommendations":[{"stockName":"股票名","code":"sh688xxx","change":5.23,"reason":"推荐理由"}]}'
          rows={10}
        />
      </Modal>

      {/* 研报弹窗 */}
      <Modal
        title={<span><span>📰</span> {currentGoodNewsStock} 利好消息</span>}
        open={showGoodNewsModal}
        onCancel={() => setShowGoodNewsModal(false)}
        footer={null}
        width={800}
        className="good-news-modal"
      >
        {matchedReports.length > 0 ? (
          <div className="good-news-list">
            {matchedReports.map((report, index) => (
              <div key={index} className="good-news-item">
                <div
                  className="good-news-title"
                  dangerouslySetInnerHTML={{ __html: highlightStockName(report.title, currentGoodNewsStock) }}
                />
                <div className="good-news-time">{report.createTime ? dayjs(report.createTime).format('YYYY-MM-DD HH:mm:ss') : ''}</div>
                <div
                  className="good-news-content"
                  dangerouslySetInnerHTML={{ __html: highlightStockName(report.text, currentGoodNewsStock) }}
                />
              </div>
            ))}
          </div>
        ) : (
          <Empty description="暂无匹配的利好消息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Modal>
    </>
  );
};

export default BuyPointDiagnosisDrawer;