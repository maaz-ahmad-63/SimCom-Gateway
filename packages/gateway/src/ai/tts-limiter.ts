import { AudioFormat } from './audio.js';
import { AiProviderError, TtsProvider } from './providers/types.js';

/**
 * A first-in-first-out concurrency limit with cancellation. A request that is cancelled while it waits is
 * dropped without ever running; one that is running is cancelled through its own signal. Slots are always
 * released, whether the task succeeded, failed or was cancelled.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('concurrency must be a positive integer');
  }

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }

  setMax(max: number): void {
    this.max = Math.max(1, Math.floor(max));
    this.drain();
  }

  async run<T>(task: () => Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
    if (signal.aborted) throw onAbort();
    if (this.active >= this.max) {
      // drain() reserves the slot for us before waking us, so a newcomer cannot slip in between.
      await new Promise<void>((resolve, reject) => {
        const entry = (): void => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = (): void => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(onAbort());
        };
        this.waiting.push(entry);
        signal.addEventListener('abort', cancel, { once: true });
      });
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.max && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.active++;
      next();
    }
  }
}

const SHARED = new Map<string, ConcurrencyLimiter>();

/** One limiter per provider for the whole process: a provider's concurrency limit is per account, not per call. */
export function sharedLimiter(provider: string, max: number): ConcurrencyLimiter {
  const existing = SHARED.get(provider);
  if (existing) {
    existing.setMax(max);
    return existing;
  }
  const created = new ConcurrencyLimiter(max);
  SHARED.set(provider, created);
  return created;
}

/**
 * Text-to-speech behind a concurrency limit. A reply of several sentences used to start one request per
 * sentence at once, which provoked "Too many concurrent requests" (HTTP 429) from providers with a low limit.
 * Now sentence N+1 is requested while sentence N plays, and never two at the same moment (default 1).
 */
export class LimitedTts implements TtsProvider {
  readonly name: string;

  constructor(
    private readonly inner: TtsProvider,
    private readonly limiter: ConcurrencyLimiter
  ) {
    this.name = inner.name;
  }

  synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    return this.limiter.run(
      () => this.inner.synthesize(text, format, signal),
      signal,
      () => new AiProviderError(this.name, 'tts', 'cancelled', { aborted: true })
    );
  }
}
