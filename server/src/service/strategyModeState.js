// 全局策略模式状态（后端集中管控买点诊断所需）
//   tech_attack           = 科技进攻（默认）
//   hot_money_extreme_win = 情绪游资-极致胜率
//   attack_defense        = 攻防兼备（双策略同时诊断：科技进攻 + 情绪游资-极致胜率）
//   wash_fusion_extreme_odds = 情绪游资-极致赔率（首板起爆 + 二板起爆融合，3s 买点 / 1min 卖点）
// 前端在切换模式时通过 POST /set_strategy_mode 同步给后端；持久化到 strategy_mode.json，
// 使后端即使浏览器未打开也能按当前模式诊断并发飞书。
// 多选模式（2026-11-04 新增）：前端通过 POST /set_strategy_modes 缓存勾选的模式列表（modes），
//   后端买点诊断调度按 modes 内全部模式并行执行；setMode 切回单模式时清空多选列表。
//   卖点诊断不受多选影响：仍按每笔持仓自身所属策略（sellStrategy / 模式回退）独立诊断。
const fs = require('fs');
const path = require('path');
const { MODE_EXTREME_WIN, MODE_ATTACK_DEFENSE } = require('./hotMoneyExtremeWin');

const MODE_TECH_ATTACK = 'tech_attack';
const MODE_WASH_FUSION = 'wash_fusion_extreme_odds';
const statePath = path.resolve(__dirname, '../data/strategy_mode.json');

const MODE_MULTI = 'multi_mode'; // 前端「多选模式」下拉显示标记（非真实模式，仅本地展示用）

const normalize = (value) => {
  if (value === MODE_EXTREME_WIN) return MODE_EXTREME_WIN;
  if (value === MODE_ATTACK_DEFENSE) return MODE_ATTACK_DEFENSE;
  if (value === MODE_WASH_FUSION) return MODE_WASH_FUSION;
  return MODE_TECH_ATTACK;
};

// 多选列表规范化：仅保留四个合法模式并去重（保持传入顺序）
const normalizeList = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((m) => {
    const next = normalize(m);
    if (!seen.has(next)) {
      seen.add(next);
      out.push(next);
    }
  });
  return out;
};

const readPersisted = () => {
  try {
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    }
  } catch (e) {
    console.error('读取策略模式状态失败:', e.message);
  }
  return {};
};

const persist = (mode, modes) => {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ mode, modes }, null, 2));
  } catch (e) {
    console.error('写入策略模式状态失败:', e.message);
  }
};

const initial = readPersisted();
let current = normalize(initial.mode);
let modes = normalizeList(initial.modes); // 多选模式列表（非空时按列表内全部模式并行诊断）

const getMode = () => current;
const getModes = () => (modes.length > 0 ? [...modes] : [current]);
const isMultiMode = () => modes.length > 0;

// 指定模式是否处于生效集合中：多选开启时看列表，否则与单模式比较
const isModeActive = (mode) => (modes.length > 0
  ? modes.includes(normalize(mode))
  : current === normalize(mode));

const setMode = (mode) => {
  // 前端「多选模式」下拉标记：仅本地展示，不改变后端单模式与多选配置
  if (mode === MODE_MULTI) return current;
  const next = normalize(mode);
  current = next;
  modes = []; // 切回单模式时关闭多选
  persist(current, modes);
  return next;
};

const setModes = (list) => {
  modes = normalizeList(list);
  if (modes.length > 0) {
    // 多选生效时把单模式指针同步为列表第一个，保持 getMode() 有合理取值（卖点诊断等场景回退用）
    current = modes[0];
  }
  persist(current, modes);
  return [...modes];
};

module.exports = {
  MODE_TECH_ATTACK,
  MODE_WASH_FUSION,
  MODE_MULTI,
  getMode,
  getModes,
  setMode,
  setModes,
  isMultiMode,
  isModeActive,
  normalize,
  normalizeList,
};
