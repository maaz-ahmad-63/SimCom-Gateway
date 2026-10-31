import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

/**
 * Longest stall of the Node event loop since the last reset. Late audio frames are either a slow source (the network)
 * or a stalled loop (something ran synchronously for tens of milliseconds); recording both lets a turn say which.
 */
export interface LoopLag {
  reset(): void;
  /** Milliseconds, or null when the monitor could not run. */
  maxMs(): number | null;
  /** Longest garbage-collection pause since the last reset, in ms; null when it could not be observed. */
  gcMaxMs?(): number | null;
  stop(): void;
}

const RESOLUTION_MS = 5;

export function createLoopLag(): LoopLag {
  try {
    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
    let gcMax = 0;
    let gc: PerformanceObserver | null = null;
    try {
      gc = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) gcMax = Math.max(gcMax, entry.duration);
      });
      gc.observe({ entryTypes: ['gc'] });
    } catch {
      gc = null;
    }
    return {
      reset: () => {
        histogram.reset();
        gcMax = 0;
      },
      gcMaxMs: () => (gc ? Math.round(gcMax) : null),
      // The histogram's floor is its own sampling interval; only what exceeds it is a stall.
      maxMs: () => (histogram.count === 0 ? null : Math.max(0, Math.round(histogram.max / 1e6 - RESOLUTION_MS))),
      stop: () => {
        histogram.disable();
        gc?.disconnect();
      },
    };
  } catch {
    return { reset: () => {}, maxMs: () => null, stop: () => {} };
  }
}
