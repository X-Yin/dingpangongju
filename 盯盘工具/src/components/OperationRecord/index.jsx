import React, { useState, useEffect, useMemo } from 'react';
import { Typography, Card, Calendar, Tag, Button, Form, Input, Select, Space, message, ConfigProvider, List, Divider, Row, Col, Modal, Alert } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import { FileTextOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import axios from 'axios';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { local_ip } from '../../constant';
import './index.scss';

// 设置 dayjs 语言为中文
dayjs.locale('zh-cn');

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Option } = Select;

const OperationRecord = () => {
  const [selectedDate, setSelectedDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [operationRecords, setOperationRecords] = useState({}); // { 'YYYY-MM-DD': [{ stockName, opType, reason, thought }] }
  const [form] = Form.useForm();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentRecordIndex, setCurrentRecordIndex] = useState(0); // 当前正在编辑的记录索引
  const [confirmModalVisible, setConfirmModalVisible] = useState(false); // 二次确认弹窗
  const [confirmModalType, setConfirmModalType] = useState('sellBeforeBuy'); // 弹窗类型：sellBeforeBuy 或 monthlyBuyLimit
  const [pendingSaveData, setPendingSaveData] = useState(null); // 待保存的数据

  // 格式化日期：YYYY-MM-DD <-> YYYYMMDD
  const formatDateToAPI = (dateStr) => dayjs(dateStr).format('YYYYMMDD');
  const formatDateFromAPI = (dateStr) => dayjs(dateStr, 'YYYYMMDD').format('YYYY-MM-DD');

  // 获取操作类型状态（用于日历颜色）
  const getDateType = (records) => {
    if (!records || records.length === 0) return null;
    const hasBuy = records.some(r => r.opType === 'buy');
    const hasSell = records.some(r => r.opType === 'sell');
    if (hasBuy && hasSell) return 'both';
    if (hasBuy) return 'buy';
    if (hasSell) return 'sell';
    return null;
  };

  // 检查是否存在先卖后买的情况
  const checkSellBeforeBuy = (records) => {
    if (!records || records.length < 2) return false;
    
    // 按时间从小到大排序来检查
    const sortedRecords = [...records].sort((a, b) => (a.opTime || '00:00').localeCompare(b.opTime || '00:00'));
    
    let hasSell = false;
    for (const record of sortedRecords) {
      if (record.opType === 'sell') {
        hasSell = true;
      } else if (record.opType === 'buy' && hasSell) {
        // 先卖后买
        return true;
      }
    }
    return false;
  };

  // 计算某个月有多少天有买入操作
  const getMonthlyBuyDays = (targetDate, records) => {
    const targetMonth = dayjs(targetDate).format('YYYY-MM');
    const buyDays = new Set();
    
    Object.keys(records).forEach(dateKey => {
      if (dayjs(dateKey).format('YYYY-MM') === targetMonth) {
        const dayRecords = records[dateKey];
        if (dayRecords && dayRecords.some(r => r.opType === 'buy')) {
          buyDays.add(dateKey);
        }
      }
    });
    
    return buyDays.size;
  };

  // 检查新增买入操作是否会超过月度5天限制
  const checkMonthlyBuyLimit = (targetDate, currentRecords, newRecord, existingRecords) => {
    // 如果不是买入操作，不检查
    if (newRecord.opType !== 'buy') return false;
    
    // 检查当前日期是否已有买入记录
    const currentDateHasBuy = currentRecords.some(r => r.opType === 'buy');
    
    // 如果当前日期已有买入记录，新增不会增加天数
    if (currentDateHasBuy) return false;
    
    // 计算当前月已有的买入天数（不含当前日期的新增）
    const currentBuyDays = getMonthlyBuyDays(targetDate, existingRecords);
    
    // 如果当前日期之前没有买入记录，且新增买入，检查是否超过5天
    return currentBuyDays >= 5;
  };

  // 初始化数据请求
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const response = await axios.get(`http://${local_ip}:3000/get_op_record`);
        // 将接口数据转换为本地结构
        const recordsMap = {};
        if (Array.isArray(response.data)) {
          response.data.forEach(item => {
            const formattedDate = formatDateFromAPI(item.date);
            recordsMap[formattedDate] = item.recordList || [];
          });
        }
        setOperationRecords(recordsMap);
        
        // 加载当前选中日期的第一条记录
        const todayRecords = recordsMap[selectedDate];
        if (todayRecords && todayRecords.length > 0) {
          loadRecordToForm(todayRecords[0]);
        }
      } catch (error) {
        console.error('获取操作记录失败:', error);
        message.error('获取操作记录失败');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // 日期单元格渲染
  const fullCellRender = (value) => {
    const dateStr = value.format('YYYY-MM-DD');
    const records = operationRecords[dateStr];
    const isSelected = selectedDate === dateStr;
    const dateType = getDateType(records);
    
    let cellClass = 'date-cell-default';
    if (dateType === 'buy') {
      cellClass = 'date-cell-buy';
    } else if (dateType === 'sell') {
      cellClass = 'date-cell-sell';
    } else if (dateType === 'both') {
      cellClass = 'date-cell-both';
    }

    return (
      <div className={`ant-picker-cell-inner ant-picker-calendar-date ${isSelected ? 'ant-picker-calendar-date-selected' : ''}`}>
        <div className={`date-cell-content ${cellClass}`}>
          {value.date()}
        </div>
      </div>
    );
  };

  // 日期选择
  const onSelect = (value) => {
    const dateStr = value.format('YYYY-MM-DD');
    setSelectedDate(dateStr);
    setIsEditing(false);
    setCurrentRecordIndex(0);
    
    const records = operationRecords[dateStr];
    if (records && records.length > 0) {
      loadRecordToForm(records[0]);
    } else {
      form.resetFields();
      form.setFieldsValue({ date: dateStr });
    }
  };

  // 加载记录到表单
  const loadRecordToForm = (record) => {
    if (record) {
      form.setFieldsValue({
        stockName: record.stockName,
        opType: record.opType,
        opTime: record.opTime || dayjs().format('HH:mm'),
        reason: record.reason,
        thought: record.thought
      });
    }
  };

  // 执行保存操作 - 接受数据参数而不依赖状态
  const executeSave = async (saveData) => {
    if (!saveData) return;
    
    try {
      const { values, updatedDateRecords, nextOperationRecords } = saveData;
      
      // 构造全量 API 请求数据并按日期排序，只保留有记录的日期
      const allRecordsForAPI = Object.keys(nextOperationRecords)
        .filter(dateKey => nextOperationRecords[dateKey] && nextOperationRecords[dateKey].length > 0)
        .map(dateKey => ({
          date: formatDateToAPI(dateKey),
          recordList: nextOperationRecords[dateKey]
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const requestData = {
        record: allRecordsForAPI
      };

      // 调用API
      await axios.post(`http://${local_ip}:3000/update_op_record`, requestData);

      // 更新本地状态，只保留有记录的日期
      const cleanedRecords = {};
      Object.keys(nextOperationRecords).forEach(dateKey => {
        if (nextOperationRecords[dateKey] && nextOperationRecords[dateKey].length > 0) {
          cleanedRecords[dateKey] = nextOperationRecords[dateKey];
        }
      });
      setOperationRecords(cleanedRecords);

      setIsEditing(false);
      setConfirmModalVisible(false);
      setPendingSaveData(null);
      message.success('保存成功！');
    } catch (error) {
      message.error('保存失败：' + (error.message || '未知错误'));
    }
  };

  // 保存操作记录
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const currentDateRecords = [...(operationRecords[selectedDate] || [])];
      
      // 更新或添加当前编辑的记录
      const updatedDateRecords = [...currentDateRecords];
      if (currentRecordIndex < updatedDateRecords.length) {
        updatedDateRecords[currentRecordIndex] = { ...values };
      } else {
        updatedDateRecords.push({ ...values });
      }

      // 准备更新后的全量本地数据
      const nextOperationRecords = {
        ...operationRecords,
        [selectedDate]: updatedDateRecords
      };

      const saveData = { values, updatedDateRecords, nextOperationRecords };

      // 检查各种违规情况
      const hasSellBeforeBuy = checkSellBeforeBuy(updatedDateRecords);
      const exceedsMonthlyBuyLimit = checkMonthlyBuyLimit(selectedDate, currentDateRecords, values, operationRecords);

      let shouldShowConfirm = false;
      let confirmType = '';
      
      if (hasSellBeforeBuy) {
        shouldShowConfirm = true;
        confirmType = 'sellBeforeBuy';
      } else if (exceedsMonthlyBuyLimit) {
        shouldShowConfirm = true;
        confirmType = 'monthlyBuyLimit';
      }

      if (shouldShowConfirm) {
        // 保存待保存数据，等待用户确认
        setPendingSaveData(saveData);
        setConfirmModalType(confirmType);
        setConfirmModalVisible(true);
      } else {
        // 没有违规，直接保存 - 直接传递数据
        await executeSave(saveData);
      }
    } catch (error) {
      message.error('保存失败：' + (error.message || '未知错误'));
    }
  };

  // 新增记录
  const handleAddRecord = () => {
    const currentDateRecords = operationRecords[selectedDate] || [];
    setCurrentRecordIndex(currentDateRecords.length);
    form.resetFields();
    form.setFieldsValue({ opTime: dayjs().format('HH:mm') });
    setIsEditing(true);
  };

  // 删除记录并同步到后端
  const handleDeleteRecord = async (index) => {
    try {
      const currentDateRecords = [...(operationRecords[selectedDate] || [])];
      currentDateRecords.splice(index, 1);
      
      // 构建下一个状态的 records
      const nextOperationRecords = {
        ...operationRecords,
        [selectedDate]: currentDateRecords
      };

      // 构造全量 API 请求数据进行同步，只保留有记录的日期
      const allRecordsForAPI = Object.keys(nextOperationRecords)
        .filter(dateKey => nextOperationRecords[dateKey] && nextOperationRecords[dateKey].length > 0)
        .map(dateKey => ({
          date: formatDateToAPI(dateKey),
          recordList: nextOperationRecords[dateKey]
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      await axios.post(`http://${local_ip}:3000/update_op_record`, { record: allRecordsForAPI });

      // 更新本地数据，只保留有记录的日期
      const cleanedRecords = {};
      Object.keys(nextOperationRecords).forEach(dateKey => {
        if (nextOperationRecords[dateKey] && nextOperationRecords[dateKey].length > 0) {
          cleanedRecords[dateKey] = nextOperationRecords[dateKey];
        }
      });
      setOperationRecords(cleanedRecords);

      // 如果删除了当前正在编辑的记录，切换到第一条或清空
      if (index === currentRecordIndex) {
        if (currentDateRecords.length > 0) {
          setCurrentRecordIndex(0);
          loadRecordToForm(currentDateRecords[0]);
        } else {
          setCurrentRecordIndex(0);
          form.resetFields();
        }
      } else if (index < currentRecordIndex) {
        setCurrentRecordIndex(prev => prev - 1);
      }
      
      message.success('删除并同步成功');
    } catch (error) {
      message.error('删除同步失败');
    }
  };

  // 选择记录进行编辑
  const handleSelectRecord = (index) => {
    const records = operationRecords[selectedDate] || [];
    setCurrentRecordIndex(index);
    loadRecordToForm(records[index]);
    setIsEditing(false);
  };

  // 开始编辑
  const startEdit = () => {
    setIsEditing(true);
  };

  // 直接使用后端返回的原始记录顺序
  const currentDateRecords = operationRecords[selectedDate] || [];

  // 计算当前月的买入天数和剩余机会
  const monthlyBuyStats = useMemo(() => {
    const buyDays = getMonthlyBuyDays(selectedDate, operationRecords);
    const remainingDays = Math.max(0, 5 - buyDays);
    return { buyDays, remainingDays };
  }, [selectedDate, operationRecords]);

  return (
    <ConfigProvider locale={zhCN}>
      <div className="operation-record-wrapper">
        <div className="operation-content">
          <div className="calendar-section">
            <Card title={<><FileTextOutlined /> 操作日历</>} variant="borderless">
              {loading ? (
                <div style={{ textAlign: 'center', padding: '40px' }}>加载中...</div>
              ) : (
                <Calendar
                  fullscreen={false}
                  onSelect={onSelect}
                  fullCellRender={fullCellRender}
                  defaultValue={dayjs()}
                />
              )}
            </Card>
          </div>
          
          <div className="detail-section">
            <Card 
              title={`操作记录 - ${selectedDate}`} 
              variant="borderless"
              extra={
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={handleAddRecord}>
                    新增记录
                  </Button>
                  {!isEditing && currentDateRecords.length > 0 && (
                    <Button type="primary" icon={<EditOutlined />} onClick={startEdit}>
                      编辑
                    </Button>
                  )}
                  {isEditing && (
                    <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>
                      保存
                    </Button>
                  )}
                </Space>
              }
            >
              {/* 常驻提示文案 */}
              <Alert
                message={`你当前已经执行了 ${monthlyBuyStats.buyDays} 天买入操作，还剩下 ${monthlyBuyStats.remainingDays} 次买入机会，请珍惜交易机会，找准时机再出手！`}
                type={monthlyBuyStats.remainingDays <= 1 ? 'warning' : 'info'}
                showIcon
                style={{ marginBottom: 16 }}
              />
              
              {/* 记录列表 */}
              {currentDateRecords.length > 0 && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <Text strong>今日记录列表：</Text>
                  </div>
                  <DragDropContext onDragEnd={() => {}}>
                    <Droppable droppableId="records-list">
                      {(provided) => (
                        <div {...provided.droppableProps} ref={provided.innerRef}>
                          <List
                            size="small"
                            dataSource={currentDateRecords}
                            renderItem={(item, index) => (
                              <Draggable key={`${index}-${item.stockName}`} draggableId={`item-${index}`} index={index} isDragDisabled={true}>
                                {(provided) => (
                                  <div
                                    ref={provided.innerRef}
                                    {...provided.draggableProps}
                                    style={{
                                      ...provided.draggableProps.style,
                                      marginBottom: 4
                                    }}
                                  >
                                    <List.Item
                                      style={{
                                        background: index === currentRecordIndex ? '#e6f7ff' : 'transparent',
                                        border: index === currentRecordIndex ? '1px solid #1890ff' : '1px solid #f0f0f0',
                                        borderRadius: 4,
                                        cursor: 'pointer',
                                        padding: '8px 12px'
                                      }}
                                      onClick={() => handleSelectRecord(index)}
                                      actions={[
                                        <DeleteOutlined 
                                          key="delete" 
                                          style={{ color: '#ff4d4f' }}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteRecord(index);
                                          }}
                                        />
                                      ]}
                                    >
                                      <List.Item.Meta
                                        title={
                                          <Space>
                                            <Text type="secondary" style={{ fontSize: '12px' }}>[{item.opTime || '--:--'}]</Text>
                                            <Tag color={item.opType === 'buy' ? 'green' : 'red'}>
                                              {item.opType === 'buy' ? '买入' : '卖出'}
                                            </Tag>
                                            <Text strong>{item.stockName}</Text>
                                          </Space>
                                        }
                                      />
                                    </List.Item>
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
                  <Divider style={{ margin: '16px 0' }} />
                </>
              )}

              {/* 记录表单 */}
              <Form
                form={form}
                layout="vertical"
                disabled={!isEditing}
              >
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item
                      label="股票名称"
                      name="stockName"
                      rules={[{ required: true, message: '请输入股票名称' }]}
                    >
                      <Input placeholder="请输入股票名称" />
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item
                      label="操作类型"
                      name="opType"
                      rules={[{ required: true, message: '请选择操作类型' }]}
                    >
                      <Select placeholder="请选择操作类型">
                        <Option value="buy">买入</Option>
                        <Option value="sell">卖出</Option>
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Form.Item
                      label="操作时间"
                      name="opTime"
                      rules={[{ required: true, message: '格式 HH:mm' }]}
                    >
                      <Input placeholder="HH:mm" />
                    </Form.Item>
                  </Col>
                </Row>

                <Form.Item
                  label="操作理由"
                  name="reason"
                  rules={[{ required: true, message: '请输入操作理由' }]}
                >
                  <TextArea 
                    rows={4} 
                    placeholder="请输入操作理由"
                  />
                </Form.Item>

                <Form.Item
                  label="反思：是否有更好的操作空间"
                  name="thought"
                >
                  <TextArea 
                    rows={6} 
                    placeholder="请输入反思内容，思考是否有更好的操作空间"
                  />
                </Form.Item>
              </Form>
            </Card>
          </div>
        </div>

        {/* 二次确认弹窗 */}
        <Modal
          title="⚠️ 交易纪律预警"
          open={confirmModalVisible}
          onOk={() => executeSave(pendingSaveData)}
          onCancel={() => {
            setConfirmModalVisible(false);
            setPendingSaveData(null);
          }}
          okText="确认继续"
          cancelText="取消"
          width={600}
        >
          {confirmModalType === 'sellBeforeBuy' ? (
            <>
              <div style={{ marginBottom: 16 }}>
                <Text strong style={{ color: '#ff4d4f' }}>
                  当前正在违反交易纪律红线，执行先卖后买操作，请确认是否符合以下情况，如果不符合请禁止操作。
                </Text>
              </div>
              <div style={{ background: '#fff7e6', padding: '16px', borderRadius: '4px', border: '1px solid #ffd591' }}>
                <div style={{ marginBottom: 12, fontWeight: 'bold' }}>
                  1. 开盘大盘情绪低落，但是盘中突然开始放量拉升 & 主力资金大幅度流入，市场情绪在盘中出现了弱转强
                </div>
                <div style={{ fontWeight: 'bold' }}>
                  2. 市场情绪连续冰点，次日大概率情绪反弹，在14:55 分左右拿先手博弈次日反弹
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <Text strong style={{ color: '#ff4d4f' }}>
                  一月内交易纪律是最多只有 5 个交易日可以执行买入操作，你当前已经违反了交易纪律红线，请确认是否要继续？
                </Text>
              </div>
            </>
          )}
        </Modal>
      </div>
    </ConfigProvider>
  );
};

export default OperationRecord;
