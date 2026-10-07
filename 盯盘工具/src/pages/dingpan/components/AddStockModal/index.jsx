import { Modal, Input, Typography, Tooltip, Button, Switch, message } from 'antd';
import { PlusOutlined, CopyOutlined } from '@ant-design/icons';
import StockSearchInput from '../../../../components/StockSearchInput';
import './index.scss';

const { Text } = Typography;

const AddStockModal = ({
    open,
    onCancel,
    onOk,
    newStockCode,
    setNewStockCode,
    newStockName,
    setNewStockName,
    newStockBlockName,
    setNewStockBlockName,
    newStockRiskScore,
    setNewStockRiskScore,
    newStockIsTech,
    setNewStockIsTech,
    themeColor,
}) => (
    <Modal
        title={<span><PlusOutlined style={{ marginRight: '8px' }} />新增监控股票</span>}
        open={open}
        onCancel={onCancel}
        onOk={onOk}
        okButtonProps={{ disabled: !newStockCode }} // 未从搜索下拉选定股票（无 code）时不允许提交
        width={400}
        centered
        className="add-stock-modal"
    >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
                <Text type="secondary" style={{ fontSize: '13px' }}>股票名称 (输入后按回车搜索)</Text>
                <StockSearchInput
                    value={newStockName}
                    code={newStockCode}
                    onChange={(name, code) => {
                        setNewStockName(name);
                        setNewStockCode(code);
                    }}
                    style={{ marginTop: 8 }}
                    autoFocus
                />
            </div>
            <div>
                <Text type="secondary" style={{ fontSize: '13px' }}>所属板块 (选填)</Text>
                <Input
                    placeholder="如: 半导体 / xxx"
                    value={newStockBlockName}
                    onChange={e => setNewStockBlockName(e.target.value)}
                    style={{ marginTop: 8 }}
                />
            </div>
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Text type="secondary" style={{ fontSize: '13px' }}>风险偏好分数 (选填)</Text>
                    <Tooltip title="复制风险偏好系数定义">
                        <Button
                            type="text"
                            icon={<CopyOutlined style={{ fontSize: '14px' }} />}
                            onClick={() => {
                                const text = `风险偏好系数定义：用半年甚至一年以后的远期叙事来为当下的股票定价是风险偏好高的股票。用该季度或者是下个季度的业绩叙事来为当下的股票定价是风险偏好低的股票，从 1-10 进行打分。${newStockName || '该股票'} 的风险偏好系数是多少。`;
                                navigator.clipboard.writeText(text).then(() => {
                                    message.success('已复制到剪贴板');
                                }).catch(() => {
                                    message.error('复制失败');
                                });
                            }}
                            size="small"
                            style={{ padding: '0 4px', height: '24px' }}
                        />
                    </Tooltip>
                </div>
                <Input
                    placeholder="请输入风险偏好分数"
                    value={newStockRiskScore}
                    onChange={e => setNewStockRiskScore(e.target.value)}
                    style={{ marginTop: 8 }}
                />
            </div>
            <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text type="secondary" style={{ fontSize: '13px' }}>是否为科技股</Text>
                    <Switch
                        checked={newStockIsTech}
                        onChange={setNewStockIsTech}
                        checkedChildren="是"
                        unCheckedChildren="否"
                    />
                </div>
            </div>
        </div>
    </Modal>
);

export default AddStockModal;