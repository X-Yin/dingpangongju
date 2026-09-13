import { useState } from 'react';
import { Tabs } from 'antd';
import { RiseOutlined, ThunderboltOutlined, ExperimentOutlined } from '@ant-design/icons';
import BacktestDiagnosisTab from './BacktestDiagnosisTab';
import RealtimeDiagnosisTab from './RealtimeDiagnosisTab';
import SmartBacktestDiagnosisTab from './SmartBacktestDiagnosisTab';

/**
 * 买卖点诊断主容器
 *
 * 买点逻辑：情绪冰点次日竞价高开 >0%，且分时前 10 分钟内股价一直高于开盘价
 *   - 情绪冰点：前一日科技情绪指数 <-30 或 前两日科技情绪指数连续为负
 * 卖点逻辑：当日抗分歧指数 < 5 或 收盘价跌破 10 日线
 */
const TradePointDiagnosisTab = ({ onStockClick, code, name, codes, names, autoBacktest, days }) => {
  const [activeSubTab, setActiveSubTab] = useState('backtest');

  const tabItems = [
    {
      key: 'backtest',
      label: (
        <span>
          <RiseOutlined style={{ marginRight: 4 }} />
          回测诊断
        </span>
      ),
      children: <BacktestDiagnosisTab onStockClick={onStockClick} preSelectedCode={code} preSelectedName={name} preSelectedCodes={codes} preSelectedNames={names} autoBacktest={autoBacktest === '1'} defaultDays={days} />,
    },
    {
      key: 'realtime',
      label: (
        <span>
          <ThunderboltOutlined style={{ marginRight: 4 }} />
          即时诊断
        </span>
      ),
      children: <RealtimeDiagnosisTab />,
    },
    {
      key: 'smartBacktest',
      label: (
        <span>
          <ExperimentOutlined style={{ marginRight: 4 }} />
          智能回测诊断
        </span>
      ),
      children: <SmartBacktestDiagnosisTab onStockClick={onStockClick} />,
    },
  ];

  return (
    <div className="trade-point-diagnosis-tab">
      <Tabs
        activeKey={activeSubTab}
        onChange={setActiveSubTab}
        items={tabItems}
        size="small"
        className="trade-point-sub-tabs"
      />
    </div>
  );
};

export default TradePointDiagnosisTab;
