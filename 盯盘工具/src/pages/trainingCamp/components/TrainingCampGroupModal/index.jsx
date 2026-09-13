import { useState } from 'react';
import { Modal, Button, Input, DatePicker, Tag, Empty, Popconfirm, message, Tooltip } from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, FolderOutlined, ArrowLeftOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../../constant';
import './index.scss';

const { TextArea } = Input;

const formatDateDisplay = (d) => {
  if (!d || d.length !== 8) return d;
  return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
};

const TrainingCampGroupModal = ({
  open,
  onClose,
  dates = [],        // 可回放日期（YYYYMMDD）
  groups = [],
  onGroupsChange,
  onApplyGroup,
}) => {
  const [saving, setSaving] = useState(false);
  // 表单视图：null 表示分组列表，对象表示正在编辑（{ id }）
  const [formState, setFormState] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [groupDates, setGroupDates] = useState([]); // YYYYMMDD

  const availableSet = new Set(dates);

  const handleClose = () => {
    setFormState(null);
    setTitle('');
    setDescription('');
    setGroupDates([]);
    onClose();
  };

  const startCreate = () => {
    setFormState({ id: null });
    setTitle('');
    setDescription('');
    setGroupDates([]);
  };

  const startEdit = (group) => {
    setFormState({ id: group.id });
    setTitle(group.name || '');
    setDescription(group.description || '');
    setGroupDates([...(group.dates || [])]);
  };

  // 日期选择后自动加入列表（仅允许可回放日期）
  const handleAddDate = (date) => {
    if (!date) return;
    const dateStr = date.format('YYYYMMDD');
    if (!availableSet.has(dateStr)) {
      message.warning('该日期无可回放数据，请选择可回放日期');
      return;
    }
    if (groupDates.some(d => d === dateStr)) {
      message.warning('该日期已添加');
      return;
    }
    setGroupDates([...groupDates, dateStr]);
  };

  const handleRemoveDate = (dateStr) => {
    setGroupDates(groupDates.filter(d => d !== dateStr));
  };

  const disabledDate = (current) => {
    if (!current) return false;
    return !availableSet.has(current.format('YYYYMMDD'));
  };

  const handleSave = async () => {
    if (!title.trim()) {
      message.warning('请输入分组标题');
      return;
    }
    if (groupDates.length === 0) {
      message.warning('请至少选择一个日期');
      return;
    }
    setSaving(true);
    try {
      const res = await axios.post(`http://${local_ip}:3000/training_camp/groups`, {
        id: formState?.id || undefined,
        name: title.trim(),
        description,
        dates: [...groupDates],
      });
      if (res.data && res.data.id) {
        const saved = res.data;
        onGroupsChange(
          formState?.id
            ? groups.map(g => (g.id === saved.id ? saved : g))
            : [...groups, saved]
        );
        message.success(formState?.id ? '分组已更新' : '分组已创建');
        setFormState(null);
        setTitle('');
        setDescription('');
        setGroupDates([]);
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
      await axios.delete(`http://${local_ip}:3000/training_camp/groups/${id}`);
      onGroupsChange(groups.filter(g => g.id !== id));
      message.success('分组已删除');
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
    onApplyGroup(group);
  };

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      footer={null}
      width={640}
      title={
        <span>
          <FolderOutlined style={{ color: '#7c3aed', marginRight: 8 }} />
          训练营日期分组
        </span>
      }
      zIndex={10001}
      destroyOnClose
    >
      {formState ? (
        <div className="tcgm-form">
          <div className="tcgm-form-header">
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={() => setFormState(null)}
            >
              返回列表
            </Button>
            <span className="tcgm-form-title">
              {formState.id ? '编辑分组' : '新建分组'}
            </span>
          </div>

          <div className="tcgm-form-item">
            <label className="tcgm-label">分组标题</label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="请输入分组标题，如：放量反弹日"
              maxLength={30}
            />
          </div>

          <div className="tcgm-form-item">
            <label className="tcgm-label">分组描述</label>
            <TextArea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="选填，描述该分组的含义或用途"
              rows={2}
              maxLength={500}
            />
          </div>

          <div className="tcgm-form-item">
            <label className="tcgm-label">分组日期（可为多个）</label>
            <div className="tcgm-date-row">
              <DatePicker
                disabledDate={disabledDate}
                allowClear
                placeholder="选择日期"
                onChange={handleAddDate}
              />
              <span className="tcgm-date-hint">选择日期后自动加入下方列表</span>
            </div>
            {groupDates.length > 0 ? (
              <div className="tcgm-date-tags">
                {groupDates.map(d => (
                  <Tag
                    key={d}
                    closable
                    onClose={() => handleRemoveDate(d)}
                    color="blue"
                  >
                    {formatDateDisplay(d)}
                  </Tag>
                ))}
              </div>
            ) : (
              <div className="tcgm-date-empty">尚未添加日期</div>
            )}
          </div>

          <div className="tcgm-form-footer">
            <Button onClick={() => setFormState(null)}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              保存分组
            </Button>
          </div>
        </div>
      ) : (
        <div className="tcgm-list">
          <div className="tcgm-list-header">
            <span className="tcgm-list-count">共 {groups.length} 个分组</span>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={startCreate}>
              新建分组
            </Button>
          </div>

          {groups.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无分组，点击右上角新建分组"
            />
          ) : (
            <div className="tcgm-group-list">
              {groups.map(g => (
                <div key={g.id} className="tcgm-group-item">
                  <div className="tcgm-group-main">
                    <div className="tcgm-group-title-row">
                      <span className="tcgm-group-title">{g.name}</span>
                      <Tooltip title="一键应用该分组日期到当前回放">
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
                      <div className="tcgm-group-desc">{g.description}</div>
                    )}
                    <div className="tcgm-group-dates">
                      {(g.dates || []).map(d => (
                        <Tag key={d} color="blue">{formatDateDisplay(d)}</Tag>
                      ))}
                    </div>
                  </div>
                  <div className="tcgm-group-actions">
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

export default TrainingCampGroupModal;
