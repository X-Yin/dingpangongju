import React, { useState } from 'react';
import { Menu } from 'antd';
import { ClockCircleOutlined, BookOutlined, FileTextOutlined, FileSearchOutlined } from '@ant-design/icons';
import TimelineModule from './modules/TimelineModule';
import MainProblemModule from './modules/MainProblemModule';
import SuggestionModule from './modules/SuggestionModule';
import ResearchReportModule from './modules/ResearchReportModule';

const ShiChangDiaoYan = () => {
  const [currentModule, setCurrentModule] = useState('timeline');

  const menuItems = [
    {
      key: 'timeline',
      icon: <ClockCircleOutlined />,
      label: '时间线',
    },
    {
      key: 'mainProblem',
      icon: <BookOutlined />,
      label: '消息面',
    },
    {
      key: 'suggestion',
      icon: <FileTextOutlined />,
      label: '个人观点',
    },
    {
      key: 'researchReport',
      icon: <FileSearchOutlined />,
      label: '近期研报',
    },
  ];

  const renderModule = () => {
    switch (currentModule) {
      case 'timeline':
        return <TimelineModule />;
      case 'mainProblem':
        return <MainProblemModule />;
      case 'suggestion':
        return <SuggestionModule />;
      case 'researchReport':
        return <ResearchReportModule />;
      default:
        return <TimelineModule />;
    }
  };

  return (
    <div className="shichangdiaoyan-container">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Menu
          mode="horizontal"
          selectedKeys={[currentModule]}
          items={menuItems}
          onClick={({ key }) => setCurrentModule(key)}
          style={{ marginBottom: 16 }}
        />
        <div style={{ flexGrow: 1 }}>
          {renderModule()}
        </div>
      </div>
    </div>
  );
};

export default ShiChangDiaoYan;
