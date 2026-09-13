import { useState } from 'react';
import { Modal, Button, Select, InputNumber, message } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, PlusOutlined, DeleteOutlined, WalletOutlined } from '@ant-design/icons';
import '../../../components/FloatingBuyPointDiagnosis/index.scss';

// 训练营回放：买点诊断命中弹窗，展示全部买点条件诊断卡片 + 增加模拟持仓模块
const BuyPointCheckModal = ({ open, result, onClose, availableStocks = [], onAddPosition, positionCount = 0 }) => {
  const [selectedCode, setSelectedCode] = useState(null);
  const [price, setPrice] = useState(null);
  const [addedList, setAddedList] = useState([]);

  if (!result) return null;
  const { checks = [], allPassed = false, tailDipBuyingHit = false, passedCount = 0, totalCheckCount = 0, conclusion = '', displayTime = '' } = result;
  // 可出手判定：其它前置检查全部通过（与逻辑）或尾盘抄底命中（或逻辑分支）
  const buyable = allPassed || tailDipBuyingHit;

  const stockOptions = (availableStocks || []).map(s => ({
    label: `${s.name} ${s.code}`,
    value: s.code,
  }));

  const handleStockSelect = (code) => {
    setSelectedCode(code);
    const stock = (availableStocks || []).find(s => s.code === code);
    if (stock?.lastPx != null) setPrice(Number(Number(stock.lastPx).toFixed(2)));
  };

  const handleAddPosition = () => {
    if (!selectedCode) {
      message.warning('请选择股票');
      return;
    }
    if (!price || Number(price) <= 0) {
      message.warning('请输入有效的买入价格');
      return;
    }
    const stock = (availableStocks || []).find(s => s.code === selectedCode);
    if (!stock) {
      message.warning('未找到该股票');
      return;
    }
    const buyPrice = Number(Number(price).toFixed(2));
    const timeKey = String(result.timeKey || '').padStart(6, '0');
    onAddPosition?.({
      code: stock.code,
      stockName: stock.name || stock.code,
      buyPrice,
      buyDate: result.targetDate, // 买入日期（添加持仓当天不运行卖点诊断，仅晚于该日期时诊断）
      buyTimeKey: result.timeKey,
      buyMinute: timeKey.length >= 4 ? parseInt(timeKey.substring(0, 4)) : null,
      buyDisplayTime: result.displayTime,
    });
    setAddedList(prev => [...prev, { code: stock.code, stockName: stock.name || stock.code, buyPrice }]);
    setSelectedCode(null);
    setPrice(null);
    message.success(`已加入模拟持仓：${stock.name}（买入价 ${buyPrice.toFixed(2)}）`);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={680}
      title={
        <span style={{ fontSize: 15, fontWeight: 700, color: '#12213a' }}>
          🎯 买点诊断命中
          {displayTime ? <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7890', marginLeft: 8 }}>{displayTime}</span> : null}
        </span>
      }
      footer={
        <Button type="primary" size="large" onClick={onClose} style={{ borderRadius: 999, padding: '0 28px' }}>
          继续播放
        </Button>
      }
      className="buy-point-check-modal"
      centered
    >
      <div className="buy-diagnosis-drawer">
        <div className="panel-header">
          <span className="panel-title">买点条件诊断</span>
          <span className={`panel-badge ${allPassed ? 'pass' : 'fail'}`}>
            {passedCount}/{totalCheckCount}
          </span>
        </div>

        <div className="drawer-split-container" style={{ height: 500, alignItems: 'stretch' }}>
          <div className="drawer-left-panel">
            <div className="fbd-checks-list">
          {checks.map((check, idx) => (
            <div key={check.id} className={`fbd-check-card ${check.passed ? 'passed' : 'failed'}`}>
              <div className="fbd-card-header">
                <div className="fbd-title-row">
                  <span className={`fbd-num ${check.passed ? 'num-pass' : 'num-fail'}`}>{idx + 1}</span>
                  <span className="fbd-title">{check.title}</span>
                </div>
                {check.passed ? (
                  <CheckCircleFilled className="fbd-status-icon pass-icon" />
                ) : (
                  <CloseCircleFilled className="fbd-status-icon fail-icon" />
                )}
              </div>
              <div className="fbd-card-body">
                <div className="fbd-value-row">
                  <span className="fbd-value-label">当前值</span>
                  <span className={`fbd-value ${check.passed ? 'value-pass' : 'value-fail'}`}>{check.value}</span>
                </div>
                {check.detail && (
                  <div className="fbd-detail-row">
                    {check.id === 'fund_inflow' && check.detail.pastValue != null && check.detail.currentValue != null && (
                      <span className="fbd-detail-item">
                        资金 <b>{check.detail.pastValue >= 0 ? '+' : ''}{check.detail.pastValue.toFixed(2)}亿</b>
                        <span className="fbd-arrow"> → </span>
                        <b>{check.detail.currentValue >= 0 ? '+' : ''}{check.detail.currentValue.toFixed(2)}亿</b>
                        <span className="fbd-detail-time">（{check.detail.pastTime} → {check.detail.currentTime}）</span>
                      </span>
                    )}
                    {check.id === 'volume_expansion' && check.detail.prev5minVol != null && check.detail.last5minVol != null && (
                      <span className="fbd-detail-item">
                        量能变化 <b>{check.detail.prev5minVol.toFixed(2)}亿</b>
                        <span className="fbd-arrow"> → </span>
                        <b>{check.detail.last5minVol.toFixed(2)}亿</b>
                        <span className="fbd-detail-time">（{check.detail.pastTime} → {check.detail.currentTime}）</span>
                      </span>
                    )}
                  </div>
                )}
                <div className="fbd-reason">{check.reason}</div>
              </div>
            </div>
          ))}
        </div>

        <div className={`fbd-conclusion ${buyable ? 'conclusion-pass' : 'conclusion-fail'}`}>
          <div className={`fbd-conclusion-title ${buyable ? 'title-pass' : 'title-fail'}`}>
            {buyable ? '🚀 诊断结果：可以出手' : '⚠️ 诊断结果：暂不可出手'}
          </div>
          <div className="fbd-conclusion-text">{conclusion}</div>
        </div>
          </div>
          <div className="drawer-right-panel">
            {/* 增加模拟持仓模块 */}
            <div className="sim-position-add" style={{ marginTop: 0 }}>
          <div className="sim-position-add-header">
            <WalletOutlined style={{ color: '#1677ff' }} />
            <span className="sim-position-add-title">增加模拟持仓</span>
            <span className="sim-position-add-count">当前模拟持仓 {positionCount} 只</span>
          </div>
          <div className="sim-position-add-row">
            <Select
              showSearch
              value={selectedCode || undefined}
              onChange={handleStockSelect}
              placeholder="选择股票名称/代码"
              style={{ flex: 1, minWidth: 200 }}
              optionFilterProp="label"
              options={stockOptions}
              notFoundContent="无匹配股票（当前回放时段自选股）"
            />
            <InputNumber
              value={price}
              onChange={setPrice}
              placeholder="买入价（自动填充）"
              min={0}
              precision={2}
              style={{ width: 140 }}
              addonBefore="价"
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAddPosition}>
              加入
            </Button>
          </div>
          {addedList.length > 0 && (
            <div className="sim-position-added-list">
              {addedList.map((item, idx) => (
                <div key={idx} className="sim-position-added-item">
                  <span style={{ fontWeight: 600, color: '#12213a', fontSize: 12 }}>{item.stockName}</span>
                  <span style={{ color: '#9ca3af', fontSize: 11, fontFamily: "'SF Mono', monospace" }}>{item.code}</span>
                  <span style={{ color: '#1677ff', fontSize: 12, fontWeight: 600, fontFamily: "'SF Mono', monospace" }}>
                    买入 {item.buyPrice.toFixed(2)}
                  </span>
                  <DeleteOutlined
                    style={{ color: '#ef4444', fontSize: 12, cursor: 'pointer' }}
                    onClick={() => setAddedList(prev => prev.filter((_, i) => i !== idx))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default BuyPointCheckModal;
