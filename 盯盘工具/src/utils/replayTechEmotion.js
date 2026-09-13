const listeners = new Set();
let currentValue = null;
let currentPrev = null;

export const replayTechEmotionStore = {
  set(value) {
    currentPrev = currentValue;
    currentValue = value;
    listeners.forEach(fn => fn(currentValue, currentPrev));
  },
  reset() {
    currentValue = null;
    currentPrev = null;
    listeners.forEach(fn => fn(null, null));
  },
  get() {
    return { value: currentValue, prev: currentPrev };
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
