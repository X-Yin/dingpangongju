import { useEffect, useState, useMemo, useRef } from "react";
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Tag, Typography, Empty, Space, Divider, Button, Modal, List, Badge, Spin, Alert, Input, Tooltip, Tabs } from 'antd';
const { TabPane } = Tabs;
import { StockOutlined, LineChartOutlined, ClockCircleOutlined, HistoryOutlined, AlertOutlined, RiseOutlined, FallOutlined, AreaChartOutlined, WarningOutlined, SearchOutlined, CaretUpOutlined, CaretDownOutlined, ThunderboltOutlined, CloseOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import { useEmotionSuggestion } from '../../hooks/emotion';
import './index.scss';

const { Title, Text } = Typography;

const colorMap = {
    lowGreen: '#00B42A',
    mediumGreen: '#00B42A',
    highGreen: '#00881C',
    lowRed: '#F53F3F',
    mediumRed: '#F53F3F',
    highRed: '#C92323',
};

const bgMap = {
    lowGreen: '#E8FFEA',
    mediumGreen: '#AFF0B5',
    highGreen: '#73E581',
    lowRed: '#FFECE8',
    mediumRed: '#FFD8D0',
    highRed: '#FFB1A4',
};

const DingPan = () => {
    const navigate = useNavigate();
    const [data, setData] = useState({ unNormalDaPanData: [], unNormalStockList: [], diagnoseData: [], topAndBottomBlockData: null, allStockData: {}, amountInfo: null, jingJiaQiangChouData: [], kaiPanZhuDongData: [] });
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [history, setHistory] = useState([]); // 记录所有发生过的急速异动
    const [searchQuery, setSearchQuery] = useState(''); // 自选股搜索关键词
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [klineModalVisible, setKlineModalVisible] = useState(false);
    const [selectedStock, setSelectedStock] = useState(null);
    const notifiedStocks = useRef(new Set()); // 用于记录已通知的异动，防止重复提醒
    const prevAllStockDataRef = useRef({}); // 记录上一次的自选股数据，用于对比涨幅趋势

    // 资金与成交量趋势监控相关
    const [amountHistory, setAmountHistory] = useState([]);
    const [mainMoneyHistory, setMainMoneyHistory] = useState([]); // 记录主力资金历史，用于趋势预警
    const [defensiveBlockHistory, setDefensiveBlockHistory] = useState([]); // 记录防御板块历史，用于趋势预警
    const [alerts, setAlerts] = useState([]); // 存储当前显示的顶部告警信息列表
    const [techIndexData, setTechIndexData] = useState([]); // 科技情绪数据
    const [jisuYidongUpList, setJisuYidongUpList] = useState([]); // 急速异动上涨排名
    const [jisuYidongDownList, setJisuYidongDownList] = useState([]); // 急速异动下跌排名

    // 打开 K 线弹窗
    const showKLine = (stock) => {
        setSelectedStock(stock);
        setKlineModalVisible(true);
    };

    // 跳转到重点板块并定位
    const jumpToBlock = (blockName) => {
        navigate(`/block?blockName=${encodeURIComponent(blockName)}`);
    };

    // 请求通知权限
    useEffect(() => {
        if ("Notification" in window) {
            if (Notification.permission !== "granted" && Notification.permission !== "denied") {
                Notification.requestPermission();
            }
        }
    }, []);

    const sendDesktopNotification = (stockName, label, changeDiff, stockCode, desc) => {

        // 记录到历史记录中（去重逻辑：如果 3 分钟内名称、代码、标签、幅度都一致，则不重复添加）
        setHistory(prev => {
            const now = Date.now();
            const threeMinutesAgo = now - 3 * 60 * 1000;
            
            const isDuplicate = prev.some(item => 
                item.id > threeMinutesAgo && // 只检查 3 分钟内的记录
                item.name === stockName && 
                item.code === stockCode && 
                item.label === label && 
                item.changeDiff === changeDiff
            );
            
            if (isDuplicate) return prev;

            return [{
                id: now,
                name: stockName,
                code: stockCode,
                label,
                desc,
                changeDiff,
                time: dayjs().format('HH:mm:ss'),
                type: label.includes('拉升') ? 'up' : 'down'
            }, ...prev];
        });

        if (!("Notification" in window) || Notification.permission !== "granted") return;

        const time = dayjs().format('HH:mm');
        const notifyKey = `${stockName}-${label}-${time}`;
        if (notifiedStocks.current.has(notifyKey)) return;

        new Notification("📈 盯盘异动提醒", {
            body: `【${stockName}】发生急速波动！\n类型：${label}\n幅度：${changeDiff}\n时间：${dayjs().format('HH:mm:ss')}`,
            icon: '/favicon.svg'
        });

        notifiedStocks.current.add(notifyKey);


        // 10分钟后清除记录，允许再次提醒
        setTimeout(() => {
            notifiedStocks.current.delete(notifyKey);
        }, 10 * 60 * 1000);
    };

    const dapanList = useMemo(() => {
        const value = data.unNormalDaPanData || [];
        return value.map(item => {
            const isUp = item.change > 0;
            const statusKey = isUp ? 'highRed' : 'highGreen';
            return {
                name: item.name,
                color: colorMap[statusKey],
                bgColor: bgMap[statusKey],
                statusKey,
                change: `${isUp ? '+' : ''}${item.change}${Math.abs(item.change) > 100 ? '' : '%'}`,
                desc: `${item.name}: ${isUp ? '涨' : '跌'} ${item.change}${item.change > 100 ? '' : '%'} `,
            };
        });
    }, [data.unNormalDaPanData]);

    const filteredAllStockData = useMemo(() => {
        const stocks = data.allStockData || [];
        if (!searchQuery) return stocks;
        const query = searchQuery.toLowerCase();
        return stocks.filter(stock => 
            (stock.stockName && stock.stockName.toLowerCase().includes(query)) ||
            (stock.code && stock.code.toLowerCase().includes(query))
        );
    }, [data.allStockData, searchQuery]);

    const stockData = useMemo(() => {
        const value = data.unNormalStockList || [];
        let waveList = [];
        const changeList = [];
        let upCount = 0;
        let downCount = 0;

        value.forEach(item => {
            const change = item.change;

            // 1. 处理普通涨跌 (按 change 排序)
            let statusKey = '';
            if (change < 0) {
                if (change > -2) statusKey = 'lowGreen';
                else if (change > -5) statusKey = 'mediumGreen';
                else statusKey = 'highGreen';
                downCount++;
            } else if (change > 0) {
                if (change < 2) statusKey = 'lowRed';
                else if (change < 5) statusKey = 'mediumRed';
                else statusKey = 'highRed';
                upCount++;
            }

            // item.type = 1 代表急速异动，item.type = 2 代码涨幅异动，在个股涨幅异动那里只显示涨幅异动的
            if (statusKey && item.type === 2) {
                changeList.push({
                    name: item.name,
                    code: item.code,
                    color: colorMap[statusKey],
                    bgColor: bgMap[statusKey],
                    statusKey,
                    changeValue: change,
                    change: `${change > 0 ? '+' : ''}${change}%`,
                    label: change > 0 ? '幅度大涨' : '幅度大跌',
                    desc: item.desc,
                    type: 'change'
                });
            }

            // 2. 处理急速波动 (放在最前面)，急速波动的不用判断 item.type，全量判断所有的 unNormalStockList
            if (Math.abs(item.change_diff) > 0.3) {
                const waveStatusKey = item.change_diff > 0 ? 'highRed' : 'highGreen';
                const label = item.change_diff > 0 ? '急速拉升 ⚡' : '急速下跌 📉';
                const changeDiffStr = `${item.change_diff > 0 ? '+' : ''}${item.change_diff.toFixed(2)}%`;

                waveList.push({
                    name: item.name,
                    code: item.code,
                    color: colorMap[waveStatusKey],
                    bgColor: bgMap[waveStatusKey],
                    statusKey: waveStatusKey,
                    change: `${item.change}%`,
                    change_diff: changeDiffStr,
                    label,
                    desc: item.desc,
                    time: dayjs().format('HH:mm:ss'),
                    type: 'wave'
                });

                // waveList 要去重，把重复的 code 给删除掉
                waveList = waveList.filter((item, index, arr) => 
                    index === arr.findIndex(t => t.code === item.code)
                );

                // 触发桌面通知和记录
                sendDesktopNotification(item.name, label, changeDiffStr, item.code, item.desc);
            }
        });

        // 按 change 从大到小排序
        changeList.sort((a, b) => b.changeValue - a.changeValue);

        // Calculate total change value
        const totalChangeValue = changeList.reduce((sum, item) => sum + item.changeValue, 0);

        // 按急速异动的幅度降序排序，幅度越大的在越前面
        waveList.sort((a, b) => {
            const aVal = parseFloat(a.change_diff);
            const bVal = parseFloat(b.change_diff);
            return Math.abs(bVal) - Math.abs(aVal);
        });

        return { waveList, changeList, upCount, downCount, totalChangeValue };
    }, [data.unNormalStockList]);

    const fetchData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/notice_data`);
            const newData = response.data;
            
            // 为自选股数据注入上一次的涨幅信息
            if (newData.allStockData && Array.isArray(newData.allStockData)) {
                newData.allStockData = newData.allStockData.map(stock => {
                    const prevData = prevAllStockDataRef.current[stock.code];
                    return {
                        ...stock,
                        prevChange: prevData !== undefined ? prevData : stock.change
                    };
                });
                
                // 更新 ref 以供下次对比
                const nextPrevData = {};
                newData.allStockData.forEach(stock => {
                    nextPrevData[stock.code] = stock.change;
                });
                prevAllStockDataRef.current = nextPrevData;
            }

            setData(newData);
            setLastUpdated(dayjs().format('HH:mm:ss'));

            // 处理防御板块趋势逻辑
            if (newData.topAndBottomBlockData && Array.isArray(newData.topAndBottomBlockData.defensiveBlock)) {
                const currentDefensiveBlocks = newData.topAndBottomBlockData.defensiveBlock;
                
                setDefensiveBlockHistory(prev => {
                    const newHistory = [...prev, currentDefensiveBlocks].slice(-3);
                    
                    // 当达到 3 次记录时进行趋势判断
                    if (newHistory.length === 3) {
                        // 筛选出涨幅持续增加的防御板块
                        const strengtheningBlocks = currentDefensiveBlocks.filter(block => {
                            const b0 = newHistory[0].find(b => b.blockName === block.blockName);
                            const b1 = newHistory[1].find(b => b.blockName === block.blockName);
                            const b2 = newHistory[2].find(b => b.blockName === block.blockName);
                            if (!b0 || !b1 || !b2) return false;
                            return parseFloat(b2.avgChange) > parseFloat(b1.avgChange) && parseFloat(b1.avgChange) > parseFloat(b0.avgChange);
                        });

                        if (strengtheningBlocks.length > 0) {
                              const newDefensiveAlert = {
                                  id: 'defensive-' + Date.now(),
                                  title: '🛡️ 防御板块走强预警',
                                  time: dayjs().format('HH:mm:ss'),
                                  type: 'warning',
                                  description: `防御板块（${strengtheningBlocks.map(b => b.blockName).join('、')}）涨幅已连续三次增加，市场防御情绪升温，请注意风险！`,
                                  isDefensive: true
                              };
                              setAlerts(prev => {
                                  // 移除旧的防御预警，加入新的
                                  const filtered = prev.filter(a => !a.isDefensive);
                                  return [newDefensiveAlert, ...filtered];
                              });
                          } else {
                              // 如果没有走强的板块了，移除旧的防御预警
                              setAlerts(prev => prev.filter(a => !a.isDefensive));
                          }
                    }
                    return newHistory;
                });
            }
        } catch (error) {
            console.error('Fetch data failed:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchEmotionData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/emotion_data`);
            if (response.data && response.data.techIndexData) {
                setTechIndexData(response.data.techIndexData);
            }
        } catch (error) {
            console.error('Fetch emotion data failed:', error);
        }
    };

    const fetchAmountData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/dapan_data`);
            const dapanData = response.data;
            const amountInfo = { mainMoney: dapanData.mainMoney, amountChangeDiff: dapanData.amountChangeDiff };
            const indexQuote = dapanData.index_quote || [];
            const shangzheng = indexQuote.find(item => item.secu_code === 'sh000001');
            const shenzheng = indexQuote.find(item => item.secu_code === 'sz399001');
            const chuangyeban = indexQuote.find(item => item.secu_code === 'sz399006');
            const kechuangban = indexQuote.find(item => item.secu_code === 'sh000688');
            
            if (amountInfo) {
                const mainMoney = parseFloat(amountInfo.mainMoney) || 0;
                const amountChangeDiff = parseFloat(amountInfo.amountChangeDiff) || 0;
                
                // 提取四大指数的价格
                const szPrice = parseFloat(shangzheng?.last_px || 0);
                const shPrice = parseFloat(shenzheng?.last_px || 0);
                const cyPrice = parseFloat(chuangyeban?.last_px || 0);
                const kcPrice = parseFloat(kechuangban?.last_px || 0);

                const normalizedInfo = { 
                    ...amountInfo, 
                    mainMoney, 
                    amountChangeDiff,
                    szPrice,
                    shPrice,
                    cyPrice,
                    kcPrice
                };
                // 更新主力资金 10 次历史记录并检测趋势
                setMainMoneyHistory(prev => {
                    const newHistory = [...prev, mainMoney].slice(-10);
                    
                    // 当达到 10 次记录时进行趋势判断
                    if (newHistory.length === 10) {
                        // 判断是否持续净流出增加 (即每一项都比前一项小，且都是负数)
                        const isContinuousOutflowIncreasing = newHistory.every((val, idx) => {
                            if (idx === 0) return val < 0;
                            return val < 0 && val < newHistory[idx - 1];
                        });

                        if (isContinuousOutflowIncreasing) {
                            // 弹出高级警告
                            setTimeout(() => {
                                window.alert('🚨 高级风险预警：主力资金呈现净流出加速态势！\n\n当前净流出：' + mainMoney + ' 亿\n建议：市场承压严重，请操作者适度减仓，并且今天不要再做任何操作，严格控制风险！');
                            }, 100);
                        }
                    }
                    return newHistory;
                });

                let triggerAlert = null;

                // 1. 趋势判断
                setAmountHistory(prev => {
                    const newHistory = [...prev, normalizedInfo].slice(-3); // 只保留最近3次
                    
                    if (newHistory.length === 3) {
                        const [h1, h2, h3] = newHistory;
                        
                        // 资金趋势
                        const isMainMoneyIncreasing = h3.mainMoney > h2.mainMoney && h2.mainMoney > h1.mainMoney;
                        const isMainMoneyDecreasing = h3.mainMoney < h2.mainMoney && h2.mainMoney < h1.mainMoney;
                        
                        // 成交量趋势
                        const isAmountIncreasing = h3.amountChangeDiff > h2.amountChangeDiff && h2.amountChangeDiff > h1.amountChangeDiff;
                        const isAmountDecreasing = h3.amountChangeDiff < h2.amountChangeDiff && h2.amountChangeDiff < h1.amountChangeDiff;

                        // 指数价格趋势 (以上证指数为基准)
                        const isPriceIncreasing = h3.szPrice > h2.szPrice && h2.szPrice > h1.szPrice;
                        const isPriceDecreasing = h3.szPrice < h2.szPrice && h2.szPrice < h1.szPrice;

                        let trendTitle = '';
                        let alertType = 'warning';

                        // 量价齐升逻辑
                        if (isPriceIncreasing && isAmountIncreasing) {
                            trendTitle = '🚀 量价齐升！大盘指数与成交量双双走强，适合出手博弈！';
                            alertType = 'error'; // 积极信号用红色
                        } 
                        // 量价背离逻辑 (价升量缩)
                        else if (isPriceIncreasing && isAmountDecreasing) {
                            trendTitle = '⚠️ 量价趋势背离！指数上涨但成交量萎缩，需警惕诱多风险！';
                            alertType = 'success'; // 风险信号用绿色 (按用户之前逻辑，缩量用绿色)
                        }
                        // 量价背离逻辑 (价跌量增)
                        else if (isPriceDecreasing && isAmountIncreasing) {
                            trendTitle = '⚠️ 量价背离！指数下跌但成交量放大，恐慌盘正在涌出，注意风险！';
                            alertType = 'success';
                        }
                        // 基础趋势判断
                        else if (isMainMoneyIncreasing && isAmountIncreasing) {
                            trendTitle = '⚠️ 大盘量价齐升！主力资金与成交量均在持续走强';
                            alertType = 'error';
                        }
                        else if (isMainMoneyDecreasing && isAmountDecreasing) {
                            trendTitle = '🚨 警惕！量价齐跌，主力资金与成交量持续萎缩';
                            alertType = 'success';
                        }
                        else if (isMainMoneyIncreasing) {
                            trendTitle = '💰 主力资金持续加速流入';
                            alertType = 'error';
                        }
                        else if (isMainMoneyDecreasing) {
                            trendTitle = '💸 主力资金持续加速流出';
                            alertType = 'success';
                        }
                        else if (isAmountIncreasing) {
                            trendTitle = '📈 成交量持续放量增加';
                            alertType = 'error';
                        }
                        else if (isAmountDecreasing) {
                            trendTitle = '📉 成交量持续缩量减少';
                            alertType = 'success';
                        }

                        if (trendTitle) {
                            triggerAlert = {
                                id: 'trend-' + Date.now(),
                                title: trendTitle,
                                time: dayjs().format('HH:mm:ss'),
                                mainMoney: h3.mainMoney,
                                amountChangeDiff: h3.amountChangeDiff,
                                moneyTrend: h3.mainMoney >= 0 ? '净流入' : '净流出',
                                amountTrend: h3.amountChangeDiff >= 0 ? '持续增加' : '持续减少',
                                type: alertType,
                                isTrend: true
                            };
                        }
                    }
                    
                    if (triggerAlert) {
                        setAlerts(prev => {
                            // 移除旧的趋势预警，加入新的
                            const filtered = prev.filter(a => !a.isTrend);
                            return [triggerAlert, ...filtered];
                        });
                    }
                    
                    return newHistory;
                });
            }
        } catch (error) {
            console.error('Fetch amount data failed:', error);
        }
    };

    const fetchJisuYidongRank = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/jisuyidong_rank`);
            if (response.data) {
                setJisuYidongUpList(response.data.upList || []);
                setJisuYidongDownList(response.data.downList || []);
            }
        } catch (error) {
            console.error('Fetch jisuyidong_rank data failed:', error);
        }
    };

    useEffect(() => {
        fetchData();
        fetchAmountData();
        fetchEmotionData();
        fetchJisuYidongRank();
        
        const monitorTimer = setInterval(fetchData, 5000);
        const amountTimer = setInterval(fetchAmountData, 10000); // 10s 轮询一次
        const jisuYidongRankTimer = setInterval(fetchJisuYidongRank, 3000); // 3s 轮询一次
        
        return () => {
            clearInterval(monitorTimer);
            clearInterval(amountTimer);
            clearInterval(jisuYidongRankTimer);
        };
    }, []);

    const emotionSuggestion = useEmotionSuggestion(techIndexData);

    const marketRiskWarning = useMemo(() => {
        // 新增：如果所有股票涨跌幅加起来是负数，也认为是市场情绪不佳
        if (stockData.downCount > stockData.upCount || stockData.totalChangeValue < 0) {
            return `当日大盘整体做多情绪不佳，容易冲高回落，不要因为某些个股涨幅异动而强行出手。善战者，求之于势，不责于人！`;
        }
        return null;
    }, [stockData.upCount, stockData.downCount, stockData.totalChangeValue]);

    return (
        <div className="dingpan-container">
            {(alerts.length > 0 || emotionSuggestion || marketRiskWarning) && (
                <div className="top-global-alerts" style={{ marginBottom: 16 }}>
                    <Space direction="vertical" style={{ width: '100%' }} size={12}>
                        {marketRiskWarning && (
                            <Alert
                                message={<Text strong style={{ fontSize: '18px', color: '#cf1322' }}>🚨 极端风险预警：市场空头占优</Text>}
                                description={
                                    <div style={{ marginTop: 8 }}>
                                        <Text strong style={{ fontSize: '15px' }}>
                                            {marketRiskWarning}
                                        </Text>
                                    </div>
                                }
                                type="error"
                                showIcon
                                icon={<WarningOutlined style={{ fontSize: '28px' }} />}
                            />
                        )}
                        {emotionSuggestion && (
                            <Alert
                                message={<Text strong style={{ fontSize: '16px' }}>{emotionSuggestion.message}</Text>}
                                description={
                                    <div style={{ marginTop: 8 }}>
                                        <Text>{emotionSuggestion.description}</Text>
                                        <div style={{ marginTop: 8, color: '#666' }}>
                                            提示：当前建议为综合前几日的科技情绪指数复盘之后给出的提示
                                        </div>
                                    </div>
                                }
                                type={emotionSuggestion.type}
                                showIcon
                                icon={<ThunderboltOutlined style={{ fontSize: '24px' }} />}
                            />
                        )}
                        {alerts.map(alert => (
                            <Alert
                                key={alert.id}
                                message={<Text strong style={{ fontSize: '16px' }}>{alert.title}</Text>}
                                description={
                                    <div style={{ marginTop: 8 }}>
                                        {alert.isDefensive ? (
                                            <div style={{ color: '#666' }}>
                                                <Space direction="vertical" size={4}>
                                                    <span><ClockCircleOutlined /> 发生时间: <Text strong>{alert.time}</Text></span>
                                                    <Text>{alert.description}</Text>
                                                </Space>
                                            </div>
                                        ) : (
                                            <>
                                                <Space size="large">
                                                    <span><ClockCircleOutlined /> 发生时间: <Text strong>{alert.time}</Text></span>
                                                    <span>主力资金: <Text strong style={{ color: alert.mainMoney >= 0 ? '#cf1322' : '#389e0d' }}>{alert.moneyTrend} ({alert.mainMoney > 0 ? '+' : ''}{alert.mainMoney}亿)</Text></span>
                                                    <span>当前成交量相比上一日: <Text strong  style={{ color: alert.amountChangeDiff >= 0 ? '#cf1322' : '#389e0d' }}>{alert.amountChangeDiff}亿</Text></span>
                                                </Space>
                                                <div style={{ marginTop: 8, color: '#666' }}>
                                                    提示：当前大盘核心指标出现显著趋势性变化，请密切关注仓位风险。
                                                </div>
                                            </>
                                        )}
                                    </div>
                                }
                                type={alert.type}
                                showIcon
                                closable
                                onClose={() => setAlerts(prev => prev.filter(a => a.id !== alert.id))}
                                icon={<WarningOutlined style={{ fontSize: '24px' }} />}
                            />
                        ))}
                    </Space>
                </div>
            )}
            <div className="page-header">
                <div className="header-left">
                    <Title level={4}>实时监控面板</Title>
                    {lastUpdated && (
                        <Text type="secondary">
                            <ClockCircleOutlined /> 最后更新: {lastUpdated}
                        </Text>
                    )}
                </div>
                <div className="header-right">
                    <Badge count={history.length} overflowCount={99} size="small" offset={[0, 0]}>
                        <Button
                            type="primary"
                            icon={<HistoryOutlined />}
                            onClick={() => setIsModalOpen(true)}
                            className="history-btn"
                        >
                            异动历史记录
                        </Button>
                    </Badge>
                </div>
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
                    <Spin size="large" tip="正在初始化实时监控数据..." />
                </div>
            ) : (
                <>
                    {/* 急速异动横幅条 */}
                    {stockData.waveList.length > 0 && (
                        <div className="wave-banner">
                            <div className="wave-banner-title">
                                <StockOutlined className="wave-icon" />
                                <span>急速异动:</span>
                            </div>
                            <div className="wave-items-wrapper">
                                {stockData.waveList.map((item, index) => (
                                    <div
                                        key={index}
                                        className={`wave-banner-item ${item.statusKey}`}
                                        onClick={() => showKLine(item)}
                                    >
                                        <span className="wave-time">{item.time}</span>
                                        <span className="wave-name">{item.name}</span>
                                        <span className="wave-label">{item.label}</span>
                                        <Text strong style={{ color: item.color, marginRight: 4 }}>{item.change}</Text>
                                        <Tag color={item.color} className="wave-tag">{item.change_diff}</Tag>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <Row gutter={[24, 24]}>
                        {/* 左侧主要监控区 */}
                        <Col xs={24} lg={17}>
                        {/* 抢筹与拉升模块 */}
                        {( (data.jingJiaQiangChouData && data.jingJiaQiangChouData.length > 0) || (data.kaiPanZhuDongData && data.kaiPanZhuDongData.length > 0) ) && (
                            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                                {data.jingJiaQiangChouData && data.jingJiaQiangChouData.length > 0 && (
                                    <Col span={data.kaiPanZhuDongData && data.kaiPanZhuDongData.length > 0 ? 12 : 24}>
                                        <Card
                                            title={<><RiseOutlined style={{ color: '#ff4d4f' }} /> 竞价抢筹监控</>}
                                            className="monitor-card jingjia-card"
                                            variant="borderless"
                                        >
                                            <div className="jingjia-grid">
                                                {data.jingJiaQiangChouData.map((item, index) => {
                                                    const isUp = item.change >= 0;
                                                    const color = isUp ? '#f5222d' : '#52c41a';
                                                    return (
                                                        <div
                                                            key={index}
                                                            className="jingjia-item"
                                                            onClick={() => showKLine({ name: item.stockName, code: item.code, change: item.change })}
                                                            style={{ cursor: 'pointer' }}
                                                        >
                                                            <div className="stock-info">
                                                                <Text strong style={{ fontSize: '14px' }}>{item.stockName}</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.code?.replace('sh', '').replace('sz', '')}</Text>
                                                            </div>
                                                            <div className="stock-values">
                                                                <Text strong style={{ color: color, fontSize: '14px' }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.last_px?.toFixed(2)}</Text>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </Card>
                                    </Col>
                                )}
                                {data.kaiPanZhuDongData && data.kaiPanZhuDongData.length > 0 && (
                                    <Col span={data.jingJiaQiangChouData && data.jingJiaQiangChouData.length > 0 ? 12 : 24}>
                                        <Card
                                            title={<><ThunderboltOutlined style={{ color: '#faad14' }} /> 开盘主动拉升</>}
                                            className="monitor-card zhudong-card"
                                            variant="borderless"
                                        >
                                            <div className="jingjia-grid">
                                                {data.kaiPanZhuDongData.map((item, index) => {
                                                    const isUp = item.change >= 0;
                                                    const color = isUp ? '#f5222d' : '#52c41a';
                                                    return (
                                                        <div
                                                            key={index}
                                                            className="jingjia-item"
                                                            onClick={() => showKLine({ name: item.stockName, code: item.code, change: item.change })}
                                                            style={{ cursor: 'pointer' }}
                                                        >
                                                            <div className="stock-info">
                                                                <Text strong style={{ fontSize: '14px' }}>{item.stockName}</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.code?.replace('sh', '').replace('sz', '')}</Text>
                                                            </div>
                                                            <div className="stock-values">
                                                                <Text strong style={{ color: color, fontSize: '14px' }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.last_px?.toFixed(2)}</Text>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </Card>
                                    </Col>
                                )}
                            </Row>
                        )}

                        {/* 抢筹与拉升模块 */}
                        {( (data.jingJiaQiangChouData && data.jingJiaQiangChouData.length > 0) || (data.kaiPanZhuDongData && data.kaiPanZhuDongData.length > 0) ) && (
                            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                                {data.jingJiaQiangChouData && data.jingJiaQiangChouData.length > 0 && (
                                    <Col span={data.kaiPanZhuDongData && data.kaiPanZhuDongData.length > 0 ? 12 : 24}>
                                        <Card
                                            title={<><RiseOutlined style={{ color: '#ff4d4f' }} /> 竞价抢筹监控</>}
                                            className="monitor-card jingjia-card"
                                            variant="borderless"
                                        >
                                            <div className="jingjia-grid">
                                                {data.jingJiaQiangChouData.map((item, index) => {
                                                    const isUp = item.change >= 0;
                                                    const color = isUp ? '#f5222d' : '#52c41a';
                                                    return (
                                                        <div
                                                            key={index}
                                                            className="jingjia-item"
                                                            onClick={() => showKLine({ name: item.stockName, code: item.code, change: item.change })}
                                                            style={{ cursor: 'pointer' }}
                                                        >
                                                            <div className="stock-info">
                                                                <Text strong style={{ fontSize: '14px' }}>{item.stockName}</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.code?.replace('sh', '').replace('sz', '')}</Text>
                                                            </div>
                                                            <div className="stock-values">
                                                                <Text strong style={{ color: color, fontSize: '14px' }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.last_px?.toFixed(2)}</Text>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </Card>
                                    </Col>
                                )}
                                {data.kaiPanZhuDongData && data.kaiPanZhuDongData.length > 0 && (
                                    <Col span={data.jingJiaQiangChouData && data.jingJiaQiangChouData.length > 0 ? 12 : 24}>
                                        <Card
                                            title={<><ThunderboltOutlined style={{ color: '#faad14' }} /> 开盘主动拉升</>}
                                            className="monitor-card zhudong-card"
                                            variant="borderless"
                                        >
                                            <div className="jingjia-grid">
                                                {data.kaiPanZhuDongData.map((item, index) => {
                                                    const isUp = item.change >= 0;
                                                    const color = isUp ? '#f5222d' : '#52c41a';
                                                    return (
                                                        <div
                                                            key={index}
                                                            className="jingjia-item"
                                                            onClick={() => showKLine({ name: item.stockName, code: item.code, change: item.change })}
                                                            style={{ cursor: 'pointer' }}
                                                        >
                                                            <div className="stock-info">
                                                                <Text strong style={{ fontSize: '14px' }}>{item.stockName}</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.code?.replace('sh', '').replace('sz', '')}</Text>
                                                            </div>
                                                            <div className="stock-values">
                                                                <Text strong style={{ color: color, fontSize: '14px' }}>{item.change > 0 ? '+' : ''}{item.change?.toFixed(2)}%</Text>
                                                                <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>{item.last_px?.toFixed(2)}</Text>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </Card>
                                    </Col>
                                )}
                            </Row>
                        )}

                        {/* 顶部监控栏：板块涨跌幅 + 大盘异常 */}
                        <Row gutter={[16, 16]} style={{ marginBottom: 12 }}>
                            <Col xs={24} md={8}>
                                <Card className="top-block-card" variant="borderless" style={{ height: '100%' }}>
                                    <div className="block-card-header">
                                        <RiseOutlined className="rise-icon" />
                                        <Title level={5} style={{ margin: 0 }}>涨幅前五板块</Title>
                                    </div>
                                    <div className="block-items-container">
                                        {data.topAndBottomBlockData && data.topAndBottomBlockData.firstNumList.map((item, index) => (
                                            <div 
                                                key={index} 
                                                className="block-item rise"
                                                onClick={() => jumpToBlock(item.blockName)}
                                                style={{ cursor: 'pointer' }}
                                            >
                                                <span className="block-name">{item.blockName}</span>
                                                <span className="block-change">+{item.avgChange}%</span>
                                            </div>
                                        ))}
                                    </div>
                                </Card>
                            </Col>
                            <Col xs={24} md={8}>
                                <Card className="bottom-block-card" variant="borderless" style={{ height: '100%' }}>
                                    <div className="block-card-header">
                                        <FallOutlined className="fall-icon" />
                                        <Title level={5} style={{ margin: 0 }}>跌幅前五板块</Title>
                                    </div>
                                    <div className="block-items-container">
                                        {data.topAndBottomBlockData && data.topAndBottomBlockData.lastNumList.map((item, index) => (
                                            <div 
                                                key={index} 
                                                className="block-item fall"
                                                onClick={() => jumpToBlock(item.blockName)}
                                                style={{ cursor: 'pointer' }}
                                            >
                                                <span className="block-name">{item.blockName}</span>
                                                <span className="block-change">{item.avgChange}%</span>
                                            </div>
                                        ))}
                                    </div>
                                </Card>
                            </Col>
                            <Col xs={24} md={8}>
                                <Card
                                    title={<><LineChartOutlined /> 大盘异常监控</>}
                                    className="monitor-card dapan-card"
                                    variant="borderless"
                                    style={{ height: '100%' }}
                                >
                                    {dapanList.length > 0 ? (
                                        <Space direction="vertical" style={{ width: '100%' }} split={<Divider style={{ margin: '4px 0' }} />}>
                                            {dapanList.map((item, index) => (
                                                <div key={index} className={`data-item ${item.statusKey}`} style={{ backgroundColor: item.bgColor, padding: '4px 12px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between' }}>
                                                    <Text strong style={{ color: item.color, fontSize: '13px' }}>{item.name}</Text>
                                                    <Tag color={item.color} style={{ marginLeft: 'auto', border: 'none', fontWeight: 'bold', fontSize: '12px' }}>
                                                        {item.change}
                                                    </Tag>
                                                </div>
                                            ))}
                                        </Space>
                                    ) : (
                                        <Empty description="暂无大盘异常数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                    )}
                                </Card>
                            </Col>
                        </Row>

                        {/* 个股异动监控区 */}
                        <Card
                            title={
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 0' }}>
                                    <span><StockOutlined /> 个股幅度异动 (按涨幅排序)</span>
                                    {marketRiskWarning && (
                                        <Text strong style={{ fontSize: '15px', color: '#ff4d4f', fontStyle: 'italic', textDecoration: 'underline' }}>
                                            ⚠️ {marketRiskWarning}
                                        </Text>
                                    )}
                                </div>
                            }
                            className="monitor-card stock-card"
                            variant="borderless"
                        >
                            {stockData.changeList.length > 0 ? (
                                <div className="stock-grid">
                                    {stockData.changeList.map((item, index) => {
                                        const isRedStock = item.statusKey?.includes('Red');
                                        const showRiskOverlay = marketRiskWarning && isRedStock;

                                        const stockItemContent = (
                                            <div
                                                key={index}
                                                className={`stock-item ${item.type} ${item.statusKey} ${showRiskOverlay ? 'has-risk-overlay' : ''}`}
                                                style={{ backgroundColor: item.bgColor, borderColor: item.color, cursor: 'pointer', position: 'relative' }}
                                                onClick={() => showKLine(item)}
                                            >
                                                <div className="stock-info">
                                                    <Text strong style={{ color: item.color }}>{item.name}</Text>
                                                    <Text type="secondary" size="small" style={{ fontSize: '11px', display: 'block', opacity: 0.8, color: item.color }}>
                                                        {item.label}
                                                    </Text>
                                                    {item.desc && (
                                                        <Text type="secondary" size="small" style={{ fontSize: '10px', display: 'block', opacity: 0.9, color: item.color, fontStyle: 'italic', marginTop: '2px' }}>
                                                            {item.desc}
                                                        </Text>
                                                    )}
                                                </div>
                                                <Tag color={item.color} className="stock-tag" style={{ border: 'none' }}>
                                                    {item.change}
                                                </Tag>
                                                {showRiskOverlay && (
                                                    <div className="risk-overlay">
                                                        <CloseOutlined className="risk-cross-icon" />
                                                    </div>
                                                )}
                                            </div>
                                        );

                                        if (showRiskOverlay) {
                                            return (
                                                <Tooltip 
                                                    key={index}
                                                    title="当日情绪不佳，该股票不建议购买，谨慎出手"
                                                    color="#ff4d4f"
                                                    placement="top"
                                                >
                                                    {stockItemContent}
                                                </Tooltip>
                                            );
                                        }

                                        return stockItemContent;
                                    })}
                                </div>
                            ) : (
                                <Empty description="暂无个股异动数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                            )}
                        </Card>
                    </Col>

                    {/* 右侧独立列：自选股全量监控 */}
                    <Col xs={24} lg={7}>
                        <Card
                            title={<><AreaChartOutlined /> 自选股全量监控</>}
                            className="monitor-card all-stock-card"
                            variant="borderless"
                            bodyStyle={{ padding: '0 8px' }}
                            style={{ height: '100%' }}
                        >
                            <div style={{ padding: '8px 4px' }}>
                                <Input
                                    placeholder="搜索股票名称/代码"
                                    prefix={<SearchOutlined style={{ color: 'rgba(0,0,0,.25)' }} />}
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    allowClear
                                    size="small"
                                    style={{ borderRadius: '4px' }}
                                />
                            </div>
                            <div className="all-stock-list" style={{ maxHeight: 'calc(100vh - 250px)', overflowY: 'auto' }}>
                                {filteredAllStockData && filteredAllStockData.length > 0 ? (
                                    filteredAllStockData.map((stock, index) => {
                                        const kline = stock || {};
                                        const isUp = kline.change >= 0;
                                        const color = isUp ? '#f5222d' : '#52c41a';
                                        
                                        // 涨幅趋势判断
                                        const currentChange = kline.change || 0;
                                        const prevChange = kline.prevChange || 0;
                                        const isTrendingUp = currentChange > prevChange;
                                        const isTrendingDown = currentChange < prevChange;
                                        const trendColor = isTrendingUp ? '#f5222d' : (isTrendingDown ? '#52c41a' : '#999');

                                        return (
                                            <div 
                                                key={stock.code || index} 
                                                className="all-stock-item"
                                                style={{ 
                                                    display: 'flex', 
                                                    justifyContent: 'space-between', 
                                                    alignItems: 'center',
                                                    padding: '8px 6px',
                                                    borderBottom: '1px solid #f0f0f0',
                                                    backgroundColor: index % 2 === 0 ? '#fafafa' : '#fff',
                                                    cursor: 'pointer'
                                                }}
                                                onClick={() => showKLine({ name: stock.stockName, code: stock.code, change: kline.change })}
                                            >
                                                <div style={{ width: '85px', minWidth: 0 }}>
                                                    <Text strong style={{ fontSize: '12px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stock.stockName}</Text>
                                                    <div style={{ fontSize: '10px', color: '#999' }}>{stock.code?.replace('sh', '').replace('sz', '')}</div>
                                                </div>
                                                <div style={{ width: '50px', textAlign: 'right' }}>
                                                    <Text strong style={{ color: color, fontSize: '12px' }}>{kline.close_px?.toFixed(2)}</Text>
                                                </div>
                                                <div style={{ flex: 1, textAlign: 'right', paddingRight: '8px' }}>
                                                    <Space size={4} style={{ fontSize: '11px' }}>
                                                        <Text type="secondary" style={{ fontSize: '10px' }}>{prevChange.toFixed(2)}%</Text>
                                                        <Text type="secondary">→</Text>
                                                        <Text strong style={{ color: color }}>{currentChange.toFixed(2)}%</Text>
                                                    </Space>
                                                </div>
                                                <div style={{ width: '20px', textAlign: 'center' }}>
                                                    {isTrendingUp && <CaretUpOutlined style={{ color: '#f5222d' }} />}
                                                    {isTrendingDown && <CaretDownOutlined style={{ color: '#52c41a' }} />}
                                                </div>
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div style={{ padding: '40px 0' }}>
                                        <Empty description="暂无股票数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                    </div>
                                )}
                            </div>
                        </Card>
                    </Col>
                </Row>
            </> // Closing fragment tag added here
            )}

            {/* 异动历史弹窗 */}
            <Modal
                title={<span><HistoryOutlined /> 异动历史记录汇总</span>}
                open={isModalOpen}
                onCancel={() => setIsModalOpen(false)}
                footer={null}
                width={1000}
                className="history-modal"
            >
                <Tabs defaultActiveKey="1" style={{ marginTop: -16 }}>
                    <TabPane tab="最新异动" key="1">
                        <List
                            itemLayout="horizontal"
                            dataSource={history}
                            locale={{ emptyText: <Empty description="今日暂无历史异动记录" /> }}
                            renderItem={(item) => (
                                <List.Item
                                    className={`history-item ${item.type}`}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => showKLine({ name: item.name, code: item.code, change: item.changeValue || 0 })}
                                >
                                    <List.Item.Meta
                                        avatar={
                                            <div className={`history-avatar ${item.type}`}>
                                                {item.type === 'up' ? '🚀' : '📉'}
                                            </div>
                                        }
                                        title={
                                            <div className="history-title">
                                                <Text strong>{item.name}</Text>
                                                <Tag color={item.type === 'up' ? 'error' : 'success'} borderless className="history-tag">
                                                    {item.label}
                                                </Tag>
                                            </div>
                                        }
                                        description={
                                            <div className="history-desc">
                                                <Space split={<Divider type="vertical" />} wrap>
                                                    <Text type="secondary"><ClockCircleOutlined /> {item.time}</Text>
                                                    <Text strong style={{ color: item.type === 'up' ? '#cf1322' : '#389e0d' }}>
                                                        异动幅度: {item.changeDiff}
                                                    </Text>
                                                </Space>
                                            </div>
                                        }
                                    />
                                </List.Item>
                            )}
                        />
                    </TabPane>
                    <TabPane tab="急速异动排名" key="2">
                        <Row gutter={[16, 16]}>
                            <Col span={12}>
                                <Card title="📈 急速拉升榜" size="small" headStyle={{ backgroundColor: '#f6ffed', borderBottom: '1px solid #b7eb8f' }}>
                                    {jisuYidongUpList.length > 0 ? (
                                        <List
                                            itemLayout="horizontal"
                                            dataSource={jisuYidongUpList}
                                            renderItem={(item, index) => (
                                                <List.Item onClick={() => showKLine({ name: item.name, code: item.code, change: item.change })}
                                                style={{ cursor: 'pointer' }}>
                                                    <List.Item.Meta
                                                        avatar={<Text type="secondary">{index + 1}.</Text>}
                                                        title={
                                                            <Space>
                                                                <Text strong style={{ color: '#f5222d' }}>{item.stockName} ({item.code?.replace('sh', '').replace('sz', '')})</Text>
                                                                <Tag color="error" bordered={false}>{item.change}%</Tag>
                                                            </Space>
                                                        }
                                                        description={
                                                            <Space>
                                                                <Text type="secondary">上涨次数: {item.up}</Text>
                                                                <Text type="secondary">下跌次数: {item.down}</Text>
                                                            </Space>
                                                        }
                                                    />
                                                </List.Item>
                                            )}
                                        />
                                    ) : (
                                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无急速拉升数据" />
                                    )}
                                </Card>
                            </Col>
                            <Col span={12}>
                                <Card title="📉 急速下跌榜" size="small" headStyle={{ backgroundColor: '#fff1f0', borderBottom: '1px solid #ffa39e' }}>
                                    {jisuYidongDownList.length > 0 ? (
                                        <List
                                            itemLayout="horizontal"
                                            dataSource={jisuYidongDownList}
                                            renderItem={(item, index) => (
                                                <List.Item onClick={() => showKLine({ name: item.name, code: item.code, change: item.change })}
                                                style={{ cursor: 'pointer' }}>
                                                    <List.Item.Meta
                                                        avatar={<Text type="secondary">{index + 1}.</Text>}
                                                        title={
                                                            <Space>
                                                                <Text strong style={{ color: '#52c41a' }}>{item.stockName} ({item.code?.replace('sh', '').replace('sz', '')})</Text>
                                                                <Tag color="success" bordered={false}>{item.change}%</Tag>
                                                            </Space>
                                                        }
                                                        description={
                                                            <Space>
                                                                <Text type="secondary">上涨次数: {item.up}</Text>
                                                                <Text type="secondary">下跌次数: {item.down}</Text>
                                                            </Space>
                                                        }
                                                    />
                                                </List.Item>
                                            )}
                                        />
                                    ) : (
                                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无急速下跌数据" />
                                    )}
                                </Card>
                            </Col>
                        </Row>
                    </TabPane>
                </Tabs>
            </Modal>

            {/* K 线图弹窗 */}
            <StockKLineModal
                visible={klineModalVisible}
                onCancel={() => setKlineModalVisible(false)}
                code={selectedStock?.code}
                stockInfo={{
                    name: selectedStock?.name,
                    change: selectedStock?.change || selectedStock?.changeValue
                }}
            />
        </div>
    );
};

export default DingPan;