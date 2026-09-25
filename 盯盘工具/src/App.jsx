import { useState, useEffect, useRef } from 'react';
import { Layout, Menu, Button, Modal, Badge, ColorPicker, Select, message, Tooltip } from 'antd';
import { DesktopOutlined, AppstoreOutlined, MenuFoldOutlined, MenuUnfoldOutlined, BookOutlined, CoffeeOutlined, StockOutlined, AreaChartOutlined, FileTextOutlined, CalendarOutlined, BarChartOutlined, GlobalOutlined, BellOutlined, AlertOutlined, ThunderboltOutlined, BgColorsOutlined, CheckOutlined, WarningOutlined, MinusOutlined, HistoryOutlined, RobotOutlined, RocketOutlined, TrophyOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from './constant';
import { getThemeColor } from './utils/theme';
import { isTradingDay, isAfterMarketClose, getNextTradingDay } from './utils/tradingDay';
import PreMarketReading from './components/PreMarketReading';
import TodayPlan from './components/TodayPlan';
import FloatingStockPosition from './components/FloatingStockPosition';
import FloatingMonitorAlarm from './components/FloatingMonitorAlarm';
import FloatingTechEmotion from './components/FloatingTechEmotion';
import FloatingStrategyCenter from './components/FloatingStrategyCenter';
import GlobalAnalysis from './components/GlobalAnalysis';
import MajorEventReminder from './components/MajorEventReminder';
import PersonalFeelingModal from './components/PersonalFeelingModal';
import ClosePipeline from './components/ClosePipeline';
import dayjs from 'dayjs';
import './App.scss';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Sider, Content, Header } = Layout;

// 主题色配置：10 个候选主题色
const THEME_COLORS = [
  {
    key: 'blue',
    name: '经典蓝',
    primary: '#1890ff',
    dark: '#096dd9',
    darker: '#0050b3',
    light: '#69c0ff',
    gradientStart: '#0d6efd',
    gradientMid: '#1677ff',
    gradientEnd: '#69b1ff',
    rgb: '22, 119, 255',
  },
  {
    key: 'purple',
    name: '梦幻紫',
    primary: '#722ed1',
    dark: '#531dab',
    darker: '#391085',
    light: '#b37feb',
    gradientStart: '#531dab',
    gradientMid: '#722ed1',
    gradientEnd: '#b37feb',
    rgb: '114, 46, 209',
  },
  {
    key: 'green',
    name: '森林绿',
    primary: '#52c41a',
    dark: '#389e0d',
    darker: '#237804',
    light: '#95de64',
    gradientStart: '#237804',
    gradientMid: '#52c41a',
    gradientEnd: '#b7eb8f',
    rgb: '82, 196, 26',
  },
  {
    key: 'red',
    name: '中国红',
    primary: '#f5222d',
    dark: '#cf1322',
    darker: '#a8071a',
    light: '#ff7875',
    gradientStart: '#a8071a',
    gradientMid: '#f5222d',
    gradientEnd: '#ff7875',
    rgb: '245, 34, 45',
  },
  {
    key: 'orange',
    name: '活力橙',
    primary: '#fa8c16',
    dark: '#d4380d',
    darker: '#ad4e00',
    light: '#ffc069',
    gradientStart: '#ad4e00',
    gradientMid: '#fa8c16',
    gradientEnd: '#ffd591',
    rgb: '250, 140, 22',
  },
  {
    key: 'cyan',
    name: '海洋青',
    primary: '#13c2c2',
    dark: '#08979c',
    darker: '#00474f',
    light: '#5cdbd3',
    gradientStart: '#00474f',
    gradientMid: '#13c2c2',
    gradientEnd: '#87e8de',
    rgb: '19, 194, 194',
  },
  {
    key: 'magenta',
    name: '玫瑰粉',
    primary: '#eb2f96',
    dark: '#c41d7f',
    darker: '#9e1068',
    light: '#ff85c0',
    gradientStart: '#9e1068',
    gradientMid: '#eb2f96',
    gradientEnd: '#ffadd2',
    rgb: '235, 47, 150',
  },
  {
    key: 'gold',
    name: '尊贵金',
    primary: '#faad14',
    dark: '#d48806',
    darker: '#874d00',
    light: '#ffd666',
    gradientStart: '#874d00',
    gradientMid: '#faad14',
    gradientEnd: '#ffe58f',
    rgb: '250, 173, 20',
  },
  {
    key: 'indigo',
    name: '极光靛',
    primary: '#2f54eb',
    dark: '#1d39c4',
    darker: '#10239e',
    light: '#85a5ff',
    gradientStart: '#10239e',
    gradientMid: '#2f54eb',
    gradientEnd: '#adc6ff',
    rgb: '47, 84, 235',
  },
  {
    key: 'geekblue',
    name: '极客蓝',
    primary: '#0052d9',
    dark: '#003cab',
    darker: '#002a7c',
    light: '#4080ff',
    gradientStart: '#002a7c',
    gradientMid: '#0052d9',
    gradientEnd: '#4080ff',
    rgb: '0, 82, 217',
  },
  {
    key: 'volcano',
    name: '火山橙',
    primary: '#fa541c',
    dark: '#d4380d',
    darker: '#ad2102',
    light: '#ff9c6e',
    gradientStart: '#ad2102',
    gradientMid: '#fa541c',
    gradientEnd: '#ffbb96',
    rgb: '250, 84, 28',
  },
  {
    key: 'lime',
    name: '青柠绿',
    primary: '#a0d911',
    dark: '#7cb305',
    darker: '#5b8c00',
    light: '#d3f261',
    gradientStart: '#5b8c00',
    gradientMid: '#a0d911',
    gradientEnd: '#e8ff85',
    rgb: '160, 217, 17',
  },
  {
    key: 'cherry',
    name: '樱花粉',
    primary: '#ff85c0',
    dark: '#eb2f96',
    darker: '#c41d7f',
    light: '#ffadd2',
    gradientStart: '#c41d7f',
    gradientMid: '#ff85c0',
    gradientEnd: '#ffd6e7',
    rgb: '255, 133, 192',
  },
  {
    key: 'turquoise',
    name: '绿松石',
    primary: '#36cfc9',
    dark: '#13c2c2',
    darker: '#006d75',
    light: '#87e8de',
    gradientStart: '#006d75',
    gradientMid: '#36cfc9',
    gradientEnd: '#b5f5ec',
    rgb: '54, 207, 201',
  },
  {
    key: 'lavender',
    name: '薰衣紫',
    primary: '#9254de',
    dark: '#722ed1',
    darker: '#531dab',
    light: '#d3adf7',
    gradientStart: '#531dab',
    gradientMid: '#9254de',
    gradientEnd: '#efdbff',
    rgb: '146, 84, 222',
  },
  {
    key: 'bronze',
    name: '古铜金',
    primary: '#d48806',
    dark: '#ad4e00',
    darker: '#873800',
    light: '#ffc53d',
    gradientStart: '#873800',
    gradientMid: '#d48806',
    gradientEnd: '#ffe58f',
    rgb: '212, 136, 6',
  },
  {
    key: 'slate',
    name: '岩板灰',
    primary: '#597ef7',
    dark: '#2f54eb',
    darker: '#1d39c4',
    light: '#adc6ff',
    gradientStart: '#1d39c4',
    gradientMid: '#597ef7',
    gradientEnd: '#d6e4ff',
    rgb: '89, 126, 247',
  },
  {
    key: 'coral',
    name: '珊瑚橘',
    primary: '#ff7a45',
    dark: '#fa541c',
    darker: '#d4380d',
    light: '#ffa940',
    gradientStart: '#d4380d',
    gradientMid: '#ff7a45',
    gradientEnd: '#ffd8bf',
    rgb: '255, 122, 69',
  },
  {
    key: 'mint',
    name: '薄荷青',
    primary: '#5cdbd3',
    dark: '#36cfc9',
    darker: '#08979c',
    light: '#87e8de',
    gradientStart: '#08979c',
    gradientMid: '#5cdbd3',
    gradientEnd: '#b5f5ec',
    rgb: '92, 219, 211',
  },
  {
    key: 'rose',
    name: '玫瑰红',
    primary: '#f759ab',
    dark: '#eb2f96',
    darker: '#c41d7f',
    light: '#ffadd2',
    gradientStart: '#c41d7f',
    gradientMid: '#f759ab',
    gradientEnd: '#ffcfdf',
    rgb: '247, 89, 171',
  },
];

// 主题色搭配组：2-3 色混搭渐变
const THEME_GRADIENTS = [
  { key: 'g1', name: '深海霞光', colors: ['#082A47', '#FE5EA0', '#FAE4EB'], primary: '#FE5EA0' },
  { key: 'g2', name: '蓝焰红霞', colors: ['#182876', '#EB4743'], primary: '#EB4743' },
  { key: 'g3', name: '紫黄暗夜', colors: ['#690DAD', '#0F0F0F', '#FFFF00'], primary: '#690DAD' },
  { key: 'g4', name: '暖橙夜空', colors: ['#EB6127', '#152639', '#F1DDBC'], primary: '#EB6127' },
  { key: 'g5', name: '米黄赤焰', colors: ['#182876', '#EB4743'], primary: '#EB4743' },
  { key: 'g6', name: '晴空金阳', colors: [ '#3DBAFD', '#F8E448'], primary: '#3DBAFD' },
  { key: 'g7', name: '雪绒紫粉', colors: ['#FE4D8E', '#7B2BBD'], primary: '#7B2BBD' },
  { key: 'g8', name: '青柠香草', colors: [ '#26C6C3', '#FEDB7C'], primary: '#26C6C3' },
  { key: 'g9', name: '玫瑰金辉', colors: ['#B62B6C', '#FCBA32'], primary: '#B62B6C' },
  { key: 'g10', name: '暗夜烈焰', colors: ['#1D2236', '#F34F1C'], primary: '#F34F1C' },
  { key: 'g11', name: '暮色胭脂', colors: ['#423F76', '#D86E84'], primary: '#D86E84' },
  { key: 'g12', name: '霓虹黑焰', colors: ['#FE019A', '#100E0F'], primary: '#FE019A' },
  { key: 'g13', name: '粉蓝霓虹', colors: ['#FE019A', '#00D3F6'], primary: '#FE019A' },
  { key: 'g14', name: '皇室尊贵', colors: ['#690DAD', '#FFFF00'], primary: '#690DAD' },
  { key: 'g15', name: '阳光海岸', colors: ['#0084D6', '#FFFF00'], primary: '#0084D6' },
  { key: 'g16', name: '青紫幻境', colors: ['#690DAD', '#00FFFF'], primary: '#690DAD' },
  { key: 'g17', name: '幽暗笼罩', colors: ['#090834', '#424379', '#00EAD7'], primary: '#424379' },
  { key: 'g18', name: '黑红相间', colors: ['#000000', '#B40B2F', '#AEB3AF'], primary: '#B40B2F' },
  { key: 'g19', name: '小丑皮肤', colors: ['#1F0635', '#00C400', '#5A2F88'], primary: '#5A2F88' },
  { key: 'g20', name: '鹦鹉螺旋', colors: ['#201B1A', '#1A1B4A', '#E60012'], primary: '#E60012' },
];

const THEME_STORAGE_KEY = 'dingpan_theme_color';
const CUSTOM_COLOR_STORAGE_KEY = 'dingpan_custom_color';
const DEFAULT_THEME_KEY = 'blue';

const getThemeByKey = (key) => THEME_COLORS.find((t) => t.key === key) || THEME_COLORS[0];
const getGradientByKey = (key) => THEME_GRADIENTS.find((g) => g.key === key);

const hexToRgb = (hex) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 22, g: 119, b: 255 };
};

const rgbToHex = (r, g, b) => {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
};

const hslToRgb = (h, s, l) => {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
};

const rgbToHsl = (r, g, b) => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
      default: h = 0;
    }
  }
  return { h, s, l };
};

const deriveThemeFromColor = (hex, alpha = 1) => {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  const darkHsl = { ...hsl, l: Math.max(0, hsl.l - 0.15) };
  const darkerHsl = { ...hsl, l: Math.max(0, hsl.l - 0.3) };
  const lightHsl = { ...hsl, l: Math.min(1, hsl.l + 0.18) };

  const primary = alpha < 1
    ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
    : hex;
  const dark = rgbToHex(...Object.values(hslToRgb(darkHsl.h, darkHsl.s, darkHsl.l)));
  const darker = rgbToHex(...Object.values(hslToRgb(darkerHsl.h, darkerHsl.s, darkerHsl.l)));
  const light = rgbToHex(...Object.values(hslToRgb(lightHsl.h, lightHsl.s, lightHsl.l)));

  const gradientStartHsl = { ...hsl, l: Math.max(0, hsl.l - 0.25) };
  const gradientEndHsl = { ...hsl, l: Math.min(1, hsl.l + 0.25) };
  const gradientStart = rgbToHex(...Object.values(hslToRgb(gradientStartHsl.h, gradientStartHsl.s, gradientStartHsl.l)));
  const gradientMid = hex;
  const gradientEnd = rgbToHex(...Object.values(hslToRgb(gradientEndHsl.h, gradientEndHsl.s, gradientEndHsl.l)));

  return {
    key: 'custom',
    name: '自定义',
    primary,
    dark,
    darker,
    light,
    gradientStart,
    gradientMid,
    gradientEnd,
    rgb: `${rgb.r}, ${rgb.g}, ${rgb.b}`
  };
};

// 由搭配组构建完整主题对象（同时设置 primary 与渐变色）
const buildThemeFromGradient = (gradient) => {
  const colors = gradient.colors;
  const gradientStart = colors[0];
  const gradientMid = colors.length === 3 ? colors[1] : colors[0];
  const gradientEnd = colors[colors.length - 1];
  const primary = gradient.primary;
  const rgb = hexToRgb(primary);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  const darkHsl = { ...hsl, l: Math.max(0, hsl.l - 0.15) };
  const darkerHsl = { ...hsl, l: Math.max(0, hsl.l - 0.3) };
  const lightHsl = { ...hsl, l: Math.min(1, hsl.l + 0.18) };
  const dark = rgbToHex(...Object.values(hslToRgb(darkHsl.h, darkHsl.s, darkHsl.l)));
  const darker = rgbToHex(...Object.values(hslToRgb(darkerHsl.h, darkerHsl.s, darkerHsl.l)));
  const light = rgbToHex(...Object.values(hslToRgb(lightHsl.h, lightHsl.s, lightHsl.l)));

  return {
    key: `gradient_${gradient.key}`,
    name: gradient.name,
    primary,
    dark,
    darker,
    light,
    gradientStart,
    gradientMid,
    gradientEnd,
    rgb: `${rgb.r}, ${rgb.g}, ${rgb.b}`,
  };
};

const applyThemeColor = (theme) => {
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--theme-color', theme.primary);
  root.style.setProperty('--theme-color-dark', theme.dark);
  root.style.setProperty('--theme-color-darker', theme.darker);
  root.style.setProperty('--theme-color-light', theme.light);
  root.style.setProperty('--theme-color-rgb', theme.rgb);
  root.style.setProperty('--theme-gradient-start', theme.gradientStart);
  root.style.setProperty('--theme-gradient-mid', theme.gradientMid);
  root.style.setProperty('--theme-gradient-end', theme.gradientEnd);
};

const getInitialTheme = () => {
  try {
    const savedKey = localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_KEY;
    if (savedKey === 'custom') {
      const savedCustomColor = localStorage.getItem(CUSTOM_COLOR_STORAGE_KEY);
      if (savedCustomColor) {
        const { hex, alpha } = JSON.parse(savedCustomColor);
        return deriveThemeFromColor(hex, alpha);
      }
    }
    if (savedKey && savedKey.startsWith('gradient_')) {
      const gradient = getGradientByKey(savedKey.replace('gradient_', ''));
      if (gradient) return buildThemeFromGradient(gradient);
    }
    return getThemeByKey(savedKey);
  } catch (e) {
    return THEME_COLORS[0];
  }
};

// 是否已收盘（非交易日视为已收盘，交易日 9:15 前或 14:59 及以后），统一来自 utils/tradingDay（以交易日历为准）

// 个人感受记录触发时间点：9:40 起每隔 20 分钟，午休（11:30-13:00）和收盘后不执行
const PERSONAL_FEELING_TIMES = [
  '09:40', '10:00', '10:20', '10:40', '11:00', '11:20',
  '13:20', '13:40', '14:00', '14:20', '14:40',
];

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(false);
  const [preMarketVisible, setPreMarketVisible] = useState(false);
  const [globalAnalysisVisible, setGlobalAnalysisVisible] = useState(false);
  const [globalAnalysisBlinking, setGlobalAnalysisBlinking] = useState(false);
  const [todayPlanVisible, setTodayPlanVisible] = useState(false);
  const [todayPlanModified, setTodayPlanModified] = useState(false);
  const [majorEventReminderVisible, setMajorEventReminderVisible] = useState(false);
  const [timerId, setTimerId] = useState(null);
  const [jigouNewCount, setJigouNewCount] = useState(0);
  const [themePickerVisible, setThemePickerVisible] = useState(false);
  const [currentTheme, setCurrentTheme] = useState(getInitialTheme);
  const [customColor, setCustomColor] = useState(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_COLOR_STORAGE_KEY);
      return saved ? JSON.parse(saved) : { hex: '#1890ff', alpha: 1 };
    } catch {
      return { hex: '#1890ff', alpha: 1 };
    }
  });

  // AI 引擎切换
  const [aiProviders, setAiProviders] = useState([]);
  const [currentAIProvider, setCurrentAIProvider] = useState('deepseek');
  const [aiProviderLoading, setAIProviderLoading] = useState(false);
  const aiProviderSyncedRef = useRef(false);

  // 应用主题色 CSS 变量
  useEffect(() => {
    applyThemeColor(currentTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, currentTheme.key);
    } catch (e) {
      // ignore
    }
    // 通知 ThemeProvider 更新 AntD 主题
    window.dispatchEvent(new CustomEvent('theme-changed'));
  }, [currentTheme]);

  const handleSelectTheme = (theme) => {
    setCurrentTheme(theme);
    setThemePickerVisible(false);
  };

  const handleSelectGradient = (gradient) => {
    setCurrentTheme(buildThemeFromGradient(gradient));
    setThemePickerVisible(false);
  };

  const handleCustomColorChange = (color) => {
    const newColor = {
      hex: color.toHexString(),
      alpha: color.toRgb().a
    };
    setCustomColor(newColor);
    try {
      localStorage.setItem(CUSTOM_COLOR_STORAGE_KEY, JSON.stringify(newColor));
      localStorage.setItem(THEME_STORAGE_KEY, 'custom');
    } catch (e) {
      // ignore
    }
    setCurrentTheme(deriveThemeFromColor(newColor.hex, newColor.alpha));
  };
  const [quantSignalState, setQuantSignalState] = useState({
    buyPointCount: 0,
    signalCount: 0,
    menuShouldBlink: false,
    marketShouldBlink: false,
    signalKey: '',
  });
  const [acknowledgedQuantSignalKey, setAcknowledgedQuantSignalKey] = useState('');

  // 主力资金监控相关状态
  const [mainMoneyHistory, setMainMoneyHistory] = useState([]);
  const [showMainMoneyAlert, setShowMainMoneyAlert] = useState(false);
  const [alertCooldownEnd, setAlertCooldownEnd] = useState(0);

  // 删除持仓股资金净流出警示弹窗
  const [outflowWarningVisible, setOutflowWarningVisible] = useState(false);
  const [outflowWarningMinimized, setOutflowWarningMinimized] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState(1200);
  const countdownTimerRef = useRef(null);

  const handleOutflowDetected = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
    }
    setCountdownSeconds(1200);
    setOutflowWarningMinimized(false);
    setOutflowWarningVisible(true);

    countdownTimerRef.current = setInterval(() => {
      setCountdownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
          setOutflowWarningVisible(false);
          setOutflowWarningMinimized(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const stopOutflowWarning = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setOutflowWarningVisible(false);
    setOutflowWarningMinimized(false);
  };

  const formatCountdown = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, []);

  // 9:40推荐购买弹窗
  const [buyRecommendationVisible, setBuyRecommendationVisible] = useState(false);
  const [buyRecommendationStocks, setBuyRecommendationStocks] = useState([]);
  const [buyRecommendationReason, setBuyRecommendationReason] = useState('');
  const buyRecommendationTriggeredRef = useRef(false); // 当天是否已触发过推荐

  // 个人感受记录弹窗
  const [personalFeelingVisible, setPersonalFeelingVisible] = useState(false);
  const [personalFeelingRecords, setPersonalFeelingRecords] = useState([]);
  const [personalFeelingDate, setPersonalFeelingDate] = useState('');
  const [personalFeelingSaving, setPersonalFeelingSaving] = useState(false);
  const personalFeelingVisibleRef = useRef(false);

  // 轮询机构研报的新增数量，用于左侧菜单徽标
  useEffect(() => {
    const fetchNewCount = () => {
      axios
        .get(`http://${local_ip}:3000/get_jigou_reports_new`)
        .then((res) => setJigouNewCount(res.data?.count || 0))
        .catch(() => { });
    };
    fetchNewCount();

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

    schedulePoll(fetchNewCount, 30000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    const timers = [];
    const schedulePoll = (callback, delay) => {
      const timer = setTimeout(() => {
        callback();
        schedulePoll(callback, delay);
      }, delay);
      timers.push(timer);
      return timer;
    };

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    if (location.pathname === '/quant_analysis' && quantSignalState.signalKey) {
      setAcknowledgedQuantSignalKey(quantSignalState.signalKey);
    }
  }, [location.pathname, quantSignalState.signalKey]);

  const hasUnreadQuantSignal = Boolean(
    quantSignalState.menuShouldBlink
    && quantSignalState.signalKey
    && quantSignalState.signalKey !== acknowledgedQuantSignalKey
  );

  // 监听 GlobalAnalysis 组件发出的闪烁通知
  useEffect(() => {
    window.onGlobalAnalysisBlinkChange = (blinking) => {
      setGlobalAnalysisBlinking(blinking);
    };
    return () => {
      delete window.onGlobalAnalysisBlinkChange;
    };
  }, []);

  // 初始化 AI 引擎配置：从后端读取当前选择，与 localStorage 缓存同步
  useEffect(() => {
    const fetchAIProvider = async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/ai_provider`);
        if (res.data?.success) {
          setCurrentAIProvider(res.data.current);
          setAiProviders(res.data.providers || []);
          // 同步到 localStorage，下次启动立即可用
          localStorage.setItem('ai_provider', res.data.current);
          aiProviderSyncedRef.current = true;
        }
      } catch (err) {
        console.error('获取 AI 引擎配置失败:', err);
        // 后端不可用时回退到 localStorage
        const cached = localStorage.getItem('ai_provider') || 'deepseek';
        setCurrentAIProvider(cached);
      }
    };
    fetchAIProvider();
  }, []);

  // 切换 AI 引擎
  const handleAIProviderChange = async (value) => {
    setAIProviderLoading(true);
    const prevProvider = currentAIProvider;
    try {
      const res = await axios.post(`http://${local_ip}:3000/ai_provider`, { provider: value });
      if (res.data?.success) {
        setCurrentAIProvider(value);
        localStorage.setItem('ai_provider', value);
        message.success(`已切换到 ${res.data.message?.replace('已切换到 ', '') || value}`);
      } else {
        message.error(res.data?.message || '切换失败');
      }
    } catch (err) {
      console.error('切换 AI 引擎失败:', err);
      const errMsg = err.response?.data?.message || err.message || '切换失败';
      message.error(errMsg);
      // 切换失败时回滚
      setCurrentAIProvider(prevProvider);
    } finally {
      setAIProviderLoading(false);
    }
  };

  // 主力资金监控轮询
  useEffect(() => {
    const fetchMainMoney = async () => {
      try {
        const response = await axios.get(`http://${local_ip}:3000/dapan_data`);
        const mainMoney = parseFloat(response.data.mainMoney) || 0;
        const now = Date.now();

        setMainMoneyHistory(prev => {
          const newHistory = [...prev.filter(item => now - item.timestamp <= 15 * 60 * 1000), { timestamp: now, value: mainMoney }];
          return newHistory;
        });
      } catch (err) {
        console.error('Fetch main money data failed:', err);
      }
    };

    fetchMainMoney();

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

    schedulePoll(fetchMainMoney, 30000);

    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  // 打开弹窗时停止闪烁
  useEffect(() => {
    if (globalAnalysisVisible) {
      setGlobalAnalysisBlinking(false);
    }
  }, [globalAnalysisVisible]);

  // 主力资金流出趋势检测
  useEffect(() => {
    if (mainMoneyHistory.length < 4) return;

    const now = Date.now();

    const sortedHistory = [...mainMoneyHistory].sort((a, b) => a.timestamp - b.timestamp);

    const fifteenMinAgo = now - 15 * 60 * 1000;
    const tenMinAgo = now - 10 * 60 * 1000;
    const fiveMinAgo = now - 5 * 60 * 1000;

    const data15minAgo = sortedHistory.find(h => h.timestamp <= fifteenMinAgo) || sortedHistory[0];
    const data10minAgo = sortedHistory.find(h => h.timestamp <= tenMinAgo && h.timestamp > fifteenMinAgo) ||
      sortedHistory.find(h => h.timestamp <= tenMinAgo) || sortedHistory[0];
    const data5minAgo = sortedHistory.find(h => h.timestamp <= fiveMinAgo && h.timestamp > tenMinAgo) ||
      sortedHistory.find(h => h.timestamp <= fiveMinAgo) || sortedHistory[0];
    const latestData = sortedHistory[sortedHistory.length - 1];

    if (data15minAgo && data10minAgo && data5minAgo && latestData) {
      const v15 = data15minAgo.value;
      const v10 = data10minAgo.value;
      const v5 = data5minAgo.value;
      const vNow = latestData.value;

      if (vNow < v5 && v5 < v10 && v10 < v15) {
        if (now < alertCooldownEnd) {
          return;
        }
        setShowMainMoneyAlert(true);
      }
    }
  }, [mainMoneyHistory, alertCooldownEnd]);

  // 设置9:10的定时器
  useEffect(() => {
    const now = dayjs();
    const targetTime = now.hour(9).minute(10).second(0).millisecond(0);

    let delay = targetTime.diff(now);

    // 如果已经过了9:10，就不再设置定时器
    if (delay <= 0) {
      return;
    }

    const id = setTimeout(() => {
      setTodayPlanVisible(true);
      // 打开后清除定时器
      if (timerId) {
        clearTimeout(timerId);
        setTimerId(null);
      }
    }, delay);

    setTimerId(id);

    return () => {
      if (id) {
        clearTimeout(id);
      }
    };
  }, []);

  // 9:40推荐购买逻辑
  useEffect(() => {
    const now = dayjs();
    const targetTime = now.hour(9).minute(40).second(0).millisecond(0);
    let delay = targetTime.diff(now);

    if (delay <= 0) {
      return;
    }

    const checkBuyRecommendation = async () => {
      try {
        // 非交易日（周末/节假日，以交易日历为准）不推送
        if (!isTradingDay(now)) {
          return;
        }

        const [techEmotionRes, highChangeStocksRes] = await Promise.all([
          axios.get(`http://${local_ip}:3000/emotion_data`),
          axios.get(`http://${local_ip}:3000/kaipan_high_change_stocks`)
        ]);

        const techIndexData = techEmotionRes.data?.techIndexData || [];

        if (techIndexData.length < 2) {
          return;
        }

        techIndexData.sort((a, b) => b.date - a.date);

        const yesterdayEmotion = parseFloat(techIndexData[0]?.changeSumResult) || 0;
        const dayBeforeYesterdayEmotion = parseFloat(techIndexData[1]?.changeSumResult) || 0;

        const condition1 = yesterdayEmotion < -30;
        const condition2 = yesterdayEmotion < 0 && dayBeforeYesterdayEmotion < 0;

        if (!condition1 && !condition2) {
          return;
        }

        const highChangeStocks = highChangeStocksRes.data || [];
        if (highChangeStocks.length === 0) {
          return;
        }

        const sortedHistory = [...mainMoneyHistory].sort((a, b) => a.timestamp - b.timestamp);
        if (sortedHistory.length < 3) {
          return;
        }

        const tenMinAgo = Date.now() - 10 * 60 * 1000;
        const recentData = sortedHistory.filter(h => h.timestamp >= tenMinAgo);

        if (recentData.length < 2) {
          return;
        }

        const earlyValue = recentData[0].value;
        const latestValue = recentData[recentData.length - 1].value;

        if (latestValue <= earlyValue) {
          return;
        }

        let reason = '';
        if (condition1) {
          reason = `前一天科技情绪指数为 ${yesterdayEmotion.toFixed(2)}（低于-30），市场情绪处于冰点，次日修复概率极大。`;
        } else if (condition2) {
          reason = `科技情绪已连续两天为负（昨日 ${yesterdayEmotion.toFixed(2)}，前日 ${dayBeforeYesterdayEmotion.toFixed(2)}），市场情绪极度低迷后蕴含转机。`;
        }
        reason += ' 且开盘后10分钟内大盘主力资金持续净流入，今日可关注以下竞价高开个股。';

        setBuyRecommendationStocks(highChangeStocks);
        setBuyRecommendationReason(reason);
        setBuyRecommendationVisible(true);
        buyRecommendationTriggeredRef.current = true;

      } catch (error) {
        console.error('9:40推荐购买检查失败:', error);
      }
    };

    const id = setTimeout(checkBuyRecommendation, delay);

    return () => {
      if (id) {
        clearTimeout(id);
      }
    };
  }, [mainMoneyHistory]);

  // 个人感受记录弹窗可见性同步到 ref
  useEffect(() => {
    personalFeelingVisibleRef.current = personalFeelingVisible;
  }, [personalFeelingVisible]);

  // 个人感受记录轮询：9:40 起每隔 20 分钟弹出，午休和收盘后不执行
  useEffect(() => {
    let timer = null;
    let cancelled = false;

    const trigger = async () => {
      if (cancelled) return;
      const todayStr = dayjs().format('YYYYMMDD');
      const nowTime = dayjs().format('HH:mm');
      const slotsToShow = PERSONAL_FEELING_TIMES.filter(t => t <= nowTime);

      if (personalFeelingVisibleRef.current) {
        // 弹窗已打开，仅补充新时段，保留未保存的内容
        setPersonalFeelingRecords(prev => {
          const updated = [...prev];
          slotsToShow.forEach(slot => {
            if (!updated.find(r => r.time === slot)) {
              updated.push({ time: slot, feeling: '' });
            }
          });
          return updated.sort((a, b) => a.time.localeCompare(b.time));
        });
      } else {
        // 弹窗未打开，从后端加载已有记录
        let existing = [];
        try {
          const res = await axios.get(`http://${local_ip}:3000/fupan/personal_feelings?date=${todayStr}`);
          existing = res.data?.data?.records || [];
        } catch (err) {
          console.error('加载个人感受记录失败:', err);
        }
        const merged = PERSONAL_FEELING_TIMES.map(slot => {
          const found = existing.find(r => r.time === slot);
          return { time: slot, feeling: found?.feeling || '' };
        });
        setPersonalFeelingRecords(merged);
        setPersonalFeelingDate(todayStr);
        setPersonalFeelingVisible(true);
      }
    };

    const scheduleNext = () => {
      if (cancelled || PERSONAL_FEELING_TIMES.length === 0) return;
      const now = dayjs();

      // 非交易日（周末/节假日）不弹出，直接跳到下一个交易日的第一个时段
      if (!isTradingDay(now)) {
        const nextDay = getNextTradingDay(now);
        const [firstH, firstM] = PERSONAL_FEELING_TIMES[0].split(':').map(Number);
        const nextTarget = nextDay.hour(firstH).minute(firstM).second(0).millisecond(0);
        const nextDiff = nextTarget.diff(now);
        timer = setTimeout(() => {
          if (!cancelled) scheduleNext();
        }, nextDiff);
        return;
      }

      // 查找当天下一个未过期的时段
      for (const timeStr of PERSONAL_FEELING_TIMES) {
        const [h, m] = timeStr.split(':').map(Number);
        const target = now.hour(h).minute(m).second(0).millisecond(0);
        const diff = target.diff(now);
        if (diff > 0) {
          timer = setTimeout(() => {
            trigger().then(() => {
              if (!cancelled) scheduleNext();
            }).catch(() => {
              if (!cancelled) scheduleNext();
            });
          }, diff);
          return;
        }
      }

      // 当天所有时段已过，找下一个交易日的第一个时段
      const nextDay = getNextTradingDay(now);
      const [firstH, firstM] = PERSONAL_FEELING_TIMES[0].split(':').map(Number);
      const nextTarget = nextDay.hour(firstH).minute(firstM).second(0).millisecond(0);
      const nextDiff = nextTarget.diff(now);
      timer = setTimeout(() => {
        trigger().then(() => {
          if (!cancelled) scheduleNext();
        }).catch(() => {
          if (!cancelled) scheduleNext();
        });
      }, nextDiff);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleFeelingChange = (time, value) => {
    setPersonalFeelingRecords(prev => prev.map(r => (r.time === time ? { ...r, feeling: value } : r)));
  };

  const handleSavePersonalFeeling = async () => {
    if (!personalFeelingDate) return;
    setPersonalFeelingSaving(true);
    try {
      await axios.post(`http://${local_ip}:3000/fupan/personal_feelings`, {
        date: personalFeelingDate,
        records: personalFeelingRecords,
      });
      message.success('感受记录已保存');
      setPersonalFeelingVisible(false);
    } catch (error) {
      console.error('保存个人感受失败:', error);
      message.error('保存失败');
    } finally {
      setPersonalFeelingSaving(false);
    }
  };

  // 从全局分析弹窗打开个人感受记录弹窗：加载当天全部时段
  const openPersonalFeelingFromGlobal = async () => {
    const todayStr = dayjs().format('YYYYMMDD');
    let existing = [];
    try {
      const res = await axios.get(`http://${local_ip}:3000/fupan/personal_feelings?date=${todayStr}`);
      existing = res.data?.data?.records || [];
    } catch (err) {
      console.error('加载个人感受记录失败:', err);
    }
    const merged = PERSONAL_FEELING_TIMES.map(slot => {
      const found = existing.find(r => r.time === slot);
      return { time: slot, feeling: found?.feeling || '' };
    });
    setPersonalFeelingRecords(merged);
    setPersonalFeelingDate(todayStr);
    setPersonalFeelingVisible(true);
    setGlobalAnalysisVisible(false);
    
  };

  const menuItems = [
    {
      key: '/opening_battle',
      icon: <RocketOutlined />,
      label: '专注交易',
    },
    // {
    //   key: '/volume',
    //   icon: <AreaChartOutlined />,
    //   label: '资金成交量',
    // },
    {
      key: '/block',
      icon: <AppstoreOutlined />,
      label: '重点板块',
    },
    {
      key: '/sentiment',
      icon: <CoffeeOutlined />,
      label: '情绪复盘',
    },

    {
      key: '/stock_diagnosis',
      icon: <StockOutlined />,
      label: '个股诊断',
    },
    {
      key: '/dingpan',
      icon: <DesktopOutlined />,
      label: '市场盯盘',
    },
    {
      key: '/shichangdiaoyan',
      icon: <BookOutlined />,
      label: '市场调研',
    },
    {
      key: '/jigou_reports',
      icon: <BookOutlined />,
      label: (
        <span className="menu-label-with-badge">
          机构研报
          {jigouNewCount > 0 && location.pathname !== '/jigou_reports' && (
            <Badge count={jigouNewCount} className="jigou-new-badge" offset={[6, -2]} />
          )}
        </span>
      ),
    },
    {
      key: '/fupan',
      icon: <HistoryOutlined />,
      label: '复盘分析',
    },
    {
      key: '/strategy_center',
      icon: <ThunderboltOutlined />,
      label: '策略中心',
    },
    {
      key: '/training_camp',
      icon: <TrophyOutlined />,
      label: '训练营',
    },
  ];

  return (
    <Layout className="app-layout">
      <Sider
        theme="light"
        className="app-sider"
        width={200}
        trigger={null}
        collapsible
        collapsed={collapsed}
      >
        <div className="logo" onClick={() => setThemePickerVisible(true)} title="点击切换主题色">
          <StockOutlined className="logo-icon" />
          {!collapsed && " 盯盘助手"}
          {!collapsed && <BgColorsOutlined className="logo-theme-icon" />}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => {
            navigate(key);
            if (key === '/jigou_reports') {
              setJigouNewCount(0);
            }
          }}
          className="app-menu"
        />
      </Sider>
      <Layout className="content-layout">
        <div
          className={`app-header-wrapper${headerVisible ? ' app-header-visible-wrapper' : ''}`}
          onMouseEnter={() => setHeaderVisible(true)}
          onMouseLeave={() => setHeaderVisible(false)}
        >
          <div className="header-hover-strip" />
          <Header className={`app-header${headerVisible ? ' app-header-visible' : ''}`}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            className="collapse-btn"
          />
          <div className="header-right-actions">
            <div className="ai-provider-switcher">
              <Select
                value={currentAIProvider}
                onChange={handleAIProviderChange}
                loading={aiProviderLoading}
                size="middle"
                className="ai-provider-select"
                popupMatchSelectWidth={false}
              >
                {aiProviders.map(p => (
                  <Select.Option key={p.key} value={p.key}>
                    <span className="ai-provider-option">
                      {p.name}
                      {p.active && <CheckOutlined style={{ marginLeft: 4, color: '#52c41a' }} />}
                    </span>
                  </Select.Option>
                ))}
              </Select>
            </div>
            <Button
              type="primary"
              icon={<GlobalOutlined />}
              onClick={() => setGlobalAnalysisVisible(true)}
              className={`global-analysis-btn${globalAnalysisBlinking ? ' global-analysis-btn-blinking' : ''}`}
            >
              全局分析
            </Button>
            <Button
              type="primary"
              icon={<BookOutlined />}
              onClick={() => setPreMarketVisible(true)}
              className="pre-market-btn"
            >
              盘前必读
            </Button>
            <Button
              type="primary"
              icon={<CalendarOutlined />}
              onClick={() => setTodayPlanVisible(true)}
              className="today-plan-btn"
            >
              今日计划
            </Button>
            <Button
              type="primary"
              icon={<BellOutlined />}
              onClick={() => setMajorEventReminderVisible(true)}
              className="major-event-btn"
            >
              大事提醒
            </Button>
          </div>
        </Header>
        </div>
        <Content className="app-content">
          <div className="content-inner">
            <Outlet />
          </div>
        </Content>
      </Layout>

      <Modal
        title={<span><BookOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />盘前必读精华</span>}
        open={preMarketVisible}
        onCancel={() => setPreMarketVisible(false)}
        footer={null}
        width={1400}
        centered
        className="pre-market-modal"
      >
        <PreMarketReading />
      </Modal>
      <Modal
        title={<span><GlobalOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />全局分析</span>}
        open={globalAnalysisVisible}
        onCancel={() => setGlobalAnalysisVisible(false)}
        footer={[
          <Button key="feeling" icon={<FileTextOutlined />} onClick={openPersonalFeelingFromGlobal}>
            打开个人感受记录
          </Button>,
        ]}
        width={1200}
        centered
        bodyStyle={{
          maxHeight: '800px',
          overflowY: 'auto'
        }}
      >
        <GlobalAnalysis />
      </Modal>
      <Modal
        title={<span><CalendarOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />今日交易计划 - {dayjs().format('YYYY-MM-DD')}</span>}
        open={todayPlanVisible}
        onCancel={() => {
          if (todayPlanModified) {
            Modal.confirm({
              title: '有未保存的修改',
              content: '今日计划有未保存的修改，确定要关闭吗？',
              okText: '放弃修改并关闭',
              okType: 'danger',
              cancelText: '继续编辑',
              onOk: () => {
                setTodayPlanModified(false);
                setTodayPlanVisible(false);
              },
            });
          } else {
            setTodayPlanVisible(false);
          }
        }}
        footer={null}
        width={1200}
        centered
        bodyStyle={{
          maxHeight: '800px',
          overflowY: 'auto'
        }}
      >
        <TodayPlan onModifiedChange={setTodayPlanModified} />
      </Modal>
      <Modal
        title={<span><BellOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />大事提醒</span>}
        open={majorEventReminderVisible}
        onCancel={() => setMajorEventReminderVisible(false)}
        footer={null}
        width={1200}
        centered
        destroyOnClose
        bodyStyle={{
          maxHeight: '800px',
          overflowY: 'auto'
        }}
      >
        <MajorEventReminder />
      </Modal>

      {location.pathname !== '/training_camp' && <FloatingStockPosition onOutflowDetected={handleOutflowDetected} />}
      {location.pathname !== '/training_camp' && location.pathname !== '/opening_battle' && <FloatingMonitorAlarm />}
      {location.pathname !== '/training_camp' && location.pathname !== '/opening_battle' && <FloatingStrategyCenter />}
      <FloatingTechEmotion />
      <ClosePipeline />

      {/* 删除持仓股资金净流出警示弹窗 */}
      {outflowWarningVisible && (
        <div
          className={`outflow-warning-popup ${outflowWarningMinimized ? 'minimized' : ''}`}
        >
          {outflowWarningMinimized ? (
            <div
              className="outflow-warning-minimized"
              onClick={() => setOutflowWarningMinimized(false)}
            >
              <WarningOutlined className="outflow-warning-minimized-icon" />
              <span className="outflow-warning-minimized-text">资金净流出</span>
              <span className="outflow-warning-minimized-countdown">{formatCountdown(countdownSeconds)}</span>
            </div>
          ) : (
            <div className="outflow-warning-full">
              <div className="outflow-warning-header">
                <WarningOutlined className="outflow-warning-header-icon" />
                <span className="outflow-warning-title">资金净流出警示</span>
                <MinusOutlined
                  className="outflow-warning-minimize-btn"
                  onClick={() => setOutflowWarningMinimized(true)}
                />
              </div>
              <div className="outflow-warning-body">
                <div className="outflow-warning-message">
                  当前资金正在净流出，不要因为部分个股冲高就新开仓股票，请耐心等待 <strong>20min</strong> 之后再做判断。
                </div>
              </div>
              <div className="outflow-warning-countdown-row">
                <span className="outflow-warning-countdown-label">倒计时</span>
                <span className="outflow-warning-countdown-value">{formatCountdown(countdownSeconds)}</span>
              </div>
              <div className="outflow-warning-footer">
                <Button size="small" onClick={stopOutflowWarning}>
                  我知道了
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 主力资金流出警告弹窗 */}
      <Modal
        title={<span><AlertOutlined style={{ color: '#f5222d', marginRight: '8px' }} />🚨 主力资金持续流出警告</span>}
        open={showMainMoneyAlert}
        onCancel={() => setShowMainMoneyAlert(false)}
        footer={null}
        width={600}
        centered
        closable={false}
        maskClosable={false}
        className="main-money-alert-modal"
      >
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <div style={{ fontSize: '18px', lineHeight: '1.8', color: '#333', marginBottom: '24px' }}>
            <p style={{
              fontSize: '20px',
              fontWeight: 'bold',
              color: '#f5222d',
              padding: '16px 20px',
              margin: '0 0 16px 0'
            }}>
              🚨 主力资金在最近15分钟内<span style={{ color: '#26cf13ff' }}>持续流出!</span>
            </p>
            <p style={{
              fontSize: '16px',
              color: '#595959',
              lineHeight: '2',
              marginBottom: '12px'
            }}>
              ⚠️ <strong style={{ color: '#262626' }}>短期趋势已不可逆转</strong>
            </p>
            <p style={{
              fontSize: '16px',
              color: '#595959',
              lineHeight: '2',
              marginBottom: '12px'
            }}>
              📉 请<strong style={{ color: '#f5222d' }}>立即卖出</strong>手中持仓，尾盘再接回
            </p>
            <p style={{
              fontWeight: 'bold',
              fontSize: '18px',
              color: 'orange',
              lineHeight: '2',
              marginBottom: '20px',
              fontStyle: 'italic'
            }}>
              💡 不要怕卖飞，只做正确的操作，盈亏交给天意！
            </p>
          </div>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
            <Button
              type="primary"
              size="large"
              onClick={() => setShowMainMoneyAlert(false)}
            >
              我知道了
            </Button>
            <Button
              type="default"
              size="large"
              onClick={() => {
                setAlertCooldownEnd(Date.now() + 30 * 60 * 1000);
                setShowMainMoneyAlert(false);
              }}
            >
              不再提示（30分钟）
            </Button>
          </div>
        </div>
      </Modal>

      {/* 9:40推荐购买弹窗 */}
      <Modal
        title={<span><ThunderboltOutlined style={{ color: '#faad14', marginRight: '8px' }} />🔥 竞价高开推荐购买</span>}
        open={buyRecommendationVisible}
        onCancel={() => setBuyRecommendationVisible(false)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setBuyRecommendationVisible(false)}>
            我知道了
          </Button>,
        ]}
        width={500}
        centered
      >
        <div style={{ padding: '8px 0' }}>
          <div style={{ marginBottom: 16, color: '#595959', fontSize: 14, lineHeight: 1.8 }}>
            {buyRecommendationReason}
          </div>
          <div style={{ marginBottom: 12, color: '#fa8c16', fontSize: 15, fontWeight: 600 }}>
            🚀 以下个股开盘涨幅超过2%，建议关注：
          </div>
          {buyRecommendationStocks.map((stock, idx) => (
            <div
              key={stock.code}
              style={{
                border: '1px solid #ffd666',
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: idx < buyRecommendationStocks.length - 1 ? 8 : 0,
                background: '#fffbe6',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: 15, color: '#d46b08' }}>{stock.stockName}</span>
                <span style={{ color: '#8c8c8c', fontSize: 13, marginLeft: 8 }}>{stock.code}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                {stock.change !== undefined && (
                  <span style={{ color: '#cf1322', fontWeight: 600, fontSize: 15 }}>
                    +{stock.change?.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* 个人感受记录弹窗（三列：情绪记录 + AI行情总结 + AI资金总结） */}
      <PersonalFeelingModal
        visible={personalFeelingVisible}
        date={personalFeelingDate}
        records={personalFeelingRecords}
        saving={personalFeelingSaving}
        onFeelingChange={handleFeelingChange}
        onSave={handleSavePersonalFeeling}
        onCancel={() => setPersonalFeelingVisible(false)}
      />

      {/* 主题色选择弹窗 */}
      <Modal
        title={<span><BgColorsOutlined style={{ color: 'var(--theme-color, #1890ff)', marginRight: '8px' }} />主题色切换</span>}
        open={themePickerVisible}
        onCancel={() => setThemePickerVisible(false)}
        footer={null}
        width={600}
        centered
        className="theme-picker-modal"
      >
        <div className="theme-picker-body">
          <div className="theme-picker-tip">选择喜欢的主题色，左侧菜单及按钮阴影将同步切换。</div>
          <div className="theme-picker-grid">
            {THEME_COLORS.map((theme) => {
              const isActive = currentTheme.key === theme.key;
              return (
                <Tooltip key={theme.key} title={theme.name}>
                  <div
                    className={`theme-picker-item${isActive ? ' theme-picker-item-active' : ''}`}
                    onClick={() => handleSelectTheme(theme)}
                  >
                    <div
                      className="theme-picker-swatch"
                      style={{
                        background: theme.primary,
                        boxShadow: `0 6px 16px rgba(${theme.rgb}, 0.35)`,
                      }}
                    >
                      {isActive && <CheckOutlined className="theme-picker-check" />}
                    </div>
                    <div className="theme-picker-name">{theme.name}</div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
          <div className="theme-picker-divider">
            <span className="theme-picker-divider-text">主题色搭配组</span>
          </div>
          <div className="theme-picker-gradients">
            {THEME_GRADIENTS.map((gradient) => {
              const isActive = currentTheme.key === `gradient_${gradient.key}`;
              const gradientCss = `linear-gradient(135deg, ${gradient.colors.join(', ')})`;
              return (
                <Tooltip key={gradient.key} title={`${gradient.name}（${gradient.colors.join(' · ')}）`}>
                  <div
                    className={`theme-picker-gradient-item${isActive ? ' theme-picker-gradient-item-active' : ''}`}
                    onClick={() => handleSelectGradient(gradient)}
                  >
                    <div
                      className="theme-picker-gradient-swatch"
                      style={{ background: gradientCss }}
                    >
                      {isActive && <CheckOutlined className="theme-picker-check" />}
                    </div>
                    <div className="theme-picker-gradient-name">{gradient.name}</div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
          <div className="theme-picker-divider">
            <span className="theme-picker-divider-text">自定义颜色</span>
          </div>
          <div className="theme-picker-custom-section">
            <div className="theme-picker-custom-label">自由选择颜色和透明度</div>
            <div className="theme-picker-custom-picker">
              <ColorPicker
                showAlpha
                value={customColor.alpha < 1
                  ? `rgba(${hexToRgb(customColor.hex).r}, ${hexToRgb(customColor.hex).g}, ${hexToRgb(customColor.hex).b}, ${customColor.alpha})`
                  : customColor.hex
                }
                onChange={handleCustomColorChange}
                className="custom-color-picker"
              />
            </div>
            <div className="theme-picker-custom-preview">
              <div
                className="theme-picker-custom-preview-swatch"
                style={{
                  background: `linear-gradient(135deg, ${currentTheme.gradientStart} 0%, ${currentTheme.gradientMid} 50%, ${currentTheme.gradientEnd} 100%)`,
                }}
              />
              <div className="theme-picker-custom-preview-info">
                <div className="theme-picker-custom-preview-color">
                  <span className="preview-label">当前颜色:</span>
                  <span className="preview-value">{currentTheme.primary}</span>
                </div>
                <div className="theme-picker-custom-preview-alpha">
                  <span className="preview-label">透明度:</span>
                  <span className="preview-value">{Math.round(customColor.alpha * 100)}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}

export default App;
