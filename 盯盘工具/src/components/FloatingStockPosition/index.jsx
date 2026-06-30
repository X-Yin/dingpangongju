import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Input, Spin, message, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, MinusOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import StockKLineModal from '../StockKLineModal';
import './index.scss';

const ALERT_THRESHOLD = 0.3; // 涨跌幅变化绝对值阈值（%）

const FloatingStockPosition = () => {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [changeMap, setChangeMap] = useState({}); // code -> 最新涨幅
  const [alertMap, setAlertMap] = useState({}); // code -> { direction, diff, text }
  const [volumeDiffPercentMap, setVolumeDiffPercentMap] = useState({}); // code -> 量能差百分比
  const prevChangeRef = useRef({}); // 上一次的涨幅数据，用于比对
  const [pos, setPos] = useState({ x: 20, y: window.innerHeight - 400 });
  const dragRef = useRef({ dragging: false, offsetX: 0, offsetY: 0 });

  const handleDragStart = (e) => {
    // 点击图标等元素时不触发拖动
    if (e.target.closest('.fsp-action-icon, .fsp-toggle-icon')) return;
    const box = e.currentTarget.parentElement.getBoundingClientRect();
    dragRef.current = {
      dragging: true,
      offsetX: e.clientX - box.left,
      offsetY: e.clientY - box.top,
    };
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current.dragging) return;
      const x = e.clientX - dragRef.current.offsetX;
      const y = e.clientY - dragRef.current.offsetY;
      // 限制在视口范围内
      const maxX = window.innerWidth - 40;
      const maxY = window.innerHeight - 40;
      setPos({
        x: Math.max(0, Math.min(x, maxX)),
        y: Math.max(0, Math.min(y, maxY)),
      });
    };
    const handleUp = () => {
      if (dragRef.current.dragging) {
        dragRef.current.dragging = false;
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      setLoading(true);
      const res = await axios.get(`http://${local_ip}:3000/get_stock_position`);
      setPositions(res.data || []);
    } catch (error) {
      console.error('获取持仓失败:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // 轮询所有持仓股票的分时图接口，获取最新涨幅
  const fetchStockChanges = useCallback(async () => { 
    if (positions.length === 0) return;
    try {
      const results = await Promise.all(
        positions.map(async (stock) => {
          try {
            const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, {
              params: { code: stock.code },
            });
            const line = res.data?.line || [];
            const latest = line[line.length - 1];
            return { code: stock.code, change: latest ? latest.change : null };
          } catch (error) {
            return { code: stock.code, change: null };
          }
        })
      );
      const newChangeMap = {};
      results.forEach((item) => {
        newChangeMap[item.code] = item.change;
      });
      setChangeMap(newChangeMap);

      // 与上一次的数据比对，找出异动股票
      const newAlertMap = {};
      const prev = prevChangeRef.current;
      results.forEach((item) => {
        const prevChange = prev[item.code];
        const curChange = item.change;
        if (
          prevChange !== undefined &&
          prevChange !== null &&
          curChange !== null &&
          curChange !== undefined
        ) {
          const diff = curChange - prevChange;
          if (Math.abs(diff) >= ALERT_THRESHOLD) {
            const direction = diff > 0 ? 'up' : 'down';
            newAlertMap[item.code] = {
              direction,
              diff: Math.abs(diff).toFixed(2),
              text: `急速异动: ${prevChange.toFixed(2)}% -> ${curChange.toFixed(2)}%`,
            };
          }
        }
      });
      setAlertMap(newAlertMap);
      // 更新 prev 为当前值，供下次比对
      prevChangeRef.current = newChangeMap;
    } catch (error) {
      console.error('获取涨幅失败:', error);
    }
  }, [positions]);

  // 每 5 秒轮询一次量能差接口
  const fetchVolumeDiff = useCallback(async () => {
    if (positions.length === 0) return;
    try {
      const res = await axios.get(`http://${local_ip}:3000/diff2_day_stock_tline`);
      const list = res.data || [];
      const map = {};
      list.forEach((item) => {
        if (item && item.code != null) {
          map[item.code] = item.volumeDiffPercent;
        }
      });
      setVolumeDiffPercentMap(map);
    } catch (error) {
      console.error('获取量能差失败:', error);
    }
  }, [positions]);

  useEffect(() => {
    fetchPositions();
    const timer = setInterval(fetchPositions, 30000);
    return () => clearInterval(timer);
  }, [fetchPositions]);

  // 5 秒轮询一次持仓股票的涨幅
  useEffect(() => {
    if (positions.length === 0) {
      setChangeMap({});
      setAlertMap({});
      prevChangeRef.current = {};
      return;
    }
    fetchStockChanges();
    const timer = setInterval(fetchStockChanges, 5000);
    return () => clearInterval(timer);
  }, [fetchStockChanges, positions]);

  // 5 秒轮询一次量能差数据
  useEffect(() => {
    if (positions.length === 0) {
      setVolumeDiffPercentMap({});
      return;
    }
    fetchVolumeDiff();
    const timer = setInterval(fetchVolumeDiff, 5000);
    return () => clearInterval(timer);
  }, [fetchVolumeDiff, positions]);

  const handleAdd = async () => {
    if (!newCode.trim() || !newName.trim()) {
      message.warning('请输入完整的股票代码和名称');
      return;
    }
    try {
      setSubmitting(true);
      const res = await axios.post(`http://${local_ip}:3000/add_stock_position`, {
        code: newCode.trim(),
        name: newName.trim(),
      });
      if (res.data.success) {
        message.success('添加成功');
        setNewCode('');
        setNewName('');
        setAdding(false);
        await fetchPositions();
      } else {
        message.warning('该股票已存在');
      }
    } catch (error) {
      console.error('添加失败:', error);
      message.error('添加失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (code, name) => {
    try {
      const res = await axios.post(`http://${local_ip}:3000/delete_stock_position`, { code });
      if (res.data.success) {
        message.success(`已删除 ${name}`);
        await fetchPositions();
      } else {
        message.warning('删除失败，未找到该股票');
      }
    } catch (error) {
      console.error('删除失败:', error);
      message.error('删除失败');
    }
  };

  const handleStockClick = (stock) => {
    setSelectedStock(stock);
    setModalVisible(true);
  };

  const handleCancelAdd = () => {
    setAdding(false);
    setNewCode('');
    setNewName('');
  };

  // 整个组件是否处于异动状态
  const hasAnyAlert = Object.keys(alertMap).length > 0;

  return (
    <div
      className={`floating-stock-position ${expanded ? 'expanded' : 'collapsed'} ${hasAnyAlert ? 'alerting' : ''}`}
      style={{ left: pos.x, top: pos.y, bottom: 'auto' }}
    >
      {/* 头部标题栏 - 始终展示，可作为拖动手柄 */}
      <div
        className="fsp-header"
        onMouseDown={handleDragStart}
        onClick={(e) => {
          // 避免拖动后的 mouseup 触发收起/展开
          if (e.detail === 0) return;
          setExpanded(!expanded);
        }}
      >
        <div className="fsp-title">
          <FolderOpenOutlined className="fsp-title-icon" />
          <span className="fsp-title-text">我的持仓</span>
          {positions.length > 0 && <span className="fsp-count">{positions.length}</span>}
        </div>
        <div className="fsp-header-actions">
          <Tooltip title="刷新">
            <ReloadOutlined
              className="fsp-action-icon"
              onClick={(e) => { e.stopPropagation(); fetchPositions(); }}
            />
          </Tooltip>
          <MinusOutlined className="fsp-toggle-icon" />
        </div>
      </div>

      {expanded && (
        <div className="fsp-body">
          {loading && positions.length === 0 ? (
            <div className="fsp-loading"><Spin size="small" /></div>
          ) : (
            <>
              {positions.length > 0 && (
                <div className="fsp-list-header">
                  <span className="fsp-list-header-name">名称</span>
                  <span className="fsp-list-header-change">涨幅</span>
                  <span className="fsp-list-header-fund">资金净流</span>
                  <span className="fsp-list-header-voldiff">量比</span>
                </div>
              )}
              <div className="fsp-list">
                {positions.length === 0 ? (
                  <div className="fsp-empty">暂无持仓，点击添加</div>
                ) : (
                  positions.map((stock) => {
                    const fund = parseFloat(stock.mainFund);
                    const fundClass = isNaN(fund) ? 'neutral' : (fund > 0 ? 'up' : fund < 0 ? 'down' : 'neutral');
                    const change = changeMap[stock.code];
                    const changeNum = change !== null && change !== undefined ? parseFloat(change) : null;
                    const changeClass = changeNum === null ? 'neutral' : (changeNum > 0 ? 'up' : changeNum < 0 ? 'down' : 'neutral');
                    const alertInfo = alertMap[stock.code];
                    const hasAlert = !!alertInfo;
                    const volDiffPercent = volumeDiffPercentMap[stock.code];
                    const volDiffNum = volDiffPercent !== null && volDiffPercent !== undefined ? parseFloat(volDiffPercent) : null;
                    const volDiffClass = volDiffNum === null ? 'neutral' : (volDiffNum > 0 ? 'up' : volDiffNum < 0 ? 'down' : 'neutral');
                    return (
                      <div key={stock.code} className={`fsp-item ${hasAlert ? 'alerting' : ''}`}>
                        <div className="fsp-item-row">
                          <div className="fsp-item-info" onClick={() => handleStockClick(stock)}>
                            <span className={`fsp-item-name ${hasAlert ? `name-alerting ${alertInfo.direction}` : ''}`}>
                              {stock.name}
                            </span>
                            <span className={`fsp-item-change ${changeClass}`}>
                              {changeNum === null ? '--' : `${changeNum > 0 ? '+' : ''}${changeNum.toFixed(2)}%`}
                            </span>
                            <span className={`fsp-item-fund ${fundClass}`}>
                              {isNaN(fund) ? '--' : `${fund > 0 ? '+' : ''}${fund}亿`}
                            </span>
                            <span className={`fsp-item-voldiff ${volDiffClass}`}>
                              {volDiffNum === null ? '--' : `${volDiffNum > 0 ? '+' : ''}${volDiffNum.toFixed(2)}%`}
                            </span>
                          </div>
                          <Tooltip title="删除">
                            <DeleteOutlined
                              className="fsp-item-delete"
                              onClick={(e) => { e.stopPropagation(); handleDelete(stock.code, stock.name); }}
                            />
                          </Tooltip>
                        </div>
                        {hasAlert && (
                          <div className={`fsp-item-alert ${alertInfo.direction}`}>
                            {alertInfo.text}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {adding ? (
                <div className="fsp-add-form">
                  <Input
                    size="small"
                    placeholder="股票代码 (如 sh603986)"
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    onPressEnter={handleAdd}
                  />
                  <Input
                    size="small"
                    placeholder="股票名称"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onPressEnter={handleAdd}
                  />
                  <div className="fsp-add-actions">
                    <Button size="small" type="primary" loading={submitting} onClick={handleAdd}>
                      确认
                    </Button>
                    <Button size="small" onClick={handleCancelAdd}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="small"
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => setAdding(true)}
                  className="fsp-add-btn"
                >
                  添加持仓
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <StockKLineModal
        visible={modalVisible}
        onCancel={() => setModalVisible(false)}
        code={selectedStock?.code}
        stockInfo={{
          name: selectedStock?.name,
        }}
      />
    </div>
  );
};

export default FloatingStockPosition;
