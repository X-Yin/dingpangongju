/**
 * 板块情绪周期判定（统一算法）
 *
 * 三处共用同一套规则：
 * - 复盘页「四维立体」板块情绪周期（siweiLiti.js）
 * - 盯盘页情绪周期按钮（/siwei_liti_analysis?realtime=1 → siweiLiti.js）
 * - block_amount_poll.js 每 5 分钟触发的即时情绪共振检查（emotionResonance.js → siweiLiti.js）
 *
 * 规则：
 *   涨停≥10 且占比提升 = 全面高潮；涨停≥10 且占比降低 = 一致加速；
 *   涨停 6~9 且占比提升：前一日 ≥10（高潮档）计爆量分歧，否则计全面高潮；
 *   涨停 6~9 且占比降低 = 弱势震荡；
 *   涨停≤5：较前一日增加 = 弱势震荡（情绪修复），否则 = 退潮
 */
const PHASE_ORDER = { 全面高潮: 4, 一致加速: 3, 爆量分歧: 2, 弱势震荡: 1, 退潮: 0 };

const calcPhase = ({ count, prevCount, ratio, prevRatio }) => {
  const ratioText = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}%` : '--');
  const countText = prevCount != null ? `${prevCount}→${count}` : `${count}`;
  const ratioTrend = Number.isFinite(Number(ratio)) && Number.isFinite(Number(prevRatio))
    ? Number(ratio) - Number(prevRatio)
    : null;
  const ratioUp = ratioTrend == null ? null : ratioTrend > 0;
  const ratioDesc = ratioTrend == null
    ? '无占比数据'
    : `${ratioText(prevRatio)}→${ratioText(ratio)}（${ratioTrend > 0 ? '提升' : '降低'}）`;

  if (count <= 5) {
    // 涨停家数较前一日增加：即便仍≤5 也按弱势震荡计，不直接判定退潮
    if (prevCount != null && count > prevCount) {
      return { phase: '弱势震荡', reason: `涨停 ${countText} 家（≤5），较前一日增加，按弱势震荡计` };
    }
    return { phase: '退潮', reason: `涨停 ${count} 家（≤5），${prevCount != null ? `较前一日 ${countText}` : '情绪冰点'}` };
  }
  if (count < 10) {
    if (ratioUp) {
      // 限制：仅当前一日处于高潮档（家数≥10，即全面高潮/一致加速）时才算爆量分歧，否则按全面高潮计
      const prevHigh = prevCount != null && prevCount >= 10;
      return prevHigh
        ? { phase: '爆量分歧', reason: `涨停 ${countText} 家（6~9），占比 ${ratioDesc}，前一日 ${prevCount} 家（高潮档）` }
        : { phase: '全面高潮', reason: `涨停 ${countText} 家（6~9），占比 ${ratioDesc}，前一日未达高潮档，按全面高潮计` };
    }
    return { phase: '弱势震荡', reason: `涨停 ${countText} 家（6~9），占比 ${ratioDesc}` };
  }
  return { phase: ratioUp ? '全面高潮' : '一致加速', reason: `涨停 ${countText} 家（≥10），占比 ${ratioDesc}` };
};

module.exports = { calcPhase, PHASE_ORDER };
