import { useEffect, useState } from 'react';
import { Modal, Input, InputNumber, Radio, Switch, Space, Typography, ColorPicker } from 'antd';
import { BgColorsOutlined, SkinOutlined } from '@ant-design/icons';
import { DEFAULT_THEME_COLOR, FONT_FAMILY_OPTIONS } from '../../utils/themeColor';
import { THEME_PACKS } from '../../utils/themePacks';
import './index.scss';

const { Text } = Typography;

// 默认主题预览配置（与当前页面默认样式近似）
const DEFAULT_PACK_OPTION = {
    id: '',
    name: '默认主题',
    desc: '当前样式（可叠加 DIY 自定义）',
    preview: {
        pageBg: 'linear-gradient(180deg, #f6f9ff, #eef4ff)',
        cardBg: 'rgba(255, 255, 255, 0.9)',
        cardBorderColor: 'rgba(255, 255, 255, 0.9)',
        cardBorderWidth: '1px',
        cardRadius: '10px',
        titleColor: '#12213a',
        upColor: '#e11d48',
        downColor: '#059669',
        accentColor: '#6366f1',
    },
};

// 主题包选项预览配置（供弹窗小卡片使用）
const buildPackOption = (pack) => {
    const t = pack.tokens || {};
    return {
        id: pack.id,
        name: pack.name,
        desc: pack.desc,
        preview: {
            pageBg: t.pageBg || '#f6f9ff',
            cardBg: t.cardBg || 'rgba(255,255,255,0.9)',
            cardBorderColor: t.cardBorderColor || 'transparent',
            cardBorderWidth: t.cardBorderWidth || '1px',
            cardRadius: t.cardRadius || '10px',
            titleColor: t.titleColor || (t.itemTitleColor ?? '#12213a'),
            upColor: t.upColor || '#e11d48',
            downColor: t.downColor || '#059669',
            // 强调色优先用按钮/标签背景（渐变也可以直接作为背景展示）
            accentColor: t.btnBg || t.tagBg || t.cardBorderColor || '#6366f1',
        },
    };
};

const ThemeColorModal = ({ open, onCancel, onOk, value }) => {
    const [draft, setDraft] = useState(DEFAULT_THEME_COLOR);

    useEffect(() => {
        if (open && value) {
            setDraft({ ...DEFAULT_THEME_COLOR, ...value });
        }
    }, [open, value]);

    const updateField = (field, val) => {
        setDraft(prev => ({ ...prev, [field]: val }));
    };

    // 当前是否已选择主题包（默认主题 id 为 ''）
    const packActive = !!draft.pack;

    const handleOk = () => {
        onOk({
            pack: draft.pack || '',
            // 主题包生效时 DIY 字段不参与生效，保存时清空避免残留
            itemTitleColor: packActive ? '' : (draft.itemTitleColor || ''),
            itemBorderColor: packActive ? '' : (draft.itemBorderColor || ''),
            numberFontFamily: packActive ? '' : (draft.numberFontFamily || ''),
            numberFontSize: packActive ? '' : (draft.numberFontSize || ''),
        });
    };

    const renderPackOption = (option) => {
        const p = option.preview || {};
        const selected = (draft.pack || '') === option.id;
        return (
            <div
                key={option.id || 'default'}
                className={`theme-pack-option${selected ? ' selected' : ''}`}
                onClick={() => updateField('pack', option.id)}
            >
                <div className="theme-pack-preview" style={{ background: p.pageBg }}>
                    <div
                        className="theme-pack-preview-card"
                        style={{
                            background: p.cardBg,
                            borderColor: p.cardBorderColor,
                            borderWidth: p.cardBorderWidth,
                            borderRadius: p.cardRadius,
                        }}
                    >
                        <span className="theme-pack-preview-title" style={{ color: p.titleColor }}>监控面板</span>
                        <div className="theme-pack-preview-bars">
                            <span style={{ background: p.upColor }} />
                            <span style={{ background: p.downColor }} />
                            <span style={{ background: p.accentColor }} />
                        </div>
                    </div>
                </div>
                <div className="theme-pack-option-name">
                    {option.id ? <span className="theme-pack-source">{option.source}</span> : null}
                    {option.name}
                </div>
                <div className="theme-pack-option-desc">{option.desc}</div>
                {selected && <div className="theme-pack-check">✓</div>}
            </div>
        );
    };

    const renderColorField = (field, label) => {
        const enabled = !packActive && !!draft[field];
        const colorValue = draft[field];
        return (
            <div className={`theme-color-field${packActive ? ' disabled' : ''}`}>
                <div className="theme-color-field-header">
                    <Text strong>{label}</Text>
                    <Space size={8}>
                        <Text type="secondary" style={{ fontSize: 12 }}>自定义</Text>
                        <Switch
                            size="small"
                            disabled={packActive}
                            checked={enabled}
                            onChange={(checked) => updateField(field, checked ? (draft[field] || '#007AFF') : '')}
                        />
                    </Space>
                </div>
                {packActive ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>主题包已生效，此 DIY 项已禁用</Text>
                ) : enabled ? (
                    <div className="theme-color-field-body">
                        <ColorPicker
                            value={colorValue}
                            onChange={(color) => updateField(field, color.toHexString())}
                            showText
                            format="hex"
                        />
                        <Input
                            placeholder="如 #FFFF00 或 rgba(255,255,0,0.5)"
                            value={draft[field]}
                            onChange={(e) => updateField(field, e.target.value)}
                            style={{ flex: 1 }}
                            size="small"
                        />
                    </div>
                ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>未设置，使用 CSS 默认颜色</Text>
                )}
            </div>
        );
    };

    return (
        <Modal
            title={<><BgColorsOutlined style={{ marginRight: 8 }} />主题与 DIY 主题色设置</>}
            open={open}
            onCancel={onCancel}
            onOk={handleOk}
            okText="保存"
            cancelText="取消"
            width={760}
            // 内容区最高 500px，超出滚动；footer（保存/取消）固定在弹窗底部
            styles={{ body: { maxHeight: 500, overflowY: 'auto' } }}
            destroyOnClose
        >
            <div className="theme-color-modal-body">
                {/* 主题包选择 */}
                <div className="theme-pack-section">
                    <div className="theme-pack-section-header">
                        <SkinOutlined style={{ marginRight: 6 }} />
                        <Text strong>主题包</Text>
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                            仅作用于盯盘页外层组件；弹窗、Tooltip 保持原样式
                        </Text>
                    </div>
                    <div className="theme-pack-grid">
                        {[DEFAULT_PACK_OPTION, ...THEME_PACKS.map(buildPackOption)].map(renderPackOption)}
                    </div>
                    {packActive && (
                        <div className="theme-color-tip" style={{ marginTop: 10 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                                当前已启用主题包，下方 DIY 自定义（标题颜色 / 边框颜色 / 数字字体）已全部禁用；切回「默认主题」后可恢复 DIY。
                            </Text>
                        </div>
                    )}
                </div>

                {/* DIY 自定义（主题包生效时禁用） */}
                <div className={`theme-diy-section${packActive ? ' disabled' : ''}`}>
                    <div className="theme-pack-section-header">
                        <BgColorsOutlined style={{ marginRight: 6 }} />
                        <Text strong>DIY 自定义</Text>
                        {packActive && (
                            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>(主题包生效期间禁用)</Text>
                        )}
                    </div>
                    <div className="theme-diy-fields">
                        {renderColorField('itemTitleColor', '卡片标题颜色')}
                        {renderColorField('itemBorderColor', '卡片边框颜色')}
                        <div className={`theme-color-field${packActive ? ' disabled' : ''}`}>
                            <div className="theme-color-field-header">
                                <Text strong>数字字体</Text>
                                <Space size={8}>
                                    <Text type="secondary" style={{ fontSize: 12 }}>自定义</Text>
                                    <Switch
                                        size="small"
                                        disabled={packActive}
                                        checked={!packActive && !!draft.numberFontFamily}
                                        onChange={(checked) => updateField('numberFontFamily', checked ? 'SF Mono' : '')}
                                    />
                                </Space>
                            </div>
                            {packActive ? (
                                <Text type="secondary" style={{ fontSize: 12 }}>主题包已生效，此 DIY 项已禁用</Text>
                            ) : draft.numberFontFamily ? (
                                <>
                                    <Radio.Group
                                        value={draft.numberFontFamily}
                                        onChange={(e) => updateField('numberFontFamily', e.target.value)}
                                        className="theme-color-font-radio"
                                    >
                                        {FONT_FAMILY_OPTIONS.map(font => (
                                            <Radio key={font} value={font} style={{ fontFamily: font }}>
                                                {font}
                                            </Radio>
                                        ))}
                                    </Radio.Group>
                                    <div className="theme-color-font-size-row">
                                        <Text type="secondary" style={{ fontSize: 12 }}>数字字号</Text>
                                        <InputNumber
                                            size="small"
                                            min={8}
                                            max={36}
                                            step={1}
                                            placeholder="不填则用默认"
                                            value={draft.numberFontSize === '' ? null : Number(draft.numberFontSize)}
                                            onChange={(val) => updateField('numberFontSize', val == null ? '' : val)}
                                            style={{ width: 120 }}
                                            addonAfter="px"
                                        />
                                        <Text type="secondary" style={{ fontSize: 11 }}>同一字号下不同字体展示大小不同，可按需调整</Text>
                                    </div>
                                </>
                            ) : (
                                <Text type="secondary" style={{ fontSize: 12 }}>未设置，使用 CSS 默认字体</Text>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
};

export default ThemeColorModal;
