import { generateTone } from '../../diagnostics/pcm-tools.js';
import { AudioFormat } from '../audio.js';
import {
  AiProviderError,
  ChatMessage,
  LlmChunk,
  LlmProvider,
  ProviderSet,
  SttProvider,
  SttResult,
  TtsProvider,
} from './types.js';

/**
 * Offline providers for tests and `npm run ai:loop -- --mock`. They make no network calls and need no
 * keys. They are scripted, so a passing run proves the orchestration only, never provider behaviour.
 */
export class ScriptedStt implements SttProvider {
  readonly name = 'mock-stt';
  readonly calls: Array<{ bytes: number }> = [];
  constructor(
    private readonly script: Array<string | Error> | ((n: number) => string | Error) = [],
    private readonly delayMs = 0
  ) {}

  async transcribe(pcm: Buffer, _format: AudioFormat, signal: AbortSignal): Promise<SttResult> {
    const n = this.calls.push({ bytes: pcm.length }) - 1;
    await wait(this.delayMs, signal, 'stt');
    const item = typeof this.script === 'function' ? this.script(n) : (this.script[n] ?? this.script[this.script.length - 1] ?? 'hello');
    if (item instanceof Error) throw item;
    return { text: item };
  }
}

export class ScriptedLlm implements LlmProvider {
  readonly name = 'mock-llm';
  readonly requests: Array<{ system: string; messages: ChatMessage[] }> = [];
  constructor(
    private readonly script: Array<string | Error> | ((n: number, messages: ChatMessage[]) => string | Error) = [],
    private readonly options: { delayMs?: number; chunkChars?: number } = {}
  ) {}

  async *stream(request: { system: string; messages: ChatMessage[] }, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const n = this.requests.push({ system: request.system, messages: request.messages.map((m) => ({ ...m })) }) - 1;
    await wait(this.options.delayMs ?? 0, signal, 'llm');
    const item =
      typeof this.script === 'function'
        ? this.script(n, request.messages)
        : (this.script[n] ?? this.script[this.script.length - 1] ?? 'Okay.');
    if (item instanceof Error) throw item;
    const size = this.options.chunkChars ?? 12;
    for (let i = 0; i < item.length; i += size) {
      if (signal.aborted) throw new AiProviderError(this.name, 'llm', 'cancelled', { aborted: true });
      yield { delta: item.slice(i, i + size) };
      await Promise.resolve();
    }
    yield { usage: { promptTokens: 10 * (n + 1), completionTokens: Math.ceil(item.length / 4), totalTokens: 10 * (n + 1) + Math.ceil(item.length / 4) } };
  }
}

export interface ToneStreamOptions {
  /** Audio per chunk. Default 100 ms. */
  chunkMs?: number;
  /** Pause after each chunk, to model a network that delivers the audio over time. */
  gapMs?: number;
  /** Throw after this many chunks, to model a stream that breaks mid-reply. */
  failAfterChunks?: number;
}

/** Speaks nothing real: returns a quiet 440 Hz tone whose length follows the text length. */
export class ToneTts implements TtsProvider {
  readonly name = 'mock-tts';
  readonly requests: string[] = [];
  /** Present only when a stream was configured, because its mere presence switches the engine to streaming. */
  synthesizeStream?: (text: string, format: AudioFormat, signal: AbortSignal) => AsyncIterable<Buffer>;
  /** Set when a streamed request was cancelled by the caller. */
  streamCancelled = 0;
  constructor(
    private readonly delayMs = 0,
    private readonly failOn: (text: string, n: number) => boolean = () => false,
    stream?: ToneStreamOptions
  ) {
    if (stream) this.synthesizeStream = (text, format, signal) => this.streamTone(text, format, signal, stream);
  }

  private async *streamTone(text: string, format: AudioFormat, signal: AbortSignal, options: ToneStreamOptions): AsyncGenerator<Buffer> {
    const n = this.requests.push(text) - 1;
    await wait(this.delayMs, signal, 'tts');
    if (this.failOn(text, n)) throw new AiProviderError(this.name, 'tts', 'scripted failure');
    const whole = generateTone(format, 440, Math.min(2000, 200 + text.length * 20), 0.05);
    const size = Math.round((format.sampleRate * (options.chunkMs ?? 100)) / 1000) * 2;
    let sent = 0;
    for (let offset = 0; offset < whole.length; offset += size) {
      if (signal.aborted) {
        this.streamCancelled++;
        throw new AiProviderError(this.name, 'tts', 'cancelled', { aborted: true });
      }
      if (options.failAfterChunks !== undefined && sent >= options.failAfterChunks) {
        throw new AiProviderError(this.name, 'tts', 'scripted stream failure');
      }
      yield whole.subarray(offset, Math.min(offset + size, whole.length));
      sent++;
      try {
        await wait(options.gapMs ?? 0, signal, 'tts');
      } catch (error) {
        this.streamCancelled++;
        throw error;
      }
    }
  }

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const n = this.requests.push(text) - 1;
    await wait(this.delayMs, signal, 'tts');
    if (this.failOn(text, n)) throw new AiProviderError(this.name, 'tts', 'scripted failure');
    return generateTone(format, 440, Math.min(2000, 200 + text.length * 20), 0.05);
  }
}

export function createMockProviders(opts: {
  stt?: Array<string | Error>;
  llm?: Array<string | Error>;
  delays?: { stt?: number; llm?: number; tts?: number };
} = {}): ProviderSet & { stt: ScriptedStt; llm: ScriptedLlm; tts: ToneTts } {
  return {
    stt: new ScriptedStt(opts.stt ?? ['hello there'], opts.delays?.stt ?? 0),
    llm: new ScriptedLlm(opts.llm ?? ['Hello! How can I help you today?'], { delayMs: opts.delays?.llm ?? 0 }),
    tts: new ToneTts(opts.delays?.tts ?? 0),
  };
}

function wait(ms: number, signal: AbortSignal, stage: 'stt' | 'llm' | 'tts'): Promise<void> {
  if (signal.aborted) return Promise.reject(new AiProviderError('mock', stage, 'cancelled', { aborted: true }));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiProviderError('mock', stage, 'cancelled', { aborted: true }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
