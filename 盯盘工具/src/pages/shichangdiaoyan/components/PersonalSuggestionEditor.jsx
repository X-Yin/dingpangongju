import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, message, Tag, Space } from 'antd';
import Vditor from 'vditor';
import 'vditor/dist/index.css';

const PersonalSuggestionEditor = ({
    title,
    initialContent,
    onSave,
    cacheId
}) => {
    const vditorRef = useRef(null);
    const editorInstance = useRef(null);
    const [isContentModified, setIsContentModified] = useState(false);
    // 用 ref 保存最新的 initialContent，避免回调闭包捕获到旧值
    const initialContentRef = useRef(initialContent);
    useEffect(() => {
        initialContentRef.current = initialContent;
    }, [initialContent]);

    // Effect for initializing Vditor on mount and cleaning up on unmount
    useEffect(() => {
        setTimeout(() => {
            const currentVditor = new Vditor(vditorRef.current, {
                minHeight: 200,
                type: 'markdown',
                cache: { enable: false },
                toolbar: [
                    'emoji',
                    'headings',
                    'bold',
                    'italic',
                    'strike',
                    'line',
                    'quote',
                    'list',
                    'ordered-list',
                    'check',
                    'outdent',
                    'indent',
                    'code',
                    'inline-code',
                    'link',
                    'table',
                    'color',
                    'highlight',
                    'undo',
                    'redo',
                    'fullscreen',
                    'info',
                    'help'
                ],
                input: (value) => {
                    setIsContentModified(value !== initialContentRef.current);
                },
                after: () => {
                    // 在编辑器初始化完成后设置内容（从 ref 读取最新值）
                    currentVditor.setValue(initialContentRef.current || '');
                }
            });
            editorInstance.current = currentVditor;
        }, 500);

        // Cleanup function: destroy Vditor instance when component unmounts
        return () => {
            if (editorInstance.current) {
                editorInstance.current.destroy();
                editorInstance.current = null;
            }
        };
    }, []); // 仅在挂载时初始化一次

    // Effect to update Vditor content when initialContent prop changes from parent
    useEffect(() => {
        if (!editorInstance.current) return;

        try {
            const currentEditorValue = editorInstance.current.getValue();

            if (initialContent !== currentEditorValue && !isContentModified) {
                editorInstance.current.setValue(initialContent || '');
            }

            if (initialContent === currentEditorValue && isContentModified) {
                setIsContentModified(false);
            }
        } catch (error) {
            console.warn("Vditor getValue error in useEffect:", error);
            if (!isContentModified) {
                editorInstance.current.setValue(initialContent || '');
            }
        }
    }, [initialContent, isContentModified]);

    const handleSave = () => {
        if (editorInstance.current) {
            const currentContent = editorInstance.current.getValue();
            onSave(currentContent);
            setIsContentModified(false); // Reset modified status after saving
            message.success(`${title}已保存`);
        }
    };

    return (
        <Card
            title={title}
            extra={
                <Space>
                    {isContentModified && <Tag color="warning">有未保存内容</Tag>}
                    {!isContentModified && <Tag color="success">内容已最新</Tag>}
                    <Button type="primary" size="small" onClick={handleSave}>完成</Button>
                </Space>
            }
            style={{ marginBottom: 16 }}
        >
            <div ref={vditorRef} className="vditor-container" style={{ minHeight: 200 }} />
        </Card>
    );
};

export default PersonalSuggestionEditor;