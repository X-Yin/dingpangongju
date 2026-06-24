import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Modal, Typography, List, Tag, Button, Space, message } from 'antd';
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
const STORAGE_KEY = 'block-ranking-modal-last-blocks';

const cloneBlocks = (blockList = []) => JSON.parse(JSON.stringify(blockList));

const buildRankMap = (blockList = []) => {
  return [...blockList]
    .sort((a, b) => b.avgChange - a.avgChange)
    .reduce((rankMap, block, index) => {
      rankMap[block.blockName] = index + 1;
      return rankMap;
    }, {});
};

const getRankChangeText = (previousRank, currentRank) => {
  if (!previousRank || !currentRank || previousRank === currentRank) {
    return '';
  }

  if (currentRank < previousRank) {
    return `前进${previousRank - currentRank}名`;
  }

  return `后退${currentRank - previousRank}名`;
};

const getCompactRankChangeText = (rankChangeText) => {
  if (!rankChangeText) {
    return '';
  }

  if (rankChangeText.startsWith('前进')) {
    return `↑${rankChangeText.replace('前进', '').replace('名', '')}`;
  }

  if (rankChangeText.startsWith('后退')) {
    return `↓${rankChangeText.replace('后退', '').replace('名', '')}`;
  }

  return rankChangeText;
};

const getDisplayLabel = (blockName) => {
  const normalizedName = String(blockName || '');
  if (normalizedName.length <= 6) {
    return normalizedName;
  }

  return `${normalizedName.slice(0, 5)}...`;
};

const getStoredBlocks = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error('读取板块涨跌幅回放数据失败:', error);
    return null;
  }
};

const BlockRankingModal = ({ visible, onCancel, blocks, onStockClick }) => {
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [displayBlocks, setDisplayBlocks] = useState(blocks);
  const [lastBlocksSnapshot, setLastBlocksSnapshot] = useState(null);
  const [replaying, setReplaying] = useState(false);
  const chartRef = useRef(null);
  const replayTimerRef = useRef(null);

  const syncDisplayBlocks = useCallback((blockList) => {
    const nextBlocks = blockList || [];
    setDisplayBlocks(nextBlocks);
    setSelectedBlock((prevSelected) => {
      if (!prevSelected) return null;
      const matchedBlock = nextBlocks.find(block => block.blockName === prevSelected.blockName);
      if (!matchedBlock) return null;
      return {
        ...matchedBlock,
        data: [...matchedBlock.data].sort((a, b) => b.change - a.change),
      };
    });
  }, []);

  useEffect(() => {
    if (visible && !replaying) {
      const storedBlocks = getStoredBlocks();
      syncDisplayBlocks(blocks);
      setLastBlocksSnapshot(storedBlocks);
    }
  }, [visible, replaying, blocks, syncDisplayBlocks]);

  useEffect(() => {
    return () => {
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
      }
    };
  }, []);

  const sortedBlocks = useMemo(
    () => [...(displayBlocks || [])].sort((a, b) => a.avgChange - b.avgChange),
    [displayBlocks]
  );

  const rankChangeMap = useMemo(() => {
    if (!Array.isArray(lastBlocksSnapshot) || lastBlocksSnapshot.length === 0) {
      return {};
    }

    const previousRankMap = buildRankMap(lastBlocksSnapshot);
    const currentRankMap = buildRankMap(blocks);

    return Object.keys(currentRankMap).reduce((result, blockName) => {
      const changeText = getRankChangeText(previousRankMap[blockName], currentRankMap[blockName]);
      if (changeText) {
        result[blockName] = changeText;
      }
      return result;
    }, {});
  }, [lastBlocksSnapshot, blocks]);

  const saveCurrentBlocks = useCallback(() => {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return;
    }
    try {
      const snapshot = cloneBlocks(blocks);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      setLastBlocksSnapshot(snapshot);
    } catch (error) {
      console.error('保存板块涨跌幅回放数据失败:', error);
    }
  }, [blocks]);

  const handleReplay = useCallback(() => {
    const lastBlocks = lastBlocksSnapshot;
    if (!lastBlocks || lastBlocks.length === 0) {
      message.info('暂无上次数据可回放');
      return;
    }

    if (replayTimerRef.current) {
      clearTimeout(replayTimerRef.current);
    }

    const currentBlocksSnapshot = cloneBlocks(blocks);
    setReplaying(true);
    setSelectedBlock(null);
    setDisplayBlocks(lastBlocks);

    replayTimerRef.current = setTimeout(() => {
      syncDisplayBlocks(currentBlocksSnapshot);
      setReplaying(false);
      replayTimerRef.current = null;
    }, 2000);
  }, [blocks, lastBlocksSnapshot, syncDisplayBlocks]);

  const handleCancel = useCallback(() => {
    if (replayTimerRef.current) {
      clearTimeout(replayTimerRef.current);
      replayTimerRef.current = null;
    }
    setReplaying(false);
    saveCurrentBlocks();
    onCancel?.();
  }, [onCancel, saveCurrentBlocks]);

  const chartData = {
    labels: sortedBlocks.map(block => {
      const displayLabel = getDisplayLabel(block.blockName);
      if (replaying) {
        return displayLabel;
      }
      const rankChangeText = rankChangeMap[block.blockName];
      const compactRankChangeText = getCompactRankChangeText(rankChangeText);
      return compactRankChangeText ? `${displayLabel} ${compactRankChangeText}` : displayLabel;
    }),
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
    maintainAspectRatio: false,
    layout: {
      padding: {
        bottom: 8,
      },
    },
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
        ticks: {
          autoSkip: false,
          maxRotation: 75,
          minRotation: 75,
          padding: 4,
          font: {
            size: 12,
          },
          color: (context) => {
            const label = chartData.labels[context.index];
            if (label && label.includes('↑')) {
              return '#cf1322'; // 红色
            }
            if (label && label.includes('↓')) {
              return '#389e0d'; // 绿色
            }
            return '#666'; // 默认颜色
          },
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
      onCancel={handleCancel}
      footer={null}
      width={1400}
    >
      {sortedBlocks.length > 0 ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
            <Space>
              <Button
                type="primary"
                onClick={handleReplay}
                disabled={!Array.isArray(lastBlocksSnapshot) || lastBlocksSnapshot.length === 0}
                loading={replaying}
              >
                {replaying ? '回放中...' : '回放上次数据'}
              </Button>
            </Space>
          </div>
          <div style={{ width: '100%', height: '500px', minHeight: '500px', marginBottom: '32px' }}>
              <Bar ref={chartRef} data={chartData} options={chartOptions} onClick={(event) => {
                const chart = chartRef.current;
                if (!chart) return;
                const elements = getElementsAtEvent(chart, event);
                if (elements.length > 0) {
                  const clickedElementIndex = elements[0].index;
                  const blockName = sortedBlocks[clickedElementIndex]?.blockName;
                  const block = displayBlocks.find(b => b.blockName === blockName);
                  if (block) {
                    const sortedStocks = [...block.data].sort((a, b) => b.change - a.change);
                    setSelectedBlock({ ...block, data: sortedStocks });
                  }
                }
              }} />
          </div>
        </>
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
              <List.Item
                style={{ cursor: item.code ? 'pointer' : 'default' }}
                onClick={() => item.code && onStockClick?.(item)}
              >
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
