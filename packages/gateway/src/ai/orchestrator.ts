import { EventEmitter } from 'node:events';
import {
  AiConversationView,
  AiMode,
  AiSessionView,
  CallSession,
  CallStateChangeEvent,
  IAudioAdapter,
  ICallSessionManager,
} from '@sim-gateway/shared';
import { createLogger } from '../core/logger.js';
import { GatewayEventBus } from '../core/event-bus.js';
import { AgentAudioSink, assertEnginePcm, AudioFormat, CallerAudioSource } from './audio.js';
import { AiConfig, AiConfigResult, describeConfig } from './config.js';
import { ConversationEvent, ConversationSession, ConversationTools, SessionTotals, TraceInput, TurnResult } from './conversation.js';
import { agentFor } from './directions.js';
import type { ToolRegistry } from './tools/registry.js';
import { IdleManager, idleActionAfterTurn, idleMessages } from './idle.js';
import { AudioMeter } from './meter.js';
import { TraceHub } from './trace.js';
import { createLoopLag, LoopLag } from './loop-lag.js';
import { activeRegistry } from './registry/active.js';
import { AiUsageStore } from './usage-store.js';
import { BargeInDetector } from './barge-in.js';
import { assessUtterance, EnergyEndpointer, SpeechDetector } from './endpointer.js';
import { loadSileroSession, SileroSession, SileroSpeechDetector } from './vad/silero.js';
import { KnowledgeProvider, LocalKnowledgeBase } from './knowledge.js';
import { GatewayAudioSink, GatewayAudioSource } from './gateway-adapters.js';
import { ProviderSet, StreamingSttProvider, SttStream } from './providers/types.js';
import { AiReadiness } from './readiness.js';

/** How often, and for how long, an eligible call waits for readiness (USB audio is activated after the call connects). */
const READINESS_POLL_MS = 500;
const READINESS_GIVE_UP_MS = 120_000;

export class AiNotReadyError extends Error {
  constructor(readonly blockers: string[]) {
    super(`AI agent is not ready: ${blockers.join(' | ')}`);
    this.name = 'AiNotReadyError';
  }
}

export interface OrchestratorDeps {
  /** Per-call details (a campaign contact) and an optional greeting for that call only; null for an ordinary call. */
  callContext?: (call: CallSession) => {
    contextBlock: string;
    greeting?: string | null;
    campaignId: string;
    contactId: number;
    /** A campaign's own prompt: when present it is this call's whole system prompt (see campaigns/campaign-agent.ts). */
    systemPrompt?: string;
    /** A Model Hub model for this call, or null/absent for the gateway's selected one. */
    llmKey?: string | null;
    promptCacheKey?: string;
  } | null;
  /** The person on a campaign call clearly asked not to be called again. Must not throw. */
  onOptOut?: (call: CallSession) => void;
  /** Functions the model may call, and the rule that stops anything being recorded for a call's person. Absent: no tools. */
  tools?: { registry: ToolRegistry; restriction: (call: CallSession) => string | null };
  configResult: AiConfigResult;
  manager: ICallSessionManager;
  audio: IAudioAdapter;
  /** Built when a call is attached, so provider keys are read then and a bad key fails only that call. */
  createProviders: (options?: { llmKey?: string }) => ProviderSet;
  /** Fresh readiness at attach time. */
  readiness: () => AiReadiness;
  eventBus?: GatewayEventBus;
  /** Test seam: replace the SIM7600EI transport with fixtures. Defaults to the gateway adapters. */
  transports?: (call: CallSession, format: AudioFormat) => { source: CallerAudioSource; sink: AgentAudioSink };
  /** True while something else (PCM verification) is writing to the audio port. */
  audioPortBusy?: () => boolean;
  /**
   * True while the IVR owns this call: the AI must not attach to it (nor be armed on it) until the IVR hands it over. Absent, or
   * false for every call, leaves attaching exactly as it was.
   */
  callHeld?: (call: CallSession) => boolean;
  /** Runtime mode: 'passive' only transcribes; 'active' also replies. Read at every decision, so it can change mid-call. */
  mode?: () => AiMode;
  /** Inspector feed. */
  hub?: TraceHub;
  /** Per-turn log and usage totals. */
  usage?: AiUsageStore;
  /** True when the providers are offline mocks: logged, never counted as usage or cost. */
  providersAreMock?: boolean;
  /** A real transcript came back for this call (evidence for the operator's inbound-audio attestation). */
  onTranscript?: (callId: string, chars: number, isSimulated: boolean) => void;
  /** Optional operator-enabled diagnostic recording of each captured utterance. */
  onUtteranceAudio?: (callId: string, index: number, pcm: Buffer, format: AudioFormat) => void;
  /** Providers for all three stages, built when the operator switches conversation on for a call. */
  createFullProviders?: (options?: { llmKey?: string }) => ProviderSet;
  /** Test seam: shorter idle waits. */
  idleWaitsMs?: readonly [number, number, number];
  /** Test seam: the per-call AI time limit in ms (production uses AI_MAX_CALL_SECONDS). */
  callLimitMs?: number;
  /** Replace the folder-based company knowledge with another KnowledgeProvider (a vector store, a service). */
  knowledge?: KnowledgeProvider | null;
  /** Test seam: replace the Silero model loader (the real one needs onnxruntime-node and a model file). */
  loadSilero?: (modelPath: string) => Promise<SileroSession>;
}

interface Attached {
  callId: string;
  /** The model a campaign chose for this call (null: the gateway's selected model). Fixed when the call was attached. */
  llmKey: string | null;
  /** The operator switched conversation on for this call (per call, never inherited). */
  conversationEnabled: boolean;
  deaf: boolean;
  ignoredBytes: number;
  idle: IdleManager | null;
  limitTimer: NodeJS.Timeout | null;
  announcedMode: AiMode;
  isSimulated: boolean;
  meter: AudioMeter;
  sink: AgentAudioSink;
  session: ConversationSession;
  endpointer: EnergyEndpointer;
  unsubscribe: () => void;
  utterances: number;
  lastTurn: TurnResult | null;
  hangupRequested: boolean;
  attachedAt: string;
  /** Listens for the caller talking over the agent while half-duplex discards that audio (null when not applicable). */
  barge: BargeInDetector | null;
  /** The most recent audio heard while deaf, so the first words of an interruption are not lost. */
  bargeRing: Buffer[];
  bargeRingBytes: number;
  /** An interruption was acted on and it is not yet known whether it was real speech. */
  bargeAwaitingVerdict: boolean;
  bargeFalse: number;
  bargeDisabled: boolean;
  bargeTimer: NodeJS.Timeout | null;
  /** Streaming recognizer for the utterance in progress (AI_STT_STREAMING); handed to the session at the endpoint. */
  stream: SttStream | null;
  streamAbort: AbortController | null;
  /** The recognizer provider of this call, kept so its spare connection is released when the call ends. */
  streamProvider: StreamingSttProvider | null;
}

export interface AiSessionStatus {
  callId: string;
  attachedAt: string;
  busy: boolean;
  degraded: boolean;
  totals: SessionTotals;
  lastTurn: {
    status: string;
    reason?: string;
    sttMs: number | null;
    llmFirstTokenMs: number | null;
    ttsFirstMs: number | null;
    totalMs: number;
  } | null;
}

/**
 * Binds one ConversationSession to each eligible gateway call.
 *
 * Eligibility is explicit: AI_ENABLED, a usable config, readiness passing, AND either the call was
 * armed by the operator (POST /api/ai/calls/:id/arm) or AI_AUTO_HANDLE matches its direction (default
 * off). The orchestrator only listens to call events and the audio adapter; it never answers, dials
 * or hangs up (unless AI_ALLOW_AGENT_HANGUP=true and the agent itself says END_CALL, attempted once),
 * and it sends no AT commands.
 */
export class AiCallOrchestrator extends EventEmitter {
  private readonly logger = createLogger('AiOrchestrator');
  private readonly attached = new Map<string, Attached>();
  /** Created on first attach, stopped with the orchestrator. */
  private loopLag: LoopLag | null = null;
  /** Fixed spoken lines (greeting, follow-ups), kept in memory across calls so they start instantly after the first time. */
  private readonly fixedAudioCache = new Map<string, Buffer>();
  private readonly armed = new Set<string>();
  private readonly waiting = new Map<string, { timer: NodeJS.Timeout; since: number; blockers: string }>();
  private started = false;
  private readonly onState = (event: CallStateChangeEvent) => this.handleStateChanged(event);
  private readonly onEnded = (session: CallSession) => {
    this.limited.delete(session.id);
    this.unattachable.delete(session.id);
    void this.detach(session.id, 'call-ended');
  };

  constructor(private readonly deps: OrchestratorDeps) {
    super();
  }

  private get config(): AiConfig {
    return this.deps.configResult.config;
  }

  /** Without a runtime mode provider (tests, scripts) the orchestrator behaves as the full agent it always was. */
  get mode(): AiMode {
    return this.deps.mode?.() ?? 'active';
  }

  /** Passive needs only a valid selection and an STT key; active needs the whole configuration. */
  private get canRun(): boolean {
    const mode = this.mode;
    if (mode === 'active') return this.deps.configResult.usable;
    return mode === 'passive' && this.deps.configResult.passiveUsable;
  }

  /** Why the configuration cannot run the AI in the current mode (the first thing to fix, in the operator's words). */
  private notRunnableReasons(): string[] {
    const result = this.deps.configResult;
    const reasons = this.mode === 'active' ? result.errors : result.selectionErrors;
    const keyReason = this.mode === 'passive' && result.sttKeyEnv && result.missingKeys.includes(result.sttKeyEnv)
      ? [`${result.sttKeyEnv} is required by the selected providers but is not set`]
      : [];
    const all = [...reasons, ...keyReason];
    return all.length > 0 ? all : ['AI is not enabled'];
  }

  private readyFor(readiness: AiReadiness): boolean {
    return this.mode === 'active' ? readiness.ok : readiness.passiveOk;
  }

  private blockersFor(readiness: AiReadiness): string[] {
    return this.mode === 'active' ? readiness.blockers : readiness.passiveBlockers;
  }

  /** Apply a mode change to calls already being handled. Takes effect from the caller's next utterance. */
  applyMode(): void {
    for (const entry of this.attached.values()) {
      const passive = this.mode !== 'active' && !entry.conversationEnabled;
      entry.session.setPassive(passive);
      if (passive) {
        entry.idle?.stop();
        entry.idle = null;
      } else if (!entry.idle) this.startIdle(entry);
      if (entry.announcedMode !== this.mode) {
        entry.announcedMode = this.mode;
        this.publish(entry.callId, { turnId: null, stage: 'call', status: 'ok', detail: `AI mode is now ${this.mode}` });
      }
    }
  }

  /** Calls whose AI time limit was reached; automatic attachment will not pick them up again. */
  private readonly limited = new Set<string>();
  /** Calls already told (once) that the AI cannot take them because the configuration is unusable. */
  private readonly unattachable = new Set<string>();

  private startIdle(entry: Attached): void {
    if (!this.config.automation.idleFollowUps || entry.idle || entry.session.isPassive || entry.session.isClosed) return;
    const messages = idleMessages(this.config.language);
    entry.idle = new IdleManager({
      followups: messages.followups,
      goodbye: messages.goodbye,
      say: (text) => entry.session.say(text),
      isBusy: () => entry.session.isAgentActive,
      disconnect: () => this.handleIdleTimeout(entry.callId),
      waitsMs: this.deps.idleWaitsMs,
    });
    entry.idle.enable();
    entry.idle.start();
  }

  /** Non-idempotent like END_CALL: at most once, and only when the operator allowed the agent to hang up. */
  private async handleIdleTimeout(callId: string): Promise<void> {
    const entry = this.attached.get(callId);
    if (!entry || entry.hangupRequested) return;
    entry.hangupRequested = true;
    if (!this.config.allowAgentHangup) {
      this.alert('info', 'The caller went silent and the AI said goodbye; not hanging up because AI_ALLOW_AGENT_HANGUP is false');
      return;
    }
    try {
      await this.deps.manager.hangup('AI idle timeout');
    } catch (error) {
      this.alert('error', `AI agent could not hang up after the idle timeout: ${(error as Error).message}`);
    }
  }

  private publish(callId: string, event: TraceInput): void {
    this.deps.hub?.publish(callId, event);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.manager.on('call:state_changed', this.onState);
    this.deps.manager.on('call:ended', this.onEnded);
    this.prepareSilero();
  }

  /** The loaded Silero model, shared by every call (the recurrent state lives in each call's detector). */
  private silero: SileroSession | null = null;

  /**
   * Silero is opt-in (AI_VAD_ENGINE=silero). Loading is asynchronous and may fail (no onnxruntime-node, no model file);
   * either way the energy detector keeps working and the reason is reported once.
   */
  private prepareSilero(): void {
    if (this.config.vad.engine !== 'silero') return;
    const modelPath = this.config.vad.silero.modelPath;
    if (!modelPath) {
      this.alert('warn', 'AI_VAD_ENGINE=silero needs AI_VAD_SILERO_MODEL (the path of silero_vad.onnx): using the energy detector');
      return;
    }
    const load = this.deps.loadSilero ?? loadSileroSession;
    void load(modelPath).then(
      (session) => {
        this.silero = session;
        this.logger.info('Silero VAD model loaded');
      },
      (error) => this.alert('warn', `Silero VAD is unavailable (${(error as Error).message}): using the energy detector`)
    );
  }

  private speechDetectorFor(format: AudioFormat): SpeechDetector | null {
    if (this.config.vad.engine !== 'silero') return null;
    if (!this.silero) {
      this.alert('warn', 'Silero VAD is not loaded: this call uses the energy detector');
      return null;
    }
    return new SileroSpeechDetector({
      session: this.silero,
      inputRate: format.sampleRate,
      threshold: this.config.vad.silero.threshold,
      onError: (error) => this.alert('warn', `Silero VAD failed (${error.message}): falling back to the energy detector for this call`),
    });
  }

  /** Release the streaming recognizer of an utterance that is being discarded or abandoned. */
  private closeStream(entry: Attached): void {
    entry.streamAbort?.abort();
    entry.stream?.close();
    entry.stream = null;
    entry.streamAbort = null;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.deps.manager.off('call:state_changed', this.onState);
    this.deps.manager.off('call:ended', this.onEnded);
    await Promise.all([...this.attached.keys()].map((id) => this.detach(id, 'orchestrator-stopped')));
    this.loopLag?.stop();
    this.loopLag = null;
    for (const id of [...this.waiting.keys()]) this.stopWaiting(id);
    this.armed.clear();
  }

  isAttached(callId: string): boolean {
    return this.attached.has(callId);
  }
  isArmed(callId: string): boolean {
    return this.armed.has(callId);
  }
  /** True while any session may be writing to the audio port. */
  get hasActiveSession(): boolean {
    return this.attached.size > 0;
  }

  /** Mark the current call for AI handling. Refused unless readiness passes right now. */
  async arm(callId: string): Promise<void> {
    if (this.mode === 'off') throw new AiNotReadyError(['AI mode is off']);
    if (!this.canRun) throw new AiNotReadyError(this.notRunnableReasons());
    const call = this.deps.manager.getCurrentCall();
    if (!call || call.id !== callId) {
      throw new Error('Only the current call can be armed');
    }
    // Arming is also what the IVR itself uses to hand a call over, and it releases the call first; anyone else is refused.
    if (this.deps.callHeld?.(call)) throw new AiNotReadyError(['the IVR is handling this call; the AI can take it once the IVR hands it over']);
    const readiness = this.deps.readiness();
    if (!this.readyFor(readiness)) throw new AiNotReadyError(this.blockersFor(readiness));
    this.armed.add(callId);
    this.limited.delete(callId); // an operator asking again is allowed to restart the clock
    if (call.state === 'ACTIVE') this.attach(call);
  }

  async disarm(callId: string): Promise<void> {
    this.armed.delete(callId);
    await this.detach(callId, 'disarmed');
  }

  /** The attached session for a call with what the operator-triggered test response needs; undefined if none. */
  getAttached(callId: string):
    | { session: ConversationSession; sink: AgentAudioSink; meter: ReturnType<AudioMeter['snapshot']> }
    | undefined {
    const a = this.attached.get(callId);
    return a ? { session: a.session, sink: a.sink, meter: a.meter.snapshot(a.utterances, a.session.totals.sttAudioSeconds) } : undefined;
  }

  /** Live view of every attached session, including the audio meters. */
  getSessions(): AiSessionView[] {
    return [...this.attached.values()].map((a) => ({
      callId: a.callId,
      attachedAt: a.attachedAt,
      mode: this.mode,
      busy: a.session.isBusy,
      degraded: a.session.isDegraded,
      isSimulated: a.isSimulated,
      audio: a.meter.snapshot(a.utterances, a.session.totals.sttAudioSeconds),
      totals: { ...a.session.totals },
      conversation: this.conversationView(a),
    }));
  }

  private conversationView(a: Attached): AiConversationView {
    const enabled = (a.conversationEnabled || this.mode === 'active') && !a.session.isPassive;
    const stopped = !enabled || a.session.isDegraded || a.session.isClosed;
    const m = a.lastTurn?.metrics;
    return {
      enabled,
      phase: stopped ? 'stopped' : a.session.phase,
      phaseSince: new Date(a.session.phaseSince).toISOString(),
      halfDuplex: this.config.halfDuplex,
      ignoredWhileSpeakingSeconds: Math.round((a.ignoredBytes / 2 / (this.config.audio.format?.sampleRate ?? 8000)) * 10) / 10,
      // The silence actually waited before the last turn (adaptive endpointing shortens it), else the configured ceiling.
      endpointSilenceMs: m?.timeline?.endpointMs ?? this.config.vad.minSilenceMs,
      lastTurn: a.lastTurn && m
        ? {
            status: a.lastTurn.status,
            reason: a.lastTurn.reason ?? null,
            sttMs: m.sttMs === null ? null : Math.round(m.sttMs),
            llmFirstTokenMs: m.llmFirstTokenMs === null ? null : Math.round(m.llmFirstTokenMs),
            ttsFirstMs: m.ttsFirstMs === null ? null : Math.round(m.ttsFirstMs),
            playMs: m.playMs ? Math.round(m.playMs) : null,
            firstAudioMs: m.firstAudioMs === null ? null : Math.round(m.firstAudioMs),
            totalMs: Math.round(m.totalMs),
            lateFrames: m.lateFrames,
          }
        : null,
      lastError: a.session.lastError,
    };
  }

  /**
   * Operator-controlled, per call: let the agent answer and speak (listen -> transcribe -> generate -> speak ->
   * listen) without a click per turn. Off again with enabled=false, which also cuts off anything being said.
   * The caller's gateway-level safeguards (readiness, confirmation) are checked by the runtime before this.
   */
  setConversation(callId: string, enabled: boolean): void {
    const entry = this.attached.get(callId);
    if (!entry) throw new Error('The AI is not attached to this call');
    if (enabled && this.deps.createFullProviders) entry.session.upgradeProviders(this.deps.createFullProviders(entry.llmKey ? { llmKey: entry.llmKey } : undefined));
    entry.conversationEnabled = enabled;
    entry.session.setPassive(!enabled && this.mode !== 'active');
    if (enabled) {
      // The silence clock starts after the first real exchange, not the moment the operator clicks.
    } else {
      entry.idle?.stop();
      entry.idle = null;
      entry.session.interrupt('manual');
    }
    this.publish(callId, { turnId: null, stage: 'call', status: 'ok', detail: enabled ? 'Conversation mode ON for this call (operator)' : 'Conversation mode OFF for this call (operator)' });
  }

  private recordTurn(callId: string, result: TurnResult, entry: Attached | undefined): void {
    if (result.turnId === 0) return; // duplicate / closed-session bookkeeping, not a real turn
    const m = result.metrics;
    const sttSubmitted = m.sttMs !== null || result.reason === 'stt-failed' || result.reason === 'aborted-during-stt';
    try {
      this.deps.usage?.record({
        callId,
        status: result.status,
        reason: result.reason ?? null,
        sttMs: m.sttMs,
        llmFirstTokenMs: m.llmFirstTokenMs,
        ttsFirstMs: m.ttsFirstMs,
        totalMs: m.totalMs,
        utteranceMs: m.utteranceMs,
        sttSeconds: sttSubmitted ? m.utteranceMs / 1000 : 0,
        llmPromptTokens: m.usage?.promptTokens ?? null,
        llmCompletionTokens: m.usage?.completionTokens ?? null,
        llmCachedTokens: m.usage?.cachedPromptTokens ?? null,
        llmCacheWriteTokens: m.usage?.cacheWriteTokens ?? null,
        ttsChars: m.ttsChars,
        selection: { stt: this.config.stt.key, llm: entry?.llmKey ?? this.config.llm.key, tts: this.config.tts.key },
        mock: this.deps.providersAreMock === true,
        // Text only exists on the result while the operator enabled transcripts.
        transcript: result.transcript ?? null,
        reply: result.reply ?? null,
        firstAudioMs: m.firstAudioMs,
        perceivedFirstAudioMs: m.perceivedFirstAudioMs,
        endpointMs: m.timeline?.endpointMs ?? null,
        sttWaitedMs: m.sttWaitedMs,
        // Whether a speculative transcript was used only means something when speech-to-text was part of this turn.
        speculativeStt: sttSubmitted ? m.speculativeStt : null,
        // Frame counts only describe a turn that actually played audio; a turn with no playback has none to report.
        lateFrames: m.firstAudioMs === null ? null : m.lateFrames,
        riskFrames: m.firstAudioMs === null ? null : m.riskFrames,
        knowledgeHits: m.knowledgeHits,
        turnRef: `${callId}:t${result.turnId}`,
        llmTotalMs: m.llmTotalMs,
        // Only a stage that ran has a duration: a turn that never reached synthesis or playback records null, not 0.
        ttsTotalMs: m.ttsFirstMs === null ? null : m.ttsTotalMs,
        playMs: m.firstAudioMs === null ? null : m.playMs,
        tftAvailable: m.tftAvailable,
        sttMode: m.sttMode,
        // Jitter only describes a turn that played audio; the loop stall is for the whole turn.
        maxLateMs: m.firstAudioMs === null ? null : m.maxLateMs,
        loopLagMaxMs: m.loopLagMaxMs,
        cancelSource: result.cancelSource ?? null,
      });
    } catch (error) {
      this.logger.warn(`Could not record AI turn: ${(error as Error).message}`);
    }
    if (!this.deps.providersAreMock && (result.transcriptChars ?? 0) > 0 && result.assessment?.decision === 'ok') {
      this.deps.onTranscript?.(callId, result.transcriptChars ?? 0, entry?.isSimulated ?? false);
    }
  }

  getStatus(): Record<string, unknown> {
    const sessions: AiSessionStatus[] = [...this.attached.values()].map((a) => ({
      callId: a.callId,
      attachedAt: a.attachedAt,
      busy: a.session.isBusy,
      degraded: a.session.isDegraded,
      totals: { ...a.session.totals },
      lastTurn: a.lastTurn
        ? {
            status: a.lastTurn.status,
            reason: a.lastTurn.reason,
            sttMs: a.lastTurn.metrics.sttMs,
            llmFirstTokenMs: a.lastTurn.metrics.llmFirstTokenMs,
            ttsFirstMs: a.lastTurn.metrics.ttsFirstMs,
            totalMs: a.lastTurn.metrics.totalMs,
          }
        : null,
    }));
    return {
      enabled: this.config.enabled,
      usable: this.deps.configResult.usable,
      errors: this.deps.configResult.errors,
      warnings: this.deps.configResult.warnings,
      config: describeConfig(this.config),
      armed: [...this.armed],
      sessions,
    };
  }

  // ---------------------------------------------------------------------------

  private eligible(call: CallSession): boolean {
    if (this.armed.has(call.id)) return true;
    const mode = this.config.autoHandle;
    return mode === 'all' || mode === call.direction;
  }

  private handleStateChanged(event: CallStateChangeEvent): void {
    if (event.currentState !== 'ACTIVE') return;
    const call = event.session;
    if (this.deps.callHeld?.(call)) return; // the IVR owns this call: no attach, and no alert about it
    if (!this.eligible(call) || this.limited.has(call.id)) return;
    if (!this.canRun) {
      // Switched off on purpose is silent; an invalid configuration is not, or a call would just never get an agent.
      if (this.mode !== 'off' && !this.unattachable.has(call.id)) {
        this.unattachable.add(call.id);
        this.alert('error', `AI agent not attached: ${this.notRunnableReasons().join('; ')}`);
      }
      return;
    }
    if (this.attached.has(call.id) || this.waiting.has(call.id)) return;
    this.tryAttach(call);
  }

  /**
   * Attach if ready. USB audio is registered after the call connects, so an eligible call that is not
   * ready yet is re-checked until it is, the call ends, or the wait runs out; the reasons are reported
   * whenever they change, never every poll.
   */
  private tryAttach(call: CallSession): void {
    if (this.deps.callHeld?.(call)) {
      this.stopWaiting(call.id); // also ends a retry loop that was already running when the IVR took the call
      return;
    }
    const readiness = this.deps.readiness();
    if (this.readyFor(readiness)) {
      this.stopWaiting(call.id);
      this.attach(call);
      return;
    }
    const blockers = this.blockersFor(readiness).join(' | ');
    let entry = this.waiting.get(call.id);
    if (!entry) {
      const timer = setInterval(() => {
        const current = this.deps.manager.getCurrentCall();
        if (!current || current.id !== call.id || current.state !== 'ACTIVE' || !this.started) {
          this.stopWaiting(call.id);
          return;
        }
        if (Date.now() - (this.waiting.get(call.id)?.since ?? Date.now()) > READINESS_GIVE_UP_MS) {
          this.stopWaiting(call.id);
          this.alert('warn', 'AI agent gave up waiting to attach to the call');
          return;
        }
        this.tryAttach(call);
      }, READINESS_POLL_MS);
      timer.unref?.();
      entry = { timer, since: Date.now(), blockers: '' };
      this.waiting.set(call.id, entry);
    }
    if (entry.blockers !== blockers) {
      entry.blockers = blockers;
      this.alert('warn', `AI agent waiting to attach to the call: ${blockers}`);
    }
  }

  private stopWaiting(callId: string): void {
    const entry = this.waiting.get(callId);
    if (entry) clearInterval(entry.timer);
    this.waiting.delete(callId);
  }

  private alert(level: 'info' | 'warn' | 'error', message: string): void {
    this.logger[level](message);
    this.deps.eventBus?.emit('gateway:alert', { level, message, timestamp: new Date().toISOString() });
  }

  private attach(call: CallSession): void {
    if (this.attached.has(call.id)) return;
    if (this.attached.size > 0) {
      this.alert('warn', 'AI agent not attached: another call already has an AI session');
      return;
    }
    if (this.deps.audioPortBusy?.()) {
      this.alert('warn', 'AI agent not attached: the audio port is in use by a PCM verification test');
      return;
    }
    const format = this.config.audio.format;
    if (!format) {
      this.alert('warn', 'AI agent not attached: AI_AUDIO_SAMPLE_RATE is not set');
      return;
    }

    // What a campaign fixed for THIS call when it was placed (null for any other call), looked up once, before anything is built.
    const callContext = this.deps.callContext?.(call) ?? null;
    let providers: ProviderSet;
    try {
      assertEnginePcm(format);
      providers = this.deps.createProviders(callContext?.llmKey ? { llmKey: callContext.llmKey } : undefined);
    } catch (error) {
      this.alert('error', `AI agent not attached: ${(error as Error).message}`);
      return;
    }

    const isLive = () => {
      const current = this.deps.manager.getCurrentCall();
      return current?.id === call.id && current.state === 'ACTIVE';
    };
    const { source, sink } = this.deps.transports
      ? this.deps.transports(call, format)
      : {
          source: new GatewayAudioSource(this.deps.audio, format, this.config.audio.inboundVerified, isLive),
          sink: new GatewayAudioSink(this.deps.audio, format, this.config.audio.outboundVerified, isLive, {
            leadFrames: this.config.playback.leadFrames,
            prerollMs: this.config.playback.prerollMs,
          }),
        };

    // One voice engine, two configurations: the call's direction picks the instructions and the greeting. A campaign with its own prompt
    // replaces BOTH for its calls: the prompt is the only source of instructions (no outbound or shared instructions are added, and the
    // gateway's global greeting is not spoken); a campaign without one, and every other call, is exactly as before.
    const agent: { systemPrompt: string; greeting: string | null; source: { instructions: string; greeting: string } } = callContext?.systemPrompt
      ? { systemPrompt: callContext.systemPrompt, greeting: null, source: { instructions: 'campaign', greeting: callContext.greeting ? 'campaign' : 'none' } }
      : agentFor(this.config, call.direction);
    const toolsDeps = this.deps.tools;
    const tools: ConversationTools | null = toolsDeps
      ? { registry: toolsDeps.registry, mode: call.direction, campaignId: callContext?.campaignId ?? null, contactId: callContext?.contactId ?? null, restriction: () => toolsDeps.restriction(call) }
      : null;
    const session = new ConversationSession({
      callId: call.id,
      config: { ...this.config, systemPrompt: agent.systemPrompt, greeting: agent.greeting },
      tools,
      providers,
      sink,
      passive: this.mode !== 'active',
      fixedAudioCache: this.fixedAudioCache,
      knowledge: this.knowledgeProvider(),
      loopLag: (this.loopLag ??= createLoopLag()),
      callContext: callContext?.contextBlock ?? null,
      promptCacheKey: callContext?.promptCacheKey ?? null,
      emit: (event) => this.handleConversationEvent(call.id, event),
      trace: (event) => this.publish(call.id, event),
    });

    const entry: Attached = {
      callId: call.id,
      llmKey: callContext?.llmKey ?? null,
      conversationEnabled: false,
      deaf: false,
      ignoredBytes: 0,
      idle: null,
      limitTimer: null,
      announcedMode: this.mode,
      isSimulated: call.isSimulated === true,
      meter: new AudioMeter(format),
      sink,
      session,
      endpointer: undefined as unknown as EnergyEndpointer,
      unsubscribe: () => {},
      utterances: 0,
      lastTurn: null,
      hangupRequested: false,
      attachedAt: new Date().toISOString(),
      barge:
        this.config.halfDuplex && this.config.bargeIn.enabled && this.config.bargeIn.whileSpeaking
          ? new BargeInDetector(format, {
              minMs: this.config.bargeIn.minMs,
              echoMultiplier: this.config.bargeIn.echoMultiplier,
              floor: Math.max(this.config.vad.rmsThreshold * 2, 0.006),
            })
          : null,
      bargeRing: [],
      bargeRingBytes: 0,
      bargeAwaitingVerdict: false,
      bargeFalse: 0,
      bargeDisabled: false,
      bargeTimer: null,
      stream: null,
      streamAbort: null,
      streamProvider: providers.sttStream ?? null,
    };
    providers.sttStream?.warm?.(format); // a connection is ready before the caller's first word, not opened after it

    if (this.config.sttStreaming.enabled && !providers.sttStream) {
      this.alert('warn', 'Streaming speech-to-text is on (AI_STT_STREAMING) but unavailable (no DEEPGRAM_API_KEY): the batch provider is used');
    }
    const speechDetector = this.speechDetectorFor(format);
    const vad = this.config.vad;
    entry.endpointer = new EnergyEndpointer(
      format,
      {
        ...vad,
        speechDetector: speechDetector ?? undefined,
        // Transcribing during the pause only pays off (and only makes sense) when something will be said in reply.
        softSilenceMs: vad.speculativeStt || vad.earlyCommit || providers.sttStream ? vad.softSilenceMs : 0,
      },
      {
        onSpeechStart: () => {
          entry.idle?.pause(); // someone is talking: the silence clock stops
          if (this.config.bargeIn.enabled && session.isBusy) session.interrupt('caller-speech');
        },
        onUtteranceAudio: (pcm, info) => {
          const streaming = providers.sttStream;
          if (!streaming) return;
          if (info.start) {
            this.closeStream(entry);
            entry.streamAbort = new AbortController();
            entry.stream = streaming.open(format, entry.streamAbort.signal);
          }
          entry.stream?.push(pcm);
        },
        onSoftEnd: (pcm, info) => {
          if (entry.stream) {
            // A pause: ask the recognizer to flush what it has, so the final text is nearly ready at the endpoint.
            // The stream replaces the speculative batch request; it can never start a turn.
            entry.stream.flush();
            return;
          }
          if (session.isPassive) return;
          session.beginSpeculative(pcm, info.id);
          if (vad.earlyCommit) void this.tryEarlyCommit(entry, session, info.id, info.durationMs);
        },
        onSoftCancel: (id) => session.cancelSpeculative(id),
        onUtterance: (pcm, info) => {
          const id = `${call.id}:${++entry.utterances}`;
          this.logger.debug(
            `utterance ${id} ready (${Math.round(info.durationMs)} ms, ${info.reason}, silence wait ${Math.round(info.silenceTargetMs)} ms${info.softId !== undefined ? ', speculative transcript available' : ''})`
          );
          try {
            this.deps.onUtteranceAudio?.(call.id, entry.utterances, pcm, format);
          } catch (error) {
            this.logger.warn(`Diagnostic recording failed: ${(error as Error).message}`);
          }
          const verdict = entry.bargeAwaitingVerdict;
          // The streaming recognizer for this utterance now belongs to the session, which releases it.
          const stream = entry.stream ?? undefined;
          entry.stream = null;
          entry.streamAbort = null;
          void session
            .handleUtterance(pcm, id, { speechEndedAt: info.speechEndedAt, endpointedAt: info.endpointedAt, speculativeId: info.softId, afterBargeIn: verdict, stream })
            .then((result) => {
              // After an interruption, an utterance with no speech in it means the interruption was echo or noise.
              if (verdict) this.settleBarge(entry, !['silent', 'too-short', 'unlikely-speech', 'empty-transcript', 'echo'].includes(result.reason ?? ''));
            });
        },
      }
    );
    entry.unsubscribe = source.onAudio((pcm) => {
      entry.meter.feed(pcm);
      // Half-duplex: while the agent speaks (and just after) what arrives may be the agent's own voice coming
      // back through the caller's phone. It is measured but not transcribed, and any half-heard utterance is dropped.
      if (session.isDeaf()) {
        if (!entry.deaf) {
          entry.deaf = true;
          this.closeStream(entry); // the utterance in progress is dropped unheard, and so is its recognizer
          entry.endpointer.reset();
          entry.barge?.reset();
          entry.bargeRing = [];
          entry.bargeRingBytes = 0;
        }
        entry.ignoredBytes += pcm.length;
        // Not transcribed, but not ignored either: sustained speech well above the line's echo is the caller interrupting.
        if (entry.barge && !entry.bargeDisabled) {
          entry.bargeRing.push(pcm);
          entry.bargeRingBytes += pcm.length;
          const keep = Math.round(format.sampleRate * 2 * 0.8);
          while (entry.bargeRingBytes > keep && entry.bargeRing.length > 1) entry.bargeRingBytes -= entry.bargeRing.shift()!.length;
          if (entry.barge.feed(pcm)) this.handleBargeIn(entry, session);
        }
        return;
      }
      entry.deaf = false;
      entry.endpointer.feed(pcm);
    });
    this.attached.set(call.id, entry);
    this.alert('info', `AI agent attached to the call (${this.mode === 'active' ? 'active' : 'passive: transcription only'})`);
    this.publish(call.id, {
      turnId: null,
      stage: 'call',
      status: 'ok',
      detail: `AI attached in ${this.mode === 'active' ? 'active' : 'passive'} mode`,
      data: { simulated: entry.isSimulated, sampleRate: format.sampleRate, direction: call.direction, instructionsFrom: agent.source.instructions, greetingFrom: agent.source.greeting, ...this.selectionFacts(), ...(callContext ? { campaignId: callContext.campaignId, campaignContactId: callContext.contactId } : {}) },
    });

    // Cost bound: the AI lets go of the call after a fixed time. The call itself keeps running.
    const limitMs = this.deps.callLimitMs ?? this.config.automation.maxCallSeconds * 1000;
    entry.limitTimer = setTimeout(() => {
      this.limited.add(call.id);
      this.alert('warn', `AI agent reached its ${this.config.automation.maxCallSeconds} s limit for this call and detached; the call is untouched`);
      void this.detach(call.id, 'time-limit');
    }, limitMs);
    entry.limitTimer.unref?.();

    if (this.mode === 'active') {
      const greetingText = callContext?.greeting ?? agent.greeting;
      const greeting = greetingText ? session.say(greetingText) : Promise.resolve();
      // The silence clock starts after the greeting, as in the source project.
      void Promise.resolve(greeting).finally(() => this.startIdle(entry));
    }
  }

  // ---- turn-taking helpers ----------------------------------------------------------------------------------

  private knowledgeCache: { dir: string; provider: KnowledgeProvider } | null = null;

  /** The configured knowledge source: an injected one, else the folder named by AI_KNOWLEDGE_DIR (loaded once), else none. */
  private knowledgeProvider(): KnowledgeProvider | null {
    if (this.deps.knowledge !== undefined) return this.deps.knowledge;
    const dir = this.config.knowledge.dir;
    if (!dir) return null;
    if (this.knowledgeCache?.dir !== dir) {
      const base = LocalKnowledgeBase.fromDir(dir);
      this.logger.info(`Company knowledge loaded from ${dir}: ${base.size} passage(s)`);
      this.knowledgeCache = { dir, provider: base };
    }
    return this.knowledgeCache.provider;
  }

  /**
   * Answer ahead of the silence wait when the speculative transcript already reads like a finished sentence. Safe to
   * get wrong: a caller who carries on interrupts the reply like any other barge-in, and the two parts are merged.
   */
  private async tryEarlyCommit(entry: Attached, session: ConversationSession, id: number, durationMs: number): Promise<void> {
    const text = await session.speculativeText(id);
    if (!text || entry.endpointer.pendingSoftId !== id) return; // gone, or the caller carried on meanwhile
    if (durationMs < 1000 || text.split(/\s+/).length < 3 || !/[.?!]["')\]]*$/.test(text)) return;
    entry.endpointer.commitEarly();
  }

  /** The caller talked over the agent: stop its speech, stop being deaf, and hand over what was just said. */
  private handleBargeIn(entry: Attached, session: ConversationSession): void {
    this.logger.info(`Barge-in on call ${entry.callId}: the caller talked over the agent`);
    this.publish(entry.callId, {
      turnId: null,
      stage: 'call',
      status: 'ok',
      detail: 'Caller interrupted the agent (barge-in): the reply was stopped and the caller is being listened to',
    });
    session.interrupt('caller-speech');
    session.resumeListening();
    entry.deaf = false;
    this.closeStream(entry);
    entry.endpointer.reset();
    for (const chunk of entry.bargeRing) entry.endpointer.feed(chunk);
    entry.bargeRing = [];
    entry.bargeRingBytes = 0;
    entry.bargeAwaitingVerdict = true;
    if (entry.bargeTimer) clearTimeout(entry.bargeTimer);
    // If no utterance forms within a few seconds the sound was not speech.
    entry.bargeTimer = setTimeout(() => this.settleBarge(entry, false), 6000);
    entry.bargeTimer.unref?.();
  }

  /** An interruption turned out to be speech (real) or not. A few in a row that were not switch the detector off for the call. */
  private settleBarge(entry: Attached, real: boolean): void {
    if (!entry.bargeAwaitingVerdict) return;
    entry.bargeAwaitingVerdict = false;
    if (entry.bargeTimer) clearTimeout(entry.bargeTimer);
    entry.bargeTimer = null;
    if (real) {
      entry.bargeFalse = 0;
      return;
    }
    entry.bargeFalse++;
    if (entry.bargeFalse >= this.config.bargeIn.maxFalseTriggers && !entry.bargeDisabled) {
      entry.bargeDisabled = true;
      this.alert('warn', `Interruption detection switched off for this call: ${entry.bargeFalse} interruptions in a row contained no speech (echo or line noise)`);
    }
  }

  /** The providers and models this call runs with, recorded on the attach event so every call log says what it used. */
  private selectionFacts(): Record<string, string> {
    const c = this.config;
    const registry = activeRegistry();
    const stt = registry.stt(c.stt.key);
    const llm = registry.llm(c.llm.key);
    return {
      sttKey: c.stt.key,
      sttProvider: stt?.vendor ?? c.stt.key,
      sttModel: stt?.model ?? '',
      llmKey: c.llm.key,
      llmProvider: llm?.family ?? llm?.vendor ?? c.llm.key,
      llmModel: llm?.model ?? '',
      ttsKey: c.tts.key,
      ttsProvider: c.tts.key,
      ttsModel: c.tts.model ?? '',
    };
  }

  private async detach(callId: string, reason: string): Promise<void> {
    const entry = this.attached.get(callId);
    this.armed.delete(callId);
    this.stopWaiting(callId);
    if (!entry) return;
    this.attached.delete(callId);
    entry.idle?.stop();
    if (entry.limitTimer) clearTimeout(entry.limitTimer);
    if (entry.bargeTimer) clearTimeout(entry.bargeTimer);
    entry.unsubscribe();
    // An utterance still being spoken when the call ends is dropped, not processed.
    this.closeStream(entry);
    entry.streamProvider?.dispose?.();
    entry.endpointer.reset();
    await entry.session.close(reason);
    this.logger.info(`AI agent detached from the call (${reason})`);
    this.publish(callId, { turnId: null, stage: 'call', status: 'ok', detail: `AI detached (${reason})`, data: { detached: true, reason } });
  }

  private handleConversationEvent(callId: string, event: ConversationEvent): void {
    const entry = this.attached.get(callId);
    this.emit('conversation', event);
    switch (event.type) {
      case 'turn':
        if (entry) entry.lastTurn = event.result;
        this.recordTurn(callId, event.result, entry);
        if (entry && !entry.idle && !entry.session.isPassive && (event.result.transcriptChars ?? 0) > 0) this.startIdle(entry);
        if (entry?.idle?.isEnabled) {
          const action = idleActionAfterTurn(event.result);
          if (action === 'reset') entry.idle.resetOnUserSpeech();
          else if (action === 'restart') entry.idle.start();
        }
        this.logger.info(
          `AI turn ${event.result.turnId} ${event.result.status}${event.result.reason ? ` (${event.result.reason})` : ''}${event.result.cancelSource ? ` [cancelled by ${event.result.cancelSource}]` : ''}: stt=${fmt(event.result.metrics.sttMs)} llmFirst=${fmt(event.result.metrics.llmFirstTokenMs)} ttsFirst=${fmt(event.result.metrics.ttsFirstMs)} total=${fmt(event.result.metrics.totalMs)} firstAudioAfterCallerStopped=${fmt(event.result.metrics.perceivedFirstAudioMs)}${event.result.metrics.speculativeStt ? ' (speculative STT)' : ''}${event.result.metrics.sttFallbackReason ? ` (speech-to-text stream not used: ${event.result.metrics.sttFallbackReason})` : ''}${event.result.metrics.llmEmptyReplies ? ` (model returned an empty reply ${event.result.metrics.llmEmptyReplies}x)` : ''} gapRiskFrames=${event.result.metrics.riskFrames} ms`
        );
        break;
      case 'opt-out': {
        const call = this.deps.manager.getCurrentCall();
        if (call && call.id === callId) {
          try {
            this.deps.onOptOut?.(call);
          } catch (error) {
            this.logger.warn(`Could not record the opt-out request: ${(error as Error).message}`);
          }
          this.alert('info', 'The person on this campaign call asked not to be called again; the number was added to the do-not-call list');
        }
        break;
      }
      case 'error':
        // Provider error text is already scrubbed of credentials; transcripts are never in it.
        this.logger.warn(`AI ${event.stage} error: ${event.message}`);
        break;
      case 'degraded':
        entry?.idle?.stop();
        this.alert('error', `AI agent stopped responding after ${event.consecutiveFailures} consecutive failures; the call is untouched`);
        break;
      case 'recovering':
        this.alert('warn', `AI agent is trying again after ${Math.round(event.afterMs / 1000)} s of provider failures`);
        break;
      case 'end-requested':
        entry?.idle?.stop();
        void this.handleEndRequested(callId);
        break;
    }
  }

  /** Non-idempotent: attempted at most once per call, never retried. */
  private async handleEndRequested(callId: string): Promise<void> {
    const entry = this.attached.get(callId);
    if (!entry || entry.hangupRequested) return;
    entry.hangupRequested = true;
    if (!this.config.allowAgentHangup) {
      this.alert('info', 'AI agent said END_CALL; not hanging up because AI_ALLOW_AGENT_HANGUP is false');
      return;
    }
    try {
      await this.deps.manager.hangup('AI agent ended the call');
    } catch (error) {
      this.alert('error', `AI agent could not hang up: ${(error as Error).message}`);
    }
  }
}

function fmt(ms: number | null): string {
  return ms === null ? '-' : String(Math.round(ms));
}
