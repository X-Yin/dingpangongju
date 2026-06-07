import React, { useState, useEffect } from 'react';
import { Typography, List, Card, Spin, message, Button, Space, Modal, Row, Col } from 'antd';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import axios from 'axios';
import { local_ip } from '../../constant';
import MainProblemEditorModal from './components/MainProblemEditorModal';
import PersonalSuggestionEditor from './components/PersonalSuggestionEditor';

const { Title, Text, Paragraph } = Typography;

const ZhuYaoMaoDun = () => {
  const [mainProblemList, setMainProblemList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState(null); // Track the item being edited
  const [globalSuggData, setGlobalSuggData] = useState('');
  const [tempSuggData, setTempSuggData] = useState('');

  const handleUpdatePersonalSuggestion = async (type, content) => {
    try {
      const payload = {};
      if (type === 'globalSuggData') {
        payload.globalSuggContent = content;
      } else if (type === 'tempSuggData') {
        payload.tempSuggContent = content;
      }
      await axios.post(`http://${local_ip}:3000/update_personal_sugg`, payload);
      message.success(`${type === 'globalSuggData' ? '全局市场观点' : '短期操作观点'}更新成功`);
      // No need to refetch all main problems, just update the local state if needed
      if (type === 'globalSuggData') {
        setGlobalSuggData(content);
      } else if (type === 'tempSuggData') {
        setTempSuggData(content);
      }
    } catch (error) {
      console.error('Error updating personal suggestion:', error);
      message.error('更新个人观点失败');
    }
  };

  useEffect(() => {
    fetchMainProblems();
  }, []);

  const fetchMainProblems = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`http://${local_ip}:3000/get_main_problem`);
      if (response.data) {
        setMainProblemList(response.data.mainProblemData || []);
        setGlobalSuggData(response.data.personalSuggData?.globalSuggContent || '');
        setTempSuggData(response.data.personalSuggData?.tempSuggContent || '');
      }
    } catch (error) {
      console.error('Error fetching main problems:', error);
      message.error('获取主要矛盾列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAddOrUpdateMainProblem = async (id, title, content) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_main_problem`, { id, title, content });
      message.success('主要矛盾保存成功');
      fetchMainProblems(); // Refresh the list
      handleModalClose(); // Close modal after successful save
    } catch (error) {
      console.error('Error saving main problem:', error);
      message.error('保存主要矛盾失败');
    }
  };

  const handleEdit = (item) => {
    setEditingItem(item);
    setIsModalVisible(true);
  };

  const handleModalClose = () => {
    setIsModalVisible(false);
    setEditingItem(null); // Clear editing item when modal closes
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
      fetchMainProblems(); // Refresh the list after deletion
    } catch (error) {
      console.error('Error deleting main problem:', error);
      message.error('删除失败');
    }
  };

  const updateMainProblemSequence = async (seqIds) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_main_problem_seq`, { seq_ids: seqIds });
      message.success('主要矛盾顺序更新成功');
    } catch (error) {
      console.error('Error updating main problem sequence:', error);
      message.error('更新主要矛盾顺序失败');
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
        <Spin size="large" tip="正在加载主要矛盾..." />
      </div>
    );
  }

  return (
    <div className="zhuyaomaodun-container">
      <Row gutter={[16, 16]}>
        <Col span={12}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Title level={2} style={{ margin: 0 }}>主要矛盾</Title>
            <Button type="primary" onClick={() => setIsModalVisible(true)}>新建</Button>
          </div>
          <Paragraph type="secondary">拖拽列表项可调整主要矛盾的顺序。</Paragraph>
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
                            style={{
                              ...provided.draggableProps.style,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              backgroundColor: snapshot.isDragging ? '#e6f7ff' : 'white',
                              padding: '12px 16px',
                              marginBottom: '8px',
                              border: '1px solid #f0f0f0',
                              borderRadius: '4px',
                              boxShadow: snapshot.isDragging ? '0 2px 8px rgba(0,0,0,0.15)' : 'none',
                            }}
                          >
                            <Card 
                              bordered={false} 
                              size="small"
                              style={{ flexGrow: 1, marginRight: '16px' }}
                            >
                              <Title level={4} style={{ margin: 0 }}>{item.title}</Title>
                              <Text type="secondary">ID: {item.id}</Text>
                              <Paragraph style={{ marginTop: '8px' }}>
                                {item.content.length > 40 ? `${item.content.substring(0, 40)}...` : item.content}
                              </Paragraph>
                            </Card>
                            <Space>
                              <Button type="link" onClick={() => handleEdit(item)}>编辑</Button>
                              <Button type="link" danger onClick={() => showDeleteConfirm(item)}>删除</Button>
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
        </Col>
        <Col span={12}>
          <PersonalSuggestionEditor
            title="全局市场观点"
            initialContent={globalSuggData}
            onSave={(content) => handleUpdatePersonalSuggestion('globalSuggData', content)}
            cacheId="global-sugg-vditor-cache"
          />
          <PersonalSuggestionEditor
            title="短期操作观点"
            initialContent={tempSuggData}
            onSave={(content) => handleUpdatePersonalSuggestion('tempSuggData', content)}
            cacheId="temp-sugg-vditor-cache"
          />
        </Col>
      </Row>

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

export default ZhuYaoMaoDun;
