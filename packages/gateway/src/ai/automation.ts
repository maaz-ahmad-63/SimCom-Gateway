import { AtCommandError, CallSession, CallStateChangeEvent, ICallSessionManager, UrcEvent, UsbAudioActivation } from '@sim-gateway/shared';
import { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import { AiConfig } from './config.js';
import type { TraceInput } from './conversation.js';
import type { IvrCallHooks } from '../ivr/ownership.js';

export interface AutomationDeps {
  manager: ICallSessionManager;
  eventBus: GatewayEventBus;
  /** Always the current effective configuration (settings can change at any time). */
  getConfig: () => { config: AiConfig; passiveUsable: boolean; usable: boolean; errors?: string[] };
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
  /** Pause before the first USB audio activation: the module is not always ready in the instant the call connects. */
  activationSettleMs?: number;
  /** Pause between retries after the module REJECTED the activation (AT ERROR). Timeouts and disconnects are never retried. */
  activationRetryMs?: number;
  /** Total activation attempts per call (default 3). */
  activationAttempts?: number;
  /**
   * IVR call ownership. The IVR runs on OUTBOUND calls only: an outbound call it owns has its USB audio activated whether or not the AI
   * is enabled (the IVR can run without the AI), and the IVR is told when audio flows or when this fails. Inbound calls are never the
   * IVR's, so answering and everything else about them is exactly the AI automation below. Absent, or answering 'ai' for every call,
   * leaves every path as it was.
   */
  ivr?: Pick<IvrCallHooks, 'decide' | 'audioReady' | 'fail'>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The call flow's own activation, never the operator's diagnostic one: that one is refused unless the diagnostic switch is on, which a
 * packaged install leaves off, so every call stayed without audio. A manager without it (older test doubles) falls back to the old method.
 */
function activate(manager: ICallSessionManager): (() => Promise<UsbAudioActivation>) | undefined {
  if (manager.activateUsbAudioForCall) return () => manager.activateUsbAudioForCall!();
  if (manager.activateUsbAudioDiagnostic) return () => manager.activateUsbAudioDiagnostic!();
  return undefined;
}

/** The module answered and said no. Anything else (timeout, disconnect) leaves the registration state unknown, so it is not retried. */
function isRejection(error: unknown): boolean {
  return error instanceof AtCommandError || /^USB audio activation rejected/.test((error as Error)?.message ?? '');
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

  private ivrOwns(call: CallSession): boolean {
    return this.deps.ivr?.decide(call) === 'ivr';
  }

  /** What a call the IVR owns needs, which is not the AI: only that the gateway knows its audio sample rate. Never asks about AI keys or mode. */
  private ivrBlockers(): string[] {
    const { config, errors } = this.cfg;
    return config.audio.format ? [] : [errors?.find((e) => e.startsWith('AI_AUDIO_SAMPLE_RATE')) ?? 'the gateway audio sample rate is not set'];
  }

  /** Something the IVR needed did not work: it releases the call (to the AI if the AI can answer, otherwise by ending it). */
  private ivrFailed(call: CallSession, reason: string): void {
    void Promise.resolve(this.deps.ivr?.fail(call.id, reason)).catch((error: unknown) =>
      this.logger.error(`IVR could not release call ${call.id}: ${error instanceof Error ? error.message : String(error)}`)
    );
  }

  /** Reasons automation must not act on a call, or an empty list if it may. */
  private blockers(direction: 'inbound' | 'outbound'): string[] {
    const { config, passiveUsable, usable, errors } = this.cfg;
    const out: string[] = [];
    if (!config.enabled || this.deps.getMode() === 'off') out.push('the AI agent is off');
    if (!this.covers(direction)) out.push(`automatic attachment is not enabled for ${direction} calls`);
    // Replies mode needs the full configuration; passive transcription only needs speech-to-text.
    if (config.automation.autoReplies ? !usable : !passiveUsable) out.push('the AI configuration or provider keys are incomplete');
    // A rate that is set but invalid (160000 for 16000) is not "not set": say which it is.
    if (!config.audio.format) out.push(errors?.find((e) => e.startsWith('AI_AUDIO_SAMPLE_RATE')) ?? 'the gateway audio sample rate is not set');
    return out;
  }

  // ---- 1. answering -------------------------------------------------------------------------------

  private handleUrc(urc: UrcEvent): void {
    if (urc.type !== 'RING' && urc.type !== 'CLIP') return;
    const { config } = this.cfg;
    const call = this.deps.manager.getCurrentCall();
    if (!config.automation.autoAnswer) return;
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
    if (session.direction !== 'inbound') {
      // An outbound call is the IVR's or the AI's from the moment it exists: asked here, before it can be answered, this pins who owns
      // it for its whole life (the AI orchestrator asks the same question when the callee picks up). Nothing is answered or dialled.
      this.ivrOwns(session);
      return;
    }
    if (!this.cfg.config.automation.autoAnswer) return;
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

  /**
   * Registers USB audio for this call. The module can answer AT+CPCMREG=1 with AT ERROR in the first moments of a
   * call, so activation waits briefly and, only when the module REJECTED it (so nothing was registered), tries again
   * a bounded number of times. It never retries after a timeout or disconnect, never when registration is already
   * active, and never once the call has ended. Returns true when audio is registered.
   */
  private async activateWithRetry(call: CallSession): Promise<boolean> {
    const manager = this.deps.manager;
    const settleMs = this.deps.activationSettleMs ?? 1500;
    const retryMs = this.deps.activationRetryMs ?? 1500;
    const attempts = Math.max(1, this.deps.activationAttempts ?? 3);
    const stillThisCall = () => {
      const current = manager.getCurrentCall();
      return current?.id === call.id && current.state === 'ACTIVE';
    };
    if (settleMs > 0) await sleep(settleMs);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!stillThisCall()) return false; // the call ended meanwhile: nothing to report
      if (manager.isUsbAudioDiagnosticActive?.()) return true; // registered meanwhile (for example by the operator): never double-register
      try {
        const activation = await activate(manager)!();
        const f = activation.moduleAudioFormat;
        this.deps.mark(call.id, {
          turnId: null,
          stage: 'call',
          status: 'ok',
          detail: `USB audio activated automatically (AT+CPCMREG=1 accepted${attempt > 1 ? `, attempt ${attempt}` : ''})`,
          data: { cpcmfrm: f?.cpcmfrm ?? null, attempt },
        });
        return true;
      } catch (error) {
        const message = (error as Error).message;
        if (/already active/.test(message)) return true;
        if (!isRejection(error) || attempt === attempts) {
          const detail = `Automatic USB audio activation failed: ${message}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`;
          this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail });
          this.deps.alert('error', detail);
          return false;
        }
        this.deps.mark(call.id, {
          turnId: null,
          stage: 'call',
          status: 'skipped',
          detail: `USB audio activation was rejected by the module (${message}); retrying in ${(retryMs / 1000).toFixed(1)} s (attempt ${attempt} of ${attempts})`,
        });
        await sleep(retryMs);
      }
    }
    return false;
  }

  private async handleState(event: CallStateChangeEvent): Promise<void> {
    if (event.currentState !== 'ACTIVE') return;
    const call = event.session;
    const { config } = this.cfg;
    // A call the IVR owns always gets its audio activated (the IVR cannot run without it), whatever AI_AUTO_ACTIVATE_USB_AUDIO says.
    const owned = this.ivrOwns(call);
    if ((!config.automation.autoActivateUsbAudio && !owned) || this.activated.has(call.id)) return;
    const blockers = owned ? this.ivrBlockers() : this.blockers(call.direction);
    if (blockers.length > 0) {
      if (owned) this.ivrFailed(call, blockers.join('; '));
      return; // not an eligible call: stay out of it, and say nothing about calls we do not handle
    }
    this.activated.add(call.id); // once per call

    const manager = this.deps.manager;
    if (!activate(manager)) {
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail: 'USB audio activation is unavailable on this gateway' });
      if (owned) this.ivrFailed(call, 'USB audio activation is unavailable on this gateway');
      return;
    }
    if (manager.isUsbAudioDiagnosticActive?.()) {
      this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'ok', detail: 'USB audio was already activated for this call' });
    } else {
      if (!(await this.activateWithRetry(call))) {
        if (owned) this.ivrFailed(call, 'USB audio could not be activated');
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
        if (owned) this.deps.ivr?.audioReady(call); // the IVR may start now
        return;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    // What the module itself reported about its audio path right after activation (read-only queries made then).
    const format = manager.getUsbAudioStatus?.().moduleAudioFormat;
    const moduleSays = !format
      ? ''
      : format.cpcmfrm === null
        ? '; the module did not report an audio format (AT+CPCMFRM? came back empty), so its USB audio path is probably not up'
        : `; the module reports audio format CPCMFRM=${format.cpcmfrm}${format.cpcmbandwidth ? ` bandwidth=${format.cpcmbandwidth.volte},${format.cpcmbandwidth.novolte}` : ''}`;
    const detail = `USB audio was activated but no audio bytes arrived within ${Math.round(waitMs / 1000)} s${moduleSays}; the AI will not attach until they do`;
    this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'failed', detail });
    this.deps.alert('warn', detail);
    if (owned) this.ivrFailed(call, `no audio bytes arrived within ${Math.round(waitMs / 1000)} s of activating USB audio`);
  }
}
