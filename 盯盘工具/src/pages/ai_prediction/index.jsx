import { Card } from 'antd';
import { RobotOutlined, SearchOutlined } from '@ant-design/icons';
import './index.scss';

const AiPrediction = () => {
  return (
    <div className="ai-prediction-page">
      <div className="ai-page-header">
        <div className="header-icon"><RobotOutlined /></div>
        <div className="header-text">
          <div className="header-title">AI 走势预测</div>
          <div className="header-sub">分时预测、K线预测功能已下线，历史探查已迁移至「策略中心」</div>
        </div>
      </div>

      <Card className="ai-empty-state" bordered={false}>
        <div className="empty-icon"><SearchOutlined /></div>
        <div className="empty-title">功能已迁移</div>
        <div className="empty-desc">历史探查功能已移至「策略中心」第三个 Tab，请前往使用</div>
      </Card>
    </div>
  );
};

export default AiPrediction;
