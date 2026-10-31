import { Modal, Input, Typography, Tooltip, Button, Switch, message } from 'antd';
import { PlusOutlined, EditOutlined, CopyOutlined } from '@ant-design/icons';
import StockSearchInput from '../../../../components/StockSearchInput';
import './index.scss';

const { Text } = Typography;

const AddStockModal = ({
    open,
    onCancel,
    onOk, // 保存并关闭（新增 / 编辑）
    onContinue, // 继续添加：保存当前股票后保留弹窗，便于连续添加多只（仅新增模式）
    addLoading,
    mode = 'add', // 'add' 新增 / 'edit' 编辑（编辑时预填原内容，隐藏「继续添加」）
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
    watchMarketCap,
    setWatchMarketCap,
    watchPE,
    setWatchPE,
    themeColor,
}) => {
    const isEdit = mode === 'edit';
    const footer = [
        <Button key="cancel" onClick={onCancel}>关闭</Button>,
    ];
    if (!isEdit) {
        footer.push(
            <Button
                key="continue"
                type="primary"
                ghost
                disabled={!newStockCode} // 未从搜索下拉选定股票（无 code）时不允许提交
                loading={addLoading}
                onClick={onContinue}
            >
                继续添加
            </Button>
        );
    }
    footer.push(
        <Button
            key="ok"
            type="primary"
            disabled={!newStockCode} // 未从搜索下拉选定股票（无 code）时不允许提交
            loading={addLoading}
            onClick={onOk}
        >
            {isEdit ? '保存' : '保存并关闭'}
        </Button>
    );

    return (
        <Modal
            title={
                <span>
                    {isEdit
                        ? <EditOutlined style={{ marginRight: '8px' }} />
                        : <PlusOutlined style={{ marginRight: '8px' }} />}
                    {isEdit ? '编辑监控股票' : '新增监控股票'}
                </span>
            }
            open={open}
            onCancel={onCancel}
            width={400}
            centered
            className="add-stock-modal"
            footer={footer}
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
                        autoFocus={!isEdit}
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
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text type="secondary" style={{ fontSize: '13px' }}>是否关注市值</Text>
                        <Switch
                            checked={watchMarketCap}
                            onChange={setWatchMarketCap}
                            checkedChildren="关注"
                            unCheckedChildren="不关注"
                        />
                    </div>
                    <Text type="secondary" style={{ fontSize: '12px' }}>
                        关闭后回测与线上模式不再按流通市值（≥ 200 亿）过滤该股
                    </Text>
                </div>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text type="secondary" style={{ fontSize: '13px' }}>是否关注 PE</Text>
                        <Switch
                            checked={watchPE}
                            onChange={setWatchPE}
                            checkedChildren="关注"
                            unCheckedChildren="不关注"
                        />
                    </div>
                    <Text type="secondary" style={{ fontSize: '12px' }}>
                        关闭后回测与线上模式不再按市盈率亏损过滤该股
                    </Text>
                </div>
            </div>
        </Modal>
    );
};

export default AddStockModal;