import React, { useState, useEffect, useRef } from 'react';
import { Layout, Menu, Button, Input, Modal, message, Space, Dropdown, Typography } from 'antd';
import { 
  FolderOutlined, 
  FileTextOutlined, 
  PlusOutlined, 
  EditOutlined, 
  DeleteOutlined, 
  MoreOutlined, 
  SaveOutlined 
} from '@ant-design/icons';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import axios from 'axios';
import { local_ip } from '../../../constant';

const { Sider, Content } = Layout;
const { Text } = Typography;

const ResearchReportModule = () => {
  const [treeData, setTreeData] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState('folder');
  const [contextMenuParentId, setContextMenuParentId] = useState(null);
  const vditorRef = useRef(null);
  const editorInstance = useRef(null);
  const [currentContent, setCurrentContent] = useState('');
  const [isModified, setIsModified] = useState(false);
  const [currentItem, setCurrentItem] = useState(null);

  const fetchReports = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      setTreeData(response.data);
    } catch (error) {
      console.error('获取研报列表失败', error);
      message.error('获取研报列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const buildMenuItems = (items, parentId = null) => {
    return items.map(item => {
      // 构建菜单项
      const menuOptions = [];
      
      // 如果是文件夹，添加新增子项选项
      if (item.type === 'folder') {
        menuOptions.push(
          {
            key: 'add-folder',
            icon: <FolderOutlined />,
            label: '新增子文件夹',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handleCreateInFolder(item.id, 'folder');
            }
          },
          {
            key: 'add-report',
            icon: <FileTextOutlined />,
            label: '新增子研报',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handleCreateInFolder(item.id, 'report');
            }
          },
          { type: 'divider' }
        );
      }
      
      // 添加通用的重命名和删除选项
      menuOptions.push(
        {
          key: 'rename',
          icon: <EditOutlined />,
          label: '重命名',
          onClick: (e) => {
            e.domEvent.stopPropagation();
            handleRename(item);
          }
        },
        {
          key: 'delete',
          icon: <DeleteOutlined />,
          label: '删除',
          danger: true,
          onClick: (e) => {
            e.domEvent.stopPropagation();
            handleDelete(item);
          }
        }
      );
      
      const menuItem = {
        key: item.id,
        label: (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <Space>
              {item.type === 'folder' ? <FolderOutlined /> : <FileTextOutlined />}
              <span>{item.name}</span>
            </Space>
            <Dropdown 
              menu={{ items: menuOptions }}
              trigger={['click']}
            >
              <Button type="text" size="small" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} />
            </Dropdown>
          </div>
        ),
      };

      if (item.type === 'folder' && item.children && item.children.length > 0) {
        menuItem.children = buildMenuItems(item.children, item.id);
      }

      return menuItem;
    });
  };

  const handleCreateInFolder = (folderId, type) => {
    setNewItemType(type);
    setNewItemName('');
    setContextMenuParentId(folderId);
    setCreateModalVisible(true);
  };

  const handleMenuSelect = async ({ key }) => {
    setSelectedKey(key);
    const item = findItemById(treeData, key);
    setCurrentItem(item);
    
    if (item && item.type === 'report') {
      setCurrentContent(item.content || '');
      setIsModified(false);
      
      if (editorInstance.current) {
        editorInstance.current.setValue(item.content || '');
      }
    } else {
      setCurrentContent('');
      setIsModified(false);
    }
  };

  const findItemById = (items, id) => {
    for (const item of items) {
      if (item.id === id) {
        return item;
      }
      if (item.children) {
        const found = findItemById(item.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  const handleCreate = (type) => {
    setNewItemType(type);
    setNewItemName('');
    setContextMenuParentId(selectedKey && findItemById(treeData, selectedKey)?.type === 'folder' ? selectedKey : null);
    setCreateModalVisible(true);
  };

  const confirmCreate = async () => {
    if (!newItemName.trim()) {
      message.error('请输入名称');
      return;
    }
    
    try {
      await axios.post(`http://${local_ip}:3000/create_research_report`, {
        parentId: contextMenuParentId,
        name: newItemName,
        type: newItemType,
        content: ''
      });
      message.success('创建成功');
      setCreateModalVisible(false);
      await refreshAndKeepSelection();
    } catch (error) {
      console.error('创建失败', error);
      message.error('创建失败');
    }
  };

  const handleRename = (item) => {
    setNewItemName(item.name);
    setSelectedKey(item.id);
    setRenameModalVisible(true);
  };

  const confirmRename = async () => {
    if (!newItemName.trim()) {
      message.error('请输入名称');
      return;
    }
    
    try {
      await axios.post(`http://${local_ip}:3000/update_research_report`, {
        id: selectedKey,
        name: newItemName
      });
      message.success('重命名成功');
      setRenameModalVisible(false);
      await refreshAndKeepSelection();
    } catch (error) {
      console.error('重命名失败', error);
      message.error('重命名失败');
    }
  };

  const handleDelete = (item) => {
    Modal.confirm({
      title: '确认删除',
      content: item.type === 'folder' 
        ? `确定要删除文件夹"${item.name}"吗？这将删除文件夹内的所有内容。`
        : `确定要删除研报"${item.name}"吗？`,
      okText: '确认',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await axios.post(`http://${local_ip}:3000/delete_research_report`, {
            id: item.id
          });
          message.success('删除成功');
          if (selectedKey === item.id) {
            setSelectedKey(null);
            setCurrentItem(null);
            setCurrentContent('');
          }
          fetchReports();
        } catch (error) {
          console.error('删除失败', error);
          message.error('删除失败');
        }
      }
    });
  };

  const refreshAndKeepSelection = async () => {
    const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
    setTreeData(response.data);
    
    if (selectedKey) {
      const updatedItem = findItemById(response.data, selectedKey);
      setCurrentItem(updatedItem);
      if (updatedItem?.type === 'report') {
        setCurrentContent(updatedItem.content || '');
      }
    }
  };

  const handleSave = async () => {
    if (!selectedKey || !currentItem || currentItem.type !== 'report') {
      message.warning('请先选择一个研报');
      return;
    }

    try {
      await axios.post(`http://${local_ip}:3000/update_research_report`, {
        id: selectedKey,
        content: currentContent,
        name: currentItem.name
      });
      message.success('保存成功');
      setIsModified(false);
      await refreshAndKeepSelection();
    } catch (error) {
      console.error('保存失败', error);
      message.error('保存失败');
    }
  };

  useEffect(() => {
    if (!currentItem || currentItem.type !== 'report') {
      return;
    }

    const initEditor = () => {
      if (!vditorRef.current || editorInstance.current) return;
      
      setTimeout(() => {
        if (!vditorRef.current) return;
        
        try {
          editorInstance.current = new Vditor(vditorRef.current, {
            minHeight: 500,
            type: 'markdown',
            value: currentContent,
            cache: { id: 'research-report-vditor-cache' },
            input: (value) => {
              setCurrentContent(value);
              setIsModified(true);
            }
          });
        } catch (error) {
          console.error('初始化编辑器失败:', error);
        }
      }, 100);
    };

    initEditor();

    return () => {
      if (editorInstance.current) {
        try {
          editorInstance.current.destroy();
        } catch (error) {
          console.warn('销毁编辑器时出错:', error);
        }
        editorInstance.current = null;
      }
    };
  }, [currentItem?.type === 'report']);

  useEffect(() => {
    if (editorInstance.current && currentItem?.type === 'report') {
      setTimeout(() => {
        if (editorInstance.current) {
          try {
            editorInstance.current.setValue(currentContent || '');
          } catch (error) {
            console.warn('设置编辑器内容时出错:', error);
          }
        }
      }, 50);
    }
  }, [selectedKey]);

  return (
    <Layout style={{ height: 'calc(100vh - 180px)', background: '#fff' }}>
      <Sider width={300} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #f0f0f0' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space style={{ width: '100%' }}>
              <Button 
                type="primary" 
                icon={<PlusOutlined />} 
                onClick={() => handleCreate('folder')}
                style={{ flex: 1 }}
              >
                新建文件夹
              </Button>
              <Button 
                icon={<PlusOutlined />} 
                onClick={() => handleCreate('report')}
                style={{ flex: 1 }}
              >
                新建研报
              </Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              在根目录创建，或点击文件夹右侧的 ··· 在其中创建
            </Text>
          </Space>
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={buildMenuItems(treeData)}
          onSelect={handleMenuSelect}
          style={{ height: '100%', borderRight: 0 }}
        />
      </Sider>
      <Content style={{ padding: 16, overflow: 'auto' }}>
        {currentItem?.type === 'report' ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <Text strong style={{ fontSize: 18 }}>{currentItem.name}</Text>
                {isModified && <Text type="warning" style={{ marginLeft: 8 }}>(有未保存的修改)</Text>}
              </div>
              <Button 
                type="primary" 
                icon={<SaveOutlined />} 
                onClick={handleSave}
                disabled={!isModified}
              >
                保存
              </Button>
            </div>
            <div 
              ref={vditorRef} 
              className="vditor-container" 
              style={{ 
                minHeight: 500, 
                border: '1px solid #f0f0f0',
                borderRadius: 4
              }} 
            />
          </>
        ) : currentItem?.type === 'folder' ? (
          <div style={{ textAlign: 'center', padding: 50 }}>
            <FolderOutlined style={{ fontSize: 48, color: '#1890ff' }} />
            <div style={{ marginTop: 16, color: '#666' }}>
              文件夹: {currentItem.name}
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 50 }}>
            <FileTextOutlined style={{ fontSize: 48, color: '#999' }} />
            <div style={{ marginTop: 16, color: '#999' }}>
              请从左侧选择一个研报或文件夹
            </div>
          </div>
        )}
      </Content>

      <Modal
        title={(() => {
          const locationText = contextMenuParentId ? '在文件夹中' : '在根目录';
          return `${locationText}新建${newItemType === 'folder' ? '文件夹' : '研报'}`;
        })()}
        open={createModalVisible}
        onOk={confirmCreate}
        onCancel={() => setCreateModalVisible(false)}
      >
        <Input
          placeholder="请输入名称"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onPressEnter={confirmCreate}
        />
      </Modal>

      <Modal
        title="重命名"
        open={renameModalVisible}
        onOk={confirmRename}
        onCancel={() => setRenameModalVisible(false)}
      >
        <Input
          placeholder="请输入新名称"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onPressEnter={confirmRename}
        />
      </Modal>
    </Layout>
  );
};

export default ResearchReportModule;
