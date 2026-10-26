// 全局买点 / 卖点诊断弹窗卡片（挂载于 App 根组件，全页面生效）
//   后端命中买点 / 卖点且进入新的 5 分钟桶时经 WS 推送 open:true，本组件据此弹出卡片：
//     买点卡片：当前模式 / 要买入的股票与买入价格 / 建议仓位（含为何全仓或半仓的说明）/ 买入理由（资金净流入、量能等通过项）
//     卖点卡片：股票名称 / 卖出价格 / 卖出理由 / 本次收益率（按成本线计算）
//   抽屉（FloatingStockPosition）与页面内诊断卡片的数据展示不受影响，本组件只负责全局弹窗提醒。
import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { ThunderboltOutlined, WarningOutlined, CloseOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { local_ip } from '../../constant';
import { getStrategyMode, MODE_TECH_ATTACK, MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE } from '../../utils/strategyMode';
import { subscribeBuyPointPush, subscribeSellPointPush, subscribeIceDelayWaitPush } from '../../utils/buyPointWs';
import './index.scss';

const MODE_LABELS = {
  [MODE_TECH_ATTACK]: '科技进攻',
  [MODE_EXTREME_WIN]: '情绪游资',
  [MODE_ATTACK_DEFENSE]: '攻防兼备',
};

const fmtPct = (v) => {
  const num = Number(v);
  if (v === undefined || v === null || Number.isNaN(num)) return '--';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
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

const GlobalDiagnosisAlert = () => {
  // 买点卡片：{ mode, data, bucket, ts, stocks, loading }
  const [buyAlert, setBuyAlert] = useState(null);
  // 卖点卡片：{ results, ts }
  const [sellAlert, setSellAlert] = useState(null);
  // 冰点转折延时观察卡片：{ mode, data:{ triggerTime, executeTime, delayMin, message }, ts }
  const [iceAlert, setIceAlert] = useState(null);
  const seqRef = useRef(0); // 旧请求返回晚于新触发时丢弃过期结果

  // 拉取本次买点命中对应的推荐标的（含实时买入价格）
  //   MOCK 调试消息自带 buyable；实盘按模式取科技进攻 3 日涨幅榜唯一推荐 / 情绪游资顺周期前三 + 逆周期前三
  const fetchBuyStocks = useCallback(async (mode, data) => {
    const decorate = async (list) => {
      const withPrice = await Promise.all(list.map(async (s) => {
        const { price, change } = await fetchStockPrice(s.code);
        return { ...s, buyPrice: price, priceChange: s.change != null ? s.change : change };
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
    // 冰点转折：买点触发后先展示「延时 15min 观察资金聚焦主线板块」等待卡片（补发消息同样展示）
    const unsubIce = subscribeIceDelayWaitPush((msg) => {
      if (!msg?.data || msg.data.phase !== 'wait') return;
      // 过期的等待消息（补发时可能已到点买入）不再展示，窗口 = 延时 + 2 分钟
      const delayMs = ((msg.data.delayMin ?? 15) + 2) * 60 * 1000;
      if (msg.ts && Date.now() - msg.ts > delayMs) return;
      setIceAlert({ mode: msg.mode || getStrategyMode(), data: msg.data, ts: msg.ts ?? null });
    });
    return () => { unsubBuy(); unsubSell(); unsubIce(); };
  }, [fetchBuyStocks]);

  if (!buyAlert && !sellAlert && !iceAlert) return null;

  return (
    <div className="gda-container">
      {iceAlert && <IceWaitCard alert={iceAlert} onClose={() => setIceAlert(null)} />}
      {buyAlert && <BuyCard alert={buyAlert} onClose={() => setBuyAlert(null)} />}
      {sellAlert && <SellCard alert={sellAlert} onClose={() => setSellAlert(null)} />}
    </div>
  );
};

// ==================== 冰点转折延时观察卡片 ====================
// 买点触发且属冰点转折时，先提示延时 15min 观察资金聚焦主线板块，到点后由买点卡片给出个股
const IceWaitCard = ({ alert, onClose }) => {
  const { mode, data } = alert;
  const delayMin = data?.delayMin ?? 15;
  return (
    <div className="gda-card gda-ice">
      <div className="gda-header">
        <ClockCircleOutlined className="gda-header-icon ice" />
        <span className="gda-title">冰点转折 · 延时观察</span>
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
        {/* ② 延时观察提示 */}
        <div className="gda-section">
          <div className="gda-section-title">延时观察提示</div>
          <div className="gda-reason-detail">
            {data?.message || `冰点转折：买点已触发，需延时 ${delayMin} 分钟观察资金聚焦主线板块后再执行买入`}
          </div>
        </div>
        {/* ③ 时间安排 */}
        <div className="gda-section">
          <div className="gda-section-title">时间安排</div>
          <div className="gda-reason">
            <span className="gda-reason-name">买点触发时间</span>
            <span className="gda-reason-value">{data?.triggerTime || '--'}</span>
          </div>
          <div className="gda-reason">
            <span className="gda-reason-name">计划买入时间</span>
            <span className="gda-reason-value">{(data?.executeTime || '--') + `（延时 ${delayMin} 分钟）`}</span>
          </div>
        </div>
        <div className="gda-footer">到点后后端会自动推送要买入的个股，请保持页面打开</div>
      </div>
    </div>
  );
};

// ==================== 买点卡片 ====================
const BuyCard = ({ alert, onClose }) => {
  const { mode, data, stocks, loading, bucket } = alert;
  const isExtreme = mode === MODE_EXTREME_WIN;
  const isDefense = mode === MODE_ATTACK_DEFENSE;
  // 命中源（攻防兼备三组并行，展示全部命中的策略）
  const hitTypes = isDefense
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

  // 仓位说明：科技进攻按快进快出 / 抬高态 / 补买第二份分情形；情绪游资固定双腿半仓
  const techPos = !isExtreme ? buildTechPositionExplain(isDefense ? data?.tech : data) : null;
  const ewPos = (isExtreme || isDefense)
    ? { pos: '半仓（50%）', why: '情绪游资为双腿结构，顺周期、逆周期各半仓' }
    : null;

  const reasons = collectBuyReasons(isDefense ? data?.tech?.checks : data?.checks);
  const reverseReasons = collectBuyReasons(data?.reverseChecks);
  // 冰点转折延时买入（2026-10-23）：到点推送时携带 iceDelay（触发/执行时间 + 选中板块）
  const iceDelay = data?.iceDelay || null;

  return (
    <div className="gda-card gda-buy">
      <div className="gda-header">
        <ThunderboltOutlined className="gda-header-icon buy" />
        <span className="gda-title">买点诊断命中</span>
        <span className="gda-mode-badge">{MODE_LABELS[mode] || mode}</span>
        <CloseOutlined className="gda-close" onClick={onClose} />
      </div>
      <div className="gda-body">
        {/* ① 当前模式 */}
        <div className="gda-row">
          <span className="gda-label">当前模式</span>
          <span className="gda-value">{MODE_LABELS[mode] || mode}</span>
          {hitTypes.length > 0 && <span className="gda-hit-types">命中：{hitTypes.join('、')}</span>}
        </div>
        {/* ①-2 冰点转折 · 延时买入说明 */}
        {iceDelay?.phase === 'ready' && (
          <div className="gda-section">
            <div className="gda-section-title">冰点转折 · 延时买入</div>
            <div className="gda-reason">
              <span className="gda-reason-name">触发 / 执行</span>
              <span className="gda-reason-value">{`${iceDelay.triggerTime || '--'} → ${iceDelay.executeTime || '--'}（延时 ${iceDelay.delayMin ?? 15} 分钟）`}</span>
            </div>
            <div className="gda-reason">
              <span className="gda-reason-name">资金聚焦板块</span>
              <span className="gda-reason-value">{iceDelay.board || '全量科技自选股（回退）'}</span>
            </div>
            {iceDelay.reason && <div className="gda-reason-detail">{iceDelay.reason}</div>}
          </div>
        )}
        {/* ② 要买入的股票 + 买入价格 */}
        <div className="gda-section">
          <div className="gda-section-title">要买入的股票</div>
          {loading ? (
            <div className="gda-loading">正在获取推荐标的与实时价格…</div>
          ) : stocks.length === 0 ? (
            <div className="gda-empty">
              {iceDelay?.phase === 'ready'
                ? `延时 ${iceDelay.delayMin ?? 15} 分钟观察结束：全量科技自选股当前无满足买点条件的可买标的。`
                : isExtreme
                  ? '当前无顺周期完整买点标的，亦无逆周期反向抱团买点标的。'
                  : '当前无满足买点条件且未封涨停的可买标的。'}
            </div>
          ) : stocks.map((s) => {
            const asEw = isExtreme || (isDefense && !s.isTechPick);
            return (
              <div key={`${s.isReverse ? 'rev-' : ''}${s.code}`} className="gda-stock">
                <div className="gda-stock-head">
                  <b>{s.stockName || s.name}</b>
                  <span className="gda-code">{s.code}</span>
                  {asEw && (
                    <span className="gda-tag">{s.isReverse ? '逆周期 · 反向抱团' : '顺周期 · 龙头'}</span>
                  )}
                  {s.buyPrice != null ? (
                    <span className="gda-price">买入价格 <b>{s.buyPrice.toFixed(2)}</b></span>
                  ) : (
                    <span className="gda-price">买入价格 --</span>
                  )}
                </div>
                <div className="gda-stock-meta">
                  {s.isReverse
                    ? `强度分 ${s.strengthScore != null ? Number(s.strengthScore).toFixed(2) : '--'} · ${s.timingTag || '--'}`
                    : asEw
                      ? `强度−差劲 ${s.delta != null ? Number(s.delta).toFixed(2) : '--'}`
                      : `3日 ${fmtPct(s.change3d)} · 抗分歧 ${s.resilienceScore != null ? Number(s.resilienceScore).toFixed(2) : '--'}`}
                  {s.lianbanCount != null ? ` · ${s.lianbanCount} 连板` : ''}
                  {s.priceChange != null ? ` · 当日 ${fmtPct(s.priceChange)}` : ''}
                </div>
              </div>
            );
          })}
        </div>
        {/* ③ 仓位（含说明） */}
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
        </div>
        {/* ④ 买入理由 */}
        <div className="gda-section">
          <div className="gda-section-title">买入理由</div>
          {reasons.length === 0 ? (
            <div className="gda-empty">前置条件数据缺失</div>
          ) : reasons.map((c) => (
            <div key={c.id} className="gda-reason">
              <span className="gda-reason-name">{c.title}</span>
              <span className="gda-reason-value">{c.value || '--'}</span>
              {c.reason && <div className="gda-reason-detail">{c.reason}</div>}
            </div>
          ))}
          {reverseReasons.length > 0 && (
            <>
              <div className="gda-section-subtitle">逆周期（反向抱团）触发理由</div>
              {reverseReasons.map((c) => (
                <div key={`rev-${c.id}`} className="gda-reason">
                  <span className="gda-reason-name">{c.title}</span>
                  <span className="gda-reason-value">{c.value || '--'}</span>
                  {c.reason && <div className="gda-reason-detail">{c.reason}</div>}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="gda-footer">
          诊断时间：{data?.timestamp || '--'}
          {bucket != null ? ` · 时间桶 ${String(bucket).slice(0, 2)}:${String(bucket).slice(2, 4)}` : ''}
        </div>
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

export default GlobalDiagnosisAlert;
