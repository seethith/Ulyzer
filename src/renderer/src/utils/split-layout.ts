import type { RefObject } from 'react';
import type { AllotmentHandle } from 'allotment';

export function readLayoutBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const value = window.localStorage.getItem(key);
  if (value === '0') return false;
  if (value === '1') return true;
  return fallback;
}

export function writeLayoutBool(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, value ? '1' : '0');
}

export function readLayoutSizes(key: string, fallback: number[], expectedLength: number): number[] {
  if (typeof window === 'undefined') return fallback;
  const value = window.localStorage.getItem(key);
  if (!value) return fallback;

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== expectedLength) return fallback;
    const sizes = parsed.map((size) => Number(size));
    if (sizes.some((size) => !Number.isFinite(size) || size < 0)) return fallback;
    if (sizes.reduce((sum, size) => sum + size, 0) <= 0) return fallback;
    return sizes;
  } catch {
    return fallback;
  }
}

export function writeLayoutSizes(key: string, sizes: number[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(sizes.map((size) => Math.max(0, Math.round(size)))));
}

export function animateSplitResize(
  ref: RefObject<AllotmentHandle | null>,
  from: number[],
  to: number[],
  durationMs: number,
  onFrame?: (sizes: number[]) => void,
  onComplete?: () => void,
): () => void {
  let frameId = 0;
  let startTime = 0;
  let cancelled = false;

  const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

  const step = (timestamp: number) => {
    if (cancelled) return;
    if (startTime === 0) startTime = timestamp;

    const progress = Math.min(1, (timestamp - startTime) / durationMs);
    const eased = easeOutCubic(progress);
    const nextSizes = to.map((target, index) => {
      const source = from[index] ?? target;
      return Math.max(0, source + (target - source) * eased);
    });

    ref.current?.resize(nextSizes);
    onFrame?.(nextSizes);

    if (progress < 1) {
      frameId = window.requestAnimationFrame(step);
    } else {
      onComplete?.();
    }
  };

  frameId = window.requestAnimationFrame(step);

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frameId);
  };
}
