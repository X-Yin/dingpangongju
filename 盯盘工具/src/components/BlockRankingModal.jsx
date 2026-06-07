import React, { useState, useRef } from 'react';
import { Modal, Typography, List, Tag } from 'antd';
import { Bar, getElementsAtEvent } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend } from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

const { Text } = Typography;

const BlockRankingModal = ({ visible, onCancel, blocks }) => {
  const [selectedBlock, setSelectedBlock] = useState(null);
  const chartRef = useRef(null);
  // Sort blocks by avgChange from low to high
  const sortedBlocks = [...blocks].sort((a, b) => a.avgChange - b.avgChange);

  const chartData = {
    labels: sortedBlocks.map(block => block.blockName),
    datasets: [
      {
        label: '板块涨跌幅',
        data: sortedBlocks.map(block => block.avgChange),
        backgroundColor: sortedBlocks.map(block => {
          if (block.avgChange > 0) return 'rgba(207, 19, 34, 0.6)'; // Red for up
          if (block.avgChange < 0) return 'rgba(56, 158, 13, 0.6)'; // Green for down
          return 'rgba(89, 89, 89, 0.6)'; // Gray for neutral
        }),
        borderColor: sortedBlocks.map(block => {
          if (block.avgChange > 0) return 'rgba(207, 19, 34, 1)';
          if (block.avgChange < 0) return 'rgba(56, 158, 13, 1)';
          return 'rgba(89, 89, 89, 1)';
        }),
        borderWidth: 1,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: '板块涨跌幅排名 (从低到高)',
      },
    },
    scales: {
      x: {
        beginAtZero: true,
        title: {
          display: true,
          text: '板块名称',
        },
      },
      y: {
        title: {
          display: true,
          text: '涨跌幅 (%)',
        },
      },
    },
  };

  return (
    <Modal
      title="板块涨跌幅排名"
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={1000}
    >
      {blocks && blocks.length > 0 ? (
        <div style={{ height: '500px', minHeight: '500px', marginBottom: '40px' }}>
          <Bar ref={chartRef} data={chartData} options={chartOptions} onClick={(event) => {
            const chart = chartRef.current;
            if (!chart) return;
            const elements = getElementsAtEvent(chart, event);
            if (elements.length > 0) {
              const clickedElementIndex = elements[0].index;
              const blockName = chartData.labels[clickedElementIndex];
              const block = blocks.find(b => b.blockName === blockName);
              if (block) {
                const sortedStocks = [...block.data].sort((a, b) => b.change - a.change);
                setSelectedBlock({ ...block, data: sortedStocks });
              }
            }
          }} />
        </div>
      ) : (
        <Text type="secondary">暂无数据</Text>
      )}

      {selectedBlock && (
        <div>
          <Typography.Title level={5} style={{ marginTop: '20px' }}>{selectedBlock.blockName} 成分股</Typography.Title>
          <List
            size="small"
            bordered
            dataSource={selectedBlock.data}
            renderItem={item => (
              <List.Item>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                  <span>{item.name}</span>
                  <Tag color={item.change > 0 ? 'red' : item.change < 0 ? 'green' : 'default'}>
                    {item.change > 0 ? '+' : ''}{item.change}%
                  </Tag>
                </div>
              </List.Item>
            )}
          />
        </div>
      )}
    </Modal>
  );
};

export default BlockRankingModal;