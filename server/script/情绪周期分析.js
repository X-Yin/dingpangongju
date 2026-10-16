#!/usr/bin/env node
/**
 * 情绪周期五阶段回溯分析（朦胧 / 聚焦 / 分歧 / 加速 / 搏傻）
 *
 * 数据源: server/src/data/lianbanSnapshot/*.json（每日涨停快照，含板块/连板数/封板时间等）
 * 输出  : 同级目录 情绪周期分析_<起始>-<结束>.html（可视化） + stdout 分类摘要
 *
 * 判定思路（把提示词里的定性描述翻译成可量化的信号）：
 *   - 大周期识别：以"5 连板以上的高标个股链"为锚，同族板块且间隔<=2个交易日的链合并为一个周期，
 *     周期窗口 = 首板日前3天 ~ 末日板后3天；每天按"死亡确认 > 存活龙头更高 > 最早发芽"归属到唯一周期。
 *   - 朦胧期：近3日多个板块涨停>=5家、主线涨停占比低、空间高度<=2板。
 *   - 聚焦期：主线涨停占比>=30%、龙头>=2板续板、板块内有首板（梯队完整）、其他板块萎缩。
 *   - 分歧期：龙头断板（但主线未死透/2日内回流）或尾盘才回封（烂板分歧）。
 *   - 加速期：龙头分歧/断板后续板新高、主线家数回升（分歧转一致、资金回流）。
 *   - 搏傻期：龙头>=5板独自新高，主线仅剩<=3家（首板断档、小弟掉队）。
 *   - 退潮终结：龙头断板且2日内不回流、主线缩量到峰值40%以下（周期死亡，过渡到下一轮朦胧）。
 */
const fs = require('fs');
const path = require('path');

const SNAP_DIR = path.resolve(__dirname, '../src/data/lianbanSnapshot');

/* ---------------- 常量 ---------------- */

// 事件/业绩类伪题材：不作为主线候选，但计入"其他板块"家数
const PSEUDO_THEMES = new Set(['其他', '中报增长', '三季报增长', '并购重组', '新股', '次新股', '摘帽', '含可转债', '妖股']);

// 板块 -> 产业链家族（归并口径不一的命名，如 通信(PCB)/算力(液冷) → AI硬件）
const FAMILIES = [
  ['AI硬件', ['PCB', '通信', '光模块', 'CPO', '液冷', '算力', '服务器', '数据中心', '光纤', '铜缆', '连接器', '元器件', '覆铜板']],
  ['半导体', ['芯片', '半导体', '存储', '封测', '晶圆', '光刻', '电子']],
  ['AI应用', ['AI应用', 'AI大模型', '智能体', '物理AI', '端侧AI', '人工智能', 'AI视频', 'AIGC', 'AI']],
  ['机器人', ['机器人', '减速器', '人形']],
  ['医药', ['医药', '疫苗', '创新药', '中药', '医疗', '保健品', '眼科']],
  ['电力能源', ['电力', '电网', '风电', '核电', '绿电', '储能', '锂电池', '光伏', '煤炭', '石油', '天然气', '智能电网']],
  ['农业', ['农业', '种业', '养殖', '猪肉', '粮食', '化肥', '转基因']],
  ['传媒教育', ['传媒', '出版', '文化', '影视', '游戏', '体育', '教育', '知识产权']],
  ['大消费', ['食品', '饮料', '白酒', '零售', '旅游', '家居', '家电', '纺织', '服装', '商业', '消费', '预制菜']],
  ['地产基建', ['地产', '房地产', '基建', '建筑', '建材', '装修', '基础建设']],
  ['军工航天', ['航天', '军工', '卫星', '大飞机', '商业航天', '兵装']],
  ['金融', ['券商', '银行', '保险', '金融', '多元金融']],
  ['有色贵金属', ['有色', '黄金', '白银', '稀土', '铜', '铝', '小金属', '贵金属']],
  ['汽车', ['汽车', '整车', '智能驾驶', '汽车零部件']],
  ['化工', ['化工', '化学', '橡胶', '塑料']],
];

const STAGE = {
  HAZY:  { key: 'hazy',  name: '朦胧期', color: '#8c8c8c', bg: '#fafafa' },
  FOCUS: { key: 'focus', name: '聚焦期', color: '#1890ff', bg: '#e6f4ff' },
  DIV:   { key: 'div',   name: '分歧期', color: '#d48806', bg: '#fffbe6' },
  ACC:   { key: 'acc',   name: '加速期', color: '#f5222d', bg: '#fff1f0' },
  FOMO:  { key: 'fomo',  name: '搏傻期', color: '#722ed1', bg: '#f9f0ff' },
  END:   { key: 'end',   name: '退潮终结', color: '#595959', bg: '#f0f0f0' },
};

/* ---------------- 工具 ---------------- */

const normTheme = (n) => (n || '').replace(/\(.*?\)/g, '').replace(/概念|板块/g, '').trim();

function themeFamily(name) {
  const n = normTheme(name);
  if (PSEUDO_THEMES.has(n)) return null;
  for (const [fam, kws] of FAMILIES) {
    if (kws.some((k) => n.includes(k))) return fam;
  }
  return n || '未分类';
}

const fmtDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fmtShort = (d) => `${d.slice(4, 6)}/${d.slice(6, 8)}`;

/* ---------------- 1. 加载快照，计算每日指标 ---------------- */

const files = fs.readdirSync(SNAP_DIR).filter((f) => /^\d{8}\.json$/.test(f)).sort();
if (!files.length) { console.error('未找到快照数据'); process.exit(1); }

const days = files.map((f) => {
  const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
  const themes = (j.themes || []).map((t) => {
    const stocks = t.stocks || [];
    return {
      board: t.board,
      norm: normTheme(t.board),
      family: themeFamily(t.board),
      count: t.count != null ? t.count : stocks.length,
      stocks,
      firstN: stocks.filter((s) => (s.lianbanCount || 1) === 1).length,
      lianbanN: stocks.filter((s) => (s.lianbanCount || 1) >= 2).length,
      maxH: stocks.reduce((m, s) => Math.max(m, s.lianbanCount || 1), 0),
    };
  });
  const codeSet = new Set();
  themes.forEach((t) => t.stocks.forEach((s) => codeSet.add(s.code)));
  return {
    date: j.date,
    totalZt: j.summary && j.summary.totalCount ? j.summary.totalCount : codeSet.size,
    themes,
    temp: j.sentiment ? j.sentiment.temperature : null,
    phase: j.sentiment ? j.sentiment.phase : '',
  };
});
const N = days.length;
const dateIdx = new Map(days.map((d, i) => [d.date, i]));

/* ---------------- 2. 个股连板链（允许断<=2日的反包/N天M板口径） ---------------- */

// 外观表：name -> [{i, h, board, family, sealTime, early, fanbao}]（同日多题材归属只记一次）
const appear = new Map();
for (let i = 0; i < N; i++) {
  const seen = new Set();
  for (const t of days[i].themes) {
    for (const s of t.stocks) {
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      const h = s.lianbanCount || 1;
      if (!appear.has(s.name)) appear.set(s.name, []);
      appear.get(s.name).push({ i, h, board: t.board, family: t.family, sealTime: s.sealTime, early: s.early, fanbao: s.fanbao });
    }
  }
}

const chains = []; // { name, days:[{i,h,board,family,sealTime}], peakH, peakI, startI, endI, family }
for (const [name, arr] of appear) {
  arr.sort((a, b) => a.i - b.i);
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const peak = cur.reduce((m, x) => (x.h > m.h ? x : m), cur[0]);
    const famCount = {};
    cur.forEach((x) => { if (x.family) famCount[x.family] = (famCount[x.family] || 0) + 1; });
    let fam = peak.family, best = -1;
    for (const [k, v] of Object.entries(famCount)) if (v > best) { best = v; fam = k; }
    chains.push({ name, days: cur, peakH: peak.h, peakI: peak.i, startI: cur[0].i, endI: cur[cur.length - 1].i, family: fam, sparse: cur.length < peak.h });
    cur = [];
  };
  for (const a of arr) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      if (a.i - prev.i > 2 || a.h <= prev.h) { flush(); }
    }
    cur.push(a);
  }
  flush();
}
chains.sort((a, b) => a.startI - b.startI || b.peakH - a.peakH);
const chainHasDay = (ch, i) => ch.days.some((x) => x.i === i);
const chainH = (ch, i) => { const x = ch.days.find((d) => d.i === i); return x ? x.h : 0; };

/* ---------------- 3. 大周期识别（高标锚定 + 窗口 + 每日归属） ---------------- */

const seeds = chains.filter((c) => c.peakH >= 5).sort((a, b) => a.startI - b.startI);

const cycles = [];
for (const sd of seeds) {
  const last = cycles[cycles.length - 1];
  // 同家族且间隔<=2个交易日 → 合并进上一周期（龙头接力）
  if (last && last.family === sd.family && sd.startI <= last.seedEndI + 2) {
    last.chains.push(sd);
    last.seedEndI = Math.max(last.seedEndI, sd.endI);
    last.seedStartI = Math.min(last.seedStartI, sd.startI);
    if (sd.peakH > last.primary.peakH) last.primary = sd;
    continue;
  }
  cycles.push({
    chains: [sd], primary: sd,
    seedStartI: sd.startI, seedEndI: sd.endI,
    windowStartI: Math.max(0, sd.startI - 3), windowEndI: Math.min(N - 1, sd.endI + 3),
    family: sd.family, // 初值，归属完成后按板块家数重定主线
  });
}

// 每日归属：死亡确认 > 当日存活龙头更高 > 最早发芽的周期（发酵期）
const owner = new Array(N).fill(-1);
for (let i = 0; i < N; i++) {
  const cands = cycles.map((c, ci) => ({ c, ci })).filter(({ c }) => i >= c.windowStartI && i <= c.windowEndI);
  if (!cands.length) continue;
  // 1) 死亡确认：某周期某链昨日有板今日断板（末日+3天内）
  let bestDeath = null;
  for (const { c, ci } of cands) {
    for (const ch of c.chains) {
      const prevH = i > 0 ? chainH(ch, i - 1) : 0;
      if (prevH > 0 && chainH(ch, i) === 0 && i <= c.seedEndI + 3) {
        if (!bestDeath || prevH > bestDeath.prevH) bestDeath = { ci, prevH };
      }
    }
  }
  if (bestDeath) { owner[i] = bestDeath.ci; continue; }
  // 2) 当日有存活的周期链条 → 谁的高度高归谁
  let bestAlive = null;
  for (const { c, ci } of cands) {
    for (const ch of c.chains) {
      const h = chainH(ch, i);
      if (h > 0 && (!bestAlive || h > bestAlive.h)) bestAlive = { ci, h };
    }
  }
  if (bestAlive) { owner[i] = bestAlive.ci; continue; }
  // 3) 无链存活 → 归属最早发芽的覆盖周期（朦胧/发酵期）
  cands.sort((a, b) => a.c.seedStartI - b.c.seedStartI);
  owner[i] = cands[0].ci;
}

/* ---------------- 4. 主线家族（按归属日板块家数总和重定） ---------------- */

const famCountAt = (i, fam) => days[i].themes.filter((t) => t.family === fam).reduce((s, t) => s + t.count, 0);
const famStocksAt = (i, fam) => days[i].themes.filter((t) => t.family === fam).flatMap((t) => t.stocks);

for (const c of cycles) {
  const owned = [];
  for (let i = 0; i < N; i++) if (owner[i] === cycles.indexOf(c)) owned.push(i);
  c.ownedI = owned;
  const sum = {};
  for (const i of owned) for (const t of days[i].themes) if (t.family) sum[t.family] = (sum[t.family] || 0) + t.count;
  const ranked = Object.entries(sum).sort((a, b) => b[1] - a[1]);
  c.mainFamily = ranked.length ? ranked[0][0] : c.family;
  c.mainThemes = ranked.slice(0, 4); // [fam, 总家数]
}

/* ---------------- 5. 逐日阶段判定 ---------------- */

const cycleOf = (ci) => cycles[ci];

function pulseThemes(i) {
  // 近3日出现涨停>=5家的不同质板块数（朦胧期信号）
  const set = new Set();
  for (let k = Math.max(0, i - 2); k <= i; k++) {
    for (const t of days[k].themes) if (!t.family || t.count >= 5) { if (t.family && t.count >= 5) set.add(t.family); }
  }
  return set.size;
}

function topFamilyMoves(i) {
  // 全市场家族家数日环比：找"发酵/掉队"板块
  if (i === 0) return { up: null, down: null };
  const fams = new Set();
  for (const d of [days[i], days[i - 1]]) for (const t of d.themes) if (t.family) fams.add(t.family);
  const moves = [];
  for (const f of fams) moves.push({ f, delta: famCountAt(i, f) - famCountAt(i - 1, f), now: famCountAt(i, f) });
  moves.sort((a, b) => b.delta - a.delta);
  const up = moves.find((m) => m.delta >= 4 && m.now >= 5) || null;
  const down = [...moves].reverse().find((m) => m.delta <= -4 && m.now < 8 && m.now >= 0 && famCountAt(i - 1, m.f) >= 5) || null;
  return { up, down };
}

function classify() {
  for (const c of cycles) {
    c.dayInfo = [];
    let prevStage = null;
    for (const i of c.ownedI) {
      const d = days[i];
      const Lh = Math.max(0, ...c.chains.map((ch) => chainH(ch, i)));
      const prevLh = i > 0 ? Math.max(0, ...c.chains.map((ch) => chainH(ch, i - 1))) : 0;
      const LhNext2 = Math.max(0, ...c.chains.map((ch) => Math.max(chainH(ch, i + 1), chainH(ch, i + 2))));
      const tc = famCountAt(i, c.mainFamily);
      const prevTc = i > 0 ? famCountAt(i - 1, c.mainFamily) : 0;
      const oc = d.totalZt - tc;
      const prevOc = i > 0 ? days[i - 1].totalZt - prevTc : 0;
      const mstocks = famStocksAt(i, c.mainFamily);
      const tfb = mstocks.filter((s) => (s.lianbanCount || 1) === 1).length;
      const tlb = mstocks.filter((s) => (s.lianbanCount || 1) >= 2).length;
      const share = d.totalZt ? tc / d.totalZt : 0;
      const peakTcAll = Math.max(...c.ownedI.map((k) => famCountAt(k, c.mainFamily)));
      const leaderStockToday = c.chains.flatMap((ch) => ch.days.filter((x) => x.i === i).map((x) => ({ name: ch.name, h: x.h, seal: x.sealTime })));
      const sealLate = leaderStockToday.some((s) => s.seal && s.seal >= '14:00');
      const leadNames = leaderStockToday.map((s) => `${s.name}${s.h}板`).join('、');
      const moves = topFamilyMoves(i);
      const pulseN = pulseThemes(i);

      let stage, why;
      const peakLh = Math.max(...c.chains.map((ch) => ch.peakH));

      if (Lh === 0 && prevLh > 0) {
        if (LhNext2 > 0) { stage = STAGE.DIV; why = `龙头断板（昨日${prevLh}板），但2日内回流，属高位放量分歧而非终结`; }
        else if (tc >= 0.4 * peakTcAll && tc >= 4) { stage = STAGE.DIV; why = `龙头断板（昨日${prevLh}板），主线尚有${tc}家涨停（为峰值${peakTcAll}家的${Math.round(tc / peakTcAll * 100)}%），板块内部补涨式分歧`; }
        else { stage = STAGE.END; why = `龙头断板且2日内不回流，主线缩量至${tc}家（峰值${peakTcAll}家的${Math.round(tc / peakTcAll * 100)}%），周期终结`; }
      } else if (Lh > 0 && Lh >= 5 && (tc <= 3 || (tfb === 0 && tlb <= 2))) {
        stage = STAGE.FOMO; why = `主线仅剩${tc}家（首板${tfb}家），龙头${leadNames}独自新高，小弟全部掉队 → 纯博弈环节，不参与`;
      } else if (Lh > 0 && Lh >= 8 && tc <= 4) {
        stage = STAGE.FOMO; why = `龙头${leadNames}高度${Lh}板，主线仅${tc}家跟随，只剩龙头的独角戏`;
      } else if (Lh > 0 && sealLate && Lh >= 3) {
        stage = STAGE.DIV; why = `龙头${leadNames}尾盘${'14:00'}后才封板（烂板/放量分歧），高位盘整信号`;
      } else if (Lh > 0 && Lh > prevLh && (prevLh === 0 || (prevStage && prevStage.key === 'div')) && tc >= 4 && tc >= prevTc * 0.6) {
        stage = STAGE.ACC; why = `龙头${leadNames}分歧转一致续创新高（昨日高度${prevLh}板），主线${tc}家（前日${prevTc}家）资金回流`;
      } else if (Lh >= 2 && share >= 0.3 && tfb >= 1 && (tc >= prevTc || oc <= prevOc)) {
        stage = STAGE.FOCUS; why = `主线涨停${tc}家、占比${Math.round(share * 100)}%（其他板块${oc}家${oc <= prevOc ? '萎缩' : '持平'}），龙头${leadNames}续板，板块内首板${tfb}家梯队完整`;
      } else if (pulseN >= 2 && (Lh <= 2 || share < 0.25)) {
        stage = STAGE.HAZY; why = `近3日${pulseN}个板块涨停>=5家、高度分散（当日Top：${d.themes.slice().sort((a, b) => b.count - a.count).slice(0, 3).map((t) => `${normTheme(t.board)}${t.count}家`).join('、')}），最高标仅${Math.max(Lh, ...d.themes.map((t) => t.maxH))}板，主线未明朗 → 轻仓试错`;
      } else {
        stage = Lh >= 2 ? STAGE.FOCUS : STAGE.HAZY;
        why = Lh >= 2
          ? `龙头${leadNames}在位，主线${tc}家（占比${Math.round(share * 100)}%），延续聚焦状态`
          : `主线${tc}家（占比${Math.round(share * 100)}%），板块${pulseN}个活跃，混沌轮动`;
      }
      if (stage === STAGE.FOCUS || stage === STAGE.HAZY) {
        const parts = [];
        if (moves.up) parts.push(`${moves.up.f}发酵(+${moves.up.delta}家)`);
        if (moves.down) parts.push(`${moves.down.f}掉队(${moves.down.delta}家)`);
        if (parts.length) why += `；${parts.join('，')}`;
      }
      c.dayInfo.push({ i, date: d.date, stage, why, Lh, prevLh, tc, oc, tfb, tlb, share, leadNames, totalZt: d.totalZt, temp: d.temp });
      prevStage = stage;
    }
    // 周期收尾：末尾若不是 END，补充说明
    const last = c.dayInfo[c.dayInfo.length - 1];
    c.endNote = last && last.stage.key === 'end' ? '周期以龙头断板收尾' : '周期以龙头高度衰竭自然过渡';
  }
}
classify();

// 清理未被分配到任何交易日的空周期（窗口被其他周期完全覆盖），避免后续渲染越界
for (let i = cycles.length - 1; i >= 0; i--) {
  if (!cycles[i].dayInfo || !cycles[i].dayInfo.length) cycles.splice(i, 1);
}

/* ---------------- 6. 控制台摘要（校准用） ---------------- */

const S = (st) => st.name.padEnd(4, '　');
console.log('================ 情绪周期五阶段回溯 ================');
console.log(`区间 ${fmtDay(days[0].date)} ~ ${fmtDay(days[N - 1].date)}，共${N}个交易日，识别出 ${cycles.length} 个大周期\n`);
for (let ci = 0; ci < cycles.length; ci++) {
  const c = cycles[ci];
  console.log(`—— 周期${ci + 1} [${fmtShort(days[c.dayInfo[0].i].date)}~${fmtShort(days[c.dayInfo[c.dayInfo.length - 1].i].date)}] 主线=${c.mainFamily} (Top: ${c.mainThemes.map(([f, n]) => `${f}:${n}`).join(' ')})`);
  console.log(`   龙头: ${c.chains.map((ch) => `${ch.name}(峰值${ch.peakH}板, ${fmtShort(days[ch.startI].date)}~${fmtShort(days[ch.endI].date)}${ch.sparse ? ',断续口径' : ''})`).join(' + ')}`);
  for (const di of c.dayInfo) {
    console.log(`   ${fmtShort(di.date)} ${S(di.stage)} 高标=${String(di.Lh).padStart(2)} 主线=${String(di.tc).padStart(3)}(${Math.round(di.share * 100)}%) 涨停=${String(di.totalZt).padStart(3)} | ${di.why}`);
  }
  console.log('');
}
// 未归属日（周期外混沌/轮动）
const free = [];
for (let i = 0; i < N; i++) if (owner[i] < 0) free.push(i);
if (free.length) {
  console.log('—— 周期外（混沌/轮动）——');
  for (const i of free) {
    const tops = days[i].themes.slice().sort((a, b) => b.count - a.count).slice(0, 2).map((t) => `${normTheme(t.board)}${t.count}家`).join('、');
    console.log(`   ${fmtShort(days[i].date)} 涨停=${String(days[i].totalZt).padStart(3)} | ${tops}${days[i].totalZt === 0 ? '（无涨停）' : ''}`);
  }
}

/* ---------------- 7. 生成可视化 HTML ---------------- */

const stageBadge = (st) => `<span class="badge" style="background:${st.bg};color:${st.color};border-color:${st.color}">${st.name}</span>`;

function timelineSvg() {
  const CW = 26, H = 300, padL = 56, padR = 16;
  const W = padL + N * CW + padR;
  const rows = { stage: { y: 18, h: 22 }, zt: { y: 48, h: 110 }, h: { y: 168, h: 62 }, temp: { y: 240, h: 48 } };
  const maxZt = Math.max(...days.map((d) => d.totalZt));
  const maxH = Math.max(...chains.map((c) => c.peakH));
  // 每日阶段色（含周期外）
  const stageAt = new Array(N).fill(null);
  for (const c of cycles) for (const di of c.dayInfo) stageAt[di.i] = di.stage;

  let g = '';
  // 周期背景带 + 名称
  cycles.forEach((c, ci) => {
    const a = c.ownedI[0], b = c.ownedI[c.ownedI.length - 1];
    const x = padL + a * CW, w = (b - a + 1) * CW;
    g += `<rect x="${x}" y="0" width="${w}" height="${H - 14}" fill="rgba(24,144,255,${ci % 2 ? 0.03 : 0.06})" rx="4"/>`;
    const label = `${fmtShort(days[a].date)}~${fmtShort(days[b].date)} ${c.mainFamily}`;
    g += `<text x="${x + w / 2}" y="${H - 3}" font-size="10" fill="#1890ff" text-anchor="middle">${escapeHtml(label)}</text>`;
  });
  // 阶段色带
  for (let i = 0; i < N; i++) {
    const st = stageAt[i];
    const x = padL + i * CW;
    g += `<rect x="${x + 2}" y="${rows.stage.y}" width="${CW - 4}" height="${rows.stage.h}" fill="${st ? st.bg : '#fff'}" stroke="${st ? st.color : '#e8e8e8'}" stroke-width="1" rx="3"><title>${fmtDay(days[i].date)} ${st ? st.name : '周期外/轮动'}</title></rect>`;
    if (st) g += `<text x="${x + CW / 2}" y="${rows.stage.y + 15}" font-size="10" fill="${st.color}" text-anchor="middle">${st.name.slice(0, 2)}</text>`;
    // 涨停家数柱
    const h = Math.round(days[i].totalZt / maxZt * rows.zt.h);
    g += `<rect x="${x + 5}" y="${rows.zt.y + rows.zt.h - h}" width="${CW - 10}" height="${h}" fill="#ffa39e" rx="2"><title>${fmtDay(days[i].date)} 涨停${days[i].totalZt}家</title></rect>`;
    // 龙头高度折线数据点
    const di = cycles.flatMap((c) => c.dayInfo).find((x) => x.i === i);
    if (di && di.Lh > 0) {
      const y = rows.h.y + rows.h.h - Math.round(di.Lh / maxH * rows.h.h);
      g += `<circle cx="${x + CW / 2}" cy="${y}" r="3" fill="#722ed1"><title>${fmtDay(days[i].date)} 空间高度${di.Lh}板 ${di.leadNames}</title></circle>`;
    }
    // 情绪温度
    if (days[i].temp != null) {
      const y = rows.temp.y + rows.temp.h - Math.round(days[i].temp / 100 * rows.temp.h);
      g += `<circle cx="${x + CW / 2}" cy="${y}" r="2.5" fill="#fa8c16"><title>${fmtDay(days[i].date)} 情绪温度${days[i].temp}</title></circle>`;
    }
    // 日期刻度
    if (i % 5 === 0 || i === N - 1) g += `<text x="${x + CW / 2}" y="${H - 30}" font-size="9" fill="#8c8c8c" text-anchor="middle" transform="rotate(0)">${fmtShort(days[i].date)}</text>`;
  }
  // 高度连线
  let path = '';
  for (let i = 0; i < N; i++) {
    const di = cycles.flatMap((c) => c.dayInfo).find((x) => x.i === i);
    if (!di || di.Lh === 0) continue;
    const x = padL + i * CW + CW / 2;
    const y = rows.h.y + rows.h.h - Math.round(di.Lh / maxH * rows.h.h);
    path += (path ? ' L' : 'M') + x + ' ' + y;
  }
  if (path) g += `<path d="${path}" fill="none" stroke="#722ed1" stroke-width="1.5" opacity="0.6"/>`;
  // 行标签
  g += `<text x="6" y="${rows.stage.y + 15}" font-size="11" fill="#595959">阶段</text>`;
  g += `<text x="6" y="${rows.zt.y + 12}" font-size="11" fill="#595959">涨停家数</text>`;
  g += `<text x="6" y="${rows.h.y + 12}" font-size="11" fill="#595959">空间高度</text>`;
  g += `<text x="6" y="${rows.temp.y + 12}" font-size="11" fill="#595959">情绪温度</text>`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="min-width:${W}px">${g}</svg>`;
}

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function cycleCard(c, idx) {
  const a = days[c.dayInfo[0].i], b = days[c.dayInfo[c.dayInfo.length - 1].i];
  const leaders = c.chains.map((ch) => {
    const peakDay = days[ch.peakI];
    return `<b>${escapeHtml(ch.name)}</b>（峰值 ${ch.peakH} 板，${fmtShort(days[ch.startI].date)}~${fmtShort(days[ch.endI].date)}，板块：${escapeHtml(normTheme(peakDay.themes.find((t) => t.stocks.some((s) => s.name === ch.name))?.board || ch.days[ch.days.length - 1].board || ''))}${ch.sparse ? '，<span class="muted">断续/N天M板口径</span>' : ''}）`;
  }).join('、');
  const rows = c.dayInfo.map((di) => `
    <tr>
      <td class="nowrap">${fmtDay(di.date)}</td>
      <td>${stageBadge(di.stage)}</td>
      <td class="num">${di.Lh || '-'}</td>
      <td class="num">${di.tc}（${Math.round(di.share * 100)}%）</td>
      <td class="num">${di.oc}</td>
      <td class="num">${di.totalZt}</td>
      <td>${escapeHtml(di.why)}</td>
    </tr>`).join('');
  return `
  <div class="cycle-card" id="cycle-${idx + 1}">
    <div class="cycle-head">
      <span class="cycle-no">周期 ${idx + 1}</span>
      <span class="cycle-range">${fmtDay(a.date)} ~ ${fmtDay(b.date)}（${c.dayInfo.length}个交易日）</span>
    </div>
    <div class="cycle-meta">
      <div><span class="k">主线板块</span><b>${escapeHtml(c.mainFamily)}</b><span class="muted">（区间家数：${c.mainThemes.map(([f, n]) => `${escapeHtml(f)} ${n} 家`).join('，')}）</span></div>
      <div><span class="k">龙头</span>${leaders}</div>
      <div><span class="k">收尾</span>${escapeHtml(c.endNote)}</div>
    </div>
    <table class="day-table">
      <thead><tr><th>日期</th><th>阶段</th><th>龙头高度</th><th>主线家数(占比)</th><th>其他板块</th><th>总涨停</th><th>判定依据</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function freeTable() {
  const freeI = [];
  for (let i = 0; i < N; i++) if (owner[i] < 0) freeI.push(i);
  if (!freeI.length) return '';
  const rows = freeI.map((i) => {
    const tops = days[i].themes.slice().sort((a, b) => b.count - a.count).slice(0, 3).map((t) => `${escapeHtml(normTheme(t.board))}${t.count}家`).join('、');
    const pulse = days[i].themes.filter((t) => t.family && t.count >= 15).map((t) => `${escapeHtml(normTheme(t.board))}单日${t.count}家，疑似量化一日游`).join('；');
    return `<tr><td class="nowrap">${fmtDay(days[i].date)}</td><td class="num">${days[i].totalZt}</td><td>${tops}</td><td class="muted">${pulse || '混沌轮动，无聚焦信号'}</td></tr>`;
  }).join('');
  return `
  <div class="cycle-card">
    <div class="cycle-head"><span class="cycle-no" style="background:#f0f0f0;color:#595959">周期外</span><span class="cycle-range">混沌 / 轮动交易日（${freeI.length}天）</span></div>
    <table class="day-table">
      <thead><tr><th>日期</th><th>总涨停</th><th>当日Top板块</th><th>备注</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>情绪周期五阶段回溯 ${fmtDay(days[0].date)} ~ ${fmtDay(days[N - 1].date)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#f5f5f5; font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; padding:24px; color:#262626; }
  .wrap { max-width:1280px; margin:0 auto; }
  h1 { font-size:22px; margin-bottom:4px; }
  .sub { font-size:13px; color:#8c8c8c; margin-bottom:20px; }
  .card { background:#fff; border-radius:8px; padding:20px; box-shadow:0 1px 2px rgba(0,0,0,.06); margin-bottom:16px; }
  .card h2 { font-size:16px; margin-bottom:14px; display:flex; align-items:center; gap:6px; }
  .card h2::before { content:''; width:3px; height:14px; background:#1890ff; border-radius:2px; }
  .scroll { overflow-x:auto; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; margin-bottom:10px; }
  .legend .item { display:flex; align-items:center; gap:5px; }
  .legend .sw { width:14px; height:14px; border-radius:3px; border:1px solid rgba(0,0,0,.1); }
  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; border:1px solid; white-space:nowrap; }
  .rule-table, .day-table { width:100%; border-collapse:collapse; font-size:13px; }
  .rule-table th, .rule-table td, .day-table th, .day-table td { border-bottom:1px solid #f0f0f0; padding:7px 10px; text-align:left; vertical-align:top; }
  .rule-table th, .day-table th { color:#8c8c8c; font-weight:500; background:#fafafa; }
  .day-table td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .nowrap { white-space:nowrap; }
  .cycle-card { background:#fff; border-radius:8px; padding:20px; box-shadow:0 1px 2px rgba(0,0,0,.06); margin-bottom:16px; }
  .cycle-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .cycle-no { background:#1890ff; color:#fff; font-size:13px; padding:2px 10px; border-radius:4px; }
  .cycle-range { font-size:14px; font-weight:600; }
  .cycle-meta { display:flex; flex-direction:column; gap:6px; background:#fafafa; border-radius:6px; padding:10px 14px; margin-bottom:14px; font-size:13px; }
  .cycle-meta .k { display:inline-block; width:64px; color:#8c8c8c; }
  .muted { color:#8c8c8c; font-size:12px; }
  .toc { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
  .toc a { font-size:12px; color:#1890ff; text-decoration:none; background:#fff; padding:4px 10px; border-radius:14px; box-shadow:0 1px 2px rgba(0,0,0,.06); }
</style>
</head>
<body>
<div class="wrap">
  <h1>情绪周期五阶段回溯（朦胧 → 聚焦 → 分歧 → 加速 → 搏傻）</h1>
  <div class="sub">数据源：lianbanSnapshot 每日涨停快照 · 区间 ${fmtDay(days[0].date)} ~ ${fmtDay(days[N - 1].date)}（${N} 个交易日）· 共识别 ${cycles.length} 个大周期 · 由 情绪周期分析.js 自动生成</div>
  <div class="toc">${cycles.map((c, i) => `<a href="#cycle-${i + 1}">周期${i + 1}·${escapeHtml(c.mainFamily)}</a>`).join('')}</div>

  <div class="card">
    <h2>总览时间轴（悬停看每日明细）</h2>
    <div class="legend">
      ${Object.values(STAGE).map((s) => `<span class="item"><span class="sw" style="background:${s.bg};border-color:${s.color}"></span>${s.name}</span>`).join('')}
      <span class="item"><span class="sw" style="background:#fff;border-color:#e8e8e8"></span>周期外/轮动</span>
    </div>
    <div class="scroll">${timelineSvg()}</div>
  </div>

  <div class="card">
    <h2>五阶段判定标准（定性描述 → 量化信号）</h2>
    <table class="rule-table">
      <thead><tr><th>阶段</th><th>提示词定义</th><th>本脚本量化信号</th><th>操作提示</th></tr></thead>
      <tbody>
        <tr><td>${stageBadge(STAGE.HAZY)}</td><td>主线不明朗，近3日多板块涨停>=5家；单日某板块暴量也可能是量化一日游</td><td>近3日 >=2 个板块涨停>=5家，且主线占比<25% 或空间高度<=2板</td><td>轻仓多板块试错（板块尚在低位）</td></tr>
        <tr><td>${stageBadge(STAGE.FOCUS)}</td><td>其他板块萎缩、最高标断板，资金聚焦：龙头打高度、梯队完整、低位首板不断</td><td>主线占比>=30%、龙头>=2板续板、主线内首板>=1家、其他板块家数萎缩</td><td>向主线靠拢；龙头买不到（一字）时可买小弟</td></tr>
        <tr><td>${stageBadge(STAGE.DIV)}</td><td>龙头放量分歧，高位盘整</td><td>龙头断板但主线未死透（家数>=峰值40% 或 2日内回流）；或龙头尾盘14:00后才回封</td><td>先卖出，回流与否无人能提前断定</td></tr>
        <tr><td>${stageBadge(STAGE.ACC)}</td><td>龙头重新涨停、分歧转一致，带动资金回流，小弟跟随</td><td>龙头在分歧/断板后续板新高，且主线家数回升（>=前日60%）</td><td>买龙头，绝不买小弟（小弟随时掉队，只有龙头有溢价）</td></tr>
        <tr><td>${stageBadge(STAGE.FOMO)}</td><td>小弟掉队，只剩龙头无脑加速，最终死于退潮或监管</td><td>龙头>=5板独自新高且主线<=3家（或首板断档、只剩龙头与<=1家跟随）</td><td>不参与；每多一个涨停减一次仓，防尾盘瀑布/次日竞价跌停</td></tr>
        <tr><td>${stageBadge(STAGE.END)}</td><td>——（辅助标签）</td><td>龙头断板且2日内不回流，主线缩量至峰值40%以下：周期终结，等待下一轮朦胧</td><td>空仓等待下一周期发酵</td></tr>
      </tbody>
    </table>
  </div>

  ${cycles.map((c, i) => cycleCard(c, i)).join('\n')}
  ${freeTable()}
</div>
</body>
</html>`;

const OUT = path.join(__dirname, `情绪周期分析_${days[0].date.slice(4, 6)}${days[0].date.slice(6, 8)}-${days[N - 1].date.slice(4, 6)}${days[N - 1].date.slice(6, 8)}.html`);
fs.writeFileSync(OUT, html);
console.log(`\nHTML 已生成: ${OUT}`);
