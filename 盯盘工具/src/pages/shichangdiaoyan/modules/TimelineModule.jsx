import { useState, useEffect, useRef } from 'react';
import { Card, Button, Timeline, message, Modal, Space, Upload, Image, Tabs, Input } from 'antd';
import { EditOutlined, DeleteOutlined, PlusOutlined, ClockCircleOutlined, PictureOutlined, BarChartOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../../constant';
import TimelineEventEditorModal from '../components/TimelineEventEditorModal';
import mermaid from 'mermaid';

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
  const [longTermRhythmData, setLongTermRhythmData] = useState(null);
  const [longTermRhythmContent, setLongTermRhythmContent] = useState('');
  const [longTermRhythmEditorVisible, setLongTermRhythmEditorVisible] = useState(false);
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

  const fetchLongTermRhythmData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_long_term_rhythm`);
      const data = response.data;
      setLongTermRhythmData(data);
      if (data) {
        setLongTermRhythmContent(data.content || '');
      }
    } catch (error) {
      console.error('Error fetching long term rhythm data:', error);
      message.error('获取长期炒作节奏数据失败');
    }
  };

  const updateLongTermRhythmData = async (content) => {
    try {
      await axios.post(`http://${local_ip}:3000/update_long_term_rhythm`, { content });
      message.success('长期炒作节奏更新成功');
      fetchLongTermRhythmData();
    } catch (error) {
      console.error('Error updating long term rhythm data:', error);
      message.error('更新长期炒作节奏失败');
    }
  };

  useEffect(() => {
    fetchTimelineData();
    fetchMarketRhythmData();
    fetchRecentOperationData();
    fetchLongTermRhythmData();
  }, []);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose'
    });
  }, []);

  useEffect(() => {
    if (mermaidRef.current && longTermRhythmContent) {
      mermaidRef.current.innerHTML = '';
      try {
        mermaid.render('mermaid-chart', longTermRhythmContent).then(({ svg }) => {
          mermaidRef.current.innerHTML = svg;
        }).catch((error) => {
          console.error('Error rendering mermaid chart:', error);
          mermaidRef.current.innerHTML = '<div style="color: red;">图表渲染失败，请检查 Mermaid 语法</div>';
        });
      } catch (error) {
        console.error('Error rendering mermaid chart:', error);
        mermaidRef.current.innerHTML = '<div style="color: red;">图表渲染失败，请检查 Mermaid 语法</div>';
      }
    }
  }, [longTermRhythmContent]);

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

  const handleSaveLongTermRhythm = () => {
    updateLongTermRhythmData(longTermRhythmContent);
    setLongTermRhythmEditorVisible(false);
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
          <div style={{ marginBottom: 16, textAlign: 'right' }}>
            <Button 
              type="primary" 
              icon={<EditOutlined />}
              onClick={() => setLongTermRhythmEditorVisible(true)}
            >
              编辑
            </Button>
          </div>
          <div 
            ref={mermaidRef} 
            style={{ 
              width: '100%', 
              overflow: 'auto',
              display: 'flex',
              justifyContent: 'center'
            }} 
          />
          {longTermRhythmData && longTermRhythmData.updatedAt && (
            <div style={{ color: '#8c8c8c', fontSize: '12px', marginTop: 16, textAlign: 'center' }}>
              最后更新：{new Date(longTermRhythmData.updatedAt).toLocaleString()}
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
        title="编辑长期炒作节奏"
        open={longTermRhythmEditorVisible}
        onOk={handleSaveLongTermRhythm}
        onCancel={() => setLongTermRhythmEditorVisible(false)}
        width={800}
        okText="保存"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: '#666', fontSize: '12px', marginBottom: 8 }}>
            使用 Mermaid 语法编辑甘特图，参考：<a href="https://mermaid.js.org/syntax/gantt.html" target="_blank" rel="noopener noreferrer">Mermaid Gantt 文档</a>
          </p>
        </div>
        <Input.TextArea
          value={longTermRhythmContent}
          onChange={(e) => setLongTermRhythmContent(e.target.value)}
          rows={20}
          placeholder="输入 Mermaid 甘特图语法..."
          style={{ fontFamily: 'monospace' }}
        />
      </Modal>
    </div>
  );
};

export default TimelineModule;
