import { AudioFormat } from '../audio.js';

export type AiStage = 'stt' | 'llm' | 'tts';

/** 'en-US' -> 'en'. Whisper and Cartesia take ISO 639-1 codes and reject regional tags. */
export function baseLanguage(language: string): string {
  return language.split('-')[0].toLowerCase();
}

/** A provider failure with enough context to act on and nothing that could leak a credential. */
export class AiProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly stage: AiStage,
    message: string,
    readonly details: { status?: number; retryable?: boolean; aborted?: boolean; timedOut?: boolean } = {}
  ) {
    super(`${provider} ${stage}: ${message}`);
    this.name = 'AiProviderError';
  }

  get retryable(): boolean {
    return this.details.retryable === true;
  }
}

export interface SttResult {
  text: string;
  confidence?: number;
}

export interface SttProvider {
  readonly name: string;
  /** Transcribe one complete utterance of PCM in `format`. */
  transcribe(pcm: Buffer, format: AudioFormat, signal: AbortSignal): Promise<SttResult>;
}

/**
 * One utterance being recognized while it is still being spoken. Audio goes in as it is captured; only FINAL text
 * comes out, and only when the caller of finalize() asks for it at the confirmed end of the utterance.
 */
export interface SttStream {
  /** Append caller audio (16-bit mono PCM in the format the stream was opened with). Never throws. */
  push(pcm: Buffer): void;
  /** Ask the provider to flush what it has heard so far without ending the stream (a hint; the caller may carry on). */
  flush(): void;
  /**
   * Flush and wait for the provider's final text for everything pushed so far. Resolves null when the stream failed,
   * closed early, was aborted, or no final answer arrived in time: the caller then uses the batch provider.
   */
  finalize(signal?: AbortSignal, timeoutMs?: number): Promise<SttResult | null>;
  /** The latest interim hypothesis, for display only. It is never a transcript and never starts a reply. */
  readonly interim: string;
  /** Set once the stream has failed. */
  readonly error: Error | null;
  /** How the last finalize() ended, so a fallback to the batch provider can say why. */
  readonly finalizeOutcome?: {
    how: 'acknowledged' | 'quiet-after-reply' | 'timeout' | 'failed' | 'closed' | 'aborted';
    waitedMs: number;
    finals: number;
    /** Counters and timings only (never words or audio): what the recognizer did, so a timeout can be traced to its cause. */
    diag?: Record<string, number>;
  } | null;
  /** Release the connection. Idempotent. */
  close(): void;
}

export interface StreamingSttProvider {
  readonly name: string;
  open(format: AudioFormat, signal: AbortSignal): SttStream;
  /** Get a connection ready for the next utterance (optional). Never throws. */
  warm?(format: AudioFormat): void;
  /** Release anything kept ready: the call ended (optional). */
  dispose?(): void;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A function the model may call: a name, a description and a JSON Schema for its arguments (the OpenAI "tools" shape). */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One call the model asked for. `arguments` is the raw JSON text exactly as the model produced it: it is parsed and validated by the caller. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** The messages of a tool exchange within one turn: the model's calls, then one result per call. Never part of the stored history. */
export type LlmToolMessage =
  | { role: 'assistant'; content: string; toolCalls: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type LlmMessage = ChatMessage | LlmToolMessage;

export interface LlmChunk {
  delta?: string;
  usage?: LlmUsage;
  /** Why the model stopped ("stop", "length", "tool_calls", ...), when the provider says. */
  finishReason?: string;
  /** The complete calls the model made, delivered once at the end of the reply (arguments are assembled from the stream). */
  toolCalls?: LlmToolCall[];
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  /** Functions the model may call. Ignored by a provider that does not support them (check `supportsTools`). */
  tools?: LlmToolSpec[];
}

export interface LlmProvider {
  readonly name: string;
  /** False for a provider that returns the whole reply at once: its first-token time is then not a real TFT. Default true. */
  readonly streaming?: boolean;
  /**
   * Whether this provider/model accepts function calling. Absent or false: `tools` is never sent and the model is used
   * exactly as before. Declared from the provider's documentation and corrected at runtime if the provider rejects tools.
   */
  readonly supportsTools?: boolean;
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk>;
}

/** Optional callbacks from a streaming synthesis request. A provider may ignore them. */
export interface TtsStreamHooks {
  /** The request left the queue and began (a concurrency limit makes later sentences wait for earlier ones). */
  onStart?: () => void;
}

export interface TtsProvider {
  readonly name: string;
  /** Returns raw PCM in exactly `format` (16-bit signed little-endian mono), never a container. */
  synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer>;
  /**
   * Optional: the same audio as it is generated, as whole 16-bit samples in `format`. Lets playback start on the
   * first bytes instead of after the full sentence. Must throw (not return) on failure, and stop when `signal` aborts.
   */
  synthesizeStream?(text: string, format: AudioFormat, signal: AbortSignal, hooks?: TtsStreamHooks): AsyncIterable<Buffer>;
}

export interface ProviderSet {
  stt: SttProvider;
  /** Optional streaming recognizer (AI_STT_STREAMING). `stt` stays the fallback for any stream that fails. */
  sttStream?: StreamingSttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}
