import { performance } from 'node:perf_hooks';
import { analyzePcm, speechIndicators } from '../diagnostics/pcm-tools.js';
import { assertEnginePcm, AudioFormat } from './audio.js';

/**
 * Energy-based utterance endpointing. The source project uses Silero VAD (an ONNX model) with a
 * 1.0 s (max 3.0 s) endpointing delay; porting that would add onnxruntime to the gateway for little
 * benefit on narrow-band phone audio, so this uses frame RMS with the same delay semantics.
 * It decides "something loud enough happened", not "this is speech"; assessUtterance() adds a
 * second, independent look before any provider is paid.
 *
 * Three refinements over a fixed threshold and a fixed timeout, all optional and all off the critical
 * path of correctness (with the defaults below the behaviour is the original one):
 *  - adaptive silence: the wait before an utterance ends shrinks toward this caller's own mid-sentence pause
 *    length (never above minSilenceMs), so a quick talker is answered sooner and a slow one is not cut off;
 *  - a soft end: after softSilenceMs of silence the audio so far is offered for speculative transcription, and
 *    withdrawn if the caller carries on, so speech-to-text overlaps the remaining wait instead of following it;
 *  - timestamps: when speech really ended, and when the endpointer decided so, so latency can be measured from
 *    the moment the caller stopped talking and not from the moment the turn began.
 */
export interface EndpointerOptions {
  rmsThreshold: number; // fraction of full scale, e.g. 0.012
  minSpeechMs: number;
  /** Silence that ends an utterance. With adaptive on, this is the ceiling. */
  minSilenceMs: number;
  maxUtteranceMs: number;
  preRollMs: number;
  /** Adapt the silence wait and the loudness threshold to this call (default false). */
  adaptive?: boolean;
  /** Lowest silence wait adaptation may reach (default 450 ms, never above minSilenceMs). */
  minSilenceFloorMs?: number;
  /** Offer the audio so far for speculative transcription after this much silence; 0 or unset disables it. */
  softSilenceMs?: number;
  /** Monotonic clock in milliseconds; injectable for tests. */
  now?: () => number;
}

export interface UtteranceInfo {
  reason: 'silence' | 'max-length' | 'early-commit';
  durationMs: number;
  /** When the last loud window was processed: the best available estimate of when the caller stopped talking. */
  speechEndedAt: number;
  /** When the endpointer decided the utterance was over. */
  endpointedAt: number;
  /** Silence that had been observed at that moment. */
  silenceMs: number;
  /** The silence wait in force (differs from the configured one when adaptive). */
  silenceTargetMs: number;
  /** Set when a soft end was offered for exactly this audio and not withdrawn. */
  softId?: number;
}

export interface EndpointerEvents {
  /** Speech has lasted at least minSpeechMs. Fires once per utterance (used for barge-in). */
  onSpeechStart?: () => void;
  /** Silence reached softSilenceMs: the audio so far, for speculative transcription. May be withdrawn. */
  onSoftEnd?: (pcm: Buffer, info: { id: number; speechEndedAt: number; durationMs: number }) => void;
  /** The caller carried on after a soft end: the speculative transcript no longer describes a finished turn. */
  onSoftCancel?: (id: number) => void;
  /** The caller stopped for the silence wait, or maxUtteranceMs was reached. */
  onUtterance: (pcm: Buffer, info: UtteranceInfo) => void;
}

const WINDOW_MS = 20;
/** Shorter silences are breaths and stop consonants, not pauses worth learning from. */
const MIN_GAP_MS = 120;
const GAP_HISTORY = 12;
const GAPS_NEEDED = 3;

export class EnergyEndpointer {
  private readonly windowBytes: number;
  private readonly now: () => number;
  private carry = Buffer.alloc(0);
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;
  private utterance: Buffer[] = [];
  private utteranceBytes = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private inSpeech = false;
  private startedEmitted = false;
  private lastLoudAt = 0;
  private softId = 0;
  private activeSoft: number | null = null;
  /** Mid-utterance pauses of this call (silences that ended because the caller carried on). */
  private gaps: number[] = [];
  private noiseFloor = 0;

  constructor(
    private readonly format: AudioFormat,
    private readonly options: EndpointerOptions,
    private readonly events: EndpointerEvents
  ) {
    assertEnginePcm(format);
    this.windowBytes = Math.round((format.sampleRate * WINDOW_MS) / 1000) * 2;
    this.now = options.now ?? (() => performance.now());
  }

  /** The silence wait currently in force. */
  get silenceTargetMs(): number {
    const base = this.options.minSilenceMs;
    if (!this.options.adaptive || this.gaps.length < GAPS_NEEDED) return base;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    const floor = Math.min(base, this.options.minSilenceFloorMs ?? 450);
    return Math.round(Math.min(base, Math.max(floor, p90 * 1.3 + 100)));
  }

  /** The loudness threshold currently in force (raised above the configured one on a noisy line when adaptive). */
  get thresholdNow(): number {
    return this.options.adaptive ? Math.max(this.options.rmsThreshold, this.noiseFloor * 3) : this.options.rmsThreshold;
  }

  /** The soft end that has been offered and not withdrawn, if any. */
  get pendingSoftId(): number | null {
    return this.activeSoft;
  }

  feed(pcm: Buffer): void {
    let data = this.carry.length > 0 ? Buffer.concat([this.carry, pcm]) : pcm;
    let offset = 0;
    while (data.length - offset >= this.windowBytes) {
      this.processWindow(data.subarray(offset, offset + this.windowBytes));
      offset += this.windowBytes;
    }
    this.carry = Buffer.from(data.subarray(offset));
  }

  /** Emit whatever has been collected (for example when the call ends). Returns true if an utterance was emitted. */
  flush(): boolean {
    if (this.inSpeech && this.speechMs >= this.options.minSpeechMs) {
      this.emit('silence');
      return true;
    }
    this.reset();
    return false;
  }

  /**
   * End the utterance now, ahead of the silence wait (the speculative transcript looked like a finished sentence).
   * Only valid while a soft end is pending, so exactly the audio that was transcribed is what is committed.
   */
  commitEarly(): boolean {
    if (!this.inSpeech || this.activeSoft === null) return false;
    this.emit('early-commit');
    return true;
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
    this.preRoll = [];
    this.preRollBytes = 0;
    this.utterance = [];
    this.utteranceBytes = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;
    this.startedEmitted = false;
    this.activeSoft = null;
  }

  private rms(window: Buffer): number {
    let sum = 0;
    const n = window.length >> 1;
    for (let i = 0; i < n; i++) {
      const v = window.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  private processWindow(window: Buffer): void {
    const level = this.rms(window);
    const loud = level >= this.thresholdNow;
    const copy = Buffer.from(window);

    if (!this.inSpeech) {
      if (!loud) {
        // The quiet between utterances is the line's noise floor; a slow average of it raises the threshold on a hissy
        // line and never lowers it below the configured one.
        // Capped, so soft speech onsets that fall under the threshold cannot push it up without limit.
        const sample = Math.min(level, this.options.rmsThreshold * 1.2);
        this.noiseFloor = this.noiseFloor === 0 ? sample : this.noiseFloor * 0.98 + sample * 0.02;
        // A burst shorter than minSpeechMs was a click or cough, not speech: drop it.
        this.utterance = [];
        this.utteranceBytes = 0;
        this.preRoll.push(copy);
        this.preRollBytes += copy.length;
        const maxPreRoll = Math.round((this.format.sampleRate * this.options.preRollMs) / 1000) * 2;
        while (this.preRollBytes > maxPreRoll && this.preRoll.length > 0) {
          this.preRollBytes -= this.preRoll.shift()!.length;
        }
        this.speechMs = 0;
        return;
      }
      // Candidate speech: keep it, but only treat it as speech once it has lasted long enough.
      this.utterance.push(copy);
      this.utteranceBytes += copy.length;
      this.speechMs += WINDOW_MS;
      this.lastLoudAt = this.now();
      if (this.speechMs >= this.options.minSpeechMs) {
        this.inSpeech = true;
        this.utterance = [...this.preRoll, ...this.utterance];
        this.utteranceBytes += this.preRollBytes;
        this.preRoll = [];
        this.preRollBytes = 0;
        this.silenceMs = 0;
        if (!this.startedEmitted) {
          this.startedEmitted = true;
          this.events.onSpeechStart?.();
        }
      }
      return;
    }

    this.utterance.push(copy);
    this.utteranceBytes += copy.length;
    if (loud) {
      // The caller carried on: a pause that long was mid-sentence, so remember it, and withdraw any soft end.
      if (this.silenceMs >= MIN_GAP_MS) {
        this.gaps.push(this.silenceMs);
        if (this.gaps.length > GAP_HISTORY) this.gaps.shift();
      }
      if (this.activeSoft !== null) {
        const id = this.activeSoft;
        this.activeSoft = null;
        this.events.onSoftCancel?.(id);
      }
      this.silenceMs = 0;
      this.lastLoudAt = this.now();
    } else {
      this.silenceMs += WINDOW_MS;
    }
    const durationMs = (this.utteranceBytes / 2 / this.format.sampleRate) * 1000;
    const target = this.silenceTargetMs;
    const soft = this.options.softSilenceMs ?? 0;
    if (soft > 0 && this.activeSoft === null && this.silenceMs >= Math.min(soft, Math.max(WINDOW_MS, target - 100)) && this.silenceMs < target) {
      this.activeSoft = ++this.softId;
      this.events.onSoftEnd?.(Buffer.concat(this.utterance), { id: this.activeSoft, speechEndedAt: this.lastLoudAt, durationMs });
    }
    if (this.silenceMs >= target) {
      this.emit('silence');
    } else if (durationMs >= this.options.maxUtteranceMs) {
      this.emit('max-length');
    }
  }

  private emit(reason: UtteranceInfo['reason']): void {
    const pcm = Buffer.concat(this.utterance);
    const durationMs = (pcm.length / 2 / this.format.sampleRate) * 1000;
    const info: UtteranceInfo = {
      reason,
      durationMs,
      speechEndedAt: this.lastLoudAt,
      endpointedAt: this.now(),
      silenceMs: this.silenceMs,
      silenceTargetMs: this.silenceTargetMs,
      ...(this.activeSoft !== null ? { softId: this.activeSoft } : {}),
    };
    this.reset();
    this.events.onUtterance(pcm, info);
  }
}

// ---------------------------------------------------------------------------
// Pre-STT gate
// ---------------------------------------------------------------------------

export type UtteranceDecision = 'ok' | 'too-short' | 'silent' | 'unlikely-speech';

export interface UtteranceAssessment {
  decision: UtteranceDecision;
  durationMs: number;
  rms: number;
  peak: number;
  clippedRatio: number;
  voicedRatio: number;
  energeticFrames: number;
}

/**
 * Decide whether a captured utterance is worth sending to a paid STT provider. 'ok' means
 * "plausibly speech", never "intelligible": the voiced-pitch ratio is a hint, and only a person
 * listening can establish intelligibility.
 */
export function assessUtterance(
  pcm: Buffer,
  format: AudioFormat,
  options: { minDurationMs: number }
): UtteranceAssessment {
  const analysis = analyzePcm(pcm, format);
  const speech = speechIndicators(pcm, format);
  const base = {
    durationMs: analysis.durationMs,
    rms: analysis.rms,
    peak: analysis.peak,
    clippedRatio: analysis.clippedRatio,
    voicedRatio: speech.voicedRatio,
    energeticFrames: speech.energeticFrames,
  };
  if (analysis.durationMs < options.minDurationMs) return { decision: 'too-short', ...base };
  // Digital silence or a noise floor of a few LSB (the idle stream is about +/-2 of 32768).
  if (analysis.peak < 0.005 || speech.energeticFrames === 0) return { decision: 'silent', ...base };
  if (speech.voicedRatio < 0.15) return { decision: 'unlikely-speech', ...base };
  return { decision: 'ok', ...base };
}
