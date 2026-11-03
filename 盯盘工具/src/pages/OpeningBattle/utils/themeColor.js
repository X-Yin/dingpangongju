// OpeningBattle DIY 主题配置工具
// themeColor 结构: { pack, randomPlay, itemTitleColor, itemBorderColor, numberFontFamily, numberFontSize }
// pack: 主题包 id（'' 表示默认样式；设置后 DIY 字段禁用，样式由主题包 CSS 变量接管）
// DIY 字段通过 .opening-battle-container.diy-active 覆盖层的 --ob-* CSS 变量生效

export const DEFAULT_THEME_COLOR = {
    pack: '',
    randomPlay: false,
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

// 将 DIY 配置转为 CSS 变量 style 对象（主题包未生效时挂到容器上）
export const buildDiyVars = (themeColor) => {
    if (!themeColor) return undefined;
    const vars = {};
    if (themeColor.itemTitleColor) vars['--ob-item-title-color'] = themeColor.itemTitleColor;
    if (themeColor.itemBorderColor) vars['--ob-item-border-color'] = themeColor.itemBorderColor;
    if (themeColor.numberFontFamily) vars['--ob-number-font-family'] = themeColor.numberFontFamily;
    const sizeVal = themeColor.numberFontSize;
    if (sizeVal !== undefined && sizeVal !== null && sizeVal !== '' && Number(sizeVal) > 0) {
        vars['--ob-number-font-size'] = `${Number(sizeVal)}px`;
    }
    return Object.keys(vars).length ? vars : undefined;
};

// 是否有任一 DIY 字段生效（用于容器挂 .diy-active 类）
export const hasDiyFields = (themeColor) => {
    if (!themeColor) return false;
    return !!(themeColor.itemTitleColor || themeColor.itemBorderColor || themeColor.numberFontFamily || Number(themeColor.numberFontSize) > 0);
};
