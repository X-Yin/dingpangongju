import React, { useEffect, useRef, useState } from 'react';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { Button, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import './index.scss';

const TodayPlan = () => {
  const vditorRef = useRef(null);
  const vditorInstanceRef = useRef(null);
  const [isSaving, setIsSaving] = useState(false);
  // 使用固定的 key 来存储计划内容，这样跨天也能保留内容
  const planKey = 'today_plan_content';

  // 初始化 Vditor
  useEffect(() => {
    if (!vditorRef.current) return;

    vditorInstanceRef.current = new Vditor(vditorRef.current, {
      height: 600,
      mode: 'wysiwyg',
      theme: 'classic',
      placeholder: '请输入今日交易计划...',
      cache: {
        enable: false,
      },
      toolbar: [
        'emoji',
        'headings',
        'bold',
        'italic',
        'strike',
        'link',
        '|',
        'list',
        'ordered-list',
        'check',
        'outdent',
        'indent',
        '|',
        'quote',
        'line',
        'code',
        'inline-code',
        '|',
        'upload',
        'record',
        'table',
        '|',
        'undo',
        'redo',
      ],
      upload: {
        accept: 'image/*',
        handler: () => {},
      },
      after: () => {
        // 加载本地存储的内容
        const savedContent = localStorage.getItem(planKey);
        if (savedContent && vditorInstanceRef.current) {
          vditorInstanceRef.current.setValue(savedContent);
        }
      },
    });

    return () => {
      if (vditorInstanceRef.current) {
        vditorInstanceRef.current.destroy();
        vditorInstanceRef.current = null;
      }
    };
  }, []);

  // 保存内容
  const handleSave = async () => {
    if (!vditorInstanceRef.current) return;
    
    try {
      setIsSaving(true);
      const content = vditorInstanceRef.current.getValue();
      localStorage.setItem(planKey, content);
      message.success('保存成功！');
    } catch (error) {
      message.error('保存失败：' + (error.message || '未知错误'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="today-plan-wrapper">
      <div className="toolbar-section">
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={handleSave}
          loading={isSaving}
        >
          保存今日计划
        </Button>
      </div>
      <div ref={vditorRef} className="vditor-container" />
    </div>
  );
};

export default TodayPlan;
