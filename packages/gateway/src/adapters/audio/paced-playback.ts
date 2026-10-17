import { performance } from 'node:perf_hooks';

/**
 * Real-time paced writer for 16-bit mono PCM.
 *
 * SIMCom's USB Audio Application Note (V1.03 / V2.00) only says the host and module "exchange
 * software PCM data" on the Audio port; it specifies no chunk size, pacing or buffering rule.
 * The frame length here (20 ms) and the small write-ahead are therefore engineering choices, not
 * documented requirements. What is required for any real-time stream is that the average write
 * rate equals the sample rate, which a per-chunk `setTimeout(20)` cannot guarantee: Windows timers
 * fire at ~15.6 ms granularity, so every chunk slips and the stream runs slow and underruns.
 * Chunks are therefore scheduled against absolute deadlines from a monotonic clock.
 */
export interface PacedPlaybackOptions {
  sampleRate: number;
  /** Frame length. Default 20 ms (320 bytes at 8 kHz, 16-bit mono). */
  frameMs?: number;
  /** Frames allowed to be written ahead of real time. Default 2 (40 ms). */
  leadFrames?: number;
  /** Polled before every frame; return a reason to stop immediately. */
  shouldStop?: () => string | null;
}

export interface PacedPlaybackResult {
  framesWritten: number;
  bytesWritten: number;
  /** Frames dispatched more than one frame length after their deadline. */
  lateFrames: number;
  maxLateMs: number;
  stoppedBy: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function playPcmPaced(
  write: (chunk: Buffer) => Promise<void>,
  pcm: Buffer,
  options: PacedPlaybackOptions
): Promise<PacedPlaybackResult> {
  const frameMs = options.frameMs ?? 20;
  const leadFrames = options.leadFrames ?? 2;
  const frameBytes = Math.round((options.sampleRate * frameMs) / 1000) * 2;

  const result: PacedPlaybackResult = {
    framesWritten: 0,
    bytesWritten: 0,
    lateFrames: 0,
    maxLateMs: 0,
    stoppedBy: null,
  };

  const startedAt = performance.now();
  for (let index = 0, offset = 0; offset < pcm.length; index++, offset += frameBytes) {
    const due = startedAt + Math.max(0, index - leadFrames) * frameMs;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);

    const stop = options.shouldStop?.() ?? null;
    if (stop) {
      result.stoppedBy = stop;
      break;
    }

    const lateMs = Math.max(0, performance.now() - due);
    if (lateMs > frameMs) result.lateFrames++;
    if (lateMs > result.maxLateMs) result.maxLateMs = lateMs;

    const chunk = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));
    await write(chunk);
    result.framesWritten++;
    result.bytesWritten += chunk.length;
  }
  return result;
}
