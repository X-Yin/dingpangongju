import { useRef, useEffect } from 'react';

export function useRunOnce(callback, condition = true) {
  const hasRun = useRef(false);

  useEffect(() => {
    if (!hasRun.current && condition) {
      hasRun.current = true;
      callback();
    }
  }, [callback, condition]);
}

export default useRunOnce;
