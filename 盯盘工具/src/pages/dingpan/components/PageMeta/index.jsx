import { Tooltip } from 'antd';
import { ClockCircleOutlined, BgColorsOutlined } from '@ant-design/icons';
import './index.scss';

const PageMeta = ({ lastUpdated, onOpenThemeColor }) => (
    <div className="page-meta">
        <div className="title-block">
            <div className="title-row">
                <h1>实时监控面板</h1>
                <Tooltip title="DIY 主题色">
                    <BgColorsOutlined
                        className="theme-color-icon"
                        onClick={onOpenThemeColor}
                    />
                </Tooltip>
            </div>
            <div className="update-time">
                <ClockCircleOutlined /> 最后更新: {lastUpdated}
            </div>
        </div>
    </div>
);

export default PageMeta;
