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
import { ConversationEvent, ConversationSession, SessionTotals, TraceInput, TurnResult } from './conversation.js';
import { IdleManager, idleMessages } from './idle.js';
import { AudioMeter } from './meter.js';
import { TraceHub } from './trace.js';
import { AiUsageStore } from './usage-store.js';
import { assessUtterance, EnergyEndpointer } from './endpointer.js';
import { GatewayAudioSink, GatewayAudioSource } from './gateway-adapters.js';
import { ProviderSet } from './providers/types.js';
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
  configResult: AiConfigResult;
  manager: ICallSessionManager;
  audio: IAudioAdapter;
  /** Built when a call is attached, so provider keys are read then and a bad key fails only that call. */
  createProviders: () => ProviderSet;
  /** Fresh readiness at attach time. */
  readiness: () => AiReadiness;
  eventBus?: GatewayEventBus;
  /** Test seam: replace the SIM7600EI transport with fixtures. Defaults to the gateway adapters. */
  transports?: (call: CallSession, format: AudioFormat) => { source: CallerAudioSource; sink: AgentAudioSink };
  /** True while something else (PCM verification) is writing to the audio port. */
  audioPortBusy?: () => boolean;
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
  createFullProviders?: () => ProviderSet;
  /** Test seam: shorter idle waits. */
  idleWaitsMs?: readonly [number, number, number];
  /** Test seam: the per-call AI time limit in ms (production uses AI_MAX_CALL_SECONDS). */
  callLimitMs?: number;
}

interface Attached {
  callId: string;
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
  private readonly armed = new Set<string>();
  private readonly waiting = new Map<string, { timer: NodeJS.Timeout; since: number; blockers: string }>();
  private started = false;
  private readonly onState = (event: CallStateChangeEvent) => this.handleStateChanged(event);
  private readonly onEnded = (session: CallSession) => {
    this.limited.delete(session.id);
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

  private startIdle(entry: Attached): void {
    if (!this.config.automation.idleFollowUps || entry.idle || entry.session.isPassive || entry.session.isClosed) return;
    const messages = idleMessages(this.config.language);
    entry.idle = new IdleManager({
      followups: messages.followups,
      goodbye: messages.goodbye,
      say: (text) => entry.session.say(text),
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
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.deps.manager.off('call:state_changed', this.onState);
    this.deps.manager.off('call:ended', this.onEnded);
    await Promise.all([...this.attached.keys()].map((id) => this.detach(id, 'orchestrator-stopped')));
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
    if (!this.canRun) {
      const reasons = this.mode === 'active' ? this.deps.configResult.errors : this.deps.configResult.selectionErrors;
      const keyReason = this.mode === 'passive' && this.deps.configResult.sttKeyEnv && this.deps.configResult.missingKeys.includes(this.deps.configResult.sttKeyEnv)
        ? [`${this.deps.configResult.sttKeyEnv} is required by the selected providers but is not set`]
        : [];
      throw new AiNotReadyError([...reasons, ...keyReason].length ? [...reasons, ...keyReason] : ['AI is not enabled']);
    }
    const call = this.deps.manager.getCurrentCall();
    if (!call || call.id !== callId) {
      throw new Error('Only the current call can be armed');
    }
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
      endpointSilenceMs: this.config.vad.minSilenceMs,
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
    if (enabled && this.deps.createFullProviders) entry.session.upgradeProviders(this.deps.createFullProviders());
    entry.conversationEnabled = enabled;
    entry.session.setPassive(!enabled && this.mode !== 'active');
    if (enabled) {
      // The silence clock starts after the first real exchange, not the moment the operator clicks.
    } else {
      entry.idle?.stop();
      entry.idle = null;
      entry.session.interrupt();
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
        ttsChars: m.ttsChars,
        selection: { stt: this.config.stt.key, llm: this.config.llm.key, tts: this.config.tts.key },
        mock: this.deps.providersAreMock === true,
        // Text only exists on the result while the operator enabled transcripts.
        transcript: result.transcript ?? null,
        reply: result.reply ?? null,
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
    if (!this.canRun || !this.eligible(call) || this.limited.has(call.id)) return;
    if (this.attached.has(call.id) || this.waiting.has(call.id)) return;
    this.tryAttach(call);
  }

  /**
   * Attach if ready. USB audio is registered after the call connects, so an eligible call that is not
   * ready yet is re-checked until it is, the call ends, or the wait runs out; the reasons are reported
   * whenever they change, never every poll.
   */
  private tryAttach(call: CallSession): void {
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

    let providers: ProviderSet;
    try {
      assertEnginePcm(format);
      providers = this.deps.createProviders();
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
          sink: new GatewayAudioSink(this.deps.audio, format, this.config.audio.outboundVerified, isLive),
        };

    const session = new ConversationSession({
      callId: call.id,
      config: this.config,
      providers,
      sink,
      passive: this.mode !== 'active',
      emit: (event) => this.handleConversationEvent(call.id, event),
      trace: (event) => this.publish(call.id, event),
    });

    const entry: Attached = {
      callId: call.id,
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
    };

    entry.endpointer = new EnergyEndpointer(format, this.config.vad, {
      onSpeechStart: () => {
        entry.idle?.pause(); // someone is talking: the silence clock stops
        if (this.config.bargeIn.enabled && session.isBusy) session.interrupt();
      },
      onUtterance: (pcm, info) => {
        const id = `${call.id}:${++entry.utterances}`;
        this.logger.debug(`utterance ${id} ready (${Math.round(info.durationMs)} ms, ${info.reason})`);
        try {
          this.deps.onUtteranceAudio?.(call.id, entry.utterances, pcm, format);
        } catch (error) {
          this.logger.warn(`Diagnostic recording failed: ${(error as Error).message}`);
        }
        void session.handleUtterance(pcm, id);
      },
    });
    entry.unsubscribe = source.onAudio((pcm) => {
      entry.meter.feed(pcm);
      // Half-duplex: while the agent speaks (and just after) what arrives may be the agent's own voice coming
      // back through the caller's phone. It is measured but not transcribed, and any half-heard utterance is dropped.
      if (session.isDeaf()) {
        if (!entry.deaf) {
          entry.deaf = true;
          entry.endpointer.reset();
        }
        entry.ignoredBytes += pcm.length;
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
      data: { simulated: entry.isSimulated, sampleRate: format.sampleRate },
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
      const greeting = this.config.greeting ? session.say(this.config.greeting) : Promise.resolve();
      // The silence clock starts after the greeting, as in the source project.
      void Promise.resolve(greeting).finally(() => this.startIdle(entry));
    }
  }

  private async detach(callId: string, reason: string): Promise<void> {
    const entry = this.attached.get(callId);
    this.armed.delete(callId);
    this.stopWaiting(callId);
    if (!entry) return;
    this.attached.delete(callId);
    entry.idle?.stop();
    if (entry.limitTimer) clearTimeout(entry.limitTimer);
    entry.unsubscribe();
    // An utterance still being spoken when the call ends is dropped, not processed.
    entry.endpointer.reset();
    await entry.session.close(reason);
    this.logger.info(`AI agent detached from the call (${reason})`);
    this.publish(callId, { turnId: null, stage: 'call', status: 'ok', detail: `AI detached (${reason})` });
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
          // Real words from the caller reset the count; anything else (including our own follow-up) just restarts the clock.
          if ((event.result.transcriptChars ?? 0) > 0) entry.idle.resetOnUserSpeech();
          else entry.idle.start();
        }
        this.logger.info(
          `AI turn ${event.result.turnId} ${event.result.status}${event.result.reason ? ` (${event.result.reason})` : ''}: stt=${fmt(event.result.metrics.sttMs)} llmFirst=${fmt(event.result.metrics.llmFirstTokenMs)} ttsFirst=${fmt(event.result.metrics.ttsFirstMs)} total=${fmt(event.result.metrics.totalMs)} ms`
        );
        break;
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
