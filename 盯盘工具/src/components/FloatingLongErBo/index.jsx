import { useState, useEffect, useRef } from 'react';
import { Drawer, Empty, Badge, Spin } from 'antd';
import { ThunderboltOutlined, AimOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { Button } from 'antd';
import { isAfterMarketClose } from '../../utils/tradingDay';
import { fetchAbnormalBasis, fetchIndexQuotes, getAbnormalWindowRows } from '../../utils/abnormalAlert';
import { local_ip } from '../../constant';
import StockKLineModal from '../StockKLineModal';
import './index.scss';

// 龙二波悬浮组件：监控「情绪游资-极致胜率」顺周期 + 逆周期候选股列表（/hot_money_leader_list）
// 交易日交易时间每 1min 刷新一次；一旦有顺周期候选股命中「强度分 − 差劲分 ≥ 30」（含涨停股），
// 抽屉自动弹出并在顶部以卡片提示命中个股。
// 点击股票名称打开通用 K 线弹窗（StockKLineModal，含异动查询按钮）。

const POLL_INTERVAL = 60 * 1000;
const DELTA_MIN = 30;

// 候选股排名口径（2026-11-14 用户要求）：顺周期 / 逆周期均按「强度分 − 差劲分」（delta）降序排名，
// 缺失 delta 的排在最后；临近异动（10/30 日窗口剩余涨幅 ≤ 10%）的个股已由后端过滤，前端不再处理
const deltaRankValue = (s) => {
  const v = s?.delta;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : -Infinity;
};
const byDeltaDesc = (a, b) => deltaRankValue(b) - deltaRankValue(a);

const FloatingLongErBo = () => {
  const [stocks, setStocks] = useState([]);        // 顺周期候选股列表（已按 delta 降序）
  const [reverseStocks, setReverseStocks] = useState([]); // 逆周期（反向抱团）候选股列表
  const [reverseMeta, setReverseMeta] = useState(null);   // { slopeClose, eligible }
  const [meta, setMeta] = useState(null);          // { date, minute, indexSlope }
  const [abnormalBasis, setAbnormalBasis] = useState({}); // 各股异动基准（10/30 交易日期初价 + 对应指数基准）
  const [indexQuotes, setIndexQuotes] = useState({});     // 分类指数实时点位
  const [hits, setHits] = useState([]);            // 今日命中卡片（新命中在前）
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [loading, setLoading] = useState(false);
  // 通用 K 线弹窗
  const [selectedStock, setSelectedStock] = useState(null);
  const [klineVisible, setKlineVisible] = useState(false);
  // 默认位于「监控」悬浮按钮上方
  const [pos, setPos] = useState({
    x: window.innerWidth - 76,
    y: Math.max(0, window.innerHeight / 2 - 28 - 78),
  });
  const [now, setNow] = useState(new Date());
  const seenRef = useRef(new Set());               // 今日已提示命中过的 code
  const dragRef = useRef({ dragging: false, moved: false, offsetX: 0, offsetY: 0, startX: 0, startY: 0 });
  const containerRef = useRef(null);

  const handleMouseDown = (e) => {
    dragRef.current = {
      dragging: true,
      moved: false,
      offsetX: e.clientX - pos.x,
      offsetY: e.clientY - pos.y,
      startX: e.clientX,
      startY: e.clientY,
    };
    document.body.style.userSelect = 'none';
    if (containerRef.current) {
      containerRef.current.style.transition = 'none';
      containerRef.current.style.willChange = 'left, top';
    }
  };

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current.dragging || !containerRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragRef.current.moved = true;
      }
      const x = e.clientX - dragRef.current.offsetX;
      const y = e.clientY - dragRef.current.offsetY;
      const maxX = window.innerWidth - 72;
      const maxY = window.innerHeight - 72;
      const newX = Math.max(0, Math.min(x, maxX));
      const newY = Math.max(0, Math.min(y, maxY));
      containerRef.current.style.left = `${newX}px`;
      containerRef.current.style.top = `${newY}px`;
    };
    const handleUp = () => {
      if (!dragRef.current.dragging) return;
      dragRef.current.dragging = false;
      document.body.style.userSelect = '';
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setPos({ x: rect.left, y: rect.top });
        containerRef.current.style.transition = '';
        containerRef.current.style.willChange = '';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const handleClick = () => {
    // 拖动则不触发点击
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    setDrawerOpen(true);
  };

  const fetchData = async (force = false) => {
    setLoading(true);
    try {
      // force=true：后端绕开缓存强制重算强度分/差劲分
      const res = await axios.post(`http://${local_ip}:3000/hot_money_leader_list`, { limit: 50, force });
      const d = res.data?.data;
      const list = Array.isArray(d?.stocks) ? d.stocks : [];
      const reverse = d?.reverse;
      const reverseList = Array.isArray(reverse?.stocks) ? reverse.stocks : [];
      setStocks(list);
      setReverseStocks(reverseList);
      setReverseMeta(reverse ? { slopeClose: reverse.slopeClose, eligible: reverse.eligible } : null);
      setMeta({ date: d?.date, minute: d?.minute, indexSlope: d?.indexSlope });
      // 命中检测：顺周期 + 逆周期候选「强度分 − 差劲分 ≥ 30」（涨停股同样提示）
      const newHits = [];
      [
        [list, '顺周期'],
        [reverseList, '逆周期'],
      ].forEach(([arr, group]) => {
        arr.forEach((s) => {
          const delta = s?.delta != null ? Number(s.delta) : null;
          if (delta != null && Number.isFinite(delta) && delta >= DELTA_MIN && s.code && !seenRef.current.has(s.code)) {
            seenRef.current.add(s.code);
            newHits.push({
              code: s.code,
              name: s.stockName,
              group,
              delta,
              strength: s.strengthScore,
              diff: s.diffScore,
              isLimitUp: !!s.isLimitUp,
              change: s.change,
              lianban: s.lianbanCount,
              time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            });
          }
        });
      });
      if (newHits.length > 0) {
        setHits((prev) => [...newHits, ...prev]);
        // 仅交易时间自动弹出抽屉（含闪烁提醒）；非交易时间只累积卡片、不弹出不打扰
        // 每只股票命中后当日只自动弹出一次（seenRef 已按 code 去重）
        if (!isAfterMarketClose()) {
          setBlinking(true);
          if (!force) setDrawerOpen(true); // 轮询命中即自动弹出抽屉；手动刷新不抢焦点
        }
      }
      // 异动数据（10/30 日窗口基准 + 对应分类指数实时点位），供「距异动还差涨幅」实时计算
      const codes = [...list, ...reverseList]
        .map((s) => String(s?.code || '').toLowerCase())
        .filter((c) => /^(sh|sz)\d{6}$/.test(c));
      if (codes.length > 0) {
        const [basisData, quotes] = await Promise.all([
          fetchAbnormalBasis(codes).catch(() => ({})),
          fetchIndexQuotes().catch(() => ({})),
        ]);
        setAbnormalBasis(basisData || {});
        setIndexQuotes(quotes || {});
      }
    } catch (e) {
      console.error('获取龙二波候选列表失败:', e);
    } finally {
      setLoading(false);
    }
  };

  // 交易日交易时间每 1min 轮询（挂载立即拉一次）
  useEffect(() => {
    fetchData();
    const timer = setInterval(() => {
      if (!isAfterMarketClose()) fetchData();
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 实时时间每秒更新
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // 打开抽屉时停止闪烁
  useEffect(() => {
    if (drawerOpen) setBlinking(false);
  }, [drawerOpen]);

  const fmtChange = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
    ? '--'
    : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const fmtNum = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : Number(v).toFixed(2));

  // 10/30 日异动列：交易所口径偏离值 = 个股区间涨跌幅 − 对应指数区间涨跌幅；
  // 「还差多少涨幅」= 异动价相对现价还需的涨幅（needPct），已触发单独标注
  const getAbnormalCols = (s) => {
    const basis = abnormalBasis[String(s?.code || '').toLowerCase()];
    const price = Number(s?.px);
    if (!basis || !Number.isFinite(price) || price <= 0) return { d10: null, d30: null };
    const idxQuote = indexQuotes?.[basis.indexCode];
    const rows = getAbnormalWindowRows(basis, price, idxQuote);
    return {
      d10: rows.find((r) => r.days === 10) || null,
      d30: rows.find((r) => r.days === 30) || null,
    };
  };

  const renderAbnormalCell = (row, title) => {
    if (!row || row.needPct == null) return <span className="flb-col-abn" title={title}>--</span>;
    if (row.triggered) return <span className="flb-col-abn triggered" title={title}>已触发</span>;
    return (
      <span className={`flb-col-abn ${row.near ? 'near' : ''}`} title={title}>
        {`${Math.round(row.needPct)}%`}
      </span>
    );
  };

  // 临近异动过滤已下沉到后端（/hot_money_leader_list），这里只按「强度分 − 差劲分」降序排名
  const visibleStocks = stocks.slice().sort(byDeltaDesc);
  const visibleReverse = reverseStocks.slice().sort(byDeltaDesc);

  // 候选股列表区块（顺周期 / 逆周期共用；点击股票名称打开通用 K 线弹窗）
  const renderSection = (title, list, extra, keyPrefix) => (
    <div className="flb-section">
      <div className="flb-list-head">
        <span>{title} {list.length > 0 ? `(${list.length})` : ''}</span>
        {extra}
        {loading && <Spin size="small" style={{ marginLeft: 8 }} />}
      </div>
      {list.length === 0 ? (
        <Empty description="暂无候选股" imageStyle={{ height: 48 }} />
      ) : (
        <div className="flb-stock-list">
          <div className="flb-stock-row flb-stock-head">
            <span className="flb-col-rank">#</span>
            <span className="flb-col-name">股票</span>
            <span className="flb-col-delta">强度−差劲</span>
            <span className="flb-col-change">当日</span>
            <span className="flb-col-lianban">连板</span>
            <span className="flb-col-abn">10日异动</span>
            <span className="flb-col-abn">30日异动</span>
          </div>
          {list.map((s, idx) => {
            const delta = s?.delta != null ? Number(s.delta) : null;
            const hit = delta != null && delta >= DELTA_MIN;
            const { d10, d30 } = getAbnormalCols(s);
            return (
              <div className={`flb-stock-row ${hit ? 'hit' : ''}`} key={`${keyPrefix}-${s.code}-${idx}`}>
                <span className={`flb-col-rank ${idx < 3 ? 'top' : ''}`}>{idx + 1}</span>
                <span className="flb-col-name">
                  <span
                    className="flb-stock-name clickable"
                    title="点击查看K线"
                    onClick={() => { setSelectedStock({ code: s.code, stockName: s.stockName, change: s.change }); setKlineVisible(true); }}
                  >{s.stockName}</span>
                  {s.isLimitUp && <span className="flb-limitup-tag">涨停</span>}
                </span>
                <span className={`flb-col-delta ${hit ? 'hit-val' : ''}`}>{fmtNum(delta)}</span>
                <span className={`flb-col-change ${Number(s.change) >= 0 ? 'up' : 'down'}`}>{fmtChange(s.change)}</span>
                <span className="flb-col-lianban">{s.lianbanCount != null ? `${s.lianbanCount} 板` : '--'}</span>
                {renderAbnormalCell(d10, '距离触发10日异动（连续10个交易日累计偏离值≥+100%）还差的涨幅')}
                {renderAbnormalCell(d30, '距离触发30日异动（连续30个交易日累计偏离值≥+200%）还差的涨幅')}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        ref={containerRef}
        className={`floating-long-erbo ${blinking ? 'blinking' : ''}`}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        <div className="flb-content">
          <Badge count={hits.length} size="small" offset={[-2, 2]} overflowCount={99}>
            <div className="flb-icon-wrap">
              <ThunderboltOutlined className="flb-icon" />
            </div>
          </Badge>
          <span className="flb-label">龙二波</span>
        </div>
      </div>

      <Drawer
        title={(
          <span>
            <AimOutlined style={{ color: '#f5222d', marginRight: 6 }} />
            龙二波 · 情绪游资-极致胜率候选
            <span className="flb-live-time">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span>
          </span>
        )}
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={780}
        className="long-erbo-drawer"
        extra={(
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => fetchData(true)}
            title="强制重算强度分/差劲分并刷新列表"
          >
            刷新
          </Button>
        )}
      >
        {/* 顶部：命中提示卡片（新命中在最上） */}
        {hits.length > 0 && (
          <div className="flb-hit-list">
            {hits.map((h) => (
              <div className="flb-hit-card" key={h.code}>
                <div className="flb-hit-header">
                  <span className="flb-hit-badge">🎯 命中</span>
                  <span className="flb-hit-name">
                    {h.name}（{h.code}）
                  </span>
                  {h.group && <span className="flb-hit-group">{h.group}</span>}
                  {h.isLimitUp && <span className="flb-hit-limitup">涨停</span>}
                  <span className="flb-hit-time">{h.time}</span>
                </div>
                <div className="flb-hit-desc">
                  强度分 {fmtNum(h.strength)} − 差劲分 {fmtNum(h.diff)} =
                  <span className="flb-hit-delta"> {fmtNum(h.delta)}</span>
                  （≥ {DELTA_MIN} 命中）
                  {h.lianban != null && <span className="flb-hit-lianban"> · {h.lianban} 连板</span>}
                  {h.change != null && <span className={`flb-hit-change ${Number(h.change) >= 0 ? 'up' : 'down'}`}> · 当日 {fmtChange(h.change)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {renderSection(
          '顺周期候选',
          visibleStocks,
          <span className="flb-list-meta">
            {meta?.date || '--'}
            {meta?.minute != null ? ` · ${String(meta.minute).slice(0, 2)}:${String(meta.minute).slice(2, 4)}` : ''}
          </span>,
          'ew',
        )}
        {renderSection(
          '逆周期候选（反向抱团）',
          visibleReverse,
          reverseMeta ? (
            <span className={`flb-list-gate ${reverseMeta.eligible ? 'passed' : ''}`}>
              {reverseMeta.eligible ? '逆周期窗口已开启' : '未进入逆周期窗口'}
              {reverseMeta.slopeClose != null ? ` · 斜率 ${fmtNum(reverseMeta.slopeClose)}` : ''}
            </span>
          ) : null,
          'rev',
        )}

        {/* 通用 K 线弹窗（点击候选股名称打开） */}
        <StockKLineModal
          visible={klineVisible}
          onCancel={() => setKlineVisible(false)}
          code={selectedStock?.code}
          stockInfo={{ name: selectedStock?.stockName, change: selectedStock?.change }}
        />
      </Drawer>
    </>
  );
};

export default FloatingLongErBo;
