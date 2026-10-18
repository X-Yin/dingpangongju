// 全局策略模式状态（后端集中管控买点诊断所需）
//   tech_attack           = 科技进攻（默认）
//   hot_money_extreme_win = 情绪游资-极致胜率
// 前端在切换模式时通过 POST /set_strategy_mode 同步给后端；持久化到 strategy_mode.json，
// 使后端即使浏览器未打开也能按当前模式诊断并发飞书。
const fs = require('fs');
const path = require('path');
const { MODE_EXTREME_WIN } = require('./hotMoneyExtremeWin');

const MODE_TECH_ATTACK = 'tech_attack';
const statePath = path.resolve(__dirname, '../data/strategy_mode.json');

const normalize = (value) => (value === MODE_EXTREME_WIN ? MODE_EXTREME_WIN : MODE_TECH_ATTACK);

let current = (() => {
  try {
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
      return normalize(raw && raw.mode);
    }
  } catch (e) {
    console.error('读取策略模式状态失败:', e.message);
  }
  return MODE_TECH_ATTACK;
})();

const getMode = () => current;

const setMode = (mode) => {
  const next = normalize(mode);
  current = next;
  try {
    fs.writeFileSync(statePath, JSON.stringify({ mode: next }, null, 2));
  } catch (e) {
    console.error('写入策略模式状态失败:', e.message);
  }
  return next;
};

module.exports = { MODE_TECH_ATTACK, getMode, setMode, normalize };
