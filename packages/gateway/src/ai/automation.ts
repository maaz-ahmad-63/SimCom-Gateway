import { CallSession, CallStateChangeEvent, ICallSessionManager, UrcEvent } from '@sim-gateway/shared';
import { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import { AiConfig } from './config.js';
import type { TraceInput } from './conversation.js';

export interface AutomationDeps {
  manager: ICallSessionManager;
  eventBus: GatewayEventBus;
  /** Always the current effective configuration (settings can change at any time). */
  getConfig: () => { config: AiConfig; passiveUsable: boolean; usable: boolean };
  /** The runtime mode: automation does nothing while it is 'off'. */
  getMode: () => 'off' | 'passive' | 'active';
  /** Connection state of the modem; answering needs a READY modem. */
  modemReady: () => boolean;
  /** True while an AI session already owns a call. */
  hasActiveSession: () => boolean;
  /** Put a marker in the inspector so the operator can read what the automation did and when. */
  mark: (callId: string, event: TraceInput) => void;
  alert: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** How long to wait for audio bytes after USB audio is activated. */
  audioWaitMs?: number;
  pollMs?: number;
}

/**
 * Hands-free call handling for the SIM7600EI, in the order a real call needs it:
 *
 *   incoming ring (counted)  ->  answer once  ->  call ACTIVE  ->  activate USB audio once
 *   ->  wait for audio bytes  ->  (the orchestrator attaches the AI once readiness passes)
 *
 * Every step is opt-in and OFF by default, each is attempted at most once per call, and each outcome is
 * written to the inspector, so a silent failure is impossible. It never speaks and never hangs up; what
 * the AI says is decided by the conversation layer, and only in replies mode.
 */
export class AiCallAutomation {
  private readonly logger = createLogger('AiAutomation');
  private readonly rings = new Map<string, { ring: number; clip: number }>();
  private readonly answered = new Set<string>();
  private readonly activated = new Set<string>();
  private started = false;
  private readonly onUrc = (urc: UrcEvent) => this.handleUrc(urc);
  private readonly onState = (event: CallStateChangeEvent) => void this.handleState(event);
  private readonly onEnded = (session: CallSession) => this.forget(session.id);
  private readonly onStarted = (session: CallSession) => this.handleStarted(session);

  constructor(private readonly deps: AutomationDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.eventBus.on('modem:urc', this.onUrc);
    this.deps.eventBus.on('call:state_changed', this.onState);
    this.deps.eventBus.on('call:ended', this.onEnded);
    this.deps.eventBus.on('call:started', this.onStarted);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.eventBus.off('modem:urc', this.onUrc);
    this.deps.eventBus.off('call:state_changed', this.onState);
    this.deps.eventBus.off('call:ended', this.onEnded);
    this.deps.eventBus.off('call:started', this.onStarted);
    this.rings.clear();
    this.answered.clear();
    this.activated.clear();
  }

  private forget(callId: string): void {
    this.rings.delete(callId);
    this.answered.delete(callId);
    this.activated.delete(callId);
  }

  private get cfg() {
    return this.deps.getConfig();
  }

  /** Does automatic handling cover this call's direction? (AI_AUTO_HANDLE / "Attach automatically to".) */
  private covers(direction: string): boolean {
    const h = this.cfg.config.autoHandle;
    return h === 'all' || h === direction;
  }

  /** Reasons automation must not act on a call, or an empty list if it may. */
  private blockers(direction: 'inbound' | 'outbound'): string[] {
    const { config, passiveUsable, usable } = this.cfg;
    const out: string[] = [];
    if (!config.enabled || this.deps.getMode() === 'off') out.push('the AI agent is off');
    if (!this.covers(direction)) out.push(`automatic attachment is not enabled for ${direction} calls`);
    // Replies mode needs the full configuration; passive transcription only needs speech-to-text.
    if (config.automation.autoReplies ? !usable : !passiveUsable) out.push('the AI configuration or provider keys are incomplete');
    if (!config.audio.format) out.push('the gateway audio sample rate is not set');
    return out;
  }

  // ---- 1. answering -------------------------------------------------------------------------------

  private handleUrc(urc: UrcEvent): void {
    if (urc.type !== 'RING' && urc.type !== 'CLIP') return;
    const { config } = this.cfg;
    if (!config.automation.autoAnswer) return;
    const call = this.deps.manager.getCurrentCall();
    // The very first ring is announced before the call exists; handleStarted counts that one.
    if (!call || call.state !== 'INBOUND_RINGING' || this.answered.has(call.id)) return;

    // The modem repeats RING and +CLIP for every ring; one cycle is whichever count is higher.
    const entry = this.rings.get(call.id) ?? { ring: 0, clip: 0 };
    if (urc.type === 'RING') entry.ring++;
    else entry.clip++;
    this.rings.set(call.id, entry);
    this.maybeAnswer(call, Math.max(entry.ring, entry.clip));
  }

  /** The call object appears with the first ring: that ring counts as cycle one. */
  private handleStarted(session: CallSession): void {
    if (session.direction !== 'inbound' || !this.cfg.config.automation.autoAnswer) return;
    this.rings.set(session.id, { ring: 1, clip: 0 });
    this.maybeAnswer(session, 1);
  }

  private maybeAnswer(call: CallSession, rings: number): void {
    if (rings < this.cfg.config.automation.autoAnswerRings || this.answered.has(call.id)) return;
    this.answered.add(call.id); // one attempt per call, success or not
    void this.answer(call, rings);
  }

  private async answer(call: CallSession, rings: number): Promise<void> {
    const blockers = this.blockers('inbound');
    if (this.deps.hasActiveSession()) blockers.push('another call already has an AI session');
    if (!this.deps.modemReady()) blockers.push('the modem is not READY');
    if (blockers.length > 0) {
      const detail = `Auto-answer skipped: ${blockers.join('; ')}`;
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'skipped', detail });
      this.deps.alert('warn', detail);
      return;
    }
    try {
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'ok', detail: `Auto-answering after ${rings} ring${rings === 1 ? '' : 's'}` });
      await this.deps.manager.answer();
    } catch (error) {
      const detail = `Auto-answer failed: ${(error as Error).message}`;
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail });
      this.deps.alert('error', detail);
    }
  }

  // ---- 2. USB audio -------------------------------------------------------------------------------

  private async handleState(event: CallStateChangeEvent): Promise<void> {
    if (event.currentState !== 'ACTIVE') return;
    const call = event.session;
    const { config } = this.cfg;
    if (!config.automation.autoActivateUsbAudio || this.activated.has(call.id)) return;
    const blockers = this.blockers(call.direction);
    if (blockers.length > 0) return; // not an eligible call: stay out of it, and say nothing about calls we do not handle
    this.activated.add(call.id); // once per call

    const manager = this.deps.manager;
    if (!manager.activateUsbAudioDiagnostic) {
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail: 'USB audio activation is unavailable on this gateway' });
      return;
    }
    if (manager.isUsbAudioDiagnosticActive?.()) {
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'ok', detail: 'USB audio was already activated for this call' });
    } else {
      try {
        const activation = await manager.activateUsbAudioDiagnostic();
        const f = activation.moduleAudioFormat;
        this.deps.mark(call.id, {
          turnId: null,
          stage: 'call',
          status: 'ok',
          detail: 'USB audio activated automatically (AT+CPCMREG=1 accepted)',
          data: { cpcmfrm: f?.cpcmfrm ?? null },
        });
      } catch (error) {
        const detail = `Automatic USB audio activation failed: ${(error as Error).message}`;
        this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail });
        this.deps.alert('error', detail);
        return;
      }
    }

    // Registration accepted is not audio. Wait for actual bytes, and say plainly if none come.
    const waitMs = this.deps.audioWaitMs ?? 6000;
    const pollMs = this.deps.pollMs ?? 200;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const current = manager.getCurrentCall();
      if (!current || current.id !== call.id || current.state !== 'ACTIVE') return; // the call ended meanwhile
      if (manager.getUsbAudioStatus?.().audio.state === 'flowing') {
        this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'ok', detail: 'Audio bytes are flowing from the modem (bytes are not proof of speech)' });
        return;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const detail = `USB audio was activated but no audio bytes arrived within ${Math.round(waitMs / 1000)} s; the AI will not attach until they do`;
    this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail });
    this.deps.alert('warn', detail);
  }
}
