import { z } from 'zod';
import { AiAgentProfile, AiCredentialCheck, AiCredentialSource, AiCredentialStatus, AiSettingsView } from '@sim-gateway/shared';
import { AiConfigResult, loadAiConfig } from './config.js';
import { activeRegistry } from './registry/active.js';
import { maskSecret, SecretCipher } from './secrets.js';

type Env = Record<string, string | undefined>;

/** The only credentials the operator can store. Anything else is rejected before it touches the database. */
export const CREDENTIAL_PROVIDERS: Record<string, string> = {
  DEEPGRAM_API_KEY: 'Deepgram',
  GROQ_API_KEY: 'Groq',
  OPENAI_API_KEY: 'OpenAI',
  TELNYX_API_KEY: 'Telnyx',
  CARTESIA_API_KEY: 'Cartesia',
  ELEVENLABS_API_KEY: 'ElevenLabs',
  GEMINI_API_KEY: 'Google Gemini',
  MURF_API_KEY: 'Murf',
  INWORLD_API_KEY: 'Inworld',
  SONIOX_API_KEY: 'Soniox',
};

/**
 * The credentials the operator can store: the built-in ones plus every credential name a provider in the model registry refers to
 * (a provider added on the AI Model Hub names its own, such as MYPROVIDER_API_KEY). Nothing else reaches the database.
 */
export function credentialProviders(): Record<string, string> {
  const all: Record<string, string> = { ...CREDENTIAL_PROVIDERS };
  for (const { name, label } of activeRegistry().credentialNames()) if (!(name in all)) all[name] = label;
  return all;
}

/** The per-direction agent settings, kept next to (not inside) the shared AiAgentProfile type. Empty or absent: use the shared value. */
export interface DirectionAgentFields {
  inboundInstructions?: string;
  inboundGreeting?: string;
  outboundInstructions?: string;
  outboundGreeting?: string;
}

export interface SettingsBackend {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
}

const SETTINGS_KEY = 'ai.settings';
const secretKey = (name: string) => `ai.secret.${name}`;
const checkKey = (name: string) => `ai.secret_check.${name}`;

const params = z
  .object({
    maxTokens: z.number().int().min(16).max(4096).nullable(),
    sttTimeoutMs: z.number().int().min(500).max(60000),
    llmFirstTokenTimeoutMs: z.number().int().min(500).max(60000),
    llmTotalTimeoutMs: z.number().int().min(1000).max(120000),
    ttsTimeoutMs: z.number().int().min(500).max(60000),
    maxResponseChars: z.number().int().min(50).max(5000),
    vadMinSilenceMs: z.number().int().min(100).max(5000),
    vadRmsThreshold: z.number().min(0.0005).max(0.5),
  })
  .partial()
  .strict();

const automation = z
  .object({
    autoAnswer: z.boolean(),
    autoAnswerRings: z.number().int().min(1).max(10),
    autoActivateUsbAudio: z.boolean(),
    autoReplies: z.boolean(),
    maxCallSeconds: z.number().int().min(30).max(3600),
    idleFollowUps: z.boolean(),
  })
  .partial()
  .strict();

const agent = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().max(8000),
    greeting: z.string().max(500),
    /** Instructions and greeting for one direction only. Empty: that direction uses the shared ones above. */
    inboundInstructions: z.string().max(8000),
    inboundGreeting: z.string().max(500),
    outboundInstructions: z.string().max(8000),
    outboundGreeting: z.string().max(500),
    enabled: z.boolean(),
    allowHangup: z.boolean(),
  })
  .partial()
  .strict();

/** What PUT /api/ai/settings accepts. Unknown fields are an error, not ignored. */
export const settingsPatchSchema = z
  .object({
    mode: z.enum(['off', 'passive']),
    stt: z.string().trim().min(1).max(64),
    llm: z.string().trim().min(1).max(100),
    tts: z.string().trim().min(1).max(64),
    ttsVoice: z.string().trim().min(1).max(100),
    /** The provider's model; null returns to the provider's default. Checked against the provider's model list on save. */
    ttsModel: z.string().trim().min(1).max(100).nullable(),
    language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'language must look like en or en-US'),
    showTranscripts: z.boolean(),
    /** Stream caller audio to Deepgram while they speak (the existing AI_STT_STREAMING switch, now settable here). */
    sttStreaming: z.boolean(),
    diagnosticRecording: z.boolean(),
    /** Verify call audio automatically (AI_AUDIO_AUTO_VERIFY). On unless switched off. */
    audioAutoVerify: z.boolean(),
    audioSampleRate: z.number().int().min(8000).max(48000).nullable(),
    autoHandle: z.enum(['off', 'inbound', 'outbound', 'all']),
    automation,
    agent,
    params,
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

interface StoredAttestation {
  confirmedAt: string;
  note: string;
  /** The gateway audio rate the confirmation was made at. Missing on confirmations saved before this was recorded. */
  sampleRate?: number | null;
}

/** One confirmation as the dashboard shows it: kept with its note and time even when it does not count at the current rate. */
export interface AttestationView {
  confirmed: boolean;
  confirmedAt: string | null;
  note: string | null;
  source: 'stored' | 'env' | 'none';
  /** The rate it was made at (null: not recorded, or set in .env). */
  sampleRate: number | null;
  /** A stored confirmation made at another sample rate: shown, but it does not count until re-verified or the rate is switched back. */
  stale: boolean;
  staleReason: string | null;
}

export type AiSettingsViewWithAudio = Omit<AiSettingsView, 'attestations' | 'agent'> & {
  agent: AiAgentProfile & DirectionAgentFields;
  attestations: { inbound: AttestationView; outbound: AttestationView };
  ttsModel: string | null;
  sttStreaming: boolean;
};

interface StoredSettings {
  mode?: 'off' | 'passive';
  stt?: string;
  llm?: string;
  tts?: string;
  ttsVoice?: string;
  ttsModel?: string;
  language?: string;
  showTranscripts?: boolean;
  sttStreaming?: boolean;
  diagnosticRecording?: boolean;
  audioAutoVerify?: boolean;
  audioSampleRate?: number;
  agent?: Partial<AiAgentProfile> & DirectionAgentFields;
  autoHandle?: 'off' | 'inbound' | 'outbound' | 'all';
  automation?: z.infer<typeof automation>;
  params?: z.infer<typeof params>;
  attestations?: { inbound?: StoredAttestation; outbound?: StoredAttestation };
  /** Proof that a real, non-simulated call produced a transcript from a live provider. */
  inboundEvidence?: { at: string; callId: string; chars: number; sampleRate?: number | null };
  updatedAt?: string;
}

export class SettingsError extends Error {
  constructor(message: string, readonly status = 400, readonly issues: string[] = []) {
    super(message);
    this.name = 'SettingsError';
  }
}

/**
 * Operator-editable AI settings and provider credentials, layered over the environment.
 * Precedence: a value saved from the dashboard wins over .env; clearing it falls back to .env.
 * Credentials are stored encrypted, decrypted only inside `effectiveEnv()` (server-side provider
 * construction), and never exposed through any method that feeds an API response.
 */
export class AiSettingsService {
  private readonly cipher: SecretCipher | null;
  /** Masks by stored blob, so status polling never re-runs the (deliberately slow) key derivation. */
  private readonly maskCache = new Map<string, string>();

  constructor(
    private readonly backend: SettingsBackend,
    private readonly baseEnv: Env,
    masterKey = baseEnv.AI_SECRETS_MASTER_KEY
  ) {
    const key = masterKey?.trim();
    this.cipher = key ? new SecretCipher(key) : null;
  }

  get secretStorageAvailable(): boolean {
    return this.cipher !== null;
  }

  // -- stored settings -----------------------------------------------------------------------

  getStored(): StoredSettings {
    const raw = this.backend.getSetting(SETTINGS_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as StoredSettings;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private save(next: StoredSettings): void {
    next.updatedAt = new Date().toISOString();
    this.backend.setSetting(SETTINGS_KEY, JSON.stringify(next));
  }

  /**
   * Validate and persist a partial update. Selection errors (unknown or not-ported provider, bad
   * voice, bad rate) reject the whole update and change nothing; a missing API key does not, because
   * saving a selection before storing its key is a normal order of operations.
   */
  update(rawPatch: unknown): StoredSettings {
    const parsed = settingsPatchSchema.safeParse(rawPatch);
    if (!parsed.success) {
      throw new SettingsError(
        'Invalid settings',
        400,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`)
      );
    }
    const patch = parsed.data;
    const current = this.getStored();
    const next: StoredSettings = { ...current };
    // A confirmation saved before the rate was recorded with it was made at the rate in force until now: stamp it with that rate
    // before the rate changes, so it keeps vouching only for the audio it was made with.
    if (patch.audioSampleRate !== undefined && patch.audioSampleRate !== (current.audioSampleRate ?? null)) {
      const previousRate = this.rateOf(current);
      if (current.attestations) {
        next.attestations = { ...current.attestations };
        for (const kind of ['inbound', 'outbound'] as const) {
          const record = next.attestations[kind];
          if (record && record.sampleRate === undefined) next.attestations[kind] = { ...record, sampleRate: previousRate };
        }
      }
      if (current.inboundEvidence && current.inboundEvidence.sampleRate === undefined) next.inboundEvidence = { ...current.inboundEvidence, sampleRate: previousRate };
    }

    for (const key of ['mode', 'stt', 'llm', 'tts', 'ttsVoice', 'language', 'showTranscripts', 'sttStreaming', 'diagnosticRecording', 'audioAutoVerify'] as const) {
      if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
    }
    // Changing the provider without naming a voice must not keep a voice that belongs to the old one.
    if (patch.tts !== undefined && patch.tts !== current.tts && patch.ttsVoice === undefined) delete next.ttsVoice;
    // The same for the model: one provider's model id means nothing to another, and is never carried over.
    if (patch.tts !== undefined && patch.tts !== current.tts && patch.ttsModel === undefined) delete next.ttsModel;
    if (patch.ttsModel !== undefined) {
      if (patch.ttsModel === null) delete next.ttsModel;
      else next.ttsModel = patch.ttsModel;
    }
    if (patch.audioSampleRate !== undefined) {
      if (patch.audioSampleRate === null) delete next.audioSampleRate;
      else next.audioSampleRate = patch.audioSampleRate;
    }
    if (patch.agent) next.agent = { ...current.agent, ...patch.agent };
    if (patch.autoHandle !== undefined) next.autoHandle = patch.autoHandle;
    if (patch.automation) next.automation = { ...current.automation, ...patch.automation };
    // Automatic replies are a promise that the audio paths work; refuse to make it without the operator's confirmations.
    if (patch.automation?.autoReplies === true && !(this.hasAttestation(next, 'inbound') && this.hasAttestation(next, 'outbound'))) {
      throw new SettingsError(
        'Automatic replies need both audio confirmations first: caller audio intelligible and agent audio audible (Overview tab)',
        409
      );
    }
    if (patch.params) {
      const merged = { ...current.params, ...patch.params };
      next.params = merged;
    }
    // A sample-rate change no longer erases anything. Each confirmation records the rate it was made at and counts only at that
    // rate (attestationState), so a confirmation made at 8000 Hz is kept, shown, and does not vouch for 16000 Hz audio; switching
    // back makes it count again. Readiness, and with it automatic replies, follows that, never a deleted record.

    const problems = this.selectionProblems(next);
    if (problems.length > 0) throw new SettingsError('Settings rejected', 400, problems);
    this.save(next);
    return next;
  }

  /** Problems with the provider selection itself, ignoring credentials and hardware state. */
  private selectionProblems(stored: StoredSettings): string[] {
    const env = this.envWith(stored, { forceEnabled: true });
    const result = loadAiConfig(env);
    return result.errors.filter((e) => !/is required by the selected providers but is not set/.test(e));
  }

  /** The gateway audio rate these settings imply: the dashboard value, else AI_AUDIO_SAMPLE_RATE from .env. */
  private rateOf(stored: StoredSettings): number | null {
    if (stored.audioSampleRate !== undefined) return stored.audioSampleRate;
    const env = Number(this.baseEnv.AI_AUDIO_SAMPLE_RATE?.trim());
    return Number.isInteger(env) && env > 0 ? env : null;
  }

  /** A stored confirmation, and whether it counts at the current rate. */
  attestationState(kind: 'inbound' | 'outbound', stored: StoredSettings = this.getStored()): { record: StoredAttestation | null; valid: boolean; staleReason: string | null } {
    const record = stored.attestations?.[kind] ?? null;
    if (!record) return { record: null, valid: false, staleReason: null };
    const rate = this.rateOf(stored);
    const madeAt = record.sampleRate ?? null;
    if (madeAt === null || madeAt === rate) return { record, valid: true, staleReason: null };
    return {
      record,
      valid: false,
      staleReason: `Confirmed at ${madeAt} Hz; the gateway is now set to ${rate === null ? 'no sample rate' : `${rate} Hz`}. Audio at the current rate has not been verified: re-verify on a real call, or switch back to ${madeAt} Hz and this confirmation counts again.`,
    };
  }

  /** The last live transcript from real caller audio, and whether it was recorded at the current rate. */
  inboundEvidenceState(): { evidence: StoredSettings['inboundEvidence'] | null; valid: boolean; staleReason: string | null } {
    const stored = this.getStored();
    const evidence = stored.inboundEvidence ?? null;
    if (!evidence) return { evidence: null, valid: false, staleReason: null };
    const rate = this.rateOf(stored);
    const madeAt = evidence.sampleRate ?? null;
    if (madeAt === null || madeAt === rate) return { evidence, valid: true, staleReason: null };
    return { evidence, valid: false, staleReason: `The last live transcript was recorded at ${madeAt} Hz; the gateway is now set to ${rate ?? 'no'} Hz` };
  }

  /** A confirmation counts if the operator stored it at the current rate, or set the flag in .env. */
  private hasAttestation(stored: StoredSettings, kind: 'inbound' | 'outbound'): boolean {
    if (this.attestationState(kind, stored).valid) return true;
    const raw = this.baseEnv[kind === 'inbound' ? 'AI_AUDIO_INBOUND_VERIFIED' : 'AI_AUDIO_OUTBOUND_VERIFIED']?.trim().toLowerCase();
    return raw !== undefined && ['true', '1', 'yes', 'on'].includes(raw);
  }

  // -- attestations ----------------------------------------------------------------------------

  setAttestation(kind: 'inbound' | 'outbound', note: string): void {
    const stored = this.getStored();
    // Re-verifying replaces the earlier confirmation; the rate it was made at is kept with it.
    stored.attestations = { ...stored.attestations, [kind]: { confirmedAt: new Date().toISOString(), note, sampleRate: this.rateOf(stored) } };
    this.save(stored);
  }

  clearAttestation(kind: 'inbound' | 'outbound'): void {
    const stored = this.getStored();
    if (stored.attestations) delete stored.attestations[kind];
    // Withdrawing a confirmation withdraws the permission that depended on it.
    if (stored.automation) stored.automation.autoReplies = false;
    this.save(stored);
  }

  recordInboundEvidence(callId: string, chars: number): void {
    const stored = this.getStored();
    stored.inboundEvidence = { at: new Date().toISOString(), callId, chars, sampleRate: this.rateOf(stored) };
    this.save(stored);
  }

  // -- credentials -------------------------------------------------------------------------------

  private assertKnownCredential(name: string): void {
    if (!(name in credentialProviders())) throw new SettingsError(`Unknown credential '${name}'`, 404);
  }

  setSecret(name: string, value: unknown): void {
    this.assertKnownCredential(name);
    if (!this.cipher) {
      throw new SettingsError(
        'Key storage is not enabled: set AI_SECRETS_MASTER_KEY (16+ random characters) in the gateway .env and restart, or put the key in .env directly',
        409
      );
    }
    if (typeof value !== 'string') throw new SettingsError('value must be a string');
    const trimmed = value.trim();
    if (trimmed.length < 8 || trimmed.length > 512 || /[\s\u0000-\u001f]/.test(trimmed)) {
      throw new SettingsError('That does not look like an API key (8-512 characters, no spaces)');
    }
    this.backend.setSetting(secretKey(name), this.cipher.encrypt(trimmed));
    this.backend.deleteSetting(checkKey(name));
  }

  deleteSecret(name: string): void {
    this.assertKnownCredential(name);
    this.backend.deleteSetting(secretKey(name));
    this.backend.deleteSetting(checkKey(name));
  }

  /** Plaintext key for server-side use only (provider construction, operator-triggered validation). */
  resolveSecret(name: string): string | undefined {
    const stored = this.backend.getSetting(secretKey(name));
    if (stored && this.cipher) {
      try {
        return this.cipher.decrypt(stored);
      } catch {
        return undefined; // reported as missing; the env fallback is deliberately not used silently
      }
    }
    const envValue = this.baseEnv[name]?.trim();
    return envValue ? envValue : undefined;
  }

  credentialSource(name: string): { source: AiCredentialSource; masked: string | null; undecryptable: boolean } {
    const stored = this.backend.getSetting(secretKey(name));
    if (stored) {
      if (!this.cipher) return { source: 'missing', masked: null, undecryptable: true };
      try {
        let masked = this.maskCache.get(stored);
        if (masked === undefined) {
          masked = maskSecret(this.cipher.decrypt(stored));
          this.maskCache.set(stored, masked);
        }
        return { source: 'stored', masked, undecryptable: false };
      } catch {
        return { source: 'missing', masked: null, undecryptable: true };
      }
    }
    return this.baseEnv[name]?.trim() ? { source: 'env', masked: null, undecryptable: false } : { source: 'missing', masked: null, undecryptable: false };
  }

  recordCheck(name: string, check: AiCredentialCheck, detail: string): void {
    this.assertKnownCredential(name);
    this.backend.setSetting(checkKey(name), JSON.stringify({ check, at: new Date().toISOString(), detail }));
  }

  credentialStatuses(required: string[]): AiCredentialStatus[] {
    return Object.entries(credentialProviders()).map(([name, provider]) => {
      const { source, masked, undecryptable } = this.credentialSource(name);
      let lastCheck: AiCredentialCheck = 'not-checked';
      let lastCheckedAt: string | null = null;
      let lastCheckDetail: string | null = undecryptable
        ? 'A stored key exists but cannot be decrypted (AI_SECRETS_MASTER_KEY missing or changed); store it again'
        : null;
      const rawCheck = this.backend.getSetting(checkKey(name));
      if (rawCheck && source !== 'missing') {
        try {
          const parsed = JSON.parse(rawCheck) as { check: AiCredentialCheck; at: string; detail: string };
          lastCheck = parsed.check;
          lastCheckedAt = parsed.at;
          lastCheckDetail = parsed.detail;
        } catch {
          // ignore a corrupt check record
        }
      }
      return { name, provider, requiredBySelection: required.includes(name), source, masked, lastCheck, lastCheckedAt, lastCheckDetail };
    });
  }

  // -- effective configuration -----------------------------------------------------------------

  private envWith(stored: StoredSettings, opts: { forceEnabled?: boolean } = {}): Env {
    const env: Env = { ...this.baseEnv };
    const set = (name: string, value: string | number | boolean | undefined | null) => {
      if (value !== undefined && value !== null) env[name] = String(value);
    };
    set('AI_STT', stored.stt);
    set('AI_LLM', stored.llm);
    set('AI_TTS', stored.tts);
    // A stale voice from a previous provider must not leak into a different provider's selection.
    if (stored.ttsModel !== undefined) set('AI_TTS_MODEL', stored.ttsModel);
    else if (stored.tts !== undefined) delete env.AI_TTS_MODEL;
    if (stored.ttsVoice !== undefined) set('AI_TTS_VOICE', stored.ttsVoice);
    else if (stored.tts !== undefined) delete env.AI_TTS_VOICE;
    set('AI_LANGUAGE', stored.language);
    set('AI_LOG_TRANSCRIPTS', stored.showTranscripts);
    set('AI_STT_STREAMING', stored.sttStreaming);
    set('AI_AUDIO_SAMPLE_RATE', stored.audioSampleRate);
    if (stored.agent) {
      set('AI_ENABLED', stored.agent.enabled);
      set('AI_GREETING', stored.agent.greeting);
      if (stored.agent.instructions !== undefined) set('AI_SYSTEM_INSTRUCTIONS', stored.agent.instructions || '');
      // Saved empty means "use the shared one", which must also beat a value left in .env.
      if (stored.agent.inboundInstructions !== undefined) set('AI_INBOUND_INSTRUCTIONS', stored.agent.inboundInstructions || '');
      if (stored.agent.inboundGreeting !== undefined) set('AI_INBOUND_GREETING', stored.agent.inboundGreeting || '');
      if (stored.agent.outboundInstructions !== undefined) set('AI_OUTBOUND_INSTRUCTIONS', stored.agent.outboundInstructions || '');
      if (stored.agent.outboundGreeting !== undefined) set('AI_OUTBOUND_GREETING', stored.agent.outboundGreeting || '');
      set('AI_ALLOW_AGENT_HANGUP', stored.agent.allowHangup);
    }
    const p = stored.params;
    if (p) {
      set('AI_LLM_MAX_TOKENS', p.maxTokens);
      set('AI_STT_TIMEOUT_MS', p.sttTimeoutMs);
      set('AI_LLM_FIRST_TOKEN_TIMEOUT_MS', p.llmFirstTokenTimeoutMs);
      set('AI_LLM_TOTAL_TIMEOUT_MS', p.llmTotalTimeoutMs);
      set('AI_TTS_TIMEOUT_MS', p.ttsTimeoutMs);
      set('AI_MAX_RESPONSE_CHARS', p.maxResponseChars);
      set('AI_VAD_MIN_SILENCE_MS', p.vadMinSilenceMs);
      set('AI_VAD_RMS_THRESHOLD', p.vadRmsThreshold);
    }
    if (stored.autoHandle !== undefined) set('AI_AUTO_HANDLE', stored.autoHandle);
    if (stored.audioAutoVerify !== undefined) set('AI_AUDIO_AUTO_VERIFY', stored.audioAutoVerify);
    const a = stored.automation;
    if (a) {
      set('AI_AUTO_ANSWER', a.autoAnswer);
      set('AI_AUTO_ANSWER_RINGS', a.autoAnswerRings);
      set('AI_AUTO_ACTIVATE_USB_AUDIO', a.autoActivateUsbAudio);
      set('AI_AUTO_REPLIES', a.autoReplies);
      set('AI_MAX_CALL_SECONDS', a.maxCallSeconds);
      set('AI_IDLE_FOLLOWUPS', a.idleFollowUps);
    }
    // Only a confirmation made at the rate in use counts.
    if (this.attestationState('inbound', stored).valid) env.AI_AUDIO_INBOUND_VERIFIED = 'true';
    if (this.attestationState('outbound', stored).valid) env.AI_AUDIO_OUTBOUND_VERIFIED = 'true';
    if (opts.forceEnabled) env.AI_ENABLED = 'true';
    // Credentials last: a stored key beats .env, and decrypt failures are reported as missing.
    for (const name of Object.keys(credentialProviders())) {
      const value = this.resolveSecret(name);
      if (value) env[name] = value;
      else delete env[name];
    }
    return env;
  }

  /** Environment seen by provider construction and config loading. Contains secrets: server-side only. */
  effectiveEnv(): Env {
    return this.envWith(this.getStored());
  }

  loadConfig(): AiConfigResult {
    return loadAiConfig(this.effectiveEnv());
  }

  view(result: AiConfigResult): AiSettingsViewWithAudio {
    const stored = this.getStored();
    const c = result.config;
    const envInbound = this.baseEnv.AI_AUDIO_INBOUND_VERIFIED?.trim().toLowerCase();
    const envOutbound = this.baseEnv.AI_AUDIO_OUTBOUND_VERIFIED?.trim().toLowerCase();
    const attest = (kind: 'inbound' | 'outbound', envValue: string | undefined): AttestationView => {
      const state = this.attestationState(kind, stored);
      const fromEnv = Boolean(envValue && ['true', '1', 'yes', 'on'].includes(envValue));
      if (state.record && (state.valid || !fromEnv)) {
        return {
          confirmed: state.valid,
          confirmedAt: state.record.confirmedAt,
          note: state.record.note,
          source: 'stored',
          sampleRate: state.record.sampleRate ?? null,
          stale: !state.valid,
          staleReason: state.staleReason,
        };
      }
      if (fromEnv) return { confirmed: true, confirmedAt: null, note: null, source: 'env', sampleRate: null, stale: false, staleReason: null };
      return { confirmed: false, confirmedAt: null, note: null, source: 'none', sampleRate: null, stale: false, staleReason: null };
    };
    return {
      mode: stored.mode ?? 'passive',
      stt: c.stt.key,
      llm: c.llm.key,
      tts: c.tts.key,
      ttsVoice: c.tts.voice,
      ttsModel: c.tts.model,
      agent: {
        name: stored.agent?.name ?? 'Phone agent',
        instructions: stored.agent?.instructions ?? this.baseEnv.AI_SYSTEM_INSTRUCTIONS?.trim() ?? '',
        greeting: c.greeting ?? '',
        inboundInstructions: c.directions.inbound.instructions ?? '',
        inboundGreeting: c.directions.inbound.greeting ?? '',
        outboundInstructions: c.directions.outbound.instructions ?? '',
        outboundGreeting: c.directions.outbound.greeting ?? '',
        language: c.language,
        enabled: c.enabled,
        allowHangup: c.allowAgentHangup,
      },
      showTranscripts: c.logTranscripts,
      sttStreaming: c.sttStreaming.enabled,
      diagnosticRecording: stored.diagnosticRecording ?? false,
      audioSampleRate: c.audio.format?.sampleRate ?? null,
      autoHandle: c.autoHandle,
      automation: {
        autoAnswer: c.automation.autoAnswer,
        autoAnswerRings: c.automation.autoAnswerRings,
        autoActivateUsbAudio: c.automation.autoActivateUsbAudio,
        autoReplies: c.automation.autoReplies,
        maxCallSeconds: c.automation.maxCallSeconds,
        idleFollowUps: c.automation.idleFollowUps,
      },
      params: {
        maxTokens: c.limits.maxLlmTokens,
        sttTimeoutMs: c.timeoutsMs.stt,
        llmFirstTokenTimeoutMs: c.timeoutsMs.llmFirstToken,
        llmTotalTimeoutMs: c.timeoutsMs.llmTotal,
        ttsTimeoutMs: c.timeoutsMs.tts,
        maxResponseChars: c.limits.maxResponseChars,
        vadMinSilenceMs: c.vad.minSilenceMs,
        vadRmsThreshold: c.vad.rmsThreshold,
      },
      attestations: { inbound: attest('inbound', envInbound), outbound: attest('outbound', envOutbound) },
      configErrors: result.errors,
      configWarnings: result.warnings,
      secretStorageAvailable: this.secretStorageAvailable,
      updatedAt: stored.updatedAt ?? null,
    };
  }
}
