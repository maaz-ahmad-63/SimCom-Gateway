import fs from 'node:fs';
import type { SpeechDetector } from '../endpointer.js';

/**
 * Silero VAD as a SpeechDetector for the endpointer (the source project's choice: Silero with activation threshold 0.5).
 *
 * What this file does NOT include: the ONNX runtime and the model. Neither is a dependency of the gateway today
 * (`onnxruntime-node` is not installed and silero_vad.onnx is not in the repository), so loadSileroSession() reports
 * exactly what is missing and the gateway keeps using the energy detector. Everything else here (windowing, context,
 * state, resampling, thresholding, fallback) is plain code that runs against any session with the same contract, and
 * is tested with a fake one. The model contract below follows Silero VAD v5's reference ONNX wrapper and has NOT been
 * verified against the real model in this repository.
 *
 *   inputs : input  float32 [1, context + window]   (the last `context` samples of the previous window are prepended)
 *            state  float32 [2, 1, 128]              (recurrent state, zeros at the start, replaced by `stateN`)
 *            sr     int64   scalar                   (8000 or 16000)
 *   outputs: output float32 [1, 1]                   (speech probability), stateN float32 [2, 1, 128]
 *   window : 256 samples at 8 kHz (32 ms), 512 at 16 kHz (32 ms); context 32 / 64 samples.
 *
 * 8 kHz audio is given to the model AS 8 kHz (Silero supports it natively); it is never relabelled as 16 kHz. Any
 * other rate is resampled to 16 kHz first.
 */
export interface SileroResult {
  probability: number;
  state: Float32Array;
}

export interface SileroSession {
  /** One model step. May return synchronously (tests) or a promise (onnxruntime). */
  run(input: Float32Array, state: Float32Array, sampleRate: 8000 | 16000): SileroResult | Promise<SileroResult>;
}

export const SILERO_STATE_LENGTH = 2 * 128;

export function sileroGeometry(modelRate: 8000 | 16000): { window: number; context: number } {
  return modelRate === 8000 ? { window: 256, context: 32 } : { window: 512, context: 64 };
}

/** 8 kHz and 16 kHz go to the model unchanged; everything else is converted to 16 kHz. */
export function sileroModelRate(inputRate: number): 8000 | 16000 {
  return inputRate === 8000 ? 8000 : 16000;
}

/**
 * Streaming linear-interpolation resampler that carries its position across chunks, so consecutive 20 ms windows
 * join without clicks. It does no low-pass filtering: acceptable for a speech/no-speech decision, and not used for
 * the rates this gateway actually runs at (8 kHz and 16 kHz pass through untouched).
 */
export class StreamResampler {
  private last: number | null = null;
  private pos = 0;

  constructor(
    private readonly from: number,
    private readonly to: number
  ) {}

  process(input: Float32Array): Float32Array {
    if (this.from === this.to) return input;
    const step = this.from / this.to;
    let src = input;
    if (this.last !== null) {
      src = new Float32Array(input.length + 1);
      src[0] = this.last;
      src.set(input, 1);
    }
    const out: number[] = [];
    let p = this.pos;
    while (p + 1 < src.length) {
      const i = Math.floor(p);
      const frac = p - i;
      out.push(src[i] * (1 - frac) + src[i + 1] * frac);
      p += step;
    }
    this.last = src.length > 0 ? src[src.length - 1] : this.last;
    this.pos = p - (src.length - 1);
    return Float32Array.from(out);
  }

  reset(): void {
    this.last = null;
    this.pos = 0;
  }
}

function int16LeToFloat(window: Buffer): Float32Array {
  const n = window.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = window.readInt16LE(i * 2) / 32768;
  return out;
}

const isPromise = (value: unknown): value is Promise<SileroResult> => typeof (value as { then?: unknown })?.then === 'function';

export interface SileroDetectorOptions {
  session: SileroSession;
  /** Sample rate of the audio the endpointer feeds in (the gateway's PCM rate). */
  inputRate: number;
  /** Speech probability at or above which a window counts as speech (0.5 in the source). */
  threshold: number;
  onError?: (error: Error) => void;
}

export class SileroSpeechDetector implements SpeechDetector {
  readonly name = 'silero';
  /** False after the model failed; the endpointer then falls back to loudness so the call is never left deaf. */
  healthy = true;
  readonly modelRate: 8000 | 16000;

  private readonly window: number;
  private readonly context: number;
  private readonly resampler: StreamResampler | null;
  private pending: Float32Array = new Float32Array(0);
  private ctx: Float32Array;
  private state: Float32Array = new Float32Array(SILERO_STATE_LENGTH);
  private probability = 0;
  private queue: Float32Array[] = [];
  private busy = false;
  private generation = 0;

  constructor(private readonly options: SileroDetectorOptions) {
    this.modelRate = sileroModelRate(options.inputRate);
    const geometry = sileroGeometry(this.modelRate);
    this.window = geometry.window;
    this.context = geometry.context;
    this.ctx = new Float32Array(this.context);
    this.resampler = options.inputRate === this.modelRate ? null : new StreamResampler(options.inputRate, this.modelRate);
  }

  /** The latest speech probability (an async model lags the audio by at most a window or two). */
  get lastProbability(): number {
    return this.probability;
  }

  isSpeech(window: Buffer): boolean {
    const samples = int16LeToFloat(window);
    const converted = this.resampler ? this.resampler.process(samples) : samples;
    const joined = new Float32Array(this.pending.length + converted.length);
    joined.set(this.pending, 0);
    joined.set(converted, this.pending.length);
    let offset = 0;
    while (joined.length - offset >= this.window) {
      this.queue.push(joined.slice(offset, offset + this.window));
      offset += this.window;
    }
    this.pending = joined.slice(offset);
    this.pump();
    return this.probability >= this.options.threshold;
  }

  reset(): void {
    this.generation++;
    this.pending = new Float32Array(0);
    this.queue = [];
    this.ctx = new Float32Array(this.context);
    this.state = new Float32Array(SILERO_STATE_LENGTH);
    this.probability = 0;
    this.busy = false;
    this.resampler?.reset();
  }

  private pump(): void {
    if (this.busy) return;
    if (!this.healthy) {
      this.queue = []; // the model failed once; the endpointer is using loudness, nothing more is sent to it
      return;
    }
    while (this.queue.length > 0) {
      const win = this.queue.shift()!;
      const input = new Float32Array(this.context + win.length);
      input.set(this.ctx, 0);
      input.set(win, this.context);
      this.ctx = win.slice(win.length - this.context);
      let result: SileroResult | Promise<SileroResult>;
      try {
        result = this.options.session.run(input, this.state, this.modelRate);
      } catch (error) {
        this.fail(error);
        return;
      }
      if (isPromise(result)) {
        this.busy = true;
        const generation = this.generation;
        result.then(
          (value) => {
            if (generation !== this.generation) return;
            this.apply(value);
            this.busy = false;
            this.pump();
          },
          (error) => {
            if (generation !== this.generation) return;
            this.busy = false;
            this.fail(error);
          }
        );
        return;
      }
      this.apply(result);
    }
  }

  private apply(result: SileroResult): void {
    this.state = result.state;
    this.probability = result.probability;
  }

  private fail(error: unknown): void {
    this.healthy = false;
    this.queue = [];
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

const RUNTIME_MODULE = 'onnxruntime-node';

/**
 * Loads the model with onnxruntime-node. Fails with a message naming what is missing (the model file, or the
 * runtime package) so the caller can report it and fall back. The session holds no per-call state: the recurrent
 * state travels with each SileroSpeechDetector, so one session serves every call.
 *
 * NOT exercised against the real runtime or model here (neither is installed); the unit tests use a fake runtime
 * that follows the same Tensor/InferenceSession API.
 */
export async function loadSileroSession(
  modelPath: string,
  importRuntime: () => Promise<any> = () => import(RUNTIME_MODULE)
): Promise<SileroSession> {
  if (!fs.existsSync(modelPath)) throw new Error(`the Silero model file was not found at ${modelPath}`);
  let ort: any;
  try {
    ort = await importRuntime();
  } catch {
    throw new Error(`the ${RUNTIME_MODULE} package is not installed`);
  }
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  return {
    async run(input, state, sampleRate) {
      const feeds = {
        input: new ort.Tensor('float32', input, [1, input.length]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(sampleRate)]), []),
      };
      const out = await session.run(feeds);
      return { probability: Number(out.output.data[0]), state: Float32Array.from(out.stateN.data as ArrayLike<number>) };
    },
  };
}
