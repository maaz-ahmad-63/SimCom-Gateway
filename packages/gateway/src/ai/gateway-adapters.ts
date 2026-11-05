import { AudioFrame, IAudioAdapter } from '@sim-gateway/shared';
import { playPcmPaced, playPcmStreamPaced } from '../adapters/audio/paced-playback.js';
import { AgentAudioSink, AudioFormat, CallerAudioSource, PlayResult } from './audio.js';

/**
 * The only two places the AI engine touches the SIM7600EI audio transport. Both go through the
 * gateway's existing IAudioAdapter (the single open COM26 handle) and add nothing to it: no extra
 * port handle, no AT commands, no change to the USB audio registration.
 *
 * `verified` is whatever the operator has established by listening/hearing (AI_AUDIO_*_VERIFIED);
 * these classes never infer it from bytes flowing.
 */
export class GatewayAudioSource implements CallerAudioSource {
  constructor(
    private readonly audio: IAudioAdapter,
    readonly format: AudioFormat,
    readonly verified: boolean,
    /** Frames are dropped unless this is true, so audio can only reach the session of the live call. */
    private readonly accept: () => boolean
  ) {}

  onAudio(listener: (pcm: Buffer) => void): () => void {
    const handler = (frame: AudioFrame) => {
      if (this.accept()) listener(Buffer.from(frame.data));
    };
    this.audio.on('audio_frame', handler);
    return () => this.audio.off('audio_frame', handler);
  }
}

/** A write to the audio port did not complete: the modem is not consuming audio (for example after a USB reset). */
export class AudioWriteTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Audio port write timed out after ${timeoutMs} ms: the modem is not consuming audio`);
    this.name = 'AudioWriteTimeoutError';
  }
}

export interface GatewayAudioSinkOptions {
  /** A single 20 ms write normally completes in milliseconds; this much silence means the port is stuck. */
  writeTimeoutMs?: number;
  /** How long the one port reopen after a stuck write may take. */
  recoverTimeoutMs?: number;
  /** Audio held back before a streamed reply starts, so a slow first second of network does not underrun. Default 150. */
  prerollMs?: number;
  /** Frames (20 ms each) written ahead of real time. More absorbs timer jitter; it also cannot be taken back on an interruption. Default 2. */
  leadFrames?: number;
}

export class GatewayAudioSink implements AgentAudioSink {
  private writing: Promise<unknown> = Promise.resolve();
  private lastRecoverAt = 0;
  private primed = false;

  constructor(
    private readonly audio: IAudioAdapter,
    readonly format: AudioFormat,
    readonly verified: boolean,
    private readonly isCallActive: () => boolean,
    private readonly options: GatewayAudioSinkOptions = {}
  ) {}

  /** Plays are serialized: two sentences never interleave on the port. */
  play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    const run = this.writing.then(() => this.playNow(pcm, signal));
    this.writing = run.catch(() => {});
    return run;
  }

  /** Streamed replies are serialized with everything else on the port, exactly like play(). */
  playStream(chunks: AsyncIterable<Buffer>, signal: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult> {
    const run = this.writing.then(() => this.playStreamNow(chunks, signal, hooks));
    this.writing = run.catch(() => {});
    return run;
  }

  private async playStreamNow(chunks: AsyncIterable<Buffer>, signal: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult> {
    if (!this.audio.getStats().isStreaming) {
      throw new Error('Audio port is not streaming; refusing to write playback');
    }
    await this.prime(signal);
    const before = this.audio.getStats().bytesSent;
    const result = await playPcmStreamPaced((chunk) => this.write(chunk, signal), chunks, {
      sampleRate: this.format.sampleRate,
      leadFrames: this.options.leadFrames,
      prerollMs: this.options.prerollMs ?? 150,
      onFirstWrite: hooks?.onFirstWrite,
      shouldStop: () => (signal.aborted ? 'aborted' : !this.isCallActive() ? 'call-ended' : null),
    });
    const bytesWritten = this.audio.getStats().bytesSent - before;
    // Whole reply written means every byte the stream produced went out and the stream ended by itself.
    const completed = result.stoppedBy === null && result.bytesWritten > 0 && bytesWritten === result.bytesWritten;
    return {
      bytesWritten,
      completed,
      stoppedBy: completed ? null : (result.stoppedBy ?? 'not-written'),
      lateFrames: result.lateFrames + result.underruns,
      riskFrames: result.riskFrames + result.underruns,
      maxLateMs: Math.round(result.maxLateMs),
      maxWriteMs: Math.round(result.maxWriteMs),
      slowWrites: result.slowWrites,
      underruns: result.underruns,
    };
  }

  /**
   * The first write to a freshly opened audio port is slow (on this hardware the first frames of a call's first reply
   * went out 130-220 ms late, every call, and later replies were clean). One frame of silence, written before the
   * pacing clock starts, takes that cost without touching the audio the caller hears. Once per call; a failure here
   * is not reported (the real write will fail the same way if the port is truly stuck).
   */
  private async prime(signal: AbortSignal): Promise<void> {
    if (this.primed) return;
    this.primed = true;
    const frame = Buffer.alloc(Math.round((this.format.sampleRate * 20) / 1000) * 2);
    try {
      await this.write(frame, signal);
    } catch {
      // ignored on purpose
    }
  }

  private async playNow(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    if (!this.audio.getStats().isStreaming) {
      throw new Error('Audio port is not streaming; refusing to write playback');
    }
    await this.prime(signal);
    const before = this.audio.getStats().bytesSent;
    const result = await playPcmPaced((chunk) => this.write(chunk, signal), pcm, {
      sampleRate: this.format.sampleRate,
      leadFrames: this.options.leadFrames,
      shouldStop: () => (signal.aborted ? 'aborted' : !this.isCallActive() ? 'call-ended' : null),
    });
    // Counted from the adapter, so a chunk it dropped silently is not reported as played.
    const bytesWritten = this.audio.getStats().bytesSent - before;
    const completed = result.stoppedBy === null && bytesWritten === pcm.length;
    return {
      bytesWritten,
      completed,
      stoppedBy: completed ? null : (result.stoppedBy ?? 'not-written'),
      lateFrames: result.lateFrames,
      riskFrames: result.riskFrames,
      maxLateMs: Math.round(result.maxLateMs),
      maxWriteMs: Math.round(result.maxWriteMs),
      slowWrites: result.slowWrites,
      underruns: 0,
    };
  }

  /**
   * One chunk to the port. A write that never completes used to block the whole turn (and every later one) until the
   * call ended: after a USB reset the reopened port can accept a write that is never consumed. Now it is cut off:
   * an abort (caller interrupted, call ended) releases it at once, and a write stuck past the timeout fails the turn
   * after one bounded reopen of the audio port, so the next sentence or turn starts from a fresh handle.
   */
  private async write(chunk: Buffer, signal: AbortSignal): Promise<void> {
    const timeoutMs = this.options.writeTimeoutMs ?? 2000;
    const writing = this.audio.writeAudioChunk(chunk);
    writing.catch(() => {}); // a late failure after we stopped waiting must not become an unhandled rejection
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const released = new Promise<'released'>((resolve) => {
      onAbort = () => resolve('released');
      if (signal.aborted) resolve('released');
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([writing.then(() => 'written' as const), timedOut, released]);
      if (outcome === 'timeout') {
        await this.reopenPort();
        throw new AudioWriteTimeoutError(timeoutMs);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** At most one reopen per 10 s, and never longer than the recover timeout. Does not touch the USB registration. */
  private async reopenPort(): Promise<void> {
    if (!this.audio.recoverSession || Date.now() - this.lastRecoverAt < 10_000) return;
    this.lastRecoverAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.audio.recoverSession().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.recoverTimeoutMs ?? 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
