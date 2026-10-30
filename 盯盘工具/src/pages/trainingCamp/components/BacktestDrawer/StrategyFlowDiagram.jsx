import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ============================================================================
// 策略决策流程图（@xyflow/react）
// 在「策略说明」弹窗中、文字说明之前渲染：哪些条件并列（AND 卡片）、
// 谁跟谁有先后顺序（纵向主链）、有哪些决策分支路径（是/否/顺延/重试循环）。
// ============================================================================

// ---------------- 文本工具（弹窗编号分行展示共用） ----------------

// 将含 **粗体** 标记的长文本按句读（；;。）切分为多行，行内保留粗体标记
export const splitBoldClauses = (text) => {
  const src = String(text ?? '');
  if (!src) return [];
  const spans = [];
  src.split('**').forEach((seg, i) => {
    if (seg !== '') spans.push({ t: seg, b: i % 2 === 1 });
  });
  const clauses = [[]];
  spans.forEach((sp) => {
    const pieces = sp.t.split(/([；;。])/);
    pieces.forEach((p) => {
      if (!p) return;
      if (p === '；' || p === ';' || p === '。') {
        const cur = clauses[clauses.length - 1];
        if (cur.length) cur.push({ t: p, b: sp.b });
        clauses.push([]);
      } else {
        clauses[clauses.length - 1].push({ t: p, b: sp.b });
      }
    });
  });
  const lines = [];
  clauses.forEach((cls) => {
    if (!cls.length) return;
    let s = '';
    let prevB = null;
    let open = false;
    cls.forEach((seg) => {
      if (prevB === seg.b) {
        s += seg.t;
      } else {
        if (open) {
          s += '**';
          open = false;
        }
        if (seg.b) {
          s += '**';
          open = true;
        }
        s += seg.t;
        prevB = seg.b;
      }
    });
    if (open) s += '**';
    const t = s.trim();
    if (t && t !== '**') lines.push(t);
  });
  return lines;
};

// 解析一条策略说明 bullet：提取开头粗体/短标题，其余切分为多行
export const parseNoteBullet = (raw) => {
  const src = String(raw ?? '');
  let title = '';
  let rest = src;
  const mBold = /^\*\*([^*]+?)\*\*\s*[:：]/.exec(src);
  if (mBold) {
    title = mBold[1];
    rest = src.slice(mBold[0].length);
  } else {
    const mPlain = /^([^：:*]{2,16})[:：]/.exec(src);
    if (mPlain) {
      title = mPlain[1];
      rest = src.slice(mPlain[0].length);
    }
  }
  const lines = splitBoldClauses(rest);
  if (!lines.length && title) return { title: '', lines: splitBoldClauses(src) };
  return { title, lines };
};

// 节点内渲染 **粗体**
const renderInlineBold = (text, color) => {
  const parts = String(text ?? '').split('**');
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <b key={i} style={{ color: color || '#16325c' }}>{p}</b>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
};

// ---------------- 画布布局基础 ----------------

const X0 = 40;    // 主链列
const X1 = 500;   // 分支列（等待节点 / 分支步骤 / 卖点卡片）
const X2 = 960;   // 顺延 hub 远端列
const GAP = 30;

const vlen = (s) => String(s ?? '').replace(/\*\*/g, '').length;

// 估算节点高度（仅用于排布间距，宁大勿小）
const estH = (d, w) => {
  const width = w || 300;
  const inner = width - 26;
  const cpl = Math.max(8, Math.floor(inner / 12.4));
  const cplS = Math.max(7, Math.floor(inner / 11.2));
  let h = 24;
  h += Math.max(1, Math.ceil(vlen(d.title) / cpl)) * 19;
  if (d.sub) h += Math.ceil(vlen(d.sub) / cplS) * 16 + 3;
  if (Array.isArray(d.items)) {
    d.items.forEach((t) => {
      h += Math.ceil(vlen(t) / Math.max(6, Math.floor((inner - 16) / 11.4))) * 16 + 10;
    });
  }
  if (d.note) h += Math.ceil(vlen(d.note) / cplS) * 15 + 10;
  return Math.round(h + 16);
};

const EDGE_COLOR = {
  flow: '#9db2cc',
  yes: '#2b8fff',
  no: '#d98f8f',
  loop: '#fa8c16',
  sell: '#52c41a',
};

const mkEdge = (id, source, target, o = {}) => {
  const color = o.color || EDGE_COLOR[o.tone] || EDGE_COLOR.flow;
  return {
    id,
    source,
    target,
    sourceHandle: o.sh || 's-b',
    targetHandle: o.th || 't-t',
    type: 'smoothstep',
    label: o.label,
    labelStyle: { fill: o.labelColor || '#3c4a63', fontSize: 10.5, fontWeight: 700 },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.95 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 3,
    animated: !!o.animated,
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color },
    style: { stroke: color, strokeWidth: 1.6, ...(o.dashed ? { strokeDasharray: '7 5' } : {}) },
  };
};

// 布局构建器：主链单列纵向排布（游标 y 自增）；分支列节点用显式 y 指定。
// 边统一延迟到 build 结束时再解析（此时所有节点 id 均已注册，顺序无关）。
const build = (fn) => {
  const nodes = [];
  const edges = [];
  const pending = [];
  const map = {};
  const pos = {};
  let y = 0;
  let ei = 0;
  const ctx = {
    x: X0,
    yNow: () => y,
    add(key, kind, data, opts = {}) {
      const d = { kind, ...data };
      const w = d.w || 300;
      const h = estH(d, w);
      const yy = opts.y != null ? opts.y : y;
      const xx = opts.x != null ? opts.x : ctx.x;
      nodes.push({ id: `n-${key}`, type: 'flow', position: { x: xx, y: yy }, data: d, style: { width: w } });
      map[key] = `n-${key}`;
      pos[key] = { y: yy, h, x: xx, w };
      if (opts.y == null) y = yy + h + GAP;
      return key;
    },
    link(from, to, o = {}) {
      pending.push([from, to, o]);
    },
  };
  ctx.nodes = nodes;
  ctx.pos = pos;
  fn(ctx);
  pending.forEach(([from, to, o]) => {
    edges.push(mkEdge(`e${++ei}`, map[from] || from, map[to] || to, o));
  });
  return { nodes, edges, map, pos };
};

// ---------------- 节点视觉 ----------------

const KIND_META = {
  start: { bg: 'linear-gradient(135deg,#1d39c4,#2f54eb)', border: '#1d39c4', color: '#ffffff', icon: '▶', badge: '开始' },
  parallel: { bg: '#eef5ff', border: '#5b9cf8', color: '#1c4a63', icon: '‖', badge: '并列 · 同时满足', itemBg: 'rgba(255,255,255,0.85)' },
  gate: { bg: '#fffbe6', border: '#f0c040', color: '#613400', icon: '◆', badge: null },
  step: { bg: '#f4f9ff', border: '#a8c7f0', color: '#22314e', icon: '⚙', badge: null },
  pool: { bg: '#f9f0ff', border: '#b78fe8', color: '#5b2c8d', icon: '◍', badge: '候选池', itemBg: 'rgba(255,255,255,0.75)' },
  hub: { bg: '#fff3e8', border: '#ff9c4a', color: '#8a4108', icon: '↻', badge: '顺延循环', itemBg: 'rgba(255,255,255,0.8)' },
  buy: { bg: '#fff1f0', border: '#ff7875', color: '#9e1313', icon: '↑', badge: '买入' },
  sell: { bg: '#f6ffed', border: '#95de64', color: '#1c6b2c', icon: '↓', badge: '卖出 · 任一触发即卖', itemBg: 'rgba(255,255,255,0.8)' },
  wait: { bg: '#fafbfc', border: '#cdd4de', color: '#7a869a', icon: '⏸', badge: null, dashed: true },
  note: { bg: '#fdfdff', border: '#c9d4e4', color: '#4a5b75', icon: 'ℹ', badge: null, dashed: true },
};

const HANDLE_STYLE = { opacity: 0, width: 7, height: 7, minWidth: 7, minHeight: 7 };

const FlowNode = ({ data }) => {
  const m = KIND_META[data.kind] || KIND_META.step;
  return (
    <div
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: m.bg,
        border: `1.5px ${m.dashed ? 'dashed' : 'solid'} ${m.border}`,
        borderRadius: 10,
        padding: '9px 11px',
        fontSize: 12,
        color: m.color,
        boxShadow: '0 2px 10px rgba(23,43,77,0.08)',
        lineHeight: 1.45,
      }}
    >
      <Handle type="source" position={Position.Top} id="s-t" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="target" position={Position.Top} id="t-t" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} id="s-b" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="target" position={Position.Bottom} id="t-b" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} id="s-r" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="target" position={Position.Right} id="t-r" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Left} id="s-l" style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="target" position={Position.Left} id="t-l" style={HANDLE_STYLE} isConnectable={false} />
      {m.badge && (
        <div
          style={{
            display: 'inline-block',
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.75)',
            border: `1px solid ${m.border}`,
            marginBottom: 4,
            letterSpacing: 0.4,
          }}
        >
          {m.badge}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <span style={{ fontWeight: 700 }}>{m.icon}</span>
        <div style={{ fontWeight: 700, fontSize: 12.3, flex: 1 }}>{renderInlineBold(data.title, m.color)}</div>
      </div>
      {data.sub && (
        <div style={{ fontSize: 10.8, marginTop: 4, opacity: 0.9 }}>{renderInlineBold(data.sub, m.color)}</div>
      )}
      {Array.isArray(data.items) && data.items.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.items.map((it, i) => (
            <div
              key={i}
              style={{
                fontSize: 11.2,
                background: m.itemBg || 'rgba(255,255,255,0.55)',
                borderRadius: 6,
                padding: '3px 7px',
                border: '1px solid rgba(0,0,0,0.05)',
              }}
            >
              {renderInlineBold(it, m.color)}
            </div>
          ))}
        </div>
      )}
      {data.note && (
        <div style={{ marginTop: 6, fontSize: 10.3, opacity: 0.78, borderTop: '1px dashed rgba(0,0,0,0.12)', paddingTop: 4 }}>
          {renderInlineBold(data.note, m.color)}
        </div>
      )}
    </div>
  );
};

const nodeTypes = { flow: FlowNode };

// ---------------- 共享内容块 ----------------

// 通用买点诊断的并列条件（基础版：资金净流入 20 亿）
const BASE_CONDS = [
  '① 最近 5min 大盘主力资金净流入 > **20 亿**',
  '② 量能为正：今日累计成交额 − 昨日全天成交额 > 0',
  '③ 竞价情绪回落：9:30 竞价情绪 > 30 → 需当前 < 10',
  '④ 低于开盘价的自选科技股 ≤ 科技股总数 × 25%（仅 9:30–10:00）',
];

// 快进快出类：资金净流入带动态阈值说明
const EMO_CONDS = [
  '① 最近 5min 资金净流入 > **20 亿**（动态：连续 2 笔折算收益 ≤ 3% → 抬至 30 亿；任一笔 > 3% → 降回 20 亿）',
  '② 量能为正（今日累计 − 昨日全天 > 0；近两日触及 -39 冰点自动豁免）',
  '③ 竞价情绪回落（9:30 情绪 > 30 → 需当前 < 10）',
  '④ 低于开盘价的自选科技股 ≤ 总数 × 25%（仅 9:30–10:00）',
];

// 通用 7 条件卖点
const GENERIC_SELL_ITEMS = [
  '① 均线破位：MA5/MA10 斜率与开盘价位置四规则，跌破对应均线或前一日最低',
  '② 高位放量大阴线：日内最高回落 > 8% 且现价 < 开盘价（持续 ≥ 5min）',
  '③ 科技情绪退潮：情绪 < -30 且自选股跌幅 < -9% 的 ≥ 5 只（持续 ≥ 5min）',
  '④ 抗分歧弱势：抗分歧指数 < 6 且当前涨幅 ≤ -5%（仅 14:50 后）',
  '⑤ 连续三日抗分歧指数均 < 10（仅 9:40 后）',
  '⑥ 跌破最迟买入日低点：现价 < 买入当日最低（持续 ≥ 5min）',
  '⑦ 跌破成本线 -2% 即时止损（竞价低开走自救窗口：拉升中持有、回补豁免、回落仍破线才卖）',
];

const fastSellData = () => ({
  kind: 'sell',
  title: '快进快出专属卖点（并列 · 先到先卖）',
  w: 340,
  items: [
    '① 次日 10:00 强制卖出（不走通用卖点；强卖当日禁止二次买入）',
    '② 次日盘中跌破成本线 -2% 先到先卖（竞价低开走自救窗口：拉升中持有、回补豁免、回落仍破线才卖）',
    '③ 全部持仓叠加：盘中当日跌幅 ≤ -7% 无条件强卖（竞价首分钟已破 → 等首个回落分钟再卖；10:00 前未回落按 10:00 时点兜底）',
  ],
  note: '止损与强卖当日均禁止二次买入',
});

const genericSellData = (withMinus7) => ({
  kind: 'sell',
  title: '通用卖点监控（并列 · 任一触发即卖）',
  w: 340,
  items: withMinus7
    ? [...GENERIC_SELL_ITEMS, '⑧ 全部持仓叠加：盘中当日跌幅 ≤ -7% 无条件强卖（含竞价低开自救窗口）']
    : GENERIC_SELL_ITEMS,
});

const leaderSellData = (opts = {}) => ({
  kind: 'sell',
  title: opts.title || '龙头战法卖点（并列 · 任一触发即卖）',
  w: 350,
  items: [
    '① 跌破成本线 -5% 止损（' + (opts.instant ? '即时卖出、不设持续分钟' : '须连续维持 ≥ 5 分钟') + '）',
    '② 盘中分时较昨收跌幅 ≤ -5% 直接卖',
    '③ 开盘后较当日开盘价下挫 ≥ 5 个点直接卖',
    '④ 持仓股跌停（较昨收 < -9%）',
    '⑤ 高位放量大阴线：最高回落 > 8% 且现价 < 开盘价',
    '⑥ 持仓第 3 个交易日 14:57 收益未拉开 +10% 即卖',
    '⑦ 竞价低开 < -5% 按开盘价卖',
    '⑧ 当日收盘抗分歧指数 < 6 按尾盘价卖',
    ...(opts.noPlummet
      ? ['⑨ 上证 3 日线斜率盘中由负转正 → 立即卖出（下跌窗口结束即离场）']
      : ['⑨ 盘中 1 分钟内跳水 ≤ -3% 直接卖（豁免：上一分钟自身涨幅 > 2% 属急拉则不卖）']),
  ],
  note: '价格类卖点按分钟级回溯成交（自 9:30 起取最先触发分钟）；卖出后当日不再追买',
});

// N 日窗口文案
const ndOf = (id) => {
  const m = /_(\d+)d(5?)_gain/.exec(String(id || ''));
  if (!m) return '3';
  return m[2] ? `${m[1]}.5` : m[1];
};

const capText = (n) => {
  const v = Number(n);
  return `${v * 10}%`;
};

const rankText = (n) => {
  if (n === '2') return '触发时点**当日盘中涨幅**最大（2 日窗口不影响排序依据）';
  if (n === '2.5' || n === '3.5') return `「${n} 日涨幅最大」口径：${Math.floor(Number(n))} 个完整交易日复利 + 窗口最早日前一交易日的 13:00→收盘半日涨幅`;
  return `最近 ${n} 个交易日涨幅之和最大（窗口 = 触发日 + 前 ${Number(n) - 1} 个交易日）`;
};

// ---------------- 共享子流程构建 ----------------

// 头部：扫描 → 并列条件 → 全部通过？ → 等待循环
const stdHead = (ctx, { condItems, passTitle = '买点诊断并列条件全部通过？' }) => {
  ctx.add('start', 'start', { title: '盘中逐 5 分钟桶扫描（9:30–15:00 · 实时分时数据）', w: 320 });
  ctx.add('conds', 'parallel', { title: '通用买点诊断 · 并列条件', items: condItems, w: 340 });
  const yGate = ctx.yNow();
  ctx.add('pass', 'gate', { title: passTitle, w: 300 });
  ctx.add('waitPass', 'wait', { title: '本桶不买 → 下一桶重新诊断', w: 220 }, { x: X1, y: yGate + 8 });
  ctx.link('conds', 'pass');
  ctx.link('pass', 'waitPass', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
  ctx.link('waitPass', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: '下一桶' });
  return 'pass';
};

// 跨指数双门禁（并列判定 → 三分支合并）
const stdDualGate = (ctx, { fromKey, toKey, fromEdge = {}, waitKey = 'waitPass' }) => {
  ctx.add('dual', 'parallel', {
    title: '跨指数双门禁（并列判定后合并 allowedMarkets）',
    w: 350,
    items: [
      '创业板指 3 日线斜率：跟踪 主板(60/00) + 创业板(30)',
      '科创 50 3 日线斜率：跟踪 科创板(68)',
    ],
    note: '③a 盘中由正转负 → 当日禁入；③b 转负次日 → 继续禁入；② 由负转正当日+次日 → 允许；① 斜率<0 且不在禁入窗口 → 允许；斜率≥0 且距转正 >1 天 → 禁止',
  });
  ctx.add('mkt', 'gate', { title: '两个指数门禁合并结果？', w: 300 });
  ctx.link(fromKey, 'dual', fromEdge);
  ctx.link('dual', 'mkt');
  ctx.link('mkt', toKey, { label: '都过 · 全池选股', tone: 'yes' });
  ctx.link('mkt', toKey, { label: '只一个过 · 限对应市场', tone: 'yes' });
  ctx.link('mkt', waitKey, { label: '都不过 · 本桶不买', tone: 'no', sh: 's-r', th: 't-b', dashed: true });
};

// 顺序过滤链：每级 gate 命中 → 共享顺延 hub → 回到排名节点；全过 → 买入
// filters: [{ key, q, bad }]，bad = 命中剔除时的分支标签（'是' 或 '否'）
const addFilterChain = (ctx, { fromKey, loopKeys, filters, hubX = X1, hubNote }) => {
  let prev = fromKey;
  filters.forEach((f) => {
    ctx.add(f.key, 'gate', { title: f.q, w: 300 });
    if (prev !== f.key) ctx.link(prev, f.key);
    prev = f.key;
  });
  const first = ctx.pos[filters[0].key];
  const last = ctx.pos[filters[filters.length - 1].key];
  const hubKey = `${filters[0].key}-hub`;
  ctx.add(hubKey, 'hub', {
    title: '顺延：剔除该候选，取排名下一只',
    note: hubNote || '对新的第一名重新按同规则判定；全部候选耗尽 → 本桶不买（后续桶重试）',
    w: 250,
  }, { x: hubX, y: (first.y + last.y) / 2 });
  filters.forEach((f, i) => {
    const good = f.bad === '是' ? '否' : '是';
    if (i < filters.length - 1) {
      ctx.link(f.key, filters[i + 1].key, { label: good, tone: 'yes' });
    }
    ctx.link(f.key, hubKey, { label: `${f.bad} · 剔除`, tone: 'loop', sh: 's-r', th: 't-l', dashed: true, animated: true });
  });
  loopKeys.forEach((k) => {
    ctx.link(hubKey, k, { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: '重新选股' });
  });
  const lastF = filters[filters.length - 1];
  return { lastKey: lastF.key, lastGood: lastF.bad === '是' ? '否' : '是', hubKey };
};

// 通用 N 日涨幅系列的过滤链
const ndFilters = (n, opts = {}) => {
  const arr = [];
  if (opts.gainCap !== false) {
    arr.push({ key: 'fCap', q: `N 日累计涨幅过热？（> 10% × N = ${capText(n)}，剔除不参与排名）`, bad: '是' });
  }
  arr.push({ key: 'fOneWord', q: '上一交易日一字板？（主板三项涨幅均 ≥ 8% / 创业·科创 ≥ 16%）', bad: '是' });
  arr.push({ key: 'fCycle', q: '逆周期？（与创业板指近 20 个交易日收益相关性 ≤ 0）', bad: '是' });
  if (opts.gainGap !== false) {
    arr.push({ key: 'fGap', q: 'N 日涨幅领先第 2 名超 N 点 且 当日爆发力不足？（抗分歧低于 2~5 名均值 N 点以上）', bad: '是' });
  }
  arr.push({
    key: 'fRes',
    q: opts.resilienceTitle || '抗分歧分数 ≥ 9？（全局最低门槛，不足顺延下一只）',
    bad: '否',
  });
  arr.push({ key: 'fLimit', q: '买入时点已涨停？（主板 > 9.5% / 创业·科创 > 19%）', bad: '是' });
  return arr;
};

// 卖点卡片：挂在某个买入节点右侧
const addSellCard = (ctx, fromKey, data) => {
  const p = ctx.pos[fromKey];
  ctx.add(`${fromKey}-sell`, 'sell', data, { x: X1, y: p.y });
  ctx.link(fromKey, `${fromKey}-sell`, { label: '持仓期间', tone: 'sell', sh: 's-r', th: 't-l' });
};

// 快进快出卖点分支：gate → 快进快出卡片 / 通用卡片
const addEmoSellBranch = (ctx, fromKey, gateTitle) => {
  ctx.add('fastGate', 'gate', { title: gateTitle || '该笔持仓处于**快进快出情形**？（上一交易日 3 日 EMA < -30，或 近两日当日情绪 ∈ (-30,-10) 且逐日回升）', w: 320 });
  ctx.link(fromKey, 'fastGate');
  const gp = ctx.pos.fastGate;
  const fd = fastSellData();
  const gh = estH(fd, fd.w);
  ctx.add('sellFast', 'sell', fd, { x: X1, y: gp.y });
  ctx.add('sellGen', 'sell', genericSellData(true), { x: X1, y: gp.y + gh + 70 });
  ctx.link('fastGate', 'sellFast', { label: '是 · 快进快出', tone: 'yes', sh: 's-r', th: 't-l' });
  ctx.link('fastGate', 'sellGen', { label: '否 · 普通', tone: 'yes' });
};

// 连续两日冰点 → 板块发酵延时选股分支（返回 s3 key，供排名节点合并）
const addIceBranch = (ctx, { passKey, passEdge = {} }) => {
  const yIce = ctx.yNow();
  ctx.add('ice', 'gate', { title: '连续两日冰点？（上一交易日 hasIce 且 当日分时曾 ≤ -39）', w: 310 });
  ctx.link(passKey, 'ice', passEdge);
  let ys = yIce + 6;
  ctx.add('s1', 'step', { title: '买点触发后**延时 15 分钟**到目标时点（落在午休 / 13:30 后 → 放弃本次）', w: 280 }, { x: X1, y: ys });
  ys += estH({ title: '买点触发后延时 15 分钟到目标时点（落在午休 / 13:30 后 → 放弃本次）' }, 280) + GAP;
  ctx.add('s2', 'step', { title: '目标时点回溯 20 分钟：「中性 / 进攻」tag 板块**区间涨幅差值**降序排名', w: 280 }, { x: X1, y: ys });
  ys += estH({ title: '目标时点回溯 20 分钟：「中性 / 进攻」tag 板块区间涨幅差值降序排名' }, 280) + GAP;
  ctx.add('s3', 'step', { title: '逐板块取「成分股 ∩ 自选科技股 ∩ 目标桶有行情」交集，交集内选 N 日涨幅最大；无标的 → 顺延下一板块；全部失败 → 回退全量自选股', w: 280 }, { x: X1, y: ys });
  ys += estH({ title: '逐板块取「成分股 ∩ 自选科技股 ∩ 目标桶有行情」交集，交集内选 N 日涨幅最大；无标的 → 顺延下一板块；全部失败 → 回退全量自选股' }, 280) + GAP;
  ctx.add('s1c', 'step', { title: '选股完成后**涨幅确认**：取「触发 → 到点」窗口内该股最高当日涨幅，之后每 5min 桶监控，当前涨幅**超过窗口最高 +1 个百分点**才买入；始终未超过 → 本次不买', w: 280 }, { x: X1, y: ys });
  ctx.link('ice', 's1', { label: '是 · 冰点日', tone: 'yes', sh: 's-r', th: 't-l' });
  ctx.link('s1', 's2');
  ctx.link('s2', 's3');
  ctx.link('s3', 's1c');
  return { iceKey: 'ice', s2: 's2', s3: 's1c' };
};

// ---------------- 各策略家族的流程定义 ----------------

// 常规 N 日涨幅最大系列（含 highest_gain 变体）
const specNdGain = (n, opts = {}) =>
  build((ctx) => {
    stdHead(ctx, { condItems: BASE_CONDS });
    ctx.add('rank', 'step', {
      title: `选股排名：${opts.rankTitle || rankText(n)}`,
      w: 320,
      ...(opts.rankNote ? { note: opts.rankNote } : {}),
    });
    stdDualGate(ctx, { fromKey: 'pass', toKey: 'rank', fromEdge: { label: '是', tone: 'yes' } });
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank'],
      filters: opts.filters || ndFilters(n),
      hubX: X1,
    });
    ctx.add('buy', 'buy', { title: '按当桶分时价买入（全仓）', w: 280 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addSellCard(ctx, 'buy', genericSellData(false));
  });

// 快进快出系列（含科技情绪门禁 g10 变体）
const specEmoQuick = (n, opts = {}) =>
  build((ctx) => {
    stdHead(ctx, { condItems: EMO_CONDS });
    const ice = addIceBranch(ctx, { passKey: 'pass', passEdge: { label: '是 · 买点触发', tone: 'yes' } });
    ctx.add('rank', 'step', {
      title: `选股排名：${rankText(n)}`,
      w: 320,
      note: '冰点日：在板块交集内排名（全部板块无标的 → 回退全量自选股）；涨停 / 一字板 / 逆周期 / 过热 / 抗分歧等过滤照常',
    });
    stdDualGate(ctx, { fromKey: ice.iceKey, toKey: 'rank', fromEdge: { label: '否 · 正常日', tone: 'yes' } });
    ctx.link(ice.s3, 'rank', { tone: 'yes', label: '涨幅确认通过', sh: 's-l', th: 't-r' });
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank', 's2'],
      filters: ndFilters(n),
      hubX: X2,
      hubNote: '对新的第一名重新判定；冰点日板块交集内无标的 → 顺延下一板块；全部耗尽 → 本桶不买',
    });
    let lastKey = chain.lastKey;
    let lastGood = chain.lastGood;
    if (opts.g10) {
      ctx.add('g10', 'gate', { title: '当前时间桶分时科技情绪 ≥ 10？（不满足或数据缺失 → 该桶不买，后续桶重新判定）', w: 310 });
      ctx.link(chain.lastKey, 'g10', { label: chain.lastGood, tone: 'yes' });
      ctx.add('waitG10', 'wait', { title: '该桶不买 → 后续桶重新判定', w: 220 }, { x: X1, y: ctx.pos.g10.y + 8 });
      ctx.link('g10', 'waitG10', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
      ctx.link('waitG10', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
      lastKey = 'g10';
      lastGood = '是';
    }
    ctx.add('buy', 'buy', { title: '按当桶分时价买入', w: 270 });
    ctx.link(lastKey, 'buy', { label: lastGood, tone: 'yes' });
    addEmoSellBranch(ctx, 'buy');
  });

// 10×n 科技情绪-快进快出（买点 = 分时情绪突破，不走通用诊断）
const specEmoBreak = (t) =>
  build((ctx) => {
    ctx.add('start', 'start', { title: '盘中逐桶监控分时科技情绪（9:30 竞价起算 · 跨日不累计）', w: 330 });
    const yGate = ctx.yNow();
    ctx.add('emoGate', 'gate', { title: `分时科技情绪 ≥ **${t}**？（首个突破时点；13:30 后不买）`, w: 300 });
    ctx.add('waitE', 'wait', { title: '未突破 → 下一桶继续监控', w: 220 }, { x: X1, y: yGate + 8 });
    ctx.link('start', 'emoGate');
    ctx.link('emoGate', 'waitE', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitE', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: '下一桶' });
    const ice = addIceBranch(ctx, { passKey: 'emoGate', passEdge: { label: '是 · 突破', tone: 'yes' } });
    ctx.add('rank', 'step', {
      title: '选股排名：最近 3 个交易日涨幅之和最大',
      w: 310,
      note: '该桶选股失败（涨停 / 抗分歧不足）时，情绪仍 ≥ 阈值的后续桶持续重试',
    });
    stdDualGate(ctx, { fromKey: ice.iceKey, toKey: 'rank', fromEdge: { label: '否 · 正常日', tone: 'yes' }, waitKey: 'waitE' });
    ctx.link(ice.s3, 'rank', { tone: 'yes', label: '涨幅确认通过', sh: 's-l', th: 't-r' });
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank', 's2'],
      filters: ndFilters('3'),
      hubX: X2,
      hubNote: '对新的第一名重新判定；冰点日板块交集内无标的 → 顺延下一板块；全部耗尽 → 该桶不买（情绪仍 ≥ 阈值则下一桶重试）',
    });
    ctx.add('buy', 'buy', { title: '按当桶分时价买入', w: 270 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addEmoSellBranch(ctx, 'buy');
  });

// 脉冲最强系列：每次买点触发都无条件走板块发酵延时选股
const specPulse = (n) =>
  build((ctx) => {
    stdHead(ctx, { condItems: EMO_CONDS });
    ctx.add('p1', 'step', { title: '买点触发后**无条件延时 15 分钟**到目标时点（落在午休 / 13:30 后 → 放弃本次买点）', w: 300 });
    ctx.add('p2', 'step', { title: '目标时点回溯 20 分钟：「中性 / 进攻」tag 板块**区间涨幅差值**降序排名', w: 300 });
    ctx.add('p3', 'step', { title: `逐板块取「成分股 ∩ 自选科技股 ∩ 目标桶有行情」交集，交集内选 ${rankText(n)}；无标的 → 顺延下一板块；全部失败 → 回退全量自选股`, w: 320 });
    stdDualGate(ctx, { fromKey: 'pass', toKey: 'p1', fromEdge: { label: '是', tone: 'yes' } });
    ctx.link('p1', 'p2');
    ctx.link('p2', 'p3');
    const chain = addFilterChain(ctx, {
      fromKey: 'p3',
      loopKeys: ['p3', 'p2'],
      filters: ndFilters(n),
      hubX: X1,
      hubNote: '对新的第一名重新判定；板块交集内无标的 → 顺延下一板块；全部耗尽 → 本次买点不买',
    });
    ctx.add('buy', 'buy', { title: '按目标时点分时价买入', w: 280 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addEmoSellBranch(ctx, 'buy');
  });

// 研报覆盖系列
const specReports = (n, opts = {}) =>
  build((ctx) => {
    stdHead(ctx, { condItems: BASE_CONDS });
    ctx.add('rank', 'step', {
      title: opts.top5
        ? `先取最近 ${n} 日研报覆盖数**前五（含并列）**形成候选池 → 池内选 ${n} 日涨幅最大`
        : `最近 ${n} 个交易日**研报覆盖数最多**（相同时取 ${n} 日涨幅最大）`,
      w: 320,
      note: '仅统计买点触发时点之前已创建的研报；研报类不适用抗分歧门槛与涨幅过滤',
    });
    ctx.link('pass', 'rank', { label: '是', tone: 'yes' });
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank'],
      filters: [
        { key: 'fOneWord', q: '上一交易日一字板？（主板 ≥ 8% / 创业·科创 ≥ 16%）', bad: '是' },
        { key: 'fCycle', q: '逆周期？（与创业板指近 20 日相关性 ≤ 0）', bad: '是' },
        { key: 'fLimit', q: '买入时点已涨停？', bad: '是' },
      ],
      hubX: X1,
    });
    ctx.add('buy', 'buy', { title: '按当桶分时价买入（全仓）', w: 280 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addSellCard(ctx, 'buy', genericSellData(false));
  });

// 研报覆盖快进快出（快进快出路径走研报前五）
const specReportsEmoQuick = () =>
  build((ctx) => {
    stdHead(ctx, { condItems: EMO_CONDS });
    const yPath = ctx.yNow();
    ctx.add('path', 'gate', { title: '触发**快进快出路径**？（上一交易日科技情绪 3 日 EMA < -30）', w: 300 });
    ctx.link('pass', 'path');
    ctx.add('r1', 'step', { title: '先取最近 3 日研报覆盖数**前五（含并列）** → 池内选 3 日涨幅最大（博弈反弹提胜率）', w: 290 }, { x: X1, y: yPath + 6 });
    ctx.add('rank', 'step', { title: '普通路径：最近 3 个交易日涨幅之和最大', w: 300 });
    ctx.link('path', 'r1', { label: '是 · 快进快出', tone: 'yes', sh: 's-r', th: 't-l' });
    stdDualGate(ctx, { fromKey: 'path', toKey: 'rank', fromEdge: { label: '否 · 普通日', tone: 'yes' } });
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank', 'r1'],
      filters: [
        { key: 'fOneWord', q: '上一交易日一字板？（主板 ≥ 8% / 创业·科创 ≥ 16%）', bad: '是' },
        { key: 'fCycle', q: '逆周期？（与创业板指近 20 日相关性 ≤ 0）', bad: '是' },
        { key: 'fRes', q: '抗分歧分数 ≥ 9？（不足顺延下一只）', bad: '否' },
        { key: 'fLimit', q: '买入时点已涨停？', bad: '是' },
      ],
      hubX: X1,
    });
    ctx.link('r1', chain.lastKey, { tone: 'yes', label: '研报池内排名' });
    ctx.add('buy', 'buy', { title: '按当桶分时价买入', w: 270 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addEmoSellBranch(ctx, 'buy');
  });

// 两次买入系列
const specTwoBuy = (n) =>
  build((ctx) => {
    stdHead(ctx, { condItems: BASE_CONDS });
    ctx.add('rank', 'step', { title: `选股排名：${rankText(n)}`, w: 320 });
    stdDualGate(ctx, { fromKey: 'pass', toKey: 'rank', fromEdge: { label: '是', tone: 'yes' } });
    const chain = addFilterChain(ctx, { fromKey: 'rank', loopKeys: ['rank'], filters: ndFilters(n), hubX: X1 });
    ctx.add('buy1', 'buy', { title: '第一份：买点首次触发 → 买入 5 成（半仓）', w: 290 });
    ctx.link(chain.lastKey, 'buy1', { label: chain.lastGood, tone: 'yes' });
    const y2 = ctx.yNow();
    ctx.add('gate2', 'gate', { title: '买点**再次触发** 且 距第一份建仓日 ≥ 1 个交易日？（同一交易日不再补买）', w: 310 });
    ctx.add('wait2', 'wait', { title: '保持半仓 · 等后续买点触发', w: 230 }, { x: X1, y: y2 + 8 });
    ctx.link('buy1', 'gate2');
    ctx.link('gate2', 'wait2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait2', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    const y3 = ctx.yNow();
    ctx.add('gate3', 'gate', { title: '第二份目标股（= 第一份同股）当时已涨停？（主板 >9.5% / 创业·科创 >19%）', w: 310 });
    ctx.add('wait3', 'wait', { title: '本次放弃 · 等下次触发且未涨停', w: 240 }, { x: X1, y: y3 + 8 });
    ctx.link('gate2', 'gate3', { label: '是', tone: 'yes' });
    ctx.link('gate3', 'wait3', { label: '是', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait3', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('buy2', 'buy', { title: '第二份：同股再买 5 成（不重新择股）', w: 290 });
    ctx.link('gate3', 'buy2', { label: '否', tone: 'yes' });
    ctx.add('noteCost', 'note', {
      title: '两份仓位各自独立：均以自身买入价为成本、不摊平；各自跌破成本线 -2% 止损；收益各按半仓 ×0.5 折算、记两条独立交易',
      w: 300,
    }, { x: X1, y: ctx.pos.buy2.y });
    ctx.link('buy2', 'noteCost', { tone: 'flow', sh: 's-r', th: 't-l' });
    addEmoSellBranch(ctx, 'buy2', '任一份持仓处于**快进快出情形**？（按份独立判定；否则该份走通用卖点）');
    ctx.link('buy1', 'fastGate', { tone: 'flow', sh: 's-r', th: 't-r', label: '第一份持仓期间' });
  });

// 两次买入（同一天）：14:55 尾盘评估补买
const specTwoBuySameDay = () =>
  build((ctx) => {
    stdHead(ctx, { condItems: BASE_CONDS });
    ctx.add('rank', 'step', { title: '选股排名：最近 3 个交易日涨幅之和最大', w: 310 });
    stdDualGate(ctx, { fromKey: 'pass', toKey: 'rank', fromEdge: { label: '是', tone: 'yes' } });
    const chain = addFilterChain(ctx, { fromKey: 'rank', loopKeys: ['rank'], filters: ndFilters('3'), hubX: X1 });
    ctx.add('buy1', 'buy', { title: '第一份：买点首次触发 → 买入 5 成（半仓）', w: 290 });
    ctx.link(chain.lastKey, 'buy1', { label: chain.lastGood, tone: 'yes' });
    const y2 = ctx.yNow();
    ctx.add('gate2', 'gate', { title: '当日 14:55 尾盘评估：当日盈利（14:55 价 vs 第一份买价）> 2% 且未涨停？（当日不再因买点二次触发补买）', w: 330 });
    ctx.add('wait2', 'wait', { title: '当日不补 · 等后续买点触发再买第二份', w: 250 }, { x: X1, y: y2 + 8 });
    ctx.link('buy1', 'gate2');
    ctx.link('gate2', 'wait2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait2', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('buy2', 'buy', { title: '第二份：14:55 尾盘按分时价补买 5 成（同股）', w: 290 });
    ctx.link('gate2', 'buy2', { label: '是', tone: 'yes' });
    ctx.add('noteCost', 'note', {
      title: '两份买入完成后统一成本线 = 两次买入价均值 (买1+买2)÷2，「跌破成本线 -2%」止损按统一成本线判定；两份收益率仍按各自实际买入价计算',
      w: 310,
    }, { x: X1, y: ctx.pos.buy2.y });
    ctx.link('buy2', 'noteCost', { tone: 'flow', sh: 's-r', th: 't-l' });
    addEmoSellBranch(ctx, 'buy2', '任一份持仓处于**快进快出情形**？（快进快出强卖/止损按统一成本线；按份独立判定）');
    ctx.link('buy1', 'fastGate', { tone: 'flow', sh: 's-r', th: 't-r', label: '第一份持仓期间' });
  });

// 两次买入不同板块
const specTwoBuyDiffBlock = (n) =>
  build((ctx) => {
    stdHead(ctx, { condItems: BASE_CONDS });
    ctx.add('rank', 'step', { title: `第一份选股排名：${rankText(n)}（不限板块）`, w: 320 });
    stdDualGate(ctx, { fromKey: 'pass', toKey: 'rank', fromEdge: { label: '是', tone: 'yes' } });
    const chain = addFilterChain(ctx, { fromKey: 'rank', loopKeys: ['rank'], filters: ndFilters(n), hubX: X1 });
    ctx.add('buy1', 'buy', { title: '第一份：买点首次触发 → 买入 5 成（半仓）', w: 290 });
    ctx.link(chain.lastKey, 'buy1', { label: chain.lastGood, tone: 'yes' });
    const y2 = ctx.yNow();
    ctx.add('gate2', 'gate', { title: '买点**再次触发** 且 距第一份建仓日 ≥ 1 个交易日？', w: 300 });
    ctx.add('wait2', 'wait', { title: '保持半仓 · 等后续买点触发', w: 230 }, { x: X1, y: y2 + 8 });
    ctx.link('buy1', 'gate2');
    ctx.link('gate2', 'wait2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait2', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('reselect', 'step', { title: `第二份不买第一份同股：在「所属板块 ≠ 第一份板块」的候选中**重新按 ${rankText(n)}** 择股`, w: 320 });
    ctx.link('gate2', 'reselect', { label: '是', tone: 'yes' });
    const y3 = ctx.yNow();
    ctx.add('gate3', 'gate', { title: '其他板块有可买候选？（涨停 / 一字板 / 逆周期 / 抗分歧过滤后）', w: 300 });
    ctx.add('wait3', 'wait', { title: '本次不补 · 等下一次买点触发再择股', w: 240 }, { x: X1, y: y3 + 8 });
    ctx.link('reselect', 'gate3');
    ctx.link('gate3', 'wait3', { label: '无', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait3', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('buy2', 'buy', { title: '第二份：不同板块股票再买 5 成（独立成本）', w: 300 });
    ctx.link('gate3', 'buy2', { label: '有', tone: 'yes' });
    addEmoSellBranch(ctx, 'buy2', '任一份持仓处于**快进快出情形**？（按份独立判定）');
    ctx.link('buy1', 'fastGate', { tone: 'flow', sh: 's-r', th: 't-r', label: '第一份持仓期间' });
  });

// 两次买入（不同股）
const specTwoBuyDiffStock = (n) =>
  build((ctx) => {
    stdHead(ctx, { condItems: BASE_CONDS });
    ctx.add('rank', 'step', { title: `选股排名：${rankText(n)}`, w: 320 });
    stdDualGate(ctx, { fromKey: 'pass', toKey: 'rank', fromEdge: { label: '是', tone: 'yes' } });
    const chain = addFilterChain(ctx, { fromKey: 'rank', loopKeys: ['rank'], filters: ndFilters(n), hubX: X1 });
    ctx.add('buy1', 'buy', { title: '第一份：买点首次触发 → 买入 5 成（半仓）', w: 290 });
    ctx.link(chain.lastKey, 'buy1', { label: chain.lastGood, tone: 'yes' });
    const y2 = ctx.yNow();
    ctx.add('gate2', 'gate', { title: '买点**再次触发** 且 距第一份建仓日 ≥ 1 个交易日？（不能与第一份同一天买入）', w: 310 });
    ctx.add('wait2', 'wait', { title: '保持半仓 · 等后续买点触发', w: 230 }, { x: X1, y: y2 + 8 });
    ctx.link('buy1', 'gate2');
    ctx.link('gate2', 'wait2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait2', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('reselect', 'step', { title: `第二份在触发时点**重新按 ${rankText(n)}** 择股（不固定第一份的股票）`, w: 310 });
    ctx.link('gate2', 'reselect', { label: '是', tone: 'yes' });
    const y3 = ctx.yNow();
    ctx.add('gate4', 'gate', { title: '重新选出的还是第一份**同一只股票**？', w: 290 });
    ctx.link('reselect', 'gate4');
    ctx.add('buy2a', 'buy', { title: '同股合并持有：统一成本线 = 两次买价均值（止损按均价判定；仍记两条独立交易、各自收益按自身买价）', w: 320 });
    ctx.add('buy2b', 'buy', { title: '买入新选出的股票：两份不同股票、独立成本、独立买卖', w: 300 }, { x: X1, y: y3 + 20 });
    ctx.link('gate4', 'buy2a', { label: '是', tone: 'yes' });
    ctx.link('gate4', 'buy2b', { label: '否 · 换股', tone: 'yes', sh: 's-r', th: 't-l' });
    addEmoSellBranch(ctx, 'buy2a', '任一份持仓处于**快进快出情形**？（按份独立判定）');
    ctx.link('buy1', 'fastGate', { tone: 'flow', sh: 's-r', th: 't-r', label: '第一份持仓期间' });
    ctx.link('buy2b', 'fastGate', { tone: 'flow', sh: 's-b', th: 't-l', label: '第二份持仓期间' });
  });

// 顺周期情绪游资
const specIce = (n) =>
  build((ctx) => {
    ctx.add('start', 'start', { title: '逐桶监控**上证指数** 3 日线斜率（MA3 − 5 日前 MA3 · 实时价代替收盘价）', w: 340 });
    const yG = ctx.yNow();
    ctx.add('turn', 'gate', { title: '斜率**由负转正** 且 前一交易日收盘斜率为负？（前一日已为正 → 不计买点）', w: 320 });
    ctx.add('waitTurn', 'wait', { title: '空仓等待；斜率由正转负 → 作废未成交买入意图', w: 260 }, { x: X1, y: yG + 8 });
    ctx.link('start', 'turn');
    ctx.link('turn', 'waitTurn', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitTurn', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('t1', 'step', { title: '转正当日至少等到 **9:40** 执行；当日未成交 → 次日 9:40 补买一次（超过次日作废；候选无效则在当日后续桶持续重试）', w: 330 });
    ctx.link('turn', 't1', { label: '是 · 转正', tone: 'yes' });
    ctx.add('pool', 'pool', {
      title: '候选池（半仓防御池）',
      w: 330,
      items: [
        '「防御 + 中性」tag 板块（key_blocks 页面维护）的全部成分股（去重、剔 ST）',
        '∪ 近 20 个交易日出现过**连板 ≥ 3（三板及以上）**的红利板块（hongliName.json）个股',
      ],
    });
    ctx.link('t1', 'pool');
    ctx.add('rank', 'step', { title: `最近 ${n} 个交易日（不含当日 · 截至 T-1 收盘）涨幅之和最大`, w: 310 });
    ctx.link('pool', 'rank');
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank'],
      filters: [
        { key: 'fLimit', q: '买入时点已涨停？（主板 > 9.5% / 创业·科创 > 19%）', bad: '是' },
        { key: 'fOneWord', q: '上一交易日一字板？（主板 ≥ 8% / 创业·科创 ≥ 16%）', bad: '是' },
        { key: 'fRes', q: '抗分歧指数 ≥ 9？（跟踪指数：主板→上证 sh000001 · 创业板→创业板指 · 科创板→科创 50）', bad: '否' },
      ],
      hubX: X1,
      hubNote: '按 N 日涨幅排名顺延下一只；全部候选不足则本桶不买、后续桶重试',
    });
    ctx.add('buy', 'buy', { title: '半仓买入（权重 0.5 · 收益 ×0.5 折算 · 按触发桶分时价）', w: 300 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addSellCard(ctx, 'buy', {
      kind: 'sell',
      title: '卖点（并列 · 任一先触发即卖）',
      w: 340,
      items: [
        '① 上证 3 日线斜率**由正转负** → 当桶分时价卖出（同时作废未成交买入）',
        '② 个股跌破成本线 -2% 止损（含竞价低开自救窗口 + 分钟级回溯成交）',
        '③ 14:55 长下影强卖：下影线 ≥ 实体长度 2 倍 → 按分时价强制卖出（买入次日起）',
      ],
    });
  });

// 逆周期情绪游资（镜像）
const specIceRev = (n) =>
  build((ctx) => {
    ctx.add('start', 'start', { title: '逐桶监控**上证指数** 3 日线斜率（MA3 − 5 日前 MA3 · 实时价代替收盘价）', w: 340 });
    const yG = ctx.yNow();
    ctx.add('turn', 'gate', { title: '斜率**由正转负** 且 前一交易日收盘斜率为正？（前一日已为负 → 不计买点）', w: 320 });
    ctx.add('waitTurn', 'wait', { title: '空仓等待；斜率由负转正 → 作废未成交买入意图', w: 260 }, { x: X1, y: yG + 8 });
    ctx.link('start', 'turn');
    ctx.link('turn', 'waitTurn', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitTurn', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('t1', 'step', { title: '转负**次日 9:40 且斜率依旧为负**才执行（转负当日不买 · 仅限次日一天；候选无效则在 9:40 及以后的桶持续重试）', w: 330 });
    ctx.link('turn', 't1', { label: '是 · 转负', tone: 'yes' });
    ctx.add('pool', 'pool', {
      title: '候选池（与顺周期一致 · 方向相反）',
      w: 330,
      items: [
        '「防御 + 中性」tag 板块全部成分股（去重、剔 ST）',
        '∪ 近 20 个交易日出现过**连板 ≥ 3**的红利板块个股',
      ],
    });
    ctx.link('t1', 'pool');
    ctx.add('rank', 'step', {
      title: n === '1'
        ? '按触发时点的**当日分时涨幅**（较昨收实时涨幅）最大'
        : `最近 ${n} 个交易日（不含当日 · 截至 T-1 收盘）涨幅之和最大`,
      w: 310,
    });
    ctx.link('pool', 'rank');
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank'],
      filters: [
        { key: 'fLimit', q: '买入时点已涨停？（主板 > 9.5% / 创业·科创 > 19%）', bad: '是' },
        { key: 'fOneWord', q: '上一交易日一字板？（主板 ≥ 8% / 创业·科创 ≥ 16%）', bad: '是' },
        { key: 'fRes', q: '抗分歧指数 ≥ 9？（跟踪指数：主板→上证 · 创业板→创业板指 · 科创板→科创 50）', bad: '否' },
      ],
      hubX: X1,
      hubNote: '按涨幅排名顺延下一只；全部候选不足则本桶不买、后续桶重试',
    });
    ctx.add('buy', 'buy', { title: '半仓买入（权重 0.5 · 收益 ×0.5 折算 · 按触发桶分时价）', w: 300 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addSellCard(ctx, 'buy', {
      kind: 'sell',
      title: '卖点（并列 · 任一先触发即卖）',
      w: 340,
      items: [
        '① 上证 3 日线斜率**由负转正** → 当桶盘中即卖出（当日新买持仓遵守「当日买入次日才可卖」）',
        '② 个股跌破成本线 -2% 止损（含竞价低开自救窗口 + 分钟级回溯成交）',
        '③ 14:55 长下影强卖：下影线 ≥ 实体长度 2 倍 → 强制卖出（买入次日起）',
      ],
    });
  });

// 情绪游资-反向抱团龙头
const specReverseLeader = () =>
  build((ctx) => {
    ctx.add('start', 'start', { title: '逐日跟踪**上证指数** 3 日线斜率（收盘口径）', w: 320 });
    const yG = ctx.yNow();
    ctx.add('win', 'gate', { title: '斜率**连续为负 ≥ 2 天**？（转负当日 = 第 1 天，负斜率第 3 天起才执行；转正 → 窗口重置、计数清零）', w: 330 });
    ctx.add('waitWin', 'wait', { title: '下跌窗口未开启 · 继续等待', w: 240 }, { x: X1, y: yG + 8 });
    ctx.link('start', 'win');
    ctx.link('win', 'waitWin', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitWin', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('pool', 'pool', {
      title: '候选池（强势抱团股）',
      w: 350,
      items: [
        '回溯过去 20 个交易日出现过**连板 ≥ 2（二连板及以上）**的个股',
        '剔除 ST / 创业板(30/301) / 科创板(688) / 题材黑名单（PCB·玻璃基板·光模块·液冷·通信·算力·芯片·靶材·电子气体·光刻胶·算力租赁）',
        '∩ 20 日内滑动「连续 10 日」子窗口区间最大涨幅 **≥ 60%**（子窗口缺日K视为不达标）',
      ],
    });
    ctx.link('win', 'pool', { label: '是 · 窗口开启', tone: 'yes' });
    ctx.add('hits', 'parallel', {
      title: '命中统计（并列条件 · 同一交易日同一只只计 1 次）',
      w: 340,
      items: [
        '① 当日上证指数跌幅 ≤ **-0.5%**（逐桶实时较昨收；跌幅不足的交易日不统计）',
        '② 盘中分时强度分 > **50**（强度分 = 0.3×竞价高开 + 0.2×单分钟最大涨幅 + 0.3×抗分歧 + 0.2×当日涨幅）',
      ],
      note: '按个股独立累计命中次数；窗口由负转正时清零',
    });
    ctx.link('pool', 'hits');
    const y2 = ctx.yNow();
    ctx.add('gate2', 'gate', { title: '该股**累计第 2 次**达标？', w: 280 });
    ctx.add('wait2', 'wait', { title: '次数保留 · 继续等下一达标日', w: 240 }, { x: X1, y: y2 + 8 });
    ctx.link('hits', 'gate2');
    ctx.link('gate2', 'wait2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait2', 'hits', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: '下一达标日' });
    const y3 = ctx.yNow();
    ctx.add('gate3', 'gate', { title: '此刻已涨停？（主板 > 9.5% / 创业·科创 > 19%）', w: 290 });
    ctx.add('wait3', 'wait', { title: '本次不买 · 顺延后续达标时点', w: 240 }, { x: X1, y: y3 + 8 });
    ctx.link('gate2', 'gate3', { label: '是 · 第 2 次', tone: 'yes' });
    ctx.link('gate3', 'wait3', { label: '是', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait3', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('buy', 'buy', { title: '在第 2 次达标的盘中分时买入（全仓 · 权重 1 · 逐笔复利）', w: 310 });
    ctx.link('gate3', 'buy', { label: '否', tone: 'yes' });
    addSellCard(ctx, 'buy', leaderSellData({ noPlummet: true, title: '卖点（龙头战法 8 条 + 斜率转正 · 任一触发即卖）' }));
  });

// 情绪游资-n板打板
const specNBoard = (n) =>
  build((ctx) => {
    ctx.add('start', 'start', { title: `盘中逐桶扫描（买入时段限 **9:40–11:30**；本策略 n = ${n}）`, w: 320 });
    const yG = ctx.yNow();
    ctx.add('slope', 'gate', { title: '**上证指数** 3 日线分时斜率 > 0？（且已到 9:40 —— 9:40 前一律不买）', w: 310 });
    ctx.add('waitS', 'wait', { title: '本桶不买 → 下一桶重试', w: 220 }, { x: X1, y: yG + 8 });
    ctx.link('start', 'slope');
    ctx.link('slope', 'waitS', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitS', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('pool', 'pool', {
      title: `候选池：上一交易日（T-1）连板数恰为 **${n - 1}（${n - 1} 板）** 的个股`,
      w: 330,
      items: [
        '剔除 ST 等黑名单',
        '一律剔除创业板（30/301）与科创板（688），仅保留主板标的',
      ],
    });
    ctx.link('slope', 'pool', { label: '是', tone: 'yes' });
    const y2 = ctx.yNow();
    ctx.add('gate1', 'gate', { title: '当日竞价一字板？（9:30 开盘价较昨收涨幅 > 9.5%）', w: 300 });
    ctx.add('wait1', 'wait', { title: '整日不买（即使后续炸板也不买）', w: 260 }, { x: X1, y: y2 + 8 });
    ctx.link('pool', 'gate1');
    ctx.link('gate1', 'wait1', { label: '是', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    const y3 = ctx.yNow();
    ctx.add('gate2', 'gate', { title: '9:40 及以后当日分时**首次冲高至 +8%**？（9:40 前冲高不计、不回溯）', w: 310 });
    ctx.add('wait2', 'wait', { title: '继续逐桶监控冲高', w: 220 }, { x: X1, y: y3 + 8 });
    ctx.link('gate1', 'gate2', { label: '否', tone: 'yes' });
    ctx.link('gate2', 'wait2', { label: '未冲高', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('wait2', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    const y4 = ctx.yNow();
    ctx.add('gate3', 'gate', { title: '触发分钟已涨停？（涨幅 ≥ 9.5%，涨停价买不进）', w: 300 });
    ctx.add('wait3', 'wait', { title: '整日不买（即使后续炸板也不买）', w: 260 }, { x: X1, y: y4 + 8 });
    ctx.link('gate2', 'gate3', { label: '冲高至 +8%', tone: 'yes' });
    ctx.link('gate3', 'wait3', { label: '是', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.add('buy', 'buy', { title: '按触发分钟分时价买入（先冲到 8% 的先买；同桶并列取涨幅更高；半仓 ×0.5 · 逐笔复利）', w: 330 });
    ctx.link('gate3', 'buy', { label: '否（+8% ≤ 涨幅 < 9.5%）', tone: 'yes' });
    addSellCard(ctx, 'buy', leaderSellData({ instant: true, title: '卖点（沿用极致胜率顺周期腿 · 9 条任一触发即卖）' }));
  });

// 情绪游资-成交量占比
const specVolumeShare = (n) =>
  build((ctx) => {
    ctx.add('start', 'start', { title: '9:40 起逐桶持续重试（9:40–11:30 · 9:40 前不买）', w: 310 });
    ctx.add('blk', 'step', {
      title: '选板块：成交量占比 **3 日线斜率（截止 T-1）为正且最陡**的前 3 板块',
      w: 340,
      sub: '斜率 = (r[i] − r[i-3]) / 3；占比 = 板块成交额 ÷ 全市场总成交额 × 100；剔除 半导体 / 液冷 / 光通信 / 存储芯片 / pcb',
    });
    ctx.link('start', 'blk');
    ctx.add('pool', 'pool', {
      title: `候选池 = 前 3 板块成分股 ∩ 最近 5 个交易日连板个股（交集）`,
      w: 330,
      items: [
        '剔除 ST 等黑名单',
        '同一股属多个前 3 板块 → 记录全部所属板块（卖出时任一板块转负即触发）',
      ],
    });
    ctx.link('blk', 'pool');
    ctx.add('rank', 'step', {
      title: `${n} 日涨幅最大（复利口径：最近 ${n - 1} 个收盘日涨幅复利 × 买入桶当日分时涨幅复利）`,
      w: 320,
    });
    ctx.link('pool', 'rank');
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank'],
      filters: [
        { key: 'fLimit', q: '已涨停 / 一字板？（主板 ≥ 9.5% · 创业·科创 ≥ 19%，买不进）', bad: '是' },
        { key: 'fChg', q: '当日分时涨幅 > -5%？', bad: '否' },
        { key: 'fRes', q: '抗分歧指数 ≥ 9？（跟踪指数：sh688 → 科创 50，其余 → 创业板指）', bad: '否' },
      ],
      hubX: X1,
      hubNote: '按 N 日涨幅排名顺延下一只；当日全部桶无合格候选则当日不买（次日再看）',
    });
    ctx.add('buy', 'buy', { title: '半仓买入（权重 0.5 · 收益 ×0.5 折算 · 逐笔复利）', w: 300 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addSellCard(ctx, 'buy', {
      kind: 'sell',
      title: '卖点（板块占比斜率转负）',
      w: 340,
      items: [
        '该股所属板块（命中的前 3 板块中的**任一**板块）成交量占比 3 日线斜率**截止 T-1 转负**',
        '→ **次一交易日开盘**按开盘分时价卖出（买入次日起生效）',
      ],
    });
  });

// N 日涨幅最大-成交量占比（9:40 单点）
const specGainVolumeShare = (n) =>
  build((ctx) => {
    ctx.add('start', 'start', { title: '仅 **9:40 单点**评估（不逐桶重试）', w: 300 });
    ctx.add('blk', 'step', {
      title: '选板块（33 个一级板块 · 截止 T-1 的成交量占比序列）',
      w: 360,
      items: [
        '① 3 日线斜率为正：MA3(T-1) > MA3(T-2)',
        '② T-1 占比较此前 5 个交易日（T-6 ~ T-2）最低占比高出 ≥ 30%',
        '③ 该最低占比本身须 > 5%（过滤低占比板块）',
      ],
      note: '多个板块同时满足 → 取「占比(T-1) − 占比(T-2)」差值最大者（资金流入越多越可能是主线）',
    });
    ctx.link('start', 'blk');
    ctx.add('pool', 'step', { title: '读该板块成分股汇总，仅保留沪深主板（60/00）、创业板（30）、科创板（68）', w: 330 });
    ctx.link('blk', 'pool');
    ctx.add('rank', 'step', {
      title: `按最近 ${n} 日涨幅降序取**前 5**（= 最近 ${n - 1} 个收盘日涨幅复利 × 当日 9:40 分时涨幅复利；日K缺失剔除）`,
      w: 330,
    });
    ctx.link('pool', 'rank');
    const chain = addFilterChain(ctx, {
      fromKey: 'rank',
      loopKeys: ['rank'],
      filters: [
        { key: 'fLimit', q: '9:40 未涨停？（主板 < 9.5% / 创业·科创 < 19%）', bad: '否' },
        { key: 'fPos', q: '9:40 分时涨幅 > 0 且 现价高于当日开盘价？', bad: '否' },
      ],
      hubX: X1,
      hubNote: '按排名从前到后顺延下一只；前 5 均不满足 → 当日跳过（不追买）',
    });
    ctx.add('buy', 'buy', { title: '9:40 按分时价**全仓**买入（账户最多同时持有 1 只）', w: 310 });
    ctx.link(chain.lastKey, 'buy', { label: chain.lastGood, tone: 'yes' });
    addSellCard(ctx, 'buy', {
      kind: 'sell',
      title: '卖点（与「N日涨幅最大」一致 · 并列任一触发即卖）',
      w: 350,
      items: [
        ...GENERIC_SELL_ITEMS,
        '⑧ 盘中当日跌幅 ≤ -7% 无条件强卖',
      ],
    });
  });

// 情绪游资-极致胜率（双腿）
const specExtremeWin = () => {
  // 左右两列分别构建后合并
  const legA = build((ctx) => {
    ctx.x = X0;
    ctx.add('start', 'start', {
      title: '账户拆两份：**两个半仓槽**，两腿择时互补',
      w: 900,
      sub: '谁的买点先触发谁占空仓位槽 · 两槽满则另一腿不买 · 两腿不得持有同一只股票 · 每天 14:30 后不再买入（14:30 桶仍可买）',
    });
    const y1 = ctx.yNow();
    ctx.add('gA1', 'gate', { title: '【顺周期腿】上证指数 3 日线**分时斜率 > 0**？（MA3 实时 − MA3 昨收 > 0）', w: 320 });
    ctx.link('start', 'gA1');
    ctx.add('waitA1', 'wait', { title: '该桶跳过（机会不作废，后续桶斜率转正可继续判定）', w: 260 }, { x: X2, y: y1 + 6 });
    ctx.link('gA1', 'waitA1', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitA1', 'gA1', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('poolA', 'pool', {
      title: '【顺周期腿】候选池：过去 10 个交易日出现过**连板准入**的个股',
      w: 350,
      items: [
        '连板准入：流通市值 > 100 亿 → 两连板且含该连板日 5 日涨幅 > 40%；其余 → 连板数 ≥ 4',
        '剔除 ST / 创业板 / 科创板 / 题材黑名单（PCB·玻璃基板·光模块·液冷·通信·算力·芯片·靶材·电子气体·光刻胶·算力租赁）',
        '剔除：20 日滑动 10 日子窗口区间最大涨幅 ≥ 80%，或 20 日总涨幅 ≥ 100%',
        '剔除：连板准入后出现过单日涨幅 < -9%；剔除与自选科技股（isTech !== false）重叠',
      ],
    });
    ctx.link('gA1', 'poolA', { label: '是', tone: 'yes' });
    ctx.add('gA2', 'gate', { title: '近 10 日（收盘 1500 口径）「强度分−差劲分」出现**死叉** 且 死叉后达标（≥30）天数 ≤ 1？（上日差值 > 30 → 该日须较前 3 日均量**放量**）', w: 360 });
    ctx.link('poolA', 'gA2');
    ctx.add('waitA2', 'wait', { title: '机会已被历史消耗 / 前置不满足 → 不买', w: 260 }, { x: X2, y: ctx.pos.gA2.y + 6 });
    ctx.link('gA2', 'waitA2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitA2', 'start', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('gA3', 'gate', { title: '今日盘中逐桶「**强度分 − 差劲分 ≥ 30**」？（首次达到；多只候选取差值最大）', w: 330 });
    ctx.link('gA2', 'gA3', { label: '是', tone: 'yes' });
    ctx.add('waitA3', 'wait', { title: '逐桶继续实时判定', w: 220 }, { x: X2, y: ctx.pos.gA3.y + 6 });
    ctx.link('gA3', 'waitA3', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitA3', 'gA3', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('gA4', 'gate', { title: '买点门禁都通过？① 上日强度分 > 60 → 今日竞价低开须 ≥ -3%；② 触发时点未涨停（主板 > 9.5% / 创业·科创 > 19%）', w: 360 });
    ctx.link('gA3', 'gA4', { label: '是', tone: 'yes' });
    ctx.add('waitA4', 'wait', { title: '顺延差值排名下一只；均不可买则本桶不买', w: 270 }, { x: X2, y: ctx.pos.gA4.y + 6 });
    ctx.link('gA4', 'waitA4', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitA4', 'gA3', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: '顺延' });
    ctx.add('buyA', 'buy', { title: '【顺周期腿】按当桶分时价买入（半仓 ×0.5）', w: 310 });
    ctx.link('gA4', 'buyA', { label: '通过', tone: 'yes' });
    ctx.add('sellA', 'sell', leaderSellData({ instant: true, title: '【顺周期腿】卖点（9 条 · 任一触发即卖）' }), {});
    ctx.link('buyA', 'sellA', { label: '持仓期间', tone: 'sell' });
  });
  const legB = build((ctx) => {
    ctx.x = X1;
    const yB = legA.pos.gA1.y;
    ctx.add('gB1', 'gate', { title: '【逆周期腿】上证 3 日线斜率**连续为负 ≥ 2 天**？（转负当日 = 第 1 天，第 3 天起执行；转正 → 窗口重置、命中清零）', w: 330 }, { y: yB });
    ctx.add('waitB1', 'wait', { title: '未连续 2 天 → 继续逐日监控（转正则窗口重置、命中清零）', w: 270 }, { x: X2, y: yB + 6 });
    ctx.link('gB1', 'waitB1', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitB1', 'gB1', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('poolB', 'pool', {
      title: '【逆周期腿】候选池（= 反向抱团龙头）',
      w: 330,
      items: [
        '近 20 日出现过**连板 ≥ 2** 的个股（剔 ST / 创业板 / 科创板 / 题材黑名单）',
        '∩ 20 日内滑动 10 日子窗口区间最大涨幅 ≥ 60%（只保留近期已大幅拉升的强势抱团股）',
      ],
    }, { y: legA.pos.poolA.y });
    ctx.link('gB1', 'poolB', { label: '是 · 窗口开启', tone: 'yes' });
    ctx.add('hitsB', 'parallel', {
      title: '命中统计（并列 · 同日同股只计 1 次）',
      w: 330,
      items: [
        '① 当日上证指数跌幅 ≤ -0.5%',
        '② 盘中分时强度分 > 50（口径同顺周期腿）',
      ],
    }, { y: legA.pos.gA2.y });
    ctx.link('poolB', 'hitsB');
    ctx.add('gB2', 'gate', { title: '该股**累计第 2 次达标** 且 此刻未涨停？（已涨停 → 本次不买、等后续达标时点）', w: 320 }, { y: legA.pos.gA3.y });
    ctx.link('hitsB', 'gB2');
    ctx.add('waitB2', 'wait', { title: '等待后续达标（14:30 后命中登记照常累计、只是不买）', w: 280 }, { x: X2, y: legA.pos.gA3.y + 180 });
    ctx.link('gB2', 'waitB2', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitB2', 'hitsB', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: '继续累计' });
    ctx.add('buyB', 'buy', { title: '【逆周期腿】第 2 次达标的盘中分时买入（半仓 ×0.5）', w: 320 }, { y: legA.pos.gA4.y });
    ctx.link('gB2', 'buyB', { label: '是', tone: 'yes' });
    ctx.add('sellB', 'sell', {
      kind: 'sell',
      title: '【逆周期腿】卖点（8 条 + 斜率转正 · 任一触发即卖）',
      w: 350,
      items: [
        '① 跌破成本线 -5% 止损（须连续维持 ≥ 5 分钟）',
        '② 盘中分时较昨收跌幅 ≤ -5% 直接卖',
        '③ 开盘后较当日开盘价下挫 ≥ 5 个点直接卖',
        '④ 持仓股跌停（较昨收 < -9%）',
        '⑤ 高位放量大阴线：最高回落 > 8% 且现价 < 开盘价',
        '⑥ 持仓第 3 个交易日 14:57 收益未拉开 +10% 即卖',
        '⑦ 竞价低开 < -5% 按开盘价卖',
        '⑧ 当日收盘抗分歧指数 < 6 按尾盘价卖',
        '⑨ 上证 3 日线斜率盘中由负转正 → 立即按当桶分时价卖出',
      ],
      note: '价格类卖点按分钟级回溯成交；卖出后该腿当日不再追买（另一腿不受影响）',
    }, { y: legA.pos.buyA.y });
    ctx.link('buyB', 'sellB', { label: '持仓期间', tone: 'sell' });
  });
  // 合并双腿：两个 build 各自持有完整的 nodes/edges，直接拼接
  return {
    nodes: [...legA.nodes, ...legB.nodes],
    edges: [...legA.edges, ...legB.edges],
  };
};

// 科技进攻-情绪游资极致胜率（融合 · 账户风格独占）
const specFused = () =>
  build((ctx) => {
    ctx.add('start', 'start', {
      title: '空仓状态：逐桶同时评估 **A（科技进攻·快进快出）** 与 **B（情绪游资-极致胜率·双腿）** 买点',
      w: 460,
      sub: '账户按 2 个半仓槽计算，但同一时刻只允许一种风格持仓',
    });
    const y1 = ctx.yNow();
    ctx.add('same', 'gate', { title: '同一个时间桶内 A、B 买点**同时触发**？', w: 300 });
    ctx.add('stepA', 'step', { title: 'A（快进快出）优先级更高 → 本桶锁定 A、由 A 成交，B 本桶不再评估', w: 300 }, { x: X1, y: y1 + 6 });
    ctx.link('start', 'same');
    ctx.link('same', 'stepA', { label: '是 · A 优先', tone: 'yes', sh: 's-r', th: 't-l' });
    ctx.add('first', 'gate', { title: '不同桶 → 谁在**更早的桶**先触发？', w: 300 });
    ctx.link('same', 'first', { label: '否' });
    ctx.add('buyA', 'buy', {
      title: 'A 风格建仓：科技进攻（= 3日涨幅最大&三日情绪-30快进快出 完整流程）',
      w: 360,
      sub: '买点诊断 + 跨指数双门禁 + 选股过滤全流程；快进快出情形 → 首日半仓、次日补齐第二份半仓（同股）；非快进快出 → 首日即全仓；卖点走快进快出专属路径（10:00 强卖 / -2% 止损 / -7% 强卖）',
      note: 'A 持仓期间 B 被完全禁止，直至 A 全部平仓回到空仓',
    });
    ctx.link('first', 'buyA', { label: 'A 先触发', tone: 'yes' });
    ctx.link('stepA', 'buyA', { tone: 'yes' });
    ctx.add('buyB', 'buy', {
      title: 'B 风格建仓：情绪游资-极致胜率（双腿）',
      w: 330,
      sub: '顺周期腿（上证斜率 > 0 买低吸反转强势股）+ 逆周期腿（斜率连续为负 + 当日上证大跌买抱团强势股）各半仓、择时互补、不得同持一只；B 双腿每天 13:30 后不再买入',
      note: 'B 持仓期间 A 被完全禁止，直至 B 全部平仓回到空仓',
    }, { x: X1, y: ctx.pos.buyA.y });
    ctx.link('first', 'buyB', { label: 'B 先触发', tone: 'yes', sh: 's-r', th: 't-l' });
    const y3 = ctx.yNow();
    ctx.add('gq', 'gate', { title: 'B 持仓期间：某桶 **A 买点成交**（诊断全通过 + 双门禁通过 + 已选到可买标的）且 该桶实时科技情绪 > 0？', w: 370 });
    ctx.add('waitQ', 'wait', { title: '继续由 B 独占（A 保持禁止）', w: 250 }, { x: X1, y: y3 + 6 });
    ctx.link('buyB', 'gq', { label: 'B 独占期间', tone: 'flow', sh: 's-b', th: 't-t' });
    ctx.link('gq', 'waitQ', { label: '否', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitQ', 'buyB', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    const y4 = ctx.yNow();
    ctx.add('gq2', 'gate', { title: '存在「**当日买入**」的 B 风格持仓？', w: 300 });
    ctx.add('waitQ2', 'wait', { title: '放弃抢仓：当日新仓保留，账户继续 B 独占', w: 280 }, { x: X1, y: y4 + 6 });
    ctx.link('gq', 'gq2', { label: '是 · 满足抢仓条件', tone: 'yes' });
    ctx.link('gq2', 'waitQ2', { label: '是', tone: 'no', sh: 's-r', th: 't-l', dashed: true });
    ctx.link('waitQ2', 'buyB', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true });
    ctx.add('rob', 'step', { title: '【科技进攻抢仓】强制卖出 B **全部隔夜持仓**（买入日早于当日，按该桶分时价，卖出原因标注「科技进攻抢仓」）→ 同一时间桶内 A 接管账户建仓', w: 370 });
    ctx.link('gq2', 'rob', { label: '否', tone: 'yes' });
    ctx.link('rob', 'buyA', { tone: 'loop', sh: 's-t', th: 't-r', dashed: true, animated: true, label: 'A 接管建仓' });
    ctx.add('noteR', 'note', {
      title: '收益口径：A / B 每笔仓位按 [买入时刻, 卖出时刻] 区间，时间上重叠的仓位归入同一轮 → 轮内收益相加、跨轮复利；记录沿用极致胜率口径（B 带 splitLeg × cycle 标签，A 带快进快出标记）',
      w: 460,
    });
    ctx.link('rob', 'noteR', { tone: 'flow' });
  });

// ---------------- 策略 id → 流程 ----------------

const nBoardN = (id) => (/3board/.test(id) ? 3 : 2);
const vsN = (id) => {
  const m = /volume_share_(\d+)d/.exec(id);
  return m ? Number(m[1]) : 3;
};
const emoT = (id) => {
  const m = /emo(\d+)$/.exec(id);
  return m ? Number(m[1]) : 10;
};

export const getStrategyFlow = (id) => {
  const s = String(id || '');
  if (s === 'highest_gain') {
    return specNdGain('1', {
      rankTitle: '触发时点**当日盘中涨幅**最大',
      filters: [
        { key: 'fOneWord', q: '上一交易日一字板？（主板 ≥ 8% / 创业·科创 ≥ 16%）', bad: '是' },
        { key: 'fCycle', q: '逆周期？（与创业板指近 20 日相关性 ≤ 0）', bad: '是' },
        { key: 'fRes', q: '抗分歧 ≥ 9（全局门槛）且 ≥ 11（本策略专项门槛，逐层顺延）？', bad: '否' },
        { key: 'fLimit', q: '买入时点已涨停？', bad: '是' },
      ],
    });
  }
  // 10 日窗口为两位数，\dd 正则不匹配，需在通用分派前特判
  if (s === 'highest_10d_gain') return specNdGain('10');
  if (s === 'sci_attack_emo_win') return specFused();
  if (s === 'hot_money_extreme_win') return specExtremeWin();
  if (s === 'hot_money_reverse_leader') return specReverseLeader();
  if (/^hot_money_[23]board_attack$/.test(s)) return specNBoard(nBoardN(s));
  if (/^hot_money_volume_share_\dd$/.test(s)) return specVolumeShare(vsN(s));
  if (/^highest_\dd_gain_volume_share$/.test(s)) {
    const m = /highest_(\d+)d_gain_volume_share/.exec(s);
    return specGainVolumeShare(Number(m[1]));
  }
  if (/^hot_money_ice_rev_/.test(s)) return specIceRev(ndOf(s.replace('_ice_rev_', '_')).replace('undefined', '1'));
  if (/^hot_money_ice_/.test(s)) return specIce(ndOf(s));
  if (/highest_\dd_gain_emoquick_emo\d+$/.test(s)) return specEmoBreak(emoT(s));
  if (s === 'highest_3d_gain_emoquick_g10') return specEmoQuick('3', { g10: true });
  if (/highest_\dd5?_gain_emoquick_pulse$/.test(s)) return specPulse(ndOf(s));
  if (s === 'highest_3d_reports_top5_gain_emoquick') return specReportsEmoQuick();
  if (/highest_\dd_reports_top5_gain$/.test(s)) {
    const m = /highest_(\d+)d_reports_top5/.exec(s);
    return specReports(Number(m[1]), { top5: true });
  }
  if (/^highest_\dd_reports$/.test(s)) {
    const m = /highest_(\d+)d_reports$/.exec(s);
    return specReports(Number(m[1]));
  }
  if (/highest_\dd5?_gain_two_buy_same_day$/.test(s)) return specTwoBuySameDay();
  if (/highest_\dd5?_gain_two_buy_diff_block$/.test(s)) return specTwoBuyDiffBlock(ndOf(s));
  if (/highest_\dd5?_gain_two_buy_diff_stock$/.test(s)) return specTwoBuyDiffStock(ndOf(s));
  if (/highest_\dd5?_gain_two_buy$/.test(s)) return specTwoBuy(ndOf(s));
  if (/highest_\dd5?_gain_emoquick$/.test(s)) return specEmoQuick(ndOf(s));
  if (/highest_\dd5?_gain$/.test(s)) return specNdGain(ndOf(s));
  return null;
};

// ---------------- 图例 + 组件 ----------------

const LEGEND = [
  ['start', '开始 / 监控'],
  ['parallel', '并列条件 (AND)'],
  ['gate', '判断分支'],
  ['step', '处理步骤'],
  ['pool', '候选池'],
  ['hub', '顺延循环'],
  ['buy', '买入'],
  ['sell', '卖出 (OR)'],
  ['wait', '等待 / 跳过'],
];

const StrategyFlowDiagram = ({ strategyId, height = 560 }) => {
  const spec = useMemo(() => getStrategyFlow(strategyId), [strategyId]);
  if (!spec || !spec.nodes || spec.nodes.length === 0) return null;
  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 12px',
          marginBottom: 8,
          alignItems: 'center',
        }}
      >
        {LEGEND.map(([kind, label]) => {
          const m = KIND_META[kind];
          return (
            <span
              key={kind}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                color: '#4b5b74',
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 4,
                  background: m.bg,
                  border: `1.5px ${m.dashed ? 'dashed' : 'solid'} ${m.border}`,
                  display: 'inline-block',
                }}
              />
              {label}
            </span>
          );
        })}
        <span style={{ fontSize: 11, color: '#b07a2e' }}>橙虚线 = 顺延 / 重试循环</span>
        <span style={{ fontSize: 11, color: '#8a94a8' }}>滚轮缩放 · 拖拽平移</span>
      </div>
      <div
        style={{
          height,
          border: '1px solid #dbe4f0',
          borderRadius: 12,
          background: '#f8fafd',
          overflow: 'hidden',
        }}
      >
        <ReactFlow
          nodes={spec.nodes}
          edges={spec.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 0.9 }}
          minZoom={0.12}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#d5dfeb" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
};

export default StrategyFlowDiagram;
