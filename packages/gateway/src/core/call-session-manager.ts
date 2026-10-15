import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import {
  CallOutcome,
  CallSession,
  CallStateChangeEvent,
  DialRequest,
  DtmfRequest,
  ICallSessionManager,
  IModemAdapter,
  IAudioAdapter,
  UrcEvent,
  ClipUrcEvent,
  CallEndUrcEvent,
} from '@sim-gateway/shared';
import { CallStateMachine } from './call-state-machine.js';
import { GatewayBusyError, InvalidStateTransitionError } from './errors.js';
import { GatewayEventBus } from './event-bus.js';

export interface CallSessionManagerOptions {
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  eventBus?: GatewayEventBus;
}

export class CallSessionManager extends EventEmitter implements ICallSessionManager {
  private readonly modem: IModemAdapter;
  private readonly audio?: IAudioAdapter;
  private readonly eventBus?: GatewayEventBus;

  private activeStateMachine: CallStateMachine | null = null;
  private dialTimeoutTimer: NodeJS.Timeout | null = null;

  constructor(options: CallSessionManagerOptions) {
    super();
    this.modem = options.modem;
    this.audio = options.audio;
    this.eventBus = options.eventBus;

    this.bindModemEvents();
  }

  getCurrentCall(): CallSession | null {
    return this.activeStateMachine ? this.activeStateMachine.getSession() : null;
  }

  async dial(request: DialRequest): Promise<CallSession> {
    if (this.activeStateMachine && this.activeStateMachine.getState() !== 'IDLE') {
      throw new GatewayBusyError(
        `Cannot initiate call to ${request.phoneNumber}: A call is already active (${this.activeStateMachine.getState()})`
      );
    }

    const session: CallSession = {
      id: uuidv4(),
      direction: 'outbound',
      remoteNumber: request.phoneNumber,
      state: 'IDLE',
      startedAt: new Date().toISOString(),
      answeredAt: null,
      endedAt: null,
      durationSeconds: 0,
      outcome: null,
      isSimulated: this.modem.isSimulated,
      metadata: request.metadata,
    };

    const sm = new CallStateMachine(session);
    this.activeStateMachine = sm;

    // Transition to DIALING
    this.applyTransition(sm, 'DIALING');
    this.emit('call:started', sm.getSession());
    this.eventBus?.emit('call:started', sm.getSession());

    // Dialing timeout guard
    const timeoutSeconds = request.timeoutSeconds ?? 45;
    this.dialTimeoutTimer = setTimeout(() => {
      if (
        this.activeStateMachine === sm &&
        (sm.getState() === 'DIALING' || sm.getState() === 'OUTBOUND_RINGING')
      ) {
        this.hangup('Dial timeout exceeded').catch(() => {});
      }
    }, timeoutSeconds * 1000);

    try {
      await this.modem.dial(request.phoneNumber);
    } catch (error) {
      this.clearDialTimer();
      this.applyTransition(sm, 'TERMINATING', {
        outcome: 'failed',
        reason: (error as Error).message,
      });
      this.finalizeCall(sm);
      throw error;
    }

    return sm.getSession();
  }

  async answer(): Promise<CallSession> {
    if (!this.activeStateMachine) {
      throw new InvalidStateTransitionError('IDLE', 'ACTIVE', 'No ringing call to answer');
    }

    if (this.activeStateMachine.getState() !== 'INBOUND_RINGING') {
      throw new InvalidStateTransitionError(
        this.activeStateMachine.getState(),
        'ACTIVE',
        'Can only answer calls that are in INBOUND_RINGING state'
      );
    }

    await this.modem.answer();
    this.applyTransition(this.activeStateMachine, 'ACTIVE');

    if (this.audio) {
      await this.audio.startSession(this.activeStateMachine.getSession().id);
    }

    return this.activeStateMachine.getSession();
  }

  async hangup(reason?: string): Promise<void> {
    this.clearDialTimer();

    if (!this.activeStateMachine) {
      return;
    }

    const sm = this.activeStateMachine;
    const currentState = sm.getState();

    if (currentState === 'IDLE' || currentState === 'TERMINATING') {
      return;
    }

    try {
      await this.modem.hangup();
    } catch {
      // Continue cleanup even if modem returns error on hangup
    }

    if (this.audio) {
      await this.audio.stopSession();
    }

    // If modem hangup emitted VOICE_CALL_END URC, sm might already be finalized to IDLE
    if (sm.getState() === 'IDLE' || sm.getState() === 'TERMINATING') {
      return;
    }

    this.applyTransition(sm, 'TERMINATING', { reason });
    this.finalizeCall(sm);
  }

  async sendDtmf(request: DtmfRequest): Promise<void> {
    if (!this.activeStateMachine || this.activeStateMachine.getState() !== 'ACTIVE') {
      throw new InvalidStateTransitionError(
        this.activeStateMachine?.getState() ?? 'IDLE',
        'ACTIVE',
        'DTMF can only be sent during an active call'
      );
    }

    await this.modem.sendDtmf(request.digit);
  }

  private bindModemEvents(): void {
    this.modem.on('urc', (urc: UrcEvent) => {
      this.handleUrc(urc);
    });

    this.modem.on('error', (err: Error) => {
      this.emit('error', err);
      this.eventBus?.emit('error', err);
    });
  }

  private handleUrc(urc: UrcEvent): void {
    this.eventBus?.emit('modem:urc', urc);

    if (urc.type === 'CLIP') {
      const clip = urc as ClipUrcEvent;
      this.handleIncomingRing(clip.phoneNumber);
      return;
    }

    if (urc.type === 'RING') {
      if (!this.activeStateMachine) {
        this.handleIncomingRing('Unknown');
      }
      return;
    }

    if (urc.type === 'VOICE_CALL_BEGIN') {
      if (
        this.activeStateMachine &&
        (this.activeStateMachine.getState() === 'DIALING' ||
          this.activeStateMachine.getState() === 'OUTBOUND_RINGING')
      ) {
        this.clearDialTimer();
        this.applyTransition(this.activeStateMachine, 'ACTIVE');
        if (this.audio) {
          this.audio.startSession(this.activeStateMachine.getSession().id).catch(() => {});
        }
      }
      return;
    }

    if (urc.type === 'VOICE_CALL_END' || urc.type === 'NO_CARRIER') {
      if (this.activeStateMachine && this.activeStateMachine.getState() !== 'IDLE') {
        this.clearDialTimer();
        if (this.audio) {
          this.audio.stopSession().catch(() => {});
        }
        const callEnd = urc as CallEndUrcEvent;
        this.applyTransition(this.activeStateMachine, 'TERMINATING', {
          reason: 'Remote party disconnected',
        });
        this.finalizeCall(this.activeStateMachine);
      }
      return;
    }

    if (urc.type === 'BUSY') {
      if (this.activeStateMachine && this.activeStateMachine.getState() !== 'IDLE') {
        this.clearDialTimer();
        this.applyTransition(this.activeStateMachine, 'TERMINATING', {
          outcome: 'busy',
          reason: 'Remote party is busy',
        });
        this.finalizeCall(this.activeStateMachine);
      }
      return;
    }

    if (urc.type === 'CUSTOM' && urc.payload?.status === 'alerting') {
      if (this.activeStateMachine && this.activeStateMachine.getState() === 'DIALING') {
        this.applyTransition(this.activeStateMachine, 'OUTBOUND_RINGING');
      }
    }
  }

  private handleIncomingRing(phoneNumber: string): void {
    // SINGLE CONCURRENT CALL GUARD:
    // If another call is already active or in progress, reject this inbound call immediately
    if (this.activeStateMachine && this.activeStateMachine.getState() !== 'IDLE') {
      const rejectedSession: CallSession = {
        id: uuidv4(),
        direction: 'inbound',
        remoteNumber: phoneNumber,
        state: 'TERMINATING',
        startedAt: new Date().toISOString(),
        answeredAt: null,
        endedAt: new Date().toISOString(),
        durationSeconds: 0,
        outcome: 'busy_rejected',
        terminationReason: 'Inbound call rejected due to existing active call',
        isSimulated: this.modem.isSimulated,
      };

      // Instruct modem to immediately reject the second ringing call
      this.modem.hangup().catch(() => {});

      this.emit('call:ended', rejectedSession);
      this.eventBus?.emit('call:ended', rejectedSession);
      this.eventBus?.emit('gateway:alert', {
        level: 'warn',
        message: `Inbound call from ${phoneNumber} rejected: Gateway already in active call`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Normal inbound ringing
    const session: CallSession = {
      id: uuidv4(),
      direction: 'inbound',
      remoteNumber: phoneNumber,
      state: 'IDLE',
      startedAt: new Date().toISOString(),
      answeredAt: null,
      endedAt: null,
      durationSeconds: 0,
      outcome: null,
      isSimulated: this.modem.isSimulated,
    };

    const sm = new CallStateMachine(session);
    this.activeStateMachine = sm;

    this.applyTransition(sm, 'INBOUND_RINGING');
    this.emit('call:started', sm.getSession());
    this.eventBus?.emit('call:started', sm.getSession());
  }

  private applyTransition(
    sm: CallStateMachine,
    nextState: any,
    options?: { outcome?: CallOutcome; reason?: string }
  ): void {
    const change = sm.transitionTo(nextState, options);
    const event: CallStateChangeEvent = {
      callId: change.session.id,
      previousState: change.previousState,
      currentState: change.currentState,
      timestamp: new Date().toISOString(),
      session: change.session,
    };
    this.emit('call:state_changed', event);
    this.eventBus?.emit('call:state_changed', event);
  }

  private finalizeCall(sm: CallStateMachine): void {
    sm.transitionTo('IDLE');
    const endedSession = sm.getSession();
    this.activeStateMachine = null;

    this.emit('call:ended', endedSession);
    this.eventBus?.emit('call:ended', endedSession);
  }

  private clearDialTimer(): void {
    if (this.dialTimeoutTimer) {
      clearTimeout(this.dialTimeoutTimer);
      this.dialTimeoutTimer = null;
    }
  }
}
