import { Badge, Button, Tooltip } from 'antd';
import { ClockCircleOutlined, HistoryOutlined, BgColorsOutlined } from '@ant-design/icons';
import './index.scss';

const PageMeta = ({ lastUpdated, historyCount, onHistoryClick, onOpenThemeColor }) => (
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
        <Badge count={historyCount} overflowCount={99} size="small" offset={[0, 0]}>
            <Button
                type="primary"
                icon={<HistoryOutlined />}
                onClick={onHistoryClick}
                className="history-btn"
            >
                异动历史记录
            </Button>
        </Badge>
    </div>
);

export default PageMeta;
