import { analyzePcm, speechIndicators } from '../diagnostics/pcm-tools.js';
import { assertEnginePcm, AudioFormat } from './audio.js';

/**
 * Energy-based utterance endpointing. The source project uses Silero VAD (an ONNX model) with a
 * 1.0 s (max 3.0 s) endpointing delay; porting that would add onnxruntime to the gateway for little
 * benefit on narrow-band phone audio, so this uses frame RMS with the same delay semantics.
 * It decides "something loud enough happened", not "this is speech"; assessUtterance() adds a
 * second, independent look before any provider is paid.
 */
export interface EndpointerOptions {
  rmsThreshold: number; // fraction of full scale, e.g. 0.012
  minSpeechMs: number;
  minSilenceMs: number;
  maxUtteranceMs: number;
  preRollMs: number;
}

export interface EndpointerEvents {
  /** Speech has lasted at least minSpeechMs. Fires once per utterance (used for barge-in). */
  onSpeechStart?: () => void;
  /** The caller stopped for minSilenceMs, or maxUtteranceMs was reached. */
  onUtterance: (pcm: Buffer, info: { reason: 'silence' | 'max-length'; durationMs: number }) => void;
}

const WINDOW_MS = 20;

export class EnergyEndpointer {
  private readonly windowBytes: number;
  private carry = Buffer.alloc(0);
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;
  private utterance: Buffer[] = [];
  private utteranceBytes = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private inSpeech = false;
  private startedEmitted = false;

  constructor(
    private readonly format: AudioFormat,
    private readonly options: EndpointerOptions,
    private readonly events: EndpointerEvents
  ) {
    assertEnginePcm(format);
    this.windowBytes = Math.round((format.sampleRate * WINDOW_MS) / 1000) * 2;
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
    const loud = this.rms(window) >= this.options.rmsThreshold;
    const copy = Buffer.from(window);

    if (!this.inSpeech) {
      if (!loud) {
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
      this.silenceMs = 0;
    } else {
      this.silenceMs += WINDOW_MS;
    }
    const durationMs = (this.utteranceBytes / 2 / this.format.sampleRate) * 1000;
    if (this.silenceMs >= this.options.minSilenceMs) {
      this.emit('silence');
    } else if (durationMs >= this.options.maxUtteranceMs) {
      this.emit('max-length');
    }
  }

  private emit(reason: 'silence' | 'max-length'): void {
    const pcm = Buffer.concat(this.utterance);
    const durationMs = (pcm.length / 2 / this.format.sampleRate) * 1000;
    this.reset();
    this.events.onUtterance(pcm, { reason, durationMs });
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
