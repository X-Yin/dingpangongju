import React, { useState } from 'react';
import { Menu, Input } from 'antd';
import { ClockCircleOutlined, BookOutlined, FileTextOutlined, FileSearchOutlined, SearchOutlined } from '@ant-design/icons';
import TimelineModule from './modules/TimelineModule';
import MainProblemModule from './modules/MainProblemModule';
import SuggestionModule from './modules/SuggestionModule';
import ResearchReportModule from './modules/ResearchReportModule';

const ShiChangDiaoYan = () => {
  const [currentModule, setCurrentModule] = useState('timeline');
  const [searchKeyword, setSearchKeyword] = useState('');

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

  const filteredMenuItems = menuItems.filter(item => 
    item.label.toLowerCase().includes(searchKeyword.toLowerCase())
  );

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
        <Input
          placeholder="搜索菜单..."
          prefix={<SearchOutlined />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          allowClear
          style={{ marginBottom: 16 }}
        />
        <Menu
          mode="horizontal"
          selectedKeys={[currentModule]}
          items={filteredMenuItems}
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
