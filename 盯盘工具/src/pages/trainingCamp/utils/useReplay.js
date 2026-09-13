import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

const useReplay = (timeBuckets, options = {}) => {
  const { intervalMs = 5000 } = options;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const timerRef = useRef(null);
  const bucketsRef = useRef(timeBuckets);
  bucketsRef.current = timeBuckets;

  useEffect(() => {
    setCurrentIndex(0);
    setIsPlaying(false);
  }, [timeBuckets]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const play = useCallback(() => {
    const len = bucketsRef.current?.length || 0;
    if (len === 0) return;
    setCurrentIndex(idx => {
      if (idx >= len - 1) return 0;
      return idx;
    });
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => setIsPlaying(false), []);

  const toggle = useCallback(() => {
    setIsPlaying(p => {
      const len = bucketsRef.current?.length || 0;
      if (!p && len === 0) return false;
      return !p;
    });
  }, []);

  const seek = useCallback((idx) => {
    const len = bucketsRef.current?.length || 0;
    if (idx < 0 || idx >= len) return;
    setCurrentIndex(idx);
  }, []);

  const stepForward = useCallback(() => {
    const len = bucketsRef.current?.length || 1;
    setCurrentIndex(i => Math.min(i + 1, len - 1));
  }, []);

  const stepBackward = useCallback(() => {
    setCurrentIndex(i => Math.max(i - 1, 0));
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      clearTimer();
      return;
    }
    const len = bucketsRef.current?.length || 0;
    if (len === 0 || currentIndex >= len - 1) {
      setIsPlaying(false);
      return;
    }
    timerRef.current = setInterval(() => {
      setCurrentIndex(i => {
        const max = (bucketsRef.current?.length || 1) - 1;
        if (i >= max) {
          return max;
        }
        return i + 1;
      });
    }, intervalMs);
    return clearTimer;
  }, [isPlaying, currentIndex, intervalMs, clearTimer]);

  useEffect(() => {
    if (isPlaying) {
      const len = bucketsRef.current?.length || 0;
      if (currentIndex >= len - 1 && len > 0) {
        setIsPlaying(false);
      }
    }
  }, [currentIndex, isPlaying]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const currentBucket = useMemo(() => {
    if (!timeBuckets || timeBuckets.length === 0) return null;
    return timeBuckets[Math.min(currentIndex, timeBuckets.length - 1)];
  }, [timeBuckets, currentIndex]);

  const progress = timeBuckets?.length ? (currentIndex + 1) / timeBuckets.length : 0;

  return {
    currentIndex,
    currentBucket,
    isPlaying,
    progress,
    play,
    pause,
    toggle,
    seek,
    stepForward,
    stepBackward,
  };
};

export default useReplay;
