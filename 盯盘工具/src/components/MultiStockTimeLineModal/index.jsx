import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Modal, Spin, Tag, Button, Input, Checkbox, Empty, Card, Tooltip, Popconfirm, message } from 'antd';
import { LineChartOutlined, PlusOutlined, SearchOutlined, CloseOutlined, GroupOutlined, EditOutlined, DeleteOutlined, StarOutlined, ApiOutlined, CaretUpOutlined, CaretDownOutlined, ReloadOutlined, FullscreenOutlined } from '@ant-design/icons';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import dayjs from 'dayjs';
import axios from 'axios';
import { local_ip } from '../../constant';
import { getThemeColor, getThemeColorRgba } from '../../utils/theme';
import { calculateReplayResilience, ensureReplayMinuteTlineByDate, getReplayMinuteTlineByDate, subscribeMinuteTlineUpdate } from '../../utils/replayResilience';
import './index.scss';

const hexToRgba = (hex, alpha = 1) => {
  if (!hex || !hex.startsWith('#')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

// 15 种高区分度颜色：按色相均匀分布，覆盖红/橙/黄/绿/青/蓝/紫/玫红等色系，避免相邻颜色混淆
const colors = [
  { border: getThemeColor(), bg: getThemeColorRgba(0.1) },
  { border: '#e11d48', bg: 'rgba(225, 29, 72, 0.1)' },
  { border: '#f97316', bg: 'rgba(249, 115, 22, 0.1)' },
  { border: '#facc15', bg: 'rgba(250, 204, 21, 0.1)' },
  { border: '#06b6d4', bg: 'rgba(6, 182, 212, 0.1)' },
  { border: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.1)' },
  { border: '#ec4899', bg: 'rgba(236, 72, 153, 0.1)' },
  { border: '#14b8a6', bg: 'rgba(20, 184, 166, 0.1)' },
  { border: '#f43f5e', bg: 'rgba(244, 63, 94, 0.1)' },
  { border: '#d946ef', bg: 'rgba(217, 70, 239, 0.1)' },
];

const DEFAULT_INDEX_STOCKS = [
  // { code: 'sh000688', stockName: '科创指数', isDefaultIndex: true },
  // { code: 'sz399006', stockName: '创业板指数', isDefaultIndex: true },
];

// 基准指数代码固定集合（与 DEFAULT_INDEX_STOCKS 展示配置解耦：
// 回放模式抗分歧计算、指数虚线样式、hideIndexTags 过滤等都依赖它识别基准指数）
const INDEX_CODE_SET = new Set(['sh000688', 'sz399006']);

const REPLAY_STORAGE_KEY = 'training_camp_replay_overlay_stocks';

const readReplayOverlayCodes = () => {
  try {
    const raw = localStorage.getItem(REPLAY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const writeReplayOverlayCodes = (codes) => {
  try { localStorage.setItem(REPLAY_STORAGE_KEY, JSON.stringify(codes)) } catch { /* noop */ }
};

// 回放模式分钟级分时缓存与拉取工具（与训练营卖点诊断共用，定义在 src/utils/replayResilience.js）

const mergeUniqueStocks = (...stockGroups) => {
  const map = new Map();
  stockGroups
    .flat()
    .filter(Boolean)
    .forEach((stock) => {
      if (!stock?.code) return;
      const prev = map.get(stock.code) || {};
      map.set(stock.code, {
        ...prev,
        ...stock,
        code: stock.code,
        stockName: stock.stockName || prev.stockName || stock.code,
      });
    });
  return Array.from(map.values());
};

const buildInitialStocks = (incomingStocks = []) => mergeUniqueStocks(DEFAULT_INDEX_STOCKS, incomingStocks);

const readPersistedStocks = (storageKey, fallbackStocks = [], includeDefaultIndex = true) => {
  const initialStocks = includeDefaultIndex ? buildInitialStocks(fallbackStocks) : (fallbackStocks || []).filter(s => !INDEX_CODE_SET.has(s.code));
  if (!storageKey) return initialStocks;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return initialStocks;
    const parsed = JSON.parse(raw);
    const stocksArray = Array.isArray(parsed) ? parsed : fallbackStocks;
    if (includeDefaultIndex) {
      return buildInitialStocks(stocksArray);
    } else {
      return stocksArray.filter(s => !INDEX_CODE_SET.has(s.code));
    }
  } catch (error) {
    console.error('读取叠加分时本地缓存失败:', error);
    return initialStocks;
  }
};

const buildFallbackInfoList = (stocks = []) => stocks.map((stock, idx) => ({
  code: stock.code,
  stockName: stock.stockName || stock.code,
  color: colors[idx % colors.length].border,
  finalChange: stock.change != null ? Number(stock.change).toFixed(2) : '0.00',
  resilienceScore: INDEX_CODE_SET.has(stock.code) ? 0 : null,
  resilienceLabel: INDEX_CODE_SET.has(stock.code) ? '基准指数' : '--',
  resilienceColor: '#8c8c8c',
  resilienceBg: '#fafafa',
  benchmarkName: INDEX_CODE_SET.has(stock.code) ? stock.stockName || stock.code : '--',
}));

const getResilienceMeta = (score) => {
  if (score >= 15) return { label: '极强抗跌', color: '#cf1322', bg: '#fff1f0' };
  if (score >= 10) return { label: '较强抗跌', color: '#fa8c16', bg: '#fff7e6' };
  if (score >= 5) return { label: '跟随指数', color: getThemeColor(), bg: '#e6f7ff' };
  return { label: '偏弱', color: '#389e0d', bg: '#f6ffed' };
};

const formatTimestamp = (minute) => {
  const minStr = String(minute).padStart(4, '0');
  const hh = minStr.substring(0, 2);
  const mm = minStr.substring(2, 4);
  const today = dayjs().format('YYYY-MM-DD');
  return dayjs(`${today} ${hh}:${mm}`).unix();
};

// 计算一组股票的平均涨幅（优先使用自选股全量监控的实时 change，缺失时回退到保存时的 change）
const computeAvgChange = (stocks, changeMap) => {
  const changes = (stocks || [])
    .map((s) => {
      const live = changeMap ? changeMap[s.code] : undefined;
      const val = live != null ? Number(live) : (s.change != null ? Number(s.change) : NaN);
      return val;
    })
    .filter((v) => !Number.isNaN(v));
  if (!changes.length) return null;
  return changes.reduce((a, b) => a + b, 0) / changes.length;
};

const formatAvgChange = (avg) => {
  if (avg == null) return '--';
  return `${avg > 0 ? '+' : ''}${avg.toFixed(2)}%`;
};

const avgChangeClass = (avg) => {
  if (avg == null) return 'neutral';
  if (avg > 0) return 'up';
  if (avg < 0) return 'down';
  return 'neutral';
};

// 叠加分时股票分组管理弹窗
const OverlayStockGroupModal = ({
  visible,
  onCancel,
  groups,
  onSaveGroup,
  onDeleteGroup,
  stockChangeMap = {},
}) => {
  const [mode, setMode] = useState('list'); // list | edit
  const [editingGroup, setEditingGroup] = useState(null);
  const [name, setName] = useState('');
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [search, setSearch] = useState('');

  const loadWatchlist = async () => {
    setWatchlistLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_all_stock_data`);
      setWatchlist(mergeUniqueStocks(res.data || []));
    } catch (error) {
      console.error('获取自选股列表失败:', error);
    } finally {
      setWatchlistLoading(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    setMode('list');
    setEditingGroup(null);
    setName('');
    setSelectedCodes([]);
    setSearch('');
    loadWatchlist();
  }, [visible]);

  const startCreate = () => {
    setEditingGroup(null);
    setName('');
    setSelectedCodes([]);
    setMode('edit');
  };

  const startEdit = (group) => {
    setEditingGroup(group);
    setName(group.name || '');
    setSelectedCodes((group.stocks || []).map((s) => s.code));
    setMode('edit');
  };

  const handleToggleStock = (code) => {
    setSelectedCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const handleSave = () => {
    if (!name.trim()) {
      message.warning('请输入分组名称');
      return;
    }
    const stocks = watchlist
      .filter((s) => selectedCodes.includes(s.code))
      .map((s) => ({ code: s.code, stockName: s.stockName, change: s.change }));
    onSaveGroup({ id: editingGroup?.id, name, stocks });
    setMode('list');
    setEditingGroup(null);
  };

  const filteredWatchlist = search
    ? watchlist.filter((s) =>
        (s.stockName || '').toLowerCase().includes(search.toLowerCase()) ||
        (s.code || '').toLowerCase().includes(search.toLowerCase())
      )
    : watchlist;

  const renderGroupList = () => (
    <div className="mtlm-group-mgr-list">
      {groups.length === 0 ? (
        <div className="mtlm-group-mgr-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无自定义分组" />
        </div>
      ) : (
        groups.map((group) => {
          const avg = computeAvgChange(group.stocks, stockChangeMap);
          return (
            <div key={group.id} className="mtlm-group-mgr-item">
              <div className="mtlm-group-mgr-item-info">
                <div className="mtlm-group-mgr-item-head">
                  <div className="mtlm-group-mgr-item-name">{group.name}</div>
                  <span className={`mtlm-group-mgr-item-avg ${avgChangeClass(avg)}`}>
                    平均 {formatAvgChange(avg)}
                  </span>
                </div>
                <div className="mtlm-group-mgr-item-count">
                  共 {(group.stocks || []).length} 只股票
                </div>
                <div className="mtlm-group-mgr-stock-chips">
                  {(group.stocks || []).length === 0 ? (
                    <span className="mtlm-group-mgr-chip-empty">暂无股票</span>
                  ) : (
                    (group.stocks || []).map((s) => (
                      <span key={s.code} className="mtlm-group-mgr-chip">
                        {s.stockName || s.code}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="mtlm-group-mgr-item-actions">
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  className="mtlm-group-mgr-btn"
                  onClick={() => startEdit(group)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="确定删除该分组？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => onDeleteGroup(group.id)}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    className="mtlm-group-mgr-btn"
                  >
                    删除
                  </Button>
                </Popconfirm>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  const renderEditForm = () => {
    const selectedStocks = selectedCodes
      .map((code) => watchlist.find((w) => w.code === code))
      .filter(Boolean);
    const selectedAvg = computeAvgChange(selectedStocks, stockChangeMap);
    return (
    <div className="mtlm-group-mgr-edit">
      <div className="mtlm-group-mgr-edit-field">
        <span className="mtlm-group-mgr-edit-label">分组名称</span>
        <Input
          placeholder="请输入分组名称"
          value={name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          className="mtlm-group-mgr-edit-input"
        />
      </div>
      <div className="mtlm-group-mgr-edit-selected">
        <div className="mtlm-group-mgr-edit-selected-head">
          <span className="mtlm-group-mgr-edit-selected-label">
            当前已选
            <span className="mtlm-group-mgr-edit-selected-count">{selectedCodes.length}</span>
          </span>
          <span className={`mtlm-group-mgr-edit-selected-avg ${avgChangeClass(selectedAvg)}`}>
            平均 {formatAvgChange(selectedAvg)}
          </span>
        </div>
        <div className="mtlm-group-mgr-edit-selected-chips">
          {selectedCodes.length === 0 ? (
            <span className="mtlm-group-mgr-chip-empty">尚未选择股票，在下方勾选加入分组</span>
          ) : (
            selectedCodes.map((code) => {
              const s = watchlist.find((w) => w.code === code);
              const change = stockChangeMap[code] != null ? Number(stockChangeMap[code]) : s?.change;
              return (
                <span key={code} className="mtlm-group-mgr-sel-chip">
                  <span className="mtlm-group-mgr-sel-chip-name">{s?.stockName || code}</span>
                  <span className={`mtlm-group-mgr-sel-chip-change ${avgChangeClass(change)}`}>
                    {change != null ? (change > 0 ? '+' : '') + change.toFixed(2) + '%' : '--'}
                  </span>
                  <span
                    className="mtlm-group-mgr-sel-chip-remove"
                    onClick={() => handleToggleStock(code)}
                  >
                    <CloseOutlined />
                  </span>
                </span>
              );
            })
          )}
        </div>
      </div>
      <div className="mtlm-group-mgr-edit-stocks">
        <div className="mtlm-group-mgr-edit-stocks-header">
          <span>选择股票（已选 {selectedCodes.length} 只）</span>
          <Input
            placeholder="搜索股票名称或代码"
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            allowClear
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mtlm-group-mgr-edit-search"
          />
        </div>
        <div className="mtlm-group-mgr-edit-stocks-body">
          {watchlistLoading ? (
            <div className="mtlm-group-mgr-edit-loading">
              <Spin size="small" />
            </div>
          ) : filteredWatchlist.length === 0 ? (
            <div className="mtlm-group-mgr-edit-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无股票" />
            </div>
          ) : (
            filteredWatchlist.map((s) => {
              const checked = selectedCodes.includes(s.code);
              return (
                <div
                  key={s.code}
                  className={`mtlm-group-mgr-stock-item ${checked ? 'checked' : ''}`}
                  onClick={() => {
                    setSelectedCodes((prev) =>
                      checked ? prev.filter((c) => c !== s.code) : [...prev, s.code]
                    );
                  }}
                >
                  <Checkbox checked={checked} />
                  <span className="mtlm-group-mgr-stock-name">{s.stockName || s.code}</span>
                  <span className="mtlm-group-mgr-stock-code">{s.code}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
      <div className="mtlm-group-mgr-edit-footer">
        <Button
          className="mtlm-group-mgr-btn"
          onClick={() => {
            setMode('list');
            setEditingGroup(null);
          }}
        >
          取消
        </Button>
        <Button
          type="primary"
          className="mtlm-group-mgr-btn"
          onClick={handleSave}
        >
          保存分组
        </Button>
      </div>
    </div>
    );
  };

  return (
    <Modal
      title={
        <span>
          <ApiOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />
          叠加分时分组管理
        </span>
      }
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={720}
      centered
      styles={{
        body: {
          padding: '20px 24px',
          height: 'calc(80vh - 60px)',
          background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)',
        },
      }}
      zIndex={10050}
    >
      <div className="mtlm-group-mgr">
        <div className="mtlm-group-mgr-header">
          <span className="mtlm-group-mgr-tip">
            基础分组为当前叠加分时观察的实时股票，不可在此编辑；自定义分组可自由增删改。
          </span>
          {mode === 'list' && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              className="mtlm-group-mgr-add-btn"
              onClick={startCreate}
            >
              新增分组
            </Button>
          )}
        </div>
        <div className="mtlm-group-mgr-body">
          {mode === 'list' ? renderGroupList() : renderEditForm()}
        </div>
      </div>
    </Modal>
  );
};

const MultiStockTimeLineModal = ({
  visible,
  onCancel,
  stocks,
  embedded = false,
  storageKey,
  title = '叠加分时对比',
  externalAddStock,
  onStockClick,
  replayMode = false,
  replayStocks,
  replayCurrentTimeKey,
  replayDate = '',
  hideIndexTags = false,
  includeDefaultIndex = true,
  compactHeader = false,
}) => {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false); // 手动刷新蒙层
  const [stockInfoList, setStockInfoList] = useState([]);
  const [currentStocks, setCurrentStocks] = useState(() => readPersistedStocks(storageKey, stocks || [], includeDefaultIndex));
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [selectedNewCodes, setSelectedNewCodes] = useState([]);
  const [panelSearch, setPanelSearch] = useState('');
  const [chartData, setChartData] = useState(null);
  const [rightAxisLabels, setRightAxisLabels] = useState([]);
  const [replayVersion, setReplayVersion] = useState(0);
  const [minuteTlineVersion, setMinuteTlineVersion] = useState(0); // 分钟级分时缓存更新版本号，拉取完成后触发回放重算
  useEffect(() => subscribeMinuteTlineUpdate(() => setMinuteTlineVersion(v => v + 1)), []);
  const fetchIdRef = useRef(0);
  const refreshingRef = useRef(false); // 手动刷新进行中标记，防止重复触发
  const chartRef = useRef(null);
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const seriesRef = useRef([]);
  const infoListRef = useRef([]);
  const lastValuesRef = useRef([]);
  const minuteDeltaRef = useRef([]); // 每只股票过去一分钟的涨幅（最新价 - 上一分钟价）
  const mainFundMapRef = useRef({});
  const importantCodesRef = useRef(new Set()); // 全量自选股中被标记为重点的股票代码集合
  const chartPausedRef = useRef(false); // 鼠标按住右侧 label 期间冻结分时图更新（轮询继续但不应用新数据）
  const isActive = embedded || visible;

  // 刷新中状态：叠加分时模块任一数据请求（分时/主力资金/自选股涨幅）进行中时，顶部刷新按钮跟随转动，全部返回后恢复静止
  const [timelineRefreshing, setTimelineRefreshing] = useState(false);
  const timelineRefreshCountRef = useRef(0);
  const beginTimelineRefresh = useCallback(() => {
    timelineRefreshCountRef.current += 1;
    setTimelineRefreshing(true);
  }, []);
  const endTimelineRefresh = useCallback(() => {
    timelineRefreshCountRef.current = Math.max(0, timelineRefreshCountRef.current - 1);
    if (timelineRefreshCountRef.current === 0) {
      setTimelineRefreshing(false);
    }
  }, []);

  // 分组相关状态
  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState('basic');
  const activeGroupIdRef = useRef('basic');
  const [basicStocks, setBasicStocks] = useState(() => readPersistedStocks(storageKey, stocks || [], includeDefaultIndex));
  const basicStocksRef = useRef(basicStocks);
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const groupBtnRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  const hoverTimerRef = useRef(null);
  const [hoveredCode, setHoveredCode] = useState(null);
  const hoveredCodeRef = useRef(null);
  const clickTimerRef = useRef(null);

  // tag 区域折叠相关：折叠时分时图高度固定增加 100px，并整体重建图表
  const [tagsCollapsed, setTagsCollapsed] = useState(true);
  const [chartReloadVersion, setChartReloadVersion] = useState(0);

  // 放大查看：打开后分时图整体移入 90% 宽高的大弹窗展示，关闭后移回卡片
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  // 悬浮 tag 时高亮对应股票曲线，其他曲线虚化
  const applyHoverHighlight = useCallback((code) => {
    seriesRef.current.forEach((series, idx) => {
      const stockInfo = infoListRef.current[idx];
      if (!stockInfo) return;
      const isIndex = INDEX_CODE_SET.has(stockInfo.code);
      if (code && stockInfo.code === code) {
        series.applyOptions({
          color: stockInfo.color,
          lineWidth: 4,
          lineStyle: LineStyle.Solid,
        });
      } else if (code) {
        series.applyOptions({
          color: hexToRgba(stockInfo.color, 0.12),
          lineWidth: 1,
          lineStyle: isIndex ? LineStyle.Dashed : LineStyle.Solid,
        });
      } else {
        series.applyOptions({
          color: stockInfo.color,
          lineWidth: isIndex ? 2 : 2,
          lineStyle: isIndex ? LineStyle.Dashed : LineStyle.Solid,
        });
      }
    });
  }, []);

  useEffect(() => {
    return () => clearTimeout(hoverTimerRef.current);
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/overlayStockGroup/list`);
      setGroups(res.data?.data || []);
    } catch (error) {
      console.error('获取叠加分时分组失败:', error);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // 自选股全量监控的实时涨幅，用于计算各分组平均涨幅
  const [stockChangeMap, setStockChangeMap] = useState({});
  useEffect(() => {
    axios
      .get(`http://${local_ip}:3000/get_all_stock_data`)
      .then((res) => {
        const map = {};
        const importantCodes = new Set();
        (res.data || []).forEach((s) => {
          if (s.code) map[s.code] = s.change;
          if (s.code && s.isImportant) importantCodes.add(s.code);
        });
        setStockChangeMap(map);
        importantCodesRef.current = importantCodes;
        requestAnimationFrame(() => updateRightAxisLabels());
      })
      .catch((error) => console.error('获取自选股涨幅失败:', error));
  }, []);

  // 主力资金净流入：交易时段轮询，用于右侧标签展示
  const fetchMainFund = useCallback(() => {
    beginTimelineRefresh();
    axios
      .get(`http://${local_ip}:3000/get_watchlist_main_fund`)
      .then((res) => {
        const map = {};
        (res.data || []).forEach((item) => {
          if (item && item.code) map[item.code] = item.mainFund;
        });
        mainFundMapRef.current = map;
        requestAnimationFrame(() => updateRightAxisLabels());
      })
      .catch((error) => console.error('获取主力资金净流入失败:', error))
      .finally(() => endTimelineRefresh());
  }, [beginTimelineRefresh, endTimelineRefresh]);

  useEffect(() => {
    if (!isActive) return undefined;
    fetchMainFund();
    const timer = window.setInterval(() => {
      const now = new Date();
      const day = now.getDay();
      const hour = now.getHours();
      const minute = now.getMinutes();
      if (day === 0 || day === 6) return;
      if (hour < 9 || (hour === 9 && minute < 25) || hour >= 15) return;
      fetchMainFund();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [isActive, fetchMainFund]);

  // 更新基础分组（当前叠加分时观察的实时股票），若当前处于基础分组视图则同步刷新图表
  const updateBasicStocks = useCallback((updater) => {
    const next = updater(basicStocksRef.current);
    basicStocksRef.current = next;
    setBasicStocks(next);
    if (activeGroupIdRef.current === 'basic') {
      setCurrentStocks(next);
    }
  }, []);

  // 切换分组视图
  const selectGroup = useCallback((groupId) => {
    clearTimeout(hoverTimerRef.current);
    setGroupDropdownOpen(false);
    setMenuPos(null);
    activeGroupIdRef.current = groupId;
    setActiveGroupId(groupId);
    if (groupId === 'basic') {
      setCurrentStocks(basicStocksRef.current);
    } else {
      const group = groups.find((x) => x.id === groupId);
      if (group) {
        const groupStocks = includeDefaultIndex
          ? mergeUniqueStocks(DEFAULT_INDEX_STOCKS, group.stocks || [])
          : (group.stocks || []).filter(s => !INDEX_CODE_SET.has(s.code));
        setCurrentStocks(groupStocks);
      }
    }
  }, [groups, includeDefaultIndex]);

  const handleSaveGroup = useCallback(async (payload) => {
    try {
      await axios.post(`http://${local_ip}:3000/overlayStockGroup/save`, payload);
      message.success('分组已保存');
      await fetchGroups();
    } catch (error) {
      console.error('保存分组失败:', error);
      message.error('保存分组失败');
    }
  }, [fetchGroups]);

  const handleDeleteGroup = useCallback(async (id) => {
    try {
      await axios.delete(`http://${local_ip}:3000/overlayStockGroup/delete?id=${id}`);
      message.success('分组已删除');
      if (activeGroupIdRef.current === id) {
        selectGroup('basic');
      }
      await fetchGroups();
    } catch (error) {
      console.error('删除分组失败:', error);
      message.error('删除分组失败');
    }
  }, [fetchGroups, selectGroup]);

  useEffect(() => {
    if (!embedded && visible) {
      const initial = includeDefaultIndex
        ? buildInitialStocks(stocks || [])
        : (stocks || []).filter(s => !INDEX_CODE_SET.has(s.code));
      setCurrentStocks(initial);
      basicStocksRef.current = initial;
      setBasicStocks(initial);
      activeGroupIdRef.current = 'basic';
      setActiveGroupId('basic');
      setShowBatchPanel(false);
      setSelectedNewCodes([]);
      setPanelSearch('');
      setStockInfoList(buildFallbackInfoList(initial));
    }
  }, [embedded, visible, stocks, includeDefaultIndex]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(currentStocks));
    } catch (error) {
      console.error('写入叠加分时本地缓存失败:', error);
    }
  }, [storageKey, currentStocks]);

  useEffect(() => {
    if (replayMode) return undefined;
    if (!isActive && !embedded) return undefined;
    if (currentStocks.length === 0) {
      setStockInfoList([]);
      setLoading(false);
      return undefined;
    }

    setStockInfoList(buildFallbackInfoList(currentStocks));
    fetchTimeLineData(currentStocks);
    const timer = window.setInterval(() => {
      const now = new Date();
      const day = now.getDay();
      const hour = now.getHours();
      const minute = now.getMinutes();
      if (day === 0 || day === 6) return;
      if (hour < 9 || (hour === 9 && minute < 15) || hour >= 15) return;
      fetchTimeLineData(currentStocks);
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [currentStocks, isActive, embedded]);

  useEffect(() => {
    if (!externalAddStock?.code) return;
    // 右键 / 增量添加默认加入基础分组
    updateBasicStocks((prev) => mergeUniqueStocks(prev, [externalAddStock]));
  }, [externalAddStock, updateBasicStocks]);

  useEffect(() => {
    if (!chartData || !containerRef.current) return;
    return updateChart(chartData.alignedLines, chartData.infoList);
  }, [chartData, chartReloadVersion]);

  useEffect(() => {
    if (!replayMode) return;
    if (!replayStocks || replayStocks.length === 0) {
      setChartData(null);
      setStockInfoList([]);
      setCurrentStocks([]);
      return;
    }
    const selectedCodes = readReplayOverlayCodes();
    const filtered = replayStocks.filter(s => selectedCodes.includes(s.code));
    if (filtered.length === 0) {
      setChartData(null);
      setStockInfoList([]);
      setCurrentStocks([]);
      return;
    }
    setCurrentStocks(filtered.map(s => ({ code: s.code, stockName: s.stockName })));
    // 预拉取叠加股票与基准指数的分钟级分时（每日期每代码仅拉一次，命中缓存后抗分歧分数按分钟精度重算）
    if (replayDate) {
      ensureReplayMinuteTlineByDate([...new Set([...filtered.map(s => s.code), ...INDEX_CODE_SET])], replayDate);
    }
    const currentMinute = replayCurrentTimeKey
      ? parseInt(String(replayCurrentTimeKey).padStart(6, '0').substring(0, 4))
      : 9999;
    const alignedLines = filtered.map((s) => {
      return (s.tlinePoints || [])
        .filter(p => p.minute != null && p.minute <= currentMinute)
        .sort((a, b) => a.minute - b.minute)
        .map(p => ({ minute: p.minute, change: p.change }));
    });
    // 基准指数分时序列（实时抗分歧指数计算用）
    const indexSeriesMap = new Map();
    replayStocks.forEach((s) => {
      if (INDEX_CODE_SET.has(s.code)) {
        indexSeriesMap.set(s.code, (s.tlinePoints || [])
          .filter(p => p.minute != null && p.minute <= currentMinute)
          .sort((a, b) => a.minute - b.minute));
      }
    });
    const infoList = filtered.map((s, idx) => {
      const points = alignedLines[idx] || [];
      const finalChange = points.length > 0 ? points[points.length - 1].change : 0;
      const isIndex = INDEX_CODE_SET.has(s.code);
      let resilienceScore = isIndex ? 0 : null;
      let resilienceLabel = isIndex ? '基准指数' : '--';
      let resilienceColor = '#8c8c8c';
      let resilienceBg = '#fafafa';
      let benchmarkName = isIndex ? (s.stockName || s.code) : '--';
      if (!isIndex) {
        const benchmarkCode = String(s.code).startsWith('sh688') ? 'sh000688' : 'sz399006';
        // 优先用分钟级分时按回放当前分钟切片计算（出分早、随回放平滑更新），未拉到时回退桶级数据
        const stockMinutePoints = replayDate ? getReplayMinuteTlineByDate(s.code, replayDate) : null;
        const indexMinutePoints = replayDate ? getReplayMinuteTlineByDate(benchmarkCode, replayDate) : null;
        let score = null;
        if (Array.isArray(stockMinutePoints) && Array.isArray(indexMinutePoints)) {
          score = calculateReplayResilience(
            stockMinutePoints.filter(p => p.minute <= currentMinute),
            indexMinutePoints.filter(p => p.minute <= currentMinute),
            s.code
          );
        }
        if (score == null) {
          const indexPoints = indexSeriesMap.get(benchmarkCode);
          const fullStockPoints = (s.tlinePoints || [])
            .filter(p => p.minute != null && p.minute <= currentMinute)
            .sort((a, b) => a.minute - b.minute);
          score = calculateReplayResilience(fullStockPoints, indexPoints, s.code);
        }
        if (score != null) {
          const meta = getResilienceMeta(score);
          resilienceScore = score;
          resilienceLabel = meta.label;
          resilienceColor = meta.color;
          resilienceBg = meta.bg;
          benchmarkName = benchmarkCode === 'sh000688' ? '科创指数' : '创业板指数';
        }
      }
      return {
        code: s.code,
        stockName: s.stockName || s.code,
        color: colors[idx % colors.length].border,
        finalChange: finalChange != null ? Number(finalChange).toFixed(2) : '0.00',
        resilienceScore,
        resilienceLabel,
        resilienceColor,
        resilienceBg,
        benchmarkName,
      };
    });
    // 鼠标按住右侧 label 期间冻结回放图更新，松开后由 release 逻辑触发重算
    if (chartPausedRef.current) return;
    setStockInfoList(infoList);
    setChartData({ alignedLines, infoList });
  }, [replayMode, replayStocks, replayCurrentTimeKey, replayVersion, replayDate, minuteTlineVersion]);

  const fetchTimeLineData = useCallback(async (stocksToFetch = currentStocks) => {
    if (!stocksToFetch.length) {
      setStockInfoList([]);
      setLoading(false);
      return;
    }

    beginTimelineRefresh();
    const fetchId = ++fetchIdRef.current;
    const shouldShowLoading = !seriesRef.current.length;
    if (shouldShowLoading) {
      setLoading(true);
    }
    try {
      // 抗分歧指数计算依赖 sh000688/sz399006 指数分时，与 currentStocks 解耦：
      // currentStocks 已包含对应指数时复用其结果，否则额外并发拉取
      const stockCodes = new Set(stocksToFetch.map(s => s.code));
      const extraIndexCodes = ['sh000688', 'sz399006'].filter(code => !stockCodes.has(code));

      const stockPromises = stocksToFetch.map((s) =>
        axios.get(`http://${local_ip}:3000/get_stock_tline?code=${s.code}`)
      );
      const indexPromises = extraIndexCodes.map((code) =>
        axios.get(`http://${local_ip}:3000/get_stock_tline?code=${code}`)
      );

      const [stockResponses, indexResponses] = await Promise.all([
        Promise.all(stockPromises),
        Promise.all(indexPromises),
      ]);

      if (fetchId !== fetchIdRef.current) return;

      const timeLineData = stockResponses.map((res) => res.data);
      const indexLineMap = {};
      extraIndexCodes.forEach((code, idx) => {
        indexLineMap[code] = indexResponses[idx]?.data?.line || [];
      });
      const validData = timeLineData.filter((d) => d?.line && d.line.length > 0);

      if (validData.length === 0) {
        if (shouldShowLoading) {
          setStockInfoList(buildFallbackInfoList(stocksToFetch));
        }
        return;
      }

      const minLen = Math.min(...validData.map(d => d.line.length));
      if (minLen === 0) {
        if (shouldShowLoading) {
          setStockInfoList(buildFallbackInfoList(stocksToFetch));
        }
        return;
      }

      const alignedLines = timeLineData.map((data) => {
        const line = data?.line || [];
        return line.slice(0, minLen).map(item => ({
          minute: item.minute,
          change: parseFloat(item.change || 0)
        }));
      });

      const getIndexLine = (code) => {
        const stockIdx = stocksToFetch.findIndex(s => s.code === code);
        return stockIdx !== -1 ? (timeLineData[stockIdx]?.line || []) : (indexLineMap[code] || []);
      };

      const resilienceRes = await axios.post(`http://${local_ip}:3000/calculate_resilience_realtime`, {
        stocks: stocksToFetch.map((s, idx) => ({
          code: s.code,
          stockName: timeLineData[idx]?.stockName || s.stockName || s.code,
          line: timeLineData[idx]?.line || [],
        })),
        indexLines: {
          sh000688: getIndexLine('sh000688'),
          sz399006: getIndexLine('sz399006'),
        },
      });
      const resilienceMap = new Map(
        (resilienceRes.data?.data || []).map((item) => [item.code, item])
      );

      const infoList = stocksToFetch.map((s, idx) => {
        const line = alignedLines[idx];
        const finalChange = line && line.length > 0
          ? (line[line.length - 1].change || 0).toFixed(2)
          : (s.change != null ? Number(s.change).toFixed(2) : '0.00');
        const resilience = resilienceMap.get(s.code);
        const isIndex = INDEX_CODE_SET.has(s.code);
        const hasValidResilience = resilience && !resilience.error && !isIndex;
        const meta = hasValidResilience
          ? getResilienceMeta(resilience.resilienceScore || 0)
          : { label: isIndex ? '基准指数' : '--', color: '#8c8c8c', bg: '#fafafa' };
        return {
          code: s.code,
          stockName: s.stockName || timeLineData[idx]?.stockName || s.code,
          color: colors[idx % colors.length].border,
          finalChange,
          resilienceScore: hasValidResilience ? resilience.resilienceScore : (isIndex ? 0 : null),
          resilienceLabel: resilience?.status || meta.label,
          resilienceColor: meta.color,
          resilienceBg: meta.bg,
          benchmarkName: resilience?.benchmarkName || (isIndex ? (s.stockName || s.code) : '--'),
        };
      });
      // 鼠标按住右侧 label 期间冻结分时图：轮询继续，但暂不应用新数据，避免 label 随涨幅变化乱跑
      if (chartPausedRef.current) return;
      setStockInfoList(infoList);
      setChartData({ alignedLines, infoList });

    } catch (error) {
      console.error('获取分时数据失败:', error);
      if (fetchId === fetchIdRef.current) {
        if (shouldShowLoading) {
          setStockInfoList(buildFallbackInfoList(stocksToFetch));
        }
      }
    } finally {
      endTimelineRefresh();
      if (fetchId === fetchIdRef.current && shouldShowLoading) setLoading(false);
    }
  }, [currentStocks, beginTimelineRefresh, endTimelineRefresh]);

  // 手动刷新：重新拉取当前分组所有股票的分时数据并重绘图表，同时刷新自选股涨幅与主力资金
  // 刷新期间在组件内容上显示蒙层，避免重复点击
  const handleRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      beginTimelineRefresh();
      await Promise.all([
        fetchMainFund(),
        axios
          .get(`http://${local_ip}:3000/get_all_stock_data`)
          .then((res) => {
            const map = {};
            (res.data || []).forEach((s) => {
              if (s.code) map[s.code] = s.change;
            });
            setStockChangeMap(map);
          })
          .catch((error) => console.error('获取自选股涨幅失败:', error))
          .finally(() => endTimelineRefresh()),
        fetchTimeLineData(currentStocks),
      ]);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [currentStocks, fetchMainFund, fetchTimeLineData, beginTimelineRefresh, endTimelineRefresh]);

  // 按住右侧 label：高亮对应折线（效果同悬浮 tag），并冻结分时图更新，避免 label 随涨幅变化乱跑；松开后恢复
  const handleLabelMouseDown = (e, code) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 防止按住拖动时选中文字
    chartPausedRef.current = true;
    hoveredCodeRef.current = code;
    setHoveredCode(code);
    applyHoverHighlight(code);
    const release = () => {
      window.removeEventListener('mouseup', release);
      window.removeEventListener('blur', release);
      chartPausedRef.current = false;
      hoveredCodeRef.current = null;
      setHoveredCode(null);
      applyHoverHighlight(null);
      // 松开后立即恢复正常刷新分时图数据
      if (replayMode) {
        setReplayVersion(v => v + 1);
      } else if (currentStocks.length > 0) {
        fetchTimeLineData();
      }
    };
    window.addEventListener('mouseup', release);
    window.addEventListener('blur', release);
  };

  const updateRightAxisLabels = useCallback(() => {
    if (!chartRef.current || !containerRef.current) return;
    const containerHeight = containerRef.current.clientHeight;
    const infoList = infoListRef.current;
    const lastValues = lastValuesRef.current;

    const labels = [];
    seriesRef.current.forEach((series, idx) => {
      const stockInfo = infoList[idx];
      const lastValue = lastValues[idx];
      if (!stockInfo || lastValue == null) return;
      const y = series.priceToCoordinate(lastValue);
      if (y == null) return;
      const change = lastValue;
      const minuteChange = minuteDeltaRef.current[idx];
      const fundRaw = mainFundMapRef.current[stockInfo.code];
      const fundNum = (fundRaw !== undefined && fundRaw !== null) ? Number(fundRaw) : NaN;
      const fundStr = Number.isNaN(fundNum) ? null : `${fundNum > 0 ? '+' : ''}${fundNum}亿`;
      const fundClass = Number.isNaN(fundNum) ? 'neutral' : (fundNum > 0 ? 'up' : fundNum < 0 ? 'down' : 'neutral');
      labels.push({
        key: stockInfo.code,
        name: stockInfo.stockName,
        color: stockInfo.color,
        isImportant: importantCodesRef.current.has(stockInfo.code),
        change,
        minuteChange,
        rank: null,
        changeStr: `${change > 0 ? '+' : ''}${change.toFixed(2)}%`,
        changeClass: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
        fundStr,
        fundClass,
        resilienceStr: stockInfo.resilienceScore != null ? stockInfo.resilienceScore.toFixed(1) : null,
        resilienceColor: stockInfo.resilienceColor || '#64748b',
        y,
      });
    });

    // 按纵向位置排序并处理重叠
    labels.sort((a, b) => a.y - b.y);
    const minGap = 18;
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < minGap) {
        labels[i].y = labels[i - 1].y + minGap;
      }
    }
    labels.forEach(label => {
      label.y = Math.max(10, Math.min(containerHeight - 10, label.y));
    });

    const visibleLabels = labels.filter(i => i.name !== '科创指数' && i.name !== '创业板指数');
    // 统计过去一分钟内涨幅最高的前三名股票，标注 1/2/3 序号
    visibleLabels
      .filter(l => l.minuteChange != null && l.minuteChange > 0)
      .sort((a, b) => b.minuteChange - a.minuteChange)
      .slice(0, 3)
      .forEach((lbl, idx) => {
        lbl.rank = idx + 1;
      });
    setRightAxisLabels(visibleLabels);
  }, []);

  const updateChart = (alignedLines, infoList) => {
    if (!containerRef.current) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }
    seriesRef.current = [];
    setRightAxisLabels([]);

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#64748b',
        fontSize: 11,
      },
      width: containerRef.current.clientWidth || 800,
      height: containerRef.current.clientHeight || 400,
      grid: {
        vertLines: { color: 'rgba(157, 176, 207, 0.12)', style: LineStyle.Dotted },
        horzLines: { color: 'rgba(157, 176, 207, 0.12)', style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: '#D1D4DC',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('HH:mm');
          }
          return time;
        },
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time) => {
          if (typeof time === 'number') {
            return dayjs.unix(time).format('HH:mm');
          }
          return time;
        },
      },
      rightPriceScale: {
        borderColor: '#D1D4DC',
        autoScale: true,
        minimumWidth: 216,
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
      },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        mode: 1,
        vertLine: {
          width: 1,
          color: '#94a3b8',
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1e293b',
          labelBorderColor: '#475569',
        },
        horzLine: {
          width: 1,
          color: '#94a3b8',
          style: LineStyle.Dotted,
          labelBackgroundColor: '#1e293b',
          labelBorderColor: '#475569',
        },
      },
    });

    chartRef.current = chart;

    alignedLines.forEach((line, idx) => {
      const stockInfo = infoList[idx];
      const isIndex = stockInfo && INDEX_CODE_SET.has(stockInfo.code);
      const lineSeries = chart.addLineSeries({
        color: stockInfo.color,
        lineWidth: isIndex ? 2 : 2,
        lineStyle: isIndex ? LineStyle.Dashed : LineStyle.Solid,
        priceFormat: {
          type: 'custom',
          formatter: (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`,
        },
        lastValueVisible: false,
      });

      let formattedData = line.map(item => ({
        time: formatTimestamp(item.minute),
        value: item.change,
      }));

      formattedData.sort((a, b) => a.time - b.time);

      const deduplicated = [];
      for (let i = 0; i < formattedData.length; i++) {
        if (i === 0 || formattedData[i].time !== formattedData[i - 1].time) {
          deduplicated.push(formattedData[i]);
        } else {
          deduplicated[deduplicated.length - 1] = formattedData[i];
        }
      }

      lineSeries.setData(deduplicated);
      seriesRef.current.push(lineSeries);
    });

    chart.timeScale().fitContent();

    chart.timeScale().applyOptions({
      fixLeftEdge: true,
      fixRightEdge: true,
      lockVisibleTimeRangeOnResize: true,
      rightOffset: 0,
    });

    // 保存当前 infoList 和各序列最新值，供右侧坐标轴标签计算使用
    infoListRef.current = infoList;
    lastValuesRef.current = alignedLines.map(line =>
      line && line.length > 0 ? line[line.length - 1].change : null
    );
    minuteDeltaRef.current = alignedLines.map(line =>
      line && line.length >= 2 ? line[line.length - 1].change - line[line.length - 2].change : null
    );
    requestAnimationFrame(() => updateRightAxisLabels());

    // 图表重建后恢复悬浮高亮状态
    if (hoveredCodeRef.current) {
      applyHoverHighlight(hoveredCodeRef.current);
    }

    const tooltip = tooltipRef.current;
    const TOOLTIP_MARGIN = 15;
    chart.subscribeCrosshairMove(param => {
      if (
        !param.point ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > containerRef.current.clientWidth ||
        param.point.y < 0 ||
        param.point.y > containerRef.current.clientHeight
      ) {
        tooltip.style.display = 'none';
      } else {
        tooltip.style.display = 'block';
        const seriesData = [];

        seriesRef.current.forEach((series, idx) => {
          const data = param.seriesData.get(series);
          if (data) {
            const stockInfo = infoList[idx];
            const resilienceText = stockInfo?.resilienceScore != null
              ? ` · 抗分歧 ${stockInfo.resilienceScore.toFixed(1)}`
              : '';
            seriesData.push({
              name: stockInfo.stockName,
              value: data.value,
              color: stockInfo.color,
              resilience: resilienceText,
            });
          }
        });

        const timeStr = typeof param.time === 'number' ? dayjs.unix(param.time).format('HH:mm') : param.time;
        let tooltipContent = `<div class="mtlm-lw-tooltip-header">${timeStr}</div>`;
        seriesData.forEach(item => {
          const sign = item.value > 0 ? '+' : '';
          tooltipContent += `
            <div class="mtlm-lw-tooltip-item">
              <span class="mtlm-lw-tooltip-dot" style="background: ${item.color}"></span>
              <span class="mtlm-lw-tooltip-name">${item.name}</span>
              <span class="mtlm-lw-tooltip-value" style="color: ${item.color}">${sign}${item.value.toFixed(2)}%</span>
              ${item.resilience ? `<span class="mtlm-lw-tooltip-resilience">${item.resilience}</span>` : ''}
            </div>
          `;
        });

        tooltip.innerHTML = tooltipContent;

        // 动态测量tooltip实际尺寸
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        const containerWidth = containerRef.current.clientWidth;
        const containerHeight = containerRef.current.clientHeight;

        let x = param.point.x;
        let y = param.point.y;

        // 水平定位：默认右侧，靠近右边界时放左侧
        let left;
        if (x + TOOLTIP_MARGIN + tooltipWidth > containerWidth) {
          // 放鼠标左侧
          left = x - TOOLTIP_MARGIN - tooltipWidth;
        } else {
          // 放鼠标右侧
          left = x + TOOLTIP_MARGIN;
        }
        // 左边界兜底
        if (left < 0) left = 4;
        if (left + tooltipWidth > containerWidth) left = containerWidth - tooltipWidth - 4;

        // 垂直定位：默认偏上，靠近上/下边界时翻转
        let top = y - tooltipHeight / 2;
        if (top < 4) top = 4;
        if (top + tooltipHeight > containerHeight - 4) {
          top = containerHeight - tooltipHeight - 4;
        }

        tooltip.style.left = `${left}px`;
        tooltip.style.right = 'auto';
        tooltip.style.top = `${top}px`;
      }
    });

    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
        requestAnimationFrame(() => updateRightAxisLabels());
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  };

  const fetchWatchlist = async () => {
    setWatchlistLoading(true);
    try {
      const res = await axios.get(`http://${local_ip}:3000/get_all_stock_data`);
      const stocks = includeDefaultIndex
        ? mergeUniqueStocks(DEFAULT_INDEX_STOCKS, res.data || [])
        : (res.data || []).filter(s => !INDEX_CODE_SET.has(s.code));
      setWatchlist(stocks);
    } catch (error) {
      console.error('获取自选股列表失败:', error);
    } finally {
      setWatchlistLoading(false);
    }
  };

  const handleToggleBatchPanel = () => {
    if (!showBatchPanel) {
      if (replayMode) {
        const stocks = replayStocks
          ? (includeDefaultIndex
              ? mergeUniqueStocks(DEFAULT_INDEX_STOCKS, replayStocks.map(s => ({ code: s.code, stockName: s.stockName })))
              : replayStocks.map(s => ({ code: s.code, stockName: s.stockName })).filter(s => !INDEX_CODE_SET.has(s.code)))
          : (includeDefaultIndex ? [...DEFAULT_INDEX_STOCKS] : []);
        setWatchlist(stocks);
        setWatchlistLoading(false);
      } else {
        fetchWatchlist();
      }
    }
    setShowBatchPanel(!showBatchPanel);
  };

  const handleConfirmBatchAdd = () => {
    if (replayMode) {
      const current = readReplayOverlayCodes();
      const newCodes = [...new Set([...current, ...selectedNewCodes])];
      writeReplayOverlayCodes(newCodes);
      setSelectedNewCodes([]);
      setShowBatchPanel(false);
      setReplayVersion(v => v + 1);
      return;
    }
    const current = basicStocksRef.current;
    const newStocks = watchlist
      .filter(s => selectedNewCodes.includes(s.code) && !current.some(c => c.code === s.code))
      .map(s => ({ code: s.code, stockName: s.stockName, change: s.change }));
    if (newStocks.length > 0) {
      updateBasicStocks(prev => [...prev, ...newStocks]);
    }
    setSelectedNewCodes([]);
    setShowBatchPanel(false);
  };

  const handleRemoveStock = (code) => {
    hoveredCodeRef.current = null;
    setHoveredCode(null);
    if (replayMode) {
      const remaining = readReplayOverlayCodes().filter(c => c !== code);
      writeReplayOverlayCodes(remaining);
      setReplayVersion(v => v + 1);
      return;
    }
    if (activeGroupIdRef.current === 'basic') {
      updateBasicStocks(prev => prev.filter(s => s.code !== code));
    } else {
      setCurrentStocks(prev => prev.filter(s => s.code !== code));
    }
  };

  const filteredWatchlist = panelSearch
    ? watchlist.filter(s =>
        (s.stockName || '').toLowerCase().includes(panelSearch.toLowerCase()) ||
        (s.code || '').toLowerCase().includes(panelSearch.toLowerCase())
      )
    : watchlist;

  const getChangeClass = (value) => {
    const num = parseFloat(value);
    if (num > 0) return 'up';
    if (num < 0) return 'down';
    return 'neutral';
  };

  const renderBody = (isFullscreen = false) => {
    const displayInfoList = hideIndexTags
      ? stockInfoList.filter((item) => !INDEX_CODE_SET.has(item.code))
      : stockInfoList;
    return (
    <div className="multi-stock-timeline-modal">
      {refreshing && (
        <div className="mtlm-refresh-mask">
          <Spin size="large" tip="刷新中..." />
        </div>
      )}
      <div className="mtlm-stock-tags-wrapper">
        {!tagsCollapsed && (
          <div className="mtlm-stock-tags">
            {displayInfoList.map((item) => (
          <div
            key={item.code}
            className={`mtlm-tag-item ${hoveredCode === item.code ? 'tag-highlighted' : ''} ${hoveredCode && hoveredCode !== item.code ? 'tag-dimmed' : ''}`}
            style={{ cursor: onStockClick ? 'pointer' : 'default' }}
            onMouseEnter={() => {
              hoveredCodeRef.current = item.code;
              setHoveredCode(item.code);
              applyHoverHighlight(item.code);
            }}
            onMouseLeave={() => {
              hoveredCodeRef.current = null;
              setHoveredCode(null);
              applyHoverHighlight(null);
            }}
            onClick={() => {
              if (clickTimerRef.current) {
                clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
                return;
              }
              clickTimerRef.current = setTimeout(() => {
                clickTimerRef.current = null;
                if (onStockClick) {
                  onStockClick({
                    code: item.code,
                    stockName: item.stockName,
                    name: item.stockName,
                    change: item.finalChange,
                  });
                }
              }, 300);
            }}
            onDoubleClick={() => {
              if (clickTimerRef.current) {
                clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
              }
              handleRemoveStock(item.code);
            }}
          >
            <span
              className="mtlm-tag-name"
              style={{ color: item.color }}
            >
              {item.stockName}
            </span>
            <span className={`mtlm-tag-change ${getChangeClass(item.finalChange)}`}>
              {parseFloat(item.finalChange) > 0 ? '+' : ''}{item.finalChange}%
            </span>
            <Tooltip
              title={
                item.resilienceScore != null
                  ? `相对 ${item.benchmarkName} 的实时抗分歧指数`
                  : '当前暂无可计算的抗分歧指数'
              }
            >
              {
                item.resilienceLabel !== '基准指数' && <span
                className="mtlm-tag-resilience"
                style={{
                  color: item.resilienceColor,
                  background: item.resilienceBg || '#fafafa',
                  borderColor: `${item.resilienceColor}22`,
                }}
              >
                {
                  item.resilienceLabel === '基准指数' ? item.resilienceLabel : `${item.resilienceScore != null ? item.resilienceScore.toFixed(1) : '--'}`
                }
              </span>
              }
            </Tooltip>
            </div>
        ))}
          </div>
        )}
      </div>

      <div className="mtlm-body">
        <div className="mtlm-chart-area">
          <div className={`mtlm-chart-inner ${tagsCollapsed ? 'collapsed' : ''} ${isFullscreen ? 'fullscreen' : ''}`}>
            <div className="mtlm-lw-chart-container">
              <div ref={containerRef} className="mtlm-lw-chart" />
              <div ref={tooltipRef} className="mtlm-lw-tooltip" />
              <div className="mtlm-right-axis-labels">
                {rightAxisLabels.map(label => (
                  <div
                    key={label.key}
                    className={`mtlm-right-label ${label.isImportant ? 'label-important' : ''} ${hoveredCode && hoveredCode !== label.key ? 'label-dimmed' : ''} ${hoveredCode === label.key ? 'label-highlighted' : ''}`}
                    style={{ top: `${label.y}px`, borderColor: label.color }}
                    onMouseDown={(e) => handleLabelMouseDown(e, label.key)}
                  >
                    <span className="mtlm-right-label-name" style={label.isImportant ? { color: '#ffffff', background: label.color } : { color: label.color }}>
                      {label.rank && <span className={`mtlm-right-label-rank rank-${label.rank}`}>{label.rank}</span>}
                      {label.name}
                    </span>
                    <span className={`mtlm-right-label-change ${label.changeClass}`}>
                      {label.changeStr}
                    </span>
                    {label.resilienceStr && (
                      <span
                        className="mtlm-right-label-resilience"
                        style={{ color: label.resilienceColor }}
                      >
                        {label.resilienceStr}
                      </span>
                    )}
                    {label.fundStr && (
                      <span className={`mtlm-right-label-fund ${label.fundClass}`}>
                        {label.fundStr}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {loading && (
              <div className="mtlm-loading">
                <Spin size="large" tip="加载中..." />
              </div>
            )}
            {!loading && stockInfoList.length === 0 && (
              <div className="mtlm-empty">
                暂无分时数据
              </div>
            )}
          </div>
        </div>

        {showBatchPanel && (
          <div className="mtlm-panel">
            <div className="mtlm-panel-header">
              <div className="mtlm-panel-title">
                自选股列表
                <span className="mtlm-panel-count">{selectedNewCodes.length}</span>
              </div>
              <div className="mtlm-panel-search">
                <Input
                  placeholder="搜索股票名称或代码"
                  prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                  allowClear
                  size="small"
                  value={panelSearch}
                  onChange={(e) => setPanelSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="mtlm-panel-body">
              {watchlistLoading ? (
                <div className="mtlm-panel-loading">
                  <Spin size="small" />
                </div>
              ) : filteredWatchlist.length === 0 ? (
                <div className="mtlm-panel-empty">
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无股票" />
                </div>
              ) : (
                filteredWatchlist.map(s => {
                  const alreadyAdded = currentStocks.some(c => c.code === s.code);
                  const changeVal = s.change || 0;
                  return (
                    <div
                      key={s.code}
                      className={`mtlm-panel-item ${alreadyAdded ? 'mtlm-panel-item-disabled' : ''}`}
                    >
                      <div className="mtlm-panel-checkbox">
                        <Checkbox
                          checked={selectedNewCodes.includes(s.code)}
                          disabled={alreadyAdded}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedNewCodes(prev => [...prev, s.code]);
                            } else {
                              setSelectedNewCodes(prev => prev.filter(c => c !== s.code));
                            }
                          }}
                        />
                      </div>
                      <span className="mtlm-panel-stock-name">{s.stockName || s.code}</span>
                      {alreadyAdded ? (
                        <Tag className="mtlm-panel-tag">已叠加</Tag>
                      ) : (
                        <span className={`mtlm-panel-change ${getChangeClass(changeVal)}`}>
                          {changeVal > 0 ? '+' : ''}{changeVal.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="mtlm-panel-footer">
              <Button
                size="small"
                className="mtlm-panel-btn"
                onClick={() => setShowBatchPanel(false)}
              >
                取消
              </Button>
              <Button
                size="small"
                type="primary"
                className="mtlm-panel-btn"
                disabled={selectedNewCodes.length === 0}
                onClick={handleConfirmBatchAdd}
              >
                确定（{selectedNewCodes.length}）
              </Button>
            </div>
          </div>
        )}</div>
      </div>
    );
  };

  const renderGroupModal = () => (
    <OverlayStockGroupModal
      visible={groupModalVisible}
      onCancel={() => setGroupModalVisible(false)}
      groups={groups}
      onSaveGroup={handleSaveGroup}
      onDeleteGroup={handleDeleteGroup}
      stockChangeMap={stockChangeMap}
    />
  );

  // 放大查看弹窗：宽高各占屏幕 90%，分时图填满弹窗内容区
  // 注意 renderBody（含图表容器 ref）同一时间只能渲染一处：弹窗打开时渲染在弹窗内，卡片显示占位
  // 弹窗内容由 rc-motion 延迟挂载，打开动画结束后（容器已可见）再触发图表在新容器重建；
  // 关闭时在 onCancel 里立即触发图表移回卡片容器重建
  const handleCloseFullscreen = () => {
    setFullscreenOpen(false);
    setChartReloadVersion(v => v + 1);
  };
  const renderFullscreenModal = () => (
    <Modal
      title={
        <span>
          <FullscreenOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />
          {title}（放大视图）
        </span>
      }
      open={fullscreenOpen}
      onCancel={handleCloseFullscreen}
      afterOpenChange={(open) => {
        if (open) setChartReloadVersion(v => v + 1);
      }}
      footer={null}
      width="90vw"
      centered
      zIndex={10000}
      styles={{ body: { height: 'calc(90vh - 56px)', padding: 12, overflow: 'hidden' } }}
    >
      <div className="mtlm-fullscreen-body">
        {fullscreenOpen && renderBody(true)}
      </div>
    </Modal>
  );

  const openGroupDropdown = () => {
    clearTimeout(hoverTimerRef.current);
    const el = groupBtnRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setMenuPos({ left: rect.left, top: rect.bottom + 6 });
    }
    setGroupDropdownOpen(true);
  };

  // 基础分组的平均涨幅（排除基准指数）
  const basicAvgChange = computeAvgChange(
    basicStocks.filter((s) => !INDEX_CODE_SET.has(s.code)),
    stockChangeMap
  );

  const scheduleCloseGroupDropdown = () => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setGroupDropdownOpen(false);
      setMenuPos(null);
    }, 150);
  };

  // tag 折叠按钮：放在「分组」按钮左侧
  const hasDisplayTags = hideIndexTags
    ? stockInfoList.some((item) => !INDEX_CODE_SET.has(item.code))
    : stockInfoList.length > 0;

  const renderTagsToggle = () => (
    hasDisplayTags && (
      <Button
        className="mtlm-group-btn mtlm-tags-toggle-btn"
        icon={tagsCollapsed ? <CaretDownOutlined /> : <CaretUpOutlined />}
        title={tagsCollapsed ? '展开股票标签' : '折叠股票标签'}
        onClick={() => {
          setTagsCollapsed((v) => !v);
          // 折叠/展开后整体重建图表，避免展示样式异常
          setChartReloadVersion((v) => v + 1);
        }}
      />
    )
  );

  const renderGroupToolbar = () => (
    <>
      <div
        className="mtlm-group-dropdown"
        onMouseEnter={openGroupDropdown}
        onMouseLeave={scheduleCloseGroupDropdown}
      >
        <Button
          ref={groupBtnRef}
          className="mtlm-group-btn"
          icon={<GroupOutlined />}
          onClick={() => setGroupModalVisible(true)}
        >
          分组
        </Button>
      </div>
      {groupDropdownOpen && groups.length > 0 && menuPos && createPortal(
        <div
          className="mtlm-group-dropdown-menu"
          style={{ position: 'fixed', left: menuPos.left, top: menuPos.top, minWidth: 200 }}
          onMouseEnter={() => {
            clearTimeout(hoverTimerRef.current);
            setGroupDropdownOpen(true);
          }}
          onMouseLeave={scheduleCloseGroupDropdown}
        >
          <div
            className={`mtlm-group-dropdown-item ${activeGroupId === 'basic' ? 'active' : ''}`}
            onClick={() => selectGroup('basic')}
          >
            <StarOutlined className="mtlm-group-dropdown-icon" />
            <span className="mtlm-group-dropdown-name">基础分组</span>
            <span className={`mtlm-group-dropdown-avg ${avgChangeClass(basicAvgChange)}`}>
              {formatAvgChange(basicAvgChange)}
            </span>
          </div>
          {groups.map((group) => {
            const avg = computeAvgChange(group.stocks, stockChangeMap);
            return (
              <div
                key={group.id}
                className={`mtlm-group-dropdown-item ${activeGroupId === group.id ? 'active' : ''}`}
                onClick={() => selectGroup(group.id)}
              >
                <span className="mtlm-group-dropdown-name">{group.name}</span>
                <span className={`mtlm-group-dropdown-avg ${avgChangeClass(avg)}`}>
                  {formatAvgChange(avg)}
                </span>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );

  if (embedded) {
    return (
      <>
        <Card
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <span><LineChartOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />{title}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Button
                  icon={<FullscreenOutlined />}
                  title="放大查看分时图"
                  onClick={() => setFullscreenOpen(true)}
                  className="mtlm-fullscreen-btn"
                />
                <Button
                  icon={<ReloadOutlined spin={timelineRefreshing} />}
                  title="刷新全部叠加分时数据"
                  onClick={handleRefresh}
                  className="mtlm-refresh-btn"
                />
                {renderTagsToggle()}
                {renderGroupToolbar()}
                <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={handleToggleBatchPanel}
                      className="mtlm-add-btn"
                    >
                      {showBatchPanel ? '收起批量添加' : '批量添加'}
                </Button>
              </div>
            </div>
          }
          className={`monitor-card mtlm-embedded-card${compactHeader ? ' mtlm-compact-header' : ''}`}
          variant="borderless"
          bodyStyle={{ padding: '16px 20px' }}
        >
          {fullscreenOpen ? (
            <div className="mtlm-fullscreen-placeholder">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="分时图已在放大弹窗中显示，关闭弹窗后恢复" />
            </div>
          ) : renderBody()}
        </Card>
        {renderGroupModal()}
        {renderFullscreenModal()}
      </>
    );
  }

  return (
    <>
      <Modal
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <span><LineChartOutlined style={{ color: getThemeColor(), marginRight: '8px' }} />{title}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {renderTagsToggle()}
              {renderGroupToolbar()}
              <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={handleToggleBatchPanel}
                    className="mtlm-add-btn"
                  >
                    {showBatchPanel ? '收起批量添加' : '批量添加'}
              </Button>
            </div>
          </div>
        }
        open={visible}
        onCancel={onCancel}
        footer={null}
        width={showBatchPanel ? 1200 : 950}
        centered
        bodyStyle={{ padding: '20px 24px', minHeight: '520px', background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)' }}
        zIndex={10000}
      >
        {renderBody()}
      </Modal>
      {renderGroupModal()}
    </>
  );
};

export default MultiStockTimeLineModal;