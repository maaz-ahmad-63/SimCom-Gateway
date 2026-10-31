import { assertEnginePcm, AudioFormat } from '../audio.js';
import { DEEPGRAM_AU_LISTEN_URL, DEEPGRAM_GLOBAL_LISTEN_URL } from '../catalog.js';
import { AiProviderError, SttResult, SttStream, StreamingSttProvider } from './types.js';

/**
 * The slice of the WebSocket API this provider uses, so tests can drive it with a fake and Node's built-in
 * WebSocket (Node 22+, no extra dependency) satisfies it as is.
 */
export interface WsLike {
  readonly readyState: number;
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
}
export type WebSocketFactory = (url: string, protocols: string[]) => WsLike;

const WS_OPEN = 1;

export const nodeWebSocketFactory: WebSocketFactory = (url, protocols) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => WsLike }).WebSocket;
  if (!Ctor) throw new Error('this Node.js has no built-in WebSocket (Node 22 or newer is required)');
  return new Ctor(url, protocols);
};

export interface DeepgramListenParams {
  model: string;
  language: string;
  sampleRate: number;
  keyterms: string[];
  /** https URL of the listen endpoint; the default follows the source project (AU for English, global otherwise). */
  baseUrl?: string;
}

/**
 * The streaming listen URL, built from the same choices as the source project's deepgram_stt.py (model, language,
 * `keyterm` list, smart_format, AU endpoint for English and the global one otherwise) plus the live-stream settings
 * LiveKit's Deepgram plugin sends (interim results, punctuation, no_delay, 25 ms endpointing). The audio is declared
 * as what it is: raw 16-bit little-endian mono at the gateway's own sample rate, never relabelled.
 */
export function deepgramListenWsUrl(params: DeepgramListenParams): string {
  const base = params.baseUrl ?? (params.language === 'en' ? DEEPGRAM_AU_LISTEN_URL : DEEPGRAM_GLOBAL_LISTEN_URL);
  const url = new URL(base);
  url.protocol = 'wss:';
  const q = url.searchParams;
  q.set('model', params.model);
  if (params.language) q.set('language', params.language);
  q.set('encoding', 'linear16');
  q.set('sample_rate', String(params.sampleRate));
  q.set('channels', '1');
  q.set('interim_results', 'true');
  q.set('smart_format', 'true');
  q.set('punctuate', 'true');
  q.set('no_delay', 'true');
  q.set('endpointing', '25');
  for (const term of params.keyterms) q.append('keyterm', term);
  return url.toString();
}

export interface DeepgramStreamingOptions {
  apiKey: string;
  model: string;
  language: string;
  keyterms: string[];
  baseUrl?: string;
  /** Longest wait, after the utterance ends, for the final text before the batch provider takes over. */
  finalizeTimeoutMs: number;
  /** Once a flush was requested and nothing is left unfinalized, this much quiet from the server means "that is all". */
  quietMs?: number;
  /** The connection must open within this long, otherwise the stream is failed (default 4000 ms). */
  connectTimeoutMs?: number;
  /** Audio held while the connection opens; a stream that cannot open before this fills is failed (default 20 s). */
  maxQueuedSeconds?: number;
  webSocketFactory?: WebSocketFactory;
  /**
   * Keep one connection open and idle, ready for the next utterance. Opening one costs 1.7 s to the AU endpoint (stream_openMs on
   * calls a239ca50 and 114431fb), and a merged-audio replay or a short utterance waits for all of it. An idle connection is kept
   * alive with Deepgram's KeepAlive message; nothing is billed until audio is sent.
   */
  warmStandby?: boolean;
  /** How often an idle spare connection sends KeepAlive (Deepgram closes a silent one after 10 s). Default 4000 ms. */
  keepAliveMs?: number;
  /** An unused spare connection is closed after this long. Default 120 000 ms. */
  standbyMaxAgeMs?: number;
}

export class DeepgramStreamingStt implements StreamingSttProvider {
  readonly name = 'deepgram-stream';

  private standby: DeepgramStream | null = null;
  private standbyRate = 0;
  private disposed = false;

  constructor(private readonly options: DeepgramStreamingOptions) {}

  open(format: AudioFormat, signal: AbortSignal): SttStream {
    assertEnginePcm(format);
    const warm = this.takeStandby(format);
    const stream = warm ?? new DeepgramStream(this.options, format, signal);
    if (warm) warm.claim(signal);
    if (this.options.warmStandby) setImmediate(() => this.warm(format)); // the next utterance finds a connection ready too
    return stream;
  }

  /** Open a spare connection now, if none is ready. Never throws and never blocks: a call works the same without it. */
  warm(format: AudioFormat): void {
    if (!this.options.warmStandby || this.disposed) return;
    try {
      assertEnginePcm(format);
      if (this.standby?.isStandbyUsable && this.standbyRate === format.sampleRate) return;
      this.standby?.close();
      this.standbyRate = format.sampleRate;
      const spare = new DeepgramStream(this.options, format, undefined, () => {
        if (this.standby === spare) this.standby = null;
      });
      this.standby = spare;
    } catch {
      this.standby = null;
    }
  }

  /** Close the spare connection (the call ended). */
  dispose(): void {
    this.disposed = true;
    this.standby?.close();
    this.standby = null;
  }

  private takeStandby(format: AudioFormat): DeepgramStream | null {
    const candidate = this.standby;
    this.standby = null;
    if (!candidate) return null;
    if (!candidate.isStandbyUsable || this.standbyRate !== format.sampleRate) {
      candidate.close();
      return null;
    }
    return candidate;
  }
}

class DeepgramStream implements SttStream {
  interim = '';
  error: Error | null = null;

  private ws: WsLike | null = null;
  private opened = false;
  private closed = false;
  private readonly queue: Array<Buffer | string> = [];
  private queuedBytes = 0;
  private readonly maxQueuedBytes: number;
  private readonly finals: string[] = [];
  private flushesSent = 0;
  private flushesAcked = 0;
  private lastMessageAt = Date.now();
  /** When the most recent Finalize was sent: only a message after it shows the server has caught up with our audio. */
  private lastFlushAt = 0;
  // Diagnostics only: counters and times, never words or audio.
  /** When an utterance took this connection: a spare that was already open reports an open time of 0, not its age. */
  private claimedAt = Date.now();
  private readonly bytesPerMs: number;
  private claimed = true;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private openedAt: number | null = null;
  private firstMessageAt: number | null = null;
  private pushedBytes = 0;
  private readonly counts = { interimText: 0, interimEmpty: 0, finalText: 0, finalEmpty: 0, fromFinalize: 0, other: 0 };
  finalizeOutcome: SttStream['finalizeOutcome'] = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private readonly wake = new Set<() => void>();

  /** `signal` is absent for a spare connection: claim() attaches it when an utterance takes the connection. */
  constructor(
    private readonly options: DeepgramStreamingOptions,
    format: AudioFormat,
    signal?: AbortSignal,
    private readonly onStandbyEnded?: () => void
  ) {
    this.maxQueuedBytes = Math.round(format.sampleRate * 2 * (options.maxQueuedSeconds ?? 20));
    this.bytesPerMs = (format.sampleRate * 2) / 1000;
    if (signal) {
      if (signal.aborted) {
        this.close();
        return;
      }
      signal.addEventListener('abort', () => this.close(), { once: true });
    } else {
      this.claimed = false;
      this.keepAliveTimer = setInterval(() => {
        if (this.opened && !this.closed) this.sendNow(JSON.stringify({ type: 'KeepAlive' }));
      }, options.keepAliveMs ?? 4000);
      this.keepAliveTimer.unref?.();
      this.expiryTimer = setTimeout(() => this.close(), options.standbyMaxAgeMs ?? 120_000);
      this.expiryTimer.unref?.();
    }
    try {
      const url = deepgramListenWsUrl({
        model: options.model,
        language: options.language,
        sampleRate: format.sampleRate,
        keyterms: options.keyterms,
        baseUrl: options.baseUrl,
      });
      // Deepgram accepts the key as a WebSocket subprotocol, which keeps it out of the URL and out of any log of it.
      this.ws = (options.webSocketFactory ?? nodeWebSocketFactory)(url, ['token', options.apiKey]);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not open the WebSocket');
      return;
    }
    const ws = this.ws;
    ws.onopen = () => {
      if (this.closed) return;
      this.opened = true;
      this.openedAt = Date.now();
      if (this.connectTimer) clearTimeout(this.connectTimer);
      for (const item of this.queue.splice(0)) this.sendNow(item);
      this.queuedBytes = 0;
    };
    ws.onmessage = (event) => this.onMessage(event.data);
    ws.onerror = () => this.fail('the WebSocket reported an error');
    ws.onclose = () => {
      if (!this.closed) this.fail('the connection closed before the utterance was finalized');
    };
    this.connectTimer = setTimeout(() => {
      if (!this.opened) this.fail('the connection did not open in time');
    }, options.connectTimeoutMs ?? 4000);
    this.connectTimer.unref?.();
  }

  /** A spare connection that is alive (open or opening) and unused. */
  get isStandbyUsable(): boolean {
    return !this.claimed && !this.closed && !this.error;
  }

  /** An utterance takes the spare connection. From now on it is an ordinary stream bound to that utterance's signal. */
  claim(signal: AbortSignal): void {
    this.claimed = true;
    this.claimedAt = Date.now();
    this.lastMessageAt = this.claimedAt;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.keepAliveTimer = this.expiryTimer = null;
    if (signal.aborted) {
      this.close();
      return;
    }
    signal.addEventListener('abort', () => this.close(), { once: true });
  }

  push(pcm: Buffer): void {
    if (this.closed || this.error || pcm.length === 0) return;
    this.pushedBytes += pcm.length;
    if (this.opened) {
      this.sendNow(pcm);
      return;
    }
    this.queue.push(Buffer.from(pcm));
    this.queuedBytes += pcm.length;
    if (this.queuedBytes > this.maxQueuedBytes) this.fail('too much audio waited for the connection to open');
  }

  flush(): void {
    if (this.closed || this.error) return;
    this.flushesSent++;
    this.lastFlushAt = Date.now();
    const message = JSON.stringify({ type: 'Finalize' });
    if (this.opened) this.sendNow(message);
    else this.queue.push(message);
  }

  async finalize(signal?: AbortSignal, timeoutMs?: number): Promise<SttResult | null> {
    if (this.error || this.closed) return null;
    this.flush();
    const quietMs = this.options.quietMs ?? 300;
    const startedAt = Date.now();
    return new Promise<SttResult | null>((resolve) => {
      let settled = false;
      const finish = (value: SttResult | null, how: NonNullable<SttStream['finalizeOutcome']>['how']) => {
        if (settled) return;
        settled = true;
        this.finalizeOutcome = { how, waitedMs: Date.now() - startedAt, finals: this.finals.length, diag: this.diagnostics() };
        clearInterval(poll);
        clearTimeout(timer);
        this.wake.delete(check);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const check = () => {
        if (this.error) return finish(null, 'failed');
        if (this.flushesAcked >= this.flushesSent) return finish(this.result(), 'acknowledged');
        // Closed (aborted, or released) before the server confirmed the flush: the words are not known to be complete.
        if (this.closed) return finish(null, 'closed');
        // Quiet means "nothing more is coming" only when the server has actually told us something: it answered AFTER our last
        // Finalize (for example it folded two Finalize requests into one answer), or it already finalized words on its own.
        // Silence from a server that has not answered yet is not an answer: before, such a stream was taken as finished after
        // 300 ms with no words, the empty result was rejected, and the batch provider ran instead. On call 503ec8b2 that was
        // every "fallback" turn. Now it waits for the answer, bounded by finalizeTimeoutMs.
        const serverHasAnswered = this.lastMessageAt > this.lastFlushAt || this.finals.length > 0;
        if (serverHasAnswered && this.interim === '' && Date.now() - this.lastMessageAt >= quietMs && Date.now() - startedAt >= quietMs) {
          return finish(this.result(), 'quiet-after-reply');
        }
      };
      const onAbort = () => finish(null, 'aborted');
      const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs ?? this.options.finalizeTimeoutMs);
      const poll = setInterval(check, 25);
      timer.unref?.();
      poll.unref?.();
      this.wake.add(check);
      if (signal?.aborted) return finish(null, 'aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.keepAliveTimer = this.expiryTimer = null;
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // closing anyway
      }
    }
    try {
      ws?.close();
    } catch {
      // already closed
    }
    this.wakeAll();
    if (!this.claimed) this.onStandbyEnded?.();
  }

  private result(): SttResult {
    return { text: this.finals.join(' ').replace(/\s+/g, ' ').trim() };
  }

  private sendNow(item: Buffer | string): void {
    try {
      this.ws?.send(item);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'send failed');
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    this.lastMessageAt = Date.now();
    this.firstMessageAt ??= this.lastMessageAt;
    if (message?.type === 'Results') {
      const text = String(message.channel?.alternatives?.[0]?.transcript ?? '').trim();
      if (message.is_final === true) {
        // Only final segments become part of the transcript, in the order they were finalized.
        if (text) this.finals.push(text);
        if (text) this.counts.finalText++;
        else this.counts.finalEmpty++;
        this.interim = '';
        if (message.from_finalize === true) {
          this.flushesAcked++;
          this.counts.fromFinalize++;
        }
      } else {
        this.interim = text; // display only
        if (text) this.counts.interimText++;
        else this.counts.interimEmpty++;
      }
    } else if (message?.type === 'Error' || message?.type === 'error') {
      this.fail(String(message.description ?? message.message ?? 'provider error').slice(0, 200));
      return;
    } else {
      this.counts.other++;
    }
    this.wakeAll();
  }

  /** What this stream did, as numbers: when it opened, how much audio it was given, what the server sent back and when. */
  private diagnostics(): Record<string, number> {
    const now = Date.now();
    return {
      openMs: this.openedAt === null ? -1 : Math.max(0, this.openedAt - this.claimedAt),
      audioMs: Math.round(this.pushedBytes / this.bytesPerMs),
      ageMs: now - this.claimedAt,
      firstReplyMs: this.firstMessageAt === null ? -1 : Math.max(0, this.firstMessageAt - this.claimedAt),
      lastReplyAgoMs: now - this.lastMessageAt,
      interimChars: this.interim.length,
      flushesSent: this.flushesSent,
      flushesAcked: this.flushesAcked,
      ...this.counts,
    };
  }

  private fail(reason: string): void {
    if (this.error) return;
    this.error = new AiProviderError('deepgram-stream', 'stt', reason, { retryable: false });
    this.close();
  }

  private wakeAll(): void {
    for (const fn of [...this.wake]) fn();
  }
}
