import { Modal } from 'antd';
import { LineChartOutlined } from '@ant-design/icons';
import { getThemeColor } from '../../../../utils/theme';
import IndexOverlayTline from '../../../../components/IndexOverlayTline';
import './index.scss';

const IndexOverlayFullscreenModal = ({ open, onCancel, themeColor }) => (
    <Modal
        title={
            <span>
                <LineChartOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />
                指数叠加分时
            </span>
        }
        open={open}
        onCancel={onCancel}
        footer={null}
        width="95vw"
        style={{ top: 20, maxWidth: '100vw', paddingBottom: 0 }}
        bodyStyle={{
            padding: '20px 24px',
            minHeight: 'calc(100vh - 120px)',
            height: 'calc(100vh - 120px)',
            display: 'flex',
            flexDirection: 'column'
        }}
        zIndex={10000}
        destroyOnClose
    >
        {open && (
            <IndexOverlayTline
                embedded={false}
                showCard={false}
            />
        )}
    </Modal>
);

export default IndexOverlayFullscreenModal;
