import React, { useState, useEffect, useRef } from 'react';
import { Modal, Input, Button, message } from 'antd';
import Vditor from 'vditor';
import 'vditor/dist/index.css';

const MainProblemEditorModal = ({
    visible,
    onCancel,
    onSave,
    initialTitle = '',
    initialContent = '请输入内容',
    editingId = null,
}) => {
    const [title, setTitle] = useState(initialTitle);
    const [content, setContent] = useState(initialContent);
    const vditorRef = useRef(null);
    const editorInstance = useRef(null);

    useEffect(() => {
        if (!visible) {
            // Destroy Vditor instance when modal is closed
            if (editorInstance.current) {
                editorInstance.current.destroy();
                editorInstance.current = null;
            }
            return;
        }

        // Modal is visible, initialize or update Vditor
        if (!vditorRef.current) return; // Ensure ref is available

        setTitle(initialTitle);
        setContent(initialContent);

        if (!editorInstance.current) {
            editorInstance.current = new Vditor(vditorRef.current, {
                minHeight: 300,
                type: 'markdown',
                value: initialContent,
                cache: { id: 'main-problem-vditor-cache' },
                input: (value) => {
                    setContent(value);
                },
                after: () => {
                    if (editorInstance.current) {
                        editorInstance.current.setValue(initialContent);
                    }
                }
            });
        } else {
            editorInstance.current.setValue(initialContent);
        }

        return () => {
            // Cleanup when component unmounts or `visible` changes to false
            if (editorInstance.current) {
                editorInstance.current.destroy();
                editorInstance.current = null;
            }
        };
    }, [visible, initialContent, initialTitle]);

    const handleSave = () => {
        if (!title.trim()) {
            message.error('标题不能为空');
            return;
        }
        onSave(editingId, title, content);
        // onCancel(); // Close modal after saving, handled by parent
    };

    return (
        <Modal
            title="编辑消息面"
            open={visible}
            onCancel={onCancel}
            footer={[
                <Button key="back" onClick={onCancel}>取消</Button>,
                <Button key="submit" type="primary" onClick={handleSave}>完成</Button>,
            ]}
            width={800}
            destroyOnClose={true} // Destroy children when close to re-initialize Vditor
        >
            <Input
                placeholder="请输入标题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{ marginBottom: 16 }}
            />
            <div ref={vditorRef} className="vditor-container" />
        </Modal>
    );
};

export default MainProblemEditorModal;