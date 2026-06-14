import React, { useState, useEffect } from 'react';
import { Card, Button, Timeline, message, Modal, Space } from 'antd';
import { EditOutlined, DeleteOutlined, PlusOutlined, ClockCircleOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../constant';
import TimelineEventEditorModal from '../components/TimelineEventEditorModal';

const TimelineModule = () => {
  const [timelineList, setTimelineList] = useState([]);
  const [timelineModalVisible, setTimelineModalVisible] = useState(false);
  const [editingTimelineItem, setEditingTimelineItem] = useState(null);

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

  useEffect(() => {
    fetchTimelineData();
  }, []);

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
      content: `您确定要删除“${item.title}”吗？此操作不可撤销。`,
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

  return (
    <div>
      <Card 
        title={<><ClockCircleOutlined style={{ marginRight: 8 }} /> 时间线</>}
        style={{ marginBottom: 16 }}
        extra={
          <Button 
            type="primary" 
            icon={<PlusOutlined />}
            onClick={() => setTimelineModalVisible(true)}
          >
            新建事件
          </Button>
        }
      >
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
              暂无时间线事件，点击上方“新建事件”添加
            </div>
          )}
        </Timeline>
      </Card>
      <TimelineEventEditorModal
        visible={timelineModalVisible}
        onCancel={handleTimelineModalClose}
        onSave={handleAddOrUpdateTimelineEvent}
        initialEvent={editingTimelineItem}
      />
    </div>
  );
};

export default TimelineModule;
