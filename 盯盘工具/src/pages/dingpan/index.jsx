import { useEffect, useState, useMemo, useRef } from "react";
import { createPortal } from 'react-dom';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { Row, Col, Spin, Modal, message, Input, Button } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, LockOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import { local_ip } from '../../constant';
import StockKLineModal from '../../components/StockKLineModal';
import IndexOverlayTline from '../../components/IndexOverlayTline';
import { useEmotionSuggestion } from '../../hooks/emotion';
import { getThemeColor } from '../../utils/theme';
import { isTradingDay, isAfterMarketClose } from '../../utils/tradingDay';
import TopGlobalAlerts from './components/TopGlobalAlerts';
import PageMeta from './components/PageMeta';
import MainMoneyCharts from './components/MainMoneyCharts';
import OpeningBattleCards from './components/OpeningBattleCards';
import BlockRankingCards from './components/BlockRankingCards';
import WatchlistTopRanking from './components/WatchlistTopRanking';
import StockAlertCard from './components/StockAlertCard';
import BlockAlertCard from './components/BlockAlertCard';
import OverlayTimelineSection from './components/OverlayTimelineSection';
import StockChangeMonitor from './components/StockChangeMonitor';
import BlockMoneyMonitor from './components/BlockMoneyMonitor';
import RihanMonitor from './components/RihanMonitor';
import WatchlistMonitor from './components/WatchlistMonitor';
import HistoryModal from './components/HistoryModal';
import GoodNewsModal from './components/GoodNewsModal';
import LogicExploreModal from './components/LogicExploreModal';
import AddStockModal from './components/AddStockModal';
import RenameStockModal from './components/RenameStockModal';
import TempHideStockModal from './components/TempHideStockModal';
import IndexOverlayFullscreenModal from './components/IndexOverlayFullscreenModal';
import BuyPointDiagnosisModal from './components/BuyPointDiagnosisModal';
import ThemeColorModal from './components/ThemeColorModal';
import { DEFAULT_THEME_COLOR } from './utils/themeColor';
import { hideStock, unhideStock, cleanExpiredHiddenStocks, filterHiddenStocks } from './utils/hiddenStocks';
import { fetchAndCopyContext } from './utils/copyContext';
import './index.scss';

// 市场盯盘页访问密码（前端写死，刷新页面后需重新输入）
const DINGPAN_ACCESS_PASSWORD = '17631540414xY@46728531912341234rR';

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

const isInMiddayBreak = (time) => {
    if (typeof time !== 'string' || time.length < 4) return false;
    const normalizedTime = time.padEnd(6, '0');
    return normalizedTime >= '113000' && normalizedTime < '130000';
};

const filterTradingSessionHistoryData = (records) => {
    if (!Array.isArray(records)) return [];
    return records.filter(([time]) => !isInMiddayBreak(time));
};

// 是否已收盘（统一来自 utils/tradingDay，非交易日视为已收盘，交易日 9:15 前或 14:59 及以后）

// 判断当前是否在交易时段内（非交易日（周末/节假日，以交易日历为准）和非交易时间不提醒）
const isWithinTradingHours = () => {
    const now = dayjs();
    if (!isTradingDay(now)) return false; // 非交易日不提醒

    const timeMinutes = now.hour() * 60 + now.minute();
    // 交易时段：9:15-11:30, 13:00-15:00
    if (timeMinutes >= 9 * 60 + 15 && timeMinutes <= 11 * 60 + 30) return true;
    if (timeMinutes >= 13 * 60 && timeMinutes <= 15 * 60) return true;
    return false;
};

const DingPan = () => {
    const navigate = useNavigate();

    // 访问密码门禁状态（不持久化：刷新页面或重新进入菜单后需重新输入）
    const [unlocked, setUnlocked] = useState(false);
    const [passwordInput, setPasswordInput] = useState('');
    const [passwordError, setPasswordError] = useState(false);

    const handleUnlockSubmit = () => {
        if (passwordInput === DINGPAN_ACCESS_PASSWORD) {
            setUnlocked(true);
            setPasswordInput('');
            setPasswordError(false);
        } else {
            setPasswordError(true);
            setPasswordInput('');
        }
    };

    // 功能开关：板块异动监控模块（设为true可重新启用）
    const SHOW_BLOCK_ALERT_MONITOR = false;

    const [data, setData] = useState({ unNormalDaPanData: [], unNormalStockList: [], diagnoseData: [], topAndBottomBlockData: null, allStockData: {}, amountInfo: null, jingJiaQiangChouData: [], kaiPanZhuDongData: [], kaiPanXiaCuoData: [], openingPrices: null });
    const [loading, setLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [history, setHistory] = useState([]); // 记录所有发生过的急速异动
    const [searchQuery, setSearchQuery] = useState(''); // 自选股搜索关键词
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [klineModalVisible, setKlineModalVisible] = useState(false);
    const [selectedStock, setSelectedStock] = useState(null);
    const [overlayInlineAddStock, setOverlayInlineAddStock] = useState(null); // 首页叠加分时增量添加
    const notifiedStocks = useRef(new Set()); // 用于记录已通知的异动，防止重复提醒
    const prevAllStockDataRef = useRef({}); // 记录上一次的自选股数据，用于对比涨幅趋势
    const [newStockCode, setNewStockCode] = useState(''); // 新增股票代码
    const [newStockName, setNewStockName] = useState(''); // 新增股票名称
    const [newStockBlockName, setNewStockBlockName] = useState(''); // 新增股票板块
    const [newStockRiskScore, setNewStockRiskScore] = useState(''); // 风险偏好分数
    const [newStockIsTech, setNewStockIsTech] = useState(true); // 是否为科技股，默认打开
    const [addStockModalVisible, setAddStockModalVisible] = useState(false); // 新增股票弹窗可见性
    const [showOnlyImportant, setShowOnlyImportant] = useState(() => {
        return localStorage.getItem('dingpan_showOnlyImportant') === 'true';
    }); // 是否只显示重点标记股票
    const [sortOrder, setSortOrder] = useState(() => {
        return localStorage.getItem('dingpan_sortOrder') || 'none'; // 'none', 'asc', 'desc'
    }); // 排序设置
    const [sortField, setSortField] = useState(() => {
        return localStorage.getItem('dingpan_sortField') || 'change'; // 'change' | 'mainFund'
    }); // 排序字段
    const [showOnlyGoodNews, setShowOnlyGoodNews] = useState(() => {
        return localStorage.getItem('dingpan_showOnlyGoodNews') === 'true';
    }); // 是否只显示有利好消息的股票
    const [stockViewMode, setStockViewMode] = useState(() => {
        const saved = localStorage.getItem('dingpan_stockViewMode');
        const valid = ['grouped', 'merged', 'statistics', 'research'];
        return valid.includes(saved) ? saved : 'grouped';
    }); // 个股幅度异动视图模式

    // DIY 主题色配置：{ itemTitleColor, itemBorderColor, numberFontFamily }
    const [themeColor, setThemeColor] = useState(() => {
        try {
            const saved = localStorage.getItem('dingpan_themeColor');
            return saved ? { ...DEFAULT_THEME_COLOR, ...JSON.parse(saved) } : { ...DEFAULT_THEME_COLOR };
        } catch {
            return { ...DEFAULT_THEME_COLOR };
        }
    });
    const [themeColorModalVisible, setThemeColorModalVisible] = useState(false);

    // 研报数据相关状态
    const [jigouReports, setJigouReports] = useState([]);
    const [recentResearchReports, setRecentResearchReports] = useState([]);
    const [researchReportsLoading, setResearchReportsLoading] = useState(false);
    const [researchReportsLoaded, setResearchReportsLoaded] = useState(false);

    // 利好消息弹窗相关状态
    const [showGoodNewsModal, setShowGoodNewsModal] = useState(false);
    const [matchedReports, setMatchedReports] = useState([]);
    const [currentGoodNewsStock, setCurrentGoodNewsStock] = useState('');

    // 逻辑探查弹窗相关状态
    const [showLogicExploreModal, setShowLogicExploreModal] = useState(false);
    const [logicExploreStock, setLogicExploreStock] = useState(null);
    const [logicExploreLoading, setLogicExploreLoading] = useState(false);
    const [jigouMatchedReports, setJigouMatchedReports] = useState([]);
    const [researchMatchedReports, setResearchMatchedReports] = useState([]);

    // 重命名股票弹窗相关状态
    const [renameModalVisible, setRenameModalVisible] = useState(false);
    const [renameStockCode, setRenameStockCode] = useState('');
    const [renameStockName, setRenameStockName] = useState('');

    // 暂时隐藏股票相关状态（localStorage 持久化，按自然日计）
    const [hiddenStockMap, setHiddenStockMap] = useState(() => cleanExpiredHiddenStocks());
    const [tempHideModalVisible, setTempHideModalVisible] = useState(false);
    const [tempHideStock, setTempHideStock] = useState(null);
    // 打开弹窗事件中记录的时间戳（事件处理器内可安全调用 Date.now），供弹窗计算剩余天数
    const [tempHideOpenTs, setTempHideOpenTs] = useState(0);
    const [refreshingStockData, setRefreshingStockData] = useState(false);
    const [watchlistMainFund, setWatchlistMainFund] = useState({});

    // 买点诊断弹窗相关状态
    const [showBuyPointDiagnosisModal, setShowBuyPointDiagnosisModal] = useState(false);
    const [buyPointDiagnosisStock, setBuyPointDiagnosisStock] = useState(null);
    const [buyPointDiagnosisData, setBuyPointDiagnosisData] = useState(null);
    const [buyPointDiagnosisLoading, setBuyPointDiagnosisLoading] = useState(false);

    // 交易纪律弹窗状态（每个交易日 9:30-9:40 强制显示，期间不可手动关闭，9:40 后自动关闭）
    const [disciplineModalVisible, setDisciplineModalVisible] = useState(false);

    // 监听筛选状态变化并存入 localStorage
    useEffect(() => {
        localStorage.setItem('dingpan_showOnlyImportant', showOnlyImportant);
    }, [showOnlyImportant]);

    // 监听排序设置变化并存入 localStorage
    useEffect(() => {
        localStorage.setItem('dingpan_sortOrder', sortOrder);
    }, [sortOrder]);

    useEffect(() => {
        localStorage.setItem('dingpan_sortField', sortField);
    }, [sortField]);

    // 表头排序：同字段循环 none→asc→desc→none，切换字段默认倒序（大到小）
    const handleSortChange = (field) => {
        if (field === sortField) {
            if (sortOrder === 'none') setSortOrder('asc');
            else if (sortOrder === 'asc') setSortOrder('desc');
            else setSortOrder('none');
        } else {
            setSortField(field);
            setSortOrder('desc');
        }
    };

    // 监听利好筛选状态变化并存入 localStorage
    useEffect(() => {
        localStorage.setItem('dingpan_showOnlyGoodNews', showOnlyGoodNews);
    }, [showOnlyGoodNews]);

    // 监听主题色配置变化并存入 localStorage
    useEffect(() => {
        localStorage.setItem('dingpan_themeColor', JSON.stringify(themeColor));
    }, [themeColor]);

    // 交易纪律弹窗：每个交易日 9:30:00-9:40:00 显示，非交易日（周末/节假日，以交易日历为准）与午休/收盘后不显示
    useEffect(() => {
        const updateVisibility = () => {
            const now = dayjs();
            if (!isTradingDay(now)) {
                setDisciplineModalVisible(prev => (prev ? false : prev));
                return;
            }
            const totalSeconds = now.hour() * 3600 + now.minute() * 60 + now.second();
            const inWindow = totalSeconds >= 9 * 3600 + 30 * 60 && totalSeconds < 9 * 3600 + 40 * 60;
            setDisciplineModalVisible(prev => (prev !== inWindow ? inWindow : prev));
        };
        updateVisibility();
        const id = setInterval(updateVisibility, 1000);
        return () => clearInterval(id);
    }, []);

    const handleSaveThemeColor = (next) => {
        setThemeColor(next);
        setThemeColorModalVisible(false);
    };

    // 新增自选股
    const handleAddStock = async () => {
        if (!newStockCode || !newStockName) {
            return;
        }
        try {
            await axios.post(`http://${local_ip}:3000/add_monitor_stock`, {
                code: newStockCode,
                name: newStockName,
                blockName: newStockBlockName || 'xxx',
                riskScore: newStockRiskScore || null,
                isTech: newStockIsTech
            });
            setNewStockCode('');
            setNewStockName('');
            setNewStockBlockName('');
            setNewStockRiskScore('');
            setNewStockIsTech(true);
            setAddStockModalVisible(false);
            fetchData(); // 重新拉取数据
        } catch (error) {
            console.error('Add stock failed:', error);
        }
    };

    // 删除自选股
    const handleDeleteStock = async (e, code) => {
        if (e && e.stopPropagation) e.stopPropagation(); // 阻止触发跳转 K 线
        Modal.confirm({
            title: '确认删除',
            content: '确定要将该股票从自选股监控中移除吗？',
            onOk: async () => {
                try {
                    await axios.post(`http://${local_ip}:3000/delete_monitor_stock`, { code });
                    fetchData();
                } catch (error) {
                    console.error('Delete stock failed:', error);
                }
            }
        });
    };

    // 切换重点标记
    const handleToggleImportant = async (e, code) => {
        e.stopPropagation();
        try {
            await axios.post(`http://${local_ip}:3000/toggle_stock_important`, { code });
            fetchData();
        } catch (error) {
            console.error('Toggle important failed:', error);
        }
    };

    // 切换置顶
    const handleToggleStockTop = async (stock) => {
        try {
            await axios.post(`http://${local_ip}:3000/toggle_stock_top`, { code: stock.code });
            fetchData();
        } catch (error) {
            console.error('Toggle top failed:', error);
        }
    };

    // 打开重命名弹窗
    const handleOpenRenameModal = (stock) => {
        setRenameStockCode(stock.code);
        setRenameStockName(stock.stockName);
        setRenameModalVisible(true);
    };

    // 确认重命名
    const handleConfirmRename = async () => {
        if (!renameStockCode || !renameStockName.trim()) {
            return;
        }
        try {
            await axios.post(`http://${local_ip}:3000/update_monitor_stock_name`, {
                code: renameStockCode,
                name: renameStockName.trim()
            });
            setRenameModalVisible(false);
            fetchData();
        } catch (error) {
            console.error('Rename stock failed:', error);
        }
    };

    // 打开暂时隐藏弹窗
    const handleOpenTempHideModal = (stock) => {
        setTempHideStock(stock);
        setTempHideOpenTs(Date.now());
        setTempHideModalVisible(true);
    };

    // 确认暂时隐藏：n 个自然日后自动恢复显示
    const handleConfirmTempHide = (days) => {
        if (!tempHideStock?.code) return;
        const nextMap = hideStock(tempHideStock.code, tempHideStock.stockName, days);
        setHiddenStockMap({ ...nextMap });
        setTempHideModalVisible(false);
        message.success(`已暂时隐藏 ${tempHideStock.stockName || tempHideStock.code}，到期后自动恢复显示`);
    };

    // 恢复显示被隐藏的股票
    const handleUnhideStock = (code) => {
        const nextMap = unhideStock(code);
        setHiddenStockMap({ ...nextMap });
        message.success('已恢复显示');
    };

    // 判断股票是否有匹配的利好研报
    const hasGoodNews = (stockName) => {
        if (!stockName || !jigouReports.length) return false;
        return jigouReports.some(report => {
            const titleMatch = report.title && report.title.includes(stockName);
            const textMatch = report.text && report.text.includes(stockName);
            return titleMatch || textMatch;
        });
    };

    // 高亮文本中的股票名称
    const highlightStockName = (text, stockName) => {
        if (!text || !stockName) return text;
        const cleanedText = text.replace(/<e[^>]*>/g, '');
        const regex = new RegExp(`(${stockName})`, 'g');
        return cleanedText.replace(regex, '<span class="highlight-stock">$1</span>');
    };

    // 点击利好消息打开弹窗
    const handleViewGoodNews = (stockName) => {
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

    // 从市场调研研报树中递归收集所有研报项
    const collectAllResearchReports = (treeItems) => {
        const results = [];
        if (!treeItems || !Array.isArray(treeItems)) return results;

        const traverse = (items, folderPath = []) => {
            for (const item of items) {
                if (item.type === 'folder') {
                    if (item.children && item.children.length > 0) {
                        traverse(item.children, [...folderPath, item.name]);
                    }
                } else if (item.type === 'report') {
                    results.push({
                        ...item,
                        folderPath: folderPath.join(' / ')
                    });
                }
            }
        };

        traverse(treeItems);
        return results;
    };

    // 研报视图：点击图标查看个股相关研报（使用预计算数据，无需重复拉取）
    const handleViewYanbaoDetail = (stock) => {
        if (!stock || !stock.stockName) return;
        setLogicExploreStock(stock);
        setJigouMatchedReports(stock.jigouReports || []);
        setResearchMatchedReports(stock.researchReports || []);
        setShowLogicExploreModal(true);
    };

    // 打开逻辑探查弹窗
    const handleLogicExplore = async (stock) => {
        if (!stock || !stock.stockName) return;

        setLogicExploreStock(stock);
        setShowLogicExploreModal(true);
        setLogicExploreLoading(true);
        setJigouMatchedReports([]);
        setResearchMatchedReports([]);

        try {
            const stockName = stock.stockName;

            // 1. 匹配机构研报（标题和内容都匹配），按发布时间倒序排列
            const jigouMatched = jigouReports.filter(report => {
                const titleMatch = report.title && report.title.includes(stockName);
                const textMatch = report.text && report.text.includes(stockName);
                return titleMatch || textMatch;
            }).sort((a, b) => {
                const timeA = a.createTime ? new Date(a.createTime).getTime() : 0;
                const timeB = b.createTime ? new Date(b.createTime).getTime() : 0;
                return timeB - timeA;
            });
            setJigouMatchedReports(jigouMatched);

            // 2. 获取市场调研所有研报，扫描标题和内容
            const researchResponse = await axios.get(`http://${local_ip}:3000/get_research_reports`);
            const researchTree = researchResponse.data || [];
            const allReports = collectAllResearchReports(researchTree);

            // 并发获取所有研报的完整内容，分批处理避免过多并发
            const batchSize = 10;
            const fullContentReports = [];

            for (let i = 0; i < allReports.length; i += batchSize) {
                const batch = allReports.slice(i, i + batchSize);
                const batchResults = await Promise.all(
                    batch.map(async (report) => {
                        try {
                            const contentResponse = await axios.get(`http://${local_ip}:3000/get_research_report`, {
                                params: { id: report.id }
                            });
                            const content = contentResponse.data?.content || '';
                            return {
                                ...report,
                                content
                            };
                        } catch (e) {
                            return { ...report, content: '' };
                        }
                    })
                );

                // 过滤出名称或内容匹配股票名称的研报
                const matchedBatch = batchResults.filter(report => {
                    const nameMatch = report.name && report.name.includes(stockName);
                    const contentMatch = report.content && report.content.includes(stockName);
                    return nameMatch || contentMatch;
                });

                fullContentReports.push(...matchedBatch);
            }

            // 排序：置顶优先 → 按文件夹日期倒序 → 重点标记优先
            fullContentReports.sort((a, b) => {
                // 置顶优先级最高
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;

                // 从文件夹路径提取日期（格式如 "20260731" 或 "20260731 / xxx"）
                const extractDate = (folderPath) => {
                    if (!folderPath) return '00000000';
                    const match = folderPath.match(/(\d{8})/);
                    return match ? match[1] : '00000000';
                };

                const dateA = extractDate(a.folderPath);
                const dateB = extractDate(b.folderPath);

                if (dateA !== dateB) {
                    return dateB.localeCompare(dateA); // 日期倒序（新的在前）
                }

                // 同一日期下，重点标记的排前面
                if (a.isImportant && !b.isImportant) return -1;
                if (!a.isImportant && b.isImportant) return 1;

                return 0;
            });

            setResearchMatchedReports(fullContentReports);
        } catch (error) {
            console.error('逻辑探查数据获取失败:', error);
            message.error('获取逻辑探查数据失败');
        } finally {
            setLogicExploreLoading(false);
        }
    };

    // 资金与成交量趋势监控相关
    const [amountHistory, setAmountHistory] = useState([]);
    const [mainMoneyHistory, setMainMoneyHistory] = useState([]); // 记录主力资金历史，用于趋势预警
    const [defensiveBlockHistory, setDefensiveBlockHistory] = useState([]); // 记录防御板块历史，用于趋势预警
    const [alerts, setAlerts] = useState([]); // 存储当前显示的顶部告警信息列表
    const [techIndexData, setTechIndexData] = useState([]); // 科技情绪数据
    const [rihanData, setRihanData] = useState([]); // 日韩指数数据
    const [jisuYidongUpList, setJisuYidongUpList] = useState([]); // 急速异动上涨排名
    const [jisuYidongDownList, setJisuYidongDownList] = useState([]); // 急速异动下跌排名
    const [showJingJiaQiangChou, setShowJingJiaQiangChou] = useState(true); // 控制竞价抢筹模块显示
    const [showKaiPanZhuDong, setShowKaiPanZhuDong] = useState(true); // 控制开盘主动拉升模块显示
    const [showKaiPanXiaCuo, setShowKaiPanXiaCuo] = useState(true); // 控制开盘持续下挫模块显示

    // 主力资金趋势图相关
    const [historyData, setHistoryData] = useState([]);
    const mainMoneyContainerRef = useRef(null);
    const mainMoneyChartRef = useRef(null);
    const [isMainMoneyExpanded, setIsMainMoneyExpanded] = useState(true);
    const [copyContextLoading, setCopyContextLoading] = useState(false);

    // 自选股全量监控折叠状态
    // 交易日（以交易日历为准）9:00-15:00 默认折叠，其他时间默认展开
    const [isWatchlistCollapsed, setIsWatchlistCollapsed] = useState(() => {
        const now = new Date();
        const hour = now.getHours();
        const isTradingTime = isTradingDay(now) && hour >= 9 && hour < 15;
        return isTradingTime;
    });
    const isWatchlistCollapseInitialized = useRef(false);

    // 指数叠加分时全屏弹窗状态
    const [indexOverlayFullscreenVisible, setIndexOverlayFullscreenVisible] = useState(false);

    // 成交量趋势图相关
    const volumeContainerRef = useRef(null);
    const volumeChartRef = useRef(null);

    // 板块异动监控相关
    const [blockHistoryData, setBlockHistoryData] = useState([]);
    const prevBlockHistoryRef = useRef(null);
    const [blockAlerts, setBlockAlerts] = useState([]);

    // 板块资金监控相关
    const [blockMoneyData, setBlockMoneyData] = useState([]);
    const [blockMoneyAlerts, setBlockMoneyAlerts] = useState([]);
    const prevBlockMoneyRef = useRef(null);
    const overlayTimelineSectionRef = useRef(null);
    const rihanSectionRef = useRef(null); // 日韩涨跌监控区域，用于双击定位
    const hasAutoScrolledToRihanRef = useRef(false); // 进入页面自动滚动到日韩区域只执行一次的标记
    const targetBlocks = [
        '光通信模块',
        '创新药',
        '半导体概念',
        '银行Ⅱ',
        '液冷',
        '保险Ⅱ',
        '证券Ⅱ',
        'PCB',
        '中证500',
        'MLCC',
        '商业航天',
        '机器人概念',
        '锂电池概念',
        '存储芯片',
        '黄金概念'
    ];
    const BLOCK_MONEY_BIG_CHANGE_THRESHOLD = 500000000; // 5 亿
    // 卡片中只展示这 4 个板块（监控告警仍覆盖全部 targetBlocks）
    const displayBlocks = ['创新药', '银行Ⅱ', '光通信模块', '半导体概念', '存储芯片', '黄金概念',];

    // 打开 K 线弹窗
    const showKLine = (stock) => {
        setSelectedStock(stock);
        setKlineModalVisible(true);
    };

    // 把股票加入首页常驻叠加分时模块，并自动滚动到该区域
    const handleOpenOverlayTimeLine = (stock) => {
        setOverlayInlineAddStock({
            code: stock.code,
            stockName: stock.stockName,
            change: stock.change,
            _ts: Date.now(),
        });
        message.success(`已将 ${stock.stockName || stock.code} 加入叠加分时`);
        window.setTimeout(() => {
            overlayTimelineSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
    };

    // 鼠标左键双击页面时自动滚动到日韩涨跌监控区域
    // 叠加分时观察中的 tag 自带双击移除股票逻辑，双击 tag 时不触发滚动，避免冲突
    const handlePageDoubleClick = (e) => {
        if (e.button !== 0) return;
        if (e.target.closest && e.target.closest('.mtlm-tag-item')) return;
        rihanSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // 连续两次按空格键滚动到日韩涨跌监控区域（与双击页面功能一致）
    useEffect(() => {
        let lastSpaceTime = 0;
        const handleKeyDown = (e) => {
            // 输入框/文本域/可编辑元素中不触发，避免影响输入
            const target = e.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            if (e.code !== 'Space') return;
            const now = Date.now();
            if (now - lastSpaceTime <= 500) {
                e.preventDefault();
                rihanSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                lastSpaceTime = 0;
            } else {
                lastSpaceTime = now;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // 自动滚动到日韩涨跌监控区域（进入页面后仅执行一次）
    const autoScrollToRihanOnce = () => {
        if (hasAutoScrolledToRihanRef.current) return;
        hasAutoScrolledToRihanRef.current = true;
        rihanSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // 进入页面等日韩数据加载完成后自动滚动到日韩涨跌监控区域；刷新页面或切走路由再回来会重新触发
    useEffect(() => {
        if (!rihanData || rihanData.length === 0) return;
        // 稍等页面渲染稳定后再滚动
        const timer = window.setTimeout(autoScrollToRihanOnce, 500);
        return () => window.clearTimeout(timer);
    }, [rihanData]);

    // 兜底：日韩数据长时间未加载时也自动滚动一次
    useEffect(() => {
        const timer = window.setTimeout(autoScrollToRihanOnce, 5000);
        return () => window.clearTimeout(timer);
    }, []);

    // 跳转到重点板块并定位
    const jumpToBlock = (blockName) => {
        navigate(`/block?blockName=${encodeURIComponent(blockName)}`);
    };

    // 打开个股买点诊断弹窗
    const handleBuyPointDiagnosis = async (stock) => {
        if (!stock || !stock.code) return;
        setBuyPointDiagnosisStock(stock);
        setShowBuyPointDiagnosisModal(true);
        setBuyPointDiagnosisData(null);
        setBuyPointDiagnosisLoading(true);
        try {
            const response = await axios.post(`http://${local_ip}:3000/buy_point_single_stock_diagnosis`, {
                code: stock.code,
                refresh: 1,
            });
            setBuyPointDiagnosisData(response.data);
        } catch (error) {
            console.error('个股买点诊断失败:', error);
            message.error('买点诊断失败，请稍后重试');
        } finally {
            setBuyPointDiagnosisLoading(false);
        }
    };

    // 刷新个股买点诊断
    const handleRefreshBuyPointDiagnosis = async () => {
        if (!buyPointDiagnosisStock?.code) return;
        setBuyPointDiagnosisLoading(true);
        try {
            const response = await axios.post(`http://${local_ip}:3000/buy_point_single_stock_diagnosis`, {
                code: buyPointDiagnosisStock.code,
                refresh: 1,
            });
            setBuyPointDiagnosisData(response.data);
        } catch (error) {
            console.error('刷新买点诊断失败:', error);
            message.error('刷新失败，请稍后重试');
        } finally {
            setBuyPointDiagnosisLoading(false);
        }
    };

    // 渲染板块内部股票涨跌幅列表（悬浮窗内容）
    const renderBlockStockList = (blockData) => {
        if (!blockData || !blockData.data || blockData.data.length === 0) {
            return <div style={{ padding: '8px', color: '#999' }}>暂无数据</div>;
        }
        return (
            <div className="block-stock-list">
                {blockData.data.map((stock, idx) => (
                    <div
                        key={idx}
                        className="block-stock-item"
                        style={{ cursor: 'pointer' }}
                        onClick={() => showKLine({ name: stock.name, code: stock.code, change: stock.change })}
                    >
                        <span className="block-stock-name">{stock.name}</span>
                        <span className={`block-stock-change ${stock.change >= 0 ? 'up' : 'down'}`}>
                            {stock.change > 0 ? '+' : ''}{stock.change}%
                        </span>
                    </div>
                ))}
            </div>
        );
    };

    // 请求通知权限
    useEffect(() => {
        if ("Notification" in window) {
            if (Notification.permission !== "granted" && Notification.permission !== "denied") {
                Notification.requestPermission();
            }
        }
    }, []);

    // 监听来自技术诊断页面的叠加分时添加请求
    useEffect(() => {
        const handleStorageChange = (e) => {
            if (e.key === 'dingpan_overlay_add_stock_ts') {
                try {
                    const stockStr = localStorage.getItem('dingpan_overlay_add_stock');
                    if (stockStr) {
                        const stock = JSON.parse(stockStr);
                        if (stock.code) {
                            setOverlayInlineAddStock({
                                code: stock.code,
                                stockName: stock.stockName,
                                change: stock.change,
                                _ts: Date.now(),
                            });
                            message.success(`已将 ${stock.stockName || stock.code} 加入叠加分时`);
                            window.setTimeout(() => {
                                overlayTimelineSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }, 80);
                            localStorage.removeItem('dingpan_overlay_add_stock');
                            localStorage.removeItem('dingpan_overlay_add_stock_ts');
                        }
                    }
                } catch (error) {
                    console.error('读取叠加分时数据失败:', error);
                }
            }
        };

        window.addEventListener('storage', handleStorageChange);

        // 检查是否有未处理的叠加请求（页面刚打开时）
        try {
            const stockStr = localStorage.getItem('dingpan_overlay_add_stock');
            if (stockStr) {
                const stock = JSON.parse(stockStr);
                if (stock.code) {
                    setOverlayInlineAddStock({
                        code: stock.code,
                        stockName: stock.stockName,
                        change: stock.change,
                        _ts: Date.now(),
                    });
                    message.success(`已将 ${stock.stockName || stock.code} 加入叠加分时`);
                    localStorage.removeItem('dingpan_overlay_add_stock');
                    localStorage.removeItem('dingpan_overlay_add_stock_ts');
                }
            }
        } catch (error) {
            console.error('读取叠加分时数据失败:', error);
        }

        return () => {
            window.removeEventListener('storage', handleStorageChange);
        };
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

        // TODO: 先注销通知，不然太频繁了，影响注意力
        // new Notification("📈 盯盘异动提醒", {
        //     body: `【${stockName}】发生急速波动！\n类型：${label}\n幅度：${changeDiff}\n时间：${dayjs().format('HH:mm:ss')}`,
        //     icon: '/favicon.svg'
        // });

        notifiedStocks.current.add(notifyKey);


        // 10分钟后清除记录，允许再次提醒
        setTimeout(() => {
            notifiedStocks.current.delete(notifyKey);
        }, 10 * 60 * 1000);
    };

    // 量价背离浏览器通知（诱多/诱空），使用 localStorage 进行 10 分钟频控
    const checkAndSendDivergenceNotification = (divergenceType, boards) => {
        if (!isWithinTradingHours()) return; // 周末和非交易时段不提醒

        const localStorageKey = 'dingpan_divergence_last_notify_time';
        const lastNotifyTime = parseInt(localStorage.getItem(localStorageKey) || '0', 10);
        const now = Date.now();

        // 至少相隔 10 分钟才能进行下一次提示
        if (now - lastNotifyTime < 10 * 60 * 1000) return;

        if (!("Notification" in window) || Notification.permission !== "granted") return;

        const boardText = boards.length === 2 ? '科创板和创业板' : boards[0];
        const timeStr = dayjs().format('HH:mm:ss');

        let title, body;
        if (divergenceType === 'bullTrap') {
            title = '⚠️ 量价背离提醒（诱多）';
            body = `主力资金持续净流出，但${boardText}分时上涨，疑似诱多，请谨慎追高！\n时间：${timeStr}`;
        } else {
            title = '⚠️ 量价背离提醒（诱空）';
            body = `主力资金持续净流入，但${boardText}分时下跌，疑似诱空，请勿盲目杀跌！\n时间：${timeStr}`;
        }

        new Notification(title, {
            body,
            icon: '/favicon.svg'
        });

        localStorage.setItem(localStorageKey, String(now));
    };

    // 暂时隐藏过滤：仅作用于自选股全量监控/个股幅度异动/自选股涨跌幅前十三个模块，其他模块与科技情绪指数计算不受影响
    const visibleAllStockData = useMemo(() => (
        filterHiddenStocks(data.allStockData, hiddenStockMap)
    ), [data.allStockData, hiddenStockMap]);

    const filteredAllStockData = useMemo(() => {
        let stocks = Array.isArray(visibleAllStockData) ? visibleAllStockData : [];

        // 1. 重点筛选
        if (showOnlyImportant) {
            stocks = stocks.filter(stock => stock.isImportant);
        }

        // 2. 利好消息筛选
        if (showOnlyGoodNews) {
            stocks = stocks.filter(stock => hasGoodNews(stock.stockName));
        }

        // 3. 搜索关键词筛选
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            stocks = stocks.filter(stock =>
                (stock.stockName && stock.stockName.toLowerCase().includes(query)) ||
                (stock.code && stock.code.toLowerCase().includes(query))
            );
        }

        // 4. 排序逻辑：置顶股票始终排在最前面，然后按当前排序字段(涨幅/主力资金)排序
        if (sortOrder !== 'none') {
            stocks = [...stocks].sort((a, b) => {
                if (a.isTop && !b.isTop) return -1;
                if (!a.isTop && b.isTop) return 1;
                let valA, valB;
                if (sortField === 'mainFund') {
                    const fa = watchlistMainFund?.[a.code];
                    const fb = watchlistMainFund?.[b.code];
                    valA = (fa !== undefined && fa !== null) ? Number(fa) : null;
                    valB = (fb !== undefined && fb !== null) ? Number(fb) : null;
                } else {
                    valA = a.change || 0;
                    valB = b.change || 0;
                }
                // 无主力资金数据的股票始终排在最后
                if (valA === null && valB === null) return 0;
                if (valA === null) return 1;
                if (valB === null) return -1;
                return sortOrder === 'asc' ? valA - valB : valB - valA;
            });
        } else {
            stocks = [...stocks].sort((a, b) => {
                if (a.isTop && !b.isTop) return -1;
                if (!a.isTop && b.isTop) return 1;
                return 0;
            });
        }

        return stocks;
    }, [visibleAllStockData, searchQuery, showOnlyImportant, showOnlyGoodNews, sortOrder, sortField, watchlistMainFund, jigouReports]);

    const allStockOverview = useMemo(() => {
        const allStocks = Array.isArray(data.allStockData) ? data.allStockData : [];
        const risingCount = filteredAllStockData.filter(stock => (stock.change || 0) >= 0).length;
        const fallingCount = filteredAllStockData.length - risingCount;

        return {
            totalCount: allStocks.length,
            filteredCount: filteredAllStockData.length,
            importantCount: allStocks.filter(stock => stock.isImportant).length,
            risingCount,
            fallingCount
        };
    }, [data.allStockData, filteredAllStockData]);

    // 研报视图：基于自选股 + 机构研报 + 近期研报，计算涨幅Top10、覆盖Top10及交集
    const reportStockData = useMemo(() => {
        if (!researchReportsLoaded) return { topGain: [], topCoverage: [], intersection: [] };

        const allStocks = Array.isArray(visibleAllStockData) ? visibleAllStockData : [];

        const fiveDaysAgo = dayjs().subtract(5, 'day');
        const recentJigouReports = jigouReports.filter(report => {
            if (!report.createTime) return false;
            return dayjs(report.createTime).isAfter(fiveDaysAgo);
        });

        const stockReports = allStocks.map(stock => {
            const stockName = stock.stockName;
            if (!stockName) return null;

            const jigouMatched = recentJigouReports.filter(report => {
                return (report.title && report.title.includes(stockName)) ||
                       (report.text && report.text.includes(stockName));
            }).sort((a, b) => {
                const timeA = a.createTime ? new Date(a.createTime).getTime() : 0;
                const timeB = b.createTime ? new Date(b.createTime).getTime() : 0;
                return timeB - timeA;
            });

            const researchMatched = recentResearchReports.filter(report => {
                return (report.name && report.name.includes(stockName)) ||
                       (report.content && report.content.includes(stockName));
            }).sort((a, b) => {
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                const extractDate = (folderPath) => {
                    if (!folderPath) return '00000000';
                    const match = folderPath.match(/(\d{8})/);
                    return match ? match[1] : '00000000';
                };
                const dateA = extractDate(a.folderPath);
                const dateB = extractDate(b.folderPath);
                if (dateA !== dateB) return dateB.localeCompare(dateA);
                if (a.isImportant && !b.isImportant) return -1;
                if (!a.isImportant && b.isImportant) return 1;
                return 0;
            });

            return {
                ...stock,
                jigouCount: jigouMatched.length,
                researchCount: researchMatched.length,
                totalCount: jigouMatched.length + researchMatched.length,
                change: stock.change || 0,
                jigouReports: jigouMatched,
                researchReports: researchMatched
            };
        }).filter(item => item !== null && item.totalCount > 0);

        const topGain = [...stockReports].sort((a, b) => b.change - a.change).slice(0, 10);
        const topCoverage = [...stockReports].sort((a, b) => {
            if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
            return b.change - a.change;
        }).slice(0, 10);
        const topGainCodes = new Set(topGain.map(s => s.code));
        const intersection = topCoverage.filter(s => topGainCodes.has(s.code));

        return { topGain, topCoverage, intersection };
    }, [visibleAllStockData, jigouReports, recentResearchReports, researchReportsLoaded]);

    const moneyStatus = useMemo(() => {
        if (historyData.length < 2) return null;

        const latest = historyData[historyData.length - 1][1];
        const prev = historyData[historyData.length - 2][1];

        const curMoney = parseFloat(latest.mainMoney) || 0;
        const preMoney = parseFloat(prev.mainMoney) || 0;

        if (curMoney > preMoney) {
            return { label: '加速流入', color: '#f5222d', icon: <ArrowUpOutlined /> };
        } else if (curMoney < preMoney) {
            return { label: '加速流出', color: '#52c41a', icon: <ArrowDownOutlined /> };
        }
        // 等于的时候返回 null，什么都不展示
        return null;
    }, [historyData]);

    const volumeStatus = useMemo(() => {
        if (historyData.length < 2) return null;

        const latest = historyData[historyData.length - 1][1];
        const prev = historyData[historyData.length - 2][1];

        const curVolume = parseFloat(latest.amountChangeDiff) || 0;
        const preVolume = parseFloat(prev.amountChangeDiff) || 0;

        if (curVolume > preVolume) {
            return { label: '持续放量', color: getThemeColor(), icon: <ArrowUpOutlined /> };
        } else if (curVolume < preVolume) {
            return { label: '持续缩量', color: '#52c41a', icon: <ArrowDownOutlined /> };
        }
        return null;
    }, [historyData]);

    // 表头展示主力资金相邻时间桶的 diff 变化值（如 +2.3亿 / -1.8亿），而非净流入绝对值
    const latestMoneyValue = useMemo(() => {
        if (historyData.length < 2) return null;
        const latest = historyData[historyData.length - 1][1];
        const prev = historyData[historyData.length - 2][1];
        return (parseFloat(latest.mainMoney) || 0) - (parseFloat(prev.mainMoney) || 0);
    }, [historyData]);

    // 成交量（展开主力资金时成交量图被隐藏，需在表头补充显示）真实数值与 diff 值，单位亿
    const latestVolumeValue = useMemo(() => {
        if (historyData.length === 0) return null;
        const last = historyData[historyData.length - 1][1];
        const v = last.amountChangeDiff;
        return v != null && v !== '' ? parseFloat(v) : null;
    }, [historyData]);

    const volumeDiffValue = useMemo(() => {
        if (historyData.length < 2) return null;
        const latest = historyData[historyData.length - 1][1];
        const prev = historyData[historyData.length - 2][1];
        return (parseFloat(latest.amountChangeDiff) || 0) - (parseFloat(prev.amountChangeDiff) || 0);
    }, [historyData]);

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
                    isImportant: item.isImportant,
                    color: colorMap[statusKey],
                    bgColor: bgMap[statusKey],
                    statusKey,
                    changeValue: change,
                    change: `${change > 0 ? '+' : ''}${change}%`,
                    label: change > 0 ? '幅度大涨' : '幅度大跌',
                    desc: item.desc,
                    type: 'change',
                    aboveOpening: item.above_opening,
                    openPx: item.open_px,
                    closePx: item.close_px
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

        // 按开盘价分组
        const aboveOpeningList = changeList.filter(item => item.aboveOpening === true);
        const belowOpeningList = changeList.filter(item => item.aboveOpening !== true);

        // Calculate total change value
        const totalChangeValue = changeList.reduce((sum, item) => sum + item.changeValue, 0);

        // 按急速异动的幅度降序排序，幅度越大的在越前面
        waveList.sort((a, b) => {
            const aVal = parseFloat(a.change_diff);
            const bVal = parseFloat(b.change_diff);
            return Math.abs(bVal) - Math.abs(aVal);
        });

        return { waveList, changeList, aboveOpeningList, belowOpeningList, upCount, downCount, totalChangeValue };
    }, [data.unNormalStockList]);

    // 全量自选股数据（用于分区/合并/统计视图）
    const fullStockData = useMemo(() => {
        const allStocks = Array.isArray(visibleAllStockData) ? visibleAllStockData : [];
        const changeList = [];
        let upCount = 0;
        let downCount = 0;

        allStocks.forEach(item => {
            const change = item.change;
            const name = item.stockName || item.name;

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

            if (statusKey) {
                const aboveOpening = parseFloat(item.open_px) > 0 && parseFloat(item.close_px) >= parseFloat(item.open_px);
                changeList.push({
                    name,
                    code: item.code,
                    isImportant: item.isImportant,
                    color: colorMap[statusKey],
                    bgColor: bgMap[statusKey],
                    statusKey,
                    changeValue: change,
                    change: `${change > 0 ? '+' : ''}${change}%`,
                    label: change > 0 ? '幅度大涨' : '幅度大跌',
                    desc: item.desc,
                    type: 'change',
                    aboveOpening,
                    openPx: item.open_px,
                    closePx: item.close_px,
                });
            }
        });

        changeList.sort((a, b) => b.changeValue - a.changeValue);

        const aboveOpeningList = changeList.filter(item => item.aboveOpening === true);
        const belowOpeningList = changeList.filter(item => item.aboveOpening !== true);
        // 小于开盘价分组按跌幅从高到低排序
        belowOpeningList.sort((a, b) => a.changeValue - b.changeValue);

        const totalChangeValue = changeList.reduce((sum, item) => sum + item.changeValue, 0);

        return { changeList, aboveOpeningList, belowOpeningList, upCount, downCount, totalChangeValue };
    }, [visibleAllStockData]);

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
                                type: 'success',
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

    const handleRefreshStockData = async () => {
        setRefreshingStockData(true);
        try {
            await axios.post(`http://${local_ip}:3000/refresh_monitor_stock_data`);
            await fetchData();
            message.success('自选股数据已刷新');
        } catch (error) {
            console.error('Refresh stock data failed:', error);
            message.error('刷新失败，请稍后重试');
        } finally {
            setRefreshingStockData(false);
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

    // 获取自选股主力资金净流入：10:00 前每 10s 轮询，10:00 后每 1min 轮询，收盘/周末停止
    const fetchWatchlistMainFund = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_watchlist_main_fund`);
            const list = response.data || [];
            const map = {};
            list.forEach(item => {
                if (item && item.code) map[item.code] = item.mainFund;
            });
            setWatchlistMainFund(map);
        } catch (error) {
            console.error('Fetch watchlist main fund failed:', error);
        }
    };

    const fetchRiHanData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/rihan_data`);
            if (response.data && Array.isArray(response.data)) {
                setRihanData(response.data);
            }
        } catch (error) {
            console.error('Fetch rihan data failed:', error);
        }
    };

    const refreshRihanData = async () => {
        try {
            await axios.post(`http://${local_ip}:3000/refresh_rihan_data`);
            await fetchRiHanData();
        } catch (error) {
            console.error('Refresh rihan data failed:', error);
        }
    };

    const fetchJigouReports = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_jigou_reports`);
            if (response.data && response.data.reports) {
                setJigouReports(response.data.reports);
            }
        } catch (error) {
            console.error('Fetch jigou reports failed:', error);
        }
    };

    // 拉取近期研报（近5天），用于研报视图展示
    const fetchRecentResearchReports = async () => {
        if (researchReportsLoading || researchReportsLoaded) return;
        setResearchReportsLoading(true);
        try {
            const researchResponse = await axios.get(`http://${local_ip}:3000/get_research_reports`);
            const researchTree = researchResponse.data || [];
            const allReports = collectAllResearchReports(researchTree);

            const fiveDaysAgo = dayjs().subtract(5, 'day');
            const recentReports = allReports.filter(report => {
                const match = report.folderPath?.match(/(\d{8})/);
                if (!match) return false;
                const reportDate = dayjs(match[1], 'YYYYMMDD');
                return reportDate.isAfter(fiveDaysAgo);
            });

            const batchSize = 10;
            const fullContentReports = [];
            for (let i = 0; i < recentReports.length; i += batchSize) {
                const batch = recentReports.slice(i, i + batchSize);
                const batchResults = await Promise.all(
                    batch.map(async (report) => {
                        try {
                            const contentResponse = await axios.get(`http://${local_ip}:3000/get_research_report`, {
                                params: { id: report.id }
                            });
                            return { ...report, content: contentResponse.data?.content || '' };
                        } catch (e) {
                            return { ...report, content: '' };
                        }
                    })
                );
                fullContentReports.push(...batchResults);
            }
            setRecentResearchReports(fullContentReports);
            setResearchReportsLoaded(true);
        } catch (error) {
            console.error('拉取近期研报失败:', error);
            message.error('拉取近期研报失败');
        } finally {
            setResearchReportsLoading(false);
        }
    };

    const getLastNDistinct = (history, field, n = 3) => {
        const distinct = [];
        let lastValue = null;
        let hasFirstValue = false;

        for (let i = history.length - 1; i >= 0 && distinct.length < n; i--) {
            const currentValue = history[i][field];
            if (!hasFirstValue) {
                distinct.unshift(history[i]);
                lastValue = currentValue;
                hasFirstValue = true;
            } else if (currentValue !== lastValue) {
                distinct.unshift(history[i]);
                lastValue = currentValue;
            }
        }

        return distinct;
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
                            // setTimeout(() => {
                            //     window.alert('🚨 高级风险预警：主力资金呈现净流出加速态势！\n\n当前净流出：' + mainMoney + ' 亿\n建议：市场承压严重，请操作者适度减仓，并且今天不要再做任何操作，严格控制风险！');
                            // }, 100);
                        }
                    }
                    return newHistory;
                });

                let triggerAlert = null;

                // 1. 趋势判断
                setAmountHistory(prev => {
                    const newHistory = [...prev, normalizedInfo].slice(-15); // 保留最近15次供去重使用

                    if (newHistory.length >= 3) {
                        // 获取去重后的最近3个点
                        const moneyDistinct = getLastNDistinct(newHistory, 'mainMoney', 3);
                        const amountDistinct = getLastNDistinct(newHistory, 'amountChangeDiff', 3);
                        const szDistinct = getLastNDistinct(newHistory, 'szPrice', 3);
                        const kcDistinct = getLastNDistinct(newHistory, 'kcPrice', 3);
                        const cyDistinct = getLastNDistinct(newHistory, 'cyPrice', 3);

                        const [h1, h2, h3] = newHistory;

                        // 资金趋势（使用去重后的数据）
                        const isMainMoneyIncreasing = moneyDistinct.length >= 3 &&
                            moneyDistinct[2].mainMoney > moneyDistinct[1].mainMoney &&
                            moneyDistinct[1].mainMoney > moneyDistinct[0].mainMoney;
                        const isMainMoneyDecreasing = moneyDistinct.length >= 3 &&
                            moneyDistinct[2].mainMoney < moneyDistinct[1].mainMoney &&
                            moneyDistinct[1].mainMoney < moneyDistinct[0].mainMoney;

                        // 成交量趋势（使用去重后的数据）
                        const isAmountIncreasing = amountDistinct.length >= 3 &&
                            amountDistinct[2].amountChangeDiff > amountDistinct[1].amountChangeDiff &&
                            amountDistinct[1].amountChangeDiff > amountDistinct[0].amountChangeDiff;
                        const isAmountDecreasing = amountDistinct.length >= 3 &&
                            amountDistinct[2].amountChangeDiff < amountDistinct[1].amountChangeDiff &&
                            amountDistinct[1].amountChangeDiff < amountDistinct[0].amountChangeDiff;

                        // 指数价格趋势 (以上证指数为基准，使用去重后的数据)
                        const isPriceIncreasing = szDistinct.length >= 3 &&
                            szDistinct[2].szPrice > szDistinct[1].szPrice &&
                            szDistinct[1].szPrice > szDistinct[0].szPrice;
                        const isPriceDecreasing = szDistinct.length >= 3 &&
                            szDistinct[2].szPrice < szDistinct[1].szPrice &&
                            szDistinct[1].szPrice < szDistinct[0].szPrice;

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

                        // 量价背离检测（诱多/诱空）
                        // 诱多：资金持续净流出（增加或不变）+ 科创板/创业板分时上涨
                        const isContinuousOutflow = moneyDistinct.length >= 3 &&
                            moneyDistinct[2].mainMoney <= moneyDistinct[1].mainMoney &&
                            moneyDistinct[1].mainMoney <= moneyDistinct[0].mainMoney;
                        const isKeChuangRising = kcDistinct.length >= 3 &&
                            kcDistinct[2].kcPrice > kcDistinct[1].kcPrice;
                        const isChuangYeBanRising = cyDistinct.length >= 3 &&
                            cyDistinct[2].cyPrice > cyDistinct[1].cyPrice;

                        if (isContinuousOutflow && (isKeChuangRising || isChuangYeBanRising)) {
                            const risingBoards = [];
                            if (isKeChuangRising) risingBoards.push('科创板');
                            if (isChuangYeBanRising) risingBoards.push('创业板');
                            checkAndSendDivergenceNotification('bullTrap', risingBoards);
                        }

                        // 诱空：资金持续净流入（增加或不变）+ 科创板/创业板分时下跌
                        const isContinuousInflow = moneyDistinct.length >= 3 &&
                            moneyDistinct[2].mainMoney >= moneyDistinct[1].mainMoney &&
                            moneyDistinct[1].mainMoney >= moneyDistinct[0].mainMoney;
                        const isKeChuangFalling = kcDistinct.length >= 3 &&
                            kcDistinct[2].kcPrice < kcDistinct[1].kcPrice;
                        const isChuangYeBanFalling = cyDistinct.length >= 3 &&
                            cyDistinct[2].cyPrice < cyDistinct[1].cyPrice;

                        if (isContinuousInflow && (isKeChuangFalling || isChuangYeBanFalling)) {
                            const fallingBoards = [];
                            if (isKeChuangFalling) fallingBoards.push('科创板');
                            if (isChuangYeBanFalling) fallingBoards.push('创业板');
                            checkAndSendDivergenceNotification('bearTrap', fallingBoards);
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

    const fetchHistoryData = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/amount_history`);
            setHistoryData(filterTradingSessionHistoryData(response.data));
        } catch (err) {
            console.error('Fetch history data failed:', err);
        }
    };

    const handleCopyContext = async () => {
        setCopyContextLoading(true);
        const msgKey = 'copy-context';
        try {
            message.loading({ content: '正在拉取历史复盘与分时数据...', key: msgKey, duration: 0 });
            const { charCount, dateCount } = await fetchAndCopyContext({
                historyData,
                onProgress: (done, total) => {
                    message.loading({ content: `正在拉取历史数据 ${done}/${total}...`, key: msgKey, duration: 0 });
                },
            });
            message.success({
                content: `已复制复盘上下文（${dateCount} 个历史日期，约 ${(charCount / 1024).toFixed(1)} KB），可直接粘贴给 AI`,
                key: msgKey,
                duration: 4,
            });
        } catch (e) {
            console.error('复制上下文失败:', e);
            message.error({ content: '复制上下文失败：' + (e?.message || '未知错误'), key: msgKey, duration: 4 });
        } finally {
            setCopyContextLoading(false);
        }
    };

    const fetchBlockHistory = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/block_history`);
            const newData = response.data;

            // 对比上一次的数据，检测异动
            if (prevBlockHistoryRef.current && newData.length > 0) {
                const prevData = prevBlockHistoryRef.current;
                const latestNewData = newData[newData.length - 1];
                const latestPrevData = prevData.length > 0 ? prevData[prevData.length - 1] : null;

                if (latestPrevData && latestNewData) {
                    const newAlerts = [];

                    latestNewData.blockData.forEach(newBlock => {
                        const prevBlock = latestPrevData.blockData.find(b => b.blockName === newBlock.blockName);
                        if (prevBlock) {
                            const change = newBlock.avgChange - prevBlock.avgChange;
                            if (Math.abs(change) > 0.3) {
                                newAlerts.push({
                                    id: `${newBlock.blockName}-${Date.now()}`,
                                    blockName: newBlock.blockName,
                                    prevChange: prevBlock.avgChange,
                                    newChange: newBlock.avgChange,
                                    changeDiff: change,
                                    time: dayjs().format('HH:mm:ss'),
                                    type: change > 0 ? 'up' : 'down'
                                });
                            }
                        }
                    });

                    // 直接替换掉旧的告警，只显示当前这次轮询到的异动数据
                    setBlockAlerts(newAlerts);
                }
            }

            prevBlockHistoryRef.current = newData;
            setBlockHistoryData(newData);
        } catch (err) {
            console.error('Fetch block history data failed:', err);
        }
    };

    const fetchBlockMoneyChange = async () => {
        try {
            const response = await axios.get(`http://${local_ip}:3000/get_block_money_change`);
            const data = response.data || [];
            // 筛选目标板块
            const filteredData = data.filter(item => targetBlocks.includes(item.block));
            // 按照资金从大到小排序（流入最大的排前面，流出最大的排后面）
            const sortedData = [...filteredData].sort((a, b) => b.money - a.money);

            // 对比上一次数据，计算大幅流入/流出
            const prevMap = prevBlockMoneyRef.current;
            if (prevMap) {
                const alerts = [];
                sortedData.forEach((item) => {
                    const prevMoney = prevMap.get(item.block);
                    if (prevMoney !== undefined) {
                        const diff = item.money - prevMoney;
                        if (Math.abs(diff) >= BLOCK_MONEY_BIG_CHANGE_THRESHOLD) {
                            alerts.push({
                                block: item.block,
                                diff,
                                type: diff > 0 ? 'inflow' : 'outflow',
                            });
                        }
                    }
                });
                alerts.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
                setBlockMoneyAlerts(alerts);
            }
            // 保存本次数据供下次对比
            const currentMap = new Map();
            sortedData.forEach((item) => {
                currentMap.set(item.block, item.money);
            });
            prevBlockMoneyRef.current = currentMap;

            setBlockMoneyData(sortedData);
        } catch (err) {
            console.error('Fetch block money change data failed:', err);
        }
    };

    const createBaseChart = (container) => {
        return createChart(container, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#6b7890',
                fontSize: 11,
            },
            width: container.clientWidth,
            height: container.clientHeight || 220,
            grid: {
                vertLines: { color: 'rgba(18, 33, 58, 0.05)' },
                horzLines: { color: 'rgba(18, 33, 58, 0.05)' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: 'rgba(18, 33, 58, 0.08)',
                tickMarkFormatter: (time) => {
                    return dayjs.unix(time).format('HH:mm');
                },
            },
            localization: {
                timeFormatter: (time) => {
                    return dayjs.unix(time).format('HH:mm');
                },
            },
            rightPriceScale: {
                borderColor: 'rgba(18, 33, 58, 0.08)',
                autoScale: true,
                scaleMargins: { top: 0.12, bottom: 0.12 },
            },
            handleScroll: false,
            handleScale: false,
        });
    };

    const aggregateData = (data, field) => {
        const sortedData = [...data].sort((a, b) => a[0].localeCompare(b[0]));
        const aggregated = [];
        const groupSize = 10;

        for (let i = 0; i < sortedData.length; i += groupSize) {
            const group = sortedData.slice(i, i + groupSize);
            const values = group.map(item => parseFloat(item[1][field]) || 0);
            const sum = values.reduce((acc, val) => acc + val, 0);
            const avg = sum / group.length;
            const firstTime = group[0][0];
            aggregated.push([firstTime, avg]);
        }

        return aggregated;
    };

    const mainMoneySeriesRef = useRef(null);
    const volumeSeriesRef = useRef(null);
    const cybOverlaySeriesRef = useRef(null);   // 主力资金图上叠加的创业板分时（紫色虚线）
    const kcbOverlaySeriesRef = useRef(null);   // 主力资金图上叠加的科创板分时（橙色虚线）
    const indexOverlayRef = useRef({ cyb: [], kcb: [] }); // 今日指数分时 {time, value} 序列

    const buildIndexOverlayData = (tline) => {
        if (!tline || !Array.isArray(tline.line)) return [];
        const today = dayjs().format('YYYY-MM-DD');
        const formatted = tline.line
            .filter(item => item && item.minute && item.change != null)
            .map(item => {
                const minStr = String(item.minute).padStart(4, '0');
                const hh = minStr.substring(0, 2);
                const mm = minStr.substring(2, 4);
                return {
                    time: dayjs(`${today} ${hh}:${mm}`).unix(),
                    value: parseFloat(item.change) || 0,
                };
            });
        formatted.sort((a, b) => a.time - b.time);
        const deduped = [];
        for (let i = 0; i < formatted.length; i++) {
            if (i === 0 || formatted[i].time !== deduped[deduped.length - 1].time) {
                deduped.push(formatted[i]);
            } else {
                deduped[deduped.length - 1] = formatted[i];
            }
        }
        return deduped;
    };

    const fetchIndexOverlay = async () => {
        try {
            const res = await axios.get(`http://${local_ip}:3000/fupan/index_tline?date=${dayjs().format('YYYYMMDD')}`);
            const data = res.data?.data;
            if (!data) return;
            indexOverlayRef.current = {
                cyb: buildIndexOverlayData(data.chuangyeban),
                kcb: buildIndexOverlayData(data.kechuangban),
            };
            cybOverlaySeriesRef.current?.setData(indexOverlayRef.current.cyb);
            kcbOverlaySeriesRef.current?.setData(indexOverlayRef.current.kcb);
        } catch (e) {
            // 忽略指数分时获取失败
        }
    };

    const initMainMoneyChart = (data) => {
        if (!mainMoneyContainerRef.current) return;

        const chart = createBaseChart(mainMoneyContainerRef.current);
        mainMoneyChartRef.current = chart;

        const series = chart.addLineSeries({
            color: '#f5222d',
            lineWidth: 2,
            priceFormat: {
                type: 'price',
                precision: 0,
                minMove: 1,
            },
        });
        mainMoneySeriesRef.current = series;

        // 叠加创业板分时（紫色虚线）与科创板分时（橙色虚线），共用顶部独立价格刻度
        cybOverlaySeriesRef.current = chart.addLineSeries({
            color: '#722ed1',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            priceScaleId: 'index',
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        kcbOverlaySeriesRef.current = chart.addLineSeries({
            color: '#fa8c16',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            priceScaleId: 'index',
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        });
        chart.priceScale('index').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.05 } });
        cybOverlaySeriesRef.current.setData(indexOverlayRef.current.cyb);
        kcbOverlaySeriesRef.current.setData(indexOverlayRef.current.kcb);

        const today = dayjs().format('YYYY-MM-DD');
        const aggregatedData = aggregateData(data, 'mainMoney');

        const chartData = aggregatedData.map(([time, avg]) => {
            const hh = time.substring(0, 2);
            const mm = time.substring(2, 4);
            const ss = time.substring(4, 6);
            return {
                time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(),
                value: avg,
            };
        });

        series.setData(chartData);
        series.createPriceLine({ price: -100, color: 'red', lineStyle: LineStyle.Dashed });
        chart.timeScale().fitContent();
    };

    const initVolumeChart = (data) => {
        if (!volumeContainerRef.current) return;

        const chart = createBaseChart(volumeContainerRef.current);
        volumeChartRef.current = chart;

        const series = chart.addLineSeries({
            color: getThemeColor(),
            lineWidth: 2,
            priceFormat: {
                type: 'price',
                precision: 0,
                minMove: 1,
            },
        });
        volumeSeriesRef.current = series;

        const today = dayjs().format('YYYY-MM-DD');
        const aggregatedData = aggregateData(data, 'amountChangeDiff');

        const chartData = aggregatedData.map(([time, avg]) => {
            const hh = time.substring(0, 2);
            const mm = time.substring(2, 4);
            const ss = time.substring(4, 6);
            return {
                time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(),
                value: avg,
            };
        });

        series.setData(chartData);
        chart.timeScale().fitContent();
    };

    const updateMainMoneyChart = (data) => {
        if (!mainMoneySeriesRef.current) return;

        const today = dayjs().format('YYYY-MM-DD');
        const aggregatedData = aggregateData(data, 'mainMoney');

        const chartData = aggregatedData.map(([time, avg]) => {
            const hh = time.substring(0, 2);
            const mm = time.substring(2, 4);
            const ss = time.substring(4, 6);
            return {
                time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(),
                value: avg,
            };
        });

        mainMoneySeriesRef.current.setData(chartData);
        cybOverlaySeriesRef.current?.setData(indexOverlayRef.current.cyb);
        kcbOverlaySeriesRef.current?.setData(indexOverlayRef.current.kcb);
        if (mainMoneyChartRef.current) {
            mainMoneyChartRef.current.timeScale().fitContent();
        }
    };

    const updateVolumeChart = (data) => {
        if (!volumeSeriesRef.current) return;

        const today = dayjs().format('YYYY-MM-DD');
        const aggregatedData = aggregateData(data, 'amountChangeDiff');

        const chartData = aggregatedData.map(([time, avg]) => {
            const hh = time.substring(0, 2);
            const mm = time.substring(2, 4);
            const ss = time.substring(4, 6);
            return {
                time: dayjs(`${today} ${hh}:${mm}:${ss}`).unix(),
                value: avg,
            };
        });

        volumeSeriesRef.current.setData(chartData);
        if (volumeChartRef.current) {
            volumeChartRef.current.timeScale().fitContent();
        }
    };

    useEffect(() => {
        if (historyData.length > 0) {
            if (!mainMoneyChartRef.current) {
                initMainMoneyChart(historyData);
            } else {
                updateMainMoneyChart(historyData);
            }
            if (!volumeChartRef.current) {
                initVolumeChart(historyData);
            } else {
                updateVolumeChart(historyData);
            }
        }
    }, [historyData]);

    // 处理窗口缩放和展开/收起
    useEffect(() => {
        const handleResize = () => {
            if (mainMoneyChartRef.current && mainMoneyContainerRef.current) {
                mainMoneyChartRef.current.applyOptions({
                    width: mainMoneyContainerRef.current.clientWidth,
                    height: mainMoneyContainerRef.current.clientHeight,
                });
                mainMoneyChartRef.current.timeScale().fitContent();
            }
            if (volumeChartRef.current && volumeContainerRef.current) {
                volumeChartRef.current.applyOptions({ width: volumeContainerRef.current.clientWidth });
                volumeChartRef.current.timeScale().fitContent();
            }
        };

        window.addEventListener('resize', handleResize);

        // 展开/收起时也触发 resize
        const resizeTimer = setTimeout(handleResize, 150);

        return () => {
            window.removeEventListener('resize', handleResize);
            clearTimeout(resizeTimer);
        };
    }, [isMainMoneyExpanded, isWatchlistCollapsed]);

    // 折叠/展开自选股时，清理并重新初始化图表（因为DOM位置变化）
    useEffect(() => {
        // 跳过首次挂载，避免初始化时就清理
        if (!isWatchlistCollapseInitialized.current) {
            isWatchlistCollapseInitialized.current = true;
            return;
        }

        // 清理旧图表
        const cleanupCharts = () => {
            try {
                if (mainMoneyChartRef.current) {
                    mainMoneyChartRef.current.remove();
                    mainMoneyChartRef.current = null;
                    mainMoneySeriesRef.current = null;
                    cybOverlaySeriesRef.current = null;
                    kcbOverlaySeriesRef.current = null;
                }
            } catch (e) { /* ignore */ }
            try {
                if (volumeChartRef.current) {
                    volumeChartRef.current.remove();
                    volumeChartRef.current = null;
                    volumeSeriesRef.current = null;
                }
            } catch (e) { /* ignore */ }
        };

        cleanupCharts();

        // DOM更新后重新初始化图表
        const reinitTimer = setTimeout(() => {
            if (historyData.length > 0) {
                if (mainMoneyContainerRef.current && !mainMoneyChartRef.current) {
                    initMainMoneyChart(historyData);
                }
                if (volumeContainerRef.current && !volumeChartRef.current) {
                    initVolumeChart(historyData);
                }
            }
        }, 150);

        return () => {
            clearTimeout(reinitTimer);
        };
    }, [isWatchlistCollapsed]);

    useEffect(() => {
        fetchData();
        fetchAmountData();
        fetchEmotionData();
        fetchJisuYidongRank();
        fetchHistoryData();
        fetchIndexOverlay();
        fetchRiHanData();
        fetchBlockHistory();
        fetchBlockMoneyChange();
        fetchJigouReports();
        fetchRecentResearchReports();
        fetchWatchlistMainFund();

        const timers = [];

        const schedulePoll = (callback, delay) => {
            const timer = setTimeout(() => {
                if (!isAfterMarketClose()) {
                    callback();
                    schedulePoll(callback, delay);
                }
            }, delay);
            timers.push(timer);
            return timer;
        };

        schedulePoll(fetchData, 5000);
        schedulePoll(fetchAmountData, 10000);
        schedulePoll(fetchJisuYidongRank, 3000);
        schedulePoll(fetchHistoryData, 10000);
        schedulePoll(fetchIndexOverlay, 30000);
        schedulePoll(fetchRiHanData, 3000);
        schedulePoll(fetchBlockHistory, 3000);
        schedulePoll(fetchBlockMoneyChange, 3000);
        schedulePoll(fetchJigouReports, 60000);

        // 自选股主力资金：10:00 前每 10s，10:00 后每 1min；收盘(14:59)/非交易日（周末/节假日，以交易日历为准）停止，盘前每分钟探测是否开盘
        const scheduleMainFundPoll = () => {
            const t = dayjs();
            if (!isTradingDay(t)) return;
            const timeVal = t.hour() * 100 + t.minute();
            if (timeVal >= 1459) return;
            const inTrading = timeVal >= 915;
            const delay = inTrading ? (timeVal < 1000 ? 10000 : 60000) : 60000;
            const timer = setTimeout(() => {
                if (inTrading) fetchWatchlistMainFund();
                scheduleMainFundPoll();
            }, delay);
            timers.push(timer);
        };
        scheduleMainFundPoll();

        return () => {
            timers.forEach(clearTimeout);
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

    const kaiPanXiaCuoWarning = useMemo(() => {
        if (data.kaiPanXiaCuoData && data.kaiPanXiaCuoData.length >= 10) {
            return `今天市场开盘快速下挫，大部分股票开盘兑现较为剧烈，建议今天不要有任何操作。`;
        }
        return null;
    }, [data.kaiPanXiaCuoData]);

    const stockUpAlerts = stockData.waveList.filter(item => item.statusKey === 'highRed');
    const stockDownAlerts = stockData.waveList.filter(item => item.statusKey !== 'highRed');
    const blockUpAlerts = blockAlerts.filter(item => item.type === 'up');
    const blockDownAlerts = blockAlerts.filter(item => item.type !== 'up');

    // 密码门禁：仅交易日的交易时段（9:15-11:30、13:00-15:00）需要解锁，其余时间直接放行
    // （所有 Hook 已在上方执行完毕，早退安全；数据轮询会持续触发重渲染，跨时段后条件自动重新生效）
    if ((!unlocked && isWithinTradingHours()) && false) {
        return (
            <div className="dingpan-container">
                <div className="dingpan-password-gate">
                    <div className="password-gate-card">
                        <div className="password-gate-icon"><LockOutlined /></div>
                        <div className="password-gate-title">市场盯盘</div>
                        <div className="password-gate-subtitle">请输入访问密码以查看监控内容</div>
                        <Input.Password
                            autoFocus
                            placeholder="请输入密码"
                            value={passwordInput}
                            status={passwordError ? 'error' : ''}
                            onChange={(e) => { setPasswordInput(e.target.value); setPasswordError(false); }}
                            onPressEnter={handleUnlockSubmit}
                        />
                        {passwordError && <div className="password-gate-error">密码错误，请重新输入</div>}
                        <Button type="primary" block onClick={handleUnlockSubmit}>解锁</Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="dingpan-container" onDoubleClick={handlePageDoubleClick}>
            <TopGlobalAlerts
                alerts={alerts}
                marketRiskWarning={marketRiskWarning}
                kaiPanXiaCuoWarning={kaiPanXiaCuoWarning}
                onCloseAlert={(id) => setAlerts(prev => prev.filter(a => a.id !== id))}
                themeColor={themeColor}
            />
            <PageMeta
                lastUpdated={lastUpdated}
                historyCount={history.length}
                onHistoryClick={() => setIsModalOpen(true)}
                onOpenThemeColor={() => setThemeColorModalVisible(true)}
            />

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
                    <Spin size="large" tip="正在初始化实时监控数据..." />
                </div>
            ) : (
                <>
                    <Row gutter={[24, 24]}>
                        {/* 左侧主要监控区 */}
                        <Col xs={24} lg={17}>
                            {/* 抢筹与拉升模块 */}
                            <OpeningBattleCards
                                jingJiaQiangChouData={data.jingJiaQiangChouData}
                                kaiPanZhuDongData={data.kaiPanZhuDongData}
                                kaiPanXiaCuoData={data.kaiPanXiaCuoData}
                                showJingJiaQiangChou={showJingJiaQiangChou}
                                showKaiPanZhuDong={showKaiPanZhuDong}
                                showKaiPanXiaCuo={showKaiPanXiaCuo}
                                emotionSuggestion={emotionSuggestion}
                                onCloseJingJia={() => setShowJingJiaQiangChou(false)}
                                onCloseKaiPanZhuDong={() => setShowKaiPanZhuDong(false)}
                                onCloseKaiPanXiaCuo={() => setShowKaiPanXiaCuo(false)}
                                onStockClick={showKLine}
                                themeColor={themeColor}
                            />
                            {/* 个股异动监控（含板块异动，置于涨跌幅前十上方） */}
                            <Row gutter={[16, 16]} style={{ marginBottom: 12 }}>
                                <Col xs={24} lg={SHOW_BLOCK_ALERT_MONITOR ? 12 : 24}>
                                    <StockAlertCard
                                        stockUpAlerts={stockUpAlerts}
                                        stockDownAlerts={stockDownAlerts}
                                        waveList={stockData.waveList}
                                        onStockClick={showKLine}
                                        bodyHeight="200px"
                                        itemsPerRow={SHOW_BLOCK_ALERT_MONITOR ? 1 : 2}
                                        themeColor={themeColor}
                                    />
                                </Col>
                                {/* 板块异动监控 */}
                                {SHOW_BLOCK_ALERT_MONITOR && (
                                <Col xs={24} lg={12}>
                                    <BlockAlertCard
                                        blockAlerts={blockAlerts}
                                        blockUpAlerts={blockUpAlerts}
                                        blockDownAlerts={blockDownAlerts}
                                        onBlockClick={jumpToBlock}
                                        themeColor={themeColor}
                                    />
                                </Col>
                                )}
                            </Row>

                            {/* 板块涨跌幅前十 - 左右布局（展开时在左侧，折叠时移动到右侧自选股监控下方） */}
                            {!isWatchlistCollapsed && (
                            <BlockRankingCards
                                topAndBottomBlockData={data.topAndBottomBlockData}
                                onBlockClick={jumpToBlock}
                                renderBlockStockList={renderBlockStockList}
                                themeColor={themeColor}
                            />
                            )}

                            {/* 首页常驻叠加分时模块 */}
                            <OverlayTimelineSection
                                overlayInlineAddStock={overlayInlineAddStock}
                                onStockClick={showKLine}
                                sectionRef={overlayTimelineSectionRef}
                                themeColor={themeColor}
                            />

                            {/* 主力资金趋势监控（全宽，左右结构） - 置于叠加分时图下方、个股幅度异动上方 */}
                            <MainMoneyCharts
                                isMainMoneyExpanded={isMainMoneyExpanded}
                                onToggleExpand={() => setIsMainMoneyExpanded(!isMainMoneyExpanded)}
                                moneyStatus={moneyStatus}
                                volumeStatus={volumeStatus}
                                latestMoneyValue={latestMoneyValue}
                                latestVolumeValue={latestVolumeValue}
                                volumeDiffValue={volumeDiffValue}
                                mainMoneyContainerRef={mainMoneyContainerRef}
                                volumeContainerRef={volumeContainerRef}
                                themeColor={themeColor}
                                historyData={historyData}
                                onCopyContext={handleCopyContext}
                                copyContextLoading={copyContextLoading}
                                style={{ marginTop: 12 }}
                            />

                            {/* 个股异动监控区 */}
                            <StockChangeMonitor
                                stockViewMode={stockViewMode}
                                onStockViewModeChange={(mode) => { setStockViewMode(mode); localStorage.setItem('dingpan_stockViewMode', mode); }}
                                stockData={stockData}
                                fullStockData={fullStockData}
                                marketRiskWarning={marketRiskWarning}
                                reportStockData={reportStockData}
                                researchReportsLoading={researchReportsLoading}
                                researchReportsLoaded={researchReportsLoaded}
                                allStockData={visibleAllStockData}
                                watchlistMainFund={watchlistMainFund}
                                onStockClick={showKLine}
                                onOpenOverlayTimeLine={handleOpenOverlayTimeLine}
                                onViewYanbaoDetail={handleViewYanbaoDetail}
                                onRefresh={handleRefreshStockData}
                                refreshing={refreshingStockData}
                                themeColor={themeColor}
                            />

                        </Col>

                        {/* 右侧独立列：自选股全量监控 */}
                        <Col xs={24} lg={7}>
                            {/* 板块资金监控 */}
                            <BlockMoneyMonitor
                                blockMoneyData={blockMoneyData}
                                blockMoneyAlerts={blockMoneyAlerts}
                                displayBlocks={displayBlocks}
                                onBlockClick={jumpToBlock}
                                onViewMore={() => navigate('/block?tab=money')}
                                themeColor={themeColor}
                            />

                            {/* 日韩涨跌监控（自选股展开时在其上方，折叠时移到自选股下方） */}
                            {!isWatchlistCollapsed && (
                                <div ref={rihanSectionRef}>
                                    <RihanMonitor rihanData={rihanData} themeColor={themeColor} onRefresh={refreshRihanData} />
                                </div>
                            )}

                            {/* 自选股全量监控 */}
                            <WatchlistMonitor
                                isWatchlistCollapsed={isWatchlistCollapsed}
                                onToggleCollapse={setIsWatchlistCollapsed}
                                allStockOverview={allStockOverview}
                                searchQuery={searchQuery}
                                setSearchQuery={setSearchQuery}
                                refreshingStockData={refreshingStockData}
                                onRefresh={handleRefreshStockData}
                                onAddStock={() => setAddStockModalVisible(true)}
                                showOnlyImportant={showOnlyImportant}
                                setShowOnlyImportant={setShowOnlyImportant}
                                sortOrder={sortOrder}
                                sortField={sortField}
                                onSortChange={handleSortChange}
                                showOnlyGoodNews={showOnlyGoodNews}
                                setShowOnlyGoodNews={setShowOnlyGoodNews}
                                filteredAllStockData={filteredAllStockData}
                                watchlistMainFund={watchlistMainFund}
                                hasGoodNews={hasGoodNews}
                                onViewGoodNews={handleViewGoodNews}
                                onStockClick={showKLine}
                                onToggleImportant={handleToggleImportant}
                                onDeleteStock={handleDeleteStock}
                                onToggleStockTop={handleToggleStockTop}
                                onBuyPointDiagnosis={handleBuyPointDiagnosis}
                                onLogicExplore={handleLogicExplore}
                                onOpenOverlayTimeLine={handleOpenOverlayTimeLine}
                                onBacktest={(stock) => navigate(`/stock_diagnosis?backtest=1&code=${encodeURIComponent(stock.code)}&name=${encodeURIComponent(stock.stockName || '')}`)}
                                onRename={handleOpenRenameModal}
                                onTempHideStock={handleOpenTempHideModal}
                                themeColor={themeColor}
                            />
                            {isWatchlistCollapsed && (
                                <div ref={rihanSectionRef}>
                                    <RihanMonitor rihanData={rihanData} themeColor={themeColor} onRefresh={refreshRihanData} />
                                </div>
                            )}
                            {isWatchlistCollapsed && (
                                <div style={{ marginBottom: 24 }}>
                                    <BlockRankingCards
                                        topAndBottomBlockData={data.topAndBottomBlockData}
                                        onBlockClick={jumpToBlock}
                                        renderBlockStockList={renderBlockStockList}
                                        themeColor={themeColor}
                                        vertical
                                    />
                                </div>
                            )}

                            {/* 当前自选股个股涨跌幅前十：位于涨跌幅前十与指数叠加分时之间 */}
                            {isWatchlistCollapsed && (
                                <div style={{ marginBottom: 16 }}>
                                    <WatchlistTopRanking
                                        stocks={visibleAllStockData}
                                        onStockClick={showKLine}
                                        onOpenOverlayTimeLine={handleOpenOverlayTimeLine}
                                        themeColor={themeColor}
                                    />
                                </div>
                            )}

                            {/* 指数叠加分时模块 */}
                            <div style={{ marginTop: 16 }}>
                                <IndexOverlayTline 
                                    onTitleClick={() => setIndexOverlayFullscreenVisible(true)}
                                />
                            </div>
                        </Col>
                    </Row>
                </>
            )}

            {/* 异动历史弹窗 */}
            <HistoryModal
                open={isModalOpen}
                onCancel={() => setIsModalOpen(false)}
                history={history}
                jisuYidongUpList={jisuYidongUpList}
                jisuYidongDownList={jisuYidongDownList}
                onStockClick={showKLine}
                themeColor={themeColor}
            />

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

            {/* 利好消息弹窗 */}
            <GoodNewsModal
                open={showGoodNewsModal}
                onCancel={() => setShowGoodNewsModal(false)}
                currentGoodNewsStock={currentGoodNewsStock}
                matchedReports={matchedReports}
                highlightStockName={highlightStockName}
                themeColor={themeColor}
            />

            {/* 逻辑探查弹窗 */}
            <LogicExploreModal
                open={showLogicExploreModal}
                onCancel={() => setShowLogicExploreModal(false)}
                logicExploreStock={logicExploreStock}
                logicExploreLoading={logicExploreLoading}
                jigouMatchedReports={jigouMatchedReports}
                researchMatchedReports={researchMatchedReports}
                highlightStockName={highlightStockName}
                themeColor={themeColor}
            />

            {/* 新增股票弹窗 */}
            <AddStockModal
                open={addStockModalVisible}
                onCancel={() => setAddStockModalVisible(false)}
                onOk={handleAddStock}
                newStockCode={newStockCode}
                setNewStockCode={setNewStockCode}
                newStockName={newStockName}
                setNewStockName={setNewStockName}
                newStockBlockName={newStockBlockName}
                setNewStockBlockName={setNewStockBlockName}
                newStockRiskScore={newStockRiskScore}
                setNewStockRiskScore={setNewStockRiskScore}
                newStockIsTech={newStockIsTech}
                setNewStockIsTech={setNewStockIsTech}
                themeColor={themeColor}
            />

            {/* 重命名股票弹窗 */}
            <RenameStockModal
                open={renameModalVisible}
                onCancel={() => setRenameModalVisible(false)}
                onOk={handleConfirmRename}
                renameStockCode={renameStockCode}
                renameStockName={renameStockName}
                setRenameStockName={setRenameStockName}
                themeColor={themeColor}
            />

            {/* 暂时隐藏股票弹窗 */}
            <TempHideStockModal
                open={tempHideModalVisible}
                openTs={tempHideOpenTs}
                onCancel={() => setTempHideModalVisible(false)}
                onOk={handleConfirmTempHide}
                stock={tempHideStock}
                hiddenStockMap={hiddenStockMap}
                onUnhide={handleUnhideStock}
            />

            {/* 指数叠加分时全屏弹窗 */}
            <IndexOverlayFullscreenModal
                open={indexOverlayFullscreenVisible}
                onCancel={() => setIndexOverlayFullscreenVisible(false)}
                themeColor={themeColor}
            />

            {/* 个股买点诊断弹窗 */}
            <BuyPointDiagnosisModal
                open={showBuyPointDiagnosisModal}
                onCancel={() => setShowBuyPointDiagnosisModal(false)}
                buyPointDiagnosisStock={buyPointDiagnosisStock}
                buyPointDiagnosisData={buyPointDiagnosisData}
                buyPointDiagnosisLoading={buyPointDiagnosisLoading}
                onRefresh={handleRefreshBuyPointDiagnosis}
                themeColor={themeColor}
            />

            {/* DIY 主题色设置弹窗 */}
            <ThemeColorModal
                open={themeColorModalVisible}
                onCancel={() => setThemeColorModalVisible(false)}
                onOk={handleSaveThemeColor}
                value={themeColor}
            />

            {/* 交易纪律悬浮组件（每个交易日 9:30-9:40 自动显示，fixed 布局，屏幕正中间，9:40 后自动隐藏） */}
            {/* 通过 Portal 挂载到 body，避免祖先 backdrop-filter 破坏 fixed 包含块导致跟随滚动 */}
            {disciplineModalVisible && false && createPortal(
                <div
                    style={{
                        position: 'fixed',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: 620,
                        zIndex: 1500,
                        background: '#ffffff',
                        border: '1px solid #ffa39e',
                        borderRadius: 12,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                        overflow: 'hidden',
                    }}
                >
                    <div style={{ background: '#fff1f0', padding: '12px 20px', borderBottom: '1px solid #ffa39e' }}>
                        <span style={{ color: '#cf1322', fontWeight: 700, fontSize: 16 }}>⚠️ 交易严格纪律（9:30 - 9:40）</span>
                    </div>
                    <div style={{ padding: '16px 20px', color: '#262626', fontSize: 14, lineHeight: 1.9 }}>
                        <div style={{ marginBottom: 12, color: '#8c8c8c', fontSize: 13 }}>
                            每个交易日 9:30 - 9:40 强制提醒，9:40 后自动关闭。
                        </div>
                        <div style={{ border: '1px solid #ffd666', borderRadius: 8, padding: '12px 16px', marginBottom: 10, background: '#fffbe6' }}>
                            <span style={{ color: '#cf1322', fontWeight: 700 }}>1. </span>
                            绝对不能在 9:40 之前买股票，一定要等到 9:40 之后看资金净流入 + 成交量放量再买。
                        </div>
                        <div style={{ border: '1px solid #ffd666', borderRadius: 8, padding: '12px 16px', marginBottom: 10, background: '#fffbe6' }}>
                            <span style={{ color: '#cf1322', fontWeight: 700 }}>2. </span>
                            新情绪周期的第一天大涨最好不要做，就算要做只能等待资金净流入 + 成交量放量的确认，第一天打一个底仓 1/3。
                        </div>
                        <div style={{ border: '1px solid #ffd666', borderRadius: 8, padding: '12px 16px', background: '#fffbe6' }}>
                            <span style={{ color: '#cf1322', fontWeight: 700 }}>3. </span>
                            实体大阴线之后，次日直接反弹的概率非常低，大概率是冲高回落/高开低走，不要参与。
                        </div>
                        <div style={{ border: '1px solid #ffd666', borderRadius: 8, padding: '12px 16px', background: '#fffbe6' }}>
                            <span style={{ color: '#cf1322', fontWeight: 700 }}>4. </span>
                            一定要买资金净流入的股票，不要光顾着看涨幅，而不顾资金当天是否为净流入的。
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

export default DingPan;
