// 全局策略模式（开盘实战页「切换模式」）
//   tech_attack           = 科技进攻（现状，默认）
//   hot_money_extreme_win = 情绪游资-极致胜率（买卖点与回测页同名策略一致）
//   attack_defense        = 攻防兼备（双策略同时诊断：科技进攻 + 情绪游资-极致胜率，对应回测融合策略）
//   wash_fusion_extreme_odds = 情绪游资-极致赔率（首板起爆 + 二板起爆，买卖点与回测页同名策略一致）
//   multi_mode            = 多选模式（2026-11-04 新增）：下拉显示标记，勾选的模式列表缓存到后端，
//                           后端买点诊断按全部勾选模式并行执行；卖点诊断不受影响（按每笔持仓自身策略）
// 模式为全局共享 + localStorage 持久化：模块级变量 + CustomEvent 广播，不引入 Context/Provider。
import { useEffect, useState } from 'react';
import { syncStrategyMode, syncStrategyModes } from './buyPointWs';

export const MODE_TECH_ATTACK = 'tech_attack';
export const MODE_EXTREME_WIN = 'hot_money_extreme_win';
export const MODE_ATTACK_DEFENSE = 'attack_defense';
export const MODE_WASH_FUSION = 'wash_fusion_extreme_odds';
export const MODE_MULTI = 'multi_mode';

export const STRATEGY_MODE_OPTIONS = [
  { value: MODE_TECH_ATTACK, label: '科技进攻' },
  { value: MODE_EXTREME_WIN, label: '情绪游资-极致胜率' },
  // attack_defense（攻防兼备）已从下拉移除（2026-11-04 用户要求）；常量与诊断逻辑保留，兼容历史缓存值
  { value: MODE_WASH_FUSION, label: '情绪游资-极致赔率' },
  { value: MODE_MULTI, label: '多选模式' },
];

// 多选弹窗可勾选的模式（排除 multi_mode 标记自身）
export const MULTI_CHECKABLE_OPTIONS = STRATEGY_MODE_OPTIONS.filter((o) => o.value !== MODE_MULTI);

const STORAGE_KEY = 'ob_strategy_mode';
const EVENT_NAME = 'strategy-mode-change';
const MODES_STORAGE_KEY = 'ob_strategy_modes';
const MODES_EVENT_NAME = 'strategy-modes-change';

const normalize = (value) => {
  if (value === MODE_MULTI) return MODE_MULTI;
  if (value === MODE_EXTREME_WIN) return MODE_EXTREME_WIN;
  if (value === MODE_ATTACK_DEFENSE) return MODE_ATTACK_DEFENSE;
  if (value === MODE_WASH_FUSION) return MODE_WASH_FUSION;
  return MODE_TECH_ATTACK;
};

// 多选列表规范化：仅保留合法模式并去重
export const normalizeModeList = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((m) => {
    const next = normalize(m);
    if (next !== MODE_MULTI && !seen.has(next)) {
      seen.add(next);
      out.push(next);
    }
  });
  return out;
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
  // 多选标记仅前端展示用，不回传（多选列表由 setStrategyModes 单独缓存到后端）
  if (next !== MODE_MULTI) syncStrategyMode(next);
};

// ==================== 多选模式（勾选列表缓存到后端） ====================
const readStoredModes = () => {
  try {
    return normalizeModeList(JSON.parse(localStorage.getItem(MODES_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
};

let currentModes = readStoredModes();

export const getStrategyModes = () => [...currentModes];

// 仅更新本地缓存（后端拉取回填用），不回传后端、不广播
export const cacheStrategyModes = (list) => {
  currentModes = normalizeModeList(list);
  try {
    localStorage.setItem(MODES_STORAGE_KEY, JSON.stringify(currentModes));
  } catch { /* 忽略存储失败 */ }
  return [...currentModes];
};

// 保存多选模式：本地缓存 + 广播 + 缓存到后端（后端买点诊断按全部勾选模式并行执行）
export const setStrategyModes = (list) => {
  const next = cacheStrategyModes(list);
  window.dispatchEvent(new CustomEvent(MODES_EVENT_NAME, { detail: [...next] }));
  syncStrategyModes(next);
  return next;
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

// 订阅多选模式列表：任意组件调用即可随勾选变化自动重渲染
export const useStrategyModes = () => {
  const [modes, setModesState] = useState(getStrategyModes);
  useEffect(() => {
    const handler = (e) => setModesState(Array.isArray(e?.detail) ? normalizeModeList(e.detail) : getStrategyModes());
    window.addEventListener(MODES_EVENT_NAME, handler);
    return () => window.removeEventListener(MODES_EVENT_NAME, handler);
  }, []);
  return modes;
};

export const isExtremeWinMode = (mode) => normalize(mode) === MODE_EXTREME_WIN;
