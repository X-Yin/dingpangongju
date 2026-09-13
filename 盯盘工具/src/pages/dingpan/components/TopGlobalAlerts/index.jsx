import { Space, Alert, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import './index.scss';

const { Text } = Typography;

const TopGlobalAlerts = ({ alerts, marketRiskWarning, kaiPanXiaCuoWarning, onCloseAlert, themeColor }) => {
    if (!alerts.length && !marketRiskWarning && !kaiPanXiaCuoWarning) return null;
    // return (
    //     <div className="top-global-alerts" style={{ marginBottom: 12 }}>
    //         <Space direction="vertical" style={{ width: '100%' }} size={8}>
    //             {kaiPanXiaCuoWarning && (
    //                 <Alert
    //                     message={
    //                         <Text>
    //                             <Text strong>🚨 开盘下挫预警</Text>：{kaiPanXiaCuoWarning}
    //                         </Text>
    //                     }
    //                     type="success"
    //                     showIcon
    //                     icon={<WarningOutlined />}
    //                 />
    //             )}
    //             {marketRiskWarning && (
    //                 <Alert
    //                     message={
    //                         <Text>
    //                             <Text strong>🚨 极端风险预警</Text>：{marketRiskWarning}
    //                         </Text>
    //                     }
    //                     type="success"
    //                     showIcon
    //                     icon={<WarningOutlined />}
    //                 />
    //             )}
    //             {alerts.map(alert => (
    //                 <Alert
    //                     key={alert.id}
    //                     message={
    //                         <Text>
    //                             <Text strong>{alert.title}</Text>：{alert.isDefensive ? alert.description : `[${alert.time}] 主力资金${alert.moneyTrend}(${alert.mainMoney > 0 ? '+' : ''}${alert.mainMoney}亿)，成交量变化${alert.amountChangeDiff}亿`}
    //                         </Text>
    //                     }
    //                     type={alert.type}
    //                     showIcon
    //                     closable
    //                     onClose={() => onCloseAlert(alert.id)}
    //                     icon={<WarningOutlined />}
    //                 />
    //             ))}
    //         </Space>
    //     </div>
    // );
    return null;
};

export default TopGlobalAlerts;
