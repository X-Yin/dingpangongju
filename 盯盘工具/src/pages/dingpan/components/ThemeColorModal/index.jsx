import { useEffect, useState } from 'react';
import { Modal, Input, InputNumber, Radio, Switch, Space, Typography, ColorPicker } from 'antd';
import { BgColorsOutlined } from '@ant-design/icons';
import { DEFAULT_THEME_COLOR, FONT_FAMILY_OPTIONS } from '../../utils/themeColor';
import './index.scss';

const { Text } = Typography;

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

    const handleOk = () => {
        onOk({
            itemTitleColor: draft.itemTitleColor || '',
            itemBorderColor: draft.itemBorderColor || '',
            numberFontFamily: draft.numberFontFamily || '',
            numberFontSize: draft.numberFontSize || '',
        });
    };

    const renderColorField = (field, label) => {
        const enabled = !!draft[field];
        const colorValue = draft[field] || 'var(--ios-blue)';
        return (
            <div className="theme-color-field">
                <div className="theme-color-field-header">
                    <Text strong>{label}</Text>
                    <Space size={8}>
                        <Text type="secondary" style={{ fontSize: 12 }}>自定义</Text>
                        <Switch
                            size="small"
                            checked={enabled}
                            onChange={(checked) => updateField(field, checked ? (draft[field] || 'var(--ios-blue)') : '')}
                        />
                    </Space>
                </div>
                {enabled && (
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
                )}
                {!enabled && (
                    <Text type="secondary" style={{ fontSize: 12 }}>未设置，使用 CSS 默认颜色</Text>
                )}
            </div>
        );
    };

    return (
        <Modal
            title={<><BgColorsOutlined style={{ marginRight: 8 }} />DIY 主题色设置</>}
            open={open}
            onCancel={onCancel}
            onOk={handleOk}
            okText="保存"
            cancelText="取消"
            width={480}
            destroyOnClose
        >
            <div className="theme-color-modal-body">
                <div className="theme-color-tip">
                    <Text type="secondary" style={{ fontSize: 12}}>
                        颜色可通过取色器选择或直接输入（支持 #RRGGBB、rgba() 等格式）；关闭开关则使用 CSS 默认样式。数字字体仅支持单选，字号可按需调整。
                    </Text>
                </div>
                {renderColorField('itemTitleColor', '卡片标题颜色')}
                {renderColorField('itemBorderColor', '卡片边框颜色')}
                <div className="theme-color-field">
                    <div className="theme-color-field-header">
                        <Text strong>数字字体</Text>
                        <Space size={8}>
                            <Text type="secondary" style={{ fontSize: 12 }}>自定义</Text>
                            <Switch
                                size="small"
                                checked={!!draft.numberFontFamily}
                                onChange={(checked) => updateField('numberFontFamily', checked ? 'SF Mono' : '')}
                            />
                        </Space>
                    </div>
                    {draft.numberFontFamily ? (
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
        </Modal>
    );
};

export default ThemeColorModal;
