import { performance } from 'node:perf_hooks';

/**
 * Names the slowest synchronous disk operation since the last reset. A synchronous write blocks the whole event loop for as
 * long as it takes, so it can make a 20 ms audio frame late; the loop-lag figure says that the loop was stalled, and this says
 * by what. Only a handful of known places report here (the call recorder's file writes and the telemetry database), and the
 * cost of reporting is two clock reads.
 */
let maxMs = 0;
let maxLabel: string | null = null;

export function timeSyncIo<T>(label: string, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    const took = performance.now() - started;
    if (took > maxMs) {
      maxMs = took;
      maxLabel = label;
    }
  }
}

export function resetSyncIo(): void {
  maxMs = 0;
  maxLabel = null;
}

export function slowestSyncIo(): { ms: number; label: string | null } {
  return { ms: Math.round(maxMs), label: maxLabel };
}
