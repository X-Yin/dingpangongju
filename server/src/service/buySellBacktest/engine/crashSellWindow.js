// 快进快出系列「盘中大跌强卖」（当日跌幅较昨收 ≤ EMO_QUICK_CRASH_PCT = -7%）触发点定位（统一口径）
//
// 2026-10-19 新增「竞价低开自救窗口」（用户新增）：
//   ① 若当日首个分时点（9:30 竞价/开盘首分钟）当日跌幅已 ≤ -7%（竞价大幅低开）：
//      —— 不再在首分钟直接卖出，改为逐分钟跟踪：取 10:00 前（minute < 1000）第一个「分钟价低于上一分钟」
//         且该分钟跌幅仍 ≤ -7% 的分钟为卖出点（模拟「低开后资金自救拉升、等拉升结束回落再卖」；
//         若价格回补至 -7% 上方则该分钟不计，继续等待，回落至阈值下方并再次回落才卖）；
//      —— 若 10:00 前始终未出现该类回落点，则仅当 10:00 时点跌幅仍 ≤ -7% 时按该时点价卖出
//         （未回落但也没修复 → 兜底成交；若 10:00 已回补至阈值上方说明自救成功，本次大跌强卖作废、
//         不成交，持仓交由其他卖点规则接管）。
//   ② 否则（盘中才跌破 -7%，非竞价低开）维持即时卖出：当日首个跌幅 ≤ -7% 的分钟。
// upToMinute：仅允许使用不晚于该分钟的分时点（桶级调用传当桶分钟，避免未来数据；日级调用传 Infinity）。
//
// 返回 { kind, pt, firstPt, firstBelowPt }：
//   kind = 'none'      无可用分时数据
//          'immediate' 非竞价低开，即时卖出（pt）
//          'window'    竞价低开，自救窗口内首个回落分钟（pt）
//          'window10'  竞价低开，窗口内无回落 → 10:00 时点（pt）
//          'wait'      竞价低开，截至 upToMinute 尚未出现回落点（本次不卖，等后续桶再评估）
const { EMO_QUICK_CRASH_PCT } = require('../constants');

const fmtMin = (m) => `${String(Math.floor(Number(m) / 100)).padStart(2, '0')}:${String(Number(m) % 100).padStart(2, '0')}`;
const pctTxt = (v) => (v == null || Number.isNaN(Number(v)) ? '缺失' : `${Number(v).toFixed(2)}%`);

const locateCrashSellPoint = (pts, { upToMinute = Infinity } = {}) => {
  const list = (pts || [])
    .filter(p => p && p.minute != null && p.lastPx != null && Number(p.lastPx) > 0)
    .map(p => ({
      minute: Number(p.minute),
      lastPx: Number(p.lastPx),
      change: p.change == null || Number.isNaN(Number(p.change)) ? null : Number(p.change),
    }))
    .sort((a, b) => a.minute - b.minute);
  const out = { kind: 'none', pt: null, firstPt: list[0] || null, firstBelowPt: null };
  if (list.length === 0) return out;
  const isBelow = (p) => p.change != null && p.change <= EMO_QUICK_CRASH_PCT;
  const inRange = (p) => p.minute <= upToMinute;
  out.firstBelowPt = list.find(isBelow) || null;

  const firstPt = list[0];
  if (!isBelow(firstPt)) {
    // 非竞价低开：即时卖出（首个跌幅 ≤ 阈值的分钟，且已在允许范围内）
    if (out.firstBelowPt && inRange(out.firstBelowPt)) {
      out.kind = 'immediate';
      out.pt = out.firstBelowPt;
    }
    return out;
  }

  // 竞价低开自救窗口
  out.kind = 'wait';
  for (let i = 1; i < list.length; i++) {
    const cur = list[i];
    if (cur.minute >= 1000) break; // 09:31~09:59 窗口
    if (!inRange(cur)) return out; // 桶级调用：尚未推进到该分钟，等后续桶
    if (cur.lastPx < list[i - 1].lastPx && isBelow(cur)) {
      out.kind = 'window';
      out.pt = cur;
      return out;
    }
  }
  const at10 = list.find(p => p.minute >= 1000) || null;
  if (at10 && inRange(at10) && isBelow(at10)) {
    out.kind = 'window10';
    out.pt = at10;
  }
  return out;
};

// 生成卖出原因中与触发点相关的描述片段（各调用方自行拼接前缀与后缀）
const describeCrashSell = ({ kind, pt, firstPt }) => {
  if (!pt) return '';
  if (kind === 'window') {
    return `开盘首分钟 ${fmtMin(firstPt.minute)} 已 ≤ ${EMO_QUICK_CRASH_PCT}%（竞价低开 ${pctTxt(firstPt.change)}），自救拉升于 ${fmtMin(pt.minute)} 回落且仍 ≤ ${EMO_QUICK_CRASH_PCT}%（${pctTxt(pt.change)}），按该分钟价 ${Number(pt.lastPx).toFixed(2)} 成交`;
  }
  if (kind === 'window10') {
    return `开盘首分钟 ${fmtMin(firstPt.minute)} 已 ≤ ${EMO_QUICK_CRASH_PCT}%（竞价低开 ${pctTxt(firstPt.change)}），10:00 前未出现回落，按 10:00 时点价 ${Number(pt.lastPx).toFixed(2)} 成交`;
  }
  return `${fmtMin(pt.minute)} 当日跌幅（较昨收）${pctTxt(pt.change)} ≤ ${EMO_QUICK_CRASH_PCT}%`;
};

module.exports = { locateCrashSellPoint, describeCrashSell, fmtMin, pctTxt };
