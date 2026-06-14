import { useState } from 'react';
import { Layout, Menu, Button, Modal, Carousel } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { DesktopOutlined, AppstoreOutlined, MenuFoldOutlined, MenuUnfoldOutlined, BookOutlined, CoffeeOutlined, ThunderboltOutlined, AreaChartOutlined, FileTextOutlined } from '@ant-design/icons';
import PreMarketReading from './components/PreMarketReading';
import OperationRecord from './components/OperationRecord';
import './App.scss';

const { Sider, Content, Header } = Layout;

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [preMarketVisible, setPreMarketVisible] = useState(false);
  const [operationRecordVisible, setOperationRecordVisible] = useState(false);

  const menuItems = [
    {
      key: '/dingpan',
      icon: <DesktopOutlined />,
      label: '盯盘',
    },
    {
      key: '/volume',
      icon: <AreaChartOutlined />,
      label: '成交量统计',
    },
    {
      key: '/block',
      icon: <AppstoreOutlined />,
      label: '重点板块',
    },
    {
      key: '/sentiment',
      icon: <CoffeeOutlined />,
      label: '情绪复盘',
    },
    {
      key: '/shichangdiaoyan',
      icon: <BookOutlined />,
      label: '市场调研',
    },
  ];

  return (
    <Layout className="app-layout">
      <Sider 
        theme="light" 
        className="app-sider" 
        width={200} 
        trigger={null} 
        collapsible 
        collapsed={collapsed}
      >
        <div className="logo">
          <span role="img" aria-label="chart">📈</span>
          {!collapsed && " 盯盘助手"}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          className="app-menu"
        />
      </Sider>
      <Layout className="content-layout">
        <Header className="app-header">
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            className="collapse-btn"
          />
          <div className="header-reminder">
            <span className="reminder-icon">⚠️</span>
            <div className="reminder-carousel-container">
              <Carousel 
                dotPosition="left" 
                dots={false} 
                autoplay 
                autoplaySpeed={5000}
                effect="scrollx"
                vertical
              >
                <div className="reminder-item">
                  <span className="reminder-text">只做顺周期，不做逆周期</span>
                </div>
                <div className="reminder-item">
                  <span className="reminder-text">一个星期只有一次全仓出手的机会！宁可踏空，绝对不能冲高回落被套住！！！</span>
                </div>
                <div className="reminder-item">
                  <span className="reminder-text">善战者，求之于势，不责于人。要看整体大势，不要被个股的涨幅所迷惑！</span>
                </div>
                <div className="reminder-item">
                  <span className="reminder-text">能赚到钱不算本事，能躲开市场抽风那一下子才是本事！</span>
                </div>
              </Carousel>
            </div>
            <span className="reminder-icon">⚠️</span>
          </div>
          <div className="header-right-actions">
            <Button
              type="primary"
              icon={<BookOutlined />}
              onClick={() => setPreMarketVisible(true)}
              className="pre-market-btn"
            >
              盘前必读
            </Button>
            <Button
              type="primary"
              icon={<FileTextOutlined />}
              onClick={() => setOperationRecordVisible(true)}
              className="operation-record-btn"
              style={{ marginLeft: 8 }}
            >
              操作记录
            </Button>
          </div>
        </Header>
        <Content className="app-content">
          <div className="content-inner">
            <Outlet />
          </div>
        </Content>
      </Layout>

      <Modal
        title={<span><BookOutlined style={{ color: '#1890ff', marginRight: '8px' }} />盘前必读精华</span>}
        open={preMarketVisible}
        onCancel={() => setPreMarketVisible(false)}
        footer={null}
        width={1200}
        centered
        className="pre-market-modal"
      >
        <PreMarketReading />
      </Modal>
      <Modal
        title={<span><FileTextOutlined style={{ color: '#1890ff', marginRight: '8px' }} />操作记录</span>}
        open={operationRecordVisible}
        onCancel={() => setOperationRecordVisible(false)}
        footer={null}
        width={1200}
        centered
        bodyStyle={{
          maxHeight: '800px',
          overflowY: 'auto'
        }}
      >
        <OperationRecord />
      </Modal>
    </Layout>
  );
}

export default App;
