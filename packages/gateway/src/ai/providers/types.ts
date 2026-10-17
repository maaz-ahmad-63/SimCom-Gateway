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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmChunk {
  delta?: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  stream(request: { system: string; messages: ChatMessage[] }, signal: AbortSignal): AsyncIterable<LlmChunk>;
}

export interface TtsProvider {
  readonly name: string;
  /** Returns raw PCM in exactly `format` (16-bit signed little-endian mono), never a container. */
  synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer>;
}

export interface ProviderSet {
  stt: SttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
}
