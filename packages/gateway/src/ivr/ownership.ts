import type { CallSession, ICallSessionManager } from '@sim-gateway/shared';
import type { TraceInput } from '../ai/conversation.js';
import type { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import { IvrError } from './errors.js';
import type { IvrSnapshot, IvrStore } from './store.js';

/**
 * Who owns an OUTBOUND call: the IVR or the AI. This is call-OWNERSHIP only. It plays nothing, listens for nothing and has no
 * menu logic; the controller that does registers itself here as the handler. Inbound calls are never the IVR's: they are the AI's
 * (or nobody's) exactly as if the IVR did not exist.
 *
 * The rules:
 *  - The decision is made ONCE per call, the first time anything asks (when the outbound call is created, before the callee can
 *    answer), and never changes for that call, so a switch flipped or a configuration published mid-call cannot move a call between
 *    owners. The configuration the call uses is the snapshot taken at that moment.
 *  - A call is the IVR's only if: it is outbound, a handler is registered, the IVR is switched on, something is published, and the
 *    snapshot (the configuration plus all its audio) can be loaded now. Otherwise the call is the AI's, exactly as if the IVR did not
 *    exist. With no handler registered NOTHING is ever the IVR's.
 *  - If the IVR cannot continue with a call it owns, `fail` releases it: to the AI if the AI can answer right now, otherwise the call
 *    is ended cleanly. The caller is never left with an IVR that is not running.
 */

/** Whatever runs the menu for an owned call. Registered once; called when the call's audio is flowing. */
export interface IvrCallHandler {
  start(call: CallSession, snapshot: IvrSnapshot, owner: IvrCallOwner): void | Promise<void>;
}

/** What a handler may do with the call it was given. */
export interface IvrCallOwner {
  /** Release the call to the AI (which re-checks its own readiness). If the AI cannot take it, the call is ended cleanly. */
  handOffToAi(callId: string): Promise<'ai' | 'hung-up' | 'gone'>;
  /** Give up on the IVR for this call: release it to the AI if the AI can answer, else end the call. */
  fail(callId: string, reason: string): Promise<'ai' | 'hung-up' | 'gone'>;
  /** The IVR finished with the call itself (for example it hung up): forget it. */
  finish(callId: string): void;
}

/** The three questions the answering/activation automation and the AI orchestrator ask. */
export interface IvrCallHooks {
  decide(call: CallSession): 'ivr' | 'ai';
  /** Audio is flowing for a call the IVR owns: the IVR may start. */
  audioReady(call: CallSession): void;
  /** Something the IVR needed for this call (audio, for one) did not work: release it. */
  fail(callId: string, reason: string): Promise<unknown>;
}

export interface IvrOwnershipDeps {
  store: Pick<IvrStore, 'isEnabled' | 'getPublished' | 'snapshot'>;
  manager: Pick<ICallSessionManager, 'getCurrentCall' | 'hangup'>;
  /** Can the AI take over and ANSWER right now (runtime mode 'active')? A passive AI would take the call and stay silent. */
  aiCanAnswer: () => boolean;
  /** Attach the AI to the call: the orchestrator's `arm`, which re-checks the full readiness and throws if it is not ready. */
  armAi: (callId: string) => Promise<void>;
  /** Write a line to the call's inspector trace. */
  mark: (callId: string, event: TraceInput) => void;
  /** Forgets a call when it ends. */
  eventBus?: GatewayEventBus;
}

type Decision = { mode: 'ai' } | { mode: 'ivr'; snapshot: IvrSnapshot; started: boolean };

export class IvrCallOwnership implements IvrCallHooks, IvrCallOwner {
  private readonly logger = createLogger('IvrOwnership');
  private readonly decisions = new Map<string, Decision>();
  private handler: IvrCallHandler | null = null;
  private readonly onEnded = (session: CallSession) => this.finish(session.id);

  constructor(private readonly deps: IvrOwnershipDeps) {
    deps.eventBus?.on('call:ended', this.onEnded);
  }

  stop(): void {
    this.deps.eventBus?.off('call:ended', this.onEnded);
    this.decisions.clear();
  }

  /** The controller registers itself here. Until one does, no call is ever owned by the IVR. */
  registerHandler(handler: IvrCallHandler | null): void {
    this.handler = handler;
  }

  get hasHandler(): boolean {
    return this.handler !== null;
  }

  /** Is this call currently held by the IVR (so the AI must not attach to it)? */
  isHeld(callId: string): boolean {
    return this.decisions.get(callId)?.mode === 'ivr';
  }

  decide(call: CallSession): 'ivr' | 'ai' {
    const known = this.decisions.get(call.id);
    if (known) return known.mode;
    // Not outbound (every inbound call), or nothing to run an IVR: the AI's, and nothing is remembered or read, so these calls cost nothing.
    if (call.direction !== 'outbound' || !this.handler) return 'ai';
    return this.take(call).mode;
  }

  /** The first time a call is asked about: decide, remember, and say why in the call's trace. */
  private take(call: CallSession): Decision {
    const own = (decision: Decision, detail?: string, status: 'ok' | 'skipped' = 'ok'): Decision => {
      this.decisions.set(call.id, decision);
      if (detail) this.deps.mark(call.id, { turnId: null, stage: 'call', status, detail });
      return decision;
    };
    if (!this.deps.store.isEnabled() || !this.deps.store.getPublished()) return own({ mode: 'ai' }); // the normal AI-only call: nothing to say
    try {
      const snapshot = this.deps.store.snapshot();
      if (!snapshot) return own({ mode: 'ai' });
      return own({ mode: 'ivr', snapshot, started: false }, `IVR took ownership of this call (published configuration version ${snapshot.version}); the AI will not attach until the IVR hands it over`);
    } catch (error) {
      const why = error instanceof IvrError || error instanceof Error ? error.message : String(error);
      this.logger.warn(`IVR could not take ownership of call ${call.id}: ${why}`);
      return own({ mode: 'ai' }, `IVR could not take ownership of this call (${why}); the call follows the normal AI path`, 'skipped');
    }
  }

  audioReady(call: CallSession): void {
    const decision = this.decisions.get(call.id);
    if (!decision || decision.mode !== 'ivr' || decision.started) return;
    decision.started = true;
    const handler = this.handler;
    if (!handler) {
      void this.fail(call.id, 'no IVR controller is running');
      return;
    }
    this.deps.mark(call.id, { turnId: null, stage: 'call', status: 'ok', detail: 'Audio is flowing: the IVR is starting' });
    Promise.resolve()
      .then(() => handler.start(call, decision.snapshot, this))
      .catch((error: unknown) => void this.fail(call.id, `the IVR failed to start: ${error instanceof Error ? error.message : String(error)}`));
  }

  fail(callId: string, reason: string): Promise<'ai' | 'hung-up' | 'gone'> {
    if (!this.isHeld(callId)) return Promise.resolve('gone'); // not ours any more (already released, handed over, or ended)
    this.release(callId);
    this.deps.mark(callId, { turnId: null, stage: 'call', status: 'failed', detail: `IVR released the call: ${reason}` });
    this.logger.warn(`IVR released call ${callId}: ${reason}`);
    return this.toAiOrHangUp(callId, reason);
  }

  handOffToAi(callId: string): Promise<'ai' | 'hung-up' | 'gone'> {
    if (!this.isHeld(callId)) return Promise.resolve('gone');
    this.release(callId);
    this.deps.mark(callId, { turnId: null, stage: 'call', status: 'ok', detail: 'IVR is handing the call to the AI' });
    return this.toAiOrHangUp(callId, 'the caller chose the AI');
  }

  finish(callId: string): void {
    this.decisions.delete(callId);
  }

  /** From here on the call is the AI's: the orchestrator may attach to it. */
  private release(callId: string): void {
    this.decisions.set(callId, { mode: 'ai' });
  }

  private async toAiOrHangUp(callId: string, reason: string): Promise<'ai' | 'hung-up' | 'gone'> {
    const current = this.deps.manager.getCurrentCall();
    if (!current || current.id !== callId) return 'gone'; // the caller already hung up
    let aiProblem = 'the AI is not set to answer calls';
    if (this.deps.aiCanAnswer()) {
      try {
        await this.deps.armAi(callId);
        this.deps.mark(callId, { turnId: null, stage: 'call', status: 'ok', detail: 'The call was handed to the AI' });
        return 'ai';
      } catch (error) {
        aiProblem = error instanceof Error ? error.message : String(error);
      }
    }
    const detail = `Ending the call: ${reason}, and the AI cannot take it (${aiProblem})`;
    this.deps.mark(callId, { turnId: null, stage: 'call', status: 'failed', detail });
    this.logger.warn(detail);
    try {
      await this.deps.manager.hangup('The IVR could not continue and the AI was not available');
    } catch (error) {
      this.logger.error(`Could not end call ${callId}: ${(error as Error).message}`);
    }
    return 'hung-up';
  }
}
