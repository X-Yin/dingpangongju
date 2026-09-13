import { useState } from 'react';
import { Select, Button, Tag, message, Popconfirm } from 'antd';
import { CalendarOutlined, WalletOutlined, ApartmentOutlined, ReloadOutlined, BarChartOutlined } from '@ant-design/icons';
import TrainingCampGroupModal from '../TrainingCampGroupModal';
import BacktestDrawer from '../BacktestDrawer';

const formatDateDisplay = (d) => {
  if (!d || d.length !== 8) return d;
  return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
};

const TopBar = ({ dates, groups, selectedDate, onDateChange, onGroupsChange, simPositionCount = 0, onOpenSimPositions, onReset }) => {
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [backtestOpen, setBacktestOpen] = useState(false);
  // 当前应用的分组：应用后下拉列表仅显示该分组日期
  const [appliedGroup, setAppliedGroup] = useState(null);

  // 应用分组：切换到分组首个日期，并将下拉列表限定为该分组日期
  const handleApplyGroup = (group) => {
    if (group.dates && group.dates.length > 0) {
      setAppliedGroup(group);
      onDateChange(group.dates[0]);
      message.success(`已应用分组「${group.name}」，下拉列表仅显示该分组日期`);
      setGroupModalOpen(false);
    }
  };

  // 点击 x 还原：恢复全部日期
  const handleClearGroup = () => {
    setAppliedGroup(null);
    message.info('已还原为全部日期');
  };

  const selectOptions = appliedGroup && appliedGroup.dates && appliedGroup.dates.length > 0
    ? appliedGroup.dates.map(d => ({ label: formatDateDisplay(d), value: d }))
    : dates.map(d => ({ label: formatDateDisplay(d), value: d }));

  return (
    <div className="training-camp-topbar">
      <div className="topbar-section">
        <CalendarOutlined style={{ color: '#1677ff' }} />
        <span className="topbar-label">回放日期</span>
        <Select
          value={selectedDate || undefined}
          onChange={onDateChange}
          style={{ width: 180 }}
          placeholder="选择日期"
          showSearch
          optionFilterProp="label"
          options={selectOptions}
        />
        {appliedGroup && (
          <Tag
            color="purple"
            closable
            onClose={handleClearGroup}
            style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            分组：{appliedGroup.name}
          </Tag>
        )}
      </div>

      <div className="topbar-section" style={{ marginLeft: 'auto' }}>
        <Button
          icon={<WalletOutlined />}
          onClick={() => onOpenSimPositions?.()}
          style={{ color: '#1677ff', borderColor: '#1677ff' }}
        >
          查看模拟持仓{simPositionCount > 0 ? `（${simPositionCount}）` : ''}
        </Button>
        <Popconfirm
          title="重置回放"
          description="将清空日期、时间桶进度、模拟持仓等所有缓存，并回到最新一天，确定重置吗？"
          okText="重置"
          cancelText="取消"
          onConfirm={() => onReset?.()}
        >
          <Button icon={<ReloadOutlined />} danger>
            重置
          </Button>
        </Popconfirm>
        <Button
          type="primary"
          icon={<ApartmentOutlined />}
          onClick={() => setGroupModalOpen(true)}
        >
          分组
        </Button>
        <Button
          type="primary"
          icon={<BarChartOutlined />}
          onClick={() => setBacktestOpen(true)}
          style={{ background: '#722ed1', borderColor: '#722ed1' }}
        >
          买卖点回测
        </Button>
      </div>

      <TrainingCampGroupModal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        dates={dates}
        groups={groups}
        onGroupsChange={onGroupsChange}
        onApplyGroup={handleApplyGroup}
      />

      <BacktestDrawer
        open={backtestOpen}
        onClose={() => setBacktestOpen(false)}
        dates={dates}
      />
    </div>
  );
};

export default TopBar;
