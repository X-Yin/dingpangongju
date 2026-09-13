import { useState, useEffect, useCallback } from 'react';
import { Modal, Button, Input, DatePicker, Tag, Empty, Spin, Popconfirm, message, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ApartmentOutlined, ArrowLeftOutlined, CheckCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../constant';
import './index.scss';

const { TextArea } = Input;

const isWeekendDay = (date) => {
    const day = dayjs(date).day();
    return day === 0 || day === 6;
};

const disabledDate = (current) => {
    if (!current) return false;
    if (current.isAfter(dayjs().endOf('day'))) return true;
    return isWeekendDay(current);
};

const IndexOverlayGroupModal = ({
    open,
    onClose,
    onApplyDates,
}) => {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // 表单视图：null 表示显示分组列表，对象表示正在编辑（{ id, title, description, dates }）
    const [formState, setFormState] = useState(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dates, setDates] = useState([]);

    const fetchGroups = useCallback(async () => {
        setLoading(true);
        try {
            const res = await axios.get(`http://${local_ip}:3000/indexOverlayGroup/list`);
            if (res.data && res.data.success) {
                setGroups(res.data.data || []);
            }
        } catch (e) {
            console.error('获取分组列表失败:', e);
            message.error('获取分组列表失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) {
            fetchGroups();
        }
    }, [open, fetchGroups]);

    const handleClose = () => {
        setFormState(null);
        setTitle('');
        setDescription('');
        setDates([]);
        onClose();
    };

    const startCreate = () => {
        setFormState({ id: null });
        setTitle('');
        setDescription('');
        setDates([]);
    };

    const startEdit = (group) => {
        setFormState({ id: group.id });
        setTitle(group.title || '');
        setDescription(group.description || '');
        setDates((group.dates || []).map(d => dayjs(d)).filter(d => d.isValid()));
    };

    const handleAddDate = (date) => {
        if (!date) return;
        if (isWeekendDay(date)) {
            message.warning('周末非交易日，请选择工作日');
            return;
        }
        const dateStr = date.format('YYYYMMDD');
        if (dates.some(d => d.format('YYYYMMDD') === dateStr)) {
            message.warning('该日期已添加');
            return;
        }
        setDates([...dates, date]);
    };

    const handleRemoveDate = (dateStr) => {
        setDates(dates.filter(d => d.format('YYYYMMDD') !== dateStr));
    };

    const handleSave = async () => {
        if (!title.trim()) {
            message.warning('请输入分组标题');
            return;
        }
        if (dates.length === 0) {
            message.warning('请至少选择一个日期');
            return;
        }
        setSaving(true);
        try {
            const res = await axios.post(`http://${local_ip}:3000/indexOverlayGroup/save`, {
                id: formState?.id || undefined,
                title,
                description,
                dates: dates.map(d => d.format('YYYY-MM-DD')),
            });
            if (res.data && res.data.success) {
                message.success(formState?.id ? '分组已更新' : '分组已创建');
                setFormState(null);
                setTitle('');
                setDescription('');
                setDates([]);
                fetchGroups();
            } else {
                message.error(res.data?.message || '保存失败');
            }
        } catch (e) {
            console.error('保存分组失败:', e);
            message.error('保存分组失败');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id) => {
        try {
            const res = await axios.delete(`http://${local_ip}:3000/indexOverlayGroup/delete`, { params: { id } });
            if (res.data && res.data.success) {
                message.success('分组已删除');
                fetchGroups();
            } else {
                message.error(res.data?.message || '删除失败');
            }
        } catch (e) {
            console.error('删除分组失败:', e);
            message.error('删除分组失败');
        }
    };

    const handleApply = (group) => {
        if (!group.dates || group.dates.length === 0) {
            message.warning('该分组暂无日期');
            return;
        }
        onApplyDates(group.dates);
        message.success(`已应用分组「${group.title}」到当前叠加分时`);
    };

    return (
        <Modal
            open={open}
            onCancel={handleClose}
            footer={null}
            width={640}
            title={
                <span>
                    <ApartmentOutlined style={{ color: '#1677ff', marginRight: 8 }} />
                    叠加分时分组
                </span>
            }
            zIndex={10001}
            destroyOnClose
        >
            {formState ? (
                <div className="iog-form">
                    <div className="iog-form-header">
                        <Button
                            type="text"
                            icon={<ArrowLeftOutlined />}
                            onClick={() => setFormState(null)}
                        >
                            返回列表
                        </Button>
                        <span className="iog-form-title">
                            {formState.id ? '编辑分组' : '新建分组'}
                        </span>
                    </div>

                    <div className="iog-form-item">
                        <label className="iog-label">分组标题</label>
                        <Input
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="请输入分组标题，如：强势反弹日"
                            maxLength={30}
                        />
                    </div>

                    <div className="iog-form-item">
                        <label className="iog-label">分组描述</label>
                        <TextArea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="选填，描述该分组的含义或用途"
                            rows={2}
                            maxLength={500}
                        />
                    </div>

                    <div className="iog-form-item">
                        <label className="iog-label">分组日期（可为多个）</label>
                        <div className="iog-date-row">
                            <DatePicker
                                disabledDate={disabledDate}
                                allowClear
                                placeholder="选择日期"
                                onChange={handleAddDate}
                            />
                            <span className="iog-date-hint">选择日期后自动加入下方列表</span>
                        </div>
                        {dates.length > 0 ? (
                            <div className="iog-date-tags">
                                {dates.map((d, idx) => {
                                    const dateStr = d.format('YYYYMMDD');
                                    return (
                                        <Tag
                                            key={dateStr}
                                            closable
                                            onClose={() => handleRemoveDate(dateStr)}
                                            color="blue"
                                        >
                                            {d.format('YYYY-MM-DD')}
                                        </Tag>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="iog-date-empty">尚未添加日期</div>
                        )}
                    </div>

                    <div className="iog-form-footer">
                        <Button onClick={() => setFormState(null)}>取消</Button>
                        <Button type="primary" loading={saving} onClick={handleSave}>
                            保存分组
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="iog-list">
                    <div className="iog-list-header">
                        <span className="iog-list-count">共 {groups.length} 个分组</span>
                        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={startCreate}>
                            新建分组
                        </Button>
                    </div>

                    {loading ? (
                        <div className="iog-loading">
                            <Spin />
                        </div>
                    ) : groups.length === 0 ? (
                        <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="暂无分组，点击右上角新建分组"
                        />
                    ) : (
                        <div className="iog-group-list">
                            {groups.map((g) => (
                                <div key={g.id} className="iog-group-item">
                                    <div className="iog-group-main">
                                        <div className="iog-group-title-row">
                                            <span className="iog-group-title">{g.title}</span>
                                            <Tooltip title="一键应用该分组日期到当前叠加分时">
                                                <Button
                                                    type="primary"
                                                    size="small"
                                                    icon={<CheckCircleOutlined />}
                                                    onClick={() => handleApply(g)}
                                                >
                                                    应用
                                                </Button>
                                            </Tooltip>
                                        </div>
                                        {g.description && (
                                            <div className="iog-group-desc">{g.description}</div>
                                        )}
                                        <div className="iog-group-dates">
                                            {(g.dates || []).map((d) => (
                                                <Tag key={d} color="blue">{d}</Tag>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="iog-group-actions">
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<EditOutlined />}
                                            onClick={() => startEdit(g)}
                                        />
                                        <Popconfirm
                                            title="确认删除该分组？"
                                            onConfirm={() => handleDelete(g.id)}
                                            okText="删除"
                                            cancelText="取消"
                                        >
                                            <Button
                                                type="text"
                                                size="small"
                                                danger
                                                icon={<DeleteOutlined />}
                                            />
                                        </Popconfirm>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
};

export default IndexOverlayGroupModal;