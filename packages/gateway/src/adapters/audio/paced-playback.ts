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
  /**
   * Frames dispatched later than the write-ahead could cover. The modem holds roughly `leadFrames` of audio, so a frame
   * this late means that buffer may have run dry: an audible gap is possible. Plain late frames are timer jitter that
   * the write-ahead absorbed.
   */
  riskFrames: number;
  /** Longest single write, and writes slower than one frame: the port pushing back, as opposed to the loop being late. */
  maxWriteMs: number;
  slowWrites: number;
  stoppedBy: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function noteWrite(result: PacedPlaybackResult, ms: number, frameMs: number): void {
  if (ms > result.maxWriteMs) result.maxWriteMs = ms;
  if (ms > frameMs) result.slowWrites++;
}

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
    riskFrames: 0,
    maxWriteMs: 0,
    slowWrites: 0,
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
    if (lateMs > leadFrames * frameMs) result.riskFrames++;
    if (lateMs > result.maxLateMs) result.maxLateMs = lateMs;

    const chunk = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));
    const writeStart = performance.now();
    await write(chunk);
    noteWrite(result, performance.now() - writeStart, frameMs);
    result.framesWritten++;
    result.bytesWritten += chunk.length;
  }
  return result;
}

export interface PacedStreamOptions extends PacedPlaybackOptions {
  /**
   * Audio to hold back before the first write, so a network that delivers a little slower than real time right
   * after the first bytes does not start the stream with an underrun. Default 150 ms.
   */
  prerollMs?: number;
  /** Called once, just before the first frame is written (the moment audio really starts going out). */
  onFirstWrite?: () => void;
}

export interface PacedStreamResult extends PacedPlaybackResult {
  /** Times the stream had to wait for the network because the buffer ran dry after playback started. */
  underruns: number;
}

/**
 * The same real-time pacing as playPcmPaced, for PCM that is still arriving. Frames go out at the sample rate from a
 * monotonic clock. If the source falls behind the clock the stream waits for it and then re-anchors the clock, so
 * the late data is not "caught up" in a burst (which would play fast); each such wait is counted as an underrun.
 */
export async function playPcmStreamPaced(
  write: (chunk: Buffer) => Promise<void>,
  chunks: AsyncIterable<Buffer>,
  options: PacedStreamOptions
): Promise<PacedStreamResult> {
  const frameMs = options.frameMs ?? 20;
  const leadFrames = options.leadFrames ?? 2;
  const frameBytes = Math.round((options.sampleRate * frameMs) / 1000) * 2;
  const prerollBytes = Math.round((options.sampleRate * (options.prerollMs ?? 150)) / 1000) * 2;

  const result: PacedStreamResult = { framesWritten: 0, bytesWritten: 0, lateFrames: 0, maxLateMs: 0, riskFrames: 0, maxWriteMs: 0, slowWrites: 0, stoppedBy: null, underruns: 0 };
  const iterator = chunks[Symbol.asyncIterator]();
  let buffer: Buffer = Buffer.alloc(0);
  let ended = false;

  /** Read until at least `bytes` are buffered or the source ends. Returns how long it had to wait. */
  const fill = async (bytes: number): Promise<number> => {
    const from = performance.now();
    while (!ended && buffer.length < bytes) {
      const next = await iterator.next();
      if (next.done) ended = true;
      else buffer = buffer.length === 0 ? next.value : Buffer.concat([buffer, next.value]);
    }
    return performance.now() - from;
  };

  try {
    await fill(Math.max(prerollBytes, frameBytes));
    let startedAt = performance.now();
    let announced = false;
    for (let index = 0; ; index++) {
      if (buffer.length < frameBytes && !ended) {
        const waited = await fill(frameBytes);
        // Whatever the wait exceeded the write-ahead by was an audible gap: count it and restart the clock from now.
        if (waited > frameMs * Math.max(1, leadFrames) && announced) {
          result.underruns++;
          startedAt = performance.now() - Math.max(0, index - leadFrames) * frameMs;
        }
      }
      if (buffer.length === 0) break; // the source ended and everything was written
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
      if (lateMs > leadFrames * frameMs) result.riskFrames++;
      if (lateMs > result.maxLateMs) result.maxLateMs = lateMs;

      const size = Math.min(frameBytes, buffer.length - (buffer.length % 2));
      if (size === 0) break; // a stray odd byte at the very end is not a sample
      const frame = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      if (!announced) {
        announced = true;
        options.onFirstWrite?.();
      }
      const writeStart = performance.now();
      await write(frame);
      noteWrite(result, performance.now() - writeStart, frameMs);
      result.framesWritten++;
      result.bytesWritten += frame.length;
    }
    return result;
  } finally {
    // Release the provider's stream when playback stops early (caller interrupted, call ended).
    await iterator.return?.().catch(() => {});
  }
}
