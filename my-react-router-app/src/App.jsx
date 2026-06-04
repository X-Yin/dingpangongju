import { useState } from 'react';
import { Layout, Menu, Button, Modal, Carousel } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { DesktopOutlined, AppstoreOutlined, MenuFoldOutlined, MenuUnfoldOutlined, BookOutlined, CoffeeOutlined, ThunderboltOutlined, AreaChartOutlined } from '@ant-design/icons';
import PreMarketReading from './components/PreMarketReading';
import './App.scss';

const { Sider, Content, Header } = Layout;

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [preMarketVisible, setPreMarketVisible] = useState(false);

  const menuItems = [
    {
      key: '/dingpan',
      icon: <DesktopOutlined />,
      label: '盯盘',
    },
    {
      key: '/jingjia',
      icon: <ThunderboltOutlined />,
      label: '竞价抢筹',
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
      key: '/volume',
      icon: <AreaChartOutlined />,
      label: '成交量统计',
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
                  <span className="reminder-text">能赚到钱不算本事，能躲开市场抽风那一下子才是本事！</span>
                </div>
                <div className="reminder-item">
                  <span className="reminder-text">大道甚夷，而民好径。确保政治正确，程序正确。在过程上下功夫，不追求结果！</span>
                </div>
                <div className="reminder-item">
                  <span className="reminder-text">赚钱的秘诀并不在于预测，而在于应对。不要提前预设市场会怎么样，而是开盘之后你看见它怎么样，你就怎么样</span>
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
    </Layout>
  );
}

export default App;
