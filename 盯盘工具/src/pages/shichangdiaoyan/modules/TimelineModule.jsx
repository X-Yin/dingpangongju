import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, Timeline, message, Modal, Space, Upload, Image } from 'antd';
import { EditOutlined, DeleteOutlined, PlusOutlined, ClockCircleOutlined, PictureOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../constant';
import TimelineEventEditorModal from '../components/TimelineEventEditorModal';

const TimelineModule = () => {
  const [timelineList, setTimelineList] = useState([]);
  const [timelineModalVisible, setTimelineModalVisible] = useState(false);
  const [editingTimelineItem, setEditingTimelineItem] = useState(null);
  const [marketRhythmData, setMarketRhythmData] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef(null);

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

  useEffect(() => {
    fetchTimelineData();
    fetchMarketRhythmData();
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
              暂无时间线事件，点击上方"新建事件"添加
            </div>
          )}
        </Timeline>
      </Card>

      <Card 
        title={<><PictureOutlined style={{ marginRight: 8 }} /> 市场节奏推演</>}
      >
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
