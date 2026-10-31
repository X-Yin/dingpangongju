// 全局策略模式（开盘实战页「切换模式」）
//   tech_attack           = 科技进攻（现状，默认）
//   hot_money_extreme_win = 情绪游资-极致胜率（买卖点与回测页同名策略一致）
//   attack_defense        = 攻防兼备（双策略同时诊断：科技进攻 + 情绪游资-极致胜率，对应回测融合策略）
// 模式为全局共享 + localStorage 持久化：模块级变量 + CustomEvent 广播，不引入 Context/Provider。
import { useEffect, useState } from 'react';
import { syncStrategyMode } from './buyPointWs';

export const MODE_TECH_ATTACK = 'tech_attack';
export const MODE_EXTREME_WIN = 'hot_money_extreme_win';
export const MODE_ATTACK_DEFENSE = 'attack_defense';

export const STRATEGY_MODE_OPTIONS = [
  { value: MODE_TECH_ATTACK, label: '科技进攻' },
  { value: MODE_EXTREME_WIN, label: '情绪游资-极致胜率' },
  { value: MODE_ATTACK_DEFENSE, label: '攻防兼备' },
];

const STORAGE_KEY = 'ob_strategy_mode';
const EVENT_NAME = 'strategy-mode-change';

const normalize = (value) => {
  if (value === MODE_EXTREME_WIN) return MODE_EXTREME_WIN;
  if (value === MODE_ATTACK_DEFENSE) return MODE_ATTACK_DEFENSE;
  return MODE_TECH_ATTACK;
};

const readStored = () => {
  try {
    return normalize(localStorage.getItem(STORAGE_KEY));
  } catch {
    return MODE_TECH_ATTACK;
  }
};

let current = readStored();

export const getStrategyMode = () => current;

export const setStrategyMode = (mode) => {
  const next = normalize(mode);
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch { /* 忽略存储失败 */ }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }));
  // 同步到后端：后端集中诊断 / 发飞书据此模式运行（失败不阻塞本地切换）
  syncStrategyMode(next);
};

// 订阅全局模式：任意组件调用即可随模式切换自动重渲染
export const useStrategyMode = () => {
  const [mode, setMode] = useState(getStrategyMode);
  useEffect(() => {
    const handler = (e) => setMode(e?.detail ? normalize(e.detail) : getStrategyMode());
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);
  return mode;
};

export const isExtremeWinMode = (mode) => normalize(mode) === MODE_EXTREME_WIN;
