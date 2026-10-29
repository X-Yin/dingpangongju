import { useEffect, useState } from 'react';
import { Modal, Input, InputNumber, Radio, Switch, Space, Typography, ColorPicker, Popconfirm, Button, message, Drawer } from 'antd';
import { BgColorsOutlined, SkinOutlined, DeleteOutlined, PlusOutlined, CheckCircleOutlined, EditOutlined } from '@ant-design/icons';
import { DEFAULT_THEME_COLOR, FONT_FAMILY_OPTIONS } from '../../utils/themeColor';
import { THEME_PACKS } from '../../utils/themePacks';
import './index.scss';

const { Text } = Typography;
const { TextArea } = Input;

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
        desc: pack.desc || '',
        source: pack.source || '',
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

// 仅校验输入的 JSON 字符串是否合法；合法返回 null，否则返回错误提示
const validatePackText = (text) => {
    if (!text || !text.trim()) return '请输入主题包 JSON';
    try {
        JSON.parse(text);
    } catch (error) {
        return `JSON 格式错误：${error.message}`;
    }
    return null;
};

// token 字段中文名（编辑抽屉展示用；未知字段直接展示原始 key）
const TOKEN_LABELS = {
    pageBg: '页面背景',
    fontFamily: '全局字体',
    numberFontFamily: '数字字体',
    cardBg: '卡片背景',
    cardBorderColor: '卡片边框',
    titleColor: '标题颜色',
    descColor: '描述颜色',
    itemBg: '子项背景',
    itemTitleColor: '子项标题',
    itemDescColor: '子项描述',
    itemBorderColor: '子项边框',
    upColor: '涨幅颜色',
    downColor: '跌幅颜色',
    upBg: '涨幅底色',
    downBg: '跌幅底色',
    btnBg: '按钮背景',
    btnColor: '按钮文字',
    btnBorderColor: '按钮边框',
    tagBg: '标签背景',
    tagColor: '标签文字',
    tagBorderColor: '标签边框',
};

// 纯色值匹配（排除渐变色、阴影、字体、圆角等非颜色 token；transparent 无实际色值不参与编辑）
const COLOR_VALUE_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb(?:a)?\(\s*[^)]*\)|hsl(?:a)?\(\s*[^)]*\))$/i;

// 提取主题包中可编辑的纯色字段（渐变色不参与编辑）
const getColorFields = (pack) => Object.entries(pack?.tokens || {}).filter(([, val]) => {
    if (typeof val !== 'string') return false;
    const text = val.trim();
    if (/gradient/i.test(text)) return false;
    return COLOR_VALUE_RE.test(text);
});

const ThemeColorModal = ({ open, onCancel, onOk, onPreview, value, packs, onAddPack, onUpdatePack, onDeletePack, onPreviewPackData }) => {
    const [draft, setDraft] = useState(DEFAULT_THEME_COLOR);
    // 添加主题包表单
    const [addVisible, setAddVisible] = useState(false);
    const [addText, setAddText] = useState('');
    const [addError, setAddError] = useState('');
    const [adding, setAdding] = useState(false);
    const [deletingId, setDeletingId] = useState('');
    // 编辑主题包颜色抽屉
    const [editVisible, setEditVisible] = useState(false);
    const [editPackId, setEditPackId] = useState('');
    const [editTokens, setEditTokens] = useState({}); // 仅记录被修改的颜色字段
    const [savingEdit, setSavingEdit] = useState(false);
    // 后端返回的主题包列表；未加载（undefined）时回退到本地静态列表
    const packList = Array.isArray(packs) ? packs : THEME_PACKS;
    // 正在编辑的主题包及其纯色字段
    const editingPack = packList.find(p => p.id === editPackId);
    const editColorFields = getColorFields(editingPack);

    useEffect(() => {
        if (open && value) {
            setDraft({ ...DEFAULT_THEME_COLOR, ...value });
            setAddVisible(false);
            setAddText('');
            setAddError('');
            setEditVisible(false);
            setEditPackId('');
            setEditTokens({});
        }
    }, [open, value]);

    const updateField = (field, val) => {
        setDraft(prev => ({ ...prev, [field]: val }));
    };

    // 当前是否已选择主题包（默认主题 id 为 ''）
    const packActive = !!draft.pack;

    useEffect(() => {
        const id = draft.pack;
        if (id) {
            setTimeout(() => {
                const el = document.querySelector(`div.theme-pack-option.selected`);
                el && el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 20);
        }
    }, [draft]);

    const handleOk = () => {
        onOk({
            pack: draft.pack || '',
            randomPlay: !!draft.randomPlay,
            // 主题包生效时 DIY 字段不参与生效，保存时清空避免残留
            itemTitleColor: packActive ? '' : (draft.itemTitleColor || ''),
            itemBorderColor: packActive ? '' : (draft.itemBorderColor || ''),
            numberFontFamily: packActive ? '' : (draft.numberFontFamily || ''),
            numberFontSize: packActive ? '' : (draft.numberFontSize || ''),
        });
    };

    const selectPack = (id) => {
        updateField('pack', id);
        // 点击即实时预览（不写入存储），点「保存」才持久化，取消关闭则恢复原主题
        onPreview && onPreview(id);
    };

    // 添加主题包：仅校验 JSON 字符串合法性后提交后端
    const handleAdd = async () => {
        const error = validatePackText(addText);
        if (error) {
            setAddError(error);
            return;
        }
        setAddError('');
        setAdding(true);
        try {
            await onAddPack(JSON.parse(addText));
            message.success('主题包添加成功');
            setAddText('');
            setAddVisible(false);
        } catch (err) {
            const msg = err?.response?.data?.message || err?.message || '添加主题包失败';
            setAddError(msg);
        } finally {
            setAdding(false);
        }
    };

    // 打开编辑主题包颜色的侧边抽屉
    const openEditPack = (packId) => {
        if (!packId) return;
        setEditPackId(packId);
        setEditTokens({});
        // 先清空实时预览，保证以已保存的颜色为基准
        onPreviewPackData && onPreviewPackData(null);
        setEditVisible(true);
    };

    // 颜色选择器变化：实时更新页面预览，但不写入后端
    const handleEditColorChange = (key, color) => {
        const nextTokens = { ...editTokens, [key]: color.toCssString() };
        setEditTokens(nextTokens);
        const pack = packList.find(p => p.id === editPackId);
        if (pack && onPreviewPackData) {
            onPreviewPackData({ ...pack, tokens: { ...pack.tokens, ...nextTokens } });
        }
    };

    // 关闭编辑抽屉：丢弃未保存的预览，恢复后端颜色
    const closeEditPack = () => {
        setEditVisible(false);
        onPreviewPackData && onPreviewPackData(null);
    };

    // 保存编辑后的颜色：只提交被修改的 token，后端合并存储
    const handleSaveEdit = async () => {
        if (!editPackId) return;
        setSavingEdit(true);
        try {
            await onUpdatePack(editPackId, editTokens);
            message.success('主题包颜色已保存');
            setEditVisible(false);
            // 后端已更新，释放预览覆盖，改用最新列表数据
            onPreviewPackData && onPreviewPackData(null);
        } catch (err) {
            message.error(err?.response?.data?.message || err?.message || '保存主题包颜色失败');
        } finally {
            setSavingEdit(false);
        }
    };

    // 删除主题包；若删除的是当前选中/预览中的主题，回退到默认主题
    const handleDelete = async (id) => {
        setDeletingId(id);
        try {
            await onDeletePack(id);
            if ((draft.pack || '') === id) {
                updateField('pack', '');
                onPreview && onPreview('');
            }
            message.success('主题包已删除');
        } catch (err) {
            message.error(err?.response?.data?.message || err?.message || '删除主题包失败');
        } finally {
            setDeletingId('');
        }
    };

    const renderPackOption = (option) => {
        const p = option.preview || {};
        const selected = (draft.pack || '') === option.id;
        return (
            <div
                key={option.id || 'default'}
                className={`theme-pack-option${selected ? ' selected' : ''}`}
                onClick={() => selectPack(option.id)}
            >
                {option.id ? (
                    <Popconfirm
                        title={`删除主题包「${option.name}」？`}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true, loading: deletingId === option.id }}
                        onConfirm={() => handleDelete(option.id)}
                    >
                        <span className="theme-pack-delete" onClick={(e) => e.stopPropagation()}>
                            <DeleteOutlined />
                        </span>
                    </Popconfirm>
                ) : null}
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
                    {option.id ? <span className="theme-pack-source">{option.source || '自定义'}</span> : null}
                    {option.name}
                </div>
                <div className="theme-pack-option-desc">{(option.desc || '').slice(0, 30)}{(option.desc || '').length > 30 ? '...' : ''}</div>
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
        <>
        <Modal
            title={<><BgColorsOutlined style={{ marginRight: 8 }} />主题与 DIY 主题色设置</>}
            open={open}
            onCancel={onCancel}
            onOk={handleOk}
            width={1200}
            // 内容区最高 500px，超出纵向滚动；禁止横向滚动
            styles={{ body: { maxHeight: 500, overflowY: 'auto', overflowX: 'hidden' } }}
            destroyOnClose
            footer={[
                <Button key="cancel" onClick={onCancel}>取消</Button>,
                <Button
                    key="edit"
                    icon={<EditOutlined />}
                    disabled={!packActive}
                    onClick={() => openEditPack(draft.pack)}
                >
                    编辑选中主题
                </Button>,
                <Button
                    key="add"
                    icon={<PlusOutlined />}
                    onClick={() => {
                        setAddError('');
                        setAddVisible(true);
                    }}
                >
                    添加主题包
                </Button>,
                <Button key="save" type="primary" onClick={handleOk}>保存</Button>,
            ]}
        >
            <div className="theme-color-modal-body">
                {/* 主题包选择 */}
                <div className="theme-pack-section">
                    <div className="theme-pack-section-header">
                        <SkinOutlined style={{ marginRight: 6 }} />
                        <Text strong>主题包</Text>
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                            仅作用于盯盘页外层组件；弹窗、Tooltip 保持原样式（列表来自后端）
                        </Text>
                    </div>
                    <div className="theme-pack-grid">
                        {[DEFAULT_PACK_OPTION, ...packList.map(buildPackOption)].map(renderPackOption)}
                    </div>
                    {/* 随机播放：每隔 5 分钟自动随机切换一个主题包 */}
                    <div
                        className="theme-shuffle-row"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginTop: 10,
                            padding: '8px 12px',
                            background: draft.randomPlay ? 'rgba(22, 119, 255, 0.08)' : 'rgba(0, 0, 0, 0.03)',
                            borderRadius: 8,
                        }}
                    >
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Text strong style={{ fontSize: 13 }}>随机播放</Text>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                                开启后每隔 5 分钟自动随机切换一个主题包（仅在主题包之间轮换，不会切回默认主题）
                            </Text>
                        </div>
                        <Switch
                            checked={!!draft.randomPlay}
                            onChange={(checked) => updateField('randomPlay', checked)}
                        />
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

        {/* 添加主题包：右侧抽屉输入 JSON */}
        <Drawer
            title={<><PlusOutlined style={{ marginRight: 8 }} />添加主题包</>}
            placement="left"
            size={480}
            zIndex={1100}
            open={addVisible}
            onClose={() => setAddVisible(false)}
            destroyOnHidden
        >
            <div className="theme-pack-add">
                <TextArea
                    value={addText}
                    onChange={(e) => {
                        setAddText(e.target.value);
                        setAddError('');
                    }}
                    rows={14}
                    spellCheck={false}
                    placeholder={`{\n  "id": "my-theme",\n  "name": "我的主题",\n  "desc": "自定义主题包",\n  "source": "自定义",\n  "tokens": {\n    "pageBg": "linear-gradient(135deg, #667eea, #764ba2)",\n    "cardBg": "rgba(255,255,255,0.8)",\n    "upColor": "#e11d48",\n    "downColor": "#059669"\n  }\n}`}
                    style={{ fontFamily: 'monospace', fontSize: 12, height: 800 }}
                />
                {addError && (
                    <Text type="danger" style={{ fontSize: 12 }}>{addError}</Text>
                )}
                <div className="theme-pack-add-footer">
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        仅校验 JSON 格式，字段内容会原样保存
                    </Text>
                    <Button type="primary" size="small" loading={adding} onClick={handleAdd} icon={<CheckCircleOutlined />}>
                        校验并添加
                    </Button>
                </div>
            </div>
        </Drawer>

        {/* 编辑主题包颜色：右侧抽屉，仅纯色字段可用颜色选择器修改 */}
        <Drawer
            title={<><EditOutlined style={{ marginRight: 8 }} />编辑主题包颜色</>}
            placement="left"
            size={480}
            zIndex={1100}
            open={editVisible}
            onClose={closeEditPack}
            destroyOnHidden
        >
            <div className="theme-pack-edit">
                <Text type="secondary" style={{ fontSize: 12 }}>
                    {editingPack?.name || editPackId} · 渐变色字段不支持编辑
                </Text>
                {editColorFields.length ? editColorFields.map(([key, val]) => (
                    <div className="theme-pack-edit-field" key={key}>
                        <div className="theme-pack-edit-label">
                            <Text strong style={{ fontSize: 13 }}>{TOKEN_LABELS[key] || key}</Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>{key}</Text>
                        </div>
                        <ColorPicker
                            value={editTokens[key] ?? val}
                            showText
                            onChange={(color) => handleEditColorChange(key, color)}
                        />
                    </div>
                )) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>该主题包没有可编辑的纯色字段</Text>
                )}
                <div className="theme-pack-edit-footer">
                    <Button onClick={closeEditPack}>取消</Button>
                    <Button type="primary" loading={savingEdit} onClick={handleSaveEdit}>
                        保存
                    </Button>
                </div>
            </div>
        </Drawer>
        </>
    );
};

export default ThemeColorModal;
