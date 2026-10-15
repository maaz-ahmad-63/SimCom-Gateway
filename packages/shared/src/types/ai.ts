import { Readable, Writable } from 'node:stream';

/**
 * Pluggable AI Voice Adapter interfaces.
 * Decouples speech recognition, intelligence (LLM), and speech synthesis
 * from modem hardware. Allows seamless future integration with VART-AI
 * or any cloud/local AI voice stack.
 */

export interface STTTranscriptEvent {
  text: string;
  isFinal: boolean;
  confidence: number;
  speechDurationMs: number;
  timestamp: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp?: string;
}

export interface VoiceAgentConfig {
  agentName: string;
  systemPrompt: string;
  voiceId: string;
  sttLanguage: string;
  temperature?: number;
  maxTokens?: number;
  allowBargeIn: boolean; // Enables interrupting AI speech when user talks
}

export interface ISTTProvider {
  readonly providerName: string;
  
  /** Initialize connection to STT service */
  connect(): Promise<void>;
  
  /** Disconnect and cleanup */
  disconnect(): Promise<void>;
  
  /** Push raw audio frame into STT pipeline */
  sendAudio(chunk: Buffer): void;

  on(event: 'transcript', listener: (event: STTTranscriptEvent) => void): this;
  on(event: 'speech_started', listener: () => void): this;
  on(event: 'speech_ended', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ILLMProvider {
  readonly providerName: string;

  /** Generate streaming text response given conversation context */
  generateResponse(
    messages: LLMMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<string>;
}

export interface ITTSProvider {
  readonly providerName: string;

  /** Synthesize text to streaming raw PCM audio chunks */
  synthesize(
    text: string,
    voiceId: string,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<Buffer>;
}

/**
 * Top-level AI voice session orchestrator coordinating STT, LLM, and TTS
 * for an active call session.
 */
export interface IVoiceAIAdapter {
  readonly isRunning: boolean;

  /** Start conversational agent session for call */
  startSession(
    callId: string,
    audioInbound: Readable,
    audioOutbound: Writable,
    config: VoiceAgentConfig
  ): Promise<void>;

  /** Terminate conversational session */
  stopSession(): Promise<void>;

  /** Force interruption of current agent speech */
  interrupt(): void;

  on(event: 'user_transcript', listener: (transcript: STTTranscriptEvent) => void): this;
  on(event: 'agent_response', listener: (text: string) => void): this;
  on(event: 'interrupted', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}
