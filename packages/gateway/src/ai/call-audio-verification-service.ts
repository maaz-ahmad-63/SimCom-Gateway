import type { CallSession, CallStateChangeEvent, UrcEvent } from '@sim-gateway/shared';
import { isDtmfUrc } from '../adapters/modem/at-parser.js';
import type { AudioVerificationStore, AudioVerificationSummary } from './audio-verification-store.js';
import { CallAudioVerification, CallAudioVerifier, sanitize, TurnObservation, VerificationAspect, VerifierThresholds } from './call-audio-verifier.js';
import type { ConversationEvent, TurnResult } from './conversation.js';

/**
 * Runs one CallAudioVerifier per call, fed only by events that already exist: call state changes, the AI conversation's turn
 * results and sink errors, the modem's DTMF reports and a periodic look at the USB audio wire state. It listens; it never writes
 * audio, sends AT commands or changes a call. Every change is saved, logged (sanitized) and pushed to listeners (the socket).
 */

export interface AudioVerificationEvents {
  on(event: 'call:state_changed', listener: (e: CallStateChangeEvent) => void): unknown;
  on(event: 'call:ended', listener: (s: CallSession) => void): unknown;
  off(event: 'call:state_changed', listener: (e: CallStateChangeEvent) => void): unknown;
  off(event: 'call:ended', listener: (s: CallSession) => void): unknown;
}
export interface ConversationSource {
  on(event: 'conversation', listener: (e: ConversationEvent) => void): unknown;
  off(event: 'conversation', listener: (e: ConversationEvent) => void): unknown;
}
export interface UrcSource {
  on(event: 'urc', listener: (urc: UrcEvent) => void): unknown;
  off(event: 'urc', listener: (urc: UrcEvent) => void): unknown;
}

export interface AudioVerificationServiceDeps {
  events: AudioVerificationEvents;
  conversations: ConversationSource;
  modem?: UrcSource;
  /** The USB audio wire state of the current call ('flowing', 'stalled', ...). */
  wireState: () => string | undefined;
  /** The AI pipeline currently has a live session on the active call. */
  pipelineActive: () => boolean;
  /** Automatic verification is on (AI_AUDIO_AUTO_VERIFY, default true). Read at the start of each call. */
  enabled: () => boolean;
  /** Real hardware AND real providers; anything simulated can never be verified. */
  simulated: () => boolean;
  store?: AudioVerificationStore | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  alert?: (level: 'info' | 'warn', message: string) => void;
  pollMs?: number;
  now?: () => Date;
  thresholds?: Partial<VerifierThresholds>;
}

const ASPECT_LABEL: Record<VerificationAspect, string> = { inbound: 'caller audio intelligibility', transport: 'agent audio transport', audibility: 'agent audio remote audibility' };

export function observeTurn(r: TurnResult): TurnObservation {
  return {
    status: r.status,
    reason: r.reason,
    utterance: r.assessment?.decision,
    transcriptWords: r.transcriptWords,
    sttConfidence: r.sttConfidence ?? null,
    callerReportsNotHearing: r.callerReportsNotHearing === true,
    bytesWritten: r.metrics.bytesWritten ?? 0,
    playbackCompleted: r.metrics.playbackCompleted ?? undefined,
    playbackStoppedBy: r.metrics.playbackStoppedBy ?? null,
    underruns: r.metrics.underruns ?? 0,
    riskFrames: r.metrics.riskFrames,
    lateFrames: r.metrics.lateFrames,
    slowWrites: r.metrics.slowWrites ?? 0,
  };
}

export class CallAudioVerificationService {
  private readonly active = new Map<string, CallAudioVerifier>();
  private last: CallAudioVerification | null = null;
  private readonly listeners = new Set<(v: CallAudioVerification) => void>();
  private timer: NodeJS.Timeout | null = null;
  /** Consecutive finished calls in which each aspect failed: a warning is raised when it repeats. */
  private readonly failStreak: Record<VerificationAspect, number> = { inbound: 0, transport: 0, audibility: 0 };
  private started = false;

  constructor(private readonly deps: AudioVerificationServiceDeps) {}

  private readonly onState = (e: CallStateChangeEvent): void => {
    try {
      if (e.currentState === 'IDLE' || e.currentState === 'TERMINATING') return;
      let v = this.active.get(e.callId);
      if (!v) {
        if (!this.deps.enabled()) return;
        v = new CallAudioVerifier(e.callId, { direction: e.session?.direction ?? null, simulated: this.deps.simulated(), now: this.deps.now, thresholds: this.deps.thresholds });
        this.active.set(e.callId, v);
        this.deps.log?.('info', `call audio verification started for call ${e.callId}`);
        this.changed(v);
      }
      if (e.currentState === 'ACTIVE') {
        v.callActive();
        this.changed(v);
      }
    } catch (err) {
      this.deps.log?.('error', `call audio verification: ${sanitize((err as Error).message)}`);
    }
  };

  private readonly onEnded = (s: CallSession): void => {
    const v = this.active.get(s.id);
    if (!v) return;
    v.callEnded();
    this.active.delete(s.id);
    this.changed(v);
    this.reportFinal(v.snapshot());
  };

  private readonly onConversation = (e: ConversationEvent): void => {
    const v = this.active.get(e.callId);
    if (!v) return;
    v.pipelineAttached();
    if (e.type === 'turn') v.turn(observeTurn(e.result));
    else if (e.type === 'error' && e.stage === 'sink') v.transportError(e.message);
    else return;
    this.changed(v);
  };

  private readonly onUrc = (urc: UrcEvent): void => {
    if (!isDtmfUrc(urc)) return; // the modem's own DTMF report (+RXDTMF); the digit is never logged
    for (const v of this.active.values()) {
      v.remoteKey(urc.payload.digit);
      this.changed(v);
    }
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.events.on('call:state_changed', this.onState);
    this.deps.events.on('call:ended', this.onEnded);
    this.deps.conversations.on('conversation', this.onConversation);
    this.deps.modem?.on('urc', this.onUrc);
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.events.off('call:state_changed', this.onState);
    this.deps.events.off('call:ended', this.onEnded);
    this.deps.conversations.off('conversation', this.onConversation);
    this.deps.modem?.off('urc', this.onUrc);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sample the wire and whether the AI pipeline is attached, for every call that is active. */
  poll(): void {
    for (const v of this.active.values()) {
      const before = JSON.stringify(v.snapshot());
      if (this.deps.pipelineActive()) v.pipelineAttached();
      v.wireState(this.deps.wireState());
      if (JSON.stringify(v.snapshot()) !== before) this.changed(v);
    }
  }

  onUpdate(listener: (v: CallAudioVerification) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The call in progress, else the most recently finished call. Null when there has been none (or verification is off). */
  current(): CallAudioVerification | null {
    const live = [...this.active.values()].at(-1);
    return live ? live.snapshot() : this.last;
  }

  get(callId: string): CallAudioVerification | null {
    const live = this.active.get(callId);
    if (live) return live.snapshot();
    if (this.last?.callId === callId) return this.last;
    return this.deps.store?.get(callId) ?? null;
  }

  recent(limit = 20): AudioVerificationSummary[] {
    return this.deps.store?.recent(limit) ?? [];
  }

  /** Arm the diagnostic key-press test on a call in progress. Returns false when that call is not being verified. */
  armKeyTest(callId: string, key: string, windowMs?: number): boolean {
    const v = this.active.get(callId);
    if (!v) return false;
    v.armKeyTest(key, windowMs);
    this.changed(v);
    return true;
  }

  private changed(v: CallAudioVerifier): void {
    const snap = v.snapshot();
    if (snap.final) this.last = snap;
    try {
      this.deps.store?.save(snap);
    } catch (err) {
      this.deps.log?.('error', `could not save the call audio verification of call ${snap.callId}: ${sanitize((err as Error).message)}`);
    }
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* a listener's failure is not the verifier's */
      }
    }
  }

  private reportFinal(v: CallAudioVerification): void {
    const line = (['inbound', 'transport', 'audibility'] as const).map((a) => `${a}=${v[a].status}`).join(' ');
    this.deps.log?.(v.inbound.status === 'failed' || v.transport.status === 'failed' ? 'warn' : 'info', `call audio verification for call ${v.callId}: ${line}`);
    for (const a of ['inbound', 'transport', 'audibility'] as const) {
      if (v[a].status === 'failed') {
        this.failStreak[a]++;
        this.deps.log?.('warn', `${ASPECT_LABEL[a]} FAILED on call ${v.callId}: ${sanitize(v[a].reason)}`);
        if (this.failStreak[a] >= 2) {
          this.deps.alert?.('warn', `Call audio check: ${ASPECT_LABEL[a]} failed on ${this.failStreak[a]} calls in a row (latest: ${sanitize(v[a].reason)}). Calling continues; check the audio path.`);
        }
      } else if (v[a].status === 'verified') {
        this.failStreak[a] = 0;
      }
    }
  }
}
