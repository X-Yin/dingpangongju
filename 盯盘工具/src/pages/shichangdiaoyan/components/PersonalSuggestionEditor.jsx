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
    console.log('initialContent', initialContent);

    // Effect for initializing Vditor on mount and cleaning up on unmount
    useEffect(() => {
        setTimeout(() => {
            // if (!vditorRef.current || editorInstance.current) {
            //     return; // Don't re-initialize if already done or ref not available
            // }

            const currentVditor = new Vditor(vditorRef.current, {
                minHeight: 200,
                type: 'markdown',
                value: initialContent,
                cache: { id: cacheId },
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
                    setIsContentModified(value !== initialContent);
                },
                after: () => {
                    if (editorInstance.current && editorInstance.current.getValue() !== initialContent) {
                        editorInstance.current.setValue(initialContent);
                    }
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
    }, [cacheId, initialContent]); // Depend on cacheId to ensure re-initialization if cacheId changes (acting as a key)

    // Effect to update Vditor content when initialContent prop changes from parent
    useEffect(() => {
        if (!editorInstance.current) return; // Ensure Vditor is initialized

        const currentEditorValue = editorInstance.current.getValue();

        // If initialContent changes and it's different from current editor content,
        // and the user hasn't modified it locally, update the editor.
        if (initialContent !== currentEditorValue && !isContentModified) {
            editorInstance.current.setValue(initialContent);
        }

        // Reset modified status if initialContent matches current editor content
        if (initialContent === currentEditorValue && isContentModified) {
            setIsContentModified(false);
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