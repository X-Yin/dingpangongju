import { useEffect, useRef, useState, useCallback } from 'react';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { Button, message } from 'antd';
import { SaveOutlined, UnorderedListOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import './index.scss';

const TodayPlan = ({ onModifiedChange }) => {
  const vditorRef = useRef(null);
  const vditorInstanceRef = useRef(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isModified, setIsModified] = useState(false);
  // 标记正在程序化设置内容，避免触发 input 误判为用户修改
  const settingValueRef = useRef(false);

  // 目录相关状态
  const [tocTree, setTocTree] = useState([]);
  const [activeHeadingIdx, setActiveHeadingIdx] = useState(-1);
  const headingElementsRef = useRef([]);
  const tocUpdateTimerRef = useRef(null);

  const updateModified = (modified) => {
    setIsModified(modified);
    onModifiedChange?.(modified);
  };

  // 获取 Vditor WYSIWYG 滚动容器（pre.vditor-reset 才是实际可滚动元素）
  const getWysiwygEl = useCallback(() => {
    if (!vditorRef.current) return null;
    return (
      vditorRef.current.querySelector('.vditor-wysiwyg pre.vditor-reset') ||
      vditorRef.current.querySelector('.vditor-wysiwyg') ||
      vditorRef.current.querySelector('[contenteditable="true"]') ||
      null
    );
  }, []);

  // 将扁平标题列表构建为树状结构
  const buildTocTree = useCallback((headings) => {
    const root = { children: [] };
    const stack = [root];
    headings.forEach((h, idx) => {
      const node = { ...h, flatIndex: idx, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    });
    return root.children;
  }, []);

  // 扫描 Vditor DOM 中的标题并更新目录
  const updateToc = useCallback(() => {
    const container = getWysiwygEl();
    if (!container) {
      setTocTree([]);
      headingElementsRef.current = [];
      return;
    }
    const headingEls = Array.from(
      container.querySelectorAll('h1, h2, h3, h4, h5, h6')
    );
    const flat = headingEls.map((el, idx) => ({
      level: parseInt(el.tagName[1], 10),
      text: el.textContent?.trim() || `标题 ${idx + 1}`,
      element: el,
    }));
    headingElementsRef.current = flat;
    setTocTree(buildTocTree(flat));
  }, [buildTocTree, getWysiwygEl]);

  // 防抖更新目录，避免频繁输入时性能下降
  const debouncedUpdateToc = useCallback(() => {
    if (tocUpdateTimerRef.current) clearTimeout(tocUpdateTimerRef.current);
    tocUpdateTimerRef.current = setTimeout(() => {
      updateToc();
    }, 300);
  }, [updateToc]);

  // 点击目录项，滚动到对应标题
  const scrollToHeading = useCallback(
    (flatIndex) => {
      const heading = headingElementsRef.current[flatIndex];
      if (!heading?.element) return;
      const container = getWysiwygEl();
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const elementRect = heading.element.getBoundingClientRect();
        const offset = elementRect.top - containerRect.top + container.scrollTop;
        container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      } else {
        heading.element.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      setActiveHeadingIdx(flatIndex);
    },
    [getWysiwygEl]
  );

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
      input: () => {
        // 程序化 setValue 期间不标记为已修改
        if (!settingValueRef.current) {
          updateModified(true);
        }
        debouncedUpdateToc();
      },
      after: () => {
        // 绑定滚动监听，实时更新目录高亮项
        const wysiwyg = getWysiwygEl();
        if (wysiwyg) {
          let scrollTimer = null;
          wysiwyg.addEventListener('scroll', () => {
            if (scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(() => {
              const elements = headingElementsRef.current;
              if (elements.length === 0) return;
              const containerTop = wysiwyg.getBoundingClientRect().top;
              let activeIdx = -1;
              for (let i = 0; i < elements.length; i++) {
                const rect = elements[i].element.getBoundingClientRect();
                if (rect.top - containerTop <= 5) {
                  activeIdx = i;
                } else {
                  break;
                }
              }
              setActiveHeadingIdx(activeIdx);
            }, 100);
          });
        }
        loadPlanContent();
      },
    });

    const loadPlanContent = async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/fupan/today_plan`);
        const content = res.data?.data?.content || '';
        // 后端为空时，兼容迁移一次旧的 localStorage 内容
        const migrated = content || localStorage.getItem('today_plan_content') || '';
        if (migrated && vditorInstanceRef.current) {
          settingValueRef.current = true;
          vditorInstanceRef.current.setValue(migrated);
          settingValueRef.current = false;
        }
        updateModified(false);
        updateToc();
      } catch (error) {
        console.error('加载今日计划失败:', error);
      }
    };

    return () => {
      if (tocUpdateTimerRef.current) {
        clearTimeout(tocUpdateTimerRef.current);
      }
      if (vditorInstanceRef.current) {
        vditorInstanceRef.current.destroy();
        vditorInstanceRef.current = null;
      }
    };
  }, []);

  // 保存内容到后端
  const handleSave = async () => {
    if (!vditorInstanceRef.current) return;

    try {
      setIsSaving(true);
      const content = vditorInstanceRef.current.getValue();
      await axios.post(`http://${local_ip}:3000/fupan/today_plan`, { content });
      message.success('保存成功！');
      updateModified(false);
    } catch (error) {
      message.error('保存失败：' + (error.message || '未知错误'));
    } finally {
      setIsSaving(false);
    }
  };

  // 递归渲染目录树节点
  const renderTocNode = (node, depth = 0) => {
    const isActive = node.flatIndex === activeHeadingIdx;
    return (
      <div key={node.flatIndex}>
        <div
          className={`toc-item${isActive ? ' toc-item-active' : ''}`}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => scrollToHeading(node.flatIndex)}
          title={node.text}
        >
          <span className="toc-level-mark">H{node.level}</span>
          <span className="toc-item-text">{node.text}</span>
        </div>
        {node.children.length > 0 && (
          <div>
            {node.children.map((child) => renderTocNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="today-plan-wrapper">
      {/* 左侧目录侧边栏 */}
      <div className="toc-sidebar">
        <div className="toc-header">
          <UnorderedListOutlined style={{ marginRight: 6 }} />
          目录
        </div>
        <div className="toc-tree">
          {tocTree.length === 0 ? (
            <div className="toc-empty">暂无标题</div>
          ) : (
            tocTree.map((node) => renderTocNode(node, 0))
          )}
        </div>
      </div>

      {/* 右侧内容区域 */}
      <div className="today-plan-content">
        <div className="toolbar-section">
          {isModified && <span className="modified-tag">有未保存的修改</span>}
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={isSaving}
            disabled={!isModified}
          >
            保存今日计划
          </Button>
        </div>
        <div ref={vditorRef} className="vditor-container" />
      </div>
    </div>
  );
};

export default TodayPlan;
