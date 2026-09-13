import { Modal, Input, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import './index.scss';

const { Text } = Typography;

const RenameStockModal = ({ open, onCancel, onOk, renameStockCode, renameStockName, setRenameStockName, themeColor }) => (
    <Modal
        title={<span><EditOutlined style={{ color: 'var(--ios-blue)', marginRight: '8px' }} />重命名股票</span>}
        open={open}
        onCancel={onCancel}
        onOk={onOk}
        width={400}
        centered
        className="add-stock-modal"
    >
        <div style={{ marginBottom: 16 }}>
            <Text type="secondary" style={{ fontSize: '13px' }}>股票代码</Text>
            <div style={{ marginTop: 4, fontSize: '14px', fontWeight: 500 }}>{renameStockCode}</div>
        </div>
        <Input
            placeholder="请输入新的股票名称"
            value={renameStockName}
            onChange={(e) => setRenameStockName(e.target.value)}
            style={{ marginTop: 8 }}
            autoFocus
        />
    </Modal>
);

export default RenameStockModal;
