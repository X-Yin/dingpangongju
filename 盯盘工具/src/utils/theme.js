// 主题色工具函数：用于在 JavaScript 中获取当前主题色

/**
 * 获取当前主题色（从 CSS 变量读取）
 * @param {string} variable - CSS 变量名，如 '--theme-color'
 * @param {string} fallback - 回退值
 * @returns {string} 颜色值
 */
export const getThemeColor = (variable = '--theme-color', fallback = '#1890ff') => {
  const root = document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(variable).trim();
  return value || fallback;
};

/**
 * 获取主题色对象
 * @returns {Object} 包含所有主题色变量的对象
 */
export const getThemeColors = () => ({
  primary: getThemeColor('--theme-color', '#1890ff'),
  dark: getThemeColor('--theme-color-dark', '#096dd9'),
  darker: getThemeColor('--theme-color-darker', '#0050b3'),
  light: getThemeColor('--theme-color-light', '#40a9ff'),
  rgb: getThemeColor('--theme-color-rgb', '24, 144, 255'),
});

/**
 * 生成主题色 rgba 字符串
 * @param {number} alpha - 透明度 0-1
 * @returns {string} rgba 字符串
 */
export const getThemeColorRgba = (alpha) => {
  const rgb = getThemeColor('--theme-color-rgb', '24, 144, 255');
  return `rgba(${rgb}, ${alpha})`;
};
