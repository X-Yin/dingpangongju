// 前端实时买点诊断：双指数 3 日线斜率门禁查询
// 后端 API: GET /api/index-slope-gate?code=sh688361&date=20260918&minute=1455
// 返回: { trackedIndex, cybGate, starGate, gatePassed, allowedMarkets }
// 两个指数各自独立判定后合并；非适用策略直接显示"跳过"

const GATE_RULES = [
  { key: '③a', label: '今日盘中由正转负', detail: '前收盘>0、当前斜率≤0 → T日禁止' },
  { key: '③b', label: '由正转负后第1天（盘中未转正）', detail: '前一天转负、今天 slope<0 且盘中未转正 → T+1日禁止；但T+1日盘中又转正则解禁' },
  { key: '②',  label: '由负转正窗口',             detail: 'slope≥0 且距最近转正 ≤1天 → 允许' },
  { key: '①',  label: '负斜率',                   detail: 'slope<0 且不在③a③b窗口 → 始终允许' },
];

const INDEX_NAMES = { sz399006: '创业板指', sh000688: '科创50' };

export const fetchIndexSlopeGate = async (code, date, minute, baseUrl = '') => {
  if (!code) return null;
  const url = `${baseUrl}/api/index-slope-gate?code=${encodeURIComponent(code)}&date=${date || ''}&minute=${minute || ''}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success) return null;
    return data;
  } catch (e) {
    return null;
  }
};

// 从 fetch 结果里提取某只股票应该显示的诊断文字（短版，适合 tooltip）
// 返回 { passed, label, detail }
export const formatGateDiagnosis = (gateResult, isApplicable = true) => {
  if (!isApplicable) return { passed: true, label: '（该策略不适用指数斜率门禁）', detail: '重点板块/尾盘抄底/情绪游资/三日情绪冰点策略跳过此检查' };
  if (!gateResult) return { passed: true, label: '指数斜率门禁数据暂不可用', detail: '可能是实时行情数据尚未就绪，请稍后刷新' };

  const { trackedIndex, cybGate, starGate, gatePassed } = gateResult;
  const trackedIdxName = INDEX_NAMES[trackedIndex] || trackedIndex;
  const trackedGate = trackedIndex === 'sh000688' ? starGate : cybGate;

  const slopeStr = trackedGate?.slope != null ? `${trackedGate.slope >= 0 ? '+' : ''}${trackedGate.slope.toFixed(2)}°` : '数据不足';
  let passedLabel = gatePassed ? '允许出手' : '禁止出手';

  return {
    passed: !!gatePassed,
    label: `跟踪${trackedIdxName}，3日线斜率 ${slopeStr}，${passedLabel}`,
    detail: trackedGate?.reason || '门禁判定失败',
    raw: gateResult,
  };
};

export { GATE_RULES, INDEX_NAMES };
