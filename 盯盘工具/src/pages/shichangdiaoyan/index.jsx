import React, { useState } from 'react';
import { Menu } from 'antd';
import { ClockCircleOutlined, BookOutlined, FileTextOutlined, FileSearchOutlined } from '@ant-design/icons';
import TimelineModule from './modules/TimelineModule';
import MainProblemModule from './modules/MainProblemModule';
import SuggestionModule from './modules/SuggestionModule';
import ResearchReportModule from './modules/ResearchReportModule';
import './index.scss';

const ShiChangDiaoYan = () => {
  const [currentModule, setCurrentModule] = useState('researchReport');

  const menuItems = [
    {
      key: 'researchReport',
      icon: <FileSearchOutlined />,
      label: '近期研报',
    },
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
    }
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
      <div className="diaoyan-header">
        <Menu
          mode="horizontal"
          selectedKeys={[currentModule]}
          items={menuItems}
          onClick={({ key }) => setCurrentModule(key)}
          className="header-menu"
        />
      </div>
      <div className="diaoyan-content">
        {renderModule()}
      </div>
    </div>
  );
};

export default ShiChangDiaoYan;
