// 叮盘页「首板起爆」列表（2026-11-01 用户新增，位于指数叠加分时模块下方）
//   数据来源：后端 firstBoardWashLive 常驻服务
//     - 首次加载：GET /first_board_wash_snapshot（含实时价/涨幅/竞价/状态），无快照时回退 GET /first_board_wash_candidates
//     - 09:15-09:41 每 3s 由后端 WS 推送 first_board_wash_candidates，本组件实时刷新（open:false 不弹窗）
//     - 右上角刷新按钮：GET /first_board_wash_candidates?refresh=1 强制重算候选股列表
import { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, Empty, Tooltip, message } from 'antd';
import { RocketOutlined, ReloadOutlined } from '@ant-design/icons';
import { local_ip } from '../../../../constant';
import { subscribeFirstBoardWashCandidatesPush } from '../../../../utils/buyPointWs';
import './index.scss';

const API = `http://${local_ip}:3000`;

const fmtPct = (v) => {
  const num = Number(v);
  if (v === undefined || v === null || Number.isNaN(num)) return '--';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

// YYYYMMDD → YYYY-MM-DD（展示基准日）
const fmtDate = (d) => {
  const s = String(d || '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

const STATUS_CLASS = {
  auction_buy: 'buy',
  burst_buy: 'buy',
  watching: 'watching',
  pending: 'pending',
  limit_open: 'limit',
  miss: 'miss',
  closed: 'closed',
};

// 候选原始数据（/first_board_wash_candidates）→ 列表行（补齐价格/状态字段）
const normalizeRow = (c) => ({
  code: c.code,
  name: c.name,
  board: c.board || '',
  lianbanCount: c.lianbanCount != null ? c.lianbanCount : null,
  floatMvYi: c.floatMvYi != null ? c.floatMvYi : null,
  washout: c.washout || null,
  preclose: c.preclose != null ? c.preclose : (c.lastClose != null ? c.lastClose : null),
  price: c.price != null ? c.price : null,
  change: c.change != null ? c.change : null,
  auctionGap: c.auctionGap != null ? c.auctionGap : null,
  status: c.status || 'pending',
  statusText: c.statusText || '待竞价',
});

const FirstBoardWashList = ({ onStockClick, themeColor }) => {
  const [rows, setRows] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [basisDate, setBasisDate] = useState(null);
  const [isPreviousDay, setIsPreviousDay] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // 后端返回的展示数据（含基准日：交易日 09:00 起为当日，其余为上一交易日收盘后）
  const applyData = (d) => {
    if (!d) return;
    if (Array.isArray(d.candidates)) setRows(d.candidates.map(normalizeRow));
    setUpdatedAt(d.updatedAt || d.computedAt || null);
    setBasisDate(d.basisDate || d.date || null);
    setIsPreviousDay(d.isPreviousDay === true);
    setLoading(false);
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const snap = await axios.get(`${API}/first_board_wash_snapshot`);
        if (!alive) return;
        applyData(snap.data?.data);
      } catch {
        if (alive) setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();

    // 盘中（09:15-09:41）后端每 3s 推送一次候选列表快照，前端实时刷新
    const unsub = subscribeFirstBoardWashCandidatesPush((msg) => {
      const d = msg?.data;
      if (!d || !Array.isArray(d.candidates)) return;
      applyData(d);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // 点击刷新：强制重算候选股（交易日盘中为当日、非交易日/盘前为上一交易日）
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await axios.get(`${API}/first_board_wash_candidates`, { params: { refresh: 1 } });
      const d = res.data?.data || {};
      const list = Array.isArray(d.candidates) ? d.candidates : [];
      const prev = new Map(rows.map((r) => [r.code, r]));
      setRows(list.map((c) => {
        const row = normalizeRow(c);
        const old = prev.get(c.code);
        // 上一交易日基准不保留实时字段（实时价/竞价/状态只属于当日盘中）
        if (!old || d.isPreviousDay === true) return row;
        return { ...row, price: old.price, change: old.change, auctionGap: old.auctionGap, status: old.status, statusText: old.statusText };
      }));
      setUpdatedAt(d.computedAt || d.updatedAt || null);
      setBasisDate(d.basisDate || d.date || null);
      setIsPreviousDay(d.isPreviousDay === true);
      message.success(`候选股已重新计算：${list.length} 只`);
    } catch {
      message.error('重新计算候选股失败');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="first-board-wash-list" style={{ marginTop: 16 }}>
      <Card
        className="monitor-card"
        variant="borderless"
        bodyStyle={{ padding: '12px 14px' }}
        title={(
          <span className="fbwl-title">
            <RocketOutlined style={{ marginRight: 8, color: themeColor || undefined }} />
            首板起爆（首板洗盘-起爆拉升候选）
            <span className="fbwl-count">{rows.length} 只</span>
          </span>
        )}
        extra={(
          <Tooltip title="重新计算符合条件的候选股">
            <ReloadOutlined
              spin={refreshing}
              style={{ cursor: 'pointer', fontSize: 14 }}
              onClick={handleRefresh}
            />
          </Tooltip>
        )}
      >
        {loading ? (
          <div className="fbwl-empty">加载中…</div>
        ) : rows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isPreviousDay ? '上一交易日无符合条件的候选股' : '今日无符合条件的候选股'} />
        ) : (
          <div className="fbwl-body">
            {rows.map((r, idx) => (
              <div
                key={r.code}
                className="fbwl-row"
                onClick={() => onStockClick && onStockClick({ code: r.code, name: r.name })}
              >
                <span className="fbwl-index">{idx + 1}</span>
                <span className="fbwl-name">
                  <b>{r.name}</b>
                  <span className="fbwl-code">{r.code}</span>
                </span>
                {r.board ? <span className="fbwl-board">{r.board}</span> : <span className="fbwl-board">--</span>}
                <span className={`fbwl-num ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : ''}`}>{fmtPct(r.change)}</span>
                <span className="fbwl-num fbwl-auction">竞价 {fmtPct(r.auctionGap)}</span>
                <span className={`fbwl-status ${STATUS_CLASS[r.status] || 'pending'}`}>{r.statusText || '待竞价'}</span>
              </div>
            ))}
          </div>
        )}
        <div className="fbwl-footer">
          {isPreviousDay
            ? `非交易时段 / 盘前：展示上一交易日${basisDate ? `（${fmtDate(basisDate)}）` : ''}收盘后的候选股；买点：竞价 ≥ 5% → 9:30 直接买入，否则 9:30-9:40 分时 +8% 首次触发买入`
            : `盘中每 3s 实时刷新至 9:41 ｜ 更新时间：${updatedAt || '--'}（买点：竞价 ≥ 5% → 9:30 直接买入；否则 9:30-9:40 分时 +8% 首次触发买入）`}
        </div>
      </Card>
    </div>
  );
};

export default FirstBoardWashList;
