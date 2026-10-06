// 主题包（Theme Pack）定义：从 uitest/styles 下的 12 个风格页面提取的配色与样式 token
// 每个 token 均为可选；未设置的 token 表示该项保持 CSS 默认样式
// 主题包通过 CSS 变量 + .dingpan-container.pack-active 覆盖层生效，
// 只影响盯盘页最外层组件（卡片/子项/按钮/标签），弹窗与 Tooltip 由 antd Portal
// 渲染在 body 下，天然不受影响

export const THEME_PACK_TOKEN_KEYS = [
    'pageBg',            // 页面背景颜色（支持渐变）
    'fontFamily',        // 全局字体 family
    'numberFontFamily',  // 数字字体 family
    // 容器卡片
    'cardBg',            // 容器卡片背景
    'cardBorderColor',   // 容器卡片边框颜色
    'cardBorderWidth',   // 容器卡片边框粗细
    'cardRadius',        // 容器卡片圆角
    'cardShadow',        // 容器卡片阴影
    // 标题/描述
    'titleColor',        // 标题字体颜色
    'descColor',         // 描述字体颜色
    // 子 item
    'itemBg',            // 子 item 背景色
    'itemTitleColor',    // 子 item 标题颜色
    'itemDescColor',     // 子 item 描述字体颜色
    'itemBorderColor',   // 子 item 边框颜色
    'itemBorderStyle',   // 子 item 边框样式（solid/dashed/dotted）
    'itemBorderWidth',   // 子 item 边框粗细
    'itemRadius',        // 子 item 圆角
    // 涨跌
    'upColor',           // 涨幅红色
    'downColor',         // 跌幅绿色
    'upBg',              // 涨幅标签底色（可选，默认由 upColor 派生）
    'downBg',            // 跌幅标签底色（可选，默认由 downColor 派生）
    // 按钮
    'btnBg',             // 按钮背景
    'btnColor',          // 按钮字体颜色
    'btnFontFamily',     // 按钮字体 family
    'btnRadius',         // 按钮圆角
    'btnBorderColor',    // 按钮边框颜色
    'btnBorderStyle',    // 按钮边框样式
    'btnBorderWidth',    // 按钮边框粗细
    'btnShadow',         // 按钮阴影
    // 标签 Tag
    'tagBg',             // tag 背景颜色
    'tagColor',          // tag 字体颜色
    'tagFontFamily',     // tag 字体 family
    'tagBorderColor',    // tag 边框颜色
    'tagBorderStyle',    // tag 边框样式
    'tagBorderWidth',    // tag 边框粗细
    'tagRadius',         // tag 圆角
];

// token -> CSS 变量名映射
const TOKEN_TO_VAR = {
    pageBg: '--dp-page-bg',
    fontFamily: '--dp-font-family',
    numberFontFamily: '--dp-number-font-family',
    cardBg: '--dp-card-bg',
    cardBorderColor: '--dp-card-border-color',
    cardBorderWidth: '--dp-card-border-width',
    cardRadius: '--dp-card-radius',
    cardShadow: '--dp-card-shadow',
    titleColor: '--dp-title-color',
    descColor: '--dp-desc-color',
    itemBg: '--dp-item-bg',
    itemTitleColor: '--dp-item-title-color',
    itemDescColor: '--dp-item-desc-color',
    itemBorderColor: '--dp-item-border-color',
    itemBorderStyle: '--dp-item-border-style',
    itemBorderWidth: '--dp-item-border-width',
    itemRadius: '--dp-item-radius',
    upColor: '--dp-up-color',
    downColor: '--dp-down-color',
    upBg: '--dp-up-bg',
    downBg: '--dp-down-bg',
    btnBg: '--dp-btn-bg',
    btnColor: '--dp-btn-color',
    btnFontFamily: '--dp-btn-font-family',
    btnRadius: '--dp-btn-radius',
    btnBorderColor: '--dp-btn-border-color',
    btnBorderStyle: '--dp-btn-border-style',
    btnBorderWidth: '--dp-btn-border-width',
    btnShadow: '--dp-btn-shadow',
    tagBg: '--dp-tag-bg',
    tagColor: '--dp-tag-color',
    tagFontFamily: '--dp-tag-font-family',
    tagBorderColor: '--dp-tag-border-color',
    tagBorderStyle: '--dp-tag-border-style',
    tagBorderWidth: '--dp-tag-border-width',
    tagRadius: '--dp-tag-radius',
};

// hex -> rgba（用于派生涨跌标签底色；非 hex 值返回中性半透明灰）
export const hexToRgba = (hex, alpha = 0.12) => {
    if (typeof hex === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
        let h = hex.slice(1);
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return `rgba(127, 127, 127, ${alpha})`;
};

// 主题包列表（默认主题不在列表内，id 为 '' 表示默认/当前样式）
export const THEME_PACKS = [
    {
        id: 'liquid-glass',
        name: '流体玻璃',
        desc: 'Liquid Glass · 流体morphing玻璃质感',
        source: '#14',
        tokens: {
            pageBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)',
            fontFamily: "'Inter', sans-serif",
            cardBg: 'rgba(255, 255, 255, 0.15)',
            cardBorderColor: 'rgba(255, 255, 255, 0.35)',
            cardBorderWidth: '1px',
            cardRadius: '30px',
            cardShadow: 'none',
            titleColor: '#ffffff',
            descColor: 'rgba(255, 255, 255, 0.75)',
            itemBg: 'rgba(255, 255, 255, 0.15)',
            itemTitleColor: '#ffffff',
            itemDescColor: 'rgba(255, 255, 255, 0.65)',
            itemBorderColor: 'rgba(255, 255, 255, 0.3)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '20px',
            upColor: '#f77598ff',
            downColor: '#5EEAD4',
            btnBg: 'rgba(255, 255, 255, 0.2)',
            btnColor: '#ffffff',
            btnRadius: '999px',
            btnBorderColor: 'rgba(255, 255, 255, 0.4)',
            btnBorderStyle: 'solid',
            btnBorderWidth: '1px',
            tagBg: 'rgba(255, 255, 255, 0.15)',
            tagColor: '#ffffff',
            tagBorderColor: 'rgba(255, 255, 255, 0.3)',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '999px',
        },
    },
    {
        id: 'glassmorphism',
        name: '玻璃拟态',
        desc: 'Glassmorphism · 磨砂玻璃层次',
        source: '#03',
        tokens: {
            pageBg: 'linear-gradient(135deg, #0080FF 0%, #8B00FF 50%, #FF1493 100%)',
            fontFamily: "'Inter', sans-serif",
            cardBg: 'rgba(255, 255, 255, 0.15)',
            cardBorderColor: 'rgba(255, 255, 255, 0.25)',
            cardBorderWidth: '1px',
            cardRadius: '16px',
            cardShadow: 'none',
            titleColor: '#ffffff',
            descColor: 'rgba(255, 255, 255, 0.7)',
            itemBg: 'rgba(255, 255, 255, 0.18)',
            itemTitleColor: '#ffffff',
            itemDescColor: 'rgba(255, 255, 255, 0.6)',
            itemBorderColor: 'rgba(255, 255, 255, 0.22)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '12px',
            upColor: '#FF8FB3',
            downColor: '#4FE3C1',
            btnBg: 'rgba(255, 255, 255, 0.25)',
            btnColor: '#ffffff',
            btnRadius: '12px',
            btnBorderColor: 'rgba(255, 255, 255, 0.35)',
            btnBorderStyle: 'solid',
            btnBorderWidth: '1px',
            tagBg: 'rgba(255, 255, 255, 0.18)',
            tagColor: '#ffffff',
            tagBorderColor: 'rgba(255, 255, 255, 0.25)',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '10px',
        },
    },
    {
        id: 'vibrant-block',
        name: '活力色块',
        desc: 'Vibrant Block · 霓虹撞色大色块',
        source: '#06',
        tokens: {
            pageBg: '#000000',
            fontFamily: "'Space Grotesk', sans-serif",
            numberFontFamily: "'Space Grotesk', 'SF Mono', monospace",
            cardBg: 'rgba(255, 255, 255, 0.06)',
            cardBorderColor: 'rgba(255, 255, 255, 0.14)',
            cardBorderWidth: '1px',
            cardRadius: '24px',
            cardShadow: 'none',
            titleColor: '#FFFFFF',
            descColor: 'rgba(255, 255, 255, 0.65)',
            itemBg: 'rgba(255, 255, 255, 0.08)',
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.55)',
            itemBorderColor: 'rgba(255, 255, 255, 0.16)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '14px',
            upColor: '#FF3355',
            downColor: '#39FF14',
            btnBg: '#39FF14',
            btnColor: '#000000',
            btnRadius: '12px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            tagBg: '#BF00FF',
            tagColor: '#FFFFFF',
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '10px',
        },
    },
    {
        id: 'aurora',
        name: '极光渐变',
        desc: 'Aurora UI · 北极光流动渐变',
        source: '#10',
        tokens: {
            pageBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 25%, #f093fb 50%, #f5576c 75%, #4facfe 100%)',
            fontFamily: "'Inter', sans-serif",
            cardBg: 'rgba(255, 255, 255, 0.12)',
            cardBorderColor: 'rgba(255, 255, 255, 0.22)',
            cardBorderWidth: '1px',
            cardRadius: '16px',
            cardShadow: 'none',
            titleColor: '#ffffff',
            descColor: 'rgba(255, 255, 255, 0.8)',
            itemBg: 'rgba(255, 255, 255, 0.14)',
            itemTitleColor: '#ffffff',
            itemDescColor: 'rgba(255, 255, 255, 0.6)',
            itemBorderColor: 'rgba(255, 255, 255, 0.22)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '14px',
            // 涨跌色较最初版本加深，避免在渐变浅背景中对比度不足
            upColor: '#D6336C',
            downColor: '#0D9488',
            btnBg: 'linear-gradient(90deg, #3b82f6, #8b5cf6)',
            btnColor: '#ffffff',
            btnRadius: '12px',
            btnBorderColor: 'rgba(255, 255, 255, 0.25)',
            btnBorderStyle: 'solid',
            btnBorderWidth: '1px',
            tagBg: 'rgba(255, 255, 255, 0.16)',
            tagColor: '#ffffff',
            tagBorderColor: 'rgba(255, 255, 255, 0.3)',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '999px',
        },
    },
    {
        id: 'motion-driven',
        name: '动效驱动',
        desc: 'Motion-Driven · 深色科技动感',
        source: '#15',
        tokens: {
            pageBg: '#0F172A',
            fontFamily: "'Inter', sans-serif",
            cardBg: '#1E293B',
            cardBorderColor: '#334155',
            cardBorderWidth: '1px',
            cardRadius: '16px',
            cardShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
            titleColor: '#F1F5F9',
            descColor: '#94A3B8',
            itemBg: 'rgba(148, 163, 184, 0.08)',
            itemTitleColor: '#F1F5F9',
            itemDescColor: '#94A3B8',
            itemBorderColor: '#334155',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '12px',
            upColor: '#FB7185',
            downColor: '#34D399',
            btnBg: '#3B82F6',
            btnColor: '#FFFFFF',
            btnRadius: '10px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            tagBg: 'rgba(148, 163, 184, 0.15)',
            tagColor: '#E2E8F0',
            tagBorderColor: 'rgba(148, 163, 184, 0.3)',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '999px',
        },
    },
    {
        id: 'neubrutalism',
        name: '新粗野主义',
        desc: 'Neubrutalism · 硬阴影黑描边',
        source: '#38',
        tokens: {
            pageBg: '#FFF8E7',
            fontFamily: "'Space Grotesk', sans-serif",
            cardBg: '#FFFFFF',
            cardBorderColor: '#000000',
            cardBorderWidth: '4px',
            cardRadius: '0px',
            cardShadow: '6px 6px 0 0 #000000',
            titleColor: '#000000',
            descColor: '#1F2937',
            itemBg: '#FFFDF5',
            itemTitleColor: '#000000',
            itemDescColor: '#374151',
            itemBorderColor: '#000000',
            itemBorderStyle: 'solid',
            itemBorderWidth: '3px',
            itemRadius: '0px',
            upColor: '#FF3B30',
            downColor: '#10B981',
            btnBg: '#FF6B6B',
            btnColor: '#000000',
            btnRadius: '0px',
            btnBorderColor: '#000000',
            btnBorderStyle: 'solid',
            btnBorderWidth: '3px',
            btnShadow: '4px 4px 0 0 #000000',
            tagBg: '#FFE66D',
            tagColor: '#000000',
            tagBorderColor: '#000000',
            tagBorderStyle: 'solid',
            tagBorderWidth: '2px',
            tagRadius: '0px',
        },
    },
    {
        id: 'genz-chaos',
        name: 'Z世代混乱',
        desc: 'Gen Z Chaos · 倾斜贴纸涂鸦',
        source: '#57',
        tokens: {
            pageBg: '#1A1A2E',
            fontFamily: "'Clash Display', 'Space Grotesk', sans-serif",
            numberFontFamily: "'Space Mono', monospace",
            cardBg: 'rgba(255, 255, 255, 0.06)',
            cardBorderColor: 'rgba(255, 255, 255, 0.16)',
            cardBorderWidth: '2px',
            cardRadius: '24px',
            cardShadow: 'none',
            titleColor: '#FFFFFF',
            descColor: 'rgba(255, 255, 255, 0.7)',
            itemBg: 'rgba(255, 255, 255, 0.08)',
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.6)',
            itemBorderColor: 'rgba(255, 255, 255, 0.3)',
            itemBorderStyle: 'dashed',
            itemBorderWidth: '2px',
            itemRadius: '20px',
            upColor: '#FF6B6B',
            downColor: '#4ECDC4',
            btnBg: '#FF6B6B',
            btnColor: '#FFFFFF',
            btnRadius: '999px',
            btnBorderColor: '#FF6B6B',
            btnBorderStyle: 'solid',
            btnBorderWidth: '2px',
            btnFontFamily: "'Space Mono', monospace",
            btnShadow: '3px 3px 0 rgba(0, 0, 0, 0.3)',
            tagBg: '#FFE66D',
            tagColor: '#000000',
            tagFontFamily: "'Space Mono', monospace",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
        },
    },
    {
        id: 'soft-ui-neu',
        name: '柔光新拟态',
        desc: 'Soft UI · 凸面双影浮雕',
        source: '自定义',
        tokens: {
            pageBg: '#dde1e7',
            fontFamily: "'Albert Sans', -apple-system, 'PingFang SC', sans-serif",
            numberFontFamily: "'Fragment Mono', 'SF Mono', monospace",
            cardBg: '#dde1e7',
            cardBorderColor: '#dde1e7',
            cardBorderWidth: '1px',
            cardRadius: '20px',
            cardShadow: '8px 8px 20px rgba(0, 0, 0, 0.07), -8px -8px 20px rgba(255, 255, 255, 0.9)',
            titleColor: '#334155',
            descColor: '#7c8aa0',
            itemBg: '#dde1e7',
            itemTitleColor: '#334155',
            itemDescColor: '#8b99ae',
            itemBorderColor: '#dde1e7',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '12px',
            upColor: '#e11d48',
            downColor: '#0d9488',
            btnBg: '#6366f1',
            btnColor: '#ffffff',
            btnRadius: '12px',
            btnBorderColor: '#6366f1',
            btnBorderStyle: 'solid',
            btnBorderWidth: '1px',
            btnShadow: '6px 6px 14px rgba(99, 102, 241, 0.35), -4px -4px 10px rgba(255, 255, 255, 0.8)',
            tagBg: '#dde1e7',
            tagColor: '#6366f1',
            tagFontFamily: "'Fragment Mono', monospace",
            tagBorderColor: '#dde1e7',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '10px',
        },
    },
    {
        "id": "modern-gradient",
        "name": "现代渐变风",
        "desc": "Modern Gradient · 多彩玻璃态与动态光影",
        "source": "/styles/modern-gradient",
        "tokens": {
            "pageBg": "linear-gradient(135deg, #020617 0%, #1e1b4b 100%)",
            "fontFamily": "'Inter', -apple-system, 'PingFang SC', sans-serif",
            "numberFontFamily": "'JetBrains Mono', 'SF Mono', monospace",
            "cardBg": "rgba(255, 255, 255, 0.1)",
            "cardBorderColor": "rgba(255, 255, 255, 0.2)",
            "cardBorderWidth": "1px",
            "cardRadius": "24px",
            "cardShadow": "0 20px 25px -5px rgba(139, 92, 246, 0.25), 0 8px 10px -6px rgba(139, 92, 246, 0.1)",
            "titleColor": "#ffffff",
            "descColor": "rgba(255, 255, 255, 0.8)",
            "itemBg": "rgba(255, 255, 255, 0.05)",
            "itemTitleColor": "#ffffff",
            "itemDescColor": "rgba(255, 255, 255, 0.6)",
            "itemBorderColor": "rgba(255, 255, 255, 0.1)",
            "itemBorderStyle": "solid",
            "itemBorderWidth": "1px",
            "itemRadius": "16px",
            "upColor": "#d946ef",
            "downColor": "#06b6d4",
            "btnBg": "linear-gradient(90deg, #7c3aed, #db2777)",
            "btnColor": "#ffffff",
            "btnRadius": "16px",
            "btnBorderColor": "transparent",
            "btnBorderStyle": "solid",
            "btnBorderWidth": "0px",
            "btnFontFamily": "'Inter', sans-serif",
            "btnShadow": "0 10px 15px -3px rgba(124, 58, 237, 0.4), 0 4px 6px -4px rgba(124, 58, 237, 0.2)",
            "tagBg": "rgba(139, 92, 246, 0.2)",
            "tagColor": "#e879f9",
            "tagFontFamily": "'Inter', sans-serif",
            "tagBorderColor": "rgba(139, 92, 246, 0.3)",
            "tagBorderStyle": "solid",
            "tagBorderWidth": "1px",
            "tagRadius": "999px"
        },
    },
    {
        "id": "memphis",
        "name": "孟菲斯风格",
        "desc": "Memphis · 大胆撞色与几何游乐场",
        "source": "/styles/memphis",
        "tokens": {
            "pageBg": "#fef9ef",
            "fontFamily": "'Space Grotesk', 'Arial Black', sans-serif",
            "numberFontFamily": "'Courier Prime', 'Courier New', monospace",
            "cardBg": "#ffffff",
            "cardBorderColor": "#000000",
            "cardBorderWidth": "4px",
            "cardRadius": "0px",
            "cardShadow": "5px 5px 0px 0px rgba(0,0,0,1)",
            "titleColor": "#000000",
            "descColor": "#2d3436",
            "itemBg": "#feca57",
            "itemTitleColor": "#000000",
            "itemDescColor": "#000000",
            "itemBorderColor": "#000000",
            "itemBorderStyle": "solid",
            "itemBorderWidth": "4px",
            "itemRadius": "0px",
            "upColor": "#e815e5ff",
            "downColor": "#077c15ff",
            "btnBg": "#ff6b6b",
            "btnColor": "#000000",
            "btnRadius": "0px",
            "btnBorderColor": "#000000",
            "btnBorderStyle": "solid",
            "btnBorderWidth": "4px",
            "btnFontFamily": "'Space Grotesk', sans-serif",
            "btnShadow": "5px 5px 0px 0px rgba(0,0,0,1)",
            "tagBg": "#48dbfb",
            "tagColor": "#000000",
            "tagFontFamily": "'Space Grotesk', sans-serif",
            "tagBorderColor": "#000000",
            "tagBorderStyle": "solid",
            "tagBorderWidth": "4px",
            "tagRadius": "0px"
        }
    },
    {
        id: 'soft-ui',
        name: '柔和界面风',
        desc: 'Soft UI · 柔和圆润友好界面',
        source: 'STYLEKIT_STYLE_REFERENCE',
        tokens: {
            pageBg: 'linear-gradient(160deg, #f8fafc 0%, #eef2ff 100%)',
            fontFamily: "'Nunito Sans', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
            numberFontFamily: "'IBM Plex Mono', 'SF Mono', monospace",
            cardBg: '#ffffff',
            cardBorderColor: 'transparent',
            cardBorderWidth: '0',
            cardRadius: '24px',
            cardShadow: '0 20px 25px -5px rgba(226, 232, 240, 0.5), 0 8px 10px -6px rgba(226, 232, 240, 0.5)',
            titleColor: '#1f2937',
            descColor: '#6b7280',
            itemBg: '#f9fafb',
            itemTitleColor: '#1f2937',
            itemDescColor: '#6b7280',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0',
            itemRadius: '16px',
            upColor: '#db2777',
            downColor: '#059669',
            btnBg: '#4f46e5',
            btnColor: '#ffffff',
            btnRadius: '16px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0',
            btnFontFamily: "'Nunito Sans', -apple-system, 'PingFang SC', sans-serif",
            btnShadow: '0 10px 15px -3px rgba(79, 70, 229, 0.3), 0 4px 6px -4px rgba(79, 70, 229, 0.3)',
            tagBg: 'rgba(99, 102, 241, 0.1)',
            tagColor: '#4f46e5',
            tagFontFamily: "'Nunito Sans', -apple-system, 'PingFang SC', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0',
            tagRadius: '999px',
        },
    },
    {
        "id": "neon-gradient",
        "name": "霓虹渐变",
        "desc": "Neon Gradient · 深色画布与高饱和发光渐变",
        "source": "/styles/neon-gradient",
        "tokens": {
            "pageBg": "#0f0a1e",
            "fontFamily": "'Outfit', 'Segoe UI', sans-serif",
            "numberFontFamily": "'Fira Code', monospace",
            "cardBg": "linear-gradient(135deg, #a855f7, #ec4899)",
            "cardBorderColor": "#fbbf24",
            "cardBorderWidth": "4px",
            "cardRadius": "24px",
            "cardShadow": "0 0 30px rgba(168, 85, 247, 0.4)",
            "titleColor": "#ffffff",
            "descColor": "rgba(255, 255, 255, 0.8)",
            "itemBg": "rgba(255, 255, 255, 0.05)",
            "itemTitleColor": "#ffffff",
            "itemDescColor": "rgba(255, 255, 255, 0.7)",
            "itemBorderColor": "rgba(168, 85, 247, 0.5)",
            "itemBorderStyle": "solid",
            "itemBorderWidth": "2px",
            "itemRadius": "16px",
            "upColor": "#fb7185",
            "downColor": "#a3e635",
            "btnBg": "linear-gradient(90deg, #22d3ee, #ec4899)",
            "btnColor": "#ffffff",
            "btnRadius": "16px",
            "btnBorderColor": "rgba(255, 255, 255, 0.2)",
            "btnBorderStyle": "solid",
            "btnBorderWidth": "2px",
            "btnFontFamily": "'Outfit', sans-serif",
            "btnShadow": "0 0 20px rgba(236, 72, 153, 0.5)",
            "tagBg": "rgba(34, 211, 238, 0.15)",
            "tagColor": "#22d3ee",
            "tagFontFamily": "'Outfit', sans-serif",
            "tagBorderColor": "rgba(34, 211, 238, 0.4)",
            "tagBorderStyle": "solid",
            "tagBorderWidth": "1px",
            "tagRadius": "999px"
        }
    },
    {
        "id": "liquid-glass2",
        "name": "Apple 流动玻璃",
        "desc": "Liquid Glass · WWDC25 霓虹描边与流体折射",
        "source": "/styles/liquid-glass",
        "tokens": {
            "pageBg": "#0f0f23",
            "fontFamily": "'SF Pro Display', -apple-system, 'PingFang SC', sans-serif",
            "numberFontFamily": "'SF Mono', 'Menlo', monospace",
            "cardBg": "rgba(255, 255, 255, 0.1)",
            "cardBorderColor": "rgba(255, 255, 255, 0.2)",
            "cardBorderWidth": "1px",
            "cardRadius": "24px",
            "cardShadow": "0 20px 40px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.4)",
            "titleColor": "#ffffff",
            "descColor": "rgba(255, 255, 255, 0.8)",
            "itemBg": "rgba(255, 255, 255, 0.08)",
            "itemTitleColor": "#ffffff",
            "itemDescColor": "rgba(255, 255, 255, 0.7)",
            "itemBorderColor": "rgba(255, 255, 255, 0.15)",
            "itemBorderStyle": "solid",
            "itemBorderWidth": "1px",
            "itemRadius": "16px",
            "upColor": "#ff2d92",
            "downColor": "#4ecdc4",
            "btnBg": "linear-gradient(90deg, #ff2d92, #a855f7)",
            "btnColor": "#ffffff",
            "btnRadius": "20px",
            "btnBorderColor": "rgba(255, 255, 255, 0.2)",
            "btnBorderStyle": "solid",
            "btnBorderWidth": "1px",
            "btnFontFamily": "'SF Pro Display', sans-serif",
            "btnShadow": "0 0 20px rgba(168, 85, 247, 0.3)",
            "tagBg": "rgba(78, 205, 196, 0.15)",
            "tagColor": "#4ecdc4",
            "tagFontFamily": "'SF Pro Display', sans-serif",
            "tagBorderColor": "rgba(78, 205, 196, 0.3)",
            "tagBorderStyle": "solid",
            "tagBorderWidth": "1px",
            "tagRadius": "999px"
        }
    },
    {
        "id": "holographic",
        "name": "全息渐变",
        "desc": "Holographic · 棱镜折射与宇宙深空虹彩",
        "source": "/styles/holographic",
        "tokens": {
            "pageBg": "#0a0a1f",
            "fontFamily": "'Space Grotesk', 'Inter', sans-serif",
            "numberFontFamily": "'JetBrains Mono', monospace",
            "cardBg": "rgba(255, 255, 255, 0.05)",
            "cardBorderColor": "rgba(255, 255, 255, 0.1)",
            "cardBorderWidth": "1px",
            "cardRadius": "16px",
            "cardShadow": "0 0 20px rgba(147, 51, 234, 0.2)",
            "titleColor": "#ffffff",
            "descColor": "rgba(255, 255, 255, 0.7)",
            "itemBg": "rgba(255, 255, 255, 0.03)",
            "itemTitleColor": "#ffffff",
            "itemDescColor": "rgba(255, 255, 255, 0.6)",
            "itemBorderColor": "rgba(255, 255, 255, 0.08)",
            "itemBorderStyle": "solid",
            "itemBorderWidth": "1px",
            "itemRadius": "12px",
            "upColor": "#00ff88",
            "downColor": "#ff0080",
            "btnBg": "linear-gradient(90deg, #ff0080, #7928ca, #00d4ff)",
            "btnColor": "#ffffff",
            "btnRadius": "12px",
            "btnBorderColor": "transparent",
            "btnBorderStyle": "solid",
            "btnBorderWidth": "0px",
            "btnFontFamily": "'Space Grotesk', sans-serif",
            "btnShadow": "0 0 25px rgba(147, 51, 234, 0.4)",
            "tagBg": "linear-gradient(135deg, rgba(255,0,128,0.2), rgba(0,212,255,0.2))",
            "tagColor": "#00d4ff",
            "tagFontFamily": "'Space Grotesk', sans-serif",
            "tagBorderColor": "rgba(255, 255, 255, 0.15)",
            "tagBorderStyle": "solid",
            "tagBorderWidth": "1px",
            "tagRadius": "999px"
        }
    },
    {
        id: 'maximalism',
        name: '极繁主义',
        desc: 'Maximalism · 饱和撞色与多重装饰',
        source: '自定义',
        tokens: {
            pageBg: '#1a0a2e',
            fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
            numberFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            cardBg: '#1a0a2e',
            cardBorderColor: '#d4145a',
            cardBorderWidth: '4px',
            cardRadius: '4px',
            cardShadow: '4px 4px 0px #ffbe0b, 8px 8px 0px #3a86ff',
            titleColor: '#ffffff',
            descColor: 'rgba(131, 56, 236, 0.7)',
            itemBg: '#1a0a2e',
            itemTitleColor: '#ffffff',
            itemDescColor: '#ffbe0b',
            itemBorderColor: '#8338ec',
            itemBorderStyle: 'dashed',
            itemBorderWidth: '3px',
            itemRadius: '4px',
            upColor: '#d4145a',
            downColor: '#06d6a0',
            btnBg: '#d4145a', // 去掉了渐变叠加，改用纯粹的热粉色饱和撞色，减少过度重叠感
            btnColor: '#ffffff',
            btnRadius: '4px',
            btnBorderColor: '#ffbe0b',
            btnBorderStyle: 'solid',
            btnBorderWidth: '2px',
            btnFontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
            btnShadow: '4px 4px 0px #ffbe0b, 8px 8px 0px #3a86ff',
            tagBg: 'transparent',
            tagColor: '#06d6a0',
            tagFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            tagBorderColor: '#06d6a0',
            tagBorderStyle: 'solid',
            tagBorderWidth: '4px',
            tagRadius: '4px',
        },
    },
    {
        id: 'dopamine',
        name: '多巴胺设计',
        desc: 'Dopamine Design · 高饱和霓虹与愉悦能量',
        source: '自定义',
        tokens: {
            pageBg: 'linear-gradient(135deg, #fff0f6 0%, #f3e8ff 50%, #e6f0ff 100%)',
            fontFamily: "'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
                      numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: '#ffffff',
            cardBorderColor: 'rgba(255, 0, 110, 0.2)',
            cardBorderWidth: '2px',
            cardRadius: '24px',
            cardShadow: '0 8px 30px rgba(255, 0, 110, 0.25)',
            titleColor: '#1a1a2e',
            descColor: 'rgba(26, 26, 46, 0.7)',
            itemBg: '#f8f0ff',
            itemTitleColor: '#1a1a2e',
            itemDescColor: 'rgba(26, 26, 46, 0.65)',
            itemBorderColor: 'rgba(131, 56, 236, 0.2)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '2px',
            itemRadius: '16px',
            upColor: '#ff006e',
            downColor: '#06d6a0',
            btnBg: '#8338ec',
            btnColor: '#ffffff',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            btnShadow: '0 8px 30px rgba(255, 0, 110, 0.4)',
            tagBg: 'rgba(255, 190, 11, 0.25)',
            tagColor: '#1a1a2e',
            tagFontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
        },
    },
    {
        id: 'shader-gradient',
        name: '着色器渐变',
        desc: 'Shader Gradient · 实时 WebGL 流动与冻毛玻璃',
        source: '自定义',
        tokens: {
            pageBg: '#08090D',
            fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            numberFontFamily: "'JetBrains Mono', monospace",
            cardBg: 'rgba(255, 255, 255, 0.06)',
            cardBorderColor: 'rgba(255, 255, 255, 0.1)',
            cardBorderWidth: '1px',
            cardRadius: '16px',
            cardShadow: '0 20px 60px rgba(0, 0, 0, 0.45)',
            titleColor: '#ffffff',
            descColor: 'rgba(255, 255, 255, 0.7)',
            itemBg: 'rgba(255, 255, 255, 0.04)',
            itemTitleColor: '#ffffff',
            itemDescColor: 'rgba(255, 255, 255, 0.5)',
            itemBorderColor: 'rgba(255, 255, 255, 0.08)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '12px',
            upColor: '#22D3EE',
            downColor: '#F472B6',
            btnBg: '#7C5CFF',
            btnColor: '#ffffff',
            btnRadius: '12px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', system-ui, sans-serif",
            btnShadow: '0 4px 20px rgba(124, 92, 255, 0.35)',
            tagBg: 'rgba(124, 92, 255, 0.15)',
            tagColor: '#7C5CFF',
            tagFontFamily: "'JetBrains Mono', monospace",
            tagBorderColor: 'rgba(124, 92, 255, 0.3)',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '999px',
        },
    },
    {
        id: 'neon-glass-dark',
        name: '霓虹玻璃暗夜',
        desc: 'Neon Glass Dark · 深色玻璃拟态与霓虹渐变',
        source: '#uploaded-image',
        tokens: {
            pageBg: '#0F172A',
            fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(30, 41, 59, 0.6)',
            cardBorderColor: 'rgba(255, 255, 255, 0.08)',
            cardBorderWidth: '1px',
            cardRadius: '16px',
            cardShadow: '0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            titleColor: '#FFFFFF',
            descColor: 'rgba(255, 255, 255, 0.65)',
            itemBg: 'rgba(255, 255, 255, 0.04)',
            itemTitleColor: '#F1F5F9',
            itemDescColor: 'rgba(255, 255, 255, 0.5)',
            itemBorderColor: 'rgba(255, 255, 255, 0.06)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '12px',
            upColor: '#FF6B9D',
            downColor: '#00D2FF',
            btnBg: 'linear-gradient(135deg, #6C5CE7 0%, #00D2FF 100%)',
            btnColor: '#FFFFFF',
            btnRadius: '12px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', sans-serif",
            btnShadow: '0 4px 15px rgba(108, 92, 231, 0.4)',
            tagBg: 'rgba(108, 92, 231, 0.15)',
            tagColor: '#A78BFA',
            tagFontFamily: "'Inter', sans-serif",
            tagBorderColor: 'rgba(108, 92, 231, 0.3)',
            tagBorderStyle: 'solid',
            tagBorderWidth: '1px',
            tagRadius: '8px',
        },
    },
    {
        id: 'pixel-flux-neon',
        name: '像素流彩霓虹',
        desc: 'Pixel Flux Neon · 噪点背景 + 像素化渐变爆炸效果',
        source: '#uploaded-image-3',
        tokens: {
            pageBg: '#0A0508', // 深紫黑带微噪点
            fontFamily: "'Inter', 'Satoshi', 'Helvetica Neue', sans-serif",
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(20, 10, 25, 0.7)',
            cardBorderColor: 'rgba(255, 255, 255, 0.1)',
            cardBorderWidth: '1px',
            cardRadius: '16px',
            cardShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            titleColor: '#FFFFFF',
            descColor: 'rgba(255, 255, 255, 0.6)',
            itemBg: 'rgba(255, 255, 255, 0.05)',
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.5)',
            itemBorderColor: 'rgba(255, 255, 255, 0.08)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '12px',
            upColor: '#FF00FF', // 荧光粉
            downColor: '#00FFFF', // 荧光青
            btnBg: 'linear-gradient(135deg, #FF00FF 0%, #00FFFF 50%, #FFD700 100%)',
            btnColor: '#000000',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Space Grotesk', 'Clash Display', sans-serif",
            btnShadow: '0 4px 20px rgba(255, 0, 255, 0.4)',
            tagBg: '#FF00FF',
            tagColor: '#FFFFFF',
            tagFontFamily: "'JetBrains Mono', monospace",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '6px',
            // 特有像素/噪点风格 Tokens
            pixelSize: '4px',
            noiseOpacity: '0.08',
            gradientColors: ['#FF00FF', '#00FFFF', '#FFD700', '#8A2BE2', '#FF4500'],
            accentGlow: '0 0 20px rgba(255, 0, 255, 0.6)',
        },
    },
    {
        id: 'vr-commerce-glow',
        name: 'VR商域光晕',
        desc: 'VR Commerce Glow · 深色沉浸 + 橙光产品轮廓 + AI助手交互',
        source: '#uploaded-image-5',
        tokens: {
            pageBg: '#0A0A0A',
            fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(20, 20, 20, 0.8)',
            cardBorderColor: 'rgba(255, 140, 0, 0.15)',
            cardBorderWidth: '1px',
            cardRadius: '20px',
            cardShadow: '0 8px 32px rgba(255, 140, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            titleColor: '#FFFFFF',
            descColor: 'rgba(255, 255, 255, 0.7)',
            itemBg: 'rgba(255, 255, 255, 0.06)',
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.5)',
            itemBorderColor: 'rgba(255, 140, 0, 0.2)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '16px',
            upColor: '#FF8C00', // 主品牌橙
            downColor: '#FF4500', // 深橙用于折扣/警告
            btnBg: '#FF8C00',
            btnColor: '#000000',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', sans-serif",
            btnShadow: '0 4px 20px rgba(255, 140, 0, 0.4)',
            tagBg: '#FF8C00',
            tagColor: '#000000',
            tagFontFamily: "'Inter', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '6px',
            // 特有产品光效 & AI 元素
            productGlowColor: '#FF8C00',
            productGlowBlur: '20px',
            aiAssistantBg: 'rgba(255, 140, 0, 0.1)',
            aiAssistantBorder: '1px solid rgba(255, 140, 0, 0.3)',
            aiAssistantRadius: '16px',
            searchInputBg: 'rgba(255, 255, 255, 0.08)',
            searchInputColor: '#FFFFFF',
            searchInputBorder: '1px solid rgba(255, 255, 255, 0.1)',
            navIconActive: '#FF8C00',
            navIconInactive: 'rgba(255, 255, 255, 0.4)',
            priceOriginalColor: 'rgba(255, 255, 255, 0.4)',
            priceDiscountColor: '#FF4500',
            ratingStarColor: '#FFD700',
        },
    },
    {
        id: 'onro-glass-dashboard',
        name: 'Onro玻璃仪表',
        desc: 'Onro Glass Dashboard · 磨砂蓝调 + 悬浮卡片 + 建筑透视背景',
        source: '#uploaded-image-9',
        tokens: {
            pageBg: '#E8F4FF', // 浅天蓝背景
            fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(255, 255, 255, 0.65)', // 半透明白底
            cardBorderColor: 'rgba(255, 255, 255, 0.4)',
            cardBorderWidth: '1px',
            cardRadius: '20px',
            cardShadow: '0 8px 32px rgba(31, 38, 135, 0.1)', // 柔和高斯阴影
            cardBackdropFilter: 'blur(12px) saturate(180%)', // 关键：磨砂玻璃效果
            titleColor: '#1A237E', // 深蓝标题
            descColor: '#5C6BC0', // 中蓝描述
            itemBg: 'rgba(255, 255, 255, 0.4)',
            itemTitleColor: '#1A237E',
            itemDescColor: '#5C6BC0',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0px',
            itemRadius: '16px',
            upColor: '#FF5252', // 绿色收入/正常
            downColor: '#4CAF50', // 红色支出/异常
            btnBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', // 蓝紫渐变按钮
            btnColor: '#FFFFFF',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', sans-serif",
            btnShadow: '0 4px 16px rgba(102, 126, 234, 0.3)',
            tagBg: 'rgba(102, 126, 234, 0.1)',
            tagColor: '#667eea',
            tagFontFamily: "'Inter', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '8px',
            // 特有玻璃拟态 & 数据可视化 Tokens
            glassOverlay: 'linear-gradient(135deg, rgba(255,255,255,0.1), rgba(255,255,255,0))',
            chartLineColor: '#667eea',
            chartGridColor: 'rgba(102, 126, 234, 0.1)',
            statValueColor: '#1A237E',
            statLabelColor: '#5C6BC0',
            navActiveBg: 'rgba(102, 126, 234, 0.15)',
            navActiveColor: '#667eea',
            navInactiveColor: '#9FA8DA',
            floatingCardZIndex: '100',
            backgroundBlurIntensity: '8px',
            accentGradientStart: '#667eea',
            accentGradientEnd: '#764ba2',
            iconActiveColor: '#667eea',
            iconInactiveColor: '#9FA8DA',
            tooltipBg: 'rgba(255, 255, 255, 0.9)',
            tooltipColor: '#1A237E',
            tooltipBorder: '1px solid rgba(102, 126, 234, 0.2)',
        },
    },
    {
        id: 'warm-learning-dashboard',
        name: '暖橙学术仪表盘',
        desc: 'Warm Learning Dashboard · 暖橙柔调 + 多彩卡片 + 3D悬浮插图',
        source: '#uploaded-image-1',
        tokens: {
            pageBg: '#FFC8A2', // 暖橙色背景
            fontFamily: "'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif",
                       numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: '#F8F6F4', // 米白色主主板背景
            cardBorderColor: 'transparent',
            cardBorderWidth: '0px',
            cardRadius: '24px',
            cardShadow: '0 20px 40px rgba(220, 120, 70, 0.15)',
            cardBackdropFilter: 'none',
            titleColor: '#1E1E24', // 深灰/近黑主标题
            descColor: '#7A7A85', // 中灰次要描述
            itemBg: '#FFFFFF', // 纯白子卡片背景
            itemTitleColor: '#1E1E24',
            itemDescColor: '#7A7A85',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0px',
            itemRadius: '16px',
            upColor: '#FF6B50', // 品牌主橙色（高亮/警示/按钮）
            downColor: '#4ECDC4', // 薄荷绿/辅助色
            btnBg: '#FF6B50', // 亮橙色主按钮
            btnColor: '#FFFFFF',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Plus Jakarta Sans', sans-serif",
            btnShadow: '0 8px 16px rgba(255, 107, 80, 0.25)',
            tagBg: '#F5F5F7',
            tagColor: '#7A7A85',
            tagFontFamily: "'Plus Jakarta Sans', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '8px',
            // 特有色彩卡片与仪表盘 Tokens
            primaryAccent: '#FF6B50', // 主色调：珊瑚橙
            cardPinkBg: '#F9D8D6', // 粉红卡片背景 (Assignments due)
            cardPinkColor: '#D9534F',
            cardGreenBg: '#D2F3E0', // 浅绿卡片背景 (Assignments to check)
            cardGreenColor: '#2E7D32',
            cardPurpleBg: '#E0DBFF', // 浅紫卡片背景 (Free time slots)
            cardPurpleColor: '#5C46E5',
            cardOrangeBg: '#FFE6D2', // 浅橙卡片背景 (Classes this week)
            cardOrangeColor: '#E66A2C',
            navActiveBg: '#FF6B50',
            navActiveColor: '#FFFFFF',
            navInactiveBg: '#FFFFFF',
            navInactiveColor: '#9E9EA7',
            calendarHighlightBg: '#FF8A65',
            calendarHighlightColor: '#FFFFFF',
            schedulePurpleBg: '#E8E5FF',
            scheduleOrangeBg: '#FFF0E5',
            scheduleGreenBg: '#E1F8ED',
            iconActiveColor: '#FFFFFF',
            iconInactiveColor: '#9E9EA7',
            sidebarBg: '#FFFFFF',
            sidebarRadius: '20px'
        },
    },
    {
        id: 'apeluid-electric-purple',
        name: 'Apeluid 电光紫风格',
        desc: 'Apeluid Electric Purple · 暗黑高饱和紫 + 极简大圆角卡片 + 多色交互胶囊标签',
        source: '#uploaded-image',
        tokens: {
            pageBg: '#0A0A12', // 极深黑紫背景
            fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: '#3B38EE', // 高饱和宝蓝/亮紫主卡片底色
            cardBorderColor: 'transparent',
            cardBorderWidth: '0px',
            cardRadius: '24px', // 大圆角卡片
            cardShadow: '0 12px 40px rgba(0, 0, 0, 0.35)', // 深邃阴影
            cardBackdropFilter: 'none',
            titleColor: '#FFFFFF', // 纯白标题
            descColor: 'rgba(255, 255, 255, 0.7)', // 半透明白描述文字
            itemBg: '#12102B', // 卡片内部深色子项/胶囊底色
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.6)',
            itemBorderColor: 'rgba(255, 255, 255, 0.15)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '999px',
            upColor: '#A855F7', // 亮紫色（上升/强调）
            downColor: '#38BDF8', // 青蓝色（下降/辅助）
            btnBg: '#0D0B18', // 黑色纯色胶囊按钮
            btnColor: '#FFFFFF',
            btnRadius: '999px', // 纯圆角胶囊
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', sans-serif",
            btnShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
            tagBg: '#D8B4FE', // 淡紫粉胶囊标签背景
            tagColor: '#3B38EE', // 主色文字
            tagFontFamily: "'Inter', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
            // 特有视觉 & 渐变 Tokens
            glassOverlay: 'linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0))',
            chartLineColor: '#A855F7',
            chartGridColor: 'rgba(255, 255, 255, 0.1)',
            statValueColor: '#FFFFFF',
            statLabelColor: 'rgba(255, 255, 255, 0.7)',
            navActiveBg: '#3B38EE',
            navActiveColor: '#FFFFFF',
            navInactiveColor: 'rgba(255, 255, 255, 0.4)',
            floatingCardZIndex: '100',
            backgroundBlurIntensity: '0px',
            accentGradientStart: '#3B38EE',
            accentGradientEnd: '#C084FC', // 蓝紫到粉紫渐变
            iconActiveColor: '#FFFFFF',
            iconInactiveColor: 'rgba(255, 255, 255, 0.5)',
            tooltipBg: '#0D0B18',
            tooltipColor: '#FFFFFF',
            tooltipBorder: '1px solid rgba(255, 255, 255, 0.1)',
        },
    },
    {
        id: 'kiddora-playful-kids-learning',
        name: 'Kiddora 欢快儿童教育风格',
        desc: 'Kiddora Playful Kids Learning · 暖调奶油渐变底色 + 缤纷彩色高饱和元素 + 柔和通透悬浮卡片',
        source: '#uploaded-image-6',
        tokens: {
            pageBg: 'linear-gradient(180deg, #FFF5EE 0%, #FAF0E6 50%, #F5E6FF 100%)', // 暖粉杏色到柔紫渐变背景[cite: 6]
            fontFamily: "'Fredoka', 'Quicksand', -apple-system, sans-serif", // 圆润亲和的儿童字体风格[cite: 6]
                       numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(255, 255, 255, 0.85)', // 柔和半透明纯白悬浮卡片[cite: 6]
            cardBorderColor: 'rgba(255, 255, 255, 0.9)',
            cardBorderWidth: '1.5px',
            cardRadius: '32px', // 特大超圆润卡片圆角[cite: 6]
            cardShadow: '0 16px 40px rgba(108, 92, 231, 0.08)', // 柔和紫调散发阴影
            cardBackdropFilter: 'blur(10px)',
            titleColor: '#3A2898', // 浓郁深紫标题[cite: 6]
            descColor: '#5D6B98', // 柔和蓝灰描述文字[cite: 6]
            itemBg: '#FFF9E6', // 暖黄子项背景
            itemTitleColor: '#3A2898',
            itemDescColor: '#5D6B98',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0px',
            itemRadius: '20px',
            upColor: '#FF3D00', // 活力绿
            downColor: '#00C853', // 活力橙红
            btnBg: '#6C5CE7', // 鲜亮紫色圆形/胶囊按钮[cite: 6]
            btnColor: '#FFFFFF', // 纯白按钮文本/图标[cite: 6]
            btnRadius: '999px', // 纯圆按钮[cite: 6]
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Fredoka', sans-serif",
            btnShadow: '0 8px 20px rgba(108, 92, 231, 0.35)', // 亮紫色柔和阴影
            tagBg: '#FFEAA7', // 明黄标签/装饰色[cite: 6]
            tagColor: '#D63031',
            tagFontFamily: "'Fredoka', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
            // 儿童教育与多色主题 Tokens
            glassOverlay: 'none',
            chartLineColor: '#6C5CE7',
            chartGridColor: 'rgba(108, 92, 231, 0.05)',
            statValueColor: '#3A2898',
            statLabelColor: '#5D6B98',
            navActiveBg: '#6C5CE7', // 活跃指示点紫色[cite: 6]
            navActiveColor: '#FFFFFF',
            navInactiveColor: '#D6D1F8', // 未选中指示点浅灰紫[cite: 6]
            floatingCardZIndex: '100',
            backgroundBlurIntensity: '8px',
            accentGradientStart: '#6C5CE7', // 活力紫[cite: 6]
            accentGradientEnd: '#FF7675', // 珊瑚粉[cite: 6]
            iconActiveColor: '#FFFFFF',
            iconInactiveColor: '#A29BFE',
            tooltipBg: '#FFFFFF',
            tooltipColor: '#3A2898',
            tooltipBorder: '1px solid rgba(108, 92, 231, 0.15)',
            // Kiddora 缤纷儿童特有色盘 Tokens
            brandBlue: '#2D52E5', // Logo 蓝[cite: 6]
            brandOrange: '#FF9F1C', // Logo 橙[cite: 6]
            brandCyan: '#00CECB', // Logo 青蓝[cite: 6]
            brandYellow: '#FFD166', // 3D星星暖黄[cite: 6]
            paginationDotActive: '#6C5CE7', // 分页指示器激活点[cite: 6]
            paginationDotInactive: '#E0D8F9', // 分页指示器未激活点[cite: 6]
        },
    },
    {
        id: 'kiddora-discover-3d-clay',
        name: 'Kiddora 3D立体探究教育风格',
        desc: 'Kiddora Discover 3D Clay · 梦幻淡紫柔粉底色 + 3D粘土软萌图标 + 高饱和圆角悬浮面板',
        source: '#uploaded-image-7',
        tokens: {
            pageBg: 'linear-gradient(180deg, #F8F3FF 0%, #FAF0F8 50%, #F5ECFF 100%)', // 梦幻极浅紫到粉紫渐变背景[cite: 7]
            fontFamily: "'Fredoka', 'Quicksand', -apple-system, sans-serif", // 圆润亲和儿童字体[cite: 7]
                       numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(255, 255, 255, 0.9)', // 半透明高亮纯白悬浮面板[cite: 7]
            cardBorderColor: 'rgba(255, 255, 255, 0.95)',
            cardBorderWidth: '1.5px',
            cardRadius: '32px', // 大圆角悬浮卡片[cite: 7]
            cardShadow: '0 16px 36px rgba(138, 92, 246, 0.08)', // 浅紫弥散柔阴影
            cardBackdropFilter: 'blur(12px)',
            titleColor: '#1E1B4B', // 深蓝紫标题[cite: 7]
            descColor: '#52525B', // 柔和灰紫描述文字[cite: 7]
            itemBg: '#F5F3FF', // 功能图标浅紫子项底色[cite: 7]
            itemTitleColor: '#1E1B4B',
            itemDescColor: '#52525B',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0px',
            itemRadius: '20px',
            upColor: '#F43F5E', // 活力绿[cite: 7]
            downColor: '#10B981', // 活力粉红[cite: 7]
            btnBg: '#7C3AED', // 鲜亮紫罗兰渐变/纯色按钮[cite: 7]
            btnColor: '#FFFFFF', // 纯白箭头图标/文本[cite: 7]
            btnRadius: '999px', // 圆形前进按钮[cite: 7]
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Fredoka', sans-serif",
            btnShadow: '0 8px 20px rgba(124, 58, 237, 0.35)', // 紫罗兰发光阴影
            tagBg: '#EDE9FE', // 浅紫胶囊标签背景[cite: 7]
            tagColor: '#6D28D9',
            tagFontFamily: "'Fredoka', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
            // 3D粘土 & 多色儿童功能分类 Tokens
            glassOverlay: 'none',
            chartLineColor: '#7C3AED',
            chartGridColor: 'rgba(124, 58, 237, 0.05)',
            statValueColor: '#1E1B4B',
            statLabelColor: '#52525B',
            navActiveBg: '#7C3AED', // 分页激活指示点[cite: 7]
            navActiveColor: '#FFFFFF',
            navInactiveColor: '#DDD6FE', // 未激活指示点[cite: 7]
            floatingCardZIndex: '100',
            backgroundBlurIntensity: '8px',
            accentGradientStart: '#7C3AED', // 主紫罗兰色[cite: 7]
            accentGradientEnd: '#EC4899', // 亮粉红[cite: 7]
            iconActiveColor: '#FFFFFF',
            iconInactiveColor: '#A78BFA',
            tooltipBg: '#FFFFFF',
            tooltipColor: '#1E1B4B',
            tooltipBorder: '1px solid rgba(124, 58, 237, 0.15)',
            // 3D 粘土图标与多元分类特色 Tokens
            clayPurpleBg: '#C084FC', // 3D书本图标紫底[cite: 7]
            clayPinkBg: '#FB7185', // 3D画板图标粉红底[cite: 7]
            clayGreenBg: '#34D399', // 3D烧杯图标薄荷绿底[cite: 7]
            clayBlueLaptop: '#A5B4FC', // 3D笔记本电脑柔紫蓝[cite: 7]
            clayYellowAccent: '#FBBF24', // 装饰小线条与星号暖黄[cite: 7]
        },
    },
    {
        id: 'upfound-emerald-dark-gradient',
        name: 'UpFound 极光翡翠暗黑渐变',
        desc: 'UpFound Emerald Dark · 深邃黑绿径向渐变背景 + 宝石绿亮色高光 + 极简现代化文字与胶囊按钮',
        source: '#uploaded-image-10',
        tokens: {
            pageBg: 'radial-gradient(circle at 50% 50%, #0D2D2A 0%, #040A0A 80%)', // 深绿到暗黑渐变背景[cite: 10, 11]
            fontFamily: "'PP Neue Montreal', 'Inter', -apple-system, sans-serif", // 第二图指定的字体[cite: 11]
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(255, 255, 255, 0.05)', // 微透暗色玻璃卡片[cite: 10]
            cardBorderColor: 'rgba(255, 255, 255, 0.1)',
            cardBorderWidth: '1px',
            cardRadius: '24px', // 圆润大卡片[cite: 10]
            cardShadow: '0 20px 50px rgba(4, 10, 10, 0.8)', // 极深沉浸式阴影[cite: 11]
            cardBackdropFilter: 'blur(16px)',
            titleColor: '#FFFFFF', // 纯白高亮标题[cite: 10, 11]
            descColor: 'rgba(255, 255, 255, 0.7)', // 半透明白次要文字[cite: 10]
            itemBg: 'rgba(255, 255, 255, 0.08)', // 胶囊导航/次级按钮微透背景[cite: 10]
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.6)',
            itemBorderColor: 'rgba(255, 255, 255, 0.12)',
            itemBorderStyle: 'solid',
            itemBorderWidth: '1px',
            itemRadius: '999px',
            upColor: '#22F2EF', // 第二图色板：荧光绿（涨/成功率）[cite: 10, 11]
            downColor: '#3EE97D', // 第二图色板：青蓝[cite: 11]
            btnBg: 'linear-gradient(135deg, #49DC7A 0%, #3EE97D 100%)', // 第二图色板渐变绿行动按钮[cite: 10, 11]
            btnColor: '#040A0A', // 黑色高对比度按钮文字[cite: 10, 11]
            btnRadius: '999px', // 纯圆胶囊按钮[cite: 10]
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'PP Neue Montreal', sans-serif", // 指定字体[cite: 11]
            btnShadow: '0 8px 24px rgba(62, 233, 125, 0.3)', // 荧光绿发光散影[cite: 11]
            tagBg: 'rgba(73, 220, 122, 0.15)',
            tagColor: '#49DC7A', // 第二图色板：薄荷绿[cite: 11]
            tagFontFamily: "'PP Neue Montreal', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
            // 图纸特定 & 第二图 Palette 指定 Token
            glassOverlay: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0))',
            chartLineColor: '#3EE97D',
            chartGridColor: 'rgba(255, 255, 255, 0.05)',
            statValueColor: '#FFFFFF',
            statLabelColor: 'rgba(255, 255, 255, 0.6)',
            navActiveBg: 'rgba(255, 255, 255, 0.15)',
            navActiveColor: '#FFFFFF',
            navInactiveColor: 'rgba(255, 255, 255, 0.6)',
            floatingCardZIndex: '100',
            backgroundBlurIntensity: '16px',
            accentGradientStart: '#49DC7A', // 色板 1：#49DC7A[cite: 11]
            accentGradientEnd: '#22F2EF', // 色板 3：#22F2EF[cite: 11]
            iconActiveColor: '#3EE97D',
            iconInactiveColor: 'rgba(255, 255, 255, 0.4)',
            tooltipBg: '#040A0A', // 色板 4：#040A0A[cite: 11]
            tooltipColor: '#FFFFFF', // 色板 5：#FFFFFF[cite: 11]
            tooltipBorder: '1px solid rgba(73, 220, 122, 0.2)',
            // Palette 精确对应色值列表（来自图二）
            paletteDarkBg: '#040A0A', // 深纯黑背景底色[cite: 11]
            palettePureWhite: '#FFFFFF', // 纯白文字/元素[cite: 11]
            paletteMintGreen: '#49DC7A', // 薄荷绿[cite: 11]
            paletteNeonGreen: '#3EE97D', // 鲜亮荧光绿[cite: 11]
            paletteElectricCyan: '#22F2EF', // 电光青蓝[cite: 11]
            typographyFont: 'PP Neue Montreal', // 指定排版字体[cite: 11]
        },
    },
    {
        id: 'strava-yearly-sport',
        name: 'Strava年度燃动',
        desc: 'Strava Yearly Sport · 紫橙流体渐变 + 粗体数据叙事 + 胶囊标签',
        source: '#uploaded-image-12',
        tokens: {
            pageBg: 'linear-gradient(160deg, #4C1D95 0%, #7C3AED 25%, #EC4899 55%, #F97316 85%, #FBBF24 100%)',
            fontFamily: "'Helvetica Now Display', 'Inter', -apple-system, sans-serif",
                       numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            cardBg: 'rgba(255, 255, 255, 0.12)',
            cardBorderColor: 'rgba(255, 255, 255, 0.2)',
            cardBorderWidth: '1px',
            cardRadius: '24px',
            cardShadow: '0 12px 40px rgba(76, 29, 149, 0.3)',
            cardBackdropFilter: 'blur(16px) saturate(180%)',
            titleColor: '#FFFFFF',
            descColor: 'rgba(255, 255, 255, 0.85)',
            itemBg: 'rgba(255, 255, 255, 0.08)',
            itemTitleColor: '#FFFFFF',
            itemDescColor: 'rgba(255, 255, 255, 0.75)',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0px',
            itemRadius: '16px',
            upColor: '#00D4FF',
            downColor: '#00FFC2', // 冰蓝：在橙黄区靠冷色相+高明度双重跳出，深紫区同样清晰
            btnBg: '#FFFFFF',
            btnColor: '#7C3AED',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Helvetica Now Display', sans-serif",
            btnShadow: '0 4px 16px rgba(255, 255, 255, 0.25)',
            tagBg: 'rgba(255, 255, 255, 0.2)',
            tagColor: '#FFFFFF',
            tagFontFamily: "'Helvetica Now Display', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '999px',
            activityIconColor: '#FFFFFF',
            distanceHighlight: '#FBBF24',
            elevationGradient: 'linear-gradient(to top, rgba(255,255,255,0.1), rgba(255,255,255,0.3))',
            weeklyChartBar: 'rgba(255, 255, 255, 0.6)',
            weeklyChartActiveBar: '#FFFFFF',
            achievementBadgeBg: 'rgba(251, 191, 36, 0.2)',
            achievementBadgeColor: '#FBBF24',
            mapOverlay: 'rgba(76, 29, 149, 0.4)',
            mapRouteLine: '#FFFFFF',
            statDivider: 'rgba(255, 255, 255, 0.15)',
            sectionTitleWeight: '800',
            dataValueWeight: '700',
            navActiveBg: 'rgba(255, 255, 255, 0.25)',
            navActiveColor: '#FFFFFF',
            navInactiveColor: 'rgba(255, 255, 255, 0.6)',
            tooltipBg: 'rgba(0, 0, 0, 0.7)',
            tooltipColor: '#FFFFFF',
            tooltipBorder: 'none',
            pulseAnimation: 'animation: glow-white 2.5s ease-in-out infinite',
            gradientText: 'background: linear-gradient(90deg, #FBBF24, #FFFFFF); -webkit-background-clip: text; color: transparent;',
        },
    },
    {
        id: 'focus-workflow-dashboard',
        name: 'Focus 工作流',
        desc: 'Focus Workflow · 深空灰玻璃拟态 + 霓虹数据流 + 圆角任务系统',
        source: '#uploaded-image-13',
        tokens: {
            // ✨ 核心背景：深邃蓝灰渐变，模拟夜空或深海，为霓虹色提供最佳画布
            pageBg: 'linear-gradient(180deg, #0F172A 0%, #1E293B 100%)',
            fontFamily: "'Inter', 'SF Pro Text', -apple-system, sans-serif",
            numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            // 卡片采用高透+强模糊，边框极细，营造悬浮感
            cardBg: 'rgba(30, 41, 51, 0.65)',
            cardBorderColor: 'rgba(255, 255, 255, 0.08)',
            cardBorderWidth: '1px',
            cardRadius: '20px',
            cardShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            cardBackdropFilter: 'blur(24px) saturate(180%)',
            titleColor: '#FFFFFF',
            descColor: '#CBD5E1',
            itemBg: 'rgba(51, 65, 85, 0.4)',
            itemTitleColor: '#FFFFFF',
            itemDescColor: '#94A3B8',
            itemBorderColor: 'transparent',
            itemBorderStyle: 'solid',
            itemBorderWidth: '0px',
            itemRadius: '16px',
            // ✨ 霓虹三色系统：紫（主任务）、粉（紧急/创意）、黄（时间轴/高亮）
            upColor: '#EC4899',   // 荧光紫：用于进度增长、完成度
            downColor: '#A855F7', // 荧光粉：用于警告、未完成、创意爆发
            btnBg: 'linear-gradient(135deg, #EC4899 0%, #A855F7 100%)',
            btnColor: '#FFFFFF',
            btnRadius: '999px',
            btnBorderColor: 'transparent',
            btnBorderStyle: 'solid',
            btnBorderWidth: '0px',
            btnFontFamily: "'Inter', sans-serif",
            btnShadow: '0 4px 16px rgba(236, 72, 153, 0.3)',
            tagBg: 'rgba(168, 85, 247, 0.15)',
            tagColor: '#C084FC',
            tagFontFamily: "'Inter', sans-serif",
            tagBorderColor: 'transparent',
            tagBorderStyle: 'solid',
            tagBorderWidth: '0px',
            tagRadius: '8px',
            // 特有工作流 Tokens
            progressBarBg: 'rgba(51, 65, 85, 0.6)',
            progressBarFill: '#A855F7',
            calendarTodayBg: 'rgba(168, 85, 247, 0.2)',
            calendarTodayColor: '#FFFFFF',
            calendarWeekendColor: '#64748B',
            timelineCurrentLine: '#FBBF24', // 黄色垂直线
            timelineBarBg: 'rgba(51, 65, 85, 0.6)',
            timelineBarActive: '#A855F7',
            timelineBarPending: 'rgba(255, 255, 255, 0.1)',
            chatBubbleUser: 'rgba(168, 85, 247, 0.2)',
            chatBubbleOther: 'rgba(51, 65, 85, 0.6)',
            chatTextColor: '#FFFFFF',
            avatarRingColor: 'rgba(255, 255, 255, 0.2)',
            notificationBadgeBg: '#A855F7',
            notificationBadgeColor: '#FFFFFF',
            searchInputBg: 'rgba(30, 41, 51, 0.4)',
            searchInputColor: '#FFFFFF',
            searchInputPlaceholder: '#64748B',
            navActiveBg: 'rgba(168, 85, 247, 0.15)',
            navActiveColor: '#C084FC',
            navInactiveColor: '#64748B',
            tooltipBg: 'rgba(15, 23, 42, 0.95)',
            tooltipColor: '#FFFFFF',
            tooltipBorder: '1px solid rgba(168, 85, 247, 0.3)',
            pulseAnimation: 'animation: pulse-purple 2s infinite',
            glowEffect: 'box-shadow: 0 0 20px rgba(168, 85, 247, 0.4)',
        },
    },
    {
    id: 'vyora-ai-streaming',
    name: 'Vyora 智能影院',
    desc: 'Vyora AI Dashboard · 深紫沉浸氛围 + 玻璃拟态卡片 + 霓虹交互',
    source: '#uploaded-image-14',
    tokens: {
        // ✨ 核心背景：从上至下的深紫到蓝紫渐变，模拟夜晚影院的静谧感
        pageBg: 'linear-gradient(180deg, #5B21B6 0%, #3730A3 40%, #1E1B4B 100%)',
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
                  numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        // 卡片采用半透明深色玻璃，边缘微光，营造悬浮感
        cardBg: 'rgba(30, 27, 75, 0.55)',
        cardBorderColor: 'rgba(255, 255, 255, 0.1)',
        cardBorderWidth: '1px',
        cardRadius: '24px',
        cardShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
        cardBackdropFilter: 'blur(20px) saturate(180%)',
        titleColor: '#FFFFFF',
        descColor: '#C4B5FD', // 浅紫灰，比纯白更柔和
        itemBg: 'rgba(59, 55, 120, 0.4)',
        itemTitleColor: '#FFFFFF',
        itemDescColor: '#A78BFA',
        itemBorderColor: 'transparent',
        itemBorderStyle: 'solid',
        itemBorderWidth: '0px',
        itemRadius: '16px',
        // ✨ 霓虹交互色：主色调为电光紫，辅助色为柔粉
        upColor: '#F472B6',   // 浅紫：用于评分、正向反馈
        downColor: '#A78BFA', // 柔粉：用于收藏、警告（虽图中未明显体现下降，但预留语义）
        btnBg: 'linear-gradient(135deg, #7C3AED 0%, #A78BFA 100%)',
        btnColor: '#FFFFFF',
        btnRadius: '999px',
        btnBorderColor: 'rgba(255, 255, 255, 0.2)',
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Inter', sans-serif",
        btnShadow: '0 4px 12px rgba(124, 58, 237, 0.4)',
        tagBg: 'rgba(124, 58, 237, 0.2)',
        tagColor: '#DDD6FE',
        tagFontFamily: "'Inter', sans-serif",
        tagBorderColor: 'transparent',
        tagBorderStyle: 'solid',
        tagBorderWidth: '0px',
        tagRadius: '999px',
        // 特有流媒体 Tokens
        progressBarBg: 'rgba(255, 255, 255, 0.15)',
        progressBarFill: '#FFFFFF',
        playButtonBg: 'rgba(255, 255, 255, 0.15)',
        playButtonIcon: '#FFFFFF',
        playButtonHoverBg: 'rgba(255, 255, 255, 0.25)',
        ratingStarColor: '#FBBF24', // 金色星星
        episodeIconColor: '#C4B5FD',
        searchInputBg: 'rgba(255, 255, 255, 0.1)',
        searchInputColor: '#FFFFFF',
        searchInputPlaceholder: '#A78BFA',
        navActiveBg: 'rgba(124, 58, 237, 0.2)',
        navActiveColor: '#FFFFFF',
        navInactiveColor: '#A78BFA',
        tooltipBg: 'rgba(30, 27, 75, 0.95)',
        tooltipColor: '#FFFFFF',
        tooltipBorder: '1px solid rgba(167, 139, 250, 0.3)',
        pulseAnimation: 'animation: glow-purple 2s infinite',
        heroOverlay: 'linear-gradient(to right, rgba(30, 27, 75, 0.8) 0%, rgba(30, 27, 75, 0.2) 100%)',
        aiBadgeBg: 'rgba(124, 58, 237, 0.15)',
        aiBadgeColor: '#DDD6FE',
        sectionTitleWeight: '700',
        dataValueWeight: '600',
    },
},
{
    id: 'light-blue-glass-finance',
    name: '浅蓝琉璃金融',
    desc: 'Light Blue Glass Finance · 高明度天蓝背景 + 白色磨砂玻璃卡片 + 柔和投影',
    source: '#uploaded-image-15',
    tokens: {
        // ✨ 核心背景：纯净的高明度天蓝色，模拟晴朗天空或清澈水面
        pageBg: 'linear-gradient(180deg, #60A5FA 0%, #3B82F6 100%)', // 从浅天蓝到标准蓝的微妙渐变
        
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
                   numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        
        // ✨ 玻璃卡片系统：关键是用白色低透明度 + 强模糊 + 白色边框高光
        cardBg: 'rgba(255, 255, 255, 0.65)', // 较高的白色透明度，保证内容清晰
        cardBorderColor: 'rgba(255, 255, 255, 0.4)', // 明显的白色边框，模拟玻璃边缘反光
        cardBorderWidth: '1px',
        cardRadius: '24px',
        // 阴影要柔和且偏冷色调，模拟自然光下的投影
        cardShadow: '0 8px 32px rgba(31, 38, 135, 0.15)', 
        // 关键：强烈的背景模糊，让背后的蓝色晕染开来
        cardBackdropFilter: 'blur(16px) saturate(180%)', 
        
        titleColor: '#1E3A8A', // 深海军蓝，与浅蓝背景形成优雅对比，比纯黑更和谐
        descColor: '#3B82F6',  // 标准蓝，用于次级信息
        
        itemBg: 'rgba(255, 255, 255, 0.4)',
        itemTitleColor: '#1E40AF',
        itemDescColor: '#60A5FA',
        itemBorderColor: 'transparent',
        itemBorderStyle: 'solid',
        itemBorderWidth: '0px',
        itemRadius: '16px',
        
        // ✨ 语义色：使用高饱和度的纯色，在浅色玻璃上依然清晰可见
        upColor: '#EF4444',   // 鲜绿
        downColor: '#10B981', // 鲜红
        
        // 按钮系统：实心白色或深蓝色，提供清晰的点击目标
        btnBg: '#FFFFFF',
        btnColor: '#2563EB',
        btnRadius: '999px',
        btnBorderColor: 'rgba(255, 255, 255, 0.5)',
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'SF Pro Display', sans-serif",
        btnShadow: '0 4px 12px rgba(37, 99, 235, 0.2)',
        
        tagBg: 'rgba(255, 255, 255, 0.5)',
        tagColor: '#1E40AF',
        tagFontFamily: "'SF Pro Display', sans-serif",
        tagBorderColor: 'rgba(255, 255, 255, 0.3)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '8px',
        
        // 特有图表 Tokens
        chartRingOrange: '#FB923C', // 橙色环
        chartRingYellow: '#FCD34D', // 黄色环
        chartRingGreen: '#86EFAC',  // 绿色环
        chartLineMini: 'rgba(255, 255, 255, 0.6)', // 迷你波形图用半透明白
        
        navActiveBg: 'rgba(255, 255, 255, 0.3)',
        navActiveColor: '#1E3A8A',
        navInactiveColor: 'rgba(255, 255, 255, 0.6)',
        
        tooltipBg: 'rgba(255, 255, 255, 0.9)',
        tooltipColor: '#1E3A8A',
        tooltipBorder: '1px solid rgba(255, 255, 255, 0.5)',
        
        sectionTitleWeight: '600',
        dataValueWeight: '700',
        
        // 动画：轻微的浮动，模拟失重感
        pulseAnimation: 'animation: float-glass 3s ease-in-out infinite',
    },
},
{
    id: 'lumina-wellness-dashboard',
    name: 'Lumina 暖光健康',
    desc: 'Lumina Wellness · 奶油蜜桃暖调渐变 + 柔光玻璃卡片 + 治愈系圆角数据流',
    source: '#uploaded-image-16',
    tokens: {
        // ✨ 核心背景：从奶油杏到蜜桃粉的暖调渐变，模拟清晨柔光或肌肤质感
        pageBg: 'linear-gradient(135deg, #FDE68A 0%, #FCA5A5 50%, #F9A8D4 100%)',
        
        fontFamily: "'Nunito', 'Quicksand', 'SF Pro Rounded', sans-serif", // 优先使用圆润字体
                   numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        
        // ✨ 柔光玻璃卡片：极高透明度白光 + 柔和投影，像一层薄纱覆盖在暖色背景上
        cardBg: 'rgba(255, 255, 255, 0.72)',
        cardBorderColor: 'rgba(255, 255, 255, 0.5)',
        cardBorderWidth: '1px',
        cardRadius: '28px',
        cardShadow: '0 8px 32px rgba(249, 168, 212, 0.2)', // 阴影带粉色环境光
        cardBackdropFilter: 'blur(20px) saturate(150%)',
        
        titleColor: '#78350F', // 深琥珀棕，比黑色更温暖和谐
        descColor: '#B45309',  // 中琥珀色，用于次级文本
        
        itemBg: 'rgba(255, 255, 255, 0.5)',
        itemTitleColor: '#92400E',
        itemDescColor: '#D97706',
        itemBorderColor: 'transparent',
        itemBorderStyle: 'solid',
        itemBorderWidth: '0px',
        itemRadius: '20px',
        
        // ✨ 治愈系语义色：低饱和度暖色调，避免刺眼的纯红纯绿
        upColor: '#F43F5E',   // 薄荷绿：正向指标（心率正常、步数达标）
        downColor: '#10B981', // 玫瑰红：警示指标（睡眠不足、压力过高）
        
        // 按钮系统：暖色渐变实心按钮，呼应背景
        btnBg: 'linear-gradient(135deg, #FB923C 0%, #F472B6 100%)',
        btnColor: '#FFFFFF',
        btnRadius: '999px',
        btnBorderColor: 'rgba(255, 255, 255, 0.3)',
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Nunito', sans-serif",
        btnShadow: '0 4px 16px rgba(244, 114, 182, 0.3)',
        
        tagBg: 'rgba(251, 146, 60, 0.15)',
        tagColor: '#C2410C',
        tagFontFamily: "'Nunito', sans-serif",
        tagBorderColor: 'transparent',
        tagBorderStyle: 'solid',
        tagBorderWidth: '0px',
        tagRadius: '12px',
        
        // 特有健康数据 Tokens
        heartRateLine: '#F43F5E',
        sleepBarDeep: '#6366F1',   // 靛蓝：深度睡眠
        sleepBarLight: '#A5B4FC',  // 浅靛蓝：浅睡
        sleepBarRem: '#FDE68A',    // 暖黄：REM睡眠
        stepProgressFill: '#10B981',
        stepProgressBg: 'rgba(255, 255, 255, 0.4)',
        calorieRing: '#FB923C',
        waterDropColor: '#38BDF8', // 天蓝：水分摄入
        
        navActiveBg: 'rgba(255, 255, 255, 0.4)',
        navActiveColor: '#78350F',
        navInactiveColor: 'rgba(120, 53, 15, 0.5)',
        
        tooltipBg: 'rgba(255, 255, 255, 0.9)',
        tooltipColor: '#78350F',
        tooltipBorder: '1px solid rgba(255, 255, 255, 0.6)',
        
        sectionTitleWeight: '700',
        dataValueWeight: '600',
        
        // 动画：轻柔的呼吸感，模拟生命律动
        pulseAnimation: 'animation: breathe-warm 3s ease-in-out infinite',
    },
},
{
    id: 'dark-industrial-monitor',
    name: '暗黑工业监控',
    desc: 'Dark Industrial Monitor · 深空灰蓝背景 + 高亮橙红警示 + 高密度数据网格',
    source: '#uploaded-image-17',
    tokens: {
        // ✨ 核心背景：极深的蓝灰色，模拟夜间控制中心或工业屏幕
        pageBg: '#0F172A', // 深空灰蓝，比纯黑更有质感
        
        fontFamily: "'Bebas Neue', 'Orbitron', 'Noto Sans SC', sans-serif",
        numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        
        // 卡片系统：半透明深色玻璃，边缘有微弱高光
        cardBg: 'rgba(30, 41, 59, 0.6)',
        cardBorderColor: 'rgba(255, 255, 255, 0.08)',
        cardBorderWidth: '1px',
        cardRadius: '8px', // 小圆角，体现工业严谨感
        cardShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
        cardBackdropFilter: 'blur(12px)',
        
        titleColor: '#E2E8F0', // 浅灰白，保证可读性
        descColor: '#94A3B8',  // 中灰，用于次要信息
        
        itemBg: 'rgba(15, 23, 42, 0.5)',
        itemTitleColor: '#F1F5F9',
        itemDescColor: '#64748B',
        itemBorderColor: 'rgba(255, 255, 255, 0.05)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '6px',
        
        // ✨ 核心语义色：高饱和度橙红，用于警示、选中、关键操作
        upColor: '#EF4444',   // 亮橙色：正常但需关注的数据
        downColor: '#F97316', // 鲜红色：严重警告、停机、损失
        
        // 按钮系统：实心橙红按钮，强烈的行动号召
        btnBg: '#F97316',
        btnColor: '#FFFFFF',
        btnRadius: '6px',
        btnBorderColor: 'transparent',
        btnBorderStyle: 'solid',
        btnBorderWidth: '0px',
        btnFontFamily: "'Inter', sans-serif",
        btnShadow: '0 4px 12px rgba(249, 115, 22, 0.4)',
        
        tagBg: 'rgba(249, 115, 22, 0.15)',
        tagColor: '#FB923C',
        tagFontFamily: "'JetBrains Mono', monospace",
        tagBorderColor: 'rgba(249, 115, 22, 0.3)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '4px',
        
        // 特有工业监控 Tokens
        heatmapNormal: 'rgba(59, 130, 246, 0.1)', // 蓝色：正常运行
        heatmapWarning: 'rgba(249, 115, 22, 0.3)', // 橙色：预警
        heatmapCritical: 'rgba(239, 68, 68, 0.8)', // 红色：故障/停机
        chartLineOrange: '#F97316',
        chartGridColor: 'rgba(255, 255, 255, 0.05)',
        
        selectionBoxBorder: '#F97316', // 选中区域的边框色
        selectionBoxFill: 'rgba(249, 115, 22, 0.1)',
        
        navActiveBg: 'rgba(249, 115, 22, 0.2)',
        navActiveColor: '#F97316',
        navInactiveColor: '#64748B',
        
        tooltipBg: 'rgba(15, 23, 42, 0.95)',
        tooltipColor: '#F1F5F9',
        tooltipBorder: '1px solid rgba(249, 115, 22, 0.3)',
        
        sectionTitleWeight: '600',
        dataValueWeight: '700',
        
        pulseAnimation: 'animation: alert-pulse 1.5s infinite', // 关键警报闪烁
    },
},
{
    id: 'neon-casino-witch',
    name: '霓虹魔女赌场',
    desc: 'Neon Casino Witch · 粉黑渐变 + 金紫橙撞色 + 动漫角色',
    source: '提取自上传图片',
    tokens: {
        // ========== 页面背景 ==========
        pageBg: '#0A0014', // 深紫黑底，带微粉光晕

        // ========== 字体 ==========
        fontFamily: "'Bebas Neue', 'Orbitron', 'Noto Sans SC', sans-serif",
        numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",

        // ========== 卡片样式 ==========
        cardBg: 'rgba(255, 0, 128, 0.08)', // 半透明粉红玻璃感
        cardBorderColor: 'rgba(255, 0, 128, 0.3)',
        cardBorderWidth: '1.5px',
        cardRadius: '16px',
        cardShadow: '0 0 20px rgba(255, 0, 128, 0.4), inset 0 0 10px rgba(255, 0, 128, 0.1)',

        // ========== 标题/描述 ==========
        titleColor: '#FFD700', // 金色标题
        descColor: 'rgba(255, 255, 255, 0.7)',

        // ========== 子项样式 ==========
        itemBg: 'rgba(138, 43, 226, 0.1)', // 紫色半透明底
        itemTitleColor: '#FFFFFF',
        itemDescColor: 'rgba(255, 255, 255, 0.6)',
        itemBorderColor: 'rgba(255, 0, 128, 0.2)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '12px',

        // ========== 涨跌颜色（A股标准：红涨绿跌）==========
        upColor: '#FF0055', // 霓虹玫红（涨）
        downColor: '#00FF99', // 荧光青绿（跌）

        // ========== 按钮样式 ==========
        btnBg: '#FF0080', // 主按钮：亮粉色
        btnColor: '#FFFFFF',
        btnRadius: '999px',
        btnBorderColor: '#FF0080',
        btnBorderStyle: 'solid',
        btnBorderWidth: '2px',
        btnFontFamily: "'Bebas Neue', sans-serif",
        btnShadow: '0 0 15px rgba(255, 0, 128, 0.6), 0 4px 0 rgba(255, 0, 128, 0.8)',

        // ========== 标签样式 ==========
        tagBg: 'rgba(255, 215, 0, 0.15)', // 金色半透明
        tagColor: '#FFD700',
        tagFontFamily: "'Share Tech Mono', monospace",
        tagBorderColor: 'rgba(255, 215, 0, 0.4)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '6px',
    },
},
{
    id: 'royal-night-casino',
    name: '皇家暗夜赌场',
    desc: 'Royal Night Casino · 藏青渐变底 + 金紫绿撞色 + 宝石质感',
    source: '提取自上传图片',
    tokens: {
        // ========== 页面背景 ==========
        pageBg: 'linear-gradient(135deg, #0F172A 0%, #1E3A8A 50%, #0F172A 100%)', // 藏青→深蓝→藏青渐变

        // ========== 字体 ==========
        fontFamily: "'Cinzel', 'Playfair Display', 'Noto Sans SC', serif",
        numberFontFamily: "'JetBrains Mono', 'Fira Code', monospace",

        // ========== 卡片样式 ==========
        cardBg: 'rgba(255, 255, 255, 0.04)',
        cardBorderColor: 'rgba(255, 215, 0, 0.3)',
        cardBorderWidth: '1.5px',
        cardRadius: '16px',
        cardShadow: '0 8px 32px rgba(0, 0, 0, 0.6), inset 0 0 20px rgba(255, 215, 0, 0.05)',

        // ========== 标题/描述 ==========
        titleColor: '#FFD700', // 皇家金
        descColor: 'rgba(255, 255, 255, 0.65)',

        // ========== 子项样式 ==========
        itemBg: 'rgba(138, 43, 226, 0.08)', // 紫色半透明底
        itemTitleColor: '#FFFFFF',
        itemDescColor: 'rgba(255, 255, 255, 0.55)',
        itemBorderColor: 'rgba(138, 43, 226, 0.25)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '12px',

        // ========== 涨跌颜色（A股标准：红涨绿跌）==========
        upColor: '#FF4D4D', // 暖红（涨）
        downColor: '#00E676', // 荧光绿（跌）

        // ========== 按钮样式 ==========
        btnBg: '#FFD700', // 金色主按钮
        btnColor: '#0F172A',
        btnRadius: '999px',
        btnBorderColor: '#FFD700',
        btnBorderStyle: 'solid',
        btnBorderWidth: '2px',
        btnFontFamily: "'Cinzel', serif",
        btnShadow: '0 4px 20px rgba(255, 215, 0, 0.4), 0 2px 0 rgba(255, 215, 0, 0.8)',

        // ========== 标签样式 ==========
        tagBg: 'rgba(0, 255, 136, 0.12)', // 绿色半透明
        tagColor: '#00E676',
        tagFontFamily: "'Orbitron', monospace",
        tagBorderColor: 'rgba(0, 255, 136, 0.3)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '6px',
    },
},
{
    id: 'rainbow-tech-minimal',
    name: '彩虹科技极简',
    desc: 'Rainbow Tech Minimal · 黑字+彩虹渐变底 + 几何Logo风',
    source: '提取自上传图片',
    tokens: {
        // ========== 页面背景 ==========
        pageBg: 'linear-gradient(135deg, #FFFFFF 0%, #FFFF00 25%, #FF0055 50%, #FF00FF 75%, #0066FF 100%)', // 白→黄→红→紫→蓝 彩虹对角渐变

        // ========== 字体 ==========
        fontFamily: "'Inter', 'Sora', 'Noto Sans SC', sans-serif",
        numberFontFamily: "'JetBrains Mono', monospace",

        // ========== 卡片样式 ==========
        cardBg: 'rgba(255, 255, 255, 0.85)',
        cardBorderColor: 'rgba(0, 0, 0, 0.1)',
        cardBorderWidth: '1px',
        cardRadius: '12px',
        cardShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',

        // ========== 标题/描述 ==========
        titleColor: '#000000',
        descColor: 'rgba(0, 0, 0, 0.6)',

        // ========== 子项样式 ==========
        itemBg: 'rgba(255, 255, 255, 0.7)',
        itemTitleColor: '#000000',
        itemDescColor: 'rgba(0, 0, 0, 0.5)',
        itemBorderColor: 'rgba(0, 0, 0, 0.08)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '10px',

        // ========== 涨跌颜色（A股标准：红涨绿跌）==========
        upColor: '#FF3B30', // 苹果红（涨）
        downColor: '#34C759', // 苹果绿（跌）

        // ========== 按钮样式 ==========
        btnBg: '#000000',
        btnColor: '#FFFFFF',
        btnRadius: '999px',
        btnBorderColor: '#000000',
        btnBorderStyle: 'solid',
        btnBorderWidth: '2px',
        btnFontFamily: "'Inter', sans-serif",
        btnShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',

        // ========== 标签样式 ==========
        tagBg: 'rgba(0, 0, 0, 0.06)',
        tagColor: '#000000',
        tagFontFamily: "'JetBrains Mono', monospace",
        tagBorderColor: 'rgba(0, 0, 0, 0.15)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '6px',
    },
},
{
    id: 'musickit-custom-theme',
    name: 'MusicKit 自定义主题',
    desc: 'MusicKit Custom Theme · 深色背景 + 紫色卡片 + 浅灰白字按钮 + 绿色高亮交互',
    source: '#uploaded-image-16',
    tokens: {
        pageBg: '#0A0C14', // 极致深色背景[cite: 6]
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        numberFontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        cardBg: '#1E1B4B', // 紫色卡片背景
        cardBorderColor: 'rgba(124, 58, 237, 0.2)',
        cardBorderWidth: '1px',
        cardRadius: '16px',
        cardShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
        cardBackdropFilter: 'none',
        titleColor: '#FFFFFF', // 纯白标题[cite: 6]
        descColor: '#A5B4FC', // 浅紫描述文字
        itemBg: '#2E2A72', // 暗紫子卡片背景
        itemTitleColor: '#FFFFFF',
        itemDescColor: '#C7D2FE',
        itemBorderColor: 'transparent',
        itemBorderStyle: 'solid',
        itemBorderWidth: '0px',
        itemRadius: '10px',
        upColor: '#EF4444', // 绿色高亮交互/正常状态[cite: 6]
        downColor: '#10B981', // 红色状态[cite: 6]
        btnBg: '#374151', // 浅灰色按钮背景
        btnColor: '#FFFFFF', // 按钮文字白色
        btnRadius: '8px',
        btnBorderColor: 'transparent',
        btnBorderStyle: 'solid',
        btnBorderWidth: '0px',
        btnFontFamily: "'Inter', sans-serif",
        btnShadow: 'none',
        tagBg: 'rgba(16, 185, 129, 0.15)', // 绿色高亮标签背景[cite: 6]
        tagColor: '#10B981', // 绿色高亮标签文字[cite: 6]
        tagFontFamily: "'Inter', sans-serif",
        tagBorderColor: 'transparent',
        tagBorderStyle: 'solid',
        tagBorderWidth: '0px',
        tagRadius: '6px',
        // 特有色彩卡片与仪表盘 Tokens
        primaryAccent: '#10B981', // 主高亮交互色：绿色[cite: 6]
        cardPinkBg: '#EC4899',
        cardPinkColor: '#FFFFFF',
        cardGreenBg: '#10B981',
        cardGreenColor: '#FFFFFF',
        cardPurpleBg: '#312E81', // 深紫色卡片底色
        cardPurpleColor: '#FFFFFF',
        cardOrangeBg: '#F97316',
        cardOrangeColor: '#FFFFFF',
        navActiveBg: 'rgba(16, 185, 129, 0.15)', // 绿色高亮激活背景
        navActiveColor: '#10B981', // 绿色高亮激活文字
        navInactiveBg: 'transparent',
        navInactiveColor: '#8A8F9E',
        calendarHighlightBg: '#10B981',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: '#4C1D95',
        scheduleOrangeBg: '#F97316',
        scheduleGreenBg: '#10B981',
        iconActiveColor: '#10B981', // 绿色高亮激活图标[cite: 6]
        iconInactiveColor: '#9CA3AF',
        sidebarBg: '#0D0F17',
        sidebarRadius: '0px'
    },
},
{
    id: 'dark-mode-developer-landing',
    name: '暗黑极客开发者首页',
    desc: 'Dark Mode Developer Landing · 深蓝黑背景 + 亮蓝微光渐变文字 + 高对比度现代科技卡片',
    source: '#uploaded-image-17',
    tokens: {
        pageBg: '#090D16', // 深藏青黑页面背景
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        numberFontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        cardBg: 'rgba(15, 23, 42, 0.6)', // 半透明暗蓝卡片背景
        cardBorderColor: 'rgba(255, 255, 255, 0.08)', // 极细半透明边框
        cardBorderWidth: '1px',
        cardRadius: '16px',
        cardShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
        cardBackdropFilter: 'blur(12px)',
        titleColor: '#FFFFFF', // 纯白高亮标题
        descColor: '#94A3B8', // 灰蓝次要描述文本
        itemBg: 'transparent',
        itemTitleColor: '#FFFFFF',
        itemDescColor: '#94A3B8',
        itemBorderColor: 'rgba(255, 255, 255, 0.08)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '12px',
        upColor: '#EF4444', // 绿色（正向增长/上升，如 +0.1%, +18%）[cite: 7]
        downColor: '#10B981', // 红色（负向下降/减少，与 upColor 区分）
        btnBg: '#2563EB', // 亮蓝主按钮背景
        btnColor: '#FFFFFF', // 主按钮文字颜色
        btnRadius: '12px',
        btnBorderColor: 'transparent',
        btnBorderStyle: 'solid',
        btnBorderWidth: '0px',
        btnFontFamily: "'Inter', sans-serif",
        btnShadow: '0 0 20px rgba(37, 99, 235, 0.35)', // 亮蓝微光阴影
        tagBg: 'rgba(37, 99, 235, 0.15)', // 顶部小胶囊标签背景
        tagColor: '#60A5FA', // 胶囊标签蓝字
        tagFontFamily: "'Inter', sans-serif",
        tagBorderColor: 'rgba(37, 99, 235, 0.3)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '999px',
        // 特有色彩卡片与仪表盘 Tokens
        primaryAccent: '#3B82F6', // 主高亮色：电光蓝
        cardPinkBg: 'rgba(236, 72, 153, 0.15)',
        cardPinkColor: '#F472B6',
        cardGreenBg: 'rgba(16, 185, 129, 0.15)',
        cardGreenColor: '#34D399',
        cardPurpleBg: 'rgba(139, 92, 246, 0.15)',
        cardPurpleColor: '#A78BFA',
        cardOrangeBg: 'rgba(245, 158, 11, 0.15)',
        cardOrangeColor: '#FBBF24', // 数据加量橙黄高亮 (+340GB)
        navActiveBg: '#2563EB',
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#94A3B8',
        calendarHighlightBg: '#2563EB',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(139, 92, 246, 0.2)',
        scheduleOrangeBg: 'rgba(245, 158, 11, 0.2)',
        scheduleGreenBg: 'rgba(16, 185, 129, 0.2)',
        iconActiveColor: '#60A5FA',
        iconInactiveColor: '#475569',
        sidebarBg: '#0F172A',
        sidebarRadius: '0px'
    },
},
{
    id: 'masonry-flow-dark-neon',
    name: 'MasonryFlow 霓虹暗黑瀑布流',
    desc: 'MasonryFlow Dark Neon · 暗黑方格网格背景 + 彩色渐变卡片 + 珊瑚红高亮按钮',
    source: '#uploaded-image-19',
    tokens: {
        pageBg: '#0F0E17', // 暗黑紫黑底色（带细微网格纹理）
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        numberFontFamily: "'Fira Code', 'JetBrains Mono', monospace",
        cardBg: 'rgba(23, 22, 36, 0.7)', // 半透明暗紫灰卡片背景
        cardBorderColor: 'rgba(255, 255, 255, 0.08)',
        cardBorderWidth: '1px',
        cardRadius: '20px',
        cardShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
        cardBackdropFilter: 'blur(16px)',
        titleColor: '#FFFFFF', // 纯白主标题
        descColor: '#A7A9BE', // 浅灰紫描述文字
        itemBg: '#161524', // 深色子卡片背景
        itemTitleColor: '#FFFFFF',
        itemDescColor: '#A7A9BE',
        itemBorderColor: 'rgba(255, 255, 255, 0.06)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '12px',
        upColor: '#FF5470', // 绿色状态文本（如 No JS / CSS only）
        downColor: '#2CB67D', // 红色/警示状态
        btnBg: '#FF5470', // 珊瑚红/亮粉红主按钮
        btnColor: '#FFFFFF',
        btnRadius: '10px',
        btnBorderColor: 'transparent',
        btnBorderStyle: 'solid',
        btnBorderWidth: '0px',
        btnFontFamily: "'Inter', sans-serif",
        btnShadow: '0 8px 20px rgba(255, 84, 112, 0.35)',
        tagBg: 'rgba(255, 84, 112, 0.15)', // 胶囊标签背景
        tagColor: '#FF5470', // 胶囊标签粉红字
        tagFontFamily: "'Fira Code', monospace",
        tagBorderColor: 'rgba(255, 84, 112, 0.3)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '999px',
        // 特有色彩卡片与瀑布流 (Masonry) Tokens
        primaryAccent: '#FF5470', // 主高亮色：珊瑚红
        cardPinkBg: 'linear-gradient(135deg, #FF5470 0%, #D64545 100%)', // 暖红渐变瀑布流块
        cardPinkColor: '#FFFFFF',
        cardGreenBg: 'linear-gradient(135deg, #00EB87 0%, #02A181 100%)', // 青绿渐变瀑布流块
        cardGreenColor: '#FFFFFF',
        cardPurpleBg: 'linear-gradient(135deg, #7F5AF0 0%, #2CB67D 100%)', // 蓝绿紫渐变瀑布流块
        cardPurpleColor: '#FFFFFF',
        cardOrangeBg: 'linear-gradient(135deg, #FFC53D 0%, #E2725B 100%)', // 黄橙渐变瀑布流块
        cardOrangeColor: '#161524',
        navActiveBg: '#FF5470',
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#A7A9BE',
        calendarHighlightBg: '#FF5470',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(127, 90, 240, 0.2)',
        scheduleOrangeBg: 'rgba(255, 197, 61, 0.2)',
        scheduleGreenBg: 'rgba(44, 182, 125, 0.2)',
        iconActiveColor: '#FF5470',
        iconInactiveColor: '#72757E',
        sidebarBg: '#0F0E17',
        sidebarRadius: '0px'
    },
},
{
  id: 'sketch-handdrawn-style',
  name: ' Sketch 手绘风',
  desc: 'Sketch Hand-drawn Style · 米色纸纹底 + 铅笔虚线边框 + 手写字体 + 星号装饰角',
  source: '提取自上传图片',
  tokens: {
    // ========== 页面背景 ==========
    pageBg: '#F8F5F0', // 米白色纸张底色，带轻微纹理感
    pageTexture: "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\" viewBox=\"0 0 100 100\"><rect fill=\"%23F8F5F0\"/><path d=\"M0 0 L100 100 M100 0 L0 100\" stroke=\"%23E8E4DD\" stroke-width=\"0.5\" opacity=\"0.3\"/></svg>')", // 可选：添加细微网格或纸纹

    // ========== 字体 ==========
    fontFamily: "'Caveat', 'Dancing Script', 'Ma Shan Zheng', cursive", // 手写体用于标题
    bodyFontFamily: "'Inter', 'Noto Sans SC', sans-serif", // 正文用清晰无衬线体
    numberFontFamily: "'JetBrains Mono', 'SF Mono', monospace",

    // ========== 主标题样式 ==========
    titleColor: '#2D2D2D', // 深灰近黑，模拟墨水
    titleFontSize: '64px',
    titleFontWeight: '700',
    titleLineHeight: '1.1',
    titleUnderlineColor: '#D94A4A', // 红色手绘下划线
    titleUnderlineWidth: '2px',
    titleUnderlineStyle: 'wavy', // 波浪线模拟手绘抖动

    // ========== 副标题/描述 ==========
    descColor: '#555555',
    descFontSize: '18px',
    descLineHeight: '1.6',

    // ========== 按钮样式 ==========
    btnPrimaryBg: '#2D2D2D',
    btnPrimaryColor: '#FFFFFF',
    btnPrimaryBorderColor: '#2D2D2D',
    btnPrimaryBorderWidth: '2px',
    btnPrimaryBorderStyle: 'solid',
    btnPrimaryRadius: '8px',
    btnPrimaryShadow: '4px 4px 0px rgba(0,0,0,0.1)', // 硬阴影模拟立体感

    btnSecondaryBg: 'transparent',
    btnSecondaryColor: '#2D2D2D',
    btnSecondaryBorderColor: '#2D2D2D',
    btnSecondaryBorderWidth: '2px',
    btnSecondaryBorderStyle: 'dashed', // 虚线边框模拟手绘
    btnSecondaryRadius: '8px',
    btnSecondaryShadow: 'none',

    btnFontFamily: "'Caveat', cursive",
    btnFontSize: '20px',
    btnPadding: '12px 32px',

    // ========== 卡片/容器样式 ==========
    cardBg: '#FFFFFF',
    cardBorderColor: '#2D2D2D',
    cardBorderWidth: '2px',
    cardBorderStyle: 'solid',
    cardRadius: '0px', // 直角更贴近手绘稿
    cardShadow: '6px 6px 0px rgba(0,0,0,0.08)',
    cardCornerDecor: '* ', // 四角星号装饰（可通过伪元素实现）
    cardCornerColor: '#2D2D2D',
    cardCornerSize: '16px',

    // ========== 统计数字样式 ==========
    statNumberColor: {
      orange: '#D94A4A',
      blue: '#3B82F6',
      green: '#10B981'
    },
    statNumberFontSize: '32px',
    statNumberFontWeight: '700',
    statLabelColor: '#666666',
    statLabelFontSize: '14px',
    statLabelFontFamily: "'Inter', sans-serif",

    // ========== 装饰元素 ==========
    decorativeLine: 'wavy', // 波浪线分隔符
    decorativeLineColor: '#CCCCCC',
    decorativeLineWidth: '1px',
    pencilIcon: '✏️', // 可用SVG替换为真实铅笔图标
    starIcon: '*', // 星号装饰

    // ========== 布局间距 ==========
    sectionGap: '64px',
    cardGap: '32px',
    paddingVertical: '48px',
    paddingHorizontal: '24px',
  },
},
{
    id: 'neo-brutalist-soft',
    name: '柔和新野兽派',
    desc: 'Neo-Brutalist Soft · 浅灰背景 + 无圆角直角卡片 + 粗硬实心位移阴影 (Hard Offset Shadow) + 糖果马卡龙四色撞色顶部边条',
    source: '#uploaded-image-22',
    tokens: {
        pageBg: '#F3F3F3', // 浅冷灰背景[cite: 12]
        fontFamily: "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", // 现代无衬线粗体[cite: 12]
        numberFontFamily: "'Fira Code', 'JetBrains Mono', monospace", // 数据等宽字体[cite: 12]
        cardBg: '#F3F3F3', // 卡片浅灰背景[cite: 12]
        cardBorderColor: '#262626', // 深灰/黑色 2px 粗边框[cite: 12]
        cardBorderWidth: '2px', // 2px 边框 (border-2)[cite: 12]
        cardRadius: '0px', // 直角无圆角 (rounded-none / 0px border radius)[cite: 12]
        cardShadow: '4px 4px 0px #262626', // 4px 硬边位移阴影 (shadow-[4px_4px])[cite: 12]
        cardBackdropFilter: 'none',
        titleColor: '#171717', // 纯黑标题[cite: 12]
        descColor: '#525252', // 深灰描述文本[cite: 12]
        itemBg: '#FFFFFF',
        itemTitleColor: '#171717',
        itemDescColor: '#525252',
        itemBorderColor: '#262626',
        itemBorderStyle: 'solid',
        itemBorderWidth: '2px',
        itemRadius: '0px',
        upColor: '#EC4899', // 莱姆绿 (LIME)[cite: 12]
        downColor: '#A3E635', // 亮粉红 (PINK)[cite: 12]
        btnBg: '#EC4899', // 糖果粉主按钮背景[cite: 12]
        btnColor: '#FFFFFF', // 按钮文字白[cite: 12]
        btnRadius: '0px', // 直角按钮[cite: 12]
        btnBorderColor: '#262626',
        btnBorderStyle: 'solid',
        btnBorderWidth: '2px',
        btnFontFamily: "'Space Grotesk', sans-serif",
        btnShadow: '4px 4px 0px #262626', // 主按钮硬阴影[cite: 12]
        tagBg: '#FFFFFF', // 标签/胶囊背景[cite: 12]
        tagColor: '#171717',
        tagFontFamily: "'Fira Code', monospace",
        tagBorderColor: '#262626',
        tagBorderStyle: 'solid',
        tagBorderWidth: '2px',
        tagRadius: '0px',
        // 特有新野兽派 (Neo-Brutalism) 四色 Tokens
        primaryAccent: '#EC4899', // 主高亮色：糖果粉[cite: 12]
        cardPinkBg: '#F472B6', // 粉色块 (PINK)[cite: 12]
        cardPinkColor: '#EC4899', // 粉色顶部条边框线[cite: 12]
        cardGreenBg: '#A3E635', // 青绿/莱姆绿块 (LIME)[cite: 12]
        cardGreenColor: '#84CC16', // 绿线[cite: 12]
        cardPurpleBg: '#38BDF8', // 天蓝块 (SKY)[cite: 12]
        cardPurpleColor: '#0EA5E9', // 蓝线[cite: 12]
        cardOrangeBg: '#FBBF24', // 琥珀黄/橙块 (AMBER)[cite: 12]
        cardOrangeColor: '#F59E0B', // 黄线[cite: 12]
        navActiveBg: '#EC4899',
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#525252',
        calendarHighlightBg: '#EC4899',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(56, 189, 248, 0.2)',
        scheduleOrangeBg: 'rgba(251, 191, 36, 0.2)',
        scheduleGreenBg: 'rgba(163, 230, 53, 0.2)',
        iconActiveColor: '#EC4899',
        iconInactiveColor: '#A3A3A3',
        sidebarBg: '#F3F3F3',
        sidebarRadius: '0px'
    },
},
{
    id: 'neo-brutalist-playful',
    name: '俏皮新野兽派',
    desc: 'Neo-Brutalist Playful · 明亮青绿背景 + 粗黑硬边框 + 倾斜卡片组件 (Tilt/Rotation) + 纯黑硬位移阴影',
    source: '#uploaded-image-23',
    tokens: {
        pageBg: '#4ECDC4', // 鲜亮青绿背景[cite: 13]
        fontFamily: "'Impact', 'Arial Black', -apple-system, BlinkMacSystemFont, sans-serif", // 超粗体艺术字[cite: 13]
        numberFontFamily: "'Fira Code', 'JetBrains Mono', monospace", // 数据等宽字体[cite: 13]
        cardBg: '#FFFFFF', // 纯白卡片背景[cite: 13]
        cardBorderColor: '#000000', // 3px/4px 纯黑粗边框[cite: 13]
        cardBorderWidth: '3px',
        cardRadius: '0px', // 直角无圆角 (0 Border Radius)[cite: 13]
        cardShadow: '5px 5px 0px #000000', // 纯黑硬边位移阴影[cite: 13]
        cardBackdropFilter: 'none',
        titleColor: '#000000', // 纯黑标题[cite: 13]
        descColor: '#000000', // 纯黑描述文本[cite: 13]
        itemBg: '#FFFFFF',
        itemTitleColor: '#000000',
        itemDescColor: '#000000',
        itemBorderColor: '#000000',
        itemBorderStyle: 'solid',
        itemBorderWidth: '3px',
        itemRadius: '0px',
        upColor: '#FF6B6B', // 珊瑚红（Accent Colors 数值高亮）[cite: 13]
        downColor: '#4ECDC4', // 青绿（aiRules 数值高亮）[cite: 13]
        btnBg: '#FF6B6B', // 珊瑚红主按钮背景[cite: 13]
        btnColor: '#FFFFFF', // 按钮白字[cite: 13]
        btnRadius: '0px',
        btnBorderColor: '#000000',
        btnBorderStyle: 'solid',
        btnBorderWidth: '3px',
        btnFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        btnShadow: '4px 4px 0px #000000', // 按钮纯黑硬阴影[cite: 13]
        tagBg: '#FF6B6B', // 倾斜胶囊/标签背景[cite: 13]
        tagColor: '#FFFFFF',
        tagFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        tagBorderColor: '#000000',
        tagBorderStyle: 'solid',
        tagBorderWidth: '2px',
        tagRadius: '0px',
        // 特有俏皮新野兽派 (Playful Neo-Brutalism) Tokens
        primaryAccent: '#FFE66D', // 主高亮色：明黄 (顶部导航/次级按钮)[cite: 13]
        cardPinkBg: '#FF6B6B', // 珊瑚红块[cite: 13]
        cardPinkColor: '#FFFFFF',
        cardGreenBg: '#4ECDC4', // 青绿块[cite: 13]
        cardGreenColor: '#000000',
        cardPurpleBg: '#FFE66D', // 柠檬黄块[cite: 13]
        cardPurpleColor: '#000000',
        cardOrangeBg: '#FF8B94', // 浅粉橙块[cite: 13]
        cardOrangeColor: '#000000',
        navActiveBg: '#000000', // 顶部导航右侧按钮[cite: 13]
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#000000',
        calendarHighlightBg: '#FF6B6B',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(255, 230, 109, 0.4)',
        scheduleOrangeBg: 'rgba(255, 107, 107, 0.4)',
        scheduleGreenBg: 'rgba(78, 205, 196, 0.4)',
        iconActiveColor: '#000000',
        iconInactiveColor: '#000000',
        sidebarBg: '#FFE66D', // 顶部栏黄底[cite: 13]
        sidebarRadius: '0px'
    },
},
{
    id: 'synthwave-neon-80s',
    name: '复古合成器浪潮',
    desc: 'Synthwave Neon 80s · 极暗紫夜景背景 + 霓虹粉紫发光大字 + 横向扫描线渐变 + 80年代网格与山脊剪影',
    source: '#uploaded-image-24',
    tokens: {
        pageBg: '#0D021A', // 深紫黑夜空底色[cite: 14]
        fontFamily: "'Orbitron', 'VT323', 'Arial Black', -apple-system, sans-serif", // 80s 赛博科技感/未来感字体[cite: 14]
        numberFontFamily: "'Fira Code', monospace",
        cardBg: 'rgba(30, 8, 56, 0.6)', // 半透明复古暗紫卡片背景[cite: 14]
        cardBorderColor: '#FF007F', // 霓虹玫粉边框[cite: 14]
        cardBorderWidth: '1px',
        cardRadius: '4px', // 硬朗微圆角
        cardShadow: '0 0 15px rgba(255, 0, 127, 0.4)', // 霓虹粉光晕发光阴影[cite: 14]
        cardBackdropFilter: 'blur(10px)',
        titleColor: '#FFFFFF', // 标题主色（背景搭配发光霓虹粉/电光蓝）[cite: 14]
        descColor: '#A892EE', // 浅紫灰描述文字[cite: 14]
        itemBg: 'rgba(20, 5, 40, 0.8)',
        itemTitleColor: '#FFFFFF',
        itemDescColor: '#A892EE',
        itemBorderColor: '#00F0FF', // 赛博电光蓝边框[cite: 14]
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '4px',
        upColor: '#FF007F', // 电光青蓝[cite: 14]
        downColor: '#00F0FF', // 霓虹玫粉[cite: 14]
        btnBg: 'linear-gradient(135deg, #FF007F 0%, #7B2CBF 100%)', // 霓虹粉紫渐变主按钮[cite: 14]
        btnColor: '#FFFFFF',
        btnRadius: '2px', // 80s 复古微角[cite: 14]
        btnBorderColor: '#FF007F',
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Orbitron', sans-serif",
        btnShadow: '0 0 20px rgba(255, 0, 127, 0.6)', // 按钮发光外阴影[cite: 14]
        tagBg: 'rgba(255, 0, 127, 0.15)', // 标签背景[cite: 14]
        tagColor: '#FF007F', // 标签粉字[cite: 14]
        tagFontFamily: "'Orbitron', sans-serif",
        tagBorderColor: '#FF007F',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '2px',
        // 特有合成器浪潮 (Synthwave / Outrun) Tokens
        primaryAccent: '#FF007F', // 主高亮色：霓虹玫粉[cite: 14]
        cardPinkBg: 'linear-gradient(180deg, #FF007F 0%, #D90429 100%)', // 霓虹粉色（带80年代太阳扫描线感）[cite: 14]
        cardPinkColor: '#FFFFFF',
        cardGreenBg: 'rgba(0, 240, 255, 0.15)',
        cardGreenColor: '#00F0FF', // 电光青蓝 (DRIVE NOW 按钮/横线)[cite: 14]
        cardPurpleBg: 'linear-gradient(180deg, #00F0FF 0%, #FF007F 100%)', // 蓝粉渐变 (WAVE 文字)[cite: 14]
        cardPurpleColor: '#FFFFFF',
        cardOrangeBg: 'rgba(255, 110, 0, 0.15)',
        cardOrangeColor: '#FF6E00', // 复古日落橙[cite: 14]
        navActiveBg: '#FF007F',
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#A892EE',
        calendarHighlightBg: '#FF007F',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(255, 0, 127, 0.25)',
        scheduleOrangeBg: 'rgba(255, 110, 0, 0.25)',
        scheduleGreenBg: 'rgba(0, 240, 255, 0.25)',
        iconActiveColor: '#00F0FF',
        iconInactiveColor: '#5C4084',
        sidebarBg: '#0D021A',
        sidebarRadius: '0px'
    },
},
{
    id: 'surrealism-dream-dark',
    name: '梦境超现实主义',
    desc: 'Surrealism Dream Dark · 幽暗梦境深紫背景 + 典雅斜体衬线字体 + 金粉彩虹渐变大字 + 柔美流体椭圆按钮',
    source: '#uploaded-image-25',
    tokens: {
        pageBg: '#111025', // 深暗紫梦境夜色背景[cite: 15]
        fontFamily: "'Playfair Display', 'Didot', 'Bodoni MT', 'Georgia', serif", // 高对比度典雅艺术衬线体[cite: 15]
         numberFontFamily: "'VT323', 'Fira Code', monospace",
        cardBg: 'rgba(28, 25, 54, 0.5)', // 半透明暗紫梦境卡片背景[cite: 15]
        cardBorderColor: 'rgba(224, 169, 109, 0.2)', // 细微琥珀金半透明边框[cite: 15]
        cardBorderWidth: '1px',
        cardRadius: '24px',
        cardShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
        cardBackdropFilter: 'blur(16px)',
        titleColor: '#F5E6D3', // 暖白/奶油米黄标题[cite: 15]
        descColor: '#A49EBF', // 柔紫灰次要描述文本[cite: 15]
        itemBg: 'rgba(35, 31, 66, 0.4)',
        itemTitleColor: '#F5E6D3',
        itemDescColor: '#A49EBF',
        itemBorderColor: 'rgba(224, 169, 109, 0.2)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '16px',
        upColor: '#E492A5', // 暖金高亮数字 (8 / 1000ms)[cite: 15]
        downColor: '#90ba6d', // 柔粉高亮数字 (5)[cite: 15]
        btnBg: 'linear-gradient(135deg, rgba(60, 45, 95, 0.8) 0%, rgba(35, 28, 65, 0.8) 100%)', // 梦境流体暗紫渐变主按钮[cite: 15]
        btnColor: '#F5E6D3',
        btnRadius: '999px', // 极圆/有机椭圆胶囊按钮[cite: 15]
        btnBorderColor: '#E0A96D', // 细金边框[cite: 15]
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Playfair Display', serif",
        btnShadow: '0 0 20px rgba(224, 169, 109, 0.25)', // 金色微光外阴影[cite: 15]
        tagBg: 'rgba(224, 169, 109, 0.12)', // 标签背景[cite: 15]
        tagColor: '#E0A96D', // 标签金色文字[cite: 15]
        tagFontFamily: "'Playfair Display', serif",
        tagBorderColor: 'rgba(224, 169, 109, 0.3)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '999px',
        // 特有超现实主义 (Surrealism) Tokens
        primaryAccent: '#E0A96D', // 主高亮色：琥珀暖金[cite: 15]
        cardPinkBg: 'rgba(228, 146, 165, 0.15)',
        cardPinkColor: '#E492A5', // 玫瑰粉[cite: 15]
        cardGreenBg: 'rgba(164, 214, 192, 0.15)',
        cardGreenColor: '#A4D6C0', // 梦境薄荷绿
        cardPurpleBg: 'linear-gradient(90deg, #F5E6D3 0%, #E0A96D 50%, #E492A5 100%)', // 主标题粉金渐变 (Surrealism)[cite: 15]
        cardPurpleColor: '#FFFFFF',
        cardOrangeBg: 'rgba(224, 169, 109, 0.15)',
        cardOrangeColor: '#E0A96D',
        navActiveBg: 'rgba(224, 169, 109, 0.2)',
        navActiveColor: '#F5E6D3',
        navInactiveBg: 'transparent',
        navInactiveColor: '#A49EBF',
        calendarHighlightBg: '#E0A96D',
        calendarHighlightColor: '#111025',
        schedulePurpleBg: 'rgba(228, 146, 165, 0.2)',
        scheduleOrangeBg: 'rgba(224, 169, 109, 0.2)',
        scheduleGreenBg: 'rgba(164, 214, 192, 0.2)',
        iconActiveColor: '#E0A96D',
        iconInactiveColor: '#5C5577',
        sidebarBg: '#111025',
        sidebarRadius: '0px'
    },
},
{
    id: 'acid-graphics-90s-rave',
    name: '酸性平面 90s 迷幻派对',
    desc: 'Acid Graphics 90s Rave · 极致纯黑背景 + 荧光毒液绿/电光青/霓虹粉高饱和撞色 + 霓虹发光边框按钮 + 实验性重影与镂空线条字',
    source: '#uploaded-image-27',
    tokens: {
        pageBg: '#0A0A0A', // 纯黑暗夜底色[cite: 17]
        fontFamily: "'Impact', 'Arial Black', -apple-system, BlinkMacSystemFont, sans-serif", // 超粗实验艺术字体[cite: 17]
        numberFontFamily: "'Fira Code', 'VT323', monospace", // 工业地下派对感等宽字体[cite: 17]
        cardBg: 'rgba(20, 20, 20, 0.8)', // 暗黑半透明卡片背景[cite: 17]
        cardBorderColor: '#00FF00', // 荧光毒液绿边框[cite: 17]
        cardBorderWidth: '1px',
        cardRadius: '2px', // 工业硬朗直角微圆[cite: 17]
        cardShadow: '0 0 15px rgba(0, 255, 0, 0.4)', // 荧光绿霓虹发光阴影[cite: 17]
        cardBackdropFilter: 'none',
        titleColor: '#00FF00', // 荧光毒液绿主标题[cite: 17]
        descColor: '#00FF00', // 荧光绿次要描述文本[cite: 17]
        itemBg: 'rgba(10, 10, 10, 0.9)',
        itemTitleColor: '#00FF00',
        itemDescColor: '#00E5FF',
        itemBorderColor: '#00FF00',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '2px',
        upColor: '#FF007F', // 荧光绿（12KV / ENTER THE RAVE）[cite: 17]
        downColor: '#00FF00', // 霓虹粉（174 BPM / 90S RAVE CULTURE）[cite: 17]
        btnBg: 'transparent', // 镂空发光按钮背景[cite: 17]
        btnColor: '#00FF00', // 荧光绿按钮文字[cite: 17]
        btnRadius: '2px',
        btnBorderColor: '#00FF00', // 荧光绿外发光边框[cite: 17]
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Fira Code', monospace",
        btnShadow: '0 0 15px #00FF00, inset 0 0 10px rgba(0, 255, 0, 0.2)', // 双向霓虹发光阴影[cite: 17]
        tagBg: 'transparent',
        tagColor: '#FF007F', // 霓虹粉胶囊/标签文字[cite: 17]
        tagFontFamily: "'Fira Code', monospace",
        tagBorderColor: '#FF007F',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '2px',
        // 特有酸性平面 (Acid Graphics) 高饱和撞色 Tokens
        primaryAccent: '#00FF00', // 主高亮色：荧光毒液绿[cite: 17]
        cardPinkBg: 'rgba(255, 0, 127, 0.15)',
        cardPinkColor: '#FF007F', // 霓虹粉 (174 BPM / PALETTE)[cite: 17]
        cardGreenBg: 'rgba(0, 255, 0, 0.15)',
        cardGreenColor: '#00FF00', // 荧光毒液绿 (ENTER THE RAVE / RULES)[cite: 17]
        cardPurpleBg: 'rgba(157, 0, 255, 0.15)',
        cardPurpleColor: '#9D00FF', // 电光紫 (MAX / COMPONENTS)[cite: 17]
        cardOrangeBg: 'rgba(204, 255, 0, 0.15)',
        cardOrangeColor: '#CCFF00', // 酸性高光黄 (STAY UNDERGROUND / TYPE / 12KV)[cite: 17]
        navActiveBg: '#00FF00',
        navActiveColor: '#0A0A0A',
        navInactiveBg: 'transparent',
        navInactiveColor: '#00E5FF', // 电光青蓝 (GRAPHICS 镂空字 / 1993 / POSTER)[cite: 17]
        calendarHighlightBg: '#00FF00',
        calendarHighlightColor: '#0A0A0A',
        schedulePurpleBg: 'rgba(157, 0, 255, 0.25)',
        scheduleOrangeBg: 'rgba(204, 255, 0, 0.25)',
        scheduleGreenBg: 'rgba(0, 255, 0, 0.25)',
        iconActiveColor: '#00FF00',
        iconInactiveColor: '#00E5FF',
        sidebarBg: '#0A0A0A',
        sidebarRadius: '0px'
    },
},
{
    id: 'magic-circle-arcane',
    name: '魔法阵神秘几何',
    desc: 'Magic Circle Arcane · 沉静深海暗蓝背景 + 炼金金色发光大字 + 星盘魔法阵几何线条 + 细线精密框线组件',
    source: '#uploaded-image-28',
    tokens: {
        pageBg: '#0B0C1E', // 沉静深海暗蓝/星空夜色背景[cite: 13]
        fontFamily: "'Cinzel', 'Trajan Pro', 'Cinzel Decorative', -apple-system, sans-serif", // 古典神秘学/几何艺术字体[cite: 13]
        numberFontFamily: "'Fira Code', 'Courier New', monospace", // 符文感等宽字体[cite: 13]
        cardBg: 'rgba(18, 20, 42, 0.7)', // 半透明暗蓝卡片背景[cite: 13]
        cardBorderColor: '#FFC72C', // 细线炼金金边框[cite: 13]
        cardBorderWidth: '1px',
        cardRadius: '8px', // 细微硬朗圆角[cite: 13]
        cardShadow: '0 0 15px rgba(255, 199, 44, 0.25)', // 亮金阵图外发光阴影[cite: 13]
        cardBackdropFilter: 'blur(10px)',
        titleColor: '#FFC72C', // 亮金发光标题 (MAGIC CIRCLE)[cite: 13]
        descColor: '#7A83B8', // 秘银紫灰描述文本[cite: 13]
        itemBg: 'rgba(15, 17, 36, 0.8)',
        itemTitleColor: '#FFC72C',
        itemDescColor: '#7A83B8',
        itemBorderColor: 'rgba(255, 199, 44, 0.3)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '6px',
        upColor: '#FFC72C', // 亮金高亮[cite: 13]
        downColor: '#8A94F8', // 秘银紫蓝高亮[cite: 13]
        btnBg: 'rgba(255, 199, 44, 0.08)', // 神秘阵图金边按钮背景 (INVOKE RITUAL)[cite: 13]
        btnColor: '#FFC72C', // 金色文字[cite: 13]
        btnRadius: '2px',
        btnBorderColor: '#FFC72C', // 细金外框[cite: 13]
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Fira Code', monospace",
        btnShadow: '0 0 12px rgba(255, 199, 44, 0.3)', // 金色微光外阴影[cite: 13]
        tagBg: 'rgba(58, 65, 120, 0.2)', // 紫蓝次要按钮背景 (OBSERVE SIGIL)[cite: 13]
        tagColor: '#8A94F8', // 紫蓝符文标签字[cite: 13]
        tagFontFamily: "'Fira Code', monospace",
        tagBorderColor: 'rgba(138, 148, 248, 0.4)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '2px',
        // 特有魔法阵 (Magic Circle / Arcane Geometry) Tokens
        primaryAccent: '#FFC72C', // 主高亮色：日光炼金金[cite: 13]
        cardPinkBg: 'rgba(235, 87, 87, 0.15)',
        cardPinkColor: '#EB5757', // 绯红法阵线[cite: 13]
        cardGreenBg: 'rgba(138, 148, 248, 0.15)',
        cardGreenColor: '#8A94F8', // 秘银蓝紫 (OBSERVE SIGIL)[cite: 13]
        cardPurpleBg: 'rgba(155, 81, 224, 0.15)',
        cardPurpleColor: '#9B51E0', // 占星暗紫[cite: 13]
        cardOrangeBg: 'rgba(255, 199, 44, 0.15)',
        cardOrangeColor: '#FFC72C', // 亮金[cite: 13]
        navActiveBg: '#FFC72C',
        navActiveColor: '#0B0C1E',
        navInactiveBg: 'transparent',
        navInactiveColor: '#7A83B8',
        calendarHighlightBg: '#FFC72C',
        calendarHighlightColor: '#0B0C1E',
        schedulePurpleBg: 'rgba(155, 81, 224, 0.25)',
        scheduleOrangeBg: 'rgba(255, 199, 44, 0.25)',
        scheduleGreenBg: 'rgba(138, 148, 248, 0.25)',
        iconActiveColor: '#FFC72C',
        iconInactiveColor: '#3A4178',
        sidebarBg: '#0B0C1E',
        sidebarRadius: '0px'
    },
},
{
    id: 'pop-art-warhol-grid',
    name: '波普艺术 沃霍尔网格',
    desc: 'Pop Art Warhol Style · 经典 CMYK 波普高饱和撞色网格 + 半音阶网点纹理 (Ben-Day Dots) + 粗黑硬边框 + 错位双色位移阴影',
    source: '#uploaded-image-29',
    tokens: {
        pageBg: '#FFE600', // 波普柠檬黄主底色
        fontFamily: "'Impact', 'Arial Black', -apple-system, BlinkMacSystemFont, sans-serif", // 超粗波普艺术黑体
        numberFontFamily: "'Fira Code', 'Courier New', monospace", // 序号编号等宽字体
        cardBg: '#FFFFFF', // 纯白网格块
        cardBorderColor: '#000000', // 3px 纯黑硬边框
        cardBorderWidth: '3px',
        cardRadius: '0px', // 直角无圆角
        cardShadow: '4px 4px 0px #000000', // 纯黑硬位移阴影
        cardBackdropFilter: 'none',
        titleColor: '#000000', // 纯黑标题
        descColor: '#000000', // 纯黑描述文字
        itemBg: '#FFFFFF',
        itemTitleColor: '#000000',
        itemDescColor: '#000000',
        itemBorderColor: '#000000',
        itemBorderStyle: 'solid',
        itemBorderWidth: '3px',
        itemRadius: '0px',
        upColor: '#FF53A5', // 波普洋红/粉色高亮
        downColor: '#00B2FF', // 波普青蓝高亮
        btnBg: '#FFE600', // 明黄主按钮 (ROTATE COLORS)
        btnColor: '#000000', // 按钮黑字
        btnRadius: '0px',
        btnBorderColor: '#000000',
        btnBorderStyle: 'solid',
        btnBorderWidth: '3px',
        btnFontFamily: "'Fira Code', monospace",
        btnShadow: '4px 4px 0px #FF53A5', // 按钮粉色硬位移阴影
        tagBg: '#FF53A5', // 洋红次级按钮 (VIEW DOCS)
        tagColor: '#000000',
        tagFontFamily: "'Fira Code', monospace",
        tagBorderColor: '#000000',
        tagBorderStyle: 'solid',
        tagBorderWidth: '3px',
        tagRadius: '0px',
        // 特有波普艺术 (Pop Art Warhol) 撞色 Tokens
        primaryAccent: '#FFE600', // 主高亮色：明黄
        cardPinkBg: '#FF53A5', // 2号网格波普粉
        cardPinkColor: '#000000',
        cardGreenBg: '#00B2FF', // 3号网格波普电光青蓝
        cardGreenColor: '#000000',
        cardPurpleBg: '#FFE600', // 1号网格波普黄
        cardPurpleColor: '#000000',
        cardOrangeBg: '#FFFFFF', // 4号网格白底
        cardOrangeColor: '#000000',
        navActiveBg: '#000000', // 顶部黑色导航块
        navActiveColor: '#FFE600',
        navInactiveBg: 'transparent',
        navInactiveColor: '#000000',
        calendarHighlightBg: '#FF53A5',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(255, 83, 165, 0.4)',
        scheduleOrangeBg: 'rgba(255, 230, 0, 0.4)',
        scheduleGreenBg: 'rgba(0, 178, 255, 0.4)',
        iconActiveColor: '#000000',
        iconInactiveColor: '#000000',
        sidebarBg: '#FFE600',
        sidebarRadius: '0px'
    },
},
{
    id: 'warm-dashboard-coral-teal',
    name: '温润仪表盘',
    desc: 'Warm Dashboard · 珊瑚陶土暖色背景 + 奶油白卡片组件 + 漫反射柔和阴影 + 暖青绿点缀',
    source: '#uploaded-image-30',
    tokens: {
        pageBg: '#D29E8B', // 珊瑚陶土暖色背景
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        numberFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        cardBg: '#FAF6F0', // 奶油白卡片背景
        cardBorderColor: 'rgba(255, 255, 255, 0.3)',
        cardBorderWidth: '1px',
        cardRadius: '16px', // 柔和圆角卡片
        cardShadow: '0 12px 32px rgba(150, 90, 70, 0.12)', // 漫反射柔和阴影
        cardBackdropFilter: 'blur(8px)',
        titleColor: '#e8b86d', // 纯白大标题
        descColor: '#F3E5DE', // 柔米粉次要描述文字
        itemBg: '#FAF6F0',
        itemTitleColor: '#332723',
        itemDescColor: '#8C7A73',
        itemBorderColor: 'transparent',
        itemBorderStyle: 'none',
        itemBorderWidth: '0px',
        itemRadius: '16px',
        upColor: '#C86D51', // 暖青绿高亮 (27.6M / 98%)
        downColor: '#3B9C96', // 陶土赤红高亮 (4.8k)
        btnBg: '#3B9C96', // 暖青绿主按钮 (View Dashboard)
        btnColor: '#FFFFFF',
        btnRadius: '12px',
        btnBorderColor: 'transparent',
        btnBorderStyle: 'none',
        btnBorderWidth: '0px',
        btnFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        btnShadow: '0 8px 20px rgba(59, 156, 150, 0.25)',
        tagBg: 'rgba(255, 255, 255, 0.2)', // 次级按钮背景 (Explore Styles)
        tagColor: '#FFFFFF',
        tagFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        tagBorderColor: 'rgba(255, 255, 255, 0.4)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '12px',
        // 特有温润仪表盘 (Warm Dashboard) Tokens
        primaryAccent: '#3B9C96', // 主高亮色：暖青绿 (Warm Teal)
        cardPinkBg: 'rgba(200, 109, 81, 0.15)',
        cardPinkColor: '#C86D51', // 陶土赤红 (4.8k)
        cardGreenBg: 'rgba(59, 156, 150, 0.15)',
        cardGreenColor: '#3B9C96', // 暖青绿 (27.6M)
        cardPurpleBg: 'rgba(216, 159, 83, 0.15)',
        cardPurpleColor: '#D89F53', // 赭石暖黄 (219k)
        cardOrangeBg: 'rgba(210, 158, 139, 0.15)',
        cardOrangeColor: '#D29E8B',
        navActiveBg: '#3B9C96',
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: 'rgba(255, 255, 255, 0.85)',
        calendarHighlightBg: '#3B9C96',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(216, 159, 83, 0.2)',
        scheduleOrangeBg: 'rgba(200, 109, 81, 0.2)',
        scheduleGreenBg: 'rgba(59, 156, 150, 0.2)',
        iconActiveColor: '#3B9C96',
        iconInactiveColor: 'rgba(255, 255, 255, 0.7)',
        sidebarBg: '#D29E8B',
        sidebarRadius: '0px'
    },
},
{
    id: 'neon-gradient-electric',
    name: '霓虹渐变',
    desc: 'Neon Gradient · 深色暗夜背景 + 高饱和鲜艳渐变卡片 + 粗彩色外框与霓虹强发光阴影 + 电光双色按钮',
    source: '#uploaded-image-31',
    tokens: {
        pageBg: '#0F0C1B', // 极深紫黑夜色背景[cite: 15]
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", // 现代无衬线字体[cite: 15]
        numberFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        cardBg: 'rgba(23, 19, 41, 0.6)', // 暗紫半透明卡片背景[cite: 15]
        cardBorderColor: '#00F2FE', // 霓虹电光青/粉外框[cite: 15]
        cardBorderWidth: '2px', // 粗彩色边框[cite: 15]
        cardRadius: '16px', // 柔和圆角卡片[cite: 15]
        cardShadow: '0 0 25px rgba(0, 242, 254, 0.35)', // 霓虹外发光阴影效果[cite: 15]
        cardBackdropFilter: 'blur(12px)',
        titleColor: '#FFFFFF', // 纯白大标题[cite: 15]
        descColor: '#A29DB5', // 浅紫灰描述文本[cite: 15]
        itemBg: 'rgba(23, 19, 41, 0.7)',
        itemTitleColor: '#FFFFFF',
        itemDescColor: '#A29DB5',
        itemBorderColor: 'rgba(255, 255, 255, 0.1)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '16px',
        upColor: '#FF2A85', // 电光青蓝[cite: 15]
        downColor: '#00F2FE', // 霓虹玫粉[cite: 15]
        btnBg: 'linear-gradient(135deg, #00F2FE 0%, #FF2A85 100%)', // 鲜艳渐变主按钮 (+ 开始免费试用)[cite: 15]
        btnColor: '#FFFFFF',
        btnRadius: '12px',
        btnBorderColor: 'transparent',
        btnBorderStyle: 'none',
        btnBorderWidth: '0px',
        btnFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        btnShadow: '0 0 20px rgba(0, 242, 254, 0.4)', // 按钮发光外阴影[cite: 15]
        tagBg: 'rgba(15, 12, 27, 0.8)', // 描边次级按钮背景 (观看演示)[cite: 15]
        tagColor: '#00F2FE',
        tagFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        tagBorderColor: '#00F2FE', // 霓虹青蓝边框[cite: 15]
        tagBorderStyle: 'solid',
        tagBorderWidth: '2px',
        tagRadius: '12px',
        // 特有霓虹渐变 (Neon Gradient) Tokens
        primaryAccent: '#FF2A85', // 主高亮色：霓虹玫粉[cite: 15]
        cardPinkBg: 'linear-gradient(135deg, #FF2A85 0%, #FF758C 100%)', // 团队协作卡片渐变[cite: 15]
        cardPinkColor: '#FFFFFF',
        cardGreenBg: 'linear-gradient(135deg, #00F5A0 0%, #00D9F6 100%)', // 安全加密卡片渐变[cite: 15]
        cardGreenColor: '#FFFFFF',
        cardPurpleBg: 'linear-gradient(135deg, #FFD166 0%, #FF2A85 100%)', // 极速响应卡片渐变[cite: 15]
        cardPurpleColor: '#FFFFFF',
        cardOrangeBg: 'rgba(255, 42, 133, 0.15)',
        cardOrangeColor: '#FF2A85',
        navActiveBg: 'linear-gradient(135deg, #FF2A85 0%, #00F2FE 100%)', // 顶部 StyleKit 按钮背景[cite: 15]
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#A29DB5',
        calendarHighlightBg: '#FF2A85',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(255, 42, 133, 0.25)',
        scheduleOrangeBg: 'rgba(255, 209, 102, 0.25)',
        scheduleGreenBg: 'rgba(0, 245, 160, 0.25)',
        iconActiveColor: '#00F2FE',
        iconInactiveColor: '#524B6B',
        sidebarBg: '#0F0C1B',
        sidebarRadius: '0px'
    },
},
{
    id: 'kawaii-minimal',
    name: 'Kawaii Minimal 可爱极简',
    desc: 'Kawaii Minimal · 柔和暖奶油底色 + 马卡龙粉紫蓝低饱和配色 + 极圆胶囊卡片与按钮 + 日式治愈系留白',
    source: '#uploaded-image-33',
    tokens: {
        pageBg: '#FFFBF2', // 柔和暖奶油色背景[cite: 16]
        fontFamily: "'Nunito', 'Quicksand', -apple-system, BlinkMacSystemFont, sans-serif", // 圆润治愈无衬线体[cite: 16]
       numberFontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        cardBg: '#FFFFFF', // 纯白温润卡片[cite: 16]
        cardBorderColor: 'rgba(255, 180, 195, 0.25)', // 极淡马卡龙粉边框[cite: 16]
        cardBorderWidth: '1px',
        cardRadius: '24px', // 超大极圆胶囊弧度[cite: 16]
        cardShadow: '0 12px 32px rgba(255, 180, 195, 0.15)', // 柔和粉润弥散阴影[cite: 16]
        cardBackdropFilter: 'none',
        titleColor: '#2D3142', // 暗哑黑灰主标题 (Soft. Warm.)[cite: 16]
        descColor: '#7D8299', // 柔灰次要描述文本[cite: 16]
        itemBg: '#FFFFFF',
        itemTitleColor: '#2D3142',
        itemDescColor: '#7D8299',
        itemBorderColor: 'transparent',
        itemBorderStyle: 'none',
        itemBorderWidth: '0px',
        itemRadius: '24px',
        upColor: '#FF6584', // 软萌粉高亮 (8,400+)[cite: 16]
        downColor: '#38C1B7', // 马卡龙青绿高亮 (156k)[cite: 16]
        btnBg: 'linear-gradient(135deg, #FF94B9 0%, #FF809B 100%)', // 柔粉渐变主按钮 (Get Started)[cite: 16]
        btnColor: '#FFFFFF',
        btnRadius: '999px', // 极致胶囊圆角[cite: 16]
        btnBorderColor: 'transparent',
        btnBorderStyle: 'none',
        btnBorderWidth: '0px',
        btnFontFamily: "'Nunito', sans-serif",
        btnShadow: '0 8px 20px rgba(255, 128, 155, 0.35)', // 按钮弥散发光阴影[cite: 16]
        tagBg: '#FFFFFF', // 白底描边次级按钮 (Explore)[cite: 16]
        tagColor: '#FF6584',
        tagFontFamily: "'Nunito', sans-serif",
        tagBorderColor: '#FFB4C3', // 粉色描边[cite: 16]
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '999px',
        // 特有可爱极简 (Kawaii Minimal) 马卡龙配色 Tokens
        primaryAccent: '#FF809B', // 主高亮色：蜜桃粉[cite: 16]
        cardPinkBg: 'rgba(255, 148, 185, 0.15)',
        cardPinkColor: '#FF6584', // 蜜桃粉 (8,400+)[cite: 16]
        cardGreenBg: 'rgba(56, 193, 183, 0.15)',
        cardGreenColor: '#38C1B7', // 马卡龙绿 (156k)[cite: 16]
        cardPurpleBg: 'rgba(145, 121, 242, 0.15)',
        cardPurpleColor: '#9179F2', // 香草紫 (24k)[cite: 16]
        cardOrangeBg: 'rgba(244, 180, 26, 0.15)',
        cardOrangeColor: '#F4B41A', // 柠檬暖黄 (4.9)[cite: 16]
        navActiveBg: 'linear-gradient(135deg, #FF94B9 0%, #FF809B 100%)',
        navActiveColor: '#FFFFFF',
        navInactiveBg: 'transparent',
        navInactiveColor: '#7D8299',
        calendarHighlightBg: '#FF809B',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(145, 121, 242, 0.25)',
        scheduleOrangeBg: 'rgba(244, 180, 26, 0.25)',
        scheduleGreenBg: 'rgba(56, 193, 183, 0.25)',
        iconActiveColor: '#FF809B',
        iconInactiveColor: '#C4C8D8',
        sidebarBg: '#FFFBF2',
        sidebarRadius: '0px'
    },
},
{
    id: 'frutiger-aero-vista-nature',
    name: 'Frutiger Aero 自然科技风',
    desc: 'Frutiger Aero · 晴空天蓝渐变底色 + Vista 拟真水晶毛玻璃卡片 + 上半部分高光反射与极光微光 + 2010 年代清爽自然科技质感',
    source: '#uploaded-image-34',
    tokens: {
        pageBg: 'linear-gradient(180deg, #64C8FA 0%, #3DA9F6 100%)', // 晴空天蓝水润渐变背景[cite: 17]
        fontFamily: "'Segoe UI', 'Frutiger', -apple-system, BlinkMacSystemFont, sans-serif", // 经典 Vista / Frutiger 科技无衬线体[cite: 17]
        numberFontFamily: "'Segoe UI', -apple-system, sans-serif",
        cardBg: 'rgba(255, 255, 255, 0.45)', // 拟真水晶玻璃半透明卡片[cite: 17]
        cardBorderColor: 'rgba(255, 255, 255, 0.8)', // 高亮通透玻璃边缘[cite: 17]
        cardBorderWidth: '1px',
        cardRadius: '20px', // 柔和温润大圆角[cite: 17]
        cardShadow: '0 15px 35px rgba(0, 80, 160, 0.25), inset 0 1px 2px rgba(255, 255, 255, 0.9)', // 水晶顶反射与天空沉降阴影[cite: 17]
        cardBackdropFilter: 'blur(20px) saturate(160%)', // 通透高饱和毛玻璃[cite: 17]
        titleColor: '#FFFFFF', // 纯白高光大标题[cite: 17]
        descColor: 'rgba(255, 255, 255, 0.9)', // 通透白色描述文本[cite: 17]
        itemBg: 'rgba(255, 255, 255, 0.5)',
        itemTitleColor: '#0F4A75', // 深水蓝文字[cite: 17]
        itemDescColor: '#2D6A98',
        itemBorderColor: 'rgba(255, 255, 255, 0.8)',
        itemBorderStyle: 'solid',
        itemBorderWidth: '1px',
        itemRadius: '16px',
        upColor: '#0288D1', // 自然生机翡翠绿[cite: 17]
        downColor: '#10B981', // 水润深蓝色[cite: 17]
        btnBg: 'linear-gradient(180deg, #FFFFFF 0%, #E0F2FE 100%)', // 水晶高光白色胶囊主按钮 (Explore the Aesthetic)[cite: 17]
        btnColor: '#0F4A75', // 深深海蓝按钮文字[cite: 17]
        btnRadius: '999px', // 极圆胶囊按钮[cite: 17]
        btnBorderColor: 'rgba(255, 255, 255, 0.9)',
        btnBorderStyle: 'solid',
        btnBorderWidth: '1px',
        btnFontFamily: "'Segoe UI', sans-serif",
        btnShadow: '0 6px 18px rgba(0, 100, 180, 0.2), inset 0 1px 0 rgba(255, 255, 255, 1)', // 顶部通透反射与外阴影[cite: 17]
        tagBg: 'rgba(255, 255, 255, 0.3)', // 小圆环图标背景[cite: 17]
        tagColor: '#0F4A75',
        tagFontFamily: "'Segoe UI', sans-serif",
        tagBorderColor: 'rgba(255, 255, 255, 0.6)',
        tagBorderStyle: 'solid',
        tagBorderWidth: '1px',
        tagRadius: '999px',
        // 特有 Frutiger Aero 自然科技风 Tokens
        primaryAccent: '#36B1F4', // 主高亮色：天蓝水润色[cite: 17]
        cardPinkBg: 'rgba(255, 255, 255, 0.35)',
        cardPinkColor: '#0F4A75',
        cardGreenBg: 'rgba(200, 245, 220, 0.5)', // 拟真生态薄荷绿块[cite: 17]
        cardGreenColor: '#0F5A38',
        cardPurpleBg: 'rgba(210, 230, 255, 0.5)',
        cardPurpleColor: '#0F4A75',
        cardOrangeBg: 'rgba(255, 255, 255, 0.4)',
        cardOrangeColor: '#0F4A75',
        navActiveBg: 'rgba(255, 255, 255, 0.6)',
        navActiveColor: '#0F4A75',
        navInactiveBg: 'transparent',
        navInactiveColor: 'rgba(255, 255, 255, 0.85)',
        calendarHighlightBg: '#36B1F4',
        calendarHighlightColor: '#FFFFFF',
        schedulePurpleBg: 'rgba(255, 255, 255, 0.3)',
        scheduleOrangeBg: 'rgba(200, 245, 220, 0.4)',
        scheduleGreenBg: 'rgba(54, 177, 244, 0.3)',
        iconActiveColor: '#0F4A75',
        iconInactiveColor: 'rgba(15, 74, 117, 0.5)',
        sidebarBg: 'linear-gradient(180deg, #64C8FA 0%, #3DA9F6 100%)',
        sidebarRadius: '0px'
    },
},

];

// 根据 id 获取主题包；'' / undefined / 'default' 返回 null（默认样式）
export const getThemePack = (id) => {
    if (!id || id === 'default') return null;
    return THEME_PACKS.find(p => p.id === id) || null;
};

// 将主题包 token 转为 CSS 变量 style 对象（用于 React style / 挂到容器上）
export const buildPackVars = (pack) => {
    if (!pack?.tokens) return undefined;
    const t = pack.tokens;
    const vars = {};
    Object.entries(TOKEN_TO_VAR).forEach(([key, varName]) => {
        const val = t[key];
        if (val !== undefined && val !== null && val !== '') {
            vars[varName] = val;
        }
    });
    // 派生涨跌标签底色（半透明）
    if (!vars['--dp-up-bg'] && t.upColor) vars['--dp-up-bg'] = hexToRgba(t.upColor, 0.14);
    if (!vars['--dp-down-bg'] && t.downColor) vars['--dp-down-bg'] = hexToRgba(t.downColor, 0.14);
    return vars;
};
