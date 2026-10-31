import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which call and turn the code running right now belongs to. The conversation sets it around each turn, so a provider
 * request, a retry or an error is attributed to the right turn without every adapter having to know about calls.
 * AsyncLocalStorage follows the async chain, so two calls running at once can never see each other's context.
 */
export interface ObsContext {
  callId: string;
  turnId: string | null;
}

const storage = new AsyncLocalStorage<ObsContext>();

export const runWithObsContext = <T>(context: ObsContext, work: () => T): T => storage.run(context, work);
export const currentObsContext = (): ObsContext | undefined => storage.getStore();

/** One HTTP attempt to a provider (every retry is its own attempt). */
export interface ProviderAttempt {
  provider: string;
  stage: string;
  /** 1-based. */
  attempt: number;
  /** Null when no response arrived (network error, timeout, cancel). */
  httpStatus: number | null;
  durationMs: number;
  outcome: 'ok' | 'http-error' | 'timeout' | 'network-error' | 'cancelled';
  willRetry: boolean;
  /** Safe, redacted text only. */
  detail?: string;
}

type AttemptSink = (attempt: ProviderAttempt, context: ObsContext | undefined) => void;
let sink: AttemptSink | null = null;

/** The runtime registers where attempts go (the observability store). Returns a function that unregisters it. */
export function setProviderAttemptSink(next: AttemptSink): () => void {
  sink = next;
  // Unregistering only clears this registration, never a newer one (several gateways can exist in one process in tests).
  return () => {
    if (sink === next) sink = null;
  };
}

export function reportProviderAttempt(attempt: ProviderAttempt): void {
  if (!sink) return;
  try {
    sink(attempt, currentObsContext());
  } catch {
    // Telemetry must never affect a provider request.
  }
}
