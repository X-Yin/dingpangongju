import { Modal, Typography, Table, Tag, Space } from 'antd';
import { useMemo } from 'react';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

const getStatusTag = (rankChange, changeDiff) => {
  if (rankChange < -5 || (rankChange < -3 && changeDiff > 3)) {
    return { text: '新晋大涨', color: 'red' };
  }
  if (rankChange > 5 || (rankChange > 3 && changeDiff < -3)) {
    return { text: '熄火掉队', color: 'green' };
  }
  return { text: '稳如泰山', color: 'default' };
};

const formatDate = (dateStr) => {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  return dayjs(dateStr, 'YYYYMMDD').format('MM-DD');
};

const MultiDayCompareModal = ({ visible, onCancel, dayHistoryData }) => {
  const threeDayData = useMemo(() => {
    if (!Array.isArray(dayHistoryData) || dayHistoryData.length < 2) {
      return null;
    }

    const result = [];
    const validDays = dayHistoryData.filter(d => d.date && d.blocks);
    
    for (let i = 0; i < Math.min(3, validDays.length); i++) {
      const day = validDays[i];
      let blocksArray = [];
      
      if (Array.isArray(day.blocks)) {
        blocksArray = day.blocks.map(b => ({
          blockName: b.blockName,
          avgChange: b.avgChange
        }));
      } else {
        blocksArray = Object.entries(day.blocks).map(([blockName, data]) => ({
          blockName,
          avgChange: data.avgChange
        }));
      }

      const sortedBlocks = [...blocksArray].sort((a, b) => b.avgChange - a.avgChange);
      
      result.push({
        date: day.date,
        blocks: sortedBlocks.map((block, index) => ({
          ...block,
          rank: index + 1
        }))
      });
    }

    return result;
  }, [dayHistoryData]);

  const compareData = useMemo(() => {
    if (!threeDayData || threeDayData.length < 2) {
      return [];
    }

    const today = threeDayData[0];
    const yesterday = threeDayData[1];
    const dayBeforeYesterday = threeDayData[2];

    const yesterdayRankMap = {};
    const yesterdayChangeMap = {};
    yesterday.blocks.forEach(b => {
      yesterdayRankMap[b.blockName] = b.rank;
      yesterdayChangeMap[b.blockName] = b.avgChange;
    });

    const dayBeforeRankMap = {};
    const dayBeforeChangeMap = {};
    if (dayBeforeYesterday) {
      dayBeforeYesterday.blocks.forEach(b => {
        dayBeforeRankMap[b.blockName] = b.rank;
        dayBeforeChangeMap[b.blockName] = b.avgChange;
      });
    }

    return today.blocks.map(block => {
      const yesterdayRank = yesterdayRankMap[block.blockName];
      const yesterdayChange = yesterdayChangeMap[block.blockName];
      const dayBeforeRank = dayBeforeRankMap[block.blockName];
      const dayBeforeChange = dayBeforeChangeMap[block.blockName];

      const rankChange = yesterdayRank ? block.rank - yesterdayRank : null;
      const changeDiff = yesterdayChange !== undefined ? block.avgChange - yesterdayChange : null;
      
      const status = changeDiff !== null && rankChange !== null 
        ? getStatusTag(rankChange, changeDiff) 
        : { text: '稳如泰山', color: 'default' };

      return {
        key: block.blockName,
        rank: block.rank,
        blockName: block.blockName,
        todayChange: block.avgChange,
        yesterdayRank: yesterdayRank || '-',
        yesterdayChange: yesterdayChange !== undefined ? yesterdayChange : '-',
        dayBeforeRank: dayBeforeRank || '-',
        dayBeforeChange: dayBeforeChange !== undefined ? dayBeforeChange : '-',
        rankChange: rankChange !== null ? (rankChange > 0 ? `↓${rankChange}` : rankChange < 0 ? `↑${Math.abs(rankChange)}` : '-') : '-',
        changeDiff: changeDiff !== null ? (changeDiff > 0 ? `+${changeDiff.toFixed(2)}%` : changeDiff.toFixed(2) + '%') : '-',
        status
      };
    });
  }, [threeDayData]);

  const columns = [
    {
      title: '排名',
      dataIndex: 'rank',
      key: 'rank',
      width: 60,
      align: 'center',
      render: (rank) => <Text strong>{rank}</Text>
    },
    {
      title: '板块名称',
      dataIndex: 'blockName',
      key: 'blockName',
      width: 120
    },
    {
      title: '今日涨幅',
      dataIndex: 'todayChange',
      key: 'todayChange',
      width: 100,
      align: 'center',
      render: (change) => (
        <Text strong style={{ color: change > 0 ? '#cf1322' : change < 0 ? '#389e0d' : '#595959' }}>
          {change > 0 ? '+' : ''}{change}%
        </Text>
      )
    },
        {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      align: 'center',
      render: (status) => (
        <Tag color={status.color}>
          {status.text}
        </Tag>
      )
    },
    {
      title: '昨日排名',
      dataIndex: 'yesterdayRank',
      key: 'yesterdayRank',
      width: 80,
      align: 'center'
    },
    {
      title: '昨日涨幅',
      dataIndex: 'yesterdayChange',
      key: 'yesterdayChange',
      width: 100,
      align: 'center',
      render: (change) => {
        if (change === '-') return '-';
        return (
          <Text style={{ color: change > 0 ? '#cf1322' : change < 0 ? '#389e0d' : '#595959' }}>
            {change > 0 ? '+' : ''}{change}%
          </Text>
        );
      }
    },
    {
      title: '前日排名',
      dataIndex: 'dayBeforeRank',
      key: 'dayBeforeRank',
      width: 80,
      align: 'center'
    },
    {
      title: '前日涨幅',
      dataIndex: 'dayBeforeChange',
      key: 'dayBeforeChange',
      width: 100,
      align: 'center',
      render: (change) => {
        if (change === '-') return '-';
        return (
          <Text style={{ color: change > 0 ? '#cf1322' : change < 0 ? '#389e0d' : '#595959' }}>
            {change > 0 ? '+' : ''}{change}%
          </Text>
        );
      }
    },
    {
      title: '排名变化',
      dataIndex: 'rankChange',
      key: 'rankChange',
      width: 100,
      align: 'center',
      render: (text) => (
        <Text style={{ color: text.includes('↑') ? '#cf1322' : text.includes('↓') ? '#389e0d' : '#595959' }}>
          {text}
        </Text>
      )
    },
    {
      title: '涨幅变化',
      dataIndex: 'changeDiff',
      key: 'changeDiff',
      width: 100,
      align: 'center',
      render: (text) => (
        <Text style={{ color: text.startsWith('+') ? '#cf1322' : text.startsWith('-') ? '#389e0d' : '#595959' }}>
          {text}
        </Text>
      )
    }
  ];

  return (
    <Modal
      title="板块多天对比"
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={1200}
    >
      {!threeDayData ? (
        <Text type="secondary">暂无足够的历史数据</Text>
      ) : (
        <>
          <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
            <Title level={5} style={{ margin: 0 }}>最近三天板块对比</Title>
            <Space size="large">
              {threeDayData.map((day, index) => (
                <Tag key={day.date} color={index === 0 ? 'blue' : 'default'}>
                  {index === 0 ? '今日' : index === 1 ? '昨日' : '前日'}: {formatDate(day.date)}
                </Tag>
              ))}
            </Space>
          </div>
          
          <div style={{ marginBottom: '16px', padding: '8px 12px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
            <Space>
              <Tag color="red">新晋大涨</Tag>
              <Text type="secondary">排名上涨超过5名，或排名上涨超过3名且涨幅相较上一日超过3%</Text>
            </Space>
            <Space style={{ marginLeft: '24px' }}>
              <Tag color="green">熄火掉队</Tag>
              <Text type="secondary">排名下降超过5名，或排名下降超过3名且涨幅相较上一日下降超过3%</Text>
            </Space>
            <Space style={{ marginLeft: '24px' }}>
              <Tag color="default">稳如泰山</Tag>
              <Text type="secondary">其他情况</Text>
            </Space>
          </div>

          <Table
            dataSource={compareData}
            columns={columns}
            pagination={false}
            scroll={{ y: 500 }}
            size="middle"
          />
        </>
      )}
    </Modal>
  );
};

export default MultiDayCompareModal;