import { useState, useEffect, useCallback } from 'react';
import { List, Card, Typography, Spin, Empty, message, Badge, Tag } from 'antd';
import { BookOutlined, SyncOutlined, ClockCircleOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import './index.scss';

const { Title, Text, Paragraph } = Typography;

const JigouReports = () => {
  const [loading, setLoading] = useState(true);
  const [reports, setReports] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchReports = useCallback(async (isAuto = false) => {
    try {
      if (!isAuto) setLoading(true);
      const res = await axios.get(`http://${local_ip}:3000/get_jigou_reports`);
      if (res.data && Array.isArray(res.data.reports)) {
        // 过滤掉标题包含“电话会音频”的项，并去除正文中的 <e xxx> 标签
        const filtered = res.data.reports
          .filter((item) => !item.title?.includes('电话会音频'))
          .map((item) => ({
            ...item,
            text: (item.text || '').replace(/<e\s+[^>]*>/gi, ''),
          }));
        setReports(filtered);
        setLastUpdated(new Date().toLocaleTimeString());
      }
    } catch (error) {
      console.error('获取机构研报失败:', error);
      if (!isAuto) message.error('获取机构研报失败');
    } finally {
      if (!isAuto) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
    const timer = setInterval(() => {
      fetchReports(true);
    }, 30000); // 30s 轮询

    return () => clearInterval(timer);
  }, [fetchReports]);

  return (
    <div className="jigou-reports-page">
      <div className="page-header">
        <div className="header-left">
          <Title level={4}><BookOutlined /> 机构研报</Title>
          {lastUpdated && (
            <Text type="secondary" className="update-time">
              <ClockCircleOutlined /> 最后更新: {lastUpdated}
            </Text>
          )}
        </div>
        <div className="header-right">
          <Tag color="blue" icon={<SyncOutlined spin={loading} />}>
            30s 自动刷新
          </Tag>
        </div>
      </div>

      <Spin spinning={loading}>
        {reports.length === 0 && !loading ? (
          <Empty description="暂无研报数据" />
        ) : (
          <List
            grid={{ gutter: 16, column: 1 }}
            dataSource={reports}
            renderItem={(item, index) => (
              <List.Item>
                <Card 
                  className="report-card"
                  title={
                    <div className="report-title-container">
                      <span className="report-title">{item.title || `研报内容 ${index + 1}`}</span>
                      {item.createTime && (
                        <Text type="secondary" className="report-time-inline">
                          {new Date(item.createTime).toLocaleString()}
                        </Text>
                      )}
                    </div>
                  }
                  extra={<Badge status="processing" text="实时" />}
                >
                  <Paragraph 
                    ellipsis={{ rows: 5, expandable: true, symbol: '展开全文' }}
                    className="report-text"
                  >
                    {item.text}
                  </Paragraph>
                </Card>
              </List.Item>
            )}
          />
        )}
      </Spin>
    </div>
  );
};

export default JigouReports;
