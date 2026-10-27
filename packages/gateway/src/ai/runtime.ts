import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AiConversationReadiness,
  AiCredentialCheck,
  AiTestResponseReadiness,
  AiTestResponseResult,
  AiTestStage,
  AiInspectorEvent,
  AiMode,
  AiReadinessView,
  IAudioAdapter,
  ICallSessionManager,
  IModemAdapter,
} from '@sim-gateway/shared';
import { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import { buildWav } from '../diagnostics/pcm-tools.js';
import { AgentAudioSink, AudioFormat, CallerAudioSource, checkPcmBuffer, describeFormat } from './audio.js';
import { buildCatalog } from './catalog-view.js';
import { AiConfigResult } from './config.js';
import { assessUtterance } from './endpointer.js';
import { AiCallAutomation } from './automation.js';
import { AiCallOrchestrator, OrchestratorDeps } from './orchestrator.js';
import { estimateCostUsd } from './pricing.js';
import { createProviders, FetchLike, ProviderSet } from './providers/index.js';
import { checkAiReadiness } from './readiness.js';
import { AiSettingsService, CREDENTIAL_PROVIDERS, SettingsError } from './settings.js';
import { extractEndCall, hasSpeechContent, ProtocolTextFilter } from './text.js';
import { TraceHub } from './trace.js';
import { AiUsageStore } from './usage-store.js';
import { CallSession } from '@sim-gateway/shared';

const MAX_TEST_AUDIO_SECONDS = 60;
const MAX_DIAGNOSTIC_FILES = 50;
const MAX_DIAGNOSTIC_SECONDS = 60;
const VALIDATION_TIMEOUT_MS = 8000;
/** A test response answers only a transcript this recent, so it is about what the caller just said. */
const TEST_TRANSCRIPT_MAX_AGE_MS = 60_000;
const TEST_REPLY_MAX_CHARS = 300;
const TEST_MAX_AUDIO_SECONDS = 25;
/** The module's documented PCM rates over USB audio: AT+CPCMFRM 0 = 8 kHz, 1 = 16 kHz. */
const CPCMFRM_RATE: Record<number, number> = { 0: 8000, 1: 16000 };

export interface AiRuntimeOptions {
  settings: AiSettingsService;
  usage: AiUsageStore;
  modem: IModemAdapter;
  audio: IAudioAdapter;
  callManager: ICallSessionManager;
  eventBus: GatewayEventBus;
  /** Where captures live (the audio dump directory). Recording tests may only read files directly inside it. */
  recordingsDir: string;
  /** Offline providers (tests, ai:loop). When set no network request is ever made for STT/LLM/TTS. */
  providers?: ProviderSet;
  fetchImpl?: FetchLike;
  transports?: (call: CallSession, format: AudioFormat) => { source: CallerAudioSource; sink: AgentAudioSink };
  /** Test seam: let mock hardware satisfy the hardware check. */
  allowSimulatedHardware?: boolean;
  audioPortBusy?: () => boolean;
  /** Test seam: shorter idle waits for follow-up prompts. */
  idleWaitsMs?: readonly [number, number, number];
  callLimitMs?: number;
  /** Test seam: how long automation waits for audio bytes, and how often it looks. */
  automationAudioWaitMs?: number;
  automationPollMs?: number;
  /** Test seam: USB audio activation settle delay, retry spacing and attempts. */
  automationActivation?: { settleMs?: number; retryMs?: number; attempts?: number };
  /** Test seam: fixed runtime mode, as if the operator had chosen it. Never set in production wiring. */
  forceMode?: AiMode;
  /** Days to keep the per-turn log (default 30). */
  retentionDays?: number;
}

export class AiBlockedError extends Error {
  constructor(message: string, readonly blockers: string[] = []) {
    super(message);
    this.name = 'AiBlockedError';
  }
}

export interface RecordingInfo {
  name: string;
  bytes: number;
  modifiedAt: string;
  kind: 'wav' | 'raw-pcm';
  /** Length when interpreted at the configured/declared rate; null if the rate is unknown. */
  seconds: number | null;
}

/**
 * Everything the dashboard controls, in one place. It owns the live AI configuration (settings
 * layered over .env), the orchestrator that attaches to calls, the inspector feed, the operator's
 * mode and attestations, and the operator-triggered tests. It never talks to the modem and never
 * answers, dials, hangs up or registers PCM.
 */
export class AiRuntime {
  private readonly logger = createLogger('AiRuntime');
  readonly hub: TraceHub;
  readonly orchestrator: AiCallOrchestrator;
  readonly automation: AiCallAutomation;
  private readonly deps: OrchestratorDeps;
  private env: Record<string, string | undefined>;
  private configResult: AiConfigResult;
  /** Active mode lasts for one call and never survives a restart. */
  private activeRequested = false;
  private testInFlight = false;
  private testCounter = 0;
  private lastTest: AiTestResponseResult | null = null;
  private readonly onCallEnded = (): void => {
    if (this.activeRequested) {
      this.activeRequested = false;
      this.orchestrator.applyMode();
      this.logger.info('AI active mode ended with the call; back to the stored mode');
    }
  };

  constructor(private readonly options: AiRuntimeOptions) {
    this.env = options.settings.effectiveEnv();
    this.configResult = options.settings.loadConfig();
    this.hub = new TraceHub(
      (event) => options.eventBus.emit('ai:event', event),
      () => this.configResult.config.logTranscripts
    );
    this.deps = {
      configResult: this.configResult,
      manager: options.callManager,
      audio: options.audio,
      eventBus: options.eventBus,
      readiness: () => this.readinessRaw(),
      createProviders: () => this.buildProviders(this.mode === 'active' ? undefined : 'stt'),
      createFullProviders: () => this.buildProviders(),
      transports: options.transports,
      audioPortBusy: options.audioPortBusy,
      mode: () => this.mode,
      hub: this.hub,
      usage: options.usage,
      providersAreMock: options.providers !== undefined,
      idleWaitsMs: options.idleWaitsMs,
      callLimitMs: options.callLimitMs,
      onUtteranceAudio: (callId, index, pcm, format) => {
        this.saveDiagnosticAudio(callId, index, pcm, format);
      },
      onTranscript: (callId, chars, simulated) => {
        // Only a real call on real hardware with a real provider counts as evidence of intelligible audio.
        if (!simulated || options.allowSimulatedHardware) options.settings.recordInboundEvidence(callId, chars);
      },
    };
    this.orchestrator = new AiCallOrchestrator(this.deps);
    this.automation = new AiCallAutomation({
      manager: options.callManager,
      eventBus: options.eventBus,
      getConfig: () => ({ config: this.configResult.config, passiveUsable: this.configResult.passiveUsable, usable: this.configResult.usable }),
      getMode: () => this.mode,
      modemReady: () => options.modem.getConnectionState() === 'READY',
      hasActiveSession: () => this.orchestrator.hasActiveSession,
      mark: (callId, event) => void this.hub.publish(callId, event),
      alert: (level, message) => options.eventBus.emit('gateway:alert', { level, message, timestamp: new Date().toISOString() }),
      audioWaitMs: options.automationAudioWaitMs,
      pollMs: options.automationPollMs,
      activationSettleMs: options.automationActivation?.settleMs,
      activationRetryMs: options.automationActivation?.retryMs,
      activationAttempts: options.automationActivation?.attempts,
    });
    options.eventBus.on('call:ended', this.onCallEnded);
    try {
      options.usage.purgeOlderThan(options.retentionDays ?? 30);
    } catch {
      // retention is best effort
    }
  }

  start(): void {
    this.orchestrator.start();
    this.automation.start();
  }

  async stop(): Promise<void> {
    this.options.eventBus.off('call:ended', this.onCallEnded);
    this.automation.stop();
    await this.orchestrator.stop();
  }

  // ---- configuration ----------------------------------------------------------------------------

  get config(): AiConfigResult {
    return this.configResult;
  }

  /** Recompute the effective configuration after any settings, credential or attestation change. */
  reload(): void {
    this.env = this.options.settings.effectiveEnv();
    this.configResult = this.options.settings.loadConfig();
    this.deps.configResult = this.configResult;
    this.deps.providersAreMock = this.options.providers !== undefined;
    this.orchestrator.applyMode();
  }

  get mode(): AiMode {
    if (!this.configResult.config.enabled) return 'off';
    if (this.options.forceMode) return this.options.forceMode;
    if (this.activeRequested) return 'active';
    const stored = this.options.settings.getStored().mode ?? 'passive';
    if (stored === 'off') return 'off';
    // Automatic replies: the agent speaks without a per-call click, but only while EVERY readiness check passes
    // (which includes both of the operator's audio confirmations). Otherwise it stays passive, never half-active.
    if (this.configResult.config.automation.autoReplies && this.readinessRaw().ok) return 'active';
    return stored;
  }

  /**
   * Passive: transcribe only. Active: replies are spoken to the caller, for the CURRENT call only.
   * Active needs the full readiness check (real hardware, verified audio both ways, all keys).
   */
  setMode(mode: AiMode): void {
    if (mode === 'active') {
      if (!this.configResult.usable) {
        throw new AiBlockedError('The AI configuration is not complete', [
          ...this.configResult.errors,
          ...(this.configResult.config.enabled ? [] : ['AI is not enabled']),
        ]);
      }
      const readiness = this.readinessRaw();
      if (!readiness.ok) throw new AiBlockedError('AI replies are blocked until readiness passes', readiness.blockers);
      this.activeRequested = true;
      this.orchestrator.applyMode();
      return;
    }
    this.activeRequested = false;
    this.options.settings.update({ mode });
    this.reload();
  }

  // ---- readiness --------------------------------------------------------------------------------

  private readinessRaw() {
    return checkAiReadiness({
      configResult: this.configResult,
      modem: this.options.modem,
      manager: this.options.callManager,
      audio: this.options.audio,
      env: this.env,
      allowSimulatedHardware: this.options.allowSimulatedHardware,
    });
  }

  readiness(): AiReadinessView {
    const r = this.readinessRaw();
    return {
      passiveOk: r.passiveOk,
      ok: r.ok,
      checkedAt: r.checkedAt,
      checks: r.checks.map(({ name, status, detail }) => ({ name, status, detail })),
      blockers: r.blockers,
      passiveBlockers: r.passiveBlockers,
      mode: this.mode,
      simulatedHardware: r.simulatedHardware,
    };
  }

  // ---- attestations -----------------------------------------------------------------------------

  attest(kind: 'inbound' | 'outbound', note: unknown): void {
    const text = typeof note === 'string' ? note.trim() : '';
    if (text.length < 10 || text.length > 500) {
      throw new SettingsError('Describe what you verified (10-500 characters), for example which call and what you heard');
    }
    const readiness = this.readinessRaw();
    if (readiness.simulatedHardware && !this.options.allowSimulatedHardware) {
      throw new AiBlockedError('Simulated hardware cannot be attested: the mock modem proves nothing about the SIM7600EI audio path');
    }
    if (kind === 'inbound') {
      const evidence = this.options.settings.getStored().inboundEvidence;
      if (!evidence) {
        throw new AiBlockedError(
          'No live transcript from real caller audio has been recorded yet. Run a passive call and read the Live Inspector; confirm only after the transcript matched what the caller said'
        );
      }
    } else if (!this.options.settings.getStored().attestations?.inbound && !this.configResult.config.audio.inboundVerified) {
      throw new AiBlockedError('Confirm incoming audio first: replies are pointless if the caller cannot be understood');
    }
    this.options.settings.setAttestation(kind, text);
    this.reload();
  }

  revokeAttestation(kind: 'inbound' | 'outbound'): void {
    this.options.settings.clearAttestation(kind);
    this.reload();
  }

  // ---- providers --------------------------------------------------------------------------------

  private buildProviders(only?: 'stt' | 'llm' | 'tts'): ProviderSet {
    if (this.options.providers) return this.options.providers;
    return createProviders(this.configResult.config, { env: this.env, fetchImpl: this.options.fetchImpl, only });
  }

  catalog() {
    return buildCatalog(this.env);
  }

  // ---- credentials ------------------------------------------------------------------------------

  credentials() {
    return this.options.settings.credentialStatuses(this.configResult.config.requiredKeyEnv);
  }

  setCredential(name: string, value: unknown): void {
    this.options.settings.setSecret(name, value);
    this.reload();
  }

  removeCredential(name: string): void {
    this.options.settings.deleteSecret(name);
    this.reload();
  }

  /**
   * Operator-triggered credential check against the provider's own authenticated listing endpoint
   * (read-only, not billed per request). Presence, validity and reachability are reported separately,
   * and the key is never echoed. Network or provider outage reads as "unreachable", never as "invalid".
   */
  async validateCredential(name: string): Promise<{ check: AiCredentialCheck; detail: string }> {
    if (!(name in CREDENTIAL_PROVIDERS)) throw new SettingsError(`Unknown credential '${name}'`, 404);
    const key = this.options.settings.resolveSecret(name);
    if (!key) {
      throw new AiBlockedError(`${name} is not set, so there is nothing to validate`);
    }
    const request = credentialProbe(name, key, this.env.CARTESIA_VERSION);
    const fetchImpl: FetchLike = this.options.fetchImpl ?? ((url, init) => fetch(url, init));
    let result: { check: AiCredentialCheck; detail: string };
    try {
      const response = await fetchImpl(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
      if (response.ok) result = { check: 'ok', detail: `${CREDENTIAL_PROVIDERS[name]} accepted the key (HTTP ${response.status})` };
      else if (response.status === 401 || response.status === 403) {
        result = { check: 'invalid', detail: `${CREDENTIAL_PROVIDERS[name]} rejected the key (HTTP ${response.status})` };
      } else {
        result = {
          check: 'unreachable',
          detail: `${CREDENTIAL_PROVIDERS[name]} answered HTTP ${response.status}; the key could not be confirmed either way`,
        };
      }
      void response.body?.cancel().catch(() => {});
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      result = { check: 'unreachable', detail: `${CREDENTIAL_PROVIDERS[name]} ${reason}; the key could not be checked` };
    }
    this.options.settings.recordCheck(name, result.check, result.detail);
    return result;
  }

  // ---- operator tests (each is explicit and billable; none touches a call or the modem) ---------

  private requireBilling(confirmBilling: unknown): void {
    if (confirmBilling !== true) {
      throw new SettingsError('This test sends a real provider request that may be billed; resend with confirmBilling: true');
    }
  }

  /** A text-only LLM exchange. No audio, no call, no TTS. */
  async testLlm(input: { prompt?: unknown; confirmBilling?: unknown }) {
    this.requireBilling(input.confirmBilling);
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt.length === 0 || prompt.length > 500) throw new SettingsError('prompt must be 1-500 characters');
    const cfg = this.configResult.config;
    if (!cfg.llm.spec && !this.options.providers) throw new AiBlockedError(`LLM '${cfg.llm.key}' is not implemented`);
    const providers = this.buildProviders('llm');
    const controller = new AbortController();
    const started = performance.now();
    let firstTokenMs: number | null = null;
    let reply = '';
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    for await (const chunk of providers.llm.stream(
      { system: cfg.systemPrompt, messages: [{ role: 'user', content: prompt }] },
      controller.signal
    )) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.delta) {
        firstTokenMs ??= performance.now() - started;
        reply += chunk.delta;
        if (reply.length > 1500) {
          controller.abort();
          break;
        }
      }
    }
    const totalMs = performance.now() - started;
    const estimatedCostUsd = usage
      ? estimateCostUsd(
          { stt: cfg.stt.key, llm: cfg.llm.key, tts: cfg.tts.key },
          { sttSeconds: 0, llmPromptTokens: usage.promptTokens, llmCompletionTokens: usage.completionTokens, ttsChars: 0 }
        )
      : null;
    this.recordTest('llm', { llmPromptTokens: usage?.promptTokens ?? null, llmCompletionTokens: usage?.completionTokens ?? null });
    return {
      model: cfg.llm.key,
      reply: reply.trim(),
      firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      totalMs: Math.round(totalMs),
      usage,
      estimatedCostUsd,
      mock: this.options.providers !== undefined,
    };
  }

  /** Synthesize speech for the browser only. The audio is returned to the dashboard and never written to a call. */
  async previewTts(input: { text?: unknown; confirmBilling?: unknown }) {
    this.requireBilling(input.confirmBilling);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text.length === 0 || text.length > 300) throw new SettingsError('text must be 1-300 characters');
    const cfg = this.configResult.config;
    const format = cfg.audio.format;
    if (!format) throw new AiBlockedError('AI_AUDIO_SAMPLE_RATE is not set; the preview must use the gateway audio format');
    const providers = this.buildProviders('tts');
    const started = performance.now();
    const pcm = await providers.tts.synthesize(text, format, new AbortController().signal);
    const ms = performance.now() - started;
    const wav = buildWav(pcm, { ...format, verified: true });
    this.recordTest('tts', { ttsChars: text.length });
    return {
      voice: cfg.tts.voice,
      provider: cfg.tts.key,
      format: describeFormat(format),
      bytes: pcm.length,
      seconds: Math.round((pcm.length / 2 / format.sampleRate) * 100) / 100,
      generationMs: Math.round(ms),
      chars: text.length,
      estimatedCostUsd: estimateCostUsd(
        { stt: cfg.stt.key, llm: cfg.llm.key, tts: cfg.tts.key },
        { sttSeconds: 0, llmPromptTokens: 0, llmCompletionTokens: 0, ttsChars: text.length }
      ),
      /** Generated for the browser. Whether it reaches the caller depends on the unverified outbound path. */
      transmittedToCaller: false,
      audioWavBase64: wav.toString('base64'),
      mock: this.options.providers !== undefined,
    };
  }

  /** What the TTS would need from the phone line, and what is and is not established. */
  ttsCompatibility() {
    const cfg = this.configResult.config;
    const format = cfg.audio.format;
    const catalog = buildCatalog(this.env).tts.find((t) => t.key === cfg.tts.key);
    const rateSupported = format ? (catalog?.sampleRates ?? []).includes(format.sampleRate) : null;
    const attest = this.options.settings.view(this.configResult).attestations;
    return {
      provider: cfg.tts.key,
      voice: cfg.tts.voice,
      gatewayFormat: format ? describeFormat(format) : null,
      providerSupportsGatewayRate: rateSupported,
      outboundPathVerified: attest.outbound.confirmed,
      statements: [
        format
          ? rateSupported
            ? `${cfg.tts.key} can return raw ${format.sampleRate} Hz 16-bit mono PCM, the gateway format.`
            : `${cfg.tts.key} cannot return raw ${format.sampleRate} Hz audio; replies would be refused.`
          : 'The gateway audio format is not configured, so compatibility cannot be assessed.',
        attest.outbound.confirmed
          ? 'You confirmed that a remote party heard audio written to the USB audio port.'
          : 'Not established: that audio written to the SIM7600 USB audio port is audible to the remote party. Generated speech is therefore never sent until you confirm a blind tone test.',
      ],
    };
  }

  // ---- recordings -------------------------------------------------------------------------------

  listRecordings(): RecordingInfo[] {
    const dir = this.options.recordingsDir;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const rate = this.configResult.config.audio.format?.sampleRate ?? null;
    const out: RecordingInfo[] = [];
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (ext !== '.wav' && ext !== '.bin') continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(dir, name));
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      out.push({
        name,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        kind: ext === '.wav' ? 'wav' : 'raw-pcm',
        seconds: ext === '.wav' ? null : rate ? Math.round((stat.size / 2 / rate) * 100) / 100 : null,
      });
    }
    return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1)).slice(0, 100);
  }

  /**
   * Run an existing capture through the configured STT, separately from any live call. Only files
   * directly inside the recordings folder can be named; the result never counts as live evidence.
   */
  async testSttRecording(input: { file?: unknown; startSeconds?: unknown; durationSeconds?: unknown; confirmBilling?: unknown }) {
    this.requireBilling(input.confirmBilling);
    const name = typeof input.file === 'string' ? input.file : '';
    if (!name || name !== path.basename(name) || name.includes('..') || !/\.(wav|bin)$/i.test(name)) {
      throw new SettingsError('file must be the name of a .wav or .bin file in the recordings folder');
    }
    const full = path.join(this.options.recordingsDir, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new SettingsError('recording not found', 404);
    const cfg = this.configResult.config;
    const raw = fs.readFileSync(full);
    let pcm: Buffer;
    let format: AudioFormat;
    if (/\.wav$/i.test(name)) {
      const parsed = parseWav(raw);
      pcm = parsed.pcm;
      format = parsed.format;
    } else {
      if (!cfg.audio.format) throw new AiBlockedError('Raw captures are read at AI_AUDIO_SAMPLE_RATE, which is not set');
      pcm = raw;
      format = cfg.audio.format;
    }
    const start = clamp(Number(input.startSeconds ?? 0), 0, 24 * 3600);
    const duration = clamp(Number(input.durationSeconds ?? 20), 1, MAX_TEST_AUDIO_SECONDS);
    const bytesPerSecond = format.sampleRate * 2;
    const from = Math.min(pcm.length, Math.floor(start * format.sampleRate) * 2);
    const slice = pcm.subarray(from, Math.min(pcm.length, from + Math.floor(duration * bytesPerSecond)));
    const check = checkPcmBuffer(slice, format);
    if (!check.ok) throw new SettingsError(`audio rejected: ${check.reason}`);
    const assessment = assessUtterance(slice, format, { minDurationMs: cfg.utterance.minDurationMs });
    const providers = this.buildProviders('stt');
    const started = performance.now();
    const result = await providers.stt.transcribe(slice, format, new AbortController().signal);
    const sttMs = performance.now() - started;
    const seconds = slice.length / bytesPerSecond;
    this.recordTest('stt', { sttSeconds: seconds });
    return {
      source: 'recording' as const,
      file: name,
      format: describeFormat(format),
      startSeconds: start,
      seconds: Math.round(seconds * 100) / 100,
      assessment: {
        decision: assessment.decision,
        rms: Math.round(assessment.rms * 10000) / 10000,
        peak: Math.round(assessment.peak * 10000) / 10000,
        voicedRatio: Math.round(assessment.voicedRatio * 100) / 100,
      },
      transcript: result.text,
      sttMs: Math.round(sttMs),
      estimatedCostUsd: estimateCostUsd(
        { stt: cfg.stt.key, llm: cfg.llm.key, tts: cfg.tts.key },
        { sttSeconds: seconds, llmPromptTokens: 0, llmCompletionTokens: 0, ttsChars: 0 }
      ),
      mock: this.options.providers !== undefined,
      note: 'Transcription of a saved recording. It is not live-call evidence and does not change readiness.',
    };
  }

  /** Test calls are usage too (they are billed), logged under a synthetic call id. */
  private recordTest(
    kind: 'stt' | 'llm' | 'tts',
    usage: { sttSeconds?: number; llmPromptTokens?: number | null; llmCompletionTokens?: number | null; ttsChars?: number }
  ): void {
    const cfg = this.configResult.config;
    try {
      this.options.usage.record({
        callId: `test:${kind}`,
        status: 'completed',
        reason: 'operator-test',
        sttMs: null,
        llmFirstTokenMs: null,
        ttsFirstMs: null,
        totalMs: null,
        utteranceMs: null,
        sttSeconds: usage.sttSeconds ?? 0,
        llmPromptTokens: usage.llmPromptTokens ?? null,
        llmCompletionTokens: usage.llmCompletionTokens ?? null,
        ttsChars: usage.ttsChars ?? 0,
        selection: { stt: cfg.stt.key, llm: cfg.llm.key, tts: cfg.tts.key },
        mock: this.options.providers !== undefined,
      });
    } catch {
      // usage logging is best effort
    }
  }

  // ---- one-shot test response (operator-triggered; never automatic) --------------------------------

  /**
   * Whether "generate and play a test response" may run now. This is deliberately NOT the active-mode
   * readiness: that check requires the outbound path to be confirmed audible, and this test is how the
   * operator finds out. Everything that can be checked from the gateway is still required: a real,
   * ACTIVE call, an attached passive session, a recent voiced transcript, working keys, live inbound
   * audio (so the USB audio registration is valid) and a PCM rate that agrees with what the module reports.
   */
  testResponseReadiness(): AiTestResponseReadiness {
    const blockers: string[] = [];
    const call = this.options.callManager.getCurrentCall();
    const cfg = this.configResult.config;
    const format = cfg.audio.format;
    const base = this.readinessRaw();
    for (const b of base.passiveBlockers) blockers.push(b);

    const attached = call ? this.orchestrator.getAttached(call.id) : undefined;
    let ageSeconds: number | null = null;
    if (call && !attached) {
      blockers.push('session: the AI is not attached to this call (attach it in passive mode first)');
    } else if (attached) {
      if (!attached.session.isPassive) blockers.push('session: replies are already enabled for this call; use the normal conversation instead of the test');
      if (attached.session.isBusy) blockers.push('session: the AI is still working on a caller turn');
      const transcript = attached.session.lastTranscript;
      if (!transcript) {
        blockers.push('transcript: no voiced transcript has been recorded for this call yet');
      } else {
        ageSeconds = Math.round((Date.now() - transcript.at) / 1000);
        if (Date.now() - transcript.at > TEST_TRANSCRIPT_MAX_AGE_MS) {
          blockers.push(`transcript: the latest one is ${ageSeconds} s old (limit ${TEST_TRANSCRIPT_MAX_AGE_MS / 1000} s); have the caller speak again`);
        }
      }
    }

    // Credentials and selection for all three stages (passive only needs STT).
    if (!this.configResult.usable) {
      for (const e of this.configResult.errors) blockers.push(`config: ${e}`);
    }
    if (this.options.audioPortBusy?.()) blockers.push('audio: a PCM verification test is using the audio port');
    if (this.testInFlight) blockers.push('test: another test response is already running');

    if (!this.options.audio.getStats().isStreaming) blockers.push('audio: the audio port is not open for this call');

    // The format the module is using must agree with the format we synthesize in.
    if (format) {
      const usb = this.options.callManager.getUsbAudioStatus?.();
      const cpcmfrm = usb?.moduleAudioFormat?.cpcmfrm;
      const moduleRate = cpcmfrm === null || cpcmfrm === undefined ? null : CPCMFRM_RATE[cpcmfrm] ?? null;
      if (moduleRate !== null && moduleRate !== format.sampleRate) {
        blockers.push(`format: the module reports ${moduleRate} Hz (AT+CPCMFRM=${cpcmfrm}) but the gateway is set to ${format.sampleRate} Hz`);
      }
      if (attached) {
        const observed = attached.meter.observedSampleRate;
        if (observed !== null && Math.abs(observed - format.sampleRate) / format.sampleRate > 0.15) {
          blockers.push(`format: audio is arriving at about ${observed} samples/s but the gateway is set to ${format.sampleRate} Hz`);
        }
      }
      if (format.bitDepth !== 16 || format.channels !== 1 || format.endianness !== 'little-endian') {
        blockers.push('format: only 16-bit mono little-endian PCM can be played');
      }
    }

    return {
      allowed: blockers.length === 0,
      blockers: [...new Set(blockers)],
      transcriptAgeSeconds: ageSeconds,
      format: format ? describeFormat(format) : null,
      last: this.lastTest && call && this.lastTest.callId === call.id ? this.lastTest : null,
    };
  }

  // ---- per-call conversation mode (operator-enabled; no per-turn clicks) -------------------------

  /**
   * May the operator switch conversation on for the current call? The same checks as the test response
   * (real ACTIVE call, valid configuration and keys, live audio bytes, a PCM rate that agrees with the module),
   * without needing a fresh transcript. It is a per-call, explicitly confirmed decision, so it does not need
   * (and never sets) the persistent "agent audio is audible" confirmation.
   */
  conversationReadiness(): AiConversationReadiness {
    const call = this.options.callManager.getCurrentCall();
    const attached = call ? this.orchestrator.getAttached(call.id) : undefined;
    const active = attached ? !attached.session.isPassive : false;
    const blockers = this.testResponseReadiness().blockers.filter(
      (b) => !/^transcript:|^test: |^session: (the AI is not attached|the AI is still working|replies are already enabled)/.test(b)
    );
    return { allowed: !active && blockers.length === 0, blockers, active };
  }

  /**
   * Switch conversation mode on or off for one call. On: attaches the AI first if needed (passive readiness
   * applies), gives the session its LLM and TTS, and from then on every finished caller utterance is answered
   * and the agent goes back to listening. Off: stops at once, including speech in progress.
   */
  async setConversation(callId: string, enabled: boolean, input: { confirmBilling?: unknown; confirmPlayToCaller?: unknown } = {}): Promise<void> {
    const call = this.options.callManager.getCurrentCall();
    if (!call || call.id !== callId) throw new SettingsError('Only the current call can be switched', 404);
    if (!enabled) {
      if (!this.orchestrator.getAttached(callId)) return;
      this.orchestrator.setConversation(callId, false);
      return;
    }
    if (input.confirmBilling !== true || input.confirmPlayToCaller !== true) {
      throw new SettingsError('Conversation mode makes billable provider requests and speaks to the remote party; resend with confirmBilling: true and confirmPlayToCaller: true');
    }
    const readiness = this.conversationReadiness();
    if (readiness.active) return; // already on: idempotent
    if (!readiness.allowed) throw new AiBlockedError('Conversation mode is blocked', readiness.blockers);
    if (!this.orchestrator.getAttached(callId)) await this.orchestrator.arm(callId);
    try {
      this.orchestrator.setConversation(callId, true);
    } catch (error) {
      throw new AiBlockedError((error as Error).message);
    }
  }

  /**
   * Run exactly one reply: LLM, then TTS, then playback through the attached session's sink, with each
   * stage reported on its own. It never changes the mode, never hangs up, never loops, and never marks
   * the outbound path as verified: bytes written to the port say nothing about what the caller heard.
   */
  async playTestResponse(callId: string, input: { confirmBilling?: unknown; confirmPlayToCaller?: unknown }): Promise<AiTestResponseResult> {
    if (input.confirmBilling !== true || input.confirmPlayToCaller !== true) {
      throw new SettingsError('This sends billable provider requests and plays audio to the remote party; resend with confirmBilling: true and confirmPlayToCaller: true');
    }
    const call = this.options.callManager.getCurrentCall();
    if (!call || call.id !== callId) throw new SettingsError('Only the current call can receive a test response', 404);
    const readiness = this.testResponseReadiness();
    if (!readiness.allowed) throw new AiBlockedError('The test response is blocked', readiness.blockers);

    const attached = this.orchestrator.getAttached(callId)!;
    const transcript = attached.session.lastTranscript!;
    const cfg = this.configResult.config;
    const format = cfg.audio.format!;
    const turnId = `${callId}:test${++this.testCounter}`;
    const trace = (stage: 'llm-request' | 'llm-response' | 'tts-generated' | 'playback', status: 'ok' | 'failed' | 'cancelled' | 'not-run', extra: { latencyMs?: number; detail?: string; text?: string; data?: Record<string, number | string | boolean | null> } = {}) =>
      this.hub.publish(callId, { turnId, stage, status, role: stage === 'llm-request' ? undefined : 'agent', ...extra });

    const stage = (): AiTestStage => ({ status: 'not-run', ms: null, error: null });
    const result: AiTestResponseResult = {
      callId,
      startedAt: new Date().toISOString(),
      mock: this.options.providers !== undefined,
      transcriptAgeSeconds: Math.round((Date.now() - transcript.at) / 1000),
      llm: { ...stage(), chars: null, promptTokens: null, completionTokens: null },
      tts: { ...stage(), chars: null, bytes: null, seconds: null },
      playbackSubmission: { ...stage(), bytesWritten: null, bytesTotal: null },
      playbackCompletion: { ...stage(), stoppedBy: null },
      format: describeFormat(format),
      heardByRemote: 'unknown',
      note: 'Bytes accepted by the audio port do not prove the remote party heard anything. Ask them, then record it under "Agent audio is audible" only if they did.',
    };
    this.lastTest = result;
    this.testInFlight = true;
    const controller = new AbortController();
    const stopOnCallEnd = (): void => controller.abort();
    this.options.eventBus.once('call:ended', stopOnCallEnd);

    const fail = (s: AiTestStage, error: unknown, label: string): AiTestResponseResult => {
      s.status = controller.signal.aborted ? 'cancelled' : 'failed';
      s.error = controller.signal.aborted ? 'the call ended' : (error instanceof Error ? error.message : String(error ?? label));
      return result;
    };

    try {
      // 1. LLM -------------------------------------------------------------------------------------
      trace('llm-request', 'ok', { data: { provider: cfg.llm.key, testResponse: true } });
      const llmStarted = performance.now();
      let reply = '';
      try {
        const providers = this.buildProviders('llm');
        const timeout = AbortSignal.timeout(cfg.timeoutsMs.llmTotal);
        const signal = AbortSignal.any([controller.signal, timeout]);
        const filter = new ProtocolTextFilter();
        let raw = '';
        let usage: { promptTokens: number; completionTokens: number } | null = null;
        for await (const chunk of providers.llm.stream({ system: cfg.systemPrompt, messages: [{ role: 'user', content: transcript.text }] }, signal)) {
          if (chunk.usage) usage = chunk.usage;
          if (chunk.delta) raw += filter.feed(chunk.delta);
          if (raw.length > TEST_REPLY_MAX_CHARS * 3) break;
        }
        raw += filter.finish();
        // The test never ends or controls the call: a sign-off token is stripped, not acted on.
        reply = extractEndCall(raw).text.replace(/\s+/g, ' ').trim();
        if (reply.length > TEST_REPLY_MAX_CHARS) {
          const cut = reply.slice(0, TEST_REPLY_MAX_CHARS);
          reply = (cut.match(/^.*[.!?]/s)?.[0] ?? cut).trim();
        }
        if (!hasSpeechContent(reply)) throw new Error('the model returned no speakable text');
        result.llm = { status: 'ok', ms: Math.round(performance.now() - llmStarted), error: null, chars: reply.length, promptTokens: usage?.promptTokens ?? null, completionTokens: usage?.completionTokens ?? null };
        trace('llm-response', 'ok', { latencyMs: performance.now() - llmStarted, text: reply, data: { chars: reply.length, testResponse: true } });
      } catch (error) {
        result.llm.ms = Math.round(performance.now() - llmStarted);
        fail(result.llm, error, 'LLM failed');
        trace('llm-response', result.llm.status as 'failed' | 'cancelled', { detail: result.llm.error ?? undefined });
        return result;
      }

      // 2. TTS -------------------------------------------------------------------------------------
      const ttsStarted = performance.now();
      let pcm: Buffer;
      try {
        const providers = this.buildProviders('tts');
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(cfg.timeoutsMs.tts)]);
        pcm = await providers.tts.synthesize(reply, format, signal);
        if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error('the voice provider returned audio that is not whole 16-bit samples');
        const seconds = pcm.length / 2 / format.sampleRate;
        if (seconds > TEST_MAX_AUDIO_SECONDS) throw new Error(`the generated audio is ${seconds.toFixed(1)} s, over the ${TEST_MAX_AUDIO_SECONDS} s test limit`);
        result.tts = { status: 'ok', ms: Math.round(performance.now() - ttsStarted), error: null, chars: reply.length, bytes: pcm.length, seconds: Math.round(seconds * 100) / 100 };
        trace('tts-generated', 'ok', { latencyMs: performance.now() - ttsStarted, data: { chars: reply.length, bytes: pcm.length, testResponse: true } });
      } catch (error) {
        result.tts.ms = Math.round(performance.now() - ttsStarted);
        fail(result.tts, error, 'TTS failed');
        trace('tts-generated', result.tts.status as 'failed' | 'cancelled', { detail: result.tts.error ?? undefined });
        return result;
      }

      // 3. Playback through the same sink the live pipeline uses ------------------------------------
      const stillOurCall = this.options.callManager.getCurrentCall();
      if (!stillOurCall || stillOurCall.id !== callId || stillOurCall.state !== 'ACTIVE') {
        result.playbackSubmission = { status: 'cancelled', ms: null, error: 'the call ended before playback', bytesWritten: 0, bytesTotal: pcm.length };
        trace('playback', 'cancelled', { detail: 'the call ended before playback' });
        return result;
      }
      const playStarted = performance.now();
      try {
        const played = await attached.sink.play(pcm, controller.signal);
        const ms = Math.round(performance.now() - playStarted);
        const submitted = played.bytesWritten > 0;
        result.playbackSubmission = {
          status: submitted ? 'ok' : 'failed',
          ms,
          error: submitted ? null : `no audio was accepted by the port (${played.stoppedBy ?? 'not-written'})`,
          bytesWritten: played.bytesWritten,
          bytesTotal: pcm.length,
        };
        result.playbackCompletion = played.completed
          ? { status: 'ok', ms, error: null, stoppedBy: null }
          : { status: controller.signal.aborted || played.stoppedBy === 'call-ended' || played.stoppedBy === 'aborted' ? 'cancelled' : 'failed', ms, error: `playback stopped early: ${played.stoppedBy ?? 'unknown'}`, stoppedBy: played.stoppedBy };
        trace('playback', played.completed ? 'ok' : (result.playbackCompletion.status as 'failed' | 'cancelled'), {
          latencyMs: performance.now() - playStarted,
          detail: played.completed ? 'all audio written to the port (audibility is not verified)' : result.playbackCompletion.error ?? undefined,
          data: { bytesWritten: played.bytesWritten, bytes: pcm.length, testResponse: true },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.playbackSubmission = { status: 'failed', ms: Math.round(performance.now() - playStarted), error: message, bytesWritten: 0, bytesTotal: pcm.length };
        trace('playback', 'failed', { detail: message });
      }
      return result;
    } finally {
      this.options.eventBus.off('call:ended', stopOnCallEnd);
      this.testInFlight = false;
      this.recordTest('llm', { llmPromptTokens: result.llm.promptTokens, llmCompletionTokens: result.llm.completionTokens });
      if (result.tts.status === 'ok') this.recordTest('tts', { ttsChars: result.tts.chars ?? 0 });
    }
  }

  // ---- live state -------------------------------------------------------------------------------

  recentEvents(callId?: string): AiInspectorEvent[] {
    return this.hub.recent(callId);
  }

  /** Persist an utterance for later listening. Off unless the operator enabled diagnostic recording. */
  saveDiagnosticAudio(callId: string, index: number, pcm: Buffer, format: AudioFormat): string | null {
    if (!this.options.settings.getStored().diagnosticRecording) return null;
    const dir = path.join(this.options.recordingsDir, 'ai-diagnostic');
    fs.mkdirSync(dir, { recursive: true });
    const limited = pcm.subarray(0, MAX_DIAGNOSTIC_SECONDS * format.sampleRate * 2);
    const safeCall = callId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
    const file = path.join(dir, `${safeCall}_${String(index).padStart(3, '0')}.wav`);
    fs.writeFileSync(file, buildWav(limited, { ...format, verified: true }), { flag: 'w' });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
    files.sort((a, b) => a.t - b.t);
    for (const old of files.slice(0, Math.max(0, files.length - MAX_DIAGNOSTIC_FILES))) fs.rmSync(path.join(dir, old.f), { force: true });
    return file;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** Minimal PCM WAV reader: 16-bit mono only, anything else is refused rather than reinterpreted. */
export function parseWav(data: Buffer): { pcm: Buffer; format: AudioFormat } {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new SettingsError('not a WAV file');
  }
  let offset = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= data.length) {
      fmt = { tag: data.readUInt16LE(body), channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new SettingsError('WAV has no fmt chunk before its data');
      if (fmt.tag !== 1 || fmt.channels !== 1 || fmt.bits !== 16) {
        throw new SettingsError('only 16-bit mono PCM WAV files can be transcribed');
      }
      if (fmt.rate < 8000 || fmt.rate > 48000) throw new SettingsError(`unsupported sample rate ${fmt.rate}`);
      const end = Math.min(data.length, body + size);
      return {
        pcm: data.subarray(body, end - ((end - body) % 2)),
        format: { sampleRate: fmt.rate, channels: 1, bitDepth: 16, endianness: 'little-endian' },
      };
    }
    offset = body + size + (size % 2);
  }
  throw new SettingsError('WAV has no data chunk');
}

/** The provider's own authenticated, read-only listing endpoint, used only to check a key. */
export function credentialProbe(
  name: string,
  key: string,
  cartesiaVersion?: string
): { url: string; headers: Record<string, string> } {
  switch (name) {
    case 'DEEPGRAM_API_KEY':
      return { url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${key}` } };
    case 'GROQ_API_KEY':
      return { url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${key}` } };
    case 'OPENAI_API_KEY':
      return { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } };
    case 'TELNYX_API_KEY':
      return { url: 'https://api.telnyx.com/v2/ai/openai/models', headers: { Authorization: `Bearer ${key}` } };
    case 'CARTESIA_API_KEY':
      return {
        url: 'https://api.cartesia.ai/voices?limit=1',
        headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': cartesiaVersion ?? '2026-08-14' },
      };
    default:
      throw new SettingsError(`Unknown credential '${name}'`, 404);
  }
}
