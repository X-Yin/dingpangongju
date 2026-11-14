// 全局买点 / 卖点诊断提醒（挂载于 App 根组件，全页面生效）
//   后端命中买点 / 卖点且进入新的 5 分钟桶时经 WS 推送 open:true，本组件据此提醒：
//     买点：右下角弹出「买点诊断命中」精简卡片（股票名称 / 当前涨幅 / 策略命中 / 各策略核心指标，
//           买点条件明细默认隐藏，点击卡片底部三角箭头展开）
//     卖点：右下角卖点卡片（股票名称 / 卖出价格 / 卖出理由 / 本次收益率）
//   抽屉（FloatingStockPosition）与页面内诊断卡片的数据展示不受影响，本组件只负责全局提醒。
import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { Button, Modal, message } from 'antd';
import {
  ThunderboltOutlined,
  WarningOutlined,
  CloseOutlined,
  ClockCircleOutlined,
  CheckOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  MinusCircleFilled,
  CaretDownOutlined,
  CaretUpOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { local_ip } from '../../constant';
import { getStrategyMode, MODE_TECH_ATTACK, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE, MODE_WASH_FUSION } from '../../utils/strategyMode';
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { subscribeBuyPointPush, subscribeSellPointPush, subscribeIceDelayWaitPush, subscribeWashFusionBuyPush, subscribeStrategySignalPush, subscribeEmotionResonancePush } from '../../utils/buyPointWs';
import { isTradingDay } from '../../utils/tradingDay';
import './index.scss';

// 情绪游资-极致赔率（首板起爆 + 二板起爆）复用本组件的统一买点卡片，
// 走独立 WS 类型 wash_fusion_buy（不走策略模式 buy_point，避免串到页面内诊断）
const MODE_LABELS = {
  [MODE_TECH_ATTACK]: '科技进攻',
  [MODE_EXTREME_WIN]: '情绪游资',
  [MODE_ATTACK_DEFENSE]: '攻防兼备',
  [MODE_WASH_FUSION]: '情绪游资-极致赔率',
};

const fmtPct = (v) => {
  const num = Number(v);
  if (v === undefined || v === null || Number.isNaN(num)) return '--';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

// 卡片展示期间：按下任意方向键即关闭（与点击右上角 × 效果一致）
const useCloseOnArrowKey = (onClose) => {
  useEffect(() => {
    const handleArrowKeyDown = (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      // 捕获阶段拦截，避免同时触发 App 里「连按两次方向键切换路由」等其它快捷键
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', handleArrowKeyDown, true);
    return () => window.removeEventListener('keydown', handleArrowKeyDown, true);
  }, [onClose]);
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
  // 买点精简卡片：{ mode, data, bucket, ts, stocks, loading }
  const [buyAlert, setBuyAlert] = useState(null);
  // 卖点卡片：{ results, ts }
  const [sellAlert, setSellAlert] = useState(null);
  // 冰点转折延时观察卡片：{ mode, data:{ triggerTime, executeTime, delayMin, message }, ts }
  const [iceAlert, setIceAlert] = useState(null);
  // 极致赔率买点卡片：{ mode:'wash_fusion_extreme_odds', data, stocks, loading:false, remind, ts }
  const [wfAlert, setWfAlert] = useState(null);
  // 每交易日 9:05 候选池全局弹窗：{ firstBoard, secondBoard, rules, ... }
  const [wfCandidates, setWfCandidates] = useState(null);
  // 策略中心命中提醒卡片（2026-11-06 用户新增）：{ signals:[{ id, time, title, description, isBullish }], ts, mock }
  const [strategyAlert, setStrategyAlert] = useState(null);
  // 大盘 × 板块情绪共振弹窗（2026-11-07 用户新增）：{ data:{ date, marketTemperature, blocks:[...] }, ts, mock }
  const [resonanceAlert, setResonanceAlert] = useState(null);
  const seqRef = useRef(0); // 旧请求返回晚于新触发时丢弃过期结果

  // 每个交易日 9:05 自动弹出「情绪游资-极致赔率候选池」全局弹窗（不依赖当前策略模式，2026-11-04 用户新增）
  //   9:05-9:30 每 30s 检查一次：候选列表非空且当日未弹过 → 弹出并按日标记（localStorage）；
  //   首板 + 二板列表均为空（含数据未就绪）则不弹；超过 9:30 不再检查
  useEffect(() => {
    const todayKey = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const shownToday = () => {
      try { return localStorage.getItem(`wf_candidates_modal_shown_${todayKey()}`) === '1'; } catch { return false; }
    };
    const markShown = () => {
      try { localStorage.setItem(`wf_candidates_modal_shown_${todayKey()}`, '1'); } catch { /* 忽略 */ }
    };
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      const now = new Date();
      const minuteOfDay = now.getHours() * 60 + now.getMinutes();
      if (!isTradingDay(now) || shownToday()) return;
      if (minuteOfDay < 9 * 60 + 5 || minuteOfDay >= 9 * 60 + 30) return;
      try {
        const res = await axios.get(`http://${local_ip}:3000/wash_fusion_extreme_odds_snapshot`);
        const d = res.data?.data || null;
        const first = Array.isArray(d?.firstBoard) ? d.firstBoard : [];
        const second = Array.isArray(d?.secondBoard) ? d.secondBoard : [];
        // 首板 + 二板均为空 → 不弹（数据未就绪时由下一个 30s 周期重试，9:30 后放弃）
        if (first.length + second.length === 0) return;
        markShown();
        setWfCandidates(d);
        stopped = true;
      } catch (e) {
        console.error('9:05 候选池弹窗获取极致赔率快照失败:', e);
      }
    };
    check();
    const timer = setInterval(check, 30000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

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
        console.error('全局买点卡片获取科技进攻标的失败:', e);
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
        console.error('全局买点卡片获取情绪游资标的失败:', e);
      }
    }
    return decorate(stocks);
  }, []);

  useEffect(() => {
    const unsubBuy = subscribeBuyPointPush((msg) => {
      if (msg?.open !== true || !msg.data) return;
      // 冰点转折延时到点：收起等待卡片，改由买点卡片展示本次要买入的个股
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
    // 延时到点转为「涨幅确认」阶段（phase='confirm'）同样展示，确认通过由买点卡片接管，
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
    // 极致赔率买点（首板起爆 / 二板起爆）：与科技进攻/情绪游资共用同一张买点卡片
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
    // 策略中心命中：新命中信号广播时弹出全局提醒卡片（与悬浮策略球/抽屉互不影响）
    const unsubStrategy = subscribeStrategySignalPush((msg) => {
      if (msg?.open !== true || !msg?.data) return;
      const signals = Array.isArray(msg.data.signals) ? msg.data.signals.filter((s) => s && s.title) : [];
      if (signals.length === 0) return;
      setStrategyAlert({ signals, ts: msg.ts ?? null, mock: msg.mock === true });
    });
    // 大盘 × 板块情绪共振：大盘情绪温度 ≥60 且板块全面高潮/一致加速时弹出
    const unsubResonance = subscribeEmotionResonancePush((msg) => {
      if (msg?.open !== true || !msg?.data) return;
      const blocks = Array.isArray(msg.data.blocks) ? msg.data.blocks : [];
      if (blocks.length === 0) return;
      setResonanceAlert({ data: msg.data, ts: msg.ts ?? null, mock: msg.mock === true });
    });
    return () => { unsubBuy(); unsubSell(); unsubIce(); unsubWf(); unsubStrategy(); unsubResonance(); };
  }, [fetchBuyStocks]);

  const buyCardAlert = buyAlert || wfAlert;
  const closeBuyCard = () => {
    if (buyAlert) setBuyAlert(null);
    if (wfAlert) setWfAlert(null);
  };

  // 弹窗类提醒使用 antd Modal portal，不依赖 gda-container 渲染；
  // 因此只在没有任何卡片、仅一个 Modal 时，也必须返回一个能挂载 Modal 的根
  const hasCardAlert = buyCardAlert || sellAlert || iceAlert || wfCandidates || strategyAlert;
  if (!hasCardAlert && !resonanceAlert) return null;

  return (
    <div className="gda-container">
      {iceAlert && <IceWaitCard alert={iceAlert} onClose={() => setIceAlert(null)} />}
      {buyCardAlert && (
        <BuyAlertCard
          key={`${buyCardAlert.mode}-${buyCardAlert.ts ?? 'new'}`}
          alert={buyCardAlert}
          onClose={closeBuyCard}
        />
      )}
      {sellAlert && <SellCard alert={sellAlert} onClose={() => setSellAlert(null)} />}
      {/* 策略中心命中提醒：与买点诊断同风格的右下角全局卡片 */}
      {strategyAlert && <StrategySignalCard alert={strategyAlert} onClose={() => setStrategyAlert(null)} />}
      {/* 大盘 × 板块情绪共振：大盘情绪 ≥60 且板块全面高潮/一致加速时弹出 */}
      {resonanceAlert && (
        <EmotionResonanceModal alert={resonanceAlert} onClose={() => setResonanceAlert(null)} />
      )}
      {/* 每交易日 9:05 候选池全局弹窗 */}
      {wfCandidates && <WfCandidatesModal data={wfCandidates} onClose={() => setWfCandidates(null)} />}
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

// ==================== 每交易日 9:05 候选池全局弹窗 ====================
// 展示情绪游资-极致赔率当日候选：左列首板起爆、右列二板起爆；
// 首板 + 二板均为空时外层已保证不会打开本弹窗
const WfCandidatesModal = ({ data, onClose }) => {
  const first = data?.firstBoard || [];
  const second = data?.secondBoard || [];
  const rules = data?.rules || {};
  const basisDate = data?.basisDate || data?.date || '';
  const updatedAt = data?.updatedAt || '';
  const pct = (v) => {
    const num = Number(v);
    if (v == null || !Number.isFinite(num)) return '--';
    return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
  };

  const renderCol = (title, list) => (
    <div className="gda-wf-col">
      <div className="gda-wf-col-head">
        <span className="gda-wf-col-title">{title}</span>
        <span className="gda-wf-col-tag">{list.length} 只</span>
      </div>
      <div className="gda-wf-head">
        <span>#</span>
        <span>股票</span>
        <span>状态</span>
        <span>当日</span>
        <span>竞价</span>
        <span>总市值</span>
      </div>
      {list.length === 0 ? (
        <div className="gda-wf-empty">暂无候选</div>
      ) : list.map((s, i) => (
        <div key={`${s.code}-${i}`} className="gda-wf-row">
          <span className="gda-wf-rank">{i + 1}</span>
          <span className="gda-wf-name" title={`${s.name}（${s.board || s.code || ''}）`}>{s.name}</span>
          <span className={`gda-wf-status ${s.status === 'limit_open' ? 'is-limit' : 'is-buy'}`}>
            {s.status === 'limit_open' ? '涨停' : s.statusText || '买点触发'}
          </span>
          <span className={`gda-wf-pct ${Number(s.change) >= 0 ? 'up' : 'down'}`}>{pct(s.change)}</span>
          <span className={`gda-wf-pct ${Number(s.auctionGap) >= 0 ? 'up' : 'down'}`}>{pct(s.auctionGap)}</span>
          <span className="gda-wf-mv">{s.totalMvYi != null ? `${Number(s.totalMvYi).toFixed(2)}亿` : '--'}</span>
        </div>
      ))}
    </div>
  );

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={1160}
      centered
      zIndex={2200}
      title={`情绪游资-极致赔率 · 今日候选池（9:05 提醒）`}
    >
      <div className="gda-wf-modal-note">
        {basisDate ? `基准日 ${basisDate}` : ''}{updatedAt ? ` · 更新于 ${updatedAt}` : ''}
        ：竞价涨幅 ≥ {rules.auctionBuyPct ?? 5}% → 9:30 直接买入；否则盘中分时涨幅首次 ≥ {rules.buyTriggerPct ?? 8}% 触发买入
      </div>
      <div className="gda-wf-grid">
        {renderCol('首板起爆', first)}
        {renderCol('二板起爆', second)}
      </div>
    </Modal>
  );
};

// ==================== 买点命中精简卡片 ====================
// 2026-11-04：替代原「大盘总览 → 股票细览 → 条件确认」三步流水线弹窗。
// 核心内容突出：股票名称 / 当前涨幅 / 策略命中 / 各策略核心指标
//   （科技进攻：3日涨幅、抗分歧分数；情绪游资：强度分、差劲分、强度−差劲；极致赔率：竞价、触发时间、洗盘形态）
// 各买点条件明细默认隐藏，点击卡片底部三角箭头展开查看
const BuyAlertCard = ({ alert, onClose }) => {
  const { mode, data, stocks, loading, bucket, remind } = alert;
  const [expanded, setExpanded] = useState(false);

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
  const reverseReasons = collectBuyReasons(data?.reverseChecks);

  // 建议仓位（精简展示）
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

  // 个股所属策略命中标签
  const stockTag = (s) => {
    if (isWf) return s.sourceLabel || (s.source === 'second_board_wash' ? '二板起爆' : '首板起爆');
    if (s.isReverse) return '情绪游资·逆周期';
    if (s.isTechPick) return '科技进攻';
    return '情绪游资·顺周期';
  };

  // 个股核心指标 chips：按所属策略展示最关键的数值（抗分歧 / n日涨幅 / 强度分 / 差劲分 / 强度−差劲 等）
  const stockMetrics = (s) => {
    const chips = [];
    const push = (label, value, hl = false) => {
      if (value != null && value !== '--' && value !== '') chips.push({ label, value, hl });
    };
    if (isWf) {
      push('触发', s.minute);
      if (s.auctionGap != null) push('竞价', fmtPct(s.auctionGap));
      if (s.washout?.washDays != null) push('洗盘', `${s.washout.washDays} 个交易日`);
    } else if (s.isTechPick) {
      if (s.change3d != null) push('3日涨幅', fmtPct(s.change3d));
      if (s.resilienceScore != null) push('抗分歧', Number(s.resilienceScore).toFixed(2));
    } else if (s.isReverse) {
      if (s.strengthScore != null) push('强度分', Number(s.strengthScore).toFixed(2));
      push('择时', s.timingTag);
    } else {
      if (s.strengthScore != null) push('强度分', Number(s.strengthScore).toFixed(2));
      if (s.diffScore != null) push('差劲分', Number(s.diffScore).toFixed(2));
      if (s.delta != null) push('强度−差劲', Number(s.delta).toFixed(2), true);
    }
    if (s.buyPrice != null) push('买入价', Number(s.buyPrice).toFixed(2), true);
    if (s.lianbanCount != null && Number(s.lianbanCount) > 0) push('', `${s.lianbanCount} 连板`);
    return chips;
  };

  const currentChange = (s) => (s.priceChange != null ? s.priceChange : s.change);

  const handleConfirm = () => {
    message.success('已确认买入，请按仓位执行下单');
    onClose();
  };

  return (
    <div className="gda-card gda-buy">
      <div className="gda-header">
        <ThunderboltOutlined className="gda-header-icon buy" />
        <span className="gda-title">买点诊断命中</span>
        <span className="gda-mode-badge">{MODE_LABELS[mode] || mode}</span>
        {isWf && remind && <span className="gda-hit-types">提前提醒 · 9:30 执行</span>}
        {hitTypes.length > 0 && <span className="gda-hit-types">命中：{hitTypes.join('、')}</span>}
        <CloseOutlined className="gda-close" onClick={onClose} />
      </div>

      {/* 核心：股票名称 / 当前涨幅 / 策略命中 / 各策略核心指标 */}
      <div className="gda-body">
        {loading ? (
          <div className="gda-loading">正在获取推荐标的与实时价格…</div>
        ) : stocks.length === 0 ? (
          <div className="gda-empty">当前无满足买点条件的可买标的。</div>
        ) : stocks.map((s, idx) => (
          <div key={`${s.code}-${idx}`} className="gda-stock gda-buy-stock">
            <div className="gda-stock-head">
              <b className="gda-stock-name">{s.stockName || s.name}</b>
              <span className="gda-code">{s.code}</span>
              <span className="gda-tag">{stockTag(s)}</span>
              <span className={`gda-change ${Number(currentChange(s) ?? 0) >= 0 ? 'up' : 'down'}`}>
                {fmtPct(currentChange(s))}
              </span>
            </div>
            <div className="gda-metrics">
              {stockMetrics(s).map((m, i) => (
                <span key={i} className={`gda-metric${m.hl ? ' hl' : ''}`}>
                  {m.label ? <i>{m.label}</i> : null}
                  <b>{m.value}</b>
                </span>
              ))}
            </div>
          </div>
        ))}

        {/* 建议仓位（精简展示） */}
        {(techPos || ewPos || wfPos) && (
          <div className="gda-section">
            <div className="gda-section-title">建议仓位</div>
            {techPos && (
              <div className="gda-position">
                <span className="gda-pos-value">科技进攻 {techPos.pos}</span>
                <span className="gda-pos-why">{techPos.why}{isDefense ? '；两策略同时触发时科技进攻（快进快出）优先' : ''}</span>
              </div>
            )}
            {ewPos && (
              <div className="gda-position">
                <span className="gda-pos-value">情绪游资 {ewPos.pos}</span>
                <span className="gda-pos-why">{ewPos.why}{isDefense ? '；若科技进攻（快进快出）同时触发则其优先，本笔情绪游资暂缓' : ''}</span>
              </div>
            )}
            {wfPos && (
              <div className="gda-position">
                <span className="gda-pos-value">极致赔率 {wfPos.pos}</span>
                <span className="gda-pos-why">{wfPos.why}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 买点条件明细：默认隐藏，点击底部三角箭头展开 */}
      {expanded && (
        <div className="gda-details">
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
      )}

      {/* 卡片最下方：诊断时间 + 三角箭头（展开/收起条件明细）+ 确认买入 */}
      <div className="gda-bottom">
        <span className="gda-diag-time">
          诊断时间：{data?.timestamp || '--'}
          {bucket != null ? ` · 时间桶 ${String(bucket).slice(0, 2)}:${String(bucket).slice(2, 4)}` : ''}
          {isWf ? (remind ? ' · 竞价提醒' : ` · ${data?.sourceLabel || '极致赔率'}买点`) : ''}
        </span>
        <span
          className={`gda-expand${expanded ? ' open' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? '收起买点条件明细' : '展开买点条件明细'}
        >
          {expanded
            ? <CaretUpOutlined className="gda-expand-arrow" />
            : <CaretDownOutlined className="gda-expand-arrow" />}
          <span>条件明细</span>
        </span>
        <Button type="primary" size="small" icon={<CheckOutlined />} onClick={handleConfirm}>
          确认买入
        </Button>
      </div>
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

// ==================== 策略中心命中提醒卡片（2026-11-06 用户新增） ====================
// 后端策略轮询新命中时经 WS（type:'strategy_signal'）广播，本卡片以类似买点诊断的
// 全局卡片样式弹出提醒：策略名称 / 触发时间 / 利好利空 / 命中详情；
// 支持「全部已读」同步到策略中心记录；悬浮策略球与抽屉（FloatingStrategyCenter）不受影响
const StrategySignalCard = ({ alert, onClose }) => {
  const { signals, ts, mock } = alert;
  const [marking, setMarking] = useState(false);
  const sorted = [...signals].sort((a, b) => ((a.time || '') < (b.time || '') ? 1 : -1));
  useCloseOnArrowKey(onClose);

  const markAllRead = async () => {
    setMarking(true);
    try {
      await axios.post(`http://${local_ip}:3000/strategy_signals/read_all`);
      message.success('策略信号已全部标记为已读');
      onClose();
    } catch (e) {
      message.error(`标记已读失败：${e.message}`);
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="gda-card gda-strategy">
      <div className="gda-header">
        <BulbOutlined className="gda-header-icon strategy" />
        <span className="gda-title">策略命中提醒</span>
        <span className="gda-count-badge strategy">{sorted.length} 条新信号</span>
        {mock && <span className="gda-mock-badge">MOCK 测试</span>}
        <CloseOutlined className="gda-close" onClick={onClose} />
      </div>
      <div className="gda-body">
        {sorted.map((s) => (
          <div key={s.id || `${s.strategyId}-${s.time}`} className={`gda-sig-item ${s.isBullish ? 'is-bullish' : 'is-bearish'}`}>
            <div className="gda-sig-head">
              <span className={`gda-sig-tag ${s.isBullish ? 'up' : 'down'}`}>{s.isBullish ? '利好' : '利空'}</span>
              <b className="gda-sig-title">{s.title}</b>
              <span className="gda-sig-time">{s.time ? s.time.slice(11, 16) || s.time : '--'}</span>
            </div>
            <div className="gda-sig-desc" dangerouslySetInnerHTML={{ __html: s.description || '' }} />
          </div>
        ))}
        <div className="gda-footer">
          <span>{ts ? `触发时间 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>
          <Button
            type="primary"
            size="small"
            ghost
            icon={<CheckOutlined />}
            loading={marking}
            onClick={markAllRead}
            className="gda-strategy-read-btn"
          >
            全部已读
          </Button>
        </div>
      </div>
    </div>
  );
};

// ==================== 大盘 × 板块 情绪共振弹窗 ====================
// 后端每 5 分钟（block_amount_poll 触发）计算即时情绪周期，大盘情绪温度 ≥60 且板块达到
// 全面高潮 / 一致加速时广播：
//   { type:'emotion_resonance', ts, open:true, data:{ date, marketTemperature, threshold,
//     blocks:[{ board, phase, count, ratio, prevRatio, deltaRatio, reason }] } }
const RESONANCE_PHASE_COLOR = {
  全面高潮: '#f43f5e',
  一致加速: '#f59e0b',
};

const formatResonanceDate = (ymd) => {
  const s = String(ymd || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

// 板块情绪周期相位 → 0~4 数值（与四维立体口径一致）
const RESONANCE_PHASE_SCORE = {
  一致加速: 4,
  全面高潮: 3,
  爆量分歧: 2,
  弱势震荡: 1,
  退潮: 0,
};
const RESONANCE_PHASE_NAMES = ['退潮', '弱势震荡', '爆量分歧', '全面高潮', '一致加速'];

// 弹窗内的板块情绪周期折线（近 10 个交易日）：视觉与四维立体的板块情绪周期图一致
const ResonanceCycleChart = ({ cycle = [], color = '#67e8f9' }) => {
  const wrapRef = useRef(null);
  // 右侧 5 个情绪阶段标签的像素位置（自己绘制，避免库自动省略刻度文字导致阶段展示不全）
  const [axisLabels, setAxisLabels] = useState([]);
  // 十字光标 tooltip：{ date, phase, count, ratio, temp }
  const [tip, setTip] = useState(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;

    const toTime = (ymd) => `${String(ymd).slice(0, 4)}-${String(ymd).slice(4, 6)}-${String(ymd).slice(6, 8)}`;
    const items = (Array.isArray(cycle) ? cycle : [])
      .filter((item) => item && RESONANCE_PHASE_SCORE[item.phase] !== undefined && String(item.date).length === 8)
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const data = items.map((item) => ({
      time: toTime(item.date),
      value: RESONANCE_PHASE_SCORE[item.phase],
    }));

    const chart = createChart(wrap, {
      width: wrap.clientWidth || 560,
      height: 180,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.82)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.08)' },
        horzLines: { color: 'rgba(255,255,255,0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.45)', style: LineStyle.Dashed, labelBackgroundColor: '#334155' },
        horzLine: { color: 'rgba(255,255,255,0.45)', style: LineStyle.Dashed, labelBackgroundColor: '#334155' },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: true },
      rightPriceScale: {
        visible: false,
        borderColor: 'rgba(255,255,255,0.18)',
        scaleMargins: { top: 0.16, bottom: 0.12 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.18)',
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time) => {
          const s = typeof time === 'string'
            ? time
            : (time && time.year
              ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
              : '');
          return s.length >= 10 ? `${s.slice(5, 7)}/${s.slice(8, 10)}` : s;
        },
      },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (p) => RESONANCE_PHASE_NAMES[Math.round(Number(p))] || '',
        timeFormatter: (time) => {
          if (typeof time === 'string') return time;
          if (time && time.year) {
            return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
          }
          return '';
        },
      },
    });

    const line = chart.addLineSeries({
      color,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      priceFormat: {
        type: 'custom',
        formatter: (p) => RESONANCE_PHASE_NAMES[Math.round(Number(p))] || '',
        minMove: 1,
      },
      // 固定 0~4，保证「退潮 / 弱势震荡 / 爆量分歧 / 全面高潮 / 一致加速」刻度完整
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 4 } }),
    });
    line.setData(data);
    // 标注大盘情绪 ≥ 60° 的交易日（文字：大盘 xx°）
    const hotMarkers = items
      .filter((item) => Number(item.marketTemperature) >= 60)
      .map((item) => ({
        time: toTime(item.date),
        position: 'aboveBar',
        color: '#fbbf24',
        shape: 'circle',
        size: 0.5,
        text: `大盘 ${Math.round(Number(item.marketTemperature))}°`,
      }));
    if (hotMarkers.length) line.setMarkers(hotMarkers);

    chart.timeScale().fitContent();

    // 按 0~4 与 scaleMargins 计算 5 个阶段标签的纵向位置
    const paneHeight = 180 - (chart.timeScale().height?.() || 26);
    const plotTop = paneHeight * 0.16;
    const plotBottom = paneHeight * (1 - 0.12);
    setAxisLabels(RESONANCE_PHASE_NAMES.map((name, value) => ({
      name,
      top: plotTop + ((4 - value) / 4) * (plotBottom - plotTop),
    })));

    // 鼠标移动显示 tooltip：按横坐标取最近的交易日
    const onMouseMove = (ev) => {
      const rect = wrap.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (!items.length || x < 0 || y < 0 || x > rect.width || y > rect.height) {
        setTip(null);
        return;
      }
      const logical = chart.timeScale().coordinateToLogical(x);
      if (logical === null || logical === undefined || !Number.isFinite(Number(logical))) {
        setTip(null);
        return;
      }
      const idx = Math.min(items.length - 1, Math.max(0, Math.round(Number(logical))));
      const item = items[idx];
      setTip({
        date: String(item.date),
        phase: item.phase,
        count: item.count,
        ratio: item.ratio,
        temp: item.marketTemperature,
      });
    };
    const onMouseLeave = () => setTip(null);
    wrap.addEventListener('mousemove', onMouseMove);
    wrap.addEventListener('mouseleave', onMouseLeave);

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: wrap.clientWidth || 560 });
    });
    ro.observe(wrap);

    return () => {
      ro.disconnect();
      wrap.removeEventListener('mousemove', onMouseMove);
      wrap.removeEventListener('mouseleave', onMouseLeave);
      chart.remove();
    };
  }, [cycle, color]);

  return (
    <div style={{ position: 'relative', paddingRight: 62 }}>
      <div ref={wrapRef} style={{ width: '100%', height: 180 }} />
      <div style={{ position: 'absolute', right: 0, top: 0, width: 60, height: 180, pointerEvents: 'none' }}>
        {axisLabels.map((label) => (
          <span
            key={label.name}
            style={{
              position: 'absolute',
              top: label.top - 7,
              right: 2,
              fontSize: 10,
              lineHeight: '14px',
              color: 'rgba(255,255,255,0.72)',
              whiteSpace: 'nowrap',
            }}
          >
            {label.name}
          </span>
        ))}
      </div>
      {tip && (
        <div
          style={{
            position: 'absolute',
            left: 8,
            top: 8,
            zIndex: 5,
            pointerEvents: 'none',
            padding: '6px 8px',
            borderRadius: 6,
            background: 'rgba(15, 23, 42, 0.92)',
            border: '1px solid rgba(255,255,255,0.16)',
            color: '#fff',
            fontSize: 11,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: 'rgba(255,255,255,0.65)' }}>{formatResonanceDate(tip.date)}</div>
          <div style={{ fontWeight: 700, color: RESONANCE_PHASE_COLOR[tip.phase] || '#fff' }}>{tip.phase}</div>
          <div>
            涨停 {tip.count ?? '--'} · 占比 {tip.ratio != null ? `${Number(tip.ratio).toFixed(2)}%` : '--'}
          </div>
          {Number.isFinite(Number(tip.temp)) && (
            <div style={{ color: Number(tip.temp) >= 60 ? '#fbbf24' : 'rgba(255,255,255,0.65)' }}>
              大盘 {Math.round(Number(tip.temp))}°
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const RESONANCE_LINE_COLORS = ['#f87171', '#60a5fa', '#facc15'];

const EmotionResonanceModal = ({ alert, onClose }) => {
  const { data, mock } = alert || {};
  const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
  const temp = Number(data?.marketTemperature);
  return (
    <Modal
      open
      onCancel={onClose}
      width={640}
      destroyOnClose
      title={(
        <span>
          <ThunderboltOutlined style={{ color: '#f59e0b', marginRight: 8 }} />
          大盘 × 板块 情绪共振{mock ? '（MOCK）' : ''}
        </span>
      )}
      footer={<Button type="primary" onClick={onClose}>知道了</Button>}
    >
      <div style={{ fontSize: 13, color: '#595959', marginBottom: 12 }}>
        {data?.date ? `${formatResonanceDate(data.date)}｜` : ''}
        大盘情绪温度{' '}
        <b style={{ color: '#f43f5e', fontSize: 15 }}>
          {Number.isFinite(temp) ? `${Math.round(temp)}°` : '--'}
        </b>
        {data?.threshold ? `（阈值 ${data.threshold}°）` : ''}，以下板块与大盘发生共振：
      </div>
      {blocks.map((b, idx) => {
        const phaseColor = RESONANCE_PHASE_COLOR[b.phase] || '#94a3b8';
        const delta = Number(b.deltaRatio);
        return (
          <div
            key={b.board}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              background: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.35)',
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700 }}>
              <span>{b.board}</span>
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: phaseColor,
                  padding: '1px 8px',
                  borderRadius: 999,
                  background: `${phaseColor}1f`,
                  border: `1px solid ${phaseColor}59`,
                }}
              >
                {b.phase}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: '#595959', marginTop: 4 }}>
              涨停 {b.count ?? '--'} 家，成交量占比绝对值 {b.ratio != null ? `${Number(b.ratio).toFixed(2)}%` : '--'}，
              相较上一日
              {Number.isFinite(delta)
                ? ` ${delta >= 0 ? '增加' : '减少'} ${Math.abs(delta).toFixed(2)}%`
                : ' --'}
            </div>
            {/* 板块情绪周期（近 10 个交易日）：与四维立体的板块情绪周期折线一致 */}
            {Array.isArray(b.cycle) && b.cycle.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11.5, color: '#8c8c8c', marginBottom: 4 }}>
                  板块情绪周期（近 {b.cycle.length} 个交易日）
                </div>
                <div
                  style={{
                    borderRadius: 10,
                    padding: '6px 4px 0',
                    background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
                  }}
                >
                  <ResonanceCycleChart
                    cycle={b.cycle}
                    color={RESONANCE_LINE_COLORS[idx % RESONANCE_LINE_COLORS.length]}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Modal>
  );
};

export default GlobalDiagnosisAlert;
