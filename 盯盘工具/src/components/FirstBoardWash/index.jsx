// 首板洗盘-起爆拉升（线上常驻功能，2026-11-01 用户新增；挂载于 App 根组件，全页面生效）
//   后端 firstBoardWashLive 与「科技进攻 / 情绪游资-极致胜率」等策略模式无关，常驻运行：
//     09:00  整理当日候选股 → WS first_board_wash_candidates（open:true）→ 本组件弹窗展示候选股列表
//     09:15-09:41 每 3s 轮询 → 同一 WS 类型（open:false）仅刷新列表数据，不重复弹窗
//   买点诊断卡片统一由 GlobalDiagnosisAlert 渲染（与科技进攻同一张卡片），本组件只负责候选股列表
import { useState, useEffect } from 'react';
import { Modal, Table, Tag } from 'antd';
import { RocketOutlined } from '@ant-design/icons';
import { subscribeFirstBoardWashCandidatesPush } from '../../utils/buyPointWs';
import './index.scss';

const fmtPct = (v) => {
  const num = Number(v);
  if (v === undefined || v === null || Number.isNaN(num)) return '--';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
};

const fmtNum = (v) => {
  const num = Number(v);
  if (v === undefined || v === null || Number.isNaN(num)) return '--';
  return num.toFixed(2);
};

// 状态色：已触发买入=绿，一字板/未触发=灰，观察中=橙
const STATUS_COLOR = {
  auction_buy: 'green',
  burst_buy: 'green',
  watching: 'orange',
  pending: 'default',
  limit_open: 'default',
  miss: 'default',
};

const washText = (w) => {
  if (!w) return '--';
  const parts = [];
  if (w.washDays != null) parts.push(`洗盘 ${w.washDays} 日`);
  if (w.rangePct != null) parts.push(`幅度 ${fmtPct(w.rangePct)}`);
  if (w.platformHigh != null) parts.push(`平台高点 ${fmtNum(w.platformHigh)}`);
  return parts.length > 0 ? parts.join('，') : '--';
};

const COLUMNS = [
  {
    title: '股票',
    dataIndex: 'code',
    key: 'code',
    render: (_, r) => (
      <span className="fbw-stock">
        <b>{r.name}</b>
        <span className="fbw-code">{r.code}</span>
      </span>
    ),
  },
  { title: '板块', dataIndex: 'board', key: 'board', render: (v) => v || '--', ellipsis: true },
  { title: '连板', dataIndex: 'lianbanCount', key: 'lianbanCount', width: 62, render: (v) => (v != null ? `${v} 板` : '--') },
  { title: '流通市值', dataIndex: 'floatMvYi', key: 'floatMvYi', width: 88, render: (v) => (v != null ? `${fmtNum(v)} 亿` : '--') },
  {
    title: '洗盘形态',
    dataIndex: 'washout',
    key: 'washout',
    width: 210,
    render: (w) => <span className="fbw-wash">{washText(w)}</span>,
  },
  { title: '竞价', dataIndex: 'auctionGap', key: 'auctionGap', width: 76, render: (v) => fmtPct(v) },
  {
    title: '涨幅',
    dataIndex: 'change',
    key: 'change',
    width: 76,
    render: (v) => (
      <span className={Number(v) > 0 ? 'fbw-up' : Number(v) < 0 ? 'fbw-down' : ''}>{fmtPct(v)}</span>
    ),
  },
  {
    title: '状态',
    dataIndex: 'statusText',
    key: 'statusText',
    width: 150,
    render: (v, r) => <Tag color={STATUS_COLOR[r.status] || 'default'}>{v || '待竞价'}</Tag>,
  },
];

const FirstBoardWash = () => {
  // 09:00 候选股弹窗
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [meta, setMeta] = useState({ date: null, updatedAt: null });

  useEffect(() => {
    const unsubCandidates = subscribeFirstBoardWashCandidatesPush((msg) => {
      const d = msg?.data;
      if (!d || !Array.isArray(d.candidates)) return;
      setCandidates(d.candidates);
      setMeta({ date: d.date ?? null, updatedAt: d.updatedAt ?? null });
      // open:true 仅 09:00 整理完成时出现（补发消息会被去掉 open），据此弹窗一次
      if (msg.open === true) setCandidatesOpen(true);
    });
    return () => { unsubCandidates(); };
  }, []);

  const dateText = meta.date
    ? `${String(meta.date).slice(0, 4)}-${String(meta.date).slice(4, 6)}-${String(meta.date).slice(6, 8)}`
    : '--';

  return (
    <>
      <Modal
        className="fbw-modal"
        open={candidatesOpen}
        onCancel={() => setCandidatesOpen(false)}
        footer={null}
        width={1080}
        title={(
          <span className="fbw-modal-title">
            <RocketOutlined />
            首板洗盘-起爆拉升 · 当日候选股
            <span className="fbw-modal-sub">{dateText} · {candidates.length} 只</span>
          </span>
        )}
      >
        <div className="fbw-rules">
          选股：首板（或首板+二板）放量峰值后 5~12 日缩量洗盘、未破位；买点日前 20 日最大三日窗口涨幅 ≤ 20%；
          剔除创业板/科创板、题材黑名单、15 日内 ≥3 板；流通市值 ≤ 100 亿。
          买点：竞价高开 ≥ 5% → 9:30 按竞价开盘价直接买入；否则 9:30-9:40 分时涨幅首次达 +8% 买入（最多 1 次回落、起爆价 ≥ 平台高点 0.80）；
          9:30 开盘即涨停买不进；仓位半仓，最多同时持有 2 只。
        </div>
        <Table
          className="fbw-table"
          rowKey="code"
          size="small"
          columns={COLUMNS}
          dataSource={candidates}
          pagination={false}
          scroll={{ y: 420 }}
          locale={{ emptyText: '今日无符合条件的候选股' }}
        />
        <div className="fbw-modal-footer">
          更新时间：{meta.updatedAt || '--'}（盘中每 3 秒轮询刷新，9:41 停止）
        </div>
      </Modal>
    </>
  );
};

export default FirstBoardWash;
