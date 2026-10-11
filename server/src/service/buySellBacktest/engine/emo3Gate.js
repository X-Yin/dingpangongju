const { loadIndexKline } = require('../deps');

const EMO3_GATE_INDEX_CODES = [
  { code: 'sz399006', name: '创业板指', cacheName: 'cyb_kline.json', pureCode: '399006', market: '32' },
  { code: 'sh000688', name: '科创50', cacheName: 'kcb50_kline.json', pureCode: '1B0688', market: '16' },
  { code: 'sh000001', name: '上证指数', cacheName: 'sh_kline.json', pureCode: '1A0001', market: '16' },
];
// 门禁结果缓存：key `${dateStr}_${indexCode}`（历史数据不可变，进程内缓存即可）
const emo3IndexGateCache = new Map();
const trackedIndexCodeOf = (code) => (String(code).toLowerCase().startsWith('sh688') ? 'sh000688' : 'sz399006');

const calcEmo3IndexGate = async (dateStr, indexCode) => {
  const conf = EMO3_GATE_INDEX_CODES.find(c => c.code === indexCode) || EMO3_GATE_INDEX_CODES[0];
  try {
    const kline = await loadIndexKline(conf.cacheName, conf.pureCode, conf.market, 500);
    const target = Number(dateStr);
    const bars = (kline || [])
      .filter(k => Number.isFinite(Number(k.trade_date)) && Number(k.trade_date) <= target
        && Number.isFinite(Number(k.close_px)) && Number(k.close_px) > 0)
      .sort((a, b) => Number(a.trade_date) - Number(b.trade_date))
      .map(k => Number(k.close_px));
    if (bars.length < 60) {
      // MA60 需要至少 60 根日K；数据不足按不满足处理（宁可不买）
      console.error(`三日情绪冰点指数门禁 ${conf.name} ${dateStr} 日K数据不足（${bars.length}/60 根），按不满足处理`);
      return { indexCode: conf.code, indexName: conf.name, passed: false, error: `指数日K数据不足（${bars.length}/60 根）` };
    }
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const avgLast = (period, endOffset) => {
      // bars 升序、末位为触发日；endOffset=0 取最近 period 根，=5 取截止 5 个交易日前（不含其间）的 period 根
      const arr = bars.slice(bars.length - period - endOffset, bars.length - endOffset);
      return arr.reduce((s, v) => s + v, 0) / period;
    };
    const ma20Now = r4(avgLast(20, 0));
    const ma20Prev = r4(avgLast(20, 5));
    const ma30 = r4(avgLast(30, 0));
    const ma60 = r4(avgLast(60, 0));
    const slope20 = r4(ma20Now - ma20Prev);
    const cond1 = slope20 > 0; // ① 近 5 个交易日 20 日线斜率为正
    const cond2 = ma30 < ma60; // ② 30 日线在 60 日线下方
    return { indexCode: conf.code, indexName: conf.name, passed: cond1 || cond2, cond1, cond2, slope20, ma20Now, ma20Prev, ma30, ma60 };
  } catch (e) {
    console.error(`三日情绪冰点指数门禁 ${conf.name} ${dateStr} 计算失败: ${e.message}`);
    return { indexCode: conf.code, indexName: conf.name, passed: false, error: e.message || String(e) };
  }
};

// 按日预计算两只跟踪指数的门禁结果（仅三日情绪冰点策略需要；pickBestStock 内同步查表过滤候选）
const ensureEmo3DayGates = async (dateStr) => {
  await Promise.all(EMO3_GATE_INDEX_CODES.map(async ({ code }) => {
    const key = `${dateStr}_${code}`;
    if (emo3IndexGateCache.has(key)) return;
    emo3IndexGateCache.set(key, await calcEmo3IndexGate(dateStr, code));
  }));
};

// 门禁命中的买入条件明细项（展示命中了哪个条件与具体数值，随 buyChecks 持久化到成交记录）
const buildEmo3GateCheck = (gate) => {
  const fmt = (v) => (v > 0 ? `+${v}` : `${v}`);
  const cond1Text = `近5个交易日20日线斜率为正（MA20 ${gate.ma20Now}，5个交易日前 ${gate.ma20Prev}，斜率 ${fmt(gate.slope20)}）`;
  const cond2Text = `30日线在60日线下方（MA30 ${gate.ma30} < MA60 ${gate.ma60}）`;
  return {
    id: 'emo3_index_gate',
    title: `跟踪指数环境门禁（${gate.indexName}，满足其一）`,
    passed: true,
    value: gate.cond1 ? `20日线斜率 ${fmt(gate.slope20)}` : `MA30 ${gate.ma30} < MA60 ${gate.ma60}`,
    reason: `①${cond1Text}；②${cond2Text}；两个条件满足其一才允许尾盘抄底买入，当前${gate.cond1 ? '命中①' : '命中②'}`,
  };
};

// 计算个股 MA3 切线正斜率连续天数（从 targetDateStr 倒着数，包括 targetDateStr 本身）
// MA3 切线公式 B：MA3(今日) − MA3(昨日)；avg(i,d) = closes.slice(i, i+d).reduce(...) / d
// closes 是按日期降序的 [{date, close}] 数组，[0] = 目标日，[1] = 前一日，...
// 返回：连续正的天数（含当日）；斜率非正返回 0；数据不足返回 null（调用方保守放行）
const countStockPositiveSlopeDays = (code, targetDateStr, dailyInfos) => {
  if (!dailyInfos) return null;
  const codeStr = String(code);
  const dates = [...dailyInfos.keys()].sort((a, b) => b - a);
  const closes = [];
  for (const d of dates) {
    const info = dailyInfos.get(d)?.get(codeStr);
    if (info?.closePx != null && info.closePx > 0) closes.push({ date: d, close: Number(info.closePx) });
    if (closes.length >= 10) break;
  }
  if (closes.length < 4) return null;
  const avg = (i, d) => closes.slice(i, i + d).reduce((s, v) => s + v.close, 0) / d;
  const slopeToday = avg(0, 3) - avg(1, 3);
  if (!Number.isFinite(slopeToday)) return null;
  if (slopeToday <= 0) return 0;
  let count = 1;
  for (let i = 1; i + 3 <= closes.length; i++) {
    const slope = avg(i, 3) - avg(i + 1, 3);
    if (!Number.isFinite(slope)) break;
    if (slope > 0) count++;
    else break;
    if (count >= 6) break; // 用户关心 ≤4，算到 5 就够了
  }
  return count;
};

// 科技板块前三系列（tech_block_top3_*）取前几的板块数量

module.exports = {
  EMO3_GATE_INDEX_CODES,
  buildEmo3GateCheck,
  calcEmo3IndexGate,
  countStockPositiveSlopeDays,
  emo3IndexGateCache,
  ensureEmo3DayGates,
  trackedIndexCodeOf,
};
