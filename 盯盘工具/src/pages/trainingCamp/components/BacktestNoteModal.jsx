import { useEffect, useRef, useState } from 'react';
import { Modal, Button, message, Tag, Spin } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import axios from 'axios';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { VDITOR_CDN } from '../../../utils/vditorConfig';
import { local_ip } from '../../../constant';

// 回测随笔弹窗：每个策略独立一篇富文本（Markdown）笔记，
// 打开时从后端读取上次内容回显，点「保存」写回后端（data/backtest_notes.json）
const BacktestNoteModal = ({ open, strategyId, strategyLabel, onClose }) => {
  const vditorRef = useRef(null);
  const editorRef = useRef(null);
  const [loading, setLoading] = useState(false); // 拉取上次随笔 + 初始化编辑器中
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    if (!open || !strategyId) return undefined;
    let cancelled = false;
    // 延迟到弹窗动画完成、容器完成布局后再初始化 Vditor（与项目内其它 Vditor 弹窗一致）
    const timer = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      setUpdatedAt(null);
      axios.get(`http://${local_ip}:3000/training_camp/backtest/note`, { params: { strategyId } })
        .then(r => {
          if (cancelled) return null;
          setUpdatedAt(r.data?.updatedAt || null);
          return r.data?.content || '';
        })
        .then(content => {
          if (cancelled || content == null) return;
          // 销毁旧实例（切换策略时不残留上一个策略的编辑器）
          if (editorRef.current) {
            editorRef.current.destroy();
            editorRef.current = null;
          }
          editorRef.current = new Vditor(vditorRef.current, {
            cdn: VDITOR_CDN,
            minHeight: 440,
            value: content,
            cache: { enable: false }, // 内容以后端为准，不启用浏览器本地草稿缓存
            toolbar: [
              'headings', 'bold', 'italic', 'strike', 'line', 'quote',
              'list', 'ordered-list', 'check', 'outdent', 'indent',
              'code', 'inline-code', 'link', 'table',
              'color', 'highlight', 'undo', 'redo', 'fullscreen',
            ],
            after: () => { if (!cancelled) setLoading(false); },
          });
        })
        .catch(() => {
          if (!cancelled) {
            message.error('获取回测随笔失败');
            setLoading(false);
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (editorRef.current) {
        try { editorRef.current.destroy(); } catch { /* 弹窗卸载后元素已移除，忽略 */ }
        editorRef.current = null;
      }
    };
  }, [open, strategyId]);

  const handleSave = () => {
    if (!editorRef.current) return;
    const content = editorRef.current.getValue();
    setSaving(true);
    axios.post(`http://${local_ip}:3000/training_camp/backtest/note`, { strategyId, content })
      .then(r => {
        setUpdatedAt(r.data?.updatedAt || new Date().toISOString());
        message.success('回测随笔已保存');
        onClose?.();
      })
      .catch(() => message.error('保存回测随笔失败'))
      .finally(() => setSaving(false));
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <EditOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>回测随笔</span>
          <Tag color="blue" style={{ marginLeft: 4 }}>{strategyLabel || strategyId}</Tag>
          {updatedAt && (
            <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 400 }}>
              上次保存：{new Date(updatedAt).toLocaleString('zh-CN')}
            </span>
          )}
        </div>
      }
      open={open}
      onCancel={onClose}
      width={860}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" loading={saving} disabled={loading} onClick={handleSave}>保存</Button>,
      ]}
    >
      <Spin spinning={loading} tip="正在加载上次随笔……">
        <div ref={vditorRef} style={{ minHeight: 440 }} />
      </Spin>
    </Modal>
  );
};

export default BacktestNoteModal;
