import { useState, useEffect } from 'react';
import { ConfigProvider } from 'antd';

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

const THEME_STORAGE_KEY = 'dingpan_theme_color';
const CUSTOM_COLOR_STORAGE_KEY = 'dingpan_custom_color';
const DEFAULT_THEME_KEY = 'blue';

const getThemeByKey = (key) => THEME_COLORS.find((t) => t.key === key) || THEME_COLORS[0];

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
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
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
    return getThemeByKey(savedKey);
  } catch (e) {
    return THEME_COLORS[0];
  }
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

const getThemeConfig = () => {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const primary = style.getPropertyValue('--theme-color').trim() || '#1890ff';
  const primaryDark = style.getPropertyValue('--theme-color-dark').trim() || '#096dd9';
  const primaryDarker = style.getPropertyValue('--theme-color-darker').trim() || '#0050b3';

  let colorPrimaryBg;
  if (primary.startsWith('rgba')) {
    const match = primary.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
    if (match) {
      colorPrimaryBg = `rgba(${match[1]}, ${match[2]}, ${match[3]}, 0.08)`;
    } else {
      colorPrimaryBg = `${primary}14`;
    }
  } else if (primary.startsWith('#')) {
    const rgb = hexToRgb(primary);
    colorPrimaryBg = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`;
  } else {
    colorPrimaryBg = `${primary}14`;
  }

  return {
    token: {
      colorPrimary: primary,
      colorPrimaryHover: primaryDark,
      colorPrimaryActive: primaryDarker,
      colorPrimaryBorder: primary,
      colorPrimaryBg,
      colorLink: primary,
      colorLinkHover: primaryDark,
      colorLinkActive: primaryDarker,
    },
  };
};

const ThemeProvider = ({ children }) => {
  const [themeConfig, setThemeConfig] = useState(() => {
    const theme = getInitialTheme();
    applyThemeColor(theme);
    return getThemeConfig();
  });

  useEffect(() => {
    const updateThemeConfig = () => {
      requestAnimationFrame(() => {
        setThemeConfig(getThemeConfig());
      });
    };

    const handleThemeChange = () => {
      updateThemeConfig();
    };

    const handleStorage = (e) => {
      if (e.key === 'dingpan_theme_color') {
        requestAnimationFrame(() => {
          const theme = getInitialTheme();
          applyThemeColor(theme);
          updateThemeConfig();
        });
      }
    };

    window.addEventListener('theme-changed', handleThemeChange);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('theme-changed', handleThemeChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return (
    <ConfigProvider theme={themeConfig}>
      {children}
    </ConfigProvider>
  );
};

export default ThemeProvider;
