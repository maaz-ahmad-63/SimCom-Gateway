import { AiAudioMeter } from '@sim-gateway/shared';
import { AudioFormat } from './audio.js';

const LEVEL_WINDOW_MS = 1000;
const GAP_WINDOW_MS = 10_000;
/** Peak below this (of full scale) counts as silence: the idle USB stream sits at about +/-2 of 32768. */
const SILENCE_PEAK = 0.005;

interface Frame {
  t: number;
  sumSq: number;
  n: number;
  peak: number;
}

/**
 * Live statistics of the caller audio the AI session is being fed: how much arrived, how recent and
 * how steady it is, and how loud. It observes the same bytes the endpointer gets; it changes nothing.
 */
export class AudioMeter {
  private receivedBytes = 0;
  private lastFrameAt: number | null = null;
  private firstFrameAt: number | null = null;
  private firstFrameBytes = 0;
  private lastLoudAt: number | null = null;
  private readonly startedAt: number;
  private frames: Frame[] = [];
  private gaps: Array<{ t: number; gap: number }> = [];

  constructor(
    private readonly format: AudioFormat,
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = this.now();
  }

  feed(pcm: Buffer): void {
    const t = this.now();
    const samples = pcm.length >> 1;
    if (samples === 0) return;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    if (this.lastFrameAt !== null) this.gaps.push({ t, gap: t - this.lastFrameAt });
    if (this.firstFrameAt === null) this.firstFrameAt = t;
    this.lastFrameAt = t;
    this.receivedBytes += pcm.length;
    if (peak >= SILENCE_PEAK) this.lastLoudAt = t;
    if (this.firstFrameBytes === 0) this.firstFrameBytes = pcm.length;
    this.frames.push({ t, sumSq, n: samples, peak });
    this.prune(t);
  }

  private prune(t: number): void {
    while (this.frames.length > 0 && t - this.frames[0].t > LEVEL_WINDOW_MS) this.frames.shift();
    while (this.gaps.length > 0 && t - this.gaps[0].t > GAP_WINDOW_MS) this.gaps.shift();
  }

  snapshot(utterances: number, submittedSeconds: number): AiAudioMeter {
    const t = this.now();
    this.prune(t);
    let sumSq = 0;
    let n = 0;
    let peak = 0;
    for (const f of this.frames) {
      sumSq += f.sumSq;
      n += f.n;
      if (f.peak > peak) peak = f.peak;
    }
    const round = (v: number) => Math.round(v * 10000) / 10000;
    // The first frame's own bytes arrived before the clock started, so measure bytes after it.
    const span = this.firstFrameAt !== null && this.lastFrameAt !== null ? this.lastFrameAt - this.firstFrameAt : 0;
    const observed =
      span >= 2000 ? Math.round(((this.receivedBytes - this.firstFrameBytes) / 2 / (span / 1000)) / 100) * 100 : null;
    // Audio that arrived in less time than it lasts is a backlog being flushed (stalled USB, then a burst).
    const audioMs = ((this.receivedBytes - this.firstFrameBytes) / 2 / this.format.sampleRate) * 1000;
    const backlogMs = span >= 2000 ? Math.max(0, Math.round(audioMs - span)) : 0;
    return {
      receivedBytes: this.receivedBytes,
      receivedSeconds: Math.round((this.receivedBytes / 2 / this.format.sampleRate) * 100) / 100,
      submittedSeconds: Math.round(submittedSeconds * 100) / 100,
      utterances,
      lastFrameAgoMs: this.lastFrameAt === null ? null : Math.round(t - this.lastFrameAt),
      maxGapMs: Math.round(this.gaps.reduce((m, g) => Math.max(m, g.gap), 0)),
      rms: n ? round(Math.sqrt(sumSq / n)) : 0,
      peak: round(peak),
      // Never heard anything above the noise floor: silent since the session started.
      backlogMs,
      observedSampleRate: observed,
      expectedSampleRate: this.format.sampleRate,
      silentForMs: this.frames.length === 0 && this.lastFrameAt === null ? null : Math.round(t - (this.lastLoudAt ?? this.startedAt)),
    };
  }
}
