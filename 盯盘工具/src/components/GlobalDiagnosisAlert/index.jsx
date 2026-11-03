// 全局买点 / 卖点诊断提醒（挂载于 App 根组件，全页面生效）
//   后端命中买点 / 卖点且进入新的 5 分钟桶时经 WS 推送 open:true，本组件据此提醒：
//     买点：弹出「买点流水线」弹窗（大盘总览 → 股票细览 → 条件确认），确认买入后关闭
//     卖点：右下角卖点卡片（股票名称 / 卖出价格 / 卖出理由 / 本次收益率）
//   抽屉（FloatingStockPosition）与页面内诊断卡片的数据展示不受影响，本组件只负责全局提醒。
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Modal, Row, Col, Button, Spin, Empty, Segmented, message } from 'antd';
import {
  ThunderboltOutlined,
  WarningOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  LineChartOutlined,
  GlobalOutlined,
  CheckOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  MinusCircleFilled,
  AreaChartOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import { local_ip } from '../../constant';
import { getStrategyMode, MODE_TECH_ATTACK, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE, MODE_WASH_FUSION } from '../../utils/strategyMode';
import { subscribeBuyPointPush, subscribeSellPointPush, subscribeIceDelayWaitPush, subscribeWashFusionBuyPush } from '../../utils/buyPointWs';
import StockTimeLine from '../StockTimeLine';
import StockKLine from '../StockKLine';
import StockKLineModal from '../StockKLineModal';
import WatchlistTopRanking from '../../pages/dingpan/components/WatchlistTopRanking';
import BlockRankingCards from '../../pages/dingpan/components/BlockRankingCards';
import './index.scss';

// 情绪游资-极致赔率（首板起爆 + 二板起爆）复用本组件的统一买点流水线弹窗，
// 走独立 WS 类型 wash_fusion_buy（不走策略模式 buy_point，避免串到页面内诊断）
const MODE_LABELS = {
  [MODE_TECH_ATTACK]: '科技进攻',
  [MODE_EXTREME_WIN]: '情绪游资',
  [MODE_ATTACK_DEFENSE]: '攻防兼备',
  [MODE_WASH_FUSION]: '情绪游资-极致赔率',
};

// 大盘总览三大指数（分时图）
const INDEX_CHARTS = [
  { code: 'sh000001', label: '上证指数' },
  { code: 'sz399006', label: '创业板指' },
  { code: 'sh000688', label: '科创50' },
];

const fmtPct = (v) => {
  const num = Number(v);
  if (v === undefined || v === null || Number.isNaN(num)) return '--';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

// 首板起爆：洗盘形态文案（与后端候选列表同一口径）
const washText = (w) => {
  if (!w) return '--';
  const parts = [];
  if (w.washDays != null) parts.push(`洗盘 ${w.washDays} 个交易日`);
  if (w.rangePct != null) parts.push(`幅度 ${Number(w.rangePct).toFixed(2)}%`);
  if (w.platformHigh != null) parts.push(`平台高点 ${Number(w.platformHigh).toFixed(2)}`);
  return parts.length > 0 ? parts.join('，') : '--';
};

// 实时价格补齐：/stock_tline_data 取分时最后一点（last_px 优先，缺失时按昨收 × (1 + 涨幅) 折算）
const fetchStockPrice = async (code) => {
  try {
    const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code } });
    const line = res.data?.line || [];
    const latest = line[line.length - 1] || null;
    const preclose = Number(res.data?.preclose_px);
    let price = latest?.last_px != null ? Number(latest.last_px) : null;
    if ((!price || !Number.isFinite(price) || price <= 0)
      && latest?.change != null && Number.isFinite(preclose) && preclose > 0) {
      price = preclose * (1 + Number(latest.change) / 100);
    }
    return {
      price: price != null && Number.isFinite(price) ? Number(price.toFixed(2)) : null,
      change: latest?.change != null ? Number(latest.change) : null,
    };
  } catch {
    return { price: null, change: null };
  }
};

// 科技进攻仓位说明（与后端飞书卡片 buildTechPositionHint / 回测 fusedEmoWinBacktest A 风格同口径）：
//   已持第一份半仓 → 补买第二份（阈值降为 20 亿）；快进快出日 → 半仓次日 10:00 强卖；
//   资金净流入阈值抬高态（≥30 亿）→ 强制两次买入首笔半仓；普通日 → 全仓
const buildTechPositionExplain = (techData) => {
  const checks = techData?.checks || [];
  const quickOutHint = checks.find((c) => c.id === 'quick_out_buy_hint')?.value || '';
  const isQuickOutDay = quickOutHint.includes('快进快出');
  const fundDetail = checks.find((c) => c.id === 'fund_inflow')?.detail || {};
  const gateThreshold = fundDetail.fundGate?.threshold;
  const isRaised = typeof gateThreshold === 'number' && gateThreshold >= 30;
  const firstLeg = fundDetail.waitingSecondLeg === true ? (fundDetail.firstLeg || null) : null;
  if (firstLeg) {
    const firstLegWeight = Number.isFinite(Number(firstLeg.weight)) ? Number(firstLeg.weight) : 50;
    const remaining = Math.max(0, 100 - firstLegWeight);
    return {
      pos: remaining === 50 ? '半仓（50%）' : `${remaining}%（补足至满仓）`,
      why: `补买剩余 ${remaining === 50 ? '半仓 5 成' : `${remaining}%`}：已持 ${firstLeg.name || firstLeg.code}（仓位 ${firstLegWeight}%，${firstLeg.buyDate || '?'} 买入），本次补足至满仓；补买资金净流入阈值降为基准 20 亿${isQuickOutDay ? '；今日为快进快出日，本份买入后次日 10:00 强卖' : ''}`,
    };
  }
  if (isQuickOutDay) {
    return { pos: '半仓（50%）', why: '快进快出日：首次买入半仓，次日买点再次触发时补足第二份半仓，该笔次日 10:00 强卖' };
  }
  if (isRaised) {
    return { pos: '半仓（50%）', why: `资金净流入阈值处于抬高态（${gateThreshold} 亿 ≥ 30 亿），强制两次买入：本次仅买第一份 5 成，剩余半仓等后续交易日买点再次触发时补买（补买阈值降为 20 亿，且不能与第一份同一天买入）` };
  }
  return { pos: '全仓（100%）', why: '普通买入日，一次性建仓' };
};

// 买入理由：已通过的检查项（资金净流入 / 量能置顶），展示标题 + 数值 + 理由
const collectBuyReasons = (checks) => (checks || [])
  .filter((c) => c && (c.passed || c.exempted) && c.id !== 'quick_out_buy_hint')
  .sort((a, b) => {
    const rank = (c) => (c.id === 'fund_inflow' ? 0 : c.id === 'volume_expansion' ? 1 : 2);
    return rank(a) - rank(b);
  });

// 条件状态：通过 / 豁免 / 未通过
const checkStatus = (c) => {
  if (!c) return 'unknown';
  if (c.passed) return 'pass';
  if (c.exempted) return 'exempt';
  return 'fail';
};

// 条件明细文案（detail 可能是对象，仅取字符串，避免渲染报错）
const checkDetailText = (c) => {
  if (!c) return '';
  if (typeof c.reason === 'string' && c.reason) return c.reason;
  if (typeof c.detail === 'string' && c.detail) return c.detail;
  return '';
};

const GlobalDiagnosisAlert = () => {
  // 买点流水线弹窗：{ mode, data, bucket, ts, stocks, loading }
  const [buyAlert, setBuyAlert] = useState(null);
  // 卖点卡片：{ results, ts }
  const [sellAlert, setSellAlert] = useState(null);
  // 冰点转折延时观察卡片：{ mode, data:{ triggerTime, executeTime, delayMin, message }, ts }
  const [iceAlert, setIceAlert] = useState(null);
  // 极致赔率买点弹窗：{ mode:'wash_fusion_extreme_odds', data, stocks, loading:false, remind, ts }
  const [wfAlert, setWfAlert] = useState(null);
  const seqRef = useRef(0); // 旧请求返回晚于新触发时丢弃过期结果

  // 拉取本次买点命中对应的推荐标的（含实时买入价格）
  //   MOCK 调试消息自带 buyable；实盘按模式取科技进攻 3 日涨幅榜唯一推荐 / 情绪游资顺周期前三 + 逆周期前三
  const fetchBuyStocks = useCallback(async (mode, data) => {
    const decorate = async (list) => {
      const withPrice = await Promise.all(list.map(async (s) => {
        const { price, change } = await fetchStockPrice(s.code);
        return { ...s, buyPrice: price != null ? price : (s.buyPrice ?? null), priceChange: s.change != null ? s.change : change };
      }));
      return withPrice;
    };
    // MOCK：后端调试触发直接携带标的
    if (Array.isArray(data?.buyable) && data.buyable.length > 0) {
      return decorate(data.buyable);
    }
    // 冰点转折延时买入（2026-10-23）：到点由后端直接给出标的；无标的时不回退普通榜单拉取
    if (data?.iceDelay) {
      return [];
    }
    const isExtreme = mode === MODE_EXTREME_WIN;
    const isDefense = mode === MODE_ATTACK_DEFENSE;
    const stocks = [];
    // 科技进攻源（tech_attack / attack_defense）：使用后端唯一买点候选 pickCode（已应用过热/一字板/顺延规则）
    if (!isExtreme) {
      try {
        const res = await axios.post(`http://${local_ip}:3000/top_gainers_by_market`, { limit: 10 });
        const d = res.data?.data || {};
        const cybPassed = d.cybGate?.passed === true;
        const starPassed = d.starGate?.passed === true;
        const merged = [
          ...(Array.isArray(d.mergedTop) ? d.mergedTop : []),
          ...(cybPassed ? (d.markets?.cybMain || []) : []),
          ...(starPassed ? (d.markets?.star || []) : []),
        ];
        // 优先使用后端 pickCode（已应用 3日涨幅过热剔除与「涨幅领先但当日爆发力不足」顺延）
        const pick = (d.pickCode ? merged.find((s) => s.code === d.pickCode) : null)
          || merged.find((s) => s.isCandidate)
          || null;
        if (pick) stocks.push({ ...pick, isTechPick: true });
      } catch (e) {
        console.error('全局买点弹窗获取科技进攻标的失败:', e);
      }
    }
    // 情绪游资源（extreme_win / attack_defense）：顺周期完整买点股前三 + 逆周期择时触发股前三
    if (isExtreme || isDefense) {
      try {
        const res = await axios.post(`http://${local_ip}:3000/hot_money_leader_list`, { limit: 50 });
        const d = res.data?.data || {};
        const forward = (d.stocks || []).filter((s) => s.buyPointHit && !s.isLimitUp).slice(0, 3);
        const rev = ((d.reverse?.stocks) || []).filter((s) => s.timingPassed).slice(0, 3)
          .map((s) => ({ ...s, isReverse: true }));
        stocks.push(...forward, ...rev);
      } catch (e) {
        console.error('全局买点弹窗获取情绪游资标的失败:', e);
      }
    }
    return decorate(stocks);
  }, []);

  useEffect(() => {
    const unsubBuy = subscribeBuyPointPush((msg) => {
      if (msg?.open !== true || !msg.data) return;
      // 冰点转折延时到点：收起等待卡片，改由买点流水线弹窗展示本次要买入的个股
      if (msg.data.iceDelay) setIceAlert(null);
      const seq = ++seqRef.current;
      const mode = msg.mode || getStrategyMode();
      setBuyAlert({ mode, data: msg.data, bucket: msg.bucket ?? null, ts: msg.ts ?? null, stocks: [], loading: true });
      fetchBuyStocks(mode, msg.data)
        .then((stocks) => {
          if (seq !== seqRef.current) return; // 已有更新的触发，丢弃过期结果
          setBuyAlert((prev) => (prev ? { ...prev, stocks, loading: false } : prev));
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setBuyAlert((prev) => (prev ? { ...prev, stocks: [], loading: false } : prev));
        });
    });
    const unsubSell = subscribeSellPointPush((msg) => {
      if (msg?.open !== true || !msg.data) return;
      const hits = (msg.data.results || []).filter((r) => r && r.isSell === true);
      if (hits.length === 0) return;
      setSellAlert({ results: hits, ts: msg.ts ?? null });
    });
    // 冰点转折：买点触发后先展示「延时 15min 观察资金聚焦主线板块」等待卡片（补发消息同样展示）；
    // 延时到点转为「涨幅确认」阶段（phase='confirm'）同样展示，确认通过由买点弹窗接管，
    // 15:00 仍未确认（phase='giveup'）则收起卡片
    const unsubIce = subscribeIceDelayWaitPush((msg) => {
      const phase = msg?.data?.phase;
      if (!msg?.data || phase == null) return;
      if (phase === 'giveup') {
        setIceAlert(null);
        return;
      }
      if (phase !== 'wait' && phase !== 'confirm') return;
      // 过期的等待消息（补发时可能已到点买入）不再展示，窗口 = 延时 + 2 分钟（确认阶段持续到收盘，不做过期）
      if (phase === 'wait') {
        const delayMs = ((msg.data.delayMin ?? 15) + 2) * 60 * 1000;
        if (msg.ts && Date.now() - msg.ts > delayMs) return;
      }
      setIceAlert({ mode: msg.mode || getStrategyMode(), data: msg.data, ts: msg.ts ?? null });
    });
    // 极致赔率买点（首板起爆 / 二板起爆）：与科技进攻/情绪游资共用同一套买点流水线弹窗
    //   data.stocks 已带买入价/触发时间；data.checks 为线上真实阈值通过项
    const unsubWf = subscribeWashFusionBuyPush((msg) => {
      if (msg?.open !== true) return;
      const raw = Array.isArray(msg.data?.stocks) ? msg.data.stocks : [];
      const stocks = raw.map((s) => ({
        ...s,
        stockName: s.stockName || s.name,
        buyPrice: s.price != null ? Number(s.price) : (s.buyPrice ?? null),
      }));
      if (stocks.length === 0) return;
      setWfAlert({
        mode: MODE_WASH_FUSION,
        data: msg.data,
        stocks,
        loading: false,
        remind: msg.data?.remind === true,
        bucket: null,
        ts: msg.ts ?? null,
      });
    });
    return () => { unsubBuy(); unsubSell(); unsubIce(); unsubWf(); };
  }, [fetchBuyStocks]);

  const pipelineAlert = buyAlert || wfAlert;
  const closePipeline = () => {
    if (buyAlert) setBuyAlert(null);
    if (wfAlert) setWfAlert(null);
  };

  if (!pipelineAlert && !sellAlert && !iceAlert) return null;

  return (
    <div className="gda-container">
      {iceAlert && <IceWaitCard alert={iceAlert} onClose={() => setIceAlert(null)} />}
      {pipelineAlert && (
        <BuyPipelineModal
          key={`${pipelineAlert.mode}-${pipelineAlert.ts ?? 'new'}`}
          alert={pipelineAlert}
          onClose={closePipeline}
        />
      )}
      {sellAlert && <SellCard alert={sellAlert} onClose={() => setSellAlert(null)} />}
    </div>
  );
};

// ==================== 冰点转折延时观察卡片 ====================
// 阶段①（phase='wait'）：买点触发后提示延时 15min 观察资金聚焦主线板块；
// 阶段②（phase='confirm'）：延时到点已锁定个股，逐 5min 桶监控涨幅，须超过窗口最高涨幅 +1 个百分点才买入
const IceWaitCard = ({ alert, onClose }) => {
  const { mode, data } = alert;
  const delayMin = data?.delayMin ?? 15;
  const isConfirm = data?.phase === 'confirm';
  return (
    <div className="gda-card gda-ice">
      <div className="gda-header">
        <ClockCircleOutlined className="gda-header-icon ice" />
        <span className="gda-title">{isConfirm ? '冰点转折 · 涨幅确认' : '冰点转折 · 延时观察'}</span>
        <span className="gda-mode-badge">{MODE_LABELS[mode] || mode}</span>
        <CloseOutlined className="gda-close" onClick={onClose} />
      </div>
      <div className="gda-body">
        {/* ① 当前模式 */}
        <div className="gda-row">
          <span className="gda-label">当前模式</span>
          <span className="gda-value">{MODE_LABELS[mode] || mode}</span>
          {data?.mock && <span className="gda-hit-types">MOCK 测试</span>}
        </div>
        {/* ② 延时观察 / 涨幅确认提示 */}
        <div className="gda-section">
          <div className="gda-section-title">{isConfirm ? '涨幅确认提示' : '延时观察提示'}</div>
          <div className="gda-reason-detail">
            {data?.message || `冰点转折：买点已触发，需延时 ${delayMin} 分钟观察资金聚焦主线板块后再执行买入`}
          </div>
        </div>
        {/* ③ 时间安排 */}
        <div className="gda-section">
          <div className="gda-section-title">{isConfirm ? '确认安排' : '时间安排'}</div>
          <div className="gda-reason">
            <span className="gda-reason-name">买点触发时间</span>
            <span className="gda-reason-value">{data?.triggerTime || '--'}</span>
          </div>
          <div className="gda-reason">
            <span className="gda-reason-name">{isConfirm ? '延时结束时间' : '计划买入时间'}</span>
            <span className="gda-reason-value">{isConfirm
              ? (data?.executeTime || '--')
              : (data?.executeTime || '--') + `（延时 ${delayMin} 分钟）`}</span>
          </div>
          {isConfirm && (
            <>
              <div className="gda-reason">
                <span className="gda-reason-name">监控标的</span>
                <span className="gda-reason-value">{`${data?.stockName || '--'}（${data?.stockCode || '--'}）`}</span>
              </div>
              <div className="gda-reason">
                <span className="gda-reason-name">确认阈值</span>
                <span className="gda-reason-value">{`窗口最高 ${data?.windowMaxGain ?? '--'}% → 需 > ${data?.needGain ?? '--'}%`}</span>
              </div>
            </>
          )}
        </div>
        <div className="gda-footer">{isConfirm
          ? '每隔 5 分钟桶检查一次涨幅，超过阈值即推送买入；15:00 仍未超过则本次不买'
          : '到点后后端会自动推送要买入的个股，请保持页面打开'}</div>
      </div>
    </div>
  );
};

// ==================== 买点流水线弹窗 ====================
const PIPELINE_STEPS = [
  { key: 'market', title: '大盘总览', desc: '指数分时 · 自选股与重点板块', icon: <GlobalOutlined /> },
  { key: 'stock', title: '股票细览', desc: '命中标的 K 线与分时', icon: <LineChartOutlined /> },
  { key: 'confirm', title: '条件确认', desc: '买入条件逐项核对', icon: <CheckOutlined /> },
];

const BuyPipelineModal = ({ alert, onClose }) => {
  const { mode, data, stocks, loading, bucket, remind } = alert;
  const [step, setStep] = useState(0);
  const [stockIdx, setStockIdx] = useState(0);
  const [klineStock, setKlineStock] = useState(null);

  const isExtreme = mode === MODE_EXTREME_WIN;
  const isDefense = mode === MODE_ATTACK_DEFENSE;
  const isWf = mode === MODE_WASH_FUSION;

  // 命中源（攻防兼备三组并行，展示全部命中的策略）
  const hitTypes = isWf
    ? stocks
      .map((s) => {
        const label = s.sourceLabel || (s.source === 'second_board_wash' ? '二板起爆' : '首板起爆');
        return s.mode === 'auction'
          ? `${label}·竞价 ≥ ${data?.rules?.auctionBuyPct ?? 5}% · ${s.minute || '9:30'} 直接买入`
          : `${label}·盘中 +${data?.rules?.buyTriggerPct ?? 8}% 触发`;
      })
      .filter((t, i, arr) => arr.indexOf(t) === i)
    : isDefense
      ? [
        data?.tech?.allPassed === true && '科技进攻·快进快出',
        data?.allPassed === true && '情绪游资·顺周期',
        data?.reverse?.allPassed === true && '情绪游资·逆周期',
      ].filter(Boolean)
      : isExtreme
        ? [
          data?.allPassed === true && '情绪游资·顺周期',
          data?.reverse?.allPassed === true && '情绪游资·逆周期',
        ].filter(Boolean)
        : [
          data?.allPassed === true && '全部前置条件通过',
        ].filter(Boolean);

  // 标的数量变化时兜底，避免选中下标越界
  const safeStockIdx = Math.min(stockIdx, Math.max(0, stocks.length - 1));

  return (
    <>
      <Modal
        open
        onCancel={onClose}
        footer={null}
        width={1280}
        centered
        destroyOnClose
        closable={false}
        zIndex={2300}
        className="gdp-modal"
        styles={{ content: { padding: 0, background: 'transparent', boxShadow: 'none' }, body: { padding: 0 } }}
      >
        <div className="gda-card gda-buy gdp-card">
          <div className="gda-header">
            <ThunderboltOutlined className="gda-header-icon buy" />
            <span className="gda-title">买点诊断命中 · 买入流水线</span>
            <span className="gda-mode-badge">{MODE_LABELS[mode] || mode}</span>
            {isWf && remind && <span className="gda-hit-types">提前提醒 · 9:30 执行</span>}
            {hitTypes.length > 0 && <span className="gda-hit-types">命中：{hitTypes.join('、')}</span>}
            <CloseOutlined className="gda-close" onClick={onClose} />
          </div>

          <div className="gdp-body">
            {/* 流水线节点进程 */}
            <div className="gdp-steps">
              {PIPELINE_STEPS.map((s, i) => (
                <div
                  key={s.key}
                  className={`gdp-step${i === step ? ' is-active' : ''}${i < step ? ' is-done' : ''}`}
                  onClick={() => setStep(i)}
                >
                  <span className="gdp-step-dot">{i < step ? <CheckOutlined /> : s.icon}</span>
                  <span className="gdp-step-text">
                    <b>{`${i + 1}. ${s.title}`}</b>
                    <i>{s.desc}</i>
                  </span>
                  {i < PIPELINE_STEPS.length - 1 && <span className="gdp-step-line" />}
                </div>
              ))}
            </div>

            <div className="gdp-step-body">
              {step === 0 && <MarketOverview onStockClick={setKlineStock} />}
              {step === 1 && (
                <StockDetail
                  stocks={stocks}
                  loading={loading}
                  stockIdx={safeStockIdx}
                  onStockIdxChange={setStockIdx}
                  isWf={isWf}
                  data={data}
                />
              )}
              {step === 2 && (
                <ConditionConfirm
                  mode={mode}
                  data={data}
                  stocks={stocks}
                  loading={loading}
                  stockIdx={safeStockIdx}
                  isWf={isWf}
                  isExtreme={isExtreme}
                  isDefense={isDefense}
                  bucket={bucket}
                  remind={remind}
                />
              )}
            </div>

            <div className="gdp-nav">
              {step > 0 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
              <span className="gdp-nav-spacer" />
              {step < 2 && (
                <Button type="primary" onClick={() => setStep(step + 1)}>
                  {step === 0 ? '下一步：股票细览' : '下一步：条件确认'}
                </Button>
              )}
              {step === 2 && (
                <Button
                  type="primary"
                  size="large"
                  icon={<CheckOutlined />}
                  onClick={() => {
                    message.success('已确认买入，请按仓位执行下单');
                    onClose();
                  }}
                >
                  确认买入
                </Button>
              )}
            </div>

            <div className="gda-footer">
              诊断时间：{data?.timestamp || '--'}
              {bucket != null ? ` · 时间桶 ${String(bucket).slice(0, 2)}:${String(bucket).slice(2, 4)}` : ''}
              {isWf ? (remind ? ' · 竞价提醒（9:25-9:30 每 30 秒一次，9:30 执行买入）' : ` · ${data?.sourceLabel || '极致赔率'}买点`) : ''}
            </div>
          </div>
        </div>
      </Modal>

      {/* 大盘总览中点击股票 → K 线弹窗（层级高于流水线弹窗） */}
      <StockKLineModal
        visible={!!klineStock}
        onCancel={() => setKlineStock(null)}
        code={klineStock?.code}
        stockInfo={{ name: klineStock?.stockName || klineStock?.name, change: klineStock?.change }}
        zIndex={2400}
      />
    </>
  );
};

// ==================== 节点一：大盘总览 ====================
const MarketOverview = ({ onStockClick }) => (
  <div className="gdp-node">
    <div className="gda-section">
      <div className="gda-section-title">三大指数分时</div>
      <Row gutter={[12, 12]}>
        {INDEX_CHARTS.map((item) => (
          <Col key={item.code} xs={24} md={8}>
            <IndexMiniChart item={item} />
          </Col>
        ))}
      </Row>
    </div>

    <MarketBoards onStockClick={onStockClick} />
  </div>
);

// 单个指数分时：/stock_tline_data 拉取当日分时（每 60s 刷新）
const IndexMiniChart = ({ item }) => {
  const [line, setLine] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: item.code } });
        if (!alive) return;
        setLine(res.data?.line || []);
      } catch (e) {
        console.error(`获取 ${item.label} 分时数据失败:`, e);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [item.code, item.label]);

  const last = line.length > 0 ? line[line.length - 1] : null;
  const change = last?.change != null ? Number(last.change) : null;

  return (
    <div className="gdp-panel">
      <div className="gdp-panel-head">
        <span className="gdp-panel-name">{item.label}</span>
        <span className="gdp-panel-code">{item.code}</span>
        {change != null && (
          <span className={`gdp-panel-change ${change >= 0 ? 'up' : 'down'}`}>{fmtPct(change)}</span>
        )}
      </div>
      <div className="gdp-chart-box">
        {loading ? (
          <div className="gdp-chart-loading"><Spin size="small" /></div>
        ) : line.length > 0 ? (
          <StockTimeLine data={line} height={168} />
        ) : (
          <div className="gdp-chart-loading"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分时" /></div>
        )}
      </div>
    </div>
  );
};

// 自选股涨跌幅前十 + 重点板块涨跌幅前十（数据同盯盘页 /notice_data）
const MarketBoards = ({ onStockClick }) => {
  const navigate = useNavigate();
  const [allStockData, setAllStockData] = useState([]);
  const [blockData, setBlockData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`http://${local_ip}:3000/notice_data`);
      setAllStockData(Array.isArray(res.data?.allStockData) ? res.data.allStockData : []);
      setBlockData(res.data?.topAndBottomBlockData || null);
    } catch (e) {
      console.error('获取自选股 / 重点板块数据失败:', e);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 组件挂载后首次拉取看板数据
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  // 强制刷新：先让后端刷新自选股行情，再重新拉取看板数据
  const handleRefreshStocks = async () => {
    setRefreshing(true);
    try {
      await axios.post(`http://${local_ip}:3000/refresh_monitor_stock_data`);
      await load();
      message.success('自选股数据已刷新');
    } catch {
      message.error('刷新失败，请稍后重试');
    } finally {
      setRefreshing(false);
    }
  };

  // 强制刷新板块数据
  const handleRefreshBlocks = async () => {
    setRefreshing(true);
    try {
      await axios.post(`http://${local_ip}:3000/api/block/refresh`);
      await load();
      message.success('板块数据已强制刷新');
    } catch {
      message.error('板块数据刷新失败，请稍后重试');
    } finally {
      setRefreshing(false);
    }
  };

  // 板块成分股悬浮列表（内联样式，避免依赖盯盘页样式表）
  const renderBlockStockList = (blockDataItem) => {
    if (!blockDataItem || !Array.isArray(blockDataItem.data) || blockDataItem.data.length === 0) {
      return <div style={{ padding: 8, color: '#999' }}>暂无数据</div>;
    }
    return (
      <div style={{ maxHeight: 320, overflowY: 'auto', minWidth: 220 }}>
        {blockDataItem.data.map((stock, idx) => (
          <div
            key={`${stock.code || idx}`}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '4px 8px', cursor: 'pointer' }}
            onClick={() => onStockClick({ code: stock.code, stockName: stock.name, name: stock.name, change: stock.change })}
          >
            <span style={{ fontSize: 12, color: '#1f2937' }}>{stock.name}</span>
            <span style={{ fontSize: 12, fontFamily: 'SF Mono, monospace', color: stock.change >= 0 ? '#e11d48' : '#059669' }}>
              {stock.change > 0 ? '+' : ''}{stock.change}%
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="gda-section">
      <div className="gda-section-title">自选股涨跌幅前十 · 重点板块涨跌幅前十</div>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <div className="gdp-light-card">
            <WatchlistTopRanking
              stocks={allStockData}
              onStockClick={(s) => onStockClick({ ...s, stockName: s.stockName || s.name })}
              onRefresh={handleRefreshStocks}
              refreshing={refreshing}
            />
          </div>
        </Col>
        <Col xs={24} lg={12}>
          <div className="gdp-light-card">
            <BlockRankingCards
              topAndBottomBlockData={blockData}
              renderBlockStockList={renderBlockStockList}
              onBlockClick={(blockName) => navigate(`/block?blockName=${encodeURIComponent(blockName)}`)}
              onRefresh={handleRefreshBlocks}
              refreshing={refreshing}
              vertical
            />
          </div>
        </Col>
      </Row>
    </div>
  );
};

// ==================== 节点二：股票细览 ====================
const StockDetail = ({ stocks, loading, stockIdx, onStockIdxChange, isWf, data }) => {
  const current = stocks[stockIdx] || null;

  return (
    <div className="gdp-node">
      <div className="gda-section">
        <div className="gda-section-title">当前命中的要买入的股票</div>
        {loading ? (
          <div className="gda-loading">正在获取推荐标的与实时价格…</div>
        ) : stocks.length === 0 ? (
          <div className="gda-empty">当前无满足买点条件的可买标的。</div>
        ) : (
          <>
            {stocks.length > 1 && (
              <Segmented
                size="small"
                value={stockIdx}
                onChange={(v) => onStockIdxChange(Number(v))}
                options={stocks.map((s, i) => ({
                  label: `${s.stockName || s.name || s.code}${s.isReverse ? '（逆）' : ''}`,
                  value: i,
                }))}
                style={{ marginBottom: 10 }}
              />
            )}
            <div className="gda-stock">
              <div className="gda-stock-head">
                <b>{current.stockName || current.name}</b>
                <span className="gda-code">{current.code}</span>
                {(isWf || current.isReverse || current.isTechPick) && (
                  <span className="gda-tag">
                    {isWf
                      ? (current.sourceLabel || (current.source === 'second_board_wash' ? '二板起爆' : '首板起爆'))
                      : current.isReverse ? '逆周期 · 反向抱团' : '科技进攻'}
                  </span>
                )}
                {current.buyPrice != null ? (
                  <span className="gda-price">买入价格 <b>{Number(current.buyPrice).toFixed(2)}</b></span>
                ) : (
                  <span className="gda-price">买入价格 --</span>
                )}
              </div>
              <div className="gda-stock-meta">
                {isWf
                  ? `触发 ${current.minute || '--'} · 竞价 ${fmtPct(current.auctionGap)} · 当日 ${fmtPct(current.change)}`
                  : current.isReverse
                    ? `强度分 ${current.strengthScore != null ? Number(current.strengthScore).toFixed(2) : '--'} · ${current.timingTag || '--'}`
                    : current.isTechPick
                      ? `3日 ${fmtPct(current.change3d)} · 抗分歧 ${current.resilienceScore != null ? Number(current.resilienceScore).toFixed(2) : '--'}`
                      : `强度−差劲 ${current.delta != null ? Number(current.delta).toFixed(2) : '--'}`}
                {isWf && ` · ${washText(current.washout)}`}
                {!isWf && current.lianbanCount != null ? ` · ${current.lianbanCount} 连板` : ''}
                {current.priceChange != null ? ` · 当日 ${fmtPct(current.priceChange)}` : ''}
                {isWf && current.mode === 'auction' ? ` · 竞价 ≥ ${data?.rules?.auctionBuyPct ?? 5}%` : ''}
              </div>
            </div>

            <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
              <Col xs={24} xl={12}>
                <div className="gdp-chart-block">
                  <div className="gdp-chart-title"><BarChartOutlined /> 日 K 线</div>
                  <StockDetailCharts current={current} />
                </div>
              </Col>
              <Col xs={24} xl={12}>
                <div className="gdp-chart-block">
                  <div className="gdp-chart-title"><AreaChartOutlined /> 当日分时</div>
                  <StockDetailCharts current={current} timelineOnly />
                </div>
              </Col>
            </Row>
          </>
        )}
      </div>
    </div>
  );
};

// K 线 / 分时数据加载：同一 code 只拉一次数据，按 timelineOnly 分别渲染
const StockDetailCharts = ({ current, timelineOnly = false }) => {
  const [kline, setKline] = useState([]);
  const [line, setLine] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current?.code) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const [kRes, tRes] = await Promise.all([
          axios.get(`http://${local_ip}:3000/stock_data`, { params: { code: current.code } }),
          axios.get(`http://${local_ip}:3000/stock_tline_data`, { params: { code: current.code } }),
        ]);
        if (!alive) return;
        setKline(kRes.data || []);
        setLine(tRes.data?.line || []);
      } catch (e) {
        console.error('获取个股行情数据失败:', e);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [current?.code]);

  const height = 340;

  if (loading) {
    return <div className="gdp-chart-loading" style={{ height }}><Spin tip="正在加载行情数据..." /></div>;
  }

  if (timelineOnly) {
    return line.length > 0
      ? <StockTimeLine data={line} height={height} />
      : <div className="gdp-chart-loading" style={{ height }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分时数据" /></div>;
  }

  return kline.length > 0
    ? <StockKLine data={kline} height={height} />
    : <div className="gdp-chart-loading" style={{ height }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 K 线数据" /></div>;
};

// ==================== 节点三：条件确认 ====================
const ConditionConfirm = ({ mode, data, stocks, loading, stockIdx, isWf, isExtreme, isDefense, bucket, remind }) => {
  const current = stocks[stockIdx] || null;

  // 条件分组：攻防兼备展示三组；其余展示主条件（+ 逆周期条件）
  const groups = [];
  if (isDefense) {
    groups.push({ title: '科技进攻 · 买入条件', checks: data?.tech?.checks });
    groups.push({ title: '情绪游资 · 顺周期买入条件', checks: data?.checks });
    groups.push({ title: '情绪游资 · 逆周期（反向抱团）条件', checks: data?.reverseChecks });
  } else if (isWf) {
    groups.push({ title: '极致赔率 · 买入条件', checks: data?.checks });
  } else {
    groups.push({ title: '买入前置条件', checks: data?.checks });
    if (Array.isArray(data?.reverseChecks) && data.reverseChecks.length > 0) {
      groups.push({ title: '逆周期（反向抱团）条件', checks: data.reverseChecks });
    }
  }
  const hasChecks = groups.some((g) => Array.isArray(g.checks) && g.checks.length > 0);

  // 仓位说明
  const techPos = !isExtreme && !isWf ? buildTechPositionExplain(isDefense ? data?.tech : data) : null;
  const ewPos = (isExtreme || isDefense)
    ? { pos: '半仓（50%）', why: '情绪游资为双腿结构，顺周期、逆周期各半仓' }
    : null;
  const wfPos = isWf
    ? {
      pos: '半仓（50%）',
      why: (data?.positionHint || '').replace(/^半仓（50%）——/, '') || '账户拆两份、每份半仓，最多同时持有 2 只不同股票，各自独立买卖',
    }
    : null;

  const reverseReasons = collectBuyReasons(data?.reverseChecks);

  return (
    <div className="gdp-node">
      <div className="gda-section">
        <div className="gda-section-title">本次买入</div>
        {loading ? (
          <div className="gda-loading">正在获取推荐标的与实时价格…</div>
        ) : current ? (
          <div className="gda-stock">
            <div className="gda-stock-head">
              <b>{current.stockName || current.name}</b>
              <span className="gda-code">{current.code}</span>
              <span className="gda-tag">{MODE_LABELS[mode] || mode}</span>
              {current.buyPrice != null && (
                <span className="gda-price">买入价格 <b>{Number(current.buyPrice).toFixed(2)}</b></span>
              )}
            </div>
            <div className="gda-stock-meta">
              {current.priceChange != null ? `当日 ${fmtPct(current.priceChange)}` : '--'}
              {bucket != null ? ` · 时间桶 ${String(bucket).slice(0, 2)}:${String(bucket).slice(2, 4)}` : ''}
              {isWf && remind ? ' · 竞价提醒' : ''}
            </div>
          </div>
        ) : (
          <div className="gda-empty">当前无可买标的，请谨慎执行。</div>
        )}
      </div>

      <div className="gda-section">
        <div className="gda-section-title">建议仓位</div>
        {techPos && (
          <div className="gda-position">
            <span className="gda-pos-value">{techPos.pos}</span>
            <span className="gda-pos-why">科技进攻：{techPos.why}{isDefense ? '；两策略同时触发时科技进攻（快进快出）优先' : ''}</span>
          </div>
        )}
        {ewPos && (
          <div className="gda-position">
            <span className="gda-pos-value">{ewPos.pos}</span>
            <span className="gda-pos-why">情绪游资：{ewPos.why}{isDefense ? '；若科技进攻（快进快出）同时触发则其优先，本笔情绪游资暂缓' : ''}</span>
          </div>
        )}
        {wfPos && (
          <div className="gda-position">
            <span className="gda-pos-value">{wfPos.pos}</span>
            <span className="gda-pos-why">极致赔率：{wfPos.why}</span>
          </div>
        )}
      </div>

      <div className="gda-section">
        <div className="gda-section-title">买入条件核对</div>
        {!hasChecks ? (
          <div className="gda-empty">前置条件数据缺失</div>
        ) : groups.map((g) => (
          Array.isArray(g.checks) && g.checks.length > 0 && (
            <div key={g.title} className="gdp-cond-group">
              <div className="gdp-cond-group-title">{g.title}</div>
              {g.checks.map((c) => {
                const status = checkStatus(c);
                const detailText = checkDetailText(c);
                return (
                  <div key={`${g.title}-${c.id}`} className={`gdp-cond is-${status}`}>
                    <div className="gdp-cond-head">
                      {status === 'pass' && <CheckCircleFilled className="gdp-cond-icon" />}
                      {status === 'exempt' && <MinusCircleFilled className="gdp-cond-icon" />}
                      {status === 'fail' && <CloseCircleFilled className="gdp-cond-icon" />}
                      {status === 'unknown' && <MinusCircleFilled className="gdp-cond-icon" />}
                      <span className="gdp-cond-title">{c.title || c.id}</span>
                      <span className="gdp-cond-value">{c.value != null ? String(c.value) : '--'}</span>
                      <span className="gdp-cond-badge">
                        {status === 'pass' ? '已满足' : status === 'exempt' ? '豁免' : status === 'fail' ? '未满足' : '未知'}
                      </span>
                    </div>
                    {detailText && <div className="gdp-cond-detail">{detailText}</div>}
                  </div>
                );
              })}
            </div>
          )
        ))}
        {reverseReasons.length > 0 && !isDefense && (
          <div className="gdp-cond-group">
            <div className="gdp-cond-group-title">逆周期（反向抱团）触发理由</div>
            {reverseReasons.map((c) => (
              <div key={`rev-${c.id}`} className="gdp-cond is-pass">
                <div className="gdp-cond-head">
                  <CheckCircleFilled className="gdp-cond-icon" />
                  <span className="gdp-cond-title">{c.title}</span>
                  <span className="gdp-cond-value">{c.value || '--'}</span>
                  <span className="gdp-cond-badge">已满足</span>
                </div>
                {checkDetailText(c) && <div className="gdp-cond-detail">{checkDetailText(c)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 冰点转折 · 延时买入说明 */}
      {data?.iceDelay?.phase === 'ready' && (
        <div className="gda-section">
          <div className="gda-section-title">冰点转折 · 延时买入</div>
          <div className="gda-reason">
            <span className="gda-reason-name">触发 / 执行</span>
            <span className="gda-reason-value">{`${data.iceDelay.triggerTime || '--'} → ${data.iceDelay.executeTime || '--'}（延时 ${data.iceDelay.delayMin ?? 15} 分钟）`}</span>
          </div>
          <div className="gda-reason">
            <span className="gda-reason-name">资金聚焦板块</span>
            <span className="gda-reason-value">{data.iceDelay.board || '全量科技自选股（回退）'}</span>
          </div>
          {data.iceDelay.reason && <div className="gda-reason-detail">{data.iceDelay.reason}</div>}
        </div>
      )}
    </div>
  );
};

// ==================== 卖点卡片 ====================
const SellCard = ({ alert, onClose }) => {
  const { results, ts } = alert;
  const fmtReturn = (r) => {
    const close = r.detail?.closePrice;
    const cost = r.costPrice;
    if (close == null || cost == null || !Number.isFinite(Number(close)) || !Number.isFinite(Number(cost)) || Number(cost) <= 0) {
      return null;
    }
    return (((Number(close) - Number(cost)) / Number(cost)) * 100).toFixed(2);
  };
  return (
    <div className="gda-card gda-sell">
      <div className="gda-header">
        <WarningOutlined className="gda-header-icon sell" />
        <span className="gda-title">卖点诊断命中</span>
        <span className="gda-count-badge">{results.length} 笔持仓触发</span>
        <CloseOutlined className="gda-close" onClick={onClose} />
      </div>
      <div className="gda-body">
        {results.map((r) => {
          const ret = fmtReturn(r);
          const hitConds = (r.conditions || []).filter((c) => c && c.satisfied);
          return (
            <div key={r.positionId || r.code} className="gda-sell-stock">
              <div className="gda-stock-head">
                <b>{r.stockName}</b>
                <span className="gda-code">{r.code}</span>
                {r.weight != null && <span className="gda-tag">仓位 {r.weight}%</span>}
                {r.detail?.change !== undefined && r.detail?.change != null && (
                  <span className={`gda-change ${r.detail.change >= 0 ? 'up' : 'down'}`}>{fmtPct(r.detail.change)}</span>
                )}
              </div>
              {/* 卖出价格 */}
              <div className="gda-row">
                <span className="gda-label">卖出价格</span>
                <span className="gda-value">{r.detail?.closePrice != null ? Number(r.detail.closePrice).toFixed(2) : '--'}</span>
                {r.costPrice != null && <span className="gda-cost">成本线 {Number(r.costPrice).toFixed(2)}</span>}
              </div>
              {/* 本次收益率 */}
              <div className="gda-row">
                <span className="gda-label">本次收益率</span>
                {ret !== null ? (
                  <span className={`gda-return ${Number(ret) >= 0 ? 'up' : 'down'}`}>{Number(ret) > 0 ? '+' : ''}{ret}%</span>
                ) : (
                  <span className="gda-value">--（未设成本线）</span>
                )}
                {r.buyDate && (
                  <span className="gda-cost">买入 {r.buyDate}{r.buyTime ? ` ${r.buyTime}` : ''}</span>
                )}
              </div>
              {/* 卖出理由 */}
              <div className="gda-section">
                <div className="gda-section-title">卖出理由</div>
                {hitConds.length > 0 ? hitConds.map((c, idx) => (
                  <div key={idx} className="gda-reason">
                    <span className="gda-reason-name">{c.name}</span>
                    <div className="gda-reason-detail">{c.detail}</div>
                  </div>
                )) : (
                  (r.reasons && r.reasons.length > 0 ? r.reasons : [r.conclusion || '--']).map((reason, idx) => (
                    <div key={idx} className="gda-reason">
                      <div className="gda-reason-detail">{reason}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
        <div className="gda-footer">
          {ts ? `诊断时间 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
        </div>
      </div>
    </div>
  );
};

export default GlobalDiagnosisAlert;
