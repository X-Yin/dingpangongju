import React, { useState, useEffect, useRef } from 'react';
import { Layout, Menu, Button, Input, Modal, message, Space, Dropdown, Typography, Tooltip } from 'antd';
import { 
  FolderOutlined, 
  FileTextOutlined, 
  PlusOutlined, 
  EditOutlined, 
  DeleteOutlined, 
  MoreOutlined, 
  SaveOutlined,
  SearchOutlined,
  StarOutlined,
  PushpinOutlined
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
  const [searchKeyword, setSearchKeyword] = useState('');
  const [openKeys, setOpenKeys] = useState([]);
  const [filterImportant, setFilterImportant] = useState(false);
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
  // 用于保存刷新前的 openKeys 状态
  const previousOpenKeysRef = useRef([]);
  // 用于标记是否正在进行数据刷新操作，避免菜单自动收起
  const isRefreshingRef = useRef(false);

  const fetchReports = async (keepOpenKeys = true) => {
    try {
      // 如果需要保持 openKeys，先保存下来
      const savedOpenKeys = keepOpenKeys ? [...openKeys] : [];
      
      setLoading(true);
      const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      setTreeData(response.data);
      
      // 恢复之前的展开状态
      if (keepOpenKeys && savedOpenKeys.length > 0) {
        setTimeout(() => {
          setOpenKeys(savedOpenKeys);
        }, 0);
      }
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

  useEffect(() => {
    const searchKeys = getOpenKeysFromTree(treeData, searchKeyword, filterImportant);
    const parentKeys = selectedKey ? getParentKeys(treeData, selectedKey) : [];
    const mergedKeys = [...new Set([...searchKeys, ...parentKeys])];
    setOpenKeys(mergedKeys);
  }, [searchKeyword, treeData, selectedKey, filterImportant]);

  const filterTreeData = (items, keyword, onlyImportant = false) => {
    const filterItems = (items) => {
      return items.filter(item => {
        let match = true;
        
        if (keyword.trim()) {
          const lowerKeyword = keyword.toLowerCase();
          match = item.name.toLowerCase().includes(lowerKeyword);
        }
        
        if (onlyImportant) {
          match = match && (item.type === 'folder' || item.isImportant);
        }
        
        if (item.type === 'folder' && item.children && item.children.length > 0) {
          const filteredChildren = filterItems(item.children);
          if (filteredChildren.length > 0) {
            return true;
          }
        }
        
        return match;
      }).map(item => {
        if (item.type === 'folder' && item.children && item.children.length > 0) {
          return {
            ...item,
            children: filterItems(item.children)
          };
        }
        return item;
      });
    };
    
    return filterItems(items);
  };

  const getOpenKeysFromTree = (items, keyword, onlyImportant = false) => {
    if (!keyword.trim() && !onlyImportant) return [];
    
    const lowerKeyword = keyword.toLowerCase();
    const newOpenKeys = [];
    
    const collectOpenKeys = (items) => {
      items.forEach(item => {
        if (item.type === 'folder' && item.children && item.children.length > 0) {
          const filteredChildren = filterTreeData(item.children, keyword, onlyImportant);
          if (filteredChildren.length > 0) {
            newOpenKeys.push(item.id);
            collectOpenKeys(item.children);
          }
        }
      });
    };
    
    collectOpenKeys(items);
    return newOpenKeys;
  };

  const handleToggleImportant = async (item) => {
    // 保存当前的 openKeys
    const savedOpenKeys = [...openKeys];
    
    try {
      // 标记正在刷新
      isRefreshingRef.current = true;
      
      await axios.post(`http://${local_ip}:3000/toggle_research_report_important`, {
        id: item.id
      });
      message.success(item.isImportant ? '已取消重点标记' : '已标记为重点');
      
      const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      setTreeData(response.data);
      
      // 使用 setTimeout 确保 state 更新后再处理
      setTimeout(() => {
        // 恢复之前的展开状态
        setOpenKeys(savedOpenKeys);
        
        // 延迟后解除刷新标记
        setTimeout(() => {
          isRefreshingRef.current = false;
        }, 100);
      }, 0);
    } catch (error) {
      console.error('标记重点失败:', error);
      message.error('标记重点失败');
      isRefreshingRef.current = false;
    }
  };

  const handlePinReport = async (item) => {
    // 保存当前的 openKeys
    const savedOpenKeys = [...openKeys];
    
    try {
      // 标记正在刷新
      isRefreshingRef.current = true;
      
      await axios.post(`http://${local_ip}:3000/pin_research_report`, {
        id: item.id
      });
      message.success('置顶成功');
      
      const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      setTreeData(response.data);
      
      // 使用 setTimeout 确保 state 更新后再处理
      setTimeout(() => {
        // 恢复之前的展开状态
        setOpenKeys(savedOpenKeys);
        
        // 延迟后解除刷新标记
        setTimeout(() => {
          isRefreshingRef.current = false;
        }, 100);
      }, 0);
    } catch (error) {
      console.error('置顶失败:', error);
      message.error('置顶失败');
      isRefreshingRef.current = false;
    }
  };

  const getParentKeys = (items, targetId) => {
    const parentKeys = [];
    
    const findParent = (items, targetId, currentParents = []) => {
      for (const item of items) {
        if (item.id === targetId) {
          return currentParents;
        }
        if (item.children && item.children.length > 0) {
          const result = findParent(item.children, targetId, [...currentParents, item.id]);
          if (result) {
            return result;
          }
        }
      }
      return null;
    };
    
    return findParent(items, targetId) || [];
  };

  const buildMenuItems = (items, parentId = null) => {
    return items.map(item => {
      // 构建菜单项
      const menuOptions = [];
      
      // 如果是研报，添加标记重点和置顶选项
      if (item.type === 'report') {
        menuOptions.push(
          {
            key: 'pin',
            icon: <PushpinOutlined />,
            label: '置顶',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handlePinReport(item);
            }
          },
          {
            key: 'toggle-important',
            icon: <StarOutlined />,
            label: item.isImportant ? '取消重点' : '标记重点',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handleToggleImportant(item);
            }
          },
          { type: 'divider' }
        );
      }
      
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
          <Dropdown
            menu={{ items: menuOptions }}
            trigger={['contextMenu']}
            align={{ offset: [10, 10] }}
            dropdownStyle={{
              maxHeight: '300px',
              overflowY: 'auto'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <Space style={{ flex: 1, minWidth: 0 }}>
                {item.type === 'folder' ? <FolderOutlined /> : (item.isImportant ? <StarOutlined style={{ color: '#faad14' }} /> : <FileTextOutlined />)}
                <Tooltip title={item.name} placement="left">
                  <span 
                    style={{ 
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                      maxWidth: '160px',
                      verticalAlign: 'middle',
                      lineHeight: '1',
                      color: item.isImportant ? '#faad14' : 'inherit',
                      fontWeight: item.isImportant ? 'bold' : 'normal'
                    }}
                  >
                    {item.name}
                  </span>
                </Tooltip>
              </Space>
              <Dropdown 
                menu={{ items: menuOptions }}
                trigger={['click']}
                dropdownStyle={{
                  maxHeight: '300px',
                  overflowY: 'auto'
                }}
              >
                <Button type="text" size="small" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} />
              </Dropdown>
            </div>
          </Dropdown>
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
    // 保存当前的 openKeys，防止后续操作影响展开状态
    previousOpenKeysRef.current = [...openKeys];
    
    // 直接从当前的 treeData 获取 item，不使用 setTimeout
    const item = findItemById(treeData, key);
    
    if (item && item.type === 'report') {
      // 研报需要单独获取完整内容
      try {
        const response = await axios.get(`http://${local_ip}:3000/get_research_report`, {
          params: { id: key }
        });
        const fullReport = response.data;
        setCurrentItem(fullReport);
        setCurrentContent(fullReport.content || '');
        setIsModified(false);
        
        if (editorInstance.current) {
          editorInstance.current.setValue(fullReport.content || '');
        }
      } catch (error) {
        console.error('获取研报内容失败', error);
        message.error('获取研报内容失败');
      }
    } else {
      setCurrentItem(item);
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
    
    // 保存当前的 openKeys 和 contextMenuParentId
    const savedOpenKeys = [...openKeys];
    const parentIdToKeep = contextMenuParentId;
    
    try {
      // 标记正在刷新，防止菜单自动收起
      isRefreshingRef.current = true;
      
      const response = await axios.post(`http://${local_ip}:3000/create_research_report`, {
        parentId: parentIdToKeep,
        name: newItemName,
        type: newItemType,
        content: ''
      });
      
      const newItem = response.data.data;
      message.success('创建成功');
      setCreateModalVisible(false);
      
      // 刷新数据
      const reportsResponse = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      const newTreeData = reportsResponse.data;
      setTreeData(newTreeData);
      
      // 刷新后重新展开之前展开的菜单，并确保父文件夹也展开
      setTimeout(() => {
        const keysToKeep = [...savedOpenKeys];
        if (parentIdToKeep && !keysToKeep.includes(parentIdToKeep)) {
          keysToKeep.push(parentIdToKeep);
        }
        setOpenKeys(keysToKeep);
        
        // 如果是新创建的研报，就选中它
        if (newItem.type === 'report') {
          // 先清空编辑器和内容状态
          setCurrentContent('');
          setIsModified(false);
          if (editorInstance.current) {
            editorInstance.current.setValue('');
          }
          
          // 从新获取的数据中找到完整的 item
          const itemFromNewData = findItemById(newTreeData, newItem.id);
          
          // 然后选中并设置当前项
          currentEditingIdRef.current = newItem.id;
          setCurrentItem(itemFromNewData || newItem);
          setSelectedKey(newItem.id);
        }
        
        // 延迟一段时间后再解除刷新标记
        setTimeout(() => {
          isRefreshingRef.current = false;
        }, 100);
      }, 50);
    } catch (error) {
      console.error('创建失败', error);
      message.error('创建失败');
      isRefreshingRef.current = false;
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
      // 使用 handleRename 中设置的 item 的 id（通过 selectedKey 保存）
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
        // 保存当前的 openKeys，删除后需要过滤掉被删除的项
        const savedOpenKeys = [...openKeys];
        
        try {
          // 标记正在刷新
          isRefreshingRef.current = true;
          
          await axios.post(`http://${local_ip}:3000/delete_research_report`, {
            id: item.id
          });
          message.success('删除成功');
          if (selectedKey === item.id) {
            setSelectedKey(null);
            setCurrentItem(null);
            setCurrentContent('');
          }
          
          // 刷新数据并重新设置 openKeys，过滤掉被删除的文件夹
          await fetchReports(false);
          
          setTimeout(() => {
            // 过滤掉被删除的项及其子项
            const filteredOpenKeys = savedOpenKeys.filter(key => key !== item.id);
            setOpenKeys(filteredOpenKeys);
            
            // 延迟后解除刷新标记
            setTimeout(() => {
              isRefreshingRef.current = false;
            }, 100);
          }, 50);
        } catch (error) {
          console.error('删除失败', error);
          message.error('删除失败');
          isRefreshingRef.current = false;
        }
      }
    });
  };

  const refreshAndKeepSelection = async () => {
    // 保存当前的 openKeys
    const savedOpenKeys = [...openKeys];
    
    try {
      // 标记正在刷新
      isRefreshingRef.current = true;
      
      const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      setTreeData(response.data);
      
      // 使用 setTimeout 确保 state 更新后再处理
      setTimeout(async () => {
        // 恢复之前的展开状态
        setOpenKeys(savedOpenKeys);
        
        if (selectedKey) {
          const updatedItem = findItemById(response.data, selectedKey);
          if (updatedItem?.type === 'report') {
            // 研报需要重新获取完整内容
            try {
              const reportResponse = await axios.get(`http://${local_ip}:3000/get_research_report`, {
                params: { id: selectedKey }
              });
              setCurrentItem(reportResponse.data);
              setCurrentContent(reportResponse.data.content || '');
            } catch (error) {
              console.error('重新获取研报内容失败', error);
              setCurrentItem(updatedItem);
            }
          } else {
            setCurrentItem(updatedItem);
          }
        }
        
        // 延迟后解除刷新标记
        setTimeout(() => {
          isRefreshingRef.current = false;
        }, 100);
      }, 0);
    } catch (error) {
      console.error('刷新数据失败', error);
      isRefreshingRef.current = false;
    }
  };

  const handleSave = async () => {
    if (!selectedKey || !currentItem || currentItem.type !== 'report') {
      message.warning('请先选择一个研报');
      return;
    }

    try {
      // 确保使用当前项的 id 而不是 selectedKey
      await axios.post(`http://${local_ip}:3000/update_research_report`, {
        id: currentItem.id,
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

  // 用 ref 来跟踪当前正在编辑的项目 id，防止内容错位
  const currentEditingIdRef = useRef(null);

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
    // 当选中的项目变化时，更新跟踪的 id 并设置编辑器内容
    if (currentItem?.type === 'report') {
      currentEditingIdRef.current = currentItem.id;
      
      if (editorInstance.current) {
        setTimeout(() => {
          // 确保当前的 currentItem 没有在延迟期间变化
          if (editorInstance.current && currentEditingIdRef.current === currentItem.id) {
            try {
              editorInstance.current.setValue(currentContent || '');
            } catch (error) {
              console.warn('设置编辑器内容时出错:', error);
            }
          }
        }, 50);
      }
    } else {
      currentEditingIdRef.current = null;
    }
  }, [currentItem?.id]);

  return (
    <Layout style={{ height: 'calc(100vh - 180px)', background: '#fff' }}>
      <Sider width={300} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #f0f0f0' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space style={{ width: '100%' }}>
              <Input
                placeholder="搜索文件夹或研报..."
                prefix={<SearchOutlined />}
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                allowClear
                style={{ flex: 1 }}
              />
              <Button 
                type={filterImportant ? 'primary' : 'default'}
                icon={<StarOutlined />}
                onClick={() => {
                  setFilterImportant(!filterImportant);
                  if (filterImportant) {
                    setSearchKeyword('');
                  }
                }}
              >
                重点研报
              </Button>
            </Space>
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
          openKeys={openKeys}
          onOpenChange={(keys) => {
            // 如果正在刷新数据，忽略 openKeys 的变化
            if (!isRefreshingRef.current) {
              setOpenKeys(keys);
            }
          }}
          items={buildMenuItems(filterTreeData(treeData, searchKeyword, filterImportant))}
          onSelect={handleMenuSelect}
          style={{ height: 'calc(100% - 180px)', overflowY: 'auto', borderRight: 0 }}
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
