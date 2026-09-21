import React, { useState, useEffect, useRef } from 'react';
import { Layout, Menu, Button, Input, Modal, message, Space, Dropdown, Typography, Tooltip, Checkbox } from 'antd';
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
  PushpinOutlined,
  EyeOutlined,
  EyeInvisibleOutlined
} from '@ant-design/icons';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import axios from 'axios';
import { local_ip } from '../../../constant';
import { getThemeColor } from '../../../utils/theme';
import './ResearchReportModule.scss';

const { Sider, Content } = Layout;
const { Text } = Typography;

// 如果第一行包含 markdown 单词（如 AI 生成的 ```markdown 标记行），自动删除第一行
const removeMarkdownFirstLine = (content) => {
  if (!content) return content;
  const lines = content.split('\n');
  if (lines.length > 0 && /markdown/i.test(lines[0])) {
    return lines.slice(1).join('\n').replace(/^\s*\n+/, '');
  }
  return content;
};

const ResearchReportModule = () => {
  const [treeData, setTreeData] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [openKeys, setOpenKeys] = useState([]);
  const [filterImportant, setFilterImportant] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState('folder');
  const [contextMenuParentId, setContextMenuParentId] = useState(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState([]);
  const [showCheckboxes, setShowCheckboxes] = useState(false);
  const vditorRef = useRef(null);
  const editorInstance = useRef(null);
  const [currentContent, setCurrentContent] = useState('');
  const [isModified, setIsModified] = useState(false);
  const [currentItem, setCurrentItem] = useState(null);
  const [shouldFocusEditor, setShouldFocusEditor] = useState(false);
  const createInputRef = useRef(null);
  const renameInputRef = useRef(null);
  const blurTimerRef = useRef(null);
  // 用于保存刷新前的 openKeys 状态
  const previousOpenKeysRef = useRef([]);
  // 用于标记是否正在进行数据刷新操作，避免菜单自动收起
  const isRefreshingRef = useRef(false);

  const handleToggleSelect = (item) => {
    if (item.type !== 'folder') return;

    setSelectedFolders(prev => {
      if (prev.includes(item.id)) {
        return prev.filter(id => id !== item.id);
      } else {
        return [...prev, item.id];
      }
    });
  };

  const handleBatchDelete = () => {
    if (selectedFolders.length === 0) {
      if (showCheckboxes) {
        setShowCheckboxes(false);
      } else {
        setShowCheckboxes(true);
      }
      return;
    }

    const folderNames = selectedFolders.map(id => {
      const item = findItemById(treeData, id);
      return item?.name || '未知文件夹';
    }).join('、');

    Modal.confirm({
      title: '确认批量删除',
      content: `确定要删除以下 ${selectedFolders.length} 个文件夹吗？这将删除文件夹内的所有内容。\n\n${folderNames}`,
      okText: '确认',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          isRefreshingRef.current = true;

          await axios.post(`http://${local_ip}:3000/delete_research_reports`, {
            ids: selectedFolders
          });

          message.success(`成功删除 ${selectedFolders.length} 个文件夹`);

          if (selectedFolders.includes(selectedKey)) {
            setSelectedKey(null);
            setCurrentItem(null);
            setCurrentContent('');
          }

          setSelectedFolders([]);
          setShowCheckboxes(false);
          await fetchReports(false);

          setTimeout(() => {
            isRefreshingRef.current = false;
          }, 100);
        } catch (error) {
          console.error('批量删除失败:', error);
          message.error('批量删除失败');
          isRefreshingRef.current = false;
        }
      },
      onCancel: () => {
        setSelectedFolders([]);
        setShowCheckboxes(false);
      }
    });
  };

  useEffect(() => {
    if (createModalVisible) {
      setTimeout(() => {
        createInputRef.current?.focus();
      }, 100);
    }
  }, [createModalVisible]);

  useEffect(() => {
    if (renameModalVisible) {
      setTimeout(() => {
        renameInputRef.current?.focus();
      }, 100);
    }
  }, [renameModalVisible]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

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
    const searchKeys = getOpenKeysFromTree(treeData, searchKeyword, filterImportant, showHiddenFolders);
    const parentKeys = selectedKey ? getParentKeys(treeData, selectedKey) : [];
    const mergedKeys = [...new Set([...searchKeys, ...parentKeys])];
    setOpenKeys(mergedKeys);
  }, [searchKeyword, treeData, selectedKey, filterImportant, showHiddenFolders]);

  const filterTreeData = (items, keyword, onlyImportant = false, showHidden = false) => {
    const filterAndSortItems = (items) => {
      // 1. 过滤逻辑
      let filtered = items.filter(item => {
        let match = true;

        if (item.type === 'folder' && item.isHidden && !showHidden) {
          return false;
        }

        if (keyword.trim()) {
          const lowerKeyword = keyword.toLowerCase();
          match = item.name.toLowerCase().includes(lowerKeyword);
        }

        if (onlyImportant) {
          match = match && (item.type === 'folder' || item.isImportant);
        }

        if (item.type === 'folder' && item.children && item.children.length > 0) {
          const filteredChildren = filterAndSortItems(item.children);
          if (filteredChildren.length > 0) {
            return true;
          }
        }

        return match;
      });

      // 2. 排序逻辑：置顶优先，其次名称倒序排列（最新的日期在最上面）
      return filtered.sort((a, b) => {
        // 置顶优先
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        // 其次名称倒序
        return b.name.localeCompare(a.name);
      }).map(item => {
        if (item.type === 'folder' && item.children && item.children.length > 0) {
          return {
            ...item,
            children: filterAndSortItems(item.children)
          };
        }
        return item;
      });
    };

    return filterAndSortItems(items);
  };

  const getOpenKeysFromTree = (items, keyword, onlyImportant = false, showHidden = false) => {
    if (!keyword.trim() && !onlyImportant) return [];

    const lowerKeyword = keyword.toLowerCase();
    const newOpenKeys = [];

    const collectOpenKeys = (items) => {
      items.forEach(item => {
        if (item.type === 'folder' && item.children && item.children.length > 0) {
          const filteredChildren = filterTreeData(item.children, keyword, onlyImportant, showHidden);
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
      message.success(item.isPinned ? '已取消置顶' : '置顶成功');

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

  const handleToggleHidden = async (item) => {
    const savedOpenKeys = [...openKeys];

    try {
      isRefreshingRef.current = true;

      await axios.post(`http://${local_ip}:3000/toggle_research_report_hidden`, {
        id: item.id
      });
      message.success(item.isHidden ? '已取消隐藏' : '已隐藏文件夹');

      const response = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      setTreeData(response.data);

      setTimeout(() => {
        setOpenKeys(savedOpenKeys);

        setTimeout(() => {
          isRefreshingRef.current = false;
        }, 100);
      }, 0);
    } catch (error) {
      console.error('隐藏/取消隐藏失败:', error);
      message.error('操作失败');
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
            label: item.isPinned ? '取消置顶' : '置顶',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handlePinReport(item);
            }
          },
                  {
          key: 'rename',
          icon: <EditOutlined />,
          label: '重命名',
          onClick: (e) => {
            e.domEvent.stopPropagation();
            handleRename(item);
          }
        },
          // {
          //   key: 'toggle-important',
          //   icon: <StarOutlined />,
          //   label: item.isImportant ? '取消重点' : '标记重点',
          //   onClick: (e) => {
          //     e.domEvent.stopPropagation();
          //     handleToggleImportant(item);
          //   }
          // },

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
          {
            key: 'toggle-hidden',
            icon: item.isHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />,
            label: item.isHidden ? '取消隐藏' : '隐藏文件夹',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handleToggleHidden(item);
            }
          },
          { type: 'divider' }
        );
      }

      // 添加通用的重命名和删除选项
      menuOptions.push(
                  {
            key: 'toggle-important',
            icon: <StarOutlined />,
            label: item.isImportant ? '取消重点' : '标记重点',
            onClick: (e) => {
              e.domEvent.stopPropagation();
              handleToggleImportant(item);
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
          },
        // {
        //   key: 'delete',
        //   icon: <DeleteOutlined />,
        //   label: '删除',
        //   danger: true,
        //   onClick: (e) => {
        //     e.domEvent.stopPropagation();
        //     handleDelete(item);
        //   }
        // }
      );

      const menuItem = {
        key: item.id,
        className: item.isHidden ? 'hidden-folder-item-container' : '',
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
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}
              className={item.isHidden ? 'hidden-folder-item' : ''}
            >
              <Space style={{ flex: 1, minWidth: 0 }}>
                {item.type === 'folder' ? (
                  <Space size={4}>
                    {parentId === null && showCheckboxes && (
                      <Checkbox
                        checked={selectedFolders.includes(item.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          handleToggleSelect(item);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    <FolderOutlined />
                    {item.isHidden && <EyeInvisibleOutlined style={{ color: '#999', fontSize: '12px' }} />}
                  </Space>
                ) : (
                  <Space size={4}>
                    {item.isPinned && <PushpinOutlined style={{ color: getThemeColor(), fontSize: '12px' }} />}
                    {item.isImportant ? <StarOutlined style={{ color: '#faad14' }} /> : <FileTextOutlined />}
                  </Space>
                )}
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
                      color: item.isHidden ? '#999' : (item.isImportant ? '#faad14' : 'inherit'),
                      fontWeight: item.isHidden ? 'normal' : ((item.isImportant || item.isPinned) ? 'bold' : 'normal'),
                      fontStyle: item.isHidden ? 'italic' : 'normal'
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
                <Button
                  className={`more-options-btn-${item.id}`}
                  type="text"
                  size="small"
                  icon={<MoreOutlined />}
                  onClick={(e) => e.stopPropagation()}
                />
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
    if (selectedFolders.includes(key)) {
      return;
    }

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
        const content = removeMarkdownFirstLine(fullReport.content || '');
        setCurrentContent(content);
        setIsModified(false);

        if (editorInstance.current) {
          editorInstance.current.setValue(content);
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

  const handleCreateTodayFolder = async () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const folderName = `${year}${month}${day}`;

    try {
      isRefreshingRef.current = true;
      const response = await axios.post(`http://${local_ip}:3000/create_research_report`, {
        parentId: null,
        name: folderName,
        type: 'folder',
        content: ''
      });

      const newItem = response.data.data;
      message.success(`已创建当日文件夹: ${folderName}`);

      // 刷新数据并保持状态
      const reportsResponse = await axios.get(`http://${local_ip}:3000/get_research_reports`);
      const newTreeData = reportsResponse.data;
      setTreeData(newTreeData);

      // 自动选中并滚动
      setTimeout(() => {
        const itemFromNewData = findItemById(newTreeData, newItem.id);
        setSelectedKey(newItem.id);
        setCurrentItem(itemFromNewData || newItem);
        setCurrentContent('');
        setIsModified(false);

        // 自动滚动到该项并触发三个点菜单
        setTimeout(() => {
          const menuElement = document.querySelector(`[data-menu-id*="${newItem.id}"]`);
          if (menuElement) {
            menuElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // 延迟触发点击，等待滚动完成
            setTimeout(() => {
              const moreBtn = document.querySelector(`.more-options-btn-${newItem.id}`);
              if (moreBtn) {
                moreBtn.click();
              }
            }, 300);
          }
          isRefreshingRef.current = false;
        }, 200);
      }, 50);
    } catch (error) {
      console.error('创建当日文件夹失败', error);
      message.error('创建当日文件夹失败');
      isRefreshingRef.current = false;
    }
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
          setShouldFocusEditor(true);
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

          setSelectedFolders(prev => prev.filter(id => id !== item.id));

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
              setCurrentContent(removeMarkdownFirstLine(reportResponse.data.content || ''));
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
              const filtered = removeMarkdownFirstLine(value);
              setCurrentContent(filtered);
              setIsModified(true);
              // 内容更新时若首行包含 markdown 单词，立即重设编辑器内容以自动删除首行
              if (filtered !== value) {
                setTimeout(() => {
                  editorInstance.current?.setValue(filtered);
                }, 0);
              }
            },
            after: () => {
              if (shouldFocusEditor) {
                editorInstance.current?.focus();
                setShouldFocusEditor(false);
              }
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
              if (shouldFocusEditor) {
                editorInstance.current.focus();
                setShouldFocusEditor(false);
              }
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
    <Layout className="research-report-module">
      <Sider width={300} className="report-sider">
        <div className="sider-header">
          <Space direction="vertical" style={{ width: '100%' }}>
            <div className="search-wrapper">
              <div className={`search-flex-container ${searchFocused ? 'search-focused' : ''}`}>
                <Input
                  placeholder="搜索文件夹或研报..."
                  prefix={<SearchOutlined />}
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  allowClear
                  style={{ flex: 1 }}
                  onFocus={() => {
                    if (blurTimerRef.current) {
                      clearTimeout(blurTimerRef.current);
                    }
                    setSearchFocused(true);
                  }}
                  onBlur={() => {
                    blurTimerRef.current = setTimeout(() => {
                      setSearchFocused(false);
                    }, 150);
                  }}
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
                  className="search-action-btn"
                >
                  <span className={`btn-label ${searchFocused ? 'hidden' : ''}`}>重点</span>
                </Button>
                <Button
                  type={showHiddenFolders ? 'primary' : 'default'}
                  icon={showHiddenFolders ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                  onClick={() => setShowHiddenFolders(!showHiddenFolders)}
                  className="search-action-btn"
                >
                  <span className={`btn-label ${searchFocused ? 'hidden' : ''}`}>隐藏</span>
                </Button>
              </div>
            </div>
            <div className="action-buttons">
              <Button
                type="primary"
                onClick={handleCreateTodayFolder}
                style={{ flex: 1.5 }}
              >
                今日
              </Button>
              <Button
                danger
                icon={<DeleteOutlined />}
                onClick={handleBatchDelete}
                style={{ flex: 1 }}
              >
                批量删除
              </Button>
            </div>
            <Text type="secondary" style={{ fontSize: 12, textAlign: 'center', display: 'block' }}>
              右键文件夹或点击 ··· 可在其中创建子项
            </Text>
          </Space>
        </div>
        <Menu
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          openKeys={openKeys}
          onOpenChange={(keys) => {
            if (!isRefreshingRef.current) {
              setOpenKeys(keys);
            }
          }}
          items={buildMenuItems(filterTreeData(treeData, searchKeyword, filterImportant, showHiddenFolders))}
          onSelect={handleMenuSelect}
          className="report-menu"
          style={{ maxHeight: '700px', overflowY: 'auto' }}
        />
      </Sider>
      <Content className="report-content">
        {currentItem?.type === 'report' ? (
          <>
            <div className="content-header">
              <div className="title-section">
                <Text strong className="report-title">{currentItem.name}</Text>
                {isModified && <span className="modified-tag">有未保存的修改</span>}
              </div>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={handleSave}
                disabled={!isModified}
                className="save-btn"
              >
                保存
              </Button>
            </div>
            <div
              ref={vditorRef}
              className="vditor-container"
            />
          </>
        ) : currentItem?.type === 'folder' ? (
          <div className="empty-state">
            <FolderOutlined className="empty-icon" style={{ color: getThemeColor() }} />
            <div className="empty-text">文件夹: {currentItem.name}</div>
          </div>
        ) : (
          <div className="empty-state">
            <FileTextOutlined className="empty-icon" />
            <div className="empty-text">请从左侧选择一个研报或文件夹</div>
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
          ref={createInputRef}
          placeholder="请输入名称"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onPressEnter={confirmCreate}
          autoFocus
        />
      </Modal>

      <Modal
        title="重命名"
        open={renameModalVisible}
        onOk={confirmRename}
        onCancel={() => setRenameModalVisible(false)}
      >
        <Input
          ref={renameInputRef}
          placeholder="请输入新名称"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          onPressEnter={confirmRename}
          autoFocus
        />
      </Modal>
    </Layout>
  );
};

export default ResearchReportModule;
