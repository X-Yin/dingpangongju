import React, { useState, useEffect } from 'react';
import { Modal, Input, Button, Select, DatePicker, message } from 'antd';
import dayjs from 'dayjs';

const { TextArea } = Input;
const { Option } = Select;

const TimelineEventEditorModal = ({
    visible,
    onCancel,
    onSave,
    initialEvent = null,
}) => {
    const [id, setId] = useState(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [date, setDate] = useState(null);
    const [type, setType] = useState('');

    useEffect(() => {
        if (visible) {
            if (initialEvent) {
                setId(initialEvent.id);
                setTitle(initialEvent.title || '');
                setDescription(initialEvent.description || '');
                setDate(initialEvent.date ? dayjs(initialEvent.date) : null);
                setType(initialEvent.type || '');
            } else {
                setId(null);
                setTitle('');
                setDescription('');
                setDate(dayjs());
                setType('');
            }
        }
    }, [visible, initialEvent]);

    const handleSave = () => {
        if (!title.trim()) {
            message.error('标题不能为空');
            return;
        }
        if (!date) {
            message.error('请选择日期');
            return;
        }
        if (!type) {
            message.error('请选择事件类型');
            return;
        }
        
        const event = {
            id: id !== null ? id : Date.now(),
            title,
            description,
            date: date.format('YYYY-MM-DD'),
            type,
        };
        onSave(event);
    };

    return (
        <Modal
            title={initialEvent ? '编辑时间线事件' : '新建时间线事件'}
            open={visible}
            onCancel={onCancel}
            footer={[
                <Button key="back" onClick={onCancel}>取消</Button>,
                <Button key="submit" type="primary" onClick={handleSave}>保存</Button>,
            ]}
            width={600}
            destroyOnClose={true}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <Input
                    placeholder="请输入事件标题"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    label="标题"
                />
                <DatePicker
                    style={{ width: '100%' }}
                    value={date}
                    onChange={(date) => setDate(date)}
                    placeholder="请选择日期"
                />
                <Select
                    style={{ width: '100%' }}
                    value={type}
                    onChange={(value) => setType(value)}
                    placeholder="请选择事件类型"
                >
                    <Option value="milestone">里程碑</Option>
                    <Option value="policy">政策</Option>
                    <Option value="incident">事件</Option>
                </Select>
                <TextArea
                    placeholder="请输入事件描述（可选）"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={4}
                />
            </div>
        </Modal>
    );
};

export default TimelineEventEditorModal;
