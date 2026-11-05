import fs from 'node:fs';
import { PcmFormat } from '../diagnostics/pcm-tools.js';
import { DEFAULT_LLM_KEY, DEFAULT_STT_KEY, DEFAULT_TTS_KEY, OpenAiCompatibleSpec } from './catalog.js';
import { activeRegistry } from './registry/active.js';
import { buildLlmSpec } from './registry/registry.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js';

/** The speech-to-text model in use, as the providers and the call log need it (resolved from the model registry). */
export interface SttSelection {
  /** The vendor name (deepgram, soniox, groq ...). */
  provider: string;
  providerId: string;
  /** The wire protocol that serves it; null when none does. */
  protocol: string | null;
  model: string | null;
  implemented: boolean;
  params: { language?: 'multi' };
}

export type AutoHandle = 'off' | 'inbound' | 'outbound' | 'all';

export interface DirectionAgent {
  instructions: string | null;
  greeting: string | null;
}

export interface AiConfig {
  /** AI_ENABLED. Everything below is inert unless this is true AND the config is usable. */
  enabled: boolean;
  /** Which calls get an AI agent without being armed by hand. Default 'off'. */
  autoHandle: AutoHandle;
  language: string;
  stt: { key: string; entry: SttSelection; keyterms: string[] };
  llm: { key: string; spec: OpenAiCompatibleSpec | null };
  /** `model`: the operator's choice of the provider's model, or null for the provider's default. */
  tts: { key: string; voice: string; model: string | null };
  systemPrompt: string;
  greeting: string | null;
  /** The built-in rules (or AI_SYSTEM_PROMPT_FILE) with no operator instructions in front: what `systemPrompt` is built on. */
  promptBody: string;
  /** AI_SYSTEM_INSTRUCTIONS: the instructions every call uses unless its own direction sets some. */
  sharedInstructions: string | null;
  /** Instructions and greeting for one kind of call only (see agentFor). Unset means that kind of call uses the shared ones. */
  directions: { inbound: DirectionAgent; outbound: DirectionAgent };
  timeoutsMs: { stt: number; llmFirstToken: number; llmTotal: number; tts: number };
  maxRetries: number;
  limits: {
    maxHistoryMessages: number;
    maxResponseChars: number;
    maxConsecutiveFailures: number;
    maxLlmTokens: number | null;
    /** The first sentence of a reply is released for speech at this length (AI_FIRST_SENTENCE_MIN_CHARS, default 24 like later sentences). */
    firstSentenceMinChars: number;
    /** The first chunk of a reply may end at a comma/colon once it is this long, so speech starts before the sentence ends. 0 = sentence ends only. */
    firstClauseMinChars: number;
    /** Simultaneous text-to-speech requests to one provider (AI_TTS_CONCURRENCY). 1 never trips a provider's limit. */
    ttsConcurrency: number;
  };
  /**
   * The PCM format used on the gateway side, or null when AI_AUDIO_SAMPLE_RATE is unset. Never
   * defaulted: the 8 kHz documented by SIMCom is not a verified property of this modem's stream.
   */
  audio: {
    format: PcmFormat | null;
    /** A person's diagnostic confirmation (manual override). Only consulted when automatic verification is switched off. */
    inboundVerified: boolean;
    outboundVerified: boolean;
    /** Automatic call-audio verification (AI_AUDIO_AUTO_VERIFY, default on): calls are judged from their own evidence. */
    autoVerify: boolean;
  };
  vad: {
    rmsThreshold: number;
    minSpeechMs: number;
    /** The silence that ends a caller turn; with `adaptive` this is the ceiling. */
    minSilenceMs: number;
    maxUtteranceMs: number;
    preRollMs: number;
    /** Adapt the silence wait and loudness threshold to this call (AI_VAD_ADAPTIVE). */
    adaptive: boolean;
    /** Lowest wait adaptation may reach (AI_VAD_MIN_SILENCE_FLOOR_MS). */
    minSilenceFloorMs: number;
    /** Silence after which the audio so far is transcribed speculatively; 0 disables (AI_VAD_SOFT_SILENCE_MS). */
    softSilenceMs: number;
    /** Reuse a speculative transcript at the real end of the turn instead of transcribing again (AI_SPECULATIVE_STT). */
    speculativeStt: boolean;
    /**
     * Answer as soon as a speculative transcript reads like a finished sentence, without waiting out the rest of the
     * silence (AI_EARLY_COMMIT). Off by default: a caller who pauses after a full sentence is then answered early.
     */
    earlyCommit: boolean;
    /** A quiet gap this short does not restart the minimum-speech count at the start of an utterance (AI_VAD_ONSET_HANGOVER_MS). */
    onsetHangoverMs: number;
    /**
     * Which detector decides what is speech (AI_VAD_ENGINE): 'energy' (frame loudness, the default) or 'silero'
     * (ONNX model; needs onnxruntime-node and a model file, otherwise the gateway reports it and uses 'energy').
     */
    engine: 'energy' | 'silero';
    /** Silero: path of silero_vad.onnx (AI_VAD_SILERO_MODEL) and the speech probability that counts as speech (AI_VAD_SILERO_THRESHOLD, 0.5 like the source). */
    silero: { modelPath: string | null; threshold: number };
  };
  /**
   * Streaming speech-to-text (AI_STT_STREAMING). Off by default. When on, caller audio goes to Deepgram over a
   * WebSocket while the caller is still speaking; only FINAL text, at the confirmed end of the utterance, is used,
   * and the batch provider chosen by AI_STT is the fallback for any stream that fails.
   */
  sttStreaming: { enabled: boolean; finalizeTimeoutMs: number; hedgeMs: number };
  utterance: { minDurationMs: number; skipUnlikelySpeech: boolean };
  bargeIn: {
    /** AI_BARGE_IN. Cancel the agent's reply when the caller starts talking. */
    enabled: boolean;
    /**
     * AI_BARGE_IN_WHILE_SPEAKING. Listen for the caller while the agent is talking (half-duplex otherwise discards that
     * audio unheard). Sustained speech well above the line's own echo level interrupts the agent.
     */
    whileSpeaking: boolean;
    /** Speech that must be sustained before it counts as an interruption (AI_BARGE_IN_MS). */
    minMs: number;
    /** How far above the echo level the caller must be (AI_BARGE_IN_ECHO_MULT). */
    echoMultiplier: number;
    /** Interruptions that produced no real speech before the detector switches itself off for the call. */
    maxFalseTriggers: number;
  };
  /** Playback scheduling (AI_PLAYBACK_LEAD_FRAMES, AI_PLAYBACK_PREROLL_MS). */
  playback: { leadFrames: number; prerollMs: number };
  /** Verified company knowledge (AI_KNOWLEDGE_DIR): retrieved per question, never pasted whole into the prompt. */
  knowledge: { dir: string | null; topK: number; maxChars: number };
  /** Rolling call notes (AI_CALL_NOTES): facts from turns that have scrolled out of the recent history. */
  /** callNotes: AI_CALL_NOTES. contactDetails: AI_CONTACT_DETAILS (the name and phone number the caller gave, tracked so they are not asked for again). */
  memory: { callNotes: boolean; contactDetails: boolean };
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
  // The providers and models come from the model registry (the built-in entries are the original catalog; a model added or
  // switched off on the AI page or in the registry JSON is seen here). An unknown, unported or switched-off choice is an error,
  // never replaced by another one.
  const registry = activeRegistry();
  const sttKey = (text(env, 'AI_STT') ?? DEFAULT_STT_KEY).toLowerCase();
  const sttFound = registry.stt(sttKey);
  const sttResolved = sttFound ?? registry.stt(DEFAULT_STT_KEY)!;
  if (!sttFound) {
    errors.push(`AI_STT '${sttKey}' is not a known STT slug (known: ${registry.sttKeys().join(', ')})`);
  } else if (!sttResolved.implemented) {
    errors.push(`AI_STT '${sttKey}' (${sttResolved.vendor}) is not ported to the gateway yet; use nova-3 or groq_whisper`);
  } else if (sttResolved.disabled) {
    errors.push(`AI_STT '${sttKey}' is switched off in the model registry`);
  }
  const sttEntry: SttSelection = {
    provider: sttResolved.vendor,
    providerId: sttResolved.providerId,
    protocol: sttResolved.protocol,
    model: sttResolved.model,
    implemented: sttResolved.implemented,
    params: sttResolved.params,
  };

  const llmRequested = text(env, 'AI_LLM') ?? DEFAULT_LLM_KEY;
  const llmKey = registry.resolveLlmKey(llmRequested);
  let llmSpec: OpenAiCompatibleSpec | null = null;
  if (!llmKey) {
    errors.push(`AI_LLM '${llmRequested}' is not a known LLM slug (known: ${registry.llmKeys().join(', ')})`);
  } else {
    const llmResolved = registry.llm(llmKey)!;
    try {
      llmSpec = buildLlmSpec(llmResolved, env);
      if (!llmSpec) errors.push(`AI_LLM '${llmKey}' (${llmResolved.family ?? llmResolved.vendor}) is not ported to the gateway yet`);
      else if (llmResolved.disabled) {
        errors.push(`AI_LLM '${llmKey}' is switched off in the model registry`);
        llmSpec = null;
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  const ttsKey = (text(env, 'AI_TTS') ?? DEFAULT_TTS_KEY).toLowerCase();
  const ttsEntry = registry.tts(ttsKey);
  let voice = text(env, 'AI_TTS_VOICE') ?? ttsEntry?.defaultVoice ?? '';
  if (!ttsEntry) {
    errors.push(`AI_TTS '${ttsKey}' is not a known TTS slug (known: ${registry.ttsKeys().join(', ')})`);
  } else if (!ttsEntry.implemented) {
    errors.push(`AI_TTS '${ttsKey}' is not ported to the gateway yet; use cartesia or deepgram`);
  } else if (ttsEntry.disabled) {
    errors.push(`AI_TTS '${ttsKey}' is switched off in the model registry`);
  } else if (ttsEntry.protocol === 'deepgram-tts' && !voice.startsWith('aura-')) {
    errors.push(
      `AI_TTS=${ttsKey} needs an Aura voice in AI_TTS_VOICE (for example aura-asteria-en); the source default '${voice}' uses Deepgram's v2 streaming protocol, which is not ported`
    );
  }

  // --- credentials: names only, never values -------------------------------
  const requiredKeyEnv = new Set<string>();
  if (sttResolved.keyEnv) requiredKeyEnv.add(sttResolved.keyEnv);
  if (llmSpec) requiredKeyEnv.add(llmSpec.apiKeyEnv);
  if (ttsEntry?.keyEnv) requiredKeyEnv.add(ttsEntry.keyEnv);

  // The model, when the operator chose one: it must be a model of the selected provider (an unsupported model is an error,
  // never passed to the provider and never replaced by a default).
  const ttsModelRaw = text(env, 'AI_TTS_MODEL') ?? null;
  const knownModels = ttsEntry && ttsEntry.models.length > 0 ? ttsEntry.models : undefined;
  let ttsModel: string | null = null;
  if (ttsModelRaw) {
    if (!knownModels) errors.push(`AI_TTS_MODEL '${ttsModelRaw}' cannot be used: '${ttsKey}' has no selectable model`);
    else if (!knownModels.includes(ttsModelRaw)) errors.push(`AI_TTS_MODEL '${ttsModelRaw}' is not a model of '${ttsKey}' (supported: ${knownModels.join(', ')})`);
    else ttsModel = ttsModelRaw;
  }
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
      errors.push(`AI_AUDIO_SAMPLE_RATE must be an integer between 8000 and 48000 (got ${rateRaw})`);
    } else {
      format = { sampleRate: rate, channels: 1, bitDepth: 16, endianness: 'little-endian' };
      const supported = ttsEntry && ttsEntry.sampleRates.length > 0 ? ttsEntry.sampleRates : undefined;
      if (ttsEntry?.implemented && supported && !supported.includes(rate)) {
        errors.push(`AI_AUDIO_SAMPLE_RATE ${rate} is not a raw rate ${ttsEntry.providerName ?? ttsKey} supports (${supported.join(', ')})`);
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
  const promptBody = systemPrompt;
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
    tts: { key: ttsKey, voice, model: ttsModel },
    systemPrompt,
    greeting: text(env, 'AI_GREETING') ?? null,
    promptBody,
    sharedInstructions: instructions ?? null,
    directions: {
      inbound: { instructions: text(env, 'AI_INBOUND_INSTRUCTIONS') ?? null, greeting: text(env, 'AI_INBOUND_GREETING') ?? null },
      outbound: { instructions: text(env, 'AI_OUTBOUND_INSTRUCTIONS') ?? null, greeting: text(env, 'AI_OUTBOUND_GREETING') ?? null },
    },
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
      // A spoken reply is a sentence or two; an uncapped model can run to a minute of speech.
      maxLlmTokens: text(env, 'AI_LLM_MAX_TOKENS') ? num(env, 'AI_LLM_MAX_TOKENS', 300, 16, 4096, errors) : 220,
      ttsConcurrency: Math.floor(num(env, 'AI_TTS_CONCURRENCY', 1, 1, 4, errors)),
      firstSentenceMinChars: Math.floor(num(env, 'AI_FIRST_SENTENCE_MIN_CHARS', 24, 4, 200, errors)),
      firstClauseMinChars: Math.floor(num(env, 'AI_FIRST_CLAUSE_MIN_CHARS', 32, 0, 200, errors)),
    },
    audio: {
      format,
      inboundVerified: bool(env, 'AI_AUDIO_INBOUND_VERIFIED', false, errors),
      outboundVerified: bool(env, 'AI_AUDIO_OUTBOUND_VERIFIED', false, errors),
      autoVerify: bool(env, 'AI_AUDIO_AUTO_VERIFY', true, errors),
    },
    vad: {
      rmsThreshold: num(env, 'AI_VAD_RMS_THRESHOLD', 0.003, 0.0005, 0.5, errors),
      minSpeechMs: num(env, 'AI_VAD_MIN_SPEECH_MS', 200, 20, 2000, errors),
      // The source waits 1.0 s (max 3.0 s) after the caller stops before it answers.
      minSilenceMs: num(env, 'AI_VAD_MIN_SILENCE_MS', 1000, 100, 5000, errors),
      maxUtteranceMs: num(env, 'AI_VAD_MAX_UTTERANCE_MS', 15000, 1000, 60000, errors),
      preRollMs: num(env, 'AI_VAD_PREROLL_MS', 200, 0, 1000, errors),
      // Off by default: the adaptive wait only ever saw pauses shorter than its own target, so it ratcheted down to its
      // floor and cut callers off mid-sentence. The wait is the stable AI_VAD_MIN_SILENCE_MS unless this is turned on.
      adaptive: bool(env, 'AI_VAD_ADAPTIVE', false, errors),
      minSilenceFloorMs: num(env, 'AI_VAD_MIN_SILENCE_FLOOR_MS', 450, 100, 3000, errors),
      softSilenceMs: num(env, 'AI_VAD_SOFT_SILENCE_MS', 350, 0, 3000, errors),
      speculativeStt: bool(env, 'AI_SPECULATIVE_STT', true, errors),
      earlyCommit: bool(env, 'AI_EARLY_COMMIT', false, errors),
      onsetHangoverMs: num(env, 'AI_VAD_ONSET_HANGOVER_MS', 100, 0, 500, errors),
      engine: ((): 'energy' | 'silero' => {
        const raw = (text(env, 'AI_VAD_ENGINE') ?? 'energy').toLowerCase();
        if (raw === 'energy' || raw === 'silero') return raw;
        errors.push("AI_VAD_ENGINE must be 'energy' or 'silero'");
        return 'energy';
      })(),
      silero: {
        modelPath: text(env, 'AI_VAD_SILERO_MODEL') ?? null,
        threshold: num(env, 'AI_VAD_SILERO_THRESHOLD', 0.5, 0.05, 0.95, errors),
      },
    },
    sttStreaming: {
      enabled: bool(env, 'AI_STT_STREAMING', false, errors),
      // How long the end of an utterance waits for Deepgram's final text before the batch provider takes over.
      finalizeTimeoutMs: num(env, 'AI_STT_STREAM_FINALIZE_MS', 1500, 200, 10000, errors),
      // If the stream has not answered this long after the utterance ended, the batch request starts too, instead of only after
      // the timeout. The stream still wins if it answers first. 0 turns it off.
      hedgeMs: num(env, 'AI_STT_STREAM_HEDGE_MS', 700, 0, 5000, errors),
    },
    utterance: {
      minDurationMs: num(env, 'AI_MIN_UTTERANCE_MS', 300, 50, 5000, errors),
      skipUnlikelySpeech: bool(env, 'AI_SKIP_UNLIKELY_SPEECH', false, errors),
    },
    bargeIn: {
      enabled: bool(env, 'AI_BARGE_IN', true, errors),
      whileSpeaking: bool(env, 'AI_BARGE_IN_WHILE_SPEAKING', true, errors),
      minMs: num(env, 'AI_BARGE_IN_MS', 300, 100, 2000, errors),
      echoMultiplier: num(env, 'AI_BARGE_IN_ECHO_MULT', 2.5, 1, 20, errors),
      maxFalseTriggers: Math.floor(num(env, 'AI_BARGE_IN_MAX_FALSE', 2, 1, 20, errors)),
    },
    playback: {
      leadFrames: Math.floor(num(env, 'AI_PLAYBACK_LEAD_FRAMES', 2, 1, 8, errors)),
      prerollMs: num(env, 'AI_PLAYBACK_PREROLL_MS', 150, 0, 1000, errors),
    },
    knowledge: {
      dir: text(env, 'AI_KNOWLEDGE_DIR') ?? null,
      topK: Math.floor(num(env, 'AI_KNOWLEDGE_TOP_K', 3, 1, 10, errors)),
      maxChars: Math.floor(num(env, 'AI_KNOWLEDGE_MAX_CHARS', 1200, 200, 6000, errors)),
    },
    memory: { callNotes: bool(env, 'AI_CALL_NOTES', true, errors), contactDetails: bool(env, 'AI_CONTACT_DETAILS', true, errors) },
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
  const sttKeyEnv = sttResolved.keyEnv;
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
