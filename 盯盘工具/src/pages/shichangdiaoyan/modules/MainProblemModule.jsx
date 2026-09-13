import React, { useState, useEffect } from 'react';
import { Typography, List, Card, Spin, message, Button, Space, Modal } from 'antd';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../constant';
import MainProblemEditorModal from '../components/MainProblemEditorModal';
import './ModulesCommon.scss';

const { Title, Text, Paragraph } = Typography;

const MainProblemModule = () => {
  const [mainProblemList, setMainProblemList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState(null);

  const fetchMainProblems = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`http://${local_ip}:3000/get_main_problem`);
      if (response.data) {
        setMainProblemList(response.data.mainProblemData || []);
      }
    } catch (error) {
      console.error('Error fetching main problems:', error);
      message.error('获取消息面列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMainProblems();
  }, []);

  const handleAddOrUpdateMainProblem = async (id, title, content) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_main_problem`, { id, title, content });
      message.success('消息面保存成功');
      fetchMainProblems();
      handleModalClose();
    } catch (error) {
      console.error('Error saving main problem:', error);
      message.error('保存消息面失败');
    }
  };

  const handleEdit = (item) => {
    setEditingItem(item);
    setIsModalVisible(true);
  };

  const handleModalClose = () => {
    setIsModalVisible(false);
    setEditingItem(null);
  };

  const showDeleteConfirm = (item) => {
    Modal.confirm({
      title: '确认删除',
      content: `您确定要删除“${item.title}”吗？此操作不可撤销。`,
      okText: '确认',
      okType: 'danger',
      cancelText: '取消',
      onOk() {
        handleDelete(item.id);
      },
    });
  };

  const handleDelete = async (id) => {
    try {
      await axios.post(`http://${local_ip}:3000/del_main_problem`, { id });
      message.success('删除成功');
      fetchMainProblems();
    } catch (error) {
      console.error('Error deleting main problem:', error);
      message.error('删除失败');
    }
  };

  const updateMainProblemSequence = async (seqIds) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_main_problem_seq`, { seq_ids: seqIds });
      message.success('消息面顺序更新成功');
    } catch (error) {
      console.error('Error updating main problem sequence:', error);
      message.error('更新消息面顺序失败');
    }
  };

  const onDragEnd = (result) => {
    if (!result.destination) {
      return;
    }

    const reorderedList = Array.from(mainProblemList);
    const [removed] = reorderedList.splice(result.source.index, 1);
    reorderedList.splice(result.destination.index, 0, removed);

    setMainProblemList(reorderedList);
    const newSeqIds = reorderedList.map(item => item.id);
    updateMainProblemSequence(newSeqIds);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
        <Spin size="large" tip="正在加载消息面..." />
      </div>
    );
  }

  return (
    <div className="module-common-container">
      <div className="module-header">
        <Title level={2}>消息面</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalVisible(true)}>新建</Button>
      </div>
      <div className="module-description">拖拽列表项可调整消息面的顺序。</div>
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="main-problems-list">
          {(provided) => (
            <div
              {...provided.droppableProps}
              ref={provided.innerRef}
            >
              <List
                itemLayout="vertical"
                dataSource={mainProblemList}
                renderItem={(item, index) => (
                  <Draggable key={item.id} draggableId={item.id.toString()} index={index}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        className={`draggable-item ${snapshot.isDragging ? 'is-dragging' : ''}`}
                        style={{
                          ...provided.draggableProps.style,
                        }}
                      >
                        <div className="item-content-wrapper">
                          <Title level={4}>{item.title}</Title>
                          <Text className="item-id">ID: {item.id}</Text>
                          <Paragraph className="item-preview">
                            {item.content.length > 80 ? `${item.content.substring(0, 80)}...` : item.content}
                          </Paragraph>
                        </div>
                        <Space>
                          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(item)}>编辑</Button>
                          <Button type="link" danger icon={<DeleteOutlined />} onClick={() => showDeleteConfirm(item)}>删除</Button>
                        </Space>
                      </div>
                    )}
                  </Draggable>
                )}
              />
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
      <MainProblemEditorModal
        visible={isModalVisible}
        onCancel={handleModalClose}
        onSave={handleAddOrUpdateMainProblem}
        initialTitle={editingItem ? editingItem.title : ''}
        initialContent={editingItem ? editingItem.content : ''}
        editingId={editingItem ? editingItem.id : null}
      />
    </div>
  );
};

export default MainProblemModule;
