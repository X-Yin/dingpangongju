import { useState, useEffect, useRef } from 'react';
import { Card, Button, Timeline, message, Modal, Space, Upload, Image, Tabs, Input, Select } from 'antd';
import { EditOutlined, DeleteOutlined, PlusOutlined, ClockCircleOutlined, PictureOutlined, BarChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../constant';
import TimelineEventEditorModal from '../components/TimelineEventEditorModal';
import mermaid from 'mermaid';
import './index.css';

const TimelineModule = () => {
  const [timelineList, setTimelineList] = useState([]);
  const [timelineModalVisible, setTimelineModalVisible] = useState(false);
  const [editingTimelineItem, setEditingTimelineItem] = useState(null);
  const [marketRhythmData, setMarketRhythmData] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef(null);
  const [recentOperationData, setRecentOperationData] = useState(null);
  const [recentOperationPreviewImage, setRecentOperationPreviewImage] = useState(null);
  const [recentOperationUploading, setRecentOperationUploading] = useState(false);
  const recentOperationUploadRef = useRef(null);
  const [longTermRhythmProjects, setLongTermRhythmProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [currentProjectContent, setCurrentProjectContent] = useState('');
  const [longTermRhythmEditorVisible, setLongTermRhythmEditorVisible] = useState(false);
  const [createProjectModalVisible, setCreateProjectModalVisible] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [editingProject, setEditingProject] = useState(null);
  const [editingProjectTitle, setEditingProjectTitle] = useState('');
  const [editingProjectDescription, setEditingProjectDescription] = useState('');
  const mermaidRef = useRef(null);

  const fetchTimelineData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_timeline`);
      const sortedData = [...(response.data || [])].sort((a, b) =>
        new Date(a.date) - new Date(b.date)
      );
      setTimelineList(sortedData);
    } catch (error) {
      console.error('Error fetching timeline data:', error);
      message.error('获取时间线数据失败');
    }
  };

  const fetchMarketRhythmData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_market_rhythm`);
      const data = response.data;
      setMarketRhythmData(data);
      if (data) {
        setPreviewImage(data.imageUrl || null);
      }
    } catch (error) {
      console.error('Error fetching market rhythm data:', error);
      message.error('获取市场节奏推演数据失败');
    }
  };

  const fetchRecentOperationData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_recent_operation`);
      const data = response.data;
      setRecentOperationData(data);
      if (data) {
        setRecentOperationPreviewImage(data.imageUrl || null);
      }
    } catch (error) {
      console.error('Error fetching recent operation data:', error);
      message.error('获取近期操作方案数据失败');
    }
  };

  const fetchLongTermRhythmProjects = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_long_term_rhythm_projects`);
      const projects = response.data || [];
      setLongTermRhythmProjects(projects);
      if (projects.length > 0) {
        const defaultProjectId = selectedProjectId || projects[0].id;
        setSelectedProjectId(defaultProjectId);
        const project = projects.find(p => p.id === defaultProjectId);
        if (project) {
          setCurrentProjectContent(project.content);
        }
      }
    } catch (error) {
      console.error('Error fetching long term rhythm projects:', error);
      message.error('获取长期炒作节奏项目失败');
    }
  };

  const handleCreateProject = async () => {
    if (!newProjectTitle.trim()) {
      message.error('请输入项目标题');
      return;
    }
    try {
      const response = await axios.post(`http://${local_ip}:3000/create_long_term_rhythm_project`, {
        title: newProjectTitle,
        description: newProjectDescription
      });
      const newProject = response.data.data;
      message.success('项目创建成功');
      setNewProjectTitle('');
      setNewProjectDescription('');
      setCreateProjectModalVisible(false);
      await fetchLongTermRhythmProjects();
      // 自动选中新创建的项目
      setSelectedProjectId(newProject.id);
      setCurrentProjectContent(newProject.content);
    } catch (error) {
      console.error('Error creating project:', error);
      message.error('创建项目失败');
    }
  };

  const handleUpdateProject = async (id, updates) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_long_term_rhythm_project`, {
        id,
        ...updates
      });
      message.success('项目更新成功');
      await fetchLongTermRhythmProjects();
    } catch (error) {
      console.error('Error updating project:', error);
      message.error('更新项目失败');
    }
  };

  const handleDeleteProject = async (id) => {
    Modal.confirm({
      title: '确认删除',
      content: '您确定要删除这个项目吗？此操作不可撤销。',
      okText: '确认',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await axios.post(`http://${local_ip}:3000/delete_long_term_rhythm_project`, { id });
          message.success('项目删除成功');
          if (selectedProjectId === id) {
            setSelectedProjectId(null);
            setCurrentProjectContent('');
          }
          await fetchLongTermRhythmProjects();
        } catch (error) {
          console.error('Error deleting project:', error);
          message.error('删除项目失败');
        }
      }
    });
  };

  const handleSaveLongTermRhythm = () => {
    if (!editingProject) {
      return;
    }
    if (!editingProjectTitle.trim()) {
      message.error('请输入项目标题');
      return;
    }
    handleUpdateProject(editingProject.id, { 
      title: editingProjectTitle, 
      description: editingProjectDescription, 
      content: currentProjectContent 
    });
    setLongTermRhythmEditorVisible(false);
    setEditingProject(null);
    setEditingProjectTitle('');
    setEditingProjectDescription('');
  };

  const handleProjectSelect = (projectId) => {
    setSelectedProjectId(projectId);
    const project = longTermRhythmProjects.find(p => p.id === projectId);
    if (project) {
      setCurrentProjectContent(project.content);
    }
  };

  useEffect(() => {
    fetchTimelineData();
    fetchMarketRhythmData();
    fetchRecentOperationData();
    fetchLongTermRhythmProjects();
  }, []);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
      themeVariables: {
        // 任务条颜色
        taskBkg: '#8A2BE2',          // 默认任务背景色（紫）
        critBkg: '#FF0000',          // crit 任务背景色（红）
        activeTaskBkg: '#00FA9A',    // active 任务背景色（绿）
        doneTaskBkg: '#D3D3D3',      // done 任务背景色（灰）

        // 先注释掉默认的 section 背景色，让我们的自定义代码完全控制
        // sectionBkg: '#F0F8FF',       // 偶数区域背景色
        // altSectionBkg: '#FFFFE0',    // 奇数区域背景色
        // sectionBkg2: '#F5FFFA',      // 有的变体支持第三种交替色

        // 字体和边框
        taskTextLightColor: '#FFFFFF', // 任务文本颜色（深色背景上）
        taskTextDarkColor: '#000000'   // 任务文本颜色（浅色背景上）
      }
    });
  }, []);

  // 定义我们要应用的 4 种淡色系任务背景色
  const taskColors = ['#E1BEE7', '#BBDEFB', '#FFE0B2', '#F8BBD0']; // 淡紫, 淡蓝, 淡橙, 淡粉

  // 用于应用自定义样式的函数
  const applyCustomStyles = (svgElement) => {
    if (!svgElement) return;

    // 1. 解析 Mermaid 文本，获取所有任务所属的 section 索引（严格按照从上到下的顺序）
    const taskSectionList = [];
    let currentSectionIndex = -1;
    const lines = (currentProjectContent || '').split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // 检测 section 开始
      if (trimmed.toLowerCase().startsWith('section')) {
        currentSectionIndex++;
        continue;
      }
      // 检测任务行（包含冒号，不以%%开头，并且已经进入了某个 section）
      if (currentSectionIndex >= 0 && trimmed && !trimmed.startsWith('%%') && trimmed.includes(':')) {
        taskSectionList.push(currentSectionIndex);
      }
    }

    // 2. 获取所有的任务图形元素 (只选择具有 'task' class 的元素，排除 'taskText' 等文本)
    // .task 类在 Mermaid 中专门用于任务条 (包括 rect, path, polygon 等)
    const taskShapes = Array.from(svgElement.querySelectorAll('.task'));

    // 3. 按图形在图表中的垂直位置 (Y 坐标) 进行从上到下的排序
    // 这确保了图形的顺序与文本中解析出的任务顺序 100% 匹配
    taskShapes.sort((a, b) => {
      let yA = parseFloat(a.getAttribute('y'));
      if (isNaN(yA)) {
        try { yA = a.getBoundingClientRect().top; } catch(e) { yA = 0; }
      }
      
      let yB = parseFloat(b.getAttribute('y'));
      if (isNaN(yB)) {
        try { yB = b.getBoundingClientRect().top; } catch(e) { yB = 0; }
      }
      
      return yA - yB;
    });

    // 4. 按顺序一一对应分配颜色
    taskShapes.forEach((shape, index) => {
      // 排除关键任务 (crit)，确保它保持红色
      if (shape.classList.contains('crit') || shape.getAttribute('fill') === '#FF0000') {
        shape.setAttribute('fill', '#FF0000');
        shape.style.fill = '#FF0000';
        shape.classList.add('mermaid-gantt-crit');
        return;
      }

      // 如果图形数量与解析出的任务对应，分配对应的 section 颜色
      // 即使由于某种原因不匹配，也回退到最后一个已知的 section
      const sectionIndex = index < taskSectionList.length ? taskSectionList[index] : (taskSectionList[taskSectionList.length - 1] || 0);
      const color = taskColors[sectionIndex % taskColors.length];
      
      shape.setAttribute('fill', color);
      shape.style.fill = color;
    });

    // 确保 Crit 任务保持红色 (双重保险)
    const critSelectors = [
      'rect.crit',
      'rect.task.crit',
      'rect[class*="crit"]'
    ];
    
    let critTasks = [];
    for (const selector of critSelectors) {
      const found = svgElement.querySelectorAll(selector);
      if (found.length > 0) {
        critTasks = Array.from(found);
        break;
      }
    }

    critTasks.forEach(rect => {
      rect.setAttribute('fill', '#FF0000');
      rect.style.fill = '#FF0000';
      rect.classList.add('mermaid-gantt-crit');
    });
  };

  useEffect(() => {
    const renderMermaid = async () => {
      if (mermaidRef.current && currentProjectContent) {
        try {
          // 清空容器
          mermaidRef.current.innerHTML = '';

          // 使用 render 方法
          const id = 'graph_' + Date.now();
          try {
            const result = await mermaid.render(id, currentProjectContent);
            mermaidRef.current.innerHTML = result.svg;

            // 立即尝试应用样式
            const svgElement = mermaidRef.current.querySelector('svg');
            if (svgElement) {
              applyCustomStyles(svgElement);
            }

            // 使用 MutationObserver 监听 DOM 变化，确保样式始终生效
            const observer = new MutationObserver((mutations) => {
              const svg = mermaidRef.current.querySelector('svg');
              if (svg) {
                applyCustomStyles(svg);
              }
            });

            // 配置 observer 监听子节点变化
            observer.observe(mermaidRef.current, {
              childList: true,
              subtree: true
            });

          } catch (renderError) {
            console.error('Render error:', renderError);
            // 显示具体错误
            mermaidRef.current.innerHTML = `<div style="color: red; padding: 20px;">
              <p>图表渲染失败</p>
              <p style="font-size: 12px;">错误: ${renderError.message || renderError}</p>
              <p style="font-size: 12px; margin-top: 10px;">尝试检查您的甘特图语法是否正确</p>
            </div>`;
          }
        } catch (error) {
          console.error('Error:', error);
          mermaidRef.current.innerHTML = `<div style="color: red; padding: 20px;">
            <p>出错了</p>
            <pre style="background: #f5f5f5; padding: 10px; font-size: 12px;">${error}</pre>
          </div>`;
        }
      }
    };

    if (!mermaidRef.current) {
      setTimeout(() => {
        renderMermaid();
      }, 2000);
    } else {
      renderMermaid();
    }
  }, [currentProjectContent]);

  const handleAddOrUpdateTimelineEvent = async (event) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_timeline_event`, event);
      message.success('时间线事件保存成功');
      fetchTimelineData();
      handleTimelineModalClose();
    } catch (error) {
      console.error('Error saving timeline event:', error);
      message.error('保存时间线事件失败');
    }
  };

  const handleEditTimelineEvent = (item) => {
    setEditingTimelineItem(item);
    setTimelineModalVisible(true);
  };

  const handleTimelineModalClose = () => {
    setTimelineModalVisible(false);
    setEditingTimelineItem(null);
  };

  const showDeleteTimelineConfirm = (item) => {
    Modal.confirm({
      title: '确认删除',
      content: `您确定要删除"${item.title}"吗？此操作不可撤销。`,
      okText: '确认',
      okType: 'danger',
      cancelText: '取消',
      onOk() {
        handleDeleteTimelineEvent(item.id);
      },
    });
  };

  const handleDeleteTimelineEvent = async (id) => {
    try {
      await axios.post(`http://${local_ip}:3000/delete_timeline_event`, { id });
      message.success('删除成功');
      fetchTimelineData();
    } catch (error) {
      console.error('Error deleting timeline event:', error);
      message.error('删除失败');
    }
  };

  const getTimelineItemColor = (type) => {
    switch (type) {
      case 'milestone':
        return 'blue';
      case 'policy':
        return 'green';
      case 'incident':
        return 'red';
      default:
        return 'gray';
    }
  };

  const handleImageUpload = async (file) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);

      const response = await axios.post(
        `http://${local_ip}:3000/upload_market_rhythm_image`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      const imageUrl = response.data.imageUrl;
      setPreviewImage(imageUrl);

      // 自动保存
      await axios.post(`http://${local_ip}:3000/update_market_rhythm`, {
        imageUrl
      });

      message.success('图片上传成功');
      fetchMarketRhythmData();
    } catch (error) {
      console.error('上传图片失败:', error);
      message.error('上传图片失败');
    } finally {
      setUploading(false);
    }
    return false;
  };

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) {
          handleImageUpload(file);
        }
      }
    }
  };

  const handleRecentOperationImageUpload = async (file) => {
    setRecentOperationUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);

      const response = await axios.post(
        `http://${local_ip}:3000/upload_recent_operation_image`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        }
      );

      const imageUrl = response.data.imageUrl;
      setRecentOperationPreviewImage(imageUrl);

      // 自动保存
      await axios.post(`http://${local_ip}:3000/update_recent_operation`, {
        imageUrl
      });

      message.success('图片上传成功');
      fetchRecentOperationData();
    } catch (error) {
      console.error('上传图片失败:', error);
      message.error('上传图片失败');
    } finally {
      setRecentOperationUploading(false);
    }
    return false;
  };

  const handleRecentOperationPaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) {
          handleRecentOperationImageUpload(file);
        }
      }
    }
  };



  const tabItems = [
    {
      key: '1',
      label: (
        <span>
          <ClockCircleOutlined style={{ marginRight: 8 }} />
          时间线
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 16, textAlign: 'right' }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setTimelineModalVisible(true)}
            >
              新建事件
            </Button>
          </div>
          <Timeline>
            {timelineList.map(item => (
              <Timeline.Item
                key={item.id}
                color={getTimelineItemColor(item.type)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flexGrow: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '16px', marginBottom: '4px' }}>
                      {item.title}
                    </div>
                    <div style={{ color: '#8c8c8c', fontSize: '14px', marginBottom: '8px' }}>
                      {item.date}
                    </div>
                    {item.description && (
                      <div style={{ color: '#595959' }}>
                        {item.description}
                      </div>
                    )}
                  </div>
                  <Space>
                    <Button
                      type="link"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => handleEditTimelineEvent(item)}
                    >
                      编辑
                    </Button>
                    <Button
                      type="link"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={() => showDeleteTimelineConfirm(item)}
                    >
                      删除
                    </Button>
                  </Space>
                </div>
              </Timeline.Item>
            ))}
            {timelineList.length === 0 && (
              <div style={{ textAlign: 'center', color: '#8c8c8c', padding: '20px' }}>
                暂无时间线事件，点击上方"新建事件"添加
              </div>
            )}
          </Timeline>
        </div>
      ),
    },
    {
      key: '2',
      label: (
        <span>
          <PictureOutlined style={{ marginRight: 8 }} />
          市场节奏推演
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 16, textAlign: 'right' }}>
            <Button
              type="link"
              icon={<EditOutlined />}
              onClick={() => window.open('https://my.feishu.cn/wiki/HuXWwr3Vti7dlskCZFzcIhlknOf', '_blank')}
            >
              编辑
            </Button>
          </div>
          <div onPaste={handlePaste} style={{ textAlign: 'center' }}>
            {previewImage ? (
              <div style={{ position: 'relative', width: '70vw', margin: '0 auto' }}>
                <Image
                  src={previewImage}
                  style={{ width: '100%', objectFit: 'contain' }}
                />
                <Upload
                  ref={uploadRef}
                  showUploadList={false}
                  beforeUpload={handleImageUpload}
                  accept="image/*"
                >
                  <Button
                    type="default"
                    size="small"
                    style={{ position: 'absolute', top: 4, right: 4 }}
                    loading={uploading}
                  >
                    更换图片
                  </Button>
                </Upload>
              </div>
            ) : (
              <Upload
                ref={uploadRef}
                showUploadList={false}
                beforeUpload={handleImageUpload}
                accept="image/*"
              >
                <Button icon={<PictureOutlined />} loading={uploading}>
                  选择图片或粘贴上传
                </Button>
              </Upload>
            )}
          </div>

          {marketRhythmData && marketRhythmData.updatedAt && (
            <div style={{ color: '#8c8c8c', fontSize: '12px', marginTop: 16, textAlign: 'center' }}>
              最后更新：{new Date(marketRhythmData.updatedAt).toLocaleString()}
            </div>
          )}
        </div>
      ),
    },
    {
      key: '3',
      label: (
        <span>
          <PictureOutlined style={{ marginRight: 8 }} />
          近期操作方案
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 16, textAlign: 'right' }}>
            <Button
              type="link"
              icon={<EditOutlined />}
              onClick={() => window.open('https://my.feishu.cn/wiki/JuCFwv1mti7JsVk5HEIcm7VCnhe', '_blank')}
            >
              编辑
            </Button>
          </div>
          <div onPaste={handleRecentOperationPaste} style={{ textAlign: 'center' }}>
            {recentOperationPreviewImage ? (
              <div style={{ position: 'relative', width: '70vw', margin: '0 auto' }}>
                <Image
                  src={recentOperationPreviewImage}
                  style={{ width: '100%', objectFit: 'contain' }}
                />
                <Upload
                  ref={recentOperationUploadRef}
                  showUploadList={false}
                  beforeUpload={handleRecentOperationImageUpload}
                  accept="image/*"
                >
                  <Button
                    type="default"
                    size="small"
                    style={{ position: 'absolute', top: 4, right: 4 }}
                    loading={recentOperationUploading}
                  >
                    更换图片
                  </Button>
                </Upload>
              </div>
            ) : (
              <Upload
                ref={recentOperationUploadRef}
                showUploadList={false}
                beforeUpload={handleRecentOperationImageUpload}
                accept="image/*"
              >
                <Button icon={<PictureOutlined />} loading={recentOperationUploading}>
                  选择图片或粘贴上传
                </Button>
              </Upload>
            )}
          </div>

          {recentOperationData && recentOperationData.updatedAt && (
            <div style={{ color: '#8c8c8c', fontSize: '12px', marginTop: 16, textAlign: 'center' }}>
              最后更新：{new Date(recentOperationData.updatedAt).toLocaleString()}
            </div>
          )}
        </div>
      ),
    },
    {
      key: '4',
      label: (
        <span>
          <BarChartOutlined style={{ marginRight: 8 }} />
          长期炒作节奏
        </span>
      ),
      children: (
        <div>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Select
                style={{ width: 300 }}
                placeholder="选择项目"
                value={selectedProjectId}
                onChange={handleProjectSelect}
                options={longTermRhythmProjects.map(project => ({
                  label: project.title,
                  value: project.id
                }))}
              />
              {selectedProjectId && (
                <Space>
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => {
                      const project = longTermRhythmProjects.find(p => p.id === selectedProjectId);
                      setEditingProject(project);
                      setCurrentProjectContent(project.content);
                      setEditingProjectTitle(project.title);
                      setEditingProjectDescription(project.description || '');
                      setLongTermRhythmEditorVisible(true);
                    }}
                  >
                    编辑甘特图
                  </Button>
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => handleDeleteProject(selectedProjectId)}
                  >
                    删除项目
                  </Button>
                </Space>
              )}
            </div>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateProjectModalVisible(true)}
            >
              新建项目
            </Button>
          </div>

          {selectedProjectId && longTermRhythmProjects.find(p => p.id === selectedProjectId) && (
            <>
              {longTermRhythmProjects.find(p => p.id === selectedProjectId).description && (
                <div style={{ marginBottom: 16, padding: '12px 16px', background: '#f5f5f5', borderRadius: 6 }}>
                  {longTermRhythmProjects.find(p => p.id === selectedProjectId).description}
                </div>
              )}
              <div
              ref={mermaidRef}
              className="mermaid-container"
            />
              {longTermRhythmProjects.find(p => p.id === selectedProjectId).updatedAt && (
                <div style={{ color: '#8c8c8c', fontSize: '12px', marginTop: 16, textAlign: 'center' }}>
                  最后更新：{new Date(longTermRhythmProjects.find(p => p.id === selectedProjectId).updatedAt).toLocaleString()}
                </div>
              )}
            </>
          )}

          {!selectedProjectId && (
            <div style={{ textAlign: 'center', color: '#8c8c8c', padding: '40px' }}>
              请选择或新建一个项目
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <Card>
        <Tabs items={tabItems} />
      </Card>

      <TimelineEventEditorModal
        visible={timelineModalVisible}
        onCancel={handleTimelineModalClose}
        onSave={handleAddOrUpdateTimelineEvent}
        initialEvent={editingTimelineItem}
      />

      <Modal
        title="新建项目"
        open={createProjectModalVisible}
        onOk={handleCreateProject}
        onCancel={() => {
          setCreateProjectModalVisible(false);
          setNewProjectTitle('');
          setNewProjectDescription('');
        }}
        okText="创建"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <p style={{ marginBottom: 8, fontWeight: 500 }}>项目标题</p>
          <Input
            value={newProjectTitle}
            onChange={(e) => setNewProjectTitle(e.target.value)}
            placeholder="请输入项目标题"
          />
        </div>
        <div>
          <p style={{ marginBottom: 8, fontWeight: 500 }}>项目描述</p>
          <Input.TextArea
            value={newProjectDescription}
            onChange={(e) => setNewProjectDescription(e.target.value)}
            placeholder="请输入项目描述（可选）"
            rows={4}
          />
        </div>
      </Modal>

      <Modal
        title="编辑长期炒作节奏"
        open={longTermRhythmEditorVisible}
        onOk={handleSaveLongTermRhythm}
        onCancel={() => {
          setLongTermRhythmEditorVisible(false);
          setEditingProject(null);
          setEditingProjectTitle('');
          setEditingProjectDescription('');
          if (selectedProjectId) {
            const project = longTermRhythmProjects.find(p => p.id === selectedProjectId);
            if (project) {
              setCurrentProjectContent(project.content);
            }
          }
        }}
        width={800}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <p style={{ marginBottom: 8, fontWeight: 500 }}>项目标题</p>
          <Input
            value={editingProjectTitle}
            onChange={(e) => setEditingProjectTitle(e.target.value)}
            placeholder="请输入项目标题"
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <p style={{ marginBottom: 8, fontWeight: 500 }}>项目描述</p>
          <Input.TextArea
            value={editingProjectDescription}
            onChange={(e) => setEditingProjectDescription(e.target.value)}
            placeholder="请输入项目描述（可选）"
            rows={3}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: '#666', fontSize: '12px', marginBottom: 8 }}>
            使用 Mermaid 语法编辑甘特图，参考：<a href="https://mermaid.js.org/syntax/gantt.html" target="_blank" rel="noopener noreferrer">Mermaid Gantt 文档</a>
          </p>
          <p style={{ color: '#666', fontSize: '12px', marginBottom: 4 }}>
            <strong>状态/颜色说明：</strong>
          </p>
          <ul style={{ color: '#666', fontSize: '12px', paddingLeft: 20, marginTop: 0, marginBottom: 0 }}>
            <li><strong>done</strong> - 已完成</li>
            <li><strong>active</strong> - 进行中</li>
            <li><strong>crit</strong> - 关键阶段</li>
            <li><strong>milestone</strong> - 里程碑</li>
          </ul>
        </div>
        <Input.TextArea
          value={currentProjectContent}
          onChange={(e) => setCurrentProjectContent(e.target.value)}
          rows={16}
          placeholder="输入 Mermaid 甘特图语法..."
          style={{ fontFamily: 'monospace' }}
        />
      </Modal>
    </div>
  );
};

export default TimelineModule;
