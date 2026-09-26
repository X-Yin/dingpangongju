// themeColor 工具函数：根据 themeColor 配置生成内联样式对象
// themeColor 结构: { pack, itemTitleColor, itemBorderColor, numberFontFamily, numberFontSize }
// pack: 主题包 id（'' 表示默认样式；设置后 DIY 字段禁用，样式由主题包 CSS 变量接管）
// 若字段未设置（undefined / 空字符串），则返回 undefined，保留 css 默认样式

// 小卡片标题颜色（覆盖 css 中的黑色标题）
export const titleStyle = (themeColor) => {
    if (!themeColor?.itemTitleColor) return undefined;
    return { color: themeColor.itemTitleColor };
};

// 小卡片边框颜色（覆盖 css 中的边框颜色）
export const borderStyle = (themeColor) => {
    if (!themeColor?.itemBorderColor) return undefined;
    return { borderColor: themeColor.itemBorderColor };
};

// 数字字体（覆盖 css 中的数字 fontFamily 与 fontSize）
// 同一字号下不同字体展示大小不同，因此允许同时自定义字号
export const numberStyle = (themeColor) => {
    const hasFamily = !!themeColor?.numberFontFamily;
    const sizeVal = themeColor?.numberFontSize;
    const hasSize = sizeVal !== undefined && sizeVal !== null && sizeVal !== '' && Number(sizeVal) > 0;
    if (!hasFamily && !hasSize) return undefined;
    const style = {};
    if (hasFamily) style.fontFamily = themeColor.numberFontFamily;
    if (hasSize) style.fontSize = `${Number(sizeVal)}px`;
    return style;
};

// 合并边框与标题样式（用于卡片容器同时设置边框）
export const cardBorderStyle = (themeColor) => {
    if (!themeColor?.itemBorderColor) return undefined;
    return { borderColor: themeColor.itemBorderColor };
};

export const DEFAULT_THEME_COLOR = {
    pack: '',
    itemTitleColor: '',
    itemBorderColor: '',
    numberFontFamily: '',
    numberFontSize: '',
};

export const FONT_FAMILY_OPTIONS = [
    'SF Mono',
    'JetBrains Mono',
    'Monaco',
    'Consolas',
    'monospace',
];
