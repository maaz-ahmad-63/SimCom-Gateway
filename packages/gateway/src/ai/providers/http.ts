import { AiProviderError, AiStage } from './types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  provider: string;
  stage: AiStage;
  fetchImpl: FetchLike;
  /** Per-attempt time to receive response headers. */
  timeoutMs: number;
  /**
   * Time allowed for the body once headers arrive (default: timeoutMs). A streaming reply passes its
   * whole-reply budget here; the timer aborts the stream if it is still running when it expires.
   */
  bodyTimeoutMs?: number;
  /** Retries after the first attempt, for idempotent requests only. */
  maxRetries: number;
  signal: AbortSignal;
  /** Sleep used between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Remove anything that looks like a credential from text that may end up in an error. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer|Token|Basic)\s+[A-Za-z0-9\-_.=+/]{6,}/gi, '$1 [REDACTED]')
    .replace(/\b(sk|gsk|sk_car|dg)[-_][A-Za-z0-9\-_]{8,}/g, '[REDACTED]')
    .replace(/(api[-_]?key|token|secret|authorization)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '$1=[REDACTED]');
}

function statusAdvice(status: number): string {
  if (status === 401 || status === 403) return 'authentication failed: check the API key for this provider';
  if (status === 404) return 'endpoint or model not found: check the model/voice id';
  if (status === 408) return 'provider timed out';
  if (status === 413) return 'request body too large';
  if (status === 429) return 'rate limited or out of quota';
  if (status >= 500) return 'provider server error';
  return 'request rejected';
}

async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const body = (await response.text()).replace(/\s+/g, ' ').trim();
    return redactSecrets(body.slice(0, 200));
  } catch {
    return '';
  }
}

/**
 * One HTTP request with a per-attempt timeout, caller cancellation and bounded retry on network
 * errors, 408, 429 and 5xx. Only use it for idempotent provider requests (STT, TTS, and the start
 * of an LLM stream before any chunk was delivered); never for call control.
 */
export async function requestWithRetry(url: string, init: RequestInit, options: RequestOptions): Promise<Response> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError: AiProviderError | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (options.signal.aborted) {
      throw new AiProviderError(options.provider, options.stage, 'cancelled', { aborted: true });
    }
    const attemptController = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, ms);
      timer.unref?.();
    };
    arm(options.timeoutMs);
    const signal = AbortSignal.any([options.signal, attemptController.signal]);

    let retryAfterMs = 0;
    try {
      const response = await options.fetchImpl(url, { ...init, signal });
      if (response.ok) {
        arm(options.bodyTimeoutMs ?? options.timeoutMs);
        // Make sure a timeout (or a caller abort) really stops a body that is still streaming.
        signal.addEventListener('abort', () => void response.body?.cancel().catch(() => {}), { once: true });
        return response;
      }
      if (timer) clearTimeout(timer);

      const snippet = await readErrorSnippet(response);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, 2000);
      lastError = new AiProviderError(
        options.provider,
        options.stage,
        `HTTP ${response.status}: ${statusAdvice(response.status)}${snippet ? ` (${snippet})` : ''}`,
        { status: response.status, retryable }
      );
      if (!retryable) throw lastError;
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (error instanceof AiProviderError) {
        if (!error.retryable) throw error;
        lastError = error;
      } else if (options.signal.aborted) {
        throw new AiProviderError(options.provider, options.stage, 'cancelled', { aborted: true });
      } else if (timedOut) {
        lastError = new AiProviderError(options.provider, options.stage, `timed out after ${options.timeoutMs} ms`, {
          retryable: true,
          timedOut: true,
        });
      } else {
        lastError = new AiProviderError(
          options.provider,
          options.stage,
          `network error: ${redactSecrets((error as Error).message ?? 'unknown')}`,
          { retryable: true }
        );
      }
    }

    if (attempt < options.maxRetries) {
      await sleep(retryAfterMs || 250 * 2 ** attempt);
    }
  }
  throw lastError ?? new AiProviderError(options.provider, options.stage, 'request failed');
}
