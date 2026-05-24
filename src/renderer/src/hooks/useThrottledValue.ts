import { useEffect, useRef, useState } from 'react';

/**
 * Leading + trailing throttle of a fast-changing value. During streaming the
 * assistant content updates on every token; rendering Markdown that often
 * causes CPU thrash and partial-syntax flicker. Batching to ~1 update per
 * `intervalMs` keeps the "line-by-line" feel without re-parsing per character.
 * The final value is always flushed via the trailing timer, so nothing is lost.
 */
export function useThrottledValue<T>(value: T, intervalMs = 50): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastEmitRef.current;
    if (elapsed >= intervalMs) {
      lastEmitRef.current = now;
      setThrottled(value);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastEmitRef.current = Date.now();
      setThrottled(value);
    }, intervalMs - elapsed);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, intervalMs]);

  return throttled;
}
