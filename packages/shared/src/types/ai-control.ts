/**
 * Contract between the gateway's AI control-center API and the dashboard. Nothing here carries a
 * secret: credentials are only ever described by their source and status, never by value.
 */

/** The eight pipeline stages the live inspector reports, in the order a caller turn passes through them. */
export type AiInspectorStage =
  | 'pcm-capture'
  | 'pcm-validation'
  | 'stt-submit'
  | 'stt-result'
  | 'llm-request'
  | 'llm-response'
  | 'tts-generated'
  | 'playback';

export const AI_INSPECTOR_STAGES: readonly AiInspectorStage[] = [
  'pcm-capture',
  'pcm-validation',
  'stt-submit',
  'stt-result',
  'llm-request',
  'llm-response',
  'tts-generated',
  'playback',
];

export type AiStageStatus = 'ok' | 'skipped' | 'failed' | 'cancelled' | 'not-run';

export interface AiInspectorEvent {
  /** Monotonic per gateway process; lets a client drop duplicates after a reconnect. */
  seq: number;
  callId: string;
  /** Groups the stages of one caller utterance. Null for call-level events. */
  turnId: string | null;
  timestamp: string;
  /** A pipeline stage, or a call-level marker. */
  stage: AiInspectorStage | 'call';
  status: AiStageStatus;
  latencyMs?: number | null;
  /** Human-readable reason, always set for failed/skipped/cancelled. Never contains credentials. */
  detail?: string;
  /** Small numeric/text facts (bytes, rms, chars, tokens). Never audio, never keys. */
  data?: Record<string, number | string | boolean | null>;
  /** Recognized/spoken text. Present only while the operator has turned transcript display on. */
  text?: string;
  role?: 'caller' | 'agent';
}

export type AiMode = 'off' | 'passive' | 'active';

export type AiCredentialSource = 'env' | 'stored' | 'missing';
export type AiCredentialCheck = 'not-checked' | 'ok' | 'invalid' | 'unreachable';

export interface AiCredentialStatus {
  /** Environment variable name that holds the key, e.g. DEEPGRAM_API_KEY. */
  name: string;
  provider: string;
  /** Used by the currently selected providers. */
  requiredBySelection: boolean;
  source: AiCredentialSource;
  /** Last four characters only, and only for stored keys. */
  masked: string | null;
  /** Result of the last operator-triggered validation, kept apart from presence. */
  lastCheck: AiCredentialCheck;
  lastCheckedAt: string | null;
  lastCheckDetail: string | null;
}

export interface AiCatalogOption {
  key: string;
  label: string;
  provider: string;
  model: string | null;
  implemented: boolean;
  /** Why it cannot be chosen yet (not ported). */
  unavailableReason: string | null;
  /** STT only: whether partial transcripts are produced while the caller is still talking. */
  streaming?: boolean;
  /** LLM only: parameters this gateway actually sends. */
  supportedParams?: string[];
  /** LLM only: parameters the gateway sets for this model and the operator cannot change. */
  fixedParams?: Record<string, string | number | boolean>;
  /** TTS only. */
  voices?: Array<{ id: string; label: string }>;
  /** TTS only: raw sample rates the provider can return. */
  sampleRates?: number[];
  priceNote: string | null;
}

export interface AiCatalogResponse {
  stt: AiCatalogOption[];
  llm: AiCatalogOption[];
  tts: AiCatalogOption[];
  languages: string[];
}

export interface AiAgentProfile {
  name: string;
  /** Operator instructions placed before the built-in voice-call rules. */
  instructions: string;
  greeting: string;
  language: string;
  /** Whether the agent is allowed to run at all. Off keeps every AI path inert. */
  enabled: boolean;
  allowHangup: boolean;
}

export interface AiAttestationView {
  confirmed: boolean;
  confirmedAt: string | null;
  /** What the operator pointed at as evidence. */
  note: string | null;
  /** Source of the effective flag: stored via dashboard, environment, or none. */
  source: 'stored' | 'env' | 'none';
}

export interface AiSettingsView {
  mode: AiMode;
  stt: string;
  llm: string;
  tts: string;
  ttsVoice: string;
  agent: AiAgentProfile;
  /** Show recognized/spoken text in the dashboard and keep it in the turn log. Default false. */
  showTranscripts: boolean;
  /** Keep a bounded local WAV of what the AI heard. Default false. */
  diagnosticRecording: boolean;
  audioSampleRate: number | null;
  autoHandle: 'off' | 'inbound' | 'outbound' | 'all';
  /** Hands-free switches. All default off; automatic replies cannot be turned on until both audio paths are confirmed. */
  automation: {
    autoAnswer: boolean;
    autoAnswerRings: number;
    autoActivateUsbAudio: boolean;
    autoReplies: boolean;
    maxCallSeconds: number;
    idleFollowUps: boolean;
  };
  params: {
    maxTokens: number | null;
    sttTimeoutMs: number;
    llmFirstTokenTimeoutMs: number;
    llmTotalTimeoutMs: number;
    ttsTimeoutMs: number;
    maxResponseChars: number;
    vadMinSilenceMs: number;
    /** Frame RMS (fraction of full scale) above which audio counts as possible speech. */
    vadRmsThreshold: number;
  };
  attestations: {
    inbound: AiAttestationView;
    outbound: AiAttestationView;
  };
  /** Problems with the effective configuration (never contains values of secrets). */
  configErrors: string[];
  configWarnings: string[];
  /** True only if secrets can be stored on this gateway (AI_SECRETS_MASTER_KEY is set). */
  secretStorageAvailable: boolean;
  updatedAt: string | null;
}

export type AiReadinessLevel = 'passive' | 'active';

export interface AiReadinessCheckView {
  name: string;
  status: 'pass' | 'fail' | 'unverified';
  detail: string;
}

export interface AiReadinessView {
  /** Passive transcription may start. */
  passiveOk: boolean;
  /** An AI reply may be spoken to the caller. Equals the existing `ok`. */
  ok: boolean;
  checkedAt: string;
  checks: AiReadinessCheckView[];
  blockers: string[];
  passiveBlockers: string[];
  mode: AiMode;
  /** Mock/simulated hardware can never make the agent ready. */
  simulatedHardware: boolean;
}

export interface AiUsageTotals {
  calls: number;
  turns: number;
  sttSeconds: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  ttsChars: number;
  failures: number;
  /** Estimated cost in USD from the source price catalog; null where any needed price is unknown. */
  estimatedCostUsd: number | null;
  costNote: string;
}

export interface AiTurnLogEntry {
  id: number;
  callId: string;
  at: string;
  status: string;
  reason: string | null;
  sttMs: number | null;
  llmFirstTokenMs: number | null;
  ttsFirstMs: number | null;
  totalMs: number | null;
  utteranceMs: number | null;
  sttSeconds: number;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  ttsChars: number;
  /** Only present while transcripts are enabled and were stored. */
  transcript: string | null;
  reply: string | null;
}

export interface AiAudioMeter {
  receivedBytes: number;
  receivedSeconds: number;
  submittedSeconds: number;
  utterances: number;
  lastFrameAgoMs: number | null;
  /** Longest gap between inbound frames in the last ~10 s. */
  maxGapMs: number;
  rms: number;
  peak: number;
  silentForMs: number | null;
  /** Audio delivered faster than real time since the first frame, in ms (0 when none): a backlog means replies would answer old speech. */
  backlogMs: number;
  /** Sample rate implied by how many bytes actually arrived per second since the first frame; null until ~2 s of audio. */
  observedSampleRate: number | null;
  /** The rate the AI session assumes (AI_AUDIO_SAMPLE_RATE). A large mismatch means the audio is mislabeled. */
  expectedSampleRate: number;
}

/** Where one call's AI pipeline is right now. 'stopped' = conversation mode is off for the call (or the session gave up). */
export type AiConversationPhase = 'stopped' | 'listening' | 'transcribing' | 'generating' | 'speaking';

export interface AiConversationView {
  /** The operator turned conversation on for THIS call. Off by default; never carries over to the next call. */
  enabled: boolean;
  phase: AiConversationPhase;
  /** ISO time the current phase began. */
  phaseSince: string;
  /** Half-duplex: caller audio is ignored while the agent speaks (and briefly after), so it cannot hear itself. */
  halfDuplex: boolean;
  /** Caller audio discarded because the agent was speaking, in seconds. */
  ignoredWhileSpeakingSeconds: number;
  /** How long the caller must pause before a turn ends (the endpointing delay); every reply waits at least this long. */
  endpointSilenceMs: number;
  /** Stage timings of the last finished turn, in ms; null where a stage did not run. */
  lastTurn: {
    status: string;
    reason: string | null;
    sttMs: number | null;
    llmFirstTokenMs: number | null;
    ttsFirstMs: number | null;
    playMs: number | null;
    /** End of the caller's pause to the first reply audio being written: what the caller waits through. */
    firstAudioMs: number | null;
    /** Includes the time spent speaking, so it grows with the length of the reply; it is not a latency. */
    totalMs: number;
    /** Frames written late during playback: the modem may have been starved and the caller may have heard gaps. */
    lateFrames: number;
  } | null;
  /** The most recent stage error (provider messages are already free of credentials). */
  lastError: { stage: string; message: string; at: string } | null;
}

export interface AiConversationReadiness {
  /** Conversation mode may be switched on for the current call right now. */
  allowed: boolean;
  blockers: string[];
  /** Already on for the current call. */
  active: boolean;
}

export interface AiSessionView {
  conversation: AiConversationView;
  callId: string;
  attachedAt: string;
  mode: AiMode;
  busy: boolean;
  degraded: boolean;
  isSimulated: boolean;
  audio: AiAudioMeter;
  totals: {
    turns: number;
    completed: number;
    skipped: number;
    cancelled: number;
    failed: number;
    sttAudioSeconds: number;
    ttsChars: number;
    llmPromptTokens: number;
    llmCompletionTokens: number;
  };
}

/** Whether the one-shot "generate and play a test response" action may run right now, and if not, why. */
export interface AiTestResponseReadiness {
  allowed: boolean;
  blockers: string[];
  /** Age of the transcript the response would answer; null if none. The words themselves are never included. */
  transcriptAgeSeconds: number | null;
  /** PCM format the response would be played in. */
  format: string | null;
  /** The last test result for the current call, if any. */
  last: AiTestResponseResult | null;
}

export type AiTestStageStatus = 'ok' | 'failed' | 'cancelled' | 'not-run';

export interface AiTestStage {
  status: AiTestStageStatus;
  ms: number | null;
  /** Reason, shown as-is. Never contains credentials. */
  error: string | null;
}

/**
 * Outcome of one operator-triggered test response. The four stages are reported separately. Nothing here
 * says the remote party heard anything: bytes accepted by the port are not evidence of audibility.
 */
export interface AiTestResponseResult {
  callId: string;
  startedAt: string;
  mock: boolean;
  transcriptAgeSeconds: number;
  llm: AiTestStage & { chars: number | null; promptTokens: number | null; completionTokens: number | null };
  tts: AiTestStage & { chars: number | null; bytes: number | null; seconds: number | null };
  /** Audio was accepted by the audio port (at least some bytes written). */
  playbackSubmission: AiTestStage & { bytesWritten: number | null; bytesTotal: number | null };
  /** The gateway wrote all of the audio, in real time, without the call ending or being cut. */
  playbackCompletion: AiTestStage & { stoppedBy: string | null };
  format: string;
  /** Always 'unknown': only a person on the other end can confirm it was audible. */
  heardByRemote: 'unknown';
  note: string;
}
