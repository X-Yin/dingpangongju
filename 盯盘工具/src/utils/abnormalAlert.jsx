import { Modal } from 'antd';
import axios from 'axios';
import { local_ip } from '../constant';

const API_BASE = `http://${local_ip}:3000`;

// A 股严重异常波动（异动）指标：连续 10 个交易日累计偏离值达 +100% / 跌幅 -50%，
// 连续 30 个交易日累计偏离值达 +200% / 跌幅 -70%
// 交易所口径的「收盘价涨跌幅偏离值累计值」=（个股期末价/期初前收盘价-1）-（对应分类指数期末点位/期初前收盘点位-1），
// 即个股区间涨跌幅要扣掉对应指数区间涨跌幅，不能只看个股自身涨幅
export const ABNORMAL_ALERT_RULES = [
  { days: 10, up: 100, down: -50 },
  { days: 30, up: 200, down: -70 },
];
export const ABNORMAL_ALERT_NEAR_POINTS = 10; // 距阈值 10 个百分点以内视为「临近异动」

// 各板块对应的「分类指数」（交易所偏离值口径的基准）
export const INDEX_BENCHMARK_NAMES = {
  sh000001: '上证综指',
  sh000688: '科创50',
  sz399001: '深证成指',
  sz399006: '创业板指',
};

const formatPct = (v, { sign = true } = {}) => {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return '--';
  const num = Number(v);
  const prefix = sign && num > 0 ? '+' : '';
  return `${prefix}${num.toFixed(2)}%`;
};

// 异动阈值基准（个股 + 对应指数的 10/30 交易日基准点位），后端按自然日缓存
export const fetchAbnormalBasis = async (marketCodes) => {
  const codes = [...new Set((Array.isArray(marketCodes) ? marketCodes : [marketCodes])
    .map((c) => String(c || '').trim().toLowerCase())
    .filter((c) => /^(sh|sz)\d{6}$/.test(c)))];
  if (codes.length === 0) return {};
  const res = await axios.get(`${API_BASE}/theme_monitor_alert_basis`, { params: { codes: codes.join(',') } });
  return res.data || {};
};

// 基准指数实时点位（上证综指 / 深证成指 / 创业板指 / 科创50）
export const fetchIndexQuotes = async () => {
  const res = await axios.get(`${API_BASE}/theme_monitor_index_quotes`);
  return res.data || {};
};

// 对应分类指数的区间累计涨跌幅（%）：优先用实时点位，取不到时退回最近收盘点位
const getIndexCumPct = (basis, days, indexQuote) => {
  const indexBase = Number(days === 10 ? basis?.indexBase10 : basis?.indexBase30);
  if (!Number.isFinite(indexBase) || indexBase <= 0) return null;
  const live = Number(indexQuote?.price);
  const current = Number.isFinite(live) && live > 0 ? live : Number(basis?.indexLastClose);
  if (!Number.isFinite(current) || current <= 0) return null;
  return (current / indexBase - 1) * 100;
};

// 个股在指定窗口的累计偏离值：个股区间涨跌幅 - 对应指数区间涨跌幅
const getDeviation = (basis, price, days, indexQuote) => {
  const base = Number(days === 10 ? basis?.base10 : basis?.base30);
  const last = Number(price);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(last) || last <= 0) return null;
  const stockPct = (last / base - 1) * 100;
  const indexCum = getIndexCumPct(basis, days, indexQuote);
  return { stockPct, indexCum, deviationPct: indexCum == null ? stockPct : stockPct - indexCum };
};

// 结合「历史基准收盘价 + 对应指数基准点位 + 当前实时价/指数点位」计算某只个股的异动状态
// 返回 { level: 'trigger' | 'near', days, threshold, deviationPct, stockPct, indexCum, targetPrice, gap }，未临近时返回 null
export const getAbnormalAlert = (basis, price, indexQuote) => {
  const last = Number(price);
  if (!basis || !Number.isFinite(last) || last <= 0) return null;
  const candidates = [];
  ABNORMAL_ALERT_RULES.forEach(({ days, up, down }) => {
    const calc = getDeviation(basis, last, days, indexQuote);
    if (!calc) return;
    const { deviationPct, stockPct, indexCum } = calc;
    const base = Number(days === 10 ? basis.base10 : basis.base30);
    [up, down].forEach((threshold) => {
      const dir = threshold > 0 ? 1 : -1;
      const gap = dir > 0 ? threshold - deviationPct : deviationPct - threshold;
      // 异动价：偏离值刚好达到阈值时的个股价格（按当前指数区间涨幅折算）
      const targetPrice = base * (1 + (threshold + (indexCum || 0)) / 100);
      const item = { days, threshold, deviationPct, stockPct, indexCum, targetPrice, gap };
      if (gap <= 0) candidates.push({ ...item, level: 'trigger', gap: 0 });
      else if (gap <= ABNORMAL_ALERT_NEAR_POINTS) candidates.push({ ...item, level: 'near' });
    });
  });
  if (candidates.length === 0) return null;
  const triggered = candidates.filter((c) => c.level === 'trigger');
  if (triggered.length > 0) return triggered.sort((a, b) => a.days - b.days)[0];
  return candidates.sort((a, b) => a.gap - b.gap)[0];
};

// 异动查询用的双窗口明细：固定返回 10 日 / 30 日两组，各自标注是否触发
// 只展示未触发窗口会让「已触发 10 日、未触发 30 日」的个股看起来只有 30 日口径
export const getAbnormalWindowRows = (basis, price, indexQuote) => {
  const last = Number(price);
  if (!basis || !Number.isFinite(last) || last <= 0) return [];
  return ABNORMAL_ALERT_RULES.map(({ days, up }) => {
    const calc = getDeviation(basis, last, days, indexQuote);
    const base = Number(days === 10 ? basis.base10 : basis.base30);
    const deviationPct = calc ? calc.deviationPct : null;
    const indexCum = calc ? calc.indexCum : null;
    const stockPct = calc ? calc.stockPct : null;
    const triggered = deviationPct != null && deviationPct >= up;
    const gap = deviationPct == null ? null : up - deviationPct;
    // 异动价：偏离值刚好达到阈值时的个股价格（按当前指数区间涨幅折算）
    const targetPrice = Number.isFinite(base) && base > 0
      ? base * (1 + (up + (indexCum || 0)) / 100)
      : null;
    const needPct = targetPrice ? (targetPrice / last - 1) * 100 : null;
    return {
      days,
      threshold: up,
      deviationPct,
      stockPct,
      indexCum,
      targetPrice,
      needPct,
      triggered,
      near: !triggered && gap != null && gap <= ABNORMAL_ALERT_NEAR_POINTS,
    };
  });
};

// 「异动查询」弹窗：同时展示 10 日 / 30 日两个窗口的触发状态
// stock: { name }，quote: { price }，basis: 后端基准数据，indexQuote: 对应指数的实时点位
export const showAbnormalQuery = (stock, quote, basis, indexQuote) => {
  const price = Number(quote?.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  const rows = getAbnormalWindowRows(basis, hasPrice ? price : null, indexQuote);
  const indexName = basis?.indexCode ? INDEX_BENCHMARK_NAMES[basis.indexCode] || basis.indexCode : null;
  let content;
  if (!hasPrice) {
    content = <div>当前无实时行情（停牌或未开盘），暂无法计算异动偏离值。</div>;
  } else if (rows.length === 0) {
    content = <div>暂无历史基准数据，无法计算异动偏离值。</div>;
  } else {
    content = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>当前价：<b>{price.toFixed(2)}</b>{indexName ? `，对应基准指数：${indexName}` : ''}</div>
        {rows.map((row) => (
          <div key={row.days} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div>
              连续 {row.days} 个交易日累计偏离值达 {formatPct(row.threshold, { sign: false })}：
              {row.triggered
                ? <b style={{ color: '#cf1322' }}>已触发</b>
                : <b style={{ color: row.near ? '#d46b08' : '#595959' }}>{row.near ? '临近（未触发）' : '未触发'}</b>}
              <span style={{ marginLeft: 8 }}>当前偏离值 <b>{formatPct(row.deviationPct)}</b></span>
            </div>
            <div style={{ fontSize: 12, color: '#8c8c8c' }}>
              个股区间涨跌幅 {formatPct(row.stockPct)}，
              已扣除{indexName || '对应指数'}区间涨跌幅 {formatPct(row.indexCum)}
            </div>
            {!row.triggered && row.targetPrice != null && (
              <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                未来异动价 <b style={{ color: '#595959' }}>{row.targetPrice.toFixed(2)}</b>，
                还需涨幅 <b style={{ color: '#cf1322' }}>{formatPct(row.needPct)}</b>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  Modal.info({ title: `${stock?.name || '个股'} 异动查询`, content, okText: '知道了' });
};
