import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Button, Modal, Form, Input, DatePicker, Select, Space, Tooltip, Empty, Popconfirm, message, Spin, Checkbox, Switch } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, HolderOutlined, CompressOutlined, ExpandOutlined, SortAscendingOutlined, SyncOutlined } from '@ant-design/icons';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import axios from 'axios';
import { local_ip } from '../../../constant';
import dayjs from 'dayjs';
import './CustomGantt.scss';

const { RangePicker } = DatePicker;
const { Option } = Select;

const IMPACT_LEVELS = {
  positive: { label: '利好', color: '#ff4d4f', bgColor: 'rgba(255, 77, 79, 0.1)' },
  negative: { label: '利空', color: '#52c41a', bgColor: 'rgba(82, 196, 26, 0.1)' },
  neutral: { label: '中性', color: '#8c8c8c', bgColor: 'rgba(140, 140, 140, 0.1)' },
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const CustomGantt = ({ 
  fetchUrl = `http://${local_ip}:3000/get_market_rhythm_gantt`, 
  saveUrl = `http://${local_ip}:3000/update_market_rhythm_gantt`,
  syncUrl = null,
  title = "节奏推演甘特图"
}) => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isThumbnail, setIsThumbnail] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [hoveredEventRange, setHoveredEventRange] = useState(null);
  const chartWrapperRef = useRef(null);

  useEffect(() => {
    if (chartWrapperRef.current) {
      const resizeObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          setContainerWidth(entry.contentRect.width);
        }
      });
      resizeObserver.observe(chartWrapperRef.current);
      return () => resizeObserver.disconnect();
    }
  }, []);

  const fetchGanttData = async () => {
    try {
      setLoading(true);
      const res = await axios.get(fetchUrl);
      setEvents(res.data || []);
    } catch (error) {
      console.error('获取甘特图数据失败:', error);
      message.error('获取甘特图数据失败');
    } finally {
      setLoading(false);
    }
  };

  const saveGanttData = async (newEvents) => {
    try {
      await axios.post(saveUrl, {
        events: newEvents
      });
    } catch (error) {
      console.error('保存甘特图数据失败:', error);
      message.error('保存失败');
      fetchGanttData();
    }
  };

  const onDragEnd = (result) => {
    if (!result.destination) return;
    const { source, destination } = result;
    if (destination.index === source.index) return;
    
    const sourceItem = visibleEvents[source.index];
    const destItem = visibleEvents[destination.index];
    if (!sourceItem || !destItem) return;

    const newEvents = Array.from(events);
    const sourceIndexInFull = newEvents.findIndex(e => e.id === sourceItem.id);
    if (sourceIndexInFull === -1) return;

    // 先从全量数组中移除源条目
    const [reorderedItem] = newEvents.splice(sourceIndexInFull, 1);
    
    // 在移除后的数组中找到目标条目的新索引
    const destIndexInFullAfterRemove = newEvents.findIndex(e => e.id === destItem.id);
    if (destIndexInFullAfterRemove === -1) return;

    // 如果是向下拖拽 (source.index < destination.index)，则插入到目标条目之后
    // 如果是向上拖拽 (source.index > destination.index)，则插入到目标条目之前
    const insertIndex = destination.index > source.index 
      ? destIndexInFullAfterRemove + 1 
      : destIndexInFullAfterRemove;

    newEvents.splice(insertIndex, 0, reorderedItem);
    
    setEvents(newEvents);
    saveGanttData(newEvents);
  };

  const handleSortByDate = () => {
    const sortedEvents = [...events].sort((a, b) => {
      const dateA = dayjs(a.startDate);
      const dateB = dayjs(b.startDate);
      if (dateA.isBefore(dateB)) return -1;
      if (dateA.isAfter(dateB)) return 1;
      return 0;
    });
    
    setEvents(sortedEvents);
    saveGanttData(sortedEvents);
    message.success('已按起始时间排序');
  };

  const handleSyncFromMarketRhythm = async () => {
    if (!syncUrl) return;
    try {
      setLoading(true);
      const res = await axios.get(syncUrl);
      const sourceEvents = res.data || [];
      
      // 过滤出起始时间在最近 10 天之内的数据（包括过去 10 天和未来 10 天，以覆盖当前和即将到来的节奏）
      const tenDaysAgo = dayjs().subtract(10, 'day').startOf('day');
      const tenDaysLater = dayjs().add(10, 'day').endOf('day');
      
      const filteredEvents = sourceEvents.filter(event => {
        const startDate = dayjs(event.startDate);
        return (startDate.isAfter(tenDaysAgo) || startDate.isSame(tenDaysAgo, 'day')) && 
               (startDate.isBefore(tenDaysLater) || startDate.isSame(tenDaysLater, 'day'));
      });

      if (filteredEvents.length === 0) {
        message.info('最近 10 天内没有可同步的市场节奏数据');
        return;
      }

      // 合并数据，通过标题去重（如果标题已存在则不再同步）
      const existingTitles = new Set(events.map(e => e.title));
      const newItems = filteredEvents
        .filter(e => !existingTitles.has(e.title))
        .map(e => ({ ...e, id: Date.now() + Math.random() })); // 重新生成 ID 以防冲突

      if (newItems.length === 0) {
        message.info('所选数据已在列表中，无需同步');
        return;
      }

      const mergedEvents = [...events, ...newItems];
      setEvents(mergedEvents);
      await saveGanttData(mergedEvents);
      message.success(`成功同步 ${newItems.length} 条数据`);
    } catch (error) {
      console.error('同步失败:', error);
      message.error('同步失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGanttData();
  }, []);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [form] = Form.useForm();

  // 计算时间轴范围（确保覆盖所有事件，且至少到下个月月底）
  const timelineRange = useMemo(() => {
    let start = dayjs().startOf('day');
    
    // 如果有事件的开始时间在今天之前，则从最早的事件开始
    events.forEach(event => {
      const eventStart = dayjs(event.startDate).startOf('day');
      if (eventStart.isBefore(start)) {
        start = eventStart;
      }
    });

    const end = dayjs().add(1, 'month').endOf('month');
    const days = [];
    let current = start;
    while (current.isBefore(end) || current.isSame(end, 'day')) {
      days.push(current);
      current = current.add(1, 'day');
    }
    return { start, end, days };
  }, [events]);

  const cellWidth = useMemo(() => {
    if (!isThumbnail) return 60;
    // 缩略模式下，尝试将所有日期放进屏幕
    // 280 是左侧标签宽度, 32 是容器内边距
    const availableWidth = containerWidth - 280 - 32;
    if (availableWidth <= 0) return 60;
    return Math.max(12, availableWidth / timelineRange.days.length);
  }, [isThumbnail, containerWidth, timelineRange.days.length]);

  const totalContentWidth = timelineRange.days.length * cellWidth;

  const handleAdd = () => {
    setEditingEvent(null);
    form.resetFields();
    form.setFieldsValue({ dates: [dayjs(), dayjs().add(1, 'day')], level: 'neutral', descInline: false, isImportant: false });
    setIsModalOpen(true);
  };

  const handleEdit = (event) => {
    setEditingEvent(event);
    form.setFieldsValue({
      title: event.title,
      description: event.description,
      dates: [dayjs(event.startDate), dayjs(event.endDate)],
      level: event.level,
      descInline: event.descInline || false,
      isImportant: event.isImportant || false,
    });
    setIsModalOpen(true);
  };

  const handleDelete = (id) => {
    const newEvents = events.filter(e => e.id !== id);
    setEvents(newEvents);
    saveGanttData(newEvents);
  };

  const handleModalOk = () => {
    form.validateFields().then(values => {
      const newEvent = {
        id: editingEvent ? editingEvent.id : Date.now(),
        title: values.title,
        description: values.description,
        startDate: values.dates[0].format('YYYY-MM-DD'),
        endDate: values.dates[1].format('YYYY-MM-DD'),
        level: values.level,
        descInline: values.descInline || false,
        isImportant: values.isImportant || false,
      };

      let newEvents;
      if (editingEvent) {
        newEvents = events.map(e => e.id === editingEvent.id ? newEvent : e);
      } else {
        newEvents = [...events, newEvent];
      }
      setEvents(newEvents);
      saveGanttData(newEvents);
      setIsModalOpen(false);
    });
  };

  const renderGanttBar = (event, index, provided, snapshot) => {
    const start = dayjs(event.startDate);
    const end = dayjs(event.endDate);
    
    // 计算位置和宽度
    const startOffset = Math.max(0, start.diff(timelineRange.start, 'day'));
    const duration = end.diff(start.isBefore(timelineRange.start) ? timelineRange.start : start, 'day') + 1;
    
    const left = startOffset * cellWidth;
    const width = duration * cellWidth;

    const levelInfo = IMPACT_LEVELS[event.level];
    const isExpired = dayjs().isAfter(dayjs(event.endDate).endOf('day'));

    return (
      <div 
        ref={provided.innerRef}
        {...provided.draggableProps}
        className={`gantt-bar-row ${snapshot.isDragging ? 'dragging' : ''} ${isExpired ? 'expired' : ''} ${isThumbnail ? 'thumbnail' : ''} ${event.isImportant ? 'important' : ''}`}
        style={{
          ...provided.draggableProps.style,
        }}
        onMouseEnter={() => setHoveredEventRange({ start: event.startDate, end: event.endDate })}
        onMouseLeave={() => setHoveredEventRange(null)}
      >
        <div className="event-info-label">
          <div className="label-left">
            <div className="drag-handle" {...provided.dragHandleProps}>
              <HolderOutlined />
            </div>
            <span className="title" title={event.title}>{event.title}</span>
          </div>
          <Space size={4}>
            {!isThumbnail && (
              <>
                <Button type="text" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); handleEdit(event); }} />
                <Popconfirm title="确定删除吗？" onConfirm={() => handleDelete(event.id)}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                </Popconfirm>
              </>
            )}
          </Space>
        </div>
        <div className="bar-container" style={{ width: isThumbnail ? '100%' : totalContentWidth }}>
          <Tooltip placement='bottom' title={isThumbnail ? `${event.title}: ${levelInfo.label}${event.description ? ` - ${event.description}` : ''}` : ''}>
            <div 
              className={`bar ${event.descInline ? 'desc-inline' : ''}`}
              onClick={() => handleEdit(event)}
              style={{ 
                left: `${left}px`, 
                width: `${width}px`,
                backgroundColor: levelInfo.color,
                boxShadow: `0 2px 6px ${levelInfo.bgColor}`
              }}
            >
              {!isThumbnail && <span className="bar-text">{levelInfo.label}</span>}
              {!isThumbnail && event.descInline && event.description && (
                <span className="bar-inline-desc">{event.description}</span>
              )}
            </div>
          </Tooltip>
          {!isThumbnail && !event.descInline && event.description && (
            <div 
              className="bar-description"
              style={{ left: `${left + width + 8}px` }}
            >
              {event.description}
            </div>
          )}
        </div>
      </div>
    );
  };

  // 过滤出在当前时间轴范围内可见的事件
  const visibleEvents = useMemo(() => {
    return events.filter(event => {
      const start = dayjs(event.startDate);
      const end = dayjs(event.endDate);
      return !(end.isBefore(timelineRange.start) || start.isAfter(timelineRange.end));
    });
  }, [events, timelineRange]);

  return (
    <div className="custom-gantt-container" ref={chartWrapperRef}>
      <div className="gantt-header">
        <div className="header-left">
          <span className="gantt-title">{title}</span>
          <Space style={{ marginLeft: 24 }}>
            <span style={{ fontSize: '13px', color: '#8c8c8c' }}>缩略展示</span>
            <Switch 
              size="small" 
              checked={isThumbnail} 
              onChange={setIsThumbnail}
              checkedChildren={<CompressOutlined />}
              unCheckedChildren={<ExpandOutlined />}
            />
          </Space>
        </div>
        <Space>
          {syncUrl && (
            <Button 
              icon={<SyncOutlined />} 
              onClick={handleSyncFromMarketRhythm}
              loading={loading}
            >
              同步近期市场节奏
            </Button>
          )}
          <Button 
            icon={<SortAscendingOutlined />} 
            onClick={handleSortByDate}
            title="按起始时间自动排序"
          >
            时间排序
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增事件</Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <div className={`gantt-chart-wrapper ${isThumbnail ? 'is-thumbnail' : ''}`}>
          <div className="gantt-chart-scroll">
            {/* 时间轴头部 */}
            <div className="timeline-header" style={{ width: isThumbnail ? '100%' : 'fit-content' }}>
              <div className="label-spacer">事件名称</div>
              <div className="days-header" style={{ flexGrow: isThumbnail ? 1 : 0 }}>
                {timelineRange.days.map(day => {
                  const dayStr = day.format('YYYY-MM-DD');
                  const isHighlighted = hoveredEventRange && 
                    (dayStr >= hoveredEventRange.start && dayStr <= hoveredEventRange.end);
                  
                  return (
                    <div 
                      key={dayStr} 
                      className={`day-cell ${day.isSame(dayjs(), 'day') ? 'today' : ''} ${day.day() === 0 || day.day() === 6 ? 'weekend' : ''} ${isHighlighted ? 'highlight-purple' : ''}`}
                      style={{ width: cellWidth, flexGrow: isThumbnail ? 1 : 0 }}
                    >
                      <div className="date-num">{day.format('DD')}</div>
                      <div className="date-weekday">{WEEKDAYS[day.day()]}</div>
                      {!isThumbnail && <div className="date-month">{day.format('MM')}月</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 甘特图主体区域 */}
            <div className="gantt-main-area" style={{ width: isThumbnail ? '100%' : 'fit-content' }}>
              {/* 网格背景层 - 放在 Droppable 同级但 z-index 较低 */}
              <div className="grid-background">
                <div className="label-spacer" />
                <div className="grid-lines" style={{ width: isThumbnail ? '100%' : totalContentWidth, flexGrow: isThumbnail ? 1 : 0 }}>
                  {timelineRange.days.map(day => (
                    <div 
                      key={`grid-${day.format('YYYY-MM-DD')}`} 
                      className={`grid-line ${day.isSame(dayjs(), 'day') ? 'today' : ''} ${day.day() === 0 || day.day() === 6 ? 'weekend' : ''}`}
                      style={{ width: cellWidth, flexGrow: isThumbnail ? 1 : 0 }}
                    />
                  ))}
                </div>
              </div>

              {/* 拖拽层 */}
              <DragDropContext onDragEnd={onDragEnd}>
                <Droppable droppableId="gantt-events">
                  {(provided) => (
                    <div 
                      className="gantt-body"
                      {...provided.droppableProps}
                      ref={provided.innerRef}
                      style={{ width: isThumbnail ? '100%' : 'fit-content' }}
                    >
                      {visibleEvents.length === 0 && !loading ? (
                        <Empty description="暂无推演事件" style={{ margin: '40px 0' }} />
                      ) : (
                        visibleEvents.map((event, index) => (
                          <Draggable key={String(event.id)} draggableId={String(event.id)} index={index}>
                            {(provided, snapshot) => renderGanttBar(event, index, provided, snapshot)}
                          </Draggable>
                        ))
                      )}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </div>
          </div>
        </div>
      </Spin>

      <Modal
        title={editingEvent ? '编辑推演事件' : '新增推演事件'}
        open={isModalOpen}
        onOk={handleModalOk}
        onCancel={() => setIsModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="事件标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：某板块主升浪预期" />
          </Form.Item>
          <Form.Item name="dates" label="起止时间" rules={[{ required: true, message: '请选择时间范围' }]}>
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="level" label="影响级别" rules={[{ required: true }]}>
            <Select>
              <Option value="positive">利好 (红色)</Option>
              <Option value="neutral">中性 (灰色)</Option>
              <Option value="negative">利空 (绿色)</Option>
            </Select>
          </Form.Item>
          <Form.Item name="descInline" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>描述文字内置在方块中</Checkbox>
          </Form.Item>
          <Form.Item name="isImportant" valuePropName="checked">
            <Checkbox>标记为重点（突出显示）</Checkbox>
          </Form.Item>
          <Form.Item name="description" label="详细描述">
            <Input.TextArea rows={3} placeholder="输入事件的详细逻辑推演..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default CustomGantt;
