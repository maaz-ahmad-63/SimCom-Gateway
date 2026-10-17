import fs from 'node:fs';
import { PcmFormat } from '../diagnostics/pcm-tools.js';
import {
  CARTESIA_RAW_SAMPLE_RATES,
  DEFAULT_LLM_KEY,
  DEFAULT_STT_KEY,
  DEFAULT_TTS_KEY,
  LLM_CATALOG,
  openAiCompatibleSpec,
  OpenAiCompatibleSpec,
  resolveLlmKey,
  STT_CATALOG,
  SttEntry,
  TTS_CATALOG,
} from './catalog.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js';

export type AutoHandle = 'off' | 'inbound' | 'outbound' | 'all';

export interface AiConfig {
  /** AI_ENABLED. Everything below is inert unless this is true AND the config is usable. */
  enabled: boolean;
  /** Which calls get an AI agent without being armed by hand. Default 'off'. */
  autoHandle: AutoHandle;
  language: string;
  stt: { key: string; entry: SttEntry; keyterms: string[] };
  llm: { key: string; spec: OpenAiCompatibleSpec | null };
  tts: { key: string; voice: string };
  systemPrompt: string;
  greeting: string | null;
  timeoutsMs: { stt: number; llmFirstToken: number; llmTotal: number; tts: number };
  maxRetries: number;
  limits: {
    maxHistoryMessages: number;
    maxResponseChars: number;
    maxConsecutiveFailures: number;
    maxLlmTokens: number | null;
    /** Simultaneous text-to-speech requests to one provider (AI_TTS_CONCURRENCY). 1 never trips a provider's limit. */
    ttsConcurrency: number;
  };
  /**
   * The PCM format used on the gateway side, or null when AI_AUDIO_SAMPLE_RATE is unset. Never
   * defaulted: the 8 kHz documented by SIMCom is not a verified property of this modem's stream.
   */
  audio: {
    format: PcmFormat | null;
    inboundVerified: boolean;
    outboundVerified: boolean;
  };
  vad: {
    rmsThreshold: number;
    minSpeechMs: number;
    minSilenceMs: number;
    maxUtteranceMs: number;
    preRollMs: number;
  };
  utterance: { minDurationMs: number; skipUnlikelySpeech: boolean };
  bargeIn: { enabled: boolean };
  /**
   * Half-duplex turn-taking: while the agent is speaking (plus a short guard afterwards) caller audio is
   * discarded instead of transcribed, so the agent never answers its own voice coming back through the
   * caller's phone. Barge-in needs this off AND real evidence that simultaneous capture/playback is clean.
   */
  halfDuplex: boolean;
  playbackGuardMs: number;
  /** Let the agent's END_CALL (or a failure policy) hang up. Default false: it only raises an event. */
  allowAgentHangup: boolean;
  logTranscripts: boolean;
  /**
   * Hands-free operation. Every switch is OFF by default; automatic replies additionally refuse to run
   * unless the readiness check passes (which needs both audio paths confirmed by the operator).
   */
  automation: {
    /** Answer incoming calls after `autoAnswerRings` rings. */
    autoAnswer: boolean;
    autoAnswerRings: number;
    /** Send the (explicit, documented) USB audio activation when an eligible call becomes ACTIVE. */
    autoActivateUsbAudio: boolean;
    /** Let the agent speak without the operator enabling replies per call. */
    autoReplies: boolean;
    /** The AI detaches from a call after this long (cost bound). The call itself is left alone. */
    maxCallSeconds: number;
    /** "Are you still there?" prompts, then a goodbye, when the caller goes quiet (replies only). */
    idleFollowUps: boolean;
    /** After the agent gives up on repeated provider failures, it may try one turn again after this long. */
    recoveryCooldownMs: number;
  };
  /** Names of the environment variables that hold the keys the selected providers need. */
  requiredKeyEnv: string[];
}

export interface AiConfigResult {
  config: AiConfig;
  errors: string[];
  warnings: string[];
  /** enabled and no errors. Only then may a full (replying) AI agent start. */
  usable: boolean;
  /** `errors` without the "key not set" ones: problems with the selection itself. */
  selectionErrors: string[];
  /** Credential variable names the selected providers need that have no value. Names only. */
  missingKeys: string[];
  /** The credential the selected STT provider needs. */
  sttKeyEnv: string | null;
  /**
   * enabled, the selection is valid and the STT key is present. Enough to transcribe passively
   * (no LLM, no TTS, nothing sent to the caller), so the LLM and TTS keys are not required.
   */
  passiveUsable: boolean;
}

type Env = Record<string, string | undefined>;

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function bool(env: Env, name: string, fallback: boolean, errors: string[]): boolean {
  const raw = text(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  errors.push(`${name} must be true or false (got a value that is neither)`);
  return fallback;
}

function num(env: Env, name: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${name} must be a number between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

/**
 * Read and validate the AI settings. Never throws and never needs the network: a bad AI setting
 * disables the AI feature and is reported, it must not stop the gateway.
 */
export function loadAiConfig(env: Env = process.env): AiConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const enabled = bool(env, 'AI_ENABLED', false, errors);
  const language = text(env, 'AI_LANGUAGE') ?? 'en';

  const autoRaw = (text(env, 'AI_AUTO_HANDLE') ?? 'off').toLowerCase();
  const autoHandle: AutoHandle = (['off', 'inbound', 'outbound', 'all'] as const).includes(autoRaw as AutoHandle)
    ? (autoRaw as AutoHandle)
    : 'off';
  if (autoHandle !== autoRaw) errors.push("AI_AUTO_HANDLE must be one of: off, inbound, outbound, all");

  // --- providers -----------------------------------------------------------
  const sttKey = (text(env, 'AI_STT') ?? DEFAULT_STT_KEY).toLowerCase();
  const sttEntry = STT_CATALOG[sttKey] ?? STT_CATALOG[DEFAULT_STT_KEY];
  if (!(sttKey in STT_CATALOG)) {
    errors.push(`AI_STT '${sttKey}' is not a known STT slug (known: ${Object.keys(STT_CATALOG).join(', ')})`);
  } else if (!sttEntry.implemented) {
    errors.push(`AI_STT '${sttKey}' (${sttEntry.provider}) is not ported to the gateway yet; use nova-3 or groq_whisper`);
  }

  const llmRequested = text(env, 'AI_LLM') ?? DEFAULT_LLM_KEY;
  const llmKey = resolveLlmKey(llmRequested);
  let llmSpec: OpenAiCompatibleSpec | null = null;
  if (!llmKey) {
    errors.push(`AI_LLM '${llmRequested}' is not a known LLM slug (known: ${Object.keys(LLM_CATALOG).join(', ')})`);
  } else {
    try {
      llmSpec = openAiCompatibleSpec(LLM_CATALOG[llmKey], env);
      if (!llmSpec) errors.push(`AI_LLM '${llmKey}' (${LLM_CATALOG[llmKey].family}) is not ported to the gateway yet`);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  const ttsKey = (text(env, 'AI_TTS') ?? DEFAULT_TTS_KEY).toLowerCase();
  const ttsEntry = TTS_CATALOG[ttsKey];
  let voice = text(env, 'AI_TTS_VOICE') ?? ttsEntry?.defaultVoice ?? '';
  if (!ttsEntry) {
    errors.push(`AI_TTS '${ttsKey}' is not a known TTS slug (known: ${Object.keys(TTS_CATALOG).join(', ')})`);
  } else if (!ttsEntry.implemented) {
    errors.push(`AI_TTS '${ttsKey}' is not ported to the gateway yet; use cartesia or deepgram`);
  } else if (ttsKey === 'deepgram' && !voice.startsWith('aura-')) {
    errors.push(
      `AI_TTS=deepgram needs an Aura voice in AI_TTS_VOICE (for example aura-asteria-en); the source default '${voice}' uses Deepgram's v2 streaming protocol, which is not ported`
    );
  }

  // --- credentials: names only, never values -------------------------------
  const requiredKeyEnv = new Set<string>();
  if (sttEntry.provider === 'deepgram') requiredKeyEnv.add('DEEPGRAM_API_KEY');
  if (sttEntry.provider === 'groq') requiredKeyEnv.add('GROQ_API_KEY');
  if (llmSpec) requiredKeyEnv.add(llmSpec.apiKeyEnv);
  if (ttsKey === 'deepgram') requiredKeyEnv.add('DEEPGRAM_API_KEY');
  if (ttsKey === 'cartesia') requiredKeyEnv.add('CARTESIA_API_KEY');
  if (enabled) {
    for (const name of requiredKeyEnv) {
      if (!text(env, name)) errors.push(`${name} is required by the selected providers but is not set`);
    }
  }

  // --- audio format: explicit only -----------------------------------------
  const rateRaw = text(env, 'AI_AUDIO_SAMPLE_RATE');
  let format: PcmFormat | null = null;
  if (rateRaw !== undefined) {
    const rate = Number(rateRaw);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) {
      errors.push('AI_AUDIO_SAMPLE_RATE must be an integer between 8000 and 48000');
    } else {
      format = { sampleRate: rate, channels: 1, bitDepth: 16, endianness: 'little-endian' };
      if (ttsKey === 'cartesia' && !CARTESIA_RAW_SAMPLE_RATES.includes(rate)) {
        errors.push(`AI_AUDIO_SAMPLE_RATE ${rate} is not a raw rate Cartesia supports (${CARTESIA_RAW_SAMPLE_RATES.join(', ')})`);
      }
    }
  } else if (enabled) {
    warnings.push('AI_AUDIO_SAMPLE_RATE is not set: the AI loop works offline, but live-call handling stays blocked until the verified rate is configured');
  }
  const bits = text(env, 'AI_AUDIO_BIT_DEPTH');
  const channels = text(env, 'AI_AUDIO_CHANNELS');
  const endian = text(env, 'AI_AUDIO_ENDIANNESS');
  if ((bits && bits !== '16') || (channels && channels !== '1') || (endian && endian !== 'little')) {
    errors.push('Only 16-bit, mono, little-endian PCM is implemented (AI_AUDIO_BIT_DEPTH=16, AI_AUDIO_CHANNELS=1, AI_AUDIO_ENDIANNESS=little)');
  }

  // --- prompt --------------------------------------------------------------
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const promptFile = text(env, 'AI_SYSTEM_PROMPT_FILE');
  if (promptFile) {
    try {
      systemPrompt = fs.readFileSync(promptFile, 'utf8').trim();
      if (!systemPrompt) errors.push('AI_SYSTEM_PROMPT_FILE is empty');
    } catch {
      errors.push('AI_SYSTEM_PROMPT_FILE could not be read');
    }
  }
  const instructions = text(env, 'AI_SYSTEM_INSTRUCTIONS');
  if (instructions) systemPrompt = `${instructions}\n\n${systemPrompt}`;

  const config: AiConfig = {
    enabled,
    autoHandle,
    language,
    stt: {
      key: sttKey,
      entry: sttEntry,
      keyterms: (text(env, 'AI_STT_KEYTERMS') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    },
    llm: { key: llmKey ?? llmRequested, spec: llmSpec },
    tts: { key: ttsKey, voice },
    systemPrompt,
    greeting: text(env, 'AI_GREETING') ?? null,
    timeoutsMs: {
      stt: num(env, 'AI_STT_TIMEOUT_MS', 8000, 500, 60000, errors),
      llmFirstToken: num(env, 'AI_LLM_FIRST_TOKEN_TIMEOUT_MS', 8000, 500, 60000, errors),
      llmTotal: num(env, 'AI_LLM_TOTAL_TIMEOUT_MS', 30000, 1000, 120000, errors),
      tts: num(env, 'AI_TTS_TIMEOUT_MS', 8000, 500, 60000, errors),
    },
    maxRetries: num(env, 'AI_MAX_RETRIES', 1, 0, 3, errors),
    limits: {
      maxHistoryMessages: num(env, 'AI_MAX_HISTORY_MESSAGES', 20, 2, 200, errors),
      maxResponseChars: num(env, 'AI_MAX_RESPONSE_CHARS', 600, 50, 5000, errors),
      maxConsecutiveFailures: num(env, 'AI_MAX_CONSECUTIVE_FAILURES', 3, 1, 20, errors),
      maxLlmTokens: text(env, 'AI_LLM_MAX_TOKENS') ? num(env, 'AI_LLM_MAX_TOKENS', 300, 16, 4096, errors) : null,
      ttsConcurrency: Math.floor(num(env, 'AI_TTS_CONCURRENCY', 1, 1, 4, errors)),
    },
    audio: {
      format,
      inboundVerified: bool(env, 'AI_AUDIO_INBOUND_VERIFIED', false, errors),
      outboundVerified: bool(env, 'AI_AUDIO_OUTBOUND_VERIFIED', false, errors),
    },
    vad: {
      rmsThreshold: num(env, 'AI_VAD_RMS_THRESHOLD', 0.003, 0.0005, 0.5, errors),
      minSpeechMs: num(env, 'AI_VAD_MIN_SPEECH_MS', 200, 20, 2000, errors),
      // The source waits 1.0 s (max 3.0 s) after the caller stops before it answers.
      minSilenceMs: num(env, 'AI_VAD_MIN_SILENCE_MS', 1000, 100, 5000, errors),
      maxUtteranceMs: num(env, 'AI_VAD_MAX_UTTERANCE_MS', 15000, 1000, 60000, errors),
      preRollMs: num(env, 'AI_VAD_PREROLL_MS', 200, 0, 1000, errors),
    },
    utterance: {
      minDurationMs: num(env, 'AI_MIN_UTTERANCE_MS', 300, 50, 5000, errors),
      skipUnlikelySpeech: bool(env, 'AI_SKIP_UNLIKELY_SPEECH', false, errors),
    },
    bargeIn: { enabled: bool(env, 'AI_BARGE_IN', true, errors) },
    halfDuplex: bool(env, 'AI_HALF_DUPLEX', true, errors),
    playbackGuardMs: num(env, 'AI_PLAYBACK_GUARD_MS', 500, 0, 3000, errors),
    allowAgentHangup: bool(env, 'AI_ALLOW_AGENT_HANGUP', false, errors),
    logTranscripts: bool(env, 'AI_LOG_TRANSCRIPTS', false, errors),
    automation: {
      autoAnswer: bool(env, 'AI_AUTO_ANSWER', false, errors),
      autoAnswerRings: num(env, 'AI_AUTO_ANSWER_RINGS', 2, 1, 10, errors),
      autoActivateUsbAudio: bool(env, 'AI_AUTO_ACTIVATE_USB_AUDIO', false, errors),
      autoReplies: bool(env, 'AI_AUTO_REPLIES', false, errors),
      maxCallSeconds: num(env, 'AI_MAX_CALL_SECONDS', 900, 30, 3600, errors),
      idleFollowUps: bool(env, 'AI_IDLE_FOLLOWUPS', true, errors),
      recoveryCooldownMs: num(env, 'AI_RECOVERY_COOLDOWN_MS', 15000, 1000, 120000, errors),
    },
    requiredKeyEnv: [...requiredKeyEnv],
  };

  // While AI is off, provider details are irrelevant and must not read as problems; only a malformed
  // AI_ENABLED itself is worth reporting.
  const reported = enabled ? errors : errors.filter((e) => e.startsWith('AI_ENABLED'));
  const keyErrorPattern = /is required by the selected providers but is not set$/;
  const selectionErrors = reported.filter((e) => !keyErrorPattern.test(e));
  const missingKeys = [...requiredKeyEnv].filter((name) => !text(env, name));
  const sttKeyEnv = sttEntry.provider === 'deepgram' ? 'DEEPGRAM_API_KEY' : sttEntry.provider === 'groq' ? 'GROQ_API_KEY' : null;
  return {
    config,
    errors: reported,
    warnings: enabled ? warnings : [],
    usable: enabled && reported.length === 0,
    selectionErrors,
    missingKeys: enabled ? missingKeys : [],
    sttKeyEnv,
    passiveUsable: enabled && selectionErrors.length === 0 && sttKeyEnv !== null && !missingKeys.includes(sttKeyEnv),
  };
}

/** Secret values the selected providers need, read at call time so nothing is cached in config. */
export function readProviderKey(env: Env, name: string): string | undefined {
  return text(env, name);
}

export function describeConfig(config: AiConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    autoHandle: config.autoHandle,
    language: config.language,
    stt: config.stt.key,
    llm: config.llm.key,
    tts: `${config.tts.key}/${config.tts.voice}`,
    audioFormat: config.audio.format,
    inboundVerified: config.audio.inboundVerified,
    outboundVerified: config.audio.outboundVerified,
    allowAgentHangup: config.allowAgentHangup,
    logTranscripts: config.logTranscripts,
    automation: config.automation,
    requiredKeyEnv: config.requiredKeyEnv,
  };
}
